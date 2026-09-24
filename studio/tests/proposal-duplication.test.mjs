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

import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { PROPOSAL_KIND, PROPOSAL_STATE, RUN_STEP, createStudioApplication } from '../backend/application/index.mjs';
import { RUN_REVIEWER, projectWithSymbolicAsset, runDecisionsFor } from './fixtures/run-fixtures.mjs';

const OWNER = 'owner:proposal-duplication';
const AGENT = 'some-external-agent';

const proposable = project => runDecisionsFor(project, {}).map(({ acceptedBy, note, ...rest }) => rest);

const withDirectory = async body => {
  const directory = await mkdtemp(join(tmpdir(), 'mml-proposal-duplication-'));
  // Windows can briefly retain a file handle after the final atomic write.
  try { return await body(directory); } finally { await rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); }
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

const acceptIn = (app, context) => app.resolveProposal(OWNER, context.fixture.projectId, context.proposal.proposal_id, {
  resolution: 'accept', accepted_by: RUN_REVIEWER,
}).then(result => ({ ok: true, result }), error => ({ ok: false, error }));

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
    // An adversarial pass found that; a retry now carries, as its precondition,
    // the revision the run records as this application's own latest write.
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

test('an interrupted acceptance is not finished onto a run that moved on without it', async () => {
  // The retry above exists so an acceptance whose application was interrupted
  // can still finish. It must finish THAT application, on the run the
  // acceptance was recorded against -- not be a standing permission to apply a
  // proposal to whatever the run has since become.
  //
  // The retry skips the Agent Review Policy, and it has to: `resume` bumps the
  // run's revision before any step runs, so a proposal whose own application
  // moved the run reads as stale to a policy that is only looking at revisions.
  // What pins it instead is the run's own precondition, carried forward only
  // to a revision the run records as this application's own latest write. So
  // a run that moved for any other reason -- here, a human reviewer applying a
  // different decision set -- fails that precondition, and the acceptance
  // cannot be finished onto material it never saw.
  let armed = true;
  const app = createStudioApplication({
    runHooks: {
      beforeResponse: ({ step }) => {
        if (armed && step === RUN_STEP.APPLY_DECISIONS) { armed = false; throw Error('stopped before the response'); }
      },
    },
  });
  const context = await submitted(app);

  await app.resolveProposal(OWNER, context.fixture.projectId, context.proposal.proposal_id, {
    resolution: 'accept', accepted_by: RUN_REVIEWER,
  }).then(() => assert.fail('the injected fault must propagate'), error => error);
  const mid = await app.getProposal(OWNER, context.fixture.projectId, context.proposal.proposal_id);
  assert.equal(mid.proposal.state, PROPOSAL_STATE.ACCEPTED, 'accepted, not applied');

  // A human reviewer takes the run somewhere else entirely, with a decision set
  // of their own.
  const theirs = runDecisionsFor(context.fixture.project, { acceptedBy: 'a-different-reviewer' })
    .map(decision => (decision.fromRole === 'Chord5'
      ? { ...decision, id: `omit:${decision.id}`, type: 'OMIT_FROM_SIX', reason: 'The reviewer dropped this role.' }
      : decision));
  const manual = await app.resumeRun(OWNER, context.fixture.projectId, context.run.run_id, {
    decisions: theirs, accepted_by: 'a-different-reviewer',
  });
  const candidatesBefore = await candidatesOf(app, context.fixture.projectId);

  // The policy says so in as many words, on an ordinary read.
  const stale = await app.getProposal(OWNER, context.fixture.projectId, context.proposal.proposal_id);
  assert.equal(stale.proposal.agent_review.verdict, 'STALE');
  assert.equal(stale.proposal.agent_review.acceptable, false);

  // And the retry is refused rather than applied to the reviewer's run.
  const retry = await app.resolveProposal(OWNER, context.fixture.projectId, context.proposal.proposal_id, {
    resolution: 'accept', accepted_by: RUN_REVIEWER,
  }).then(result => ({ ok: true, result }), error => ({ ok: false, error }));
  assert.equal(retry.ok, false, 'an acceptance may not be finished onto a run that moved on without it');
  assert.equal(retry.error.code, 'RUN_CONFLICT');

  const settled = await app.getProposal(OWNER, context.fixture.projectId, context.proposal.proposal_id);
  assert.equal(settled.proposal.state, PROPOSAL_STATE.ACCEPTED, 'and it is not recorded as applied');
  assert.ok(settled.proposal.application.conflict, 'the blocker is on the record');
  assert.deepEqual(
    await candidatesOf(app, context.fixture.projectId),
    candidatesBefore,
    'nothing was minted by the refused retry',
  );
  assert.equal((await app.getRun(OWNER, context.fixture.projectId, context.run.run_id)).run.candidate_id, manual.run.candidate_id,
    "and the reviewer's candidate is still the run's");

  // And it stays refused. A refused retry records its own conflict, and if that
  // record moved the precondition to wherever the run had got to, the NEXT
  // retry would pass it -- the standing permission back, one round later. The
  // precondition moves only to a revision this application's own request
  // wrote, and a refused retry writes nothing to the run.
  for (let round = 0; round < 3; round += 1) {
    const again = await app.resolveProposal(OWNER, context.fixture.projectId, context.proposal.proposal_id, {
      resolution: 'accept', accepted_by: RUN_REVIEWER,
    }).then(result => ({ ok: true, result }), error => ({ ok: false, error }));
    assert.equal(again.ok, false, `retry ${round + 2} must be refused too`);
    assert.equal(again.error.code, 'RUN_CONFLICT');
  }
  assert.equal((await app.getProposal(OWNER, context.fixture.projectId, context.proposal.proposal_id)).proposal.state, PROPOSAL_STATE.ACCEPTED);
  assert.deepEqual(await candidatesOf(app, context.fixture.projectId), candidatesBefore, 'and still nothing was minted');
});

