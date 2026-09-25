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
import { MICRO_TIMING_KEEP_ACTION, MICRO_TIMING_TECHNICAL_ACTIONS, SAFE_GRID, createIntervalIdentity } from '../backend/canonical/micro-timing.mjs';
import { FINAL_LENGTH_LCM, POSITION_CLASS, RELEASE_REFUSAL, REPRESENTATION, TARGET_STATUS, analyzeReleaseTiming, classifyPosition, planReleaseRepresentation } from '../backend/canonical/release-timing.mjs';
import { BOUNDARY_COVERAGE, LEADING_ONSET_REASON, MICRO_GAP_BLOCKERS, SHORTEST_ADMITTED_TOKEN_BEATS, enforceMicroGaps } from '../backend/final/micro-gap-enforcement.mjs';
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
// Raised for preserved source-supported material, beside the boundary code
// when both apply; never inside MICRO_GAP_BLOCKED_PENDING.
const SOURCE_SUPPORTED = 'MICRO_TIMING_SOURCE_SUPPORTED_NOT_FINAL_REPRESENTABLE';
const SEARCH_CODES = [EMIT_DIAGNOSTICS.DURATION_SEARCH_POLICY_LIMIT, EMIT_DIAGNOSTICS.DURATION_SEARCH_BUDGET_EXHAUSTED];
const OFFICIAL = createSource({ id: 'official', label: 'Official score', kind: 'official-musicxml', authority: 'primary-symbolic' });

let counter = 0;
const note = (start, end, { id = `n${++counter}`, role = 'Melody', pitch = 60 } = {}) => createCanonicalNoteEvent({
  id, pitch, start: String(start), end: String(end), role, voice: role, volume: null, sourceIds: ['official'],
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
    // The emitter stops at G10 instead of blaming its search limit, and names
    // the proof and where it is rather than calling it unproven material.
    assert.equal(emitted.status, 'FAIL', label);
    assert.equal(emitted.combinedMml, null, label);
    assert.deepEqual(emitted.diagnostics.map(item => [item.code, item.severity]), [[EMIT_DIAGNOSTICS.MICRO_GAP_BOUNDARY_NOT_FINAL_REPRESENTABLE, 'error']], label);
    assert.deepEqual(emitted.diagnostics[0].unreachableBoundaries.map(item => [item.role, item.eventId, item.boundary, item.position]), [['Melody', 'late', 'start', onset]], label);
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
  const emitted = emitFinalMml(trailing);
  assert.equal(emitted.status, 'FAIL');
  assert.deepEqual(codes(emitted), [EMIT_DIAGNOSTICS.MICRO_GAP_BOUNDARY_NOT_FINAL_REPRESENTABLE]);
  assert.deepEqual(emitted.diagnostics[0].unreachableBoundaries.map(item => [item.role, item.eventId, item.kind, item.boundary, item.position]),
    [['Melody', 'tail', 'rest', 'end', '961/480']]);
});

test('a boundary another G10 outcome decides keeps that outcome, and one inside a silence raises nothing', () => {
  // A sub-grid gap ends at the late onset: the UNKNOWN interval decides, as before.
  const gap = enforceMicroGaps(project([note(0, 1, { id: 'a' }), note('481/480', 2, { id: 'b' })]));
  assert.deepEqual(gap.blockers, [MICRO_GAP_BLOCKERS.CLASSIFICATION_UNKNOWN]);
  assert.deepEqual(gap.unsupportedBoundaries.map(item => [item.eventId, item.coverage]), [['b', BOUNDARY_COVERAGE.ANALYSED_INTERVAL]]);

  // An explicit rest starting at an unreachable release. Extending the release
  // enters the rest and truncating it leaves the rest's start where it is, so
  // the release has no valid representation: it raises no release code, and
  // nothing on the release side decides the rest's start.
  const atRelease = enforceMicroGaps(project([note(0, '479/480', { id: 'x' }), rest('479/480', 2, { id: 'r' }), note(2, 3, { id: 'y' })]));
  assert.deepEqual(atRelease.blockers, [BOUNDARY]);
  assert.deepEqual(atRelease.unsupportedBoundaries.map(item => [item.eventId, item.boundary, item.coverage]), [['r', 'start', BOUNDARY_COVERAGE.NONE]]);

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
  // The same shape as the explicit-rest case above, but a keep decision claims
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
    assert.equal(emitted.status, 'FAIL', status);
    assert.equal(emitted.combinedMml, null, status);
    const proof = emitted.diagnostics.find(item => item.code === EMIT_DIAGNOSTICS.MICRO_GAP_BOUNDARY_NOT_FINAL_REPRESENTABLE);
    assert.deepEqual(proof.unreachableBoundaries.map(item => [item.eventId, item.boundary, item.position]), [['r', 'start', '479/480']], status);
  }

  // Without the claim the release has no valid representation either (the
  // explicit rest at it refuses both options), so it raises no release code and
  // the rest's start is still the boundary the role cannot reach.
  const unclaimed = enforceMicroGaps(project(events()));
  assert.deepEqual(unclaimed.blockers, [BOUNDARY]);
  assert.deepEqual(unclaimed.unsupportedBoundaries.map(item => [item.eventId, item.coverage]), [['r', BOUNDARY_COVERAGE.NONE]]);
});

test('coverage is decided per role: another role\'s interval, release or note at the same beat decides nothing', () => {
  const view = report => report.unsupportedBoundaries.map(item => [item.role, item.eventId, item.boundary, item.position, item.coverage]);

  // Chord1's sub-grid note ends at 1/480, where Melody's first note starts.
  // The UNKNOWN interval is Chord1's; Melody's onset is still its own problem.
  const byInterval = enforceMicroGaps(project([
    note('1/480', 1, { id: 'late' }),
    note(0, '1/480', { id: 'blip', role: 'Chord1', pitch: 64 }),
    note('1/480', 2, { id: 'held', role: 'Chord1', pitch: 64 }),
  ]));
  assert.deepEqual(byInterval.blockers, [MICRO_GAP_BLOCKERS.CLASSIFICATION_UNKNOWN, BOUNDARY]);
  assert.deepEqual(view(byInterval), [
    ['Chord1', 'blip', 'end', '1/480', BOUNDARY_COVERAGE.ANALYSED_INTERVAL],
    ['Chord1', 'held', 'start', '1/480', BOUNDARY_COVERAGE.ANALYSED_INTERVAL],
    ['Melody', 'late', 'start', '1/480', BOUNDARY_COVERAGE.NONE],
  ]);

  // Melody's release at 479/480 raises the release code; Chord1's onset at the
  // same beat is not a release and is not decided by Melody's.
  const byRelease = enforceMicroGaps(project([
    note(0, '479/480', { id: 'x' }),
    note(2, 3, { id: 'y' }),
    note('479/480', 2, { id: 'entry', role: 'Chord1', pitch: 64 }),
  ]));
  assert.deepEqual(byRelease.blockers, [MICRO_GAP_BLOCKERS.RELEASE_NOT_FINAL_REPRESENTABLE, BOUNDARY]);
  assert.deepEqual(view(byRelease), [['Chord1', 'entry', 'start', '479/480', BOUNDARY_COVERAGE.NONE]]);

  // Melody's rest starts inside Melody's own silence; that Chord1 attacks at the
  // same beat does not make it a position Melody has to reach.
  const bySilence = enforceMicroGaps(project([
    note(0, 1, { id: 'm' }),
    rest('961/480', 3, { id: 'breath' }),
    note('961/480', 3, { id: 'entry', role: 'Chord1', pitch: 64 }),
  ]));
  assert.deepEqual(bySilence.blockers, [BOUNDARY]);
  assert.deepEqual(view(bySilence), [
    ['Chord1', 'entry', 'start', '961/480', BOUNDARY_COVERAGE.NONE],
    ['Melody', 'breath', 'start', '961/480', BOUNDARY_COVERAGE.INSIDE_SILENCE],
  ]);
});

