#!/usr/bin/env bun
/**
 * voidlink: build a site's links into its Worker, and plan or check a
 * redirects file.
 *
 *   voidlink build --redirects <file> --site <voidlink.config.ts> --out <file>
 *   voidlink build --empty --site <voidlink.config.ts> --out <file>
 *   voidlink plan  --redirects <file> [--base <file>] [--summary]
 *   voidlink check --redirects <file> --host <host> [--origin <url>]
 *   voidlink ls    --redirects <file> [--host <host>]
 */
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { buildLinks, UTM_KEYS } from './links'
import { buildAll, diff, planMarkdown } from './plan'
import type { LinkTable, Redirects, Site } from './types'

const USAGE = `usage:
  voidlink build --redirects <file> --site <voidlink.config.ts> --out <file>
  voidlink build --empty --site <voidlink.config.ts> --out <file>
  voidlink plan  --redirects <file> [--base <file>] [--summary]
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

async function load<T>(path: string): Promise<T> {
    const mod = await import(pathToFileURL(resolve(path)).href)
    return (mod.default ?? mod) as T
}

type Out = { log: (s: string) => void; fetch: typeof fetch }

export async function run(argv: string[], out: Out): Promise<number> {
    const { command, flags } = parseArgs(argv)
    switch (command) {
        case 'build': {
            const site = await load<Site>(str(flags, 'site'))
            let table: LinkTable = {}
            if (!flags.empty) {
                const redirects = await load<Redirects>(str(flags, 'redirects'))
                const inputs = redirects[site.host]
                if (!inputs) {
                    throw new Error(
                        `${flags.redirects} has no "${site.host}" entry (pass --empty for none)`,
                    )
                }
                table = buildLinks(inputs, site)
            }
            const file = str(flags, 'out')
            mkdirSync(dirname(resolve(file)), { recursive: true })
            writeFileSync(file, `${JSON.stringify(table, null, 4)}\n`)
            const n = Object.keys(table).length
            const listed = Object.values(table).filter((l) => l.public).length
            // Counts only: CI logs must not show private destinations.
            out.log(
                `${file}: ${n} link${n === 1 ? '' : 's'} (${listed} public)`,
            )
            return 0
        }
        case 'plan': {
            const head = buildAll(
                await load<Redirects>(str(flags, 'redirects')),
            )
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
        case 'check': {
            const host = str(flags, 'host')
            const all = buildAll(await load<Redirects>(str(flags, 'redirects')))
            const table = all[host]
            if (!table) throw new Error(`no "${host}" entry`)
            const origin =
                typeof flags.origin === 'string'
                    ? flags.origin
                    : `https://${host}`
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
            const host = typeof flags.host === 'string' ? flags.host : undefined
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

if (import.meta.main) {
    try {
        process.exitCode = await run(Bun.argv.slice(2), {
            log: (s) => console.log(s),
            fetch,
        })
    } catch (err) {
        console.error((err as Error).message)
        if (err instanceof UsageError) console.error(USAGE)
        process.exitCode = 2
    }
}
