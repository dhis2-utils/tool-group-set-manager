import { ENDPOINTS } from './endpoints'
import { fetchJson, Fetcher } from './sources/DataSource'
import {
    GroupMeta,
    GroupSetMeta,
    OBJECT_TYPES,
    ObjectType,
} from '@/engine/types'

interface GroupRow {
    id: string
    displayName: string
    code?: string
    access: { write: boolean }
}

interface GroupSetRow {
    id: string
    displayName: string
    compulsory?: boolean
    dataDimension?: boolean
    access: { write: boolean }
    [groupsField: string]: unknown
}

async function loadType(
    fetcher: Fetcher,
    type: ObjectType
): Promise<GroupSetMeta[]> {
    const ep = ENDPOINTS[type]
    const fields = `id,displayName,compulsory,dataDimension,access,${ep.groups}[id,displayName,code,access]`
    const body = await fetchJson<Record<string, GroupSetRow[]>>(
        fetcher,
        `${ep.groupSets}?fields=${fields}&paging=false`
    )
    return body[ep.groupSets].map((row) => {
        const groups = (row[ep.groups] as GroupRow[] | undefined) ?? []
        return {
            id: row.id,
            displayName: row.displayName,
            objectType: type,
            // Indicator sets have no dataDimension and category option sets no
            // compulsory; the API omits unknown fields, so default to false.
            compulsory: row.compulsory === true,
            dataDimension: row.dataDimension === true,
            canWrite: row.access.write === true,
            groups: groups.map(
                (g): GroupMeta => ({
                    id: g.id,
                    displayName: g.displayName,
                    code: g.code,
                    canWrite: g.access.write === true,
                })
            ),
        }
    })
}

export async function loadGroupSets(fetcher: Fetcher): Promise<GroupSetMeta[]> {
    const perType = await Promise.all(
        OBJECT_TYPES.map((type) => loadType(fetcher, type))
    )
    return perType.flat()
}

export function groupIdsFor(sets: GroupSetMeta[], type: ObjectType): string[] {
    const seen = new Set<string>()
    const ids: string[] = []
    sets.filter((s) => s.objectType === type).forEach((s) =>
        s.groups.forEach((g) => {
            if (!seen.has(g.id)) {
                seen.add(g.id)
                ids.push(g.id)
            }
        })
    )
    return ids
}
