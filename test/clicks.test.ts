import { Database } from 'bun:sqlite'
import { describe, expect, test } from 'bun:test'
import { countClick, ensureSchema } from '../src/clicks'
import { testD1 } from './d1'

const counts = (db: ReturnType<typeof testD1>) =>
    db.sqlite
        .query('SELECT slug, click_count FROM voidlink_clicks ORDER BY slug')
        .all()

describe('clicks', () => {
    test('creates its tables and counts', async () => {
        const db = testD1()
        await countClick(db, 'cv')
        await countClick(db, 'cv')
        await countClick(db, 'gh')
        expect(counts(db)).toEqual([
            { slug: 'cv', click_count: 2 },
            { slug: 'gh', click_count: 1 },
        ])
    })

    test("imports a pre-voidlink `links` table's counts, once", async () => {
        const sqlite = new Database(':memory:')
        sqlite.run(`CREATE TABLE links (
            slug TEXT PRIMARY KEY NOT NULL,
            destination_url TEXT NOT NULL,
            click_count INTEGER NOT NULL DEFAULT 0,
            last_clicked_at TEXT
        )`)
        sqlite.run(
            "INSERT INTO links (slug, destination_url, click_count) VALUES ('cv', 'https://a.example', 7), ('old', 'https://b.example', 2)",
        )
        const db = testD1(sqlite)
        await countClick(db, 'cv')
        expect(counts(db)).toEqual([
            { slug: 'cv', click_count: 8 },
            { slug: 'old', click_count: 2 },
        ])
        // A new isolate (new D1 object, same database) does not import again.
        sqlite.run("UPDATE links SET click_count = 100 WHERE slug = 'old'")
        const again = testD1(sqlite)
        await countClick(again, 'cv')
        expect(counts(again)).toEqual([
            { slug: 'cv', click_count: 9 },
            { slug: 'old', click_count: 2 },
        ])
    })

    test('a database with no legacy table is marked imported', async () => {
        const db = testD1()
        await ensureSchema(db)
        expect(db.sqlite.query('SELECT key FROM voidlink_meta').all()).toEqual([
            { key: 'legacy_links_import' },
        ])
    })

    test('never throws, and retries the schema after a failure', async () => {
        const db = testD1()
        db.sqlite.close()
        const err = console.error
        console.error = () => {}
        await countClick(db, 'cv')
        console.error = err
        // The failed migration is not cached for a later, working database.
        const fresh = testD1()
        await countClick(fresh, 'cv')
        expect(counts(fresh)).toEqual([{ slug: 'cv', click_count: 1 }])
    })
})
