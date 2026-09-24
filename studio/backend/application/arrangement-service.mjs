// Arrangement: suggestion, then explicit acceptance.
//
// Status: IMPLEMENTATION NOTES. Two operations that must never collapse into
// one.
//
//   suggest()         reads the Source-Faithful Baseline and returns the
//                     existing G11-B lane decomposition and G11-C role
//                     candidates. Nothing is accepted, nothing is written into
//                     a candidate, and a `PENDING` stays `PENDING`.
//   applyDecisions()  applies an explicitly accepted decision set through the
//                     existing G11-D `applyAcceptedArrangement`, all or
//                     nothing, and files the derived candidate.
//
// A suggestion is not an acceptance. This layer will not convert one into the
// other, will not resolve a `PENDING` on a caller's behalf, and will not invent
// evidence for any Lead move. Demotion, existing-role promotion and
// duplication into Melody remain subject to the shared Lead-role evidence
// interlock. Initial role-less ASSIGN_ROLE -> Melody may only materialize a
// review-pending candidate; downstream Lead readiness still uses the shared
// grader and remains PENDING without candidate-bound reviewer evidence.
//
// The acceptance bindings are computed here, from the baseline and lane
// decomposition that are loaded right now, and a caller may not supply them.
// That is the same rule the Studio Web integration follows and for the same
// reason: an identity a caller can supply is an identity a caller can make
// stale-proof, and the bindings exist precisely to catch a decision that was
// reviewed against different inputs. The digests themselves come from the
// backend's own `baselineIdentityOf` / `laneDecompositionDigestOf`; this module
// computes no digest of its own.

import { ERROR_CODES, LIMITS, isCandidateId, fail, requirePlainObject, requireString } from './contracts.mjs';

const now = () => new Date().toISOString();

// Fields a caller may state about a decision. `acceptance` is absent on
// purpose: see the header. `id` is optional and generated when omitted.
export const CALLER_DECISION_KEYS = new Set(['id', 'type', 'target', 'fromRole', 'toRole', 'toRoles', 'reason', 'evidence', 'section', 'leadEvidence', 'metadata', 'acceptedBy', 'note']);

const summarizeMergeDiagnostics = diagnostics => {
  if (!diagnostics || typeof diagnostics !== 'object') return null;
  const pendingRoleGroups = diagnostics.pendingRoleGroups ?? [];
  const overflowLanes = diagnostics.overflowLanes ?? [];
  const boundedPendingRoleGroups = pendingRoleGroups.slice(0, 6);
  const boundedOverflowLanes = overflowLanes.slice(0, LIMITS.maxReviewRequestEventIds);
  return Object.freeze({
    authority: diagnostics.authority ?? null,
    pendingRoleGroupTotal: pendingRoleGroups.length,
    pendingRoleGroupReturned: boundedPendingRoleGroups.length,
    pendingRoleGroupsTruncated: boundedPendingRoleGroups.length < pendingRoleGroups.length,
    overflowLaneTotal: overflowLanes.length,
    overflowLaneReturned: boundedOverflowLanes.length,
    overflowLanesTruncated: boundedOverflowLanes.length < overflowLanes.length,
    pendingRoleGroups: Object.freeze(boundedPendingRoleGroups.map(group => {
      const laneIds = [...(group.laneIds ?? [])];
      const boundedLaneIds = laneIds.slice(0, LIMITS.maxReviewRequestEventIds);
      return Object.freeze({
      role: group.role ?? null,
      laneTotal: laneIds.length,
      laneReturned: boundedLaneIds.length,
      laneIdsTruncated: boundedLaneIds.length < laneIds.length,
      laneIds: Object.freeze(boundedLaneIds),
      status: group.status ?? null,
      fullyLosslessTogether: group.fullyLosslessTogether === true,
      unisonReviewCount: group.unisonReviewCount ?? 0,
      collisionEventCount: group.collisionEventCount ?? 0,
      leadReviewRequired: group.leadReviewRequired === true,
      authority: group.authority ?? null,
    });
    })),
    overflowLanes: Object.freeze(boundedOverflowLanes
      .map(entry => Object.freeze({
        laneId: entry.laneId ?? null,
        candidateEventCount: entry.candidateEventCount ?? 0,
        sourceEventCount: entry.sourceEventCount ?? 0,
        authority: entry.authority ?? null,
        targets: Object.freeze((entry.targets ?? []).slice(0, 6).map(target => Object.freeze({
          role: target.role ?? null,
          losslessGapCount: target.losslessGapCount ?? 0,
          unisonCoveredCount: target.unisonCoveredCount ?? 0,
          wouldRequireTrimOrDropCount: target.wouldRequireTrimOrDropCount ?? 0,
          fullyLossless: target.fullyLossless === true,
          leadReviewRequired: target.leadReviewRequired === true,
          authority: target.authority ?? null,
        }))),
      }))),
    certifiesGates: Object.freeze([]),
  });
};

