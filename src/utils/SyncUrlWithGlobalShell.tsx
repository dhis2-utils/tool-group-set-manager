import { useEffect } from 'react'
import { Outlet, useLocation } from 'react-router-dom'

/*
 * In the DHIS2 Global Shell, react-router no longer fires "popstate" on
 * pushState/replaceState. The shell listens for "popstate" to keep the
 * browser URL in sync, so we dispatch it on every route change.
 */
export const SyncUrlWithGlobalShell = () => {
    const location = useLocation()

    useEffect(() => {
        dispatchEvent(new PopStateEvent('popstate'))
    }, [location.key])

    return <Outlet />
}
