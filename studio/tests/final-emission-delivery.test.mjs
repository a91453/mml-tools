// Machine delivery is ready only when the Final emitter writes the Final.
//
// ACCEPTANCE_CRITERIA "Machine delivery" lists "Final round-trip" among the
// BLOCKING items, and no readiness gate asked it. Every gate could clear --
// G10 included -- while the Final emitter, run on exactly what would be
// delivered with the options delivery uses, refused to write it. Nothing wrong
// was ever delivered, because the emitter refused; but readiness and the
// machine-delivery ledger (@1 and @2) reported READY until someone tried to
// emit. Three classes were found that way, and each is reproduced here:
//
//   1. a release that drifted from its Source-Faithful Baseline with no
//      release record (the candidate's release is where Final cannot reach,
//      its baseline's is not, and no release target is raised);
//   2. a Tempo position the Final cannot reach, or one past a role's end (G10
//      does not read the Tempo Map; FINAL_MML_EMITTER §4b assigns it to
//      serialization);
//   3. a caution-denominator release the bounded duration search cannot
//      write, or runs out of budget on.
//
// The answer is one catch-all, not three rules: the delivery-level
// `finalEmission` entry, FINAL_EMISSION_REFUSED (FINAL_EMISSION_PENDING when
// the emitter says PENDING), carrying the emitter's own diagnostics verbatim.
// No gate, classification or emitter answer changes.
//
// Every Canonical identity is constructed explicitly, so each test holds
// whichever release the published Manifest names. The codes are written as
// literals so this file states the contract rather than echoing it.
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
  MACHINE_DELIVERY_SCHEMA_V1,
  MACHINE_DELIVERY_SCHEMA_V2,
  deliveryBlockingGates,
  evaluateMachineDelivery,
} from '../backend/final/delivery-evaluator.mjs';
import {
  EVIDENCE_BASIS,
  RELEASE_RECORD_KEY,
  REPRESENTATION,
  analyzeReleaseTiming,
  buildEvidenceRegistry,
  planReleaseRepresentation,
  releaseRecordFor,
} from '../backend/canonical/release-timing.mjs';
import { createStudioApplication, READINESS_BLOCKER_WITHOUT_OPERATION, RUN_STATE, RUN_STEP, RUN_STEP_STATUS } from '../backend/application/index.mjs';
import { FIXTURE_CONFIRMATIONS, projectWithSymbolicAsset, runDecisionsFor, sixRoleBaseline } from './fixtures/run-fixtures.mjs';
import { FIXTURE_SOURCE_ID } from './fixtures/application-fixtures.mjs';
import { oneTickEarlyBaseline } from './fixtures/release-fixtures.mjs';

const identity = (version, schema) => Object.freeze({ canonical_version: version, canonical_status: 'PUBLISHED', rules_snapshot_sha: 'e'.repeat(40), machine_delivery_schema: schema });
const AT1 = identity('2026-09-23-v2', MACHINE_DELIVERY_SCHEMA_V1);
const AT2 = identity('2026-09-23-v3', MACHINE_DELIVERY_SCHEMA_V2);

const OFFICIAL = createSource({ id: 'official', label: 'Official score', kind: 'official-musicxml', authority: 'primary-symbolic' });
const note = (start, end, id, role = 'Melody', pitch = 60) => createCanonicalNoteEvent({ id, pitch, start: String(start), end: String(end), role, voice: role, volume: null, sourceIds: ['official'] });
const tempo = (id, beat, bpm) => createCanonicalTempoEvent({ id, beat: String(beat), bpm, sourceIds: ['official'] });
const ONE_TICK = new F(1, 480);
const early = beat => f(beat).sub(ONE_TICK).toString();

