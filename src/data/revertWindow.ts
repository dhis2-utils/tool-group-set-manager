import type { ChangeSet } from '@/engine/changeSet'

/**
 * How long after it was written a change set can still be reverted from
 * History. A revert is planned against today's membership but replays a
 * change made back then; the older the change, the more of what happened
 * since it undoes without anyone seeing it. Older change sets stay listed
 * and exportable, and their documents stay in the dataStore.
 */
export const REVERT_WINDOW_MS = 24 * 60 * 60 * 1000

/** False for a change set older than the window, and for one whose date cannot be read. */
export function canStillRevert(
    changeSet: Pick<ChangeSet, 'createdAt'>,
    now: number
): boolean {
    const createdAt = Date.parse(changeSet.createdAt)
    if (!Number.isFinite(createdAt)) {
        return false
    }
    return now - createdAt < REVERT_WINDOW_MS
}
