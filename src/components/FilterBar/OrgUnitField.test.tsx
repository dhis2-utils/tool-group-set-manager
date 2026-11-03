import { fireEvent, render, screen } from '@testing-library/react'
import React from 'react'
import { levelFromPath, OrgUnitField } from './OrgUnitField'

const mockSetRoot = jest.fn()
jest.mock('@/hooks/useScope', () => ({
    useScope: () => ({
        rootId: 'r1',
        rootName: 'Sierra Leone',
        rootLevel: 1,
        setRoot: mockSetRoot,
        isReady: true,
    }),
}))
jest.mock('@/hooks/useUserScope', () => ({
    useUserScope: () => ({
        roots: [{ id: 'r1', displayName: 'Sierra Leone' }],
    }),
}))
// OrganisationUnitTree fetches its root org units through @dhis2/app-runtime's
// own data engine, which this unit test wires up no provider for -- the
// assertions below are about OrgUnitField opening the modal around the tree,
// not about the tree's own contents, so a stand-in that mounts cleanly is
// enough.
jest.mock('@dhis2/ui', () => {
    const actual = jest.requireActual('@dhis2/ui')
    return {
        ...actual,
        OrganisationUnitTree: () => null,
    }
})

describe('OrgUnitField', () => {
    it('is labelled "Organisation unit", not "Scope"', () => {
        render(<OrgUnitField />)
        expect(screen.getByText('Organisation unit')).toBeInTheDocument()
        expect(screen.queryByText('Scope')).not.toBeInTheDocument()
    })

    it('shows the current organisation unit as the field value', () => {
        render(<OrgUnitField />)
        expect(screen.getByText('Sierra Leone')).toBeInTheDocument()
    })

    it('opens the tree when the field is activated', () => {
        render(<OrgUnitField />)
        fireEvent.click(screen.getByRole('button', { name: /Sierra Leone/ }))
        expect(
            screen.getByText('Choose the organisation unit to work in')
        ).toBeInTheDocument()
    })
})

// Moved from ScopeSelector.test.ts, unchanged: a DHIS2 path is
// "/root/child/grandchild", so its segment count is the level.
describe('levelFromPath', () => {
    it('counts path segments', () => {
        expect(levelFromPath('/a/b/c')).toBe(3)
        expect(levelFromPath('/a')).toBe(1)
        expect(levelFromPath(undefined)).toBeNull()
        expect(levelFromPath('')).toBeNull()
    })

    // Carried over from ScopeSelector.test.ts: the case above uses
    // fictional path segments, but the tree's onChange payload carries the
    // path but no level, and the level cannot be recovered from the id
    // later -- a scope chosen in the tree is not among the user's own
    // roots. This exercises the same counting against real DHIS2 ids,
    // including the two-segment case the block above doesn't cover.
    it('reads the level from a DHIS2 org unit path', () => {
        expect(levelFromPath('/ImspTQPwCqd')).toBe(1)
        expect(levelFromPath('/ImspTQPwCqd/O6uvpzGd5pu')).toBe(2)
        expect(levelFromPath('/ImspTQPwCqd/O6uvpzGd5pu/U6Kr7Gtpidn')).toBe(3)
    })
})