// A candidate whose every non-emission gate can clear: source complete, its
// Source-Faithful Baseline the candidate itself unless one is named.
function candidate(id, events, { tempi = [tempo('t0', 0, 120)], baseline = null } = {}) {
  const snapshot = baseline ?? createCanonicalProject({ id: `${id}:baseline`, title: id, sources: [OFFICIAL], events, tempoEvents: tempi });
  return createCanonicalProject({ id, title: id, sources: [OFFICIAL], events, tempoEvents: tempi, metadata: { sourceComplete: true, sourceFaithfulBaseline: { snapshot } } });
}

// Readiness after emission would have graded the MML: technical PASS, every
// review that blocks answered, the rest left unresolved where machine delivery
// lets it wait (listening first, or after delivery).
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

// What machine delivery emits with (application/final-service.mjs), written out.
const deliveryOptions = (readiness, canonical) => ({
  readiness,
  provisionalReleaseRendering: readiness.machineDelivery.authoritative === true
    && readiness.machineDelivery.non_blocking_pending.some(entry => entry.gate === 'microTiming'),
  collapseTempoRestatements: readiness.machineDelivery.authoritative === true
    && readiness.machineDelivery.schema === MACHINE_DELIVERY_SCHEMA_V2,
  canonical,
});

const errorCodes = result => result.diagnostics.filter(item => item.severity === 'error').map(item => item.code);
const finalEmissionEntry = readiness => readiness.machineDelivery.blocking.find(entry => entry.gate === 'finalEmission') ?? null;

const CLASSES = {
  // The judge's example: x[0,479/480) at the role end, its baseline x[0,1/32).
  'a baseline-drift release with no release record': {
    build: () => {
      const baseline = createCanonicalProject({ id: 'drift:baseline', title: 'drift', sources: [OFFICIAL], events: [note(0, '1/32', 'x')], tempoEvents: [tempo('t0', 0, 120)] });
      return candidate('drift', [note(0, early(1), 'x')], { baseline });
    },
    code: 'BOUNDARY_NOT_FINAL_REPRESENTABLE',
  },
  // A real Tempo change one tick before a grid point: the notes it crosses are
  // split there, at a position no admitted token sequence reaches.
  'a Tempo position the Final cannot reach': {
    build: () => candidate('tempo', [note(0, 4, 'm'), note(0, 4, 'c', 'Chord1', 48)], { tempi: [tempo('t0', 0, 120), tempo('t1', early(2), 90)] }),
    code: 'BOUNDARY_NOT_FINAL_REPRESENTABLE',
  },
  // A Tempo change on the grid, after the Melody has ended: the emitter does
  // not pad the role with rests to reach it.
  'a Tempo position past a role\'s end': {
    build: () => candidate('beyond', [note(0, 1, 'm'), note(0, 4, 'c', 'Chord1', 48)], { tempi: [tempo('t0', 0, 120), tempo('t1', 2, 90)] }),
    code: 'TEMPO_POSITION_BEYOND_ROLE_END',
  },
  // Two ticks before the grid: a caution-denominator position, then silence.
  // The bounded search finds no writing within its own limits.
  'a caution-denominator release the bounded search cannot write': {
    build: () => candidate('caution', [note(0, '478/480', 'x'), note(2, 3, 'y')]),
    code: 'DURATION_SEARCH_POLICY_LIMIT',
  },
};

