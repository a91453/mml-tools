# G11-C — Traceable Six-Role Candidate Suggestion

Status: IMPLEMENTER NOTE — **NOT CANONICAL**
Stage: G11-C (Arrangement Candidates)

This file records the G11-C implementation across its checkpoints. It is not a Canonical
authority. Under `docs/CANONICAL_MANIFEST.md` the only Canonical rule sources are
the four human-readable documents pinned at `rules_snapshot_sha`; **nothing here
adds, amends, or reinterprets them.** G11-C implements Published Canonical; it
does not define Canonical.

Canonical release loaded for this stage:

| Field | Value |
| --- | --- |
| `canonical_version` | `2026-09-13-v1` |
| `canonical_status` | `PUBLISHED` |
| `manifest_version` | `2026-09-13-v1-manifest1` |
| `rules_snapshot_sha` | `0a172900a01fdf39c2e9e84cf176961320b779ea` |
| Manifest commit | `5e7666b850a37f1c85ee2dd8cd0f4fac037a9e14` |

---

## 1. Where this stage sits

```
G11-A   raw MIDI            -> Source-Faithful Evidence / Canonical IR
G11-B   source voices       -> lossless source-aware monophonic candidate lanes
G11-C   evidence + lanes    -> traceable six-role candidate suggestions
```

The G11-A Source-Faithful Baseline remains **immutable truth**. The G11-B
decomposition remains **lossless evidence**. G11-C outputs **role candidates**,
not accepted Final arrangements, and certifies no acceptance gate.

Entry point: `suggestRoleCandidates(project, options)` in
`studio/backend/arrangement/role-candidates.mjs`, re-exported from
`studio/backend/arrangement/index.mjs`.

## 2. Scope boundary

G11-C **does**: candidate lane construction from G11-B output, structured role
evidence, six-role candidate assignment, an event-level role-decision ledger,
explicit `PENDING`, explicit overflow/unassigned retention, separate Core3 and
Full6 reasoning, cross-role review signals, and an exact event coverage audit.

G11-C **does not**: emit Final MML or paste-ready `MML@`, canonicalize Final
syntax, shift octaves, map volume, assign instruments, emit a Tempo Map, quantize
or rewrite timing, repair collisions, run a theory cleanup pass, allocate
performers, accept a six-role arrangement, begin later verification/player work,
or touch G12 interoperability. `ROLE_CANDIDATE_STATUS` states each of these as `false`, and
`studio/tests/role-candidates.test.mjs` asserts it.

Heuristic evidence is not authority. `PENDING` is a valid, preferred outcome.
The six-role limit is a capacity fact and never authorises silent deletion.

## 3. Canonical rules this stage is built around

- **§0 / §4 authority and Lead policy.** Melody is the Lead role, not
  Vocal-only. `highest note -> Melody` and `not proven Vocal -> demote` are
  forbidden inferences, and a source-supported Lead demotion needs positive
  evidence plus a demotion report.
- **§2 musical decision hierarchy.** Source completeness -> Lead continuity ->
  Core3 completeness -> Full6 enrichment. Nothing is optimized across all six
  roles at once.
- **§3 / SOURCE_POLICY.md §3 source-complete baseline.** Every candidate move is
  diffable at event level against the baseline.
- **§5 Core3 / Full6.** Chord2 is the bass skeleton **plus** any essential inner
  voice a complete one-player arrangement needs; it is never hardened into
  Bass-only. Chord3–Chord5 are enrichment and must not make Core3 less complete.
- **§6 cross-source arbitration.** Same-pitch overlap and dense simultaneous
  attacks are review signals, never automatic deletion targets.
- **§8 drum policy.** Percussion/unsupported material never becomes a pitched
  role here.
- **ACCEPTANCE_CRITERIA.md Gates 2–5.** Implemented as candidate-stage *readings*
  only. This stage sets no gate result.
- **PENDING.md P17.** One-role and two-role completeness remain unresolved, so
  they are reported as diagnostics and never as completeness.

## 4. Candidate data model

`mabinogi-mobile-mml-studio/role-candidate-arrangement@1`:

