import type { ObjectType } from '@/engine/types'

export const ENDPOINTS: Record<
    ObjectType,
    { collection: string; groups: string; members: string; groupSets: string }
> = {
    organisationUnit: {
        collection: 'organisationUnits',
        groups: 'organisationUnitGroups',
        members: 'organisationUnits',
        groupSets: 'organisationUnitGroupSets',
    },
    dataElement: {
        collection: 'dataElements',
        groups: 'dataElementGroups',
        members: 'dataElements',
        groupSets: 'dataElementGroupSets',
    },
    indicator: {
        collection: 'indicators',
        groups: 'indicatorGroups',
        members: 'indicators',
        groupSets: 'indicatorGroupSets',
    },
    categoryOption: {
        collection: 'categoryOptions',
        groups: 'categoryOptionGroups',
        members: 'categoryOptions',
        groupSets: 'categoryOptionGroupSets',
    },
}
