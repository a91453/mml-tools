# Import Record — back number〈瞬き〉 (`back-number-mabataki`)

This file was added when the portable package was imported into `a91453/mml-tools`.
It records where the package came from, what was verified at import time, and what
was **not** re-run. It adds no Canonical rule and grants the package no authority.

## Source branches reconciled

Two remote branches carried this package; both were created on 2026-09-14 from
the same base (`d47f64c`) and were compared file by file before import.

| Branch | Head | Commit | Result |
| --- | --- | --- | --- |
| `import/song-reference-back-number-mabataki-20260914` | `191b808` | `chore(song-reference): stage back number Mabataki package` | **Imported.** Detailed `song-context.json` (`1.0-portable-staging-index`, 132 lines) and a staging manifest keyed by Git blob SHA-1. |
| `import/song-reference-back-number-mabataki-20260914-clean` | `38582bd` | `import: add back number Mabataki song reference package` | Not imported. Identical for 9 of 11 files; its `song-context.json` is a minified transport index (2800 bytes) that drops `provenance_class` / `claim_type`, per-item feedback quotes and dates, unresolved-item descriptions, reusable-insight statements and scope limits, and the Canonical read-only/authority notes. Its manifest (`1.0-portable-git-index`, SHA-256 keyed) only described that reduced file. |

Neither branch contained source audio, MIDI, score or any other prohibited
binary, so `-clean` removed nothing that needed removing; it only lost metadata.
The un-normalized full `song-context.json` referenced by SHA-256
`00ab62147098886a7c2cf299dea3b8ca1b5aba5e2ad2f1ce77aa26c4270fe008` was in
neither branch and is not available.

Every file except `package-manifest.json` is byte-identical to the imported
branch (Git blob SHA-1s unchanged). `package-manifest.json` was regenerated to
list this file, to carry SHA-256 and byte length alongside the blob SHA-1, and
to record the import provenance below. `song-context.json` still says
`package_status: READY_FOR_GIT_IMPORT`; that is its export-time state and was
left as recorded.

## Published Canonical at import

Loaded from Published `main` per `docs/CANONICAL_MANIFEST.md`:

| Identity | Value |
| --- | --- |
| Published `main` HEAD at verification | `95c774e19d057d9834318e7652b4f796e4ce2031` (the branch base; `ae6b759` was verified first, then re-verified after PR #30 merged) |
| Manifest commit | `5e7666b850a37f1c85ee2dd8cd0f4fac037a9e14` |
| `rules_snapshot_sha` | `0a172900a01fdf39c2e9e84cf176961320b779ea` |
| `canonical_version` / `canonical_status` / `manifest_version` | `2026-09-13-v1` / `PUBLISHED` / `2026-09-13-v1-manifest1` |

The package's own `canonical_context` (recorded at export against `main`
`d47f64c`) names the same Manifest commit and rules snapshot, so the release the
package was validated under is the release published at import. The recorded
gate results were **not** re-run and keep their `HISTORICAL_RECORDED_RESULT`
status.

## Newly run at import (implementation-level, `IMPLEMENTER` / `VERIFIER` authority only)

| Check | Status | Evidence |
| --- | --- | --- |
| Manifest integrity | PASS | SHA-256, byte length and Git blob SHA-1 of every listed file match; no unlisted file in the package. |
| Prohibited source binaries | PASS | No `.m4a` `.mp3` `.wav` `.flac` `.pdf` `.mid` `.midi` in the package. |
| Accepted MML integrity | PASS | `current-accepted.mml` SHA-256 `bfbfb8b77416e6abca47f75ce7687b43dded6fd9f72ef848d1e129ae1fab15ed`. |
| Six-track split and per-track Final-mode parse (`studio/backend/mml/parser.mjs`) | PASS | `current-accepted.mml`: 0 track errors, 0 track warnings; note counts `555 / 229 / 625 / 271 / 110 / 51`; total `1244.5` beats on all six roles; `T240`; characters `1524 / 1048 / 1567 / 1144 / 944 / 853`. All match the recorded values in `validation-summary.md` and `arrangement-notes.md`. |
| Historical MML parse | PASS | `v13`: `555 / 229 / 623 / 275 / 115 / 53`; `SF6R` and `TL1`: `555 / 229 / 625 / 275 / 115 / 53`; 0 track errors each. Consistent with the history (v20 Bass restoration after v13; TL1 keeps SF6R note identity). |
| Song-level Final validation (`validateMML`, `mode: final`) | NOT_RUN | The current parser requires a source-confirmed meter map and refuses to assume 4/4. No meter map was source-confirmed at import, so none was supplied. |

The following stay `NOT_RUN`, as in `validation-summary.md`: full event-level
source comparison, original-audio alignment, expanded Preview readback, Studio
readiness, source-aware micro-timing analysis, and any new in-game session.

These checks are enforced on every CI run by
`studio/tests/song-reference-packages.test.mjs`.

## Authority

This package is song-specific context and evidence. It is not a
`CANONICAL_RULE_SOURCE`, it does not modify the Published release, and the
`reusable_insight_candidates` remain candidates. Its `canonical_context` is
provenance of the export, not a rules snapshot to load from.