test('an unreachable onset that starts a sub-grid note is decided by that note\'s own interval', () => {
  // The note [1/480, 1/16) is shorter than the grid, so the analyzer reports an
  // event-duration interval that STARTS at the unreachable onset. That interval
  // is UNKNOWN and decides the onset; the boundary code is not added on top.
  const candidate = project([note('1/480', '1/16', { id: 'tiny' })]);
  const g10 = enforceMicroGaps(candidate);
  assert.deepEqual(g10.enforcement.map(item => [item.identity.type, item.identity.start, item.identity.end, item.classification]),
    [['event-duration', '1/480', '1/16', 'UNKNOWN']]);
  assert.equal(g10.status, 'PENDING');
  assert.deepEqual(g10.blockers, [MICRO_GAP_BLOCKERS.CLASSIFICATION_UNKNOWN]);
  assert.deepEqual(g10.unsupportedBoundaries.map(item => [item.eventId, item.boundary, item.position, item.reason, item.coverage]),
    [['tiny', 'start', '1/480', 'ONSET_NOT_FINAL_REPRESENTABLE', BOUNDARY_COVERAGE.ANALYSED_INTERVAL]]);
  const emitted = emitFinalMml(candidate);
  assert.equal(emitted.status, 'PENDING');
  assert.deepEqual(emitted.microGap.blockedIntervalKeys, g10.blockedIntervalKeys);
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

test('the emitter reports a proven boundary as a proof that names where it is, apart from unproven material, and delivers nothing', () => {
  // The boundary code used to reach the caller inside MICRO_GAP_BLOCKED_PENDING,
  // "Unproven sub-grid material is never acted on", with status PENDING and no
  // role, event or beat anywhere in the result. It is a proof, and the emitter
  // contract's ERROR ("a confirmed negative: this candidate cannot be
  // Final-emitted as it stands") is the severity that says so.
  const UNKNOWN = MICRO_GAP_BLOCKERS.CLASSIFICATION_UNKNOWN;
  const mixed = project([
    note('1/480', 1, { id: 'late' }),
    note(0, '1/480', { id: 'blip', role: 'Chord1', pitch: 64 }),
    note('1/480', 2, { id: 'held', role: 'Chord1', pitch: 64 }),
  ]);
  const g10 = enforceMicroGaps(mixed);
  assert.deepEqual(g10.blockers, [UNKNOWN, BOUNDARY]);
  for (const options of [{}, { readiness: evaluateProjectReadiness({ project: mixed }) }]) {
    const label = Object.keys(options).join() || 'no readiness';
    const emitted = emitFinalMml(mixed, options);
    assert.equal(emitted.status, 'FAIL', label);
    assert.equal(emitted.combinedMml, null, label);
    assert.deepEqual(emitted.microGap.blockers, g10.blockers, `${label}: the G10 report itself is carried unchanged`);
    // The open question keeps its pending diagnostic, which no longer claims
    // the proof is unproven.
    const pending = emitted.diagnostics.filter(item => item.code === EMIT_DIAGNOSTICS.MICRO_GAP_BLOCKED_PENDING);
    assert.deepEqual(pending.map(item => [item.severity, item.blockers]), [['pending', [UNKNOWN]]], label);
    assert.equal(pending[0].message.includes(BOUNDARY), false, label);
    // The proof is its own error, with the location.
    const proofs = emitted.diagnostics.filter(item => item.code === EMIT_DIAGNOSTICS.MICRO_GAP_BOUNDARY_NOT_FINAL_REPRESENTABLE);
    assert.equal(proofs.length, 1, label);
    const [proof] = proofs;
    assert.deepEqual([proof.severity, proof.blocker, proof.completenessProven, proof.unreachableBoundaryCount, proof.unreachableBoundariesTruncated],
      ['error', BOUNDARY, true, 1, false], label);
    assert.deepEqual(proof.unreachableBoundaries, [{ role: 'Melody', eventId: 'late', kind: 'note', boundary: 'start', position: '1/480', reason: 'ONSET_NOT_FINAL_REPRESENTABLE' }], label);
    assert.match(proof.message, /Melody event late \(note start\) at beat 1\/480/, label);
    assert.doesNotMatch(proof.message, /unproven sub-grid material|not representable|unrepresentable|impossible/i, label);
  }

  // Bounded like the other lists a diagnostic carries, with the true count.
  const many = project(Array.from({ length: 22 }, (_, index) => note(`${960 * index + 1}/480`, `${960 * index + 480}/480`, { id: `m${index}` })));
  const bounded = emitFinalMml(many);
  assert.equal(bounded.status, 'FAIL');
  assert.deepEqual(codes(bounded), [EMIT_DIAGNOSTICS.MICRO_GAP_BOUNDARY_NOT_FINAL_REPRESENTABLE]);
  const [listed] = bounded.diagnostics;
  assert.deepEqual([listed.unreachableBoundaryCount, listed.unreachableBoundaries.length, listed.unreachableBoundariesTruncated], [22, 20, true]);
  assert.deepEqual(listed.unreachableBoundaries.map(item => item.eventId), Array.from({ length: 20 }, (_, index) => `m${index}`));
  assert.match(listed.message, /^G10 \(MICRO_TIMING_BOUNDARY_NOT_FINAL_REPRESENTABLE\): 22 onset or rest boundaries .* the first Melody event m0 \(note start\) at beat 1\/480; unreachableBoundaries lists the first 20\./);

  // Control: an unreachable release is an open decision -- an evidence-backed
  // release representation, or the provisional hold (here the one release is
  // its source's whole offset pattern, so RELEASE_PROVISIONAL is beside it) --
  // so it stays PENDING, with the pending diagnostic it always had.
  const release = emitFinalMml(project([note(0, '479/480', { id: 'x' }), note(2, 3, { id: 'y' })]));
  assert.equal(release.status, 'PENDING');
  assert.deepEqual(release.diagnostics.map(item => [item.code, item.severity, item.blockers]), [[EMIT_DIAGNOSTICS.MICRO_GAP_BLOCKED_PENDING, 'pending',
    [MICRO_GAP_BLOCKERS.RELEASE_NOT_FINAL_REPRESENTABLE, MICRO_GAP_BLOCKERS.RELEASE_PROVISIONAL]]]);
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

// ─── a release no release representation can move ───────────────────────────
//
// The release analysis reports an unreachable note release as a target, never
// as a boundary, because a representation decision can move it. A release under
// a keep claim (SOURCE_SUPPORTED_NOT_REPRESENTABLE) and one whose every
// representation is invalid (NO_VALID_REPRESENTATION) cannot be moved. The
// first used to raise nothing at all, so G10 and readiness PASSed it whenever no
// explicit rest started at it (implicit silence after it, or the role ending
// there) while the emitter proved the position unreachable; the second raised
// the release code, whose only answer, release representation, refuses it.

const KEEP_REASON = 'RELEASE_UNDER_A_KEEP_CLAIM_NOT_FINAL_REPRESENTABLE';
const NO_VALID_REASON = 'RELEASE_WITH_NO_VALID_REPRESENTATION';
const keepOn = (status, identity) => createArbitrationDecision({
  id: `keep-x-${status}`,
  eventIds: ['x'],
  action: MICRO_TIMING_KEEP_ACTION,
  status,
  reason: 'claimed musically meaningful',
  metadata: { intervalIdentity: createIntervalIdentity(identity) },
});
// One unreachable release, x at 479/480, and what follows it. A keep claim
// names x's release through the gap after it (K0, K1) or its own duration (K2).
const SHAPES = Object.freeze({
  K0: {
    followingShape: 'explicit-rest-at-release',
    events: () => [note(0, '479/480', { id: 'x' }), rest('479/480', 2, { id: 'r' }), note(2, 3, { id: 'y' })],
    identity: { type: 'inter-event-gap', previousEventId: 'x', nextEventId: 'y', start: '479/480', end: '1' },
  },
  K1: {
    followingShape: 'rest-of-at-least-safe-grid',
    events: () => [note(0, '479/480', { id: 'x' }), note(2, 3, { id: 'y' })],
    identity: { type: 'inter-event-gap', previousEventId: 'x', nextEventId: 'y', start: '479/480', end: '1' },
  },
  K2: {
    followingShape: 'role-end',
    events: () => [note(0, '479/480', { id: 'x' })],
    identity: { type: 'event-duration', eventId: 'x', start: '0', end: '479/480' },
  },
});
const shaped = (name, status) => project(SHAPES[name].events(), undefined, status ? [keepOn(status, SHAPES[name].identity)] : []);
const noneEntries = report => report.unsupportedBoundaries.filter(item => item.coverage === BOUNDARY_COVERAGE.NONE)
  .map(({ role, eventId, kind, boundary, position, reason }) => ({ role, eventId, kind, boundary, position, reason }));
const REST_AT_X = { role: 'Melody', eventId: 'r', kind: 'rest', boundary: 'start', position: '479/480', reason: 'REST_START_NOT_FINAL_REPRESENTABLE' };
const X_RELEASE = reason => ({ role: 'Melody', eventId: 'x', kind: 'note', boundary: 'end', position: '479/480', reason });
const planFor = (analysis, representation) => planReleaseRepresentation({
  analysis,
  registry: null,
  input: { decisions: [{ id: `rr-${representation}`, eventIds: ['x'], representation, reason: 'fixture', evidence: [] }] },
});

// What G10, the readiness microTiming gate, the machine-delivery schemas and
// the emitter (alone and with the readiness report) each say about a candidate
// they must agree on.
function assertBoundaryAgreement(candidate, expectedNone, label, expectedBlockers = [BOUNDARY]) {
  const g10 = enforceMicroGaps(candidate);
  assert.equal(g10.status, 'PENDING', label);
  assert.deepEqual(g10.blockers, expectedBlockers, label);
  assert.deepEqual(noneEntries(g10), expectedNone, label);
  assert.equal(g10.provisionalReleases.length, 0, `${label}: nothing is held provisionally`);

  const readiness = evaluateProjectReadiness({ project: candidate });
  const micro = readiness.gates.microTiming;
  assert.equal(micro.status, 'PENDING', label);
  assert.deepEqual(micro.blockers, expectedBlockers, label);
  assert.deepEqual(micro.unsupportedBoundaries, g10.unsupportedBoundaries, `${label}: readiness republishes G10`);
  assert.ok(readiness.preGameBlocking.includes('microTiming'), label);

  const identity = schema => Object.freeze({ canonical_version: 'x', canonical_status: 'PUBLISHED', rules_snapshot_sha: 'f'.repeat(40), machine_delivery_schema: schema });
  const gates = { ...Object.fromEntries(MACHINE_DELIVERY_GATE_NAMES.map(name => [name, { status: 'PASS' }])), microTiming: { status: micro.status, blockers: micro.blockers } };
  for (const schema of [MACHINE_DELIVERY_SCHEMA_V1, MACHINE_DELIVERY_SCHEMA_V2]) {
    const delivery = evaluateMachineDelivery(gates, { canonical: identity(schema), requireCompleteGateMap: true });
    assert.deepEqual(delivery.blocking.map(entry => entry.gate), ['microTiming'], `${label} ${schema}`);
    assert.equal(delivery.ready, false, `${label} ${schema}`);
  }

  for (const options of [{}, { readiness }]) {
    const tag = `${label}${options.readiness ? ' with readiness' : ''}`;
    const emitted = emitFinalMml(candidate, options);
    assert.equal(emitted.status, 'FAIL', tag);
    assert.equal(emitted.combinedMml, null, tag);
    const proofs = emitted.diagnostics.filter(item => item.code === EMIT_DIAGNOSTICS.MICRO_GAP_BOUNDARY_NOT_FINAL_REPRESENTABLE);
    assert.equal(proofs.length, 1, tag);
    assert.deepEqual([proofs[0].severity, proofs[0].completenessProven, proofs[0].unreachableBoundaryCount], ['error', true, expectedNone.length], tag);
    assert.deepEqual(proofs[0].unreachableBoundaries, expectedNone, `${tag}: the emitter names what G10 named`);
    // A proof, never unproven material, and never met again at serialization.
    assert.equal(codes(emitted).includes(EMIT_DIAGNOSTICS.MICRO_GAP_BLOCKED_PENDING), false, tag);
    assert.equal(codes(emitted).includes(EMIT_DIAGNOSTICS.BOUNDARY_NOT_FINAL_REPRESENTABLE), false, tag);
    assert.equal(codes(emitted).some(code => SEARCH_CODES.includes(code)), false, tag);
  }
  return { g10, readiness, emitted: emitFinalMml(candidate) };
}

test('a release under a keep claim blocks G10, readiness and the emitter alike, whether an explicit rest follows it, implicit silence follows it or the role ends there', () => {
  for (const name of ['K0', 'K1', 'K2']) {
    for (const status of ['accepted', 'pending']) {
      const label = `${name} ${status} keep`;
      const candidate = shaped(name, status);
      const analysis = analyzeReleaseTiming({ candidate });
      assert.deepEqual(analysis.targets.map(target => [target.eventId, target.status, target.analysis.followingShape]),
        [['x', TARGET_STATUS.SOURCE_SUPPORTED_NOT_REPRESENTABLE, SHAPES[name].followingShape]], label);
      assert.equal(analysis.notVisibleToIntervalAnalyzerCount, 0, `${label}: no release code is raised for it`);
      assert.equal(enforceMicroGaps(candidate).candidateCount, 0, `${label}: no analysed interval covers it`);

      // The explicit rest starting at the release already reports that position,
      // so the release is not listed a second time; without it, the release is.
      const expected = name === 'K0' ? [REST_AT_X] : [X_RELEASE(KEEP_REASON)];
      const { readiness, emitted } = assertBoundaryAgreement(candidate, expected, label);
      if (name !== 'K0') assert.match(emitted.diagnostics[0].message, /Melody event x \(note end\) at beat 479\/480 is a note release its Final role has to reach/, label);
      // A pending claim is also an open decision of its own.
      assert.equal(readiness.gates.pendingDecisions.status, status === 'pending' ? 'PENDING' : 'PASS', label);
      assert.equal(codes(emitted).includes(EMIT_DIAGNOSTICS.PENDING_DECISIONS_PRESENT), status === 'pending', label);
      // Release representation refuses the claimed release, whichever option.
      for (const representation of Object.values(REPRESENTATION)) {
        assert.deepEqual(planFor(analysis, representation).blockers.map(item => item.code), [RELEASE_REFUSAL.KEEP_DECISION_PRESENT], `${label} ${representation}`);
      }
    }
  }
});

test('a release no representation can move gets one answer whether a keep claim on it is accepted, pending, rejected or absent', () => {
  // K0: the explicit rest at x refuses both options, so no status of a claim
  // leaves anything that could move x. For identical events the emitter used to
  // answer FAIL with the claim accepted and PENDING ("unproven sub-grid
  // material") with it rejected, and the run hint named release representation.
  for (const status of ['accepted', 'pending', 'rejected', null]) {
    const label = `K0 ${status ?? 'no'} keep`;
    const candidate = shaped('K0', status);
    const analysis = analyzeReleaseTiming({ candidate });
    const claimed = status === 'accepted' || status === 'pending';
    const [target] = analysis.targets;
    assert.equal(target.status, claimed ? TARGET_STATUS.SOURCE_SUPPORTED_NOT_REPRESENTABLE : TARGET_STATUS.NO_VALID_REPRESENTATION, label);
    assert.ok(target.options.every(option => !option.valid), `${label}: neither representation is valid`);
    for (const representation of Object.values(REPRESENTATION)) {
      assert.deepEqual(planFor(analysis, representation).blockers.map(item => item.code),
        [claimed ? RELEASE_REFUSAL.KEEP_DECISION_PRESENT : RELEASE_REFUSAL.REPRESENTATION_INVALID], `${label} ${representation}`);
    }
    assertBoundaryAgreement(candidate, [REST_AT_X], label);
  }

  // K1 and K2: x has a valid representation. A standing claim takes it away, so
  // the release is the proven boundary; with the claim rejected or absent it is
  // an open decision a release representation answers, and stays PENDING.
  for (const name of ['K1', 'K2']) {
    for (const status of ['rejected', null]) {
      const label = `${name} ${status ?? 'no'} keep`;
      const candidate = shaped(name, status);
      const analysis = analyzeReleaseTiming({ candidate });
      assert.equal(analysis.targets[0].status, TARGET_STATUS.REPRESENTATION_DECISION_REQUIRED, label);
      const valid = analysis.targets[0].options.find(option => option.valid)?.representation;
      assert.ok(valid, label);
      assert.deepEqual(planFor(analysis, valid).blockers, [], `${label}: release representation takes it`);
      const g10 = enforceMicroGaps(candidate);
      assert.deepEqual(g10.blockers, [MICRO_GAP_BLOCKERS.RELEASE_NOT_FINAL_REPRESENTABLE, MICRO_GAP_BLOCKERS.RELEASE_PROVISIONAL], label);
      assert.deepEqual(g10.unsupportedBoundaries, [], label);
      const emitted = emitFinalMml(candidate);
      assert.equal(emitted.status, 'PENDING', label);
      assert.deepEqual(emitted.diagnostics.map(item => [item.code, item.severity]), [[EMIT_DIAGNOSTICS.MICRO_GAP_BLOCKED_PENDING, 'pending']], label);
    }
    assertBoundaryAgreement(shaped(name, 'accepted'), [X_RELEASE(KEEP_REASON)], `${name} accepted keep`);
  }

  // A release with no valid representation and no rest at it is its own entry.
  // x starts on a triplet position, so truncating it would leave a sub-grid
  // note; Chord1 attacks the same pitch just before the next grid point, so
  // extending it would overlap that attack. Both positions are ones a caution
  // length reaches, so x's release is the only unreachable position.
  assert.equal(classifyPosition('1/3'), POSITION_CLASS.CAUTION_REPRESENTABLE);
  assert.equal(classifyPosition('157/360'), POSITION_CLASS.CAUTION_REPRESENTABLE);
  for (const [label, tail] of [['followed by silence', [note(2, 3, { id: 'y' })]], ['at the role end', []]]) {
    const candidate = project([note('1/3', '209/480', { id: 'x' }), ...tail, note('157/360', 1, { id: 'c', role: 'Chord1', pitch: 60 })]);
    const analysis = analyzeReleaseTiming({ candidate });
    assert.deepEqual(analysis.targets.map(target => [target.eventId, target.status, target.options.map(option => option.reasons)]), [['x', TARGET_STATUS.NO_VALID_REPRESENTATION, [
      ['EXTENSION_INTRODUCES_CROSS_ROLE_SAME_PITCH_OVERLAP'], ['TRUNCATION_WOULD_LEAVE_A_SUB_GRID_NOTE'],
    ]]], label);
    assert.equal(analysis.notVisibleToIntervalAnalyzerCount, 1, label);
    assertBoundaryAgreement(candidate, [{ role: 'Melody', eventId: 'x', kind: 'note', boundary: 'end', position: '209/480', reason: NO_VALID_REASON }], `no valid representation, ${label}`);
  }
});

test('a release an analysed interval decides is not reported again, and a release a representation can move still decides a boundary at it', () => {
  const official = { evidence: ['official bar 1'], metadata: { evidenceSourceIds: ['official'] } };
  const keepWithEvidence = (status, identity) => createArbitrationDecision({
    id: `keep-${status}`,
    eventIds: identity.type === 'event-duration' ? [identity.eventId] : [identity.previousEventId, identity.nextEventId],
    action: MICRO_TIMING_KEEP_ACTION,
    status,
    reason: 'notated',
    evidence: official.evidence,
    metadata: { ...official.metadata, intervalIdentity: createIntervalIdentity(identity) },
  });
  const cases = [
    // x's release is followed by a sub-grid gap: the gap interval starts at it.
    ['gap', [note(0, '479/480', { id: 'x' }), note(1, 2, { id: 'y' })], { type: 'inter-event-gap', previousEventId: 'x', nextEventId: 'y', start: '479/480', end: '1' }],
    // x is itself shorter than the grid: its duration interval ends at it.
    ['sub-grid note', [note(0, '29/480', { id: 'x' }), note(1, 2, { id: 'y' })], { type: 'event-duration', eventId: 'x', start: '0', end: '29/480' }],
  ];
  for (const [label, events, identity] of cases) {
    for (const status of ['accepted', 'pending']) {
      const tag = `${label} ${status}`;
      const candidate = project(events, undefined, [keepWithEvidence(status, identity)]);
      assert.equal(analyzeReleaseTiming({ candidate }).targets[0].status, TARGET_STATUS.SOURCE_SUPPORTED_NOT_REPRESENTABLE, tag);
      const g10 = enforceMicroGaps(candidate);
      // The interval's own outcome decides: preserved when the claim is
      // accepted with admissible evidence, UNKNOWN while it is pending. Either
      // way it blocks: preserved material no Final token can carry raises its
      // own code.
      assert.deepEqual(g10.enforcement.map(item => [item.identity.start, item.identity.end, item.classification]),
        [[identity.start, identity.end, status === 'accepted' ? 'SOURCE_SUPPORTED_MICROTIMING' : 'UNKNOWN']], tag);
      assert.equal(g10.status, 'PENDING', tag);
      assert.deepEqual(g10.blockers, status === 'accepted' ? [SOURCE_SUPPORTED] : [MICRO_GAP_BLOCKERS.CLASSIFICATION_UNKNOWN], tag);
      assert.deepEqual(g10.unsupportedBoundaries, [], `${tag}: the release is not reported a second time`);
      const emitted = emitFinalMml(candidate);
      assert.deepEqual(emitted.diagnostics.filter(item => item.severity !== 'notice').map(item => item.code), status === 'accepted'
        ? [EMIT_DIAGNOSTICS.SOURCE_SUPPORTED_INTERVAL_NOT_REPRESENTABLE]
        : [EMIT_DIAGNOSTICS.MICRO_GAP_BLOCKED_PENDING, EMIT_DIAGNOSTICS.PENDING_DECISIONS_PRESENT], tag);
    }
  }

  // A release with no valid representation whose gap to an explicit rest is
  // sub-grid: the UNKNOWN gap decides, and neither the release nor the rest's
  // start is reported as a boundary nothing decides.
  const toRest = enforceMicroGaps(project([note(0, '479/480', { id: 'x' }), rest('959/960', 2, { id: 'r' }), note(2, 3, { id: 'y' })]));
  assert.deepEqual(toRest.blockers, [MICRO_GAP_BLOCKERS.CLASSIFICATION_UNKNOWN]);
  assert.equal(toRest.releaseTiming.noValidRepresentationCount, 1);
  assert.deepEqual(toRest.unsupportedBoundaries.map(item => [item.eventId, item.boundary, item.coverage]), [['r', 'start', BOUNDARY_COVERAGE.ANALYSED_INTERVAL]]);

  // A release a representation can move still raises the release code, and a
  // boundary at it (here a rest ending there) is still decided by it.
  const overlapping = enforceMicroGaps(project([note(0, '479/480', { id: 'x' }), rest('1/2', '479/480', { id: 'r' }), note(2, 3, { id: 'y' })]));
  assert.deepEqual(overlapping.blockers, [MICRO_GAP_BLOCKERS.RELEASE_NOT_FINAL_REPRESENTABLE]);
  assert.deepEqual(overlapping.unsupportedBoundaries.map(item => [item.eventId, item.boundary, item.coverage]), [['r', 'end', BOUNDARY_COVERAGE.RELEASE_TARGET]]);
});

test('a sub-grid rest that starts at a release no representation can move decides the rest\'s start, never the release, whatever its outcome', () => {
  // x[0,479/480) is followed at once by an explicit rest r[479/480,1) one
  // 480-tick long, then y[1,2). The rest refuses both of x's representations,
  // so x has no valid one. r is shorter than the grid, so the interval analyzer
  // reports r's own duration, an interval that STARTS at x's release. That
  // interval decides r's start; it does not decide x's release: a rest starts
  // where a release is, and no outcome of r's own duration moves x or makes
  // 479/480 reachable. Counting it as covering x let G10 and readiness PASS once
  // r was kept with evidence, while the emitter failed and nothing on the
  // release side could answer x. Only an interval that decides the release
  // itself -- x's own sub-grid duration, or the sub-grid gap after it (the
  // previous test) -- decides it.
  const official = { evidence: ['official bar 1'], metadata: { evidenceSourceIds: ['official'] } };
  const restDuration = { type: 'event-duration', eventId: 'r', start: '479/480', end: '1' };
  const keepRest = (status, evidence = true) => createArbitrationDecision({
    id: `keep-r-${status}`,
    eventIds: ['r'],
    action: MICRO_TIMING_KEEP_ACTION,
    status,
    reason: 'notated breath',
    ...(evidence ? { evidence: official.evidence } : {}),
    metadata: { ...(evidence ? official.metadata : {}), intervalIdentity: createIntervalIdentity(restDuration) },
  });
  const events = () => [note(0, '479/480', { id: 'x' }), rest('479/480', 1, { id: 'r' }), note(1, 2, { id: 'y' })];
  const coverage = report => report.unsupportedBoundaries.map(item => [item.eventId, item.boundary, item.position, item.coverage]);
  const REST_START_DECIDED = ['r', 'start', '479/480', BOUNDARY_COVERAGE.ANALYSED_INTERVAL];
  const X_RELEASE_NONE = ['x', 'end', '479/480', BOUNDARY_COVERAGE.NONE];

  // r kept with admissible evidence: its interval is preserved. x has no claim
  // (NO_VALID_REPRESENTATION) or a standing claim of its own
  // (SOURCE_SUPPORTED_NOT_REPRESENTABLE); either way nothing moves it.
  const preservedCases = [
    ['no claim on x', [], TARGET_STATUS.NO_VALID_REPRESENTATION, NO_VALID_REASON],
    ['accepted claim on x', [keepOn('accepted', SHAPES.K0.identity)], TARGET_STATUS.SOURCE_SUPPORTED_NOT_REPRESENTABLE, KEEP_REASON],
    ['pending claim on x', [keepOn('pending', SHAPES.K0.identity)], TARGET_STATUS.SOURCE_SUPPORTED_NOT_REPRESENTABLE, KEEP_REASON],
  ];
  for (const [label, claims, targetStatus, reason] of preservedCases) {
    const tag = `preserved rest, ${label}`;
    const candidate = project(events(), undefined, [keepRest('accepted'), ...claims]);
    const analysis = analyzeReleaseTiming({ candidate });
    assert.deepEqual(analysis.targets.map(target => [target.eventId, target.status, target.analysis.followingShape]),
      [['x', targetStatus, 'explicit-rest-at-release']], tag);
    assert.ok(analysis.targets[0].options.every(option => !option.valid), `${tag}: neither representation is valid`);
    const { g10, emitted } = assertBoundaryAgreement(candidate, [X_RELEASE(reason)], tag, [BOUNDARY, SOURCE_SUPPORTED]);
    assert.deepEqual(g10.enforcement.map(item => [item.identity.type, item.identity.eventId, item.classification]),
      [['event-duration', 'r', 'SOURCE_SUPPORTED_MICROTIMING']], `${tag}: the rest's own interval is preserved`);
    assert.deepEqual(coverage(g10), [REST_START_DECIDED, X_RELEASE_NONE], `${tag}: the rest's start is decided by its interval, x's release is not`);
    // Both proofs stand: the release no token sequence reaches, and the
    // preserved rest no token is short enough for.
    assert.deepEqual(emitted.diagnostics.filter(item => item.severity !== 'notice').map(item => item.code), [
      EMIT_DIAGNOSTICS.MICRO_GAP_BOUNDARY_NOT_FINAL_REPRESENTABLE,
      EMIT_DIAGNOSTICS.SOURCE_SUPPORTED_INTERVAL_NOT_REPRESENTABLE,
      ...(label.startsWith('pending') ? [EMIT_DIAGNOSTICS.PENDING_DECISIONS_PRESENT] : []),
    ], tag);
    assert.match(emitted.diagnostics[0].message, /Melody event x \(note end\) at beat 479\/480 is a note release its Final role has to reach/, tag);
  }

  // r's own duration still open (claim pending, accepted without evidence, or
  // absent): that UNKNOWN interval keeps its pending answer, and x's release is
  // reported beside it rather than hidden behind it.
  const openCases = [
    ['pending claim on r', [keepRest('pending')]],
    ['accepted claim on r without evidence', [keepRest('accepted', false)]],
    ['no claim on r', []],
  ];
  for (const [label, decisions] of openCases) {
    const tag = `open rest, ${label}`;
    const candidate = project(events(), undefined, decisions);
    const g10 = enforceMicroGaps(candidate);
    assert.deepEqual(g10.enforcement.map(item => [item.identity.eventId, item.classification]), [['r', 'UNKNOWN']], tag);
    assert.equal(g10.status, 'PENDING', tag);
    assert.deepEqual(g10.blockers, [MICRO_GAP_BLOCKERS.CLASSIFICATION_UNKNOWN, BOUNDARY], tag);
    assert.deepEqual(coverage(g10), [REST_START_DECIDED, X_RELEASE_NONE], tag);
    const readiness = evaluateProjectReadiness({ project: candidate });
    assert.deepEqual([readiness.gates.microTiming.status, readiness.gates.microTiming.blockers], ['PENDING', g10.blockers], tag);
    assert.deepEqual(readiness.gates.microTiming.unsupportedBoundaries, g10.unsupportedBoundaries, tag);
    const emitted = emitFinalMml(candidate);
    assert.equal(emitted.status, 'FAIL', tag);
    assert.equal(emitted.combinedMml, null, tag);
    assert.deepEqual(emitted.diagnostics.filter(item => item.severity !== 'notice').map(item => [item.code, item.severity]), [
      [EMIT_DIAGNOSTICS.MICRO_GAP_BLOCKED_PENDING, 'pending'],
      [EMIT_DIAGNOSTICS.MICRO_GAP_BOUNDARY_NOT_FINAL_REPRESENTABLE, 'error'],
      ...(label.startsWith('pending') ? [[EMIT_DIAGNOSTICS.PENDING_DECISIONS_PRESENT, 'pending']] : []),
    ], tag);
    assert.deepEqual(emitted.diagnostics[0].blockers, [MICRO_GAP_BLOCKERS.CLASSIFICATION_UNKNOWN], `${tag}: the pending diagnostic keeps only the open question`);
    const proof = emitted.diagnostics[1];
    assert.deepEqual([proof.blocker, proof.completenessProven, proof.unreachableBoundaries], [BOUNDARY, true, [X_RELEASE(NO_VALID_REASON)]], tag);
  }
});

// Only two analysed intervals decide a release no representation can move: the
// note's own sub-grid duration, which ends at the release, and the sub-grid gap
// after it, which starts at the release in the note's own role. An interval of
// another span that meets the release at the same beat decides that span's
// boundary, not the release. The two tests below take the previous test's shape
// -- x[0,479/480), an explicit rest r[479/480,1) kept as notated with admissible
// evidence, then y[1,2) -- and add one such interval each: another role's gap
// starting at the beat, and another note of the role ending there. Letting
// either decide x brings back the looseness the previous test pins. With that
// interval kept with evidence, G10 and readiness then name no proof for x (and
// before preserved material raised its own code they PASSed) while the emitter
// fails. With it still open, x's release hides behind CLASSIFICATION_UNKNOWN and the
// emitter names no proof for it; once the rest is open too, the emitter
// answers PENDING although no answer to either open question moves x.
async function assertAnotherSpanDecidesNothing(t, { events, other, otherIds, otherTarget, otherRole }) {
  const official = { evidence: ['official bar 1'], metadata: { evidenceSourceIds: ['official'] } };
  const keep = (id, eventIds, identity, status, evidence = true) => createArbitrationDecision({
    id,
    eventIds,
    action: MICRO_TIMING_KEEP_ACTION,
    status,
    reason: 'notated',
    ...(evidence ? { evidence: official.evidence } : {}),
    metadata: { ...(evidence ? official.metadata : {}), intervalIdentity: createIntervalIdentity(identity) },
  });
  const keepRest = () => keep('keep-r', ['r'], { type: 'event-duration', eventId: 'r', start: '479/480', end: '1' }, 'accepted');
  const keepOther = (status, evidence) => keep(`keep-${otherTarget}-${status}`, otherIds, other, status, evidence);
  const releaseOf = (analysis, eventId) => analysis.targets.find(target => target.eventId === eventId);
  const coverage = report => report.unsupportedBoundaries.map(item => [item.role, item.eventId, item.boundary, item.position, item.coverage]);
  // Melody's two entries and nothing else: r's start, decided by r's own
  // interval, and x's release, which nothing decides. The other span's release
  // is decided by its own interval and is not listed.
  const EXPECTED_COVERAGE = [
    ['Melody', 'r', 'start', '479/480', BOUNDARY_COVERAGE.ANALYSED_INTERVAL],
    ['Melody', 'x', 'end', '479/480', BOUNDARY_COVERAGE.NONE],
  ];

  // The other interval kept with admissible evidence: both intervals are
  // preserved and raise only the preserved-material code, so x's release is
  // the only boundary G10 raises.
  await t.test('the other interval kept with evidence', () => {
    const tag = 'kept with evidence';
    const candidate = project(events(), undefined, [keepRest(), keepOther('accepted', true)]);
    const analysis = analyzeReleaseTiming({ candidate });
    const x = releaseOf(analysis, 'x');
    assert.deepEqual([x.role, x.status, x.analysis.followingShape], ['Melody', TARGET_STATUS.NO_VALID_REPRESENTATION, 'explicit-rest-at-release'], tag);
    assert.ok(x.options.every(option => !option.valid), `${tag}: neither representation is valid for x`);
    // The other span's release is at the same beat, and the keep claim on the
    // interval after or within it makes it a release nothing can move either.
    // Its own interval decides it, so it is not listed.
    const otherRelease = releaseOf(analysis, otherTarget);
    assert.deepEqual([otherRelease.role, otherRelease.status], [otherRole, TARGET_STATUS.SOURCE_SUPPORTED_NOT_REPRESENTABLE], tag);
    const { g10, emitted } = assertBoundaryAgreement(candidate, [X_RELEASE(NO_VALID_REASON)], tag, [BOUNDARY, SOURCE_SUPPORTED]);
    assert.deepEqual(g10.enforcement.map(item => [item.identity.type, item.classification]),
      [['event-duration', 'SOURCE_SUPPORTED_MICROTIMING'], [other.type, 'SOURCE_SUPPORTED_MICROTIMING']], `${tag}: both intervals are preserved`);
    assert.deepEqual(coverage(g10), EXPECTED_COVERAGE, `${tag}: the other interval decides its own span, not x's release`);
    assert.deepEqual(emitted.diagnostics.filter(item => item.severity !== 'notice').map(item => item.code), [
      EMIT_DIAGNOSTICS.MICRO_GAP_BOUNDARY_NOT_FINAL_REPRESENTABLE,
      EMIT_DIAGNOSTICS.SOURCE_SUPPORTED_INTERVAL_NOT_REPRESENTABLE,
    ], tag);
    assert.match(emitted.diagnostics[0].message, /Melody event x \(note end\) at beat 479\/480 is a note release its Final role has to reach/, tag);
  });

  // The other interval still open (claim pending, accepted without evidence, or
  // absent): its UNKNOWN answer stays pending, and x's release is reported
  // beside it rather than hidden behind it. In the last case the rest is open
  // too, so nothing but open questions and x's release is left, and the emitter
  // FAILs on the proof rather than answering PENDING.
  const PRESERVED = 'SOURCE_SUPPORTED_MICROTIMING';
  for (const [label, decisions, restClassification] of [
    ['the other interval\'s claim pending', () => [keepRest(), keepOther('pending', true)], PRESERVED],
    ['the other interval\'s claim accepted without evidence', () => [keepRest(), keepOther('accepted', false)], PRESERVED],
    ['no claim on the other interval', () => [keepRest()], PRESERVED],
    ['no claim on the other interval or on the rest', () => [], 'UNKNOWN'],
  ]) {
    await t.test(label, () => {
      const open = project(events(), undefined, decisions());
      assert.equal(releaseOf(analyzeReleaseTiming({ candidate: open }), 'x').status, TARGET_STATUS.NO_VALID_REPRESENTATION, label);
      const report = enforceMicroGaps(open);
      assert.deepEqual(report.enforcement.map(item => [item.identity.type, item.classification]),
        [['event-duration', restClassification], [other.type, 'UNKNOWN']], label);
      assert.equal(report.status, 'PENDING', label);
      assert.deepEqual(report.blockers, [
        MICRO_GAP_BLOCKERS.CLASSIFICATION_UNKNOWN,
        BOUNDARY,
        ...(restClassification === PRESERVED ? [SOURCE_SUPPORTED] : []),
      ], label);
      assert.deepEqual(coverage(report), EXPECTED_COVERAGE, label);
      const readiness = evaluateProjectReadiness({ project: open }).gates.microTiming;
      assert.deepEqual([readiness.status, readiness.blockers], ['PENDING', report.blockers], label);
      assert.deepEqual(readiness.unsupportedBoundaries, report.unsupportedBoundaries, label);
      const emitted = emitFinalMml(open);
      assert.equal(emitted.status, 'FAIL', label);
      assert.equal(emitted.combinedMml, null, label);
      const blocking = emitted.diagnostics.filter(item => item.severity !== 'notice');
      assert.deepEqual(blocking.map(item => item.code), [
        EMIT_DIAGNOSTICS.MICRO_GAP_BLOCKED_PENDING,
        EMIT_DIAGNOSTICS.MICRO_GAP_BOUNDARY_NOT_FINAL_REPRESENTABLE,
        ...(restClassification === PRESERVED ? [EMIT_DIAGNOSTICS.SOURCE_SUPPORTED_INTERVAL_NOT_REPRESENTABLE] : []),
        ...(label.includes('pending') ? [EMIT_DIAGNOSTICS.PENDING_DECISIONS_PRESENT] : []),
      ], label);
      assert.deepEqual([blocking[0].severity, blocking[0].blockers], ['pending', [MICRO_GAP_BLOCKERS.CLASSIFICATION_UNKNOWN]], `${label}: the pending diagnostic keeps only the open question`);
      assert.deepEqual([blocking[1].severity, blocking[1].blocker, blocking[1].completenessProven, blocking[1].unreachableBoundaries],
        ['error', BOUNDARY, true, [X_RELEASE(NO_VALID_REASON)]], label);
    });
  }
}

test('another role\'s sub-grid gap that starts at a release no representation can move does not decide that release', async t => {
  // Chord1's c1[0,479/480) is followed by a sub-grid gap to c2[1,2). That gap
  // starts at 479/480 too, but it is the silence c1's release opens in Chord1:
  // it decides c1's release, and Melody still has to reach 479/480 with a note
  // release nothing can move. The gap-start key is the release's own role.
  await assertAnotherSpanDecidesNothing(t, {
    events: () => [
      note(0, '479/480', { id: 'x' }), rest('479/480', 1, { id: 'r' }), note(1, 2, { id: 'y' }),
      note(0, '479/480', { id: 'c1', role: 'Chord1', pitch: 64 }), note(1, 2, { id: 'c2', role: 'Chord1', pitch: 64 }),
    ],
    other: { type: 'inter-event-gap', previousEventId: 'c1', nextEventId: 'c2', start: '479/480', end: '1' },
    otherIds: ['c1', 'c2'],
    otherTarget: 'c1',
    otherRole: 'Chord1',
  });
});

test('another note of the role whose sub-grid duration ends at a release no representation can move does not decide that release', async t => {
  // w[478/480,479/480) is a second Melody note shorter than the grid. Its own
  // duration interval ENDS at x's release and decides w's release; no outcome of
  // it moves x or makes 479/480 reachable. Among intervals that end at the
  // release, only x's own duration, matched by event, decides it.
  await assertAnotherSpanDecidesNothing(t, {
    events: () => [
      note(0, '479/480', { id: 'x' }), note('478/480', '479/480', { id: 'w', pitch: 67 }),
      rest('479/480', 1, { id: 'r' }), note(1, 2, { id: 'y' }),
    ],
    other: { type: 'event-duration', eventId: 'w', start: '478/480', end: '479/480' },
    otherIds: ['w'],
    otherTarget: 'w',
    otherRole: 'Melody',
  });
});

// ─── preserved source-supported material never clears G10 ──────────────────
//
// FINAL_MML_EMITTER §4/§5: every admitted Final token is at least 1/64 of a
// whole note, so a sub-grid interval classified SOURCE_SUPPORTED_MICROTIMING,
// which must be kept exactly, is provably unwritable, and the emitter always
// FAILs on it (SOURCE_SUPPORTED_INTERVAL_NOT_REPRESENTABLE). G10 counted
// preserved material as raising nothing, so G10, readiness microTiming and
// machine delivery (@1 and @2) PASSed candidates the emitter must refuse --
// with or without an unreachable boundary beside it: a boundary an analysed
// interval decides was 'analysed-interval' whatever that interval's
// classification, and several shapes have no unreachable boundary at all. G10
// now raises MICRO_TIMING_SOURCE_SUPPORTED_NOT_FINAL_REPRESENTABLE for any
// preserved interval, keyed on the classification alone, which it leaves
// unchanged (ACCEPTANCE_CRITERIA Gate 2: PENDING/UNSUPPORTED, not guessed).

const THIRD_PARTY = createSource({ id: 'third', label: 'Community MIDI', kind: 'third-party-midi', authority: 'supporting' });
const TEMPO = () => [createCanonicalTempoEvent({ id: 't0', beat: '0', bpm: 120, sourceIds: ['official'] })];
// Every readiness gate but microTiming passes, so microTiming is the only
// variable; the Source-Faithful Baseline carries the candidate's own events.
const readyProject = (events, decisions = []) => {
  const baseline = createCanonicalProject({
    id: `baseline:${++counter}`, title: 'Source-Faithful Baseline', sources: [OFFICIAL, THIRD_PARTY], events, tempoEvents: TEMPO(),
    metadata: { sourceComplete: true, baselineKind: 'source-faithful' },
  });
  return createCanonicalProject({
    id: `preserved:${++counter}`, title: 'preserved material fixture', sources: [OFFICIAL, THIRD_PARTY], events, tempoEvents: TEMPO(), decisions,
    metadata: { sourceComplete: true, sourceFaithfulBaseline: { snapshot: baseline }, audioAlignmentEvidence: [{ sourceId: 'original-audio', warnings: [], metrics: { confidence: 0.9 } }] },
  });
};
const fullReadiness = candidate => evaluateProjectReadiness({
  project: candidate,
  mmlValidation: { ok: true, errors: [] },
  core3Report: { status: 'PASS', blockers: [] },
  core3CompletenessReport: { status: 'PASS', blockers: [] },
  harmonyReport: { status: 'PASS', unresolvedCount: 0 },
  playerReadback: 'PASS',
  originalAudioRequired: true,
  originalAudioReviewed: true,
  mobileAdaptation: 'PASS',
  regressionReviewed: true,
  inGameAcceptance: 'PENDING',
});
// "kept" is an accepted keep with admissible official evidence; the others are
// the claims that leave the interval UNKNOWN.
const CLAIM = Object.freeze({
  kept: { status: 'accepted', evidence: ['official bar 1'], sources: ['official'] },
  pending: { status: 'pending', evidence: ['official bar 1'], sources: ['official'] },
  'accepted without evidence': { status: 'accepted', evidence: [], sources: ['official'] },
  'third-party only': { status: 'accepted', evidence: ['community MIDI bar 1'], sources: ['third'] },
  rejected: { status: 'rejected', evidence: ['official bar 1'], sources: ['official'] },
  absent: null,
});
const claimOn = (kind, identity) => {
  const claim = CLAIM[kind];
  if (!claim) return [];
  const eventIds = identity.type === 'event-duration' ? [identity.eventId] : [identity.previousEventId, identity.nextEventId];
  return [createArbitrationDecision({
    id: `claim-${kind.replaceAll(' ', '-')}`, eventIds, action: MICRO_TIMING_KEEP_ACTION, status: claim.status, reason: 'notated',
    evidence: claim.evidence, metadata: { evidenceSourceIds: claim.sources, intervalIdentity: createIntervalIdentity(identity) },
  })];
};
const durationOf = (eventId, start, end) => ({ type: 'event-duration', eventId, start, end });
const gapOf = (previousEventId, nextEventId, start, end) => ({ type: 'inter-event-gap', previousEventId, nextEventId, start, end });
const keyOf = identity => (identity.type === 'event-duration'
  ? JSON.stringify(['event-duration', identity.eventId, identity.start, identity.end])
  : JSON.stringify(['inter-event-gap', identity.previousEventId, identity.nextEventId, identity.start, identity.end]));
const entriesOf = report => report.unsupportedBoundaries.map(item => `${item.role}/${item.eventId}/${item.kind}/${item.boundary}@${item.position}:${item.reason}:${item.coverage}`);
const V2_IDENTITY = Object.freeze({ canonical_version: 'x', canonical_status: 'PUBLISHED', rules_snapshot_sha: 'f'.repeat(40), machine_delivery_schema: MACHINE_DELIVERY_SCHEMA_V2 });
const EMIT_PATHS = Object.freeze({
  default: {},
  cautionLengthOptIn: { cautionLengthOptIn: true },
  technicalTimingRepair: { technicalTimingRepair: true },
  provisionalReleaseRendering: { provisionalReleaseRendering: true, canonical: V2_IDENTITY },
});
const nonNotice = result => result.diagnostics.filter(item => item.severity !== 'notice').map(item => item.code);
const deliveryOf = (gate, schema) => {
  const identity = Object.freeze({ canonical_version: 'x', canonical_status: 'PUBLISHED', rules_snapshot_sha: 'f'.repeat(40), machine_delivery_schema: schema });
  const gates = { ...Object.fromEntries(MACHINE_DELIVERY_GATE_NAMES.map(name => [name, { status: 'PASS' }])), microTiming: gate };
  const delivery = evaluateMachineDelivery(gates, { canonical: identity, requireCompleteGateMap: true });
  return { ready: delivery.ready, blocking: delivery.blocking.map(entry => entry.gate), nonBlocking: delivery.non_blocking_pending.map(entry => entry.gate) };
};

const P = '479/480';
// Each shape: its events, the interval a claim names, and what G10 reported
// for it before this change (classification aside): the unsupportedBoundaries
// entries with their coverage. Those, and the classification, must not move.
// `heldIfUnproven` marks a shape whose release the provisional hold covers
// once the claim leaves the interval UNKNOWN only for missing evidence.
const PRESERVED_SHAPES = Object.freeze({
  // The owner's example 1: x legato into a sub-grid note z whose duration is kept.
  'x legato into a kept sub-grid note z (example 1)': {
    events: () => [note(0, P, { id: 'x' }), note(P, 1, { id: 'z', pitch: 62 }), note(2, 3, { id: 'y' })],
    identity: durationOf('z', P, '1'),
    entries: [
      `Melody/x/note/end@${P}:RELEASE_SHARED_WITH_AN_UNREPRESENTABLE_ONSET:analysed-interval`,
      `Melody/z/note/start@${P}:ONSET_NOT_FINAL_REPRESENTABLE:analysed-interval`,
    ],
  },
  // The owner's example 2, and the same at 961/960.
  'an onset after a kept sub-grid gap (example 2)': {
    events: () => [note(0, 1, { id: 'a' }), note('481/480', 2, { id: 'b', pitch: 62 })],
    identity: gapOf('a', 'b', '1', '481/480'),
    entries: ['Melody/b/note/start@481/480:ONSET_NOT_FINAL_REPRESENTABLE:analysed-interval'],
  },
  'an onset after a kept sub-grid gap at 961/960': {
    events: () => [note(0, 1, { id: 'a' }), note('961/960', 2, { id: 'b', pitch: 62 })],
    identity: gapOf('a', 'b', '1', '961/960'),
    entries: ['Melody/b/note/start@961/960:ONSET_NOT_FINAL_REPRESENTABLE:analysed-interval'],
  },
  // No unreachable boundary at all: both ends are caution positions.
  'a kept sub-grid note between caution positions': {
    events: () => [note(0, 1, { id: 'a' }), note(1, '25/24', { id: 'z', pitch: 62 }), note('25/24', 2, { id: 'b' })],
    identity: durationOf('z', '1', '25/24'),
    entries: [],
  },
  'a kept sub-grid gap to a caution position': {
    events: () => [note(0, 1, { id: 'a' }), note('49/48', 2, { id: 'b', pitch: 62 })],
    identity: gapOf('a', 'b', '1', '49/48'),
    entries: [],
  },
  // A release no representation can move, decided by the kept interval itself.
  'a kept sub-grid gap after an unreachable release': {
    events: () => [note(0, P, { id: 'x' }), note(1, 2, { id: 'y', pitch: 62 })],
    identity: gapOf('x', 'y', P, '1'),
    entries: [],
    heldIfUnproven: true,
  },
  'a kept sub-grid note whose own duration ends at its release': {
    events: () => [note(0, '29/480', { id: 'x' }), note(1, 2, { id: 'y', pitch: 62 })],
    identity: durationOf('x', '0', '29/480'),
    entries: [],
    heldIfUnproven: true,
  },
  'a kept sub-grid note after a grid onset': {
    events: () => [note(0, 1, { id: 'a' }), note(1, '481/480', { id: 'x', pitch: 62 }), note(2, 3, { id: 'y' })],
    identity: durationOf('x', '1', '481/480'),
    entries: [],
    heldIfUnproven: true,
  },
  // A kept sub-grid rest followed by another rest: one silence.
  'a kept sub-grid rest inside one silence': {
    events: () => [note(0, 1, { id: 'a' }), rest(1, '481/480', { id: 'r1' }), rest('481/480', 2, { id: 'r2' }), note(2, 3, { id: 'b' })],
    identity: durationOf('r1', '1', '481/480'),
    entries: ['Melody/r2/rest/start@481/480:REST_START_NOT_FINAL_REPRESENTABLE:analysed-interval'],
  },
  // In no role at all: the interval is still analysed and still preserved.
  'a kept role-less sub-grid note': {
    events: () => [note(0, '1/32', { id: 'u', role: null, pitch: 67 }), note(0, 2, { id: 'm' })],
    identity: durationOf('u', '0', '1/32'),
    entries: [],
  },
  'a kept sub-grid gap in Chord1 beside a Melody note': {
    events: () => [note(0, 2, { id: 'm' }), note(0, 1, { id: 'c1', role: 'Chord1', pitch: 48 }), note('25/24', 2, { id: 'c2', role: 'Chord1', pitch: 48 })],
    identity: gapOf('c1', 'c2', '1', '25/24'),
    entries: [],
  },
});

test('G10 never PASSes preserved source-supported material the emitter must refuse, and leaves its classification alone', () => {
  for (const [label, shape] of Object.entries(PRESERVED_SHAPES)) {
    const candidate = readyProject(shape.events(), claimOn('kept', shape.identity));
    const g10 = enforceMicroGaps(candidate);
    // The Canonical classification and everything else G10 reported are unchanged.
    assert.deepEqual(g10.enforcement.map(item => [item.identityKey, item.classification, item.classificationBasis, item.enforcement]),
      [[keyOf(shape.identity), 'SOURCE_SUPPORTED_MICROTIMING', 'accepted-keep-decision', 'preserve-source-supported']], label);
    assert.deepEqual(g10.preservedIntervalKeys, [keyOf(shape.identity)], label);
    assert.deepEqual(g10.sourceSupportedIntervalKeys, [keyOf(shape.identity)], label);
    assert.deepEqual([g10.sourceSupportedCount, g10.unknownCount, g10.technicalResidueCount], [1, 0, 0], label);
    assert.deepEqual(entriesOf(g10), shape.entries, `${label}: the boundary entries and their coverage are unchanged`);
    assert.equal(g10.finalRepresentable, null, label);
    assert.deepEqual(g10.provisionalReleases, [], label);
    // What changes: the gate says it cannot clear the candidate.
    assert.equal(g10.status, 'PENDING', label);
    assert.deepEqual(g10.blockers, [SOURCE_SUPPORTED], label);

    const readiness = fullReadiness(candidate);
    assert.deepEqual([readiness.gates.microTiming.status, readiness.gates.microTiming.blockers], ['PENDING', [SOURCE_SUPPORTED]], label);
    assert.deepEqual(readiness.preGameBlocking, ['microTiming'], `${label}: microTiming is the only gate that blocks`);
    assert.equal(readiness.candidateReady, false, label);

    const gate = { status: readiness.gates.microTiming.status, blockers: readiness.gates.microTiming.blockers };
    for (const schema of [MACHINE_DELIVERY_SCHEMA_V1, MACHINE_DELIVERY_SCHEMA_V2]) {
      assert.deepEqual(deliveryOf(gate, schema), { ready: false, blocking: ['microTiming'], nonBlocking: [] }, `${label} ${schema}`);
    }

    // The emitter's answer is unchanged: the proof it always gave, and no
    // "unproven" diagnostic for a proof.
    for (const [path, options] of Object.entries(EMIT_PATHS)) {
      const emitted = emitFinalMml(candidate, options);
      assert.equal(emitted.status, 'FAIL', `${label} ${path}`);
      assert.equal(emitted.combinedMml, null, `${label} ${path}`);
      assert.deepEqual(nonNotice(emitted), [EMIT_DIAGNOSTICS.SOURCE_SUPPORTED_INTERVAL_NOT_REPRESENTABLE], `${label} ${path}`);
      assert.deepEqual(emitted.microGap.blockers, [SOURCE_SUPPORTED], `${label} ${path}`);
    }
    const provisional = emitFinalMml(candidate, EMIT_PATHS.provisionalReleaseRendering).provisionalReleaseRendering;
    assert.deepEqual([provisional.applied, provisional.reason], [false, `micro-timing is BLOCKING under ${MACHINE_DELIVERY_SCHEMA_V2}`], label);
    const withReadiness = emitFinalMml(candidate, { readiness });
    assert.deepEqual(nonNotice(withReadiness), [EMIT_DIAGNOSTICS.SOURCE_SUPPORTED_INTERVAL_NOT_REPRESENTABLE, EMIT_DIAGNOSTICS.READINESS_BLOCKED], label);
  }

  // A listen-first ledger cannot carry it either: beside every code @2 admits,
  // the preserved-material code keeps microTiming BLOCKING.
  const forged = { status: 'PENDING', blockers: [
    MICRO_GAP_BLOCKERS.CLASSIFICATION_UNKNOWN, MICRO_GAP_BLOCKERS.RELEASE_NOT_FINAL_REPRESENTABLE, SOURCE_SUPPORTED, MICRO_GAP_BLOCKERS.RELEASE_PROVISIONAL,
  ] };
  assert.deepEqual(deliveryOf(forged, MACHINE_DELIVERY_SCHEMA_V2), { ready: false, blocking: ['microTiming'], nonBlocking: [] });
  const withoutIt = { status: 'PENDING', blockers: forged.blockers.filter(code => code !== SOURCE_SUPPORTED) };
  assert.deepEqual(deliveryOf(withoutIt, MACHINE_DELIVERY_SCHEMA_V2).nonBlocking, ['microTiming'], 'the same gate without the code is listen-first');
  assert.equal(MICRO_GAP_BLOCKERS.SOURCE_SUPPORTED_NOT_FINAL_REPRESENTABLE, SOURCE_SUPPORTED);
});

test('an interval a claim leaves UNKNOWN keeps its own answer and never raises the preserved-material code', () => {
  for (const [label, shape] of Object.entries(PRESERVED_SHAPES)) {
    for (const kind of ['pending', 'accepted without evidence', 'third-party only', 'rejected', 'absent']) {
      const tag = `${label}, claim ${kind}`;
      const candidate = readyProject(shape.events(), claimOn(kind, shape.identity));
      const g10 = enforceMicroGaps(candidate);
      assert.deepEqual(g10.enforcement.map(item => [item.identityKey, item.classification]), [[keyOf(shape.identity), 'UNKNOWN']], tag);
      assert.deepEqual(g10.preservedIntervalKeys, [], tag);
      assert.deepEqual(entriesOf(g10), shape.entries, tag);
      // Only a claim that leaves nothing but missing evidence lets the
      // provisional hold take a release, exactly as before.
      const held = shape.heldIfUnproven && (kind === 'rejected' || kind === 'absent');
      assert.equal(g10.status, 'PENDING', tag);
      assert.deepEqual(g10.blockers, held
        ? [MICRO_GAP_BLOCKERS.CLASSIFICATION_UNKNOWN, MICRO_GAP_BLOCKERS.RELEASE_PROVISIONAL]
        : [MICRO_GAP_BLOCKERS.CLASSIFICATION_UNKNOWN], tag);
      const emitted = emitFinalMml(candidate);
      assert.equal(emitted.status, 'PENDING', tag);
      assert.deepEqual(nonNotice(emitted), [
        EMIT_DIAGNOSTICS.MICRO_GAP_BLOCKED_PENDING,
        ...(kind === 'pending' ? [EMIT_DIAGNOSTICS.PENDING_DECISIONS_PRESENT] : []),
      ], tag);
    }
  }
});

test('a project with no sub-grid interval gets exactly the report it always had', () => {
  const candidate = project([note(0, 1, { id: 'a' }), note(2, 3, { id: 'b' })]);
  assert.equal(JSON.stringify(enforceMicroGaps(candidate)), '{"status":"PASS","blockers":[],"policy":{"declaredSafeDenominator":64,"declaredSafeGrid":"1/16","analyzerSafeGrid":"1/16","rejectTechnicalMicroGapsBelow64":true,"preserveMeaningfulRests":true,"conformant":true,"blockers":[]},"policyBlockers":[],"safeGrid":"1/16","candidateCount":0,"sourceSupportedCount":0,"technicalResidueCount":0,"unknownCount":0,"unresolvedStreamIssueCount":0,"hasUnknown":false,"hasUnresolvedStreamAnalysis":false,"technicalResidueIntervals":[],"unknownIntervals":[],"sourceSupportedIntervalKeys":[],"unresolvedStreamIssues":[],"enforcement":[],"preservedIntervalKeys":[],"rejectedIntervalKeys":[],"blockedIntervalKeys":[],"finalRepresentable":null,"releaseTiming":{"schema":"mml-studio/release-timing-analysis@1#summary","releaseCount":2,"targetCount":0,"decisionRequiredCount":0,"sourceSupportedNotRepresentableCount":0,"noValidRepresentationCount":0,"representedCount":0,"unsupportedBoundaryCount":0,"notVisibleToIntervalAnalyzerCount":0,"samePitchRepeatedAttackTargets":0,"followingShapes":{},"byRole":{},"windowCount":0,"encodingObservations":[]},"releaseEvidenceRequirement":null,"releaseRepresentationRecords":{"recordCount":0,"registryChecked":false,"violations":[]},"unsupportedBoundaries":[],"provisionalReleases":[],"provisionalReleaseIntervalKeys":[],"releaseOffsetSources":[]}');
  const ready = readyProject([note(0, 1, { id: 'a' }), note(2, 3, { id: 'b' })]);
  const readiness = fullReadiness(ready);
  assert.deepEqual([readiness.gates.microTiming.status, readiness.preGameBlocking, readiness.candidateReady], ['PASS', [], true]);
  assert.equal(emitFinalMml(ready).status, 'PASS');
});

test('preserved material beside another G10 outcome: every code stays visible, and only open questions are unproven', () => {
  const keptGap = claimOn('kept', gapOf('a', 'b', '1', '481/480'));
  const melody = () => [note(0, 1, { id: 'a' }), note('481/480', 2, { id: 'b', pitch: 62 })];

  // Beside an UNKNOWN interval: PENDING with both codes; the emitter's pending
  // diagnostic carries only the open question.
  const withUnknown = readyProject([...melody(), note(0, 1, { id: 'c1', role: 'Chord1', pitch: 48 }), note('481/480', 2, { id: 'c2', role: 'Chord1', pitch: 48 })], keptGap);
  const unknownReport = enforceMicroGaps(withUnknown);
  assert.deepEqual([unknownReport.status, unknownReport.blockers], ['PENDING', [MICRO_GAP_BLOCKERS.CLASSIFICATION_UNKNOWN, SOURCE_SUPPORTED]]);
  const unknownEmitted = emitFinalMml(withUnknown);
  assert.equal(unknownEmitted.status, 'FAIL');
  assert.deepEqual(nonNotice(unknownEmitted), [EMIT_DIAGNOSTICS.MICRO_GAP_BLOCKED_PENDING, EMIT_DIAGNOSTICS.SOURCE_SUPPORTED_INTERVAL_NOT_REPRESENTABLE]);
  assert.deepEqual(unknownEmitted.diagnostics.find(item => item.code === EMIT_DIAGNOSTICS.MICRO_GAP_BLOCKED_PENDING).blockers, [MICRO_GAP_BLOCKERS.CLASSIFICATION_UNKNOWN]);

  // Beside an unreachable boundary nothing decides: both proofs.
  const restAtRelease = readyProject([note(0, P, { id: 'x' }), rest(P, 1, { id: 'r' }), note(1, 2, { id: 'y' })], claimOn('kept', durationOf('r', P, '1')));
  const boundaryReport = enforceMicroGaps(restAtRelease);
  assert.deepEqual([boundaryReport.status, boundaryReport.blockers], ['PENDING', [BOUNDARY, SOURCE_SUPPORTED]]);
  assert.deepEqual(nonNotice(emitFinalMml(restAtRelease)), [
    EMIT_DIAGNOSTICS.MICRO_GAP_BOUNDARY_NOT_FINAL_REPRESENTABLE,
    EMIT_DIAGNOSTICS.SOURCE_SUPPORTED_INTERVAL_NOT_REPRESENTABLE,
  ]);

  // Beside confirmed technical residue: FAIL, and the preserved code is not
  // hidden behind it.
  const technical = createArbitrationDecision({
    id: 'technical-c', eventIds: ['c1', 'c2'], action: MICRO_TIMING_TECHNICAL_ACTIONS[0], status: 'accepted', reason: 'export pad',
    evidence: ['converter log'], metadata: { intervalIdentity: createIntervalIdentity(gapOf('c1', 'c2', '1', '481/480')) },
  });
  const withResidue = readyProject([...melody(), note(0, 1, { id: 'c1', role: 'Chord1', pitch: 48 }), note('481/480', 2, { id: 'c2', role: 'Chord1', pitch: 48 })], [...keptGap, technical]);
  const residueReport = enforceMicroGaps(withResidue);
  assert.deepEqual([residueReport.status, residueReport.blockers], ['FAIL', [MICRO_GAP_BLOCKERS.TECHNICAL_RESIDUE_PRESENT, SOURCE_SUPPORTED]]);
  const residueEmitted = emitFinalMml(withResidue);
  assert.deepEqual(nonNotice(residueEmitted), [EMIT_DIAGNOSTICS.MICRO_GAP_TECHNICAL_RESIDUE, EMIT_DIAGNOSTICS.SOURCE_SUPPORTED_INTERVAL_NOT_REPRESENTABLE]);
  assert.deepEqual(residueEmitted.diagnostics[0].blockers, [MICRO_GAP_BLOCKERS.TECHNICAL_RESIDUE_PRESENT, SOURCE_SUPPORTED]);

  // Beside a release a representation can move: the release code keeps its
  // hint, but the provisional hold never applies beside preserved material,
  // so @2 does not deliver it for listening.
  const withRelease = readyProject([...melody(), note(0, P, { id: 'c1', role: 'Chord1', pitch: 48 }), note(2, 3, { id: 'c2', role: 'Chord1', pitch: 48 })], keptGap);
  const releaseReport = enforceMicroGaps(withRelease);
  assert.deepEqual([releaseReport.status, releaseReport.blockers], ['PENDING', [MICRO_GAP_BLOCKERS.RELEASE_NOT_FINAL_REPRESENTABLE, SOURCE_SUPPORTED]]);
  assert.deepEqual(releaseReport.provisionalReleases, []);
  assert.deepEqual(deliveryOf({ status: releaseReport.status, blockers: releaseReport.blockers }, MACHINE_DELIVERY_SCHEMA_V2), { ready: false, blocking: ['microTiming'], nonBlocking: [] });
  const releaseEmitted = emitFinalMml(withRelease, EMIT_PATHS.provisionalReleaseRendering);
  assert.deepEqual(nonNotice(releaseEmitted), [EMIT_DIAGNOSTICS.MICRO_GAP_BLOCKED_PENDING, EMIT_DIAGNOSTICS.SOURCE_SUPPORTED_INTERVAL_NOT_REPRESENTABLE]);
  assert.deepEqual(releaseEmitted.diagnostics.find(item => item.code === EMIT_DIAGNOSTICS.MICRO_GAP_BLOCKED_PENDING).blockers, [MICRO_GAP_BLOCKERS.RELEASE_NOT_FINAL_REPRESENTABLE]);
  // Without the kept gap the same Chord1 release is held for listening.
  const releaseOnly = enforceMicroGaps(readyProject([note(0, 1, { id: 'a' }), note(0, P, { id: 'c1', role: 'Chord1', pitch: 48 }), note(2, 3, { id: 'c2', role: 'Chord1', pitch: 48 })]));
  assert.deepEqual(releaseOnly.blockers, [MICRO_GAP_BLOCKERS.RELEASE_NOT_FINAL_REPRESENTABLE, MICRO_GAP_BLOCKERS.RELEASE_PROVISIONAL]);
});

// ─── a role's leading silence shorter than any Final token ─────────────────
//
// A role is written as consecutive tokens from beat 0, and no admitted token --
// caution lengths included -- is shorter than 1/64 of a whole note (1/16 beat),
// so no position after beat 0 and before 1/16 is reached, whatever its
// denominator. classifyPosition calls 1/24 CAUTION_REPRESENTABLE (its
// denominator divides the admitted lcm), the release analysis reports nothing
// there, and a role's first onset after an implicit silence leaves no interval,
// so G10, readiness and machine delivery PASSed a[1/24,1) while every emitter
// path FAILed. G10 now lists a role's earliest note onset in (0, 1/16) that
// classifyPosition does not already refuse, with reason
// LEADING_SILENCE_SHORTER_THAN_ANY_FINAL_TOKEN and coverage always 'none', and
// raises the boundary code: ACCEPTANCE_CRITERIA rule 1 keeps "attack or onset
// timing ... sub-1/64 silence" BLOCKING, and no operation moves an attack.

const LEADING = 'LEADING_SILENCE_SHORTER_THAN_ANY_FINAL_TOKEN';
const leadingEntry = (role, eventId, position) => ({ eventId, role, kind: 'note', boundary: 'start', position, reason: LEADING, coverage: BOUNDARY_COVERAGE.NONE });
const proofOf = result => result.diagnostics.find(item => item.code === EMIT_DIAGNOSTICS.MICRO_GAP_BOUNDARY_NOT_FINAL_REPRESENTABLE) ?? null;
const withoutCoverage = ({ coverage, ...rest }) => rest;

test('the shortest admitted token is derived from the contract lattice, and is the safe grid under the published contract', () => {
  assert.equal(SHORTEST_ADMITTED_TOKEN_BEATS.toString(), '1/16');
  assert.equal(SHORTEST_ADMITTED_TOKEN_BEATS.cmp(SAFE_GRID), 0);
  assert.equal(LEADING_ONSET_REASON, LEADING);
});

test('a role\'s earliest onset after a silence shorter than any Final token is a boundary G10, readiness, delivery and every emitter path agree on', () => {
  const cases = {
    'Melody a[1/24,1)': { events: () => [note('1/24', 1, { id: 'a' })], entry: leadingEntry('Melody', 'a', '1/24') },
    // Per role: Melody starts on beat 0, and Chord1's first onset still counts.
    'Melody m[0,2), Chord1 c[1/240,2)': { events: () => [note(0, 2, { id: 'm' }), note('1/240', 2, { id: 'c', role: 'Chord1', pitch: 48 })], entry: leadingEntry('Chord1', 'c', '1/240') },
  };
  for (const [label, shape] of Object.entries(cases)) {
    assert.equal(classifyPosition(shape.entry.position), POSITION_CLASS.CAUTION_REPRESENTABLE, `${label}: not a position classifyPosition refuses`);
    const candidate = project(shape.events());
    assert.deepEqual(analyzeReleaseTiming({ candidate }).unsupportedBoundaries, [], `${label}: the release analysis reports nothing`);
    const g10 = enforceMicroGaps(candidate);
    assert.deepEqual([g10.status, g10.blockers], ['PENDING', [BOUNDARY]], label);
    assert.deepEqual(g10.unsupportedBoundaries, [shape.entry], label);
    const micro = evaluateProjectReadiness({ project: candidate }).gates.microTiming;
    assert.deepEqual([micro.status, micro.blockers, micro.unsupportedBoundaries], ['PENDING', [BOUNDARY], g10.unsupportedBoundaries], label);
    for (const schema of [MACHINE_DELIVERY_SCHEMA_V1, MACHINE_DELIVERY_SCHEMA_V2]) {
      assert.deepEqual(deliveryOf({ status: micro.status, blockers: micro.blockers }, schema), { ready: false, blocking: ['microTiming'], nonBlocking: [] }, `${label} ${schema}`);
    }
    for (const [path, options] of Object.entries(EMIT_PATHS)) {
      const emitted = emitFinalMml(candidate, options);
      assert.equal(emitted.status, 'FAIL', `${label} ${path}`);
      assert.equal(emitted.combinedMml, null, `${label} ${path}`);
      assert.deepEqual(nonNotice(emitted), [EMIT_DIAGNOSTICS.MICRO_GAP_BOUNDARY_NOT_FINAL_REPRESENTABLE], `${label} ${path}`);
      const proof = proofOf(emitted);
      assert.deepEqual([proof.severity, proof.completenessProven, proof.unreachableBoundaryCount, proof.unreachableBoundaries],
        ['error', true, 1, [withoutCoverage(shape.entry)]], `${label} ${path}`);
      assert.ok(proof.message.includes(`${shape.entry.role} event ${shape.entry.eventId} (note start) at beat ${shape.entry.position} is an onset its Final role has to reach`), `${label} ${path}`);
      assert.ok(proof.message.includes('no admitted Final token is shorter than 1/16 beat (1/64 of a whole note), so no position after beat 0 and before beat 1/16 is reached;'
        + ` ${shape.entry.position} is such a position.`), `${label} ${path}: ${proof.message}`);
      // The denominator argument is false for this position, so it is not made.
      assert.equal(proof.message.includes('whole-note denominator'), false, `${label} ${path}`);
    }
  }

  // The same leading silence as an explicit rest: the rest's own sub-grid
  // interval ends at the onset, but no outcome of it moves an attack, so it
  // decides only itself and the onset keeps coverage 'none'.
  const explicit = claims => project([rest(0, '1/24', { id: 'r' }), note('1/24', 1, { id: 'a' })], undefined, claims);
  const open = enforceMicroGaps(explicit([]));
  assert.deepEqual([open.status, open.blockers], ['PENDING', [MICRO_GAP_BLOCKERS.CLASSIFICATION_UNKNOWN, BOUNDARY]]);
  assert.deepEqual(open.unsupportedBoundaries, [leadingEntry('Melody', 'a', '1/24')]);
  const openEmitted = emitFinalMml(explicit([]));
  assert.equal(openEmitted.status, 'FAIL');
  assert.deepEqual(nonNotice(openEmitted), [EMIT_DIAGNOSTICS.MICRO_GAP_BLOCKED_PENDING, EMIT_DIAGNOSTICS.MICRO_GAP_BOUNDARY_NOT_FINAL_REPRESENTABLE]);
  assert.deepEqual(openEmitted.diagnostics.find(item => item.code === EMIT_DIAGNOSTICS.MICRO_GAP_BLOCKED_PENDING).blockers, [MICRO_GAP_BLOCKERS.CLASSIFICATION_UNKNOWN]);
  const kept = enforceMicroGaps(explicit(claimOn('kept', durationOf('r', '0', '1/24'))));
  assert.deepEqual([kept.status, kept.blockers], ['PENDING', [BOUNDARY, SOURCE_SUPPORTED]]);
  assert.deepEqual(kept.unsupportedBoundaries, [leadingEntry('Melody', 'a', '1/24')]);

  // A sub-grid note after the leading silence: its release was held for
  // listening under @2 (NON_BLOCKING_PENDING) while its onset could not be
  // written. The onset now blocks, so nothing is held.
  const held = project([note('1/24', '49/480', { id: 'a' })]);
  const heldReport = enforceMicroGaps(held);
  assert.deepEqual([heldReport.status, heldReport.blockers], ['PENDING', [MICRO_GAP_BLOCKERS.CLASSIFICATION_UNKNOWN, BOUNDARY]]);
  assert.deepEqual(heldReport.provisionalReleases, []);
  assert.deepEqual(deliveryOf({ status: heldReport.status, blockers: heldReport.blockers }, MACHINE_DELIVERY_SCHEMA_V2), { ready: false, blocking: ['microTiming'], nonBlocking: [] });
  assert.equal(emitFinalMml(held, EMIT_PATHS.provisionalReleaseRendering).provisionalReleaseRendering.applied, false);
  // The control: the same sub-grid note from beat 0 is still held.
  const fromZero = enforceMicroGaps(project([note(0, '29/480', { id: 'a' })]));
  assert.deepEqual(fromZero.blockers, [MICRO_GAP_BLOCKERS.CLASSIFICATION_UNKNOWN, MICRO_GAP_BLOCKERS.RELEASE_PROVISIONAL]);
  assert.equal(deliveryOf({ status: fromZero.status, blockers: fromZero.blockers }, MACHINE_DELIVERY_SCHEMA_V2).nonBlocking[0], 'microTiming');
});

test('a leading-onset proof beside a denominator proof states both arithmetic facts, and a denominator-only proof keeps its message', () => {
  const mixed = emitFinalMml(project([note('1/24', 1, { id: 'a' }), note('1/480', 1, { id: 'c', role: 'Chord1', pitch: 48 })]));
  const proof = proofOf(mixed);
  assert.deepEqual(proof.unreachableBoundaries.map(item => [item.role, item.position, item.reason]), [
    ['Chord1', '1/480', 'ONSET_NOT_FINAL_REPRESENTABLE'],
    ['Melody', '1/24', LEADING],
  ]);
  assert.ok(proof.message.includes('so every position it reaches is a sum of admitted token lengths, whose whole-note denominator divides the lcm of the admitted token denominators; the whole-note denominator of beat 1/480 (1/1920 of a whole note) does not; and no admitted Final token is shorter than 1/16 beat (1/64 of a whole note), so no position after beat 0 and before beat 1/16 is reached; 1/24 is such a position. This is a proof about those positions'), proof.message);

  // No leading entry: the message is exactly the one this proof always carried.
  assert.equal(proofOf(emitFinalMml(project([note('1/480', 1, { id: 'a' })]))).message,
    'G10 (MICRO_TIMING_BOUNDARY_NOT_FINAL_REPRESENTABLE): Melody event a (note start) at beat 1/480 is an onset its Final role has to reach, and no admitted Final token sequence reaches it. A role is written as consecutive tokens from beat 0, so every position it reaches is a sum of admitted token lengths, whose whole-note denominator divides the lcm of the admitted token denominators; this position\'s does not. This is a proof about the position, not a search limit and not an unproven question: no search bound, budget, caution opt-in or evidence changes where it is, and nothing is moved to make the role writable -- no attack, no rest, and no release that release representation refuses (one under a keep claim, or one with no valid representation). This candidate cannot be Final-emitted as it stands; the emitter fails closed.');
});

test('beside a leading onset the denominator fact names the whole-note denominator, and the positions it names are bounded', () => {
  // Beat 49/32 is 49/128 of a whole note. 32 divides the admitted lcm and 128
  // does not, so the proof is the whole-note denominator's. The message used to
  // say "the denominator of 49/32 does not", which is false as stated.
  assert.equal(FINAL_LENGTH_LCM % 32n, 0n);
  assert.notEqual(FINAL_LENGTH_LCM % 128n, 0n);
  const single = proofOf(emitFinalMml(project([
    note('1/24', 2, { id: 'c', role: 'Chord1', pitch: 64 }),
    note(0, 1, { id: 'm0', pitch: 72 }),
    note('49/32', 2, { id: 'm', pitch: 72 }),
  ])));
  assert.deepEqual(single.unreachableBoundaries.map(item => [item.eventId, item.position, item.reason]), [
    ['c', '1/24', LEADING],
    ['m', '49/32', 'ONSET_NOT_FINAL_REPRESENTABLE'],
  ]);
  assert.ok(single.message.includes('; the whole-note denominator of beat 49/32 (49/128 of a whole note) does not; and no admitted Final token is shorter than'), single.message);
  assert.equal(single.message.includes('the denominator of 49/32'), false, single.message);

  // 400 unreachable onsets and a leading one: the message names as many
  // positions as unreachableBoundaries lists and counts the rest, rather than
  // growing with the song.
  const many = project([
    ...Array.from({ length: 400 }, (_, index) => note(`${960 * index + 1}/480`, 2 * index + 1, { id: `m${index}`, pitch: 60 + (index % 12) })),
    note('1/24', 1, { id: 'c0', role: 'Chord1', pitch: 64 }),
  ]);
  const proof = proofOf(emitFinalMml(many));
  assert.equal(proof.unreachableBoundaryCount, 401);
  assert.equal(proof.unreachableBoundaries.length, 20);
  assert.ok(proof.message.includes('18241/480 (18241/1920 of a whole note) and 380 more do not; and'), proof.message);
  assert.equal(proof.message.includes('19201/480'), false, 'the 21st position is counted, not named');
  assert.ok(proof.message.length < 2500, `the message is bounded: ${proof.message.length} characters`);
});

test('a leading silence the shortest token reaches, a rest-first role and an already-refused onset add no leading entry', () => {
  // Reports unchanged, and each candidate emits exactly where it did.
  const passes = {
    'onset on the grid at 1/16': { events: () => [note('1/16', 1, { id: 'a' })], emitsOn: ['default', 'cautionLengthOptIn'] },
    // 1/12 is the caution length 48; only the caution lattice writes it.
    'onset at 1/12, no shorter than the shortest token': { events: () => [note('1/12', 1, { id: 'a' })], emitsOn: ['cautionLengthOptIn'] },
    'onset at beat 0': { events: () => [note(0, 1, { id: 'a' })], emitsOn: ['default', 'cautionLengthOptIn'] },
    // The first span is a rest: the silence before the first note is one span.
    'a rest first, then the first note on a beat': { events: () => [rest('1/24', 1, { id: 'r' }), note(1, 2, { id: 'a' })], emitsOn: ['default', 'cautionLengthOptIn'] },
  };
  for (const [label, shape] of Object.entries(passes)) {
    const candidate = project(shape.events());
    const g10 = enforceMicroGaps(candidate);
    assert.deepEqual([g10.status, g10.blockers, g10.unsupportedBoundaries], ['PASS', [], []], label);
    for (const path of ['default', 'cautionLengthOptIn']) {
      assert.equal(emitFinalMml(candidate, EMIT_PATHS[path]).status, shape.emitsOn.includes(path) ? 'PASS' : 'FAIL', `${label} ${path}`);
    }
  }
  // Positions classifyPosition already refuses keep their own single entry.
  for (const position of ['1/480', '1/32']) {
    assert.equal(classifyPosition(position), POSITION_CLASS.NOT_FINAL_REPRESENTABLE, position);
    const g10 = enforceMicroGaps(project([note(position, 1, { id: 'a' })]));
    assert.deepEqual(g10.unsupportedBoundaries.map(item => [item.eventId, item.position, item.reason, item.coverage]),
      [['a', position, 'ONSET_NOT_FINAL_REPRESENTABLE', BOUNDARY_COVERAGE.NONE]], position);
    assert.deepEqual(g10.blockers, [BOUNDARY], position);
  }
});
