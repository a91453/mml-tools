// Canonical-aware Technical Timing Repair regressions.
//
// The rule these pin is published, not invented here. MASTER_RULES §7 permits
// normalizing a technical micro-gap that carries no musical meaning while
// preserving meaningful source rests, breaths and articulation gaps;
// MOBILE_SYNTAX §4 and §11 step 5 forbid a sub-1/64 technical component in Final
// output; MOBILE_SYNTAX §8 and §11 step 1 and ACCEPTANCE_CRITERIA Gate 1 require
// attacks and note-on identity to survive.
//
// The failure modes these exist to make impossible:
//
//   * the repair layer classifying anything itself, rather than consuming what
//     the source-aware analyzer and micro-gap enforcement already decided;
//   * a source-supported interval, an unproven interval, or an interval that is
//     not sub-grid at all being touched;
//   * a quantizer wearing a repair costume — snapping, rounding, epsilon
//     comparison, or moving a note to make a metric look better;
//   * an attack being created, deleted, moved, merged into a tie, or having its
//     pitch changed;
//   * a rejected interval being quietly dropped from the worklist and the result
//     still reporting PASS.
//
// Every timing assertion is exact rational. An epsilon anywhere in this file
// would defeat the pipeline it is checking.
import test from 'node:test';
import assert from 'node:assert/strict';
import { F, f } from '../backend/mml/index.mjs';
import {
  createSource,
  createCanonicalNoteEvent,
  createCanonicalRestEvent,
  createCanonicalTempoEvent,
  createCanonicalProject,
  createArbitrationDecision,
} from '../backend/canonical/index.mjs';
import {
  SAFE_GRID,
  INTERVAL_TYPES,
  MICRO_TIMING_CLASSIFICATIONS,
  MICRO_TIMING_KEEP_ACTION,
  MICRO_TIMING_TECHNICAL_ACTIONS,
  createIntervalIdentity,
  intervalIdentityKey,
} from '../backend/canonical/micro-timing.mjs';
import { enforceMicroGaps } from '../backend/final/micro-gap-enforcement.mjs';
import {
  REPAIR_STATUS,
  REPAIR_OPERATIONS,
  REPAIR_NEUTRALITY,
  REPAIR_DIAGNOSTICS,
  REPAIR_UNSUPPORTED,
  repairTechnicalTiming,
  readRejectedTechnicalRecords,
} from '../backend/final/technical-timing-repair.mjs';
import { EFFECTIVE_RULESET } from '../backend/rules/index.mjs';

const KEEP = MICRO_TIMING_KEEP_ACTION;
const TECHNICAL = MICRO_TIMING_TECHNICAL_ACTIONS[0];

// The published safe grid in Canonical IR quarter-note beats, written as its
// derivation rather than as a literal: whole-note 1/64 is 4/64 = 1/16 IR beats.
const EXACT_GRID = new F(4, 64);

// A residue length four times finer than the grid, and one whose float image is
// indistinguishable from the grid's. Anything comparing with a double or an
// epsilon cannot tell EXACT_GRID from NEAR_GRID; exact rational can.
const RESIDUE = new F(1, 256);
const NEAR_GRID = EXACT_GRID.sub(new F(1, 10n ** 20n));

const OFFICIAL = createSource({ id: 'official', label: 'Official MusicXML', kind: 'official-musicxml', authority: 'primary-symbolic' });
const THIRD_PARTY = createSource({ id: 'third', label: 'Community MIDI', kind: 'third-party-midi', authority: 'supporting' });

let counter = 0;
const nextId = prefix => `${prefix}-${++counter}`;

const note = ({ id = nextId('n'), pitch = 60, start, end, role = 'Melody', volume = null, sourceId = 'official' }) => createCanonicalNoteEvent({
  id, pitch, start: String(start), end: String(end), role, voice: role, volume,
  sourceIds: [sourceId], sourceEventIds: [`${id}/${sourceId}`],
});
const rest = ({ id = nextId('r'), start, end, role = 'Melody', sourceId = 'official' }) => createCanonicalRestEvent({
  id, start: String(start), end: String(end), role, voice: role,
  sourceIds: [sourceId], sourceEventIds: [`${id}/${sourceId}`],
});
const tempo = (beat = 0, bpm = 120) => createCanonicalTempoEvent({ id: nextId('t'), beat: String(beat), bpm, sourceIds: ['official'] });

const gapIdentity = (previous, next) => createIntervalIdentity({
  type: INTERVAL_TYPES.INTER_EVENT_GAP,
  previousEventId: previous.id,
  nextEventId: next.id,
  start: previous.end,
  end: next.start,
});
const durationIdentity = event => createIntervalIdentity({
  type: INTERVAL_TYPES.EVENT_DURATION,
  eventId: event.id,
  start: event.start,
  end: event.end,
});
const eventIdsOf = identity => (identity.type === INTERVAL_TYPES.EVENT_DURATION
  ? [identity.eventId]
  : [identity.previousEventId, identity.nextEventId]);

// An accepted classification that the interval is tooling residue with no source
// counterpart. Note what is absent: no threshold, no "looks like rounding"
// heuristic, no source-type inference. The claim is affirmed literally.
function technicalDecision(identity, { id = null } = {}) {
  const eventIds = eventIdsOf(identity);
  return createArbitrationDecision({
    id: id ?? `tech:${eventIds.join('+')}`,
    eventIds,
    action: TECHNICAL,
    status: 'accepted',
    reason: 'Decomposition residue left by the tie-splitting pass; no source counterpart.',
    evidence: ['producer log: split residue, no notated separation in any source'],
    metadata: { intervalIdentity: identity },
  });
}

