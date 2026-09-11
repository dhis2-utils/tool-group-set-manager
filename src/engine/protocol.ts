import { ObjectType } from './types'

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
    | 'dashboard'
    | 'matrixFor'
    | 'objectsFor'
    | 'planAssignment'
    | 'planRevert'
    | 'resolve'
    | 'resolveParents'
    | 'indexOf'
    | 'indexesOf'
    | 'levelOf'
    | 'reset'
    | 'dropType'

export interface EngineRequest {
    id: number
    method: EngineMethod
    args: unknown[]
}

export type EngineResponse =
    | { id: number; ok: true; result: unknown }
    | { id: number; ok: false; error: string }
