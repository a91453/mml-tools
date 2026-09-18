// Lead evidence across the revision lineage.
//
// The readiness Lead gates derive what needs evidence from the candidate-versus-
// Source-Faithful-baseline diff, which accumulates for the life of a project. The
// evidence itself is recorded on the one revision that performed the role move,
// and `metadata.g11d` deliberately does not inherit across revisions. Reading a
// single revision therefore loses the evidence for every earlier move: a
// revision that merely KEEPs an already-promoted event produced no report at
// all, and the gate could never be cleared again, because G11-D correctly
// refuses to re-apply a move that has already happened.
//
// These regressions pin the recovery and -- just as importantly -- its limits.
// Nothing here may carry a previous PASS forward: every surviving report is a
// fresh grade from the shared Lead gate, and a candidate whose event identity,
// destination role or Core3 context has moved sends the evidence back to
// PENDING for re-review.

import test from 'node:test';
import assert from 'node:assert/strict';
import { applyAcceptedArrangement } from '../backend/arrangement/decision-application.mjs';
import {
  applicationLineage,
  reviewAppliedCandidate,
  leadDemotionReportsFromApplication,
  leadDemotionReportsFromLineage,
  leadPromotionReportsFromApplication,
  leadPromotionReportsFromLineage,
  LEAD_EVIDENCE_LINEAGE_BLOCKERS,
} from '../backend/arrangement/decision-review.mjs';
import { suggestRoleCandidates } from '../backend/arrangement/role-candidates.mjs';
import {
  roleDeclaredBaseline,
  acceptanceFor,
  leadDemotionEvidence,
  leadPromotionEvidence,
  CANONICAL_IDENTITY,
} from './fixtures/g11d-fixtures.mjs';

const baseline = roleDeclaredBaseline();
const suggestion = suggestRoleCandidates(baseline);

const applyFirst = decisions => applyAcceptedArrangement({
  baseline, suggestion, decisions, canonicalIdentity: CANONICAL_IDENTITY,
});

const applyNext = (parent, decisions) => applyAcceptedArrangement({
  baseline,
  suggestion,
  canonicalIdentity: CANONICAL_IDENTITY,
  parent: { revision: parent.revision, candidate: parent.candidate },
  decisions: decisions.map(decision => ({
    ...decision,
    acceptance: acceptanceFor(baseline, { suggestion, reviewedRevisionId: parent.revision.id }),
  })),
});

const accept = () => acceptanceFor(baseline, { suggestion });

// Revision 1: a lawful Chord-to-Melody promotion with complete positive
// evidence. `tex-1` carries no baseline role, so ASSIGN_ROLE is the lawful move.
const promoteTex1 = () => applyFirst([{
  id: 'p1', type: 'ASSIGN_ROLE', target: { eventIds: ['tex-1'] }, toRole: 'Melody',
  reason: 'Reviewed: the cited texture becomes the foreground instrumental lead here.',
  evidence: ['fixture:score top line', 'fixture:audio foreground'],
  leadEvidence: leadPromotionEvidence(),
  acceptance: accept(),
}]);

// Revision 1: a lawful Lead demotion with complete positive evidence.
const demoteLead1 = () => applyFirst([{
  id: 'd1', type: 'MOVE_ROLE', target: { eventIds: ['lead-1'] },
  fromRole: 'Melody', toRole: 'Chord3',
  reason: 'Reviewed: inner-staff doubling, not the lead.',
  evidence: ['fixture:score inner staff'],
  leadEvidence: leadDemotionEvidence(),
  acceptance: accept(),
}]);

const keep = (id, eventIds) => ({
  id, type: 'KEEP', target: { eventIds },
  reason: 'Reviewed: carried unchanged into this revision.',
  evidence: ['fixture:review'],
});

const reportsFor = (applications, head) => ({
  promotion: leadPromotionReportsFromLineage({ applications, baseline, candidate: head.candidate }),
  demotion: leadDemotionReportsFromLineage({ applications, baseline, candidate: head.candidate }),
});

// ─── the reproduction ───────────────────────────────────────────────────────

