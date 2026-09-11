import i18n from '@dhis2/d2-i18n'
import { useEffect } from 'react'
import { NavLink, Outlet, useLocation } from 'react-router-dom'
import styles from './SyncUrlWithGlobalShell.module.css'

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

    return (
        <>
            {/* D2: the link to History (and back to the dashboard) lives
             * here, in the element both routes already share, rather than
             * duplicated onto each page -- this is a two-page app, so the
             * nav stays this small. */}
            <nav className={styles.nav}>
                <NavLink
                    to="/"
                    end
                    className={({ isActive }) =>
                        isActive ? styles.active : styles.link
                    }
                >
                    {i18n.t('Dashboard')}
                </NavLink>
                <NavLink
                    to="/history"
                    className={({ isActive }) =>
                        isActive ? styles.active : styles.link
                    }
                >
                    {i18n.t('History')}
                </NavLink>
            </nav>
            <Outlet />
        </>
    )
}
