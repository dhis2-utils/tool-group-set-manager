import { CssReset, CssVariables } from '@dhis2/ui'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import React from 'react'
import { createHashRouter, RouterProvider } from 'react-router-dom'
import './styles/fontSizes.css'
import { EngineProvider } from '@/hooks/useEngine'
import { GsiConfigProvider } from '@/hooks/useGsiConfig'
import { IntegrityProvider } from '@/hooks/useIntegrity'
import { ScopeProvider } from '@/hooks/useScope'
import { Dashboard } from '@/pages/Dashboard/Dashboard'
import { GroupSetDetail } from '@/pages/GroupSetDetail/GroupSetDetail'
import { History } from '@/pages/History/History'
import { NotFound, RouteError } from '@/pages/NotFound/NotFound'
import { Settings } from '@/pages/Settings/Settings'
import { SyncUrlWithGlobalShell } from '@/utils/SyncUrlWithGlobalShell'

const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: 1, refetchOnWindowFocus: false } },
})

const router = createHashRouter([
    {
        element: <SyncUrlWithGlobalShell />,
        // M10: a render error anywhere below, translated, with a way back,
        // instead of React Router's developer screen.
        errorElement: <RouteError />,
        children: [
            { path: '/', element: <Dashboard /> },
            { path: '/sets/:setId', element: <GroupSetDetail /> },
            { path: '/history', element: <History /> },
            { path: '/settings', element: <Settings /> },
            { path: '*', element: <NotFound /> },
        ],
    },
])

const App = () => (
    <QueryClientProvider client={queryClient}>
        <CssReset />
        <CssVariables theme spacers colors elevations />
        <ScopeProvider>
            <EngineProvider>
                <IntegrityProvider>
                    <GsiConfigProvider>
                        <RouterProvider router={router} />
                    </GsiConfigProvider>
                </IntegrityProvider>
            </EngineProvider>
        </ScopeProvider>
    </QueryClientProvider>
)

export default App
