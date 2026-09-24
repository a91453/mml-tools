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
import { POSITION_CLASS, RELEASE_REFUSAL, REPRESENTATION, TARGET_STATUS, analyzeReleaseTiming, classifyPosition, planReleaseRepresentation } from '../backend/canonical/release-timing.mjs';
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
function assertBoundaryAgreement(candidate, expectedNone, label) {
  const g10 = enforceMicroGaps(candidate);
  assert.equal(g10.status, 'PENDING', label);
  assert.deepEqual(g10.blockers, [BOUNDARY], label);
  assert.deepEqual(noneEntries(g10), expectedNone, label);
  assert.equal(g10.provisionalReleases.length, 0, `${label}: nothing is held provisionally`);

  const readiness = evaluateProjectReadiness({ project: candidate });
  const micro = readiness.gates.microTiming;
  assert.equal(micro.status, 'PENDING', label);
  assert.deepEqual(micro.blockers, [BOUNDARY], label);
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
      // accepted with admissible evidence, UNKNOWN while it is pending.
      assert.deepEqual(g10.enforcement.map(item => [item.identity.start, item.identity.end, item.classification]),
        [[identity.start, identity.end, status === 'accepted' ? 'SOURCE_SUPPORTED_MICROTIMING' : 'UNKNOWN']], tag);
      assert.deepEqual(g10.blockers, status === 'accepted' ? [] : [MICRO_GAP_BLOCKERS.CLASSIFICATION_UNKNOWN], tag);
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
    const { g10, emitted } = assertBoundaryAgreement(candidate, [X_RELEASE(reason)], tag);
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
