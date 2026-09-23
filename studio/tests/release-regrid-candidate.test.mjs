// UNPUBLISHED CANONICAL CANDIDATE regressions: sub-grid systematic release offset.
//
// These pin the candidate described in
// docs/canonical-candidates/SUBGRID_RELEASE_OFFSET.md. They do not pin a
// Published rule: Published 2026-09-13-v1 does not decide this case, so the
// most important assertions below are the fail-closed ones — a project produced
// by the candidate is refused by Published-v1 micro-gap enforcement, readiness
// and the Final emitter.
//
// Every timing assertion is exact rational.
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
  MICRO_TIMING_KEEP_ACTION,
  createIntervalIdentity,
  analyzeProjectMicroTiming,
} from '../backend/canonical/micro-timing.mjs';
import {
  RELEASE_REGRID_CANDIDATE,
  REGRID_REFUSAL,
  CANDIDATE_MARKER_KEY,
  analyzeReleaseOffsetPattern,
  planReleaseRegrid,
  applyReleaseRegridCandidate,
  reverseReleaseRegridCandidate,
  verifyReleaseRegridInvariants,
  isReleaseRegridCandidateActive,
} from '../backend/canonical/release-regrid-candidate.mjs';
import { enforceMicroGaps, MICRO_GAP_BLOCKERS } from '../backend/final/micro-gap-enforcement.mjs';
import { emitFinalMml } from '../backend/final/mml-emitter.mjs';
import { verifyFinalReadback } from '../backend/final/round-trip.mjs';
import { EFFECTIVE_RULESET } from '../backend/rules/index.mjs';
import { SUPPORTED_CANONICAL_VERSIONS } from '../backend/rules/supported-releases.mjs';

const TICK = new F(1, 480);
const SRC = createSource({ id: 'midi', label: 'Third-party MIDI', kind: 'third-party-midi', authority: 'supporting' });
const OTHER = createSource({ id: 'other', label: 'Second MIDI', kind: 'third-party-midi', authority: 'supporting' });

let counter = 0;
const nextId = prefix => `${prefix}-${++counter}`;
// A note whose release is one source tick before `nominalEnd` (the captured real-song shape).
const short = ({ pitch = 60, start, nominalEnd, role = 'Melody', sourceId = 'midi', id = nextId('n'), ticks = 480 }) => createCanonicalNoteEvent({
  id, pitch, start: String(start), end: f(nominalEnd).sub(new F(1, ticks)).toString(), role, voice: role,
  sourceIds: [sourceId], sourceEventIds: [`${id}/on`, `${id}/off`], metadata: { ticksPerQuarter: ticks },
});
const exact = ({ pitch = 60, start, end, role = 'Melody', sourceId = 'midi', id = nextId('n') }) => createCanonicalNoteEvent({
  id, pitch, start: String(start), end: String(end), role, voice: role,
  sourceIds: [sourceId], sourceEventIds: [`${id}/on`, `${id}/off`], metadata: { ticksPerQuarter: 480 },
});
const tempo = () => createCanonicalTempoEvent({ id: nextId('t'), beat: '0', bpm: 120, sourceIds: ['midi'] });
const project = ({ events, decisions = [], sources = [SRC] }) => createCanonicalProject({
  id: nextId('song'), title: 'candidate fixture', sources, events, tempoEvents: [tempo()], decisions,
});
const eventById = (p, id) => p.events.find(e => e.id === id);
const stripMarkers = p => createCanonicalProject({
  ...p,
  metadata: Object.fromEntries(Object.entries(p.metadata).filter(([k]) => k !== CANDIDATE_MARKER_KEY)),
  events: p.events.map(e => (e.kind === 'note' ? createCanonicalNoteEvent : createCanonicalRestEvent)({
    ...e, metadata: Object.fromEntries(Object.entries(e.metadata ?? {}).filter(([k]) => k !== CANDIDATE_MARKER_KEY)),
  })),
});

test('RRC-1 the candidate is unpublished and inactive for the loaded Published release', () => {
  assert.equal(RELEASE_REGRID_CANDIDATE.status, 'UNPUBLISHED_CANONICAL_CANDIDATE');
  assert.deepEqual([...RELEASE_REGRID_CANDIDATE.activeInCanonicalVersions], []);
  assert.equal(isReleaseRegridCandidateActive(EFFECTIVE_RULESET.canonical.canonical_version), false);
  // No release this implementation supports activates it, v2 included.
  for (const version of SUPPORTED_CANONICAL_VERSIONS) assert.equal(isReleaseRegridCandidateActive(version), false, version);
});

