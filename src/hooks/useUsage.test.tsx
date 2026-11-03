import { renderHook, waitFor } from '@testing-library/react'
import React from 'react'
import { USAGE_QUERY_PREFIX, useUsage, useUsageRefresh } from './useUsage'

const mockQuery = jest.fn()
jest.mock('@/utils/useApiDataQuery', () => ({
    useApiDataQuery: (args: unknown) => mockQuery(args),
}))

// Fix round 1: `refresh()` now invalidates through `useQueryClient()`
// rather than closing over `lookup`/`read`'s own `refetch` -- mocked here
// the same way `useApiDataQuery` is mocked above, since nothing in this
// file needs a real QueryClient (or the real TanStack Query behaviour
// `invalidateQueries` triggers -- that propagation is the e2e flow's job,
// not this hook-level suite's; see Settings.test.tsx and
// e2e/flows.spec.ts's "usage" test).
const mockInvalidateQueries = jest.fn()
jest.mock('@tanstack/react-query', () => ({
    useQueryClient: () => ({ invalidateQueries: mockInvalidateQueries }),
}))

const lookup = (sqlViews: unknown[]) => ({
    data: { sqlViews },
    isLoading: false,
    isError: false,
    error: null,
    refetch: jest.fn(),
})

const data = (rows: unknown[][]) => ({
    data: {
        listGrid: {
            headers: [
                { name: 'groupset_uid' },
                { name: 'groupset_type' },
                { name: 'favourite_type' },
                { name: 'favourites' },
                { name: 'views_12m' },
            ],
            rows,
        },
    },
    isLoading: false,
    isError: false,
    error: null,
    refetch: jest.fn(),
})

const pending = {
    data: undefined,
    isLoading: true,
    isError: false,
    error: null,
    refetch: jest.fn(),
}

/**
 * R2: `renderHook` + `waitFor` re-renders the hook, which would exhaust a
 * `mockReturnValueOnce` queue and return `undefined` on the third call. The
 * two queries this hook issues use disjoint queryKey prefixes ('sqlViews'
 * vs 'sqlViewData'), so a stable implementation keyed on that discriminator
 * replaces the once-queue and survives any number of re-renders.
 */
const mockQueries = (lookupResult: unknown, dataResult: unknown) => {
    mockQuery.mockImplementation((args: { queryKey: unknown[] }) =>
        args.queryKey[1] === 'sqlViews' ? lookupResult : dataResult
    )
}

