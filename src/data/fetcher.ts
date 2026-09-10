import { Fetcher } from './sources/DataSource'

export function createFetcher(baseUrl: string, apiVersion: number): Fetcher {
    const root = baseUrl.replace(/\/$/, '')
    return (path, init) => {
        const isCsv = /\.csv(\?|$)/.test(path)
        // Normalise via the Headers API rather than object-spreading
        // init.headers: a caller-supplied Headers instance (or an
        // array-of-pairs HeadersInit) has no own enumerable properties, so a
        // plain spread silently drops every header it carries.
        const headers = new Headers(init?.headers)
        if (!headers.has('Accept')) {
            headers.set('Accept', isCsv ? 'text/csv' : 'application/json')
        }
        return fetch(`${root}/api/${apiVersion}/${path}`, {
            credentials: 'include',
            ...init,
            headers,
        })
    }
}
