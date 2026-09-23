---
canonical_version: 2026-09-22-v2-candidate
canonical_status: CANDIDATE
based_on_rules_snapshot_sha: 0a172900a01fdf39c2e9e84cf176961320b779ea
candidate_snapshot_status: PUBLISHED_AS_2026-09-23-v2
candidate_snapshot_sha: 1c84c95133990e3882a5770077c3d2d39b1a6b04
machine_delivery_schema: mabinogi-mobile-mml-studio/machine-delivery@1
---

# Machine-delivery Canonical candidate

This document is the design and change record for `2026-09-23-v2`, and the
change record for its refinement `2026-09-23-v3` (last section). It is not a
rule source and its metadata activates nothing. The metadata above describes
the `2026-09-23-v2` candidate only. The release is published only
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
  (Refined on 2026-09-23 for Core3 completeness residue and version drift, and
  by `2026-09-23-v3` for sub-grid releases and Lead promotion without primary
  evidence; see the change records below.)
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

A real-song project, `prj_a808b53c7cafadaf4c6bf5f0fe4c370a`, is represented
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

## Change record for `2026-09-23-v3` (MASTER_RULES §12)

The owner decided on 2026-09-23 to deliver two more kinds of unresolved result
first and flag them for listening. The owner chose this option in the session
and accepted the rule text before any implementation (MASTER_RULES §12, item 4).

