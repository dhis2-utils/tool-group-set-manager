import { act, renderHook, waitFor } from '@testing-library/react'
import { useChangeSets } from './useChangeSets'
import type { ChangeSet } from '@/engine/changeSet'

jest.mock('@dhis2/app-runtime', () => ({
    useConfig: () => ({ baseUrl: 'http://server', apiVersion: 41 }),
}))

const mockListChangeSets: jest.Mock = jest.fn()
jest.mock('@/data/datastore', () => ({
    listChangeSets: (...args: unknown[]) => mockListChangeSets(...args),
}))

function cs(id: string): ChangeSet {
    return {
        id,
        createdAt: '2024-01-01T00:00:00.000Z',
        createdBy: { id: 'u1', displayName: 'A User' },
        objectType: 'organisationUnit',
        groupSetId: 'own',
        groupSetName: 'Ownership',
        action: 'move',
        note: '',
        changes: [],
    }
}

beforeEach(() => {
    mockListChangeSets.mockReset()
})

describe('useChangeSets', () => {
    it('loads the first page on mount', async () => {
        mockListChangeSets.mockResolvedValue({
            changeSets: [cs('a'), cs('b')],
            hasMore: true,
        })
        const { result } = renderHook(() => useChangeSets())
        expect(result.current.isLoading).toBe(true)
        await waitFor(() => expect(result.current.isLoading).toBe(false))
        expect(result.current.changeSets.map((c) => c.id)).toEqual(['a', 'b'])
        expect(result.current.hasMore).toBe(true)
        expect(mockListChangeSets).toHaveBeenCalledWith(expect.anything(), {
            offset: 0,
            limit: 20,
        })
    })

    it('loadMore appends the next page rather than replacing the first', async () => {
        mockListChangeSets.mockResolvedValueOnce({
            changeSets: [cs('a'), cs('b')],
            hasMore: true,
        })
        const { result } = renderHook(() => useChangeSets())
        await waitFor(() => expect(result.current.isLoading).toBe(false))

        mockListChangeSets.mockResolvedValueOnce({
            changeSets: [cs('c')],
            hasMore: false,
        })
        act(() => {
            result.current.loadMore()
        })
        await waitFor(() => expect(result.current.isLoadingMore).toBe(false))

        expect(result.current.changeSets.map((c) => c.id)).toEqual([
            'a',
            'b',
            'c',
        ])
        expect(result.current.hasMore).toBe(false)
        // M1: the next offset is the window *requested* (PAGE_SIZE), not
        // the number of rows returned -- see the dedicated regression test
        // below for why that distinction matters.
        expect(mockListChangeSets).toHaveBeenLastCalledWith(expect.anything(), {
            offset: 20,
            limit: 20,
        })
    })

    it("M1: a page short of a document that failed to read does not make the next page's offset overlap it", async () => {
        // The key window requested is a full page (20), but one key's
        // document failed to read (listChangeSets silently drops it), so
        // only 19 rows come back. Advancing by the returned count (19)
        // instead of the window requested (20) would re-request key index
        // 19 on the next page -- the very key already read (and dropped) --
        // producing a duplicate row with a duplicate React key.
        const shortPage = Array.from({ length: 19 }, (_, i) => cs(`a${i}`))
        mockListChangeSets.mockResolvedValueOnce({
            changeSets: shortPage,
            hasMore: true,
        })
        const { result } = renderHook(() => useChangeSets())
        await waitFor(() => expect(result.current.isLoading).toBe(false))

        mockListChangeSets.mockResolvedValueOnce({
            changeSets: [cs('next')],
            hasMore: false,
        })
        act(() => {
            result.current.loadMore()
        })
        await waitFor(() => expect(result.current.isLoadingMore).toBe(false))

        expect(mockListChangeSets).toHaveBeenLastCalledWith(expect.anything(), {
            offset: 20,
            limit: 20,
        })
        expect(
            result.current.changeSets.filter((c) => c.id === 'next')
        ).toHaveLength(1)
    })

    it('reload discards what was loaded and starts over from offset 0', async () => {
        mockListChangeSets.mockResolvedValueOnce({
            changeSets: [cs('a')],
            hasMore: false,
        })
        const { result } = renderHook(() => useChangeSets())
        await waitFor(() => expect(result.current.isLoading).toBe(false))

        mockListChangeSets.mockResolvedValueOnce({
            changeSets: [cs('a'), cs('b')],
            hasMore: false,
        })
        act(() => {
            result.current.reload()
        })
        await waitFor(() =>
            expect(result.current.changeSets.map((c) => c.id)).toEqual([
                'a',
                'b',
            ])
        )
        expect(mockListChangeSets).toHaveBeenLastCalledWith(expect.anything(), {
            offset: 0,
            limit: 20,
        })
    })

    it('surfaces a load failure as error rather than an infinite loading state', async () => {
        mockListChangeSets.mockRejectedValue(new Error('boom'))
        const { result } = renderHook(() => useChangeSets())
        await waitFor(() => expect(result.current.isLoading).toBe(false))
        expect(result.current.error).toBe('boom')
        expect(result.current.changeSets).toEqual([])
    })
})
