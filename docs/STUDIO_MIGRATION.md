# Mabinogi Mobile MML Studio v1 — migration plan

Frozen legacy baseline: `legacy-v0.2.0` at commit `b48a3a3abc9f8617f50bc28cfddd3424e8230f70`.

This migration is intentionally additive. Studio v1 must not delete, move, or silently rewrite the working legacy engine while the new architecture is being proven.

## Inventory decision

### Keep as authoritative MML engine

- `dist/core.js`
  - BigInt rational beat math
  - six-track parser
  - Strict Mobile profile
  - meter/bar construction
  - Tempo Map checks
  - 15 cross-track pair review
  - low/mid interval warnings
  - MIDI/ABC encode/readback utilities
- `tests/core.test.mjs`
- `tests/player.test.mjs`

These are the first reusable engine assets. Studio v1 imports them through an adapter instead of copying their logic.

### Keep as compatibility / deployment layer

- `dist/app.js`, `dist/player.js`, `dist/index.html`, `dist/style.css`
- `server/mcp.mjs`, `server/worker.mjs`
- `railway/`
- `tests/mcp.test.mjs`, `tests/railway.test.mjs`

They remain available for the current Workbench/MCP deployment, but they are not allowed to define Studio's future domain model.

### Keep as normative rule sources

- `skills/mabinogi-mobile-mml/`

The rule files are evidence/rule sources. They are not treated as proof that an external installed ChatGPT skill has already been updated.

### Treat as generated / legacy packaging

- `dist/workbench-source.zip`
- future generated deployment bundles under `dist/`

Do not build new Studio domain logic into generated bundles.

## Studio v1 target layers

```text
studio/
  backend/
    canonical/      # source-traceable Canonical Music IR
    mml/            # adapter to the proven legacy MML engine
    score/          # MusicXML/MIDI ingestion (next milestone)
    compare/        # source/version diff (next milestone)
    arbitration/    # explicit conflict decisions (next milestone)
  web/              # iPhone/iPad-first UI (later in v1)
  tests/            # Studio regression tests
```

## Source hierarchy

Studio must keep these layers separate:

1. source files and source-derived facts;
2. source-complete canonical representation;
3. arbitration decisions with reasons;
4. Mabinogi Mobile adaptations;
5. final MML output and reverse validation.

A final MML event must never become the only surviving record of why a note exists.

## V1 milestones

1. Freeze legacy and add adapters — current milestone.
2. Canonical source/event IR with exact rational beat positions.
3. MusicXML import into Canonical IR.
4. Current MML + historical MML -> Canonical events.
5. Version/source comparison and divergence report.
6. Core3 + Full6 validation using existing engine gates.
7. Mobile browser upload/report UI.
8. Only after symbolic sources are stable: original-audio alignment.

## Safety rule for migration

Until Studio regression coverage is equal to or stronger than the legacy coverage:

- do not delete legacy tests;
- do not replace `dist/core.js` in-place;
- do not change the production Railway/MCP route merely to serve Studio;
- do not merge Studio changes into `main` without reviewing the branch diff and tests.
