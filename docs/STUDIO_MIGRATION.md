# Mabinogi Mobile MML Studio v1 — migration status

Frozen legacy baseline: `legacy-v0.2.0` at commit `b48a3a3abc9f8617f50bc28cfddd3424e8230f70`.

This migration remains additive. Studio v1 does not delete, move or silently rewrite the working legacy engine while the new architecture is being proven.

## Inventory decision

### Reuse as implementation, not rule authority

- `dist/core.js`
  - BigInt rational beat math
  - meter/bar construction
  - cross-track review
  - MIDI/ABC encode/readback utilities
- `tests/core.test.mjs`
- `tests/player.test.mjs`

The legacy MML parser and `mobile-strict-2026-09-08` profile are **not** Studio rule authority because the audit found known rule drift (notably 64th-note rejection and the obsolete Tempo ceiling). Studio uses its own dated parser/rule contract and reuses only proven implementation pieces.

### Keep as compatibility / deployment layer

- `dist/app.js`, `dist/player.js`, `dist/index.html`, `dist/style.css`
- `server/mcp.mjs`, `server/worker.mjs`
- `railway/`
- `tests/mcp.test.mjs`, `tests/railway.test.mjs`

These remain available for the current Workbench/MCP deployment. Studio work has not changed the production Railway/MCP route.

### Keep as partial version-controlled rule extensions

- `skills/mabinogi-mobile-mml/`

This directory is not a complete current SKILL/master package. It currently stores the 2026-09-10 Lead Role rule extensions. Studio therefore does not treat the directory as complete rule truth.

### Treat as generated / legacy packaging

- `dist/workbench-source.zip`
- generated deployment bundles under `dist/`

New Studio domain logic belongs under `studio/`, not generated bundles.

## Current Studio layers

```text
studio/
  backend/
    rules/          # dated effective rule contract + implementation blockers
    canonical/      # source-traceable Canonical Music IR
    mml/            # current-rule parser + MML source canonicalization
    score/          # MusicXML ingestion + fail-closed completeness detection
    compare/        # deterministic version/source drift
    arbitration/    # Core3, Lead Demotion, cross-source harmony gates
  web/              # iPhone/iPad-first UI (not yet implemented)
  tests/            # Studio regression tests
```

## Source hierarchy

Studio keeps these layers separate:

1. immutable source files and source-derived facts;
2. source-complete canonical representation;
3. explicit arbitration decisions with reasons/evidence;
4. Mabinogi Mobile adaptations;
5. final MML output and reverse validation.

A final MML event must never become the only surviving record of why a note exists.

## Milestone status

### Complete + regression-tested

1. Freeze legacy and create `studio-v1` development branch.
2. Dated effective Rule Contract independent of the legacy parser profile.
3. Current-rule MML parser (64th-note boundary, T32–T255, explicit meter).
4. Canonical source/event/control/decision IR with exact rational timing.
5. score-partwise MusicXML ingestion with source provenance and fail-closed unsupported reporting.
6. Current and historical MML → Canonical evidence normalization.
7. Deterministic source/version drift reporting.
8. Source-relative Core3 Continuity Gate.
9. Evidence-first Lead Demotion Gate.
10. Cross-source harmony conflict/arbitration gate.
11. Combined legacy + Studio CI on every `studio-v1` push.

### Global implementation blocker

12. Original-audio alignment / Tempo-drift evidence.

### After audio foundation

13. iPhone/iPad-first upload/report Web UI.
14. Cloud deployment for Studio without replacing the existing production MCP until independently accepted.
15. Optional heavier audio source-separation/transcription helpers only if the lightweight alignment layer proves insufficient.

## Source-specific completeness caveat

`musicXmlIngestion=true` means the ingestion module exists and is tested; it does **not** mean every MusicXML file is automatically complete.

The current importer deliberately returns `complete=false` for unsupported constructs including:
- unexpanded repeat/volta/navigation flow;
- grace-note realization;
- transposing-part concert pitch;
- microtonal pitch;
- unpitched/percussion mapping.

Those cases remain explicit `PENDING/UNSUPPORTED` evidence instead of being guessed.

## Migration safety rules

- do not delete legacy tests;
- do not replace `dist/core.js` in-place merely to make Studio rules pass;
- do not change the production Railway/MCP route merely to serve Studio;
- do not merge `studio-v1` into `main` while the PR is still intentionally Draft;
- do not mark a module PASS before its regression tests pass in the combined suite;
- do not let a global module flag turn song-specific unsupported evidence into PASS;
- do not let audio evidence overwrite symbolic source truth.

## Next engineering milestone

Build original-audio alignment as a separate cloud-side worker boundary. The first audio milestone is **not** full Audio-to-MIDI or Demucs. It should decode user-provided M4A/FLAC/WAV, derive alignment features, map recording seconds to canonical beat time, and emit Tempo/structure/role evidence with confidence and traceability. Heavy separation can remain a later optional worker.
