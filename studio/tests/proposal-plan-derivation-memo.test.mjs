// The AI Proposal Protocol — the Agent Review Policy's plan derivation is
// derived once per set of inputs, and never served for any other.
//
// The policy grades whether an acceptance could translate a reduction or
// adaptation proposal by running the same read-only plan derivation the
// acceptance runs. The engine behind it is synchronous, and on a song-length
// project one reduction plan holds the event loop for seconds -- and the
// policy runs on every read, on every submission, on the answer to a
// rejection or withdrawal and under the lock before an acceptance, while
// clients poll the read. So the derivation's outcome is memoized, keyed on
// everything it reads: the operation's exact input, the loaded engines, and a
// digest of the stored bytes the operation reads.
//
// Two things are pinned here, and the second is the one that matters:
//
//   * the derivation runs once for one set of inputs, not once per read;
//   * a held outcome is never served for inputs it was not derived from --
//     each input, changed on its own, is derived afresh, and a derivation a
//     write may have raced is not held at all.
//
// Both are pinned twice: through the real service, where only what a caller
// can move is moved, and against the memo itself (`plan-derivation-memo.mjs`)
// over a world whose every input a test controls, including the two a
// running service holds constant -- the loaded engines and the rules snapshot
// they were loaded as.

import test from 'node:test';
import assert from 'node:assert/strict';

import { mkdtemp, readFile, rm, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { AGENT_REVIEW, PROPOSAL_KIND, createStudioApplication } from '../backend/application/index.mjs';
import { createArrangementService } from '../backend/application/arrangement-service.mjs';
import { ERROR_CODES } from '../backend/application/contracts.mjs';
import { PLAN_DERIVATION_MEMO_LIMIT, createPlanDerivationMemo } from '../backend/application/plan-derivation-memo.mjs';
import { createIntakeService } from '../backend/application/intake-service.mjs';
import { blobName, createStore } from '../backend/application/store.mjs';
import { baselineWithUnassignedRole, FIXTURE_SOURCE_ID } from './fixtures/g12-fixtures.mjs';
import { RUN_REVIEWER, projectWithSymbolicAsset, runDecisionsFor } from './fixtures/run-fixtures.mjs';
import { enginesWith } from './support/real-engines.mjs';

const OWNER = 'owner:proposal-plan-memo';
const AGENT = 'some-external-agent';
// The reviewer the plan operation previews under when a proposal names none,
// which is the one the policy's own derivation runs under.
const PREVIEW_REVIEWER = 'reduction-preview';

const REDUCTION_DECISIONS = [{
  id: 'place-chord5',
  action: 'REDISTRIBUTE',
  eventIds: ['chord5-1', 'chord5-2', 'chord5-3'],
  toRole: 'Chord5',
  reason: 'The official source carries this lane as secondary bass reinforcement; it is placed in the one free enrichment role.',
  evidence: [`${FIXTURE_SOURCE_ID}#Chord5`],
}];

const withDirectory = async body => {
  const directory = await mkdtemp(join(tmpdir(), 'mml-proposal-plan-memo-'));
  try { return await body(directory); } finally { await rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); }
};

/**
 * A service whose reduction engine records every plan it derives for a
 * proposal's decisions, under which reviewer. `during` runs inside the
 * engine call, synchronously, when set.
 */
const countingApp = (options = {}) => {
  const calls = [];
  const hooks = { during: null };
  const app = createStudioApplication({
    ...options,
    loadEngines: enginesWith(engines => ({
      reduction: {
        ...engines.reduction,
        planFinalReduction: input => {
          if ((input.decisions ?? []).some(decision => decision.id === 'place-chord5')) {
            calls.push({ acceptedBy: input.acceptedBy, candidate: input.parent?.revision?.id ?? null });
            hooks.during?.();
          }
          return engines.reduction.planFinalReduction(input);
        },
      },
    })),
  });
  // How many plans one operation made the engine derive, and under whom.
  const derivedBy = async operation => {
    const before = calls.length;
    const value = await operation();
    return { value, derived: calls.slice(before) };
  };
  return { app, calls, hooks, derivedBy };
};

