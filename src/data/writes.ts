import { ENDPOINTS } from './endpoints'
import { readMembersAmong } from './groupMembers'
import type { Fetcher } from './sources/DataSource'
import type { GroupChange } from '@/engine/changeSet'
import type { ObjectType } from '@/engine/types'

/**
 * The outcome of one batch request against one group. `requested` and
 * `accepted` are both counts of ids (additions plus deletions), not booleans,
 * because DHIS2 can accept some of a batch and drop the rest without saying
 * which -- see finding 2 in
 * docs/developer/dhis2-behavior.md. `accepted !==
 * requested` marks a partial failure (a shortfall in the ordinary case, but
 * the batch is disowned either way if the server ever reports more than was
 * sent); `error` is set instead when the request itself failed (non-200, the
 * request never completed, or the batch was skipped because an earlier batch
 * for this same group already failed outright -- see the note on the writer
 * below).
 */
export interface BatchOutcome {
    groupId: string
    requested: number
    accepted: number
    /**
     * Either a locale-neutral token (`HTTP 403`, a caught exception's own
     * `message`) that `outcomeText` (writeOutcomes.ts) is allowed to
     * splice into a translated sentence as-is, or the sentinel
     * `UNPARSEABLE_RESPONSE` below, which `outcomeText` must translate
     * itself before display -- see `UNPARSEABLE_RESPONSE`'s own doc
     * comment for why English prose can never live in this field
     * directly.
     */
    error?: string
    /**
     * The raw text behind an `UNPARSEABLE_RESPONSE` `error`, kept for
     * developer diagnostics only -- never shown to a user. Also logged via
     * `console.warn` at the point of capture (below); if a future caller
     * wants to attach it to a bug report or a persisted write log, it is
     * carried here rather than only in that one console line.
     */
    rawError?: string
}

/**
 * Sentinel `error` value for a 200 response whose body could not be parsed
 * as JSON. Not English prose: `outcomeText` (writeOutcomes.ts) splices
 * `error` directly into a translated sentence for every other value this
 * field takes (`HTTP 403`, a caught exception's `message`), because those
 * are locale-neutral tokens. A JSON parser's own message is not, and
 * neither would a hand-written English sentence be if put here directly --
 * this module has no access to `i18n.t`, and is not the place that should
 * translate a user-facing string anyway (see the module doc comment on
 * `setGroupSetProperties` in metadataWrites.ts for the same convention).
 * `outcomeText` recognises this exact value and produces the translated
 * sentence in its place.
 */
export const UNPARSEABLE_RESPONSE = 'unparseable-response'

/**
 * What `writeMemberships` actually achieved, as distinct from what it was
 * asked to do. `applied` is the truth a ChangeSet should be built from:
 * the batches the server's own stats confirm in full, plus the part of a
 * short batch a re-read of the group confirmed. `unaccounted` is the rest:
 * every failed batch, and the ids of a short batch the re-read did not
 * find in place (or the whole short batch when the re-read failed) -- see
 * the note on reconciliation below. Never a guessed subset.
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
 * Ids per collection request, and a measured number rather than a chosen one
 * (spec §6.4, Plan 7 Task 2).
 *
 * DHIS2 re-reads a group's whole collection on every collection write, so the
 * cost of a bulk fix is dominated by how many times that re-read happens --
 * which is the number of batches, not the number of memberships. Measured
 * over 91,892 memberships on a 266,396-organisation-unit instance, writing
 * the same population at three batch sizes:
 *
 *   batch   elapsed   requests   rows fetched per object written
 *     250     823 s        369   397.5
 *    1000     192 s         93    56.1   <- the previous default
 *    5000      47 s         20    19.5
 *
 * So a bigger batch is better on both axes at once: four times faster than
 * the old default *and* 2.9x less work asked of the server per object. The
 * instinct that smaller batches are gentler on a shared instance is exactly
 * backwards here, and 250 is the measurement that retires it.
 *
 * 5000 is where the measurement stopped, not a proven optimum -- the trend
 * had not turned. It was not raised further because 5000 already meets
 * §6.1's ~60-second budget (47 s here, ~40 s at the 77,017 objects §6.1
 * states) and a larger payload buys correspondingly less.
 *
 * Full numbers, including why the metadata-import shape was measured, won on
 * every axis, and was still not adopted (its concurrency guard cannot be
 * built on 2.41-2.43 -- see
 * docs/developer/dhis2-behavior.md).
 */
