---
canonical_version: 2026-09-22-v2-candidate
canonical_status: CANDIDATE
based_on_rules_snapshot_sha: 0a172900a01fdf39c2e9e84cf176961320b779ea
candidate_snapshot_status: PUBLISHED_AS_2026-09-23-v2
candidate_snapshot_sha: 1c84c95133990e3882a5770077c3d2d39b1a6b04
machine_delivery_schema: mabinogi-mobile-mml-studio/machine-delivery@1
---

# Machine-delivery Canonical candidate

This document is the design and change record for `2026-09-23-v2`. It is not a
rule source and its metadata activates nothing. The release is published only
through `docs/CANONICAL_MANIFEST.md`: its revision that names
`2026-09-23-v2`, rules snapshot `1c84c95133990e3882a5770077c3d2d39b1a6b04` and
the schema above becomes the Published Canonical when it is merged into `main`.
Until then the sole Published Canonical remains `2026-09-13-v1` at
`0a172900a01fdf39c2e9e84cf176961320b779ea`.

The `machine_delivery_schema` value above does **not** activate runtime
authority. Activation requires the loaded Canonical identity itself to be
`PUBLISHED`, to carry a valid immutable `rules_snapshot_sha`, and to declare
this exact schema.

## Delivery model

Studio, not the conversation-hosted AI, computes the delivery projection. The AI
may submit source material, evidence and explicitly authorized decisions through
MCP. It cannot submit or override `AUTOMATED_VALIDATED`, Human reviewed, or
`IN_GAME_ACCEPTED`.

Every non-PASS result is retained in the unresolved evidence ledger and assigned
exactly one phase:

* **BLOCKING** prevents machine delivery. Source traceability and completeness,
  Source-Faithful Baseline integrity, technical legality and character limits,
  Final round-trip, micro-timing, Core3 continuity/completeness, Lead evidence,
  harmony, version drift, unresolved decisions, unknown future gates, and any
  destructive or unsupported edit remain fail-closed.
  (Refined on 2026-09-23 for Core3 completeness residue and version drift; see
  the change record below.)
* **NON_BLOCKING_PENDING** is a candidate-policy classification for evidence that
  may remain unresolved after a technically safe machine artifact exists.
  Original-audio alignment, candidate-specific Mobile review and named
  regression review are proposed for this phase. Missing evidence is never
  rewritten as PASS or N/A.
* **POST_DELIVERY** is evaluated only after an artifact exists. Player/human
  listening and in-game acceptance are separate from machine delivery and may
  never be inferred from emitter success.

The evaluator exposes `projection_ready` for the candidate-policy calculation.
While this candidate is unpublished, `ready` remains false and lifecycle remains
`CANDIDATE` even when `projection_ready=true`. Only after the matching schema
is activated by Published Canonical may a projection with no BLOCKING entries
become authoritative `AUTOMATED_VALIDATED`.

`AUTOMATED_VALIDATED` means only that Studio's deterministic machine-delivery
checks passed under the active Published Canonical. It is not Human reviewed and
not `IN_GAME_ACCEPTED`. With no evidence-backed instrument profile, the
candidate policy proposes generic Mobile delivery under the published
syntax/range/character and round-trip constraints while retaining Mobile review
as unresolved.

## Migration and publication

Existing `2026-09-13-v1` runs and Final artifacts receive a lazy, non-mutating
machine-delivery projection from their stored gate data. Migration preserves the
original statuses and evidence, treats unknown gates as BLOCKING, and creates no
PASS. Missing, empty or partial required gate maps are explicitly marked
`MACHINE_DELIVERY_GATE_MAP_INCOMPLETE` and remain `CANDIDATE`.

Publication is intentionally two-phase:

1. Review this candidate, implementation, migration, and the real-song scenario.
2. Produce and review an immutable candidate rules snapshot. Until such a
   snapshot actually exists in GitHub Published history,
   `candidate_snapshot_status` remains `UNPUBLISHED` and
   `candidate_snapshot_sha` remains null; a Cloud-local or PR merge ref is not
   an immutable published authority.
3. In a later publication commit, update `docs/CANONICAL_MANIFEST.md` to point
   to the reviewed immutable rules snapshot and explicitly declare the matching
   `machine_delivery_schema`. Never point the Manifest at its own mutable HEAD
   and never substitute a PR merge ref.
