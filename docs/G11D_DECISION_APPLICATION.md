# G11-D — Accepted Arrangement / Decision Application

Status: IMPLEMENTATION NOTES — not a Canonical authority.

This document records how the Studio pipeline turns *reviewed, explicitly
accepted* arrangement decisions into a new derived Candidate Canonical project.
It defines no music rule, no syntax rule and no acceptance gate, and it MUST NOT
be loaded as a replacement for the Published Canonical rule sources. Rule
discovery starts only at [docs/CANONICAL_MANIFEST.md](CANONICAL_MANIFEST.md) and
its pinned snapshot.

## Loaded Canonical identity

| Identity | Value |
| --- | --- |
| `canonical_version` | `2026-09-13-v1` |
| `canonical_status` | `PUBLISHED` |
| `manifest_version` | `2026-09-13-v1-manifest1` |
| `rules_snapshot_sha` | `0a172900a01fdf39c2e9e84cf176961320b779ea` |
| Manifest commit | `5e7666b850a37f1c85ee2dd8cd0f4fac037a9e14` |
| Published `main` at start of work | `e3ad55c09e82d889d64c9cee13ea1332632df49f` |
| Branch base / merge-base | `e3ad55c09e82d889d64c9cee13ea1332632df49f` |

`docs/MASTER_RULES.md`, `docs/SOURCE_POLICY.md`, `docs/MOBILE_SYNTAX.md`,
`docs/ACCEPTANCE_CRITERIA.md`, `docs/PENDING.md` and `docs/OFFICIAL_EVIDENCE.md`
were loaded from that exact snapshot and their version/publication headers
verified. No working-HEAD rule copy, legacy Skill, old Master, Draft2 file,
memory or historical implementation behaviour was used as a rule substitute.
The legacy frontend archive was not read and is not a dependency of this stage.

## Stage name

`G11-D` is an **implementation stage identifier** used by this repository's
Studio pipeline and roadmap documents. It is **not** a Published Canonical rule
identifier: the Published Canonical release defines no stage called G11-D, and
nothing in this document or in the code it describes publishes one. The
executable status record states the same thing as data
(`DECISION_APPLICATION_STATUS.stageNameAuthority`).

## Problem

Before this stage the pipeline ended one step short of usefulness:

```
G11-A Source-Faithful Baseline
  -> G11-B lossless voice decomposition
  -> G11-C six-role candidate suggestion + decision ledger
  -> (nothing)
```

G11-C is deliberately inert. It proposes roles, records every event-level
decision, keeps unresolved material, changes no pitch/onset/duration, never
deletes a source event and certifies no `ACCEPTANCE_CRITERIA.md` gate. That is
correct — but it left Studio able to *say* "this lane belongs in Chord1" with no
mechanism at all for a reviewer to accept that and get a real candidate back.

What was missing is a formal, safe, traceable application layer:

```
accepted decisions
  -> G11-D derived Candidate Canonical project + revision record
  -> event-level diff vs baseline and vs the accepted previous revision
  -> existing Lead / Core3 / harmony / micro-timing / readiness pipeline
  -> Final MML emitter
```

## Architecture

| Concern | Module |
| --- | --- |
| Accepted-decision schema, validation, binding | `studio/backend/arrangement/decision-application.mjs` |
| Application, revision identity, provenance trace | same module, `applyAcceptedArrangement()` |
| Downstream pipeline wiring | `studio/backend/arrangement/decision-review.mjs` |
| Facade | `studio/backend/arrangement/index.mjs` |

The core module imports only `canonical/`, `compare/`, `mml/`,
`arbitration/lead-demotion` and `source/sha256`. It re-derives no lane
decomposition and creates no parallel identity system: lane identity comes from
the G11-C result, and event identity comes from the Canonical constructors.

### Inputs

```js
applyAcceptedArrangement({
  baseline,            // G11-A Source-Faithful Canonical project
  suggestion,          // G11-C result -- lane identity only, never a role source
  parent,              // null, or { revision, candidate } from a previous application
  decisions,           // explicitly accepted decisions
  canonicalIdentity,   // the Published Canonical release this was reviewed under
})
```