The prose rule is in `ACCEPTANCE_CRITERIA.md` ("Machine delivery", "Delivered
first, flagged for listening"), `MASTER_RULES.md` §4, §7 and §11, and
`MOBILE_SYNTAX.md` §4, §7 and §11. All six indexed documents declare
`Version: 2026-09-23-v3`. The rule is not published by this change.
Publication happens in a later Manifest commit. Until then the Published
Canonical stays `2026-09-23-v2` at rules snapshot
`1c84c95133990e3882a5770077c3d2d39b1a6b04`, with
`machine_delivery_schema: mabinogi-mobile-mml-studio/machine-delivery@1`.

1. **Rationale.** A real-song project now blocks only on source-aware
   micro-timing and Lead promotion.
   - Its micro-timing residue is 1,282 `UNKNOWN` gaps of one MIDI tick (1/480
     beat) between a note's release and the next attack in the same role, plus
     releases one tick short of a Final grid point. This is an export encoding
     pattern. Final cannot write a sub-1/64 gap. SOURCE_POLICY §6 and §1C forbid
     treating the pattern, or the third-party MIDI it comes from, as evidence.
     Without a direct review of the original recording the intervals stay
     `UNKNOWN` and block.
   - Its Melody was promoted or assigned without primary evidence. Third-party
     MIDI is supporting only (SOURCE_POLICY §1C).
   - No machine can decide either question. Both need a person's judgment, and
     the owner does not want to review the original recording before hearing a
     delivery. By the dividing line v2 set (what a machine can determine blocks;
     what needs a person's judgment is delivered for listening first), both
     move to `NON_BLOCKING_PENDING`. Every machine-determined neighbour of
     either case still blocks.
   - **Refinement (owner, 2026-09-23, same session).** The provisional release
     default applies only where a source shows a systematic export offset,
     checked first and per source. A source qualifies when one sub-1/64 offset
     before the next grid point accounts for at least 95% of its releases that
     fall short of a grid point. Only its releases at exactly that offset are
     held. The observed data behind the number: one piano MIDI had 1,544 of
     1,545 such releases exactly one tick early, and two notation-software
     MIDI exports had 98.3% and 96.4% at their dominant offset. A release at
     any other offset, and every such release of a source that does not
     qualify, keeps the ordinary handling and blocks. The pattern is used only
     as the precondition for the default. It is still never evidence of
     musical meaning (SOURCE_POLICY §6).
   - **Addition (owner, 2026-09-23, same session): same-value Tempo
     restatements** (MOBILE_SYNTAX §7). The same project's source restates the
     Tempo already in effect at five positions one tick before a grid point.
     The synchronization-safe policy copies the Tempo Map onto every role, so
     each restatement splits notes at a position no Final length can reach,
     and emission fails there even with every release held. A restatement
     changes no timing. It is not part of the Tempo Map, and a Final delivered
     under machine delivery collapses it and records each one. A Tempo change
     keeps its current handling wherever it falls. The published v2 text does
     not say whether a restatement belongs to the Tempo Map, so the collapse
     applies only under this release's schema and never under v2.
2. **Evidence class.** Project-owner decision (MASTER_RULES §0, item 1). This is
   a delivery policy only.
   - It claims no musical meaning for any release, no Lead identity, no engine
     behaviour and no in-game result.
   - It changes no classification: the intervals stay `UNKNOWN` and the
     promotion stays unproven.
   - It does not publish or activate the unpublished release-regrid candidate
     (`docs/canonical-candidates/SUBGRID_RELEASE_OFFSET.md`). That candidate
     would classify such gaps from their encoding pattern. This release
     classifies nothing. It reads the pattern only to decide where the
     delivery default applies, and still admits no pattern as evidence.
3. **Regression impact.**
   - Every gate reports what it reported before. The micro-timing gate still
     lists every `UNKNOWN` interval, and the Lead promotion gate is still
     `PENDING`. Each adds one code that says the whole of its open question is
     the release-side case, or missing primary evidence. The
     machine-delivery classification is made on those codes, and only the two
     shapes named in the prose move. A mixed result blocks as it did under v2,
     and so does a single release outside its source's dominant offset.
   - The stored candidate, the Source-Faithful Baseline and the baseline diff
     never change. The delivered MML differs from the candidate only in the
     listed releases. Each of them moves later by less than 1/64 and never
     across an attack. The existing evidence paths (release representation,
     Lead evidence review) still resolve both questions and replace the
     provisional rendering or the flag.
   - The meanings of `PASS`, `VALIDATED` and `IN_GAME_ACCEPTED` are unchanged.
     A delivery with either result unresolved is `AUTOMATED_VALIDATED` only.
   - The new classification is the machine-delivery schema
     `mabinogi-mobile-mml-studio/machine-delivery@2`. Runs and artifacts
     recorded under `@1` keep their `@1` projection: the lazy, non-mutating
     projection v2 introduced for v1 records.
   - The captured acceptance scenario above was recorded before these codes
     existed, so it still blocks on source, micro-timing and Lead promotion
     under either schema.
   - Named historical regressions remain `FIXTURE_PENDING`.
   - The local Studio Web keeps its v1 generation gating, as it did for v2.
4. **Executable changes, in order.**
   1. This prose. The owner accepted it before implementation.
   2. The implementation, in the same change set as this prose and still
      unpublished.
      - Implementations opt into `2026-09-23-v3` explicitly.
      - The evaluator classifies by the schema of the Canonical identity it is
        evaluated under: `@1` as in v2, `@2` with the two rules above. It
        splits strictly on the gates' own statuses and codes, never on caller
        input, and unknown gates still fail closed.
      - The micro-timing gate checks the dominant-offset precondition per
        source (threshold 95/100) and lists the releases it covers. Under `@2`
        the Final emitter renders exactly those releases for delivery, without
        modifying the stored candidate. It re-grades the rendered MML by
        round-trip and records every rendering and the per-source figures in
        the Final and in the machine-delivery ledger. Under `@2` it also
        collapses same-value Tempo restatements and records them. Under `@1`
        nothing changes.
   3. Publication, in a later Manifest commit and with explicit owner
      authorization.
      - `CANONICAL_MANIFEST.md` points `rules_snapshot_sha` to the merge commit
        that carries this prose and its implementation.
      - The Manifest declares `canonical_version: 2026-09-23-v3` and
        `machine_delivery_schema: mabinogi-mobile-mml-studio/machine-delivery@2`.
      - The full test suite and the Manifest verifier are run against that
        snapshot.
