// Studio Application Service — contract regressions.
//
// Covers the layer's own promises: capability discovery, Canonical provenance,
// the fail-closed Canonical gate, identity, ownership isolation, asset
// integrity and the job lifecycle. The pipeline itself is covered by
// `application-pipeline.test.mjs`; nothing here asserts a musical verdict.

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  ASSET_KIND_INTAKE,
  ASSET_KIND_NAMES,
  ERROR_CODES,
  GATE_NAMES,
  createStudioApplication,
} from '../backend/application/index.mjs';
import { SOURCE_KINDS } from '../backend/canonical/index.mjs';
import { canonicalProjectBytes, sixRoleBaseline } from './fixtures/application-fixtures.mjs';

const OWNER = 'owner:alice';
const OTHER = 'owner:bob';

const app = (options = {}) => createStudioApplication(options);
const bytesOf = text => new TextEncoder().encode(text);

async function rejects(promise, code) {
  try {
    await promise;
    assert.fail(`expected ${code}`);
  } catch (error) {
    assert.equal(error.name, 'StudioApplicationError', `expected a structured error, got: ${error.message}`);
    assert.equal(error.code, code);
    return error;
  }
}

const newProject = async (service, owner = OWNER, title = 'Test project') =>
  (await service.createProject(owner, { title })).project;

// ─── capabilities ───────────────────────────────────────────────────────────

test('capabilities report what this build does, not what it wishes it did', async () => {
  const service = app({ transports: ['direct', 'http', 'mcp'] });
  const caps = await service.capabilities();

  assert.equal(caps.interface, 'studio-application/v1');
  assert.equal(caps.model_agnostic, true);
  assert.deepEqual(caps.transports, ['direct', 'http', 'mcp']);

  // The audio worker is an evidence alignment layer. It must never be
  // advertised as transcription, separation or isolation.
  assert.equal(caps.capabilities.audio_alignment, true);
  assert.equal(caps.capabilities.audio_to_midi, false);
  assert.equal(caps.capabilities.source_separation, false);
  assert.equal(caps.capabilities.vocal_isolation, false);
  assert.equal(caps.capabilities.exact_pitch_transcription_from_audio, false);
  assert.equal(caps.audio.role, 'original-audio-evidence-alignment');
  for (const claim of ['exact_pitch_truth', 'vocal_identity', 'octave_correctness', 'lead_deletion_decision', 'final_arrangement_superiority']) {
    assert.ok(caps.audio.does_not_produce.includes(claim), `audio must disclaim ${claim}`);
  }

  // No in-game testing exists here, and the gate can never be set by this side.
  assert.equal(caps.capabilities.in_game_test, false);
  assert.ok(caps.gates.never_settable_by_this_service.includes('in_game'));
  assert.ok(!caps.gates.settable_by_this_service.includes('in_game'));
  assert.deepEqual([...caps.gates.axes], [...GATE_NAMES]);

  // Gate 8 is settable only through the explicit candidate-bound,
  // evidence-backed review confirmation. Parser/emitter success never sets it.
  assert.ok(caps.gates.settable_by_this_service.includes('mobile_adaptation'));
  assert.ok(!caps.gates.not_implemented_in_this_build.includes('mobile_adaptation'));
  assert.ok(!caps.gates.not_implemented_in_this_build.includes('in_game'));
  assert.ok(!caps.gates.never_settable_by_this_service.includes('mobile_adaptation'));

  // Gate 9 has the same trust shape: explicit candidate-bound evidence, never
  // inferred from a clean diff or a passing test suite.
  assert.ok(caps.gates.settable_by_this_service.includes('regression'));
  assert.ok(!caps.gates.not_implemented_in_this_build.includes('regression'));
  assert.ok(!caps.gates.never_settable_by_this_service.includes('regression'));
  // Every axis is accounted for by exactly one of the three lists, so a future
  // axis cannot be added without saying which it is.
  const classified = [
    ...caps.gates.settable_by_this_service,
    ...caps.gates.not_implemented_in_this_build,
    ...caps.gates.never_settable_by_this_service,
  ];
  assert.deepEqual([...classified].sort(), [...GATE_NAMES].sort());
});