`suggestion` is used for exactly two things: resolving a `laneId` target to the
event ids G11-C says are in that lane, and computing the lane-decomposition
digest a lane-targeted decision is bound to. No role, status, confidence,
ranking or reason is ever read out of it.

### Output

A frozen result:

```
status            'PASS' | 'FAIL' | 'PENDING' | 'UNSUPPORTED'
candidate         CanonicalProject | null      (null unless PASS)
revision          revision record | null
baselineIdentity  content-derived identity of the baseline
decisionSetDigest order-independent digest of the accepted set
applied[]         one entry per applied decision, with its per-event effects
rejected[]        structured rejections, with the binding that failed
conflicts[]       structured mutual-exclusion diagnostics
stale[]           the subset of rejections that are staleness
trace[]           decision -> input event -> output event(s), reversible
omitted[]         events omitted from the six roles, with source provenance
diffFromBaseline  compareCanonicalVersions(baseline, candidate)
diffFromParent    compareCanonicalVersions(parentCandidate, candidate) | null
immutability      before/after digests of the baseline and parent
diagnostics[]     non-blocking facts (unassigned material, stripped metadata, …)
downstream        the gates that must still be re-run
```

## Accepted-decision contract

```js
{
  id,          // stable, unique within the set
  type,        // KEEP | ASSIGN_ROLE | MOVE_ROLE | OMIT_FROM_SIX | DUPLICATE_WITH_JUSTIFICATION
  target,      // { laneId } or { eventIds }, never both
  fromRole,    // the role the reviewer saw; required for MOVE_ROLE
  toRole,      // ASSIGN_ROLE / MOVE_ROLE
  toRoles,     // DUPLICATE_WITH_JUSTIFICATION
  section,     // optional exact-rational { start, end } window
  reason,      // required, positive
  evidence,    // citation references; required for duplication and Lead promotion
  leadEvidence,// required when the decision leaves or enters Melody
  acceptance: {
    state: 'ACCEPTED',          // exact string; nothing else is acceptance
    acceptedBy,                 // who accepted it
    reviewedRevisionId,         // null = reviewed against the baseline
    baselineContentDigest,
    sourceIdentityDigest,
    laneDecompositionDigest,    // required for a lane target
    canonicalRulesSnapshotSha,
  },
  metadata,
}
```

Two properties do the load-bearing work:

**The key list is an allowlist.** An unknown top-level field is a rejection, not
an ignored field. That is what stops a pitch, octave, onset, duration, volume,
tempo or meter edit from riding along inside a role decision, and what stops an
older build from silently honouring a field a newer reviewer added.

**Acceptance cannot be defaulted.** There is no lenient mode. A decision with no
`acceptance`, or with any `state` other than the exact string `ACCEPTED`, cannot
be constructed at all. A G11-C ledger entry is refused by the same constructor,
and the module exposes no suggestion-to-acceptance shortcut of any kind.

### What is not accepted

None of these is acceptance, and none of them is readable as one:

highest pitch; best candidate; highest confidence; shortest distance; source
authority rank; a G11-C `candidate.status`; a G11-C suggested role; a green CI
run; a successful parse; a stored `accepted: true`; a newer timestamp.

## Immutability model

The Source-Faithful Baseline and the parent candidate are read-only inputs. The
application constructs a new project through the Canonical constructors; it
sorts no input array in place, writes no property on any input event, and reuses
no mutable reference.

This is proven rather than asserted. A content digest of the baseline and of the
parent candidate is taken before any work starts and recomputed at the end; the
result carries both, and a disagreement throws rather than returning a candidate.
Every output note is additionally compared back to the input event it came from
for pitch, onset, duration, volume, `sourceIds` and `sourceEventIds` drift.

## Revision model

Every application produces a **new** revision. Nothing overwrites a parent.

```
Baseline
  -> revision 1  (parentRevisionId: null)
  -> revision 2  (parentRevisionId: <revision 1 id>)
  -> revision 3  (parentRevisionId: <revision 2 id>)
```

The revision id is content-addressed:

```
id = 'g11d:rev:' + sha256(canonicalJson({
  index, parentRevisionId, baselineIdentity, parentCandidateIdentity,
  decisionSetDigest, canonicalIdentity, laneDecompositionDigest, candidateDigest,
}))
```

