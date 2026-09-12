# Mabinogi Mobile MML Studio — Rule Audit

Date: 2026-09-13
Branch: `studio-v1`

## Decision

The existing Workbench remains useful **implementation**, but it is not the rules authority for Studio v1.

`legacy-v0.2.0` and `main` remain untouched. Studio rules are centralized in `studio/backend/rules/index.mjs`; current-rule parsing lives in `studio/backend/mml/parser.mjs`. Legacy `dist/core.js` remains reusable for exact-rational arithmetic, meter/bar construction, cross-track review and MIDI/ABC preview codecs, but its legacy parser/profile cannot certify Studio Final output.

The symbolic/source arbitration pipeline is now implemented and covered by the combined legacy + Studio regression suite. The only global Studio Final implementation blocker is currently **original-audio alignment**. Individual source files can still be incomplete when they contain unsupported constructs such as unexpanded MusicXML repeats/navigation, grace realization, transposing-part concert pitch, microtones or unpitched mapping.

## Important scope finding

`skills/mabinogi-mobile-mml/` in this repository is **not a complete current SKILL/master-rules package**. It contains the 2026-09-10 Lead Role patch and its master-rules extension. Those files are useful version-controlled rule extensions, but they must not be treated as the complete installed ChatGPT skill/master rule truth.

Studio therefore uses a dated, executable Rule Contract rather than assuming the repository `skills/` directory is complete.

## P0 conflicts found in the legacy Workbench

| Area | Legacy Workbench | Effective Studio rule | Current Studio action |
|---|---|---|---|
| 64th note/rest | `c64`, `r64`, `L64` rejected | plain 1/64 is a legal Mobile boundary | Studio parser accepts plain 64; legacy behavior remains only as drift evidence |
| dotted 64 | legacy rule was not expressed as the current safe-grid boundary | `64.` introduces a sub-1/64 component | Studio rejects dotted 64 |
| Tempo ceiling | accepts through T320 | Mobile final range T32–T255 | Studio accepts T255 and rejects T256+ |
| Error text/tests | encoded old 64th rejection | current rule distinguishes legal 64 from unsafe finer timing | Studio tests cover the current boundary; legacy tests remain historical evidence |
| Profile identity | `mobile-strict-2026-09-08` | rules changed after 2026-09-08 | Studio uses `mabinogi-mobile-mml-studio-rules-2026-09-13` |

External evidence recorded during the audit:
- Nexon community score-making guide documents 1/64 editing and examples using `r64` / `l64`: https://mabinogimobile.nexon.com/Community/Tip/3137150
- Nexon community MML basics documents Tempo 32–255: https://mabinogimobile.nexon.com/Community/Art/3113735
- Current official composition guide documents up to six harmonies and 2,400 MML characters per harmony: https://mabinogimobile.nexon.com/Info/Guide/2751071

## Effective rules that remain preserved

### Exact timing / final syntax
- BigInt rational timing remains canonical for symbolic time.
- Exact event start/end comparison is retained.
- Zero/invalid durations are rejected.
- Plain 1/64 note/rest/default length is accepted.
- Timing below the 1/64 safe grid is not emitted as Final Canonical syntax.
- Double/multiple dots remain rejected.
- Dotted-triplet shorthand (`3.`, `6.`, `12.`, `24.`, `48.`) remains rejected in the current final profile.
- `Nxx` remains excluded from the user's Final Canonical output.
- Studio Final validation requires a source-confirmed meter map; it never silently assumes 4/4.

### Mobile structure
- Six output roles remain Melody + Chord1–Chord5.
- Core3 is Melody / Chord1 / Chord2.
- Chord3–Chord5 are enrichment by default.
- Per-track 2,400-character limit remains enforced.
- O0–O8 and V0–V15 checks remain active.
- Drum conversion requires an evidence-backed Mobile drum-face mapping.

### Validation semantics
- Technical PASS is not source/audio/player/game PASS.
- Real loaded-player readback cannot be replaced by expected values.
- Same-pitch overlap is a review signal, not an automatic deletion command.
- Low/mid m2/M7 and cross-source m9 conflicts require review/arbitration, not automatic deletion.
- Five-/six-track simultaneous attacks are not automatic failures when musically/source supported.
- Natural source rests must not be filled to improve continuity statistics.
- A source reference proves provenance, not cross-source compatibility.

## Current effective musical hierarchy

