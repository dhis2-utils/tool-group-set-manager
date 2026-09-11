import {
    readDetails,
    readSummaries,
    resolveChecks,
    startRun,
} from './integrity'

const jsonResponse = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), { status })

// Fixtures copied verbatim from the findings note's table (finding 1).
const CHECK_2_43 = [
    {
        name: 'org_units_not_in_compulsory_group_sets',
        code: 'OUNICGS',
        displayName: 'Organisation units not in compulsory group sets',
        issuesIdType: 'organisationUnits',
        isSlow: false,
    },
    {
        name: 'organisation_units_violating_exclusive_group_sets',
        code: 'OUVEGS',
        displayName: 'Organisation units violating exclusive group sets',
        issuesIdType: 'organisationUnits',
        isSlow: false,
    },
    {
        name: 'data_elements_violating_exclusive_group_sets',
        code: 'DEVEGS',
        displayName: 'Data elements violating exclusive group sets',
        issuesIdType: 'dataElements',
        isSlow: false,
    },
    {
        name: 'indicators_violating_exclusive_group_sets',
        code: 'IVEGS',
        displayName: 'Indicators violating exclusive group sets',
        issuesIdType: 'indicators',
        isSlow: false,
    },
    {
        name: 'category_options_excess_groupset_membership',
        code: 'COEGM',
        displayName: 'Category options excess groupset membership',
        issuesIdType: 'categories',
        isSlow: false,
    },
    {
        name: 'category_option_group_sets_incomplete',
        code: 'COGSI',
        displayName: 'Category option group sets incomplete',
        issuesIdType: 'categoryOptionGroupSets',
        isSlow: false,
    },
]

const CHECK_2_40 = [
    {
        name: 'orgunits_compulsory_group_count',
        code: 'OCGC',
        displayName: 'Organisation units compulsory group count',
        issuesIdType: 'organisationUnits',
        isSlow: false,
    },
    {
        name: 'orgunit_group_sets_excess_groups',
        code: 'OGSEG',
        displayName: 'Org unit group sets excess groups',
        issuesIdType: 'organisationUnits',
        isSlow: false,
    },
    {
        name: 'data_elements_violating_exclusive_group_sets',
        code: 'DEVEGS',
        displayName: 'Data elements violating exclusive group sets',
        issuesIdType: 'data_elements_aggregate',
        isSlow: false,
    },
    {
        name: 'indicators_violating_exclusive_group_sets',
        code: 'IVEGS',
        displayName: 'Indicators violating exclusive group sets',
        issuesIdType: 'indicators',
        isSlow: false,
    },
    {
        name: 'category_options_excess_groupset_membership',
        code: 'COEGM',
        displayName: 'Category options excess groupset membership',
        issuesIdType: 'categories',
        isSlow: false,
    },
    {
        name: 'category_option_group_sets_incomplete',
        code: 'COGSI',
        displayName: 'Category option group sets incomplete',
        issuesIdType: 'categoryOptionGroupSets',
        isSlow: false,
    },
]

// The decoy from finding 1: on 2.40, code OUVEGS belongs to a different,
// slow, programmatic check -- not the fast SQL check that code names on 2.43.
const OUVEGS_DECOY_2_40 = {
    name: 'org_units_violating_exclusive_group_sets',
    code: 'OUVEGS',
    displayName: 'Org units violating exclusive group sets (slow)',
    issuesIdType: 'organisationUnits',
    isSlow: true,
}

