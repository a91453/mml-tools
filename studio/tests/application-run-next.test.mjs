// Real-engine continuation regressions. Fixture declarations are not defaults.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync, readFileSync, statSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createStudioApplication, ERROR_CODES, RUN_STEP } from '../backend/application/index.mjs';
import { FIXTURE_CONFIRMATIONS, projectWithSymbolicAsset, runDecisionsFor } from './fixtures/run-fixtures.mjs';

const OWNER = 'owner:continuation';
const rejected = (promise, code) => assert.rejects(promise, error => error.code === code);
const snapshots = root => Object.fromEntries(readdirSync(root, { recursive: true }).sort().flatMap(name => {
  const path = join(root, name); const stat = statSync(path);
  return stat.isFile() ? [[name, { bytes: readFileSync(path).toString('base64'), mtime: stat.mtimeMs }]] : [];
}));
async function fixture(app) {
  const f = await projectWithSymbolicAsset(app, OWNER);
  const { run } = await app.startRun(OWNER, f.projectId, { asset_ids: [f.assetId] });
  return { ...f, run, next: () => app.nextRun(OWNER, f.projectId, run.run_id) };
}
async function proposalInput(app, f, next, overrides = {}) {
  const events = await app.listBaselineEvents(OWNER, f.projectId, { limit: 3 });
  const target = next.proposal_targets.find(t => t.admissible_kinds.includes('arrangement_decision'));
  return {
    run_id: next.run_id, expected_run_revision: next.run_revision,
    request_key: target.request_key, kind: 'arrangement_decision',
    proposed_by: 'conversation-agent', rationale: 'Preserve source-supported fixture roles with no removal or Lead move.',
    action: { decisions: runDecisionsFor(f.project).map(({ acceptedBy, note, ...rest }) => rest) },
    cites: { event_ids: events.events.map(e => e.event_id) }, ...overrides,
  };
}

