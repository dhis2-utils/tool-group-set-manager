import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, renderHook, waitFor } from '@testing-library/react'
import React from 'react'
import { IntegrityProvider, useIntegrity } from './useIntegrity'

const mockDataEngineQuery = jest.fn(() =>
    Promise.resolve({
        apiDataQuery: { id: 'me1', authorities: ['ALL'] },
    })
) as unknown as jest.Mock<
    Promise<{ apiDataQuery: { id: string; authorities: string[] } }>,
    [unknown]
>

jest.mock('@dhis2/app-runtime', () => ({
    useConfig: () => ({ baseUrl: 'http://server', apiVersion: 41 }),
    useDataEngine: () => ({ query: mockDataEngineQuery }),
}))

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
    return { ok, status, json: () => Promise.resolve(body) }
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
        // oxlint-disable-next-line no-await-in-loop -- one microtask per round is the point of flush()
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
    mockDataEngineQuery.mockResolvedValue({
        apiDataQuery: { id: 'me1', authorities: ['ALL'] },
    })
    mockFetcher.mockReset()
    mockFetcher.mockImplementation(defaultFetcherImpl)
})

test('never makes an integrity request when the user lacks either authority', async () => {
    mockDataEngineQuery.mockResolvedValue({
        apiDataQuery: { id: 'me1', authorities: ['SOME_OTHER'] },
    })

    const { result } = renderHook(() => useIntegrity(), { wrapper })

    await waitFor(() => expect(mockDataEngineQuery).toHaveBeenCalled())
    // give any (incorrect) async fetch a chance to fire
    await act(async () => {
        await Promise.resolve()
        await Promise.resolve()
    })

    expect(result.current.available).toBe(false)
    expect(mockFetcher).not.toHaveBeenCalled()
})

