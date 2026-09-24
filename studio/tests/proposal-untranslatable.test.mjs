// The AI Proposal Protocol — a proposal an acceptance could never translate,
// and an acceptance that never reached the run.
//
// An acceptance does not hand a proposal to `runs.resume` as it stands. It
// first translates it, through the existing READ-ONLY plan operations, into
// the ordinary resume input. A final reduction whose stated plan id its own
// decisions do not produce passed the Agent Review Policy -- which judged
// bindings, not the translation -- and was accepted. The translation then
// failed before the run was reached, every retry recomputed the same failure,
// and the guard against rejecting an accepted proposal ("its application may
// already have reached the run", which was false) held it `accepted` for good,
// counting against the open-proposal cap until the project was locked out.
//
// Two things answer that, and both are pinned here:
//
//   * the policy runs the same derivation and grades a failure INVALID, so
//     such a proposal is refused BEFORE an acceptance is recorded;
//   * an acceptance records, under the lock and before the call, that an
//     attempt is about to reach `runs.resume`. While no attempt has, the
//     proposal may still be rejected or withdrawn; once one has, it may not,
//     and the refusal says which of the two it is.

import test from 'node:test';
import assert from 'node:assert/strict';

import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { AGENT_REVIEW, LIMITS, PROPOSAL_KIND, PROPOSAL_STATE, RUN_STEP, createStudioApplication } from '../backend/application/index.mjs';
import { baselineWithUnassignedRole, FIXTURE_SOURCE_ID } from './fixtures/g12-fixtures.mjs';
import { RUN_REVIEWER, mobileProfile, projectWithSymbolicAsset, runDecisionsFor, sixRoleBaseline } from './fixtures/run-fixtures.mjs';
import { enginesWith } from './support/real-engines.mjs';

const OWNER = 'owner:proposal-untranslatable';
const AGENT = 'some-external-agent';

const withDirectory = async body => {
  const directory = await mkdtemp(join(tmpdir(), 'mml-proposal-untranslatable-'));
  try { return await body(directory); } finally { await rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); }
};

const REDUCTION_DECISIONS = [{
  id: 'place-chord5',
  action: 'REDISTRIBUTE',
  eventIds: ['chord5-1', 'chord5-2', 'chord5-3'],
  toRole: 'Chord5',
  reason: 'The official source carries this lane as secondary bass reinforcement; it is placed in the one free enrichment role.',
  evidence: [`${FIXTURE_SOURCE_ID}#Chord5`],
}];

/** A run stopped at the reduction, with a real ledger behind the request. */
async function runAwaitingReduction(app) {
  const fixture = await projectWithSymbolicAsset(app, OWNER, { project: baselineWithUnassignedRole() });
  const started = await app.startRun(OWNER, fixture.projectId, {
    asset_ids: [fixture.assetId],
    decisions: runDecisionsFor(fixture.project, { exclude: ['Chord5'], acceptedBy: RUN_REVIEWER }),
    accepted_by: RUN_REVIEWER,
  });
  assert.equal(started.run.halt.reason, 'AWAITING_ACCEPTED_REDUCTION_DECISIONS', JSON.stringify(started.run.halt));
  const targets = await app.proposalTargets(OWNER, fixture.projectId, started.run.run_id);
  return { fixture, run: started.run, target: targets.targets.find(entry => entry.code === 'REDUCTION_DECISIONS_REQUIRED') };
}

const proposeReduction = (app, context, action, rationale = 'Place the unassigned lane in the one free enrichment role.') => app.proposeDecision(OWNER, context.fixture.projectId, {
  run_id: context.run.run_id,
  request_key: context.target.request_key,
  kind: PROPOSAL_KIND.FINAL_REDUCTION,
  proposed_by: AGENT,
  rationale,
  action,
  cites: { event_ids: ['chord5-1'], source_ids: [FIXTURE_SOURCE_ID] },
});

