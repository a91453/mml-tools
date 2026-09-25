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

## 4. What "may be normalized" settles, and what it does not

`MASTER_RULES §7` permits normalizing a meaning-free technical micro-gap. That is
a **permission, not a transformation**: it establishes that the interval may stop
existing and says nothing about which of several musically different rewrites is
right. Canonical does not enumerate them.

For a hole between a span ending at `t` and one starting at `t + d`, two
directions exist.

**Moving the following onset back to `t` is ruled out.** `MOBILE_SYNTAX §8`
requires a syntax optimizer to preserve note-on identity, `§11 step 1` preserves
source attacks, and `ACCEPTANCE_CRITERIA` Gate 1 requires note-on identity
preserved.

**Extending the preceding span is not thereby licensed.** An earlier revision of
this document and of the code claimed it was, on four supports, and a Canonical
review found none of them carries that weight:

| Claimed support | What the text actually says |
| --- | --- |
| `MASTER_RULES §6` | Sits in *Cross-source arbitration*. It is about repairing a confirmed non-musical **overlap**, and it forbids *delaying* an onset. It mandates no leftward duration extension, and must not be read as one. |
| `MOBILE_SYNTAX §8` | A constraint on what an optimizer must not break, not a licence to change a release. |
| `MOBILE_SYNTAX §4` | "preserves event timing **and** attack identity" — two requirements. A release move fails the first. |
| `ACCEPTANCE_CRITERIA` Gate 1 | "**exact timing** and note-on identity preserved" — two again. This cuts *against* the extension. |

Attack identity surviving is half the test, not the whole of it. A note whose end
moves keeps its onset, pitch, volume and ordinal position while sounding longer
than the candidate said it does, and the role's silence shrinks by exactly that
much.

**So the direction is decided by what the transformation touches**, not by any
Canonical preference for a direction:

| Preceding span | Outcome |
| --- | --- |
| **rest** | the rest's end moves and no note changes. A role's silence is the complement of its note coverage, so silence and attacks are *identical point sets* before and after. Provable from the IR — repaired. |
| **note** | that note sounds longer and the silence shrinks. Nothing in the Canonical IR proves that neutral, so the layer returns `NOTE_RELEASE_NOT_PROVEN_NEUTRAL` and no alternative is guessed in its place. |

**Why no IR evidence can rescue the note case today.** `canonical/timing.mjs`
records timing provenance as explicitly factual — "`origin` is descriptive... It
is not a verdict. Nothing here classifies an interval" — so a `tool-derived`
release is not evidence that moving it is neutral. The C2 artifact attestation
that could carry such a claim is documented as deliberately unavailable
(`micro-timing.mjs`: "Path B... is intentionally unavailable in C2A"). Supporting
the note case therefore needs either that evidence channel or a published
Canonical change — see §13 for why an implementer preference is not a third
option. Neither is invented here.

## 5. The two operations

| Operation | Applies to | Neutrality |
| --- | --- | --- |
| `close-technical-gap-into-preceding-rest` | an `inter-event-gap` technical residue whose preceding span is a **rest** | `silence-preserving` |
| `coalesce-technical-rest-with-preceding-rest` | an `event-duration` technical residue on a rest whose immediate predecessor is also a rest | `silence-preserving` |

There is exactly **one** neutrality class, and deliberately no weaker one:

- `silence-preserving` — the operation touches no note, so the role's note-event
  semantics (onset, pitch, volume, release, ordinal) and its silence coverage are
  *exactly unchanged*; only the representation loses the sub-grid component. This
  is a statement about the Canonical IR and the parsed readback, both compared as
  exact rationals. No claim is made about rendered-audio byte identity, which
  nothing in this repository establishes.

