// Studio Application Service — what finalize delivers, and what it refuses.
//
// A delivered Final is the one output of this service that leaves the
// building, so every path that ends without one has to say why, and every
// path that ends with one has to have earned it. These regressions pin the
// cases an adversarial review found answered wrongly:
//
//   - a piece whose last bar is partial could never satisfy the technical
//     gate, because the source-confirmed pickup / final_partial that the Final
//     parser accepts were never plumbed from the caller to the parser;
//   - a stored candidate that no longer agreed with itself or with the
//     baseline was emitted and filed as a Final;
//   - a candidate accepted under a different Published Canonical release was
//     finalized under the loaded one without a word;
//   - source completeness could be confirmed for a baseline that reports its
//     own inputs incomplete;
//   - a non-delivery was explained with the wrong sentence for the path taken,
//     and an emitter failure was recorded as a succeeded job.

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createStudioApplication, ERROR_CODES } from '../backend/application/index.mjs';
import { createStore } from '../backend/application/store.mjs';
import { createCanonicalNoteEvent, createCanonicalProject } from '../backend/canonical/index.mjs';
import { applyKeepOnlyCandidate, canonicalProjectBytes, keepEveryRole, sixRoleBaseline } from './fixtures/application-fixtures.mjs';

const OWNER = 'owner:alice';
const CONFIRMATIONS = Object.freeze({
  source_complete: { value: true, reason: 'The fixture is the complete material.' },
  player_readback: { value: 'N/A', reason: 'No preview or verification assets are used for this cue.' },
  mobile_adaptation_reviewed: { value: true, reason: 'The fixture candidate was reviewed against Gate 8 and needs no additional Mobile adaptation.', evidence: ['fixture Gate 8 review'] },
  regression_reviewed: { value: true, reason: 'The fixture candidate was reviewed against Gate 9.', evidence: ['fixture Gate 9 review'] },
  original_audio_required: { value: false, reason: 'The fixture workflow has no recording.' },
});

const rejects = (promise, code) => assert.rejects(promise, error => error.code === code || assert.fail(`expected ${code}, got ${error.code}: ${error.message}`));

async function uploaded(service, project, title) {
  const created = (await service.createProject(OWNER, { title })).project;
  await service.uploadAsset(OWNER, created.project_id, { kind: 'canonical_project', filename: 'b.json', mediaType: 'application/json', bytes: canonicalProjectBytes(project) });
  await service.analyzeSources(OWNER, created.project_id);
  return created.project_id;
}

async function withDirectory(work) {
  const directory = await mkdtemp(join(tmpdir(), 'mml-finalize-'));
  try { return await work(directory); } finally { await rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); }
}

test('a piece that ends on a partial bar is finalized only with the source-confirmed final_partial, which is carried on the artifact', async () => {
  const base = sixRoleBaseline();
  // One extra Melody beat past the last full 4/4 bar: bar two is one beat long.
  const partial = createCanonicalProject({
    ...base,
    id: 'fixture:partial-bar',
    events: [...base.events, createCanonicalNoteEvent({ id: 'melody-4', pitch: 74, start: '4', end: '5', sourceIds: ['fixture:official-midi'], sourceEventIds: ['fixture:official-midi#melody-4'], role: 'Melody', voice: 'melody', volume: null, metadata: {} })],
  });
  const service = createStudioApplication({});
  const projectId = await uploaded(service, partial, 'Partial bar');
  const candidateId = (await service.applyDecisions(OWNER, projectId, { decisions: keepEveryRole(partial) })).decisions.candidate_id;

  const bare = await service.finalize(OWNER, projectId, { candidateId, confirmations: CONFIRMATIONS });
  assert.equal(bare.operation, 'blocked', 'without the bar declaration the Final parser rejects the partial bar');
  assert.equal(bare.gates.technical, 'FAIL');
  assert.deepEqual(bare.blockers, ['technical']);
  assert.equal(bare.artifact_id, null);
  assert.deepEqual(bare.final_bar, { pickup: null, final_partial: null, meter_text: '0 4/4' });
  assert.match(bare.notice, /final_partial/, 'the refusal names the remedy that exists');

  for (const bad of [{ finalPartial: 'x;y' }, { pickup: 5 }, { finalPartial: '1'.repeat(33) }, { pickup: '' }]) {
    await rejects(service.finalize(OWNER, projectId, { candidateId, ...bad }), ERROR_CODES.INVALID_REQUEST);
  }

  const declared = await service.finalize(OWNER, projectId, { candidateId, finalPartial: '1' });
  assert.equal(declared.operation, 'succeeded');
  assert.equal(declared.gates.technical, 'PASS');
  assert.match(declared.mml, /^MML@/);
  assert.deepEqual(declared.final_bar, { pickup: null, final_partial: '1', meter_text: '0 4/4' });
  const { artifact } = await service.getArtifact(OWNER, declared.artifact_id);
  assert.deepEqual(artifact.final_bar, declared.final_bar, 'the bar declaration the Final was validated under is part of the record');
  assert.equal(artifact.mml, declared.mml);
});

