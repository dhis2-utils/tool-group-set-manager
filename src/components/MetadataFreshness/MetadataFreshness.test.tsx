import { fireEvent, render, screen } from '@testing-library/react'
import React from 'react'
import { MetadataFreshness } from './MetadataFreshness'
import { CACHE_TTL_MS } from '@/data/cache'

const mockReload = jest.fn(async () => undefined)
jest.mock('@/hooks/useEngine', () => ({
    useEngine: () => ({ reload: mockReload }),
}))

beforeEach(() => jest.clearAllMocks())

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
    expect(
        screen.getByText(/may be out of date/)
    ).toBeInTheDocument()
})

it('forces a reload when refreshed -- never a cache-reusing one', () => {
    render(<MetadataFreshness loadedAt={Date.now()} />)
    fireEvent.click(screen.getByRole('button', { name: 'Refresh' }))
    expect(mockReload).toHaveBeenCalledWith(true)
})
