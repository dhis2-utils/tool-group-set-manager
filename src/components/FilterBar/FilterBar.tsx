import React, { useId } from 'react'
import styles from './FilterBar.module.css'

/**
 * One row of controls, shared by the dashboard and the group set page so a
 * field never moves between pages (spec 2026-09-15 §4.1). Every child is a
 * `FilterBarField`, which always renders a label — that is what makes the
 * row one height. (Before this component existed, the dashboard's row
 * mixed a label-left line, a label-above select, a checkbox and a small
 * button under `align-items: center`, which is the misalignment this
 * component replaces.)
 */
export const FilterBar = ({
    children,
    status,
}: {
    children: React.ReactNode
    /**
     * Right-aligned, and deliberately not a `FilterBarField`: everything
     * else in this row is label-above because it is something you set, and
     * being the one thing shaped differently is what makes this read as
     * status rather than as another control (spec 2026-09-16 section 4.1).
     */
    status?: React.ReactNode
}) => (
    <div className={styles.bar} data-test="filter-bar">
        <div className={styles.row}>{children}</div>
        {status && <div className={styles.status}>{status}</div>}
    </div>
)

/**
 * The label is a plain span, not the select's own `label` prop (which would
 * add a second, differently styled label to the row). On its own a span
 * names nothing, so the field is a fieldset labelled by it: a screen reader
 * announces "Group set, group" as focus enters the select inside, and
 * every caller's control is named without the caller doing anything.
 */
export const FilterBarField = ({
    label,
    children,
}: {
    label: string
    children: React.ReactNode
}) => {
    const labelId = useId()
    return (
        <fieldset className={styles.field} aria-labelledby={labelId}>
            <span id={labelId} className={styles.label}>
                {label}
            </span>
            {children}
        </fieldset>
    )
}
