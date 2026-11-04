import i18n from '@dhis2/d2-i18n'
import { CircularLoader, NoticeBox } from '@dhis2/ui'
import React from 'react'
import styles from './BulkFixDialog.module.css'
import { aggregateOutcomes, outcomeText } from '@/data/writeOutcomes'
import type { BatchOutcome } from '@/data/writes'
import type { MembershipWriteResult } from '@/hooks/useMembershipWrite'
import { interpolate } from '@/utils/interpolate'

export interface ApplyStepProps {
    isWriting: boolean
    progress: { done: number; total: number } | null
    writeResult: MembershipWriteResult | null
    mergedOutcomes: BatchOutcome[]
    applyError: string | null
    groups: { id: string; displayName: string }[]
}

export const ApplyStep: React.FC<ApplyStepProps> = ({
    isWriting,
    progress,
    writeResult,
    mergedOutcomes,
    applyError,
    groups,
}) => (
    <div className={styles.applyStep}>
        {isWriting && (
            <div className={styles.progressRow}>
                <CircularLoader small />
                <span>
                    {progress
                        ? interpolate(
                              i18n.t('Applied {done} of {total} batches'),
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
                        groups.find((g) => g.id === o.groupId)?.displayName ??
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
                    <NoticeBox
                        warning
                        title={i18n.t('The view may be out of date')}
                    >
                        {i18n.t(
                            'The change was applied but the local view could not be refreshed; reload to see it'
                        )}
                    </NoticeBox>
                )}
                {writeResult.historyError && (
                    <NoticeBox
                        warning
                        title={i18n.t('Not recorded in History')}
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
                title={i18n.t('The result could not be confirmed')}
            >
                {i18n.t(
                    'The write may have reached the server, but this dialog could not confirm what happened to it -- reload and check History to see what changed'
                )}
            </NoticeBox>
        )}
    </div>
)
