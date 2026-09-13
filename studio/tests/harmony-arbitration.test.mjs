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

// Every pair of note events is reviewed, so a song-length project decides
// whether the phone workflow is usable at all: the local Worker analysis is
// bounded by a timeout, and losing it discards the imported sources. Six
// overlapping roles at song length also keep the same-source and interval
// rejection paths on the hot path rather than short-circuiting immediately.
test('a song-length six-role project is reviewed pair-by-pair without losing conflicts or stalling the local Worker', () => {
  const ROLES = ['Melody', 'Chord1', 'Chord2', 'Chord3', 'Chord4', 'Chord5'];
  const [official, thirdparty] = sources();
  const events = [];
  for (let bar = 0; bar < 1000; bar++) {
    for (let role = 0; role < ROLES.length; role++) {
      // Sustained, heavily overlapping roles, and same-source neighbours at the
      // reviewed distances (0/1/11/13) that must never become cross-source conflicts.
      events.push(note(`official:${bar}:${role}`, 'official', ROLES[role], 48 + role * 11, String(bar), String(bar + 3)));
    }
  }
  const planted = [
    ['Chord1', 'Chord4', 60, 60, 'cross-source-same-pitch', 'P1'],
    ['Melody', 'Chord3', 72, 73, 'cross-source-dissonance', 'm2'],
    ['Chord2', 'Chord5', 55, 66, 'cross-source-dissonance', 'M7'],
    ['Chord2', 'Chord3', 50, 63, 'cross-source-dissonance', 'm9'],
  ];
  planted.forEach(([leftRole, rightRole, leftPitch, rightPitch], index) => {
    // Past the sustained material, so the expected conflict set is exactly the
    // planted pairs and not incidental neighbours of the background roles.
    const at = 2000 + index * 10;
    events.push(note(`official:planted:${index}`, 'official', leftRole, leftPitch, String(at), String(at + 2)));
    events.push(note(`thirdparty:planted:${index}`, 'thirdparty', rightRole, rightPitch, String(at), String(at + 2)));
  });
  const project = createCanonicalProject({
    id: 'song-length', title: 'Song length', sources: [official, thirdparty], events,
  });

  const started = process.hrtime.bigint();
  const report = analyzeCrossSourceHarmony(project);
  const elapsedMs = Number(process.hrtime.bigint() - started) / 1e6;

  assert.equal(project.events.length, 6008);
  assert.equal(report.conflictCount, planted.length, 'only genuine cross-source pairs are reported');
  assert.deepEqual(
    report.conflicts.map(conflict => [conflict.kind, conflict.intervalName]),
    planted.map(([, , , , kind, intervalName]) => [kind, intervalName]),
  );
  assert.deepEqual(
    report.conflicts.map(conflict => [conflict.leftEventId, conflict.rightEventId]),
    planted.map((_, index) => [`official:planted:${index}`, `thirdparty:planted:${index}`]),
  );
  assert.equal(report.unresolvedCount, planted.length);
  assert.ok(elapsedMs < 5000, `cross-source review of a song-length project took ${elapsedMs.toFixed(0)}ms`);
});
