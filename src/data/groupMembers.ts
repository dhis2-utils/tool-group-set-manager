import { ENDPOINTS } from './endpoints'
import type { Fetcher } from './sources/DataSource'
import type { ObjectType } from '@/engine/types'

/**
 * Ids per `filter=id:in:[…]` request. 100 eleven-character uids keep the
 * query string near 1,200 characters, well inside what every proxy in front
 * of a DHIS2 instance accepts.
 */
export const FILTER_CHUNK_SIZE = 100

/**
 * Above this many ids, one unfiltered read of the whole group is cheaper
 * than the ten-plus filtered requests it would take, even for a large
 * group (1-2 s on a 266k-unit instance, see `readGroupMembers`).
 */
export const FULL_READ_THRESHOLD = 1000

async function fetchMemberIds(
    fetcher: Fetcher,
    objectType: ObjectType,
    groupId: string,
    query: string,
    signal?: AbortSignal
): Promise<string[]> {
    const endpoint = ENDPOINTS[objectType]
    const response = await fetcher(
        `${endpoint.groups}/${groupId}/${endpoint.members}?fields=id${query}&paging=false`,
        { cache: 'no-store', signal }
    )
    if (!response.ok) {
        throw new Error(`HTTP ${response.status}`)
    }
    const body = (await response.json()) as Record<string, { id: string }[]>
    return (body[endpoint.members] ?? []).map((o) => o.id)
}

/**
 * The complete current membership of the named groups, read from the
 * server right now. The bulk fix's pre-write check calls this for the
 * groups about to receive a JSON Patch replace (spec 2026-09-16 section
 * 5.1): a replace overwrites the whole collection, so a member someone else
 * added since our snapshot would be silently dropped unless the list we
 * send was just re-read.
 *
 * `cache: 'no-store'` because a view or collection an earlier build created
 * may carry a two-week `Cache-Control` (docs/developer/dhis2-behavior.md),
 * and a cached answer here defeats the whole point. `paging=false` because
 * a default page of 50 would look like a small group. Groups are read in
 * parallel; the measured cost is 1-2 s per group on a 266k-unit instance
 * (docs/developer/dhis2-behavior.md).
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
    const entries = await Promise.all(
        groupIds.map(
            async (groupId) =>
                [
                    groupId,
                    await fetchMemberIds(
                        fetcher,
                        objectType,
                        groupId,
                        '',
                        signal
                    ),
                ] as const
        )
    )
    return new Map(entries)
}

/**
 * Which of `ids` are members of one group right now, read from the server.
 * A short list is asked for by id (`filter=id:in:[…]`, in chunks of
 * `FILTER_CHUNK_SIZE`, one after another), so checking a handful of objects
 * in a group of tens of thousands costs a few hundred bytes; past
 * `FULL_READ_THRESHOLD` ids the whole group is read once instead.
 */
export async function readMembersAmong(
    fetcher: Fetcher,
    objectType: ObjectType,
    groupId: string,
    ids: string[],
    signal?: AbortSignal
): Promise<Set<string>> {
    const wanted = [...new Set(ids)]
    if (wanted.length === 0) {
        return new Set()
    }
    if (wanted.length > FULL_READ_THRESHOLD) {
        const wantedSet = new Set(wanted)
        const all = await fetchMemberIds(
            fetcher,
            objectType,
            groupId,
            '',
            signal
        )
        return new Set(all.filter((id) => wantedSet.has(id)))
    }
    const present = new Set<string>()
    /* oxlint-disable no-await-in-loop -- one chunk at a time keeps a large check from bursting requests at a shared instance */
    for (let start = 0; start < wanted.length; start += FILTER_CHUNK_SIZE) {
        const chunk = wanted.slice(start, start + FILTER_CHUNK_SIZE)
        const filter = encodeURIComponent(`id:in:[${chunk.join(',')}]`)
        const found = await fetchMemberIds(
            fetcher,
            objectType,
            groupId,
            `&filter=${filter}`,
            signal
        )
        for (const id of found) {
            present.add(id)
        }
    }
    /* oxlint-enable no-await-in-loop */
    return present
}

/**
 * `readMembersAmong` for several groups at once: for each group, which of
 * the ids given for it are members right now. Parallel across groups,
 * keyed by group id.
 */
export async function readMembershipAmong(
    fetcher: Fetcher,
    objectType: ObjectType,
    idsByGroup: Map<string, string[]>,
    signal?: AbortSignal
): Promise<Map<string, Set<string>>> {
    const entries = await Promise.all(
        Array.from(
            idsByGroup,
            async ([groupId, ids]) =>
                [
                    groupId,
                    await readMembersAmong(
                        fetcher,
                        objectType,
                        groupId,
                        ids,
                        signal
                    ),
                ] as const
        )
    )
    return new Map(entries)
}
