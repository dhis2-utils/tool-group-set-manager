import { useConfig } from '@dhis2/app-runtime'
import React, {
    createContext,
    useCallback,
    useContext,
    useEffect,
    useMemo,
    useState,
} from 'react'
import { useEngine } from './useEngine'
import {
    GsiConfig,
    loadConfig,
    saveCatchAllGroup,
    saveIncludeTracker,
    saveRequiredLevels,
} from '@/data/datastore'
import { createFetcher } from '@/data/fetcher'
import { EngineConfig } from '@/engine/types'

interface GsiConfigContextValue {
    config: GsiConfig
    isLoaded: boolean
    setRequiredLevels: (setId: string, levels: number[]) => Promise<void>
    setCatchAllGroup: (setId: string, groupId: string) => Promise<void>
    setIncludeTracker: (value: boolean) => Promise<void>
}

const DEFAULT_CONFIG: GsiConfig = {
    requiredLevels: {},
    catchAllGroup: {},
    includeTracker: false,
}

const GsiConfigContext = createContext<GsiConfigContextValue | null>(null)

/**
 * D1: this provider closes the gap the brief's own plan left open --
 * nothing else in the app ever called the engine's `setConfig`, so required
 * levels and the tracker toggle were saved to the dataStore and then
 * silently ignored by every evaluation. It holds the loaded `GsiConfig`,
 * pushes the engine-relevant half (`requiredLevels`, `includeTracker`) into
 * the worker with `setConfig` (which re-evaluates on its own -- see
 * EngineStore.setConfig) whenever either changes, and exposes savers that
 * write to the dataStore and update local state so a caller never has to
 * reload to see its own change take effect. `catchAllGroup` is not part of
 * `EngineConfig` -- it never influences evaluation, only which group a bulk
 * fix defaults to -- so setting it never touches the engine.
 */
export const GsiConfigProvider = ({
    children,
}: {
    children: React.ReactNode
}) => {
    const { baseUrl, apiVersion } = useConfig() as {
        baseUrl: string
        apiVersion: number
    }
    const { client } = useEngine()
    const fetcher = useMemo(
        () => createFetcher(baseUrl, apiVersion),
        [baseUrl, apiVersion]
    )
    const [config, setConfig] = useState<GsiConfig>(DEFAULT_CONFIG)
    const [isLoaded, setIsLoaded] = useState(false)

    useEffect(() => {
        let cancelled = false
        loadConfig(fetcher).then((loaded) => {
            if (!cancelled) {
                setConfig(loaded)
                setIsLoaded(true)
            }
        })
        return () => {
            cancelled = true
        }
    }, [fetcher])

    useEffect(() => {
        if (!client || !isLoaded) {
            return
        }
        const engineConfig: EngineConfig = {
            requiredLevels: config.requiredLevels,
            includeTracker: config.includeTracker,
        }
        void client.call('setConfig', engineConfig)
    }, [client, isLoaded, config.requiredLevels, config.includeTracker])

    const setRequiredLevels = useCallback(
        async (setId: string, levels: number[]) => {
            await saveRequiredLevels(fetcher, setId, levels)
            setConfig((c) => ({
                ...c,
                requiredLevels: { ...c.requiredLevels, [setId]: levels },
            }))
        },
        [fetcher]
    )

    const setCatchAllGroup = useCallback(
        async (setId: string, groupId: string) => {
            await saveCatchAllGroup(fetcher, setId, groupId)
            setConfig((c) => ({
                ...c,
                catchAllGroup: { ...c.catchAllGroup, [setId]: groupId },
            }))
        },
        [fetcher]
    )

    const setIncludeTracker = useCallback(
        async (value: boolean) => {
            await saveIncludeTracker(fetcher, value)
            setConfig((c) => ({ ...c, includeTracker: value }))
        },
        [fetcher]
    )

    const value = useMemo<GsiConfigContextValue>(
        () => ({
            config,
            isLoaded,
            setRequiredLevels,
            setCatchAllGroup,
            setIncludeTracker,
        }),
        [
            config,
            isLoaded,
            setRequiredLevels,
            setCatchAllGroup,
            setIncludeTracker,
        ]
    )

    return (
        <GsiConfigContext.Provider value={value}>
            {children}
        </GsiConfigContext.Provider>
    )
}

export function useGsiConfig(): GsiConfigContextValue {
    const ctx = useContext(GsiConfigContext)
    if (!ctx) {
        throw new Error('useGsiConfig must be used inside GsiConfigProvider')
    }
    return ctx
}
