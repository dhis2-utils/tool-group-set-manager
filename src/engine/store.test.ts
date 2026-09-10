import { EngineStore } from './store'
import { GroupSetMeta, Status } from './types'

const ownership: GroupSetMeta = {
    id: 'own',
    displayName: 'Ownership',
    objectType: 'organisationUnit',
    compulsory: true,
    dataDimension: true,
    canWrite: true,
    groups: [
        { id: 'pub', displayName: 'Public', canWrite: true },
        { id: 'priv', displayName: 'Private', canWrite: true },
    ],
}

function loadedStore(): EngineStore {
    const store = new EngineStore()
    store.loadObjects({
        objectType: 'organisationUnit',
        ids: ['root', 'A', 'B', 'a1', 'a2', 'b1'],
        names: ['Root', 'A', 'B', 'a1', 'a2', 'b1'],
        level: Uint8Array.from([1, 2, 2, 3, 3, 3]),
        parentIds: [null, 'root', 'root', 'A', 'A', 'B'],
        domainType: null,
        categoryIdsOfOption: null,
    })
    store.setGroupSets([ownership])
    store.loadMemberships({
        objectType: 'organisationUnit',
        groups: [
            { groupId: 'pub', memberIds: ['a1', 'a2', 'unknown-id'] },
            { groupId: 'priv', memberIds: ['a2', 'b1'] },
        ],
    })
    store.evaluate()
    return store
}

describe('EngineStore', () => {
    it('produces dashboard summaries for the scope', () => {
        const store = loadedStore()
        const [entry] = store.dashboard({ objectType: 'organisationUnit', rootId: 'A' })
        expect(entry.set.id).toBe('own')
        expect(entry.summary).toEqual({ population: 3, ok: 1, missingError: 1, missingWarning: 0, conflict: 1 })
    })

    it('ignores member ids that are not loaded objects', () => {
        const store = loadedStore()
        const [entry] = store.dashboard({ objectType: 'organisationUnit', rootId: null })
        expect(entry.summary.population).toBe(6)
    })

    it('returns a matrix with resolved row objects', () => {
        const store = loadedStore()
        const result = store.matrixFor('own', { objectType: 'organisationUnit', rootId: 'root' }, 2)
        expect(result.groups.map((g) => g.id)).toEqual(['pub', 'priv'])
        expect(result.rows[0].row?.displayName).toBe('A')
        expect(result.rows[0].perGroup).toEqual([1, 0])
        expect(result.rows[0].conflict).toBe(1)
        expect(result.rows[2].row).toBeNull()
    })

    it('pages object lists and includes status and groups', () => {
        const store = loadedStore()
        const page = store.objectsFor(
            'own',
            { objectType: 'organisationUnit', rootId: 'root' },
            { statuses: [Status.Conflict, Status.Ok] },
            0,
            10
        )
        expect(page.total).toBe(3)
        expect(page.items.map((i) => i.id)).toEqual(['a1', 'a2', 'b1'])
        expect(page.items[1].status).toBe(Status.Conflict)
        expect(page.items[1].groups).toEqual([0, 1])
        expect(page.items[0].parentId).toBe('A')
    })

    it('reports hasData false for sets whose type is not loaded', () => {
        const store = new EngineStore()
        store.setGroupSets([{ ...ownership, id: 'x', objectType: 'indicator' }])
        const [entry] = store.dashboard({ objectType: 'indicator', rootId: null })
        expect(entry.hasData).toBe(false)
    })

    it('setNames fills names after the fact', () => {
        const store = loadedStore()
        store.setNames('organisationUnit', ['R', 'AA', 'BB', 'x', 'y', 'z'])
        expect(store.resolve('organisationUnit', [1])[0].displayName).toBe('AA')
    })
})
