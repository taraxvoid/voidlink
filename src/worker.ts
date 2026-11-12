import { isBotUserAgent } from './bot'
import { countClick } from './clicks'
import { destinationFor, slugFromPath, UTM_KEYS } from './links'
import { indexHtml, indexText, notFoundHtml, notFoundText } from './pages'
import { capture } from './posthog'
import type { Env, LinkTable, Site } from './types'

export type Ctx = Pick<ExecutionContext, 'waitUntil'>

/**
 * The site's own routes, tried before voidlink's. Return a Response to
 * answer, or undefined to fall through to `/`, `/_health` and the links.
 */
export type Routes<E extends Env> = (
    req: Request,
    url: URL,
    env: E,
    ctx: Ctx,
) => Response | undefined | Promise<Response | undefined>

export type WorkerOptions<E extends Env> = {
    site: Site
    /** From `voidlink build`: the site's checked links. */
    links: LinkTable
    routes?: Routes<E>
}

const TEXT = { 'content-type': 'text/plain; charset=utf-8' }
const HTML = { 'content-type': 'text/html; charset=utf-8' }

export function isBrowser(req: Request): boolean {
    return (req.headers.get('accept') ?? '').includes('text/html')
}

/** One request, start to finish. Exported for tests; use createWorker. */
export async function handle<E extends Env>(
    opts: WorkerOptions<E>,
    req: Request,
    env: E,
    ctx: Ctx,
): Promise<Response> {
    const { site, links } = opts
    if (req.method !== 'GET' && req.method !== 'HEAD') {
        return new Response('method not allowed\n', {
            status: 405,
            headers: { ...TEXT, allow: 'GET, HEAD' },
        })
    }
    const url = new URL(req.url)
    const own = await opts.routes?.(req, url, env, ctx)
    if (own) return own

    if (url.pathname === '/') {
        if (!isBrowser(req)) {
            return new Response(indexText(site, links), { headers: TEXT })
        }
        return site.index === 'home'
            ? Response.redirect(site.homeUrl, 302)
            : new Response(indexHtml(site, links), {
                  headers: { ...HTML, 'cache-control': 'public, max-age=300' },
              })
    }
    if (url.pathname === '/_health') return health(env)

    const slug = slugFromPath(url.pathname)
    const link = slug && Object.hasOwn(links, slug) ? links[slug] : undefined
    if (!slug || !link) {
        return isBrowser(req)
            ? new Response(notFoundHtml(site), { status: 404, headers: HTML })
            : new Response(notFoundText(site, url.pathname), {
                  status: 404,
                  headers: TEXT,
              })
    }

    const destination = destinationFor(link.to, slug, url.searchParams, site)
    if (
        req.method === 'GET' &&
        !isBotUserAgent(req.headers.get('user-agent'))
    ) {
        ctx.waitUntil(recordClick(site, req, env, slug, destination))
    }
    return Response.redirect(destination.toString(), 302)
}

async function recordClick(
    site: Site,
    req: Request,
    env: Env,
    slug: string,
    destination: URL,
): Promise<void> {
    const utm = Object.fromEntries(
        UTM_KEYS.flatMap((key) => {
            const value = destination.searchParams.get(key)
            return value ? [[key, value]] : []
        }),
    )
    await Promise.all([
        env.DB ? countClick(env.DB, slug) : undefined,
        site.analytics
            ? capture(
                  env.POSTHOG_KEY,
                  env.POSTHOG_HOST ?? 'https://us.i.posthog.com',
                  site.analytics.event,
                  {
                      source: site.host,
                      slug,
                      destination: destination.origin + destination.pathname,
                      referrer_host: referrerHost(req.headers.get('referer')),
                      country: (req as { cf?: { country?: string } }).cf
                          ?.country,
                      ...utm,
                  },
              )
            : undefined,
    ])
}

function referrerHost(referer: string | null): string | undefined {
    if (!referer) return undefined
    try {
        return new URL(referer).host
    } catch {
        return undefined
    }
}

async function health(env: Env): Promise<Response> {
    if (!env.DB) return Response.json({ ok: true })
    try {
        await env.DB.prepare('SELECT 1').first()
        return Response.json({ ok: true })
    } catch (err) {
        console.error('health check failed:', err)
        return Response.json({ ok: false }, { status: 500 })
    }
}

/**
 * The Worker's default export.
 *
 *   import links from './links.gen.json'
 *   import site from './voidlink.config'
 *   export default createWorker({ site, links })
 */
export function createWorker<E extends Env = Env>(
    opts: WorkerOptions<E>,
): ExportedHandler<E> {
    return {
        async fetch(req, env, ctx) {
            try {
                return await handle(opts, req as Request, env, ctx)
            } catch (err) {
                console.error(err)
                return new Response('internal error\n', { status: 500 })
            }
        },
    }
}
