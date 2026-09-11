import { ObjectType } from './types'

/** One group's membership delta: ids added and ids removed. */
export interface GroupChange {
    groupId: string
    additions: string[]
    deletions: string[]
}

/**
 * A record of one user action against one group set, holding exactly the
 * membership additions and deletions the server confirmed (not what the
 * user asked for -- see docs/superpowers/notes/2026-09-plan2-write-api-findings.md
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
    action: 'move' | 'assign' | 'revert'
    note: string
    targetGroupId?: string
    changes: GroupChange[]
    revertOf?: string
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
