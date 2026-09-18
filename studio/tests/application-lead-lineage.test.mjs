// Studio Application Service — Lead evidence survives a later revision.
//
// The audit's reproduction, through the service an agent actually calls:
//
//   revision 1  promotes Chord3 -> Melody with complete positive Lead evidence
//               and the shared promotion gate passes
//   revision 2  KEEPs the already-promoted Melody event and changes nothing
//   result      application integrity PASSes, the promotion report is empty,
//               and readiness blocks with LEAD_PROMOTION_EVIDENCE_REQUIRED
//
// The block was unclearable: G11-D correctly refuses to re-apply a move that
// already happened, so no later decision could re-supply the evidence. These
// regressions pin that `reviewCandidate` and `finalize` read the whole stored
// revision lineage and re-grade the recovered evidence against the current
// candidate.

import test from 'node:test';
import assert from 'node:assert/strict';

import { createStudioApplication } from '../backend/application/index.mjs';
import { canonicalProjectBytes, sixRoleBaseline } from './fixtures/application-fixtures.mjs';

const OWNER = 'owner:alice';
const SOURCE_ID = 'fixture:official-midi';

const promotionEvidence = eventId => ({
  sourceIdentity: { sourceId: SOURCE_ID, sourceEventId: `${SOURCE_ID}#${eventId}` },
  sectionRole: 'instrumental',
  scoreEvidence: { availability: 'available', classification: 'lead', citation: 'fixture:score top line bar 1' },
  audioEvidence: { availability: 'available', classification: 'foreground', citation: 'fixture:audio 0:00 foreground' },
  continuity: { checked: true, createsLeadGap: false, replacementEventIds: [] },
  core3: { checked: true, status: 'PASS' },
  positiveReason: 'The score places this attack on the top staff and the mix carries it in front.',
});

async function projectWithBaseline(service, title) {
  const project = sixRoleBaseline();
  const created = (await service.createProject(OWNER, { title })).project;
  await service.uploadAsset(OWNER, created.project_id, {
    kind: 'canonical_project', filename: 'baseline.json', mediaType: 'application/json', bytes: canonicalProjectBytes(project),
  });
  await service.analyzeSources(OWNER, created.project_id);
  return { project, projectId: created.project_id };
}

/** Revision 1: promote one Chord3 event into Melody with complete evidence. */
const promote = eventId => ({
  id: 'promote:chord3-1',
  type: 'MOVE_ROLE',
  target: { eventIds: [eventId] },
  fromRole: 'Chord3',
  toRole: 'Melody',
  reason: 'Reviewed: this cited voice carries the foreground lead through the instrumental window.',
  evidence: ['fixture:score top line', 'fixture:audio foreground'],
  leadEvidence: promotionEvidence(eventId),
  acceptedBy: 'reviewer:test',
});

const keep = (id, eventIds, role) => ({
  id, type: 'KEEP', target: { eventIds }, fromRole: role,
  reason: 'Reviewed: carried unchanged into this revision.',
  evidence: [`${SOURCE_ID}#keep`],
  acceptedBy: 'reviewer:test',
});

test('a KEEP revision does not erase the Lead promotion evidence of an earlier one', async () => {
  const service = createStudioApplication();
  const { projectId } = await projectWithBaseline(service, 'Lead lineage');

  const first = await service.applyDecisions(OWNER, projectId, { decisions: [promote('chord3-1')] });
  assert.equal(first.decisions.applied, true);

  // Revision 1 on its own passes the promotion gate.
  const firstReview = (await service.reviewCandidate(OWNER, projectId, { candidateId: first.decisions.candidate_id })).review;
  assert.equal(firstReview.lead_promotion.length, 1);
  assert.equal(firstReview.lead_promotion[0].status, 'PASS');
  assert.equal(firstReview.readiness.gates.leadPromotion.status, 'PASS');

  // Revision 2 keeps the already-promoted event and changes nothing else.
  const second = await service.applyDecisions(OWNER, projectId, {
    parentCandidateId: first.decisions.candidate_id,
    decisions: [keep('keep:promoted', ['chord3-1'], 'Melody')],
  });
  assert.equal(second.decisions.applied, true);
  assert.equal(second.decisions.revision_index, 2);

  const secondReview = (await service.reviewCandidate(OWNER, projectId, { candidateId: second.decisions.candidate_id })).review;
  assert.equal(secondReview.integrity.ok, true, 'application integrity still passes, as the audit observed');

  // The requirement is still there -- the baseline diff still shows the event
  // arriving in Melody -- and so is the evidence.
  assert.equal(secondReview.lead_promotion.length, 1, 'the promotion report must not vanish on a no-op revision');
  assert.equal(secondReview.lead_promotion[0].status, 'PASS');
  assert.equal(secondReview.lead_promotion[0].eventId, 'chord3-1');
  // The report names the revision whose evidence it re-graded, which is the
  // candidate id revision 1 was filed under.
  assert.equal(secondReview.lead_promotion[0].gradedFromRevisionId, first.decisions.candidate_id);
  assert.equal(secondReview.readiness.gates.leadPromotion.status, 'PASS');
  assert.equal(secondReview.blockers.includes('leadPromotion'), false);
});

