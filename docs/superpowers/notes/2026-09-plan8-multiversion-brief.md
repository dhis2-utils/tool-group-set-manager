# Multi-version verification pass — working brief

**Status: in progress.** This file is the durable state for a verification
pass that runs after the metadata freshness work merged. If context is lost,
resume from here.

## What is already merged

`main` at `efc905b` — "Merge metadata freshness: bound, show and refresh the
snapshot's age". 24 commits. 689 tests / 62 suites green; `tsc --noEmit`,
`eslint src`, `tsc -p e2e --noEmit` all clean.

Spec: `docs/superpowers/specs/2026-09-16-metadata-freshness-design.md`.
Carried forward: `docs/superpowers/notes/2026-09-plan8-carry-forward.md`.

## Why this pass exists

Coverage before it:

| version | database | what had run |
| --- | --- | --- |
| 2.40.12 | SL demo | full e2e 9/9; JSON Patch functional check |
| 2.41.10 | EMIS (266,396 org units) | **perf only** — no e2e, no functional test |
| 2.42.6 | SL demo | one `lastUpdated` probe (Plan 7); nothing from this work |
| 2.43.1 | SL demo | full e2e 9/9; `mergeMode` check |

Three gaps:

1. **2.41 and 2.42 have never run the e2e suite** — the app as a whole is
   unexercised on the two middle versions.
2. **The freshness feature has only run against the Sierra Leone seed.** EMIS
   is the one genuinely different database and was used for measurement, never
   functional testing. The indicator, the TTL and the pre-write check have
   never been exercised against a 266k-org-unit population — which is exactly
   where the re-read's measured 1–2s per group lands.
3. `e2e/playwright.config.ts` defines only two projects, so covering 2.41/2.42
   means adding projects and instances, not just changing a URL.

Note the manual-review spec's §10 multi-version review (2.40→2.43, different
databases) was scoped to run once after Plans 4–7 together and has **not**
happened either; this work is new scope stacked on top, so §10's sweep would
now have to cover it too.

## The pass

In this order, **one broker instance running at a time**:

1. Create `agent-gsi-p8-41` (2.41, seed `dhis2-db-sierra-leone_v41.sql.gz`).
   Add a `2.41` project to `e2e/playwright.config.ts`. Build, install, run the
   full suite. Record per-test results.
2. Stop it. Create `agent-gsi-p8-42` (2.42, seed
   `dhis2-db-sierra-leone_v42.sql.gz`). Add a `2.42` project. Same again.
3. Stop it. Start `agent-gsi-emis` (2.41, 266,396 org units). Install the
   build. **Manually** exercise the freshness feature at scale: the indicator
   renders and shows a plausible age; Refresh reloads and the age resets; the
   TTL expires a cached load; a bulk fix large enough to cross
   `DEFAULT_BATCH_SIZE` runs its pre-write re-read and the wait is tolerable.
   The e2e suite cannot run here — `flows.spec.ts` is pinned to Sierra Leone
   data throughout.
4. Delete the two created instances. Leave `agent-gsi-emis` and the two
   existing SL instances stopped and restored.

## Environment facts that will otherwise cost time

- **`e2e/playwright.config.ts` pins a Chromium build that no longer exists.**
  Export `PLAYWRIGHT_CHROME_PATH=/opt/playwright-browsers/chromium-1234/chrome-linux/chrome`
  before any Playwright run or every test fails at launch. (Carried forward as
  its own item — do not fix it here.)
- Broker: `$DHIS2_BROKER_URL` / `$DHIS2_BROKER_TOKEN`. Create/start/stop return
  a job; poll `GET $DHIS2_BROKER_URL/jobs/<id>` until `status` is not
  `running`. A `succeeded` create/start already means the API is up.
- Reach instances at `http://dhis2-<name>:8080`, never `localhost`.
  Credentials `local_admin` / `district`.
- Install the app with
  `curl -u local_admin:district -X POST -F "file=@build/bundle/group-set-integrity-tool-1.0.0.zip" http://dhis2-<name>:8080/api/apps`
  after `pnpm build`. Reinstall per instance or you test an old build.
- **Instance-state hazard.** Every writing flow in `flows.spec.ts` reverts as
  its last step; one that fails between write and revert leaves the instance
  in the state that fails the *next* run's precondition. The `Area` set
  (`uIuxlbV1vRT`) should hold only the thirteen level-2 districts — Northern:
  Bombali, Koinadugu, Kono, Tonkolili; Southern: Bo, Bonthe, Moyamba. Any
  level-3/4 org unit in an Area group is leftover damage; clear it before
  re-running. This has cost this project a full investigation twice.
- There is an instance cap counting stopped instances. Four already exist
  (`agent-dqa`, `agent-gsi-emis`, `agent-gsi-p2`, `agent-gsi-p2-40`). If a
  create is refused, delete only instances this pass created.

## Results

### 2.41.10, Sierra Leone v41 seed (`agent-gsi-p8-41`) — 9/9

Full suite green in 2.6 min. Instance deleted after the run.

