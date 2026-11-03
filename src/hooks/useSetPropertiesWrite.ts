import { useConfig } from '@dhis2/app-runtime'
import { useCallback, useState } from 'react'
import { generateChangeSetId, useChangeSetAuthor } from './useChangeSetAuthor'
import { saveChangeSet } from '@/data/datastore'
import { createFetcher } from '@/data/fetcher'
import { setGroupSetProperties } from '@/data/metadataWrites'
import type { ChangeSet, GroupSetProperties } from '@/engine/changeSet'
import type { GroupSetMeta } from '@/engine/types'

export interface SetPropertiesWriteInput {
    set: Pick<GroupSetMeta, 'id' | 'objectType' | 'displayName'>
    /** The changed properties' values before this write. */
    before: Partial<GroupSetProperties>
    /** The values to write; only these properties are patched. */
    after: Partial<GroupSetProperties>
    action: 'properties' | 'revert'
    note?: string
    revertOf?: string
}

export interface SetPropertiesWriteResult {
    changeSet: ChangeSet
    /** Set when the server change happened but History could not record it. Diagnostic only. */
    historyError?: string
}

/**
 * Changes a group set's properties and records the change in History
 * (finding M11), so it can be reverted from there like a membership change.
 * The server write comes first and its failure is thrown (a
 * `MetadataWriteError` the caller turns into a sentence); a History save
 * that fails after it is returned as `historyError`, never thrown, since
 * the server change is already real.
 */
export function useSetPropertiesWrite(): {
    write: (input: SetPropertiesWriteInput) => Promise<SetPropertiesWriteResult>
    isWriting: boolean
} {
    const { baseUrl, apiVersion } = useConfig() as {
        baseUrl: string
        apiVersion: number
    }
    const [writing, setWriting] = useState(false)
    const identity = useChangeSetAuthor()

    const write = useCallback(
        async (
            input: SetPropertiesWriteInput
        ): Promise<SetPropertiesWriteResult> => {
            setWriting(true)
            try {
                const fetcher = createFetcher(baseUrl, apiVersion)
                await setGroupSetProperties(fetcher, input.set, input.after)
                const changeSet: ChangeSet = {
                    id: generateChangeSetId(),
                    createdAt: new Date().toISOString(),
                    createdBy: identity,
                    objectType: input.set.objectType,
                    groupSetId: input.set.id,
                    groupSetName: input.set.displayName,
                    action: input.action,
                    note: input.note ?? '',
                    changes: [],
                    properties: { before: input.before, after: input.after },
                    revertOf: input.revertOf,
                }
                try {
                    await saveChangeSet(fetcher, changeSet)
                    return { changeSet }
                } catch (e) {
                    return {
                        changeSet,
                        historyError:
                            e instanceof Error ? e.message : String(e),
                    }
                }
            } finally {
                setWriting(false)
            }
        },
        // oxlint-disable-next-line react/memo-dependencies -- every listed dependency is read in the callback, as react-hooks/exhaustive-deps confirms
        [baseUrl, apiVersion, identity]
    )

    return { write, isWriting: writing }
}