test('an application interrupted a second time is still finished by its retry, and records where each interruption left the run', async () => {
  // The first attempt stops before its effect; the retry continues from there,
  // re-runs the step and stops again after the effect, before its receipt.
  // That used to be terminal: the revision a retry was held to was written
  // once, by the first interruption, so the third attempt carried it into a
  // run the second attempt had moved and was refused for good. What a retry
  // is held to is now the run's own record of which request made its latest
  // write, and here every write since the acceptance is this application's.
  const armed = { beforeEffect: false, afterEffect: false };
  const seen = {};
  const hook = name => ({ step, run }) => {
    if (!armed[name] || step !== RUN_STEP.APPLY_DECISIONS) return;
    armed[name] = false;
    seen[name] = run.revision;
    throw Error(`stopped at ${name}`);
  };
  const app = createStudioApplication({ runHooks: { beforeEffect: hook('beforeEffect'), afterEffect: hook('afterEffect') } });
  const context = await submitted(app);
  const read = async () => (await app.getProposal(OWNER, context.fixture.projectId, context.proposal.proposal_id)).proposal;

  armed.beforeEffect = true;
  const first = await acceptIn(app, context);
  assert.equal(first.ok, false);
  assert.match(String(first.error.message), /stopped at beforeEffect/);
  assert.equal((await read()).application.run_revision_at_attempt, seen.beforeEffect, 'the first interruption records where it left the run');

  armed.afterEffect = true;
  const second = await acceptIn(app, context);
  assert.equal(second.ok, false);
  assert.match(String(second.error.message), /stopped at afterEffect/);
  assert.equal(second.error.details.admitted_by_run, true, 'the retry continued the application');
  assert.ok(seen.afterEffect > seen.beforeEffect);
  assert.equal((await read()).application.run_revision_at_attempt, seen.afterEffect, 'and the second records where IT left the run');
  const afterSecond = await candidatesOf(app, context.fixture.projectId);
  assert.equal(afterSecond.length, 1, 'the second attempt\'s effect landed');

  const third = await acceptIn(app, context);
  assert.ok(third.ok, `the retry must finish the twice-interrupted application, got ${third.error?.code}: ${third.error?.message}`);
  assert.equal(third.result.proposal.state, PROPOSAL_STATE.APPLIED);
  assert.equal(third.result.proposal.application.settled_on_retry, true);
  assert.deepEqual(await candidatesOf(app, context.fixture.projectId), afterSecond, 'the landed effect was adopted, not repeated');
});

