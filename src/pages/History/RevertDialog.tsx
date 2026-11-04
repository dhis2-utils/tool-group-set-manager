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
} from '@dhis2/ui'
import React, { useEffect, useMemo, useRef, useState } from 'react'
import styles from './History.module.css'
import {
    missingGroupSetLabel,
    notRecordedLabel,
    revertWindowClosedLabel,
} from './labels'
import { CHECK_TIMEOUT_MS } from '@/components/BulkFixDialog/constants'
import type {
    ChangeSetPreviewObjects,
    PreviewRow,
} from '@/components/ChangeSetPreview/ChangeSetPreview'
import { ChangeSetPreview } from '@/components/ChangeSetPreview/ChangeSetPreview'
import { createFetcher } from '@/data/fetcher'
import { changeExpectations, findMembershipDrift } from '@/data/freshness'
import { canStillRevert } from '@/data/revertWindow'
import {
    aggregateOutcomes,
    mergeOutcomes,
    outcomeText,
} from '@/data/writeOutcomes'
import type { ChangeSet } from '@/engine/changeSet'
import type { EngineClient } from '@/engine/client'
import type { AssignmentPlan, ObjectsResult, ScopeRef } from '@/engine/store'
import type { GroupSetMeta } from '@/engine/types'
import { useEngine } from '@/hooks/useEngine'
import type { MembershipWriteResult } from '@/hooks/useMembershipWrite'
import { useMembershipWrite } from '@/hooks/useMembershipWrite'

const SAMPLE_SIZE = 20

interface Preview {
    plan: AssignmentPlan
    sample: PreviewRow[]
    skippedSample: { id: string; displayName: string | null }[]
}

/**
 * The revert plan (`planRevert`) for a change set, and the rows resolved to
 * show it. Run once when the dialog opens, and again only when the
 * pre-write check finds that the objects changed since (finding M1).
 */
async function computePreview(
    client: Pick<EngineClient, 'call'>,
    set: GroupSetMeta,
    changeSet: ChangeSet
): Promise<Preview> {
    const plan = await client.call<AssignmentPlan>(
        'planRevert',
        set.id,
        changeSet.changes
    )
    const scope: ScopeRef = { objectType: set.objectType, rootId: null }
    const touchedIds = [
        ...new Set(
            plan.changes.flatMap((c) => [...c.additions, ...c.deletions])
        ),
    ].slice(0, SAMPLE_SIZE)
    const none = Promise.resolve({ items: [] as ObjectsResult['items'] })
    const [sampleResult, skippedResult] = await Promise.all([
        touchedIds.length > 0
            ? client.call<ObjectsResult>(
                  'objectsFor',
                  set.id,
                  scope,
                  { ids: touchedIds },
                  0,
                  touchedIds.length
              )
            : none,
        plan.skippedSample.length > 0
            ? client.call<ObjectsResult>(
                  'objectsFor',
                  set.id,
                  scope,
                  { ids: plan.skippedSample },
                  0,
                  plan.skippedSample.length
              )
            : none,
    ])
    // M3: `plan.skippedSample` is the authority on which ids were skipped
    // -- `objectsFor` returns nothing for one that no longer exists, so the
    // display list maps over the ids themselves (falling back to no name,
    // which `ChangeSetPreview` renders as the raw id).
    const skippedNameById = new Map(
        skippedResult.items.map((item) => [item.id, item.displayName])
    )
    return {
        plan,
        sample: sampleResult.items.map((item) => ({
            id: item.id,
            displayName: item.displayName,
            groups: item.groups,
        })),
        skippedSample: plan.skippedSample.map((id) => ({
            id,
            displayName: skippedNameById.get(id) ?? null,
        })),
    }
}

/** Runs `work`, rejecting if it has not settled within the check deadline. */
async function withDeadline<T>(
    work: (signal: AbortSignal) => Promise<T>
): Promise<T> {
    const abort = new AbortController()
    let timer: ReturnType<typeof setTimeout> | undefined
    const deadline = new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
            abort.abort()
            reject(new Error('timeout'))
        }, CHECK_TIMEOUT_MS)
    })
    const running = work(abort.signal)
    running.catch(() => undefined)
    try {
        return await Promise.race([running, deadline])
    } finally {
        clearTimeout(timer)
    }
}