test('legacy Final artifact reads add a lazy machine-delivery projection without mutating stored bytes', async () => withDirectory(async directory => {
  const first = createStudioApplication({ dataDirectory: directory, durability: 'persistent' });
  const run = await applyKeepOnlyCandidate(first, OWNER);
  const delivered = await first.finalize(OWNER, run.projectId, { candidateId: run.candidateId, confirmations: CONFIRMATIONS });
  assert.equal(delivered.operation, 'succeeded');
  assert.ok(delivered.artifact_id);

  const store = createStore({ directory });
  const key = `artifact:${run.projectId}:${delivered.artifact_id}`;
  const legacy = store.getJson(key);
  assert.ok(legacy.machine_delivery, 'new artifacts carry the projection before the legacy simulation');
  delete legacy.machine_delivery;
  if (legacy.readiness_summary) delete legacy.readiness_summary.machine_delivery;
  store.putJson(key, legacy);
  const before = structuredClone(store.getJson(key));

  const second = createStudioApplication({ dataDirectory: directory, durability: 'persistent' });
  const { artifact } = await second.getArtifact(OWNER, delivered.artifact_id);
  assert.equal(artifact.machine_delivery.schema, 'mabinogi-mobile-mml-studio/machine-delivery@1');
  assert.equal(artifact.machine_delivery.complete_gate_map, true);
  assert.equal(artifact.machine_delivery.projection_ready, true);
  assert.equal(artifact.machine_delivery.authoritative, false);
  assert.equal(artifact.machine_delivery.ready, false);
  assert.equal(artifact.machine_delivery.lifecycle, 'CANDIDATE');

  assert.deepEqual(store.getJson(key), before, 'artifact read migration is a pure projection and never rewrites storage');
}));

test('a stored candidate that no longer agrees with the baseline is not finalized', async () => withDirectory(async directory => {
  const first = createStudioApplication({ dataDirectory: directory, durability: 'persistent' });
  const run = await applyKeepOnlyCandidate(first, OWNER);
  const clean = await first.finalize(OWNER, run.projectId, { candidateId: run.candidateId, confirmations: CONFIRMATIONS });
  assert.equal(clean.operation, 'succeeded');

  // Chord5 moved up an octave in the stored application, in both the candidate
  // and its embedded baseline snapshot, so the record still agrees with
  // itself pairwise but not with the project's own Source-Faithful Baseline.
  const store = createStore({ directory });
  const key = `application:${run.projectId}:${run.candidateId}`;
  const application = store.getJson(key);
  const bump = event => (event.kind === 'note' && event.role === 'Chord5' ? { ...event, pitch: event.pitch + 12 } : event);
  application.candidate.events = application.candidate.events.map(bump);
  application.candidate.metadata.sourceFaithfulBaseline.snapshot.events = application.candidate.metadata.sourceFaithfulBaseline.snapshot.events.map(bump);
  store.putJson(key, application);

  const second = createStudioApplication({ dataDirectory: directory, durability: 'persistent' });
  const { review } = await second.reviewCandidate(OWNER, run.projectId, { candidateId: run.candidateId });
  assert.equal(review.integrity.ok, false, 'review already reports the record as inconsistent');

  const tampered = await second.finalize(OWNER, run.projectId, { candidateId: run.candidateId });
  assert.equal(tampered.operation, 'blocked', 'finalize must reach the same conclusion review does');
  assert.equal(tampered.code, ERROR_CODES.FINALIZATION_BLOCKED);
  assert.deepEqual(tampered.blockers, ['integrity']);
  assert.equal(tampered.integrity.ok, false);
  assert.equal(tampered.artifact_id, null);
  assert.equal(tampered.mml, null);
  const artifacts = (await second.getProject(OWNER, run.projectId)).project.artifacts;
  assert.equal(artifacts.length, 1, 'only the untampered Final was ever filed');
}));

test('a candidate accepted under another Published Canonical release is reported and not finalized under this one', async () => withDirectory(async directory => {
  const first = createStudioApplication({ dataDirectory: directory, durability: 'persistent' });
  const run = await applyKeepOnlyCandidate(first, OWNER);
  const engines = await first.canonical.engines();
  const loaded = engines.emitterContract.canonicalIdentity().rules_snapshot_sha;
  const other = 'f'.repeat(40);

  // A later process over the same volume, whose engines report another release.
  const second = createStudioApplication({
    dataDirectory: directory,
    durability: 'persistent',
    loadEngines: async () => ({ ...engines, emitterContract: { ...engines.emitterContract, canonicalIdentity: () => ({ ...engines.emitterContract.canonicalIdentity(), rules_snapshot_sha: other }) } }),
  });
  const { review } = await second.reviewCandidate(OWNER, run.projectId, { candidateId: run.candidateId, confirmations: CONFIRMATIONS });
  assert.equal(review.candidate_rules_snapshot_sha, loaded);
  assert.equal(review.loaded_rules_snapshot_sha, other);
  assert.ok(review.blockers.includes('canonical'), `review must name the release mismatch, got ${JSON.stringify(review.blockers)}`);

  const result = await second.finalize(OWNER, run.projectId, { candidateId: run.candidateId });
  assert.equal(result.operation, 'blocked');
  assert.deepEqual(result.blockers, ['canonical']);
  assert.equal(result.candidate_rules_snapshot_sha, loaded);
  assert.equal(result.loaded_rules_snapshot_sha, other);
  assert.equal(result.artifact_id, null);
  assert.equal(result.mml, null);
  assert.match(result.notice, /different Published Canonical rules snapshot/);
}));

