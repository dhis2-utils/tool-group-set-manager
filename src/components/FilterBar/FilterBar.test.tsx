import { render, screen } from '@testing-library/react'
import React from 'react'
import { FilterBar, FilterBarField } from './FilterBar'

describe('FilterBar', () => {
    it('renders its children', () => {
        render(
            <FilterBar>
                <span>a field</span>
            </FilterBar>
        )
        expect(screen.getByText('a field')).toBeInTheDocument()
    })
})

describe('FilterBarField', () => {
    it('always renders its label, even around a control with no label of its own', () => {
        // The point of this component: a bare Button (unlike a
        // SingleSelectField) has no label above it, so without this
        // wrapper it would sit at a different height than a labelled
        // field next to it in the row.
        render(
            <FilterBarField label="Data">
                <button type="button">Reload data</button>
            </FilterBarField>
        )
        expect(screen.getByText('Data')).toBeInTheDocument()
        expect(
            screen.getByRole('button', { name: 'Reload data' })
        ).toBeInTheDocument()
    })

    it('renders its label as a complete, argument-free string, not built from parts', () => {
        render(
            <FilterBarField label="Organisation unit">
                <button type="button">Sierra Leone</button>
            </FilterBarField>
        )
        expect(screen.getByText('Organisation unit')).toBeInTheDocument()
    })
})
