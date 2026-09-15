# GSI Plan 5: Navigation and Layout — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the organisation unit one control shown in one place on every page, make the summary matrix survive a group set with hundreds of groups, and make the two features a reviewer could not find — drill-down and the DHIS2 integrity check — visible.

**Architecture:** A new shared `FilterBar` owns the row of controls on both the dashboard and the group set page, and the organisation unit becomes one of its fields rather than a separate widget with its own layout. The matrix gains a ranking-and-capping layer between `MatrixResult` and its columns, computed from the totals it already has rather than from a new query. Everything else is a presentation change on existing data.

**Tech Stack:** TypeScript, React 18, @dhis2/ui 10.17.0, @dhis2/app-runtime, TanStack Query v4, Jest + @testing-library/react, Playwright for e2e, Vite via the DHIS2 App Platform, pnpm.

**Spec:** `docs/superpowers/specs/2026-09-15-manual-review-1-design.md` — this plan implements §4 in full, plus the e2e coverage gap in §7's last bullet. §3 (usage) and §5/§6 (fixing) are later plans; their absence is not a defect.

## Global Constraints

- Supported DHIS2 versions: **2.40 and newer**.
- `src/engine` is pure TypeScript with typed arrays, runs in a Web Worker, imports nothing from React or DHIS2. Test it with plain Jest.
- Every user-facing string goes through a single, **argument-free** `i18n.t('…')` call. Any second argument makes the call invisible to this project's i18next-scanner, so it never reaches `i18n/en.pot`.
- **A sentence is translated whole.** Never join translated fragments around a value; put a `{name}` placeholder inside the one complete string and fill it with `interpolate()` from `src/utils/interpolate.ts`. Single braces, never `{{…}}`.
- **No colon inside an `i18n.t()` string** — the scanner reads it as a namespace separator and drops the key.
- Counts are two complete strings chosen on `count === 1`, with the number in a `{count}` placeholder.
- Data fetching goes through `useApiDataQuery` (TanStack Query v4), never `useDataQuery` directly.
- Run `pnpm exec d2-app-scripts i18n extract` after adding or changing any string; commit `i18n/en.pot` and check the output for scanner warnings.
- Gates before every commit: `pnpm test`, `pnpm exec tsc --noEmit`, `pnpm exec eslint src`.
- Commit messages end with `Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>` and **never** a `Claude-Session:` or session-URL trailer.

---

## File Structure

| File | Responsibility after this plan |
| --- | --- |
| `src/components/FilterBar/FilterBar.tsx` | **New.** One row of equal-height labelled fields; renders the fields its caller passes, always in the same order |
| `src/components/FilterBar/OrgUnitField.tsx` | **New.** The organisation unit field — label, current name, opens the existing tree modal |
| `src/components/ScopeSelector/ScopeSelector.tsx` | **Deleted.** `levelFromPath` moves to `OrgUnitField.tsx` with its tests |
| `src/pages/Dashboard/Dashboard.tsx` | Renders `FilterBar` with org unit, object type, show, sort, reload |
| `src/pages/GroupSetDetail/GroupSetDetail.tsx` | Renders `FilterBar`; no `Scope ({name})` tag; header gains the integrity button; owns drill-down |
| `src/components/SummaryMatrix/SummaryMatrix.tsx` | Right-aligns its numeric headers; caps group columns; row labels drill down |
| `src/components/SummaryMatrix/columnPlan.ts` | **New.** Pure: ranks groups by total and splits them into shown / other |
| `src/components/GroupsPanel/GroupsPanel.tsx` | **New.** "Groups in this set", derived from `MatrixResult` |
| `e2e/flows.spec.ts` | Gains an integrity-tab flow and a text-search flow |

**Dependency order:** Task 1 → Task 2 (FilterBar exists before its second caller). Task 4 → Task 5 (the ranking `columnPlan` is shared). Tasks 3, 7 and 8 are independent of the rest.

---

### Task 1: FilterBar, and the organisation unit as one of its fields

**Files:**
- Create: `src/components/FilterBar/FilterBar.tsx`, `src/components/FilterBar/FilterBar.module.css`, `src/components/FilterBar/OrgUnitField.tsx`
- Create: `src/components/FilterBar/OrgUnitField.test.tsx`, `src/components/FilterBar/FilterBar.test.tsx`
- Modify: `src/pages/Dashboard/Dashboard.tsx:138-175`, `src/pages/Dashboard/Dashboard.module.css`
- Delete: `src/components/ScopeSelector/ScopeSelector.tsx`, `src/components/ScopeSelector/ScopeSelector.test.ts`
- Test: `src/pages/Dashboard/Dashboard.test.tsx`

**Interfaces:**
- Consumes: `useScope()` → `{ rootId, rootName, rootLevel, setRoot, isReady }` from `src/hooks/useScope.tsx`; `useUserScope()` → `{ roots }`.
- Produces, for Task 2 and Task 6:
  - `FilterBar: (props: { children: React.ReactNode }) => JSX.Element` — a flex row with `align-items: flex-end`, wrapping.
  - `FilterBarField: (props: { label: string; children: React.ReactNode }) => JSX.Element` — one labelled cell; its label always renders, so every field in the row has the same height.
  - `OrgUnitField: () => JSX.Element | null` — the organisation unit field, self-contained: reads and writes the scope itself, takes no props.
  - `levelFromPath: (path: string | undefined) => number | null` — moved verbatim from `ScopeSelector.tsx`, re-exported from `OrgUnitField.tsx`.

**Why this shape:** the review's complaint is that the dashboard's controls have four different heights and two different label positions — today's row mixes a bare `<span>Scope: </span><strong>…</strong><Button>` line, a label-above `SingleSelectField`, a `Checkbox`, and a small `Button`, all under `align-items: center`. Making every control a labelled field of one height is the whole fix.

- [ ] **Step 1: Write the failing test for the org unit field**

Create `src/components/FilterBar/OrgUnitField.test.tsx`:

