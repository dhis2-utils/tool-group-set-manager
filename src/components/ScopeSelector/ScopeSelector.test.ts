import { levelFromPath } from './ScopeSelector'

describe('levelFromPath', () => {
    it('reads the level from a DHIS2 org unit path', () => {
        // The tree's onChange payload carries the path but no level, and the
        // level cannot be recovered from the id later -- a scope chosen in
        // the tree is not among the user's own roots.
        expect(levelFromPath('/ImspTQPwCqd')).toBe(1)
        expect(levelFromPath('/ImspTQPwCqd/O6uvpzGd5pu')).toBe(2)
        expect(levelFromPath('/ImspTQPwCqd/O6uvpzGd5pu/U6Kr7Gtpidn')).toBe(3)
    })

    it('reports an unknown level rather than guessing when there is no path', () => {
        expect(levelFromPath(undefined)).toBeNull()
        expect(levelFromPath('')).toBeNull()
    })
})
