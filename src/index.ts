export { handleApply, siteInfo } from './apply'
export { isBotUserAgent } from './bot'
export { countClick, ensureSchema } from './clicks'
export {
    BUILTIN_RESERVED,
    buildLinks,
    destinationFor,
    hostMatches,
    linkError,
    normalizeLink,
    SLUG_RE,
    slugFromPath,
    UTM_KEYS,
} from './links'
export type { Claims, Expect, JwksFetcher } from './oidc'
export { AuthError, GITHUB_ISSUER, verifyGitHubToken } from './oidc'
export {
    asComments,
    escapeHtml,
    indexHtml,
    indexText,
    notFoundHtml,
    notFoundText,
    publicLinks,
} from './pages'
export { capture } from './posthog'
export type { Stored, WriteResult } from './store'
export { cachedLinks, readLinks, writeLinks } from './store'
export type {
    Env,
    Link,
    LinkInput,
    LinkTable,
    Redirects,
    Site,
} from './types'
export type { Ctx, Routes, WorkerOptions } from './worker'
export { createWorker, handle, isBrowser } from './worker'

/**
 * Type-checks a site config.
 * @deprecated Write the config as plain data instead:
 * `export default { ... } satisfies Site`. Removed in the next minor.
 */
export const defineSite = <S extends import('./types').Site>(site: S): S => site
