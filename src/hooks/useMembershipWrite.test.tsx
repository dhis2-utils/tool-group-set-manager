import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, renderHook, waitFor } from '@testing-library/react'
import React from 'react'
import { useMembershipWrite } from './useMembershipWrite'
import type { ChangeSet } from '@/engine/changeSet'
import type { GroupSetMeta } from '@/engine/types'

const mockDataEngineQuery = jest.fn(() =>
    Promise.resolve({
        apiDataQuery: { id: 'me1', displayName: 'Me' },
    })
)

jest.mock('@dhis2/app-runtime', () => ({
    useConfig: () => ({ baseUrl: 'http://server', apiVersion: 41 }),
    useDataEngine: () => ({ query: mockDataEngineQuery }),
}))

const mockCall = jest.fn(() => Promise.resolve(undefined))
const mockInvalidateType = jest.fn(() => Promise.resolve(undefined))
// Mutable so individual tests can exercise the client === null case (I1
// ruling 3) without a separate module mock per test.
let mockClient: { call: jest.Mock } | null = { call: mockCall }
jest.mock('./useEngine', () => ({
    useEngine: () => ({
        client: mockClient,
        invalidateType: mockInvalidateType,
    }),
}))

const mockMarkStale = jest.fn()
jest.mock('./useIntegrity', () => ({
    useIntegrity: () => ({
        markStale: mockMarkStale,
    }),
}))

let mockWriteMembershipsImpl: jest.Mock
jest.mock('@/data/writes', () => ({
    ...jest.requireActual('@/data/writes'),
    writeMemberships: (...args: unknown[]) => mockWriteMembershipsImpl(...args),
}))

