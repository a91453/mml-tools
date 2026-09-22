// Who stands behind a stored Lead evidence review, and whether the shared Lead
// grader may consume it.
//
// A Lead evidence review is a candidate-bound *reviewer* record
// (capabilities: "never_agent_settlable ... a Lead evidence citation"). Before
// this module, a stored review carried no statement of who made it or how its
// audio classification was established, so a review written by an agent from
// F0/CQT metrics was graded exactly like a human listening review. That let a
// lower evidence layer impersonate a higher one (MASTER_RULES §11), and let an
// audio metric act as positive role evidence (SOURCE_POLICY §6).
//
// The service cannot authenticate *what kind* of reviewer typed a request: a
// human and an MCP-connected model reach it under the same owner credential.
// So the fix is representational and fail-closed:
//
//   * every new review must carry an explicit `attestation` naming the
//     reviewer, the reviewer kind and the basis of any audio classification,
//     and the authenticated owner is recorded beside it by the server;
//   * only a `human` attestation is handed to the grader, and a
//     `machine-metric` audio basis is handed through so the grader never counts
//     it as positive role evidence;
//   * agent/tool reviews and historical reviews that carry no attestation stay
//     on record, unchanged, for the audit trail -- they are reported as not
//     counted, never deleted and never rewritten.
//
// An attestation is caller-declared text, like `submitted_by` on audio
// evidence. It makes a false claim of human review an explicit, recorded,
// attributable statement rather than an implicit default; it does not prove a
// human listened, and nothing here claims it does.

export const LEAD_REVIEW_REVIEWER_KINDS = Object.freeze(['human', 'agent', 'tool']);
export const LEAD_REVIEW_AUDIO_BASES = Object.freeze(['listening', 'machine-metric', 'not-used']);

export const LEAD_REVIEW_AUTHORITY = Object.freeze({
  HUMAN_ATTESTED: 'HUMAN_ATTESTED',
  AGENT_OR_TOOL: 'AGENT_OR_TOOL_NOT_REVIEWER_EVIDENCE',
  UNATTESTED_LEGACY: 'UNATTESTED_LEGACY_NOT_REVIEWER_EVIDENCE',
});

const nonEmpty = value => typeof value === 'string' && value.trim().length > 0;

/**
 * Validate a submitted attestation against the Lead evidence it accompanies.
 * Returns `{ ok, attestation?, error? }`; never throws.
 */
export function validateLeadReviewAttestation(attestation, leadEvidence) {
  if (!attestation || typeof attestation !== 'object' || Array.isArray(attestation)) {
    return { ok: false, error: 'review.attestation is required: { reviewer, reviewer_kind: human|agent|tool, audio_basis: listening|machine-metric|not-used }. A Lead evidence review states who made it and how any audio classification was established.' };
  }
  const reviewer = attestation.reviewer;
  if (!nonEmpty(reviewer) || reviewer.length > 200) return { ok: false, error: 'review.attestation.reviewer must name who made this review (1-200 characters).' };
  if (!LEAD_REVIEW_REVIEWER_KINDS.includes(attestation.reviewer_kind)) {
    return { ok: false, error: `review.attestation.reviewer_kind must be one of ${LEAD_REVIEW_REVIEWER_KINDS.join(', ')}.` };
  }
  if (!LEAD_REVIEW_AUDIO_BASES.includes(attestation.audio_basis)) {
    return { ok: false, error: `review.attestation.audio_basis must be one of ${LEAD_REVIEW_AUDIO_BASES.join(', ')}.` };
  }
  const audioAvailable = leadEvidence?.audioEvidence?.availability === 'available'
    || (leadEvidence?.audioEvidence && leadEvidence.audioEvidence.availability === undefined);
  const audioClassified = audioAvailable && (leadEvidence?.audioEvidence?.classification ?? 'unknown') !== 'unknown';
  if (audioClassified && attestation.audio_basis === 'not-used') {
    return { ok: false, error: 'review.attestation.audio_basis cannot be not-used while lead_evidence.audioEvidence carries a classification. State whether it came from listening or from a machine metric.' };
  }
  if (!audioClassified && attestation.audio_basis !== 'not-used') {
    return { ok: false, error: 'review.attestation.audio_basis must be not-used when lead_evidence.audioEvidence carries no classification.' };
  }
  return {
    ok: true,
    attestation: Object.freeze({
      reviewer: reviewer.trim(),
      reviewer_kind: attestation.reviewer_kind,
      audio_basis: attestation.audio_basis,
    }),
  };
}

/** Classify a stored review entry (store shape: snake_case). */
export function leadReviewAuthorityOf(entry) {
  const attestation = entry?.attestation;
  if (!attestation || typeof attestation !== 'object') return LEAD_REVIEW_AUTHORITY.UNATTESTED_LEGACY;
  if (attestation.reviewer_kind === 'human') return LEAD_REVIEW_AUTHORITY.HUMAN_ATTESTED;
  return LEAD_REVIEW_AUTHORITY.AGENT_OR_TOOL;
}

/**
 * The Lead evidence as the grader must see it: a machine-metric audio basis is
 * carried into the audio evidence so the grader cannot count it positively.
 */
export function gradedLeadEvidenceOf(leadEvidence, attestation) {
  if (!leadEvidence || typeof leadEvidence !== 'object') return leadEvidence;
  if (attestation?.audio_basis !== 'machine-metric' && attestation?.audio_basis !== 'listening') return leadEvidence;
  if (!leadEvidence.audioEvidence || typeof leadEvidence.audioEvidence !== 'object') return leadEvidence;
  return { ...leadEvidence, audioEvidence: { ...leadEvidence.audioEvidence, basis: attestation.audio_basis } };
}
