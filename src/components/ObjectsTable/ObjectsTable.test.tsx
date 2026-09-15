import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import React from 'react'
import {
    computeMembershipChanges,
    isAwaitedPage,
    ObjectsTable,
} from './ObjectsTable'

// babel-plugin-jest-hoist only allows a jest.mock() factory to reference
// out-of-scope variables whose names start with "mock" (see the matching
// comment in Dashboard.test.tsx and useEngineQuery.test.tsx). Delegating to
// a mutable `mockUseEngineQuery` (rather than a fixed literal return value)
// is what lets later tests in this file swap in a stateful, controllable
// fake per test.
const mockUseEngineQuery = jest.fn()
jest.mock('@/hooks/useEngineQuery', () => ({
    useEngineQuery: (...args: unknown[]) => mockUseEngineQuery(...args),
}))

const mockWrite = jest.fn()
jest.mock('@/hooks/useMembershipWrite', () => ({
    useMembershipWrite: () => ({ write: mockWrite, isWriting: false }),
}))

const set = {
    id: 'own',
    displayName: 'Ownership',
    objectType: 'organisationUnit' as const,
    compulsory: true,
    dataDimension: true,
    canWrite: true,
    groups: [
        { id: 'a', displayName: 'Public', canWrite: true },
        { id: 'b', displayName: 'Private', canWrite: true },
    ],
}
const scope = { objectType: 'organisationUnit' as const, rootId: 'r' }

const makeItems = (
    count: number,
    { offset = 0, label = 'Item' }: { offset?: number; label?: string } = {}
) =>
    Array.from({ length: count }, (_, i) => ({
        index: offset + i,
        id: `o${offset + i}`,
        displayName: `${label} ${offset + i}`,
        level: 4,
        parentId: 'p',
        status: 1,
        groups: [0],
    }))

interface FakeResult {
    total: number
    /** echoed back by the real store, so the fake echoes it too */
    offset: number
    items: ReturnType<typeof makeItems>
}

/**
 * A hand-rolled stand-in for the real `useEngineQuery`, needed because
 * these tests have to control *when* a given request settles -- something
 * a static mock return value can't express. It mirrors the real hook's two
 * load-bearing properties (checked against src/hooks/useEngineQuery.ts):
 * each distinct args key gets its own promise that only that key's own
 * effect will ever act on, and a key whose effect has since been cleaned
 * up (a newer key started) can never call `setState`, no matter when its
 * promise resolves. `useFakeQuery` is named starting with "use" so
 * eslint-plugin-react-hooks recognises it as a hook and allows the
 * `useState`/`useEffect` calls inside it.
 */
function createControllableEngineQuery() {
    const resolvers = new Map<string, (result: unknown) => void>()
    // The real hook re-runs its effect when the engine's load phase or type
    // changes, re-issuing the *identical* request; `rerun()` below is that
    // (src/hooks/useEngineQuery.ts's status?.phase/status?.type deps).
    // Requests actually issued -- one entry per (method, key) the fake's own
    // request effect below ran for, which only happens on a genuinely new
    // key/epoch, never on every render. This is what "one call per page,
    // not per row" is checked against, rather than raw mock-call counts
    // (`mockUseEngineQuery` is invoked -- and re-invoked -- on every render
    // regardless of whether a new request went out).
    const requests: { method: string; key: string }[] = []
    const epochSetters = new Set<React.Dispatch<React.SetStateAction<number>>>()
    const useFakeQuery = (method: string, args: unknown[], enabled = true) => {
        const key = JSON.stringify(args)
        const [epoch, setEpoch] = React.useState(0)
        React.useEffect(() => {
            epochSetters.add(setEpoch)
            return () => {
                epochSetters.delete(setEpoch)
            }
        }, [])
        const [state, setState] = React.useState<{
            data: unknown
            settledKey: string | null
            isLoading: boolean
        }>({ data: undefined, settledKey: null, isLoading: true })
        React.useEffect(() => {
            // Mirrors the real hook: disabled means no request at all, not
            // a request that never settles. `resolveParents` relies on this
            // to stay un-asked before its page's rows (and `isOrgUnit`) are
            // known.
            if (!enabled) {
                return
            }
            let cancelled = false
            setState((s) => ({ ...s, isLoading: true }))
            requests.push({ method, key })
            const promise = new Promise<unknown>((resolve) => {
                resolvers.set(key, resolve)
            })
            promise.then((result) => {
                if (!cancelled) {
                    setState({
                        data: result,
                        settledKey: key,
                        isLoading: false,
                    })
                }
            })
            return () => {
                cancelled = true
            }
        }, [key, epoch, enabled])
        // Mirrors the real hook's own masking (see the comment on its
        // `useMemo` return in src/hooks/useEngineQuery.ts): a result for
        // arguments no longer being asked about must never reach the
        // consumer, even for the one render between a key change and that
        // key's own request effect running -- the exact race that folded a
        // stale filter's page into a freshly reset list.
        return state.settledKey === key
            ? { data: state.data, isLoading: state.isLoading, error: null }
            : { data: undefined, isLoading: enabled, error: null }
    }
    // The offset is stamped on from the request itself, exactly as the store
    // echoes back the offset it was asked for.
    const resolve = (args: unknown[], result: Omit<FakeResult, 'offset'>) => {
        const key = JSON.stringify(args)
        const resolver = resolvers.get(key)
        if (!resolver) {
            throw new Error(`no pending request for ${key}`)
        }
        resolver({ ...result, offset: args[3] as number })
    }
    // The component now waits for a page's `resolveParents` call to land
    // alongside the page itself (D1/D3 -- see ObjectsTable's append
    // effect), so every fake page resolved through `resolve` above needs
    // its matching `resolveParents` request settled too before the rows
    // appear. Callers that don't care about the parent column pass no
    // `parents`, and every row resolves to no parent (D2's blank rendering
    // either way). This must run in an `act()` of its own, after the one
    // that resolved `resolve` above, so the effect that registers this
    // request (keyed on the page that just landed) has already run.
    const resolveParentsFor = (
        items: { index: number }[],
        parents: unknown[] = items.map(() => null)
    ) => {
        const key = JSON.stringify([set.objectType, items.map((i) => i.index)])
        const resolver = resolvers.get(key)
        if (!resolver) {
            throw new Error(`no pending resolveParents request for ${key}`)
        }
        resolver(parents)
    }
    const rerun = () => {
        epochSetters.forEach((set) => set((e) => e + 1))
    }
    return { useFakeQuery, resolve, resolveParentsFor, rerun, requests }
}

