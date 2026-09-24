// G10 — onsets and rest boundaries no admitted Final token sequence can reach.
//
// `canonical/release-timing.mjs#classifyPosition` proves a position
// NOT_FINAL_REPRESENTABLE when its whole-note denominator does not divide the
// lcm of every admitted Final token denominator: no sum of admitted token
// lengths lands there. A Final role is written as consecutive tokens from beat 0,
// so a role whose note starts or ends there, or which ends there, cannot be
// written at all.
//
// The interval analyzer (`canonical/micro-timing.mjs`) only sees such a
// boundary when it ends a sub-grid interval. A role's first off-grid onset, an
// off-grid onset after a rest of at least the grid, a legato join at an
// off-grid point and an off-grid role end leave no interval, so G10 and the
// readiness `microTiming` gate reported PASS, and the emitter then failed with
// DURATION_SEARCH_POLICY_LIMIT, "not proof that no exact token decomposition
// exists", although the proof was already in hand. These pin the fix: G10
// raises MICRO_TIMING_BOUNDARY_NOT_FINAL_REPRESENTABLE for such a boundary, the
// machine-delivery schemas keep it BLOCKING, and the emitter names the proof.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createSource,
  createArbitrationDecision,
  createCanonicalNoteEvent,
  createCanonicalRestEvent,
  createCanonicalTempoEvent,
  createCanonicalProject,
} from '../backend/canonical/index.mjs';
import { MICRO_TIMING_KEEP_ACTION, createIntervalIdentity } from '../backend/canonical/micro-timing.mjs';
import { POSITION_CLASS, TARGET_STATUS, analyzeReleaseTiming, classifyPosition } from '../backend/canonical/release-timing.mjs';
import { BOUNDARY_COVERAGE, MICRO_GAP_BLOCKERS, enforceMicroGaps } from '../backend/final/micro-gap-enforcement.mjs';
import { evaluateProjectReadiness } from '../backend/final/readiness.mjs';
import { emitFinalMml } from '../backend/final/mml-emitter.mjs';
import { EMIT_DIAGNOSTICS } from '../backend/final/emitter-contract.mjs';
import {
  MACHINE_DELIVERY_GATE_NAMES,
  MACHINE_DELIVERY_SCHEMA_V1,
  MACHINE_DELIVERY_SCHEMA_V2,
  evaluateMachineDelivery,
} from '../backend/final/delivery-evaluator.mjs';

const BOUNDARY = MICRO_GAP_BLOCKERS.BOUNDARY_NOT_FINAL_REPRESENTABLE;
const SEARCH_CODES = [EMIT_DIAGNOSTICS.DURATION_SEARCH_POLICY_LIMIT, EMIT_DIAGNOSTICS.DURATION_SEARCH_BUDGET_EXHAUSTED];
const OFFICIAL = createSource({ id: 'official', label: 'Official score', kind: 'official-musicxml', authority: 'primary-symbolic' });

let counter = 0;
const note = (start, end, { id = `n${++counter}`, role = 'Melody' } = {}) => createCanonicalNoteEvent({
  id, pitch: 60, start: String(start), end: String(end), role, voice: role, volume: null, sourceIds: ['official'],
});
const rest = (start, end, { id = `r${++counter}`, role = 'Melody' } = {}) => createCanonicalRestEvent({
  id, start: String(start), end: String(end), role, voice: role, sourceIds: ['official'],
});
const project = (events, tempo = [['0', 120]], decisions = []) => createCanonicalProject({
  id: `boundary:${++counter}`,
  title: 'boundary representability fixture',
  sources: [OFFICIAL],
  events,
  tempoEvents: tempo.map(([beat, bpm], index) => createCanonicalTempoEvent({ id: `t${index}`, beat, bpm, sourceIds: ['official'] })),
  decisions,
  metadata: {},
});
const codes = result => result.diagnostics.map(item => item.code);