4. Run the full test suite and manifest verifier against that exact snapshot.
5. Merge/publish only with explicit owner authorization. A PR branch is never
   PUBLISHED.

## Acceptance scenario

`怪獸之歌` project `prj_a808b53c7cafadaf4c6bf5f0fe4c370a` is represented
as a captured acceptance scenario, not as fabricated production evidence.
`source`, `microTiming`, and `leadPromotion` remain BLOCKING.
`core3Completeness` carries reviewer residue only
(`CORE3_COMPLETENESS_UNRESOLVED`), so under the refinement in the change record
it is NON_BLOCKING_PENDING together with `originalAudio`, `mobileAdaptation`,
and `regression`; `playerReadback` remains POST_DELIVERY. The scenario still
blocks. All other
required axes in the fixture are explicit PASS/N/A placeholders for the
scenario only, so migration completeness can be tested without inventing
production evidence. The fixture does not assert Human listening, in-game
evidence, or any new PASS for the real production project.

## Change record for `2026-09-23-v2` (MASTER_RULES §12)

The owner decided on 2026-09-23 to publish this candidate. The prose rule is in
`ACCEPTANCE_CRITERIA.md` ("Machine delivery") and `MASTER_RULES.md` §9 and §11,
and all six indexed documents declare `Version: 2026-09-23-v2`. The rule is
still not published. The loaded release stays `2026-09-13-v1` until the Manifest
points to a snapshot that contains this prose.

1. **Rationale.** The owner's workflow is: AI through MCP, then Studio, then a
   machine-checked MML first. Human listening and in-game reports come after
   and drive further revisions. Under v1, player readback, Mobile review and
   regression review block Final generation, so no MML exists to listen to.
   This change keeps every source, Lead, Core3, harmony, micro-timing and
   technical protection fail-closed. It moves only the evidence that grades a
   delivered artifact after delivery, and it names the resulting state
   separately from `VALIDATED`.
2. **Evidence class.** Project-owner decision (MASTER_RULES §0, item 1). This is
   a delivery policy only. It claims no engine behavior, no musical evidence and
   no in-game result.
3. **Regression impact.**
   - Every existing gate, and every existing meaning of `VALIDATED` and
     `IN_GAME_ACCEPTED`, is unchanged.
   - The change adds one earlier state and changes which unresolved gates block
     a machine delivery.
   - Existing runs and artifacts are migrated lazily and without mutation;
     unknown or missing gates block.
   - Named historical regressions remain `FIXTURE_PENDING`.
   - The local Studio Web keeps its v1 generation gating until it implements
     this rule.
4. **Refinement decided with this change (owner, 2026-09-23).** The dividing
   line is: what a machine can determine blocks; what needs a person's judgment
   is delivered for listening first. This refines the candidate's classification
   in two places. Both stay unresolved until a person decides, and both still
   block `VALIDATED`.
   - **Core3 completeness.** A defect the evaluator determines, such as no
     Lead or a Core3 that depends on Chord3–Chord5, stays `BLOCKING`. So does
     an evaluation that did not run. Residue the evaluator can only hand to a
     reviewer (it cannot tell material the source never carried from material
     cleanup dropped) becomes `NON_BLOCKING_PENDING`.
   - **Version drift.** Its only unresolved state is a review request when
     divergence increased (MASTER_RULES §10 calls it a review trigger, not a
     verdict). It becomes `NON_BLOCKING_PENDING`.

   The implementation step classifies these by the evaluator's own status and
   blocker codes, never by caller input. It updates the machine-delivery tests
   and the captured acceptance scenario to match.
5. **Executable changes, in order, each after the step before it merges.**
   1. This prose. The owner reviews and accepts it.
   2. The implementation.
      - The Manifest loader accepts an optional `machine_delivery_schema` field
        and passes it through the loaded metadata. Today the loader rejects any
        field beyond the four it knows, so publishing without this change would
        stop every loader with `CANONICAL_NOT_LOADED`.
      - Implementations opt into `2026-09-23-v2` explicitly.
      - Tests cover both points.
   3. Publication, with explicit owner authorization.
      - `CANONICAL_MANIFEST.md` points to the merge commit of step 2 as
        `rules_snapshot_sha`. That commit contains this prose and its
        implementation.
      - The Manifest declares `machine_delivery_schema:
        mabinogi-mobile-mml-studio/machine-delivery@1`.
      - The full test suite and the Manifest verifier are run against that
        snapshot.
