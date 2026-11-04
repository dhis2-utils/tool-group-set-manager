import i18n from '@dhis2/d2-i18n'
import { Card, Tag } from '@dhis2/ui'
import React from 'react'
import styles from './GroupSetCard.module.css'
import { usageApplies } from '@/data/sources/usageSqlView'
import type { DashboardEntry } from '@/engine/store'
import { useUsage } from '@/hooks/useUsage'
import { usedInFavouritesLabel } from '@/utils/favouritesLabel'
import { groupsLabel } from '@/utils/groupsLabel'
import { interpolate } from '@/utils/interpolate'

interface Props {
    entry: DashboardEntry
    onOpen: () => void
    onOpenUsage: () => void
    /**
     * Why this set's type could not be loaded, when it could not. A set of
     * a failed type has no data and never will in this load, so it shows
     * that instead of "Loading…".
     */
    loadError?: string
}

const readOnlyLabel = (count: number) =>
    count === 1
        ? i18n.t('1 group read-only for you')
        : interpolate(i18n.t('{count} groups read-only for you'), {
              count: count.toLocaleString(),
          })

export const GroupSetCard = ({
    entry,
    onOpen,
    onOpenUsage,
    loadError,
}: Props) => {
    const { set, summary, hasData } = entry
    const readOnlyGroups = set.groups.filter((g) => !g.canWrite).length
    const usage = useUsage()
    // Only a set whose type can be an analytics dimension, on an instance
    // that actually has the usage view, shows anything here. Everything
    // else renders nothing at all -- not a dash, not a zero.
    //
    // Manual review 2: the card used to end with the DHIS2 integrity
    // check's own result line ("DHIS2 check … found N objects across all
    // group sets on this instance …"). That number is instance-wide and
    // spans every set of the type, so under one set's own counts it read
    // as that set's, however carefully the sentence disclaimed it. The
    // line lives on the set's DHIS2 integrity tab now, and nowhere on the
    // dashboard.
    const setUsage =
        usage.status === 'ready' && usageApplies(set.objectType)
            ? usage.forSet(set.id)
            : null
    // The same condition, and the same wording, as the summary matrix's
    // extra column (see SummaryMatrix's showUnassigned): only a set that is
    // neither compulsory nor a data dimension can hold objects that are in
    // no group and still Ok. Showing it here as well is what keeps the card
    // and the matrix telling one story -- the card used to fold those
    // objects into a green OK number while the matrix counted them as
    // Missing.
    const showUnassigned = !set.compulsory && !set.dataDimension
    // The set name is the card's one real control, so keyboard and screen
    // reader users get a plain button with the set's name as its label.
    // The rest of the card also opens the set on a mouse click, as a
    // larger target; it is not a second control, so it is not focusable.
    // "Appears unused" is a sibling button, not nested in another one.
    return (
        <Card>
            {/* oxlint-disable-next-line jsx-a11y/click-events-have-key-events, jsx-a11y/no-static-element-interactions -- a mouse-only enlargement of the name button below, which is the keyboard and screen reader control for the same action */}
            <div
                className={styles.card}
                data-test="group-set-card"
                onClick={onOpen}
            >
                <button
                    type="button"
                    className={styles.name}
                    data-test="group-set-card-name"
                    onClick={(e) => {
                        // The card's own click would open the set a second
                        // time.
                        e.stopPropagation()
                        onOpen()
                    }}
                >
                    {set.displayName}
                </button>
                <div className={styles.badges}>
                    {set.compulsory && (
                        <Tag positive>{i18n.t('Compulsory')}</Tag>
                    )}
                    {set.dataDimension && (
                        <Tag positive>{i18n.t('Data dimension')}</Tag>
                    )}
                    <Tag neutral>{groupsLabel(set.groups.length)}</Tag>
                </div>
                {set.groups.length === 0 ? (
                    // Nothing was, or could have been, checked: showing the
                    // usual all-green stat block here would read as "every
                    // object passed" when in fact there is no configuration
                    // to pass or fail against. That is a configuration gap
                    // for a manager to notice, not a clean bill of health.
                    <div className={styles.meta}>
                        {i18n.t('This group set has no groups configured')}
                    </div>
                ) : !hasData && loadError ? (
                    <div className={styles.failed} title={loadError}>
                        {i18n.t('This group set could not be loaded')}
                    </div>
                ) : !hasData ? (
                    <div className={styles.meta}>{i18n.t('Loading…')}</div>
                ) : (
                    <div className={styles.stats}>
                        <div className={styles.error}>
                            <div className={styles.value}>
                                {summary.conflict.toLocaleString()}
                            </div>
                            <div className={styles.label}>
                                {i18n.t('Conflicts')}
                            </div>
                        </div>
                        <div
                            className={
                                summary.missingError > 0
                                    ? styles.error
                                    : styles.warning
                            }
                        >
                            <div className={styles.value}>
                                {(
                                    summary.missingError +
                                    summary.missingWarning
                                ).toLocaleString()}
                            </div>
                            <div className={styles.label}>
                                {i18n.t('Missing')}
                            </div>
                        </div>
                        {showUnassigned && (
                            <div className={styles.neutral}>
                                <div className={styles.value}>
                                    {summary.unassigned.toLocaleString()}
                                </div>
                                <div className={styles.label}>
                                    {i18n.t('No group')}
                                </div>
                            </div>
                        )}
                        <div className={styles.ok}>
                            <div className={styles.value}>
                                {summary.ok.toLocaleString()}
                            </div>
                            <div className={styles.label}>{i18n.t('OK')}</div>
                        </div>
                    </div>
                )}
                <div className={styles.meta}>
                    {readOnlyGroups > 0
                        ? readOnlyLabel(readOnlyGroups)
                        : i18n.t('You can edit all groups')}
                </div>
                {setUsage && (
                    <div className={styles.usage}>
                        <span>
                            {usedInFavouritesLabel(setUsage.favourites)}
                        </span>
                        {setUsage.favourites === 0 && (
                            <button
                                type="button"
                                className={styles.unusedTag}
                                onClick={(e) => {
                                    // The card itself opens the set on a
                                    // click; without this that would fire
                                    // too and land the user on the
                                    // Overview tab instead.
                                    e.stopPropagation()
                                    onOpenUsage()
                                }}
                            >
                                {i18n.t('Appears unused')}
                            </button>
                        )}
                    </div>
                )}
            </div>
        </Card>
    )
}
