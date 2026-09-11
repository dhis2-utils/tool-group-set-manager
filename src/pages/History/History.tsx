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
import { ChangeSet } from '@/engine/changeSet'
import { AssignmentPlan, ObjectsResult, ScopeRef } from '@/engine/store'
import { useChangeSets } from '@/hooks/useChangeSets'
import { useEngine } from '@/hooks/useEngine'
import { useMembershipWrite } from '@/hooks/useMembershipWrite'
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

const SAMPLE_SIZE = 20

interface RevertDialogProps {
    changeSet: ChangeSet
    onClose: () => void
    onReverted: () => void
}

/**
 * D5: the preview computed here (`planRevert`, plus the rows resolved
 * afterwards for display) is exactly what `handleRevert` applies -- never
 * recomputed between preview and apply.
 */
const RevertDialog = ({
    changeSet,
    onClose,
    onReverted,
}: RevertDialogProps) => {
    const { client, groupSets } = useEngine()
    const { write, isWriting } = useMembershipWrite()
    const set = groupSets.find((s) => s.id === changeSet.groupSetId)

    const [plan, setPlan] = useState<AssignmentPlan | null>(null)
    const [sample, setSample] = useState<PreviewRow[]>([])
    const [skippedSample, setSkippedSample] = useState<
        { id: string; displayName: string | null }[]
    >([])
    const [loading, setLoading] = useState(true)
    const [loadError, setLoadError] = useState<string | null>(null)
    const [applyError, setApplyError] = useState<string | null>(null)
    const [note, setNote] = useState('')

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
                setSkippedSample(
                    skippedResult.items.map((item) => ({
                        id: item.id,
                        displayName: item.displayName,
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
        setApplyError(null)
        write({
            set,
            changes: plan.changes,
            action: 'revert',
            note,
            revertOf: changeSet.id,
        })
            .then(() => {
                onReverted()
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
    }

    return (
        <Modal
            position="middle"
            onClose={isWriting ? () => undefined : onClose}
        >
            <ModalTitle>{i18n.t('Revert change')}</ModalTitle>
            <ModalContent>
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
                            <NoticeBox title={i18n.t('Nothing to revert')}>
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
                            onChange={({ value }) => setNote(value ?? '')}
                        />
                    </>
                )}
                {applyError && <NoticeBox error>{applyError}</NoticeBox>}
            </ModalContent>
            <ModalActions>
                <ButtonStrip end>
                    <Button onClick={onClose} disabled={isWriting}>
                        {i18n.t('Cancel')}
                    </Button>
                    <Button
                        primary
                        destructive
                        disabled={!plan || plan.affected === 0 || isWriting}
                        loading={isWriting}
                        onClick={handleRevert}
                    >
                        {i18n.t('Revert')}
                    </Button>
                </ButtonStrip>
            </ModalActions>
        </Modal>
    )
}

export const History = () => {
    const { groupSets } = useEngine()
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

    return (
        <div className={styles.page}>
            <h1 className={styles.heading}>{i18n.t('History')}</h1>
            {error && (
                <NoticeBox error title={i18n.t('Could not load history')}>
                    {error}
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
                                                        onMouseOut={onMouseOut}
                                                    >
                                                        <Button small disabled>
                                                            {i18n.t('Revert')}
                                                        </Button>
                                                    </span>
                                                )}
                                            </Tooltip>
                                        )}
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
                    onReverted={() => {
                        setRevertTarget(null)
                        reload()
                    }}
                />
            )}
        </div>
    )
}
