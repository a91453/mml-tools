# Canonical-aware Technical Timing Repair — implementation notes

Status: IMPLEMENTATION NOTES (not a Canonical rule source)
Implements: Published Canonical `2026-09-13-v1`, rules snapshot
`0a172900a01fdf39c2e9e84cf176961320b779ea`

This document describes an implementer. It defines no rule, publishes no
Canonical snapshot, and closes no `PENDING` item. Where it states a behaviour the
published rule sources do not state, that behaviour is labelled an **implementer
decision** and is chosen to be strictly narrower than the rule, never wider.

## 1. What was missing

G10 closed the *classification* gap: `canonical/micro-timing.mjs` decides what a
sub-1/64 interval is, and `final/micro-gap-enforcement.mjs` decides what Final
must do about each class. It publishes three lists — `preservedIntervalKeys`,
`rejectedIntervalKeys`, `blockedIntervalKeys` — and recorded at the time that
rejecting was "the fail-closed half of the range MASTER_RULES §7 permits".

The Final MML emitter then became G10's second consumer, and refused: a candidate
carrying confirmed technical residue returned `FAIL` with
`MICRO_GAP_TECHNICAL_RESIDUE`. So `rejectedIntervalKeys` was a declared worklist
with no consumer anywhere in the repository — the same shape the G10 finding
itself described about the contract flags before G10 was implemented.

This layer consumes it. Nothing else changes.

## 2. Where it sits

```
 candidate Canonical project
            │
            ▼
 canonical/micro-timing.mjs          what an interval IS        (classification)
            │
            ▼
 final/micro-gap-enforcement.mjs     what Final must DO          (policy)
            │  rejectedIntervalKeys
            ▼
 final/technical-timing-repair.mjs   can it be made to STOP      ◄── this PR
            │                        existing, exactly?
            │  repaired Canonical project
            ▼
 final/mml-emitter.mjs               six role bodies + `MML@…;`
            │
            ▼
 final/round-trip.mjs                exact semantic readback
```

The repair layer sits **beside** the pipeline, not inside the serializer. It
consumes a Canonical project and produces a different Canonical project; it emits
nothing and parses nothing.

## 3. Authority boundary

The repair layer has **no classification authority**. Concretely, it:

- never inspects a duration to decide whether an interval is musical;
- never re-derives, restates or re-tunes the 1/64 grid — it imports the
  analyzer's `SAFE_GRID` and requires `enforceMicroGaps` to report the executable
  contract conformant before it will run at all;
- never reads a source record, a decision's status text, or project metadata as
  evidence;
- never reaches a preserved or blocked interval: its entire worklist is
  `rejectedIntervalKeys`, and every record behind a rejected key must still say
  `TECHNICAL_RESIDUE` / `reject-final-technical-residue` and must re-encode to its
  own key before it is admitted.

A caller may hand in an enforcement report it already computed — the emitter does
— but the report is **compared against a freshly computed one**, structured
interval identity included, and a difference is fatal. The supplied report is
never read for its content. A stale or edited worklist cannot inject anything.

## 4. Which transformation, and why it is not invented here

Canonical *permits* normalizing a meaning-free micro-gap. It does not enumerate
transformations. For a hole between a span ending at `t` and one starting at
`t + d`, two directions exist:

| Direction | What it costs |
| --- | --- |
| absorb the hole leftward into the preceding span | the preceding span's release moves into an interval accepted as meaning-free |
| move the following event's onset earlier | a note-on moves |

Canonical decides between them in four separate places:

- `MOBILE_SYNTAX §8` — "A syntax optimizer MUST preserve note-on identity."
- `MOBILE_SYNTAX §11 step 1` — "preserve source attacks/rests".
- `MASTER_RULES §6` — "Do not delay a new note-on just to hide a collision."
- `ACCEPTANCE_CRITERIA Gate 1` — "exact timing and note-on identity preserved".

Moving the following onset breaks all four. Absorbing leftward breaks none: every
attack keeps its onset, pitch, volume and ordinal position.
`MASTER_RULES §7`'s own contrast — do not fill *true* rests — is the same
direction read from the other side, since the interval in question is by accepted
decision not a true rest.

**Implementer decision.** Leftward absorption is the only direction implemented.
Rightward onset movement is not implemented and is not a configuration option.

## 5. The two operations

| Operation | Applies to | Neutrality |
| --- | --- | --- |
| `close-technical-gap-into-preceding-span` | an `inter-event-gap` technical residue | `silence-preserving` when the preceding span is a rest; `attack-preserving` when it is a note |
| `coalesce-technical-rest-with-preceding-rest` | an `event-duration` technical residue on a rest whose immediate predecessor is also a rest | `silence-preserving` |

The two neutrality classes are deliberately **not** the same claim:

- `silence-preserving` — the role's silence region and its attack set are
  *identical point sets* before and after. Nothing about the candidate's sound
  changes at all. This is provable from the IR, not a judgement.
- `attack-preserving` — every attack keeps onset, pitch, volume and ordinal; one
  preceding note's release extends across an interval accepted as meaning-free.
  This is the normalization `MASTER_RULES §7` permits, and it is recorded as such
  rather than presented as a no-op.