test('a no-op KEEP revision does not erase an earlier promotion evidence chain', () => {
  const first = promoteTex1();
  assert.equal(first.status, 'PASS');
  assert.equal(leadPromotionReportsFromApplication(first, baseline)[0].status, 'PASS');

  // Revision 2 keeps the already-promoted Melody event unchanged.
  const second = applyNext(first, [keep('k1', ['tex-1'])]);
  assert.equal(second.status, 'PASS');
  assert.equal(second.candidate.events.find(event => event.id === 'tex-1').role, 'Melody');

  // The single-revision reading is what produced the block: revision 2 performed
  // no promotion, so it carries no promotion evidence...
  assert.deepEqual(leadPromotionReportsFromApplication(second, baseline), []);
  const lost = reviewAppliedCandidate({ application: second, baseline, leadPromotionReports: [] });
  assert.equal(lost.readiness.gates.leadPromotion.status, 'PENDING');
  assert.ok(lost.readiness.gates.leadPromotion.blockers.includes('LEAD_PROMOTION_EVIDENCE_REQUIRED'));

  // ...while the requirement never goes away, because the baseline diff still
  // shows tex-1 arriving in Melody. Reading the lineage recovers the evidence
  // and re-grades it against the current candidate.
  const { promotion } = reportsFor([first, second], second);
  assert.equal(promotion.length, 1);
  assert.equal(promotion[0].status, 'PASS');
  assert.equal(promotion[0].eventId, 'tex-1');
  assert.equal(promotion[0].originEventId, 'tex-1');
  assert.equal(promotion[0].gradedFromRevisionId, first.revision.id, 'the report names the revision whose evidence it re-graded');

  const recovered = reviewAppliedCandidate({ application: second, baseline, leadPromotionReports: promotion });
  assert.equal(recovered.readiness.gates.leadPromotion.status, 'PASS');
});

test('the same loss and the same recovery apply to Lead demotion evidence', () => {
  const first = demoteLead1();
  assert.equal(first.status, 'PASS');
  assert.equal(leadDemotionReportsFromApplication(first, baseline)[0].status, 'PASS');

  const second = applyNext(first, [keep('k1', ['lead-1'])]);
  assert.equal(second.status, 'PASS');

  assert.deepEqual(leadDemotionReportsFromApplication(second, baseline), []);
  const lost = reviewAppliedCandidate({ application: second, baseline, leadDemotionReports: [] });
  assert.equal(lost.readiness.gates.leadDemotion.status, 'PENDING');
  assert.ok(lost.readiness.gates.leadDemotion.pendingEventIds.includes('lead-1'));

  const { demotion } = reportsFor([first, second], second);
  assert.equal(demotion.length, 1);
  assert.equal(demotion[0].status, 'PASS');
  assert.equal(demotion[0].eventId, 'lead-1');
  assert.equal(demotion[0].destinationRole, 'Chord3');

  const recovered = reviewAppliedCandidate({ application: second, baseline, leadDemotionReports: demotion });
  assert.equal(recovered.readiness.gates.leadDemotion.status, 'PASS');
});

test('a revision that only touches an unrelated voice keeps the promotion evidence applicable', () => {
  const first = promoteTex1();
  // tex-2 carries no baseline role and lands in enrichment: it is outside Core3
  // and outside the Lead move, so the continuity/Core3 claims still hold.
  const second = applyNext(first, [{
    id: 'e1', type: 'ASSIGN_ROLE', target: { eventIds: ['tex-2'] }, toRole: 'Chord5',
    reason: 'Reviewed: the second texture voice enriches without touching Core3.',
    evidence: ['fixture:review'],
  }]);
  assert.equal(second.status, 'PASS');
  assert.equal(second.candidate.events.find(event => event.id === 'tex-2').role, 'Chord5');

  const { promotion } = reportsFor([first, second], second);
  assert.equal(promotion.length, 1);
  assert.equal(promotion[0].status, 'PASS', 'an enrichment-only change does not invalidate a Lead claim');
  assert.equal(reviewAppliedCandidate({ application: second, baseline, leadPromotionReports: promotion })
    .readiness.gates.leadPromotion.status, 'PASS');
});

// ─── the limits: this is a re-grade, never a carry-forward ──────────────────

test('a later revision that moves Core3 material sends the recovered evidence back to PENDING', () => {
  const first = promoteTex1();
  // Chord1 material leaves Core3. The reviewer's continuity and Core3 claims
  // were made about the Core3 picture as it stood at revision 1; that picture
  // has moved, so the claim is unproven again.
  const second = applyNext(first, [{
    id: 'm1', type: 'MOVE_ROLE', target: { eventIds: ['harm-1'] },
    fromRole: 'Chord1', toRole: 'Chord4',
    reason: 'Reviewed: moved to enrichment.',
    evidence: ['fixture:review'],
  }]);
  assert.equal(second.status, 'PASS');

  const { promotion } = reportsFor([first, second], second);
  assert.equal(promotion.length, 1);
  assert.equal(promotion[0].status, 'PENDING');
  assert.deepEqual([...promotion[0].blockers], [LEAD_EVIDENCE_LINEAGE_BLOCKERS.CONTEXT_CHANGED]);
  assert.equal(promotion[0].pass, false);

  // Readiness still requires it, so the candidate is blocked until re-reviewed.
  const review = reviewAppliedCandidate({ application: second, baseline, leadPromotionReports: promotion });
  assert.equal(review.readiness.gates.leadPromotion.status, 'PENDING');
  assert.ok(review.readiness.gates.leadPromotion.pendingEventIds.includes('tex-1'));
});

