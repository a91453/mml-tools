// One-Click Orchestrator — run vocabulary.
//
// Status: IMPLEMENTATION NOTES. This file names the states, steps, halt reasons
// and review-request codes of a *workflow instance*. Every name here is
// implementation vocabulary. None of it is a Canonical rule, a Canonical gate,
// a Canonical PASS/PENDING value or a musical policy, and no constant here may
// be read as one.
//
// Why the two vocabularies are named apart, again and explicitly
// ---------------------------------------------------------------
// `contracts.mjs` already keeps operation status and Canonical gates apart. A
// run adds a third axis, and it is the most dangerous of the three, because a
// run is the thing a caller is most tempted to read as a verdict: "the run
// completed" feels like "the song is done". It is not. A run state answers
// only "how far did this workflow instance get, and what is it waiting for".
//
//   run state          this file. A workflow instance's own progress.
//   operation status   `OPERATION_STATUS` — did one call do what it was asked?
//   readiness gates    `final/readiness.mjs` — is the song ready?
//   acceptance gates   `GATE_NAMES` — the seven public Canonical axes.
//   song state         CANDIDATE / VALIDATED / IN_GAME_ACCEPTED, which only an
//                      authoritative result may report.
//
// A `completed` run means the run reached the end of the steps it was allowed
// to take and the existing `finalize` delivered a Final artifact. It does not
// mean TECHNICAL_PASS, SOURCE_PASS, VALIDATED or IN_GAME_ACCEPTED, and the run
// record says so in its own notice rather than relying on a reader to know it.
//
// Execution model
// ---------------
// Bounded synchronous advancement. `startRun` and `resumeRun` each take as many
// steps as the current inputs allow and then return. Nothing continues after
// the call returns: there is no background queue, no worker pool, no timer and
// no automatic restart in this build, and `capabilities.jobs.background_execution`
// stays `false`. A run that is waiting is waiting for another explicit call.

const freeze = Object.freeze;

export const RUN_RECORD_SCHEMA = 'mabinogi-mobile-mml-studio/application-run@1';
export const RUN_REPORT_SCHEMA = 'mabinogi-mobile-mml-studio/application-run-report@1';
export const RUN_REPORT_ARTIFACT_TYPE = 'run_report';

/**
 * How a run makes progress, stated as a value so a caller cannot mistake the
 * presence of a run record for something still executing.
 */
export const RUN_EXECUTION_MODE = 'bounded-synchronous-advancement';

export const RUN_EXECUTION_NOTICE = 'A run advances only inside the startRun/resumeRun call that was made. The core run engine has no background queue, no worker pool, no timer and no automatic restart. A separately enabled and explicitly authorized external agent driver may make subsequent calls; inspect that driver status separately. A run in awaiting_review, blocked or interrupted stays there until an explicit resumeRun call is made with new input, decisions or evidence.';

/**
 * Run lifecycle states. Implementation vocabulary, deliberately not the
 * Canonical PASS / FAIL / PENDING / UNSUPPORTED / N/A vocabulary.
 */
export const RUN_STATE = freeze({
  CREATED: 'created',
  RUNNING: 'running',
  AWAITING_REVIEW: 'awaiting_review',
  BLOCKED: 'blocked',
  COMPLETED: 'completed',
  FAILED: 'failed',
  INTERRUPTED: 'interrupted',
});

export const RUN_STATE_NAMES = freeze(Object.values(RUN_STATE));

/**
 * The steps a Phase 1 run may take, in the only order it takes them.
 *
 * Each one is a call into an existing Application Service operation. None of
 * them is a new parser, arranger, evaluator or emitter, and none of them
 * resolves a decision, invents evidence or moves a gate.
 */
export const RUN_STEP = freeze({
  INTAKE: 'intake',
  SUGGEST: 'suggest',
  APPLY_DECISIONS: 'apply_decisions',
  FINAL_REDUCTION: 'final_reduction',
  MOBILE_ADAPTATION: 'mobile_adaptation',
  REVIEW: 'review',
  FINALIZE: 'finalize',
  REPORT: 'report',
});

export const RUN_STEP_ORDER = freeze([
  RUN_STEP.INTAKE,
  RUN_STEP.SUGGEST,
  RUN_STEP.APPLY_DECISIONS,
  RUN_STEP.FINAL_REDUCTION,
  RUN_STEP.MOBILE_ADAPTATION,
  RUN_STEP.REVIEW,
  RUN_STEP.FINALIZE,
  RUN_STEP.REPORT,
]);

