import { beforeEach, describe, expect, test } from 'bun:test'
import {
    cachedLinks,
    clearLinkCache,
    readLinks,
    type Stored,
    writeLinks,
} from '../src/store'
import type { LinkTable } from '../src/types'
import { testD1 } from './d1'

const H = 'short.example'
const v1: LinkTable = { cv: { to: 'https://home.example/cv', public: true } }
const v2: LinkTable = {
    gh: { to: 'https://github.com/example', public: false },
}
const stored = (version: number, sha: string, links = v1): Stored => ({
    version,
    sha,
    links,
})

/** A D1 whose every query throws, after `ok` successful prepares. */
function breakable() {
    const db = testD1()
    let broken = false
    const real = db.prepare.bind(db)
    ;(db as { prepare: unknown }).prepare = (q: string) => {
        if (broken) throw new Error('D1 down')
        return real(q)
    }
    return { db, breakIt: () => (broken = true) }
}

beforeEach(() => clearLinkCache())

describe('writeLinks and readLinks', () => {
    test('round trip', async () => {
        const db = testD1()
        expect(await writeLinks(db, H, stored(10, 'a'))).toEqual({
            ok: true,
            changed: true,
        })
        expect(await readLinks(db, H)).toEqual(stored(10, 'a'))
        expect(await readLinks(db, 'other.example')).toBeNull()
    })

    test('same version and sha is a no-op', async () => {
        const db = testD1()
        await writeLinks(db, H, stored(10, 'a'))
        expect(await writeLinks(db, H, stored(10, 'a'))).toEqual({
            ok: true,
            changed: false,
        })
    })

    test('same version, other sha conflicts', async () => {
        const db = testD1()
        await writeLinks(db, H, stored(10, 'a'))
        expect(await writeLinks(db, H, stored(10, 'b', v2))).toEqual({
            ok: false,
            reason: 'conflict',
            current: { version: 10, sha: 'a' },
        })
        expect((await readLinks(db, H))?.links).toEqual(v1)
    })

    test('older version never overwrites, even written second', async () => {
        const db = testD1()
        await writeLinks(db, H, stored(20, 'new', v2))
        expect(await writeLinks(db, H, stored(10, 'old'))).toEqual({
            ok: false,
            reason: 'older',
            current: { version: 20, sha: 'new' },
        })
        expect(await readLinks(db, H)).toEqual(stored(20, 'new', v2))
    })

    test('a newer version replaces the whole set', async () => {
        const db = testD1()
        await writeLinks(db, H, stored(10, 'a'))
        await writeLinks(db, H, stored(11, 'b', v2))
        expect(await readLinks(db, H)).toEqual(stored(11, 'b', v2))
    })
})

describe('cachedLinks', () => {
    test('no row yet is an empty table', async () => {
        expect(await cachedLinks(testD1(), H, 0)).toEqual({})
    })

    test('reads at most once per 30 s', async () => {
        const db = testD1()
        await writeLinks(db, H, stored(10, 'a'))
        clearLinkCache()
        expect(await cachedLinks(db, H, 0)).toEqual(v1)
        // Written behind this isolate's back (another isolate's apply).
        await db
            .prepare('UPDATE voidlink_links SET links = ?, version = 11')
            .bind(JSON.stringify(v2))
            .run()
        expect(await cachedLinks(db, H, 29_000)).toEqual(v1)
        expect(await cachedLinks(db, H, 31_000)).toEqual(v2)
    })

    test("this isolate's own write shows at once", async () => {
        const db = testD1()
        await writeLinks(db, H, stored(10, 'a'))
        expect(await cachedLinks(db, H, 0)).toEqual(v1)
        await writeLinks(db, H, stored(11, 'b', v2))
        expect(await cachedLinks(db, H, 1_000)).toEqual(v2)
    })

    test('stale on error', async () => {
        const { db, breakIt } = breakable()
        await writeLinks(db, H, stored(10, 'a'))
        clearLinkCache()
        expect(await cachedLinks(db, H, 0)).toEqual(v1)
        breakIt()
        expect(await cachedLinks(db, H, 31_000)).toEqual(v1)
    })

    test('never read and failing is null', async () => {
        const { db, breakIt } = breakable()
        breakIt()
        expect(await cachedLinks(db, H, 0)).toBeNull()
    })
})
