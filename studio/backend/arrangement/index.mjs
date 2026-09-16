// Arrangement facade (G11-B decomposition, G11-C role candidates). This layer
// operates after the Source-Faithful Baseline exists; it never replaces source
// intake or Published Canonical.

export {
  splitCanonicalVoice,
  splitProjectSourceVoices,
  VOICE_SPLIT_STATUS,
} from './voice-split.mjs';

// G11-C. Consumes the G11-A baseline plus the G11-B lanes above and proposes
// six-role candidates. It suggests roles; it never accepts an arrangement, and
// it emits no Final MML.
export {
  suggestRoleCandidates,
  ROLE_CANDIDATE_STATUS,
  ROLE_CANDIDATE_THRESHOLDS,
  ROLE_DECISIONS,
  SIX_ROLES,
  CORE3_ROLE_NAMES,
  ENRICHMENT_ROLE_NAMES,
} from './role-candidates.mjs';

// G11-D. Consumes the G11-A baseline, the G11-B lanes, the G11-C lane identity
// and an explicitly accepted decision set, and produces a new derived Candidate
// Canonical project plus its revision record. It accepts no suggestion on its
// own, mutates no baseline, emits no Final MML and certifies no gate.
//
// `G11-D` is an implementation stage name used by this repository's pipeline
// and roadmap documents. It is not a Published Canonical rule identifier.
export {
  applyAcceptedArrangement,
  createAcceptedDecision,
  createArrangementRevision,
  revisionIdentityMatches,
  baselineIdentityOf,
  laneDecompositionDigestOf,
  decisionSetDigestOf,
  derivedDuplicateEventId,
  canonicalJson,
  contentDigest,
  ACCEPTED_DECISION_TYPES,
  RECOGNIZED_UNSUPPORTED_DECISION_TYPES,
  DECISION_REJECTION,
  CONFLICT_CODES,
  DOWNSTREAM_CONTRACT,
  DECISION_APPLICATION_STATUS,
} from './decision-application.mjs';
