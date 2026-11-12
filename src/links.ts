import type { Link, LinkInput, LinkTable, Site } from './types'

export const SLUG_RE = /^[a-z0-9][a-z0-9-]{0,63}$/

/** Paths voidlink serves itself. */
export const BUILTIN_RESERVED = ['_health'] as const

export const UTM_KEYS = [
    'utm_source',
    'utm_medium',
    'utm_campaign',
    'utm_content',
    'utm_term',
] as const

/** `/CV/` and `/cv` are the same link; anything else that isn't a slug is null. */
export function slugFromPath(pathname: string): string | null {
    const slug = pathname.replace(/^\/+|\/+$/g, '').toLowerCase()
    return SLUG_RE.test(slug) ? slug : null
}

export function hostMatches(host: string, hosts: readonly string[]): boolean {
    return hosts.some((h) => host === h || host.endsWith(`.${h}`))
}

/** Why a link can't be used, or null when it can. */
export function linkError(
    slug: string,
    input: LinkInput,
    site: Pick<Site, 'host' | 'aliases' | 'reserved'>,
): string | null {
    if (!SLUG_RE.test(slug)) {
        return `invalid slug "${slug}": lowercase letters, digits and hyphens, max 64`
    }
    const reserved = [...BUILTIN_RESERVED, ...(site.reserved ?? [])]
    if (reserved.includes(slug)) return `"${slug}" is reserved by the site`
    if (typeof input !== 'string') {
        if (typeof input !== 'object' || input === null) {
            return `${slug}: not a URL or { to }`
        }
        const extra = Object.keys(input).filter(
            (k) => !['to', 'public', 'title'].includes(k),
        )
        if (extra.length) return `${slug}: unknown field ${extra.join(', ')}`
        if (input.public !== undefined && typeof input.public !== 'boolean') {
            return `${slug}: public must be true or false`
        }
        if (input.title !== undefined && typeof input.title !== 'string') {
            return `${slug}: title must be a string`
        }
    }
    const to = typeof input === 'string' ? input : input.to
    let url: URL
    try {
        url = new URL(to)
    } catch {
        return `${slug}: invalid destination URL "${to}"`
    }
    if (url.protocol !== 'https:') return `${slug}: destination must be https`
    if (hostMatches(url.hostname, [site.host, ...(site.aliases ?? [])])) {
        return `${slug}: destination points back at ${url.hostname}`
    }
    return null
}

export function normalizeLink(input: LinkInput): Link {
    if (typeof input === 'string') return { to: input, public: false }
    const link: Link = { to: input.to, public: input.public ?? false }
    if (input.title) link.title = input.title
    return link
}

/**
 * Check and normalize one site's links. Throws with every problem at once,
 * so a bad redirects file fails the build, not a redirect.
 */
export function buildLinks(
    inputs: Record<string, LinkInput>,
    site: Pick<Site, 'host' | 'aliases' | 'reserved'>,
): LinkTable {
    const errors: string[] = []
    const table: LinkTable = {}
    for (const slug of Object.keys(inputs).sort()) {
        const input = inputs[slug] as LinkInput
        const error = linkError(slug, input, site)
        if (error) errors.push(error)
        else table[slug] = normalizeLink(input)
    }
    if (errors.length) throw new Error(errors.join('\n'))
    return table
}

/**
 * The redirect target: the stored URL, plus default utm_ tags when it's one
 * of utmHosts, with any utm_ params on the short link itself winning. Other
 * query params on the short link are dropped.
 */
export function destinationFor(
    stored: string,
    slug: string,
    incoming: URLSearchParams,
    site: Pick<Site, 'host' | 'utmHosts'>,
): URL {
    const url = new URL(stored)
    if (hostMatches(url.hostname, site.utmHosts ?? [])) {
        const defaults = {
            utm_source: site.host,
            utm_medium: 'shortlink',
            utm_campaign: slug,
        }
        for (const [key, value] of Object.entries(defaults)) {
            if (!url.searchParams.has(key)) url.searchParams.set(key, value)
        }
    }
    for (const key of UTM_KEYS) {
        const value = incoming.get(key)
        if (value) url.searchParams.set(key, value)
    }
    return url
}
