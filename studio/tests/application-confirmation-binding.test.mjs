// Studio Application Service — confirmation binding regressions.
//
// A confirmation is a statement about a specific thing: source completeness is
// about the baseline that was loaded, version-drift review and player readback
// are about the candidate that was reviewed or read back. These regressions pin
// that a confirmation cannot outlive the identity it was made about: a new
// baseline or a different candidate must not inherit a PASS nobody restated.
//
// Gate 0 of the pinned snapshot fails closed on silent version mixing and
// Gate 6 requires that "loaded player state/readback is actual, not assumed";
// nothing here adds a rule — it stops the implementation from assuming one.

import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';

import { ERROR_CODES, createStudioApplication } from '../backend/application/index.mjs';
import { createCanonicalProject } from '../backend/canonical/index.mjs';
import { applyKeepOnlyCandidate, canonicalProjectBytes, keepEveryRole, sixRoleBaseline } from './fixtures/application-fixtures.mjs';

const OWNER = 'owner:alice';
const app = () => createStudioApplication({});
const sha256 = text => createHash('sha256').update(text).digest('hex');

async function rejects(promise, code) {
  try {
    await promise;
    assert.fail(`expected ${code}`);
  } catch (error) {
    assert.equal(error.code, code, error.message);
    return error;
  }
}

const baselineConfirmations = {
  source_complete: { value: true, reason: 'The fixture is the complete material.', evidence: ['fixture'] },
  original_audio_required: { value: false, reason: 'No recording exists for this cue.' },
};

/** A second, different candidate chained on the first: Chord5 omitted. */
async function chainOmitChord5(service, projectId, parentCandidateId) {
  const base = sixRoleBaseline();
  const decisions = [
    ...keepEveryRole(base, { acceptedBy: 'reviewer-2' }).filter(decision => decision.fromRole !== 'Chord5'),
    {
      id: 'omit:Chord5',
      type: 'OMIT_FROM_SIX',
      target: { eventIds: base.events.filter(event => event.role === 'Chord5').map(event => event.id) },
      fromRole: 'Chord5',
      reason: 'Test: omit the enrichment lane so the candidate differs.',
      evidence: ['test'],
      acceptedBy: 'reviewer-2',
    },
  ];
  const applied = await service.applyDecisions(OWNER, projectId, { decisions, parentCandidateId });
  assert.equal(applied.decisions.applied, true, JSON.stringify(applied.decisions.rejected));
  return applied.decisions.candidate_id;
}

test('a player readback recorded for one candidate does not pass a different candidate', async () => {
  const service = app();
  const run = await applyKeepOnlyCandidate(service, OWNER);
  const first = await service.finalize(OWNER, run.projectId, {
    candidateId: run.candidateId,
    confirmations: { ...baselineConfirmations, player_readback: { value: 'PASS', reason: 'Read back the first candidate.', evidence: ['session 1'] }, version_drift_reviewed: { value: true, reason: 'Reviewed the first candidate.' } },
  });
  assert.equal(first.operation, 'succeeded');
  assert.equal(first.gates.player_readback, 'PASS');

  const second = await chainOmitChord5(service, run.projectId, run.candidateId);
  assert.notEqual(second, run.candidateId);
  const result = await service.finalize(OWNER, run.projectId, { candidateId: second });

  // Nobody read the second candidate back and nobody reviewed its drift.
  assert.equal(result.operation, 'blocked', 'a PASS recorded for another candidate must not deliver this one');
  assert.equal(result.artifact_id, null);
  assert.equal(result.mml, null);
  assert.notEqual(result.gates.player_readback, 'PASS');
  assert.ok(result.blockers.includes('playerReadback'), JSON.stringify(result.blockers));

  const review = (await service.reviewCandidate(OWNER, run.projectId, { candidateId: second })).review;
  assert.equal(review.confirmations.player_readback, undefined, 'a stale confirmation is not an effective one');
  assert.ok(review.stale_confirmations.some(entry => entry.name === 'player_readback' && entry.bound_candidate_id === run.candidateId));
  // The baseline-scoped confirmations were made about this baseline and still hold.
  assert.equal(review.confirmations.source_complete.value, true);
});

test('a source-completeness confirmation does not survive a new baseline', async () => {
  const service = app();
  const created = (await service.createProject(OWNER, { title: 'Rebaselined' })).project;
  await service.uploadAsset(OWNER, created.project_id, { kind: 'canonical_project', filename: 'b1.json', mediaType: 'application/json', bytes: canonicalProjectBytes() });
  const first = (await service.analyzeSources(OWNER, created.project_id)).baseline;
  await service.recordConfirmations(OWNER, created.project_id, baselineConfirmations);

  const alt = sixRoleBaseline({ id: 'fixture:alt' });
  const altProject = createCanonicalProject({ ...alt, events: alt.events.filter(event => event.role !== 'Chord5') });
  const asset = (await service.uploadAsset(OWNER, created.project_id, { kind: 'canonical_project', filename: 'b2.json', mediaType: 'application/json', bytes: new TextEncoder().encode(JSON.stringify(altProject)) })).asset;
  const second = (await service.analyzeSources(OWNER, created.project_id, { assetIds: [asset.asset_id] })).baseline;
  assert.notEqual(second.baseline_id, first.baseline_id);

  const decisions = keepEveryRole(altProject, { acceptedBy: 'reviewer' }).filter(decision => decision.target.eventIds.length);
  const candidateId = (await service.applyDecisions(OWNER, created.project_id, { decisions })).decisions.candidate_id;
  assert.ok(candidateId);

  const review = (await service.reviewCandidate(OWNER, created.project_id, { candidateId })).review;
  assert.equal(review.gates.source, 'PENDING', 'completeness confirmed for the old baseline must not pass the new one');
  assert.equal(review.confirmations.source_complete, undefined);
  assert.ok(review.stale_confirmations.some(entry => entry.name === 'source_complete' && entry.bound_baseline_id === first.baseline_id));

  const result = await service.finalize(OWNER, created.project_id, { candidateId, confirmations: { player_readback: { value: 'N/A', reason: 'No preview or verification assets are used for this cue.' } } });
  assert.equal(result.operation, 'blocked');
  assert.ok(result.blockers.includes('source'));
  assert.equal(result.artifact_id, null);
});