for (const [label, { build, code }] of Object.entries(CLASSES)) {
  test(`${label}: every gate lets it through, the emitter refuses, and machine delivery is not ready (@1 and @2)`, () => {
    for (const canonical of [AT1, AT2]) {
      const schema = canonical.machine_delivery_schema;
      const project = build();
      const stored = JSON.stringify(project);
      const readiness = readinessOf(project, canonical);

      // The gap: G10 passes it, and the gate map alone reports it ready.
      assert.equal(readiness.gates.microTiming.status, 'PASS', `${schema}: G10 passes it`);
      const gatesOnly = evaluateMachineDelivery(readiness.gates, { canonical });
      assert.equal(gatesOnly.ready, true, `${schema}: every gate lets it through`);

      // The emitter, on exactly this project with delivery's options, refuses.
      const emitted = emitFinalMml(project, deliveryOptions(readiness, canonical));
      assert.equal(emitted.status, 'FAIL', schema);
      assert.equal(emitted.combinedMml, null);
      assert.ok(errorCodes(emitted).includes(code), `${schema}: ${JSON.stringify(errorCodes(emitted))}`);

      // So delivery is not ready, and says so under its own code.
      assert.equal(readiness.machineDelivery.ready, false, `${schema}: never READY while the emitter refuses`);
      assert.equal(readiness.machineDeliveryReady, false);
      assert.equal(readiness.automatedLifecycle, 'CANDIDATE');
      assert.equal(readiness.machineDelivery.projection_ready, false);
      assert.deepEqual(deliveryBlockingGates(readiness), ['finalEmission'], schema);
      const entry = finalEmissionEntry(readiness);
      assert.ok(entry, schema);
      assert.equal(entry.classification, 'BLOCKING');
      assert.equal(entry.status, 'FAIL');
      assert.deepEqual(entry.blockers, ['FINAL_EMISSION_REFUSED']);
      assert.equal(entry.emitter_status, 'FAIL');
      // The emitter's own codes, severities and proofs, verbatim.
      assert.deepEqual(entry.emitter_diagnostics, emitted.diagnostics, `${schema}: never paraphrased`);
      assert.equal(entry.emitter_diagnostic_count, emitted.diagnostics.length);
      assert.equal(entry.emitter_diagnostics_truncated, false);

      // Nothing else moved: every gate, and every other ledger entry.
      assert.deepEqual(readiness.machineDelivery.unresolved_evidence_ledger.filter(item => item.gate !== 'finalEmission'), gatesOnly.unresolved_evidence_ledger);
      assert.equal(readiness.gates.microTiming.status, 'PASS');
      assert.equal(JSON.stringify(project), stored, 'the candidate is never modified');
    }
  });
}

test('a search that runs out of budget is refused the same way, in the emitter\'s own words', () => {
  // A caller whose delivery opts into caution lengths, with a smaller node
  // budget than the default so the test stays quick: the bounded search on the
  // caution-denominator release exhausts it.
  const project = CLASSES['a caution-denominator release the bounded search cannot write'].build();
  let emitted = null;
  const readiness = readinessOf(project, AT2, {
    emitFinal: before => (emitted = emitFinalMml(project, { ...deliveryOptions(before, AT2), cautionLengthOptIn: true, budget: 20000 })),
  });
  assert.ok(emitted, 'the delivery emission was asked');
  assert.ok(errorCodes(emitted).includes('DURATION_SEARCH_BUDGET_EXHAUSTED'), JSON.stringify(errorCodes(emitted)));
  const entry = finalEmissionEntry(readiness);
  assert.deepEqual(entry.blockers, ['FINAL_EMISSION_REFUSED']);
  assert.deepEqual(entry.emitter_diagnostics, emitted.diagnostics);
  assert.equal(readiness.machineDelivery.ready, false);
});

// The one-tick-early fixture with its roles assigned and itself as its own
// baseline: under @2 every release is held provisionally for delivery.
function listenFirstProject() {
  const ROLE_OF = { lead: 'Melody', harm: 'Chord1', bass: 'Chord2' };
  const base = oneTickEarlyBaseline();
  const events = base.events.map(event => ({ ...event, role: ROLE_OF[event.id.split('-')[0]] }));
  const snapshot = createCanonicalProject({ ...base, events, metadata: {} });
  return createCanonicalProject({ ...base, id: 'fixture:one-tick-early#assigned', events, metadata: { sourceComplete: true, sourceFaithfulBaseline: { snapshot } } });
}

