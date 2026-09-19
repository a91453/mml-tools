# AI One-Click Orchestrator — Phase 1 implementation notes

Status: IMPLEMENTATION NOTES (not a Canonical rule source)
Implements: Published Canonical `2026-09-13-v1`, rules snapshot
`0a172900a01fdf39c2e9e84cf176961320b779ea`

This document describes an **orchestration layer inside the existing Studio
Application Service**. It implements and exposes existing Published
Canonical-aware Studio capabilities. It defines no Canonical rule, moves no
rules snapshot, and adds no musical capability. Where it states a behaviour the
published rule sources do not state, that behaviour is an **implementer
decision** and is chosen to be strictly narrower than the rule, never wider.

## 0. What Phase 1 is

One traceable, explicitly resumable **run**: a workflow instance that calls the
existing operations — source intake, role suggestion, accepted-decision
application (G11-D), the Final Six-Role Reduction (G12), Mobile Adaptation,
candidate review and `finalize` — in a fixed order, and stops at the first point
where a decision, an evidence record or a capability is missing.

Four operations:

| Operation | Writes? | What it does |
| --- | --- | --- |
| `planRun` | **no** | Read-only. Names the steps it would take, the results that already exist, what needs caller input, and what is blocked. It describes the start it names: the same asset selection (an omitted `asset_ids` means every symbolic asset in the project *now*), the same meter binding, and — when its own intake would replace the baseline — the named candidate echoed as `target_candidate_invalidated_by_intake` rather than reported as a satisfied result. |
| `startRun` | yes | Creates the run record and takes the steps the supplied inputs already allow. |
| `getRun` | **no** | Read-only run state, progress, blockers and review requests. Without a run id, the project's run list. |
| `resumeRun` | yes | Re-validates every binding and advances again, after explicit new input, decisions or evidence. |

### What Phase 1 is not

* No provider SDK, no model API, no model credentials, no provider branch.
* No new paid service, database, queue or object storage. The run record lives
  in the existing project record; the run report is an ordinary artifact in the
  existing store.
* No change to the Web/PWA or Permanent Studio publishing topology.
* No Canonical change.
* No claim that audio alone, a song title alone, or an arbitrary source can
  produce a Final without review.
* No new parser, arranger, reducer, adapter, evaluator or emitter. No model call
  fills a PASS.

## 1. Modules

| Path | Role |
| --- | --- |
| `studio/backend/application/run-contracts.mjs` | Run states, steps, halt reasons, review-request codes, the readiness-gate *hint* table, the separation notices. |
| `studio/backend/application/run-service.mjs` | The orchestrator. Step selection, staleness re-validation, step receipts, idempotency, reconciliation, review-request projection. |
| `studio/backend/application/index.mjs` | Wires it in, exposes the four operations, and holds the `internal` façade (§6). |
| `studio/backend/application/capabilities.mjs` | The factual `runs` capability block. |
| `studio/backend/application/final-service.mjs` | `fileArtifact` is now exposed so the run report reuses the one artifact-filing implementation. |
| `server/api.mjs`, `server/mcp-studio.mjs` | Thin adapters. One run service behind both. |

## 2. Three vocabularies, still separate

`contracts.mjs` already keeps operation status and Canonical gates apart. A run
adds a third axis, and it is the most dangerous, because "the run completed"
reads like "the song is done".

```
run state          implementation progress of one workflow instance
operation status   did one call do what it was asked?
readiness gates    final/readiness.mjs — is the song ready?
acceptance axes    the seven public Canonical gate axes
song state         CANDIDATE / VALIDATED / IN_GAME_ACCEPTED
```

Run states: `created`, `running`, `awaiting_review`, `blocked`, `completed`,
`failed`, `interrupted`. These are implementation vocabulary, deliberately not
`PASS` / `FAIL` / `PENDING` / `UNSUPPORTED` / `N/A`.

```
completed run ≠ succeeded operation ≠ succeeded job
              ≠ TECHNICAL_PASS ≠ SOURCE_PASS ≠ PLAYER_READBACK_PASS
              ≠ AUDIO_ALIGNMENT_PASS ≠ MOBILE_ADAPTATION_PASS
              ≠ VALIDATED ≠ IN_GAME_ACCEPTED
```

`in_game` stays `PENDING`. No run, job, emitter, parser, transport or model call
can set it, and a completed run does not change that.

A **blocked finalize is a completed operation with a real answer about the
song**, not a transport failure: the run records it as a step with status
`blocked` and carries the readiness blockers through unchanged. Equally, an HTTP
200 on `startRun` never writes a song PASS.

