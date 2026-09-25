// Technical Timing Repair × Final MML emitter regressions.
//
// Checkpoint A pinned the repair layer in isolation. These pin the seam: that
// turning repair on changes *which candidate* the emitter grades and nothing
// about *what the gates demand*, and that turning it off leaves the emitter
// byte-for-byte what it was.
//
// The failure modes these exist to make impossible:
//
//   * repair becoming a bypass — for readiness, for the character budget, for a
//     preserved source-supported interval, or for unproven material;
//   * the round-trip gate grading the pre-repair semantics, so the emitted string
//     "passes" against music it does not represent;
//   * the original and repaired candidates becoming indistinguishable in the
//     result, so nobody can see what was changed;
//   * a repaired candidate losing an attack, merging two into a tie, or moving a
//     tempo.
import test from 'node:test';
import assert from 'node:assert/strict';
import { F, f, ROLES } from '../backend/mml/index.mjs';
import { splitMML, parseTrack } from '../backend/mml/parser.mjs';
import {
  createSource,
  createCanonicalNoteEvent,
  createCanonicalRestEvent,
  createCanonicalTempoEvent,
  createCanonicalProject,
  createArbitrationDecision,
} from '../backend/canonical/index.mjs';
import {
  INTERVAL_TYPES,
  MICRO_TIMING_KEEP_ACTION,
  MICRO_TIMING_TECHNICAL_ACTIONS,
  createIntervalIdentity,
  intervalIdentityKey,
} from '../backend/canonical/micro-timing.mjs';
import { emitFinalMml } from '../backend/final/mml-emitter.mjs';
import { EMIT_DIAGNOSTICS, parserFacts } from '../backend/final/emitter-contract.mjs';
import { projectFromFinalReadback, silenceSpansOf } from '../backend/final/round-trip.mjs';
import { evaluateProjectReadiness } from '../backend/final/readiness.mjs';
import { REPAIR_DIAGNOSTICS, REPAIR_STATUS, repairTechnicalTiming } from '../backend/final/technical-timing-repair.mjs';
import { MICRO_GAP_BLOCKERS, enforceMicroGaps } from '../backend/final/micro-gap-enforcement.mjs';
import {
  MACHINE_DELIVERY_GATE_NAMES,
  MACHINE_DELIVERY_SCHEMA_V1,
  MACHINE_DELIVERY_SCHEMA_V2,
  evaluateMachineDelivery,
} from '../backend/final/delivery-evaluator.mjs';

const RESIDUE = new F(1, 256);
const OFFICIAL = createSource({ id: 'official', label: 'Official MusicXML', kind: 'official-musicxml', authority: 'primary-symbolic' });

let counter = 0;
const nextId = prefix => `${prefix}-${++counter}`;

const note = ({ id = nextId('n'), pitch = 60, start, end, role = 'Melody', volume = 8 }) => createCanonicalNoteEvent({
  id, pitch, start: String(start), end: String(end), role, voice: role, volume, sourceIds: ['official'],
});
const rest = ({ id = nextId('r'), start, end, role = 'Melody' }) => createCanonicalRestEvent({
  id, start: String(start), end: String(end), role, voice: role, sourceIds: ['official'],
});
const tempo = (beat, bpm) => createCanonicalTempoEvent({ id: nextId('t'), beat: String(beat), bpm, sourceIds: ['official'] });

const gapIdentity = (previous, next) => createIntervalIdentity({
  type: INTERVAL_TYPES.INTER_EVENT_GAP,
  previousEventId: previous.id,
  nextEventId: next.id,
  start: previous.end,
  end: next.start,
});
const durationIdentity = event => createIntervalIdentity({
  type: INTERVAL_TYPES.EVENT_DURATION, eventId: event.id, start: event.start, end: event.end,
});
const eventIdsOf = identity => (identity.type === INTERVAL_TYPES.EVENT_DURATION
  ? [identity.eventId] : [identity.previousEventId, identity.nextEventId]);

