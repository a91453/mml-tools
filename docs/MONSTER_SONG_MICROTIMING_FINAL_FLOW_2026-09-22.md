# 怪獸之歌 / Monster Song — source microTiming before Final MML delivery (2026-09-22)

Status: IMPLEMENTATION NOTES (not a Canonical rule source; publishes nothing)

> **Correction, 2026-09-23 — read §8 first.** The first version of this work
> (checkpoints A–D and `9e6d07d`) made release evidence count only when a
> **human** submitted it (`ATTESTATION_NOT_HUMAN_REVIEWER_EVIDENCE`,
> `AUDIO_BASIS_NOT_LISTENING`). No Published Canonical rule says that; it was an
> implementation assumption. §2 and §4 below are kept as written, with the
> superseded statements marked; §8 describes the corrected model and the re-run.

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

*(Superseded by §8: who submits a decision is provenance, not authority.)*
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

Evidence the project holds, graded by the same function the stage uses
*(first version; superseded by §8, where every row is graded identically for a
human and an AI submitter)*:

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

### Known limits (stated, not hidden)

- **Caution-lattice positions are out of scope.** "Not Final-representable" is
  proved against the full admitted lattice, caution lengths included, but
  Finalize emits without the caution opt-in. A release two 480-tpq ticks before
  the grid (1/960 whole note) is `CAUTION_REPRESENTABLE`, is not a representation
  target, leaves micro-timing `PASS`, and fails closed at emission with
  `DURATION_SEARCH_POLICY_LIMIT` (pinned by RT-21). The real song's releases are
  all exactly one tick early and are not affected.
- **Evidence is re-checked, not re-authenticated.** Review and Finalize rebuild
  the evidence registry from the project's current sources and assets and
  re-grade every recorded citation against it (RT-19, RRA-5): a cited asset that
  becomes byte-identical to a supporting file, or disappears, turns the record
  invalid and the gate `FAIL`. A `direct-source-review` basis is the submitter's
  statement, whoever the submitter is; nothing here can verify that the review
  happened.
- **Without a profile**, role-assignment and drum-face questions are asked only
  of notes a release change touches (RT-20); a release change on a percussion
  note is refused with `DRUM_FACE_MAPPING_REQUIRED`.

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
| D real-song E2E and notes | `870f7bb` (then `b3679de`, `9e6d07d` review fixes) |
| E evidence authority decoupled from submitter type (§8) | the commit adding §8 (read the PR head from the PR) |

## 8. Follow-up 2026-09-23 — evidence authority is not the submitter's type

Published Canonical re-loaded from main's Manifest before this change:
`2026-09-13-v1`, `rules_snapshot_sha` `0a172900…`, Manifest commit `5e7666b8…`;
origin/main and the PR base still `8bec72a7…`; none of the six indexed documents
is changed by this branch.

### What was wrong

`gradeReleaseEvidence` refused any decision whose `attestation.reviewer_kind`
was not `human` (`ATTESTATION_NOT_HUMAN_REVIEWER_EVIDENCE`) and any primary-audio
item whose `audio_basis` was not `listening` (`AUDIO_BASIS_NOT_LISTENING`). The
Published rules name no reviewer species for source evidence: SOURCE_POLICY §1
assigns authority to *sources* (official symbolic for onset and duration; the
original recording for sustain and articulation), §6 limits *metrics* to
locators, and the only actor-bound rule is ACCEPTANCE Gate 10 (in-game
acceptance: the user or a controlled client). So a provider-neutral client — a
conversational AI through MCP — citing an independent official score was refused
for being an AI, while the rule that matters (a metric is not a finding) was
expressed as "not listening", as if only human ears could read a recording.

### Corrected model (`canonical/release-timing.mjs`)

| Concept | Field | Effect on the grade |
| --- | --- | --- |
| Provenance — who submitted | `attestation: { reviewer, reviewer_kind: human \| agent \| tool \| mcp-client \| imported }` | none; recorded and required for the audit trail (`DECISION_PROVENANCE_MISSING` if absent, for anyone) |
| Source — what is cited | `evidence[].class` + `ref`, resolved in the project's registry | primary-symbolic / primary-audio only; kind must match; must be independent of every supporting file |
| Basis — how the finding was derived | `evidence[].basis` | only `direct-source-review` establishes a finding; `machine-metric`, `alignment-locator` (SOURCE_POLICY §6), `encoding-pattern`, `imported-assertion` are recorded and never counted |
| Claim — what the representation asserts | derived: EXTEND → `SOURCE_EVENT_SUSTAINS_TO_GRID_POINT`, TRUNCATE → `SOURCE_EVENT_RELEASES_BY_PREVIOUS_GRID_POINT` | the cited class must be one SOURCE_POLICY lets support it (§1A onset/duration, §1B sustain/articulation: both do) |

Unchanged: third-party files, the encoding pattern, metrics, tool output and an
accepted prior (no record to bind) never count; a relabelled copy is not
independent; stored decisions are re-graded against the project's *current*
registry at every review and finalize (RT-19, RRA-5), whoever submitted them; a
decision carries no field that can set a gate, and nothing on this path can set
`IN_GAME_ACCEPTED` (RT-19b, RDR-4). A decision-level `audio_basis` from the first
schema is still read as the default basis of a primary-audio item, with its
human-only meaning removed. The service verifies the cited source; it cannot
verify the act of review, for a person or an AI alike.

