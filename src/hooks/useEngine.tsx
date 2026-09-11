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
import { GroupSetMeta, ObjectType } from '@/engine/types'

interface EngineContextValue {
    client: EngineClient | null
    status: LoadStatus | null
    groupSets: GroupSetMeta[]
    sourceKind: 'sqlView' | 'metadata' | null
    error: string | null
    reload: (force: boolean) => Promise<void>
    /**
     * Drops the one type's cached payload, kept private in `cacheRef`
     * rather than putting the `Cache` itself on the context -- a write is
     * the only thing outside this provider that ever needs to invalidate,
     * and it only ever needs to invalidate, never to read or replace a
     * cache entry directly.
     */
    invalidateType: (type: ObjectType) => Promise<void>
}

const EngineContext = createContext<EngineContextValue | null>(null)

export const EngineProvider = ({ children }: { children: React.ReactNode }) => {
    const { baseUrl, apiVersion } = useConfig()
    // The client is real state, not a ref: a ref can't be a hook dependency,
    // so a memoised context value built from `ref.current` can never notice
    // the client changing on its own -- it would keep serving whatever it
    // read on the render that happened to be running when the ref changed
    // (often null, since a child's mount effect runs before this
    // component's, so a consumer that calls `client.call(...)` in its own
    // effect can easily run before the ref would ever have been assigned).
    // Holding it in state means the type is honestly nullable, so
    // TypeScript makes every consumer handle "no client yet", and the
    // context value updates the moment the client actually exists.
    const [client, setClient] = useState<EngineClient | null>(null)
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
            if (!client) {
                return
            }
            const generation = ++generationRef.current
            const isCurrent = () => generationRef.current === generation
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
        [baseUrl, apiVersion, getCache, client]
    )

    const invalidateType = useCallback(
        async (type: ObjectType) => {
            await getCache().remove(type)
        },
        [getCache]
    )

    // Create and terminate the worker together, in the same effect: if
    // creation only happened in the render body while termination lived in
    // a separate empty-deps effect, nothing would ever recreate the client
    // after a remount that only re-runs effects without re-rendering
    // (Strict Mode's mount/unmount/remount simulation is exactly this) --
    // the client would stay cleared, or worse, stay pointed at the
    // terminated worker, and every later call would hang forever
    // (postMessage on a terminated worker is a silent no-op). Note: the
    // client is deliberately NOT created synchronously in the render body
    // to make it available on the first render -- that pattern is exactly
    // what caused the remount bug in the first place.
    useEffect(() => {
        const created = new EngineClient(createEngineWorker())
        setClient(created)
        return () => {
            created.terminate()
            setClient(null)
        }
    }, [])

    // reload's identity depends on `client`, so once the client goes from
    // null to a real instance, this effect re-runs and the initial load
    // starts as soon as there is a worker to run it on. (The very first
    // invocation, while client is still null, is a harmless no-op --
    // reload() returns immediately without touching the generation counter
    // or any engine/network call.)
    useEffect(() => {
        void reload(false)
    }, [reload])

    const value = useMemo<EngineContextValue>(
        () => ({
            client,
            status,
            groupSets,
            sourceKind,
            error,
            reload,
            invalidateType,
        }),
        [client, status, groupSets, sourceKind, error, reload, invalidateType]
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
