import { useConfig } from '@dhis2/app-runtime'
import { useCallback, useState } from 'react'
import { useEngine } from './useEngine'
import { saveChangeSet } from '@/data/datastore'
import { createFetcher } from '@/data/fetcher'
import { WriteResult, writeMemberships } from '@/data/writes'
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
}

export interface MembershipWriteResult extends WriteResult {
    changeSet: ChangeSet
    /**
     * Set when the change set could not be saved to the dataStore. The
     * server write and the engine update it describes both already
     * happened and are never undone for this -- a stale cache is worse
     * than a missing history row, and the server change is already real.
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
 * four things in this order:
 *
 * 1. Write to the server (`writeMemberships`), batched and reconciled
 *    against what the server actually confirmed.
 * 2. Apply exactly what was confirmed (`result.applied`, never the input)
 *    to the engine, so the screen reflects it without a reload.
 * 3. Invalidate the cache for the affected type -- a membership write does
 *    not bump a group's `lastUpdated`
 *    (docs/superpowers/notes/2026-09-plan2-write-api-findings.md section 3),
 *    so the next load would not notice on its own.
 * 4. Record a change set in the dataStore for the History page.
 *
 * Steps 3 and 4 are independent of each other: a failure to save the
 * change set must not skip the cache invalidation and must not undo the
 * engine update, since the server change already happened. That failure is
 * surfaced on the returned result as `historyError` instead.
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
    const [isWriting, setIsWriting] = useState(false)

    // D3: this hook's own query, distinct from useUserScope's ['me','scope']
    // query, which serves a different purpose (the org unit tree roots).
    const { data: identity } = useApiDataQuery<Identity>({
        queryKey: ['me', 'identity'],
        query: { resource: 'me', params: { fields: 'id,displayName' } },
        staleTime: Infinity,
    })

    const write = useCallback(
        async (input: MembershipWriteInput): Promise<MembershipWriteResult> => {
            setIsWriting(true)
            try {
                const fetcher = createFetcher(baseUrl, apiVersion)
                const objectType = input.set.objectType

                const result = await writeMemberships(
                    fetcher,
                    objectType,
                    input.changes,
                    () => undefined
                )

                if (client) {
                    await client.call(
                        'applyChangeSet',
                        objectType,
                        result.applied
                    )
                }

                await invalidateType(objectType)

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
                try {
                    await saveChangeSet(fetcher, changeSet)
                } catch (e) {
                    historyError = e instanceof Error ? e.message : String(e)
                }

                return { ...result, changeSet, historyError }
            } finally {
                setIsWriting(false)
            }
        },
        [baseUrl, apiVersion, client, invalidateType, identity]
    )

    return { write, isWriting }
}
