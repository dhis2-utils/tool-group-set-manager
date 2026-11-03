import i18n from '@dhis2/d2-i18n'
import { Tag } from '@dhis2/ui'
import React from 'react'
import styles from './IntegrityLine.module.css'
import type { CheckSummary, ResolvedCheck } from '@/data/integrity'
import { interpolate } from '@/utils/interpolate'

interface Props {
    check: ResolvedCheck
    summary: CheckSummary
    stale: boolean
}

// Same reasoning as GroupSetCard's groupsLabel/readOnlyLabel: two complete,
// argument-free i18n.t() calls chosen on count === 1, each with the value
// placed afterwards through interpolate() rather than glued on or passed as
// a second i18n.t() argument (which the scanner cannot see).
//
// P3-R5 (review round 1, M1): finding 5 established that neither integrity
// endpoint takes an org unit or a group set parameter -- the count is
// national and spans every group set of the object type, never scoped to
// the one set whose card this line sits on. "across the whole instance"
// alone only disclaims the *geographic* scope; it says nothing about the
// *set* scope, so a reader could still read the number as this set's own.
// The sentence must say both: which check produced the number (named
// in-line, not hidden in a `title` attribute -- invisible on hover-only,
// absent on touch, unreliable to a screen reader) and that it spans every
// group set, not just this one.
const resultLabel = (check: string, count: number, time: string) =>
    count === 1
        ? interpolate(
              i18n.t(
                  'DHIS2 check {check} found 1 object across all group sets on this instance as of {time}'
              ),
              { check, time }
          )
        : interpolate(
              i18n.t(
                  'DHIS2 check {check} found {count} objects across all group sets on this instance as of {time}'
              ),
              // m1 (final review): every other count-rendering site on the
              // branch thousands-formats -- Task 8 item 4's sweep missed
              // this file (and IntegrityTab.tsx, fixed alongside it).
              { check, count: count.toLocaleString(), time }
          )

const neverRunLabel = (check: string) =>
    interpolate(
        i18n.t(
            'The {check} check has not been run yet; run it from the DHIS2 integrity tab'
        ),
        { check }
    )

/**
 * One line, after a card's own counts: the DHIS2-native integrity result for
 * `check`, with its run time, and a stale marker when a write this session
 * has outrun the last recorded run. The check's `displayName` is always part
 * of the visible sentence (never a `title`-only attribute) -- see the M1
 * comment on `resultLabel` above. `check` also carries the identity Task 4's
 * detail-tab list needs to show several of these side by side; this card
 * only ever shows one.
 */
export const IntegrityLine = ({ check, summary, stale }: Props) => {
    if (summary.finishedTime === null) {
        return (
            <div className={styles.line}>
                {neverRunLabel(check.displayName)}
            </div>
        )
    }
    const time = new Date(summary.finishedTime).toLocaleString()
    return (
        <div className={styles.line}>
            <span>{resultLabel(check.displayName, summary.count, time)}</span>
            {stale && <Tag neutral>{i18n.t('Stale')}</Tag>}
        </div>
    )
}

IntegrityLine.displayName = 'IntegrityLine'
