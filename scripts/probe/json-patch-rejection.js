// What does DHIS2 actually do with a JSON Patch members `replace` it cannot
// fully honour?
//
// `writes.ts`'s `patchChange` treats `response.ok` as the whole success
// signal and then reports `accepted: requested`. That is only sound if a
// 2xx means every id in the payload landed. The measurement that adopted
// JSON Patch (2026-09-plan8-json-patch.md) only ever induced *successful*
// patches, so the failure modes were never observed -- and a false success
// is not merely a misreport: `useMembershipWrite` writes a History row for
// it, and a later Revert would act on changes that never landed.
//
// Every case below sends a patch, records the status and body, and then
// RE-READS the group's members. The re-read is the point: it is the only
// thing that separates "reported success and did it" from "reported success
// and silently dropped ids".
//
//   node scripts/probe/json-patch-rejection.js <baseUrl> <groupId>
//
// Writes nothing permanent: the group's original members are restored at the
// end and the restore is verified.

const [, , baseUrl, groupId] = process.argv
if (!baseUrl || !groupId) {
    console.error(
        'usage: node scripts/probe/json-patch-rejection.js <baseUrl> <groupId>'
    )
    process.exit(1)
}

const USER = process.env.GSI_PROBE_USERNAME || 'local_admin'
const PASS = process.env.GSI_PROBE_PASSWORD || 'district'
const auth = ({ username = USER, password = PASS } = {}) =>
    `Basic ${Buffer.from(`${username}:${password}`).toString('base64')}`

const api = (path, init = {}, creds) =>
    fetch(`${baseUrl}/api/${path}`, {
        ...init,
        headers: {
            Authorization: auth(creds),
            ...(init.headers || {}),
        },
    })

async function members() {
    const r = await api(
        `organisationUnitGroups/${groupId}?fields=organisationUnits[id]`
    )
    const body = await r.json()
    return (body.organisationUnits || []).map((o) => o.id).sort()
}

async function patch(ids, creds) {
    const r = await api(
        `organisationUnitGroups/${groupId}`,
        {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json-patch+json' },
            body: JSON.stringify([
                {
                    op: 'replace',
                    path: '/organisationUnits',
                    value: ids.map((id) => ({ id })),
                },
            ]),
        },
        creds
    )
    const text = await r.text()
    return { status: r.status, ok: r.ok, body: text.slice(0, 300) }
}

const sameSet = (a, b) =>
    a.length === b.length && a.every((v, i) => v === b[i])

async function runCase({ name, ids, expectIds, creds }) {
    const before = await members()
    const res = await patch(ids, creds)
    const after = await members()
    const wanted = [...new Set(expectIds)].sort()
    const landed = sameSet(after, wanted)
    const unchanged = sameSet(after, before)
    console.log(
        [
            `CASE ${name}`,
            `  sent=${ids.length} ids`,
            `  HTTP ${res.status} ok=${res.ok}`,
            `  members before=${before.length} after=${after.length}`,
            `  landed_exactly_as_intended=${landed}`,
            `  unchanged=${unchanged}`,
            `  VERDICT=${
                res.ok && !landed
                    ? 'SILENT-PARTIAL -- 2xx but the group does not hold what was sent'
                    : res.ok && landed
                      ? 'honest success'
                      : !res.ok && unchanged
                        ? 'honest rejection -- nothing changed'
                        : 'REJECTED BUT MUTATED -- non-2xx yet members changed'
            }`,
            `  body=${res.body.replace(/\s+/g, ' ')}`,
        ].join('\n')
    )
    return { name, ...res, before, after, landed, unchanged }
}


/**
 * Creates a role with an authority that has nothing to do with organisation
 * unit groups, a user holding only that role, and patches as them. Both are
 * deleted afterwards whatever happens.
 */
async function authorityCase() {
    const suffix = Date.now().toString().slice(-6)
    const username = `gsiprobe${suffix}`
    let roleId = null
    let userId = null
    try {
        const roleRes = await api('userRoles', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                name: `GSI probe no-metadata-write ${suffix}`,
                authorities: ['F_DATAVALUE_ADD'],
            }),
        })
        roleId = (await roleRes.json()).response?.uid
        if (!roleId) {
            console.log('CASE F skipped: could not create a user role')
            return { name: 'F insufficient authority', ok: false, landed: false }
        }

        const userRes = await api('users', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                username,
                password: 'Probe#12345',
                firstName: 'GSI',
                surname: 'Probe',
                userRoles: [{ id: roleId }],
            }),
        })
        userId = (await userRes.json()).response?.uid
        if (!userId) {
            console.log('CASE F skipped: could not create the probe user')
            return { name: 'F insufficient authority', ok: false, landed: false }
        }

        const pool = (
            await (
                await api('organisationUnits?fields=id&pageSize=3&page=3')
            ).json()
        ).organisationUnits.map((o) => o.id)
        return await runCase({
            name: 'F valid ids, but the user has no authority to change the group',
            ids: pool,
            expectIds: pool,
            creds: { username, password: 'Probe#12345' },
        })
    } finally {
        if (userId) {
            await api(`users/${userId}`, { method: 'DELETE' })
        }
        if (roleId) {
            await api(`userRoles/${roleId}`, { method: 'DELETE' })
        }
    }
}

async function main() {
    const original = await members()
    console.log(`baseUrl=${baseUrl}`)
    const info = await (await api('system/info?fields=version')).json()
    console.log(`version=${info.version}`)
    console.log(`group=${groupId} original_members=${original.length}\n`)

    // A pool of real org unit ids to build payloads from -- taken from
    // outside this group so the cases genuinely change membership.
    const pool = (
        await (
            await api('organisationUnits?fields=id&pageSize=6&page=2')
        ).json()
    ).organisationUnits.map((o) => o.id)

    const results = []
    try {
        // Control: everything valid. Establishes that the shape works here.
        results.push(
            await runCase({
                name: 'A control: all ids valid',
                ids: pool,
                expectIds: pool,
            })
        )

        // The case with teeth: a well-formed UID that no object has.
        const ghost = 'Zz9GhOsT000'
        results.push(
            await runCase({
                name: 'B one well-formed but nonexistent id among valid ones',
                ids: [...pool.slice(0, 3), ghost],
                // If DHIS2 is honest this either rejects wholesale (members
                // unchanged) or accepts only the three real ids.
                expectIds: pool.slice(0, 3),
            })
        )

        results.push(
            await runCase({
                name: 'C only a nonexistent id',
                ids: [ghost],
                expectIds: [],
            })
        )

        results.push(
            await runCase({
                name: 'D malformed id (not a UID)',
                ids: ['tooshort'],
                expectIds: [],
            })
        )

        results.push(
            await runCase({
                name: 'E duplicate ids in one payload',
                ids: [pool[0], pool[0], pool[1]],
                expectIds: [pool[0], pool[1]],
            })
        )
        // The other half of the question: a user who may read the group but
        // has no authority to change it. Built and torn down here so the
        // probe needs no pre-seeded user.
        results.push(await authorityCase())
    } finally {
        // Restore, and prove the restore.
        await patch(original)
        const restored = await members()
        console.log(
            `\nRESTORE: original=${original.length} now=${restored.length} exact=${sameSet(
                restored,
                original
            )}`
        )
    }

    const liars = results.filter((r) => r.ok && !r.landed)
    console.log(
        `\nSUMMARY: ${liars.length} case(s) returned 2xx without the sent membership landing` +
            (liars.length ? `: ${liars.map((l) => l.name).join(', ')}` : '')
    )
}

main().catch((e) => {
    console.error(e)
    process.exit(1)
})
