/**
 * A stand-in for GitHub's OIDC issuer: one RSA keypair, a signer, and a JWKS
 * fetcher that counts its calls.
 */
import { GITHUB_ISSUER } from '../src/oidc'

const pair = (await crypto.subtle.generateKey(
    {
        name: 'RSASSA-PKCS1-v1_5',
        modulusLength: 2048,
        publicExponent: new Uint8Array([1, 0, 1]),
        hash: 'SHA-256',
    },
    true,
    ['sign', 'verify'],
)) as CryptoKeyPair

export const publicJwk = {
    ...((await crypto.subtle.exportKey('jwk', pair.publicKey)) as JsonWebKey),
    kid: 'test',
    alg: 'RS256',
    use: 'sig',
}

export const b64url = (data: Uint8Array | string): string =>
    Buffer.from(
        typeof data === 'string' ? new TextEncoder().encode(data) : data,
    )
        .toString('base64')
        .replace(/\+/g, '-')
        .replace(/\//g, '_')
        .replace(/=+$/, '')

export async function sign(
    claims: Record<string, unknown>,
    header: Record<string, unknown> = { alg: 'RS256', typ: 'JWT', kid: 'test' },
): Promise<string> {
    const input = `${b64url(JSON.stringify(header))}.${b64url(JSON.stringify(claims))}`
    const sig = await crypto.subtle.sign(
        'RSASSA-PKCS1-v1_5',
        pair.privateKey,
        new TextEncoder().encode(input),
    )
    return `${input}.${b64url(new Uint8Array(sig))}`
}

/** A JWKS fetcher serving the test key; `calls` counts fetches. */
export function jwksFetcher(keys: JsonWebKey[] = [publicJwk]) {
    const f = async () => {
        f.calls++
        return { keys }
    }
    f.calls = 0
    return f
}

export const AUD = 'voidlink:short.example'

export function goodClaims(now: number): Record<string, unknown> {
    return {
        iss: GITHUB_ISSUER,
        aud: AUD,
        repository: 'owner/links',
        repository_id: '42',
        ref: 'refs/heads/main',
        environment: 'links',
        workflow_ref:
            'owner/links/.github/workflows/redirects.yml@refs/heads/main',
        event_name: 'push',
        iat: now,
        nbf: now,
        exp: now + 300,
    }
}

export const expected = {
    audience: AUD,
    repositoryId: '42',
    workflow: '.github/workflows/redirects.yml',
    environment: 'links',
}
