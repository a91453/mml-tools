# Mabinogi Mobile MML Studio

Studio is the new orchestration layer built on top of the proven MML Workbench core.

The first goal is not automatic arranging. It is to remove repetitive verification work while keeping every musical decision traceable to a source.

## Principles

- Preserve source facts before six-track reduction.
- Use exact rational beat positions; no floating-point timing as canonical truth.
- Never silently mutate a source event.
- Record every arbitration as an explicit decision with reason/evidence.
- Keep source truth, Mobile adaptation, and final MML as separate layers.
- Reuse the legacy Strict Mobile validator until Studio has equivalent regression coverage.
- Core3 (Lead + Core Harmony + Core Bass) and Full6 are separate gates.

## Current layout

```text
studio/
  backend/
    canonical/      Canonical Music IR
    mml/            adapter to the legacy validated MML engine
    score/          MusicXML/MIDI import contract
    compare/        source/version comparison contract
    arbitration/    conflict decision contract
  web/              future iPhone/iPad-first UI
  tests/            Studio regression tests
```

## V1 input target

- trusted/official MusicXML
- trusted/official MIDI when available
- third-party MuseScore export as supporting source
- current six-track MML
- historical MML versions

Original audio is intentionally a later milestone. Symbolic source comparison must be stable before audio evidence is allowed to influence arbitration.

## V1 output target

A report that can answer:

- Which current notes differ from the trusted score?
- Which edits are new relative to historical accepted versions?
- Did a later revision drift farther from source truth?
- Did a role move break T1 continuity or Core3 completeness?
- Which differences are deliberate Mobile adaptations and which are unexplained?
- Does the final six-track string still pass Strict Mobile technical validation?

See `docs/STUDIO_MIGRATION.md` for migration status and keep/defer decisions.
