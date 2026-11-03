import { render, screen } from '@testing-library/react'
import React from 'react'
import { ApplyStep } from './ApplyStep'

const base = {
    isWriting: false,
    progress: null,
    writeResult: null,
    mergedOutcomes: [],
    applyError: null,
    groups: [{ id: 'g1', displayName: 'Group one' }],
}

test('shows batch progress while writing', () => {
    render(<ApplyStep {...base} isWriting progress={{ done: 2, total: 5 }} />)
    expect(screen.getByText('Applied 2 of 5 batches')).toBeInTheDocument()
})

test('says so when there was nothing to apply', () => {
    render(
        <ApplyStep
            {...base}
            writeResult={{
                outcomes: [],
                applied: [],
                unaccounted: [],
                changeSet: {} as never,
            }}
        />
    )
    expect(screen.getByText('There was nothing to apply')).toBeInTheDocument()
})

test('names a group by display name in its outcome, not by id', () => {
    render(
        <ApplyStep
            {...base}
            writeResult={{
                outcomes: [],
                applied: [],
                unaccounted: [],
                changeSet: {} as never,
            }}
            mergedOutcomes={[{ groupId: 'g1', requested: 3, accepted: 3 }]}
        />
    )
    expect(screen.getByText(/Group one/)).toBeInTheDocument()
    expect(screen.queryByText(/g1/)).not.toBeInTheDocument()
})

test('reports an unconfirmed write as its own error', () => {
    render(<ApplyStep {...base} applyError="boom" />)
    expect(
        screen.getByText('The result could not be confirmed')
    ).toBeInTheDocument()
})
