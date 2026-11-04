import i18n from '@dhis2/d2-i18n'
import { NoticeBox } from '@dhis2/ui'
import React from 'react'
import { Link, useRouteError } from 'react-router-dom'

const pageStyle = { padding: 'var(--spacers-dp16)', maxWidth: 800 }

/**
 * M10: what an unknown route shows, instead of React Router's untranslated
 * developer screen.
 */
export const NotFound = () => (
    <div style={pageStyle}>
        <NoticeBox title={i18n.t('Page not found')}>
            <p>{i18n.t('There is no page at this address in this app.')}</p>
            <Link to="/">{i18n.t('Back to the dashboard')}</Link>
        </NoticeBox>
    </div>
)

/**
 * M10: what a render error anywhere under the router shows. A plain link
 * (to the hash route) rather than a router Link: the router that threw may
 * not be in a state to navigate.
 */
export const RouteError = () => {
    const error = useRouteError()
    return (
        <div style={pageStyle}>
            <NoticeBox error title={i18n.t('Something went wrong')}>
                <p>
                    {i18n.t(
                        'This page could not be shown. Reloading the app may help.'
                    )}
                </p>
                {error instanceof Error && <p>{error.message}</p>}
                <a href="#/">{i18n.t('Back to the dashboard')}</a>
            </NoticeBox>
        </div>
    )
}
