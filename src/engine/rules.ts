import { SetMembership } from './membership'
import { EngineConfig, GroupSetMeta, Status } from './types'

/**
 * Spec 3.2 and 3.3. Returns one Status per object.
 * - Conflict (count > 1) is always an error.
 * - Missing (count == 0) is an error when the set is compulsory.
 * - Otherwise, when the set has required levels configured (3.3), those
 *   levels narrow the set: missing is an error at a required level, and
 *   Ok (ignored) at every other level -- even when the set is a data
 *   dimension. Required levels replace the data-dimension warning, they
 *   do not add to it: an admin who configured required levels is saying
 *   "this set only applies at these levels", and a warning at every other
 *   level is exactly the noise they configured required levels to remove.
 * - Without required levels, missing is a warning when the set is a data
 *   dimension, otherwise Ok.
 */
export function evaluateSet(
    set: GroupSetMeta,
    membership: SetMembership,
    population: Uint8Array,
    level: Uint8Array | null,
    config: EngineConfig
): Uint8Array {
    const n = population.length
    const status = new Uint8Array(n)
    const requiredLevels = config.requiredLevels[set.id] ?? []
    const requiredMask = new Uint8Array(64)
    requiredLevels.forEach((l) => {
        if (l >= 0 && l < 64) {
            requiredMask[l] = 1
        }
    })
    const hasRequiredLevels = level !== null && requiredLevels.length > 0

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
        } else if (hasRequiredLevels) {
            status[i] =
                requiredMask[level![i]] === 1 ? Status.MissingError : Status.Ok
        } else if (set.dataDimension) {
            status[i] = Status.MissingWarning
        } else {
            status[i] = Status.Ok
        }
    }
    return status
}
