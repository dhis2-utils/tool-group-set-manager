# Manual review round 1

## 1. Remove the per-group-set "compulsory at orgunit level" setting

Hide the option that lets the app define a "compulsory at orgunit level" setting per orgunit group set.

Rationale: level-based compulsoriness and group set completeness are two separate concerns. The data entry API is permissive, so data can arrive at level 3 even when group assignment was only enforced at level 4. The rule "every orgunit belongs to exactly one group in each group set" is easier to explain than partial group sets, and the integrity checks flag partial sets regardless.

Replace it with guidance and bulk actions that complete the set, using a catch-all group (for example "Not a facility") for orgunits the group set does not really describe.

Constraint: the catch-all group must be unique per group set. Do not create one shared "Other" group and reuse it across several group sets. Where the app creates or suggests a catch-all group, name it per group set.

## 2. Add group set usage data, and show it before offering fixes

Goal: let the user see which group sets are actually used before deciding which ones to fix or delete.

- Install an SQL view that counts, per group set, how many saved analytics objects reference it as a dimension. Model it on the category dimension disabler app (github.com/dhis2/tool-category-dimension-disabler, see src/app.js), which already does this for categories, and extend to the other dimension types. Relevant tables include eventvisualization_orgunitgroupsetdimensions; check for the equivalent tables for visualization, eventReport, eventChart and map for both orgunit group sets and other group set types. Note that table names might differ per dhis2 version. Line listing and new EVER app favorites must also be considered.
- Follow the disabler app's pattern for the view: create it from the app, offer a button to remove it, set it public read.
- Rank group sets by usage in the Overview, and flag ones with zero references as candidates for disabling as data dimension or deletion.
- Label these numbers as indicative. Data view counts derive only from favorites, so they are a hint that a group set is unused, not proof. Do not phrase the UI as if unused is certain.
- The app already lets the user disable a dimension manually but gives no basis for deciding. This usage data is that basis.
- Result could be shown in a new tab in the “details” view for a group set alongside overview, objects etc.

## 3. Orgunit filtering and scope

- Add an orgunit tree filter to the Objects tab, alongside the existing group membership, level and free text filters.
- Align that filter with the orgunit scope set on the front page, so the two do not conflict.
- Make the scope selector reachable without leaving the group set you are working in. Either keep it visible on all pages, or add a scope filter inside the group set details view.
- Rename the scope control. In testing, a reviewer did not find it, and then found the terminology unclear.
- Check whether rows in the results table should be clickable to drill down. This was intended in v1 but does not appear to work for orgunits, only groups

## 4. Fix issues page

The current options are too coarse, for example "Move all with conflicts/missing assignment to other", with no way to narrow the target set.

Let the user filter the table first, then apply the fix only to the rows matching the filter. Show the number of affected orgunits before the user confirms. This option migth this be better placed as one of the actions/selectors linked to the content tables. Option for adding “other/unknown” group should allow customising the name.

## 5. Layout and components

- Fix alignment of column headers and values in the Overview tab of results. Headers and values do not line up, so it is hard to see what belongs where.
- Fix the selectors on the dashboard: alignment is poor and heights differ (the Scope label sits left of the orgunit dropdown while other labels sit above). One option is a single row of selectors across the top of the page, as in the Capture app.
- Rework the "Groups in this set" component. It will not hold up with many groups, and a user normally expects to see one group per orgunit.
- Make the existing button that triggers integrity checks discoverable. A reviewer missed it entirely.

## 6. Still to verify

Full review against v40 to v43 with different databases.


#§agent_edit