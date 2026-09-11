import { GroupChange } from './changeSet'
import { buildHierarchy, Hierarchy } from './hierarchy'
import { buildSetMembership, groupsOf, SetMembership } from './membership'
import { ObjectAttributes, populationFor } from './population'
import { MembershipsPayload, ObjectsPayload } from './protocol'
import {
    listObjects,
    matrix,
    MatrixRow,
    ObjectFilter,
    SetSummary,
    summarize,
} from './queries'
import { evaluateSet } from './rules'
import {
    DEFAULT_CONFIG,
    EngineConfig,
    GroupMeta,
    GroupSetMeta,
    ObjectType,
    Status,
} from './types'

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

/**
 * I4: how many `AssignmentPlan.skipped*` ids `planAssignment` keeps and
 * returns. The exact count (`skippedCount`) is unbounded and cheap; the
 * ids themselves are kept only up to this limit, so a national-scale plan
 * with many read-only-blocked objects cannot grow the response (or the
 * preview's rendered text) with population size.
 */
export const SKIPPED_SAMPLE_LIMIT = 50

export interface AssignmentPlan {
    /** additions to the target, deletions from every other group of the set */
    changes: GroupChange[]
    /** how many objects the plan moves */
    affected: number
    /** how many objects were skipped because a group involved is read-only */
    skippedCount: number
    /** up to `SKIPPED_SAMPLE_LIMIT` of the skipped ids, for display */
    skippedSample: string[]
}

export interface ObjectsResult {
    total: number
    /**
     * The offset this page was asked for, echoed back. A caller that appends
     * pages has to know which page a result is, and nothing else in the
     * payload says: the same request is re-issued whenever the engine's load
     * phase changes, so "a result arrived" is not the same as "the next page
     * arrived". Without this a repeat of the page already held was appended
     * a second time, duplicating rows and overshooting `total`.
     */
    offset: number
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

const EMPTY_SUMMARY: SetSummary = {
    population: 0,
    ok: 0,
    unassigned: 0,
    missingError: 0,
    missingWarning: 0,
    conflict: 0,
}

export class EngineStore {
    private types = new Map<ObjectType, TypeIndex>()
    private groupSets: GroupSetMeta[] = []
    private config: EngineConfig = DEFAULT_CONFIG
    private sets = new Map<string, SetState>()

    reset(): void {
        this.types.clear()
        this.sets.clear()
    }

    /**
     * Removes a type and every evaluated set for it, undoing a
     * `loadObjects` whose matching `loadMemberships` did not arrive (the
     * cached-reuse path in loadAll makes both calls with nothing else to
     * undo the first if the second fails). Narrow on purpose: this is not a
     * general transaction mechanism, just enough to keep a worker crash
     * between the two calls from leaving a type holding objects with no
     * memberships -- which reads as every object being uncategorised.
     */
    dropType(objectType: ObjectType): void {
        this.types.delete(objectType)
        for (const [id, state] of this.sets) {
            if (state.set.objectType === objectType) {
                this.sets.delete(id)
            }
        }
    }

