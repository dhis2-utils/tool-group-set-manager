# Review findings: Group Set Integrity Tool v1.0.0

Reviewed: 2026-09-12 · Scope: code review + functional test (Task 11 hand-off
pass) · Reviewer: agent (Claude Sonnet 5)
DHIS2 versions tested: 2.43.1, 2.40.12

## Summary

This is Plan 3's hand-off review, run at the end of an eleven-task branch
that already carries its own extensive verification trail (Plans 1-3's
compatibility, write-path, integrity-API and performance notes, plus Task
9/10's Playwright e2e suite). The static pass covered every file Plan 3
touched (`git diff 73d3e03..cf5622f --stat -- src`, 59 files) rather than
sampling; the functional pass re-ran the existing 5-flow suite on both
target versions and additionally drove the two features that suite never
touches (the DHIS2 integrity tab, and text search as a feature in its own
right, not just as a means to find a row). No new functional defect was
found. Safe to hand off, with four known, deliberately unfixed defects
recorded in `docs/superpowers/notes/2026-09-plan3-carry-forward.md` and one
new LOW below.

## Findings

### HIGH

None found in Plan 3's own work. (Four pre-existing/known defects are
tracked in the carry-forward note rather than repeated here — see that note
for `ObjectsTable`'s stale-after-write control, the bulk-apply timing
extrapolation, the transient History message, and the `@types/node`
resolution change.)

### MEDIUM

None found beyond what the carry-forward note already tracks.

### LOW

#### L1. No regression coverage for the integrity tab or the search filter — `e2e/flows.spec.ts`

Plan 3's two headline features (the DHIS2 integrity overlay and
whole-population text search) are never driven by the permanent Playwright
suite. Search is used incidentally inside other flows (as a way to locate a
row by name), never asserted on as a feature — no test exercises the
integrity tab at all. Both were confirmed working live during this review
(see `UI-TEST-RESULTS.md`), so this is not a functional defect, but a future
plan changing either area has no regression net for it. Recorded in
`docs/superpowers/notes/2026-09-plan3-carry-forward.md` rather than fixed
here — fixing it means adding new permanent test cases, which is scope
beyond a hand-off review.

## Claims investigated and rejected

None — no static-review claim in this pass was contradicted by a live test.

## Architecture assessment

Out of scope for this review (not requested).

## Environment gaps

None. Broker, `SANDBOX_HOST_PORT`, Playwright and every sibling `dhis2-*`
skill referenced were all available. Both instances the e2e suite targets
(`agent-gsi-p2` 2.43.1, `agent-gsi-p2-40` 2.40.12) were reachable; the
latter was stopped when this review began and was started, used, and
stopped again to leave it as found. `agent-gsi-p2` was left running and
untouched throughout, as instructed.
