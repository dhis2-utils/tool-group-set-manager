import { ENDPOINTS } from './endpoints'
import { Fetcher } from './sources/DataSource'
import { GroupChange } from '@/engine/changeSet'
import { ObjectType } from '@/engine/types'

/**
 * The outcome of one batch request against one group. `requested` and
 * `accepted` are both counts of ids (additions plus deletions), not booleans,
 * because DHIS2 can accept some of a batch and drop the rest without saying
 * which -- see finding 2 in
 * docs/superpowers/notes/2026-09-plan2-write-api-findings.md. `accepted <
 * requested` marks a partial failure; `error` is set instead when the
 * request itself failed (non-200, or the request never completed).
 */
export interface BatchOutcome {
    groupId: string
    requested: number
    accepted: number
    error?: string
}

/**
 * What `writeMemberships` actually achieved, as distinct from what it was
 * asked to do. `applied` is the truth a ChangeSet should be built from:
 * only the batches the server's own stats confirm in full. `unaccounted` is
 * every batch that came back short, in full -- see the note on
 * reconciliation below for why it is never a guessed subset.
 */
export interface WriteResult {
    outcomes: BatchOutcome[]
    applied: GroupChange[]
    unaccounted: GroupChange[]
}

interface ImportStats {
    created?: number
    updated?: number
    deleted?: number
    ignored?: number
}

interface ImportReportBody {
    response?: { stats?: ImportStats }
}

/**
 * Reconciles what a batch asked for against what the server's stats confirm
 * it did. Every bucket counts as a success, including `ignored`: an addition
 * of a member that is already there leaves the member where the caller
 * wanted it, so it is not a failure just because the server had nothing to
 * do. What does not count is the absence of `stats` altogether -- a response
 * naming nothing tells us nothing, so that reads as zero accepted rather
 * than as success.
 */
function acceptedCount(body: ImportReportBody | null): number {
    const stats = body?.response?.stats
    if (!stats) {
        return 0
    }
    return (
        (stats.created ?? 0) +
        (stats.updated ?? 0) +
        (stats.deleted ?? 0) +
        (stats.ignored ?? 0)
    )
}

/**
 * Splits one group's change into batches of at most `batchSize` ids
 * (additions and deletions counted together), preserving the additions
 * before deletions ordering within each batch. A change with nothing to do
 * produces no batches at all, so a no-op change never becomes a request.
 */
function splitChange(change: GroupChange, batchSize: number): GroupChange[] {
    const ids: { id: string; addition: boolean }[] = [
        ...change.additions.map((id) => ({ id, addition: true })),
        ...change.deletions.map((id) => ({ id, addition: false })),
    ]
    const batches: GroupChange[] = []
    for (let start = 0; start < ids.length; start += batchSize) {
        const slice = ids.slice(start, start + batchSize)
        batches.push({
            groupId: change.groupId,
            additions: slice.filter((x) => x.addition).map((x) => x.id),
            deletions: slice.filter((x) => !x.addition).map((x) => x.id),
        })
    }
    return batches
}

/**
 * Writes membership changes to DHIS2, one request per group per batch,
 * strictly sequential -- a national fix can be a hundred thousand
 * memberships, and a burst of parallel requests against a shared production
 * instance is not neighbourly.
 *
 * The response to each request is reconciled against what was sent rather
 * than trusted at face value: DHIS2 returns 200 OK even when it silently
 * dropped an invalid id, so an HTTP status alone would report success for a
 * write that did not fully happen (see finding 2 in
 * docs/superpowers/notes/2026-09-plan2-write-api-findings.md). When a batch
 * comes back short, the response names nothing that would let the caller
 * tell which ids it kept, so the whole batch is reported as unaccounted --
 * never a guessed subset -- and the caller must re-read that group from the
 * server rather than trust its own intent.
 *
 * A group the caller cannot write to (or one a network failure hits) is
 * recorded as a failed batch and does not stop the remaining groups: being
 * able to fix nine groups out of ten is worth far more than failing all ten.
 */
export async function writeMemberships(
    fetcher: Fetcher,
    objectType: ObjectType,
    changes: GroupChange[],
    onProgress: (done: number, total: number) => void,
    batchSize = 1000
): Promise<WriteResult> {
    const endpoint = ENDPOINTS[objectType]
    const batches = changes.flatMap((change) => splitChange(change, batchSize))
    const total = batches.length

    const outcomes: BatchOutcome[] = []
    const applied: GroupChange[] = []
    const unaccounted: GroupChange[] = []

    let done = 0
    for (const batch of batches) {
        const requested = batch.additions.length + batch.deletions.length
        try {
            const response = await fetcher(
                `${endpoint.groups}/${batch.groupId}/${endpoint.members}`,
                {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        additions: batch.additions.map((id) => ({ id })),
                        deletions: batch.deletions.map((id) => ({ id })),
                    }),
                }
            )
            if (!response.ok) {
                outcomes.push({
                    groupId: batch.groupId,
                    requested,
                    accepted: 0,
                    error: `HTTP ${response.status}`,
                })
                unaccounted.push(batch)
                continue
            }
            const body = (await response.json()) as ImportReportBody
            const accepted = acceptedCount(body)
            outcomes.push({ groupId: batch.groupId, requested, accepted })
            if (accepted === requested) {
                applied.push(batch)
            } else {
                unaccounted.push(batch)
            }
        } catch (error) {
            outcomes.push({
                groupId: batch.groupId,
                requested,
                accepted: 0,
                error: error instanceof Error ? error.message : String(error),
            })
            unaccounted.push(batch)
        } finally {
            done += 1
            onProgress(done, total)
        }
    }

    return { outcomes, applied, unaccounted }
}