    loadObjects(p: ObjectsPayload): void {
        const indexOf = new Map<string, number>()
        p.ids.forEach((id, i) => indexOf.set(id, i))

        let hierarchy: Hierarchy | null = null
        if (p.level && p.parentIds) {
            const parent = new Int32Array(p.ids.length)
            p.parentIds.forEach((pid, i) => {
                const parentIndex = pid === null ? -1 : (indexOf.get(pid) ?? -1)
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
            throw new Error(
                `loadMemberships before loadObjects for ${p.objectType}`
            )
        }
        p.groups.forEach((g) => t.membersByGroup.set(g.groupId, g.memberIds))
    }

    setGroupSets(sets: GroupSetMeta[]): void {
        this.groupSets = sets
    }

    /**
     * Re-evaluates immediately. Plan 2 introduces two callers that change
     * config and could easily forget to follow up with an explicit
     * evaluate(): the Settings page writing required levels, and the
     * tracker toggle. A caller that forgets would serve numbers computed
     * against the old rules with nothing on screen to say so, so the store
     * does not leave that door open.
     */
    setConfig(config: EngineConfig): void {
        this.config = config
        this.evaluate()
    }

    /**
     * Applies a confirmed write to the raw member lists and re-evaluates,
     * so the screen reflects it without a reload. Used both right after a
     * write (the server's own confirmation) and when restoring a change set
     * from the dataStore, weeks later -- which is why unknown ids are
     * ignored rather than treated as errors.
     */
    applyChangeSet(objectType: ObjectType, changes: GroupChange[]): void {
        const t = this.types.get(objectType)
        if (!t) {
            return // Nothing loaded for this type; nothing to apply to.
        }
        changes.forEach((change) => {
            // A change set may name a group that has since been removed
            // from its set (or was never part of one this type loaded);
            // skip it rather than fabricating a group nobody loaded.
            const members = t.membersByGroup.get(change.groupId)
            if (!members) {
                return
            }
            const set = new Set(members)
            change.deletions.forEach((id) => set.delete(id))
            change.additions.forEach((id) => {
                // A change set may also name an object id that no longer
                // exists (deleted since the change was made); ignore it,
                // same as evaluate() already ignores unknown ids in a
                // membership payload loaded from the server.
                if (t.indexOf.has(id)) {
                    set.add(id)
                }
            })
            t.membersByGroup.set(change.groupId, Array.from(set))
        })
        this.evaluate()
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
            const population = populationFor(
                set,
                t.ids.length,
                membership,
                t.attrs,
                this.config
            )
            const level = t.hierarchy ? t.hierarchy.level : null
            const status = evaluateSet(
                set,
                membership,
                population,
                level,
                this.config
            )
            this.sets.set(set.id, { set, membership, status })
        })
    }