const accept = (app, context, proposalId) => app.resolveProposal(OWNER, context.fixture.projectId, proposalId, { resolution: 'accept', accepted_by: RUN_REVIEWER })
  .then(result => ({ ok: true, result }), error => ({ ok: false, error }));

const runOf = async (app, context) => (await app.getRun(OWNER, context.fixture.projectId, context.run.run_id)).run;
const candidatesOf = async (app, context) => (await app.getProject(OWNER, context.fixture.projectId)).project.candidates;

// ─── A. the policy grades the translation ───────────────────────────────────

test('proposals whose stated plan id is wrong are refused before acceptance, so they cannot fill the open cap', async () => {
  const app = createStudioApplication({});
  const context = await runAwaitingReduction(app);
  const runBefore = await runOf(app, context);

  // The reproduction, at a size a test can afford: a proposal naming a plan
  // id its own decisions do not produce, accepted twice. It used to be
  // accepted, fail in the translation, fail again on the retry, and stay
  // `accepted` -- open, and refusing both rejection and withdrawal.
  const ids = [];
  for (let index = 0; index < 3; index += 1) {
    const submitted = await proposeReduction(app, context, {
      decisions: REDUCTION_DECISIONS,
      expected_plan_id: `g12:plan:${String(index).padStart(64, '0')}`,
      plan_accepted_by: 'someone-else',
    }, `Attempt ${index}.`);
    assert.equal(submitted.proposal.agent_review.verdict, AGENT_REVIEW.INVALID);
    assert.deepEqual(submitted.proposal.agent_review.refusals, ['REDUCTION_PLAN_ID_MISMATCH']);
    assert.equal(submitted.proposal.agent_review.plan_accepted_by, 'someone-else');
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const outcome = await accept(app, context, submitted.proposal.proposal_id);
      assert.equal(outcome.ok, false);
      assert.equal(outcome.error.code, 'PROPOSAL_REFUSED');
      assert.equal(outcome.error.details.agent_review.verdict, AGENT_REVIEW.INVALID);
    }
    const reread = (await app.getProposal(OWNER, context.fixture.projectId, submitted.proposal.proposal_id)).proposal;
    assert.equal(reread.state, PROPOSAL_STATE.SUBMITTED, 'never accepted');
    assert.equal(reread.application, null);
    ids.push(submitted.proposal.proposal_id);
  }

  // Every one of them can be taken back, which is what frees the open slots.
  for (const [index, id] of ids.entries()) {
    const resolved = await app.resolveProposal(OWNER, context.fixture.projectId, id, { resolution: index % 2 ? 'reject' : 'withdraw', reason: 'The plan id was wrong.' });
    assert.equal(resolved.proposal.state, index % 2 ? PROPOSAL_STATE.REJECTED : PROPOSAL_STATE.WITHDRAWN);
  }
  const open = (await app.listProposals(OWNER, context.fixture.projectId)).proposals.filter(entry => ['submitted', 'accepted'].includes(entry.state));
  assert.deepEqual(open, []);
  assert.equal((await runOf(app, context)).revision, runBefore.revision, 'nothing reached the run');

  // The control: a stated id that IS the plan the named reviewer derives stays
  // acceptable, and the acceptance applies the plan derived under the
  // ACCEPTING reviewer, never the stated one.
  const named = 'a-reviewer-the-agent-named';
  const statedPlan = (await app.planFinalReduction(OWNER, context.fixture.projectId, {
    candidateId: context.run.candidate_id, decisions: REDUCTION_DECISIONS, acceptedBy: named,
  })).reduction.plan;
  const honest = await proposeReduction(app, context, { decisions: REDUCTION_DECISIONS, expected_plan_id: statedPlan.id, plan_accepted_by: named });
  assert.equal(honest.proposal.agent_review.verdict, AGENT_REVIEW.REQUIRES_EXPLICIT_ACCEPTANCE, JSON.stringify(honest.proposal.agent_review));
  const applied = await accept(app, context, honest.proposal.proposal_id);
  assert.ok(applied.ok, `${applied.error?.code}: ${applied.error?.message}`);
  assert.equal(applied.result.proposal.state, PROPOSAL_STATE.APPLIED);
  assert.notEqual(applied.result.proposal.application.derived.reduction_plan_id, statedPlan.id, 'the applied plan is the accepting reviewer\'s');
  assert.equal(applied.result.proposal.application.run_resume_called, true);
});

