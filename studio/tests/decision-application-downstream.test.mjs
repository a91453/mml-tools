import test from 'node:test';
import assert from 'node:assert/strict';
import {
  applyAcceptedArrangement,
  DECISION_APPLICATION_STATUS,
} from '../backend/arrangement/decision-application.mjs';
import {
  reviewAppliedCandidate,
  leadDemotionReportsFromApplication,
  leadPromotionReportsFromApplication,
} from '../backend/arrangement/decision-review.mjs';
import { suggestRoleCandidates } from '../backend/arrangement/role-candidates.mjs';
import {
  roleDeclaredBaseline,
  acceptanceFor,
  leadDemotionEvidence,
  leadPromotionEvidence,
  CANONICAL_IDENTITY,
  SECOND_SOURCE_ID,
} from './fixtures/g11d-fixtures.mjs';

// What has to still be true after a successful application.
//
// G11-D's job ends at "the accepted decisions were applied faithfully". These
// regressions are the other half of that sentence: the Lead, Core3 and
// cross-source gates must still be able to block a candidate that G11-D was
// perfectly right to produce.

const baseline = roleDeclaredBaseline();
const suggestion = suggestRoleCandidates(baseline);
const accept = () => acceptanceFor(baseline, { suggestion });

const apply = decisions => applyAcceptedArrangement({
  baseline, suggestion, decisions, canonicalIdentity: CANONICAL_IDENTITY,
});

const omit = (id, eventIds, extra = {}) => ({
  id, type: 'OMIT_FROM_SIX', target: { eventIds },
  reason: 'Reviewed: not carried into the six roles.', evidence: ['fixture:review'], acceptance: accept(), ...extra,
});

// ─── L. Core3 is never complete because roles are filled ────────────────────

test('G11-D reports no Core3 verdict of its own', () => {
  const result = apply([{
    id: 'k1', type: 'KEEP', target: { eventIds: ['lead-1', 'harm-1', 'bass-1'] },
    reason: 'Reviewed: Core3 as it stands.', evidence: ['fixture:review'], acceptance: accept(),
  }]);
  assert.equal(result.status, 'PASS');
  assert.equal(DECISION_APPLICATION_STATUS.certifiesCore3Complete, false);
  assert.equal(DECISION_APPLICATION_STATUS.certifiesReadiness, false);
  assert.equal('core3' in result, false, 'the application result publishes no Core3 field to be mistaken for a verdict');
  assert.equal('readiness' in result, false);
  assert.ok(result.downstream.mustRerun.some(item => item.includes('core3')));
});

test('omitting Core3 material is applied, and then blocked by the Core3 gate', () => {
  const result = apply([omit('o1', ['harm-1'])]);
  assert.equal(result.status, 'PASS', 'the accepted decision is legal, so G11-D applies it');

  const review = reviewAppliedCandidate({ application: result, baseline });
  assert.equal(review.core3FromBaseline.status, 'PENDING');
  assert.ok(review.core3FromBaseline.blockers.includes('UNAPPROVED_CORE3_SOURCE_CHANGE'));
  assert.ok(review.core3FromBaseline.removedCore3.some(item => item.event.id === 'harm-1'));
  assert.equal(review.readiness.gates.core3.status, 'PENDING');
  assert.ok(review.readiness.preGameBlocking.includes('core3'));
  assert.equal(review.readiness.candidateReady, false);
});

test('omitting the essential bass is blocked the same way', () => {
  const review = reviewAppliedCandidate({ application: apply([omit('o1', ['bass-1', 'bass-2'])]), baseline });
  assert.equal(review.core3FromBaseline.status, 'PENDING');
  assert.deepEqual(
    review.core3FromBaseline.removedCore3.map(item => item.event.id).sort(),
    ['bass-1', 'bass-2'],
  );
  assert.ok(review.readiness.preGameBlocking.includes('core3'));
});