// ─── C. a process that dies inside the run ──────────────────────────────────
//
// The interruptions above throw from a hook, so the acceptance's own last step
// -- recording the conflict under the lock -- still runs in the process that
// was interrupted. A process that dies inside the run records nothing at all:
// the run holds whatever its own writes left, and the proposal holds only the
// acceptance and the run's admission of it.

/**
 * A service that stops for good inside the run's advance: the hook never
 * returns, so nothing after it runs in that service -- no receipt, no failure,
 * no outcome recorded on the proposal. What it leaves in the store is what a
 * process that died there leaves.
 */
const dyingInside = (directory, hook, stepName = RUN_STEP.APPLY_DECISIONS) => {
  let reached;
  const stopped = new Promise(resolve => { reached = resolve; });
  const app = createStudioApplication({
    dataDirectory: directory,
    durability: 'persistent',
    runHooks: { [hook]: ({ step }) => { if (step === stepName) { reached(); return new Promise(() => {}); } } },
  });
  return { app, stopped };
};

test('a process that dies inside the run leaves an acceptance whose retry finishes exactly that application', async () => {
  for (const hook of ['beforeEffect', 'afterEffect', 'beforeResponse']) {
    await withDirectory(async directory => {
      const app = createStudioApplication({ dataDirectory: directory, durability: 'persistent' });
      const context = await submitted(app);

      const dying = dyingInside(directory, hook);
      acceptIn(dying.app, context);
      await dying.stopped;

      // A fresh service over the same store. The acceptance and the run's
      // admission of it are on the record; nothing after that is.
      const restarted = createStudioApplication({ dataDirectory: directory, durability: 'persistent' });
      const mid = (await restarted.getProposal(OWNER, context.fixture.projectId, context.proposal.proposal_id)).proposal;
      assert.equal(mid.state, PROPOSAL_STATE.ACCEPTED, `${hook}: accepted, not applied`);
      assert.equal(mid.application.run_resume_called, true, `${hook}: the run admitted it`);
      assert.equal(mid.application.conflict, null, `${hook}: and no outcome was ever recorded`);
      assert.equal(mid.application.run_revision_at_attempt, null, `${hook}: so nothing pinned where it stopped`);
      const runAtDeath = (await restarted.getRun(OWNER, context.fixture.projectId, context.run.run_id)).run;
      assert.ok(runAtDeath.revision > context.run.revision, `${hook}: its application moved the run before the process died`);

      // Its application may have landed, so it cannot be taken back.
      await assert.rejects(
        restarted.resolveProposal(OWNER, context.fixture.projectId, context.proposal.proposal_id, { resolution: 'withdraw', reason: 'The process died.' }),
        error => error.code === 'PROPOSAL_CONFLICT',
      );

      // It used to be unfinishable from here: every retry carried the revision
      // the acceptance observed, the run -- moved by this application's own
      // writes -- refused it at its precondition before admitting it, and a
      // refused attempt pins nothing, so the next retry was identical. The
      // run's own record says its latest write was this application's, so the
      // retry continues from there, and the run's reconciliation settles
      // whatever step the dead process left pending.
      const retry = await acceptIn(restarted, context);
      assert.ok(retry.ok, `${hook}: the retry must finish the application, got ${retry.error?.code}: ${retry.error?.message}`);
      assert.equal(retry.result.proposal.state, PROPOSAL_STATE.APPLIED);
      assert.equal(retry.result.proposal.application.settled_on_retry, true);
      assert.equal(retry.result.run.pending_step, null, `${hook}: nothing is left pending`);
      const candidates = await candidatesOf(restarted, context.fixture.projectId);
      assert.equal(candidates.length, 1, `${hook}: exactly one candidate for one acceptance, got ${candidates.length}`);
      assert.equal(retry.result.run.candidate_id, candidates[0].candidate_id, hook);
    });
  }
});

