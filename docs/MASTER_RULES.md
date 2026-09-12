# Mabinogi Mobile MML — Canonical Master Rules

Version: 2026-09-13-draft1
Status: CANONICAL CANDIDATE on `rules-canonical-20260913`

This document is the human-readable authority for project policy. Executable contracts, parsers, validators, Studio code, legacy skills, community posts, websites, and historical outputs MUST NOT silently redefine it.

## 0. Authority order

1. User's latest explicit decision for this project.
2. Current Canonical docs in this directory after review/merge.
3. Confirmed in-game evidence supplied by the user for the relevant client/version.
4. Official Nexon guide/update evidence for game limits and documented behavior.
5. Accepted project regressions and dated normative extensions.
6. Community examples and third-party tools as supporting evidence only.
7. Legacy Grok Skill 2026-09-02 and older outputs as `LEGACY_REFERENCE` only.

If two authorities disagree, do not guess. Mark the decision `PENDING` and record the conflict.

## 1. Three separate rule layers

Never collapse these into one category:

- `OFFICIAL_GAME_LIMIT`: what Nexon explicitly documents.
- `FINAL_CANONICAL_POLICY`: this project's safe and auditable output policy; may be stricter than the engine.
- `MUSICAL_ARRANGEMENT_POLICY`: source/role/arbitration rules learned from arrangement work and regressions.

A project safety policy MUST NOT be described as an official engine limitation without official evidence.

## 2. Musical decision hierarchy

`source traceability`
→ `source-complete preservation before reduction`
→ `lead continuity`
→ `Core3 completeness`
→ `Mobile audibility / role clarity`
→ `minimal necessary adaptation`
→ `Full6 enrichment`
→ `theory/statistical cleanup last`

Do not improve metrics by erasing source-supported music.

## 3. Source-complete baseline first

Before six-track reduction, preserve important source material in a traceable baseline: Lead/Top voice, core harmony, inner voices, bass, counter-lines, rhythmic/texture voices, tempo/meter/form, and source IDs.

Every candidate SHOULD be diffable against:
- Source-Faithful Baseline;
- accepted previous version, if one exists.

A role move, removed event, added event, pitch/onset/duration change, or prominence change must not be silent.

## 4. Melody / Lead policy

Melody (T1) is `Lead Role`, not `Vocal-only`.

Valid lead sources include sung vocal, instrumental intro/solo/answer phrase, piano/guitar/keyboard top line, and source-supported hand-offs during vocal rests.

Forbidden inference shortcuts:
- `highest piano note -> therefore Vocal`;
- `not proven Vocal -> therefore Inner/Harmony`.

Demoting a source-supported Lead requires positive role evidence and must preserve continuity and Core3 integrity.

## 5. Core3 / Full6

Core3 = Melody + Chord1 + Chord2 and is the single-player three-chord target.

Default musical roles:
- Melody = Lead;
- Chord1 = Core Harmony / principal accompaniment / essential response;
- Chord2 = Core Bass skeleton **plus any essential inner voice required for a complete one-player arrangement**.

Chord2 MUST NOT be hardened into `Bass-only` when source evidence or one-player completeness requires essential inner material.

Chord3–Chord5 are enrichment by default. They may add inner harmony, counter-lines, texture, secondary bass reinforcement, rhythmic detail, or source-specific roles, but must not make Core3 less complete.

## 6. Cross-source arbitration

Do not directly stack Vocal, Piano, Guitar, Bass, third-party MIDI/MML, or alternate arrangements merely because each has a source.

Review at minimum:
- same-pitch doubling;
- low/mid m2 and M7 compression;
- cross-source m9 risk;
- unresolved tension;
- register pollution;
- role duplication;
- density/volume bursts;
- source-supported hand-offs.

Same-pitch overlap and simultaneous 5/6-track attacks are review signals, not automatic deletion targets.

When a confirmed non-musical overlap must be repaired, prefer evidence-backed redistribution/split before truncation. Do not delay a new note-on just to hide a collision.

## 7. Rests, articulation, ties

Preserve meaningful source rests, breaths, articulation gaps, and sparse passages. Do not fill true rests to improve continuity statistics.

Technical micro-gaps without musical meaning may be normalized under `MOBILE_SYNTAX.md`.

Tie (`&`) is used only when the musical event is a continuation of the same pitch. Adjacent repeated attacks must not be silently converted into one sustain.

## 8. Drum policy

General MIDI drum note numbers are not ordinary pitched Mobile MML notes. Drum sources must first be mapped to evidence-backed Mobile drum-face positions/instrument behavior. If a drum-capable performer/instrument is unavailable, provide a safe non-drum version rather than leaking GM pitches into pitched instruments.

## 9. Tempo / preview policy

Final syntax limits are defined in `MOBILE_SYNTAX.md`.

For verification previews:
- use an independent Conductor where applicable;
- fully expand playback order;
- reconstruct exact bars/ties from confirmed meter;
- require Tempo Map agreement;
- use the 2% duration comparison only as a sanity check, never as proof of correctness;
- ABC `L:1/4` is a preview convention only, not a final-MML rule.

Midify is `N/A` by default and is not a Final Gate. `applied=true`, zero warnings, or website playback is not acceptance evidence.

## 10. Version drift / rollback

A newer version is not automatically better. Increasing drift from the source-faithful baseline or accepted version is a review trigger, not a quality verdict.

If a change lacks stronger source or in-game evidence and degrades accepted lead/Core3/source fidelity, prefer rollback to the last accepted baseline followed by the smallest justified correction.

## 11. Validation states

Keep these separate:
- `TECHNICAL_PASS`
- `SOURCE_PASS`
- `PLAYER_READBACK_PASS`
- `AUDIO_ALIGNMENT_PASS`
- `MOBILE_ADAPTATION_PASS`
- `IN_GAME_ACCEPTED`

No lower layer may impersonate a higher layer.

## 12. Canonical change control

Changes to these docs require:
1. explicit rationale;
2. evidence class;
3. regression impact;
4. corresponding executable-contract/test changes only after the prose rule is accepted.

Studio code implements Canonical rules; it does not define them.

Historical named regressions such as Rashisa lead over-cleaning remain permanent evidence and should become fixtures when source assets are available.