// Cache identity is implementation identity, not Canonical identity. A new
// suggestion field or arbitration implementation must not silently reuse a
// durable suggestion blob written by an older service merely because the
// baseline and Published Canonical snapshot are unchanged.
//
// v3: suggestions are derived from the supported notes only. A v2 blob of a
// baseline with percussion / unsupported notes can give that material a pitched
// role, so a v2 blob is never read again and is deleted once its replacement has
// been derived. For a baseline without such notes v2 and v3 are byte-identical.
export const ARRANGEMENT_SUGGESTION_CACHE_EPOCH = 'g11c-role-candidate-v3-supported-notes-only';
export const RETIRED_ARRANGEMENT_SUGGESTION_CACHE_EPOCHS = Object.freeze(['g11c-role-candidate-v2-merge-diagnostics']);

const epochSuggestionKey = (epoch, projectId, baselineId, rulesSnapshotSha) =>
  `suggestion:${epoch}:${projectId}:${baselineId}:${rulesSnapshotSha}`;

export function createArrangementService({ canonical, projects, intake, store }) {
  // Keyed by the implementation epoch, baseline AND Published Canonical rules
  // snapshot. The epoch intentionally changes when the cached G11-C output
  // shape/semantics change; otherwise a durable pre-upgrade cache could hide
  // newly implemented review diagnostics on the exact song we need to rerun.
  const suggestionKey = (projectId, baselineId, rulesSnapshotSha) =>
    epochSuggestionKey(ARRANGEMENT_SUGGESTION_CACHE_EPOCH, projectId, baselineId, rulesSnapshotSha);
  const legacySuggestionKey = (projectId, baselineId, rulesSnapshotSha) =>
    `suggestion:${projectId}:${baselineId}:${rulesSnapshotSha}`;
  // The whole G11-D application result is stored, not just the candidate it
  // produced. `reviewAppliedCandidate` re-establishes the revision identity,
  // the candidate digest and the baseline snapshot from it on every read, so a
  // stored result that was edited, truncated or restored from an older pipeline
  // is reported as inconsistent instead of being trusted as current.
  const applicationKey = (projectId, candidateId) => `application:${projectId}:${candidateId}`;

  /** The G11-C suggestion for the current baseline, derived or reused. */
  const suggestionFor = async (owner, projectId, { refresh = false } = {}) => {
    const engines = await canonical.engines();
    const { record, baseline, project } = await intake.project(owner, projectId);
    const key = suggestionKey(record.project_id, baseline.baseline_id, engines.emitterContract.canonicalIdentity().rules_snapshot_sha);
    const cached = refresh ? null : store.getJson(key);
    if (cached) return { engines, record, baseline, project, suggestion: cached };

    // The engine decomposes the baseline itself. It splits only the notes it
    // treats as supported and keeps percussion-channel and percussion / drum /
    // unsupported-tagged notes as unsupported source material. A decomposition
    // of the whole baseline handed in from here put that material into lanes,
    // where it could take a pitched role and was counted twice.
    const suggestion = engines.arrangement.suggestRoleCandidates(project);

    // A cache is reconstructible, not evidence. Once the new suggestion has
    // been derived successfully, discard the pre-epoch and retired-epoch blobs
    // before writing the replacement so a large stale cache cannot make an
    // otherwise valid deployment upgrade fail its store quota.
    const rulesSnapshotSha = engines.emitterContract.canonicalIdentity().rules_snapshot_sha;
    store.deleteBytes(legacySuggestionKey(record.project_id, baseline.baseline_id, rulesSnapshotSha));
    for (const epoch of RETIRED_ARRANGEMENT_SUGGESTION_CACHE_EPOCHS) {
      store.deleteBytes(epochSuggestionKey(epoch, record.project_id, baseline.baseline_id, rulesSnapshotSha));
    }
    store.putJson(key, suggestion);
    return { engines, record, baseline, project, suggestion };
  };

  const loadCandidate = (record, candidateId) => {
    if (!isCandidateId(candidateId)) fail(ERROR_CODES.CANDIDATE_NOT_FOUND, 'Unknown candidate', { candidate_id: String(candidateId).slice(0, 96) });
    const entry = record.candidates.find(candidate => candidate.candidate_id === candidateId);
    if (!entry) fail(ERROR_CODES.CANDIDATE_NOT_FOUND, 'Unknown candidate', { candidate_id: candidateId, project_id: record.project_id });
    const application = store.getJson(applicationKey(record.project_id, candidateId));
    if (!application?.candidate || !application?.revision) fail(ERROR_CODES.CANDIDATE_NOT_FOUND, 'The stored candidate is no longer available', { candidate_id: candidateId });
    return { entry, application, candidate: application.candidate, revision: application.revision };
  };

  /**
   * Every stored application from revision 1 up to this candidate, oldest first.
   *
   * Lead evidence is recorded on the revision that performed the role move and
   * is deliberately not inherited by later candidates, while the readiness Lead
   * gates derive what needs evidence from the candidate-versus-baseline diff,
   * which does accumulate. Recovering the evidence therefore means reading the
   * chain, not just the head.
   *
   * Only what is stored and linked is returned. A broken or missing link stops
   * the walk and returns what was reachable; `applicationLineage()` then refuses
   * an inconsistent chain outright, so a partial answer here becomes PENDING
   * downstream rather than a silently shorter history. The `seen` set bounds the
   * walk against a cycle in stored data.
   */
  const loadCandidateLineage = (record, candidateId) => {
    const chain = [];
    const seen = new Set();
    let currentId = candidateId;
    while (typeof currentId === 'string' && currentId && !seen.has(currentId)) {
      seen.add(currentId);
      const entry = record.candidates.find(candidate => candidate.candidate_id === currentId);
      if (!entry) break;
      const application = store.getJson(applicationKey(record.project_id, currentId));
      if (!application?.candidate || !application?.revision) break;
      chain.push(application);
      currentId = entry.parent_candidate_id ?? null;
    }
    return chain.reverse();
  };

  /**
   * The baseline's events with their provenance, optionally one lane's, paged.
   *
   * Identity, role, pitch, timing and source identities only. No verdict is
   * computed and nothing is written; the suggestion is consulted solely to
   * resolve a lane id to the events it groups.
   */
  const baselineEvents = async (owner, projectId, { laneId = null, eventIds = null, offset = 0, limit = LIMITS.maxEventsPerPage } = {}) => {
    if (laneId !== null && laneId !== undefined) requireString(laneId, 'lane_id', { max: 200 });
    if (eventIds !== null && eventIds !== undefined) {
      if (!Array.isArray(eventIds) || eventIds.length > LIMITS.maxEventsPerPage) fail(ERROR_CODES.INVALID_REQUEST, `event_ids must be an array of at most ${LIMITS.maxEventsPerPage} event ids.`);
      eventIds.forEach((id, index) => requireString(id, `event_ids[${index}]`, { max: 300 }));
    }
    if (!Number.isSafeInteger(offset) || offset < 0) fail(ERROR_CODES.INVALID_REQUEST, 'offset must be a non-negative integer.');
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > LIMITS.maxEventsPerPage) fail(ERROR_CODES.INVALID_REQUEST, `limit must be an integer from 1 to ${LIMITS.maxEventsPerPage}.`);

    const { baseline, project, suggestion } = laneId ? await suggestionFor(owner, projectId) : { ...(await intake.project(owner, projectId)), suggestion: null };
    let selected = project.events;
    if (laneId) {
      const lane = (suggestion?.lanes ?? []).find(entry => entry?.id === laneId || entry?.laneId === laneId);
      if (!lane) fail(ERROR_CODES.INVALID_REQUEST, 'Unknown lane in the current suggestion.', { lane_id: laneId });
      const members = new Set(lane.eventIds ?? []);
      selected = selected.filter(event => members.has(event.id));
    }
    if (eventIds) {
      const wanted = new Set(eventIds);
      selected = selected.filter(event => wanted.has(event.id));
    }
    const page = selected.slice(offset, offset + limit);
    return {
      baseline_id: baseline.baseline_id,
      lane_id: laneId ?? null,
      total: selected.length,
      offset,
      limit,
      next_offset: offset + limit < selected.length ? offset + limit : null,
      events: page.map(event => Object.freeze({
        event_id: event.id,
        kind: event.kind,
        role: event.role ?? null,
        voice: event.voice ?? null,
        pitch: event.kind === 'note' ? event.pitch : null,
        start: event.start,
        end: event.end,
        source_ids: [...(event.sourceIds ?? [])],
        source_event_ids: [...(event.sourceEventIds ?? [])],
      })),
      notice: 'A read-only projection of the Source-Faithful Baseline. Source identities are what Lead evidence must cite; nothing here is a verdict.',
    };
  };

  return Object.freeze({
    suggestionFor,
    loadCandidate,
    loadCandidateLineage,
    baselineEvents,

    async mobileAdaptation(owner, projectId, { candidateId, profile = null, releaseRepresentation = null, expectedPlanId = null, acceptedBy = null, apply = false, inputFingerprint = null, effectAttemptId = null } = {}) {
      const engines = await canonical.engines();
      const { record, baseline, project } = await intake.project(owner, projectId);
      const { application: parent } = loadCandidate(record, candidateId);
      if (!engines.arrangement.applicationIntegrity(parent, project).ok) fail(ERROR_CODES.INVALID_REQUEST, 'The candidate no longer matches the current baseline.');
      if (parent.revision.canonicalIdentity.rules_snapshot_sha !== engines.emitterContract.canonicalIdentity().rules_snapshot_sha) fail(ERROR_CODES.INVALID_REQUEST, 'The candidate belongs to a different Canonical snapshot.');
      // Which events a recovered Lead report re-checks the identity of. Read from
      // the whole stored lineage, because a promotion in one revision and a move
      // back in a later one leaves the baseline and candidate roles equal while
      // the surviving record still binds this event's pitch, timing and volume.
      // Changing one of those would leave a gate no review could answer, so the
      // engine refuses before the candidate exists.
      const leadReportInputs = { applications: loadCandidateLineage(record, candidateId), baseline: project, candidate: parent.candidate };
      const leadBoundEventIds = [...engines.arrangement.leadDemotionReportsFromLineage(leadReportInputs), ...engines.arrangement.leadPromotionReportsFromLineage(leadReportInputs)]
        .map(report => report.eventId).filter(eventId => typeof eventId === 'string' && eventId);
      let result;
      try {
        // The evidence registry a release representation decision is graded
        // against: this project's uploaded assets and the Canonical sources, each
        // with its declared kind and bytes' digest. Nothing a caller writes into
        // the decision can add an entry.
        const evidenceSources = { assets: record.assets ?? [], sources: [...(project.sources ?? []), ...(parent.candidate.sources ?? [])] };
        const input = { baseline: project, candidate: parent.candidate, profile, releaseRepresentation, evidenceSources, leadBoundEventIds };
        if (!apply) return { candidate_id: candidateId, baseline_id: baseline.baseline_id, plan: engines.adaptation.planMobileAdaptation(input) };
        result = engines.adaptation.applyMobileAdaptation({ ...input, parent, expectedPlanId, acceptedBy });
      } catch (error) { fail(ERROR_CODES.INVALID_REQUEST, error.message); }
      if (!result.didApply) return { applied: false, candidate_id: candidateId, baseline_id: baseline.baseline_id, status: result.status, unchanged: result.unchanged ?? false, blockers: result.blockers, plan: result.plan };
      const adaptedId = result.revision.id;
      store.putJson(applicationKey(record.project_id, adaptedId), result);
      projects.save({ ...record, candidates: [...record.candidates.filter(entry => entry.candidate_id !== adaptedId), {
        candidate_id: adaptedId, parent_candidate_id: candidateId, baseline_id: baseline.baseline_id,
        revision_index: result.revision.index, created_at: now(), decision_count: result.plan.changes.length + (result.plan.releaseRepresentation?.changes?.length ?? 0),
        decision_ids: [result.plan.id], accepted_by: [acceptedBy.trim()], stage: 'MOBILE_ADAPTATION_V1',
        input_fingerprint: inputFingerprint, effect_attempt_id: effectAttemptId,
      }] });
      return { applied: true, status: 'PASS', candidate_id: adaptedId, parent_candidate_id: candidateId, baseline_id: baseline.baseline_id,
        plan: result.plan, diff_from_baseline: result.diffFromBaseline, diff_from_parent: result.diffFromParent, notice: result.notice };
    },

    /**
     * Preview or apply the Final Six-Role Reduction for one candidate.
     *
     * Two operations that must never collapse into one. `finalReduction(...,
     * { apply: false })` is read-only and writes nothing; applying is an
     * explicit mutation that has to name the preview's `expectedPlanId`. The
     * application layer exposes them as two named operations for exactly that
     * reason — a single `apply=true` flag is one typo away from a mutation
     * nobody previewed.
     *
     * Everything a caller could make stale-proof is recomputed here from what
     * is loaded now: the acceptance bindings, the plan, and the lineage inputs
     * the Lead and accounting checks read. A caller supplies decisions and the
     * plan id it reviewed; nothing else.
     */
    async finalReduction(owner, projectId, { candidateId, decisions = [], expectedPlanId = null, acceptedBy = null, instrumentProfile = null, apply = false, inputFingerprint = null, effectAttemptId = null } = {}) {
      const engines = await canonical.engines();
      const { record, baseline, project } = await intake.project(owner, projectId);
      const { application: parent } = loadCandidate(record, candidateId);
      if (!engines.arrangement.applicationIntegrity(parent, project).ok) fail(ERROR_CODES.INVALID_REQUEST, 'The candidate no longer matches the current baseline.');
      if (parent.revision.canonicalIdentity.rules_snapshot_sha !== engines.emitterContract.canonicalIdentity().rules_snapshot_sha) fail(ERROR_CODES.INVALID_REQUEST, 'The candidate belongs to a different Canonical snapshot.');
      if (!Array.isArray(decisions)) fail(ERROR_CODES.INVALID_REQUEST, 'decisions must be an array of accepted reduction decisions.');
      if (decisions.length > LIMITS.maxDecisionsPerRequest) fail(ERROR_CODES.INVALID_REQUEST, `A reduction decision set is limited to ${LIMITS.maxDecisionsPerRequest} decisions.`, { received: decisions.length });
      const reviewer = apply ? requireString(acceptedBy, 'accepted_by', { max: 120 }) : (typeof acceptedBy === 'string' && acceptedBy.trim() ? requireString(acceptedBy, 'accepted_by', { max: 120 }) : 'reduction-preview');
      // Which baseline events earlier accepted revisions already omitted. Read
      // from the whole stored lineage, because `metadata.g11d.omittedEventIds`
      // records only the omissions of the revision that performed them and is
      // deliberately not inherited. Without this the accounting ledger would
      // have to report every earlier omission as unverified.
      const lineage = loadCandidateLineage(record, candidateId);
      const parentOmittedEventIds = [...new Set(lineage.flatMap(step => step.candidate?.metadata?.g11d?.omittedEventIds ?? []))];
      const input = { baseline: project, candidate: parent.candidate, parent, decisions, acceptedBy: reviewer, parentOmittedEventIds, instrumentProfile };
      let result;
      try {
        if (!apply) return { candidate_id: candidateId, baseline_id: baseline.baseline_id, plan: engines.reduction.planFinalReduction(input) };
        result = engines.reduction.applyFinalReduction({ ...input, expectedPlanId, acceptedBy: reviewer });
      } catch (error) { fail(ERROR_CODES.INVALID_REQUEST, error.message); }
      if (!result.didApply) return { applied: false, candidate_id: candidateId, baseline_id: baseline.baseline_id, status: result.status, unchanged: result.unchanged ?? false, blockers: result.blockers, plan: result.plan };
      const reducedId = result.revision.id;
      store.putJson(applicationKey(record.project_id, reducedId), result.roleApplication);
      projects.save({ ...record, candidates: [...record.candidates.filter(entry => entry.candidate_id !== reducedId), {
        candidate_id: reducedId, parent_candidate_id: candidateId, baseline_id: baseline.baseline_id,
        revision_index: result.revision.index, created_at: now(), decision_count: result.plan.decisions.length,
        decision_ids: [result.plan.id], accepted_by: [reviewer], stage: 'FINAL_SIX_ROLE_REDUCTION_V1',
        input_fingerprint: inputFingerprint, effect_attempt_id: effectAttemptId,
      }] });
      return { applied: true, status: 'PASS', candidate_id: reducedId, parent_candidate_id: candidateId, baseline_id: baseline.baseline_id,
        plan: result.plan, accounting: result.accounting, diff_from_baseline: result.diffFromBaseline, diff_from_parent: result.diffFromParent, notice: result.notice };
    },

    /**
     * Propose six-role candidates over the Source-Faithful Baseline.
     *
     * The returned `bindings` are what an accepted decision must carry. They
     * are echoed so an agent can see what its decisions will be checked
     * against — not so it can send them back: `applyDecisions` recomputes them
     * and ignores anything a caller supplies.
     */
    async suggest(owner, projectId, { refresh = false } = {}) {
      const { engines, baseline, project, suggestion } = await suggestionFor(owner, projectId, { refresh });
      const identity = engines.arrangement.baselineIdentityOf(project);
      return {
        baseline_id: baseline.baseline_id,
        lane_count: suggestion.lanes?.length ?? 0,
        roles: summarizeRoles(suggestion),
        pending: summarizePending(suggestion),
        coverage: suggestion.coverage ?? null,
        core3: suggestion.core3 ?? null,
        full6: suggestion.full6 ?? null,
        unassigned: suggestion.unassigned ?? null,
        merge_diagnostics: summarizeMergeDiagnostics(suggestion.mergeDiagnostics),
        unsupported_source_material: suggestion.unsupportedSourceMaterial ?? null,
        diagnostics: suggestion.diagnostics ?? [],
        bindings: {
          reviewedRevisionId: null,
          baselineContentDigest: identity.contentDigest,
          sourceIdentityDigest: identity.sourceIdentityDigest,
          laneDecompositionDigest: engines.arrangement.laneDecompositionDigestOf(suggestion),
          canonicalRulesSnapshotSha: engines.emitterContract.canonicalIdentity().rules_snapshot_sha,
        },
        status: engines.arrangement.ROLE_CANDIDATE_STATUS,
        notice: 'A G11-C suggestion over a Source-Faithful Baseline. It is not an accepted arrangement, it modifies no source project, and it certifies no acceptance gate. PENDING stays PENDING until a decision states otherwise.',
      };
    },

    /**
     * Apply an explicitly accepted decision set.
     *
     * All-or-nothing, by the existing G11-D contract: a set whose seventeenth
     * decision is illegal leaves no partially applied candidate. A non-PASS
     * result files no candidate and returns the backend's own rejection codes
     * unchanged.
     */
    async applyDecisions(owner, projectId, { decisions, parentCandidateId = null, acceptedBy = null, inputFingerprint = null, effectAttemptId = null } = {}) {
      if (!Array.isArray(decisions) || !decisions.length) {
        fail(ERROR_CODES.DECISION_REQUIRED, 'An accepted decision set is required; applying nothing does not mint a candidate.', {});
      }
      if (decisions.length > LIMITS.maxDecisionsPerRequest) {
        fail(ERROR_CODES.INVALID_REQUEST, `A decision set is limited to ${LIMITS.maxDecisionsPerRequest} decisions.`, { received: decisions.length });
      }

      const { engines, record, baseline, project, suggestion } = await suggestionFor(owner, projectId);
      const identity = engines.arrangement.baselineIdentityOf(project);
      const canonicalIdentity = engines.emitterContract.canonicalIdentity();

      const parent = parentCandidateId === null ? null : (() => {
        const loaded = loadCandidate(record, parentCandidateId);
        return { revision: loaded.revision, candidate: loaded.candidate };
      })();

      const bindings = {
        state: 'ACCEPTED',
        reviewedRevisionId: parent?.revision?.id ?? null,
        baselineContentDigest: identity.contentDigest,
        sourceIdentityDigest: identity.sourceIdentityDigest,
        laneDecompositionDigest: engines.arrangement.laneDecompositionDigestOf(suggestion),
        canonicalRulesSnapshotSha: canonicalIdentity.rules_snapshot_sha,
      };

      const prepared = decisions.map((input, index) => {
        requirePlainObject(input, `decisions[${index}]`);
        for (const key of Object.keys(input)) {
          if (key === 'acceptance') {
            fail(ERROR_CODES.INVALID_REQUEST, 'decisions[].acceptance is computed by this service from the inputs that are loaded now and must not be supplied.', { index });
          }
          if (!CALLER_DECISION_KEYS.has(key)) fail(ERROR_CODES.INVALID_REQUEST, `decisions[${index}].${key} is not an accepted decision field`, { accepted: [...CALLER_DECISION_KEYS] });
        }
        const who = input.acceptedBy ?? acceptedBy;
        if (!who) fail(ERROR_CODES.INVALID_REQUEST, 'acceptedBy must name who accepted the decision.', { index });
        const { acceptedBy: _ignoredWho, note, ...rest } = input;
        return {
          ...rest,
          id: input.id ?? `dec:${index + 1}`,
          acceptance: {
            ...bindings,
            acceptedBy: requireString(who, 'acceptedBy', { max: 120 }),
            ...(note === undefined || note === null ? {} : { note: requireString(note, 'note', { max: 500 }) }),
          },
        };
      });

      // Deliberately not wrapped in a try: `applyAcceptedArrangement` throws
      // only on a malformed call shape, and rejecting a decision *set* is a
      // returned status with codes, not an exception. Converting the latter
      // into an error would hide the per-decision reasons a reviewer needs.
      const application = engines.arrangement.applyAcceptedArrangement({
        baseline: project,
        suggestion,
        parent,
        decisions: prepared,
        canonicalIdentity,
      });

      if (application.status !== 'PASS' || !application.candidate) {
        return {
          applied: false,
          status: application.status,
          candidate_id: null,
          baseline_id: baseline.baseline_id,
          parent_candidate_id: parentCandidateId,
          rejected: application.rejected ?? [],
          conflicts: application.conflicts ?? [],
          diagnostics: application.diagnostics ?? [],
          notice: application.notice ?? null,
        };
      }

      const candidateId = application.revision.id;
      const entry = {
        candidate_id: candidateId,
        parent_candidate_id: parentCandidateId,
        baseline_id: baseline.baseline_id,
        revision_index: application.revision.index,
        created_at: now(),
        decision_count: prepared.length,
        decision_ids: prepared.map(decision => decision.id),
        accepted_by: [...new Set(prepared.map(decision => decision.acceptance.acceptedBy))],
        // Internal provenance, written in the same record write as the entry:
        // which explicit input this application was applying, and which
        // ATTEMPT at a step produced it. Neither is part of the revision
        // identity and neither is a Canonical rule.
        input_fingerprint: inputFingerprint,
        effect_attempt_id: effectAttemptId,
      };

      store.putJson(applicationKey(record.project_id, candidateId), application);
      projects.save({
        ...record,
        candidates: [...record.candidates.filter(existing => existing.candidate_id !== candidateId), entry],
      });

      return {
        applied: true,
        status: application.status,
        candidate_id: candidateId,
        baseline_id: baseline.baseline_id,
        parent_candidate_id: parentCandidateId,
        revision_index: application.revision.index,
        decision_count: prepared.length,
        rejected: application.rejected ?? [],
        conflicts: application.conflicts ?? [],
        diagnostics: application.diagnostics ?? [],
        diff_from_baseline: application.diffFromBaseline ?? null,
        notice: 'Applied faithfully, deterministically and traceably. The candidate must still be reviewed: an application PASS certifies no acceptance gate.',
      };
    },
  });
}