const WriteResultPanel = ({
    writeResult,
    mergedOutcomes,
    set,
}: {
    writeResult: MembershipWriteResult
    mergedOutcomes: MembershipWriteResult['outcomes']
    set: GroupSetMeta | undefined
}) => (
    <div className={styles.resultPanel}>
        {mergedOutcomes.length === 0 && (
            <NoticeBox>{i18n.t('There was nothing to apply')}</NoticeBox>
        )}
        {aggregateOutcomes(mergedOutcomes).map((o) => {
            const groupName =
                set?.groups.find((g) => g.id === o.groupId)?.displayName ??
                o.groupId
            const { text, tone } = outcomeText(o, groupName)
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
            <NoticeBox warning title={i18n.t('The view may be out of date')}>
                {i18n.t(
                    'The change was applied but the local view could not be refreshed; reload to see it'
                )}
            </NoticeBox>
        )}
        {writeResult.historyError && (
            <NoticeBox warning title={i18n.t('Not recorded in History')}>
                {notRecordedLabel()}
            </NoticeBox>
        )}
    </div>
)

const PreviewPanel = ({
    preview,
    set,
    note,
    onNoteChange,
}: {
    preview: Preview
    set: GroupSetMeta | undefined
    note: string
    onNoteChange: (note: string) => void
}) => {
    const { plan } = preview
    const objects: ChangeSetPreviewObjects = {
        total: plan.affected + plan.skippedCount,
        sample: preview.sample,
        skippedCount: plan.skippedCount,
        skippedSample: preview.skippedSample,
        // A revert skips for three different reasons, not just the
        // read-only one an assignment plan has; see ChangeSetPreview's
        // `skipReason`.
        skipReason: 'revert',
    }
    return (
        <>
            {plan.affected === 0 ? (
                <NoticeBox title={i18n.t('Nothing to revert')}>
                    {i18n.t(
                        'No object can be reverted. Each one has moved to another group since this change, or its group has left the set, or a group involved is read-only for you.'
                    )}
                </NoticeBox>
            ) : (
                <ChangeSetPreview
                    changes={plan.changes}
                    groups={set?.groups ?? []}
                    objects={objects}
                />
            )}
            <InputField
                // Without `name`, @dhis2/ui's label associates with no
                // control at all and a screen reader announces an
                // unlabelled text box.
                name="note"
                label={i18n.t('Note (optional)')}
                value={note}
                onChange={({ value }) => onNoteChange(value ?? '')}
            />
        </>
    )
}

const PreviewStepContent = ({
    setMissing,
    loadError,
    checking,
    checkFailed,
    changedSince,
    loading,
    preview,
    set,
    note,
    onNoteChange,
}: {
    setMissing: boolean
    loadError: string | null
    checking: boolean
    checkFailed: boolean
    changedSince: boolean
    loading: boolean
    preview: Preview | null
    set: GroupSetMeta | undefined
    note: string
    onNoteChange: (note: string) => void
}) => (
    <>
        {setMissing && (
            <NoticeBox error title={i18n.t('This change cannot be reverted')}>
                {missingGroupSetLabel()}
            </NoticeBox>
        )}
        {loadError && (
            <NoticeBox
                error
                title={i18n.t(
                    'Could not compute what this revert would change'
                )}
            >
                {loadError}
            </NoticeBox>
        )}
        {checking && (
            <div className={styles.progressRow}>
                <CircularLoader small />
                <span>{i18n.t('Checking the metadata is up to date…')}</span>
            </div>
        )}
        {checkFailed && (
            <NoticeBox
                error
                title={i18n.t('The metadata could not be checked')}
            >
                {i18n.t(
                    'Reading the latest metadata before reverting failed, so nothing was written — try Revert again'
                )}
            </NoticeBox>
        )}
        {changedSince && !checking && (
            <NoticeBox
                warning
                title={i18n.t('The metadata changed while you were reviewing')}
            >
                {i18n.t(
                    'Someone else has changed these objects since this page loaded. The revert below has been recalculated against the current metadata — check it before reverting.'
                )}
            </NoticeBox>
        )}
        {loading && <CircularLoader small />}
        {!loading && preview && (
            <PreviewPanel
                preview={preview}
                set={set}
                note={note}
                onNoteChange={onNoteChange}
            />
        )}
    </>
)

const ApplyStepContent = ({
    isWriting,
    writeResult,
    mergedOutcomes,
    applyError,
    set,
}: {
    isWriting: boolean
    writeResult: MembershipWriteResult | null
    mergedOutcomes: MembershipWriteResult['outcomes']
    applyError: string | null
    set: GroupSetMeta | undefined
}) => (
    <div>
        {isWriting && (
            <div className={styles.progressRow}>
                <CircularLoader small />
                <span>{i18n.t('Applying the revert…')}</span>
            </div>
        )}
        {writeResult && !isWriting && (
            <WriteResultPanel
                writeResult={writeResult}
                mergedOutcomes={mergedOutcomes}
                set={set}
            />
        )}
        {applyError && !isWriting && (
            <NoticeBox
                error
                title={i18n.t('The result could not be confirmed')}
            >
                {i18n.t(
                    'The write may have reached the server, but this dialog could not confirm what happened to it -- reload and check History to see what changed'
                )}
            </NoticeBox>
        )}
    </div>
)

interface RevertDialogProps {
    changeSet: ChangeSet
    onClose: () => void
    /** Called once a write has settled (however it went) so the list behind the dialog can pick up the new revert change set. Never closes the dialog itself -- I1: the user must see the outcome before dismissing it, same as BulkFixDialog. */
    onApplied: () => void
}

/**
 * Reverts a membership change set.
 *
 * D5: the preview computed here (`planRevert`, plus the rows resolved
 * afterwards for display) is what `handleRevert` applies -- with one
 * exception (finding M1): right before writing, the objects the revert
 * touches are re-read from the server, and if anyone changed them since
 * the page loaded, the engine is corrected, the preview recomputed and
 * shown again with a notice, and nothing is written until Revert is
 * clicked once more.
 *
 * I1 (fix round 1): `write()` resolves rather than rejects for a partial or
 * failed write, so this dialog mirrors `BulkFixDialog`'s honesty: the
 * result is shown (never silently treated as success), a partial write
 * offers Retry over `unaccounted`, and the dialog only closes when the
 * user clicks Close.
 */
export const RevertDialog = ({
    changeSet,
    onClose,
    onApplied,
}: RevertDialogProps) => {
    const { baseUrl, apiVersion } = useConfig() as {
        baseUrl: string
        apiVersion: number
    }
    const fetcher = useMemo(
        () => createFetcher(baseUrl, apiVersion),
        [baseUrl, apiVersion]
    )
    const { client, groupSets, groupSetsLoaded } = useEngine()
    const { write, isWriting } = useMembershipWrite()
    const set = groupSets.find((s) => s.id === changeSet.groupSetId)
    // Group sets not loaded yet is a third state, not "missing".
    const setMissing = groupSetsLoaded && !set

    const [step, setStep] = useState<'preview' | 'apply'>('preview')
    const [preview, setPreview] = useState<Preview | null>(null)
    const [loading, setLoading] = useState(true)
    const [loadError, setLoadError] = useState<string | null>(null)
    const [note, setNote] = useState('')
    const [checking, setChecking] = useState(false)
    const [checkFailed, setCheckFailed] = useState(false)
    const [changedSince, setChangedSince] = useState(false)
    const mountedRef = useRef(true)
    useEffect(
        () => () => {
            mountedRef.current = false
        },
        []
    )

    const [writeResult, setWriteResult] =
        useState<MembershipWriteResult | null>(null)
    const [mergedOutcomes, setMergedOutcomes] = useState<
        MembershipWriteResult['outcomes']
    >([])
    const [applyError, setApplyError] = useState<string | null>(null)

    useEffect(() => {
        if (!client || !set) {
            setLoading(false)
            return
        }
        let cancelled = false
        setLoading(true)
        setLoadError(null)
        computePreview(client, set, changeSet)
            .then((computed) => {
                if (!cancelled) {
                    setPreview(computed)
                    setLoading(false)
                }
            })
            .catch((e: unknown) => {
                if (!cancelled) {
                    setLoadError(e instanceof Error ? e.message : String(e))
                    setLoading(false)
                }
            })
        return () => {
            cancelled = true
        }
    }, [client, set, changeSet])

    const runWrite = (
        changes: MembershipWriteResult['applied'],
        retry: boolean
    ) => {
        if (!set) {
            return
        }
        setApplyError(null)
        write({
            set,
            changes,
            action: 'revert',
            note,
            revertOf: changeSet.id,
        })
            .then((result) => {
                setWriteResult(result)
                setMergedOutcomes((prev) =>
                    retry
                        ? mergeOutcomes(prev, result.outcomes)
                        : result.outcomes
                )
                onApplied()
            })
            .catch((e: unknown) => {
                // The write already happened by the time this could reject
                // -- never render this as if nothing changed.
                setApplyError(e instanceof Error ? e.message : String(e))
            })
    }

    /**
     * Finding M1: the objects this revert touches, re-read right before it
     * is written. Returns true when everything still holds; otherwise
     * brings the engine and the preview up to date and returns false.
     */
    const stillCurrent = (plan: AssignmentPlan): Promise<boolean> => {
        if (!client || !set) {
            return Promise.resolve(false)
        }
        return withDeadline(async (signal) => {
            const drift = await findMembershipDrift(fetcher, set.objectType, {
                expectations: changeExpectations(plan.changes),
                signal,
            })
            if (drift.length === 0) {
                return true
            }
            await client.call('applyChangeSet', set.objectType, drift)
            const recomputed = await computePreview(client, set, changeSet)
            if (mountedRef.current) {
                setPreview(recomputed)
            }
            return false
        })
    }

    const handleRevert = async () => {
        if (!preview || !set || checking) {
            return
        }
        // The dialog may have been opened just inside the window and left
        // open past it.
        if (!canStillRevert(changeSet, Date.now())) {
            setLoadError(revertWindowClosedLabel())
            return
        }
        setChecking(true)
        setCheckFailed(false)
        let current: boolean
        try {
            current = await stillCurrent(preview.plan)
        } catch {
            if (mountedRef.current) {
                setCheckFailed(true)
                setChecking(false)
            }
            return
        }
        if (!mountedRef.current) {
            return
        }
        setChecking(false)
        setChangedSince(!current)
        if (!current) {
            return
        }
        setStep('apply')
        setWriteResult(null)
        setMergedOutcomes([])
        runWrite(preview.plan.changes, false)
    }

    const handleRetry = () => {
        if (writeResult && writeResult.unaccounted.length > 0) {
            runWrite(writeResult.unaccounted, true)
        }
    }

    const settled =
        step === 'apply' && !isWriting && (writeResult || applyError)
    const busy = isWriting || checking

    return (
        <Modal position="middle" onClose={busy ? () => undefined : onClose}>
            <ModalTitle>{i18n.t('Revert change')}</ModalTitle>
            <ModalContent>
                {step === 'preview' && (
                    <PreviewStepContent
                        setMissing={setMissing}
                        loadError={loadError}
                        checking={checking}
                        checkFailed={checkFailed}
                        changedSince={changedSince}
                        loading={loading}
                        preview={preview}
                        set={set}
                        note={note}
                        onNoteChange={setNote}
                    />
                )}
                {step === 'apply' && (
                    <ApplyStepContent
                        isWriting={isWriting}
                        writeResult={writeResult}
                        mergedOutcomes={mergedOutcomes}
                        applyError={applyError}
                        set={set}
                    />
                )}
            </ModalContent>
            <ModalActions>
                <ButtonStrip end>
                    {settled ? (
                        <Button onClick={onClose}>{i18n.t('Close')}</Button>
                    ) : (
                        <Button onClick={onClose} disabled={busy}>
                            {i18n.t('Cancel')}
                        </Button>
                    )}
                    {step === 'preview' && (
                        <Button
                            primary
                            destructive
                            loading={checking}
                            disabled={
                                !preview ||
                                preview.plan.affected === 0 ||
                                checking
                            }
                            onClick={() => {
                                void handleRevert()
                            }}
                        >
                            {i18n.t('Revert')}
                        </Button>
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
