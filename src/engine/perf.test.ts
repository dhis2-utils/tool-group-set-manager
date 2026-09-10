import { EngineStore } from './store'
import { GroupSetMeta, Status } from './types'

/** 300K org units: 1 root, 40 states, 800 LGAs, 20K wards, ~279K schools. */
function synthetic() {
    const ids: string[] = ['root']
    const level: number[] = [1]
    const parentIds: (string | null)[] = [null]
    const add = (id: string, l: number, parent: string) => {
        ids.push(id)
        level.push(l)
        parentIds.push(parent)
    }
    for (let s = 0; s < 40; s++) {
        add(`s${s}`, 2, 'root')
        for (let d = 0; d < 20; d++) {
            add(`s${s}d${d}`, 3, `s${s}`)
            for (let w = 0; w < 25; w++) {
                add(`s${s}d${d}w${w}`, 4, `s${s}d${d}`)
                for (let f = 0; f < 14; f++) {
                    add(`s${s}d${d}w${w}f${f}`, 5, `s${s}d${d}w${w}`)
                }
            }
        }
    }
    const pub: string[] = []
    const priv: string[] = []
    ids.forEach((id, i) => {
        if (level[i] !== 5) {
            return
        }
        if (i % 7 === 0) {
            return // missing
        }
        if (i % 2 === 0) {
            pub.push(id)
        } else {
            priv.push(id)
        }
        if (i % 97 === 0) {
            pub.push(id)
            priv.push(id) // conflict
        }
    })
    return { ids, level: Uint8Array.from(level), parentIds, pub, priv }
}

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

describe('engine performance on 300K org units', () => {
    const data = synthetic()

    it('loads, evaluates and answers queries within budget', () => {
        const store = new EngineStore()
        const t0 = performance.now()
        store.loadObjects({
            objectType: 'organisationUnit',
            ids: data.ids,
            names: null,
            level: data.level,
            parentIds: data.parentIds,
            domainType: null,
            categoryIdsOfOption: null,
        })
        store.setGroupSets([ownership])
        store.loadMemberships({
            objectType: 'organisationUnit',
            groups: [
                { groupId: 'pub', memberIds: data.pub },
                { groupId: 'priv', memberIds: data.priv },
            ],
        })
        store.evaluate()
        const tLoad = performance.now() - t0

        const t1 = performance.now()
        const dash = store.dashboard({
            objectType: 'organisationUnit',
            rootId: 'root',
        })
        const m = store.matrixFor(
            'own',
            { objectType: 'organisationUnit', rootId: 'root' },
            2
        )
        const page = store.objectsFor(
            'own',
            { objectType: 'organisationUnit', rootId: 's3' },
            { statuses: [Status.Conflict] },
            0,
            200
        )
        const tQuery = performance.now() - t1

        expect(data.ids.length).toBeGreaterThan(280000)
        expect(dash[0].summary.conflict).toBeGreaterThan(0)
        expect(m.rows.length).toBe(41) // 40 states + "above" row
        expect(page.total).toBeGreaterThan(0)
        // Budgets are generous for CI machines; the point is catching 10x regressions.
        expect(tLoad).toBeLessThan(5000)
        expect(tQuery).toBeLessThan(500)
        console.info(
            `perf: load+evaluate ${tLoad.toFixed(0)} ms, three queries ${tQuery.toFixed(0)} ms`
        )
    })
})
