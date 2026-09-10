import { parseCsv } from '../csv'
import { DataSource, Fetcher, Progress } from './DataSource'
import { createMetadataSource } from './metadataSource'
import { MembershipsPayload, ObjectsPayload } from '@/engine/protocol'
import { ObjectType } from '@/engine/types'

export interface SqlViewIds {
    orgUnits: string
    orgUnitNames: string
    orgUnitMemberships: string
}

export const SQL_VIEW_CODES = {
    orgUnits: 'GSI_ORGUNITS',
    orgUnitNames: 'GSI_ORGUNIT_NAMES',
    orgUnitMemberships: 'GSI_ORGUNIT_MEMBERSHIPS',
} as const

export const SQL_VIEW_DEFINITIONS = [
    {
        code: SQL_VIEW_CODES.orgUnits,
        name: 'GSI org unit hierarchy',
        sqlQuery:
            'select ou.uid, ou.hierarchylevel as level, p.uid as parent from organisationunit ou left join organisationunit p on p.organisationunitid = ou.parentid',
    },
    {
        code: SQL_VIEW_CODES.orgUnitNames,
        name: 'GSI org unit names',
        sqlQuery: 'select uid, name from organisationunit',
    },
    {
        code: SQL_VIEW_CODES.orgUnitMemberships,
        name: 'GSI org unit group memberships',
        sqlQuery:
            'select g.uid as groupid, ou.uid as ouid from orgunitgroupmembers m join orgunitgroup g on g.orgunitgroupid = m.orgunitgroupid join organisationunit ou on ou.organisationunitid = m.organisationunitid where g.orgunitgroupid in (select orgunitgroupid from orgunitgroupsetmembers)',
    },
]

async function fetchCsv(fetcher: Fetcher, viewId: string): Promise<string[][]> {
    const response = await fetcher(`sqlViews/${viewId}/data.csv?paging=false`)
    if (!response.ok) {
        throw new Error(
            `SQL view ${viewId} failed with HTTP ${response.status}`
        )
    }
    const rows = parseCsv(await response.text())
    return rows.slice(1) // drop header
}

export function createSqlViewSource(
    fetcher: Fetcher,
    views: SqlViewIds
): DataSource {
    const metadata = createMetadataSource(fetcher)

    const loadObjects = async (
        type: ObjectType,
        onProgress: (p: Progress) => void
    ): Promise<ObjectsPayload> => {
        if (type !== 'organisationUnit') {
            return metadata.loadObjects(type, onProgress)
        }
        onProgress({ label: 'organisationUnits', done: 0, total: 1 })
        const rows = await fetchCsv(fetcher, views.orgUnits)
        const payload: ObjectsPayload = {
            objectType: type,
            ids: rows.map((r) => r[0]),
            names: null,
            level: Uint8Array.from(rows, (r) => Number(r[1])),
            parentIds: rows.map((r) => (r[2] === '' ? null : r[2])),
            domainType: null,
            categoryIdsOfOption: null,
        }
        onProgress({ label: 'organisationUnits', done: 1, total: 1 })
        return payload
    }

    const loadNames = async (type: ObjectType) => {
        if (type !== 'organisationUnit') {
            return metadata.loadNames(type)
        }
        const rows = await fetchCsv(fetcher, views.orgUnitNames)
        return rows.map((r) => ({ id: r[0], displayName: r[1] }))
    }

    const loadMemberships = async (
        type: ObjectType,
        groupIds: string[],
        onProgress: (p: Progress) => void
    ): Promise<MembershipsPayload> => {
        if (type !== 'organisationUnit') {
            return metadata.loadMemberships(type, groupIds, onProgress)
        }
        onProgress({ label: 'organisationUnitGroups', done: 0, total: 1 })
        const rows = await fetchCsv(fetcher, views.orgUnitMemberships)
        const byGroup = new Map<string, string[]>(groupIds.map((g) => [g, []]))
        rows.forEach((r) => byGroup.get(r[0])?.push(r[1]))
        onProgress({ label: 'organisationUnitGroups', done: 1, total: 1 })
        return {
            objectType: type,
            groups: groupIds.map((groupId) => ({
                groupId,
                memberIds: byGroup.get(groupId) ?? [],
            })),
        }
    }

    return { kind: 'sqlView', loadObjects, loadNames, loadMemberships }
}
