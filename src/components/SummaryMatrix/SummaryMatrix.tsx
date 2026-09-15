import i18n from '@dhis2/d2-i18n'
import {
    Button,
    ButtonStrip,
    Checkbox,
    DataTable,
    DataTableBody,
    DataTableCell,
    DataTableColumnHeader,
    DataTableHead,
    DataTableRow,
    Modal,
    ModalActions,
    ModalContent,
    ModalTitle,
} from '@dhis2/ui'
import React, { useEffect, useMemo, useState } from 'react'
import { MAX_GROUP_COLUMNS, planColumns } from './columnPlan'
import styles from './SummaryMatrix.module.css'
import { MatrixResult, ObjectRef } from '@/engine/store'
import { groupsLabel } from '@/utils/groupsLabel'
import { interpolate } from '@/utils/interpolate'

export type MatrixColumn =
    | { kind: 'group'; index: number }
    | { kind: 'missing' }
    | { kind: 'unassigned' }
    | { kind: 'conflict' }
    | { kind: 'total' }

interface Props {
    result: MatrixResult
    onCell: (row: ObjectRef | null, column: MatrixColumn) => void
    /**
     * Drills one level deeper into the row clicked. Absent for a flat
     * object type (data element, indicator, category option) -- there is
     * no hierarchy to descend, and (per `flat`'s own doc) that type's sole
     * row has `row: null` anyway, so it could never be handed a row to
     * drill into. When present, only a row with a real `row` (never the
     * "above the row level" pseudo-row, which stands for objects with no
     * single ancestor and is equally not clickable for filtering) renders
     * its label as a control.
     */
    onDrillDown?: (row: ObjectRef) => void
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
    /**
     * Whether to show the "no group, and that is allowed" column. It can only
     * ever be non-zero for a set that is neither compulsory nor a data
     * dimension (spec 3.2 gives an object with no group Status.Ok only
     * then), so for every other set it would be a column of zeroes inviting
     * a manager to wonder what it means. The caller knows the set; this
     * component only knows the rows.
     */
    showUnassigned?: boolean
}

const fmt = (n: number) => n.toLocaleString()

const DEFAULT_ABOVE_LEVEL_CAPTION = () =>
    i18n.t('Includes organisation units above the chosen row level')

const ABOVE_LEVEL_CLICK_TITLE = () =>
    i18n.t('Objects above the row level cannot be filtered yet')

