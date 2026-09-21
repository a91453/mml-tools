import test from 'node:test';
import assert from 'node:assert/strict';
import {
  analyzeLegacyMergeLane,
  LEGACY_MERGE_DIAGNOSTIC_SCHEMA,
  LEGACY_MERGE_DIAGNOSTIC_STATUS,
} from '../backend/arrangement/merge-diagnostics.mjs';

const note = (id, role, pitch, start, end, extra = {}) => ({
  kind: 'note',
  id,
  role,
  pitch,
  start,
  end,
  sourceIds: extra.sourceIds ?? ['fixture-source'],
  sourceEventIds: extra.sourceEventIds ?? [`raw:${id}`],
});
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

test('adjacent same-pitch targets jointly cover one source interval', () => {
  const source = [note('overflow-1', null, 60, '0', '2')];
  const candidate = [
    ...source,
    note('cover-a', 'Chord4', 60, '0', '1'),
    note('cover-b', 'Chord4', 60, '1', '2'),
  ];
  const report = analyzeLegacyMergeLane({ sourceEvents: source, candidateEvents: candidate });
  const chord4 = target(report, 'Chord4');
  assert.equal(chord4.unisonCoveredCount, 1);
  assert.equal(chord4.wouldRequireTrimOrDropCount, 0);
  assert.equal(chord4.eventDiagnostics, undefined, 'per-event collision detail is never persisted in the lane diagnostic');
});

test('a gap inside adjacent-looking same-pitch targets is not full coverage', () => {
  const source = [note('overflow-1', null, 60, '0', '2')];
  const candidate = [
    ...source,
    note('cover-a', 'Chord4', 60, '0', '3/4'),
    note('cover-b', 'Chord4', 60, '1', '2'),
  ];
  const report = analyzeLegacyMergeLane({ sourceEvents: source, candidateEvents: candidate });
  const chord4 = target(report, 'Chord4');
  assert.equal(chord4.unisonCoveredCount, 0);
  assert.equal(chord4.wouldRequireTrimOrDropCount, 1);
  assert.equal(chord4.eventDiagnostics, undefined);
});

test('a covering unison does not hide a simultaneous different-pitch collision', () => {
  const source = [note('overflow-1', null, 60, '1', '2')];
  const candidate = [
    ...source,
    note('cover', 'Chord4', 60, '0', '3'),
    note('other-pitch', 'Chord4', 64, '3/2', '5/2'),
  ];
  const report = analyzeLegacyMergeLane({ sourceEvents: source, candidateEvents: candidate });
  const chord4 = target(report, 'Chord4');
  assert.equal(chord4.unisonCoveredCount, 1);
  assert.equal(chord4.wouldRequireTrimOrDropCount, 1);
  assert.equal(chord4.requiresReviewerDecision, true);
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

test('lane diagnostics separate candidate counts from source-qualified raw provenance without persisting ids', () => {
  const source = [
    note('candidate-a', null, 67, '0', '1', {
      sourceIds: ['asset:a'],
      sourceEventIds: ['track:0/event:1'],
    }),
    note('candidate-b', null, 69, '1', '2', {
      sourceIds: ['asset:b'],
      sourceEventIds: ['track:0/event:1'],
    }),
  ];
  const report = analyzeLegacyMergeLane({ sourceEvents: source, candidateEvents: source });
  assert.equal(report.candidateEventCount, 2);
  assert.equal(report.sourceEventCount, 2,
    'the same source-local raw id from two imported assets is two provenance identities');
  assert.equal(report.sourceCount, 2);
  assert.ok(report.targets.every(entry => entry.sourceEventCount === 2));
  assert.equal(report.candidateEventIds, undefined);
  assert.equal(report.sourceEventIds, undefined);
  assert.ok(report.targets.every(entry => entry.eventDiagnostics === undefined));
  assert.ok(!JSON.stringify(report).includes('collisionEventIds'));
  assert.ok(!JSON.stringify(report).includes('coveringEventIds'));
});

test('source-event counts are source-set-qualified without inventing array-index pairs', () => {
  const raw = 'track:0/event:1';
  const source = [
    note('candidate-a', null, 60, '0', '1', { sourceIds: ['asset:a'], sourceEventIds: [raw] }),
    note('candidate-b', null, 62, '1', '2', { sourceIds: ['asset:b'], sourceEventIds: [raw] }),
    note('candidate-ab-1', null, 64, '2', '3', { sourceIds: ['asset:a', 'asset:b'], sourceEventIds: [raw] }),
    // Same ambiguous source set in the opposite array order is the same
    // set-scoped provenance identity, not a fourth source event.
    note('candidate-ab-2', null, 65, '3', '4', { sourceIds: ['asset:b', 'asset:a'], sourceEventIds: [raw] }),
  ];
  const report = analyzeLegacyMergeLane({ sourceEvents: source, candidateEvents: source });
  assert.equal(report.candidateEventCount, 4);
  assert.equal(report.sourceCount, 2);
  assert.equal(report.sourceEventCount, 3,
    'the same source-local raw id from A, B, and the ambiguous {A,B} source set must not collapse together');
});

test('dense collisions stay compact instead of serializing event-by-event cross products', () => {
  const source = Array.from({ length: 64 }, (_, index) =>
    note(`source-${index}`, null, 60 + (index % 4), '0', '4'));
  const targetEvents = Array.from({ length: 64 }, (_, index) =>
    note(`target-${index}`, 'Chord4', 72 + (index % 4), '0', '4'));
  const report = analyzeLegacyMergeLane({ sourceEvents: source, candidateEvents: [...source, ...targetEvents] });
  const chord4 = target(report, 'Chord4');
  assert.equal(chord4.candidateEventCount, 64);
  assert.equal(chord4.wouldRequireTrimOrDropCount, 64);
  assert.equal(chord4.eventDiagnostics, undefined);
  assert.ok(JSON.stringify(report).length < 10000, 'serialized lane-level diagnostic stays bounded by roles, not collision pairs');
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