/** One run per candidate, each stopped at the reduction, in one project. */
async function runsAwaitingReduction(app, reviewers = [RUN_REVIEWER]) {
  const fixture = await projectWithSymbolicAsset(app, OWNER, { project: baselineWithUnassignedRole() });
  await app.analyzeSources(OWNER, fixture.projectId, { assetIds: [fixture.assetId] });
  const runs = [];
  for (const reviewer of reviewers) {
    const candidateId = (await app.applyDecisions(OWNER, fixture.projectId, {
      decisions: runDecisionsFor(fixture.project, { exclude: ['Chord5'], acceptedBy: reviewer }),
    })).decisions.candidate_id;
    const started = await app.startRun(OWNER, fixture.projectId, { target_candidate_id: candidateId });
    assert.equal(started.run.halt.reason, 'AWAITING_ACCEPTED_REDUCTION_DECISIONS', JSON.stringify(started.run.halt));
    const target = (await app.proposalTargets(OWNER, fixture.projectId, started.run.run_id)).targets.find(entry => entry.code === 'REDUCTION_DECISIONS_REQUIRED');
    runs.push({ run: started.run, target, candidateId });
  }
  return { fixture, runs };
}

const propose = (app, fixture, on, action, rationale = 'Place the unassigned lane in the one free enrichment role.') => app.proposeDecision(OWNER, fixture.projectId, {
  run_id: on.run.run_id,
  request_key: on.target.request_key,
  kind: PROPOSAL_KIND.FINAL_REDUCTION,
  proposed_by: AGENT,
  rationale,
  action,
  cites: { event_ids: ['chord5-1'], source_ids: [FIXTURE_SOURCE_ID] },
});

const reviewOf = async (app, fixture, proposalId) => (await app.getProposal(OWNER, fixture.projectId, proposalId)).proposal.agent_review;

// ─── derived once ───────────────────────────────────────────────────────────

test('the policy derives a plan once per set of inputs, however often the proposal is read', async () => {
  const { app, derivedBy } = countingApp();
  const { fixture, runs: [on] } = await runsAwaitingReduction(app);

  const submitted = await derivedBy(() => propose(app, fixture, on, { decisions: REDUCTION_DECISIONS }));
  assert.equal(submitted.value.proposal.agent_review.verdict, AGENT_REVIEW.REQUIRES_EXPLICIT_ACCEPTANCE);
  assert.deepEqual(submitted.derived.map(call => call.acceptedBy), [PREVIEW_REVIEWER], 'graded at submission, by one derivation');
  const proposalId = submitted.value.proposal.proposal_id;

  // The read an agent polls. The verdict is recomputed each time; the plan
  // behind it is not derived again, because nothing it reads has changed.
  for (let read = 0; read < 3; read += 1) {
    const reread = await derivedBy(() => reviewOf(app, fixture, proposalId));
    assert.equal(reread.value.verdict, AGENT_REVIEW.REQUIRES_EXPLICIT_ACCEPTANCE);
    assert.deepEqual(reread.derived, [], `read ${read + 1} derives nothing`);
  }

  // Another proposal with the same action on the same material is the same
  // derivation, and so is the answer to its withdrawal.
  const twin = await derivedBy(() => propose(app, fixture, on, { decisions: REDUCTION_DECISIONS }, 'The same placement, stated again.'));
  assert.equal(twin.value.proposal.agent_review.verdict, AGENT_REVIEW.REQUIRES_EXPLICIT_ACCEPTANCE);
  assert.deepEqual(twin.derived, []);
  const withdrawn = await derivedBy(() => app.resolveProposal(OWNER, fixture.projectId, twin.value.proposal.proposal_id, { resolution: 'withdraw', reason: 'A duplicate.' }));
  assert.equal(withdrawn.value.proposal.state, 'withdrawn');
  assert.deepEqual(withdrawn.derived, []);

  // A refusal is the derivation's answer too, and is held the same way: the
  // read still says INVALID, with the plan the action really produces.
  const wrong = await derivedBy(() => propose(app, fixture, on, { decisions: REDUCTION_DECISIONS, expected_plan_id: `g12:plan:${'0'.repeat(64)}`, plan_accepted_by: 'someone-else' }, 'A wrong plan id.'));
  assert.deepEqual(wrong.value.proposal.agent_review.refusals, ['REDUCTION_PLAN_ID_MISMATCH']);
  assert.deepEqual(wrong.derived.map(call => call.acceptedBy), ['someone-else']);
  const wrongRead = await derivedBy(() => reviewOf(app, fixture, wrong.value.proposal.proposal_id));
  assert.deepEqual(wrongRead.derived, []);
  assert.deepEqual(wrongRead.value.refusals, ['REDUCTION_PLAN_ID_MISMATCH']);
  assert.equal(wrongRead.value.derived_plan_id, wrong.value.proposal.agent_review.derived_plan_id);

  // The acceptance grades it again under the lock -- from the outcome it was
  // just given, for the same inputs -- and its translation derives afresh,
  // under the ACCEPTING reviewer, as the backstop it is.
  const accepted = await derivedBy(() => app.resolveProposal(OWNER, fixture.projectId, proposalId, { resolution: 'accept', accepted_by: RUN_REVIEWER }));
  assert.equal(accepted.value.proposal.state, 'applied');
  assert.deepEqual(accepted.derived.filter(call => call.acceptedBy === PREVIEW_REVIEWER), [], 'no second policy derivation in the lock');
  assert.ok(accepted.derived.some(call => call.acceptedBy === RUN_REVIEWER), 'the translation still derives its own plan');
});

