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
* G11-D never reports Core3 as complete. `certifiesCore3Complete` is `false`,
  and Core3 completeness is decided by `arbitration/core3.mjs` against the
  baseline, after application.

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
