# Mabinogi Mobile MML Studio — Rule Audit

Date: 2026-09-13
Branch: `studio-v1`
Status: refreshed after Canonical Draft2 + Studio alignment merges

## Authority decision

The human-readable rule authority is the reviewed Canonical document set:

- `docs/MASTER_RULES.md`
- `docs/SOURCE_POLICY.md`
- `docs/MOBILE_SYNTAX.md`
- `docs/ACCEPTANCE_CRITERIA.md`
- `docs/PENDING.md`

`studio/backend/rules/index.mjs` implements those documents; it does not define or override them. Legacy `dist/core.js`, old tests, community posts, websites and the 2026-09-02 Grok Skill are evidence/reference layers only.

The working legacy Workbench remains useful implementation and deployment compatibility. Studio v1 is additive and does not replace the current Railway/MCP production route in this PR.

## Official / project-policy separation

Current official evidence recorded in `docs/OFFICIAL_EVIDENCE.md` supports:

- up to 6 composition roles;
- up to 2,400 MML characters per role;
- Tempo editor range 32–255;
- note/rest numeric length range 1–64;
- Volume 0–15;
- documented pitch range 0–107;
- 3-harmony instruments capable of up to 3 simultaneous notes.

Project Final policy is intentionally separate from those official limits. In particular:

- plain `64` is accepted;
- arbitrary plain 1–64 lengths are ingestible; non-preferred values are Final caution, not engine-illegal;
- plain `48` is `FINAL_ALLOWED_WITH_CAUTION`;
- `Nxx` is preserved at ingest and is Final opt-in-with-evidence, not blanket engine rejection;
- `64.`, fragile dotted forms, multiple dots and technical sub-1/64 micro-gaps remain Final-forbidden by project policy;
- `O0–O8` is an implementation mapping, not Nexon wording.

## Musical / arbitration rules preserved

- Melody/T1 is Lead Role, not Vocal-only.
- Source-Faithful Baseline is mandatory before role cleanup, six-track reduction or Mobile adaptation.
- Baseline/candidate event differences must remain auditable.
- Chord2 is the Core Bass skeleton **plus essential inner support when required**; it is not Bass-only.
- Core3 must remain independently musical; Chord3–Chord5 are enrichment by default and may not damage Core3.
- `not proven Vocal` is never positive Lead-demotion evidence.
- A source reference proves provenance, not harmonic compatibility.
- Same-pitch overlap, low/mid m2/M7 and cross-source m9 are review signals, not automatic deletion commands.
- Natural rests are not filled for continuity statistics.
- Theory/statistical cleanup is last and may not erase source-supported material.

## Legacy Workbench drift retained as regression evidence

Known legacy behavior intentionally remains visible rather than being silently rewritten:

- legacy parser rejects plain 64;
- legacy parser accepts Tempo above the current Final 255 ceiling;
- legacy parser rejects caution values such as plain 48;
- historical Workbench strict-profile tests therefore do not define current Canonical rules.

Studio tests must keep distinguishing historical regression evidence from current Studio behavior.

## Current implementation status

Implemented and regression-tested on `studio-v1`:

- current MML ingest + Final validation split;
- exact rational timing;
- Canonical Music IR with provenance;
- MusicXML ingestion with fail-closed unsupported constructs;
- current/historical MML normalization;
- version-drift reporting;
- Core3 Continuity Gate;
- evidence-first Lead Demotion Gate;
- cross-source harmony arbitration;
- Source-Faithful Baseline readiness gate with computed event diff;
- original-audio alignment worker + Node evidence bridge;
- per-song Project Readiness;
- combined legacy + Studio symbolic regressions;
- Python audio-worker regressions with FFmpeg.

`studioFinalBlockers()` currently has no module-level blockers. This **does not** certify any song.

## Per-song readiness remains mandatory

A candidate still needs its own evidence/gates, including:

- source completeness;
- real Source-Faithful Baseline snapshot and event diff;
- Strict Mobile technical validation;
- Core3 review;
- evidence-backed review of Lead removals/role moves;
- cross-source harmony arbitration;
- version-drift review when required;
- original-audio evidence when required;
- actual player readback;
- no pending arbitration decisions.

`candidateReady=true` is not `finalAccepted=true`. Explicit in-game acceptance is still required for Final acceptance.

## Known non-blocking debt

The following remain visible and must not be overclaimed:

- caution-length opt-in is currently candidate-level rather than a per-token evidence schema;
- exact O-token ↔ official 0–107 edge mapping remains pending;
- baseline snapshot provenance/deep-freeze workflow can be hardened further;
- a generic technical micro-gap analyzer is not yet complete;
- not every historical named-song regression has a committed reproducible fixture;
- the iPhone/iPad Studio UI and production Studio deployment are not implemented.

## Tool / preview scope

- Midify is N/A by default and is not a Final Gate.
- Only actual loaded player/readback state counts as player evidence.
- ABC `L:1/4` is a preview convention only.
- Preview uses a separate Conductor, full expansion, exact bars/ties, Tempo-map agreement and the 2% duration sanity check.

## No automatic rule promotion

A website, third-party editor, old report, old song, old test or executable implementation cannot silently become a master rule. Canonical changes require explicit human rule review plus regression alignment.
