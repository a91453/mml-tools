// Who submitted a stored Lead evidence review, what the evidence in it can
// prove, and whether the shared Lead grader may consume it.
//
// History. A stored review once carried no statement of who made it or how its
// audio classification was established, so a review written from F0/CQT
// metrics was graded exactly like a direct review of the recording: a lower
// evidence layer impersonating a higher one (MASTER_RULES §11), an audio metric
// acting as positive role evidence (SOURCE_POLICY §6). The first fix (f020b95)
// made every new review carry an attestation and handed only `human`
// attestations to the grader. That closed the metric hole with the wrong key:
// Published Canonical names no reviewer species for Lead evidence (SOURCE_POLICY
// §1 and §4 grade *sources*; §6 limits *metrics*; only ACCEPTANCE Gate 10 binds
// an actor), the service cannot tell who typed a request anyway, and the same
// citation from an MCP-connected model was refused while a free-text claim
// labelled `human` counted.
//
// Now authority comes from the evidence itself, the same way for every
// submitter:
//
//   * provenance — `attestation.reviewer` and `reviewer_kind` (human, agent,
//     tool, mcp-client, imported) are required, recorded beside the
//     authenticated owner, and never read by the grader;
//   * method — `attestation.audio_basis` says how an audio classification was
//     established; a `machine-metric` basis is carried into the audio evidence
//     so the grader never counts it as positive role evidence (§6);
//   * source — each classified score/audio item names the project source it
//     cites (`ref`), resolved against the project's evidence registry: only an
//     official score or the original recording the project holds, independent
//     of every supporting file, may prove a role (§1A/§1B); third-party or
//     derived material is supporting only (§1C), and a citation naming nothing
//     the project holds proves nothing.
//
// A review with no attestation (recorded before attestations existed) states
// neither who made it nor how its audio classification was established; it
// stays on record for the audit trail and is not graded. The service verifies
// the cited source and the stated method; it cannot verify that anybody read
// the source, whoever they are, and nothing here claims it does.

export const LEAD_REVIEW_REVIEWER_KINDS = Object.freeze(['human', 'agent', 'tool', 'mcp-client', 'imported']);
// `listening` and `direct-source-review` both mean the classification was read
// from the recording itself; they grade identically.
export const LEAD_REVIEW_AUDIO_BASES = Object.freeze(['listening', 'direct-source-review', 'machine-metric', 'not-used']);

export const LEAD_REVIEW_AUTHORITY = Object.freeze({
  // Provenance and method stated: graded by the shared Lead grader on its
  // evidence, whoever submitted it.
  GRADED_ON_EVIDENCE: 'GRADED_ON_EVIDENCE',
  UNATTESTED_LEGACY: 'UNATTESTED_LEGACY_NOT_REVIEWER_EVIDENCE',
});

// Why a classified score/audio item is or is not source evidence.
export const LEAD_EVIDENCE_SOURCE_REFUSAL = Object.freeze({
  NOT_CITED: 'LEAD_EVIDENCE_SOURCE_NOT_CITED',
  REF_UNKNOWN: 'LEAD_EVIDENCE_REFERENCE_NOT_IN_PROJECT',
  BYTES_NOT_HELD: 'LEAD_EVIDENCE_REFERENCE_NOT_BACKED_BY_PROJECT_BYTES',
  NOT_INDEPENDENT: 'LEAD_EVIDENCE_SOURCE_NOT_INDEPENDENT',
  SUPPORTING_ONLY: 'LEAD_EVIDENCE_SOURCE_SUPPORTING_ONLY',
  KIND_MISMATCH: 'LEAD_EVIDENCE_SOURCE_KIND_DOES_NOT_MATCH',
  NO_REGISTRY: 'LEAD_EVIDENCE_SOURCES_NOT_RESOLVABLE',
});

const nonEmpty = value => typeof value === 'string' && value.trim().length > 0;
const plain = value => value !== null && typeof value === 'object' && !Array.isArray(value);
// Available and classified, read exactly the way the shared grader reads it:
// an absent or null availability means available.
const audioIsClassified = audio => plain(audio)
  && (audio.availability ?? 'available') !== 'unavailable'
  && (audio.classification ?? 'unknown') !== 'unknown';

/**
 * Validate a submitted attestation against the Lead evidence it accompanies.
 * Returns `{ ok, attestation?, error? }`; never throws.
 */
