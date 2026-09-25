# AI One-Click Orchestrator — Phase 2 implementation notes

Status: IMPLEMENTATION NOTES (not a Canonical rule source)
Implements: Published Canonical `2026-09-13-v1`, rules snapshot
`0a172900a01fdf39c2e9e84cf176961320b779ea`

This document describes the **AI Proposal Protocol** and the **Agent Review
Policy** added inside the existing Studio Application Service. It implements and
exposes existing Published Canonical-aware Studio capabilities. It defines no
Canonical rule, moves no rules snapshot, and adds no musical capability. Where
it states a behaviour the published rule sources do not state, that behaviour is
an **implementer decision** and is chosen to be strictly narrower than the rule,
never wider.

Phase 1 is [AI One-Click Orchestrator — Phase 1](AI_ONE_CLICK_ORCHESTRATOR_PHASE1.md)
and everything it says still holds. Phase 2 changes none of it.

## 0. What Phase 2 is

Phase 1 built a run that stops at the first point where a decision, an evidence
record or a capability is missing, and reports a **review request** saying
exactly what it is waiting for. It deliberately left those requests for a human
to answer. Phase 2 is the formal way an external agent may answer one.

```
run review_request
  → inspect the exact evidence                       (existing read operations)
  → submit a structured proposal                     proposeDecision
  → the policy validates it against current identity getProposal / listProposals
  → an explicit acceptance by a named reviewer       resolveProposal
  → the EXISTING Application Service operation runs  resumeRun → applyDecisions …
  → the run resumes under its ordinary semantics
```

Five operations over one new first-class durable record:

| Operation | Writes? | What it does |
| --- | --- | --- |
| `proposalTargets` | **no** | Read-only. Which of a run's open review requests an agent may answer, with which proposal classes, what each class would reach, what evidence the upstream module says is missing, and which proposals already exist for that request. |
| `proposeDecision` | yes, one record | Stores one agent's statement. Mints no candidate, takes no revision, records no confirmation, moves no gate, and does not advance the run — not even its revision. |
| `getProposal` | **no** | Read-only. The stored statement, plus the Agent Review verdict **recomputed against what is stored now**. |
| `listProposals` | **no** | Read-only. This project's proposals, optionally narrowed by run, request, state or class. |
| `resolveProposal` | yes | Records an explicit acceptance, rejection or withdrawal. An acceptance — and only an acceptance — routes the prepared input into the existing run resume path. It takes no `idempotency_key`: the acceptance mints its own deterministic one, so a caller's would bind nothing, and a stated field that binds nothing is the defect this protocol refuses elsewhere in as many words. |

### What Phase 2 is not

* No provider SDK, no model API, no model credentials, no provider branch, no
  model identifier field. The service calls no model. An agent is an external
  MCP/HTTP client, exactly as in Phase 1.
* No background worker, queue, automatic continuation or automatic acceptance.
* No second musical mutation engine. Nothing here parses, arranges, reduces,
  adapts, evaluates or emits.
* No Canonical change, no new gate, no new confirmation, no new evidence class.
* No audio-to-MIDI, stem separation, vocal isolation, pitch transcription or
  in-game test. Every one of those is still `false`.

## 1. The five separations, said once

A proposal is the single most dangerous object this system has held, because it
is written in the language of a decision by a party with every incentive to be
convincing and no way to be held to account. So:

```
proposal ≠ accepted decision   an acceptance names a reviewer and is a separate
                               explicit act. Submitting performs none.
proposal ≠ gate PASS           no verdict here moves a Canonical acceptance gate
                               or a readiness gate. The protocol produces no gate
                               confirmation of any kind.
proposal ≠ evidence            a citation is a pointer at evidence this service
                               can resolve. A proposal that cites nothing has
                               cited nothing; it does not become evidence by
                               being detailed.
proposal ≠ IN_GAME_ACCEPTED    only the user or a controlled target-client test
                               records that, and this build records none.
proposal ≠ mutation            acceptance routes back into the existing
                               operation, which performs every check it performs
                               for any other caller.
```

And the fourth vocabulary axis, beside the three Phase 1 already keeps apart:

```
proposal state     what happened to one agent's statement
run state          how far one workflow instance got
operation status   did one call do what it was asked?
readiness gates    final/readiness.mjs — is the song ready?
acceptance gates   the seven public Canonical axes
song state         CANDIDATE / VALIDATED / IN_GAME_ACCEPTED
```

An `applied` proposal means an explicit acceptance was recorded and the existing
operation was **called** with the input the proposal prepared. It does not mean
the operation succeeded, that a candidate was minted, that a gate moved, or that
anything about the song is now true. The operation's own result says those
things, in its own words, exactly as it does for a caller who never used a
proposal at all.

In the Canonical authority order (`MASTER_RULES.md` §0) a proposal sits *below*
conversation context: it is not a user decision, not a Canonical document, not
confirmed in-game evidence, not official evidence, not an accepted project
regression and not a community example. It is a reviewed caller's suggestion
that happens to have been written by a machine.

## 2. Modules

| Path | Role |
| --- | --- |
| `studio/backend/application/proposal-contracts.mjs` | Proposal classes, states, agent-review verdicts, refusal causes, the closed target table, the evidence vocabulary, the request-key derivation, the separation notices. |
| `studio/backend/application/proposal-service.mjs` | Submission, the Agent Review Policy, acceptance, and the translation into an existing operation's input. |
| `studio/backend/application/plan-derivation-memo.mjs` | The policy's plan derivation, held in memory on every input it reads, so a polled read does not re-run an engine (§6). Grades nothing. |
| `studio/backend/application/contracts.mjs` | `pro_` identity, three error codes, five bounds. |
| `studio/backend/application/run-service.mjs` | Every review request now carries the `request_key` an agent addresses it by. Every revision the run takes records the request whose write produced it, and which revision that write produced (`revision_written_by`); every write also keeps the latest revision it has found written with no recorded writer (`latest_unattributed_revision`, never lowered); and `resume` takes two in-process options no transport reaches, `admit` and `wrote`, so an acceptance knows truthfully what its own request did to the run (§7). |
| `studio/backend/application/index.mjs` | Wires it in, exposes the five operations, and adds two read-only baseline projections to the internal façade. |
| `studio/backend/application/capabilities.mjs` | The factual `proposals` capability block. |
| `server/api.mjs`, `server/mcp-studio.mjs` | Thin adapters. One protocol behind both. |

## 3. How an agent addresses a request

A Phase 1 review request carries **no id**. It is a projection, rebuilt on every
advancement from the upstream report that produced it. An agent still has to be
able to say *which* request it is answering, and the three ways that would
otherwise be reached for are exactly the three this codebase refuses everywhere
else — the newest one, the first matching one, the one at a remembered index.

So a request is addressed by a key **derived from what makes it that request**:

```
request_key = req:<sha256 of code, step, gate, report_reference,
                   baseline_id, candidate_id>
```

Two consequences, both wanted:

* the key is **stable** while the request is the same request, so an agent can
  read a run, think, and come back;
* the key **changes** when the candidate or the baseline moves, so a proposal
  written against the old material cannot address the new request at all.
  Staleness is structural here rather than a check somebody has to remember.

Not a content digest of the whole request: `blockers`, `missing`, `detail` and
the bounded event ids are the request's *contents*, and they legitimately change
as an upstream report is re-derived over the same candidate. Keying on them
would expire an open request for no reason.

A key identifies a request **within one run** and is deliberately not globally
unique: two runs over the same baseline, waiting on the same thing, legitimately
carry the same key. Every proposal therefore names its `run_id`, and a key is
only ever resolved against the requests of *that* run — so a key read from one
run can never address another run's request, whether or not the two collide. A
key no open request carries addresses nothing and is refused outright; a key
more than one carries is `REQUEST_AMBIGUOUS` rather than resolved by position.

## 4. Proposal classes, and what each one may be about