In the coalesce case the **classified** event survives and grows backwards while
its ordinary predecessor is folded into it. That direction is not aesthetic: a
Canonical project rejects a decision referencing a missing event, so removing the
classified event would strand its own accepted classification decision. The
absorbed event's `sourceIds` and `sourceEventIds` travel to the survivor, and an
absorbed event that any decision references is refused outright.

## 6. What is deliberately unsupported

Every one of these is a structured refusal that keeps the result off `PASS`. None
is a silent skip, and an interval carrying one stays on
`unrepairedIntervalKeys`.

| Reason | Why |
| --- | --- |
| `note-duration-residue-has-no-unique-neutral-repair` | eliminating a sub-grid **note** duration means deleting an attack, inventing duration, or moving a neighbour. Nothing in the IR makes one of those the neutral choice. |
| `rest-duration-residue-has-no-preceding-contiguous-rest` | folding a rest event into a note's sustain both removes a source-backed rest and lengthens a note — two different changes, neither forced by the evidence. |
| `interval-boundary-event-is-ambiguous` | more than one span of the role ends at the hole, so there is no single repair target. |
| `interval-is-not-empty-within-its-role` | another span of the role lies inside the interval. |
| `interval-identity-is-not-current-in-the-project` | the interval does not describe the project's own timing. |
| `interval-events-do-not-share-one-assigned-role` | no unambiguous stream to repair in. |
| `absorbed-event-is-referenced-by-a-decision` | a decision is an audit record, not something this layer may rewrite. |
| `repair-interacts-with-another-repair-on-the-same-event` | two plans writing one event would make the outcome order-dependent. Both are refused rather than sequenced. |

## 7. Exact timing

Every comparison, every boundary test and every delta is exact rational
(`F`/`f`, BigInt-backed). There is no epsilon, no float, no rounding, no
snapping, no quantization and no grid search anywhere in the layer. A residue
whose double is bit-identical to the safe grid is still repaired by its exact
value.

That is load-bearing rather than stylistic: a deliberate mutation replacing the
timing comparison with a `1e-9` epsilon initially survived the whole suite, and
`TTR-28` was added to catch it. Two spans ending one part in 10²⁰ apart are the
same double and different exact rationals; only exact comparison resolves a
single unambiguous repair target.

## 8. Result contract

`repairTechnicalTiming(project, { mobileSyntax, enforcement })` returns a frozen
result with `PASS` / `FAIL` / `PENDING`, plus:

| Field | Meaning |
| --- | --- |
| `presentedIntervalKeys` | the technical intervals presented for repair |
| `repairedIntervalKeys` / `unrepairedIntervalKeys` | a partition of the above — no presented interval may vanish |
| `preservedIntervalKeys` / `blockedIntervalKeys` | untouched, reported so they stay visible |
| `repairs[]` | per repair: operation, neutrality, role, target, absorbed event, exact before/after timing, exact delta, the classifying decision id, the published citation under `permittedBecause`, and a `reversal` record |
| `unrepaired[]` | per refusal: interval identity, reason, detail |
| `repairedProject` | the transformed candidate, or `null` |
| `verification` | the full `enforceMicroGaps` report for the repaired candidate |
| `finalEmissionEligible` | `PASS` **and** verification clean **and** nothing preserved remains |
| `canonical`, `notice` | published release identity; an explicit disclaimer |

Two independent guards stand between an unrepaired interval and `PASS`: the
worklist must be empty, **and** re-running `enforceMicroGaps` on the repaired
candidate must agree. Dropping an interval from the worklist cannot buy a pass.

`PASS` is an implementation result. It certifies no Canonical gate, does not make
a song `VALIDATED`, and never implies `IN_GAME_ACCEPTED`.

## 9. Provenance

The input project is never mutated. The repaired candidate is a **different
project**: distinct `id` (`<id>#technical-timing-repair`), a
`metadata.technicalTimingRepair` block naming the project it was derived from,
and a per-event `metadata.technicalTimingRepair` record carrying the exact
before/after timing, the delta, the operation, the classifying decision and the
published citation. `MOBILE_SYNTAX §11 step 8` asks for a reversible mapping; the
`reversal` record is enough to restore the pre-repair candidate exactly.

The `sourceFaithfulBaseline` snapshot is copied through untouched, so the repair
appears in the baseline event diff instead of hiding from it.

Invariants are checked against the **produced project**, not assumed from the
plans that produced it: attack count, pitch, onset, volume, role and provenance
unchanged; no release shortened; no event invented; no rest moved without a plan;
no non-positive duration; Tempo Map, meter map, source set and decision record
byte-identical; and the repaired project distinguishable from the input.

## 10. Emitter integration

`emitFinalMml(project, { technicalTimingRepair: true })` is **opt-in**.

Off — the default — the emitter behaves byte-for-byte as it did before this layer
existed. On, the repair runs between `enforceMicroGaps` and the gates, and the
gates grade the repaired candidate. Opt-in because the repair transforms the
musical candidate, and that must be a caller's explicit decision rather than a
side effect of asking for MML.

