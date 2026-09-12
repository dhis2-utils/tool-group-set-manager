# UI test results: Group Set Integrity Tool v1.0.0

Tested: 2026-09-12 · App: installed zip (`group-set-integrity-tool-1.0.0.zip`,
`POST /api/apps`) on each instance · Test data: Sierra Leone demo database
(seeded identically on both broker instances)

## Instances

| Label | URL | DHIS2 version | Source |
|---|---|---|---|
| 2.43.1 | http://dhis2-agent-gsi-p2:8080 | 2.43.1 | broker, Sierra Leone demo |
| 2.40.12 | http://dhis2-agent-gsi-p2-40:8080 | 2.40.12 | broker, Sierra Leone demo |

## Results

| Step | 2.43.1 | 2.40.12 | Notes |
|---|---|---|---|
| App installed (`POST /api/apps`) | PASS (201) | PASS (204) | documented version-dependent status code, both correct |
| Dashboard renders group set cards | PASS | PASS | `e2e/flows.spec.ts` |
| Drill down: card → overview matrix → filtered objects | PASS | PASS | `e2e/flows.spec.ts` |
| Single assign, confirm, revert through History | PASS | PASS | `e2e/flows.spec.ts` |
| Bulk move: preview counts match result panel, then revert | PASS | PASS | `e2e/flows.spec.ts` |
| Direct `#/history` revert | PASS | PASS | `e2e/flows.spec.ts` |
| DHIS2 integrity tab: open, "Run now", completes | PASS (2.43.1 only) | not run | throwaway probe, not committed — see L1 in `REVIEW-FINDINGS.md` |
| Text search: full facility name narrows list to 1 row | PASS (2.43.1 only) | not run | same probe |

Full suite timing: 5/5 passed on 2.43.1 in 38.7s; 5/5 passed on 2.40.12 in
1.6m (visibly slower per write step, consistent with
`docs/superpowers/notes/2026-09-plan3-performance.md`'s findings about this
instance, not a new regression).

## Version-specific failures

None. Every step that ran on both versions passed identically. The
integrity-tab and search probe was only run on 2.43.1 (see L1) — this is a
coverage gap, not an observed version-specific failure.

## Console/network hygiene

Not separately captured this pass — the existing suite does not assert on
console/network output, and this review did not add that instrumentation
(out of scope for a hand-off pass; would be new tooling, not a finding
about the app itself).

## Screenshots

None captured for the passing runs. One failure screenshot was produced
while debugging the throwaway probe's own selector (not an app defect —
`getByLabel('Search')` doesn't match `@dhis2/ui`'s `InputField` markup; the
probe was fixed to use the same `[data-test="dhis2-uiwidgets-inputfield"]`
locator pattern `e2e/flows.spec.ts` already uses) and was deleted along with
the probe file itself.
