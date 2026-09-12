import test from 'node:test';
import assert from 'node:assert/strict';
import {
  EFFECTIVE_RULESET,
  STUDIO_IMPLEMENTATION,
  auditLegacyRuleDrift,
  studioFinalBlockers,
  assertRulesReadyForFinal,
} from '../backend/rules/index.mjs';

test('effective Mobile rule contract uses current syntax boundaries', () => {
  assert.equal(EFFECTIVE_RULESET.mobileSyntax.tempoMin, 32);
  assert.equal(EFFECTIVE_RULESET.mobileSyntax.tempoMax, 255);
  assert.equal(EFFECTIVE_RULESET.mobileSyntax.shortestSafeDenominator, 64);
  assert.ok(EFFECTIVE_RULESET.mobileSyntax.allowedLengthDenominators.includes(64));
  assert.equal(EFFECTIVE_RULESET.mobileSyntax.rejectNCommandInFinal, true);
});

test('effective arrangement contract preserves Core3 and evidence-first lead role', () => {
  assert.deepEqual(EFFECTIVE_RULESET.arrangement.core3, ['Melody', 'Chord1', 'Chord2']);
  assert.equal(EFFECTIVE_RULESET.arrangement.leadIsNotVocalOnly, true);
  assert.equal(EFFECTIVE_RULESET.arrangement.leadDemotionRequiresPositiveEvidence, true);
  assert.equal(EFFECTIVE_RULESET.arrangement.samePitchOverlapIsReviewNotAutoDelete, true);
  assert.equal(EFFECTIVE_RULESET.arrangement.simultaneousAttackDensityIsReviewNotAutoDelete, true);
});

test('Midify is not a Studio gate and preview L:1/4 is not a composition rule', () => {
  assert.equal(EFFECTIVE_RULESET.tools.midifyIsGate, false);
  assert.equal(EFFECTIVE_RULESET.preview.abcBaseLength, '1/4');
  assert.equal(EFFECTIVE_RULESET.preview.abcBaseLengthIsPreviewConventionOnly, true);
});

test('known legacy parser drift remains visible but is not the Studio parser', () => {
  const drift = auditLegacyRuleDrift();
  assert.ok(drift.some(item => item.id === 'LEGACY_REJECTS_64'));
  assert.ok(drift.some(item => item.id === 'LEGACY_ACCEPTS_T256_PLUS'));
  assert.equal(STUDIO_IMPLEMENTATION.currentRuleMmlParser, true);
});

test('tested symbolic, arbitration and original-audio modules are active', () => {
  assert.equal(STUDIO_IMPLEMENTATION.musicXmlIngestion, true);
  assert.equal(STUDIO_IMPLEMENTATION.sourceAwareMmlNormalization, true);
  assert.equal(STUDIO_IMPLEMENTATION.versionDriftReport, true);
  assert.equal(STUDIO_IMPLEMENTATION.core3ContinuityGate, true);
  assert.equal(STUDIO_IMPLEMENTATION.leadDemotionGate, true);
  assert.equal(STUDIO_IMPLEMENTATION.originalAudioAlignment, true);
  assert.equal(STUDIO_IMPLEMENTATION.crossSourceHarmonyArbitration, true);
});

test('implementation-level Final blockers are empty after all required modules are implemented', () => {
  const blockers = studioFinalBlockers();
  assert.deepEqual(blockers, []);
  assert.ok(!blockers.some(id => id.includes('LEGACY')));
  assert.equal(assertRulesReadyForFinal(), true);
});

test('module readiness does not imply any song-specific Final PASS', () => {
  assert.deepEqual(studioFinalBlockers(), []);
  assert.equal(EFFECTIVE_RULESET.gates.includes('original-audio-ab'), true);
  assert.equal(EFFECTIVE_RULESET.gates.includes('player-readback'), true);
  assert.equal(EFFECTIVE_RULESET.gates.includes('in-game'), true);
});
