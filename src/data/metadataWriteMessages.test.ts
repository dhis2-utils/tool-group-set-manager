import {
    catchAllCreationErrorMessage,
    setPropertiesErrorMessage,
} from './metadataWriteMessages'
import {
    createCatchAllGroup,
    MetadataWriteError,
    NAME_OWNED_BY_ANOTHER_SET,
} from './metadataWrites'
import type { GroupSetMeta } from '@/engine/types'

const json = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), { status })

describe('catchAllCreationErrorMessage', () => {
    it('says which property a 409 found in use', () => {
        expect(
            catchAllCreationErrorMessage(
                new MetadataWriteError('createGroup', 409, ['shortName'])
            )
        ).toMatch(/already uses this short name/)
        expect(
            catchAllCreationErrorMessage(
                new MetadataWriteError('createGroup', 409, ['code'])
            )
        ).toMatch(/already uses its code/)
        expect(
            catchAllCreationErrorMessage(
                new MetadataWriteError('createGroup', 409, [])
            )
        ).toMatch(/name, short name or code/)
    })

    it('tells a permission refusal and a half-finished create apart', () => {
        expect(
            catchAllCreationErrorMessage(
                new MetadataWriteError('createGroup', 403)
            )
        ).toMatch(/do not have permission to create/)
        expect(
            catchAllCreationErrorMessage(
                new MetadataWriteError('addToSet', 500)
            )
        ).toBe(
            'The catch-all group was created, but could not be added to the group set (HTTP 500). Try again to finish.'
        )
    })

    it('never shows the raw English of a lookup failure or a network error', () => {
        expect(
            catchAllCreationErrorMessage(
                new Error(
                    'organisationUnitGroups?filter=x failed with HTTP 500'
                )
            )
        ).toBe('The catch-all group could not be created (HTTP 500).')
        expect(
            catchAllCreationErrorMessage(new TypeError('Failed to fetch'))
        ).toMatch(/Check your connection/)
    })

    it('keeps the cross-set name sentence', () => {
        expect(
            catchAllCreationErrorMessage(new Error(NAME_OWNED_BY_ANOTHER_SET))
        ).toMatch(/already belongs to a different group set/)
    })
})

describe('setPropertiesErrorMessage', () => {
    it('maps statuses to whole sentences', () => {
        expect(
            setPropertiesErrorMessage(new MetadataWriteError('updateSet', 403))
        ).toBe('You do not have permission to change this group set.')
        expect(
            setPropertiesErrorMessage(new MetadataWriteError('updateSet', 500))
        ).toBe('The group set could not be updated (HTTP 500).')
        expect(setPropertiesErrorMessage(new TypeError('x'))).toMatch(
            /Check your connection/
        )
    })
})

describe('MetadataWriteError from createCatchAllGroup', () => {
    it("reads the conflicting property out of a 409's import report", async () => {
        const set: GroupSetMeta = {
            id: 'set1abcdefg',
            displayName: 'Ownership',
            objectType: 'organisationUnit',
            compulsory: true,
            dataDimension: true,
            canWrite: true,
            groups: [],
        }
        const fetcher = (path: string, init?: RequestInit) => {
            const method = init?.method ?? 'GET'
            if (method === 'POST') {
                return Promise.resolve(
                    json(
                        {
                            status: 'ERROR',
                            response: {
                                errorReports: [
                                    {
                                        errorCode: 'E5003',
                                        errorProperty: 'shortName',
                                    },
                                ],
                            },
                        },
                        409
                    )
                )
            }
            if (path.startsWith('organisationUnitGroups?')) {
                return Promise.resolve(json({ organisationUnitGroups: [] }))
            }
            return Promise.resolve(json({}))
        }
        const error = await createCatchAllGroup(fetcher, set).catch(
            (e: unknown) => e
        )
        expect(error).toBeInstanceOf(MetadataWriteError)
        expect(error).toMatchObject({
            step: 'createGroup',
            status: 409,
            conflicts: ['shortName'],
        })
    })
})
