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

it('markStale marks only checks of the given object type', async () => {
    const { result } = renderHook(() => useIntegrity(), { wrapper })
    await waitFor(() => expect(result.current.checks.length).toBe(3))

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
})
