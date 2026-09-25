// Machine delivery READY implies the Final emitter emits: a differential
// property over generated projects, the evaluator's contract, and the mutants
// the catch-all has to kill.
//
//   skip the check                 -> the property and the refusal cases fail
//   check with other options       -> the options pin and the listen-first /
//                                     restatement / registry cases fail
//   treat PENDING as ready         -> the PENDING cases fail
//   record it beside other blockers-> "identical answer" fails for blocked songs
//   ask while a pre-game gate still
//   stops delivery                 -> the no-authority case fails
//   emit twice in finalize         -> the single-emission spy fails
//
// Fixed seed, small projects, well under 30 s.
import test from 'node:test';
import assert from 'node:assert/strict';
import { F, f } from '../backend/mml/index.mjs';
import {
  createSource,
  createCanonicalNoteEvent,
  createCanonicalTempoEvent,
  createCanonicalProject,
} from '../backend/canonical/index.mjs';
import { evaluateProjectReadiness } from '../backend/final/readiness.mjs';
import { emitFinalMml } from '../backend/final/mml-emitter.mjs';
import {
  FINAL_EMISSION_CODES,
  FINAL_EMISSION_GATE,
  MACHINE_DELIVERY_GATE_NAMES,
  MACHINE_DELIVERY_SCHEMA_V1,
  MACHINE_DELIVERY_SCHEMA_V2,
  MAX_FINAL_EMISSION_DIAGNOSTICS,
  deliveryBlockingGates,
  evaluateMachineDelivery,
  isEmittedFinal,
  machineDeliveryEmitOptions,
} from '../backend/final/delivery-evaluator.mjs';
import * as finalFacade from '../backend/final/index.mjs';
import { createStudioApplication } from '../backend/application/index.mjs';
import { FIXTURE_CONFIRMATIONS, projectWithSymbolicAsset, runDecisionsFor, sixRoleBaseline } from './fixtures/run-fixtures.mjs';

const identity = (version, schema, status = 'PUBLISHED') => Object.freeze({ canonical_version: version, canonical_status: status, rules_snapshot_sha: 'e'.repeat(40), machine_delivery_schema: schema });
const AT1 = identity('2026-09-23-v2', MACHINE_DELIVERY_SCHEMA_V1);
const AT2 = identity('2026-09-23-v3', MACHINE_DELIVERY_SCHEMA_V2);
const UNPUBLISHED = identity('2026-09-23-v3', MACHINE_DELIVERY_SCHEMA_V2, 'CANDIDATE');

const OFFICIAL = createSource({ id: 'official', label: 'Official score', kind: 'official-musicxml', authority: 'primary-symbolic' });
const PITCH = { Melody: 72, Chord1: 64, Chord2: 48 };
const note = (start, end, id, role) => createCanonicalNoteEvent({ id, pitch: PITCH[role], start: String(start), end: String(end), role, voice: role, volume: null, sourceIds: ['official'] });
const tempo = (id, beat, bpm) => createCanonicalTempoEvent({ id, beat: String(beat), bpm, sourceIds: ['official'] });
const readinessOf = (project, canonical, extra = {}) => evaluateProjectReadiness({
  project,
  mmlValidation: { ok: true, errors: [] },
  core3Report: { status: 'PASS', blockers: [] },
  core3CompletenessReport: { status: 'PASS', blockers: [] },
  harmonyReport: { status: 'PASS', unresolvedCount: 0 },
  originalAudioRequired: false,
  playerReadback: 'NOT_RUN',
  mobileAdaptation: 'PENDING',
  regressionReviewed: false,
  canonical,
  ...extra,
});
const entryOf = projection => projection.blocking.find(item => item.gate === FINAL_EMISSION_GATE) ?? null;

// ── generated projects ──────────────────────────────────────────────────────

