// Canonical-aware Final MML emitter regressions.
//
// These exercise the production entry point `emitFinalMml`, not helpers. The
// published rules they serve are MOBILE_SYNTAX §3/§4/§5/§6/§7/§8/§9/§10/§11,
// MASTER_RULES §7, and ACCEPTANCE_CRITERIA Gate 1.
//
// The failure modes they exist to make impossible are all the same shape: output
// that looks fine and quietly is not the candidate's music — a merged attack, an
// absorbed rest, a moved tempo, a rounded duration, a deleted note that made the
// character budget fit.
import test from 'node:test';
import assert from 'node:assert/strict';
import { F, f, ROLES } from '../backend/mml/index.mjs';
import { splitMML, parseTrack } from '../backend/mml/parser.mjs';
import { EFFECTIVE_RULESET } from '../backend/rules/index.mjs';
import { SAFE_GRID, INTERVAL_TYPES, MICRO_TIMING_KEEP_ACTION, MICRO_TIMING_TECHNICAL_ACTIONS, createIntervalIdentity } from '../backend/canonical/micro-timing.mjs';
import {
  createSource,
  createCanonicalNoteEvent,
  createCanonicalRestEvent,
  createCanonicalTempoEvent,
  createCanonicalProject,
  createArbitrationDecision,
} from '../backend/canonical/index.mjs';
import { emitFinalMml } from '../backend/final/mml-emitter.mjs';
import { verifyFinalReadback, projectFromFinalReadback } from '../backend/final/round-trip.mjs';
import { EMIT_DIAGNOSTICS } from '../backend/final/emitter-contract.mjs';

const OFFICIAL = createSource({ id: 'official', label: 'Official MusicXML', kind: 'official-musicxml', authority: 'primary-symbolic' });

let counter = 0;
const nextId = prefix => `${prefix}-${++counter}`;

const note = ({ id = nextId('n'), pitch = 60, start, end, role = 'Melody', volume = null }) => createCanonicalNoteEvent({
  id, pitch, start: String(start), end: String(end), role, voice: role, volume, sourceIds: ['official'],
});
const rest = ({ id = nextId('r'), start, end, role = 'Melody' }) => createCanonicalRestEvent({
  id, start: String(start), end: String(end), role, voice: role, sourceIds: ['official'],
});
const tempo = (beat, bpm, id = nextId('t')) => createCanonicalTempoEvent({
  id, beat: String(beat), bpm, sourceIds: ['official'],
});

function project({ events, tempoEvents = [tempo(0, 120)], decisions = [], metadata = {} }) {
  return createCanonicalProject({
    id: nextId('project'), title: 'emitter fixture', sources: [OFFICIAL], events, tempoEvents, decisions, metadata,
  });
}

const emit = (events, options = {}, extra = {}) => emitFinalMml(project({ events, ...extra }), options);
const melody = result => result.roles.find(entry => entry.role === 'Melody');
const codes = result => result.diagnostics.map(item => item.code);
const readTrack = (result, role = 'Melody') => parseTrack(
  splitMML(result.combinedMml)[ROLES.indexOf(role)], role, { mode: 'final', allowCautionLengths: true },
);

// ── 1–2. the simplest exact cases ──────────────────────────────────────────

test('a single exact note emits and reads back exactly', () => {
  const result = emit([note({ start: 0, end: 1 })]);
  assert.equal(result.status, 'PASS');
  assert.equal(melody(result).mml, 't120o4c');
  const track = readTrack(result);
  assert.deepEqual(track.events, [{ pitch: 60, start: '0', end: '1', volume: 8 }]);
});

test('an exact rest is written and preserved', () => {
  // The octave token is emitted where it is first needed, so it follows the
  // leading rest rather than preceding it.
  const result = emit([rest({ start: 0, end: 1 }), note({ start: 1, end: 2 })]);
  assert.equal(result.status, 'PASS');
  assert.equal(melody(result).mml, 't120ro4c');
  const track = readTrack(result);
  assert.equal(track.events[0].start, '1');
  assert.equal(track.total, '2');
});

// ── 3–6. duration decomposition and attack identity ────────────────────────

