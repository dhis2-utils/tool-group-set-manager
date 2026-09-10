import i18n from '@dhis2/d2-i18n'
import { Card, Tag } from '@dhis2/ui'
import React from 'react'
import styles from './GroupSetCard.module.css'
import { DashboardEntry } from '@/engine/store'

interface Props {
    entry: DashboardEntry
    onOpen: () => void
}

// Two problems with a single call of the shape the brief specified --
// i18n.t of a key plus an options object holding count and a
// defaultValue_plural fallback: (1) @dhis2/d2-i18n@1.2.0 resolves an
// i18next version that never reads that fallback, so it is a silent no-op
// and the singular string always renders regardless of count; (2) this
// project's `d2-app-scripts i18n extract` uses i18next-scanner in a mode
// that only recognises an i18n.t call taking a single string argument --
// passing any second (options) argument at all, verified directly against
// the installed scanner, makes the whole call invisible to extraction, so
// the plural string never even reaches the .pot file to be translated.
// Both are avoided by keeping every i18n.t call a single bare string
// argument, choosing between two such calls on `count === 1`, and
// splicing the number in around the translated word with plain JS
// templating instead of i18next's own count-interpolation option.
const groupsLabel = (count: number) =>
    `${count} ${count === 1 ? i18n.t('group') : i18n.t('groups')}`

const readOnlyLabel = (count: number) =>
    `${count} ${
        count === 1
            ? i18n.t('group read-only for you')
            : i18n.t('groups read-only for you')
    }`

export const GroupSetCard = ({ entry, onOpen }: Props) => {
    const { set, summary, hasData } = entry
    const readOnlyGroups = set.groups.filter((g) => !g.canWrite).length
    // The same condition, and the same wording, as the summary matrix's
    // extra column (see SummaryMatrix's showUnassigned): only a set that is
    // neither compulsory nor a data dimension can hold objects that are in
    // no group and still Ok. Showing it here as well is what keeps the card
    // and the matrix telling one story -- the card used to fold those
    // objects into a green OK number while the matrix counted them as
    // Missing.
    const showUnassigned = !set.compulsory && !set.dataDimension
    const activate = (e: React.KeyboardEvent) => {
        if (e.key === 'Enter') {
            onOpen()
        } else if (e.key === ' ' || e.key === 'Spacebar') {
            // Space's default action is scrolling the page; a button
            // reached by keyboard must not do that instead of activating.
            e.preventDefault()
            onOpen()
        }
    }
    return (
        <Card>
            <div
                className={styles.card}
                role="button"
                tabIndex={0}
                onClick={onOpen}
                onKeyDown={activate}
            >
                <div className={styles.name}>{set.displayName}</div>
                <div className={styles.badges}>
                    {set.compulsory && (
                        <Tag positive>{i18n.t('Compulsory')}</Tag>
                    )}
                    {set.dataDimension && (
                        <Tag positive>{i18n.t('Data dimension')}</Tag>
                    )}
                    <Tag neutral>{groupsLabel(set.groups.length)}</Tag>
                </div>
                {!hasData ? (
                    <div className={styles.meta}>{i18n.t('Loading…')}</div>
                ) : set.groups.length === 0 ? (
                    // Nothing was, or could have been, checked: showing the
                    // usual all-green stat block here would read as "every
                    // object passed" when in fact there is no configuration
                    // to pass or fail against. That is a configuration gap
                    // for a manager to notice, not a clean bill of health.
                    <div className={styles.meta}>
                        {i18n.t('This group set has no groups configured')}
                    </div>
                ) : (
                    <div className={styles.stats}>
                        <div className={styles.error}>
                            <div className={styles.value}>
                                {summary.conflict}
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
                                {summary.missingError + summary.missingWarning}
                            </div>
                            <div className={styles.label}>
                                {i18n.t('Missing')}
                            </div>
                        </div>
                        {showUnassigned && (
                            <div className={styles.neutral}>
                                <div className={styles.value}>
                                    {summary.unassigned}
                                </div>
                                <div className={styles.label}>
                                    {i18n.t('No group (not required)')}
                                </div>
                            </div>
                        )}
                        <div className={styles.ok}>
                            <div className={styles.value}>{summary.ok}</div>
                            <div className={styles.label}>{i18n.t('OK')}</div>
                        </div>
                    </div>
                )}
                <div className={styles.meta}>
                    {readOnlyGroups > 0
                        ? readOnlyLabel(readOnlyGroups)
                        : i18n.t('You can edit all groups')}
                </div>
            </div>
        </Card>
    )
}
