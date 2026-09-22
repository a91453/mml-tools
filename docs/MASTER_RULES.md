# Mabinogi Mobile MML — Canonical Master Rules

Version: 2026-09-22-v1
Status: PUBLISHED CANONICAL

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

Before role cleanup or six-track reduction, preserve important source material in a traceable Source-Faithful Baseline: Lead/Top voice, core harmony, inner voices, bass, counter-lines, rhythmic/texture voices, tempo/meter/form, and source IDs.

When a candidate performs any role move, cleanup, reduction or Mobile adaptation, a diff-capable Source-Faithful Baseline SHALL exist before that transformation is accepted.

The baseline or equivalent event map MUST be able to enumerate at minimum:
- T1/Lead removed events;
- T1/Lead added events;
- T1-to-other-track moves;
- other-track-to-T1 promotions;
- other meaningful role moves;
- pitch/onset/duration changes;
- prominence/volume changes when role or audibility is affected.

Every candidate SHALL be diffed against:
- the Source-Faithful Baseline;
- the accepted previous version, if one exists.

A role move, removed event, added event, pitch/onset/duration change, or prominence change must not be silent.

A source inventory that cannot produce these event-level differences is not sufficient as the required baseline.

## 4. Melody / Lead policy

Melody (T1) is `Lead Role`, not `Vocal-only`.

Valid lead sources include sung vocal, instrumental intro/solo/answer phrase, piano/guitar/keyboard top line, and source-supported hand-offs during vocal rests.

Forbidden inference shortcuts:
- `highest piano note -> therefore Vocal`;
- `not proven Vocal -> therefore Inner/Harmony`.

Demoting a source-supported Lead requires positive role evidence and must preserve continuity and Core3 integrity.

If the evidence for demotion conflicts or is incomplete, preserve the Source-Faithful Lead event and mark the decision `PENDING` rather than cleaning it away.

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

Final syntax and delivery synchronization policy are defined in `MOBILE_SYNTAX.md`.

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

## 11. Validation states and delivery lifecycle

Keep verification axes separate:
- `TECHNICAL_PASS`
- `SOURCE_PASS`
- `PLAYER_READBACK_PASS`
- `AUDIO_ALIGNMENT_PASS`
- `MOBILE_ADAPTATION_PASS`
- `IN_GAME_ACCEPTED`

No lower layer may impersonate a higher layer. An AI model, proposal, caller-supplied confirmation, or UI action MUST NOT author a Canonical PASS. Machine verdicts are computed by Studio from the Published Canonical rules and stored evidence.

The song lifecycle is separate from the gate vocabulary:
- `CANDIDATE`: arrangement work is still in progress or a machine-delivery blocker remains.
- `AUTOMATED_VALIDATED`: Studio produced a paste-ready MML artifact and every machine-delivery blocker is cleared. Non-blocking evidence or quality questions MAY remain `PENDING` and must be reported with the artifact.
- `HUMAN_REVIEWED`: optional post-delivery listening/review has been recorded for the exact artifact or candidate.
- `IN_GAME_ACCEPTED`: optional post-delivery controlled target-client acceptance has been recorded for the exact MML.

`HUMAN_REVIEWED` and `IN_GAME_ACCEPTED` enrich the quality history; neither is a prerequisite for `AUTOMATED_VALIDATED`.

## 12. Machine-deliverable Final versus post-delivery review

Final delivery is fail-closed for defects that make the artifact illegal, untraceable, destructively unsupported, or materially ambiguous in a way that cannot be preserved conservatively. At minimum these remain machine-delivery blockers:
- unresolved recording/source version mixing;
- no diff-capable Source-Faithful Baseline or broken source/event identity;
- unexplained deletion, replacement, role move, timing change, or prominence change of source-supported material when reverting/preserving it is still possible;
- an unresolved reduction that cannot fit the intended delivery within six roles without silently dropping material;
- official numeric-limit or character-limit violations;
- Final-forbidden syntax, zero duration, unrepresentable timing, synchronization failure, or Final round-trip mismatch;
- integrity/provenance failures that make the produced bytes or their candidate binding uncertain.

A musical or evidentiary question MAY remain `PENDING` without blocking machine delivery only when Studio can prove all of the following:
1. the unresolved question is reported, not converted to PASS/N/A;
2. the output keeps the safer Source-Faithful material or otherwise applies a reversible evidence-backed transformation;
3. no source-supported event is silently erased or reassigned to manufacture a clean metric;
4. the resulting MML is technically legal, representable and round-trip stable;
5. the unresolved question is not itself required to choose between incompatible source versions or destructive alternatives.

Examples of normally post-delivery or non-blocking evidence include subjective listening preference, optional player listening, target-instrument audibility when no instrument-specific transformation was necessary, and in-game acceptance. Original-audio or human review becomes blocking only when the arrangement decision being made actually depends on that evidence and no conservative source-faithful fallback exists.

## 13. Provider-neutral AI boundary

ChatGPT, Claude, Codex, another MCP-capable assistant, or a local model may inspect state and propose actions. Model/provider identity does not change authority.

The production Studio MUST NOT require a server-side model credential or provider-specific inference path in order to reach a machine-deliverable Final. A conversational AI may spend its own subscription/session quota while operating the same MCP contract.

AI responsibilities:
- understand the task and source context;
- inspect Studio state;
- propose source-bound arrangement decisions or reversible adaptations;
- continue the run through explicit MCP/Application Service operations.

Studio responsibilities:
- load Published Canonical;
- validate bindings, source traceability, diffs, syntax, limits, timing and regression;
- calculate gate/disposition results;
- emit the artifact and its unresolved-evidence ledger.

AI MUST NOT claim `PASS`, `HUMAN_REVIEWED`, or `IN_GAME_ACCEPTED` on its own authority.

## 14. Canonical change control and regression claims

Changes to these docs require:
1. explicit rationale;
2. evidence class;
3. regression impact;
4. corresponding executable-contract/test changes only after the prose rule is accepted.

Studio code implements Canonical rules; it does not define them.

Historical named regressions such as Rashisa lead over-cleaning remain permanent evidence and SHOULD become reproducible fixtures when legally/source-permitted assets are available.

Until a named regression fixture exists and is actually executed, a report MUST NOT claim that the named regression has passed. For Lead demotion scenarios without the required evidence, preserve/revert to the Source-Faithful Lead when that is a safe legal fallback; otherwise report `FAIL` or blocking `PENDING`.