// Synthetic regression ONLY. This is not real-song, listening or game evidence.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync, readdirSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { callAgentTool, checkAgentCall, LOCAL_AGENT_OWNER } from '../scripts/studio-agent.mjs';
import { createStudioApplication } from '../studio/backend/application/index.mjs';
import { STUDIO_MCP_TOOLS, runStudioTool } from '../server/mcp-studio.mjs';
import { compactStudioResponse } from '../server/mcp-compaction.mjs';
import { canonicalProjectBytes, sixRoleBaseline, runDecisionsFor, projectWithSymbolicAsset, FIXTURE_CONFIRMATIONS } from '../studio/tests/fixtures/run-fixtures.mjs';
import { sixSourceVoices } from '../studio/tests/fixtures/midi-fixtures.mjs';
import { staleCompletedRun } from './fixtures/stale-run.mjs';

const cli = fileURLToPath(new URL('../scripts/studio-agent.mjs', import.meta.url));
const actor = 'agent:codex';
function workspace(t) {
  const dir = mkdtempSync(join(tmpdir(), 'studio-agent-test-'));
  t.after(() => rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));
  let sequence = 0;
  const command = (args, expectedCode = 0) => {
    const proc = spawnSync(process.execPath, [cli, '--data-dir', dir, '--actor', actor, ...args], { encoding: 'utf8', maxBuffer: 4 * 1024 * 1024 });
    assert.equal(proc.status, expectedCode, proc.stderr + proc.stdout);
    return JSON.parse(proc.stdout || proc.stderr);
  };
  const call = (name, args = {}, expectedCode = 0) => {
    const path = join(dir, `input-${sequence++}.json`);
    writeFileSync(path, JSON.stringify(args));
    return command(['call', name, '--input', path], expectedCode);
  };
  return { dir, call, command };
}

test('local commands reopen one source-blocked run and preserve structured schema errors', t => {
  const { dir, call, command } = workspace(t);
  const project_id = call('studio_project_create', { title: 'Synthetic CLI recovery regression' }).project.project_id;
  const request = { project_id, idempotency_key: 'same-start' };
  const first = call('studio_run_start', request).run;
  assert.equal(first.state, 'awaiting_review');
  assert.equal(first.review_requests[0].code, 'SYMBOLIC_SOURCE_REQUIRED');
  assert.equal(first.final_artifact_id, null);
  assert.deepEqual(call('studio_run_start', request).run, first);
  assert.equal(call('studio_run_status', { project_id, run_id: first.run_id }).run.revision, first.revision);
  const error = call('studio_run_resume', { project_id, run_id: first.run_id, unknown: true }, 1).error;
  assert.equal(error.code, -32602, 'the existing MCP schema checker answers');
  const output = join(dir, 'must-not-exist.mml');
  command(['export', '--project-id', project_id, '--run-id', first.run_id, '--out', output], 1);
  assert.equal(existsSync(output), false);
  assert.ok(readdirSync(join(dir, 'receipts')).length >= 6);
  assert.equal(existsSync(join(dir, '.agent.lock')), false);
});

test('binary synthetic MIDI enters the existing intake and suggestion engines through the CLI', t => {
  const { dir, call, command } = workspace(t);
  const project_id = call('studio_project_create', { title: 'Synthetic MIDI, not song acceptance' }).project.project_id;
  const midi = join(dir, 'synthetic.mid');
  writeFileSync(midi, sixSourceVoices());
  const asset = command(['upload', '--project-id', project_id, '--file', midi, '--kind', 'third_party_midi']).asset;
  const { run } = call('studio_run_start', { project_id, asset_ids: [asset.asset_id] });
  assert.equal(run.steps.find(step => step.step === 'intake').status, 'completed');
  assert.equal(run.steps.find(step => step.step === 'suggest').status, 'completed');
  assert.equal(run.halt.reason, 'AWAITING_ACCEPTED_DECISIONS');
  assert.equal(run.candidate_id, null);
  const output = join(dir, 'suggestion.json');
  const report = command(['report', '--project-id', project_id, '--kind', 'suggestion', '--out', output]);
  const stored = JSON.parse(readFileSync(output, 'utf8'));
  assert.equal(stored.suggestion.lane_count, report.lane_count);
  assert.equal(stored.suggestion.pending.count, report.pending_lane_count);
  assert.doesNotMatch(report.notice, /Review/);
  assert.equal(call('studio_run_status', { project_id, run_id: run.run_id }).run.revision, run.revision, 'report does not advance the run');
  command(['report', '--project-id', project_id, '--kind', 'suggestion', '--out', output], 1);
});

