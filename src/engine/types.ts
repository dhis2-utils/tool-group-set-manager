export type ObjectType =
    | 'organisationUnit'
    | 'dataElement'
    | 'indicator'
    | 'categoryOption'

export const OBJECT_TYPES: ObjectType[] = [
    'organisationUnit',
    'dataElement',
    'indicator',
    'categoryOption',
]

export interface GroupMeta {
    id: string
    displayName: string
    code?: string
    canWrite: boolean
}

export interface GroupSetMeta {
    id: string
    displayName: string
    objectType: ObjectType
    compulsory: boolean
    dataDimension: boolean
    groups: GroupMeta[]
    canWrite: boolean
}

export enum Status {
    NotApplicable = 0,
    Ok = 1,
    MissingWarning = 2,
    MissingError = 3,
    Conflict = 4,
}

export interface EngineConfig {
    /** group set id -> org unit levels at which membership is required */
    requiredLevels: Record<string, number[]>
    includeTracker: boolean
}

export const DEFAULT_CONFIG: EngineConfig = {
    requiredLevels: {},
    includeTracker: false,
}
