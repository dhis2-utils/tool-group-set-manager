import { MatrixResult } from '@/engine/store'
import { GroupMeta } from '@/engine/types'

export interface GroupTotal {
    index: number
    group: GroupMeta
    total: number
}

export interface ColumnPlan {
    shown: GroupTotal[]
    other: GroupTotal[]
    ranked: GroupTotal[]
}

/** Spec 2026-09-15 §4.2. A data element group set can have hundreds of
 * groups, and one column each is not a table. */
export const MAX_GROUP_COLUMNS = 8

/**
 * Ranks a set's groups by how many objects they hold across every row of
 * the matrix, and splits them into the columns to show and the rest.
 *
 * The totals come from `result` itself -- the same numbers already on
 * screen -- so the ranking costs no query and the groups panel (which
 * shares this plan) can never disagree with the matrix.
 *
 * `pinned` is the user's explicit choice from the picker: those groups
 * become `shown`, still ranked among themselves, and everything else is
 * `other`. An unknown index in `pinned` is ignored rather than throwing --
 * it can only come from a stale choice, and dropping a column is a better
 * failure than a blank screen.
 */
export function planColumns(
    result: MatrixResult,
    pinned?: number[]
): ColumnPlan {
    const ranked: GroupTotal[] = result.groups
        .map((group, index) => ({
            index,
            group,
            total: result.rows.reduce((sum, r) => sum + r.perGroup[index], 0),
        }))
        // Descending by total, then by index: a tie must not depend on how
        // Array.prototype.sort happens to order equal keys, or the columns
        // would reshuffle between renders of the same data.
        .sort((a, b) => b.total - a.total || a.index - b.index)

    if (pinned) {
        const keep = new Set(pinned)
        return {
            shown: ranked.filter((g) => keep.has(g.index)),
            other: ranked.filter((g) => !keep.has(g.index)),
            ranked,
        }
    }
    return {
        shown: ranked.slice(0, MAX_GROUP_COLUMNS),
        other: ranked.slice(MAX_GROUP_COLUMNS),
        ranked,
    }
}
