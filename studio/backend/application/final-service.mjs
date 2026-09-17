// Final delivery orchestration and artifacts.
//
// Status: IMPLEMENTATION NOTES. This is wiring, not Final logic. The order —
// readiness, then micro-gap classification and enforcement, then the optional
// Technical Timing Repair, then serialization, then round-trip readback — is
// the order `final/mml-emitter.mjs` already implements internally. Calling it
// once with the right options is the whole of finalize; re-implementing any
// step here would create a second Final policy, which is exactly what this
// layer exists to prevent.
//
// Technical Timing Repair stays explicitly opt-in
// -----------------------------------------------
// `DEFAULT_EMIT_OPTIONS.technicalTimingRepair` is `false` because the repair
// transforms the musical candidate, and that has to be a caller's decision
// rather than a side effect of asking for MML. Asking this service to finalize
// does not turn it on: the flag is passed through exactly as supplied and
// defaults to `false`. There is no `auto` mode, because introducing one would
// change what an existing `finalize` call means.
//
// A Final artifact is not an acceptance
// -------------------------------------
// An emitter PASS means the candidate was serialized exactly and re-parsed to
// identical semantics under the authoritative Final parser. It certifies no
// source completeness, no audio alignment, no player readback, no Mobile
// adaptation and no in-game acceptance. The artifact carries the gate axes
// beside the MML so that reading one can never be mistaken for the other.

import { ERROR_CODES, OPERATION_STATUS, fail } from './contracts.mjs';
import { sha256Of } from './store.mjs';
import { gatesFrom } from './review-service.mjs';

const now = () => new Date().toISOString();
const encoder = new TextEncoder();

export const FINAL_ARTIFACT_SCHEMA = 'mabinogi-mobile-mml-studio/application-final-artifact@1';

// Readiness gates the Final emitter itself grades. Requiring `technical` before
// emission would be circular: generation could never start, so the output that
// gate reads could never exist. Everything else stays blocking — source
// completeness, the baseline snapshot, micro-timing, Core3, Lead demotion,
// cross-source harmony, version drift, original audio, player readback and
// pending arbitration all still have to be satisfied before a single character
// is emitted.
export const PRE_EMISSION_EXEMPT_GATES = Object.freeze(['technical']);