// `axes` is the Acceptance gate vocabulary, not the list of things that can
// block a Final. Readiness has its own pre-game gates and every one of them
// reaches `blockers`, so a capability record that published only `axes` beside
// an empty `not_implemented_in_this_build` read as a complete inventory and was
// not one: an agent would meet a refusal naming `core3Completeness` or
// `leadPromotion` without ever having seen the name.
test('capabilities name every readiness gate that can block a Final, and name them correctly', async () => {
  const caps = await app().capabilities();
  const { evaluateProjectReadiness } = await import('../backend/final/index.mjs');

  // Transcribed, not imported, so the record survives an unavailable Canonical.
  // Equality with the real readiness gate set is what stops it drifting.
  const readiness = evaluateProjectReadiness({ project: sixRoleBaseline() });
  const blocking = new Set([...readiness.preGameBlocking, ...Object.keys(readiness.gates)]);
  for (const name of caps.gates.readiness_gates_that_block_final) {
    assert.ok(blocking.has(name), `${name} is advertised as a readiness gate but readiness does not report it`);
  }
  // The pre-game set is what decides `candidateReady`, so nothing in it may be
  // missing from the record.
  const everBlocking = Object.keys(readiness.gates).filter(name => name !== 'inGameAcceptance');
  for (const name of everBlocking) {
    assert.ok(
      caps.gates.readiness_gates_that_block_final.includes(name),
      `${name} can block a Final but is not advertised`,
    );
  }

  // The two Gate 4 axes and the two Lead axes are each named with the operation
  // that answers them, and no axis claims to be answerable by another's.
  const axes = Object.fromEntries(caps.gates.review_axes_settable_by_this_service.map(entry => [entry.axis, entry]));
  assert.equal(axes.core3_source_continuity.operation, 'approveCore3SourceChange');
  assert.equal(axes.core3_source_continuity.readiness_gate, 'core3');
  assert.equal(axes.core3_completeness.readiness_gate, 'core3Completeness');
  assert.ok(axes.core3_completeness.operation.includes('core3_completeness_reviewed'));
  for (const axis of ['lead_promotion', 'lead_demotion']) {
    assert.ok(axes[axis].operation.includes('reviewLeadEvidence'), `${axis} must name the re-review path`);
    assert.ok(!axes[axis].operation.includes('Core3'), 'a Lead operation is never a Core3 approval');
  }
  // Every named review axis is a readiness gate that actually exists.
  for (const entry of caps.gates.review_axes_settable_by_this_service) {
    assert.ok(blocking.has(entry.readiness_gate), `${entry.axis} names a readiness gate that does not exist`);
  }

  // The evidence rule an agent has to know before it records anything.
  for (const gate of ['Gate 8', 'Gate 9', 'Gate 4']) assert.ok(caps.gates.notice.includes(gate));
  assert.ok(caps.gates.notice.includes('core3_completeness'));
  assert.ok(/never a Core3 approval/.test(caps.gates.notice));
  assert.equal(caps.capabilities.lead_evidence_re_review, true);
  assert.equal(caps.capabilities.core3_source_change_approval, true);
});

test('capabilities state the zero-cost and no-LLM position as facts', async () => {
  const caps = await app().capabilities();
  assert.equal(caps.cost.additional_recurring_cost, 'NONE');
  assert.equal(caps.cost.external_paid_services, 'NONE');
  assert.equal(caps.cost.llm_api_dependency, 'NONE');
  assert.equal(caps.privacy.uploaded_assets_leave_this_service, false);
  assert.equal(caps.privacy.calls_external_analysis_services, false);
});

test('jobs are advertised as synchronous, not as a queue that does not exist', async () => {
  const caps = await app().capabilities();
  assert.equal(caps.jobs.background_execution, false);
  assert.equal(caps.jobs.job_cancellation, false);
  assert.equal(caps.jobs.execution_model, 'synchronous-completion');
  assert.deepEqual([...caps.jobs.lifecycle], ['queued', 'running', 'succeeded', 'failed', 'cancelled']);
});

