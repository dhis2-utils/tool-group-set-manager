import { favouritesLabel, usedInFavouritesLabel } from './favouritesLabel'

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

describe('usedInFavouritesLabel', () => {
    it('says what the number counts, singular and plural', () => {
        expect(usedInFavouritesLabel(1)).toBe('Used in 1 favourite')
        expect(usedInFavouritesLabel(0)).toBe('Used in 0 favourites')
        expect(usedInFavouritesLabel(1000)).toBe('Used in 1,000 favourites')
    })
})