When releases still need a decision, the micro-timing gate now says what would
settle them from the sources the project holds — `MICRO_TIMING_RELEASE_EVIDENCE_REQUIRED`
with `releaseEvidenceRequirement.anyOf`: `ORIGINAL_AUDIO_ARTICULATION_REVIEW_REQUIRED`
or `ORIGINAL_AUDIO_SOURCE_REQUIRED`, and `INDEPENDENT_SYMBOLIC_SOURCE_REVIEW_REQUIRED`
or `INDEPENDENT_SYMBOLIC_SOURCE_REQUIRED` — never who must submit it.

Regressions: RT-8 (encoding pattern, any submitter), RT-9 (every submitter kind
grades identically; weak evidence stays weak for a person; metrics and locators
stay locators for anyone; legacy schema), RT-9b (requirement), RT-10 (a metric
moves nothing; AI and human submissions plan identical changes), RT-11 (editing
the submitter changes nothing; editing a basis to a metric invalidates), RT-19 /
RT-19b (re-verification for any submitter; no gate-setting fields), RRA-1/2/3,
RDR-2/3 (an AI-submitted decision reaches a VALIDATED Final; human- and
AI-submitted runs deliver byte-identical MML).

### Kaiju, re-evaluated from the real evidence

Re-read 2026-09-23 (read-only `studio_project_get`, report `6c7ee26b…`): the
project is unchanged since 2026-09-22 15:59 — the same five assets, two alignment
reports, no artifact. The E2E was re-run through the existing Studio run;
receipt: [release-timing-e2e.json](evidence/monster-song-evidence-authority-2026-09-23/release-timing-e2e.json)
(`unknownIntervals` still byte-identical to production `23f23907…`; exports,
release analysis and finalize identical to the first receipt).

| Question | Answer from the evidence |
| --- | --- |
| Intentional articulation? | **Undetermined** — no primary-source finding about these releases is on record. |
| Encoding artifact / technical micro-gap? | **Undetermined** — the uniform one-tick pattern is an observation about the third-party file; it is not read as meaningless for being uniform or for being one tick. |
| Does any subset differ? | No. 1,282 close a one-tick gap before the next attack, 257 shorten a real rest by one tick, 5 are role ends, 331 precede a same-pitch repeated attack (kept as two attacks); every subset asks the same source question. |
| Is EXTEND justified? | **Not yet.** It is the minimal valid option for all 1,544 arithmetically; the claim it makes has no admissible finding. |
| Original audio available? | Yes — one recording, `35a05318…` (`ast_6154…`, `ast_bf88…`), independent. |
| Does the audio evidence on record support the claim? | No. The only audio evidence is the alignment report `342aea74…` (confidence 0.456, `LOW_ALIGNMENT_CONFIDENCE` + `LOW_SCORE_FRAME_COVERAGE`): a locator (§6), and a weak one, so even the recording-time locations of the 41 release windows are unreliable (Gate 0 recording version and Gate 7 are open). The audio worker implements alignment only; no articulation analysis exists, and any metric would still be a locator. |
| Independent symbolic source? | No — `official_midi` `ast_62c0…` is byte-identical to the third-party MIDI. |
| Accepted prior version? | No — none exists, and no Final was ever delivered. |
| Still insufficient? | **Yes.** |

Every probe grades identically for a human and an AI submitter
(`same_grade_for_every_submitter: true` for all ten).

**microTiming: `PENDING`**, blocker `MICRO_TIMING_RELEASE_EVIDENCE_REQUIRED`, any
one of: `ORIGINAL_AUDIO_ARTICULATION_REVIEW_REQUIRED` (a direct review of the
recording at each window, stating whether the note is held to the grid point or
released before it — from anyone able to review it) or
`INDEPENDENT_SYMBOLIC_SOURCE_REQUIRED` (none held). Who submits it is not a
blocker. This session did not supply the review: it has no access to the
recording's sound, and a metric it could compute would be a locator.

The rest of the Final Gate matrix (§4) is unchanged in substance: Gate 0 version
confirmation, Gate 2 `source_complete` with evidence, 569 provisional Lead events
without Lead evidence, Gate 4 completeness (answered by the release
representation, per the counterfactual), Gate 7 (a better alignment and a review),
Gate 8 (the release decision, a cited profile for the undecided volumes, a
review), Gate 9 review and player readback. Each needs evidence that does not yet
exist; none of them is blocked by who may supply it in this path. **Song state:
`CANDIDATE`; no MML was produced.** The counterfactual (a hypothetical direct
review, submitted under an *agent* provenance) behaves as before: 1,544 records
re-verified, micro-timing and Gate 4 completeness `PASS`, six roles serialise
with an exact round trip (1,096 / 816 / 1,472 / 671 / 209 / 0), still `CANDIDATE`.

### Found, not changed here

`application/lead-review-authority.mjs` (on main since `f020b95`) applies the same
pattern to Lead evidence reviews: only a `human` attestation reaches the Lead
grader. It predates this PR and governs a different gate; changing it is a
separate decision. For Kaiju it changes nothing today — no Lead evidence of any
kind has been submitted.