test('RRC-2 a one-tick note-preceded gap closes by extending the release exactly one tick; attacks untouched', () => {
  const a = short({ start: 0, nominalEnd: 1 });
  const b = short({ start: 1, nominalEnd: 2, pitch: 62 });
  const p = project({ events: [a, b] });
  assert.equal(analyzeProjectMicroTiming(p).unknownCount, 1, 'the original carries one UNKNOWN interval');
  const r = applyReleaseRegridCandidate(p);
  assert.equal(r.status, 'CANDIDATE_ONLY');
  assert.deepEqual([...r.violations], []);
  assert.equal(eventById(r.project, a.id).end, '1');
  assert.equal(eventById(r.project, b.id).end, '2');
  assert.equal(eventById(r.project, b.id).start, '1', 'following onset never moves');
  assert.equal(r.plans.find(x => x.eventId === a.id).effect, 'sub-grid-gap-closed');
  assert.equal(f(r.plans[0].delta).cmp(TICK), 0);
  assert.equal(analyzeProjectMicroTiming(r.project).unknownCount, 0);
});

test('RRC-3 Published-v1 enforcement, readiness input and the Final emitter refuse the candidate project', () => {
  const p = project({ events: [short({ start: 0, nominalEnd: 1 }), short({ start: 1, nominalEnd: 2 })] });
  const r = applyReleaseRegridCandidate(p);
  const enforcement = enforceMicroGaps(r.project);
  assert.equal(enforcement.status, 'PENDING');
  assert.ok(enforcement.blockers.includes(MICRO_GAP_BLOCKERS.UNPUBLISHED_CANONICAL_CANDIDATE));
  const emitted = emitFinalMml(r.project);
  assert.notEqual(emitted.status, 'PASS');
  assert.equal(emitted.combinedMml, null);
  // Stripping the project-level marker is not enough: event-level markers remain.
  const partial = createCanonicalProject({ ...r.project, metadata: {} });
  assert.ok(enforceMicroGaps(partial).blockers.includes(MICRO_GAP_BLOCKERS.UNPUBLISHED_CANONICAL_CANDIDATE));
  // An unmarked project keeps its old blocker list exactly.
  assert.ok(!enforceMicroGaps(p).blockers.includes(MICRO_GAP_BLOCKERS.UNPUBLISHED_CANONICAL_CANDIDATE));
});

test('RRC-4 a true source rest survives: shortened by exactly one tick, never removed', () => {
  const a = short({ start: 0, nominalEnd: 1 });
  const b = short({ start: 2, nominalEnd: 3 }); // rest of 1 beat + 1 tick before b
  const r = applyReleaseRegridCandidate(project({ events: [a, b] }));
  const plan = r.plans.find(x => x.eventId === a.id);
  assert.equal(plan.effect, 'following-rest-shortened-by-delta');
  assert.equal(f(plan.followingSilenceBefore).cmp(f(1).add(TICK)), 0);
  assert.equal(plan.followingSilenceAfter, '1');
  assert.equal(f(eventById(r.project, b.id).start).cmp(f(eventById(r.project, a.id).end)), 1, 'the rest still exists');
});

test('RRC-5 a rest that would fall below the safe grid is refused, not shortened', () => {
  // A 1/64 whole-note rest (1/16 beat) exactly, measured from the off-grid release: after one tick it would be sub-grid.
  const a = short({ start: 0, nominalEnd: 1 });
  const b = createCanonicalNoteEvent({ id: nextId('n'), pitch: 64, start: f(1).sub(TICK).add(SAFE_GRID).toString(), end: '3', role: 'Melody', voice: 'Melody', sourceIds: ['other'], sourceEventIds: ['x'] });
  const r = applyReleaseRegridCandidate(project({ events: [a, b], sources: [SRC, OTHER] }));
  assert.ok(r.refusals.some(x => x.eventId === a.id && x.reason === REGRID_REFUSAL.REST_WOULD_BECOME_SUB_GRID));
  assert.equal(eventById(r.project, a.id).end, a.end, 'refused release is untouched');
});