No wall-clock timestamp, counter or random value participates. The same inputs
produce the same revision id on any machine, and a revision record whose fields
were edited no longer hashes to its own id — which is exactly the check
`revisionIdentityMatches()` performs on a parent handed back from storage.

The candidate carries its revision in `metadata.g11d` as **provenance data**,
explicitly marked as certifying no gate.

## Stale-decision protection

A decision is bound to the exact inputs it was reviewed against. All five
bindings are mandatory and all five are checked before the decision's targets
are even resolved, so a stale decision can never partly resolve:

| Change | Binding | Rejection |
| --- | --- | --- |
| Candidate moved on | `reviewedRevisionId` | `STALE_DECISION_REVISION_MISMATCH` |
| Baseline changed | `baselineContentDigest` | `STALE_DECISION_BASELINE_CHANGED` |
| Source identity changed | `sourceIdentityDigest` | `STALE_DECISION_SOURCE_CHANGED` |
| Canonical release changed | `canonicalRulesSnapshotSha` | `STALE_DECISION_CANONICAL_CHANGED` |
| Lane decomposition changed | `laneDecompositionDigest` | `STALE_DECISION_LANE_DECOMPOSITION_CHANGED` |

A decision naming event ids that are not in the project being applied onto fails
closed (`TARGET_EVENT_NOT_FOUND`); a lane target whose events are not all present
fails closed rather than silently retargeting to the subset that survived.

A parent revision is verified three ways: its id is recomputed from its own
content, its `candidateDigest` must match the candidate actually supplied, and
its baseline and Canonical identities must match this application's.

Any staleness sets `requiresFreshReview: true` and fails the whole set.

## Conflict behaviour

Conflicts are computed from a map keyed by event id and reported in sorted
order. Nothing reads array position, acceptance order, recency, evidence rank or
source authority, so there is no "last decision wins" to depend on: a mutually
exclusive pair is a conflict whichever way the caller ordered it.

| Code | Meaning |
| --- | --- |
| `MULTIPLE_DISPOSITIONS` | Two KEEP/ASSIGN/MOVE decisions target one event. |
| `DISPOSITION_AND_OMISSION` | One event is both kept/assigned/moved and omitted. |
| `MULTIPLE_DUPLICATIONS` | Two duplication decisions target one event. |
| `DUPLICATION_OF_OMITTED_EVENT` | An event is both omitted and duplicated. |

Compatibility is explicit, not residual: a duplication may coexist with one
disposition that keeps the event present, and with nothing else.

## Transactional guarantee

Validate every decision → bind → resolve → gate → detect conflicts → decide the
verdict → *only then* construct. A set whose seventeenth decision is illegal
leaves no partially applied candidate: `candidate` is `null`, `applied` is
empty, and the inputs are byte-identical to what was handed in.

## Provenance model

Output event identity:

| Case | Identity |
| --- | --- |
| unchanged / KEEP / ASSIGN_ROLE / MOVE_ROLE | the event id is preserved exactly |
| OMIT_FROM_SIX | absent from the candidate; recorded in `omitted` and visible as a removal in the baseline diff |
| DUPLICATE_WITH_JUSTIFICATION | original keeps its id; each copy gets `\<originalId\>#g11d-dup:\<16 hex\>` derived from `{from, role, decisionId}` |

No random UUID is ever minted. A duplicate keeps the original `sourceIds` and
`sourceEventIds` — that is what makes it traceable to the one source event it
copies — and is tagged `g11d-derived-duplicate` with a `metadata.g11d` record
naming the origin event, the decision, the role, the reason and the evidence, so
nothing downstream can read it as independent source support.

`trace[]` gives the reversible chain for every applied decision:

```
decisionId, decisionType,
inputEventId, baselineEventId, sourceIds[], sourceEventIds[],
fromRole, toRole, outputEventIds[],
pitch, start, end, volume     // restated, proving they did not change
```

## Lead and Core3 behaviour

An accepted decision does not disable a gate.

* Leaving Melody (a MOVE out of Melody, or an OMIT of a Melody event) runs the
  existing `evaluateLeadDemotion()` gate unchanged. Missing or incomplete
  evidence yields `PENDING` for the whole set, never a quiet demotion.