// An accepted keep whose evidence cites a genuinely primary source that every
// event in the interval actually carries — what "source-supported" has to mean.
function keepDecision(identity, { evidenceSourceIds = ['official'] } = {}) {
  const eventIds = eventIdsOf(identity);
  return createArbitrationDecision({
    id: `keep:${eventIds.join('+')}`,
    eventIds,
    action: KEEP,
    status: 'accepted',
    reason: 'Source-supported articulation separation notated in the official score.',
    evidence: ['official MusicXML, measure 3, notated staccato separation'],
    metadata: { intervalIdentity: identity, evidenceSourceIds },
  });
}

function project({ events, decisions = [], sources = [OFFICIAL], tempoEvents = [tempo()], id = nextId('song') }) {
  const baseline = createCanonicalProject({
    id: `${id}:baseline`,
    title: 'Source-Faithful Baseline',
    sources,
    events,
    metadata: { sourceComplete: true, baselineKind: 'source-faithful' },
  });
  return createCanonicalProject({
    id,
    title: 'technical timing repair fixture',
    sources,
    events,
    tempoEvents,
    decisions,
    metadata: {
      sourceComplete: true,
      sourceFaithfulBaseline: { snapshot: baseline },
      audioAlignmentEvidence: [{ sourceId: 'original-audio', warnings: [], metrics: { confidence: 0.9 } }],
    },
  });
}

// Everything a repair is forbidden to move, compared structurally rather than by
// a tolerance: attack onsets, pitches, volumes, roles, provenance and count.
const attackShape = candidate => candidate.events
  .filter(event => event.kind === 'note')
  .map(event => ({ id: event.id, pitch: event.pitch, start: event.start, volume: event.volume, role: event.role, sourceIds: [...event.sourceIds].sort() }))
  .sort((left, right) => (left.id < right.id ? -1 : 1));

// The role's silence as a point set: everything in [0, end) no note covers.
function silenceOf(candidate, role = 'Melody') {
  const notes = candidate.events
    .filter(event => event.kind === 'note' && event.role === role)
    .sort((left, right) => f(left.start).cmp(right.start));
  const spans = candidate.events.filter(event => event.role === role);
  const end = spans.reduce((max, event) => (f(event.end).cmp(max) > 0 ? f(event.end) : max), f(0));
  const silence = [];
  let cursor = f(0);
  for (const event of notes) {
    if (f(event.start).cmp(cursor) > 0) silence.push([cursor.toString(), event.start]);
    if (f(event.end).cmp(cursor) > 0) cursor = f(event.end);
  }
  if (end.cmp(cursor) > 0) silence.push([cursor.toString(), end.toString()]);
  return silence;
}

const codes = result => result.diagnostics.map(item => item.code);

/**
 * The canonical fixture: a technical sub-grid hole left by an early release.
 * `a` stops one 1/256 before beat 1, `b` attacks exactly on beat 1.
 */
function earlyReleaseGap({ classify = 'technical', residue = RESIDUE } = {}) {
  const a = note({ id: 'gap-a', start: 0, end: f(1).sub(residue) });
  const b = note({ id: 'gap-b', pitch: 62, start: 1, end: 2 });
  const identity = gapIdentity(a, b);
  const decisions = classify === 'technical' ? [technicalDecision(identity)]
    : classify === 'keep' ? [keepDecision(identity)]
      : [];
  return { a, b, identity, candidate: project({ events: [a, b], decisions }) };
}

/** Two contiguous rests where the second one is sub-grid technical residue. */
function contiguousRestResidue() {
  const opening = note({ id: 'rest-n1', start: 0, end: 1 });
  const long = rest({ id: 'rest-q', start: 1, end: f(2).sub(RESIDUE) });
  const residue = rest({ id: 'rest-r', start: f(2).sub(RESIDUE), end: 2 });
  const closing = note({ id: 'rest-n2', pitch: 62, start: 2, end: 3 });
  const identity = durationIdentity(residue);
  return {
    opening, long, residue, closing, identity,
    candidate: project({ events: [opening, long, residue, closing], decisions: [technicalDecision(identity)] }),
  };
}

// ---------------------------------------------------------------------------
// 1–5. Successful technical repair
// ---------------------------------------------------------------------------

test('TTR-1 a technical sub-grid inter-event gap is closed into the preceding span, exactly', () => {
  const { a, b, identity, candidate } = earlyReleaseGap();
  const before = enforceMicroGaps(candidate);
  assert.equal(before.status, 'FAIL', 'the fixture must actually present technical residue');
  assert.deepEqual([...before.rejectedIntervalKeys], [intervalIdentityKey(identity)]);

  const result = repairTechnicalTiming(candidate);

  assert.equal(result.status, REPAIR_STATUS.PASS);
  assert.equal(result.finalEmissionEligible, true);
  assert.equal(result.presentedCount, 1);
  assert.deepEqual([...result.presentedIntervalKeys], [intervalIdentityKey(identity)]);
  assert.deepEqual([...result.repairedIntervalKeys], [intervalIdentityKey(identity)]);
  assert.deepEqual([...result.unrepairedIntervalKeys], []);

  const [repair] = result.repairs;
  assert.equal(repair.operation, REPAIR_OPERATIONS.CLOSE_GAP_INTO_PRECEDING_SPAN);
  assert.equal(repair.neutrality, REPAIR_NEUTRALITY.ATTACK_PRESERVING);
  assert.equal(repair.classification, MICRO_TIMING_CLASSIFICATIONS.TECHNICAL_RESIDUE);
  assert.equal(repair.targetEventId, a.id);
  assert.equal(repair.absorbedEventId, null);
  assert.equal(repair.before.end, a.end);
  assert.equal(repair.after.end, b.start);
  // Exact rational delta, not a rounded or float-derived one.
  assert.equal(repair.delta, RESIDUE.toString());
  assert.equal(f(repair.after.end).sub(f(repair.before.end)).cmp(RESIDUE), 0);
  assert.ok(repair.permittedBecause.includes('MASTER_RULES §7'));
  assert.equal(repair.decisionId, 'tech:gap-a+gap-b');

  // The repaired candidate has no hole left, and enforcement agrees.
  const repaired = result.repairedProject;
  assert.equal(repaired.events.find(event => event.id === a.id).end, '1');
  assert.equal(repaired.events.find(event => event.id === b.id).start, '1');
  assert.equal(result.verification.status, 'PASS');
  assert.deepEqual([...result.verification.rejectedIntervalKeys], []);
});