// Calls for the given method only -- the component now also calls
// `useEngineQuery('resolveParents', ...)` once per page, and that call's
// args have a completely different shape ([objectType, indexes], no
// offset/limit), so anything reading positional args here must filter to
// the method it actually means.
const callsFor = (method: string) =>
    mockUseEngineQuery.mock.calls.filter((c) => c[0] === method)

const lastCallArgs = () => {
    const calls = callsFor('objectsFor')
    return calls[calls.length - 1][1] as unknown[]
}

/**
 * Every distinct page the component has asked the engine for, in order, as
 * "offset/limit". Both halves matter: a fix that paged by offset but kept
 * growing the limit, or one that kept the limit but re-requested from zero,
 * would each look right in one half alone.
 */
const pageRequests = () => {
    const seen: string[] = []
    callsFor('objectsFor').forEach((c) => {
        const args = c[1] as unknown[]
        const key = `${args[3] as number}/${args[4] as number}`
        if (seen[seen.length - 1] !== key) {
            seen.push(key)
        }
    })
    return seen
}

// @tanstack/react-virtual's `observeElementRect` (checked in the installed
// node_modules/.pnpm/@tanstack+virtual-core@3.17.9/.../index.js) calls its
// resize handler once synchronously, on mount, with the scroll element's
// real `offsetWidth`/`offsetHeight` -- unconditionally, even when there is
// no `ResizeObserver` to keep it updated afterwards. That overwrites
// `initialRect` (which only ever backstops a rect that has never been
// measured at all) with jsdom's real, always-zero `offsetHeight` before
// this test's first assertion ever runs, which is what left the container
// at zero height and the virtualizer with nothing in range. `initialRect`
// in the component is still correct to keep (it is what a real browser
// would report before its own first layout, and it documents the actual
// `.scroll` height), but jsdom needs its own stand-in for real layout: the
// component's `.scroll` container is fixed at 600px tall in
// `ObjectsTable.module.css`, so 600 here is that same real, honest number,
// not a value picked to make the virtualizer happen to render enough rows.
Object.defineProperty(HTMLElement.prototype, 'offsetHeight', {
    configurable: true,
    value: 600,
})
Object.defineProperty(HTMLElement.prototype, 'offsetWidth', {
    configurable: true,
    value: 800,
})

// CSS module class names are mocked away entirely in tests (jest.config.js
// maps `.module.css` imports to an empty object), so there is no hashed
// class name to select the scroll container by -- `data-test` is a stable
// hook `screen.getByTestId` can find regardless.
const getScrollEl = () => screen.getByTestId('objects-table-scroll')

/**
 * A static, single-page stand-in for both `useEngineQuery` calls at once:
 * `objectsFor` gets the given page, `resolveParents` gets a same-length
 * array of parents (defaulting to none, D2's blank rendering). Tests below
 * that don't care about paging use this rather than a bare
 * `mockUseEngineQuery.mockReturnValue`, because that would otherwise hand
 * the `resolveParents` call the `objectsFor` page shape too.
 */
