import i18n from '@dhis2/d2-i18n'
import { Button, Input } from '@dhis2/ui'
import React, { useMemo, useState } from 'react'
import styles from './GroupsPanel.module.css'
import { ColumnPlan, MAX_GROUP_COLUMNS } from '@/components/SummaryMatrix/columnPlan'
import { interpolate } from '@/utils/interpolate'

// Two complete strings chosen on the count, never a number glued to a
// translated word -- see CLAUDE.md's "Translatable strings".
const objectsLabel = (count: number) =>
    count === 1
        ? i18n.t('1 object')
        : interpolate(i18n.t('{count} objects'), {
              count: count.toLocaleString(),
          })

const showAllLabel = (count: number) =>
    count === 1
        ? i18n.t('Show 1 group')
        : interpolate(i18n.t('Show all {count} groups'), {
              count: count.toLocaleString(),
          })

// One complete sentence naming the term that matched nothing, rather than
// a generic "No results" glued to the term afterwards -- see CLAUDE.md's
// "Translatable strings".
const noMatchLabel = (term: string) =>
    interpolate(i18n.t('No groups match "{term}"'), { term })

/**
 * Spec 2026-09-15 §4.4. Takes the plan and the population total and
 * renders them -- it derives nothing and issues no query of its own, so
 * this panel and the matrix beside it cannot disagree about a number.
 */
export const GroupsPanel = ({
    plan,
    total,
}: {
    plan: ColumnPlan
    total: number
}) => {
    const [expanded, setExpanded] = useState(false)
    const [filter, setFilter] = useState('')
    const trimmedFilter = filter.trim()
    const rows = useMemo(() => {
        if (!expanded) {
            return plan.ranked.slice(0, MAX_GROUP_COLUMNS)
        }
        const needle = trimmedFilter.toLowerCase()
        return needle
            ? plan.ranked.filter((g) =>
                  g.group.displayName.toLowerCase().includes(needle)
              )
            : plan.ranked
    }, [plan.ranked, expanded, trimmedFilter])
    // Distinct from "nothing to show yet" (never true here -- the panel
    // only mounts once there is a population): the list is empty because
    // this specific search term matched nothing, and the user needs to
    // know that rather than see a silently blank box.
    const noMatches = expanded && trimmedFilter !== '' && rows.length === 0

    return (
        <section className={styles.panel}>
            <h3 className={styles.heading}>{i18n.t('Groups in this set')}</h3>
            {expanded && plan.ranked.length > MAX_GROUP_COLUMNS && (
                <Input
                    dense
                    value={filter}
                    placeholder={i18n.t('Filter groups by name')}
                    onChange={({ value }) => setFilter(value ?? '')}
                />
            )}
            {noMatches ? (
                <p className={styles.empty}>{noMatchLabel(trimmedFilter)}</p>
            ) : (
                // max-height in the CSS, so a 400-group set cannot push the
                // matrix off the page
                <ul className={expanded ? styles.listExpanded : styles.list}>
                    {rows.map((g) => (
                        <li key={g.group.id} className={styles.row}>
                            <span className={styles.name}>
                                {g.group.displayName}
                            </span>
                            <span className={styles.count}>
                                {objectsLabel(g.total)}
                            </span>
                            <span className={styles.bar}>
                                <i
                                    style={{
                                        width: `${total > 0 ? (g.total / total) * 100 : 0}%`,
                                    }}
                                />
                            </span>
                        </li>
                    ))}
                </ul>
            )}
            {plan.ranked.length > MAX_GROUP_COLUMNS && (
                <Button small onClick={() => setExpanded((v) => !v)}>
                    {expanded
                        ? i18n.t('Show fewer groups')
                        : showAllLabel(plan.ranked.length)}
                </Button>
            )}
        </section>
    )
}
