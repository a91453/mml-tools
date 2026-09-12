# Mabinogi Mobile MML Studio

Studio is the source-aware orchestration layer being built beside the existing MML Workbench. Its purpose is to remove repetitive verification work while keeping every musical decision traceable to evidence.

## Core principles

- Preserve source facts before six-track reduction.
- Use exact rational beat positions; floating point is never canonical symbolic time.
- Never silently mutate a source event.
- Keep source truth, arbitration, Mobile adaptation and final MML as separate layers.
- Melody/T1 is the perceptual Lead role, not a Vocal-only channel.
- Core3 (Lead + Core Harmony + Core Bass) and Full6 enrichment are separate gates.
- Natural source rests remain rests; continuity statistics do not justify filling them.
- Cross-source provenance does not prove harmonic compatibility.
- Audio evidence supplements symbolic truth; it does not overwrite it.

## Current layout

```text
studio/
  backend/
    rules/          effective dated rule contract and Final blockers
    canonical/      source-traceable Canonical Music IR
    mml/            current-rule MML parser and source normalization
    score/          MusicXML ingestion and source completeness checks
    compare/        deterministic version/source drift reports
    arbitration/    Core3, Lead Demotion and cross-source harmony gates
  web/              future iPhone/iPad-first UI
  tests/            Studio regression tests
```

## Implemented symbolic pipeline

The following are implemented and covered by the combined legacy + Studio CI suite:

- current Mobile parser profile with plain 1/64 support and T32–T255;
- Canonical Music IR with note/rest/Tempo/meter provenance;
- score-partwise MusicXML ingestion;
- fail-closed handling of unsupported MusicXML constructs;
- Current/Historical MML → Canonical evidence normalization;
- source/previous/candidate version-drift reporting;
- source-relative Core3 Continuity Gate;
- evidence-first Lead Demotion Gate;
- cross-source same-pitch / m2 / M7 / m9 harmony arbitration.

MusicXML ingestion being implemented does not mean every source file is complete. Repeat/navigation flow, grace realization, transposing-part concert pitch, microtones and unpitched mapping currently remain explicit unsupported/PENDING cases instead of being guessed.

## Current global blocker

`ORIGINAL_AUDIO_ALIGNMENT_PENDING`

The next module must accept user-provided original audio and create traceable evidence mapping recording seconds ↔ canonical beat time. Its first job is alignment, Tempo drift and structure/role evidence — **not** blind whole-song Audio-to-MIDI transcription.

## Intended input set

- official/trusted MusicXML or score export;
- trusted/official MIDI when available;
- third-party MuseScore export as supporting evidence;
- current six-track MML;
- historical MML versions;
- original M4A/FLAC/WAV for the audio evidence layer.

## Intended user-facing result

The phone/iPad UI should eventually answer questions such as:

- Which current notes differ from the trusted symbolic source?
- Which changes are new relative to the last accepted version?
- Did a later candidate drift farther from the source baseline?
- Did a role move create a false Lead gap or damage Core3?
- Are Chord3–Chord5 additions colliding with Core3?
- Which conflicts have explicit evidence-backed arbitration?
- Where does the original recording disagree in timing/structure/foreground role?
- Does the final MML still pass the current Mobile technical profile?

See `docs/RULES_AUDIT_2026-09-13.md` and `docs/STUDIO_MIGRATION.md` for the current authoritative migration/audit status.
