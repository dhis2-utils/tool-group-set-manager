import i18n from '@dhis2/d2-i18n'
import type { ChangeSet, GroupSetProperties } from '@/engine/changeSet'
import { GROUP_SET_PROPERTY_KEYS, isPending } from '@/engine/changeSet'
import { interpolate } from '@/utils/interpolate'

export const actionLabel = (changeSet: ChangeSet): string => {
    switch (changeSet.action) {
        case 'move':
            return i18n.t('Moved to a group')
        case 'assign':
            return i18n.t('Assigned to a group')
        case 'unassign':
            return i18n.t('Removed from its group')
        case 'properties':
            return i18n.t('Changed group set properties')
        case 'revert':
            return i18n.t('Reverted an earlier change')
        default:
            return changeSet.action
    }
}

/** Spec 5.4's "number of membership changes": every addition and deletion the change set recorded, across every group it touched. */
export function membershipChangeCount(changeSet: ChangeSet): number {
    return changeSet.changes.reduce(
        (sum, c) => sum + c.additions.length + c.deletions.length,
        0
    )
}

const changeCountLabel = (count: number) =>
    count === 1
        ? i18n.t('1 membership change')
        : interpolate(i18n.t('{count} membership changes'), {
              count: count.toLocaleString(),
          })

/** One whole sentence per property and direction, never a property name spliced into a verb. */
export function propertyChangeLabel(
    key: keyof GroupSetProperties,
    value: boolean
): string {
    if (key === 'compulsory') {
        return value
            ? i18n.t('Compulsory turned on')
            : i18n.t('Compulsory turned off')
    }
    return value
        ? i18n.t('Data dimension turned on')
        : i18n.t('Data dimension turned off')
}

const pendingLabel = (confirmed: number, planned: number) =>
    planned === 1
        ? interpolate(
              i18n.t(
                  'Interrupted or still running, {confirmed} of 1 change confirmed'
              ),
              { confirmed: confirmed.toLocaleString() }
          )
        : interpolate(
              i18n.t(
                  'Interrupted or still running, {confirmed} of {planned} changes confirmed'
              ),
              {
                  confirmed: confirmed.toLocaleString(),
                  planned: planned.toLocaleString(),
              }
          )

/** The Changes column: one line per property for a property change, else the membership count. */
export function changeSummary(changeSet: ChangeSet): string[] {
    const { properties } = changeSet
    if (properties) {
        return GROUP_SET_PROPERTY_KEYS.flatMap((key) => {
            const value = properties.after[key]
            return value === undefined ? [] : [propertyChangeLabel(key, value)]
        })
    }
    const count = membershipChangeCount(changeSet)
    if (isPending(changeSet)) {
        return [pendingLabel(count, changeSet.planned ?? count)]
    }
    return [changeCountLabel(count)]
}

export const missingGroupSetLabel = () =>
    i18n.t(
        'This group set no longer exists, so this change cannot be reverted from here'
    )

export const restrictedGroupSetLabel = () =>
    i18n.t(
        'You cannot see all groups of this group set, so this change cannot be reverted from here'
    )

export const groupSetsLoadFailedLabel = () =>
    i18n.t(
        'Group set information could not be loaded, so this change cannot be reverted from here'
    )

export const revertWindowClosedLabel = () =>
    i18n.t('Can no longer be reverted (older than 24 hours)')

export const nothingConfirmedLabel = () =>
    i18n.t(
        'Nothing was confirmed before this change stopped, so there is nothing to revert'
    )

export const notRecordedLabel = () =>
    i18n.t(
        'The revert was applied but could not itself be recorded in History, so it cannot in turn be reverted from here'
    )

export const readOnlyGroupSetLabel = () =>
    i18n.t('Cannot be reverted, because you cannot edit this group set')

export const readOnlyGroupsLabel = () =>
    i18n.t(
        'Cannot be reverted, because some groups in this set are read-only for you'
    )
