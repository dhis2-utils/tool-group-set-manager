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
        id: 'set1abcdefg', // 11 characters, like a real DHIS2 uid
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

interface Call {
    path: string
    method: string
    contentType: string | null
    body: unknown
}

const lookupPath = (displayName: string) =>
    `organisationUnitGroups?filter=${encodeURIComponent(
        `name:eq:${displayName}`
    )}&fields=id&paging=false`

/**
 * A fetcher stub keyed by exact "METHOD path", per ruling P2-R15: every
 * request `createCatchAllGroup`/`setGroupSetProperties` issues must be
 * pinned to its literal path and method, not merely matched by prefix or
 * substring -- a prefix match is exactly what let both live-server
 * Criticals (C1, C2) slip past this file's tests last round.
 */
function scriptedFetcher(script: Record<string, () => Response>) {
    const calls: Call[] = []
    const fetcher = async (path: string, init?: RequestInit) => {
        const headers = new Headers(init?.headers)
        calls.push({
            path,
            method: init?.method ?? 'GET',
            contentType: headers.get('Content-Type'),
            body: init?.body ? JSON.parse(init.body as string) : undefined,
        })
        const key = `${init?.method ?? 'GET'} ${path}`
        const handler = script[key]
        if (!handler) {
            throw new Error(`Unhandled request: ${key}`)
        }
        return handler()
    }
    return { fetcher, calls }
}

