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
    NoticeBox,
} from '@dhis2/ui'
import React, { useEffect, useState } from 'react'
import styles from './History.module.css'
import { exportChangeSet } from './historyExport'
import { actionLabel, changeSummary } from './labels'
import { PropertiesRevertDialog } from './PropertiesRevertDialog'
import type { GroupSetState } from './RevertControl'
import { RevertControl } from './RevertControl'
import { RevertDialog } from './RevertDialog'
import type { ChangeSet } from '@/engine/changeSet'
import { isPropertiesChange } from '@/engine/changeSet'
import { useChangeSets } from '@/hooks/useChangeSets'
import { useEngine } from '@/hooks/useEngine'

const noAuthorLabel = () => i18n.t('Unknown user')

const noHistoryMessage = () =>
    i18n.t('No changes have been recorded on this instance yet')

const HistoryRow = ({
    changeSet: cs,
    groupSet,
    now,
    exporting,
    onExport,
    onRevert,
}: {
    changeSet: ChangeSet
    groupSet: GroupSetState
    now: number
    exporting: boolean
    onExport: () => void
    onRevert: () => void
}) => (
    <DataTableRow>
        <DataTableCell>{new Date(cs.createdAt).toLocaleString()}</DataTableCell>
        <DataTableCell>
            {cs.createdBy.displayName || noAuthorLabel()}
        </DataTableCell>
        <DataTableCell>{cs.groupSetName}</DataTableCell>
        <DataTableCell>{actionLabel(cs)}</DataTableCell>
        <DataTableCell>
            {changeSummary(cs).map((line) => (
                <span key={line} className={styles.summaryLine}>
                    {line}
                </span>
            ))}
        </DataTableCell>
        <DataTableCell>{cs.note}</DataTableCell>
        <DataTableCell>
            <ButtonStrip>
                <Button small loading={exporting} onClick={onExport}>
                    {i18n.t('Export')}
                </Button>
                <RevertControl
                    changeSet={cs}
                    groupSet={groupSet}
                    now={now}
                    onRevert={onRevert}
                />
            </ButtonStrip>
        </DataTableCell>
    </DataTableRow>
)

export const History = () => {
    const {
        client,
        groupSets,
        restrictedSets,
        groupSetsLoaded,
        error: groupSetsError,
    } = useEngine()
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
    // The revert window is judged against this clock rather than one read
    // during render, and it advances each minute so a page left open closes
    // the window on time. The dialog checks again when Revert is clicked.
    const [now, setNow] = useState(() => Date.now())
    useEffect(() => {
        const timer = setInterval(() => setNow(Date.now()), 60_000)
        return () => clearInterval(timer)
    }, [])
    const [exportingId, setExportingId] = useState<string | null>(null)
    const [exportError, setExportError] = useState<string | null>(null)

    const handleExport = async (cs: ChangeSet) => {
        setExportError(null)
        setExportingId(cs.id)
        try {
            await exportChangeSet(cs, client, groupSets)
        } catch (e) {
            setExportError(e instanceof Error ? e.message : String(e))
        } finally {
            setExportingId(null)
        }
    }

    // D4: a change set whose group set no longer exists is still listed
    // (never hidden), just without a working Revert. Until group sets have
    // loaded, nothing is known either way -- so Revert waits rather than
    // accusing -- and F1: loading having failed outright must say so rather
    // than silently behaving like "still loading".
    const groupSetState = (cs: ChangeSet): GroupSetState => {
        const set = groupSets.find((gs) => gs.id === cs.groupSetId)
        const present = set !== undefined
        // A set with a group the user cannot read is not in `groupSets` (it
        // never reaches the engine), but it does exist: say why it cannot
        // be reverted rather than calling it deleted.
        const restricted =
            !present && restrictedSets.some((rs) => rs.id === cs.groupSetId)
        return {
            exists: groupSetsLoaded && present,
            missing: groupSetsLoaded && !present && !restricted,
            restricted: groupSetsLoaded && restricted,
            loadFailed: !groupSetsLoaded && Boolean(groupSetsError),
            // A property revert writes the group set; a membership revert
            // is a bulk write, and like a bulk fix needs every group.
            readOnly:
                set !== undefined &&
                (isPropertiesChange(cs)
                    ? !set.canWrite
                    : !set.groups.every((g) => g.canWrite)),
        }
    }

    const closeRevert = () => setRevertTarget(null)

    return (
        <div className={styles.page}>
            <h1 className={styles.heading}>{i18n.t('History')}</h1>
            {error && (
                <NoticeBox error title={i18n.t('Could not load history')}>
                    {error}
                </NoticeBox>
            )}
            {!groupSetsLoaded && groupSetsError && (
                <NoticeBox error title={i18n.t('Could not load group sets')}>
                    {groupSetsError}
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
                            <DataTableColumnHeader />
                        </DataTableRow>
                    </DataTableHead>
                    <DataTableBody>
                        {changeSets.map((cs) => (
                            <HistoryRow
                                key={cs.id}
                                changeSet={cs}
                                groupSet={groupSetState(cs)}
                                now={now}
                                exporting={exportingId === cs.id}
                                onExport={() => {
                                    void handleExport(cs)
                                }}
                                onRevert={() => setRevertTarget(cs)}
                            />
                        ))}
                    </DataTableBody>
                </DataTable>
            )}
            {hasMore && (
                <Button onClick={loadMore} loading={isLoadingMore}>
                    {i18n.t('Load more')}
                </Button>
            )}
            {revertTarget && isPropertiesChange(revertTarget) && (
                <PropertiesRevertDialog
                    changeSet={revertTarget}
                    onClose={closeRevert}
                    onApplied={() => reload()}
                />
            )}
            {revertTarget && !isPropertiesChange(revertTarget) && (
                <RevertDialog
                    changeSet={revertTarget}
                    onClose={closeRevert}
                    onApplied={() => reload()}
                />
            )}
        </div>
    )
}
