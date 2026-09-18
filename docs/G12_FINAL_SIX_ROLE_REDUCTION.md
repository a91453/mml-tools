# G12 — Final Six-Role Reduction v1

Status: IMPLEMENTATION NOTES
Canonical release implemented: `2026-09-13-v1`
Rules snapshot: `0a172900a01fdf39c2e9e84cf176961320b779ea`

This document describes an implementation stage in this repository's pipeline.
It is **not** a Canonical rule source and defines no rule. Where it states a
requirement, that requirement comes from `MASTER_RULES.md`, `SOURCE_POLICY.md`,
`MOBILE_SYNTAX.md` or `ACCEPTANCE_CRITERIA.md` in the snapshot above, and those
documents remain the authority. `G12` is a pipeline stage name, like `G11-D`; it
is not a Published Canonical rule identifier.

## Why the stage exists

The pipeline had no step between an accepted G11-D role decision and Mobile
Adaptation, so nothing owned the question:

> For every source-supported event that reaches the six-role delivery, where
> does it end up?

Without an answer, six-role capacity pressure has nowhere to go except into
silent loss — the exact failure `MASTER_RULES.md` §2 and §3 and
`SOURCE_POLICY.md` §3 forbid. G12 is where that question is answered, event by
event, on the record.

```
Raw MIDI → G11-A → G11-B → G11-C → G11-D
        → G12 reduction preview → G12 reduction apply
        → Mobile Adaptation preview → Mobile Adaptation apply
        → candidate review → Gate 8 → Gate 9
        → studio_finalize → Final MML → round-trip readback → Final Gate
```

## What it decides, and what it does not

G12 resolves **role and six-role capacity**. Nothing else.

| Question | Owner |
| --- | --- |
| Which of the six roles does this material belong to? | G12 |
| Does this material fit in six roles at all? | G12 |
| What is the target register / volume for a role? | Mobile Adaptation (Gate 8) |
| Is this onset, duration or pitch right? | the source, never a stage |
| Is the arrangement musically complete? | Gate 4 |
| Is the Lead correct? | Gate 3 and the shared Lead grader |
| Does the string fit the character limit? | the Final pipeline, downstream |

G12 changes no pitch, no octave, no onset, no duration and no volume. A
reduction decision is key-allowlisted, so a register or prominence field on one
is a rejection rather than an edit: the two layers stay separable and separately
reviewable.

## Event accounting invariant

Every note event of the Source-Faithful Baseline that reaches this stage lands
in exactly one outcome, and the ledger says which:

| Outcome | Accounting | Meaning |
| --- | --- | --- |
| `KEEP` | `retained` | delivered in the role it already has |
| `REDISTRIBUTE` | `redistributed` | delivered in a role a reviewer moved it to |
| `OVERFLOW` | `overflow` | retained in the candidate, outside the six roles, on the record |
| `PENDING` | `pending` | retained, destination is an open musical question |
| `OMIT` | `omitted` | removed by an explicit, evidence-backed reviewer decision, or by an earlier accepted revision |

Nothing else is possible. The planner refuses rather than produce a candidate
that delivers an event no ledger entry accounts for, or drops one the ledger
says is retained; `applyFinalReduction` re-proves both on its own output before
returning, and a violation throws rather than returns.

### One source event, several candidate copies

An upstream G11-D `DUPLICATE_WITH_JUSTIFICATION` sounds one source event in a
second role, so that event reaches this stage as **two or more candidate
events**, and `baselineOriginResolver()` resolves every copy back to the one
origin it came from.

The invariant is about the **source** event, so the ledger carries one entry per
baseline note, with each candidate copy described beneath it in
`manifestations[]` — its own `candidateEventId`, role, outcome, reason code,
decision and Lead/Core3 impact. One entry per *copy* would let a single source
event occupy two accounting buckets and make `accounting.total` exceed the
number of source events, which is exactly what the invariant denies.

The entry's own outcome is a roll-up over its copies, in the fail-visible
direction:

```
PENDING  >  OVERFLOW  >  REDISTRIBUTE  >  KEEP  >  OMIT
```

An unresolved or outside-the-six-roles copy outranks a settled one, so a
duplicate that happens to be decided can never hide the copy that is not.
`OMIT` is last because it is the entry's answer only when *every* copy is
omitted. The two counts are reported separately and neither stands in for the
other:

| Field | Counts |
| --- | --- |
| `accounting.total` | source events — always equals `baselineNoteCount` |
| `accounting.manifestationCount` | the candidate events they reach this stage as |
| `accounting.duplicatedBaselineEventIds` | which source events arrived with more than one copy |

Both the planner's projection check and the apply-time proof run **per
manifestation**, not per entry: a baseline event with one omitted copy and one
retained copy satisfies any entry-level test trivially, which is the case those
checks exist for.

### The ledger and the delivery must agree on the role, not just on presence

