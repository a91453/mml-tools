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

const freeze = Object.freeze;

export const INTERFACE_VERSION = 'studio-application/v1';

// Named so a report can cite it without re-deriving the claim.
export const AUDIO_WORKER_ROLE = 'original-audio-evidence-alignment';

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
      candidate_review: true,
      version_drift_comparison: true,
      readiness_evaluation: true,
      micro_gap_enforcement: true,
      technical_timing_repair: true,
      final_emission: true,
      round_trip_readback: true,
      legacy_technical_validation: true,
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

    gates: freeze({
      axes: GATE_NAMES,
      settable_by_this_service: freeze(['technical', 'source', 'audio', 'player_readback', 'mobile_adaptation']),
      // Gate 8 is settable only through the explicit candidate-bound,
      // evidence-backed review confirmation. Parser/emitter success never sets
      // it. in_game remains a standing prohibition for this service.
      not_implemented_in_this_build: freeze([]),
      never_settable_by_this_service: freeze(['in_game']),
      notice: 'mobile_adaptation can reach PASS only from an explicit candidate-bound evidence-backed Gate 8 review; parser/emitter success does not upgrade it. in_game is recorded only by the user or a controlled target-client test. No parser, emitter, transport, job or model call can set in_game, so it stays PENDING.',
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
      notice: 'Project assets are processed by this service and the existing Studio backend only.',
    }),
  });
}
