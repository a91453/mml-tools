// Studio Application Service — re-reviewing Lead evidence that went stale.
//
// The lineage recovery in `application-lead-lineage.test.mjs` fixed the case
// where a later revision merely KEEPs an already-promoted event. It did not fix
// this one, and reproducing it through the real service showed exactly how
// closed the door was:
//
//   revision 1  promotes chord3-1 into Melody with complete evidence   PASS
//   revision 2  moves a DIFFERENT Lead event                           the Lead
//               context digest changes, so revision 1's citation no longer
//               describes the arrangement being graded
//   result      LEAD_EVIDENCE_CONTEXT_CHANGED -> PENDING, gate blocks
//
//   re-applying the move   refused, PREVIOUS_ROLE_MISMATCH (expected Chord3,
//                          observed Melody) -- G11-D is right to refuse
//   a KEEP carrying fresh  applied, and silently ignored: a KEEP is not a role
//   leadEvidence           move, so no report reads its evidence at all
//   a confirmation         there is none for Lead evidence, and a boolean could
//                          not be graded if there were
//
// The staleness is correct and stays. What was missing was any way to answer
// it. `reviewLeadEvidence` is that answer: one candidate-bound, axis-specific,
// evidence-backed review per event, graded by the same shared Lead gate on
// every review and finalize, carrying no previous verdict forward.

import test from 'node:test';
import assert from 'node:assert/strict';

import { createStudioApplication } from '../backend/application/index.mjs';
import { canonicalProjectBytes, sixRoleBaseline } from './fixtures/application-fixtures.mjs';

const OWNER = 'owner:alice';
const SOURCE_ID = 'fixture:official-midi';

/** A complete, correctly-scoped promotion citation for one baseline event. */
const promotionEvidence = (eventId, over = {}) => ({
  sourceIdentity: { sourceId: SOURCE_ID, sourceEventId: `${SOURCE_ID}#${eventId}` },
  sectionRole: 'instrumental',
  scoreEvidence: { availability: 'available', classification: 'lead', citation: 'fixture:score top line bar 1' },
  audioEvidence: { availability: 'available', classification: 'foreground', citation: 'fixture:audio 0:00 foreground' },
  continuity: { checked: true, createsLeadGap: false, replacementEventIds: [] },
  core3: { checked: true, status: 'PASS' },
  positiveReason: 'The score places this attack on the top staff and the mix carries it in front.',
  ...over,
});

/** The same, arguing the other way: this event is inner material. */
const demotionEvidence = (eventId, over = {}) => promotionEvidence(eventId, {
  scoreEvidence: { availability: 'available', classification: 'inner', citation: 'fixture:score inner staff' },
  audioEvidence: { availability: 'available', classification: 'background', citation: 'fixture:audio 0:00 behind the lead' },
  positiveReason: 'The score places this attack on the inner staff and the mix keeps it behind the lead.',
  ...over,
});

async function project(title) {
  const service = createStudioApplication();
  const created = (await service.createProject(OWNER, { title })).project;
  await service.uploadAsset(OWNER, created.project_id, {
    kind: 'canonical_project', filename: 'baseline.json', mediaType: 'application/json', bytes: canonicalProjectBytes(sixRoleBaseline()),
  });
  await service.analyzeSources(OWNER, created.project_id);
  return { service, projectId: created.project_id };
}

const promote = (eventId, fromRole = 'Chord3') => ({
  id: `promote:${eventId}`, type: 'MOVE_ROLE', target: { eventIds: [eventId] }, fromRole, toRole: 'Melody',
  reason: 'Reviewed: this cited voice carries the foreground lead through the instrumental window.',
  evidence: ['fixture:score top line'], leadEvidence: promotionEvidence(eventId), acceptedBy: 'reviewer:test',
});

const demote = (eventId, toRole = 'Chord3') => ({
  id: `demote:${eventId}`, type: 'MOVE_ROLE', target: { eventIds: [eventId] }, fromRole: 'Melody', toRole,
  reason: 'Reviewed: on a second listen this attack is inner material.',
  evidence: ['fixture:score inner staff'], leadEvidence: demotionEvidence(eventId), acceptedBy: 'reviewer:test',
});

const reportFor = (reports, eventId) => reports.find(report => report.eventId === eventId);

// ─── 1. a stale promotion is answerable again ───────────────────────────────

