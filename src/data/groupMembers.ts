import { ENDPOINTS } from './endpoints'
import type { Fetcher } from './sources/DataSource'
import type { ObjectType } from '@/engine/types'

/**
 * The complete current membership of the named groups, read from the
 * server right now. The bulk fix's pre-write check calls this for the
 * groups about to receive a JSON Patch replace (spec 2026-09-16 section
 * 5.1): a replace overwrites the whole collection, so a member someone else
 * added since our snapshot would be silently dropped unless the list we
 * send was just re-read.
 *
 * `cache: 'no-store'` because a view or collection an earlier build created
 * may carry a two-week `Cache-Control` (2026-09-plan7-e2e-write-flows.md),
 * and a cached answer here defeats the whole point. `paging=false` because
 * a default page of 50 would look like a small group. Groups are read in
 * parallel; the measured cost is 1-2 s per group on a 266k-unit instance
 * (2026-09-plan8-reread-cost.md).
 */
export async function readGroupMembers(
    fetcher: Fetcher,
    objectType: ObjectType,
    groupIds: string[],
    signal?: AbortSignal
): Promise<Map<string, string[]>> {
    if (groupIds.length === 0) {
        return new Map()
    }
    const endpoint = ENDPOINTS[objectType]
    const entries = await Promise.all(
        groupIds.map(async (groupId) => {
            const response = await fetcher(
                `${endpoint.groups}/${groupId}/${endpoint.members}?fields=id&paging=false`,
                { cache: 'no-store', signal }
            )
            if (!response.ok) {
                throw new Error(`HTTP ${response.status}`)
            }
            const body = (await response.json()) as Record<
                string,
                { id: string }[]
            >
            return [
                groupId,
                (body[endpoint.members] ?? []).map((o) => o.id),
            ] as const
        })
    )
    return new Map(entries)
}