test('TTR-2 a technical sub-grid rest duration is coalesced with its contiguous predecessor', () => {
  const { long, residue, identity, candidate } = contiguousRestResidue();
  assert.equal(enforceMicroGaps(candidate).status, 'FAIL');

  const result = repairTechnicalTiming(candidate);
  assert.equal(result.status, REPAIR_STATUS.PASS);
  assert.equal(result.finalEmissionEligible, true);

  const [repair] = result.repairs;
  assert.equal(repair.operation, REPAIR_OPERATIONS.COALESCE_CONTIGUOUS_RESTS);
  assert.equal(repair.neutrality, REPAIR_NEUTRALITY.SILENCE_PRESERVING);
  assert.equal(repair.intervalType, INTERVAL_TYPES.EVENT_DURATION);
  // The classified event survives so its accepted decision stays bound to a real
  // event; the ordinary predecessor is folded into it.
  assert.equal(repair.targetEventId, residue.id);
  assert.equal(repair.absorbedEventId, long.id);
  assert.equal(repair.before.start, residue.start);
  assert.equal(repair.after.start, long.start);
  assert.equal(repair.after.end, residue.end);

  const repaired = result.repairedProject;
  assert.equal(repaired.events.some(event => event.id === long.id), false, 'the absorbed rest is gone');
  const survivor = repaired.events.find(event => event.id === residue.id);
  assert.equal(survivor.start, '1');
  assert.equal(survivor.end, '2');
  // Provenance of the absorbed event travels with the survivor.
  assert.deepEqual([...survivor.sourceEventIds].sort(), ['rest-q/official', 'rest-r/official']);
  assert.equal(result.verification.status, 'PASS');

  assert.equal(intervalIdentityKey(identity), result.repairedIntervalKeys[0]);
});

test('TTR-3 a silence-preserving repair leaves the role silence and attack set identical point sets', () => {
  const { candidate } = contiguousRestResidue();
  const result = repairTechnicalTiming(candidate);
  assert.equal(result.status, REPAIR_STATUS.PASS);

  assert.deepEqual(silenceOf(result.repairedProject), silenceOf(candidate), 'silence must be the same point set');
  assert.deepEqual(attackShape(result.repairedProject), attackShape(candidate), 'attacks must be untouched');
});

test('TTR-4 an attack-preserving repair moves no onset, pitch, volume or attack count', () => {
  const { candidate } = earlyReleaseGap();
  const result = repairTechnicalTiming(candidate);
  assert.equal(result.status, REPAIR_STATUS.PASS);

  assert.deepEqual(attackShape(result.repairedProject), attackShape(candidate));
  const notesBefore = candidate.events.filter(event => event.kind === 'note').length;
  const notesAfter = result.repairedProject.events.filter(event => event.kind === 'note').length;
  assert.equal(notesAfter, notesBefore, 'no attack invented or deleted');
});

test('TTR-5 the input project is never mutated and the repaired candidate is a distinct, inspectable project', () => {
  const { a, candidate } = earlyReleaseGap();
  const snapshot = JSON.stringify(candidate);

  const result = repairTechnicalTiming(candidate);
  assert.equal(JSON.stringify(candidate), snapshot, 'the source-faithful input is untouched');

  const repaired = result.repairedProject;
  assert.notEqual(repaired.id, candidate.id);
  assert.equal(result.baselineProjectId, candidate.id);
  assert.equal(repaired.metadata.technicalTimingRepair.appliedToProjectId, candidate.id);
  assert.deepEqual([...repaired.metadata.technicalTimingRepair.repairedIntervalKeys], [...result.repairedIntervalKeys]);

  // MOBILE_SYNTAX §11 step 8 — the pre-repair timing is still recoverable from
  // the repaired candidate itself, not only from the result object.
  const provenance = repaired.events.find(event => event.id === a.id).metadata.technicalTimingRepair;
  assert.equal(provenance.before.end, a.end);
  assert.equal(provenance.after.end, '1');
  assert.equal(provenance.delta, RESIDUE.toString());
  assert.deepEqual(provenance.canonical, EFFECTIVE_RULESET.canonical);
  assert.equal(result.repairs[0].reversal.restore.end, a.end);

  // The Source-Faithful Baseline is copied through untouched, so the repair shows
  // up in the baseline diff rather than hiding from it.
  assert.equal(repaired.metadata.sourceFaithfulBaseline.snapshot.events.find(event => event.id === a.id).end, a.end);
});

// ---------------------------------------------------------------------------
// 6–13. Must not repair
// ---------------------------------------------------------------------------