test('a promotion sent back to PENDING by a later Lead move is answerable by a fresh candidate-bound review', async () => {
  const { service, projectId } = await project('promotion re-review');

  const first = await service.applyDecisions(OWNER, projectId, { decisions: [promote('chord3-1')] });
  const firstReview = (await service.reviewCandidate(OWNER, projectId, { candidateId: first.decisions.candidate_id })).review;
  assert.equal(reportFor(firstReview.lead_promotion, 'chord3-1').status, 'PASS');
  assert.equal(reportFor(firstReview.lead_promotion, 'chord3-1').evidenceSource, 'revision');

  // A different Lead event moves. The earlier citation's continuity claim was
  // made about the Lead picture as it stood then.
  const second = await service.applyDecisions(OWNER, projectId, {
    parentCandidateId: first.decisions.candidate_id, decisions: [demote('melody-1')],
  });
  const candidateId = second.decisions.candidate_id;

  const stale = (await service.reviewCandidate(OWNER, projectId, { candidateId })).review;
  assert.equal(reportFor(stale.lead_promotion, 'chord3-1').status, 'PENDING');
  assert.ok(reportFor(stale.lead_promotion, 'chord3-1').blockers.includes('LEAD_EVIDENCE_CONTEXT_CHANGED'));
  assert.equal(stale.readiness.gates.leadPromotion.status, 'PENDING');

  // The path that did not exist: re-supply the citation against this candidate.
  const recorded = await service.reviewLeadEvidence(OWNER, projectId, {
    candidateId,
    review: {
      event_id: 'chord3-1', axis: 'promotion',
      reason: 'Re-reviewed against the Lead picture as it now stands; the top line is unchanged.',
      evidence: ['fixture:score top line bar 1', 'fixture:audio 0:00'],
      lead_evidence: promotionEvidence('chord3-1'),
    },
  });
  assert.equal(recorded.review.candidate_id, candidateId);
  assert.equal(recorded.review.axis, 'promotion');

  const after = (await service.reviewCandidate(OWNER, projectId, { candidateId })).review;
  const report = reportFor(after.lead_promotion, 'chord3-1');
  assert.equal(report.status, 'PASS');
  // The verdict came from the shared grader run over the fresh citation, not
  // from the revision's own record and not from the earlier PASS.
  assert.equal(report.evidenceSource, 'candidate-review');
  assert.equal(after.readiness.gates.leadPromotion.status, 'PASS');
  assert.equal(after.blockers.includes('leadPromotion'), false);
  assert.equal(after.lead_evidence_reviews.length, 1);
});

// ─── 2. the same, on the demotion axis ──────────────────────────────────────

test('a demotion sent back to PENDING by a later Lead move is answerable the same way', async () => {
  const { service, projectId } = await project('demotion re-review');

  const first = await service.applyDecisions(OWNER, projectId, { decisions: [demote('melody-1')] });
  const firstReview = (await service.reviewCandidate(OWNER, projectId, { candidateId: first.decisions.candidate_id })).review;
  assert.equal(reportFor(firstReview.lead_demotion, 'melody-1').status, 'PASS');

  const second = await service.applyDecisions(OWNER, projectId, {
    parentCandidateId: first.decisions.candidate_id, decisions: [demote('melody-2')],
  });
  const candidateId = second.decisions.candidate_id;

  const stale = (await service.reviewCandidate(OWNER, projectId, { candidateId })).review;
  assert.equal(reportFor(stale.lead_demotion, 'melody-1').status, 'PENDING');
  assert.ok(reportFor(stale.lead_demotion, 'melody-1').blockers.includes('LEAD_EVIDENCE_CONTEXT_CHANGED'));
  assert.equal(stale.readiness.gates.leadDemotion.status, 'PENDING');

  await service.reviewLeadEvidence(OWNER, projectId, {
    candidateId,
    review: {
      event_id: 'melody-1', axis: 'demotion',
      reason: 'Re-reviewed: still inner material against the Lead picture as it now stands.',
      evidence: ['fixture:score inner staff'],
      lead_evidence: demotionEvidence('melody-1'),
    },
  });

  const after = (await service.reviewCandidate(OWNER, projectId, { candidateId })).review;
  assert.equal(reportFor(after.lead_demotion, 'melody-1').status, 'PASS');
  assert.equal(reportFor(after.lead_demotion, 'melody-1').evidenceSource, 'candidate-review');
  assert.equal(after.readiness.gates.leadDemotion.status, 'PASS');
});

// ─── 3. a fresh review is bound to the candidate it was made for ────────────

