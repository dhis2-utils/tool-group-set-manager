import i18n from '@dhis2/d2-i18n'
import {
    DataTable,
    DataTableBody,
    DataTableCell,
    DataTableColumnHeader,
    DataTableHead,
    DataTableRow,
} from '@dhis2/ui'
import React from 'react'
import styles from './SummaryMatrix.module.css'
import { MatrixResult, ObjectRef } from '@/engine/store'

export type MatrixColumn =
    | { kind: 'group'; index: number }
    | { kind: 'missing' }
    | { kind: 'conflict' }
    | { kind: 'total' }

interface Props {
    result: MatrixResult
    onCell: (row: ObjectRef | null, column: MatrixColumn) => void
    /**
     * True for object types with no hierarchy (data element, indicator,
     * category option). The engine always represents "no row" as `row:
     * null` (see `MatrixRow.object === -1` in `src/engine/queries.ts`), but
     * that means two different things depending on the object type: for a
     * hierarchical type it is a real leftover -- objects a compulsory set
     * still checks above the chosen row level -- while for a flat type
     * it's simply the only row there is, standing in for the whole
     * population. Rendering both cases with the same "above the row
     * level" copy would misdescribe the flat case, where there is no row
     * level at all.
     */
    flat?: boolean
    /**
     * Pre-composed, already-translated explanation of why the "above the
     * row level" row exists, shown under its heading. Every organisation
     * unit group set -- compulsory or not -- evaluates every organisation
     * unit at every level (`populationFor` in `src/engine/population.ts`
     * never restricts an org unit set's population by level), so the row
     * appears for entirely non-compulsory sets too (confirmed against the
     * Sierra Leone demo: the non-compulsory "Area" set still has a
     * non-empty above-the-row-level row). Hardcoding a "compulsory" or
     * "data dimension" explanation would therefore be just as likely to be
     * wrong as right; the caller (which knows the row level actually
     * chosen) supplies the real reason instead. Falls back to a neutral,
     * still-true default when omitted.
     */
    aboveLevelCaption?: string
}

const fmt = (n: number) => n.toLocaleString()

const DEFAULT_ABOVE_LEVEL_CAPTION = () =>
    i18n.t('Includes organisation units above the chosen row level')

const ABOVE_LEVEL_CLICK_TITLE = () =>
    i18n.t('Objects above the row level cannot be filtered yet')

export const SummaryMatrix = ({
    result,
    onCell,
    flat = false,
    aboveLevelCaption,
}: Props) => {
    const totals = {
        perGroup: result.groups.map((_, g) =>
            result.rows.reduce((s, r) => s + r.perGroup[g], 0)
        ),
        missing: result.rows.reduce((s, r) => s + r.missing, 0),
        conflict: result.rows.reduce((s, r) => s + r.conflict, 0),
        total: result.rows.reduce((s, r) => s + r.total, 0),
    }
    const cell = (
        value: number,
        options: {
            row: ObjectRef | null
            column: MatrixColumn
            tone?: 'error'
            cellKey?: React.Key
            clickable?: boolean
        }
    ) => {
        const clickable = options.clickable ?? true
        return (
            <DataTableCell
                key={options.cellKey ?? options.column.kind}
                align="right"
                className={clickable ? styles.cell : styles.cellStatic}
                onClick={
                    clickable
                        ? () => onCell(options.row, options.column)
                        : undefined
                }
                title={clickable ? undefined : ABOVE_LEVEL_CLICK_TITLE()}
            >
                <span
                    className={
                        options.tone === 'error' && value > 0
                            ? styles.error
                            : value === 0
                              ? styles.zero
                              : undefined
                    }
                >
                    {fmt(value)}
                </span>
            </DataTableCell>
        )
    }
    return (
        <div className={styles.wrap}>
            <DataTable>
                <DataTableHead>
                    <DataTableRow>
                        <DataTableColumnHeader>
                            {i18n.t('Organisation unit')}
                        </DataTableColumnHeader>
                        {result.groups.map((g) => (
                            <DataTableColumnHeader key={g.id} align="right">
                                {g.displayName}
                            </DataTableColumnHeader>
                        ))}
                        <DataTableColumnHeader align="right">
                            {i18n.t('Missing')}
                        </DataTableColumnHeader>
                        <DataTableColumnHeader align="right">
                            {i18n.t('Conflict')}
                        </DataTableColumnHeader>
                        <DataTableColumnHeader align="right">
                            {i18n.t('Total')}
                        </DataTableColumnHeader>
                    </DataTableRow>
                </DataTableHead>
                <DataTableBody>
                    {result.rows.map((r) => {
                        // The engine represents "no row" the same way (`row:
                        // null`) whether that's a flat type's sole row (the
                        // whole population -- handled above, still fully
                        // filterable) or a hierarchical leftover above the
                        // chosen row level. Only the latter has no `ancestor`
                        // to filter by: `onCell` would build a filter with a
                        // group/status but no ancestor, which silently
                        // matches every such object in the *whole* scope
                        // rather than the handful this row counted. There is
                        // no way to express "objects above this row level" in
                        // the engine's current filter, so these cells must
                        // not be clickable at all rather than lie about what
                        // they'd filter.
                        const isAboveRowLeftover = r.row === null && !flat
                        return (
                            <DataTableRow key={r.object}>
                                <DataTableCell>
                                    {r.row ? (
                                        (r.row.displayName ?? r.row.id)
                                    ) : flat ? (
                                        i18n.t('All objects')
                                    ) : (
                                        <div>
                                            <div>
                                                {i18n.t('Above the row level')}
                                            </div>
                                            <div className={styles.hint}>
                                                {aboveLevelCaption ??
                                                    DEFAULT_ABOVE_LEVEL_CAPTION()}
                                            </div>
                                        </div>
                                    )}
                                </DataTableCell>
                                {r.perGroup.map((v, g) =>
                                    cell(v, {
                                        row: r.row,
                                        column: { kind: 'group', index: g },
                                        cellKey: g,
                                        clickable: !isAboveRowLeftover,
                                    })
                                )}
                                {cell(r.missing, {
                                    row: r.row,
                                    column: { kind: 'missing' },
                                    tone: 'error',
                                    clickable: !isAboveRowLeftover,
                                })}
                                {cell(r.conflict, {
                                    row: r.row,
                                    column: { kind: 'conflict' },
                                    tone: 'error',
                                    clickable: !isAboveRowLeftover,
                                })}
                                {cell(r.total, {
                                    row: r.row,
                                    column: { kind: 'total' },
                                    clickable: !isAboveRowLeftover,
                                })}
                            </DataTableRow>
                        )
                    })}
                    {result.rows.length > 1 && (
                        <DataTableRow className={styles.totalRow}>
                            <DataTableCell>{i18n.t('Total')}</DataTableCell>
                            {totals.perGroup.map((v, g) => (
                                <DataTableCell key={g} align="right">
                                    {fmt(v)}
                                </DataTableCell>
                            ))}
                            <DataTableCell align="right">
                                {fmt(totals.missing)}
                            </DataTableCell>
                            <DataTableCell align="right">
                                {fmt(totals.conflict)}
                            </DataTableCell>
                            <DataTableCell align="right">
                                {fmt(totals.total)}
                            </DataTableCell>
                        </DataTableRow>
                    )}
                </DataTableBody>
            </DataTable>
        </div>
    )
}
