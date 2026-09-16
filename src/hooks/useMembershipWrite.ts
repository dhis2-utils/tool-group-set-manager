import { useConfig } from '@dhis2/app-runtime'
import { useCallback, useState } from 'react'
import { useEngine } from './useEngine'
import { useIntegrity } from './useIntegrity'
import { saveChangeSet } from '@/data/datastore'
import { createFetcher } from '@/data/fetcher'
import {
    DEFAULT_BATCH_SIZE,
    WriteResult,
    writeMemberships,
} from '@/data/writes'
import { ChangeSet, GroupChange } from '@/engine/changeSet'
import { GroupSetMeta } from '@/engine/types'
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
 * DHIS2 uid rules don't apply here: a change set's `id` is only ever used
 * as a dataStore key (`history-<id>`), never sent as a metadata object id,
 * so it only needs to be unique and URL-safe.
 */
function generateChangeSetId(): string {
    return `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`
}

/**
 * The single place a membership change happens. Every screen that moves,
 * assigns or reverts an object between groups calls `write()`, which does
 * four things in this order -- server, engine, cache, history:
 *
 * 1. Write to the server (`writeMemberships`), batched and reconciled
 *    against what the server actually confirmed.
 * 2. Apply exactly what was confirmed (`result.applied`, never the input)
 *    to the engine, so the screen reflects it without a reload.
 * 3. Invalidate the cache for the affected type -- on 2.43 a membership
 *    write does not bump a group's `lastUpdated`
 *    (docs/superpowers/notes/2026-09-plan2-write-api-findings.md section 3;
 *    2.40 does bump it, see
 *    docs/superpowers/notes/2026-09-plan2-write-compatibility.md section 4),
 *    so the next load cannot be trusted to notice on its own regardless of
 *    which server this is running against.
 * 4. Record a change set in the dataStore for the History page -- skipped
 *    entirely when `result.applied` is empty (nothing was confirmed): a
 *    History row describing no change is worse than no row, since Task 9
 *    offers a revert on every row and reverting nothing is a control that
 *    cannot do anything.
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

                const result = await writeMemberships(
                    fetcher,
                    objectType,
                    input.changes,
                    input.onProgress ?? (() => undefined),
                    DEFAULT_BATCH_SIZE,
                    input.completeMembers
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
                    engineError =
                        'No engine client is available; reload to see this change reflected.'
                }

                await invalidateType(objectType)

                // Like invalidateType, a failure to mark the affected
                // checks stale must never fail an already-confirmed write --
                // it is a same-session UI hint, not part of the write's
                // contract with the server.
                try {
                    markStale(objectType)
                } catch {
                    // deliberately ignored -- see comment above
                }

                // `changes: result.applied` is the batch list verbatim and
                // therefore unbounded: a hundred-thousand-membership
                // national fix produces one dataStore document holding a
                // hundred thousand ids. That is a property of this
                // contract (writeMemberships batches, this hook stores
                // whatever it confirmed), not a bug to fix here -- noted
                // so a page rendering History (Task 9) doesn't discover it
                // against a large real instance.
                const changeSet: ChangeSet = {
                    id: generateChangeSetId(),
                    createdAt: new Date().toISOString(),
                    createdBy: identity ?? UNKNOWN_IDENTITY,
                    objectType,
                    groupSetId: input.set.id,
                    groupSetName: input.set.displayName,
                    action: input.action,
                    note: input.note,
                    targetGroupId: input.targetGroupId,
                    changes: result.applied,
                    revertOf: input.revertOf,
                }

                let historyError: string | undefined
                if (result.applied.length > 0) {
                    try {
                        await saveChangeSet(fetcher, changeSet)
                    } catch (e) {
                        historyError =
                            e instanceof Error ? e.message : String(e)
                    }
                }

                return { ...result, changeSet, historyError, engineError }
            } finally {
                setWriteCount((n) => n - 1)
            }
        },
        [baseUrl, apiVersion, client, invalidateType, markStale, identity]
    )

    return { write, isWriting: writeCount > 0 }
}
