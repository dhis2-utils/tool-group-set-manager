import { favouritesLabel } from './favouritesLabel'

describe('favouritesLabel', () => {
    it('chooses the singular string for exactly one favourite', () => {
        expect(favouritesLabel(1)).toBe('1 favourite')
    })

    it('chooses the plural string for zero favourites', () => {
        expect(favouritesLabel(0)).toBe('0 favourites')
    })

    it('chooses the plural string for two favourites', () => {
        expect(favouritesLabel(2)).toBe('2 favourites')
    })

    it('formats a four-figure count with a thousands separator', () => {
        expect(favouritesLabel(1000)).toBe('1,000 favourites')
    })
})
