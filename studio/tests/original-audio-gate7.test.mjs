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

// Gate 7 is required when official audio is part of the source set. A reason
// string used to be enough to record `original_audio_required: false` while the
// project held the recording itself or audio evidence attached to a candidate,
// and review/finalize then reported the gate N/A. Studio Web already forces it
// required when audio is present; the service now refuses the statement, and
// review/finalize re-check it for a `false` stored before the audio arrived.
const notRequired = { original_audio_required: { value: false, reason: 'Declared not needed.' } };
const uploadRecording = (service, run) => service.uploadAsset(OWNER, run.projectId, {
  kind: 'original_audio', filename: 'song.m4a', mediaType: 'audio/mp4', bytes: new TextEncoder().encode('fixture original recording bytes'),
});
const refusedAsHeld = error => {
  assert.equal(error.code, 'INVALID_REQUEST');
  assert.match(error.message, /holds original audio/);
  assert.equal(error.details.confirmation, 'original_audio_required');
  return true;
};

test('G7-6 original_audio_required cannot be recorded false while the project holds an original_audio asset', async () => {
  const service = createStudioApplication();
  const run = await applyKeepOnlyCandidate(service, OWNER);
  const asset = (await uploadRecording(service, run)).asset;
  await assert.rejects(() => service.recordConfirmations(OWNER, run.projectId, notRequired), error => {
    refusedAsHeld(error);
    assert.deepEqual(error.details.original_audio_asset_ids, [asset.asset_id]);
    return true;
  });
  // Through review as well, and nothing it carried is recorded.
  await assert.rejects(() => service.reviewCandidate(OWNER, run.projectId, { candidateId: run.candidateId, confirmations: notRequired }), refusedAsHeld);
  const after = await review(service, run);
  assert.equal(after.confirmations.original_audio_required, undefined);
  assert.equal(after.readiness.gates.originalAudio.status, 'PENDING');
  assert.deepEqual(after.readiness.gates.originalAudio.blockers, ['AUDIO_ALIGNMENT_EVIDENCE_MISSING']);
  // A statement that audio IS required is still accepted.
  await service.recordConfirmations(OWNER, run.projectId, { original_audio_required: { value: true, reason: 'The recording is part of the source set.' } });
});

test('G7-7 original_audio_required cannot be recorded false while audio evidence is attached to a candidate', async () => {
  const service = createStudioApplication();
  const run = await applyKeepOnlyCandidate(service, OWNER);
  await service.attachAudioAlignment(OWNER, run.projectId, { candidateId: run.candidateId, report: cleanReport() });
  await assert.rejects(() => service.recordConfirmations(OWNER, run.projectId, notRequired), error => {
    refusedAsHeld(error);
    assert.deepEqual(error.details.audio_evidence_candidate_ids, [run.candidateId]);
    return true;
  });
  await assert.rejects(() => service.finalize(OWNER, run.projectId, { candidateId: run.candidateId, confirmations: notRequired }), refusedAsHeld);
  assert.deepEqual((await review(service, run)).readiness.gates.originalAudio.blockers, ['ORIGINAL_AUDIO_GATE7_REVIEW_REQUIRED']);
});

test('G7-8 a false recorded before the audio arrived no longer makes Gate 7 N/A in review or finalize', async () => {
  const service = createStudioApplication();
  const run = await applyKeepOnlyCandidate(service, OWNER);
  // No recording yet: the statement is accepted and the gate is N/A.
  await service.recordConfirmations(OWNER, run.projectId, notRequired);
  assert.equal((await review(service, run)).readiness.gates.originalAudio.status, 'N/A');

  await uploadRecording(service, run);
  const reviewed = await review(service, run);
  assert.equal(reviewed.confirmations.original_audio_required.value, false, 'the stored statement is not rewritten');
  assert.equal(reviewed.readiness.gates.originalAudio.status, 'PENDING');
  assert.deepEqual(reviewed.readiness.gates.originalAudio.blockers, ['AUDIO_ALIGNMENT_EVIDENCE_MISSING']);
  assert.equal(reviewed.gates.audio, 'PENDING');
  const finalized = await service.finalize(OWNER, run.projectId, { candidateId: run.candidateId });
  assert.equal(finalized.gates.audio, 'PENDING');

  // Audio evidence attached later, with no asset: the same.
  const other = await applyKeepOnlyCandidate(service, OWNER, { title: 'evidence later' });
  await service.recordConfirmations(OWNER, other.projectId, notRequired);
  await service.attachAudioAlignment(OWNER, other.projectId, { candidateId: other.candidateId, report: cleanReport() });
  const withEvidence = await review(service, other);
  assert.deepEqual(withEvidence.readiness.gates.originalAudio.blockers, ['ORIGINAL_AUDIO_GATE7_REVIEW_REQUIRED']);
  assert.equal((await service.finalize(OWNER, other.projectId, { candidateId: other.candidateId })).gates.audio, 'PENDING');
});
