import { act, renderHook, waitFor } from '@testing-library/react'
import React from 'react'
import { GsiConfigProvider, useGsiConfig } from './useGsiConfig'

jest.mock('@dhis2/app-runtime', () => ({
    useConfig: () => ({ baseUrl: 'http://localhost:8080', apiVersion: 41 }),
}))

const mockClientCall = jest.fn<Promise<void>, unknown[]>(async () => undefined)
// A stable object: the real EngineProvider only replaces `client` when the
// worker itself is recreated, never on every render, and this hook must not
// re-push setConfig just because a mock or a parent re-rendered.
jest.mock('@/hooks/useEngine', () => {
    const fakeClient = { call: (...args: unknown[]) => mockClientCall(...args) }
    return { useEngine: () => ({ client: fakeClient }) }
})

const mockLoadConfig = jest.fn<Promise<unknown>, unknown[]>()
const mockSaveRequiredLevels = jest.fn<Promise<void>, unknown[]>(
    async () => undefined
)
const mockSaveCatchAllGroup = jest.fn<Promise<void>, unknown[]>(
    async () => undefined
)
const mockSaveIncludeTracker = jest.fn<Promise<void>, unknown[]>(
    async () => undefined
)
jest.mock('@/data/datastore', () => ({
    loadConfig: (...args: unknown[]) => mockLoadConfig(...args),
    saveRequiredLevels: (...args: unknown[]) => mockSaveRequiredLevels(...args),
    saveCatchAllGroup: (...args: unknown[]) => mockSaveCatchAllGroup(...args),
    saveIncludeTracker: (...args: unknown[]) => mockSaveIncludeTracker(...args),
}))

const Wrapper = ({ children }: { children: React.ReactNode }) => (
    <GsiConfigProvider>{children}</GsiConfigProvider>
)

const defaultConfig = {
    requiredLevels: { setA: [2] },
    catchAllGroup: { setA: 'g1' },
    includeTracker: false,
}

beforeEach(() => {
    mockClientCall.mockClear()
    mockLoadConfig.mockReset()
    mockLoadConfig.mockResolvedValue(defaultConfig)
    mockSaveRequiredLevels.mockClear()
    mockSaveCatchAllGroup.mockClear()
    mockSaveIncludeTracker.mockClear()
})

it('loads the config on mount and pushes it into the engine as setConfig', async () => {
    const { result } = renderHook(() => useGsiConfig(), { wrapper: Wrapper })
    await waitFor(() => expect(result.current.isLoaded).toBe(true))
    expect(result.current.config).toEqual(defaultConfig)
    expect(mockClientCall).toHaveBeenCalledWith('setConfig', {
        requiredLevels: { setA: [2] },
        includeTracker: false,
    })
})

it('setRequiredLevels saves to the dataStore and pushes the change into the engine, without any caller having to reload', async () => {
    const { result } = renderHook(() => useGsiConfig(), { wrapper: Wrapper })
    await waitFor(() => expect(result.current.isLoaded).toBe(true))
    mockClientCall.mockClear()

    await act(async () => {
        await result.current.setRequiredLevels('setB', [3, 4])
    })

    expect(mockSaveRequiredLevels).toHaveBeenCalledWith(
        expect.anything(),
        'setB',
        [3, 4]
    )
    // The whole point of this hook (D1): required levels take effect
    // immediately, not on the next reload -- so the engine must see the
    // *merged* config (setA untouched, setB added) right after the save.
    expect(mockClientCall).toHaveBeenCalledWith('setConfig', {
        requiredLevels: { setA: [2], setB: [3, 4] },
        includeTracker: false,
    })
    expect(result.current.config.requiredLevels).toEqual({
        setA: [2],
        setB: [3, 4],
    })
})

it('setIncludeTracker saves and pushes the new value into the engine', async () => {
    const { result } = renderHook(() => useGsiConfig(), { wrapper: Wrapper })
    await waitFor(() => expect(result.current.isLoaded).toBe(true))
    mockClientCall.mockClear()

    await act(async () => {
        await result.current.setIncludeTracker(true)
    })

    expect(mockSaveIncludeTracker).toHaveBeenCalledWith(expect.anything(), true)
    expect(mockClientCall).toHaveBeenCalledWith('setConfig', {
        requiredLevels: { setA: [2] },
        includeTracker: true,
    })
})

it('setCatchAllGroup saves and updates local config, but never calls the engine (catch-all has no effect on evaluation)', async () => {
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

it('throws when used outside the provider', () => {
    // Suppress React's expected console.error for this render failure.
    const spy = jest.spyOn(console, 'error').mockImplementation(() => undefined)
    expect(() => renderHook(() => useGsiConfig())).toThrow(
        'useGsiConfig must be used inside GsiConfigProvider'
    )
    spy.mockRestore()
})
