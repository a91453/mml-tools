// ACCEPTANCE_CRITERIA Gate 7 through the Application Service.
//
// Gate 7 asks for beat<->recording alignment evidence AND a review of the role /
// prominence / sustain / articulation / recording-structure questions. Before
// this, the service passed `originalAudio` on warning-free evidence alone while
// Studio Web already required its own `audio` review -- a parity hole any agent
// caller could walk through. These pin the closed behaviour.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createStudioApplication } from '../backend/application/index.mjs';
import { createStore } from '../backend/application/store.mjs';
import { applyKeepOnlyCandidate, sixRoleBaseline } from './fixtures/application-fixtures.mjs';

const OWNER = 'owner:gate7';
const review = async (service, run) => (await service.reviewCandidate(OWNER, run.projectId, { candidateId: run.candidateId })).review;
const cleanReport = () => ({
  schema: 'mabinogi-mobile-mml-studio/audio-alignment@1',
  audio: { sha256: 'b'.repeat(64), filename: 'x.m4a' },
  symbolic: { project_id: `${sixRoleBaseline().id}#g11d-r1` },
  evidence_policy: { changes_symbolic_truth: false },
  alignment: { control_points: [{ beat: 0, seconds: 0 }, { beat: 4, seconds: 2 }], metrics: { confidence: 0.92, score_frame_coverage: 0.99, audio_frame_coverage: 0.95 } },
});
const gate7 = (run, over = {}) => ({ original_audio_reviewed: { value: true, reason: 'Role/prominence/sustain/articulation reviewed against the recording.', evidence: ['fixture:listening notes'], candidate_id: run.candidateId, ...over } });

test('G7-1 without active audio evidence there is nothing to review: the Gate 7 review is refused', async () => {
  const service = createStudioApplication();
  const run = await applyKeepOnlyCandidate(service, OWNER);
  await assert.rejects(() => service.recordConfirmations(OWNER, run.projectId, gate7(run)), /needs active audio alignment evidence/);
  assert.deepEqual((await review(service, run)).readiness.gates.originalAudio.blockers, ['AUDIO_ALIGNMENT_EVIDENCE_MISSING']);
});

test('G7-2 clean evidence alone is PENDING; a reason-only review is refused; an evidenced review passes, bound to the revision', async () => {
  const service = createStudioApplication();
  const run = await applyKeepOnlyCandidate(service, OWNER);
  const attached = await service.attachAudioAlignment(OWNER, run.projectId, { candidateId: run.candidateId, report: cleanReport() });
  const before = await review(service, run);
  assert.equal(before.gates.audio, 'PENDING');
  assert.deepEqual(before.readiness.gates.originalAudio.blockers, ['ORIGINAL_AUDIO_GATE7_REVIEW_REQUIRED']);
  await assert.rejects(() => service.recordConfirmations(OWNER, run.projectId, gate7(run, { evidence: [] })), /requires at least one evidence reference/);
  await service.recordConfirmations(OWNER, run.projectId, gate7(run));
  const after = await review(service, run);
  assert.equal(after.gates.audio, 'PASS');
  assert.equal(after.confirmations.original_audio_reviewed.audio_report_sha256, attached.evidence.report_sha256);
  // A Gate 7 review is a candidate-bound reviewer record, never in_game.
  assert.equal(after.gates.in_game, 'PENDING');
});

test('G7-3 a review recorded as false keeps the gate PENDING', async () => {
  const service = createStudioApplication();
  const run = await applyKeepOnlyCandidate(service, OWNER);
  await service.attachAudioAlignment(OWNER, run.projectId, { candidateId: run.candidateId, report: cleanReport() });
  await service.recordConfirmations(OWNER, run.projectId, gate7(run, { value: false, evidence: [] }));
  assert.equal((await review(service, run)).gates.audio, 'PENDING');
});

test('G7-4 a review bound to another audio evidence revision is stale and does not count', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'g7-'));
  try {
    const service = createStudioApplication({ dataDirectory: dir, durability: 'persistent' });
    const run = await applyKeepOnlyCandidate(service, OWNER);
    await service.attachAudioAlignment(OWNER, run.projectId, { candidateId: run.candidateId, report: cleanReport() });
    await service.recordConfirmations(OWNER, run.projectId, gate7(run));
    assert.equal((await review(service, run)).gates.audio, 'PASS');
    // Simulate a restored/edited record whose review names a different revision.
    const store = createStore({ directory: dir, durability: 'persistent' });
    const record = store.readProjectRecord(run.projectId);
    store.writeProjectRecord({ ...record, confirmations: { ...record.confirmations, original_audio_reviewed: { ...record.confirmations.original_audio_reviewed, audio_report_sha256: 'e'.repeat(64) } } });
    const after = await review(service, run);
    assert.equal(after.gates.audio, 'PENDING');
    assert.ok(after.stale_confirmations.some(entry => entry.name === 'original_audio_reviewed' && entry.reason === 'AUDIO_EVIDENCE_REVISION_CHANGED'));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('G7-5 finalize reads the same Gate 7 review (no path review does not see)', async () => {
  const service = createStudioApplication();
  const run = await applyKeepOnlyCandidate(service, OWNER);
  await service.attachAudioAlignment(OWNER, run.projectId, { candidateId: run.candidateId, report: cleanReport() });
  const blocked = await service.finalize(OWNER, run.projectId, { candidateId: run.candidateId });
  assert.equal(blocked.operation, 'blocked');
  assert.ok(JSON.stringify(blocked).includes('originalAudio'));
});
