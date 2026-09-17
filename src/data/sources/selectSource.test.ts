import { selectSource } from './selectSource'

const jsonResponse = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), { status })

const readableView = (id: string, code: string, type = 'VIEW') => ({
    id,
    code,
    type,
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

    it('keeps the SQL view path when only the names view is missing, and takes names from the metadata API', async () => {
        // Spec 8a's remedy for an instance that needs translated organisation
        // unit names is to remove GSI_ORGUNIT_NAMES. That must cost names
        // alone: the hierarchy and the memberships are the expensive reads
        // (roughly 4s versus 60-70s on a 266k-unit instance), and they carry
        // no names to translate.
        const fetcher = async () =>
            jsonResponse({
                sqlViews: [
                    readableView('v1', 'GSI_ORGUNITS'),
                    // GSI_ORGUNIT_NAMES removed by an administrator
                    readableView('v3', 'GSI_ORGUNIT_MEMBERSHIPS'),
                ],
            })
        const result = await selectSource(fetcher)
        expect(result.source.kind).toBe('sqlView')
        expect(result.source.nameSource).toBe('metadata')
        expect(result.sqlViews).toEqual({
            orgUnits: 'v1',
            orgUnitNames: null,
            orgUnitMemberships: 'v3',
        })
    })

    it('treats an unreadable or materialised names view the same as an absent one', async () => {
        const fetcher = async () =>
            jsonResponse({
                sqlViews: [
                    readableView('v1', 'GSI_ORGUNITS'),
                    {
                        ...readableView('v2', 'GSI_ORGUNIT_NAMES'),
                        type: 'MATERIALIZED_VIEW',
                    },
                    readableView('v3', 'GSI_ORGUNIT_MEMBERSHIPS'),
                ],
            })
        const result = await selectSource(fetcher)
        expect(result.source.kind).toBe('sqlView')
        expect(result.source.nameSource).toBe('metadata')
        expect(result.sqlViews?.orgUnitNames).toBeNull()
    })

    it('reports names as coming from the views when all three are usable', async () => {
        const fetcher = async () =>
            jsonResponse({
                sqlViews: [
                    readableView('v1', 'GSI_ORGUNITS'),
                    readableView('v2', 'GSI_ORGUNIT_NAMES'),
                    readableView('v3', 'GSI_ORGUNIT_MEMBERSHIPS'),
                ],
            })
        const result = await selectSource(fetcher)
        expect(result.source.nameSource).toBe('sqlView')
    })

    it('reports metadata names on the metadata source', async () => {
        const fetcher = async () => jsonResponse({ sqlViews: [] })
        const result = await selectSource(fetcher)
        expect(result.source.kind).toBe('metadata')
        expect(result.source.nameSource).toBe('metadata')
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

    it('falls back to metadata when a view reports no type at all', async () => {
        // A trimmed or older response carrying no `type` must not let a
        // materialised view through: an unknown type is unusable, because
        // the staleness the check exists to catch is invisible to the user.
        const fetcher = async () =>
            jsonResponse({
                sqlViews: [
                    readableView('v1', 'GSI_ORGUNITS'),
                    readableView('v2', 'GSI_ORGUNIT_NAMES'),
                    {
                        id: 'v3',
                        code: 'GSI_ORGUNIT_MEMBERSHIPS',
                        access: { data: { read: true } },
                    },
                ],
            })
        const result = await selectSource(fetcher)
        expect(result.source.kind).toBe('metadata')
        expect(result.sqlViews).toBeNull()
    })

    it('falls back to metadata when a view is materialised', async () => {
        // A MATERIALIZED_VIEW returns whatever was written the last time
        // someone executed it, with nothing in the response to say how old
        // that is -- confident counts from arbitrarily stale rows.
        const fetcher = async () =>
            jsonResponse({
                sqlViews: [
                    readableView('v1', 'GSI_ORGUNITS'),
                    readableView('v2', 'GSI_ORGUNIT_NAMES'),
                    {
                        ...readableView('v3', 'GSI_ORGUNIT_MEMBERSHIPS'),
                        type: 'MATERIALIZED_VIEW',
                    },
                ],
            })
        const result = await selectSource(fetcher)
        expect(result.source.kind).toBe('metadata')
        expect(result.sqlViews).toBeNull()
    })

    it('accepts plain views and queries, and asks the server for the type', async () => {
        const paths: string[] = []
        const fetcher = async (path: string) => {
            paths.push(path)
            return jsonResponse({
                sqlViews: [
                    { ...readableView('v1', 'GSI_ORGUNITS'), type: 'VIEW' },
                    {
                        ...readableView('v2', 'GSI_ORGUNIT_NAMES'),
                        type: 'QUERY',
                    },
                    {
                        ...readableView('v3', 'GSI_ORGUNIT_MEMBERSHIPS'),
                        type: 'VIEW',
                    },
                ],
            })
        }
        const result = await selectSource(fetcher)
        expect(result.source.kind).toBe('sqlView')
        expect(paths[0]).toContain('type')
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