## 3. Steps

```
intake → suggest → apply_decisions → final_reduction → mobile_adaptation
       → review → finalize → report
```

Each step is one existing operation, and each records a receipt. What a step
does when its input is missing is the interesting part:

| Step | Missing input | What happens |
| --- | --- | --- |
| `intake` | no symbolic asset | halts with `SYMBOLIC_SOURCE_REQUIRED`. Original audio is evidence, not a symbolic source: this build does no audio-to-MIDI, stem separation, vocal isolation or pitch transcription, so a recording alone cannot produce a baseline, and neither can a song title. |
| `suggest` | — | derived only when new decisions are being applied; a run that already has a candidate does not re-derive one. |
| `apply_decisions` | no accepted decisions | halts with `ARRANGEMENT_DECISIONS_REQUIRED`. A suggestion is not an acceptance and a `PENDING` lane is not resolved on a caller's behalf. |
| `final_reduction` | no accepted reduction decisions | derives the **read-only** plan. If the plan's own accounting shows every source event already retained and no blocker, the step is `skipped` — the reduction stage itself refuses that apply as `REDUCTION_NOTHING_TO_APPLY`, so minting a revision would be a no-op revision. Otherwise it halts with `REDUCTION_DECISIONS_REQUIRED`, carrying the plan id, the ledger's non-`KEEP` outcomes and the plan's own warnings. |
| `mobile_adaptation` | no Mobile profile | `skipped`. **This is not a Gate 8 result.** The Gate 8 review stays a separate candidate-bound, evidence-backed statement, and a run that changed nothing still needs it. No instrument range and no volume is invented. |
| `review` | — | always runs on the current candidate, recording only the confirmations a caller stated. |
| `finalize` | — | reached only when the review's own `preGameBlocking`, minus the Final service's own `PRE_EMISSION_EXEMPT_GATES`, is empty. That list is **imported**, not restated, so the run can never become a second exemption policy and cannot extend the exemption. |
| `report` | — | files a `run_report` artifact naming the exact final candidate and the exact Final artifact id. |

`technical_timing_repair` stays `false` by default and is passed through exactly
as a caller supplied it. There is no automatic mode.

## 4. Run record

Stored in the project record under `runs`. A project without the field reads
normally, so the extension is backward compatible. Bounded by construction:
identities, fingerprints, step receipts and bounded review requests — never song
bytes and never a full event list. Long lists stay behind `listBaselineEvents`
and artifact retrieval.

Schema `mabinogi-mobile-mml-studio/application-run@1` holds:

* `run_id` (`run_<32 hex>`, server-generated), `project_id`, `schema`,
  `revision`, `state`, `execution_mode`;
* `requested_by` — the authenticated owner subject — and `declared_reviewers`,
  which is **caller-supplied text recorded for the audit trail**. The record
  says so in its own notice: an `accepted_by` string is not an authenticated
  identity and is never presented as one;
* `inputs.asset_ids` plus `inputs.asset_digests` — the actual stored bytes
  digest and size per selected asset;
* `baseline_id`, `candidate_id`, `candidate_lineage`;
* per-step `input_fingerprint`, `result_reference`, `operation`, `job_id`,
  `blockers`, `detail`, `at`;
* raw upstream `blockers`, `warnings` and `review_requests`;
* `canonical` (Canonical provenance) and `implementation` (code provenance),
  **separately**;
* `revision` for optimistic concurrency, `idempotency` bindings and receipts,
  `pending_step` and `needs_reconciliation`.

Run identity is a workflow instance. It never re-mints a baseline or candidate
identity: those stay the existing content-addressed ids. Source-event accounting
continues to come from the G12 ledger; no second ledger is computed.

### Run report artifact

A separate artifact type (`run_report`, schema
`…/application-run-report@1`). It **names** the Final artifact and never
rewrites its content or identity — `fileArtifact` derives the id from the
SHA-256 of the body, so a `final_mml` artifact is structurally unreachable from
here. The report records `final_candidate_id` and `final_artifact_id` explicitly,
so an earlier candidate's MML can never be presented as this run's output.

## 5. Review requests

A review request is a **projection** of an upstream report. Each one carries:

* the owning module's own blocker/gate codes, unchanged, and
  `report_reference` naming the report they came from;
* the baseline/candidate binding, and the related event ids, roles and sections
  the upstream report supplied (bounded, with the true total);
* existing evidence references and what is missing;
* the existing operations that can answer it;
* `invalidated_by` — which input changes expire the request.