| Class | Reaches | Admissible against |
| --- | --- | --- |
| `arrangement_decision` | `resumeRun.decisions` → `applyDecisions` | `ARRANGEMENT_DECISIONS_REQUIRED`, `ARRANGEMENT_DECISIONS_REFUSED` |
| `final_reduction` | `resumeRun.final_reduction` → `planFinalReduction` / `applyFinalReduction` | `REDUCTION_DECISIONS_REQUIRED`, `REDUCTION_APPLY_BLOCKED` |
| `mobile_adaptation` | `resumeRun.mobile_adaptation` → `planMobileAdaptation` / `applyMobileAdaptation` | `MOBILE_ADAPTATION_BLOCKED` |
| `source_selection` | `resumeRun.asset_ids` / `meter_text` → `analyzeSources` | `SOURCE_SELECTION_REQUIRED`, `SYMBOLIC_SOURCE_REQUIRED`, `SOURCE_METER_BINDING_REQUIRED` |
| `candidate_selection` | `resumeRun.adopt_candidate_id` | `CANDIDATE_SELECTION_REQUIRED`, `ARRANGEMENT_DECISIONS_REQUIRED` |
| `evidence_needed` | **nothing** | every request, always |

`PROPOSAL_TARGETS` is a **closed** table and the closure is the safety property.
A request code it has never heard of admits `evidence_needed` and nothing else,
and is reported with `known: false` — the same discipline
`READINESS_GATE_OPERATIONS` uses for an unrecognised readiness gate. A new
upstream request code therefore cannot become agent-settlable by being absent
from a list.

Note what `READINESS_GATE_BLOCKED` admits: `evidence_needed`, alone. Every
readiness gate — source completeness, Core3 completeness, the Lead axes, player
readback, Gate 8, Gate 9 — is answered by a confirmation, an approval or an
evidence record that a **reviewer** states. A proposal is not one of those and
cannot be turned into one, however detailed it is. `FINALIZE_BLOCKED`,
`RUN_INPUT_CHANGED` and `RECONCILIATION_REQUIRED` are the same: the first is a
fact about the song, the second needs new material, and the third rests on a
caller having *actually inspected* a stored record — an agent asserting that it
has is precisely the forge Phase 1's reconciliation exists to refuse.

### `evidence_needed` is a result, not a failure

"I cannot decide this, and here is exactly what would let someone" is a complete
answer. It escapes the evidence rung of the policy ladder deliberately, and it
is the only class admissible against the four request kinds above. `PENDING`
being a legitimate and important outcome is a Canonical rule
(`MASTER_RULES.md` §0 and §4, `SOURCE_POLICY.md` §4); this is where that is true
in code rather than in prose.

## 5. What a proposal carries

```
run_id                  which run, always named
expected_run_revision   optional; the revision the agent read. A mismatch is
                        RUN_CONFLICT at submission
request_key             which request, derived (§3)
kind                    which class
proposed_by             caller-supplied text for the audit trail. NOT an
                        authenticated identity, and never presented as one
rationale               prose for a human reviewer, ≤ 2048 characters
action                  the class's own closed field set
cites                   event_ids, source_ids, evidence_refs
unresolved_conflicts    summary, event_ids, source_ids, truth_classes
missing_evidence        what would let someone decide
canonical_warnings      what the agent thinks a reviewer should notice
expected_operation      what the agent believes this reaches — checked against
                        the table, refused on mismatch
```

`expected_operation` is stated by the agent and **checked**, rather than read
from the table. An agent that believes it is proposing one thing while the
service would apply another is refused instead of surprised.

### Citations resolve, or they are fabrications

Every citation is resolved inside the proposal's own project's record, which is
what makes "fabricated reference" a checkable claim rather than a wish — and
what makes a cross-project or cross-owner citation *impossible* rather than
merely refused: the record is loaded for this owner and this project, and an
identity that is not in it is simply not found.

* `event_ids` resolve through the same read-only `listBaselineEvents`
  projection an agent uses;
* `source_ids` resolve against the Source-Faithful Baseline's own inventory;
* `evidence_refs` are `{ kind, id, truth_class, note? }` where `kind` is one of
  `source`, `asset`, `artifact`, `job`, `candidate`, `baseline`, `run`,
  `report_reference` — and `report_reference` must be one this run itself
  handed the agent.

A URL, a filename, a conversation excerpt and a model's recollection are none of
these and are refused. Prose belongs in `rationale`, where nobody can mistake it
for a pointer.

### Symbolic truth and audio truth stay apart

`SOURCE_POLICY.md` §2 keeps them in separate evidence fields precisely so one
number cannot hide their disagreement. So:

* every evidence reference states its own `truth_class` — `symbolic`, `audio`,
  `in_game`, `community`, `project_history`;
* a field named `confidence`, `score`, `certainty`, `probability`,
  `likelihood` or `confidence_score` is **refused** at every nesting level,
  not dropped. A field silently ignored reads, to the agent that sent it and to
  a reviewer skimming the record, as a field this service accepted;
* a `source` reference whose declared class contradicts the Canonical authority
  the intake adapters recorded is refused. The check is mechanical and
  arbitrates nothing about what either class may *prove*; it only refuses to let
  the two be swapped.

## 6. The Agent Review Policy

The policy does **not** judge musical truth. It never decides whether a Lead
belongs in Melody, whether an omission is safe, or whether a register shift
preserves a role: every one of those is arbitrated by the existing engines,
under the Published Canonical rules, when the operation runs, for this caller
exactly as for any other. It answers one narrower question:

> does this proposal carry enough binding, evidence and authority to be handed
> to the existing operation it names?

One verdict, from a fixed ladder evaluated in order. The first rule that matches
is the answer, so "which problem does this have" has one answer rather than a
set a caller has to rank.

| Verdict | Meaning |
| --- | --- |
| `INVALID` | The protocol itself: a forged identity, an unknown field, a field only the server may compute, a collapsed score — or an action the acceptance could never translate into the run's input (`REDUCTION_PLAN_REFUSED`, `REDUCTION_PLAN_ID_MISMATCH`, `ADAPTATION_PLAN_REFUSED`, `ADAPTATION_PLAN_ID_MISMATCH`; see §7). |
| `STALE` | Well-formed, but a binding it names no longer matches what is stored now. |
| `NOT_AGENT_SETTLABLE` | Correctly bound, but this class may not settle this target at **any** evidence level. |
| `REQUIRES_MORE_EVIDENCE` | In scope and bound, but what the downstream operation needs is absent — including when the proposal says so itself. |
| `PROPOSABLE` | In scope, bound and complete, but this class reaches no operation: it records a position for a reviewer. |
| `REQUIRES_EXPLICIT_ACCEPTANCE` | In scope, bound, complete, naming an existing operation. **The only verdict an acceptance may act on.** |

The ladder is evaluated in that order and `STALE` is deliberately **above**
`INVALID`. Every `INVALID` check is evaluated *against* the bindings — a cited
event id against the baseline the proposal names, a cited report reference
against the requests the run is currently making — so when those bindings have
moved, a forgery verdict is not merely redundant but actively misleading: an
agent whose baseline was re-ingested underneath it would be told its citations
were fabricated, which is a different accusation with a different remedy.
`AGENT_REVIEW_ORDER` states this order, and a regression asserts the constant
matches what the policy walks.

`ACCEPTABLE_AGENT_REVIEW` is a **single value**, not a list. A list is something
a later change appends to without noticing what it has widened; a single value
has to be deliberately replaced, and a regression asserts it is still one value.
The strongest verdict the policy produces is named after what is still missing.

Two rungs are worth stating explicitly:

* **the agent's own statement about itself is taken at face value.** A proposal
  declaring `missing_evidence` is `REQUIRES_MORE_EVIDENCE`; it is never
  overruled into having enough. A proposal declaring an unresolved conflict is
  the same — `MASTER_RULES.md` §0: when two authorities disagree, do not guess;
