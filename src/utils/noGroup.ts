import type { GroupSetMeta } from '@/engine/types'

/**
 * How serious it is for an object to be in no group of this set. Every such
 * object is called "No group"; only the colour differs:
 *
 * - `error` (red): the set is compulsory.
 * - `warning` (orange): the set is a data dimension and not compulsory, so
 *   the object's data drops out of analytics broken down by the set.
 * - `neutral` (grey): the set is neither, and being in no group is allowed.
 */
export type NoGroupSeverity = 'error' | 'warning' | 'neutral'

type SetProperties = Pick<GroupSetMeta, 'compulsory' | 'dataDimension'>

export function noGroupSeverity(set: SetProperties): NoGroupSeverity {
    if (set.compulsory) {
        return 'error'
    }
    return set.dataDimension ? 'warning' : 'neutral'
}

/** In no group is only a warning here: a data dimension that is not compulsory. */
export const noGroupIsWarning = (set: SetProperties): boolean =>
    noGroupSeverity(set) === 'warning'
