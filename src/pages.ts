import type { LinkTable, Site } from './types'

export function escapeHtml(s: string): string {
    return s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`)
}

const hostOf = (url: string) => new URL(url).host

/** Public links, sorted by title (or slug). */
export function publicLinks(
    links: LinkTable,
): Array<{ slug: string; title: string; to: string }> {
    return Object.entries(links)
        .filter(([, l]) => l.public)
        .map(([slug, l]) => ({ slug, title: l.title ?? slug, to: l.to }))
        .sort((a, b) => a.title.localeCompare(b.title))
}

const STYLE = `
  :root { color-scheme: light dark;
    --bg: #fbfbfa; --fg: #1d1d1b; --muted: #6b6b66; --line: #e4e4e0; --accent: #3d4fd6; }
  @media (prefers-color-scheme: dark) {
    :root { --bg: #141413; --fg: #ededea; --muted: #9a9a94; --line: #2c2c2a; --accent: #9aa6ff; } }
  * { box-sizing: border-box; }
  body { margin: 0; background: var(--bg); color: var(--fg);
    font: 1rem/1.5 system-ui, -apple-system, "Segoe UI", sans-serif; }
  main { max-width: 36rem; margin: 0 auto; padding: 3rem 1rem 4rem; }
  h1 { font-size: 1.5rem; margin: 0 0 .25rem; letter-spacing: -.01em; }
  header p { margin: 0; color: var(--muted); }
  ul { list-style: none; padding: 0; margin: 2rem 0 0; border-top: 1px solid var(--line); }
  li { border-bottom: 1px solid var(--line); }
  li a { display: flex; flex-wrap: wrap; gap: .25rem 1rem; justify-content: space-between;
    align-items: baseline; padding: .875rem .25rem; color: inherit; text-decoration: none; }
  li a:hover .title, li a:focus-visible .title { color: var(--accent); text-decoration: underline; }
  a:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; border-radius: 2px; }
  .title { font-weight: 600; }
  .meta { color: var(--muted); font: .875rem/1.4 ui-monospace, SFMono-Regular, Menlo, monospace;
    overflow-wrap: anywhere; }
  footer { margin-top: 2rem; color: var(--muted); font-size: .875rem; }
  footer a { color: inherit; }`

/** What `/` shows a browser: the site's public links. */
export function indexHtml(site: Site, links: LinkTable): string {
    const title = escapeHtml(site.title ?? site.host)
    const items = publicLinks(links)
        .map(
            (l) => `    <li><a href="/${l.slug}">
      <span class="title">${escapeHtml(l.title)}</span>
      <span class="meta">${escapeHtml(site.host)}/${l.slug} &rarr; ${escapeHtml(hostOf(l.to))}</span>
    </a></li>`,
        )
        .join('\n')
    const list = items
        ? `<ul>\n${items}\n  </ul>`
        : '<p>No public links yet.</p>'
    const description = site.description
        ? `\n    <p>${escapeHtml(site.description)}</p>`
        : ''
    return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${title}</title>
<style>${STYLE}
</style>
</head>
<body>
<main>
  <header>
    <h1>${title}</h1>${description}
  </header>
  ${list}
  <footer><a href="${escapeHtml(site.homeUrl)}">${escapeHtml(hostOf(site.homeUrl))}</a></footer>
</main>
</body>
</html>
`
}

/** `#` before every line, so piping the body to `sh` does nothing. */
export function asComments(text: string): string {
    return `${text
        .trimEnd()
        .split('\n')
        .map((line) => (line ? `# ${line}` : '#'))
        .join('\n')}\n`
}

/** What `/` gives curl and other non-browsers: the public links, as comments. */
export function indexText(site: Site, links: LinkTable): string {
    const list = publicLinks(links)
    const width = Math.max(0, ...list.map((l) => l.slug.length))
    const lines = list.map(
        (l) => `  ${site.host}/${l.slug.padEnd(width)}  ${l.title}`,
    )
    return asComments(
        `${site.title ?? site.host}\n\n${lines.join('\n') || '  (no public links)'}`,
    )
}

/**
 * A 404 that is safe to pipe to sh: `curl -sL host/typo | sh` prints an
 * error and fails instead of feeding an HTML page to the shell.
 */
export function notFoundText(site: Site, path: string): string {
    const shown = path.replace(/[^\w./-]/g, '')
    return `echo "${site.host}: nothing at ${shown}; see https://${site.host}/" >&2\nexit 1\n`
}

export function notFoundHtml(site: Site): string {
    const home = escapeHtml(site.homeUrl)
    return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta http-equiv="refresh" content="5;url=${home}">
<title>Link not found - ${escapeHtml(site.host)}</title>
<style>${STYLE}
  main { text-align: center; padding-top: 6rem; }
</style>
</head>
<body>
<main>
  <h1>No link here</h1>
  <p>This short link doesn't point anywhere. It may have been mistyped or retired.</p>
  <p>Taking you to <a href="${home}">${escapeHtml(hostOf(site.homeUrl))}</a> in 5 seconds.</p>
</main>
</body>
</html>
`
}
