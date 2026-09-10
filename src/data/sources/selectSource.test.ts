import { selectSource } from './selectSource'

const jsonResponse = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), { status })

const readableView = (id: string, code: string) => ({
    id,
    code,
    access: { data: { read: true } },
})

describe('selectSource', () => {
    it('picks the SQL view source when all three views are present and readable', async () => {
        const fetcher = async () =>
            jsonResponse({
                sqlViews: [
                    readableView('v1', 'GSI_ORGUNITS'),
                    readableView('v2', 'GSI_ORGUNIT_NAMES'),
                    readableView('v3', 'GSI_ORGUNIT_MEMBERSHIPS'),
                ],
            })
        const result = await selectSource(fetcher)
        expect(result.source.kind).toBe('sqlView')
        expect(result.sqlViews).toEqual({
            orgUnits: 'v1',
            orgUnitNames: 'v2',
            orgUnitMemberships: 'v3',
        })
    })

    it('falls back to metadata when one view is missing from the response', async () => {
        const fetcher = async () =>
            jsonResponse({
                sqlViews: [
                    readableView('v1', 'GSI_ORGUNITS'),
                    readableView('v2', 'GSI_ORGUNIT_NAMES'),
                    // GSI_ORGUNIT_MEMBERSHIPS missing
                ],
            })
        const result = await selectSource(fetcher)
        expect(result.source.kind).toBe('metadata')
        expect(result.sqlViews).toBeNull()
    })

    it('falls back to metadata when one view lacks access.data.read', async () => {
        const fetcher = async () =>
            jsonResponse({
                sqlViews: [
                    readableView('v1', 'GSI_ORGUNITS'),
                    readableView('v2', 'GSI_ORGUNIT_NAMES'),
                    {
                        id: 'v3',
                        code: 'GSI_ORGUNIT_MEMBERSHIPS',
                        access: { data: { read: false } },
                    },
                ],
            })
        const result = await selectSource(fetcher)
        expect(result.source.kind).toBe('metadata')
        expect(result.sqlViews).toBeNull()
    })

    it('falls back to metadata when the lookup fetch rejects', async () => {
        const fetcher = async (): Promise<Response> => {
            throw new Error('network down')
        }
        const result = await selectSource(fetcher)
        expect(result.source.kind).toBe('metadata')
        expect(result.sqlViews).toBeNull()
    })

    it('falls back to metadata when the lookup responds with an HTTP error', async () => {
        const fetcher = async () => jsonResponse({ message: 'Forbidden' }, 403)
        const result = await selectSource(fetcher)
        expect(result.source.kind).toBe('metadata')
        expect(result.sqlViews).toBeNull()
    })
})
