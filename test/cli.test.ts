import { describe, expect, test } from 'bun:test'
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { check, parseArgs, run, UsageError } from '../src/cli'
import { buildAll, diff, planMarkdown } from '../src/plan'

const fx = (name: string) => join(import.meta.dir, 'fixtures', name)
const tmp = () => mkdtempSync(join(tmpdir(), 'voidlink-'))

function cli(argv: string[], fetcher: typeof fetch = fetch) {
    const lines: string[] = []
    const code = run(argv, { log: (s) => lines.push(s), fetch: fetcher })
    return code.then((c) => ({ code: c, out: lines.join('\n') }))
}

describe('parseArgs', () => {
    test('flags with and without values', () => {
        expect(parseArgs(['build', '--out', 'x', '--empty'])).toEqual({
            command: 'build',
            flags: { out: 'x', empty: true },
        })
    })
    test('rejects stray positionals', () => {
        expect(() => parseArgs(['build', 'x'])).toThrow(UsageError)
    })
})

describe('build', () => {
    test("writes the site's checked links, and logs counts only", async () => {
        const out = join(tmp(), 'gen', 'links.json')
        const res = await cli([
            'build',
            '--redirects',
            fx('redirects.ts'),
            '--site',
            fx('site-ok.ts'),
            '--out',
            out,
        ])
        expect(res.code).toBe(0)
        expect(JSON.parse(readFileSync(out, 'utf8'))).toEqual({
            cv: { to: 'https://home.example/cv', public: true, title: 'CV' },
            gh: { to: 'https://github.com/example', public: false },
        })
        expect(res.out).toContain('2 links (1 public)')
        expect(res.out).not.toContain('github.com')
    })
    test('fails on a slug the site reserves', async () => {
        const out = join(tmp(), 'links.json')
        await expect(
            cli([
                'build',
                '--redirects',
                fx('redirects.ts'),
                '--site',
                fx('site.ts'),
                '--out',
                out,
            ]),
        ).rejects.toThrow('"gh" is reserved')
    })
    test('fails when the redirects file has no entry for the site', async () => {
        const site = join(tmp(), 'site.ts')
        await Bun.write(
            site,
            "export default { host: 'nobody.example', homeUrl: 'https://h.example/' }",
        )
        await expect(
            cli([
                'build',
                '--redirects',
                fx('redirects.ts'),
                '--site',
                site,
                '--out',
                join(tmp(), 'x.json'),
            ]),
        ).rejects.toThrow('no "nobody.example" entry')
    })
    test("refuses a site entry with no links, so a deploy can't wipe them", async () => {
        const redirects = join(tmp(), 'r.ts')
        await Bun.write(redirects, "export default { 'short.example': {} }")
        await expect(
            cli([
                'build',
                '--redirects',
                redirects,
                '--site',
                fx('site-ok.ts'),
                '--out',
                join(tmp(), 'x.json'),
            ]),
        ).rejects.toThrow('no links for "short.example"')
    })
    test('--empty writes no links, for local dev without infra', async () => {
        const out = join(tmp(), 'links.json')
        const res = await cli([
            'build',
            '--empty',
            '--site',
            fx('site-ok.ts'),
            '--out',
            out,
        ])
        expect(res.code).toBe(0)
        expect(readFileSync(out, 'utf8')).toBe('{}\n')
    })
})

describe('plan', () => {
    test('diffs head against base, site by site', async () => {
        const res = await cli([
            'plan',
            '--redirects',
            fx('redirects.ts'),
            '--base',
            fx('redirects-base.ts'),
        ])
        expect(res.code).toBe(0)
        expect(res.out).toContain('3 link changes')
        expect(res.out).toContain(
            '| change | `short.example/cv` | https://home.example/old-cv → https://home.example/cv (public) "CV" |',
        )
        expect(res.out).toContain('| remove | `short.example/gone` |')
        expect(res.out).toContain('| add | `other.example/talk` |')
        expect(res.out).not.toContain('short.example/gh`')
    })
    test('without a base, everything is added', async () => {
        const res = await cli(['plan', '--redirects', fx('redirects.ts')])
        expect(res.out).toContain('3 link changes')
    })
    test('fails with every problem in a bad file', async () => {
        await expect(
            cli(['plan', '--redirects', fx('redirects-bad.ts')]),
        ).rejects.toThrow(
            /short\.example: invalid slug "Bad"[\s\S]*points back[\s\S]*must be https/,
        )
    })
    test('no changes', () => {
        const all = buildAll({ 'a.example': { x: 'https://x.example' } })
        expect(planMarkdown(diff(all, all))).toBe('No link changes.\n')
    })
    test('escapes pipes in a title', () => {
        const head = buildAll({
            'a.example': { x: { to: 'https://x.example', title: 'a | b' } },
        })
        expect(planMarkdown(diff({}, head))).toContain('"a \\| b"')
    })
})

describe('check', () => {
    const table =
        buildAll({
            'short.example': {
                cv: 'https://home.example/cv',
                gh: 'https://github.com/example',
                gone: 'https://gone.example',
            },
        })['short.example'] ?? {}
    const live: Record<string, Response> = {
        cv: new Response(null, {
            status: 302,
            headers: {
                location:
                    'https://home.example/cv?utm_source=short.example&utm_medium=shortlink&utm_campaign=cv',
            },
        }),
        gh: new Response(null, {
            status: 302,
            headers: { location: 'https://github.com/someone-else' },
        }),
        gone: new Response(null, { status: 404 }),
    }
    const seen: RequestInit[] = []
    const fetcher = (async (url: string, init: RequestInit) => {
        seen.push(init)
        return live[url.split('/').pop() ?? ''] as Response
    }) as typeof fetch

    test('reports links that differ, ignoring the utm tags voidlink adds', async () => {
        const drift = await check('https://short.example', table, fetcher)
        expect(drift).toEqual([
            'gh: redirects elsewhere',
            'gone: HTTP 404, want a redirect',
        ])
    })
    test('probes as a bot with HEAD, without following redirects', () => {
        for (const init of seen) {
            expect(init.method).toBe('HEAD')
            expect(init.redirect).toBe('manual')
            expect(
                (init.headers as Record<string, string>)['user-agent'],
            ).toContain('bot')
        }
    })
})

test('unknown command is a usage error', async () => {
    await expect(cli(['nope'])).rejects.toThrow(UsageError)
})
