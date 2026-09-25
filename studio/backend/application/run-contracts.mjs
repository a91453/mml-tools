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
  // A release no Final token can express — and the sub-grid gap it leaves
  // before the next attack — is answered by an evidence-backed release
  // representation decision in the Mobile adaptation stage. G10 raises
  // MICRO_TIMING_RELEASE_NOT_FINAL_REPRESENTABLE only for a release with no keep
  // claim and at least one valid representation, so release representation can
  // answer every release that code stands for. The finalize-time technical
  // timing repair is not listed: finalize refuses a blocked micro-timing gate
  // before the emitter (and its opt-in repair) runs, so naming it here would
  // send a caller to an operation that cannot answer. A sub-grid interval with
  // no non-representable release behind it (a sub-grid note, or a gap after a
  // release Final can express) has no application operation in this build; an
  // open one is answered in the Canonical source itself. A preserved one
  // (source-supported, MICRO_TIMING_SOURCE_SUPPORTED_NOT_FINAL_REPRESENTABLE)
  // is answered by nothing in this build, so that blocker is listed in
  // READINESS_BLOCKER_WITHOUT_OPERATION below. Nor has a position Final cannot
  // reach that is an onset, a rest boundary, or a release under a keep claim or
  // with no valid representation (MICRO_TIMING_BOUNDARY_NOT_FINAL_REPRESENTABLE):
  // release representation never moves an onset or a rest and refuses such a
  // release, so that blocker is listed in READINESS_BLOCKER_WITHOUT_OPERATION
  // below, and a request carrying only blockers listed there names no
  // operation.
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
  // Not a readiness gate: the machine-delivery ledger's entry for a Final the
  // emitter would not write although every gate lets it through
  // (final/delivery-evaluator.mjs). No operation answers it as such; see
  // READINESS_BLOCKER_WITHOUT_OPERATION.
  finalEmission: freeze([]),
});

/**
 * Readiness blockers that no operation in this build answers, per gate, with
 * what a caller has to know instead.
 *
 * `READINESS_GATE_OPERATIONS` hints per gate, and a gate can carry a blocker
 * none of its listed operations can reach. A review request for such a gate
 * states each of these blockers it carries in `missing`, and when these are
 * all it carries it names no operation at all: a listed operation that cannot
 * answer sends a caller round a loop that returns the same refusal. Like the
 * table above, this decides nothing. The gate blocks exactly as readiness says,
 * and a blocker absent from here keeps the gate's own hint.
 */
export const READINESS_BLOCKER_WITHOUT_OPERATION = freeze({
  finalEmission: freeze({
    FINAL_EMISSION_REFUSED: 'FINAL_EMISSION_REFUSED: every readiness gate lets this candidate through, and the Final emitter, run on exactly what would be delivered with the options delivery uses, returned no Final. The emitter\'s own status and diagnostics are carried unchanged in this entry (emitter_status and emitter_diagnostics, with emitter_diagnostic_count and emitter_diagnostics_truncated); each diagnostic names what it is about in the emitter\'s words. No operation in this build answers the refusal as such: nothing rewrites the emitter\'s answer, reclassifies material or moves a gate to reach a Final, and finalizing the same candidate again returns the same refusal. It is answered where each diagnostic points -- the Canonical source, a decision the owning stage records on its own evidence, or an arrangement decision -- and finalize asks the emitter again. Until then no Final is delivered.',
    FINAL_EMISSION_PENDING: 'FINAL_EMISSION_PENDING: every readiness gate lets this candidate through, and the Final emitter returned PENDING for exactly what would be delivered, with the options delivery uses. The question it is waiting on is named in emitter_diagnostics, unchanged. PENDING is never read as a Final, and no operation in this build answers it as such; it is answered where that diagnostic points, and finalize asks the emitter again.',
  }),
  microTiming: freeze({
    MICRO_TIMING_BOUNDARY_NOT_FINAL_REPRESENTABLE: 'MICRO_TIMING_BOUNDARY_NOT_FINAL_REPRESENTABLE: a position a Final role has to reach sits where no admitted Final token sequence reaches, and nothing in this build moves it. It is an onset, a rest boundary, or a note release no release representation can move (one under a keep claim, or one whose every representation is invalid); readiness.gates.microTiming.unsupportedBoundaries names each one with coverage "none" by role, event, boundary, beat and reason. No operation in this build answers it. An onset is an attack and is never moved; applyMobileAdaptation refuses to move an onset or remove a rest, and its release_representation moves only a note release and refuses one under a keep claim (RELEASE_EVENT_HAS_A_SOURCE_SUPPORTED_KEEP_CLAIM) and any option not valid for its release (RELEASE_REPRESENTATION_NOT_VALID_FOR_EVENT); applyDecisions and applyFinalReduction change no event timing; and the finalize-time Technical Timing Repair reaches only classified sub-grid intervals and never runs past a blocked microTiming gate. Omitting a note that starts or ends there, or moving it to another role, would change the boundary only by changing the arrangement, which is an arrangement decision on its own evidence and not an answer to this gate, so it is not suggested. The positions come from the sources the Source-Faithful Baseline was built from, and a keep claim from the decisions the Canonical project carries, so it is answered in the Canonical source itself: a baseline analysed from sources that put the boundary where Final reaches does not carry it, and a release no keep claim covers that has a valid representation is answered by release representation instead. Until then this candidate cannot become a Final, and the gate still blocks.',
    MICRO_TIMING_SOURCE_SUPPORTED_NOT_FINAL_REPRESENTABLE: 'MICRO_TIMING_SOURCE_SUPPORTED_NOT_FINAL_REPRESENTABLE: a sub-grid interval is classified SOURCE_SUPPORTED_MICROTIMING (an accepted keep decision with admissible evidence), so it must be kept exactly: never deleted, shortened, quantized, absorbed or moved (MASTER_RULES §7, MOBILE_SYNTAX §11 step 1). No admitted Final token is shorter than 1/64 of a whole note (MOBILE_SYNTAX §2, §3, §4), so no Final writes it as the interval it is, and the Final emitter refuses the candidate (SOURCE_SUPPORTED_INTERVAL_NOT_REPRESENTABLE). readiness.gates.microTiming.preservedIntervalKeys names each interval, and its enforcement entry gives the type, event ids, start, end, length and keep decision. No operation in this build answers it. applyMobileAdaptation refuses to move an onset or remove a rest, and its release_representation refuses a release under a keep claim (RELEASE_EVENT_HAS_A_SOURCE_SUPPORTED_KEEP_CLAIM) and any option not valid for its release (RELEASE_REPRESENTATION_NOT_VALID_FOR_EVENT); applyDecisions and applyFinalReduction change no event timing; the provisional hold never applies beside source-supported material; and the finalize-time Technical Timing Repair never runs past a blocked microTiming gate. Withdrawing or rejecting the keep decision would change the interval\'s classification, which is decided only on its own evidence (SOURCE_POLICY), and omitting a note or moving it to another role is an arrangement decision on its own evidence; neither is an answer to this gate, so neither is suggested. The loaded Canonical gives no Final representation for source-supported material finer than 1/64, so it stays PENDING/UNSUPPORTED (ACCEPTANCE_CRITERIA Gate 2): this candidate cannot become a Final under it, and the gate still blocks.',
  }),
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