const mockObjectsPage = (
    result: { total: number; offset: number; items: { index: number }[] },
    parents: unknown[] = result.items.map(() => null)
) => {
    mockUseEngineQuery.mockImplementation((method: string) =>
        method === 'objectsFor'
            ? { data: result, isLoading: false, error: null }
            : { data: parents, isLoading: false, error: null }
    )
}

beforeEach(() => {
    mockUseEngineQuery.mockReset()
    mockWrite.mockReset()
    mockWrite.mockResolvedValue({
        outcomes: [],
        applied: [],
        unaccounted: [],
        changeSet: {} as never,
    })
})

it('renders rows with status and membership', async () => {
    const items = Array.from({ length: 3 }, (_, i) => ({
        index: i,
        id: `ou${i}`,
        displayName: `Facility ${i}`,
        level: 4,
        parentId: 'p',
        status: i === 1 ? 4 : 1,
        groups: i === 1 ? [0, 1] : [0],
    }))
    mockObjectsPage({ total: 3, offset: 0, items })
    render(<ObjectsTable set={set} scope={scope} filter={{}} />)
    await waitFor(() =>
        expect(screen.getByText('Facility 1')).toBeInTheDocument()
    )
    expect(screen.getByText('Conflict')).toBeInTheDocument()
    expect(screen.getByText(/3 objects/)).toBeInTheDocument()
})

it('pages by offset and appends, never re-requesting the rows it already has', async () => {
    const { useFakeQuery, resolve, resolveParentsFor } =
        createControllableEngineQuery()
    mockUseEngineQuery.mockImplementation(useFakeQuery)

    render(<ObjectsTable set={set} scope={scope} filter={{}} />)
    const firstPageArgs = lastCallArgs()
    // [setId, scope, filter, offset, limit]
    expect(firstPageArgs[3]).toBe(0)
    expect(firstPageArgs[4]).toBe(200)

    const firstPageItems = makeItems(200)
    await act(async () => {
        resolve(firstPageArgs, { total: 1000, items: firstPageItems })
    })
    await act(async () => {
        resolveParentsFor(firstPageItems)
    })

    const scrollEl = getScrollEl()
    act(() => {
        scrollEl.scrollTop = 6000
        fireEvent.scroll(scrollEl)
    })
    // The next page is exactly that: the next 200 rows, not the first 400
    // all over again. Growing a limit from offset 0 re-sent and re-resolved
    // every row already on screen.
    await waitFor(() => expect(lastCallArgs()[3]).toBe(200))
    expect(lastCallArgs()[4]).toBe(200)

    // While that page is outstanding, further scroll ticks must not ask for
    // 400, 600 and so on.
    act(() => {
        fireEvent.scroll(scrollEl)
        fireEvent.scroll(scrollEl)
    })
    expect(pageRequests()).toEqual(['0/200', '200/200'])

    const secondPageArgs = callsFor('objectsFor').find(
        (c) => (c[1] as unknown[])[3] === 200
    )![1] as unknown[]
    const secondPageItems = makeItems(200, { offset: 200 })
    await act(async () => {
        resolve(secondPageArgs, {
            total: 1000,
            items: secondPageItems,
        })
    })
    await act(async () => {
        resolveParentsFor(secondPageItems)
    })

    // Both pages are in the list now: the second page was appended to the
    // first, not swapped for it. (Only the rows near the scroll position are
    // in the DOM, so each end is checked from where it is visible.)
    act(() => {
        scrollEl.scrollTop = 13000
        fireEvent.scroll(scrollEl)
    })
    await waitFor(() =>
        expect(screen.getByText('Item 380')).toBeInTheDocument()
    )
    act(() => {
        scrollEl.scrollTop = 0
        fireEvent.scroll(scrollEl)
    })
    await waitFor(() => expect(screen.getByText('Item 0')).toBeInTheDocument())
    expect(pageRequests()).toEqual(['0/200', '200/200', '400/200'])
})

