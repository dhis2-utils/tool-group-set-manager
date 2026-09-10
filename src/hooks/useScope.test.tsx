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

it('restores a stored root from the same server', () => {
    sessionStorage.setItem(
        KEY,
        JSON.stringify({ id: 'a1', name: 'A1', baseUrl: 'http://server' })
    )
    const { result } = renderHook(() => useScope(), { wrapper: Wrapper })
    expect(result.current.rootId).toBe('a1')
    expect(result.current.rootName).toBe('A1')
    expect(result.current.isReady).toBe(true)
})

it('discards a stored root from a different server and falls back to the first user root', async () => {
    sessionStorage.setItem(
        KEY,
        JSON.stringify({ id: 'a1', name: 'A1', baseUrl: 'http://other-server' })
    )
    mockRoots = [{ id: 'root1', displayName: 'Root One', level: 1 }]
    const { result } = renderHook(() => useScope(), { wrapper: Wrapper })
    expect(result.current.rootId).not.toBe('a1')
    await waitFor(() => expect(result.current.rootId).toBe('root1'))
    expect(result.current.rootName).toBe('Root One')
})

it('degrades to no stored scope when sessionStorage holds corrupted JSON', async () => {
    sessionStorage.setItem(KEY, '{not valid json')
    mockRoots = [{ id: 'root1', displayName: 'Root One', level: 1 }]
    const { result } = renderHook(() => useScope(), { wrapper: Wrapper })
    await waitFor(() => expect(result.current.rootId).toBe('root1'))
})

it('does not break when sessionStorage access throws, as in private browsing', async () => {
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
            result.current.setRoot('x1', 'X1')
        })
    }).not.toThrow()
    expect(result.current.rootId).toBe('x1')

    getItemSpy.mockRestore()
    setItemSpy.mockRestore()
})
