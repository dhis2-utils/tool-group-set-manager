import { useConfig } from '@dhis2/app-runtime'
import { useCallback, useState } from 'react'
import { useEngine } from './useEngine'
import { useIntegrity } from './useIntegrity'
import { deleteChangeSet, saveChangeSet } from '@/data/datastore'
import { createFetcher } from '@/data/fetcher'
import type { Fetcher } from '@/data/sources/DataSource'
import type { WriteResult } from '@/data/writes'
import { writeMemberships } from '@/data/writes'
import type { ChangeSet, GroupChange } from '@/engine/changeSet'
import type { GroupSetMeta } from '@/engine/types'
import { useApiDataQuery } from '@/utils/useApiDataQuery'

interface Identity {
    id: string
    displayName: string
}

// Used when the identity query has not settled yet -- a write must never
// wait on a cosmetic field. The change set is still recorded, just with a
// blank author, rather than blocking an already-confirmed server change.
const UNKNOWN_IDENTITY: Identity = { id: '', displayName: '' }

export interface MembershipWriteInput {
    set: GroupSetMeta
    changes: GroupChange[]
    action: ChangeSet['action']
    note: string
    targetGroupId?: string
    revertOf?: string
    /**
     * D1: threaded straight through to `writeMemberships`'s own
     * `onProgress(done, total)` callback, which already exists but was
     * previously discarded (the hook passed `() => undefined`). Optional so
     * every existing caller keeps working unchanged.
     */
    onProgress?: (done: number, total: number) => void
    /**
     * The current complete membership of each group in `changes`, by group
     * id, read fresh immediately before this call. Supplying it is what
     * makes `writeMemberships`'s patch route available for a large
     * per-group change -- and withholding it is what makes that route
     * unreachable for a caller that has not re-read (spec 2026-09-16
     * section 6.3). Optional, so every existing caller keeps working and
     * keeps the batched path.
     */
    completeMembers?: Map<string, string[]>
}

export interface MembershipWriteResult extends WriteResult {
    changeSet: ChangeSet
    /**
     * Set when the engine could not be told about the confirmed change --
     * either the call to `applyChangeSet` itself rejected (the worker
     * crashed, or was terminated mid-call by a provider remount), or there
     * was no engine client at all yet. Either way the server change already
     * happened and is never undone or retried for this: the cache is still
     * invalidated and the change set is still recorded (see the doc
     * comment on `write` for why), so a forced reload recovers the screen.
     * This field exists so a caller can tell "the change landed but the
     * screen may be stale" from "the change landed and the screen reflects
     * it" -- text is a diagnostic, not user-facing; translate before
     * display, same as `historyError`.
     */
    engineError?: string
    /**
     * Set when the change set could not be saved to the dataStore. The
     * server write and the engine update it describes both already
     * happened and are never undone for this -- a stale cache is worse
     * than a missing history row, and the server change is already real.
     * Diagnostic text only; translate before display.
     */
    historyError?: string
}

/**
 * `engineError` when there was no engine client to tell at all. A
 * locale-neutral token like `UNPARSEABLE_RESPONSE` in writes.ts, not prose:
 * `engineError` is diagnostic, and every caller shows its own translated
 * sentence for it.
 */
export const NO_ENGINE_CLIENT = 'no-engine-client'

/**
 * DHIS2 uid rules don't apply here: a change set's `id` is only ever used
 * as a dataStore key (`history-<id>`), never sent as a metadata object id,
 * so it only needs to be unique and URL-safe.
 */
function generateChangeSetId(): string {
    return `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`
}

function plannedCount(changes: GroupChange[]): number {
    return changes.reduce(
        (sum, c) => sum + c.additions.length + c.deletions.length,
        0
    )
}

function errorText(e: unknown): string {
    return e instanceof Error ? e.message : String(e)
}

interface HistoryRecorder {
    /** Saves what is confirmed so far into the pending record; never throws. */
    update?: (appliedSoFar: GroupChange[]) => Promise<void>
    /**
     * Replaces the pending record with the finished one, or removes it when
     * nothing was confirmed. Returns the save error, if any; never throws.
     */
    finish: (changeSet: ChangeSet) => Promise<string | undefined>
}

/**
 * Saves a pending History record before anything is written, so a write
 * interrupted partway -- a closed tab, a dropped connection, an expired
 * session -- still leaves a row for the groups it finished. The record is
 * updated after each group and replaced by the finished change set at the
 * end, which carries no `status` and so reads exactly like one written by
 * an earlier version.
 *
 * When the pending save itself fails (no write access to the dataStore,
 * say), the write still goes ahead -- the server change matters more than
 * its History row, as it always has -- and only the final save is tried.
 */
async function startHistory(
    fetcher: Fetcher,
    record: ChangeSet,
    planned: number
): Promise<HistoryRecorder> {
    const pending = (changes: GroupChange[]): ChangeSet => ({
        ...record,
        status: 'pending',
        planned,
        changes,
    })
    let pendingSaved = false
    try {
        await saveChangeSet(fetcher, pending([]))
        pendingSaved = true
    } catch {
        // See the doc comment: the write does not wait on its History row.
    }
    return {
        update: pendingSaved
            ? async (appliedSoFar) => {
                  try {
                      await saveChangeSet(fetcher, pending(appliedSoFar))
                  } catch {
                      // The next update, or the final save, tries again.
                  }
              }
            : undefined,
        finish: async (changeSet) => {
            if (changeSet.changes.length === 0) {
                // A History row describing no change is worse than no row:
                // every row offers Revert, and reverting nothing is a
                // control that cannot do anything.
                if (pendingSaved) {
                    try {
                        await deleteChangeSet(fetcher, changeSet.id)
                    } catch {
                        // Left behind as a pending row with nothing
                        // confirmed, which History shows as such.
                    }
                }
                return undefined
            }
            try {
                await saveChangeSet(fetcher, changeSet)
                return undefined
            } catch (e) {
                return errorText(e)
            }
        },
    }
}

