// AI Proposal Protocol — proposal vocabulary.
//
// Status: IMPLEMENTATION NOTES. This file names the kinds, states, agent-review
// verdicts, refusal causes and target table of an *AI proposal*. Every name
// here is implementation vocabulary. None of it is a Canonical rule, a
// Canonical gate, a Canonical PASS/FAIL/PENDING value or a musical policy, and
// no constant here may be read as one.
//
// What a proposal is
// ------------------
// A structured, durable, auditable, refusable statement by an external agent —
// ChatGPT, Claude, Codex, a future model, a local script — about what it thinks
// one open run review request should be answered with, and why.
//
// A proposal is the weakest thing in this system that is still worth storing.
// It sits *below* conversation context in the Canonical authority order
// (`MASTER_RULES.md` §0), because it is not a user decision, not a Canonical
// document, not confirmed in-game evidence, not official evidence, not an
// accepted project regression and not a community example. It is a reviewed
// caller's suggestion that happens to have been written by a machine.
//
// So, said as the five things it is not, because each one is a real failure
// this protocol exists to make impossible:
//
//   proposal ≠ accepted decision      an acceptance names a reviewer and is a
//                                     separate, explicit act. Submitting a
//                                     proposal performs none.
//   proposal ≠ gate PASS              no verdict here moves a Canonical
//                                     acceptance gate or a readiness gate.
//                                     This protocol produces no gate
//                                     confirmation of any kind.
//   proposal ≠ evidence               a citation is a pointer at evidence this
//                                     service can resolve. A proposal that
//                                     cites nothing has cited nothing; it does
//                                     not become evidence by being detailed.
//   proposal ≠ IN_GAME_ACCEPTED       only the user or a controlled
//                                     target-client test records that, and
//                                     this build records none.
//   proposal ≠ mutation               acceptance routes back into the existing
//                                     Application Service operation. This
//                                     layer holds no second musical engine and
//                                     mints no candidate, revision or artifact.
//
// Four vocabularies, still separate
// ---------------------------------
// `contracts.mjs` keeps operation status and Canonical gates apart.
// `run-contracts.mjs` adds run state as a third axis. A proposal is a fourth,
// and it is the one most likely to be read as a verdict, because a proposal is
// written in the language of a decision:
//
//   proposal state     this file. What happened to one agent's statement.
//   run state          `RUN_STATE` — how far one workflow instance got.
//   operation status   `OPERATION_STATUS` — did one call do what it was asked?
//   readiness gates    `final/readiness.mjs` — is the song ready?
//   acceptance gates   `GATE_NAMES` — the seven public Canonical axes.
//   song state         CANDIDATE / VALIDATED / IN_GAME_ACCEPTED.
//
// An `applied` proposal means an explicit acceptance was recorded and the
// existing operation the proposal named was called with the input the proposal
// prepared. It does not mean the operation succeeded, that a candidate was
// minted, that a gate moved, or that anything about the song is now true. The
// operation's own result says those things, in its own words, exactly as it
// does for a caller who never used a proposal at all.
//
// Model-agnostic by construction
// ------------------------------
// There is no provider name in this protocol, no provider branch, no model
// identifier field, no SDK and no credential. `proposed_by` is caller-supplied
// text recorded for the audit trail — it is not an authenticated identity and
// is never presented as one. Every agent goes through the identical contract,
// because the answer to "what does this song need next" must not depend on who
// asked.

import { sha256Of } from './store.mjs';
import { RUN_REVIEW_REQUEST } from './run-contracts.mjs';

const freeze = Object.freeze;
const encoder = new TextEncoder();

export const PROPOSAL_RECORD_SCHEMA = 'mabinogi-mobile-mml-studio/application-proposal@1';
export const PROPOSAL_PROTOCOL_VERSION = 1;

// ─── request identity ───────────────────────────────────────────────────────
//
// A Phase 1 review request carries no id of its own: it is a projection, rebuilt
// on every advancement from the upstream report that produced it. An agent still
// has to be able to say *which* request it is answering, and the three ways that
// would otherwise be reached for are exactly the three this codebase refuses
// everywhere else — the newest one, the first matching one, and the one at a
// remembered array index.
//
// So a request is addressed by a key DERIVED from what makes it that request:
// the code, the step, the gate it projects, the report it was read from, and
// the baseline and candidate it is bound to. Two consequences, both wanted:
//
//   * the key is stable while the request is the same request, so an agent can
//     read a run, think, and come back;
//   * the key CHANGES when the candidate or baseline moves, so a proposal
//     written against the old material cannot address the new request at all.
//     Staleness is structural here rather than a check somebody has to
//     remember to write.
//
// Not a content digest of the whole request. `blockers`, `missing`, `detail`
// and the bounded event ids are the request's *contents*, and they legitimately
// change as an upstream report is re-derived over the same candidate; keying on
// them would expire an open request for no reason. The six fields below are its
// identity.
export const REQUEST_KEY_FIELDS = freeze(['code', 'step', 'gate', 'report_reference', 'baseline_id', 'candidate_id']);

