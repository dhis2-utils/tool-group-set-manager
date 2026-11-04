import {
    FILTER_CHUNK_SIZE,
    FULL_READ_THRESHOLD,
    readGroupMembers,
    readMembersAmong,
    readMembershipAmong,
} from './groupMembers'
import type { Fetcher } from './sources/DataSource'

const ok = (body: unknown) =>
    ({
        ok: true,
        status: 200,
        json: () => Promise.resolve(body),
    }) as unknown as Response

describe('readGroupMembers', () => {
    it('reads each group by id only, unpaged, bypassing the browser cache', async () => {
        const fetcher = jest.fn(() =>
            Promise.resolve(
                ok({ organisationUnits: [{ id: 'm1' }, { id: 'm2' }] })
            )
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
        const fetcher = jest.fn((path: string) =>
            Promise.resolve(
                ok({
                    dataElements: [{ id: path.includes('/a/') ? 'ma' : 'mb' }],
                })
            )
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
        const fetcher = jest.fn(() =>
            Promise.resolve({ ok: false, status: 502 } as unknown as Response)
        ) as unknown as Fetcher
        await expect(
            readGroupMembers(fetcher, 'organisationUnit', ['g1'])
        ).rejects.toThrow('HTTP 502')
    })

    it('passes the abort signal to every request', async () => {
        const controller = new AbortController()
        const fetcher = jest.fn(() =>
            Promise.resolve(ok({ organisationUnits: [] }))
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

describe('readMembersAmong', () => {
    const idsFromFilter = (path: string): string[] => {
        const match = /id:in:\[([^\]]*)\]/.exec(decodeURIComponent(path))
        return match ? match[1].split(',') : []
    }

    it('asks for exactly the given ids, in chunks, and reports which are members', async () => {
        const members = new Set(['m3', `m${FILTER_CHUNK_SIZE + 4}`])
        const fetcher = jest.fn((path: string) =>
            Promise.resolve(
                ok({
                    organisationUnits: idsFromFilter(path)
                        .filter((id) => members.has(id))
                        .map((id) => ({ id })),
                })
            )
        ) as unknown as jest.Mock
        const ids = Array.from(
            { length: FILTER_CHUNK_SIZE + 10 },
            (_, i) => `m${i}`
        )
        const present = await readMembersAmong(
            fetcher as unknown as Fetcher,
            'organisationUnit',
            'g1',
            ids
        )
        expect(present).toEqual(members)
        expect(fetcher).toHaveBeenCalledTimes(2)
        expect(idsFromFilter(fetcher.mock.calls[0][0])).toHaveLength(
            FILTER_CHUNK_SIZE
        )
        expect(fetcher.mock.calls[0][1].cache).toBe('no-store')
    })

    it('reads the whole group once when there are too many ids to ask for one by one', async () => {
        const fetcher = jest.fn(() =>
            Promise.resolve(
                ok({ organisationUnits: [{ id: 'm1' }, { id: 'other' }] })
            )
        ) as unknown as jest.Mock
        const ids = Array.from(
            { length: FULL_READ_THRESHOLD + 1 },
            (_, i) => `m${i}`
        )
        const present = await readMembersAmong(
            fetcher as unknown as Fetcher,
            'organisationUnit',
            'g1',
            ids
        )
        expect(present).toEqual(new Set(['m1']))
        expect(fetcher).toHaveBeenCalledTimes(1)
        expect(fetcher.mock.calls[0][0]).toBe(
            'organisationUnitGroups/g1/organisationUnits?fields=id&paging=false'
        )
    })

    it('reads nothing for no ids', async () => {
        const fetcher = jest.fn()
        await expect(
            readMembersAmong(
                fetcher as unknown as Fetcher,
                'organisationUnit',
                'g1',
                []
            )
        ).resolves.toEqual(new Set())
        expect(fetcher).not.toHaveBeenCalled()
    })

    it('checks each group for its own ids', async () => {
        const fetcher = jest.fn((path: string) =>
            Promise.resolve(
                ok({
                    organisationUnits: idsFromFilter(path).map((id) => ({
                        id,
                    })),
                })
            )
        ) as unknown as Fetcher
        const result = await readMembershipAmong(
            fetcher,
            'organisationUnit',
            new Map([
                ['g1', ['a']],
                ['g2', ['b', 'c']],
            ])
        )
        expect(result).toEqual(
            new Map([
                ['g1', new Set(['a'])],
                ['g2', new Set(['b', 'c'])],
            ])
        )
    })
})
