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
// adaptation and no in-game acceptance. Mobile adaptation is a separate
// evidence-backed readiness gate; serializer success never substitutes for it.
// The artifact carries the gate axes
// beside the MML so that reading one can never be mistaken for the other.

import { ERROR_CODES, GATE_STATUS, OPERATION_STATUS, fail, requireString } from './contracts.mjs';
import { sha256Of } from './store.mjs';
import { gatesFrom } from './review-service.mjs';
import { migrateMachineDeliveryState } from './machine-delivery-migration.mjs';

const now = () => new Date().toISOString();
const encoder = new TextEncoder();

// Source-confirmed bar-closure inputs for the authoritative Final parser. The
// parser refuses to guess how a piece that does not end on a bar line closes
// (`末小節剩N拍，請依來源明確填寫末小節長度`), exactly as the legacy technical
// check does; a caller states the pickup and final partial bar from the source,
// in the same grammar the legacy tools accept. They are validated here, never
// derived, and recorded in the artifact beside the meter map that was used.
const BAR_INPUT = /^\d+(?:\/\d+|\.\d{1,9})?$/;
function barInput(value, label) {
  // Absent means "the piece ends on a bar line". An empty string is not that
  // statement; it is a malformed one, and is refused rather than read as absent.
  if (value === undefined || value === null) return null;
  const text = requireString(value, label, { max: 32 });
  if (/\d{10}/.test(text) || !BAR_INPUT.test(text)) {
    fail(ERROR_CODES.INVALID_REQUEST, `${label} must be a non-negative integer, decimal or fraction of beats, confirmed from the source.`);
  }
  return text;
}

const mmlDigest = mml => sha256Of(encoder.encode(mml));

export const FINAL_ARTIFACT_SCHEMA = 'mabinogi-mobile-mml-studio/application-final-artifact@1';

// Readiness gates the Final emitter itself grades. Requiring `technical` before
// emission would be circular: generation could never start, so the output that
// gate reads could never exist. Everything else stays blocking — source
// completeness, the baseline snapshot, micro-timing, Core3, Lead demotion,
// Lead promotion, cross-source harmony, version drift, original audio, player readback and
// pending arbitration all still have to be satisfied before a single character
// is emitted.
export const PRE_EMISSION_EXEMPT_GATES = Object.freeze(['technical']);