test('an unconfigured store reports ephemeral durability rather than implying persistence', async () => {
  const memory = await app().capabilities();
  assert.equal(memory.asset_storage.durability, 'ephemeral');
  assert.equal(memory.asset_storage.backend, 'memory');

  const directory = await mkdtemp(join(tmpdir(), 'studio-app-'));
  try {
    const undeclared = await app({ dataDirectory: directory }).capabilities();
    assert.equal(undeclared.asset_storage.backend, 'filesystem');
    assert.equal(undeclared.asset_storage.durability, 'ephemeral', 'a filesystem the operator has not declared persistent is not persistent');

    const declared = await app({ dataDirectory: directory, durability: 'persistent' }).capabilities();
    assert.equal(declared.asset_storage.durability, 'persistent');
  } finally {
    await rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});

// ─── Canonical provenance ───────────────────────────────────────────────────

test('Canonical provenance keeps its five identities apart', async () => {
  const caps = await app().capabilities();
  const canonical = caps.canonical;
  assert.equal(canonical.status, 'CANONICAL_LOADED');
  assert.equal(canonical.canonical_version, '2026-09-13-v1');
  assert.equal(canonical.canonical_status, 'PUBLISHED');
  assert.match(canonical.rules_snapshot_sha, /^[0-9a-f]{40}$/);
  assert.match(canonical.manifest_commit, /^[0-9a-f]{40}$/);
  assert.match(canonical.published_main_head, /^[0-9a-f]{40}$/);
  assert.match(canonical.repository_head, /^[0-9a-f]{40}$/);
  assert.equal(canonical.pr_head, null);

  // The identities must not be collapsed into one another: the rules snapshot
  // predates the Manifest commit, and neither is a repository head.
  assert.notEqual(canonical.rules_snapshot_sha, canonical.manifest_commit);
  assert.notEqual(canonical.rules_snapshot_sha, canonical.repository_head);
  assert.notEqual(canonical.manifest_commit, canonical.rules_snapshot_sha);
  assert.equal(canonical.entry_point, 'docs/CANONICAL_MANIFEST.md');

  // There is no single merged "version" field a reader could mistake for the
  // release identity.
  assert.ok(!Object.hasOwn(canonical, 'version'));
});

test('every significant response carries the provenance envelope', async () => {
  const service = app();
  const created = await service.createProject(OWNER, { title: 'Provenance' });
  assert.equal(created.canonical.status, 'CANONICAL_LOADED');
  assert.equal(created.canonical.rules_snapshot_sha, (await service.capabilities()).canonical.rules_snapshot_sha);

  const fetched = await service.getProject(OWNER, created.project.project_id);
  assert.equal(fetched.canonical.manifest_commit, created.canonical.manifest_commit);
});

// ─── the fail-closed Canonical gate ─────────────────────────────────────────

test('an unloadable Published Canonical yields CANONICAL_NOT_LOADED with no fallback', async () => {
  const service = app({ loadEngines: async () => { throw Error('Published Manifest is unavailable'); } });

  const caps = await service.capabilities();
  assert.equal(caps.canonical.status, ERROR_CODES.CANONICAL_NOT_LOADED);
  assert.equal(caps.canonical.legacy_fallback_allowed, false);
  assert.equal(caps.canonical.rules_snapshot_sha, null, 'a failed load must not report a snapshot');
  assert.match(caps.canonical.authority_notice, /No legacy Skill, old Master, memory, Draft2, cached rule set or working-tree replacement/);

  const project = await newProject(service);
  await service.uploadAsset(OWNER, project.project_id, {
    kind: 'canonical_project', filename: 'b.json', mediaType: 'application/json', bytes: canonicalProjectBytes(),
  });

  // Every Canonical-aware operation refuses. None of them degrades to a
  // working-tree, legacy or cached rule set.
  await rejects(service.analyzeSources(OWNER, project.project_id), ERROR_CODES.CANONICAL_NOT_LOADED);
  await rejects(service.suggestArrangement(OWNER, project.project_id), ERROR_CODES.CANONICAL_NOT_LOADED);
  await rejects(service.reviewCandidate(OWNER, project.project_id, { candidateId: `g11d:rev:${'0'.repeat(64)}` }), ERROR_CODES.CANONICAL_NOT_LOADED);
  await rejects(service.finalize(OWNER, project.project_id, { candidateId: `g11d:rev:${'0'.repeat(64)}` }), ERROR_CODES.CANONICAL_NOT_LOADED);
});

test('a rules module that does not report a loaded release is refused', async () => {
  const service = app({ loadEngines: async () => ({ rules: { PUBLISHED_CANONICAL: { status: 'CANONICAL_NOT_LOADED' } } }) });
  const caps = await service.capabilities();
  assert.equal(caps.canonical.status, ERROR_CODES.CANONICAL_NOT_LOADED);
});

test('project and asset records still work while Canonical is unavailable', async () => {
  // Capability discovery is how an agent learns Canonical is down. If the whole
  // service refused, it could not learn it.
  const service = app({ loadEngines: async () => { throw Error('no published history'); } });
  const project = await newProject(service);
  const upload = await service.uploadAsset(OWNER, project.project_id, {
    kind: 'original_audio', filename: 'song.m4a', mediaType: 'audio/mp4', bytes: bytesOf('fake audio'),
  });
  assert.match(upload.asset.asset_id, /^ast_[0-9a-f]{32}$/);
  assert.equal(upload.canonical.status, ERROR_CODES.CANONICAL_NOT_LOADED);
});

test('a missing engine module is not reported as a Canonical failure', async () => {
  // A missing runtime dependency is an environment problem. Reporting it as
  // CANONICAL_NOT_LOADED would blame the published rules for it and would make
  // a test for that code start passing for the wrong reason.
  const { createCanonicalGate } = await import('../backend/application/provenance.mjs');
  const { EngineUnavailableError } = await import('../backend/application/provenance.mjs');
  const gate = createCanonicalGate({
    load: async () => { throw new EngineUnavailableError('Cannot find package fast-xml-parser'); },
  });
  await assert.rejects(gate.engines(), error => {
    assert.equal(error.code, ERROR_CODES.ENGINE_UNAVAILABLE);
    assert.notEqual(error.code, ERROR_CODES.CANONICAL_NOT_LOADED);
    return true;
  });
});

// ─── identity and ownership ─────────────────────────────────────────────────

test('project identities are opaque, generated and not guessable from content', async () => {
  const service = app();
  const first = await newProject(service, OWNER, 'Same title');
  const second = await newProject(service, OWNER, 'Same title');
  assert.match(first.project_id, /^prj_[0-9a-f]{32}$/);
  assert.notEqual(first.project_id, second.project_id, 'identical input must not collide into one project');
});

test('a project belonging to another owner is absent, not forbidden', async () => {
  const service = app();
  const mine = await newProject(service, OWNER);
  await rejects(service.getProject(OTHER, mine.project_id), ERROR_CODES.PROJECT_NOT_FOUND);
  await rejects(service.uploadAsset(OTHER, mine.project_id, {
    kind: 'current_mml', filename: 'x.mml', mediaType: 'text/plain', bytes: bytesOf('MML@;'),
  }), ERROR_CODES.PROJECT_NOT_FOUND);
  await rejects(service.analyzeSources(OTHER, mine.project_id), ERROR_CODES.PROJECT_NOT_FOUND);

  const theirs = await service.listProjects(OTHER);
  assert.deepEqual(theirs.projects, [], "another owner's project must not appear in a listing");
});

test('malformed identifiers are rejected by shape, before any lookup', async () => {
  const service = app();
  for (const bad of ['../../etc/passwd', 'prj_notahex', '', 'prj_' + 'g'.repeat(32), null, 42, '/etc/passwd']) {
    await rejects(service.getProject(OWNER, bad), ERROR_CODES.PROJECT_NOT_FOUND);
  }
  const project = await newProject(service);
  for (const bad of ['../secrets', 'ast_zz', 'C:\\windows\\system32']) {
    await rejects(service.getAsset(OWNER, project.project_id, bad), ERROR_CODES.ASSET_NOT_FOUND);
  }
  await rejects(service.getJob(OWNER, '../../job'), ERROR_CODES.JOB_NOT_FOUND);
  await rejects(service.getArtifact(OWNER, '../../artifact'), ERROR_CODES.ARTIFACT_NOT_FOUND);
});

// ─── assets ─────────────────────────────────────────────────────────────────

test('asset identity is generated and the digest is computed, never asserted', async () => {
  const service = app();
  const project = await newProject(service);
  const bytes = bytesOf('identical bytes');

  const first = (await service.uploadAsset(OWNER, project.project_id, { kind: 'current_mml', filename: 'a.mml', mediaType: 'text/plain', bytes })).asset;
  const second = (await service.uploadAsset(OWNER, project.project_id, { kind: 'current_mml', filename: 'b.mml', mediaType: 'text/plain', bytes })).asset;

  assert.notEqual(first.asset_id, second.asset_id, 'asset ids must be unique per upload');
  assert.equal(first.sha256, second.sha256, 'the digest describes the bytes, not the upload');
  assert.match(first.sha256, /^[0-9a-f]{64}$/);
  assert.equal(first.size, bytes.byteLength);
  assert.equal(first.project_id, project.project_id);
});

test('the upload filename is metadata and never becomes a path or an identity', async () => {
  const service = app();
  const project = await newProject(service);
  const hostile = '../../../../etc/passwd';
  const asset = (await service.uploadAsset(OWNER, project.project_id, {
    kind: 'current_mml', filename: hostile, mediaType: 'text/plain', bytes: bytesOf('MML@;'),
  })).asset;

  // Echoed back for a human, and inert: the id is what addresses the bytes.
  assert.equal(asset.filename, hostile);
  assert.match(asset.asset_id, /^ast_[0-9a-f]{32}$/);
  assert.ok(!asset.asset_id.includes('..'));
  assert.ok(!asset.asset_id.includes('/'));

  const read = service.readAssetBytes(OWNER, project.project_id, asset.asset_id);
  assert.deepEqual([...read.bytes], [...bytesOf('MML@;')]);
});

test('an unknown asset kind is refused rather than guessed', async () => {
  const service = app();
  const project = await newProject(service);
  await rejects(service.uploadAsset(OWNER, project.project_id, {
    kind: 'official-midi', filename: 'x.mid', mediaType: 'audio/midi', bytes: bytesOf('x'),
  }), ERROR_CODES.INVALID_ASSET_KIND);
  await rejects(service.uploadAsset(OWNER, project.project_id, {
    kind: 'anything', filename: 'x.mid', mediaType: 'audio/midi', bytes: bytesOf('x'),
  }), ERROR_CODES.INVALID_ASSET_KIND);
});

test('every asset kind maps onto the existing Canonical source vocabulary', async () => {
  // The underscored wire spelling must never become a second Canonical source
  // vocabulary: each symbolic kind names a real `SOURCE_KINDS` member.
  for (const kind of ASSET_KIND_NAMES) {
    const wiring = ASSET_KIND_INTAKE[kind];
    assert.ok(wiring, `${kind} has no intake wiring`);
    if (wiring.canonicalKind !== null) {
      assert.ok(SOURCE_KINDS.includes(wiring.canonicalKind), `${kind} maps to ${wiring.canonicalKind}, which is not a Canonical source kind`);
    }
    if (wiring.intake) assert.ok(wiring.adapter, `${kind} claims intake but names no adapter`);
  }
});

test('an asset id from another project is not found in this one', async () => {
  const service = app();
  const mine = await newProject(service, OWNER, 'Mine');
  const other = await newProject(service, OWNER, 'Other');
  const asset = (await service.uploadAsset(OWNER, mine.project_id, {
    kind: 'current_mml', filename: 'a.mml', mediaType: 'text/plain', bytes: bytesOf('MML@;'),
  })).asset;

  await rejects(service.getAsset(OWNER, other.project_id, asset.asset_id), ERROR_CODES.ASSET_NOT_FOUND);
});

test('oversized, empty and unknown-media-type uploads are bounded', async () => {
  const service = app();
  const project = await newProject(service);
  await rejects(service.uploadAsset(OWNER, project.project_id, {
    kind: 'current_mml', filename: 'x', mediaType: 'text/plain', bytes: new Uint8Array(0),
  }), ERROR_CODES.INVALID_REQUEST);
  await rejects(service.uploadAsset(OWNER, project.project_id, {
    kind: 'original_audio', filename: 'x', mediaType: 'application/x-msdownload', bytes: bytesOf('x'),
  }), ERROR_CODES.INVALID_REQUEST);

  const small = app({ maxStoreBytes: 8 });
  const tiny = await newProject(small);
  await rejects(small.uploadAsset(OWNER, tiny.project_id, {
    kind: 'original_audio', filename: 'x', mediaType: 'audio/mp4', bytes: bytesOf('more than eight bytes'),
  }), ERROR_CODES.STORAGE_FULL);
});

// ─── jobs ───────────────────────────────────────────────────────────────────

test('a job records queued, running and its terminal state', async () => {
  const service = app();
  const project = await newProject(service);
  await service.uploadAsset(OWNER, project.project_id, {
    kind: 'canonical_project', filename: 'b.json', mediaType: 'application/json', bytes: canonicalProjectBytes(),
  });

  const { job } = await service.analyzeSources(OWNER, project.project_id);
  assert.match(job.job_id, /^job_[0-9a-f]{32}$/);
  assert.equal(job.project_id, project.project_id);
  assert.equal(job.type, 'intake');
  assert.equal(job.status, 'succeeded');
  assert.deepEqual(job.transitions.map(entry => entry.status), ['queued', 'running', 'succeeded']);
  assert.ok(job.started_at && job.finished_at);
  assert.ok(job.result_reference.startsWith('bas:'), 'a succeeded job must point at what it produced');

  const looked = await service.getJob(OWNER, job.job_id);
  assert.equal(looked.job.job_id, job.job_id);
  assert.equal(looked.job.status, 'succeeded');
});

test('a failed job records the failure it reached and the error that caused it', async () => {
  const service = app();
  const project = await newProject(service);
  // No symbolic asset: intake refuses, and the job must say so rather than
  // disappearing or reporting success.
  await rejects(service.analyzeSources(OWNER, project.project_id), ERROR_CODES.SOURCE_INCOMPLETE);

  const jobs = (await service.listJobs(OWNER, project.project_id)).jobs;
  assert.equal(jobs.length, 1);
  assert.equal(jobs[0].status, 'failed');
  assert.deepEqual(jobs[0].transitions.map(entry => entry.status), ['queued', 'running', 'failed']);
  assert.equal(jobs[0].error.code, ERROR_CODES.SOURCE_INCOMPLETE);
  assert.equal(jobs[0].result_artifact_id, null);
});

test('a job belonging to another owner is not found', async () => {
  const service = app();
  const project = await newProject(service);
  await service.uploadAsset(OWNER, project.project_id, {
    kind: 'canonical_project', filename: 'b.json', mediaType: 'application/json', bytes: canonicalProjectBytes(),
  });
  const { job } = await service.analyzeSources(OWNER, project.project_id);
  await rejects(service.getJob(OTHER, job.job_id), ERROR_CODES.JOB_NOT_FOUND);
});

// ─── durability ─────────────────────────────────────────────────────────────

test('a filesystem store survives a new service over the same directory', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'studio-app-'));
  try {
    const first = app({ dataDirectory: directory, durability: 'persistent' });
    const project = await newProject(first, OWNER, 'Durable');
    const asset = (await first.uploadAsset(OWNER, project.project_id, {
      kind: 'current_mml', filename: 'a.mml', mediaType: 'text/plain', bytes: bytesOf('MML@t120o4c1,,,,,;'),
    })).asset;

    const second = app({ dataDirectory: directory, durability: 'persistent' });
    const reopened = await second.getProject(OWNER, project.project_id);
    assert.equal(reopened.project.title, 'Durable');
    assert.equal(reopened.project.assets.length, 1);
    assert.equal(reopened.project.assets[0].asset_id, asset.asset_id);
    assert.deepEqual([...second.readAssetBytes(OWNER, project.project_id, asset.asset_id).bytes], [...bytesOf('MML@t120o4c1,,,,,;')]);
  } finally {
    await rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});

