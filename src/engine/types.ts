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
    /** In no group of a set that is neither compulsory nor a data dimension: allowed. */
    NoGroup = 5,
}

/** Every status of an object in no group, whatever its severity: what "No group" lists. */
export const NO_GROUP_STATUSES: Status[] = [
    Status.MissingError,
    Status.MissingWarning,
    Status.NoGroup,
]

export interface EngineConfig {
    includeTracker: boolean
}

export const DEFAULT_CONFIG: EngineConfig = {
    includeTracker: false,
}
