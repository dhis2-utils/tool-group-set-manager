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
const mockPhase = 'objects'
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
    return <div>{isLoading ? 'loading' : data}</div>
}

it('calls the engine and re-runs when args change', async () => {
    const { rerender } = render(<Probe x={1} />)
    await waitFor(() =>
        expect(
            screen.getByText('result:["organisationUnit",1]')
        ).toBeInTheDocument()
    )
    rerender(<Probe x={2} />)
    await waitFor(() =>
        expect(
            screen.getByText('result:["organisationUnit",2]')
        ).toBeInTheDocument()
    )
    expect(mockCall).toHaveBeenCalledTimes(2)
})