| Field | Contents |
| --- | --- |
| `roles` | The six target roles. Each has `status`, `laneIds`, `eventIds`, `evidenceTier`/`evidenceTierName`, `reasons`, `competingLaneIds`, `evidenceIds`, `duplicatedLaneIds`, and a `core3`/`full6` group tag. A role holds **zero or more** lanes. |
| `lanes` | One candidate lane per (source voice, G11-B lane), with `chainIds`, `eventIds`, `sourceIds`, `sourceEventIds`, `declaredSourceRoles`, exact `metrics`, `soundingIntervals`, `continuity`, `roleSupport`, `evidence`, and the original G11-B `spans`. |
| `ledger` | One entry per (source event, decision). Carries `sourceRole`, `candidateRole`, `proposedRole`, `decision`, `reason`, `evidenceIds`, `competingLaneIds`, `uncertainty`, `selected`, `duplicate`, `provisional`, and the **restated source pitch/onset/end** so the ledger itself proves nothing was mutated. |
| `unassigned` | Lanes not selected into this six-role proposal, with reason, competing role, added functions, `essential`, `provisional: true`, evidence ids, and every event id. |
| `pending` | Lanes whose role decision is open, with blockers, competing lanes, evidence ids, event ids, and (for a refused Lead demotion) the gate that must decide it. |
| `unsupportedSourceMaterial` | Percussion / unsupported source notes, retained with full timing and `status: 'PENDING'`. |
| `declaredDuplications` | Caller-declared candidate duplications with their reason and evidence. |
| `core3` / `full6` | Separately inspectable, see §6 and §7. |
| `reducedRoleDiagnostics` | One-/two-role diagnostics, see §8. |
| `diagnostics` | Cross-role review signals, see §9. |
| `coverage` | The exact event-level coverage audit, see §10. |
| `thresholds` | `ROLE_CANDIDATE_THRESHOLDS`, declared as implementer heuristics. |

Decision vocabulary (`ROLE_DECISIONS`): `KEEP_ROLE`, `ASSIGN_ROLE`, `MOVE_ROLE`,
`OMIT_FROM_SIX`, `DUPLICATE_WITH_JUSTIFICATION`, `PENDING`.

## 5. Role evidence model

Evidence is a list of structured records, never an aggregate score. Each record
carries its own `measurement`, the `threshold` it was judged against, an
`evidenceClass` (`symbolic` for declared source facts, `symbolic-derived` for
measurements; audio evidence is a **separate class and is not accepted at this
layer**), and a `strength`:

- `primary` — may, on its own, support a role proposal;
- `supporting` — context only; **can never create an assignment**;
- `conflict` — recorded disagreement, never silently resolved.

| Signal | Strength | Notes |
| --- | --- | --- |
| `source_role_hint` | primary | Role carried by the baseline event itself. |
| `trusted_symbolic_role` | primary | Caller-supplied, **citation required**, and applied **only to the material every selector on the entry names** (see below). |
| `melodic_contour` | primary when the gate passes | Distinct pitches and pitch-change ratio across real attacks. |
| `attack_independence` | primary when the gate passes | Share of attacks that coincide with a sibling lane of the same source voice. |
| `bass_function` | primary when the gate passes | Time spent as the lowest sounding pitch, measured over the exact sounding grid. |
| `source_voice_identity` | supporting | Provenance separation. A G11-B lane index carries no role meaning. |
| `register_position` | supporting | Never proves Melody or Chord2. |
| `continuity` | supporting | Chain count and silence junctions; `continuousVoiceAsserted: false`. |
| `rhythmic_density` | supporting | Diagnostic only. |
| `instrument_hint` | supporting | GM program family; never proves a final role. |
| `section_role` | supporting | Form context; never demotes and never creates a Lead gap. |

### Scope of a cited role

A cited trusted symbolic role lands in tier 1 `DECLARED_SOURCE_ROLE`, where it
outranks every derived measurement and is one of the two things that clear the
Core3 interlocks. Its scope is therefore load-bearing, and the entry's
selectors — `sourceVoice`, `laneId`, `eventIds` and the optional `sourceIds` —
are **conjunctive**: every selector supplied has to hold before the claim
reaches a lane. A narrowing selector narrows and can never widen, so a citation
naming one lane of a polyphonic accompaniment voice never reaches its siblings.

`sourceIds` scopes a claim to the provenance that made it, and is a qualifier
rather than a target: a lane whose provenance reaches outside the declared set
is not covered by it and fails closed, exactly as cross-source arbitration does.

**Provenance is read from `sourceIds`, never from the `sourceVoice` string**
(§10). A voice label is a track/channel coordinate that two sources of one song
ordinarily share, so a voice-only citation over a label spanning several sources
identifies nothing: it is withheld from every lane rather than spread across
sources that did not make it, and is reported as `AMBIGUOUS_EVIDENCE_PROVENANCE`
with the sources it spans and the lanes it was withheld from. A withheld claim is
never silent. `laneId` and `eventIds` pin provenance by themselves and need no
such guard. Each record states its own scope in `scopedBy`, `declaredSourceIds`
and `laneSourceIds`.

Evidence **tiers** decide selection. Selection only ever happens inside the
highest non-empty tier, so a declared source role is never outvoted by a derived
measurement:

| Role | Tier 1 | Tier 2 | Tier 3 |
| --- | --- | --- | --- |
| Melody | `DECLARED_SOURCE_ROLE` | `INDEPENDENT_MELODIC_LINE` | `MELODIC_LINE_AT_HARMONIC_FLOOR` |
| Chord1 | `DECLARED_SOURCE_ROLE` | `PRINCIPAL_HARMONY_COVERAGE` | — |
| Chord2 | `DECLARED_SOURCE_ROLE` | `BASS_FUNCTION` | — |

Weaker-tier evidence is **kept, not erased**: a walking bass assigned to Chord2
on its tier-2 bass function still carries its tier-3 Lead evidence, and the
disagreement is reported as `CONFLICTING_ROLE_EVIDENCE`.

## 6. Core3 logic

### Core3 is a three-role musical unit

Core3 is **Melody + Chord1 + Chord2 evaluated as one musically complete
single-player three-role arrangement**. It is *not* Melody + Chord2 with Chord1
as an optional middle layer. The three roles carry distinct required functions
inside the same completeness target, with **no priority among them**:

| Role | Required function |
| --- | --- |
| Melody | source-supported Lead continuity |
| Chord1 | Core Harmony / principal accompaniment / essential response |
| Chord2 | Core Bass skeleton **plus** any essential inner support required for one-player completeness |

All three must be positively resolved before `core3.status = COMPLETE`.
Therefore:

- unresolved Chord1 cross-source arbitration **blocks** Core3 `COMPLETE`;
- a strong Melody and a strong bass do **not** compensate for an unresolved or
  missing Chord1;
- Chord2 must not absorb Chord1's principal-harmony responsibility to make Core3
  pass;
- Chord3–Chord5 must not compensate for a weak or unresolved Chord1;
- candidate ranking preserves the three-role architecture rather than optimizing
  Lead + bass coverage alone.

The question the candidate answers is *"do Melody + Chord1 + Chord2 together form
the best source-supported single-player musical backbone?"* — never *"are Melody
and bass good enough, with something placed in Chord1?"*

This creates no Canonical priority among the three roles. It is the same
implementer-side reading of `MASTER_RULES.md` §5 and `ACCEPTANCE_CRITERIA.md`
Gate 4 used throughout. The invariant is stated in the output itself as
`core3.architecture`, with `priorityAmongRoles: 'NONE'` and
`allThreeRequiredForComplete: true`.

**The internal assignment sequence is a dependency order, not a priority order.**
Roles are processed Melody → Chord2 skeleton → Chord1 → essential inner support
because essentiality can only be measured once the roles it is measured against
exist. That sequence asserts nothing about musical importance, and no step may
be read as "Lead and bass are the real backbone, harmony is optional support".

### Assignment

Assignment order follows the Canonical hierarchy: Lead, then bass skeleton, then
principal harmony, then essential inner support.

- **Melody.** Candidates are taken from the strongest non-empty tier. Lanes in
  that tier that are **time-disjoint** are a hand-off and all receive Melody
  (`LEAD_HANDOFF_CONTINUATION`) — a vocal rest filled by an instrumental answer
  is not a contest and must not become a false gap. Lanes in that tier that
  **overlap** are a contest: the whole Melody decision becomes `PENDING`, no lane
  is assigned, and every candidate keeps its evidence.
- **Chord2 (skeleton).** Same tier/disjointness rule on bass-function evidence.
- **Chord1.** Declared evidence decides outright. Otherwise the *source voice*
  with the greatest harmonic coverage is ranked first (ties broken by attack
  count, then `PENDING`), and only then its principal lane. Choosing at voice
  level stops "one accompaniment voice, three chord members" from looking like a
  three-way tie. Register is used **only** to order lanes inside one
  already-ranked accompaniment voice, recorded as
  `TIE_BROKEN_BY_REGISTER_WITHIN_SOURCE_VOICE`; it never establishes a voice's
  function and never selects Melody or Chord2.

  **Candidate selection is not functional evidence** (checkpoint 2). Total
  sounding time, attack count, register and density rank candidates; none of
  them establishes that a source voice *is* the principal harmony. A long
  sustained pad outlasts the real accompaniment without being it. So the role
  can be `ASSIGNED` with `evidenceTierName: BEST_AVAILABLE_COVERAGE_CANDIDATE`
  while `core3.functions.principalHarmony.status` is `CANDIDATE_ONLY` and
  `evidenceStrength: HEURISTIC_CANDIDATE`. Only a declared source role or a
  cited trusted symbolic role yields `PRESENT` / `POSITIVE`. Melody's and
  Chord2's tier-2 signals are direct functional measurements of a line and of
  the harmonic floor, so they remain positive; this narrowing is specific to
  Chord1's coverage ranking.
