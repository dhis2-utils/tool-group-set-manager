import i18n from '@dhis2/d2-i18n'
import { SingleSelect, SingleSelectOption } from '@dhis2/ui'
import React from 'react'
import styles from './MembershipControl.module.css'
import { GroupMeta } from '@/engine/types'

interface Props {
    groups: GroupMeta[]
    /** group positions the object currently belongs to */
    current: number[]
    disabled: boolean
    onChange: (groupIndex: number) => void
}

const SEGMENTED_MAX = 5

// A second argument to i18n.t (interpolation options, including
// defaultValue_plural) makes this project's i18next-scanner treat the
// whole call as unextractable -- see the matching comment in
// GroupSetCard.tsx. The dynamic group name is spliced in with plain JS
// templating instead.
const keepLabel = (name: string) =>
    `${i18n.t('Keep')} ${name} ${i18n.t('and remove the others')}`

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
    return (
        <SingleSelect
            dense
            disabled={disabled}
            selected={selected}
            placeholder={
                // A colon inside an i18n.t() string is read by this
                // project's i18next-scanner as a namespace separator (its
                // default `nsSeparator`), which splits "Conflict: choose
                // group to keep" into namespace "Conflict" plus key
                // " choose group to keep" and warns that the namespace
                // doesn't exist -- confirmed against the scanner's own
                // output while running `pnpm start` for the browser check.
                // Spliced outside the call instead, the same way
                // GroupSetDetail.tsx builds "Scope: {name}".
                isConflict
                    ? `${i18n.t('Conflict')}: ${i18n.t('choose group to keep')}`
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
                            ? `${g.displayName} (${i18n.t('current')})`
                            : g.displayName
                    }
                />
            ))}
        </SingleSelect>
    )
}
