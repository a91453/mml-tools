---
canonical_version: 2026-09-22-v2-candidate
canonical_status: CANDIDATE
based_on_rules_snapshot_sha: 0a172900a01fdf39c2e9e84cf176961320b779ea
candidate_snapshot_sha: cdc596b5e56bfc972f66315f45e1b3efde16b59c
---

# Machine-delivery Canonical candidate

This document is an unpublished candidate. Until its reviewed snapshot is
merged and `CANONICAL_MANIFEST.md` is deliberately updated, the Published
Canonical remains `2026-09-13-v1` at the SHA above.

## Delivery model

Studio, not the conversation-hosted AI, computes the delivery verdict. The AI
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
* **NON_BLOCKING_PENDING** does not prevent a technically safe machine artifact,
  but remains visibly unresolved. Original-audio alignment, candidate-specific
  Mobile review and named regression review are in this phase. Missing evidence
  is never rewritten as PASS or N/A.
* **POST_DELIVERY** is evaluated only after an artifact exists. Player/human
  listening and in-game acceptance are separate from machine delivery and may
  never be inferred from emitter success.

When all BLOCKING gates pass, the lifecycle is `AUTOMATED_VALIDATED`. This means
only that Studio's deterministic delivery checks passed. It is not Human
reviewed and not `IN_GAME_ACCEPTED`. With no evidence-backed instrument profile,
Studio delivers generic Mobile MML under the published syntax/range/character
and round-trip constraints and records Mobile adaptation review as unresolved.

## Migration and publication

Existing `2026-09-13-v1` runs and Final artifacts are migrated lazily from their
stored gate map. The migration is pure and idempotent: it adds a machine-delivery
projection, preserves the original statuses, treats unknown gates as BLOCKING,
and creates no evidence or PASS. A legacy record without enough gate data stays
`CANDIDATE` until normal review/finalization recomputes it.

Publication is intentionally two-phase:

1. Review this candidate, implementation, migration, and the real-song scenario.
2. Commit the accepted rule documents. Set `candidate_snapshot_sha` above to
   that immutable full commit and verify it contains every candidate authority.
3. In a later publication commit, update `docs/CANONICAL_MANIFEST.md` metadata
   and authority links to the reviewed snapshot; never point the Manifest at
   its own mutable HEAD and never substitute a PR merge ref.
4. Run the full test suite and manifest verifier against the exact snapshot.
5. Merge only with explicit owner authorization. A PR branch is never PUBLISHED.

## Acceptance scenario

`怪獸之歌` project `prj_a808b53c7cafadaf4c6bf5f0fe4c370a` is represented
as a captured acceptance scenario, not as fabricated production evidence.
`source`, `microTiming`, `core3Completeness`, and `leadPromotion` remain
BLOCKING; `originalAudio`, `mobileAdaptation`, and `regression` remain
NON_BLOCKING_PENDING; `playerReadback` remains POST_DELIVERY. The fixture does
not assert Human listening, in-game evidence, or any PASS.