- **Essential inner support.** A lane is *proven* essential when it sounds in a
  window where Core3 is silent, or where Chord1 and Chord2 are both silent and
  the Lead is left with no accompaniment at all. Proven-essential lanes are
  promoted into Chord2, which is how Chord2 carries the bass skeleton **plus**
  essential inner material. Windows are read only inside the span Core3 occupies:
  a lane merely running past Core3's last event is an end-time question
  (PENDING.md P14), not evidence of missing essential material, and is reported
  separately as `outsideCore3SpanWindows`.

  **The silence-gap test is one positive route to essentiality, not the
  definition of it** (checkpoint 2). A lane can carry essential harmonic identity
  while sounding concurrently with Core3, where no gap analysis can reach it.

- **Concurrent harmony resolution** (checkpoint 2, a separate Core3 function).
  A polyphonic accompaniment source voice decomposes into several simultaneous
  G11-B lanes. When one is selected into Core3 and a sibling of the *same source
  voice*, overlapping it in time, is left outside, that sibling may carry
  harmonic identity a complete one-player arrangement needs. Core3 never falls
  silent there, so nothing proves it essential — and **absence of evidence that a
  lane is essential is not evidence that it is optional**. The sibling is
  therefore reported as `UNRESOLVED_CORE_HARMONY_SIBLING` and Core3 cannot be
  `COMPLETE` while the blocker is open.

  This is an **uncertainty interlock, not an assignment rule**: the lane is not
  moved, merged, deleted, or forced into Chord2, and it is not claimed essential
  either. Only positive evidence clears it — a declared source role or a cited
  trusted symbolic role naming Chord3, Chord4 or Chord5 for that lane. The
  interlock is scoped by provenance to siblings of Core3 source voices, so a
  counter-line in its own source voice never trips it.

**A declared source role outranks every derived measurement** (`MASTER_RULES.md`
§0). A lane whose source names it `Chord2` is not eligible for Melody just
because the derived contour measurement likes it, and a lane named `Chord1` is
not pulled into Chord2 because it happens to sit at the harmonic floor. Such a
promotion is an unevidenced role move — the mirror of the demotion the Lead
interlock refuses — and it quietly dismantles the three-role unit by leaving a
declared role empty. A lane carrying a declared role is only eligible for a role
its own source evidence names.

**Cross-source Chord1 arbitration.** When the accompaniment candidates come from
more than one source, `principalHarmony.arbitration` records the exact source ids
behind each candidate voice, the type of disagreement, and the decision —
`PENDING`, or `RESOLVED_BY_DECLARED_SOURCE_ROLE` (`SOURCE_POLICY.md` §2, §5). A
coverage ranking may still propose a winner, but an unresolved cross-source
arbitration is reported as `UNRESOLVED_CROSS_SOURCE_HARMONY` and Core3 cannot be
complete. A losing accompaniment from another source is never allowed to vanish
into enrichment with nothing in the report saying an arbitration was left open.

**Same-source co-assignment vs. cross-source stacking.** These are different
questions and are handled differently:

| Declared Chord1 lanes | Handling |
| --- | --- |
| Several overlapping lanes, **one source provenance** | Co-assigned. One source naming the role for all of them leaves nothing to pick between, and a role holds zero or more lanes. Declaring a whole accompaniment staff as Chord1 yields Chord1. |
| Overlapping lanes, **distinct source provenance** | `CROSS_SOURCE_DECLARED_CHORD1_OVERLAP`. Neither is stacked, neither is chosen, neither is dropped. `principalHarmony` is `PENDING` and Core3 cannot be complete. |
| **Non-overlapping** lanes from distinct sources | Co-assigned. A sectional or arrangement hand-off stays representable; differing source ids alone are never the conflict. |

A declared source role proves *"this source presents this material as Chord1"*.
It does **not** prove *"two separate arrangements are mutually compatible and may
be stacked into one Core Harmony"* — `MASTER_RULES.md` §6 forbids directly
stacking alternate arrangements merely because each has a source, and
`SOURCE_POLICY.md` §5 says a source proves provenance, not compatibility. Both
candidates keep every lane, event, `sourceIds` and `sourceEventIds`; the conflict
is reported as `UNRESOLVED_CROSS_SOURCE_DECLARED_CHORD1` with the exact source
ids and the exact overlap windows, and clears through an explicit keep / omit /
move-role / redistribute arbitration — for example declaring one source `Chord1`
and the other `Chord3`–`Chord5` with a citation. The loser is then preserved as
enrichment rather than dropped.

**No automatic source authority.** Nothing here prefers official over
third-party, earlier over later, longer over shorter, or one source id's sort
order over another's. Canonical requires arbitration, and without one the answer
is `PENDING`.

**Provenance is read from `sourceIds`, never from the `sourceVoice` string.** Two
source voices of one source are still one provenance; a lane whose own provenance
is mixed is never treated as safely same-source, because nothing establishes that
it is, and it fails closed into the conflict instead.

