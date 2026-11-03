import { groupIdsFor, loadGroupSets } from './groupSets'

const json = (body: unknown) =>
    new Response(JSON.stringify(body), { status: 200 })

describe('loadGroupSets', () => {
    it('maps every type, its flags and write access', async () => {
        const fetcher = (path: string) => {
            if (path.startsWith('organisationUnitGroupSets')) {
                return Promise.resolve(
                    json({
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
                )
            }
            if (path.startsWith('indicatorGroupSets')) {
                return Promise.resolve(
                    json({
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
                )
            }
            if (path.startsWith('categoryOptionGroupSets')) {
                return Promise.resolve(
                    json({
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
                )
            }
            return Promise.resolve(json({ dataElementGroupSets: [] }))
        }
        const { sets, errors } = await loadGroupSets(fetcher)
        expect(errors).toEqual({})
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

    it('keeps the types that loaded when one type responds with an error', async () => {
        // Spec 6.4: a failure is per object type. A bare Promise.all here
        // rejected the whole load, so one unreadable type blanked the entire
        // dashboard behind a single "Loading failed" box.
        const fetcher = (path: string) => {
            if (path.startsWith('dataElementGroupSets')) {
                return Promise.resolve(json({ message: 'Forbidden' }))
            }
            if (path.startsWith('indicatorGroupSets')) {
                return Promise.resolve(new Response('nope', { status: 409 }))
            }
            if (path.startsWith('organisationUnitGroupSets')) {
                return Promise.resolve(
                    json({
                        organisationUnitGroupSets: [
                            {
                                id: 'own',
                                displayName: 'Ownership',
                                compulsory: true,
                                access: { write: true },
                                organisationUnitGroups: [],
                            },
                        ],
                    })
                )
            }
            return Promise.resolve(json({ categoryOptionGroupSets: [] }))
        }
        const { sets, errors } = await loadGroupSets(fetcher)
        expect(sets.map((s) => s.id)).toEqual(['own'])
        expect(errors.indicator).toMatch(/409/)
        expect(errors.organisationUnit).toBeUndefined()
        expect(errors.categoryOption).toBeUndefined()
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
