import { useConfig } from '@dhis2/app-runtime'
import React, {
    createContext,
    useCallback,
    useContext,
    useEffect,
    useMemo,
    useRef,
    useState,
} from 'react'
import { openCache } from '@/data/cache'
import { createFetcher } from '@/data/fetcher'
import { loadAll, LoadStatus } from '@/data/loadAll'
import { selectSource } from '@/data/sources/selectSource'
import { EngineClient } from '@/engine/client'
import { createEngineWorker } from '@/engine/createWorker'
import { GroupSetMeta } from '@/engine/types'

interface EngineContextValue {
    client: EngineClient
    status: LoadStatus | null
    groupSets: GroupSetMeta[]
    sourceKind: 'sqlView' | 'metadata' | null
    error: string | null
    reload: (force: boolean) => Promise<void>
}

const EngineContext = createContext<EngineContextValue | null>(null)

export const EngineProvider = ({ children }: { children: React.ReactNode }) => {
    const { baseUrl, apiVersion } = useConfig()
    const clientRef = useRef<EngineClient | null>(null)
    if (clientRef.current === null) {
        clientRef.current = new EngineClient(createEngineWorker())
    }
    const [status, setStatus] = useState<LoadStatus | null>(null)
    const [groupSets, setGroupSets] = useState<GroupSetMeta[]>([])
    const [sourceKind, setSourceKind] = useState<'sqlView' | 'metadata' | null>(
        null
    )
    const [error, setError] = useState<string | null>(null)

    const reload = useCallback(
        async (force: boolean) => {
            const client = clientRef.current as EngineClient
            setError(null)
            try {
                const fetcher = createFetcher(baseUrl, apiVersion)
                const { source } = await selectSource(fetcher)
                setSourceKind(source.kind)
                if (force) {
                    await client.call('reset')
                }
                const result = await loadAll({
                    source,
                    fetcher,
                    cache: openCache(baseUrl),
                    engine: client,
                    onStatus: setStatus,
                    forceRefresh: force,
                })
                setGroupSets(result.groupSets)
            } catch (e) {
                setError(e instanceof Error ? e.message : String(e))
            }
        },
        [baseUrl, apiVersion]
    )

    useEffect(() => {
        void reload(false)
    }, [reload])

    // Terminate the worker only when the provider unmounts, not when reload
    // changes identity (e.g. baseUrl/apiVersion happen to change reference).
    useEffect(() => () => clientRef.current?.terminate(), [])

    const value = useMemo<EngineContextValue>(
        () => ({
            client: clientRef.current as EngineClient,
            status,
            groupSets,
            sourceKind,
            error,
            reload,
        }),
        [status, groupSets, sourceKind, error, reload]
    )
    return (
        <EngineContext.Provider value={value}>
            {children}
        </EngineContext.Provider>
    )
}

export function useEngine(): EngineContextValue {
    const ctx = useContext(EngineContext)
    if (!ctx) {
        throw new Error('useEngine must be used inside EngineProvider')
    }
    return ctx
}
