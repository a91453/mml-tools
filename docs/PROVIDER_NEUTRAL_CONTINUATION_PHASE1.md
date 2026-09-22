# Provider-neutral continuation: phase 1

Status: IMPLEMENTATION NOTES. Not a Canonical rule source or publication.

Conversation-hosted AI -> existing MCP adapter -> existing Studio Application
Service / run and proposal services -> existing Canonical-aware backend.
This change adds navigation over that workflow, not a new orchestrator or a
server-side inference loop. It adds no provider SDK, model credential, inference
request or necessary external-agent dependency. Existing optional driver code
is unchanged; the new read does not invoke it.

## Published rules and source identities

The Published main Manifest was re-read on 2026-09-22. Its existing snapshot and
all six indexed documents were loaded, with their distinct authority roles.

- canonical_version: `2026-09-13-v1`
- manifest_version: `2026-09-13-v1-manifest1`
- rules_snapshot_sha: `0a172900a01fdf39c2e9e84cf176961320b779ea`
- Manifest commit: `5e7666b850a37f1c85ee2dd8cd0f4fac037a9e14`
- branch base / observed main HEAD: `bfbcdf810475a5b28e645332a2a77f5c5e2896f8`

The actual working / PR head is obtained from Git or PR metadata, never from the
rules snapshot. This branch changes none of the Manifest, four rule sources,
PENDING inventory, supporting evidence, executable music rules or Final Gate.
It imports neither superseded #57 nor the unpublished #58 policy candidate.
Machine delivery versus post-delivery human/in-game acceptance remains a
separate, coordinated Canonical/contract/readiness/Final/UI change.

## Read contract

`application.nextRun(owner, projectId, runId, input)` is reached through:

- MCP `studio_run_next`, with required `project_id` and `run_id`;
- HTTP `GET /api/v1/projects/:project_id/runs/:run_id/next`.

`expected_run_revision` is optional on the read. When supplied, an obsolete
revision is refused with `RUN_CONFLICT`. The HTTP query is closed and rejects
duplicate parameters. MCP additionally supports the existing `report_page`.
Unknown verdict, confirmation, acceptance and recovery fields are rejected.
A run ID is mandatory: the operation never chooses a latest run or candidate.

The response schema is `mabinogi-mobile-mml-studio/run-next@1`. It reports the
run revision, baseline/candidate identity, current and run-captured Canonical
provenance, stored progress, halt/pending step, blockers, review requests,
proposal summaries/targets and evidence requirements. Reads are serialized with
existing per-project writes in the same Application Service instance. This is
not cross-process coordination, which remains unsupported.

The projection calls the existing read operations only. It never creates a
baseline/candidate, caches a suggestion, refreshes a review, advances a run,
accepts a proposal, reconciles an interruption, records a confirmation or files
an artifact. Nested return data is detached from stored records.

`next_action` is a navigation hint derived from existing state, not a second
step planner. `allowed_operations` are conditional operation descriptions, not
an authorization grant or complete executable requests. Every write still
passes existing owner, revision, evidence and explicit acceptance checks.
`reviewer_operations` remain reviewer-facing; listing them grants no authority.
`gate_snapshot` is explicitly historical, not recomputed or currently verified.
A cheap empty staleness list is not a new song review or a new PASS.

## Continuing an existing run

Read `studio_run_next` for the explicitly identified run. Use its current
request keys and identities with existing `studio_proposal_submit`, then read
`studio_proposal_status` for the recomputed Agent Review result. Submission
alone changes no candidate or run revision. Only a separate explicit authorized
`studio_proposal_resolve` acceptance reaches the existing `resumeRun` path.

Use the observed revision and a stable idempotency key for each exact resume or
submission payload. Re-read after any conflict. Proposed reviewer identity is
not accepted reviewer identity; the projection supplies neither. Missing
reviewer evidence stays missing. The read never supplies `reconcile=true`,
confirmation defaults, a gate verdict, human listening or in-game acceptance.
Existing direct reviewer entrances and their authority model are unchanged;
this phase does not claim a new authorization system across all write paths.

For interrupted work, inspect the existing pending effect and receipt, then use
the existing explicit resume/reconciliation mechanism. The read itself adopts
or replays nothing. Terminal records are navigated as records, not reopened for
new work. An audit-closed interrupted receipt may still require recovery.

## Server registration is not conversation-client exposure

The branch's `tools/list` exposes 27 Studio tools plus 3 technical tools. This is
a server test result, not proof that a particular conversation can invoke them.

The actual connected conversation surface was inspected on 2026-09-22: it
exposed 17 tools (14 Studio + 3 technical), with none of these nine names:

```
studio_run_plan
studio_run_start
studio_run_status
studio_run_next
studio_run_resume
studio_proposal_targets
studio_proposal_submit
studio_proposal_status
studio_proposal_resolve
```

Its live `studio_capabilities` call succeeded, reported Published v1 and
`external_agent.enabled=false`, and did not advertise `nextRun`. Its deployment
provenance reported `d8c2407226ab5094a3eafb8eb7323afd5fe64e8f`; that is the
observed deployed build identity, not this branch's HEAD or the rules snapshot.
No production or connector update was performed by this implementation.

`server/continuation-surface.mjs` compares server definitions with an explicitly
captured client list. The offline command is:

```
node scripts/check-studio-continuation-surface.mjs observed-client-tools.json
```

Input is a tool array or `{ "tools": [...] }`. Name-only observations can
establish missing tools but cannot establish schema equality. No client capture
means `CLIENT_EXPOSURE_UNVERIFIED`; missing tools, unknown schemas and schema
mismatches are separate results. `DISCOVERY_MATCH` still says
`behavioral_e2e: NOT_RUN`. Exit 2 means discovery remains unresolved, not that a
Canonical gate failed. Exit 1 indicates malformed input/usage.

After an independently authorized merge/deploy, refresh/reconnect the intended
conversation client, capture its actual tools and input schemas, and execute an
authorized synthetic continuation through that client. Neither a local adapter
test nor server `tools/list` substitutes for this acceptance. The generic local
`scripts/studio-agent.mjs` allowlist is unchanged; this new read is exposed via
MCP/HTTP, and the offline discovery checker does not invoke that driver.

## Verification and remaining acceptance

Targeted command:

```
node --test studio/tests/application-run-next.test.mjs studio/tests/provider-neutral-transport.test.mjs tests/mcp-studio.test.mjs tests/api.test.mjs
```

The 55 targeted tests passed locally in an exported test tree overlaid with the
branch files; modified runtime/test blobs were checked against remote hashes.
This is not an authenticated checkout or a substitute for full repository CI.
The two new files contribute 16 tests, covering byte/mtime non-mutation, repeated
reads, owner/run isolation, stale revisions, exact idempotent retries, proposal
and candidate bindings, explicit acceptance, interrupted-effect recovery,
fail-closed Canonical, forged verdict refusal, HTTP/MCP parity, report paging,
and client/schema discovery distinctions.

Full CI results belong to the actual PR head/check runs and must be read there.
Real conversation continuation, the real-song E2E, listening acceptance and
in-game acceptance are NOT claimed. No merge or production deploy is authorized
by this document or by passing tests.
