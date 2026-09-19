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
| `studio/backend/application/contracts.mjs` | `pro_` identity, three error codes, five bounds. |
| `studio/backend/application/run-service.mjs` | Every review request now carries the `request_key` an agent addresses it by. Nothing else changed. |
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
| `INVALID` | The protocol itself: a forged identity, an unknown field, a field only the server may compute, a collapsed score. |
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
(`REVIEWER_EVIDENCE_RECORD_SUPPLIED`). The move itself stays proposable — an
agent can still say "this belongs in Melody, and here is why" — and without a
citation the engine holds it `PENDING`, which is the honest state and exactly
what `SOURCE_POLICY.md` §4 requires of incomplete Lead evidence. A reviewer
supplies the citation through `applyDecisions` or `reviewLeadEvidence`, the
paths that already exist and already bind it to a named reviewer.

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
checked against a plan derived under *that* reviewer, and a mismatch is stale.
An un-checkable stated field is worse than no field, because the agent reads it
back and believes it was honoured.

An **adaptation** plan id is bound to the candidate and the profile, both of
which the proposal carries, so an agent *can* state it in advance. It is still
derived rather than taken, and a stated id the inputs no longer produce is
refused rather than overridden.

### Crossing the lock

`runs.resume` takes the per-project serializer itself, so the acceptance cannot
hold it: one project key acquired twice deadlocks by construction. The sequence
is therefore

```
1. under the lock   validate, re-run the policy, mark accepted, record an
                    application marker: a deterministic idempotency key
                    `proposal:<proposal_id>:<revision>` and the run revision
                    observed now
2. no lock          translate, call runs.resume with that key and that revision
                    as expected_run_revision
3. under the lock   record the outcome
```

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
pass found in turn. A retry also skips the policy gate, so an acceptance whose
application had been interrupted became a *standing permission*: whatever the
run had since become — another reviewer's decision set, another candidate, a
request that was no longer open — the retry reached `runs.resume` anyway, and
the proposal was recorded `applied` naming an advancement it had not caused,
with the policy's own read of it saying `STALE` at the same moment.

So the precondition is **carried forward** rather than dropped: phase 3 records
the revision the interrupted attempt left the run at, and a retry sends that as
its `expected_run_revision`. A retry then finishes exactly the application it is
a retry of, and a run that moved for any other reason fails the precondition and
is refused. The receipt is still checked *first*, so a run that did apply this
replays it either way. A regression drives all three interruption classes and
requires the retry to complete with exactly one candidate for one acceptance;
another drives a human reviewer's resume into the same window and requires the
retry to be refused.

**A retry does not re-litigate the acceptance.** An acceptance is a recorded past
act; a crash between it and its application advances the run, which makes the
proposal stale, and re-running the policy there would refuse the very retry the
marker exists for. So the policy gate is skipped for a proposal that is already
`accepted` and carries a marker — and nothing is taken on trust, because safety
there is the run's: the same key, and the carried-forward revision precondition
that pins the retry to the run the acceptance was applying to. This mirrors
Phase 1's own ordering, where an idempotency replay is decided *before* the
audit-closed guard.

The one genuinely ambiguous state — the run advanced but its receipt was not
written, which is a crash inside `advance` — is reported as the conflict it is,
with the run's own reconciliation machinery as the remedy. The proposal is not
marked applied, the conflict is recorded on it rather than swallowed, and
nothing guesses.

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
| too many proposals | two caps: `maxProposalsPerProject` counts the **open** ones, so the refusal's "resolve or withdraw one" is true, and `maxProposalsRetainedPerProject` bounds the lifetime total and promises no remedy, because a resolved proposal is an audit record and nothing evicts it |
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

**The proposal cap named a remedy that did not exist.** It counted every
proposal a project had ever held, and resolving one removes nothing, so
"Resolve or withdraw one before submitting another" was a no-op and a project
was locked out of the protocol for good at 64. `proposalTargets` also went on
answering `accepts_proposals: true` there, advertising a capability every
submission was then refused.

The open cap now counts only open proposals, so its remedy is true; a separate
retention cap bounds the lifetime total and promises no remedy, because there is
none but a new project; and `accepts_proposals` reflects both.

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

Seven files, all against the real Canonical engines, the real G11-C suggestion,
the real G11-D application, the real G12 ledger and the real readiness modules.
No mock stands in anywhere.

| File | What it pins |
| --- | --- |
| `studio/tests/proposal-contracts.test.mjs` | the derived request key, the closed target table, the one actionable verdict |
| `studio/tests/proposal-protocol.test.mjs` | submitting changes nothing; no gate, no in_game; suggestion ≠ acceptance; PENDING stays PENDING; **manual path == accepted-proposal path** |
| `studio/tests/proposal-classes.test.mjs` | reduction, adaptation, source selection and candidate selection each land where a manual caller lands |
| `studio/tests/proposal-staleness.test.mjs` | every binding, moved underneath a proposal, refuses it |
| `studio/tests/proposal-security.test.mjs` | forged identities, unknown and inherited fields, prototype keys, server-computed fields, collapsed scores, bounds, replay |
| `studio/tests/proposal-agent-review-policy.test.mjs` | the Lead evidence boundary, Gate 8, Gate 9, the ladder, recomputation |
| `studio/tests/proposal-duplication.test.mjs` | one acceptance, one application — across retries, concurrency and a crash in the window |
| `studio/tests/proposal-adversarial.test.mjs` | the four escalations an independent adversarial review found, kept in the shape they were found in |
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
