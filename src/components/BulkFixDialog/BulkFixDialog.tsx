import { useConfig } from '@dhis2/app-runtime'
import i18n from '@dhis2/d2-i18n'
import {
    Button,
    ButtonStrip,
    CircularLoader,
    InputField,
    Modal,
    ModalActions,
    ModalContent,
    ModalTitle,
    NoticeBox,
    Radio,
    SingleSelectField,
    SingleSelectOption,
} from '@dhis2/ui'
import React, { useEffect, useMemo, useRef, useState } from 'react'
import styles from './BulkFixDialog.module.css'
import {
    afterIdsPrepared,
    PreparedChange,
    prepareChanges,
    ChangeSetPreview,
    ChangeSetPreviewObjects,
    PreviewRow,
} from '@/components/ChangeSetPreview/ChangeSetPreview'
import { toCsv } from '@/data/csv'
import { ENDPOINTS } from '@/data/endpoints'
import { createFetcher } from '@/data/fetcher'
import {
    createCatchAllGroup,
    generateCatchAllNames,
    NAME_OWNED_BY_ANOTHER_SET,
} from '@/data/metadataWrites'
import {
    aggregateOutcomes,
    mergeOutcomes,
    outcomeText,
} from '@/data/writeOutcomes'
import { BatchOutcome, DEFAULT_BATCH_SIZE } from '@/data/writes'
import { ChangeSet, GroupChange } from '@/engine/changeSet'
import { ObjectFilter } from '@/engine/queries'
import { AssignmentPlan, ObjectsResult, ScopeRef } from '@/engine/store'
import { GroupSetMeta, Status } from '@/engine/types'
import { useEngine } from '@/hooks/useEngine'
import { useEngineQuery } from '@/hooks/useEngineQuery'
import { useGsiConfig } from '@/hooks/useGsiConfig'
import {
    MembershipWriteResult,
    useMembershipWrite,
} from '@/hooks/useMembershipWrite'
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
     * only knew about locally (`createdGroup` above).
     */
    onApplied: (result: MembershipWriteResult) => void
}

type Action = 'moveToCatchAll' | 'assignAll'
type Step = 'action' | 'preview' | 'apply'

const SAMPLE_SIZE = 20
// M3: fetched larger than the displayed sample so rows the plan actually
// changes can be sorted to the front before slicing down to SAMPLE_SIZE --
// otherwise a page full of already-correct rows (no change at all) could
// fill the whole visible sample while the real changes sit further down.
const SAMPLE_FETCH_SIZE = 100
const CSV_PAGE_SIZE = 1000

/**
 * DHIS2's own cap on a group's `shortName`. Duplicated from
 * metadataWrites.ts deliberately: that module enforces it when generating a
 * name, this one when validating one the user typed, and the two checks
 * happen at different moments for different reasons. Exporting it from
 * there would read as though one check implied the other.
 */
const MAX_SHORT_NAME_LENGTH = 50

/** A group whose own name suggests it is the catch-all for its set. */
const CATCH_ALL_NAME_PATTERN = /other|unknown/i

/**
 * Spec 3.2/3.4's violations: missing from a set that requires membership
 * (at error or warning severity) or in conflict between two of its
 * groups. "Move to catch-all" is restricted to exactly this population
 * (see the Critical fix in task-7-fix1.md) -- an object with any other
 * status is, by definition, already correctly categorised, and moving it
 * would strip it out of the group it is correctly in.
 */
const VIOLATION_STATUSES = [
    Status.MissingError,
    Status.MissingWarning,
    Status.Conflict,
]

const objectsCountLabel = (count: number) =>
    count === 1
        ? i18n.t('1 object')
        : interpolate(i18n.t('{count} objects'), {
              count: count.toLocaleString(),
          })

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
        .slice()
        .sort()
    const after = afterIdsPrepared(row, groups, prepared).slice().sort()
    return now.length !== after.length || now.some((id, i) => id !== after[i])
}