test('demoting a promoted event withdraws its promotion record instead of leaving two reports', () => {
  const first = promoteTex1();
  const second = applyNext(first, [{
    id: 'd2', type: 'MOVE_ROLE', target: { eventIds: ['tex-1'] },
    fromRole: 'Melody', toRole: 'Chord3',
    reason: 'Reviewed: on a second listen this is inner material after all.',
    evidence: ['fixture:score inner staff'],
    leadEvidence: leadDemotionEvidence({ eventId: 'tex-1', sourceEventId: 'fixture:symbolic#tex-1' }),
  }]);
  assert.equal(second.status, 'PASS');

  const { promotion, demotion } = reportsFor([first, second], second);
  // Exactly one report per event id: the readiness gate keys reports by event
  // id and keeps the last one, so a second report for tex-1 would make the gate
  // outcome depend on array order.
  assert.deepEqual(promotion, [], 'the promotion no longer exists in the candidate');
  assert.equal(demotion.filter(report => report.eventId === 'tex-1').length, 1);
});

test('an unrecoverable evidence chain fails closed rather than passing by default', () => {
  const first = promoteTex1();
  const second = applyNext(first, [keep('k1', ['tex-1'])]);

  // An edited intermediate application is data, not evidence. Tampering with the
  // candidate breaks the revision's content address, so the lineage is refused
  // whole: no report is produced and the gate stays PENDING.
  const forged = {
    ...first,
    candidate: {
      ...first.candidate,
      events: first.candidate.events.map(event => (event.id === 'harm-1' ? { ...event, pitch: event.pitch + 1 } : event)),
    },
  };
  const lineage = applicationLineage([forged, second], baseline);
  assert.equal(lineage.ok, false);
  assert.deepEqual(leadPromotionReportsFromLineage({ applications: [forged, second], baseline, candidate: second.candidate }), []);

  const review = reviewAppliedCandidate({ application: second, baseline, leadPromotionReports: [] });
  assert.equal(review.readiness.gates.leadPromotion.status, 'PENDING');
});

test('a chain with a hole in it is refused, and a well-formed one is ordered oldest first', () => {
  const first = promoteTex1();
  const second = applyNext(first, [keep('k1', ['tex-1'])]);
  const third = applyNext(second, [keep('k2', ['tex-1'])]);

  const whole = applicationLineage([third, first, second], baseline);
  assert.equal(whole.ok, true, 'order of the input does not matter');
  assert.deepEqual(whole.steps.map(step => step.index), [1, 2, 3]);

  const holed = applicationLineage([first, third], baseline);
  assert.equal(holed.ok, false);
  assert.ok(holed.reasons.includes('LINEAGE_INDEX_NOT_CONTIGUOUS'));

  // The evidence still survives three revisions of KEEP when the chain is whole.
  const { promotion } = reportsFor([first, second, third], third);
  assert.equal(promotion.length, 1);
  assert.equal(promotion[0].status, 'PASS');
});

test('recovery never invents a PASS the shared gate would not give', () => {
  // Revision 1 promotes with an incomplete citation: the gate said PENDING then,
  // and recovering the record two revisions later must say PENDING too.
  const first = applyFirst([{
    id: 'p1', type: 'ASSIGN_ROLE', target: { eventIds: ['tex-1'] }, toRole: 'Melody',
    reason: 'Reviewed: the cited texture becomes the foreground instrumental lead here.',
    evidence: ['fixture:score top line', 'fixture:audio foreground'],
    leadEvidence: leadPromotionEvidence(),
    acceptance: accept(),
  }]);
  assert.equal(first.status, 'PASS');

  // `applied[]` is not covered by the revision's content address -- the digest
  // is over the decision set, the candidate and the identities, not over the
  // applied trace -- so an evidence record removed there survives the integrity
  // check. That is precisely why nothing downstream reads a stored verdict:
  // recovery re-grades the record it finds, and a record with no citation gets
  // the same closed answer it would have got at application time.
  const stripped = { ...first, applied: first.applied.map(entry => ({ ...entry, leadEvidence: null })) };
  const second = applyNext(first, [keep('k1', ['tex-1'])]);

  const recovered = leadPromotionReportsFromLineage({ applications: [stripped, second], baseline, candidate: second.candidate });
  assert.equal(recovered.length, 1);
  assert.equal(recovered[0].status, 'PENDING', 'a recovered record with no evidence is not a recovered PASS');
  assert.ok(recovered[0].blockers.includes('LEAD_EVIDENCE_MISSING'));

  // The single-revision reading of the stripped result agrees.
  assert.ok(leadPromotionReportsFromApplication(stripped, baseline).every(report => report.status !== 'PASS'));

  // And the gate readiness keys on stays PENDING for the event.
  const review = reviewAppliedCandidate({ application: second, baseline, leadPromotionReports: recovered });
  assert.equal(review.readiness.gates.leadPromotion.status, 'PENDING');
  assert.ok(review.readiness.gates.leadPromotion.pendingEventIds.includes('tex-1'));
});
