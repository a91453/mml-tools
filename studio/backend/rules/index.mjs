import { parseTrack as legacyParseTrack } from '../../../dist/core.js';

export const EFFECTIVE_RULESET = Object.freeze({
  id: 'mabinogi-mobile-mml-studio-rules-2026-09-13',
  status: 'effective',
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
    octaveMin: 0,
    octaveMax: 8,
    volumeMin: 0,
    volumeMax: 15,
    allowedLengthDenominators: Object.freeze([1, 2, 3, 4, 6, 8, 12, 16, 24, 32, 64]),
    shortestSafeDenominator: 64,
    maxDottedBaseDenominator: 32,
    rejectDenominators: Object.freeze([48, 128]),
    rejectMultipleDots: true,
    rejectDottedTripletShorthand: Object.freeze([3, 6, 12, 24, 48]),
    rejectNCommandInFinal: true,
    rejectZeroDuration: true,
    rejectTechnicalMicroGapsBelow64: true,
    preserveMeaningfulRests: true,
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
  }),
  arrangement: Object.freeze({
    leadRole: 'Melody',
    core3: Object.freeze(['Melody', 'Chord1', 'Chord2']),
    core3Meaning: Object.freeze({ Melody: 'Lead', Chord1: 'Core Harmony', Chord2: 'Core Bass' }),
    enrichment: Object.freeze(['Chord3', 'Chord4', 'Chord5']),
    leadIsNotVocalOnly: true,
    leadDemotionRequiresPositiveEvidence: true,
    preserveSourceRoleUntilResolved: true,
    samePitchOverlapIsReviewNotAutoDelete: true,
    lowMidM2M7IsReviewNotAutoDelete: true,
    simultaneousAttackDensityIsReviewNotAutoDelete: true,
    continuityRepairRequiresSourceEvidence: true,
    doNotFillTrueRestsForStatistics: true,
  }),
  tools: Object.freeze({
    midify: 'N/A-by-default',
    midifyIsGate: false,
    selectedPlayerReadbackMustBeReal: true,
    noAppliedTrueEqualsPass: true,
  }),
  gates: Object.freeze(['technical', 'source', 'player-readback', 'original-audio-ab', 'mobile-adaptation', 'in-game']),
});

export const STUDIO_IMPLEMENTATION = Object.freeze({
  currentRuleMmlParser: true,
  exactRationalTiming: true,
  crossTrackReview: true,
  // Supports score-partwise MusicXML with exact duration/divisions timing and
  // explicit completeness flags. Repeats/navigation, grace realization,
  // transposing parts, microtones and unpitched mapping remain fail-closed.
  musicXmlIngestion: true,
  sourceAwareMmlNormalization: true,
  versionDriftReport: true,
  core3ContinuityGate: true,
  leadDemotionGate: true,
  // Python 3.12 worker: FFmpeg decode -> chroma -> DTW -> beat/time and Tempo-drift
  // evidence, plus a Node bridge that attaches reports without mutating symbolic events.
  originalAudioAlignment: true,
  crossSourceHarmonyArbitration: true,
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

  return Object.freeze(findings);
}

// These blockers describe whether the Studio implementation has the required
// modules. An empty array never certifies a song. Song-specific readiness is
// evaluated separately by backend/final/readiness.mjs.
export function studioFinalBlockers() {
  const required = [
    ['musicXmlIngestion', 'MUSICXML_INGESTION_PENDING'],
    ['sourceAwareMmlNormalization', 'SOURCE_AWARE_MML_NORMALIZATION_PENDING'],
    ['versionDriftReport', 'VERSION_DRIFT_REPORT_PENDING'],
    ['core3ContinuityGate', 'CORE3_CONTINUITY_GATE_PENDING'],
    ['leadDemotionGate', 'LEAD_DEMOTION_GATE_PENDING'],
    ['originalAudioAlignment', 'ORIGINAL_AUDIO_ALIGNMENT_PENDING'],
    ['crossSourceHarmonyArbitration', 'CROSS_SOURCE_HARMONY_PENDING'],
  ];
  return Object.freeze(required.filter(([key]) => !STUDIO_IMPLEMENTATION[key]).map(([, id]) => id));
}

export function assertRulesReadyForFinal() {
  const blockers = studioFinalBlockers();
  if (blockers.length) throw Error(`Studio Final implementation blocked: ${blockers.join(', ')}`);
  return true;
}
