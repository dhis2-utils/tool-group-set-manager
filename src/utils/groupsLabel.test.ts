import { groupsLabel } from './groupsLabel'

describe('groupsLabel', () => {
    it('chooses the plural string for zero groups', () => {
        expect(groupsLabel(0)).toBe('0 groups')
    })

    it('chooses the singular string for exactly one group', () => {
        expect(groupsLabel(1)).toBe('1 group')
    })

    it('chooses the plural string for two groups', () => {
        expect(groupsLabel(2)).toBe('2 groups')
    })

    it('formats a four-figure count with a thousands separator', () => {
        expect(groupsLabel(1234)).toBe('1,234 groups')
    })
})