test('RRC-6 repeated same-pitch attacks survive as separate attacks and are never tied', () => {
  const a = short({ start: 0, nominalEnd: 1, pitch: 60 });
  const b = short({ start: 1, nominalEnd: 2, pitch: 60 });
  const r = applyReleaseRegridCandidate(project({ events: [a, b] }));
  assert.equal(r.project.events.length, 2);
  assert.equal(eventById(r.project, a.id).end, eventById(r.project, b.id).start, 'abutting, not merged');
  const emitted = emitFinalMml(stripMarkers(r.project));
  assert.equal(emitted.status, 'PASS', JSON.stringify(emitted.diagnostics.map(d => d.code)));
  const melody = emitted.roles.find(x => x.role === 'Melody');
  assert.equal(melody.attacks, 2, 'two note-ons, not one sustain');
  assert.ok(!melody.mml.includes('&'), `no tie may hide the repeated attack: ${melody.mml}`);
});

test('RRC-7 same-pitch continuation vs reattack: an existing single sustain stays one attack', () => {
  const sustained = exact({ start: 0, end: 2, pitch: 60 });
  const reattack = short({ start: 2, nominalEnd: 3, pitch: 60 });
  const r = applyReleaseRegridCandidate(project({ events: [sustained, reattack] }));
  const emitted = emitFinalMml(stripMarkers(r.project));
  assert.equal(emitted.status, 'PASS', JSON.stringify(emitted.diagnostics.map(d => d.code)));
  assert.equal(emitted.roles.find(x => x.role === 'Melody').attacks, 2);
  assert.equal(eventById(r.project, sustained.id).end, '2', 'an on-grid release is never touched');
});

test('RRC-8 extension never crosses a same-role onset and never introduces a same-pitch overlap', () => {
  const a = short({ start: 0, nominalEnd: 1, pitch: 60 });
  // A same-role onset inside (release, release + tick) is impossible on-grid,
  // so use a second source whose onset is off-grid by half a tick.
  const b = createCanonicalNoteEvent({ id: nextId('n'), pitch: 67, start: f(1).sub(new F(1, 960)).toString(), end: '2', role: 'Melody', voice: 'Melody', sourceIds: ['other'], sourceEventIds: ['y'] });
  const r = applyReleaseRegridCandidate(project({ events: [a, b], sources: [SRC, OTHER] }));
  assert.ok(r.refusals.some(x => x.eventId === a.id && x.reason === REGRID_REFUSAL.EXTENSION_CROSSES_ONSET));

  const c = short({ start: 0, nominalEnd: 1, pitch: 60, role: 'Chord1' });
  const d = exact({ start: '1/2', end: 3, pitch: 60, role: 'Chord1', sourceId: 'other' });
  const r2 = applyReleaseRegridCandidate(project({ events: [c, d], sources: [SRC, OTHER] }));
  assert.ok(r2.refusals.some(x => x.eventId === c.id && x.reason === REGRID_REFUSAL.SAME_PITCH_OVERLAP));
});

test('RRC-9 a non-uniform source is refused as a whole; nothing is regridded', () => {
  const events = [
    short({ start: 0, nominalEnd: 1 }),
    short({ start: 1, nominalEnd: 2, ticks: 240 }), // two ticks at 480 PPQ: a different offset
    short({ start: 2, nominalEnd: 3 }),
  ];
  const r = applyReleaseRegridCandidate(project({ events }));
  assert.equal(r.plans.length, 0);
  assert.ok(r.refusals.length >= 2);
  assert.ok(r.refusals.every(x => [REGRID_REFUSAL.SOURCE_PATTERN_NOT_UNIFORM, REGRID_REFUSAL.SOURCE_OFFSET_NOT_ONE_TICK].includes(x.reason)));
  const pattern = analyzeReleaseOffsetPattern(project({ events }));
  assert.equal(pattern.sources[0].uniform, false);
});

test('RRC-10 an off-grid onset anywhere in the source refuses the source', () => {
  const events = [short({ start: 0, nominalEnd: 1 }), short({ start: '1/960', nominalEnd: 2 })];
  const pattern = analyzeReleaseOffsetPattern(project({ events }));
  assert.ok(pattern.sources[0].refusals.includes(REGRID_REFUSAL.SOURCE_ONSET_OFF_GRID));
  assert.equal(applyReleaseRegridCandidate(project({ events })).plans.length, 0);
});

test('RRC-11 source-supported articulation is never normalized: any keep decision refuses the release', () => {
  for (const status of ['accepted', 'pending', 'rejected']) {
    const a = short({ start: 0, nominalEnd: 1 });
    const b = short({ start: 1, nominalEnd: 2 });
    const identity = createIntervalIdentity({ type: INTERVAL_TYPES.INTER_EVENT_GAP, previousEventId: a.id, nextEventId: b.id, start: a.end, end: b.start });
    const keep = createArbitrationDecision({ id: nextId('keep'), eventIds: [a.id, b.id], action: MICRO_TIMING_KEEP_ACTION, status, reason: 'articulation', evidence: ['score'], metadata: { intervalIdentity: identity } });
    const r = applyReleaseRegridCandidate(project({ events: [a, b], decisions: [keep] }));
    assert.ok(r.refusals.some(x => x.eventId === a.id && x.reason === REGRID_REFUSAL.KEEP_DECISION_PRESENT), status);
    assert.equal(eventById(r.project, a.id).end, a.end);
  }
});

