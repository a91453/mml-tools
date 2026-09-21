import test from 'node:test';
import assert from 'node:assert/strict';
import {
  analyzeLegacyMergeLane,
  LEGACY_MERGE_DIAGNOSTIC_SCHEMA,
  LEGACY_MERGE_DIAGNOSTIC_STATUS,
} from '../backend/reduction/legacy-merge-diagnostics.mjs';

const note = (id, role, pitch, start, end) => ({ kind: 'note', id, role, pitch, start, end });
const target = (report, role) => report.targets.find(entry => entry.role === role);

test('legacy merge diagnostics keep an exact gap as a lossless reviewer candidate', () => {
  const source = [note('overflow-1', null, 67, '1', '2')];
  const candidate = [
    ...source,
    note('c3-a', 'Chord3', 60, '0', '1'),
    note('c3-b', 'Chord3', 62, '2', '3'),
    note('c4-hit', 'Chord4', 65, '3/2', '5/2'),
  ];
  const report = analyzeLegacyMergeLane({ sourceEvents: source, candidateEvents: candidate });
  assert.equal(report.schema, LEGACY_MERGE_DIAGNOSTIC_SCHEMA);
  assert.equal(report.authority, 'SUGGESTION_ONLY');
  assert.equal(report.mutatesCandidate, false);
  assert.equal(target(report, 'Chord3').fullyLossless, true);
  assert.equal(target(report, 'Chord3').wouldRequireTrimOrDropCount, 0);
  assert.equal(target(report, 'Chord4').fullyLossless, false);
  assert.equal(target(report, 'Chord4').wouldRequireTrimOrDropCount, 1);
});

test('same-pitch coverage is visible but never converted into automatic omission', () => {
  const source = [note('overflow-1', null, 60, '1', '2')];
  const candidate = [...source, note('cover', 'Chord4', 60, '0', '3')];
  const report = analyzeLegacyMergeLane({ sourceEvents: source, candidateEvents: candidate });
  const chord4 = target(report, 'Chord4');
  assert.equal(chord4.unisonCoveredCount, 1);
  assert.equal(chord4.wouldRequireTrimOrDropCount, 0);
  assert.equal(chord4.fullyLossless, false);
  assert.equal(chord4.requiresReviewerDecision, true);
  assert.equal(report.permitsAutomaticOmission, false);
});

test('exact rational overlap is detected without float epsilon', () => {
  const source = [note('overflow-1', null, 64, '1/3', '2/3')];
  const candidate = [
    ...source,
    note('touch-before', 'Chord3', 55, '0', '1/3'),
    note('overlap', 'Chord4', 55, '1/2', '3/4'),
  ];
  const report = analyzeLegacyMergeLane({ sourceEvents: source, candidateEvents: candidate });
  assert.equal(target(report, 'Chord3').fullyLossless, true, 'touching at the boundary is not overlap');
  assert.equal(target(report, 'Chord4').wouldRequireTrimOrDropCount, 1, '1/2..2/3 overlaps exactly');
});

test('a preferred role hypothesis only breaks ties and remains suggestion-only', () => {
  const source = [note('overflow-1', null, 72, '4', '5')];
  const candidate = [...source];
  const report = analyzeLegacyMergeLane({
    sourceEvents: source,
    candidateEvents: candidate,
    preferredRole: 'Chord2',
  });
  assert.equal(report.targets[0].role, 'Chord2');
  assert.equal(report.targets[0].preferredByRoleAnalysis, true);
  assert.ok(report.targets.every(entry => entry.authority === 'SUGGESTION_ONLY'));
  assert.deepEqual(report.certifiesGates, []);
});

test('diagnostics never mutate source or candidate arrays', () => {
  const source = [note('overflow-1', null, 67, '0', '1')];
  const candidate = [...source, note('target', 'Chord5', 60, '2', '3')];
  const beforeSource = structuredClone(source);
  const beforeCandidate = structuredClone(candidate);
  analyzeLegacyMergeLane({ sourceEvents: source, candidateEvents: candidate });
  assert.deepEqual(source, beforeSource);
  assert.deepEqual(candidate, beforeCandidate);
  assert.equal(LEGACY_MERGE_DIAGNOSTIC_STATUS.automaticOmission, false);
  assert.equal(LEGACY_MERGE_DIAGNOSTIC_STATUS.automaticTruncation, false);
});