describe('createCatchAllGroup', () => {
    it('creates a set-specific group, copies sibling sharing, and adds it to the set', async () => {
        const set = buildSet()
        const displayName = 'Other/unknown Ownership'
        const { fetcher, calls } = scriptedFetcher({
            [`GET ${lookupPath(displayName)}`]: () =>
                json({ organisationUnitGroups: [] }),
            'GET organisationUnitGroupSets/set1abcdefg?fields=code': () =>
                json({ code: 'OWN' }),
            'GET organisationUnitGroups/g1?fields=sharing': () =>
                json({ sharing }),
            'POST organisationUnitGroups': () =>
                json({ response: { uid: 'newGroup' } }, 201),
            'POST organisationUnitGroupSets/set1abcdefg/organisationUnitGroups/newGroup':
                () => json({ status: 'OK' }, 200),
        })

        const created = await createCatchAllGroup(fetcher, set)

        expect(created).toEqual({ id: 'newGroup', displayName })

        // Every call this function makes, exactly: path, method, and
        // Content-Type where DHIS2 requires one (C2 -- a POST with a body
        // and no Content-Type is rejected with 415 before the path is even
        // read).
        expect(calls).toEqual([
            {
                path: lookupPath(displayName),
                method: 'GET',
                contentType: null,
                body: undefined,
            },
            {
                path: 'organisationUnitGroupSets/set1abcdefg?fields=code',
                method: 'GET',
                contentType: null,
                body: undefined,
            },
            {
                path: 'organisationUnitGroups/g1?fields=sharing',
                method: 'GET',
                contentType: null,
                body: undefined,
            },
            {
                path: 'organisationUnitGroups',
                method: 'POST',
                contentType: 'application/json',
                body: {
                    name: displayName,
                    shortName: displayName,
                    code: 'OWN_OTHER',
                    sharing,
                },
            },
            {
                path: 'organisationUnitGroupSets/set1abcdefg/organisationUnitGroups/newGroup',
                method: 'POST',
                contentType: 'application/json',
                body: undefined,
            },
        ])
    })

    it('reserves the tail of a too-long short name for the set id (unique) rather than truncating blindly', async () => {
        const set = buildSet({
            displayName:
                'A very long group set name that will not fit into fifty characters at all',
        })
        const displayName = `Other/unknown ${set.displayName}`
        const expectedShortName = `${displayName.slice(0, 38)} ${set.id}`
        expect(expectedShortName).toHaveLength(50)

        const { fetcher, calls } = scriptedFetcher({
            [`GET ${lookupPath(displayName)}`]: () =>
                json({ organisationUnitGroups: [] }),
            'GET organisationUnitGroupSets/set1abcdefg?fields=code': () =>
                json({}),
            'GET organisationUnitGroups/g1?fields=sharing': () =>
                json({ sharing }),
            'POST organisationUnitGroups': () =>
                json({ response: { uid: 'newGroup' } }, 201),
            'POST organisationUnitGroupSets/set1abcdefg/organisationUnitGroups/newGroup':
                () => json({}, 200),
        })

        await createCatchAllGroup(fetcher, set)

        const createCall = calls.find(
            (c) => c.path === 'organisationUnitGroups' && c.method === 'POST'
        )
        const body = createCall?.body as { shortName: string; name: string }
        expect(body.shortName).toBe(expectedShortName)
        expect(body.name).toBe(displayName)
    })

    it('produces no code when the set has none', async () => {
        const set = buildSet()
        const displayName = 'Other/unknown Ownership'
        const { fetcher, calls } = scriptedFetcher({
            [`GET ${lookupPath(displayName)}`]: () =>
                json({ organisationUnitGroups: [] }),
            'GET organisationUnitGroupSets/set1abcdefg?fields=code': () =>
                json({}), // no code field
            'GET organisationUnitGroups/g1?fields=sharing': () =>
                json({ sharing }),
            'POST organisationUnitGroups': () =>
                json({ response: { uid: 'newGroup' } }, 201),
            'POST organisationUnitGroupSets/set1abcdefg/organisationUnitGroups/newGroup':
                () => json({}, 200),
        })

        await createCatchAllGroup(fetcher, set)

        const createCall = calls.find(
            (c) => c.path === 'organisationUnitGroups' && c.method === 'POST'
        )
        expect(createCall?.body).not.toHaveProperty('code')
    })

    it('produces exact, restrictive default sharing for a set with no existing groups, without throwing', async () => {
        const set = buildSet({ groups: [] })
        const displayName = 'Other/unknown Ownership'
        const { fetcher, calls } = scriptedFetcher({
            [`GET ${lookupPath(displayName)}`]: () =>
                json({ organisationUnitGroups: [] }),
            'GET organisationUnitGroupSets/set1abcdefg?fields=code': () =>
                json({ code: 'OWN' }),
            'POST organisationUnitGroups': () =>
                json({ response: { uid: 'newGroup' } }, 201),
            'POST organisationUnitGroupSets/set1abcdefg/organisationUnitGroups/newGroup':
                () => json({}, 200),
        })

        const created = await createCatchAllGroup(fetcher, set)
        expect(created.id).toBe('newGroup')

        const createCall = calls.find(
            (c) => c.path === 'organisationUnitGroups' && c.method === 'POST'
        )
        // M1: rw------ (owner metadata read/write only), never rwrw---- --
        // that would grant every user metadata AND data write on a group
        // this app created.
        expect((createCall?.body as { sharing: unknown }).sharing).toEqual({
            public: 'rw------',
            users: {},
            userGroups: {},
        })
    })

    it('throws when the create request fails', async () => {
        const set = buildSet()
        const displayName = 'Other/unknown Ownership'
        const { fetcher } = scriptedFetcher({
            [`GET ${lookupPath(displayName)}`]: () =>
                json({ organisationUnitGroups: [] }),
            'GET organisationUnitGroupSets/set1abcdefg?fields=code': () =>
                json({}),
            'GET organisationUnitGroups/g1?fields=sharing': () =>
                json({ sharing }),
            'POST organisationUnitGroups': () => json({}, 500),
        })
        await expect(createCatchAllGroup(fetcher, set)).rejects.toThrow()
    })

    it('reuses an existing group with the same name instead of creating a duplicate', async () => {
        const set = buildSet()
        const displayName = 'Other/unknown Ownership'
        const { fetcher, calls } = scriptedFetcher({
            [`GET ${lookupPath(displayName)}`]: () =>
                json({
                    organisationUnitGroups: [{ id: 'existingGroup' }],
                }),
            'POST organisationUnitGroupSets/set1abcdefg/organisationUnitGroups/existingGroup':
                () => json({}, 200),
        })

        const created = await createCatchAllGroup(fetcher, set)

        expect(created).toEqual({ id: 'existingGroup', displayName })
        // Neither the code lookup, the sibling-sharing lookup, nor the
        // create POST happen -- only the lookup and the add.
        expect(calls.map((c) => `${c.method} ${c.path}`)).toEqual([
            `GET ${lookupPath(displayName)}`,
            'POST organisationUnitGroupSets/set1abcdefg/organisationUnitGroups/existingGroup',
        ])
    })

    it('is retry-safe: a failed add-to-set does not strand an orphan group behind a name that would 409 on retry', async () => {
        const set = buildSet()
        const displayName = 'Other/unknown Ownership'

        // First attempt: nothing exists yet, create succeeds, add fails.
        const first = scriptedFetcher({
            [`GET ${lookupPath(displayName)}`]: () =>
                json({ organisationUnitGroups: [] }),
            'GET organisationUnitGroupSets/set1abcdefg?fields=code': () =>
                json({}),
            'GET organisationUnitGroups/g1?fields=sharing': () =>
                json({ sharing }),
            'POST organisationUnitGroups': () =>
                json({ response: { uid: 'newGroup' } }, 201),
            'POST organisationUnitGroupSets/set1abcdefg/organisationUnitGroups/newGroup':
                () => json({ message: 'Forbidden' }, 403),
        })
        await expect(createCatchAllGroup(first.fetcher, set)).rejects.toThrow(
            /newGroup/
        )

        // Retry: the group the first attempt created is now found by name,
        // so this attempt must not call create again, and only repeats the
        // add (which now succeeds).
        const retry = scriptedFetcher({
            [`GET ${lookupPath(displayName)}`]: () =>
                json({ organisationUnitGroups: [{ id: 'newGroup' }] }),
            'POST organisationUnitGroupSets/set1abcdefg/organisationUnitGroups/newGroup':
                () => json({}, 200),
        })
        const created = await createCatchAllGroup(retry.fetcher, set)
        expect(created).toEqual({ id: 'newGroup', displayName })
        expect(
            retry.calls.some(
                (c) =>
                    c.method === 'POST' && c.path === 'organisationUnitGroups'
            )
        ).toBe(false)
    })
})

describe('setGroupSetProperties', () => {
    it('sends a JSON patch for the given properties', async () => {
        const { fetcher, calls } = scriptedFetcher({
            'PATCH organisationUnitGroupSets/set1abcdefg': () => json({}, 200),
        })
        await setGroupSetProperties(
            fetcher,
            { objectType: 'organisationUnit', id: 'set1abcdefg' },
            { compulsory: true, dataDimension: false }
        )
        expect(calls).toEqual([
            {
                path: 'organisationUnitGroupSets/set1abcdefg',
                method: 'PATCH',
                contentType: 'application/json-patch+json',
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
            { objectType: 'organisationUnit', id: 'set1abcdefg' },
            {}
        )
        expect(fetcher).not.toHaveBeenCalled()
    })

    it('throws when the patch fails', async () => {
        const fetcher = async () => json({}, 500)
        await expect(
            setGroupSetProperties(
                fetcher,
                { objectType: 'organisationUnit', id: 'set1abcdefg' },
                { compulsory: true }
            )
        ).rejects.toThrow()
    })
})