export const REQUEST_KEY_NOTICE = 'Two open requests that share all six identity fields share one key, which the run does produce: every non-meter staleness reason is projected onto one fixed shape, so an asset change and a Canonical snapshot change on the same run key alike. Such a key is refused as ambiguous rather than resolved to either -- picking one is how ownership-by-position returns -- and it costs nothing, because the requests that can collide admit only a description of what is missing. A review request key is derived from the request\'s code, step, gate, report reference, baseline id and candidate id. It is not an index, not a timestamp and not a content digest of the request body. A key that no current request carries addresses nothing, and a proposal holding one is stale rather than applied to whatever looks closest. It identifies a request WITHIN one run and is not globally unique: two runs over the same baseline, waiting on the same thing, legitimately carry the same key. Every proposal therefore names its run_id, and a key is only ever resolved against the requests of that run -- so a key read from one run can never address another run\'s request, whether or not the two happen to collide.';

/**
 * The stable key of one review request.
 *
 * Own-property reads only, and each field is JSON-quoted before joining, so no
 * value can impersonate the separator or reach in through a prototype.
 */
export const requestKeyOf = request => {
  const parts = REQUEST_KEY_FIELDS.map(field => {
    const value = request !== null && typeof request === 'object' && Object.hasOwn(request, field) ? request[field] : null;
    return `${field}=${JSON.stringify(value === undefined || value === null ? null : String(value))}`;
  });
  return `req:${sha256Of(encoder.encode(parts.join('\n')))}`;
};

const REQUEST_KEY = /^req:[0-9a-f]{64}$/;
export const isRequestKey = value => typeof value === 'string' && REQUEST_KEY.test(value);

// ─── what a proposal may be about ───────────────────────────────────────────

/**
 * The proposal classes this build supports.
 *
 * Each one exists because a Phase 1 run actually stops somewhere an agent could
 * usefully answer. There is no class here for a question the run never asks,
 * and no class that reaches an operation this service does not already have.
 */
export const PROPOSAL_KIND = freeze({
  /** KEEP / ASSIGN_ROLE / MOVE_ROLE / OMIT_FROM_SIX / DUPLICATE_WITH_JUSTIFICATION, in the existing G11-D decision vocabulary. */
  ARRANGEMENT_DECISION: 'arrangement_decision',
  /** Event-level choices over the existing read-only G12 analysis plan. */
  FINAL_REDUCTION: 'final_reduction',
  /** An evidence-bound Mobile profile for the existing adaptation plan. */
  MOBILE_ADAPTATION: 'mobile_adaptation',
  /** Which symbolic sources this run is about, and the meter they are parsed against. */
  SOURCE_SELECTION: 'source_selection',
  /** Which existing candidate the run should act on. Never "the newest". */
  CANDIDATE_SELECTION: 'candidate_selection',
  /**
   * "I cannot decide this, and here is exactly what would let someone."
   *
   * A first-class result, not a failure to produce one. It is the only class
   * admissible against a readiness gate, a blocked finalize, a changed input
   * and an interrupted step — the places where the honest machine answer is a
   * description of the missing evidence rather than a decision.
   */
  EVIDENCE_NEEDED: 'evidence_needed',
});

export const PROPOSAL_KIND_NAMES = freeze(Object.values(PROPOSAL_KIND));
export const isProposalKind = value => PROPOSAL_KIND_NAMES.includes(value);

/**
 * The existing operation an accepted proposal of each class is prepared for.
 *
 * Every one of these already exists and already holds every owner, Canonical,
 * integrity, evidence and acceptance check it has. This table says which one a
 * class reaches; it does not say a class may reach it, which is the agent
 * review policy's answer, and it creates no operation of its own.
 *
 * `EVIDENCE_NEEDED` reaches none, and that is the point: there is nothing to
 * apply, so accepting one performs no operation and advances no run.
 */