test('an enrichment role cannot compensate for removed Core3 material', () => {
  // Chord1 is emptied and the same material is re-placed in Chord4. The role
  // count looks healthy; Core3 is not.
  const result = apply([{
    id: 'm1', type: 'MOVE_ROLE', target: { eventIds: ['harm-1', 'harm-2'] },
    fromRole: 'Chord1', toRole: 'Chord4',
    reason: 'Reviewed: moved to enrichment.', evidence: ['fixture:review'], acceptance: accept(),
  }]);
  assert.equal(result.status, 'PASS');
  assert.equal(result.candidate.events.some(event => event.role === 'Chord1'), false);

  const review = reviewAppliedCandidate({ application: result, baseline });
  assert.equal(review.core3FromBaseline.status, 'PENDING');
  assert.ok(review.core3FromBaseline.roleMovesFromCore3.some(item => item.before.id === 'harm-1' && item.leavesCore3));
  assert.ok(review.readiness.preGameBlocking.includes('core3'));
});

// ─── K. Lead regressions ────────────────────────────────────────────────────

test('a Lead demotion that G11-D applied still needs its evidence at the readiness gate', () => {
  const result = apply([{
    id: 'm1', type: 'MOVE_ROLE', target: { eventIds: ['lead-1'] },
    fromRole: 'Melody', toRole: 'Chord3',
    reason: 'Reviewed: inner-staff doubling, not the lead.',
    evidence: ['fixture:score inner staff'],
    leadEvidence: leadDemotionEvidence(),
    acceptance: accept(),
  }]);
  assert.equal(result.status, 'PASS');

  // With no reports handed to readiness, the Lead gate fails closed on the
  // Lead role move the baseline diff found.
  const unevidenced = reviewAppliedCandidate({ application: result, baseline });
  assert.equal(unevidenced.readiness.gates.leadDemotion.status, 'PENDING');
  assert.ok(unevidenced.readiness.gates.leadDemotion.blockers.includes('LEAD_DEMOTION_EVIDENCE_REQUIRED'));
  assert.ok(unevidenced.readiness.gates.leadDemotion.pendingEventIds.includes('lead-1'));

  // With the reports the accepted evidence actually supports, the gate passes
  // -- because evaluateLeadDemotion said so, not because G11-D did.
  const reports = leadDemotionReportsFromApplication(result, baseline);
  assert.equal(reports.length, 1);
  assert.equal(reports[0].status, 'PASS');
  const evidenced = reviewAppliedCandidate({ application: result, baseline, leadDemotionReports: reports });
  assert.equal(evidenced.readiness.gates.leadDemotion.status, 'PASS');
  // ...and the song is still not ready, on every other gate.
  assert.equal(evidenced.readiness.candidateReady, false);
});

test('a lawful Lead promotion is independently re-graded at readiness', () => {
  const result = apply([{
    id: 'p1', type: 'ASSIGN_ROLE', target: { eventIds: ['tex-1'] }, toRole: 'Melody',
    reason: 'Reviewed: the cited texture becomes the foreground instrumental lead here.',
    evidence: ['fixture:score top line', 'fixture:audio foreground'],
    leadEvidence: leadPromotionEvidence(),
    acceptance: accept(),
  }]);
  assert.equal(result.status, 'PASS');

  const unevidenced = reviewAppliedCandidate({ application: result, baseline });
  assert.equal(unevidenced.readiness.gates.leadDemotion.status, 'N/A');
  assert.equal(unevidenced.readiness.gates.leadPromotion.status, 'PENDING');
  assert.ok(unevidenced.readiness.gates.leadPromotion.blockers.includes('LEAD_PROMOTION_EVIDENCE_REQUIRED'));
  assert.deepEqual(unevidenced.readiness.gates.leadPromotion.pendingEventIds, ['tex-1']);

  const reports = leadPromotionReportsFromApplication(result, baseline);
  assert.equal(reports.length, 1);
  assert.equal(reports[0].status, 'PASS');
  assert.equal(reports[0].eventId, 'tex-1');
  assert.equal(reports[0].originEventId, 'tex-1');

  const evidenced = reviewAppliedCandidate({
    application: result,
    baseline,
    leadPromotionReports: reports,
  });
  assert.equal(evidenced.readiness.gates.leadPromotion.status, 'PASS');
});