test('agent proposals stop at review; independent fixture reviewer unlocks real Final export', async t => {
  const { dir, call, command } = workspace(t);
  const project_id = call('studio_project_create', { title: 'Synthetic proposal/export regression' }).project.project_id;
  const source = join(dir, 'synthetic.json');
  writeFileSync(source, canonicalProjectBytes());
  const asset = command(['upload', '--project-id', project_id, '--file', source, '--kind', 'canonical_project']).asset;
  const { run } = call('studio_run_start', { project_id, asset_ids: [asset.asset_id] });
  const identity = { project_id, run_id: run.run_id };
  const target = call('studio_proposal_targets', identity).targets.find(row => row.admissible_kinds.includes('arrangement_decision'));
  const event_ids = call('studio_baseline_events', { project_id }).events.map(row => row.event_id);
  const decisions = runDecisionsFor(sixRoleBaseline()).map(({ acceptedBy, note, ...rest }) => rest);
  const proposal = call('studio_proposal_submit', {
    ...identity, request_key: target.request_key, kind: 'arrangement_decision', proposed_by: actor,
    rationale: 'Synthetic fixture roles stay unchanged.', action: { decisions }, cites: { event_ids },
  }).proposal;
  assert.equal(proposal.agent_review.verdict, 'REQUIRES_EXPLICIT_ACCEPTANCE');
  const accepted = call('studio_proposal_resolve', {
    project_id, proposal_id: proposal.proposal_id, resolution: 'accept', accepted_by: actor,
    reason: 'Authorized reversible fixture decision by an external agent.', expected_proposal_revision: proposal.revision,
  });
  assert.equal(accepted.proposal.resolution.accepted_by, actor);
  assert.equal(accepted.run.state, 'awaiting_review');
  assert.equal(accepted.run.gates.mobile_adaptation, 'PENDING');
  assert.equal(accepted.run.gates.player_readback, 'NOT_RUN');
  call('studio_run_resume', { ...identity, confirmations: FIXTURE_CONFIRMATIONS }, 1);
  assert.equal(call('studio_run_status', identity).run.revision, accepted.run.revision);

  // Test-only reviewer seam, outside the agent adapter. Never used for a real song.
  const reviewer = createStudioApplication({ dataDirectory: join(dir, 'store'), durability: 'persistent' });
  await reviewer.reviewCandidate(LOCAL_AGENT_OWNER, project_id, {
    candidateId: accepted.run.candidate_id, confirmations: FIXTURE_CONFIRMATIONS,
  });
  const finished = call('studio_run_resume', { ...identity, expected_run_revision: accepted.run.revision, idempotency_key: 'after-fixture-review' }).run;
  assert.equal(finished.state, 'completed', JSON.stringify(finished.blockers));
  const output = join(dir, 'synthetic.mml');
  const exported = command(['export', '--project-id', project_id, '--run-id', run.run_id, '--out', output]);
  assert.equal(readFileSync(output, 'utf8'), exported.artifact.mml);
  assert.equal(exported.artifact.candidate_id, finished.candidate_id);
  assert.equal(exported.artifact.gates.technical, 'PASS');
  assert.equal(exported.artifact.gates.in_game, 'PENDING');
  assert.equal(exported.artifact.round_trip.status, 'PASS');
  const status = call('studio_run_status', identity);
  assert.deepEqual(exported.staleness, []);
  assert.equal(exported.staleness_notice, status.staleness_notice);
  assert.deepEqual(exported.canonical, status.canonical);
  command(['export', '--project-id', project_id, '--run-id', run.run_id, '--out', output], 1);
  assert.equal(readFileSync(output, 'utf8'), exported.artifact.mml, 'existing output is never overwritten');
});

