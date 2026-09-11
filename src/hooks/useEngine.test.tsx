import {
    act,
    render,
    renderHook,
    screen,
    waitFor,
} from '@testing-library/react'
import React from 'react'
import { EngineProvider, useEngine } from './useEngine'

jest.mock('@dhis2/app-runtime', () => ({
    useConfig: () => ({ baseUrl: 'http://localhost:8080', apiVersion: 41 }),
}))

const mockCacheRemove = jest.fn(async () => undefined)
const mockCacheClear = jest.fn(async () => undefined)

interface MockStatus {
    phase: string
    type: string | null
    progress: null
    fromCache: Record<string, boolean>
    errors: Record<string, string>
}

interface MockLoadAllDeps {
    engine: { call: (method: string, ...args: unknown[]) => Promise<unknown> }
    onStatus: (s: MockStatus) => void
}

const doneStatus: MockStatus = {
    phase: 'done',
    type: null,
    progress: null,
    fromCache: {},
    errors: {},
}

async function defaultLoadAllImpl({ onStatus }: MockLoadAllDeps) {
    onStatus(doneStatus)
    return { groupSets: [{ id: 's1' }] }
}
const mockLoadAll = jest.fn(defaultLoadAllImpl)

jest.mock('@/data/loadAll', () => ({
    loadAll: (deps: MockLoadAllDeps) => mockLoadAll(deps),
}))
type MockSelectSourceResult = {
    source: { kind: 'sqlView' | 'metadata' }
    sqlViews: {
        orgUnits: string
        orgUnitNames: string
        orgUnitMemberships: string
    } | null
}
const mockSelectSource = jest.fn<Promise<MockSelectSourceResult>, unknown[]>(
    async () => ({
        source: { kind: 'metadata' },
        sqlViews: null,
    })
)
jest.mock('@/data/sources/selectSource', () => ({
    selectSource: (...args: unknown[]) => mockSelectSource(...args),
}))
jest.mock('@/data/cache', () => ({
    openCache: () => ({
        get: async () => undefined,
        put: async () => undefined,
        remove: mockCacheRemove,
        clear: mockCacheClear,
    }),
}))

// A fake worker-backed client whose `call` behaves like the real one after
// `terminate()`: postMessage on a terminated worker is a silent no-op, so a
// call made against a terminated client must never settle -- that is the
// observable symptom of the provider reusing a dead client after a remount.
jest.mock('@/engine/client', () => {
    class FakeEngineClient {
        static instances: FakeEngineClient[] = []
        terminated = false
        call = jest.fn(() => {
            if (this.terminated) {
                return new Promise(() => undefined)
            }
            return Promise.resolve(undefined)
        })
        terminate = jest.fn(() => {
            this.terminated = true
        })
        constructor() {
            FakeEngineClient.instances.push(this)
        }
    }
    return { EngineClient: FakeEngineClient }
})
jest.mock('@/engine/createWorker', () => ({
    createEngineWorker: () => ({}),
}))

interface FakeClientHandle {
    terminated: boolean
    call: jest.Mock
    terminate: jest.Mock
}

interface FakeEngineClientStatics {
    instances: FakeClientHandle[]
}

const { EngineClient: FakeEngineClientClass } = jest.requireMock(
    '@/engine/client'
) as { EngineClient: FakeEngineClientStatics }

const Probe = () => {
    const { status, groupSets, sourceKind } = useEngine()
    return (
        <div>
            <span>{status?.phase ?? 'none'}</span>
            <span>{groupSets.length}</span>
            <span>{sourceKind ?? 'unknown'}</span>
        </div>
    )
}

const Wrapper = ({ children }: { children: React.ReactNode }) => (
    <EngineProvider>{children}</EngineProvider>
)

beforeEach(() => {
    FakeEngineClientClass.instances.length = 0
    mockLoadAll.mockReset()
    mockLoadAll.mockImplementation(defaultLoadAllImpl)
    mockCacheRemove.mockClear()
    mockCacheClear.mockClear()
    mockSelectSource.mockReset()
    mockSelectSource.mockImplementation(async () => ({
        source: { kind: 'metadata' as const },
        sqlViews: null,
    }))
})