* Entering Melody requires the mirror obligation: a resolved section role and a
  positive, cited score-lead or audio-foreground classification. This is an
  evidence-presence interlock; it decides nothing about what the lead *is*.
* Both sides first require the evidence to be **in scope for the event being
  moved** — see below.
* G11-D never reports Core3 as complete. `certifiesCore3Complete` is `false`,
  and Core3 completeness is decided by `arbitration/core3.mjs` against the
  baseline, after application.

### Lead evidence is bound to the event it is attached to

`SOURCE_POLICY.md` §4 lists source identity as the first thing a Lead move must
inspect. Inspecting it means confirming the citation belongs to the event being
moved. `leadEvidenceIdentityBlockers(leadEvidence, event)` is that check, and
both interlocks run it *before* they call or accept the underlying gate:

```
evidence.sourceIdentity.sourceId      ∈ event.sourceIds
evidence.sourceIdentity.sourceEventId ∈ event.sourceEventIds
```

Membership, deliberately not equality. A Canonical event may legitimately carry
several `sourceIds` and several `sourceEventIds`; the check never requires either
array to have one element, and never compares the arrays to the citation.

Both halves are necessary. Two events from one source share a `sourceId`, so
matching only that would still let one event's evidence move another. The
`sourceEventId` is what pins a citation to a single source event.

An event that states no `sourceEventIds` cannot have Lead evidence bound to it
and fails closed with `TARGET_EVENT_SOURCE_EVENT_IDS_MISSING`, rather than
falling back to the source id.

A derived duplicate carries its origin's `sourceIds`/`sourceEventIds` and binds
against that origin provenance. Its own derived event id is a different
namespace and is never accepted as a `sourceEventId`.

Out-of-scope evidence produces `LEAD_EVIDENCE_EVENT_IDENTITY_MISMATCH` and a
result status of `PENDING` — the evidence has not shown this event is the one it
describes, which is not the same as proving the musical decision wrong.

### One Lead event per decision

A decision carries one `leadEvidence` record, and one source-event citation
cannot describe several different source events. A Lead-affecting decision —
Melody to another role, Melody to omitted, anything into Melody, including a
duplication whose `toRoles` contain Melody — that resolves to anything other
than exactly one note event is refused with
`LEAD_EVIDENCE_MULTI_EVENT_SCOPE_UNSUPPORTED` and status `UNSUPPORTED`.

Nothing is bound to the first event, reused across the rest, or split on the
caller's behalf. A lane naming several Lead events is the same case: a lane id
does not bind evidence to the events inside it. Multi-event support needs an
`eventId → Lead evidence` contract, which is a later phase.

Decisions that touch no Lead event are unaffected and may still target many
events.

### Downstream defence in depth

`leadDemotionReportsFromApplication()` re-establishes both checks against the
baseline event before producing any report. An application result is data — it
can be restored, hand-built, mutated, or produced by a caller that bypassed the
recording path — so `status === 'PASS'` is not evidence that the scope checks
ever ran. This is the last place a foreign citation could be re-packaged as a
PASS carrying the target event's id, because the readiness Lead gate matches
reports to required Lead events by `eventId`. A mismatch yields a `PENDING`
report carrying `LEAD_EVIDENCE_EVENT_IDENTITY_MISMATCH`; the underlying gate is
never called.

Omitting Core3 material is applied when the decision is legal and evidenced, and
is reported as `CORE3_MATERIAL_OMITTED`; whether the result is still a complete
one-player arrangement is the Core3 gate's answer, not this stage's.

## Downstream validation boundary

`status: 'PASS'` means one thing: the accepted decisions were applied
faithfully, deterministically and traceably. It is not `VALIDATED`, and it
certifies no `ACCEPTANCE_CRITERIA.md` gate. The result carries the list of what
must still run (`downstream.mustRerun`), and `decision-review.mjs` wires the
existing modules:

event-level diff (baseline and previous) · Core3 continuity and false Lead gaps ·
Lead Demotion Gate for every Lead removal/role move in the diff · cross-source
harmony arbitration · source-aware micro-timing · per-song readiness.

