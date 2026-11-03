import { render, screen } from '@testing-library/react'
import React from 'react'
import { CHECK_TIMEOUT } from './constants'
import { PreviewStep } from './PreviewStep'

const plan = { changes: [], affected: 3, skippedCount: 0, skippedSample: [] }
const base = {
    action: 'moveToCatchAll' as const,
    filterText: undefined,
    plan,
    planLoading: false,
    planError: null,
    checkingFreshness: false,
    checkError: null,
    recheck: null,
    groups: [],
    previewObjects: {
        total: 3,
        sample: [],
        skippedCount: 0,
        skippedSample: [],
    },
    csvBusy: false,
    csvError: null,
    onDownloadCsv: jest.fn(),
    note: '',
    onNoteChange: jest.fn(),
}

test('headlines the affected count', () => {
    render(<PreviewStep {...base} />)
    expect(screen.getByText('3 objects')).toBeInTheDocument()
})

test('shows the checking indicator while the freshness check runs', () => {
    render(<PreviewStep {...base} checkingFreshness />)
    expect(
        screen.getByText('Checking the metadata is up to date…')
    ).toBeInTheDocument()
})

test('distinguishes a timed-out check from any other check failure', () => {
    const { rerender } = render(
        <PreviewStep {...base} checkError={CHECK_TIMEOUT} />
    )
    expect(
        screen.getByText('Checking the metadata took too long')
    ).toBeInTheDocument()
    rerender(<PreviewStep {...base} checkError="HTTP 502" />)
    expect(
        screen.getByText('The metadata could not be checked')
    ).toBeInTheDocument()
})

test('shows the previewed and recalculated counts when the plan changed underneath', () => {
    render(
        <PreviewStep
            {...base}
            recheck={{
                previewed: 517,
                recomputed: { ...plan, affected: 42 },
            }}
        />
    )
    expect(
        screen.getByText('The metadata changed while you were reviewing')
    ).toBeInTheDocument()
    // Distinct, unswappable values (not '5'/'4', which both still pass if
    // the two counts are swapped), each asserted through its own label so
    // the test fails if `previewed` and `recomputed.affected` are mixed up.
    expect(
        screen.getByText(
            (_, element) => element?.textContent === 'Previewed: 517'
        )
    ).toBeInTheDocument()
    expect(
        screen.getByText(
            (_, element) => element?.textContent === 'Will now change: 42'
        )
    ).toBeInTheDocument()
})