**One finding, and it is about the instance, not the app.** On the freshly
created-and-seeded instance, three legacy list endpoints reported an empty
collection although the rows were there:

```
GET /api/organisationUnitGroupSets  -> {"pager":{"total":0}, ...:[]}
GET /api/organisationUnitGroups     -> total 0   (18 rows in the database)
GET /api/categoryOptionGroupSets    -> total 0   (2 rows)
GET /api/dataElementGroupSets       -> total 5   (fine)
GET /api/indicatorGroupSets         -> total 8   (fine)
GET /api/organisationUnits          -> total 1332 (fine)
```

The app therefore rendered "No group sets of this type" for organisation
units, and every flow that needs the `Area` set failed.

What it was not: the rows exist; `sharing` is byte-identical in shape to
`dataElementGroupSet`'s (`{"owner": "GOLswS44mh8", "public": "rw------",
"external": false}`); the owner FK resolves; `orgunitgroupsetmembers` is
intact; the same query fails for `admin` as for `local_admin`. Two things
separated the working path from the broken one: `GET /api/…/<uid>` returned
the object fine, and `GET /api/organisationUnitGroupSets/gist` returned all
four. Only the legacy list query — the one that builds a SQL count — saw
nothing, even filtered by `filter=id:eq:<uid>`.

`POST /api/maintenance/cacheClear` did **not** fix it. A Tomcat stop/start
through the broker did, immediately and completely. 2.42 created the same
way never showed it.

So: a fresh-boot artifact of a seeded instance, in the same family as the
known "`/api/authorities` 500s until something loads the legacy web layer"
quirk. **Before concluding that a freshly seeded instance is missing
metadata, restart it** — or cross-check with `/gist`, which does not share
the broken path. Nothing here is an app defect and nothing was changed in
the app because of it.

The run also re-confirmed the instance-state hazard this brief warns about
from the other direction: the pre-restart failing run installed the usage
SQL view and failed before removing it, so the first post-restart run failed
that one flow on a dirty precondition (`Remove usage SQL view` where it
expected `Install usage SQL view`). Cleaned, re-run, green.

### 2.42.6, Sierra Leone v42 seed (`agent-gsi-p8-42`) — 9/9

Full suite green in 57 s, first try, no findings. Legacy list endpoints were
correct from first boot. Instance deleted after the run.

### EMIS (266,396 organisation units, DHIS2 2.41.10) — one real defect, fixed

The feature works at scale, and the numbers are comfortable. Measured on the
installed build, data coming from the `GSI_*` SQL views:

| | |
| --- | --- |
| cold dashboard load to indicator visible | 5.0 s |
| opening a group set detail page | 5.2 s |
| warm reload inside the TTL (cache reused) | ~5 s |
| forced Refresh, whole reload | 5.0 s |

All seven organisation unit group sets render, and the buckets reconcile
against the population exactly (School Level: 16,136 conflicts + 60,881
missing + 189,379 ok = 266,396).

**The defect.** Clicking Refresh made the age label *and the Refresh button
itself* disappear from the filter bar for the whole reload, then reappear.
Instrumented on the dashboard: gone 117 ms after the click, back at
5,678 ms.

Cause: `MetadataFreshness` opened with

```tsx
if (loadedAt === null) {
    return null
}
```

and a forced reload clears `loadedAt` for its duration. So the component
unmounted mid-refresh, losing its own `busy` state — which is also why the
`Reloading metadata…` label and the disabled button, both of which the
component already implemented, were unreachable in practice.

Why four green versions missed it: on the Sierra Leone seed the reload
finishes fast enough that the busy render lands before `loadedAt` clears, so
`flows.spec.ts`'s `toBeDisabled` → `toBeEnabled` assertion passes. It is a
race the small seed happens to win and the large one loses. This is exactly
the class of bug the EMIS leg exists to find, and it would not have been
found by any amount of further testing on Sierra Leone data.

Fix: only "nothing has loaded yet" renders nothing —

```tsx
if (loadedAt === null && !busy) {
    return null
}
const age = loadedAt === null ? null : metadataAge(loadedAt, now)
```

Two regression tests pin it at the unit level (the deterministic layer for a
race like this): the control stays mounted, disabled and showing
`Reloading metadata…` while a reload is in flight with `loadedAt` null, and
still renders nothing when an idle reload leaves no data. Re-verified live
on EMIS afterwards: indicator never disappears, button disables, busy label
shows, 5.0 s refresh.

## Status: complete

| leg | result |
| --- | --- |
| 2.41.10, SL v41 seed | 9/9 — one instance-boot artifact, not an app defect |
| 2.42.6, SL v42 seed | 9/9 first try |
| EMIS, 266k org units | one real defect found and fixed |
| 2.43.1 re-run with the fix | 9/9 |

`pnpm test` 691 tests / 62 suites; `tsc --noEmit` and `eslint src` clean.
`agent-gsi-p8-41` and `agent-gsi-p8-42` deleted; every other instance left
stopped.
