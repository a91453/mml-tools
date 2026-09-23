// Final emission of releases held provisionally for delivery, and of a Tempo
// Map without same-value restatements (ACCEPTANCE_CRITERIA "Delivered first,
// flagged for listening"; MOBILE_SYNTAX §4, §7; 2026-09-23-v3).
//
// Every Canonical identity here is constructed and injected explicitly, so each
// test states the @2 outcome and the @1 outcome whichever release the published
// Manifest on origin/main names. The fixture is synthetic
// (fixtures/release-fixtures.mjs): every release one 480-tpq tick early.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { F, f, ROLES } from '../backend/mml/index.mjs';
import { splitMML, parseTrack, validateMML } from '../backend/mml/parser.mjs';
import {
  createSource,
  createCanonicalNoteEvent,
  createCanonicalTempoEvent,
  createCanonicalProject,
} from '../backend/canonical/index.mjs';
import { evaluateProjectReadiness } from '../backend/final/readiness.mjs';
import { emitFinalMml } from '../backend/final/mml-emitter.mjs';
import { EMIT_DIAGNOSTICS } from '../backend/final/emitter-contract.mjs';
import { enforceMicroGaps } from '../backend/final/micro-gap-enforcement.mjs';
import {
  PROVISIONAL_RENDERING_DIAGNOSTICS,
  renderProvisionalReleases,
  verifyProvisionalRenderingInvariants,
} from '../backend/final/technical-timing-repair.mjs';
import {
  DELIVERY_FLAG,
  MACHINE_DELIVERY_SCHEMA_V1,
  MACHINE_DELIVERY_SCHEMA_V2,
  deliveryBlockingGates,
} from '../backend/final/delivery-evaluator.mjs';
import { createStudioApplication } from '../backend/application/index.mjs';
import { createStore } from '../backend/application/store.mjs';
import { OWNER, ALL_RELEASE_EVENTS, assign, oneTickEarlyBaseline, roleDecisions } from './fixtures/release-fixtures.mjs';

const identity = (version, schema) => Object.freeze({ canonical_version: version, canonical_status: 'PUBLISHED', rules_snapshot_sha: 'd'.repeat(40), machine_delivery_schema: schema });
const AT1 = identity('2026-09-23-v2', MACHINE_DELIVERY_SCHEMA_V1);
const AT2 = identity('2026-09-23-v3', MACHINE_DELIVERY_SCHEMA_V2);

const ROLE_OF = { lead: 'Melody', harm: 'Chord1', bass: 'Chord2' };
// The synthetic baseline with its roles assigned, and itself as its own
// Source-Faithful Baseline: nothing moved, so every other gate can pass.
function assignedProject() {
  const base = oneTickEarlyBaseline();
  const events = base.events.map(event => ({ ...event, role: ROLE_OF[event.id.split('-')[0]] }));
  const snapshot = createCanonicalProject({ ...base, events, metadata: {} });
  return createCanonicalProject({ ...base, id: 'fixture:one-tick-early#assigned', events, metadata: { sourceComplete: true, sourceFaithfulBaseline: { snapshot } } });
}
const readinessOf = (project, canonical, mmlValidation = null) => evaluateProjectReadiness({
  project,
  mmlValidation,
  core3Report: { status: 'PASS', blockers: [] },
  core3CompletenessReport: { status: 'PASS', blockers: [] },
  harmonyReport: { status: 'PASS', unresolvedCount: 0 },
  originalAudioRequired: false,
  // Unresolved and never blocking: delivered for listening first, or after.
  playerReadback: 'NOT_RUN',
  mobileAdaptation: 'PENDING',
  regressionReviewed: false,
  canonical,
});
const MACHINE_DELIVERY_PATH = { provisionalReleaseRendering: true, collapseTempoRestatements: true };
const read = (mml, role) => parseTrack(splitMML(mml)[ROLES.indexOf(role)], role, { mode: 'final' });