export function createFinalService({ canonical, projects, review, store }) {
  const artifactKey = (projectId, artifactId) => `artifact:${projectId}:${artifactId}`;

  const fileArtifact = (record, artifact, { inputFingerprint = null, effectAttemptId = null } = {}) => {
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
      // Internal provenance, written in the same record write as the entry,
      // so a stop between filing the artifact and recording what produced it
      // is not a state this can reach. Neither field takes any part in the
      // artifact's identity -- the id is the SHA-256 of the body and neither
      // is in the body -- and neither is a Canonical rule.
      //
      //   input_fingerprint   which explicit input the caller was applying.
      //                       For audit and for rerun decisions.
      //   effect_attempt_id   WHICH ATTEMPT at a step produced this record.
      //                       Exact: a second attempt, by this run or another,
      //                       carries a different one however identical its
      //                       inputs. This is what recovery matches on.
      input_fingerprint: inputFingerprint,
      effect_attempt_id: effectAttemptId,
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
     * File one artifact against a project record.
     *
     * Exposed so the run orchestrator can store its own run report without
     * owning a second copy of the artifact key convention, the id derivation or
     * the project-record bookkeeping. It files an artifact; it can neither
     * modify nor replace one that exists, because the id is the SHA-256 of the
     * body — a different body is a different artifact, and an identical body is
     * the same artifact filed again. A `final_mml` artifact's content and
     * identity are therefore unreachable from here by construction.
     */
    fileArtifact,

    /**
     * Candidate → Final MML artifact, or a structured refusal.
     *
     * Returns rather than throws when a Canonical gate blocks emission: a
     * blocked finalize is an answer about the song, not a failure of the call,
     * and the two must not arrive as the same thing. `operation` says whether
     * the orchestration ran; `gates` says what the song satisfies.
     */
    async finalize(owner, projectId, { candidateId, technicalTimingRepair = false, confirmations = null, pickup = null, finalPartial = null, inputFingerprint = null, effectAttemptId = null } = {}) {
      if (technicalTimingRepair !== true && technicalTimingRepair !== false) {
        fail(ERROR_CODES.INVALID_REQUEST, 'technical_timing_repair must be true or false. There is no automatic mode: the repair transforms the musical candidate and stays an explicit opt-in.');
      }
      const barInputs = { pickup: barInput(pickup, 'pickup'), final_partial: barInput(finalPartial, 'final_partial') };
      if (confirmations) review.record(owner, projectId, confirmations, { candidateId });

      const ctx = await review.context(owner, projectId, candidateId);
      const { engines, record, baseline, entry, application, baselineProject, project, parent, confirmations: recorded } = ctx;
      const core3ApprovedChanges = ctx.core3Approvals;

      const identity = {
        project_id: record.project_id,
        baseline_id: baseline.baseline_id,
        candidate_id: candidateId,
        parent_candidate_id: entry.parent_candidate_id,
        revision_index: entry.revision_index,
      };
      const refused = (blockers, extra, notice) => ({
        operation: OPERATION_STATUS.BLOCKED,
        code: ERROR_CODES.FINALIZATION_BLOCKED,
        ...identity,
        artifact_id: null,
        mml: null,
        emit_status: null,
        technical_timing_repair: { requested: technicalTimingRepair, applied: false },
        final_bar: barInputs,
        blockers,
        ...extra,
        notice,
      });

      // The stored application must agree with itself and with the project's
      // own Source-Faithful Baseline before anything is emitted from it. A
      // record that was edited, truncated or restored from another pipeline is
      // reported as inconsistent, exactly as review reports it, rather than
      // being trusted as current.
      const integrity = engines.arrangement.applicationIntegrity(application, baselineProject);
      if (!integrity.ok || integrity.against !== 'baseline') {
        return refused(['integrity'], { integrity, gates: gatesFrom(null), readiness: null }, 'Nothing was emitted. The stored candidate does not agree with itself or with the Source-Faithful Baseline, so it cannot be finalized.');
      }
      // A candidate accepted under one Published Canonical release is not a
      // candidate reviewed under another. G11-D already refuses to chain onto
      // it; delivery refuses for the same reason.
      if (ctx.candidateRulesSnapshot !== ctx.loadedRulesSnapshot) {
        return refused(['canonical'], {
          candidate_rules_snapshot_sha: ctx.candidateRulesSnapshot,
          loaded_rules_snapshot_sha: ctx.loadedRulesSnapshot,
          gates: gatesFrom(null),
          readiness: null,
        }, 'Nothing was emitted. This candidate was accepted under a different Published Canonical rules snapshot than the one loaded now; re-run the suggestion and decisions under the loaded release.');
      }

      // Same lineage recovery as review: evidence for a Lead move made in an
      // earlier revision is recovered from that revision and re-graded against
      // this candidate. A previous PASS is never inherited. The same
      // candidate-bound Lead evidence re-reviews reach it too, from the same
      // `review.context()` -- so a citation a reviewer re-supplied is graded
      // here by the same shared gate, and Finalize cannot be satisfied by a
      // path review does not see, or refuse one review accepts.
      const leadReportInputs = { applications: ctx.applicationLineage, baseline: baselineProject, candidate: application.candidate, freshReviews: ctx.gradedLeadEvidenceReviews };
      const leadDemotionReports = engines.arrangement.leadDemotionReportsFromLineage(leadReportInputs);
      const leadPromotionReports = engines.arrangement.leadPromotionReportsFromLineage(leadReportInputs);
      const lineage = engines.compare.compareCandidateLineage({ sourceBaseline: baselineProject, acceptedPrevious: parent, candidate: project });
      // Validated, candidate-bound Core3 approvals, recorded through
      // `approveCore3SourceChange` and re-checked against this candidate when
      // they were recorded. Finalize used to pass `[]` here, which left a
      // legitimate reviewed Core3 source change blocked by
      // UNAPPROVED_CORE3_SOURCE_CHANGE with no way to clear it.
      const core3 = engines.core3.evaluateCore3Continuity({ baseline: baselineProject, candidate: project, approvedChanges: core3ApprovedChanges });
      // Gate 4's own question. A clean continuity audit above does not answer it.
      const core3Completeness = engines.core3Completeness.evaluateCore3Completeness({
        candidate: project,
        reviewed: recorded.core3_completeness_reviewed?.value === true,
      });
      const harmony = engines.harmony.analyzeCrossSourceHarmony(project);
      // One set of readiness inputs, evaluated twice: once before emission with
      // no MML to grade, and once after with the emitted string. Nothing else
      // differs between the two calls.
      const readinessInputs = {
        project,
        core3Report: core3,
        core3CompletenessReport: core3Completeness,
        harmonyReport: harmony,
        lineageReport: lineage,
        leadDemotionReports,
        leadPromotionReports,
        versionDriftReviewed: recorded.version_drift_reviewed?.value === true,
        originalAudioRequired: recorded.original_audio_required?.value !== false,
        originalAudioReviewed: recorded.original_audio_reviewed?.value === true,
        playerReadback: recorded.player_readback?.value ?? 'NOT_RUN',
        mobileAdaptation: recorded.mobile_adaptation_reviewed?.value === true ? 'PASS' : 'PENDING',
        regressionReviewed: recorded.regression_reviewed?.value === true,
        inGameAcceptance: 'PENDING',
      };
      const readiness = engines.final.evaluateProjectReadiness({ ...readinessInputs, mmlValidation: null });

      const machineProjection = readiness.machineDelivery;
      const blocked = machineProjection?.authoritative === true
        ? machineProjection.blocking.map(entry => entry.gate).filter(name => !PRE_EMISSION_EXEMPT_GATES.includes(name))
        : readiness.preGameBlocking.filter(name => !PRE_EMISSION_EXEMPT_GATES.includes(name));

      if (blocked.length) {
        return refused(blocked, { gates: gatesFrom(readiness), readiness }, 'Nothing was emitted. Required Canonical gates are not satisfied, and the Final emitter was not run.');
      }

      // One call. The emitter owns micro-gap enforcement, the optional repair,
      // serialization and the round-trip readback, in that order.
      const emitted = engines.final.emitFinalMml(project, { readiness, technicalTimingRepair });
      const emitStatus = emitted.status;
      const passed = emitStatus === engines.final.EMIT_STATUS.PASS;

      // The technical gate asks whether the emitted MML is valid under the
      // authoritative Final parser. Before emission there was no MML, so
      // readiness could only report NOT_RUN. Now there is one, so readiness is
      // asked again with it — rather than the emitter's own PASS being copied
      // across as if it were the readiness answer. The meter map comes from the
      // candidate's own meter events, never from a caller.
      const meterText = (project.meterEvents ?? [])
        .map(event => `${event.beat} ${event.numerator}/${event.denominator}`)
        .join('\n');
      const mmlValidation = passed && meterText
        ? engines.mml.validateMML(emitted.combinedMml, { meterText, pickup: barInputs.pickup ?? undefined, finalPartial: barInputs.final_partial ?? undefined })
        : null;
      // A player readback PASS that named the MML it read back counts only for
      // that exact MML. The emitted string is now known, so the claim can be
      // checked; a readback of some other string is not a readback of this one
      // and leaves the gate NOT_RUN.
      const readback = recorded.player_readback ?? null;
      const emittedDigest = passed ? mmlDigest(emitted.combinedMml) : null;
      const readbackMatched = readback?.value === 'PASS' && readback.mml_sha256
        ? readback.mml_sha256 === emittedDigest
        : null;
      const playerReadbackBinding = {
        recorded: readback?.value ?? 'NOT_RUN',
        expected_mml_sha256: readback?.mml_sha256 ?? null,
        emitted_mml_sha256: emittedDigest,
        matched: readbackMatched,
      };
      // Deliberately the post-emission readiness, including when the emitter
      // passed and the parser then disagreed: two modules contradicting each
      // other is reported as the unsatisfied gate it is, not resolved in favour
      // of the more convenient one.
      const finalReadiness = passed
        ? engines.final.evaluateProjectReadiness({
          ...readinessInputs,
          playerReadback: readbackMatched === false ? 'NOT_RUN' : readinessInputs.playerReadback,
          mmlValidation,
        })
        : readiness;
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
      const emitGates = gatesFrom(finalReadiness);

      // Two independent facts, kept independent and both required.
      //
      //   `passed`               the Final emitter's own result.
      //   `technicalSatisfied`   the authoritative Final parser's verdict on
      //                          the string the emitter produced, as readiness
      //                          graded it.
      //
      // Delivery requires both. An emitter PASS that the parser then
      // contradicts is not a Final: shipping it would hand a caller MML and an
      // artifact carrying `technical: FAIL`, which is the layered gate model
      // collapsing into the emitter's single opinion. Anything short of PASS
      // blocks, NOT_RUN included — an emitted string nobody graded is not a
      // graded one, and this fails closed.
      const technicalSatisfied = emitGates.technical === GATE_STATUS.PASS;
      // Post-emission readiness is the whole verdict, not only its technical
      // row. The readback gate can also change after emission — a readback
      // PASS that named a different MML digest falls back to NOT_RUN once the
      // emitted string is known — and a Final that readiness calls not ready
      // is not delivered whichever gate said so.
      const machineDelivery = finalReadiness.machineDelivery;
      const gatesSatisfied = machineDelivery?.authoritative === true
        ? machineDelivery.ready
        : finalReadiness.preGameBlocking.length === 0;
      const delivered = passed && technicalSatisfied && gatesSatisfied;

      // Why the two are still reported separately below rather than reconciled:
      // the disagreement is the finding. A reader has to be able to see that
      // the emitter said PASS and the parser did not.
      const technicalValidation = mmlValidation === null
        ? { run: false, reason: passed ? 'the candidate declares no meter events, so the emitted MML could not be re-validated' : 'nothing was emitted' }
        : { run: true, ok: mmlValidation.ok, error_count: mmlValidation.errors.length };

      const artifact = {
        schema: FINAL_ARTIFACT_SCHEMA,
        type: 'final_mml',
        ...identity,
        created_at: now(),
        emit_status: emitStatus,
        mml: delivered ? emitted.combinedMml : null,
        roles: emitted.roles,
        character_counts: emitted.characterCounts,
        micro_gap: emitted.microGap,
        technical_timing_repair: repairReport,
        final_bar: { ...barInputs, meter_text: meterText },
        player_readback_binding: playerReadbackBinding,
        candidate_rules_snapshot_sha: ctx.candidateRulesSnapshot,
        round_trip: emitted.roundTrip,
        diagnostics: emitted.diagnostics,
        warnings: emitted.diagnostics.filter(item => item.severity === engines.final.DIAGNOSTIC_SEVERITY.WARNING),
        readiness_summary: {
          candidate_ready: finalReadiness.candidateReady,
          pre_game_blocking: [...finalReadiness.preGameBlocking],
          gates: Object.fromEntries(Object.entries(finalReadiness.gates).map(([name, gate]) => [name, gate.status])),
          technical_validation: technicalValidation,
          machine_delivery: machineDelivery,
        },
        gates: emitGates,
        machine_delivery: machineDelivery,
        remaining_pending_gates: Object.entries(emitGates)
          .filter(([name, status]) => name !== 'notice' && status !== 'PASS' && status !== 'N/A')
          .map(([name]) => name),
        canonical: await canonical.provenance(),
        emitter_notice: emitted.notice,
        acceptance_notice: 'A Final artifact is an implementation result. Producing it does not make the song VALIDATED and never implies IN_GAME_ACCEPTED.',
      };

      // No artifact is filed unless the Final was actually delivered. A stored
      // `final_mml` artifact is the record of a Final that happened; minting
      // one for an emission the parser rejected would leave a retrievable
      // artifact that later reads as a delivered Final.
      const artifactId = delivered ? fileArtifact(projects.load(owner, projectId), artifact, { inputFingerprint, effectAttemptId }).artifactId : null;

      return {
        // A technical gate that did not pass after emission is a Canonical
        // block on delivery, not a crash of the orchestration: the call ran and
        // produced a real answer about the song, which is what `blocked` means
        // everywhere else in this interface.
        operation: delivered ? OPERATION_STATUS.SUCCEEDED : (passed ? OPERATION_STATUS.BLOCKED : OPERATION_STATUS.FAILED),
        code: delivered ? null : ERROR_CODES.FINALIZATION_BLOCKED,
        ...identity,
        artifact_id: artifactId,
        mml: artifact.mml,
        emit_status: emitStatus,
        technical_timing_repair: repairReport,
        final_bar: artifact.final_bar,
        player_readback_binding: playerReadbackBinding,
        candidate_rules_snapshot_sha: ctx.candidateRulesSnapshot,
        micro_gap: emitted.microGap,
        round_trip: emitted.roundTrip,
        character_counts: emitted.characterCounts,
        diagnostics: emitted.diagnostics,
        gates: artifact.gates,
        machine_delivery: machineDelivery,
        // `technical` is exempt only *before* emission, where requiring it
        // would be circular. Past that point there is an emitted string the
        // parser has graded, so it is an ordinary blocking gate again and
        // filtering it out here would hide the one blocker that matters.
        blockers: machineDelivery?.authoritative === true
          ? machineDelivery.blocking.map(entry => entry.gate)
          : [...finalReadiness.preGameBlocking],
        // Carried in the response, not only in the artifact, because a blocked
        // finalize files no artifact and the contradiction still has to be
        // readable from what the caller was handed.
        technical_validation: technicalValidation,
        readiness: finalReadiness,
        notice: delivered
          ? artifact.acceptance_notice
          : nonDeliveryNotice({ passed, emitStatus, mmlValidation, readbackMatched }),
      };
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
        if (body) {
          if (body.type !== 'final_mml') return Object.freeze(body);
          const migrated = migrateMachineDeliveryState(body, { canonical: body.canonical ?? null });
          return Object.freeze(migrated.record);
        }
      }
      return fail(ERROR_CODES.ARTIFACT_NOT_FOUND, 'Unknown artifact', { artifact_id: artifactId });
    },
  });
}

