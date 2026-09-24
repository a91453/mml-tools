// A request the run's own steps would refuse is refused before the run is
// written.
//
// Refused inside a step instead, the error left the run marked running with a
// pending step and no halt: every proposal on it turned STALE, the next action
// read "inspect interrupted step", a retry of the same request was answered
// RUN_CONFLICT, and a named asset intake cannot ingest wedged the run for good
// (every later resume re-threw inside the intake effect).
import test from 'node:test';
import assert from 'node:assert/strict';

import { createStudioApplication } from '../backend/application/index.mjs';
import { projectWithSymbolicAsset, runDecisionsFor, sixRoleBaseline } from './fixtures/run-fixtures.mjs';

const OWNER = 'owner:run-input-refusal';

async function haltedAtReview(app) {
  const project = sixRoleBaseline();
  const fx = await projectWithSymbolicAsset(app, OWNER, { project });
  await app.analyzeSources(OWNER, fx.projectId, { assetIds: [fx.assetId] });
  const applied = await app.applyDecisions(OWNER, fx.projectId, { decisions: runDecisionsFor(project) });
  const started = await app.startRun(OWNER, fx.projectId, { target_candidate_id: applied.decisions.candidate_id, idempotency_key: 'start' });
  return { fx, project, run: started.run };
}

const unchanged = async (app, projectId, before) => {
  const after = (await app.getRun(OWNER, projectId, before.run_id)).run;
  assert.equal(after.revision, before.revision, 'nothing was written');
  assert.equal(after.state, before.state);
  assert.deepEqual(after.halt, before.halt);
  assert.equal(after.pending_step ?? null, null);
  assert.equal(after.needs_reconciliation, false);
  return after;
};

test('an unknown confirmation is refused before the run moves, and a retry is refused the same way', async () => {
  const app = createStudioApplication({});
  const { fx, run } = await haltedAtReview(app);
  assert.equal(run.halt.reason, 'AWAITING_REVIEW_EVIDENCE');
  const request = { confirmations: { bogus_confirmation: { value: true, reason: 'x' } }, expected_run_revision: run.revision, idempotency_key: 'resume-bad' };
  for (let attempt = 0; attempt < 2; attempt++) {
    await assert.rejects(app.resumeRun(OWNER, fx.projectId, run.run_id, request), error => error.code === 'INVALID_REQUEST' && /Unknown confirmation: bogus_confirmation/.test(error.message));
    await unchanged(app, fx.projectId, run);
  }
  assert.equal((await app.proposalTargets(OWNER, fx.projectId, run.run_id)).accepts_proposals, true);
  assert.notEqual((await app.nextRun(OWNER, fx.projectId, run.run_id)).next_action.kind, 'inspect_interrupted_step');
  await assert.rejects(app.resumeRun(OWNER, fx.projectId, run.run_id, { confirmations: { in_game: { value: 'PASS', reason: 'x' } } }), /in-game acceptance is not recordable/);
  await assert.rejects(app.resumeRun(OWNER, fx.projectId, run.run_id, { confirmations: { source_complete: 'yes' } }), /confirmations\.source_complete must be an object/);
  await unchanged(app, fx.projectId, run);
});

test('a decision with a field applyDecisions refuses is refused before the run moves', async () => {
  const app = createStudioApplication({});
  const project = sixRoleBaseline();
  const fx = await projectWithSymbolicAsset(app, OWNER, { project });
  const started = (await app.startRun(OWNER, fx.projectId, { asset_ids: [fx.assetId], idempotency_key: 'start' })).run;
  assert.equal(started.halt.reason, 'AWAITING_ACCEPTED_DECISIONS');
  const [first, ...rest] = runDecisionsFor(project);
  for (const decisions of [[{ ...first, unknownField: 1 }, ...rest], [{ ...first, acceptance: {} }, ...rest]]) {
    await assert.rejects(app.resumeRun(OWNER, fx.projectId, started.run_id, { decisions, expected_run_revision: started.revision }), error => error.code === 'INVALID_REQUEST');
    await unchanged(app, fx.projectId, started);
  }
  const { acceptedBy: _who, ...anonymous } = first;
  await assert.rejects(app.resumeRun(OWNER, fx.projectId, started.run_id, { decisions: [anonymous, ...rest] }), /acceptedBy must name who accepted the decision/);
  await unchanged(app, fx.projectId, started);
  // The same decisions, well formed, still advance the run.
  const resumed = await app.resumeRun(OWNER, fx.projectId, started.run_id, { decisions: [first, ...rest], expected_run_revision: started.revision });
  assert.ok(resumed.run.revision > started.revision);
  assert.notEqual(resumed.run.halt?.reason, 'AWAITING_ACCEPTED_DECISIONS');
});

test('an asset intake cannot ingest is refused by plan, start and resume, and graded INVALID as a source selection', async () => {
  const app = createStudioApplication({});
  const projectId = (await app.createProject(OWNER, { title: 'recording only' })).project.project_id;
  const audio = (await app.uploadAsset(OWNER, projectId, { kind: 'original_audio', filename: 'song.wav', mediaType: 'audio/wav', bytes: new Uint8Array([1, 2, 3, 4]) })).asset;
  const refusal = error => error.code === 'UNSUPPORTED_SOURCE' && error.details.asset_id === audio.asset_id && error.details.kind === 'original_audio';
  await assert.rejects(app.planRun(OWNER, projectId, { asset_ids: [audio.asset_id] }), refusal);
  await assert.rejects(app.startRun(OWNER, projectId, { asset_ids: [audio.asset_id] }), refusal);
  const started = (await app.startRun(OWNER, projectId, { idempotency_key: 'start' })).run;
  assert.deepEqual(started.review_requests.map(request => request.code), ['SYMBOLIC_SOURCE_REQUIRED']);
  await assert.rejects(app.resumeRun(OWNER, projectId, started.run_id, { asset_ids: [audio.asset_id] }), refusal);
  await unchanged(app, projectId, started);
  const proposed = await app.proposeDecision(OWNER, projectId, {
    run_id: started.run_id, request_key: started.review_requests[0].request_key, kind: 'source_selection', proposed_by: 'agent',
    rationale: 'use the recording', action: { asset_ids: [audio.asset_id] }, expected_run_revision: started.revision,
  });
  assert.equal(proposed.proposal.agent_review.verdict, 'INVALID');
  assert.deepEqual(proposed.proposal.agent_review.refusals, ['ACTION_KIND_MISMATCH']);
  assert.equal(proposed.proposal.agent_review.acceptable, false);
  await assert.rejects(app.resolveProposal(OWNER, projectId, proposed.proposal.proposal_id, { resolution: 'accept', accepted_by: 'reviewer' }));
  await unchanged(app, projectId, started);
  // Withdrawing it is still possible: nothing was accepted.
  const withdrawn = await app.resolveProposal(OWNER, projectId, proposed.proposal.proposal_id, { resolution: 'withdraw' });
  assert.equal(withdrawn.proposal.state, 'withdrawn');
});