test('after a process died inside the run, a retry is refused once another writer has moved the run', async () => {
  // Continuing from the run's latest write is safe only because the run says
  // which request made it: the idempotency key AND the request. Three other
  // writers land between the death and the retry: a reviewer with a decision
  // set of their own; a caller who sends exactly this acceptance's payload by
  // hand, without its key; and a caller who reuses the acceptance's own key
  // with a different payload and is interrupted before the key is bound. None
  // of those writes is this application's, so the retry is refused at the
  // run's precondition and moves nothing.
  const theirs = project => runDecisionsFor(project, { acceptedBy: 'a-different-reviewer' })
    .map(decision => (decision.fromRole === 'Chord5'
      ? { ...decision, id: `omit:${decision.id}`, type: 'OMIT_FROM_SIX', reason: 'The reviewer dropped this role.' }
      : decision));
  for (const writer of ['reviewer', 'same-payload-without-key', 'same-key-other-payload']) {
    await withDirectory(async directory => {
      const app = createStudioApplication({ dataDirectory: directory, durability: 'persistent' });
      const context = await submitted(app);
      const dying = dyingInside(directory, 'beforeEffect');
      acceptIn(dying.app, context);
      await dying.stopped;

      let interruptOther = false;
      const restarted = createStudioApplication({
        dataDirectory: directory,
        durability: 'persistent',
        runHooks: { beforeResponse: ({ step }) => { if (interruptOther && step === RUN_STEP.APPLY_DECISIONS) { interruptOther = false; throw Error('the other request stopped before its response'); } } },
      });
      const key = (await restarted.getProposal(OWNER, context.fixture.projectId, context.proposal.proposal_id)).proposal.application.idempotency_key;
      if (writer === 'reviewer') {
        await restarted.resumeRun(OWNER, context.fixture.projectId, context.run.run_id, {
          decisions: theirs(context.fixture.project), accepted_by: 'a-different-reviewer',
        });
      } else if (writer === 'same-payload-without-key') {
        // What the acceptance translates this proposal into, sent by hand.
        await restarted.resumeRun(OWNER, context.fixture.projectId, context.run.run_id, {
          decisions: context.proposal.action.decisions, accepted_by: RUN_REVIEWER,
        });
      } else {
        interruptOther = true;
        await assert.rejects(restarted.resumeRun(OWNER, context.fixture.projectId, context.run.run_id, {
          idempotency_key: key, decisions: theirs(context.fixture.project), accepted_by: 'a-different-reviewer',
        }), /stopped before its response/);
      }
      const runBefore = (await restarted.getRun(OWNER, context.fixture.projectId, context.run.run_id)).run;
      const candidatesBefore = await candidatesOf(restarted, context.fixture.projectId);
      assert.equal(candidatesBefore.length, 1, `${writer}: the other writer's application landed`);

      for (let round = 0; round < 2; round += 1) {
        const retry = await acceptIn(restarted, context);
        assert.equal(retry.ok, false, `${writer}: retry ${round + 1} may not finish the acceptance onto a run another writer moved`);
        assert.equal(retry.error.code, 'RUN_CONFLICT', `${writer}: ${retry.error.code}: ${retry.error.message}`);
        assert.equal(retry.error.details.admitted_by_run, false, writer);
      }
      const runAfter = (await restarted.getRun(OWNER, context.fixture.projectId, context.run.run_id)).run;
      assert.equal(runAfter.revision, runBefore.revision, `${writer}: the refused retries did not touch the run`);
      assert.equal(runAfter.candidate_id, runBefore.candidate_id, writer);
      assert.deepEqual(await candidatesOf(restarted, context.fixture.projectId), candidatesBefore, `${writer}: and minted nothing`);
      const settled = (await restarted.getProposal(OWNER, context.fixture.projectId, context.proposal.proposal_id)).proposal;
      assert.equal(settled.state, PROPOSAL_STATE.ACCEPTED, `${writer}: not recorded as applied`);
      assert.equal(settled.application.conflict.code, 'RUN_CONFLICT', `${writer}: the blocker is on the record`);
    });
  }
});

// ─── D. records an earlier version wrote ────────────────────────────────────
//
// A proposal accepted and admitted before the run recorded who wrote each of
// its revisions carries what that version recorded: a revision phase 3 read
// from the run, and a marker with no request beside it. Neither is proof of
// anything the run did, and neither is trusted past what it proves. Nor is a
// run record written by a build that does not know the run's writer record:
// every write it makes carries the record of the write before it onto its own
// revision.