test('an emitter PENDING stays PENDING: machine delivery says what the emitter says and is not ready', () => {
  const project = listenFirstProject();
  // Machine delivery holds the releases provisionally and writes the Final.
  const delivered = readinessOf(project, AT2);
  assert.equal(delivered.gates.microTiming.status, 'PENDING');
  assert.equal(delivered.machineDelivery.ready, true, 'machine delivery emits this candidate');
  assert.equal(finalEmissionEntry(delivered), null);
  assert.equal(emitFinalMml(project, deliveryOptions(delivered, AT2)).status, 'PASS');

  // A delivery that never renders provisionally (the Studio Web path) gets
  // PENDING from the emitter for the same candidate. That is its answer.
  let emitted = null;
  const readiness = readinessOf(project, AT2, { emitFinal: before => (emitted = emitFinalMml(project, { readiness: before, canonical: AT2 })) });
  assert.equal(emitted.status, 'PENDING');
  assert.equal(readiness.machineDelivery.ready, false, 'PENDING is never a Final');
  assert.equal(readiness.automatedLifecycle, 'CANDIDATE');
  const entry = finalEmissionEntry(readiness);
  assert.equal(entry.status, 'PENDING');
  assert.deepEqual(entry.blockers, ['FINAL_EMISSION_PENDING']);
  assert.equal(entry.emitter_status, 'PENDING');
  assert.deepEqual(entry.emitter_diagnostics, emitted.diagnostics);
  assert.ok(entry.emitter_diagnostics.some(item => item.code === 'MICRO_GAP_BLOCKED_PENDING' && item.severity === 'pending'));
  // The micro-timing gate and its listen-first classification are untouched.
  assert.deepEqual(readiness.gates.microTiming, delivered.gates.microTiming);
  assert.ok(readiness.machineDelivery.non_blocking_pending.some(item => item.gate === 'microTiming'));
});

test('the check emits with delivery\'s options: a same-value Tempo restatement is collapsed under @2 and refused under @1', () => {
  // The same Tempo again one tick before a grid point, then a real change on
  // the grid. Only machine delivery under @2 collapses the restatement.
  const project = candidate('restatement', [note(0, 4, 'm'), note(0, 4, 'c', 'Chord1', 48)], {
    tempi: [tempo('t0', 0, 150), tempo('t1', early(2), 150), tempo('t2', 3, 120)],
  });
  const at2 = readinessOf(project, AT2);
  assert.equal(at2.machineDelivery.ready, true, 'delivery under @2 writes it, so the check must too');
  assert.equal(finalEmissionEntry(at2), null);

  const at1 = readinessOf(project, AT1);
  assert.equal(at1.machineDelivery.ready, false);
  const entry = finalEmissionEntry(at1);
  assert.deepEqual(entry.blockers, ['FINAL_EMISSION_REFUSED']);
  assert.ok(entry.emitter_diagnostics.some(item => item.code === 'BOUNDARY_NOT_FINAL_REPRESENTABLE' && item.completenessProven === true));
});

