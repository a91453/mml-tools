import test from 'node:test';
import assert from 'node:assert/strict';
import { EFFECTIVE_RULESET, auditLegacyRuleDrift, assertRulesReadyForFinal } from '../backend/rules/index.mjs';

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

test('known legacy parser drift is visible and blocks Studio Final Gate', () => {
  const drift = auditLegacyRuleDrift();
  assert.ok(drift.some(item => item.id === 'LEGACY_REJECTS_64'));
  assert.ok(drift.some(item => item.id === 'LEGACY_ACCEPTS_T256_PLUS'));
  assert.throws(() => assertRulesReadyForFinal(), /Studio Final Gate blocked/);
});