// ─── never served for other inputs ──────────────────────────────────────────

test('a held plan is never served for another candidate, another reviewer or another action', async () => {
  const { app, derivedBy } = countingApp();
  const { fixture, runs: [first, second] } = await runsAwaitingReduction(app, [RUN_REVIEWER, 'a-second-reviewer']);
  assert.notEqual(first.candidateId, second.candidateId);

  // The same decisions plan differently on the two candidates.
  const named = 'a-reviewer-the-agent-named';
  const planOn = async candidateId => (await app.planFinalReduction(OWNER, fixture.projectId, { candidateId, decisions: REDUCTION_DECISIONS, acceptedBy: named })).reduction.plan.id;
  const firstPlan = await planOn(first.candidateId);
  assert.notEqual(firstPlan, await planOn(second.candidateId));

  // One action, word for word, stating the first candidate's plan. Graded
  // against the first run it is right; against the second it is wrong -- and
  // it is only found wrong because the second is derived for its own
  // candidate rather than served the first one's plan.
  const action = { decisions: REDUCTION_DECISIONS, expected_plan_id: firstPlan, plan_accepted_by: named };
  const onFirst = await derivedBy(() => propose(app, fixture, first, action));
  assert.equal(onFirst.value.proposal.agent_review.verdict, AGENT_REVIEW.REQUIRES_EXPLICIT_ACCEPTANCE, JSON.stringify(onFirst.value.proposal.agent_review));
  assert.deepEqual(onFirst.derived.map(call => [call.acceptedBy, call.candidate]), [[named, first.candidateId]]);
  const onSecond = await derivedBy(() => propose(app, fixture, second, action));
  assert.equal(onSecond.value.proposal.agent_review.verdict, AGENT_REVIEW.INVALID);
  assert.deepEqual(onSecond.value.proposal.agent_review.refusals, ['REDUCTION_PLAN_ID_MISMATCH']);
  assert.deepEqual(onSecond.derived.map(call => [call.acceptedBy, call.candidate]), [[named, second.candidateId]]);
  // And each stays what it is on a read.
  assert.equal((await reviewOf(app, fixture, onFirst.value.proposal.proposal_id)).verdict, AGENT_REVIEW.REQUIRES_EXPLICIT_ACCEPTANCE);
  assert.equal((await reviewOf(app, fixture, onSecond.value.proposal.proposal_id)).verdict, AGENT_REVIEW.INVALID);

  // Another reviewer: the same decisions and stated id, named under someone
  // else, is its own derivation and is found wrong.
  const otherReviewer = await derivedBy(() => propose(app, fixture, first, { ...action, plan_accepted_by: 'someone-else' }));
  assert.deepEqual(otherReviewer.derived.map(call => call.acceptedBy), ['someone-else']);
  assert.deepEqual(otherReviewer.value.proposal.agent_review.refusals, ['REDUCTION_PLAN_ID_MISMATCH']);

  // Another action: one word of one decision's reason is another input.
  const reworded = [{ ...REDUCTION_DECISIONS[0], reason: `${REDUCTION_DECISIONS[0].reason} Reworded.` }];
  const otherAction = await derivedBy(() => propose(app, fixture, first, { decisions: reworded }));
  assert.equal(otherAction.derived.length, 1);
  assert.equal(otherAction.value.proposal.agent_review.verdict, AGENT_REVIEW.REQUIRES_EXPLICIT_ACCEPTANCE);
});