const technicalDecision = identity => createArbitrationDecision({
  id: `tech:${eventIdsOf(identity).join('+')}`,
  eventIds: eventIdsOf(identity),
  action: MICRO_TIMING_TECHNICAL_ACTIONS[0],
  status: 'accepted',
  reason: 'Decomposition residue left by the tie-splitting pass; no source counterpart.',
  evidence: ['producer log: split residue at bar 3'],
  metadata: { intervalIdentity: identity },
});
const keepDecision = identity => createArbitrationDecision({
  id: `keep:${eventIdsOf(identity).join('+')}`,
  eventIds: eventIdsOf(identity),
  action: MICRO_TIMING_KEEP_ACTION,
  status: 'accepted',
  reason: 'Source-supported articulation separation notated in the official score.',
  evidence: ['official MusicXML, measure 3, notated staccato separation'],
  metadata: { intervalIdentity: identity, evidenceSourceIds: ['official'] },
});

function project({ events, decisions = [], tempoEvents = [tempo(0, 120)], metadata = {} }) {
  return createCanonicalProject({
    id: nextId('song'), title: 'repair × emitter fixture',
    sources: [OFFICIAL], events, tempoEvents, decisions,
    metadata: { sourceComplete: true, ...metadata },
  });
}

const codes = result => result.diagnostics.map(item => item.code);
const melody = result => result.roles.find(entry => entry.role === 'Melody');
const readTrack = (result, role = 'Melody') => parseTrack(
  splitMML(result.combinedMml)[ROLES.indexOf(role)], role, { mode: 'final' },
);

/**
 * The canonical repairable shape: a rest releases one 1/256 early, `b` is on
 * beat. Rest-preceded because that is the only hole whose closure the Canonical
 * IR proves neutral — moving a rest's end changes no note, so the role's silence
 * and attacks are identical point sets either side of the repair.
 */
function residueCandidate({ pitchB = 62 } = {}) {
  const opening = note({ id: 'emit-n', start: 0, end: 1 });
  const a = rest({ id: 'emit-a', start: 1, end: f(2).sub(RESIDUE) });
  const b = note({ id: 'emit-b', pitch: pitchB, start: 2, end: 3 });
  return { opening, a, b, candidate: project({ events: [opening, a, b], decisions: [technicalDecision(gapIdentity(a, b))] }) };
}

/**
 * The same hole with a NOTE in front of it. Closing it would extend that note's
 * release, which nothing in the IR proves neutral, so the emitter must still
 * refuse with the repair opt-in switched on.
 */
function noteBeforeGapCandidate() {
  const a = note({ id: 'nbg-a', start: 0, end: f(1).sub(RESIDUE) });
  const b = note({ id: 'nbg-b', pitch: 62, start: 1, end: 2 });
  return { a, b, candidate: project({ events: [a, b], decisions: [technicalDecision(gapIdentity(a, b))] }) };
}

// ---------------------------------------------------------------------------
// 1–3. The default path does not move
// ---------------------------------------------------------------------------

test('TTRE-1 without the opt-in the emitter refuses technical residue exactly as before', () => {
  const { candidate } = residueCandidate();
  const result = emitFinalMml(candidate);

  assert.equal(result.status, 'FAIL');
  assert.ok(codes(result).includes(EMIT_DIAGNOSTICS.MICRO_GAP_TECHNICAL_RESIDUE));
  assert.equal(result.combinedMml, null);
  assert.equal(result.technicalTimingRepair, null, 'an un-requested repair leaves no block behind');
  assert.equal(result.microGap.rejectedIntervalKeys.length, 1);
  assert.ok(codes(result).every(code => !code.startsWith('TECHNICAL_TIMING_REPAIR')));
});

test('TTRE-2 a previously valid candidate emits byte-identically with the opt-in on or off', () => {
  const clean = project({
    events: [note({ id: 'ok-a', start: 0, end: 1 }), rest({ id: 'ok-r', start: 1, end: '3/2' }), note({ id: 'ok-b', pitch: 64, start: '3/2', end: 3 })],
  });
  const off = emitFinalMml(clean);
  const on = emitFinalMml(clean, { technicalTimingRepair: true });

  assert.equal(off.status, 'PASS');
  assert.equal(on.status, 'PASS');
  assert.equal(on.combinedMml, off.combinedMml, 'the emitted string must not move');
  assert.deepEqual(codes(on), codes(off), 'no new diagnostic appears on a clean candidate');
  assert.deepEqual(JSON.parse(JSON.stringify(on.roles)), JSON.parse(JSON.stringify(off.roles)));
  // The block still records that repair was asked for and found nothing to do.
  assert.equal(on.technicalTimingRepair.requested, true);
  assert.equal(on.technicalTimingRepair.applied, false);
  assert.deepEqual([...on.technicalTimingRepair.presentedIntervalKeys], []);
});