test('a tied duration decomposition still reads back as ONE attack', () => {
  // 5 beats needs more than one token. The emitted tie chain must collapse back
  // into a single note-on, not become two.
  const result = emit([note({ start: 0, end: 5 })]);
  assert.equal(result.status, 'PASS');
  assert.ok(melody(result).mml.includes('&'), 'expected a tie chain');
  const track = readTrack(result);
  assert.equal(track.events.length, 1, 'one attack');
  assert.equal(track.events[0].start, '0');
  assert.equal(track.events[0].end, '5');
});

test('adjacent same-pitch notes stay two distinct attacks', () => {
  // MOBILE_SYNTAX §8: `&` may not hide a repeated attack. Same pitch, touching
  // in time — the cheapest wrong answer is one tied note.
  const result = emit([note({ start: 0, end: 1 }), note({ start: 1, end: 2 })]);
  assert.equal(result.status, 'PASS');
  const track = readTrack(result);
  assert.equal(track.events.length, 2);
  assert.deepEqual(track.events.map(event => [event.start, event.end]), [['0', '1'], ['1', '2']]);
  assert.equal(melody(result).mml.includes('&'), false, 'two attacks must not be tied');
});

test('a non-trivial exact rational duration survives exactly', () => {
  const result = emit([note({ start: 0, end: '7/8' })]);
  assert.equal(result.status, 'PASS');
  const track = readTrack(result);
  assert.equal(f(track.events[0].end).cmp(new F(7, 8)), 0);
});

test('a multi-token duration sums to the exact original', () => {
  const result = emit([note({ start: 0, end: '13/16' })]);
  assert.equal(result.status, 'PASS');
  const track = readTrack(result);
  assert.equal(track.events.length, 1);
  assert.equal(f(track.events[0].end).sub(track.events[0].start).cmp(new F(13, 16)), 0);
});

// ── 7–8. fail closed, exactly ──────────────────────────────────────────────

test('an unrepresentable exact duration fails closed with no output', () => {
  const result = emit([note({ start: 0, end: '1/3' })]);
  assert.equal(result.status, 'FAIL');
  assert.equal(result.combinedMml, null);
  assert.ok(codes(result).includes(EMIT_DIAGNOSTICS.DURATION_NOT_REPRESENTABLE));
});

test('a duration one part in 10^20 off a token is not rounded to it', () => {
  // The two durations below are the same double. Only exact rational arithmetic
  // separates them, so this fails the moment anything compares with Number.
  const exact = emit([note({ start: 0, end: '1' })]);
  assert.equal(exact.status, 'PASS');

  const offBy = f('1').add(new F(1, 10n ** 20n));
  assert.equal(offBy.num(), 1, 'the two values must be indistinguishable as doubles');
  const drifted = emit([note({ start: 0, end: offBy.toString() })]);
  assert.equal(drifted.status, 'FAIL');
  assert.equal(drifted.combinedMml, null);
  assert.ok(codes(drifted).includes(EMIT_DIAGNOSTICS.DURATION_NOT_REPRESENTABLE));
});

// ── 9–11. G10 consumption ──────────────────────────────────────────────────

const identityOf = event => createIntervalIdentity({
  type: INTERVAL_TYPES.EVENT_DURATION, eventId: event.id, start: event.start, end: event.end,
});

test('a source-supported sub-1/64 interval is never destroyed to make output', () => {
  // G10 says preserve. No Final token is shorter than the grid, so the only
  // honest answer is to refuse — never to lengthen, absorb or quantize it.
  const short = note({ start: 0, end: SAFE_GRID.sub(new F(1, 1000)).toString() });
  const identity = identityOf(short);
  const keep = createArbitrationDecision({
    id: nextId('keep'),
    eventIds: [short.id],
    action: MICRO_TIMING_KEEP_ACTION,
    status: 'accepted',
    reason: 'Notated staccato separation in the official score.',
    evidence: ['official MusicXML, measure 3'],
    metadata: { intervalIdentity: identity, evidenceSourceIds: ['official'] },
  });
  const result = emitFinalMml(project({ events: [short], decisions: [keep] }));
  assert.equal(result.status, 'FAIL');
  assert.equal(result.combinedMml, null);
  assert.ok(codes(result).includes(EMIT_DIAGNOSTICS.SOURCE_SUPPORTED_INTERVAL_NOT_REPRESENTABLE));
  assert.ok(result.microGap.preservedIntervalKeys.length > 0);
});

