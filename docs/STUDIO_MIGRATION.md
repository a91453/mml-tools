# Mabinogi Mobile MML Studio v1 — migration status

Frozen legacy baseline: `legacy-v0.2.0` at commit `b48a3a3abc9f8617f50bc28cfddd3424e8230f70`.

Current Studio branch: `studio-v1`.

This migration remains additive. Studio source, tests and Published Canonical v1 documents coexist with the legacy Workbench; the current Railway/MCP production route is not replaced by this migration PR.

## Rule authority

Human-readable project policy lives in the published Canonical v1 documents under `docs/`:

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

### Partial version-controlled rule extensions

- `skills/mabinogi-mobile-mml/`

These files remain dated extensions/reference material. The complete current rule authority is the published Canonical document set above.

## Current Studio layers

```text
studio/
  backend/
    rules/          # executable contract implementing Canonical docs
    canonical/      # source-traceable Canonical Music IR
    mml/            # ingest parser + Final validator + MML source normalization
    score/          # MusicXML ingestion + fail-closed completeness detection
    compare/        # deterministic version/source drift
    arbitration/    # Core3, Lead Demotion, cross-source harmony gates
    final/           # per-song readiness
    audio/           # Node bridge for derived audio evidence
  audio-worker/      # Python/FFmpeg original-audio alignment
  web/               # iPhone/iPad-first UI scaffold
  tests/             # Studio regression tests
```

## Source hierarchy

Studio keeps these layers separate:

1. immutable source files and source-derived facts;
2. source-complete canonical representation;
3. explicit arbitration decisions with reasons/evidence;
4. Mabinogi Mobile adaptations;
5. final MML output and reverse validation.

A final MML event must never become the only surviving record of why a note exists.

## Current milestone status

### Complete + regression-tested

1. Freeze legacy and create `studio-v1` development branch.
2. Published Canonical v1 rule set independent of the legacy parser profile.
3. Current MML ingest + Final validation split, including plain 64 and caution handling for 1–64 values.
4. Nxx ingest preservation with Final opt-in/evidence policy.
5. Canonical source/event/control/decision IR with exact rational timing.
6. score-partwise MusicXML ingestion with source provenance and fail-closed unsupported reporting.
7. Current and historical MML → Canonical evidence normalization.
8. Deterministic source/version drift reporting.
9. Source-relative Core3 Continuity Gate.
10. Evidence-first Lead Demotion Gate.
11. Cross-source harmony conflict/arbitration gate.
12. Original-audio alignment worker + Node evidence bridge.
13. Per-song Project Readiness separating module availability from song acceptance.
14. Combined legacy + Studio CI, including audio regressions and legacy production build smoke test.

There is currently **no global implementation-module blocker** in `studioFinalBlockers()`. This does not make any song Final.

### Remaining product milestone

15. iPhone/iPad-first upload/report Web UI.
16. Cloud deployment for Studio without replacing the existing production MCP until independently accepted.
17. Optional heavier audio source-separation/transcription helpers only if the lightweight alignment layer proves insufficient.

## Source-specific completeness caveat

`musicXmlIngestion=true` means the ingestion module exists and is tested; it does **not** mean every MusicXML file is automatically complete.

The current importer deliberately returns `complete=false` for unsupported constructs including:
- unexpanded repeat/volta/navigation flow;
- grace-note realization;
- transposing-part concert pitch;
- microtonal pitch;
- unpitched/percussion mapping.

Those cases remain explicit `PENDING/UNSUPPORTED` evidence instead of being guessed.

Likewise, `originalAudioAlignment=true` means the audio module exists. Each song still needs its own alignment evidence when audio is required, and warned/weak evidence remains `PENDING`.

## Migration safety rules

- do not delete legacy tests;
- do not replace `dist/core.js` in-place merely to make Studio rules pass;
- do not change the production Railway/MCP route merely to serve Studio;
- do not let a global module flag turn song-specific unsupported evidence into PASS;
- do not let audio evidence overwrite symbolic source truth;
- do not let executable code redefine the Canonical prose rules;
- do not call `candidateReady` an in-game acceptance result.

## Next engineering milestone

Build the thin iPhone/iPad-first Studio UI over the existing Canonical/source/arbitration/audio/readiness modules. The UI should expose evidence and decisions without becoming an independent rule store. Studio production deployment remains a later explicit decision and must not silently replace the working legacy MCP/Railway route.
