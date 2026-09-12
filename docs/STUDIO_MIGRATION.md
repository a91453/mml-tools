# Mabinogi Mobile MML Studio v1 — migration status

Frozen legacy baseline: `legacy-v0.2.0` at commit `b48a3a3abc9f8617f50bc28cfddd3424e8230f70`.

Current Studio branch: `studio-v1`.

This migration remains additive. Studio source, tests and Canonical documents coexist with the legacy Workbench; the current Railway/MCP production route is not replaced by this migration PR.

## Rule authority

Human-readable project policy lives in the reviewed Canonical documents under `docs/`:

- `MASTER_RULES.md`
- `SOURCE_POLICY.md`
- `MOBILE_SYNTAX.md`
- `ACCEPTANCE_CRITERIA.md`
- `PENDING.md`

`studio/backend/rules/index.mjs` implements that policy. It does not define or override it.

The repository `skills/mabinogi-mobile-mml/` directory remains a partial dated extension set and is not the complete current rule truth. The 2026-09-02 local Grok Skill remains `LEGACY_REFERENCE` until a later loader migration.

## Legacy compatibility boundary

### Reused implementation / regression evidence

- `dist/core.js`
- `tests/core.test.mjs`
- `tests/player.test.mjs`

Useful pieces include exact rational timing, meter/bar construction, cross-track review and preview codecs. The legacy parser/profile is not current Studio rule authority.

### Existing production compatibility layer

- `dist/app.js`, `dist/player.js`, `dist/index.html`, `dist/style.css`
- `server/mcp.mjs`, `server/worker.mjs`
- `railway/`
- legacy MCP/Railway tests

PR #2 does not replace those production routes. A future Studio deployment requires a separate explicit deployment decision.

## Current Studio layers

```text
studio/
  backend/
    rules/          # executable contract implementing Canonical docs
    canonical/      # source-traceable Canonical Music IR
    mml/            # ingest parser + Final validator + source normalization
    score/          # MusicXML ingestion + fail-closed completeness
    compare/        # deterministic version/source drift
    arbitration/    # Core3, Lead Demotion, cross-source harmony gates
    final/           # per-song readiness evaluation
    audio/           # Node bridge for audio-alignment evidence
  audio-worker/      # Python/FFmpeg original-audio alignment
  web/               # iPhone/iPad-first UI scaffold only
  tests/             # Studio regressions
```

## Implemented + regression-tested

1. Frozen legacy baseline and additive Studio branch.
2. Reviewed Canonical Draft2 document set.
3. Executable Rule Contract aligned to Canonical policy.
4. Ingest vs Final MML validation split.
5. Plain 64 support and 1–64 caution handling without blanket engine-illegal claims.
6. Nxx ingest preservation with opt-in/evidence Final policy.
7. Canonical source/event/control/decision IR with exact rational timing.
8. score-partwise MusicXML ingestion with provenance and explicit unsupported cases.
9. Current/historical MML → Canonical evidence normalization.
10. Deterministic source/version drift reporting.
11. Source-relative Core3 Continuity Gate.
12. Evidence-first Lead Demotion Gate.
13. Cross-source harmony arbitration.
14. Source-Faithful Baseline readiness gate with runtime event diff.
15. Original-audio alignment worker and Node evidence bridge.
16. Per-song Project Readiness with implementation/source/baseline/technical/Core3/Lead/harmony/version/audio/player/pending-decision gates.
17. Pull-request + `studio-v1` CI covering Node symbolic and Python audio-worker regressions.

There is currently **no module-level Studio Final implementation blocker**. This is not a song-level PASS.

## Song-specific completeness still matters

Implemented modules do not make every source or song complete. Examples that remain explicit `PENDING/UNSUPPORTED` when encountered include:

- unexpanded MusicXML repeat/volta/navigation flow;
- grace-note realization;
- transposing-part concert pitch;
- microtonal pitch;
- unpitched/percussion mapping;
- missing/weak audio evidence when audio is required;
- missing player readback;
- unresolved Lead/Core3/harmony arbitration;
- unresolved version drift;
- missing in-game acceptance.

## Known non-blocking engineering debt

- caution-length opt-in is candidate-level rather than per-token;
- O-token edge mapping versus official 0–107 remains pending;
- baseline snapshot provenance/deep-freeze can be hardened further;
- generic technical micro-gap detection is not complete;
- not all named historical regressions have committed fixtures;
- iPhone/iPad Studio Web UI is still a scaffold;
- Studio cloud deployment is not wired to production.

These items must remain visible; they must not be described as completed capabilities.

## Migration safety rules

- do not delete legacy tests merely because Studio tests pass;
- do not replace `dist/core.js` in place to force current rules;
- do not let legacy tests become Canonical authority;
- do not change the production Railway/MCP route merely because Studio source enters `main`;
- do not let a module-ready flag certify a song;
- do not let audio evidence overwrite symbolic source truth;
- do not let a Full6 improvement reduce Core3 completeness;
- do not accept an unexplained Lead removal/role move as `N/A`.

## Next engineering milestones

1. Complete release-level review of PR #2 before any merge to `main`.
2. After an independently approved main merge, migrate the old local skill into a thin loader/reference model rather than another rule authority.
3. Build the iPhone/iPad-first upload/report UI on top of the existing backend gates.
4. Plan Studio cloud deployment separately from the current legacy Railway/MCP production route.
5. Add source-permitted/minimal regression fixtures for important historical song failures.
