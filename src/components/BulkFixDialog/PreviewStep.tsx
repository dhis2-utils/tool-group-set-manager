import i18n from '@dhis2/d2-i18n'
import { Button, CircularLoader, InputField, NoticeBox } from '@dhis2/ui'
import React from 'react'
import styles from './BulkFixDialog.module.css'
import type { Action } from './constants'
import { CHECK_TIMEOUT } from './constants'
import type { ChangeSetPreviewObjects } from '@/components/ChangeSetPreview/ChangeSetPreview'
import { ChangeSetPreview } from '@/components/ChangeSetPreview/ChangeSetPreview'
import type { AssignmentPlan } from '@/engine/store'
import type { GroupSetMeta } from '@/engine/types'
import { interpolate } from '@/utils/interpolate'

const objectsCountLabel = (count: number) =>
    count === 1
        ? i18n.t('1 object')
        : interpolate(i18n.t('{count} objects'), {
              count: count.toLocaleString(),
          })

export interface PreviewStepProps {
    action: Action
    filterText: string | undefined
    plan: AssignmentPlan | null | undefined
    planLoading: boolean
    planError: string | null
    checkingFreshness: boolean
    checkError: string | null
    recheck: { previewed: number; recomputed: AssignmentPlan } | null
    groups: GroupSetMeta['groups']
    previewObjects: ChangeSetPreviewObjects
    csvBusy: boolean
    csvError: string | null
    onDownloadCsv: () => void
    note: string
    onNoteChange: (note: string) => void
}

export const PreviewStep: React.FC<PreviewStepProps> = ({
    action,
    filterText,
    plan,
    planLoading,
    planError,
    checkingFreshness,
    checkError,
    recheck,
    groups,
    previewObjects,
    csvBusy,
    csvError,
    onDownloadCsv,
    note,
    onNoteChange,
}) => (
    <div>
        {planLoading && <CircularLoader small />}
        {planError && <NoticeBox error>{planError}</NoticeBox>}
        {/* Task 9 (spec 5.1/5.4), finding M1: shown while the
            touched groups are re-read before any write. */}
        {checkingFreshness && (
            <div className={styles.progressRow}>
                <CircularLoader small />
                <span>{i18n.t('Checking the metadata is up to date…')}</span>
            </div>
        )}
        {/* Fix round 1, finding 2: the check itself failed
            (or, finding 3, there was no engine client to run
            it against) -- distinct from `applyError` in
            ApplyStep.tsx, which only ever renders on the apply
            step and means the opposite (a write happened but
            could not be confirmed). Nothing was written here. */}
        {checkError === CHECK_TIMEOUT && !checkingFreshness && (
            <NoticeBox
                error
                title={i18n.t('Checking the metadata took too long')}
            >
                {i18n.t(
                    'The check was stopped because it did not finish in time, so nothing was written — try Apply again'
                )}
            </NoticeBox>
        )}
        {checkError && checkError !== CHECK_TIMEOUT && !checkingFreshness && (
            <NoticeBox
                error
                title={i18n.t('The metadata could not be checked')}
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
                title={i18n.t('The metadata changed while you were reviewing')}
            >
                <p>
                    {i18n.t(
                        'Someone else has changed this group set since the preview was calculated. The plan below has been recalculated against the current metadata — check it before applying.'
                    )}
                </p>
                <p className={styles.recheckCounts}>
                    <span>
                        {i18n.t('Previewed')}:{' '}
                        <s>{recheck.previewed.toLocaleString()}</s>
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
                        {filterText
                            ? interpolate(
                                  i18n.t(
                                      'Only objects missing from this set or in conflict are moved here -- correctly assigned objects are left alone, among objects matching the search term {term}'
                                  ),
                                  { term: filterText }
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
                            i18n.t('{count} objects match this view'),
                            {
                                count: previewObjects.total.toLocaleString(),
                            }
                        )}
                    </p>
                )}
                <ChangeSetPreview
                    changes={plan.changes}
                    groups={groups}
                    objects={previewObjects}
                />
                {/* L2: one column with its own spacing. The CSV button
                    used to sit in a ButtonStrip directly above the note
                    field, and the field's label was drawn under the
                    button. */}
                <div className={styles.previewFooter}>
                    <div>
                        <Button small loading={csvBusy} onClick={onDownloadCsv}>
                            {i18n.t('Download full list as CSV')}
                        </Button>
                    </div>
                    {csvError && <NoticeBox error>{csvError}</NoticeBox>}
                    <InputField
                        // See the catch-all name fields in
                        // ActionStep.tsx: without `name` the label
                        // associates with nothing.
                        name="note"
                        label={i18n.t('Note for History (optional)')}
                        value={note}
                        onChange={({ value }) => onNoteChange(value ?? '')}
                    />
                </div>
            </>
        )}
    </div>
)