test('a held plan is never served once a stored byte it was derived from has changed', async () => {
  await withDirectory(async directory => {
    const { app, derivedBy } = countingApp({ dataDirectory: directory, durability: 'persistent' });
    const { fixture, runs: [on] } = await runsAwaitingReduction(app);
    const submitted = await propose(app, fixture, on, { decisions: REDUCTION_DECISIONS });
    const proposalId = submitted.proposal.proposal_id;
    const read = () => derivedBy(() => reviewOf(app, fixture, proposalId));
    assert.deepEqual((await read()).derived, [], 'held');

    // Written outside the service, under the same ids, while it runs: the
    // bytes move and nothing that names them does.
    const blob = key => join(directory, 'blobs', `${blobName(key)}.bin`);
    const reserialize = async path => writeFile(path, JSON.stringify(JSON.parse(await readFile(path, 'utf8')), null, 1));
    const candidateBlob = blob(`application:${fixture.projectId}:${on.candidateId}`);

    // The candidate's stored application: the same content, other bytes.
    await reserialize(candidateBlob);
    let reread = await read();
    assert.equal(reread.derived.length, 1, 'derived afresh after the candidate bytes moved');
    assert.equal(reread.value.verdict, AGENT_REVIEW.REQUIRES_EXPLICIT_ACCEPTANCE);
    assert.deepEqual((await read()).derived, [], 'and held again');

    // The stored baseline, the same way.
    await reserialize(blob(`baseline:${fixture.projectId}`));
    reread = await read();
    assert.equal(reread.derived.length, 1, 'derived afresh after the baseline bytes moved');
    assert.equal(reread.value.verdict, AGENT_REVIEW.REQUIRES_EXPLICIT_ACCEPTANCE);

    // The asset registry an adaptation reads, through the service.
    await app.uploadAsset(OWNER, fixture.projectId, { kind: 'report', filename: 'notes.txt', mediaType: 'text/plain', bytes: new TextEncoder().encode('a reviewer note') });
    reread = await read();
    assert.equal(reread.derived.length, 1, 'derived afresh after the asset registry moved');
    assert.equal(reread.value.verdict, AGENT_REVIEW.REQUIRES_EXPLICIT_ACCEPTANCE);

    // Gone altogether. A plan that cannot be derived is STALE -- and that is
    // a fact about this moment, so it is never held: every read derives again.
    await unlink(candidateBlob);
    for (let attempt = 0; attempt < 2; attempt += 1) {
      reread = await read();
      assert.equal(reread.value.verdict, AGENT_REVIEW.STALE);
      assert.deepEqual(reread.value.refusals, ['CANDIDATE_CHANGED']);
      assert.equal(reread.value.plan_derivation_error, 'CANDIDATE_NOT_FOUND');
    }
  });
});