test('TTR-6 a source-supported articulation gap is preserved and never presented for repair', () => {
  const { identity, candidate } = earlyReleaseGap({ classify: 'keep' });
  const enforcement = enforceMicroGaps(candidate);
  assert.equal(enforcement.status, 'PASS');
  assert.deepEqual([...enforcement.preservedIntervalKeys], [intervalIdentityKey(identity)]);

  const result = repairTechnicalTiming(candidate);
  assert.equal(result.presentedCount, 0, 'a preserved interval is never a repair candidate');
  assert.deepEqual([...result.repairedIntervalKeys], []);
  assert.equal(result.repairedProject, null, 'no transformed candidate is produced');
  assert.deepEqual([...result.preservedIntervalKeys], [intervalIdentityKey(identity)]);
  // Preserved sub-grid material is provably unrepresentable in Final; the repair
  // layer says so instead of quietly making the candidate look emittable.
  assert.equal(result.finalEmissionEligible, false);
  assert.ok(codes(result).includes(REPAIR_DIAGNOSTICS.PRESERVED_INTERVAL_PRESENT));
});

test('TTR-7 a source-supported musical rest is never shortened, absorbed or filled', () => {
  // A deliberate sub-grid breath between two phrases, backed by the official
  // score, sitting where a repair would otherwise be able to reach it.
  const before = note({ id: 'breath-a', start: 0, end: 1 });
  const breath = rest({ id: 'breath-r', start: 1, end: f(1).add(NEAR_GRID) });
  const after = note({ id: 'breath-b', pitch: 62, start: f(1).add(NEAR_GRID), end: 2 });
  const identity = durationIdentity(breath);
  const candidate = project({ events: [before, breath, after], decisions: [keepDecision(identity)] });

  const result = repairTechnicalTiming(candidate);
  assert.equal(result.presentedCount, 0);
  assert.equal(result.repairedProject, null);
  assert.deepEqual([...result.preservedIntervalKeys], [intervalIdentityKey(identity)]);
});

test('TTR-8 two adjacent repeated attacks stay two attacks; nothing becomes a tie or a sustain', () => {
  // Same pitch, technical hole between them — the exact shape a "tie it together"
  // optimizer would collapse. MOBILE_SYNTAX §8 forbids that.
  const first = note({ id: 'rep-a', pitch: 60, start: 0, end: f(1).sub(RESIDUE) });
  const second = note({ id: 'rep-b', pitch: 60, start: 1, end: 2 });
  const identity = gapIdentity(first, second);
  const candidate = project({ events: [first, second], decisions: [technicalDecision(identity)] });

  const result = repairTechnicalTiming(candidate);
  assert.equal(result.status, REPAIR_STATUS.PASS);

  const repaired = result.repairedProject;
  const attacks = repaired.events.filter(event => event.kind === 'note');
  assert.equal(attacks.length, 2, 'the two repeated attacks are still two events');
  assert.equal(attacks.find(event => event.id === 'rep-a').end, '1');
  assert.equal(attacks.find(event => event.id === 'rep-b').start, '1', 'the second attack did not move');
  assert.deepEqual(attackShape(repaired), attackShape(candidate));
});

test('TTR-9 unknown provenance is blocked, never repaired', () => {
  const { identity, candidate } = earlyReleaseGap({ classify: 'none' });
  const enforcement = enforceMicroGaps(candidate);
  assert.equal(enforcement.status, 'PENDING');
  assert.deepEqual([...enforcement.blockedIntervalKeys], [intervalIdentityKey(identity)]);

  const result = repairTechnicalTiming(candidate);
  assert.equal(result.status, REPAIR_STATUS.PENDING);
  assert.equal(result.presentedCount, 0);
  assert.equal(result.repairedProject, null);
  assert.equal(result.finalEmissionEligible, false);
  assert.ok(codes(result).includes(REPAIR_DIAGNOSTICS.BLOCKED_INTERVAL_PRESENT));
});

test('TTR-10 unresolved stream identity keeps the repair layer from clearing anything', () => {
  // A role-null span sitting within one safe-grid unit of an assigned one: the
  // analyzer cannot establish the relationship, so nothing may be acted on.
  const assigned = note({ id: 'stream-a', start: 0, end: 1 });
  const floating = createCanonicalNoteEvent({
    id: 'stream-b', pitch: 64, start: f(1).add(RESIDUE).toString(), end: '2',
    role: null, sourceIds: ['third'], sourceEventIds: ['stream-b/third'],
  });
  const candidate = project({ events: [assigned, floating], sources: [OFFICIAL, THIRD_PARTY] });

  const enforcement = enforceMicroGaps(candidate);
  assert.ok(enforcement.unresolvedStreamIssueCount > 0);

  const result = repairTechnicalTiming(candidate);
  assert.equal(result.status, REPAIR_STATUS.PENDING);
  assert.equal(result.repairedProject, null);
  assert.equal(result.finalEmissionEligible, false);
  assert.ok(codes(result).includes(REPAIR_DIAGNOSTICS.VERIFICATION_NOT_CLEAR));
});

test('TTR-11 a gap of exactly 1/64 is not sub-grid and is never presented for repair', () => {
  const a = note({ id: 'edge-a', start: 0, end: f(1).sub(EXACT_GRID) });
  const b = note({ id: 'edge-b', pitch: 62, start: 1, end: 2 });
  assert.equal(f(b.start).sub(f(a.end)).cmp(SAFE_GRID), 0, 'the fixture sits exactly on the grid');
  const candidate = project({ events: [a, b], decisions: [technicalDecision(gapIdentity(a, b))] });

  const enforcement = enforceMicroGaps(candidate);
  assert.equal(enforcement.status, 'PASS');
  assert.deepEqual([...enforcement.rejectedIntervalKeys], []);

  const result = repairTechnicalTiming(candidate);
  assert.equal(result.presentedCount, 0);
  assert.equal(result.repairedProject, null, 'exactly-on-grid timing is not a sub-grid violation');
  assert.ok(codes(result).includes(REPAIR_DIAGNOSTICS.NOT_REQUIRED));
});