it('sends a text filter to the engine and renders a match that was never loaded before', async () => {
    // The whole point of this task: search is a predicate the engine
    // applies to the entire population, not a client-side filter over
    // whatever pages happened to be in memory. Proof of that has to be a
    // match beyond the first page -- a client-side filter over the first
    // 200 loaded rows could never produce this row at all.
    const { useFakeQuery, resolve, resolveParentsFor } =
        createControllableEngineQuery()
    mockUseEngineQuery.mockImplementation(useFakeQuery)

    const { rerender } = render(
        <ObjectsTable set={set} scope={scope} filter={{}} />
    )
    const firstPageArgs = lastCallArgs()
    const firstPageItems = makeItems(200)
    await act(async () => {
        resolve(firstPageArgs, { total: 100000, items: firstPageItems })
    })
    await act(async () => {
        resolveParentsFor(firstPageItems)
    })
    expect(screen.getByText('Item 5')).toBeInTheDocument()

    // A search term arrives as `filter.text` -- ObjectsTab's job, simulated
    // here directly.
    rerender(
        <ObjectsTable set={set} scope={scope} filter={{ text: 'beyond' }} />
    )
    expect((lastCallArgs()[2] as { text?: string }).text).toBe('beyond')
    expect(lastCallArgs()[3]).toBe(0)

    // The engine's own answer: one row, at object index 50000 -- an index
    // that was never part of any page this table had loaded before the
    // search.
    const matchItems = [
        {
            index: 50000,
            id: 'far0',
            displayName: 'Beyond Match',
            level: 4,
            parentId: 'p',
            status: 1,
            groups: [0],
        },
    ]
    await act(async () => {
        resolve(lastCallArgs(), { total: 1, items: matchItems })
    })
    await act(async () => {
        resolveParentsFor(matchItems)
    })
    expect(screen.getByText('Beyond Match')).toBeInTheDocument()
    // The total shown is the engine's real total for this query, not a
    // count of what happened to be in memory.
    expect(screen.getByText(/1 object\b/)).toBeInTheDocument()
    expect(screen.queryByText('Item 5')).not.toBeInTheDocument()
})

it('resets paging to the first page when the filter changes', async () => {
    const { useFakeQuery, resolve, resolveParentsFor } =
        createControllableEngineQuery()
    mockUseEngineQuery.mockImplementation(useFakeQuery)

    const { rerender } = render(
        <ObjectsTable set={set} scope={scope} filter={{}} />
    )
    const firstPageArgs = lastCallArgs()
    const firstPageItems = makeItems(200)
    await act(async () => {
        resolve(firstPageArgs, { total: 1000, items: firstPageItems })
    })
    await act(async () => {
        resolveParentsFor(firstPageItems)
    })

    const scrollEl = getScrollEl()
    act(() => {
        scrollEl.scrollTop = 6000
        fireEvent.scroll(scrollEl)
    })
    await waitFor(() => expect(lastCallArgs()[3]).toBe(200))

    // A different filter must go back to the first page, and must not keep
    // the rows the old filter had loaded.
    rerender(<ObjectsTable set={set} scope={scope} filter={{ level: 4 }} />)
    await waitFor(() => expect(lastCallArgs()[3]).toBe(0))
    expect(screen.queryByText('Item 0')).not.toBeInTheDocument()
})

it('does not let a slow response for the previous filter land once a new filter has been requested', async () => {
    const { useFakeQuery, resolve, resolveParentsFor } =
        createControllableEngineQuery()
    mockUseEngineQuery.mockImplementation(useFakeQuery)

    const { rerender } = render(
        <ObjectsTable set={set} scope={scope} filter={{}} />
    )
    const staleArgs = lastCallArgs()

    // Change the filter before the first request has resolved at all.
    rerender(<ObjectsTable set={set} scope={scope} filter={{ level: 4 }} />)
    const freshArgs = lastCallArgs()
    expect(freshArgs).not.toEqual(staleArgs)

    // The old, now-superseded request resolves late. Its own effect was
    // already cleaned up by the filter change above (the fake's `cancelled`
    // flag mirrors the real hook's), so this settles a promise nothing
    // reads any more -- `data` never becomes this result, and no matching
    // `resolveParents` request is ever made for it.
    const staleItems = makeItems(1, { label: 'STALE-SHOULD-NOT-APPEAR' })
    await act(async () => {
        resolve(staleArgs, { total: 1, items: staleItems })
    })
    expect(
        screen.queryByText(/STALE-SHOULD-NOT-APPEAR/)
    ).not.toBeInTheDocument()

    // The new request resolves, and its rows are what actually show.
    const freshItems = makeItems(1, { label: 'Fresh' })
    await act(async () => {
        resolve(freshArgs, { total: 1, items: freshItems })
    })
    await act(async () => {
        resolveParentsFor(freshItems)
    })
    expect(screen.getByText('Fresh 0')).toBeInTheDocument()
})