export const PROPOSAL_KIND_OPERATION = freeze({
  [PROPOSAL_KIND.ARRANGEMENT_DECISION]: 'resumeRun.decisions → applyDecisions',
  [PROPOSAL_KIND.FINAL_REDUCTION]: 'resumeRun.final_reduction → planFinalReduction / applyFinalReduction',
  [PROPOSAL_KIND.MOBILE_ADAPTATION]: 'resumeRun.mobile_adaptation → planMobileAdaptation / applyMobileAdaptation',
  [PROPOSAL_KIND.SOURCE_SELECTION]: 'resumeRun.asset_ids / meter_text → analyzeSources',
  [PROPOSAL_KIND.CANDIDATE_SELECTION]: 'resumeRun.adopt_candidate_id',
  [PROPOSAL_KIND.EVIDENCE_NEEDED]: null,
});

/**
 * Which proposal classes are admissible against which review request.
 *
 * A *closed* table, and the closure is the safety property. A request code this
 * table has never heard of admits `evidence_needed` and nothing else, and is
 * reported with `known: false` — exactly the discipline
 * `READINESS_GATE_OPERATIONS` uses for an unrecognised readiness gate. A new
 * upstream request code therefore cannot silently become agent-settlable by
 * being absent from a list.
 *
 * Note what `READINESS_GATE_BLOCKED` admits: `evidence_needed`, alone. Every
 * readiness gate — source completeness, Core3 completeness, the Lead axes,
 * player readback, Gate 8, Gate 9 — is answered by a confirmation, an approval
 * or an evidence record that a reviewer states. A proposal is not one of those
 * and cannot be turned into one, however detailed it is, so the only thing an
 * agent may do against a gate is describe what is missing.
 */
export const PROPOSAL_TARGETS = freeze({
  [RUN_REVIEW_REQUEST.SOURCE_SELECTION_REQUIRED]: freeze([PROPOSAL_KIND.SOURCE_SELECTION, PROPOSAL_KIND.EVIDENCE_NEEDED]),
  [RUN_REVIEW_REQUEST.SYMBOLIC_SOURCE_REQUIRED]: freeze([PROPOSAL_KIND.SOURCE_SELECTION, PROPOSAL_KIND.EVIDENCE_NEEDED]),
  [RUN_REVIEW_REQUEST.SOURCE_METER_BINDING_REQUIRED]: freeze([PROPOSAL_KIND.SOURCE_SELECTION, PROPOSAL_KIND.EVIDENCE_NEEDED]),
  // The request itself offers naming an existing candidate as the alternative
  // to a decision set, so both classes are admissible against it.
  [RUN_REVIEW_REQUEST.ARRANGEMENT_DECISIONS_REQUIRED]: freeze([PROPOSAL_KIND.ARRANGEMENT_DECISION, PROPOSAL_KIND.CANDIDATE_SELECTION, PROPOSAL_KIND.EVIDENCE_NEEDED]),
  [RUN_REVIEW_REQUEST.ARRANGEMENT_DECISIONS_REFUSED]: freeze([PROPOSAL_KIND.ARRANGEMENT_DECISION, PROPOSAL_KIND.EVIDENCE_NEEDED]),
  [RUN_REVIEW_REQUEST.REDUCTION_DECISIONS_REQUIRED]: freeze([PROPOSAL_KIND.FINAL_REDUCTION, PROPOSAL_KIND.EVIDENCE_NEEDED]),
  [RUN_REVIEW_REQUEST.REDUCTION_APPLY_BLOCKED]: freeze([PROPOSAL_KIND.FINAL_REDUCTION, PROPOSAL_KIND.EVIDENCE_NEEDED]),
  [RUN_REVIEW_REQUEST.MOBILE_ADAPTATION_BLOCKED]: freeze([PROPOSAL_KIND.MOBILE_ADAPTATION, PROPOSAL_KIND.EVIDENCE_NEEDED]),
  [RUN_REVIEW_REQUEST.CANDIDATE_SELECTION_REQUIRED]: freeze([PROPOSAL_KIND.CANDIDATE_SELECTION, PROPOSAL_KIND.EVIDENCE_NEEDED]),
  // Gates, a blocked finalize, a changed input and an interrupted step. None of
  // these is answered by a decision: they are answered by a reviewer's
  // confirmation, by new material, or by a human inspecting a stored record.
  [RUN_REVIEW_REQUEST.READINESS_GATE_BLOCKED]: freeze([PROPOSAL_KIND.EVIDENCE_NEEDED]),
  [RUN_REVIEW_REQUEST.FINALIZE_BLOCKED]: freeze([PROPOSAL_KIND.EVIDENCE_NEEDED]),
  [RUN_REVIEW_REQUEST.RUN_INPUT_CHANGED]: freeze([PROPOSAL_KIND.EVIDENCE_NEEDED]),
  [RUN_REVIEW_REQUEST.RECONCILIATION_REQUIRED]: freeze([PROPOSAL_KIND.EVIDENCE_NEEDED]),
});

