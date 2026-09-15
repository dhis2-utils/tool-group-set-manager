import i18n from '@dhis2/d2-i18n'
import { interpolate } from '@/utils/interpolate'

// Two problems with a single call of the shape the brief specified --
// i18n.t of a key plus an options object holding count and a
// defaultValue_plural fallback: (1) @dhis2/d2-i18n@1.2.0 resolves an
// i18next version that never reads that fallback, so it is a silent no-op
// and the singular string always renders regardless of count; (2) this
// project's `d2-app-scripts i18n extract` uses i18next-scanner in a mode
// that only recognises an i18n.t call taking a single string argument --
// passing any second (options) argument at all, verified directly against
// the installed scanner, makes the whole call invisible to extraction, so
// the plural string never even reaches the .pot file to be translated.
// Both are avoided by keeping every i18n.t call a single bare string
// argument and choosing between two such calls on `count === 1`. Each of
// those strings is complete, punctuation and all, with the number in a
// {count} placeholder that interpolate() fills in afterwards -- a number
// glued to a separately translated word is the fragment pattern
// CLAUDE.md's "Translatable strings" section rules out, because no
// translator can move the number relative to the noun.
export const groupsLabel = (count: number): string =>
    count === 1
        ? i18n.t('1 group')
        : interpolate(i18n.t('{count} groups'), {
              count: count.toLocaleString(),
          })
