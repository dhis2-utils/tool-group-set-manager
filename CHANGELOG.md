# Changelog

All notable changes to the Group Set Integrity Tool are recorded here. The
format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and
the project uses [Semantic Versioning](https://semver.org/).

## [1.1.0] - 2026-11-03

### Upgrading

- The app key changes from `group-set-integrity-tool` to
  `tool-group-set-manager`, to match the repository name. DHIS2 treats this
  release as a different app:
    - Install the new version, then uninstall the old Group Set Integrity Tool
      in App Management, or two entries remain in the menu.
    - Add the new app (authority `M_toolgroupsetmanager`) to every user role
      that gave access to the old one. Until then, users without the `ALL`
      authority cannot open it.
    - Bookmarks to the old app URL stop working.
- History, settings and the `GSI_*` SQL views are kept: they are stored on
  the server under names that do not depend on the app key.

### Added

- Settings, **Who can read the SQL views**: share the SQL views with every
  logged-in user (the default) or only with the members of one user group.
  Users outside the group load their data through the metadata API and see no
  usage figures. Administrators outside the group see the status **Not shared
  with you**.
- History records changes to **Compulsory** and **Data dimension** made in the
  group set properties dialog, and can revert them for 24 hours. A property
  that was changed again since is left as it is. The History export has three
  new columns: `property`, `oldValue` and `newValue`.
- History shows a write that was interrupted, for example by a closed tab, as
  **Interrupted or still running**, with the number of confirmed changes. The
  confirmed changes can be reverted.
- History shows in text why a change cannot be reverted: it is older than 24
  hours, the group set no longer exists, the group sets could not be loaded,
  or nothing was confirmed before the change stopped.
- Unknown addresses and unexpected errors show a page with a link back to the
  dashboard. A link to a deleted group set shows **This group set does not
  exist, or you cannot see it.**
- Settings shows a note when the stored catch-all group no longer exists in
  its set.

### Changed

- History offers **Revert** only for changes made in the last 24 hours. Older
  changes stay listed and can still be exported.
- Every bulk fix and every revert checks the groups that it changes on the
  server before it writes. If anything changed, the tool updates the plan and
  asks you to confirm again.
- **Create SQL views** puts a view that was changed by hand back to its
  definition: type, query and sharing. A materialized view becomes a query
  view. When a repair fails, the message says why and what to do.
- **Remove usage SQL view** needs the `ALL` or `F_SQLVIEW_DELETE` authority.
- The tracker setting is now labeled **Include tracker data elements when
  checking data element group sets**, which is what it does.
- The catch-all group of each group set is stored under its own key, so two
  administrators who save different sets at the same time no longer erase
  each other's choice. Choices saved by version 1.0.0 are still read.
- The browser cache is kept per user and per language.
- The **Groups in this set** list says **objects only in this group**.
- Errors when you create a catch-all group or change group set properties are
  full sentences, and say which of the name, short name or code is already
  in use.
- The **DHIS2 integrity** tab shows the check for missing compulsory group
  sets only on compulsory sets. A check that does not finish in time says
  that the server can still be running it.
- The **Usage** tab says **Usage data is not available to you** when the
  usage view is not installed or not shared with you.

### Fixed

- The group list in the objects table is wide enough to read when no
  group is selected.
- A failed or short addition no longer leaves an object in no group. The
  removal from the old group waits until the addition is confirmed, and
  **Retry failed changes** sends it.
- When the server accepts a batch only in part, the confirmed part is
  recorded in History and can be reverted. Retry sends only the rest.
- A group set with no groups no longer shows **Loading…**. Cards of an object
  type that failed to load say **This group set could not be loaded**.
- The counts and the overview update after a change without a reload.
- The objects table scrolls sideways in a narrow window, and shows **No
  objects match this filter.** when nothing matches.
- Matrix cells and group set cards work with the keyboard, and the filter
  fields have labels for screen readers.
- The tool checks the header row of a SQL view before it reads it, and uses
  the metadata API if the columns differ.

### Security

- CSV exports start a value that begins with `=`, `+`, `-`, `@`, a tab or a
  carriage return with a single quote, so that a spreadsheet does not run it
  as a formula.
- Administrators can limit who reads the SQL views, which list the members of
  every organisation unit group and the usage of every favourite, to one user
  group.

## [1.0.0] - 2026-09-22

First release.

### Added

- Dashboard of every organisation unit, data element, indicator and category
  option group set, with conflict, missing and OK counts per set, filtered by
  organisation unit scope, object type, issues-only and sort order.
- Group set page with an overview matrix by organisation unit level (drill
  down by row), a paged and searchable objects table with in-place group
  assignment, a usage tab, and a DHIS2 integrity tab that runs the server's
  own checks read-only.
- Bulk fix: assign a filtered population to one group, with a preview, a
  stale-read guard and a catch-all group option.
- History of every change made through the app, with revert.
- Fast data path through three `GSI_*` SQL views, installed and repaired from
  Settings, falling back to the metadata API when they are absent; an
  optional usage SQL view counting the favourites that reference each set.
- Settings for the SQL views, the catch-all group per set, tracker data
  inclusion and the local cache.
- Supports DHIS2 2.40 to 2.43.
