import { buildLinks } from './links'
import type { Link, LinkTable, Redirects } from './types'

export type Change =
    | { kind: 'add'; site: string; slug: string; link: Link }
    | { kind: 'remove'; site: string; slug: string; link: Link }
    | { kind: 'change'; site: string; slug: string; from: Link; to: Link }

const same = (a: Link, b: Link) =>
    a.to === b.to && a.public === b.public && a.title === b.title

/** Check every site in a redirects file; throws with all problems, by site. */
export function buildAll(redirects: Redirects): Record<string, LinkTable> {
    if (typeof redirects !== 'object' || redirects === null) {
        throw new Error('redirects file must export an object of sites')
    }
    const out: Record<string, LinkTable> = {}
    const errors: string[] = []
    for (const host of Object.keys(redirects).sort()) {
        try {
            out[host] = buildLinks(redirects[host] ?? {}, { host })
        } catch (err) {
            for (const line of (err as Error).message.split('\n'))
                errors.push(`${host}: ${line}`)
        }
    }
    if (errors.length) throw new Error(errors.join('\n'))
    return out
}

/** What applying `head` over `base` changes, site by site, slug by slug. */
export function diff(
    base: Record<string, LinkTable>,
    head: Record<string, LinkTable>,
): Change[] {
    const changes: Change[] = []
    const sites = [...new Set([...Object.keys(base), ...Object.keys(head)])]
    for (const site of sites.sort()) {
        const b = base[site] ?? {}
        const h = head[site] ?? {}
        const slugs = [...new Set([...Object.keys(b), ...Object.keys(h)])]
        for (const slug of slugs.sort()) {
            const from = b[slug]
            const to = h[slug]
            if (from && to) {
                if (!same(from, to))
                    changes.push({ kind: 'change', site, slug, from, to })
            } else if (to) changes.push({ kind: 'add', site, slug, link: to })
            else if (from)
                changes.push({ kind: 'remove', site, slug, link: from })
        }
    }
    return changes
}

const cell = (s: string) => s.replace(/\|/g, '\\|').replace(/\n/g, ' ')
const describe = (l: Link) =>
    `${l.to}${l.public ? ' (public)' : ''}${l.title ? ` "${l.title}"` : ''}`

/** The plan as a Markdown table, for a terminal or a job summary. */
export function planMarkdown(changes: Change[]): string {
    if (!changes.length) return 'No link changes.\n'
    const rows = changes.map((c) => {
        const what =
            c.kind === 'change'
                ? `${describe(c.from)} → ${describe(c.to)}`
                : describe(c.link)
        return `| ${c.kind} | \`${c.site}/${c.slug}\` | ${cell(what)} |`
    })
    return [
        `${changes.length} link change${changes.length === 1 ? '' : 's'}:`,
        '',
        '| | Link | Destination |',
        '|---|---|---|',
        ...rows,
        '',
    ].join('\n')
}