Presence is not the whole invariant. An event can be delivered and still be
delivered *somewhere the ledger denies* — a bookkeeping action whose underlying
role decision preserves the role, while the ledger reports the material as
outside the six roles, passes every presence check while the accounting lies.

So both proofs also require, for every delivered copy, that the role the
projection delivers equals the `proposedRole` the ledger records, and that a
duplicate this plan creates lands in one of the `duplicateRoles` recorded for
it. A disagreement is `REDUCTION_LEDGER_ROLE_DISAGREES_WITH_PROJECTION` in the
plan and a thrown invariant violation at apply.

`ACCEPT_OVERFLOW` on an event that already holds one of the six roles is
refused up front for the same reason: the G11-D action it becomes is `KEEP`,
which preserves the role, so accepting it would mean recording material as
outside the delivery while it keeps sounding inside it.

**`OMIT` is not something the planner can reach on its own.** "The six roles
were full" is a capacity fact, not a licence to delete. An omission requires an
explicit decision naming exact candidate events, with a reason, at least one
evidence reference, and a named reviewer — and, when Melody material is
involved, a Lead evidence record the shared Lead grader passes.

### Overflow versus pending

Both retain the material; they differ in what is blocking.

* **`PENDING`** — a free role exists, and which material belongs in it is a
  musical choice nobody has made. The plan attaches a deterministic ranked
  suggestion list marked `authority: 'SUGGESTION_ONLY'`; a suggestion is never
  an outcome, never resolves a `PENDING`, and never removes an event.
* **`OVERFLOW`** — no role is free. Placing the material would mean displacing
  or merging with something already delivered, which is a further musical
  decision. It is reported and retained, not auto-placed and not dropped.

## Decisions

A reduction decision names **events**, never a lane: the invariant is
event-level, and a lane-shaped omission is the bulk deletion `SOURCE_POLICY.md`
§3 forbids.

| Action | G11-D decision it becomes | Evidence required |
| --- | --- | --- |
| `KEEP` | `KEEP` | reason |
| `REDISTRIBUTE` | `ASSIGN_ROLE` (unassigned) / `MOVE_ROLE` (assigned) | reason + ≥1 reference |
| `DUPLICATE` | `DUPLICATE_WITH_JUSTIFICATION` | reason + ≥1 reference — *plan-time only, see below* |
| `ACCEPT_OVERFLOW` | `KEEP` over role-less material | reason |
| `OMIT` | `OMIT_FROM_SIX` | reason + ≥1 reference |

The role application is **not re-implemented**. Decisions are translated into
the existing G11-D accepted-decision vocabulary and applied by
`applyAcceptedArrangement()`, which owns the Lead demotion/promotion interlocks,
the conflict codes, the acceptance bindings, the provenance invariants and the
all-or-nothing atomicity. There is no G12-only path around the Lead evidence
contract, and a Lead refusal surfaces as the G11-D rejection code it is.

The acceptance bindings are computed from the baseline and Canonical release
loaded at call time and are never taken from a caller — an identity a caller can
supply is an identity a caller can make stale-proof.

### `DUPLICATE` is graded, and cannot be applied in v1

A duplicate copies its source event exactly, pitch and timing included, so it
always sounds at the same pitch and time as the original it copies. That is a
same-pitch overlap the plan would **introduce**, and the new-risk check blocks
it — for any target role, on any baseline.

The action exists because the Lead contract must be enforced on a duplication
into Melody, and it is: the decision is normalized, translated and graded by the
shared Lead grader at plan time. But no duplication can reach `apply` in v1, and
the `createdEventIds` checks in both proofs are therefore defence in depth for a
path apply cannot currently take. A regression pins this, so making duplication
reachable is a deliberate change with a failing test rather than a silent one.

A duplicate an *upstream* G11-D revision already accepted is a different thing
entirely: it arrives inside the candidate, is not introduced by this plan, and
is handled as an additional manifestation of its source event.

## Core3

The plan evaluates Gate 4 completeness on the candidate **before** and on the
projection **after**, through the existing `evaluateCore3Completeness()`.

* after is `FAIL` → **blocked**. Gate 4 fails only on deficiencies a reviewer
  cannot answer away (an absent Lead, a Core3 whose identity depends on
  Chord3–Chord5), so a complete Full6 can never stand in for an incomplete
  Core3.
* before was `PASS`, after is not → **blocked** as a regression.
* after is `PENDING` → reported as a warning and left for the Gate 4 review the
  apply re-opens. It is never upgraded here.

## Harmony and collisions

The existing modules answer, unchanged:

* `analyzeCrossSourceHarmony()` for disjoint-source conflicts;
* the shared transformation overlap sweep in `arbitration/harmony.mjs`
  (`overlapRisks`) for the same-pitch / m2 / M7 / m9 pairs a role move can
  create *inside* one source, which a disjoint-source scan cannot see.

