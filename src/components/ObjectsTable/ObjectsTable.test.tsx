import { render, screen, waitFor } from '@testing-library/react'
import React from 'react'
import { ObjectsTable } from './ObjectsTable'

// babel-plugin-jest-hoist only allows a jest.mock() factory to reference
// out-of-scope variables whose names start with "mock" (see the matching
// comment in Dashboard.test.tsx and useEngineQuery.test.tsx) -- so the
// brief's plain `items` has to be renamed here.
const mockItems = Array.from({ length: 3 }, (_, i) => ({
    index: i,
    id: `ou${i}`,
    displayName: `Facility ${i}`,
    level: 4,
    parentId: 'p',
    status: i === 1 ? 4 : 1,
    groups: i === 1 ? [0, 1] : [0],
}))
jest.mock('@/hooks/useEngineQuery', () => ({
    useEngineQuery: () => ({
        data: { total: 3, items: mockItems },
        isLoading: false,
        error: null,
    }),
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

it('renders rows with status and membership', async () => {
    render(
        <ObjectsTable
            set={set}
            scope={{ objectType: 'organisationUnit', rootId: 'r' }}
            filter={{}}
            search=""
        />
    )
    await waitFor(() =>
        expect(screen.getByText('Facility 1')).toBeInTheDocument()
    )
    expect(screen.getByText('Conflict')).toBeInTheDocument()
    expect(screen.getByText(/3 objects/)).toBeInTheDocument()
})