**Lead-demotion interlock.** A lane carrying a declared source Lead cannot be
moved off Melody here, not even by an explicit caller override. The move is
refused, the lane becomes `PENDING` with blocker `LEAD_DEMOTION_NOT_EVALUATED`
pointing at `arbitration/lead-demotion.mjs#evaluateLeadDemotion`, **and no
substitute Lead is quietly chosen in its place** — promoting some other lane to
Melody while the declared Lead is unresolved would be the same rewrite by another
route.

`core3.status` is `COMPLETE` only when **all** of the following hold:

1. Melody carries recognizable source-supported Lead continuity;
2. Chord1 supplies principal harmony, **positively evidenced** — not merely the
   best-ranked candidate;
3. Chord2 supplies a measured or declared bass skeleton;
4. every *proven* essential lane is inside Core3;
5. no unresolved possible-essential harmony/inner material is outstanding;
6. nothing is `PENDING` and no blocking conflict is open;
7. Full6 holds no material Core3's musical identity still depends on.

This is an implementer-side fail-closed reading of `MASTER_RULES.md` §5 and
`ACCEPTANCE_CRITERIA.md` Gate 4. It defines no new Canonical rule.

Otherwise the candidate is `PENDING` (evidence unresolved) or `INCOMPLETE` (a
function is positively absent, or Core3 provably depends on enrichment).
**Three non-empty roles are never sufficient**, and neither is "Core3 never falls
silent": Published Canonical requires musical completeness, not temporal
coverage. A function is only reported positively absent while no role decision is
still open — Chord1 can read as empty simply because both of its candidates are
locked in an unresolved Lead contest, and calling that a deficiency would report
a verdict the evidence has not earned.

The report carries `functions` (five: `leadContinuity`, `principalHarmony`,
`bassSkeleton`, `essentialInnerSupport`, `concurrentHarmonyResolution`),
`rationale` (one entry per function, with the lanes it argues from),
`essentialEventIds`, `sourceCoverage`, `identityDependsOnEnrichment`,
`identityMayDependOnEnrichment`, `unresolvedHarmony`, `missingFunctions` (every
unsatisfied function) split into `absentFunctions` and `unprovenFunctions`,
`conflicts` and `pending`.

## 7. Full6 logic

Chord3–Chord5 are filled only after Core3, by a deterministic rank over exact
measurements: essential first, then useful, then ascending duplication ratio,
then added-function count, then sounding time, weighted pitch and lane id.

Each enrichment lane reports `addedFunctions` (`counter-line`, `inner-harmony`,
`sustained-texture`, `rhythmic-detail`, `secondary-bass-reinforcement`,
`essential-response`), the source events supporting it, `duplicationRisks` with
their exact ratios, `useful`, and `removingLeavesCore3Intact`.

`full6.status` is `NONE`, `USEFUL`, `REVIEW`, `PENDING`, or `CORE3_DEPENDENCY`.
An enrichment lane that turns out to be essential makes Core3 `INCOMPLETE` and
Full6 `CORE3_DEPENDENCY`: **Chord3–Chord5 may not be used to hide an incomplete
Core3**, and a non-empty enrichment role is never by itself a benefit.

Checkpoint 2 extends this to unresolved material. Enrichment means
optional-but-useful *after* Core3 integrity; it never means material Core3 may
still require. A lane carrying an open `UNRESOLVED_CORE_HARMONY_SIBLING` blocker
therefore reports `core3DependencyUnresolved: true`, is withheld from `useful`,
puts its role at `CORE3_DEPENDENCY_UNRESOLVED` and the whole view at
`CORE3_DEPENDENCY`, and is listed in `full6.core3DependencyLaneIds`. Its musical
contribution is still described in full — the uncertainty is exposed, not the
lane suppressed. `core3IntegrityIfRemoved` is a tri-state (`INTACT` / `DEPENDS` /
`UNRESOLVED`); `removingLeavesCore3Intact` asserts *established* intact only, so
it is false for both the proven-essential and the unresolved case.

## 8. Reduced-role diagnostics

`reducedRoleDiagnostics` reports role priority and the musical functions lost at
one and two roles. Every tier is stamped `canonicalCompleteness: 'NOT_DEFINED'`
with `pendingReference: 'PENDING.md P17'`, and `canonicalCompletenessGate` stays
`CORE3`. **One-role and two-role completeness are not defined by Published
Canonical and are never reported as complete here.** No performer-count
allocation policy is hard-coded; the per-role priority and enrichment rationale
exist so a later allocation stage can derive one.

## 9. Cross-role review signals

