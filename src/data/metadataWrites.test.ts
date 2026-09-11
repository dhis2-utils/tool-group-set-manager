import { createCatchAllGroup, setGroupSetProperties } from './metadataWrites'
import { GroupSetMeta } from '@/engine/types'

const json = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), { status })

const sharing = {
    owner: 'u1',
    public: 'rwrw----',
    users: {},
    userGroups: { g1: 'r-------' },
}

function buildSet(overrides: Partial<GroupSetMeta> = {}): GroupSetMeta {
    return {
        id: 'set1',
        displayName: 'Ownership',
        objectType: 'organisationUnit',
        compulsory: true,
        dataDimension: false,
        canWrite: true,
        groups: [
            { id: 'g1', displayName: 'Group A', canWrite: true },
            { id: 'g2', displayName: 'Group B', canWrite: true },
        ],
        ...overrides,
    }
}

type Call = { path: string; method: string; body: unknown }

function fakeFetcher(handlers: Record<string, (call: Call) => Response>) {
    const calls: Call[] = []
    const fetcher = async (path: string, init?: RequestInit) => {
        const call: Call = {
            path,
            method: init?.method ?? 'GET',
            body: init?.body ? JSON.parse(init.body as string) : undefined,
        }
        calls.push(call)
        for (const [pattern, handler] of Object.entries(handlers)) {
            if (path.startsWith(pattern)) {
                return handler(call)
            }
        }
        throw new Error(`Unhandled request: ${call.method} ${path}`)
    }
    return { fetcher, calls }
}

describe('createCatchAllGroup', () => {
    it('creates a set-specific group, copies sibling sharing, and adds it to the set', async () => {
        const set = buildSet()
        const { fetcher, calls } = fakeFetcher({
            'organisationUnitGroupSets/set1?': () => json({ code: 'OWN' }),
            'organisationUnitGroups/g1?': () => json({ sharing }),
            organisationUnitGroups: (call) => {
                if (call.method === 'POST') {
                    return json({ response: { uid: 'newGroup' } }, 201)
                }
                throw new Error('unexpected')
            },
            'organisationUnitGroupSets/set1/groups/newGroup': () =>
                json({}, 200),
        })

        const created = await createCatchAllGroup(fetcher, set)

        expect(created).toEqual({
            id: 'newGroup',
            displayName: 'Other/unknown Ownership',
        })

        const createCall = calls.find(
            (c) => c.path === 'organisationUnitGroups' && c.method === 'POST'
        )
        expect(createCall?.body).toMatchObject({
            name: 'Other/unknown Ownership',
            shortName: 'Other/unknown Ownership',
            code: 'OWN_OTHER',
            sharing,
        })

        const addCall = calls.find((c) =>
            c.path.startsWith('organisationUnitGroupSets/set1/groups/newGroup')
        )
        expect(addCall?.method).toBe('POST')
    })

    it('truncates a long short name to 50 characters instead of rejecting the create', async () => {
        const set = buildSet({
            displayName:
                'A very long group set name that will not fit into fifty characters at all',
        })
        const { fetcher, calls } = fakeFetcher({
            'organisationUnitGroupSets/set1?': () => json({}),
            'organisationUnitGroups/g1?': () => json({ sharing }),
            organisationUnitGroups: (call) => {
                if (call.method === 'POST') {
                    return json({ response: { uid: 'newGroup' } }, 201)
                }
                throw new Error('unexpected')
            },
            'organisationUnitGroupSets/set1/groups/newGroup': () =>
                json({}, 200),
        })

        await createCatchAllGroup(fetcher, set)

        const createCall = calls.find(
            (c) => c.path === 'organisationUnitGroups' && c.method === 'POST'
        )
        const body = createCall?.body as { shortName: string; name: string }
        expect(body.shortName.length).toBeLessThanOrEqual(50)
        expect(body.name.length).toBeGreaterThan(50)
    })

    it('produces no code when the set has none', async () => {
        const set = buildSet()
        const { fetcher, calls } = fakeFetcher({
            'organisationUnitGroupSets/set1?': () => json({}), // no code field
            'organisationUnitGroups/g1?': () => json({ sharing }),
            organisationUnitGroups: (call) => {
                if (call.method === 'POST') {
                    return json({ response: { uid: 'newGroup' } }, 201)
                }
                throw new Error('unexpected')
            },
            'organisationUnitGroupSets/set1/groups/newGroup': () =>
                json({}, 200),
        })

        await createCatchAllGroup(fetcher, set)

        const createCall = calls.find(
            (c) => c.path === 'organisationUnitGroups' && c.method === 'POST'
        )
        expect(createCall?.body).not.toHaveProperty('code')
    })

    it('produces sensible default sharing, and does not throw, for a set with no existing groups', async () => {
        const set = buildSet({ groups: [] })
        const { fetcher, calls } = fakeFetcher({
            'organisationUnitGroupSets/set1?': () => json({ code: 'OWN' }),
            organisationUnitGroups: (call) => {
                if (call.method === 'POST') {
                    return json({ response: { uid: 'newGroup' } }, 201)
                }
                throw new Error('unexpected')
            },
            'organisationUnitGroupSets/set1/groups/newGroup': () =>
                json({}, 200),
        })

        const created = await createCatchAllGroup(fetcher, set)
        expect(created.id).toBe('newGroup')

        const createCall = calls.find(
            (c) => c.path === 'organisationUnitGroups' && c.method === 'POST'
        )
        const body = createCall?.body as { sharing: unknown }
        expect(body.sharing).toBeTruthy()
    })

    it('throws when the create request fails', async () => {
        const set = buildSet()
        const { fetcher } = fakeFetcher({
            'organisationUnitGroupSets/set1?': () => json({}),
            'organisationUnitGroups/g1?': () => json({ sharing }),
            organisationUnitGroups: () => json({}, 500),
        })
        await expect(createCatchAllGroup(fetcher, set)).rejects.toThrow()
    })
})

describe('setGroupSetProperties', () => {
    it('sends a JSON patch for the given properties', async () => {
        const calls: Call[] = []
        const fetcher = async (path: string, init?: RequestInit) => {
            calls.push({
                path,
                method: init?.method ?? 'GET',
                body: init?.body ? JSON.parse(init.body as string) : undefined,
            })
            return json({}, 200)
        }
        await setGroupSetProperties(
            fetcher,
            { objectType: 'organisationUnit', setId: 'set1' },
            {
                compulsory: true,
                dataDimension: false,
            }
        )
        expect(calls).toEqual([
            {
                path: 'organisationUnitGroupSets/set1',
                method: 'PATCH',
                body: [
                    { op: 'replace', path: '/compulsory', value: true },
                    { op: 'replace', path: '/dataDimension', value: false },
                ],
            },
        ])
    })

    it('sends nothing when no property is given', async () => {
        const fetcher = jest.fn()
        await setGroupSetProperties(
            fetcher,
            { objectType: 'organisationUnit', setId: 'set1' },
            {}
        )
        expect(fetcher).not.toHaveBeenCalled()
    })

    it('throws when the patch fails', async () => {
        const fetcher = async () => json({}, 500)
        await expect(
            setGroupSetProperties(
                fetcher,
                { objectType: 'organisationUnit', setId: 'set1' },
                {
                    compulsory: true,
                }
            )
        ).rejects.toThrow()
    })
})
