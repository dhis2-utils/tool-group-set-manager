import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import React from 'react'
import { ObjectsTable } from './ObjectsTable'

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
    const resolvers = new Map<string, (result: FakeResult) => void>()
    // The real hook re-runs its effect when the engine's load phase or type
    // changes, re-issuing the *identical* request; `rerun()` below is that
    // (src/hooks/useEngineQuery.ts's status?.phase/status?.type deps).
    const epochSetters = new Set<React.Dispatch<React.SetStateAction<number>>>()
    const useFakeQuery = (_method: string, args: unknown[]) => {
        const key = JSON.stringify(args)
        const [epoch, setEpoch] = React.useState(0)
        React.useEffect(() => {
            epochSetters.add(setEpoch)
            return () => {
                epochSetters.delete(setEpoch)
            }
        }, [])
        const [state, setState] = React.useState<{
            data: FakeResult | undefined
            isLoading: boolean
        }>({ data: undefined, isLoading: true })
        React.useEffect(() => {
            let cancelled = false
            setState((s) => ({ ...s, isLoading: true }))
            const promise = new Promise<FakeResult>((resolve) => {
                resolvers.set(key, resolve)
            })
            promise.then((result) => {
                if (!cancelled) {
                    setState({ data: result, isLoading: false })
                }
            })
            return () => {
                cancelled = true
            }
        }, [key, epoch])
        return { data: state.data, isLoading: state.isLoading, error: null }
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
    const rerun = () => {
        epochSetters.forEach((set) => set((e) => e + 1))
    }
    return { useFakeQuery, resolve, rerun }
}

const lastCallArgs = () =>
    mockUseEngineQuery.mock.calls[
        mockUseEngineQuery.mock.calls.length - 1
    ][1] as unknown[]

/**
 * Every distinct page the component has asked the engine for, in order, as
 * "offset/limit". Both halves matter: a fix that paged by offset but kept
 * growing the limit, or one that kept the limit but re-requested from zero,
 * would each look right in one half alone.
 */