There is **no allow-list gate**. A run proceeds only while
`readiness.preGameBlocking` is empty; a gate this layer has never heard of is
reported with `known: false`, gets no operation hint, and still blocks.
`READINESS_GATE_OPERATIONS` is a hint table and decides nothing.

Phase 2 adds the AI Proposal protocol and an agent review policy. Phase 1
connects no model, and a fixture's human confirmations are not a permission a
model can grant itself.

## 6. Locking: no nested acquisition

`createProjectSerializer()` serializes public mutations per project. A run
reached from a public entry point therefore must not call a public method that
takes the same lock again — one project key acquired twice deadlocks by
construction.

`index.mjs` now holds an `internal` façade: the body of each composed operation,
without the lock and without the provenance envelope. The public method is that
body plus both. The run service calls the body and takes the lock itself, **once
per step**.

This is not a way around a check. Every owner, Canonical, integrity, evidence
and acceptance check lives in the service the body calls, so both callers get
the identical refusal. Per step rather than per advancement so a concurrent
intake, decision or confirmation on the same project is not shut out for the
length of a whole run; the price is that upstream state can move between steps,
which is what §7 exists to catch.

No cross-process or multi-worker guarantee is claimed. `runs` reports
`cross_process_run_coordination: false`.

## 7. Idempotency, staleness, interruption

### Idempotency

Keyed by owner + project + run operation, bound to the normalized request
fingerprint the key was first used with. Enforced in the service, not by an MCP
annotation or an HTTP adapter's claim about itself.

* same key, same payload → the same run is returned; nothing is re-applied, no
  revision is taken, no artifact is produced;
* same key, different payload → `IDEMPOTENCY_CONFLICT`; the original run is
  untouched;
* a different key writing the same project still goes through the existing
  serializer, so nothing is lost.

`resumeRun` additionally accepts `expected_run_revision`; a mismatch is
`RUN_CONFLICT`.

### Staleness

Re-read and re-checked at the top of **every** step, not once per advancement.
When the selected asset set or its bytes, the baseline, the candidate target or
the Canonical rules snapshot has changed, the run halts and says which: an
approval, confirmation, plan or PASS that described the previous material is not
reusable, and the run will not reuse one. Canonical snapshot changes and
implementation code changes are recorded separately; neither silently overwrites
an accepted decision, and repository HEAD is never treated as a Canonical
version.

Normal top-up of evidence is the ordinary path: resume with the new
confirmation, approval or citation and the current candidate is reviewed again
and the run continues.

A candidate produced by an operation outside the run is adopted only when named
(`adopt_candidate_id`) and only after its baseline and lineage are verified —
never by being the newest. Naming one is not a way past the interruption rules
below: a candidate recorded in a pending step's before-set predates that step's
effect, so naming it is refused rather than written down as the effect.

### Interruption

Before each mutating effect the run stores a `pending_step` marker carrying the
effect's expectation, and the expectation carries **what already existed when
the marker was written**. That before-set is the difference between "this record
answers the step's description" and "this record is what the step produced":

| Step | What identifies its effect |
| --- | --- |
| intake | the selected asset ids, the meter map the step was about (an MML source is parsed against it), and the baseline that was already committed — which is by construction not this step's output |
| apply_decisions (G11-D) | the parent and the stage, minus the sibling candidates that already matched. G11-D names no accepted plan, so a candidate applied earlier from the same parent matches the filter exactly |
| final_reduction / mobile_adaptation | the parent, the stage and the accepted plan id the candidate records, plus the same before-set |
| finalize | the type and the candidate, minus the Final artifacts already filed for it — a Final's body names no run |
| report | the run its body names. Exact, so no before-set is needed |

A before-set records four things: the matching ids (bounded by
`LIMITS.maxEffectBeforeSet`), whether that list is complete, and — never
truncated — the **count** and the **digest of the sorted ids**. The count and
the digest are what make this exact at any size:

| What the current set shows | Conclusion |
| --- | --- |
| same digest | `EFFECT_ABSENT` — nothing was added, so the effect never landed |
| one more, and removing exactly one record reproduces the digest | `EFFECT_FOUND` — that record is the effect, whatever the set's size |
| more than one more, with the ids complete | `EFFECT_AMBIGUOUS` — a caller names which one |
| anything else | `EFFECT_IDENTITY_UNPROVABLE` |

`EFFECT_IDENTITY_UNPROVABLE` is **not** `EFFECT_ABSENT`. A step whose effect
can be neither confirmed nor ruled out is reported `interrupted` and is never
replayed: repeating a finalize on a maybe files a second Final for one attempt.
The named remedies are held to the same rule — naming an artifact or a candidate
settles *which* of a step's possible outputs it produced, and never makes a
record the before-set cannot place after the marker into one.

