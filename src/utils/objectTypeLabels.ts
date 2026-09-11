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
//
// Both are functions, not a record built once at module evaluation time.
// A record snapshots whatever i18n.t returns the moment this module is
// first imported, so a locale that finishes resolving (or is switched)
// afterwards is never reflected -- every call site already re-renders on
// every relevant change, so there is no cost to calling i18n.t fresh each
// time and every benefit.
export function typeLabel(type: ObjectType): string {
    switch (type) {
        case 'organisationUnit':
            return i18n.t('Organisation unit group sets')
        case 'dataElement':
            return i18n.t('Data element group sets')
        case 'indicator':
            return i18n.t('Indicator group sets')
        case 'categoryOption':
            return i18n.t('Category option group sets')
    }
}

// The objects themselves, rather than their group sets, in the form that
// reads correctly *inside* a sentence -- "Loading organisation units", not
// "Loading Organisation unit group sets". Sentences that name a type are
// translated whole, with this spliced into a {type} placeholder afterwards
// (see src/utils/interpolate.ts), so each of these is a plain noun phrase a
// translator can decline as their language needs.
export function typeObjectsLabel(type: ObjectType): string {
    switch (type) {
        case 'organisationUnit':
            return i18n.t('organisation units')
        case 'dataElement':
            return i18n.t('data elements')
        case 'indicator':
            return i18n.t('indicators')
        case 'categoryOption':
            return i18n.t('category options')
    }
}