export const DEFAULT_BATCH_SIZE = 5000

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
 * Builds one group's complete intended membership -- the current list plus
 * this change's additions, minus its deletions -- and sends it as a single
 * JSON Patch `replace` of the group's members collection (`PATCH
 * <endpoint.groups>/<groupId>`, `Content-Type: application/json-patch+json`,
 * a one-op body `[{op: 'replace', path: '/<endpoint.members>', value:
 * [...]}]`), the exact shape proven against live 2.40.12 and 2.41.10
 * instances (see
 * docs/developer/dhis2-behavior.md). Reports back as
 * exactly one `BatchOutcome`, so `WriteResult` cannot be told apart from the
 * batched route by a caller.
 *
 * This replaces a metadata-import shape (`POST /api/metadata`) this module
 * used until that note measured JSON Patch against it. The import shape
 * overwrote every owned property absent from its payload -- not a default
 * that could be changed: `mergeMode` was removed from the endpoint in 2.41
 * and backported to 2.38.7/2.39.6/2.40.4, so REPLACE was the only behaviour
 * available across this app's supported range -- which forced it to read
 * the group fresh with `fields=:owner,!<members>` immediately before every
 * write and spread the result back into the payload, just to avoid nulling
 * `description`, `color`, `symbol` and every other owned property the
 * payload didn't happen to repeat.
 *
 * A JSON Patch scoped to the members path cannot touch anything else by
 * construction: there is no payload to keep in sync with the group's other
 * properties, and therefore no pre-read needed to protect them -- the
 * hazard the import shape's `:owner` read compensated for does not exist
 * here at all, rather than being worked around. Plan 8 confirmed this holds
 * at the same 91,892-membership scale the import shape was measured at
 * (23.0s and 19.2s in 2 requests, against the import shape's 18.2s and
 * 20.3s at the same cluster; `description`/`color`/`symbol` preserved
 * through a full empty-then-refill on both 2.40.12 and 2.41.10) -- one
 * request cheaper than the import shape's real production path, which
 * needed the owner-field read on top of its own two requests.
 *
 * There is no analogue here of the import shape's "200 OK but the report
 * says ERROR" case, and that is measured rather than assumed. Every way
 * this patch can be refused was induced against live instances on all four
 * supported versions -- a well-formed id no object has, that same id mixed
 * among valid ones, a malformed id, and a user without the authority to
 * change the group -- and each answered 409 (or 403) with the group's
 * membership completely unchanged; duplicates in one payload dedupe
 * honestly. No case returned 2xx without the sent membership landing, so
 * `response.ok` really is the whole success signal here, the same
 * convention `setGroupSetProperties` (metadataWrites.ts) already uses for
 * this app's other JSON Patch call. See
 * docs/developer/dhis2-behavior.md.
 */
async function patchChange(
    fetcher: Fetcher,
    objectType: ObjectType,
    change: GroupChange,
    current: string[]
): Promise<{ outcome: BatchOutcome; ok: boolean }> {
    const endpoint = ENDPOINTS[objectType]
    const requested = change.additions.length + change.deletions.length

    const currentIds = new Set(current)
    const deletions = new Set(change.deletions)
    const intended = [
        ...current.filter((id) => !deletions.has(id)),
        ...change.additions.filter((id) => !currentIds.has(id)),
    ]
    try {
        const response = await fetcher(`${endpoint.groups}/${change.groupId}`, {
            method: 'PATCH',
            headers: {
                'Content-Type': 'application/json-patch+json',
            },
            body: JSON.stringify([
                {
                    op: 'replace',
                    path: `/${endpoint.members}`,
                    value: intended.map((id) => ({ id })),
                },
            ]),
        })
        if (!response.ok) {
            // A rejected members patch answers with an ObjectReport whose
            // `message` and `errorReports` say exactly what was wrong
            // ("Invalid reference [Zz9GhOsT000]", "You don't have the
            // proper permissions to update this object"). That is worth
            // far more than the bare status to anyone diagnosing a failed
            // write, but it is DHIS2's own English and `error` is spliced
            // into translated sentences, so it goes to `rawError` and the
            // console -- the same split the unparseable-body path above
            // already makes. Reading the body cannot itself fail the
            // write: the request already has.
            let rawMessage: string | undefined
            try {
                rawMessage = (await response.text()).slice(0, 500)
            } catch {
                rawMessage = undefined
            }
            if (rawMessage) {
                console.warn(
                    `writeMemberships: JSON Patch for group ${change.groupId} was rejected`,
                    rawMessage
                )
            }
            return {
                outcome: {
                    groupId: change.groupId,
                    requested,
                    accepted: 0,
                    error: `HTTP ${response.status}`,
                    rawError: rawMessage,
                },
                ok: false,
            }
        }
        return {
            outcome: {
                groupId: change.groupId,
                requested,
                accepted: requested,
            },
            ok: true,
        }
    } catch (error) {
        return {
            outcome: {
                groupId: change.groupId,
                requested,
                accepted: 0,
                error: error instanceof Error ? error.message : String(error),
            },
            ok: false,
        }
    }
}

/**
 * Writes membership changes to DHIS2. Per group, a change at or below
 * `batchSize` goes to the collection endpoint as one request per batch,
 * strictly sequential; a change above `batchSize` goes as a single JSON
 * Patch carrying that group's complete intended membership instead -- see
 * the routing note above `routesToPatch` inside this function, and spec
 * 2026-09-16 section 6.1. Both routes are sequential across groups and
 * batches alike -- a national fix can be a hundred thousand
 * memberships, and a burst of parallel requests against a shared production
 * instance is not neighbourly.
 *
 * The response to each request is reconciled against what was sent rather
 * than trusted at face value: DHIS2 returns 200 OK even when it silently
 * dropped an invalid id, so an HTTP status alone would report success for a
 * write that did not fully happen (see finding 2 in
 * docs/developer/dhis2-behavior.md). When a batch
 * comes back short, the response names nothing that would tell which ids
 * it kept, so the group is re-read for exactly that batch's ids
 * (`reconcileShortfall`): what the re-read finds in place is applied and
 * goes to History, and only the rest is unaccounted and offered for Retry.
 * If the re-read fails too, the whole batch is unaccounted -- never a
 * guessed subset.
 *
 * A failed batch is recorded and does not stop the remaining groups: being
 * able to fix nine groups out of ten is worth far more than failing all ten.
 * Only a 401 or 403 -- a permission rejection -- marks the group itself as a
 * lost cause and skips every remaining batch for it rather than sending
 * them: that is a property of the group, not of which slice of ids happened
 * to be in a given batch, so retrying it a hundred times against a
 * hundred-way split serves nobody. Each skipped batch still gets its own
 * `BatchOutcome` (carrying the same error) and is added to `unaccounted`, so
 * the totals the caller sees still add up to every batch that was going to
 * be attempted. Anything else that fails a batch -- a different non-2xx
 * status, or a thrown error such as a dropped connection -- is recorded
 * against that one batch only; the next batch for the same group still gets
 * its own attempt, because a transient failure says nothing about the
 * batches after it. This also does not apply to a partial (silent-drop)
 * shortfall on an otherwise-successful response, which stays batch-specific
 * and does not mark the group as failed either.
 *
 * A change list with nothing in it produces no batches at all, so
 * `onProgress` is never called -- a caller driving a progress display from
 * it has to settle that display itself rather than waiting on a callback
 * that will not come.
 */
/**
 * Options `writeMemberships` takes beyond the change list. `batchSize` is a
 * test seam: production always writes at `DEFAULT_BATCH_SIZE`, and
 * `useMembershipWrite.test.tsx` pins that the hook never passes one,
 * because `takesPatchRoute`'s default below is also what `BulkFixDialog`
 * decides its pre-write re-read with. Five tests use a batch size of one or
 * two so that a three-id change splits into batches an assertion can read.
 */
export interface WriteOptions {
    batchSize?: number
    completeMembers?: Map<string, string[]>
    /**
     * Called after each change's last request, except the very last
     * change's, with everything confirmed so far, and awaited before the
     * next change is written. `useMembershipWrite` saves its pending
     * History record here, so a write interrupted partway (a closed tab, a
     * lost connection) still leaves the groups it finished in History. A
     * rejection is ignored: progress reporting must never stop the write.
     */
    onChangeSettled?: (appliedSoFar: GroupChange[]) => Promise<void> | void
}

/**
 * Whether a group's change is large enough to take the JSON Patch route
 * (spec 2026-09-16 section 6.1). The one predicate both the writer below
 * and `BulkFixDialog`'s freshness check use, so the two cannot disagree
 * about where the threshold sits -- they used to be two copies that agreed
 * only because the hook between them passed the constant explicitly.
 */
export function takesPatchRoute(
    change: GroupChange,
    batchSize: number = DEFAULT_BATCH_SIZE
): boolean {
    return change.additions.length + change.deletions.length > batchSize
}

/**
 * What one batch request achieved: the outcome to report, and the parts of
 * the batch that are confirmed and unaccounted for. Either part may be
 * absent (empty), never both present and both empty for a non-empty batch.
 */
interface BatchResult {
    outcome: BatchOutcome
    confirmed?: GroupChange
    missing?: GroupChange
    /** Set for a 401/403, which writes off the group's remaining batches. */
    groupError?: string
}

/**
 * A batch whose stats did not add up to what was sent: DHIS2 dropped some
 * ids without saying which (typically an object deleted since the page
 * loaded). The group is re-read for exactly this batch's ids, so the
 * additions now present and the deletions now absent are recorded as
 * applied -- History can revert them -- and only the rest is left for
 * Retry. Returns undefined when the re-read itself fails, and the caller
 * then disowns the whole batch, as it did before the re-read existed.
 */
async function reconcileShortfall(
    fetcher: Fetcher,
    objectType: ObjectType,
    batch: GroupChange
): Promise<{ confirmed: GroupChange; missing: GroupChange } | undefined> {
    let present: Set<string>
    try {
        present = await readMembersAmong(fetcher, objectType, batch.groupId, [
            ...batch.additions,
            ...batch.deletions,
        ])
    } catch {
        return undefined
    }
    return {
        confirmed: {
            groupId: batch.groupId,
            additions: batch.additions.filter((id) => present.has(id)),
            deletions: batch.deletions.filter((id) => !present.has(id)),
        },
        missing: {
            groupId: batch.groupId,
            additions: batch.additions.filter((id) => !present.has(id)),
            deletions: batch.deletions.filter((id) => present.has(id)),
        },
    }
}

function sizeOf(change: GroupChange): number {
    return change.additions.length + change.deletions.length
}

async function writeBatch(
    fetcher: Fetcher,
    objectType: ObjectType,
    batch: GroupChange
): Promise<BatchResult> {
    const endpoint = ENDPOINTS[objectType]
    const requested = sizeOf(batch)
    const failed = (error: string, rawError?: string): BatchResult => ({
        outcome: {
            groupId: batch.groupId,
            requested,
            accepted: 0,
            error,
            ...(rawError === undefined ? {} : { rawError }),
        },
        missing: batch,
    })
    let response: Response
    try {
        response = await fetcher(
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
    } catch (error) {
        // A thrown error (a dropped connection, a network blip) is a
        // transient failure, not a permission rejection -- it does not
        // mark the group, so the next batch still gets its own attempt.
        return failed(error instanceof Error ? error.message : String(error))
    }
    if (!response.ok) {
        const error = `HTTP ${response.status}`
        // Only a permission rejection marks the whole group as a lost
        // cause; a transient failure (a 500, a rate limit) is exactly the
        // case where the next batch deserves its own attempt rather than
        // being written off with this one.
        const permission = response.status === 401 || response.status === 403
        return {
            ...failed(error),
            ...(permission ? { groupError: error } : {}),
        }
    }
    let body: ImportReportBody
    try {
        body = (await response.json()) as ImportReportBody
    } catch (parseError) {
        // The conclusion (this batch did not land) is the same as any
        // other failed request, but a JSON parser's own message
        // ("Unexpected token < in JSON at position 0") is not something a
        // user should ever see, and (this module has no `i18n.t`) not
        // something this module could translate into user-facing prose
        // even if it wanted to -- see `UNPARSEABLE_RESPONSE`'s doc
        // comment. The raw text is logged here for whoever is watching
        // the console, and also kept on `rawError` for a future caller (a
        // bug report, a persisted write log) that wants it.
        const rawMessage =
            parseError instanceof Error
                ? parseError.message
                : String(parseError)
        console.warn(
            `writeMemberships: batch for group ${batch.groupId} returned a response that could not be parsed as JSON`,
            rawMessage
        )
        return failed(UNPARSEABLE_RESPONSE, rawMessage)
    }
    const accepted = acceptedCount(body)
    if (accepted === requested) {
        return {
            outcome: { groupId: batch.groupId, requested, accepted },
            confirmed: batch,
        }
    }
    const reconciled = await reconcileShortfall(fetcher, objectType, batch)
    if (!reconciled) {
        return {
            outcome: { groupId: batch.groupId, requested, accepted },
            missing: batch,
        }
    }
    return {
        // What the re-read confirmed, not what the stats said: the stats
        // are the very thing that did not add up.
        outcome: {
            groupId: batch.groupId,
            requested,
            accepted: sizeOf(reconciled.confirmed),
        },
        confirmed: reconciled.confirmed,
        missing: reconciled.missing,
    }
}

export async function writeMemberships(
    fetcher: Fetcher,
    objectType: ObjectType,
    changes: GroupChange[],
    onProgress: (done: number, total: number) => void,
    {
        batchSize = DEFAULT_BATCH_SIZE,
        completeMembers,
        onChangeSettled,
    }: WriteOptions = {}
): Promise<WriteResult> {
    // Spec 2026-09-16 section 6.1. DHIS2 re-reads a group's whole collection
    // on every collection write, so the batched path costs roughly (requests
    // x collection size) while a JSON Patch replace costs one pass. The two
    // are equal at one request -- which is `batchSize` ids -- and the patch
    // wins beyond it. Below it, batched costs the same single re-read and
    // sends far fewer ids, so a small fix must never take the patch route.
    //
    // The `completeMembers` requirement is the safety property, not a
    // convenience: a JSON Patch replace overwrites the group's whole
    // collection, which is only sound when the membership it is built from
    // was just re-read (section 5). A caller that has not done that refresh
    // has no entry here and therefore cannot reach this route at all.
    const patchMembers = (change: GroupChange): string[] | undefined =>
        takesPatchRoute(change, batchSize)
            ? completeMembers?.get(change.groupId)
            : undefined

    // Each change is routed once, in the order given: a patch change
    // counts as one unit of `onProgress`'s total (the same as one batch),
    // and a batched change contributes the batches `splitChange` produces
    // for it (zero for a no-op change). `last` marks a change's final unit,
    // after which `onChangeSettled` runs.
    type Unit = { last: boolean } & (
        | { kind: 'patch'; change: GroupChange; members: string[] }
        | { kind: 'batch'; batch: GroupChange }
    )
    const units: Unit[] = changes.flatMap((change): Unit[] => {
        const members = patchMembers(change)
        if (members) {
            return [{ kind: 'patch', change, members, last: true }]
        }
        const batches = splitChange(change, batchSize)
        return batches.map((batch, i) => ({
            kind: 'batch',
            batch,
            last: i === batches.length - 1,
        }))
    })
    const total = units.length

    const outcomes: BatchOutcome[] = []
    const applied: GroupChange[] = []
    const unaccounted: GroupChange[] = []
    // A group whose first batch came back 401/403: every later batch for it
    // is skipped rather than retried, but still recorded (see the doc
    // comment above), keyed by groupId so a hundred-way split only ever
    // costs one real request. Any other failure is not added here. Not
    // consulted for a patch change, which is always a single request per
    // group and has no "remaining batches" to skip.
    const failedGroups = new Map<string, string>()

    const record = ({ outcome, confirmed, missing }: BatchResult) => {
        outcomes.push(outcome)
        if (confirmed && sizeOf(confirmed) > 0) {
            applied.push(confirmed)
        }
        if (missing && sizeOf(missing) > 0) {
            unaccounted.push(missing)
        }
    }

    let done = 0
    /* oxlint-disable no-await-in-loop -- one request at a time: a group's 401/403 skips its later batches, and onProgress counts in order */
    for (const unit of units) {
        if (unit.kind === 'patch') {
            const { outcome, ok } = await patchChange(
                fetcher,
                objectType,
                unit.change,
                unit.members
            )
            record(
                ok
                    ? { outcome, confirmed: unit.change }
                    : { outcome, missing: unit.change }
            )
        } else {
            const { batch } = unit
            const priorFailure = failedGroups.get(batch.groupId)
            if (priorFailure === undefined) {
                const result = await writeBatch(fetcher, objectType, batch)
                record(result)
                if (result.groupError !== undefined) {
                    failedGroups.set(batch.groupId, result.groupError)
                }
            } else {
                record({
                    outcome: {
                        groupId: batch.groupId,
                        requested: sizeOf(batch),
                        accepted: 0,
                        error: priorFailure,
                    },
                    missing: batch,
                })
            }
        }
        done += 1
        onProgress(done, total)
        if (unit.last && done < total && onChangeSettled) {
            try {
                await onChangeSettled([...applied])
            } catch {
                // Progress reporting must never stop the write itself.
            }
        }
    }
    /* oxlint-enable no-await-in-loop */

    return { outcomes, applied, unaccounted }
}