/** What an unrecognised request code admits. Fail closed: description only. */
export const UNKNOWN_REQUEST_TARGETS = freeze([PROPOSAL_KIND.EVIDENCE_NEEDED]);

/**
 * Things no proposal settles, at any evidence level, in any class, ever.
 *
 * Stated as data so a capability reader and a regression can both cite it, and
 * so it is one list rather than a habit spread over the service.
 */
export const NEVER_AGENT_SETTLABLE = freeze([
  'in_game acceptance, which only the user or a controlled target-client test records',
  'any Canonical acceptance gate verdict, including technical, source, audio, player_readback, mobile_adaptation and regression',
  'any readiness gate verdict, including source, core3, core3Completeness, leadDemotion, leadPromotion, playerReadback, mobileAdaptation and regression',
  'a recorded confirmation of any kind, and in particular source_complete, player_readback, mobile_adaptation_reviewed (Gate 8), regression_reviewed (Gate 9), core3_completeness_reviewed (Gate 4) and original_audio_reviewed (Gate 7)',
  'a Core3 source-change approval or a Lead evidence citation, both of which are candidate-bound review records filed through their own operations (approveCore3SourceChange, reviewLeadEvidence), where they are graded on their evidence whoever submits them',
  'the acceptance binding a decision carries, which this service computes from what is loaded now',
  'the reconciliation of an interrupted step, which rests on a caller having actually inspected the stored record',
  'the identity of a baseline, a candidate or an artifact, all of which are content-addressed by the engines that mint them',
]);

// ─── proposal state ─────────────────────────────────────────────────────────

/**
 * What has happened to one proposal. Deliberately not the Canonical
 * PASS / FAIL / PENDING / UNSUPPORTED / N/A vocabulary, and deliberately not
 * the run state vocabulary either.
 *
 * There is no `stale` state, on purpose. Staleness is not something a proposal
 * becomes and then is; it is a fact about the proposal's bindings against what
 * is stored *now*, and nothing walks the project to expire records when a
 * baseline moves. So it is recomputed on every read and on every acceptance,
 * and it lives in the agent review verdict rather than in the record's state.
 * A stored `stale` would be a cache of a safety check, and a cache of a safety
 * check is a safety check that can be wrong.
 */
export const PROPOSAL_STATE = freeze({
  SUBMITTED: 'submitted',
  /** Explicitly accepted by a named reviewer; the existing operation is being reached. */
  ACCEPTED: 'accepted',
  /** The existing operation was called with the input this proposal prepared. */
  APPLIED: 'applied',
  REJECTED: 'rejected',
  /** Withdrawn by the owner. Never by the agent that submitted it, which holds no authenticated identity. */
  WITHDRAWN: 'withdrawn',
});

export const PROPOSAL_STATE_NAMES = freeze(Object.values(PROPOSAL_STATE));

/** The states from which an acceptance or a rejection may still be recorded. */
export const OPEN_PROPOSAL_STATES = freeze([PROPOSAL_STATE.SUBMITTED, PROPOSAL_STATE.ACCEPTED]);

// ─── the agent review policy's vocabulary ───────────────────────────────────

/**
 * What the Agent Review Policy answers.
 *
 * The policy does not judge musical truth. It never decides whether a Lead
 * belongs in Melody, whether an omission is safe, or whether a register shift
 * preserves a role — every one of those is arbitrated by the existing engines,
 * under the Published Canonical rules, when the operation runs. The policy
 * answers exactly one narrower question:
 *
 *   does this proposal carry enough binding, evidence and authority to be
 *   handed to the existing operation it names?
 *
 * Exactly one verdict is returned, from a fixed ladder evaluated in order, so
 * "which problem does this proposal have" has one answer rather than a set a
 * caller has to rank.
 */
