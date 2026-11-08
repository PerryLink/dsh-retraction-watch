# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project
adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Fixed

- Re-checking the same Crossref answers no longer fails with `STORE_ERROR`:
  evidence identity includes the checks and retrieval times come from the
  immutable snapshots, so unchanged answers dedupe.
- The first observation of a DOI is no longer reported as `changed: true`:
  `changed` now requires a recorded previous status that differs, matching the
  tool description.
- A transient update-query 5xx was cached for the full TTL and replayed as
  `unknown`; only 2xx/3xx answers are cached now.
- `mailto` was documented as the Crossref polite-pool contact but never sent.
  It is now added to both Crossref requests and stripped from cached/stored
  URLs so the address does not leak into evidence.
- `package.json#author` said `dsh-statcheck contributors`.

## [0.1.0] - 2026-11-08

First release: retraction and correction monitoring.

### Added

- `retraction_check`: per-DOI status from two **verified** Crossref queries
  (`/works/{doi}` and `/works?filter=updates:{doi}`), with notice DOIs,
  expression-of-concern/correction distinction, and REP evidence holding both
  provider responses.
- `retraction_watch`: bounded-concurrency bibliography check with an
  append-only timeline and change detection (`clear → retracted`).
- `retraction_report`: Markdown + SARIF 2.1.0.
- `clear` carries an explicit absence-of-evidence caveat; `unknown` is never
  collapsed into `clear`; a failed update query is a `skipped` check.
- Bounded HTTP client (allowlist, manual redirect re-validation, timeout,
  interval, retry) with an injectable fetch for offline tests.
- 23 tests; manual sample table in the README.

### Notes

- Retraction Watch ingestion is out of scope in v0.1 (licence/coverage review
  required first).
- No scheduler: the caller decides when to poll.
