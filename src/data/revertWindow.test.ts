import { canStillRevert, REVERT_WINDOW_MS } from './revertWindow'

const NOW = Date.parse('2026-11-03T12:00:00.000Z')
const at = (msAgo: number) => ({
    createdAt: new Date(NOW - msAgo).toISOString(),
})

describe('canStillRevert', () => {
    it('allows a change set inside the window', () => {
        expect(canStillRevert(at(REVERT_WINDOW_MS - 1000), NOW)).toBe(true)
    })

    it('refuses one at or past the window', () => {
        expect(canStillRevert(at(REVERT_WINDOW_MS), NOW)).toBe(false)
        expect(canStillRevert(at(365 * REVERT_WINDOW_MS), NOW)).toBe(false)
    })

    it('refuses one whose date cannot be read', () => {
        expect(canStillRevert({ createdAt: 'not a date' }, NOW)).toBe(false)
    })
})