test('readiness checks with the release evidence registry it grades G10 with', () => {
  // A recorded release representation whose stored citation omits its
  // resolution, so only the project's current evidence registry establishes
  // that it is admissible. G10 grades it with that registry and passes, and
  // the Final service emits with it (machineDeliveryEmitOptions); a check that
  // dropped it would record a refusal of a Final delivery writes.
  const THIRD = createSource({ id: 'third', label: 'Synthetic third-party MIDI', kind: 'third-party-midi', authority: 'supporting', sha256: 'c'.repeat(64) });
  const midiNote = (id, start, end) => createCanonicalNoteEvent({ id, pitch: 60, start: String(start), end: String(end), role: 'Melody', voice: 'Melody', sourceIds: ['third'], sourceEventIds: [`third#${id}`], metadata: { ticksPerQuarter: 480 } });
  const midiProject = (events, metadata = {}) => createCanonicalProject({ id: 'registry', title: 'registry', sources: [THIRD], events, tempoEvents: [createCanonicalTempoEvent({ id: 't', beat: '0', bpm: 150, sourceIds: ['third'] })], metadata });
  const source = [midiNote('a', 0, early(1)), midiNote('b', 1, 2)];
  const registry = buildEvidenceRegistry({ assets: [{ asset_id: 'ast_third', kind: 'third_party_midi', sha256: 'c'.repeat(64) }, { asset_id: 'ast_audio', kind: 'original_audio', sha256: 'e'.repeat(64) }], sources: [THIRD] });
  const plan = planReleaseRepresentation({ analysis: analyzeReleaseTiming({ candidate: midiProject(source) }), registry, input: { decisions: [{
    id: 'rr-audio', eventIds: ['a'], representation: REPRESENTATION.EXTEND_TO_NEXT_GRID, reason: 'Legato in the recording.', attestation: { reviewer: 'agent:assistant', reviewer_kind: 'agent' },
    evidence: [{ class: 'primary-audio', ref: 'ast_audio', basis: EVIDENCE_BASIS.DIRECT_SOURCE_REVIEW, locator: '0:12', finding: 'Sustained through the boundary.' }],
  }] } });
  assert.equal(plan.changes.length, 1);
  const [change] = plan.changes;
  const events = source.map(event => (event.id === change.eventId
    ? createCanonicalNoteEvent({ ...event, end: change.after.end, metadata: { ...event.metadata, [RELEASE_RECORD_KEY]: releaseRecordFor(change) } })
    : event));
  const decisions = plan.decisions.map(decision => ({ ...decision, evidence: decision.evidence.map(({ resolved, ...item }) => item) }));
  const project = midiProject(events, { sourceComplete: true, sourceFaithfulBaseline: { snapshot: midiProject(source) }, mobileAdaptation: { releaseRepresentation: { decisions } } });

  const readiness = readinessOf(project, AT2, { releaseEvidenceRegistry: registry });
  assert.equal(readiness.gates.microTiming.status, 'PASS', JSON.stringify(readiness.gates.microTiming.blockers));
  // The registry is what the emitter's answer turns on.
  assert.equal(emitFinalMml(project, deliveryOptions(readiness, AT2)).status, 'FAIL', 'without the registry the record does not verify');
  assert.equal(emitFinalMml(project, { ...deliveryOptions(readiness, AT2), releaseEvidenceRegistry: registry }).status, 'PASS');
  assert.equal(finalEmissionEntry(readiness), null, 'checked with the registry it was graded with');
  assert.equal(readiness.machineDelivery.ready, true);
});

test('a candidate the emitter writes keeps exactly the delivery answer it had', () => {
  const project = candidate('clean', [note(0, 1, 'a'), note(2, 3, 'b'), note(0, 4, 'c', 'Chord1', 48)]);
  for (const canonical of [AT1, AT2]) {
    const readiness = readinessOf(project, canonical);
    assert.equal(readiness.machineDelivery.ready, true);
    assert.deepEqual(readiness.machineDelivery, evaluateMachineDelivery(readiness.gates, { canonical }), 'identical to the gate map\'s own answer');
    assert.deepEqual(deliveryBlockingGates(readiness), []);
  }
});

// ── through the application: finalize and the run ─────────────────────────

// The six-role fixture with a real Tempo change one tick before beat 3: G10
// has nothing to say about it, and the Chord notes it crosses cannot be split
// there.
function tempoClassBaseline() {
  const source = sixRoleBaseline({ id: 'fixture:unreachable-tempo' });
  return createCanonicalProject({
    ...source,
    tempoEvents: [
      ...source.tempoEvents,
      createCanonicalTempoEvent({ id: 'tempo-2', beat: early(3), bpm: 100, sourceIds: [FIXTURE_SOURCE_ID], sourceEventIds: [`${FIXTURE_SOURCE_ID}#tempo-2`] }),
    ],
  });
}