test('TTR-12 an interval longer than 1/64 is never presented for repair', () => {
  const a = note({ id: 'wide-a', start: 0, end: f(1).sub(EXACT_GRID).sub(RESIDUE) });
  const b = note({ id: 'wide-b', pitch: 62, start: 1, end: 2 });
  assert.equal(f(b.start).sub(f(a.end)).cmp(SAFE_GRID) > 0, true);
  const candidate = project({ events: [a, b], decisions: [technicalDecision(gapIdentity(a, b))] });

  const result = repairTechnicalTiming(candidate);
  assert.equal(result.presentedCount, 0);
  assert.equal(result.repairedProject, null);
});

test('TTR-13 unrelated normal timing is reported as needing nothing and is returned unchanged', () => {
  const candidate = project({ events: [note({ id: 'plain-a', start: 0, end: 1 }), note({ id: 'plain-b', pitch: 62, start: 1, end: 2 })] });

  const result = repairTechnicalTiming(candidate);
  assert.equal(result.status, REPAIR_STATUS.PASS);
  assert.equal(result.presentedCount, 0);
  assert.equal(result.repairedProject, null);
  assert.equal(result.finalEmissionEligible, true);
  assert.ok(codes(result).includes(REPAIR_DIAGNOSTICS.NOT_REQUIRED));
});

// ---------------------------------------------------------------------------
// 14–24. Fail-closed behaviour
// ---------------------------------------------------------------------------

test('TTR-14 a residue whose float image equals the grid is still repaired exactly, not rounded', () => {
  const { candidate } = earlyReleaseGap({ residue: NEAR_GRID });
  assert.equal(f(NEAR_GRID.toString()).num(), EXACT_GRID.num(), 'the doubles are identical, so only exact rational can separate them');

  const result = repairTechnicalTiming(candidate);
  assert.equal(result.status, REPAIR_STATUS.PASS);
  const [repair] = result.repairs;
  assert.equal(repair.delta, NEAR_GRID.toString());
  assert.equal(repair.after.end, '1');
  // A rounding repair would have produced the grid value; exact arithmetic did not.
  assert.notEqual(repair.delta, EXACT_GRID.toString());
});

test('TTR-15 a sub-grid note duration has no unique neutral repair and is refused', () => {
  const short = note({ id: 'short-a', start: 0, end: RESIDUE });
  const following = note({ id: 'short-b', pitch: 62, start: RESIDUE, end: 1 });
  const identity = durationIdentity(short);
  const candidate = project({ events: [short, following], decisions: [technicalDecision(identity)] });

  const result = repairTechnicalTiming(candidate);
  assert.equal(result.status, REPAIR_STATUS.PENDING);
  assert.equal(result.presentedCount, 1);
  assert.deepEqual([...result.repairedIntervalKeys], []);
  assert.deepEqual([...result.unrepairedIntervalKeys], [intervalIdentityKey(identity)]);
  assert.equal(result.unrepaired[0].reason, REPAIR_UNSUPPORTED.NOTE_DURATION_RESIDUE);
  assert.equal(result.repairedProject, null, 'nothing is emitted from a refused repair');
  assert.equal(result.finalEmissionEligible, false);
  assert.ok(codes(result).includes(REPAIR_DIAGNOSTICS.UNSUPPORTED_INTERVAL));
});

test('TTR-16 a sub-grid rest after a note is refused rather than folded into the note sustain', () => {
  const sounding = note({ id: 'fold-a', start: 0, end: 1 });
  const residue = rest({ id: 'fold-r', start: 1, end: f(1).add(RESIDUE) });
  const next = note({ id: 'fold-b', pitch: 62, start: f(1).add(RESIDUE), end: 2 });
  const identity = durationIdentity(residue);
  const candidate = project({ events: [sounding, residue, next], decisions: [technicalDecision(identity)] });

  const result = repairTechnicalTiming(candidate);
  assert.equal(result.status, REPAIR_STATUS.PENDING);
  assert.equal(result.unrepaired[0].reason, REPAIR_UNSUPPORTED.REST_DURATION_WITHOUT_PRECEDING_REST);
  assert.equal(result.repairedProject, null);
});

test('TTR-17 an ambiguous boundary refuses rather than picking one of two spans', () => {
  // Two Melody spans end at the same instant. Extending one of them leaves the
  // other behind, so there is no single repair target.
  const first = note({ id: 'amb-a', start: 0, end: f(1).sub(RESIDUE) });
  const second = note({ id: 'amb-b', pitch: 64, start: '1/2', end: f(1).sub(RESIDUE) });
  const later = note({ id: 'amb-c', pitch: 62, start: 1, end: 2 });
  const identity = gapIdentity(first, later);
  const candidate = project({ events: [first, second, later], decisions: [technicalDecision(identity)] });

  const result = repairTechnicalTiming(candidate);
  assert.equal(result.status, REPAIR_STATUS.PENDING);
  assert.equal(result.repairedProject, null);
  assert.equal(result.unrepaired[0].reason, REPAIR_UNSUPPORTED.AMBIGUOUS_BOUNDARY);
});