/** Which existing operation each step calls, for discovery and for the record. */
export const RUN_STEP_OPERATION = freeze({
  [RUN_STEP.INTAKE]: 'analyzeSources',
  [RUN_STEP.SUGGEST]: 'suggestArrangement',
  [RUN_STEP.APPLY_DECISIONS]: 'applyDecisions',
  [RUN_STEP.FINAL_REDUCTION]: 'planFinalReduction / applyFinalReduction',
  [RUN_STEP.MOBILE_ADAPTATION]: 'planMobileAdaptation / applyMobileAdaptation',
  [RUN_STEP.REVIEW]: 'recordConfirmations / reviewCandidate',
  [RUN_STEP.FINALIZE]: 'finalize',
  [RUN_STEP.REPORT]: 'getArtifact (run report)',
});

/**
 * What happened to one step on one advancement.
 *
 * `SATISFIED` and `SKIPPED` are different facts and stay different: satisfied
 * means the result this step would produce already existed and was reused;
 * skipped means the step had nothing to do, which is never a gate result. In
 * particular a skipped Mobile adaptation does not make Gate 8 PASS — the
 * Gate 8 review is a separate, evidence-backed statement, and a run that
 * changed nothing still needs it.
 */
export const RUN_STEP_STATUS = freeze({
  PLANNED: 'planned',
  COMPLETED: 'completed',
  SATISFIED: 'satisfied',
  SKIPPED: 'skipped',
  AWAITING_INPUT: 'awaiting_input',
  BLOCKED: 'blocked',
  FAILED: 'failed',
  UNCONFIRMED: 'unconfirmed',
});

/**
 * Why an advancement stopped. A halt reason is a statement about the run, not
 * about the song: the song's state is whatever the upstream reports say.
 */
export const RUN_HALT = freeze({
  AWAITING_DECISIONS: 'AWAITING_ACCEPTED_DECISIONS',
  AWAITING_REDUCTION_DECISIONS: 'AWAITING_ACCEPTED_REDUCTION_DECISIONS',
  AWAITING_REVIEW_EVIDENCE: 'AWAITING_REVIEW_EVIDENCE',
  AWAITING_SOURCE_SELECTION: 'AWAITING_SOURCE_SELECTION',
  AWAITING_CANDIDATE_SELECTION: 'AWAITING_CANDIDATE_SELECTION',
  OPERATION_BLOCKED: 'OPERATION_BLOCKED',
  INPUT_CHANGED: 'RUN_INPUT_CHANGED',
  BASELINE_CHANGED: 'RUN_BASELINE_CHANGED',
  CANDIDATE_CHANGED: 'RUN_CANDIDATE_CHANGED',
  CANONICAL_SNAPSHOT_CHANGED: 'RUN_CANONICAL_SNAPSHOT_CHANGED',
  // The project's baseline was built from an intake input this run cannot
  // prove it shares — in practice, an MML source's meter map. Re-ingesting
  // under the run's own (absent) meter would silently produce a different
  // baseline, so the run stops instead.
  METER_BINDING_UNPROVABLE: 'RUN_BASELINE_INTAKE_INPUT_UNPROVABLE',
  RECONCILIATION_REQUIRED: 'RUN_RECONCILIATION_REQUIRED',
  STEP_BUDGET_EXHAUSTED: 'RUN_STEP_BUDGET_EXHAUSTED',
  CAPABILITY_UNSUPPORTED: 'RUN_CAPABILITY_UNSUPPORTED',
});

/**
 * Review-request codes.
 *
 * Every one of these names *what the run is waiting for*. None of them is a
 * gate verdict, and none of them is a substitute for the upstream blocker code
 * a request carries: `blockers` always holds the owning module's own codes,
 * unchanged, and `report_reference` says where they came from.
 *
 * `READINESS_GATE_BLOCKED` is deliberately one code for every readiness gate,
 * including gates this file has never heard of. There is no allow-list here
 * that decides a run may proceed when a blocker is absent from a table: the
 * run proceeds only when the upstream readiness report says nothing blocks it.
 * An unrecognised blocker is reported with `known: false` and still blocks.
 */