function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Positions in beats: mostly on the grid, some a tick or two short of it
// (sub-grid material G10 grades), some at caution denominators (triplets,
// 1/24) G10 lets through and the bounded search may not write.
function generate(seed) {
  const random = mulberry32(seed);
  const pick = list => list[Math.floor(random() * list.length)];
  const nudge = beat => {
    const roll = random();
    if (roll < 0.1) return f(beat).sub(new F(1, 480));
    if (roll < 0.16) return f(beat).sub(new F(2, 480));
    if (roll < 0.24) return f(beat).add(new F(pick([1, 2]), 3));
    if (roll < 0.28) return f(beat).add(new F(1, 24));
    return f(beat);
  };
  const roles = ['Melody', 'Chord1', 'Chord2'].slice(0, 1 + Math.floor(random() * 3));
  const events = [];
  for (const role of roles) {
    let cursor = 0;
    const count = 1 + Math.floor(random() * 3);
    for (let index = 0; index < count; index += 1) {
      const start = index === 0 && random() < 0.8 ? f(0) : nudge(cursor + Math.floor(random() * 2));
      const length = pick([1, 1, 2, 0.5, 0.25]);
      let end = nudge(f(start).add(f(String(length))).toString());
      if (end.cmp(start) <= 0) end = f(start).add(f(1));
      if (start.cmp(f(cursor)) < 0) continue;
      events.push(note(start.toString(), end.toString(), `${role.toLowerCase()}-${index}`, role));
      cursor = Math.ceil(Number(end.n) / Number(end.d));
    }
  }
  const tempi = [tempo('t0', 0, 120)];
  if (random() < 0.3) tempi.push(tempo('t1', nudge(1 + Math.floor(random() * 2)).toString(), random() < 0.5 ? 120 : 90));
  // A release that drifted from its baseline, with no release record: the
  // candidate's last note of a role ends a tick short of the grid, its
  // baseline's a 1/32 beat after its start.
  let baselineEvents = events;
  if (random() < 0.15 && events.length) {
    const last = events[events.length - 1];
    const drifted = createCanonicalNoteEvent({ ...last, end: f(last.end).sub(new F(1, 480)).toString() });
    if (f(drifted.end).cmp(f(drifted.start)) > 0) {
      events[events.length - 1] = drifted;
      baselineEvents = events.map(event => (event.id === last.id ? createCanonicalNoteEvent({ ...last, end: f(last.start).add(new F(1, 32)).toString() }) : event));
    }
  }
  const snapshot = createCanonicalProject({ id: `gen-${seed}:baseline`, title: 'generated', sources: [OFFICIAL], events: baselineEvents, tempoEvents: tempi });
  return createCanonicalProject({ id: `gen-${seed}`, title: 'generated', sources: [OFFICIAL], events, tempoEvents: tempi, metadata: { sourceComplete: true, sourceFaithfulBaseline: { snapshot } } });
}

test('property (seed 20260925): delivery READY implies the emitter emits, and every candidate it emits keeps its delivery answer', () => {
  const started = Date.now();
  const tally = { readyEmitted: 0, refusedByEmitterOnly: 0, blockedByGates: 0, blockedAndRefused: 0 };
  const refusedCodes = new Set();
  for (let seed = 20260925; seed < 20260925 + 160; seed += 1) {
    const project = generate(seed);
    for (const canonical of [AT1, AT2]) {
      const label = `seed ${seed} ${canonical.machine_delivery_schema}`;
      const readiness = readinessOf(project, canonical);
      // Today's answer: the gate map alone.
      const gatesOnly = evaluateMachineDelivery(readiness.gates, { canonical });
      const emitted = emitFinalMml(project, machineDeliveryEmitOptions(readiness, { canonical }));

      if (readiness.machineDelivery.ready) assert.ok(isEmittedFinal(emitted), `${label}: READY while the emitter says ${emitted.status}`);
      if (isEmittedFinal(emitted)) {
        assert.deepEqual(readiness.machineDelivery, gatesOnly, `${label}: an emitted candidate keeps its answer`);
        if (gatesOnly.ready) tally.readyEmitted += 1;
        continue;
      }
      if (gatesOnly.projection_ready) {
        const entry = entryOf(readiness.machineDelivery);
        assert.ok(entry, `${label}: refused and everything else ready`);
        assert.equal(readiness.machineDelivery.ready, false, label);
        assert.deepEqual(entry.blockers, [emitted.status === 'PENDING' ? FINAL_EMISSION_CODES.PENDING : FINAL_EMISSION_CODES.REFUSED], label);
        assert.deepEqual(entry.emitter_diagnostics, emitted.diagnostics, label);
        assert.deepEqual(readiness.machineDelivery.unresolved_evidence_ledger.filter(item => item.gate !== FINAL_EMISSION_GATE), gatesOnly.unresolved_evidence_ledger, label);
        for (const item of emitted.diagnostics) if (item.severity === 'error') refusedCodes.add(item.code);
        tally.refusedByEmitterOnly += 1;
      } else {
        // Something else already blocks: the answer is exactly what it was.
        assert.deepEqual(readiness.machineDelivery, gatesOnly, `${label}: nothing added beside another blocker`);
        tally.blockedAndRefused += 1;
      }
    }
  }
  // Blocked candidates the emitter would have written are counted too.
  for (let seed = 20260925; seed < 20260925 + 160; seed += 1) {
    const readiness = readinessOf(generate(seed), AT2);
    if (!evaluateMachineDelivery(readiness.gates, { canonical: AT2 }).projection_ready) tally.blockedByGates += 1;
  }
  // The generator reaches every region the property speaks about.
  if (process.env.FINAL_EMISSION_TALLY) console.log(JSON.stringify({ ...tally, refusedCodes: [...refusedCodes] }));
  assert.ok(tally.readyEmitted >= 20, JSON.stringify(tally));
  assert.ok(tally.refusedByEmitterOnly >= 10, JSON.stringify(tally));
  assert.ok(tally.blockedByGates >= 10, JSON.stringify(tally));
  assert.ok(refusedCodes.has('BOUNDARY_NOT_FINAL_REPRESENTABLE'), [...refusedCodes].join(','));
  assert.ok(Date.now() - started < 30000, `took ${Date.now() - started} ms`);
});

