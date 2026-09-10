import { MembershipsPayload, ObjectsPayload } from '@/engine/protocol'
import { ObjectType } from '@/engine/types'

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
    loadObjects(
        type: ObjectType,
        onProgress: (p: Progress) => void
    ): Promise<ObjectsPayload>
    loadNames(type: ObjectType): Promise<NamedId[]>
    loadMemberships(
        type: ObjectType,
        groupIds: string[],
        onProgress: (p: Progress) => void
    ): Promise<MembershipsPayload>
}

export async function fetchJson<T>(fetcher: Fetcher, path: string): Promise<T> {
    const response = await fetcher(path)
    if (!response.ok) {
        throw new Error(`${path} failed with HTTP ${response.status}`)
    }
    return (await response.json()) as T
}
