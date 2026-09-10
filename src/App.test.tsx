import { render, screen } from '@testing-library/react'
import React from 'react'
import App from './App'

it('renders the app title', () => {
    render(<App />)
    expect(screen.getByText('Group Set Integrity Tool')).toBeInTheDocument()
})