test('export refuses a completed run after a real baseline replacement and preserves the service evidence', async t => {
  const { dir, command } = workspace(t);
  const app = createStudioApplication({ dataDirectory: join(dir, 'store'), durability: 'persistent' });
  const fixture = await projectWithSymbolicAsset(app, LOCAL_AGENT_OWNER);
  // Test-only reviewer inputs for a synthetic cue, never real-song evidence.
  const { run } = await app.startRun(LOCAL_AGENT_OWNER, fixture.projectId, {
    asset_ids: [fixture.assetId], decisions: runDecisionsFor(fixture.project),
    accepted_by: 'fixture-run-reviewer', confirmations: FIXTURE_CONFIRMATIONS,
  });
  assert.equal(run.state, 'completed');
  const second = (await app.uploadAsset(LOCAL_AGENT_OWNER, fixture.projectId, {
    kind: 'canonical_project', filename: 'replacement.json', mediaType: 'application/json',
    bytes: canonicalProjectBytes(sixRoleBaseline({ id: 'fixture:replacement', title: 'Replacement' })),
  })).asset;
  await app.analyzeSources(LOCAL_AGENT_OWNER, fixture.projectId, { assetIds: [second.asset_id] });
  const status = await app.getRun(LOCAL_AGENT_OWNER, fixture.projectId, run.run_id);
  assert.equal(status.run.state, 'completed', 'historical completion itself is unchanged');
  assert.ok(status.staleness.some(entry => entry.code === 'RUN_BASELINE_CHANGED'));
  assert.ok(status.staleness.some(entry => entry.code === 'RUN_CANDIDATE_CHANGED'));

  const output = join(dir, 'stale.mml');
  const result = command(['export', '--project-id', fixture.projectId, '--run-id', run.run_id, '--out', output], 1);
  assert.equal(result.error.code, 'AGENT_INPUT_REFUSED');
  assert.deepEqual(result.error.details, {
    run_id: run.run_id, staleness: status.staleness,
    staleness_notice: status.staleness_notice, canonical: status.canonical,
  });
  assert.equal(existsSync(output), false);
  const receipts = readdirSync(join(dir, 'receipts')).map(name => JSON.parse(readFileSync(join(dir, 'receipts', name), 'utf8')));
  assert.equal(receipts.length, 1);
  assert.deepEqual(receipts[0].result, result);
  assert.deepEqual(await app.getRun(LOCAL_AGENT_OWNER, fixture.projectId, run.run_id), status, 'refusal never rewrites the run');
  assert.equal(existsSync(join(dir, '.agent.lock')), false);
});

test('review and reduction reports leave store bytes unchanged and describe only their own operation', async t => {
  const { dir, command } = workspace(t);
  const app = createStudioApplication({ dataDirectory: join(dir, 'store'), durability: 'persistent' });
  const fixture = await projectWithSymbolicAsset(app, LOCAL_AGENT_OWNER);
  const { run } = await app.startRun(LOCAL_AGENT_OWNER, fixture.projectId, {
    asset_ids: [fixture.assetId], decisions: runDecisionsFor(fixture.project), accepted_by: 'fixture-run-reviewer',
  });
  assert.equal(run.state, 'awaiting_review');
  assert.ok(run.candidate_id);
  const storeBytes = () => Object.fromEntries(['records', 'blobs'].flatMap(folder =>
    readdirSync(join(dir, 'store', folder)).sort().map(name => [`${folder}/${name}`, readFileSync(join(dir, 'store', folder, name)).toString('base64')])));
  const before = storeBytes();
  for (const kind of ['review', 'reduction']) {
    const output = join(dir, `${kind}.json`);
    const report = command(['report', '--kind', kind, '--project-id', fixture.projectId, '--candidate-id', run.candidate_id, '--out', output]);
    const stored = JSON.parse(readFileSync(output, 'utf8'));
    assert.equal(stored.operation, 'succeeded');
    if (kind === 'review') {
      assert.match(report.notice, /no store artifact/);
      assert.deepEqual(stored.review.confirmations, {});
    } else assert.doesNotMatch(report.notice, /Review/);
    assert.deepEqual(storeBytes(), before, `${kind} files no artifact and changes no confirmations or run`);
    const receipts = readdirSync(join(dir, 'receipts')).map(name => JSON.parse(readFileSync(join(dir, 'receipts', name), 'utf8')));
    assert.ok(receipts.some(receipt => receipt.command === 'report' && receipt.result.kind === kind && receipt.result.output === output));
  }
});

