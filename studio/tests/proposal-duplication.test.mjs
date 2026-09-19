// The AI Proposal Protocol — one acceptance, one application.
//
// An acceptance cannot be done under the project lock, because `runs.resume`
// takes that lock itself and one project key acquired twice deadlocks by
// construction. So the acceptance is recorded under the lock, the lock is
// released, the run is resumed, and the outcome is recorded under the lock
// again — and that leaves a window in the middle.
//
// The window is closed with what Phase 1 already built rather than a second
// mechanism: the acceptance mints a deterministic idempotency key from the
// proposal id and the revision it was accepted at, and passes the run revision
// it observed as a precondition. Everything below is about that being enough.
//
// What "enough" means precisely: after any number of crashes, retries and
// concurrent callers, the step the proposal asked for has happened at most
// once, and the proposal's record says which.

import test from 'node:test';
import assert from 'node:assert/strict';

import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { PROPOSAL_KIND, PROPOSAL_STATE, RUN_STEP, createStudioApplication } from '../backend/application/index.mjs';
import { RUN_REVIEWER, projectWithSymbolicAsset, runDecisionsFor } from './fixtures/run-fixtures.mjs';

const OWNER = 'owner:proposal-duplication';
const AGENT = 'some-external-agent';

const proposable = project => runDecisionsFor(project, {}).map(({ acceptedBy, note, ...rest }) => rest);

const withDirectory = async body => {
  const directory = await mkdtemp(join(tmpdir(), 'mml-proposal-duplication-'));
  try { return await body(directory); } finally { await rm(directory, { recursive: true, force: true }); }
};

/** A submitted, applicable arrangement proposal on a fresh run. */
async function submitted(app, owner = OWNER) {
  const fixture = await projectWithSymbolicAsset(app, owner);
  const started = await app.startRun(owner, fixture.projectId, { asset_ids: [fixture.assetId] });
  const targets = await app.proposalTargets(owner, fixture.projectId, started.run.run_id);
  const target = targets.targets.find(entry => entry.admissible_kinds.includes(PROPOSAL_KIND.ARRANGEMENT_DECISION));
  const events = await app.listBaselineEvents(owner, fixture.projectId, { limit: 3 });
  const proposal = (await app.proposeDecision(owner, fixture.projectId, {
    run_id: started.run.run_id,
    request_key: target.request_key,
    kind: PROPOSAL_KIND.ARRANGEMENT_DECISION,
    proposed_by: AGENT,
    rationale: 'Keep every source-supported role.',
    action: { decisions: proposable(fixture.project) },
    cites: { event_ids: events.events.map(entry => entry.event_id) },
  })).proposal;
  return { fixture, run: started.run, proposal };
}

const candidatesOf = async (app, projectId, owner = OWNER) => (await app.getProject(owner, projectId)).project.candidates;

// ─── A. the ordinary retry ──────────────────────────────────────────────────

test('accepting the same proposal twice applies it once', async () => {
  const app = createStudioApplication({});
  const context = await submitted(app);

  const first = await app.resolveProposal(OWNER, context.fixture.projectId, context.proposal.proposal_id, {
    resolution: 'accept', accepted_by: RUN_REVIEWER,
  });
  assert.equal(first.applied, true);
  assert.equal(first.proposal.state, PROPOSAL_STATE.APPLIED);
  const afterFirst = await candidatesOf(app, context.fixture.projectId);
  assert.equal(afterFirst.length, 1);

  // A resolved proposal is an audit record, not a workspace.
  await assert.rejects(
    app.resolveProposal(OWNER, context.fixture.projectId, context.proposal.proposal_id, { resolution: 'accept', accepted_by: RUN_REVIEWER }),
    error => error.code === 'PROPOSAL_CONFLICT',
  );
  assert.deepEqual(await candidatesOf(app, context.fixture.projectId), afterFirst, 'nothing was applied a second time');
});

test('two callers accepting at once apply it once, and both see the same answer', async () => {
  const app = createStudioApplication({});
  const context = await submitted(app);

  // No await between them: both are in flight before either completes.
  const results = await Promise.allSettled([
    app.resolveProposal(OWNER, context.fixture.projectId, context.proposal.proposal_id, { resolution: 'accept', accepted_by: RUN_REVIEWER }),
    app.resolveProposal(OWNER, context.fixture.projectId, context.proposal.proposal_id, { resolution: 'accept', accepted_by: RUN_REVIEWER }),
  ]);
  const applied = results.filter(entry => entry.status === 'fulfilled' && entry.value.applied);
  assert.ok(applied.length >= 1, `at least one must apply: ${JSON.stringify(results.map(entry => entry.reason?.code ?? entry.value?.applied))}`);

  // However many callers got an answer, the step ran once. The second
  // acceptance re-issues the SAME deterministic key, so the run replays its own
  // receipt rather than applying anything again.
  const candidates = await candidatesOf(app, context.fixture.projectId);
  assert.equal(candidates.length, 1, 'exactly one candidate was minted');
  for (const entry of applied) {
    assert.equal(entry.value.run.candidate_id, candidates[0].candidate_id, 'and every caller was told about that one');
  }
  const stored = await app.getProposal(OWNER, context.fixture.projectId, context.proposal.proposal_id);
  assert.equal(stored.proposal.state, PROPOSAL_STATE.APPLIED);
});