A derived revision never inherits `sourceComplete`, `audioAlignmentEvidence`, a
stored `sourceFaithfulBaseline` snapshot or a previous `g11d` block from its
parent: every one of those is read downstream as evidence that a gate passed, so
they are recomputed or absent, and the strip is reported as
`PARENT_GATE_METADATA_NOT_INHERITED`.

## Final emitter boundary

G11-D emits no MML. It performs no string surgery, no compression, no
character-limit reduction, no note removal for a 2,400-character budget, no
timing repair and no Final token optimization. Those belong to the existing
Final emitter and to a later, explicit adaptation stage.

## Unsupported / future work

Recognized and deliberately deferred, each reported as `UNSUPPORTED` with its
reason rather than approximated:

| Type | Why it is deferred |
| --- | --- |
| `REDISTRIBUTE` | Splitting one lane or event group across several roles needs its own coverage audit. It is not emulated by duplicate-then-drop-provenance. |
| `OCTAVE_ADAPTATION` / `REGISTER_ADAPTATION` | Changes a sounding pitch. Gate 8 adaptation work, reported as adaptation and never as a source correction. |
| `TRANSFORM_TIMING` | Onset/duration editing rewrites source timing and needs a full source diff of its own. |
| `TRANSFORM_PROMINENCE` | Volume/prominence re-arbitration is Gate 8 adaptation work. |

Also out of scope for this stage, by decision: the Arrangement Editor UI, piano
roll, drag-and-drop note editing, a verification player, automatic best-six
optimization, automatic Mobile octave adaptation, volume balancing, instrument
assignment, drum-face mapping, automatic collision repair and automatic source
reduction.

## Duplication and same-source doubling

A duplicate copies one source event exactly, so it always sounds at the same
pitch and time as its original in another role. `analyzeCrossSourceHarmony()`
is right not to flag that: both events carry the same `sourceIds`, so they are
not a cross-source conflict. Left there, the doubling would go unmentioned by
every layer, so G11-D reports it as `DERIVED_DUPLICATE_SOUNDS_WITH_ORIGINAL`
with the roles, the pitch and the exact window. Per `MASTER_RULES.md` §6 it is a
review signal, never an automatic deletion.

A derived id that would collide with an event already in the project is a
structured rejection (`DERIVED_DUPLICATE_ID_COLLISION`), not a thrown Canonical
constructor error.

## Arbitration decisions

G11-D writes **no** `decisions` entries into the candidate. This is deliberate:
`analyzeCrossSourceHarmony()` marks a conflict `resolved` when an accepted
arbitration decision covers both of its event ids, so an accepted *arrangement*
decision that became an accepted *arbitration* decision would silently resolve
harmony conflicts it never examined.

Decisions already present on the project being applied onto are carried forward
unchanged and reported as `ARBITRATION_DECISIONS_CARRIED_FORWARD`. One that
references an event this revision omitted is dropped loudly
(`ARBITRATION_DECISION_DROPPED_WITH_OMITTED_EVENT`), which makes whatever it
resolved report as unresolved again — the safe direction.

## Studio Web integration

`studio/web/arrangement-decisions.mjs` is the whole Web surface. There is no
Arrangement Editor UI in this change: decisions are recorded through the model
API (`recordAcceptedDecision`, `clearAcceptedDecisions`), and the acceptance
bindings are computed by `acceptedDecisionBindings()` from the project and lanes
that are loaded, never supplied by a caller.

* Decision **records** are persisted. The applied candidate is not: it is
  re-derived on every analysis from the re-validated source project and freshly
  computed G11-C lanes.
* A record is bound to the workspace revision it was accepted at, and
  `invalidate()` drops it exactly as it drops harmony decisions, Core3 approvals
  and Lead evidence.
* `importWorkspace()` restores no accepted decision and no applied candidate.
  Both travel in `importedHistory`, like imported reviews and acceptance.
* A persisted application found on a restored asset is reported through
  `acceptedArrangementBinding()` and never displayed as current.
* Each record carries a content digest over what the decision *does*, kept
  separate from the acceptance block that says what it was reviewed against.
  This is **self-consistency, not authentication**: a body edited in storage no
  longer agrees with its digest and is refused, but anyone who can rewrite the
  record can rewrite the digest beside it. What actually fails closed against a
  hostile or stale workspace is the binding to the baseline content, source
  identity, reviewed revision and Canonical rules snapshot, none of which the
  workspace chooses.

