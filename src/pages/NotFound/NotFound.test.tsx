import { render, screen } from '@testing-library/react'
import React from 'react'
import { createMemoryRouter, RouterProvider } from 'react-router-dom'
import { NotFound, RouteError } from './NotFound'

const Boom = () => {
    throw new Error('render failed')
}

const renderAt = (path: string) => {
    const router = createMemoryRouter(
        [
            {
                errorElement: <RouteError />,
                children: [
                    { path: '/', element: <p>dashboard</p> },
                    { path: '/boom', element: <Boom /> },
                    { path: '*', element: <NotFound /> },
                ],
            },
        ],
        { initialEntries: [path] }
    )
    render(<RouterProvider router={router} />)
}

describe('route dead ends', () => {
    it('shows a translated not-found page with a link back for an unknown route', () => {
        renderAt('/no/such/page')
        expect(screen.getByText('Page not found')).toBeInTheDocument()
        expect(
            screen.getByRole('link', { name: 'Back to the dashboard' })
        ).toHaveAttribute('href', '/')
    })

    it('shows a translated error page when a route throws while rendering', () => {
        jest.spyOn(console, 'error').mockImplementation(() => undefined)
        jest.spyOn(console, 'warn').mockImplementation(() => undefined)
        renderAt('/boom')
        expect(screen.getByText('Something went wrong')).toBeInTheDocument()
        expect(screen.getByText('render failed')).toBeInTheDocument()
        jest.restoreAllMocks()
    })
})
