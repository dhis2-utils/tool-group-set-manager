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
    clearCatchAllGroup as clearCatchAllGroupDocument,
    GsiConfig,
    loadConfig,
    saveCatchAllGroup,
    saveIncludeTracker,
} from '@/data/datastore'
import { createFetcher } from '@/data/fetcher'
import { EngineConfig } from '@/engine/types'

interface GsiConfigContextValue {
    config: GsiConfig
    isLoaded: boolean
    setCatchAllGroup: (setId: string, groupId: string) => Promise<void>
    /**
     * Unsets one set's catch-all group. Deliberately not `setCatchAllGroup`
     * with an empty id: "not configured" is the key's absence everywhere
     * else in the app, and this keeps a cleared set indistinguishable from
     * one nobody ever configured.
     */
    clearCatchAllGroup: (setId: string) => Promise<void>
    setIncludeTracker: (value: boolean) => Promise<void>
}

const DEFAULT_CONFIG: GsiConfig = {
    catchAllGroup: {},
    includeTracker: false,
}

const GsiConfigContext = createContext<GsiConfigContextValue | null>(null)

/**
 * D1: this provider closes the gap the brief's own plan left open --
 * nothing else in the app ever called the engine's `setConfig`, so the
 * tracker toggle was saved to the dataStore and then silently ignored by
 * every evaluation. It holds the loaded `GsiConfig`, pushes the engine-
 * relevant half (`includeTracker`) into the worker with `setConfig` (which
 * re-evaluates on its own -- see EngineStore.setConfig) whenever it
 * changes, and exposes savers that write to the dataStore and update local
 * state so a caller never has to reload to see its own change take effect.
 * `catchAllGroup` is not part of `EngineConfig` -- it never influences
 * evaluation, only which group a bulk fix defaults to -- so setting it
 * never touches the engine.
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

    // M4: this pushes the new config into the worker, but nothing here
    // invalidates whatever `useEngineQuery` consumers elsewhere already
    // hold -- that hook only re-runs its query on a key or
    // `status.phase`/`status.type` change, neither of which a config change
    // touches. It is safe today only because Settings is its own route: a
    // consumer like Dashboard is a different mounted component and remounts
    // (and so re-queries) on navigation back to it. A future control that
    // changes the tracker toggle from *within* an already-mounted
    // Dashboard/GroupSetDetail (an in-place settings panel, say) would need
    // to invalidate those consumers explicitly, or it would silently keep
    // showing numbers computed against the old config.
    useEffect(() => {
        if (!client || !isLoaded) {
            return
        }
        const engineConfig: EngineConfig = {
            includeTracker: config.includeTracker,
        }
        void client.call('setConfig', engineConfig)
    }, [client, isLoaded, config.includeTracker])

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

    const clearCatchAllGroup = useCallback(
        async (setId: string) => {
            await clearCatchAllGroupDocument(fetcher, setId)
            setConfig((c) => {
                const catchAllGroup = { ...c.catchAllGroup }
                delete catchAllGroup[setId]
                return { ...c, catchAllGroup }
            })
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
            setCatchAllGroup,
            clearCatchAllGroup,
            setIncludeTracker,
        }),
        [
            config,
            isLoaded,
            setCatchAllGroup,
            clearCatchAllGroup,
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