test('confirmed technical sub-1/64 residue never silently passes', () => {
  const short = note({ start: 0, end: SAFE_GRID.sub(new F(1, 1000)).toString() });
  const identity = identityOf(short);
  const technical = createArbitrationDecision({
    id: nextId('tech'),
    eventIds: [short.id],
    action: MICRO_TIMING_TECHNICAL_ACTIONS[0],
    status: 'accepted',
    reason: 'Tie-splitting residue with no source counterpart.',
    evidence: ['producer log: split residue at bar 3'],
    metadata: { intervalIdentity: identity },
  });
  const result = emitFinalMml(project({ events: [short], decisions: [technical] }));
  assert.equal(result.status, 'FAIL');
  assert.equal(result.combinedMml, null);
  assert.ok(codes(result).includes(EMIT_DIAGNOSTICS.MICRO_GAP_TECHNICAL_RESIDUE));
});

test('an unclassified micro-gap blocks Final output entirely', () => {
  const short = note({ start: 0, end: SAFE_GRID.sub(new F(1, 1000)).toString() });
  const result = emitFinalMml(project({ events: [short] }));
  assert.equal(result.status, 'PENDING');
  assert.equal(result.combinedMml, null);
  assert.ok(codes(result).includes(EMIT_DIAGNOSTICS.MICRO_GAP_BLOCKED_PENDING));
});

// ── 12–14. tempo ───────────────────────────────────────────────────────────

test('a tempo change on an event boundary lands on the exact beat', () => {
  const result = emit(
    [note({ start: 0, end: 1 }), note({ start: 1, end: 2 })],
    {},
    { tempoEvents: [tempo(0, 120), tempo(1, 150)] },
  );
  assert.equal(result.status, 'PASS');
  assert.deepEqual(readTrack(result).tempo, [{ beat: '0', bpm: 120 }, { beat: '1', bpm: 150 }]);
});

test('a tempo change inside a sustained note splits the representation, not the attack', () => {
  const result = emit(
    [note({ start: 0, end: 4 })],
    {},
    { tempoEvents: [tempo(0, 120), tempo(2, 150)] },
  );
  assert.equal(result.status, 'PASS');
  const track = readTrack(result);
  assert.equal(track.events.length, 1, 'still one attack');
  assert.equal(track.events[0].start, '0');
  assert.equal(track.events[0].end, '4');
  assert.deepEqual(track.tempo, [{ beat: '0', bpm: 120 }, { beat: '2', bpm: 150 }]);
});

test('tempo positions round-trip exactly on a non-integer beat', () => {
  const result = emit(
    [note({ start: 0, end: 2 })],
    {},
    { tempoEvents: [tempo(0, 120), tempo('3/4', 200)] },
  );
  assert.equal(result.status, 'PASS');
  const track = readTrack(result);
  assert.equal(f(track.tempo[1].beat).cmp(new F(3, 4)), 0);
  assert.equal(track.events.length, 1);
});

test('a tempo the candidate places past a non-empty role end fails closed, without padding', () => {
  const result = emit(
    [note({ start: 0, end: 1 })],
    {},
    { tempoEvents: [tempo(0, 120), tempo(8, 150)] },
  );
  assert.equal(result.status, 'FAIL');
  assert.ok(codes(result).includes(EMIT_DIAGNOSTICS.TEMPO_POSITION_BEYOND_ROLE_END));
});

test('a non-integer or out-of-range tempo is refused, never rounded or clamped', () => {
  const fractional = emit([note({ start: 0, end: 1 })], {}, { tempoEvents: [createCanonicalTempoEvent({ id: nextId('t'), beat: '0', bpm: 120.5, sourceIds: ['official'] })] });
  assert.equal(fractional.status, 'FAIL');
  assert.ok(codes(fractional).includes(EMIT_DIAGNOSTICS.TEMPO_NOT_INTEGER));

  const tooFast = emit([note({ start: 0, end: 1 })], {}, { tempoEvents: [tempo(0, 300)] });
  assert.equal(tooFast.status, 'FAIL');
  assert.ok(codes(tooFast).includes(EMIT_DIAGNOSTICS.TEMPO_OUT_OF_FINAL_RANGE));
});

test('a missing initial tempo is refused rather than invented', () => {
  const result = emit([note({ start: 0, end: 1 })], {}, { tempoEvents: [tempo(1, 120)] });
  assert.equal(result.status, 'FAIL');
  assert.ok(codes(result).includes(EMIT_DIAGNOSTICS.TEMPO_INITIAL_MISSING));
});

