import i18n from '@dhis2/d2-i18n'
import { Tag } from '@dhis2/ui'
import React from 'react'
import styles from './IntegrityLine.module.css'
import { CheckSummary, ResolvedCheck } from '@/data/integrity'
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
// Deliberately phrased as "DHIS2 found N objects", never as a bare number
// beside the engine's own count -- the two count different populations
// (the whole hierarchy vs. this scope), and putting them side by side
// invites exactly the wrong comparison.
const resultLabel = (count: number, time: string) =>
    count === 1
        ? interpolate(
              i18n.t(
                  'DHIS2 found 1 object across the whole instance as of {time}'
              ),
              { time }
          )
        : interpolate(
              i18n.t(
                  'DHIS2 found {count} objects across the whole instance as of {time}'
              ),
              { count, time }
          )

/**
 * One line, after a card's own counts: the DHIS2-native integrity result for
 * `check`, with its run time, and a stale marker when a write this session
 * has outrun the last recorded run. `check` carries the identity Task 4's
 * detail-tab list needs to show several of these side by side (its
 * `displayName` titles the line so a reader with more than one check on
 * screen can tell them apart); this card only ever shows one.
 */
export const IntegrityLine = ({ check, summary, stale }: Props) => {
    if (summary.finishedTime === null) {
        return (
            <div className={styles.line} title={check.displayName}>
                {i18n.t(
                    'This check has not been run yet; run it from the DHIS2 integrity tab'
                )}
            </div>
        )
    }
    const time = new Date(summary.finishedTime).toLocaleString()
    return (
        <div className={styles.line} title={check.displayName}>
            <span>{resultLabel(summary.count, time)}</span>
            {stale && <Tag neutral>{i18n.t('Stale')}</Tag>}
        </div>
    )
}

IntegrityLine.displayName = 'IntegrityLine'
