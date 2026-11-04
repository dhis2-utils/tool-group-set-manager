import type { SetMembership } from './membership'
import type { GroupSetMeta } from './types'
import { Status } from './types'

/**
 * Spec 2026-09-15 §2.1. Returns one Status per object.
 * - Conflict (count > 1) is always an error.
 * - Exactly one group is Ok.
 * - Missing (count === 0) is an error when the set is compulsory, a
 *   warning when it is a data dimension and not compulsory, and Ok
 *   otherwise -- the "in no group, and that is allowed here" bucket.
 *
 * The rule deliberately does not vary by organisation unit level. The
 * per-set "required levels" policy that used to narrow it was removed in
 * Plan 4: level-based compulsoriness and group set completeness are
 * separate concerns, the data entry API is permissive enough that data
 * arrives below any level a policy names, and DHIS2's own integrity checks
 * flag a partial set regardless of what this app was told. The remedy for
 * objects a set does not really describe is a per-set catch-all group, not
 * a narrower rule.
 */
export function evaluateSet(
    set: GroupSetMeta,
    membership: SetMembership,
    population: Uint8Array
): Uint8Array {
    const n = population.length
    const status = new Uint8Array(n)

    for (let i = 0; i < n; i++) {
        if (population[i] === 0) {
            status[i] = Status.NotApplicable
            continue
        }
        const count = membership.memberCount[i]
        if (count > 1) {
            status[i] = Status.Conflict
        } else if (count === 1) {
            status[i] = Status.Ok
        } else if (set.compulsory) {
            status[i] = Status.MissingError
        } else if (set.dataDimension) {
            status[i] = Status.MissingWarning
        } else {
            status[i] = Status.Ok
        }
    }
    return status
}