test('a derivation a write may have raced is not held', async () => {
  // Reads are not serialized. A write that lands between taking the key and
  // the derivation's own reads could pair the key of one state with the
  // answer of another, so an outcome derived while the store's write count
  // moved is answered but not kept.
  const { app, hooks, derivedBy } = countingApp();
  const { fixture, runs: [on] } = await runsAwaitingReduction(app);

  // A write from elsewhere in the process, landing during the derivation.
  hooks.during = () => { app.createProject('owner:someone-else', { title: 'written meanwhile' }).catch(() => {}); };
  const submitted = await derivedBy(() => propose(app, fixture, on, { decisions: REDUCTION_DECISIONS }));
  assert.equal(submitted.derived.length, 1);
  hooks.during = null;

  const proposalId = submitted.value.proposal.proposal_id;
  const first = await derivedBy(() => reviewOf(app, fixture, proposalId));
  assert.equal(first.derived.length, 1, 'not held: the write moved the count while it was derived');
  assert.equal(first.value.verdict, AGENT_REVIEW.REQUIRES_EXPLICIT_ACCEPTANCE);
  assert.deepEqual((await derivedBy(() => reviewOf(app, fixture, proposalId))).derived, [], 'held once derived undisturbed');
});

// ─── what the key covers ────────────────────────────────────────────────────

test('the stored-input identity moves with every stored byte a plan operation reads, and only those', () => {
  const projectId = 'prj_00000000000000000000000000000001';
  const store = createStore({});
  let record;
  const projects = { load: () => structuredClone(record) };
  const intake = createIntakeService({ canonical: null, projects, assets: null, store });
  const arrangement = createArrangementService({ canonical: null, projects, intake, store });
  const put = (key, text) => store.putBytes(key, new TextEncoder().encode(text));

  const root = 'g11d:rev:root';
  const head = 'g11d:rev:head';
  const sibling = 'g11d:rev:sibling';
  record = {
    project_id: projectId,
    baseline: { baseline_id: 'bas:one' },
    candidates: [
      { candidate_id: root, parent_candidate_id: null },
      { candidate_id: head, parent_candidate_id: root },
      { candidate_id: sibling, parent_candidate_id: root },
    ],
    assets: [{ asset_id: 'ast_1', kind: 'canonical_project', sha256: 'a'.repeat(64), size: 1 }],
  };
  put(`baseline:${projectId}`, '{"baseline":1}');
  put(`application:${projectId}:${root}`, '{"root":1}');
  put(`application:${projectId}:${head}`, '{"head":1}');
  put(`application:${projectId}:${sibling}`, '{"sibling":1}');

  const identity = () => arrangement.planInputIdentity(OWNER, projectId, head);
  const start = identity();
  assert.equal(identity(), start, 'a pure function of what is stored');

  const moves = [
    ['the baseline bytes', () => put(`baseline:${projectId}`, '{"baseline":2}')],
    ['the baseline id', () => { record.baseline.baseline_id = 'bas:two'; }],
    ['the candidate bytes', () => put(`application:${projectId}:${head}`, '{"head":2}')],
    ['an ancestor\'s bytes', () => put(`application:${projectId}:${root}`, '{"root":2}')],
    ['the lineage link', () => { record.candidates[1].parent_candidate_id = sibling; }],
    ['the asset registry', () => { record.assets.push({ asset_id: 'ast_2', kind: 'report', sha256: 'b'.repeat(64), size: 2 }); }],
    ['a missing candidate blob', () => store.deleteBytes(`application:${projectId}:${head}`)],
  ];
  const seen = new Set([start]);
  for (const [name, move] of moves) {
    move();
    const now = identity();
    assert.ok(!seen.has(now), `${name} moves the identity`);
    seen.add(now);
  }

  // What no plan operation reads does not move it: a candidate off the
  // lineage, and a blob under another key.
  put(`application:${projectId}:${head}`, '{"head":3}');
  record.candidates[1].parent_candidate_id = root;
  const settled = identity();
  put(`application:${projectId}:${sibling}`, '{"sibling":2}');
  put(`suggestion:any:${projectId}`, '{"cache":1}');
  assert.equal(identity(), settled);
});

