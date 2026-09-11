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
// Mutable so individual tests can exercise the client === null case (I1
// ruling 3) without a separate module mock per test.
let mockClient: { call: jest.Mock } | null = { call: mockCall }
jest.mock('./useEngine', () => ({
    useEngine: () => ({
        client: mockClient,
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

type WriteResult = Awaited<
    ReturnType<ReturnType<typeof useMembershipWrite>['write']>
>

async function doWrite(
    changes = [change],
    overrides: Partial<
        Parameters<ReturnType<typeof useMembershipWrite>['write']>[0]
    > = {}
): Promise<WriteResult> {
    const { result } = renderHook(() => useMembershipWrite(), { wrapper })
    let writeResult!: WriteResult
    await act(async () => {
        writeResult = await result.current.write({
            set,
            changes,
            action: 'move',
            note: 'move it',
            ...overrides,
        })
    })
    return writeResult
}

beforeEach(() => {
    queryClient = new QueryClient({
        defaultOptions: { queries: { retry: false } },
    })
    mockDataEngineQuery.mockClear()
    mockDataEngineQuery.mockImplementation(async () => ({
        apiDataQuery: { id: 'me1', displayName: 'Me' },
    }))
    mockCall.mockClear()
    mockCall.mockImplementation(async () => undefined)
    mockClient = { call: mockCall }
    mockInvalidateType.mockClear()
    mockSaveChangeSet.mockClear()
    mockSaveChangeSet.mockImplementation(async () => undefined)
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

    let writeResult!: WriteResult
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
    expect(writeResult.engineError).toBeUndefined()
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

    const writeResult = await doWrite([change, unaccountedChange])

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

    const writeResult = await doWrite()

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

    const writeResult = await doWrite()

    expect(writeResult.changeSet).toBeDefined()
    expect(mockInvalidateType).toHaveBeenCalledWith('organisationUnit')
})

// I1 / ruling 3: an engine rejection, or no engine client at all, must not
// abort the write -- cache invalidation and the history save must still
// happen, and the failure is reported on the result instead of thrown.

it('still invalidates the cache and records history when the engine call rejects, and surfaces engineError', async () => {
    mockCall.mockRejectedValueOnce(new Error('worker crashed'))

    const writeResult = await doWrite()

    expect(mockInvalidateType).toHaveBeenCalledWith('organisationUnit')
    expect(mockSaveChangeSet).toHaveBeenCalled()
    expect(writeResult.engineError).toBe('worker crashed')
    expect(writeResult.historyError).toBeUndefined()
    expect(writeResult.changeSet.changes).toEqual([change])
})

it('still invalidates the cache and records history when there is no engine client, and surfaces engineError', async () => {
    mockClient = null

    const writeResult = await doWrite()

    expect(mockInvalidateType).toHaveBeenCalledWith('organisationUnit')
    expect(mockSaveChangeSet).toHaveBeenCalled()
    expect(writeResult.engineError).toBeTruthy()
})

// I2: the brief calls out the order itself as the thing that matters, so
// it must be pinned directly rather than only through the two failure
// tests above (which pin that the later steps still happen, not that they
// happen in this order). Each mock pushes its own label before resolving.

it("performs the four steps in D4's order: server, engine, cache, history", async () => {
    const order: string[] = []
    mockWriteMembershipsImpl = jest.fn(async () => {
        order.push('server')
        return {
            outcomes: [{ groupId: 'g1', requested: 1, accepted: 1 }],
            applied: [change],
            unaccounted: [],
        }
    })
    mockCall.mockImplementation(async () => {
        order.push('engine')
    })
    mockInvalidateType.mockImplementation(async () => {
        order.push('cache')
    })
    mockSaveChangeSet.mockImplementation(async () => {
        order.push('history')
    })

    await doWrite()

    expect(order).toEqual(['server', 'engine', 'cache', 'history'])
})

// M3: a write that confirmed nothing must not leave a History row
// describing no change (Task 9 offers a revert on every row, and
// reverting an empty change set is a control that cannot do anything).

it('skips saving a change set when nothing was applied, but still returns one and still invalidates the cache', async () => {
    mockWriteMembershipsImpl = jest.fn(async () => ({
        outcomes: [
            { groupId: 'g1', requested: 1, accepted: 0, error: 'HTTP 500' },
        ],
        applied: [],
        unaccounted: [change],
    }))

    const writeResult = await doWrite()

    expect(mockSaveChangeSet).not.toHaveBeenCalled()
    expect(mockInvalidateType).toHaveBeenCalledWith('organisationUnit')
    expect(writeResult.changeSet.changes).toEqual([])
    expect(writeResult.historyError).toBeUndefined()
})

// M5: two overlapping writes share one counter now, not one boolean, so
// the first to finish must not clear isWriting while the second is still
// in flight.

it('keeps isWriting true while any overlapping write is still in flight', async () => {
    const resolvers: Array<() => void> = []
    mockWriteMembershipsImpl = jest.fn(
        () =>
            new Promise((resolve) => {
                resolvers.push(() =>
                    resolve({
                        outcomes: [
                            { groupId: 'g1', requested: 1, accepted: 1 },
                        ],
                        applied: [change],
                        unaccounted: [],
                    })
                )
            })
    )
    const { result } = renderHook(() => useMembershipWrite(), { wrapper })

    let p1!: Promise<WriteResult>
    let p2!: Promise<WriteResult>
    act(() => {
        p1 = result.current.write({
            set,
            changes: [change],
            action: 'move',
            note: 'a',
        })
    })
    expect(result.current.isWriting).toBe(true)

    act(() => {
        p2 = result.current.write({
            set,
            changes: [change],
            action: 'move',
            note: 'b',
        })
    })
    expect(result.current.isWriting).toBe(true)

    await act(async () => {
        resolvers[0]()
        await p1
    })
    expect(result.current.isWriting).toBe(true)

    await act(async () => {
        resolvers[1]()
        await p2
    })
    expect(result.current.isWriting).toBe(false)
})

// D1: onProgress is an optional field on the input, threaded straight
// through to writeMemberships's own progress callback (previously
// discarded as `() => undefined`).

it('threads an optional onProgress through to writeMemberships (D1)', async () => {
    let capturedOnProgress: ((done: number, total: number) => void) | undefined
    mockWriteMembershipsImpl = jest.fn(async (...args: unknown[]) => {
        const onProgress = args[3] as (done: number, total: number) => void
        capturedOnProgress = onProgress
        onProgress(1, 1)
        return {
            outcomes: [{ groupId: 'g1', requested: 1, accepted: 1 }],
            applied: [change],
            unaccounted: [],
        }
    })
    const onProgress = jest.fn()
    await doWrite([change], { onProgress })

    expect(capturedOnProgress).toBe(onProgress)
    expect(onProgress).toHaveBeenCalledWith(1, 1)
})

it('still works when onProgress is omitted', async () => {
    await expect(doWrite()).resolves.toBeDefined()
})
