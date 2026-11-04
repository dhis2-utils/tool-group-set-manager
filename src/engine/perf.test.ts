import { EngineStore } from './store'
import type { GroupSetMeta } from './types'
import { Status } from './types'

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
        // Measured baseline on the machine this test was written on (two
        // runs): load+evaluate 237-325 ms, three queries 32-46 ms. Budgets
        // below are set at roughly 6x the worse of those two baselines --
        // enough slack that a slower or busier CI machine's normal run
        // doesn't trip this, but tight enough that a true 10x regression
        // (which would land at ~2350-3250 ms / ~320-460 ms) is still well
        // over budget and fails. This is not a tight performance assertion;
        // it exists to catch an order-of-magnitude regression, not to hold
        // the engine to its current speed.
        expect(tLoad).toBeLessThan(2000)
        expect(tQuery).toBeLessThan(300)
        console.info(
            `perf: load+evaluate ${tLoad.toFixed(0)} ms, three queries ${tQuery.toFixed(0)} ms`
        )
    })
})