it('ignores a repeat of the page it already holds, however often the request is re-issued', async () => {
    // `useEngineQuery` re-issues the identical request whenever the engine's
    // load phase or type changes -- pressing Reload with this tab open fires
    // several in a row -- and each re-issue resolves to a fresh result
    // object. Appending on result identity alone therefore added the page
    // already held once per phase change: duplicate rows, duplicate React
    // keys, and a row count past the total, until a filter change reset it.
    const { useFakeQuery, resolve, resolveParentsFor, rerun } =
        createControllableEngineQuery()
    mockUseEngineQuery.mockImplementation(useFakeQuery)

    render(<ObjectsTable set={set} scope={scope} filter={{}} />)
    const firstPageArgs = lastCallArgs()
    const items = makeItems(200)
    await act(async () => {
        resolve(firstPageArgs, { total: 1000, items })
    })
    await act(async () => {
        resolveParentsFor(items)
    })

    // Two more phase changes, each re-requesting and re-resolving offset 0.
    for (let i = 0; i < 2; i++) {
        act(() => {
            rerun()
        })
        await act(async () => {
            resolve(firstPageArgs, { total: 1000, items })
        })
        await act(async () => {
            resolveParentsFor(items)
        })
    }

    expect(screen.getAllByText('Item 5')).toHaveLength(1)
    expect(pageRequests()).toEqual(['0/200'])
})

describe('parent column', () => {
    it("shows the parent's resolved display name, not a raw id", async () => {
        const items = [
            {
                index: 0,
                id: 'ou0',
                displayName: 'Child A',
                level: 4,
                parentId: 'p0',
                status: 1,
                groups: [0],
            },
        ]
        mockObjectsPage({ total: 1, offset: 0, items }, [
            {
                index: 5,
                id: 'p0',
                displayName: 'District X',
                level: 2,
                parentId: null,
            },
        ])
        render(<ObjectsTable set={set} scope={scope} filter={{}} />)
        await waitFor(() =>
            expect(screen.getByTestId('parent-ou0')).toHaveTextContent(
                'District X'
            )
        )
        // D4: the raw parent id must never appear as a fallback.
        expect(screen.queryByText('p0')).not.toBeInTheDocument()
    })

    it('asks the engine once per landed page for parent names, not once per row', async () => {
        const { useFakeQuery, resolve, resolveParentsFor, requests } =
            createControllableEngineQuery()
        mockUseEngineQuery.mockImplementation(useFakeQuery)

        render(<ObjectsTable set={set} scope={scope} filter={{}} />)
        const firstPageArgs = lastCallArgs()
        const items = makeItems(200)
        await act(async () => {
            resolve(firstPageArgs, { total: 1000, items })
        })
        await act(async () => {
            resolveParentsFor(items)
        })
        await waitFor(() =>
            expect(screen.getByText('Item 5')).toBeInTheDocument()
        )
        // 200 rows landed in this one page; the engine was asked for their
        // parents exactly once -- not once per row (which would show up
        // here as 200 separate `resolveParents` requests).
        expect(
            requests.filter((r) => r.method === 'resolveParents')
        ).toHaveLength(1)
    })

    it('shows nothing, not a dash or the raw id, for a root object', async () => {
        const items = [
            {
                index: 0,
                id: 'root0',
                displayName: 'Country',
                level: 1,
                parentId: null,
                status: 1,
                groups: [0],
            },
        ]
        // The engine resolves no parent for a root: null in that position.
        mockObjectsPage({ total: 1, offset: 0, items }, [null])
        render(<ObjectsTable set={set} scope={scope} filter={{}} />)
        await waitFor(() =>
            expect(screen.getByText('Country')).toBeInTheDocument()
        )
        expect(screen.getByTestId('parent-root0')).toBeEmptyDOMElement()
        expect(screen.queryByText('—')).not.toBeInTheDocument()
        expect(screen.queryByText('-')).not.toBeInTheDocument()
    })

    it('shows nothing, not the raw id, when the parent has no resolved name', async () => {
        // D4 is why the column was dropped in Plan 1: it showed a raw id,
        // which reads as noise. The root case above only proves the
        // no-parent branch. This is the branch D4 exists for -- a parent
        // object the engine DID resolve, whose `displayName` it could not
        // fill in. A fallback to `parent.id` would pass every other test in
        // this file.
        const items = [
            {
                index: 0,
                id: 'child0',
                displayName: 'Ngelehun CHC',
                level: 4,
                parentId: 'unnamed0',
                status: 1,
                groups: [0],
            },
        ]
        mockObjectsPage({ total: 1, offset: 0, items }, [
            { id: 'unnamed0', displayName: null },
        ])
        render(<ObjectsTable set={set} scope={scope} filter={{}} />)
        await waitFor(() =>
            expect(screen.getByText('Ngelehun CHC')).toBeInTheDocument()
        )
        expect(screen.getByTestId('parent-child0')).toBeEmptyDOMElement()
        expect(screen.queryByText('unnamed0')).not.toBeInTheDocument()
    })

    it('has no parent column at all for a flat object type', async () => {
        const flatSet = { ...set, objectType: 'dataElement' as const }
        const flatScope = { objectType: 'dataElement' as const, rootId: null }
        const items = [
            {
                index: 0,
                id: 'de0',
                displayName: 'Data element A',
                level: null,
                parentId: null,
                status: 1,
                groups: [0],
            },
        ]
        mockObjectsPage({ total: 1, offset: 0, items })
        render(<ObjectsTable set={flatSet} scope={flatScope} filter={{}} />)
        await waitFor(() =>
            expect(screen.getByText('Data element A')).toBeInTheDocument()
        )
        expect(screen.queryByText('Parent')).not.toBeInTheDocument()
        expect(screen.queryByTestId('parent-de0')).not.toBeInTheDocument()
        // Flat types have no hierarchy at all -- the resolveParents query is
        // always disabled for one, never actually asked of the engine.
        const resolveParentsCalls = callsFor('resolveParents')
        expect(resolveParentsCalls.length).toBeGreaterThan(0)
        resolveParentsCalls.forEach((c) => expect(c[2]).toBe(false))
    })
})

