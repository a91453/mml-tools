# Mabinogi Mobile MML Studio

Studio is the source-aware orchestration layer built beside the existing MML Workbench. Its purpose is to reduce repetitive verification work while keeping every musical decision traceable to evidence.

## Rule authority

Human-readable rules live in the reviewed Canonical documents under `docs/`. `studio/backend/rules/index.mjs` implements those rules; it is not an independent rule authority.

## Core principles

- Preserve source facts before six-track reduction.
- Use exact rational beat positions; floating point is never canonical symbolic time.
- Never silently mutate or discard a source event to satisfy Final policy.
- Keep source truth, arbitration, Mobile adaptation and final MML as separate layers.
- Melody/T1 is Lead Role, not a Vocal-only channel.
- Core3 is Lead + Core Harmony + Core Bass skeleton/essential inner support; Chord2 is not Bass-only.
- Full6 enrichment must not reduce Core3 completeness.
- Natural source rests remain rests; continuity statistics do not justify filling them.
- Cross-source provenance does not prove harmonic compatibility.
- Audio evidence supplements symbolic truth; it does not overwrite it.

## Current layout

```text
studio/
  backend/
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

See `docs/MASTER_RULES.md`, `docs/MOBILE_SYNTAX.md`, `docs/ACCEPTANCE_CRITERIA.md`, `docs/RULES_AUDIT_2026-09-13.md` and `docs/STUDIO_MIGRATION.md` for current policy/status.
