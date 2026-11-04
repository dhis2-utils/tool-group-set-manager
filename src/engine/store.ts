import type { GroupChange } from './changeSet'
import type { Hierarchy } from './hierarchy'
import { buildHierarchy } from './hierarchy'
import type { SetMembership } from './membership'
import { buildSetMembership, groupsOf } from './membership'
import type { ObjectAttributes } from './population'
import { populationFor } from './population'
import type { MembershipsPayload, ObjectsPayload } from './protocol'
import type { MatrixRow, ObjectFilter, SetSummary } from './queries'
import { listObjects, matrix, summarize } from './queries'
import { evaluateSet } from './rules'
import type {
    EngineConfig,
    GroupMeta,
    GroupSetMeta,
    ObjectType,
    Status,
} from './types'
import { DEFAULT_CONFIG } from './types'

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
    /**
     * Whether the engine's list has rows after this page. A caller that
     * pages by cursor (`after`) cannot compare its own row count with
     * `total`: it keeps rows an inline fix has since moved out of the
     * filter, so its count and the engine's list no longer line up.
     */
    hasMore: boolean
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
    /**
     * Lazily built lowercase mirror of `names`, one entry per object, used
     * by the `text` predicate in `listObjects`. `undefined` means "not
     * built yet"; `null` means "built, and there were no names to lower"
     * (`text` then matches nothing rather than everything -- see
     * `ObjectFilter.text`). Invalidated (reset to `undefined`) by anything
     * that changes `names` -- `loadObjects` (a fresh `TypeIndex` never
     * carries this field over), `setNames` (explicit reset) and `dropType`
     * (the whole `TypeIndex`, cache included, is deleted) -- so a search
     * can never see a name that is no longer there.
     */
    namesLowerCache?: string[] | null
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
    /**
     * Bumped by every method that changes what a query would answer
     * (evaluating, applying a change, dropping or resetting data, renaming).
     * The worker sends it back with every response, so a view on the main
     * thread can re-ask its question after any such change -- a write or a
     * late `setConfig` -- not only when the load phase moves.
     */
    revision = 0

    reset(): void {
        this.types.clear()
        this.sets.clear()
        this.revision++
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
        this.revision++
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
            t.namesLowerCache = undefined
            this.revision++
        }
    }

    /**
     * Builds and caches the lowercase name mirror `text` searches against,
     * on first use per type. See `TypeIndex.namesLowerCache` for the
     * invalidation rules that keep this from ever serving a stale index.
     */
    private namesLower(t: TypeIndex): string[] | null {
        if (t.namesLowerCache === undefined) {
            t.namesLowerCache = t.names
                ? t.names.map((n) => n.toLowerCase())
                : null
        }
        return t.namesLowerCache
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
     * Re-evaluates immediately. The tracker toggle is the only caller that
     * changes config, and it changes which data elements are in the
     * population, so a caller that forgot to follow up with an explicit
     * evaluate() would serve numbers computed against the old population
     * with nothing on screen to say so. The store does not leave that door
     * open.
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
            t.membersByGroup.set(change.groupId, [...set])
        })
        // M5: only the group sets that actually contain one of the groups
        // this change named can have changed -- a set's membership and
        // status are derived from its own groups' member lists and nothing
        // else. Re-evaluating every set of the type meant a full rebuild
        // of seven sets over 266,000 org units for one inline row
        // assignment, paid per click.
        const touchedGroups = new Set(changes.map((c) => c.groupId))
        this.groupSets.forEach((set) => {
            if (
                set.objectType === objectType &&
                set.groups.some((g) => touchedGroups.has(g.id))
            ) {
                this.evaluateOne(set)
            }
        })
        this.revision++
    }

    /**
     * Replaces the named groups' membership with exactly `memberIds`, then
     * re-evaluates the sets that contain them.
     *
     * The absolute counterpart to `applyChangeSet`, and it exists for the bulk
     * fix's pre-write freshness check (spec 2026-09-16 section 5.2): a plan
     * can only be recomputed against fresh data once that data is in the
     * engine, and `loadMemberships` replaces a whole type rather than named
     * groups.
     *
     * Unknown ids and unknown groups are ignored rather than fabricated, the
     * same reading `applyChangeSet` applies -- a group the type never loaded
     * is not this method's to invent, and an object id that no longer exists
     * must not become a member of anything.
     */
    setGroupMembers(
        objectType: ObjectType,
        groups: { groupId: string; memberIds: string[] }[]
    ): void {
        const t = this.types.get(objectType)
        if (!t) {
            return // Nothing loaded for this type; nothing to set.
        }
        const touchedGroups = new Set<string>()
        groups.forEach(({ groupId, memberIds }) => {
            if (!t.membersByGroup.has(groupId)) {
                return
            }
            t.membersByGroup.set(
                groupId,
                memberIds.filter((id) => t.indexOf.has(id))
            )
            touchedGroups.add(groupId)
        })
        // Same narrowing as applyChangeSet, and for the same reason: only the
        // sets containing one of these groups can have changed, and a full
        // rebuild of every set of the type is not something to pay per Apply.
        this.groupSets.forEach((set) => {
            if (
                set.objectType === objectType &&
                set.groups.some((g) => touchedGroups.has(g.id))
            ) {
                this.evaluateOne(set)
            }
        })
        this.revision++
    }

    /** Rebuilds membership and status for every set whose object type is loaded. */
    evaluate(): void {
        this.sets.clear()
        this.groupSets.forEach((set) => {
            this.evaluateOne(set)
        })
        this.revision++
    }

    /** One set's rebuild -- see `evaluate` and, for why it is callable on
     * its own, `applyChangeSet`. */
    private evaluateOne(set: GroupSetMeta): void {
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
        const status = evaluateSet(set, membership, population)
        this.sets.set(set.id, { set, membership, status })
    }

    /**
     * -1 means "no restriction, scan everything": either the type has no
     * hierarchy, or no root was requested. A root id that does not resolve
     * is different from that and must not be read as "scan everything" by
     * the query layer, so it throws instead of silently returning
     * whole-instance numbers.
     *
     * `!t.hierarchy` is checked *before* `scope.rootId`, on purpose: a flat
     * type (no hierarchy) has no root to restrict by, so this always
     * returns -1 for one regardless of what `scope.rootId` holds -- it
     * never even reaches the id lookup below. That is what makes
     * `matrix`'s flat branch in queries.ts provably safe to ignore
     * `scopeRoot`: for a flat type, this method guarantees that parameter
     * is always -1.
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
                // A set with no groups has nothing to check, and loadAll
                // never loads a type whose sets all have none -- so waiting
                // for its data would show "Loading…" forever. The card says
                // the set has no groups instead.
                if (set.groups.length === 0) {
                    return { set, summary: EMPTY_SUMMARY, hasData: true }
                }
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

    /**
     * I3: resolves ids to indexes in one call. History's Export resolves
     * every id in a change set, and a national fix's change set is
     * unbounded -- the writer's own doc comment names a hundred thousand
     * memberships. One call per id is a hundred thousand sequential worker
     * round-trips and minutes of frozen UI; the map is already here, so one
     * call answers the lot. Unknown ids (and an unloaded type) give -1 in place, so the
     * result is positionally aligned with `ids`.
     */
    indexesOf(objectType: ObjectType, ids: string[]): number[] {
        const t = this.types.get(objectType)
        if (!t) {
            return ids.map(() => -1)
        }
        return ids.map((id) => t.indexOf.get(id) ?? -1)
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
        if (targetIndex === -1) {
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
            t.ids,
            this.namesLower(t)
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

        for (const idx of indexes) {
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
                additions: [...additions],
                deletions: [],
            })
        }
        deletionsByGroup.forEach((ids, position) => {
            changes.push({
                groupId: state.set.groups[position].id,
                additions: [],
                deletions: [...ids],
            })
        })

        return { changes, affected, skippedCount, skippedSample }
    }

    /**
     * What would happen if `changes` (a change set's own recorded
     * `changes`, NOT `invert()`'s output -- inversion happens in here)
     * were undone right now, given current membership rather than the
     * change set's record of a past one.
     *
     * The rule (task 9 / spec 5.4): a change set's addition is only
     * reverted (as a deletion) if the object is currently IN that group,
     * and its deletion is only reverted (as an addition) if the object is
     * currently NOT in it. An object is judged as a whole, not group by
     * group -- if it touched more than one group (a "move" always does:
     * one deletion, one addition), every one of those touches must still
     * hold for any of them to be reverted. This is what stops reverting a
     * bulk move from dragging an object back out of a group a user
     * assigned it to by hand afterwards: that manual assignment already
     * broke at least one of the checks, so the whole object is skipped.
     *
     * Fix round 1, I2/I3: two more ways a touch can fail to "still hold",
     * checked before the addition/deletion test above even runs, since
     * neither has a sensible in/out answer at all:
     *
     * - I2: a touched group the caller cannot write to (spec 5.6, same
     *   whole-object skip `planAssignment` uses for the same reason --
     *   applying the writable half only would leave the object in more
     *   than one group, or in none).
     * - I3: a group that has since been removed from the set entirely.
     *   `positionOfGroup` has no entry for it, and treating "not found" as
     *   "not currently in it" is wrong for an original *deletion* from
     *   that group: it would pass the "currently not in it" test (there is
     *   nowhere for the object to currently be) and revert by emitting an
     *   addition to a group that is no longer part of the set at all.
     *   Both must be rejected regardless of which way the touch runs.
     */
    planRevert(setId: string, changes: GroupChange[]): AssignmentPlan {
        const { state, t } = this.setState(setId)
        const positionOfGroup = new Map(
            state.set.groups.map((g, i) => [g.id, i])
        )

        // Every id touched by the change set, with the group + original
        // action (before inversion) it was touched under. A "move"
        // contributes two entries for the same id (a deletion from its old
        // group, an addition to its new one); both must check out for
        // either to be reverted.
        const touches = new Map<
            string,
            { groupId: string; wasAddition: boolean }[]
        >()
        changes.forEach((change) => {
            change.additions.forEach((id) => {
                const arr = touches.get(id) ?? []
                arr.push({ groupId: change.groupId, wasAddition: true })
                touches.set(id, arr)
            })
            change.deletions.forEach((id) => {
                const arr = touches.get(id) ?? []
                arr.push({ groupId: change.groupId, wasAddition: false })
                touches.set(id, arr)
            })
        })

        const additionsByGroup = new Map<string, string[]>()
        const deletionsByGroup = new Map<string, string[]>()
        const skippedSample: string[] = []
        let skippedCount = 0
        let affected = 0

        touches.forEach((entries, id) => {
            const idx = t.indexOf.get(id)
            const positions =
                idx !== undefined ? groupsOf(state.membership, idx) : []
            const stillHolds = entries.every(({ groupId, wasAddition }) => {
                const position = positionOfGroup.get(groupId)
                if (position === undefined) {
                    // I3: the group is no longer part of the set at all --
                    // neither an "in it" nor a "not in it" reading is safe.
                    return false
                }
                if (!state.set.groups[position].canWrite) {
                    // I2: spec 5.6 -- a touch this caller cannot write
                    // fails the whole object, the same as planAssignment.
                    return false
                }
                const currentlyIn = positions.includes(position)
                // An original addition is only reverted if the object is
                // currently in that group; an original deletion only if it
                // is currently not in it.
                return wasAddition ? currentlyIn : !currentlyIn
            })
            if (!stillHolds) {
                skippedCount++
                if (skippedSample.length < SKIPPED_SAMPLE_LIMIT) {
                    skippedSample.push(id)
                }
                return
            }
            entries.forEach(({ groupId, wasAddition }) => {
                const byGroup = wasAddition
                    ? deletionsByGroup
                    : additionsByGroup
                const ids = byGroup.get(groupId) ?? []
                ids.push(id)
                byGroup.set(groupId, ids)
            })
            affected++
        })

        const groupIds = new Set([
            ...additionsByGroup.keys(),
            ...deletionsByGroup.keys(),
        ])
        const revertChanges: GroupChange[] = Array.from(
            groupIds,
            (groupId) => ({
                groupId,
                additions: additionsByGroup.get(groupId) ?? [],
                deletions: deletionsByGroup.get(groupId) ?? [],
            })
        )

        return { changes: revertChanges, affected, skippedCount, skippedSample }
    }

    /**
     * One page of the filtered list. With `after` (the id of the last row
     * the caller holds) the page starts right after that object in the
     * list's own order, wherever it now sits; otherwise at `offset`.
     *
     * The cursor is what keeps an inline fix from skipping a row: the fix
     * moves its object out of a filtered list, so every later object shifts
     * up one position, and the next page asked for by offset started one
     * row too far. The cursor object itself may be out of the list by then;
     * its position in the list's order is still defined (pre-order in the
     * hierarchy, or the index for a flat type), so a binary search finds
     * the first object after it either way.
     */
    objectsFor(
        setId: string,
        scope: ScopeRef,
        filter: ObjectFilter,
        offset: number,
        limit: number,
        after: string | null = null
    ): ObjectsResult {
        const { state, t } = this.setState(setId)
        const all = listObjects(
            state.status,
            state.membership,
            t.hierarchy,
            this.scopeRoot(t, scope),
            filter,
            t.ids,
            this.namesLower(t)
        )
        const cursor = after === null ? undefined : t.indexOf.get(after)
        const start =
            cursor === undefined
                ? offset
                : firstAfter(all, cursor, t.hierarchy?.order ?? null)
        const slice = all.subarray(start, start + limit)
        return {
            total: all.length,
            offset,
            hasMore: start + limit < all.length,
            items: Array.from(slice, (index) => ({
                ...this.ref(t, index),
                status: state.status[index] as Status,
                groups: groupsOf(state.membership, index),
            })),
        }
    }
}

/**
 * The position in `list` of the first object that comes after `cursor` in
 * the list's order. `listObjects` returns objects in pre-order when the type
 * has a hierarchy (`order[i]` is object `i`'s pre-order position) and in
 * index order when it has none, so `list` is sorted by that key and a binary
 * search finds the boundary without allocating anything.
 */
function firstAfter(
    list: Int32Array,
    cursor: number,
    order: Int32Array | null
): number {
    const key = order ? order[cursor] : cursor
    let lo = 0
    let hi = list.length
    while (lo < hi) {
        const mid = (lo + hi) >>> 1
        const at = order ? order[list[mid]] : list[mid]
        if (at <= key) {
            lo = mid + 1
        } else {
            hi = mid
        }
    }
    return lo
}
