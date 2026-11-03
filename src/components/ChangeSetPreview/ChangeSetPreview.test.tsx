import { render, screen } from '@testing-library/react'
import React from 'react'
import type { PreviewRow } from './ChangeSetPreview'
import { ChangeSetPreview } from './ChangeSetPreview'
import type { GroupChange } from '@/engine/changeSet'
import type { GroupMeta } from '@/engine/types'

const groups = [
    { id: 'pub', displayName: 'Public', canWrite: true },
    { id: 'priv', displayName: 'Private', canWrite: true },
    { id: 'other', displayName: 'Other/unknown', canWrite: false },
]

describe('ChangeSetPreview', () => {
    it("renders one line per group with a signed count matching the plan's own additions/deletions", () => {
        // D3: the whole point of this test is that the rendered numbers
        // are read from `changes` itself, not recomputed independently --
        // so this asserts against `changes[i].additions.length` /
        // `deletions.length` directly rather than against a hand-counted
        // expectation.
        const changes: GroupChange[] = [
            { groupId: 'pub', additions: ['a1', 'a2'], deletions: [] },
            { groupId: 'priv', additions: [], deletions: ['a1', 'a2', 'a3'] },
        ]
        render(
            <ChangeSetPreview
                changes={changes}
                groups={groups}
                objects={{
                    total: 3,
                    sample: [],
                    skippedCount: 0,
                    skippedSample: [],
                }}
            />
        )
        const pubChange = changes.find((c) => c.groupId === 'pub')
        const privChange = changes.find((c) => c.groupId === 'priv')
        expect(
            screen.getByText(
                `+${pubChange?.additions.length} / -${pubChange?.deletions.length}`
            )
        ).toBeInTheDocument()
        expect(
            screen.getByText(
                `+${privChange?.additions.length} / -${privChange?.deletions.length}`
            )
        ).toBeInTheDocument()
        // A group untouched by the plan gets no line.
        expect(screen.queryByText('Other/unknown')).not.toBeInTheDocument()
    })

    it('renders a sample row with Now and After columns', () => {
        const changes: GroupChange[] = [
            { groupId: 'pub', additions: ['b1'], deletions: [] },
            { groupId: 'priv', additions: [], deletions: ['b1'] },
        ]
        render(
            <ChangeSetPreview
                changes={changes}
                groups={groups}
                objects={{
                    total: 1,
                    sample: [
                        { id: 'b1', displayName: 'B1', groups: [1] }, // priv
                    ],
                    skippedCount: 0,
                    skippedSample: [],
                }}
            />
        )
        const row = screen.getByText('B1').closest('tr') as HTMLElement
        const cells = row.querySelectorAll('td')
        expect(cells[1]).toHaveTextContent('Private')
        expect(cells[2]).toHaveTextContent('Public')
    })

    it('shows a callout naming objects skipped because a group involved is read-only', () => {
        render(
            <ChangeSetPreview
                changes={[]}
                groups={groups}
                objects={{
                    total: 0,
                    sample: [],
                    skippedCount: 1,
                    skippedSample: [{ id: 'x1', displayName: 'Skipped One' }],
                }}
            />
        )
        expect(screen.getByText(/Skipped One/)).toBeInTheDocument()
        expect(screen.getByText(/read-only/i)).toBeInTheDocument()
    })

    it('shows the exact skipped count and "and N more" when the sample is capped (I4)', () => {
        render(
            <ChangeSetPreview
                changes={[]}
                groups={groups}
                objects={{
                    total: 0,
                    sample: [],
                    skippedCount: 120,
                    skippedSample: [{ id: 'x1', displayName: 'Skipped One' }],
                }}
            />
        )
        expect(screen.getByText(/120 objects/)).toBeInTheDocument()
        expect(screen.getByText(/Skipped One/)).toBeInTheDocument()
        expect(screen.getByText(/and 119 more/)).toBeInTheDocument()
    })

    it('renders no read-only callout when nothing was skipped', () => {
        render(
            <ChangeSetPreview
                changes={[]}
                groups={groups}
                objects={{
                    total: 0,
                    sample: [],
                    skippedCount: 0,
                    skippedSample: [],
                }}
            />
        )
        expect(screen.queryByText(/read-only/i)).not.toBeInTheDocument()
    })
})

describe('ChangeSetPreview scale', () => {
    /**
     * Counts how many Sets are constructed while rendering a preview with
     * `rowCount` sampled rows. React allocates Sets of its own, so the
     * absolute number is not meaningful -- what matters is how it GROWS
     * with the row count, which is what separates the two shapes.
     */
    const setsBuiltForRows = (rowCount: number): number => {
        const RealSet = globalThis.Set
        let setsBuilt = 0
        class CountingSet<T> extends RealSet<T> {
            constructor(iterable?: Iterable<T> | null) {
                super(iterable ?? undefined)
                setsBuilt += 1
            }
        }
        const scaleGroups: GroupMeta[] = [
            { id: 'g1', displayName: 'Public', canWrite: true },
            { id: 'g2', displayName: 'Private', canWrite: true },
        ]
        const changes: GroupChange[] = [
            { groupId: 'g1', additions: ['o0'], deletions: [] },
            { groupId: 'g2', additions: [], deletions: ['o0'] },
        ]
        const sample: PreviewRow[] = Array.from(
            { length: rowCount },
            (_, i) => ({
                id: `o${i}`,
                displayName: `Object ${i}`,
                groups: [1],
            })
        )
        globalThis.Set = CountingSet as unknown as SetConstructor
        try {
            const { unmount } = render(
                <ChangeSetPreview
                    changes={changes}
                    groups={scaleGroups}
                    objects={{
                        total: sample.length,
                        sample,
                        skippedCount: 0,
                        skippedSample: [],
                    }}
                />
            )
            unmount()
        } finally {
            globalThis.Set = RealSet
        }
        return setsBuilt
    }

    it('prepares the change lookup once per render, not once per sampled row', () => {
        // The I2 fix replaced `Array.includes` with Sets, but building
        // those Sets inside the row loop restores the same quadratic
        // shape at sample scale: `prepareChanges` allocates two Sets per
        // group change, so calling it per row multiplies that by the
        // number of rows. Counting `includes` calls cannot see this at
        // all -- both the fixed and the regressed version call it zero
        // times -- so this counts Set construction instead, and measures
        // the growth rather than the total, since React builds Sets too.
        //
        // Prepared once, each extra row costs one Set: 20 more rows, 20
        // more Sets. Prepared per row with two changes it costs five: 20
        // more rows, 100 more Sets. The threshold sits between them.
        const growth = setsBuiltForRows(40) - setsBuiltForRows(20)
        expect(growth).toBeLessThan(50)
    })
})
