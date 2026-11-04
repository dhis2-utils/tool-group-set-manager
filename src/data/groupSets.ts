import { ENDPOINTS } from './endpoints'
import type { Fetcher } from './sources/DataSource'
import { fetchJson } from './sources/DataSource'
import type { GroupMeta, GroupSetMeta, ObjectType } from '@/engine/types'
import { OBJECT_TYPES } from '@/engine/types'

interface GroupRow {
    id: string
    displayName?: string
    code?: string
    access: { read?: boolean; write: boolean }
}

interface GroupSetRow {
    id: string
    displayName: string
    compulsory?: boolean
    dataDimension?: boolean
    access: { read?: boolean; write: boolean }
    [groupsField: string]: unknown
}

/**
 * A group set the user can see but cannot check: at least one of its groups
 * is not shared with them. Kept apart from the checked sets and never sent
 * to the engine -- with a group missing, every object in it would read as
 * "in no group" and the set's numbers would be wrong, not just incomplete.
 */
export interface RestrictedGroupSet {
    id: string
    displayName: string
    objectType: ObjectType
    /** Groups of the set the user cannot read. */
    hiddenGroups: number
    /** All groups of the set, readable or not. */
    totalGroups: number
}

interface TypeResult {
    sets: GroupSetMeta[]
    restricted: RestrictedGroupSet[]
}

/**
 * The same order in every session: the API returns a set's groups in
 * collection order, which is not stable between requests, and every column
 * and option list follows this order.
 */
const byDisplayName = (a: GroupMeta, b: GroupMeta) =>
    a.displayName.localeCompare(b.displayName) || a.id.localeCompare(b.id)

async function loadType(
    fetcher: Fetcher,
    type: ObjectType
): Promise<TypeResult> {
    const ep = ENDPOINTS[type]
    const fields = `id,displayName,compulsory,dataDimension,access,${ep.groups}[id,displayName,code,access]`
    const body = await fetchJson<Record<string, GroupSetRow[]>>(
        fetcher,
        `${ep.groupSets}?fields=${fields}&paging=false`
    )
    const result: TypeResult = { sets: [], restricted: [] }
    for (const row of body[ep.groupSets]) {
        // Defensive: a set the user cannot read is expected not to be
        // listed at all, but if one ever is, it is not theirs to see.
        if (row.access.read === false) {
            continue
        }
        const groups = (row[ep.groups] as GroupRow[] | undefined) ?? []
        // A group the user cannot read is still listed in its set, with
        // `access.read: false` and no displayName (measured on 2.42.7.1,
        // see docs/developer/dhis2-behavior.md).
        const hiddenGroups = groups.filter(
            (g) => g.access.read === false
        ).length
        if (hiddenGroups > 0) {
            result.restricted.push({
                id: row.id,
                displayName: row.displayName,
                objectType: type,
                hiddenGroups,
                totalGroups: groups.length,
            })
            continue
        }
        result.sets.push({
            id: row.id,
            displayName: row.displayName,
            objectType: type,
            // Indicator sets have no dataDimension and category option sets no
            // compulsory; the API omits unknown fields, so default to false.
            compulsory: row.compulsory === true,
            dataDimension: row.dataDimension === true,
            canWrite: row.access.write === true,
            groups: groups
                .map((g): GroupMeta => ({
                    id: g.id,
                    displayName: g.displayName ?? g.id,
                    code: g.code,
                    canWrite: g.access.write === true,
                }))
                .sort(byDisplayName),
        })
    }
    return result
}

export interface GroupSetsResult {
    sets: GroupSetMeta[]
    /**
     * Sets with at least one group the user cannot read. Not in `sets`, so
     * they never reach the engine, the membership load or the cache key.
     */
    restricted: RestrictedGroupSet[]
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
    const restricted: RestrictedGroupSet[] = []
    const errors: Partial<Record<ObjectType, string>> = {}
    settled.forEach((outcome, i) => {
        const type = OBJECT_TYPES[i]
        if (outcome.status === 'fulfilled') {
            sets.push(...outcome.value.sets)
            restricted.push(...outcome.value.restricted)
        } else {
            const reason: unknown = outcome.reason
            errors[type] =
                reason instanceof Error ? reason.message : String(reason)
        }
    })
    return { sets, restricted, errors }
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