All non-destructive, all carrying `deleted: false`:
`SIMULTANEOUS_SAME_PITCH_DOUBLING`, `SUSTAINED_SAME_PITCH_OVERLAP` (with
`rolePairsPossible: 15`, PENDING.md P11/P15), `ROLE_DUPLICATION`,
`DENSE_SIMULTANEOUS_ATTACKS`, `LOW_MID_CLOSE_INTERVAL` (m2/M7/m9 below the
low/mid boundary), `COMPETING_LEAD_CANDIDATES`, `COMPETING_BASS_CANDIDATES`,
`COMPETING_HARMONY_CANDIDATES`, `CONFLICTING_ROLE_EVIDENCE`,
`SOURCE_LANE_OVERFLOW`, `AMBIGUOUS_EVIDENCE_PROVENANCE`,
`UNRESOLVED_CORE_HARMONY_SIBLING`,
`UNRESOLVED_CROSS_SOURCE_HARMONY`, `UNRESOLVED_CROSS_SOURCE_DECLARED_CHORD1`,
`ESSENTIAL_MATERIAL_IN_ENRICHMENT`,
`ESSENTIAL_MATERIAL_UNASSIGNED`, `LANE_PACKING_IS_NOT_CONTINUITY`,
`UNSUPPORTED_SOURCE_MATERIAL_RETAINED`, `ROLE_ASSIGNMENT_PENDING`,
`ROLE_CARRIES_MULTIPLE_LANES`, `CANDIDATE_COVERAGE_MISMATCH`.

No theory cleanup pass is performed. These are arbitration inputs.

## 10. Source / provenance invariants

- Input event ids **equal** assigned ∪ pending ∪ unassigned ∪ unsupported.
- No pitch, onset, duration, prominence or octave is changed, and the ledger
  proves it by restating the source values beside every decision; any drift would
  surface as `coverage.mutatedEventIds`.
- No event is deleted, added, merged, truncated, tied or quantized.
- Six-role capacity never authorises deletion: overflow is retained in
  `unassigned` with reason, competing role, evidence and `provisional: true`.
- A candidate duplication is **never inferred**. A caller must declare the roles,
  a positive reason and explicit evidence; each copy is then a
  `DUPLICATE_WITH_JUSTIFICATION` ledger entry and the original source event stays
  identifiable in all of them.
- Two source voices sharing a MIDI channel on different tracks stay distinct.
- Chains packed into one G11-B lane are a packing fact:
  `continuousVoiceAsserted` is always `false`, and continuity across a silence
  junction is never asserted.
- `averagePitch` from G11-B is a presentation float and is never read. All
  ordering, matching and measurement use exact rationals.

## 11. Determinism

Input is re-sorted before anything else, so caller array order cannot change the
result. Every ordering and every decision is made on exact rationals, integers,
or string ids; no decision reads Map or Set enumeration order, and no beat is
projected to a float. `1/3` stays `1/3`.
`studio/tests/role-candidates.test.mjs` re-runs every fixture rotated, reversed,
id-descending and pitch-ascending and requires byte-identical output.

## 12. Synthetic regression coverage

All fixtures are synthetic and legally clean. **No historical song fixture exists
and none is claimed** — PENDING.md P12 applies, and no named regression is
reported as passing.

`studio/tests/role-candidates.test.mjs` covers: obvious Lead + harmony + bass;
six roles with Core3 independently complete; vocal-rest instrumental hand-off;
a top voice that is clearly accompaniment; strong bass plus essential inner
support; an ambiguous two-Lead situation; more than six meaningful lanes;
simultaneous same-pitch source events; one role represented by several lanes;
source role change and the refused Lead demotion; declared candidate duplication;
shuffled input; exact triplet timing; silence-separated G11-B chains; a shared
MIDI channel across tracks; percussion and unsupported material; Core3 non-empty
but musically incomplete; essential material misplaced into Chord3; redundant
enrichment; useful enrichment; reduced-role diagnostics; scope and gate
boundaries; input contracts; caller exclusion; competing bass candidates;
sustained same-pitch overlap, dense attacks and low/mid compression; and a
work-shape sanity check on a moderate score.

Checkpoint 2 adds: a long pad that cannot outrank trusted principal-harmony
evidence; the same fixture with no distinguishing evidence, where a candidate is
still offered but Core3 stays `PENDING`; a concurrent omitted inner sibling with
no silence gap anywhere, which must not disappear, must not be forced into
Chord2, and must block `COMPLETE`; the same fixture with positive enrichment
evidence, which reaches `COMPLETE`; proof that the interlock is scoped to Core3
source voices rather than every omitted lane; proof that an unresolved sibling is
never reported as proven essential; and a scan asserting the G11 roadmap names
only A, B and C.

The Core3 three-role invariant adds: a clear Melody and clear bass with an
unresolved cross-source Chord1, which must stay `PENDING`; the same material
after explicit Chord1 arbitration, which reaches `COMPLETE`; a matrix degrading
each of the three functions in turn, none of which may be covered by the other
two; enrichment piled onto an unresolved Chord1, which must not move the verdict;
and a declared `Chord2` lane that a derived Lead signal must not promote.

