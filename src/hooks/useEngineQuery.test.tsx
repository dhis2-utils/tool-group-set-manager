import { render, screen, waitFor } from '@testing-library/react'
import React from 'react'
import { useEngineQuery } from './useEngineQuery'

// babel-plugin-jest-hoist only allows a jest.mock() factory to reference
// out-of-scope variables whose names start with "mock" (see the matching
// comment in Dashboard.test.tsx), since jest.mock() calls are hoisted above
// other top-level statements in this file.
const mockCall = jest.fn(
    async (_m: string, ...args: unknown[]) => `result:${JSON.stringify(args)}`
)
let mockPhase = 'objects'
jest.mock('./useEngine', () => ({
    useEngine: () => ({
        client: { call: mockCall },
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
    const { data, isLoading } = useEngineQuery<string>('indexOf', [
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
    mockCall.mockClear()
})

const data = () => screen.getByTestId('data')

it('calls the engine and re-runs when args change', async () => {
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

it('clears data when the args change, so no consumer sees a result for a query it has stopped asking', async () => {
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

it('keeps the current data when only the engine load phase changes', async () => {
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
