import { act, renderHook, waitFor } from '@testing-library/react'
import React from 'react'
import { GsiConfigProvider, useGsiConfig } from './useGsiConfig'

jest.mock('@dhis2/app-runtime', () => ({
    useConfig: () => ({ baseUrl: 'http://localhost:8080', apiVersion: 41 }),
}))

const mockClientCall = jest.fn<Promise<void>, unknown[]>(() =>
    Promise.resolve(undefined)
)
// A stable object: the real EngineProvider only replaces `client` when the
// worker itself is recreated, never on every render, and this hook must not
// re-push setConfig just because a mock or a parent re-rendered.
jest.mock('@/hooks/useEngine', () => {
    const fakeClient = { call: (...args: unknown[]) => mockClientCall(...args) }
    return { useEngine: () => ({ client: fakeClient }) }
})

const mockLoadConfig = jest.fn<Promise<unknown>, unknown[]>()
const mockSaveCatchAllGroup = jest.fn<Promise<void>, unknown[]>(() =>
    Promise.resolve(undefined)
)
const mockSaveIncludeTracker = jest.fn<Promise<void>, unknown[]>(() =>
    Promise.resolve(undefined)
)
const mockClearCatchAllGroup = jest.fn<Promise<void>, unknown[]>(() =>
    Promise.resolve(undefined)
)
jest.mock('@/data/datastore', () => ({
    loadConfig: (...args: unknown[]) => mockLoadConfig(...args),
    saveCatchAllGroup: (...args: unknown[]) => mockSaveCatchAllGroup(...args),
    clearCatchAllGroup: (...args: unknown[]) => mockClearCatchAllGroup(...args),
    saveIncludeTracker: (...args: unknown[]) => mockSaveIncludeTracker(...args),
}))

const Wrapper = ({ children }: { children: React.ReactNode }) => (
    <GsiConfigProvider>{children}</GsiConfigProvider>
)

const defaultConfig = {
    catchAllGroup: { setA: 'g1' },
    includeTracker: false,
}

beforeEach(() => {
    mockClientCall.mockClear()
    mockLoadConfig.mockReset()
    mockLoadConfig.mockResolvedValue(defaultConfig)
    mockSaveCatchAllGroup.mockClear()
    mockSaveIncludeTracker.mockClear()
})

test('loads the config on mount and pushes it into the engine as setConfig', async () => {
    const { result } = renderHook(() => useGsiConfig(), { wrapper: Wrapper })
    await waitFor(() => expect(result.current.isLoaded).toBe(true))
    expect(result.current.config).toEqual(defaultConfig)
    expect(mockClientCall).toHaveBeenCalledWith('setConfig', {
        includeTracker: false,
    })
})

test('setIncludeTracker saves and pushes the new value into the engine', async () => {
    const { result } = renderHook(() => useGsiConfig(), { wrapper: Wrapper })
    await waitFor(() => expect(result.current.isLoaded).toBe(true))
    mockClientCall.mockClear()

    await act(async () => {
        await result.current.setIncludeTracker(true)
    })

    expect(mockSaveIncludeTracker).toHaveBeenCalledWith(expect.anything(), true)
    expect(mockClientCall).toHaveBeenCalledWith('setConfig', {
        includeTracker: true,
    })
})

test('setCatchAllGroup saves and updates local config, but never calls the engine (catch-all has no effect on evaluation)', async () => {
    const { result } = renderHook(() => useGsiConfig(), { wrapper: Wrapper })
    await waitFor(() => expect(result.current.isLoaded).toBe(true))
    mockClientCall.mockClear()

    await act(async () => {
        await result.current.setCatchAllGroup('setA', 'g2')
    })

    expect(mockSaveCatchAllGroup).toHaveBeenCalledWith(
        expect.anything(),
        'setA',
        'g2'
    )
    expect(result.current.config.catchAllGroup.setA).toBe('g2')
    expect(mockClientCall).not.toHaveBeenCalled()
})

test('clearCatchAllGroup drops the entry entirely, so a cleared set reads the same as one that was never configured', async () => {
    const { result } = renderHook(() => useGsiConfig(), { wrapper: Wrapper })
    await waitFor(() => expect(result.current.isLoaded).toBe(true))
    expect(result.current.config.catchAllGroup.setA).toBe('g1')

    await act(async () => {
        await result.current.clearCatchAllGroup('setA')
    })

    expect(mockClearCatchAllGroup).toHaveBeenCalledWith(
        expect.anything(),
        'setA'
    )
    // Not '' -- every reader treats `undefined` as "not configured", and an
    // empty string would look configured to one that only checks presence.
    expect('setA' in result.current.config.catchAllGroup).toBe(false)
})

test('throws when used outside the provider', () => {
    // Suppress React's expected console.error for this render failure.
    const spy = jest.spyOn(console, 'error').mockImplementation(() => undefined)
    expect(() => renderHook(() => useGsiConfig())).toThrow(
        'useGsiConfig must be used inside GsiConfigProvider'
    )
    spy.mockRestore()
})