/** Filesystem-unsafe characters a group set's own display name could contain. */
function safeFileName(name: string): string {
    return name.replace(/[\\/:*?"<>|]/g, '_')
}

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
    const [creating, setCreating] = useState(false)
    const [createError, setCreateError] = useState<string | null>(null)
    // Spec 5.2: the user names the catch-all group. Seeded with exactly what
    // the server would otherwise have generated (`generateCatchAllNames` is
    // the single source of that rule, shared with the data layer rather than
    // reimplemented here), and re-seeded if the dialog is pointed at a
    // different set, which would make the previous set's name wrong.
    const [catchAllNames, setCatchAllNames] = useState(() =>
        generateCatchAllNames(set)
    )
    useEffect(() => {
        setCatchAllNames(generateCatchAllNames(set))
    }, [set])
    const [csvBusy, setCsvBusy] = useState(false)
    const [csvError, setCsvError] = useState<string | null>(null)
    // A group `createCatchAllGroup` just created is not yet part of
    // `set.groups` -- that prop only updates when the parent reloads the
    // engine's group sets, which this dialog does not do for itself. Held
    // here so the target SingleSelect has an option for it immediately
    // (@dhis2/ui's SingleSelect throws if `selected` names no option at
    // all), rather than waiting on a reload this dialog does not trigger.
    //
    // M6 caveats carried forward for the task that adds Apply: (1) the
    // reload must actually happen once Apply confirms the write, or this
    // locally-tracked option is all this dialog will ever show, even after
    // the group is genuinely part of `set.groups` server-side; (2)
    // `createdGroup` has no `canWrite` of its own -- the engine's own
    // `GroupMeta` for it (once loaded) is the only authority a plan can
    // trust for whether it is writable.
    const [createdGroup, setCreatedGroup] = useState<{
        id: string
        displayName: string
    } | null>(null)

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
    // is true only while the import-route groups are being re-read and the
    // plan recomputed -- never for the common case where nothing crosses the
    // import threshold, which writes straight through with none of this ever
    // touched. `recheck` holds the previewed count and the recomputed plan
    // once the two disagree, so the re-confirmation can show both and apply
    // the recomputed one specifically, never the stale preview. `planOverride`
    // is what makes "Review changes" carry the recomputed plan back to the
    // preview step (spec 5.3) without every other reader of `plan` below (the
    // sample, the CSV export, the summary line) needing its own copy of that
    // logic -- it is cleared whenever the user leaves the preview step, so a
    // later, unrelated preview can never be shadowed by a stale recompute.
    const [checkingFreshness, setCheckingFreshness] = useState(false)
    const [recheck, setRecheck] = useState<{
        previewed: number
        recomputed: AssignmentPlan
        completeMembers: Map<string, string[]>
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

    // I7: the new group's id changes the set, and per the cache contract
    // (CLAUDE.md 4.4) the IndexedDB snapshot is only reused when the group
    // ids match the server -- so a non-forced reload here is guaranteed to
    // re-fetch rather than serve the stale snapshot that lacks the new
    // group. Without this, `planAssignment` throws "Unknown target group"
    // the moment the dialog tries to plan against a group it only knows
    // about locally (`createdGroup`), and the app's headline remedy --
    // create a catch-all, then bulk-move into it -- dead-ends in the same
    // session it was created. `createdGroup` stays as the belt-and-braces
    // path for a reload that itself fails.
    // Validated here rather than only on the server: both are required, and
    // DHIS2 caps shortName at 50 characters. Catching it before the request
    // turns a 409/400 whose body this module would have to translate into a
    // field the user can see is wrong while they are still typing.
    const trimmedNames = {
        displayName: catchAllNames.displayName.trim(),
        shortName: catchAllNames.shortName.trim(),
    }
    const nameTooLong = trimmedNames.shortName.length > MAX_SHORT_NAME_LENGTH
    const namesValid =
        trimmedNames.displayName.length > 0 &&
        trimmedNames.shortName.length > 0 &&
        !nameTooLong

    const handleCreateCatchAll = async () => {
        if (!namesValid) {
            return
        }
        setCreating(true)
        setCreateError(null)
        try {
            const created = await createCatchAllGroup(fetcher, set, trimmedNames)
            setCreatedGroup(created)
            setTargetTouched(true)
            setTargetGroupId(created.id)
            await reload(false)
        } catch (e) {
            const message = e instanceof Error ? e.message : String(e)
            // The data layer has no i18n.t and must not build user-facing
            // prose, so it throws a locale-neutral sentinel (the same
            // convention writes.ts's UNPARSEABLE_RESPONSE uses) and this is
            // where it becomes a sentence.
            setCreateError(
                message === NAME_OWNED_BY_ANOTHER_SET
                    ? i18n.t(
                          'A group with this name already belongs to a different group set. Choose another name — one group must not be shared between two sets.'
                      )
                    : message
            )
        } finally {
            setCreating(false)
        }
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
            const csv = toCsv(rows)
            const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' })
            const url = URL.createObjectURL(blob)
            const link = document.createElement('a')
            link.href = url
            link.download = `${safeFileName(set.displayName)}.csv`
            document.body.appendChild(link)
            link.click()
            document.body.removeChild(link)
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
    // `targetOptions` already builds -- a freshly created catch-all group
    // is not yet part of `set.groups` (see the comment on `createdGroup`
    // above), so without this a result naming it renders the raw UID.
    const allGroups = [
        ...set.groups,
        ...(createdGroup && !set.groups.some((g) => g.id === createdGroup.id)
            ? [createdGroup]
            : []),
    ]

    /**
     * A group change large enough to take the import route (spec 6.1) --
     * shared between the synchronous pre-check in `handleApply` (which
     * decides whether to touch any of this machinery at all) and
     * `readImportRouteGroups` below (which decides which ids to re-read),
     * so the two can never disagree about where the threshold sits.
     */
    const takesImportRoute = (c: GroupChange): boolean =>
        c.additions.length + c.deletions.length > DEFAULT_BATCH_SIZE

    /**
     * The membership of the groups this plan will write by metadata import,
     * read fresh from the server.
     *
     * Only those groups. An import replaces a group's whole collection, so a
     * member someone else added since our snapshot is absent from the list we
     * send and is silently dropped -- that is the hazard this read exists to
     * remove. A batched delta touches only the ids it names and cannot do it,
     * so re-reading a group about to receive a delta buys no safety and costs
     * 1-2s (docs/superpowers/notes/2026-09-plan8-reread-cost.md).
     *
     * Returns an empty map when nothing crosses the threshold, which is the
     * common case -- though by the time `handleApply` calls this, it has
     * already checked that with `takesImportRoute` itself (see the fix
     * round 1 note there on why that check has to happen before this
     * function is even called, not just inside it).
     */
    const readImportRouteGroups = async (
        planChanges: GroupChange[]
    ): Promise<Map<string, string[]>> => {
        const endpoint = ENDPOINTS[set.objectType]
        const ids = planChanges
            .filter(takesImportRoute)
            .map((c) => c.groupId)
        if (ids.length === 0) {
            return new Map()
        }
        const entries = await Promise.all(
            ids.map(async (groupId) => {
                const response = await fetcher(
                    `${endpoint.groups}/${groupId}/${endpoint.members}?fields=id&paging=false`,
                    { cache: 'no-store' }
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

    // D5, extended by Task 9: the plan the preview rendered is the plan
    // applied -- `plan.changes` is read once here and never recomputed from
    // `useEngineQuery`'s own copy, so a background requery can never smuggle
    // in something other than what was shown. Task 9 adds one exception, and
    // only one: when a group in that plan is large enough to take the import
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
    }

    const handleApply = async () => {
        // Fix round 1, finding 1: this guard has to be a ref, not just the
        // `checkingFreshness` state below -- two clicks fired back to back,
        // in the same synchronous burst, both close over the render that
        // was current when the *first* click started, so a state check
        // alone would let the second one through before React ever
        // re-renders the disabled button. The ref is written synchronously,
        // before this function's first `await`, so the second call sees it
        // immediately.
        if (!plan || checkInFlightRef.current) {
            return
        }
        setApplyError(null)
        setCheckError(null)
        // Synchronous by construction (spec 5.1's own scoping rule): whether
        // any group in this plan takes the import route is knowable from
        // the plan already in hand, with no read of anything. Deciding it
        // here, before `checkingFreshness` is ever touched, is what keeps
        // the common case (no group crosses the threshold) genuinely inert
        // -- no field read, no progress message, nothing to race.
        const needsCheck = plan.changes.some(takesImportRoute)
        if (!needsCheck) {
            performWrite(plan.changes)
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
            return
        }
        // Fix round 1, finding 1: set *before* the read starts, not after
        // it resolves -- the read is the only slow part (1-2s per group),
        // and Cancel/Back/Apply/the modal's own close affordance all read
        // this flag. Setting it after the `await` left a real window where
        // all four were still enabled through the entire read.
        checkInFlightRef.current = true
        setCheckingFreshness(true)
        try {
            const completeMembers = await readImportRouteGroups(plan.changes)
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
            const unchanged =
                recomputed.affected === plan.affected &&
                JSON.stringify(recomputed.changes) ===
                    JSON.stringify(plan.changes)
            if (unchanged) {
                performWrite(recomputed.changes, completeMembers)
            } else {
                setRecheck({
                    previewed: plan.affected,
                    recomputed,
                    completeMembers,
                })
            }
        } catch (e) {
            // Fix round 1, finding 2: the check itself failed -- nothing
            // was written (nothing above this line ever calls
            // `performWrite`), so this must never be confused with
            // `applyError`, which specifically means the opposite: a write
            // that did happen but could not be confirmed.
            setCheckError(e instanceof Error ? e.message : String(e))
        } finally {
            setCheckingFreshness(false)
            checkInFlightRef.current = false
        }
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

    const targetOptions = allGroups.map((g) => (
        <SingleSelectOption key={g.id} value={g.id} label={g.displayName} />
    ))

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
                    <div className={styles.actionOptions}>
                        {!configLoaded && <CircularLoader small />}
                        <Radio
                            label={i18n.t('Move to catch-all group')}
                            checked={action === 'moveToCatchAll'}
                            onChange={() => handleAction('moveToCatchAll')}
                        />
                        <Radio
                            label={i18n.t('Assign all to one group')}
                            checked={action === 'assignAll'}
                            onChange={() => handleAction('assignAll')}
                        />
                        <div className={styles.targetRow}>
                            <SingleSelectField
                                label={
                                    action === 'moveToCatchAll'
                                        ? i18n.t('Catch-all group')
                                        : i18n.t('Target group')
                                }
                                selected={targetGroupId}
                                placeholder={i18n.t('Choose target group')}
                                onChange={({ selected }) => {
                                    setTargetTouched(true)
                                    setTargetGroupId(selected ?? '')
                                }}
                            >
                                {targetOptions}
                            </SingleSelectField>
                        </div>
                        {showCreateOffer && (
                            <div className={styles.createCatchAll}>
                                {/* Spec 5.2: the user names the group rather
                                    than accepting a generated name they
                                    cannot see until it exists. Prefilled
                                    with exactly what would have been
                                    generated, so leaving both alone is the
                                    old behaviour. */}
                                <InputField
                                    dense
                                    // `name` is what @dhis2/ui uses as the
                                    // input's id and the label's `for`, so
                                    // without it the label names nothing --
                                    // a screen reader announces an unlabelled
                                    // text box.
                                    name="catchAllDisplayName"
                                    label={i18n.t('Group name')}
                                    value={catchAllNames.displayName}
                                    onChange={({ value }) =>
                                        setCatchAllNames((n) => ({
                                            ...n,
                                            displayName: value ?? '',
                                        }))
                                    }
                                />
                                <InputField
                                    dense
                                    name="catchAllShortName"
                                    label={i18n.t('Short name')}
                                    value={catchAllNames.shortName}
                                    error={nameTooLong}
                                    validationText={
                                        nameTooLong
                                            ? i18n.t(
                                                  'A short name can be at most 50 characters'
                                              )
                                            : undefined
                                    }
                                    onChange={({ value }) =>
                                        setCatchAllNames((n) => ({
                                            ...n,
                                            shortName: value ?? '',
                                        }))
                                    }
                                />
                                <Button
                                    small
                                    disabled={creating || !namesValid}
                                    onClick={handleCreateCatchAll}
                                >
                                    {creating
                                        ? i18n.t('Creating…')
                                        : i18n.t('Create group')}
                                </Button>
                            </div>
                        )}
                        {createError && (
                            <NoticeBox
                                error
                                title={i18n.t('Could not create the group')}
                            >
                                {createError}
                            </NoticeBox>
                        )}
                    </div>
                )}
                {step === 'preview' && (
                    <div>
                        {planLoading && <CircularLoader small />}
                        {planError && <NoticeBox error>{planError}</NoticeBox>}
                        {/* Task 9 (spec 5.1/5.4): shown only for a plan with
                            at least one group taking the import route --
                            the common case (every group batched) never sets
                            `checkingFreshness` at all. */}
                        {checkingFreshness && (
                            <div className={styles.progressRow}>
                                <CircularLoader small />
                                <span>
                                    {i18n.t(
                                        'Checking the metadata is up to date…'
                                    )}
                                </span>
                            </div>
                        )}
                        {/* Fix round 1, finding 2: the check itself failed
                            (or, finding 3, there was no engine client to run
                            it against) -- distinct from `applyError` below,
                            which only ever renders on the apply step and
                            means the opposite (a write happened but could
                            not be confirmed). Nothing was written here. */}
                        {checkError && !checkingFreshness && (
                            <NoticeBox
                                error
                                title={i18n.t(
                                    'The metadata could not be checked'
                                )}
                            >
                                {i18n.t(
                                    'Reading the latest metadata before applying failed, so nothing was written — try Apply again'
                                )}
                            </NoticeBox>
                        )}
                        {/* Task 9 (spec 5.3): the recomputed plan disagreed
                            with the one just previewed -- rendered in place
                            of the checking indicator above, never together
                            with it. */}
                        {recheck && !checkingFreshness && (
                            <NoticeBox
                                warning
                                title={i18n.t(
                                    'The metadata changed while you were reviewing'
                                )}
                            >
                                <p>
                                    {i18n.t(
                                        'Someone else has changed this group set since the preview was calculated. The plan below has been recalculated against the current metadata — check it before applying.'
                                    )}
                                </p>
                                <p className={styles.recheckCounts}>
                                    <span>
                                        {i18n.t('Previewed')}:{' '}
                                        <s>
                                            {recheck.previewed.toLocaleString()}
                                        </s>
                                    </span>
                                    <span>
                                        {i18n.t('Will now change')}:{' '}
                                        {recheck.recomputed.affected.toLocaleString()}
                                    </span>
                                </p>
                            </NoticeBox>
                        )}
                        {plan && (
                            <>
                                {action === 'moveToCatchAll' && (
                                    <NoticeBox>
                                        {/* m3 (final review): status, level,
                                            group and ancestor filters are
                                            visible as dropdown selections on
                                            the Objects tab this dialog was
                                            opened from, so "whatever filter
                                            this was opened with" is a fair
                                            summary of those. A text search
                                            is not visible anywhere in this
                                            dialog, so a search term in play
                                            is named explicitly rather than
                                            folded into that same phrase --
                                            nothing is written wrong either
                                            way (the preview below enumerates
                                            every affected object), but the
                                            generic wording read as though no
                                            search was narrowing the
                                            population. */}
                                        {filter.text
                                            ? interpolate(
                                                  i18n.t(
                                                      'Only objects missing from this set or in conflict are moved here -- correctly assigned objects are left alone, among objects matching the search term {term}'
                                                  ),
                                                  { term: filter.text }
                                              )
                                            : i18n.t(
                                                  'Only objects missing from this set or in conflict are moved here -- correctly assigned objects are left alone, whatever filter this was opened with'
                                              )}
                                    </NoticeBox>
                                )}
                                {/* I1: the headline is what the plan will
                                    actually write, never a second count of
                                    the population -- that number can be
                                    larger (skipped or already-correct
                                    objects contribute nothing to it), so it
                                    is shown only as separate context. */}
                                <p className={styles.summary}>
                                    {objectsCountLabel(plan.affected)}
                                </p>
                                {previewObjects.total !== plan.affected && (
                                    <p className={styles.contextNote}>
                                        {interpolate(
                                            i18n.t(
                                                '{count} objects match this view'
                                            ),
                                            {
                                                count: previewObjects.total.toLocaleString(),
                                            }
                                        )}
                                    </p>
                                )}
                                <ChangeSetPreview
                                    changes={plan.changes}
                                    groups={set.groups}
                                    objects={previewObjects}
                                />
                                <ButtonStrip>
                                    <Button
                                        small
                                        loading={csvBusy}
                                        onClick={handleDownloadCsv}
                                    >
                                        {i18n.t('Download full list as CSV')}
                                    </Button>
                                </ButtonStrip>
                                {csvError && (
                                    <NoticeBox error>{csvError}</NoticeBox>
                                )}
                                <InputField
                                    label={i18n.t(
                                        'Note for History (optional)'
                                    )}
                                    value={note}
                                    onChange={({ value }) =>
                                        setNote(value ?? '')
                                    }
                                />
                            </>
                        )}
                    </div>
                )}
                {step === 'apply' && (
                    <div className={styles.applyStep}>
                        {isWriting && (
                            <div className={styles.progressRow}>
                                <CircularLoader small />
                                <span>
                                    {progress
                                        ? interpolate(
                                              i18n.t(
                                                  'Applied {done} of {total} batches'
                                              ),
                                              {
                                                  done: progress.done.toLocaleString(),
                                                  total: progress.total.toLocaleString(),
                                              }
                                          )
                                        : i18n.t('Applying changes…')}
                                </span>
                            </div>
                        )}
                        {writeResult && !isWriting && (
                            <div className={styles.resultPanel}>
                                {/* M1: an empty plan produces no batches at
                                    all (writeMemberships never calls
                                    onProgress for one either) -- without
                                    this, the panel would render nothing but
                                    a Close button and no explanation. */}
                                {mergedOutcomes.length === 0 && (
                                    <NoticeBox>
                                        {i18n.t('There was nothing to apply')}
                                    </NoticeBox>
                                )}
                                {aggregateOutcomes(mergedOutcomes).map((o) => {
                                    const groupName =
                                        allGroups.find(
                                            (g) => g.id === o.groupId
                                        )?.displayName ?? o.groupId
                                    const { text, tone } = outcomeText(
                                        o,
                                        groupName
                                    )
                                    return (
                                        <NoticeBox
                                            key={o.groupId}
                                            error={tone === 'error'}
                                            warning={tone === 'warning'}
                                            valid={tone === 'valid'}
                                        >
                                            {text}
                                        </NoticeBox>
                                    )
                                })}
                                {writeResult.engineError && (
                                    <NoticeBox
                                        warning
                                        title={i18n.t(
                                            'The view may be out of date'
                                        )}
                                    >
                                        {i18n.t(
                                            'The change was applied but the local view could not be refreshed; reload to see it'
                                        )}
                                    </NoticeBox>
                                )}
                                {writeResult.historyError && (
                                    <NoticeBox
                                        warning
                                        title={i18n.t(
                                            'Not recorded in History'
                                        )}
                                    >
                                        {i18n.t(
                                            'The change was applied but could not be recorded in History'
                                        )}
                                    </NoticeBox>
                                )}
                            </div>
                        )}
                        {/* I4: the write's own promise rejected -- the
                            server change may well be real (the rejection
                            comes from cache invalidation, which runs after
                            the server write in useMembershipWrite), so this
                            must never be silence. */}
                        {applyError && !isWriting && (
                            <NoticeBox
                                error
                                title={i18n.t(
                                    'The result could not be confirmed'
                                )}
                            >
                                {i18n.t(
                                    'The write may have reached the server, but this dialog could not confirm what happened to it -- reload and check History to see what changed'
                                )}
                            </NoticeBox>
                        )}
                    </div>
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
                    {/* Task 9 (spec 5.3): replaces Back/Apply… while the
                        recomputed plan disagrees with the preview -- "Review
                        changes" carries the recomputed plan back into the
                        preview above (`planOverride`), and "Apply {n}
                        changes" writes it directly, never a second recheck. */}
                    {step === 'preview' && recheck && (
                        <>
                            <Button
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
                                onClick={() => {
                                    if (!recheck) {
                                        return
                                    }
                                    performWrite(
                                        recheck.recomputed.changes,
                                        recheck.completeMembers
                                    )
                                }}
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
