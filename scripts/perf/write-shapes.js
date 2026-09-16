// Write-shape measurement for spec 2026-09-15 section 6.2 (Plan 7 Task 2).
// Three shapes against one target group on the EMIS instance, each run from
// the same starting state, with server-side cost sampled throughout. Kept in
// the repository -- like scripts/perf/emis-run.js, and for the same reason --
// so a future run is a re-run, not a re-implementation.
//
// No browser: these are API calls, not UI, so this is plain Node with
// `fetch` rather than Playwright.
//
// Usage:
//   node scripts/perf/write-shapes.js <groupId> <shape> [batchSize]
//     shape: batched | import | import-async
//   node scripts/perf/write-shapes.js <groupId> capture  > members.json
//   node scripts/perf/write-shapes.js <groupId> restore  < members.json
//
// `capture` writes the group's current member list to stdout; `restore`
// puts it back. Every timed run must start from the same state, so the
// sequence for each measurement is capture once, then {restore, run} per
// shape. NOTE (and this is recorded in the write-up too): `restore` uses
// the metadata-import shape, which is itself one of the shapes under test.
// It is not a neutral restore. It is used anyway because it is the only one
// fast enough to run seven times, and because a restore's own cost is never
// part of a measured interval -- the timer starts after it.
//
// Overridable via environment variables, the same convention emis-run.js
// uses:
//   GSI_PERF_BASE_URL   target instance (default: agent-gsi-emis)
//   GSI_PERF_USERNAME   login (default: local_admin)
//   GSI_PERF_PASSWORD   password (default: district)
'use strict'

const BASE_URL =
    process.env.GSI_PERF_BASE_URL || 'http://dhis2-agent-gsi-emis:8080'
const CREDS = {
    username: process.env.GSI_PERF_USERNAME || 'local_admin',
    password: process.env.GSI_PERF_PASSWORD || 'district',
}
const AUTH =
    'Basic ' +
    Buffer.from(`${CREDS.username}:${CREDS.password}`).toString('base64')

/**
 * Every request this script makes, including the async shape's polling --
 * polling a job is real load on the server and belongs in the comparison,
 * not outside it.
 */
let requestCount = 0

async function api(path, init) {
    requestCount += 1
    const response = await fetch(`${BASE_URL}/api/${path}`, {
        ...init,
        headers: {
            Authorization: AUTH,
            'Content-Type': 'application/json',
            ...(init && init.headers),
        },
    })
    return response
}

async function apiJson(path, init) {
    const response = await api(path, init)
    const text = await response.text()
    if (!response.ok) {
        throw new Error(`HTTP ${response.status} on ${path}: ${text.slice(0, 300)}`)
    }
    return JSON.parse(text)
}

async function readGroup(groupId) {
    return apiJson(
        `organisationUnitGroups/${groupId}?fields=id,name,shortName,code`
    )
}

async function readMembers(groupId) {
    const body = await apiJson(
        `organisationUnitGroups/${groupId}/organisationUnits?fields=id&paging=false`
    )
    return body.organisationUnits.map((o) => o.id)
}

/** Shape 1: today's path -- sequential collection updates, `size` ids each. */
async function batched(groupId, memberIds, size) {
    for (let i = 0; i < memberIds.length; i += size) {
        const slice = memberIds.slice(i, i + size)
        const response = await api(
            `organisationUnitGroups/${groupId}/organisationUnits`,
            {
                method: 'POST',
                body: JSON.stringify({
                    additions: slice.map((id) => ({ id })),
                    deletions: [],
                }),
            }
        )
        if (!response.ok) {
            throw new Error(`batch at ${i} failed: HTTP ${response.status}`)
        }
        await response.text()
    }
}