describe('resolveChecks', () => {
    it('requests the exact fields and paging=false, nothing else', async () => {
        let capturedPath = ''
        const fetcher = async (path: string) => {
            capturedPath = path
            return jsonResponse(CHECK_2_43)
        }
        await resolveChecks(fetcher)
        expect(capturedPath).toBe(
            'dataIntegrity?fields=name,code,displayName,isSlow&paging=false'
        )
    })

    it('resolves all six logical checks to their 2.43 names', async () => {
        const fetcher = async () => jsonResponse(CHECK_2_43)
        const resolved = await resolveChecks(fetcher)
        expect(resolved.map((r) => r.logical)).toEqual([
            'orgUnitsMissingCompulsory',
            'orgUnitsConflicting',
            'dataElementsConflicting',
            'indicatorsConflicting',
            'categoryOptionsConflicting',
            'categoryOptionGroupSetsIncomplete',
        ])
        expect(resolved.map((r) => r.name)).toEqual([
            'org_units_not_in_compulsory_group_sets',
            'organisation_units_violating_exclusive_group_sets',
            'data_elements_violating_exclusive_group_sets',
            'indicators_violating_exclusive_group_sets',
            'category_options_excess_groupset_membership',
            'category_option_group_sets_incomplete',
        ])
    })

    it('resolves the two org unit checks to their 2.40 names while the other four keep shared names', async () => {
        const fetcher = async () => jsonResponse(CHECK_2_40)
        const resolved = await resolveChecks(fetcher)
        const byLogical = new Map(resolved.map((r) => [r.logical, r]))
        expect(byLogical.get('orgUnitsMissingCompulsory')?.name).toBe(
            'orgunits_compulsory_group_count'
        )
        expect(byLogical.get('orgUnitsConflicting')?.name).toBe(
            'orgunit_group_sets_excess_groups'
        )
        expect(byLogical.get('dataElementsConflicting')?.name).toBe(
            'data_elements_violating_exclusive_group_sets'
        )
        expect(byLogical.get('indicatorsConflicting')?.name).toBe(
            'indicators_violating_exclusive_group_sets'
        )
        expect(byLogical.get('categoryOptionsConflicting')?.name).toBe(
            'category_options_excess_groupset_membership'
        )
        expect(byLogical.get('categoryOptionGroupSetsIncomplete')?.name).toBe(
            'category_option_group_sets_incomplete'
        )
    })

    it('returns only the checks present, in LogicalCheck order, with no throw', async () => {
        const partial = [CHECK_2_43[2], CHECK_2_43[0]]
        const fetcher = async () => jsonResponse(partial)
        const resolved = await resolveChecks(fetcher)
        expect(resolved.map((r) => r.logical)).toEqual([
            'orgUnitsMissingCompulsory',
            'dataElementsConflicting',
        ])
    })

    it('resolves orgUnitsConflicting to the fast SQL check, not the decoy sharing its code (finding 1)', async () => {
        const fetcher = async () =>
            jsonResponse([...CHECK_2_40, OUVEGS_DECOY_2_40])
        const resolved = await resolveChecks(fetcher)
        const conflicting = resolved.find(
            (r) => r.logical === 'orgUnitsConflicting'
        )
        expect(conflicting?.name).toBe('orgunit_group_sets_excess_groups')
        expect(conflicting?.name).not.toBe(
            'org_units_violating_exclusive_group_sets'
        )
    })

    it('derives objectType from the logical check, and null for the check that concerns no object type', async () => {
        const fetcher = async () => jsonResponse(CHECK_2_43)
        const resolved = await resolveChecks(fetcher)
        const byLogical = new Map(resolved.map((r) => [r.logical, r]))
        expect(byLogical.get('orgUnitsMissingCompulsory')?.objectType).toBe(
            'organisationUnit'
        )
        expect(byLogical.get('orgUnitsConflicting')?.objectType).toBe(
            'organisationUnit'
        )
        expect(byLogical.get('dataElementsConflicting')?.objectType).toBe(
            'dataElement'
        )
        expect(byLogical.get('indicatorsConflicting')?.objectType).toBe(
            'indicator'
        )
        expect(byLogical.get('categoryOptionsConflicting')?.objectType).toBe(
            'categoryOption'
        )
        expect(
            byLogical.get('categoryOptionGroupSetsIncomplete')?.objectType
        ).toBe(null)
    })
})

