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
    ChangeSetPreview,
    ChangeSetPreviewObjects,
} from '@/components/ChangeSetPreview/ChangeSetPreview'
import { toCsv } from '@/data/csv'
import { loadConfig } from '@/data/datastore'
import { createFetcher } from '@/data/fetcher'
import { createCatchAllGroup } from '@/data/metadataWrites'
import { ObjectFilter } from '@/engine/queries'
import { AssignmentPlan, ObjectsResult, ScopeRef } from '@/engine/store'
import { GroupSetMeta } from '@/engine/types'
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
const CSV_PAGE_SIZE = 1000

/** A group whose own name suggests it is the catch-all for its set. */
const CATCH_ALL_NAME_PATTERN = /other|unknown/i

const objectsCountLabel = (count: number) =>
    count === 1
        ? i18n.t('1 object')
        : interpolate(i18n.t('{count} objects'), {
              count: count.toLocaleString(),
          })

/**
 * The group ids a row (identified by its current group positions) would
 * end up in once `changes` is applied -- the same arithmetic
 * `ChangeSetPreview` uses for its After column, reused here so the CSV
 * export can never disagree with the preview or with what would be
 * written (D3).
 */
function afterGroupIds(
    row: { id: string; currentPositions: number[] },
    groups: GroupSetMeta['groups'],
    changes: AssignmentPlan['changes']
): string[] {
    const { id, currentPositions } = row
    const ids = new Set(
        currentPositions
            .map((p) => groups[p]?.id)
            .filter((g): g is string => Boolean(g))
    )
    changes.forEach((change) => {
        if (change.deletions.includes(id)) {
            ids.delete(change.groupId)
        }
        if (change.additions.includes(id)) {
            ids.add(change.groupId)
        }
    })
    return Array.from(ids)
}

function namesOf(ids: string[], groups: GroupSetMeta['groups']): string {
    const names = ids
        .map((id) => groups.find((g) => g.id === id)?.displayName)
        .filter((n): n is string => Boolean(n))
    return names.length > 0 ? names.join(', ') : i18n.t('No group')
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

    const handleAction = (next: Action) => {
        setAction(next)
        setTargetTouched(next === 'moveToCatchAll' ? targetTouched : true)
        setTargetGroupId(
            next === 'moveToCatchAll' ? (catchAllCandidateId ?? '') : ''
        )
        if (next === 'moveToCatchAll') {
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

    const previewEnabled = step === 'preview' && targetGroupId !== ''
    const {
        data: plan,
        isLoading: planLoading,
        error: planError,
    } = useEngineQuery<AssignmentPlan>(
        'planAssignment',
        [set.id, scope, filter, targetGroupId, selection],
        previewEnabled
    )

    // D4: the sample is simply the first page of the same population
    // `objectsFor` already pages for the Objects table. When a selection is
    // given there is no `ObjectFilter` that means "these exact ids", so the
    // sample (and the CSV export below) fall back to showing none rather
    // than a population that does not match the selection.
    const sampleEnabled = previewEnabled && !selection
    const { data: sampleResult } = useEngineQuery<ObjectsResult>(
        'objectsFor',
        [set.id, scope, filter, 0, SAMPLE_SIZE],
        sampleEnabled
    )

    const skippedRows = useMemo(() => {
        if (!plan) {
            return []
        }
        return plan.skipped.map((id) => ({
            id,
            displayName:
                sampleResult?.items.find((r) => r.id === id)?.displayName ??
                null,
        }))
    }, [plan, sampleResult])

    const previewObjects: ChangeSetPreviewObjects = {
        total: selection ? selection.length : (sampleResult?.total ?? 0),
        sample: selection ? [] : (sampleResult?.items ?? []),
        skipped: skippedRows,
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
            if (selection) {
                // No per-id resolution exists yet to look up a selected
                // object's current groups without shipping a national
                // population across the worker boundary; the row is still
                // listed, just with the current-groups column left blank.
                selection.forEach((id) => {
                    rows.push([id, '', namesOf([targetGroupId], set.groups)])
                })
            } else {
                let offset = 0
                let total = Infinity
                while (offset < total) {
                    const page = await client.call<ObjectsResult>(
                        'objectsFor',
                        set.id,
                        scope,
                        filter,
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
                                afterGroupIds(
                                    {
                                        id: item.id,
                                        currentPositions: item.groups,
                                    },
                                    set.groups,
                                    plan.changes
                                ),
                                set.groups
                            ),
                        ])
                    })
                    if (page.items.length === 0) {
                        break
                    }
                    offset += page.items.length
                }
            }
            const csv = toCsv(rows)
            const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' })
            const url = URL.createObjectURL(blob)
            const link = document.createElement('a')
            link.href = url
            link.download = `${set.displayName}.csv`
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
                {interpolate(i18n.t('Bulk fix: {name}'), {
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
                                <p className={styles.summary}>
                                    {objectsCountLabel(previewObjects.total)}
                                </p>
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
