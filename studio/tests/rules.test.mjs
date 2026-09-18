import test from 'node:test';
import assert from 'node:assert/strict';
import {
  EFFECTIVE_RULESET,
  STUDIO_IMPLEMENTATION,
  auditLegacyRuleDrift,
  studioFinalBlockers,
  assertRulesReadyForFinal,
} from '../backend/rules/index.mjs';

test('executable contract explicitly implements the published Canonical rules rather than defining them', () => {
  assert.equal(EFFECTIVE_RULESET.status, 'implements-published-canonical');
  assert.equal(EFFECTIVE_RULESET.authority.executableContractDefinesRules, false);
  assert.ok(EFFECTIVE_RULESET.authority.humanReadable.includes('docs/MASTER_RULES.md'));
});

test('Mobile contract separates official ranges from preferred/caution Final policy', () => {
  assert.equal(EFFECTIVE_RULESET.mobileSyntax.tempoMin, 32);
  assert.equal(EFFECTIVE_RULESET.mobileSyntax.tempoMax, 255);
  assert.equal(EFFECTIVE_RULESET.mobileSyntax.officialLengthMin, 1);
  assert.equal(EFFECTIVE_RULESET.mobileSyntax.officialLengthMax, 64);
  assert.equal(EFFECTIVE_RULESET.mobileSyntax.shortestSafeDenominator, 64);
  assert.ok(EFFECTIVE_RULESET.mobileSyntax.preferredLengthDenominators.includes(64));
  assert.equal(EFFECTIVE_RULESET.mobileSyntax.numericNoteInputSupported, true);
  assert.equal(EFFECTIVE_RULESET.mobileSyntax.numericNoteFinalPolicy, 'opt-in-with-evidence');
  assert.equal(EFFECTIVE_RULESET.mobileSyntax.numericNoteDefaultFinalAllowed, false);
});

test('Final synchronization policy is explicit while engine necessity remains pending', () => {
  assert.equal(EFFECTIVE_RULESET.synchronization.sameInitialTempoOnEveryNonEmptyRole, true);
  assert.equal(EFFECTIVE_RULESET.synchronization.duplicateFullTempoMapOnEveryNonEmptyRole, true);
  assert.equal(EFFECTIVE_RULESET.synchronization.emptyRolesStayEmpty, true);
  assert.equal(EFFECTIVE_RULESET.synchronization.engineNecessityStillPending, true);
  assert.equal(EFFECTIVE_RULESET.synchronization.crossRoleEndTimeMismatch, 'review-warning');
});

test('arrangement contract preserves mandatory baseline, Core3 and evidence-first Lead role', () => {
  assert.equal(EFFECTIVE_RULESET.sources.sourceFaithfulBaselineRequiredBeforeReduction, true);
  assert.equal(EFFECTIVE_RULESET.sources.silentRoleMovesForbidden, true);
  assert.deepEqual(EFFECTIVE_RULESET.arrangement.core3, ['Melody', 'Chord1', 'Chord2']);
  assert.match(EFFECTIVE_RULESET.arrangement.core3Meaning.Chord2, /Essential Inner/i);
  assert.equal(EFFECTIVE_RULESET.arrangement.leadIsNotVocalOnly, true);
  assert.equal(EFFECTIVE_RULESET.arrangement.leadDemotionRequiresPositiveEvidence, true);
  assert.equal(EFFECTIVE_RULESET.arrangement.unresolvedLeadDemotion, 'FAIL_OR_PENDING');
  // And no promotion counterpart: the published release states the positive-
  // evidence requirement for demotion only, so declaring a symmetric promotion
  // policy here would be this contract inventing a Canonical rule. The Lead
  // Promotion Gate is an IMPLEMENTER signal instead, asserted below.
  assert.equal('leadPromotionRequiresPositiveEvidence' in EFFECTIVE_RULESET.arrangement, false);
  assert.equal('unresolvedLeadPromotion' in EFFECTIVE_RULESET.arrangement, false);
  assert.equal(EFFECTIVE_RULESET.arrangement.full6MustNotReduceCore3Completeness, true);
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
  assert.ok(drift.some(item => item.id === 'LEGACY_REJECTS_CAUTION_LENGTH_48'));
  assert.equal(STUDIO_IMPLEMENTATION.currentRuleMmlParser, true);
});

test('tested symbolic, arbitration and original-audio modules are active', () => {
  assert.equal(STUDIO_IMPLEMENTATION.musicXmlIngestion, true);
  assert.equal(STUDIO_IMPLEMENTATION.sourceAwareMmlNormalization, true);
  assert.equal(STUDIO_IMPLEMENTATION.versionDriftReport, true);
  assert.equal(STUDIO_IMPLEMENTATION.core3ContinuityGate, true);
  assert.equal(STUDIO_IMPLEMENTATION.leadDemotionGate, true);
  assert.equal(STUDIO_IMPLEMENTATION.leadPromotionGate, true);
  assert.equal(STUDIO_IMPLEMENTATION.originalAudioAlignment, true);
  assert.equal(STUDIO_IMPLEMENTATION.crossSourceHarmonyArbitration, true);
});

test('implementation-level Final blockers are empty after all required modules are implemented', () => {
  const blockers = studioFinalBlockers();
  assert.deepEqual(blockers, []);
  assert.ok(!blockers.some(id => id.includes('LEGACY')));
  assert.equal(assertRulesReadyForFinal(), true);
});

test('Lead promotion grader is a fail-closed Final implementation requirement', () => {
  const withoutPromotion = { ...STUDIO_IMPLEMENTATION, leadPromotionGate: false };
  assert.deepEqual(studioFinalBlockers(withoutPromotion), ['LEAD_PROMOTION_GATE_PENDING']);
});


test('module readiness does not imply any song-specific Final PASS', () => {
  assert.deepEqual(studioFinalBlockers(), []);
  assert.equal(EFFECTIVE_RULESET.gates.includes('original-audio-ab'), true);
  assert.equal(EFFECTIVE_RULESET.gates.includes('player-readback'), true);
  assert.equal(EFFECTIVE_RULESET.gates.includes('regression'), true);
  assert.equal(EFFECTIVE_RULESET.gates.includes('in-game'), true);
});
