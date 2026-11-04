import { readMembershipAmong } from './groupMembers'
import type { Fetcher } from './sources/DataSource'
import type { GroupChange } from '@/engine/changeSet'
import type { ObjectType } from '@/engine/types'

/**
 * What a plan assumed about one group: which ids it took to be members and
 * which it took not to be. A plan is computed from the membership the page
 * loaded, which can be hours old; these are the facts that must still hold
 * on the server for the plan to mean what the user was shown.
 */
export interface GroupExpectation {
    members: string[]
    nonMembers: string[]
}

export type Expectations = Map<string, GroupExpectation>

function expectationFor(
    expectations: Expectations,
    groupId: string
): GroupExpectation {
    let entry = expectations.get(groupId)
    if (!entry) {
        entry = { members: [], nonMembers: [] }
        expectations.set(groupId, entry)
    }
    return entry
}

/**
 * The assumptions behind a revert, or any plan that only claims what its
 * own changes say: an id it deletes from a group is in that group now, and
 * an id it adds is not.
 */
export function changeExpectations(changes: GroupChange[]): Expectations {
    const expectations: Expectations = new Map()
    for (const change of changes) {
        const entry = expectationFor(expectations, change.groupId)
        entry.members.push(...change.deletions)
        entry.nonMembers.push(...change.additions)
    }
    return expectations
}

/**
 * The assumptions behind an assignment plan (`planAssignment`), which are
 * wider than its changes: the plan puts every object it touches in the
 * target group and takes it out of every other group of the set. So for
 * every touched group and every touched object, the plan also assumed
 * where the object is *not* changed -- it is already in the target (it was
 * only deleted elsewhere), and it is in no other touched group it is not
 * deleted from. Checking those too is what catches another admin having
 * put the object into one of those groups since the page loaded: the plan
 * would otherwise leave it there, in conflict.
 */
export function assignmentExpectations(
    changes: GroupChange[],
    targetGroupId: string
): Expectations {
    const objectIds = [
        ...new Set(changes.flatMap((c) => [...c.additions, ...c.deletions])),
    ]
    const byGroup = new Map(changes.map((c) => [c.groupId, c]))
    const groupIds = new Set([...byGroup.keys(), targetGroupId])
    const expectations: Expectations = new Map()
    for (const groupId of groupIds) {
        const change = byGroup.get(groupId)
        const deleted = new Set(change?.deletions)
        const added = new Set(change?.additions)
        const entry = expectationFor(expectations, groupId)
        for (const id of objectIds) {
            const isMember =
                deleted.has(id) || (groupId === targetGroupId && !added.has(id))
            ;(isMember ? entry.members : entry.nonMembers).push(id)
        }
    }
    return expectations
}

/**
 * Re-reads, for each group, exactly the ids the plan made an assumption
 * about (by id, chunked -- see `readMembersAmong`), and returns what no
 * longer holds as corrections in change form: per group, the ids now
 * present that were assumed absent (`additions`) and the ids now absent
 * that were assumed present (`deletions`). Applying them to the engine
 * (`applyChangeSet`) brings its picture of these objects up to date, and a
 * plan recomputed afterwards reflects what someone else did meanwhile. An
 * empty list means every assumption still holds.
 */
export async function findMembershipDrift(
    fetcher: Fetcher,
    objectType: ObjectType,
    {
        expectations,
        signal,
    }: { expectations: Expectations; signal?: AbortSignal }
): Promise<GroupChange[]> {
    const idsByGroup = new Map(
        Array.from(expectations, ([groupId, { members, nonMembers }]) => [
            groupId,
            [...members, ...nonMembers],
        ])
    )
    const present = await readMembershipAmong(
        fetcher,
        objectType,
        idsByGroup,
        signal
    )
    const drift: GroupChange[] = []
    for (const [groupId, { members, nonMembers }] of expectations) {
        const found = present.get(groupId) ?? new Set<string>()
        const additions = nonMembers.filter((id) => found.has(id))
        const deletions = members.filter((id) => !found.has(id))
        if (additions.length > 0 || deletions.length > 0) {
            drift.push({ groupId, additions, deletions })
        }
    }
    return drift
}
