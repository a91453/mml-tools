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

test('Studio Final Gate stays blocked only for still-unimplemented musical/source gates', () => {
  const blockers = studioFinalBlockers();
  assert.ok(blockers.includes('MUSICXML_INGESTION_PENDING'));
  assert.ok(blockers.includes('VERSION_DRIFT_REPORT_PENDING'));
  assert.ok(blockers.includes('CORE3_CONTINUITY_GATE_PENDING'));
  assert.ok(!blockers.some(id => id.includes('LEGACY')));
  assert.throws(() => assertRulesReadyForFinal(), /Studio Final Gate blocked/);
});