test('source completeness cannot be confirmed for a baseline that reports its own inputs incomplete', async () => {
  const base = sixRoleBaseline();
  const incomplete = createCanonicalProject({ ...base, id: 'fixture:incomplete', metadata: { sourceComplete: false, incompleteInputs: ['fixture:official-midi'] } });
  const service = createStudioApplication({});
  const projectId = await uploaded(service, incomplete, 'Incomplete');
  const { baseline } = (await service.getProject(OWNER, projectId)).project;
  assert.equal(baseline.source_complete, false);
  assert.deepEqual(baseline.incomplete_inputs, ['fixture:official-midi']);

  await rejects(service.recordConfirmations(OWNER, projectId, { source_complete: { value: true, reason: 'claimed anyway' } }), ERROR_CODES.SOURCE_INCOMPLETE);
  const recorded = await service.recordConfirmations(OWNER, projectId, { source_complete: { value: false, reason: 'One source is still missing.' } });
  assert.equal(recorded.confirmations.source_complete.value, false, 'stating the incompleteness is still allowed');

  const candidateId = (await service.applyDecisions(OWNER, projectId, { decisions: keepEveryRole(incomplete) })).decisions.candidate_id;
  const result = await service.finalize(OWNER, projectId, { candidateId, confirmations: { player_readback: CONFIRMATIONS.player_readback, mobile_adaptation_reviewed: CONFIRMATIONS.mobile_adaptation_reviewed, regression_reviewed: CONFIRMATIONS.regression_reviewed, original_audio_required: CONFIRMATIONS.original_audio_required } });
  assert.equal(result.operation, 'blocked');
  assert.ok(result.blockers.includes('source'));
  assert.equal(result.artifact_id, null);
});

test('every non-delivery is explained for the path that was taken, and an emitter failure is a failed job', async () => {
  const service = createStudioApplication({});
  const run = await applyKeepOnlyCandidate(service, OWNER);

  const gates = await service.finalize(OWNER, run.projectId, { candidateId: run.candidateId });
  assert.equal(gates.operation, 'blocked');
  assert.match(gates.notice, /Nothing was emitted\. Required Canonical gates/);
  assert.equal(gates.job.status, 'succeeded', 'a blocked finalize is a completed job with a real answer');
  assert.equal(gates.job.result_operation, 'blocked');
  assert.equal(gates.job.error, null);

  const engines = await service.canonical.engines();
  const failingEmitter = createStudioApplication({
    loadEngines: async () => ({ ...engines, final: { ...engines.final, emitFinalMml: (project, options) => ({ ...engines.final.emitFinalMml(project, options), status: 'FAIL', combinedMml: null }) } }),
  });
  const failingRun = await applyKeepOnlyCandidate(failingEmitter, OWNER);
  const failed = await failingEmitter.finalize(OWNER, failingRun.projectId, { candidateId: failingRun.candidateId, confirmations: CONFIRMATIONS });
  assert.equal(failed.operation, 'failed');
  assert.equal(failed.gates.technical, 'NOT_RUN', 'nothing was emitted, so nothing was graded');
  assert.match(failed.notice, /The Final emitter reported FAIL/);
  assert.doesNotMatch(failed.notice, /did not satisfy the technical gate/, 'the parser never saw any MML');
  assert.equal(failed.job.status, 'failed');
  assert.equal(failed.job.result_operation, 'failed');
  assert.equal(failed.job.error.code, ERROR_CODES.FINALIZATION_BLOCKED);
  const { job } = await failingEmitter.getJob(OWNER, failed.job.job_id);
  assert.equal(job.status, 'failed', 'a later poll sees the same outcome');

  const base = sixRoleBaseline();
  const noMeter = createCanonicalProject({ ...base, id: 'fixture:no-meter', meterEvents: [] });
  const projectId = await uploaded(service, noMeter, 'No meter');
  const candidateId = (await service.applyDecisions(OWNER, projectId, { decisions: keepEveryRole(noMeter) })).decisions.candidate_id;
  const ungraded = await service.finalize(OWNER, projectId, { candidateId, confirmations: CONFIRMATIONS });
  assert.equal(ungraded.operation, 'blocked');
  assert.equal(ungraded.gates.technical, 'NOT_RUN');
  assert.equal(ungraded.technical_validation.run, false);
  assert.match(ungraded.notice, /declares no meter events/);
  assert.doesNotMatch(ungraded.notice, /did not satisfy the technical gate/);
});