test('TTRE-3 emission is deterministic and idempotent on a repaired candidate', () => {
  const { candidate } = residueCandidate();
  const first = emitFinalMml(candidate, { technicalTimingRepair: true });
  const second = emitFinalMml(candidate, { technicalTimingRepair: true });
  assert.equal(first.status, 'PASS');
  assert.equal(second.combinedMml, first.combinedMml);

  // emit → parse → emit is byte-identical, so the repaired output is a fixed
  // point of the serializer rather than something that keeps drifting.
  const rebuilt = projectFromFinalReadback(first.combinedMml);
  const again = emitFinalMml(rebuilt, { technicalTimingRepair: true });
  assert.equal(again.status, 'PASS');
  assert.equal(again.combinedMml, first.combinedMml);
});

// ---------------------------------------------------------------------------
// 4–7. A repaired candidate emits, and the round trip grades the repaired music
// ---------------------------------------------------------------------------

test('TTRE-4 a repaired candidate emits, parses under Final mode, and round-trips exactly', () => {
  const { candidate } = residueCandidate();
  const result = emitFinalMml(candidate, { technicalTimingRepair: true });

  assert.equal(result.status, 'PASS');
  assert.ok(codes(result).includes(EMIT_DIAGNOSTICS.TECHNICAL_TIMING_REPAIR_APPLIED));
  assert.equal(result.roundTrip.status, 'PASS');
  assert.deepEqual([...result.roundTrip.mismatches], []);

  // The emitted string is valid under the authoritative Final parser, not merely
  // under the ingest profile.
  const track = readTrack(result);
  assert.deepEqual([...track.errors], []);
  assert.equal(track.events.length, 2, 'both attacks survive');
  assert.deepEqual(track.events, [
    { pitch: 60, start: '0', end: '1', volume: 8 },
    { pitch: 62, start: '2', end: '3', volume: 8 },
  ]);
  // The silence the candidate always meant, with the sub-grid hole folded into
  // it — one span, not two, and not a beat more or less.
  assert.deepEqual(silenceSpansOf(track), [{ start: '1', end: '2' }]);
  assert.equal(melody(result).attacks, 2);
});

test('TTRE-5 the round trip grades the repaired semantics, and the original timing is still recorded', () => {
  const { a, candidate } = residueCandidate();
  const result = emitFinalMml(candidate, { technicalTimingRepair: true });
  const track = readTrack(result);

  // What the string means is the repaired candidate: the hole before the second
  // attack is gone, and the silence runs to the attack exactly.
  assert.deepEqual(silenceSpansOf(track), [{ start: '1', end: '2' }]);
  assert.notEqual(a.end, '2', 'the candidate itself had the rest stopping early');

  // ...and the pre-repair timing is still on the result, so the two are never
  // indistinguishable. MOBILE_SYNTAX §11 step 8.
  const block = result.technicalTimingRepair;
  assert.equal(block.applied, true);
  assert.equal(block.status, REPAIR_STATUS.PASS);
  assert.equal(block.repairs[0].before.end, a.end);
  assert.equal(block.repairs[0].after.end, '2');
  assert.equal(block.repairs[0].delta, RESIDUE.toString());
  assert.equal(block.baselineProjectId, candidate.id);
  assert.notEqual(block.repairedProjectId, candidate.id);
  assert.equal(result.microGap.gradedProjectId, block.repairedProjectId);
  assert.deepEqual([...block.preRepair.rejectedIntervalKeys], [...block.presentedIntervalKeys]);
});

