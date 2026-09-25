// Factual capability discovery for the Studio Application Interface.
//
// Status: IMPLEMENTATION NOTES. Every value here is a statement about what this
// build actually does. `false` means the capability is absent — never that an
// input was silently accepted as if it had been handled — and a capability
// being `true` certifies no Canonical gate.
//
// The audio capability wording is deliberate. The existing audio worker aligns
// an original recording against an already-symbolic Canonical project and
// reports beat↔seconds control points, tempo drift and confidence. It is an
// evidence layer. It is not audio-to-MIDI, not stem separation, not vocal
// isolation and not pitch transcription, and this interface must never let an
// agent read it as any of those.

import { ASSET_KIND_NAMES, GATE_NAMES, IDENTITY_MODEL, JOB_STATUS, LIMITS } from './contracts.mjs';
import { PRESCREEN_LIMITS } from './prescreen-service.mjs';
import { PREROLL_SECONDS } from '../audio/prescreen/prescreen.mjs';
import { RUN_EXECUTION_MODE, RUN_EXECUTION_NOTICE, RUN_RECORD_SCHEMA, RUN_REPORT_SCHEMA, RUN_SEPARATION_NOTICE, RUN_STATE_NAMES, RUN_STEP_OPERATION, RUN_STEP_ORDER } from './run-contracts.mjs';
import {
  ACCEPTABLE_AGENT_REVIEW,
  AGENT_REVIEW_NAMES,
  AGENT_REVIEW_NOTICE,
  EVIDENCE_REF_KIND_NAMES,
  EVIDENCE_SEPARATION_NOTICE,
  EVIDENCE_TRUTH_CLASS_NAMES,
  NEVER_AGENT_SETTLABLE,
  PROPOSAL_AUTHORITY_NOTICE,
  PROPOSAL_EXECUTION_NOTICE,
  PROPOSAL_KIND_NAMES,
  PROPOSAL_KIND_OPERATION,
  PROPOSAL_MODEL_NOTICE,
  PROPOSAL_PROTOCOL_VERSION,
  PROPOSAL_RECORD_SCHEMA,
  PROPOSAL_SEPARATION_NOTICE,
  PROPOSAL_STATE_NAMES,
  REQUEST_KEY_NOTICE,
} from './proposal-contracts.mjs';

const freeze = Object.freeze;

export const INTERFACE_VERSION = 'studio-application/v1';

// Named so a report can cite it without re-deriving the claim.
export const AUDIO_WORKER_ROLE = 'original-audio-evidence-alignment';

// How a Lead citation carried by an accepted decision is graded, stated beside
// the operation that answers Gate 3 so an agent is not sent to a path that
// cannot answer it.
const LEAD_DECISION_TIME_CITATION = 'applyDecisions.leadEvidence is graded at review and finalize on the project source each classified score/audio item cites (ref), like a reviewLeadEvidence citation; a decision states no audio method, so its audio classification is a machine metric and never positive role evidence. On that path only an official score the project holds, cited by ref, can prove the role; an uncited or third-party citation leaves the axis PENDING. A move already applied is answered through reviewLeadEvidence.';

/**
 * Build the capability record.
 *
 * `canonical` and `storage` are passed in rather than recomputed so that the
 * capability answer and the provenance answer in the same response cannot
 * disagree.
 */
