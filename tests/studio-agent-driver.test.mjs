import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createStudioApplication } from '../studio/backend/application/index.mjs';
import { createAgentDriver, checkDispatchAction, AGENT_ACTOR } from '../server/studio-agent-driver.mjs';
import { createApiRouter } from '../server/api.mjs';
import { sixSourceVoices } from '../studio/tests/fixtures/midi-fixtures.mjs';

async function setup(decide, extra = {}) {
  const application = createStudioApplication();
  const { project } = await application.createProject('owner', { title: 'Synthetic dispatch test; no song evidence' });
  const { run } = await application.startRun('owner', project.project_id, { idempotency_key: 'start' });
  const driver = createAgentDriver({ application, decide, ...extra });
  const input = { expected_run_revision: run.revision, idempotency_key: 'dispatch', authorization: 'reversible-proposals' };
  return { application, driver, projectId: project.project_id, runId: run.run_id, input };
}
const wait = { tool: null, arguments_json: '{}', reason: '缺少來源；不能推測音符或聲部。' };

test('dispatch invokes agent once; duplicate start is idempotent and owner isolated', async () => {
  let calls = 0, release;
  const barrier = new Promise(r => { release = r; });
  const s = await setup(async c => { calls++; assert.equal(c.actor, AGENT_ACTOR); await barrier; return wait; });
  await s.driver.start('owner', s.projectId, s.runId, s.input);
  assert.equal((await s.driver.start('owner', s.projectId, s.runId, s.input)).replayed, true);
  await assert.rejects(s.driver.status('intruder', s.projectId, s.runId));
  release(); await s.driver.settled();
  assert.equal(calls, 1);
  assert.equal((await s.driver.status('owner', s.projectId, s.runId)).task.state, 'waiting_review');
  assert.equal((await s.application.getRun('owner', s.projectId, s.runId)).run.revision, s.input.expected_run_revision);
});

test('agent action boundaries refuse confirmations, actor spoofing and other runs', () => {
  const c = { project_id: 'prj_' + 'a'.repeat(32), run_id: 'run_' + 'b'.repeat(32), candidate_id: 'candidate' };
  const action = (tool, args) => ({ tool, arguments_json: JSON.stringify(args), reason: 'test' });
  assert.throws(() => checkDispatchAction(action('studio_candidate_review', { project_id: c.project_id, candidate_id: c.candidate_id, confirmations: { source_complete: true } }), c));
  assert.throws(() => checkDispatchAction(action('studio_run_resume', { project_id: c.project_id, run_id: 'run_' + 'c'.repeat(32), expected_run_revision: 1, idempotency_key: 'test' }), c));
  assert.throws(() => checkDispatchAction(action('studio_finalize', {}), c));
  assert.throws(() => checkDispatchAction(action('studio_proposal_resolve', { project_id: c.project_id, proposal_id: 'pro_' + 'd'.repeat(32), expected_proposal_revision: 1, resolution: 'accept', accepted_by: 'user', reason: 'test' }), c));
  assert.equal(checkDispatchAction(wait, c), null);
});

test('stopping an inference prevents its returned mutation from executing', async () => {
  let release, started;
  const barrier = new Promise(r => { release = r; });
  const entered = new Promise(r => { started = r; });
  const s = await setup(async c => { started(); await barrier; return { tool: 'studio_run_resume', arguments_json: JSON.stringify({ project_id: c.project_id, run_id: c.run_id, expected_run_revision: c.run.run.revision, idempotency_key: 'should-not-run' }), reason: 'test' }; });
  await s.driver.start('owner', s.projectId, s.runId, s.input); await entered;
  await s.driver.stop('owner', s.projectId, s.runId); release(); await s.driver.settled();
  const task = (await s.driver.status('owner', s.projectId, s.runId)).task;
  assert.equal(task.state, 'stopped'); assert.equal(task.steps, 0);
});