Both are run before and after. A pair the reduction would **introduce** blocks;
a pair the input already had stays a visible warning for the existing review.
No event is ever removed to make either list shorter.

Both scanners read pitch, time and source identity — never role. So a *pure role
move* cannot introduce a pair at all, which is what makes a reduction safe to
apply over an already-conflicted arrangement. What it must not do is quietly
*clear* one, and the before/after comparison is what proves the inherited risk
survives into the review. `DUPLICATE` is the one action here that adds a
sounding event, so it is the one that can introduce a pair — and it blocks when
it does.

## Character budget

Per-role MML character pressure is measured with the real Final emitter and
reported in `characterBudget.before` / `.after`. It is a constraint to report:
`Chord5 is over 2400` is never a reason to remove source-supported music. Real
canonicalization and syntax compression remain downstream in the Final pipeline.
A measurement that cannot be taken is reported as `NOT_MEASURED`, never guessed.

## Percussion

General MIDI drum material stays explicitly `PENDING` with
`PERCUSSION_DRUM_FACE_MAPPING_REQUIRED` and is never given a pitched role
(`MASTER_RULES.md` §8). A decision that would assign one is refused; drum
material already sitting in a pitched role in the input blocks, because that is
leaked GM material rather than a reduction question.

## Revision and provenance

Applying mints a derived, content-addressed candidate:

* `revision.stage = FINAL_SIX_ROLE_REDUCTION_V1`, inside the content-addressed
  revision body — a reduction revision cannot be re-read as a G11-D role
  decision, nor the reverse, even over identical inputs;
* candidate id `<baseline>#g12-r<n>`;
* `metadata.g12` carries the plan id, the input digest, the decisions, the
  accounting summary and the full event ledger. It is inside the candidate
  digest, so an edited ledger no longer hashes to the revision that names it;
* the parent candidate and the Source-Faithful Baseline are untouched;
* rollback is "use the parent candidate": nothing is rewritten in place.

The revision id keeps the repository-wide `g11d:rev:` namespace, as Mobile
Adaptation revisions do. The namespace is how a candidate id is recognized
across every stage; the stage identity is the `stage` field, not the prefix.

### The application target

Decisions are applied onto the parent candidate, or onto the baseline when there
is no parent. So the project the plan describes and the project the decisions
land on must be the same project. A candidate handed in without its stored
application wrapper has its parent recovered from the provenance it carries and
re-checked by the ordinary `applicationIntegrity()`; a candidate that differs
from the baseline and carries no verifiable derivation is refused with
`REDUCTION_CANDIDATE_NOT_THE_APPLICATION_TARGET` rather than quietly reduced
against the baseline, which would discard the role decisions this stage exists
to converge.

## Applying certifies nothing

`status: 'PASS'` on a plan means **this reduction plan can be safely applied**.
It is not Gate 3, 4, 5, 8 or 9, not `VALIDATED` and not `IN_GAME_ACCEPTED`.
`certifiesGates` is empty on the plan, the application, the revision and the
candidate's stage record. The Application Service re-runs the candidate review
immediately after applying, so "applied" cannot be read as "reviewed".

## Surfaces

| Plane | Preview | Apply |
| --- | --- | --- |
| Application Service | `planFinalReduction` | `applyFinalReduction` |
| HTTP | `POST /projects/:id/final-reduction/plan` | `POST /projects/:id/final-reduction/apply` |
| MCP | `studio_final_reduction_plan` | `studio_final_reduction_apply` |
| Studio Web | `previewFinalReduction` | `applyWorkspaceFinalReduction` / `clearFinalReduction` |

Preview is read-only on every plane. Apply is an explicit mutation that must
name the preview's `expected_plan_id`; a stale plan is refused and applies
nothing. The two are never one operation with an `apply` flag.

Studio Web persists the reduction **inputs** — accepted decisions, plan id,
reviewer — and re-derives the reduction on every analysis and every reload. It
stores no derived candidate and no PASS. A backup's reduction record is carried
as history and must be previewed and accepted again.

## Optional timbre / audibility interface

`mml-studio/instrument-profile@1` is reserved so a future Timbre-Aware Reduction
has somewhere to plug in. It is **optional and provably inert**: the plan
identity, items, outcomes and blockers are computed before it is read, and a
regression asserts the plan is byte-identical with and without one, including a
profile claiming `verificationStatus: "VERIFIED"`. It produces diagnostics only.
See `TIMBRE_PROFILE_RESEARCH.md` for what would have to be established before it
could mean more than that.

## Not in this stage

`Melody Adaptation v1.1`, automatic instrument assignment, automatic performer
allocation, evidence-backed drum-face mapping, Timbre-Aware Reduction, a
drag-and-drop arrangement editor and any in-game automation are all out of
scope and remain unimplemented.