test('a fresh review does not answer the next candidate once the Lead context changes again', async () => {
  const { service, projectId } = await project('re-review staleness');

  const first = await service.applyDecisions(OWNER, projectId, { decisions: [promote('chord3-1')] });
  const second = await service.applyDecisions(OWNER, projectId, {
    parentCandidateId: first.decisions.candidate_id, decisions: [demote('melody-1')],
  });
  const reviewed = second.decisions.candidate_id;

  await service.reviewLeadEvidence(OWNER, projectId, {
    candidateId: reviewed,
    review: {
      event_id: 'chord3-1', axis: 'promotion', reason: 'Re-reviewed against this candidate.',
      evidence: ['fixture:score top line'], lead_evidence: promotionEvidence('chord3-1'),
    },
  });
  assert.equal(reportFor((await service.reviewCandidate(OWNER, projectId, { candidateId: reviewed })).review.lead_promotion, 'chord3-1').status, 'PASS');

  // A third revision moves the Lead picture again. The review was an argument
  // about the candidate it named, and that candidate is not this one.
  const third = await service.applyDecisions(OWNER, projectId, {
    parentCandidateId: reviewed, decisions: [demote('melody-2')],
  });
  const later = (await service.reviewCandidate(OWNER, projectId, { candidateId: third.decisions.candidate_id })).review;
  const report = reportFor(later.lead_promotion, 'chord3-1');
  assert.equal(report.status, 'PENDING', 'a re-review is not a standing permission');
  assert.ok(report.blockers.includes('LEAD_EVIDENCE_CONTEXT_CHANGED'));
  assert.equal(later.readiness.gates.leadPromotion.status, 'PENDING');
  assert.deepEqual(later.lead_evidence_reviews, [], 'the earlier candidate review is not loaded for this candidate');

  // And it is answerable there too, so this is re-review, not a dead end that
  // moved one revision along.
  await service.reviewLeadEvidence(OWNER, projectId, {
    candidateId: third.decisions.candidate_id,
    review: {
      event_id: 'chord3-1', axis: 'promotion', reason: 'Re-reviewed again, against the current Lead picture.',
      evidence: ['fixture:score top line'], lead_evidence: promotionEvidence('chord3-1'),
    },
  });
  assert.equal(reportFor((await service.reviewCandidate(OWNER, projectId, { candidateId: third.decisions.candidate_id })).review.lead_promotion, 'chord3-1').status, 'PASS');
});

// ─── 4. what the operation refuses ──────────────────────────────────────────

test('a Lead evidence review is refused unless it binds to this move, this axis and this baseline event', async () => {
  const { service, projectId } = await project('re-review refusals');

  const first = await service.applyDecisions(OWNER, projectId, { decisions: [promote('chord3-1')] });
  const second = await service.applyDecisions(OWNER, projectId, {
    parentCandidateId: first.decisions.candidate_id, decisions: [demote('melody-1')],
  });
  const candidateId = second.decisions.candidate_id;
  const base = {
    event_id: 'chord3-1', axis: 'promotion', reason: 'Re-reviewed.',
    evidence: ['fixture:score top line'], lead_evidence: promotionEvidence('chord3-1'),
  };

  // A citation about a different source event. The event id names this move,
  // but the provenance names another event, which is the exact substitution the
  // identity binding exists to refuse.
  await assert.rejects(
    () => service.reviewLeadEvidence(OWNER, projectId, { candidateId, review: { ...base, lead_evidence: promotionEvidence('chord4-1') } }),
    error => {
      assert.equal(error.code, 'INVALID_REQUEST');
      assert.ok(error.details.blockers.includes('LEAD_EVIDENCE_EVENT_IDENTITY_MISMATCH'));
      return true;
    },
  );

  // Promotion evidence does not answer a demotion requirement.
  await assert.rejects(
    () => service.reviewLeadEvidence(OWNER, projectId, { candidateId, review: { ...base, axis: 'demotion' } }),
    /reports no Lead demotion requiring evidence/,
  );
  await assert.rejects(
    () => service.reviewLeadEvidence(OWNER, projectId, { candidateId, review: { ...base, axis: 'either' } }),
    /axis must be promotion or demotion/,
  );

  // An event this candidate performed no Lead move on.
  await assert.rejects(
    () => service.reviewLeadEvidence(OWNER, projectId, { candidateId, review: { ...base, event_id: 'chord5-2', lead_evidence: promotionEvidence('chord5-2') } }),
    /reports no Lead promotion requiring evidence/,
  );

  // A review is a review: a reason with no evidence reference is a claim.
  await assert.rejects(
    () => service.reviewLeadEvidence(OWNER, projectId, { candidateId, review: { ...base, evidence: [] } }),
    /requires at least one explicit evidence reference/,
  );
  await assert.rejects(
    () => service.reviewLeadEvidence(OWNER, projectId, { candidateId, review: { ...base, lead_evidence: undefined } }),
    /lead_evidence must be the Lead evidence record/,
  );

  // Nothing above was stored, so the gate is exactly where it was.
  const review = (await service.reviewCandidate(OWNER, projectId, { candidateId })).review;
  assert.deepEqual(review.lead_evidence_reviews, []);
  assert.equal(reportFor(review.lead_promotion, 'chord3-1').status, 'PENDING');

  // Once answered, the question is not re-openable: a second review would be a
  // second answer to a question that already has one.
  await service.reviewLeadEvidence(OWNER, projectId, { candidateId, review: base });
  await assert.rejects(
    () => service.reviewLeadEvidence(OWNER, projectId, { candidateId, review: base }),
    /already answered/,
  );
});

