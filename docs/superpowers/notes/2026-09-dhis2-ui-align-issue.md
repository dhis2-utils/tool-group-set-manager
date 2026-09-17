# Upstream report: `DataTableColumnHeader` ignores `align` (@dhis2/ui)

Status: drafted 2026-09-17; to be filed by the maintainer from the host
(the sandbox token cannot create issues). Once filed, put the URL here and
close the item in OPEN-ITEMS.md.

Checked before drafting: latest published @dhis2/ui is 10.17.0 (same as
this app's installed version); the component's master source at
`20e343fc9e34570dcd8678ddb449d48c5b62a140` still emits the
`.label` rule against a tree of `span.container > span.top > span.content`.
Existing issues searched: none found (GitHub code search for
`DataTableColumnHeader align` in dhis2/ui turned up only two unrelated
closed PRs -- #922 "feat(data-table): configurable sort icon button title"
and #463 "feat: introduce (data) table and related components" -- neither
is a report of this defect).

## Title

DataTableColumnHeader: the `align` prop has no effect

## Body

**Version:** @dhis2/ui 10.17.0 (also checked master at
`20e343fc9e34570dcd8678ddb449d48c5b62a140`).

**What happens:** `<DataTableColumnHeader align="right">` renders exactly
like `align="left"`. The component turns `align` into a styled-jsx rule for
a `.label` class, but the element it renders is
`span.container > span.top > span.content`, and `.label` appears nowhere in
the rendered tree. `.label` occurs exactly once in the whole package -- in
the rule the component generates.

**Effect:** every numeric column in a `DataTable` has a left-aligned header
over right-aligned cells. On a wide table the header sits nowhere near its
own numbers once any header text is long.

**Reproduction:**

```jsx
<DataTable>
  <DataTableHead>
    <DataTableRow>
      <DataTableColumnHeader align="right">Total</DataTableColumnHeader>
    </DataTableRow>
  </DataTableHead>
  <DataTableBody>
    <DataTableRow>
      <DataTableCell align="right">1,234</DataTableCell>
    </DataTableRow>
  </DataTableBody>
</DataTable>
```

Inspect the header: `span.top` has `justify-content: flex-start` (or no
justification), and no element carries the `.label` class the generated
`<style>` targets.

**Workaround used:** a consumer-side rule on the real flex container,
`.numericHeader :global(span.top) { justify-content: flex-end }`, with the
`align="right"` props left in place so the library's fix takes over when it
lands. (This app's copy lives in
`src/components/SummaryMatrix/SummaryMatrix.module.css`.)

**Suggested fix:** target the rule at `.top` (the actual flex container) or
render the `.label` element the rule expects.
