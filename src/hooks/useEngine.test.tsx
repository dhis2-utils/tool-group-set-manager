import { render, screen, waitFor } from '@testing-library/react'
import React from 'react'
import { EngineProvider, useEngine } from './useEngine'

jest.mock('@dhis2/app-runtime', () => ({
    useConfig: () => ({ baseUrl: 'http://localhost:8080', apiVersion: 41 }),
}))

const mockLoadAll = jest.fn(async ({ onStatus }) => {
    onStatus({
        phase: 'done',
        type: null,
        progress: null,
        fromCache: {},
        errors: {},
    })
    return { groupSets: [{ id: 's1' }] }
})
jest.mock('@/data/loadAll', () => ({
    loadAll: (deps: unknown) => mockLoadAll(deps),
}))
jest.mock('@/data/sources/selectSource', () => ({
    selectSource: async () => ({
        source: { kind: 'metadata' },
        sqlViews: null,
    }),
}))
jest.mock('@/data/cache', () => ({
    openCache: () => ({
        get: async () => undefined,
        put: async () => undefined,
        clear: async () => undefined,
    }),
}))
jest.mock('@/engine/client', () => ({
    EngineClient: class {
        call = jest.fn()
        terminate = jest.fn()
    },
}))
jest.mock('@/engine/createWorker', () => ({
    createEngineWorker: () => ({}),
}))

const Probe = () => {
    const { status, groupSets, sourceKind } = useEngine()
    return (
        <div>
            <span>{status?.phase ?? 'none'}</span>
            <span>{groupSets.length}</span>
            <span>{sourceKind ?? 'unknown'}</span>
        </div>
    )
}

it('loads on mount and exposes status, group sets and source kind', async () => {
    render(
        <EngineProvider>
            <Probe />
        </EngineProvider>
    )
    await waitFor(() => expect(screen.getByText('done')).toBeInTheDocument())
    expect(screen.getByText('1')).toBeInTheDocument()
    expect(screen.getByText('metadata')).toBeInTheDocument()
    expect(mockLoadAll).toHaveBeenCalledTimes(1)
})