test('under @2 the one-tick candidate is emitted with its releases held, round-trips, and is AUTOMATED_VALIDATED; under @1 it still refuses', () => {
  const project = assignedProject();
  const stored = JSON.stringify(project);

  // @2: readiness delivers micro-timing for listening first.
  const before = readinessOf(project, AT2);
  assert.equal(before.gates.microTiming.status, 'PENDING');
  assert.ok(before.gates.microTiming.blockers.includes('MICRO_TIMING_RELEASE_PROVISIONAL'));
  assert.deepEqual(deliveryBlockingGates(before), ['technical'], 'only the gate that grades the emitted MML is open');

  const emitted = emitFinalMml(project, { readiness: before, ...MACHINE_DELIVERY_PATH, canonical: AT2 });
  assert.equal(emitted.status, 'PASS', JSON.stringify(emitted.diagnostics.filter(item => item.severity !== 'notice')));
  assert.equal(emitted.roundTrip.status, 'PASS');
  assert.ok(emitted.diagnostics.some(item => item.code === EMIT_DIAGNOSTICS.PROVISIONAL_RELEASES_RENDERED));
  // What the result reports about micro-timing is the stored candidate: still unresolved.
  assert.equal(emitted.microGap.status, 'PENDING');
  assert.ok(emitted.microGap.blockedIntervalKeys.length > 0);

  const block = emitted.provisionalReleaseRendering;
  assert.equal(block.applied, true);
  assert.equal(block.machineDeliverySchema, MACHINE_DELIVERY_SCHEMA_V2);
  assert.equal(block.storedProjectId, project.id);
  assert.notEqual(block.renderedProjectId, project.id);
  assert.equal(block.roundTripAgainst, 'rendered-project');
  assert.deepEqual(block.renderings.map(item => item.eventId).sort(), [...ALL_RELEASE_EVENTS].sort());
  for (const item of block.renderings) {
    assert.equal(item.classification, 'UNKNOWN');
    assert.equal(item.representation, 'EXTEND_TO_NEXT_GRID');
    assert.equal(f(item.renderedRelease).sub(item.release).cmp(new F(1, 480)), 0, `${item.eventId} moves by exactly one tick`);
  }
  assert.deepEqual(new Set(block.renderings.flatMap(item => item.intervalKeys)), new Set(emitted.microGap.blockedIntervalKeys), 'every unproven interval is closed by a listed release');
  assert.equal(block.closedIntervalCount, emitted.microGap.blockedIntervalKeys.length);
  assert.equal(block.heldEventCount, ALL_RELEASE_EVENTS.length);
  assert.deepEqual(block.releaseOffsetSources.map(item => [item.dominantOffset, item.share, item.qualifies, item.provisionallyRendered, item.unresolved]), [['1 tick(s)', '8/8', true, 8, 0]]);

  // The emitted string: legal, attacks and pitches exactly the candidate's,
  // repeated attacks still two attacks, the real rest shorter by the held tick.
  const technical = validateMML(emitted.combinedMml, { meterText: '0 4/4' });
  assert.equal(technical.ok, true, JSON.stringify(technical.errors));
  assert.deepEqual(read(emitted.combinedMml, 'Melody').events.map(event => [event.pitch, event.start, event.end]), [[72, '0', '1'], [74, '1', '2'], [74, '2', '3'], [76, '3', '4']]);
  assert.equal(splitMML(emitted.combinedMml)[ROLES.indexOf('Melody')].includes('&'), false);
  assert.deepEqual(read(emitted.combinedMml, 'Chord2').events.map(event => [event.start, event.end]), [['0', '1'], ['2', '4']]);

  // After emission the song is AUTOMATED_VALIDATED, never VALIDATED, and the
  // ledger lists every provisionally rendered release.
  const after = readinessOf(project, AT2, technical);
  assert.equal(after.gates.technical.status, 'PASS');
  assert.equal(after.machineDelivery.ready, true);
  assert.equal(after.machineDelivery.lifecycle, 'AUTOMATED_VALIDATED');
  assert.equal(after.songState, 'CANDIDATE');
  const entry = after.machineDelivery.non_blocking_pending.find(item => item.gate === 'microTiming');
  assert.equal(entry.delivery_flag, DELIVERY_FLAG.RELEASES_RENDERED_PROVISIONALLY);
  assert.deepEqual(entry.provisional_releases.map(item => item.event_id).sort(), block.renderings.map(item => item.eventId).sort());
  assert.equal(JSON.stringify(project), stored, 'the stored candidate is never modified');

  // @1: the same candidate is refused, by readiness and by the emitter.
  const refused = readinessOf(project, AT1);
  assert.deepEqual(deliveryBlockingGates(refused), ['technical', 'microTiming']);
  const underAt1 = emitFinalMml(project, { readiness: refused, ...MACHINE_DELIVERY_PATH, canonical: AT1 });
  assert.equal(underAt1.status, 'PENDING');
  assert.equal(underAt1.combinedMml, null);
  assert.equal(underAt1.provisionalReleaseRendering.applied, false);
  assert.match(underAt1.provisionalReleaseRendering.reason, /BLOCKING under mabinogi-mobile-mml-studio\/machine-delivery@1/);
  assert.ok(underAt1.diagnostics.some(item => item.code === EMIT_DIAGNOSTICS.MICRO_GAP_BLOCKED_PENDING));

  // Without the machine-delivery opt-in (the Studio Web path) nothing is rendered, under either schema.
  for (const canonical of [AT1, AT2]) {
    const plain = emitFinalMml(project, { canonical });
    assert.equal(plain.status, 'PENDING');
    assert.equal(plain.provisionalReleaseRendering, null);
  }
  assert.equal(JSON.stringify(project), stored);
});

