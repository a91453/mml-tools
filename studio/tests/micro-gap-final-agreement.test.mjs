// G10, readiness, machine delivery and the Final emitter agree on micro-timing.
//
// A seeded property test over generated Canonical projects: small roles with
// sub-grid notes, gaps and rests, legato joins, explicit rests, rests that stop
// one 480-tick before a grid onset, first onsets inside and outside the first
// 1/64 of a whole note, and a claim on every analysed sub-grid interval drawn
// from absent, kept with admissible evidence, kept without evidence, kept on a
// third-party source only, pending, rejected and technical. Two focused
// families ride along: a kept sub-grid rest before a technical hole, and a
// role that starts after a silence shorter than any Final token. No Tempo
// change and no baseline snapshot: an off-grid Tempo position and a note that
// drifted from its baseline are refusals G10 does not own
// (FINAL_MML_EMITTER §5, "Scope").
//
// Properties, per project:
//   P1 readiness microTiming republishes G10's status and blockers;
//   P2 MICRO_TIMING_SOURCE_SUPPORTED_NOT_FINAL_REPRESENTABLE is raised exactly
//      when something is preserved, and G10 FAILs only on residue, an
//      invariant violation or an invalid release record;
//   P3 a G10 PASS leaves no analysed interval and no boundary but one inside
//      a silence;
//   P4 a G10 PASS meets no micro-timing refusal on any emitter path;
//   P5 MICRO_GAP_BLOCKED_PENDING carries open questions only, never a proof
//      code, and is never empty;
//   P6 a leading-onset entry is the role's earliest note, in (0, shortest
//      token), not a position classifyPosition refuses, coverage 'none', and
//      it raises the boundary code;
//   P7 whatever an emitter path writes has no leading entry and nothing
//      preserved -- except that the repair path may write a G10 FAIL whose
//      repair left nothing preserved (TECHNICAL_TIMING_REPAIR.md §13);
//   P8 preserved material is BLOCKING under @1 and @2 and never held;
//   P9 a G10 PASS has no role starting after a silence shorter than any Final
//      token.
//
// The seed is fixed, so every run grades the same projects.
import test from 'node:test';
import assert from 'node:assert/strict';
import { f } from '../backend/mml/index.mjs';
import {
  createSource,
  createArbitrationDecision,
  createCanonicalNoteEvent,
  createCanonicalRestEvent,
  createCanonicalTempoEvent,
  createCanonicalProject,
} from '../backend/canonical/index.mjs';
import { MICRO_TIMING_KEEP_ACTION, MICRO_TIMING_TECHNICAL_ACTIONS, createIntervalIdentity } from '../backend/canonical/micro-timing.mjs';
import { POSITION_CLASS, classifyPosition } from '../backend/canonical/release-timing.mjs';
import {
  BOUNDARY_COVERAGE,
  LEADING_ONSET_REASON,
  MICRO_GAP_BLOCKERS,
  SHORTEST_ADMITTED_TOKEN_BEATS,
  enforceMicroGaps,
} from '../backend/final/micro-gap-enforcement.mjs';
import { evaluateProjectReadiness } from '../backend/final/readiness.mjs';
import { emitFinalMml } from '../backend/final/mml-emitter.mjs';
import { EMIT_DIAGNOSTICS } from '../backend/final/emitter-contract.mjs';
import {
  MACHINE_DELIVERY_GATE_NAMES,
  MACHINE_DELIVERY_SCHEMA_V1,
  MACHINE_DELIVERY_SCHEMA_V2,
  evaluateMachineDelivery,
} from '../backend/final/delivery-evaluator.mjs';

const SEED = 0x6d6d6c31;
const PROJECTS = 300;

const NEW = MICRO_GAP_BLOCKERS.SOURCE_SUPPORTED_NOT_FINAL_REPRESENTABLE;
const BOUNDARY = MICRO_GAP_BLOCKERS.BOUNDARY_NOT_FINAL_REPRESENTABLE;
const MICRO_TIMING_REFUSALS = [
  EMIT_DIAGNOSTICS.SOURCE_SUPPORTED_INTERVAL_NOT_REPRESENTABLE,
  EMIT_DIAGNOSTICS.MICRO_GAP_TECHNICAL_RESIDUE,
  EMIT_DIAGNOSTICS.MICRO_GAP_BLOCKED_PENDING,
  EMIT_DIAGNOSTICS.MICRO_GAP_BOUNDARY_NOT_FINAL_REPRESENTABLE,
  EMIT_DIAGNOSTICS.BOUNDARY_NOT_FINAL_REPRESENTABLE,
];