// ─── technical validation routing ───────────────────────────────────────────

test('Canonical technical validation fails closed without Published Canonical', async () => {
  // The operation advertises a current Canonical / Strict Mobile verdict, so an
  // environment that cannot load the published rules gets a refusal. Answering
  // it from the legacy core instead would report a non-Canonical verdict under
  // a Canonical name, and the two engines disagree in both directions.
  const service = app({ loadEngines: async () => { throw Error('no published history'); } });
  await assert.rejects(
    () => service.validateTechnicalMml({ mml: 'MML@t120o4c1,,,,,;', meter_text: '0 4/4' }),
    error => error.code === ERROR_CODES.CANONICAL_NOT_LOADED,
  );
  await assert.rejects(
    () => service.technicalOverlapDetails({ mml: 'MML@t120o4c1,,,,,;', meter_text: '0 4/4' }),
    error => error.code === ERROR_CODES.CANONICAL_NOT_LOADED,
  );
});

test('the legacy diagnostic stays reachable without Published Canonical and claims no Canonical PASS', async () => {
  // It always ran on the legacy core. A layer that is meant to be additive must
  // not take that capability away from an environment that had it -- but it is
  // labelled for what it is, so a legacy PASS cannot be read as a Canonical one.
  const service = app({ loadEngines: async () => { throw Error('no published history'); } });
  const report = service.legacyTechnicalDiagnostic({ mml: 'MML@t120o4c1,,,,,;', meter_text: '0 4/4' });
  assert.equal(report.authority, 'LEGACY_DIAGNOSTIC');
  assert.equal(report.technical_ok, null);
  assert.equal(report.legacy_technical_ok, true);
  assert.equal(report.gates.strict_mobile_technical, 'NOT_RUN');
  assert.equal(report.gates.legacy_diagnostic, 'PASS');
  assert.equal(report.gates.in_game_acceptance, 'PENDING');
  assert.equal(report.changed_input, false);
});