export const SummaryMatrix = ({
    result,
    onCell,
    onDrillDown,
    flat = false,
    aboveLevelCaption,
    showUnassigned = false,
}: Props) => {
    // Spec §4.2: an explicit choice persists while the user stays on that set
    // and is dropped on leaving it. `result.groups` is NOT a stable proxy for
    // "still the same set": `matrixFor` runs in a Web Worker
    // (src/engine/client.ts), so every response is structured-cloned and
    // gets a brand-new `groups` array even for a byte-identical query, and
    // `useEngineQuery` re-issues that query on every `status.phase` /
    // `status.type` change -- by its own comment, "several times per load"
    // during ordinary progressive loading, and again on an explicit reload.
    // Keying the reset on `result.groups`'s object identity would silently
    // wipe a user's pinned columns mid-load or on reload, well before they
    // actually left the set. The group ids themselves, though, only change
    // when the matrix really is showing a different set's groups.
    const groupKey = result.groups.map((g) => g.id).join(',')
    const [pinnedGroups, setPinnedGroups] = useState<number[] | undefined>(
        undefined
    )
    useEffect(() => {
        setPinnedGroups(undefined)
    }, [groupKey])

    const plan = useMemo(
        () => planColumns(result, pinnedGroups),
        [result, pinnedGroups]
    )
    const showOther = plan.other.length > 0

    const [pickerOpen, setPickerOpen] = useState(false)
    const [draftSelected, setDraftSelected] = useState<number[]>([])
    const openPicker = () => {
        setDraftSelected(plan.shown.map((g) => g.index))
        setPickerOpen(true)
    }
    const toggleGroup = (index: number) => {
        setDraftSelected((prev) =>
            prev.includes(index)
                ? prev.filter((i) => i !== index)
                : prev.length >= MAX_GROUP_COLUMNS
                  ? prev
                  : [...prev, index]
        )
    }
    const confirmPicker = () => {
        setPinnedGroups(draftSelected)
        setPickerOpen(false)
    }
    const resetPicker = () => {
        setPinnedGroups(undefined)
        setPickerOpen(false)
    }

    const totals = {
        other: plan.other.reduce((s, g) => s + g.total, 0),
        missing: result.rows.reduce((s, r) => s + r.missing, 0),
        unassigned: result.rows.reduce((s, r) => s + r.unassigned, 0),
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
    // The Other groups cell opens the picker rather than filtering (spec
    // §4.2): `ObjectFilter.group` is a single index and cannot express "in
    // some of N groups", so this deliberately never calls `onCell`.
    const otherGroupsCell = (
        value: number,
        row: ObjectRef | null,
        clickable: boolean
    ) => (
        <DataTableCell
            key="other"
            align="right"
            className={clickable ? styles.cell : styles.cellStatic}
            onClick={clickable ? () => openPicker() : undefined}
            title={clickable ? undefined : ABOVE_LEVEL_CLICK_TITLE()}
        >
            <span className={value === 0 ? styles.zero : undefined}>
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
                        {plan.shown.map((g) => (
                            <DataTableColumnHeader
                                key={g.group.id}
                                align="right"
                                className={styles.numericHeader}
                            >
                                {g.group.displayName}
                            </DataTableColumnHeader>
                        ))}
                        {showOther && (
                            <DataTableColumnHeader
                                align="right"
                                className={styles.numericHeader}
                            >
                                {i18n.t('Other groups')}
                            </DataTableColumnHeader>
                        )}
                        {showUnassigned && (
                            <DataTableColumnHeader
                                align="right"
                                className={styles.numericHeader}
                            >
                                {i18n.t('No group (not required)')}
                            </DataTableColumnHeader>
                        )}
                        <DataTableColumnHeader
                            align="right"
                            className={styles.numericHeader}
                        >
                            {i18n.t('Missing')}
                        </DataTableColumnHeader>
                        <DataTableColumnHeader
                            align="right"
                            className={styles.numericHeader}
                        >
                            {i18n.t('Conflict')}
                        </DataTableColumnHeader>
                        <DataTableColumnHeader
                            align="right"
                            className={styles.numericHeader}
                        >
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
                                        onDrillDown ? (
                                            <button
                                                type="button"
                                                className={styles.rowLabel}
                                                onClick={() =>
                                                    onDrillDown(
                                                        r.row as ObjectRef
                                                    )
                                                }
                                            >
                                                {r.row.displayName ?? r.row.id}
                                            </button>
                                        ) : (
                                            r.row.displayName ?? r.row.id
                                        )
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
                                {plan.shown.map((g) =>
                                    cell(r.perGroup[g.index], {
                                        row: r.row,
                                        column: {
                                            kind: 'group',
                                            index: g.index,
                                        },
                                        cellKey: g.index,
                                        clickable: !isAboveRowLeftover,
                                    })
                                )}
                                {showOther &&
                                    otherGroupsCell(
                                        plan.other.reduce(
                                            (s, g) => s + r.perGroup[g.index],
                                            0
                                        ),
                                        r.row,
                                        !isAboveRowLeftover
                                    )}
                                {showUnassigned &&
                                    cell(r.unassigned, {
                                        row: r.row,
                                        column: { kind: 'unassigned' },
                                        clickable: !isAboveRowLeftover,
                                    })}
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
                            {plan.shown.map((g) => (
                                <DataTableCell key={g.index} align="right">
                                    {fmt(g.total)}
                                </DataTableCell>
                            ))}
                            {showOther && (
                                <DataTableCell align="right">
                                    {fmt(totals.other)}
                                </DataTableCell>
                            )}
                            {showUnassigned && (
                                <DataTableCell align="right">
                                    {fmt(totals.unassigned)}
                                </DataTableCell>
                            )}
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
            {pickerOpen && (
                <Modal onClose={() => setPickerOpen(false)} position="middle">
                    <ModalTitle>
                        {i18n.t('Choose which groups to show')}
                    </ModalTitle>
                    <ModalContent>
                        <p>
                            {interpolate(
                                i18n.t(
                                    'Choose up to {max} groups to show as their own columns; the rest are added together in Other groups.'
                                ),
                                { max: MAX_GROUP_COLUMNS }
                            )}
                        </p>
                        <div className={styles.pickerList}>
                            {plan.ranked.map((g) => {
                                const checked = draftSelected.includes(
                                    g.index
                                )
                                return (
                                    <div
                                        key={g.group.id}
                                        className={styles.pickerRow}
                                    >
                                        <Checkbox
                                            checked={checked}
                                            label={g.group.displayName}
                                            disabled={
                                                !checked &&
                                                draftSelected.length >=
                                                    MAX_GROUP_COLUMNS
                                            }
                                            onChange={() =>
                                                toggleGroup(g.index)
                                            }
                                        />
                                        <span className={styles.pickerTotal}>
                                            {fmt(g.total)}
                                        </span>
                                    </div>
                                )
                            })}
                        </div>
                        <p>{groupsLabel(draftSelected.length)}</p>
                    </ModalContent>
                    <ModalActions>
                        <ButtonStrip end>
                            <Button onClick={resetPicker}>
                                {i18n.t('Reset')}
                            </Button>
                            <Button onClick={() => setPickerOpen(false)}>
                                {i18n.t('Cancel')}
                            </Button>
                            <Button primary onClick={confirmPicker}>
                                {i18n.t('Save')}
                            </Button>
                        </ButtonStrip>
                    </ModalActions>
                </Modal>
            )}
        </div>
    )
}