## Tests

| File | Covers |
| --- | --- |
| `studio/tests/decision-application-contract.test.mjs` | the decision schema, mandatory acceptance, the allowlisted key set, deferred types, Canonical binding, and that no export turns a suggestion into decisions |
| `studio/tests/decision-application-binding.test.mjs` | all five staleness bindings, parent tampering, duplicate ids, every conflict class and its order-independence, the transactional guarantee, and the Lead interlocks |
| `studio/tests/decision-application.test.mjs` | immutability, determinism under rotation / reversed events / reversed keys, KEEP, ASSIGN, MOVE, OMIT, DUPLICATE, revision lineage, provenance, section windows, post-validation mutation |
| `studio/tests/decision-application-downstream.test.mjs` | Core3, Lead and cross-source gates blocking a correctly applied candidate, and Final-emitter consumability |
| `studio/tests/decision-application-lead-evidence.test.mjs` | Lead evidence identity binding (correct / foreign event / same source, wrong event / right event, wrong source / missing), membership over equality, derived-duplicate namespace, one-event containment for demotion, omission, promotion and lanes, the downstream re-check, and the readiness end-to-end |
| `studio/tests/g11d-pipeline.test.mjs` | raw SMF bytes → G11-A → G11-B → G11-C → accepted decisions → G11-D → diff → readiness |
| `studio/tests/web-g11d-decisions.test.mjs` | Web recording, revision safety, tampering, import, and stored-application binding |

Regression families from the brief map onto these as: A immutability, B
determinism, C KEEP, D ASSIGN, E MOVE, F OMIT, G DUPLICATE, H conflict, I stale,
J tamper, K Lead, L Core3, M round pipeline.

## Mutation exercise

Ten deliberate defects were introduced one at a time into
`decision-application.mjs` / `decision-review.mjs`, the six G11-D suites were run,
and the source was restored. Every mutation was caught.

| # | Mutation | Caught by (first of N) |
| --- | --- | --- |
| 1 | the baseline's event array is sorted in place | `the Source-Faithful Baseline is byte-identical before and after` (1) |
| 2 | any `acceptance.state` is read as acceptance | `a decision without an explicit acceptance record cannot be constructed` (2) |
| 3 | conflicting dispositions resolve by last write | `two moves of one event to different roles is reported, never resolved` (4) |
| 4 | the reviewed-revision binding is not checked | `a decision bound to a superseded candidate revision is refused` (4) |
| 5 | an accepted Lead move skips the Lead Demotion Gate | `a Melody demotion without the evidence chain is PENDING, not applied` (3) |
| 6 | an omission disappears from the baseline diff | `OMIT_FROM_SIX removes from the candidate only, and can never vanish from the record` (5) |
| 7 | derived duplicate ids are random | `duplicate identity depends on the decision, so two reviewers do not collide` (4) |
| 8 | a duplicate claims its own source event id | `a duplicate is derived candidate material, never a second source event` (5) |
| 9 | a failed batch applies its legal members | `one illegal decision in a batch of twenty leaves nothing applied` (26) |
| 10 | readiness is skipped after application | `omitting Core3 material is applied, and then blocked by the Core3 gate` (9) |

Mutation 1 is the interesting one: the project digest deliberately normalizes
array order away, so it does **not** catch an in-place sort. The deep-equality
regression does. Both checks exist because neither alone is sufficient.

Five further mutations cover the external-review P1 fix. All five were caught.

| # | Mutation | Failing tests |
| --- | --- | --- |
| 11 | the `sourceEventId` membership check is removed | 10 |
| 12 | promotion does not check identity | 3 |
| 13 | downstream report generation trusts the applied evidence | 2 |
| 14 | one-event containment is removed | 5 |
| 15 | demotion accepts the existing gate's answer without binding | 4 |

Mutation 11 is the one that matters most: removing only the `sourceEventId` half
leaves the `sourceId` check in place, which still passes for any two events from
the same source — the exact hole the external review found.

## External review P1 — Lead evidence was not bound to the targeted event

Found by independent external review of PR HEAD `cc8e3b4`, after the first six
checkpoints. Recorded here rather than quietly folded in.

