import { useConfig } from '@dhis2/app-runtime'
import i18n from '@dhis2/d2-i18n'
import {
    Button,
    ButtonStrip,
    Modal,
    ModalActions,
    ModalContent,
    ModalTitle,
} from '@dhis2/ui'
import React, { useEffect, useMemo, useRef, useState } from 'react'
import { ActionStep } from './ActionStep'
import { ApplyStep } from './ApplyStep'
import type { Action, Step } from './constants'
import {
    CATCH_ALL_NAME_PATTERN,
    CHECK_TIMEOUT,
    CHECK_TIMEOUT_MS,
    CSV_PAGE_SIZE,
    SAMPLE_FETCH_SIZE,
    SAMPLE_SIZE,
    VIOLATION_STATUSES,
} from './constants'
import { PreviewStep } from './PreviewStep'
import { useCatchAllCreation } from './useCatchAllCreation'
import type {
    PreparedChange,
    ChangeSetPreviewObjects,
    PreviewRow,
} from '@/components/ChangeSetPreview/ChangeSetPreview'
import {
    afterIdsPrepared,
    prepareChanges,
} from '@/components/ChangeSetPreview/ChangeSetPreview'
import { toCsv } from '@/data/csv'
import { createFetcher } from '@/data/fetcher'
import { readGroupMembers } from '@/data/groupMembers'
import { mergeOutcomes } from '@/data/writeOutcomes'
import type { BatchOutcome } from '@/data/writes'
import { takesPatchRoute } from '@/data/writes'
import type { ChangeSet, GroupChange } from '@/engine/changeSet'
import { sameChanges } from '@/engine/changeSet'
import type { ObjectFilter } from '@/engine/queries'
import type { AssignmentPlan, ObjectsResult, ScopeRef } from '@/engine/store'
import type { GroupSetMeta } from '@/engine/types'
import { useEngine } from '@/hooks/useEngine'
import { useEngineQuery } from '@/hooks/useEngineQuery'
import { useGsiConfig } from '@/hooks/useGsiConfig'
import type { MembershipWriteResult } from '@/hooks/useMembershipWrite'
import { useMembershipWrite } from '@/hooks/useMembershipWrite'
import { interpolate } from '@/utils/interpolate'

interface Props {
    set: GroupSetMeta
    scope: ScopeRef
    filter: ObjectFilter
    /**
     * D1: an optional list of object ids. When absent, the population is
     * everything matching `scope`/`filter`. Kept optional so a later
     * per-row selection UI can feed this same dialog unchanged.
     */
    selection?: string[]
    onClose: () => void
    /**
     * Called after every apply and every retry with that write's own
     * result (D5) -- the caller's own view of the set (`set.groups` is a
     * prop this dialog cannot refresh on its own) should refresh from it,
     * since a "move to catch-all" apply can confirm a group this dialog
     * only knew about locally (`createdGroup`, tracked in
     * useCatchAllCreation.ts).
     */
    onApplied: (result: MembershipWriteResult) => void
}

/** Task 9: the re-confirmation button's own count-aware label. */
const applyChangesLabel = (count: number) =>
    count === 1
        ? i18n.t('Apply 1 change')
        : interpolate(i18n.t('Apply {count} changes'), {
              count: count.toLocaleString(),
          })

function namesOf(ids: string[], groups: GroupSetMeta['groups']): string {
    const names = ids
        .map((id) => groups.find((g) => g.id === id)?.displayName)
        .filter((n): n is string => Boolean(n))
    return names.length > 0 ? names.join(', ') : i18n.t('No group')
}

/**
 * A row whose After differs from its Now -- the plan actually changes it.
 * Takes already-prepared changes because its only caller runs it over a
 * whole page of rows: preparing inside would rebuild a Set per group for
 * every row, which is the quadratic shape I2 removed from the export.
 */
function rowIsChanged(
    row: PreviewRow,
    groups: GroupSetMeta['groups'],
    prepared: PreparedChange[]
): boolean {
    const now = row.groups
        .map((p) => groups[p]?.id)
        .filter((id): id is string => Boolean(id))
        .sort()
    const after = [...afterIdsPrepared(row, groups, prepared)].sort()
    return now.length !== after.length || now.some((id, i) => id !== after[i])
}