const mockSaveChangeSet: jest.Mock = jest.fn(() => Promise.resolve(undefined))
const mockDeleteChangeSet: jest.Mock = jest.fn(() => Promise.resolve(undefined))
jest.mock('@/data/datastore', () => ({
    saveChangeSet: (...args: unknown[]) => mockSaveChangeSet(...args),
    deleteChangeSet: (...args: unknown[]) => mockDeleteChangeSet(...args),
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
    mockDataEngineQuery.mockResolvedValue({
        apiDataQuery: { id: 'me1', displayName: 'Me' },
    })
    mockCall.mockClear()
    mockCall.mockResolvedValue(undefined)
    mockClient = { call: mockCall }
    mockInvalidateType.mockClear()
    mockMarkStale.mockClear()
    mockMarkStale.mockImplementation(() => undefined)
    mockSaveChangeSet.mockClear()
    mockSaveChangeSet.mockResolvedValue(undefined)
    mockDeleteChangeSet.mockClear()
    mockDeleteChangeSet.mockResolvedValue(undefined)
    mockWriteMembershipsImpl = jest.fn(() =>
        Promise.resolve({
            outcomes: [{ groupId: 'g1', requested: 1, accepted: 1 }],
            applied: [change],
            unaccounted: [],
        })
    )
})

test('applies exactly the confirmed changes to the engine and records a matching change set', async () => {
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

test('applies only what was confirmed on a partial write', async () => {
    const unaccountedChange = { groupId: 'g2', additions: ['b'], deletions: [] }
    mockWriteMembershipsImpl = jest.fn(() =>
        Promise.resolve({
            outcomes: [
                { groupId: 'g1', requested: 1, accepted: 1 },
                { groupId: 'g2', requested: 1, accepted: 0, error: 'HTTP 500' },
            ],
            applied: [change],
            unaccounted: [unaccountedChange],
        })
    )

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

test('still applies the engine update and invalidates the cache when saving the change set fails, and surfaces the failure', async () => {
    mockSaveChangeSet.mockRejectedValue(new Error('dataStore down'))

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

test('proceeds without blocking on identity when it has not loaded yet', async () => {
    mockDataEngineQuery.mockImplementation(() => new Promise(() => {}))

    const writeResult = await doWrite()

    expect(writeResult.changeSet).toBeDefined()
    expect(mockInvalidateType).toHaveBeenCalledWith('organisationUnit')
})

// I1 / ruling 3: an engine rejection, or no engine client at all, must not
// abort the write -- cache invalidation and the history save must still
// happen, and the failure is reported on the result instead of thrown.

test('still invalidates the cache and records history when the engine call rejects, and surfaces engineError', async () => {
    mockCall.mockRejectedValueOnce(new Error('worker crashed'))

    const writeResult = await doWrite()

    expect(mockInvalidateType).toHaveBeenCalledWith('organisationUnit')
    expect(mockSaveChangeSet).toHaveBeenCalled()
    expect(writeResult.engineError).toBe('worker crashed')
    expect(writeResult.historyError).toBeUndefined()
    expect(writeResult.changeSet.changes).toEqual([change])
})

test('still invalidates the cache and records history when there is no engine client, and surfaces engineError', async () => {
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

test("performs the steps in D4's order: pending history, server, engine, cache, history", async () => {
    const order: string[] = []
    mockWriteMembershipsImpl = jest.fn(() => {
        order.push('server')
        return Promise.resolve({
            outcomes: [{ groupId: 'g1', requested: 1, accepted: 1 }],
            applied: [change],
            unaccounted: [],
        })
    })
    mockCall.mockImplementation(() => {
        order.push('engine')
        return Promise.resolve(undefined)
    })
    mockInvalidateType.mockImplementation(() => {
        order.push('cache')
        return Promise.resolve(undefined)
    })
    mockSaveChangeSet.mockImplementation((_f: unknown, cs: ChangeSet) => {
        order.push(cs.status === 'pending' ? 'pending' : 'history')
        return Promise.resolve()
    })

    await doWrite()

    expect(order).toEqual(['pending', 'server', 'engine', 'cache', 'history'])
})

// M3: a write that confirmed nothing must not leave a History row
// describing no change (Task 9 offers a revert on every row, and
// reverting an empty change set is a control that cannot do anything).

test('removes the pending record when nothing was applied, but still returns a change set and still invalidates the cache', async () => {
    mockWriteMembershipsImpl = jest.fn(() =>
        Promise.resolve({
            outcomes: [
                { groupId: 'g1', requested: 1, accepted: 0, error: 'HTTP 500' },
            ],
            applied: [],
            unaccounted: [change],
        })
    )

    const writeResult = await doWrite()

    expect(mockSaveChangeSet).toHaveBeenCalledTimes(1)
    expect(mockSaveChangeSet.mock.calls[0][1]).toMatchObject({
        status: 'pending',
    })
    expect(mockDeleteChangeSet).toHaveBeenCalledWith(
        expect.anything(),
        writeResult.changeSet.id
    )
    expect(mockInvalidateType).toHaveBeenCalledWith('organisationUnit')
    expect(writeResult.changeSet.changes).toEqual([])
    expect(writeResult.historyError).toBeUndefined()
})

// M5: two overlapping writes share one counter now, not one boolean, so
// the first to finish must not clear isWriting while the second is still
// in flight.

test('keeps isWriting true while any overlapping write is still in flight', async () => {
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
    await waitFor(() => expect(resolvers).toHaveLength(2))

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

test('threads an optional onProgress through to writeMemberships (D1)', async () => {
    let capturedOnProgress: ((done: number, total: number) => void) | undefined
    mockWriteMembershipsImpl = jest.fn((...args: unknown[]) => {
        const onProgress = args[3] as (done: number, total: number) => void
        capturedOnProgress = onProgress
        onProgress(1, 1)
        return Promise.resolve({
            outcomes: [{ groupId: 'g1', requested: 1, accepted: 1 }],
            applied: [change],
            unaccounted: [],
        })
    })
    const onProgress = jest.fn()
    await doWrite([change], { onProgress })

    expect(capturedOnProgress).toBe(onProgress)
    expect(onProgress).toHaveBeenCalledWith(1, 1)
})

test('still works when onProgress is omitted', async () => {
    await expect(doWrite()).resolves.toBeDefined()
})

// Task 2: a successful write marks the checks for the written object type
// stale, in the same place invalidateType is called.

test('marks the checks stale for the written object type after a successful write', async () => {
    await doWrite()

    expect(mockMarkStale).toHaveBeenCalledWith('organisationUnit')
    expect(mockMarkStale).toHaveBeenCalledTimes(1)
})

// The hook never chooses a batch size. `writeMemberships`' default is also
// what `takesPatchRoute` (and so BulkFixDialog's freshness re-read) uses,
// so a batchSize appearing here would silently desync the two -- this pair
// of tests is what would fail.
test('passes completeMembers through, and no batch size', async () => {
    const completeMembers = new Map([['g1', ['existing1']]])

    await doWrite([change], { completeMembers })

    expect(mockWriteMembershipsImpl).toHaveBeenCalledWith(
        expect.anything(),
        'organisationUnit',
        [change],
        expect.any(Function),
        { completeMembers, onChangeSettled: expect.any(Function) }
    )
})

test('still writes when completeMembers is omitted, passing none through', async () => {
    const writeResult = await doWrite()

    const options = mockWriteMembershipsImpl.mock.calls[0][4] as Record<
        string,
        unknown
    >
    expect(options).toEqual({
        completeMembers: undefined,
        onChangeSettled: expect.any(Function),
    })
    expect(Object.keys(options)).not.toContain('batchSize')
    expect(writeResult.changeSet).toBeDefined()
})

test('still resolves the write when markStale throws', async () => {
    mockMarkStale.mockImplementation(() => {
        throw new Error('boom')
    })

    const writeResult = await doWrite()

    expect(writeResult.changeSet).toBeDefined()
    expect(mockInvalidateType).toHaveBeenCalledWith('organisationUnit')
    expect(mockSaveChangeSet).toHaveBeenCalled()
})

// M3: History is written before the server is, so a write that stops
// partway still leaves a revertible row for what it finished.

test('saves a pending record before writing, then replaces it with the finished one under the same id', async () => {
    const order: string[] = []
    mockSaveChangeSet.mockImplementation((_f: unknown, cs: ChangeSet) => {
        order.push(cs.status === 'pending' ? 'pending' : 'final')
        return Promise.resolve()
    })
    mockWriteMembershipsImpl = jest.fn(() => {
        order.push('server')
        return Promise.resolve({
            outcomes: [{ groupId: 'g1', requested: 1, accepted: 1 }],
            applied: [change],
            unaccounted: [],
        })
    })

    const writeResult = await doWrite([
        change,
        { groupId: 'g2', additions: ['b', 'c', 'd'], deletions: [] },
    ])

    expect(order).toEqual(['pending', 'server', 'final'])
    expect(mockSaveChangeSet.mock.calls[0][1]).toMatchObject({
        id: writeResult.changeSet.id,
        status: 'pending',
        planned: 4,
        changes: [],
    })
    const final = mockSaveChangeSet.mock.calls[1][1] as ChangeSet
    expect(final).toEqual(writeResult.changeSet)
    expect(final.id).toBe(writeResult.changeSet.id)
    expect('status' in final).toBe(false)
    expect('planned' in final).toBe(false)
})

test('updates the pending record with what each finished group confirmed', async () => {
    const second = { groupId: 'g2', additions: ['b'], deletions: [] }
    mockWriteMembershipsImpl = jest.fn(async (...args: unknown[]) => {
        const options = args[4] as {
            onChangeSettled?: (applied: unknown[]) => Promise<void>
        }
        await options.onChangeSettled?.([change])
        return {
            outcomes: [
                { groupId: 'g1', requested: 1, accepted: 1 },
                { groupId: 'g2', requested: 1, accepted: 1 },
            ],
            applied: [change, second],
            unaccounted: [],
        }
    })

    await doWrite([change, second])

    const saved = mockSaveChangeSet.mock.calls.map(
        (call) => call[1] as ChangeSet
    )
    expect(saved.map((cs) => [cs.status, cs.changes])).toEqual([
        ['pending', []],
        ['pending', [change]],
        [undefined, [change, second]],
    ])
})

test('an interrupted write leaves the pending record holding what it confirmed', async () => {
    mockWriteMembershipsImpl = jest.fn(async (...args: unknown[]) => {
        const options = args[4] as {
            onChangeSettled?: (applied: unknown[]) => Promise<void>
        }
        await options.onChangeSettled?.([change])
        // The tab closes here: the write never settles.
        return new Promise(() => {
            // never settles
        })
    })
    const { result } = renderHook(() => useMembershipWrite(), { wrapper })
    act(() => {
        void result.current.write({
            set,
            changes: [
                change,
                { groupId: 'g2', additions: ['b'], deletions: [] },
            ],
            action: 'move',
            note: '',
        })
    })

    await waitFor(() => expect(mockSaveChangeSet).toHaveBeenCalledTimes(2))
    expect(mockSaveChangeSet.mock.calls[1][1]).toMatchObject({
        status: 'pending',
        planned: 2,
        changes: [change],
    })
})

test('still writes and records the result when the pending save fails', async () => {
    mockSaveChangeSet
        .mockRejectedValueOnce(new Error('dataStore down'))
        .mockResolvedValue(undefined)

    const writeResult = await doWrite()

    expect(mockWriteMembershipsImpl).toHaveBeenCalled()
    expect(writeResult.historyError).toBeUndefined()
    expect(mockSaveChangeSet).toHaveBeenLastCalledWith(
        expect.anything(),
        writeResult.changeSet
    )
})

test('still records history and resolves when invalidating the cache fails', async () => {
    mockInvalidateType.mockRejectedValueOnce(new Error('IndexedDB blocked'))

    const writeResult = await doWrite()

    expect(writeResult.historyError).toBeUndefined()
    expect(mockSaveChangeSet).toHaveBeenLastCalledWith(
        expect.anything(),
        writeResult.changeSet
    )
    expect(mockMarkStale).toHaveBeenCalledWith('organisationUnit')
})