Overlapping cross-source declared Chord1 adds: same-source polyphony still
co-assigning without deadlock, including when one source is split across two
source voices; overlapping declarations from two sources becoming a reported
conflict with `principalHarmony` `PENDING` and Core3 `PENDING`, by both the
event-level and the cited-evidence declaration paths; explicit arbitration
clearing it with the loser preserved as enrichment; a non-overlapping hand-off
that must not be rejected for differing source ids; a multi-source project where
only one source declares Chord1; Melody and Chord2 unable to compensate;
enrichment neither compensating nor laundering the conflict; a mixed-provenance
lane failing closed; and proof that no source authority — order, length or id
sort — picks a winner.

Evidence scope adds: a narrowing selector that must not widen to unnamed lanes;
a citation for one lane that must not clear another lane's
`UNRESOLVED_CORE_HARMONY_SIBLING` interlock, and the named citation that does;
a voice label shared by two sources failing closed and reporting itself; the
same claim re-issued with `sourceIds` reaching exactly the provenance that made
it; a lane reaching outside a declared provenance scope; and the `sourceIds`
input contract.

### End-to-end pipeline regression

`studio/tests/g11-pipeline.test.mjs` runs the real production path from raw
Standard MIDI File bytes: `ingestMIDI` → `midiFragmentToProject` (G11-A) →
`splitProjectSourceVoices` (G11-B) → `suggestRoleCandidates` (G11-C). Hand-built
Canonical events would prove nothing about the contracts *between* the stages,
which is what that file exists to check.

The fixture uses PPQ 360 so a beat divides exactly into thirds, and carries a
triplet Lead opening, a genuine one-bar Lead rest with an instrumental answer
over it, a polyphonic block-triad accompaniment, a moving bass, a sustained pad,
a same-pitch simultaneous double from two distinct source events, more lanes than
six-role capacity, and General MIDI channel-10 percussion. It asserts: source
event conservation by id and by count; the provenance chain from raw note-on /
note-off through the Canonical event and the G11-B lane and chain to the G11-C
ledger entry; `1/3` and `2/3` spelled identically at all three stages with no
float anywhere in the candidate; percussion staying unsupported and never
becoming a pitched role; bare MIDI failing closed to Core3 `PENDING`; the Core3
three-role backbone — including the Lead hand-off across the rest — surviving the
whole pipeline once the score's role evidence is supplied; that no stage does
another stage's job or mutates source truth; and determinism under permuted
source-event and caller-evidence order.

Performance is asserted as a **work shape**, matching the repository's existing
convention in `micro-timing-performance.test.mjs` — one sweep over the exact
boundary grid, bucketed same-pitch scans, and counters that stay output-sensitive
as the score doubles. No wall-clock budget is turned into a pass/fail rule.

## 12a. Checkpoint 2 — fail closed on unresolved core harmony

Checkpoint 1 could report `core3.status = COMPLETE` in two situations the
evidence did not support. Both were reproduced with minimal synthetic probes
before anything was changed, and both are now regressions in
`studio/tests/role-candidates.test.mjs`.

| Fail-open | Checkpoint-1 behaviour | Checkpoint-2 behaviour |
| --- | --- | --- |
| A long sustained pad wins the Chord1 coverage ranking | `principalHarmony.status: PRESENT`, `satisfied: true`, Core3 `COMPLETE`, real accompaniment demoted to Chord3 as "useful enrichment" | Role still `ASSIGNED` as `BEST_AVAILABLE_COVERAGE_CANDIDATE`; `principalHarmony.status: CANDIDATE_ONLY`, `satisfied: false`, Core3 `PENDING`. With declared/cited evidence the shorter true harmony wins Chord1 and Core3 reaches `COMPLETE`. |
| A concurrent sibling of a Core3 source voice sits outside Core3 with no silence anywhere | `essentialInnerSupport: NOT_REQUIRED`, Core3 `COMPLETE`, Full6 `USEFUL` with `removingLeavesCore3Intact: true` | `UNRESOLVED_CORE_HARMONY_SIBLING` raised, `concurrentHarmonyResolution: UNRESOLVED`, Core3 `PENDING`, Full6 `CORE3_DEPENDENCY`. The lane is preserved, is not moved into Chord2, and is not claimed essential either. Declared/cited enrichment evidence on the sibling clears it and Core3 reaches `COMPLETE`. |

The repair is evidence discipline plus fail-closed completeness, not music
theory. **No chord-name inference, key detection, harmonic-function analysis or
statistical chord-completeness threshold was added, and none is planned here.**
The two questions kept apart throughout are:

- "this is our best current candidate" vs. "this function is positively
  established";
