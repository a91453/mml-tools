---
canonical_version: 2026-09-22-v2-candidate
canonical_status: CANDIDATE
based_on_rules_snapshot_sha: 0a172900a01fdf39c2e9e84cf176961320b779ea
candidate_snapshot_status: UNPUBLISHED
candidate_snapshot_sha: null
machine_delivery_schema: mabinogi-mobile-mml-studio/machine-delivery@1
---

# Machine-delivery Canonical candidate

This document is an unpublished candidate. Its metadata is descriptive proposal
data, not Canonical activation. Until a later reviewed rules snapshot is
published through `docs/CANONICAL_MANIFEST.md`, the sole Published Canonical
remains `2026-09-13-v1` at
`0a172900a01fdf39c2e9e84cf176961320b779ea`.

In particular, the `machine_delivery_schema` value above does **not** activate
runtime authority. Activation requires the loaded Canonical identity itself to
be `PUBLISHED`, to carry a valid immutable `rules_snapshot_sha`, and to
declare this exact schema.

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
`source`, `microTiming`, `core3Completeness`, and `leadPromotion` remain
BLOCKING; `originalAudio`, `mobileAdaptation`, and `regression` remain
NON_BLOCKING_PENDING; `playerReadback` remains POST_DELIVERY. All other
required axes in the fixture are explicit PASS/N/A placeholders for the
scenario only, so migration completeness can be tested without inventing
production evidence. The fixture does not assert Human listening, in-game
evidence, or any new PASS for the real production project.