export function createFinalService({ canonical, projects, review, store }) {
  const artifactKey = (projectId, artifactId) => `artifact:${projectId}:${artifactId}`;

  const fileArtifact = (record, artifact) => {
    const body = JSON.stringify(artifact);
    const artifactId = `art_${sha256Of(encoder.encode(body))}`;
    const entry = {
      artifact_id: artifactId,
      project_id: record.project_id,
      type: artifact.type,
      candidate_id: artifact.candidate_id,
      created_at: artifact.created_at,
      size: encoder.encode(body).byteLength,
      media_type: 'application/json',
    };
    store.putJson(artifactKey(record.project_id, artifactId), { ...artifact, artifact_id: artifactId });
    projects.save({
      ...record,
      artifacts: [...record.artifacts.filter(existing => existing.artifact_id !== artifactId), entry],
    });
    return { artifactId, entry };
  };

  return Object.freeze({
    /**
     * Candidate → Final MML artifact, or a structured refusal.
     *
     * Returns rather than throws when a Canonical gate blocks emission: a
     * blocked finalize is an answer about the song, not a failure of the call,
     * and the two must not arrive as the same thing. `operation` says whether
     * the orchestration ran; `gates` says what the song satisfies.
     */
    async finalize(owner, projectId, { candidateId, technicalTimingRepair = false, confirmations = null } = {}) {
      if (technicalTimingRepair !== true && technicalTimingRepair !== false) {
        fail(ERROR_CODES.INVALID_REQUEST, 'technical_timing_repair must be true or false. There is no automatic mode: the repair transforms the musical candidate and stays an explicit opt-in.');
      }
      if (confirmations) review.record(owner, projectId, confirmations);

      const ctx = await review.context(owner, projectId, candidateId);
      const { engines, record, baseline, entry, application, baselineProject, project, parent, confirmations: recorded } = ctx;

      const leadDemotionReports = engines.arrangement.leadDemotionReportsFromApplication(application, baselineProject);
      const lineage = engines.compare.compareCandidateLineage({ sourceBaseline: baselineProject, acceptedPrevious: parent, candidate: project });
      const core3 = engines.core3.evaluateCore3Continuity({ baseline: baselineProject, candidate: project, approvedChanges: [] });
      const harmony = engines.harmony.analyzeCrossSourceHarmony(project);
      const readiness = engines.final.evaluateProjectReadiness({
        project,
        mmlValidation: null,
        core3Report: core3,
        harmonyReport: harmony,
        lineageReport: lineage,
        leadDemotionReports,
        versionDriftReviewed: recorded.version_drift_reviewed?.value === true,
        originalAudioRequired: recorded.original_audio_required?.value !== false,
        playerReadback: recorded.player_readback?.value ?? 'NOT_RUN',
        inGameAcceptance: 'PENDING',
      });

      const blocked = readiness.preGameBlocking.filter(name => !PRE_EMISSION_EXEMPT_GATES.includes(name));
      const identity = {
        project_id: record.project_id,
        baseline_id: baseline.baseline_id,
        candidate_id: candidateId,
        parent_candidate_id: entry.parent_candidate_id,
        revision_index: entry.revision_index,
      };

      if (blocked.length) {
        return {
          operation: OPERATION_STATUS.BLOCKED,
          code: ERROR_CODES.FINALIZATION_BLOCKED,
          ...identity,
          artifact_id: null,
          mml: null,
          emit_status: null,
          technical_timing_repair: { requested: technicalTimingRepair, applied: false },
          gates: gatesFrom(readiness),
          blockers: blocked,
          readiness,
          notice: 'Nothing was emitted. Required Canonical gates are not satisfied, and the Final emitter was not run.',
        };
      }

      // One call. The emitter owns micro-gap enforcement, the optional repair,
      // serialization and the round-trip readback, in that order.
      const emitted = engines.final.emitFinalMml(project, { readiness, technicalTimingRepair });
      const emitStatus = emitted.status;
      const passed = emitStatus === engines.final.EMIT_STATUS.PASS;
      // The emitter reports no repair block at all when the repair was not
      // requested. The opt-in state is exactly what a caller needs to see, so
      // it is always reported rather than left as a null a reader has to guess
      // the meaning of.
      const repairReport = emitted.technicalTimingRepair ?? {
        requested: technicalTimingRepair,
        applied: false,
        status: null,
        reason: technicalTimingRepair ? 'the emitter reported no repair block' : 'Technical Timing Repair was not requested',
      };
      const emitGates = gatesFrom(readiness, { emit: emitStatus, emitPassStatus: engines.final.EMIT_STATUS.PASS });

      const artifact = {
        schema: FINAL_ARTIFACT_SCHEMA,
        type: 'final_mml',
        ...identity,
        created_at: now(),
        emit_status: emitStatus,
        mml: passed ? emitted.combinedMml : null,
        roles: emitted.roles,
        character_counts: emitted.characterCounts,
        micro_gap: emitted.microGap,
        technical_timing_repair: repairReport,
        round_trip: emitted.roundTrip,
        diagnostics: emitted.diagnostics,
        warnings: emitted.diagnostics.filter(item => item.severity === engines.final.DIAGNOSTIC_SEVERITY.WARNING),
        readiness_summary: {
          candidate_ready: readiness.candidateReady,
          pre_game_blocking: [...readiness.preGameBlocking],
          gates: Object.fromEntries(Object.entries(readiness.gates).map(([name, gate]) => [name, gate.status])),
        },
        gates: emitGates,
        remaining_pending_gates: Object.entries(emitGates)
          .filter(([name, status]) => name !== 'notice' && status !== 'PASS' && status !== 'N/A')
          .map(([name]) => name),
        canonical: await canonical.provenance(),
        emitter_notice: emitted.notice,
        acceptance_notice: 'A Final artifact is an implementation result. Producing it does not make the song VALIDATED and never implies IN_GAME_ACCEPTED.',
      };

      const { artifactId } = fileArtifact(projects.load(owner, projectId), artifact);

      return {
        operation: passed ? OPERATION_STATUS.SUCCEEDED : OPERATION_STATUS.FAILED,
        code: passed ? null : ERROR_CODES.FINALIZATION_BLOCKED,
        ...identity,
        artifact_id: artifactId,
        mml: artifact.mml,
        emit_status: emitStatus,
        technical_timing_repair: repairReport,
        micro_gap: emitted.microGap,
        round_trip: emitted.roundTrip,
        character_counts: emitted.characterCounts,
        diagnostics: emitted.diagnostics,
        gates: artifact.gates,
        blockers: [],
        readiness,
        notice: artifact.acceptance_notice,
      };
    },

    /** One stored artifact, by id. */
    get(owner, projectId, artifactId) {
      const record = projects.load(owner, projectId);
      const entry = record.artifacts.find(item => item.artifact_id === artifactId);
      if (!entry) fail(ERROR_CODES.ARTIFACT_NOT_FOUND, 'Unknown artifact', { artifact_id: String(artifactId).slice(0, 96) });
      const body = store.getJson(artifactKey(record.project_id, artifactId));
      if (!body) fail(ERROR_CODES.ARTIFACT_NOT_FOUND, 'The stored artifact is no longer available', { artifact_id: artifactId });
      return Object.freeze(body);
    },

    /**
     * An artifact named by id alone, scoped to the owner's own projects.
     *
     * An artifact id from another owner is not found rather than refused, for
     * the same reason a project id is.
     */
    find(owner, artifactId) {
      if (typeof artifactId !== 'string' || !/^art_[0-9a-f]{64}$/.test(artifactId)) {
        fail(ERROR_CODES.ARTIFACT_NOT_FOUND, 'Unknown artifact', { artifact_id: String(artifactId).slice(0, 96) });
      }
      for (const record of projects.list(owner)) {
        const body = store.getJson(artifactKey(record.project_id, artifactId));
        if (body) return Object.freeze(body);
      }
      return fail(ERROR_CODES.ARTIFACT_NOT_FOUND, 'Unknown artifact', { artifact_id: artifactId });
    },
  });
}
