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

/** Type-checks a site config: `export default defineSite({ ... })`. */
export const defineSite = <S extends import('./types').Site>(site: S): S => site