```tsx
import { fireEvent, render, screen } from '@testing-library/react'
import React from 'react'
import { levelFromPath, OrgUnitField } from './OrgUnitField'

const mockSetRoot = jest.fn()
jest.mock('@/hooks/useScope', () => ({
    useScope: () => ({
        rootId: 'r1',
        rootName: 'Sierra Leone',
        rootLevel: 1,
        setRoot: mockSetRoot,
        isReady: true,
    }),
}))
jest.mock('@/hooks/useUserScope', () => ({
    useUserScope: () => ({ roots: [{ id: 'r1', displayName: 'Sierra Leone' }] }),
}))

describe('OrgUnitField', () => {
    it('is labelled "Organisation unit", not "Scope"', () => {
        render(<OrgUnitField />)
        expect(screen.getByText('Organisation unit')).toBeInTheDocument()
        expect(screen.queryByText('Scope')).not.toBeInTheDocument()
    })

    it('shows the current organisation unit as the field value', () => {
        render(<OrgUnitField />)
        expect(screen.getByText('Sierra Leone')).toBeInTheDocument()
    })

    it('opens the tree when the field is activated', () => {
        render(<OrgUnitField />)
        fireEvent.click(screen.getByRole('button', { name: /Sierra Leone/ }))
        expect(
            screen.getByText('Choose the organisation unit to work in')
        ).toBeInTheDocument()
    })
})

// Moved from ScopeSelector.test.ts, unchanged: a DHIS2 path is
// "/root/child/grandchild", so its segment count is the level.
describe('levelFromPath', () => {
    it('counts path segments', () => {
        expect(levelFromPath('/a/b/c')).toBe(3)
        expect(levelFromPath('/a')).toBe(1)
        expect(levelFromPath(undefined)).toBe(null)
        expect(levelFromPath('')).toBe(null)
    })
})
```

Read `src/components/ScopeSelector/ScopeSelector.test.ts` first and carry over any `levelFromPath` case it has that the block above misses.

- [ ] **Step 2: Run it to verify it fails**

Run: `pnpm test -- src/components/FilterBar/OrgUnitField.test.tsx`
Expected: FAIL — the module does not exist.

- [ ] **Step 3: Write `FilterBar.tsx` and its CSS**

```tsx
import React from 'react'
import styles from './FilterBar.module.css'

/**
 * One row of controls, shared by the dashboard and the group set page so a
 * field never moves between pages (spec 2026-09-15 §4.1). Every child is a
 * `FilterBarField`, which always renders a label — that is what makes the
 * row one height. Today's dashboard row mixes a label-left line, a
 * label-above select, a checkbox and a small button under
 * `align-items: center`, which is the misalignment the review reports.
 */
export const FilterBar = ({ children }: { children: React.ReactNode }) => (
    <div className={styles.bar}>
        <div className={styles.row}>{children}</div>
    </div>
)

export const FilterBarField = ({
    label,
    children,
}: {
    label: string
    children: React.ReactNode
}) => (
    <div className={styles.field}>
        <span className={styles.label}>{label}</span>
        {children}
    </div>
)
```

`src/components/FilterBar/FilterBar.module.css`:

```css
.bar {
    background: var(--colors-white);
    border: 1px solid var(--colors-grey300);
    border-radius: 3px;
    padding: var(--spacers-dp12) var(--spacers-dp16);
}
.row {
    display: flex;
    gap: var(--spacers-dp12);
    /* flex-end, not center: fields have a label above their control, and a
       control with no label of its own must still sit on the same baseline
       as one that has. */
    align-items: flex-end;
    flex-wrap: wrap;
}
.field {
    display: flex;
    flex-direction: column;
    gap: var(--spacers-dp4);
    min-width: 0;
}
.label {
    font-size: var(--gsi-font-size-sm, 12px);
    color: var(--colors-grey700);
    font-weight: 500;
}
```

- [ ] **Step 4: Write `OrgUnitField.tsx`**

Move `levelFromPath` across verbatim, with its doc comment. The field is a `Button` showing the current name, so it is one focusable control of the same height as a `dense` select:

```tsx
import i18n from '@dhis2/d2-i18n'
import {
    Button,
    Modal,
    ModalActions,
    ModalContent,
    ModalTitle,
    OrganisationUnitTree,
} from '@dhis2/ui'
import React, { useState } from 'react'
import { FilterBarField } from './FilterBar'
import { useScope } from '@/hooks/useScope'
import { useUserScope } from '@/hooks/useUserScope'

/** <paste ScopeSelector.tsx's existing doc comment for levelFromPath here> */
export const levelFromPath = (path: string | undefined): number | null => {
    if (!path) {
        return null
    }
    const segments = path.split('/').filter((s) => s.length > 0)
    return segments.length > 0 ? segments.length : null
}

/**
 * The app's single organisation unit control (spec 2026-09-15 §4.1). It is
 * rendered on every page that has a scope, so there is only ever one value
 * and the dashboard and the Objects tab cannot disagree about it. Labelled
 * "Organisation unit" rather than "Scope": in review the old label was
 * missed entirely, and then found unclear.
 */
export const OrgUnitField = () => {
    const { rootName, setRoot } = useScope()
    const { roots } = useUserScope()
    const [open, setOpen] = useState(false)

    return (
        <FilterBarField label={i18n.t('Organisation unit')}>
            <Button onClick={() => setOpen(true)}>
                {rootName || i18n.t('Choose an organisation unit')}
            </Button>
            {open && (
                <Modal onClose={() => setOpen(false)} position="middle">
                    <ModalTitle>
                        {i18n.t('Choose the organisation unit to work in')}
                    </ModalTitle>
                    <ModalContent>
                        <OrganisationUnitTree
                            roots={roots.map((r) => r.id)}
                            singleSelection
                            onChange={({ id, displayName, path }) => {
                                setRoot(id, displayName, levelFromPath(path))
                                setOpen(false)
                            }}
                        />
                    </ModalContent>
                    <ModalActions>
                        <Button onClick={() => setOpen(false)}>
                            {i18n.t('Cancel')}
                        </Button>
                    </ModalActions>
                </Modal>
            )}
        </FilterBarField>
    )
}
```

- [ ] **Step 5: Run the org unit field tests**

Run: `pnpm test -- src/components/FilterBar/OrgUnitField.test.tsx`
Expected: PASS.

- [ ] **Step 6: Rebuild the dashboard's row**

In `src/pages/Dashboard/Dashboard.tsx`, replace the `styles.toolbar` block with a `FilterBar` holding five fields in this order: **Organisation unit · Object type · Show · Sort by · Reload data**.

**One height, one label style — this is the point of the task, and it beats any sample below.** Two rules bind every field in the bar, here and in Task 2:

1. **`FilterBarField` supplies the label; the library control never does.** Drop `label=` from every `SingleSelectField` in the bar. Otherwise the row carries two label typographies — `FilterBarField`'s own span against `@dhis2-ui/label`'s `Label`, which `SingleSelectField` renders at a different size, colour and weight.
2. **Every control renders at the same height.** In @dhis2/ui 10.17.0 a default `Button` is 36px, a `small` `Button` is 28px, and a `dense` `SingleSelectField` is 32px — so mixing the defaults gives three heights. Choose one convention across the whole bar, record it in a comment in `FilterBar.module.css`, and close any residual gap with an explicit height on the field's control slot only if the library's own size props cannot.