// ── the evaluator's contract ────────────────────────────────────────────────

const completeGates = (overrides = {}) => ({ ...Object.fromEntries(MACHINE_DELIVERY_GATE_NAMES.map(name => [name, { status: 'PASS' }])), ...overrides });
const DIAGNOSTIC = Object.freeze({ code: 'BOUNDARY_NOT_FINAL_REPRESENTABLE', severity: 'error', message: 'verbatim', positions: Object.freeze(['479/480']), completenessProven: true });

test('only an emitted Final is one: FAIL, PENDING, a PASS without MML and nothing at all are refusals', () => {
  assert.equal(isEmittedFinal({ status: 'PASS', combinedMml: 'MML@c;' }), true);
  for (const result of [{ status: 'PASS' }, { status: 'PASS', combinedMml: '' }, { status: 'FAIL', combinedMml: 'MML@c;' }, { status: 'PENDING', combinedMml: 'MML@c;' }, {}, null, undefined, 'PASS']) {
    assert.equal(isEmittedFinal(result), false, JSON.stringify(result));
  }
  const cases = [
    [{ status: 'FAIL', diagnostics: [DIAGNOSTIC] }, 'FAIL', FINAL_EMISSION_CODES.REFUSED],
    [{ status: 'PENDING', diagnostics: [DIAGNOSTIC] }, 'PENDING', FINAL_EMISSION_CODES.PENDING],
    [{ status: 'PASS', diagnostics: [] }, 'FAIL', FINAL_EMISSION_CODES.REFUSED],
    [{}, 'FAIL', FINAL_EMISSION_CODES.REFUSED],
  ];
  for (const [finalEmission, status, code] of cases) {
    const result = evaluateMachineDelivery(completeGates(), { canonical: AT2, requireCompleteGateMap: true, finalEmission });
    assert.equal(result.ready, false, JSON.stringify(finalEmission));
    assert.equal(result.projection_ready, false);
    assert.equal(result.lifecycle, 'CANDIDATE');
    const entry = entryOf(result);
    assert.equal(entry.classification, 'BLOCKING');
    assert.equal(entry.status, status, 'PENDING is said as PENDING, never PASS');
    assert.deepEqual(entry.blockers, [code]);
    assert.equal(entry.emitter_status, finalEmission.status ?? null);
    assert.deepEqual(entry.emitter_diagnostics, finalEmission.diagnostics ?? []);
  }
  // Verbatim: the very objects the emitter returned.
  const refused = entryOf(evaluateMachineDelivery(completeGates(), { canonical: AT2, finalEmission: { status: 'FAIL', diagnostics: [DIAGNOSTIC] } }));
  assert.equal(refused.emitter_diagnostics[0], DIAGNOSTIC);
  // An emitted Final adds nothing: the answer is the gate map's.
  const emitted = evaluateMachineDelivery(completeGates(), { canonical: AT2, finalEmission: { status: 'PASS', combinedMml: 'MML@c;', diagnostics: [] } });
  assert.deepEqual(emitted, evaluateMachineDelivery(completeGates(), { canonical: AT2 }));
  assert.equal(emitted.ready, true);
});