// ── 15–17. pitch, octave, volume ───────────────────────────────────────────

test('an octave boundary transition round-trips to the same pitches', () => {
  // B3 -> C4 -> B3 crosses the octave line twice.
  const result = emit([
    note({ pitch: 59, start: 0, end: 1 }),
    note({ pitch: 60, start: 1, end: 2 }),
    note({ pitch: 59, start: 2, end: 3 }),
  ]);
  assert.equal(result.status, 'PASS');
  assert.deepEqual(readTrack(result).events.map(event => event.pitch), [59, 60, 59]);
});

test('repeated octave motion is planned deterministically and stays exact', () => {
  const pitches = [60, 72, 60, 72, 59, 71, 59];
  const events = pitches.map((pitch, index) => note({ pitch, start: index, end: index + 1 }));
  const first = emit(events);
  const second = emit(events);
  assert.equal(first.status, 'PASS');
  assert.equal(melody(first).mml, melody(second).mml);
  assert.deepEqual(readTrack(first).events.map(event => event.pitch), pitches);
});

test('volume state is serialized only where the candidate decided it', () => {
  const result = emit([
    note({ start: 0, end: 1, volume: 12 }),
    note({ start: 1, end: 2, volume: 12 }),
    note({ start: 2, end: 3, volume: 5 }),
  ]);
  assert.equal(result.status, 'PASS');
  const mml = melody(result).mml;
  assert.equal((mml.match(/v/g) ?? []).length, 2, 'one V per change, not per note');
  assert.deepEqual(readTrack(result).events.map(event => event.volume), [12, 12, 5]);
});

test('an undecided volume is reported, not invented', () => {
  const result = emit([note({ start: 0, end: 1 })]);
  assert.ok(codes(result).includes(EMIT_DIAGNOSTICS.VOLUME_NOT_DECIDED));
  assert.equal(melody(result).mml.includes('v'), false);
});

test('a role with some decided and some undecided volume fails closed', () => {
  const result = emit([
    note({ start: 0, end: 1, volume: 12 }),
    note({ start: 1, end: 2 }),
  ]);
  assert.equal(result.status, 'FAIL');
  assert.ok(codes(result).includes(EMIT_DIAGNOSTICS.EVENT_VOLUME_MIXED_DECISION));
});

test('a pitch above the official range fails closed instead of being re-spelled', () => {
  const max = EFFECTIVE_RULESET.mobileSyntax.numericNoteMax;
  const result = emit([note({ pitch: max + 5, start: 0, end: 1 })]);
  assert.equal(result.status, 'FAIL');
  assert.ok(codes(result).includes(EMIT_DIAGNOSTICS.PITCH_ABOVE_OFFICIAL_RANGE));
});

// ── 18–19. rests ───────────────────────────────────────────────────────────

test('a meaningful rest between two notes is preserved, not absorbed', () => {
  // The cheapest wrong answer is to lengthen the first note over the rest.
  const result = emit([
    note({ start: 0, end: 1 }),
    rest({ start: 1, end: 2 }),
    note({ start: 2, end: 3 }),
  ]);
  assert.equal(result.status, 'PASS');
  const track = readTrack(result);
  assert.deepEqual(track.events.map(event => [event.start, event.end]), [['0', '1'], ['2', '3']]);
  assert.equal(track.total, '3');
});

test('distinct same-pitch attacks around a rest stay distinct', () => {
  const result = emit([
    note({ pitch: 64, start: 0, end: 1 }),
    rest({ start: 1, end: '5/4' }),
    note({ pitch: 64, start: '5/4', end: 2 }),
  ]);
  assert.equal(result.status, 'PASS');
  const track = readTrack(result);
  assert.equal(track.events.length, 2);
  assert.equal(f(track.events[1].start).cmp(new F(5, 4)), 0);
});

// ── 20–21. character budget ────────────────────────────────────────────────

// `t120o4` then one `c` per beat: every note costs exactly one character, so
// the budget boundary can be hit on the nose rather than approached.
const oneCharPerNote = count => Array.from({ length: count }, (unused, index) => note({ start: index, end: index + 1 }));
const LIMIT = EFFECTIVE_RULESET.mobileSyntax.perTrackCharacterLimit;

