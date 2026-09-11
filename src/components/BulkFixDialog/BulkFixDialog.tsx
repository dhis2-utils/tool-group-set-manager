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
import React, { useEffect, useMemo, useState } from 'react'
import styles from './BulkFixDialog.module.css'
import {
    afterIds,
    ChangeSetPreview,
    ChangeSetPreviewObjects,
    PreviewRow,
} from '@/components/ChangeSetPreview/ChangeSetPreview'
import { toCsv } from '@/data/csv'
import { loadConfig } from '@/data/datastore'
import { createFetcher } from '@/data/fetcher'
import { createCatchAllGroup } from '@/data/metadataWrites'
import { ObjectFilter } from '@/engine/queries'
import { AssignmentPlan, ObjectsResult, ScopeRef } from '@/engine/store'
import { GroupSetMeta, Status } from '@/engine/types'
import { useEngine } from '@/hooks/useEngine'
import { useEngineQuery } from '@/hooks/useEngineQuery'
import { MembershipWriteResult } from '@/hooks/useMembershipWrite'
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
     * Not called by this task -- Apply (the next task) is the only step
     * that can produce a `MembershipWriteResult`. The prop exists now so
     * the dialog's shape does not change again when Apply is added.
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

function namesOf(ids: string[], groups: GroupSetMeta['groups']): string {
    const names = ids
        .map((id) => groups.find((g) => g.id === id)?.displayName)
        .filter((n): n is string => Boolean(n))
    return names.length > 0 ? names.join(', ') : i18n.t('No group')
}

/** A row whose After differs from its Now -- the plan actually changes it. */
function rowIsChanged(
    row: PreviewRow,
    groups: GroupSetMeta['groups'],
    changes: AssignmentPlan['changes']
): boolean {
    const now = row.groups
        .map((p) => groups[p]?.id)
        .filter((id): id is string => Boolean(id))
        .slice()
        .sort()
    const after = afterIds(row, groups, changes).slice().sort()
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
}: Props) => {
    const { baseUrl, apiVersion } = useConfig() as {
        baseUrl: string
        apiVersion: number
    }
    const fetcher = useMemo(
        () => createFetcher(baseUrl, apiVersion),
        [baseUrl, apiVersion]
    )
    const { client } = useEngine()

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

    useEffect(() => {
        let cancelled = false
        loadConfig(fetcher).then((config) => {
            if (!cancelled) {
                setConfiguredCatchAll(config.catchAllGroup[set.id])
                setConfigLoaded(true)
            }
        })
        return () => {
            cancelled = true
        }
    }, [fetcher, set.id])

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

    const handleCreateCatchAll = async () => {
        setCreating(true)
        setCreateError(null)
        try {
            const created = await createCatchAllGroup(fetcher, set)
            setCreatedGroup(created)
            setTargetTouched(true)
            setTargetGroupId(created.id)
        } catch (e) {
            setCreateError(e instanceof Error ? e.message : String(e))
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
        data: plan,
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
        sampleResult.items.forEach((row) => {
            ;(rowIsChanged(row, set.groups, plan.changes)
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
                            afterIds(item, set.groups, plan.changes),
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

    const targetOptions = [
        ...set.groups,
        ...(createdGroup && !set.groups.some((g) => g.id === createdGroup.id)
            ? [createdGroup]
            : []),
    ].map((g) => (
        <SingleSelectOption key={g.id} value={g.id} label={g.displayName} />
    ))

    const showCreateOffer =
        configLoaded &&
        action === 'moveToCatchAll' &&
        !catchAllCandidateId &&
        targetGroupId === ''

    return (
        <Modal position="middle" onClose={onClose} large>
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
                            <Button
                                small
                                disabled={creating}
                                onClick={handleCreateCatchAll}
                            >
                                {creating
                                    ? i18n.t('Creating…')
                                    : interpolate(
                                          i18n.t('Create Other/unknown {name}'),
                                          { name: set.displayName }
                                      )}
                            </Button>
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
                        {plan && (
                            <>
                                {action === 'moveToCatchAll' && (
                                    <NoticeBox>
                                        {i18n.t(
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
            </ModalContent>
            <ModalActions>
                <ButtonStrip>
                    <Button onClick={onClose}>{i18n.t('Cancel')}</Button>
                    {step === 'preview' && (
                        <Button onClick={() => setStep('action')}>
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
                    {step === 'preview' && (
                        <Button
                            primary
                            disabled
                            title={i18n.t('Not available yet')}
                        >
                            {i18n.t('Apply…')}
                        </Button>
                    )}
                </ButtonStrip>
            </ModalActions>
        </Modal>
    )
}