async function tempoClassCandidate(app, owner) {
  const own = await projectWithSymbolicAsset(app, owner, { project: tempoClassBaseline() });
  await app.analyzeSources(owner, own.projectId, { assetIds: [own.assetId] });
  const applied = await app.applyDecisions(owner, own.projectId, { decisions: runDecisionsFor(own.project) });
  assert.equal(applied.decisions.applied, true, JSON.stringify(applied.decisions.rejected ?? null));
  return { projectId: own.projectId, candidateId: applied.decisions.candidate_id };
}

test('finalize: the emitter\'s refusal is the finalEmission entry, not a bare technical NOT_RUN', async () => {
  const OWNER = 'owner:final-emission';
  const app = createStudioApplication({});
  const { projectId, candidateId } = await tempoClassCandidate(app, OWNER);
  const result = await app.finalize(OWNER, projectId, { candidateId, confirmations: FIXTURE_CONFIRMATIONS });
  assert.equal(result.emit_status, 'FAIL');
  assert.equal(result.mml, null);
  assert.equal(result.artifact_id, null);
  assert.ok(result.diagnostics.some(item => item.code === 'BOUNDARY_NOT_FINAL_REPRESENTABLE'), JSON.stringify(result.diagnostics.map(item => item.code)));
  assert.equal(result.readiness.gates.microTiming.status, 'PASS', 'G10 has nothing to say about the Tempo Map');
  assert.equal(result.gates.technical, 'NOT_RUN', 'nothing was emitted, so nothing was graded');
  assert.deepEqual(result.blockers, ['technical', 'finalEmission']);
  assert.equal(result.machine_delivery.ready, false);
  const entry = result.machine_delivery.blocking.find(item => item.gate === 'finalEmission');
  assert.deepEqual(entry.blockers, ['FINAL_EMISSION_REFUSED']);
  assert.equal(entry.emitter_status, 'FAIL');
  assert.deepEqual(entry.emitter_diagnostics, result.diagnostics, 'the emitter\'s answer, verbatim');
});

test('the run halts at finalize on the emitter\'s refusal, carries its diagnostics, and names no operation', async () => {
  const OWNER = 'owner:final-emission-run';
  const app = createStudioApplication({});
  const { projectId, candidateId } = await tempoClassCandidate(app, OWNER);
  const { run } = await app.startRun(OWNER, projectId, { target_candidate_id: candidateId, confirmations: FIXTURE_CONFIRMATIONS });
  assert.equal(run.state, RUN_STATE.AWAITING_REVIEW, JSON.stringify(run.blockers));
  assert.equal(run.final_artifact_id, null);
  const finalize = run.steps.find(step => step.step === RUN_STEP.FINALIZE);
  assert.equal(finalize.status, RUN_STEP_STATUS.BLOCKED);
  // The finalize request's gates, then the codes of each gate's own request.
  assert.deepEqual([...run.blockers], ['technical', 'finalEmission', 'FINAL_EMISSION_REFUSED']);
  assert.equal(run.machine_delivery.ready, false);
  const request = run.review_requests.find(item => item.gate === 'finalEmission');
  assert.ok(request, JSON.stringify(run.review_requests.map(item => item.gate)));
  assert.equal(request.known, true);
  assert.deepEqual(request.blockers, ['FINAL_EMISSION_REFUSED']);
  assert.equal(request.report_reference, 'readiness.machineDelivery.blocking.finalEmission');
  assert.deepEqual(request.available_operations, [], 'no operation answers a refusal as such');
  assert.deepEqual(request.missing, [READINESS_BLOCKER_WITHOUT_OPERATION.finalEmission.FINAL_EMISSION_REFUSED]);
  assert.equal(request.detail.emitter_status, 'FAIL');
  assert.ok(request.detail.emitter_diagnostics.some(item => item.code === 'BOUNDARY_NOT_FINAL_REPRESENTABLE' && item.severity === 'error'));
});
