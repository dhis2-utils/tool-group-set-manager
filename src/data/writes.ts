import { ENDPOINTS } from './endpoints'
import { Fetcher } from './sources/DataSource'
import { GroupChange } from '@/engine/changeSet'
import { ObjectType } from '@/engine/types'

/**
 * The outcome of one batch request against one group. `requested` and
 * `accepted` are both counts of ids (additions plus deletions), not booleans,
 * because DHIS2 can accept some of a batch and drop the rest without saying
 * which -- see finding 2 in
 * docs/superpowers/notes/2026-09-plan2-write-api-findings.md. `accepted !==
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
 * built on 2.41-2.43 -- see 2026-09-plan7-lastupdated-guard.md):
 * docs/superpowers/notes/2026-09-plan7-write-shapes.md.
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
 * instances by `scripts/perf/json-patch-members.js` and measured in
 * docs/superpowers/notes/2026-09-plan8-json-patch.md. Reports back as
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
 * docs/superpowers/notes/2026-09-plan9-json-patch-rejection.md; reproduce
 * with scripts/probe/json-patch-rejection.js.
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
 * docs/superpowers/notes/2026-09-plan2-write-api-findings.md). When a batch
 * comes back short, the response names nothing that would let the caller
 * tell which ids it kept, so the whole batch is reported as unaccounted --
 * never a guessed subset -- and the caller must re-read that group from the
 * server rather than trust its own intent.
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

export async function writeMemberships(
    fetcher: Fetcher,
    objectType: ObjectType,
    changes: GroupChange[],
    onProgress: (done: number, total: number) => void,
    { batchSize = DEFAULT_BATCH_SIZE, completeMembers }: WriteOptions = {}
): Promise<WriteResult> {
    const endpoint = ENDPOINTS[objectType]

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
    const routesToPatch = (change: GroupChange): boolean =>
        takesPatchRoute(change, batchSize) &&
        completeMembers?.has(change.groupId) === true

    // Each change is routed once, in the order given: a patch change
    // counts as one unit of `onProgress`'s total (the same as one batch),
    // and a batched change contributes the batches `splitChange` produces
    // for it (zero for a no-op change).
    type Unit =
        | { kind: 'patch'; change: GroupChange }
        | { kind: 'batch'; batch: GroupChange }
    const units: Unit[] = changes.flatMap((change): Unit[] =>
        routesToPatch(change)
            ? [{ kind: 'patch', change }]
            : splitChange(change, batchSize).map((batch) => ({
                  kind: 'batch',
                  batch,
              }))
    )
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

    let done = 0
    for (const unit of units) {
        if (unit.kind === 'patch') {
            const { outcome, ok } = await patchChange(
                fetcher,
                objectType,
                unit.change,
                completeMembers!.get(unit.change.groupId)!
            )
            outcomes.push(outcome)
            ;(ok ? applied : unaccounted).push(unit.change)
            done += 1
            onProgress(done, total)
            continue
        }
        const batch = unit.batch
        const requested = batch.additions.length + batch.deletions.length
        const priorFailure = failedGroups.get(batch.groupId)
        if (priorFailure !== undefined) {
            outcomes.push({
                groupId: batch.groupId,
                requested,
                accepted: 0,
                error: priorFailure,
            })
            unaccounted.push(batch)
            done += 1
            onProgress(done, total)
            continue
        }
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
                const error = `HTTP ${response.status}`
                outcomes.push({
                    groupId: batch.groupId,
                    requested,
                    accepted: 0,
                    error,
                })
                unaccounted.push(batch)
                // Only a permission rejection marks the whole group as a
                // lost cause; a transient failure (a 500, a rate limit) is
                // exactly the case where the next batch deserves its own
                // attempt rather than being written off with this one.
                if (response.status === 401 || response.status === 403) {
                    failedGroups.set(batch.groupId, error)
                }
                continue
            }
            let body: ImportReportBody
            try {
                body = (await response.json()) as ImportReportBody
            } catch (parseError) {
                // The conclusion (this batch did not land) is the same as
                // any other failed request, but a JSON parser's own
                // message ("Unexpected token < in JSON at position 0") is
                // not something a user should ever see, and (this module
                // has no `i18n.t`) not something this module could
                // translate into user-facing prose even if it wanted to --
                // see `UNPARSEABLE_RESPONSE`'s doc comment. The raw text is
                // logged here for whoever is watching the console, and
                // also kept on `rawError` for a future caller (a bug
                // report, a persisted write log) that wants it.
                const rawMessage =
                    parseError instanceof Error
                        ? parseError.message
                        : String(parseError)
                console.warn(
                    `writeMemberships: batch for group ${batch.groupId} returned a response that could not be parsed as JSON`,
                    rawMessage
                )
                outcomes.push({
                    groupId: batch.groupId,
                    requested,
                    accepted: 0,
                    error: UNPARSEABLE_RESPONSE,
                    rawError: rawMessage,
                })
                unaccounted.push(batch)
                continue
            }
            const accepted = acceptedCount(body)
            outcomes.push({ groupId: batch.groupId, requested, accepted })
            if (accepted === requested) {
                applied.push(batch)
            } else {
                unaccounted.push(batch)
            }
        } catch (error) {
            // A thrown error (a dropped connection, a network blip) is a
            // transient failure, not a permission rejection -- it does not
            // mark the group, so the next batch still gets its own attempt.
            const message =
                error instanceof Error ? error.message : String(error)
            outcomes.push({
                groupId: batch.groupId,
                requested,
                accepted: 0,
                error: message,
            })
            unaccounted.push(batch)
        } finally {
            done += 1
            onProgress(done, total)
        }
    }

    return { outcomes, applied, unaccounted }
}
