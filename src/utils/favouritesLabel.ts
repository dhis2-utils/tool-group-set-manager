import i18n from '@dhis2/d2-i18n'
import { interpolate } from '@/utils/interpolate'

// See the matching comment in groupsLabel.ts: two argument-free i18n.t
// calls chosen on `count === 1`, not one call with a count option, because
// this project's i18n.t/extractor pairing neither pluralises at runtime nor
// extracts a call with a second argument at all.
export const favouritesLabel = (count: number): string =>
    count === 1
        ? i18n.t('1 favourite')
        : interpolate(i18n.t('{count} favourites'), {
              count: count.toLocaleString(),
          })

// Manual review 2: the dashboard card's line. A bare "42 favourites" under
// a group set's counts did not say what the number was a count *of*; the
// usage tab's per-type breakdown keeps the short form above, where the
// type label beside it already does that job.
export const usedInFavouritesLabel = (count: number): string =>
    count === 1
        ? i18n.t('Used in 1 favourite')
        : interpolate(i18n.t('Used in {count} favourites'), {
              count: count.toLocaleString(),
          })
