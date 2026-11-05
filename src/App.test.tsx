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
        restrictedSets: [],
        sourceKind: null,
        error: null,
        reload: () => Promise.resolve(undefined),
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
        run: () => Promise.resolve(undefined),
        markStale: () => undefined,
        refresh: () => Promise.resolve(undefined),
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
        setCatchAllGroup: () => Promise.resolve(undefined),
        setIncludeTracker: () => Promise.resolve(undefined),
    }),
}))
jest.mock('@/hooks/useScope', () => ({
    ScopeProvider: ({ children }: { children: React.ReactNode }) => (
        <>{children}</>
    ),
    useScope: () => ({
        rootId: null,
        rootName: '',
        rootLevel: null,
        setRoot: () => undefined,
        isReady: false,
    }),
}))
// OrgUnitField (rendered by the dashboard's FilterBar) reads its own roots
// for the tree through this hook; this test never opens the tree modal, so
// it only needs to resolve without hitting the real data engine.
jest.mock('@/hooks/useUserScope', () => ({
    useUserScope: () => ({ roots: [] }),
}))

test('renders the dashboard with the only-issues filter', () => {
    render(<App />)
    expect(screen.getByText('With issues')).toBeInTheDocument()
})
