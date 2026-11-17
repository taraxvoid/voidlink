/**
 * Checking a GitHub Actions OIDC token, so a links repo's workflow can prove
 * who it is to a site's Worker without holding any stored secret.
 * WebCrypto only: no dependencies.
 */

export const GITHUB_ISSUER = 'https://token.actions.githubusercontent.com'
const JWKS_URL = `${GITHUB_ISSUER}/.well-known/jwks`
const JWKS_TTL = 3600
const LEEWAY = 60

/** 401: not a valid GitHub token. 403: valid, but not one this site trusts. */
export class AuthError extends Error {
    constructor(
        readonly status: 401 | 403,
        message: string,
    ) {
        super(message)
    }
}

/** What the token must say, from the site's `apply` config. */
export type Expect = {
    audience: string
    repositoryId: string
    workflow: string
    environment: string
}

export type Claims = Record<string, unknown> & {
    repository: string
    repository_id: string
}

export type JwksFetcher = () => Promise<{ keys: JsonWebKey[] }>

const fetchGitHubJwks: JwksFetcher = async () => {
    const res = await fetch(JWKS_URL)
    if (!res.ok) throw new Error(`JWKS: HTTP ${res.status}`)
    return (await res.json()) as { keys: JsonWebKey[] }
}

let cache: { keys: JsonWebKey[]; at: number } | null = null

/** Forget the cached JWKS (tests). */
export function clearJwksCache(): void {
    cache = null
}

function b64urlBytes(s: string): Uint8Array<ArrayBuffer> {
    if (!/^[A-Za-z0-9_-]*$/.test(s)) throw new Error('not base64url')
    const b64 = s.replace(/-/g, '+').replace(/_/g, '/')
    const bin = atob(b64 + '='.repeat((4 - (b64.length % 4)) % 4))
    return Uint8Array.from(bin, (c) => c.charCodeAt(0))
}

const b64urlJson = (s: string): unknown =>
    JSON.parse(new TextDecoder().decode(b64urlBytes(s)))

const isObj = (x: unknown): x is Record<string, unknown> =>
    typeof x === 'object' && x !== null && !Array.isArray(x)

async function keyFor(
    kid: string,
    now: number,
    fetchJwks: JwksFetcher,
): Promise<JsonWebKey | undefined> {
    const find = () =>
        cache?.keys.find((k) => (k as { kid?: string }).kid === kid)
    const load = async () => {
        try {
            cache = { keys: (await fetchJwks()).keys ?? [], at: now }
        } catch (err) {
            console.error('voidlink: could not load GitHub signing keys:', err)
            throw new AuthError(401, 'signing keys unavailable')
        }
    }
    if (!cache || now - cache.at >= JWKS_TTL) await load()
    else if (!find()) await load()
    return find()
}

/**
 * The token's claims when it is a GitHub Actions token for the expected repo,
 * branch, workflow and environment; otherwise throws AuthError. Messages name
 * the failing check, never the token.
 */
export async function verifyGitHubToken(
    jwt: string,
    expect: Expect,
    opts: { now?: number; jwks?: JwksFetcher } = {},
): Promise<Claims> {
    const now = opts.now ?? Math.floor(Date.now() / 1000)
    const parts = jwt.split('.')
    if (parts.length !== 3) throw new AuthError(401, 'malformed token')
    const [h, p, s] = parts as [string, string, string]
    let header: unknown
    let claims: unknown
    let sig: Uint8Array<ArrayBuffer>
    try {
        header = b64urlJson(h)
        claims = b64urlJson(p)
        sig = b64urlBytes(s)
    } catch {
        throw new AuthError(401, 'malformed token')
    }
    if (!isObj(header) || !isObj(claims)) {
        throw new AuthError(401, 'malformed token')
    }
    // Checked before any key is touched, so alg confusion can't happen.
    if (header.alg !== 'RS256') throw new AuthError(401, 'unsupported alg')
    if (typeof header.kid !== 'string') throw new AuthError(401, 'no kid')

    const jwk = await keyFor(header.kid, now, opts.jwks ?? fetchGitHubJwks)
    if (!jwk) throw new AuthError(401, 'unknown signing key')
    let valid = false
    try {
        const key = await crypto.subtle.importKey(
            'jwk',
            jwk,
            { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
            false,
            ['verify'],
        )
        valid = await crypto.subtle.verify(
            'RSASSA-PKCS1-v1_5',
            key,
            sig,
            new TextEncoder().encode(`${h}.${p}`),
        )
    } catch {
        valid = false
    }
    if (!valid) throw new AuthError(401, 'bad signature')

    const num = (k: string) =>
        typeof claims[k] === 'number' ? (claims[k] as number) : undefined
    const exp = num('exp')
    if (exp === undefined || exp + LEEWAY < now) {
        throw new AuthError(401, 'token expired')
    }
    for (const k of ['nbf', 'iat']) {
        const t = num(k)
        if (t !== undefined && t - LEEWAY > now) {
            throw new AuthError(401, `token not valid yet (${k})`)
        }
    }

    const fail = (claim: string) => {
        throw new AuthError(403, `token ${claim} does not match`)
    }
    if (claims.iss !== GITHUB_ISSUER) fail('iss')
    const aud = claims.aud
    if (
        !(Array.isArray(aud)
            ? aud.includes(expect.audience)
            : aud === expect.audience)
    ) {
        fail('aud')
    }
    if (claims.repository_id !== expect.repositoryId) fail('repository_id')
    if (claims.ref !== 'refs/heads/main') fail('ref')
    if (claims.environment !== expect.environment) fail('environment')
    if (typeof claims.repository !== 'string') fail('repository')
    const workflow = `${claims.repository}/${expect.workflow}@refs/heads/main`
    if (
        typeof claims.workflow_ref !== 'string' ||
        !claims.workflow_ref.startsWith(workflow)
    ) {
        fail('workflow_ref')
    }
    if (
        claims.event_name !== 'push' &&
        claims.event_name !== 'workflow_dispatch'
    ) {
        fail('event_name')
    }
    return claims as Claims
}
