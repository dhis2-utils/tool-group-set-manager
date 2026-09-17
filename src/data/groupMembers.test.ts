import { readGroupMembers } from './groupMembers'
import { Fetcher } from './sources/DataSource'

const ok = (body: unknown) =>
    ({ ok: true, status: 200, json: async () => body }) as unknown as Response

describe('readGroupMembers', () => {
    it('reads each group by id only, unpaged, bypassing the browser cache', async () => {
        const fetcher = jest.fn(async () =>
            ok({ organisationUnits: [{ id: 'm1' }, { id: 'm2' }] })
        ) as unknown as jest.Mock
        const result = await readGroupMembers(
            fetcher as unknown as Fetcher,
            'organisationUnit',
            ['g1']
        )
        expect(result).toEqual(new Map([['g1', ['m1', 'm2']]]))
        const [path, init] = fetcher.mock.calls[0] as [string, RequestInit]
        expect(path).toBe(
            'organisationUnitGroups/g1/organisationUnits?fields=id&paging=false'
        )
        expect(init.cache).toBe('no-store')
    })

    it('reads every group and keys the result by group id', async () => {
        const fetcher = jest.fn(async (path: string) =>
            ok({
                dataElements: [{ id: path.includes('/a/') ? 'ma' : 'mb' }],
            })
        ) as unknown as Fetcher
        const result = await readGroupMembers(fetcher, 'dataElement', [
            'a',
            'b',
        ])
        expect(result).toEqual(
            new Map([
                ['a', ['ma']],
                ['b', ['mb']],
            ])
        )
    })

    it('returns an empty map for no groups without a request', async () => {
        const fetcher = jest.fn() as unknown as Fetcher
        await expect(
            readGroupMembers(fetcher, 'organisationUnit', [])
        ).resolves.toEqual(new Map())
        expect(fetcher).not.toHaveBeenCalled()
    })

    it('rejects with the status when a read fails', async () => {
        const fetcher = jest.fn(
            async () => ({ ok: false, status: 502 }) as unknown as Response
        ) as unknown as Fetcher
        await expect(
            readGroupMembers(fetcher, 'organisationUnit', ['g1'])
        ).rejects.toThrow('HTTP 502')
    })

    it('passes the abort signal to every request', async () => {
        const controller = new AbortController()
        const fetcher = jest.fn(async () =>
            ok({ organisationUnits: [] })
        ) as unknown as jest.Mock
        await readGroupMembers(
            fetcher as unknown as Fetcher,
            'organisationUnit',
            ['g1', 'g2'],
            controller.signal
        )
        fetcher.mock.calls.forEach(([, init]: [string, RequestInit]) =>
            expect(init.signal).toBe(controller.signal)
        )
    })
})
