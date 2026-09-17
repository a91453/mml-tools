// Candidate review, confirmations and the Canonical gate axes.
//
// Status: IMPLEMENTATION NOTES. Every verdict reported here belongs to the
// module that produced it: version drift to `compare/version-drift.mjs`, Core3
// continuity to `arbitration/core3.mjs`, cross-source harmony to
// `arbitration/harmony.mjs`, Lead demotion to `arbitration/lead-demotion.mjs`,
// readiness to `final/readiness.mjs`, micro-timing to
// `canonical/micro-timing.mjs`. This module computes no verdict of its own and
// publishes no aggregate that could be mistaken for one.
//
// Why the review project is assembled rather than reviewed as stored
// -------------------------------------------------------------------
// `applyAcceptedArrangement` deliberately refuses to let a derived revision
// inherit gate evidence: `sourceComplete`, `audioAlignmentEvidence` and the
// baseline snapshot are stripped from the metadata a candidate carries forward,
// so no restored or imported parent can hand a fresh revision a gate result
// nobody recomputed. The consequence is that a G11-D candidate, as applied,
// carries no source-completeness confirmation and no audio evidence — and it
// must not, because both are assertions somebody has to make against the
// candidate that actually exists.
//
// So the review project is built here, from the candidate plus exactly the
// confirmations that were explicitly recorded, using the backend's own
// constructors (`createCanonicalProject`, `attachAudioAlignmentEvidence`). This
// is the same composition the Studio Web analysis performs, for the same
// reason. Nothing is asserted that a caller did not state, with a reason, in a
// recorded confirmation.
//
// A confirmation is bound to the thing it is about
// ------------------------------------------------
// A confirmation is a statement about one specific identity. Source
// completeness and the original-audio requirement are statements about the
// baseline that was loaded; version-drift review and player readback are
// statements about the candidate that was reviewed or read back. Each recorded
// confirmation therefore carries the baseline id it was made under and, for the
// candidate-scoped kinds, the candidate id it names. A confirmation whose
// identity no longer matches — the baseline was replaced, or a different
// candidate is being reviewed — is not an effective confirmation: it is kept
// on the record for the audit trail, reported as stale, and never feeds a
// gate. The pinned rules fail closed on silent version mixing (Gate 0) and
// require a player readback to be "actual, not assumed" (Gate 6); a PASS that
// outlived the material it described would be exactly that assumption.
//
// Player readback has three honest states here. `NOT_RUN` (the default), `N/A`
// with a stated reason when no preview or verification assets are used for the
// cue — the same state the Studio Web plane records for that situation, and
// the state Gate 6 makes conditional on such assets being used — and `PASS`,
// which may additionally name the SHA-256 of the exact MML that was read back;
// finalize honours such a PASS only for that MML. None of these is ever
// upgraded to another.
//
// What cannot be confirmed at all
// -------------------------------
// `in_game`. Not by this service, not by a transport, not by a model, not by a
// successful emit and not by a passing test. It is recorded only by the user or
// a controlled target-client test, and this build records none.

import { ERROR_CODES, GATE_STATUS, GATE_NOTICE, fail, isCandidateId, requireString } from './contracts.mjs';

const now = () => new Date().toISOString();

// Confirmations a caller may record, and what each one feeds.
const CONFIRMATIONS = Object.freeze({
  source_complete: 'readiness `source` gate: the sources loaded are confirmed to be the complete material for this song. Bound to the baseline.',
  version_drift_reviewed: 'readiness `versionDrift` gate: the divergence of this candidate from the accepted previous version has been reviewed. Bound to the candidate.',
  player_readback: 'readiness `playerReadback` gate: PASS (the emitted MML was read back in a player; may name the mml_sha256 that was read back), NOT_RUN, or N/A (no preview or verification assets are used for this cue, with the reason). Bound to the candidate.',
  original_audio_required: 'readiness `originalAudio` applicability. Setting it false states the song-specific workflow does not require original audio, and must say why. Bound to the baseline.',
});

// Which identity each confirmation is a statement about.
const CONFIRMATION_SCOPE = Object.freeze({
  source_complete: 'baseline',
  version_drift_reviewed: 'candidate',
  player_readback: 'candidate',
  original_audio_required: 'baseline',
});

const PLAYER_READBACK_VALUES = Object.freeze(['PASS', 'NOT_RUN', 'N/A']);
const SHA256_HEX = /^[0-9a-f]{64}$/;

