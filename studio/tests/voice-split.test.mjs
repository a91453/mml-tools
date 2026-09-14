import test from 'node:test';
import assert from 'node:assert/strict';
import {
  splitCanonicalVoice,
  splitProjectSourceVoices,
  VOICE_SPLIT_STATUS,
} from '../backend/arrangement/index.mjs';
import { f } from '../backend/mml/index.mjs';

// Beats are compared by exact rational value, never by spelling: the module
// canonicalizes `30/3` to `10`, and that normalization must not read as drift.
const sameBeat = (a, b) => f(a).cmp(b) === 0;

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
const spansOf = (result, eventId) => result.lanes.flatMap((lane, index) => lane.notes
  .filter(item => item.eventId === eventId)
  .map(item => ({ laneIndex: index, start: item.start, end: item.end, fragment: item.fragment })));
const diagnostic = (result, code) => result.diagnostics.find(item => item.code === code);

// Every fixture must stay source-complete: same event set, same pitches, same
// spans, nothing invented. This is the Canonical Gate 2 obligation expressed as
// an executable check, and it runs on every fixture below.
function assertLossless(result, events) {
  assert.equal(result.complete, true, 'decomposition must report source-complete coverage');
  assert.equal(diagnostic(result, 'SOURCE_COVERAGE_MISMATCH'), undefined);
  const emitted = result.lanes.flatMap(lane => lane.notes);
  assert.deepEqual(
    new Set(emitted.map(item => item.eventId)),
    new Set(events.map(event => event.id)),
    'every input event id must appear exactly in the output set',
  );
  for (const event of events) {
    const spans = emitted.filter(item => item.eventId === event.id);
    assert.ok(spans.length, `${event.id} must be represented`);
    for (const span of spans) {
      assert.equal(span.pitch, event.pitch, `${event.id} pitch must not change`);
      assert.ok(sameBeat(span.eventStart, event.start), `${event.id} original start must be retained`);
      assert.ok(sameBeat(span.eventEnd, event.end), `${event.id} original end must be retained`);
      assert.deepEqual([...span.sourceIds], [...event.sourceIds]);
      assert.deepEqual([...span.sourceEventIds], [...event.sourceEventIds]);
      assert.equal(span.sourceVoice, event.voice);
    }
  }
}

// The decomposition must be a pure function of the event set, not of the array
// order the caller happened to build. Guards against any hidden reliance on
// insertion order in a Map or on an unstable comparator.
function assertOrderIndependent(events, options) {
  const canonical = JSON.stringify(splitCanonicalVoice(events, options));
  const rotated = events.map((_, index) => events[(index + 1) % events.length]);
  const reversed = [...events].reverse();
  const shuffled = [...events].sort((a, b) => (a.id < b.id ? 1 : -1));
  for (const [label, variant] of [['rotated', rotated], ['reversed', reversed], ['id-desc', shuffled]]) {
    assert.equal(JSON.stringify(splitCanonicalVoice(variant, options)), canonical,
      `${label} input order must produce an identical decomposition`);
  }
}

// ─── checkpoint 1 behaviour, kept pinned ────────────────────────────────────

test('fixture: static triad -> three source-complete monophonic lanes', () => {
  const events = [
    note('c', 60, '0', '1'),
    note('e', 64, '0', '1'),
    note('g', 67, '0', '1'),
  ];
  const result = splitCanonicalVoice(events);
  assertLossless(result, events);
  assertOrderIndependent(events);
  assert.equal(result.maxPolyphony, 3);
  assert.deepEqual(laneIds(result), [['g'], ['e'], ['c']]);
});

test('fixture: adjacent replacements connect by minimum pitch distance', () => {
  const events = [
    note('c4', 60, '0', '1'),
    note('g4', 67, '0', '1'),
    note('d4', 62, '1', '2'),
    note('f4', 65, '1', '2'),
  ];
  const result = splitCanonicalVoice(events);
  assertLossless(result, events);
  assertOrderIndependent(events);
  assert.deepEqual(laneIds(result), [['g4', 'f4'], ['c4', 'd4']]);
});