test('an acceptance racing a manual resume does not apply the step twice', async () => {
  const app = createStudioApplication({});
  const context = await submitted(app);

  // The same decisions, arriving two ways at once. The run's per-step lock and
  // its own staleness re-validation are what make this safe; the proposal layer
  // adds nothing and needs to add nothing.
  const results = await Promise.allSettled([
    app.resolveProposal(OWNER, context.fixture.projectId, context.proposal.proposal_id, { resolution: 'accept', accepted_by: RUN_REVIEWER }),
    app.resumeRun(OWNER, context.fixture.projectId, context.run.run_id, {
      decisions: runDecisionsFor(context.fixture.project, { acceptedBy: RUN_REVIEWER }),
    }),
  ]);
  assert.ok(results.some(entry => entry.status === 'fulfilled'), JSON.stringify(results.map(entry => entry.reason?.code)));

  // Both paths apply the identical decision set, so both produce the identical
  // content-addressed revision -- which is exactly why a duplicate is
  // detectable here rather than hidden behind two ids for one object.
  const candidates = await candidatesOf(app, context.fixture.projectId);
  assert.equal(candidates.length, 1, `one revision, got ${candidates.map(entry => entry.candidate_id).join(', ')}`);
});

// ─── B. the crash in the window ─────────────────────────────────────────────

test('a crash between the acceptance and its application leaves the proposal accepted, and a retry applies it once', async () => {
  await withDirectory(async directory => {
    const app = createStudioApplication({ dataDirectory: directory, durability: 'persistent' });
    const context = await submitted(app);

    // A service that dies inside the resume the acceptance triggers, after the
    // effect and before its receipt -- the hardest of the three interruption
    // classes, because the candidate exists and nothing recorded that it does.
    const interrupted = createStudioApplication({
      dataDirectory: directory,
      durability: 'persistent',
      runHooks: { afterEffect: ({ step }) => { if (step === RUN_STEP.APPLY_DECISIONS) throw Error('the process stopped after the effect'); } },
    });
    const failure = await interrupted.resolveProposal(OWNER, context.fixture.projectId, context.proposal.proposal_id, {
      resolution: 'accept', accepted_by: RUN_REVIEWER,
    }).then(() => assert.fail('the injected fault must propagate'), error => error);
    assert.match(String(failure.message), /stopped after the effect/);

    // The acceptance stands, the application did not complete, and the record
    // says so rather than claiming either more or less than happened.
    const restarted = createStudioApplication({ dataDirectory: directory, durability: 'persistent' });
    const mid = await restarted.getProposal(OWNER, context.fixture.projectId, context.proposal.proposal_id);
    assert.equal(mid.proposal.state, PROPOSAL_STATE.ACCEPTED, 'accepted, not applied');
    assert.ok(mid.proposal.application, 'the acceptance recorded what it was about to do');
    assert.equal(mid.proposal.application.accepted_by, RUN_REVIEWER);
    assert.match(mid.proposal.application.idempotency_key, /^proposal:pro_[0-9a-f]{32}:\d+$/);
    const afterCrash = await candidatesOf(restarted, context.fixture.projectId);

    // The retry re-issues the SAME key, so whatever the run already did is not
    // done again.
    const retry = await restarted.resolveProposal(OWNER, context.fixture.projectId, context.proposal.proposal_id, {
      resolution: 'accept', accepted_by: RUN_REVIEWER,
    }).then(result => ({ ok: true, result }), error => ({ ok: false, error }));

    const finalCandidates = await candidatesOf(restarted, context.fixture.projectId);
    assert.ok(finalCandidates.length <= 1, `at most one revision for one acceptance, got ${finalCandidates.length}`);
    if (afterCrash.length === 1) {
      assert.equal(finalCandidates.length, 1, 'the effect that landed was adopted, not repeated');
      assert.equal(finalCandidates[0].candidate_id, afterCrash[0].candidate_id, 'and it is the same one');
    }
    // The retry COMPLETES. It used not to, and the reason is worth keeping:
    // `resume` bumps the run's revision in its first lock hold, before any step
    // runs, and writes the idempotency receipt only in a last hold after every
    // step has finished. So for the whole duration of an advancement the run
    // has moved and the key is unbound, and a retry carrying the pre-bump
    // revision as a precondition could never match. The acceptance was
    // recorded, the work had landed, and the one mechanism built to finish it
    // was the one thing that could not: the proposal stuck `accepted` for good.
    // An adversarial pass found that; the precondition now belongs to the first
    // attempt only.
    assert.ok(retry.ok, `the retry must complete, got ${retry.error?.code}: ${retry.error?.message}`);
    const settled = await restarted.getProposal(OWNER, context.fixture.projectId, context.proposal.proposal_id);
    assert.equal(settled.proposal.state, PROPOSAL_STATE.APPLIED);
    assert.equal(settled.proposal.application.conflict, null);
    assert.equal(settled.proposal.application.run_revision_after, retry.result.run.revision);
    assert.equal(settled.proposal.application.settled_on_retry, true, 'and the record says which attempt settled it');
  });
});