test('an allowed tool missing from the registry is an internal fault rather than invalid caller input', async t => {
  const index = STUDIO_MCP_TOOLS.findIndex(tool => tool.name === 'studio_project_create');
  const [tool] = STUDIO_MCP_TOOLS.splice(index, 1);
  t.after(() => STUDIO_MCP_TOOLS.splice(index, 0, tool));
  const createProject = t.mock.fn(() => assert.fail('a missing tool must not dispatch'));
  const result = await callAgentTool({ createProject }, 'studio_project_create', { title: 'fixture' }, actor);
  assert.deepEqual(result, { error: { code: 'INTERNAL_ERROR', message: 'The request could not be completed.' } });
  assert.equal(createProject.mock.callCount(), 0);
});

test('adapter cannot turn a direct operation or forged actor into a proposal acceptance', () => {
  for (const name of ['studio_decisions_apply', 'studio_lead_evidence_review', 'studio_core3_change_approve', 'studio_final_reduction_apply', 'studio_mobile_adaptation_apply']) {
    assert.throws(() => checkAgentCall(name, {}, actor), { code: 'AGENT_INPUT_REFUSED' });
  }
  for (const name of ['studio_finalize', 'studio_candidate_review', 'studio_run_start', 'studio_run_resume']) {
    assert.throws(() => checkAgentCall(name, { confirmations: {} }, actor), { code: 'AGENT_INPUT_REFUSED' });
  }
  for (const key of ['decisions', 'final_reduction', 'mobile_adaptation', 'reconcile', 'adopt_artifact_id']) {
    assert.throws(() => checkAgentCall('studio_run_resume', { [key]: true }, actor), { code: 'AGENT_INPUT_REFUSED' });
  }
  assert.throws(() => checkAgentCall('studio_proposal_resolve', { resolution: 'accept', accepted_by: 'human' }, actor), { code: 'AGENT_INPUT_REFUSED' });
  assert.throws(() => checkAgentCall('studio_proposal_submit', { proposed_by: 'human' }, actor), { code: 'AGENT_INPUT_REFUSED' });
});

test('a second local command refuses the directory lock without deleting it', t => {
  const { dir, command } = workspace(t);
  const lock = join(dir, '.agent.lock');
  writeFileSync(lock, 'existing process');
  const result = command(['call', 'studio_project_create'], 1);
  assert.equal(result.error.code, 'AGENT_INPUT_REFUSED');
  assert.equal(readFileSync(lock, 'utf8'), 'existing process');
});

test('local report output retains a full-song response above the MCP wire cap', async () => {
  const report = { operation: 'succeeded', suggestion: { diagnostics: 'x'.repeat(600_000) } };
  const app = { suggestArrangement: async () => report };
  const result = await callAgentTool(app, 'studio_arrangement_suggest', { project_id: 'prj_' + 'a'.repeat(32) }, actor);
  assert.equal(result, report, 'no response rows or diagnostics are lost to a network-size refusal');
});

