import type { MembershipsPayload, ObjectsPayload } from '@/engine/protocol'
import type { ObjectType } from '@/engine/types'

export type Fetcher = (path: string, init?: RequestInit) => Promise<Response>

export interface Progress {
    label: string
    done: number
    total: number | null
}

export interface NamedId {
    id: string
    displayName: string
}

export interface DataSource {
    kind: 'sqlView' | 'metadata'
    /**
     * Where organisation unit display names come from, which is not always
     * where everything else comes from: the SQL view path serves names from
     * `GSI_ORGUNIT_NAMES` when that view exists and from the metadata API
     * when it does not (design spec §8a -- removing the names view is the
     * supported way to get locale-resolved `displayName` back without
     * giving up the fast hierarchy and membership reads). The app tells the
     * user which source served the load, so it has to be able to say when
     * the answer differs for names.
     */
    nameSource: 'sqlView' | 'metadata'
    loadObjects: (
        type: ObjectType,
        onProgress: (p: Progress) => void
    ) => Promise<ObjectsPayload>
    loadNames: (type: ObjectType) => Promise<NamedId[]>
    loadMemberships: (
        type: ObjectType,
        groupIds: string[],
        onProgress: (p: Progress) => void
    ) => Promise<MembershipsPayload>
}

export async function fetchJson<T>(fetcher: Fetcher, path: string): Promise<T> {
    const response = await fetcher(path)
    if (!response.ok) {
        throw new Error(`${path} failed with HTTP ${response.status}`)
    }
    return (await response.json()) as T
}
