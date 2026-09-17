import i18n from '@dhis2/d2-i18n'
import { CACHE_TTL_MS } from '@/data/cache'
import { interpolate } from '@/utils/interpolate'

export interface MetadataAge {
    /** One complete translated sentence, ready to render. */
    label: string
    /** Past CACHE_TTL_MS -- drives the amber treatment. */
    stale: boolean
}

const MINUTE = 60_000
const HOUR = 60 * MINUTE
const DAY = 24 * HOUR

/**
 * The age of a metadata snapshot as one whole translated sentence.
 *
 * Every branch below is a complete sentence in its own right, and the stale
 * variants are a parallel set rather than the fresh sentence with a suffix
 * glued on. Building "…and may be out of date" by wrapping an already
 * translated string would put a translated fragment inside a translated
 * sentence, which no translator can reorder -- see CLAUDE.md. Twelve short
 * strings is the cost of getting that right.
 *
 * Granularity stops at "over a day": days, weeks and months would be more
 * strings for a number nobody acts on differently.
 *
 * `now` is a parameter rather than a `Date.now()` call inside, so callers
 * can drive it from a ticking clock and tests need no fake timers.
 */
export function metadataAge(loadedAt: number, now: number): MetadataAge {
    // A negative age (clock skew, or a savedAt from a machine running
    // ahead) must never render as "-3 minutes ago".
    const elapsed = Math.max(0, now - loadedAt)
    const stale = elapsed > CACHE_TTL_MS
    return { label: stale ? staleLabel(elapsed) : freshLabel(elapsed), stale }
}

/**
 * At the current ten-minute TTL the hour and day branches below are
 * unreachable -- anything that old is stale by definition, so `staleLabel`
 * handles it -- exactly as `staleLabel`'s own sub-minute branches are.
 * Both halves stay complete so either function remains total if the TTL
 * moves; the asymmetry was documented only in the test file, which is not
 * where someone reading this function will look for it.
 */
function freshLabel(elapsed: number): string {
    if (elapsed < MINUTE) {
        return i18n.t('Metadata from just now')
    }
    if (elapsed < HOUR) {
        const count = Math.floor(elapsed / MINUTE)
        return count === 1
            ? i18n.t('Metadata from 1 minute ago')
            : interpolate(i18n.t('Metadata from {count} minutes ago'), {
                  count,
              })
    }
    if (elapsed < DAY) {
        const count = Math.floor(elapsed / HOUR)
        return count === 1
            ? i18n.t('Metadata from 1 hour ago')
            : interpolate(i18n.t('Metadata from {count} hours ago'), { count })
    }
    return i18n.t('Metadata from over a day ago')
}

function staleLabel(elapsed: number): string {
    if (elapsed < MINUTE) {
        return i18n.t('Metadata from just now and may be out of date')
    }
    if (elapsed < HOUR) {
        const count = Math.floor(elapsed / MINUTE)
        return count === 1
            ? i18n.t('Metadata from 1 minute ago and may be out of date')
            : interpolate(
                  i18n.t('Metadata from {count} minutes ago and may be out of date'),
                  { count }
              )
    }
    if (elapsed < DAY) {
        const count = Math.floor(elapsed / HOUR)
        return count === 1
            ? i18n.t('Metadata from 1 hour ago and may be out of date')
            : interpolate(
                  i18n.t('Metadata from {count} hours ago and may be out of date'),
                  { count }
              )
    }
    return i18n.t('Metadata from over a day ago and may be out of date')
}
