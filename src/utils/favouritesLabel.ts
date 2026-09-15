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