test('mixed source voices are rejected unless the caller groups them first', () => {
  assert.throws(() => splitCanonicalVoice([
    note('a', 60, '0', '1', 'track:0/channel:0'),
    note('b', 64, '0', '1', 'track:1/channel:0'),
  ]), /one source voice/);
});

test('status record makes the checkpoint boundaries explicit', () => {
  assert.equal(VOICE_SPLIT_STATUS.sourceEventCoverage, 'lossless');
  assert.equal(VOICE_SPLIT_STATUS.exactCanonicalTiming, true);
  assert.equal(VOICE_SPLIT_STATUS.floatFreeOrdering, true);
  assert.equal(VOICE_SPLIT_STATUS.inputOrderIndependent, true);
  assert.equal(VOICE_SPLIT_STATUS.sustainedEventContinuityHardConstraint, true);
  assert.equal(VOICE_SPLIT_STATUS.silenceBreaksContinuityGraph, true);
  assert.equal(VOICE_SPLIT_STATUS.simultaneousUnisonMerge, false);
  assert.equal(VOICE_SPLIT_STATUS.overlappingSamePitchMerge, false);
  assert.equal(VOICE_SPLIT_STATUS.repeatedAttackTied, false);
  assert.equal(VOICE_SPLIT_STATUS.eventDeletion, false);
  assert.equal(VOICE_SPLIT_STATUS.laneCapReduction, false);
  assert.equal(VOICE_SPLIT_STATUS.roleAssignment, false);
  assert.equal(VOICE_SPLIT_STATUS.sixTrackReduction, false);
  assert.equal(VOICE_SPLIT_STATUS.referenceStatus, 'MML_MABI_REFERENCE_NOT_VERIFIED');
});

// ─── A. source-aware continuity ─────────────────────────────────────────────

test('fixture: moving top voice over a held bass keeps the bass in one lane and one span', () => {
  const events = [
    note('bass', 48, '0', '4'),
    note('top-1', 72, '0', '1'),
    note('top-2', 74, '1', '2'),
    note('top-3', 76, '2', '3'),
    note('top-4', 77, '3', '4'),
  ];
  const result = splitCanonicalVoice(events);
  assertLossless(result, events);
  assertOrderIndependent(events);
  assert.deepEqual(laneIds(result), [['top-1', 'top-2', 'top-3', 'top-4'], ['bass']]);
  assert.deepEqual(spansOf(result, 'bass'), [{ laneIndex: 1, start: '0', end: '4', fragment: false }]);
});

test('fixture: moving bass under a held top keeps the top in one lane and one span', () => {
  const events = [
    note('top', 79, '0', '3'),
    note('bass-1', 43, '0', '1'),
    note('bass-2', 45, '1', '2'),
    note('bass-3', 47, '2', '3'),
  ];
  const result = splitCanonicalVoice(events);
  assertLossless(result, events);
  assertOrderIndependent(events);
  assert.deepEqual(laneIds(result), [['top'], ['bass-1', 'bass-2', 'bass-3']]);
  assert.deepEqual(spansOf(result, 'top'), [{ laneIndex: 0, start: '0', end: '3', fragment: false }]);
});

test('fixture: an inner sustained tone is never stolen by a nearer moving neighbour', () => {
  // The moving outer voices repeatedly pass within a semitone of the held inner
  // tone. A pure pitch-distance matcher would hand the inner lane to whichever
  // neighbour is closest at the boundary; source-event identity outranks it.
  const events = [
    note('inner', 64, '0', '4'),
    note('low-1', 62, '0', '1'),
    note('low-2', 63, '1', '2'),
    note('low-3', 60, '2', '3'),
    note('low-4', 55, '3', '4'),
    note('high-1', 65, '0', '1'),
    note('high-2', 66, '1', '2'),
    note('high-3', 65, '2', '3'),
    note('high-4', 72, '3', '4'),
  ];
  const result = splitCanonicalVoice(events);
  assertLossless(result, events);
  assertOrderIndependent(events);
  assert.deepEqual(spansOf(result, 'inner'), [{ laneIndex: 1, start: '0', end: '4', fragment: false }]);
  assert.deepEqual(laneIds(result)[1], ['inner']);
  assert.equal(diagnostic(result, 'EVENT_REPRESENTED_AS_FRAGMENTS'), undefined);
});

