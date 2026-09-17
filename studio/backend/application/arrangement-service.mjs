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
// other, will not resolve a `PENDING` on a caller's behalf, will not accept a
// Lead demotion because one was suggested, and will not invent the evidence a
// demotion requires. An agent that wants a decision applied has to state the
// decision.
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
const CALLER_DECISION_KEYS = new Set(['id', 'type', 'target', 'fromRole', 'toRole', 'toRoles', 'reason', 'evidence', 'section', 'leadEvidence', 'metadata', 'acceptedBy', 'note']);

export function createArrangementService({ canonical, projects, intake, store }) {
  const suggestionKey = (projectId, baselineId) => `suggestion:${projectId}:${baselineId}`;
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
    const key = suggestionKey(record.project_id, baseline.baseline_id);
    const cached = refresh ? null : store.getJson(key);
    if (cached) return { engines, record, baseline, project, suggestion: cached };

    const decompositions = engines.arrangement.splitProjectSourceVoices(project);
    const suggestion = engines.arrangement.suggestRoleCandidates(project, { decompositions });
    store.putJson(key, suggestion);
    return { engines, record, baseline, project, suggestion, decompositions };
  };

  const loadCandidate = (record, candidateId) => {
    if (!isCandidateId(candidateId)) fail(ERROR_CODES.CANDIDATE_NOT_FOUND, 'Unknown candidate', { candidate_id: String(candidateId).slice(0, 96) });
    const entry = record.candidates.find(candidate => candidate.candidate_id === candidateId);
    if (!entry) fail(ERROR_CODES.CANDIDATE_NOT_FOUND, 'Unknown candidate', { candidate_id: candidateId, project_id: record.project_id });
    const application = store.getJson(applicationKey(record.project_id, candidateId));
    if (!application?.candidate || !application?.revision) fail(ERROR_CODES.CANDIDATE_NOT_FOUND, 'The stored candidate is no longer available', { candidate_id: candidateId });
    return { entry, application, candidate: application.candidate, revision: application.revision };
  };

  return Object.freeze({
    suggestionFor,
    loadCandidate,

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
    async applyDecisions(owner, projectId, { decisions, parentCandidateId = null, acceptedBy = null } = {}) {
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
