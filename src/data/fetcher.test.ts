import { createFetcher } from './fetcher'

describe('createFetcher', () => {
    it('builds versioned API urls and sends cookies', async () => {
        const spy = jest
            .spyOn(globalThis, 'fetch')
            .mockResolvedValue(new Response('{}', { status: 200 }))
        const fetcher = createFetcher('https://play.example/dhis', 41)
        await fetcher('organisationUnits?fields=id')
        expect(spy).toHaveBeenCalledWith(
            'https://play.example/dhis/api/41/organisationUnits?fields=id',
            expect.objectContaining({ credentials: 'include' })
        )
        const [firstUrl, firstInit] = spy.mock.calls[0]
        expect(firstUrl).toBe(
            'https://play.example/dhis/api/41/organisationUnits?fields=id'
        )
        expect(new Headers(firstInit?.headers).get('Accept')).toBe(
            'application/json'
        )

        await fetcher('sqlViews/x/data.csv?paging=false')
        const [secondUrl, secondInit] = spy.mock.calls[1]
        expect(secondUrl).toBe(
            'https://play.example/dhis/api/41/sqlViews/x/data.csv?paging=false'
        )
        expect(new Headers(secondInit?.headers).get('Accept')).toBe('text/csv')
        spy.mockRestore()
    })

    it('preserves a caller-supplied Headers instance instead of silently dropping it', async () => {
        const spy = jest
            .spyOn(globalThis, 'fetch')
            .mockResolvedValue(new Response('{}', { status: 200 }))
        const fetcher = createFetcher('https://play.example/dhis', 41)
        await fetcher('organisationUnits', {
            headers: new Headers({
                Accept: 'application/xml',
                'X-Custom': 'yes',
            }),
        })
        const [, init] = spy.mock.calls[0]
        const headers = new Headers(init?.headers)
        expect(headers.get('Accept')).toBe('application/xml')
        expect(headers.get('X-Custom')).toBe('yes')
        spy.mockRestore()
    })
})
