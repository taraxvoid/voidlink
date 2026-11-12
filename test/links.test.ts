import { describe, expect, test } from 'bun:test'
import {
    buildLinks,
    destinationFor,
    linkError,
    slugFromPath,
} from '../src/links'

const site = { host: 'short.example', reserved: ['verify'] }

describe('slugFromPath', () => {
    test('is case-insensitive and tolerates slashes', () => {
        expect(slugFromPath('/CV/')).toBe('cv')
        expect(slugFromPath('//a-b')).toBe('a-b')
    })
    test('rejects anything that is not a slug', () => {
        for (const p of ['/', '/a/b', '/-x', '/x.sh', `/${'a'.repeat(65)}`])
            expect(slugFromPath(p)).toBeNull()
    })
})

describe('linkError', () => {
    test('accepts a URL or an object', () => {
        expect(linkError('cv', 'https://example.com/cv', site)).toBeNull()
        expect(
            linkError('cv', { to: 'https://example.com', public: true }, site),
        ).toBeNull()
    })
    test.each([
        ['Bad', 'https://example.com', 'invalid slug'],
        ['verify', 'https://example.com', 'reserved'],
        ['_health', 'https://example.com', 'invalid slug'],
        ['cv', 'http://example.com', 'must be https'],
        ['cv', 'not a url', 'invalid destination'],
        ['cv', 'https://short.example/x', 'points back'],
        ['cv', 'https://www.short.example/x', 'points back'],
    ])('%s -> %s: %s', (slug, to, why) => {
        expect(linkError(slug, to, site)).toContain(why)
    })
    test('checks object fields', () => {
        const bad = (x: unknown) => linkError('cv', x as never, site)
        expect(bad({ to: 'https://a.example', extra: 1 })).toContain(
            'unknown field extra',
        )
        expect(bad({ to: 'https://a.example', public: 'yes' })).toContain(
            'public',
        )
        expect(bad({ to: 'https://a.example', title: 3 })).toContain('title')
        expect(bad(null)).toContain('not a URL')
    })
    test('aliases count as the site', () => {
        expect(
            linkError('cv', 'https://dev.short.example', {
                host: 'prod.example',
                aliases: ['dev.short.example'],
            }),
        ).toContain('points back')
    })
})

describe('buildLinks', () => {
    test('normalizes and sorts', () => {
        const table = buildLinks(
            {
                zz: 'https://z.example',
                aa: { to: 'https://a.example', public: true, title: 'A' },
            },
            site,
        )
        expect(Object.keys(table)).toEqual(['aa', 'zz'])
        expect(table.aa).toEqual({
            to: 'https://a.example',
            public: true,
            title: 'A',
        })
        expect(table.zz).toEqual({ to: 'https://z.example', public: false })
    })
    test('reports every problem at once', () => {
        expect(() =>
            buildLinks({ A: 'https://a.example', b: 'http://b.example' }, site),
        ).toThrow(/invalid slug "A"[\s\S]*must be https/)
    })
})

describe('destinationFor', () => {
    const utmSite = { host: 'short.example', utmHosts: ['mine.example'] }
    test('tags our own hosts', () => {
        const url = destinationFor(
            'https://www.mine.example/cv',
            'cv',
            new URLSearchParams(),
            utmSite,
        )
        expect(url.searchParams.get('utm_source')).toBe('short.example')
        expect(url.searchParams.get('utm_medium')).toBe('shortlink')
        expect(url.searchParams.get('utm_campaign')).toBe('cv')
    })
    test("leaves others' hosts alone but passes utm through", () => {
        const url = destinationFor(
            'https://other.example/?q=1',
            'x',
            new URLSearchParams('utm_source=meetup&junk=1'),
            utmSite,
        )
        expect(url.toString()).toBe(
            'https://other.example/?q=1&utm_source=meetup',
        )
    })
    test("stored utm tags win over defaults, the visitor's over both", () => {
        const url = destinationFor(
            'https://mine.example/?utm_medium=card',
            'cv',
            new URLSearchParams('utm_campaign=talk'),
            utmSite,
        )
        expect(url.searchParams.get('utm_medium')).toBe('card')
        expect(url.searchParams.get('utm_campaign')).toBe('talk')
    })
})