test('the entry is recorded only when nothing but technical blocks, and never changes another entry', () => {
  const refusal = { status: 'FAIL', diagnostics: [DIAGNOSTIC] };
  // Another blocker: the answer is exactly the one without the emission.
  for (const overrides of [{ source: { status: 'PENDING', blockers: ['SOURCE_COMPLETENESS_NOT_CONFIRMED'] } }, { microTiming: { status: 'FAIL', blockers: ['MICRO_TIMING_TECHNICAL_RESIDUE_PRESENT'] } }]) {
    const withEmission = evaluateMachineDelivery(completeGates(overrides), { canonical: AT2, finalEmission: refusal });
    assert.deepEqual(withEmission, evaluateMachineDelivery(completeGates(overrides), { canonical: AT2 }));
    assert.equal(entryOf(withEmission), null);
  }
  // An incomplete gate map is a blocker too.
  const partial = { source: { status: 'PASS' } };
  assert.equal(entryOf(evaluateMachineDelivery(partial, { canonical: AT2, requireCompleteGateMap: true, finalEmission: refusal })), null);
  // After a refusal nothing was emitted, so technical is NOT_RUN: the refusal
  // is still recorded, beside it.
  const notRun = evaluateMachineDelivery(completeGates({ technical: { status: 'NOT_RUN' } }), { canonical: AT2, finalEmission: refusal });
  assert.deepEqual(notRun.blocking.map(item => item.gate), ['technical', FINAL_EMISSION_GATE]);
  assert.deepEqual(notRun.blocking[0], evaluateMachineDelivery(completeGates({ technical: { status: 'NOT_RUN' } }), { canonical: AT2 }).blocking[0]);
  // Listen-first entries keep their phase and flag beside a refusal.
  const listenFirst = { status: 'PENDING', blockers: ['LEAD_PROMOTION_EVIDENCE_REQUIRED', 'LEAD_PROMOTION_PRIMARY_EVIDENCE_MISSING'], unverifiedLeadEventIds: ['x'] };
  const flagged = evaluateMachineDelivery(completeGates({ leadPromotion: listenFirst }), { canonical: AT2, finalEmission: refusal });
  assert.equal(flagged.non_blocking_pending[0].gate, 'leadPromotion');
  assert.deepEqual(flagged.blocking.map(item => item.gate), [FINAL_EMISSION_GATE]);
});

test('the emitter\'s diagnostics are bounded with their true count', () => {
  const many = Array.from({ length: MAX_FINAL_EMISSION_DIAGNOSTICS + 7 }, (_, index) => ({ ...DIAGNOSTIC, index }));
  const entry = entryOf(evaluateMachineDelivery(completeGates(), { canonical: AT2, finalEmission: { status: 'FAIL', diagnostics: many } }));
  assert.equal(entry.emitter_diagnostics.length, MAX_FINAL_EMISSION_DIAGNOSTICS);
  assert.equal(entry.emitter_diagnostic_count, many.length);
  assert.equal(entry.emitter_diagnostics_truncated, true);
  assert.deepEqual(entry.emitter_diagnostics, many.slice(0, MAX_FINAL_EMISSION_DIAGNOSTICS));
});

test('delivery blocks on the refusal with or without machine-delivery authority', () => {
  const project = createCanonicalProject({ id: 'tempo', title: 't', sources: [OFFICIAL], events: [note(0, 4, 'm', 'Melody'), note(0, 4, 'c', 'Chord1')], tempoEvents: [tempo('t0', 0, 120), tempo('t1', f(2).sub(new F(1, 480)).toString(), 90)] });
  const candidate = createCanonicalProject({ ...project, metadata: { sourceComplete: true, sourceFaithfulBaseline: { snapshot: project } } });
  const informational = readinessOf(candidate, UNPUBLISHED, { playerReadback: 'N/A', mobileAdaptation: 'PASS', regressionReviewed: true });
  assert.equal(informational.machineDelivery.authoritative, false);
  assert.deepEqual([...informational.preGameBlocking], [], 'every pre-game gate passes');
  assert.equal(informational.songState, 'VALIDATED', 'the song state is the gates\' answer and is not rewritten');
  assert.deepEqual(deliveryBlockingGates(informational), [FINAL_EMISSION_GATE], 'but nothing is delivered');
  const authoritative = readinessOf(candidate, AT2, { playerReadback: 'N/A', mobileAdaptation: 'PASS', regressionReviewed: true });
  assert.deepEqual(deliveryBlockingGates(authoritative), [FINAL_EMISSION_GATE]);
});

