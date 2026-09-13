# Mabinogi Mobile MML Studio

Studio is the source-aware orchestration layer built beside the existing MML Workbench. Its purpose is to reduce repetitive verification work while keeping every musical decision traceable to evidence.

## Rule authority

Start only at [docs/CANONICAL_MANIFEST.md](../docs/CANONICAL_MANIFEST.md), then
load its pinned Published Canonical human-readable rules. This README and
`studio/backend/rules/index.mjs` describe/implement the system; neither defines
rules. The authority map is derived from the Manifest, with inventory and
supporting evidence separate from rule sources.

After refreshing `origin/main`, run `npm run canonical:bootstrap` from the
repository root to read the Manifest, documents and Git provenance.
`npm run canonical:bootstrap -- --summary` checks identity without displaying
the document text. The loader performs no network fetch and requires the
published main ref and snapshot history. Studio's contract/parser imports fail
with `CANONICAL_NOT_LOADED` if loading fails; they never substitute a local Skill,
standalone Master, an unmerged PR Manifest, or the legacy parser as rule authority.
An archive without Git provenance is insufficient for this Bootstrap.

## Current layout

```text
studio/
  backend/
    bootstrap/      Manifest discovery and pinned published-document loading
    rules/          executable contract implementing Canonical docs
    canonical/      source-traceable Canonical Music IR
    mml/            ingest parser, Final validator, source normalization
    score/          MusicXML ingestion and source completeness checks
    compare/        deterministic version/source drift reports
    arbitration/    Core3, Lead Demotion and cross-source harmony gates
    final/           per-song readiness evaluation
    audio/           Node audio-evidence bridge
  audio-worker/      Python/FFmpeg original-audio alignment
  web/               future iPhone/iPad-first UI
  tests/             Studio regression tests
```

## Implemented pipeline

The following are implemented and covered by the combined legacy + Studio CI suite:

- current MML ingest and Final validation split;
- plain 1/64 support and 1–64 caution handling;
- Nxx ingest preservation with opt-in/evidence Final policy;
- Canonical Music IR with note/rest/Tempo/meter provenance;
- score-partwise MusicXML ingestion;
- fail-closed handling of unsupported MusicXML constructs;
- Current/Historical MML → Canonical evidence normalization;
- source/previous/candidate version-drift reporting;
- Source-Faithful Baseline with runtime event diff;
- source-relative Core3 Continuity Gate;
- evidence-first Lead Demotion Gate;
- cross-source same-pitch / m2 / M7 / m9 harmony arbitration;
- original-audio alignment worker and Node evidence bridge;
- per-song Project Readiness.

There is currently **no module-level Studio implementation blocker**. That does not certify any song. Every song still needs its own source, baseline, technical, Core3, Lead, harmony, version, audio, player and in-game evidence as applicable.

MusicXML ingestion being implemented does not mean every file is complete. Repeat/navigation flow, grace realization, transposing-part concert pitch, microtones and unpitched mapping remain explicit unsupported/PENDING cases when encountered.

## Intended input set

- official/trusted MusicXML or score export;
- trusted/official MIDI when available;
- third-party MuseScore export as supporting evidence;
- current six-track MML;
- historical MML versions;
- original M4A/FLAC/WAV for audio evidence.

## Intended user-facing result

The future phone/iPad UI should answer questions such as:

- Which current notes differ from the trusted symbolic source?
- Which changes are new relative to the last accepted version?
- Did a later candidate drift farther from the source baseline?
- Did a role move create a false Lead gap or damage Core3?
- Are Chord3–Chord5 additions colliding with Core3?
- Which conflicts have explicit evidence-backed arbitration?
- Where does the original recording disagree in timing/structure/foreground role?
- Does the final MML still pass the current Mobile technical policy?

The UI is not yet implemented beyond the scaffold, and Studio has not replaced the current production Railway/MCP route.

Use the Manifest for current policy discovery. `docs/RULES_AUDIT_2026-09-13.md`,
`docs/STUDIO_MIGRATION.md`, and `docs/RELEASE_READINESS_2026-09-13.md` are dated
historical/status records, not alternate rule-loading entry points. Their
pre-Bootstrap descriptions are retained as history. References to a song
`candidate` or `candidateReady` describe musical artifacts/readiness, not a
candidate Canonical rules release.
