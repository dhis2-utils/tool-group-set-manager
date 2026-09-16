# What DHIS2 does with a JSON Patch it cannot honour

Closes `2026-09-plan8-carry-forward.md` §1's first item.

## The question

`writes.ts`'s `patchChange` treats `response.ok` as the whole success signal
and then reports `accepted: requested`. That is only sound if a 2xx means
every id in the payload actually landed.

The measurement that adopted JSON Patch
(`2026-09-plan8-json-patch.md`) only ever induced *successful* patches, so
the failure modes were never observed. The risk was not merely a misreport:
`useMembershipWrite` writes a History row for a reported success, and a later
Revert would then act on changes that never happened.

## Method

`scripts/probe/json-patch-rejection.js`. Each case sends a members
`replace` patch, records the status and body, and then **re-reads the
group's members**. The re-read is the point — it is the only thing that
separates "reported success and did it" from "reported success and silently
dropped ids". The group's original membership is restored at the end and the
restore is verified.

Run against `Northern Area` on a disposable Sierra Leone instance per
version. Deliberately not against the e2e instances: that group is exactly
the one `flows.spec.ts` pins its preconditions to.

## Result: `response.ok` is sound, on every supported version

Identical on **2.40.12, 2.41.10, 2.42.6 and 2.43.1**:

| case | status | membership after |
| --- | --- | --- |
| A all ids valid | 200 | exactly what was sent |
| B one well-formed but nonexistent id among valid ones | **409** | **unchanged** |
| C only a nonexistent id | **409** | **unchanged** |
| D malformed id (`tooshort`) | **409** | **unchanged** |
| E duplicate ids in one payload | 200 | deduplicated, as intended |
| F valid ids, user without the authority | **403** | **unchanged** |

**No case returned 2xx without the sent membership landing.** A refusal is
atomic: the whole patch is rejected and the group keeps the membership it
had. There is no partial application and no silent dropping of ids, which is
the specific failure the carry-forward was worried about.

Case B is the decisive one. A single bad id among valid ones does **not**
write the valid three and quietly discard the fourth — it refuses the lot.

## The bodies are useful, and were being thrown away

A rejection carries an `ObjectReport` that says precisely what was wrong:

```
409  "One or more errors occurred, please see full details in import report."
     errorReports: [{ message: "Invalid reference [Zz9GhOsT000] (OrganisationUnit)" }]
403  "You don't have the proper permissions to update this object."  errorCode E1006
```

`patchChange` discarded this, so a failed large write was diagnosable only as
`HTTP 409` — the second thing `2026-09-plan8-carry-forward.md` §3 noted about
this path. It now captures the body onto `rawError` and logs it, matching the
convention the unparseable-body path already uses. It deliberately does **not**
go on `error`: that field is spliced into translated sentences and has to stay
locale-neutral (`UNPARSEABLE_RESPONSE`'s doc comment has the full reasoning).

## What this does not cover

- **A mid-flight failure** — connection dropped after the server committed —
  is untouched by this. It is the same exposure the batched path has always
  had, and no status code can close it.
- **`E` deduplication is a DHIS2 behaviour this app never relies on**: the
  intended list `patchChange` builds is already free of duplicates by
  construction.
- **A 2xx whose body reports an error** does not occur for a single-object
  patch (there is no import report to carry a per-object status), and A and E
  both returned `errorReports: []`. If a future version starts reporting
  errors inside a 200 here, this conclusion needs re-running — the probe
  script is committed for exactly that.