test('a Canonical technical PASS is labelled as one', async () => {
  const service = app();
  const report = await service.validateTechnicalMml({ mml: 'MML@t120o4c1,,,,,;', meter_text: '0 4/4' });
  assert.equal(report.authority, 'PUBLISHED_CANONICAL');
  assert.equal(report.technical_ok, true);
  assert.equal(report.legacy_technical_ok, undefined);
  assert.equal(report.gates.strict_mobile_technical, 'PASS');
});

test('technical validation keeps its preflight bounds on both engines', async () => {
  const service = app();
  await assert.rejects(() => service.validateTechnicalMml({ mml: 'MML@t1200o4c1,,,,,;', meter_text: '0 4/4' }), /三位數安全界限/);
  await assert.rejects(() => service.validateTechnicalMml({ mml: 'MML@t120o4c1,,,,,;', meter_text: '0 4/4', pickup: 'abc' }), /pickup/);
  assert.throws(() => service.legacyTechnicalDiagnostic({ mml: 'MML@t1200o4c1,,,,,;', meter_text: '0 4/4' }), /三位數安全界限/);
  assert.throws(() => service.legacyTechnicalDiagnostic({ mml: 'MML@t120o4c1,,,,,;', meter_text: '0 4/4', pickup: 'abc' }), /pickup/);
});

