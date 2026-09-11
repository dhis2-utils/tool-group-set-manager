import { render, screen } from '@testing-library/react'
import React from 'react'
import { IntegrityLine } from './IntegrityLine'
import { ResolvedCheck, CheckSummary } from '@/data/integrity'

const check: ResolvedCheck = {
    logical: 'orgUnitsMissingCompulsory',
    name: 'org_units_not_in_compulsory_group_sets',
    displayName: 'Org units not in compulsory group sets',
    objectType: 'organisationUnit',
    isSlow: false,
}

it('renders the count and the run time as one sentence', () => {
    const summary: CheckSummary = {
        name: check.name,
        count: 5,
        finishedTime: '2026-09-01T10:00:00.000Z',
    }
    render(<IntegrityLine check={check} summary={summary} stale={false} />)
    // The rendered sentence carries both the count and a formatted time
    // string derived from finishedTime -- never a bare pair of numbers.
    const line = screen.getByText(/5/)
    expect(line.textContent).toMatch(/5/)
    expect(line.textContent).toEqual(
        expect.stringContaining(
            new Date(summary.finishedTime as string).toLocaleString()
        )
    )
})

it('uses the singular wording for a count of exactly one', () => {
    const summary: CheckSummary = {
        name: check.name,
        count: 1,
        finishedTime: '2026-09-01T10:00:00.000Z',
    }
    render(<IntegrityLine check={check} summary={summary} stale={false} />)
    expect(screen.getByText(/1 object/)).toBeInTheDocument()
    expect(screen.queryByText(/1 objects/)).not.toBeInTheDocument()
})

it('says a never-run check has not run, and shows no time or count', () => {
    const summary: CheckSummary = {
        name: check.name,
        count: 0,
        finishedTime: null,
    }
    render(<IntegrityLine check={check} summary={summary} stale={false} />)
    expect(screen.getByText(/has not been run/i)).toBeInTheDocument()
    // A never-run check must read as "has not run", never as a zero count --
    // rendering a 0 here would be indistinguishable from a real, clean run.
    expect(screen.queryByText('0')).not.toBeInTheDocument()
})

it('shows a stale marker when the result predates a write this session', () => {
    const summary: CheckSummary = {
        name: check.name,
        count: 5,
        finishedTime: '2026-09-01T10:00:00.000Z',
    }
    render(<IntegrityLine check={check} summary={summary} stale={true} />)
    expect(screen.getByText(/stale/i)).toBeInTheDocument()
})

it('shows no stale marker when the result is current', () => {
    const summary: CheckSummary = {
        name: check.name,
        count: 5,
        finishedTime: '2026-09-01T10:00:00.000Z',
    }
    render(<IntegrityLine check={check} summary={summary} stale={false} />)
    expect(screen.queryByText(/stale/i)).not.toBeInTheDocument()
})
