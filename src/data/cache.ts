import { openDB } from 'idb'
import type { MembershipsPayload, ObjectsPayload } from '@/engine/protocol'
import type { ObjectType } from '@/engine/types'

/**
 * How long a cached payload may be reused before it is re-read regardless
 * of what the server's own signals say.
 *
 * This is not belt-and-braces on top of a working check. On 2.41 through
 * 2.43 a group's `lastUpdated` does not move when its membership changes
 * (docs/superpowers/notes/2026-09-plan7-lastupdated-guard.md), and neither
 * the group id list nor the object total can see an object moving between
 * groups -- so on three of four supported versions every gate spec 4.4
 * defines is blind to the one change this tool exists to watch. Age cannot
 * make them see it; it bounds how long they can be wrong.
 *
 * Ten minutes is a starting value chosen to match "a few minutes old is
 * fine", not a tuned one.
 */
export const CACHE_TTL_MS = 10 * 60 * 1000

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
    /**
     * When this entry was written. `tryCache` reads it to reject the entry
     * once it is older than `CACHE_TTL_MS`, regardless of what the other
     * gates say.
     */
    savedAt: number
}

export interface Cache {
    get: (type: ObjectType) => Promise<CachedType | undefined>
    put: (type: ObjectType, value: CachedType) => Promise<void>
    /**
     * Removes only the one type's cached payload. On 2.43 a membership
     * write does not bump a group's `lastUpdated` (see
     * docs/superpowers/notes/2026-09-plan2-write-api-findings.md section 3;
     * 2.40 does bump it -- see
     * docs/superpowers/notes/2026-09-plan2-write-compatibility.md section 4
     * -- but the app cannot assume that of every server it runs against),
     * so the app must invalidate precisely what it changed itself rather
     * than rely on the next load noticing -- and `clear()` is too broad for
     * that: on a large instance, discarding all four types' payloads to fix
     * one costs a reload the other three types never needed.
     */
    remove: (type: ObjectType) => Promise<void>
    clear: () => Promise<void>
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
        async remove(type) {
            try {
                await (await db).delete(STORE, key(type))
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
        get(type) {
            return Promise.resolve(map.get(type))
        },
        put(type, value) {
            map.set(type, value)
            return Promise.resolve()
        },
        remove(type) {
            map.delete(type)
            return Promise.resolve()
        },
        clear() {
            map.clear()
            return Promise.resolve()
        },
    }
}
