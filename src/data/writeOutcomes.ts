import i18n from '@dhis2/d2-i18n'
import { BatchOutcome, UNPARSEABLE_RESPONSE } from './writes'
import { interpolate } from '@/utils/interpolate'

/**
 * Every other value `BatchOutcome.error` takes (`HTTP 403`, a caught
 * exception's `message`) is a locale-neutral token safe to splice into a
 * translated sentence as-is. `UNPARSEABLE_RESPONSE` is the one sentinel
 * value, standing in for a JSON parser's own English message -- writes.ts
 * has no `i18n.t` and could not translate it even if it tried, so this is
 * the one place that recognises the sentinel and produces the translated
 * sentence in its place, rather than ever letting the raw fragment reach
 * `outcomeText`'s `{error}` placeholder untranslated.
 */
function splitErrors(errors: string[]): {
    tokens: string[]
    anyUnreadable: boolean
} {
    return {
        tokens: errors.filter((e) => e !== UNPARSEABLE_RESPONSE),
        anyUnreadable: errors.some((e) => e === UNPARSEABLE_RESPONSE),
    }
}

/**
 * Shared between `BulkFixDialog` and `History`'s revert dialog: both apply
 * a `MembershipWriteResult` and must report it with the same honesty --
 * neither ever treats "the write resolved" as "the write succeeded" (see
 * `useMembershipWrite`'s own doc comment: it resolves rather than rejects
 * for a partial or failed write).
 */
export interface GroupOutcome {
    groupId: string
    requested: number
    accepted: number
    /** Every batch this group was split into, kept individually rather
     * than only summed -- see task 8 fix round 1's C1. */
    batches: BatchOutcome[]
}

/**
 * A group set's write can split one group across several batches. The
 * result panel reports per group, not per batch, so batches for the same
 * group are collected here -- but summed counts are for *display* only;
 * classification in `outcomeText` below works batch by batch, because
 * summing before classifying is exactly the bug task 8 fix round 1's C1
 * describes: an over-reporting batch (the server can report more than was
 * requested -- see `acceptedCount`'s doc comment in `writes.ts`) and a
 * short batch can cancel out in the sums while both sit in `unaccounted`.
 */
export function aggregateOutcomes(outcomes: BatchOutcome[]): GroupOutcome[] {
    const byGroup = new Map<string, GroupOutcome>()
    outcomes.forEach((o) => {
        const existing = byGroup.get(o.groupId) ?? {
            groupId: o.groupId,
            requested: 0,
            accepted: 0,
            batches: [],
        }
        existing.requested += o.requested
        existing.accepted += o.accepted
        existing.batches.push(o)
        byGroup.set(o.groupId, existing)
    })
    return Array.from(byGroup.values())
}

export type OutcomeTone = 'valid' | 'warning' | 'error'

/** A batch the server confirmed in full, with no error. */
function isFullyApplied(b: BatchOutcome): boolean {
    return !b.error && b.accepted === b.requested
}

/**
 * The three outcomes need distinct wording, and a partial acceptance must
 * never be called a success -- the writer refuses to guess which ids
 * landed. Classification is done batch by batch, never on the summed
 * counts: a group is `valid` only when EVERY one of its batches was
 * confirmed in full.
 *
 * A group split across batches where some were confirmed and some were not
 * is neither a clean success nor an outright failure -- part of its change
 * is real and permanent on the server, so it gets its own wording rather
 * than being folded into "failed". Only a group with zero confirmed
 * batches and at least one hard error is reported as failed; zero
 * confirmed batches with no error at all (a silent partial accept) is
 * reported as a partial acceptance.
 */
export function outcomeText(
    o: GroupOutcome,
    groupName: string
): { text: string; tone: OutcomeTone } {
    const fullyApplied = o.batches.filter(isFullyApplied)
    const notConfirmed = o.batches.filter((b) => !isFullyApplied(b))
    const errors = notConfirmed
        .map((b) => b.error)
        .filter((e): e is string => Boolean(e))

    if (notConfirmed.length === 0) {
        return {
            tone: 'valid',
            text: interpolate(i18n.t('All changes applied to {name}'), {
                name: groupName,
            }),
        }
    }

    if (fullyApplied.length > 0) {
        return {
            tone: 'warning',
            text: interpolate(
                i18n.t(
                    '{name} accepted {accepted} of {requested} changes -- some of its batches were confirmed and some were not, and the objects in the unconfirmed batches need to be re-read from the server'
                ),
                {
                    name: groupName,
                    accepted: o.accepted,
                    requested: o.requested,
                }
            ),
        }
    }

    if (errors.length > 0) {
        // Two whole sentences, chosen on the sentinel, rather than one
        // sentence with a translated clause interpolated into it: a clause
        // does not reorder with the rest of the sentence in most languages,
        // which is the same rule CLAUDE.md states for never joining
        // translated fragments. An `HTTP 403` or a caught exception's
        // message is a locale-neutral token and stays a {placeholder}; the
        // sentinel is not, so it gets its own sentence. A group whose
        // batches failed both ways gets both sentences.
        const { tokens, anyUnreadable } = splitErrors(errors)
        const sentences: string[] = []
        if (tokens.length > 0) {
            sentences.push(
                interpolate(
                    i18n.t(
                        '{name} failed with error {error} -- the affected objects need to be re-read from the server'
                    ),
                    { name: groupName, error: tokens.join('; ') }
                )
            )
        }
        if (anyUnreadable) {
            sentences.push(
                interpolate(
                    i18n.t(
                        '{name} failed because the server returned a response the app could not read -- the affected objects need to be re-read from the server'
                    ),
                    { name: groupName }
                )
            )
        }
        return { tone: 'error', text: sentences.join(' ') }
    }

    return {
        tone: 'warning',
        text: interpolate(
            i18n.t(
                '{name} accepted {accepted} of {requested} changes -- the affected objects need to be re-read from the server'
            ),
            { name: groupName, accepted: o.accepted, requested: o.requested }
        ),
    }
}

/**
 * A retry only ever resends the batches the previous write left
 * `unaccounted` -- a *subset* of the batches of the groups it names. So
 * merging must be done per batch, not per group (I1): every batch the
 * server already confirmed in full is real and permanent, and the panel
 * must never un-report it.
 *
 * Concretely: a group whose batch A was confirmed 500/500 and whose batch B
 * errored is retried for B alone. Replacing all of the group's outcomes
 * with the retry's would leave only B, so a retry that failed again would
 * render as "the group failed" and the 500 memberships that really are on
 * the server would vanish from the report. What is kept instead is every
 * confirmed batch of every group, plus the outcomes of any group the retry
 * did not report on at all; only the unconfirmed batches of the groups the
 * retry names are replaced by what it reports.
 */
export function mergeOutcomes(
    prev: BatchOutcome[],
    next: BatchOutcome[]
): BatchOutcome[] {
    const nextGroupIds = new Set(next.map((o) => o.groupId))
    const kept = prev.filter(
        (o) => !nextGroupIds.has(o.groupId) || isFullyApplied(o)
    )
    return [...kept, ...next]
}