test('a role landing exactly on the character limit still passes', () => {
  const result = emit(oneCharPerNote(LIMIT - 't120o4'.length));
  assert.equal(result.status, 'PASS');
  assert.equal(melody(result).characters, LIMIT);
});

test('a role one character over the limit fails, and deletes no music', () => {
  const count = LIMIT - 't120o4'.length + 1;
  const result = emit(oneCharPerNote(count));
  assert.equal(result.status, 'FAIL');
  assert.equal(result.combinedMml, null);
  const budget = result.diagnostics.find(item => item.code === EMIT_DIAGNOSTICS.CHARACTER_BUDGET_EXCEEDED);
  assert.ok(budget);
  assert.equal(budget.overBy, 1);
  assert.equal(budget.unit, 'javascript-string-length');
  // The whole point: every attack is still there in the report.
  assert.equal(melody(result).attacks, count);
});

test('the character count is labelled as a string length, never as client truth', () => {
  const result = emit([note({ start: 0, end: 1 })]);
  assert.equal(result.characterCounts.unit, 'javascript-string-length');
  assert.equal(result.characterCounts.clientEquivalenceVerified, false, 'PENDING P1 stays open');
});

// ── 22–24. six-role delivery ───────────────────────────────────────────────

test('all six roles serialize into one combined MML@ string', () => {
  const events = ROLES.map((role, index) => note({ pitch: 48 + index * 3, start: 0, end: 4, role }));
  const result = emit(events);
  assert.equal(result.status, 'PASS');
  const tracks = splitMML(result.combinedMml);
  assert.equal(tracks.length, 6);
  assert.equal(tracks.every(track => track.length > 0), true);
});

test('empty roles stay empty — no filler tempo, no filler rests', () => {
  // MOBILE_SYNTAX §10 / PENDING P7.
  const result = emit([note({ start: 0, end: 1, role: 'Melody' }), note({ pitch: 48, start: 0, end: 1, role: 'Chord2' })]);
  assert.equal(result.status, 'PASS');
  const tracks = splitMML(result.combinedMml);
  assert.deepEqual(tracks.map(track => track === ''), [false, true, false, true, true, true]);
});

test('the combined string parses back through the authoritative splitter', () => {
  const result = emit([note({ start: 0, end: 1 }), note({ pitch: 55, start: 0, end: 1, role: 'Chord1' })]);
  assert.equal(result.status, 'PASS');
  assert.match(result.combinedMml, /^MML@.*;$/);
  assert.equal(splitMML(result.combinedMml).length, 6);
});

// ── 25–26. the round-trip gate ─────────────────────────────────────────────

test('every PASS carries a round-trip report over the semantic fields', () => {
  const result = emit([note({ start: 0, end: 1 })]);
  assert.equal(result.roundTrip.status, 'PASS');
  for (const field of ['attack-count', 'pitch', 'start', 'end', 'volume', 'silence-spans', 'tempo-position', 'tempo-value', 'total-duration']) {
    assert.ok(result.roundTrip.comparedFields.includes(field), `${field} must be compared`);
  }
});

test('a deliberately mismatched readback is rejected by the gate', () => {
  // The gate is handed output that is one beat short of what the candidate says.
  const expected = [{
    role: 'Melody',
    empty: false,
    notes: [{ pitch: 60, start: '0', end: '2', volume: 8 }],
    silence: [],
    tempo: [{ beat: '0', bpm: 120 }],
    total: '2',
  }];
  const { report } = verifyFinalReadback('MML@t120o4c4,,,,,;', expected);
  assert.equal(report.status, 'FAIL');
  assert.ok(report.mismatches.some(item => item.field === 'end' || item.field === 'total-duration'));
});

test('the gate catches a merged attack even though every pitch still matches', () => {
  const expected = [{
    role: 'Melody',
    empty: false,
    notes: [
      { pitch: 60, start: '0', end: '1', volume: 8 },
      { pitch: 60, start: '1', end: '2', volume: 8 },
    ],
    silence: [],
    tempo: [{ beat: '0', bpm: 120 }],
    total: '2',
  }];
  const { report } = verifyFinalReadback('MML@t120o4c4&c4,,,,,;', expected);
  assert.equal(report.status, 'FAIL');
  assert.ok(report.mismatches.some(item => item.field === 'attack-count'));
});