* **scope is checked before evidence.** No amount of evidence makes a gate
  confirmation into something an agent states, so `NOT_AGENT_SETTLABLE` is
  decided above the evidence rung rather than beside it.

The verdict is **recomputed on every read** and again under the project lock
immediately before an acceptance, never served from what was stored. There is no
sweeper that expires proposals when material changes, and there deliberately is
not one: a cached safety check is a safety check that can be wrong. The verdict
the proposal was written under is kept beside the live one as
`agent_review_at_submission`, so a reviewer can see that the two differ and why.

One rung runs an engine: the plan check (§7), which derives the plan an
acceptance would derive. The engine is synchronous, and on a song-length project
one reduction plan holds the event loop for seconds, so deriving it afresh on
every read of a proposal a client polls stalled every other request the process
serves. The derivation's **outcome** — the plan id, or the plan operation's
refusal — is therefore held in memory (`plan-derivation-memo.mjs`), keyed on
every input the derivation reads: the operation and its exact input (the bound
candidate, the action, the reviewer), the loaded engines by identity and the
rules snapshot they were loaded as, and a digest of the stored **bytes** the
operation reads — bytes rather than ids, because a blob can change under the id
that names it. That is not a cached verdict. The verdict is still graded on
every read, from that outcome, against the proposal as it stands, and every
other rung is re-read as before. Nothing is held when the material could not be
read, nor when a change the memo can detect may have landed while the
derivation ran: any write of this process (the store counts every write it is
asked to make, and a regression pins each write method), or a rules snapshot,
engine or stored-bytes digest that reads differently after the derivation than
when the key was taken. What neither check can see is a change made by another
process **and undone** while one derivation ran; the service runs one process
and says so (`cross_process_run_coordination: false`), and the module's "What
is never held" section states the limit. Nothing is persisted; the memo is
bounded. A regression moves each input on its own and requires a fresh
derivation.

One acceptance does not re-run the policy, and the exception is named here
rather than only where it is implemented: a **retry** of an acceptance that was
already recorded, and whose application may already have reached the run, skips
the policy gate, because that acceptance's own application moves the run and
would then read as stale to a policy looking at revisions. What stands in its
place is the run's, not this layer's — the same idempotency key, the same
request, and a revision precondition that moves only to a revision the run's
own record says this application's request wrote, so a retry can only finish
the application it is a retry of. A retry of an acceptance none of whose
attempts the run ever admitted through this build (`run_resume_called: false`)
is **not** excepted: the policy grades it again, exactly as it graded the
first acceptance, so one whose run or material has moved since is refused. It
can still be withdrawn, unless the run has taken a write since the acceptance
that does not record which request made it, which is what the release a
rollback returns to leaves when it applies the acceptance itself (§7). That
includes an acceptance whose attempts reached `runs.resume` and were refused
there, before the run wrote anything — at its revision precondition, say,
because another application moved the run first. §7 is the whole argument.

## 7. Acceptance, and why there is only one mutation path

An acceptance translates the proposal into the ordinary input of the ordinary
operation and calls `runs.resume` through its **public** entry point. The run
therefore takes its own per-project lock, applies its own idempotency, its own
optimistic concurrency, its own per-step staleness re-validation and its own
interruption rules. Nothing here uses the run-internal façade, and nothing here
supplies an internal provenance key: a proposal is external input, and it goes
through the external door.

That is why the manual path and the accepted-proposal path produce the **same
content-addressed candidate id** for the same decisions. There is only one path;
the proposal layer is a way of filling in its arguments. A regression asserts it
directly, and it is the assertion the whole design rests on: if those ids ever
differ, this layer has grown a second mutation engine.

### A machine may not author the evidence for its own proposal

`leadEvidence` is a candidate-bound **reviewer** record, and the one field on a
decision a proposal may not carry.

The shared Lead grader checks that a citation *binds*: that its `sourceIdentity`
names a real Source-Faithful Baseline source event, that continuity holds, that
Core3 survives. It cannot check that anyone actually read the score, because
nothing can. An independent adversarial review of this code as first written
exploited exactly that: a well-formed record whose score citation read *"I, the
model, recall the score shows an inner voice here"* passed the grader through an
accepted proposal and moved **both** Gate 3 axes to `PASS`, with every other
guard in this protocol working as designed.

So a proposed decision carrying `leadEvidence` is refused
(`REVIEWER_EVIDENCE_RECORD_SUPPLIED`). The role decision itself stays
proposable, but the application distinguishes two cases. An existing-role
`MOVE_ROLE -> Melody` (and Lead demotion/duplication into Melody) still stops at
the existing Lead interlock when reviewer evidence is missing. An initial
role-less `ASSIGN_ROLE -> Melody` may instead materialize a reversible
review-pending candidate with
`ROLELESS_LEAD_ASSIGNMENT_REVIEW_PENDING`. That is deliberately **not** a
Gate 3 PASS: the candidate's Lead-promotion readiness remains `PENDING` until a
reviewer supplies the citation through `applyDecisions` or
`reviewLeadEvidence`.

### The reviewer is supplied by the acceptance, and only by the acceptance

`applyDecisions` reads a decision's **own** `acceptedBy` in preference to the
call's. So a proposed decision may carry neither `acceptedBy` nor `note`: an
agent that could set the first would name the accepting reviewer itself, and the
reviewer who actually accepted would never reach the acceptance binding; `note`
is written *inside* the acceptance, where it reads as the accepting reviewer's
words. Both are refused with `ACCEPTANCE_IDENTITY_SUPPLIED`. `acceptance` itself
is refused too — this service computes it from the baseline, the suggestion and
the Canonical snapshot loaded at apply time, and a caller who could supply one
could make a decision claim to have been accepted against material it never saw.

### The two plan ids are derived, never taken

A **reduction** plan id is bound to its decision set *and* its reviewer, so it
cannot be known before an acceptance names one. The service derives it at
acceptance through the existing **read-only** `planFinalReduction`, using the
accepted decisions and the accepting reviewer — the same thing a manual caller
does before applying. A proposal may still state `expected_plan_id`, and then it
must also state the `plan_accepted_by` it derived that id under: the pair is
checked against a plan derived under *that* reviewer, and a mismatch is refused.
An un-checkable stated field is worse than no field, because the agent reads it
back and believes it was honoured.

**The check is the policy's, not only the acceptance's.** The derivation is a
pure function of what the proposal is bound to and of the proposal itself, so
the Agent Review Policy runs it too (on the same code path as the acceptance)
and grades a failure `INVALID`: `*_PLAN_ID_MISMATCH` for a stated id the action
does not produce, `*_PLAN_REFUSED` for an action the plan operation refuses
outright. It used to be found only at acceptance, *after* the acceptance was
recorded, in the translation before `runs.resume` — and every retry recomputed
the same failure, so the proposal stayed `accepted` for good, could not be
withdrawn, and held an open-proposal slot; enough of them locked the project
out. The one input the policy cannot know, the accepting reviewer, changes a
reduction plan's id but not whether it can be derived. What the operation
*reports* about an action it accepts — blockers, a Lead interlock, a `PENDING`
event — is still not graded: that is its musical answer, reached at the run.
Nor is a refusal that names the stored material rather than the action an
accusation about the proposal: when the plan operation refuses because the
bound candidate no longer matches the current baseline
(`reason: CANDIDATE_NO_LONGER_MATCHES_BASELINE`) or was derived under another
Canonical snapshot (`CANDIDATE_RULES_SNAPSHOT_DIFFERS`), the verdict is `STALE`
(`CANDIDATE_CHANGED` / `CANONICAL_SNAPSHOT_CHANGED`), as it is when that
material cannot be read at all.