test('a reduction proposal whose decisions the plan operation refuses is INVALID, and never accepted', async () => {
  const app = createStudioApplication({});
  const context = await runAwaitingReduction(app);
  const runBefore = await runOf(app, context);

  // A REDISTRIBUTE with no destination. The proposal layer validates no
  // decision vocabulary of its own; the reduction engine does, and refuses
  // it outright -- so an acceptance could never have translated it.
  const [{ toRole, ...withoutDestination }] = REDUCTION_DECISIONS;
  assert.equal(toRole, 'Chord5');
  const submitted = await proposeReduction(app, context, { decisions: [withoutDestination] });
  const review = submitted.proposal.agent_review;
  assert.equal(review.verdict, AGENT_REVIEW.INVALID);
  assert.deepEqual(review.refusals, ['REDUCTION_PLAN_REFUSED']);
  assert.equal(review.plan_refusal.operation, 'planFinalReduction');
  assert.equal(review.plan_refusal.code, 'INVALID_REQUEST');
  assert.match(review.plan_refusal.message, /toRole/);

  const outcome = await accept(app, context, submitted.proposal.proposal_id);
  assert.equal(outcome.ok, false);
  assert.equal(outcome.error.code, 'PROPOSAL_REFUSED');
  assert.ok(outcome.error.details.agent_review.refusals.includes('REDUCTION_PLAN_REFUSED'));
  assert.equal((await app.getProposal(OWNER, context.fixture.projectId, submitted.proposal.proposal_id)).proposal.state, PROPOSAL_STATE.SUBMITTED);
  assert.equal((await runOf(app, context)).revision, runBefore.revision);
});

test('a Mobile adaptation proposal is graded on the plan its own profile produces', async () => {
  const app = createStudioApplication({});
  const fixture = await projectWithSymbolicAsset(app, OWNER, { project: sixRoleBaseline() });
  await app.analyzeSources(OWNER, fixture.projectId, { assetIds: [fixture.assetId] });
  const candidateId = (await app.applyDecisions(OWNER, fixture.projectId, { decisions: runDecisionsFor(fixture.project) })).decisions.candidate_id;
  const started = await app.startRun(OWNER, fixture.projectId, { target_candidate_id: candidateId });

  // A run stopped on a blocked adaptation: the one request a Mobile
  // adaptation proposal may answer.
  const reviewed = mobileProfile({ Chord5: { defaultVolume: 9 } });
  const reviewedPlan = (await app.planMobileAdaptation(OWNER, fixture.projectId, { candidateId, profile: reviewed })).adaptation.plan;
  const blocked = await app.resumeRun(OWNER, fixture.projectId, started.run.run_id, {
    mobile_adaptation: { profile: mobileProfile({ Chord5: { defaultVolume: 11 } }), expected_plan_id: reviewedPlan.id, accepted_by: RUN_REVIEWER },
  });
  const target = (await app.proposalTargets(OWNER, fixture.projectId, started.run.run_id)).targets.find(entry => entry.code === 'MOBILE_ADAPTATION_BLOCKED');
  assert.ok(target, JSON.stringify(blocked.run.review_requests.map(entry => entry.code)));
  const events = await app.listBaselineEvents(OWNER, fixture.projectId, { limit: 2 });
  const propose = action => app.proposeDecision(OWNER, fixture.projectId, {
    run_id: started.run.run_id,
    request_key: target.request_key,
    kind: PROPOSAL_KIND.MOBILE_ADAPTATION,
    proposed_by: AGENT,
    rationale: 'Lower the enrichment role for the target client.',
    action,
    cites: { event_ids: events.events.map(entry => entry.event_id) },
  });

  const wrongId = await propose({ profile: reviewed, expected_plan_id: `mobile:plan:${'0'.repeat(64)}` });
  assert.equal(wrongId.proposal.agent_review.verdict, AGENT_REVIEW.INVALID);
  assert.deepEqual(wrongId.proposal.agent_review.refusals, ['ADAPTATION_PLAN_ID_MISMATCH']);
  assert.equal(wrongId.proposal.agent_review.derived_plan_id, reviewedPlan.id);

  const refusedProfile = await propose({ profile: mobileProfile({ Chord5: { pitchRange: [40, 30] } }) });
  assert.equal(refusedProfile.proposal.agent_review.verdict, AGENT_REVIEW.INVALID);
  assert.deepEqual(refusedProfile.proposal.agent_review.refusals, ['ADAPTATION_PLAN_REFUSED']);
  assert.equal(refusedProfile.proposal.agent_review.plan_refusal.operation, 'planMobileAdaptation');

  // The control: the id the profile really produces is acceptable.
  const rightId = await propose({ profile: reviewed, expected_plan_id: reviewedPlan.id });
  assert.equal(rightId.proposal.agent_review.verdict, AGENT_REVIEW.REQUIRES_EXPLICIT_ACCEPTANCE, JSON.stringify(rightId.proposal.agent_review));
});