test('next is byte-and-mtime read-only, repeatable, detached, and uses the existing bindings', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'run-next-'));
  try {
    const app = createStudioApplication({ dataDirectory: directory, durability: 'persistent' });
    const f = await fixture(app); const before = snapshots(directory);
    const first = await f.next();
    for (let i = 0; i < 5; i++) assert.deepEqual(await f.next(), first);
    assert.deepEqual(snapshots(directory), before);
    assert.equal(first.read_only, true); assert.equal(first.advanced, false);
    assert.equal(first.run_revision, f.run.revision);
    assert.equal(first.baseline_id, f.run.baseline_id);
    assert.equal(first.candidate_id, null);
    assert.deepEqual(first.progress.steps, f.run.steps);
    assert.deepEqual(first.review_requests, f.run.review_requests);
    assert.equal(first.next_action.kind, 'prepare_proposal');
    assert.equal(first.connector_exposure, 'UNVERIFIED_BY_SERVER');
    assert.equal(first.gate_snapshot.recomputed, false);
    assert.equal(first.gate_snapshot.current_binding_verified, false);
    first.review_requests[0].missing.push('client mutation');
    first.canonical.rules_snapshot_sha = 'forged';
    assert.deepEqual(snapshots(directory), before);
    assert.notDeepEqual(await f.next(), first);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test('next requires an explicit owned run and never selects the latest one', async () => {
  const app = createStudioApplication(); const f = await fixture(app);
  await rejected(app.nextRun(OWNER, f.projectId, null), ERROR_CODES.INVALID_REQUEST);
  await rejected(app.nextRun('other-owner', f.projectId, f.run.run_id), ERROR_CODES.PROJECT_NOT_FOUND);
  const other = await fixture(app);
  await rejected(app.nextRun(OWNER, other.projectId, f.run.run_id), ERROR_CODES.RUN_NOT_FOUND);
  const second = await app.startRun(OWNER, f.projectId, {});
  assert.notEqual(second.run.run_id, f.run.run_id);
  assert.equal((await f.next()).run_id, f.run.run_id);
});

test('next refuses verdicts, confirmations, acceptance and prototype-shaped input', async () => {
  const app = createStudioApplication(); const f = await fixture(app); const before = await f.next();
  for (const input of [
    { gates: { technical: 'PASS' } }, { in_game: 'IN_GAME_ACCEPTED' },
    { confirmations: FIXTURE_CONFIRMATIONS }, { accepted_by: 'forged-reviewer' },
    { reconcile: true }, { decisions: [] }, { expected_run_revision: 0 },
    Object.create({ expected_run_revision: f.run.revision }),
    JSON.parse('{"__proto__":{"gates":"PASS"}}'),
  ]) await rejected(app.nextRun(OWNER, f.projectId, f.run.run_id, input), ERROR_CODES.INVALID_REQUEST);
  assert.deepEqual(await f.next(), before);
});

test('observed revisions reject stale reads and new writes, but an exact idempotent retry is safe', async () => {
  const app = createStudioApplication(); const f = await fixture(app); const before = await f.next();
  const input = { expected_run_revision: before.run_revision, idempotency_key: 'resume-once' };
  const resumed = await app.resumeRun(OWNER, f.projectId, before.run_id, input);
  assert.ok(resumed.run.revision > before.run_revision);
  await rejected(app.nextRun(OWNER, f.projectId, before.run_id, { expected_run_revision: before.run_revision }), ERROR_CODES.RUN_CONFLICT);
  await rejected(app.resumeRun(OWNER, f.projectId, before.run_id, { ...input, idempotency_key: 'new-write' }), ERROR_CODES.RUN_CONFLICT);
  const retry = await app.resumeRun(OWNER, f.projectId, before.run_id, input);
  assert.equal(retry.replayed, true); assert.equal(retry.advanced, false);
  assert.equal(retry.run.revision, resumed.run.revision);
});

test('next -> proposal -> explicit resolution uses the existing engine and cannot manufacture Final', async () => {
  const app = createStudioApplication(); const f = await fixture(app); const before = await f.next();
  const submitted = await app.proposeDecision(OWNER, f.projectId, await proposalInput(app, f, before, { idempotency_key: 'proposal-1' }));
  const waiting = await f.next();
  assert.equal(waiting.next_action.kind, 'read_proposal_review');
  assert.equal(waiting.run_revision, before.run_revision); assert.equal(waiting.candidate_id, null);
  assert.equal(waiting.proposals[0].state, 'submitted');
  const review = await app.getProposal(OWNER, f.projectId, submitted.proposal.proposal_id);
  const result = await app.resolveProposal(OWNER, f.projectId, submitted.proposal.proposal_id, {
    resolution: 'accept', accepted_by: 'explicit-fixture-reviewer',
    expected_proposal_revision: review.proposal.revision,
  });
  assert.equal(result.proposal.state, 'applied');
  const next = await f.next();
  assert.ok(next.candidate_id); assert.ok(next.run_revision > waiting.run_revision);
  assert.equal(next.progress.final_artifact_id, null);
  assert.ok(next.blockers.readiness.length > 0);
  assert.equal(next.gate_snapshot.gates.in_game, 'PENDING');
  assert.equal(next.next_action.kind, 'supply_missing_evidence');
  assert.ok(next.missing_evidence.length > 0);
  assert.ok(next.never_agent_settlable.some(text => text.includes('in_game')));
});

test('a stale proposal cannot follow the run onto a new candidate', async () => {
  const app = createStudioApplication(); const f = await fixture(app); const before = await f.next();
  const input = await proposalInput(app, f, before);
  const submitted = await app.proposeDecision(OWNER, f.projectId, input);
  await app.resumeRun(OWNER, f.projectId, f.run.run_id, { decisions: runDecisionsFor(f.project), expected_run_revision: before.run_revision });
  const next = await f.next(); assert.ok(next.candidate_id);
  await rejected(app.resolveProposal(OWNER, f.projectId, submitted.proposal.proposal_id, {
    resolution: 'accept', accepted_by: 'fixture-reviewer', expected_proposal_revision: submitted.proposal.revision,
  }), ERROR_CODES.PROPOSAL_REFUSED);
  assert.equal((await f.next()).candidate_id, next.candidate_id);
});

test('same request keys across sibling runs do not share proposals or candidate bindings', async () => {
  const app = createStudioApplication(); const f = await fixture(app);
  const sibling = (await app.startRun(OWNER, f.projectId, {})).run;
  const a = await f.next(); const b = await app.nextRun(OWNER, f.projectId, sibling.run_id);
  assert.equal(a.proposal_targets[0].request_key, b.proposal_targets[0].request_key);
  await app.proposeDecision(OWNER, f.projectId, await proposalInput(app, f, a));
  assert.equal((await f.next()).proposals.length, 1);
  assert.equal((await app.nextRun(OWNER, f.projectId, sibling.run_id)).proposals.length, 0);
  await app.resumeRun(OWNER, f.projectId, f.run.run_id, { decisions: runDecisionsFor(f.project) });
  assert.ok((await f.next()).candidate_id);
  assert.equal((await app.nextRun(OWNER, f.projectId, sibling.run_id)).candidate_id, null);
});

test('proposal input cannot forge PASS, confirmations or acceptedBy', async () => {
  const app = createStudioApplication(); const f = await fixture(app); const next = await f.next();
  const input = await proposalInput(app, f, next);
  for (const extra of [{ gates: { source: 'PASS' } }, { confirmations: FIXTURE_CONFIRMATIONS }, { in_game: 'PASS' }]) {
    await assert.rejects(app.proposeDecision(OWNER, f.projectId, { ...input, ...extra }));
  }
  const ownAcceptance = structuredClone(input);
  ownAcceptance.action.decisions[0].acceptedBy = 'conversation-agent';
  await assert.rejects(app.proposeDecision(OWNER, f.projectId, ownAcceptance));
  assert.equal((await f.next()).candidate_id, null);
});

test('interrupted apply survives restart; next never reconciles, resume adopts its own effect once', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'run-next-restart-'));
  try {
    const app = createStudioApplication({ dataDirectory: directory, durability: 'persistent' });
    const f = await fixture(app);
    const faulted = createStudioApplication({ dataDirectory: directory, durability: 'persistent', runHooks: {
      afterEffect: ({ step }) => { if (step === RUN_STEP.APPLY_DECISIONS) throw Error('fixture interruption'); },
    } });
    await assert.rejects(faulted.resumeRun(OWNER, f.projectId, f.run.run_id, { decisions: runDecisionsFor(f.project) }), /fixture interruption/);
    const restarted = createStudioApplication({ dataDirectory: directory, durability: 'persistent' });
    const before = snapshots(directory);
    const next = await restarted.nextRun(OWNER, f.projectId, f.run.run_id);
    assert.equal(next.next_action.kind, 'inspect_interrupted_step');
    assert.equal(next.progress.pending_step.step, RUN_STEP.APPLY_DECISIONS);
    assert.equal(next.accepts_proposals, false);
    assert.deepEqual(snapshots(directory), before);
    const count = (await restarted.getProject(OWNER, f.projectId)).project.candidates.length;
    const resumed = await restarted.resumeRun(OWNER, f.projectId, f.run.run_id, { expected_run_revision: next.run_revision, idempotency_key: 'recover-1' });
    assert.equal(resumed.run.pending_step, null); assert.ok(resumed.run.candidate_id);
    assert.equal((await restarted.getProject(OWNER, f.projectId)).project.candidates.length, count);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test('unavailable Canonical remains blocked and advertises no writes', async () => {
  const app = createStudioApplication({ loadEngines: async () => { throw Error('Published snapshot unavailable'); } });
  const project = (await app.createProject(OWNER, { title: 'unloaded' })).project;
  const { run } = await app.startRun(OWNER, project.project_id, {});
  const next = await app.nextRun(OWNER, project.project_id, run.run_id);
  assert.equal(next.next_action.kind, 'restore_published_canonical');
  assert.deepEqual(next.blockers.canonical, ['CANONICAL_NOT_LOADED']);
  assert.ok(next.allowed_operations.every(operation => operation.read_only));
  assert.equal(next.accepts_proposals, false);
});