An **adaptation** plan id is bound to the candidate and the profile, both of
which the proposal carries, so an agent *can* state it in advance. It is still
derived rather than taken, and a stated id the inputs no longer produce is
refused rather than overridden. It carries **no** `plan_accepted_by`, and the
absence is the point: the pair exists on the reduction action because the id is
not checkable without the reviewer, and here it is. The adaptation action
accepted the field anyway — validated, stored, echoed back, never read — which
is the same un-checkable stated field this protocol removed from `resolve`, one
class further in, and a reviewer's name written by the machine onto a record a
human reads as an acceptance.

### Crossing the lock

`runs.resume` takes the per-project serializer itself, so the acceptance cannot
hold it: one project key acquired twice deadlocks by construction. The sequence
is therefore

```
1. under the lock   validate, re-run the policy (unless this is a retry whose
                    application may have reached the run), mark accepted,
                    record an application marker: a deterministic idempotency
                    key `proposal:<proposal_id>:<revision>` and the run
                    revision observed now; for a retry of an application the
                    run admitted, read whether the run's latest write was that
                    application's own (the run's `revision_written_by`, trusted
                    only when it names the run's current revision)
2. no lock          translate
   no lock          call runs.resume with that key and, as
                    expected_run_revision, the run's current revision when its
                    latest write was this application's, else the revision the
                    acceptance observed
2b. inside the run's own first lock hold, after every refusal of the run's own
                    and before its first write (resume's `admit` option):
                    re-read the proposal; if it was rejected or withdrawn
                    meanwhile, refuse, and the run writes nothing; if an
                    earlier admission recorded a different request under this
                    key, refuse; otherwise record run_resume_called: true
                    (never cleared) and, the first time, which request the run
                    let in (admitted_request_fingerprint)
2c. inside the run  every write of that request records it as the writer of
                    the revision it produces, naming that revision, in the same
                    save, and reports the revision back under the lock
                    (resume's `wrote`)
3. under the lock   record the outcome; for a failure, where this attempt's own
                    request left the run, if it wrote anything
```

**An acceptance that never reached the run can still be taken back.**
`run_resume_called` is written when the run **admits** an attempt — inside the
run's own first lock hold, after the run has made every refusal of its own (the
idempotency fingerprint, the revision precondition, the audit-closed guard, the
adoption checks) and before it writes anything. So `false` means the run never
let an attempt made through this build in. The release a rollback returns to
does not record the admission at all, so the run is read as well, and an
accepted proposal may be rejected or withdrawn only while both hold (the
acceptance then stays on the record as `resolution.superseded_acceptance`):

1. `run_resume_called` is `false`; and
2. no revision the run has taken since the acceptance observed it — that is,
   after `application.expected_run_revision` — was produced by a write that does
   not record which request made it. The latest such revision is the larger of
   the run's `latest_unattributed_revision` and, when `revision_written_by` does
   not name the run's current revision, that revision (below: *nor can a build
   that does not record the admission open a withdrawal*).

Otherwise the refusal stands and says which case it is: the marker is `true`;
the marker is absent, on a record accepted before the field existed, where
nothing can establish that no attempt reached the run; or the run has taken
such a write since the acceptance, with the revision it names. A run the
proposal names that is not on the record is refused as `RUN_NOT_FOUND`. The
open-proposal cap counts a proposal as one that can be withdrawn by the same
two conditions.
This is race-free without refusing while an attempt is in flight: the
withdrawal and the admission take the same lock, so either the withdrawal lands
first and the run refuses the attempt with nothing written, or the marker lands
first and the withdrawal is refused. A retry of an acceptance whose marker is
still `false` goes through the policy again, since no attempt of it made
through this build has moved the run: if a reviewer advanced the run meanwhile,
or the material moved, the retry is refused as `STALE` before it reaches the
run, and the proposal can still be withdrawn unless condition 2 fails. A
regression moves the run between a failed attempt and its retry
and requires exactly that. Carried past the policy instead, the retry would
still not get in: it carries the revision the acceptance observed, and the run
refuses it at its own precondition, before admitting it, so the marker stays
`false` and the proposal stays withdrawable. The policy there is defence in
depth that names the reason (`STALE`) rather than a bare `RUN_CONFLICT`.
(While the marker was still written in a hold before the call, the same
skipped retry set it on its way in and left the proposal accepted and not
withdrawable again; the regression was written against that.)

**Why the admission, and not a hold of this layer's own before the call.** The
marker used to be written in a short hold of the proposal layer's own just
before `runs.resume`. That counted an attempt the run then *refused* as one that
had reached it, although a refusal at the run's precondition happens under the
run's lock before anything is written. An independent review drove two
different acceptances of one request at once: the second reached `runs.resume`
after the first had moved the run, was refused at its precondition, and —
counted as having reached the run — pinned the revision the *first* application
had left the run at. Its retry skipped the policy on the marker's word, passed its precondition
against that borrowed revision and moved the run: recorded `applied`, naming an
advancement it had not caused, while the policy graded it `STALE` at the same
moment — the standing permission below, back through a refusal. (Before the hold
existed the same path pinned a revision taken mid-way through the other
application and stuck on `RUN_CONFLICT`: true, but not withdrawable.) Two ways
to tell the cases apart were available. A flag on the run's refusals would have
to be attached to every refusal the run makes before its first write, and one
added later without it would read as "may have written" and reopen the hole for
that refusal; and the marker would still be written before the call, so taking
it back after a refusal would need per-attempt bookkeeping to stay correct while
another attempt of the same acceptance is admitted and in flight. The admission
has neither problem: it is the one point where the run passes from refusing to
writing, the marker is written there under the same lock as the run's first
write, and nothing classifies the run's errors. `admit` is not a resume input —
the public `resumeRun` passes none, so no transport reaches it — and it can only
refuse, never widen what the run accepts. Two regressions drive the refusal: the
review's two concurrent acceptances, and a human reviewer's manual resume landing
while an acceptance is being translated. Each requires the refused attempt to
pin nothing and leave the marker `false`, its retry to be refused as `STALE` with
the run untouched, and the proposal to stay withdrawable.

The window in the middle is closed with what Phase 1 already built rather than a
second mechanism:

* a crash between 1 and 2, or anywhere inside 2, leaves the proposal `accepted`,
  and retrying re-issues the **same** key — so a run that already applied it
  replays its own receipt instead of applying anything twice;
* a concurrent writer that advanced the run in the window fails the revision
  precondition, so the acceptance is not applied to material it never saw.

**The revision precondition moves on a retry; it is not dropped.** `resume`
bumps the run's revision in its own first lock hold, before any step runs, and
writes the idempotency receipt in a last hold after every step has finished. So
for the whole duration of an advancement the run has moved and the key is
unbound — and a retry carrying the pre-bump revision as a precondition could
never match. The acceptance was recorded, the work may well have landed, and the
one mechanism built to finish it was the one thing that could not: the proposal
stuck `accepted` for good. An adversarial pass found that.

Sending no precondition at all fixed it and opened a worse hole, which a later
pass found in turn. A retry of an application that may have reached the run
also skips the policy gate, so an acceptance whose application had been
interrupted became a *standing permission*: whatever the run had since become —
another reviewer's decision set, another candidate, a request that was no
longer open — the retry reached `runs.resume` anyway, and the proposal was
recorded `applied` naming an advancement it had not caused, with the policy's
own read of it saying `STALE` at the same moment.

