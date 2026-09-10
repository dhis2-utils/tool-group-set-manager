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
}

const fmt = (n: number) => n.toLocaleString()

export const SummaryMatrix = ({ result, onCell, flat = false }: Props) => {
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
        }
    ) => (
        <DataTableCell
            key={options.cellKey ?? options.column.kind}
            align="right"
            className={styles.cell}
            onClick={() => onCell(options.row, options.column)}
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
                    {result.rows.map((r) => (
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
                                            {i18n.t(
                                                'A compulsory group set is checked at every level, including this one'
                                            )}
                                        </div>
                                    </div>
                                )}
                            </DataTableCell>
                            {r.perGroup.map((v, g) =>
                                cell(v, {
                                    row: r.row,
                                    column: { kind: 'group', index: g },
                                    cellKey: g,
                                })
                            )}
                            {cell(r.missing, {
                                row: r.row,
                                column: { kind: 'missing' },
                                tone: 'error',
                            })}
                            {cell(r.conflict, {
                                row: r.row,
                                column: { kind: 'conflict' },
                                tone: 'error',
                            })}
                            {cell(r.total, {
                                row: r.row,
                                column: { kind: 'total' },
                            })}
                        </DataTableRow>
                    ))}
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
                </DataTableBody>
            </DataTable>
        </div>
    )
}