/** Filesystem-unsafe characters a group set's own display name could contain. */
function safeFileName(name: string): string {
    return name.replace(/[\\/:*?"<>|]/g, '_')
}

// oxlint-disable-next-line complexity -- predates the lint migration; splitting it is a refactor of its own, not part of adopting the linter
export const BulkFixDialog = ({
    set,
    scope,
    filter,
    selection,
    onClose,
    onApplied,
}: Props) => {
    const { baseUrl, apiVersion } = useConfig() as {
        baseUrl: string
        apiVersion: number
    }
    const fetcher = useMemo(
        () => createFetcher(baseUrl, apiVersion),
        [baseUrl, apiVersion]
    )
    const { client, reload } = useEngine()
    const { write, isWriting } = useMembershipWrite()

    const [step, setStep] = useState<Step>('action')
    const [action, setAction] = useState<Action>('moveToCatchAll')
    const [targetGroupId, setTargetGroupId] = useState('')
    // Tracks whether the user (or a completed create) has ever touched the
    // target, so the configuration/name-match preselection effect below
    // never overwrites a deliberate choice, and never fires again once the
    // set has one.
    const [targetTouched, setTargetTouched] = useState(false)
    const [configuredCatchAll, setConfiguredCatchAll] = useState<
        string | undefined
    >(undefined)
    const [configLoaded, setConfigLoaded] = useState(false)
    const [note, setNote] = useState('')
    const [csvBusy, setCsvBusy] = useState(false)
    const [csvError, setCsvError] = useState<string | null>(null)
    const catchAll = useCatchAllCreation({
        set,
        fetcher,
        reload,
        onCreated: (g) => {
            setTargetTouched(true)
            setTargetGroupId(g.id)
        },
    })

    // Apply step (D3/D4): `writeResult` is the latest write's outcome,
    // whether the original apply or a retry -- retrying replaces it rather
    // than appending, since a retry is itself just another write (D2) and
    // its outcome supersedes what it was retrying. `progress` is reset to
    // null at the start of every write so a stale count from a previous
    // attempt cannot be shown before the first onProgress call lands.
    const [progress, setProgress] = useState<{
        done: number
        total: number
    } | null>(null)
    const [writeResult, setWriteResult] =
        useState<MembershipWriteResult | null>(null)
    // I5: the panel's own record of every group reported on so far, merged
    // across the original apply and any retries -- `writeResult` alone only
    // ever holds the LATEST write's outcomes, which would silently drop an
    // earlier group's real result once a retry replaces it.
    const [mergedOutcomes, setMergedOutcomes] = useState<BatchOutcome[]>([])
    // I4: `write()` can reject (`invalidateType` runs uncaught, after the
    // server change has already happened -- see `useMembershipWrite`'s doc
    // comment) without this ever becoming a `writeResult`. Without this
    // state the apply step would render a blank panel: no progress, no
    // result, no error, with the write having genuinely reached the
    // server. Cleared at the start of every write so a stale error from a
    // previous attempt cannot linger over a fresh one.
    const [applyError, setApplyError] = useState<string | null>(null)

    // Task 9 (spec 5.1/5.4): the pre-write freshness check. `checkingFreshness`
    // is true only while the patch-route groups are being re-read and the
    // plan recomputed -- never for the common case where nothing crosses the
    // patch threshold, which writes straight through with none of this ever
    // touched. `recheck` holds the previewed count and the recomputed plan
    // once the two disagree, so the re-confirmation can show both. It does
    // NOT hold the membership that check read: the re-confirmation's own
    // Apply button re-runs the same check (fix round 2, finding 1) rather
    // than writing from a map read before the unbounded pause while the user
    // reads the notice, so there is nothing here for it to read stale.
    // `planOverride` is what makes "Review changes" carry the recomputed plan
    // back to the preview step (spec 5.3) without every other reader of
    // `plan` below (the sample, the CSV export, the summary line) needing its
    // own copy of that logic -- it is cleared by Back (the only way to leave
    // the preview step without either writing or re-previewing), so a later,
    // unrelated preview can never be shadowed by a stale recompute.
    const [checkingFreshness, setCheckingFreshness] = useState(false)
    const [recheck, setRecheck] = useState<{
        previewed: number
        recomputed: AssignmentPlan
    } | null>(null)
    const [planOverride, setPlanOverride] = useState<AssignmentPlan | null>(
        null
    )
    // Fix round 1, finding 2: the check itself (the re-read, or the
    // recompute) can fail before anything is written -- this is its own
    // error, distinct from `applyError` (which is specifically about a
    // write whose outcome could not be confirmed) and rendered on the
    // preview step rather than the apply step, since no write has happened
    // yet when this is set. The message stored here is diagnostic only,
    // same convention as `applyError` -- the rendered notice is a fixed,
    // translated sentence, never this raw text.
    const [checkError, setCheckError] = useState<string | null>(null)
    // Fix round 1, finding 1: a plain state flag is not enough to stop a
    // second click landing before React has re-rendered the disabled
    // button -- two synchronous clicks in the same tick both close over the
    // same pre-update `checkingFreshness`. A ref is mutated immediately, so
    // the second call sees it inside the very same synchronous burst that
    // started the first.
    const checkInFlightRef = useRef(false)
    // Carried forward from Plan 8: `checkingFreshness` disables Cancel, Back
    // and the modal's own close affordance, which is right while the check
    // is genuinely running but left the dialog unclosable if the check never
    // settled -- a hung request meant a page reload was the only way out.
    // Two refs give it an escape hatch. `checkAbortRef` stops the HTTP
    // re-read itself; `checkGenerationRef` is what makes abandoning one
    // safe at all, because `Promise.race` does not cancel the chain that
    // loses -- without it a timed-out check could still reach
    // `performWrite` afterwards and write a plan the user was never shown.
    const checkAbortRef = useRef<AbortController | null>(null)
    const checkGenerationRef = useRef(0)

    // If the dialog unmounts while a check is running, stop the read and
    // mark the check stale: its continuation would otherwise set state on
    // an unmounted component, and the request would keep the connection
    // open for an answer nobody can receive.
    useEffect(
        () => () => {
            checkGenerationRef.current++
            checkAbortRef.current?.abort()
        },
        []
    )

    const { config: gsiConfig, isLoaded: gsiConfigLoaded } = useGsiConfig()

    useEffect(() => {
        if (gsiConfigLoaded) {
            setConfiguredCatchAll(gsiConfig.catchAllGroup[set.id])
            setConfigLoaded(true)
        }
    }, [gsiConfigLoaded, gsiConfig, set.id])

    const nameMatchId = useMemo(
        () =>
            set.groups.find((g) => CATCH_ALL_NAME_PATTERN.test(g.displayName))
                ?.id,
        [set.groups]
    )

    // D5: configuration first, then a name match, then nothing -- and
    // "nothing" is an empty string, never a stale id, since @dhis2/ui's
    // SingleSelect throws when `selected` matches no option.
    const configuredIsValid =
        configuredCatchAll !== undefined &&
        set.groups.some((g) => g.id === configuredCatchAll)
    const catchAllCandidateId = configuredIsValid
        ? configuredCatchAll
        : nameMatchId

    useEffect(() => {
        if (!configLoaded || targetTouched || action !== 'moveToCatchAll') {
            return
        }
        setTargetGroupId(catchAllCandidateId ?? '')
    }, [configLoaded, catchAllCandidateId, targetTouched, action])

    // M7: one branch each, no redundant `setTargetTouched` call. Switching
    // to "move to catch-all" clears `targetTouched` so the effect above
    // re-applies the preselection; switching to "assign all" marks the
    // target touched (so that effect leaves it alone) and clears it back
    // to empty, since the catch-all's preselected target must not silently
    // carry over as the "assign all" target.
    const handleAction = (next: Action) => {
        setAction(next)
        if (next === 'assignAll') {
            setTargetTouched(true)
            setTargetGroupId('')
        } else {
            setTargetTouched(false)
        }
    }

    const handleTargetChange = (id: string) => {
        setTargetTouched(true)
        setTargetGroupId(id)
    }

    // Critical fix (task-7-fix1.md): "move to catch-all" must never
    // include a correctly categorised object, whatever filter or selection
    // the dialog was opened with -- `planAssignment` has no notion of
    // `Status` at all, so an unrestricted population handed to it while
    // moving to the catch-all would strip every already-correct object out
    // of its correct group. This is the one population definition used for
    // the plan, the sample and the CSV (I5): `ids` (new predicate, added to
    // `ObjectFilter`/`listObjects` for exactly this) carries a `selection`
    // through as the same population everywhere, and `statuses` is forced
    // to the violation set for "move to catch-all" regardless of what the
    // dialog was opened with. "Assign all to one group" is a deliberate
    // bulk re-categorisation the user chose, so it keeps the full,
    // unrestricted filter it was opened with.
    const populationFilter: ObjectFilter = useMemo(() => {
        const base: ObjectFilter = selection
            ? { ...filter, ids: selection }
            : filter
        return action === 'moveToCatchAll'
            ? { ...base, statuses: VIOLATION_STATUSES }
            : base
    }, [filter, selection, action])

    const previewEnabled = step === 'preview' && targetGroupId !== ''
    const {
        data: rawPlan,
        isLoading: planLoading,
        error: planError,
    } = useEngineQuery<AssignmentPlan>(
        'planAssignment',
        // Fix round 2: `planAssignment` no longer takes `selection` as a
        // separate argument that would bypass `populationFilter` -- a
        // selection is already folded into `populationFilter.ids` above,
        // so this is the one population definition, used here exactly as
        // it is for the sample and the CSV below.
        [set.id, scope, populationFilter, targetGroupId],
        previewEnabled
    )
    // Task 9: every reader below (`displaySample`, the CSV export, the
    // summary line, `handleApply` itself) reads `plan`, not `rawPlan` -- so
    // "Review changes" carrying the recomputed plan back to the preview step
    // (spec 5.3) is one assignment here, not a second copy of this logic at
    // every call site.
    const plan = planOverride ?? rawPlan

    // D4: the sample pages through the same `objectsFor` the Objects table
    // uses, now with `populationFilter` -- so a `selection` (via the new
    // `ids` predicate, I5) produces the same population here as it does
    // for the plan, rather than an empty sample.
    const { data: sampleResult } = useEngineQuery<ObjectsResult>(
        'objectsFor',
        [set.id, scope, populationFilter, 0, SAMPLE_FETCH_SIZE],
        previewEnabled
    )

    const displaySample = useMemo(() => {
        if (!sampleResult || !plan) {
            return []
        }
        const changed: PreviewRow[] = []
        const unchanged: PreviewRow[] = []
        const prepared = prepareChanges(plan.changes)
        sampleResult.items.forEach((row) => {
            ;(rowIsChanged(row, set.groups, prepared)
                ? changed
                : unchanged
            ).push(row)
        })
        return [...changed, ...unchanged].slice(0, SAMPLE_SIZE)
    }, [sampleResult, plan, set.groups])

    const skippedSample = useMemo(() => {
        if (!plan) {
            return []
        }
        return plan.skippedSample.map((id) => ({
            id,
            displayName:
                sampleResult?.items.find((r) => r.id === id)?.displayName ??
                null,
        }))
    }, [plan, sampleResult])

    const previewObjects: ChangeSetPreviewObjects = {
        total: sampleResult?.total ?? 0,
        sample: displaySample,
        skippedCount: plan?.skippedCount ?? 0,
        skippedSample,
    }

    const handleDownloadCsv = async () => {
        if (!client || !plan) {
            return
        }
        setCsvBusy(true)
        setCsvError(null)
        try {
            const rows: string[][] = [
                [
                    i18n.t('Object'),
                    i18n.t('Current groups'),
                    i18n.t('New group'),
                ],
            ]
            // I5: the same `populationFilter` the plan and the sample use,
            // so the CSV can never list a row the plan disagrees with.
            // I2: the After lookup is built once here, not per row -- see
            // `prepareChanges`.
            const prepared = prepareChanges(plan.changes)
            let offset = 0
            let total = Infinity
            /* oxlint-disable no-await-in-loop -- each page's total decides whether there is a next page */
            while (offset < total) {
                const page = await client.call<ObjectsResult>(
                    'objectsFor',
                    set.id,
                    scope,
                    populationFilter,
                    offset,
                    CSV_PAGE_SIZE
                )
                total = page.total
                page.items.forEach((item) => {
                    rows.push([
                        item.displayName ?? item.id,
                        namesOf(
                            item.groups
                                .map((p) => set.groups[p]?.id)
                                .filter((g): g is string => Boolean(g)),
                            set.groups
                        ),
                        namesOf(
                            afterIdsPrepared(item, set.groups, prepared),
                            set.groups
                        ),
                    ])
                })
                if (page.items.length === 0) {
                    break
                }
                offset += page.items.length
            }
            /* oxlint-enable no-await-in-loop */
            const csv = toCsv(rows)
            const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' })
            const url = URL.createObjectURL(blob)
            const link = document.createElement('a')
            link.href = url
            link.download = `${safeFileName(set.displayName)}.csv`
            document.body.appendChild(link)
            link.click()
            link.remove()
            URL.revokeObjectURL(url)
        } catch (e) {
            setCsvError(e instanceof Error ? e.message : String(e))
        } finally {
            setCsvBusy(false)
        }
    }

    const changeSetAction: ChangeSet['action'] =
        action === 'moveToCatchAll' ? 'move' : 'assign'

    // I6: the result panel's group-name lookup needs the same merged list
    // `targetOptions` (in ActionStep.tsx) already builds -- a freshly
    // created catch-all group is not yet part of `set.groups` (see the
    // comment on `createdGroup` in useCatchAllCreation.ts), so without
    // this a result naming it renders the raw UID.
    const allGroups = [
        ...set.groups,
        ...(catchAll.createdGroup &&
        !set.groups.some((g) => g.id === catchAll.createdGroup?.id)
            ? [catchAll.createdGroup]
            : []),
    ]

    /**
     * The membership of only the groups this plan will write by JSON Patch,
     * read fresh -- see `readGroupMembers` for why, and spec 5.1 for why
     * only those groups. Returns an empty map when nothing crosses the
     * threshold, which `runFreshnessCheck` has already ruled out before
     * calling this.
     */
    const readPatchRouteGroups = (
        planChanges: GroupChange[],
        signal?: AbortSignal
    ) =>
        readGroupMembers(
            fetcher,
            set.objectType,
            planChanges.filter((c) => takesPatchRoute(c)).map((c) => c.groupId),
            signal
        )

    // D5, extended by Task 9: the plan the preview rendered is the plan
    // applied -- `plan.changes` is read once here and never recomputed from
    // `useEngineQuery`'s own copy, so a background requery can never smuggle
    // in something other than what was shown. Task 9 adds one exception, and
    // only one: when a group in that plan is large enough to take the patch
    // route (spec 5.1), its membership is re-read from the server first, and
    // if that changes the plan, the recomputed one is what gets applied --
    // never the stale preview (spec 5.3).
    const performWrite = (
        changesToWrite: GroupChange[],
        completeMembers?: Map<string, string[]>
    ) => {
        setStep('apply')
        setProgress(null)
        setWriteResult(null)
        setMergedOutcomes([])
        setApplyError(null)
        write({
            set,
            changes: changesToWrite,
            action: changeSetAction,
            note,
            targetGroupId,
            completeMembers,
            onProgress: (done, total) => setProgress({ done, total }),
        })
            .then((result) => {
                setWriteResult(result)
                setMergedOutcomes(result.outcomes)
                onApplied(result)
            })
            .catch((e) => {
                // I4: the server write already happened by the time this
                // could reject (`invalidateType` runs after it, uncaught,
                // in `useMembershipWrite`) -- never render this as if
                // nothing happened.
                setApplyError(e instanceof Error ? e.message : String(e))
            })
            .finally(() => {
                // The in-flight guard covers check-then-write as one unit,
                // so it lifts when the write settles -- not when the check
                // did. Without this a sub-threshold apply would leave it
                // set forever and Back-then-Apply would silently do
                // nothing.
                checkInFlightRef.current = false
            })
    }

    /**
     * The freshness check itself (spec 5.1-5.3), against whichever plan is
     * the current reference point: the previewed `plan` the first time
     * through, or -- fix round 2, finding 1 -- the just-recomputed
     * `recheck.recomputed` when the user re-confirms. Both callers (
     * `handleApply` and `handleReconfirmApply`) *read* `checkInFlightRef`
     * before calling this, and this function *sets* it synchronously below,
     * before its first `await` and before any branch -- so the guard is in
     * place for the second of two clicks in one tick regardless of which
     * caller is running, and regardless of whether the plan needs a check
     * at all.
     *
     * The property this restores: a JSON Patch is never built from
     * membership read before an unbounded user pause. The re-confirmation's
     * Apply button used to write from a map read at the *start* of the
     * pause the user then took to read the notice; now it calls this again,
     * so the membership it writes is as fresh as the click that sends it,
     * not as stale as the click that preceded the pause. If the plan has
     * changed *again* by the time this resolves, re-confirming once more
     * with the newer numbers is correct -- it means someone is still
     * actively editing this set -- not a bug to work around.
     */
    const runFreshnessCheck = async (referencePlan: AssignmentPlan) => {
        setApplyError(null)
        setCheckError(null)
        // Before every branch below, including the sub-threshold one that
        // writes without checking anything. Set only on the check path, two
        // clicks in one synchronous tick both reached `performWrite` on a
        // plan that needed no check -- one user intent, two writes, two
        // History rows. Cleared by the `!client` bail below, by this
        // function's own `finally`, and when the write settles.
        checkInFlightRef.current = true
        // Synchronous by construction (spec 5.1's own scoping rule): whether
        // any group in this plan takes the patch route is knowable from
        // the plan already in hand, with no read of anything. Deciding it
        // here, before `checkingFreshness` is ever touched, is what keeps
        // the common case (no group crosses the threshold) genuinely inert
        // -- no field read, no progress message, nothing to race.
        const needsCheck = referencePlan.changes.some((c) => takesPatchRoute(c))
        if (!needsCheck) {
            performWrite(referencePlan.changes)
            return
        }
        if (!client) {
            // Fix round 1, finding 3: the same shape as `handleDownloadCsv`
            // above (`if (!client || !plan) return`) -- but that read-only
            // export can bail silently, while this dialog is about to
            // replace a group's whole collection, so the bail has to be
            // loud. Writing the stale plan here (the previous behaviour)
            // would apply decisions the user made against data that was
            // never re-verified, with no signal that the check never ran.
            setCheckError(i18n.t('The metadata could not be checked'))
            checkInFlightRef.current = false
            return
        }
        // Fix round 1, finding 1: set *before* the read starts, not after
        // it resolves -- the read is the only slow part (1-2s per group),
        // and Cancel/Back/Apply/the modal's own close affordance all read
        // this flag. Setting it after the `await` left a real window where
        // all four were still enabled through the entire read.
        setCheckingFreshness(true)
        const generation = ++checkGenerationRef.current
        const isCurrent = () => checkGenerationRef.current === generation
        const abort = new AbortController()
        checkAbortRef.current = abort
        let timer: ReturnType<typeof setTimeout> | undefined
        try {
            // The deadline covers the whole check, not just the fetch. The
            // re-read is only the first of three ways this can hang: both
            // `client.call`s below are worker round-trips with no timeout of
            // their own, and a terminated or wedged worker never answers, so
            // an AbortController on the HTTP request alone would leave two
            // of the three cases exactly as stuck as before.
            const deadline = new Promise<never>((_, reject) => {
                timer = setTimeout(() => {
                    abort.abort()
                    reject(new Error(CHECK_TIMEOUT))
                }, CHECK_TIMEOUT_MS)
            })
            const work = (async () => {
                const completeMembers = await readPatchRouteGroups(
                    referencePlan.changes,
                    abort.signal
                )
                await client.call(
                    'setGroupMembers',
                    set.objectType,
                    Array.from(completeMembers, ([groupId, memberIds]) => ({
                        groupId,
                        memberIds,
                    }))
                )
                const recomputed = await client.call<AssignmentPlan>(
                    'planAssignment',
                    set.id,
                    scope,
                    populationFilter,
                    targetGroupId
                )
                return { completeMembers, recomputed }
            })()
            // Once the deadline wins, `work` is still running and will
            // reject when its aborted fetch does. `Promise.race` stops
            // listening at that point, so without a handler of its own that
            // rejection surfaces as an unhandled promise rejection --
            // noise in the console at best, a failed test run at worst.
            // This handler only swallows it; the race still sees the
            // rejection through its own.
            work.catch(() => undefined)
            const { completeMembers, recomputed } = await Promise.race([
                work,
                deadline,
            ])
            // Not what stops a timed-out check from writing -- the
            // deadline's rejection does that on its own, by making
            // everything below unreachable for that invocation. This is
            // for the case the rejection cannot cover: the dialog
            // unmounting mid-check. The read and both engine calls carry
            // on regardless, and without this their continuation would
            // write, and set state, on behalf of a dialog that is no
            // longer on screen.
            if (!isCurrent()) {
                return
            }
            const unchanged =
                recomputed.affected === referencePlan.affected &&
                sameChanges(recomputed.changes, referencePlan.changes)
            if (unchanged) {
                performWrite(recomputed.changes, completeMembers)
            } else {
                setRecheck({
                    previewed: referencePlan.affected,
                    recomputed,
                })
            }
        } catch (e) {
            if (!isCurrent()) {
                return
            }
            // Fix round 1, finding 2: the check itself failed -- nothing
            // was written (nothing above this line ever calls
            // `performWrite`), so this must never be confused with
            // `applyError`, which specifically means the opposite: a write
            // that did happen but could not be confirmed.
            setCheckError(e instanceof Error ? e.message : String(e))
        } finally {
            if (timer !== undefined) {
                clearTimeout(timer)
            }
            if (isCurrent()) {
                checkAbortRef.current = null
                setCheckingFreshness(false)
                checkInFlightRef.current = false
            }
        }
    }

    const handleApply = async () => {
        // Fix round 1, finding 1: this guard has to be a ref, not just the
        // `checkingFreshness` state below -- two clicks fired back to back,
        // in the same synchronous burst, both close over the render that
        // was current when the *first* click started, so a state check
        // alone would let the second one through before React ever
        // re-renders the disabled button. The ref is written synchronously,
        // inside `runFreshnessCheck`, before that function's first `await`,
        // so the second call sees it immediately.
        if (!plan || checkInFlightRef.current) {
            return
        }
        await runFreshnessCheck(plan)
    }

    // Fix round 2, finding 1 (and, by sharing `runFreshnessCheck` and its
    // ref, finding 2): the re-confirmation's own Apply button. Re-runs the
    // full check against `recheck.recomputed` -- the plan the user just
    // confirmed -- rather than writing from membership read before this
    // button was even shown. Same in-flight guard as `handleApply`, for the
    // same reason: two clicks in one synchronous burst must produce one
    // check and one write, not two.
    const handleReconfirmApply = async () => {
        if (!recheck || checkInFlightRef.current) {
            return
        }
        await runFreshnessCheck(recheck.recomputed)
    }

    // D2: retry is built from the previous result's `unaccounted` batches,
    // never from the original plan -- it is a second, independent write and
    // gets its own change set.
    const handleRetry = () => {
        if (!writeResult || writeResult.unaccounted.length === 0) {
            return
        }
        setProgress(null)
        setApplyError(null)
        write({
            set,
            changes: writeResult.unaccounted,
            action: changeSetAction,
            note,
            targetGroupId,
            onProgress: (done, total) => setProgress({ done, total }),
        })
            .then((result) => {
                setWriteResult(result)
                // I5/I1: merge per batch -- every other group's earlier,
                // real outcome, and every batch of THIS group the server
                // already confirmed, must survive on the panel.
                setMergedOutcomes((prev) =>
                    mergeOutcomes(prev, result.outcomes)
                )
                onApplied(result)
            })
            .catch((e) => {
                setApplyError(e instanceof Error ? e.message : String(e))
            })
    }

    const showCreateOffer =
        configLoaded &&
        action === 'moveToCatchAll' &&
        !catchAllCandidateId &&
        targetGroupId === ''

    return (
        <Modal
            position="middle"
            onClose={isWriting || checkingFreshness ? () => undefined : onClose}
            large
        >
            <ModalTitle>
                {interpolate(i18n.t('Bulk fix {name}'), {
                    name: set.displayName,
                })}
            </ModalTitle>
            <ModalContent>
                {step === 'action' && (
                    <ActionStep
                        action={action}
                        onAction={handleAction}
                        configLoaded={configLoaded}
                        targetGroupId={targetGroupId}
                        onTargetChange={handleTargetChange}
                        targetGroups={allGroups}
                        showCreateOffer={showCreateOffer}
                        catchAll={catchAll}
                    />
                )}
                {step === 'preview' && (
                    <PreviewStep
                        action={action}
                        filterText={filter.text}
                        plan={plan}
                        planLoading={planLoading}
                        planError={planError}
                        checkingFreshness={checkingFreshness}
                        checkError={checkError}
                        recheck={recheck}
                        // Deliberately `set.groups`, not `allGroups`: a
                        // catch-all group created in this dialog session is
                        // not part of it yet, so a preview naming that
                        // group renders its raw UID rather than its name.
                        // Do not "fix" this to `allGroups` -- ApplyStep
                        // gets that below because its result names a group
                        // that may already have been created by the time
                        // it renders; the preview never can.
                        groups={set.groups}
                        previewObjects={previewObjects}
                        csvBusy={csvBusy}
                        csvError={csvError}
                        onDownloadCsv={handleDownloadCsv}
                        note={note}
                        onNoteChange={setNote}
                    />
                )}
                {step === 'apply' && (
                    <ApplyStep
                        isWriting={isWriting}
                        progress={progress}
                        writeResult={writeResult}
                        mergedOutcomes={mergedOutcomes}
                        applyError={applyError}
                        // Deliberately `allGroups` (set.groups plus a
                        // just-created catch-all), not `set.groups` as
                        // PreviewStep gets above: by apply time the write
                        // may have created the catch-all group this result
                        // names, and this panel should show it by name, not
                        // as a raw UID. See I6 above.
                        groups={allGroups}
                    />
                )}
            </ModalContent>
            <ModalActions>
                <ButtonStrip>
                    {/* D4: while a write is in flight, Cancel is disabled
                        rather than removed -- it stays visible so the user
                        can see the dialog is still doing something, but
                        cannot dismiss it and lose the result. Once the
                        result panel is up, "Cancel" becomes the deliberate
                        dismissal the user makes to close it. */}
                    {step === 'apply' &&
                    !isWriting &&
                    (writeResult || applyError) ? (
                        <Button onClick={onClose}>{i18n.t('Close')}</Button>
                    ) : (
                        <Button
                            onClick={onClose}
                            disabled={isWriting || checkingFreshness}
                        >
                            {i18n.t('Cancel')}
                        </Button>
                    )}
                    {step === 'preview' && !isWriting && !recheck && (
                        <Button
                            disabled={checkingFreshness}
                            onClick={() => {
                                setStep('action')
                                setRecheck(null)
                                setPlanOverride(null)
                                setCheckError(null)
                            }}
                        >
                            {i18n.t('Back')}
                        </Button>
                    )}
                    {step === 'action' && (
                        <Button
                            primary
                            disabled={targetGroupId === ''}
                            onClick={() => setStep('preview')}
                        >
                            {i18n.t('Next')}
                        </Button>
                    )}
                    {step === 'preview' && !recheck && (
                        <Button
                            primary
                            disabled={!plan || checkingFreshness}
                            onClick={handleApply}
                        >
                            {i18n.t('Apply…')}
                        </Button>
                    )}
                    {/* Task 9 (spec 5.3), fix round 2 finding 1: replaces
                        Back/Apply… while the recomputed plan disagrees with
                        the preview -- "Review changes" carries the recomputed
                        plan back into the preview above (`planOverride`), and
                        "Apply {n} changes" re-runs the freshness check
                        against that same recomputed plan (`handleReconfirmApply`)
                        rather than writing it as-is, since it was confirmed
                        an unbounded user pause ago. Both disabled while that
                        re-run is in flight, same as the first Apply below. */}
                    {step === 'preview' && recheck && (
                        <>
                            <Button
                                disabled={checkingFreshness}
                                onClick={() => {
                                    if (!recheck) {
                                        return
                                    }
                                    setPlanOverride(recheck.recomputed)
                                    setRecheck(null)
                                }}
                            >
                                {i18n.t('Review changes')}
                            </Button>
                            <Button
                                primary
                                disabled={checkingFreshness}
                                onClick={handleReconfirmApply}
                            >
                                {applyChangesLabel(recheck.recomputed.affected)}
                            </Button>
                        </>
                    )}
                    {step === 'apply' &&
                        writeResult &&
                        !isWriting &&
                        writeResult.unaccounted.length > 0 && (
                            <Button onClick={handleRetry}>
                                {i18n.t('Retry failed changes')}
                            </Button>
                        )}
                </ButtonStrip>
            </ModalActions>
        </Modal>
    )
}