export const RUN_REVIEW_REQUEST = freeze({
  SOURCE_SELECTION_REQUIRED: 'SOURCE_SELECTION_REQUIRED',
  SYMBOLIC_SOURCE_REQUIRED: 'SYMBOLIC_SOURCE_REQUIRED',
  SOURCE_METER_BINDING_REQUIRED: 'SOURCE_METER_BINDING_REQUIRED',
  ARRANGEMENT_DECISIONS_REQUIRED: 'ARRANGEMENT_DECISIONS_REQUIRED',
  ARRANGEMENT_DECISIONS_REFUSED: 'ARRANGEMENT_DECISIONS_REFUSED',
  REDUCTION_DECISIONS_REQUIRED: 'REDUCTION_DECISIONS_REQUIRED',
  REDUCTION_APPLY_BLOCKED: 'REDUCTION_APPLY_BLOCKED',
  MOBILE_ADAPTATION_BLOCKED: 'MOBILE_ADAPTATION_BLOCKED',
  READINESS_GATE_BLOCKED: 'READINESS_GATE_BLOCKED',
  FINALIZE_BLOCKED: 'FINALIZE_BLOCKED',
  CANDIDATE_SELECTION_REQUIRED: 'CANDIDATE_SELECTION_REQUIRED',
  RUN_INPUT_CHANGED: 'RUN_INPUT_CHANGED',
  RECONCILIATION_REQUIRED: 'RECONCILIATION_REQUIRED',
});

/**
 * For each readiness gate, the existing operation that can answer it.
 *
 * A *hint table*, not a gate table. It never decides whether a gate blocks —
 * `readiness.preGameBlocking` decides that — and a gate missing from here is
 * reported with no hint and `known: false` while still blocking the run. The
 * alternative, a table that listed "the gates that matter", would be a second
 * readiness model, and a gate added upstream would silently stop blocking.
 */
export const READINESS_GATE_OPERATIONS = freeze({
  implementation: freeze([]),
  source: freeze(['analyzeSources', 'recordConfirmations.source_complete']),
  baseline: freeze(['analyzeSources']),
  technical: freeze(['finalize']),
  // A release no Final token can express is answered by an evidence-backed
  // release representation decision in the Mobile adaptation stage. The
  // finalize-time technical timing repair is not listed: finalize refuses a
  // blocked micro-timing gate before the emitter (and its opt-in repair) runs,
  // so naming it here would send a caller to an operation that cannot answer.
  microTiming: freeze(['planMobileAdaptation', 'applyMobileAdaptation.release_representation']),
  core3: freeze(['approveCore3SourceChange']),
  core3Completeness: freeze(['recordConfirmations.core3_completeness_reviewed']),
  leadDemotion: freeze(['applyDecisions.leadEvidence', 'reviewLeadEvidence']),
  leadPromotion: freeze(['applyDecisions.leadEvidence', 'reviewLeadEvidence']),
  crossSourceHarmony: freeze(['applyDecisions', 'applyFinalReduction']),
  versionDrift: freeze(['recordConfirmations.version_drift_reviewed']),
  originalAudio: freeze(['attachAudioAlignment', 'recordConfirmations.original_audio_reviewed', 'recordConfirmations.original_audio_required']),
  playerReadback: freeze(['recordConfirmations.player_readback']),
  mobileAdaptation: freeze(['applyMobileAdaptation', 'recordConfirmations.mobile_adaptation_reviewed']),
  regression: freeze(['recordConfirmations.regression_reviewed']),
  pendingDecisions: freeze(['applyDecisions']),
});

/**
 * Which input changes expire a review request.
 *
 * Reported on every request so a caller knows when the answer it is about to
 * supply would arrive too late. It restates the existing binding discipline
 * (confirmations are baseline- or candidate-bound, approvals and Lead
 * citations are candidate-bound, decisions carry acceptance bindings); it does
 * not create one.
 */
export const RUN_REQUEST_INVALIDATORS = freeze({
  baseline: 'the selected asset set or their bytes change, or intake produces a different baseline_id',
  candidate: 'a later revision is applied, so the request names a candidate that is no longer the run target',
  canonical: 'the Published Canonical rules snapshot changes',
  decisions: 'the accepted decision set changes',
  plan: 'the reduction or adaptation plan id changes because its inputs changed',
  meter: 'the source-confirmed meter map an MML source was ingested against changes, because the baseline is parsed against it',
});

export const RUN_SEPARATION_NOTICE = 'A run state is implementation progress, not a Canonical verdict. completed means this workflow instance reached the end of the steps its inputs allowed and the existing finalize delivered an artifact. A completed run, a succeeded operation and a succeeded job are each independent of TECHNICAL_PASS, SOURCE_PASS, PLAYER_READBACK_PASS, AUDIO_ALIGNMENT_PASS, MOBILE_ADAPTATION_PASS, VALIDATED and IN_GAME_ACCEPTED. in_game is never set by this service.';

export const RUN_AUTHORITY_NOTICE = 'This orchestrator applies only decisions a caller explicitly accepted and evidence a caller explicitly supplied. It converts no suggestion into an acceptance, no PENDING into KEEP/OMIT/PASS, and no absence of data into N/A or not-required. Every blocker, warning and gate status it reports is a projection of the module that produced it.';
