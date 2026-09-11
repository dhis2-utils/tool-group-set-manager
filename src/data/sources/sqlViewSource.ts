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

/**
 * M4: the SQL view types this app will read, declared once. Both the
 * reader's source selection (`selectSource`) and the Settings status/repair
 * screen (`sqlViewAdmin`) must agree on this: a status page that calls a
 * view "usable" -- or offers to repair it -- when the reader would then
 * refuse it is actively misleading, and a comment asking two copies to stay
 * in step is not a mechanism.
 *
 * It is an allow list rather than a `MATERIALIZED_VIEW` deny list because a
 * response with no `type` at all (a trimmed or older payload) must not slip
 * a materialised view through: the whole point of the check is that stale
 * rows are invisible to the user, so an unknown type is unusable.
 */
export const USABLE_SQL_VIEW_TYPES = ['VIEW', 'QUERY']

export const SQL_VIEW_CODES = {
    orgUnits: 'GSI_ORGUNITS',
    orgUnitNames: 'GSI_ORGUNIT_NAMES',
    orgUnitMemberships: 'GSI_ORGUNIT_MEMBERSHIPS',
} as const

/**
 * `type` is pinned on every definition: the app refuses to read a
 * MATERIALIZED_VIEW (see selectSource.ts -- it serves whatever was last
 * written, with no signal of its age), so the creation code a later plan
 * writes must not inherit whatever the server would default to.
 */
export const SQL_VIEW_DEFINITIONS = [
    {
        code: SQL_VIEW_CODES.orgUnits,
        type: 'VIEW',
        name: 'GSI org unit hierarchy',
        sqlQuery:
            'select ou.uid, ou.hierarchylevel as level, p.uid as parent from organisationunit ou left join organisationunit p on p.organisationunitid = ou.parentid',
    },
    {
        code: SQL_VIEW_CODES.orgUnitNames,
        type: 'VIEW',
        name: 'GSI org unit names',
        // Returns the raw, untranslated `name` column by design: resolving a
        // caller's locale inside a SQL view is not practical, and this
        // divergence from the metadata source's `displayName` only affects
        // the label shown, never ids, counts or fixes. See design spec
        // section 8a.
        sqlQuery: 'select uid, name from organisationunit',
    },
    {
        code: SQL_VIEW_CODES.orgUnitMemberships,
        type: 'VIEW',
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