// Why nothing was delivered, said for the path that was actually taken. One
// sentence for every non-delivery would tell a caller the parser rejected MML
// the parser never saw.
function nonDeliveryNotice({ passed, emitStatus, mmlValidation, readbackMatched }) {
  if (!passed) return `No Final was delivered. The Final emitter reported ${emitStatus} for this candidate, so nothing was emitted and the authoritative Final parser did not run. in_game is unaffected and remains PENDING.`;
  if (mmlValidation === null) return 'No Final was delivered. The candidate declares no meter events, so the emitted MML could not be re-validated under the authoritative Final parser; the technical gate stays NOT_RUN and no MML and no artifact were returned. in_game is unaffected and remains PENDING.';
  if (!mmlValidation.ok) return 'No Final was delivered. The emitted MML did not satisfy the technical gate under the authoritative Final parser, so no MML and no artifact were returned. If the piece does not end on a bar line, state the source-confirmed pickup and final_partial. in_game is unaffected and remains PENDING.';
  if (readbackMatched === false) return 'No Final was delivered. The recorded player readback names a different MML than the one emitted for this candidate, so the readback gate stays NOT_RUN and no MML and no artifact were returned. in_game is unaffected and remains PENDING.';
  return 'No Final was delivered. A required gate did not pass after emission, so no MML and no artifact were returned. in_game is unaffected and remains PENDING.';
}