export function validateLeadReviewAttestation(attestation, leadEvidence) {
  if (!plain(attestation)) {
    return { ok: false, error: `review.attestation is required: { reviewer, reviewer_kind: ${LEAD_REVIEW_REVIEWER_KINDS.join('|')}, audio_basis: ${LEAD_REVIEW_AUDIO_BASES.join('|')} }. A Lead evidence review states who submitted it and how any audio classification was established; who submitted it does not change its grade.` };
  }
  const reviewer = attestation.reviewer;
  if (!nonEmpty(reviewer) || reviewer.length > 200) return { ok: false, error: 'review.attestation.reviewer must name who submitted this review (1-200 characters).' };
  if (!LEAD_REVIEW_REVIEWER_KINDS.includes(attestation.reviewer_kind)) {
    return { ok: false, error: `review.attestation.reviewer_kind must be one of ${LEAD_REVIEW_REVIEWER_KINDS.join(', ')}.` };
  }
  if (!LEAD_REVIEW_AUDIO_BASES.includes(attestation.audio_basis)) {
    return { ok: false, error: `review.attestation.audio_basis must be one of ${LEAD_REVIEW_AUDIO_BASES.join(', ')}.` };
  }
  const audioClassified = audioIsClassified(leadEvidence?.audioEvidence);
  if (audioClassified && attestation.audio_basis === 'not-used') {
    return { ok: false, error: 'review.attestation.audio_basis cannot be not-used while lead_evidence.audioEvidence carries a classification. State whether it came from a direct review of the recording or from a machine metric.' };
  }
  if (!audioClassified && attestation.audio_basis !== 'not-used') {
    return { ok: false, error: 'review.attestation.audio_basis must be not-used when lead_evidence.audioEvidence carries no classification.' };
  }
  return {
    ok: true,
    attestation: Object.freeze({
      reviewer: reviewer.trim(),
      reviewer_kind: attestation.reviewer_kind,
      audio_basis: attestation.audio_basis === 'direct-source-review' ? 'listening' : attestation.audio_basis,
    }),
  };
}

/**
 * Classify a stored review entry (store shape: snake_case). An entry is graded
 * when it states who submitted it and how its audio classification was
 * established; the kind of submitter is not consulted.
 */
export function leadReviewAuthorityOf(entry) {
  const attestation = entry?.attestation;
  if (!plain(attestation) || !nonEmpty(attestation.reviewer)
    || !LEAD_REVIEW_REVIEWER_KINDS.includes(attestation.reviewer_kind)
    || !LEAD_REVIEW_AUDIO_BASES.includes(attestation.audio_basis)) return LEAD_REVIEW_AUTHORITY.UNATTESTED_LEGACY;
  return LEAD_REVIEW_AUTHORITY.GRADED_ON_EVIDENCE;
}

// What one classified item's cited source may prove, from the registry entry.
function resolveItem(item, kind, registry) {
  if (!plain(item) || item.availability === 'unavailable' || (item.classification ?? 'unknown') === 'unknown') return null;
  const ref = typeof item.ref === 'string' ? item.ref.trim() : '';
  const expected = kind === 'score' ? 'primary-symbolic' : 'primary-audio';
  const decide = (sourceAuthority, reason, entry = null) => Object.freeze({ ref: ref || null, sourceAuthority, reason, sourceClass: entry?.sourceClass ?? null, kind: entry?.kind ?? null });
  if (!registry) return decide('unresolved', LEAD_EVIDENCE_SOURCE_REFUSAL.NO_REGISTRY);
  if (!ref) return decide('unresolved', LEAD_EVIDENCE_SOURCE_REFUSAL.NOT_CITED);
  const entry = registry.get(ref);
  if (!entry) return decide('unresolved', LEAD_EVIDENCE_SOURCE_REFUSAL.REF_UNKNOWN);
  switch (entry.sourceClass) {
    case expected: return decide('primary', null, entry);
    case 'bytes-not-held': return decide('unresolved', LEAD_EVIDENCE_SOURCE_REFUSAL.BYTES_NOT_HELD, entry);
    case 'not-independent': return decide('supporting', LEAD_EVIDENCE_SOURCE_REFUSAL.NOT_INDEPENDENT, entry);
    case 'supporting': return decide('supporting', LEAD_EVIDENCE_SOURCE_REFUSAL.SUPPORTING_ONLY, entry);
    default: return decide('unresolved', LEAD_EVIDENCE_SOURCE_REFUSAL.KIND_MISMATCH, entry);
  }
}

/**
 * The Lead evidence as the grader must see it, and why. The stated audio method
 * is carried into the audio evidence (a `machine-metric` basis is never positive
 * role evidence), and each classified score/audio citation is resolved against
 * the project's current evidence registry into a `sourceAuthority` the grader
 * reads. Nothing about the submitter is consulted.
 */
export function gradedLeadEvidenceOf(leadEvidence, attestation, registry = undefined) {
  if (!plain(leadEvidence)) return { leadEvidence, sources: null };
  const next = { ...leadEvidence };
  // The stated method always decides, never a `basis` inside the evidence. A
  // classified audio item whose method is not a direct review of the recording
  // is a metric as far as the grader is concerned -- including an entry whose
  // attestation says `not-used`, which a stored or hand-edited record can carry.
  if (audioIsClassified(leadEvidence.audioEvidence)) {
    next.audioEvidence = { ...leadEvidence.audioEvidence, basis: attestation?.audio_basis === 'listening' ? 'listening' : 'machine-metric' };
  } else if (plain(leadEvidence.audioEvidence) && (attestation?.audio_basis === 'machine-metric' || attestation?.audio_basis === 'listening')) {
    next.audioEvidence = { ...leadEvidence.audioEvidence, basis: attestation.audio_basis };
  }
  // `registry === undefined` means the caller does not resolve sources (the
  // historical shape); `null` means it tried and could not, which fails closed.
  if (registry === undefined) return { leadEvidence: next, sources: null };
  const sources = {};
  for (const [kind, key] of [['score', 'scoreEvidence'], ['audio', 'audioEvidence']]) {
    const resolved = resolveItem(next[key], kind, registry);
    if (!resolved) continue;
    sources[kind] = resolved;
    next[key] = { ...next[key], sourceAuthority: resolved.sourceAuthority };
  }
  return { leadEvidence: next, sources: Object.freeze(sources) };
}
