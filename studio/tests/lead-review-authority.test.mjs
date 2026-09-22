// Lead evidence review authority: a lower evidence layer must not impersonate a
// higher one (MASTER_RULES §11), and an audio metric is a locator, never role
// evidence by itself (SOURCE_POLICY §6).
//
// What these pin:
//   * a review must say who made it and how its audio classification was
//     established, or it is refused and nothing is stored;
//   * an agent/tool review is kept for the audit trail but never reaches the
//     shared Lead grader, in review or in finalize;
//   * a stored historical review with no attestation is kept, unchanged, and is
//     not counted;
//   * a human review whose audio classification came from a machine metric is
//     graded without that audio as positive evidence;
//   * the grader itself refuses a metric as positive Lead/non-Lead evidence but
//     still lets it raise a conflict.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createStudioApplication } from '../backend/application/index.mjs';
import { createStore } from '../backend/application/store.mjs';
import { LEAD_REVIEW_AUTHORITY } from '../backend/application/lead-review-authority.mjs';
import { leadContextDigestOf } from '../backend/arrangement/decision-application.mjs';
import {
  evaluateLeadPromotion,
  evaluateLeadDemotion,
  AUDIO_METRIC_NOT_ROLE_EVIDENCE,
} from '../backend/arbitration/lead-demotion.mjs';
import { canonicalProjectBytes, sixRoleBaseline } from './fixtures/application-fixtures.mjs';

const OWNER = 'owner:alice';
const SOURCE_ID = 'fixture:official-midi';
const HUMAN = Object.freeze({ reviewer: 'human:alice', reviewer_kind: 'human', audio_basis: 'listening' });
const AGENT = Object.freeze({ reviewer: 'agent:some-model', reviewer_kind: 'agent', audio_basis: 'machine-metric' });

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
const demotionEvidence = eventId => promotionEvidence(eventId, {
  scoreEvidence: { availability: 'available', classification: 'inner', citation: 'fixture:score inner staff' },
  audioEvidence: { availability: 'available', classification: 'background', citation: 'fixture:audio 0:00 behind the lead' },
  positiveReason: 'The score places this attack on the inner staff and the mix keeps it behind the lead.',
});
const promote = eventId => ({
  id: `promote:${eventId}`, type: 'MOVE_ROLE', target: { eventIds: [eventId] }, fromRole: 'Chord3', toRole: 'Melody',
  reason: 'Reviewed: this cited voice carries the foreground lead.', evidence: ['fixture:score top line'],
  leadEvidence: promotionEvidence(eventId), acceptedBy: 'reviewer:test',
});
const demote = eventId => ({
  id: `demote:${eventId}`, type: 'MOVE_ROLE', target: { eventIds: [eventId] }, fromRole: 'Melody', toRole: 'Chord3',
  reason: 'Reviewed: inner material.', evidence: ['fixture:score inner staff'],
  leadEvidence: demotionEvidence(eventId), acceptedBy: 'reviewer:test',
});
const reportFor = (reports, eventId) => reports.find(report => report.eventId === eventId);
const review = (attestation, over = {}) => ({
  ...(attestation ? { attestation } : {}),
  event_id: 'chord3-1', axis: 'promotion',
  reason: 'Re-reviewed against the Lead picture as it now stands.',
  evidence: ['fixture:score top line bar 1'],
  lead_evidence: promotionEvidence('chord3-1'),
  ...over,
});

// A candidate whose promotion of chord3-1 is PENDING and waiting on a fresh review.
async function stalePromotion(dataDirectory = null) {
  const service = dataDirectory
    ? createStudioApplication({ dataDirectory, durability: 'persistent' })
    : createStudioApplication();
  const { project } = await service.createProject(OWNER, { title: 'authority' });
  const projectId = project.project_id;
  await service.uploadAsset(OWNER, projectId, { kind: 'canonical_project', filename: 'b.json', mediaType: 'application/json', bytes: canonicalProjectBytes(sixRoleBaseline()) });
  await service.analyzeSources(OWNER, projectId);
  const first = await service.applyDecisions(OWNER, projectId, { decisions: [promote('chord3-1')] });
  const second = await service.applyDecisions(OWNER, projectId, { parentCandidateId: first.decisions.candidate_id, decisions: [demote('melody-1')] });
  const candidateId = second.decisions.candidate_id;
  const stale = (await service.reviewCandidate(OWNER, projectId, { candidateId })).review;
  assert.equal(reportFor(stale.lead_promotion, 'chord3-1').status, 'PENDING');
  return { service, projectId, candidateId };
}