test('a duplicate promoted into Melody is graded under its derived candidate event id', () => {
  const result = apply([{
    id: 'p2', type: 'DUPLICATE_WITH_JUSTIFICATION', target: { eventIds: ['harm-1'] }, toRoles: ['Melody'],
    reason: 'Reviewed: this cited harmony voice doubles as the foreground lead in the section.',
    evidence: ['fixture:score top line', 'fixture:audio foreground'],
    leadEvidence: leadPromotionEvidence({ sourceEventId: 'fixture:symbolic#harm-1' }),
    acceptance: accept(),
  }]);
  assert.equal(result.status, 'PASS');

  const reports = leadPromotionReportsFromApplication(result, baseline);
  assert.equal(reports.length, 1);
  assert.equal(reports[0].status, 'PASS');
  assert.equal(reports[0].originEventId, 'harm-1');
  assert.notEqual(reports[0].eventId, 'harm-1');
  assert.equal(result.candidate.events.find(event => event.id === reports[0].eventId)?.role, 'Melody');

  const review = reviewAppliedCandidate({
    application: result,
    baseline,
    leadPromotionReports: reports,
  });
  assert.ok(review.readiness.gates.baseline.leadEventDiff.added.includes(reports[0].eventId));
  assert.equal(review.readiness.gates.leadPromotion.status, 'PASS');
});

test('omitting a Melody event leaves a source-supported Lead gap the Core3 gate finds', () => {
  const result = apply([omit('o1', ['lead-2'], {
    fromRole: 'Melody',
    leadEvidence: leadDemotionEvidence({ sourceEventId: 'fixture:symbolic#lead-2' }),
  })]);
  assert.equal(result.status, 'PASS');

  const review = reviewAppliedCandidate({ application: result, baseline });
  assert.ok(review.core3FromBaseline.blockers.includes('SOURCE_SUPPORTED_LEAD_GAP'));
  const gap = review.core3FromBaseline.falseLeadGaps.find(item => item.baselineEventId === 'lead-2');
  assert.ok(gap, 'the window the omitted Lead event used to cover is reported');
  assert.equal(review.readiness.candidateReady, false);

  // Approving the demotion does not clear the gap: another accepted Lead event
  // has to cover the window.
  const approved = reviewAppliedCandidate({
    application: result,
    baseline,
    leadDemotionReports: leadDemotionReportsFromApplication(result, baseline),
    core3ApprovedChanges: [{ type: 'remove', eventId: 'lead-2', reason: 'Reviewed: doubled elsewhere.', evidence: ['fixture:review'] }],
  });
  assert.ok(approved.core3FromBaseline.blockers.includes('SOURCE_SUPPORTED_LEAD_GAP'));
});

test('the Lead gate is not satisfied by a report for some other event', () => {
  const result = apply([{
    id: 'm1', type: 'MOVE_ROLE', target: { eventIds: ['lead-3'] },
    fromRole: 'Melody', toRole: 'Chord3',
    reason: 'Reviewed: inner-staff doubling.',
    evidence: ['fixture:score'],
    leadEvidence: leadDemotionEvidence({ sourceEventId: 'fixture:symbolic#lead-3' }),
    acceptance: accept(),
  }]);
  const foreign = [{ status: 'PASS', pass: true, eventId: 'lead-1', destinationRole: 'Chord3', blockers: [], warnings: [] }];
  const review = reviewAppliedCandidate({ application: result, baseline, leadDemotionReports: foreign });
  assert.equal(review.readiness.gates.leadDemotion.status, 'PENDING');
  assert.ok(review.readiness.gates.leadDemotion.pendingEventIds.includes('lead-3'));
});

// ─── cross-source arbitration still runs on the applied candidate ───────────

test('a cross-source collision the decisions created is reported by the harmony gate', () => {
  const crossBaseline = roleDeclaredBaseline({ extraSource: true });
  const crossSuggestion = suggestRoleCandidates(crossBaseline);
  const result = applyAcceptedArrangement({
    baseline: crossBaseline,
    suggestion: crossSuggestion,
    canonicalIdentity: CANONICAL_IDENTITY,
    decisions: [{
      id: 'a1', type: 'ASSIGN_ROLE', target: { eventIds: ['alt-1'] }, toRole: 'Chord4',
      reason: 'Reviewed: the third-party inner voice is accepted as enrichment.',
      evidence: ['fixture:third-party midi'],
      acceptance: acceptanceFor(crossBaseline, { suggestion: crossSuggestion }),
    }],
  });
  assert.equal(result.status, 'PASS', 'G11-D applies the decision; compatibility is not its question');

  const review = reviewAppliedCandidate({ application: result, baseline: crossBaseline });
  assert.equal(review.harmony.status, 'PENDING');
  const collision = review.harmony.unresolved.find(item =>
    [item.leftEventId, item.rightEventId].includes('alt-1') && item.kind === 'cross-source-same-pitch');
  assert.ok(collision, 'the same-pitch doubling between two sources is reported');
  assert.equal(collision.core3Threat, true, 'Chord1 against Chord4 is a Core3 threat');
  assert.deepEqual([...collision.leftAuthorities, ...collision.rightAuthorities].sort(), ['primary-symbolic', 'supporting']);
  assert.ok(review.readiness.preGameBlocking.includes('crossSourceHarmony'));

  // The conflict is a review signal, not a deletion: both events are present.
  assert.ok(result.candidate.events.some(event => event.id === 'alt-1'));
  assert.ok(result.candidate.events.some(event => event.id === 'harm-1'));
  assert.equal(result.candidate.sources.some(source => source.id === SECOND_SOURCE_ID), true);
});

