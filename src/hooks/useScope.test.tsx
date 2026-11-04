import { act, renderHook, waitFor } from '@testing-library/react'
import React from 'react'
import { ScopeProvider, useScope } from './useScope'

const KEY = 'gsi.scope'

let mockBaseUrl = 'http://server'
jest.mock('@dhis2/app-runtime', () => ({
    useConfig: () => ({ baseUrl: mockBaseUrl }),
}))

let mockRoots: { id: string; displayName: string; level: number }[] = []
let mockIsLoading = false
jest.mock('./useUserScope', () => ({
    useUserScope: () => ({
        isLoading: mockIsLoading,
        roots: mockRoots,
        authorities: new Set<string>(),
        hasAuthority: () => false,
    }),
}))

const Wrapper = ({ children }: { children: React.ReactNode }) => (
    <ScopeProvider>{children}</ScopeProvider>
)

beforeEach(() => {
    sessionStorage.clear()
    mockBaseUrl = 'http://server'
    mockRoots = []
    mockIsLoading = false
})

test('restores a stored root from the same server', () => {
    sessionStorage.setItem(
        KEY,
        JSON.stringify({
            id: 'a1',
            name: 'A1',
            level: 3,
            baseUrl: 'http://server',
        })
    )
    const { result } = renderHook(() => useScope(), { wrapper: Wrapper })
    expect(result.current.rootId).toBe('a1')
    expect(result.current.rootName).toBe('A1')
    expect(result.current.rootLevel).toBe(3)
    expect(result.current.isReady).toBe(true)
})

test('keeps the level of a scope chosen deeper in the tree', () => {
    // The level cannot be recovered from the id later: a scope chosen
    // through the org unit tree is not among the user's roots, so before it
    // was carried here every such scope read as level 1 -- which offered row
    // levels above the scope and produced matrix rows outside it.
    const { result } = renderHook(() => useScope(), { wrapper: Wrapper })
    act(() => {
        result.current.setRoot('deep', 'Deep unit', 4)
    })
    expect(result.current.rootLevel).toBe(4)
    expect(JSON.parse(sessionStorage.getItem(KEY) as string)).toEqual({
        id: 'deep',
        name: 'Deep unit',
        level: 4,
        baseUrl: 'http://server',
    })
})

test('accepts a scope stored before levels were stored, reporting an unknown level', () => {
    sessionStorage.setItem(
        KEY,
        JSON.stringify({ id: 'a1', name: 'A1', baseUrl: 'http://server' })
    )
    const { result } = renderHook(() => useScope(), { wrapper: Wrapper })
    expect(result.current.rootId).toBe('a1')
    expect(result.current.rootLevel).toBeNull()
})

test('discards a stored root from a different server and falls back to the first user root', async () => {
    sessionStorage.setItem(
        KEY,
        JSON.stringify({ id: 'a1', name: 'A1', baseUrl: 'http://other-server' })
    )
    mockRoots = [{ id: 'root1', displayName: 'Root One', level: 1 }]
    const { result } = renderHook(() => useScope(), { wrapper: Wrapper })
    expect(result.current.rootId).not.toBe('a1')
    await waitFor(() => expect(result.current.rootId).toBe('root1'))
    expect(result.current.rootName).toBe('Root One')
    expect(result.current.rootLevel).toBe(1)
})

test('degrades to no stored scope when sessionStorage holds corrupted JSON', async () => {
    sessionStorage.setItem(KEY, '{not valid json')
    mockRoots = [{ id: 'root1', displayName: 'Root One', level: 1 }]
    const { result } = renderHook(() => useScope(), { wrapper: Wrapper })
    await waitFor(() => expect(result.current.rootId).toBe('root1'))
})

test('does not break when sessionStorage access throws, as in private browsing', async () => {
    const getItemSpy = jest
        .spyOn(Storage.prototype, 'getItem')
        .mockImplementation(() => {
            throw new Error('SecurityError: storage disabled')
        })
    const setItemSpy = jest
        .spyOn(Storage.prototype, 'setItem')
        .mockImplementation(() => {
            throw new Error('SecurityError: storage disabled')
        })
    mockRoots = [{ id: 'root1', displayName: 'Root One', level: 1 }]
    const { result } = renderHook(() => useScope(), { wrapper: Wrapper })
    await waitFor(() => expect(result.current.rootId).toBe('root1'))

    expect(() => {
        act(() => {
            result.current.setRoot('x1', 'X1', 4)
        })
    }).not.toThrow()
    expect(result.current.rootId).toBe('x1')

    getItemSpy.mockRestore()
    setItemSpy.mockRestore()
})
