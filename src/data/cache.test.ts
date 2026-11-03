import type { CachedType } from './cache'
import { cacheIdentity, createMemoryCache } from './cache'
import type { Fetcher } from './sources/DataSource'

const value: CachedType = {
    objects: {
        objectType: 'indicator',
        ids: ['i'],
        names: ['I'],
        level: null,
        parentIds: null,
        domainType: null,
        categoryIdsOfOption: null,
    },
    memberships: { objectType: 'indicator', groups: [] },
    names: ['I'],
    groupIds: [],
    objectTotal: 1,
    savedAt: 1,
}

describe('memory cache', () => {
    it('stores and returns values per type', async () => {
        const cache = createMemoryCache()
        expect(await cache.get('indicator')).toBeUndefined()
        await cache.put('indicator', value)
        expect(await cache.get('indicator')).toEqual(value)
        await cache.clear()
        expect(await cache.get('indicator')).toBeUndefined()
    })

    it('removes only the named type, leaving the others untouched', async () => {
        const cache = createMemoryCache()
        await cache.put('indicator', value)
        await cache.put('dataElement', value)
        await cache.remove('indicator')
        expect(await cache.get('indicator')).toBeUndefined()
        expect(await cache.get('dataElement')).toEqual(value)
    })
})

describe('IndexedDB-backed cache', () => {
    // idb has no real IndexedDB to talk to under jsdom, so `openDB` is
    // mocked here rather than exercised against a real database -- the same
    // reason no test of get/put/clear existed for this implementation
    // before this task.
    it("remove deletes only that type's key, scoped to the server URL", async () => {
        const deleteFn = jest.fn().mockResolvedValue(undefined)
        jest.resetModules()
        jest.doMock('idb', () => ({
            openDB: () =>
                Promise.resolve({
                    get: jest.fn(),
                    put: jest.fn(),
                    delete: deleteFn,
                    clear: jest.fn(),
                }),
        }))
        const { openCache } = await import('./cache')
        const cache = openCache('http://server', {
            userId: 'u1',
            locale: 'fr/en',
        })
        await cache.remove('indicator')
        // L8: the user and locale are part of the key, so another user of
        // the same browser never reads this user's entry.
        expect(deleteFn).toHaveBeenCalledWith(
            'types',
            'http://server|u1|fr/en|indicator'
        )
        jest.dontMock('idb')
        // Without this, a test added after this one that dynamically
        // imports './cache' would silently get back the mocked module: the
        // module registry, not just the mock factory, was reset at the top
        // of this test, so `jest.dontMock` alone leaves the already-mocked
        // instance cached under the un-mocked name.
        jest.resetModules()
    })
})

describe('cacheIdentity', () => {
    const fetcherFor =
        (response: Response): Fetcher =>
        () =>
            Promise.resolve(response)

    it('reads the user id and both locales', async () => {
        const fetcher = fetcherFor(
            new Response(
                JSON.stringify({
                    id: 'u1',
                    settings: { keyUiLocale: 'fr', keyDbLocale: 'pt' },
                })
            )
        )
        expect(await cacheIdentity(fetcher)).toEqual({
            userId: 'u1',
            locale: 'fr/pt',
        })
    })

    it('gives null when the user cannot be read', async () => {
        const fetcher = fetcherFor(new Response('', { status: 500 }))
        expect(await cacheIdentity(fetcher)).toBeNull()
    })
})