With those in force:

- `Organisation unit` is `<OrgUnitField />` — it brings its own `FilterBarField`.
- `Object type` is today's `SingleSelectField` wrapped in a `FilterBarField`, with its own `label` prop removed and its size matched to the convention.
- `Show` replaces the `Checkbox`. Two options, `Only sets with issues` (the default, matching today's `useState(true)`) and `All sets`. Keep the `onlyIssues` boolean in state and map it, rather than storing the string.
- `Sort by` is new: `Issues` (today's `byWorstFirst`, the default) and `Usage`. **Usage data does not exist until Plan 6.** Render the option `disabled` with the title `i18n.t('Usage data is not installed on this instance')` and leave `byWorstFirst` as the only sort actually implemented. Do not invent a usage sort or a placeholder number.
- `Reload data` is today's button wrapped in a `FilterBarField` whose label is `i18n.t('Data')`, so it sits on the same baseline. Do not use a blank or `&nbsp;` label — an empty label is unreadable to a screen reader.

Delete `.toolbar` from `Dashboard.module.css`.

- [ ] **Step 7: Delete `ScopeSelector`**

```bash
git rm src/components/ScopeSelector/ScopeSelector.tsx src/components/ScopeSelector/ScopeSelector.test.ts
```

`pnpm exec tsc --noEmit` names any remaining importer. There should be exactly one (Dashboard), already handled in Step 6.

- [ ] **Step 8: Update the dashboard tests**

`src/pages/Dashboard/Dashboard.test.tsx` mocks or renders the old toolbar. Update the assertions to the new controls. Add one test that pins the field order, because "a field never moves between pages" is the point of the component:

```tsx
it('renders its filter fields in the fixed order', () => {
    renderDashboard()
    const labels = screen
        .getAllByText(
            /Organisation unit|Object type|Show|Sort by|Data/
        )
        .map((el) => el.textContent)
    expect(labels).toEqual([
        'Organisation unit',
        'Object type',
        'Show',
        'Sort by',
        'Data',
    ])
})
```

Use the file's existing render helper in place of `renderDashboard()`.

- [ ] **Step 9: Extract strings, run the gate, commit**

```bash
pnpm exec d2-app-scripts i18n extract
pnpm test && pnpm exec tsc --noEmit && pnpm exec eslint src
git add src/components/FilterBar src/components/ScopeSelector src/pages/Dashboard i18n
git commit -m "$(cat <<'EOF'
Put the dashboard controls in one row of equal-height fields

The organisation unit becomes one of those fields, labelled
"Organisation unit" rather than "Scope" — a label a reviewer first missed
and then found unclear. ScopeSelector is gone; levelFromPath moved with
its tests.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 2: The same bar on the group set page

**Files:**
- Modify: `src/pages/GroupSetDetail/GroupSetDetail.tsx:185-232`, `src/pages/GroupSetDetail/GroupSetDetail.module.css`
- Modify: `src/pages/GroupSetDetail/OverviewTab.tsx:70-95` (the `Rows` selector moves out)
- Test: `src/pages/GroupSetDetail/GroupSetDetail.test.tsx`, `src/pages/GroupSetDetail/OverviewTab.test.tsx`

**Interfaces:**
- Consumes: `FilterBar`, `FilterBarField`, `OrgUnitField` from Task 1.
- Produces: `OverviewTab`'s props lose **`levels` and `onRowLevel`** — the selector they fed now lives in the bar. They **keep `rowLevel`**: `OverviewTab` still needs the chosen level to call `matrixFor` and to build `aboveLevelCaption`. `GroupSetDetail` passes `effectiveRowLevel` into it. So the props after this task are `set`, `scope`, `rowLevel`, `onCell`. Task 6 adds `onDrillDown`.

- [ ] **Step 1: Write the failing tests**

Add to `src/pages/GroupSetDetail/GroupSetDetail.test.tsx`:

```tsx
// Spec 2026-09-15 §4.1: the organisation unit is reachable without leaving
// the group set you are working in — that was the review's complaint.
it('shows the organisation unit field on the group set page', async () => {
    renderDetail({ objectType: 'organisationUnit' })
    expect(await screen.findByText('Organisation unit')).toBeInTheDocument()
})

// A data element group set has no organisation unit scope, and a control
// that changes nothing on screen is worse than no control.
it('hides the organisation unit field for a non-hierarchical type', async () => {
    renderDetail({ objectType: 'dataElement' })
    await screen.findByText('Overview')
    expect(screen.queryByText('Organisation unit')).not.toBeInTheDocument()
})

// The bar shows the organisation unit, so the header tag that repeated it
// is gone.
it('does not repeat the organisation unit as a header tag', async () => {
    renderDetail({ objectType: 'organisationUnit' })
    await screen.findByText('Overview')
    expect(screen.queryByText(/^Scope \(/)).not.toBeInTheDocument()
})
```

Use the file's existing render helper and set fixture in place of `renderDetail()`.

- [ ] **Step 2: Run them to verify they fail**

Run: `pnpm test -- src/pages/GroupSetDetail/GroupSetDetail.test.tsx -t "organisation unit"`
Expected: FAIL on all three.

- [ ] **Step 3: Render the bar, and move the row level selector into it**

In `GroupSetDetail.tsx`, above the header, render:

```tsx
<FilterBar>
    {set.objectType === 'organisationUnit' && <OrgUnitField />}
    {set.objectType === 'organisationUnit' && tab === 'overview' && levels.length > 0 && (
        <FilterBarField label={i18n.t('Rows')}>
            <SingleSelectField
                dense
                selected={String(effectiveRowLevel)}
                onChange={({ selected }) => setRowLevel(Number(selected))}
                inputWidth="240px"
            >
                {levels.map((l) => (
                    <SingleSelectOption
                        key={l.level}
                        value={String(l.level)}
                        label={interpolate(i18n.t('{name} (level {level})'), {
                            name: l.displayName,
                            level: l.level,
                        })}
                    />
                ))}
            </SingleSelectField>
        </FilterBarField>
    )}
</FilterBar>
```

Keep `SingleSelectField`'s own `label` prop off — `FilterBarField` supplies the label, and two labels would render twice. **Match Task 1's height convention**, which is recorded in a comment in `FilterBar.module.css`; the `dense` in the sample above is a placeholder for whatever that convention turned out to be, not an instruction.

**Preserve the existing guard exactly.** `OverviewTab` currently refuses to render the selector when `levels.length === 0`, because `@dhis2/ui`'s `SingleSelect` throws a hard runtime error — not a blank — when `selected` matches no rendered option. The `levels.length > 0` condition above is that same guard; do not drop it. `effectiveRowLevel` (not `rowLevel`) is likewise the synchronously-corrected value that already exists in `GroupSetDetail.tsx` for this reason; keep using it.

- [ ] **Step 4: Remove the selector and the tag from where they were**

- In `OverviewTab.tsx`, delete the `canShowRowLevelSelector` block and the `SingleSelectField` it guards, and drop `rowLevel`, `levels` and `onRowLevel` from `Props`. `OverviewTab` still needs the chosen row level to build `aboveLevelCaption` and to call `matrixFor` — keep receiving it, but as one value; name it `rowLevel` still, and let `GroupSetDetail` pass `effectiveRowLevel`.
- In `GroupSetDetail.tsx`, delete the `<Tag neutral>{interpolate(i18n.t('Scope ({name})'), …)}</Tag>` from the header badges. Leave the compulsory and data dimension tags. The group-names tag is Task 5's, not yours — leave it for now.

- [ ] **Step 5: Run the tests**

Run: `pnpm test -- src/pages/GroupSetDetail`
Expected: PASS, after updating `OverviewTab.test.tsx` for the narrowed props.

- [ ] **Step 6: Extract, gate, commit**

```bash
pnpm exec d2-app-scripts i18n extract
pnpm test && pnpm exec tsc --noEmit && pnpm exec eslint src
git add src/pages/GroupSetDetail i18n
git commit -m "$(cat <<'EOF'
Show the same filter bar on the group set page

The organisation unit is now reachable without leaving the set being
worked on, and the header no longer repeats it as a tag. The row level
selector joins it in the bar, keeping the empty-levels guard that stops
@dhis2/ui's SingleSelect throwing on a selected value with no option.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 3: Right-align the matrix's numeric column headers

**Files:**
- Modify: `src/components/SummaryMatrix/SummaryMatrix.tsx:126-150`, `src/components/SummaryMatrix/SummaryMatrix.module.css`
- Modify: `docs/superpowers/specs/2026-09-15-manual-review-1-design.md` §4.2
- Test: `src/components/SummaryMatrix/SummaryMatrix.test.tsx`

**Interfaces:** consumes nothing, produces nothing. Independent of every other task.

**Read this before writing code — the spec's stated cause is wrong.** Spec §4.2 says the fix is to give the numeric `DataTableColumnHeader`s `align="right"`. **They already have it**, and have since the component was written. The real cause is upstream: in `@dhis2/ui` 10.17.0, `DataTableColumnHeader` turns its `align` prop into

```js
.label { justify-content: ${flexboxAlignLookup[align]}; }
```

(`@dhis2-ui/table/src/data-table/data-table-column-header/data-table-column-header.js:88`) while the element it renders is

```jsx
<span className="container">
  <span className={cx('top', { large })}>
    <span className="content">{children}</span>
```

There is no element with `className="label"` anywhere in that component — `.label` appears exactly once in the whole package, in that generated rule. So `align` is a **silent no-op**: the app asked for right-aligned headers, the library dropped the request, and the headers stayed left over right-aligned numbers. That is the review's "headers and values do not line up".

The flex container that actually needs overriding is `span.top` (`data-table-column-header.styles.js`).

- [ ] **Step 1: Write the failing test**

Add to `src/components/SummaryMatrix/SummaryMatrix.test.tsx`:

```tsx
// @dhis2/ui 10.17.0's DataTableColumnHeader `align` prop is a no-op: it
// emits a rule for a `.label` class the component never renders. Our own
// class on the header is what actually right-aligns it, so the test pins
// the class rather than a computed style jsdom would not resolve anyway.
it('marks every numeric column header as numeric', () => {
    render(<SummaryMatrix result={twoGroupResult} onCell={jest.fn()} />)
    const headers = screen.getAllByRole('columnheader')
    // first column is the row label; every other header is a number
    const [rowLabel, ...numeric] = headers
    expect(rowLabel).not.toHaveClass('numericHeader')
    numeric.forEach((h) => expect(h.className).toMatch(/numericHeader/))
})
```

Use the file's existing result fixture in place of `twoGroupResult`. CSS modules are hashed in this project's Jest config, so match on a substring with `toMatch(/numericHeader/)` rather than `toHaveClass('numericHeader')` for the positive case — check how the file's existing tests assert on module classes and follow that.

- [ ] **Step 2: Run it to verify it fails**

Run: `pnpm test -- src/components/SummaryMatrix/SummaryMatrix.test.tsx -t "numeric column header"`
Expected: FAIL — no such class on any header.

- [ ] **Step 3: Add the class and the override**

In `SummaryMatrix.module.css`:

```css
/* @dhis2/ui 10.17.0's DataTableColumnHeader ignores its own `align` prop:
   it emits `.label { justify-content: … }` for a class the component never
   renders (see data-table-column-header.js). `span.top` is the real flex
   row around the header's content, so that is what has to be pushed to the
   end. `:global` because the class comes from the library, not this
   module, and CSS modules would otherwise rewrite it. Remove this rule if
   @dhis2/ui ever fixes `align`; the `align="right"` props are already in
   place and would take over. */
.numericHeader :global(span.top) {
    justify-content: flex-end;
}
```

In `SummaryMatrix.tsx`, add `className={styles.numericHeader}` to every `DataTableColumnHeader` that carries `align="right"` — the group headers, the unassigned header, Missing, Conflict and Total. Leave the first (`Organisation unit`) header alone. Keep the `align="right"` props.

- [ ] **Step 4: Run the tests**

Run: `pnpm test -- src/components/SummaryMatrix/SummaryMatrix.test.tsx`
Expected: PASS.

- [ ] **Step 5: Correct the spec**

In `docs/superpowers/specs/2026-09-15-manual-review-1-design.md` §4.2, replace the sentence claiming the fix is to add `align="right"` with an accurate one: the props were already there, `@dhis2/ui` 10.17.0 ignores them because the rule it generates targets a class it never renders, and the app overrides `span.top` itself. A spec that misstates a cause will mislead the next reader of it.

- [ ] **Step 6: Gate and commit**

```bash
pnpm test && pnpm exec tsc --noEmit && pnpm exec eslint src
git add src/components/SummaryMatrix docs/superpowers/specs/2026-09-15-manual-review-1-design.md
git commit -m "$(cat <<'EOF'
Right-align the matrix headers over their own numbers

@dhis2/ui 10.17.0's DataTableColumnHeader accepts an `align` prop and then
emits a rule for a `.label` class it never renders, so the headers this
app already asked to right-align stayed left over right-aligned values.
Override the real flex row instead, and correct the spec, which named the
wrong cause.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 4: Cap the matrix's group columns

**Files:**
- Create: `src/components/SummaryMatrix/columnPlan.ts`, `src/components/SummaryMatrix/columnPlan.test.ts`
- Modify: `src/components/SummaryMatrix/SummaryMatrix.tsx`
- Test: `src/components/SummaryMatrix/SummaryMatrix.test.tsx`

**Interfaces:**
- Consumes: `MatrixResult` from `src/engine/store.ts` — `{ rows: (MatrixRow & { row: ObjectRef | null })[]; groups: GroupMeta[] }`, where `MatrixRow.perGroup` is a `number[]` parallel to `groups`.
- Produces, for Task 5:
  ```ts
  export interface GroupTotal { index: number; group: GroupMeta; total: number }
  export interface ColumnPlan {
      /** the shown groups, biggest total first */
      shown: GroupTotal[]
      /** every other group, biggest total first; empty when nothing is capped */
      other: GroupTotal[]
      /** every group ranked, shown and other together — Task 5's panel uses this */
      ranked: GroupTotal[]
  }
  export const MAX_GROUP_COLUMNS = 8
  export function planColumns(
      result: MatrixResult,
      pinned?: number[]
  ): ColumnPlan
  ```
  `pinned` is an optional list of group indexes the user chose through the picker; when given, those are the `shown` set (still ranked) and everything else is `other`.

- [ ] **Step 1: Write the failing test**

Create `src/components/SummaryMatrix/columnPlan.test.ts`:

```ts
import { MAX_GROUP_COLUMNS, planColumns } from './columnPlan'

const g = (n: number) => ({ id: `g${n}`, displayName: `Group ${n}` })

// One row, so a group's total is just its own cell.
const resultWith = (perGroup: number[]) => ({
    groups: perGroup.map((_, i) => g(i)),
    rows: [
        {
            object: 0,
            row: null,
            perGroup,
            missing: 0,
            unassigned: 0,
            conflict: 0,
            total: perGroup.reduce((a, b) => a + b, 0),
        },
    ],
})

describe('planColumns', () => {
    it('shows every group when there are few enough', () => {
        const plan = planColumns(resultWith([5, 1, 3]))
        expect(plan.shown.map((s) => s.index)).toEqual([0, 2, 1])
        expect(plan.other).toEqual([])
    })

    it('caps at MAX_GROUP_COLUMNS, biggest total first', () => {
        const perGroup = Array.from({ length: 12 }, (_, i) => i)
        const plan = planColumns(resultWith(perGroup))
        expect(plan.shown).toHaveLength(MAX_GROUP_COLUMNS)
        expect(plan.shown[0].index).toBe(11)
        expect(plan.other).toHaveLength(12 - MAX_GROUP_COLUMNS)
        // nothing is lost: shown + other is every group, once each
        expect(
            [...plan.shown, ...plan.other].map((s) => s.index).sort((a, b) => a - b)
        ).toEqual(perGroup.map((_, i) => i))
    })

    it('sums a group across every row, not just the first', () => {
        const result = {
            groups: [g(0), g(1)],
            rows: [
                { object: 0, row: null, perGroup: [1, 9], missing: 0, unassigned: 0, conflict: 0, total: 10 },
                { object: 1, row: null, perGroup: [9, 0], missing: 0, unassigned: 0, conflict: 0, total: 9 },
            ],
        }
        const plan = planColumns(result)
        expect(plan.ranked.map((r) => r.total)).toEqual([10, 9])
    })

    it('honours a pinned selection over the ranking', () => {
        const perGroup = Array.from({ length: 12 }, (_, i) => i)
        const plan = planColumns(resultWith(perGroup), [0, 1])
        expect(plan.shown.map((s) => s.index)).toEqual([1, 0])
        expect(plan.other).toHaveLength(10)
    })

    it('ranks every group even when none are capped', () => {
        const plan = planColumns(resultWith([5, 1, 3]))
        expect(plan.ranked.map((r) => r.index)).toEqual([0, 2, 1])
    })
})
```

- [ ] **Step 2: Run it to verify it fails**

Run: `pnpm test -- src/components/SummaryMatrix/columnPlan.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write `columnPlan.ts`**

A pure module — no React, no DHIS2 imports — so it tests as plain Jest:

```ts
import { MatrixResult } from '@/engine/store'
import { GroupMeta } from '@/engine/types'

export interface GroupTotal {
    index: number
    group: GroupMeta
    total: number
}

export interface ColumnPlan {
    shown: GroupTotal[]
    other: GroupTotal[]
    ranked: GroupTotal[]
}

/** Spec 2026-09-15 §4.2. A data element group set can have hundreds of
 * groups, and one column each is not a table. */
export const MAX_GROUP_COLUMNS = 8

/**
 * Ranks a set's groups by how many objects they hold across every row of
 * the matrix, and splits them into the columns to show and the rest.
 *
 * The totals come from `result` itself -- the same numbers already on
 * screen -- so the ranking costs no query and the groups panel (which
 * shares this plan) can never disagree with the matrix.
 *
 * `pinned` is the user's explicit choice from the picker: those groups
 * become `shown`, still ranked among themselves, and everything else is
 * `other`. An unknown index in `pinned` is ignored rather than throwing --
 * it can only come from a stale choice, and dropping a column is a better
 * failure than a blank screen.
 */
export function planColumns(
    result: MatrixResult,
    pinned?: number[]
): ColumnPlan {
    const ranked: GroupTotal[] = result.groups
        .map((group, index) => ({
            index,
            group,
            total: result.rows.reduce((sum, r) => sum + r.perGroup[index], 0),
        }))
        // Descending by total, then by index: a tie must not depend on how
        // Array.prototype.sort happens to order equal keys, or the columns
        // would reshuffle between renders of the same data.
        .sort((a, b) => b.total - a.total || a.index - b.index)

    if (pinned) {
        const keep = new Set(pinned)
        return {
            shown: ranked.filter((g) => keep.has(g.index)),
            other: ranked.filter((g) => !keep.has(g.index)),
            ranked,
        }
    }
    return {
        shown: ranked.slice(0, MAX_GROUP_COLUMNS),
        other: ranked.slice(MAX_GROUP_COLUMNS),
        ranked,
    }
}
```

- [ ] **Step 4: Run it, then wire the matrix to it**

`SummaryMatrix` gains:
- `const plan = useMemo(() => planColumns(result, pinnedGroups), [result, pinnedGroups])`
- group headers and cells rendered from `plan.shown` rather than from `result.groups`, keeping each `GroupTotal.index` as the `MatrixColumn` index so `onCell`'s existing `{ kind: 'group', index }` filter still points at the right group.
- when `plan.other.length > 0`, one extra column headed `i18n.t('Other groups')`, whose cell value is the row's summed `perGroup` over `plan.other`.

**The Other groups cell opens the picker, it does not filter.** Per spec §4.2, a list of "objects in some of 192 groups" answers no question, and `ObjectFilter.group` is a single index that cannot express it. That cell's `onClick` opens `SummaryMatrix`'s own picker (Step 5) — it must **not** be routed through `onCell`, and `MatrixColumn` must **not** gain an `otherGroups` kind, because nothing downstream could consume one. `SummaryMatrix` needs no new prop for this: the picker is entirely its own state.

- [ ] **Step 5: Add the picker**

A `Modal` owned by `SummaryMatrix`, listing every group from `plan.ranked` with its total, each a checkbox, capped at `MAX_GROUP_COLUMNS` selections. Confirm sets `pinnedGroups`; a Reset button clears it back to `undefined`, meaning "use the ranking".

```tsx
// Spec §4.2: an explicit choice persists while the user stays on that set
// and is dropped on leaving it.
//
// The reset key must be the group IDENTITIES, not the `result.groups`
// array's object identity. `MatrixResult` crosses the Web Worker boundary
// through postMessage, so it is structured-cloned: every response carries a
// brand-new `groups` array even for an identical repeat query. And
// `useEngineQuery` re-issues its call on every `status.phase`/`status.type`
// change, which fires several times during the app's normal per-type
// progressive load and again on an explicit reload. Keying on the array
// object would therefore wipe the user's pinned columns mid-load, or on a
// reload, rather than only when they leave the set.
const groupKey = result.groups.map((g) => g.id).join(',')
const [pinnedGroups, setPinnedGroups] = useState<number[] | undefined>(
    undefined
)
const [pickerOpen, setPickerOpen] = useState(false)
useEffect(() => {
    setPinnedGroups(undefined)
}, [groupKey])
```

- [ ] **Step 6: Test the matrix's own behaviour**

Add to `SummaryMatrix.test.tsx`: a set with 12 groups renders 8 group columns plus `Other groups`; the `Other groups` cell holds the sum of the four hidden groups for that row; clicking a shown group's cell still calls `onCell` with that group's original index (not its rank); clicking `Other groups` calls `onPickGroups` and never `onCell`.

- [ ] **Step 7: Extract, gate, commit**

```bash
pnpm exec d2-app-scripts i18n extract
pnpm test && pnpm exec tsc --noEmit && pnpm exec eslint src
git add src/components/SummaryMatrix i18n
git commit -m "$(cat <<'EOF'
Cap the matrix at eight group columns, with the rest behind a picker

A data element group set can have hundreds of groups, and one column each
is not a table. The eight biggest by total membership are shown, the rest
are summed into an Other groups column, and a picker changes which eight.
The Other groups column opens that picker rather than filtering: the
engine's filter takes one group index, and a list of objects across 192
groups answers nothing.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 5: "Groups in this set"

**Files:**
- Create: `src/components/GroupsPanel/GroupsPanel.tsx`, `src/components/GroupsPanel/GroupsPanel.module.css`, `src/components/GroupsPanel/GroupsPanel.test.tsx`
- Modify: `src/pages/GroupSetDetail/OverviewTab.tsx`, `src/pages/GroupSetDetail/GroupSetDetail.tsx` (the header tag)
- Test: `src/pages/GroupSetDetail/GroupSetDetail.test.tsx`

**Interfaces:**
- Consumes: `planColumns` and `ColumnPlan` from Task 4.
- Produces: `GroupsPanel: (props: { plan: ColumnPlan; total: number }) => JSX.Element`.

**What it replaces:** the header currently renders every group name joined with `·` inside one `<Tag neutral>`. With EMIS-scale sets that tag overflows the header, and it reads as a list of things one object is in when an object is in exactly one of them.

- [ ] **Step 1: Write the failing test**

`GroupsPanel.test.tsx` should pin: the eight biggest groups render with their counts; a ninth does not, until `Show all N groups` is activated; the filter input narrows the expanded list by name; and the counts shown are the ones passed in, not recomputed.

Use the count strings `i18n.t('1 object')` / `interpolate(i18n.t('{count} objects'), …)` — this project already has both, so reuse them rather than adding new keys.

- [ ] **Step 2: Run it to verify it fails**

Run: `pnpm test -- src/components/GroupsPanel/GroupsPanel.test.tsx`
Expected: FAIL — module not found.

- [ ] **Step 3: Write the panel**

```tsx
import i18n from '@dhis2/d2-i18n'
import { Button, Input } from '@dhis2/ui'
import React, { useMemo, useState } from 'react'
import styles from './GroupsPanel.module.css'
import { ColumnPlan, MAX_GROUP_COLUMNS } from '@/components/SummaryMatrix/columnPlan'
import { interpolate } from '@/utils/interpolate'

// Two complete strings chosen on the count, never a number glued to a
// translated word -- see CLAUDE.md's "Translatable strings".
const objectsLabel = (count: number) =>
    count === 1
        ? i18n.t('1 object')
        : interpolate(i18n.t('{count} objects'), {
              count: count.toLocaleString(),
          })

const showAllLabel = (count: number) =>
    count === 1
        ? i18n.t('Show 1 group')
        : interpolate(i18n.t('Show all {count} groups'), {
              count: count.toLocaleString(),
          })

/**
 * Spec 2026-09-15 §4.4. Takes the plan and the population total and
 * renders them -- it derives nothing and issues no query of its own, so
 * this panel and the matrix beside it cannot disagree about a number.
 */
export const GroupsPanel = ({
    plan,
    total,
}: {
    plan: ColumnPlan
    total: number
}) => {
    const [expanded, setExpanded] = useState(false)
    const [filter, setFilter] = useState('')
    const rows = useMemo(() => {
        if (!expanded) {
            return plan.ranked.slice(0, MAX_GROUP_COLUMNS)
        }
        const needle = filter.trim().toLowerCase()
        return needle
            ? plan.ranked.filter((g) =>
                  g.group.displayName.toLowerCase().includes(needle)
              )
            : plan.ranked
    }, [plan.ranked, expanded, filter])

    return (
        <section className={styles.panel}>
            <h3 className={styles.heading}>{i18n.t('Groups in this set')}</h3>
            {expanded && plan.ranked.length > MAX_GROUP_COLUMNS && (
                <Input
                    dense
                    value={filter}
                    placeholder={i18n.t('Filter groups by name')}
                    onChange={({ value }) => setFilter(value ?? '')}
                />
            )}
            {/* max-height in the CSS, so a 400-group set cannot push the
                matrix off the page */}
            <ul className={expanded ? styles.listExpanded : styles.list}>
                {rows.map((g) => (
                    <li key={g.group.id} className={styles.row}>
                        <span className={styles.name}>
                            {g.group.displayName}
                        </span>
                        <span className={styles.count}>
                            {objectsLabel(g.total)}
                        </span>
                        <span className={styles.bar}>
                            <i
                                style={{
                                    width: `${total > 0 ? (g.total / total) * 100 : 0}%`,
                                }}
                            />
                        </span>
                    </li>
                ))}
            </ul>
            {plan.ranked.length > MAX_GROUP_COLUMNS && (
                <Button small onClick={() => setExpanded((v) => !v)}>
                    {expanded
                        ? i18n.t('Show fewer groups')
                        : showAllLabel(plan.ranked.length)}
                </Button>
            )}
        </section>
    )
}
```

Write `GroupsPanel.module.css` to match: `.list` unconstrained, `.listExpanded` with `max-height: 320px; overflow-y: auto`, `.row` a three-column grid, `.bar` a track with `i` as the fill.

- [ ] **Step 4: Mount it and replace the tag**

- In `OverviewTab.tsx`, compute the plan and the total once and pass the same plan object to both the panel and `SummaryMatrix`, so there is literally one ranking:

```tsx
const plan = useMemo(() => (data ? planColumns(data) : null), [data])
const populationTotal = useMemo(
    () => (data ? data.rows.reduce((s, r) => s + r.total, 0) : 0),
    [data]
)
// …then, where the matrix renders:
{plan && <GroupsPanel plan={plan} total={populationTotal} />}
```

  Note `SummaryMatrix` owns its own `pinnedGroups` state (Task 4), so it must still call `planColumns` itself with that state applied. Passing the unpinned plan to the panel is correct and deliberate: the panel always lists every group ranked, whatever subset the matrix is currently showing as columns.
- In `GroupSetDetail.tsx`, replace the group-names `<Tag neutral>` with a count chip: `1 group` / `{count} groups`. `GroupSetCard.tsx` already has exactly these two strings and the comment explaining why they are two argument-free calls — reuse the same strings.

- [ ] **Step 5: Test the header change**

Add to `GroupSetDetail.test.tsx`: a set with four groups shows a `4 groups` chip and does **not** render the four names joined in the header.

- [ ] **Step 6: Extract, gate, commit**

```bash
pnpm exec d2-app-scripts i18n extract
pnpm test && pnpm exec tsc --noEmit && pnpm exec eslint src
git add src/components/GroupsPanel src/pages/GroupSetDetail i18n
git commit -m "$(cat <<'EOF'
Replace the header's group-name tag with a panel that scales

The tag listed every group name in the header, which overflows on a large
set and reads as a list of things one object is in. The Overview tab now
carries the distribution — eight biggest with counts and shares, the rest
behind Show all — derived from the matrix totals already on screen so the
two cannot disagree.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 6: Drill down from a row label

**Files:**
- Modify: `src/components/SummaryMatrix/SummaryMatrix.tsx`, `src/pages/GroupSetDetail/OverviewTab.tsx`, `src/pages/GroupSetDetail/GroupSetDetail.tsx`
- Test: `src/components/SummaryMatrix/SummaryMatrix.test.tsx`, `src/pages/GroupSetDetail/GroupSetDetail.test.tsx`

**Interfaces:**
- Consumes: `useScope().setRoot(id, name, level)` from Task 1's field; `effectiveRowLevel` / `setRowLevel` already in `GroupSetDetail.tsx`.
- Produces: `SummaryMatrix` gains `onDrillDown?: (row: ObjectRef) => void`. When absent, row labels are plain text — that is the flat-type case.

**The review's complaint:** "rows should be clickable to drill down. This was intended in v1 but does not appear to work for orgunits, only groups." Numeric cells already open the Objects tab; the row label does nothing.

- [ ] **Step 1: Write the failing test**

In `GroupSetDetail.test.tsx`, pin the whole behaviour at the level that matters — clicking a chiefdom row label sets the scope to that chiefdom and moves the row level one deeper:

```tsx
it('drills into a row, moving the scope and the row level down together', async () => {
    renderDetail({ objectType: 'organisationUnit' })
    fireEvent.click(await screen.findByRole('button', { name: 'Badjia' }))
    expect(mockSetRoot).toHaveBeenCalledWith('ou-badjia', 'Badjia', 4)
    // the Rows field follows the scope down
    expect(await screen.findByText('Facility (level 5)')).toBeInTheDocument()
})
```

Match the fixture's own ids, names and level list.

- [ ] **Step 2: Run it to verify it fails**

Expected: FAIL — the row label is not a button.

- [ ] **Step 3: Make the row label a control when drilling is possible**

In `SummaryMatrix`, when `onDrillDown` is given and `r.row` is non-null, render the label as a `<button>` calling `onDrillDown(r.row)`. Otherwise render today's plain text. The "Above the row level" pseudo-row (`r.row === null && !flat`) is never drillable — it stands for objects with no single ancestor, exactly as it is already not clickable for filtering.

- [ ] **Step 4: Wire it up**

`GroupSetDetail` passes an `onDrillDown` that calls `setRoot(row.id, row.displayName ?? row.id, rowLevelOfThatRow)` and `setRowLevel(next)` where `next` is the next level in `levels` below the row's own. Pass it through `OverviewTab` only for `organisationUnit` sets.

**The level to pass to `setRoot` is the row's own level, which is the current `effectiveRowLevel`** — every row in the matrix sits at that level by construction. Do not re-derive it from a path; the matrix rows carry no path.

**The way back is the bar's own organisation unit field**, which now shows the chiefdom. No separate breadcrumb is needed for this task; if you find the field alone is not enough to get back, say so in your report rather than inventing navigation the spec does not describe.

- [ ] **Step 5: Run the tests, extract, gate, commit**

```bash
pnpm exec d2-app-scripts i18n extract
pnpm test && pnpm exec tsc --noEmit && pnpm exec eslint src
git add src/components/SummaryMatrix src/pages/GroupSetDetail i18n
git commit -m "$(cat <<'EOF'
Drill into a matrix row by clicking its label

The row label was inert: numbers opened the filtered object list, but
going a level deeper in the summary was not possible, which the review
reported as drill-down working for groups but not for organisation units.
Clicking a row now moves the organisation unit and the row level down
together.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 7: Make the DHIS2 integrity check visible

**Files:**
- Modify: `src/pages/GroupSetDetail/GroupSetDetail.tsx` (header actions)
- Test: `src/pages/GroupSetDetail/GroupSetDetail.test.tsx`

**Interfaces:** consumes `useIntegrity()` → `{ available, … }`, already used by this file to gate the tab.

**The complaint:** "Make the existing button that triggers integrity checks discoverable. A reviewer missed it entirely." The feature lives behind a tab that is itself easy to miss.

- [ ] **Step 1: Write the failing test**

```tsx
it('offers the integrity check from the header when it is available', async () => {
    renderDetail({ integrityAvailable: true })
    const button = await screen.findByRole('button', {
        name: 'Run DHIS2 integrity checks',
    })
    fireEvent.click(button)
    // it takes the user to the tab that runs them
    expect(await screen.findByRole('tab', { selected: true })).toHaveTextContent(
        'DHIS2 integrity'
    )
})

it('offers nothing when the user may not read integrity results', async () => {
    renderDetail({ integrityAvailable: false })
    await screen.findByText('Overview')
    expect(
        screen.queryByRole('button', { name: 'Run DHIS2 integrity checks' })
    ).not.toBeInTheDocument()
})
```

Match the file's render helper and its `useIntegrity` mock.

- [ ] **Step 2: Run them to verify they fail**

Expected: FAIL — no such button.

- [ ] **Step 3: Add the button**

In the header's `styles.actions` strip, next to `Set properties…`, add a button rendered only when `integrity.available`, whose `onClick` is `setTab('integrity')`.

**It switches to the tab; it does not run anything itself.** Spec §4.5 keeps the overlay read-only and gated on the maintenance authority, and the tab already owns running the checks and showing their results. A second code path that ran them would duplicate that and could drift from it.

- [ ] **Step 4: Run, gate, extract, commit**

```bash
pnpm exec d2-app-scripts i18n extract
pnpm test && pnpm exec tsc --noEmit && pnpm exec eslint src
git add src/pages/GroupSetDetail i18n
git commit -m "$(cat <<'EOF'
Surface the DHIS2 integrity check in the header

A reviewer missed the feature entirely because it was only reachable by
noticing a tab. The button switches to that tab rather than running the
checks itself, so there is still one code path that runs them.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 8: Close the e2e coverage gap

**Files:**
- Modify: `e2e/flows.spec.ts`
- Create: nothing

**Interfaces:** consumes the suite's existing `appRoot`, `APP_PATH`, `expect` and `test` from `e2e/fixtures/session.ts`.

**Background:** the September review recorded that `e2e/flows.spec.ts` never drives the DHIS2 integrity overlay, and never asserts on text search as a feature — search is used incidentally inside other flows, as a way to locate a row. This plan touches both areas, so the net goes in.

The suite runs against **live broker instances**, and installs the app as a built zip rather than serving it from the dev server (see the long comment in `session.ts` — the dev server and its proxy are two different origins and the instances send no CORS headers). Both instances are stopped; the `dhis2-instances` skill has the broker API.

- [ ] **Step 1: Start the instances and confirm the existing suite is green before you add to it**

Start `agent-gsi-p2` (2.43.1) and `agent-gsi-p2-40` (2.40.12) through the broker, build and install the app on each as the suite's fixture expects, then run the existing suite on both. **If it is already red, stop and report that** — adding tests to a failing suite tells you nothing.

- [ ] **Step 2: Write the integrity flow**

Open a group set, click the header's `Run DHIS2 integrity checks` button (Task 7), assert the integrity tab is selected and that a check result renders. The checks resolve **by name at runtime, never by code** — neither a check's name nor its code is stable across 2.40 to 2.43, and `OUVEGS` names a different check on the two versions. So assert on the presence of a result for a named check the app itself resolved, not on a hardcoded code.

Gate the whole flow on the integrity feature being available for the session's user; skip with a reason if it is not, rather than failing.

- [ ] **Step 3: Write the search flow**

Assert search as a feature in its own right, which means asserting the things the incidental uses never do:

- a term matching an object **not on the first loaded page** still finds it — this is what "search is a predicate on the engine's own filter over the whole population, not a component concern" actually buys, and a component-level filter would pass every incidental use while failing this one;
- clearing the term restores the unfiltered count;
- a term matching nothing shows the empty state rather than a stale list.

The input is debounced 300ms before it reaches the filter; wait for the result, do not assert synchronously after typing.

- [ ] **Step 4: Run both new flows on both versions**

Run the full suite on 2.43.1 and on 2.40.12. Every write the suite makes must be reverted through the app's own History before the test ends — that rule is in the fixture's own comment and applies to anything you add.

- [ ] **Step 5: Stop the instances**

Both were stopped before you started; leave them stopped.

- [ ] **Step 6: Commit**

```bash
git add e2e/flows.spec.ts
git commit -m "$(cat <<'EOF'
Cover the integrity tab and text search in the e2e suite

Both were driven only incidentally or not at all, so the two features this
plan touches had no regression net. Search is asserted on a term that
matches an object beyond the first loaded page, which is the property a
component-level filter would fail and the engine-level one provides.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
EOF
)"
```

---

## Done when

- One organisation unit control exists, labelled `Organisation unit`, rendered on the dashboard and on any org-unit group set page; `ScopeSelector` is gone and `grep -rn "Scope (" src` returns nothing.
- The matrix's numeric headers sit over their own numbers, and the spec records why the library's own `align` prop could not do it.
- A set with more than eight groups renders eight columns, an `Other groups` column, and a picker; the groups panel and the matrix share one ranking.
- A row label drills down; the organisation unit field follows.
- `Run DHIS2 integrity checks` is in the header whenever the feature is available.
- `e2e/flows.spec.ts` drives the integrity tab and asserts search as a feature, green on 2.43.1 and 2.40.12.
- `pnpm test`, `pnpm exec tsc --noEmit` and `pnpm exec eslint src` all pass.