test('an interruption at any of the three points still ends with one application, and a finishable proposal', async () => {
  // The three interruption classes the run's own durability regressions use.
  // For each: the acceptance is recorded, the retry completes, and exactly one
  // candidate exists for one acceptance.
  for (const hook of ['beforeEffect', 'afterEffect', 'beforeResponse']) {
    await withDirectory(async directory => {
      const app = createStudioApplication({ dataDirectory: directory, durability: 'persistent' });
      const context = await submitted(app);

      const interrupted = createStudioApplication({
        dataDirectory: directory,
        durability: 'persistent',
        runHooks: { [hook]: ({ step }) => { if (step === RUN_STEP.APPLY_DECISIONS) throw Error(`stopped at ${hook}`); } },
      });
      await interrupted.resolveProposal(OWNER, context.fixture.projectId, context.proposal.proposal_id, {
        resolution: 'accept', accepted_by: RUN_REVIEWER,
      }).then(() => assert.fail(`the injected fault at ${hook} must propagate`), error => error);

      const restarted = createStudioApplication({ dataDirectory: directory, durability: 'persistent' });
      const mid = await restarted.getProposal(OWNER, context.fixture.projectId, context.proposal.proposal_id);
      assert.equal(mid.proposal.state, PROPOSAL_STATE.ACCEPTED, `${hook}: accepted, not applied`);

      const retry = await restarted.resolveProposal(OWNER, context.fixture.projectId, context.proposal.proposal_id, {
        resolution: 'accept', accepted_by: RUN_REVIEWER,
      }).then(result => ({ ok: true, result }), error => ({ ok: false, error }));
      assert.ok(retry.ok, `${hook}: the retry must complete, got ${retry.error?.code}: ${retry.error?.message}`);

      const candidates = await candidatesOf(restarted, context.fixture.projectId);
      assert.equal(candidates.length, 1, `${hook}: exactly one candidate for one acceptance, got ${candidates.length}`);
      assert.equal((await restarted.getProposal(OWNER, context.fixture.projectId, context.proposal.proposal_id)).proposal.state, PROPOSAL_STATE.APPLIED, hook);
    });
  }
});

test('a rejection after an acceptance is refused, because the run may already have it', async () => {
  const app = createStudioApplication({});
  const context = await submitted(app);
  await app.resolveProposal(OWNER, context.fixture.projectId, context.proposal.proposal_id, {
    resolution: 'accept', accepted_by: RUN_REVIEWER,
  });
  // Rejecting it now would leave the record disagreeing with what the run did.
  for (const resolution of ['reject', 'withdraw']) {
    await assert.rejects(
      app.resolveProposal(OWNER, context.fixture.projectId, context.proposal.proposal_id, { resolution, reason: 'On reflection, no.' }),
      error => error.code === 'PROPOSAL_CONFLICT',
    );
  }
});

test('an acceptance is refused when the proposal moved under the caller', async () => {
  const app = createStudioApplication({});
  const context = await submitted(app);

  await assert.rejects(
    app.resolveProposal(OWNER, context.fixture.projectId, context.proposal.proposal_id, {
      resolution: 'accept', accepted_by: RUN_REVIEWER, expected_proposal_revision: context.proposal.revision + 3,
    }),
    error => {
      assert.equal(error.code, 'PROPOSAL_CONFLICT');
      assert.equal(error.details.current_proposal_revision, context.proposal.revision);
      return true;
    },
  );
  assert.deepEqual(await candidatesOf(app, context.fixture.projectId), [], 'a refused precondition applies nothing');
});
