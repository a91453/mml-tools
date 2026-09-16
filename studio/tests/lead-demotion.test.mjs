import test from 'node:test';
import assert from 'node:assert/strict';
import {
  evaluateLeadDemotion,
  sourceIdentityBlockers,
  singleSourceIdentityOf,
  LEAD_EVIDENCE_IDENTITY_MISMATCH,
  LEAD_EVIDENCE_PROVENANCE_PAIR_AMBIGUOUS,
  LEAD_EVIDENCE_IDENTITY_BLOCKERS,
} from '../backend/arbitration/lead-demotion.mjs';

// The gate binds a citation to the event it is asked about, so the fixture
// event carries the provenance its identity cites. Before the G11-D residual
// hardening this fixture carried none and the gate did not look; a PASS then
// said nothing about *which* source event the evidence described.
const identity = { sourceId: 'official-score', sourceEventId: 'part:P1/measure:1/voice:1/note:1' };
const lead = { id: 'source:n1', role: 'Melody', pitch: 69, start: '0', end: '1', sourceIds: [identity.sourceId], sourceEventIds: [identity.sourceEventId] };
const otherLead = { id: 'source:n2', role: 'Melody', pitch: 71, start: '1', end: '2', sourceIds: [identity.sourceId], sourceEventIds: ['part:P1/measure:1/voice:1/note:2'] };
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

// ─── identity binding inside the gate (G11-D residual A) ────────────────────

const fullEvidence = overrides => ({
  event: lead,
  destinationRole: 'Chord1',
  sourceIdentity: identity,
  sectionRole: 'vocal-active',
  scoreEvidence: { availability: 'available', classification: 'inner', citation: 'official-score:P1/staff2/voice2' },
  audioEvidence: { availability: 'available', classification: 'background', citation: 'original-audio:foreground-review@00:12.400' },
  continuity: continuityPass,
  core3: core3Pass,
  positiveReason: 'Official voicing and the recording place this event in the supporting inner voice.',
  ...overrides,
});

const identityOnly = gate => gate.blockers.filter(code => LEAD_EVIDENCE_IDENTITY_BLOCKERS.includes(code));

test('A1: a citation naming the exact source event of the target passes exactly as before', () => {
  const gate = evaluateLeadDemotion(fullEvidence());
  assert.equal(gate.status, 'PASS');
  assert.deepEqual([...gate.blockers], []);
  assert.deepEqual(gate.evidence.sourceIdentityBinding, { bound: true, blockers: [] });
  // Any of the event's source event ids is a citation of that source event.
  const twoRefs = { ...lead, sourceEventIds: ['track:0/event:1', identity.sourceEventId] };
  assert.equal(evaluateLeadDemotion(fullEvidence({ event: twoRefs })).status, 'PASS');
});

test('A2: event A judged with event B\'s source event identity is PENDING under A\'s id', () => {
  // The record names event A; the citation is B's. Before: PASS carrying A's
  // id, which is the key the readiness Lead gate matches on.
  const gate = evaluateLeadDemotion(fullEvidence({
    event: lead,
    sourceIdentity: { sourceId: identity.sourceId, sourceEventId: otherLead.sourceEventIds[0] },
  }));
  assert.equal(gate.status, 'PENDING');
  assert.equal(gate.eventId, lead.id);
  assert.deepEqual(identityOnly(gate), [LEAD_EVIDENCE_IDENTITY_MISMATCH]);
  assert.equal(gate.evidence.sourceIdentityBinding.bound, false);
});

test('A3: the same source with a wrong source event id is refused', () => {
  const gate = evaluateLeadDemotion(fullEvidence({ sourceIdentity: { sourceId: identity.sourceId, sourceEventId: 'part:P1/measure:9/voice:1/note:9' } }));
  assert.equal(gate.status, 'PENDING');
  assert.deepEqual(identityOnly(gate), [LEAD_EVIDENCE_IDENTITY_MISMATCH]);
});

test('A4: the right source event id under a wrong source is refused', () => {
  const gate = evaluateLeadDemotion(fullEvidence({ sourceIdentity: { sourceId: 'third-party-midi', sourceEventId: identity.sourceEventId } }));
  assert.equal(gate.status, 'PENDING');
  assert.deepEqual(identityOnly(gate), [LEAD_EVIDENCE_IDENTITY_MISMATCH]);
});

test('A5: an event whose provenance states no source event ids fails closed', () => {
  const bare = { ...lead, sourceEventIds: [] };
  const gate = evaluateLeadDemotion(fullEvidence({ event: bare }));
  assert.equal(gate.status, 'PENDING');
  assert.deepEqual(identityOnly(gate), ['TARGET_EVENT_SOURCE_EVENT_IDS_MISSING']);
  // And an event with no provenance at all -- the shape the old fixture had.
  const none = { id: 'source:n1', role: 'Melody', pitch: 69, start: '0', end: '1' };
  const gateNone = evaluateLeadDemotion(fullEvidence({ event: none }));
  assert.equal(gateNone.status, 'PENDING');
  assert.deepEqual(identityOnly(gateNone), ['TARGET_EVENT_SOURCE_IDS_MISSING', 'TARGET_EVENT_SOURCE_EVENT_IDS_MISSING']);
});