test('TTRE-6 a sustain a tempo change splits stays one attack, and the repair never lengthens it', () => {
  // A sustain spanning a mid-song tempo change, in a role that also carries a
  // repairable hole. The sustain's *representation* becomes tied segments; its
  // attack identity does not change, and the repair does not touch it.
  const a = note({ id: 'split-a', start: 0, end: 2 });
  const gap = rest({ id: 'split-r', start: 2, end: f(3).sub(RESIDUE) });
  const b = note({ id: 'split-b', pitch: 62, start: 3, end: 4 });
  const candidate = project({
    events: [a, gap, b],
    tempoEvents: [tempo(0, 120), tempo(1, 144)],
    decisions: [technicalDecision(gapIdentity(gap, b))],
  });

  const result = emitFinalMml(candidate, { technicalTimingRepair: true });
  assert.equal(result.status, 'PASS');
  assert.equal(result.technicalTimingRepair.applied, true);
  const track = readTrack(result);
  assert.ok(melody(result).mml.includes('&'), 'the tempo change forces a tie chain');
  assert.equal(track.events.length, 2, 'the tie chain collapses back into one attack, not two');
  assert.deepEqual(track.events[0], { pitch: 60, start: '0', end: '2', volume: 8 }, 'the sustain was not extended by the repair');
  // The Tempo Map itself is untouched by the repair.
  assert.deepEqual(track.tempo, [{ beat: '0', bpm: 120 }, { beat: '1', bpm: 144 }]);
});

test('TTRE-7 two repeated attacks around technical residue never become one sustain', () => {
  const { candidate } = residueCandidate({ pitchB: 60 });
  const result = emitFinalMml(candidate, { technicalTimingRepair: true });
  assert.equal(result.status, 'PASS');

  const track = readTrack(result);
  assert.equal(track.events.length, 2, 'MOBILE_SYNTAX §8: a repeated attack is not tied away');
  assert.equal(track.events[0].pitch, 60);
  assert.equal(track.events[1].pitch, 60);
  assert.equal(track.events[0].end, '1', 'the first attack was not stretched into the second');
  assert.equal(track.events[1].start, '2');
  assert.ok(!melody(result).mml.includes('&'), 'no tie may join two distinct attacks');
});

// ---------------------------------------------------------------------------
// 8–13. Repair is never a bypass
// ---------------------------------------------------------------------------

test('TTRE-8 a source-supported sub-grid interval still fails closed with the opt-in on', () => {
  const opening = note({ id: 'keep-n', start: 0, end: 1 });
  const a = rest({ id: 'keep-a', start: 1, end: f(2).sub(RESIDUE) });
  const b = note({ id: 'keep-b', pitch: 62, start: 2, end: 3 });
  const candidate = project({ events: [opening, a, b], decisions: [keepDecision(gapIdentity(a, b))] });

  const result = emitFinalMml(candidate, { technicalTimingRepair: true });
  assert.equal(result.status, 'FAIL');
  assert.ok(codes(result).includes(EMIT_DIAGNOSTICS.SOURCE_SUPPORTED_INTERVAL_NOT_REPRESENTABLE));
  assert.equal(result.combinedMml, null);
  assert.equal(result.technicalTimingRepair.applied, false);
  assert.deepEqual([...result.technicalTimingRepair.presentedIntervalKeys], [],
    'a preserved interval is never even presented to the repair layer');
});

test('TTRE-9 unproven sub-grid material still blocks with the opt-in on', () => {
  const opening = note({ id: 'unk-n', start: 0, end: 1 });
  const a = rest({ id: 'unk-a', start: 1, end: f(2).sub(RESIDUE) });
  const b = note({ id: 'unk-b', pitch: 62, start: 2, end: 3 });
  const candidate = project({ events: [opening, a, b] });

  const result = emitFinalMml(candidate, { technicalTimingRepair: true });
  assert.equal(result.status, 'PENDING');
  assert.ok(codes(result).includes(EMIT_DIAGNOSTICS.MICRO_GAP_BLOCKED_PENDING));
  assert.equal(result.combinedMml, null);
  assert.equal(result.technicalTimingRepair.applied, false);
});

test('TTRE-10 residue the repair layer refuses still fails the emitter, with the refusal on record', () => {
  // A sub-grid note duration: repairable by nothing this layer implements.
  const short = note({ id: 'nore-a', start: 0, end: RESIDUE });
  const following = note({ id: 'nore-b', pitch: 62, start: RESIDUE, end: 1 });
  const candidate = project({ events: [short, following], decisions: [technicalDecision(durationIdentity(short))] });

  const result = emitFinalMml(candidate, { technicalTimingRepair: true });
  assert.equal(result.status, 'FAIL');
  assert.ok(codes(result).includes(EMIT_DIAGNOSTICS.TECHNICAL_TIMING_REPAIR_UNAVAILABLE));
  assert.ok(codes(result).includes(EMIT_DIAGNOSTICS.MICRO_GAP_TECHNICAL_RESIDUE));
  assert.equal(result.combinedMml, null);
  assert.equal(result.technicalTimingRepair.applied, false);
  assert.equal(result.technicalTimingRepair.status, REPAIR_STATUS.PENDING);
  assert.equal(result.technicalTimingRepair.unrepairedIntervalKeys.length, 1);
  // The unrepaired interval is still on the emitter's own reject list.
  assert.deepEqual([...result.microGap.rejectedIntervalKeys], [...result.technicalTimingRepair.unrepairedIntervalKeys]);
  assert.equal(result.microGap.gradedProjectId, null, 'nothing was regraded');
});

