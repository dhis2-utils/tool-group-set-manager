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

    // Level 0 is impossible in DHIS2 (the root sits at level 1), so a
    // malformed level column (blank, non-numeric, or anything Number()
    // cannot parse) must never silently coerce to 0 -- Uint8Array.from
    // does exactly that (Number('') is 0, Number('x') is NaN, and NaN
    // truncates to 0 in a typed array) and 0 would then read as a real,
    // if wrong, hierarchy level rather than as the parse failure it is.
    it('throws naming the row when a level column cannot be parsed', async () => {
        const fetcher = async () =>
            csvResponse('uid,level,parent\nr,1,\na,bad,r\n')
        await expect(
            createSqlViewSource(fetcher, views).loadObjects(
                'organisationUnit',
                () => undefined
            )
        ).rejects.toThrow(/row 2/)
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
