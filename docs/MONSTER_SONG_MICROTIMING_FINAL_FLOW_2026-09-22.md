# 怪獸之歌 / Monster Song — source microTiming before Final MML delivery (2026-09-22)

Status: IMPLEMENTATION NOTES (not a Canonical rule source; publishes nothing)

Branch `claude/monster-song-source-microtiming-final-flow-e4sjv6`, started from
Published main `8bec72a74f665f7e86533ae895228345c9212efc` (PR #65 merge).

## 0. Identities (kept separate; none substitutes for another)

| Identity | Value | How obtained |
| --- | --- | --- |
| `canonical_version` / status | `2026-09-13-v1` / `PUBLISHED` | Published main `docs/CANONICAL_MANIFEST.md` |
| `manifest_version` | `2026-09-13-v1-manifest1` | same |
| `rules_snapshot_sha` | `0a172900a01fdf39c2e9e84cf176961320b779ea` | same; fetched as a full commit; all six documents loaded from it with correct `Version`/`Status` headers |
| Manifest commit | `5e7666b850a37f1c85ee2dd8cd0f4fac037a9e14` | `git log -1 origin/main -- docs/CANONICAL_MANIFEST.md` on **full** history (the shallow clone reported the wrong commit until unshallowed) |
| origin/main at start | `8bec72a74f665f7e86533ae895228345c9212efc` | `git rev-parse origin/main` after `git fetch --prune` |
| Working branch initial HEAD | `8bec72a74f665f7e86533ae895228345c9212efc` | pushed before any change |
| Production build | `8bec72a…` | `studio_capabilities` self-report; not independent control-plane evidence |
| Checkpoints / PR head | see §7 | Git / PR |

Real-song identities (read-only, zero Studio writes): project
`prj_a808b53c7cafadaf4c6bf5f0fe4c370a`, run `run_faf465f75ad72e943adba4832f88f931`
(`awaiting_review`), candidate
`g11d:rev:fc3c93547c09a668031005bbb67f96a88f109cc6e7f59a5cb0b2dbe5ddb75b63`, baseline
`bas:315eb13d5b82f81a3a20d72986514bb2ee4bc3e70304199f693037b8fb4d7c0d`, selected
source `ast_2ba293828d08c0c7e4b67240fb7dad28` (`third_party_midi`, sha256
`5819c9c5…c23782`).

## 1. Root cause and what `SUBGRID_RELEASE_OFFSET` is

The only symbolic source is a class-C third-party piano MIDI (480 ticks per
quarter). All 1,545 onsets are on the 1/64 grid; 1,544 of 1,545 note-offs are
exactly **one source tick** before a grid point. No admitted Final token sequence
can express such a release: every admitted length is `1/n` of a whole note
(`n` in 1–64) or a single-dotted binary base, so any sum has a denominator
dividing `L = lcm(…)`, whose power of two is 2⁶; a one-tick position has a 2⁷
whole-note denominator. This is arithmetic, not a threshold.

Before this branch the micro-timing gate saw only the 1,282 releases followed by
a one-tick **gap** (1,282 `UNKNOWN` intervals). The 257 releases before a real
rest and the 5 role ends left no sub-grid interval and were invisible to the gate,
while the Final emitter could not write them either.

`SUBGRID_RELEASE_OFFSET` (repository evidence, today):

| Question | Answer |
| --- | --- |
| Published Canonical rule? | **No.** `docs/canonical-candidates/SUBGRID_RELEASE_OFFSET.md` is an `UNPUBLISHED CANONICAL CANDIDATE`, not indexed by the Manifest. |
| Implementation | `canonical/release-regrid-candidate.mjs`, `activeInCanonicalVersions: []`; reviewer/diagnostic tool only; any marked project is refused by Published-v1 enforcement. |
| Category | an unpublished rule *candidate* plus its inactive implementation; its evidence class `SOURCE_ENCODING_PATTERN` is machine-derived pattern analysis. |
| After this branch | unchanged and still inactive; **not required**: the Published-v1 evidence route below resolves the same releases without any rule change. |

## 2. Three layers, kept apart

| Layer | Where | What it holds | What it may decide |
| --- | --- | --- | --- |
| A. Source / performance evidence | Source-Faithful Baseline; `source.*` of each release target; `record.source.end` | the note-off exactly as the source says (e.g. `479/480` beat, `endTick`) | nothing — it is never rewritten |
| B. Analysis precision | `canonical/release-timing.mjs` (`analyzeReleaseTiming`) | exact position class, offset to the grid (beats, ticks; seconds only with a Tempo Map), following shape, repeated-attack flag, both 1/64-safe options with their exact effects, a minimal-change recommendation, and the encoding pattern as an **observation** | nothing — the recommendation is arithmetic, never a musical verdict |
| C. Mobile Final representation | Mobile Adaptation v1, `release_representation` | a release moved to an adjacent 1/64 grid point by a reviewer decision; record with source release, Final release, decision id, exact reversal | only through a decision whose evidence is admissible |

Admissible evidence for a representation decision (SOURCE_POLICY §1): a **human**
reviewer attesting an **independent primary** source of the matching kind —
an official score/MIDI (`primary-symbolic`), or the original recording by
**listening** (`primary-audio`). Recorded and never counted: agent/tool
attestations, third-party sources, the encoding pattern, audio metrics, tool
output, and an accepted prior (no record exists to bind it to). A primary asset
whose bytes equal a supporting asset's is a relabelled copy
(`EVIDENCE_SOURCE_NOT_INDEPENDENT`).

Options are evaluated, not chosen: `EXTEND_TO_NEXT_GRID` closes the one-tick gap,
shortens a real rest by one tick or moves a role end; `TRUNCATE_TO_PREVIOUS_GRID`
inserts a new ≥1/64 rest (a new articulation). An option that would move an
attack, enter an explicit rest, leave a sub-grid note or rest, or create a new
cross-role same-pitch overlap is invalid. No option adds a tie, merges a repeated
attack or removes a rest. A keep claim makes the release UNSUPPORTED in Final
(never adapted); the technical gate then refuses emission, as before.

## 3. What changed (by checkpoint)

**A — `e27aa9a`** `canonical/release-timing.mjs`; micro-gap enforcement adds
`MICRO_TIMING_RELEASE_NOT_FINAL_REPRESENTABLE` only for releases the interval
analyzer cannot see, and `MICRO_TIMING_RELEASE_REPRESENTATION_RECORD_INVALID`
(FAIL) for a record that does not re-verify. Projects Final can express keep their
blocker list byte for byte; the G10 three-way outcome is unchanged.

**B — `2586722`** Mobile Adaptation v1 accepts `releaseRepresentation` with or
without a profile. Lead evidence identity reads a represented note through its
recorded source release (only that), and the Lead context digest reads an EXTEND
release at its source value — otherwise every Raw-MIDI Melody promotion would go
stale the moment its release was represented. The version diff pairs a role move
plus release change as one modified event (traceable). The run's
`mobile_adaptation` input takes `profile` and/or `release_representation`; a run
with neither records a read-only release summary and what the missing profile
blocks; the `microTiming` hint names the operation that can answer it (the
finalize-time repair cannot: finalize refuses a blocked gate first). MCP/HTTP pass
it through.

**C — `9af0317`** Readiness states `songState` (`CANDIDATE` / `VALIDATED` /
`IN_GAME_ACCEPTED`, ACCEPTANCE_CRITERIA vocabulary). The Final artifact carries
`song_state`, `mml_sha256` and a `delivery` block (Canonical identity it was
validated under; listening feedback and in-game as non-blocking post-delivery
evidence). The emitter writes a long silence exactly as whole-note rests plus an
exact remainder (rests only; the tie-bounded note search is unchanged) — the
Kaiju Chord4 rests of 89.5 and 96 beats were an independent Gate 1 blocker.

**D — this section's commit** real-song E2E script and receipt, and these notes.

## 4. Real E2E — 《怪獸之歌》 (furthest truthful state)

`scripts/studio-release-timing-e2e.mjs` rebuilt the real candidate from the four
`studio_baseline_events` pages and the applied 298-decision proposal (digests
`c9eecab2…` / `65074eaf…`, identical to the committed receipt) in an isolated
store and drove **the existing Studio run** over it. The reconstruction's
`unknownIntervals` value is byte-identical to production's (`23f23907…`).
Receipt: [release-timing-e2e.json](evidence/monster-song-microtiming-2026-09-22/release-timing-e2e.json).

| Stage | Result |
| --- | --- |
| intake → suggest → apply_decisions | completed (1,545 events; 298 lane/section `ASSIGN_ROLE` decisions, all provisional) |
| final_reduction | skipped — every source event already retained |
| mobile_adaptation | skipped — no profile, no release decision; receipt names what each would answer |
| review | `awaiting_input`; song state **`CANDIDATE`** |
| finalize | refused before emission; no MML, no artifact |

Release analysis (Layer B): 1,545 releases; 1,544 `NOT_FINAL_REPRESENTABLE`
(Melody 568, Chord1 209, Chord2 641, Chord3 119, Chord4 7); every offset is
exactly 1 tick; following shapes 1,282 sub-grid gap / 257 real rest / 5 role end;
262 were invisible to the gate before; EXTEND is the minimal valid representation
for all 1,544 (0 without a valid representation); 331 targets precede a
same-pitch repeated attack (kept as two attacks). No Tempo Map is exported, so no
seconds are claimed.

Evidence the project holds, graded by the same function the stage uses:

| Citation shape | Admissible? | Why |
| --- | --- | --- |
| `official_midi` `ast_62c0…` as primary-symbolic | no | `EVIDENCE_SOURCE_NOT_INDEPENDENT` — byte-identical to the third-party MIDI |
| third-party MIDI / uniform one-tick pattern | no | `EVIDENCE_CLASS_NOT_ADMISSIBLE` |
| original audio cited by an agent | no | `ATTESTATION_NOT_HUMAN_REVIEWER_EVIDENCE` |
| original audio from an alignment metric | no | `AUDIO_BASIS_NOT_LISTENING` (the active report is also low-confidence, 0.456) |
| original audio with a **human listening** attestation | **would be** | no such attestation exists |

**microTiming decision:** `PENDING`. The exact evidence that would resolve it
without any Canonical change: a human listening review of the original recording
(`ast_6154…` / `ast_bf88…`, sha256 `35a05318…`) stating, per window, that the
releases carry no audible separation — or an independent official score. The
run's `mobile_adaptation.release_representation` input takes it; everything after
it is deterministic.

Counterfactual (labelled `COUNTERFACTUAL_NOT_A_RESULT`; placeholder audio, a
hypothetical attestation, a hypothetical T150 and 2/4→4/4 meter): all 1,544
releases represented (1,282 gaps closed, 257 rests shortened by one tick, 5 role
ends), micro-timing `PASS` with 1,544 re-verified records, and all six roles
serialise with an exact round trip (Melody 1,096 / Chord1 816 / Chord2 1,472 /
Chord3 671 / Chord4 209 / Chord5 0 characters), and the Gate 4 completeness
residue (`CORE3_ENRICHMENT_DEPENDENCE_UNRESOLVED`) clears to `PASS` because the
one-tick Core3 gaps it depended on are closed. Lead promotion stays `PENDING`
(no Lead evidence) and the song state stays `CANDIDATE`.

### Final Gate matrix (this branch, real data)

| Gate | State | Blocker / missing evidence |
| --- | --- | --- |
| 0 Intake / version | PENDING (Web-only gate) | recording version / offset / range not confirmed |
| 1 Technical | NOT_RUN | upstream gates; serialisation itself is no longer blocked by Chord4 |
| 2 Source | PENDING | `source_complete` (human, with evidence) |
| microTiming | **PENDING** | human listening review (or independent official score) per window |
| 3 Lead promotion | PENDING | 569 provisional Melody events; no Lead evidence in the decisions |
| 4 Core3 completeness | PENDING | `CORE3_ENRICHMENT_DEPENDENCE_UNRESOLVED` (the one-tick gaps; a release representation or a human Gate 4 review answers it) |
| 5 Full6 / cross-source | PASS (machine-derived) | — |
| 6 Tempo / preview / player | NOT_RUN | no Tempo Map exported; player readback PASS or N/A-with-reason |
| 7 Original audio | PENDING | better-aligned report + human Gate 7 review |
| 8 Mobile adaptation | PENDING | release decision; cited target profile for register/volume (volumes undecided); human Gate 8 review |
| 9 Regression | PENDING | human Gate 9 review; Rashisa `FIXTURE_PENDING` |
| 10 In-game | PENDING | user / controlled client only |

**Whole-song state: `CANDIDATE`.** `VALIDATED` was not reached and no paste-ready
MML was produced for the real song: several required non-game gates need human or
primary evidence that does not exist. Nothing was fabricated to move them.

## 5. What this does not claim

- Published Canonical is unchanged; the Manifest, the four rule sources, the
  inventory and the evidence index are untouched.
- Human listening, in-game acceptance and every human review remain not provided.
- The synthetic regressions prove the workflow, not the song.

## 6. Canonical follow-up

`NO_CANONICAL_CHANGE_NEEDED` for this work: MASTER_RULES §7 already permits
normalising a technical micro-gap, MOBILE_SYNTAX §4 already forbids it in Final
without source-supported meaning, SOURCE_POLICY §1 already names the sources that
can establish articulation, and Gate 8 already requires adaptations to be minimal
and evidence-backed. This branch implements that route; the unpublished
`CANDIDATE-2026-09-22-SUBGRID-RELEASE-OFFSET` stays unpublished and is not a
prerequisite.

## 7. Checkpoints

| Checkpoint | Commit |
| --- | --- |
| A source / analysis layers | `e27aa9a` |
| B evidence-gated Mobile release representation | `2586722` |
| C VALIDATED song state, delivery identity, exact long rests | `9af0317` |
| D real-song E2E and notes | the commit adding this file (read the PR head from the PR) |
