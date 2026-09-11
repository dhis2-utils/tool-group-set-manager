jest.mock('@dhis2/d2-i18n', () => ({
    __esModule: true,
    default: { t: jest.fn((s: string) => s) },
}))

import i18n from '@dhis2/d2-i18n'
import { typeLabel, typeObjectsLabel } from './objectTypeLabels'

// A record built by calling i18n.t at module evaluation time freezes
// whatever locale was active the moment the module was first imported --
// a locale switched afterwards (the normal case: the app loads before a
// user's locale preference finishes resolving) never reaches it. Modelled
// here by having i18n.t itself return a different string on a later call,
// standing in for "the locale changed"; a function recomputes and picks
// that up, a frozen object does not.
describe('objectTypeLabels', () => {
    beforeEach(() => {
        ;(i18n.t as jest.Mock).mockReset()
    })

    it('typeLabel calls i18n.t fresh on each call, reflecting a locale set after import', () => {
        ;(i18n.t as jest.Mock).mockReturnValue('EN group sets')
        expect(typeLabel('organisationUnit')).toBe('EN group sets')
        ;(i18n.t as jest.Mock).mockReturnValue('NB group sets')
        expect(typeLabel('organisationUnit')).toBe('NB group sets')
    })

    it('typeObjectsLabel calls i18n.t fresh on each call, reflecting a locale set after import', () => {
        ;(i18n.t as jest.Mock).mockReturnValue('EN units')
        expect(typeObjectsLabel('organisationUnit')).toBe('EN units')
        ;(i18n.t as jest.Mock).mockReturnValue('NB units')
        expect(typeObjectsLabel('organisationUnit')).toBe('NB units')
    })
})
