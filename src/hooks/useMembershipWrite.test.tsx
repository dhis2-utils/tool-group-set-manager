import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, renderHook, waitFor } from '@testing-library/react'
import React from 'react'
import { useMembershipWrite } from './useMembershipWrite'
import { GroupSetMeta } from '@/engine/types'

jest.mock('@dhis2/app-runtime', () => ({
    useConfig: () => ({ baseUrl: 'http://server', apiVersion: 41 }),
    useDataEngine: () => ({ query: mockDataEngineQuery }),
}))

const mockDataEngineQuery = jest.fn(async () => ({
    apiDataQuery: { id: 'me1', displayName: 'Me' },
}))

const mockCall = jest.fn(async () => undefined)
const mockInvalidateType = jest.fn(async () => undefined)
jest.mock('./useEngine', () => ({
    useEngine: () => ({
        client: { call: mockCall },
        invalidateType: mockInvalidateType,
    }),
}))

let mockWriteMembershipsImpl: jest.Mock
jest.mock('@/data/writes', () => ({
    writeMemberships: (...args: unknown[]) => mockWriteMembershipsImpl(...args),
}))

const mockSaveChangeSet: jest.Mock = jest.fn(async () => undefined)
jest.mock('@/data/datastore', () => ({
    saveChangeSet: (...args: unknown[]) => mockSaveChangeSet(...args),
}))

const set: GroupSetMeta = {
    id: 'set1',
    displayName: 'Ownership',
    objectType: 'organisationUnit',
    compulsory: true,
    dataDimension: false,
    canWrite: true,
    groups: [{ id: 'g1', displayName: 'A', canWrite: true }],
}

const change = { groupId: 'g1', additions: ['a'], deletions: [] }

let queryClient: QueryClient

function wrapper({ children }: { children: React.ReactNode }) {
    return (
        <QueryClientProvider client={queryClient}>
            {children}
        </QueryClientProvider>
    )
}

beforeEach(() => {
    queryClient = new QueryClient({
        defaultOptions: { queries: { retry: false } },
    })
    mockDataEngineQuery.mockClear()
    mockCall.mockClear()
    mockInvalidateType.mockClear()
    mockSaveChangeSet.mockClear()
    mockWriteMembershipsImpl = jest.fn(async () => ({
        outcomes: [{ groupId: 'g1', requested: 1, accepted: 1 }],
        applied: [change],
        unaccounted: [],
    }))
})

it('applies exactly the confirmed changes to the engine and records a matching change set', async () => {
    const { result } = renderHook(() => useMembershipWrite(), { wrapper })
    await waitFor(() =>
        expect(queryClient.getQueryData(['me', 'identity'])).toEqual({
            id: 'me1',
            displayName: 'Me',
        })
    )

    let writeResult!: Awaited<
        ReturnType<ReturnType<typeof useMembershipWrite>['write']>
    >
    await act(async () => {
        writeResult = await result.current.write({
            set,
            changes: [change],
            action: 'move',
            note: 'move it',
        })
    })

    expect(mockCall).toHaveBeenCalledWith(
        'applyChangeSet',
        'organisationUnit',
        [change]
    )
    expect(mockInvalidateType).toHaveBeenCalledWith('organisationUnit')
    expect(writeResult.changeSet.changes).toEqual([change])
    expect(writeResult.changeSet.createdBy).toEqual({
        id: 'me1',
        displayName: 'Me',
    })
    expect(writeResult.changeSet.objectType).toBe('organisationUnit')
    expect(writeResult.changeSet.groupSetId).toBe('set1')
    expect(mockSaveChangeSet).toHaveBeenCalledWith(
        expect.anything(),
        writeResult.changeSet
    )
    expect(writeResult.historyError).toBeUndefined()
})

it('applies only what was confirmed on a partial write', async () => {
    const unaccountedChange = { groupId: 'g2', additions: ['b'], deletions: [] }
    mockWriteMembershipsImpl = jest.fn(async () => ({
        outcomes: [
            { groupId: 'g1', requested: 1, accepted: 1 },
            { groupId: 'g2', requested: 1, accepted: 0, error: 'HTTP 500' },
        ],
        applied: [change],
        unaccounted: [unaccountedChange],
    }))
    const { result } = renderHook(() => useMembershipWrite(), { wrapper })

    let writeResult!: Awaited<
        ReturnType<ReturnType<typeof useMembershipWrite>['write']>
    >
    await act(async () => {
        writeResult = await result.current.write({
            set,
            changes: [change, unaccountedChange],
            action: 'move',
            note: 'move it',
        })
    })

    expect(mockCall).toHaveBeenCalledWith(
        'applyChangeSet',
        'organisationUnit',
        [change]
    )
    expect(writeResult.changeSet.changes).toEqual([change])
    expect(writeResult.unaccounted).toEqual([unaccountedChange])
    expect(mockInvalidateType).toHaveBeenCalledWith('organisationUnit')
})

it('still applies the engine update and invalidates the cache when saving the change set fails, and surfaces the failure', async () => {
    mockSaveChangeSet.mockRejectedValueOnce(new Error('dataStore down'))
    const { result } = renderHook(() => useMembershipWrite(), { wrapper })

    let writeResult!: Awaited<
        ReturnType<ReturnType<typeof useMembershipWrite>['write']>
    >
    await act(async () => {
        writeResult = await result.current.write({
            set,
            changes: [change],
            action: 'move',
            note: 'move it',
        })
    })

    expect(mockCall).toHaveBeenCalledWith(
        'applyChangeSet',
        'organisationUnit',
        [change]
    )
    expect(mockInvalidateType).toHaveBeenCalledWith('organisationUnit')
    expect(writeResult.historyError).toBe('dataStore down')
    expect(writeResult.changeSet.changes).toEqual([change])
})

it('proceeds without blocking on identity when it has not loaded yet', async () => {
    mockDataEngineQuery.mockImplementation(() => new Promise(() => undefined))
    const { result } = renderHook(() => useMembershipWrite(), { wrapper })

    let writeResult!: Awaited<
        ReturnType<ReturnType<typeof useMembershipWrite>['write']>
    >
    await act(async () => {
        writeResult = await result.current.write({
            set,
            changes: [change],
            action: 'move',
            note: 'move it',
        })
    })

    expect(writeResult.changeSet).toBeDefined()
    expect(mockInvalidateType).toHaveBeenCalledWith('organisationUnit')
})