it('invalidateType calls the cache with only the given type', async () => {
    const { result } = renderHook(() => useEngine(), { wrapper: Wrapper })
    await act(async () => {
        await result.current.invalidateType('organisationUnit')
    })
    // "only" here means the one call names only this type, not that some
    // other type is left untouched -- that half is pinned against the real
    // implementation in cache.test.ts ("removes only the named type,
    // leaving the others untouched"), which this mock can't demonstrate on
    // its own.
    expect(mockCacheRemove).toHaveBeenCalledTimes(1)
    expect(mockCacheRemove).toHaveBeenCalledWith('organisationUnit')
})

// M5: Settings clears the cache through this rather than opening its own
// second `openCache(baseUrl)` connection.
it("clearCache clears the engine's own cache", async () => {
    const { result } = renderHook(() => useEngine(), { wrapper: Wrapper })
    await act(async () => {
        await result.current.clearCache()
    })
    expect(mockCacheClear).toHaveBeenCalledTimes(1)
})

it('exposes a null client before the creation effect has run, then a live one after', async () => {
    const seen: unknown[] = []
    const Capture = () => {
        const { client } = useEngine()
        seen.push(client)
        return null
    }
    render(
        <EngineProvider>
            <Capture />
        </EngineProvider>
    )
    await waitFor(() => expect(seen.some((c) => c !== null)).toBe(true))
    // The very first render commits before the client-creation effect has
    // had a chance to run, so the context must have honestly exposed null
    // rather than a lying cast -- this is what stops a consumer that reads
    // `client` in its own mount effect (which runs before this provider's)
    // from dereferencing a value TypeScript claimed could never be null.
    expect(seen[0]).toBeNull()
    expect(seen[seen.length - 1]).not.toBeNull()
})

it('loads on mount and exposes status, group sets and source kind', async () => {
    render(
        <EngineProvider>
            <Probe />
        </EngineProvider>
    )
    await waitFor(() => expect(screen.getByText('done')).toBeInTheDocument())
    expect(screen.getByText('1')).toBeInTheDocument()
    expect(screen.getByText('metadata')).toBeInTheDocument()
    expect(mockLoadAll).toHaveBeenCalledTimes(1)
})

it('D4: reflects a sourceKind loadAll fell back to, not just the one selectSource initially picked', async () => {
    mockSelectSource.mockImplementation(async () => ({
        source: { kind: 'sqlView' as const },
        sqlViews: {
            orgUnits: 'v1',
            orgUnitNames: 'v2',
            orgUnitMemberships: 'v3',
        },
    }))
    mockLoadAll.mockImplementationOnce(async ({ onStatus }) => {
        onStatus(doneStatus)
        // Simulates loadAll's own D4 fallback: it started against the
        // sqlView source selectSource picked, but a read failed and it
        // finished the load against the metadata source instead.
        return { groupSets: [{ id: 's1' }], sourceKind: 'metadata' as const }
    })
    render(
        <EngineProvider>
            <Probe />
        </EngineProvider>
    )
    await waitFor(() => expect(screen.getByText('done')).toBeInTheDocument())
    expect(screen.getByText('metadata')).toBeInTheDocument()
})

it('unmount terminates the client exactly once', async () => {
    const { result, unmount } = renderHook(() => useEngine(), {
        wrapper: Wrapper,
    })
    await waitFor(() => expect(result.current.status?.phase).toBe('done'))
    const client = result.current.client as unknown as FakeClientHandle
    unmount()
    expect(client.terminate).toHaveBeenCalledTimes(1)
})

it('reload(true) resets the engine before loadAll runs', async () => {
    const { result } = renderHook(() => useEngine(), { wrapper: Wrapper })
    await waitFor(() => expect(result.current.status?.phase).toBe('done'))

    const order: string[] = []
    const client = result.current.client as unknown as FakeClientHandle
    client.call.mockImplementation((method: string) => {
        if (method === 'reset') {
            order.push('reset')
        }
        return Promise.resolve(undefined)
    })
    mockLoadAll.mockImplementationOnce(async ({ onStatus }) => {
        order.push('loadAll')
        onStatus(doneStatus)
        return { groupSets: [] }
    })

    await act(async () => {
        await result.current.reload(true)
    })

    expect(order).toEqual(['reset', 'loadAll'])
})

