import i18n from '@dhis2/d2-i18n'
import { SingleSelect, SingleSelectOption } from '@dhis2/ui'
import React from 'react'
import styles from './MembershipControl.module.css'
import { GroupMeta } from '@/engine/types'
import { interpolate } from '@/utils/interpolate'

interface Props {
    groups: GroupMeta[]
    /** group positions the object currently belongs to */
    current: number[]
    disabled: boolean
    onChange: (groupIndex: number) => void
}

const SEGMENTED_MAX = 5

// One complete, translatable sentence with a placeholder, filled in
// afterwards -- not two translated fragments joined around the group name in
// English word order, which no translator can reorder. See
// src/utils/interpolate.ts for why the i18n.t call itself still takes a
// single bare string.
const keepLabel = (name: string) =>
    interpolate(i18n.t('Keep {group} and remove the others'), { group: name })

export const MembershipControl = ({
    groups,
    current,
    disabled,
    onChange,
}: Props) => {
    const isConflict = current.length > 1
    if (groups.length <= SEGMENTED_MAX) {
        return (
            <span className={styles.seg} role="group">
                {groups.map((g, i) => {
                    const state = current.includes(i)
                        ? isConflict
                            ? 'conflict'
                            : 'selected'
                        : 'none'
                    return (
                        <button
                            key={g.id}
                            type="button"
                            className={styles.segButton}
                            data-state={state}
                            disabled={disabled}
                            title={
                                isConflict
                                    ? keepLabel(g.displayName)
                                    : g.displayName
                            }
                            onClick={() => onChange(i)}
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
        <span className={styles.dropdownWrap}>
            <SingleSelect
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
                onChange={({ selected: value }) => onChange(Number(value))}
                filterable={groups.length > 10}
                noMatchText={i18n.t('No group matches')}
            >
                {groups.map((g, i) => (
                    <SingleSelectOption
                        key={g.id}
                        value={String(i)}
                        label={
                            current.includes(i) && isConflict
                                ? interpolate(i18n.t('{group} (current)'), {
                                      group: g.displayName,
                                  })
                                : g.displayName
                        }
                    />
                ))}
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
