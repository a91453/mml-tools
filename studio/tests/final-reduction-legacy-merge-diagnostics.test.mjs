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

// The lane diagnostics feed a cached, stored suggestion, so their exact output
// is pinned here: counts, continuity distances and the role ranking.
test('the full per-role diagnostic output is pinned exactly', () => {
  const source = [
    note('overflow-b', null, 70, '2', '3'),
    note('overflow-a', null, 64, '1/2', '1'),
    note('overflow-c', null, 60, '6', '8'),
  ];
  const candidate = [
    ...source,
    note('c4-early', 'Chord4', 69, '0', '1/2'),
    note('c4-high', 'Chord4', 80, '1', '2'),
    note('c4-low', 'Chord4', 65, '1', '2'),
    note('c4-short', 'Chord4', 90, '3', '4'),
    note('c4-long', 'Chord4', 71, '3', '5'),
    // Two touching same-pitch spans (given out of order) cover overflow-c.
    note('c3-cover-2', 'Chord3', 60, '7', '8'),
    note('c3-cover-1', 'Chord3', 60, '6', '7'),
    note('c3-hit', 'Chord3', 62, '3/4', '5/4'),
    // A covering unison plus a different-pitch overlap on overflow-b.
    note('c5-cover', 'Chord5', 70, '1', '4'),
    note('c5-other', 'Chord5', 72, '5/2', '7/2'),
    // Equal starts and ends, different pitches.
    note('m-a', 'Melody', 76, '4', '6'),
    note('m-b', 'Melody', 74, '4', '6'),
    note('m-c', 'Melody', 74, '10', '12'),
  ];
  const report = analyzeLegacyMergeLane({ sourceEvents: source, candidateEvents: candidate, preferredRole: 'Chord3' });
  const entry = (role, core3, targetEventCount, losslessGapCount, unisonCoveredCount, wouldRequireTrimOrDropCount, continuityDistance) => ({
    role,
    core3,
    leadReviewRequired: role === 'Melody',
    preferredByRoleAnalysis: role === 'Chord3',
    candidateEventCount: 3,
    sourceEventCount: 3,
    targetEventCount,
    losslessGapCount,
    unisonCoveredCount,
    wouldRequireTrimOrDropCount,
    fullyLossless: losslessGapCount === 3,
    requiresReviewerDecision: unisonCoveredCount > 0 || wouldRequireTrimOrDropCount > 0,
    continuityDistance,
    authority: 'SUGGESTION_ONLY',
  });
  assert.deepEqual(JSON.parse(JSON.stringify(report.targets)), [
    entry('Chord4', false, 5, 3, 0, 0, 1),
    entry('Melody', true, 3, 3, 0, 0, 4),
    entry('Chord1', true, 0, 3, 0, 0, null),
    entry('Chord2', true, 0, 3, 0, 0, null),
    entry('Chord5', false, 2, 2, 1, 1, 6),
    entry('Chord3', false, 3, 1, 1, 1, 2),
  ]);
  assert.equal(report.candidateEventCount, 3);
  assert.equal(report.sourceEventCount, 3);
  assert.equal(report.sourceCount, 1);
  assert.equal(report.preferredRole, 'Chord3');
});

test('continuity neighbours follow the (start, end, pitch, id) order, not the nearest end or onset', () => {
  // Before 2: c4-low and c4-high both end at 2 and start at 1, so pitch breaks
  // the tie and c4-high (80) is the LAST such neighbour. After 3: c4-short and
  // c4-long both start at 3, so the earlier end makes c4-short (90) the FIRST.
  // |70-80| = 10 and |70-90| = 20: the distance is 10. Choosing c4-low (5) or
  // c4-long (1) instead would be a different, wrong, diagnostic.
  const source = [note('overflow', null, 70, '2', '3')];
  const candidate = [
    ...source,
    note('c4-early', 'Chord4', 69, '0', '1/2'),
    note('c4-high', 'Chord4', 80, '1', '2'),
    note('c4-low', 'Chord4', 65, '1', '2'),
    note('c4-long', 'Chord4', 71, '3', '5'),
    note('c4-short', 'Chord4', 90, '3', '4'),
  ];
  const report = analyzeLegacyMergeLane({ sourceEvents: source, candidateEvents: candidate, roles: ['Chord4'] });
  assert.equal(target(report, 'Chord4').continuityDistance, 10);
  assert.equal(target(report, 'Chord4').fullyLossless, true);
});
