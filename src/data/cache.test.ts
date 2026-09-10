import { CachedType, createMemoryCache } from './cache'

describe('memory cache', () => {
    it('stores and returns values per type', async () => {
        const cache = createMemoryCache()
        expect(await cache.get('indicator')).toBeUndefined()
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
        await cache.put('indicator', value)
        expect(await cache.get('indicator')).toEqual(value)
        await cache.clear()
        expect(await cache.get('indicator')).toBeUndefined()
    })
})
