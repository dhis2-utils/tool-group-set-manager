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
import type { Cache } from '@/data/cache'
import { cacheIdentity, createMemoryCache, openCache } from '@/data/cache'
import { createFetcher } from '@/data/fetcher'
import type { LoadStatus } from '@/data/loadAll'
import { loadAll } from '@/data/loadAll'
import { selectSource } from '@/data/sources/selectSource'
import { EngineClient } from '@/engine/client'
import { createEngineWorker } from '@/engine/createWorker'
import type { GroupSetMeta, ObjectType } from '@/engine/types'

interface EngineContextValue {
    client: EngineClient | null
    status: LoadStatus | null
    groupSets: GroupSetMeta[]
    /**
     * False until the first load has actually set `groupSets` (even to an
     * empty array), true from then on. Set together with `groupSets` in the
     * same `isCurrent()` block, never derived from `status.phase` -- `loadAll`
     * emits `phase: 'done'` one render before `setGroupSets` runs, so a
     * status-based signal would still have a window where "no longer exists"
     * gets claimed on an array that just hasn't been filled yet.
     */
    groupSetsLoaded: boolean
    sourceKind: 'sqlView' | 'metadata' | null
    /**
     * Where organisation unit names came from. Separate from `sourceKind`
     * because the SQL view path serves names from the metadata API when
     * `GSI_ORGUNIT_NAMES` is absent (design spec §8a), and a label claiming
     * one source for the whole load would then be wrong about the only
     * field a user can actually see the difference in.
     */
    nameSource: 'sqlView' | 'metadata' | null
    /**
     * P3-R2: true only when the most recent load actually fell back from a
     * broken SQL view source to the metadata source mid-load (`loadAll`'s
     * `fellBack`) -- never inferred from `sourceKind === 'metadata'`, which
     * is also true on a server that never had SQL views at all.
     */
    fellBack: boolean
    error: string | null
    /**
     * The engine's data revision (`EngineStore.revision`): it moves after
     * anything changed what a query would answer, whoever caused it -- a
     * load step, a write's `applyChangeSet`, a late `setConfig`. Views that
     * hold an engine answer re-ask when it moves.
     */
    revision: number
    reload: (force: boolean) => Promise<void>
    /**
     * Drops the one type's cached payload, kept private in `cacheRef`
     * rather than putting the `Cache` itself on the context -- a write is
     * the only thing outside this provider that ever needs to invalidate,
     * and it only ever needs to invalidate, never to read or replace a
     * cache entry directly.
     */
    invalidateType: (type: ObjectType) => Promise<void>
    /**
     * M5: Settings' "clear cache" action goes through this rather than
     * opening its own `openCache(baseUrl)` connection -- there is exactly
     * one `Cache` per base URL, owned by this provider (`cacheRef`), and a
     * second connection opened elsewhere would not be wrong today (IndexedDB
     * allows it) but has no reason to exist and would be one more place a
     * future change to how the cache is opened must remember to touch.
     */
    clearCache: () => Promise<void>
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
    const [groupSetsLoaded, setGroupSetsLoaded] = useState(false)
    const [sourceKind, setSourceKind] = useState<'sqlView' | 'metadata' | null>(
        null
    )
    const [nameSource, setNameSource] = useState<'sqlView' | 'metadata' | null>(
        null
    )
    const [fellBack, setFellBack] = useState(false)
    const [error, setError] = useState<string | null>(null)
    const [revision, setRevision] = useState(0)

    // One IndexedDB connection per base URL and user, opened lazily on first
    // use rather than during render (avoiding an extra, unclosable
    // connection if this component's render is ever invoked more than once
    // for the same commit) and reused across every reload() call against
    // that URL. The entries are keyed by the user and their locales as well
    // as the server: two users of one browser see different groups and
    // different translated names, and must never be served each other's.
    const cacheRef = useRef<{ baseUrl: string; cache: Promise<Cache> } | null>(
        null
    )
    const getCache = useCallback((): Promise<Cache> => {
        if (!cacheRef.current || cacheRef.current.baseUrl !== baseUrl) {
            const entry = {
                baseUrl,
                cache: cacheIdentity(createFetcher(baseUrl, apiVersion)).then(
                    (identity) => {
                        if (identity) {
                            return openCache(baseUrl, identity)
                        }
                        // Without knowing whose data this is, nothing is
                        // kept across page loads; the next call asks again.
                        if (cacheRef.current === entry) {
                            cacheRef.current = null
                        }
                        return createMemoryCache()
                    }
                ),
            }
            cacheRef.current = entry
        }
        return cacheRef.current.cache
    }, [baseUrl, apiVersion])
    // Bumped by invalidateType and clearCache. A load that started before
    // either read its data before the change that prompted it, so it must
    // not write that data back into the cache.
    const cacheEpochRef = useRef(0)

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
                setNameSource(source.nameSource)
                // Reset here, before loadAll runs: a fresh attempt starts
                // from "no fallback happened yet" rather than carrying
                // forward a notice earned by a previous load.
                setFellBack(false)
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
                const cacheEpoch = cacheEpochRef.current
                const result = await loadAll({
                    source,
                    fetcher,
                    cache: await getCache(),
                    engine: client,
                    // A superseded load stops before its next engine call
                    // and never writes the cache: what it read is older
                    // than what the newer load is reading.
                    isCurrent,
                    mayCache: () =>
                        isCurrent() && cacheEpochRef.current === cacheEpoch,
                    onStatus: (s) => {
                        if (isCurrent()) {
                            setStatus(s)
                        }
                    },
                    forceRefresh: force,
                })
                if (isCurrent()) {
                    setGroupSets(result.groupSets)
                    // Set together with the array itself, never derived from
                    // status.phase: loadAll emits 'done' before this line
                    // runs, so there is a render in between where the phase
                    // says loaded and the array is still empty.
                    setGroupSetsLoaded(true)
                    // D4: `result.sourceKind` is the source actually used,
                    // which can differ from the one selected above if
                    // loadAll fell back from a broken SQL view source to
                    // the metadata source partway through -- re-set it so
                    // the label the user sees (see Dashboard's sourceLabel)
                    // reflects reality rather than the initial guess.
                    if (result.sourceKind) {
                        setSourceKind(result.sourceKind)
                    }
                    setNameSource(result.nameSource)
                    setFellBack(result.fellBack)
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
            cacheEpochRef.current++
            await (await getCache()).remove(type)
        },
        [getCache]
    )

    const clearCache = useCallback(async () => {
        cacheEpochRef.current++
        await (await getCache()).clear()
    }, [getCache])

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
        const unsubscribe = created.onRevision(setRevision)
        return () => {
            unsubscribe()
            // Any load still in flight belongs to a provider that no longer
            // exists. Bumping the generation makes its continuation return
            // at the next isCurrent() check instead of calling loadAll on a
            // terminated worker (whose postMessage is a silent no-op, so the
            // call would never settle) and setting state on a gone tree.
            // oxlint-disable-next-line react-hooks/exhaustive-deps -- a generation counter, not a DOM ref: the cleanup must bump its latest value
            generationRef.current++
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
            groupSetsLoaded,
            sourceKind,
            nameSource,
            fellBack,
            error,
            revision,
            reload,
            invalidateType,
            clearCache,
        }),
        [
            client,
            status,
            groupSets,
            groupSetsLoaded,
            sourceKind,
            nameSource,
            fellBack,
            error,
            revision,
            reload,
            invalidateType,
            clearCache,
        ]
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
