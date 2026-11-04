import type { ObjectType } from './types'

export interface ObjectsPayload {
    objectType: ObjectType
    ids: string[]
    names: string[] | null
    /** org units only */
    level: Uint8Array | null
    /** org units only, same length as ids, null for roots */
    parentIds: (string | null)[] | null
    /** data elements only: 1 aggregate, 2 tracker */
    domainType: Uint8Array | null
    /** category options only: category ids per option */
    categoryIdsOfOption: string[][] | null
}

export interface MembershipsPayload {
    objectType: ObjectType
    groups: { groupId: string; memberIds: string[] }[]
}

export type EngineMethod =
    | 'loadObjects'
    | 'loadMemberships'
    | 'setGroupSets'
    | 'setConfig'
    | 'setNames'
    | 'evaluate'
    | 'applyChangeSet'
    | 'setGroupMembers'
    | 'dashboard'
    | 'matrixFor'
    | 'objectsFor'
    | 'planAssignment'
    | 'planRevert'
    | 'resolve'
    | 'resolveParents'
    | 'indexesOf'
    | 'levelOf'
    | 'reset'
    | 'dropType'

export interface EngineRequest {
    id: number
    method: EngineMethod
    args: unknown[]
}

/**
 * `revision` is the store's revision after the call (see
 * `EngineStore.revision`). Optional so a response from something that does
 * not track it (a test double) still reads as a response.
 */
export type EngineResponse =
    | { id: number; ok: true; result: unknown; revision?: number }
    | { id: number; ok: false; error: string; revision?: number }
