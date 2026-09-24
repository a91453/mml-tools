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
//   * an acceptance records when the run ADMITS one of its attempts -- inside
//     the run's own first lock hold, after the run's own refusals and before
//     its first write. While the run has admitted none, the proposal may still
//     be rejected or withdrawn, and a retry is graded by the policy again,
//     including after an attempt the run refused before writing anything; once
//     one is admitted, it may not, and the refusal says which of the two it is.

import test from 'node:test';
import assert from 'node:assert/strict';

import { mkdtemp, readdir, readFile, rm, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { AGENT_REVIEW, LIMITS, PROPOSAL_KIND, PROPOSAL_STATE, RUN_STEP, createStudioApplication } from '../backend/application/index.mjs';
import { blobName } from '../backend/application/store.mjs';
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

test('a plan that cannot be derived from the stored material is STALE, never INVALID and never acceptable', async () => {
  await withDirectory(async directory => {
    const app = createStudioApplication({ dataDirectory: directory, durability: 'persistent' });
    const context = await runAwaitingReduction(app);
    const blob = key => join(directory, 'blobs', `${blobName(key)}.bin`);
    const read = async id => (await app.getProposal(OWNER, context.fixture.projectId, id)).proposal.agent_review;

    // The candidate's stored application is gone, though the record still
    // names it. That is a statement about the material, not an accusation
    // about the proposal -- and an acceptance could not translate it either.
    const cited = await proposeReduction(app, context, { decisions: REDUCTION_DECISIONS });
    assert.equal(cited.proposal.agent_review.verdict, AGENT_REVIEW.REQUIRES_EXPLICIT_ACCEPTANCE);
    const candidateBlob = blob(`application:${context.fixture.projectId}:${context.run.candidate_id}`);
    const candidateBytes = await readFile(candidateBlob);
    await unlink(candidateBlob);
    const missingCandidate = await read(cited.proposal.proposal_id);
    assert.equal(missingCandidate.verdict, AGENT_REVIEW.STALE);
    assert.deepEqual(missingCandidate.refusals, ['CANDIDATE_CHANGED']);
    assert.equal(missingCandidate.plan_derivation_error, 'CANDIDATE_NOT_FOUND');
    assert.match(missingCandidate.notice, /statement about the material, not about the proposal/);
    const refused = await accept(app, context, cited.proposal.proposal_id);
    assert.equal(refused.ok, false);
    assert.equal(refused.error.code, 'PROPOSAL_REFUSED');
    assert.equal(refused.error.details.agent_review.verdict, AGENT_REVIEW.STALE);
    await writeFile(candidateBlob, candidateBytes);
    assert.equal((await read(cited.proposal.proposal_id)).verdict, AGENT_REVIEW.REQUIRES_EXPLICIT_ACCEPTANCE, 'and acceptable again once it is back');

    // Any other failure to read -- here the stored baseline, for a proposal
    // that cites nothing and so reaches the plan without reading it first --
    // names the baseline.
    const uncited = await app.proposeDecision(OWNER, context.fixture.projectId, {
      run_id: context.run.run_id,
      request_key: context.target.request_key,
      kind: PROPOSAL_KIND.FINAL_REDUCTION,
      proposed_by: AGENT,
      rationale: 'Place the unassigned lane.',
      action: { decisions: REDUCTION_DECISIONS },
    });
    assert.equal(uncited.proposal.agent_review.verdict, AGENT_REVIEW.REQUIRES_MORE_EVIDENCE);
    await unlink(blob(`baseline:${context.fixture.projectId}`));
    const missingBaseline = await read(uncited.proposal.proposal_id);
    assert.equal(missingBaseline.verdict, AGENT_REVIEW.STALE);
    assert.deepEqual(missingBaseline.refusals, ['BASELINE_CHANGED']);
    assert.equal(missingBaseline.plan_derivation_error, 'SOURCE_INCOMPLETE');
  });
});

test('a plan operation that answers with no plan id is INVALID, because there is nothing to apply', async () => {
  const empty = { armed: false };
  const app = createStudioApplication({
    loadEngines: enginesWith(engines => ({
      reduction: {
        ...engines.reduction,
        planFinalReduction: input => {
          const plan = engines.reduction.planFinalReduction(input);
          return empty.armed ? { ...plan, id: null } : plan;
        },
      },
    })),
  });
  const context = await runAwaitingReduction(app);
  empty.armed = true;
  const submitted = await proposeReduction(app, context, { decisions: REDUCTION_DECISIONS });
  const review = submitted.proposal.agent_review;
  assert.equal(review.verdict, AGENT_REVIEW.INVALID);
  assert.deepEqual(review.refusals, ['REDUCTION_PLAN_REFUSED']);
  assert.equal(review.plan_refusal.operation, 'planFinalReduction');
  assert.equal(review.plan_refusal.code, null);
  assert.match(review.plan_refusal.message, /produced no plan id/);
  const outcome = await accept(app, context, submitted.proposal.proposal_id);
  assert.equal(outcome.ok, false);
  assert.equal(outcome.error.code, 'PROPOSAL_REFUSED');
  assert.equal((await app.getProposal(OWNER, context.fixture.projectId, submitted.proposal.proposal_id)).proposal.state, PROPOSAL_STATE.SUBMITTED);
});

test('the plan check runs only for a class the request admits', async () => {
  // A Mobile adaptation proposal against the reduction request. The request
  // does not admit the class, so the proposal is refused on the scope rung
  // whatever its plan says -- and no plan is derived against a request that
  // is not asking for one, which would report the request's shape as the
  // proposal's fault.
  const adaptations = [];
  const app = createStudioApplication({
    loadEngines: enginesWith(engines => ({
      adaptation: {
        ...engines.adaptation,
        planMobileAdaptation: input => {
          adaptations.push(input.profile?.id ?? null);
          return engines.adaptation.planMobileAdaptation(input);
        },
      },
    })),
  });
  const context = await runAwaitingReduction(app);
  const before = adaptations.length;
  const submitted = await app.proposeDecision(OWNER, context.fixture.projectId, {
    run_id: context.run.run_id,
    request_key: context.target.request_key,
    kind: PROPOSAL_KIND.MOBILE_ADAPTATION,
    proposed_by: AGENT,
    rationale: 'A profile the adaptation engine refuses, sent to the wrong request.',
    // A profile the plan operation refuses outright: graded, it would be
    // INVALID with ADAPTATION_PLAN_REFUSED.
    action: { profile: mobileProfile({ Chord5: { pitchRange: [40, 30] } }) },
    cites: { event_ids: ['chord5-1'] },
  });
  const review = submitted.proposal.agent_review;
  assert.equal(review.verdict, AGENT_REVIEW.NOT_AGENT_SETTLABLE, JSON.stringify(review));
  assert.ok(review.refusals.includes('TARGET_NOT_SETTLABLE_BY_THIS_CLASS'));
  assert.equal(review.plan_refusal, undefined);
  await app.getProposal(OWNER, context.fixture.projectId, submitted.proposal.proposal_id);
  assert.equal(adaptations.length, before, 'no adaptation plan was derived for it');
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

test('a retry of an acceptance that never reached the run is graded by the policy again, and refused once the run has moved', async () => {
  // The retry above fails the same way twice, so it cannot tell a retry the
  // policy re-graded from one that skipped it. Here the policy's answer
  // changes between the two: a human reviewer moves the run in between. A
  // retry that went back through the policy is refused as STALE before it
  // reaches the run, and stays withdrawable. One that skipped it would carry
  // its old precondition into the run, record that it reached it, and leave
  // the proposal accepted and not withdrawable -- the defect this marker
  // exists to prevent.
  const { app, fault } = translationFaulted();
  const context = await runAwaitingReduction(app);
  const submitted = await proposeReduction(app, context, { decisions: REDUCTION_DECISIONS });
  assert.equal(submitted.proposal.agent_review.verdict, AGENT_REVIEW.REQUIRES_EXPLICIT_ACCEPTANCE);
  fault.armed = true;
  const first = await accept(app, context, submitted.proposal.proposal_id);
  assert.equal(first.ok, false);
  assert.equal(first.error.details.run_resume_called, false);
  fault.armed = false;

  // Meanwhile a human reviewer applies a reduction by hand.
  const other = 'another-human-reviewer';
  const plan = (await app.planFinalReduction(OWNER, context.fixture.projectId, { candidateId: context.run.candidate_id, decisions: REDUCTION_DECISIONS, acceptedBy: other })).reduction.plan;
  const manual = await app.resumeRun(OWNER, context.fixture.projectId, context.run.run_id, {
    final_reduction: { decisions: REDUCTION_DECISIONS, expected_plan_id: plan.id, accepted_by: other },
  });
  assert.notEqual(manual.run.revision, context.run.revision);
  const candidatesAfterManual = await candidatesOf(app, context);

  const retry = await accept(app, context, submitted.proposal.proposal_id);
  assert.equal(retry.ok, false, 'the retry is not applied to a run that moved on without it');
  assert.equal(retry.error.code, 'PROPOSAL_REFUSED', `${retry.error.code}: ${retry.error.message}`);
  assert.equal(retry.error.details.agent_review.verdict, AGENT_REVIEW.STALE);
  assert.ok(retry.error.details.agent_review.refusals.includes('RUN_REVISION_CHANGED'));

  const mid = (await app.getProposal(OWNER, context.fixture.projectId, submitted.proposal.proposal_id)).proposal;
  assert.equal(mid.state, PROPOSAL_STATE.ACCEPTED);
  assert.equal(mid.application.run_resume_called, false, 'refused before the run, so still nothing reached it');
  const runNow = await runOf(app, context);
  assert.equal(runNow.revision, manual.run.revision, 'the refused retry did not touch the run');
  assert.equal(runNow.candidate_id, manual.run.candidate_id);
  assert.deepEqual(await candidatesOf(app, context), candidatesAfterManual);

  const withdrawn = await app.resolveProposal(OWNER, context.fixture.projectId, submitted.proposal.proposal_id, {
    resolution: 'withdraw', reason: 'Superseded by the reviewer\'s own reduction.',
  });
  assert.equal(withdrawn.proposal.state, PROPOSAL_STATE.WITHDRAWN);
});

test('a withdrawal that lands while a failing acceptance is translating is not written over', async () => {
  // The acceptance records itself, releases the lock and translates; the
  // withdrawal, queued behind that first hold, lands; the translation then
  // fails before the run. Phase 3 finds the proposal withdrawn and leaves the
  // record exactly as the withdrawal wrote it: no conflict, no pin, no new
  // revision over it.
  const { app, fault } = translationFaulted();
  const context = await runAwaitingReduction(app);
  const submitted = await proposeReduction(app, context, { decisions: REDUCTION_DECISIONS });
  const runBefore = await runOf(app, context);
  fault.armed = true;

  const [accepted, withdrawn] = await Promise.all([
    accept(app, context, submitted.proposal.proposal_id),
    app.resolveProposal(OWNER, context.fixture.projectId, submitted.proposal.proposal_id, { resolution: 'withdraw', reason: 'Changed my mind.' })
      .then(result => ({ ok: true, result }), error => ({ ok: false, error })),
  ]);
  assert.ok(withdrawn.ok, `${withdrawn.error?.code}: ${withdrawn.error?.message}`);
  assert.equal(accepted.ok, false);
  assert.equal(accepted.error.code, 'INVALID_REQUEST', 'the translation failed');
  assert.equal(accepted.error.details.proposal_state, PROPOSAL_STATE.WITHDRAWN, 'after the withdrawal landed');
  assert.match(accepted.error.details.notice, /withdrawn meanwhile/);

  const asWithdrawn = withdrawn.result.proposal;
  assert.equal(asWithdrawn.state, PROPOSAL_STATE.WITHDRAWN);
  assert.equal(asWithdrawn.revision, submitted.proposal.revision + 2, 'accepted, then withdrawn');
  const settled = (await app.getProposal(OWNER, context.fixture.projectId, submitted.proposal.proposal_id)).proposal;
  assert.equal(settled.revision, asWithdrawn.revision, 'the failed attempt added no revision');
  assert.equal(settled.updated_at, asWithdrawn.updated_at);
  assert.deepEqual(settled.resolution, asWithdrawn.resolution);
  assert.deepEqual(settled.application, asWithdrawn.application, 'and wrote nothing into the application record');
  assert.equal(settled.application.conflict, null);
  assert.equal(settled.application.run_revision_at_attempt, null);
  assert.equal(settled.application.run_resume_called, false);
  assert.equal((await runOf(app, context)).revision, runBefore.revision, 'the run never moved');
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

test('an attempt that never reached the run pins nothing, and a later interrupted attempt is still finished by its retry', async () => {
  // `run_revision_at_attempt` records where an INTERRUPTED attempt's own
  // request left the run. An attempt that failed before `runs.resume` left the
  // run nowhere -- it never touched it -- but it used to write the revision the
  // run happened to be at anyway. That revision was then what a retry carried
  // as its precondition, written once: a later attempt that did reach the run
  // and was interrupted there could not move it, so the retry after that
  // failed the precondition against the pre-interruption revision, with
  // `run_resume_called` already true: accepted, open and not withdrawable for
  // good. The same stuck proposal, one attempt later. (A retry now continues
  // from the run's own record of which request made its latest write; the pin
  // is a record of the attempt.)
  const fault = { armed: false };
  let interrupt = false;
  const app = createStudioApplication({
    runHooks: { beforeEffect: ({ step }) => { if (interrupt && step === RUN_STEP.FINAL_REDUCTION) { interrupt = false; throw Error('the process stopped before the effect'); } } },
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
  const context = await runAwaitingReduction(app);
  const submitted = await proposeReduction(app, context, { decisions: REDUCTION_DECISIONS });
  const candidatesBefore = await candidatesOf(app, context);
  const read = async () => (await app.getProposal(OWNER, context.fixture.projectId, submitted.proposal.proposal_id)).proposal;

  // 1. Fails before the run. Nothing about the run is known to it.
  fault.armed = true;
  const first = await accept(app, context, submitted.proposal.proposal_id);
  assert.equal(first.ok, false);
  assert.equal(first.error.details.run_resume_called, false);
  assert.equal((await read()).application.run_revision_at_attempt, null, 'an attempt that never reached the run pins nothing');

  // 2. Reaches the run and is interrupted inside it.
  fault.armed = false;
  interrupt = true;
  const second = await accept(app, context, submitted.proposal.proposal_id);
  assert.equal(second.ok, false);
  assert.match(String(second.error.message), /stopped before the effect/);
  assert.equal(second.error.details.run_resume_called, true);
  const interrupted = await read();
  assert.equal(interrupted.application.run_revision_at_attempt, (await runOf(app, context)).revision, 'pinned where the interrupted attempt left the run');

  // 3. The retry finishes exactly that application.
  const third = await accept(app, context, submitted.proposal.proposal_id);
  assert.ok(third.ok, `the retry must finish the interrupted application, got ${third.error?.code}: ${third.error?.message}`);
  assert.equal(third.result.proposal.state, PROPOSAL_STATE.APPLIED);
  assert.equal(third.result.proposal.application.settled_on_retry, true);
  const minted = (await candidatesOf(app, context)).filter(entry => !candidatesBefore.some(before => before.candidate_id === entry.candidate_id));
  assert.equal(minted.length, 1, 'one acceptance, one application');
});

test('an attempt the run refuses at its own precondition changed nothing: it pins no revision, and its retry is graded again and refused', async () => {
  // Two different, valid reduction proposals on one request, accepted at once.
  // Both are graded against, and record, the same run revision. The first to
  // reach the run is applied. The other reaches `runs.resume` after the run
  // has moved, and the run refuses it at its own revision precondition --
  // under its lock, before it writes anything. That attempt changed nothing.
  //
  // It used to count as one that had reached the run all the same, because the
  // marker was written before the call: phase 3 pinned the revision the OTHER
  // application had left the run at, the retry skipped the policy on the
  // strength of the marker, passed its precondition against that borrowed
  // revision and moved the run -- recorded `applied`, naming an advancement it
  // had not caused, while the policy graded it STALE at the same moment.
  const app = createStudioApplication({});
  const context = await runAwaitingReduction(app);
  const alternative = [{ ...REDUCTION_DECISIONS[0], id: 'place-chord5-alternative', reason: 'Another reading of the same lane: placed in the free enrichment role as a separate decision.' }];
  const planOf = async decisions => (await app.planFinalReduction(OWNER, context.fixture.projectId, {
    candidateId: context.run.candidate_id, decisions, acceptedBy: RUN_REVIEWER,
  })).reduction.plan.id;
  const alternativePlan = await planOf(alternative);
  assert.notEqual(await planOf(REDUCTION_DECISIONS), alternativePlan, 'two different applications of one request');
  const proposals = [
    (await proposeReduction(app, context, { decisions: REDUCTION_DECISIONS })).proposal,
    (await proposeReduction(app, context, { decisions: alternative }, 'Place the unassigned lane, read as a separate decision.')).proposal,
  ];
  for (const proposal of proposals) assert.equal(proposal.agent_review.verdict, AGENT_REVIEW.REQUIRES_EXPLICIT_ACCEPTANCE, JSON.stringify(proposal.agent_review));
  const candidatesBefore = await candidatesOf(app, context);

  const outcomes = await Promise.all(proposals.map(proposal => accept(app, context, proposal.proposal_id)));
  assert.equal(outcomes.filter(outcome => outcome.ok).length, 1, `exactly one is applied: ${JSON.stringify(outcomes.map(outcome => outcome.ok || outcome.error.code))}`);
  const winner = outcomes.find(outcome => outcome.ok).result;
  const refused = outcomes.find(outcome => !outcome.ok).error;
  const loser = proposals[outcomes.findIndex(outcome => !outcome.ok)];

  // The run's own refusal, at its precondition: the revision both acceptances
  // observed, and a run that had moved past it.
  assert.equal(refused.code, 'RUN_CONFLICT', `${refused.code}: ${refused.message}`);
  assert.equal(refused.details.expected_run_revision, context.run.revision);
  assert.notEqual(refused.details.current_run_revision, context.run.revision);
  assert.equal(refused.details.run_resume_called, false, 'the run admitted nothing of it');
  assert.match(refused.details.notice, /refused this attempt before admitting it/);

  const runAfterWinner = await runOf(app, context);
  assert.equal(runAfterWinner.candidate_id, winner.run.candidate_id);
  const candidatesAfterWinner = await candidatesOf(app, context);
  assert.equal(candidatesAfterWinner.length, candidatesBefore.length + 1, 'one application landed');

  const read = async () => (await app.getProposal(OWNER, context.fixture.projectId, loser.proposal_id)).proposal;
  const mid = await read();
  assert.equal(mid.state, PROPOSAL_STATE.ACCEPTED);
  assert.equal(mid.application.conflict.code, 'RUN_CONFLICT', 'the refusal is on the record');
  assert.equal(mid.application.conflict.admitted_by_run, false, 'and so is that the run never admitted it');
  assert.equal(mid.application.run_revision_at_attempt, null, 'it left the run nowhere, so it pins nothing');
  assert.equal(mid.application.run_resume_called, false);
  assert.equal(mid.agent_review.verdict, AGENT_REVIEW.STALE);

  // The retry goes back through the policy, which refuses it: the run moved
  // on without it. It is not applied onto the run the other application left.
  const retry = await accept(app, context, loser.proposal_id);
  assert.equal(retry.ok, false, 'not applied onto a run another application moved');
  assert.equal(retry.error.code, 'PROPOSAL_REFUSED', `${retry.error.code}: ${retry.error.message}`);
  assert.equal(retry.error.details.agent_review.verdict, AGENT_REVIEW.STALE);
  assert.ok(retry.error.details.agent_review.refusals.includes('RUN_REVISION_CHANGED'));
  const runNow = await runOf(app, context);
  assert.equal(runNow.revision, runAfterWinner.revision, 'the refused retry did not touch the run');
  assert.equal(runNow.candidate_id, runAfterWinner.candidate_id);
  const candidatesNow = await candidatesOf(app, context);
  assert.deepEqual(candidatesNow, candidatesAfterWinner, 'and minted nothing');
  assert.ok(!candidatesNow.some(entry => (entry.decision_ids ?? []).includes(alternativePlan)), 'no candidate carries the refused plan');

  // Nothing of it ever reached the run, so it can still be withdrawn.
  const withdrawn = await app.resolveProposal(OWNER, context.fixture.projectId, loser.proposal_id, {
    resolution: 'withdraw', reason: 'The request was answered by the other proposal.',
  });
  assert.equal(withdrawn.proposal.state, PROPOSAL_STATE.WITHDRAWN);
  assert.match(withdrawn.notice, /never reached the run/);
  assert.equal((await runOf(app, context)).revision, runAfterWinner.revision);
});

test('a human reviewer who moves the run while an acceptance is on its way to it leaves that acceptance refused, not borrowed', async () => {
  // The same defect with a person as the other actor. The acceptance is
  // graded and recorded under the lock; while it is being translated a
  // reviewer applies a reduction of their own by hand; the acceptance then
  // reaches `runs.resume` and the run refuses it at its precondition. The
  // reviewer's revision is not the acceptance's to finish on.
  const other = 'another-human-reviewer';
  const manual = { started: null };
  let plan = null;
  let context = null;
  const app = createStudioApplication({
    loadEngines: enginesWith(engines => ({
      reduction: {
        ...engines.reduction,
        planFinalReduction: input => {
          // Only the acceptance's own translation plans under the accepting
          // reviewer; the policy's derivation and the reviewer's own step do
          // not. Once, and without waiting: the reviewer's request is simply
          // in flight by the time the translation returns.
          if (plan && !manual.started && input.acceptedBy === RUN_REVIEWER) {
            manual.started = app.resumeRun(OWNER, context.fixture.projectId, context.run.run_id, {
              final_reduction: { decisions: REDUCTION_DECISIONS, expected_plan_id: plan.id, accepted_by: other },
            });
          }
          return engines.reduction.planFinalReduction(input);
        },
      },
    })),
  });
  context = await runAwaitingReduction(app);
  const submitted = await proposeReduction(app, context, { decisions: REDUCTION_DECISIONS });
  assert.equal(submitted.proposal.agent_review.verdict, AGENT_REVIEW.REQUIRES_EXPLICIT_ACCEPTANCE);
  plan = (await app.planFinalReduction(OWNER, context.fixture.projectId, { candidateId: context.run.candidate_id, decisions: REDUCTION_DECISIONS, acceptedBy: other })).reduction.plan;

  const first = await accept(app, context, submitted.proposal.proposal_id);
  assert.ok(manual.started, 'the reviewer acted while the acceptance was being translated');
  const reviewed = await manual.started;
  assert.equal(first.ok, false);
  assert.equal(first.error.code, 'RUN_CONFLICT', `${first.error.code}: ${first.error.message}`);
  assert.equal(first.error.details.expected_run_revision, context.run.revision, 'refused at the precondition the acceptance recorded');
  assert.equal(first.error.details.run_resume_called, false);
  assert.equal(first.error.details.admitted_by_run, false);
  const runAfterReviewer = await runOf(app, context);
  assert.equal(runAfterReviewer.candidate_id, reviewed.run.candidate_id, 'the reviewer\'s application is the run\'s');
  const candidatesAfterReviewer = await candidatesOf(app, context);

  const mid = (await app.getProposal(OWNER, context.fixture.projectId, submitted.proposal.proposal_id)).proposal;
  assert.equal(mid.application.run_revision_at_attempt, null, 'the reviewer\'s revision is not pinned as this acceptance\'s');
  assert.equal(mid.application.run_resume_called, false);

  const retry = await accept(app, context, submitted.proposal.proposal_id);
  assert.equal(retry.ok, false);
  assert.equal(retry.error.code, 'PROPOSAL_REFUSED', `${retry.error.code}: ${retry.error.message}`);
  assert.equal(retry.error.details.agent_review.verdict, AGENT_REVIEW.STALE);
  assert.equal((await runOf(app, context)).revision, runAfterReviewer.revision, 'the run is where the reviewer left it');
  assert.deepEqual(await candidatesOf(app, context), candidatesAfterReviewer);
  const withdrawn = await app.resolveProposal(OWNER, context.fixture.projectId, submitted.proposal.proposal_id, {
    resolution: 'withdraw', reason: 'Superseded by the reviewer\'s own reduction.',
  });
  assert.equal(withdrawn.proposal.state, PROPOSAL_STATE.WITHDRAWN);
});

test('an admitted attempt pins where its own application left the run, and a reviewer who moved the run after it leaves its retry refused', async () => {
  // The attempt is admitted and interrupted after its own last write. A human
  // reviewer's resume, queued behind that hold, lands its first hold -- a bump
  // folding in a reduction of their own -- before the acceptance records its
  // outcome, and then fails in its own step without writing more.
  //
  // The acceptance used to pin the revision the run was at when it recorded
  // its outcome: the reviewer's. Its retry skipped the policy, passed its
  // precondition against that borrowed revision and was recorded `applied`
  // after another actor had moved the run. The pin is now the revision this
  // attempt's own request last wrote, as the run reported it under its own
  // lock, and the retry continues only from a revision the run records as this
  // application's own.
  const other = 'another-human-reviewer';
  const alternative = [{ ...REDUCTION_DECISIONS[0], id: 'place-chord5-by-hand', reason: 'The reviewer placed the lane by hand, as a decision of their own.' }];
  const state = { armed: false, faultOther: false, ownRevision: null, reviewer: null, otherPlan: null, context: null };
  const app = createStudioApplication({
    loadEngines: enginesWith(engines => ({
      reduction: {
        ...engines.reduction,
        planFinalReduction: input => {
          if (state.faultOther && input.acceptedBy === other) throw Error('a transient engine fault in the reviewer\'s own step');
          return engines.reduction.planFinalReduction(input);
        },
      },
    })),
    runHooks: {
      beforeResponse: async ({ step, run }) => {
        if (!state.armed || step !== RUN_STEP.FINAL_REDUCTION) return;
        state.armed = false;
        state.ownRevision = run.revision;
        state.reviewer = app.resumeRun(OWNER, state.context.fixture.projectId, state.context.run.run_id, {
          final_reduction: { decisions: alternative, expected_plan_id: state.otherPlan, accepted_by: other },
        }).then(result => ({ ok: true, result }), error => ({ ok: false, error }));
        // Long enough for the reviewer's request to queue for the run's lock
        // ahead of the acceptance's own last hold.
        await new Promise(resolve => setImmediate(resolve));
        throw Error('the process stopped before the response');
      },
    },
  });
  const context = await runAwaitingReduction(app);
  state.context = context;
  state.otherPlan = (await app.planFinalReduction(OWNER, context.fixture.projectId, {
    candidateId: context.run.candidate_id, decisions: alternative, acceptedBy: other,
  })).reduction.plan.id;
  const submitted = await proposeReduction(app, context, { decisions: REDUCTION_DECISIONS });
  assert.equal(submitted.proposal.agent_review.verdict, AGENT_REVIEW.REQUIRES_EXPLICIT_ACCEPTANCE);
  const read = async () => (await app.getProposal(OWNER, context.fixture.projectId, submitted.proposal.proposal_id)).proposal;

  state.armed = true;
  state.faultOther = true;
  const first = await accept(app, context, submitted.proposal.proposal_id);
  assert.equal(first.ok, false);
  assert.match(String(first.error.message), /stopped before the response/);
  assert.equal(first.error.details.admitted_by_run, true);
  const reviewed = await state.reviewer;
  assert.equal(reviewed.ok, false, 'the reviewer\'s own step failed');
  assert.match(String(reviewed.error.message), /transient engine fault/);
  const runAfterReviewer = await runOf(app, context);
  assert.ok(runAfterReviewer.revision > state.ownRevision, 'the reviewer\'s request moved the run after the attempt\'s own last write');
  assert.ok(runAfterReviewer.declared_reviewers.includes(other));

  const mid = await read();
  assert.equal(mid.state, PROPOSAL_STATE.ACCEPTED);
  assert.equal(mid.application.run_resume_called, true);
  assert.equal(mid.application.run_revision_at_attempt, state.ownRevision, 'pinned where its own application left the run, not where the reviewer did');
  const candidatesAfterReviewer = await candidatesOf(app, context);

  const retry = await accept(app, context, submitted.proposal.proposal_id);
  assert.equal(retry.ok, false, 'not finished onto a run another actor moved');
  assert.equal(retry.error.code, 'RUN_CONFLICT', `${retry.error.code}: ${retry.error.message}`);
  assert.equal(retry.error.details.admitted_by_run, false);
  const runNow = await runOf(app, context);
  assert.equal(runNow.revision, runAfterReviewer.revision, 'the refused retry did not touch the run');
  assert.equal(runNow.candidate_id, runAfterReviewer.candidate_id);
  assert.deepEqual(await candidatesOf(app, context), candidatesAfterReviewer, 'and minted nothing');
  const settled = await read();
  assert.equal(settled.state, PROPOSAL_STATE.ACCEPTED, 'not recorded as applied');
  assert.equal(settled.application.run_revision_at_attempt, state.ownRevision, 'and the refused retry pinned nothing either');
  await assert.rejects(
    app.resolveProposal(OWNER, context.fixture.projectId, submitted.proposal.proposal_id, { resolution: 'withdraw', reason: 'The reviewer moved the run.' }),
    error => error.code === 'PROPOSAL_CONFLICT',
    'its application reached the run, so it is not withdrawable',
  );
});

test('a retry that would hand the run a different request than the one it admitted for this acceptance is refused before the run writes anything', async () => {
  // A retry finishes the application the run admitted: the same idempotency
  // key AND the same request. Here the plan the acceptance derives moves
  // between the interrupted attempt and its retry -- the engines the plan is
  // derived with changed, say -- so the retry would carry another request
  // under the same key, onto a run whose latest write is the first request's.
  // The run admits nothing of it and writes nothing.
  const moved = { armed: false };
  let interrupt = false;
  const app = createStudioApplication({
    runHooks: { beforeEffect: ({ step }) => { if (interrupt && step === RUN_STEP.FINAL_REDUCTION) { interrupt = false; throw Error('the process stopped before the effect'); } } },
    loadEngines: enginesWith(engines => ({
      reduction: {
        ...engines.reduction,
        planFinalReduction: input => {
          const plan = engines.reduction.planFinalReduction(input);
          return moved.armed && input.acceptedBy === RUN_REVIEWER ? { ...plan, id: `${plan.id}:moved` } : plan;
        },
      },
    })),
  });
  const context = await runAwaitingReduction(app);
  const submitted = await proposeReduction(app, context, { decisions: REDUCTION_DECISIONS });
  const read = async () => (await app.getProposal(OWNER, context.fixture.projectId, submitted.proposal.proposal_id)).proposal;
  const candidatesBefore = await candidatesOf(app, context);

  interrupt = true;
  const first = await accept(app, context, submitted.proposal.proposal_id);
  assert.equal(first.ok, false);
  assert.equal(first.error.details.admitted_by_run, true);
  const interrupted = await read();
  assert.equal(typeof interrupted.application.admitted_request_fingerprint, 'string', 'the run\'s admission recorded which request it let in');
  const runInterrupted = await runOf(app, context);
  const candidatesInterrupted = await candidatesOf(app, context);

  moved.armed = true;
  const retry = await accept(app, context, submitted.proposal.proposal_id);
  assert.equal(retry.ok, false, 'a different request under the same key is not a retry of this application');
  assert.equal(retry.error.code, 'IDEMPOTENCY_CONFLICT', `${retry.error.code}: ${retry.error.message}`);
  assert.equal(retry.error.details.admitted_by_run, false);
  assert.equal(retry.error.details.admitted_request_fingerprint, interrupted.application.admitted_request_fingerprint);
  assert.notEqual(retry.error.details.received_request_fingerprint, interrupted.application.admitted_request_fingerprint);
  const runAfter = await runOf(app, context);
  assert.equal(runAfter.revision, runInterrupted.revision, 'the run wrote nothing');
  assert.deepEqual(await candidatesOf(app, context), candidatesInterrupted, 'and minted nothing');
  const mid = await read();
  assert.equal(mid.state, PROPOSAL_STATE.ACCEPTED);
  assert.equal(mid.application.admitted_request_fingerprint, interrupted.application.admitted_request_fingerprint, 'the admitted request stays the one on the record');
  assert.equal(mid.application.run_revision_at_attempt, interrupted.application.run_revision_at_attempt);

  // With the plan back where it was, the retry is the same request again and
  // finishes the application.
  moved.armed = false;
  const finished = await accept(app, context, submitted.proposal.proposal_id);
  assert.ok(finished.ok, `${finished.error?.code}: ${finished.error?.message}`);
  assert.equal(finished.result.proposal.state, PROPOSAL_STATE.APPLIED);
  const minted = (await candidatesOf(app, context)).filter(entry => !candidatesBefore.some(before => before.candidate_id === entry.candidate_id));
  assert.equal(minted.length, 1, 'one acceptance, one application');
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