test('becomes available and loads checks and summaries for an authorised user', async () => {
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

test('flips available to false with a null error on a 403 mid-session', async () => {
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

test('run() posts then polls the summary until finishedTime advances, and clears the run names from stale', async () => {
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
    // Counts only GETs made *after* `run()`'s own pre-POST baseline read
    // (which also hits this path, and must not itself count as a poll) --
    // an independent counter from summary's, so this fixture's two GET
    // handlers cannot cross-contaminate each other's advancement timing.
    let detailsPollCount = 0
    mockFetcher.mockImplementation((path: string, init?: RequestInit) => {
        if (
            (path.startsWith('dataIntegrity/summary') ||
                path.startsWith('dataIntegrity/details')) &&
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
        // The details job advances on the same poll tick as summary here --
        // the "details lands a tick later" case has its own dedicated test
        // below. The pre-POST baseline read (detailsPollCount === 0) always
        // reports the old value, exactly like a real "before this run"
        // snapshot would.
        if (path.startsWith('dataIntegrity/details')) {
            detailsPollCount += 1
            const finishedTime =
                detailsPollCount <= 2
                    ? '2026-09-01T00:00:00.000Z'
                    : '2026-09-11T00:00:00.000Z'
            return Promise.resolve(
                jsonResponse({
                    org_units_not_in_compulsory_group_sets: {
                        issues: [],
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

// C1 (final review): `run()` used to start a SUMMARY run only. The
// integrity tab's in-scope count, unknown-id count and issue list are all
// read from the *details* endpoint (`readDetails`, a GET against a
// separately-cached result), which a summary-only run never populates --
// measured live against a 2.43.1 instance to return `{}` forever, no
// matter how many times "Run now" refreshed the summary. `run()` must also
// start a details run for the same checks.
test('run() also starts a DETAILS run for the same checks, not summary only', async () => {
    const { result } = renderHook(() => useIntegrity(), { wrapper })
    await waitFor(() => expect(result.current.available).toBe(true))
    await waitFor(() => expect(result.current.checks.length).toBe(3))

    let pollCount = 0
    let detailsPollCount = 0
    mockFetcher.mockImplementation((path: string, init?: RequestInit) => {
        if (
            (path.startsWith('dataIntegrity/summary') ||
                path.startsWith('dataIntegrity/details')) &&
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
        if (path.startsWith('dataIntegrity/details')) {
            detailsPollCount += 1
            const finishedTime =
                detailsPollCount <= 2
                    ? '2026-09-01T00:00:00.000Z'
                    : '2026-09-11T00:00:00.000Z'
            return Promise.resolve(
                jsonResponse({
                    org_units_not_in_compulsory_group_sets: {
                        issues: [],
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

    const detailsPostCalls = mockFetcher.mock.calls.filter(
        ([path, init]) =>
            typeof path === 'string' &&
            path.startsWith('dataIntegrity/details') &&
            (init as RequestInit | undefined)?.method === 'POST'
    )
    expect(detailsPostCalls).toHaveLength(1)
    expect(detailsPostCalls[0][0]).toBe(
        'dataIntegrity/details?checks=org_units_not_in_compulsory_group_sets'
    )
})

// m4 (final review): `run` used to close over `summaries` directly, so its
// identity (and, with it, the whole `IntegrityState` memo) changed on every
// poll iteration inside `run` itself. Harmless while nothing puts `run` in
// an effect dependency list, but a `summariesRef` removes the hazard rather
// than relying on no consumer ever doing that.
test("run's identity does not change when summaries update", async () => {
    const { result, rerender } = renderHook(() => useIntegrity(), { wrapper })
    await waitFor(() => expect(result.current.available).toBe(true))
    await waitFor(() => expect(result.current.checks.length).toBe(3))

    const runBefore = result.current.run
    await act(async () => {
        await result.current.refresh()
    })
    rerender()
    expect(result.current.run).toBe(runBefore)
})

// C1 residual (final re-review): `run()`'s completion signal used to be the
// SUMMARY job's `finishedTime` only. The DETAILS job is a separate job with
// its own `finishedTime`, and measured live it lands 137-168ms *after*
// summary's on every one of four runs against agent-gsi-p2 -- a database
// small enough that the app's own poll happened to land after both. On a
// larger instance the details job can still be running when `run()`
// resolves and `loadDetails()` fires, silently replacing a correct in-scope
// count with a stale (or absent) one that nothing ever re-reads. This test
// simulates exactly that: summary's finishedTime advances on the very first
// poll, but details' does not advance until the third.
test("run() also requires the DETAILS job's own finishedTime to advance, not only the summary's", async () => {
    const { result } = renderHook(() => useIntegrity(), { wrapper })
    await waitFor(() => expect(result.current.available).toBe(true))
    await waitFor(() => expect(result.current.checks.length).toBe(3))

    let summaryGetCount = 0
    let detailsGetCount = 0
    mockFetcher.mockImplementation((path: string, init?: RequestInit) => {
        if (
            (path.startsWith('dataIntegrity/summary') ||
                path.startsWith('dataIntegrity/details')) &&
            init?.method === 'POST'
        ) {
            return Promise.resolve(jsonResponse({ httpStatus: 'OK' }))
        }
        if (path.startsWith('dataIntegrity/summary')) {
            summaryGetCount += 1
            // Advances on the very first read.
            return Promise.resolve(
                jsonResponse({
                    org_units_not_in_compulsory_group_sets: {
                        count: 5,
                        finishedTime: '2026-09-11T00:00:00.000Z',
                    },
                })
            )
        }
        if (path.startsWith('dataIntegrity/details')) {
            detailsGetCount += 1
            // Does not advance until the third read -- summary alone would
            // have declared victory after the first.
            const finishedTime =
                detailsGetCount >= 3
                    ? '2026-09-11T00:00:05.000Z'
                    : '2026-09-01T00:00:00.000Z'
            return Promise.resolve(
                jsonResponse({
                    org_units_not_in_compulsory_group_sets: {
                        issues: [],
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

    // If `run()` only waited on summary, it would have stopped after one
    // poll -- the point of this test is that it kept going until details
    // caught up too, even though summary itself was already satisfied.
    expect(summaryGetCount).toBeGreaterThanOrEqual(1)
    expect(detailsGetCount).toBeGreaterThanOrEqual(3)
    expect(result.current.isRunning).toBe(false)
    expect(result.current.error).toBeNull()
})

test('markStale marks only checks of the given object type, and makes no request at all', async () => {
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

test('does not become available when the server resolves no checks at all', async () => {
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

test('clears a previous error on a later successful refresh', async () => {
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

test('flips available to false with a null error on a 403 from resolveChecks', async () => {
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

test('flips available to false with a null error on a 403 from startRun', async () => {
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

test('flips available to false with a null error on a 403 from the authority check itself', async () => {
    mockDataEngineQuery.mockRejectedValue(new Error('me failed with HTTP 403'))

    const { result } = renderHook(() => useIntegrity(), { wrapper })

    await waitFor(() => expect(result.current.available).toBe(false))
    await flush()

    expect(result.current.error).toBeNull()
    expect(mockFetcher).not.toHaveBeenCalled()
})

// M1: nothing must keep polling, or update state, after the provider has
// unmounted.

test('stops polling after unmount, issuing no further requests', async () => {
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

test('ignores an overlapping run() call while one is already in flight', async () => {
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

test('gives up after finishedTime never advances, clearing isRunning and leaving a readable error', async () => {
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
        /* oxlint-disable no-await-in-loop -- steps the poll loop one timer advance at a time until it stops */
        for (let i = 0; i < 40 && result.current.isRunning; i++) {
            await flush()
            await act(async () => {
                jest.advanceTimersByTime(60000)
                await flush()
            })
        }
        /* oxlint-enable no-await-in-loop */

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