test('the renderer acts only on a fresh, current worklist', () => {
  const project = assignedProject();
  const other = oneTickEarlyBaseline();
  const stale = renderProvisionalReleases(project, { enforcement: enforceMicroGaps(createCanonicalProject({ ...project, id: 'other', events: project.events.slice(1) })) });
  assert.equal(stale.status, 'FAIL');
  assert.deepEqual(stale.diagnostics.map(item => item.code), [PROVISIONAL_RENDERING_DIAGNOSTICS.ENFORCEMENT_STALE]);
  assert.equal(stale.renderedProject, null);
  // Role-less material has unresolved stream identity: never release-side.
  const notEligible = renderProvisionalReleases(other);
  assert.equal(notEligible.status, 'PENDING');
  assert.deepEqual(notEligible.diagnostics.map(item => item.code), [PROVISIONAL_RENDERING_DIAGNOSTICS.NOT_ELIGIBLE]);
  assert.equal(notEligible.renderedProject, null);
});

test('the rendering invariants are checked on the produced project, not assumed from the plan', () => {
  const project = assignedProject();
  const rendered = renderProvisionalReleases(project);
  assert.equal(rendered.status, 'PASS');
  const holds = rendered.renderings.map(item => ({ eventId: item.eventId, role: item.role, release: item.release, heldTo: item.renderedRelease }));
  assert.deepEqual(verifyProvisionalRenderingInvariants(project, rendered.renderedProject, holds), []);
  const tamper = (label, change) => {
    const events = rendered.renderedProject.events.map(event => change(event) ?? event);
    const after = createCanonicalProject({ ...rendered.renderedProject, events });
    const violations = verifyProvisionalRenderingInvariants(project, after, holds);
    assert.ok(violations.length > 0, label);
    return violations;
  };
  tamper('an attack moved', event => (event.id === 'lead-2' ? { ...event, start: '1/2' } : null));
  tamper('a listed release held past its point', event => (event.id === 'lead-1' ? { ...event, end: '17/16' } : null));
  tamper('a pitch changed', event => (event.id === 'harm-1' ? { ...event, pitch: event.pitch + 1 } : null));
  // An unlisted note may not move at all.
  const partial = holds.filter(hold => hold.eventId !== 'bass-2');
  assert.ok(verifyProvisionalRenderingInvariants(project, rendered.renderedProject, partial).some(item => /bass-2 release moved without being listed/.test(item)));
  // The Tempo Map is never touched by the rendering.
  const retimed = createCanonicalProject({ ...rendered.renderedProject, tempoEvents: [createCanonicalTempoEvent({ id: 'tempo-1', beat: '0', bpm: 151, sourceIds: [project.sources[0].id] })] });
  assert.ok(verifyProvisionalRenderingInvariants(project, retimed, holds).includes('tempo or meter map changed'));
});

