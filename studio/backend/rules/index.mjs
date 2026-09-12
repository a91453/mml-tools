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
    // 64/r64 are legal. Sub-1/64 timing remains outside the safe final grid.
    allowedLengthDenominators: Object.freeze([1, 2, 3, 4, 6, 8, 12, 16, 24, 32, 64]),
    shortestSafeDenominator: 64,
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

export function assertRulesReadyForFinal() {
  const drift = auditLegacyRuleDrift();
  if (drift.length) {
    const ids = drift.map(item => item.id).join(', ');
    throw Error(`Studio Final Gate blocked: legacy rule drift unresolved (${ids})`);
  }
  return true;
}
