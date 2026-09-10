import { Fetcher } from './sources/DataSource'

export function createFetcher(baseUrl: string, apiVersion: number): Fetcher {
    const root = baseUrl.replace(/\/$/, '')
    return (path, init) => {
        const isCsv = /\.csv(\?|$)/.test(path)
        return fetch(`${root}/api/${apiVersion}/${path}`, {
            credentials: 'include',
            ...init,
            headers: {
                Accept: isCsv ? 'text/csv' : 'application/json',
                ...(init?.headers ?? {}),
            },
        })
    }
}
