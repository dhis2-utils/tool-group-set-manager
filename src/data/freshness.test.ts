import {
    assignmentExpectations,
    changeExpectations,
    findMembershipDrift,
} from './freshness'
import type { Fetcher } from './sources/DataSource'

describe('changeExpectations', () => {
    it('takes deletions as current members and additions as non-members', () => {
        expect(
            changeExpectations([
                { groupId: 'g1', additions: ['a'], deletions: ['b'] },
            ])
        ).toEqual(new Map([['g1', { members: ['b'], nonMembers: ['a'] }]]))
    })
})

describe('assignmentExpectations', () => {
    it('assumes every touched object is in the target unless added to it, and in no other touched group it is not deleted from', () => {
        const expectations = assignmentExpectations(
            [
                { groupId: 'g1', additions: [], deletions: ['x'] },
                { groupId: 'g2', additions: ['x'], deletions: [] },
                { groupId: 'g3', additions: [], deletions: ['y'] },
            ],
            'g2'
        )
        expect(expectations).toEqual(
            new Map([
                ['g1', { members: ['x'], nonMembers: ['y'] }],
                // y is only deleted from g3, so it is already in the target.
                ['g2', { members: ['y'], nonMembers: ['x'] }],
                ['g3', { members: ['y'], nonMembers: ['x'] }],
            ])
        )
    })

    it('includes the target even when the plan has no change for it', () => {
        expect(
            assignmentExpectations(
                [{ groupId: 'g1', additions: [], deletions: ['x'] }],
                'g2'
            ).get('g2')
        ).toEqual({ members: ['x'], nonMembers: [] })
    })
})

describe('findMembershipDrift', () => {
    const serving = (members: Record<string, string[]>) =>
        ((path: string) => {
            const groupId = /Groups\/([^/]+)\//.exec(path)?.[1] ?? ''
            const asked =
                /id:in:\[([^\]]*)\]/
                    .exec(decodeURIComponent(path))?.[1]
                    .split(',') ?? []
            const held = new Set(members[groupId] ?? [])
            return Promise.resolve(
                new Response(
                    JSON.stringify({
                        organisationUnits: asked
                            .filter((id) => held.has(id))
                            .map((id) => ({ id })),
                    })
                )
            )
        }) as Fetcher

    it('is empty when every assumption still holds', async () => {
        await expect(
            findMembershipDrift(serving({ g1: ['a'] }), 'organisationUnit', {
                expectations: changeExpectations([
                    { groupId: 'g1', additions: ['b'], deletions: ['a'] },
                ]),
            })
        ).resolves.toEqual([])
    })

    it('reports what changed as corrections to apply to the engine', async () => {
        await expect(
            findMembershipDrift(
                serving({ g1: ['b'], g2: [] }),
                'organisationUnit',
                {
                    expectations: changeExpectations([
                        { groupId: 'g1', additions: ['b'], deletions: ['a'] },
                        { groupId: 'g2', additions: [], deletions: ['c'] },
                    ]),
                }
            )
        ).resolves.toEqual([
            { groupId: 'g1', additions: ['b'], deletions: ['a'] },
            { groupId: 'g2', additions: [], deletions: ['c'] },
        ])
    })

    it('rejects when a read fails, so nothing is written on an unchecked plan', async () => {
        const fetcher = (() =>
            Promise.resolve(new Response('', { status: 500 }))) as Fetcher
        await expect(
            findMembershipDrift(fetcher, 'organisationUnit', {
                expectations: changeExpectations([
                    { groupId: 'g1', additions: ['a'], deletions: [] },
                ]),
            })
        ).rejects.toThrow('HTTP 500')
    })
})
