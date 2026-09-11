import { CachedType, createMemoryCache } from './cache'

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
        const cache = openCache('http://server')
        await cache.remove('indicator')
        expect(deleteFn).toHaveBeenCalledWith(
            'types',
            'http://server|indicator'
        )
        jest.dontMock('idb')
    })
})
