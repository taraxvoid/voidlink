import { beforeEach, describe, expect, test } from 'bun:test'
import {
    AuthError,
    clearJwksCache,
    GITHUB_ISSUER,
    verifyGitHubToken,
} from '../src/oidc'
import {
    b64url,
    expected,
    goodClaims,
    jwksFetcher,
    publicJwk,
    sign,
} from './jwt'

const NOW = 1_763_400_000

beforeEach(() => clearJwksCache())

async function rejects(
    p: Promise<unknown>,
    status: 401 | 403,
): Promise<AuthError> {
    try {
        await p
    } catch (err) {
        expect(err).toBeInstanceOf(AuthError)
        expect((err as AuthError).status).toBe(status)
        return err as AuthError
    }
    throw new Error('expected a rejection')
}

const verify = (jwt: string, jwks = jwksFetcher(), now = NOW) =>
    verifyGitHubToken(jwt, expected, { now, jwks })

describe('verifyGitHubToken', () => {
    test('accepts a good token', async () => {
        const claims = await verify(await sign(goodClaims(NOW)))
        expect(claims.repository).toBe('owner/links')
    })

    test('aud array', async () => {
        const ok = { ...goodClaims(NOW), aud: ['other', expected.audience] }
        expect((await verify(await sign(ok))).repository).toBe('owner/links')
        const bad = { ...goodClaims(NOW), aud: ['voidlink:other.example'] }
        await rejects(verify(await sign(bad)), 403)
    })

    const mutations: Array<[string, Record<string, unknown>]> = [
        ['iss', { iss: 'https://evil.example' }],
        ['aud', { aud: 'voidlink:other.example' }],
        ['repository_id', { repository_id: '43' }],
        ['ref', { ref: 'refs/heads/dev' }],
        ['environment', { environment: 'prod' }],
        [
            'workflow_ref file',
            {
                workflow_ref:
                    'owner/links/.github/workflows/other.yml@refs/heads/main',
            },
        ],
        [
            'workflow_ref branch',
            {
                workflow_ref:
                    'owner/links/.github/workflows/redirects.yml@refs/heads/dev',
            },
        ],
        ['event_name', { event_name: 'pull_request' }],
        ['missing environment', { environment: undefined }],
    ]
    for (const [name, change] of mutations) {
        test(`refuses a wrong ${name}`, async () => {
            const err = await rejects(
                verify(await sign({ ...goodClaims(NOW), ...change })),
                403,
            )
            expect(err.message).not.toContain('eyJ')
        })
    }

    test('expiry, with 60 s of leeway', async () => {
        await rejects(
            verify(await sign({ ...goodClaims(NOW), exp: NOW - 61 })),
            401,
        )
        const late = { ...goodClaims(NOW), exp: NOW - 30 }
        expect((await verify(await sign(late))).repository).toBe('owner/links')
        await rejects(
            verify(await sign({ ...goodClaims(NOW), nbf: NOW + 120 })),
            401,
        )
        await rejects(
            verify(await sign({ ...goodClaims(NOW), iat: NOW + 120 })),
            401,
        )
    })

    test('bad signature', async () => {
        const jwt = await sign(goodClaims(NOW))
        const flipped = jwt.slice(0, -2) + (jwt.endsWith('A') ? 'BB' : 'AA')
        await rejects(verify(flipped), 401)
    })

    test('a payload swapped under a good signature', async () => {
        const [h, , s] = (await sign(goodClaims(NOW))).split('.')
        const evil = b64url(
            `${JSON.stringify({ ...goodClaims(NOW), repository_id: '42' })} `,
        )
        await rejects(verify(`${h}.${evil}.${s}`), 401)
    })

    test('alg none', async () => {
        const jwt = await sign(goodClaims(NOW), { alg: 'none', kid: 'test' })
        const [h, p] = jwt.split('.')
        await rejects(verify(`${h}.${p}.`), 401)
    })

    test('HS256 with the public key as secret', async () => {
        const header = { alg: 'HS256', typ: 'JWT', kid: 'test' }
        const input = `${b64url(JSON.stringify(header))}.${b64url(JSON.stringify(goodClaims(NOW)))}`
        const key = await crypto.subtle.importKey(
            'raw',
            new TextEncoder().encode(JSON.stringify(publicJwk)),
            { name: 'HMAC', hash: 'SHA-256' },
            false,
            ['sign'],
        )
        const sig = await crypto.subtle.sign(
            'HMAC',
            key,
            new TextEncoder().encode(input),
        )
        await rejects(verify(`${input}.${b64url(new Uint8Array(sig))}`), 401)
    })

    test('unknown kid refetches the JWKS once', async () => {
        const jwks = jwksFetcher()
        await verify(await sign(goodClaims(NOW)), jwks)
        expect(jwks.calls).toBe(1)
        const other = await sign(goodClaims(NOW), {
            alg: 'RS256',
            kid: 'rotated',
        })
        await rejects(verify(other, jwks), 401)
        expect(jwks.calls).toBe(2)
    })

    test('the JWKS is cached for an hour', async () => {
        const jwks = jwksFetcher()
        await verify(await sign(goodClaims(NOW)), jwks, NOW)
        await verify(await sign(goodClaims(NOW + 3599)), jwks, NOW + 3599)
        expect(jwks.calls).toBe(1)
        await verify(await sign(goodClaims(NOW + 3601)), jwks, NOW + 3601)
        expect(jwks.calls).toBe(2)
    })

    test('malformed tokens are AuthError 401', async () => {
        for (const jwt of ['', 'a.b', '!!!.e30.x', 'e30.e30.x', 'a.b.c.d']) {
            await rejects(verify(jwt), 401)
        }
    })

    test('a JWKS fetch failure is 401, not a crash', async () => {
        const failing = async () => {
            throw new Error('network down')
        }
        await rejects(
            verifyGitHubToken(await sign(goodClaims(NOW)), expected, {
                now: NOW,
                jwks: failing,
            }),
            401,
        )
    })

    test('issuer constant', () => {
        expect(GITHUB_ISSUER).toBe(
            'https://token.actions.githubusercontent.com',
        )
    })
})
