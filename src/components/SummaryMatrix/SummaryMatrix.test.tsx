import { fireEvent, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import React from 'react'
import { SummaryMatrix } from './SummaryMatrix'

// This project's Jest config maps every `.css` import (module or not) to
// jest.identity.mock.js, which exports a plain `{}`. Unlike the project's
// real (Vite) build -- which hashes `.numericHeader` to something like
// `_numericHeader_1l7ml_39`, still containing the substring -- Jest gives
// every class name `undefined`, so `styles.numericHeader` would never reach
// the DOM here at all and no test could observe it. Supply the one class
// this file's tests need to see, matching its own name the way the real
// build's hashed name still would.
jest.mock('./SummaryMatrix.module.css', () => ({
    __esModule: true,
    default: { numericHeader: 'numericHeader' },
}))

const result = {
    groups: [
        { id: 'pub', displayName: 'Public', canWrite: true },
        { id: 'priv', displayName: 'Private', canWrite: true },
    ],
    rows: [
        {
            object: 1,
            row: {
                index: 1,
                id: 'A',
                displayName: 'Abaji',
                level: 3,
                parentId: 'r',
            },
            perGroup: [210, 388],
            missing: 61,
            unassigned: 0,
            conflict: 12,
            total: 671,
        },
        {
            object: -1,
            row: null,
            perGroup: [0, 0],
            missing: 7,
            unassigned: 0,
            conflict: 0,
            total: 7,
        },
    ],
}

it('renders group columns, rows, totals and fires onCell', async () => {
    const onCell = jest.fn()
    render(<SummaryMatrix result={result} onCell={onCell} />)
    expect(screen.getByText('Public')).toBeInTheDocument()
    expect(screen.getByText('Abaji')).toBeInTheDocument()
    expect(screen.getByText(/Above the row level/)).toBeInTheDocument()
    // Total row: 210, 388, 68, 12, 678
    expect(screen.getByText('678')).toBeInTheDocument()
    await userEvent.click(screen.getByText('61'))
    expect(onCell).toHaveBeenCalledWith(result.rows[0].row, { kind: 'missing' })
})

it('labels the sole row of a flat (non-hierarchical) object type as the whole population, not as an above-the-row-level leftover', () => {
    const flatResult = {
        groups: [{ id: 'g', displayName: 'Group', canWrite: true }],
        rows: [
            {
                object: -1,
                row: null,
                perGroup: [10],
                missing: 2,
                unassigned: 0,
                conflict: 1,
                total: 13,
            },
        ],
    }
    render(<SummaryMatrix result={flatResult} onCell={jest.fn()} flat />)
    expect(screen.getByText('All objects')).toBeInTheDocument()
    expect(screen.queryByText(/Above the row level/)).not.toBeInTheDocument()
    expect(
        screen.queryByText(/compulsory group set is checked/)
    ).not.toBeInTheDocument()
    // With exactly one data row, a separate totals row underneath is a
    // pure duplicate -- '13' (the row's total) must appear only once.
    expect(screen.getAllByText('13')).toHaveLength(1)
})

it('suppresses the totals row generally whenever there is exactly one data row, not only for flat types', () => {
    const oneRowResult = {
        groups: [{ id: 'g', displayName: 'Group', canWrite: true }],
        rows: [
            {
                object: 1,
                row: {
                    index: 1,
                    id: 'A',
                    displayName: 'Solo',
                    level: 2,
                    parentId: null,
                },
                perGroup: [3],
                missing: 1,
                unassigned: 0,
                conflict: 0,
                total: 4,
            },
        ],
    }
    render(<SummaryMatrix result={oneRowResult} onCell={jest.fn()} />)
    // '4' (the row's total) would appear a second time in a totals row.
    expect(screen.getAllByText('4')).toHaveLength(1)
})

it('does not let the aggregate "above the row level" row be filtered by clicking its cells', () => {
    const onCell = jest.fn()
    render(<SummaryMatrix result={result} onCell={onCell} />)
    const aboveRow = screen
        .getByText('Above the row level')
        .closest('tr') as HTMLTableRowElement
    const valueCells = Array.from(aboveRow.querySelectorAll('td')).slice(1)
    expect(valueCells.length).toBeGreaterThan(0)
    valueCells.forEach((td) => fireEvent.click(td))
    expect(onCell).not.toHaveBeenCalled()
})

it('shows the "no group, not required" column only when the caller asks for it, and filters by it', async () => {
    const permissive = {
        groups: [{ id: 'g', displayName: 'Group', canWrite: true }],
        rows: [
            {
                object: 1,
                row: {
                    index: 1,
                    id: 'A',
                    displayName: 'Abaji',
                    level: 3,
                    parentId: 'r',
                },
                perGroup: [4],
                missing: 0,
                unassigned: 9,
                conflict: 0,
                total: 13,
            },
        ],
    }
    const onCell = jest.fn()
    const { rerender } = render(
        <SummaryMatrix result={permissive} onCell={onCell} />
    )
    // Without the flag the column is not there at all -- for a compulsory or
    // data dimension set it could only ever be zero.
    expect(
        screen.queryByText('No group (not required)')
    ).not.toBeInTheDocument()

    rerender(
        <SummaryMatrix result={permissive} onCell={onCell} showUnassigned />
    )
    expect(screen.getByText('No group (not required)')).toBeInTheDocument()
    await userEvent.click(screen.getByText('9'))
    expect(onCell).toHaveBeenCalledWith(permissive.rows[0].row, {
        kind: 'unassigned',
    })
})

it('lets the caller say why the aggregate row exists instead of assuming a compulsory set', () => {
    const onCell = jest.fn()
    render(
        <SummaryMatrix
            result={result}
            onCell={onCell}
            aboveLevelCaption="Includes organisation units above the District level"
        />
    )
    expect(
        screen.getByText('Includes organisation units above the District level')
    ).toBeInTheDocument()
    expect(
        screen.queryByText(/compulsory group set is checked/)
    ).not.toBeInTheDocument()
})

// @dhis2/ui 10.17.0's DataTableColumnHeader `align` prop is a no-op: it
// emits a rule for a `.label` class the component never renders. Our own
// class on the header is what actually right-aligns it, so the test pins
// the class rather than a computed style jsdom would not resolve anyway.
it('marks every numeric column header as numeric', () => {
    render(<SummaryMatrix result={result} onCell={jest.fn()} />)
    const headers = screen.getAllByRole('columnheader')
    // first column is the row label; every other header is a number
    const [rowLabel, ...numeric] = headers
    expect(rowLabel).not.toHaveClass('numericHeader')
    numeric.forEach((h) => expect(h.className).toMatch(/numericHeader/))
})

// Detects only one of the ways @dhis2/ui could fix `align`: it starting to
// render an element with the literal `.label` class its own generated rule
// already targets. It would NOT catch the library fixing `align` by
// retargeting that generated selector at `.top` (the class that already
// exists) instead -- that fix leaves this assertion passing forever, so a
// human still has to notice the CHANGELOG entry.
it('would fail if @dhis2/ui started rendering the `.label` element its own align rule already targets', () => {
    const { container } = render(
        <SummaryMatrix result={result} onCell={jest.fn()} />
    )
    expect(container.querySelector('.label')).toBeNull()
})

const manyGroupsResult = {
    groups: Array.from({ length: 12 }, (_, i) => ({
        id: `g${i}`,
        displayName: `Group ${i}`,
        canWrite: true,
    })),
    rows: [
        {
            object: 1,
            row: {
                index: 1,
                id: 'A',
                displayName: 'Abaji',
                level: 3,
                parentId: 'r',
            },
            // Descending totals: group 0 has the most (110), group 11 the
            // least (0) -- so the eight shown are groups 0-7 and the four
            // hidden (8, 9, 10, 11) sum to 6 + 4 + 2 + 0 = 12.
            perGroup: [110, 100, 90, 80, 70, 60, 50, 40, 6, 4, 2, 0],
            missing: 0,
            unassigned: 0,
            conflict: 0,
            total: 612,
        },
    ],
}

it('caps the matrix at eight group columns plus an Other groups column summing the rest', () => {
    render(<SummaryMatrix result={manyGroupsResult} onCell={jest.fn()} />)
    for (let i = 0; i < 8; i++) {
        expect(screen.getByText(`Group ${i}`)).toBeInTheDocument()
    }
    for (let i = 8; i < 12; i++) {
        expect(screen.queryByText(`Group ${i}`)).not.toBeInTheDocument()
    }
    expect(screen.getByText('Other groups')).toBeInTheDocument()
    // 6 + 4 + 2 + 0, the four hidden groups' cells for this row.
    expect(screen.getByText('12')).toBeInTheDocument()
})

it('still fires onCell with the original group index (not its rank) for a shown column', async () => {
    const onCell = jest.fn()
    render(<SummaryMatrix result={manyGroupsResult} onCell={onCell} />)
    // "Group 0" is the biggest, shown first, but its original index is 0.
    await userEvent.click(screen.getByText('110'))
    expect(onCell).toHaveBeenCalledWith(manyGroupsResult.rows[0].row, {
        kind: 'group',
        index: 0,
    })
})

it('opens a picker on the Other groups cell instead of calling onCell', async () => {
    const onCell = jest.fn()
    render(<SummaryMatrix result={manyGroupsResult} onCell={onCell} />)
    await userEvent.click(screen.getByText('12'))
    expect(onCell).not.toHaveBeenCalled()
    expect(
        screen.getByText('Choose which groups to show')
    ).toBeInTheDocument()
    // Every group, including the twelfth, is offered in the picker -- the
    // panel that shares this same ranking (Task 5) must see them all too.
    expect(screen.getByText('Group 11')).toBeInTheDocument()
})

// A repeat query through the worker (src/engine/client.ts) structured-clones
// its response, so `useEngineQuery` re-issuing the same query -- which it
// does "several times per load" per its own comment, and again on reload --
// hands SummaryMatrix a brand-new `groups` array holding the very same
// group ids. A pinned selection must survive that; it should only reset
// when the matrix is genuinely showing a different set's groups.
it('keeps a pinned selection across a re-render carrying a new but identical `groups` array (a repeat query, not a set change)', async () => {
    const onCell = jest.fn()
    const { rerender } = render(
        <SummaryMatrix result={manyGroupsResult} onCell={onCell} />
    )
    // Pin a non-default set of eight: drop Group 0 (shown by default, as
    // the biggest), add Group 8 (hidden by default). Checkboxes are
    // queried by role rather than by their label text, since the same
    // group name is already on screen as a column header behind the modal.
    await userEvent.click(screen.getByText('12'))
    await userEvent.click(screen.getByRole('checkbox', { name: 'Group 0' }))
    await userEvent.click(screen.getByRole('checkbox', { name: 'Group 8' }))
    await userEvent.click(screen.getByText('Save'))
    expect(screen.queryByText('Group 0')).not.toBeInTheDocument()
    expect(screen.getByText('Group 8')).toBeInTheDocument()

    // Simulate a repeat query's structured-cloned response: a new object,
    // new arrays, but the same group ids and the same data.
    const repeatQueryResult = {
        ...manyGroupsResult,
        groups: manyGroupsResult.groups.map((g) => ({ ...g })),
        rows: manyGroupsResult.rows.map((r) => ({
            ...r,
            perGroup: [...r.perGroup],
        })),
    }
    rerender(<SummaryMatrix result={repeatQueryResult} onCell={onCell} />)
    expect(screen.queryByText('Group 0')).not.toBeInTheDocument()
    expect(screen.getByText('Group 8')).toBeInTheDocument()
})

it('drops a pinned selection once the matrix actually shows a different set (different group ids)', async () => {
    const onCell = jest.fn()
    const { rerender } = render(
        <SummaryMatrix result={manyGroupsResult} onCell={onCell} />
    )
    await userEvent.click(screen.getByText('12'))
    await userEvent.click(screen.getByRole('checkbox', { name: 'Group 0' }))
    await userEvent.click(screen.getByRole('checkbox', { name: 'Group 8' }))
    await userEvent.click(screen.getByText('Save'))
    expect(screen.getByText('Group 8')).toBeInTheDocument()

    // A different set's matrix: different group ids entirely.
    rerender(<SummaryMatrix result={result} onCell={onCell} />)
    // The stale pin is {1,2,3,4,5,6,7,8}; this set's own indices are just 0
    // and 1, so a stale, unreset pin would coincidentally still match index
    // 1 ("Private") and fold index 0 ("Public") into an Other groups column
    // instead of showing it plainly. Seeing "Public" on its own is the
    // signal that the pin was actually dropped, not just harmlessly stale.
    expect(screen.getByText('Public')).toBeInTheDocument()
    expect(screen.getByText('Private')).toBeInTheDocument()
})

it('does not let the Other groups cell in the aggregate "above the row level" row open the picker either', () => {
    const onCell = jest.fn()
    const withLeftover = {
        ...manyGroupsResult,
        rows: [
            ...manyGroupsResult.rows,
            {
                object: -1,
                row: null,
                perGroup: [0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 1, 1],
                missing: 0,
                unassigned: 0,
                conflict: 0,
                total: 4,
            },
        ],
    }
    render(<SummaryMatrix result={withLeftover} onCell={onCell} />)
    const aboveRow = screen
        .getByText('Above the row level')
        .closest('tr') as HTMLTableRowElement
    // The leftover row's Other groups cell sums to 1 + 1 + 1 + 1 = 4.
    const otherCell = Array.from(aboveRow.querySelectorAll('td')).find(
        (td) => td.textContent === '4'
    ) as HTMLTableCellElement
    expect(otherCell).toBeTruthy()
    fireEvent.click(otherCell)
    expect(onCell).not.toHaveBeenCalled()
    expect(
        screen.queryByText('Choose which groups to show')
    ).not.toBeInTheDocument()
})
