import { render, screen } from '@testing-library/react'
import React from 'react'
import { MemoryRouter } from 'react-router-dom'
import { UsageTab } from './UsageTab'
import type { GroupSetMeta } from '@/engine/types'

const mockUsage = jest.fn()
jest.mock('@/hooks/useUsage', () => ({ useUsage: () => mockUsage() }))

const set = (over: Partial<GroupSetMeta> = {}): GroupSetMeta => ({
    id: 'a',
    displayName: 'Facility type',
    objectType: 'organisationUnit',
    compulsory: false,
    dataDimension: true,
    groups: [],
    canWrite: true,
    ...over,
})

const ready = (usage: unknown) => ({
    status: 'ready',
    error: null,
    forSet: () => usage,
    refresh: jest.fn(),
})

describe('UsageTab', () => {
    it('shows the favourite and view counts', () => {
        mockUsage.mockReturnValue(
            ready({
                favourites: 42,
                views12m: 100,
                byFavouriteType: [
                    {
                        favouriteType: 'visualization',
                        favourites: 37,
                        views12m: 89,
                    },
                    {
                        favouriteType: 'eventVisualization',
                        favourites: 4,
                        views12m: 11,
                    },
                    { favouriteType: 'map', favourites: 1, views12m: 0 },
                ],
            })
        )
        render(
            <MemoryRouter>
                <UsageTab set={set()} />
            </MemoryRouter>
        )
        expect(
            screen.getByText('42 favourites reference this group set')
        ).toBeInTheDocument()
        expect(
            screen.getByText('100 recorded uses in the last 12 months')
        ).toBeInTheDocument()
    })

    it('breaks the favourites down by favourite type', () => {
        mockUsage.mockReturnValue(
            ready({
                favourites: 38,
                views12m: 89,
                byFavouriteType: [
                    {
                        favouriteType: 'visualization',
                        favourites: 37,
                        views12m: 89,
                    },
                    { favouriteType: 'map', favourites: 1, views12m: 0 },
                ],
            })
        )
        render(
            <MemoryRouter>
                <UsageTab set={set()} />
            </MemoryRouter>
        )
        expect(screen.getByText('Charts and pivot tables')).toBeInTheDocument()
        expect(screen.getByText('Maps')).toBeInTheDocument()
    })

    it('always carries the caveat, so no count reads as proof', () => {
        mockUsage.mockReturnValue(
            ready({ favourites: 0, views12m: 0, byFavouriteType: [] })
        )
        render(
            <MemoryRouter>
                <UsageTab set={set()} />
            </MemoryRouter>
        )
        expect(
            screen.getByText(/leaves no favourite behind/)
        ).toBeInTheDocument()
    })

    it('words zero as "nothing on this instance references it", never as unused', () => {
        mockUsage.mockReturnValue(
            ready({ favourites: 0, views12m: 0, byFavouriteType: [] })
        )
        render(
            <MemoryRouter>
                <UsageTab set={set()} />
            </MemoryRouter>
        )
        expect(
            screen.getByText('No saved favourite references this group set')
        ).toBeInTheDocument()
    })

    it('says indicator group sets are not analytics dimensions instead of showing a zero', () => {
        mockUsage.mockReturnValue(
            ready({ favourites: 0, views12m: 0, byFavouriteType: [] })
        )
        render(
            <MemoryRouter>
                <UsageTab set={set({ objectType: 'indicator' })} />
            </MemoryRouter>
        )
        expect(
            screen.getByText(
                'Indicator group sets are not analytics dimensions, so there is no usage data for them.'
            )
        ).toBeInTheDocument()
        expect(
            screen.queryByText('No saved favourite references this group set')
        ).not.toBeInTheDocument()
    })

    it('prompts for the install when this instance has no usage view', () => {
        mockUsage.mockReturnValue({
            status: 'absent',
            error: null,
            forSet: () => null,
            refresh: jest.fn(),
        })
        render(
            <MemoryRouter>
                <UsageTab set={set()} />
            </MemoryRouter>
        )
        expect(
            screen.getByText('Usage data is not installed on this instance')
        ).toBeInTheDocument()
        // Pins the actual link target, not just its text -- a plain anchor
        // or a Link pointed at the wrong path would still satisfy the text
        // assertion above.
        expect(
            screen.getByRole('link', { name: 'Go to Settings to install it' })
        ).toHaveAttribute('href', '/settings')
    })

    it('shows a loader, not the install prompt, while the usage lookup is still in flight', () => {
        mockUsage.mockReturnValue({
            status: 'loading',
            error: null,
            forSet: () => null,
            refresh: jest.fn(),
        })
        render(
            <MemoryRouter>
                <UsageTab set={set()} />
            </MemoryRouter>
        )
        expect(
            screen.getByTestId('dhis2-uicore-circularloader')
        ).toBeInTheDocument()
        expect(
            screen.queryByText('Go to Settings to install it')
        ).not.toBeInTheDocument()
    })

    it('shows the error rather than an empty page when the view cannot be read', () => {
        mockUsage.mockReturnValue({
            status: 'error',
            error: 'HTTP 500',
            forSet: () => null,
            refresh: jest.fn(),
        })
        render(
            <MemoryRouter>
                <UsageTab set={set()} />
            </MemoryRouter>
        )
        expect(screen.getByText('HTTP 500')).toBeInTheDocument()
    })
})