test('fixture: a long tone sustained across chord changes stays one lane and one span', () => {
  const events = [
    note('pedal', 55, '0', '4'),
    note('c-1', 60, '0', '2'), note('e-1', 64, '0', '2'),
    note('d-1', 62, '2', '4'), note('f-1', 65, '2', '4'),
  ];
  const result = splitCanonicalVoice(events);
  assertLossless(result, events);
  assertOrderIndependent(events);
  assert.deepEqual(spansOf(result, 'pedal'), [{ laneIndex: 2, start: '0', end: '4', fragment: false }]);
});

// ─── B. deterministic adjacent-segment matching ─────────────────────────────

test('fixture: contrary motion resolves deterministically and losslessly', () => {
  const events = [
    note('up-1', 60, '0', '1'), note('up-2', 62, '1', '2'), note('up-3', 64, '2', '3'),
    note('down-1', 72, '0', '1'), note('down-2', 70, '1', '2'), note('down-3', 67, '2', '3'),
  ];
  const result = splitCanonicalVoice(events);
  assertLossless(result, events);
  assertOrderIndependent(events);
  assert.deepEqual(laneIds(result), [
    ['down-1', 'down-2', 'down-3'],
    ['up-1', 'up-2', 'up-3'],
  ]);
});

test('fixture: crossing voices are matched by pitch proximity, and the choice is recorded', () => {
  // Reference difference. A contig matcher that only sees pitch cannot follow a
  // true voice crossing; it hands each lane to the nearest survivor. Canonical
  // allows that here because nothing is lost: the source events keep their own
  // ids, spans and provenance, so a later layer can still re-read the crossing.
  const events = [
    note('a-1', 60, '0', '1'), note('a-2', 67, '1', '2'),
    note('b-1', 67, '0', '1'), note('b-2', 60, '1', '2'),
  ];
  const result = splitCanonicalVoice(events);
  assertLossless(result, events);
  assertOrderIndependent(events);
  assert.deepEqual(laneIds(result), [['b-1', 'a-2'], ['a-1', 'b-2']]);
});

test('polyphony that grows and shrinks (3 -> 4 -> 2) stays source-complete', () => {
  const events = [
    note('s1-a', 72, '0', '1'), note('s1-b', 64, '0', '1'), note('s1-c', 48, '0', '1'),
    note('s2-a', 74, '1', '2'), note('s2-b', 67, '1', '2'), note('s2-c', 60, '1', '2'), note('s2-d', 50, '1', '2'),
    note('s3-a', 76, '2', '3'), note('s3-b', 52, '2', '3'),
  ];
  const result = splitCanonicalVoice(events);
  assertLossless(result, events);
  assertOrderIndependent(events);
  assert.equal(result.maxPolyphony, 4);
  assert.equal(result.lanes.length, 4);
  const emitted = result.lanes.flatMap(lane => lane.notes.length);
  assert.equal(emitted.reduce((a, b) => a + b, 0), events.length);
});

// ─── C. silence boundary ────────────────────────────────────────────────────

test('fixture: gap-separated phrases may share a lane but the junction records the silence', () => {
  const events = [
    note('first', 60, '0', '1'),
    note('second', 62, '2', '3'),
  ];
  const result = splitCanonicalVoice(events);
  assertLossless(result, events);
  assertOrderIndependent(events);
  assert.equal(result.lanes.length, 1, 'a physical lane may be reused after silence');
  assert.deepEqual(result.lanes[0].notes.map(item => [item.eventId, item.start, item.end]), [
    ['first', '0', '1'],
    ['second', '2', '3'],
  ]);
  assert.equal(result.lanes[0].segments.length, 2, 'the two phrases are separate continuity segments');
  assert.deepEqual(result.lanes[0].junctions, [{
    previousChainId: result.lanes[0].segments[0].chainId,
    nextChainId: result.lanes[0].segments[1].chainId,
    from: '1',
    to: '2',
    silence: true,
  }]);
  const diag = diagnostic(result, 'LANE_REUSED_ACROSS_SILENCE');
  assert.ok(diag, 'lane reuse across real silence must be reported');
  assert.equal(diag.continuousVoiceAsserted, false);
});