test('RRC-12 Lead/Core3 events never disappear; per-role counts, ids, pitches and onsets are identical', () => {
  const events = [];
  for (const [role, pitch] of [['Melody', 72], ['Chord1', 64], ['Chord2', 48], ['Chord3', 55]]) {
    for (let beat = 0; beat < 8; beat += 1) events.push(short({ start: beat, nominalEnd: beat + 1, pitch: pitch + (beat % 3), role }));
  }
  const p = project({ events });
  const r = applyReleaseRegridCandidate(p);
  assert.deepEqual([...r.violations], []);
  for (const role of ['Melody', 'Chord1', 'Chord2', 'Chord3']) {
    const before = p.events.filter(e => e.role === role);
    const after = r.project.events.filter(e => e.role === role);
    assert.equal(after.length, before.length, role);
    assert.deepEqual(after.map(e => [e.id, e.pitch, e.start]), before.map(e => [e.id, e.pitch, e.start]), role);
  }
});

test('RRC-13 round trip: the candidate serializes, reads back exactly, and reverses to the original', () => {
  const events = [
    short({ start: 0, nominalEnd: '1/2', pitch: 72 }),
    short({ start: '1/2', nominalEnd: 1, pitch: 72 }),
    short({ start: 1, nominalEnd: 2, pitch: 74 }),
    short({ start: 3, nominalEnd: 4, pitch: 76 }), // preceded by a true one-beat rest
    short({ start: 0, nominalEnd: 2, pitch: 48, role: 'Chord2' }),
    short({ start: 2, nominalEnd: 4, pitch: 43, role: 'Chord2' }),
  ];
  const p = project({ events });
  const r = applyReleaseRegridCandidate(p);
  const emitted = emitFinalMml(stripMarkers(r.project));
  assert.equal(emitted.status, 'PASS', JSON.stringify(emitted.diagnostics.map(d => d.code)));
  assert.equal(emitted.roundTrip.status, 'PASS');
  const back = reverseReleaseRegridCandidate(r.project);
  assert.equal(back.id, p.id);
  assert.deepEqual(back.events.map(e => [e.id, e.start, e.end]), p.events.map(e => [e.id, e.start, e.end]));
  assert.deepEqual(back.events.map(e => e.metadata), p.events.map(e => e.metadata));
});

test('RRC-14 a project already carrying a candidate marker is not transformed twice', () => {
  const r = applyReleaseRegridCandidate(project({ events: [short({ start: 0, nominalEnd: 1 }), short({ start: 1, nominalEnd: 2 })] }));
  const again = planReleaseRegrid(r.project);
  assert.equal(again.plans.length, 0);
  assert.equal(again.refusals[0].reason, REGRID_REFUSAL.ALREADY_MARKED);
});

test('RRC-15 invariant net catches a release moved by anything but delta, an onset move and an invented event', () => {
  const a = short({ start: 0, nominalEnd: 1 });
  const b = short({ start: 1, nominalEnd: 2 });
  const p = project({ events: [a, b] });
  const plans = planReleaseRegrid(p).plans;
  const tampered = { ...p, id: 'x', events: [{ ...a, end: '3/2' }, { ...b, start: '1/2' }, exact({ start: 5, end: 6 })] };
  const v = verifyReleaseRegridInvariants(p, tampered, plans);
  assert.ok(v.some(x => x.startsWith('release-moved-by-other-than-delta')));
  assert.ok(v.some(x => x.startsWith('onset-moved')));
  assert.ok(v.some(x => x.startsWith('event-invented')));
});

test('RRC-16 projects without the pattern are untouched (no drift for existing fixtures)', () => {
  const clean = project({ events: [exact({ start: 0, end: 1 }), exact({ start: 1, end: 2 }), exact({ start: 3, end: 4 })] });
  const r = applyReleaseRegridCandidate(clean);
  assert.equal(r.plans.length, 0);
  assert.deepEqual(r.project.events, clean.events);
  // And the Published-v1 path for the unmarked project is unchanged by this module's existence.
  const before = enforceMicroGaps(clean);
  assert.equal(before.status, 'PASS');
});
