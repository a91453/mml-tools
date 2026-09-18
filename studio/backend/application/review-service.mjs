// Candidate review, confirmations and the Canonical gate axes.
//
// Status: IMPLEMENTATION NOTES. Every verdict reported here belongs to the
// module that produced it: version drift to `compare/version-drift.mjs`, Core3
// continuity to `arbitration/core3.mjs`, cross-source harmony to
// `arbitration/harmony.mjs`, Lead demotion/promotion to the shared
// `arbitration/lead-demotion.mjs` role grader,
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
// baseline that was loaded; version-drift review, Mobile adaptation review and
// player readback are statements about the candidate that was reviewed. Each recorded
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
  mobile_adaptation_reviewed: 'readiness `mobileAdaptation` gate: the candidate was reviewed against Acceptance Gate 8 and any Mobile adaptation (or the conclusion that none is needed) is minimal, role-preserving and evidence-backed. Bound to the candidate.',
  regression_reviewed: 'readiness `regression` gate: the candidate was compared against the Source-Faithful Baseline and accepted previous version when present, with Lead/Core3/source drift and available historical regressions explicitly reviewed. Bound to the candidate.',
  core3_completeness_reviewed: 'readiness `core3Completeness` gate: the Core3 the evaluator could not certify complete was reviewed against Acceptance Gate 4 and found to stand up as a one-player arrangement for this source. It resolves the unresolved residue, which includes a missing Chord1/Chord2 function -- the evaluator cannot tell material the source never carried from material cleanup dropped, so only a reviewer can. It can never clear an absent Lead or a Core3 whose identity depends on Chord3-Chord5: those are deficiencies in the arrangement and the gate FAILs on them. Bound to the candidate.',
  original_audio_required: 'readiness `originalAudio` applicability. Setting it false states the song-specific workflow does not require original audio, and must say why. Bound to the baseline.',
});

// Which identity each confirmation is a statement about.
const CONFIRMATION_SCOPE = Object.freeze({
  source_complete: 'baseline',
  version_drift_reviewed: 'candidate',
  player_readback: 'candidate',
  mobile_adaptation_reviewed: 'candidate',
  regression_reviewed: 'candidate',
  core3_completeness_reviewed: 'candidate',
  original_audio_required: 'baseline',
});

