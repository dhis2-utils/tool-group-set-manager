import i18n from '@dhis2/d2-i18n'
import { CssReset, CssVariables } from '@dhis2/ui'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import React from 'react'
import { createHashRouter, RouterProvider } from 'react-router-dom'
import { SyncUrlWithGlobalShell } from '@/utils/SyncUrlWithGlobalShell'

const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: 1, refetchOnWindowFocus: false } },
})

const router = createHashRouter([
    {
        element: <SyncUrlWithGlobalShell />,
        children: [
            {
                path: '/',
                element: <div>{i18n.t('Group Set Integrity Tool')}</div>,
            },
        ],
    },
])

const App = () => (
    <QueryClientProvider client={queryClient}>
        <CssReset />
        <CssVariables theme spacers colors elevations />
        <RouterProvider router={router} />
    </QueryClientProvider>
)

export default App
