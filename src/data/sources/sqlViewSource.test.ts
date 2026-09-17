import { createSqlViewSource, SQL_VIEW_DEFINITIONS } from './sqlViewSource'

const csvResponse = (text: string) => new Response(text, { status: 200 })

describe('sqlViewSource', () => {
    const views = {
        orgUnits: 'V1',
        orgUnitNames: 'V2',
        orgUnitMemberships: 'V3',
    }

    it('loads org units from the hierarchy view', async () => {
        const calls: string[] = []
        const fetcher = async (path: string) => {
            calls.push(path)
            return csvResponse('uid,level,parent\nr,1,\na,2,r\n')
        }
        const payload = await createSqlViewSource(fetcher, views).loadObjects(
            'organisationUnit',
            () => undefined
        )
        expect(calls[0]).toBe('sqlViews/V1/data.csv?paging=false')
        expect(payload.ids).toEqual(['r', 'a'])
        expect(Array.from(payload.level ?? [])).toEqual([1, 2])
        expect(payload.parentIds).toEqual([null, 'r'])
    })

    // Plan 7 Task 1: `cacheStrategy` on the definitions only fixes views
    // this version creates. An installation whose views were created by an
    // earlier build still advertises `Cache-Control: max-age=1209600,
    // public`, and an administrator can re-edit a view at any time -- so
    // the app must not depend on a server object it does not re-check to
    // get its own writes back. `no-store` makes the read bypass the
    // browser HTTP cache regardless of what the view says.
    it('reads view data with the browser HTTP cache bypassed', async () => {
        const inits: (RequestInit | undefined)[] = []
        const fetcher = async (_path: string, init?: RequestInit) => {
            inits.push(init)
            return csvResponse('uid,level,parent\nr,1,\n')
        }
        await createSqlViewSource(fetcher, views).loadObjects(
            'organisationUnit',
            () => undefined
        )
        expect(inits[0]?.cache).toBe('no-store')
    })

    // Level 0 is impossible in DHIS2 (the root sits at level 1), so a
    // malformed level column (blank, non-numeric, or anything Number()
    // cannot parse) must never silently coerce to 0 -- Uint8Array.from
    // does exactly that (Number('') is 0, Number('x') is NaN, and NaN
    // truncates to 0 in a typed array) and 0 would then read as a real,
    // if wrong, hierarchy level rather than as the parse failure it is.
    // Minor 4 (fix round 1): the row named in the message must match the
    // CSV line a spreadsheet or the view's own export would call it --
    // line 1 is the header, so the first data row ("r,1,") is line 2 and
    // the malformed one ("a,bad,r") is line 3.
    it('throws naming the row when a level column cannot be parsed', async () => {
        const fetcher = async () =>
            csvResponse('uid,level,parent\nr,1,\na,bad,r\n')
        await expect(
            createSqlViewSource(fetcher, views).loadObjects(
                'organisationUnit',
                () => undefined
            )
        ).rejects.toThrow(/row 3/)
    })

    // Minor 4 (fix round 1): a body ending in a blank line (a trailing
    // newline after the last real row) used to parse to a phantom row of
    // one empty field, which the level parser then hard-failed on -- worse
    // than the old silent-0 behaviour, which at least tolerated it.
    it('tolerates a trailing blank line rather than treating it as a malformed row', async () => {
        const fetcher = async () =>
            csvResponse('uid,level,parent\nr,1,\na,2,r\n\n')
        const payload = await createSqlViewSource(fetcher, views).loadObjects(
            'organisationUnit',
            () => undefined
        )
        expect(payload.ids).toEqual(['r', 'a'])
        expect(Array.from(payload.level ?? [])).toEqual([1, 2])
    })

    it('loads memberships from the membership view and keeps only requested groups', async () => {
        const fetcher = async () =>
            csvResponse('groupid,ouid\ng1,a\ng1,b\ng9,a\n')
        const payload = await createSqlViewSource(
            fetcher,
            views
        ).loadMemberships('organisationUnit', ['g1', 'g2'], () => undefined)
        expect(payload.groups).toEqual([
            { groupId: 'g1', memberIds: ['a', 'b'] },
            { groupId: 'g2', memberIds: [] },
        ])
    })

    it('reads names from the names view when it is present', async () => {
        const calls: string[] = []
        const fetcher = async (path: string) => {
            calls.push(path)
            return csvResponse('uid,name\na,Alpha\n')
        }
        const names = await createSqlViewSource(fetcher, views).loadNames(
            'organisationUnit'
        )
        expect(calls[0]).toBe('sqlViews/V2/data.csv?paging=false')
        expect(names).toEqual([{ id: 'a', displayName: 'Alpha' }])
    })

    // Spec 8a: removing GSI_ORGUNIT_NAMES is the remedy for an instance
    // whose organisation unit names are translated, because the metadata
    // API resolves `displayName` against the user's locale and a SQL view
    // cannot. It must cost names only -- the hierarchy and membership
    // reads are the expensive ones and carry nothing to translate.
    it('takes names from the metadata API when the names view is absent, keeping the other two views', async () => {
        const calls: string[] = []
        const fetcher = async (path: string) => {
            calls.push(path)
            if (path.startsWith('organisationUnits')) {
                return new Response(
                    JSON.stringify({
                        organisationUnits: [{ id: 'a', displayName: 'Alpha' }],
                    }),
                    { status: 200 }
                )
            }
            return csvResponse('groupid,ouid\ng1,a\n')
        }
        const source = createSqlViewSource(fetcher, {
            ...views,
            orgUnitNames: null,
        })
        expect(source.kind).toBe('sqlView')
        expect(source.nameSource).toBe('metadata')

        const names = await source.loadNames('organisationUnit')
        expect(names).toEqual([{ id: 'a', displayName: 'Alpha' }])
        expect(calls.every((c) => !c.startsWith('sqlViews/'))).toBe(true)

        await source.loadMemberships(
            'organisationUnit',
            ['g1'],
            () => undefined
        )
        expect(calls[calls.length - 1]).toBe(
            'sqlViews/V3/data.csv?paging=false'
        )
    })

    it('falls back to the metadata source for other object types', async () => {
        const calls: string[] = []
        const fetcher = async (path: string) => {
            calls.push(path)
            return new Response(
                JSON.stringify({ indicators: [{ id: 'i', displayName: 'I' }] }),
                { status: 200 }
            )
        }
        const payload = await createSqlViewSource(fetcher, views).loadObjects(
            'indicator',
            () => undefined
        )
        expect(calls[0]).toContain('indicators?fields=')
        expect(payload.ids).toEqual(['i'])
    })
})

describe('SQL_VIEW_DEFINITIONS', () => {
    it('pins every definition to NO_CACHE', () => {
        // Plan 7 Task 1: without this the server applies
        // RESPECT_SYSTEM_SETTING, which defers to `keyCacheStrategy` --
        // CACHE_TWO_WEEKS on a stock instance. The browser then answers
        // every post-write membership read from its own HTTP cache for a
        // fortnight, so a user's own fix vanishes on the next load and
        // History offers a Revert that reports "nothing to revert". See
        // docs/superpowers/notes/2026-09-plan7-e2e-write-flows.md.
        expect(SQL_VIEW_DEFINITIONS.map((d) => d.cacheStrategy)).toEqual([
            'NO_CACHE',
            'NO_CACHE',
            'NO_CACHE',
        ])
    })

    it('pins every definition to a plain view', () => {
        // The app declines to read a MATERIALIZED_VIEW (see selectSource), so
        // the creation code a later plan writes must not inherit whatever
        // type the server would default to.
        expect(SQL_VIEW_DEFINITIONS.map((d) => d.type)).toEqual([
            'VIEW',
            'VIEW',
            'VIEW',
        ])
    })
})