describe('interactive membership control', () => {
    const conflictRow = {
        index: 0,
        id: 'o1',
        displayName: 'Facility 1',
        level: 4,
        parentId: 'p',
        status: 4,
        groups: [0, 1],
    }

    const renderWithRows = (items: (typeof conflictRow)[]) => {
        mockObjectsPage({ total: items.length, offset: 0, items })
        return render(<ObjectsTable set={set} scope={scope} filter={{}} />)
    }

    it('assigning a conflict row to one group confirms, then writes a deletion from the other group and no addition to the already-held one', async () => {
        renderWithRows([conflictRow])
        // Group 1 ("Private") is already held; choosing it should resolve
        // the conflict by removing the object from Group 0 only.
        fireEvent.click(screen.getAllByRole('button')[1])
        expect(
            screen.getByText(/will be assigned to Private/)
        ).toBeInTheDocument()
        expect(mockWrite).not.toHaveBeenCalled()

        fireEvent.click(screen.getByText('Assign'))
        await waitFor(() => expect(mockWrite).toHaveBeenCalledTimes(1))
        expect(mockWrite.mock.calls[0][0]).toMatchObject({
            set,
            action: 'assign',
            targetGroupId: 'b',
            changes: [{ groupId: 'a', additions: [], deletions: ['o1'] }],
        })
    })

    it('assigning a well-formed row to a different group produces one addition and one deletion, not one deletion per group', async () => {
        const okRow = { ...conflictRow, id: 'o2', status: 1, groups: [0] }
        renderWithRows([okRow])
        fireEvent.click(screen.getAllByRole('button')[1])
        fireEvent.click(screen.getByText('Assign'))
        await waitFor(() => expect(mockWrite).toHaveBeenCalledTimes(1))
        expect(mockWrite.mock.calls[0][0].changes).toEqual([
            { groupId: 'a', additions: [], deletions: ['o2'] },
            { groupId: 'b', additions: ['o2'], deletions: [] },
        ])
    })

    it('produces no change and no write when clicking the group already the sole membership', () => {
        const okRow = { ...conflictRow, id: 'o3', status: 1, groups: [0] }
        renderWithRows([okRow])
        fireEvent.click(screen.getAllByRole('button')[0])
        expect(
            screen.queryByText('Confirm group change')
        ).not.toBeInTheDocument()
        expect(mockWrite).not.toHaveBeenCalled()
    })

    it('disables the control and names the read-only group when the object cannot be moved', () => {
        const restrictedSet = {
            ...set,
            groups: [
                { id: 'a', displayName: 'Public', canWrite: false },
                { id: 'b', displayName: 'Private', canWrite: true },
            ],
        }
        mockObjectsPage({ total: 1, offset: 0, items: [conflictRow] })
        render(<ObjectsTable set={restrictedSet} scope={scope} filter={{}} />)
        const buttons = screen.getAllByRole('button')
        expect(buttons[0]).toBeDisabled()
        expect(buttons[0]).toHaveAttribute(
            'title',
            'Public is read-only for you'
        )
        expect(buttons[1]).toBeDisabled()
    })

    it('disables the row being written to and ignores a second click on it, while a failed write leaves its original groups shown', async () => {
        let resolveWrite!: (value: unknown) => void
        mockWrite.mockImplementation(
            () =>
                new Promise((resolve) => {
                    resolveWrite = resolve
                })
        )
        renderWithRows([conflictRow])

        fireEvent.click(screen.getAllByRole('button')[1])
        fireEvent.click(screen.getByText('Assign'))
        await waitFor(() => expect(mockWrite).toHaveBeenCalledTimes(1))

        // The row's controls are disabled while its write is outstanding.
        const buttons = screen.getAllByRole('button')
        expect(buttons[0]).toBeDisabled()
        expect(buttons[1]).toBeDisabled()

        // A click while writing must not open a second confirmation.
        fireEvent.click(buttons[0])
        expect(
            screen.queryByText('Confirm group change')
        ).not.toBeInTheDocument()

        // The write fails outright (nothing confirmed).
        await act(async () => {
            resolveWrite({
                outcomes: [
                    {
                        groupId: 'a',
                        requested: 1,
                        accepted: 0,
                        error: 'HTTP 500',
                    },
                ],
                applied: [],
                unaccounted: [
                    { groupId: 'a', additions: [], deletions: ['o1'] },
                ],
                changeSet: {} as never,
            })
        })

        // No optimistic update was ever applied (D4): the row's control
        // still reflects its original, still-conflicting groups.
        await waitFor(() => expect(buttons[0]).not.toBeDisabled())
        expect(buttons[0]).toHaveAttribute('data-state', 'conflict')
        expect(buttons[1]).toHaveAttribute('data-state', 'conflict')
        expect(
            screen.getByText(/could not be fully applied/)
        ).toBeInTheDocument()
    })

    // I2: the earlier single-row version of this test could not distinguish
    // "disabled by row id" from "disabled by the table-wide isWriting flag"
    // -- both read identically with one row on screen. A second row pins
    // the actual guarantee: only the row that asked for the write is
    // disabled.
    it('disables only the row being written to, not the whole table, while a write is outstanding', async () => {
        let resolveWrite!: (value: unknown) => void
        mockWrite.mockImplementation(
            () =>
                new Promise((resolve) => {
                    resolveWrite = resolve
                })
        )
        const otherRow = {
            index: 1,
            id: 'o2',
            displayName: 'Facility 2',
            level: 4,
            parentId: 'p',
            status: 1,
            groups: [0],
        }
        renderWithRows([conflictRow, otherRow])

        // Start a write on the first (conflict) row.
        fireEvent.click(screen.getAllByRole('button')[1])
        fireEvent.click(screen.getByText('Assign'))
        await waitFor(() => expect(mockWrite).toHaveBeenCalledTimes(1))

        // Row 1's controls are disabled...
        const buttons = screen.getAllByRole('button')
        expect(buttons[0]).toBeDisabled()
        expect(buttons[1]).toBeDisabled()
        // ...but row 2's are not, and remain clickable.
        expect(buttons[2]).not.toBeDisabled()
        expect(buttons[3]).not.toBeDisabled()
        fireEvent.click(buttons[3])
        expect(screen.getByText('Confirm group change')).toBeInTheDocument()

        await act(async () => {
            resolveWrite({
                outcomes: [{ groupId: 'a', requested: 1, accepted: 1 }],
                applied: [{ groupId: 'a', additions: [], deletions: ['o1'] }],
                unaccounted: [],
                changeSet: {} as never,
            })
        })
    })

    it('shows the new group and a confirmation after a successful assign', async () => {
        // One row, currently the sole member of group 0 ("Public").
        const row = {
            ...conflictRow,
            id: 'o1',
            displayName: 'Item 0',
            status: 1,
            groups: [0],
        }
        renderWithRows([row])

        fireEvent.click(screen.getAllByRole('button')[1])
        fireEvent.click(screen.getByText('Assign'))

        await waitFor(() => expect(mockWrite).toHaveBeenCalledTimes(1))
        // The row now reads as Private, without a reload...
        await waitFor(() =>
            expect(screen.getAllByRole('button')[1]).toHaveAttribute(
                'data-state',
                'selected'
            )
        )
        // ...and the user is told the write landed, so a successful write
        // can never look like a failure.
        expect(
            screen.getByText('Item 0 is now in Private')
        ).toBeInTheDocument()
    })

    // M2: `engineError`/`historyError` mean the server change is real --
    // never reported as a failure -- but must not be silently dropped
    // either.
    it('reports engineError as a non-critical notice that the change was saved', async () => {
        mockWrite.mockResolvedValue({
            outcomes: [{ groupId: 'a', requested: 1, accepted: 1 }],
            applied: [{ groupId: 'a', additions: [], deletions: ['o1'] }],
            unaccounted: [],
            changeSet: {} as never,
            engineError: 'worker crashed',
        })
        renderWithRows([conflictRow])
        fireEvent.click(screen.getAllByRole('button')[1])
        fireEvent.click(screen.getByText('Assign'))

        const notice = await screen.findByText(/was saved to the server/)
        expect(notice).toBeInTheDocument()
        // Not the critical failure banner -- the change is real.
        expect(
            screen.queryByText(/could not be fully applied/)
        ).not.toBeInTheDocument()
    })

    it('reports historyError as a non-critical notice that the change was saved', async () => {
        mockWrite.mockResolvedValue({
            outcomes: [{ groupId: 'a', requested: 1, accepted: 1 }],
            applied: [{ groupId: 'a', additions: [], deletions: ['o1'] }],
            unaccounted: [],
            changeSet: {} as never,
            historyError: 'dataStore down',
        })
        renderWithRows([conflictRow])
        fireEvent.click(screen.getAllByRole('button')[1])
        fireEvent.click(screen.getByText('Assign'))

        expect(
            await screen.findByText(/could not be recorded in History/)
        ).toBeInTheDocument()
    })

    describe('a rejected write is reported, not swallowed (M1/M2)', () => {
        it('tells the user the change may be real when write() itself rejects', async () => {
            mockWrite.mockRejectedValue(new Error('cache blew up'))
            renderWithRows([conflictRow])
            fireEvent.click(screen.getAllByRole('button')[1])
            await act(async () => {
                fireEvent.click(screen.getByText('Assign'))
            })

            // The server write happens before anything that can reject (cache
            // invalidation, History), so silence would leave a user whose
            // change did land believing nothing happened.
            expect(
                await screen.findByText(/could not be confirmed/i)
            ).toBeInTheDocument()
            // And the row must be usable again rather than stuck disabled.
            await waitFor(() =>
                expect(screen.getAllByRole('button')[1]).not.toBeDisabled()
            )
        })

        it('names the state a partial move can leave the object in (M2)', async () => {
            mockWrite.mockResolvedValue({
                outcomes: [
                    {
                        groupId: 'a',
                        requested: 1,
                        accepted: 0,
                        error: 'HTTP 500',
                    },
                ],
                applied: [],
                unaccounted: [
                    { groupId: 'a', additions: [], deletions: ['o1'] },
                ],
                changeSet: {} as never,
            })
            renderWithRows([conflictRow])
            fireEvent.click(screen.getAllByRole('button')[1])
            await act(async () => {
                fireEvent.click(screen.getByText('Assign'))
            })

            // A move whose deletions landed and whose addition did not leaves
            // the object in no group at all -- the very violation this app
            // exists to find, so the message must name it.
            expect(await screen.findByText(/in no group/i)).toBeInTheDocument()
        })
    })
})

