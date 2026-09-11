import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, renderHook, waitFor } from '@testing-library/react'
import React from 'react'
import { IntegrityProvider, useIntegrity } from './useIntegrity'

jest.mock('@dhis2/app-runtime', () => ({
    useConfig: () => ({ baseUrl: 'http://server', apiVersion: 41 }),
    useDataEngine: () => ({ query: mockDataEngineQuery }),
}))

const mockDataEngineQuery = jest.fn(async () => ({
    apiDataQuery: { id: 'me1', authorities: ['ALL'] },
})) as unknown as jest.Mock<
    Promise<{ apiDataQuery: { id: string; authorities: string[] } }>,
    [unknown]
>

const mockFetcher = jest.fn()
jest.mock('@/data/fetcher', () => ({
    createFetcher: () => (path: string, init?: RequestInit) =>
        mockFetcher(path, init),
}))

const checkRows = [
    {
        name: 'org_units_not_in_compulsory_group_sets',
        code: 'OUNICGS',
        displayName: 'Org units missing compulsory group',
        isSlow: false,
    },
    {
        name: 'organisation_units_violating_exclusive_group_sets',
        code: 'OUVEGS',
        displayName: 'Org units conflicting',
        isSlow: false,
    },
    {
        name: 'data_elements_violating_exclusive_group_sets',
        code: 'DEVEGS',
        displayName: 'Data elements conflicting',
        isSlow: false,
    },
]

function jsonResponse(body: unknown, ok = true, status = 200) {
    return { ok, status, json: async () => body }
}

function deferred<T>(): {
    promise: Promise<T>
    resolve: (value: T) => void
} {
    let resolve!: (value: T) => void
    const promise = new Promise<T>((res) => {
        resolve = res
    })
    return { promise, resolve }
}

async function flush(times = 3) {
    for (let i = 0; i < times; i++) {
        await Promise.resolve()
    }
}

function defaultFetcherImpl(path: string) {
    if (path.startsWith('dataIntegrity?')) {
        return Promise.resolve(jsonResponse(checkRows))
    }
    if (path.startsWith('dataIntegrity/summary')) {
        return Promise.resolve(
            jsonResponse({
                org_units_not_in_compulsory_group_sets: {
                    count: 3,
                    finishedTime: '2026-09-01T00:00:00.000Z',
                },
                organisation_units_violating_exclusive_group_sets: {
                    count: 1,
                    finishedTime: '2026-09-01T00:00:00.000Z',
                },
                data_elements_violating_exclusive_group_sets: {
                    count: 0,
                    finishedTime: '2026-09-01T00:00:00.000Z',
                },
            })
        )
    }
    return Promise.resolve(jsonResponse({}))
}

let queryClient: QueryClient

function wrapper({ children }: { children: React.ReactNode }) {
    return (
        <QueryClientProvider client={queryClient}>
            <IntegrityProvider>{children}</IntegrityProvider>
        </QueryClientProvider>
    )
}

beforeEach(() => {
    queryClient = new QueryClient({
        defaultOptions: { queries: { retry: false } },
    })
    mockDataEngineQuery.mockReset()
    mockDataEngineQuery.mockImplementation(async () => ({
        apiDataQuery: { id: 'me1', authorities: ['ALL'] },
    }))
    mockFetcher.mockReset()
    mockFetcher.mockImplementation(defaultFetcherImpl)
})

it('never makes an integrity request when the user lacks either authority', async () => {
    mockDataEngineQuery.mockImplementation(async () => ({
        apiDataQuery: { id: 'me1', authorities: ['SOME_OTHER'] },
    }))

    const { result } = renderHook(() => useIntegrity(), { wrapper })

    await waitFor(() => expect(mockDataEngineQuery).toHaveBeenCalled())
    // give any (incorrect) async fetch a chance to fire
    await act(async () => {
        await Promise.resolve()
        await Promise.resolve()
    })

    expect(result.current.available).toBe(false)
    expect(mockFetcher).toHaveBeenCalledTimes(0)
})