test('a later revision that changes the Lead picture sends the recovered promotion back to PENDING', async () => {
  const service = createStudioApplication();
  const { projectId } = await projectWithBaseline(service, 'Lead lineage staleness');

  const first = await service.applyDecisions(OWNER, projectId, { decisions: [promote('chord3-1')] });
  assert.equal(first.decisions.applied, true);

  // A Lead event leaves Melody. The reviewer's continuity claim for the earlier
  // promotion was made about the Lead picture as it stood at revision 1.
  const second = await service.applyDecisions(OWNER, projectId, {
    parentCandidateId: first.decisions.candidate_id,
    decisions: [{
      id: 'demote:melody-1',
      type: 'MOVE_ROLE',
      target: { eventIds: ['melody-1'] },
      fromRole: 'Melody',
      toRole: 'Chord3',
      reason: 'Reviewed: on a second listen this opening attack is inner material.',
      evidence: ['fixture:score inner staff'],
      leadEvidence: {
        sourceIdentity: { sourceId: SOURCE_ID, sourceEventId: `${SOURCE_ID}#melody-1` },
        sectionRole: 'instrumental',
        scoreEvidence: { availability: 'available', classification: 'inner', citation: 'fixture:score inner staff' },
        audioEvidence: { availability: 'available', classification: 'background', citation: 'fixture:audio 0:00 behind' },
        continuity: { checked: true, createsLeadGap: false, replacementEventIds: [] },
        core3: { checked: true, status: 'PASS' },
        positiveReason: 'The score places this attack on the inner staff and the mix keeps it behind the lead.',
      },
      acceptedBy: 'reviewer:test',
    }],
  });
  assert.equal(second.decisions.applied, true);

  const review = (await service.reviewCandidate(OWNER, projectId, { candidateId: second.decisions.candidate_id })).review;
  const promoted = review.lead_promotion.find(report => report.eventId === 'chord3-1');
  assert.equal(promoted.status, 'PENDING', 'a changed Lead picture is re-review, not a carried PASS');
  assert.ok(promoted.blockers.includes('LEAD_EVIDENCE_CONTEXT_CHANGED'));
  assert.equal(review.readiness.gates.leadPromotion.status, 'PENDING');
  assert.ok(review.blockers.includes('leadPromotion'));
});

test('an ordinary later Core3 decision does not void the recovered promotion evidence', async () => {
  const service = createStudioApplication();
  const { project, projectId } = await projectWithBaseline(service, 'Lead lineage unrelated edit');

  const first = await service.applyDecisions(OWNER, projectId, { decisions: [promote('chord3-1')] });
  // Chord1 material leaves Core3. That is a real Core3 source change -- the
  // continuity gate reports it -- but it says nothing about the Lead move, and
  // G11-D will not let the reviewer re-apply a promotion that already happened.
  const second = await service.applyDecisions(OWNER, projectId, {
    parentCandidateId: first.decisions.candidate_id,
    decisions: [{
      id: 'move:chord1',
      type: 'MOVE_ROLE',
      target: { eventIds: project.events.filter(event => event.role === 'Chord1').map(event => event.id) },
      fromRole: 'Chord1',
      toRole: 'Chord4',
      reason: 'Reviewed: this accompaniment reads as enrichment, not core harmony.',
      evidence: ['fixture:review note'],
      acceptedBy: 'reviewer:test',
    }],
  });
  assert.equal(second.decisions.applied, true);

  const review = (await service.reviewCandidate(OWNER, projectId, { candidateId: second.decisions.candidate_id })).review;
  assert.equal(review.lead_promotion.find(report => report.eventId === 'chord3-1').status, 'PASS');
  assert.equal(review.readiness.gates.leadPromotion.status, 'PASS');
  // The Core3 change is still caught, by the gate that owns that question.
  assert.equal(review.core3.status, 'PENDING');
  assert.ok(review.core3.blockers.includes('UNAPPROVED_CORE3_SOURCE_CHANGE'));
});

test('finalize reads the same recovered evidence review does', async () => {
  const service = createStudioApplication();
  const { projectId } = await projectWithBaseline(service, 'Lead lineage finalize');

  const first = await service.applyDecisions(OWNER, projectId, { decisions: [promote('chord3-1')] });
  const second = await service.applyDecisions(OWNER, projectId, {
    parentCandidateId: first.decisions.candidate_id,
    decisions: [keep('keep:promoted', ['chord3-1'], 'Melody')],
  });

  // Finalize still refuses -- other required gates are unsatisfied in this
  // fixture -- but `leadPromotion` must not be among the reasons.
  const finalized = await service.finalize(OWNER, projectId, { candidateId: second.decisions.candidate_id });
  assert.equal(finalized.mml, null);
  assert.ok(Array.isArray(finalized.blockers));
  assert.equal(finalized.blockers.includes('leadPromotion'), false, 'recovered promotion evidence must reach the Finalize gate too');
});