test('the gate catches an absorbed rest', () => {
  const expected = [{
    role: 'Melody',
    empty: false,
    notes: [{ pitch: 60, start: '0', end: '1', volume: 8 }],
    silence: [{ start: '1', end: '2' }],
    tempo: [{ beat: '0', bpm: 120 }],
    total: '2',
  }];
  const { report } = verifyFinalReadback('MML@t120o4c2,,,,,;', expected);
  assert.equal(report.status, 'FAIL');
});

// ── 27–29. determinism, immutability, readiness ────────────────────────────

test('the same candidate emits byte-identical output every time', () => {
  const events = [
    note({ pitch: 60, start: 0, end: '3/2' }),
    note({ pitch: 67, start: '3/2', end: '9/4' }),
    rest({ start: '9/4', end: '5/2' }),
    note({ pitch: 72, start: '5/2', end: 4 }),
  ];
  const runs = [emit(events), emit(events), emit(events)];
  assert.equal(runs[0].status, 'PASS');
  assert.equal(new Set(runs.map(run => run.combinedMml)).size, 1);
});

test('the Source-Faithful Baseline is untouched by emission', () => {
  const baselineSnapshot = createCanonicalProject({
    id: 'baseline', title: 'baseline', sources: [OFFICIAL],
    events: [note({ start: 0, end: 1 })], tempoEvents: [tempo(0, 120)],
  });
  const candidate = project({
    events: [note({ start: 0, end: 1 }), note({ start: 1, end: 2 })],
    metadata: { sourceFaithfulBaseline: { snapshot: baselineSnapshot } },
  });
  const before = structuredClone(candidate);
  const result = emitFinalMml(candidate);
  assert.equal(result.status, 'PASS');
  assert.deepEqual(structuredClone(candidate), before, 'the emitter mutated its input');
});

test('a blocking readiness gate stops emission — the emitter is not a bypass', () => {
  const result = emit([note({ start: 0, end: 1 })], {
    readiness: { preGameBlocking: ['source', 'baseline'], candidateReady: false },
  });
  assert.equal(result.status, 'PENDING');
  assert.equal(result.combinedMml, null);
  assert.ok(codes(result).includes(EMIT_DIAGNOSTICS.READINESS_BLOCKED));
});

test('a readiness report blocked only on `technical` still allows emission', () => {
  // That gate grades the MML this emitter has not produced yet; requiring it
  // here would be circular.
  const result = emit([note({ start: 0, end: 1 })], {
    readiness: { preGameBlocking: ['technical'], candidateReady: false },
  });
  assert.equal(result.status, 'PASS');
});

test('a pending arbitration decision blocks emission', () => {
  const target = note({ start: 0, end: 1 });
  const decision = createArbitrationDecision({
    id: nextId('d'), eventIds: [target.id], action: 'role-move', status: 'pending',
    reason: 'Unresolved lead/harmony arbitration.',
  });
  const result = emitFinalMml(project({ events: [target], decisions: [decision] }));
  assert.equal(result.status, 'PENDING');
  assert.ok(codes(result).includes(EMIT_DIAGNOSTICS.PENDING_DECISIONS_PRESENT));
});

// ── 30–32. Canonical conformance of what is emitted ────────────────────────

test('caution lengths are refused by default and exact once opted in', () => {
  // MOBILE_SYNTAX §3: a plain non-power-of-two length is not engine-illegal. It
  // is caution-gated. Both halves of that sentence are checked here.
  const events = [note({ start: 0, end: '1/3' })];
  assert.equal(emit(events).status, 'FAIL');

  const optedIn = emit(events, { cautionLengthOptIn: true });
  assert.equal(optedIn.status, 'PASS');
  const track = readTrack(optedIn);
  assert.equal(f(track.events[0].end).cmp(new F(1, 3)), 0);
});

test('a plain non-power-of-two denominator no tick grid can express stays exact', () => {
  // 4/7 of a quarter note is 274.285… ticks at PPQ 480. Any implementation that
  // smuggled in a tick domain cannot represent it; exact rational can.
  const events = Array.from({ length: 7 }, (unused, index) => note({
    start: new F(4 * index, 7).toString(), end: new F(4 * (index + 1), 7).toString(),
  }));
  const result = emit(events, { cautionLengthOptIn: true });
  assert.equal(result.status, 'PASS');
  const track = readTrack(result);
  assert.equal(track.events.length, 7);
  assert.equal(f(track.total).cmp(4), 0);
  for (let index = 0; index < 7; index += 1) {
    assert.equal(f(track.events[index].start).cmp(new F(4 * index, 7)), 0);
  }
});

