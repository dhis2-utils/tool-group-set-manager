# Changelog

All notable changes to the Group Set Integrity Tool are recorded here. The
format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and
the project uses [Semantic Versioning](https://semver.org/).

## [Unreleased]

### Upgrading

- The app key changes from `group-set-integrity-tool` to
  `tool-group-set-manager`, to match the repository name. DHIS2 treats this
  release as a different app:
    - Install the new version, then uninstall the old Group Set Integrity Tool
      in App Management, or two entries remain in the menu.
    - Add the new app to every user role that gave access to the old one. Until
      then, users without the `ALL` authority cannot open it.
    - Bookmarks to the old app URL stop working.
- History, settings and the `GSI_*` SQL views are kept: they are stored on
  the server under names that do not depend on the app key.

### Changed

- History offers **Revert** only for changes made in the last 24 hours. Older
  changes stay listed and can still be exported.

### Fixed

- The group dropdown in the objects table is wide enough to read when no
  group is selected.

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
