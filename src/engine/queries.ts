import { ancestorAtLevel, Hierarchy, isInSubtree } from './hierarchy'
import { SetMembership } from './membership'
import { Status } from './types'

export interface SetSummary {
    population: number
    /** in exactly one group of the set */
    ok: number
    /**
     * In no group of the set, and the rules allow that (spec 3.2: the set is
     * neither compulsory nor a data dimension, and the object's level is not
     * a required level). Kept apart from `ok` so every bucket is disjoint and
     * they sum to `population`, and so the dashboard card can say "N in no
     * group, which is allowed here" rather than folding those objects into a
     * green OK number that reads as "in a group".
     */
    unassigned: number
    missingError: number
    missingWarning: number
    conflict: number
}

/**
 * Visits every object index in scope, in depth-first order for hierarchies.
 *
 * When there is a hierarchy and no scope root (scopeRoot < 0, whole-forest
 * scan), this walks every order position 0..n-1. `byOrder` is initialised to
 * -1 and only positions the depth-first walk in buildHierarchy actually
 * reaches get a real object index; corrupted input (e.g. a parent cycle)
 * leaves some tail positions unassigned. Skipping -1 entries keeps the scan
 * from revisiting object 0 (byOrder's zero-value default) for every
 * unassigned position, and from never visiting the unreachable nodes -
 * each object is visited at most once.
 */
function forEachInScope(
    n: number,
    h: Hierarchy | null,
    scopeRoot: number,
    visit: (idx: number) => void
): void {
    if (h === null || scopeRoot < 0) {
        if (h === null) {
            for (let i = 0; i < n; i++) {
                visit(i)
            }
        } else {
            for (let pos = 0; pos < n; pos++) {
                const idx = h.byOrder[pos]
                if (idx >= 0) {
                    visit(idx)
                }
            }
        }
        return
    }
    const start = h.order[scopeRoot]
    const end = h.subtreeEnd[scopeRoot]
    for (let pos = start; pos < end; pos++) {
        visit(h.byOrder[pos])
    }
}

export function summarize(
    status: Uint8Array,
    m: SetMembership,
    h: Hierarchy | null,
    scopeRoot: number
): SetSummary {
    const s: SetSummary = {
        population: 0,
        ok: 0,
        unassigned: 0,
        missingError: 0,
        missingWarning: 0,
        conflict: 0,
    }
    forEachInScope(status.length, h, scopeRoot, (i) => {
        switch (status[i]) {
            case Status.Ok:
                // Status.Ok covers both "in exactly one group" and "in no
                // group, which this set allows"; only the membership tells
                // them apart.
                if (m.groupOf[i] >= 0) {
                    s.ok++
                } else {
                    s.unassigned++
                }
                break
            case Status.MissingError:
                s.missingError++
                break
            case Status.MissingWarning:
                s.missingWarning++
                break
            case Status.Conflict:
                s.conflict++
                break
            default:
                return
        }
        s.population++
    })
    return s
}

export interface MatrixRow {
    /** org unit index of the row, or -1 for objects above the row level */
    object: number
    perGroup: number[]
    /** in no group where the rules require one: an error or a warning */
    missing: number
    /** in no group where that is allowed (spec 3.2), so status Ok */
    unassigned: number
    conflict: number
    total: number
}

function newRow(object: number, groupCount: number): MatrixRow {
    return {
        object,
        perGroup: new Array(groupCount).fill(0),
        missing: 0,
        unassigned: 0,
        conflict: 0,
        total: 0,
    }
}

/**
 * Buckets by *status*, not by membership. Bucketing "in no group" as missing
 * regardless of status contradicted rules.ts, which gives such an object
 * Status.Ok when the set is neither compulsory nor a data dimension (spec
 * 3.2): the card counted no missing objects, the matrix counted them all,
 * and the drill-down filter (which goes by status) listed none of them.
 * Those objects now have their own bucket instead, so every bucket is
 * disjoint and the four still sum to `total`.
 */
function addToRow(row: MatrixRow, status: number, groupOf: number): void {
    if (status === Status.NotApplicable) {
        return
    }
    row.total++
    switch (status) {
        case Status.Conflict:
            row.conflict++
            break
        case Status.MissingError:
        case Status.MissingWarning:
            row.missing++
            break
        default:
            if (groupOf >= 0) {
                row.perGroup[groupOf]++
            } else {
                row.unassigned++
            }
    }
}