test('a lane junction without silence is not reported as a silence break', () => {
  const events = [
    note('held', 60, '0', '2'),
    note('upper', 72, '0', '1'),
    note('lower', 48, '1', '2'),
  ];
  const result = splitCanonicalVoice(events);
  assertLossless(result, events);
  assert.equal(diagnostic(result, 'LANE_REUSED_ACROSS_SILENCE'), undefined);
  for (const lane of result.lanes) {
    for (const junction of lane.junctions) assert.equal(junction.silence, false);
  }
});

// ─── D. exact timing ────────────────────────────────────────────────────────

test('fixture: exact triplet timing stays exact and the input is never mutated', () => {
  const events = [
    note('triplet-a', 72, '0', '1/3', 'track:2/channel:1', ['track:2/event:4', 'track:2/event:5']),
    note('triplet-b', 74, '1/3', '2/3', 'track:2/channel:1', ['track:2/event:6', 'track:2/event:7']),
    note('triplet-c', 71, '2/3', '1', 'track:2/channel:1', ['track:2/event:8', 'track:2/event:9']),
  ];
  const snapshot = JSON.stringify(events);
  const result = splitCanonicalVoice(events);
  assertLossless(result, events);
  assertOrderIndependent(events);
  assert.deepEqual(result.lanes[0].notes.map(item => [item.start, item.end]),
    [['0', '1/3'], ['1/3', '2/3'], ['2/3', '1']]);
  assert.deepEqual(result.lanes[0].notes[0].sourceEventIds, ['track:2/event:4', 'track:2/event:5']);
  assert.equal(JSON.stringify(events), snapshot, 'input events are not mutated');
});

test('a triplet boundary that a float would smear stays an exact overlap decision', () => {
  // 1/3 and 2/3 have no exact binary float representation. The held note ends
  // exactly where the next one starts, so it must be a continuity break, not an
  // overlap, and the two must not be tied into one sustain.
  const events = [
    note('held', 60, '0', '1/3'),
    note('next', 60, '1/3', '2/3'),
    note('over', 67, '0', '2/3'),
  ];
  const result = splitCanonicalVoice(events);
  assertLossless(result, events);
  assertOrderIndependent(events);
  assert.deepEqual(spansOf(result, 'over'), [{ laneIndex: 0, start: '0', end: '2/3', fragment: false }]);
  const repeats = diagnostic(result, 'ADJACENT_REPEATED_ATTACKS');
  assert.ok(repeats);
  assert.deepEqual(repeats.pairs, [{ pitch: 60, eventIds: ['held', 'next'], at: '1/3', tieForbidden: true }]);
  assert.equal(diagnostic(result, 'OVERLAPPING_SAME_PITCH_EVENTS'), undefined);
});

// ─── E. provenance ──────────────────────────────────────────────────────────

test('every emitted span carries original event identity beside its fragment span', () => {
  const events = [
    note('x', 60, '0', '2', 'track:3/channel:5', ['track:3/event:11', 'track:3/event:12']),
    note('y', 67, '1', '2', 'track:3/channel:5', ['track:3/event:13', 'track:3/event:14']),
  ];
  const result = splitCanonicalVoice(events);
  assertLossless(result, events);
  const all = result.lanes.flatMap(lane => lane.notes);
  for (const span of all) {
    assert.ok(typeof span.eventId === 'string' && span.eventId);
    assert.ok(typeof span.eventStart === 'string' && typeof span.eventEnd === 'string');
    assert.equal(typeof span.fragment, 'boolean');
    assert.equal(span.sourceVoice, 'track:3/channel:5');
    assert.equal(span.sourceRole, null);
    assert.ok(span.sourceEventIds.length === 2);
    assert.ok(span.chainId.startsWith('chain:'));
  }
});

// ─── F. unison / repeated attack adversarial behaviour ──────────────────────