/** Rewrite one stored proposal in place, as a record an earlier version left. */
const rewriteStoredProposal = async (directory, proposalId, edit) => {
  let rewritten = false;
  for (const name of await readdir(join(directory, 'records'))) {
    const path = join(directory, 'records', name);
    const body = await readFile(path, 'utf8');
    if (!body.includes(proposalId)) continue;
    const record = JSON.parse(body);
    edit(record.proposals.find(entry => entry.proposal_id === proposalId), record);
    await writeFile(path, JSON.stringify(record));
    rewritten = true;
  }
  assert.ok(rewritten, 'the stored proposal record was found and rewritten');
};

/** The stored run record, as it is on disk, with every field the run keeps. */
const storedRunOf = async (directory, runId) => {
  for (const name of await readdir(join(directory, 'records'))) {
    const record = JSON.parse(await readFile(join(directory, 'records', name), 'utf8'));
    const run = (record.runs ?? []).find(entry => entry.run_id === runId);
    if (run) return run;
  }
  return assert.fail('the stored run record was found');
};

/** Rewrite one stored run in place, as a write another build made. */
const rewriteStoredRun = async (directory, runId, edit) => {
  let rewritten = false;
  for (const name of await readdir(join(directory, 'records'))) {
    const path = join(directory, 'records', name);
    const record = JSON.parse(await readFile(path, 'utf8'));
    const index = (record.runs ?? []).findIndex(entry => entry.run_id === runId);
    if (index === -1) continue;
    record.runs[index] = edit(record.runs[index]);
    await writeFile(path, JSON.stringify(record));
    rewritten = true;
  }
  assert.ok(rewritten, 'the stored run record was found and rewritten');
};

test('a revision an earlier version recorded as where an attempt stopped is never carried as a retry\'s precondition', async () => {
  // The earlier version pinned, in phase 3, the revision the run was at when
  // phase 3 ran, and carried it as the retry's precondition. A reviewer's
  // resume landing before that phase 3 made it the reviewer's revision, and
  // the retry passed against it and was recorded `applied`. Such a record is
  // written here directly: an interrupted, admitted acceptance, a reviewer who
  // then moved the run, and the pin equal to the reviewer's revision.
  await withDirectory(async directory => {
    let armed = true;
    const app = createStudioApplication({
      dataDirectory: directory,
      durability: 'persistent',
      runHooks: { beforeEffect: ({ step }) => { if (armed && step === RUN_STEP.APPLY_DECISIONS) { armed = false; throw Error('stopped before the effect'); } } },
    });
    const context = await submitted(app);
    const first = await acceptIn(app, context);
    assert.equal(first.ok, false);
    assert.equal(first.error.details.admitted_by_run, true);
    const theirs = runDecisionsFor(context.fixture.project, { acceptedBy: 'a-different-reviewer' })
      .map(decision => (decision.fromRole === 'Chord5'
        ? { ...decision, id: `omit:${decision.id}`, type: 'OMIT_FROM_SIX', reason: 'The reviewer dropped this role.' }
        : decision));
    const manual = await app.resumeRun(OWNER, context.fixture.projectId, context.run.run_id, { decisions: theirs, accepted_by: 'a-different-reviewer' });
    await rewriteStoredProposal(directory, context.proposal.proposal_id, proposal => {
      proposal.application.run_revision_at_attempt = manual.run.revision;
    });

    const restarted = createStudioApplication({ dataDirectory: directory, durability: 'persistent' });
    const candidatesBefore = await candidatesOf(restarted, context.fixture.projectId);
    const retry = await acceptIn(restarted, context);
    assert.equal(retry.ok, false, 'a borrowed revision on the record does not let the retry onto the reviewer\'s run');
    assert.equal(retry.error.code, 'RUN_CONFLICT', `${retry.error.code}: ${retry.error.message}`);
    assert.equal(retry.error.details.admitted_by_run, false);
    const runAfter = (await restarted.getRun(OWNER, context.fixture.projectId, context.run.run_id)).run;
    assert.equal(runAfter.revision, manual.run.revision, 'the run is where the reviewer left it');
    assert.equal(runAfter.candidate_id, manual.run.candidate_id);
    assert.deepEqual(await candidatesOf(restarted, context.fixture.projectId), candidatesBefore, 'and nothing was minted');
    assert.equal((await restarted.getProposal(OWNER, context.fixture.projectId, context.proposal.proposal_id)).proposal.state, PROPOSAL_STATE.ACCEPTED);
  });
});

