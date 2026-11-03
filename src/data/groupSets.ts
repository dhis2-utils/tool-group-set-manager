import { ENDPOINTS } from './endpoints'
import type { Fetcher } from './sources/DataSource'
import { fetchJson } from './sources/DataSource'
import type { GroupMeta, GroupSetMeta, ObjectType } from '@/engine/types'
import { OBJECT_TYPES } from '@/engine/types'

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
            groups: groups.map((g): GroupMeta => ({
                id: g.id,
                displayName: g.displayName,
                code: g.code,
                canWrite: g.access.write === true,
            })),
        }
    })
}

export interface GroupSetsResult {
    sets: GroupSetMeta[]
    /** object type -> why its group sets could not be read */
    errors: Partial<Record<ObjectType, string>>
}

/**
 * Spec 6.4: load failures are per object type. A bare Promise.all here made
 * one non-200 response (a type the user may not read, say) reject the whole
 * dashboard with a single "Loading failed" box, undoing the per-type
 * isolation the rest of the loader goes to trouble to provide -- so each
 * type settles on its own and the failed ones are reported alongside the
 * sets that did load.
 */
export async function loadGroupSets(
    fetcher: Fetcher
): Promise<GroupSetsResult> {
    const settled = await Promise.allSettled(
        OBJECT_TYPES.map((type) => loadType(fetcher, type))
    )
    const sets: GroupSetMeta[] = []
    const errors: Partial<Record<ObjectType, string>> = {}
    settled.forEach((outcome, i) => {
        const type = OBJECT_TYPES[i]
        if (outcome.status === 'fulfilled') {
            sets.push(...outcome.value)
        } else {
            const reason: unknown = outcome.reason
            errors[type] =
                reason instanceof Error ? reason.message : String(reason)
        }
    })
    return { sets, errors }
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