export function buildCapabilities({ canonical, storage, jobs, transports = [] }) {
  return freeze({
    interface: INTERFACE_VERSION,
    canonical,
    model_agnostic: true,

    // Which callers exist. The Application Service is the orchestration
    // boundary; each of these is an adapter over it and holds no business
    // logic of its own.
    transports: freeze([...transports]),

    capabilities: freeze({
      midi_ingest: true,
      musicxml_ingest: true,
      // Compressed .mxl (bounded container reader), repeat/volta/D.C./D.S./
      // Coda/Fine expansion into playback order, pickup placement. Ambiguous
      // navigation is refused and leaves the source incomplete.
      musicxml_compressed_ingest: true,
      musicxml_navigation_expansion: true,
      mml_ingest: true,
      canonical_project_ingest: true,
      audio_alignment: true,
      audio_to_midi: false,
      source_separation: false,
      vocal_isolation: false,
      exact_pitch_transcription_from_audio: false,
      voice_split: true,
      role_suggestion: true,
      arrangement_application: true,
      mobile_adaptation: true,
      final_six_role_reduction: true,
      reduction_event_accounting_ledger: true,
      mobile_register_adaptation: true,
      mobile_volume_mapping: true,
      automatic_instrument_assignment: false,
      automatic_drum_face_mapping: false,
      automatic_collision_repair: false,
      automatic_performer_allocation: false,
      candidate_review: true,
      // The AI Proposal Protocol. `true` because the protocol exists and its
      // records are durable -- NOT because anything about it is automatic.
      // An external agent can submit a structured, citable, refusable
      // statement about one open review request; nothing applies it but an
      // explicit acceptance, and the three `false`s below say so as facts
      // rather than leaving a reader to infer them.
      ai_proposal_protocol: true,
      proposal_persistence: true,
      proposal_agent_review_policy: true,
      automatic_proposal_acceptance: false,
      automatic_proposal_generation: false,
      server_side_model_calls: false,
      // One traceable, explicitly resumable workflow instance over the
      // operations already listed here. It is `true` because the run
      // orchestration exists; it adds no musical capability, and every `false`
      // above stays `false` — in particular a run does not make this build
      // capable of background execution, cancellation, audio transcription or
      // an in-game test.
      one_click_run_orchestration: true,
      read_only_run_continuation: true,
      run_step_receipts: true,
      run_idempotency: true,
      run_optimistic_concurrency: true,
      run_interruption_reconciliation: true,
      // An interrupted step's marker records what already existed, so a
      // baseline, candidate or artifact that predates the effect is never
      // adopted as it — by the automatic path or by a named one.
      run_effect_before_set: true,
      // A run goes forward. Supplying a new decision set, reduction, adaptation
      // or meter map advances a live run and drops every result bound to the
      // identity it replaces; a COMPLETED run is an audit record and refuses a
      // material change rather than moving what it points at.
      run_monotonic_completion: true,
      run_downstream_invalidation: true,
      // Advancement is caller-driven. There is no automatic restart, no timer
      // and no queue: a waiting run waits for an explicit resume call.
      automatic_run_continuation: false,
      cross_process_run_coordination: false,
      version_drift_comparison: true,
      readiness_evaluation: true,
      micro_gap_enforcement: true,
      technical_timing_repair: true,
      final_emission: true,
      round_trip_readback: true,
      // Two separate Core3 questions, and neither answers the other: the
      // source-continuity audit with its own candidate-bound approval path, and
      // the independent Gate 4 musical-completeness result.
      core3_source_continuity_audit: true,
      core3_source_change_approval: true,
      core3_completeness_gate: true,
      // Lead evidence is recovered from the revision that performed the move and
      // re-graded against the current candidate, and a reviewer can re-supply a
      // citation for an already-applied move when a later revision moves the
      // Lead picture. Both axes; the shared grader runs every time.
      lead_evidence_lineage_recovery: true,
      lead_evidence_re_review: true,
      // A re-review is graded on its evidence, whoever submits it: the submitter
      // is provenance; each classified score/audio citation names a project
      // source (`ref`) that must be an official score or the original recording
      // the project holds; a machine-metric audio basis is never positive.
      lead_evidence_graded_on_evidence_not_submitter: true,
      // A decision's own `leadEvidence`, recovered from the lineage, is resolved
      // against the project's sources the same way before it is graded, and
      // its audio classification -- a decision states no method -- is a metric.
      lead_decision_citation_source_resolution: true,
      // The Published Canonical validator, and the legacy engine kept beside it
      // as an explicitly labelled diagnostic whose PASS is not a Canonical PASS.
      canonical_technical_validation: true,
      legacy_technical_diagnostic: true,
      // 音色 A/B 預篩: machine evidence only. It selects nothing, and
      // nothing applies its verdicts (the rule that would is an unpublished
      // draft). Shadow mode records predictions and the owner's choices.
      audio_prescreen: true,
      audio_prescreen_shadow_record: true,
      automatic_prescreen_selection: false,
      in_game_test: false,
    }),

    // How the heavier work actually runs. Stated so an agent never assumes a
    // background queue that does not exist.
    jobs: freeze({
      lifecycle: freeze(Object.values(JOB_STATUS)),
      background_execution: jobs?.backgroundExecution === true,
      job_cancellation: jobs?.cancellation === true,
      execution_model: jobs?.executionModel ?? 'synchronous-completion',
      notice: jobs?.notice ?? 'Work runs inline in the request that created the job and the job is already terminal when it is returned. The lifecycle is recorded, not simulated: no background queue, worker pool or external queue service exists in this build.',
    }),

    // How a run actually behaves. Stated as facts beside the job record above,
    // because the two are different things and an agent that reads one as the
    // other will wait for something that is not happening.
    runs: freeze({
      version: 1,
      record_schema: RUN_RECORD_SCHEMA,
      report_schema: RUN_REPORT_SCHEMA,
      execution_mode: RUN_EXECUTION_MODE,
      states: RUN_STATE_NAMES,
      steps: RUN_STEP_ORDER,
      step_operations: RUN_STEP_OPERATION,
      operations: freeze(['planRun', 'startRun', 'getRun', 'nextRun', 'resumeRun']),
      read_only_operations: freeze(['planRun', 'getRun', 'nextRun']),
      continuation: freeze({
        operation: 'nextRun', mcp_tool: 'studio_run_next', read_only: true,
        connector_exposure: 'NOT_OBSERVABLE_FROM_SERVER',
        notice: 'Conversation-hosted AI uses the existing proposal and explicit acceptance/resume operations. This snapshot never advances, accepts, reconciles or evaluates a gate. Check actual client tools and schemas separately; server capability is not client availability.',
      }),
      background_execution: false,
      automatic_continuation: false,
      cancellation: false,
      // The existing deployment runs one process. Nothing here has been shown
      // to be safe across processes or workers, so it is reported as absent
      // rather than left for a reader to assume from the per-project lock.
      cross_process_run_coordination: false,
      max_runs_per_project: LIMITS.maxRunsPerProject,
      max_steps_per_advance: LIMITS.maxRunStepsPerAdvance,
      idempotency: freeze({
        scope: 'owner + project + run operation',
        binding: 'the normalized request fingerprint the key was first used with',
        enforced_by: 'the Application Service run record, not a transport annotation',
        same_key_same_payload: 'the same run is returned; nothing is re-applied, no revision is taken and no artifact is produced',
        same_key_different_payload: 'refused with IDEMPOTENCY_CONFLICT; the original run is untouched',
      }),
      refuses: freeze([
        'converting a suggestion into an acceptance, or a PENDING into KEEP / OMIT / PASS',
        'writing source_complete, player_readback, or the Gate 4 / 8 / 9 reviews that a caller did not state with a reason',
        'recording player_readback as N/A or original_audio_required as false because data is missing',
        'applying a reduction or an adaptation that a caller did not accept with the plan id it reviewed',
        'reusing an approval, confirmation, plan or PASS after the source bytes, asset selection, baseline, candidate, accepted decisions, profile, plan or rules snapshot it was bound to changed',
        'adopting a candidate produced outside the run without it being named and its lineage and baseline verified',
        'replaying a step whose effect cannot be established from a deterministic identity or a stored reference',
        'minting a no-op revision when no transformation is needed, and treating that as a gate result',
        'rewriting the content or identity of a Final artifact, or presenting an earlier candidate\'s MML as a later run output',
        'proceeding past a readiness blocker it does not recognise',
        'naming an operation for a readiness blocker none in this build answers: MICRO_TIMING_BOUNDARY_NOT_FINAL_REPRESENTABLE (an onset, a rest boundary, or a release under a keep claim or with no valid representation, that Final cannot reach) and MICRO_TIMING_SOURCE_SUPPORTED_NOT_FINAL_REPRESENTABLE (a source-supported sub-grid interval no Final token can carry) are stated in the review request\'s missing, and a microTiming request that carries only them lists no operation; it still blocks',
        'naming an operation for a finalize the Final emitter refused: every gate finalize grades before emission was already satisfied, so FINALIZE_BLOCKED and the technical request it leaves NOT_RUN list no operation, and FINALIZE_BLOCKED carries the emitter\'s blocking diagnostic codes in detail.emitter_blockers',
        'advancing because a proposal exists: a stored proposal is an external agent\'s statement, and only its explicit acceptance reaches a resume',
      ]),
      execution_notice: RUN_EXECUTION_NOTICE,
      separation_notice: RUN_SEPARATION_NOTICE,
    }),

    // The AI Proposal Protocol. Stated beside `runs` rather than inside it,
    // because a proposal is not a run step and an agent that reads one as the
    // other will expect a run to move when a proposal is stored. It does not.
    proposals: freeze({
      version: PROPOSAL_PROTOCOL_VERSION,
      record_schema: PROPOSAL_RECORD_SCHEMA,
      states: PROPOSAL_STATE_NAMES,
      // The classes this build supports, and the EXISTING operation each one
      // reaches. `evidence_needed` reaches none, which is the point of it.
      kinds: PROPOSAL_KIND_NAMES,
      kind_operations: PROPOSAL_KIND_OPERATION,
      operations: freeze(['proposalTargets', 'proposeDecision', 'getProposal', 'listProposals', 'resolveProposal']),
      read_only_operations: freeze(['proposalTargets', 'getProposal', 'listProposals']),
      agent_review_verdicts: AGENT_REVIEW_NAMES,
      // One verdict, not a list. Everything else the policy can answer refuses.
      acceptable_verdict: ACCEPTABLE_AGENT_REVIEW,
      evidence_reference_kinds: EVIDENCE_REF_KIND_NAMES,
      evidence_truth_classes: EVIDENCE_TRUTH_CLASS_NAMES,
      max_proposals_per_project: LIMITS.maxProposalsPerProject,
      max_rationale_length: LIMITS.maxProposalRationaleLength,
      max_citations: LIMITS.maxProposalCitations,
      // Facts, and each one is a thing an agent might otherwise assume.
      automatic_acceptance: false,
      automatic_continuation: false,
      background_execution: false,
      server_side_model_calls: false,
      provider_specific_behaviour: false,
      // What a proposal cannot settle at any evidence level, in any class.
      never_agent_settlable: NEVER_AGENT_SETTLABLE,
      refuses: freeze([
        'applying anything on submission: storing a proposal mints no candidate, takes no revision, records no confirmation, moves no gate and does not advance the run',
        'accepting a proposal on any verdict but REQUIRES_EXPLICIT_ACCEPTANCE, which is a single value rather than a list',
        'reusing the agent\'s proposed_by as an acceptance, or letting a proposed decision name its own acceptedBy',
        'letting a proposal carry a review record: a proposed decision may not carry leadEvidence. A proposal is a suggestion that an explicit acceptance turns into a decision, and a Lead citation is a candidate-bound review record: it is filed through reviewLeadEvidence, where it is graded on its cited source, method and finding whoever submits it (the grader checks that a citation binds to a real baseline source identity and resolves to a source the project holds; it cannot check that anybody read the source)',
        'answering a readiness gate, a blocked finalize, a changed input or an interrupted step with anything but a description of what is missing',
        'recording source_complete, player_readback, the Gate 4 / 8 / 9 reviews, a Core3 approval, a Lead citation or in_game',
        'resolving a PENDING, converting a suggestion into an acceptance, or treating an absence of evidence as N/A or not-required',
        'citing an event, source, asset, artifact, job, candidate, run or report reference this project does not hold',
        'collapsing symbolic and audio evidence into a single confidence score, or mislabelling which class a cited source belongs to',
        'applying a proposal after the rules snapshot, baseline, candidate, asset selection, accepted decision set, run revision or review request it was bound to changed',
        'deriving a second musical result: acceptance prepares the input and the existing operation performs the mutation',
      ]),
      request_key_notice: REQUEST_KEY_NOTICE,
      agent_review_notice: AGENT_REVIEW_NOTICE,
      evidence_separation_notice: EVIDENCE_SEPARATION_NOTICE,
      execution_notice: PROPOSAL_EXECUTION_NOTICE,
      separation_notice: PROPOSAL_SEPARATION_NOTICE,
      authority_notice: PROPOSAL_AUTHORITY_NOTICE,
      model_notice: PROPOSAL_MODEL_NOTICE,
    }),

    asset_storage: freeze({
      durability: storage?.durability ?? 'ephemeral',
      backend: storage?.backend ?? 'filesystem',
      kinds: ASSET_KIND_NAMES,
      max_asset_bytes: LIMITS.maxAssetBytes,
      max_assets_per_project: LIMITS.maxAssetsPerProject,
      binary_plane: 'http-upload-only',
      notice: storage?.notice ?? null,
    }),

    identities: IDENTITY_MODEL,

    mobile_adaptation: freeze({
      version: 1,
      profile_schema: 'mml-studio/mobile-adaptation-profile@1',
      operations: freeze(['planMobileAdaptation', 'applyMobileAdaptation']),
      supported: freeze(['uniform-role-octave-shift', 'relative-volume-offset', 'explicit-default-volume', 'evidence-gated-release-representation']),
      notice: 'Register and volume adaptation require a cited target profile and a candidate with assigned roles. Release representation needs no profile: a note release no admitted Final token can express moves to an adjacent 1/64 grid point only under a decision whose evidence cites an independent primary source by a direct review of it; who submitted the decision is recorded and never graded; the source release stays on the baseline and on the event record. Preview before apply; stale plans are refused. Atomic, reversible derived revision, with fresh review. Does not certify Gate 8, infer audibility, map MIDI velocity or reduce to six roles: six-role reduction is the separate final_six_role_reduction stage, which runs before this one.',
      release_representation: freeze({
        record_schema: 'mml-studio/release-representation-record@1',
        decision_schema: 'mml-studio/release-representation-decision@1',
        representations: freeze(['EXTEND_TO_NEXT_GRID', 'TRUNCATE_TO_PREVIOUS_GRID']),
        admissible_evidence: freeze(['primary-symbolic (independent official score/MIDI asset, basis direct-source-review)', 'primary-audio (original recording, basis direct-source-review)']),
        evidence_bases: freeze(['direct-source-review', 'machine-metric', 'alignment-locator', 'encoding-pattern', 'imported-assertion']),
        submitter_kinds: freeze(['human', 'agent', 'tool', 'mcp-client', 'imported']),
        submitter_is_provenance_only: true,
        recorded_not_counted: freeze(['third-party score/MIDI/MML', 'source encoding pattern', 'audio metrics and alignment locators', 'tool output', 'imported assertions', 'accepted-prior (no record to bind in this build)']),
        profile_required: false,
      }),
      refuses: freeze([
        'pitch or volume change on an event a Lead evidence record still binds, including one only the revision lineage records; a Melody assigned from a role-less Source-Faithful Baseline is such an event, so Melody is not adaptable on a Raw MIDI project in v1 (release representation is not a pitch or volume change and is allowed on such events)',
        'moving an onset, adding a tie, merging a repeated attack, removing a rest, or moving a release that Final can already express',
        'moving a release whose sub-grid timing a keep decision claims is musically meaningful (Final UNSUPPORTED instead)',
      ]),
    }),

    final_six_role_reduction: freeze({
      version: 1,
      stage: 'FINAL_SIX_ROLE_REDUCTION_V1',
      plan_schema: 'mml-studio/final-six-role-reduction-plan@1',
      decision_schema: 'mml-studio/final-six-role-reduction-decision@1',
      ledger_schema: 'mml-studio/final-six-role-reduction-ledger@1',
      operations: freeze(['planFinalReduction', 'applyFinalReduction']),
      outcomes: freeze(['KEEP', 'REDISTRIBUTE', 'OVERFLOW', 'PENDING', 'OMIT']),
      actions: freeze(['KEEP', 'REDISTRIBUTE', 'DUPLICATE', 'ACCEPT_OVERFLOW', 'OMIT']),
      optional_inputs: freeze(['instrument_profile (mml-studio/instrument-profile@1, diagnostic only)']),
      notice: 'Resolves role and six-role capacity for a candidate whose roles are already accepted. Every source-supported baseline event is accounted for in exactly one outcome; overflow and pending material is retained and recorded. Preview before apply; stale plans are refused. Applying mints an atomic, content-addressed reduction revision and certifies no gate: Core3, Lead, Full6, Gate 8 and Gate 9 are re-opened for the new candidate.',
      refuses: freeze([
        'omitting source-supported material without an explicit, event-level, evidence-backed reviewer decision',
        'any Melody move, duplication into Melody or Lead removal whose Lead evidence the shared Lead grader does not pass',
        'delivering a Core3 the Gate 4 evaluator reports incomplete, whatever Chord3-Chord5 contain',
        'introducing a same-pitch overlap, m2, M7, m9 or cross-source conflict the input did not already have',
        'assigning unmapped General MIDI drum material to a pitched role',
        'removing music to fit a per-role MML character limit',
        'any pitch, octave, onset, duration or volume edit: those remain Mobile Adaptation (Gate 8)',
        'letting an instrument or timbre profile decide an outcome, resolve a PENDING or clear a gate',
      ]),
    }),

    gates: freeze({
      // The Acceptance gate axes this interface reports as such. It is NOT the
      // full list of gates that can block a Final: shared readiness has its own
      // pre-game gates, and every one of them reaches `blockers`. They are
      // listed beside it rather than folded into it, because an agent that
      // reads `axes` plus an empty `not_implemented_in_this_build` would
      // otherwise take it for a complete inventory and be surprised by a
      // refusal naming a gate it never saw.
      axes: GATE_NAMES,
      // Exactly `preGameGateNames` in `final/readiness.mjs`, in its order. It is
      // transcribed rather than imported so that this record can still be built
      // when the Canonical engines are unavailable, and a regression asserts the
      // two lists are equal so the transcription cannot drift.
      readiness_gates_that_block_final: freeze([
        'implementation', 'source', 'baseline', 'technical', 'microTiming',
        'core3', 'core3Completeness', 'leadDemotion', 'leadPromotion',
        'crossSourceHarmony', 'versionDrift', 'originalAudio', 'playerReadback',
        'mobileAdaptation', 'regression', 'pendingDecisions',
      ]),
      // Scoped to `axes` above, and every axis there is in exactly one of the
      // three lists below — a future Acceptance axis cannot be added without
      // saying which it is.
      settable_by_this_service: freeze(['technical', 'source', 'audio', 'player_readback', 'mobile_adaptation', 'regression']),
      // Review axes this service can move that are not Acceptance gate axes.
      // Listed because each is a separate question with its own operation, and
      // an agent that cannot see them has no way to learn how to answer them.
      review_axes_settable_by_this_service: freeze([
        { axis: 'core3_source_continuity', gate: 'Gate 4 (source continuity)', readiness_gate: 'core3', operation: 'approveCore3SourceChange' },
        { axis: 'core3_completeness', gate: 'Gate 4 (musical completeness)', readiness_gate: 'core3Completeness', operation: 'recordConfirmations.core3_completeness_reviewed' },
        { axis: 'original_audio_review', gate: 'Gate 7 (role / prominence / sustain / articulation / recording-structure review)', readiness_gate: 'originalAudio', operation: 'recordConfirmations.original_audio_reviewed' },
        // `reviewLeadEvidence` is the operation that answers a Lead axis with
        // resolved evidence: its classified score/audio citations name project
        // sources by `ref`, and it states how an audio classification was
        // established. A decision's own `leadEvidence` is graded the same way
        // at review and finalize, except that it states no audio method, so its
        // audio classification is a locator: on that path only an official
        // score the project holds, cited by `ref`, proves the role.
        { axis: 'lead_promotion', gate: 'Gate 3 (promotion into Melody)', readiness_gate: 'leadPromotion', operation: 'reviewLeadEvidence', decision_time_citation: LEAD_DECISION_TIME_CITATION },
        { axis: 'lead_demotion', gate: 'Gate 3 (demotion out of Melody)', readiness_gate: 'leadDemotion', operation: 'reviewLeadEvidence', decision_time_citation: LEAD_DECISION_TIME_CITATION },
      ]),
      // Each of these moves only through an explicit, candidate-bound,
      // evidence-backed review. Parser/emitter/test success never sets one, and
      // in_game remains a standing prohibition for this service.
      not_implemented_in_this_build: freeze([]),
      never_settable_by_this_service: freeze(['in_game']),
      notice: 'mobile_adaptation, regression, core3_completeness and audio can reach PASS only from explicit candidate-bound evidence-backed Gate 8 / Gate 9 / Gate 4 / Gate 7 reviews, each of which requires at least one evidence reference (audio additionally requires warning-free alignment evidence, and its review is bound to the active audio evidence revision); parser/emitter/test success does not upgrade them. The Core3 source-continuity axis moves only through per-change evidence-backed approvals, and the Lead axes only through the shared Lead grader re-run over a cited evidence record — a Lead approval is never a Core3 approval and neither axis of Gate 4 answers the other. in_game is recorded only by the user or a controlled target-client test. No parser, emitter, transport, job or model call can set in_game, so it stays PENDING.',
    }),

    audio_prescreen: freeze({
      report_schema: 'mml-studio/audio-prescreen-report@1',
      shadow_schema: 'mml-studio/audio-prescreen-shadow@1',
      operations: freeze(['audioPrescreen', 'prescreenShadowStatus', 'recordPrescreenShadow']),
      read_only_operations: freeze(['audioPrescreen', 'prescreenShadowStatus']),
      alternatives: '2-4: raw six-role MML, or a project candidate or Final artifact',
      // Checked before anything renders; a request over one is refused with
      // INVALID_REQUEST (the render-length refusal carries
      // details.reason RENDER_TOO_LONG and a suggested_bar_range, or a
      // later_bar_range when the first bar alone is over the limit).
      limits: freeze({
        max_mml_characters: PRESCREEN_LIMITS.maxMmlCharacters,
        max_bars: PRESCREEN_LIMITS.maxBars,
        max_render_seconds_per_alternative: PRESCREEN_LIMITS.maxRenderSeconds,
        render_seconds_are: `the whole performance, or with bar_range the window from ${PREROLL_SECONDS} s before its first bar to the end of its last bar; a longer song is prescreened section by section with bar_range`,
      }),
      metrics: freeze(['roughness (low/mid, source-inherited pairs excluded)', 'masking', 'smear', 'clipping', 'original_similarity (WAV/PCM recordings with active alignment only)']),
      verdicts: freeze(['OBVIOUS', 'NEEDS_HUMAN', 'NO_DIFFERENCE']),
      sound_bank: freeze({
        name: 'FluidR3Mono GM (SF3), MIT',
        sha256: 'cfcd66d89e8386823400eca64934b14fbea7bf48ba1f00d21189af1262794ec2',
        stored_in_repository_or_image: false,
        obtained: 'downloaded once on first need from one pinned URL, verified by SHA-256 and size, cached in the service data directory',
        is_game_timbre: false,
      }),
      sets_gates: false,
      never_sets: freeze(['audio (Gate 7)', 'player_readback (Gate 6)', 'in_game']),
      automatic_selection: false,
      notice: 'Machine prescreen evidence only. An OBVIOUS verdict selects, accepts and applies nothing; the draft rule that would let one be applied provisionally (docs/canonical-candidates/MACHINE_PRESCREEN_SELECTION.md) is unpublished.',
    }),

    audio: freeze({
      role: AUDIO_WORKER_ROLE,
      produces: freeze(['beat_seconds_control_points', 'tempo_drift_diagnostics', 'alignment_confidence', 'coverage_metrics']),
      does_not_produce: freeze(['exact_pitch_truth', 'vocal_identity', 'octave_correctness', 'lead_deletion_decision', 'final_arrangement_superiority']),
    }),

    cost: freeze({
      additional_recurring_cost: 'NONE',
      external_paid_services: 'NONE',
      llm_api_dependency: 'NONE',
      notice: 'This service calls no LLM API and holds no model provider credentials. Models are external MCP clients of this interface.',
    }),

    privacy: freeze({
      uploaded_assets_leave_this_service: false,
      reads_conversation_history: false,
      calls_external_analysis_services: false,
      // The one outbound request: the audio prescreen's pinned, public sound
      // bank, fetched without any project data and verified by SHA-256.
      outbound_downloads: freeze(['audio prescreen GM sound bank (pinned URL, SHA-256 verified, no project data sent)']),
      notice: 'Project assets are processed by this service and the existing Studio backend only.',
    }),
  });
}