// ── the readiness wiring ────────────────────────────────────────────────────

const clean = () => {
  const project = createCanonicalProject({ id: 'clean', title: 'c', sources: [OFFICIAL], events: [note(0, 1, 'a', 'Melody'), note(0, 4, 'c', 'Chord1')], tempoEvents: [tempo('t0', 0, 120)] });
  return createCanonicalProject({ ...project, metadata: { sourceComplete: true, sourceFaithfulBaseline: { snapshot: project } } });
};

test('readiness asks once, only when it is the last question, with the report as it stands, and fails closed on no answer', () => {
  const project = clean();
  const asked = [];
  const record = before => { asked.push(before); return emitFinalMml(project, machineDeliveryEmitOptions(before, { canonical: AT2 })); };
  const ready = readinessOf(project, AT2, { emitFinal: record });
  assert.equal(asked.length, 1);
  assert.equal(ready.machineDelivery.ready, true);
  assert.equal(asked[0].machineDelivery.ready, true, 'handed the report before its own answer');
  assert.deepEqual(asked[0].gates, ready.gates);

  // Not asked while another gate blocks, nor before emission (technical NOT_RUN).
  asked.length = 0;
  readinessOf(project, AT2, { emitFinal: record, harmonyReport: { status: 'PENDING', unresolvedCount: 1 } });
  readinessOf(project, AT2, { emitFinal: record, mmlValidation: null });
  assert.equal(asked.length, 0);

  // An emission already in hand is used, never repeated.
  const inHand = emitFinalMml(project, {});
  readinessOf(project, AT2, { emitFinal: record, finalEmission: inHand });
  assert.equal(asked.length, 0);

  // An emission that answers nothing is no Final.
  for (const nothing of [() => undefined, () => null]) {
    const silent = readinessOf(project, AT2, { emitFinal: nothing });
    assert.equal(silent.machineDelivery.ready, false);
    assert.deepEqual(entryOf(silent.machineDelivery).blockers, [FINAL_EMISSION_CODES.REFUSED]);
  }
  assert.throws(() => readinessOf(project, AT2, { emitFinal: 'yes' }), /emitFinal must be a function/);
});

test('without machine-delivery authority the emitter is not asked while a pre-game gate still stops delivery', () => {
  // Delivery then keys on the pre-game gates, and the emitter refuses past any
  // of them (READINESS_BLOCKED). The candidate-policy ledger can still be
  // projection_ready -- Mobile adaptation, regression and player readback wait
  // there -- so asking would only record that restatement as a
  // FINAL_EMISSION_PENDING about a Final the emitter writes.
  const project = clean();
  const asked = [];
  const record = before => { asked.push(before); return emitFinalMml(project, machineDeliveryEmitOptions(before, { canonical: UNPUBLISHED })); };
  for (const extra of [{}, { emitFinal: record }]) {
    const informational = readinessOf(project, UNPUBLISHED, extra);
    assert.equal(informational.machineDelivery.authoritative, false);
    assert.deepEqual([...informational.preGameBlocking], ['playerReadback', 'mobileAdaptation', 'regression']);
    assert.equal(informational.machineDelivery.projection_ready, true, 'the candidate policy alone would deliver it');
    assert.deepEqual(informational.machineDelivery, evaluateMachineDelivery(informational.gates, { canonical: UNPUBLISHED }), 'no entry is recorded');
    assert.deepEqual(deliveryBlockingGates(informational), ['playerReadback', 'mobileAdaptation', 'regression']);
  }
  assert.equal(asked.length, 0, 'not asked');
  // Once nothing stops delivery it is asked, and this candidate is one it writes.
  const answered = readinessOf(project, UNPUBLISHED, { emitFinal: record, playerReadback: 'N/A', mobileAdaptation: 'PASS', regressionReviewed: true });
  assert.equal(asked.length, 1);
  assert.equal(entryOf(answered.machineDelivery), null);
  assert.deepEqual(deliveryBlockingGates(answered), []);
});

test('the emitter does not read its own refusal back out of a readiness report', () => {
  const project = clean();
  const plain = readinessOf(project, AT2);
  const refused = readinessOf(project, AT2, { finalEmission: { status: 'FAIL', diagnostics: [DIAGNOSTIC] } });
  assert.deepEqual(deliveryBlockingGates(refused), [FINAL_EMISSION_GATE]);
  const withRefusal = emitFinalMml(project, machineDeliveryEmitOptions(refused, { canonical: AT2 }));
  const withoutRefusal = emitFinalMml(project, machineDeliveryEmitOptions(plain, { canonical: AT2 }));
  assert.equal(withRefusal.status, 'PASS', 'no circular READINESS_BLOCKED on its own answer');
  assert.deepEqual(withRefusal.diagnostics, withoutRefusal.diagnostics);
  assert.equal(withRefusal.combinedMml, withoutRefusal.combinedMml);
});