1. Preserve source-complete material before six-track reduction.
2. Build a Source-Faithful Baseline with traceable source IDs.
3. Keep symbolic truth and audio truth separate:
   - official/credible score, MusicXML and accepted MIDI: exact symbolic event evidence;
   - original official audio: actual role, prominence, sustain, articulation, recording structure and tempo-drift evidence;
   - third-party score/MIDI/MML: supporting arrangement evidence, not automatic pitch truth.
4. Arbitrate Lead role before cleanup. Melody/T1 is **Lead**, not Vocal-only.
5. Core3 must remain independently musical:
   - Melody = Lead
   - Chord1 = Core Harmony / essential inner voice / response
   - Chord2 = Core Bass / low-voice skeleton
6. Chord3–Chord5 enrich Full6 and must not damage Core3.
7. Apply Mobile minimal adaptation only after source reconciliation.
8. Theory/statistical cleanup is last and may not erase source-supported material.
9. Every candidate must diff against the source-faithful baseline and accepted prior version so version drift remains visible.

## Implemented and regression-tested on `studio-v1`

### Current-rule MML parsing
- independent current-rule parser;
- plain `c64`, `r64`, `L64` acceptance;
- dotted `64.` rejection at the sub-1/64 boundary;
- T32–T255 with T256+ rejection;
- 48/128, multiple dots, dotted-triplet shorthand and `Nxx` canonical exclusions;
- source-confirmed meter requirement;
- 1/64 MIDI/ABC preview round-trip coverage.

### Canonical Music IR
- source records with authority and provenance;
- exact note and rest events;
- tempo and meter events;
- decisions kept separate from source events;
- strict source/event reference validation.

### MusicXML ingestion
- score-partwise ingestion with exact `<divisions>` timing;
- chords, rests, `backup`, `forward`, voice/staff, ties/lyrics metadata;
- meter and tempo extraction;
- metronome tempo normalization;
- source-event provenance;
- fail-closed unsupported reporting.

MusicXML repeat/navigation markers (repeat, ending/volta, segno, coda, D.C., D.S., To Coda, Fine) force `complete=false` until canonical playback-order expansion is implemented. Grace realization, transposing-part concert pitch, microtones and unpitched mapping also remain source-specific unsupported cases rather than being guessed.

### Current / historical MML normalization
- each version remains an independent evidence source;
- technically invalid historical MML can be retained as incomplete evidence rather than silently dropped/certified;
- expanded notes become canonical events;
- meaningful silence gaps become explicit inferred-rest evidence;
- Tempo and caller-confirmed meter maps are preserved.

### Version drift
- reports note add/remove/modify, pure role moves, rest changes and Tempo changes;
- compares source baseline → accepted previous → candidate;
- increasing divergence is only a review trigger, never a quality verdict.

### Core3 Continuity Gate
- checks source-relative Core3 removals/modifications/role moves;
- detects source-supported Lead gaps;
- an approved demotion cannot hide a resulting Lead gap;
- true sparse/rest passages are preserved;
- register jumps are diagnostic only.

### Lead Demotion Gate
- `not proven Vocal` is never positive demotion evidence;
- requires source identity, section role, positive destination reason, continuity check and Core3 check;
- accepts structured score/audio role evidence;
- conflicting lead evidence keeps the decision `PENDING`;
- instrumental Lead windows receive extra caution rather than a Vocal-absence penalty.

### Cross-source Harmony Gate
- reviews overlapping disjoint-source same-pitch doubling;
- reviews m2/M7/m9 cross-source risk;
- identifies T4–T6 enrichment conflicts that threaten Core3;
- accepts explicit evidence-backed arbitration decisions without mutating source events;
- compatible cross-source material is left alone.

## Current global Final blocker

`assertRulesReadyForFinal()` currently blocks on:

- `ORIGINAL_AUDIO_ALIGNMENT_PENDING`

The audio layer must not overwrite symbolic truth. Its job is to align recording time to canonical beat time and provide evidence for actual arrangement role, prominence, sustain, articulation, recording structure and Tempo drift.

A song-specific source may still remain `PENDING/UNSUPPORTED` even after the global audio implementation exists. The system must never convert an unsupported source construct into PASS merely because the global module exists.

## Tool / preview scope

- Midify is not a Studio Final Gate; it is N/A by default.
- If a player is used, only actual loaded-engine/readback state is evidence.
- ABC `L:1/4` is a preview/verification convention, not a requirement for source or final MML notation.
- Preview should use a separate Conductor, full expansion, exact bar/tie reconstruction, Tempo Map agreement and the 2% duration sanity check.

## No automatic rule promotion

A website, third-party editor, old report, old song or historical test is evidence only. It does not silently become a master rule. Rule changes require an explicit dated contract update plus regression coverage.
