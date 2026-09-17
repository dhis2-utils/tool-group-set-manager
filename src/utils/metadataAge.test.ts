import { CACHE_TTL_MS } from '@/data/cache'
import { metadataAge } from '@/utils/metadataAge'

const NOW = 1_700_000_000_000

describe('metadataAge', () => {
    it('reads as just now under a minute', () => {
        expect(metadataAge(NOW - 59_000, NOW).label).toBe(
            'Metadata from just now'
        )
    })

    it('uses the singular string at exactly one minute', () => {
        expect(metadataAge(NOW - 60_000, NOW).label).toBe(
            'Metadata from 1 minute ago'
        )
    })

    it('uses the plural string for several minutes', () => {
        expect(metadataAge(NOW - 5 * 60_000, NOW).label).toBe(
            'Metadata from 5 minutes ago'
        )
    })

    // Sixty minutes is already past CACHE_TTL_MS (ten minutes), so this
    // reaches the stale hour-formatting branch, not the fresh one -- there
    // is no elapsed time that is both an hour (or more) old and still
    // inside a ten-minute TTL.
    it('switches to hours at sixty minutes', () => {
        expect(metadataAge(NOW - 60 * 60_000, NOW).label).toBe(
            'Metadata from 1 hour ago and may be out of date'
        )
    })

    it('stops at over a day rather than counting days', () => {
        expect(metadataAge(NOW - 50 * 60 * 60_000, NOW).label).toBe(
            'Metadata from over a day ago and may be out of date'
        )
    })

    it('is not stale inside the TTL', () => {
        expect(metadataAge(NOW - CACHE_TTL_MS + 1, NOW).stale).toBe(false)
    })

    it('is stale past the TTL, and says so in one whole sentence', () => {
        const { label, stale } = metadataAge(NOW - 2 * 60 * 60_000, NOW)
        expect(stale).toBe(true)
        expect(label).toBe('Metadata from 2 hours ago and may be out of date')
    })

    // A clock skew, or a savedAt written by a machine slightly ahead, must
    // not produce "Metadata from -3 minutes ago".
    it('treats a future timestamp as just now', () => {
        expect(metadataAge(NOW + 10_000, NOW).label).toBe(
            'Metadata from just now'
        )
    })
})