test('LRA-1 a review without an attestation is refused and nothing is stored', async () => {
  const { service, projectId, candidateId } = await stalePromotion();
  await assert.rejects(() => service.reviewLeadEvidence(OWNER, projectId, { candidateId, review: review(null) }), /attestation is required/);
  await assert.rejects(() => service.reviewLeadEvidence(OWNER, projectId, { candidateId, review: review({ ...HUMAN, reviewer_kind: 'person' }) }), /reviewer_kind/);
  await assert.rejects(() => service.reviewLeadEvidence(OWNER, projectId, { candidateId, review: review({ ...HUMAN, reviewer: ' ' }) }), /reviewer must name/);
  const after = (await service.reviewCandidate(OWNER, projectId, { candidateId })).review;
  assert.equal(after.lead_evidence_reviews.length, 0);
});

test('LRA-2 audio_basis must agree with the audio evidence it describes', async () => {
  const { service, projectId, candidateId } = await stalePromotion();
  await assert.rejects(() => service.reviewLeadEvidence(OWNER, projectId, { candidateId, review: review({ ...HUMAN, audio_basis: 'not-used' }) }), /cannot be not-used/);
  const noAudio = promotionEvidence('chord3-1', { audioEvidence: { availability: 'unavailable' } });
  await assert.rejects(() => service.reviewLeadEvidence(OWNER, projectId, { candidateId, review: review(HUMAN, { lead_evidence: noAudio }) }), /must be not-used/);
});

test('LRA-3 an agent review is recorded for audit but never moves the gate, in review or finalize', async () => {
  const { service, projectId, candidateId } = await stalePromotion();
  const recorded = await service.reviewLeadEvidence(OWNER, projectId, { candidateId, review: review(AGENT) });
  assert.equal(recorded.counted_as_reviewer_evidence, false);
  assert.equal(recorded.authority, LEAD_REVIEW_AUTHORITY.AGENT_OR_TOOL);
  assert.equal(recorded.report.status, 'PENDING');
  assert.equal(recorded.review.authenticated_owner, OWNER);
  const after = (await service.reviewCandidate(OWNER, projectId, { candidateId })).review;
  assert.equal(reportFor(after.lead_promotion, 'chord3-1').status, 'PENDING');
  assert.equal(after.readiness.gates.leadPromotion.status, 'PENDING');
  assert.equal(after.lead_evidence_reviews.length, 1, 'kept on record');
  assert.equal(after.lead_evidence_reviews[0].countedAsReviewerEvidence, false);
  assert.equal(after.lead_evidence_review_authority.counted_as_reviewer_evidence, 0);
  const final = await service.finalize(OWNER, projectId, { candidateId }).catch(error => error);
  const text = JSON.stringify(final?.details ?? final);
  assert.ok(/leadPromotion|LEAD_PROMOTION/.test(text), 'finalize is still blocked on the Lead promotion');
});

test('LRA-4 the same citation attested by a human counts; a later agent entry cannot displace it', async () => {
  const { service, projectId, candidateId } = await stalePromotion();
  const human = await service.reviewLeadEvidence(OWNER, projectId, { candidateId, review: review(HUMAN) });
  assert.equal(human.counted_as_reviewer_evidence, true);
  assert.equal(human.report.status, 'PASS');
  await service.reviewLeadEvidence(OWNER, projectId, { candidateId, review: review(AGENT, { supersede_reason: 'agent wants to restate', lead_evidence: promotionEvidence('chord3-1', { sectionRole: 'unknown' }) }) });
  const after = (await service.reviewCandidate(OWNER, projectId, { candidateId })).review;
  assert.equal(reportFor(after.lead_promotion, 'chord3-1').status, 'PASS');
  assert.equal(after.lead_evidence_reviews.length, 2);
});

test('LRA-5 a human review whose audio classification is a machine metric needs other positive evidence', async () => {
  const metricOnly = promotionEvidence('chord3-1', { scoreEvidence: { availability: 'unavailable' } });
  {
    const { service, projectId, candidateId } = await stalePromotion();
    const recorded = await service.reviewLeadEvidence(OWNER, projectId, { candidateId, review: review({ ...HUMAN, audio_basis: 'machine-metric' }, { lead_evidence: metricOnly }) });
    assert.equal(recorded.counted_as_reviewer_evidence, true);
    assert.equal(recorded.report.status, 'PENDING');
    assert.ok(recorded.report.blockers.includes('POSITIVE_LEAD_EVIDENCE_MISSING'));
    assert.ok(recorded.report.warnings.includes(AUDIO_METRIC_NOT_ROLE_EVIDENCE));
    // And from the stored record, on every later review.
    const reread = (await service.reviewCandidate(OWNER, projectId, { candidateId })).review;
    assert.equal(reportFor(reread.lead_promotion, 'chord3-1').status, 'PENDING');
    assert.ok(reportFor(reread.lead_promotion, 'chord3-1').warnings.includes(AUDIO_METRIC_NOT_ROLE_EVIDENCE));
  }
  {
    const { service, projectId, candidateId } = await stalePromotion();
    const recorded = await service.reviewLeadEvidence(OWNER, projectId, { candidateId, review: review(HUMAN, { lead_evidence: metricOnly }) });
    assert.equal(recorded.report.status, 'PASS', 'the same audio, stated as listened, is positive evidence');
  }
});