// ─── 5. derived duplicates keep their origin chain ──────────────────────────

test('a duplicate promoted into Melody is re-reviewed under its derived id and graded against its baseline origin', async () => {
  const { service, projectId } = await project('duplicate re-review');

  const first = await service.applyDecisions(OWNER, projectId, {
    decisions: [{
      id: 'dup:chord3-1', type: 'DUPLICATE_WITH_JUSTIFICATION', target: { eventIds: ['chord3-1'] }, toRoles: ['Melody'],
      reason: 'Reviewed: doubled into the lead for the cited phrase.',
      evidence: ['fixture:score doubling bar 1'], leadEvidence: promotionEvidence('chord3-1'), acceptedBy: 'reviewer:test',
    }],
  });
  const initial = (await service.reviewCandidate(OWNER, projectId, { candidateId: first.decisions.candidate_id })).review;
  const derivedId = initial.lead_promotion[0].eventId;
  assert.notEqual(derivedId, 'chord3-1', 'a justified duplicate is keyed on its derived candidate event');
  assert.equal(initial.lead_promotion[0].originEventId, 'chord3-1');

  const second = await service.applyDecisions(OWNER, projectId, {
    parentCandidateId: first.decisions.candidate_id, decisions: [demote('melody-1')],
  });
  const candidateId = second.decisions.candidate_id;
  assert.equal(reportFor((await service.reviewCandidate(OWNER, projectId, { candidateId })).review.lead_promotion, derivedId).status, 'PENDING');

  // The derived id is what readiness keys on, so it is what the review names.
  // The citation is still the origin's: a derived event id lives in another
  // namespace and is never accepted as a source event id.
  await assert.rejects(
    () => service.reviewLeadEvidence(OWNER, projectId, {
      candidateId,
      review: {
        event_id: derivedId, axis: 'promotion', reason: 'Re-reviewed.', evidence: ['fixture:score doubling'],
        lead_evidence: promotionEvidence('chord3-1', { sourceIdentity: { sourceId: SOURCE_ID, sourceEventId: `${SOURCE_ID}#${derivedId}` } }),
      },
    }),
    error => {
      assert.ok(error.details.blockers.includes('LEAD_EVIDENCE_EVENT_IDENTITY_MISMATCH'));
      assert.equal(error.details.origin_event_id, 'chord3-1');
      return true;
    },
  );

  const recorded = await service.reviewLeadEvidence(OWNER, projectId, {
    candidateId,
    review: {
      event_id: derivedId, axis: 'promotion',
      reason: 'Re-reviewed: the doubled line still reads as the lead against the current picture.',
      evidence: ['fixture:score doubling bar 1'], lead_evidence: promotionEvidence('chord3-1'),
    },
  });
  assert.equal(recorded.review.origin_event_id, 'chord3-1');

  const after = (await service.reviewCandidate(OWNER, projectId, { candidateId })).review;
  const report = reportFor(after.lead_promotion, derivedId);
  assert.equal(report.status, 'PASS');
  assert.equal(report.originEventId, 'chord3-1', 'readiness keys the derived id; the citation stays bound to the origin');
  assert.equal(report.evidenceSource, 'candidate-review');
  assert.equal(after.readiness.gates.leadPromotion.status, 'PASS');
});

// ─── 6. nothing happens on its own ──────────────────────────────────────────

