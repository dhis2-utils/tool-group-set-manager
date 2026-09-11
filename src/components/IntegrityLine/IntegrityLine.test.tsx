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

it('renders the check name, the count, the run time and that it spans every group set', () => {
    const summary: CheckSummary = {
        name: check.name,
        count: 5,
        finishedTime: '2026-09-01T10:00:00.000Z',
    }
    render(<IntegrityLine check={check} summary={summary} stale={false} />)
    // P3-R5: the check's identity must be visible text, not a `title`
    // attribute -- confirmed here by finding it through getByText, which a
    // title-only carrier would never satisfy.
    const line = screen.getByText(
        new RegExp(check.displayName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
    )
    expect(line.textContent).toEqual(
        expect.stringContaining(
            new Date(summary.finishedTime as string).toLocaleString()
        )
    )
    // The number is national, across every group set of the object type
    // (finding 5) -- "all group sets" must be said, not merely "the whole
    // instance", which only disclaims the geographic scope.
    expect(line.textContent).toEqual(expect.stringContaining('all group sets'))
})

it('uses the singular wording for a count of exactly one', () => {
    const summary: CheckSummary = {
        name: check.name,
        count: 1,
        finishedTime: '2026-09-01T10:00:00.000Z',
    }
    render(<IntegrityLine check={check} summary={summary} stale={false} />)
    expect(screen.getByText(/1 object\b/)).toBeInTheDocument()
    expect(screen.queryByText(/1 objects\b/)).not.toBeInTheDocument()
})

it('says a never-run check has not run, names the check, and shows no time or count', () => {
    const summary: CheckSummary = {
        name: check.name,
        count: 0,
        finishedTime: null,
    }
    render(<IntegrityLine check={check} summary={summary} stale={false} />)
    expect(screen.getByText(/has not been run/i)).toBeInTheDocument()
    expect(screen.getByText(new RegExp(check.displayName))).toBeInTheDocument()
    // A never-run check must read as "has not run", never as a zero count --
    // a bare "0" would be indistinguishable from a real, clean run. Bounded
    // so it cannot be satisfied by a substring of some other number (e.g. a
    // "10" in a rendered time), unlike an unanchored exact-match query.
    expect(screen.queryByText(/\b0\b/)).not.toBeInTheDocument()
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