test('an accepted arrangement decision cannot resolve a harmony conflict by existing', () => {
  const crossBaseline = roleDeclaredBaseline({ extraSource: true });
  const crossSuggestion = suggestRoleCandidates(crossBaseline);
  const result = applyAcceptedArrangement({
    baseline: crossBaseline,
    suggestion: crossSuggestion,
    canonicalIdentity: CANONICAL_IDENTITY,
    decisions: [{
      id: 'a1', type: 'ASSIGN_ROLE', target: { eventIds: ['alt-1'] }, toRole: 'Chord4',
      reason: 'Reviewed: accepted as enrichment.',
      evidence: ['fixture:third-party midi'],
      acceptance: acceptanceFor(crossBaseline, { suggestion: crossSuggestion }),
    }],
  });
  // G11-D writes no accepted arbitration decision into the candidate, so the
  // harmony analyzer has nothing to read as a resolution.
  assert.deepEqual([...result.candidate.decisions], []);
  const review = reviewAppliedCandidate({ application: result, baseline: crossBaseline });
  assert.equal(review.harmony.unresolvedCount > 0, true);
  for (const conflict of review.harmony.conflicts) assert.equal(conflict.resolved, false);
});

// ─── the Final emitter consumes the applied candidate directly ──────────────

test('an applied candidate is consumable by the existing Final MML emitter', async () => {
  const { emitFinalMml } = await import('../backend/final/index.mjs');
  const result = apply([{
    id: 'a1', type: 'ASSIGN_ROLE', target: { eventIds: ['tex-1', 'tex-2'] }, toRole: 'Chord3',
    reason: 'Reviewed: texture accepted as enrichment.', evidence: ['fixture:review'], acceptance: accept(),
  }]);
  assert.equal(result.status, 'PASS');

  // G11-D emitted nothing. The existing emitter takes the candidate as it is,
  // with no adapter, no re-shaping and no second identity system.
  const emitted = emitFinalMml(result.candidate);
  assert.equal(emitted.status, 'PASS');
  assert.equal(emitted.canonical.rules_snapshot_sha, CANONICAL_IDENTITY.rules_snapshot_sha);
  assert.deepEqual(emitted.roles.map(role => role.role), ['Melody', 'Chord1', 'Chord2', 'Chord3', 'Chord4', 'Chord5']);
});

test('material nobody accepted makes the emitter fail closed rather than disappear', () => {
  const result = apply([{
    id: 'k1', type: 'KEEP', target: { eventIds: ['lead-1'] },
    reason: 'Reviewed: Melody as it stands.', evidence: ['fixture:review'], acceptance: accept(),
  }]);
  assert.equal(result.status, 'PASS');
  assert.ok(result.diagnostics.some(item => item.code === 'UNASSIGNED_MATERIAL_RETAINED'));

  // This is the point of retaining it. Six-role capacity is a capacity fact,
  // so G11-D keeps the material and the emitter refuses to serialize a project
  // with an event nobody placed -- instead of the material being dropped to
  // make an emission succeed.
  return import('../backend/final/index.mjs').then(({ emitFinalMml }) => {
    const emitted = emitFinalMml(result.candidate);
    assert.equal(emitted.status, 'FAIL');
    assert.ok(emitted.diagnostics.some(item => item.code === 'EVENT_ROLE_UNASSIGNED'));
  });
});