test('the verifier\'s four cases: an unreachable onset no interval covers blocks G10, readiness and the emitter; a caution-reachable one does not', () => {
  const cases = [
    { label: 'first onset one 480-tick after beat 0', events: [note('1/480', 1, { id: 'late' })], onset: '1/480' },
    { label: 'first onset at 1/32 beat', events: [note('1/32', 1, { id: 'late' })], onset: '1/32' },
    { label: 'onset one 480-tick late after a rest of at least the grid', events: [note(0, 1), note('961/480', 3, { id: 'late' })], onset: '961/480' },
    // 2 + 1/240 beats is 481/960 of a whole note: off the grid, but 960 divides
    // the admitted lcm, so a caution length could reach it. Nothing is proven,
    // G10 has nothing to raise and the emitter keeps its search code.
    { label: 'onset 1/240 beat late after a rest (caution-representable)', events: [note(0, 1), note('481/240', 3, { id: 'late' })], onset: '481/240', caution: true },
  ];
  for (const { label, events, onset, caution = false } of cases) {
    const candidate = project(events);
    const g10 = enforceMicroGaps(candidate);
    const readiness = evaluateProjectReadiness({ project: candidate }).gates.microTiming;
    const emitted = emitFinalMml(candidate);

    if (caution) {
      assert.equal(classifyPosition(onset), POSITION_CLASS.CAUTION_REPRESENTABLE, label);
      assert.equal(g10.status, 'PASS', label);
      assert.deepEqual(g10.blockers, [], label);
      assert.deepEqual(g10.unsupportedBoundaries, [], label);
      assert.equal(readiness.status, 'PASS', label);
      assert.equal(emitted.status, 'FAIL', label);
      assert.ok(codes(emitted).includes(EMIT_DIAGNOSTICS.DURATION_SEARCH_POLICY_LIMIT), label);
      assert.equal(codes(emitted).includes(EMIT_DIAGNOSTICS.BOUNDARY_NOT_FINAL_REPRESENTABLE), false, `${label}: no proof is claimed`);
      continue;
    }

    assert.equal(classifyPosition(onset), POSITION_CLASS.NOT_FINAL_REPRESENTABLE, label);
    // G10: no interval, no release target, so the boundary is its own blocker.
    assert.equal(g10.candidateCount, 0, `${label}: the interval analyzer sees nothing here`);
    assert.equal(g10.status, 'PENDING', label);
    assert.deepEqual(g10.blockers, [BOUNDARY], label);
    assert.deepEqual(g10.unsupportedBoundaries.map(item => [item.eventId, item.boundary, item.position, item.reason, item.coverage]),
      [['late', 'start', onset, 'ONSET_NOT_FINAL_REPRESENTABLE', BOUNDARY_COVERAGE.NONE]], label);
    assert.equal(g10.provisionalReleases.length, 0, `${label}: nothing is held provisionally`);
    // Readiness republishes the G10 verdict: microTiming is no longer PASS.
    assert.equal(readiness.status, 'PENDING', label);
    assert.deepEqual(readiness.blockers, [BOUNDARY], label);
    // The emitter stops at G10 instead of blaming its search limit.
    assert.equal(emitted.status, 'PENDING', label);
    assert.equal(emitted.combinedMml, null, label);
    assert.ok(emitted.diagnostics.some(item => item.code === EMIT_DIAGNOSTICS.MICRO_GAP_BLOCKED_PENDING && item.blockers.includes(BOUNDARY)), label);
    assert.equal(codes(emitted).some(code => SEARCH_CODES.includes(code)), false, `${label}: no search-limit diagnosis`);
  }
});

test('a legato join at an unreachable point and a trailing rest to an unreachable role end block G10', () => {
  const legato = enforceMicroGaps(project([note(0, '481/480', { id: 'a' }), note('481/480', 2, { id: 'b' })]));
  assert.equal(legato.status, 'PENDING');
  assert.deepEqual(legato.blockers, [BOUNDARY]);
  assert.deepEqual(legato.unsupportedBoundaries.map(item => [item.eventId, item.boundary, item.reason, item.coverage]), [
    ['a', 'end', 'RELEASE_SHARED_WITH_AN_UNREPRESENTABLE_ONSET', BOUNDARY_COVERAGE.NONE],
    ['b', 'start', 'ONSET_NOT_FINAL_REPRESENTABLE', BOUNDARY_COVERAGE.NONE],
  ]);

  // The role ends where no token sequence reaches; the emitter never shortens a rest.
  const trailing = project([note(0, 1, { id: 'a' }), rest(1, '961/480', { id: 'tail' })]);
  const report = enforceMicroGaps(trailing);
  assert.equal(report.status, 'PENDING');
  assert.deepEqual(report.blockers, [BOUNDARY]);
  assert.deepEqual(report.unsupportedBoundaries.map(item => [item.eventId, item.boundary, item.reason, item.coverage]), [
    ['tail', 'end', 'REST_END_NOT_FINAL_REPRESENTABLE', BOUNDARY_COVERAGE.NONE],
  ]);
  assert.equal(emitFinalMml(trailing).status, 'PENDING');
});