test('A6: a multi-source event cannot prove the pair and fails closed whatever the citation', () => {
  const multi = { ...lead, sourceIds: ['official-score', 'third-party-midi'], sourceEventIds: [identity.sourceEventId, 'track:1/event:4'] };
  for (const sourceIdentity of [
    { sourceId: 'official-score', sourceEventId: identity.sourceEventId },   // apparently correct
    { sourceId: 'third-party-midi', sourceEventId: 'track:1/event:4' },      // apparently correct
    { sourceId: 'official-score', sourceEventId: 'track:1/event:4' },        // cross-paired
    { sourceId: 'official-score', sourceEventId: otherLead.sourceEventIds[0] }, // foreign
  ]) {
    const gate = evaluateLeadDemotion(fullEvidence({ event: multi, sourceIdentity }));
    assert.equal(gate.status, 'PENDING');
    assert.deepEqual(identityOnly(gate), [LEAD_EVIDENCE_PROVENANCE_PAIR_AMBIGUOUS], JSON.stringify(sourceIdentity));
  }
  // No constructor will index-pair such an event, and the gate says why.
  assert.equal(singleSourceIdentityOf(multi), null);
  const noIdentity = evaluateLeadDemotion(fullEvidence({ event: multi, sourceIdentity: null }));
  assert.deepEqual(identityOnly(noIdentity), ['SOURCE_IDENTITY_MISSING', LEAD_EVIDENCE_PROVENANCE_PAIR_AMBIGUOUS]);
});

test('A7: a derived duplicate binds to its origin provenance, never to its own id', () => {
  const duplicate = { ...lead, id: `${lead.id}#g11d-dup:0123456789abcdef`, tags: ['g11d-derived-duplicate'] };
  assert.equal(evaluateLeadDemotion(fullEvidence({ event: duplicate })).status, 'PASS');
  const asOwnId = evaluateLeadDemotion(fullEvidence({ event: duplicate, sourceIdentity: { sourceId: identity.sourceId, sourceEventId: duplicate.id } }));
  assert.deepEqual(identityOnly(asOwnId), [LEAD_EVIDENCE_IDENTITY_MISMATCH]);
});

test('an identity that is merely two non-empty strings is not an identity', () => {
  for (const sourceIdentity of [
    { sourceId: 'anything', sourceEventId: 'anything' },
    { sourceId: identity.sourceId, sourceEventId: lead.id },
    { sourceId: identity.sourceId, sourceEventId: identity.sourceEventId.toUpperCase() },
  ]) {
    const gate = evaluateLeadDemotion(fullEvidence({ sourceIdentity }));
    assert.equal(gate.status, 'PENDING', JSON.stringify(sourceIdentity));
    assert.deepEqual(identityOnly(gate), [LEAD_EVIDENCE_IDENTITY_MISMATCH]);
  }
  for (const sourceIdentity of [undefined, null, {}, { sourceId: identity.sourceId }, { sourceEventId: identity.sourceEventId }, { sourceId: ' ', sourceEventId: identity.sourceEventId }]) {
    assert.deepEqual(identityOnly(evaluateLeadDemotion(fullEvidence({ sourceIdentity }))), ['SOURCE_IDENTITY_MISSING'], JSON.stringify(sourceIdentity));
  }
});

test('the binding is a scope check and never manufactures a verdict', () => {
  // Correct citation, weak evidence: the existing blockers, and no identity code.
  const weak = evaluateLeadDemotion(fullEvidence({ scoreEvidence: { availability: 'unavailable' }, audioEvidence: { availability: 'unavailable' } }));
  assert.equal(weak.status, 'PENDING');
  assert.ok(weak.blockers.includes('POSITIVE_ROLE_EVIDENCE_MISSING'));
  assert.deepEqual(identityOnly(weak), []);
  // The exported binding is what the gate ran: same event, same codes.
  const foreign = fullEvidence({ sourceIdentity: { sourceId: identity.sourceId, sourceEventId: otherLead.sourceEventIds[0] } });
  assert.deepEqual(identityOnly(evaluateLeadDemotion(foreign)), sourceIdentityBlockers(foreign.sourceIdentity, foreign.event));
});

test('singleSourceIdentityOf constructs an identity only when the pair is provable', () => {
  assert.deepEqual(singleSourceIdentityOf(lead), { sourceId: identity.sourceId, sourceEventId: identity.sourceEventId });
  assert.deepEqual(sourceIdentityBlockers(singleSourceIdentityOf(lead), lead), []);
  assert.equal(singleSourceIdentityOf({ ...lead, sourceEventIds: [] }), null);
  assert.equal(singleSourceIdentityOf({ ...lead, sourceIds: [] }), null);
  assert.equal(singleSourceIdentityOf({ ...lead, sourceIds: ['a', 'b'] }), null);
  assert.equal(singleSourceIdentityOf(null), null);
});