describe('readSummaries', () => {
    it('requests timeout=0 and nothing else', async () => {
        let capturedPath = ''
        const fetcher = async (path: string) => {
            capturedPath = path
            return jsonResponse({})
        }
        await readSummaries(fetcher, ['a', 'b'])
        expect(capturedPath).toBe('dataIntegrity/summary?checks=a,b&timeout=0')
    })

    it('returns one entry per requested name with count 0 and finishedTime null on an empty body', async () => {
        const fetcher = async () => jsonResponse({})
        const summaries = await readSummaries(fetcher, ['a', 'b'])
        expect(summaries).toEqual([
            { name: 'a', count: 0, finishedTime: null },
            { name: 'b', count: 0, finishedTime: null },
        ])
    })

    it('returns the server counts and finishedTime when present', async () => {
        const fetcher = async () =>
            jsonResponse({
                a: { count: 272, finishedTime: '2026-09-11T10:00:00.000' },
            })
        const summaries = await readSummaries(fetcher, ['a', 'b'])
        expect(summaries).toEqual([
            { name: 'a', count: 272, finishedTime: '2026-09-11T10:00:00.000' },
            { name: 'b', count: 0, finishedTime: null },
        ])
    })
})

describe('readDetails', () => {
    it('reads refs into detail, joined with a space (2.43)', async () => {
        const fetcher = async () =>
            jsonResponse({
                orgUnitsConflicting: {
                    issues: [
                        {
                            id: 'roQ2l7TX0eZ',
                            name: 'SLRCS (Bo) Clinic',
                            refs: [
                                'ougs_name: Facility Ownership; ougs_id: Bpx0589u8y0; groups: [oug_uid: oRVt7g429ZO; oug_name: Public facilities, oug_uid: PVLOW4bCshG; oug_name: NGO]',
                            ],
                        },
                    ],
                },
            })
        const issues = await readDetails(fetcher, 'orgUnitsConflicting')
        expect(issues).toEqual([
            {
                id: 'roQ2l7TX0eZ',
                displayName: 'SLRCS (Bo) Clinic',
                detail: 'ougs_name: Facility Ownership; ougs_id: Bpx0589u8y0; groups: [oug_uid: oRVt7g429ZO; oug_name: Public facilities, oug_uid: PVLOW4bCshG; oug_name: NGO]',
            },
        ])
    })

    it('reads comment into detail (2.40)', async () => {
        const fetcher = async () =>
            jsonResponse({
                orgUnitsConflicting: {
                    issues: [
                        {
                            id: 'sK498nBOLfQ',
                            name: 'Elshadai MCHP',
                            comment:
                                'Facility Ownership :(Public facilities; Private Clinic)',
                        },
                    ],
                },
            })
        const issues = await readDetails(fetcher, 'orgUnitsConflicting')
        expect(issues).toEqual([
            {
                id: 'sK498nBOLfQ',
                displayName: 'Elshadai MCHP',
                detail: 'Facility Ownership :(Public facilities; Private Clinic)',
            },
        ])
    })

    it('yields detail: null for an issue with neither field', async () => {
        const fetcher = async () =>
            jsonResponse({
                orgUnitsMissingCompulsory: {
                    issues: [{ id: 'Rp268JB6Ne4', name: 'Adonkia CHP' }],
                },
            })
        const issues = await readDetails(fetcher, 'orgUnitsMissingCompulsory')
        expect(issues).toEqual([
            { id: 'Rp268JB6Ne4', displayName: 'Adonkia CHP', detail: null },
        ])
    })
})

describe('startRun', () => {
    it('POSTs to dataIntegrity/summary with the checks in the query string and resolves without reading the job id', async () => {
        let capturedPath = ''
        let capturedInit: RequestInit | undefined
        const fetcher = async (path: string, init?: RequestInit) => {
            capturedPath = path
            capturedInit = init
            return jsonResponse({ response: { id: 'someJobId' } })
        }
        await expect(
            startRun(fetcher, ['a', 'b'], 'summary')
        ).resolves.toBeUndefined()
        expect(capturedPath).toBe('dataIntegrity/summary?checks=a,b')
        expect(capturedInit?.method).toBe('POST')
    })

    it('POSTs to dataIntegrity/details with the checks in the query string', async () => {
        let capturedPath = ''
        const fetcher = async (path: string) => {
            capturedPath = path
            return jsonResponse({ response: { id: 'someJobId' } })
        }
        await startRun(fetcher, ['a'], 'details')
        expect(capturedPath).toBe('dataIntegrity/details?checks=a')
    })
})
