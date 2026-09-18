import { parseTrack as legacyParseTrack } from '../../../dist/core.js';
import { loadPublishedCanonical } from '../bootstrap/index.mjs';

// An executable implementation must opt into a new release explicitly; reading
// a newer repository HEAD must never relabel these unchanged policy values.
export const PUBLISHED_CANONICAL = loadPublishedCanonical({ supportedCanonicalVersion: '2026-09-13-v1' });

export const EFFECTIVE_RULESET = Object.freeze({
  id: 'mabinogi-mobile-mml-canonical-v1-2026-09-13',
  status: 'implements-published-canonical',
  canonical: PUBLISHED_CANONICAL.metadata,
  authority: PUBLISHED_CANONICAL.authority,
  principles: Object.freeze([
    'source-faithful-baseline-first',
    'source-complete-before-six-track-reduction',
    'symbolic-and-audio-truth-remain-separate',
    'core3-before-full6-enrichment',
    'mobile-minimal-adaptation-last',
    'no-statistical-overcleaning',
    'version-drift-must-be-auditable',
  ]),
  mobileSyntax: Object.freeze({
    perTrackCharacterLimit: 2400,
    tempoMin: 32,
    tempoMax: 255,
    officialLengthMin: 1,
    officialLengthMax: 64,
    preferredLengthDenominators: Object.freeze([1, 2, 4, 8, 16, 32, 64]),
    cautionPlainLengthsWithinOfficialRange: true,
    shortestSafeDenominator: 64,
    preferredDottedBaseDenominators: Object.freeze([1, 2, 4, 8, 16, 32]),
    rejectDottedBasesInFinal: Object.freeze([3, 6, 12, 24, 48, 64]),
    rejectMultipleDots: true,
    numericNoteInputSupported: true,
    numericNoteMin: 0,
    numericNoteMax: 107,
    numericNoteFinalPolicy: 'opt-in-with-evidence',
    numericNoteDefaultFinalAllowed: false,
    rejectZeroDuration: true,
    // G10. These three values are the executable echo of MOBILE_SYNTAX §4 /
    // §11 step 5 and MASTER_RULES §7, and they are read — not merely
    // declared — by backend/final/micro-gap-enforcement.mjs, which applies the
    // Final micro-gap policy for both the readiness gate and any future
    // Canonical-aware Final emitter. `shortestSafeDenominator` above is the
    // same echo for the 1/64 safe grid. Changing any of them does not relax the
    // published rule: the enforcement module reports a non-conformant contract
    // and fails closed.
    rejectTechnicalMicroGapsBelow64: true,
    preserveMeaningfulRests: true,
    octaveTokenRangeIsImplementationMapping: true,
    octaveMin: 0,
    octaveMax: 8,
    volumeMin: 0,
    volumeMax: 15,
  }),
  synchronization: Object.freeze({
    sameInitialTempoOnEveryNonEmptyRole: true,
    duplicateFullTempoMapOnEveryNonEmptyRole: true,
    emptyRolesStayEmpty: true,
    policyClass: 'FINAL_CANONICAL_POLICY',
    engineNecessityStillPending: true,
    crossRoleEndTimeMismatch: 'review-warning',
  }),
  preview: Object.freeze({
    abcBaseLength: '1/4',
    abcBaseLengthIsPreviewConventionOnly: true,
    requireIndependentConductor: true,
    requireFullExpansion: true,
    requireExactBarsAndTies: true,
    requireTempoMapAgreement: true,
    durationSanityTolerancePercent: 2,
  }),
  sources: Object.freeze({
    symbolicTruth: Object.freeze(['official-score', 'official-musicxml', 'trusted-official-midi']),
    audioTruth: Object.freeze(['original-official-audio']),
    supportingOnly: Object.freeze(['third-party-score', 'third-party-musicxml', 'third-party-midi', 'third-party-mml']),
    audioPurpose: Object.freeze(['foreground-background-role', 'articulation', 'sustain', 'prominence', 'tempo-drift', 'recording-structure']),
    symbolicPurpose: Object.freeze(['pitch', 'onset', 'duration', 'written-voicing', 'staff-voice', 'repeat-structure']),
    sourceFaithfulBaselineRequiredBeforeReduction: true,
    silentRoleMovesForbidden: true,
  }),
  arrangement: Object.freeze({
    leadRole: 'Melody',
    core3: Object.freeze(['Melody', 'Chord1', 'Chord2']),
    core3Meaning: Object.freeze({
      Melody: 'Lead',
      Chord1: 'Core Harmony / principal accompaniment / essential response',
      Chord2: 'Core Bass skeleton + essential inner voice when required',
    }),
    enrichment: Object.freeze(['Chord3', 'Chord4', 'Chord5']),
    leadIsNotVocalOnly: true,
    leadDemotionRequiresPositiveEvidence: true,
    unresolvedLeadDemotion: 'FAIL_OR_PENDING',
    preserveSourceRoleUntilResolved: true,
    samePitchOverlapIsReviewNotAutoDelete: true,
    lowMidM2M7IsReviewNotAutoDelete: true,
    simultaneousAttackDensityIsReviewNotAutoDelete: true,
    continuityRepairRequiresSourceEvidence: true,
    doNotFillTrueRestsForStatistics: true,
    full6MustNotReduceCore3Completeness: true,
  }),
  tools: Object.freeze({
    midify: 'N/A-by-default',
    midifyIsGate: false,
    selectedPlayerReadbackMustBeReal: true,
    noAppliedTrueEqualsPass: true,
  }),
  gates: Object.freeze(['technical', 'source', 'player-readback', 'original-audio-ab', 'mobile-adaptation', 'regression', 'in-game']),
});

