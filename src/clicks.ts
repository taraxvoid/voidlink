/**
 * Click counts in D1, managed by the Worker through its own binding. CI never
 * runs migrations: a REST D1 grant can't be narrower than the whole account,
 * while the binding needs nothing beyond a token scoped to this one Worker.
 *
 * Each step below is idempotent, so concurrent isolates running them at once
 * is fine. Add new steps at the end; never edit one that has shipped.
 */
const SCHEMA = [
    `CREATE TABLE IF NOT EXISTS voidlink_clicks (
        slug TEXT PRIMARY KEY NOT NULL,
        click_count INTEGER NOT NULL DEFAULT 0,
        last_clicked_at TEXT
    )`,
    `CREATE TABLE IF NOT EXISTS voidlink_meta (
        key TEXT PRIMARY KEY NOT NULL,
        value TEXT NOT NULL
    )`,
]

/**
 * Before voidlink, txv.sh and rvnflt.com kept counts on a `links` table that
 * CI migrations created. Copy them over once, so no history is lost.
 */
const LEGACY_IMPORT = 'legacy_links_import'

const ready = new WeakMap<D1Database, Promise<void>>()

/** Create the tables (once per isolate and database). */
export function ensureSchema(db: D1Database): Promise<void> {
    let done = ready.get(db)
    if (!done) {
        done = migrate(db)
        // A failure is retried by the next request, not cached.
        done.catch(() => ready.delete(db))
        ready.set(db, done)
    }
    return done
}

async function migrate(db: D1Database): Promise<void> {
    await db.batch(SCHEMA.map((sql) => db.prepare(sql)))
    const imported = await db
        .prepare('SELECT 1 FROM voidlink_meta WHERE key = ?')
        .bind(LEGACY_IMPORT)
        .first()
    if (imported) return
    const legacy = await db
        .prepare(
            "SELECT 1 FROM pragma_table_info('links') WHERE name = 'click_count'",
        )
        .first()
    const steps = legacy
        ? [
              db.prepare(
                  `INSERT OR IGNORE INTO voidlink_clicks (slug, click_count, last_clicked_at)
                   SELECT slug, click_count, last_clicked_at FROM links`,
              ),
          ]
        : []
    await db.batch([
        ...steps,
        db
            .prepare(
                "INSERT OR IGNORE INTO voidlink_meta (key, value) VALUES (?, datetime('now'))",
            )
            .bind(LEGACY_IMPORT),
    ])
}

/** Add one click. Never throws: counting must not break a redirect. */
export async function countClick(db: D1Database, slug: string): Promise<void> {
    try {
        await ensureSchema(db)
        await db
            .prepare(
                `INSERT INTO voidlink_clicks (slug, click_count, last_clicked_at)
                 VALUES (?, 1, datetime('now'))
                 ON CONFLICT (slug) DO UPDATE SET
                     click_count = click_count + 1,
                     last_clicked_at = excluded.last_clicked_at`,
            )
            .bind(slug)
            .run()
    } catch (err) {
        console.error('click count failed:', err)
    }
}
