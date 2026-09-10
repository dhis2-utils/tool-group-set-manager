import { openDB } from 'idb'
import { MembershipsPayload, ObjectsPayload } from '@/engine/protocol'
import { ObjectType } from '@/engine/types'

export interface CachedType {
    objects: ObjectsPayload
    memberships: MembershipsPayload
    names: string[] | null
    groupIds: string[]
    /**
     * Spec 4.4: the groups' `lastUpdated` stamps at load time, keyed by group
     * id. Moving an object from one group to another changes neither the
     * group id list nor the object total, so those two alone can never notice
     * a membership change; the stamps can. An entry written before this field
     * existed has it undefined, which reads as "cannot be verified" and so
     * forces a reload.
     */
    groupLastUpdated?: Record<string, string>
    objectTotal: number
    savedAt: number
}

export interface Cache {
    get(type: ObjectType): Promise<CachedType | undefined>
    put(type: ObjectType, value: CachedType): Promise<void>
    clear(): Promise<void>
}

const DB_NAME = 'gsi-cache'
const STORE = 'types'

export function openCache(serverUrl: string): Cache {
    const db = openDB(DB_NAME, 1, {
        upgrade(database) {
            database.createObjectStore(STORE)
        },
    })
    const key = (type: ObjectType) => `${serverUrl}|${type}`
    return {
        async get(type) {
            try {
                return (await (await db).get(STORE, key(type))) as
                    | CachedType
                    | undefined
            } catch {
                return undefined // private mode or blocked storage: behave as empty
            }
        },
        async put(type, value) {
            try {
                await (await db).put(STORE, value, key(type))
            } catch {
                // Storage failures must never break loading.
            }
        },
        async clear() {
            try {
                await (await db).clear(STORE)
            } catch {
                // ignore
            }
        },
    }
}

export function createMemoryCache(): Cache {
    const map = new Map<ObjectType, CachedType>()
    return {
        async get(type) {
            return map.get(type)
        },
        async put(type, value) {
            map.set(type, value)
        },
        async clear() {
            map.clear()
        },
    }
}
