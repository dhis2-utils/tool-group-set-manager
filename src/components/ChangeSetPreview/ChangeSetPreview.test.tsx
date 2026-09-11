import { render, screen } from '@testing-library/react'
import React from 'react'
import { ChangeSetPreview } from './ChangeSetPreview'
import { GroupChange } from '@/engine/changeSet'

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
                objects={{ total: 3, sample: [], skipped: [] }}
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
                    skipped: [],
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
                    skipped: [{ id: 'x1', displayName: 'Skipped One' }],
                }}
            />
        )
        expect(screen.getByText(/Skipped One/)).toBeInTheDocument()
        expect(screen.getByText(/read-only/i)).toBeInTheDocument()
    })

    it('renders no read-only callout when nothing was skipped', () => {
        render(
            <ChangeSetPreview
                changes={[]}
                groups={groups}
                objects={{ total: 0, sample: [], skipped: [] }}
            />
        )
        expect(screen.queryByText(/read-only/i)).not.toBeInTheDocument()
    })
})