test('local call returns the full result of reads the MCP view compacts, and leaves the MCP view unchanged', async () => {
  const project_id = 'prj_' + 'a'.repeat(32);
  const run_id = 'run_' + 'b'.repeat(32);
  const artifact_id = 'art_' + 'c'.repeat(64);
  // Above the size trigger: the MCP view summarizes its long list.
  const status = { operation: 'succeeded', project_id, run: { run_id, state: 'awaiting_review',
    steps: Array.from({ length: 3000 }, (_, index) => ({ step: `s${index}`, note: 'x'.repeat(40) })) }, staleness: [] };
  // Small, but a machine-delivery ledger's per-release list is always summarized.
  const artifact = { operation: 'succeeded', artifact: { artifact_id, type: 'final_mml', mml: 'MML@t120l8cdefg;',
    machine_delivery: { schema: 'fixture-ledger', unresolved_evidence_ledger: [], blocking: [],
      non_blocking_pending: [{ provisional_releases: Array.from({ length: 12 }, (_, index) => ({ event_id: `e${index}`, role: 'lead' })) }] } } };
  const app = { getRun: async () => structuredClone(status), getArtifact: async () => structuredClone(artifact) };
  for (const [name, args, full] of [
    ['studio_run_status', { project_id, run_id }, status],
    ['studio_artifact_get', { artifact_id }, artifact],
  ]) {
    const mcp = await runStudioTool(name, args, { application: app, owner: LOCAL_AGENT_OWNER });
    assert.ok(mcp.response_compaction, `precondition: the MCP view of ${name} is compacted`);
    assert.deepEqual(mcp, compactStudioResponse(name, args, full), 'the MCP transport view is unchanged');
    const local = await callAgentTool(app, name, args, actor);
    assert.equal(local.response_compaction, undefined);
    assert.equal(JSON.stringify(local), JSON.stringify(full), `local ${name} is the full Application Service result`);
  }
});

test('local call --output and its receipt keep a size-compacted run status whole', async t => {
  const { dir, command } = workspace(t);
  const app = createStudioApplication({ dataDirectory: join(dir, 'store'), durability: 'persistent' });
  const { project_id, run_id, status } = await staleCompletedRun(app, join(dir, 'store'), LOCAL_AGENT_OWNER);
  const input = join(dir, 'status-request.json');
  writeFileSync(input, JSON.stringify({ project_id, run_id }));
  const output = join(dir, 'status.json');
  const printed = command(['call', 'studio_run_status', '--input', input, '--output', output]);
  assert.deepEqual(printed, status, 'stdout is the full result');
  assert.deepEqual(JSON.parse(readFileSync(output, 'utf8')), status, '--output holds the full result');
  const receipts = readdirSync(join(dir, 'receipts')).map(name => JSON.parse(readFileSync(join(dir, 'receipts', name), 'utf8')));
  assert.equal(receipts.length, 1);
  assert.deepEqual(receipts[0].result, status, 'the receipt holds the full result');
});

test('local export refuses a stale run whose MCP view compacts the staleness list, with the full list as evidence', async t => {
  const { dir, command } = workspace(t);
  const app = createStudioApplication({ dataDirectory: join(dir, 'store'), durability: 'persistent' });
  const { project_id, run_id, status, view } = await staleCompletedRun(app, join(dir, 'store'), LOCAL_AGENT_OWNER);
  assert.equal(view.staleness.length, undefined, 'precondition: the summary object has no length to test');
  const output = join(dir, 'stale.mml');
  const result = command(['export', '--project-id', project_id, '--run-id', run_id, '--out', output], 1);
  assert.equal(existsSync(output), false, 'no Final of a stale run is written');
  assert.equal(result.error.code, 'AGENT_INPUT_REFUSED');
  assert.match(result.error.message, /bound to changed inputs/);
  assert.deepEqual(result.error.details, {
    run_id, staleness: status.staleness, staleness_notice: status.staleness_notice, canonical: status.canonical,
  }, 'the refusal keeps every staleness entry, not a summary');
  const receipts = readdirSync(join(dir, 'receipts')).map(name => JSON.parse(readFileSync(join(dir, 'receipts', name), 'utf8')));
  assert.equal(receipts.length, 1);
  assert.deepEqual(receipts[0].result, result);
  assert.deepEqual(JSON.parse(JSON.stringify(await app.getRun(LOCAL_AGENT_OWNER, project_id, run_id))), status, 'refusal never rewrites the run');
  assert.equal(existsSync(join(dir, '.agent.lock')), false);
});