test('a restarted host exposes interrupted work and does not automatically run it', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'mml-dispatch-test-'));
  t.after(() => rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }));
  let release; const barrier = new Promise(r => { release = r; });
  const s = await setup(async () => { await barrier; return wait; }, { directory });
  await s.driver.start('owner', s.projectId, s.runId, s.input);
  let calls = 0;
  const restarted = createAgentDriver({ application: s.application, directory, decide: async () => { calls++; return wait; } });
  assert.equal((await restarted.status('owner', s.projectId, s.runId)).task.state, 'interrupted');
  assert.equal(calls, 0);
  release(); await s.driver.settled();
});

test('HTTP dispatch is authenticated, revision-bound and persists a wait result', async () => {
  const s = await setup(async () => wait);
  const router = createApiRouter({ application: s.application, ownerOf: () => 'owner', agentDriver: s.driver });
  const path = `https://test.example/api/v1/projects/${s.projectId}/runs/${s.runId}/agent`;
  const request = body => new Request(path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  assert.equal((await router(request(s.input), { authenticated: false })).status, 401);
  assert.equal((await router(request({ ...s.input, expected_run_revision: 999 }), { authenticated: true })).status, 400);
  assert.equal((await router(request(s.input), { authenticated: true })).status, 202);
  await s.driver.settled();
  assert.equal((await (await router(new Request(path), { authenticated: true })).json()).task.state, 'waiting_review');
});

test('repeated reads are bounded without spending more inference on the same state', async () => {
  let calls = 0;
  const s = await setup(async c => { calls++; return { tool: 'studio_proposal_targets', arguments_json: JSON.stringify({ project_id: c.project_id, run_id: c.run_id }), reason: 'inspect' }; });
  await s.driver.start('owner', s.projectId, s.runId, s.input); await s.driver.settled();
  const task = (await s.driver.status('owner', s.projectId, s.runId)).task;
  assert.equal(calls, 2); assert.equal(task.steps, 1); assert.equal(task.state, 'waiting_review');
});

test('agent submits then separately accepts source selection through real engines on the same run', async () => {
  let assetId, decisions = 0;
  const s = await setup(async c => {
    decisions++;
    const body = decisions === 1 ? {
      project_id: c.project_id, run_id: c.run_id, expected_run_revision: c.run.run.revision,
      request_key: c.targets.targets[0].request_key, proposed_by: AGENT_ACTOR,
      kind: 'source_selection', action: { asset_ids: [assetId] },
      rationale: 'Select the explicitly uploaded synthetic MIDI source; no musical acceptance.',
    } : decisions === 2 ? {
      project_id: c.project_id, proposal_id: c.previous.proposal.proposal_id,
      expected_proposal_revision: c.previous.proposal.revision, resolution: 'accept', accepted_by: AGENT_ACTOR,
      reason: 'Authorized source selection; exact uploaded asset ID verified.',
    } : null;
    if (!body) return wait;
    return { tool: decisions === 1 ? 'studio_proposal_submit' : 'studio_proposal_resolve', arguments_json: JSON.stringify(body), reason: 'Source selection regression' };
  });
  assetId = (await s.application.uploadAsset('owner', s.projectId, { kind: 'third_party_midi', filename: 'synthetic.mid', mediaType: 'audio/midi', bytes: sixSourceVoices() })).asset.asset_id;
  await s.driver.start('owner', s.projectId, s.runId, s.input); await s.driver.settled();
  const task = (await s.driver.status('owner', s.projectId, s.runId)).task;
  assert.equal(task.state, 'waiting_review', JSON.stringify(task)); assert.equal(task.steps, 2);
  const { run } = await s.application.getRun('owner', s.projectId, s.runId);
  assert.equal(run.run_id, s.runId); assert.ok(run.baseline_id);
  assert.equal(run.halt.reason, 'AWAITING_ACCEPTED_DECISIONS'); assert.equal(run.final_artifact_id, null);
  const { proposal } = await s.application.getProposal('owner', s.projectId, task.proposal_ids[0]);
  assert.equal(proposal.proposed_by, AGENT_ACTOR); assert.equal(proposal.state, 'applied');
});

test('agent materializes a role-less Melody review candidate without manufacturing Lead evidence', async () => {
  let assetId, turn = 0, lanes = [];
  const s = await setup(async c => {
    turn++;
    if (turn === 1) {
      return { tool: 'studio_proposal_submit', arguments_json: JSON.stringify({
        project_id: c.project_id, run_id: c.run_id, expected_run_revision: c.run.run.revision,
        request_key: c.targets.targets[0].request_key, proposed_by: AGENT_ACTOR,
        kind: 'source_selection', action: { asset_ids: [assetId] },
        rationale: 'Select the explicitly uploaded synthetic role-less MIDI source.',
      }), reason: 'Select synthetic source' };
    }
    if (turn === 2) {
      return { tool: 'studio_proposal_resolve', arguments_json: JSON.stringify({
        project_id: c.project_id, proposal_id: c.previous.proposal.proposal_id,
        expected_proposal_revision: c.previous.proposal.revision, resolution: 'accept', accepted_by: AGENT_ACTOR,
        reason: 'Authorized reversible source selection for the synthetic regression.',
      }), reason: 'Accept source selection' };
    }
    if (turn === 3) {
      const target = c.targets.targets.find(entry => entry.admissible_kinds.includes('arrangement_decision'));
      assert.ok(target);
      assert.equal(target.detail.roleless_melody_candidate_boundary, 'ASSIGN_ROLE_ONLY_REVIEW_PENDING');
      return { tool: 'studio_arrangement_suggest', arguments_json: JSON.stringify({ project_id: c.project_id }), reason: 'Read role-less lanes before proposing' };
    }
    if (turn === 4) {
      lanes = c.previous.suggestion.lanes;
      assert.ok(lanes.length >= 6, 'fixture exposes at least six role-less lanes');
      return { tool: 'studio_baseline_events', arguments_json: JSON.stringify({ project_id: c.project_id, limit: 1 }), reason: 'Read one real baseline event for proposal citation' };
    }
    if (turn === 5) {
      const target = c.targets.targets.find(entry => entry.admissible_kinds.includes('arrangement_decision'));
      const roles = ['Melody', 'Chord1', 'Chord2', 'Chord3', 'Chord4', 'Chord5'];
      const decisions = lanes.map((lane, index) => ({
        id: `roleless-preview:${index}`,
        type: 'ASSIGN_ROLE',
        target: { laneId: lane.id },
        toRole: roles[Math.min(index, roles.length - 1)],
        reason: 'Synthetic fixture role assignment used only to test candidate materialization.',
        evidence: ['fixture:roleless-preview-regression'],
      }));
      return { tool: 'studio_proposal_submit', arguments_json: JSON.stringify({
        project_id: c.project_id, run_id: c.run_id, expected_run_revision: c.run.run.revision,
        request_key: target.request_key, proposed_by: AGENT_ACTOR, kind: 'arrangement_decision',
        rationale: 'Materialize a reversible six-role review candidate from synthetic role-less MIDI; do not claim Lead PASS.',
        action: { decisions }, cites: { event_ids: [c.previous.events[0].event_id] },
      }), reason: 'Submit provisional arrangement' };
    }
    if (turn === 6) {
      assert.equal(c.previous.proposal.agent_review.acceptable, true);
      return { tool: 'studio_proposal_resolve', arguments_json: JSON.stringify({
        project_id: c.project_id, proposal_id: c.previous.proposal.proposal_id,
        expected_proposal_revision: c.previous.proposal.revision, resolution: 'accept', accepted_by: AGENT_ACTOR,
        reason: 'Authorized reversible candidate materialization; Lead review remains separate.',
      }), reason: 'Apply provisional arrangement' };
    }
    return { tool: null, arguments_json: '{}', reason: '候選已產生；Lead promotion 仍需 candidate-bound reviewer evidence。' };
  });
  assetId = (await s.application.uploadAsset('owner', s.projectId, {
    kind: 'third_party_midi', filename: 'roleless.mid', mediaType: 'audio/midi', bytes: sixSourceVoices(),
  })).asset.asset_id;

  await s.driver.start('owner', s.projectId, s.runId, s.input);
  await s.driver.settled();

  const task = (await s.driver.status('owner', s.projectId, s.runId)).task;
  assert.equal(task.state, 'waiting_review', JSON.stringify(task));
  assert.equal(task.steps, 6);

  const { run } = await s.application.getRun('owner', s.projectId, s.runId);
  assert.ok(run.candidate_id, 'the role-less assignment now produces an audition/review candidate');
  assert.equal(run.final_artifact_id, null);
  const applicationStep = run.steps.find(entry => entry.step === 'apply_decisions');
  assert.equal(applicationStep.status, 'completed');
  assert.equal(applicationStep.detail.review_pending, true);
  assert.ok(applicationStep.detail.diagnostic_codes.includes('ROLELESS_LEAD_ASSIGNMENT_REVIEW_PENDING'));

  const { review } = await s.application.reviewCandidate('owner', s.projectId, { candidateId: run.candidate_id });
  assert.equal(review.readiness.gates.leadPromotion.status, 'PENDING');
  assert.ok(review.readiness.preGameBlocking.includes('leadPromotion'));
  assert.ok(review.lead_promotion.some(report => report.status === 'PENDING'));
});

test('state changed during inference prevents a stale action from being applied', async () => {
  let release, entered;
  const ready = new Promise(r => { entered = r; }), barrier = new Promise(r => { release = r; });
  const s = await setup(async c => { entered(); await barrier; return { tool: 'studio_run_resume', arguments_json: JSON.stringify({ project_id: c.project_id, run_id: c.run_id, expected_run_revision: c.run.run.revision, idempotency_key: 'stale-agent' }), reason: 'test' }; });
  await s.driver.start('owner', s.projectId, s.runId, s.input); await ready;
  await s.application.resumeRun('owner', s.projectId, s.runId, { expected_run_revision: s.input.expected_run_revision, idempotency_key: 'other-caller' });
  release(); await s.driver.settled();
  const task = (await s.driver.status('owner', s.projectId, s.runId)).task;
  assert.equal(task.state, 'needs_attention'); assert.equal(task.steps, 0); assert.match(task.reason, /changed/);
});

test('an uncertain operation stays inspectable and cannot be blindly redispatched', async () => {
  let s;
  s = await setup(async c => ({ tool: 'studio_run_resume', arguments_json: JSON.stringify({ project_id: c.project_id, run_id: c.run_id, expected_run_revision: c.run.run.revision, idempotency_key: 'uncertain' }), reason: 'test' }));
  const faulty = { ...s.application, resumeRun: async () => { throw Error('private backend detail must not be exposed'); } };
  const driver = createAgentDriver({ application: faulty, decide: async c => ({ tool: 'studio_run_resume', arguments_json: JSON.stringify({ project_id: c.project_id, run_id: c.run_id, expected_run_revision: c.run.run.revision, idempotency_key: 'uncertain' }), reason: 'test' }) });
  await driver.start('owner', s.projectId, s.runId, s.input); await driver.settled();
  const task = (await driver.status('owner', s.projectId, s.runId)).task;
  assert.equal(task.pending_action.tool, 'studio_run_resume'); assert.equal(task.state, 'needs_attention');
  assert.ok(!JSON.stringify(task).includes('private backend detail'));
  await assert.rejects(driver.start('owner', s.projectId, s.runId, { ...s.input, idempotency_key: 'blind-retry' }), /uncertain/);
  const inspected = { inspected: true, pending_action_fingerprint: task.pending_action.fingerprint,
    expected_run_revision: s.input.expected_run_revision, reason: 'Synthetic operator inspected the injected failure; no operation was applied.' };
  await assert.rejects(driver.reconcile('intruder', s.projectId, s.runId, inspected));
  await assert.rejects(driver.reconcile('owner', s.projectId, s.runId, { ...inspected, pending_action_fingerprint: 'wrong' }));
  const recovered = await driver.reconcile('owner', s.projectId, s.runId, inspected);
  assert.equal(recovered.task.pending_action, null); assert.equal(recovered.task.state, 'stopped');
  assert.equal((await s.application.getRun('owner', s.projectId, s.runId)).run.revision, s.input.expected_run_revision);
});