test('fixture: duplicate simultaneous unisons are preserved, not collapsed', () => {
  const events = [
    note('u1', 60, '0', '1', 'track:0/channel:0', ['raw:on1', 'raw:off1']),
    note('u2', 60, '0', '1', 'track:0/channel:0', ['raw:on2', 'raw:off2']),
  ];
  const result = splitCanonicalVoice(events);
  assertLossless(result, events);
  assertOrderIndependent(events);
  assert.equal(result.maxPolyphony, 2, 'two source events are two sounding voices, not one');
  assert.equal(result.lanes.length, 2);
  const diag = diagnostic(result, 'SIMULTANEOUS_UNISONS_PRESERVED');
  assert.ok(diag);
  assert.equal(diag.merged, false);
  assert.deepEqual(diag.groups, [{ start: '0', pitch: 60, eventIds: ['u1', 'u2'] }]);
});

test('fixture: repeated unison attacks stay separate events and are flagged tie-forbidden', () => {
  const events = [
    note('hit-1', 60, '0', '1'),
    note('hit-2', 60, '1', '2'),
    note('hit-3', 60, '2', '3'),
  ];
  const result = splitCanonicalVoice(events);
  assertLossless(result, events);
  assertOrderIndependent(events);
  assert.equal(result.lanes.length, 1);
  assert.deepEqual(result.lanes[0].notes.map(item => [item.eventId, item.start, item.end]), [
    ['hit-1', '0', '1'],
    ['hit-2', '1', '2'],
    ['hit-3', '2', '3'],
  ]);
  const diag = diagnostic(result, 'ADJACENT_REPEATED_ATTACKS');
  assert.ok(diag);
  assert.equal(diag.tiedIntoSustain, false);
  assert.deepEqual(diag.pairs.map(pair => pair.eventIds), [['hit-1', 'hit-2'], ['hit-2', 'hit-3']]);
});

test('same pitch, different onset, overlapping in time stays two events and is flagged for review', () => {
  const events = [
    note('sustain', 60, '0', '2'),
    note('restrike', 60, '1', '3'),
  ];
  const result = splitCanonicalVoice(events);
  assertLossless(result, events);
  assertOrderIndependent(events);
  assert.equal(result.maxPolyphony, 2);
  assert.deepEqual(spansOf(result, 'sustain'), [{ laneIndex: 0, start: '0', end: '2', fragment: false }]);
  assert.deepEqual(spansOf(result, 'restrike'), [{ laneIndex: 1, start: '1', end: '3', fragment: false }]);
  const diag = diagnostic(result, 'OVERLAPPING_SAME_PITCH_EVENTS');
  assert.ok(diag, 'a same-pitch overlap is a Canonical review signal, not a deletion target');
  assert.equal(diag.merged, false);
  assert.deepEqual(diag.pairs, [{ pitch: 60, eventIds: ['restrike', 'sustain'], from: '1', to: '2' }]);
});

test('fixture: silence then restart does not resurrect the earlier source event', () => {
  const events = [
    note('phrase-a1', 67, '0', '1'), note('phrase-a2', 52, '0', '1'),
    note('phrase-b1', 67, '2', '3'), note('phrase-b2', 52, '2', '3'),
  ];
  const result = splitCanonicalVoice(events);
  assertLossless(result, events);
  assertOrderIndependent(events);
  assert.equal(result.lanes.length, 2);
  for (const lane of result.lanes) {
    assert.equal(lane.segments.length, 2);
    assert.deepEqual(lane.junctions.map(junction => junction.silence), [true]);
  }
  const diag = diagnostic(result, 'LANE_REUSED_ACROSS_SILENCE');
  assert.deepEqual(diag.lanes.map(entry => entry.laneIndex), [0, 1]);
});

