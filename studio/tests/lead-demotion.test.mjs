import test from 'node:test';
import assert from 'node:assert/strict';
import { evaluateLeadDemotion } from '../backend/arbitration/lead-demotion.mjs';

const lead = { id: 'source:n1', role: 'Melody', pitch: 69, start: '0', end: '1' };
const identity = { sourceId: 'official-score', sourceEventId: 'part:P1/measure:1/voice:1/note:1' };
const continuityPass = { checked: true, createsLeadGap: false, replacementEventIds: ['candidate:n2'] };
const core3Pass = { checked: true, status: 'PASS' };

test('not proven Vocal can never pass as the reason for demotion', () => {
  const gate = evaluateLeadDemotion({
    event: lead,
    destinationRole: 'Chord1',
    sourceIdentity: identity,
    sectionRole: 'vocal-active',
    scoreEvidence: { availability: 'unavailable' },
    audioEvidence: { availability: 'unavailable' },
    continuity: continuityPass,
    core3: core3Pass,
    positiveReason: 'The note is not proven to be Vocal.',
  });
  assert.equal(gate.status, 'PENDING');
  assert.ok(gate.blockers.includes('POSITIVE_ROLE_EVIDENCE_MISSING'));
  assert.match(gate.notice, /Not proven Vocal/i);
});

test('positive accompaniment evidence can pass when continuity and Core3 also pass', () => {
  const gate = evaluateLeadDemotion({
    event: lead,
    destinationRole: 'Chord1',
    sourceIdentity: identity,
    sectionRole: 'vocal-active',
    scoreEvidence: {
      availability: 'available', classification: 'inner', citation: 'official-score:P1/staff2/voice2',
    },
    audioEvidence: {
      availability: 'available', classification: 'background', citation: 'original-audio:foreground-review@00:12.400',
    },
    continuity: continuityPass,
    core3: core3Pass,
    positiveReason: 'Official voicing and the recording place this event in the supporting inner voice.',
  });
  assert.equal(gate.status, 'PASS');
  assert.deepEqual(gate.blockers, []);
});

test('source evidence supporting Lead keeps the demotion pending even if another source says background', () => {
  const gate = evaluateLeadDemotion({
    event: lead,
    destinationRole: 'Chord1',
    sourceIdentity: identity,
    sectionRole: 'vocal-active',
    scoreEvidence: {
      availability: 'available', classification: 'lead', citation: 'official-score:P1/voice1',
    },
    audioEvidence: {
      availability: 'available', classification: 'background', citation: 'original-audio:mix-review',
    },
    continuity: continuityPass,
    core3: core3Pass,
    positiveReason: 'Audio mix sounds subordinate.',
  });
  assert.equal(gate.status, 'PENDING');
  assert.ok(gate.blockers.includes('SOURCE_ROLE_EVIDENCE_CONFLICT'));
});

test('a demotion that creates a Lead gap remains blocked regardless of role evidence', () => {
  const gate = evaluateLeadDemotion({
    event: lead,
    destinationRole: 'Chord3',
    sourceIdentity: identity,
    sectionRole: 'vocal-active',
    scoreEvidence: {
      availability: 'available', classification: 'duplicate', citation: 'official-score:duplicate-voice',
    },
    audioEvidence: { availability: 'unavailable' },
    continuity: { checked: true, createsLeadGap: true, replacementEventIds: [] },
    core3: core3Pass,
    positiveReason: 'Duplicate support line.',
  });
  assert.equal(gate.status, 'PENDING');
  assert.ok(gate.blockers.includes('LEAD_GAP_CREATED'));
});

test('instrumental windows warn instead of treating absence of Vocal as demotion evidence', () => {
  const gate = evaluateLeadDemotion({
    event: lead,
    destinationRole: 'Chord3',
    sourceIdentity: identity,
    sectionRole: 'solo',
    scoreEvidence: {
      availability: 'available', classification: 'lead', citation: 'official-score:guitar-solo',
    },
    audioEvidence: {
      availability: 'available', classification: 'foreground', citation: 'original-audio:guitar-solo',
    },
    continuity: continuityPass,
    core3: core3Pass,
    positiveReason: 'Attempted cleanup during solo.',
  });
  assert.equal(gate.status, 'PENDING');
  assert.ok(gate.warnings.includes('INSTRUMENTAL_LEAD_WINDOW_REQUIRES_EXTRA_CAUTION'));
  assert.ok(gate.blockers.includes('SOURCE_ROLE_EVIDENCE_CONFLICT'));
});

test('non-Melody events are outside the Lead Demotion Gate', () => {
  const gate = evaluateLeadDemotion({ event: { ...lead, role: 'Chord1' }, destinationRole: 'Chord3' });
  assert.equal(gate.status, 'N/A');
  assert.equal(gate.pass, true);
});
