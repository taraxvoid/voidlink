#!/usr/bin/env bun
/**
 * voidlink: plan, apply and check a redirects file.
 *
 *   voidlink plan  --redirects <file> [--base <file>] [--remote] [--summary]
 *   voidlink apply --redirects <file> [--host <host>] [--origin <url>]
 *   voidlink check --redirects <file> --host <host> [--origin <url>]
 *   voidlink ls    --redirects <file> [--host <host>]
 */
import { writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { buildLinks, UTM_KEYS } from './links'
import { buildAll, diff, planMarkdown } from './plan'
import type { LinkTable, Redirects } from './types'

const USAGE = `usage:
  voidlink plan  --redirects <file> [--base <file>] [--remote] [--summary]
  voidlink apply --redirects <file> [--host <host>] [--origin <url>]
  voidlink check --redirects <file> --host <host> [--origin <url>]
  voidlink ls    --redirects <file> [--host <host>]`

export class UsageError extends Error {}

type Flags = Record<string, string | true>

export function parseArgs(argv: string[]): { command?: string; flags: Flags } {
    const [command, ...rest] = argv
    const flags: Flags = {}
    for (let i = 0; i < rest.length; i++) {
        const arg = rest[i] as string
        if (!arg.startsWith('--')) throw new UsageError(`unexpected ${arg}`)
        const next = rest[i + 1]
        if (next === undefined || next.startsWith('--'))
            flags[arg.slice(2)] = true
        else {
            flags[arg.slice(2)] = next
            i++
        }
    }
    return { command, flags }
}

function str(flags: Flags, name: string): string {
    const v = flags[name]
    if (typeof v !== 'string')
        throw new UsageError(`--${name} <value> is required`)
    return v
}

const opt = (flags: Flags, name: string) =>
    typeof flags[name] === 'string' ? (flags[name] as string) : undefined

async function load<T>(path: string): Promise<T> {
    const mod = await import(pathToFileURL(resolve(path)).href)
    return (mod.default ?? mod) as T
}

type Out = {
    log: (s: string) => void
    fetch: typeof fetch
    env: Record<string, string | undefined>
    /** Runs git in the current directory and returns trimmed stdout. */
    git: (args: string[]) => string
}

/** The hosts to act on: every host in the file, or just --host. */
function pick(all: Record<string, LinkTable>, host?: string): string[] {
    if (!host) return Object.keys(all)
    if (!all[host]) throw new Error(`no "${host}" entry`)
    return [host]
}

export async function run(argv: string[], out: Out): Promise<number> {
    const { command, flags } = parseArgs(argv)
    switch (command) {
        case 'plan': {
            const redirects = await load<Redirects>(str(flags, 'redirects'))
            const head = buildAll(redirects)
            if (flags.remote) await checkRemote(redirects, out.fetch)
            const base =
                typeof flags.base === 'string'
                    ? buildAll(await load<Redirects>(flags.base))
                    : {}
            const md = planMarkdown(diff(base, head))
            out.log(md)
            const summary = process.env.GITHUB_STEP_SUMMARY
            if (flags.summary && summary) {
                writeFileSync(summary, `### voidlink plan\n\n${md}`, {
                    flag: 'a',
                })
            }
            return 0
        }
        case 'apply': {
            const all = buildAll(await load<Redirects>(str(flags, 'redirects')))
            const hosts = pick(all, opt(flags, 'host'))
            if (
                !out.env.ACTIONS_ID_TOKEN_REQUEST_URL ||
                !out.env.ACTIONS_ID_TOKEN_REQUEST_TOKEN
            ) {
                throw new UsageError(
                    'apply runs in GitHub Actions, in a job with `permissions: { id-token: write }`',
                )
            }
            const version = Number(out.git(['log', '-1', '--format=%ct']))
            const sha = out.git(['rev-parse', 'HEAD'])
            let failed = 0
            for (const host of hosts) {
                const origin = opt(flags, 'origin') ?? `https://${host}`
                const res = await (async () => {
                    try {
                        const token = await oidcToken(
                            `voidlink:${host}`,
                            out.env,
                            out.fetch,
                        )
                        return await apply(
                            origin,
                            { version, sha, links: all[host] ?? {} },
                            token,
                            out.fetch,
                        )
                    } catch (err) {
                        return { ok: false, line: (err as Error).message }
                    }
                })()
                if (!res.ok) failed++
                out.log(`${host}: ${res.line}`)
            }
            return failed ? 1 : 0
        }
        case 'check': {
            const host = str(flags, 'host')
            const all = buildAll(await load<Redirects>(str(flags, 'redirects')))
            const table = all[host]
            if (!table) throw new Error(`no "${host}" entry`)
            const origin = opt(flags, 'origin') ?? `https://${host}`
            const drift = await check(origin, table, out.fetch)
            for (const d of drift) out.log(d)
            out.log(
                drift.length
                    ? `${drift.length} of ${Object.keys(table).length} links differ from ${origin}`
                    : `all ${Object.keys(table).length} links match ${origin}`,
            )
            return drift.length ? 1 : 0
        }
        case 'ls': {
            const all = buildAll(await load<Redirects>(str(flags, 'redirects')))
            const host = opt(flags, 'host')
            for (const [site, table] of Object.entries(all)) {
                if (host && site !== host) continue
                for (const [slug, l] of Object.entries(table))
                    out.log(
                        `${site}/${slug}\t${l.public ? 'public' : 'unlisted'}\t${l.to}`,
                    )
            }
            return 0
        }
        default:
            throw new UsageError(
                command ? `unknown command ${command}` : 'no command',
            )
    }
}

/**
 * An OIDC token for this job from the Actions runtime, for `audience`.
 * Needs `permissions: { id-token: write }` on the job.
 */
export async function oidcToken(
    audience: string,
    env: Out['env'],
    fetcher: typeof fetch,
): Promise<string> {
    const base = env.ACTIONS_ID_TOKEN_REQUEST_URL
    const bearer = env.ACTIONS_ID_TOKEN_REQUEST_TOKEN
    if (!base || !bearer) {
        throw new UsageError('no Actions OIDC endpoint (id-token: write)')
    }
    const url = new URL(base)
    url.searchParams.set('audience', audience)
    const res = await fetcher(url.toString(), {
        headers: { authorization: `bearer ${bearer}` },
    })
    if (!res.ok) throw new Error(`OIDC token: HTTP ${res.status}`)
    const { value } = (await res.json()) as { value?: string }
    if (!value) throw new Error('OIDC token: empty response')
    return value
}

/** PUT one site's whole link set. The line has counts, never destinations. */
export async function apply(
    origin: string,
    body: { version: number; sha: string; links: LinkTable },
    token: string,
    fetcher: typeof fetch,
): Promise<{ ok: boolean; line: string }> {
    const res = await fetcher(`${origin}/_voidlink/links`, {
        method: 'PUT',
        headers: {
            authorization: `Bearer ${token}`,
            'content-type': 'application/json',
        },
        body: JSON.stringify(body),
    })
    if (!res.ok) {
        const reason = (await res.text()).trim().split('\n')[0] ?? ''
        return { ok: false, line: `HTTP ${res.status} ${reason}`.trim() }
    }
    const { count } = (await res.json()) as { count: number }
    return {
        ok: true,
        line: `version ${body.version}, ${count} link${count === 1 ? '' : 's'}`,
    }
}

/**
 * Check each host's links against the live site's reserved paths
 * (`GET /_voidlink/site`), so a PR fails before merge rather than at apply.
 */
async function checkRemote(
    redirects: Redirects,
    fetcher: typeof fetch,
): Promise<void> {
    const errors: string[] = []
    for (const host of Object.keys(redirects).sort()) {
        const url = `https://${host}/_voidlink/site`
        const res = await fetcher(url)
        if (!res.ok) {
            errors.push(`${host}: ${url}: HTTP ${res.status}`)
            continue
        }
        const { reserved } = (await res.json()) as { reserved?: string[] }
        try {
            buildLinks(redirects[host] ?? {}, { host, reserved })
        } catch (err) {
            for (const line of (err as Error).message.split('\n'))
                errors.push(`${host}: ${line}`)
        }
    }
    if (errors.length) throw new Error(errors.join('\n'))
}

/** Strip the utm_ params voidlink adds, so a live Location compares to config. */
function withoutUtm(url: string): string {
    const u = new URL(url)
    for (const k of UTM_KEYS) u.searchParams.delete(k)
    return u.toString()
}

/**
 * HEAD every link on the live site (as a bot, so nothing is counted) and
 * report each one whose redirect doesn't match the config.
 */
export async function check(
    origin: string,
    table: LinkTable,
    fetcher: typeof fetch,
): Promise<string[]> {
    const drift: string[] = []
    for (const [slug, link] of Object.entries(table)) {
        const res = await fetcher(`${origin}/${slug}`, {
            method: 'HEAD',
            redirect: 'manual',
            headers: { 'user-agent': 'voidlink-check (bot)' },
        })
        const location = res.headers.get('location')
        if (res.status !== 302 || !location) {
            drift.push(`${slug}: HTTP ${res.status}, want a redirect`)
        } else if (withoutUtm(location) !== withoutUtm(link.to)) {
            drift.push(`${slug}: redirects elsewhere`)
        }
    }
    return drift
}

function git(args: string[]): string {
    const res = Bun.spawnSync(['git', ...args], { stderr: 'pipe' })
    if (res.exitCode !== 0) {
        throw new Error(
            `git ${args.join(' ')}: ${res.stderr.toString().trim()}`,
        )
    }
    return res.stdout.toString().trim()
}

if (import.meta.main) {
    try {
        process.exitCode = await run(Bun.argv.slice(2), {
            log: (s) => console.log(s),
            fetch,
            env: process.env,
            git,
        })
    } catch (err) {
        console.error((err as Error).message)
        if (err instanceof UsageError) console.error(USAGE)
        process.exitCode = 2
    }
}