/**
 * The single place a membership change happens. Every screen that moves,
 * assigns or reverts an object between groups calls `write()`, which does
 * these things in this order -- pending history, server, engine, cache,
 * history:
 *
 * 0. Save a pending History record (`startHistory`), updated after each
 *    group, so a write that never reaches step 4 still leaves the groups it
 *    finished in History, revertible.
 * 1. Write to the server (`writeMemberships`), batched and reconciled
 *    against what the server actually confirmed.
 * 2. Apply exactly what was confirmed (`result.applied`, never the input)
 *    to the engine, so the screen reflects it without a reload.
 * 3. Invalidate the cache for the affected type -- on 2.43 a membership
 *    write does not bump a group's `lastUpdated`
 *    (2.40 does bump it; see docs/developer/dhis2-behavior.md),
 *    so the next load cannot be trusted to notice on its own regardless of
 *    which server this is running against.
 * 4. Replace the pending record with the finished change set -- or delete
 *    it when `result.applied` is empty (nothing was confirmed): a History
 *    row describing no change is worse than no row, since History offers a
 *    revert on every row and reverting nothing is a control that cannot do
 *    anything.
 *
 * Steps 2, 3 and 4 are independent of each other once the server write has
 * happened: a rejection from the engine call (the worker crashed, or was
 * terminated mid-call by a provider remount -- see `EngineClient.failAll`)
 * or the absence of an engine client must not skip the cache invalidation
 * or the history save, and a failure to save the change set must not undo
 * the engine update or skip the cache invalidation either. The server
 * change is already real in every one of these cases; only the two
 * failures are surfaced, as `engineError` and `historyError` on the
 * result, rather than thrown.
 */
export function useMembershipWrite(): {
    write: (input: MembershipWriteInput) => Promise<MembershipWriteResult>
    isWriting: boolean
} {
    const { baseUrl, apiVersion } = useConfig() as {
        baseUrl: string
        apiVersion: number
    }
    const { client, invalidateType } = useEngine()
    const { markStale } = useIntegrity()
    // A counter, not a boolean: two overlapping writes must not have the
    // first one finishing clear a spinner the second write still needs.
    // Nothing today calls write() more than once concurrently, but nothing
    // stops a caller from doing so either, so this is closing that hole
    // rather than fixing a live fault.
    const [writeCount, setWriteCount] = useState(0)

    // D3: this hook's own query, distinct from useUserScope's ['me','scope']
    // query, which serves a different purpose (the org unit tree roots).
    const { data: identity } = useApiDataQuery<Identity>({
        queryKey: ['me', 'identity'],
        query: { resource: 'me', params: { fields: 'id,displayName' } },
        staleTime: Infinity,
    })

    const write = useCallback(
        async (input: MembershipWriteInput): Promise<MembershipWriteResult> => {
            setWriteCount((n) => n + 1)
            try {
                const fetcher = createFetcher(baseUrl, apiVersion)
                const objectType = input.set.objectType

                // `changes` is the batch list verbatim and therefore
                // unbounded: a hundred-thousand-membership national fix
                // produces one dataStore document holding a hundred
                // thousand ids. That is a property of this contract
                // (writeMemberships batches, this hook stores whatever it
                // confirmed), not a bug to fix here.
                const record: ChangeSet = {
                    id: generateChangeSetId(),
                    createdAt: new Date().toISOString(),
                    createdBy: identity ?? UNKNOWN_IDENTITY,
                    objectType,
                    groupSetId: input.set.id,
                    groupSetName: input.set.displayName,
                    action: input.action,
                    note: input.note,
                    targetGroupId: input.targetGroupId,
                    changes: [],
                    revertOf: input.revertOf,
                }
                const history = await startHistory(
                    fetcher,
                    record,
                    plannedCount(input.changes)
                )

                const result = await writeMemberships(
                    fetcher,
                    objectType,
                    input.changes,
                    input.onProgress ?? (() => undefined),
                    {
                        completeMembers: input.completeMembers,
                        onChangeSettled: history.update,
                        holdUnplacedDeletions: true,
                    }
                )

                let engineError: string | undefined
                if (client) {
                    try {
                        await client.call(
                            'applyChangeSet',
                            objectType,
                            result.applied
                        )
                    } catch (e) {
                        engineError = e instanceof Error ? e.message : String(e)
                    }
                } else {
                    engineError = NO_ENGINE_CLIENT
                }

                // Neither of these may fail an already-confirmed write or
                // skip the History save below: a cache that could not be
                // cleared (IndexedDB unavailable) costs at worst a stale
                // next load, and stale check results are a same-session UI
                // hint, while a confirmed change missing from History
                // cannot be reverted at all.
                try {
                    await invalidateType(objectType)
                } catch {
                    // deliberately ignored -- see comment above
                }
                try {
                    markStale(objectType)
                } catch {
                    // deliberately ignored -- see comment above
                }

                const changeSet: ChangeSet = {
                    ...record,
                    changes: result.applied,
                }
                const historyError = await history.finish(changeSet)

                return { ...result, changeSet, historyError, engineError }
            } finally {
                setWriteCount((n) => n - 1)
            }
        },
        // oxlint-disable-next-line react/memo-dependencies -- every listed dependency is read in the callback, as react-hooks/exhaustive-deps confirms
        [baseUrl, apiVersion, client, invalidateType, markStale, identity]
    )

    return { write, isWriting: writeCount > 0 }
}