What happens next follows from which of the four answers the record supports —
**a missing or unusable identity is never read as "safe to replay"**:

1. **stopped before the mutation** → `EFFECT_ABSENT`. The record positively
   shows nothing was added, so the step runs again. This is the only answer that
   re-runs a step;
2. **effect persisted, receipt not stored** → `EFFECT_FOUND`. The effect is
   *adopted*, never replayed, so no volume offset stacks and no duplicate Final
   is produced. An adopted effect leaves the run where the same effect with its
   receipt would have: an adopted intake drops the candidate pointer its own
   baseline invalidated, and an adopted Final restores the gates, the emit
   status, the readiness summary and the finalize job **from what the Final
   artifact and the job records already hold** — read back, not re-derived, and
   never by running the emitter again. An artifact whose body cannot be read
   restores nothing, and a Final that no single job claims is given no job id
   rather than the newest one;
3. **several records could be it** → `EFFECT_AMBIGUOUS`. The caller names one
   (`adopt_artifact_id`, `adopt_candidate_id`), held to the same identity the
   automatic path uses, before-set included. Naming settles *which* of a step's
   possible outputs it produced; it never widens what may count as one;
4. **nothing can be established** → `EFFECT_IDENTITY_UNPROVABLE`. The run
   reports `interrupted` with `needs_reconciliation` and names the exact
   unconfirmed step. It **replays nothing**: a marker with no usable expectation
   is this case, not the first one, because repeating a non-idempotent step on a
   maybe produces a second result for one attempt. A step that declared itself
   repeatable, or a caller who has inspected the record and resumes with
   `reconcile: true`, is what establishes absence.

A **receipt stored but the response not delivered** is not an interruption of
this kind at all: the next call sees the step complete, and an idempotency-key
replay returns the same run.

The run report is the one step with an exact identity of its own — its body
names the run that produced it — so a pending report is settled by that identity
even when the marker was restored without an expectation. It is adopted when one
report names this run, reported ambiguous when several do, and left to the
policy above when none does; a missing marker never files a second report for a
run that already has one.

Only the request carries a meter map's text — the run stores its digest — so a
step that would ingest under a meter other than the one the run states does not
run at all. It blocks `RUN_BASELINE_INTAKE_INPUT_UNPROVABLE` and asks for
`meter_text`, rather than ingesting under an empty meter and filing a receipt
fingerprinted with the stated one.

An **adopted** effect is that effect, and leaves the run exactly where the same
effect with its receipt would have. An adopted intake replaced the baseline and
`intake.run` deleted the candidates bound to the old one, so the run drops its
candidate pointer too — otherwise the loss of a receipt would turn a successful
intake into a run permanently blocked on `RUN_CANDIDATE_CHANGED`.

## 7.1 The workflow contract: a run goes forward

Two rules, and together they are why a run's record can never describe two
different results at once.

**Nothing a run holds outlives the identity it names.** When a step produces a
new baseline, a new candidate or a new Final — the report names the candidate
AND the Final — every result this run recorded downstream of it
— the review verdict, the gate and readiness snapshots, the emitted Final, the
run report naming both — was computed against an identity that no longer stands,
so all of it is dropped together and those steps run again. This is applied from
the effect's own result rather than per step, so a step that mints a new
identity cannot forget to declare it. Partial invalidation is the failure it
prevents: a run that kept its report while its candidate moved ended
`completed` with a report naming a different candidate and a different Final
than the run itself.

**An audit-closed run is a record, not a workspace.** A run is audit-closed once
its run report exists — in the run record, OR in the project naming this run,
which is what a crash between the report effect and its receipt leaves behind.
Such a run accepts **no workflow input at all**. The rule is stated as its
exception rather than as a list of material fields, because a list of material
fields is a list that can be missed:

| Field | On an audit-closed run |
| --- | --- |
| `idempotency_key`, `expected_run_revision` | address the request, not the song — accepted |
| the field that settles the step actually pending (`adopt_artifact_id` for a pending artifact, `adopt_candidate_id` for a pending candidate, `reconcile`) | recovery of this run's own identity — accepted |
| everything else, including `finalize` options and adoption with no matching pending step | refused, `RUN_CONFLICT` / `reason: COMPLETED_RUN_IS_AUDIT_CLOSED`, with `refused_fields` naming them |