**Finding.** `evaluateLeadDemotion()` asks only that a source identity be
present, and `leadPromotionBlockers()` asked the same. Neither confirmed the
identity belonged to the event under decision.

**Exploit.** Event A is moved out of Melody, or promoted into it, while carrying
event B's `sourceIdentity` and B's score/audio evidence. The gate accepts it.
Worse, `leadDemotionReportsFromApplication()` then re-ran the gate with A's
baseline event and produced `{eventId: 'A', status: 'PASS'}`, and the readiness
Lead gate matches reports to required Lead events by `eventId` — so B's evidence
became A's Lead PASS. Reproduced before the fix on all three vectors, including
`readiness.gates.leadDemotion === 'PASS'` for a Melody event whose only evidence
described a different one.

**Root cause.** Presence of an identity was treated as proof of identity. Two
events from one source share a `sourceId`, so even a `sourceId` comparison would
not have closed it; the `sourceEventId` binding is the necessary condition.

**Fix.** The shared `leadEvidenceIdentityBlockers()` above, enforced in the
backend application path so no caller can bypass it, on demotion and promotion
alike, plus the one-event containment and the downstream re-check.

**Consequence for callers.** A reviewer can no longer assign or demote a whole
lane of Lead events in one decision. That pattern is exactly what let one
citation stand for many events, and it is now one decision per Lead event, each
with its own citation. The end-to-end pipeline fixture was updated accordingly.

## Findings from the pre-PR adversarial review

No P0 or P1 was found by the pre-PR self-review; the P1 above came from
independent external review afterwards, which is the honest reading of what a
self-review is worth. Three P2/P3 items were found and fixed before the PR:

* **P2 — a duplicate's doubling with its own original was reported nowhere.**
  Cross-source arbitration correctly skips it (same `sourceIds`), and no other
  layer looked. Fixed: `DERIVED_DUPLICATE_SOUNDS_WITH_ORIGINAL`.
* **P2 — a derived duplicate id colliding with an existing event id would have
  surfaced as a thrown Canonical duplicate-id error** rather than a structured
  rejection. Fixed: `DERIVED_DUPLICATE_ID_COLLISION`, checked before construction.
* **P3 — the embedded baseline snapshot was over-filtered.** It had gate-evidence
  keys stripped from it as well as from the candidate. Gate evidence is only read
  from the candidate, so the snapshot now keeps the baseline verbatim apart from
  the two keys that would nest a snapshot inside a snapshot.

Remaining, recorded rather than fixed:

* **P3 — decision records are not authenticated.** See the Studio Web section
  above. Local workspace storage is the reviewer's own; the bindings, not a
  signature, are what make a decision unusable against inputs it was not
  reviewed against.
* **P3 — arbitration decisions already on the baseline are trusted.** G11-D
  carries them forward unchanged and manufactures none. In the Web path
  `readCanonical()` already forces imported decisions to `pending`; in a direct
  backend call the caller owns the baseline.

## Known limitations

* No Arrangement Editor UI, piano roll, drag-and-drop editing or verification
  player. Decisions are recorded through the model API.
* Lane targeting requires the G11-C suggestion the decision was accepted against.
  A lane whose events are not all present in the project being applied onto fails
  closed rather than shrinking to the survivors.
* A Lead-affecting decision must resolve to exactly one note event. Multi-event
  Lead decisions need an `eventId → Lead evidence` contract and are deferred.
* An event carrying no `sourceEventIds` cannot be the target of a Lead-affecting
  decision at all. That is the fail-closed consequence of requiring the binding,
  and it is a real restriction for any adapter that leaves the field empty.
* The Lead evidence path in `studio/web/model.mjs` that predates G11-D calls
  `evaluateLeadDemotion()` directly and is **not** covered by this binding. It is
  outside this stage's application path and was left alone rather than widened
  into; it is recorded here so the gap is visible rather than assumed closed.
* Rest events are carried through unchanged and cannot be targeted.
* Reduced one-/two-role performance questions (`PENDING.md` P17) are untouched.
* M6 (Canonical bootstrap Git-subprocess fragility under parallel tests) is not
  in scope and was not worked around. It reproduces on the unmodified base
  commit; see `docs/V1_1_ROADMAP.md` M6.
