import { act, fireEvent, render, screen } from '@testing-library/react'
import React from 'react'
import { MetadataFreshness } from './MetadataFreshness'
import { CACHE_TTL_MS } from '@/data/cache'

const mockReload = jest.fn(async () => undefined)
jest.mock('@/hooks/useEngine', () => ({
    useEngine: () => ({ reload: mockReload }),
}))

beforeEach(() => {
    // `mockReset`, not `mockClear`: two tests below install their own
    // implementation, and a leaked one would silently change what a later
    // test is exercising.
    mockReload.mockReset()
    mockReload.mockImplementation(async () => undefined)
})

it('renders nothing before anything has loaded', () => {
    const { container } = render(<MetadataFreshness loadedAt={null} />)
    expect(container).toBeEmptyDOMElement()
})

it('shows the age of the data', () => {
    render(<MetadataFreshness loadedAt={Date.now() - 2 * 60_000} />)
    expect(screen.getByText('Metadata from 2 minutes ago')).toBeInTheDocument()
})

it('says the data may be out of date once past the TTL', () => {
    render(<MetadataFreshness loadedAt={Date.now() - CACHE_TTL_MS - 60_000} />)
    expect(screen.getByText(/may be out of date/)).toBeInTheDocument()
})

it('forces a reload when refreshed -- never a cache-reusing one', async () => {
    render(<MetadataFreshness loadedAt={Date.now()} />)
    // `act` because the click leaves a promise in flight whose resolution
    // sets state again; without it React warns about the update landing
    // after the test body finished.
    await act(async () => {
        fireEvent.click(screen.getByRole('button', { name: 'Refresh' }))
    })
    expect(mockReload).toHaveBeenCalledWith(true)
})

/**
 * Found by the multi-version verification pass, measured against the EMIS
 * database: a forced reload clears `loadedAt`, and the control used to
 * return null on that -- so clicking Refresh made the age label and the
 * Refresh button itself disappear for the whole reload (117ms after the
 * click until 5.6s later) instead of showing the busy state.
 */
it('stays on screen while a reload is in flight, even once loadedAt clears', async () => {
    let finishReload: () => void = () => undefined
    mockReload.mockImplementation(
        () =>
            new Promise<undefined>((resolve) => {
                finishReload = () => resolve(undefined)
            })
    )

    const { rerender } = render(<MetadataFreshness loadedAt={Date.now()} />)
    fireEvent.click(screen.getByRole('button', { name: 'Refresh' }))

    // What the engine does for the duration of a forced reload.
    rerender(<MetadataFreshness loadedAt={null} />)

    expect(screen.getByRole('button', { name: 'Refresh' })).toBeDisabled()
    expect(screen.getByText('Reloading metadata…')).toBeInTheDocument()

    await act(async () => {
        finishReload()
    })
})

it('renders nothing again once an idle reload leaves no loaded data', async () => {
    mockReload.mockImplementation(async () => undefined)
    const { container, rerender } = render(
        <MetadataFreshness loadedAt={Date.now()} />
    )
    await act(async () => {
        fireEvent.click(screen.getByRole('button', { name: 'Refresh' }))
    })
    rerender(<MetadataFreshness loadedAt={null} />)
    expect(container).toBeEmptyDOMElement()
})

it('only ticks while it has an age to keep current', () => {
    jest.useFakeTimers()
    try {
        const { rerender } = render(<MetadataFreshness loadedAt={null} />)
        expect(jest.getTimerCount()).toBe(0)
        rerender(<MetadataFreshness loadedAt={Date.now()} />)
        expect(jest.getTimerCount()).toBe(1)
        rerender(<MetadataFreshness loadedAt={null} />)
        expect(jest.getTimerCount()).toBe(0)
    } finally {
        jest.useRealTimers()
    }
})
