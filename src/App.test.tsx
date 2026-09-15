import { render, screen } from '@testing-library/react'
import React from 'react'
import App from './App'

jest.mock('@/hooks/useEngine', () => ({
    EngineProvider: ({ children }: { children: React.ReactNode }) => (
        <>{children}</>
    ),
    useEngine: () => ({
        client: null,
        status: null,
        groupSets: [],
        sourceKind: null,
        error: null,
        reload: async () => undefined,
    }),
}))
jest.mock('@/hooks/useIntegrity', () => ({
    IntegrityProvider: ({ children }: { children: React.ReactNode }) => (
        <>{children}</>
    ),
    useIntegrity: () => ({
        available: false,
        checks: [],
        summaries: {},
        stale: new Set(),
        isRunning: false,
        error: null,
        run: async () => undefined,
        markStale: () => undefined,
        refresh: async () => undefined,
    }),
}))
jest.mock('@/hooks/useGsiConfig', () => ({
    GsiConfigProvider: ({ children }: { children: React.ReactNode }) => (
        <>{children}</>
    ),
    useGsiConfig: () => ({
        config: {
            catchAllGroup: {},
            includeTracker: false,
        },
        isLoaded: true,
        setCatchAllGroup: async () => undefined,
        setIncludeTracker: async () => undefined,
    }),
}))
jest.mock('@/hooks/useScope', () => ({
    ScopeProvider: ({ children }: { children: React.ReactNode }) => (
        <>{children}</>
    ),
    useScope: () => ({
        rootId: null,
        rootName: '',
        setRoot: () => undefined,
        isReady: false,
    }),
}))
jest.mock('@/components/ScopeSelector/ScopeSelector', () => ({
    ScopeSelector: () => <div>scope</div>,
}))

it('renders the dashboard with the only-issues filter', () => {
    render(<App />)
    expect(screen.getByText('Only sets with issues')).toBeInTheDocument()
})