test('without a fresh review the stale report stays PENDING, and no other operation clears it', async () => {
  const { service, projectId } = await project('no re-review');

  const first = await service.applyDecisions(OWNER, projectId, { decisions: [promote('chord3-1')] });
  const second = await service.applyDecisions(OWNER, projectId, {
    parentCandidateId: first.decisions.candidate_id, decisions: [demote('melody-1')],
  });
  const candidateId = second.decisions.candidate_id;

  // Re-applying the move is refused by G11-D, and rightly: it already happened.
  const reapply = await service.applyDecisions(OWNER, projectId, { parentCandidateId: candidateId, decisions: [promote('chord3-1')] });
  assert.equal(reapply.decisions.applied, false);
  assert.equal(reapply.decisions.rejected[0].code, 'PREVIOUS_ROLE_MISMATCH');

  // A KEEP carrying Lead evidence is not a role move. It applies, and it must
  // not be mistaken for a re-review: no report reads its evidence.
  const kept = await service.applyDecisions(OWNER, projectId, {
    parentCandidateId: candidateId,
    decisions: [{
      id: 'keep:chord3-1', type: 'KEEP', target: { eventIds: ['chord3-1'] }, fromRole: 'Melody',
      reason: 'Reviewed: carried unchanged into this revision.',
      evidence: ['fixture:score top line'], leadEvidence: promotionEvidence('chord3-1'), acceptedBy: 'reviewer:test',
    }],
  });
  assert.equal(kept.decisions.applied, true);
  const afterKeep = (await service.reviewCandidate(OWNER, projectId, { candidateId: kept.decisions.candidate_id })).review;
  assert.equal(reportFor(afterKeep.lead_promotion, 'chord3-1').status, 'PENDING');
  assert.ok(reportFor(afterKeep.lead_promotion, 'chord3-1').blockers.includes('LEAD_EVIDENCE_CONTEXT_CHANGED'));

  // Nor does any confirmation reach the Lead gates.
  await service.recordConfirmations(OWNER, projectId, {
    version_drift_reviewed: { value: true, reason: 'Reviewed the divergence.', candidate_id: candidateId },
    core3_completeness_reviewed: { value: true, reason: 'Reviewed Core3 completeness.', evidence: ['fixture:review note'], candidate_id: candidateId },
  });
  const afterConfirmations = (await service.reviewCandidate(OWNER, projectId, { candidateId })).review;
  assert.equal(reportFor(afterConfirmations.lead_promotion, 'chord3-1').status, 'PENDING');
  assert.equal(afterConfirmations.readiness.gates.leadPromotion.status, 'PENDING');
});

// ─── finalize reads the same path ───────────────────────────────────────────

test('finalize grades the re-reviewed evidence review grades, not a separate one', async () => {
  const { service, projectId } = await project('re-review finalize');

  const first = await service.applyDecisions(OWNER, projectId, { decisions: [promote('chord3-1')] });
  const second = await service.applyDecisions(OWNER, projectId, {
    parentCandidateId: first.decisions.candidate_id, decisions: [demote('melody-1')],
  });
  const candidateId = second.decisions.candidate_id;

  // Other required gates are unsatisfied in this fixture, so finalize refuses
  // either way; what matters is whether `leadPromotion` is among the reasons.
  const blocked = await service.finalize(OWNER, projectId, { candidateId });
  assert.equal(blocked.mml, null);
  assert.ok(blocked.blockers.includes('leadPromotion'), 'the stale citation blocks Finalize too');

  await service.reviewLeadEvidence(OWNER, projectId, {
    candidateId,
    review: {
      event_id: 'chord3-1', axis: 'promotion', reason: 'Re-reviewed against this candidate.',
      evidence: ['fixture:score top line'], lead_evidence: promotionEvidence('chord3-1'),
    },
  });

  const after = await service.finalize(OWNER, projectId, { candidateId });
  assert.equal(after.blockers.includes('leadPromotion'), false, 'Finalize reads the same re-reviewed evidence review does');
});

// ─── what a re-review may and may not answer ────────────────────────────────
//
// Findings from an adversarial review of the operation above. Several PENDING
// reasons are decided BEFORE the builder consults a fresh review -- the
// multi-event scope boundary, an unresolvable origin, and the event-identity
// and destination staleness checks. A citation cannot answer any of those, so
// filing one against them used to report success and store a record no gate
// would ever read.