test('a later engine failure keeps the loaded Canonical identity and never reads as CANONICAL_NOT_LOADED', async () => {
  // The two failures are different facts and must never be confused:
  //
  //   the published rules would not load        -> CANONICAL_NOT_LOADED
  //   the rules loaded, a later engine did not  -> ENGINE_UNAVAILABLE
  //
  // Reporting the second as the first blames the published release for an
  // environment fault, and makes the operation and the provenance contradict
  // each other — one refusing with ENGINE_UNAVAILABLE while the other claims
  // nothing was ever loaded.
  const { createCanonicalGate, EngineUnavailableError } = await import('../backend/application/provenance.mjs');
  const { PUBLISHED_CANONICAL } = await import('../backend/rules/index.mjs');
  assert.equal(PUBLISHED_CANONICAL.status, 'CANONICAL_LOADED', 'this regression needs the real published release');

  // Stage 1 completes with the real rules module, exactly as production does;
  // stage 2 then fails. Nothing here fabricates an identity.
  const gate = createCanonicalGate({
    load: async ({ recordPublished }) => {
      recordPublished(PUBLISHED_CANONICAL);
      throw new EngineUnavailableError("Cannot find package 'fast-xml-parser' imported from /app/studio/backend/score/musicxml.mjs");
    },
  });

  const provenance = await gate.provenance();
  assert.equal(provenance.status, 'CANONICAL_LOADED');
  assert.equal(await gate.loaded(), false, 'the engines are still not usable');

  // The real identities survive, all five kept apart.
  assert.equal(provenance.canonical_version, PUBLISHED_CANONICAL.metadata.canonical_version);
  assert.equal(provenance.rules_snapshot_sha, PUBLISHED_CANONICAL.metadata.rules_snapshot_sha);
  assert.equal(provenance.manifest_commit, PUBLISHED_CANONICAL.provenance.manifest_commit);
  assert.equal(provenance.published_main_head, PUBLISHED_CANONICAL.provenance.published_main_head);
  assert.equal(provenance.repository_head, PUBLISHED_CANONICAL.provenance.repository_head);
  assert.notEqual(provenance.rules_snapshot_sha, null);
  assert.notEqual(provenance.manifest_commit, provenance.rules_snapshot_sha);

  // The engine problem is named beside the release, not instead of it, and the
  // raw import message is not published: this envelope is served unauthenticated.
  assert.equal(provenance.engine_status, ERROR_CODES.ENGINE_UNAVAILABLE);
  assert.match(provenance.engine_notice, /Published Canonical loaded/);
  assert.ok(!JSON.stringify(provenance).includes('/app/studio'), 'provenance must not publish a container path');
  assert.ok(!JSON.stringify(provenance).includes('fast-xml-parser'), 'provenance must not publish a raw import failure');

  // And the operation refuses with the engine code, not the Canonical one.
  await assert.rejects(gate.engines(), error => {
    assert.equal(error.code, ERROR_CODES.ENGINE_UNAVAILABLE);
    assert.notEqual(error.code, ERROR_CODES.CANONICAL_NOT_LOADED);
    return true;
  });
});