// Confirmations whose `true` is a reviewer's answer to a required gate, and the
// gate each one answers. Recorded without evidence they would be a bare claim,
// so `record()` refuses them.
const EVIDENCE_REQUIRED_ON_TRUE = Object.freeze({
  mobile_adaptation_reviewed: 'Gate 8',
  regression_reviewed: 'Gate 9',
  core3_completeness_reviewed: 'Gate 4 Core3 completeness',
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
  // Core3 source-change approvals are per candidate, like audio evidence and
  // unlike a confirmation: each one is about one specific change to one
  // specific event, not a statement about the candidate as a whole.
  const core3ApprovalKey = (projectId, candidateId) => `core3-approvals:${projectId}:${candidateId}`;
  // Fresh Lead evidence, re-supplied for a move an earlier revision already
  // performed. Per candidate for the same reason the approvals are: the
  // citation is an answer about one specific candidate's Lead picture.
  const leadEvidenceReviewKey = (projectId, candidateId) => `lead-evidence-reviews:${projectId}:${candidateId}`;

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

  /**
   * The Core3 source-change approvals stored for one candidate.
   *
   * Returned in the shape `evaluateCore3Continuity` normalizes, and bound to
   * both the baseline and the candidate. An approval recorded against a
   * different baseline or a different candidate is not an approval for this
   * one: the change it named belongs to a comparison that is no longer being
   * made, so it is dropped here rather than inherited.
   */
  const core3ApprovalsFor = (record, candidateId) => {
    const stored = store.getJson(core3ApprovalKey(record.project_id, candidateId));
    const baselineId = record.baseline?.baseline_id ?? null;
    return (Array.isArray(stored) ? stored : [])
      .filter(entry => entry?.baseline_id === baselineId && entry?.candidate_id === candidateId)
      .map(entry => ({ eventId: entry.event_id, type: entry.type, reason: entry.reason, evidence: [...entry.evidence] }));
  };

  /**
   * The fresh Lead evidence reviews stored for one candidate.
   *
   * Same binding discipline as the Core3 approvals above, and for a stronger
   * reason: a Lead citation is an argument about the arrangement as it stands,
   * so one recorded against another baseline or another candidate is an
   * argument about material that is no longer being graded. Such an entry is
   * dropped here rather than inherited, which returns the recovered record to
   * PENDING -- the closed direction.
   *
   * Returned in the shape the lineage report builders read.
   */
  const leadEvidenceReviewsFor = (record, candidateId) => {
    const stored = store.getJson(leadEvidenceReviewKey(record.project_id, candidateId));
    const baselineId = record.baseline?.baseline_id ?? null;
    return (Array.isArray(stored) ? stored : [])
      .filter(entry => entry?.baseline_id === baselineId && entry?.candidate_id === candidateId)
      .map(entry => ({
        eventId: entry.event_id,
        axis: entry.axis,
        leadEvidence: entry.lead_evidence,
        leadContextDigest: entry.lead_context_digest,
        reason: entry.reason,
        evidence: [...(entry.evidence ?? [])],
        originEventId: entry.origin_event_id ?? null,
        at: entry.at ?? null,
      }));
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

    return { engines, record, baseline, baselineProject, entry, application, applicationLineage: arrangement.loadCandidateLineage(record, candidateId), core3Approvals: core3ApprovalsFor(record, candidateId), leadEvidenceReviews: leadEvidenceReviewsFor(record, candidateId), confirmations, staleConfirmations: stale, audioReports, audioErrors, project, parent, candidateRulesSnapshot, loadedRulesSnapshot };
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
      const evidence = normalizeEvidence(input.evidence);
      // A candidate-specific gate review that carries no evidence is an
      // assertion, not a review. Each of these three clears a required gate the
      // modules deliberately leave PENDING until a human answers it, so a
      // reason string on its own must not be enough -- and Studio Web already
      // requires a note *and* evidence for the same three reviews, so anything
      // less here would be a parity hole an Agent caller could walk through.
      // Own keys only, as everywhere else a caller-supplied name indexes a
      // table here: `constructor` resolves through the prototype and is truthy.
      const gate = Object.hasOwn(EVIDENCE_REQUIRED_ON_TRUE, name) ? EVIDENCE_REQUIRED_ON_TRUE[name] : null;
      if (gate && input.value === true && !evidence.length) {
        fail(ERROR_CODES.INVALID_REQUEST, `${name} PASS requires at least one evidence reference for the candidate-specific ${gate} review.`);
      }
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
      next[name] = { value: input.value, reason, evidence, at: now(), ...binding };
    }
    projects.save({ ...record, confirmations: next });
    return Object.freeze({ confirmations: Object.freeze({ ...next }) });
  }

  return Object.freeze({
    context,
    audioKey,
    record,
    effectiveConfirmations,

    /**
     * Record one reviewed, evidence-backed approval for one Core3 source change.
     *
     * Deliberately not a confirmation and deliberately not a boolean. A Core3
     * approval is a statement about one specific change to one specific event --
     * "this Chord1 event was moved to Chord4, for this reason, on this
     * evidence" -- so it is recorded per change, bound to the baseline and the
     * candidate the change exists in.
     *
     * The change must be one the continuity audit is currently reporting as
     * unapproved for this candidate. That is what stops an approval from being
     * a standing permission: a caller cannot pre-approve an edit it has not
     * made, and an approval does not survive into a candidate where the change
     * it named no longer exists.
     *
     * This is its own review axis. An accepted role decision, a Lead evidence
     * record and a Lead promotion PASS are none of them a Core3 approval, and
     * no operation converts one into another.
     */
    async approveCore3SourceChange(owner, projectId, { candidateId, approval } = {}) {
      const ctx = await context(owner, projectId, candidateId);
      const { engines, record, baselineProject, project } = ctx;
      if (!approval || typeof approval !== 'object' || Array.isArray(approval)) {
        fail(ERROR_CODES.INVALID_REQUEST, 'A Core3 change approval is required', { candidate_id: candidateId });
      }
      const eventId = requireString(approval.event_id, 'approval.event_id', { max: 200 });
      const type = approval.type;
      if (!['remove', 'modify', 'role-move'].includes(type)) {
        fail(ERROR_CODES.INVALID_REQUEST, 'approval.type must be remove, modify, or role-move', { accepted: ['remove', 'modify', 'role-move'] });
      }
      const reason = requireString(approval.reason, 'approval.reason', { max: 500 });
      const evidence = normalizeEvidence(approval.evidence);
      if (!evidence.length) {
        fail(ERROR_CODES.INVALID_REQUEST, 'A Core3 change approval requires at least one explicit evidence reference.');
      }

      // The change has to be one this candidate actually shows, and has to be
      // unapproved right now. Recording an approval for a change that is not
      // there would file a permission rather than a review.
      const current = engines.core3.evaluateCore3Continuity({
        baseline: baselineProject,
        candidate: project,
        approvedChanges: core3ApprovalsFor(record, candidateId),
      });
      const named = (current.unapproved ?? []).find(item => item.eventId === eventId && item.type === type);
      if (!named) {
        fail(ERROR_CODES.INVALID_REQUEST, 'This candidate reports no unapproved Core3 change of that type for that event.', {
          candidate_id: candidateId,
          event_id: eventId,
          type,
          unapproved: (current.unapproved ?? []).map(item => ({ event_id: item.eventId, type: item.type })),
        });
      }

      const stored = store.getJson(core3ApprovalKey(record.project_id, candidateId));
      const existing = Array.isArray(stored) ? stored : [];
      const entry = {
        event_id: eventId,
        type,
        reason,
        evidence,
        baseline_id: record.baseline?.baseline_id ?? null,
        candidate_id: candidateId,
        at: now(),
      };
      store.putJson(
        core3ApprovalKey(record.project_id, candidateId),
        [...existing.filter(item => !(item.event_id === eventId && item.type === type)), entry],
      );
      return Object.freeze({
        approval: Object.freeze({ ...entry, evidence: Object.freeze([...evidence]) }),
        notice: 'A Core3 source-change approval explains one reviewed change to the continuity audit. It is not a Gate 4 completeness result, not a Lead decision, and not an approval of any other change.',
      });
    },

    /**
     * Re-supply Lead evidence for a role move an earlier revision already made.
     *
     * Why this operation has to exist. The downstream Lead gates recover each
     * move's evidence from the revision that performed it and re-grade it
     * against the current candidate. When a later revision moves the Lead
     * picture, that recovered citation no longer describes the arrangement being
     * graded and is correctly reported `LEAD_EVIDENCE_CONTEXT_CHANGED` --
     * PENDING, per MASTER_RULES §4. That staleness is right and stays. What was
     * missing was any way to answer it: G11-D refuses to re-apply a move that
     * already happened (`PREVIOUS_ROLE_MISMATCH`), and a KEEP carrying
     * `leadEvidence` is not a role move, so no report reads it. The gate was
     * unclearable by construction.
     *
     * What this is, and what it is not. It is a review record: one candidate,
     * one event, one axis, one citation, with a reason and explicit evidence.
     * It is not a decision -- it moves nothing and produces no revision -- and
     * it is not a boolean confirmation, because a checkbox cannot be graded.
     * Nothing here decides anything: the submitted citation is put through the
     * same shared `evaluateLeadPromotion()` / `evaluateLeadDemotion()` grader on
     * every subsequent review and finalize, exactly as the original was. The
     * previous PASS is never read and never carried forward.
     *
     * Four bindings, all of them refusals rather than warnings:
     *
     *   the move      must be one this candidate's lineage actually performed
     *                 and is currently reporting as not yet answered. A caller
     *                 cannot file a citation for a move it has not made, or
     *                 re-answer one that already passes.
     *   the axis      promotion evidence cannot answer a demotion requirement,
     *                 or the reverse. They are different graders.
     *   the identity  the citation is bound to the Source-Faithful baseline
     *                 event -- for a derived duplicate, to the origin the
     *                 duplicate chain resolves to, never to the derived id.
     *   the candidate the review is stored under, and re-checked against, the
     *                 exact candidate and Lead context digest it was made for.
     *                 The next Lead-affecting revision is a different candidate,
     *                 so the review is not loaded and the report returns to
     *                 PENDING.
     *
     * The identity binding is checked by grading the submission through the real
     * report builder before anything is written, so this operation holds no copy
     * of the binding rule. A submission that fails it is refused and not stored.
     */
    async reviewLeadEvidence(owner, projectId, { candidateId, review } = {}) {
      const ctx = await context(owner, projectId, candidateId);
      const { engines, record, baselineProject, application } = ctx;
      if (!review || typeof review !== 'object' || Array.isArray(review)) {
        fail(ERROR_CODES.INVALID_REQUEST, 'A Lead evidence review is required', { candidate_id: candidateId });
      }
      const eventId = requireString(review.event_id, 'review.event_id', { max: 300 });
      const axes = engines.arrangement.LEAD_EVIDENCE_REVIEW_AXES;
      const axis = review.axis;
      if (axis !== axes.PROMOTION && axis !== axes.DEMOTION) {
        fail(ERROR_CODES.INVALID_REQUEST, 'review.axis must be promotion or demotion. Promotion evidence argues an event into Melody; demotion evidence argues one out of it, and neither answers the other.', { accepted: [axes.PROMOTION, axes.DEMOTION] });
      }
      const reason = requireString(review.reason, 'review.reason', { max: 500 });
      const evidence = normalizeEvidence(review.evidence);
      if (!evidence.length) {
        fail(ERROR_CODES.INVALID_REQUEST, 'A Lead evidence review requires at least one explicit evidence reference.');
      }
      const leadEvidence = review.lead_evidence;
      if (!leadEvidence || typeof leadEvidence !== 'object' || Array.isArray(leadEvidence)) {
        fail(ERROR_CODES.INVALID_REQUEST, 'review.lead_evidence must be the Lead evidence record the shared gate grades: sourceIdentity, sectionRole, scoreEvidence, audioEvidence, continuity, core3 and a positive destination reason.');
      }

      // The Lead picture this review is an argument about. Recorded with the
      // review so a later candidate cannot silently inherit it.
      let leadContextDigest;
      try { leadContextDigest = engines.arrangement.leadContextDigestOf(application.candidate); }
      catch (error) { fail(ERROR_CODES.INVALID_REQUEST, `This candidate has no readable Lead context to review against: ${error.message}`, { candidate_id: candidateId }); }

      const stored = store.getJson(leadEvidenceReviewKey(record.project_id, candidateId));
      const existing = Array.isArray(stored) ? stored : [];
      const others = leadEvidenceReviewsFor(record, candidateId).filter(entry => !(entry.eventId === eventId && entry.axis === axis));
      const reportsWith = freshReviews => {
        const inputs = { applications: ctx.applicationLineage, baseline: baselineProject, candidate: application.candidate, freshReviews };
        return axis === axes.PROMOTION
          ? engines.arrangement.leadPromotionReportsFromLineage(inputs)
          : engines.arrangement.leadDemotionReportsFromLineage(inputs);
      };

      // Something to answer. Computed with the reviews already stored, so a
      // question this caller has already answered is reported as answered.
      const before = reportsWith(leadEvidenceReviewsFor(record, candidateId)).find(report => report.eventId === eventId);
      if (!before) {
        fail(ERROR_CODES.INVALID_REQUEST, `This candidate reports no Lead ${axis} requiring evidence for that event.`, {
          candidate_id: candidateId,
          event_id: eventId,
          axis,
          reviewable: reportsWith(leadEvidenceReviewsFor(record, candidateId)).filter(report => report.pass !== true).map(report => report.eventId),
        });
      }
      if (before.pass === true) {
        fail(ERROR_CODES.INVALID_REQUEST, `This candidate's Lead ${axis} for that event is already answered; there is nothing to re-review.`, {
          candidate_id: candidateId, event_id: eventId, axis, status: before.status ?? null,
        });
      }

      // Grade the submission through the real builder before storing it. The
      // identity binding lives in one place and this asks it the question
      // rather than repeating it. A scope failure is a fault in the submission,
      // so it is refused; an insufficient but correctly-scoped citation is
      // recorded and reported PENDING by the gate, which is its answer to give.
      const candidateEntry = {
        event_id: eventId,
        axis,
        lead_evidence: leadEvidence,
        reason,
        evidence,
        lead_context_digest: leadContextDigest,
        origin_event_id: before.originEventId ?? null,
        baseline_id: record.baseline?.baseline_id ?? null,
        candidate_id: candidateId,
        at: now(),
      };
      const dryRun = reportsWith([...others, {
        eventId, axis, leadEvidence, leadContextDigest, reason, evidence, originEventId: candidateEntry.origin_event_id, at: candidateEntry.at,
      }]).find(report => report.eventId === eventId);
      const identityBlockers = (dryRun?.blockers ?? []).filter(blocker => engines.leadDemotion.LEAD_EVIDENCE_IDENTITY_BLOCKERS.includes(blocker));
      if (identityBlockers.length) {
        fail(ERROR_CODES.INVALID_REQUEST, 'The Lead evidence does not bind to the Source-Faithful baseline event this move is about, so it is not evidence for this move.', {
          candidate_id: candidateId,
          event_id: eventId,
          axis,
          origin_event_id: candidateEntry.origin_event_id,
          blockers: identityBlockers,
        });
      }

      store.putJson(
        leadEvidenceReviewKey(record.project_id, candidateId),
        [...existing.filter(item => !(item.event_id === eventId && item.axis === axis)), candidateEntry],
      );
      return Object.freeze({
        review: Object.freeze({ ...candidateEntry, evidence: Object.freeze([...evidence]) }),
        report: dryRun ?? null,
        notice: 'A Lead evidence review re-supplies one citation for one already-applied Lead move on one candidate. It is graded by the shared Lead gate on every review and finalize, it carries no previous verdict forward, and it is not loaded for any other candidate.',
      });
    },

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
      const core3ApprovedChanges = ctx.core3Approvals;

      // Read the whole integrity-checked revision lineage, not just this
      // revision: a Lead move made three revisions ago still needs evidence
      // relative to the Source-Faithful baseline, and its evidence record lives
      // on the revision that made it. Every recovered record is re-graded
      // against the current candidate, never carried forward as a stored PASS.
      const leadReportInputs = { applications: ctx.applicationLineage, baseline: baselineProject, candidate: application.candidate, freshReviews: ctx.leadEvidenceReviews };
      const leadDemotionReports = engines.arrangement.leadDemotionReportsFromLineage(leadReportInputs);
      const leadPromotionReports = engines.arrangement.leadPromotionReportsFromLineage(leadReportInputs);
      const readinessInputs = {
        leadDemotionReports,
        leadPromotionReports,
        versionDriftReviewed: recorded.version_drift_reviewed?.value === true,
        originalAudioRequired: recorded.original_audio_required?.value !== false,
        playerReadback: recorded.player_readback?.value ?? 'NOT_RUN',
        mobileAdaptation: recorded.mobile_adaptation_reviewed?.value === true ? 'PASS' : 'PENDING',
        regressionReviewed: recorded.regression_reviewed?.value === true,
        core3CompletenessReviewed: recorded.core3_completeness_reviewed?.value === true,
        // Never a parameter a caller can reach. See the header.
        inGameAcceptance: 'PENDING',
      };

      const applied = engines.arrangement.reviewAppliedCandidate({
        application,
        baseline: baselineProject,
        acceptedPrevious: parent,
        core3ApprovedChanges,
        ...readinessInputs,
      });

      const lineage = engines.compare.compareCandidateLineage({ sourceBaseline: baselineProject, acceptedPrevious: parent, candidate: project });
      // Validated, candidate-bound approvals reach the continuity engine; a
      // caller cannot hand it approvals directly.
      const core3 = engines.core3.evaluateCore3Continuity({ baseline: baselineProject, candidate: project, approvedChanges: core3ApprovedChanges });
      const core3Completeness = engines.core3Completeness.evaluateCore3Completeness({
        candidate: project,
        reviewed: recorded.core3_completeness_reviewed?.value === true,
      });
      const harmony = engines.harmony.analyzeCrossSourceHarmony(project);
      const readiness = engines.final.evaluateProjectReadiness({
        project,
        mmlValidation: null,
        core3Report: core3,
        core3CompletenessReport: core3Completeness,
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
        core3_completeness: core3Completeness,
        core3_approvals: core3ApprovedChanges,
        harmony,
        lead_demotion: leadDemotionReports,
        lead_promotion: leadPromotionReports,
        lead_evidence_reviews: ctx.leadEvidenceReviews,
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
 *   mobile_adaptation  Readiness answers this from an explicit candidate-bound
 *               evidence-backed Gate 8 review. Parser/emitter success never
 *               upgrades it.
 *   regression  Readiness answers this from an explicit candidate-bound,
 *               evidence-backed Gate 9 review. A clean diff or passing test
 *               suite never silently upgrades it.
 *   in_game     `PENDING`, unconditionally and by construction.
 */
export function gatesFrom(readiness) {
  const status = name => readiness?.gates?.[name]?.status ?? GATE_STATUS.NOT_RUN;
  return Object.freeze({
    technical: status('technical'),
    source: status('source'),
    audio: status('originalAudio'),
    player_readback: status('playerReadback'),
    mobile_adaptation: status('mobileAdaptation'),
    regression: status('regression'),
    in_game: GATE_STATUS.PENDING,
    notice: GATE_NOTICE,
  });
}

export { CONFIRMATIONS, CONFIRMATION_SCOPE, PLAYER_READBACK_VALUES };