test('recorded confirmations carry the identity they were made about', async () => {
  const service = app();
  const run = await applyKeepOnlyCandidate(service, OWNER);
  const recorded = (await service.recordConfirmations(OWNER, run.projectId, {
    ...baselineConfirmations,
    player_readback: { value: 'NOT_RUN', reason: 'Not yet read back.', candidate_id: run.candidateId },
  })).confirmations;
  assert.equal(recorded.source_complete.baseline_id, run.intake.baseline.baseline_id);
  assert.equal(recorded.source_complete.candidate_id, null);
  assert.equal(recorded.player_readback.candidate_id, run.candidateId);
  assert.equal(recorded.player_readback.baseline_id, run.intake.baseline.baseline_id);

  // A candidate-scoped confirmation must say which candidate it is about.
  await rejects(service.recordConfirmations(OWNER, run.projectId, { player_readback: { value: 'PASS', reason: 'x' } }), ERROR_CODES.INVALID_REQUEST);
  await rejects(service.recordConfirmations(OWNER, run.projectId, { version_drift_reviewed: { value: true, reason: 'x' } }), ERROR_CODES.INVALID_REQUEST);
  await rejects(service.recordConfirmations(OWNER, run.projectId, { player_readback: { value: 'PASS', reason: 'x', candidate_id: `g11d:rev:${'0'.repeat(64)}` } }), ERROR_CODES.CANDIDATE_NOT_FOUND);
  // Through review or finalize the candidate is the one being reviewed, and a
  // contradicting candidate_id inside the confirmation is refused.
  await rejects(service.reviewCandidate(OWNER, run.projectId, { candidateId: run.candidateId, confirmations: { player_readback: { value: 'PASS', reason: 'x', candidate_id: `g11d:rev:${'1'.repeat(64)}` } } }), ERROR_CODES.INVALID_REQUEST);
});

test('player readback may be recorded as N/A when no preview assets are used, and never as anything else', async () => {
  const service = app();
  const run = await applyKeepOnlyCandidate(service, OWNER);
  await rejects(service.reviewCandidate(OWNER, run.projectId, { candidateId: run.candidateId, confirmations: { player_readback: { value: 'FAIL', reason: 'x' } } }), ERROR_CODES.INVALID_REQUEST);
  await rejects(service.reviewCandidate(OWNER, run.projectId, { candidateId: run.candidateId, confirmations: { player_readback: { value: 'N/A' } } }), ERROR_CODES.INVALID_REQUEST);

  const result = await service.finalize(OWNER, run.projectId, {
    candidateId: run.candidateId,
    confirmations: { ...baselineConfirmations, player_readback: { value: 'N/A', reason: 'No preview or verification assets are used for this cue.' } },
  });
  assert.equal(result.operation, 'succeeded');
  assert.equal(result.gates.player_readback, 'N/A', 'not applicable is reported as such, never upgraded to PASS');
  assert.match(result.mml, /^MML@/);
  const { artifact } = await service.getArtifact(OWNER, result.artifact_id);
  assert.equal(artifact.gates.player_readback, 'N/A');
});

test('a player readback PASS that names an MML digest only counts for that exact MML', async () => {
  const service = app();
  const run = await applyKeepOnlyCandidate(service, OWNER);
  const draft = await service.finalize(OWNER, run.projectId, {
    candidateId: run.candidateId,
    confirmations: { ...baselineConfirmations, player_readback: { value: 'N/A', reason: 'No preview assets used yet.' } },
  });
  assert.equal(draft.operation, 'succeeded');

  await rejects(service.reviewCandidate(OWNER, run.projectId, { candidateId: run.candidateId, confirmations: { player_readback: { value: 'PASS', reason: 'x', mml_sha256: 'not-a-digest' } } }), ERROR_CODES.INVALID_REQUEST);

  const wrong = await service.finalize(OWNER, run.projectId, {
    candidateId: run.candidateId,
    confirmations: { player_readback: { value: 'PASS', reason: 'Read back a different string.', mml_sha256: 'f'.repeat(64) } },
  });
  assert.equal(wrong.operation, 'blocked', 'a readback of some other MML is not a readback of this one');
  assert.equal(wrong.artifact_id, null);
  assert.equal(wrong.mml, null);
  assert.notEqual(wrong.gates.player_readback, 'PASS');
  assert.equal(wrong.player_readback_binding.matched, false);

  const right = await service.finalize(OWNER, run.projectId, {
    candidateId: run.candidateId,
    confirmations: { player_readback: { value: 'PASS', reason: 'Read back the delivered MML in the player.', mml_sha256: sha256(draft.mml), evidence: ['player session'] } },
  });
  assert.equal(right.operation, 'succeeded');
  assert.equal(right.gates.player_readback, 'PASS');
  assert.equal(right.mml, draft.mml);
  assert.equal(right.player_readback_binding.matched, true);
});
