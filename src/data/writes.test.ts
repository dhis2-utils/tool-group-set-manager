import { writeMemberships } from './writes'
import { GroupChange } from '@/engine/changeSet'

const json = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), { status })

const okStats = (total: number) =>
    json({
        response: { stats: { total, updated: total, deleted: 0, ignored: 0 } },
    })

describe('writeMemberships', () => {
    it("sends one group's additions and deletions as a single request", async () => {
        const calls: { path: string; method: string; body: unknown }[] = []
        const fetcher = async (path: string, init?: RequestInit) => {
            calls.push({
                path,
                method: init?.method ?? 'GET',
                body: init?.body ? JSON.parse(init.body as string) : undefined,
            })
            return okStats(2)
        }
        const changes: GroupChange[] = [
            { groupId: 'g1', additions: ['a', 'b'], deletions: ['c'] },
        ]
        await writeMemberships(
            fetcher,
            'organisationUnit',
            changes,
            () => undefined
        )

        expect(calls).toEqual([
            {
                path: 'organisationUnitGroups/g1/organisationUnits',
                method: 'POST',
                body: {
                    additions: [{ id: 'a' }, { id: 'b' }],
                    deletions: [{ id: 'c' }],
                },
            },
        ])
    })

    it('splits a change larger than the batch size and reports progress once per batch', async () => {
        const calls: unknown[] = []
        const fetcher = async (path: string, init?: RequestInit) => {
            calls.push(JSON.parse(init?.body as string))
            const body = JSON.parse(init?.body as string) as {
                additions: unknown[]
                deletions: unknown[]
            }
            return okStats(body.additions.length + body.deletions.length)
        }
        const changes: GroupChange[] = [
            { groupId: 'g1', additions: ['a', 'b', 'c'], deletions: [] },
        ]
        const progress: [number, number][] = []
        const result = await writeMemberships(
            fetcher,
            'organisationUnit',
            changes,
            (done, total) => progress.push([done, total]),
            2
        )

        expect(calls).toEqual([
            { additions: [{ id: 'a' }, { id: 'b' }], deletions: [] },
            { additions: [{ id: 'c' }], deletions: [] },
        ])
        expect(progress).toEqual([
            [1, 2],
            [2, 2],
        ])
        expect(result.applied).toEqual([
            { groupId: 'g1', additions: ['a', 'b'], deletions: [] },
            { groupId: 'g1', additions: ['c'], deletions: [] },
        ])
    })

    it('reports a partial failure when the server accepts fewer changes than it was sent', async () => {
        const fetcher = async () =>
            new Response(
                JSON.stringify({
                    response: {
                        stats: { total: 1, updated: 1, deleted: 0, ignored: 0 },
                    },
                }),
                { status: 200 }
            )
        const result = await writeMemberships(
            fetcher,
            'organisationUnit',
            [{ groupId: 'g1', additions: ['a', 'b'], deletions: [] }],
            () => undefined
        )
        expect(result.outcomes[0]).toMatchObject({
            groupId: 'g1',
            requested: 2,
            accepted: 1,
        })
        expect(result.unaccounted).toEqual([
            { groupId: 'g1', additions: ['a', 'b'], deletions: [] },
        ])
        expect(result.applied).toEqual([])
    })

    it('treats a response with no stats at all as nothing accepted', async () => {
        const fetcher = async () => json({})
        const result = await writeMemberships(
            fetcher,
            'organisationUnit',
            [{ groupId: 'g1', additions: ['a'], deletions: [] }],
            () => undefined
        )
        expect(result.outcomes[0]).toMatchObject({
            groupId: 'g1',
            requested: 1,
            accepted: 0,
        })
        expect(result.unaccounted).toEqual([
            { groupId: 'g1', additions: ['a'], deletions: [] },
        ])
        expect(result.applied).toEqual([])
    })

    it('records a non-200 response as an error against that group without stopping the rest', async () => {
        const fetcher = async (path: string) => {
            if (path.includes('g1')) {
                return new Response('forbidden', { status: 403 })
            }
            return okStats(1)
        }
        const changes: GroupChange[] = [
            { groupId: 'g1', additions: ['a'], deletions: [] },
            { groupId: 'g2', additions: ['b'], deletions: [] },
        ]
        const result = await writeMemberships(
            fetcher,
            'organisationUnit',
            changes,
            () => undefined
        )

        expect(result.outcomes).toEqual([
            {
                groupId: 'g1',
                requested: 1,
                accepted: 0,
                error: 'HTTP 403',
            },
            { groupId: 'g2', requested: 1, accepted: 1 },
        ])
        expect(result.unaccounted).toEqual([
            { groupId: 'g1', additions: ['a'], deletions: [] },
        ])
        expect(result.applied).toEqual([
            { groupId: 'g2', additions: ['b'], deletions: [] },
        ])
    })

    it('an addition already present (ignored by the server) still counts as accepted', async () => {
        const fetcher = async () =>
            json({
                response: {
                    stats: {
                        total: 1,
                        created: 0,
                        updated: 0,
                        deleted: 0,
                        ignored: 1,
                    },
                },
            })
        const result = await writeMemberships(
            fetcher,
            'organisationUnit',
            [{ groupId: 'g1', additions: ['a'], deletions: [] }],
            () => undefined
        )
        expect(result.outcomes[0]).toMatchObject({ requested: 1, accepted: 1 })
        expect(result.applied).toEqual([
            { groupId: 'g1', additions: ['a'], deletions: [] },
        ])
    })

    it('one request per group, sequential, in the order the changes were given', async () => {
        const order: string[] = []
        const fetcher = async (path: string) => {
            order.push(path)
            return okStats(1)
        }
        const changes: GroupChange[] = [
            { groupId: 'g1', additions: ['a'], deletions: [] },
            { groupId: 'g2', additions: ['b'], deletions: [] },
        ]
        await writeMemberships(
            fetcher,
            'organisationUnit',
            changes,
            () => undefined
        )
        expect(order).toEqual([
            'organisationUnitGroups/g1/organisationUnits',
            'organisationUnitGroups/g2/organisationUnits',
        ])
    })

    it('a group with nothing to change makes no request', async () => {
        const calls: string[] = []
        const fetcher = async (path: string) => {
            calls.push(path)
            return okStats(0)
        }
        const changes: GroupChange[] = [
            { groupId: 'g1', additions: [], deletions: [] },
        ]
        const result = await writeMemberships(
            fetcher,
            'organisationUnit',
            changes,
            () => undefined
        )
        expect(calls).toEqual([])
        expect(result.outcomes).toEqual([])
        expect(result.applied).toEqual([])
        expect(result.unaccounted).toEqual([])
    })

    it('a network failure on one group is recorded as an error and does not stop the rest', async () => {
        const fetcher = async (path: string) => {
            if (path.includes('g1')) {
                throw new Error('network down')
            }
            return okStats(1)
        }
        const changes: GroupChange[] = [
            { groupId: 'g1', additions: ['a'], deletions: [] },
            { groupId: 'g2', additions: ['b'], deletions: [] },
        ]
        const result = await writeMemberships(
            fetcher,
            'organisationUnit',
            changes,
            () => undefined
        )
        expect(result.outcomes[0]).toMatchObject({
            groupId: 'g1',
            requested: 1,
            accepted: 0,
            error: 'network down',
        })
        expect(result.unaccounted).toEqual([
            { groupId: 'g1', additions: ['a'], deletions: [] },
        ])
        expect(result.applied).toEqual([
            { groupId: 'g2', additions: ['b'], deletions: [] },
        ])
    })
})
