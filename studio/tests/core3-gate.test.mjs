import test from 'node:test';
import assert from 'node:assert/strict';
import { createSource, createCanonicalNoteEvent, createCanonicalProject } from '../backend/canonical/index.mjs';
import { evaluateCore3Continuity } from '../backend/arbitration/core3.mjs';

function project(id, specs) {
  const source = createSource({
    id: `${id}-source`, label: id, kind: id === 'candidate' ? 'current-mml' : 'historical-mml', authority: 'derived',
  });
  const events = specs.map((spec, index) => createCanonicalNoteEvent({
    id: `${id}:n${index + 1}`,
    pitch: spec.pitch,
    start: spec.start,
    end: spec.end,
    role: spec.role,
    sourceIds: [source.id],
  }));
  return createCanonicalProject({ id, title: id, sources: [source], events });
}

test('identical source-relative Core3 passes without demanding continuous density', () => {
  const baseline = project('baseline', [
    { pitch: 60, start: '0', end: '1', role: 'Melody' },
    { pitch: 64, start: '0', end: '1', role: 'Chord1' },
    { pitch: 48, start: '0', end: '1', role: 'Chord2' },
    { pitch: 62, start: '3', end: '4', role: 'Melody' },
  ]);
  const candidate = project('candidate', [
    { pitch: 60, start: '0', end: '1', role: 'Melody' },
    { pitch: 64, start: '0', end: '1', role: 'Chord1' },
    { pitch: 48, start: '0', end: '1', role: 'Chord2' },
    { pitch: 62, start: '3', end: '4', role: 'Melody' },
  ]);
  const gate = evaluateCore3Continuity({ baseline, candidate });
  assert.equal(gate.status, 'PASS');
  assert.equal(gate.falseLeadGaps.length, 0);
  assert.match(gate.notice, /True source rests/i);
});

test('removing a source-supported Lead event creates a blocking Lead gap', () => {
  const baseline = project('baseline', [
    { pitch: 60, start: '0', end: '2', role: 'Melody' },
    { pitch: 64, start: '0', end: '2', role: 'Chord1' },
  ]);
  const candidate = project('candidate', [
    { pitch: 64, start: '0', end: '2', role: 'Chord1' },
  ]);
  const gate = evaluateCore3Continuity({ baseline, candidate });
  assert.equal(gate.status, 'PENDING');
  assert.ok(gate.blockers.includes('UNAPPROVED_CORE3_SOURCE_CHANGE'));
  assert.ok(gate.blockers.includes('SOURCE_SUPPORTED_LEAD_GAP'));
  assert.deepEqual(gate.falseLeadGaps.map(gap => [gap.start, gap.end]), [['0', '2']]);
});

test('approving a Lead demotion cannot hide a resulting Lead gap', () => {
  const baseline = project('baseline', [
    { pitch: 69, start: '0', end: '1', role: 'Melody' },
  ]);
  const candidate = project('candidate', [
    { pitch: 69, start: '0', end: '1', role: 'Chord3' },
  ]);
  const baselineEventId = baseline.events[0].id;
  const gate = evaluateCore3Continuity({
    baseline,
    candidate,
    approvedChanges: [{
      type: 'role-move',
      eventId: baselineEventId,
      reason: 'Source evidence classifies this event as background texture.',
      evidence: ['official-score:staff2', 'original-audio:background-role'],
    }],
  });
  assert.equal(gate.roleMovesFromCore3[0].approval.eventId, baselineEventId);
  assert.equal(gate.unapproved.length, 0);
  assert.equal(gate.status, 'PENDING');
  assert.deepEqual(gate.blockers, ['SOURCE_SUPPORTED_LEAD_GAP']);
});

test('evidence-backed Core Harmony modification can pass when Lead continuity is intact', () => {
  const baseline = project('baseline', [
    { pitch: 60, start: '0', end: '2', role: 'Melody' },
    { pitch: 64, start: '0', end: '2', role: 'Chord1' },
  ]);
  const candidate = project('candidate', [
    { pitch: 60, start: '0', end: '2', role: 'Melody' },
    { pitch: 65, start: '0', end: '2', role: 'Chord1' },
  ]);
  const harmonyEvent = baseline.events.find(event => event.role === 'Chord1');
  const gate = evaluateCore3Continuity({
    baseline,
    candidate,
    approvedChanges: [{
      type: 'modify',
      eventId: harmonyEvent.id,
      reason: 'Official score voicing corrects the historical candidate.',
      evidence: ['official-musicxml:Piano/measure1/voice2'],
    }],
  });
  assert.equal(gate.status, 'PASS');
  assert.equal(gate.modifiedCore3.length, 1);
  assert.equal(gate.falseLeadGaps.length, 0);
});

test('adding Full6 enrichment does not make Core3 fail', () => {
  const baseline = project('baseline', [
    { pitch: 60, start: '0', end: '1', role: 'Melody' },
    { pitch: 48, start: '0', end: '1', role: 'Chord2' },
  ]);
  const candidate = project('candidate', [
    { pitch: 60, start: '0', end: '1', role: 'Melody' },
    { pitch: 48, start: '0', end: '1', role: 'Chord2' },
    { pitch: 72, start: '0', end: '1', role: 'Chord3' },
  ]);
  const gate = evaluateCore3Continuity({ baseline, candidate });
  assert.equal(gate.status, 'PASS');
  assert.equal(gate.sourceDiff.summary.noteAdded, 1);
});

test('large register jumps are diagnostic and never auto-fail Core3', () => {
  const baseline = project('baseline', [
    { pitch: 48, start: '0', end: '1', role: 'Chord2' },
    { pitch: 72, start: '2', end: '3', role: 'Chord2' },
  ]);
  const candidate = project('candidate', [
    { pitch: 48, start: '0', end: '1', role: 'Chord2' },
    { pitch: 72, start: '2', end: '3', role: 'Chord2' },
  ]);
  const gate = evaluateCore3Continuity({ baseline, candidate });
  assert.equal(gate.status, 'PASS');
  assert.equal(gate.candidateRoleStats.Chord2.largestAdjacentJump, 24);
  assert.equal(gate.candidateRoleStats.Chord2.octavePlusJumps.length, 1);
});
