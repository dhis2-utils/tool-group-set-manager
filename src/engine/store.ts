import { buildHierarchy, Hierarchy } from './hierarchy'
import { buildSetMembership, groupsOf, SetMembership } from './membership'
import { ObjectAttributes, populationFor } from './population'
import { MembershipsPayload, ObjectsPayload } from './protocol'
import { listObjects, matrix, MatrixRow, ObjectFilter, SetSummary, summarize } from './queries'
import { evaluateSet } from './rules'
import { DEFAULT_CONFIG, EngineConfig, GroupMeta, GroupSetMeta, ObjectType, Status } from './types'

export interface ScopeRef {
    objectType: ObjectType
    /** org unit id, or null for everything */
    rootId: string | null
}

export interface ObjectRef {
    index: number
    id: string
    displayName: string | null
    level: number | null
    parentId: string | null
}

export interface DashboardEntry {
    set: GroupSetMeta
    summary: SetSummary
    hasData: boolean
}

export interface MatrixResult {
    rows: (MatrixRow & { row: ObjectRef | null })[]
    groups: GroupMeta[]
}

export interface ObjectsResult {
    total: number
    items: (ObjectRef & { status: Status; groups: number[] })[]
}

interface TypeIndex {
    ids: string[]
    names: string[] | null
    indexOf: Map<string, number>
    hierarchy: Hierarchy | null
    attrs: ObjectAttributes
    /** raw member id lists per group id, kept so evaluate() can re-run after config changes */
    membersByGroup: Map<string, string[]>
}

interface SetState {
    set: GroupSetMeta
    membership: SetMembership
    status: Uint8Array
}

const EMPTY_SUMMARY: SetSummary = { population: 0, ok: 0, missingError: 0, missingWarning: 0, conflict: 0 }

export class EngineStore {
    private types = new Map<ObjectType, TypeIndex>()
    private groupSets: GroupSetMeta[] = []
    private config: EngineConfig = DEFAULT_CONFIG
    private sets = new Map<string, SetState>()

    reset(): void {
        this.types.clear()
        this.sets.clear()
    }

    loadObjects(p: ObjectsPayload): void {
        const indexOf = new Map<string, number>()
        p.ids.forEach((id, i) => indexOf.set(id, i))

        let hierarchy: Hierarchy | null = null
        if (p.level && p.parentIds) {
            const parent = new Int32Array(p.ids.length)
            p.parentIds.forEach((pid, i) => {
                const parentIndex = pid === null ? -1 : indexOf.get(pid) ?? -1
                parent[i] = parentIndex
            })
            hierarchy = buildHierarchy(parent, p.level)
        }

        const attrs: ObjectAttributes = {}
        if (p.domainType) {
            attrs.domainType = p.domainType
        }
        if (p.categoryIdsOfOption) {
            const categoryIndex = new Map<string, number>()
            attrs.categoryOfOption = p.categoryIdsOfOption.map((cats) =>
                Int32Array.from(
                    cats.map((c) => {
                        if (!categoryIndex.has(c)) {
                            categoryIndex.set(c, categoryIndex.size)
                        }
                        return categoryIndex.get(c) as number
                    })
                )
            )
        }

        const existing = this.types.get(p.objectType)
        this.types.set(p.objectType, {
            ids: p.ids,
            names: p.names,
            indexOf,
            hierarchy,
            attrs,
            membersByGroup: existing?.membersByGroup ?? new Map(),
        })
    }

    setNames(objectType: ObjectType, names: string[]): void {
        const t = this.types.get(objectType)
        if (t) {
            t.names = names
        }
    }

    loadMemberships(p: MembershipsPayload): void {
        const t = this.types.get(p.objectType)
        if (!t) {
            throw new Error(`loadMemberships before loadObjects for ${p.objectType}`)
        }
        p.groups.forEach((g) => t.membersByGroup.set(g.groupId, g.memberIds))
    }

