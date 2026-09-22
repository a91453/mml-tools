# 怪獸之歌 / Kaiju — final remediation (2026-09-22)

Status: IMPLEMENTATION NOTES (not a Canonical rule source; publishes nothing)

Branch `claude/kaiju-final-remediation-sbth4h`, started from Published main
`ae15e5fc11eea5486d5f6c7fe3b243f9549168c2` (PR #64 merge). PR #64's Railway
audit/gate architecture is not touched.

## 0. Identities (kept separate; none substitutes for another)

| Identity | Value | How obtained |
| --- | --- | --- |
| `canonical_version` / status | `2026-09-13-v1` / `PUBLISHED` | Published main `docs/CANONICAL_MANIFEST.md` |
| `manifest_version` | `2026-09-13-v1-manifest1` | same |
| `rules_snapshot_sha` | `0a172900a01fdf39c2e9e84cf176961320b779ea` | same; verified as a full commit, ancestor of main; all six documents loaded from it with correct headers |
| Manifest commit | `5e7666b850a37f1c85ee2dd8cd0f4fac037a9e14` | `git log -1 origin/main -- docs/CANONICAL_MANIFEST.md` on **full** history (a shallow clone returned the wrong `85c049c…`) |
| Repository main HEAD | `ae15e5fc11eea5486d5f6c7fe3b243f9549168c2` | `git rev-parse origin/main` |
| Production build / deployed source | `37ddf414ee90abfb78109dfc1e6a8a43cb85e35c` | `studio_capabilities` self-report (PR #63 merge; not independent Railway control-plane evidence) |
| Working-branch checkpoints / PR head | see §6 | Git |

`scripts/bootstrap-canonical.mjs --summary` → `CANONICAL_LOADED`.

Kaiju identities (full values re-read from production, never guessed):
project `prj_a808b53c7cafadaf4c6bf5f0fe4c370a`, run
`run_faf465f75ad72e943adba4832f88f931` (revision 16, `awaiting_review`),
candidate `g11d:rev:fc3c93547c09a668031005bbb67f96a88f109cc6e7f59a5cb0b2dbe5ddb75b63`,
baseline `bas:315eb13d5b82f81a3a20d72986514bb2ee4bc3e70304199f693037b8fb4d7c0d`,
selected source asset `ast_2ba293828d08c0c7e4b67240fb7dad28`
(`third_party_midi`, sha256 `5819c9c5…c23782`). All Studio access in this work was
read-only; zero writes.

## 1. Checkpoint A — microTiming

### A1. Reproduction (production evidence, machine-verified)

The source MIDI is not available in this environment. The candidate was rebuilt
instead from production read exports — all 1,545 baseline events (exact ids,
pitch, timing, voice) and the 298 accepted decisions — through the unchanged
Canonical IR intake → suggestion → decision application → review
(`scripts/studio-microtiming-audit.mjs`). The rebuilt micro-timing gate value is
**byte-identical** to production's:
`review.readiness.gates.microTiming` value SHA-256 `de4dc41b…d7df7`
(2,994,319 UTF-16 units) and `unknownIntervals` `23f23907…3cd3` both match the
service's `report_page` `value_sha256`. Receipt:
[microtiming-audit.json](evidence/kaiju-final-remediation-2026-09-22/microtiming-audit.json).

| Finding | Value |
| --- | --- |
| UNKNOWN intervals | 1,282 — all `inter-event-gap`, all exactly 1/480 beat (one source tick), all note→note |
| Role pairs | Melody 556 · Chord2 640 · Chord1 77 · Chord3 9 (Lead, Core3 and enrichment all affected) |
| Next onset | on the 1/64 safe grid in 1,282 / 1,282 |
| Previous note | duration + 1 tick is a grid multiple in 1,282 / 1,282 (239, 479, 719 … ticks) |
| Same-pitch repeated attacks across the gap | 296 (must remain two attacks) |
| Position | every song-position decile holds 112–155 intervals of the identical shape |
| **Whole source** | 1,545 / 1,545 onsets on grid; **1,544 / 1,545 releases exactly one tick before the grid**; the single exception (`0:1715`) ends on the grid |
| Release boundaries per role stream | 1,282 sub-grid gaps (reported) + **257 note→rest** boundaries where the rest is grid + 1 tick + **5** role ends (both **not** reported by the analyzer) |

Classification of the gaps against the prompt's hypotheses: not a parser/IR
round-trip artifact (event times reproduce the exported source ticks exactly);
not quantization residue of this pipeline (nothing here quantizes); not
evidence of intentional articulation in any source we hold (the only symbolic
source is class-C third-party MIDI; no primary score). It is a uniform
note-release encoding of the source MIDI — a *pattern observation*, not a
Canonical classification.

Consequence that was not visible before: resolving the 1,282 UNKNOWNs alone
would **not** make Kaiju emittable. The 257 off-grid rest boundaries and 5 role
ends have no exact Final decomposition either (the exact duration planner finds
no plan for 239/480, 241/480, 1441/480 … beats; with a 480-tick grid denominator
of 2⁵·3·5 none exists, since no admitted token carries a 2⁵ factor). The
emitter fails closed on them; readiness does not count them.

### A2. Does Published v1 decide it? — **No**

Published v1 forbids a meaning-free sub-1/64 micro-gap in Final
(`MOBILE_SYNTAX §4, §11.5`) and *permits* normalizing it (`MASTER_RULES §7`),
but leaves two decisions open (full analysis in the candidate document):

1. **Classification authority** — nothing says what evidence shows a
   note-preceded gap has *no* musical meaning when the only symbolic source is
   third-party (`SOURCE_POLICY §1`: official symbolic sources are the authority
   for duration; class C can prove neither meaning nor its absence).
2. **Transformation** — extending the release by 1/480 and truncating it to the
   previous grid point are both normalizations; moving the onset is forbidden;
   Gate 1 "exact timing preserved" is contradicted by both remaining options.

So no single unambiguous algorithm is authorised. The existing implementation
already refuses the note-preceded case (`TECHNICAL_TIMING_REPAIR.md §13`), and
that refusal is the Published-v1-compliant behaviour.

**Decision:** an **UNPUBLISHED CANONICAL CANDIDATE** —
[docs/canonical-candidates/SUBGRID_RELEASE_OFFSET.md](canonical-candidates/SUBGRID_RELEASE_OFFSET.md)
(`CANDIDATE-2026-09-22-SUBGRID-RELEASE-OFFSET`) — with rationale, evidence class
(`SOURCE_ENCODING_PATTERN`, machine-derived), precise scope (uniform whole-source
one-tick release offset), treatment (release + δ to the grid), exceptions, tie
semantics, meaningful-rest protection, regression and implementation impact, and
rollback. The Manifest is not changed.

Candidate implementation (inactive): `studio/backend/canonical/release-regrid-candidate.mjs`.
Published-v1 fail-closed guard: `enforceMicroGaps` now appends
`MICRO_GAP_UNPUBLISHED_CANONICAL_CANDIDATE` for any project carrying a candidate
marker (project or event level), so readiness and the Final emitter refuse it.
Unmarked projects' blocker lists are byte-identical to before.

Candidate-only evaluation on the reproduced Kaiju candidate: 1,544 releases
planned (1,282 gaps closed, 257 rests shortened by exactly one tick and still
≥ 1/64, 5 role ends), 0 refusals, 0 invariant violations, 0 remaining
micro-timing intervals; Published-v1 enforcement on the result: `PENDING`
(`MICRO_GAP_UNPUBLISHED_CANONICAL_CANDIDATE`).

A hypothetical emission (markers stripped, an assumed T150 added because the
export has no tempo map — **not a result**) serialises Melody/Chord1/Chord2/Chord3
at 1,096/816/1,472/671 characters but still `FAIL`s on Chord4: two very long rests
(179/2 and 96 beats) exceed the bounded exact duration search
(`DURATION_SEARCH_POLICY_LIMIT`). That is an independent Gate 1 blocker.

**Publication is required before Kaiju can pass Gate 1 / Final under this
candidate.** The no-rule-change alternative is a primary symbolic source for the
song that states the nominal durations.

### A3. Tests

`studio/tests/release-regrid-candidate.test.mjs` (`RRC-1`…`RRC-16`): true rest
survives; sub-grid rest refused; repeated same-pitch attacks survive untied
through emission; sustain vs re-attack; no onset crossing; no new same-pitch
overlap; non-uniform source and off-grid onset refuse the whole source; any keep
decision (accepted/pending/rejected) refuses; per-role Lead/Core3 ids, pitches
and onsets identical; emission round-trip and exact reversal; no double
application; invariant net; no drift on pattern-free projects. Seven deliberate
mutations were each caught. Existing micro-timing, repair, emitter and readiness
suites: 450/450 pass unchanged.

| Axis | Before | After checkpoint A |
| --- | --- | --- |
| microTiming (Published v1) | PENDING, 1,282 UNKNOWN, cause undocumented | **PENDING** (unchanged, correct); cause proven; scope corrected to 1,544 off-grid releases; Canonical decision required and drafted as an unpublished candidate |

## 2. Checkpoint B — Lead evidence

### B1. Audit of every Lead decision

Inputs: the 174 stored Lead reviews exported from production
(`review.lead_evidence_reviews`, 325,017 units, value SHA-256 `2646aab8…a6ba23`,
matching the service) and the 569 Melody events of the reproduced candidate.
Classes are kept separate — no confidence score
([lead-review-queue.json](evidence/kaiju-final-remediation-2026-09-22/lead-review-queue.json),
`scripts/studio-lead-review-queue.mjs`):

| Class | Lead decisions | Basis |
| --- | --- | --- |
| sufficiently source-supported | **0** | no primary symbolic source is bound to any event; the only symbolic source is class-C third-party MIDI |
| human-confirmed | **0** | no stored review carries any reviewer attestation; all 174 were written 14:57–16:13 UTC by the previous agent session |
| weak machine evidence | **150** | "harmonic CQT salience … at candidate MIDI n pitch class" — no reproducible method; not a role measurement |
| F0 / pitch-class-only | **3** | the song opening: predominant pitch one octave below the event, same pitch class (voice-vs-piano octave); plus a third-party Yamaha arrangement note ("no intro, begins with vocal") that is not a project source |
| audio locator only | **0** | — |
| contradictory evidence | **21** | the review's **own** measured pitch (predominant/pYIN) lies two or three octaves below the event (MIDI 40–57, bass/low register) while claiming the event is the foreground |
| unresolved / missing evidence | **395** | no review at all |

All 174 records also self-assert `sectionRole: vocal-active`, `core3: PASS`
(a record field, not a Gate 4 result) and — in 171 — state that the purchased
score/MIDI bytes were **not inspected**. Every Melody event is the highest
sounding pitch at its onset; that is a symbolic observation from a third-party
MIDI, and "highest note ⇒ Vocal/Lead" is a forbidden shortcut (`MASTER_RULES §4`).

### B2. False authority removed (representation + derivation)

Before: a stored review carried no statement of who made it or how its audio
classification was established, so these agent-authored F0/CQT reviews were graded
exactly like human listening and produced **174 PASS**. Fix (`f020b95c`):

- `reviewLeadEvidence` requires `attestation { reviewer, reviewer_kind:
  human|agent|tool, audio_basis: listening|machine-metric|not-used }`, validated
  against the audio evidence; the authenticated owner is stored beside it.
- Only `human` reviews reach the shared Lead grader (review **and** finalize);
  agent/tool and unattested historical reviews stay on record unchanged and are
  reported `countedAsReviewerEvidence: false` with a per-class summary.
- The grader never counts a `machine-metric` audio classification as positive
  role evidence (SOURCE_POLICY §6); it can still raise a conflict.

Proof on the real data: the byte-faithful reproduction with the 174 exported
reviews seeded (Lead context digest identical to production) grades
**PASS 174 / PENDING 395 on main's code** — exactly production — and
**PASS 0 / PENDING 569 on this branch**; all 174 records remain, reported as
`UNATTESTED_LEGACY_NOT_REVIEWER_EVIDENCE`. No record was deleted or rewritten;
no Studio write was made.

Remaining representation gap (documented, not changed here): a Lead citation
embedded in `applyDecisions.leadEvidence` still carries only `acceptedBy` text.
The attestation is caller-declared text; it makes a false "human" claim explicit
and attributable, it does not prove a human listened.

### B3. Human review surface

`lead-review-queue.json` (public form: no raw citation text, no absolute pitches;
full form reproducible from the exports) gives, for all 569 events: stable event
and source-event identity, lane, onset beat, current role (Melody) and proposed
role (none), the accepted decision and section that assigned it, the symbolic
observation, the stored review's authority, audio citation kind and
measured-minus-event interval, the class and why automation cannot decide it,
and the allowed dispositions: **KEEP_LEAD** (positive evidence), **DEMOTE with
positive evidence**, **MOVE**, or **PENDING**. Entry points: 113 `sections` (one per
accepted Melody decision, class mix shown, every event id listed) and 329
contiguous same-class `windows`. No accepted previous version exists, so there is
no accepted-version Lead evidence to show.

### B4. Canonical behaviour unchanged

"Not proven Vocal" is still not demotion evidence; conflicting/incomplete
evidence keeps the Source-Faithful Lead in Melody as `PENDING`; demotion still
requires positive evidence. Nothing here demotes, keeps or moves any event.

| Axis | Before | After checkpoint B |
| --- | --- | --- |
| Gate 3 Lead promotion | PENDING — 174 PASS on agent F0/CQT reviews + 395 missing | **PENDING — 0 PASS / 569 PENDING**; 569 decisions classified; review queue ready for a human |

## 3. Checkpoint C — Audio Gate (Gate 7) implementation drift

Three separate things, kept separate: the audio module is **implemented**
(`studio_capabilities.audio_alignment: true`); an audio report **exists** for
the Kaiju candidate (two revisions, active `342aea74…`, confidence 0.456);
audio alignment for this candidate **does not pass**.

### C1. Prose authority vs runtime

| Surface | Published v1 (ACCEPTANCE_CRITERIA Gate 7, SOURCE_POLICY §1B/§6) | Runtime before | Drift? |
| --- | --- | --- | --- |
| readiness `originalAudio` (`final/readiness.mjs`) | alignment evidence for relevant sections **and** role/prominence/sustain/articulation/recording-structure questions reviewed; "a globally implemented audio module does not pass this gate for a song automatically" | `PASS` whenever warning-free alignment evidence was attached; no review required | **Yes — fixed** |
| Studio Web (`studio/web/model.mjs`) | same | already required its own `audio` review (note + evidence, revision-bound) on top of the shared gate | parity reference |
| Application Service / MCP / HTTP / run continuation / finalize | same | inherited the shared gate: an agent could pass Gate 7 by attaching a clean report | **Yes — fixed** (same code path) |
| audio worker / `audio/index.mjs` | metrics are locators; audio must not mutate symbolic events or claim exact pitch | `changes_symbolic_truth:false` enforced; no pitch/role output; warnings on low confidence/coverage/collapsed intervals | no drift |
| active report revision semantics (PR #60/61) | evidence selection is not a verdict; revisions immutable | readiness reads only each chain's active head from the store; revision refused once candidate-bound reviews exist | no drift |
| Lead evidence citing audio metrics | a metric cannot alone prove role/Vocal/exact pitch/octave | an F0/CQT "foreground" citation was positive Lead evidence | fixed in checkpoint B |

### C2. Fix

- `audioGate(project, required, reviewed)`: missing evidence → `AUDIO_ALIGNMENT_EVIDENCE_MISSING`;
  alignment warnings → `AUDIO_ALIGNMENT_REVIEW_REQUIRED` (a review never clears
  them); warning-free but unreviewed → **`ORIGINAL_AUDIO_GATE7_REVIEW_REQUIRED`**;
  `PASS` only with both. The new input defaults to `false` (fail closed).
- New confirmation `original_audio_reviewed` (candidate-bound, `true` requires
  ≥1 evidence reference, refused when the candidate has no active audio
  evidence, bound to the hash of the active report head(s) read from the
  store — not the `audio_evidence` index cache). A different active revision
  makes it stale (`AUDIO_EVIDENCE_REVISION_CHANGED`).
- Threaded through review, finalize, `reviewAppliedCandidate`, run-contract
  available operations, capabilities, the proposal "never agent-settable" list
  and the MCP confirmation description; Studio Web passes its existing `audio`
  review into the shared gate.
- PR #60/61 behaviour preserved: revisions stay immutable/auditable, active
  selection stays evidence selection, stale bindings fail closed, no pitch claim.
- Tests: `G7-1…5` and a readiness unit test; two deliberate mutations (review
  requirement removed, revision binding ignored) both caught. Five existing
  "fully reviewed" fixtures now state the Gate 7 review explicitly; two
  service tests now assert the two-step behaviour instead of PASS-on-evidence.

### C3. Kaiju

`originalAudio`: **PENDING**. Active report `342aea7427781d37fe4c61d54aaabc4ed3062113b10a8ca1e51f62a7a85479da`
(revision of `2816ea27…`, differing only in input filename) carries
`LOW_ALIGNMENT_CONFIDENCE` (0.456 < 0.55) and `LOW_SCORE_FRAME_COVERAGE`; no Gate 7
review exists. Official audio is part of the source set (`original_audio_required`
is not set false), so the gate cannot be N/A. Needed: a better-aligned report
revision for the relevant sections, then a human Gate 7 review bound to it. No
anchor, listening or confirmation was invented.

| Axis | Before | After checkpoint C |
| --- | --- | --- |
| Gate 7 derivation | PASS on warning-free evidence alone (service); Web required a review | evidence **and** candidate-bound, evidence-backed, revision-bound Gate 7 review, same on every surface |
| Gate 7 Kaiju | PENDING (alignment warnings) | **PENDING** (alignment warnings; no Gate 7 review) |

## 4. Checkpoint D — Mobile (Gate 8), Regression (Gate 9), player readback

### D1. Gate 8 — Mobile adaptation: **PENDING**

Facts on the reproduced candidate (machine-checked):

| Check | Finding |
| --- | --- |
| Adaptation performed | none — run step `mobile_adaptation` skipped (`NO_MOBILE_PROFILE_SUPPLIED`); candidate = decision application only |
| Minimal / source-supported Lead & Core3 preserved | trivially (no transformation): 0 pitch, onset, duration or volume edits vs the baseline; 1,545 role assignments only |
| Octave / register changes | none; pitches 38–86, inside the official 0–107 |
| Role polyphony | every role monophonic (0 overlapping onsets inside a role) |
| Prominence / volume after role assignment | **not arbitrated**: every event's volume is undecided, so each role would fall back to the parser default (`VOLUME_NOT_DECIDED` notice ×5) — Gate 8's "re-arbitrate prominence rather than inheriting destination volume" is unanswered |
| Final syntax per `MOBILE_SYNTAX.md` | **NOT_RUN** under Published v1 (emission blocked by micro-timing). Candidate-only hypothetical: Melody/Chord1/Chord2/Chord3 at 1,096/816/1,472/671 chars (≤ 2,400); Chord4 not serialisable (long-rest duration-search limit); no Nxx, no dotted fragile forms, no shell/label text are ever emitted by the emitter |
| Tempo-map policy | **NOT_RUN** — no emitted candidate; the export used for reproduction carries no Tempo Map, so no claim is made |
| Zero duration | none in the IR (every event has positive duration) |
| Reversible mapping | yes (no transformation; lineage lists all 1,545 role moves) |
| Studio v1 limit | a Melody assigned from a role-less baseline carries Lead-evidence lineage and cannot be re-pitched/re-volumed by `mobile_adaptation` v1 |

Gate 8 needs a cited Mobile profile (instrument range, volume mapping) and a
candidate-bound, evidence-backed human `mobile_adaptation_reviewed`. Nothing was
deleted or re-registered to improve a metric.

### D2. Gate 9 — Regression: **PENDING**

- vs Source-Faithful Baseline (`bas:315eb13d…`): Lead added 569 (role-less → Melody,
  all review-pending), Lead removed 0, Lead moved away 0; other role moves 976
  (role-less → Chord1 209 / Chord2 641 / Chord3 119 / Chord4 7); pitch 0 / onset 0 /
  duration 0 / volume 0 changes; Core3 = Melody 569 + Chord1 209 + Chord2 641; Full6
  enrichment = Chord3 119 + Chord4 7, Chord5 empty.
- vs accepted previous version: **N/A** — none exists (`parent_candidate_id` null; no
  accepted Kaiju MML is in the repository or the project).
- Executable historical fixtures: all run in the suite and pass
  (`song-reference-packages` for `back-number-mabataki`, the Kaiju
  machine-delivery acceptance scenario, Lead demotion/promotion regressions).
- Named regressions without an executable fixture: **Rashisa / らしさ Lead
  over-cleaning — `FIXTURE_PENDING`**; not claimed as passed. Its semantics are
  preserved by the unchanged rule that a Lead demotion needs positive evidence,
  now additionally protected against agent/metric evidence (checkpoint B).
- `regression_reviewed` is unrecorded; Gate 9 needs a human, evidence-backed review.

### D3. Player readback: **PENDING (NOT_RUN)**

No Final artifact exists for Kaiju (`artifacts: []`; finalize is blocked upstream by
micro-timing, Lead, Gate 4, Gate 7, Gate 8 and Gate 9), so there is no MML that any
player could load and read back. Nothing was loaded; `applied=true`, website playback,
parser success and the hypothetical emission above are not readback and are not
reported as such. When an artifact exists, readback must bind the loaded MML by
`mml_sha256` (`player_readback: PASS` supports that binding).

Receipt: [gate8-gate9-readback.json](evidence/kaiju-final-remediation-2026-09-22/gate8-gate9-readback.json).

| Axis | Before | After checkpoint D |
| --- | --- | --- |
| Gate 8 | PENDING (review required) | **PENDING**; volume/prominence shown to be un-arbitrated; syntax NOT_RUN under v1 |
| Gate 9 | PENDING | **PENDING**; event-level baseline diff enumerated; previous-version diff N/A; Rashisa `FIXTURE_PENDING` |
| Player readback | NOT_RUN | **PENDING (NOT_RUN)** — no artifact exists to load |