// The suggestion's own role map, reduced to identities and counts. The full
// lane spans, metrics and evidence stay in the suggestion a human reads in the
// Studio; a model deciding what to do next needs the shape, not every span.
function summarizeRoles(suggestion) {
  const roles = suggestion?.roles;
  if (!roles || typeof roles !== 'object') return null;
  return Object.fromEntries(Object.entries(roles).map(([role, entry]) => [role, {
    role,
    group: entry.group ?? null,
    status: entry.status ?? null,
    lane_ids: [...(entry.laneIds ?? [])],
    event_count: entry.eventIds?.length ?? 0,
  }]));
}

// Pending role candidates are reported with their blockers and never resolved.
// A model that wants one resolved has to send a decision that states it.
function summarizePending(suggestion) {
  const pending = Array.isArray(suggestion?.pending) ? suggestion.pending : [];
  return {
    count: pending.length,
    lanes: pending.map(entry => ({
      lane_id: entry.laneId ?? null,
      proposed_role: entry.proposedRole ?? null,
      blockers: [...(entry.blockers ?? [])],
      event_ids: [...(entry.eventIds ?? [])],
      cross_source: entry.crossSource ?? false,
    })),
    notice: 'PENDING is a state, not a default. This service never converts it to keep, omit or move, and never guesses the evidence a decision would need.',
  };
}