// Why a recorded confirmation is not an effective one.
export const STALE_CONFIRMATION = Object.freeze({
  BASELINE_CHANGED: 'BASELINE_CHANGED',
  CANDIDATE_MISMATCH: 'CANDIDATE_MISMATCH',
  UNBOUND: 'UNBOUND',
});

export function createReviewService({ canonical, projects, intake, arrangement, store }) {
  const audioKey = (projectId, candidateId) => `audio:${projectId}:${candidateId}`;

  /**
   * The candidate as the readiness modules should see it.
   *
   * Confirmations and audio evidence are applied through the backend's own
   * constructors, never by mutating a stored object, so a project that would
   * not pass the Canonical IR constructors cannot be reviewed at all.
   */
  const reviewProject = (engines, candidate, { confirmations, audioReports }) => {
    let project = candidate;
    if (confirmations.source_complete?.value === true) {
      project = engines.canonical.createCanonicalProject({
        ...project,
        metadata: { ...project.metadata, sourceComplete: true },
      });
    }
    const audioErrors = [];
    for (const report of audioReports) {
      try { project = engines.audio.attachAudioAlignmentEvidence(project, report); }
      catch (error) { audioErrors.push(error.message); }
    }
    return { project, audioErrors };
  };

  const confirmationsOf = record => record.confirmations ?? {};

  /**
   * The confirmations that actually apply to this baseline and candidate.
   *
   * Everything else on the record is reported as stale with the reason, so a
   * reviewer can see that a statement exists and why it does not count here.
   */
  const effectiveConfirmations = (record, candidateId) => {
    const baselineId = record.baseline?.baseline_id ?? null;
    const effective = {};
    const stale = [];
    for (const [name, entry] of Object.entries(confirmationsOf(record))) {
      const boundBaseline = entry?.baseline_id ?? null;
      const boundCandidate = entry?.candidate_id ?? null;
      let reason = null;
      if (boundBaseline === null) reason = STALE_CONFIRMATION.UNBOUND;
      else if (boundBaseline !== baselineId) reason = STALE_CONFIRMATION.BASELINE_CHANGED;
      else if (CONFIRMATION_SCOPE[name] === 'candidate' && boundCandidate !== candidateId) reason = STALE_CONFIRMATION.CANDIDATE_MISMATCH;
      if (reason) stale.push({ name, reason, bound_baseline_id: boundBaseline, bound_candidate_id: boundCandidate, at: entry?.at ?? null });
      else effective[name] = entry;
    }
    return { effective: Object.freeze(effective), stale: Object.freeze(stale) };
  };

  const audioReportsFor = (projectId, candidateId) => {
    const stored = store.getJson(audioKey(projectId, candidateId));
    return Array.isArray(stored) ? stored : [];
  };

  /** Everything review and finalize both need, assembled once. */
  const context = async (owner, projectId, candidateId) => {
    // Checked by shape first, before the Canonical engines are loaded or the
    // baseline is read. A malformed identifier is refused for what it is rather
    // than producing whichever error the next step happens to raise, so a
    // caller is told the actual problem and nothing is done on its behalf.
    if (!isCandidateId(candidateId)) fail(ERROR_CODES.CANDIDATE_NOT_FOUND, 'Unknown candidate', { candidate_id: String(candidateId).slice(0, 96) });
    const engines = await canonical.engines();
    const { record, baseline, project: baselineProject } = await intake.project(owner, projectId);
    const { entry, application } = arrangement.loadCandidate(record, candidateId);
    const { effective: confirmations, stale } = effectiveConfirmations(record, candidateId);
    const audioReports = audioReportsFor(record.project_id, candidateId);
    const { project, audioErrors } = reviewProject(engines, application.candidate, { confirmations, audioReports });

    const parent = entry.parent_candidate_id
      ? arrangement.loadCandidate(record, entry.parent_candidate_id).application.candidate
      : null;

    // The rules release the candidate was accepted under, beside the one that
    // is loaded now. They are reported separately; finalize refuses when they
    // differ, because a candidate reviewed under one release is not a
    // candidate reviewed under another.
    const candidateRulesSnapshot = application.revision?.canonicalIdentity?.rules_snapshot_sha ?? null;
    const loadedRulesSnapshot = engines.emitterContract.canonicalIdentity().rules_snapshot_sha;

    return { engines, record, baseline, baselineProject, entry, application, confirmations, staleConfirmations: stale, audioReports, audioErrors, project, parent, candidateRulesSnapshot, loadedRulesSnapshot };
  };

  /** Record an explicit confirmation. Each one needs a stated reason. */
  function record(owner, projectId, confirmations, { candidateId = null } = {}) {
    const record = projects.load(owner, projectId);
    if (!confirmations || typeof confirmations !== 'object' || Array.isArray(confirmations)) {
      fail(ERROR_CODES.INVALID_REQUEST, 'confirmations must be an object');
    }
    const baselineId = record.baseline?.baseline_id ?? null;
    const next = { ...confirmationsOf(record) };
    for (const [name, input] of Object.entries(confirmations)) {
      if (name === 'in_game' || name === 'in_game_acceptance') {
        fail(ERROR_CODES.INVALID_REQUEST, 'in-game acceptance is not recordable through this interface. Only the user or a controlled target-client test can record it.', { gate: 'in_game' });
      }
      if (!Object.hasOwn(CONFIRMATIONS, name)) {
        fail(ERROR_CODES.INVALID_REQUEST, `Unknown confirmation: ${String(name).slice(0, 64)}`, { accepted: Object.keys(CONFIRMATIONS) });
      }
      if (!input || typeof input !== 'object' || Array.isArray(input)) fail(ERROR_CODES.INVALID_REQUEST, `confirmations.${name} must be an object`);
      const reason = requireString(input.reason, `confirmations.${name}.reason`, { max: 500 });
      // Every confirmation is a statement about loaded material. Without a
      // baseline there is nothing it could be about.
      if (!baselineId) fail(ERROR_CODES.SOURCE_INCOMPLETE, 'This project has no Source-Faithful Baseline to confirm anything about; run intake first.', { project_id: record.project_id });

      // Candidate-scoped confirmations name the candidate they are about:
      // the one being reviewed or finalized, or an explicit candidate_id when
      // recorded on their own. A contradiction between the two is refused.
      let boundCandidate = null;
      if (CONFIRMATION_SCOPE[name] === 'candidate') {
        const named = input.candidate_id === undefined || input.candidate_id === null ? null : input.candidate_id;
        if (named !== null && candidateId !== null && named !== candidateId) {
          fail(ERROR_CODES.INVALID_REQUEST, `confirmations.${name}.candidate_id names a different candidate than the one being reviewed.`, { candidate_id: candidateId });
        }
        boundCandidate = named ?? candidateId;
        if (boundCandidate === null) {
          fail(ERROR_CODES.INVALID_REQUEST, `confirmations.${name} is a statement about one candidate and must name it: record it through review or finalize, or supply candidate_id.`, { confirmation: name });
        }
        if (!isCandidateId(boundCandidate)) fail(ERROR_CODES.CANDIDATE_NOT_FOUND, 'Unknown candidate', { candidate_id: String(boundCandidate).slice(0, 96) });
        if (!record.candidates.some(candidate => candidate.candidate_id === boundCandidate)) {
          fail(ERROR_CODES.CANDIDATE_NOT_FOUND, 'Unknown candidate', { candidate_id: boundCandidate, project_id: record.project_id });
        }
      } else if (input.candidate_id !== undefined && input.candidate_id !== null) {
        fail(ERROR_CODES.INVALID_REQUEST, `confirmations.${name} is a statement about the baseline, not a candidate; candidate_id does not apply.`, { confirmation: name });
      }

      const binding = { baseline_id: baselineId, candidate_id: boundCandidate };

      if (name === 'player_readback') {
        const value = requireString(input.value, 'confirmations.player_readback.value', { max: 16 });
        if (!PLAYER_READBACK_VALUES.includes(value)) fail(ERROR_CODES.INVALID_REQUEST, 'player_readback may only be recorded as PASS, NOT_RUN or N/A.', { accepted: PLAYER_READBACK_VALUES });
        let mmlSha256 = null;
        if (input.mml_sha256 !== undefined && input.mml_sha256 !== null) {
          if (value !== 'PASS') fail(ERROR_CODES.INVALID_REQUEST, 'player_readback.mml_sha256 names the MML that was read back and applies to PASS only.');
          const digest = requireString(input.mml_sha256, 'confirmations.player_readback.mml_sha256', { max: 64 }).toLowerCase();
          if (!SHA256_HEX.test(digest)) fail(ERROR_CODES.INVALID_REQUEST, 'player_readback.mml_sha256 must be the SHA-256 (64 hex characters) of the exact MML that was read back.');
          mmlSha256 = digest;
        }
        next[name] = { value, reason, evidence: normalizeEvidence(input.evidence), at: now(), ...binding, ...(mmlSha256 ? { mml_sha256: mmlSha256 } : {}) };
        continue;
      }

      if (input.value !== true && input.value !== false) fail(ERROR_CODES.INVALID_REQUEST, `confirmations.${name}.value must be true or false`);
      // Source completeness cannot be asserted over a baseline whose own
      // adapters reported material they could not represent or inputs they
      // found incomplete. The evidence contradicts the claim, and a review is
      // not allowed to overrule it.
      if (name === 'source_complete' && input.value === true) {
        const unsupported = record.baseline?.unsupported ?? {};
        if (Object.keys(unsupported).length) {
          fail(ERROR_CODES.SOURCE_INCOMPLETE, 'The Source-Faithful Baseline reports unsupported source material, so source completeness cannot be confirmed.', { unsupported });
        }
        const incomplete = record.baseline?.incomplete_inputs ?? [];
        if (incomplete.length) {
          fail(ERROR_CODES.SOURCE_INCOMPLETE, 'The Source-Faithful Baseline reports incomplete inputs, so source completeness cannot be confirmed.', { incomplete_inputs: incomplete });
        }
      }
      next[name] = { value: input.value, reason, evidence: normalizeEvidence(input.evidence), at: now(), ...binding };
    }
    projects.save({ ...record, confirmations: next });
    return Object.freeze({ confirmations: Object.freeze({ ...next }) });
  }

  return Object.freeze({
    context,
    audioKey,
    record,
    effectiveConfirmations,

    /** Validate and record an audio alignment report against one candidate. */
    async attachAudioAlignment(owner, projectId, { candidateId, report }) {
      const engines = await canonical.engines();
      const record = projects.load(owner, projectId);
      const { application } = arrangement.loadCandidate(record, candidateId);
      if (!report || typeof report !== 'object' || Array.isArray(report)) fail(ERROR_CODES.INVALID_REQUEST, 'An audio alignment report is required');

      let validation;
      try { validation = engines.audio.validateAudioAlignmentReport(report, application.candidate); }
      catch (error) {
        return fail(ERROR_CODES.UNSUPPORTED_SOURCE, `Audio alignment report rejected: ${error.message}`, { candidate_id: candidateId });
      }

      const existing = audioReportsFor(record.project_id, candidateId);
      const sha256 = String(report.audio?.sha256 ?? '').toLowerCase();
      if (existing.some(entry => String(entry.audio?.sha256 ?? '').toLowerCase() === sha256)) {
        fail(ERROR_CODES.INVALID_REQUEST, 'An alignment report for this recording is already attached to this candidate.', { candidate_id: candidateId });
      }
      store.putJson(audioKey(record.project_id, candidateId), [...existing, report]);

      const evidence = {
        candidate_id: candidateId,
        audio_sha256: sha256,
        schema: report.schema,
        confidence: validation.metrics?.confidence ?? null,
        warnings: [...validation.warnings],
        attached_at: now(),
      };
      projects.save({ ...record, audio_evidence: [...record.audio_evidence, evidence] });
      return Object.freeze({
        evidence: Object.freeze(evidence),
        notice: 'Original-audio alignment is evidence about timing. It establishes no exact pitch truth, no vocal identity, no octave correctness, no Lead deletion decision and no arrangement superiority.',
      });
    },

    /**
     * Re-run the existing validation pipeline against an applied candidate.
     *
     * `reviewAppliedCandidate` answers over the candidate exactly as applied —
     * that is the integrity check, and it must see the stored application
     * untouched. The readiness that finalize keys on is computed separately
     * over the review project, because that is the project the confirmations
     * and audio evidence actually describe. Both are reported; neither is
     * silently substituted for the other.
     */
    async review(owner, projectId, { candidateId, confirmations = null } = {}) {
      if (confirmations) record(owner, projectId, confirmations, { candidateId });
      const ctx = await context(owner, projectId, candidateId);
      const { engines, application, baselineProject, confirmations: recorded, project, parent } = ctx;

      const leadDemotionReports = engines.arrangement.leadDemotionReportsFromApplication(application, baselineProject);
      const readinessInputs = {
        leadDemotionReports,
        versionDriftReviewed: recorded.version_drift_reviewed?.value === true,
        originalAudioRequired: recorded.original_audio_required?.value !== false,
        playerReadback: recorded.player_readback?.value ?? 'NOT_RUN',
        // Never a parameter a caller can reach. See the header.
        inGameAcceptance: 'PENDING',
      };

      const applied = engines.arrangement.reviewAppliedCandidate({
        application,
        baseline: baselineProject,
        acceptedPrevious: parent,
        ...readinessInputs,
      });

      const lineage = engines.compare.compareCandidateLineage({ sourceBaseline: baselineProject, acceptedPrevious: parent, candidate: project });
      const core3 = engines.core3.evaluateCore3Continuity({ baseline: baselineProject, candidate: project, approvedChanges: [] });
      const harmony = engines.harmony.analyzeCrossSourceHarmony(project);
      const readiness = engines.final.evaluateProjectReadiness({
        project,
        mmlValidation: null,
        core3Report: core3,
        harmonyReport: harmony,
        lineageReport: lineage,
        ...readinessInputs,
      });

      return {
        candidate_id: candidateId,
        baseline_id: ctx.baseline.baseline_id,
        parent_candidate_id: ctx.entry.parent_candidate_id,
        candidate_rules_snapshot_sha: ctx.candidateRulesSnapshot,
        loaded_rules_snapshot_sha: ctx.loadedRulesSnapshot,
        integrity: applied.integrity,
        application_status: applied.applicationStatus ?? null,
        lineage,
        core3,
        harmony,
        lead_demotion: leadDemotionReports,
        readiness,
        audio: {
          reports: ctx.audioReports.length,
          errors: ctx.audioErrors,
          evidence: ctx.record.audio_evidence.filter(entry => entry.candidate_id === candidateId),
        },
        confirmations: recorded,
        stale_confirmations: ctx.staleConfirmations,
        gates: gatesFrom(readiness),
        blockers: [...readiness.preGameBlocking, ...(ctx.candidateRulesSnapshot !== ctx.loadedRulesSnapshot ? ['canonical'] : [])],
        pending_decisions: (project.decisions ?? []).filter(decision => decision.status === 'pending').map(decision => decision.id),
        notice: 'Every verdict belongs to the module that produced it. Metrics here are diagnostic: source-supported music is never removed to make a number smaller, and REVIEWED is not a gate result.',
      };
    },

    gatesFrom,
  });
}

