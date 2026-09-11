# Carried forward from Plan 1 into the plans that follow

Plan 1's reviews deferred these deliberately. The final whole-branch review
triaged each one; this is that triage, plus the items later reviews raised.
Anything marked **blocks Plan 2** must be settled before the work it names.

## Blocks Plan 2

- **`setConfig` does not re-evaluate.** `EngineStore.setConfig` stores the config
  and nothing else; only an explicit `evaluate()` recomputes. Plan 2 introduces
  the two callers that will forget it: writing required levels, and the tracker
  toggle. Either make `setConfig` re-evaluate, or make the omission impossible.
- **Required-levels semantics are unsettled.** Spec 3.3 says required levels on a
  non-compulsory set make other levels "ignored", but `rules.ts` still emits a
  missing warning at other levels for a data dimension set, and its test asserts
  that. Harmless while nothing populates `requiredLevels`; a contradiction the
  moment Plan 2 wires the dataStore config. Decide which is right and align both.
- **The cache-reuse branch has no rollback.** It makes two engine calls with
  nothing to undo the first if the second fails, so a worker crash between them
  leaves objects without memberships. Closing it needs an engine change, because
  `loadMemberships` requires the type to exist already.

## Plan 2's own scope, already identified

- **Restore the parent column** with a resolved parent name. It was dropped in
  Plan 1 because a column of identical opaque ids reads as noise, but at national
  scope the list now has nothing to distinguish two identically named facilities.
- **Cancellation.** An unmount during an in-flight load leaves a promise pending
  forever, because the generation token is not bumped on unmount. Fix it with the
  cancellation work Plan 2 needs anyway for writes.
- **A failed page fetch clears the loaded rows** and shows an error with no retry
  path. It belongs with the shared query hook's error handling.

## Smaller, any time

- A malformed level column from a SQL view is coerced to 0 rather than surfacing.
  Level 0 is impossible in DHIS2, so it lands as a silent wrong answer.
- `setNames` runs after a type's evaluate, so a names failure records a type-level
  error even though the counts are correct: a cosmetic failure that looks like a
  data failure.
- No test combines two object filters in one call, and none covers flat types
  silently excluding everything under a level or ancestor filter.
- The overview's loading, error and data branch has no regression test.
- The detail page shows no indication that a reload is running; only the dashboard
  does, so numbers can change under a user with no explanation.
- Four CSS modules use hardcoded font sizes rather than tokens, and it is drifting.
- Count labels are inconsistent about thousands separators.
- The object type labels call `i18n.t` at module evaluation time, so a locale set
  after import is not reflected.
- The matrix's flat branch ignores the scope root. Harmless for types with no
  hierarchy.
- Sets that have not loaded yet sort to the bottom with the clean ones; only the
  card's own text distinguishes them.
- The performance budget's cushion is thin on a machine much slower than the one
  it was calibrated on. If it flakes once, raise the budget rather than loosening
  what it asserts.
