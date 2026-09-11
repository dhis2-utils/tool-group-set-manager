import i18n from '@dhis2/d2-i18n'
import {
    Button,
    ButtonStrip,
    CircularLoader,
    DataTable,
    DataTableBody,
    DataTableCell,
    DataTableColumnHeader,
    DataTableHead,
    DataTableRow,
    InputField,
    Modal,
    ModalActions,
    ModalContent,
    ModalTitle,
    NoticeBox,
    Tooltip,
} from '@dhis2/ui'
import React, { useEffect, useState } from 'react'
import styles from './History.module.css'
import {
    ChangeSetPreview,
    ChangeSetPreviewObjects,
    PreviewRow,
} from '@/components/ChangeSetPreview/ChangeSetPreview'
import { toCsv } from '@/data/csv'
import {
    aggregateOutcomes,
    mergeOutcomes,
    outcomeText,
} from '@/data/writeOutcomes'
import { ChangeSet } from '@/engine/changeSet'
import {
    ObjectRef,
    AssignmentPlan,
    ObjectsResult,
    ScopeRef,
} from '@/engine/store'
import { useChangeSets } from '@/hooks/useChangeSets'
import { useEngine } from '@/hooks/useEngine'
import {
    MembershipWriteResult,
    useMembershipWrite,
} from '@/hooks/useMembershipWrite'
import { interpolate } from '@/utils/interpolate'

const actionLabel = (action: ChangeSet['action']): string => {
    switch (action) {
        case 'move':
            return i18n.t('Moved to a group')
        case 'assign':
            return i18n.t('Assigned to a group')
        case 'revert':
            return i18n.t('Reverted an earlier change')
        default:
            return action
    }
}

/** Spec 5.4's "number of membership changes": every addition and deletion the change set recorded, across every group it touched. */
function membershipChangeCount(changeSet: ChangeSet): number {
    return changeSet.changes.reduce(
        (sum, c) => sum + c.additions.length + c.deletions.length,
        0
    )
}

const changeCountLabel = (count: number) =>
    count === 1
        ? i18n.t('1 membership change')
        : interpolate(i18n.t('{count} membership changes'), {
              count: count.toLocaleString(),
          })

const noAuthorLabel = () => i18n.t('Unknown user')

const noHistoryMessage = () =>
    i18n.t('No changes have been recorded on this instance yet')

const missingGroupSetTooltip = () =>
    i18n.t(
        'This group set no longer exists, so this change cannot be reverted from here'
    )