test('TTR-18 two repairs that would write the same event are both refused rather than ordered', () => {
  // A sub-grid rest `r` that is both the duration residue coalescing with the
  // rest before it and the left boundary of the hole after it. Both repairs
  // write `r`, so the outcome would depend on which ran first. Neither runs.
  const opening = note({ id: 'lock-n', start: 0, end: 1 });
  const q = rest({ id: 'lock-q', start: 1, end: f(2).sub(RESIDUE).sub(RESIDUE) });
  const r = rest({ id: 'lock-r', start: f(2).sub(RESIDUE).sub(RESIDUE), end: f(2).sub(RESIDUE) });
  const closing = note({ id: 'lock-m', pitch: 62, start: 2, end: 3 });
  const candidate = project({
    events: [opening, q, r, closing],
    decisions: [technicalDecision(durationIdentity(r)), technicalDecision(gapIdentity(r, closing))],
  });

  const result = repairTechnicalTiming(candidate);
  assert.equal(result.presentedCount, 2);
  assert.equal(result.status, REPAIR_STATUS.PENDING);
  assert.deepEqual([...result.repairedIntervalKeys], []);
  assert.equal(result.unrepaired.length, 2);
  assert.ok(result.unrepaired.every(item => item.reason === REPAIR_UNSUPPORTED.INTERACTING_REPAIRS));
  assert.equal(result.repairedProject, null);
});

test('TTR-18b two holes that write different events are both repaired, in one deterministic pass', () => {
  // The neighbouring case that must NOT be refused: a hole before `mid` and a
  // hole after it write `left` and `mid` respectively, so they are independent.
  const left = note({ id: 'chain-a', start: 0, end: f(1).sub(RESIDUE) });
  const mid = note({ id: 'chain-b', pitch: 62, start: 1, end: f(2).sub(RESIDUE) });
  const right = note({ id: 'chain-c', pitch: 64, start: 2, end: 3 });
  const candidate = project({
    events: [left, mid, right],
    decisions: [technicalDecision(gapIdentity(left, mid)), technicalDecision(gapIdentity(mid, right))],
  });

  const result = repairTechnicalTiming(candidate);
  assert.equal(result.status, REPAIR_STATUS.PASS);
  assert.equal(result.repairs.length, 2);
  assert.equal(result.repairedProject.events.find(event => event.id === 'chain-a').end, '1');
  assert.equal(result.repairedProject.events.find(event => event.id === 'chain-b').end, '2');
  assert.deepEqual(attackShape(result.repairedProject), attackShape(candidate));
  // Deterministic: the same input produces the same repaired candidate every run.
  assert.equal(JSON.stringify(repairTechnicalTiming(candidate).repairedProject), JSON.stringify(result.repairedProject));
});

test('TTR-19 an absorbed event that an arbitration decision references is never removed', () => {
  const { long, residue, identity, candidate: base } = contiguousRestResidue();
  const bound = createArbitrationDecision({
    id: 'other:rest-q',
    eventIds: [long.id],
    action: 'harmony:keep',
    status: 'accepted',
    reason: 'Recorded elsewhere in the arbitration trail.',
    evidence: ['review note'],
  });
  const candidate = createCanonicalProject({
    ...base,
    id: `${base.id}-bound`,
    sources: [...base.sources],
    events: [...base.events],
    tempoEvents: [...base.tempoEvents],
    decisions: [...base.decisions, bound],
    metadata: base.metadata,
  });

  const result = repairTechnicalTiming(candidate);
  assert.equal(result.status, REPAIR_STATUS.PENDING);
  assert.equal(result.unrepaired[0].reason, REPAIR_UNSUPPORTED.DECISION_BOUND_REMOVAL);
  assert.equal(result.repairedProject, null);
  assert.equal(intervalIdentityKey(identity), result.unrepairedIntervalKeys[0]);
  assert.equal(residue.id, 'rest-r');
});

test('TTR-20 a stale enforcement report is fatal, not a worklist', () => {
  const { candidate } = earlyReleaseGap();
  const stale = enforceMicroGaps(contiguousRestResidue().candidate);

  const result = repairTechnicalTiming(candidate, { enforcement: stale });
  assert.equal(result.status, REPAIR_STATUS.FAIL);
  assert.ok(codes(result).includes(REPAIR_DIAGNOSTICS.ENFORCEMENT_STALE));
  assert.equal(result.repairedProject, null);
  assert.equal(result.finalEmissionEligible, false);
});

test('TTR-21 a rejected key with no intact technical-residue record is fatal', () => {
  const { candidate } = earlyReleaseGap();
  const real = enforceMicroGaps(candidate);

  // Same fingerprint-visible shape, but one rejected key no longer has a record.
  const invented = { ...real, rejectedIntervalKeys: Object.freeze([...real.rejectedIntervalKeys, 'not-a-real-key']) };
  const result = repairTechnicalTiming(candidate, { enforcement: invented });
  // The fingerprint check sees the extra key first, which is the stronger refusal.
  assert.equal(result.status, REPAIR_STATUS.FAIL);
  assert.equal(result.repairedProject, null);
});