it('becomes available and loads checks and summaries for an authorised user', async () => {
    const { result } = renderHook(() => useIntegrity(), { wrapper })

    await waitFor(() => expect(result.current.available).toBe(true))
    await waitFor(() => expect(result.current.checks.length).toBe(3))
    expect(
        result.current.summaries.org_units_not_in_compulsory_group_sets.count
    ).toBe(3)
    // Spec 4.5: loading checks and their cached summaries must never itself
    // trigger a run -- only a user pressing "Run now" (run()) may POST.
    expect(
        mockFetcher.mock.calls.some(
            ([, init]) => (init as RequestInit | undefined)?.method === 'POST'
        )
    ).toBe(false)
})

it('flips available to false with a null error on a 403 mid-session', async () => {
    const { result } = renderHook(() => useIntegrity(), { wrapper })
    await waitFor(() => expect(result.current.available).toBe(true))
    await waitFor(() => expect(result.current.checks.length).toBe(3))

    mockFetcher.mockImplementation((path: string) => {
        if (path.startsWith('dataIntegrity/summary')) {
            return Promise.resolve(jsonResponse({}, false, 403))
        }
        return defaultFetcherImpl(path)
    })

    await act(async () => {
        await result.current.refresh()
    })

    expect(result.current.available).toBe(false)
    expect(result.current.error).toBeNull()
})

it('run() posts then polls the summary until finishedTime advances, and clears the run names from stale', async () => {
    const { result } = renderHook(() => useIntegrity(), { wrapper })
    await waitFor(() => expect(result.current.available).toBe(true))
    await waitFor(() => expect(result.current.checks.length).toBe(3))

    act(() => {
        result.current.markStale('organisationUnit')
    })
    expect(
        result.current.stale.has('org_units_not_in_compulsory_group_sets')
    ).toBe(true)

    let pollCount = 0
    mockFetcher.mockImplementation((path: string, init?: RequestInit) => {
        if (
            path.startsWith('dataIntegrity/summary') &&
            init?.method === 'POST'
        ) {
            return Promise.resolve(jsonResponse({ httpStatus: 'OK' }))
        }
        if (path.startsWith('dataIntegrity/summary')) {
            pollCount += 1
            const finishedTime =
                pollCount === 1
                    ? '2026-09-01T00:00:00.000Z'
                    : '2026-09-11T00:00:00.000Z'
            return Promise.resolve(
                jsonResponse({
                    org_units_not_in_compulsory_group_sets: {
                        count: 5,
                        finishedTime,
                    },
                })
            )
        }
        return defaultFetcherImpl(path)
    })

    await act(async () => {
        await result.current.run(['org_units_not_in_compulsory_group_sets'])
    })

    expect(
        mockFetcher.mock.calls.some(
            ([path, init]) =>
                typeof path === 'string' &&
                path.startsWith('dataIntegrity/summary') &&
                (init as RequestInit | undefined)?.method === 'POST'
        )
    ).toBe(true)
    expect(pollCount).toBeGreaterThanOrEqual(2)
    expect(
        result.current.summaries.org_units_not_in_compulsory_group_sets
            .finishedTime
    ).toBe('2026-09-11T00:00:00.000Z')
    expect(
        result.current.stale.has('org_units_not_in_compulsory_group_sets')
    ).toBe(false)
})

it('markStale marks only checks of the given object type, and makes no request at all', async () => {
    const { result } = renderHook(() => useIntegrity(), { wrapper })
    await waitFor(() => expect(result.current.checks.length).toBe(3))

    const callsBefore = mockFetcher.mock.calls.length

    act(() => {
        result.current.markStale('dataElement')
    })

    expect(
        result.current.stale.has('data_elements_violating_exclusive_group_sets')
    ).toBe(true)
    expect(
        result.current.stale.has('org_units_not_in_compulsory_group_sets')
    ).toBe(false)
    expect(
        result.current.stale.has(
            'organisation_units_violating_exclusive_group_sets'
        )
    ).toBe(false)
    // M3 / spec 4.5: markStale sets a flag and nothing else -- it must
    // never issue a request of any kind, POST included.
    expect(mockFetcher.mock.calls.length).toBe(callsBefore)
})

// m1: a server with none of the six checks must not present as an overlay
// with nothing in it.