/** Filesystem-unsafe characters a group set's own display name could contain. Same rule as BulkFixDialog's. */
function safeFileName(name: string): string {
    return name.replace(/[\\/:*?"<>|]/g, '_')
}

function downloadCsv(rows: string[][], fileName: string): void {
    const csv = toCsv(rows)
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' })
    const url = URL.createObjectURL(blob)
    const link = document.createElement('a')
    link.href = url
    link.download = fileName
    document.body.appendChild(link)
    link.click()
    document.body.removeChild(link)
    URL.revokeObjectURL(url)
}

const SAMPLE_SIZE = 20

interface RevertDialogProps {
    changeSet: ChangeSet
    onClose: () => void
    /** Called once a write has settled (however it went) so the list behind the dialog can pick up the new revert change set. Never closes the dialog itself -- I1: the user must see the outcome before dismissing it, same as BulkFixDialog. */
    onApplied: () => void
}

/**
 * D5: the preview computed here (`planRevert`, plus the rows resolved
 * afterwards for display) is exactly what `handleRevert` applies -- never
 * recomputed between preview and apply.
 *
 * I1 (fix round 1): `write()` resolves rather than rejects for a partial or
 * failed write, so this dialog now mirrors `BulkFixDialog`'s honesty: the
 * result is shown (never silently treated as success), a partial write
 * offers Retry over `unaccounted`, and the dialog only closes when the
 * user clicks Close.
 */
const RevertDialog = ({ changeSet, onClose, onApplied }: RevertDialogProps) => {
    const { client, groupSets } = useEngine()
    const { write, isWriting } = useMembershipWrite()
    const set = groupSets.find((s) => s.id === changeSet.groupSetId)

    const [step, setStep] = useState<'preview' | 'apply'>('preview')
    const [plan, setPlan] = useState<AssignmentPlan | null>(null)
    const [sample, setSample] = useState<PreviewRow[]>([])
    const [skippedSample, setSkippedSample] = useState<
        { id: string; displayName: string | null }[]
    >([])
    const [loading, setLoading] = useState(true)
    const [loadError, setLoadError] = useState<string | null>(null)
    const [note, setNote] = useState('')

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
        client
            .call<AssignmentPlan>('planRevert', set.id, changeSet.changes)
            .then(async (computed) => {
                if (cancelled) {
                    return
                }
                setPlan(computed)
                const scope: ScopeRef = {
                    objectType: set.objectType,
                    rootId: null,
                }
                const touchedIds = Array.from(
                    new Set(
                        computed.changes.flatMap((c) => [
                            ...c.additions,
                            ...c.deletions,
                        ])
                    )
                ).slice(0, SAMPLE_SIZE)
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
                        : Promise.resolve({
                              items: [] as ObjectsResult['items'],
                          }),
                    computed.skippedSample.length > 0
                        ? client.call<ObjectsResult>(
                              'objectsFor',
                              set.id,
                              scope,
                              { ids: computed.skippedSample },
                              0,
                              computed.skippedSample.length
                          )
                        : Promise.resolve({
                              items: [] as ObjectsResult['items'],
                          }),
                ])
                if (cancelled) {
                    return
                }
                setSample(
                    sampleResult.items.map((item) => ({
                        id: item.id,
                        displayName: item.displayName,
                        groups: item.groups,
                    }))
                )
                // M3: `computed.skippedSample` is the authority on which ids
                // were skipped -- `objectsFor` returns nothing for one that
                // no longer exists, so the display list is built by mapping
                // over the ids themselves (falling back to no name, which
                // `ChangeSetPreview` already renders as the raw id) rather
                // than over whatever `objectsFor` happened to resolve.
                const skippedNameById = new Map(
                    skippedResult.items.map((item) => [
                        item.id,
                        item.displayName,
                    ])
                )
                setSkippedSample(
                    computed.skippedSample.map((id) => ({
                        id,
                        displayName: skippedNameById.get(id) ?? null,
                    }))
                )
                setLoading(false)
            })
            .catch((e: unknown) => {
                if (cancelled) {
                    return
                }
                setLoadError(e instanceof Error ? e.message : String(e))
                setLoading(false)
            })
        return () => {
            cancelled = true
        }
    }, [client, set, changeSet])

    const handleRevert = () => {
        if (!plan || !set) {
            return
        }
        setStep('apply')
        setWriteResult(null)
        setMergedOutcomes([])
        setApplyError(null)
        write({
            set,
            changes: plan.changes,
            action: 'revert',
            note,
            revertOf: changeSet.id,
        })
            .then((result) => {
                setWriteResult(result)
                setMergedOutcomes(result.outcomes)
                onApplied()
            })
            .catch((e: unknown) => {
                // I4 (task 8's numbering)/I1 here: the write already
                // happened by the time this could reject -- never render
                // this as if nothing changed.
                setApplyError(e instanceof Error ? e.message : String(e))
            })
    }

    const handleRetry = () => {
        if (!writeResult || writeResult.unaccounted.length === 0 || !set) {
            return
        }
        setApplyError(null)
        write({
            set,
            changes: writeResult.unaccounted,
            action: 'revert',
            note,
            revertOf: changeSet.id,
        })
            .then((result) => {
                setWriteResult(result)
                setMergedOutcomes((prev) =>
                    mergeOutcomes(prev, result.outcomes)
                )
                onApplied()
            })
            .catch((e: unknown) => {
                setApplyError(e instanceof Error ? e.message : String(e))
            })
    }

    const previewObjects: ChangeSetPreviewObjects = {
        total: (plan?.affected ?? 0) + (plan?.skippedCount ?? 0),
        sample,
        skippedCount: plan?.skippedCount ?? 0,
        skippedSample,
        // A revert skips for three different reasons, not just the
        // read-only one an assignment plan has; see ChangeSetPreview's
        // `skipReason`.
        skipReason: 'revert',
    }

    const settled =
        step === 'apply' && !isWriting && (writeResult || applyError)

    return (
        <Modal
            position="middle"
            onClose={isWriting ? () => undefined : onClose}
        >
            <ModalTitle>{i18n.t('Revert change')}</ModalTitle>
            <ModalContent>
                {step === 'preview' && (
                    <>
                        {!set && (
                            <NoticeBox
                                error
                                title={i18n.t('This change cannot be reverted')}
                            >
                                {missingGroupSetTooltip()}
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
                        {loading && <CircularLoader small />}
                        {!loading && plan && (
                            <>
                                {plan.affected === 0 ? (
                                    <NoticeBox
                                        title={i18n.t('Nothing to revert')}
                                    >
                                        {i18n.t(
                                            'Every object this change touched has since been reassigned by hand, so reverting it now would not change anything'
                                        )}
                                    </NoticeBox>
                                ) : (
                                    <ChangeSetPreview
                                        changes={plan.changes}
                                        groups={set?.groups ?? []}
                                        objects={previewObjects}
                                    />
                                )}
                                <InputField
                                    label={i18n.t('Note (optional)')}
                                    value={note}
                                    onChange={({ value }) =>
                                        setNote(value ?? '')
                                    }
                                />
                            </>
                        )}
                    </>
                )}
                {step === 'apply' && (
                    <div>
                        {isWriting && (
                            <div className={styles.progressRow}>
                                <CircularLoader small />
                                <span>{i18n.t('Applying the revert…')}</span>
                            </div>
                        )}
                        {writeResult && !isWriting && (
                            <div className={styles.resultPanel}>
                                {mergedOutcomes.length === 0 && (
                                    <NoticeBox>
                                        {i18n.t('There was nothing to apply')}
                                    </NoticeBox>
                                )}
                                {aggregateOutcomes(mergedOutcomes).map((o) => {
                                    const groupName =
                                        set?.groups.find(
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
                                            'The revert was applied but could not itself be recorded in History, so it cannot in turn be reverted from here'
                                        )}
                                    </NoticeBox>
                                )}
                            </div>
                        )}
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
                <ButtonStrip end>
                    {settled ? (
                        <Button onClick={onClose}>{i18n.t('Close')}</Button>
                    ) : (
                        <Button onClick={onClose} disabled={isWriting}>
                            {i18n.t('Cancel')}
                        </Button>
                    )}
                    {step === 'preview' && (
                        <Button
                            primary
                            destructive
                            disabled={!plan || plan.affected === 0}
                            onClick={handleRevert}
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

export const History = () => {
    const { client, groupSets } = useEngine()
    const {
        changeSets,
        isLoading,
        isLoadingMore,
        error,
        hasMore,
        loadMore,
        reload,
    } = useChangeSets()
    const [revertTarget, setRevertTarget] = useState<ChangeSet | null>(null)
    const [exportingId, setExportingId] = useState<string | null>(null)
    const [exportError, setExportError] = useState<string | null>(null)

    // I4: spec 5.4's Export action -- a per-membership-change CSV of the
    // *recorded* change set (never the revert plan), with the change
    // set's own metadata carried on every row so the file is
    // self-describing once downloaded. Object names are resolved through
    // the engine's plain `indexOf`/`resolve` (not `objectsFor`, which needs
    // a group set the engine still knows about -- Export must work even
    // for D4's "group set no longer exists" rows).
    const handleExport = async (cs: ChangeSet) => {
        setExportError(null)
        setExportingId(cs.id)
        try {
            const ids = Array.from(
                new Set(
                    cs.changes.flatMap((c) => [...c.additions, ...c.deletions])
                )
            )
            const nameById = new Map<string, string>()
            if (client && ids.length > 0) {
                const indexes: number[] = []
                const idOfIndexPos: string[] = []
                for (const id of ids) {
                    const idx = await client.call<number>(
                        'indexOf',
                        cs.objectType,
                        id
                    )
                    if (idx >= 0) {
                        indexes.push(idx)
                        idOfIndexPos.push(id)
                    }
                }
                if (indexes.length > 0) {
                    const resolved = await client.call<ObjectRef[]>(
                        'resolve',
                        cs.objectType,
                        indexes
                    )
                    resolved.forEach((r, i) => {
                        nameById.set(idOfIndexPos[i], r.displayName ?? '')
                    })
                }
            }
            const set = groupSets.find((s) => s.id === cs.groupSetId)
            const groupName = (groupId: string) =>
                set?.groups.find((g) => g.id === groupId)?.displayName ??
                groupId

            const rows: string[][] = [
                [
                    'changeSetId',
                    'createdAt',
                    'createdBy',
                    'groupSet',
                    'action',
                    'note',
                    'revertOf',
                    'objectId',
                    'objectName',
                    'groupId',
                    'groupName',
                    'operation',
                ],
            ]
            cs.changes.forEach((change) => {
                const addRow = (id: string, operation: string) => {
                    rows.push([
                        cs.id,
                        cs.createdAt,
                        cs.createdBy.displayName,
                        cs.groupSetName,
                        cs.action,
                        cs.note,
                        cs.revertOf ?? '',
                        id,
                        nameById.get(id) ?? '',
                        change.groupId,
                        groupName(change.groupId),
                        operation,
                    ])
                }
                change.additions.forEach((id) => addRow(id, 'added'))
                change.deletions.forEach((id) => addRow(id, 'removed'))
            })
            downloadCsv(rows, `${safeFileName(cs.groupSetName)}-${cs.id}.csv`)
        } catch (e) {
            setExportError(e instanceof Error ? e.message : String(e))
        } finally {
            setExportingId(null)
        }
    }

    return (
        <div className={styles.page}>
            <h1 className={styles.heading}>{i18n.t('History')}</h1>
            {error && (
                <NoticeBox error title={i18n.t('Could not load history')}>
                    {error}
                </NoticeBox>
            )}
            {exportError && (
                <NoticeBox error title={i18n.t('Could not export this change')}>
                    {exportError}
                </NoticeBox>
            )}
            {isLoading && <CircularLoader />}
            {!isLoading && changeSets.length === 0 && !error && (
                <p>{noHistoryMessage()}</p>
            )}
            {!isLoading && changeSets.length > 0 && (
                <DataTable>
                    <DataTableHead>
                        <DataTableRow>
                            <DataTableColumnHeader>
                                {i18n.t('When')}
                            </DataTableColumnHeader>
                            <DataTableColumnHeader>
                                {i18n.t('Who')}
                            </DataTableColumnHeader>
                            <DataTableColumnHeader>
                                {i18n.t('Group set')}
                            </DataTableColumnHeader>
                            <DataTableColumnHeader>
                                {i18n.t('Action')}
                            </DataTableColumnHeader>
                            <DataTableColumnHeader>
                                {i18n.t('Changes')}
                            </DataTableColumnHeader>
                            <DataTableColumnHeader>
                                {i18n.t('Note')}
                            </DataTableColumnHeader>
                            <DataTableColumnHeader></DataTableColumnHeader>
                        </DataTableRow>
                    </DataTableHead>
                    <DataTableBody>
                        {changeSets.map((cs) => {
                            // D4: a change set whose group set no longer
                            // exists is still listed (never hidden), just
                            // without a working Revert.
                            const setExists = groupSets.some(
                                (gs) => gs.id === cs.groupSetId
                            )
                            return (
                                <DataTableRow key={cs.id}>
                                    <DataTableCell>
                                        {new Date(
                                            cs.createdAt
                                        ).toLocaleString()}
                                    </DataTableCell>
                                    <DataTableCell>
                                        {cs.createdBy.displayName ||
                                            noAuthorLabel()}
                                    </DataTableCell>
                                    <DataTableCell>
                                        {cs.groupSetName}
                                        {!setExists && (
                                            <div className={styles.note}>
                                                {missingGroupSetTooltip()}
                                            </div>
                                        )}
                                    </DataTableCell>
                                    <DataTableCell>
                                        {actionLabel(cs.action)}
                                    </DataTableCell>
                                    <DataTableCell>
                                        {changeCountLabel(
                                            membershipChangeCount(cs)
                                        )}
                                    </DataTableCell>
                                    <DataTableCell>{cs.note}</DataTableCell>
                                    <DataTableCell>
                                        <ButtonStrip>
                                            <Button
                                                small
                                                loading={exportingId === cs.id}
                                                onClick={() => handleExport(cs)}
                                            >
                                                {i18n.t('Export')}
                                            </Button>
                                            {setExists ? (
                                                <Button
                                                    small
                                                    onClick={() =>
                                                        setRevertTarget(cs)
                                                    }
                                                >
                                                    {i18n.t('Revert')}
                                                </Button>
                                            ) : (
                                                <Tooltip
                                                    content={missingGroupSetTooltip()}
                                                >
                                                    {({
                                                        onMouseOver,
                                                        onMouseOut,
                                                        ref,
                                                    }) => (
                                                        <span
                                                            ref={ref}
                                                            onMouseOver={
                                                                onMouseOver
                                                            }
                                                            onMouseOut={
                                                                onMouseOut
                                                            }
                                                        >
                                                            <Button
                                                                small
                                                                disabled
                                                            >
                                                                {i18n.t(
                                                                    'Revert'
                                                                )}
                                                            </Button>
                                                        </span>
                                                    )}
                                                </Tooltip>
                                            )}
                                        </ButtonStrip>
                                    </DataTableCell>
                                </DataTableRow>
                            )
                        })}
                    </DataTableBody>
                </DataTable>
            )}
            {hasMore && (
                <Button onClick={loadMore} loading={isLoadingMore}>
                    {i18n.t('Load more')}
                </Button>
            )}
            {revertTarget && (
                <RevertDialog
                    changeSet={revertTarget}
                    onClose={() => setRevertTarget(null)}
                    onApplied={() => reload()}
                />
            )}
        </div>
    )
}
