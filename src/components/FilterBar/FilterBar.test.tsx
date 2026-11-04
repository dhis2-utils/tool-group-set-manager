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

    // Carried forward from Plan 8: `status` is the one shared, two-consumer
    // thing that work added (Dashboard and GroupSetDetail both pass it), and
    // `MetadataFreshness.test.tsx` renders that component standalone -- so
    // nothing exercised the two together anywhere but the e2e flow.
    it('renders a status slot alongside its children, outside the field row', () => {
        const { container } = render(
            <FilterBar status={<span>Metadata from just now</span>}>
                <span>a field</span>
            </FilterBar>
        )
        expect(screen.getByText('a field')).toBeInTheDocument()
        expect(screen.getByText('Metadata from just now')).toBeInTheDocument()
        // Not inside the row: the row is the label-above controls, and the
        // status deliberately sits outside them (see FilterBar.tsx).
        const row = container.querySelector('[data-test="filter-bar"] > div')
        expect(row).not.toBeNull()
        expect(row).toHaveTextContent('a field')
        expect(row).not.toHaveTextContent('Metadata from just now')
    })

    it('renders no status container at all when given none', () => {
        const { container } = render(
            <FilterBar>
                <span>a field</span>
            </FilterBar>
        )
        // One child, not an empty second div -- `status &&` guards it.
        expect(
            container.querySelectorAll('[data-test="filter-bar"] > div')
        ).toHaveLength(1)
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

    it('names the control it wraps by its label, as a labelled group', () => {
        render(
            <FilterBarField label="Group set">
                <button type="button">Ownership</button>
            </FilterBarField>
        )
        expect(
            screen.getByRole('group', { name: 'Group set' })
        ).toContainElement(screen.getByRole('button', { name: 'Ownership' }))
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
