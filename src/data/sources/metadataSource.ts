import { ENDPOINTS } from '../endpoints'
import type { DataSource, Fetcher, NamedId, Progress } from './DataSource'
import { fetchJson } from './DataSource'
import type { MembershipsPayload, ObjectsPayload } from '@/engine/protocol'
import type { ObjectType } from '@/engine/types'

interface OrgUnitRow {
    id: string
    level: number
    parent?: { id: string }
}
interface DataElementRow {
    id: string
    displayName: string
    domainType: 'AGGREGATE' | 'TRACKER'
}
interface NamedRow {
    id: string
    displayName: string
}
interface CategoryOptionRow extends NamedRow {
    categories: { id: string }[]
}

const emptyPayload = (
    objectType: ObjectType,
    ids: string[]
): ObjectsPayload => ({
    objectType,
    ids,
    names: null,
    level: null,
    parentIds: null,
    domainType: null,
    categoryIdsOfOption: null,
})

export function createMetadataSource(fetcher: Fetcher): DataSource {
    const loadObjects = async (
        type: ObjectType,
        onProgress: (p: Progress) => void
    ): Promise<ObjectsPayload> => {
        const ep = ENDPOINTS[type]
        onProgress({ label: ep.collection, done: 0, total: null })
        switch (type) {
            case 'organisationUnit': {
                // Names are deliberately left out: on 266K org units they add 15 MB
                // and 20+ seconds; loadNames fetches them afterwards.
                const body = await fetchJson<{
                    organisationUnits: OrgUnitRow[]
                }>(
                    fetcher,
                    `${ep.collection}?fields=id,level,parent&paging=false`
                )
                const rows = body.organisationUnits
                const payload = emptyPayload(
                    type,
                    rows.map((r) => r.id)
                )
                payload.level = Uint8Array.from(rows, (r) => r.level)
                payload.parentIds = rows.map((r) => r.parent?.id ?? null)
                onProgress({ label: ep.collection, done: 1, total: 1 })
                return payload
            }
            case 'dataElement': {
                const body = await fetchJson<{
                    dataElements: DataElementRow[]
                }>(
                    fetcher,
                    `${ep.collection}?fields=id,displayName,domainType&paging=false`
                )
                const rows = body.dataElements
                const payload = emptyPayload(
                    type,
                    rows.map((r) => r.id)
                )
                payload.names = rows.map((r) => r.displayName)
                payload.domainType = Uint8Array.from(rows, (r) =>
                    r.domainType === 'TRACKER' ? 2 : 1
                )
                onProgress({ label: ep.collection, done: 1, total: 1 })
                return payload
            }
            case 'indicator': {
                const body = await fetchJson<{ indicators: NamedRow[] }>(
                    fetcher,
                    `${ep.collection}?fields=id,displayName&paging=false`
                )
                const payload = emptyPayload(
                    type,
                    body.indicators.map((r) => r.id)
                )
                payload.names = body.indicators.map((r) => r.displayName)
                onProgress({ label: ep.collection, done: 1, total: 1 })
                return payload
            }
            case 'categoryOption': {
                const body = await fetchJson<{
                    categoryOptions: CategoryOptionRow[]
                }>(
                    fetcher,
                    `${ep.collection}?fields=id,displayName,categories[id]&paging=false`
                )
                const rows = body.categoryOptions
                const payload = emptyPayload(
                    type,
                    rows.map((r) => r.id)
                )
                payload.names = rows.map((r) => r.displayName)
                payload.categoryIdsOfOption = rows.map((r) =>
                    r.categories.map((c) => c.id)
                )
                onProgress({ label: ep.collection, done: 1, total: 1 })
                return payload
            }
            // Exhaustive: TypeScript rejects this function if a case is missing.
            // no default
        }
    }

    const loadNames = async (type: ObjectType): Promise<NamedId[]> => {
        const ep = ENDPOINTS[type]
        const body = await fetchJson<Record<string, NamedRow[]>>(
            fetcher,
            `${ep.collection}?fields=id,displayName&paging=false`
        )
        return body[ep.collection]
    }

    const loadMemberships = async (
        type: ObjectType,
        groupIds: string[],
        onProgress: (p: Progress) => void
    ): Promise<MembershipsPayload> => {
        const ep = ENDPOINTS[type]
        const groups: MembershipsPayload['groups'] = []
        for (let i = 0; i < groupIds.length; i++) {
            const groupId = groupIds[i]
            // oxlint-disable-next-line no-await-in-loop -- one group at a time keeps the server's load bounded and progress in order
            const body = await fetchJson<Record<string, { id: string }[]>>(
                fetcher,
                `${ep.groups}/${groupId}/${ep.members}?fields=id&paging=false`
            )
            groups.push({
                groupId,
                memberIds: body[ep.members].map((m) => m.id),
            })
            onProgress({
                label: ep.groups,
                done: i + 1,
                total: groupIds.length,
            })
        }
        return { objectType: type, groups }
    }

    return {
        kind: 'metadata',
        nameSource: 'metadata',
        loadObjects,
        loadNames,
        loadMemberships,
    }
}
