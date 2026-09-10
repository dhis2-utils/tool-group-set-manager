import { groupIdsFor, loadGroupSets } from './groupSets'

const json = (body: unknown) =>
    new Response(JSON.stringify(body), { status: 200 })

describe('loadGroupSets', () => {
    it('maps every type, its flags and write access', async () => {
        const fetcher = async (path: string) => {
            if (path.startsWith('organisationUnitGroupSets')) {
                return json({
                    organisationUnitGroupSets: [
                        {
                            id: 'own',
                            displayName: 'Ownership',
                            compulsory: true,
                            dataDimension: true,
                            access: { write: true },
                            organisationUnitGroups: [
                                {
                                    id: 'pub',
                                    displayName: 'Public',
                                    code: 'PUB',
                                    access: { write: true },
                                },
                                {
                                    id: 'priv',
                                    displayName: 'Private',
                                    access: { write: false },
                                },
                            ],
                        },
                    ],
                })
            }
            if (path.startsWith('indicatorGroupSets')) {
                return json({
                    indicatorGroupSets: [
                        {
                            id: 'igs',
                            displayName: 'IGS',
                            compulsory: false,
                            access: { write: false },
                            indicatorGroups: [],
                        },
                    ],
                })
            }
            if (path.startsWith('categoryOptionGroupSets')) {
                return json({
                    categoryOptionGroupSets: [
                        {
                            id: 'cogs',
                            displayName: 'COGS',
                            dataDimension: true,
                            access: { write: true },
                            categoryOptionGroups: [],
                        },
                    ],
                })
            }
            return json({ dataElementGroupSets: [] })
        }
        const sets = await loadGroupSets(fetcher)
        expect(
            sets.map((s) => [
                s.id,
                s.objectType,
                s.compulsory,
                s.dataDimension,
                s.canWrite,
            ])
        ).toEqual([
            ['own', 'organisationUnit', true, true, true],
            ['igs', 'indicator', false, false, false],
            ['cogs', 'categoryOption', false, true, true],
        ])
        expect(sets[0].groups).toEqual([
            { id: 'pub', displayName: 'Public', code: 'PUB', canWrite: true },
            {
                id: 'priv',
                displayName: 'Private',
                code: undefined,
                canWrite: false,
            },
        ])
    })
})

describe('groupIdsFor', () => {
    it('returns unique group ids of the type, in order', () => {
        const sets = [
            {
                id: 'a',
                objectType: 'organisationUnit',
                groups: [{ id: 'g1' }, { id: 'g2' }],
            },
            {
                id: 'b',
                objectType: 'organisationUnit',
                groups: [{ id: 'g2' }, { id: 'g3' }],
            },
            { id: 'c', objectType: 'indicator', groups: [{ id: 'g9' }] },
        ] as never
        expect(groupIdsFor(sets, 'organisationUnit')).toEqual([
            'g1',
            'g2',
            'g3',
        ])
    })
})
