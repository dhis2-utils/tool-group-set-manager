import i18n from '@dhis2/d2-i18n'
import { ObjectType } from '@/engine/types'

// Shared between Dashboard (section headings) and LoadProgress (progress
// line, per-type error listing) so both read the same translated section
// name for an ObjectType rather than a raw, untranslated value -- and so
// neither has to import the other to get at it (a page importing a
// component it renders, and that component importing back from the page,
// is a circular import: it happens to work as long as a bundler or test
// runner evaluates the two modules in a particular order, but is not
// guaranteed to).
export const TYPE_LABEL: Record<ObjectType, string> = {
    organisationUnit: i18n.t('Organisation unit group sets'),
    dataElement: i18n.t('Data element group sets'),
    indicator: i18n.t('Indicator group sets'),
    categoryOption: i18n.t('Category option group sets'),
}