An idempotency replay is decided **before** this guard, so a genuine retry of
the request that completed the run is unaffected. A resume that asks for nothing
returns the run as it stands: no step runs, no revision is taken, nothing is
re-emitted. The work belongs in a new run, which leaves both records intact and
separately citable.

Inside a live run, forward motion is unrestricted: supplying a decision set,
an accepted reduction or adaptation plan, a confirmation or a different meter map
is how a run advances, and the first rule is what makes that safe.

The selected sources and their bytes are **one** identity: a resume that
restates `asset_ids` rebinds `asset_digests` in the same write. Intake
satisfaction reads the digests, so a run recording new ids against old digests
would leave an added source silently out of the Source-Faithful Baseline.

A temp-then-rename record write is not distributed exactly-once, and nothing here
claims it is. What makes adoption safe is that the effect's identity is derived
from its content. After a process restart, only a configured and actually
retained filesystem store can recover anything; a memory store stays honestly
`ephemeral`, and recovery needs an explicit resume call — there is no automatic
restart.

## 7.2 One input contract per operation

Each run operation has its own closed set of accepted fields —
`PLAN_INPUT_KEYS`, `START_INPUT_KEYS`, `RESUME_INPUT_KEYS`, exported from the
Application Service — rather than one union applied three times. A union lets
one transport admit what another rejects, and lets a caller send a field the
operation does not read: `target_candidate_id` on a resume was accepted and
silently ignored, and `reconcile` was accepted by a read-only plan. Both are
now `INVALID_REQUEST`, naming the accepted fields.

Every bound is one constant in `LIMITS`, referenced by the service and by the
MCP tool schemas: `maxAssetsPerProject`, `maxMeterTextLength`,
`maxDecisionsPerRequest`, `maxIdempotencyKeyLength`, `maxRunRevision`. The
minima MCP declares are minima the service enforces, so an empty `asset_ids`,
an explicitly empty `meter_text` and an empty `decisions` are refused on both
surfaces rather than accepted on one. A transport parity regression asserts the
declared property set equals the operation's key set field for field, and that
each declared bound is the constant — in both directions, so neither surface can
drift silently.

## 8. Transports

HTTP and MCP go through the **same** run service. Neither holds a second
workflow.

| HTTP | MCP |
| --- | --- |
| `POST /api/v1/projects/:id/runs/plan` | `studio_run_plan` |
| `POST /api/v1/projects/:id/runs` | `studio_run_start` |
| `GET /api/v1/projects/:id/runs` · `GET /api/v1/projects/:id/runs/:run_id` | `studio_run_status` |
| `POST /api/v1/projects/:id/runs/:run_id/resume` | `studio_run_resume` |

Both reuse the existing owner/project isolation, the Canonical provenance
envelope, the structured error codes and operation statuses, the request
byte/depth/array bounds and the asset integrity verification. Neither trusts a
client-supplied filesystem path, filename, source digest or self-declared
Canonical binding. MCP carries no bytes. Capability discovery still answers when
Canonical is unavailable, and nothing falls back silently.

Source text, filenames, metadata and evidence notes are **data**. Phase 1 adds
no arbitrary URL fetching and no execution.

Unchanged: the Permanent Studio pinned release, trust bundle and
`/studio-cache`; the Agent `/data` and release-cache boundary; OAuth, external
origins and production cutover; provider-specific workflow (there is none).

## 9. Capabilities stay factual

`background_execution`, `job_cancellation`, `audio_to_midi`,
`source_separation`, `vocal_isolation`,
`exact_pitch_transcription_from_audio` and `in_game_test` remain `false`. Adding
a run did not change any of them. `runs.automatic_continuation` and
`runs.cross_process_run_coordination` are `false` too, and `runs.refuses` lists
what the orchestrator will not do.

## 10. Not covered by Phase 1

* The AI Proposal protocol and any agent review policy (Phase 2).
* Background execution, queues, cancellation and automatic continuation.
* Audio-to-MIDI, stem separation, vocal isolation, pitch transcription.
* In-game acceptance, which only the user or a controlled target-client test
  records.
* Migrating the Permanent Studio Web plane onto this service.
* Named historical song regressions: they are `FIXTURE_PENDING` until a
  reproducible fixture exists and is actually executed. A synthetic fixture
  passing is not this user's song passing, and a parser round-trip passing is
  not in-game acceptance.

## 11. Authority

This document is IMPLEMENTATION NOTES. The Published Canonical Manifest and the
rule sources it indexes are the authority; this layer, its transports and its
tests are implementers and verifiers and cannot define or amend a Canonical rule
in reverse.
