import i18n from '@dhis2/d2-i18n'
import { Card, Tag } from '@dhis2/ui'
import React from 'react'
import styles from './GroupSetCard.module.css'
import type { RestrictedGroupSet } from '@/data/groupSets'
import { groupsLabel } from '@/utils/groupsLabel'
import { restrictedSetLabel } from '@/utils/restrictedSetLabel'

/**
 * A group set the user can see but not check, because some of its groups
 * are not shared with them. Deliberately not a control: there is no page to
 * open and no count to show, since any number computed without those groups
 * would be wrong.
 */
export const RestrictedGroupSetCard = ({
    set,
}: {
    set: RestrictedGroupSet
}) => (
    <Card>
        <div
            className={styles.restricted}
            data-test="restricted-group-set-card"
        >
            <div className={styles.restrictedName}>{set.displayName}</div>
            <div className={styles.badges}>
                <Tag neutral>{i18n.t('Not checked')}</Tag>
                <Tag neutral>{groupsLabel(set.totalGroups)}</Tag>
            </div>
            <div className={styles.meta}>
                {restrictedSetLabel(set.hiddenGroups, set.totalGroups)}
            </div>
        </div>
    </Card>
)
