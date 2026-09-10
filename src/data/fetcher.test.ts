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
            expect.objectContaining({
                credentials: 'include',
                headers: { Accept: 'application/json' },
            })
        )
        await fetcher('sqlViews/x/data.csv?paging=false')
        expect(spy).toHaveBeenLastCalledWith(
            'https://play.example/dhis/api/41/sqlViews/x/data.csv?paging=false',
            expect.objectContaining({ headers: { Accept: 'text/csv' } })
        )
        spy.mockRestore()
    })
})
