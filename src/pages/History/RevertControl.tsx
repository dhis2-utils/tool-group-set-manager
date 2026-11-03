import i18n from '@dhis2/d2-i18n'
import { Button } from '@dhis2/ui'
import React from 'react'
import styles from './History.module.css'
import {
    groupSetsLoadFailedLabel,
    missingGroupSetLabel,
    nothingConfirmedLabel,
    revertWindowClosedLabel,
} from './labels'
import { canStillRevert } from '@/data/revertWindow'
import type { ChangeSet } from '@/engine/changeSet'
import { isPropertiesChange } from '@/engine/changeSet'

export interface GroupSetState {
    /** Group sets have loaded and this one is among them. */
    exists: boolean
    /** Group sets have loaded and this one is not among them. */
    missing: boolean
    /** Loading group sets failed, so nothing is known either way. */
    loadFailed: boolean
}

/** Why a row cannot be reverted, or undefined when it can (or it is too early to say). */
function blockedReason(
    changeSet: ChangeSet,
    groupSet: GroupSetState,
    now: number
): string | undefined {
    if (!canStillRevert(changeSet, now)) {
        return revertWindowClosedLabel()
    }
    if (!isPropertiesChange(changeSet) && changeSet.changes.length === 0) {
        return nothingConfirmedLabel()
    }
    if (groupSet.missing) {
        return missingGroupSetLabel()
    }
    if (groupSet.loadFailed) {
        return groupSetsLoadFailedLabel()
    }
    return undefined
}

/**
 * A row's Revert action, or the reason there is none. M12: the reason is
 * visible text, not a hover-only tooltip on a disabled button, so keyboard
 * and screen reader users get it too.
 */
export const RevertControl = ({
    changeSet,
    groupSet,
    now,
    onRevert,
}: {
    changeSet: ChangeSet
    groupSet: GroupSetState
    now: number
    onRevert: () => void
}) => {
    const reason = blockedReason(changeSet, groupSet, now)
    if (reason) {
        return <span className={styles.windowClosed}>{reason}</span>
    }
    if (!groupSet.exists) {
        // Still loading: nothing is known yet either way, so Revert waits
        // (disabled, no reason) rather than accusing.
        return (
            <Button small disabled>
                {i18n.t('Revert')}
            </Button>
        )
    }
    return (
        <Button small onClick={onRevert}>
            {i18n.t('Revert')}
        </Button>
    )
}