export const AGENT_REVIEW = freeze({
  /** The proposal fails the protocol itself: a forged identity, an unknown field, a field only the server may compute. */
  INVALID: 'INVALID',
  /** Well-formed, but a binding it names no longer matches what is stored now. */
  STALE: 'STALE',
  /** Correctly bound, but this class may not settle this target at any evidence level. */
  NOT_AGENT_SETTLABLE: 'NOT_AGENT_SETTLABLE',
  /** In scope and correctly bound, but what the downstream operation needs is absent — including when the proposal says so itself. */
  REQUIRES_MORE_EVIDENCE: 'REQUIRES_MORE_EVIDENCE',
  /** In scope, bound and complete, but this class reaches no operation: it records a position for a reviewer. */
  PROPOSABLE: 'PROPOSABLE',
  /** In scope, bound, complete, and naming an existing operation. The only verdict an acceptance may act on. */
  REQUIRES_EXPLICIT_ACCEPTANCE: 'REQUIRES_EXPLICIT_ACCEPTANCE',
});

export const AGENT_REVIEW_NAMES = freeze(Object.values(AGENT_REVIEW));

/**
 * The ladder, in the order the policy evaluates it. The first rule that matches
 * is the verdict.
 *
 * STALE is first, ahead of INVALID, and the order is load-bearing rather than
 * incidental. Everything INVALID checks is checked AGAINST the bindings: a
 * cited event id is resolved against the baseline the proposal names, a cited
 * report reference against the requests the run is currently making. When those
 * bindings have moved, the forgery check is not merely redundant, it is
 * actively misleading -- an agent whose baseline was re-ingested underneath it
 * would be told its citations were fabricated, which is a different accusation
 * with a different remedy. Staleness explains why the identities no longer
 * resolve, so it is reported first and the forgery checks run only once the
 * material they are evaluated against is still the material.
 */
export const AGENT_REVIEW_ORDER = freeze([
  AGENT_REVIEW.STALE,
  AGENT_REVIEW.INVALID,
  AGENT_REVIEW.NOT_AGENT_SETTLABLE,
  AGENT_REVIEW.REQUIRES_MORE_EVIDENCE,
  AGENT_REVIEW.PROPOSABLE,
  AGENT_REVIEW.REQUIRES_EXPLICIT_ACCEPTANCE,
]);

/**
 * The single verdict an acceptance may act on.
 *
 * One value, not a list. A list is something a later change adds to without
 * noticing what it has widened; a single value has to be deliberately
 * replaced, and a regression asserts it is still one value.
 */
export const ACCEPTABLE_AGENT_REVIEW = AGENT_REVIEW.REQUIRES_EXPLICIT_ACCEPTANCE;

export const AGENT_REVIEW_NOTICE = 'The Agent Review Policy answers whether a proposal carries enough binding, evidence and authority to be handed to an existing operation. It is not a musical verdict, not a gate result and not an acceptance. REQUIRES_EXPLICIT_ACCEPTANCE is the strongest verdict it produces and it means exactly what it says: an explicit acceptance by a named reviewer is still required, and until one is recorded nothing has been applied.';

/**
 * Why a verdict came out the way it did.
 *
 * Carried as codes beside the verdict rather than folded into a message,
 * because a caller has to be able to tell "your citation does not resolve" from
 * "the candidate moved under you" without parsing prose.
 */