describe('computeMembershipChanges re-checks canWrite itself (M6)', () => {
    const row = { id: 'o1', groups: [0, 1] }
    const writable = [
        { id: 'a', displayName: 'Public', canWrite: true },
        { id: 'b', displayName: 'Private', canWrite: true },
    ]

    it('plans the move when every group involved is writable', () => {
        expect(computeMembershipChanges(row, writable, 1)).toEqual([
            { groupId: 'a', additions: [], deletions: ['o1'] },
        ])
    })

    it('plans nothing when the chosen target is read-only', () => {
        // `planAssignment` enforces this in the engine for the bulk path;
        // the per-object path enforced it only through the control's
        // per-option `disabled`, so the invariant lived in the rendering
        // layer alone.
        const groups = [writable[0], { ...writable[1], canWrite: false }]
        expect(
            computeMembershipChanges({ id: 'o1', groups: [0] }, groups, 1)
        ).toEqual([])
    })

    it('plans nothing when a group the object must leave is read-only', () => {
        const groups = [{ ...writable[0], canWrite: false }, writable[1]]
        expect(computeMembershipChanges(row, groups, 1)).toEqual([])
    })
})

describe('isAwaitedPage: the append effect only folds in the page its list is waiting for (M2)', () => {
    it('accepts a page for the list that is waiting for it, at the offset it is waiting for', () => {
        expect(isAwaitedPage({ key: 'k', offset: 0, rows: [] }, 'k', 0)).toBe(
            true
        )
    })

    it('rejects a page for a different filter, even when the offset and row count happen to line up', () => {
        // The exact shape a filter change resets to: a freshly reset list is
        // also offset 0 with no rows loaded, which is precisely the shape a
        // stale, late-landing page for the *previous* filter also has.
        // Without this check, that stale page would be folded into the new
        // list under its own (correct) label -- the fold `ObjectsTable.
        // withEngine.test.tsx` is named for.
        expect(
            isAwaitedPage(
                { key: 'new-filter', offset: 0, rows: [] },
                'old-filter',
                0
            )
        ).toBe(false)
    })

    it('rejects a page whose offset is not the one this list is waiting for', () => {
        expect(
            isAwaitedPage(
                { key: 'k', offset: 200, rows: Array(200).fill({}) },
                'k',
                0
            )
        ).toBe(false)
    })

    it('rejects a page the list already holds, rather than appending it a second time', () => {
        // rows.length > offset means the awaited page already landed and was
        // appended -- a re-issued, re-resolved identical request (a load
        // phase or type change) must not be folded in again.
        expect(
            isAwaitedPage(
                { key: 'k', offset: 0, rows: [{}, {}] as never },
                'k',
                0
            )
        ).toBe(false)
    })
})