test('TTRE-11 a blocking readiness report is not bypassed by a successful repair', () => {
  const { candidate } = residueCandidate();
  const readiness = evaluateProjectReadiness({
    project: candidate,
    mmlValidation: { ok: true, errors: [] },
    core3Report: { status: 'PASS', blockers: [] },
    core3CompletenessReport: { status: 'PASS', blockers: [] },
    harmonyReport: { status: 'PASS', unresolvedCount: 0 },
    playerReadback: 'PASS',
    originalAudioRequired: true,
  });
  assert.ok(readiness.preGameBlocking.length, 'the fixture must actually block somewhere');

  const result = emitFinalMml(candidate, { technicalTimingRepair: true, readiness });
  assert.equal(result.status, 'PENDING');
  assert.ok(codes(result).includes(EMIT_DIAGNOSTICS.READINESS_BLOCKED));
  assert.equal(result.combinedMml, null);
  // The repair itself succeeded; it simply bought nothing past the gate.
  assert.equal(result.technicalTimingRepair.applied, true);
});

test('TTRE-12 readiness still sees the unrepaired candidate as failing micro-timing', () => {
  // The repair layer is not wired into the readiness gate, and must not be: a
  // gate that silently repaired what it grades would grade its own output.
  const { candidate } = residueCandidate();
  const readiness = evaluateProjectReadiness({
    project: candidate,
    mmlValidation: { ok: true, errors: [] },
    core3Report: { status: 'PASS', blockers: [] },
    core3CompletenessReport: { status: 'PASS', blockers: [] },
    harmonyReport: { status: 'PASS', unresolvedCount: 0 },
    playerReadback: 'PASS',
    originalAudioRequired: true,
  });
  assert.equal(readiness.gates.microTiming.status, 'FAIL');
  assert.ok(readiness.preGameBlocking.includes('microTiming'));
});

test('TTRE-13 repair never rescues a character-budget failure', () => {
  // A role far over the 2,400-character limit that also carries repairable
  // residue. The repair runs; the budget still refuses, and no note is dropped.
  const { characterLimit } = parserFacts();
  const leading = rest({ id: 'big-r', start: 0, end: f(1).sub(RESIDUE) });
  const events = [leading];
  const total = characterLimit + 200;
  for (let index = 1; index <= total; index += 1) {
    events.push(note({ id: `big-${index}`, pitch: 60 + (index % 2), start: index, end: index + 1 }));
  }
  const candidate = project({ events, decisions: [technicalDecision(gapIdentity(leading, events[1]))] });

  const result = emitFinalMml(candidate, { technicalTimingRepair: true });
  assert.equal(result.status, 'FAIL');
  assert.ok(codes(result).includes(EMIT_DIAGNOSTICS.CHARACTER_BUDGET_EXCEEDED));
  assert.equal(result.combinedMml, null);
  assert.equal(result.technicalTimingRepair.applied, true, 'the repair did run');
  assert.equal(melody(result).attacks, total, 'every attack is still there');
  const overflow = result.diagnostics.find(item => item.code === EMIT_DIAGNOSTICS.CHARACTER_BUDGET_EXCEEDED);
  assert.ok(overflow.characters > characterLimit);
});

