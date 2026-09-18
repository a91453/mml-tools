import test from 'node:test';
import assert from 'node:assert/strict';
import {
  evaluateLeadPromotion,
  LEAD_EVIDENCE_IDENTITY_MISMATCH,
} from '../backend/arbitration/lead-demotion.mjs';

const identity = { sourceId: 'official-score', sourceEventId: 'part:P1/measure:1/voice:2/note:1' };
const sourceEvent = {
  id: 'source:inner-1',
  role: 'Chord1',
  pitch: 67,
  start: '0',
  end: '1',
  sourceIds: [identity.sourceId],
  sourceEventIds: [identity.sourceEventId],
};
const continuityPass = { checked: true, createsLeadGap: false, replacementEventIds: [] };
const core3Pass = { checked: true, status: 'PASS' };

const fullEvidence = overrides => ({
  event: sourceEvent,
  destinationRole: 'Melody',
  sourceIdentity: identity,
  sectionRole: 'instrumental',
  scoreEvidence: { availability: 'available', classification: 'lead', citation: 'official-score:P1/top-line' },
  audioEvidence: { availability: 'available', classification: 'foreground', citation: 'original-audio:lead-review@00:12.400' },
  continuity: continuityPass,
  core3: core3Pass,
  positiveReason: 'The cited source line carries the foreground instrumental lead in this section.',
  ...overrides,
});

test('positive source-bound Lead evidence passes promotion grading', () => {
  const gate = evaluateLeadPromotion(fullEvidence());
  assert.equal(gate.status, 'PASS');
  assert.equal(gate.pass, true);
  assert.deepEqual([...gate.blockers], []);
  assert.equal(gate.eventId, sourceEvent.id);
  assert.equal(gate.destinationRole, 'Melody');
  assert.deepEqual(gate.evidence.sourceIdentityBinding, { bound: true, blockers: [] });
});

test('promotion requires reviewed continuity, Core3 and a positive Melody destination reason', () => {
  const gate = evaluateLeadPromotion(fullEvidence({
    continuity: { checked: false, createsLeadGap: null, replacementEventIds: [] },
    core3: { checked: false, status: 'PENDING' },
    positiveReason: '',
  }));
  assert.equal(gate.status, 'PENDING');
  for (const blocker of ['LEAD_CONTINUITY_NOT_CHECKED', 'CORE3_NOT_CHECKED', 'POSITIVE_DESTINATION_REASON_MISSING']) {
    assert.ok(gate.blockers.includes(blocker), blocker);
  }
});

test('highest-note style inference cannot replace positive Lead evidence', () => {
  const gate = evaluateLeadPromotion(fullEvidence({
    scoreEvidence: { availability: 'available', classification: 'inner', citation: 'official-score:P1/inner' },
    audioEvidence: { availability: 'available', classification: 'background', citation: 'original-audio:background' },
  }));
  assert.equal(gate.status, 'PENDING');
  assert.ok(gate.blockers.includes('POSITIVE_LEAD_EVIDENCE_MISSING'));
});

test('conflicting source-role evidence keeps promotion pending', () => {
  const gate = evaluateLeadPromotion(fullEvidence({
    scoreEvidence: { availability: 'available', classification: 'lead', citation: 'official-score:P1/top-line' },
    audioEvidence: { availability: 'available', classification: 'background', citation: 'original-audio:background' },
  }));
  assert.equal(gate.status, 'PENDING');
  assert.ok(gate.blockers.includes('SOURCE_ROLE_EVIDENCE_CONFLICT'));
});

test('promotion evidence is bound to the exact source event', () => {
  const gate = evaluateLeadPromotion(fullEvidence({
    sourceIdentity: { sourceId: identity.sourceId, sourceEventId: 'part:P1/measure:9/voice:2/note:9' },
  }));
  assert.equal(gate.status, 'PENDING');
  assert.ok(gate.blockers.includes(LEAD_EVIDENCE_IDENTITY_MISMATCH));
  assert.equal(gate.evidence.sourceIdentityBinding.bound, false);
});

test('already-Melody material is outside the promotion gate', () => {
  const gate = evaluateLeadPromotion({ event: { ...sourceEvent, role: 'Melody' } });
  assert.equal(gate.status, 'N/A');
  assert.equal(gate.pass, true);
});
