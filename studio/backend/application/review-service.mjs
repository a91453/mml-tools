// Evidence persistence adapter around the unchanged Canonical review engine.
// No gate, confidence threshold, role judgement or confirmation policy lives here.
// The original implementation is retained byte-for-byte in review-service-core.mjs.
import { createReviewService as createCoreReviewService } from './review-service-core.mjs';
import { ERROR_CODES, fail, isCandidateId } from './contracts.mjs';
import {
  readAudioHistory, activeAudioEntries, appendAudioReport,
  unpackAudioSubmission, exportAudioHistory,
} from './audio-report-history.mjs';
export {
  gatesFrom, CONFIRMATIONS, CONFIRMATION_SCOPE, PLAYER_READBACK_VALUES, STALE_CONFIRMATION,
} from './review-service-core.mjs';

const guarded = operation => {
  try { return operation(); }
  catch (error) { fail(ERROR_CODES.INVALID_REQUEST, error.message); }
};
const hasLeadEvidence = value => {
  if (!value || typeof value !== 'object') return false;
  if ((Object.hasOwn(value, 'leadEvidence') && value.leadEvidence != null)
      || (Object.hasOwn(value, 'lead_evidence') && value.lead_evidence != null)) return true;
  return Object.values(value).some(hasLeadEvidence);
};

export function createReviewService(dependencies) {
  const { canonical, projects, arrangement, store } = dependencies;
  const keyFor = (projectId, candidateId) => `audio:${projectId}:${candidateId}`;
  const historyFor = (record, candidateId) => guarded(() => readAudioHistory(
    store.getJson(keyFor(record.project_id, candidateId)), candidateId, record.audio_evidence ?? [],
  ));

  // Both review and finalize use the original core.context. Present its expected
  // raw-report array, selecting only the explicit head of each recording chain.
  // The underlying store retains all revisions; no gate reads the index cache.
  const coreStore = {
    ...store,
    getJson(key) {
      const stored = store.getJson(key);
      if (!key.startsWith('audio:') || stored == null || Array.isArray(stored)) return stored;
      const candidateId = key.split(':').slice(2).join(':');
      const history = guarded(() => readAudioHistory(stored, candidateId));
      return activeAudioEntries(history).map(entry => structuredClone(entry.report));
    },
  };
  const core = createCoreReviewService({ ...dependencies, store: coreStore });
  const indexOf = (history, candidateId) => exportAudioHistory(history).entries.map(entry => ({
    candidate_id: candidateId, audio_sha256: entry.audio_sha256,
    schema: entry.report.schema, confidence: entry.report.alignment?.metrics?.confidence ?? null,
    warnings: [...entry.warnings], attached_at: entry.attached_at,
    report_sha256: entry.report_sha256, supersedes_report_sha256: entry.supersedes_report_sha256,
    active: entry.active, submitted_by: entry.submitted_by,
    authenticated_owner: entry.authenticated_owner,
  }));

  // v1 deliberately supports pre-review candidates only. There is no safe way
  // to infer whether a free-text reviewer citation depends on the replaced
  // alignment. Until explicit dependency invalidation exists, refuse rather
  // than retaining a potentially stale approval. This never weakens a gate.
  const requireUnreviewedCandidate = (record, candidateId) => {
    const confirmations = Object.values(record.confirmations ?? {}).some(entry =>
      entry?.candidate_id === candidateId && (entry.value === true || entry.value === 'PASS'));
    const core3 = store.getJson(`core3-approvals:${record.project_id}:${candidateId}`);
    const lead = store.getJson(`lead-evidence-reviews:${record.project_id}:${candidateId}`);
    const lineage = arrangement.loadCandidateLineage(record, candidateId);
    if (confirmations || (Array.isArray(core3) && core3.length) || (Array.isArray(lead) && lead.length)
        || hasLeadEvidence(lineage) || (record.artifacts ?? []).length) {
      fail(ERROR_CODES.INVALID_REQUEST,
        'Audio revision requires coordinated invalidation of existing reviews/artifacts; this version only revises unreviewed candidates. Nothing was changed.',
        { candidate_id: candidateId, reason: 'AUDIO_REVISION_REVIEW_DEPENDENCIES' });
    }
  };

  return Object.freeze({
    ...core,
    async attachAudioAlignment(owner, projectId, { candidateId, report: submission }) {
      if (!isCandidateId(candidateId)) fail(ERROR_CODES.CANDIDATE_NOT_FOUND, 'Unknown candidate');
      // Ownership is resolved before exporting or inspecting any report history.
      const record = projects.load(owner, projectId);
      const engines = await canonical.engines();
      const { application } = arrangement.loadCandidate(record, candidateId);
      const { report, revision } = guarded(() => unpackAudioSubmission(submission));
      let validation;
      try { validation = engines.audio.validateAudioAlignmentReport(report, application.candidate); }
      catch (error) {
        fail(ERROR_CODES.UNSUPPORTED_SOURCE, `Audio alignment report rejected: ${error.message}`, { candidate_id: candidateId });
      }
      if (revision) {
        const audioSha = String(report.audio.sha256).toLowerCase();
        if (!(record.assets ?? []).some(asset => asset.kind === 'original_audio' && asset.sha256 === audioSha)) {
          fail(ERROR_CODES.INVALID_REQUEST, 'A revision must refer to an original_audio asset held by this project.');
        }
        const candidateRules = application.revision?.canonicalIdentity?.rules_snapshot_sha;
        const currentRules = engines.emitterContract.canonicalIdentity().rules_snapshot_sha;
        if (!candidateRules || candidateRules !== currentRules) {
          fail(ERROR_CODES.INVALID_REQUEST, 'Audio revision candidate uses a different rules snapshot.');
        }
      }
      const history = historyFor(record, candidateId);
      const result = guarded(() => appendAudioReport(history, {
        report, revision, authenticatedOwner: owner,
        warnings: [...validation.warnings], at: new Date().toISOString(),
      }));
      if (revision && !result.replayed) requireUnreviewedCandidate(record, candidateId);
      if (!result.replayed) {
        // Single authoritative, atomic store write: old entries and new head
        // change together. Project audio_evidence below is only a projection.
        store.putJson(keyFor(record.project_id, candidateId), result.history);
      }
      const current = projects.load(owner, projectId);
      const projected = [
        ...(current.audio_evidence ?? []).filter(entry => entry.candidate_id !== candidateId),
        ...indexOf(result.history, candidateId),
      ];
      // Repairs a failed projection write on an exact replay. No second report
      // is appended; a complete retry with a current index performs no writes.
      if (JSON.stringify(projected) !== JSON.stringify(current.audio_evidence ?? [])) {
        projects.save({ ...current, audio_evidence: projected });
      }
      const evidence = indexOf(result.history, candidateId).find(entry => entry.report_sha256 === result.entry.report_sha256);
      return Object.freeze({
        evidence: Object.freeze(evidence), replayed: result.replayed,
        report_sha256: result.entry.report_sha256,
        notice: 'An explicit evidence revision is not a gate result. Original reports and warnings remain in review.audio.history. Review/finalize recompute from the selected report; no symbolic event, confirmation, Lead review or in-game result was authored.',
      });
    },
    async review(owner, projectId, input = {}) {
      const result = await core.review(owner, projectId, input);
      const record = projects.load(owner, projectId);
      const history = historyFor(record, input.candidateId);
      return {
        ...result,
        audio: {
          ...result.audio,
          evidence: indexOf(history, input.candidateId),
          history: exportAudioHistory(history),
        },
      };
    },
  });
}