So the precondition is **carried forward** rather than dropped — to the run's
latest write, and only when the run's own record says that write was this
application's. The run records, with every revision it takes and in the same
save, which request's write produced it (`revision_written_by`: the idempotency
key, the request fingerprint, and the revision that write produced), and the
admission records which request it let in for this acceptance
(`admitted_request_fingerprint`). A retry of an application the run admitted
reads, under the lock, whether the record is the one written for the revision
the run is at now and names that key and that request. If it is, the retry
carries the run's current revision, which the run re-checks under its own lock,
and the run's own reconciliation settles whatever step the interrupted attempt
left pending — adopting an effect that landed, re-running one that did not. If
it is not, the retry carries the revision the acceptance observed, which a run
anyone else has moved refuses. A retry then finishes exactly the application it
is a retry of, and a run that moved for any other reason fails the precondition
and is refused.
The receipt is still checked *first*, so a run that did apply this replays it
either way. The record is the run's, written by `bumpRun` for the request whose
lock hold is writing: a caller is only ever recorded as the request it actually
sent, and since the key is the caller's to choose, the request fingerprint is
compared as well. `resume`'s `wrote`, like `admit`, is an in-process option no
transport reaches, and it only reports. Regressions drive all three
interruption classes, a process that dies inside the run at each of them, a
second interruption, an interruption by a fault followed by a retry whose
process dies inside the run (the stored revision is then behind the run's, and
the retry continues from the run's own record, not from it), and an attempt
whose only write is the run's first hold, before any step (recorded and
reported as that request's write like every other), and require the retry to
complete with exactly one candidate for one acceptance; others drive a human
reviewer's resume into the same window, before and after a process death, and
require the retry to be refused.

**The precondition used to be a revision somebody observed, and that was the
defect twice over.** Phase 3 of the interrupted attempt pinned it from the run
as that hold read it, written once. That was wherever the run was when phase 3
ran, not where the attempt's application stopped: an independent review queued a
reviewer's manual resume behind the interrupted hold, its first hold — a bump
folding in the reviewer's own reduction — landed before phase 3, phase 3 pinned
the reviewer's revision, and the retry passed its precondition against it and was
recorded `applied` after another actor had moved the run. And a process that
died inside the run's advance never ran phase 3 at all: every retry carried the
pre-bump revision, the run refused it at its precondition before admitting it, a
refused attempt pins nothing, and the proposal stayed accepted, not withdrawable
and unfinishable although nothing else had touched the run. Being written once,
the pin also made a second interruption terminal. The run's record of who wrote
each revision answers all three: it is written with the write itself, so it
survives the process; it names the revision it was written for and is trusted
only while that is the run's revision, so it cannot name another writer's
revision as this application's; and every write this application makes writes
it afresh.

**A build that does not know the record cannot lend it.** Rolling the service
back to the release before the run kept writer records, and forward again, is a
documented procedure (`ops/permanent/RELEASE_2026-09-24-v4.md`, Rollback). That
release's `bumpRun` writes the run by spreading the record it read and bumping
the revision, so every write it makes carries the writer record of the revision
before it onto its own. A record of only the key and the request then read a
reviewer's resume through that build as this application's latest write: the
retry skipped the policy, passed its precondition and was recorded `applied`
onto the reviewer's run while the policy graded it `STALE`, which an
independent review reproduced with the released build itself. The record names
the revision its write produced, and a reader trusts it only when that is the
run's revision, so any write by a build that does not know the field leaves a
record that names nobody, and the retry is refused as `RUN_CONFLICT`. That is
the refusing direction for this application's own writes through such a build
too: they cannot be told from anyone else's. A regression rewrites the stored
run as that build leaves it — after a reviewer's resume, and after a bare
write in that build's shape — and requires the retry to be refused with the run
untouched and the proposal not withdrawable.

**Nor can a build that does not record the admission open a withdrawal.** The
same release knows nothing of `run_resume_called` either. Its retry of an
accepted proposal skips the policy, as it does for every accepted proposal, is
let into the run and writes to it, and records no admission. So after an
acceptance whose first attempt stopped before the run (the marker `false`), a
rollback, that build's retry reaching the run and being interrupted — by a
thrown fault, or by its process dying — and a roll forward, the marker still
said `false` with the acceptance's reduction input on the run and its step
pending. The proposal could be withdrawn with the notice that nothing of it had
reached the run, and in the process-death case the owner's next plain resume
adopted the candidate that application had minted. An independent review
reproduced both with the released build itself.

Nothing either build writes names this acceptance on every write that build
makes. The acceptance's key reaches the run only in the idempotency receipt,
which the run writes in a last hold once every step has finished, so none of an
interrupted application's writes carries it, and which is kept among the run's
latest `maxIdempotencyReceiptsPerRun` receipts, so a later one can evict it. The
input the run folds in is content, which a reviewer's own request can repeat and
a later resume replaces. The effect attempt ids are random. That build's own
last phase records a conflict and a revision on the proposal after a thrown
failure, nothing after a process death, and never an admission. What the run
does record is whether each revision's writer is known: every write that build
makes records none, because it carries the record of an earlier revision.
Only the latest revision can be read that way, since the next write that
records its writer replaces the record, so `bumpRun` also keeps
`latest_unattributed_revision`: before each write it folds in the run's current
revision when that revision's writer is not recorded, and it never lowers the
value. That build spreads the run it read, so it carries the field forward as
well. Together they say whether any write since a given revision recorded no
writer, however many writes that do record one came after it.

So the rule is the conservative one: after a write the run cannot attribute
has landed since the acceptance, the acceptance is not taken back, whatever
that write was (condition 2 above). A write the acceptance observed was made
before it and is no part of its application, so it does not count: a run that
build wrote before the acceptance, or one kept before the run recorded writers
at all, leaves an acceptance that never reached the run withdrawable. The cost,
in the refusing direction: a reviewer's resume through that build after the
acceptance cannot be told from that build's retry of it, so it blocks the
withdrawal too. Such a proposal's retry is graded by the policy again, since the
marker is `false`, and refused as `STALE`, because the run has moved since the
acceptance; it stays accepted and open, the refusal names the unattributed
revision, and the remedy is a fresh proposal against the request as it stands.
The same holds when this application's own retry through that build is the
write: it cannot be finished or taken back.

Regressions in `proposal-untranslatable.test.mjs` write the stored run as that
build leaves it — its retry's request sent through the run's public entry point
exactly as its proposal layer sends it, with the writer fields its `bumpRun`
carries in place of the ones this build writes, and its last phase's record of a
thrown failure — and require the rejection and the withdrawal to be refused, the
retry refused as `STALE`, and nothing written: on a run this build started,
after a fault and after a process death, each alone and followed by a reviewer's
resume through this build. Others put a bare write in that build's shape after
the acceptance on a run this build started, alone, followed by one and by two
resumes through this build, and between two of them, and require the withdrawal
to be refused for the same reason. Two more start from runs those do not: one
with no writer record at all, and one whose record of unattributed writes is
already set when the acceptance observes it. On a run record kept before the run
recorded writers — every run on the record when this build is first deployed —
the acceptance is followed by a bare write in that build's shape, by its retry
stopped by a fault, by its retry stopped by a process death, and by that last
followed by a reviewer's resume through this build, which adopts the candidate
the application minted. And on a run that already holds a
`latest_unattributed_revision` from before the acceptance — that build's write,
or a run record kept before the field, followed by a resume through this build —
the acceptance is followed by a bare write in that build's shape and by its
retry stopped by a fault or by a process death, each alone, and the bare write
and the process death each followed by a resume through this build. In each case
of both, the rejection and the withdrawal are refused, and the refusal names
that build's latest write as the unattributed revision and the revision the
acceptance observed; nothing is written; the retry is refused as `STALE` with
the run untouched; and the withdrawal is still refused after it. A write made
outside any request's hold records `revision_written_by: null`, which names no
request either. One more regression puts such a write after the acceptance —
the run as the step-budget hold would leave it if written that way — alone and
followed by a resume through this build, and requires the same. Others require
an acceptance that never reached the run to stay withdrawable when that build's
write, or a run record kept before the field, is one the acceptance observed,
including when a reviewer's resume through this build follows the acceptance;
and require the open-proposal cap to stop counting such an acceptance as one
that can be withdrawn.

Nor does it hand the standing permission back one round later. A retry the run
refuses writes nothing, so the run's latest writer stays whoever moved it, and
the next retry reads the same record and is refused the same way. One regression
drives four retries after a reviewer's resume for that reason; another puts
three kinds of other writer after a process death — a reviewer, this proposal's
own payload sent by hand without its key, and this proposal's key reused with
another payload and interrupted before the key is bound — and none of them is
this application's writer. A run record written before the run kept this has no
writer on it, a write made outside a request's hold records null, and a writer
record that names a revision other than the run's names nobody. Each reads as
not this application's, so such a retry is refused unless the run is still where
the acceptance observed it; a regression puts a null record on the run after a
process death and requires the retry refused and the run untouched. What an earlier
version recorded on the proposal is not trusted past what it proves either: the
revision it pinned in phase 3 may be another writer's and is never carried, and
a marker it set without the request is completed by the next admission, so a
later interruption can still be recognised. Regressions write both records
directly and require exactly that.

**A retry is the same request.** The admission records the request fingerprint
the run computed when it first let this acceptance in, and refuses — with
`IDEMPOTENCY_CONFLICT`, before the run writes anything — an attempt that would
hand it a different request under the same key: the plan the acceptance derives
moved in between, say. Continuing a run whose latest write was the first request
with a second one is not a retry of that application. A regression moves the
derived plan between an interrupted attempt and its retry, requires the refusal
with the run untouched, and requires the retry to finish once the plan is back.

`run_revision_at_attempt` is a record of the attempt, not a precondition: the
last revision the attempt's **own** request wrote, as the run reported it under
its lock after each of that request's writes (`resume`'s `wrote`), recorded by
phase 3 when the attempt did not finish. It is never the revision the run is at
when phase 3 reads it, and it is never written by an attempt that wrote nothing —
one that failed before `runs.resume`, in the translation, say; one the run
refused before admitting it, including a refused twin of an attempt of the same
acceptance the run admitted first; one admitted and stopped before its first
write. Such an attempt left the run nowhere, so the revision the run happens to
be at is no fact about it. Written by a pre-run failure, the old pin could not
then move to where a later attempt that did get in was interrupted, and the retry
after that failed its precondition for good; written by a refused attempt, it was
the revision *another* application had left the run at (above). Regressions
drive a pre-run failure then an attempt interrupted inside the run (the record is
where that attempt stopped, and the retry finishes); the review's reviewer queued
behind an interrupted hold (the record is the attempt's own revision, not the
reviewer's, and the retry is refused); and one proposal accepted twice at once,
whose refused twin records its refusal while the admitted attempt is still in
flight and must record no revision.

**A retry does not re-litigate the acceptance.** An acceptance is a recorded past
act; a crash between it and its application advances the run, which makes the
proposal stale, and re-running the policy there would refuse the very retry the
marker exists for. So the policy gate is skipped for a proposal that is already
`accepted`, carries a marker, and whose marker does not say the run admitted
none of its attempts (`run_resume_called` is `true`, or absent on a record
accepted before the field existed) — and nothing is taken on trust, because
safety there is the run's: the same key, the same request, and a revision
precondition that moves only to a revision the run records as this
application's own. This mirrors Phase 1's own ordering, where an idempotency
replay is decided *before* the audit-closed guard. A proposal whose marker says
the run admitted no attempt through this build has nothing of this build's to
finish, and is graded again (above) — including when the release a rollback
returns to has written to the run since the acceptance, where the policy then
refuses it because the run has moved.

The state that used to be the ambiguous one — the run advanced but its receipt
was not written, which is an application interrupted inside `advance`, a process
that died there included — is not guessed about, and it is no longer terminal
when nothing else has touched the run: the run's own record says whether its
latest write was this application's, the retry continues from there, and the
run's own reconciliation settles the pending step. When another writer has moved
the run since, the retry is refused, the conflict is recorded on the proposal
rather than swallowed, and the proposal is not marked applied. That state —
accepted, not withdrawable, its blocker on the record — is the one a
persistently refusing run already produces, and its remedy is the one it always
had: a fresh proposal against the request as it stands. A failing attempt
records its conflict only on a proposal that is still `accepted`: one another
attempt of the same acceptance applied meanwhile (a retry in another process,
say), or one rejected or withdrawn before the run admitted anything, is left
exactly as that write left it, and the failing caller is told which.

## 8. Identity and staleness

A proposal binds, at submission, to:

```
rules_snapshot_sha       the Published Canonical release it was written under
baseline_id              the run's Source-Faithful Baseline
candidate_id             the run's candidate target, when it has one
run_revision             the run as the agent read it
asset_selection_digest   the actual stored bytes digest and size per asset
decision_set_fingerprint the accepted decision set the run recorded
request_key + code + step + gate + report_reference
```

Every one is re-read on every read and again before an acceptance, and each is
checked **twice** — against the run, and against the project:

| Checked against | Catches |
| --- | --- |
| the run | the run advanced, its candidate moved, its recorded selection changed |
| the project | intake replaced the baseline, the bound candidate is no longer stored, an asset no longer matches the digest the run snapshotted |

Both halves are needed. A run holds what it wrote down, so re-ingesting under
new sources or applying a revision outside the run moves the material without
moving anything the run recorded. The acceptance would still have been refused —
Phase 1 re-validates every binding per step — but a proposal a reader is told is
applicable, and which halts the run the moment it is accepted, is a proposal
whose verdict was answering the wrong question.

A completed (audit-closed) run and a run whose step may or may not have landed
accept no proposal at all, and `proposalTargets` says so with
`accepts_proposals: false` before an agent writes anything. **Both** interruption
markers are read, because they are written at different moments: `pending_step`
is written before a mutating effect and survives a crash, while the derived
`needs_reconciliation` flag is written only once a *later* advancement has
already tried to settle that effect and failed. Reading the flag alone left a
window — the whole window that matters — in which a proposal could be accepted
onto a step that may or may not exist. The adversarial review found that too.

**A snapshot nobody can name is not a snapshot that matches.** The Canonical
half of that binding compared `loaded && bound && loaded !== bound`, so a
binding with no snapshot skipped the comparison altogether. Two states reach
that: a proposal submitted while the Published Canonical could not be loaded,
which honestly records `rules_snapshot_sha: null`, and a record restored from a
schema that predates the field. Both read as `REQUIRES_EXPLICIT_ACCEPTANCE` —
the first while Canonical judgment was stopped, and both under every release
published afterwards. A missing field is not a wildcard anywhere else in this
protocol, and the rules release is the last place it could be one, so an absence
on either side is now its own refusal, `CANONICAL_SNAPSHOT_UNKNOWN`, kept
distinct from `CANONICAL_SNAPSHOT_CHANGED` because "the release moved under
you" and "nobody can say which release either of us means" have different
remedies.

A baseline that cannot be *read* is `STALE`, not a fabricated citation: "this
identity is not in the baseline" and "there is no baseline to look in" are
different facts with different remedies, and collapsing them would accuse a
correct proposal of forgery every time intake had been re-run underneath it.

## 9. Security boundary

All public proposal input goes through a closed schema — one per operation, not
a union, for the same reason the run operations have one each.

| Attack | Answer |
| --- | --- |
| unknown field | refused at every level (`UNKNOWN_FIELD`), never ignored |
| inherited / prototype-chain field | **left behind**, not refused — and that is the stronger answer. Every request object is rebuilt from its own enumerable fields onto a fresh one, so an inherited field never exists as far as the service is concerned and `Object.keys` and `obj.field` cannot disagree. Refusing one would mean walking a caller-controlled prototype chain, which is a hazard of its own |
| `__proto__` / `constructor` / `prototype` as a key | refused by name at every level. The shared `statedFields` rebuild writes with `Object.defineProperty`, so an own `__proto__` from a parsed body survives as ordinary data instead of being consumed as a prototype write nobody can see |
| fabricated event / source / evidence / request id | resolved against this project, refused when it does not |
| cross-project, cross-owner identity | not refused so much as **not found**: the record is loaded for this owner and this project |
| server-computed acceptance binding | refused (`SERVER_COMPUTED_FIELD_SUPPLIED`) |
| agent-named accepting reviewer | refused (`ACCEPTANCE_IDENTITY_SUPPLIED`) |
| agent-authored reviewer evidence record | refused (`REVIEWER_EVIDENCE_RECORD_SUPPLIED`): a decision may carry no `leadEvidence`, on the arrangement path and the reduction path alike |
| internal provenance keys | stripped by the public boundary before any operation sees them |
| collapsed confidence score | refused at every nesting level |
| oversized rationale, deep nesting, huge arrays, long field names | bounded by `LIMITS`, spent as a budget rather than discovered by a recursion limit |
| an oversized proposal that breaks no *shape* bound | bounded in **bytes** by `maxProposalBytes`, measured on the record as it will be stored. The node, depth and string budgets bound a proposal's shape; none of them bounds its size, and 4000 nodes × a 4000-character string is 15 MB inside every one of them |
| too many proposals | two caps: `maxProposalsPerProject` counts the **open** ones, and the refusal says "resolve or withdraw one" only when one can be (`withdrawable_open_proposals`) — an accepted proposal whose application may have reached the run cannot be; `maxProposalsRetainedPerProject` bounds the lifetime total and promises no remedy, because a resolved proposal is an audit record and nothing evicts it |
| stale proposal replay | the policy, recomputed; plus the run's own per-step re-validation |

MCP carries no bytes. Every proposal input is an identity, a small structured
option or short text, and `rationale` is held to the same 2048-character
inline-text bound every MCP string field is held to — enforced by the service,
so neither transport admits what the other refuses.

### Two bounds that were shapes, not sizes

The same pass found two places where this layer stated something that was not
true, both in its own storage bounds. Neither is a security escalation — the
security properties all held — and both are the failure this protocol refuses
everywhere else: *a stated thing that is not so*.

**A proposal was bounded in shape, not in size.** The free-form structure a
proposal carries was spent against a node, depth and string-length budget, and
none of those is a byte budget. A payload of 1850 values, each a string of
exactly `maxStringLength`, is 1851 of 4000 nodes at depth 3 — and 7 MB, stored
verbatim in the project record, while that record's own comment called a
proposal "small by construction". The declared budget alone permits 15 MB per
proposal. A long field *name* was a second, smaller gap: a key costs no node, so
75 keys of 100,000 characters spent 75 of 4000.

`maxProposalBytes` is now measured on the record as it will be stored, and keys
are bounded like values. 128 KiB is MCP's own body cap, so a proposal that fits
one surface fits the other. Worth naming precisely: the *manual* Phase 1 path
consumes this structure transiently, and only the proposal record retains it —
so this is new to Phase 2 rather than inherited.

*"As it will be stored"* had to be made true a second time. The measurement ran
before `agent_review_at_submission` was attached, and that verdict is stored
with the record and is not a constant: `REQUIRES_MORE_EVIDENCE` repeats the
caller's own `missing_evidence` strings back into it. A record measured at
129,906 bytes was persisted at 146,681 — 11.9% past the number its own refusal
quotes and the number the per-project budget is reckoned from. It is measured
twice now: once before the policy runs, as a cheap refusal that spends no
evaluation on a payload that cannot be stored whatever the verdict, and once
after, which is the bound. A regression reads the bytes off the disk rather than
off a projection of them.

**The proposal cap named a remedy that did not exist.** It counted every
proposal a project had ever held, and resolving one removes nothing, so
"Resolve or withdraw one before submitting another" was a no-op and a project
was locked out of the protocol for good at 64. `proposalTargets` also went on
answering `accepts_proposals: true` there, advertising a capability every
submission was then refused.

The open cap now counts only open proposals, so its remedy is true; a separate
retention cap bounds the lifetime total and promises no remedy, because there is
none but a new project; and `accepts_proposals` reflects both.

**`accepts_proposals` ignored a project that had moved under the run.** A run
whose baseline was replaced, whose bound candidate is gone or whose selected
asset bytes changed kept listing its old review requests with
`accepts_proposals: true`, but the Agent Review Policy marks every proposal
bound to such a run STALE from the moment it is stored. The targets read now
applies the same project checks to the binding a new proposal would get,
answers `accepts_proposals: false` when any holds, and names them in
`stale_at_submission`.

### One fix that belongs to Phase 1

The adversarial pass found the worst defect not in this layer but under it.
`statedFields` — the primitive `withoutInternalProvenance` is built from, and
the one every operation boundary in the service depends on — rebuilt a request
with `rebuilt[key] = value[key]`. For the single key `"__proto__"` that invokes
the inherited setter and retargets the object's prototype rather than adding a
field, and an own `"__proto__"` key is precisely what `JSON.parse` of a request
body produces.

So a body of `{"__proto__": {"effectAttemptId": "eff_…"}, …}` came back with no
own internal-provenance field and every internal-provenance field *readable*: the
function whose entire purpose is to make `effectAttemptId` unforgeable
constructed the forgery, and a service destructuring `{ effectAttemptId }` read
the caller's value. Phase 1's whole reconciliation identity proof — "a record
carrying another attempt's id is somebody else's effect" — rests on that field
being unsuppliable.

The existing HTTP routes were not reachable, because each rebuilds its call
shape from named body fields; the Phase 2 proposal routes pass the parsed body
straight through, which is deliberate (it is what lets the service's closed
schema *refuse* an unknown field rather than an adapter silently drop it) and is
what made the primitive's weakness reachable. It is fixed at the root, in
`contracts.mjs`, with `Object.defineProperty`, so every caller gets the
guarantee the function always claimed — including a direct in-process one, which
is what its own comment promised.

## 10. Transports

HTTP and MCP go through the **same** proposal service. Neither holds a policy.

| HTTP | MCP |
| --- | --- |
| `GET /api/v1/projects/:id/runs/:run_id/proposal-targets` | `studio_proposal_targets` |
| `POST /api/v1/projects/:id/proposals` | `studio_proposal_submit` |
| `GET /api/v1/projects/:id/proposals` · `GET …/proposals/:proposal_id` | `studio_proposal_status` |
| `POST /api/v1/projects/:id/proposals/:proposal_id/resolve` | `studio_proposal_resolve` |

Four tools rather than fewer. `targets` and `status` write nothing and answer
different questions — what a *run* is waiting for, and what a stored *proposal*
says — while `submit` and `resolve` are the two halves the whole protocol exists
to keep apart: merging them would make submitting a proposal into accepting it.

A parity regression asserts the two surfaces answer identically, refusal
included. One difference is real and is stated rather than hidden: an unknown
**top-level** field is refused by HTTP through the service's closed key set and
by MCP through `additionalProperties: false` before the dispatch is reached, so
the codes differ because the layers differ. What must not differ — and does not
— is whether it is refused, and whether anything was stored.

## 11. Run integration

Phase 1's `review_requests` are the proposal input, directly: every request now
carries the `request_key` that addresses it, and `proposalTargets` derives the
admissible classes, the downstream operations and the upstream module's own
`missing` text from the run's own requests. It invents no target: a request the
run is not making is not listed.

**A run does not advance because a proposal exists.** Storing one does not touch
the run's revision. Only an explicit acceptance reaches `resumeRun`, and from
there the run's ordinary resume semantics apply unchanged. `runs.refuses` states
this as a fact a caller can read.

The audit-closed contract is untouched: a completed run refuses a material
change, and a proposal is a material change.

## 12. Capabilities stay factual

`ai_proposal_protocol`, `proposal_persistence` and
`proposal_agent_review_policy` are `true` because those things exist.
`automatic_proposal_acceptance`, `automatic_proposal_generation` and
`server_side_model_calls` are `false`. So are `background_execution`,
`automatic_run_continuation`, `audio_to_midi`, `source_separation`,
`vocal_isolation`, `exact_pitch_transcription_from_audio` and `in_game_test` —
Phase 2 changed none of them.

The `proposals` block states the single acceptable verdict, the supported
classes and what each reaches, the evidence vocabulary, the bounds, and two
lists worth reading: `never_agent_settlable` (what no proposal settles at any
evidence level, in any class) and `refuses` (ten things the protocol will not
do).

## 13. Model-agnostic by construction

There is no provider name in the protocol, no provider branch, no model
identifier field, no SDK and no credential, and the service calls no model.
`proposed_by` is caller-supplied text recorded for the audit trail; it is not an
authenticated identity and is never presented as one. The proposal record has no
field for which model wrote it, so a provider cannot be recorded and therefore
cannot later be branched on — a regression asserts that too.

ChatGPT, Claude, Codex, a future model and a local script reach the identical
contract, because the answer to "what does this song need next" must not depend
on who asked.

## 14. Regressions

Eleven files. Every regression in them that exercises the service does so
through `createStudioApplication` — in `tests/proposal-transport.test.mjs`
mostly through its HTTP and MCP doors — and there every operation runs on the
real Canonical engines, the real G11-C suggestion, the real G11-D application,
the real G12 ledger and the real readiness modules: no mock stands in for any of
them. The tests that do not exercise the service are eight of the ten in
`proposal-contracts.test.mjs`, which check the protocol's constants and pure
functions directly, one in `tests/proposal-transport.test.mjs`, which reads the
MCP tool schemas, and five of the nine in
`proposal-plan-derivation-memo.test.mjs`, described below.

To reach a state the service would not produce by itself, a regression through
the service changes one of these, and nothing else:

* an engine fault, a counted derivation, a plan answered with no id or with
  another id, or another request or write started from inside an engine call at
  a chosen moment: exactly one engine function is replaced over the real set,
  and it delegates to the real one (`studio/tests/support/real-engines.mjs`);
* another published release: `proposal-staleness.test.mjs` relabels the loaded
  rules' `PUBLISHED_CANONICAL` metadata with another `rules_snapshot_sha` over
  the real engines — a value, so nothing delegates;
* a missing Manifest: the engine load fails;
* an interruption: thrown from, or held forever in, a run hook, which may first
  start another request or read the stored record;
* stored state no current operation writes: a record an earlier version or an
  older build left, a restored record whose asset no longer matches the digest
  the run recorded (`proposal-staleness.test.mjs` writes a corrupted `sha256`),
  stored bytes rewritten or removed under the ids that name them, and the
  proposal states the open-proposal cap counts, each written into the store
  directly;
* the HTTP door: the router is handed the authenticated owner (`ownerOf`)
  rather than resolving one from credentials.

The five tests of `proposal-plan-derivation-memo.test.mjs` that do not go
through the service test the memo's key and its guards on their own. The four
built on `memoWorld` drive `createPlanDerivationMemo` over a synthetic world: a
fake engine set (`{ release: 'engines-1' }`), a fake provenance, a fake store
write count, a fake stored-input identity and a fake derivation, which together
let the test move each input the key covers on its own — the loaded engines and
the rules snapshot included, which a running service holds constant. The
stored-input identity test calls the real `planInputIdentity` of an arrangement
service it builds, with an intake service, over a real in-memory store: both
with `canonical: null`, the intake service with no asset service, and both
reading a stub `projects.load` that returns a record the test writes. The other
four tests in the file go through the service as above.

| File | What it pins |
| --- | --- |
| `studio/tests/proposal-contracts.test.mjs` | the derived request key, the closed target table, the one actionable verdict |
| `studio/tests/proposal-protocol.test.mjs` | submitting changes nothing; no gate, no in_game; suggestion ≠ acceptance; PENDING stays PENDING; **manual path == accepted-proposal path** |
| `studio/tests/proposal-classes.test.mjs` | reduction, adaptation, source selection and candidate selection each land where a manual caller lands |
| `studio/tests/proposal-staleness.test.mjs` | every binding, moved underneath a proposal, refuses it |
| `studio/tests/proposal-security.test.mjs` | forged identities, unknown and inherited fields, prototype keys, server-computed fields, collapsed scores, bounds, replay |
| `studio/tests/proposal-agent-review-policy.test.mjs` | the Lead evidence boundary, Gate 8, Gate 9, the ladder, recomputation |
| `studio/tests/proposal-duplication.test.mjs` | one acceptance, one application — across retries, concurrency, a crash in the window, a second interruption, a process that dies inside the run, and an interruption by a fault followed by a retry whose process dies inside the run; a retry continues only from a run whose latest write is its own application's, and is refused once any other writer — a reviewer, the same payload without the key, the same key with another payload — has moved it; a pin or a marker an earlier version recorded is not trusted past what it proves, a writer record a build that predates it carried onto its own revision is not read as this application's, and nor is a write that records no writer; the step-budget hold this build writes, reached through the run hooks, records the request that spent the budget |
| `studio/tests/proposal-adversarial.test.mjs` | the four escalations an independent adversarial review found, and the two storage bounds the same pass found saying something that was not true (§9), each kept in the shape it was found in |
| `studio/tests/proposal-untranslatable.test.mjs` | a proposal the acceptance could never translate is `INVALID` before it is accepted, and one whose plan cannot be derived from the stored material is `STALE`; an acceptance the run never admitted — failed before the run, or refused by the run before it wrote anything, because another acceptance or a reviewer moved it first — can be withdrawn, race-free, is graded again on a retry, and pins no revision — nor does a refused twin of an attempt of the same acceptance the run admitted first; one that may have reached it cannot be withdrawn; an admitted attempt records where its own request left the run, never a revision a reviewer's resume produced after it, and that reviewer's move leaves its retry refused; an attempt whose only write is the run's first hold records that write as its own and is finished by its retry; a retry that would carry another request under the same key is refused before the run writes; an acceptance the release a rollback returns to may have applied cannot be withdrawn once that release has written to the run since the acceptance — a bare write in its shape, or its retry of the acceptance stopped by a fault or by a process death (the cases §7 lists) — on a run this build started, on one kept before the run recorded writers, and on one that already kept an unattributed revision from before the acceptance, including when writes through this build that record their writer follow — and nor can one after a write that records no writer; every case but the bare writes on a run this build started also checks that the rejection is refused, that the refusal names that release's latest write, and that the retry is refused as `STALE`; the open cap does not count such an acceptance as one that can be withdrawn, while such a write the acceptance observed leaves it withdrawable |
| `studio/tests/proposal-plan-derivation-memo.test.mjs` | the policy derives a plan once per set of inputs, and a held outcome is never served for any other: each input moved on its own, and a derivation a change may have raced, is derived afresh (`studio/tests/application-store-regressions.test.mjs` pins that every store write method moves the write count that guard reads, and no read does) |
| `tests/proposal-transport.test.mjs` | HTTP/MCP parity, and what Phase 2 did not add |

## 15. Not covered by Phase 2

* Background execution, queues, cancellation and automatic continuation.
* Automatic proposal generation, and any server-side model call.
* Audio-to-MIDI, stem separation, vocal isolation, pitch transcription.
* In-game acceptance, which only the user or a controlled target-client test
  records.
* Migrating the Permanent Studio Web plane onto this service.
* Multi-user authorization beyond the existing owner isolation: a proposal is
  submitted and resolved by the same authenticated owner, and `proposed_by` /
  `accepted_by` are recorded text rather than a second identity system.
* Official MCP SDK migration, and any Canonical rule change.
* Named historical song regressions: still `FIXTURE_PENDING` until a
  reproducible fixture exists and is actually executed.

## 16. Authority

This document is IMPLEMENTATION NOTES. The Published Canonical Manifest and the
rule sources it indexes are the authority; this layer, its transports and its
tests are implementers and verifiers and cannot define or amend a Canonical rule
in reverse.
