# Mabinogi Mobile MML Studio — Rule Audit

Date: 2026-09-13
Branch: `studio-v1`

## Decision

The existing Workbench implementation is reusable **implementation**, but it is not the rules authority for Studio v1.

`legacy-v0.2.0` and `main` remain untouched. Studio rules are now centralized in `studio/backend/rules/index.mjs` and the Studio Final Gate is deliberately blocked while known P0 legacy drift remains.

## Important scope finding

`skills/mabinogi-mobile-mml/` in this repository is **not a complete current SKILL/master-rules package**. It currently contains the 2026-09-10 Lead Role patch and its master-rules extension. The repository README already warns that these files are merge-ready rule extensions and must not be treated as proof that an external/installed full skill has been replaced.

Therefore no Studio code may infer that the GitHub `skills/` directory is the complete rule truth.

## P0 conflicts found

| Area | Legacy Workbench | Effective Studio rule | Action |
|---|---|---|---|
| 64th note/rest | `c64`, `r64`, `L64` are rejected | 1/64 is a legal Mobile boundary; sub-1/64 technical timing remains rejected | Block legacy validator as Final authority; migrate parser/profile |
| Tempo ceiling | accepts through T320 | Mobile final range is T32–T255 | Block legacy validator as Final authority; migrate parser/profile |
| Error text | says `48/64` are both unavailable | 64 is legal; 48 remains outside the current safe canonical output set | replace during parser migration |
| Tests | regression test expects `c64/r64/L64` rejection | tests must expect 64 acceptance after migration | old test remains historical until parser migration; Studio drift test prevents accidental Final use |
| Profile identity | `mobile-strict-2026-09-08` | effective rules changed after 2026-09-08 | legacy profile cannot certify current Final output |

Current external evidence used for the syntax boundary:
- Nexon community score-making guide: 1/64 editing and examples containing `r64`/`l64`; explains Mobile recognition down to 64th-note resolution: https://mabinogimobile.nexon.com/Community/Tip/3137150
- Nexon community MML basics: Tempo 32–255: https://mabinogimobile.nexon.com/Community/Art/3113735
- Current official composition guide confirms up to six harmonies and 2,400 MML characters per harmony: https://mabinogimobile.nexon.com/Info/Guide/2751071

## Rules that remain valid and should be preserved

### Exact timing / parser engineering
- BigInt rational timing is correct and should stay.
- Exact event start/end comparison should stay.
- Zero/invalid duration rejection should stay.
- Double/multiple dotted final syntax rejection should stay.
- Dotted-triplet shorthand (`3.`, `6.`, `12.`, `24.`, `48.`) remains rejected in the current canonical final profile.
- `Nxx` remains excluded from the user's Final Canonical output. Do not reintroduce it merely because third-party Mobile tools can support N notation.

### Mobile structure
- Six fixed output slots remain Melody + Chord1–Chord5.
- Per-track 2,400-character limit remains current official Mobile behavior.
- O0–O8 and V0–V15 checks remain useful.
- Drum notes require an evidence-backed Mobile drum-face mapping before conversion to GM preview percussion.

### Validation semantics
- Technical PASS is not source/audio/player/game PASS.
- Real loaded-player readback must not be replaced by expected values.
- Same-pitch overlaps are review items, not automatic deletion commands.
- Low/mid m2/M7 conflicts are review items requiring musical/source arbitration.
- Five-/six-track simultaneous attacks are not automatic failures when source/music supports the accent.
- Natural rests must not be filled merely to improve continuity statistics.

## Current effective musical hierarchy

1. Preserve source-complete material before six-track reduction.
2. Build a Source-Faithful Baseline with traceable source IDs.
3. Separate symbolic truth from audio truth:
   - official/credible score, MusicXML and accepted MIDI: exact symbolic event evidence;
   - original official audio: actual role, prominence, sustain, articulation, recording structure and tempo-drift evidence;
   - third-party score/MIDI/MML: supporting arrangement evidence, not automatic pitch truth.
4. Arbitrate Lead role before cleanup. Melody/T1 is **Lead**, not Vocal-only.
5. Core3 must remain independently musical:
   - Melody = Lead
   - Chord1 = Core Harmony / essential inner voice / response
   - Chord2 = Core Bass / low-voice skeleton
6. Chord3–Chord5 enrich Full6 and must not damage Core3.
7. Apply Mabinogi Mobile minimal adaptation only after source reconciliation.
8. Theory/statistical cleanup is last and may not erase source-supported material.
9. Every later candidate must diff against the source-faithful baseline and accepted prior version so version drift is visible.

## Tool / preview scope

- Midify is not a Studio Final Gate. Current workflow treats it as N/A by default.
- If a player is used, only its actual loaded engine state/readback is evidence.
- ABC `L:1/4` is a preview/verification convention, **not** a rule that the musical source or final MML must be written with L4.
- Preview should use a separate Conductor, full expansion, exact bar/tie reconstruction, Tempo Map agreement and the 2% duration sanity check.

## Not yet implemented — must not be claimed as PASS

- MusicXML → Canonical IR ingestion.
- Current/history MML → source-aware Canonical IR normalization.
- source-faithful baseline diff and automatic version-drift report.
- full Core3 Continuity Gate.
- Lead Demotion Gate as executable code.
- original-audio alignment / Tempo drift analysis.
- cross-source harmony arbitration.
- final 1/64-aware replacement of the legacy parser profile.

Until the legacy syntax drift is migrated, `assertRulesReadyForFinal()` intentionally throws and Studio must not label a generated score Final.

## No automatic rule promotion

A website, third-party editor, old report, old song, or historical test is evidence only. It does not silently become a new master rule. Rule changes require an explicit dated contract update plus regression coverage.
