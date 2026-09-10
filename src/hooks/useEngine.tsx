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
import { Cache, openCache } from '@/data/cache'
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
    // Bumped by every reload() call; a call's own state updates are dropped
    // once a newer call has started, so two overlapping reloads can never
    // interleave their setStatus/setGroupSets/setSourceKind updates, and a
    // forced reload always wins over whatever an older one was still doing.
    const generationRef = useRef(0)
    const [status, setStatus] = useState<LoadStatus | null>(null)
    const [groupSets, setGroupSets] = useState<GroupSetMeta[]>([])
    const [sourceKind, setSourceKind] = useState<'sqlView' | 'metadata' | null>(
        null
    )
    const [error, setError] = useState<string | null>(null)

    // One IndexedDB connection per base URL, opened lazily on first use
    // rather than during render (avoiding an extra, unclosable connection
    // if this component's render is ever invoked more than once for the
    // same commit) and reused across every reload() call against that URL.
    const cacheRef = useRef<{ baseUrl: string; cache: Cache } | null>(null)
    const getCache = useCallback((): Cache => {
        if (!cacheRef.current || cacheRef.current.baseUrl !== baseUrl) {
            cacheRef.current = { baseUrl, cache: openCache(baseUrl) }
        }
        return cacheRef.current.cache
    }, [baseUrl])

    const reload = useCallback(
        async (force: boolean) => {
            const generation = ++generationRef.current
            const isCurrent = () => generationRef.current === generation
            const client = clientRef.current
            if (!client) {
                return
            }
            setError(null)
            try {
                const fetcher = createFetcher(baseUrl, apiVersion)
                const { source } = await selectSource(fetcher)
                if (!isCurrent()) {
                    return
                }
                setSourceKind(source.kind)
                if (force) {
                    // A forced reload must never let an older, still-running
                    // load keep filling the engine after this reset -- but
                    // it also must not be skipped just because something
                    // newer than IT has since started (the newest call
                    // always wins).
                    await client.call('reset')
                    if (!isCurrent()) {
                        return
                    }
                }
                const result = await loadAll({
                    source,
                    fetcher,
                    cache: getCache(),
                    engine: client,
                    onStatus: (s) => {
                        if (isCurrent()) {
                            setStatus(s)
                        }
                    },
                    forceRefresh: force,
                })
                if (isCurrent()) {
                    setGroupSets(result.groupSets)
                }
            } catch (e) {
                if (isCurrent()) {
                    setError(e instanceof Error ? e.message : String(e))
                }
            }
        },
        [baseUrl, apiVersion, getCache]
    )

    // Create and terminate the worker together, in the same effect: if
    // creation only happened in the render body (behind a ref-null guard)
    // while termination lived in a separate empty-deps effect, nothing
    // would ever recreate the client after a remount that only re-runs
    // effects without re-rendering (Strict Mode's mount/unmount/remount
    // simulation is exactly this) -- the ref would stay cleared, or worse,
    // stay pointed at the terminated worker, and every later call would
    // hang forever (postMessage on a terminated worker is a silent no-op).
    // Clearing the ref here means a remount always builds a live one.
    useEffect(() => {
        const client = new EngineClient(createEngineWorker())
        clientRef.current = client
        return () => {
            client.terminate()
            clientRef.current = null
        }
    }, [])

    useEffect(() => {
        void reload(false)
    }, [reload])

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
