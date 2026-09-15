import React from 'react'
import styles from './FilterBar.module.css'

/**
 * One row of controls, shared by the dashboard and the group set page so a
 * field never moves between pages (spec 2026-09-15 §4.1). Every child is a
 * `FilterBarField`, which always renders a label — that is what makes the
 * row one height. Today's dashboard row mixes a label-left line, a
 * label-above select, a checkbox and a small button under
 * `align-items: center`, which is the misalignment the review reports.
 */
export const FilterBar = ({ children }: { children: React.ReactNode }) => (
    <div className={styles.bar}>
        <div className={styles.row}>{children}</div>
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
