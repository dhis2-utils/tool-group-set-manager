import { ancestorAtLevel, Hierarchy, isInSubtree } from './hierarchy'
import { SetMembership } from './membership'
import { Status } from './types'

export interface SetSummary {
    population: number
    ok: number
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
    h: Hierarchy | null,
    scopeRoot: number
): SetSummary {
    const s: SetSummary = { population: 0, ok: 0, missingError: 0, missingWarning: 0, conflict: 0 }
    forEachInScope(status.length, h, scopeRoot, (i) => {
        switch (status[i]) {
            case Status.Ok:
                s.ok++
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
    missing: number
    conflict: number
    total: number
}

function newRow(object: number, groupCount: number): MatrixRow {
    return { object, perGroup: new Array(groupCount).fill(0), missing: 0, conflict: 0, total: 0 }
}

function addToRow(row: MatrixRow, status: number, groupOf: number): void {
    if (status === Status.NotApplicable) {
        return
    }
    row.total++
    if (status === Status.Conflict) {
        row.conflict++
    } else if (groupOf >= 0) {
        row.perGroup[groupOf]++
    } else {
        row.missing++
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
}

export function listObjects(
    status: Uint8Array,
    m: SetMembership,
    h: Hierarchy | null,
    scopeRoot: number,
    filter: ObjectFilter
): Int32Array {
    const statusMask = new Uint8Array(8)
    if (filter.statuses) {
        filter.statuses.forEach((s) => (statusMask[s] = 1))
    } else {
        statusMask.fill(1)
        statusMask[Status.NotApplicable] = 0
    }
    const out: number[] = []
    forEachInScope(status.length, h, scopeRoot, (i) => {
        if (statusMask[status[i]] === 0) {
            return
        }
        if (filter.level !== undefined && (h === null || h.level[i] !== filter.level)) {
            return
        }
        if (filter.group !== undefined && m.groupOf[i] !== filter.group) {
            return
        }
        if (filter.ancestor !== undefined && (h === null || !isInSubtree(h, filter.ancestor, i))) {
            return
        }
        out.push(i)
    })
    return Int32Array.from(out)
}
