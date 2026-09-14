# G11-C — Traceable Six-Role Candidate Suggestion

Status: IMPLEMENTER NOTE — **NOT CANONICAL**
Stage: G11-C (Arrangement Candidates)

This file records the G11-C checkpoint-1 implementation. It is not a Canonical
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
performers, accept a six-role arrangement, start G11-D, or touch G12
interoperability. `ROLE_CANDIDATE_STATUS` states each of these as `false`, and
`studio/tests/role-candidates.test.mjs` asserts it.

Heuristic evidence is not authority. `PENDING` is a valid, preferred outcome.
The six-role limit is a capacity fact and never authorises silent deletion.

## 3. Canonical rules this checkpoint is built around

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
| `trusted_symbolic_role` | primary | Caller-supplied, **citation required**. |
| `melodic_contour` | primary when the gate passes | Distinct pitches and pitch-change ratio across real attacks. |
| `attack_independence` | primary when the gate passes | Share of attacks that coincide with a sibling lane of the same source voice. |
| `bass_function` | primary when the gate passes | Time spent as the lowest sounding pitch, measured over the exact sounding grid. |
| `source_voice_identity` | supporting | Provenance separation. A G11-B lane index carries no role meaning. |
| `register_position` | supporting | Never proves Melody or Chord2. |
| `continuity` | supporting | Chain count and silence junctions; `continuousVoiceAsserted: false`. |
| `rhythmic_density` | supporting | Diagnostic only. |
| `instrument_hint` | supporting | GM program family; never proves a final role. |
| `section_role` | supporting | Form context; never demotes and never creates a Lead gap. |

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
  with the greatest harmonic coverage is chosen first (ties broken by attack
  count, then `PENDING`), and only then its principal lane. Choosing at voice
  level stops "one accompaniment voice, three chord members" from looking like a
  three-way tie. Register is used **only** to order lanes inside one
  already-identified accompaniment voice, recorded as
  `TIE_BROKEN_BY_REGISTER_WITHIN_SOURCE_VOICE`; it never establishes a voice's
  function and never selects Melody or Chord2.
- **Essential inner support.** A lane is *essential* when it sounds in a window
  where Core3 is silent, or where Chord1 and Chord2 are both silent and the Lead
  is left with no accompaniment at all. Essential lanes are promoted into Chord2,
  which is how Chord2 carries the bass skeleton **plus** essential inner
  material. Windows are read only inside the span Core3 occupies: a lane merely
  running past Core3's last event is an end-time question (PENDING.md P14), not
  evidence of missing essential material, and is reported separately as
  `outsideCore3SpanWindows`.

**Lead-demotion interlock.** A lane carrying a declared source Lead cannot be
moved off Melody here, not even by an explicit caller override. The move is
refused, the lane becomes `PENDING` with blocker `LEAD_DEMOTION_NOT_EVALUATED`
pointing at `arbitration/lead-demotion.mjs#evaluateLeadDemotion`, **and no
substitute Lead is quietly chosen in its place** — promoting some other lane to
Melody while the declared Lead is unresolved would be the same rewrite by another
route.

`core3.status` is `COMPLETE` only when **all** of the following hold:

1. Melody carries recognizable source-supported Lead continuity;
2. Chord1 supplies principal harmony / accompaniment / essential response;
3. Chord2 supplies a measured bass skeleton;
4. every essential lane is inside Core3;
5. nothing is `PENDING` and no blocking conflict is open.

Otherwise it is `PENDING` (evidence unresolved) or `INCOMPLETE` (a function is
positively absent). **Three non-empty roles are never sufficient.** The report
carries `functions`, `rationale` (one entry per function, with the lanes it
argues from), `essentialEventIds`, `sourceCoverage`, `identityDependsOnEnrichment`,
`missingFunctions`, `conflicts` and `pending`.

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
`SOURCE_LANE_OVERFLOW`, `ESSENTIAL_MATERIAL_IN_ENRICHMENT`,
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

Performance is asserted as a **work shape**, matching the repository's existing
convention in `micro-timing-performance.test.mjs` — one sweep over the exact
boundary grid, bucketed same-pitch scans, and counters that stay output-sensitive
as the score doubles. No wall-clock budget is turned into a pass/fail rule.

## 13. Explicitly deferred

Later stages own: Final Mobile MML emission and canonicalization, paste-ready
`MML@`, octave/register adaptation, volume and instrument assignment, Tempo Map
emission, in-game collision repair, audio-derived role inference, final six-role
acceptance, the G11-D verification player, G12 mml.mabi.tw interoperability, and
any performer-count allocation policy.

No mml.mabi.tw production code was copied or consulted; that reference remains
`MML_MABI_REFERENCE_NOT_VERIFIED` (see `docs/G11A_SOURCE_REVIEW.md` §1). No
Draft2 history or legacy Skill was used to invent a role rule.