// ─── the memo itself, against every input ───────────────────────────────────

/**
 * A memo over a world whose every input the test controls. The derivation's
 * answer names every input it read, at the moment it read them, so an outcome
 * served for any other inputs than the current ones cannot pass for the
 * right one.
 */
const memoWorld = ({ limit } = {}) => {
  const world = {
    engines: { release: 'engines-1' },
    rules: 'rules-1',
    stored: { 'cand-1': 'bytes-1', 'cand-2': 'bytes-2' },
    writes: 0,
    refuse: false,
    unreadable: false,
    identityUnreadable: false,
    enginesUnreadable: false,
    // Run inside the derivation: before it reads the world, and after.
    beforeRead: null,
    afterRead: null,
  };
  const failure = (code, message) => Object.assign(new Error(message), { code });
  const answerFor = (owner, projectId, request) => JSON.stringify({
    owner, projectId, request, engines: world.engines.release, rules: world.rules, stored: world.stored[request.input.candidateId] ?? null,
  });
  const derivations = [];
  const memo = createPlanDerivationMemo({
    canonical: {
      engines: async () => {
        if (world.enginesUnreadable) throw failure(ERROR_CODES.ENGINE_UNAVAILABLE, 'no engines');
        return world.engines;
      },
      provenance: async () => ({ rules_snapshot_sha: world.rules }),
    },
    store: { writeCount: () => world.writes },
    // Deliberately blind to the owner and the project, so that the memo's own
    // key is what keeps two owners' or two projects' outcomes apart.
    planInputIdentity: (_owner, _projectId, candidateId) => {
      if (world.identityUnreadable) throw failure(ERROR_CODES.CANDIDATE_NOT_FOUND, 'unreadable');
      return JSON.stringify([candidateId, world.stored[candidateId] ?? null]);
    },
    derive: async (owner, projectId, request) => {
      world.beforeRead?.();
      const answer = answerFor(owner, projectId, request);
      derivations.push(answer);
      world.afterRead?.();
      if (world.unreadable) throw failure(ERROR_CODES.CANDIDATE_NOT_FOUND, 'The stored candidate is no longer available');
      if (world.refuse) throw failure(ERROR_CODES.INVALID_REQUEST, `refused ${answer}`);
      return `plan:${answer}`;
    },
    ...(limit === undefined ? {} : { limit }),
  });
  const request = (overrides = {}) => ({
    operation: 'planFinalReduction',
    input: { candidateId: 'cand-1', decisions: [{ id: 'd1', action: 'REDISTRIBUTE' }], acceptedBy: 'reviewer-1', instrumentProfile: null, ...overrides },
  });
  // One call: how many derivations it ran, and the derivation's answer for
  // the world as it stands now, which is what it must have answered.
  const call = async (owner = 'owner-1', projectId = 'prj-1', req = request()) => {
    const before = derivations.length;
    const outcome = await memo.outcome(owner, projectId, req);
    return { outcome, derived: derivations.length - before, current: `plan:${answerFor(owner, projectId, req)}` };
  };
  return { world, memo, request, call };
};

