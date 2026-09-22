# Changelog

All notable changes to the Group Set Integrity Tool are recorded here. The
format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and
the project uses [Semantic Versioning](https://semver.org/).

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
