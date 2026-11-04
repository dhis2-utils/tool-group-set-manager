import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import React from 'react'
import { useEngineQuery } from './useEngineQuery'

// babel-plugin-jest-hoist only allows a jest.mock() factory to reference
// out-of-scope variables whose names start with "mock" (see the matching
// comment in Dashboard.test.tsx), since jest.mock() calls are hoisted above
// other top-level statements in this file.
const mockCall = jest.fn((_m: string, ...args: unknown[]) =>
    Promise.resolve(`result:${JSON.stringify(args)}`)
)
let mockPhase = 'objects'
let mockRevision = 0
jest.mock('./useEngine', () => ({
    useEngine: () => ({
        client: { call: mockCall },
        revision: mockRevision,
        status: {
            phase: mockPhase,
            type: null,
            progress: null,
            fromCache: {},
            errors: {},
        },
    }),
}))

const Probe = ({ x }: { x: number }) => {
    const { data, isLoading } = useEngineQuery<string>('levelOf', [
        'organisationUnit',
        x,
    ])
    return (
        <div>
            <div data-test="state">{isLoading ? 'loading' : 'idle'}</div>
            <div data-test="data">{data ?? 'no-data'}</div>
        </div>
    )
}

afterEach(() => {
    mockPhase = 'objects'
    mockRevision = 0
    mockCall.mockClear()
})

const data = () => screen.getByTestId('data')

test('calls the engine and re-runs when args change', async () => {
    const { rerender } = render(<Probe x={1} />)
    await waitFor(() =>
        expect(data()).toHaveTextContent('result:["organisationUnit",1]')
    )
    rerender(<Probe x={2} />)
    await waitFor(() =>
        expect(data()).toHaveTextContent('result:["organisationUnit",2]')
    )
    expect(mockCall).toHaveBeenCalledTimes(2)
})

test('clears data when the args change, so no consumer sees a result for a query it has stopped asking', async () => {
    // The objects table appends pages; left holding the previous filter's
    // page 0 while the new filter's page 0 was in flight, it folded those
    // rows into the new, freshly reset list and then rejected the real
    // response for good. A result belongs to the args it was asked for.
    const { rerender } = render(<Probe x={1} />)
    await waitFor(() =>
        expect(data()).toHaveTextContent('result:["organisationUnit",1]')
    )

    rerender(<Probe x={2} />)
    // Synchronously after the re-render, before the new call resolves.
    expect(data()).toHaveTextContent('no-data')
    expect(screen.getByTestId('state')).toHaveTextContent('loading')

    await waitFor(() =>
        expect(data()).toHaveTextContent('result:["organisationUnit",2]')
    )
})

test('keeps the current data when only the engine load phase changes', async () => {
    // The precise other half: this effect also re-runs on every load phase
    // and type change, and those re-runs ask the same question -- clearing
    // there would blank an already rendered matrix repeatedly during a load.
    const { rerender } = render(<Probe x={1} />)
    await waitFor(() =>
        expect(data()).toHaveTextContent('result:["organisationUnit",1]')
    )

    // The mocked useEngine reads this at render time, so re-rendering the
    // same component with it changed is exactly a load phase change.
    mockPhase = 'names'
    rerender(<Probe x={1} />)
    expect(data()).toHaveTextContent('result:["organisationUnit",1]')
    expect(screen.getByTestId('state')).toHaveTextContent('loading')
    expect(mockCall).toHaveBeenCalledTimes(2)
})

test('refetch re-issues the same call after a failure and clears the error once it succeeds', async () => {
    mockCall.mockRejectedValueOnce(new Error('worker went away'))
    const RetryProbe = () => {
        const {
            data: value,
            error,
            refetch,
        } = useEngineQuery<string>('levelOf', ['organisationUnit', 7])
        return (
            <div>
                <div data-test="error">{error ?? 'no-error'}</div>
                <div data-test="data">{value ?? 'no-data'}</div>
                <button type="button" onClick={refetch}>
                    retry
                </button>
            </div>
        )
    }
    render(<RetryProbe />)
    await waitFor(() =>
        expect(screen.getByTestId('error')).toHaveTextContent(
            'worker went away'
        )
    )
    fireEvent.click(screen.getByRole('button', { name: 'retry' }))
    await waitFor(() =>
        expect(data()).toHaveTextContent('result:["organisationUnit",7]')
    )
    expect(screen.getByTestId('error')).toHaveTextContent('no-error')
    expect(mockCall).toHaveBeenCalledTimes(2)
})

test('M9c: re-asks when the engine revision moves, as after a write', async () => {
    const { rerender } = render(<Probe x={1} />)
    await waitFor(() => expect(mockCall).toHaveBeenCalledTimes(1))
    mockRevision = 1
    rerender(<Probe x={1} />)
    await waitFor(() => expect(mockCall).toHaveBeenCalledTimes(2))
})