// ─── B. an acceptance that never reached the run ────────────────────────────

/**
 * A service whose reduction engine refuses to plan for the accepting
 * reviewer once armed. It stands in for the material moving in the window
 * between the policy's check under the lock and the translation after it,
 * which no test can time: the policy's derivation (under the plan
 * operation's own preview reviewer) passes, and the acceptance's translation
 * fails before `runs.resume` is ever called.
 */
const translationFaulted = (options = {}) => {
  const fault = { armed: false };
  const app = createStudioApplication({
    ...options,
    loadEngines: enginesWith(engines => ({
      reduction: {
        ...engines.reduction,
        planFinalReduction: input => {
          if (fault.armed && input.acceptedBy === RUN_REVIEWER) throw Error('the reduction plan could not be derived for this acceptance');
          return engines.reduction.planFinalReduction(input);
        },
      },
    })),
  });
  return { app, fault };
};

test('an acceptance whose application stopped before the run can still be withdrawn, and is re-checked on a retry', async () => {
  const { app, fault } = translationFaulted();
  const context = await runAwaitingReduction(app);
  const submitted = await proposeReduction(app, context, { decisions: REDUCTION_DECISIONS });
  assert.equal(submitted.proposal.agent_review.verdict, AGENT_REVIEW.REQUIRES_EXPLICIT_ACCEPTANCE);
  const runBefore = await runOf(app, context);
  const candidatesBefore = await candidatesOf(app, context);
  fault.armed = true;

  const first = await accept(app, context, submitted.proposal.proposal_id);
  assert.equal(first.ok, false);
  assert.equal(first.error.code, 'INVALID_REQUEST');
  assert.equal(first.error.details.run_resume_called, false);
  assert.match(first.error.details.notice, /stopped before it reached the run/);
  assert.match(first.error.details.notice, /can also still be rejected or withdrawn/);

  const mid = (await app.getProposal(OWNER, context.fixture.projectId, submitted.proposal.proposal_id)).proposal;
  assert.equal(mid.state, PROPOSAL_STATE.ACCEPTED, 'the acceptance is on the record');
  assert.equal(mid.application.run_resume_called, false, 'and so is the fact that nothing reached the run');
  assert.equal(mid.application.conflict.code, 'INVALID_REQUEST');

  // A retry goes through the policy again -- nothing of this acceptance has
  // moved the run -- and then fails the same way, still short of the run.
  const retry = await accept(app, context, submitted.proposal.proposal_id);
  assert.equal(retry.ok, false);
  assert.equal(retry.error.details.run_resume_called, false);

  // It used to stop here for good: accepted, open, and refusing both of these
  // with "its application may already have reached the run".
  const withdrawn = await app.resolveProposal(OWNER, context.fixture.projectId, submitted.proposal.proposal_id, {
    resolution: 'withdraw', reason: 'The plan cannot be derived for this acceptance.',
  });
  assert.equal(withdrawn.proposal.state, PROPOSAL_STATE.WITHDRAWN);
  assert.match(withdrawn.notice, /never reached the run/);
  assert.equal(withdrawn.proposal.resolution.resolution, 'withdraw');
  assert.equal(withdrawn.proposal.resolution.superseded_acceptance.accepted_by, RUN_REVIEWER, 'the acceptance it replaces stays on the record');
  assert.equal(withdrawn.proposal.application.run_resume_called, false);

  const runAfter = await runOf(app, context);
  assert.equal(runAfter.revision, runBefore.revision, 'the run never moved');
  assert.equal(runAfter.candidate_id, runBefore.candidate_id);
  assert.deepEqual(await candidatesOf(app, context), candidatesBefore, 'and nothing was minted');
  const open = (await app.listProposals(OWNER, context.fixture.projectId)).proposals.filter(entry => ['submitted', 'accepted'].includes(entry.state));
  assert.deepEqual(open, [], 'and it no longer holds an open slot');
});