it('a whole-load failure sets error', async () => {
    mockLoadAll.mockRejectedValueOnce(new Error('group sets request failed'))
    const { result } = renderHook(() => useEngine(), { wrapper: Wrapper })
    await waitFor(() =>
        expect(result.current.error).toBe('group sets request failed')
    )
})

it('a per-type failure arrives in status.errors and does not set error', async () => {
    mockLoadAll.mockImplementationOnce(async ({ onStatus }) => {
        onStatus({
            phase: 'done',
            type: null,
            progress: null,
            fromCache: {},
            errors: { organisationUnit: 'organisationUnits request failed' },
        })
        return { groupSets: [] }
    })
    const { result } = renderHook(() => useEngine(), { wrapper: Wrapper })
    await waitFor(() =>
        expect(result.current.status?.errors.organisationUnit).toBe(
            'organisationUnits request failed'
        )
    )
    expect(result.current.error).toBeNull()
})

it('a remount after an unmount produces a working client rather than a dead one', async () => {
    const StrictWrapper = ({ children }: { children: React.ReactNode }) => (
        <React.StrictMode>
            <EngineProvider>{children}</EngineProvider>
        </React.StrictMode>
    )
    const { result } = renderHook(() => useEngine(), {
        wrapper: StrictWrapper,
    })
    await waitFor(() => expect(result.current.status?.phase).toBe('done'))

    // Strict Mode (in dev) mounts, simulates an unmount, then simulates a
    // remount, all as part of this one render. Whichever client the
    // provider currently exposes must be a live one, and some earlier
    // instance must have actually been torn down (i.e. this isn't
    // trivially true because cleanup never ran at all).
    const current = result.current.client as unknown as FakeClientHandle
    expect(current.terminated).toBe(false)
    expect(
        FakeEngineClientClass.instances.some(
            (i) => i !== current && i.terminated
        )
    ).toBe(true)

    // The proof that it is "working" rather than "dead": a fresh forced
    // reload actually settles instead of hanging on a terminated
    // client's silently-dropped postMessage.
    await act(async () => {
        await result.current.reload(true)
    })
    expect(result.current.error).toBeNull()
}, 3000)

it('a forced reload supersedes an in-flight non-forced one, and a late-arriving stale result cannot overwrite it', async () => {
    let resolveFirst: (() => void) | undefined
    mockLoadAll.mockImplementationOnce(async ({ onStatus }) => {
        await new Promise<void>((resolve) => {
            resolveFirst = resolve
        })
        onStatus({
            phase: 'done',
            type: null,
            progress: null,
            fromCache: {},
            errors: { organisationUnit: 'stale result' },
        })
        return { groupSets: [{ id: 'stale' }] }
    })

    const { result } = renderHook(() => useEngine(), { wrapper: Wrapper })
    // Let the mount-triggered reload(false) start and block inside loadAll.
    await waitFor(() => expect(mockLoadAll).toHaveBeenCalledTimes(1))

    mockLoadAll.mockImplementationOnce(async ({ onStatus }) => {
        onStatus(doneStatus)
        return { groupSets: [{ id: 'fresh' }] }
    })
    // The forced reload runs and completes fully while the first (stale)
    // call is still blocked -- this is the user explicitly asking for fresh
    // data while an old load is still in flight.
    await act(async () => {
        await result.current.reload(true)
    })
    expect(result.current.groupSets).toEqual([{ id: 'fresh' }])

    // Only now does the superseded, still-in-flight non-forced call resolve.
    // Its stale result must not be allowed to overwrite the fresh one.
    await act(async () => {
        resolveFirst?.()
        for (let i = 0; i < 5; i++) {
            await Promise.resolve()
        }
    })

    expect(result.current.groupSets).toEqual([{ id: 'fresh' }])
    expect(result.current.status?.errors.organisationUnit).toBeUndefined()
})