const pageRequests = () => {
    const seen: string[] = []
    mockUseEngineQuery.mock.calls.forEach((c) => {
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
    mockUseEngineQuery.mockReturnValue({
        data: { total: 3, offset: 0, items },
        isLoading: false,
        error: null,
    })
    render(<ObjectsTable set={set} scope={scope} filter={{}} search="" />)
    await waitFor(() =>
        expect(screen.getByText('Facility 1')).toBeInTheDocument()
    )
    expect(screen.getByText('Conflict')).toBeInTheDocument()
    expect(screen.getByText(/3 objects/)).toBeInTheDocument()
})

it('pages by offset and appends, never re-requesting the rows it already has', async () => {
    const { useFakeQuery, resolve } = createControllableEngineQuery()
    mockUseEngineQuery.mockImplementation(useFakeQuery)

    render(<ObjectsTable set={set} scope={scope} filter={{}} search="" />)
    const firstPageArgs = lastCallArgs()
    // [setId, scope, filter, offset, limit]
    expect(firstPageArgs[3]).toBe(0)
    expect(firstPageArgs[4]).toBe(200)

    await act(async () => {
        resolve(firstPageArgs, { total: 1000, items: makeItems(200) })
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

    const secondPageArgs = mockUseEngineQuery.mock.calls.find(
        (c) => (c[1] as unknown[])[3] === 200
    )![1] as unknown[]
    await act(async () => {
        resolve(secondPageArgs, {
            total: 1000,
            items: makeItems(200, { offset: 200 }),
        })
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

it('does not page at all while a search term is active, however few rows it matches', async () => {
    const { useFakeQuery, resolve } = createControllableEngineQuery()
    mockUseEngineQuery.mockImplementation(useFakeQuery)

    const { rerender } = render(
        <ObjectsTable set={set} scope={scope} filter={{}} search="" />
    )
    await act(async () => {
        resolve(lastCallArgs(), { total: 100000, items: makeItems(200) })
    })
    expect(pageRequests()).toEqual(['0/200'])

    // A search matching three of the 200 loaded rows. The last visible index
    // is then permanently within 50 of the *filtered* list's end, which is
    // what used to make every settled response ask for another page --
    // one worker round-trip per page, all the way to the 100,000th row.
    rerender(
        <ObjectsTable set={set} scope={scope} filter={{}} search="Item 19" />
    )
    const scrollEl = getScrollEl()
    act(() => {
        scrollEl.scrollTop = 0
        fireEvent.scroll(scrollEl)
        fireEvent.scroll(scrollEl)
        fireEvent.scroll(scrollEl)
    })
    await waitFor(() =>
        expect(screen.getByText('Item 190')).toBeInTheDocument()
    )
    expect(pageRequests()).toEqual(['0/200'])
    // And the count line still tells the truth about both numbers.
    expect(screen.getByText(/100,000 objects/)).toBeInTheDocument()
    expect(screen.getByText(/200 rows loaded so far/)).toBeInTheDocument()
})

it('resumes paging from where it left off once the search is cleared', async () => {
    const { useFakeQuery, resolve } = createControllableEngineQuery()
    mockUseEngineQuery.mockImplementation(useFakeQuery)

    const { rerender } = render(
        <ObjectsTable set={set} scope={scope} filter={{}} search="Item 1" />
    )
    await act(async () => {
        resolve(lastCallArgs(), { total: 1000, items: makeItems(200) })
    })
    const scrollEl = getScrollEl()
    act(() => {
        scrollEl.scrollTop = 6000
        fireEvent.scroll(scrollEl)
    })
    expect(pageRequests()).toEqual(['0/200'])

    rerender(<ObjectsTable set={set} scope={scope} filter={{}} search="" />)
    act(() => {
        scrollEl.scrollTop = 6000
        fireEvent.scroll(scrollEl)
    })
    // The 200 rows already loaded are kept; paging continues at 200.
    await waitFor(() => expect(pageRequests()).toEqual(['0/200', '200/200']))
})

it('resets paging to the first page when the filter changes', async () => {
    const { useFakeQuery, resolve } = createControllableEngineQuery()
    mockUseEngineQuery.mockImplementation(useFakeQuery)

    const { rerender } = render(
        <ObjectsTable set={set} scope={scope} filter={{}} search="" />
    )
    const firstPageArgs = lastCallArgs()
    await act(async () => {
        resolve(firstPageArgs, { total: 1000, items: makeItems(200) })
    })

    const scrollEl = getScrollEl()
    act(() => {
        scrollEl.scrollTop = 6000
        fireEvent.scroll(scrollEl)
    })
    await waitFor(() => expect(lastCallArgs()[3]).toBe(200))

    // A different filter must go back to the first page, and must not keep
    // the rows the old filter had loaded.
    rerender(
        <ObjectsTable set={set} scope={scope} filter={{ level: 4 }} search="" />
    )
    await waitFor(() => expect(lastCallArgs()[3]).toBe(0))
    expect(screen.queryByText('Item 0')).not.toBeInTheDocument()
})

it('does not let a slow response for the previous filter land once a new filter has been requested', async () => {
    const { useFakeQuery, resolve } = createControllableEngineQuery()
    mockUseEngineQuery.mockImplementation(useFakeQuery)

    const { rerender } = render(
        <ObjectsTable set={set} scope={scope} filter={{}} search="" />
    )
    const staleArgs = lastCallArgs()

    // Change the filter before the first request has resolved at all.
    rerender(
        <ObjectsTable set={set} scope={scope} filter={{ level: 4 }} search="" />
    )
    const freshArgs = lastCallArgs()
    expect(freshArgs).not.toEqual(staleArgs)

    // The old, now-superseded request resolves late.
    await act(async () => {
        resolve(staleArgs, {
            total: 1,
            items: makeItems(1, { label: 'STALE-SHOULD-NOT-APPEAR' }),
        })
    })
    expect(
        screen.queryByText(/STALE-SHOULD-NOT-APPEAR/)
    ).not.toBeInTheDocument()

    // The new request resolves, and its rows are what actually show.
    await act(async () => {
        resolve(freshArgs, {
            total: 1,
            items: makeItems(1, { label: 'Fresh' }),
        })
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
    const { useFakeQuery, resolve, rerun } = createControllableEngineQuery()
    mockUseEngineQuery.mockImplementation(useFakeQuery)

    const { rerender } = render(
        <ObjectsTable set={set} scope={scope} filter={{}} search="" />
    )
    const firstPageArgs = lastCallArgs()
    await act(async () => {
        resolve(firstPageArgs, { total: 1000, items: makeItems(200) })
    })

    // The search note is what reports the loaded row count; "Item" matches
    // every loaded row, so it counts them all.
    rerender(<ObjectsTable set={set} scope={scope} filter={{}} search="Item" />)
    expect(screen.getByText(/200 rows loaded so far/)).toBeInTheDocument()

    // Two more phase changes, each re-requesting and re-resolving offset 0.
    for (let i = 0; i < 2; i++) {
        act(() => {
            rerun()
        })
        await act(async () => {
            resolve(firstPageArgs, { total: 1000, items: makeItems(200) })
        })
    }

    expect(screen.getByText(/200 rows loaded so far/)).toBeInTheDocument()
    expect(screen.getAllByText('Item 5')).toHaveLength(1)
    expect(pageRequests()).toEqual(['0/200'])
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
        mockUseEngineQuery.mockReturnValue({
            data: { total: items.length, offset: 0, items },
            isLoading: false,
            error: null,
        })
        return render(
            <ObjectsTable set={set} scope={scope} filter={{}} search="" />
        )
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
        mockUseEngineQuery.mockReturnValue({
            data: { total: 1, offset: 0, items: [conflictRow] },
            isLoading: false,
            error: null,
        })
        render(
            <ObjectsTable
                set={restrictedSet}
                scope={scope}
                filter={{}}
                search=""
            />
        )
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
})