- "this omitted lane does not fill a silence" vs. "this omitted lane is proven
  non-essential".

Nothing in the checkpoint-1 contract was removed. `missingFunctions` keeps its
meaning as the superset of every unsatisfied function and is now split into
`absentFunctions` and `unprovenFunctions`.

### Consequence for bare MIDI

A MIDI with no role metadata and a polyphonic accompaniment voice now reports
Core3 `PENDING` rather than `COMPLETE`. That is the intended outcome: from that
input alone nothing establishes which simultaneous lane is the principal harmony,
nor that the others are droppable without losing the arrangement's identity. The
candidate is still produced in full — roles assigned, lanes ranked, rationale and
evidence attached — it simply no longer claims a completeness it cannot support.
Several checkpoint-1 fixtures asserted `COMPLETE` on exactly such input; those
assertions encoded the fail-open and now supply the score's own role evidence so
that each fixture's actual subject stays isolated.

## 12b. Evidence scope hotfix — a citation speaks only for what it names

A cited trusted symbolic role is tier 1 `DECLARED_SOURCE_ROLE`. It outranks every
derived measurement, and it is one of the two things that clear the checkpoint-2
Core3 interlocks. How far such a claim reaches is therefore as load-bearing as
the claim itself, and it reached further than the caller said in two ways. Both
were reproduced with minimal synthetic probes before anything was changed, and
both are now regressions in `studio/tests/role-candidates.test.mjs`.

| Fail-open | Previous behaviour | Behaviour now |
| --- | --- | --- |
| An entry carries more than one of `sourceVoice`, `laneId`, `eventIds` | Selectors were read as alternatives, so a lane matching any single one received the claim: the broadest selector won and a narrowing selector silently widened. A citation naming one lane of a polyphonic accompaniment voice reached its siblings, cleared `UNRESOLVED_CORE_HARMONY_SIBLING` on lanes it never named, and Core3 could report `COMPLETE` on evidence that did not cover them. | Selectors are conjunctive: every selector supplied must hold. The claim reaches the named lane and nothing else; an unnamed sibling keeps its interlock and Core3 stays `PENDING` until a citation names *it*. |
| A voice-only citation in a multi-source project | Provenance was taken from the `sourceVoice` string, which §10 says it never is. A track/channel label is ordinarily shared by two sources of one song, so one source's citation was applied to the other's lanes, and the report carried the official score's citation text against third-party material. | The label is not provenance. A voice-only claim over a label spanning several sources is withheld from every lane and reported as `AMBIGUOUS_EVIDENCE_PROVENANCE` with the sources it spans and the lanes it was withheld from. Re-issuing it with `sourceIds`, a `laneId` or `eventIds` says which source it speaks for, and it then reaches exactly that provenance. |

`sourceIds` is the new optional qualifier, and it narrows only: it is never a
target on its own, because "everything this source ever published is Chord1" is
not a claim any citation supports. A lane whose provenance reaches outside the
declared set is not covered by it and fails closed, matching the existing
mixed-provenance rule in cross-source arbitration. `laneId` and `eventIds` pin
provenance by themselves and are unaffected.

The repair is evidence discipline, not music theory. **No chord-name inference,
key detection, harmonic-function analysis or statistical threshold was added.**
The question kept apart throughout is "this citation covers this material" vs.
"this citation exists somewhere in the project". Nothing in the earlier contract
was removed: no existing caller supplied more than one selector, so no fixture
changes meaning, and each record now states its own scope in `scopedBy`,
`declaredSourceIds` and `laneSourceIds`.

### Consequence for callers

A caller that annotated a whole voice in a project where that voice label is
carried by one source is unaffected. A caller doing the same where two sources
share the label now gets no assignment from that entry plus an explicit
diagnostic, instead of a silent cross-source claim. That is the intended
outcome: the label did not say which source was speaking, and inventing an
answer is exactly the automatic source authority `MASTER_RULES.md` §6 and
`SOURCE_POLICY.md` §5 refuse.

## 13. Explicitly deferred

Later stages own: Final Mobile MML emission and canonicalization, paste-ready
`MML@`, octave/register adaptation, volume and instrument assignment, Tempo Map
emission, in-game collision repair, audio-derived role inference, final six-role
acceptance, later verification/player work, G12 mml.mabi.tw interoperability, and
any performer-count allocation policy.

The currently defined project roadmap names **G11-A, G11-B and G11-C only**.
Verification/player tooling is future out-of-scope work and is deliberately left
unnamed here; it is not a fourth numbered G11 stage.

No mml.mabi.tw production code was copied or consulted; that reference remains
`MML_MABI_REFERENCE_NOT_VERIFIED` (see `docs/G11A_SOURCE_REVIEW.md` §1). No
Draft2 history or legacy Skill was used to invent a role rule.