    setGroupSets(sets: GroupSetMeta[]): void {
        this.groupSets = sets
    }

    setConfig(config: EngineConfig): void {
        this.config = config
    }

    /** Rebuilds membership and status for every set whose object type is loaded. */
    evaluate(): void {
        this.sets.clear()
        this.groupSets.forEach((set) => {
            const t = this.types.get(set.objectType)
            if (!t) {
                return
            }
            const groupMembers = set.groups.map((g) => {
                const ids = t.membersByGroup.get(g.id) ?? []
                const out: number[] = []
                ids.forEach((id) => {
                    const idx = t.indexOf.get(id)
                    if (idx !== undefined) {
                        out.push(idx)
                    }
                })
                return Int32Array.from(out)
            })
            const membership = buildSetMembership(t.ids.length, groupMembers)
            const population = populationFor(set, t.ids.length, membership, t.attrs, this.config)
            const level = t.hierarchy ? t.hierarchy.level : null
            const status = evaluateSet(set, membership, population, level, this.config)
            this.sets.set(set.id, { set, membership, status })
        })
    }

    private scopeRoot(t: TypeIndex, scope: ScopeRef): number {
        if (!t.hierarchy || scope.rootId === null) {
            return -1
        }
        return t.indexOf.get(scope.rootId) ?? -1
    }

    dashboard(scope: ScopeRef): DashboardEntry[] {
        return this.groupSets
            .filter((set) => set.objectType === scope.objectType)
            .map((set) => {
                const state = this.sets.get(set.id)
                const t = this.types.get(set.objectType)
                if (!state || !t) {
                    return { set, summary: EMPTY_SUMMARY, hasData: false }
                }
                return {
                    set,
                    summary: summarize(state.status, t.hierarchy, this.scopeRoot(t, scope)),
                    hasData: true,
                }
            })
    }

    resolve(objectType: ObjectType, indexes: ArrayLike<number>): ObjectRef[] {
        const t = this.types.get(objectType)
        if (!t) {
            return []
        }
        return Array.from(indexes, (index) => this.ref(t, index))
    }

    private ref(t: TypeIndex, index: number): ObjectRef {
        const h = t.hierarchy
        const parentIndex = h ? h.parent[index] : -1
        return {
            index,
            id: t.ids[index],
            displayName: t.names ? t.names[index] : null,
            level: h ? h.level[index] : null,
            parentId: parentIndex >= 0 ? t.ids[parentIndex] : null,
        }
    }

    indexOf(objectType: ObjectType, id: string): number {
        return this.types.get(objectType)?.indexOf.get(id) ?? -1
    }

    private setState(setId: string): { state: SetState; t: TypeIndex } {
        const state = this.sets.get(setId)
        if (!state) {
            throw new Error(`Unknown or unevaluated group set ${setId}`)
        }
        const t = this.types.get(state.set.objectType) as TypeIndex
        return { state, t }
    }

    matrixFor(setId: string, scope: ScopeRef, rowLevel: number): MatrixResult {
        const { state, t } = this.setState(setId)
        const rows = matrix(
            state.status,
            state.membership,
            t.hierarchy,
            this.scopeRoot(t, scope),
            rowLevel,
            state.set.groups.length
        )
        return {
            groups: state.set.groups,
            rows: rows.map((r) => ({ ...r, row: r.object >= 0 ? this.ref(t, r.object) : null })),
        }
    }

    objectsFor(
        setId: string,
        scope: ScopeRef,
        filter: ObjectFilter,
        offset: number,
        limit: number
    ): ObjectsResult {
        const { state, t } = this.setState(setId)
        const all = listObjects(state.status, state.membership, t.hierarchy, this.scopeRoot(t, scope), filter)
        const slice = all.subarray(offset, offset + limit)
        return {
            total: all.length,
            items: Array.from(slice, (index) => ({
                ...this.ref(t, index),
                status: state.status[index] as Status,
                groups: groupsOf(state.membership, index),
            })),
        }
    }
}