test('TTR-22a the rejected-record reader admits nothing it cannot verify', () => {
  const { candidate } = earlyReleaseGap();
  const real = enforceMicroGaps(candidate);
  const [key] = real.rejectedIntervalKeys;
  const [record] = real.enforcement;

  // The honest report is admitted whole.
  const clean = readRejectedTechnicalRecords(real);
  assert.deepEqual(clean.malformed, []);
  assert.equal(clean.records.length, 1);
  assert.equal(clean.records[0].identityKey, key);

  const reject = (enforcement, why) => {
    const result = readRejectedTechnicalRecords({ rejectedIntervalKeys: [key], enforcement });
    assert.deepEqual(result.records, [], why);
    assert.equal(result.malformed.length, 1, why);
    assert.equal(result.malformed[0].identityKey, key);
  };

  // A rejected key with no record at all.
  reject([], 'a rejected key with no enforcement record is never acted on');
  // A record that is not technical residue, however the reject list labels it.
  reject([{ ...record, classification: MICRO_TIMING_CLASSIFICATIONS.SOURCE_SUPPORTED_MICROTIMING }],
    'a source-supported record on the reject list is refused, not repaired');
  reject([{ ...record, classification: MICRO_TIMING_CLASSIFICATIONS.UNKNOWN }],
    'an unproven record on the reject list is refused, not repaired');
  // A record carrying the wrong Final outcome.
  reject([{ ...record, enforcement: 'preserve-source-supported' }],
    'a preserve outcome on the reject list is refused');
  // A missing identity, and an identity that no longer encodes to its own key.
  reject([{ ...record, identity: null }], 'a record with no interval identity is refused');
  reject([{ ...record, identity: { ...record.identity, length: undefined, start: '0', end: '1/1024' } }],
    'an identity that does not encode to its own key is refused');

  // Exactly-on-grid timing is not a sub-grid violation. A rejected record that is
  // not below the grid means the analyzer and this layer disagree about the grid
  // itself, which is a contradiction to refuse rather than a repair to perform.
  const onGrid = createIntervalIdentity({
    type: INTERVAL_TYPES.INTER_EVENT_GAP,
    previousEventId: 'grid-a',
    nextEventId: 'grid-b',
    start: '0',
    end: SAFE_GRID.toString(),
  });
  const onGridKey = intervalIdentityKey(onGrid);
  const onGridResult = readRejectedTechnicalRecords({
    rejectedIntervalKeys: [onGridKey],
    enforcement: [{ ...record, identityKey: onGridKey, identity: onGrid, length: onGrid.length, eventIds: ['grid-a', 'grid-b'] }],
  });
  assert.deepEqual(onGridResult.records, [], 'an exactly-on-grid interval is never admitted for repair');
  assert.equal(onGridResult.malformed.length, 1);
  assert.match(onGridResult.malformed[0].reason, /not below the analyzer safe grid/);

  // One safe-grid unit finer than the grid is admitted, so the comparison is a
  // strict boundary and not a blanket refusal.
  const belowGrid = createIntervalIdentity({
    type: INTERVAL_TYPES.INTER_EVENT_GAP,
    previousEventId: 'grid-a',
    nextEventId: 'grid-b',
    start: '0',
    end: SAFE_GRID.sub(new F(1, 10n ** 20n)).toString(),
  });
  const belowKey = intervalIdentityKey(belowGrid);
  const belowResult = readRejectedTechnicalRecords({
    rejectedIntervalKeys: [belowKey],
    enforcement: [{ ...record, identityKey: belowKey, identity: belowGrid, length: belowGrid.length, eventIds: ['grid-a', 'grid-b'] }],
  });
  assert.deepEqual(belowResult.malformed, []);
  assert.equal(belowResult.records.length, 1);
});

test('TTR-22 a malformed enforcement record is refused before any repair is planned', () => {
  const { candidate } = earlyReleaseGap();
  const real = enforceMicroGaps(candidate);
  const [key] = real.rejectedIntervalKeys;

  // A record whose classification no longer matches the reject list it appears
  // on: the repair layer will not take the list's word for it.
  const tampered = {
    ...real,
    enforcement: Object.freeze(real.enforcement.map(item => (item.identityKey === key
      ? { ...item, classification: MICRO_TIMING_CLASSIFICATIONS.SOURCE_SUPPORTED_MICROTIMING }
      : item))),
  };
  assert.equal(repairTechnicalTiming(candidate, { enforcement: tampered }).status, REPAIR_STATUS.FAIL);

  // Same again for an identity edited underneath an unchanged key. The supplied
  // report is never read for its content — it is compared, structured identity
  // included — so this is caught as a report that does not describe the project.
  const reKeyed = {
    ...real,
    enforcement: Object.freeze(real.enforcement.map(item => (item.identityKey === key
      ? { ...item, identity: { ...item.identity, start: '0', end: '1/1024' } }
      : item))),
  };
  const result = repairTechnicalTiming(candidate, { enforcement: reKeyed });
  assert.equal(result.status, REPAIR_STATUS.FAIL);
  assert.ok(codes(result).includes(REPAIR_DIAGNOSTICS.ENFORCEMENT_STALE));
  assert.equal(result.repairedProject, null);
});

test('TTR-23 a non-conformant Final contract stops the repair layer instead of being repaired around', () => {
  const { candidate } = earlyReleaseGap();
  const relaxed = { ...EFFECTIVE_RULESET.mobileSyntax, rejectTechnicalMicroGapsBelow64: false };

  const result = repairTechnicalTiming(candidate, { mobileSyntax: relaxed });
  assert.equal(result.status, REPAIR_STATUS.PENDING);
  assert.ok(codes(result).includes(REPAIR_DIAGNOSTICS.POLICY_NON_CONFORMANT));
  assert.equal(result.repairedProject, null);
  assert.equal(result.finalEmissionEligible, false);

  // A mismatched safe denominator is equally fatal: the contract does not get to
  // hand the repair layer a different grid.
  const wrongGrid = { ...EFFECTIVE_RULESET.mobileSyntax, shortestSafeDenominator: 32 };
  assert.equal(repairTechnicalTiming(candidate, { mobileSyntax: wrongGrid }).status, REPAIR_STATUS.PENDING);
});