export function matrix(
    status: Uint8Array,
    m: SetMembership,
    h: Hierarchy | null,
    scopeRoot: number,
    rowLevel: number,
    groupCount: number
): MatrixRow[] {
    const above = newRow(-1, groupCount)
    if (h === null) {
        for (let i = 0; i < status.length; i++) {
            addToRow(above, status[i], m.groupOf[i])
        }
        return [above]
    }
    const rows = new Map<number, MatrixRow>()
    forEachInScope(status.length, h, scopeRoot, (i) => {
        const rowObject = ancestorAtLevel(h, i, rowLevel)
        if (rowObject < 0) {
            addToRow(above, status[i], m.groupOf[i])
            return
        }
        let row = rows.get(rowObject)
        if (!row) {
            row = newRow(rowObject, groupCount)
            rows.set(rowObject, row)
        }
        addToRow(row, status[i], m.groupOf[i])
    })
    // Map preserves insertion order, which is depth-first order.
    const result = Array.from(rows.values())
    if (above.total > 0) {
        result.push(above)
    }
    return result
}

export interface ObjectFilter {
    statuses?: Status[]
    level?: number
    /** -1 = no group, -2 = conflict, >= 0 = that group position */
    group?: number
    ancestor?: number
    /**
     * Restricts the population to exactly these object ids, when given.
     * Requires the caller (`listObjects`) to also be given the type's own
     * id array -- `queries.ts` otherwise works entirely in index space
     * (see `group`/`ancestor` above, both positions rather than ids) and
     * has no id table of its own. `objectsFor`/`planAssignment` in
     * `store.ts` are the only two callers, and both already hold that
     * array (`TypeIndex.ids`), so passing it costs them nothing.
     *
     * Exists so one population definition -- this filter -- can serve a
     * plan, its sample, and its CSV export identically. Before this, a
     * caller with a `selection` (ids, not a scope+filter) had no way to
     * ask `objectsFor` for that same population, so the sample and CSV
     * fell back to guessing or going empty (see BulkFixDialog).
     */
    ids?: string[]
    /**
     * Restricts the population to objects whose name contains this text,
     * case-insensitively, after both sides are trimmed. An empty or
     * whitespace-only value is the same as no filter.
     *
     * Composes with every other predicate the same way `ids` does (see
     * above) rather than replacing any of them: a caller narrowing by
     * status or ancestor and adding a search term expects both to apply,
     * not the search term alone.
     *
     * Matched against `namesLower`, the same parameter shape as `ids` --
     * `queries.ts` has no name table of its own and never builds one; the
     * store owns the one lowercase array per type (built on first use,
     * dropped whenever the names change) and passes it in. A type with no
     * names loaded (`namesLower` null or undefined) matches nothing here,
     * not everything -- the same "forgot to pass the array" failure mode
     * `ids` guards against, and the worse of the two possible failures:
     * silently returning the whole population would read to the user as
     * "my search matched everything" rather than "names are not loaded".
     */
    text?: string
}

export function listObjects(
    status: Uint8Array,
    m: SetMembership,
    h: Hierarchy | null,
    scopeRoot: number,
    filter: ObjectFilter,
    ids?: string[],
    namesLower?: string[] | null
): Int32Array {
    const statusMask = new Uint8Array(8)
    if (filter.statuses) {
        filter.statuses.forEach((s) => (statusMask[s] = 1))
    } else {
        statusMask.fill(1)
        statusMask[Status.NotApplicable] = 0
    }
    const idFilter = filter.ids ? new Set(filter.ids) : null
    const textQuery = filter.text?.trim().toLowerCase() || null
    const out: number[] = []
    forEachInScope(status.length, h, scopeRoot, (i) => {
        if (statusMask[status[i]] === 0) {
            return
        }
        if (
            filter.level !== undefined &&
            (h === null || h.level[i] !== filter.level)
        ) {
            return
        }
        if (filter.group !== undefined && m.groupOf[i] !== filter.group) {
            return
        }
        if (
            filter.ancestor !== undefined &&
            (h === null || !isInSubtree(h, filter.ancestor, i))
        ) {
            return
        }
        // No `ids` array to check against means nothing can match: a
        // caller that asks for `filter.ids` and forgets to pass the id
        // array gets an empty result rather than silently ignoring the
        // predicate and returning everything.
        if (idFilter && !(ids && idFilter.has(ids[i]))) {
            return
        }
        // No `namesLower` array to check against means nothing can match,
        // same reasoning as the `ids` predicate just above.
        if (textQuery && !(namesLower && namesLower[i]?.includes(textQuery))) {
            return
        }
        out.push(i)
    })
    return Int32Array.from(out)
}
