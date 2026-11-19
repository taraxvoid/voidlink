import { beforeEach, describe, expect, test } from 'bun:test'
import { handleApply, siteInfo } from '../src/apply'
import { clearJwksCache } from '../src/oidc'
import { clearLinkCache, readLinks, writeLinks } from '../src/store'
import type { Env, Site } from '../src/types'
import { handle } from '../src/worker'
import { testD1 } from './d1'
import { goodClaims, jwksFetcher, sign } from './jwt'

const site: Site = {
    host: 'short.example',
    homeUrl: 'https://home.example/',
    reserved: ['verify'],
    apply: {
        repositoryId: 42,
        workflow: '.github/workflows/redirects.yml',
        environment: 'links',
    },
}
const NOW = 1_763_400_000
const good = {
    version: 100,
    sha: 'abc',
    links: { cv: 'https://home.example/cv' },
}

let env: Env & { DB: ReturnType<typeof testD1> }
let jwks: ReturnType<typeof jwksFetcher>
let token: string
const quiet = <T>(f: () => Promise<T>): Promise<T> => {
    const [log, err] = [console.log, console.error]
    console.log = () => {}
    console.error = () => {}
    return f().finally(() => {
        console.log = log
        console.error = err
    })
}

beforeEach(async () => {
    env = { DB: testD1() }
    jwks = jwksFetcher()
    clearJwksCache()
    clearLinkCache()
    token = await sign(goodClaims(NOW))
})

function put(
    body: unknown,
    {
        headers = {},
        s = site,
        raw,
    }: { headers?: Record<string, string>; s?: Site; raw?: string } = {},
) {
    const req = new Request('https://short.example/_voidlink/links', {
        method: 'PUT',
        headers: {
            authorization: `Bearer ${token}`,
            'content-type': 'application/json',
            ...headers,
        },
        body: raw ?? JSON.stringify(body),
    })
    return quiet(() => handleApply(req, s, env, { now: NOW, jwks }))
}

describe('PUT /_voidlink/links', () => {
    test('stores and answers version, sha, count', async () => {
        const res = await put(good)
        expect(res.status).toBe(200)
        expect(await res.json()).toEqual({ version: 100, sha: 'abc', count: 1 })
        const redirect = await handle(
            { site },
            new Request('https://short.example/cv'),
            env,
            { waitUntil() {} },
        )
        expect(redirect.status).toBe(302)
        expect(redirect.headers.get('location')).toBe('https://home.example/cv')
    })

    test('no apply in config is a 404', async () => {
        const res = await put(good, { s: { ...site, apply: undefined } })
        expect(res.status).toBe(404)
    })

    test('no DB binding is a 500', async () => {
        env = {} as typeof env
        const res = await put(good)
        expect(res.status).toBe(500)
        expect(await res.text()).toContain('no DB binding')
    })

    test('missing bearer is a 401', async () => {
        const res = await put(good, { headers: { authorization: '' } })
        expect(res.status).toBe(401)
    })

    test('a token the site does not trust is a 403', async () => {
        token = await sign({ ...goodClaims(NOW), repository_id: '43' })
        expect((await put(good)).status).toBe(403)
        expect(await readLinks(env.DB, site.host)).toBeNull()
    })

    test('wrong content-type is a 400', async () => {
        const res = await put(good, {
            headers: { 'content-type': 'text/plain' },
        })
        expect(res.status).toBe(400)
    })

    test('a body over 256 KiB is a 400', async () => {
        const big = JSON.stringify({ ...good, pad: 'x'.repeat(262_144) })
        expect((await put(null, { raw: big })).status).toBe(400)
        const lying = await put(null, {
            raw: big,
            headers: { 'content-length': '10' },
        })
        expect(lying.status).toBe(400)
    })

    test('bad shapes are 400s', async () => {
        expect((await put(null, { raw: '{nope' })).status).toBe(400)
        for (const body of [
            { ...good, version: 0 },
            { ...good, version: 1.5 },
            { ...good, version: '100' },
            { ...good, sha: '' },
            { ...good, sha: 7 },
            { ...good, links: [] },
            { ...good, links: null },
            [],
        ]) {
            expect((await put(body)).status).toBe(400)
        }
    })

    test('a __proto__ key is refused', async () => {
        const raw =
            '{"version":100,"sha":"abc","links":{"__proto__":"https://a.example"}}'
        const res = await put(null, { raw })
        expect(res.status).toBe(422)
        expect(await readLinks(env.DB, site.host)).toBeNull()
    })

    test('prototype names are ordinary slugs, served only as own keys', async () => {
        const raw =
            '{"version":100,"sha":"abc","links":{"constructor":"https://b.example/c"}}'
        expect((await put(null, { raw })).status).toBe(200)
        const get = (path: string) =>
            handle({ site }, new Request(`https://short.example${path}`), env, {
                waitUntil() {},
            })
        const hit = await get('/constructor')
        expect(hit.headers.get('location')).toBe('https://b.example/c')
        expect((await get('/tostring')).status).toBe(404)
        expect((await get('/hasownproperty')).status).toBe(404)
    })

    test('invalid links are a 422 listing every problem', async () => {
        const res = await put({
            ...good,
            links: {
                plain: 'http://insecure.example/x',
                verify: 'https://home.example/v',
                loop: 'https://short.example/cv',
            },
        })
        expect(res.status).toBe(422)
        const body = await res.text()
        expect(body.trim().split('\n')).toHaveLength(3)
        expect(body).toContain('"verify" is reserved')
    })

    test('never echoes destinations', async () => {
        const res = await put({
            ...good,
            links: {
                plain: 'http://insecure.example/secret-path',
                broken: 'not a url/secret-thing',
            },
        })
        expect(res.status).toBe(422)
        const body = await res.text()
        expect(body).toContain('plain')
        expect(body).not.toContain('secret-path')
        expect(body).not.toContain('secret-thing')
    })

    test('an older version or a conflicting sha is a 409', async () => {
        await writeLinks(env.DB, site.host, {
            version: 200,
            sha: 'z',
            links: {},
        })
        expect((await put(good)).status).toBe(409)
        const same = await put({ ...good, version: 200, sha: 'other' })
        expect(same.status).toBe(409)
        expect(await same.text()).toContain('200')
    })

    test('the same version and sha again is a 200', async () => {
        expect((await put(good)).status).toBe(200)
        expect((await put(good)).status).toBe(200)
    })
})

describe('GET /_voidlink/site', () => {
    test('host and every reserved path, no links', () => {
        expect(siteInfo(site)).toEqual({
            host: 'short.example',
            reserved: ['_health', '_voidlink', 'verify'],
        })
    })
})