test('under @2 a same-value Tempo restatement is collapsed and recorded; a Tempo change never is; @1 is unchanged', () => {
  const source = createSource({ id: 'score', label: 'Synthetic score', kind: 'official-musicxml', authority: 'primary-symbolic' });
  const oneTickBeforeTwo = f(2).sub(new F(1, 480)).toString();
  const project = createCanonicalProject({
    id: 'tempo-restatement',
    title: 'Tempo restatement (synthetic)',
    sources: [source],
    events: [
      createCanonicalNoteEvent({ id: 'm', pitch: 72, start: '0', end: '4', role: 'Melody', sourceIds: ['score'] }),
      createCanonicalNoteEvent({ id: 'c', pitch: 60, start: '0', end: '4', role: 'Chord1', sourceIds: ['score'] }),
    ],
    tempoEvents: [
      createCanonicalTempoEvent({ id: 't0', beat: '0', bpm: 150, sourceIds: ['score'] }),
      // The same Tempo again, one tick before a grid point: no timing change at all.
      createCanonicalTempoEvent({ id: 't1', beat: oneTickBeforeTwo, bpm: 150, sourceIds: ['score'] }),
      // A real change, on the grid.
      createCanonicalTempoEvent({ id: 't2', beat: '3', bpm: 120, sourceIds: ['score'] }),
    ],
  });
  const collapsed = emitFinalMml(project, { ...MACHINE_DELIVERY_PATH, canonical: AT2 });
  assert.equal(collapsed.status, 'PASS', JSON.stringify(collapsed.diagnostics.filter(item => item.severity === 'error')));
  assert.equal(collapsed.roundTrip.status, 'PASS');
  assert.deepEqual(collapsed.tempoRestatements.collapsed, [{ tempoId: 't1', beat: oneTickBeforeTwo, bpm: 150, inEffectSince: '0', inEffectTempoId: 't0' }]);
  assert.ok(collapsed.diagnostics.some(item => item.code === EMIT_DIAGNOSTICS.TEMPO_RESTATEMENTS_COLLAPSED));
  // Both roles carry the same map: 150 from the start, 120 from beat 3.
  for (const role of ['Melody', 'Chord1']) assert.deepEqual(read(collapsed.combinedMml, role).tempo.map(item => [item.beat, item.bpm]), [['0', 150], ['3', 120]]);
  assert.equal(validateMML(collapsed.combinedMml, { meterText: '0 4/4' }).ok, true);

  // Under @1, or without the machine-delivery opt-in, the map is written as the
  // candidate carries it, and the off-grid restatement fails closed as before.
  for (const [canonical, options] of [[AT1, MACHINE_DELIVERY_PATH], [AT2, {}]]) {
    const unchanged = emitFinalMml(project, { ...options, canonical });
    assert.equal(unchanged.status, 'FAIL');
    assert.equal(unchanged.combinedMml, null);
    assert.ok(unchanged.diagnostics.some(item => item.code === EMIT_DIAGNOSTICS.DURATION_SEARCH_POLICY_LIMIT));
    assert.equal(unchanged.tempoRestatements?.applied ?? false, false);
  }
});

// ── through the Final service ───────────────────────────────────────────────