test('machine delivery\'s emit options are one definition, exported where the Final service reads them', () => {
  assert.equal(finalFacade.machineDeliveryEmitOptions, machineDeliveryEmitOptions);
  const listenFirst = { status: 'PENDING', blockers: ['MICRO_TIMING_CLASSIFICATION_UNKNOWN', 'MICRO_TIMING_RELEASE_NOT_FINAL_REPRESENTABLE', 'MICRO_TIMING_RELEASE_EVIDENCE_REQUIRED', 'MICRO_TIMING_RELEASE_PROVISIONAL'] };
  const readinessUnder = (canonical, overrides = {}) => ({ machineDelivery: evaluateMachineDelivery(completeGates(overrides), { canonical }) });
  const cases = [
    [readinessUnder(AT2, { microTiming: listenFirst }), true, true],
    [readinessUnder(AT2), false, true],
    [readinessUnder(AT1, { microTiming: listenFirst }), false, false],
    [readinessUnder(UNPUBLISHED, { microTiming: listenFirst }), false, false],
  ];
  for (const [readiness, provisional, collapse] of cases) {
    const options = machineDeliveryEmitOptions(readiness, { releaseEvidenceRegistry: 'registry', technicalTimingRepair: true });
    assert.equal(options.readiness, readiness);
    assert.equal(options.provisionalReleaseRendering, provisional);
    assert.equal(options.collapseTempoRestatements, collapse);
    assert.equal(options.technicalTimingRepair, true, 'the repair stays the caller\'s opt-in');
    assert.equal(options.releaseEvidenceRegistry, 'registry');
    assert.equal(options.canonical, null, 'null is the loaded release');
  }
  assert.equal(machineDeliveryEmitOptions(cases[0][0]).technicalTimingRepair, false);
});

// ── the Final service emits once, with those options ───────────────────────

test('finalize emits exactly once, with machine delivery\'s options, and hands that emission to readiness', async () => {
  const OWNER = 'owner:final-emission-spy';
  const engines = await createStudioApplication({}).canonical.engines();
  const emissions = [];
  const readinessInputs = [];
  const app = createStudioApplication({
    loadEngines: async () => ({
      ...engines,
      final: {
        ...engines.final,
        emitFinalMml: (project, options = {}) => {
          const result = engines.final.emitFinalMml(project, options);
          emissions.push({ options, result });
          return result;
        },
        evaluateProjectReadiness: input => {
          readinessInputs.push(input);
          return engines.final.evaluateProjectReadiness(input);
        },
      },
    }),
  });
  const own = await projectWithSymbolicAsset(app, OWNER, { project: sixRoleBaseline() });
  await app.analyzeSources(OWNER, own.projectId, { assetIds: [own.assetId] });
  const candidateId = (await app.applyDecisions(OWNER, own.projectId, { decisions: runDecisionsFor(own.project) })).decisions.candidate_id;
  emissions.length = 0;
  readinessInputs.length = 0;
  const result = await app.finalize(OWNER, own.projectId, { candidateId, confirmations: FIXTURE_CONFIRMATIONS, technicalTimingRepair: true });
  assert.equal(result.operation, 'succeeded', JSON.stringify(result.blockers));
  assert.equal(emissions.length, 1, 'one emission');
  const [{ options, result: emitted }] = emissions;
  const expected = machineDeliveryEmitOptions(options.readiness, { technicalTimingRepair: true, releaseEvidenceRegistry: options.releaseEvidenceRegistry });
  assert.deepEqual({ ...options }, { ...expected }, 'the options are machine delivery\'s own');
  // Before emission readiness has nothing to ask; after it, it is handed the
  // emission instead of emitting a second time.
  assert.equal(readinessInputs.length, 2);
  assert.equal(readinessInputs[0].mmlValidation, null);
  assert.equal(readinessInputs[0].finalEmission, undefined);
  assert.equal(readinessInputs[1].finalEmission, emitted);
  assert.equal(result.mml, emitted.combinedMml);
  assert.equal(entryOf(result.machine_delivery), null);
});
