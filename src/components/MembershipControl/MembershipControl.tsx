import i18n from '@dhis2/d2-i18n'
import { SingleSelect, SingleSelectOption } from '@dhis2/ui'
import React from 'react'
import styles from './MembershipControl.module.css'
import type { GroupMeta } from '@/engine/types'
import { interpolate } from '@/utils/interpolate'

interface Props {
    groups: GroupMeta[]
    /** group positions the object currently belongs to */
    current: number[]
    /**
     * Whole-control disable, for the case where no move is possible at
     * all: one of the object's *current* groups is read-only for the
     * user, so there is no group it could be moved to without first
     * failing to leave one it is already in. See `disabledReason`.
     */
    disabled: boolean
    /**
     * Why the whole control is disabled, named for the user (D2). Reuses
     * the control's existing `title` mechanism (the segmented buttons'
     * own tooltip, or a wrapper title around the dropdown) rather than
     * adding a new visual element to a virtualised row. Ignored while
     * `disabled` is false.
     */
    disabledReason?: string
    /**
     * Let the user deselect the object's only group: clicking the selected
     * button again, or clearing the dropdown, passes `NO_GROUP`. Only for a
     * set that is not compulsory, where being in no group is allowed (or,
     * for a data dimension, only a warning).
     */
    allowNone?: boolean
    /** A group position, or `NO_GROUP` to remove the object from every group. */
    onChange: (groupIndex: number) => void
}

/** The choice "in no group of this set", passed to `onChange`. */
export const NO_GROUP = -1

const removeLabel = (name: string) =>
    interpolate(i18n.t('Click again to remove from {group}'), { group: name })

/** Up to this many groups the control is a row of buttons, above it a dropdown. */
export const SEGMENTED_MAX = 5

// One complete, translatable sentence with a placeholder, filled in
// afterwards -- not two translated fragments joined around the group name in
// English word order, which no translator can reorder. See
// src/utils/interpolate.ts for why the i18n.t call itself still takes a
// single bare string.
const keepLabel = (name: string) =>
    interpolate(i18n.t('Keep {group} and remove the others'), { group: name })

// I1: a read-only *target* is a per-option fact, independent of whether the
// control as a whole is enabled -- an object whose current groups are all
// writable can still not be moved into a specific group it has no write
// access to. Disabling only that option (rather than the whole control, or
// leaving it clickable) is what stops a doomed write that could otherwise
// remove the object from every writable group it holds while the addition
// to the read-only target is rejected, leaving it in no group at all.
const readOnlyTargetLabel = (name: string) =>
    interpolate(i18n.t('{group} is read-only for you'), { group: name })

export const MembershipControl = ({
    groups,
    current,
    disabled,
    disabledReason,
    allowNone = false,
    onChange,
}: Props) => {
    const isConflict = current.length > 1
    // The object's only group can be deselected, which removes the object
    // from it (a conflict is resolved by choosing a group to keep instead).
    const deselectable = allowNone && current.length === 1
    if (groups.length <= SEGMENTED_MAX) {
        return (
            // oxlint-disable-next-line jsx-a11y/prefer-tag-over-role -- role=group gives the segmented control group semantics without a fieldset's border and legend layout
            <span className={styles.seg} role="group">
                {groups.map((g, i) => {
                    const state = current.includes(i)
                        ? isConflict
                            ? 'conflict'
                            : 'selected'
                        : 'none'
                    const optionDisabled = disabled || !g.canWrite
                    const deselect = deselectable && state === 'selected'
                    const title =
                        disabled && disabledReason
                            ? disabledReason
                            : !g.canWrite
                              ? readOnlyTargetLabel(g.displayName)
                              : isConflict
                                ? keepLabel(g.displayName)
                                : deselect
                                  ? removeLabel(g.displayName)
                                  : g.displayName
                    return (
                        <button
                            key={g.id}
                            type="button"
                            className={styles.segButton}
                            data-state={state}
                            data-read-only={!g.canWrite}
                            aria-pressed={state === 'selected'}
                            disabled={optionDisabled}
                            title={title}
                            onClick={() => onChange(deselect ? NO_GROUP : i)}
                        >
                            {g.displayName}
                        </button>
                    )
                })}
            </span>
        )
    }
    const selected = current.length === 1 ? String(current[0]) : ''
    // For this branch (more than five groups), the conflicting group
    // *names* otherwise live only inside the dropdown's own option labels
    // -- and a disabled `SingleSelect` cannot be opened at all, so a
    // conflict row here would say only "there is a conflict", never which
    // two groups it is between. That is the app's headline case, so the
    // names are surfaced as plain text next to the control instead of
    // being locked inside it.
    const conflictGroupNames = isConflict
        ? current
              .map((i) => groups[i]?.displayName)
              .filter((name): name is string => Boolean(name))
        : []
    return (
        <span
            className={styles.dropdownWrap}
            title={disabled && disabledReason ? disabledReason : undefined}
        >
            <SingleSelect
                className={styles.select}
                dense
                disabled={disabled}
                selected={selected}
                placeholder={
                    // One whole string per case rather than two translated
                    // fragments joined by a colon. (The colon is gone as
                    // well: this project's i18next-scanner reads a colon
                    // inside an i18n.t() string as its default namespace
                    // separator and warns that the namespace does not exist
                    // -- confirmed against the scanner's own output while
                    // running `pnpm start` for the browser check.)
                    isConflict
                        ? i18n.t('Conflict, choose the group to keep')
                        : i18n.t('Choose group')
                }
                // Clearing the select is how its only group is deselected.
                clearable={deselectable}
                clearText={i18n.t('Remove from this group')}
                onChange={({ selected: value }) =>
                    onChange(value ? Number(value) : NO_GROUP)
                }
                filterable={groups.length > 10}
                noMatchText={i18n.t('No group matches')}
            >
                {groups.map((g, i) => {
                    const baseLabel =
                        current.includes(i) && isConflict
                            ? interpolate(i18n.t('{group} (current)'), {
                                  group: g.displayName,
                              })
                            : g.displayName
                    // I1: same per-option disable as the segmented branch --
                    // a read-only target must not be choosable even while
                    // the rest of the control is enabled.
                    return (
                        <SingleSelectOption
                            key={g.id}
                            value={String(i)}
                            disabled={!g.canWrite}
                            label={
                                g.canWrite
                                    ? baseLabel
                                    : interpolate(
                                          i18n.t('{group} (read-only for you)'),
                                          { group: baseLabel }
                                      )
                            }
                        />
                    )
                })}
            </SingleSelect>
            {conflictGroupNames.length > 0 && (
                <span
                    className={styles.conflictNames}
                    title={conflictGroupNames.join(', ')}
                >
                    {interpolate(i18n.t('Conflict between {groups}'), {
                        groups: conflictGroupNames.join(', '),
                    })}
                </span>
            )}
        </span>
    )
}
