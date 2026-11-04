import { useApiDataQuery } from '@/utils/useApiDataQuery'

export interface Identity {
    id: string
    displayName: string
}

// Used when the identity query has not settled yet -- a write must never
// wait on a cosmetic field. The change set is still recorded, just with a
// blank author, rather than blocking an already-confirmed server change.
export const UNKNOWN_IDENTITY: Identity = { id: '', displayName: '' }

/**
 * DHIS2 uid rules don't apply here: a change set's `id` is only ever used
 * as a dataStore key (`history-<id>`), never sent as a metadata object id,
 * so it only needs to be unique and URL-safe.
 */
export function generateChangeSetId(): string {
    return `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`
}

/**
 * Who a change set is recorded as written by. Shared by every hook that
 * saves one (membership writes, group set property writes), under one
 * query key so the identity is fetched once.
 */
export function useChangeSetAuthor(): Identity {
    const { data } = useApiDataQuery<Identity>({
        queryKey: ['me', 'identity'],
        query: { resource: 'me', params: { fields: 'id,displayName' } },
        staleTime: Infinity,
    })
    return data ?? UNKNOWN_IDENTITY
}