test('a boundary another G10 outcome decides keeps that outcome, and one inside a silence raises nothing', () => {
  // A sub-grid gap ends at the late onset: the UNKNOWN interval decides, as before.
  const gap = enforceMicroGaps(project([note(0, 1, { id: 'a' }), note('481/480', 2, { id: 'b' })]));
  assert.deepEqual(gap.blockers, [MICRO_GAP_BLOCKERS.CLASSIFICATION_UNKNOWN]);
  assert.deepEqual(gap.unsupportedBoundaries.map(item => [item.eventId, item.coverage]), [['b', BOUNDARY_COVERAGE.ANALYSED_INTERVAL]]);

  // An explicit rest starting at an unreachable release: the release side decides.
  const atRelease = enforceMicroGaps(project([note(0, '479/480', { id: 'x' }), rest('479/480', 2, { id: 'r' }), note(2, 3, { id: 'y' })]));
  assert.deepEqual(atRelease.blockers, [MICRO_GAP_BLOCKERS.RELEASE_NOT_FINAL_REPRESENTABLE]);
  assert.deepEqual(atRelease.unsupportedBoundaries.map(item => [item.eventId, item.boundary, item.coverage]), [['r', 'start', BOUNDARY_COVERAGE.RELEASE_TARGET]]);

  // A rest starting inside a silence: the Final writes the silence as one exact
  // span, so the rest's own start is never a position the role has to reach.
  const inside = project([note(0, 1, { id: 'a' }), rest('961/480', 3, { id: 'r' })]);
  const report = enforceMicroGaps(inside);
  assert.equal(report.status, 'PASS');
  assert.deepEqual(report.blockers, []);
  assert.deepEqual(report.unsupportedBoundaries.map(item => [item.eventId, item.reason, item.coverage]), [['r', 'REST_START_NOT_FINAL_REPRESENTABLE', BOUNDARY_COVERAGE.INSIDE_SILENCE]]);
  assert.equal(emitFinalMml(inside).status, 'PASS');
});

test('a release under a keep claim raises no release blocker, so a rest boundary at it raises the boundary code', () => {
  // The same shape as the release-target case above, but a keep decision claims
  // the sub-grid release is musically meaningful. The release analysis then
  // reports it SOURCE_SUPPORTED_NOT_REPRESENTABLE and leaves it out of
  // notVisibleToIntervalAnalyzerCount, so RELEASE_NOT_FINAL_REPRESENTABLE is not
  // raised and nothing on the release side decides the rest's start. Counting
  // the target as coverage left G10 and readiness at PASS here while the
  // emitter proved the position unreachable.
  const keep = status => createArbitrationDecision({
    id: `keep-x-${status}`,
    eventIds: ['x'],
    action: MICRO_TIMING_KEEP_ACTION,
    status,
    reason: 'claimed musically meaningful',
    metadata: { intervalIdentity: createIntervalIdentity({ type: 'inter-event-gap', previousEventId: 'x', nextEventId: 'y', start: '479/480', end: '1' }) },
  });
  const events = () => [note(0, '479/480', { id: 'x' }), rest('479/480', 2, { id: 'r' }), note(2, 3, { id: 'y' })];
  for (const status of ['accepted', 'pending']) {
    const claimed = project(events(), undefined, [keep(status)]);
    const analysis = analyzeReleaseTiming({ candidate: claimed });
    assert.deepEqual(analysis.targets.map(target => [target.eventId, target.status]), [['x', TARGET_STATUS.SOURCE_SUPPORTED_NOT_REPRESENTABLE]], status);
    assert.equal(analysis.notVisibleToIntervalAnalyzerCount, 0, status);

    const g10 = enforceMicroGaps(claimed);
    assert.equal(g10.status, 'PENDING', status);
    assert.deepEqual(g10.blockers, [BOUNDARY], status);
    assert.deepEqual(g10.unsupportedBoundaries.map(item => [item.eventId, item.boundary, item.position, item.coverage]),
      [['r', 'start', '479/480', BOUNDARY_COVERAGE.NONE]], status);
    const readiness = evaluateProjectReadiness({ project: claimed }).gates.microTiming;
    assert.equal(readiness.status, 'PENDING', status);
    assert.deepEqual(readiness.blockers, [BOUNDARY], status);
    const emitted = emitFinalMml(claimed);
    assert.notEqual(emitted.status, 'PASS', status);
    assert.equal(emitted.combinedMml, null, status);
  }

  // Control: without the claim the release itself raises its blocker, and that
  // still decides the rest's start.
  const unclaimed = enforceMicroGaps(project(events()));
  assert.deepEqual(unclaimed.blockers, [MICRO_GAP_BLOCKERS.RELEASE_NOT_FINAL_REPRESENTABLE]);
  assert.deepEqual(unclaimed.unsupportedBoundaries.map(item => [item.eventId, item.coverage]), [['r', BOUNDARY_COVERAGE.RELEASE_TARGET]]);
});

