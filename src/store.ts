/**
 * Each site's links, as `voidlink apply` last sent them, in D1 through the
 * Worker's own binding. Reads go through a short per-isolate cache so a
 * redirect costs at most one D1 read per isolate every 30 s.
 */
import { ensureSchema } from './clicks'
import type { LinkTable } from './types'

const CACHE_MS = 30_000

export type Stored = { version: number; sha: string; links: LinkTable }

export type WriteResult =
    | { ok: true; changed: boolean }
    | {
          ok: false
          reason: 'older' | 'conflict'
          current: { version: number; sha: string }
      }

const cache = new Map<string, { links: LinkTable; at: number }>()

/** Forget every cached link set in this isolate (tests). */
export function clearLinkCache(): void {
    cache.clear()
}

/**
 * Store `next` unless the stored version is the same or newer. One statement,
 * so two applies racing can't let the older one win.
 */
export async function writeLinks(
    db: D1Database,
    host: string,
    next: Stored,
): Promise<WriteResult> {
    await ensureSchema(db)
    const res = await db
        .prepare(
            `INSERT INTO voidlink_links (host, version, sha, links, updated_at)
             VALUES (?1, ?2, ?3, ?4, datetime('now'))
             ON CONFLICT (host) DO UPDATE SET
                 version = excluded.version, sha = excluded.sha,
                 links = excluded.links, updated_at = excluded.updated_at
             WHERE excluded.version > voidlink_links.version`,
        )
        .bind(host, next.version, next.sha, JSON.stringify(next.links))
        .run()
    if (res.meta.changes === 1) {
        cache.delete(host)
        return { ok: true, changed: true }
    }
    const row = await db
        .prepare('SELECT version, sha FROM voidlink_links WHERE host = ?')
        .bind(host)
        .first<{ version: number; sha: string }>()
    const current = { version: row?.version ?? 0, sha: row?.sha ?? '' }
    if (current.version === next.version && current.sha === next.sha) {
        return { ok: true, changed: false }
    }
    return {
        ok: false,
        reason: current.version === next.version ? 'conflict' : 'older',
        current,
    }
}

export async function readLinks(
    db: D1Database,
    host: string,
): Promise<Stored | null> {
    await ensureSchema(db)
    const row = await db
        .prepare(
            'SELECT version, sha, links FROM voidlink_links WHERE host = ?',
        )
        .bind(host)
        .first<{ version: number; sha: string; links: string }>()
    if (!row) return null
    return {
        version: row.version,
        sha: row.sha,
        links: JSON.parse(row.links) as LinkTable,
    }
}

/**
 * The site's links, from this isolate's cache when it is under 30 s old.
 * No row yet is an empty table. When D1 fails, the last set read; null if
 * this isolate never read one.
 */
export async function cachedLinks(
    db: D1Database,
    host: string,
    now: number = Date.now(),
): Promise<LinkTable | null> {
    const hit = cache.get(host)
    if (hit && now - hit.at < CACHE_MS) return hit.links
    try {
        const links = (await readLinks(db, host))?.links ?? {}
        cache.set(host, { links, at: now })
        return links
    } catch (err) {
        console.error('voidlink: link read failed:', err)
        return hit?.links ?? null
    }
}