const CONFIRMATIONS = Object.freeze({
  source_complete: { value: true, reason: 'The synthetic fixture project is the complete material.' },
  player_readback: { value: 'N/A', reason: 'No preview or verification player is used for this synthetic cue.' },
  core3_completeness_reviewed: { value: true, reason: 'Melody, Chord1 and Chord2 stand as a one-player arrangement in the fixture.', evidence: ['fixture:gate-4'] },
  mobile_adaptation_reviewed: { value: true, reason: 'The fixture needs no Mobile adaptation beyond the listed releases.', evidence: ['fixture:gate-8'] },
  regression_reviewed: { value: true, reason: 'Compared against the Source-Faithful Baseline.', evidence: ['fixture:gate-9'] },
  original_audio_required: { value: false, reason: 'The synthetic workflow has no recording.' },
});

// The loaded engines, with the Canonical identity readiness and the emitter
// classify under replaced by `canonical`: the Final service itself is unchanged.
async function serviceUnder(canonical, directory) {
  const engines = await createStudioApplication({}).canonical.engines();
  return createStudioApplication({
    dataDirectory: directory,
    durability: 'persistent',
    loadEngines: async () => ({
      ...engines,
      final: {
        ...engines.final,
        evaluateProjectReadiness: input => engines.final.evaluateProjectReadiness({ ...input, canonical }),
        emitFinalMml: (project, options = {}) => engines.final.emitFinalMml(project, { ...options, canonical }),
      },
    }),
  });
}

async function candidate(service, decisions) {
  const baseline = oneTickEarlyBaseline();
  const created = (await service.createProject(OWNER, { title: 'Provisional release delivery' })).project;
  await service.uploadAsset(OWNER, created.project_id, { kind: 'canonical_project', filename: 'b.json', mediaType: 'application/json', bytes: new TextEncoder().encode(JSON.stringify(baseline)) });
  await service.analyzeSources(OWNER, created.project_id);
  const applied = await service.applyDecisions(OWNER, created.project_id, { decisions });
  assert.equal(applied.decisions.applied, true, JSON.stringify(applied.decisions.rejected ?? null));
  return { projectId: created.project_id, candidateId: applied.decisions.candidate_id };
}

async function withDirectory(work) {
  const directory = await mkdtemp(join(tmpdir(), 'mml-provisional-'));
  try { return await work(directory); } finally { await rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); }
}