test('a withdrawal that lands while an acceptance is being applied stops the application before the run', async () => {
  const app = createStudioApplication({});
  const context = await runAwaitingReduction(app);
  const submitted = await proposeReduction(app, context, { decisions: REDUCTION_DECISIONS });
  const runBefore = await runOf(app, context);
  const candidatesBefore = await candidatesOf(app, context);

  // Both in flight at once. The acceptance records itself first, releases the
  // lock to translate, and takes it again before it calls the run -- and the
  // withdrawal, queued behind the first hold, lands in between. That last
  // hold re-reads the proposal, finds it withdrawn, and stops.
  const [accepted, withdrawn] = await Promise.all([
    accept(app, context, submitted.proposal.proposal_id),
    app.resolveProposal(OWNER, context.fixture.projectId, submitted.proposal.proposal_id, { resolution: 'withdraw', reason: 'Changed my mind.' })
      .then(result => ({ ok: true, result }), error => ({ ok: false, error })),
  ]);
  assert.ok(withdrawn.ok, `${withdrawn.error?.code}: ${withdrawn.error?.message}`);
  assert.equal(withdrawn.result.proposal.state, PROPOSAL_STATE.WITHDRAWN);
  assert.equal(accepted.ok, false);
  assert.equal(accepted.error.code, 'PROPOSAL_CONFLICT');
  assert.equal(accepted.error.details.proposal_state, PROPOSAL_STATE.WITHDRAWN);
  assert.match(accepted.error.message, /before the application reached the run/);

  const settled = (await app.getProposal(OWNER, context.fixture.projectId, submitted.proposal.proposal_id)).proposal;
  assert.equal(settled.state, PROPOSAL_STATE.WITHDRAWN);
  assert.equal(settled.application.run_resume_called, false);
  assert.equal(settled.application.conflict, null, 'the stopped attempt wrote nothing over the withdrawal');
  assert.equal((await runOf(app, context)).revision, runBefore.revision, 'the run never moved');
  assert.deepEqual(await candidatesOf(app, context), candidatesBefore, 'and nothing was minted');
});