test('same channel on different MIDI tracks stays two independent source voices', () => {
  const project = {
    events: [
      note('t0-a', 60, '0', '1', 'track:0/channel:3'),
      note('t0-b', 64, '0', '1', 'track:0/channel:3'),
      note('t1-a', 60, '0', '1', 'track:1/channel:3'),
    ],
  };
  const groups = splitProjectSourceVoices(project);
  assert.equal(groups.length, 2, 'a shared MIDI channel does not merge two source tracks');
  assert.deepEqual(groups.map(group => [group.sourceVoice, group.maxPolyphony]), [
    ['track:0/channel:3', 2],
    ['track:1/channel:3', 1],
  ]);
  // The same pitch on both tracks is not a unison inside either decomposition,
  // because G11-B never merges across source voices.
  for (const group of groups) assert.equal(diagnostic(group, 'SIMULTANEOUS_UNISONS_PRESERVED'), undefined);
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

// ─── polyphony above a lane target: reported, never reduced ─────────────────

test('fixture: polyphony above a lane target is reported without deleting anything', () => {
  const events = [
    note('v1', 84, '0', '1'),
    note('v2', 79, '0', '1'),
    note('v3', 76, '0', '1'),
    note('v4', 72, '0', '1'),
    note('v5', 67, '0', '1'),
    note('v6', 60, '0', '1'),
    note('v7', 48, '0', '1'),
  ];
  const result = splitCanonicalVoice(events, { laneTarget: 4 });
  assertLossless(result, events);
  assertOrderIndependent(events, { laneTarget: 4 });
  assert.equal(result.lanes.length, 7, 'the source-preserving layer applies no cap');
  const diag = diagnostic(result, 'LANE_COUNT_EXCEEDS_TARGET');
  assert.ok(diag);
  assert.deepEqual(
    { laneCount: diag.laneCount, laneTarget: diag.laneTarget, reductionApplied: diag.reductionApplied },
    { laneCount: 7, laneTarget: 4, reductionApplied: false },
  );
});

test('no lane target means no lane-count diagnostic at all', () => {
  const events = [note('a', 60, '0', '1'), note('b', 64, '0', '1')];
  const result = splitCanonicalVoice(events);
  assert.equal(result.laneTarget, null);
  assert.equal(diagnostic(result, 'LANE_COUNT_EXCEEDS_TARGET'), undefined);
  assert.throws(() => splitCanonicalVoice(events, { laneTarget: 0 }), /positive integer/);
});

test('an empty source voice decomposes to an empty, complete result', () => {
  const result = splitCanonicalVoice([]);
  assert.equal(result.complete, true);
  assert.equal(result.maxPolyphony, 0);
  assert.deepEqual(result.lanes, []);
  assert.deepEqual(result.diagnostics, []);
});

// ─── randomized adversarial property check ──────────────────────────────────

// A seeded generator so the case set is wide but the run is reproducible. Dense
// overlaps, repeated unisons, exact thirds and long pedal tones all appear.
function generatedEvents(seed, count) {
  let state = seed;
  const rnd = (n) => {
    state = (state * 1103515245 + 12345) % 2147483648;
    return state % n;
  };
  const events = [];
  for (let i = 0; i < count; i++) {
    const startThirds = rnd(120);
    const lengthThirds = 1 + rnd(9);
    const start = `${startThirds}/3`;
    const end = `${startThirds + lengthThirds}/3`;
    events.push(note(`g${i}`, 48 + rnd(24), start, end, 'track:9/channel:1', [`raw:g${i}`]));
  }
  return events;
}

test('randomized dense polyphony stays lossless, exact and order-independent', () => {
  for (const seed of [1, 7, 4242, 99991]) {
    const events = generatedEvents(seed, 240);
    const result = splitCanonicalVoice(events, { laneTarget: 6 });
    assertLossless(result, events);
    assertOrderIndependent(events, { laneTarget: 6 });
    // Exactness: no emitted boundary may lose the thirds denominator.
    for (const lane of result.lanes) {
      for (const span of lane.notes) {
        assert.ok(/^-?\d+(\/\d+)?$/.test(span.start), `${span.start} must stay an exact rational`);
        assert.ok(/^-?\d+(\/\d+)?$/.test(span.end), `${span.end} must stay an exact rational`);
      }
    }
    // Lane count never exceeds the observed maximum simultaneous polyphony.
    assert.ok(result.lanes.length <= result.maxPolyphony);
    // No lane may ever sound two spans at once: that is what "monophonic" means.
    for (const lane of result.lanes) {
      const ordered = [...lane.notes];
      for (let i = 0; i + 1 < ordered.length; i++) {
        assert.ok(f(ordered[i].end).cmp(ordered[i + 1].start) <= 0,
          `lane ${lane.index} must not overlap itself`);
      }
    }
  }
});
