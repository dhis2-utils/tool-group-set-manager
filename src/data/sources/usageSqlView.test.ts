import {
    parseUsageListGrid,
    USAGE_SQL_CANDIDATES,
    usageApplies,
    usageByGroupSet,
    UsageListGrid,
} from './usageSqlView'

const grid = (rows: unknown[][]): UsageListGrid => ({
    listGrid: {
        headers: [
            { name: 'groupset_uid' },
            { name: 'groupset_type' },
            { name: 'favourite_type' },
            { name: 'favourites' },
            { name: 'views_12m' },
        ],
        rows,
    },
})

describe('parseUsageListGrid', () => {
    it('reads columns by header name, not by position', () => {
        const reordered: UsageListGrid = {
            listGrid: {
                headers: [
                    { name: 'views_12m' },
                    { name: 'favourites' },
                    { name: 'favourite_type' },
                    { name: 'groupset_type' },
                    { name: 'groupset_uid' },
                ],
                rows: [[7, 3, 'map', 'orgUnitGroupSet', 'abc']],
            },
        }
        expect(parseUsageListGrid(reordered)).toEqual([
            {
                groupSetId: 'abc',
                groupSetType: 'orgUnitGroupSet',
                favouriteType: 'map',
                favourites: 3,
                views12m: 7,
            },
        ])
    })

    it('parses counts that arrive as strings', () => {
        // The listGrid types every column java.lang.String on 2.43.
        expect(
            parseUsageListGrid(
                grid([['abc', 'orgUnitGroupSet', 'visualization', '37', '89']])
            )[0]
        ).toMatchObject({ favourites: 37, views12m: 89 })
    })

    it('returns an empty array for a view with no rows', () => {
        expect(parseUsageListGrid(grid([]))).toEqual([])
    })

    it('rejects a result missing a column this app needs', () => {
        const missing: UsageListGrid = {
            listGrid: {
                headers: [{ name: 'groupset_uid' }, { name: 'groupset_type' }],
                rows: [['abc', 1]],
            },
        }
        expect(() => parseUsageListGrid(missing)).toThrow(/favourite_type/)
    })

    it('rejects an unrecognised favourite type rather than dropping the row', () => {
        expect(() =>
            parseUsageListGrid(
                grid([['abc', 'orgUnitGroupSet', 'dashboard', '1', '0']])
            )
        ).toThrow(/dashboard/)
    })

    it('rejects an unrecognised group set type', () => {
        expect(() =>
            parseUsageListGrid(
                grid([['abc', 'indicatorGroupSet', 'visualization', '1', '0']])
            )
        ).toThrow(/indicatorGroupSet/)
    })
})

describe('usageByGroupSet', () => {
    const rows = parseUsageListGrid(
        grid([
            ['a', 'orgUnitGroupSet', 'visualization', '37', '89'],
            ['a', 'orgUnitGroupSet', 'map', '1', '0'],
            ['a', 'orgUnitGroupSet', 'eventVisualization', '4', '11'],
            ['b', 'dataElementGroupSet', 'visualization', '8', '0'],
        ])
    )

    it('sums favourites and views across favourite types', () => {
        const byId = usageByGroupSet(rows)
        expect(byId.get('a')).toMatchObject({ favourites: 42, views12m: 100 })
        expect(byId.get('b')).toMatchObject({ favourites: 8, views12m: 0 })
    })

    it('orders the breakdown by favourites, largest first', () => {
        expect(usageByGroupSet(rows).get('a')?.byFavouriteType).toEqual([
            { favouriteType: 'visualization', favourites: 37 },
            { favouriteType: 'eventVisualization', favourites: 4 },
            { favouriteType: 'map', favourites: 1 },
        ])
    })

    it('has no entry for a group set no favourite references', () => {
        expect(usageByGroupSet(rows).has('c')).toBe(false)
    })
})

describe('usageApplies', () => {
    it('is false for indicators, which are not an analytics dimension', () => {
        expect(usageApplies('indicator')).toBe(false)
    })

    it('is true for the three types the view covers', () => {
        expect(usageApplies('organisationUnit')).toBe(true)
        expect(usageApplies('dataElement')).toBe(true)
        expect(usageApplies('categoryOption')).toBe(true)
    })

    it.each([
        ['organisationUnit', true],
        ['dataElement', true],
        ['categoryOption', true],
        ['indicator', false],
    ] as const)('%s -> %s', (objectType, expected) => {
        expect(usageApplies(objectType)).toBe(expected)
    })
})

describe('USAGE_SQL_CANDIDATES', () => {
    it('has at least one candidate and every body is a bare select', () => {
        expect(USAGE_SQL_CANDIDATES.length).toBeGreaterThan(0)
        USAGE_SQL_CANDIDATES.forEach((c) => {
            // DHIS2 refuses a SQL view body containing a statement
            // separator; a trailing semicolon from a copy-paste out of psql
            // is the easy way to ship one by accident.
            expect(c.sqlQuery).not.toContain(';')
            expect(c.sqlQuery.trim().toLowerCase().startsWith('with')).toBe(
                true
            )
        })
    })

    it('gives every candidate a distinct variant name', () => {
        const names = USAGE_SQL_CANDIDATES.map((c) => c.variant)
        expect(new Set(names).size).toBe(names.length)
    })
})