A weaker "the attacks survived, so the change is fine" class is exactly the claim
this layer must not make, so `REPAIR_NEUTRALITY` has no constant for it, and
`verifyRepairInvariants` treats a plan carrying any other class as a violation.

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
| `preceding-note-release-extension-is-not-proven-semantically-neutral` | closing a hole whose preceding span is a **note** would lengthen how long that note sounds. `MASTER_RULES §7` permits normalizing the hole; it does not prove this rewrite neutral, and attack identity surviving does not either (§4 above). |
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
| `repairs[]` | per repair: operation, neutrality, role, target, absorbed event, exact before/after timing, exact `delta` (the distance the repaired boundary moved — for a coalesce that is the absorbed rest's whole length; the sub-grid interval is `identity.length`), the classifying decision id, the published citation under `permittedBecause`, and a `reversal` record |
| `unrepaired[]` | per refusal: interval identity, reason, detail |
| `repairedProject` | the transformed candidate, or `null` |
| `verification` | the full `enforceMicroGaps` report for the repaired candidate |
| `finalEmissionEligible` | `PASS` **and** verification clean **and** nothing preserved remains |
| `canonical`, `notice` | published release identity; an explicit disclaimer |

Two independent guards stand between an unrepaired interval and `PASS`: the
worklist must be empty, **and** re-running `enforceMicroGaps` on the repaired
candidate must agree. Dropping an interval from the worklist cannot buy a pass.

**Verification clean** means the re-grade rejected nothing and is either
`PASS`, or `PENDING` whose only blocker is
`MICRO_TIMING_SOURCE_SUPPORTED_NOT_FINAL_REPRESENTABLE`. G10 raises that code
exactly when a source-supported interval is preserved, and it never makes G10
`FAIL`, so this is true exactly where the re-grade would be `PASS` without it
(the definition before G10 raised it was `status === 'PASS'`). A preserved
interval is this layer's own notice (`PRESERVED_INTERVAL_PRESENT`) and still
keeps `finalEmissionEligible` false; any other `PENDING` — an unproven interval
beside it, for example — is still not clean and gives `VERIFICATION_NOT_CLEAR`.

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
plans that produced it: every note byte-identical *including its end*; no note
ever a repair target; the per-role silence point set unchanged; every plan
carrying the one implemented neutrality class; no event invented; no rest moved
without a plan; no non-positive duration; Tempo Map, meter map, source set and
decision record byte-identical; and the repaired project distinguishable from the
input.

`verifyRepairInvariants` is exported, because the planners already refuse
everything it would catch and a check nothing exercises silently stops being a
check. `TTR-34` drives it with a hand-built project in which a note's release was
extended, and `TTR-35` with a plan claiming a neutrality class this layer does
not implement.

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
| a repaired candidate contains a sustain crossing a tempo change | unchanged: the existing serialization splits that **untouched** sustain into tied segments, which re-read as one attack, and the Tempo Map is not edited. The repair never lengthens a sustain — it touches no note at all (`TTRE-6`). |

The round-trip gate compares against the **repaired** semantics, because that is
what the emitted string claims to mean. The pre-repair timing stays visible in
`result.technicalTimingRepair`, and `result.microGap.gradedProjectId` names which
project the three key lists describe, so the original and the repaired candidate
never become indistinguishable in diagnostics.

The readiness gate is deliberately **not** wired to the repair layer. A gate that
silently repaired what it grades would be grading its own output.

## 11. Regression and mutation coverage

`studio/tests/technical-timing-repair.test.mjs` (37) and
`studio/tests/technical-timing-repair-emitter.test.mjs` (17) — 54 regressions for
this layer, inside a full suite of 1,160.

Seventeen deliberate mutations were applied to the production source one at a
time, the targeted suites run, the catching regression recorded, and the mutation
reverted with `git checkout`. All seventeen were caught.

| # | Mutation | Caught by |
| --- | --- | --- |
| 1 | repair a source-supported interval | `TTR-6` |
| 2 | repair an unknown/blocked interval | `TTR-9`, `TTR-25` |
| 3 | treat exactly 1/64 as sub-grid (analyzer boundary) | `TTR-11`, `G10-5`, `C2B-2` |
| 3b | treat exactly 1/64 as sub-grid (repair admission boundary) | `TTR-22a` |
| 4 | ignore the executable contract and repair anyway | `TTR-23` |
| 5 | derive the repair delta with floating point | `TTR-1`, `TTR-5`, `TTR-14`, `TTR-33`, `TTRE-5` |
| 5b | compare timing with a float epsilon | `TTR-28` |
| 6 | move the following attack instead of extending the preceding rest | 22 regressions, incl. `TTR-1`, `TTR-4`, `TTRE-4` |
| 7 | fold a technical rest into the preceding note's sustain | `TTR-16` |
| 8 | merge two same-pitch attacks into one sustain | 14 regressions, incl. `TTR-8`, `TTRE-7` |
| 9 | drop unrepaired rejected intervals from the worklist | 11 regressions, incl. `TTR-15`…`TTR-19`, `TTRE-10`, `TTRE-14b` |
| 10 | let the emitter use a repair that did not pass | `TTRE-14` |
| 11 | lose the pre-repair timing from the provenance record | `TTR-5` |
| 12 | accept a stale enforcement report | `TTR-20`, `TTR-21`, `TTR-22` |
| 13 | re-admit gap closure when the preceding span is a **note** | `TTR-29`, `TTR-30`, `TTRE-14b` |
| 14 | drop the silence point-set invariant | `TTR-34` |
| 15 | let a note be a repair target | `TTR-34` |

Three mutations survived a first run and produced new regressions rather than a
shrug:

- **5b** (float epsilon in place of exact-rational comparison) → `TTR-28`;
- **14 and 15**, the invariant net added by the note-release correction. Both were
  unreachable in production once mutation 13's guard holds, so `TTR-34` drives
  `verifyRepairInvariants` directly instead.

The harness is a scratch script, not a committed artifact, so this is a
*reproducible-by-hand mutation exercise* rather than committed mutation testing —
the same standing `FINAL_MML_EMITTER.md §7` records for the emitter.

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

## 13. Open questions, recorded rather than decided

Three sub-grid technical shapes have **no proven semantically neutral repair** on
the evidence the Canonical IR carries:

1. an inter-event hole whose preceding span is a **note** — closing it lengthens
   how long that note sounds;
2. a sub-grid **note** duration — eliminating it means deleting an attack,
   inventing duration, or moving a neighbour;
3. a sub-grid **rest** whose predecessor is a note — folding it away both removes
   a source-backed rest and lengthens a note.

Published Canonical permits normalizing all three and does not say which of
several musically different transformations to prefer. All three fail closed.

**Failing closed is the current compliant behaviour**, not a placeholder:
`ACCEPTANCE_CRITERIA` "Final state vocabulary" allows `PENDING` / `UNSUPPORTED`,
so no published rule is missing and nothing here is blocked on a decision in
order to be correct today.

### What would actually be required to support them

There are exactly two routes, and an ordinary implementer preference is **not**
one of them. Published Canonical currently requires a rewrite to preserve *event
timing* (`MOBILE_SYNTAX §4`) and *exact timing* (`ACCEPTANCE_CRITERIA` Gate 1),
and `SOURCE_POLICY §1` class A makes authoritative symbolic sources the primary
authority for **onset and duration**. A changed release contradicts all three, so
no amount of implementer convenience can authorise it.

1. **Evidence.** Support becomes possible if stronger evidence — the C2
   artifact-attestation channel `micro-timing.mjs` documents as deliberately
   unavailable, or equivalent source/in-game evidence admissible under
   `SOURCE_POLICY` — establishes for a *specific* event that the changed release
   is correct under the **existing** Published Canonical. That needs no rule
   change: it supplies the proof the rule already demands.

2. **A published Canonical change.** If the project instead wants to normatively
   permit release extension *without* that evidence, that is a proposed change to
   Canonical policy, not an implementation choice. It goes through the
   change-control route in `MASTER_RULES §12` — explicit rationale, evidence
   class, regression impact, and executable-contract/test changes only *after*
   the prose rule is accepted — with review and publication of a new rules
   release. Implementing it silently, or inferring it from the rule text, is
   exactly what this PR's first revision did wrong.

Neither route has been taken here, and **no Canonical rule source was modified**.

**Open item (2026-09-25), for an owner decision.** Closing a technical hole
into the preceding rest can lengthen an explicit rest that is itself preserved
source-supported material. Reproduced: `a[0,1)`, a rest `r[1,509/480)` kept as
notated with admissible evidence, and a technical hole to `b[17/16,2)`. The
repair extends `r` to `17/16`, exactly 1/64 of a whole note, so the repaired
candidate holds no preserved interval, and the `technicalTimingRepair` path
emits `MML@t120o4cr64c8.&c32.,,,,,;` (`r64`). The preserved rest was never
presented for repair; the hole after it was. G10 is `FAIL` on the original
(technical residue beside the preserved rest), so readiness and machine delivery
block it and Finalize, which refuses a blocked micro-timing gate before the
emitter runs, never reaches this path. It is left unchanged: refusing it would
stop the emitter writing a candidate it writes today. A regression pins the
current behaviour (`technical-timing-repair-emitter.test.mjs`, "a kept sub-grid
rest before a technical hole").

Case 1 is the narrowest and most likely to matter in practice: it is the shape a
MIDI ingest produces when a note-off lands a few ticks before the next note-on.
That makes it worth raising with the project — as a question about which of the
two routes above applies, never as a one-line implementer fix.

**Update (2026-09-22).** Route 1 now exists, outside this layer: an evidence-gated
release representation in Mobile Adaptation v1 (`canonical/release-timing.mjs`,
`adaptation/index.mjs`). It moves a release that
no admitted Final token can express to an adjacent 1/64 grid point only under a
decision whose evidence cites an independent primary source by a direct review
of it (who submitted the decision is provenance, not authority; corrected
2026-09-23 from a first version that required a human submitter), records the
Source-Faithful release on the event, and produces a new
candidate that the micro-timing gate re-verifies. This layer is unchanged: it
still refuses the note-preceded case, because it holds no such evidence.

**Update (2026-09-23, `2026-09-23-v3` prose, not yet published).** Route 2 has
been taken for delivery only. `ACCEPTANCE_CRITERIA` "Delivered first, flagged
for listening" lets a Final delivered under machine-delivery schema `@2` hold a
note's release to the following attack or next grid point, where the release
follows its source's systematic export offset (one sub-1/64 offset for at least
95% of that source's non-representable releases) and every open micro-timing
item is such a release. It is implemented beside this layer, not in it:
`renderProvisionalReleases` in `final/technical-timing-repair.mjs` reuses the
worklist discipline (only the releases a fresh enforcement report lists, each
re-checked against the project) and has its own invariant check. It produces a
rendering for serialization only. The stored candidate keeps the source
release, the intervals stay `UNKNOWN`, and the Final lists every held release.
`repairTechnicalTiming` is unchanged and still refuses the note-preceded case
(`NOTE_RELEASE_NOT_PROVEN_NEUTRAL`).
