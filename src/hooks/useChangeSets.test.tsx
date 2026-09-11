import { act, renderHook, waitFor } from '@testing-library/react'
import { useChangeSets } from './useChangeSets'
import { ChangeSet } from '@/engine/changeSet'

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
        expect(mockListChangeSets).toHaveBeenLastCalledWith(expect.anything(), {
            offset: 2,
            limit: 20,
        })
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