test('TTRE-14 a mixed candidate whose residue is only partly repairable emits nothing', () => {
  // Melody residue is repairable; Chord1 residue is a sub-grid note duration and
  // is not. A partial repair must not become a partial pass.
  const opening = note({ id: 'mix2-n', start: 0, end: 1 });
  const a = rest({ id: 'mix2-a', start: 1, end: f(2).sub(RESIDUE) });
  const b = note({ id: 'mix2-b', pitch: 62, start: 2, end: 3 });
  const short = note({ id: 'mix2-c', pitch: 64, role: 'Chord1', start: 0, end: RESIDUE });
  const after = note({ id: 'mix2-d', pitch: 65, role: 'Chord1', start: RESIDUE, end: 3 });
  const candidate = project({
    events: [opening, a, b, short, after],
    decisions: [technicalDecision(gapIdentity(a, b)), technicalDecision(durationIdentity(short))],
  });

  const result = emitFinalMml(candidate, { technicalTimingRepair: true });
  assert.equal(result.status, 'FAIL');
  assert.equal(result.combinedMml, null);
  assert.equal(result.technicalTimingRepair.applied, false);
  assert.equal(result.technicalTimingRepair.presentedIntervalKeys.length, 2);
  assert.equal(result.technicalTimingRepair.repairedIntervalKeys.length, 1);
  assert.equal(result.technicalTimingRepair.unrepairedIntervalKeys.length, 1);
});

test('TTRE-14b a hole preceded by a NOTE still refuses with the opt-in on', () => {
  // The correction, at the emitter seam: turning the opt-in on must not turn a
  // refusal into an emission when the transformation's neutrality is unproven.
  const { a, b, candidate } = noteBeforeGapCandidate();

  const off = emitFinalMml(candidate);
  const on = emitFinalMml(candidate, { technicalTimingRepair: true });

  assert.equal(off.status, 'FAIL');
  assert.equal(on.status, 'FAIL', 'the opt-in buys nothing here');
  assert.equal(on.combinedMml, null);
  assert.ok(codes(on).includes(EMIT_DIAGNOSTICS.TECHNICAL_TIMING_REPAIR_UNAVAILABLE));
  assert.ok(codes(on).includes(EMIT_DIAGNOSTICS.MICRO_GAP_TECHNICAL_RESIDUE));
  assert.equal(on.technicalTimingRepair.applied, false);
  assert.equal(on.technicalTimingRepair.status, REPAIR_STATUS.PENDING);
  assert.equal(on.technicalTimingRepair.repairedIntervalKeys.length, 0);
  assert.equal(on.technicalTimingRepair.unrepairedIntervalKeys.length, 1);
  assert.equal(on.microGap.gradedProjectId, null, 'nothing was regraded');

  // The candidate's own note is untouched either way.
  assert.equal(candidate.events.find(event => event.id === a.id).end, f(1).sub(RESIDUE).toString());
  assert.equal(candidate.events.find(event => event.id === b.id).start, '1');
});

test('TTRE-15 a coalesced rest emits the same silence the candidate always meant', () => {
  const opening = note({ id: 'sil-n1', start: 0, end: 1 });
  const long = rest({ id: 'sil-q', start: 1, end: f(2).sub(RESIDUE) });
  const residue = rest({ id: 'sil-r', start: f(2).sub(RESIDUE), end: 2 });
  const closing = note({ id: 'sil-n2', pitch: 62, start: 2, end: 3 });
  const candidate = project({
    events: [opening, long, residue, closing],
    decisions: [technicalDecision(durationIdentity(residue))],
  });

  const result = emitFinalMml(candidate, { technicalTimingRepair: true });
  assert.equal(result.status, 'PASS');
  const track = readTrack(result);
  assert.deepEqual([...track.errors], []);
  assert.deepEqual(silenceSpansOf(track), [{ start: '1', end: '2' }], 'one uninterrupted beat of silence');
  assert.deepEqual(track.events, [
    { pitch: 60, start: '0', end: '1', volume: 8 },
    { pitch: 62, start: '2', end: '3', volume: 8 },
  ]);
  assert.equal(result.roundTrip.status, 'PASS');
});

test('TTRE-16 the emit result keeps the pre-repair and post-repair verdicts apart', () => {
  const { candidate } = residueCandidate();
  const result = emitFinalMml(candidate, { technicalTimingRepair: true });

  // Post-repair: the graded candidate is clean.
  assert.equal(result.microGap.status, 'PASS');
  assert.deepEqual([...result.microGap.rejectedIntervalKeys], []);
  // Pre-repair: the interval that was rejected is still named.
  assert.equal(result.technicalTimingRepair.preRepair.rejectedIntervalKeys.length, 1);
  assert.equal(
    result.technicalTimingRepair.preRepair.rejectedIntervalKeys[0],
    intervalIdentityKey(gapIdentity(
      candidate.events.find(event => event.id === 'emit-a'),
      candidate.events.find(event => event.id === 'emit-b'),
    )),
  );
  assert.notEqual(result.microGap.gradedProjectId, result.technicalTimingRepair.baselineProjectId);
});

