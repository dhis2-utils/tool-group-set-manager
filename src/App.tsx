import { CssReset, CssVariables } from '@dhis2/ui'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import React from 'react'
import { createHashRouter, RouterProvider } from 'react-router-dom'
import { EngineProvider } from '@/hooks/useEngine'
import { ScopeProvider } from '@/hooks/useScope'
import { Dashboard } from '@/pages/Dashboard/Dashboard'
import { GroupSetDetail } from '@/pages/GroupSetDetail/GroupSetDetail'
import { History } from '@/pages/History/History'
import { SyncUrlWithGlobalShell } from '@/utils/SyncUrlWithGlobalShell'

const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: 1, refetchOnWindowFocus: false } },
})

const router = createHashRouter([
    {
        element: <SyncUrlWithGlobalShell />,
        children: [
            { path: '/', element: <Dashboard /> },
            { path: '/sets/:setId', element: <GroupSetDetail /> },
            { path: '/history', element: <History /> },
        ],
    },
])

const App = () => (
    <QueryClientProvider client={queryClient}>
        <CssReset />
        <CssVariables theme spacers colors elevations />
        <ScopeProvider>
            <EngineProvider>
                <RouterProvider router={router} />
            </EngineProvider>
        </ScopeProvider>
    </QueryClientProvider>
)

export default App