    /**
     * -1 means "scan everything": either the type has no hierarchy, or no
     * root was requested. A root id that does not resolve is different from
     * that and must not be read as "scan everything" by the query layer, so
     * it throws instead of silently returning whole-instance numbers.
     */
    private scopeRoot(t: TypeIndex, scope: ScopeRef): number {
        if (!t.hierarchy || scope.rootId === null) {
            return -1
        }
        const idx = t.indexOf.get(scope.rootId)
        if (idx === undefined) {
            throw new Error(
                `Unknown ${scope.objectType} root id ${scope.rootId}`
            )
        }
        return idx
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
                    summary: summarize(
                        state.status,
                        state.membership,
                        t.hierarchy,
                        this.scopeRoot(t, scope)
                    ),
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

    /**
     * The display refs of each given object's parent, in the same order,
     * with null where an object has no parent or the type has no
     * hierarchy. One call per page of rows rather than one per row: at
     * 266,000 objects the difference is a round-trip per visible row
     * versus a round-trip per scroll.
     */
    resolveParents(
        objectType: ObjectType,
        indexes: ArrayLike<number>
    ): (ObjectRef | null)[] {
        const t = this.types.get(objectType)
        const h = t?.hierarchy
        if (!t || !h) {
            return Array.from(indexes, () => null)
        }
        return Array.from(indexes, (index) => {
            const parentIndex = h.parent[index]
            return parentIndex >= 0 ? this.ref(t, parentIndex) : null
        })
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

    /**
     * The hierarchy level of one object, or null when the type has no
     * hierarchy or the id is unknown. The scope selector carries the level of
     * the org unit it selected, but a scope restored from storage before that
     * was stored -- or one whose id is not among the user's own roots -- has
     * no level to carry, and every level-dependent screen (the matrix row
     * level above all) needs one. The engine already holds the hierarchy, so
     * it can answer without another metadata request.
     */
    levelOf(objectType: ObjectType, id: string): number | null {
        const t = this.types.get(objectType)
        if (!t || !t.hierarchy) {
            return null
        }
        const idx = t.indexOf.get(id)
        return idx === undefined ? null : t.hierarchy.level[idx]
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
            rows: rows.map((r) => ({
                ...r,
                row: r.object >= 0 ? this.ref(t, r.object) : null,
            })),
        }
    }

    /**
     * D2/D3: computes the change a bulk fix would write, entirely inside
     * the worker -- the caller gets ids and counts back, never a resolved
     * population with display names. The population is exactly what
     * `objectsFor` would return for the same scope and filter -- there is
     * exactly one population definition, the filter, and it is honoured
     * here through `listObjects` the same way `objectsFor` honours it.
     *
     * Fix round 2: this used to also accept a `selection` parameter that
     * *replaced* the filter outright, bypassing it (and any status
     * restriction a caller had forced into it) entirely. A caller that
     * forced `filter.statuses` to violations-only (as `BulkFixDialog` does
     * for "move to catch-all") while also passing a `selection` got a plan
     * computed against the *unfiltered* selection, silently defeating that
     * restriction -- proven on a real store to strip a correctly
     * categorised object out of its group. A selection is now expressed as
     * `filter.ids` (added to `ObjectFilter`/`listObjects` for exactly this),
     * which *narrows* the filter instead of replacing it, so a forced
     * status restriction applies to a selection exactly as it does to
     * everything else.
     *
     * An object already the sole member of the target needs no write and
     * contributes nothing. Otherwise it needs a deletion from every other
     * group it currently holds and, unless it already holds the target, an
     * addition to the target. Either operation touching a group the caller
     * cannot write to (the target itself, for the addition; any other held
     * group, for a deletion) skips the *whole* object rather than issuing
     * the writable half of it, which would otherwise silently leave the
     * object in more than one group, or in none.
     */
    planAssignment(
        setId: string,
        scope: ScopeRef,
        filter: ObjectFilter,
        targetGroupId: string
    ): AssignmentPlan {
        const { state, t } = this.setState(setId)
        const targetIndex = state.set.groups.findIndex(
            (g) => g.id === targetGroupId
        )
        if (targetIndex < 0) {
            throw new Error(
                `Unknown target group ${targetGroupId} in set ${setId}`
            )
        }
        const targetWritable = state.set.groups[targetIndex].canWrite

        // M2: the typed array `listObjects` returns is iterated directly
        // below, never copied through `Array.from` into a second array of
        // up to 200,000 boxed numbers just to get a `.forEach`.
        const indexes = listObjects(
            state.status,
            state.membership,
            t.hierarchy,
            this.scopeRoot(t, scope),
            filter,
            t.ids
        )

        const additions = new Set<string>()
        const deletionsByGroup = new Map<number, Set<string>>()
        // I4: only a bounded sample of skipped ids is kept -- the count is
        // exact, but the array crossing back to the caller (and, from
        // there, into `ChangeSetPreview`'s rendered text) cannot be
        // allowed to scale with the population, the same reason `changes`
        // and `affected` return ids and counts rather than resolved rows.
        const skippedSample: string[] = []
        let skippedCount = 0
        let affected = 0

        for (let k = 0; k < indexes.length; k++) {
            const idx = indexes[k]
            const id = t.ids[idx]
            const positions = groupsOf(state.membership, idx)
            if (positions.length === 1 && positions[0] === targetIndex) {
                continue // Already the sole member of the target: no change.
            }
            const needsAddition = !positions.includes(targetIndex)
            const deletionPositions = positions.filter((p) => p !== targetIndex)
            const blocked =
                (needsAddition && !targetWritable) ||
                deletionPositions.some((p) => !state.set.groups[p].canWrite)
            if (blocked) {
                skippedCount++
                if (skippedSample.length < SKIPPED_SAMPLE_LIMIT) {
                    skippedSample.push(id)
                }
                continue
            }
            if (needsAddition) {
                additions.add(id)
            }
            deletionPositions.forEach((p) => {
                let ids = deletionsByGroup.get(p)
                if (!ids) {
                    ids = new Set()
                    deletionsByGroup.set(p, ids)
                }
                ids.add(id)
            })
            affected++
        }

        const changes: GroupChange[] = []
        if (additions.size > 0) {
            changes.push({
                groupId: targetGroupId,
                additions: Array.from(additions),
                deletions: [],
            })
        }
        deletionsByGroup.forEach((ids, position) => {
            changes.push({
                groupId: state.set.groups[position].id,
                additions: [],
                deletions: Array.from(ids),
            })
        })

        return { changes, affected, skippedCount, skippedSample }
    }

    objectsFor(
        setId: string,
        scope: ScopeRef,
        filter: ObjectFilter,
        offset: number,
        limit: number
    ): ObjectsResult {
        const { state, t } = this.setState(setId)
        const all = listObjects(
            state.status,
            state.membership,
            t.hierarchy,
            this.scopeRoot(t, scope),
            filter,
            t.ids
        )
        const slice = all.subarray(offset, offset + limit)
        return {
            total: all.length,
            offset,
            items: Array.from(slice, (index) => ({
                ...this.ref(t, index),
                status: state.status[index] as Status,
                groups: groupsOf(state.membership, index),
            })),
        }
    }
}
