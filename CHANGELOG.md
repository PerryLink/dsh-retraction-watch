# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project
adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

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
- 20 tests; manual sample table in the README.

### Notes

- Retraction Watch ingestion is out of scope in v0.1 (licence/coverage review
  required first).
- No scheduler: the caller decides when to poll.
