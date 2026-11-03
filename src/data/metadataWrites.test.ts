import {
    createCatchAllGroup,
    generateCatchAllNames,
    NAME_OWNED_BY_ANOTHER_SET,
    setGroupSetProperties,
} from './metadataWrites'
import type { GroupSetMeta } from '@/engine/types'

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
    )}&fields=id,groupSets%5Bid%5D&paging=false`

/**
 * A fetcher stub keyed by exact "METHOD path", per ruling P2-R15: every
 * request `createCatchAllGroup`/`setGroupSetProperties` issues must be
 * pinned to its literal path and method, not merely matched by prefix or
 * substring -- a prefix match is exactly what let both live-server
 * Criticals (C1, C2) slip past this file's tests last round.
 */
function scriptedFetcher(script: Record<string, () => Response>) {
    const calls: Call[] = []
    const fetcher = (path: string, init?: RequestInit) => {
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
            return Promise.reject(new Error(`Unhandled request: ${key}`))
        }
        return Promise.resolve(handler())
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

    // The 38 was only ever "50 - 11 (a standard DHIS2 uid) - 1 (the
    // space)" written out as a literal. An id longer than the standard 11
    // characters (not something DHIS2 itself generates, but the shape of
    // an id is never actually validated here) makes a hardcoded 38 produce
    // a shortName over the server's 50-character limit; deriving it from
    // MAX_SHORT_NAME_LENGTH minus the real id length keeps it exactly 50
    // regardless.
    it('derives the truncation point from the id length rather than a hardcoded 38, for an id longer than 11 characters', async () => {
        const set = buildSet({
            id: 'aLongerThanUsualId123',
            displayName:
                'A very long group set name that will not fit into fifty characters at all',
        })
        const displayName = `Other/unknown ${set.displayName}`
        const expectedShortName = `${displayName.slice(0, 50 - set.id.length - 1)} ${set.id}`
        expect(expectedShortName).toHaveLength(50)

        const { fetcher, calls } = scriptedFetcher({
            [`GET ${lookupPath(displayName)}`]: () =>
                json({ organisationUnitGroups: [] }),
            [`GET organisationUnitGroupSets/${set.id}?fields=code`]: () =>
                json({}),
            'GET organisationUnitGroups/g1?fields=sharing': () =>
                json({ sharing }),
            'POST organisationUnitGroups': () =>
                json({ response: { uid: 'newGroup' } }, 201),
            [`POST organisationUnitGroupSets/${set.id}/organisationUnitGroups/newGroup`]:
                () => json({}, 200),
        })

        await createCatchAllGroup(fetcher, set)

        const createCall = calls.find(
            (c) => c.path === 'organisationUnitGroups' && c.method === 'POST'
        )
        const body = createCall?.body as { shortName: string }
        expect(body.shortName).toBe(expectedShortName)
        expect(body.shortName.length).toBeLessThanOrEqual(50)
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
        expect(
            (createCall?.body as { sharing: unknown } | undefined)?.sharing
        ).toEqual({
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

    // Spec 5.2 (Plan 7 Task 7): the user may name the catch-all group.
    it('uses caller-supplied names when given them', async () => {
        const set = buildSet()
        const { fetcher, calls } = scriptedFetcher({
            [`GET ${lookupPath('Unclassified facilities')}`]: () =>
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

        const created = await createCatchAllGroup(fetcher, set, {
            displayName: 'Unclassified facilities',
            shortName: 'Unclassified',
        })

        expect(created).toEqual({
            id: 'newGroup',
            displayName: 'Unclassified facilities',
        })
        expect(
            calls.find(
                (c) =>
                    c.method === 'POST' && c.path === 'organisationUnitGroups'
            )?.body
        ).toMatchObject({
            name: 'Unclassified facilities',
            shortName: 'Unclassified',
        })
    })

    // The hazard editing the name creates, which did not exist while the
    // name was generated: the lookup is global, so a name another set's
    // group already holds would otherwise be silently pulled into this set
    // -- one group shared between two sets, which spec 5.2 forbids.
    it('refuses a name owned by a group in a different set', async () => {
        const set = buildSet()
        const { fetcher, calls } = scriptedFetcher({
            [`GET ${lookupPath('Other')}`]: () =>
                json({
                    organisationUnitGroups: [
                        { id: 'g9', groupSets: [{ id: 'someOtherSet' }] },
                    ],
                }),
        })

        await expect(
            createCatchAllGroup(fetcher, set, {
                displayName: 'Other',
                shortName: 'Other',
            })
        ).rejects.toThrow(NAME_OWNED_BY_ANOTHER_SET)
        // Refused before anything is written -- the lookup is the only call.
        expect(calls.map((c) => c.method)).toEqual(['GET'])
    })

    it('refuses a name owned by a group in this set AND another', async () => {
        const set = buildSet()
        const { fetcher } = scriptedFetcher({
            [`GET ${lookupPath('Other')}`]: () =>
                json({
                    organisationUnitGroups: [
                        {
                            id: 'g9',
                            groupSets: [
                                { id: 'set1abcdefg' },
                                { id: 'someOtherSet' },
                            ],
                        },
                    ],
                }),
        })

        await expect(
            createCatchAllGroup(fetcher, set, {
                displayName: 'Other',
                shortName: 'Other',
            })
        ).rejects.toThrow(NAME_OWNED_BY_ANOTHER_SET)
    })

    it('reuses a same-named group that already belongs to this set', async () => {
        const set = buildSet()
        const displayName = 'Other/unknown Ownership'
        const { fetcher } = scriptedFetcher({
            [`GET ${lookupPath(displayName)}`]: () =>
                json({
                    organisationUnitGroups: [
                        { id: 'g9', groupSets: [{ id: 'set1abcdefg' }] },
                    ],
                }),
            'POST organisationUnitGroupSets/set1abcdefg/organisationUnitGroups/g9':
                () => json({}, 200),
        })

        await expect(createCatchAllGroup(fetcher, set)).resolves.toMatchObject({
            id: 'g9',
        })
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
        await expect(
            createCatchAllGroup(first.fetcher, set)
        ).rejects.toMatchObject({ step: 'addToSet', status: 403 })

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

describe('generateCatchAllNames', () => {
    it('produces the name the dialog prefills', () => {
        expect(generateCatchAllNames(buildSet())).toEqual({
            displayName: 'Other/unknown Ownership',
            shortName: 'Other/unknown Ownership',
        })
    })

    // The tail is reserved for the set id rather than plainly truncated:
    // DHIS2 enforces shortName uniqueness, so two sets agreeing in their
    // first ~40 characters would otherwise collide.
    it('reserves the tail for the set id when the name is too long', () => {
        const long = buildSet({
            displayName: 'x'.repeat(60),
            id: 'abcdefghijk',
        })
        const { shortName } = generateCatchAllNames(long)
        expect(shortName).toHaveLength(50)
        expect(shortName.endsWith(' abcdefghijk')).toBe(true)
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
        const fetcher = () => Promise.resolve(json({}, 500))
        await expect(
            setGroupSetProperties(
                fetcher,
                { objectType: 'organisationUnit', id: 'set1abcdefg' },
                { compulsory: true }
            )
        ).rejects.toThrow()
    })
})
