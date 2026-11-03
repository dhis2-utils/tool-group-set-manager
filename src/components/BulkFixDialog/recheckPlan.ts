import { assignmentExpectations, findMembershipDrift } from '@/data/freshness'
import { readGroupMembers } from '@/data/groupMembers'
import type { Fetcher } from '@/data/sources/DataSource'
import { takesPatchRoute } from '@/data/writes'
import type { EngineClient } from '@/engine/client'
import type { ObjectFilter } from '@/engine/queries'
import type { AssignmentPlan, ScopeRef } from '@/engine/store'
import type { GroupSetMeta } from '@/engine/types'

export interface RecheckInput {
    fetcher: Fetcher
    client: Pick<EngineClient, 'call'>
    set: GroupSetMeta
    scope: ScopeRef
    populationFilter: ObjectFilter
    targetGroupId: string
    referencePlan: AssignmentPlan
    signal?: AbortSignal
}

export interface RecheckResult {
    /** The plan to write: `referencePlan` itself when nothing changed. */
    recomputed: AssignmentPlan
    /** Complete, just-read membership of every group taking the patch route. */
    completeMembers: Map<string, string[]>
}

/**
 * The pre-write check every bulk fix runs, whatever its size (finding M1;
 * spec 2026-09-16 section 5 for the patch-route half).
 *
 * The plan was computed from the membership the page loaded, which may be
 * hours old, and the engine never refreshes on its own. So before anything
 * is written:
 *
 * - every group the plan touches is re-read for exactly the objects the
 *   plan touches (`findMembershipDrift`, by id and chunked, so it stays
 *   cheap for a small fix), and whatever another admin changed for those
 *   objects is applied to the engine;
 * - every group large enough to take the JSON Patch route is re-read in
 *   full instead, because a replace overwrites the whole collection and
 *   must be built from a list that was just read.
 *
 * When either found anything, the plan is recomputed from the engine's
 * corrected picture and returned for the caller to compare with the one
 * the user saw. When neither did, the reference plan is returned as-is,
 * with no engine round trip at all.
 */
export async function recheckPlan({
    fetcher,
    client,
    set,
    scope,
    populationFilter,
    targetGroupId,
    referencePlan,
    signal,
}: RecheckInput): Promise<RecheckResult> {
    const patchGroupIds = referencePlan.changes
        .filter((c) => takesPatchRoute(c))
        .map((c) => c.groupId)
    const expectations = assignmentExpectations(
        referencePlan.changes,
        targetGroupId
    )
    // A group read in full is brought up to date wholesale below; asking it
    // about individual ids as well would only repeat the read.
    for (const groupId of patchGroupIds) {
        expectations.delete(groupId)
    }
    const [completeMembers, drift] = await Promise.all([
        readGroupMembers(fetcher, set.objectType, patchGroupIds, signal),
        findMembershipDrift(fetcher, set.objectType, { expectations, signal }),
    ])
    if (completeMembers.size === 0 && drift.length === 0) {
        return { recomputed: referencePlan, completeMembers }
    }
    if (completeMembers.size > 0) {
        await client.call(
            'setGroupMembers',
            set.objectType,
            Array.from(completeMembers, ([groupId, memberIds]) => ({
                groupId,
                memberIds,
            }))
        )
    }
    if (drift.length > 0) {
        await client.call('applyChangeSet', set.objectType, drift)
    }
    const recomputed = await client.call<AssignmentPlan>(
        'planAssignment',
        set.id,
        scope,
        populationFilter,
        targetGroupId
    )
    return { recomputed, completeMembers }
}
