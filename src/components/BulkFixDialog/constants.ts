import { Status } from '@/engine/types'

/**
 * How long the pre-write freshness check may run before it is abandoned.
 *
 * Not a performance budget -- it is the escape hatch for a check that never
 * settles, which would otherwise leave the dialog unclosable (Cancel, Back
 * and the modal's own close affordance are all disabled while it runs).
 * Well above anything measured: the re-read costs 1-2s per group and runs
 * the groups in parallel, and the slowest whole check observed on the
 * largest real database (266,396 organisation units) was single-digit
 * seconds. A legitimate check has to be an order of magnitude slower than
 * ever seen to hit this, and when it does nothing has been written and
 * Apply can simply be pressed again.
 */
export const CHECK_TIMEOUT_MS = 60_000

/**
 * Stored in `checkError` when the deadline above wins, so the notice can say
 * "took too long" rather than the generic "failed" -- different words
 * because they call for different things from the reader. Locale-neutral by
 * construction: `checkError` is diagnostic only and is never rendered, the
 * same convention `applyError` follows.
 */
export const CHECK_TIMEOUT = 'CHECK_TIMEOUT'

export type Action = 'moveToCatchAll' | 'assignAll'
export type Step = 'action' | 'preview' | 'apply'

export const SAMPLE_SIZE = 20
// M3: fetched larger than the displayed sample so rows the plan actually
// changes can be sorted to the front before slicing down to SAMPLE_SIZE --
// otherwise a page full of already-correct rows (no change at all) could
// fill the whole visible sample while the real changes sit further down.
export const SAMPLE_FETCH_SIZE = 100
export const CSV_PAGE_SIZE = 1000

/**
 * DHIS2's own cap on a group's `shortName`. Duplicated from
 * metadataWrites.ts deliberately: that module enforces it when generating a
 * name, this one when validating one the user typed, and the two checks
 * happen at different moments for different reasons. Exporting it from
 * there would read as though one check implied the other.
 */
export const MAX_SHORT_NAME_LENGTH = 50

/** A group whose own name suggests it is the catch-all for its set. */
export const CATCH_ALL_NAME_PATTERN = /other|unknown/i

/**
 * Spec 3.2/3.4's violations: missing from a set that requires membership
 * (at error or warning severity) or in conflict between two of its
 * groups. "Move to catch-all" is restricted to exactly this population
 * (see the Critical fix in task-7-fix1.md) -- an object with any other
 * status is, by definition, already correctly categorised, and moving it
 * would strip it out of the group it is correctly in.
 */
export const VIOLATION_STATUSES = [
    Status.MissingError,
    Status.MissingWarning,
    Status.Conflict,
]