Repair never answers a gate. It only changes which candidate the gates are asked
about, and only when the repaired candidate is re-graded `PASS` by the same
enforcement pass that rejected the original. A repair that does not reach `PASS`,
or that leaves the candidate ineligible for Final emission, changes nothing: the
original verdict stands and the refusal is recorded as a notice.

| Situation | Outcome with the opt-in on |
| --- | --- |
| G10 preserves a source-supported sub-grid interval | `FAIL` — never presented to the repair layer at all |
| G10 reports unproven sub-grid material | `PENDING` — never acted on |
| residue the repair layer refuses | `FAIL`, with `TECHNICAL_TIMING_REPAIR_UNAVAILABLE` beside the usual `MICRO_GAP_TECHNICAL_RESIDUE` |
| residue repaired only in part | `FAIL` — a partial repair is not a partial pass, and `applied` stays `false` |
| a supplied readiness report blocks on any gate but `technical` | `PENDING` — the repair succeeded and bought nothing |
| a role exceeds the 2,400-character budget | `FAIL` — the repair runs, the budget still refuses, no note is dropped |
| a repaired sustain crosses a tempo change | the existing serialization splits it into tied segments; one attack, Tempo Map untouched |

The round-trip gate compares against the **repaired** semantics, because that is
what the emitted string claims to mean. The pre-repair timing stays visible in
`result.technicalTimingRepair`, and `result.microGap.gradedProjectId` names which
project the three key lists describe, so the original and the repaired candidate
never become indistinguishable in diagnostics.

The readiness gate is deliberately **not** wired to the repair layer. A gate that
silently repaired what it grades would be grading its own output.

## 11. Regression and mutation coverage

`studio/tests/technical-timing-repair.test.mjs` (30) and
`studio/tests/technical-timing-repair-emitter.test.mjs` (16).

Fourteen deliberate mutations were applied to the production source one at a
time, the targeted suites run, the catching regression recorded, and the mutation
reverted with `git checkout`. All fourteen were caught.

| # | Mutation | Caught by |
| --- | --- | --- |
| 1 | repair a source-supported interval | `TTR-6` |
| 2 | repair an unknown/blocked interval | `TTR-9`, `TTR-25` |
| 3 | treat exactly 1/64 as sub-grid (analyzer boundary) | `TTR-11`, `G10-5`, `C2B-2` |
| 3b | treat exactly 1/64 as sub-grid (repair admission boundary) | `TTR-22a` |
| 4 | ignore the executable contract and repair anyway | `TTR-23` |
| 5 | derive the repair delta with floating point | `TTR-1`, `TTR-5`, `TTR-14`, `TTRE-5` |
| 5b | compare timing with a float epsilon | `TTR-28` |
| 6 | move the following attack instead of extending the preceding span | 19 regressions, incl. `TTR-1`, `TTR-4`, `TTRE-4` |
| 7 | fold a technical rest into the preceding note's sustain | `TTR-16` |
| 8 | merge two same-pitch attacks into one sustain | `TTR-8`, `TTRE-7` |
| 9 | drop unrepaired rejected intervals from the worklist | `TTR-15`…`TTR-19`, `TTR-25`, `TTRE-10`, `TTRE-14` |
| 10 | let the emitter use a repair that did not pass | `TTRE-14` |
| 11 | lose the pre-repair timing from the provenance record | `TTR-5` |
| 12 | accept a stale enforcement report | `TTR-20`, `TTR-21`, `TTR-22` |

Mutation 5b initially **survived**; `TTR-28` was written because of it, and the
re-run caught it. The harness is a scratch script, not a committed artifact, so
this is a *reproducible-by-hand mutation exercise* rather than committed mutation
testing — the same standing `FINAL_MML_EMITTER.md §7` records for the emitter.

## 12. What this does not claim

- It resolves no `PENDING` item. `P1`, `P4`, `P5`, `P13` and `P16` are all still
  open, and this layer is narrower than each of them.
- A repair `PASS` is not a Canonical verdict, not `VALIDATED`, and never
  `IN_GAME_ACCEPTED`.
- It adds no rule. `MASTER_RULES §7` already permitted normalizing a meaning-free
  technical micro-gap; only the implementation was missing.
- It is not a quantizer, an optimizer, or a timing cleanup pass. It cannot reach
  an interval the source-aware analyzer has not already classified as technical
  residue and micro-gap enforcement has not already rejected.

## 13. Open question, recorded rather than decided

Two sub-grid technical shapes have **no unique semantically neutral repair** on
the evidence the Canonical IR carries: a sub-grid *note* duration, and a sub-grid
rest event whose predecessor is a note. Published Canonical permits normalizing
them and does not say which of several musically different transformations to
prefer.

This is recorded as an **unresolved implementation question**, not a Canonical
ambiguity requiring a rule change: failing closed is already a Canonical-valid
answer (`ACCEPTANCE_CRITERIA` "Final state vocabulary" allows `PENDING` /
`UNSUPPORTED`), so no published rule is missing. Supporting either shape would
require an explicit project decision about which transformation is preferred, and
that decision has not been taken here. No Canonical rule source was modified.
