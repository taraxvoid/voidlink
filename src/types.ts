/**
 * One short link as written in a redirects file: a bare https URL, or an
 * object when it needs more than that.
 */
export type LinkInput =
    | string
    | {
          /** Where the short link sends people (https). */
          to: string
          /** List it on the site's index page. Default false (unlisted). */
          public?: boolean
          /** Shown on the index page. Default: the slug. */
          title?: string
      }

/**
 * A redirects file (`redirects.ts` in your private links repo): links per site, keyed
 * by the site's host, then by slug.
 *
 *   import type { Redirects } from '@taraxvoid/voidlink'
 *   export default {
 *       'txv.sh': {
 *           cv: { to: 'https://example.com/cv', public: true, title: 'CV' },
 *           gh: 'https://github.com/example',
 *       },
 *   } satisfies Redirects
 *
 * Keep the import type-only: CI loads this file without installing anything.
 */
export type Redirects = Record<string, Record<string, LinkInput>>

/** A link once checked and normalized, as the Worker bundles it. */
export type Link = { to: string; public: boolean; title?: string }

/** Every link of one site, by slug. What `voidlink build` writes. */
export type LinkTable = Record<string, Link>

/** A deployment's own settings (`voidlink.config.ts` in the site's repo). */
export type Site = {
    /** The host short links live on, e.g. 'txv.sh'. Its key in redirects files. */
    host: string
    /** Other hosts the same Worker serves (e.g. dev.example.com). */
    aliases?: string[]
    /** Where unknown links send browsers. */
    homeUrl: string
    /** Heading of the index page. Default: the host. */
    title?: string
    /** One line under the heading. */
    description?: string
    /**
     * What `/` shows a browser: 'list' (default) the public links, 'home' a
     * redirect to homeUrl.
     */
    index?: 'list' | 'home'
    /**
     * Destination hosts (and their subdomains) that get default utm_ tags
     * (source = host, medium = shortlink, campaign = slug).
     */
    utmHosts?: string[]
    /** Paths the site serves itself, so no link may use them as a slug. */
    reserved?: string[]
    /** PostHog event for a click. Sent only when POSTHOG_KEY is set. */
    analytics?: { event: string }
}

/** Worker bindings voidlink reads. */
export interface Env {
    /** Click counts. Optional: without it links still redirect. */
    DB?: D1Database
    /** PostHog project key, a Worker secret. Unset: no analytics. */
    POSTHOG_KEY?: string
    /** Default https://us.i.posthog.com. */
    POSTHOG_HOST?: string
}