test('the memo derives afresh when any one input changes, and never serves an outcome for other inputs', async () => {
  const { world, request, call } = memoWorld();
  const base = { owner: 'owner-1', projectId: 'prj-1', req: request() };
  const engines = world.engines;
  const first = await call(base.owner, base.projectId, base.req);
  assert.equal(first.derived, 1);
  assert.equal(first.outcome.plan_id, first.current);
  const again = await call(base.owner, base.projectId, base.req);
  assert.equal(again.derived, 0, 'held for the same inputs');
  assert.equal(again.outcome.plan_id, first.current);

  // Each input, moved on its own and then put back. Moved, it is derived
  // afresh and the answer is the one for the moved world; put back, the
  // outcome held for the original inputs is the one served.
  const moves = [
    ['the owner', { owner: 'owner-2' }],
    ['the project', { projectId: 'prj-2' }],
    ['the operation', { req: { ...request(), operation: 'planMobileAdaptation' } }],
    ['the bound candidate', { req: request({ candidateId: 'cand-2' }) }],
    ['the decisions', { req: request({ decisions: [{ id: 'd1', action: 'OMIT' }] }) }],
    ['the reviewer', { req: request({ acceptedBy: 'reviewer-2' }) }],
    ['the instrument profile', { req: request({ instrumentProfile: { id: 'harp' } }) }],
    ['an adaptation profile', { req: { operation: 'planMobileAdaptation', input: { candidateId: 'cand-1', profile: { id: 'mobile-1' } } } }],
    ['the rules snapshot', { world: () => { world.rules = 'rules-2'; }, undo: () => { world.rules = 'rules-1'; } }],
    ['the engines release', { world: () => { world.engines = { release: 'engines-2' }; }, undo: () => { world.engines = engines; } }],
    ['the stored bytes', { world: () => { world.stored['cand-1'] = 'bytes-1b'; }, undo: () => { world.stored['cand-1'] = 'bytes-1'; } }],
  ];
  for (const [name, move] of moves) {
    move.world?.();
    const at = { ...base, ...move };
    const moved = await call(at.owner, at.projectId, at.req);
    assert.equal(moved.derived, 1, `${name}: derived afresh`);
    assert.equal(moved.outcome.plan_id, moved.current, `${name}: the answer for the moved input`);
    assert.notEqual(moved.outcome.plan_id, first.current, `${name}: not the outcome held for the original`);
    assert.equal((await call(at.owner, at.projectId, at.req)).derived, 0, `${name}: then held`);
    move.undo?.();
    const back = await call(base.owner, base.projectId, base.req);
    assert.equal(back.derived, 0, `${name}: put back, the original is still held`);
    assert.equal(back.outcome.plan_id, first.current, `${name}: and it is the original's answer`);
  }

  // The engines are compared by identity, not by what they say they are: a
  // reload that reports the same release is still another set of engines.
  world.engines = { release: 'engines-1' };
  const reloaded = await call(base.owner, base.projectId, base.req);
  assert.equal(reloaded.derived, 1, 'other engines, derived afresh');
  assert.equal(reloaded.outcome.plan_id, reloaded.current);
});

test('the memo holds a refusal, and never a failure to read', async () => {
  const { world, request, call } = memoWorld();

  // The plan operation's refusal is its answer for these inputs.
  world.refuse = true;
  const refused = await call();
  assert.equal(refused.derived, 1);
  assert.equal(refused.outcome.plan_id, null);
  assert.equal(refused.outcome.refusal.code, ERROR_CODES.INVALID_REQUEST);
  assert.equal(refused.outcome.refusal.message, `refused ${refused.current.slice('plan:'.length)}`);
  const heldRefusal = await call();
  assert.equal(heldRefusal.derived, 0);
  assert.deepEqual(heldRefusal.outcome, refused.outcome);
  world.refuse = false;

  // Anything else is a fact about this moment: thrown every time, derived
  // every time -- and once the material reads again, the plan it produces.
  const other = request({ candidateId: 'cand-2' });
  world.unreadable = true;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    await assert.rejects(call('owner-1', 'prj-1', other), error => error.code === ERROR_CODES.CANDIDATE_NOT_FOUND);
  }
  world.unreadable = false;
  const readable = await call('owner-1', 'prj-1', other);
  assert.equal(readable.derived, 1, 'the failures were not held');
  assert.equal(readable.outcome.plan_id, readable.current);

  // A key that cannot be taken is no reason to skip the derivation, and what
  // it derives is answered but not held.
  for (const flag of ['identityUnreadable', 'enginesUnreadable']) {
    world[flag] = true;
    const req = request({ acceptedBy: `unkeyed-${flag}` });
    const unkeyed = await call('owner-1', 'prj-1', req);
    assert.equal(unkeyed.derived, 1, `${flag}: derived`);
    assert.equal(unkeyed.outcome.plan_id, unkeyed.current);
    assert.equal((await call('owner-1', 'prj-1', req)).derived, 1, `${flag}: and not held`);
    world[flag] = false;
  }
});

