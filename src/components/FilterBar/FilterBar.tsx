import React from 'react'
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

export const FilterBarField = ({
    label,
    children,
}: {
    label: string
    children: React.ReactNode
}) => (
    <div className={styles.field}>
        <span className={styles.label}>{label}</span>
        {children}
    </div>
)
