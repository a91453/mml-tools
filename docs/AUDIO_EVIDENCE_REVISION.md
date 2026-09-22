# Audio report revisions (implementation, not Canonical)

Implements the published 2026-09-13-v1 rules without changing any rule, threshold,
review authority, musical event, or gate. This is an evidence persistence repair,
not the policy candidate in #58 and not a claim of real-song alignment success.

## Existing endpoints, explicit input

The existing `studio_audio_alignment` tool / HTTP `POST
/api/v1/projects/:project_id/audio-alignment` still accepts an ordinary Worker
report for the first attachment. A duplicate ordinary report is refused.
For a replacement, use this explicitly versioned value in the existing `report`
parameter (candidate_id remains the outer candidate):

```json
{
  "schema": "mml-studio/audio-report-revision@1",
  "expected_previous_report_sha256": "<current report SHA-256>",
  "reason": "Why a recomputation replaces this particular report",
  "submitted_by": "agent:declared-name",
  "report": { "schema": "mabinogi-mobile-mml-studio/audio-alignment@1" }
}
```

The inner `report` must be the COMPLETE computed Worker report; the abbreviated
object above is not valid evidence. Never fill confidence, coverage or control
points from an expectation. No acceptance/confirmation field is accepted in the
envelope. `submitted_by` is a caller declaration, separate from authenticated
owner. A revised report must match an original_audio asset held by the project,
the candidate's symbolic identity, and the loaded rules snapshot.

Read `studio_candidate_review` without confirmations, preferably with
`report_page.path=["review","audio","history"]`, to export original raw reports,
their stable hashes, actors, original warnings and explicit supersession links.
Use the first page's `report_sha256` as `expected_sha256` on subsequent pages;
concatenate fragments before parsing JSON. Exporting legacy arrays invents no
actor or timestamp. `audio.reports` counts active recordings; history counts all
versions. `audio.evidence[].active` distinguishes selected from historical
summaries. An active report is not a gate PASS.

A report hash is SHA-256 over UTF-8 JSON with recursively sorted object keys and
unchanged array order. JSON indentation/key insertion order does not change it;
report content does. Revisions require the exact current report hash. Concurrent
writes are serialized by the existing Application Service project lock. Old or
ambiguous replacements are refused, never redirected to a newer candidate.

## Deliberately bounded scope

This version supports candidates WITHOUT candidate-bound positive confirmations,
Core3 source-change approvals, Lead evidence records (including lineage), or
project artifacts. Those cases are refused with
`AUDIO_REVISION_REVIEW_DEPENDENCIES`: free-text review dependencies cannot safely
be inferred. This is deliberately conservative, including artifacts elsewhere
in the project. It does NOT implement general approval invalidation, retraction,
or post-Final report replacement. Do not discard those records to bypass it.

The existing review engine is preserved unchanged in review-service-core.mjs;
review-service.mjs is the public application adapter. Both review and Final use
its active-report store view and recompute through the same audio/readiness
engines. The history and active selection commit together in one atomic store
record. Project audio_evidence is a projection, not the gate's source of truth.
An exact active revision retry repairs a failed index projection, but never
appends another report. A completed retry may still create an ordinary job
receipt at the existing Application Service boundary. No background work exists.

Original warnings remain in history; a better report is not fabricated to clear
them. A newly worse report can return audio to PENDING. Other candidate gates,
confirmations, source events and in_game are not changed by this operation.
History is bounded to 128 reports per candidate, subject to the existing store
and request byte limits. Unknown/corrupt history fails closed.

## Verification boundary

`studio/tests/audio-report-history.test.mjs` tests the pure storage contract.
`tests/audio-report-revision.test.mjs` uses synthetic inputs through the real
Application Service, HTTP router and MCP handler. Those are NOT authenticated
ChatGPT conversation E2E and NOT audio computation, listening or song acceptance.
Deployment and a fresh conversation-client read/write check remain separate.
