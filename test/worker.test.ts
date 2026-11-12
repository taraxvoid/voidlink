import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { buildLinks } from '../src/links'
import type { Env, Site } from '../src/types'
import { createWorker, handle, type WorkerOptions } from '../src/worker'
import { testD1 } from './d1'

const CHROME =
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
const HTML = 'text/html,application/xhtml+xml,*/*;q=0.8'

const site: Site = {
    host: 'short.example',
    homeUrl: 'https://home.example/',
    title: 'Short <links>',
    description: 'Things worth a short URL',
    utmHosts: ['home.example'],
    reserved: ['hello'],
    analytics: { event: 'link_clicked' },
}
const links = buildLinks(
    {
        cv: { to: 'https://home.example/cv', public: true, title: 'CV' },
        gh: { to: 'https://github.com/example', public: true },
        secret: 'https://private.example/plans',
    },
    site,
)

let env: Env & { DB: ReturnType<typeof testD1> }
let pending: Promise<unknown>[]
let posted: Array<{ event: string; properties: Record<string, unknown> }>
const realFetch = globalThis.fetch

beforeEach(() => {
    env = { DB: testD1(), POSTHOG_KEY: 'phc_test' }
    pending = []
    posted = []
    globalThis.fetch = (async (_url: string, init?: RequestInit) => {
        posted.push(JSON.parse(String(init?.body)))
        return new Response('ok')
    }) as typeof fetch
})
afterEach(() => {
    globalThis.fetch = realFetch
})

async function get(
    path: string,
    headers: Record<string, string> = {},
    method = 'GET',
    opts: Partial<WorkerOptions<Env>> = {},
) {
    const res = await handle(
        { site, links, ...opts },
        new Request(`https://short.example${path}`, { method, headers }),
        env,
        { waitUntil: (p) => pending.push(p) },
    )
    await Promise.all(pending)
    return res
}

const browser = { 'user-agent': CHROME, accept: HTML }
function clicks(slug: string): number {
    const db = env.DB.sqlite
    const table = db
        .query("SELECT 1 FROM sqlite_master WHERE name = 'voidlink_clicks'")
        .get()
    if (!table) return 0
    const row = db
        .query('SELECT click_count FROM voidlink_clicks WHERE slug = ?')
        .get(slug) as { click_count: number } | null
    return row?.click_count ?? 0
}

describe('links', () => {
    test('redirects with utm tags, counts the click, sends one event', async () => {
        const res = await get('/cv', browser)
        expect(res.status).toBe(302)
        const to = new URL(res.headers.get('location') ?? '')
        expect(to.origin + to.pathname).toBe('https://home.example/cv')
        expect(to.searchParams.get('utm_source')).toBe('short.example')
        expect(clicks('cv')).toBe(1)
        await get('/cv', browser)
        expect(clicks('cv')).toBe(2)
        expect(posted).toHaveLength(2)
        expect(posted[0]).toMatchObject({
            event: 'link_clicked',
            properties: {
                source: 'short.example',
                slug: 'cv',
                destination: 'https://home.example/cv',
                utm_campaign: 'cv',
                $process_person_profile: false,
            },
        })
    })
    test('unlisted links redirect too', async () => {
        const res = await get('/secret', browser)
        expect(res.headers.get('location')).toBe(
            'https://private.example/plans',
        )
    })
    test('is case-insensitive and tolerates a trailing slash', async () => {
        expect((await get('/CV/')).status).toBe(302)
    })
    test('bots and HEAD requests are redirected but not counted', async () => {
        expect(
            (await get('/cv', { 'user-agent': 'Slackbot 1.0' })).status,
        ).toBe(302)
        expect((await get('/cv', { 'user-agent': 'curl/8.4.0' })).status).toBe(
            302,
        )
        expect((await get('/cv', browser, 'HEAD')).status).toBe(302)
        expect(clicks('cv')).toBe(0)
        expect(posted).toHaveLength(0)
    })
    test('no analytics config, no key or no DB: still redirects', async () => {
        const noAnalytics = { ...site, analytics: undefined }
        await get('/cv', browser, 'GET', { site: noAnalytics })
        expect(posted).toHaveLength(0)
        env = { DB: env.DB }
        await get('/cv', browser)
        expect(posted).toHaveLength(0)
        env = {} as typeof env
        expect((await get('/cv', browser)).status).toBe(302)
    })
    test('a missing link is a 404: HTML for browsers, failing sh otherwise', async () => {
        const page = await get('/nope', browser)
        expect(page.status).toBe(404)
        expect(await page.text()).toContain('url=https://home.example/')
        const text = await get('/nope')
        expect(text.status).toBe(404)
        expect(await text.text()).toContain('exit 1')
    })
    test('prototype keys are not links', async () => {
        expect((await get('/constructor')).status).toBe(404)
    })
    test('only GET and HEAD', async () => {
        const res = await get('/cv', {}, 'POST')
        expect(res.status).toBe(405)
        expect(res.headers.get('allow')).toBe('GET, HEAD')
    })
})

describe('index', () => {
    test('browsers get the public links only, escaped', async () => {
        const res = await get('/', browser)
        expect(res.headers.get('content-type')).toContain('text/html')
        const html = await res.text()
        expect(html).toContain('<title>Short &#60;links&#62;</title>')
        expect(html).toContain('href="/cv"')
        expect(html).toContain('href="/gh"')
        expect(html).toContain('github.com')
        expect(html).not.toContain('secret')
        expect(html).not.toContain('private.example')
    })
    test('curl gets them as shell comments, so `| sh` does nothing', async () => {
        const body = await (await get('/')).text()
        for (const line of body.trimEnd().split('\n'))
            expect(line.startsWith('#')).toBe(true)
        expect(body).toContain('short.example/cv')
        expect(body).not.toContain('secret')
    })
    test("index: 'home' sends browsers home", async () => {
        const res = await get('/', browser, 'GET', {
            site: { ...site, index: 'home' },
        })
        expect(res.status).toBe(302)
        expect(res.headers.get('location')).toBe('https://home.example/')
    })
    test('with no public links it says so', async () => {
        const html = await (
            await get('/', browser, 'GET', { links: {} })
        ).text()
        expect(html).toContain('No public links yet.')
    })
})

describe('routes and health', () => {
    test("the site's routes come first; undefined falls through", async () => {
        const routes = (_req: Request, url: URL) =>
            url.pathname === '/hello' ? new Response('hi') : undefined
        expect(await (await get('/hello', {}, 'GET', { routes })).text()).toBe(
            'hi',
        )
        expect((await get('/cv', {}, 'GET', { routes })).status).toBe(302)
    })
    test('/_health checks D1, and is ok without one', async () => {
        expect(await (await get('/_health')).json()).toEqual({ ok: true })
        env = {} as typeof env
        expect(await (await get('/_health')).json()).toEqual({ ok: true })
    })
    test('/_health is a 500 when D1 fails', async () => {
        env.DB.sqlite.close()
        const err = console.error
        console.error = () => {}
        const res = await get('/_health')
        console.error = err
        expect(res.status).toBe(500)
    })
    test('createWorker turns a thrown route into a 500', async () => {
        const worker = createWorker({
            site,
            links,
            routes: () => {
                throw new Error('boom')
            },
        })
        const err = console.error
        console.error = () => {}
        const res = await worker.fetch?.(
            new Request('https://short.example/') as never,
            env,
            { waitUntil() {}, passThroughOnException() {} } as never,
        )
        console.error = err
        expect(res?.status).toBe(500)
    })
})