test('a marker an earlier version set without recording the request is completed at the next admission, so a later interruption is still finished', async () => {
  // The earlier version recorded that the run admitted an attempt, but not
  // which request. Here its admission's own write to the run never landed, so
  // the run is still where the acceptance observed it and the next attempt is
  // admitted -- and that admission records the request, or no later retry
  // could ever recognise the run's latest write as this application's.
  await withDirectory(async directory => {
    const app = createStudioApplication({ dataDirectory: directory, durability: 'persistent' });
    const context = await submitted(app);
    const at = new Date().toISOString();
    await rewriteStoredProposal(directory, context.proposal.proposal_id, proposal => {
      proposal.state = PROPOSAL_STATE.ACCEPTED;
      proposal.revision += 1;
      proposal.resolution = { resolution: 'accept', resolved_by: OWNER, accepted_by: RUN_REVIEWER, reason: null, at };
      proposal.application = {
        idempotency_key: `proposal:${proposal.proposal_id}:${proposal.revision - 1}`,
        expected_run_revision: context.run.revision,
        run_revision_at_attempt: null,
        run_resume_called: true,
        run_resume_called_at: at,
        accepted_by: RUN_REVIEWER,
        attempted_at: at,
        run_revision_after: null,
        run_state_after: null,
        candidate_id_after: null,
        derived: {},
        conflict: null,
      };
    });

    let armed = true;
    const restarted = createStudioApplication({
      dataDirectory: directory,
      durability: 'persistent',
      runHooks: { beforeEffect: ({ step }) => { if (armed && step === RUN_STEP.APPLY_DECISIONS) { armed = false; throw Error('stopped before the effect'); } } },
    });
    const first = await acceptIn(restarted, context);
    assert.equal(first.ok, false);
    assert.match(String(first.error.message), /stopped before the effect/);
    assert.equal(first.error.details.admitted_by_run, true, 'the run was still where the acceptance observed it');
    const mid = (await restarted.getProposal(OWNER, context.fixture.projectId, context.proposal.proposal_id)).proposal;
    assert.equal(typeof mid.application.admitted_request_fingerprint, 'string', 'the admission recorded which request it let in');

    const retry = await acceptIn(restarted, context);
    assert.ok(retry.ok, `the retry must finish the application, got ${retry.error?.code}: ${retry.error?.message}`);
    assert.equal(retry.result.proposal.state, PROPOSAL_STATE.APPLIED);
    assert.equal((await candidatesOf(restarted, context.fixture.projectId)).length, 1, 'one acceptance, one application');
  });
});

