// Measures spec 2026-09-16 section 5.4: what re-reading a plan's groups
// costs, which is what the bulk fix's pre-write freshness check will pay on
// every Apply. Kept in the repository so a future run is a re-run.
//
// Usage: node scripts/perf/reread-cost.js <groupSetId>
// Overridable: GSI_PERF_BASE_URL, GSI_PERF_USERNAME, GSI_PERF_PASSWORD
'use strict'

const BASE_URL =
    process.env.GSI_PERF_BASE_URL || 'http://dhis2-agent-gsi-emis:8080'
const AUTH =
    'Basic ' +
    Buffer.from(
        `${process.env.GSI_PERF_USERNAME || 'local_admin'}:${
            process.env.GSI_PERF_PASSWORD || 'district'
        }`
    ).toString('base64')

async function api(path) {
    const r = await fetch(`${BASE_URL}/api/${path}`, {
        headers: { Authorization: AUTH },
        cache: 'no-store',
    })
    if (!r.ok) {
        throw new Error(`HTTP ${r.status} on ${path}`)
    }
    return r.json()
}

async function main() {
    const setId = process.argv[2]
    if (!setId) {
        throw new Error('usage: node scripts/perf/reread-cost.js <groupSetId>')
    }
    const set = await api(
        `organisationUnitGroupSets/${setId}?fields=name,organisationUnitGroups%5Bid,name%5D`
    )
    const groups = set.organisationUnitGroups

    // Worst case: every group in the set, which is what "move to catch-all"
    // over an unfiltered population produces. Read them sequentially, the
    // way the app will.
    const started = Date.now()
    let totalIds = 0
    for (const g of groups) {
        const body = await api(
            `organisationUnitGroups/${g.id}/organisationUnits?fields=id&paging=false`
        )
        totalIds += body.organisationUnits.length
    }
    const seconds = (Date.now() - started) / 1000

    console.log(
        JSON.stringify(
            {
                set: set.name,
                groups: groups.length,
                totalIds,
                seconds,
                secondsPerGroup: seconds / groups.length,
            },
            null,
            2
        )
    )
}

main().catch((e) => {
    console.error('FAILED:', e.message)
    process.exit(1)
})