export const PROPOSAL_REFUSAL = freeze({
  // INVALID — the protocol itself.
  UNKNOWN_FIELD: 'UNKNOWN_FIELD',
  // `__proto__`, `constructor`, `prototype`. Refused rather than sanitized: a
  // caller told its field was dropped knows where it stands, and a caller whose
  // field was silently turned into a prototype write does not.
  PROTOTYPE_POLLUTING_KEY: 'PROTOTYPE_POLLUTING_KEY',
  UNKNOWN_PROPOSAL_KIND: 'UNKNOWN_PROPOSAL_KIND',
  ACTION_KIND_MISMATCH: 'ACTION_KIND_MISMATCH',
  FABRICATED_REQUEST_KEY: 'FABRICATED_REQUEST_KEY',
  FABRICATED_EVENT_ID: 'FABRICATED_EVENT_ID',
  FABRICATED_SOURCE_ID: 'FABRICATED_SOURCE_ID',
  FABRICATED_EVIDENCE_REF: 'FABRICATED_EVIDENCE_REF',
  CROSS_PROJECT_IDENTITY: 'CROSS_PROJECT_IDENTITY',
  SERVER_COMPUTED_FIELD_SUPPLIED: 'SERVER_COMPUTED_FIELD_SUPPLIED',
  // A proposal that named its own accepting reviewer. `applyDecisions` reads a
  // decision's own `acceptedBy` in preference to the call's, so an agent that
  // could set it would write the acceptance binding itself and the reviewer who
  // accepted the proposal would never appear on the decision at all. That is
  // suggestion becoming acceptance in one field, so the field is refused.
  ACCEPTANCE_IDENTITY_SUPPLIED: 'ACCEPTANCE_IDENTITY_SUPPLIED',
  // A proposal that authored a reviewer's own evidence record -- in practice a
  // decision's `leadEvidence`. The shared Lead grader checks that a citation
  // BINDS to a real baseline source identity; it cannot check that anybody
  // actually read the score, so a well-formed record written by an agent grades
  // exactly like one written by a reviewer and moves the Gate 3 axes to PASS.
  // That is a machine authoring the evidence for its own proposal, which is the
  // one thing `NEVER_AGENT_SETTLABLE` says a proposal never does.
  REVIEWER_EVIDENCE_RECORD_SUPPLIED: 'REVIEWER_EVIDENCE_RECORD_SUPPLIED',
  COLLAPSED_CONFIDENCE_SCORE: 'COLLAPSED_CONFIDENCE_SCORE',
  EXPECTED_OPERATION_MISMATCH: 'EXPECTED_OPERATION_MISMATCH',

  // STALE — a binding moved.
  CANONICAL_SNAPSHOT_CHANGED: 'CANONICAL_SNAPSHOT_CHANGED',
  // Neither side of that comparison can be named: the proposal's binding
  // records no rules snapshot, or this service has none loaded. Distinct from
  // CANONICAL_SNAPSHOT_CHANGED on purpose -- "the release moved under you" and
  // "nobody can say which release either of us means" have different remedies,
  // and collapsing them would report a proposal written under no known rules as
  // though it had been written under a known one that has since moved.
  CANONICAL_SNAPSHOT_UNKNOWN: 'CANONICAL_SNAPSHOT_UNKNOWN',
  BASELINE_CHANGED: 'BASELINE_CHANGED',
  CANDIDATE_CHANGED: 'CANDIDATE_CHANGED',
  ASSET_SELECTION_CHANGED: 'ASSET_SELECTION_CHANGED',
  DECISION_SET_CHANGED: 'DECISION_SET_CHANGED',
  RUN_REVISION_CHANGED: 'RUN_REVISION_CHANGED',
  REQUEST_NO_LONGER_OPEN: 'REQUEST_NO_LONGER_OPEN',
  REQUEST_AMBIGUOUS: 'REQUEST_AMBIGUOUS',
  REDUCTION_PLAN_INPUTS_CHANGED: 'REDUCTION_PLAN_INPUTS_CHANGED',
  ADAPTATION_PLAN_INPUTS_CHANGED: 'ADAPTATION_PLAN_INPUTS_CHANGED',
  RUN_AUDIT_CLOSED: 'RUN_AUDIT_CLOSED',
  RUN_NEEDS_RECONCILIATION: 'RUN_NEEDS_RECONCILIATION',

  // NOT_AGENT_SETTLABLE — out of scope for any proposal.
  TARGET_NOT_SETTLABLE_BY_THIS_CLASS: 'TARGET_NOT_SETTLABLE_BY_THIS_CLASS',
  TARGET_NOT_SETTLABLE_BY_ANY_PROPOSAL: 'TARGET_NOT_SETTLABLE_BY_ANY_PROPOSAL',

  // REQUIRES_MORE_EVIDENCE — in scope, not yet answerable.
  MISSING_EVIDENCE_DECLARED: 'MISSING_EVIDENCE_DECLARED',
  UNRESOLVED_CONFLICT_DECLARED: 'UNRESOLVED_CONFLICT_DECLARED',
  NO_VERIFIABLE_CITATION: 'NO_VERIFIABLE_CITATION',

  // PROPOSABLE — recorded, reaches no operation.
  NO_DOWNSTREAM_OPERATION: 'NO_DOWNSTREAM_OPERATION',
});

// ─── evidence, kept in separate fields ──────────────────────────────────────

/**
 * What class of truth a citation is.
 *
 * Required on every evidence reference, and the reason is `SOURCE_POLICY.md` §2:
 * symbolic truth and audio truth are separate evidence fields and must not be
 * collapsed into a single confidence score that can hide disagreement. Recording
 * the class per reference is how they stay separate in a machine-written
 * proposal, where the temptation to average is strongest.
 *
 * These names transcribe the existing source classes; they arbitrate nothing.
 * Which class may prove what is decided by the published rule sources and by
 * the engines that read them, not here.
 */