it('does not become available when the server resolves no checks at all', async () => {
    mockFetcher.mockImplementation((path: string) => {
        if (path.startsWith('dataIntegrity?')) {
            return Promise.resolve(jsonResponse([]))
        }
        return defaultFetcherImpl(path)
    })

    const { result } = renderHook(() => useIntegrity(), { wrapper })

    await waitFor(() =>
        expect(
            mockFetcher.mock.calls.some(([path]) =>
                (path as string).startsWith('dataIntegrity?')
            )
        ).toBe(true)
    )
    await flush()

    expect(result.current.checks).toEqual([])
    expect(result.current.available).toBe(false)
})

// m2: a transient failure's message must not stick around after a later
// success.

it('clears a previous error on a later successful refresh', async () => {
    const { result } = renderHook(() => useIntegrity(), { wrapper })
    await waitFor(() => expect(result.current.available).toBe(true))
    await waitFor(() => expect(result.current.checks.length).toBe(3))

    mockFetcher.mockImplementation((path: string) => {
        if (path.startsWith('dataIntegrity/summary')) {
            return Promise.reject(new Error('network down'))
        }
        return defaultFetcherImpl(path)
    })
    await act(async () => {
        await result.current.refresh()
    })
    expect(result.current.error).toBe('network down')

    mockFetcher.mockImplementation(defaultFetcherImpl)
    await act(async () => {
        await result.current.refresh()
    })
    expect(result.current.error).toBeNull()
})

// m3: the 403 rule must hold on all three call kinds, not only the summary
// read exercised above.

it('flips available to false with a null error on a 403 from resolveChecks', async () => {
    mockFetcher.mockImplementation((path: string) => {
        if (path.startsWith('dataIntegrity?')) {
            return Promise.resolve(jsonResponse({}, false, 403))
        }
        return defaultFetcherImpl(path)
    })

    const { result } = renderHook(() => useIntegrity(), { wrapper })

    await waitFor(() => expect(result.current.available).toBe(false))
    await flush()
    expect(result.current.error).toBeNull()
})

it('flips available to false with a null error on a 403 from startRun', async () => {
    const { result } = renderHook(() => useIntegrity(), { wrapper })
    await waitFor(() => expect(result.current.available).toBe(true))
    await waitFor(() => expect(result.current.checks.length).toBe(3))

    mockFetcher.mockImplementation((path: string, init?: RequestInit) => {
        if (
            path.startsWith('dataIntegrity/summary') &&
            init?.method === 'POST'
        ) {
            return Promise.resolve(jsonResponse({}, false, 403))
        }
        return defaultFetcherImpl(path)
    })

    await act(async () => {
        await result.current.run(['org_units_not_in_compulsory_group_sets'])
    })

    expect(result.current.available).toBe(false)
    expect(result.current.error).toBeNull()
    expect(result.current.isRunning).toBe(false)
})

it('flips available to false with a null error on a 403 from the authority check itself', async () => {
    mockDataEngineQuery.mockImplementation(async () => {
        throw new Error('me failed with HTTP 403')
    })

    const { result } = renderHook(() => useIntegrity(), { wrapper })

    await waitFor(() => expect(result.current.available).toBe(false))
    await flush()

    expect(result.current.error).toBeNull()
    expect(mockFetcher).toHaveBeenCalledTimes(0)
})

// M1: nothing must keep polling, or update state, after the provider has
// unmounted.

it('stops polling after unmount, issuing no further requests', async () => {
    const { result, unmount } = renderHook(() => useIntegrity(), { wrapper })
    await waitFor(() => expect(result.current.available).toBe(true))
    await waitFor(() => expect(result.current.checks.length).toBe(3))

    let getCallCount = 0
    const pending = deferred<ReturnType<typeof jsonResponse>>()
    mockFetcher.mockImplementation((path: string, init?: RequestInit) => {
        if (
            path.startsWith('dataIntegrity/summary') &&
            init?.method === 'POST'
        ) {
            return Promise.resolve(jsonResponse({ httpStatus: 'OK' }))
        }
        if (path.startsWith('dataIntegrity/summary')) {
            getCallCount += 1
            return pending.promise
        }
        return defaultFetcherImpl(path)
    })

    let runPromise!: Promise<void>
    act(() => {
        runPromise = result.current.run([
            'org_units_not_in_compulsory_group_sets',
        ])
    })
    await waitFor(() => expect(getCallCount).toBe(1))

    unmount()

    // Resolves with a non-advanced finishedTime -- in a live provider this
    // would schedule another poll. After unmount it must not.
    pending.resolve(
        jsonResponse({
            org_units_not_in_compulsory_group_sets: {
                count: 1,
                finishedTime: '2026-09-01T00:00:00.000Z',
            },
        })
    )
    await runPromise
    await flush()

    expect(getCallCount).toBe(1)
})