function normalizeEvidence(evidence) {
  if (evidence === undefined || evidence === null) return [];
  if (!Array.isArray(evidence)) fail(ERROR_CODES.INVALID_REQUEST, 'confirmation evidence must be an array of references');
  return evidence.map((item, index) => requireString(item, `evidence[${index}]`, { max: 500 }));
}

/**
 * The six independent gate axes, transcribed from the modules that own them.
 *
 * A transcription, not a computation. Each axis reads the readiness gate that
 * owns it; the axes readiness does not answer are reported as what they are.
 *
 *   technical   Readiness answers this from an MML validation it was given. At
 *               review time there is no emitted MML yet, so it is `NOT_RUN`.
 *               After emission the caller re-evaluates readiness with the
 *               emitted MML and passes that in, so the gate is always a
 *               readiness verdict over something readiness actually graded —
 *               never the Final emitter's own PASS copied across.
 *   mobile_adaptation  No gate implements it in this build. It stays `PENDING`
 *               rather than borrowing `technical`, because Gate 8 adaptation is
 *               a different question from serialization.
 *   in_game     `PENDING`, unconditionally and by construction.
 */
export function gatesFrom(readiness) {
  const status = name => readiness?.gates?.[name]?.status ?? GATE_STATUS.NOT_RUN;
  return Object.freeze({
    technical: status('technical'),
    source: status('source'),
    audio: status('originalAudio'),
    player_readback: status('playerReadback'),
    mobile_adaptation: GATE_STATUS.PENDING,
    in_game: GATE_STATUS.PENDING,
    notice: GATE_NOTICE,
  });
}

export { CONFIRMATIONS, CONFIRMATION_SCOPE, PLAYER_READBACK_VALUES };
