/**
 * `PUT /_voidlink/links`: a links repo's workflow sends this site its whole
 * link set, proving who it is with a GitHub Actions OIDC token. The Worker
 * checks the token against `site.apply`, validates the links against its own
 * config and stores them through its D1 binding. Responses and logs carry
 * counts and versions, never destinations.
 */
import { BUILTIN_RESERVED, buildLinks } from './links'
import { AuthError, type JwksFetcher, verifyGitHubToken } from './oidc'
import { writeLinks } from './store'
import type { Env, LinkInput, Site } from './types'

const MAX_BODY = 262_144
const TEXT = { 'content-type': 'text/plain; charset=utf-8' }

const reply = (status: number, message: string) =>
    new Response(`${message}\n`, { status, headers: TEXT })

/** What `voidlink plan --remote` needs to know about a site. No links. */
export function siteInfo(site: Site): { host: string; reserved: string[] } {
    return {
        host: site.host,
        reserved: [...BUILTIN_RESERVED, ...(site.reserved ?? [])],
    }
}

const isObj = (x: unknown): x is Record<string, unknown> =>
    typeof x === 'object' && x !== null && !Array.isArray(x)

export async function handleApply(
    req: Request,
    site: Site,
    env: Env,
    opts: { now?: number; jwks?: JwksFetcher } = {},
): Promise<Response> {
    if (!site.apply) return reply(404, 'not found')
    if (!env.DB) return reply(500, 'no DB binding')

    const auth = req.headers.get('authorization') ?? ''
    const token = /^Bearer (\S+)$/i.exec(auth)?.[1]
    if (!token) return reply(401, 'missing bearer token')
    const type = req.headers.get('content-type') ?? ''
    if (!/^application\/json\b/i.test(type)) {
        return reply(400, 'content-type must be application/json')
    }
    const declared = Number(req.headers.get('content-length') ?? 0)
    if (declared > MAX_BODY) return reply(400, 'body over 256 KiB')

    try {
        await verifyGitHubToken(
            token,
            {
                audience: `voidlink:${site.host}`,
                repositoryId: String(site.apply.repositoryId),
                workflow: site.apply.workflow,
                environment: site.apply.environment,
            },
            opts,
        )
    } catch (err) {
        if (err instanceof AuthError) return reply(err.status, err.message)
        throw err
    }

    // Read after the token check, so an unauthenticated caller can't make
    // the Worker buffer anything.
    const bytes = await req.arrayBuffer()
    if (bytes.byteLength > MAX_BODY) return reply(400, 'body over 256 KiB')
    let body: unknown
    try {
        body = JSON.parse(new TextDecoder().decode(bytes))
    } catch {
        return reply(400, 'body is not JSON')
    }
    if (!isObj(body)) return reply(400, 'body must be an object')
    const { version, sha, links } = body
    if (
        typeof version !== 'number' ||
        !Number.isSafeInteger(version) ||
        version < 1
    ) {
        return reply(400, 'version must be a positive integer')
    }
    if (typeof sha !== 'string' || !sha) {
        return reply(400, 'sha must be a non-empty string')
    }
    if (!isObj(links)) return reply(400, 'links must be an object of slugs')

    let table: ReturnType<typeof buildLinks>
    try {
        table = buildLinks(links as Record<string, LinkInput>, site)
    } catch (err) {
        return reply(422, (err as Error).message)
    }

    const result = await writeLinks(env.DB, site.host, {
        version,
        sha,
        links: table,
    })
    if (!result.ok) {
        const { current } = result
        return reply(
            409,
            result.reason === 'older'
                ? `version ${version} is older than the stored ${current.version}`
                : `version ${version} is already stored with another sha`,
        )
    }
    const count = Object.keys(table).length
    console.log(
        `voidlink: ${site.host} links ${result.changed ? 'now' : 'already'} at version ${version} (${count})`,
    )
    return Response.json({ version, sha, count })
}