test('a demotion whose destination moved on again is still answerable', async () => {
  const { service, projectId } = await project('destination moved on');

  const first = await service.applyDecisions(OWNER, projectId, { decisions: [demote('melody-1')] });
  // The event moves again, between two non-Lead roles. That is not a Lead move,
  // so it carries no Lead evidence -- but the recovered citation argues for
  // Chord3 and the candidate now has Chord4, so the recovered record is stale
  // for a reason no citation about Chord3 could answer.
  const second = await service.applyDecisions(OWNER, projectId, {
    parentCandidateId: first.decisions.candidate_id,
    decisions: [{
      id: 'move-on:melody-1', type: 'MOVE_ROLE', target: { eventIds: ['melody-1'] }, fromRole: 'Chord3', toRole: 'Chord4',
      reason: 'Reviewed: this reads as enrichment rather than core harmony.',
      evidence: ['fixture:review note'], acceptedBy: 'reviewer:test',
    }],
  });
  const candidateId = second.decisions.candidate_id;

  const stale = reportFor((await service.reviewCandidate(OWNER, projectId, { candidateId })).review.lead_demotion, 'melody-1');
  assert.equal(stale.status, 'PENDING');
  assert.ok(stale.blockers.includes('LEAD_EVIDENCE_DESTINATION_DOES_NOT_MATCH_CANDIDATE'));

  // A fresh citation is an argument about the candidate as it stands, so it is
  // graded against the role the event actually has now. Without this the Lead
  // gate would be unclearable again.
  await service.reviewLeadEvidence(OWNER, projectId, {
    candidateId,
    review: {
      event_id: 'melody-1', axis: 'demotion',
      reason: 'Re-reviewed: inner material, and enrichment is where it sits now.',
      evidence: ['fixture:score inner staff'],
      lead_evidence: demotionEvidence('melody-1'),
    },
  });

  const after = (await service.reviewCandidate(OWNER, projectId, { candidateId })).review;
  const report = reportFor(after.lead_demotion, 'melody-1');
  assert.equal(report.status, 'PASS');
  assert.equal(report.destinationRole, 'Chord4', 'graded against the role the candidate actually has');
  assert.equal(report.evidenceSource, 'candidate-review');
  assert.equal(after.readiness.gates.leadDemotion.status, 'PASS');
});

test('a citation that turns out to be wrong can be retracted, and the gate returns to PENDING', async () => {
  const { service, projectId } = await project('supersede');

  const first = await service.applyDecisions(OWNER, projectId, { decisions: [promote('chord3-1')] });
  const second = await service.applyDecisions(OWNER, projectId, {
    parentCandidateId: first.decisions.candidate_id, decisions: [demote('melody-1')],
  });
  const candidateId = second.decisions.candidate_id;
  const base = {
    event_id: 'chord3-1', axis: 'promotion', reason: 'Re-reviewed against this candidate.',
    evidence: ['fixture:score top line'], lead_evidence: promotionEvidence('chord3-1'),
  };

  await service.reviewLeadEvidence(OWNER, projectId, { candidateId, review: base });
  assert.equal(reportFor((await service.reviewCandidate(OWNER, projectId, { candidateId })).review.lead_promotion, 'chord3-1').status, 'PASS');

  // An answered question is not re-opened by accident.
  await assert.rejects(
    () => service.reviewLeadEvidence(OWNER, projectId, { candidateId, review: base }),
    /Supply supersede_reason to replace the citation on record/,
  );

  // With an explicit retraction it is, and the replacement is graded like any
  // other citation -- so withdrawing a claim returns the gate to PENDING rather
  // than forcing anything.
  const retracted = await service.reviewLeadEvidence(OWNER, projectId, {
    candidateId,
    review: {
      ...base,
      reason: 'Re-listened: the top line is doubled, and this is the inner half.',
      supersede_reason: 'The earlier citation read the wrong staff.',
      lead_evidence: promotionEvidence('chord3-1', {
        scoreEvidence: { availability: 'available', classification: 'inner', citation: 'fixture:score inner staff' },
        audioEvidence: { availability: 'available', classification: 'background', citation: 'fixture:audio behind' },
      }),
    },
  });
  assert.equal(retracted.review.supersede_reason, 'The earlier citation read the wrong staff.');

  const after = (await service.reviewCandidate(OWNER, projectId, { candidateId })).review;
  assert.equal(reportFor(after.lead_promotion, 'chord3-1').status, 'PENDING', 'a withdrawn claim does not stay PASS');
  assert.equal(after.readiness.gates.leadPromotion.status, 'PENDING');
  // Both citations stay on the record: the superseded one is the audit trail.
  assert.equal(after.lead_evidence_reviews.length, 2);
  assert.equal(after.lead_evidence_reviews[1].supersedeReason, 'The earlier citation read the wrong staff.');
});