test('TTR-24 a mixed worklist repairs only what it can and never reports PASS for the rest', () => {
  // One repairable hole in Melody, one refused sub-grid note duration in Chord1.
  const a = note({ id: 'mix-a', start: 0, end: f(1).sub(RESIDUE) });
  const b = note({ id: 'mix-b', pitch: 62, start: 1, end: 2 });
  const shortNote = note({ id: 'mix-c', pitch: 64, role: 'Chord1', start: 0, end: RESIDUE });
  const afterShort = note({ id: 'mix-d', pitch: 65, role: 'Chord1', start: RESIDUE, end: 1 });
  const gap = gapIdentity(a, b);
  const shortDuration = durationIdentity(shortNote);
  const candidate = project({
    events: [a, b, shortNote, afterShort],
    decisions: [technicalDecision(gap), technicalDecision(shortDuration)],
  });

  const result = repairTechnicalTiming(candidate);
  assert.equal(result.presentedCount, 2);
  assert.deepEqual([...result.repairedIntervalKeys], [intervalIdentityKey(gap)]);
  assert.deepEqual([...result.unrepairedIntervalKeys], [intervalIdentityKey(shortDuration)]);
  // The repairable half really was repaired...
  assert.equal(result.repairedProject.events.find(event => event.id === 'mix-a').end, '1');
  // ...and the result is still not PASS, and still not Final-eligible.
  assert.equal(result.status, REPAIR_STATUS.PENDING);
  assert.equal(result.finalEmissionEligible, false);
  assert.equal(result.verification.status, 'FAIL');
  assert.equal(result.verification.rejectedIntervalKeys.length, 1);
});

test('TTR-25 presented keys always partition into repaired and unrepaired', () => {
  const fixtures = [
    earlyReleaseGap().candidate,
    contiguousRestResidue().candidate,
    project({ events: [note({ id: 'p-a', start: 0, end: RESIDUE }), note({ id: 'p-b', pitch: 62, start: RESIDUE, end: 1 })] }),
  ];
  for (const candidate of fixtures) {
    const result = repairTechnicalTiming(candidate);
    const partition = [...result.repairedIntervalKeys, ...result.unrepairedIntervalKeys].sort();
    assert.deepEqual(partition, [...result.presentedIntervalKeys].sort(), 'no presented interval may vanish');
    if (result.status === REPAIR_STATUS.PASS) {
      assert.deepEqual([...result.unrepairedIntervalKeys], [], 'PASS requires an empty unrepaired list');
      assert.equal(result.verification.rejectedIntervalKeys.length, 0, 'PASS requires enforcement to agree');
    }
  }
});

test('TTR-26 the repair layer never rewrites the Tempo Map, the sources or the decision record', () => {
  const { candidate } = earlyReleaseGap();
  const result = repairTechnicalTiming(candidate);
  const repaired = result.repairedProject;

  assert.deepEqual(JSON.parse(JSON.stringify(repaired.tempoEvents)), JSON.parse(JSON.stringify(candidate.tempoEvents)));
  assert.deepEqual(JSON.parse(JSON.stringify(repaired.meterEvents)), JSON.parse(JSON.stringify(candidate.meterEvents)));
  assert.deepEqual(JSON.parse(JSON.stringify(repaired.sources)), JSON.parse(JSON.stringify(candidate.sources)));
  assert.deepEqual(JSON.parse(JSON.stringify(repaired.decisions)), JSON.parse(JSON.stringify(candidate.decisions)));
});

test('TTR-28 boundary resolution is exact, so timings a float cannot separate stay separate', () => {
  // Two Melody spans end one part in 10^20 apart. Their doubles are identical, so
  // an epsilon or float comparison sees one boundary where there are two — and
  // would report the repair target as ambiguous, or worse, extend the wrong span.
  const hair = new F(1, 10n ** 20n);
  const early = note({ id: 'exact-a', start: 0, end: f(1).sub(RESIDUE) });
  const late = note({ id: 'exact-a2', pitch: 64, start: '1/2', end: f(1).sub(RESIDUE).add(hair) });
  const next = note({ id: 'exact-b', pitch: 62, start: 1, end: 2 });
  assert.equal(f(early.end).num(), f(late.end).num(), 'the two ends are the same double');
  assert.notEqual(early.end, late.end, 'and different exact rationals');

  const identity = gapIdentity(late, next);
  const candidate = project({ events: [early, late, next], decisions: [technicalDecision(identity)] });

  const result = repairTechnicalTiming(candidate);
  assert.equal(result.status, REPAIR_STATUS.PASS, 'exactly one span ends at the hole, so the target is unambiguous');
  assert.equal(result.repairs.length, 1);
  assert.equal(result.repairs[0].targetEventId, late.id, 'the later-ending span is the one extended');
  assert.equal(result.repairs[0].after.end, '1');
  // The span that ends a hair earlier is untouched, not swept up by a tolerance.
  assert.equal(result.repairedProject.events.find(event => event.id === early.id).end, early.end);
});

test('TTR-27 the result carries the published Canonical identity and claims no acceptance', () => {
  const { candidate } = earlyReleaseGap();
  const result = repairTechnicalTiming(candidate);

  assert.deepEqual(result.canonical, EFFECTIVE_RULESET.canonical);
  assert.equal(result.safeGrid, SAFE_GRID.toString());
  assert.ok(/never implies IN_GAME_ACCEPTED/.test(result.notice));
  assert.ok(/does not make a song VALIDATED/.test(result.notice));
});