test('the Final service delivers under @2 with every rendering recorded, and refuses the same input under @1', async () => withDirectory(async directory => {
  const at2 = await serviceUnder(AT2, join(directory, 'at2'));
  const { projectId, candidateId } = await candidate(at2, roleDecisions());
  const store = createStore({ directory: join(directory, 'at2') });
  const storedBefore = structuredClone(store.getJson(`application:${projectId}:${candidateId}`));

  // Refused on another gate first: the refusal's ledger already lists what
  // would be delivered provisionally.
  const { source_complete: _source, ...withoutSource } = CONFIRMATIONS;
  const blocked = await at2.finalize(OWNER, projectId, { candidateId, confirmations: withoutSource });
  assert.equal(blocked.operation, 'blocked');
  assert.deepEqual(blocked.blockers, ['source']);
  const pendingEntry = blocked.machine_delivery.non_blocking_pending.find(item => item.gate === 'microTiming');
  assert.equal(pendingEntry.delivery_flag, DELIVERY_FLAG.RELEASES_RENDERED_PROVISIONALLY);
  assert.equal(pendingEntry.provisional_releases.length, ALL_RELEASE_EVENTS.length);

  const delivered = await at2.finalize(OWNER, projectId, { candidateId, confirmations: CONFIRMATIONS });
  assert.equal(delivered.operation, 'succeeded', JSON.stringify(delivered.blockers));
  assert.match(delivered.mml, /^MML@/);
  const { artifact } = await at2.getArtifact(OWNER, delivered.artifact_id);
  assert.equal(artifact.machine_delivery.lifecycle, 'AUTOMATED_VALIDATED');
  assert.equal(artifact.machine_delivery.schema, MACHINE_DELIVERY_SCHEMA_V2);
  assert.equal(artifact.song_state, 'CANDIDATE', 'never VALIDATED while releases are provisional');
  assert.deepEqual(artifact.delivery.flags, [DELIVERY_FLAG.RELEASES_RENDERED_PROVISIONALLY]);
  assert.equal(artifact.readiness_summary.gates.microTiming, 'PENDING');
  assert.equal(artifact.gates.technical, 'PASS');
  assert.equal(artifact.micro_gap.status, 'PENDING');
  assert.equal(artifact.provisional_release_rendering.applied, true);
  assert.deepEqual(artifact.provisional_release_rendering.renderings.map(item => item.eventId).sort(), [...ALL_RELEASE_EVENTS].sort());
  assert.equal(artifact.tempo_restatements.applied, true);
  assert.deepEqual(artifact.tempo_restatements.collapsed, []);
  assert.deepEqual(store.getJson(`application:${projectId}:${candidateId}`), storedBefore, 'the stored candidate is unchanged');

  // @1: the same input is refused before the emitter runs.
  const at1 = await serviceUnder(AT1, join(directory, 'at1'));
  const again = await candidate(at1, roleDecisions());
  const refused = await at1.finalize(OWNER, again.projectId, { candidateId: again.candidateId, confirmations: CONFIRMATIONS });
  assert.equal(refused.operation, 'blocked');
  assert.deepEqual(refused.blockers, ['microTiming']);
  assert.equal(refused.mml, null);
  assert.equal(refused.artifact_id, null);
  assert.ok(refused.machine_delivery.blocking.some(item => item.gate === 'microTiming'));
}));

test('the Final service delivers role-less Melody material without Lead evidence under @2, flagged Lead unverified', async () => withDirectory(async directory => {
  const decisions = [
    ...['lead-1', 'lead-2', 'lead-3', 'lead-4'].map(id => assign(id, 'Melody', { leadEvidence: null })),
    ...['harm-1', 'harm-2'].map(id => assign(id, 'Chord1')),
    ...['bass-1', 'bass-2'].map(id => assign(id, 'Chord2')),
  ];
  const at2 = await serviceUnder(AT2, join(directory, 'at2'));
  const { projectId, candidateId } = await candidate(at2, decisions);
  const delivered = await at2.finalize(OWNER, projectId, { candidateId, confirmations: CONFIRMATIONS });
  assert.equal(delivered.operation, 'succeeded', JSON.stringify(delivered.blockers));
  assert.deepEqual(delivered.machine_delivery.delivery_flags, [DELIVERY_FLAG.RELEASES_RENDERED_PROVISIONALLY, DELIVERY_FLAG.LEAD_UNVERIFIED]);
  const lead = delivered.machine_delivery.non_blocking_pending.find(item => item.gate === 'leadPromotion');
  assert.deepEqual([...lead.unverified_lead_event_ids].sort(), ['lead-1', 'lead-2', 'lead-3', 'lead-4']);
  assert.equal(delivered.readiness.gates.leadPromotion.status, 'PENDING', 'unresolved, never PASS');
  // The Melody is delivered as arranged.
  assert.deepEqual(read(delivered.mml, 'Melody').events.map(event => [event.pitch, event.start]), [[72, '0'], [74, '1'], [74, '2'], [76, '3']]);

  const at1 = await serviceUnder(AT1, join(directory, 'at1'));
  const again = await candidate(at1, decisions);
  const refused = await at1.finalize(OWNER, again.projectId, { candidateId: again.candidateId, confirmations: CONFIRMATIONS });
  assert.equal(refused.operation, 'blocked');
  assert.deepEqual([...refused.blockers].sort(), ['leadPromotion', 'microTiming']);
}));
