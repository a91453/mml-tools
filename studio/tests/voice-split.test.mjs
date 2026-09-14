import test from 'node:test';
import assert from 'node:assert/strict';
import {
  splitCanonicalVoice,
  splitProjectSourceVoices,
  VOICE_SPLIT_STATUS,
} from '../backend/arrangement/index.mjs';

const note = (id, pitch, start, end, voice = 'track:0/channel:0', sourceEventIds = [`raw:${id}`]) => Object.freeze({
  kind: 'note',
  id,
  pitch,
  start,
  end,
  sourceIds: Object.freeze(['fixture']),
  sourceEventIds: Object.freeze(sourceEventIds),
  role: null,
  voice,
  volume: null,
  tags: Object.freeze(['source-faithful']),
  metadata: Object.freeze({}),
});

const laneIds = result => result.lanes.map(lane => lane.notes.map(item => item.eventId));

test('a sustained triad decomposes into three source-complete monophonic lanes', () => {
  const result = splitCanonicalVoice([
    note('c', 60, '0', '1'),
    note('e', 64, '0', '1'),
    note('g', 67, '0', '1'),
  ]);
  assert.equal(result.complete, true);
  assert.equal(result.maxPolyphony, 3);
  assert.deepEqual(laneIds(result), [['g'], ['e'], ['c']]);
  assert.deepEqual(new Set(result.outputEventIds), new Set(['c', 'e', 'g']));
});

test('adjacent replacements connect by minimum pitch distance', () => {
  const result = splitCanonicalVoice([
    note('c4', 60, '0', '1'),
    note('g4', 67, '0', '1'),
    note('d4', 62, '1', '2'),
    note('f4', 65, '1', '2'),
  ]);
  assert.deepEqual(laneIds(result), [['g4', 'f4'], ['c4', 'd4']]);
});

test('a still-sounding source event is a hard continuity constraint', () => {
  const result = splitCanonicalVoice([
    note('held-c', 60, '0', '2'),
    note('g', 67, '0', '1'),
    note('a', 69, '1', '2'),
  ]);
  const laneWithHeld = result.lanes.find(lane => lane.notes.some(item => item.eventId === 'held-c'));
  assert.ok(laneWithHeld);
  const held = laneWithHeld.notes.filter(item => item.eventId === 'held-c');
  assert.equal(held.length, 1, 'slice fragments are coalesced back to the original source span');
  assert.deepEqual([held[0].start, held[0].end], ['0', '2']);
  const other = result.lanes.find(lane => lane !== laneWithHeld);
  assert.deepEqual(other.notes.map(item => item.eventId), ['g', 'a']);
});

test('silence breaks continuity without inventing filler or extending duration', () => {
  const result = splitCanonicalVoice([
    note('first', 60, '0', '1'),
    note('second', 62, '2', '3'),
  ]);
  assert.equal(result.lanes.length, 1, 'a physical lane may be reused after silence');
  assert.deepEqual(result.lanes[0].notes.map(item => [item.eventId, item.start, item.end]), [
    ['first', '0', '1'],
    ['second', '2', '3'],
  ]);
});

test('simultaneous same-pitch source events are preserved rather than silently merged', () => {
  const result = splitCanonicalVoice([
    note('u1', 60, '0', '1', 'track:0/channel:0', ['raw:on1', 'raw:off1']),
    note('u2', 60, '0', '1', 'track:0/channel:0', ['raw:on2', 'raw:off2']),
  ]);
  assert.equal(result.complete, true);
  assert.equal(result.maxPolyphony, 2);
  assert.equal(result.lanes.length, 2);
  assert.deepEqual(new Set(result.outputEventIds), new Set(['u1', 'u2']));
  const diag = result.diagnostics.find(item => item.code === 'SIMULTANEOUS_UNISONS_PRESERVED');
  assert.ok(diag);
  assert.deepEqual(new Set(diag.groups[0].eventIds), new Set(['u1', 'u2']));
});

test('exact rational boundaries remain exact and source event provenance is retained', () => {
  const original = [
    note('triplet-a', 72, '0', '1/3', 'track:2/channel:1', ['track:2/event:4', 'track:2/event:5']),
    note('triplet-b', 74, '1/3', '2/3', 'track:2/channel:1', ['track:2/event:6', 'track:2/event:7']),
  ];
  const snapshot = JSON.stringify(original);
  const result = splitCanonicalVoice(original);
  assert.deepEqual(result.lanes[0].notes.map(item => [item.start, item.end]), [['0', '1/3'], ['1/3', '2/3']]);
  assert.deepEqual(result.lanes[0].notes[0].sourceEventIds, ['track:2/event:4', 'track:2/event:5']);
  assert.equal(JSON.stringify(original), snapshot, 'input events are not mutated');
});

test('mixed source voices are rejected unless the caller groups them first', () => {
  assert.throws(() => splitCanonicalVoice([
    note('a', 60, '0', '1', 'track:0/channel:0'),
    note('b', 64, '0', '1', 'track:1/channel:0'),
  ]), /one source voice/);
});

test('project helper decomposes each source voice independently', () => {
  const project = {
    events: [
      note('a', 60, '0', '1', 'track:0/channel:0'),
      note('b', 64, '0', '1', 'track:0/channel:0'),
      note('c', 48, '0', '2', 'track:1/channel:2'),
    ],
  };
  const groups = splitProjectSourceVoices(project);
  assert.equal(groups.length, 2);
  assert.deepEqual(groups.map(group => [group.sourceVoice, group.maxPolyphony]), [
    ['track:0/channel:0', 2],
    ['track:1/channel:2', 1],
  ]);
});

test('status record makes the first checkpoint boundaries explicit', () => {
  assert.equal(VOICE_SPLIT_STATUS.sourceEventCoverage, 'lossless');
  assert.equal(VOICE_SPLIT_STATUS.simultaneousUnisonMerge, false);
  assert.equal(VOICE_SPLIT_STATUS.eventDeletion, false);
  assert.equal(VOICE_SPLIT_STATUS.roleAssignment, false);
  assert.equal(VOICE_SPLIT_STATUS.sixTrackReduction, false);
});