test('a genuine rules failure still reports CANONICAL_NOT_LOADED with no retained identity', async () => {
  // The other half of the distinction. Nothing about the fix above may soften
  // the fail-closed answer when the published rules themselves do not load.
  const { createCanonicalGate } = await import('../backend/application/provenance.mjs');
  const gate = createCanonicalGate({ load: async () => { throw Error('Missing or invalid snapshot resource: docs/MASTER_RULES.md'); } });

  const provenance = await gate.provenance();
  assert.equal(provenance.status, ERROR_CODES.CANONICAL_NOT_LOADED);
  assert.equal(provenance.legacy_fallback_allowed, false);
  assert.equal(provenance.canonical_version, null);
  assert.equal(provenance.rules_snapshot_sha, null);
  assert.equal(provenance.manifest_commit, null);
  assert.equal(provenance.engine_status, undefined, 'this is not an engine problem');
  await assert.rejects(gate.engines(), error => error.code === ERROR_CODES.CANONICAL_NOT_LOADED);

  // A rules module that loads but reports no release is the same answer: a
  // recorded identity must come from a real CANONICAL_LOADED, never from a
  // module that merely resolved.
  const unloaded = createCanonicalGate({
    load: async ({ recordPublished }) => {
      recordPublished({ status: 'CANONICAL_NOT_LOADED', metadata: { rules_snapshot_sha: 'not-a-release' } });
      throw Error('rules module did not expose a loaded Published Canonical');
    },
  });
  const unloadedProvenance = await unloaded.provenance();
  assert.equal(unloadedProvenance.status, ERROR_CODES.CANONICAL_NOT_LOADED);
  assert.equal(unloadedProvenance.rules_snapshot_sha, null);
});