// ─── preserved material and the repair's own verification ──────────────────
//
// G10 now raises MICRO_TIMING_SOURCE_SUPPORTED_NOT_FINAL_REPRESENTABLE for any
// preserved interval, so the re-grade of a repaired candidate that still holds
// one is PENDING with exactly that code where it used to be PASS. "Verification
// clean" means PASS, or PENDING whose only blocker is that code: the repair
// reports the preserved interval itself (PRESERVED_INTERVAL_PRESENT) and is
// still never Final-eligible beside it. Any other PENDING is still not clean.

const SOURCE_SUPPORTED = 'MICRO_TIMING_SOURCE_SUPPORTED_NOT_FINAL_REPRESENTABLE';
const quietNote = ({ id, pitch = 60, start, end, role = 'Melody' }) => note({ id, pitch, start, end, role, volume: null });

// Melody a[0,1) b[49/48,2) with the sub-grid gap kept as notated; Chord1 has a
// rest that stops one 480-tick before c2's attack, a technical hole the repair
// closes into the rest. `withUnknown` adds a Chord2 sub-grid gap nobody claimed.
function preservedBesideRepairable({ withUnknown = false } = {}) {
  const a = quietNote({ id: 'mix-a', start: 0, end: 1 });
  const b = quietNote({ id: 'mix-b', pitch: 62, start: '49/48', end: 2 });
  const c1 = quietNote({ id: 'mix-c1', start: 0, end: 1, role: 'Chord1', pitch: 48 });
  const cr = rest({ id: 'mix-cr', start: 1, end: '959/480', role: 'Chord1' });
  const c2 = quietNote({ id: 'mix-c2', start: 2, end: 3, role: 'Chord1', pitch: 48 });
  const extra = withUnknown
    ? [quietNote({ id: 'mix-d1', start: 0, end: 1, role: 'Chord2', pitch: 52 }), quietNote({ id: 'mix-d2', start: '481/480', end: 2, role: 'Chord2', pitch: 52 })]
    : [];
  return project({ events: [a, b, c1, cr, c2, ...extra], decisions: [keepDecision(gapIdentity(a, b)), technicalDecision(gapIdentity(cr, c2))] });
}

test('TTRE the repair\'s verification stays clean beside preserved material, which still keeps the candidate out of Final', () => {
  const candidate = preservedBesideRepairable();
  const enforcement = enforceMicroGaps(candidate);
  assert.deepEqual([enforcement.status, enforcement.blockers], ['FAIL', [MICRO_GAP_BLOCKERS.TECHNICAL_RESIDUE_PRESENT, SOURCE_SUPPORTED]]);

  const repaired = repairTechnicalTiming(candidate, { enforcement });
  assert.deepEqual([repaired.verification.status, repaired.verification.blockers], ['PENDING', [SOURCE_SUPPORTED]]);
  // As before the preserved-material code existed: the repair itself passes,
  // says what it left, and is not Final-eligible.
  assert.equal(repaired.status, REPAIR_STATUS.PASS);
  assert.equal(repaired.finalEmissionEligible, false);
  assert.ok(codes(repaired).includes(REPAIR_DIAGNOSTICS.PRESERVED_INTERVAL_PRESENT));
  assert.equal(codes(repaired).includes(REPAIR_DIAGNOSTICS.VERIFICATION_NOT_CLEAR), false);

  const emitted = emitFinalMml(candidate, { technicalTimingRepair: true });
  assert.equal(emitted.status, 'FAIL');
  assert.equal(emitted.combinedMml, null);
  const unavailable = emitted.diagnostics.find(item => item.code === EMIT_DIAGNOSTICS.TECHNICAL_TIMING_REPAIR_UNAVAILABLE);
  assert.equal(unavailable?.repairStatus, REPAIR_STATUS.PASS);
  assert.deepEqual(emitted.diagnostics.filter(item => item.severity !== 'notice').map(item => item.code), [
    EMIT_DIAGNOSTICS.MICRO_GAP_TECHNICAL_RESIDUE,
    EMIT_DIAGNOSTICS.SOURCE_SUPPORTED_INTERVAL_NOT_REPRESENTABLE,
  ]);
  assert.deepEqual(emitted.diagnostics.find(item => item.code === EMIT_DIAGNOSTICS.MICRO_GAP_TECHNICAL_RESIDUE).blockers,
    [MICRO_GAP_BLOCKERS.TECHNICAL_RESIDUE_PRESENT, SOURCE_SUPPORTED]);

  // With an unclaimed sub-grid gap beside them, the verification is not clean:
  // only the preserved-material code on its own is.
  const open = preservedBesideRepairable({ withUnknown: true });
  const openRepaired = repairTechnicalTiming(open, { enforcement: enforceMicroGaps(open) });
  assert.deepEqual([openRepaired.verification.status, openRepaired.verification.blockers],
    ['PENDING', [MICRO_GAP_BLOCKERS.CLASSIFICATION_UNKNOWN, SOURCE_SUPPORTED]]);
  assert.equal(openRepaired.status, REPAIR_STATUS.PENDING);
  assert.ok(codes(openRepaired).includes(REPAIR_DIAGNOSTICS.VERIFICATION_NOT_CLEAR));
  assert.equal(openRepaired.finalEmissionEligible, false);
});

