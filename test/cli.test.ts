import { describe, expect, test } from 'bun:test'
import { join } from 'node:path'
import { check, parseArgs, run, UsageError } from '../src/cli'
import { buildAll, diff, planMarkdown } from '../src/plan'

const fx = (name: string) => join(import.meta.dir, 'fixtures', name)

const ACTIONS = {
    ACTIONS_ID_TOKEN_REQUEST_URL: 'https://oidc.example/token?api-version=2.0',
    ACTIONS_ID_TOKEN_REQUEST_TOKEN: 'runtime-secret',
}

const git = (args: string[]) => {
    if (args.join(' ') === 'log -1 --format=%ct') return '1763400000'
    if (args.join(' ') === 'rev-parse HEAD') return 'abc123'
    throw new Error(`unexpected git ${args.join(' ')}`)
}

function cli(
    argv: string[],
    fetcher: typeof fetch = fetch,
    env: Record<string, string | undefined> = ACTIONS,
) {
    const lines: string[] = []
    return run(argv, {
        log: (s) => lines.push(s),
        fetch: fetcher,
        env,
        git,
    }).then((code) => ({ code, out: lines.join('\n') }))
}

type Call = { url: string; init?: RequestInit }

/** A fake network: the Actions token endpoint, then each site's PUT. */
function network(status: Record<string, number> = {}) {
    const calls: Call[] = []
    const fetcher = (async (url: string, init?: RequestInit) => {
        calls.push({ url, init })
        if (url.startsWith('https://oidc.example/')) {
            const aud = new URL(url).searchParams.get('audience')
            return Response.json({ value: `jwt-for-${aud}` })
        }
        const code = status[new URL(url).host] ?? 200
        if (code !== 200) {
            return new Response('token aud does not match\n', { status: code })
        }
        const body = JSON.parse(String(init?.body))
        return Response.json({
            version: body.version,
            sha: body.sha,
            count: Object.keys(body.links).length,
        })
    }) as typeof fetch
    return { calls, fetcher }
}

const headers = (c?: Call) => (c?.init?.headers ?? {}) as Record<string, string>

describe('parseArgs', () => {
    test('flags with and without values', () => {
        expect(parseArgs(['plan', '--base', 'x', '--summary'])).toEqual({
            command: 'plan',
            flags: { base: 'x', summary: true },
        })
    })
    test('rejects stray positionals', () => {
        expect(() => parseArgs(['plan', 'x'])).toThrow(UsageError)
    })
})

describe('apply', () => {
    test("sends each host's links with its own audience", async () => {
        const { calls, fetcher } = network()
        const res = await cli(
            ['apply', '--redirects', fx('redirects.ts')],
            fetcher,
        )
        expect(res.code).toBe(0)
        const tokens = calls.filter((c) =>
            c.url.startsWith('https://oidc.example/'),
        )
        expect(
            tokens.map((c) => new URL(c.url).searchParams.get('audience')),
        ).toEqual(['voidlink:other.example', 'voidlink:short.example'])
        for (const t of tokens) {
            expect(new URL(t.url).searchParams.get('api-version')).toBe('2.0')
            expect(headers(t).authorization).toBe('bearer runtime-secret')
        }
        const puts = calls.filter((c) => c.init?.method === 'PUT')
        expect(puts.map((c) => c.url)).toEqual([
            'https://other.example/_voidlink/links',
            'https://short.example/_voidlink/links',
        ])
        expect(headers(puts[1]).authorization).toBe(
            'Bearer jwt-for-voidlink:short.example',
        )
        expect(headers(puts[1])['content-type']).toBe('application/json')
        expect(JSON.parse(String(puts[1]?.init?.body))).toEqual({
            version: 1763400000,
            sha: 'abc123',
            links: {
                cv: {
                    to: 'https://home.example/cv',
                    public: true,
                    title: 'CV',
                },
                gh: { to: 'https://github.com/example', public: false },
            },
        })
        expect(res.out).toContain('short.example: version 1763400000, 2 links')
        expect(res.out).not.toContain('https://home.example')
        expect(res.out).not.toContain('github.com')
    })

    test('--host sends only that host; --origin replaces https://<host>', async () => {
        const { calls, fetcher } = network()
        await cli(
            [
                'apply',
                '--redirects',
                fx('redirects.ts'),
                '--host',
                'short.example',
                '--origin',
                'http://localhost:8787',
            ],
            fetcher,
        )
        const puts = calls.filter((c) => c.init?.method === 'PUT')
        expect(puts.map((c) => c.url)).toEqual([
            'http://localhost:8787/_voidlink/links',
        ])
    })

    test('reports every host, exits 1 if any failed', async () => {
        const { calls, fetcher } = network({ 'other.example': 403 })
        const res = await cli(
            ['apply', '--redirects', fx('redirects.ts')],
            fetcher,
        )
        expect(res.code).toBe(1)
        expect(calls.filter((c) => c.init?.method === 'PUT')).toHaveLength(2)
        expect(res.out).toContain(
            'other.example: HTTP 403 token aud does not match',
        )
        expect(res.out).toContain('short.example: version 1763400000, 2 links')
    })

    test('apply outside Actions', async () => {
        const { calls, fetcher } = network()
        await expect(
            cli(['apply', '--redirects', fx('redirects.ts')], fetcher, {}),
        ).rejects.toThrow(/id-token: write/)
        expect(calls).toHaveLength(0)
    })

    test('an unknown --host is an error', async () => {
        const { fetcher } = network()
        await expect(
            cli(
                [
                    'apply',
                    '--redirects',
                    fx('redirects.ts'),
                    '--host',
                    'nope.example',
                ],
                fetcher,
            ),
        ).rejects.toThrow('no "nope.example" entry')
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

describe('plan --remote', () => {
    test('fails on a slug the live site reserves', async () => {
        const fetcher = (async (url: string) =>
            Response.json({
                host: new URL(url).host,
                reserved: ['_health', '_voidlink', 'gh'],
            })) as typeof fetch
        await expect(
            cli(
                ['plan', '--redirects', fx('redirects.ts'), '--remote'],
                fetcher,
            ),
        ).rejects.toThrow('short.example: "gh" is reserved by the site')
    })
    test('passes when nothing is reserved, and asks each host', async () => {
        const asked: string[] = []
        const fetcher = (async (url: string) => {
            asked.push(url)
            return Response.json({
                host: new URL(url).host,
                reserved: ['_health'],
            })
        }) as typeof fetch
        const res = await cli(
            ['plan', '--redirects', fx('redirects.ts'), '--remote'],
            fetcher,
        )
        expect(res.code).toBe(0)
        expect(asked.sort()).toEqual([
            'https://other.example/_voidlink/site',
            'https://short.example/_voidlink/site',
        ])
    })
    test('a site that does not answer fails the plan', async () => {
        const fetcher = (async (_url: string) =>
            new Response('nope', { status: 404 })) as typeof fetch
        await expect(
            cli(
                ['plan', '--redirects', fx('redirects.ts'), '--remote'],
                fetcher,
            ),
        ).rejects.toThrow(/_voidlink\/site: HTTP 404/)
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

test('build is gone', async () => {
    await expect(cli(['build'])).rejects.toThrow('unknown command build')
})