test('LRA-6 a historical review with no attestation stays on record and is not counted', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'lra-'));
  try {
    const { service, projectId, candidateId } = await stalePromotion(dir);
    const store = createStore({ directory: dir, durability: 'persistent' });
    const record = store.readProjectRecord(projectId);
    const legacy = {
      event_id: 'chord3-1', axis: 'promotion', lead_evidence: promotionEvidence('chord3-1'), reason: 'legacy', evidence: ['legacy citation'],
      lead_context_digest: null, origin_event_id: 'chord3-1', baseline_id: record.baseline.baseline_id, candidate_id: candidateId, at: '2026-09-22T15:00:00.000Z',
    };
    // Written the way a pre-attestation build stored it, bound to this exact
    // candidate's Lead context so that it would PASS if it were counted.
    const key = `lead-evidence-reviews:${projectId}:${candidateId}`;
    legacy.lead_context_digest = leadContextDigestOf(store.getJson(`application:${projectId}:${candidateId}`).candidate);
    // Control: the identical entry with a human attestation does count.
    store.putJson(key, [{ ...legacy, attestation: HUMAN }]);
    const control = (await service.reviewCandidate(OWNER, projectId, { candidateId })).review;
    assert.equal(reportFor(control.lead_promotion, 'chord3-1').status, 'PASS', 'the fixture entry is a passing citation when attested');
    store.putJson(key, [legacy]);
    const after = (await service.reviewCandidate(OWNER, projectId, { candidateId })).review;
    assert.equal(after.lead_evidence_reviews.length, 1);
    assert.equal(after.lead_evidence_reviews[0].authority, LEAD_REVIEW_AUTHORITY.UNATTESTED_LEGACY);
    assert.equal(reportFor(after.lead_promotion, 'chord3-1').status, 'PENDING');
    assert.deepEqual(store.getJson(key), [legacy], 'the stored record is not rewritten');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('LRA-7 grader: a metric is never positive role evidence but can still raise a conflict', () => {
  const event = { id: 'e1', role: 'Chord3', sourceIds: [SOURCE_ID], sourceEventIds: [`${SOURCE_ID}#e1`] };
  const base = {
    event, sourceIdentity: { sourceId: SOURCE_ID, sourceEventId: `${SOURCE_ID}#e1` }, sectionRole: 'vocal-active',
    continuity: { checked: true, createsLeadGap: false, replacementEventIds: [] }, core3: { checked: true, status: 'PASS' }, positiveReason: 'x',
  };
  const metricForeground = { availability: 'available', classification: 'foreground', citation: 'F0 match', basis: 'machine-metric' };
  const promo = evaluateLeadPromotion({ ...base, scoreEvidence: { availability: 'unavailable' }, audioEvidence: metricForeground });
  assert.equal(promo.status, 'PENDING');
  assert.ok(promo.blockers.includes('POSITIVE_LEAD_EVIDENCE_MISSING'));
  // A metric saying "background" still conflicts with a score saying "lead".
  const conflict = evaluateLeadPromotion({ ...base, scoreEvidence: { availability: 'available', classification: 'lead', citation: 's' }, audioEvidence: { ...metricForeground, classification: 'background' } });
  assert.ok(conflict.blockers.includes('SOURCE_ROLE_EVIDENCE_CONFLICT'));
  const melodyEvent = { ...event, role: 'Melody' };
  const demo = evaluateLeadDemotion({ ...base, event: melodyEvent, destinationRole: 'Chord3', scoreEvidence: { availability: 'unavailable' }, audioEvidence: { ...metricForeground, classification: 'background' } });
  assert.ok(demo.blockers.includes('POSITIVE_ROLE_EVIDENCE_MISSING'), 'a metric cannot demote a Lead');
  assert.throws(() => evaluateLeadPromotion({ ...base, audioEvidence: { ...metricForeground, basis: 'vibes' } }), /audio.basis/);
  // No basis: historical behaviour, byte-identical evidence shape.
  const legacy = evaluateLeadPromotion({ ...base, audioEvidence: { availability: 'available', classification: 'foreground', citation: 'a' } });
  assert.equal(legacy.status, 'PASS');
  assert.equal('basis' in legacy.evidence.audio, false);
});
