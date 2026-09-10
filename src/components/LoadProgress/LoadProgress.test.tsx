import { render, screen } from '@testing-library/react'
import React from 'react'
import { LoadProgress } from './LoadProgress'
import { LoadStatus } from '@/data/loadAll'

const status = (patch: Partial<LoadStatus>): LoadStatus => ({
    phase: 'objects',
    type: null,
    progress: null,
    fromCache: {},
    errors: {},
    ...patch,
})

it('says what it is doing as one whole sentence, not fragments joined by punctuation', () => {
    // The line used to be assembled here as "<phase>: <type> (<resource>
    // <done>/<total>)", which no translator could reorder and which showed
    // the raw API resource name. Each phase is now one complete string with
    // the type spliced into a placeholder.
    render(
        <LoadProgress
            status={status({
                phase: 'memberships',
                type: 'organisationUnit',
                progress: {
                    label: 'organisationUnitGroups',
                    done: 3,
                    total: 7,
                },
            })}
        />
    )
    expect(
        screen.getByText(/Loading group memberships for organisation units/)
    ).toBeInTheDocument()
    expect(screen.getByText(/3 of 7/)).toBeInTheDocument()
    expect(screen.queryByText(/organisationUnitGroups/)).not.toBeInTheDocument()
})

it('names the type in a complete sentence when a type fails to load', () => {
    render(
        <LoadProgress
            status={status({
                phase: 'done',
                errors: { indicator: 'HTTP 500' },
            })}
        />
    )
    expect(
        screen.getByText('Indicator group sets could not be loaded')
    ).toBeInTheDocument()
    expect(screen.getByText('HTTP 500')).toBeInTheDocument()
})

it('renders nothing once loading is done without errors', () => {
    const { container } = render(
        <LoadProgress status={status({ phase: 'done' })} />
    )
    expect(container).toBeEmptyDOMElement()
})
