import i18n from '@dhis2/d2-i18n'
import { interpolate } from './interpolate'

describe('interpolate', () => {
    it('fills placeholders in a whole translated sentence', () => {
        expect(
            interpolate('Includes organisation units above the {level} level', {
                level: 'District',
            })
        ).toBe('Includes organisation units above the District level')
    })

    it('accepts numbers and repeated placeholders, and leaves unknown ones visible', () => {
        expect(interpolate('{n} of {total} ({n})', { n: 3, total: 10 })).toBe(
            '3 of 10 (3)'
        )
        expect(interpolate('above the {levl} level', { level: 'x' })).toBe(
            'above the {levl} level'
        )
    })

    it('survives i18n.t, which double braces would not', () => {
        // i18next interpolates its own {{…}} placeholders even when t() is
        // called with no options, substituting an empty string for a value it
        // cannot find -- so the placeholder would be gone before interpolate
        // ever saw it. This is why the pattern uses single braces.
        expect(i18n.t('Loading {type}')).toBe('Loading {type}')
        // Built rather than written inline: a literal here would be picked
        // up by the i18n extractor and land in en.pot as a real string.
        const doubleBraced = ['Loading {', '{type}', '}'].join('')
        expect(i18n.t(doubleBraced)).not.toContain('type')
        expect(
            interpolate(i18n.t('Loading {type}'), { type: 'indicators' })
        ).toBe('Loading indicators')
    })
})