export const EVIDENCE_TRUTH_CLASS = freeze({
  /** Official or third-party symbolic sources: score, MusicXML, MIDI, MML. */
  SYMBOLIC: 'symbolic',
  /** Original official audio, and the alignment evidence derived from it. */
  AUDIO: 'audio',
  /** User-provided game behaviour for a stated client and version. */
  IN_GAME: 'in_game',
  /** Community works and guides. Supporting evidence, never official specification. */
  COMMUNITY: 'community',
  /** Accepted prior project versions and this project's own stored records. */
  PROJECT_HISTORY: 'project_history',
});

export const EVIDENCE_TRUTH_CLASS_NAMES = freeze(Object.values(EVIDENCE_TRUTH_CLASS));

export const EVIDENCE_SEPARATION_NOTICE = 'Every citation states its truth class, and the classes are stored in separate fields. This protocol accepts no single confidence score: a field named confidence, score, certainty, probability or likelihood is refused, because a collapsed number is exactly what hides a disagreement between symbolic and audio evidence that SOURCE_POLICY.md requires to be recorded.';

/**
 * Field names a proposal may not carry, whatever it means by them.
 *
 * Refused rather than ignored. A proposal that sent `confidence: 0.92` and had
 * it silently dropped would read, to the agent that wrote it and to a reviewer
 * skimming the record, as a confidence this service accepted.
 */
export const COLLAPSED_SCORE_KEYS = freeze(['confidence', 'score', 'certainty', 'probability', 'likelihood', 'confidence_score']);

/**
 * What an evidence reference may point at.
 *
 * Every one of these is an identity this service can resolve inside the
 * proposal's own project, which is what makes "fabricated evidence reference"
 * a checkable claim rather than a wish. A URL, a filename, a conversation
 * excerpt and a model's recollection are none of these, and are not accepted:
 * prose belongs in `rationale`, where nobody can mistake it for a pointer.
 */
export const EVIDENCE_REF_KIND = freeze({
  /**
   * A source in the Source-Faithful Baseline's own inventory.
   *
   * The one reference kind whose declared `truth_class` is CHECKED rather than
   * only recorded: the intake adapters wrote down each source's Canonical
   * authority, so "this is audio evidence" and "this is symbolic evidence" are
   * answerable mechanically. Swapping them is how a single collapsed score
   * gets in through the back door, one reference at a time.
   */
  SOURCE: 'source',
  ASSET: 'asset',
  ARTIFACT: 'artifact',
  JOB: 'job',
  CANDIDATE: 'candidate',
  BASELINE: 'baseline',
  RUN: 'run',
  /** A `report_reference` string a review request itself supplied. */
  REPORT_REFERENCE: 'report_reference',
});

export const EVIDENCE_REF_KIND_NAMES = freeze(Object.values(EVIDENCE_REF_KIND));

// ─── closed input key sets ──────────────────────────────────────────────────
//
// One closed set per operation, not a union, for the same reason the run
// operations have one each: a union lets one transport admit what another
// rejects, and lets a caller send a field the operation does not read.

export const PROPOSE_INPUT_KEYS = freeze([
  'idempotency_key', 'run_id', 'expected_run_revision', 'request_key', 'kind',
  'proposed_by', 'rationale', 'action', 'cites', 'unresolved_conflicts',
  'missing_evidence', 'canonical_warnings', 'expected_operation',
]);

/**
 * No `idempotency_key`, and the absence is deliberate.
 *
 * An acceptance already mints its own deterministic key —
 * `proposal:<proposal_id>:<revision>` — and passes it to `runs.resume`, so
 * retrying a resolve is safe by construction and a caller's key would bind
 * nothing. Accepting one anyway would be the defect this protocol refuses
 * elsewhere in as many words: a stated field that is validated, echoed nowhere
 * and never read, which an agent reads back and believes was honoured.
 */
export const RESOLVE_INPUT_KEYS = freeze([
  'resolution', 'accepted_by', 'reason', 'expected_proposal_revision',
]);

export const LIST_PROPOSALS_INPUT_KEYS = freeze(['run_id', 'request_key', 'state', 'kind']);

export const CITES_KEYS = freeze(['event_ids', 'source_ids', 'evidence_refs']);
export const EVIDENCE_REF_KEYS = freeze(['kind', 'id', 'truth_class', 'note']);
export const CONFLICT_KEYS = freeze(['summary', 'event_ids', 'source_ids', 'truth_classes']);

