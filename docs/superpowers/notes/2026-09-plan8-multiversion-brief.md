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

*(fill in as the pass runs)*
