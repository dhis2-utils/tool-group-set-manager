import i18n from '@dhis2/d2-i18n'
import { Card, Tag } from '@dhis2/ui'
import React from 'react'
import styles from './GroupSetCard.module.css'
import { IntegrityLine } from '@/components/IntegrityLine/IntegrityLine'
import { CheckSummary, LogicalCheck, ResolvedCheck } from '@/data/integrity'
import { usageApplies } from '@/data/sources/usageSqlView'
import { DashboardEntry } from '@/engine/store'
import { ObjectType } from '@/engine/types'
import { useIntegrity } from '@/hooks/useIntegrity'
import { useUsage } from '@/hooks/useUsage'
import { favouritesLabel } from '@/utils/favouritesLabel'
import { groupsLabel } from '@/utils/groupsLabel'
import { interpolate } from '@/utils/interpolate'

interface Props {
    entry: DashboardEntry
    onOpen: () => void
    onOpenUsage: () => void
}

const readOnlyLabel = (count: number) =>
    count === 1
        ? i18n.t('1 group read-only for you')
        : interpolate(i18n.t('{count} groups read-only for you'), {
              count: count.toLocaleString(),
          })

/**
 * P3-R5 (review round 1, M1): the check shown must be one the set on screen
 * actually enforces, never merely "the first check for this object type" --
 * the compulsory check and the exclusive-groups check for the same object
 * type measure different rules, and showing the wrong one under a set's own
 * counts misattributes a number that is already instance-wide (finding 5)
 * to a rule the set does not even follow. So selection reads the set's own
 * `compulsory` flag, not just its `objectType`: a compulsory set shows the
 * compulsory-membership check (org units only -- no other object type has
 * one, per OBJECT_TYPE_OF in src/data/integrity.ts), every other set shows
 * its type's exclusive-groups ("conflicting") check. A set for which the
 * applicable logical check never resolved on this server shows nothing --
 * never a check that does not concern it.
 */
const CONFLICT_LOGICAL_OF: Record<ObjectType, LogicalCheck> = {
    organisationUnit: 'orgUnitsConflicting',
    dataElement: 'dataElementsConflicting',
    indicator: 'indicatorsConflicting',
    categoryOption: 'categoryOptionsConflicting',
}

function checkFor(
    checks: ResolvedCheck[],
    set: { objectType: ObjectType; compulsory: boolean }
): ResolvedCheck | undefined {
    const logical: LogicalCheck =
        set.compulsory && set.objectType === 'organisationUnit'
            ? 'orgUnitsMissingCompulsory'
            : CONFLICT_LOGICAL_OF[set.objectType]
    return checks.find((c) => c.logical === logical)
}

export const GroupSetCard = ({ entry, onOpen, onOpenUsage }: Props) => {
    const { set, summary, hasData } = entry
    const readOnlyGroups = set.groups.filter((g) => !g.canWrite).length
    const { available, checks, summaries, stale } = useIntegrity()
    const usage = useUsage()
    // Only a set whose type can be an analytics dimension, on an instance
    // that actually has the usage view, shows anything here. Everything
    // else renders nothing at all -- not a dash, not a zero (the same rule
    // the integrity line below already follows).
    const setUsage =
        usage.status === 'ready' && usageApplies(set.objectType)
            ? usage.forSet(set.id)
            : null
    // A user without the overlay (available === false, the normal case for
    // a district manager) gets nothing from this at all -- not an empty
    // element, not a placeholder, not a dash. `relevantCheck` stays
    // undefined and the block below renders nothing.
    const relevantCheck = available ? checkFor(checks, set) : undefined
    const relevantSummary: CheckSummary | undefined = relevantCheck
        ? summaries[relevantCheck.name]
        : undefined
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
                                    {i18n.t('No group (not required)')}
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
                        <span>{favouritesLabel(setUsage.favourites)}</span>
                        {setUsage.favourites === 0 && (
                            <button
                                type="button"
                                className={styles.unusedTag}
                                onClick={(e) => {
                                    // The whole card is itself a button;
                                    // without this the card's own onOpen
                                    // would fire too and land the user on
                                    // the Overview tab instead.
                                    e.stopPropagation()
                                    onOpenUsage()
                                }}
                                onKeyDown={(e) => {
                                    // Fix round 2 (Minor promoted): the
                                    // mouse path stops propagation above,
                                    // but a keydown on this inner button
                                    // still bubbled to the card's own
                                    // `activate` handler -- Space hit
                                    // `preventDefault` there and suppressed
                                    // this button's own activation
                                    // (navigating to Overview instead of
                                    // Usage), and Enter fired `onOpen` on
                                    // the bubbled keydown *and* `onOpenUsage`
                                    // on the resulting click, with only
                                    // ordering deciding which one "won".
                                    e.stopPropagation()
                                }}
                            >
                                {i18n.t('Appears unused')}
                            </button>
                        )}
                    </div>
                )}
                {relevantCheck && relevantSummary && (
                    <IntegrityLine
                        check={relevantCheck}
                        summary={relevantSummary}
                        stale={stale.has(relevantCheck.name)}
                    />
                )}
            </div>
        </Card>
    )
}