describe('useUsage', () => {
    beforeEach(() => {
        mockQuery.mockReset()
        mockInvalidateQueries.mockReset()
    })

    it('is absent when no view carries the usage code', async () => {
        mockQueries(lookup([]), pending)
        const { result } = renderHook(() => useUsage())
        await waitFor(() => expect(result.current.status).toBe('absent'))
        expect(result.current.forSet('a')).toBeNull()
    })

    it('is absent when the only view with that code is a materialised view', async () => {
        mockQueries(
            lookup([
                {
                    id: 'v1',
                    code: 'GSI_GROUPSET_USAGE',
                    type: 'MATERIALIZED_VIEW',
                    access: { data: { read: true } },
                },
            ]),
            pending
        )
        const { result } = renderHook(() => useUsage())
        await waitFor(() => expect(result.current.status).toBe('absent'))
    })

    it('aggregates the rows per group set once both queries resolve', async () => {
        mockQueries(
            lookup([
                {
                    id: 'v1',
                    code: 'GSI_GROUPSET_USAGE',
                    type: 'VIEW',
                    access: { data: { read: true } },
                },
            ]),
            data([
                ['a', 'orgUnitGroupSet', 'visualization', '37', '89'],
                ['a', 'orgUnitGroupSet', 'map', '1', '0'],
            ])
        )
        const { result } = renderHook(() => useUsage())
        await waitFor(() => expect(result.current.status).toBe('ready'))
        expect(result.current.forSet('a')).toMatchObject({
            favourites: 38,
            views12m: 89,
        })
    })

    it('answers zero, not null, for a set the view does not mention', async () => {
        mockQueries(
            lookup([
                {
                    id: 'v1',
                    code: 'GSI_GROUPSET_USAGE',
                    type: 'VIEW',
                    access: { data: { read: true } },
                },
            ]),
            data([])
        )
        const { result } = renderHook(() => useUsage())
        await waitFor(() => expect(result.current.status).toBe('ready'))
        expect(result.current.forSet('nobody')).toEqual({
            favourites: 0,
            views12m: 0,
            byFavouriteType: [],
        })
    })

    it('reports a result it cannot parse as an error, not as zero usage', async () => {
        mockQueries(
            lookup([
                {
                    id: 'v1',
                    code: 'GSI_GROUPSET_USAGE',
                    type: 'VIEW',
                    access: { data: { read: true } },
                },
            ]),
            {
                data: { listGrid: { headers: [{ name: 'nope' }], rows: [] } },
                isLoading: false,
                isError: false,
                error: null,
                refetch: jest.fn(),
            }
        )
        const { result } = renderHook(() => useUsage())
        await waitFor(() => expect(result.current.status).toBe('error'))
        expect(result.current.error).toMatch(/groupset_uid/)
        expect(result.current.forSet('a')).toBeNull()
    })

    // Additional branch coverage, beyond the brief's five tests: the status
    // ternary has branches the tests above never reach.

    it('is loading while the lookup query itself is still in flight', () => {
        mockQueries(pending, pending)
        const { result } = renderHook(() => useUsage())
        expect(result.current.status).toBe('loading')
        expect(result.current.forSet('a')).toBeNull()
    })

    it('is an error when the lookup query itself fails', async () => {
        mockQueries(
            {
                data: undefined,
                isLoading: false,
                isError: true,
                error: new Error('network down'),
                refetch: jest.fn(),
            },
            pending
        )
        const { result } = renderHook(() => useUsage())
        await waitFor(() => expect(result.current.status).toBe('error'))
        expect(result.current.error).toMatch(/network down/)
        expect(result.current.forSet('a')).toBeNull()
    })

    it('is loading, not absent or error, once a view is found but its data has not arrived yet', () => {
        mockQueries(
            lookup([
                {
                    id: 'v1',
                    code: 'GSI_GROUPSET_USAGE',
                    type: 'VIEW',
                    access: { data: { read: true } },
                },
            ]),
            pending
        )
        const { result } = renderHook(() => useUsage())
        expect(result.current.status).toBe('loading')
        expect(result.current.forSet('a')).toBeNull()
    })

    it('is an error when a view passes the metadata filter but the read itself fails', async () => {
        mockQueries(
            lookup([
                {
                    id: 'v1',
                    code: 'GSI_GROUPSET_USAGE',
                    type: 'VIEW',
                    access: { data: { read: true } },
                },
            ]),
            {
                data: undefined,
                isLoading: false,
                isError: true,
                error: new Error('403 not readable'),
                refetch: jest.fn(),
            }
        )
        const { result } = renderHook(() => useUsage())
        await waitFor(() => expect(result.current.status).toBe('error'))
        expect(result.current.error).toMatch(/403 not readable/)
        expect(result.current.forSet('a')).toBeNull()
    })

    it('reports an error, not a partial result, when the row count hits the page-size guard', async () => {
        const headers = [
            { name: 'groupset_uid' },
            { name: 'groupset_type' },
            { name: 'favourite_type' },
            { name: 'favourites' },
            { name: 'views_12m' },
        ]
        const rows = Array.from({ length: 5000 }, (_, i) => [
            `set${i}`,
            'orgUnitGroupSet',
            'visualization',
            '1',
            '0',
        ])
        mockQueries(
            lookup([
                {
                    id: 'v1',
                    code: 'GSI_GROUPSET_USAGE',
                    type: 'VIEW',
                    access: { data: { read: true } },
                },
            ]),
            {
                data: { listGrid: { headers, rows } },
                isLoading: false,
                isError: false,
                error: null,
                refetch: jest.fn(),
            }
        )
        const { result } = renderHook(() => useUsage())
        await waitFor(() => expect(result.current.status).toBe('error'))
        expect(result.current.error).toMatch(/truncated/)
        expect(result.current.forSet('set0')).toBeNull()
    })

    it('keeps both of its query keys under the usage prefix, so refresh cannot reach another feature', () => {
        mockQueries(
            lookup([
                {
                    id: 'v1',
                    code: 'GSI_GROUPSET_USAGE',
                    type: 'VIEW',
                    access: { data: { read: true } },
                },
            ]),
            data([])
        )
        renderHook(() => useUsage())
        const keys = mockQuery.mock.calls.map(
            (c) => (c[0] as { queryKey: unknown[] }).queryKey
        )
        expect(keys.some((k) => k[1] === 'sqlViews')).toBe(true)
        expect(keys.some((k) => k[1] === 'sqlViewData')).toBe(true)
        keys.forEach((key) => expect(key[0]).toBe(USAGE_QUERY_PREFIX))
        return Promise.resolve()
    })
})

describe('useUsageRefresh', () => {
    it('invalidates the usage prefix and nothing else, without issuing any query', () => {
        mockQuery.mockClear()
        mockInvalidateQueries.mockClear()
        const { result } = renderHook(() => useUsageRefresh())
        result.current()
        expect(mockQuery).not.toHaveBeenCalled()
        expect(mockInvalidateQueries).toHaveBeenCalledTimes(1)
        expect(mockInvalidateQueries).toHaveBeenCalledWith({
            queryKey: [USAGE_QUERY_PREFIX],
        })
    })
})
