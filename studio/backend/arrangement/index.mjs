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