test('TTRE a kept sub-grid rest before a technical hole: G10 adds its code behind the FAIL, and the repair path writes what it wrote', () => {
  // a[0,1), r[1,509/480) kept as notated, then a technical hole of one
  // 480-tick to b[17/16,2). G10 was FAIL on the residue before, and readiness
  // and machine delivery blocked on it; they still do, with the
  // preserved-material code now visible beside it.
  //
  // Disclosed, not changed here (TECHNICAL_TIMING_REPAIR.md): the repair closes
  // the hole into the preceding rest, which lengthens the preserved rest from
  // 1/480 short of the grid to exactly 1/16, so the repaired candidate holds no
  // preserved interval and the opt-in path writes "r64". Refusing that would
  // stop the emitter writing a candidate it writes today; it is an owner
  // decision. Finalize never reaches it, because it refuses a FAIL gate first.
  const a = quietNote({ id: 'o5-a', start: 0, end: 1 });
  const r = rest({ id: 'o5-r', start: 1, end: '509/480' });
  const b = quietNote({ id: 'o5-b', start: '17/16', end: 2 });
  const candidate = project({ events: [a, r, b], decisions: [keepDecision(durationIdentity(r)), technicalDecision(gapIdentity(r, b))] });

  const g10 = enforceMicroGaps(candidate);
  assert.deepEqual([g10.status, g10.blockers], ['FAIL', [MICRO_GAP_BLOCKERS.TECHNICAL_RESIDUE_PRESENT, SOURCE_SUPPORTED]]);
  assert.deepEqual(g10.preservedIntervalKeys, [intervalIdentityKey(durationIdentity(r))]);
  const readiness = evaluateProjectReadiness({ project: candidate });
  assert.deepEqual([readiness.gates.microTiming.status, readiness.gates.microTiming.blockers], ['FAIL', g10.blockers]);
  for (const schema of [MACHINE_DELIVERY_SCHEMA_V1, MACHINE_DELIVERY_SCHEMA_V2]) {
    const identity = Object.freeze({ canonical_version: 'x', canonical_status: 'PUBLISHED', rules_snapshot_sha: 'f'.repeat(40), machine_delivery_schema: schema });
    const gates = { ...Object.fromEntries(MACHINE_DELIVERY_GATE_NAMES.map(name => [name, { status: 'PASS' }])), microTiming: { status: g10.status, blockers: g10.blockers } };
    assert.deepEqual(evaluateMachineDelivery(gates, { canonical: identity, requireCompleteGateMap: true }).blocking.map(entry => entry.gate), ['microTiming'], schema);
  }

  const plain = emitFinalMml(candidate);
  assert.equal(plain.status, 'FAIL');
  const withRepair = emitFinalMml(candidate, { technicalTimingRepair: true });
  assert.equal(withRepair.status, 'PASS');
  assert.equal(withRepair.combinedMml, 'MML@t120o4cr64c8.&c32.,,,,,;');
  assert.deepEqual(withRepair.microGap.blockers, []);
});