export const STUDIO_IMPLEMENTATION = Object.freeze({
  currentRuleMmlParser: true,
  exactRationalTiming: true,
  crossTrackReview: true,
  musicXmlIngestion: true,
  sourceAwareMmlNormalization: true,
  versionDriftReport: true,
  core3ContinuityGate: true,
  leadDemotionGate: true,
  leadPromotionGate: true,
  originalAudioAlignment: true,
  crossSourceHarmonyArbitration: true,
  // G10 C2B: the source-aware micro-timing readiness gate exists as a module.
  // This is an IMPLEMENTER signal only. It defines no Canonical rule and never
  // certifies that any song's sub-1/64 timing is source-supported.
  sourceAwareMicroTimingGate: true,
});

export function auditLegacyRuleDrift() {
  const findings = [];
  const c64 = legacyParseTrack('t120o4c64', 'Melody');
  if (c64.errors.length) findings.push(Object.freeze({
    id: 'LEGACY_REJECTS_64',
    severity: 'P0',
    expected: 'c64/r64/L64 are legal at the 1/64 boundary',
    actual: c64.errors.map(error => error.message),
  }));

  const t256 = legacyParseTrack('t256o4c4', 'Melody');
  if (!t256.errors.some(error => /Tempo|T256|32/.test(error.message))) findings.push(Object.freeze({
    id: 'LEGACY_ACCEPTS_T256_PLUS',
    severity: 'P0',
    expected: 'Tempo above 255 is rejected for Mobile final delivery',
    actual: 'legacy parser accepts T256',
  }));

  const c48 = legacyParseTrack('t120o4c48', 'Melody');
  if (c48.errors.length) findings.push(Object.freeze({
    id: 'LEGACY_REJECTS_CAUTION_LENGTH_48',
    severity: 'P1',
    expected: 'plain 48 is ingestible and Final-allowed only through the caution policy',
    actual: c48.errors.map(error => error.message),
  }));

  return Object.freeze(findings);
}

export const STUDIO_FINAL_MODULE_BLOCKERS = Object.freeze([
  Object.freeze(['musicXmlIngestion', 'MUSICXML_INGESTION_PENDING']),
  Object.freeze(['sourceAwareMmlNormalization', 'SOURCE_AWARE_MML_NORMALIZATION_PENDING']),
  Object.freeze(['versionDriftReport', 'VERSION_DRIFT_REPORT_PENDING']),
  Object.freeze(['core3ContinuityGate', 'CORE3_CONTINUITY_GATE_PENDING']),
  Object.freeze(['leadDemotionGate', 'LEAD_DEMOTION_GATE_PENDING']),
  Object.freeze(['leadPromotionGate', 'LEAD_PROMOTION_GATE_PENDING']),
  Object.freeze(['originalAudioAlignment', 'ORIGINAL_AUDIO_ALIGNMENT_PENDING']),
  Object.freeze(['crossSourceHarmonyArbitration', 'CROSS_SOURCE_HARMONY_PENDING']),
  Object.freeze(['sourceAwareMicroTimingGate', 'SOURCE_AWARE_MICRO_TIMING_GATE_PENDING']),
]);

// These blockers describe whether the Studio implementation has the required
// modules. An empty array never certifies a song. Song-specific readiness is
// evaluated separately by backend/final/readiness.mjs.
//
// `implementation` is an injection point for regressions that need to observe a
// removed or disabled capability. Production callers pass nothing.
export function studioFinalBlockers(implementation = STUDIO_IMPLEMENTATION) {
  return Object.freeze(
    STUDIO_FINAL_MODULE_BLOCKERS.filter(([key]) => !implementation?.[key]).map(([, id]) => id),
  );
}

export function assertRulesReadyForFinal() {
  const blockers = studioFinalBlockers();
  if (blockers.length) throw Error(`Studio Final implementation blocked: ${blockers.join(', ')}`);
  return true;
}