test('the memo holds nothing a change during the derivation may have raced', async () => {
  // A write of this process that moves the material and puts it back while
  // the derivation reads: the key and the material read afterwards agree,
  // and only the write count says the derivation may have read the other
  // state. Held, that answer would be served for the original bytes.
  {
    const { world, call } = memoWorld();
    world.beforeRead = () => { world.stored['cand-1'] = 'bytes-elsewhere'; world.writes += 1; };
    world.afterRead = () => { world.stored['cand-1'] = 'bytes-1'; world.writes += 1; };
    assert.equal((await call()).derived, 1);
    world.beforeRead = null;
    world.afterRead = null;
    const next = await call();
    assert.equal(next.derived, 1, 'the raced outcome was not held');
    assert.equal(next.outcome.plan_id, next.current);
    assert.equal((await call()).derived, 0, 'and an undisturbed one is');
  }

  // A change this process did not write -- another process on the same store
  // directory, an operator restoring a file -- moves no write count. The
  // material read again after the derivation is what catches it.
  for (const [name, change] of [
    ['stored bytes', world => { world.stored['cand-1'] = 'bytes-from-elsewhere'; }],
    ['engines', world => { world.engines = { release: 'engines-2' }; }],
    ['rules snapshot', world => { world.rules = 'rules-2'; }],
  ]) {
    const { world, call } = memoWorld();
    const original = { engines: world.engines, rules: world.rules, stored: { ...world.stored } };
    world.beforeRead = () => change(world);
    assert.equal((await call()).derived, 1);
    world.beforeRead = null;
    world.engines = original.engines;
    world.rules = original.rules;
    world.stored = { ...original.stored };
    const next = await call();
    assert.equal(next.derived, 1, `${name}: the raced outcome was not held for the key it was taken under`);
    assert.equal(next.outcome.plan_id, next.current);
  }
});

test('the memo is bounded, least recently used out first', async () => {
  const { memo, request, call } = memoWorld({ limit: 3 });
  const reqs = ['a', 'b', 'c', 'd'].map(name => request({ acceptedBy: name }));
  for (const req of reqs.slice(0, 3)) assert.equal((await call('owner-1', 'prj-1', req)).derived, 1);
  assert.equal(memo.size(), 3);
  // Reading `a` makes `b` the least recently used.
  assert.equal((await call('owner-1', 'prj-1', reqs[0])).derived, 0);
  assert.equal((await call('owner-1', 'prj-1', reqs[3])).derived, 1);
  assert.equal(memo.size(), 3, 'never more than the limit');
  assert.equal((await call('owner-1', 'prj-1', reqs[0])).derived, 0, 'a recently read outcome stays');
  const evicted = await call('owner-1', 'prj-1', reqs[1]);
  assert.equal(evicted.derived, 1, 'the least recently used one was evicted, and costs one derivation');
  assert.equal(evicted.outcome.plan_id, evicted.current);

  // The service's own bound.
  const service = memoWorld();
  for (let index = 0; index < PLAN_DERIVATION_MEMO_LIMIT + 20; index += 1) {
    await service.call('owner-1', 'prj-1', service.request({ acceptedBy: `reviewer-${index}` }));
    assert.ok(service.memo.size() <= PLAN_DERIVATION_MEMO_LIMIT);
  }
  assert.equal(service.memo.size(), PLAN_DERIVATION_MEMO_LIMIT);
});
