// Do the legacy eventchart/eventreport bridge rows add up to
// eventvisualization's, on this version? usageSqlView.ts reads only the
// eventvisualization bridges on the strength of that claim, which had been
// measured on 2.43.1 alone. A missing table is reported as "absent", not as
// zero.
//
//   node scripts/probe/bridge-rows.js <baseUrl>

const [, , baseUrl] = process.argv
if (!baseUrl) {
    console.error('usage: node scripts/probe/bridge-rows.js <baseUrl>')
    process.exit(1)
}
const USER = process.env.GSI_PROBE_USERNAME || 'local_admin'
const PASS = process.env.GSI_PROBE_PASSWORD || 'district'
const auth = `Basic ${Buffer.from(`${USER}:${PASS}`).toString('base64')}`
const api = (path, init = {}) =>
    fetch(`${baseUrl}/api/${path}`, {
        ...init,
        headers: { Authorization: auth, ...(init.headers || {}) },
    })

const TABLES = [
    'eventchart_orgunitgroupsetdimensions',
    'eventreport_orgunitgroupsetdimensions',
    'eventvisualization_orgunitgroupsetdimensions',
    'eventchart_categoryoptiongroupsetdimensions',
    'eventreport_categoryoptiongroupsetdimensions',
    'eventvisualization_categoryoptiongroupsetdimensions',
]

async function countRows(table) {
    const create = await api('sqlViews', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            name: `GSI probe ${table}`,
            code: `GSI_PROBE_${table.toUpperCase().slice(0, 40)}`,
            type: 'QUERY',
            cacheStrategy: 'NO_CACHE',
            sqlQuery: `select count(*) as n from ${table}`,
        }),
    })
    if (!create.ok) {
        return `create failed: HTTP ${create.status}`
    }
    const { response } = await create.json()
    const id = response.uid
    try {
        const read = await api(`sqlViews/${id}/data.json`)
        if (!read.ok) {
            return `absent (HTTP ${read.status})`
        }
        const body = await read.json()
        return Number(body.listGrid.rows[0][0])
    } finally {
        await api(`sqlViews/${id}`, { method: 'DELETE' })
    }
}

async function main() {
    const info = await (await api('system/info')).json()
    console.log(`DHIS2 ${info.version} at ${baseUrl}`)
    const counts = {}
    for (const table of TABLES) {
        counts[table] = await countRows(table)
        console.log(`${table.padEnd(55)} ${counts[table]}`)
    }
    for (const kind of ['orgunitgroupset', 'categoryoptiongroupset']) {
        const ec = counts[`eventchart_${kind}dimensions`]
        const er = counts[`eventreport_${kind}dimensions`]
        const ev = counts[`eventvisualization_${kind}dimensions`]
        const sum =
            typeof ec === 'number' && typeof er === 'number' ? ec + er : 'n/a'
        console.log(
            `${kind}: eventchart + eventreport = ${sum}, eventvisualization = ${ev}, ${sum === ev ? 'ADD UP' : 'DIFFER'}`
        )
    }
}

main().catch((e) => {
    console.error(e)
    process.exit(1)
})
