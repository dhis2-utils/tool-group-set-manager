import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import React from 'react'
import { ScopeTrail } from './ScopeTrail'

const trail = [
    { id: 'r', name: 'Sierra Leone' },
    { id: 'b', name: 'Bo' },
]

describe('ScopeTrail', () => {
    it('renders nothing until a drill-down has happened', () => {
        const { container } = render(
            <ScopeTrail
                trail={[]}
                currentName="Sierra Leone"
                onJump={() => undefined}
            />
        )
        expect(container).toBeEmptyDOMElement()
    })

    it('shows every scope drilled through, and the current one as plain text', () => {
        render(
            <ScopeTrail
                trail={trail}
                currentName="Badjia"
                onJump={() => undefined}
            />
        )
        expect(
            screen.getByRole('button', { name: 'Sierra Leone' })
        ).toBeInTheDocument()
        expect(screen.getByRole('button', { name: 'Bo' })).toBeInTheDocument()
        // The scope you are already in is not a way back to anywhere.
        expect(
            screen.queryByRole('button', { name: 'Badjia' })
        ).not.toBeInTheDocument()
        expect(screen.getByText('Badjia')).toBeInTheDocument()
    })

    it('reports which crumb was chosen by its position, not its name', async () => {
        const onJump = jest.fn()
        render(
            <ScopeTrail trail={trail} currentName="Badjia" onJump={onJump} />
        )
        await userEvent.click(screen.getByRole('button', { name: 'Bo' }))
        expect(onJump).toHaveBeenCalledWith(1)
    })

    // Two organisation units may share a display name -- the trail is a path,
    // so position is the only thing that identifies a crumb unambiguously.
    it('keeps two same-named crumbs apart', async () => {
        const onJump = jest.fn()
        render(
            <ScopeTrail
                trail={[
                    { id: 'a', name: 'Central' },
                    { id: 'b', name: 'Central' },
                ]}
                currentName="Ward 3"
                onJump={onJump}
            />
        )
        const crumbs = screen.getAllByRole('button', { name: 'Central' })
        expect(crumbs).toHaveLength(2)
        await userEvent.click(crumbs[0])
        expect(onJump).toHaveBeenCalledWith(0)
    })
})
