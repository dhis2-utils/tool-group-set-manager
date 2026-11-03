import type { ObjectType } from './types'

/** One group's membership delta: ids added and ids removed. */
export interface GroupChange {
    groupId: string
    additions: string[]
    deletions: string[]
}

/**
 * A record of one user action against one group set, holding exactly the
 * membership additions and deletions the server confirmed (not what the
 * user asked for -- see docs/developer/dhis2-behavior.md
 * finding 2: a batch write can silently drop an id). A History page lists
 * these and can undo one by reverting it.
 */
export interface ChangeSet {
    id: string
    createdAt: string
    createdBy: { id: string; displayName: string }
    objectType: ObjectType
    groupSetId: string
    groupSetName: string
    action: 'move' | 'assign' | 'revert' | 'properties'
    note: string
    targetGroupId?: string
    changes: GroupChange[]
    revertOf?: string
    /**
     * `'pending'` while the write it records is still running, and for good
     * if that write never finished (a closed tab, a lost connection):
     * `changes` then holds only the groups confirmed before it stopped.
     * Absent on a finished record, which is also how every record written
     * before this field existed reads.
     */
    status?: 'pending'
    /** On a pending record, how many membership changes the write set out to make. */
    planned?: number
    /**
     * Set on a change to the group set itself (action `properties`, and
     * the `revert` of one), which has no membership changes: the
     * properties that changed, before and after. Only changed properties
     * are present.
     */
    properties?: {
        before: Partial<GroupSetProperties>
        after: Partial<GroupSetProperties>
    }
}

/** The group set properties this app can change (SetPropertiesDialog). */
export interface GroupSetProperties {
    compulsory: boolean
    dataDimension: boolean
}

export const GROUP_SET_PROPERTY_KEYS: (keyof GroupSetProperties)[] = [
    'compulsory',
    'dataDimension',
]

/** Whether a record is a change to the group set's properties rather than to memberships. */
export function isPropertiesChange(
    changeSet: Pick<ChangeSet, 'properties'>
): boolean {
    return changeSet.properties !== undefined
}

/** Whether a record's write finished. A record without `status` always did. */
export function isPending(changeSet: Pick<ChangeSet, 'status'>): boolean {
    return changeSet.status === 'pending'
}

/**
 * The changes that would undo a change set: every group's additions and
 * deletions swapped. Pure arithmetic on ids, used both to preview a revert
 * and to build the revert change set once the server confirms it.
 */
export function invert(changeSet: ChangeSet): GroupChange[] {
    return changeSet.changes.map((change) => ({
        groupId: change.groupId,
        additions: change.deletions,
        deletions: change.additions,
    }))
}

/**
 * Whether two change lists describe the same membership delta, regardless
 * of the order groups or ids are listed in. The bulk fix's pre-write check
 * compares the previewed plan with the one recomputed from fresh
 * membership, and a `JSON.stringify` comparison there asked the user to
 * re-confirm a plan that had merely been reordered. Assumes each group
 * appears once per list, which `planAssignment` guarantees.
 */
export function sameChanges(a: GroupChange[], b: GroupChange[]): boolean {
    if (a.length !== b.length) {
        return false
    }
    const byGroup = new Map(b.map((change) => [change.groupId, change]))
    return a.every((change) => {
        const other = byGroup.get(change.groupId)
        return (
            other !== undefined &&
            sameIds(change.additions, other.additions) &&
            sameIds(change.deletions, other.deletions)
        )
    })
}

function sameIds(x: string[], y: string[]): boolean {
    if (x.length !== y.length) {
        return false
    }
    const sortedX = [...x].sort()
    const sortedY = [...y].sort()
    return sortedX.every((id, i) => id === sortedY[i])
}