test('Final-forbidden syntax is never emitted, across a wide duration sweep', () => {
  // MOBILE_SYNTAX §4 / §5 / PENDING P3, P5. The real check is that the
  // authoritative Final parser accepts the output with zero errors; the pattern
  // scan names the specific forms so a failure says which one appeared.
  const forbidden = [/\.\./, /64\./, /(?<!\d)3\./, /(?<!\d)6\./, /12\./, /24\./, /48\./, /n\d/];
  for (let numerator = 1; numerator <= 40; numerator += 1) {
    const events = [note({ start: 0, end: new F(numerator, 16).toString() })];
    const result = emit(events, { cautionLengthOptIn: true });
    if (result.status !== 'PASS') continue;
    const mml = melody(result).mml;
    for (const pattern of forbidden) {
      assert.equal(pattern.test(mml), false, `${mml} contains forbidden form ${pattern}`);
    }
    assert.equal(readTrack(result).errors.length, 0, `${mml} must be Final-clean`);
  }
});

test('no emitted role ever carries a Final parse error', () => {
  const events = [
    note({ pitch: 48, start: 0, end: '3/2', role: 'Chord2', volume: 9 }),
    note({ pitch: 60, start: 0, end: '7/4', role: 'Melody', volume: 11 }),
    note({ pitch: 64, start: '7/4', end: 4, role: 'Melody', volume: 11 }),
    note({ pitch: 55, start: '3/2', end: 4, role: 'Chord2', volume: 9 }),
  ];
  const result = emit(events, {}, { tempoEvents: [tempo(0, 96), tempo(2, 132)] });
  assert.equal(result.status, 'PASS');
  for (const role of ['Melody', 'Chord2']) {
    assert.equal(readTrack(result, role).errors.length, 0);
  }
});

// ── 33. idempotence ────────────────────────────────────────────────────────

test('emit -> parse -> emit is byte-identical', () => {
  const events = [
    note({ pitch: 60, start: 0, end: '3/2', volume: 10 }),
    note({ pitch: 67, start: '3/2', end: '5/2', volume: 10 }),
    rest({ start: '5/2', end: 3 }),
    note({ pitch: 72, start: 3, end: 5, volume: 10 }),
    note({ pitch: 48, start: 0, end: 5, role: 'Chord2', volume: 7 }),
  ];
  const first = emit(events, {}, { tempoEvents: [tempo(0, 120), tempo(4, 150)] });
  assert.equal(first.status, 'PASS');

  const reconstructed = projectFromFinalReadback(first.combinedMml);
  const second = emitFinalMml(reconstructed);
  assert.equal(second.status, 'PASS');
  assert.equal(second.combinedMml, first.combinedMml);
});

// ── input shape refusals ───────────────────────────────────────────────────

test('overlapping notes in one role are refused, never flattened', () => {
  const result = emit([note({ start: 0, end: 2 }), note({ pitch: 64, start: 1, end: 3 })]);
  assert.equal(result.status, 'FAIL');
  assert.ok(codes(result).includes(EMIT_DIAGNOSTICS.ROLE_POLYPHONY_UNSUPPORTED));
});

test('an event with no six-slot role is refused, not assigned one', () => {
  const orphan = createCanonicalNoteEvent({
    id: nextId('n'), pitch: 60, start: '0', end: '1', role: null, sourceIds: ['official'],
  });
  const result = emitFinalMml(project({ events: [orphan] }));
  assert.equal(result.status, 'FAIL');
  assert.ok(codes(result).includes(EMIT_DIAGNOSTICS.EVENT_ROLE_UNASSIGNED));
});

test('a non-project argument is a programmer error, not a result', () => {
  assert.throws(() => emitFinalMml(null), /Canonical project is required/);
  assert.throws(() => emitFinalMml('MML@'), /Canonical project is required/);
});

test('every result carries the published release identity and the scope notice', () => {
  const result = emit([note({ start: 0, end: 1 })]);
  assert.equal(result.canonical.canonical_version, EFFECTIVE_RULESET.canonical.canonical_version);
  assert.equal(result.canonical.rules_snapshot_sha, EFFECTIVE_RULESET.canonical.rules_snapshot_sha);
  assert.match(result.notice, /not a Canonical verdict/);
});