test('a writer record an older build carried onto its own revision is never read as this application\'s', async () => {
  // Rolling the service back to the release before the run recorded its
  // writers, and forward again, is a documented procedure. That release's
  // `bumpRun` spreads the run it read and bumps the revision, so every write
  // it makes carries the writer record of the revision before it onto its own
  // revision. After an admitted, interrupted attempt, a reviewer's resume
  // through that build leaves the run naming this application as the writer of
  // the reviewer's revision; the retry used to read it so, skip the policy,
  // pass its precondition and be recorded `applied` onto the reviewer's run
  // while the policy graded it STALE. The record names the revision it was
  // written for and is trusted for that revision only, so any write by a build
  // that does not know the field makes it read as nobody's.
  const theirs = project => runDecisionsFor(project, { acceptedBy: 'a-different-reviewer' })
    .map(decision => (decision.fromRole === 'Chord5'
      ? { ...decision, id: `omit:${decision.id}`, type: 'OMIT_FROM_SIX', reason: 'The reviewer dropped this role.' }
      : decision));
  // What the older build's own writes leave on the stored run: the record of
  // the write before them, carried along.
  const olderBuild = {
    // A reviewer's resume with a decision set of their own.
    'reviewer-resume': async (app, context, carried) => {
      await app.resumeRun(OWNER, context.fixture.projectId, context.run.run_id, {
        decisions: theirs(context.fixture.project), accepted_by: 'a-different-reviewer',
      });
      return run => ({ ...run, revision_written_by: carried });
    },
    // A bare write, in exactly that build's shape: `{ ...run, ...changes,
    // revision: run.revision + 1, updated_at }`.
    'bare-write': async () => run => ({ ...run, revision: run.revision + 1, updated_at: new Date().toISOString() }),
  };
  for (const [writer, write] of Object.entries(olderBuild)) {
    await withDirectory(async directory => {
      let armed = true;
      const app = createStudioApplication({
        dataDirectory: directory,
        durability: 'persistent',
        runHooks: { beforeEffect: ({ step }) => { if (armed && step === RUN_STEP.APPLY_DECISIONS) { armed = false; throw Error('stopped before the effect'); } } },
      });
      const context = await submitted(app);
      const first = await acceptIn(app, context);
      assert.equal(first.ok, false, writer);
      assert.equal(first.error.details.admitted_by_run, true, writer);
      const application = (await app.getProposal(OWNER, context.fixture.projectId, context.proposal.proposal_id)).proposal.application;
      const own = await storedRunOf(directory, context.run.run_id);
      assert.equal(own.revision_written_by?.idempotency_key, application.idempotency_key, `${writer}: the attempt's own write is the run's latest`);
      assert.equal(own.revision_written_by?.request_fingerprint, application.admitted_request_fingerprint, writer);

      const edit = await write(app, context, own.revision_written_by);
      await rewriteStoredRun(directory, context.run.run_id, edit);
      const written = await storedRunOf(directory, context.run.run_id);
      assert.ok(written.revision > own.revision, `${writer}: the older build moved the run`);
      assert.deepEqual(written.revision_written_by, own.revision_written_by, `${writer}: and carried the attempt's writer record onto its own revision`);

      const restarted = createStudioApplication({ dataDirectory: directory, durability: 'persistent' });
      const graded = (await restarted.getProposal(OWNER, context.fixture.projectId, context.proposal.proposal_id)).proposal;
      assert.equal(graded.agent_review.verdict, 'STALE', writer);
      const runBefore = (await restarted.getRun(OWNER, context.fixture.projectId, context.run.run_id)).run;
      const candidatesBefore = await candidatesOf(restarted, context.fixture.projectId);

      for (let round = 0; round < 2; round += 1) {
        const retry = await acceptIn(restarted, context);
        assert.equal(retry.ok, false, `${writer}: retry ${round + 1} may not finish the acceptance onto a run another build moved`);
        assert.equal(retry.error.code, 'RUN_CONFLICT', `${writer}: ${retry.error.code}: ${retry.error.message}`);
        assert.equal(retry.error.details.admitted_by_run, false, writer);
      }
      const runAfter = (await restarted.getRun(OWNER, context.fixture.projectId, context.run.run_id)).run;
      assert.equal(runAfter.revision, runBefore.revision, `${writer}: the refused retries did not touch the run`);
      assert.equal(runAfter.candidate_id, runBefore.candidate_id, writer);
      assert.deepEqual(await candidatesOf(restarted, context.fixture.projectId), candidatesBefore, `${writer}: and minted nothing`);
      const settled = (await restarted.getProposal(OWNER, context.fixture.projectId, context.proposal.proposal_id)).proposal;
      assert.equal(settled.state, PROPOSAL_STATE.ACCEPTED, `${writer}: not recorded as applied`);
      await assert.rejects(
        restarted.resolveProposal(OWNER, context.fixture.projectId, context.proposal.proposal_id, { resolution: 'withdraw', reason: 'Another build moved the run.' }),
        error => error.code === 'PROPOSAL_CONFLICT',
        `${writer}: its application reached the run, so it is not withdrawable`,
      );

      // Why: the record names the revision it was written for, and that is no
      // longer the run's.
      assert.equal(own.revision_written_by.revision, own.revision, `${writer}: the writer record names the revision it was written for`);
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
