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
    const useFakeQuery = (_method: string, args: unknown[]) => {
        const key = JSON.stringify(args)
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
        }, [key])
        return { data: state.data, isLoading: state.isLoading, error: null }
    }
    const resolve = (args: unknown[], result: FakeResult) => {
        const key = JSON.stringify(args)
        const resolver = resolvers.get(key)
        if (!resolver) {
            throw new Error(`no pending request for ${key}`)
        }
        resolver(result)
    }
    return { useFakeQuery, resolve }
}

const lastCallArgs = () =>
    mockUseEngineQuery.mock.calls[
        mockUseEngineQuery.mock.calls.length - 1
    ][1] as unknown[]

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
        data: { total: 3, items },
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

it('advances the limit by exactly one page per near-the-end scroll, and only once the response for that page lands', async () => {
    const { useFakeQuery, resolve } = createControllableEngineQuery()
    mockUseEngineQuery.mockImplementation(useFakeQuery)

    render(<ObjectsTable set={set} scope={scope} filter={{}} search="" />)
    const firstPageArgs = lastCallArgs()
    expect(firstPageArgs[4]).toBe(200)

    await act(async () => {
        resolve(firstPageArgs, { total: 1000, items: makeItems(200) })
    })

    const scrollEl = getScrollEl()
    act(() => {
        scrollEl.scrollTop = 6000
        fireEvent.scroll(scrollEl)
    })
    await waitFor(() => expect(lastCallArgs()[4]).toBe(400))

    // The response for the second page hasn't landed yet -- further scroll
    // ticks (or any other re-render) while it's outstanding must not ask
    // for 600, 800, and so on. This is the regression the fix targets:
    // before it, this alone was enough to ratchet the limit to the total.
    act(() => {
        fireEvent.scroll(scrollEl)
        fireEvent.scroll(scrollEl)
    })
    const limitsRequestedSoFar = mockUseEngineQuery.mock.calls.map(
        (c) => (c[1] as unknown[])[4] as number
    )
    expect(Math.max(...limitsRequestedSoFar)).toBe(400)

    // Now the second page's response lands.
    const secondPageArgs = mockUseEngineQuery.mock.calls.find(
        (c) => (c[1] as unknown[])[4] === 400
    )![1] as unknown[]
    await act(async () => {
        resolve(secondPageArgs, { total: 1000, items: makeItems(400) })
    })

    // Scrolled near the new end: exactly one more page is requested.
    act(() => {
        scrollEl.scrollTop = 13000
        fireEvent.scroll(scrollEl)
    })
    await waitFor(() => expect(lastCallArgs()[4]).toBe(600))
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
    await waitFor(() => expect(lastCallArgs()[4]).toBe(400))

    // A different filter must go back to the first page, not keep asking
    // for the bigger limit it had reached under the old one.
    rerender(
        <ObjectsTable set={set} scope={scope} filter={{ level: 4 }} search="" />
    )
    await waitFor(() => expect(lastCallArgs()[4]).toBe(200))
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