test('the boundary code is BLOCKING under both machine-delivery schemas, even beside the listen-first code', () => {
  const identity = schema => Object.freeze({ canonical_version: 'x', canonical_status: 'PUBLISHED', rules_snapshot_sha: 'f'.repeat(40), machine_delivery_schema: schema });
  const gates = microTiming => ({ ...Object.fromEntries(MACHINE_DELIVERY_GATE_NAMES.map(name => [name, { status: 'PASS' }])), microTiming });
  const { status, blockers } = enforceMicroGaps(project([note('1/480', 1)]));
  const forged = { status: 'PENDING', blockers: [MICRO_GAP_BLOCKERS.CLASSIFICATION_UNKNOWN, MICRO_GAP_BLOCKERS.RELEASE_NOT_FINAL_REPRESENTABLE, BOUNDARY, MICRO_GAP_BLOCKERS.RELEASE_PROVISIONAL] };
  for (const schema of [MACHINE_DELIVERY_SCHEMA_V1, MACHINE_DELIVERY_SCHEMA_V2]) {
    for (const microTiming of [{ status, blockers }, forged]) {
      const result = evaluateMachineDelivery(gates(microTiming), { canonical: identity(schema), requireCompleteGateMap: true });
      assert.deepEqual(result.blocking.map(entry => [entry.gate, entry.status, entry.blockers.includes(BOUNDARY)]), [['microTiming', 'PENDING', true]], schema);
      assert.equal(result.non_blocking_pending.length, 0, schema);
      assert.equal(result.ready, false, schema);
    }
  }
});

test('the emitter names a span boundary no admitted token sequence reaches as a proof, not a search limit', () => {
  // A Tempo change one 480-tick after beat 0 splits the sustained note there.
  // G10 does not own Tempo positions, so it passes; the role still cannot be written.
  const offGrid = project([note(0, 2, { id: 'held' })], [['0', 120], ['1/480', 130]]);
  assert.equal(enforceMicroGaps(offGrid).status, 'PASS');
  for (const options of [{}, { cautionLengthOptIn: true }]) {
    const emitted = emitFinalMml(offGrid, options);
    assert.equal(emitted.status, 'FAIL');
    assert.equal(codes(emitted).some(code => SEARCH_CODES.includes(code)), false, JSON.stringify(options));
    const proofs = emitted.diagnostics.filter(item => item.code === EMIT_DIAGNOSTICS.BOUNDARY_NOT_FINAL_REPRESENTABLE);
    assert.deepEqual(proofs.map(item => [item.severity, item.eventId, item.start, item.end, item.completenessProven, item.unreachableBoundaries.map(entry => `${entry.boundary}@${entry.position}`)]), [
      ['error', 'held', '0', '1/480', true, ['end@1/480']],
      ['error', 'held', '1/480', '2', true, ['start@1/480']],
    ], JSON.stringify(options));
  }

  // A caution-representable split point proves nothing: the preferred-only
  // search keeps its own code, and the caution lattice writes it.
  const triplet = project([note(0, 2, { id: 'held' })], [['0', 120], ['1/3', 130]]);
  const preferred = emitFinalMml(triplet);
  assert.equal(preferred.status, 'FAIL');
  assert.ok(codes(preferred).includes(EMIT_DIAGNOSTICS.DURATION_SEARCH_POLICY_LIMIT));
  assert.equal(codes(preferred).includes(EMIT_DIAGNOSTICS.BOUNDARY_NOT_FINAL_REPRESENTABLE), false);
  assert.equal(emitFinalMml(triplet, { cautionLengthOptIn: true }).status, 'PASS');
});