const OFFICIAL = createSource({ id: 'official', label: 'Official score', kind: 'official-musicxml', authority: 'primary-symbolic' });
const THIRD_PARTY = createSource({ id: 'third', label: 'Community MIDI', kind: 'third-party-midi', authority: 'supporting' });
const identityOf = schema => Object.freeze({ canonical_version: 'x', canonical_status: 'PUBLISHED', rules_snapshot_sha: 'f'.repeat(40), machine_delivery_schema: schema });
const PATHS = Object.freeze({
  default: {},
  cautionLengthOptIn: { cautionLengthOptIn: true },
  provisionalReleaseRendering: { provisionalReleaseRendering: true, canonical: identityOf(MACHINE_DELIVERY_SCHEMA_V2) },
  technicalTimingRepair: { technicalTimingRepair: true },
});

// mulberry32: a small deterministic generator.
function mulberry32(seed) {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const FIRST_ONSETS = ['0', '0', '0', '1/480', '1/240', '1/48', '1/24', '1/32', '29/480', '1/12', '1/2'];
const CLEAN_FIRST_ONSETS = ['0', '0', '1/16', '1/12', '1/2', '1'];
const GRID_DURATIONS = ['1', '1', '1/2', '1/4', '3/4', '2'];
const SUB_GRID_DURATIONS = ['1/480', '29/480', '1/48', '1/24', '1/32'];
// Releases one or two 480-ticks off a grid point.
const OFF_GRID_DURATIONS = ['479/480', '481/480', '959/480'];
// What separates two spans: legato or a real rest, or a sub-grid gap.
const GRID_SEPARATIONS = ['0', '0', '1/2', '1'];
const SUB_GRID_SEPARATIONS = ['1/480', '1/240', '1/48', '1/24'];
// Per project: how often a duration or separation is sub-grid, and how often a
// release is off the grid.
// 'export offset' releases one 480-tick short and starts the next span back
// on the grid, the systematic shape the provisional hold is for.
const MODES = [
  { name: 'clean', subGrid: 0, offGrid: 0, offGridDurations: OFF_GRID_DURATIONS },
  { name: 'export offset', subGrid: 0, offGrid: 0.5, offGridDurations: ['479/480', '959/480'], regrid: true },
  { name: 'mixed', subGrid: 0.25, offGrid: 0.15, offGridDurations: OFF_GRID_DURATIONS },
  { name: 'dense', subGrid: 0.5, offGrid: 0.2, offGridDurations: OFF_GRID_DURATIONS },
];
const CLAIMS = ['absent', 'absent', 'kept', 'kept', 'kept without evidence', 'third-party only', 'pending', 'rejected', 'technical'];
const PITCH = { Melody: 72, Chord1: 64, Chord2: 55 };

function note(id, role, start, end, pitch) {
  return createCanonicalNoteEvent({ id, pitch, start: f(start).toString(), end: f(end).toString(), role, voice: role, volume: null, sourceIds: ['official'] });
}
function rest(id, role, start, end) {
  return createCanonicalRestEvent({ id, start: f(start).toString(), end: f(end).toString(), role, voice: role, sourceIds: ['official'] });
}
const ceilGrid = value => {
  const units = f(value).div(f('1/16'));
  const whole = units.n / units.d + (units.n % units.d === 0n ? 0n : 1n);
  return f(`${whole}/16`);
};

function randomEvents(rand) {
  const pick = list => list[Math.floor(rand() * list.length)];
  const mode = pick(MODES);
  const duration = () => (rand() < mode.subGrid ? pick(SUB_GRID_DURATIONS) : rand() < mode.offGrid ? pick(mode.offGridDurations) : pick(GRID_DURATIONS));
  const separation = () => (rand() < mode.subGrid ? pick(SUB_GRID_SEPARATIONS) : pick(GRID_SEPARATIONS));
  const roles = ['Melody', 'Chord1', 'Chord2'].slice(0, 1 + Math.floor(rand() * 3));
  const events = [];
  for (const role of roles) {
    let cursor = f(pick(mode.name === 'clean' ? CLEAN_FIRST_ONSETS : FIRST_ONSETS));
    const tag = role[0] + role.at(-1);
    if (cursor.cmp(0) > 0 && rand() < 0.15) events.push(rest(`${tag}-lead`, role, '0', cursor));
    const count = 2 + Math.floor(rand() * 3);
    for (let i = 0; i < count; i += 1) {
      const id = `${tag}-${i}`;
      if (i && rand() < 0.2) {
        // An explicit rest, sometimes one 480-tick short of the next grid onset.
        const end = rand() < 0.4 ? ceilGrid(cursor.add(f('1/4'))).sub(f('1/480')) : cursor.add(f(duration()));
        events.push(rest(id, role, cursor, end));
        cursor = rand() < 0.5 ? ceilGrid(end) : end;
        continue;
      }
      const end = cursor.add(f(duration()));
      events.push(note(id, role, cursor, end, PITCH[role] + i));
      cursor = (mode.regrid ? ceilGrid(end) : end).add(f(separation()));
    }
  }
  return events;
}

// A kept sub-grid rest before a technical hole, the shape Technical Timing
// Repair can emit after lengthening the rest.
function keptRestBeforeHole(rand) {
  const short = 1 + Math.floor(rand() * 29);
  const restEnd = f(1).add(f(`${short}/480`));
  const next = ceilGrid(restEnd);
  return {
    events: [note('o-a', 'Melody', '0', '1', 72), rest('o-r', 'Melody', '1', restEnd), note('o-b', 'Melody', next, '2', 74)],
    claims: { 'o-r': 'kept', 'o-r>o-b': 'technical' },
  };
}

// A role whose first note starts inside the first 1/64 of a whole note.
function leadingOnset(rand) {
  const pick = list => list[Math.floor(rand() * list.length)];
  const events = [note('l-m', 'Melody', '0', '2', 72)];
  const start = f(pick(['1/24', '1/48', '1/20', '1/240', '1/480', '1/32', '1/16', '1/12']));
  events.push(note('l-c', 'Chord1', start, rand() < 0.5 ? '1' : start.add(f(pick(['1/48', '29/480', '1']))), 64));
  if (rand() < 0.3) events.push(rest('l-r', 'Chord1', '0', start));
  return { events, claims: {} };
}

const claimKeyOf = identity => (identity.type === 'event-duration' ? identity.eventId : `${identity.previousEventId}>${identity.nextEventId}`);
function decisionFor(kind, identity, index) {
  if (kind === 'absent') return null;
  const target = createIntervalIdentity(identity.type === 'event-duration'
    ? { type: identity.type, eventId: identity.eventId, start: identity.start, end: identity.end }
    : { type: identity.type, previousEventId: identity.previousEventId, nextEventId: identity.nextEventId, start: identity.start, end: identity.end });
  const eventIds = identity.type === 'event-duration' ? [identity.eventId] : [identity.previousEventId, identity.nextEventId];
  const base = { id: `claim-${index}`, eventIds, reason: 'generated', metadata: { intervalIdentity: target } };
  if (kind === 'technical') return createArbitrationDecision({ ...base, action: MICRO_TIMING_TECHNICAL_ACTIONS[0], status: 'accepted', evidence: ['converter log'] });
  const keep = (status, evidence, sources) => createArbitrationDecision({
    ...base, action: MICRO_TIMING_KEEP_ACTION, status, evidence, metadata: { ...base.metadata, evidenceSourceIds: sources },
  });
  switch (kind) {
    case 'kept': return keep('accepted', ['official bar 1'], ['official']);
    case 'kept without evidence': return keep('accepted', [], ['official']);
    case 'third-party only': return keep('accepted', ['community MIDI bar 1'], ['third']);
    case 'pending': return keep('pending', ['official bar 1'], ['official']);
    case 'rejected': return keep('rejected', ['official bar 1'], ['official']);
    default: throw Error(`unknown claim ${kind}`);
  }
}

const build = (id, events, decisions = []) => createCanonicalProject({
  id, title: 'agreement fixture', sources: [OFFICIAL, THIRD_PARTY], events,
  tempoEvents: [createCanonicalTempoEvent({ id: 't0', beat: '0', bpm: 120, sourceIds: ['official'] })],
  decisions, metadata: {},
});

function generate(index, rand) {
  const family = index % 6 === 4 ? keptRestBeforeHole(rand) : index % 6 === 5 ? leadingOnset(rand) : { events: randomEvents(rand), claims: null };
  const bare = build(`agreement:${index}`, family.events);
  // A claim on every analysed sub-grid interval, from the family or at random.
  const decisions = enforceMicroGaps(bare).enforcement
    .map((record, n) => decisionFor(family.claims
      ? family.claims[claimKeyOf(record.identity)] ?? 'absent'
      : CLAIMS[Math.floor(rand() * CLAIMS.length)], record.identity, n))
    .filter(Boolean);
  return build(`agreement:${index}`, family.events, decisions);
}

const deliveryOf = (gate, schema) => {
  const gates = { ...Object.fromEntries(MACHINE_DELIVERY_GATE_NAMES.map(name => [name, { status: 'PASS' }])), microTiming: gate };
  const result = evaluateMachineDelivery(gates, { canonical: identityOf(schema), requireCompleteGateMap: true });
  return result.blocking.some(entry => entry.gate === 'microTiming') ? 'BLOCKING' : result.non_blocking_pending.some(entry => entry.gate === 'microTiming') ? 'NON_BLOCKING_PENDING' : 'CLEAR';
};

test('G10, readiness, machine delivery and every emitter path agree on micro-timing over seeded projects', t => {
  const rand = mulberry32(SEED);
  const seen = { g10Pass: 0, preserved: 0, leading: 0, failWithPreserved: 0, emitted: 0, repairedPastPreserved: 0, heldForListening: 0, boundary: 0 };
  for (let index = 0; index < PROJECTS; index += 1) {
    const project = generate(index, rand);
    const label = `project ${index}: ${JSON.stringify(project.events.map(event => [event.id, event.kind, event.role, event.start, event.end]))} ${JSON.stringify(project.decisions.map(item => [item.status, item.action, item.metadata.intervalIdentity.start, item.metadata.intervalIdentity.end]))}`;
    const g10 = enforceMicroGaps(project);
    const preserved = g10.preservedIntervalKeys.length > 0;
    const leading = g10.unsupportedBoundaries.filter(item => item.reason === LEADING_ONSET_REASON);

    // P1: readiness republishes G10.
    const micro = evaluateProjectReadiness({ project }).gates.microTiming;
    assert.deepEqual([micro.status, micro.blockers ?? []], [g10.status, [...g10.blockers]], `P1 ${label}`);

    // P2: the preserved-material code exactly when something is preserved, and
    // FAIL only for residue, an invariant violation or an invalid record.
    assert.equal(g10.blockers.includes(NEW), preserved, `P2 ${label}`);
    if (g10.status === 'FAIL') {
      assert.ok(g10.rejectedIntervalKeys.length
        || g10.blockers.includes(MICRO_GAP_BLOCKERS.ENFORCEMENT_INVARIANT_VIOLATED)
        || g10.blockers.includes(MICRO_GAP_BLOCKERS.RELEASE_RECORD_INVALID), `P2 ${label}`);
    }

    // P3: a PASS leaves nothing analysed and nothing but silence-internal
    // boundaries.
    if (g10.status === 'PASS') {
      assert.deepEqual(g10.enforcement, [], `P3 ${label}`);
      assert.ok(g10.unsupportedBoundaries.every(item => item.coverage === BOUNDARY_COVERAGE.INSIDE_SILENCE), `P3 ${label}`);
      // P9: and no role starts after a silence shorter than any Final token,
      // which the emitter meets only as a search limit, never as a proof.
      for (const role of new Set(project.events.filter(event => event.kind === 'note' && event.role).map(event => event.role))) {
        const first = project.events.filter(event => event.kind === 'note' && event.role === role)
          .map(event => f(event.start)).reduce((min, start) => (start.cmp(min) < 0 ? start : min));
        assert.ok(first.cmp(0) === 0 || first.cmp(SHORTEST_ADMITTED_TOKEN_BEATS) >= 0, `P9 ${role} ${label}`);
      }
    }

    // P6: a leading entry is the role's earliest note, strictly inside
    // (0, shortest token), not a position classifyPosition refuses, never
    // decided by anything, and it raises the boundary code.
    for (const entry of leading) {
      const notes = project.events.filter(event => event.kind === 'note' && event.role === entry.role)
        .sort((a, b) => f(a.start).cmp(b.start) || (a.id < b.id ? -1 : 1));
      assert.equal(notes[0].id, entry.eventId, `P6 ${label}`);
      assert.ok(f(entry.position).cmp(0) > 0 && f(entry.position).cmp(SHORTEST_ADMITTED_TOKEN_BEATS) < 0, `P6 ${label}`);
      assert.notEqual(classifyPosition(entry.position), POSITION_CLASS.NOT_FINAL_REPRESENTABLE, `P6 ${label}`);
      assert.equal(entry.coverage, BOUNDARY_COVERAGE.NONE, `P6 ${label}`);
      assert.ok(g10.blockers.includes(BOUNDARY), `P6 ${label}`);
    }

    // P8: preserved material blocks under every schema and is never held.
    const d1 = deliveryOf({ status: micro.status, blockers: micro.blockers }, MACHINE_DELIVERY_SCHEMA_V1);
    const d2 = deliveryOf({ status: micro.status, blockers: micro.blockers }, MACHINE_DELIVERY_SCHEMA_V2);
    if (preserved) {
      assert.deepEqual([d1, d2], ['BLOCKING', 'BLOCKING'], `P8 ${label}`);
      assert.equal(g10.blockers.includes(MICRO_GAP_BLOCKERS.RELEASE_PROVISIONAL), false, `P8 ${label}`);
    }

    for (const [path, options] of Object.entries(PATHS)) {
      const emitted = emitFinalMml(project, options);
      const codes = emitted.diagnostics.map(item => item.code);
      // P4: a G10 PASS never meets a micro-timing refusal G10 owns.
      if (g10.status === 'PASS') {
        assert.deepEqual(codes.filter(code => MICRO_TIMING_REFUSALS.includes(code)), [], `P4 ${path} ${label}`);
      }
      // P5: the pending diagnostic carries open questions only, never a proof,
      // and is never empty.
      for (const item of emitted.diagnostics.filter(entry => entry.code === EMIT_DIAGNOSTICS.MICRO_GAP_BLOCKED_PENDING)) {
        assert.ok(item.blockers.length > 0, `P5 ${path} ${label}`);
        assert.equal(item.blockers.includes(NEW), false, `P5 ${path} ${label}`);
        assert.equal(item.blockers.includes(BOUNDARY), false, `P5 ${path} ${label}`);
      }
      // P7: what the emitter writes, G10 does not refuse on these grounds.
      if (emitted.status === 'PASS') {
        seen.emitted += 1;
        assert.equal(leading.length, 0, `P7 ${path} ${label}`);
        if (path === 'technicalTimingRepair') {
          const repairedPast = preserved && g10.status === 'FAIL' && emitted.technicalTimingRepair?.applied === true
            && emitted.microGap.preservedIntervalKeys.length === 0;
          assert.ok(!preserved || repairedPast, `P7 ${path} ${label}`);
          if (repairedPast) seen.repairedPastPreserved += 1;
        } else {
          assert.equal(preserved, false, `P7 ${path} ${label}`);
        }
      }
    }

    if (g10.status === 'PASS') seen.g10Pass += 1;
    if (preserved) seen.preserved += 1;
    if (preserved && g10.status === 'FAIL') seen.failWithPreserved += 1;
    if (leading.length) seen.leading += 1;
    if (g10.blockers.includes(BOUNDARY)) seen.boundary += 1;
    if (d2 === 'NON_BLOCKING_PENDING') seen.heldForListening += 1;
  }
  t.diagnostic(`seed ${SEED}, ${PROJECTS} projects: ${JSON.stringify(seen)}`);
  // The generator reaches every shape the properties are about.
  for (const [key, minimum] of Object.entries({ g10Pass: 20, preserved: 40, leading: 10, failWithPreserved: 5, emitted: 40, repairedPastPreserved: 3, heldForListening: 5, boundary: 20 })) {
    assert.ok(seen[key] >= minimum, `coverage: ${key} ${seen[key]} < ${minimum} (${JSON.stringify(seen)})`);
  }
});
