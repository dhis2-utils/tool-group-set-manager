import { createMetadataSource } from './metadataSource'

const jsonResponse = (body: unknown) =>
    new Response(JSON.stringify(body), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
    })

describe('metadataSource', () => {
    it('loads org units with level and parent and ignores paging', async () => {
        const calls: string[] = []
        const fetcher = async (path: string) => {
            calls.push(path)
            return jsonResponse({
                organisationUnits: [
                    { id: 'r', level: 1 },
                    { id: 'a', level: 2, parent: { id: 'r' } },
                ],
            })
        }
        const source = createMetadataSource(fetcher)
        const payload = await source.loadObjects(
            'organisationUnit',
            () => undefined
        )
        expect(calls[0]).toBe(
            'organisationUnits?fields=id,level,parent&paging=false'
        )
        expect(payload.ids).toEqual(['r', 'a'])
        expect(Array.from(payload.level ?? [])).toEqual([1, 2])
        expect(payload.parentIds).toEqual([null, 'r'])
        expect(payload.names).toBeNull()
    })

    it('loads data elements with names and domain type in one request', async () => {
        const fetcher = async () =>
            jsonResponse({
                dataElements: [
                    { id: 'd1', displayName: 'D1', domainType: 'AGGREGATE' },
                    { id: 'd2', displayName: 'D2', domainType: 'TRACKER' },
                ],
            })
        const payload = await createMetadataSource(fetcher).loadObjects(
            'dataElement',
            () => undefined
        )
        expect(payload.names).toEqual(['D1', 'D2'])
        expect(Array.from(payload.domainType ?? [])).toEqual([1, 2])
    })

    it('loads category options with their categories', async () => {
        const fetcher = async () =>
            jsonResponse({
                categoryOptions: [
                    {
                        id: 'o1',
                        displayName: 'O1',
                        categories: [{ id: 'c1' }, { id: 'c2' }],
                    },
                ],
            })
        const payload = await createMetadataSource(fetcher).loadObjects(
            'categoryOption',
            () => undefined
        )
        expect(payload.categoryIdsOfOption).toEqual([['c1', 'c2']])
    })

    it('loads memberships one group per request and reports progress', async () => {
        const calls: string[] = []
        const fetcher = async (path: string) => {
            calls.push(path)
            return jsonResponse({
                organisationUnits: [{ id: 'a' }, { id: 'b' }],
            })
        }
        const progress: number[] = []
        const payload = await createMetadataSource(fetcher).loadMemberships(
            'organisationUnit',
            ['g1', 'g2'],
            (p) => progress.push(p.done)
        )
        expect(calls).toEqual([
            'organisationUnitGroups/g1/organisationUnits?fields=id&paging=false',
            'organisationUnitGroups/g2/organisationUnits?fields=id&paging=false',
        ])
        expect(payload.groups).toEqual([
            { groupId: 'g1', memberIds: ['a', 'b'] },
            { groupId: 'g2', memberIds: ['a', 'b'] },
        ])
        expect(progress).toEqual([1, 2])
    })

    it('loads memberships for a group with no members as an empty array', async () => {
        const fetcher = async () => jsonResponse({ organisationUnits: [] })
        const payload = await createMetadataSource(fetcher).loadMemberships(
            'organisationUnit',
            ['g1'],
            () => undefined
        )
        expect(payload.groups).toEqual([{ groupId: 'g1', memberIds: [] }])
    })
})