/** Shape 2: one metadata import carrying the group's complete member list. */
async function metadataImport(group, memberIds) {
    const response = await api('metadata?importStrategy=UPDATE', {
        method: 'POST',
        body: JSON.stringify({
            organisationUnitGroups: [
                {
                    ...group,
                    organisationUnits: memberIds.map((id) => ({ id })),
                },
            ],
        }),
    })
    const text = await response.text()
    if (!response.ok) {
        throw new Error(`import failed: HTTP ${response.status}: ${text.slice(0, 300)}`)
    }
    const body = JSON.parse(text)
    const status = body.status ?? body.response?.status
    if (status !== 'OK' && status !== 'SUCCESS') {
        throw new Error(`import not OK: ${text.slice(0, 400)}`)
    }
    return body
}

/** Shape 3: shape 2 with async=true, then poll the job to completion. */
async function metadataImportAsync(group, memberIds) {
    const response = await api('metadata?importStrategy=UPDATE&async=true', {
        method: 'POST',
        body: JSON.stringify({
            organisationUnitGroups: [
                {
                    ...group,
                    organisationUnits: memberIds.map((id) => ({ id })),
                },
            ],
        }),
    })
    const text = await response.text()
    if (!response.ok) {
        throw new Error(
            `async import failed: HTTP ${response.status}: ${text.slice(0, 300)}`
        )
    }
    const job = JSON.parse(text).response
    for (;;) {
        await new Promise((r) => setTimeout(r, 1000))
        const poll = await api(`system/tasks/METADATA_IMPORT/${job.id}`)
        const notifications = JSON.parse(await poll.text())
        if (Array.isArray(notifications) && notifications.some((n) => n.completed)) {
            return notifications
        }
    }
}

async function readStdin() {
    const chunks = []
    for await (const chunk of process.stdin) {
        chunks.push(chunk)
    }
    return Buffer.concat(chunks).toString('utf8')
}

async function main() {
    const [groupId, shape, batchArg] = process.argv.slice(2)
    if (!groupId || !shape) {
        throw new Error(
            'usage: node scripts/perf/write-shapes.js <groupId> <shape|capture|restore> [batchSize]'
        )
    }
    const group = await readGroup(groupId)

    if (shape === 'capture') {
        const memberIds = await readMembers(groupId)
        process.stdout.write(JSON.stringify(memberIds))
        console.error(`captured ${memberIds.length} members of ${group.name}`)
        return
    }

    if (shape === 'restore') {
        const memberIds = JSON.parse(await readStdin())
        await metadataImport(group, memberIds)
        const now = await readMembers(groupId)
        console.error(
            `restored ${group.name} to ${now.length} members (wanted ${memberIds.length})`
        )
        if (now.length !== memberIds.length) {
            throw new Error('restore did not reach the captured member count')
        }
        return
    }

    // A timed run replaces the group's whole membership with the captured
    // list, from whatever state the group is in now. The caller is
    // responsible for having emptied it first (see the runner), so that
    // every shape does the same amount of real work.
    const memberIds = JSON.parse(await readStdin())
    const batchSize = batchArg ? Number(batchArg) : undefined

    requestCount = 0
    const started = Date.now()
    if (shape === 'batched') {
        if (!batchSize) {
            throw new Error('batched requires a batch size')
        }
        await batched(groupId, memberIds, batchSize)
    } else if (shape === 'import') {
        await metadataImport(group, memberIds)
    } else if (shape === 'import-async') {
        await metadataImportAsync(group, memberIds)
    } else {
        throw new Error(`unknown shape ${shape}`)
    }
    const seconds = (Date.now() - started) / 1000

    // Read back rather than trust the shape's own report: a shape that
    // finished fast because it silently did less is the one thing a timing
    // alone cannot show.
    const after = await readMembers(groupId)

    console.log(
        JSON.stringify({
            shape,
            batchSize: batchSize ?? null,
            seconds,
            requestCount,
            intended: memberIds.length,
            actual: after.length,
            complete: after.length === memberIds.length,
        })
    )
}

main().catch((e) => {
    console.error('FAILED:', e.message)
    process.exit(1)
})