test('an acceptance that reached the run cannot be withdrawn, and the refusal says so', async () => {
  let armed = true;
  const app = createStudioApplication({
    runHooks: { beforeEffect: ({ step }) => { if (armed && step === RUN_STEP.FINAL_REDUCTION) { armed = false; throw Error('the process stopped before the effect'); } } },
  });
  const context = await runAwaitingReduction(app);
  const submitted = await proposeReduction(app, context, { decisions: REDUCTION_DECISIONS });

  const interrupted = await accept(app, context, submitted.proposal.proposal_id);
  assert.equal(interrupted.ok, false);
  assert.match(String(interrupted.error.message), /stopped before the effect/);
  assert.equal(interrupted.error.details.run_resume_called, true);
  const mid = (await app.getProposal(OWNER, context.fixture.projectId, submitted.proposal.proposal_id)).proposal;
  assert.equal(mid.state, PROPOSAL_STATE.ACCEPTED);
  assert.equal(mid.application.run_resume_called, true);
  assert.ok(mid.application.run_resume_called_at);

  for (const resolution of ['reject', 'withdraw']) {
    await assert.rejects(
      app.resolveProposal(OWNER, context.fixture.projectId, submitted.proposal.proposal_id, { resolution, reason: 'On reflection, no.' }),
      error => {
        assert.equal(error.code, 'PROPOSAL_CONFLICT');
        assert.equal(error.details.run_resume_called, true);
        assert.match(error.message, /handed its input to the run's resume path/);
        return true;
      },
    );
  }
  // And the documented remedy is the one that works: the retry finishes it.
  const retry = await accept(app, context, submitted.proposal.proposal_id);
  assert.ok(retry.ok, `${retry.error?.code}: ${retry.error?.message}`);
  assert.equal(retry.result.proposal.state, PROPOSAL_STATE.APPLIED);
});

test('an acceptance recorded before the marker existed is not guessed about', async () => {
  await withDirectory(async directory => {
    // A proposal stuck exactly as the defect left them: accepted, with a
    // conflict recorded, and a record that predates `run_resume_called`.
    const { app, fault } = translationFaulted({ dataDirectory: directory, durability: 'persistent' });
    const context = await runAwaitingReduction(app);
    const submitted = await proposeReduction(app, context, { decisions: REDUCTION_DECISIONS });
    fault.armed = true;
    assert.equal((await accept(app, context, submitted.proposal.proposal_id)).ok, false);

    let patched = false;
    for (const name of await readdir(join(directory, 'records'))) {
      const path = join(directory, 'records', name);
      const body = await readFile(path, 'utf8');
      if (!body.includes(submitted.proposal.proposal_id)) continue;
      const record = JSON.parse(body);
      delete record.proposals.find(entry => entry.proposal_id === submitted.proposal.proposal_id).application.run_resume_called;
      await writeFile(path, JSON.stringify(record));
      patched = true;
    }
    assert.ok(patched, 'the stored proposal record was found and downgraded');

    // Nothing on such a record can establish that no attempt reached the run,
    // so it is not withdrawable -- and the refusal says that, rather than
    // claiming to know either way.
    const restarted = createStudioApplication({ dataDirectory: directory, durability: 'persistent' });
    await assert.rejects(
      restarted.resolveProposal(OWNER, context.fixture.projectId, submitted.proposal.proposal_id, { resolution: 'withdraw' }),
      error => {
        assert.equal(error.code, 'PROPOSAL_CONFLICT');
        assert.equal(error.details.run_resume_called, null);
        assert.match(error.message, /cannot establish that none did/);
        return true;
      },
    );
    // Its retry is still the remedy, and still works when the translation does.
    const retry = await accept(restarted, context, submitted.proposal.proposal_id);
    assert.ok(retry.ok, `${retry.error?.code}: ${retry.error?.message}`);
    assert.equal(retry.result.proposal.state, PROPOSAL_STATE.APPLIED);
    assert.equal(retry.result.proposal.application.run_resume_called, true);
  });
});

// ─── C. the open cap names only remedies that exist ─────────────────────────

test('the open-proposal cap does not tell a project to withdraw what it cannot', async () => {
  await withDirectory(async directory => {
    const app = createStudioApplication({ dataDirectory: directory, durability: 'persistent' });
    const fixture = await projectWithSymbolicAsset(app, OWNER);
    const started = await app.startRun(OWNER, fixture.projectId, { asset_ids: [fixture.assetId] });
    const target = (await app.proposalTargets(OWNER, fixture.projectId, started.run.run_id)).targets
      .find(entry => entry.admissible_kinds.includes(PROPOSAL_KIND.EVIDENCE_NEEDED));
    const describe = index => ({
      run_id: started.run.run_id,
      request_key: target.request_key,
      kind: PROPOSAL_KIND.EVIDENCE_NEEDED,
      proposed_by: AGENT,
      rationale: `Statement ${index}: what is missing here.`,
      missing_evidence: ['A score covering this section.'],
    });
    const ids = [];
    for (let index = 0; index < LIMITS.maxProposalsPerProject; index += 1) {
      ids.push((await app.proposeDecision(OWNER, fixture.projectId, describe(index))).proposal.proposal_id);
    }

    // The cap counts states, so the fixture writes the states directly: every
    // open proposal an accepted one whose application may have reached the
    // run, and one of them an accepted one whose application never did.
    const rewrite = async edit => {
      for (const name of await readdir(join(directory, 'records'))) {
        const path = join(directory, 'records', name);
        const body = await readFile(path, 'utf8');
        if (!body.includes(ids[0])) continue;
        const record = JSON.parse(body);
        for (const entry of record.proposals) edit(entry);
        await writeFile(path, JSON.stringify(record));
      }
    };
    const acceptedMarker = reached => ({
      idempotency_key: 'proposal:fixture', expected_run_revision: started.run.revision, run_revision_at_attempt: null,
      run_resume_called: reached, accepted_by: RUN_REVIEWER, attempted_at: new Date().toISOString(),
      run_revision_after: null, run_state_after: null, candidate_id_after: null, derived: {},
      conflict: { code: 'RUN_CONFLICT', message: 'fixture', details: {}, at: new Date().toISOString() },
    });
    await rewrite(entry => {
      entry.state = PROPOSAL_STATE.ACCEPTED;
      entry.resolution = { resolution: 'accept', resolved_by: OWNER, accepted_by: RUN_REVIEWER, reason: null, at: new Date().toISOString() };
      entry.application = acceptedMarker(true);
    });

    const restarted = createStudioApplication({ dataDirectory: directory, durability: 'persistent' });
    await assert.rejects(restarted.proposeDecision(OWNER, fixture.projectId, describe(998)), error => {
      assert.equal(error.code, 'STORAGE_FULL');
      assert.equal(error.details.withdrawable_open_proposals, 0);
      assert.doesNotMatch(error.message, /Resolve or withdraw one/, 'no remedy that every attempt would refuse');
      assert.match(error.message, /none of them can be rejected or withdrawn/);
      return true;
    });

    await rewrite(entry => { if (entry.proposal_id === ids[0]) entry.application = acceptedMarker(false); });
    const again = createStudioApplication({ dataDirectory: directory, durability: 'persistent' });
    await assert.rejects(again.proposeDecision(OWNER, fixture.projectId, describe(999)), error => {
      assert.equal(error.details.withdrawable_open_proposals, 1);
      assert.match(error.message, /Resolve or withdraw one/);
      return true;
    });
    // And following it works.
    await again.resolveProposal(OWNER, fixture.projectId, ids[0], { resolution: 'withdraw', reason: 'Freeing a slot, as the refusal says to.' });
    const after = await again.proposeDecision(OWNER, fixture.projectId, describe(1000));
    assert.equal(after.proposal.agent_review.verdict, AGENT_REVIEW.PROPOSABLE);
  });
});
