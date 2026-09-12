import { aggregateOutcomes, mergeOutcomes, outcomeText } from './writeOutcomes'
import { BatchOutcome, UNPARSEABLE_RESPONSE } from './writes'

const batch = (
    o: Partial<BatchOutcome> & { groupId: string }
): BatchOutcome => ({
    requested: 500,
    accepted: 500,
    ...o,
})

describe('aggregateOutcomes', () => {
    it('collects every batch of a group while summing its counts', () => {
        const a = batch({ groupId: 'g1' })
        const b = batch({ groupId: 'g1', accepted: 0, error: 'HTTP 500' })
        const c = batch({ groupId: 'g2', requested: 10, accepted: 10 })

        expect(aggregateOutcomes([a, b, c])).toEqual([
            { groupId: 'g1', requested: 1000, accepted: 500, batches: [a, b] },
            { groupId: 'g2', requested: 10, accepted: 10, batches: [c] },
        ])
    })
})

describe('outcomeText', () => {
    const textFor = (batches: BatchOutcome[]) =>
        outcomeText(aggregateOutcomes(batches)[0], 'Group one')

    it('calls a group valid only when every batch was confirmed in full', () => {
        const { tone } = textFor([
            batch({ groupId: 'g1' }),
            batch({ groupId: 'g1' }),
        ])
        expect(tone).toBe('valid')
    })

    it('warns, not fails, when some batches were confirmed and some were not', () => {
        const { tone, text } = textFor([
            batch({ groupId: 'g1' }),
            batch({ groupId: 'g1', accepted: 0, error: 'HTTP 500' }),
        ])
        expect(tone).toBe('warning')
        expect(text).toContain('some of its batches were confirmed')
        expect(text).toContain('500 of 1000')
    })

    it('reports an error only when no batch was confirmed and one errored', () => {
        const { tone, text } = textFor([
            batch({ groupId: 'g1', accepted: 0, error: 'HTTP 500' }),
        ])
        expect(tone).toBe('error')
        expect(text).toContain('HTTP 500')
    })

    // Minor 2 (fix round 1): the UNPARSEABLE_RESPONSE sentinel writes.ts
    // records for a non-JSON 200 must never reach the user as itself --
    // this is the one place that turns it into prose. Re-reviewed: it gets
    // its own whole sentence rather than a translated clause interpolated
    // into the {error} placeholder, because a clause does not reorder with
    // the rest of the sentence in most languages.
    it('gives the UNPARSEABLE_RESPONSE sentinel its own sentence instead of splicing it in raw', () => {
        const { tone, text } = textFor([
            batch({ groupId: 'g1', accepted: 0, error: UNPARSEABLE_RESPONSE }),
        ])
        expect(tone).toBe('error')
        expect(text).not.toContain(UNPARSEABLE_RESPONSE)
        expect(text).toMatch(/could not read/i)
        // The token sentence is the other branch, and must not appear:
        // spliced together, the two would read as one run-on failure.
        expect(text).not.toMatch(/failed with error/i)
    })

    // A group split across batches can fail both ways at once. Each error
    // kind keeps its own complete sentence; neither is folded into the
    // other's placeholder.
    it('gives a group that failed both ways one sentence for each', () => {
        const { tone, text } = textFor([
            batch({ groupId: 'g1', accepted: 0, error: 'HTTP 500' }),
            batch({ groupId: 'g1', accepted: 0, error: UNPARSEABLE_RESPONSE }),
        ])
        expect(tone).toBe('error')
        expect(text).toMatch(/failed with error/i)
        expect(text).toContain('HTTP 500')
        expect(text).toMatch(/could not read/i)
        expect(text).not.toContain(UNPARSEABLE_RESPONSE)
    })

    it('reports a silent short accept as a partial acceptance, not a failure', () => {
        const { tone, text } = textFor([
            batch({ groupId: 'g1', requested: 500, accepted: 400 }),
        ])
        expect(tone).toBe('warning')
        expect(text).toContain('400 of 500')
        expect(text).not.toContain('failed')
    })

    it('does not classify on the summed counts, so an over-reporting batch cannot cancel a short one', () => {
        // 600 + 400 === 500 + 500: the sums say "all accepted", the batches
        // say neither was confirmed.
        const { tone } = textFor([
            batch({ groupId: 'g1', requested: 500, accepted: 600 }),
            batch({ groupId: 'g1', requested: 500, accepted: 400 }),
        ])
        expect(tone).toBe('warning')
    })
})

describe('mergeOutcomes', () => {
    it('keeps a group the retry did not report on', () => {
        const other = batch({ groupId: 'g2' })
        const retried = batch({ groupId: 'g1', accepted: 0, error: 'HTTP 500' })
        expect(
            mergeOutcomes([other, batch({ groupId: 'g1' })], [retried])
        ).toEqual([other, batch({ groupId: 'g1' }), retried])
    })

    it('keeps the confirmed batches of a group whose failed batch is retried and fails again', () => {
        // I1: a retry resends only `unaccounted`, a subset of the group's
        // batches. What the server already confirmed is real and permanent
        // and must never be dropped from the panel.
        const confirmed = batch({ groupId: 'g1' })
        const failed = batch({ groupId: 'g1', accepted: 0, error: 'HTTP 500' })
        const retryFailed = batch({
            groupId: 'g1',
            accepted: 0,
            error: 'HTTP 409',
        })

        const merged = mergeOutcomes([confirmed, failed], [retryFailed])

        expect(merged).toEqual([confirmed, retryFailed])
        const { tone, text } = outcomeText(
            aggregateOutcomes(merged)[0],
            'Group one'
        )
        expect(tone).toBe('warning')
        expect(text).toContain('500 of 1000')
    })

    it('drops only the unconfirmed batches a successful retry replaces', () => {
        const confirmed = batch({ groupId: 'g1' })
        const failed = batch({ groupId: 'g1', accepted: 0, error: 'HTTP 500' })
        const retryOk = batch({ groupId: 'g1' })

        const merged = mergeOutcomes([confirmed, failed], [retryOk])

        expect(merged).toEqual([confirmed, retryOk])
        expect(
            outcomeText(aggregateOutcomes(merged)[0], 'Group one').tone
        ).toBe('valid')
    })
})
