import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createSource,
  createCanonicalNoteEvent,
  createArbitrationDecision,
  createCanonicalProject,
} from '../backend/canonical/index.mjs';
import { analyzeCrossSourceHarmony } from '../backend/arbitration/harmony.mjs';

function sources() {
  return [
    createSource({ id: 'official', label: 'Official score', kind: 'official-musicxml', authority: 'primary-symbolic' }),
    createSource({ id: 'thirdparty', label: 'Third-party score', kind: 'third-party-musicxml', authority: 'supporting' }),
  ];
}

function note(id, sourceId, role, pitch, start = '0', end = '1') {
  return createCanonicalNoteEvent({ id, pitch, start, end, role, sourceIds: [sourceId] });
}

test('same-pitch notes from separate sources require arbitration instead of blind stacking', () => {
  const [official, thirdparty] = sources();
  const events = [
    note('official:n1', 'official', 'Chord1', 60),
    note('thirdparty:n1', 'thirdparty', 'Chord4', 60),
  ];
  const project = createCanonicalProject({ id: 'same-pitch', title: 'Same pitch', sources: [official, thirdparty], events });
  const report = analyzeCrossSourceHarmony(project);

  assert.equal(report.status, 'PENDING');
  assert.equal(report.conflictCount, 1);
  assert.equal(report.conflicts[0].kind, 'cross-source-same-pitch');
  assert.equal(report.conflicts[0].core3Threat, true);
  assert.match(report.notice, /provenance, not compatibility/i);
});

test('low-mid cross-source m2 against enrichment is a Core3 threat but never auto-deleted', () => {
  const [official, thirdparty] = sources();
  const events = [
    note('official:n1', 'official', 'Chord1', 60),
    note('thirdparty:n1', 'thirdparty', 'Chord3', 61),
  ];
  const project = createCanonicalProject({ id: 'm2', title: 'm2', sources: [official, thirdparty], events });
  const report = analyzeCrossSourceHarmony(project);

  assert.equal(report.status, 'PENDING');
  assert.equal(report.core3ThreatCount, 1);
  assert.equal(report.conflicts[0].intervalName, 'm2');
  assert.equal(report.conflicts[0].registerRisk, 'low-mid');
  assert.match(report.conflicts[0].notice, /not an automatic deletion/i);
});

test('accepted evidence-backed conflict decision resolves the harmony gate without rewriting events', () => {
  const [official, thirdparty] = sources();
  const left = note('official:n1', 'official', 'Chord1', 60);
  const right = note('thirdparty:n1', 'thirdparty', 'Chord3', 61);
  const decision = createArbitrationDecision({
    id: 'decision-1',
    eventIds: [left.id, right.id],
    action: 'reassign-octave:thirdparty:n1:+12',
    status: 'accepted',
    reason: 'Third-party color tone is retained one octave higher so Core3 remains clear.',
    evidence: ['official-score:core-harmony', 'thirdparty-score:color-tone', 'mobile-ab:upper-register-clearer'],
  });
  const project = createCanonicalProject({
    id: 'resolved', title: 'Resolved', sources: [official, thirdparty], events: [left, right], decisions: [decision],
  });
  const report = analyzeCrossSourceHarmony(project);

  assert.equal(report.status, 'PASS');
  assert.equal(report.unresolvedCount, 0);
  assert.equal(report.conflicts[0].decision.id, 'decision-1');
  assert.equal(project.events[1].pitch, 61, 'arbitration record must not silently mutate source truth');
});

test('compatible cross-source harmony is allowed without manufacturing a conflict', () => {
  const [official, thirdparty] = sources();
  const project = createCanonicalProject({
    id: 'compatible', title: 'Compatible', sources: [official, thirdparty],
    events: [
      note('official:n1', 'official', 'Chord1', 60),
      note('thirdparty:n1', 'thirdparty', 'Chord3', 64),
    ],
  });
  const report = analyzeCrossSourceHarmony(project);
  assert.equal(report.status, 'PASS');
  assert.equal(report.conflictCount, 0);
});

test('notes supported by the same source do not become cross-source conflicts', () => {
  const [official] = sources();
  const project = createCanonicalProject({
    id: 'same-source', title: 'Same source', sources: [official],
    events: [
      note('official:n1', 'official', 'Chord1', 60),
      note('official:n2', 'official', 'Chord2', 61),
    ],
  });
  const report = analyzeCrossSourceHarmony(project);
  assert.equal(report.status, 'PASS');
  assert.equal(report.conflictCount, 0);
});