/** The action key set of each class. A class with no action carries none. */
export const PROPOSAL_ACTION_KEYS = freeze({
  [PROPOSAL_KIND.ARRANGEMENT_DECISION]: freeze(['decisions']),
  [PROPOSAL_KIND.FINAL_REDUCTION]: freeze(['decisions', 'instrument_profile', 'expected_plan_id', 'plan_accepted_by']),
  // No `plan_accepted_by`, and the absence is the same one `RESOLVE_INPUT_KEYS`
  // states for `idempotency_key`. A REDUCTION plan id is bound to its decision
  // set AND its reviewer, so a stated id is only checkable against a plan
  // derived under the reviewer it was derived under, and the pair is required
  // together. An ADAPTATION plan id is bound to the candidate and the profile --
  // which is precisely why an agent can state it in advance, and precisely why
  // no reviewer is needed to check it. The field was accepted, validated,
  // stored and echoed back here, and nothing ever read it: a reviewer's name,
  // written by the machine, on a record a human reads as an acceptance.
  [PROPOSAL_KIND.MOBILE_ADAPTATION]: freeze(['profile', 'expected_plan_id']),
  [PROPOSAL_KIND.SOURCE_SELECTION]: freeze(['asset_ids', 'meter_text']),
  [PROPOSAL_KIND.CANDIDATE_SELECTION]: freeze(['candidate_id']),
  [PROPOSAL_KIND.EVIDENCE_NEEDED]: freeze([]),
});

/** Which classes must carry at least one citation this service can resolve. */
export const CITATION_REQUIRED = freeze({
  [PROPOSAL_KIND.ARRANGEMENT_DECISION]: true,
  [PROPOSAL_KIND.FINAL_REDUCTION]: true,
  [PROPOSAL_KIND.MOBILE_ADAPTATION]: true,
  // The action itself names existing, verified identities — the asset ids and
  // the candidate id — so a separate citation would be ceremony, not evidence.
  [PROPOSAL_KIND.SOURCE_SELECTION]: false,
  [PROPOSAL_KIND.CANDIDATE_SELECTION]: false,
  [PROPOSAL_KIND.EVIDENCE_NEEDED]: false,
});

export const RESOLUTION = freeze({ ACCEPT: 'accept', REJECT: 'reject', WITHDRAW: 'withdraw' });
export const RESOLUTION_NAMES = freeze(Object.values(RESOLUTION));

/**
 * Which proposal bindings each kind of change expires.
 *
 * Reported on every proposal so an agent knows when the answer it is about to
 * have accepted would arrive too late. It restates the existing binding
 * discipline; it creates none.
 */
export const PROPOSAL_INVALIDATORS = freeze({
  canonical: 'the Published Canonical rules snapshot changes',
  baseline: 'the selected asset set or their bytes change, or intake produces a different baseline_id',
  candidate: 'a later revision is applied, so the proposal names a candidate that is no longer the run target',
  run_revision: 'the run advances, because a proposal answers the run as the agent read it',
  request: 'the review request this proposal answers is no longer open, so its derived key addresses nothing',
  decisions: 'the accepted decision set changes',
  plan: 'the reduction or adaptation plan derived from the proposal\'s own inputs changes because those inputs changed',
});

// ─── the notices a reader is owed ───────────────────────────────────────────

export const PROPOSAL_SEPARATION_NOTICE = 'A proposal is an external agent\'s structured statement about one open review request. It is not an accepted decision, not evidence, not a gate result and not a song state. An applied proposal means an explicit acceptance was recorded and the existing operation was called; whether that operation succeeded, what it produced and which gates moved are reported by that operation in its own words, exactly as for a caller who used no proposal at all. in_game is never set here.';

export const PROPOSAL_AUTHORITY_NOTICE = 'Submitting a proposal applies nothing, mutates no candidate, records no confirmation and moves no gate. Only an explicit acceptance by a named reviewer routes a proposal into an existing Application Service operation, and that operation re-validates every binding and performs every check it performs for any other caller. This layer converts no suggestion into an acceptance, no PENDING into KEEP / OMIT / PASS, and no absence of evidence into N/A or not-required.';

export const PROPOSAL_EXECUTION_NOTICE = 'Acceptance is bounded and synchronous: the existing operation is reached inside the resolve call that asked for it, through the run\'s ordinary resume semantics. When the call returns nothing is executing — there is no background queue, no worker pool, no timer and no automatic continuation in this build, and a run that is waiting stays waiting until an explicit call is made.';

export const PROPOSAL_MODEL_NOTICE = 'This protocol is model-agnostic. It holds no provider SDK, no model credential, no model identifier and no provider-specific branch, and this service calls no model. ChatGPT, Claude, Codex, a future model and a local script reach the identical contract. proposed_by is caller-supplied text recorded for the audit trail; it is not an authenticated identity and is never presented as one.';