// M2: an overlapping run() call must be a no-op, not a second POST, and
// must not touch isRunning/stale out from under the call already running.

it('ignores an overlapping run() call while one is already in flight', async () => {
    const { result } = renderHook(() => useIntegrity(), { wrapper })
    await waitFor(() => expect(result.current.available).toBe(true))
    await waitFor(() => expect(result.current.checks.length).toBe(3))

    let postCount = 0
    const pending = deferred<ReturnType<typeof jsonResponse>>()
    mockFetcher.mockImplementation((path: string, init?: RequestInit) => {
        if (
            path.startsWith('dataIntegrity/summary') &&
            init?.method === 'POST'
        ) {
            postCount += 1
            return pending.promise
        }
        return defaultFetcherImpl(path)
    })

    act(() => {
        void result.current.run(['org_units_not_in_compulsory_group_sets'])
    })
    await waitFor(() => expect(postCount).toBe(1))
    expect(result.current.isRunning).toBe(true)

    await act(async () => {
        await result.current.run([
            'data_elements_violating_exclusive_group_sets',
        ])
    })

    // The overlapping call returned immediately without starting a run of
    // its own.
    expect(postCount).toBe(1)
    expect(result.current.isRunning).toBe(true)
})

// C1: a check whose finishedTime never advances (a dropped/failed
// DATA_INTEGRITY job) must not poll forever -- it must give up, clear
// isRunning, and leave a readable error, after a bounded number of polls
// rather than none.

it('gives up after finishedTime never advances, clearing isRunning and leaving a readable error', async () => {
    const { result } = renderHook(() => useIntegrity(), { wrapper })
    await waitFor(() => expect(result.current.available).toBe(true))
    await waitFor(() => expect(result.current.checks.length).toBe(3))

    act(() => {
        result.current.markStale('organisationUnit')
    })
    expect(
        result.current.stale.has('org_units_not_in_compulsory_group_sets')
    ).toBe(true)

    let getCallCount = 0
    mockFetcher.mockImplementation((path: string, init?: RequestInit) => {
        if (
            path.startsWith('dataIntegrity/summary') &&
            init?.method === 'POST'
        ) {
            return Promise.resolve(jsonResponse({ httpStatus: 'OK' }))
        }
        if (path.startsWith('dataIntegrity/summary')) {
            getCallCount += 1
            return Promise.resolve(
                jsonResponse({
                    org_units_not_in_compulsory_group_sets: {
                        count: 1,
                        // Never moves past the pre-run value.
                        finishedTime: '2026-09-01T00:00:00.000Z',
                    },
                })
            )
        }
        return defaultFetcherImpl(path)
    })

    jest.useFakeTimers()
    try {
        let runPromise!: Promise<void>
        act(() => {
            runPromise = result.current.run([
                'org_units_not_in_compulsory_group_sets',
            ])
        })

        // Drive the poll loop to completion: each cycle is a resolved
        // fetch (flushed via microtasks) followed by a backoff wait (a
        // real timer, advanced here). A generous number of iterations
        // guarantees the loop's own cap is reached well before this does.
        for (let i = 0; i < 40 && result.current.isRunning; i++) {
            await flush()
            await act(async () => {
                jest.advanceTimersByTime(60000)
                await flush()
            })
        }

        await runPromise

        expect(result.current.isRunning).toBe(false)
        expect(getCallCount).toBeGreaterThan(1)
        // Bounded: nowhere near "polls forever". A generous upper bound
        // that would only be hit by an unbounded loop.
        expect(getCallCount).toBeLessThan(100)
        expect(result.current.error).toEqual(expect.any(String))
        expect(result.current.error).not.toBeNull()
        // The result may still be stale -- a run that never confirmed
        // completion must not be treated as having cleared it.
        expect(
            result.current.stale.has('org_units_not_in_compulsory_group_sets')
        ).toBe(true)
    } finally {
        jest.useRealTimers()
    }
}, 15000)
