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
//     Nor may it once the run has taken a write since the acceptance that does
//     not record which request made it: the release a rollback returns to
//     applies an acceptance without recording any admission (section D).

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

/** The stored run record, as it is on disk, with every field the run keeps. */
const storedRunOf = async (directory, runId) => {
  for (const name of await readdir(join(directory, 'records'))) {
    const record = JSON.parse(await readFile(join(directory, 'records', name), 'utf8'));
    const run = (record.runs ?? []).find(entry => entry.run_id === runId);
    if (run) return run;
  }
  return assert.fail('the stored run record was found');
};
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
  // reaches the run, names the reason, and stays withdrawable. One that
  // skipped it would carry the revision the acceptance observed into the run
  // and be refused there instead, at the run's own precondition and before
  // admission -- still withdrawable, but told only RUN_CONFLICT. Since the
  // marker is written at the run's admission rather than before the call, the
  // policy here is defence in depth with the right reason, not the only thing
  // between the retry and the run.
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

  // Both in flight at once. The acceptance records itself first and releases
  // the lock to translate; the withdrawal, queued behind that first hold,
  // lands while it translates. The acceptance then calls the run, and the
  // run's admission -- inside the run's own first lock hold, after the run's
  // refusals and before its first write -- re-reads the proposal, finds it
  // withdrawn, and refuses: the run writes nothing.
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

test('an attempt whose only write is the run\'s first hold records that write as its own, and its retry finishes the application', async () => {
  // `resume` bumps the run in its first lock hold, before any step runs, and
  // that write is this request's like every other: the run records the
  // request as the writer of the revision it produces and reports the
  // revision back. Here the run's own reduction step then fails in its
  // read-only plan preview -- a transient engine fault -- before that step
  // writes anything, so the first hold's bump is the only write the attempt
  // made. Recorded as nobody's, it would leave nothing to tell the run's
  // latest write as this application's: the attempt would record no revision,
  // every retry would carry the revision the acceptance observed and be
  // refused, and the proposal would stay accepted and not withdrawable
  // although only its own application ever wrote to the run.
  await withDirectory(async directory => {
    const fault = { armed: false, calls: 0, fired: false };
    const app = createStudioApplication({
      dataDirectory: directory,
      durability: 'persistent',
      loadEngines: enginesWith(engines => ({
        reduction: {
          ...engines.reduction,
          planFinalReduction: input => {
            // The acceptance's translation derives the plan under the
            // accepting reviewer first; the run's own step derives it second.
            if (fault.armed && input.acceptedBy === RUN_REVIEWER && ++fault.calls === 2) {
              fault.armed = false;
              fault.fired = true;
              throw Error('a transient engine fault in the run step\'s own plan preview');
            }
            return engines.reduction.planFinalReduction(input);
          },
        },
      })),
    });
    const context = await runAwaitingReduction(app);
    const submitted = await proposeReduction(app, context, { decisions: REDUCTION_DECISIONS });
    const read = async () => (await app.getProposal(OWNER, context.fixture.projectId, submitted.proposal.proposal_id)).proposal;
    const runBefore = await runOf(app, context);
    const candidatesBefore = await candidatesOf(app, context);

    fault.armed = true;
    const first = await accept(app, context, submitted.proposal.proposal_id);
    assert.equal(first.ok, false);
    assert.equal(fault.fired, true);
    assert.match(String(first.error.message), /run step's own plan preview/);
    assert.equal(first.error.details.admitted_by_run, true, 'the run admitted the attempt before its step failed');
    const runAfter = await runOf(app, context);
    assert.equal(runAfter.revision, runBefore.revision + 1, 'the first hold\'s bump is the only write the attempt made');
    assert.equal(runAfter.pending_step, null, 'the step itself wrote nothing');

    const mid = await read();
    assert.equal(mid.state, PROPOSAL_STATE.ACCEPTED);
    assert.equal(mid.application.run_revision_at_attempt, runAfter.revision, 'that write was reported as the attempt\'s own');
    const stored = await storedRunOf(directory, context.run.run_id);
    assert.deepEqual(stored.revision_written_by, {
      idempotency_key: mid.application.idempotency_key,
      request_fingerprint: mid.application.admitted_request_fingerprint,
      revision: runAfter.revision,
    }, 'and the run records it as this request\'s write of that revision');
    await assert.rejects(
      app.resolveProposal(OWNER, context.fixture.projectId, submitted.proposal.proposal_id, { resolution: 'withdraw', reason: 'The step failed.' }),
      error => error.code === 'PROPOSAL_CONFLICT',
      'its application reached the run, so it is not withdrawable',
    );

    const retry = await accept(app, context, submitted.proposal.proposal_id);
    assert.ok(retry.ok, `the retry must finish the application, got ${retry.error?.code}: ${retry.error?.message}`);
    assert.equal(retry.result.proposal.state, PROPOSAL_STATE.APPLIED);
    assert.equal(retry.result.proposal.application.settled_on_retry, true);
    const minted = (await candidatesOf(app, context)).filter(entry => !candidatesBefore.some(before => before.candidate_id === entry.candidate_id));
    assert.equal(minted.length, 1, 'one acceptance, one application');
  });
});

test('a refused twin of an attempt the run already admitted pins nothing, and the admitted attempt pins where its own application stopped', async () => {
  // One proposal accepted twice at once. One attempt is admitted and advances;
  // the other reaches the run after it has moved and is refused at the run's
  // precondition, and records its outcome while the admitted one is still in
  // flight -- so the record's marker is already true when it does. It changed
  // nothing and pins nothing. The admitted attempt is then interrupted at a
  // later step and pins where its own application stopped, and the retry
  // finishes that application.
  const state = { armed: false, effects: 0, interruptedAt: null, snapshot: null, read: null };
  const app = createStudioApplication({
    runHooks: {
      beforeEffect: async ({ step, run }) => {
        if (!state.armed) return;
        state.effects += 1;
        if (state.effects < 2) return;
        state.armed = false;
        state.interruptedAt = run.revision;
        // What the record said just before the admitted attempt stopped.
        // Reads take no lock.
        state.snapshot = (await state.read()).application;
        throw Error(`the process stopped before the ${step} effect`);
      },
    },
  });
  const context = await runAwaitingReduction(app);
  const submitted = await proposeReduction(app, context, { decisions: REDUCTION_DECISIONS });
  state.read = async () => (await app.getProposal(OWNER, context.fixture.projectId, submitted.proposal.proposal_id)).proposal;
  const candidatesBefore = await candidatesOf(app, context);

  state.armed = true;
  const outcomes = await Promise.all([accept(app, context, submitted.proposal.proposal_id), accept(app, context, submitted.proposal.proposal_id)]);
  assert.ok(outcomes.every(outcome => !outcome.ok), JSON.stringify(outcomes.map(outcome => outcome.ok || outcome.error.code)));
  const admitted = outcomes.find(outcome => outcome.error.details.admitted_by_run === true);
  const twin = outcomes.find(outcome => outcome.error.details.admitted_by_run === false);
  assert.ok(admitted && twin, JSON.stringify(outcomes.map(outcome => [outcome.error.code, outcome.error.details.admitted_by_run])));
  assert.match(String(admitted.error.message), /stopped before the/);
  assert.equal(twin.error.code, 'RUN_CONFLICT', `${twin.error.code}: ${twin.error.message}`);

  // The twin had recorded its refusal before the admitted attempt stopped, on
  // a record whose marker the admitted attempt had already set -- and pinned
  // nothing.
  assert.ok(state.snapshot, 'the admitted attempt reached its second effect');
  assert.equal(state.snapshot.run_resume_called, true);
  assert.equal(state.snapshot.conflict?.code, 'RUN_CONFLICT', 'the twin\'s refusal was on the record by then');
  assert.equal(state.snapshot.conflict.admitted_by_run, false);
  assert.equal(state.snapshot.run_revision_at_attempt, null, 'an attempt the run refused pins nothing, whatever another attempt of the same acceptance did');

  const mid = await state.read();
  assert.equal(mid.application.run_revision_at_attempt, state.interruptedAt, 'pinned where the admitted attempt\'s own application stopped');
  const retry = await accept(app, context, submitted.proposal.proposal_id);
  assert.ok(retry.ok, `the retry must finish the admitted application, got ${retry.error?.code}: ${retry.error?.message}`);
  assert.equal(retry.result.proposal.state, PROPOSAL_STATE.APPLIED);
  const minted = (await candidatesOf(app, context)).filter(entry => !candidatesBefore.some(before => before.candidate_id === entry.candidate_id));
  assert.equal(minted.length, 1, 'one acceptance, one application');
});

test('an attempt that fails after another attempt of the same acceptance applied it leaves the applied record as it is', async () => {
  // Two processes on one store, each with its own project lock. The first
  // attempt is admitted and held inside the run before its effect; meanwhile
  // the second process retries the same acceptance and applies it. The first
  // attempt then fails, and its record step finds the proposal applied. It
  // used to write its conflict onto the applied proposal all the same, so
  // studio_proposal_status showed a failure on a proposal that had applied.
  await withDirectory(async directory => {
    const options = { dataDirectory: directory, durability: 'persistent' };
    const hold = { armed: false, reached: null, release: null };
    const reached = new Promise(resolve => { hold.reached = resolve; });
    const released = new Promise(resolve => { hold.release = resolve; });
    const first = createStudioApplication({
      ...options,
      runHooks: {
        beforeEffect: async ({ step }) => {
          if (!hold.armed || step !== RUN_STEP.FINAL_REDUCTION) return;
          hold.armed = false;
          hold.reached();
          await released;
          throw Error('the process stopped before the effect');
        },
      },
    });
    const second = createStudioApplication(options);
    const context = await runAwaitingReduction(first);
    const submitted = await proposeReduction(first, context, { decisions: REDUCTION_DECISIONS });
    const proposalId = submitted.proposal.proposal_id;

    hold.armed = true;
    const held = accept(first, context, proposalId);
    await reached;
    const applied = await accept(second, context, proposalId);
    assert.ok(applied.ok, `the retry in the other process applies it: ${applied.error?.code}: ${applied.error?.message}`);
    assert.equal(applied.result.proposal.state, PROPOSAL_STATE.APPLIED);
    const asApplied = (await second.getProposal(OWNER, context.fixture.projectId, proposalId)).proposal;

    hold.release();
    const stopped = await held;
    assert.equal(stopped.ok, false);
    assert.match(String(stopped.error.message), /stopped before the effect/);
    assert.equal(stopped.error.details.proposal_state, PROPOSAL_STATE.APPLIED);
    assert.match(stopped.error.details.notice, /Another attempt of this acceptance applied it/);

    const settled = (await first.getProposal(OWNER, context.fixture.projectId, proposalId)).proposal;
    assert.equal(settled.state, PROPOSAL_STATE.APPLIED);
    assert.equal(settled.application.conflict, null, 'no conflict is written onto an applied proposal');
    assert.equal(settled.revision, asApplied.revision, 'the failed attempt added no revision');
    assert.deepEqual(settled.application, asApplied.application, 'and left the application record as the applying attempt wrote it');
  });
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

// ─── D. a build that does not record the admission ──────────────────────────
//
// Rolling the service back to the release before the admission marker and the
// run's writer record existed, and forward again, is a documented procedure
// (`ops/permanent/RELEASE_2026-09-24-v4.md`, Rollback). That release knows
// neither. Its retry of an accepted proposal skips the policy, is let into the
// run and writes to it without recording an admission, so the marker stays
// `false`. And its `bumpRun` writes the run as `{ ...run, ...changes, revision:
// run.revision + 1, updated_at }`: every write it makes carries, from the run it
// read, the writer record and every other field this build keeps about the
// run's writers. Rolled forward, the marker alone read such an acceptance as
// one nothing of which had reached the run, and let it be withdrawn with its
// application on the run.
//
// What that release leaves is written here as it leaves it. Its request reaches
// the run through the run's public entry point exactly as its proposal layer
// sends it -- the acceptance's key, the input the acceptance translates to, the
// revision the acceptance observed, and no admission -- and the stored run is
// then written back with the writer fields that release's `bumpRun` carries in
// place of the ones this build writes. Nothing else that release writes to the
// run differs from what this build writes for the same request.

/** Rewrite one stored run in place. */
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

/** Rewrite one stored proposal in place. */
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

// What this build's `bumpRun` writes about the run's writers, and the older
// build's carries unchanged from the run it read.
const WRITER_FIELDS = ['revision_written_by', 'latest_unattributed_revision'];

/** The stored run with its writer fields as they were in `before`. */
const carriedFrom = before => run => {
  const written = { ...run };
  for (const field of WRITER_FIELDS) {
    if (Object.hasOwn(before, field)) written[field] = before[field];
    else delete written[field];
  }
  return written;
};

/** A write in exactly the older build's `bumpRun` shape, with no changes of its own. */
const olderBuildBump = run => ({ ...run, revision: run.revision + 1, updated_at: new Date().toISOString() });

/**
 * The stored run as a build that never kept the writer fields leaves it: none
 * of them at all. Every run on the record when this build is first deployed
 * is such a run.
 */
const legacy = run => {
  const written = { ...run };
  for (const field of WRITER_FIELDS) delete written[field];
  return written;
};

/** A service over the same store, as after a restart or a redeploy. */
const reopened = directory => createStudioApplication({ dataDirectory: directory, durability: 'persistent' });

/**
 * The older build's retry of an accepted final-reduction proposal, stopped
 * inside the run: by a fault thrown before the reduction's effect, after which
 * that build's own phase 3 records the conflict and pins the run's revision as
 * it reads it; or by its process dying after the effect, which records nothing.
 */
async function olderBuildRetry(directory, context, proposal, stop) {
  const projectId = context.fixture.projectId;
  const runId = context.run.run_id;
  const before = await storedRunOf(directory, runId);
  let reached;
  const died = new Promise(resolve => { reached = resolve; });
  const older = createStudioApplication({
    dataDirectory: directory,
    durability: 'persistent',
    runHooks: stop === 'fault'
      ? { beforeEffect: ({ step }) => { if (step === RUN_STEP.FINAL_REDUCTION) throw Error('the older build stopped before the effect'); } }
      : { afterEffect: ({ step }) => { if (step === RUN_STEP.FINAL_REDUCTION) { reached(); return new Promise(() => {}); } } },
  });
  const { application } = (await older.getProposal(OWNER, projectId, proposal.proposal_id)).proposal;
  const plan = (await older.planFinalReduction(OWNER, projectId, { candidateId: context.run.candidate_id, decisions: REDUCTION_DECISIONS, acceptedBy: RUN_REVIEWER })).reduction.plan;
  const call = older.resumeRun(OWNER, projectId, runId, {
    final_reduction: { decisions: REDUCTION_DECISIONS, expected_plan_id: plan.id, accepted_by: RUN_REVIEWER, instrument_profile: null },
    idempotency_key: application.idempotency_key,
    expected_run_revision: application.expected_run_revision,
  }).then(() => ({ settled: 'applied' }), error => ({ settled: 'failed', error }));
  const outcome = await Promise.race([call, died.then(() => ({ settled: 'died' }))]);
  if (stop === 'fault') {
    assert.equal(outcome.settled, 'failed', `the older build's retry must be stopped inside the run, got ${outcome.settled}`);
    assert.match(String(outcome.error.message), /older build stopped before the effect/, `the older build's retry must reach the run, got ${outcome.error.code}: ${outcome.error.message}`);
  } else {
    assert.equal(outcome.settled, 'died', `the older build's retry must reach the run and die there, got ${outcome.settled}: ${outcome.error?.code} ${outcome.error?.message}`);
  }

  await rewriteStoredRun(directory, runId, carriedFrom(before));
  const after = await storedRunOf(directory, runId);
  assert.ok(after.revision > before.revision, 'the older build\'s retry wrote to the run');
  if (stop === 'fault') {
    // That build's phase 3 after a failure: the conflict, what it derived, and
    // `run_revision_at_attempt ?? runNow.revision`. No admission, which it
    // does not know.
    const at = new Date().toISOString();
    await rewriteStoredProposal(directory, proposal.proposal_id, stored => {
      stored.revision += 1;
      stored.updated_at = at;
      stored.application = {
        ...stored.application,
        conflict: { code: outcome.error.code ?? 'INVALID_REQUEST', message: String(outcome.error.message).slice(0, 500), details: outcome.error.details ?? {}, at },
        derived: { reduction_plan_id: plan.id, proposed_plan_id: stored.action.expected_plan_id, plan_accepted_by: stored.action.plan_accepted_by },
        run_revision_at_attempt: stored.application.run_revision_at_attempt ?? after.revision,
      };
    });
  }
  return { before, after };
}

test('an acceptance an older build\'s retry applied to the run cannot be withdrawn after rolling forward, whatever writes the run after it', async () => {
  // The older build's retry reaches the run and is interrupted: by a thrown
  // fault, or by its process dying. Rolled forward, the proposal is taken back
  // at once, or after a reviewer's resume through this build -- a write that
  // records its own writer, on top of the older build's writes that record
  // none. Either way the acceptance's application may be on the run, and the
  // marker (`false`: the older build records no admission) cannot say
  // otherwise.
  const variants = [
    { stop: 'fault', then: null },
    { stop: 'death', then: null },
    { stop: 'fault', then: 'resume' },
    { stop: 'death', then: 'resume' },
  ];
  for (const { stop, then } of variants) {
    const label = then ? `${stop}, then a reviewer's resume through this build` : stop;
    await withDirectory(async directory => {
      const { app, fault } = translationFaulted({ dataDirectory: directory, durability: 'persistent' });
      const context = await runAwaitingReduction(app);
      const projectId = context.fixture.projectId;
      const submitted = (await proposeReduction(app, context, { decisions: REDUCTION_DECISIONS })).proposal;
      fault.armed = true;
      const first = await accept(app, context, submitted.proposal_id);
      assert.equal(first.ok, false, label);
      assert.equal(first.error.details.run_resume_called, false, `${label}: this build's attempt stopped before the run`);
      const acceptedAt = (await app.getProposal(OWNER, projectId, submitted.proposal_id)).proposal.application.expected_run_revision;
      assert.equal(acceptedAt, context.run.revision, label);

      // Rolled back: the older build's retry of the acceptance reaches the run.
      const { after } = await olderBuildRetry(directory, context, submitted, stop);

      // Rolled forward.
      const forward = reopened(directory);
      if (then === 'resume') {
        const resumed = await forward.resumeRun(OWNER, projectId, context.run.run_id, {});
        assert.ok(resumed.run.revision > after.revision, `${label}: the reviewer's resume wrote to the run`);
        const stored = await storedRunOf(directory, context.run.run_id);
        assert.equal(stored.revision_written_by?.revision, stored.revision, `${label}: and that write records its own writer`);
        if (stop === 'death') {
          assert.notEqual(resumed.run.candidate_id, context.run.candidate_id, `${label}: the reviewer's resume adopted what the older build's application minted`);
        }
      }
      const mid = (await forward.getProposal(OWNER, projectId, submitted.proposal_id)).proposal;
      assert.equal(mid.state, PROPOSAL_STATE.ACCEPTED, label);
      assert.equal(mid.application.run_resume_called, false, `${label}: the older build recorded no admission`);
      const runBefore = await storedRunOf(directory, context.run.run_id);

      for (const resolution of ['withdraw', 'reject']) {
        const taken = await forward.resolveProposal(OWNER, projectId, submitted.proposal_id, { resolution, reason: 'Taking it back after rolling forward.' })
          .then(result => ({ ok: true, result }), error => ({ ok: false, error }));
        assert.equal(taken.ok, false, `${label}: ${resolution} must be refused, got ${taken.result?.proposal?.state}: ${taken.result?.notice}`);
        assert.equal(taken.error.code, 'PROPOSAL_CONFLICT', `${label}: ${taken.error.code}: ${taken.error.message}`);
        assert.equal(taken.error.details.run_resume_called, false, label);
        assert.equal(taken.error.details.run_revision_at_acceptance, acceptedAt, label);
        assert.equal(taken.error.details.unattributed_run_revision, after.revision, `${label}: the refusal names the older build's latest write`);
        assert.match(taken.error.message, /does not record which request made it/, label);
      }
      const refused = (await forward.getProposal(OWNER, projectId, submitted.proposal_id)).proposal;
      assert.equal(refused.state, PROPOSAL_STATE.ACCEPTED, `${label}: still accepted`);
      assert.equal(refused.revision, mid.revision, `${label}: and the refusals wrote nothing`);

      // Its retry is graded again, since the marker is false, and refused: the
      // run has moved since the acceptance. That leaves it accepted and open,
      // the cost of a write nothing can attribute.
      const retry = await accept(forward, context, submitted.proposal_id);
      assert.equal(retry.ok, false, label);
      assert.equal(retry.error.code, 'PROPOSAL_REFUSED', `${label}: ${retry.error.code}: ${retry.error.message}`);
      assert.equal(retry.error.details.agent_review.verdict, AGENT_REVIEW.STALE, label);
      const runAfter = await storedRunOf(directory, context.run.run_id);
      assert.equal(runAfter.revision, runBefore.revision, `${label}: nothing here touched the run`);
      await assert.rejects(
        forward.resolveProposal(OWNER, projectId, submitted.proposal_id, { resolution: 'withdraw', reason: 'After the refused retry.' }),
        error => error.code === 'PROPOSAL_CONFLICT',
        `${label}: nor does a refused retry make it withdrawable`,
      );
    });
  }
});

test('any write by the older build after the acceptance keeps it from being withdrawn, and writes by this build after that do not hide it', async () => {
  // Nothing on the run names the request an older build's write was made for,
  // so any such write after the acceptance -- its retry of this acceptance, or
  // a reviewer's resume through it -- keeps the acceptance from being taken
  // back. That is the cost of the rule, in the refusing direction. The writes
  // after it are this build's and each records its own writer; the older
  // build's write must still count.
  const variants = {
    'one older write': [olderBuildBump],
    'one older write, then a reviewer\'s resume through this build': [olderBuildBump, 'resume'],
    'one older write, then two resumes through this build': [olderBuildBump, 'resume', 'resume'],
    'this build, the older build, this build': ['resume', olderBuildBump, 'resume'],
  };
  for (const [label, writes] of Object.entries(variants)) {
    await withDirectory(async directory => {
      const { app, fault } = translationFaulted({ dataDirectory: directory, durability: 'persistent' });
      const context = await runAwaitingReduction(app);
      const projectId = context.fixture.projectId;
      const submitted = (await proposeReduction(app, context, { decisions: REDUCTION_DECISIONS })).proposal;
      fault.armed = true;
      const first = await accept(app, context, submitted.proposal_id);
      assert.equal(first.error?.details?.run_resume_called, false, `${label}: nothing of the acceptance reached the run`);

      for (const write of writes) {
        if (write === 'resume') await reopened(directory).resumeRun(OWNER, projectId, context.run.run_id, {});
        else await rewriteStoredRun(directory, context.run.run_id, write);
      }
      const forward = reopened(directory);
      await assert.rejects(
        forward.resolveProposal(OWNER, projectId, submitted.proposal_id, { resolution: 'withdraw', reason: 'Taking it back.' }),
        error => {
          assert.equal(error.code, 'PROPOSAL_CONFLICT', `${label}: ${error.code}: ${error.message}`);
          assert.equal(error.details.run_resume_called, false, label);
          assert.match(error.message, /does not record which request made it/, label);
          return true;
        },
        label,
      );
      assert.equal((await forward.getProposal(OWNER, projectId, submitted.proposal_id)).proposal.state, PROPOSAL_STATE.ACCEPTED, label);
    });
  }
});

// Whether a write since the acceptance recorded no writer is read from two
// places: the writer record, which speaks for the run's current revision
// alone, and which a run kept before the field existed does not carry at all;
// and `latest_unattributed_revision`, which may already hold a revision from
// before the acceptance. The two tests below start from each of those states,
// which the tests above never do, and put the older build's write after the
// acceptance.

/**
 * Write one step to the run, and answer the run's revision after it when the
 * older build made it (null otherwise). The steps, by name:
 *
 *   * 'resume': a reviewer's plain resume through this build, which records
 *     its own writer;
 *   * 'older write': a bare write in the older build's `bumpRun` shape;
 *   * 'older retry, fault' and 'older retry, death': the older build's retry
 *     of the acceptance, stopped inside the run (`olderBuildRetry`);
 *   * 'legacy': the writer fields removed, as on a run kept before they
 *     existed. It writes no revision.
 */
async function writeToRun(directory, context, step, proposal = null) {
  const runId = context.run.run_id;
  if (step === 'resume') {
    const resumed = await reopened(directory).resumeRun(OWNER, context.fixture.projectId, runId, {});
    const stored = await storedRunOf(directory, runId);
    assert.equal(stored.revision, resumed.run.revision);
    assert.equal(stored.revision_written_by?.revision, stored.revision, 'a resume through this build records its own writer');
    return null;
  }
  if (step === 'legacy') {
    await rewriteStoredRun(directory, runId, legacy);
    return null;
  }
  if (step === 'older write') await rewriteStoredRun(directory, runId, olderBuildBump);
  else if (step === 'older retry, fault') await olderBuildRetry(directory, context, proposal, 'fault');
  else if (step === 'older retry, death') await olderBuildRetry(directory, context, proposal, 'death');
  else assert.fail(`no such step: ${step}`);
  return (await storedRunOf(directory, runId)).revision;
}

/**
 * A run awaiting its reduction, with the given steps written to it, and then
 * a proposal accepted on it whose first attempt stopped before the run.
 */
async function acceptedShortOfTheRun(directory, before) {
  const started = await runAwaitingReduction(reopened(directory));
  for (const step of before) await writeToRun(directory, started, step);
  const { app, fault } = translationFaulted({ dataDirectory: directory, durability: 'persistent' });
  const run = await runOf(app, started);
  const targets = await app.proposalTargets(OWNER, started.fixture.projectId, run.run_id);
  const context = { ...started, run, target: targets.targets.find(entry => entry.code === 'REDUCTION_DECISIONS_REQUIRED') };
  const submitted = (await proposeReduction(app, context, { decisions: REDUCTION_DECISIONS })).proposal;
  fault.armed = true;
  const first = await accept(app, context, submitted.proposal_id);
  assert.equal(first.ok, false);
  assert.equal(first.error.details.run_resume_called, false, 'this build\'s attempt stopped before the run');
  const acceptedAt = (await app.getProposal(OWNER, context.fixture.projectId, submitted.proposal_id)).proposal.application.expected_run_revision;
  assert.equal(acceptedAt, run.revision);
  const atAcceptance = await storedRunOf(directory, run.run_id);
  assert.equal(atAcceptance.revision, acceptedAt, 'the acceptance wrote nothing to the run');
  return { context, submitted, acceptedAt, atAcceptance };
}

/**
 * Rolled forward: the acceptance can be neither rejected nor withdrawn, each
 * refusal names the older build's latest write and the revision the
 * acceptance observed, and nothing is written; its retry is graded by the
 * policy again and refused as STALE, touching nothing; and after that it
 * still cannot be withdrawn.
 */
async function assertNotTakenBack(directory, { context, submitted, acceptedAt }, unattributed) {
  const projectId = context.fixture.projectId;
  const forward = reopened(directory);
  const mid = (await forward.getProposal(OWNER, projectId, submitted.proposal_id)).proposal;
  assert.equal(mid.state, PROPOSAL_STATE.ACCEPTED);
  assert.equal(mid.application.run_resume_called, false, 'the older build recorded no admission');
  const runBefore = await storedRunOf(directory, context.run.run_id);

  for (const resolution of ['withdraw', 'reject']) {
    const taken = await forward.resolveProposal(OWNER, projectId, submitted.proposal_id, { resolution, reason: 'Taking it back after rolling forward.' })
      .then(result => ({ ok: true, result }), error => ({ ok: false, error }));
    assert.equal(taken.ok, false, `${resolution} must be refused, got ${taken.result?.proposal?.state}: ${taken.result?.notice}`);
    assert.equal(taken.error.code, 'PROPOSAL_CONFLICT', `${resolution}: ${taken.error.code}: ${taken.error.message}`);
    assert.equal(taken.error.details.run_resume_called, false, resolution);
    assert.equal(taken.error.details.run_revision_at_acceptance, acceptedAt, resolution);
    assert.equal(taken.error.details.unattributed_run_revision, unattributed, `${resolution}: the refusal names the older build's latest write`);
    assert.match(taken.error.message, /does not record which request made it/, resolution);
  }
  const refused = (await forward.getProposal(OWNER, projectId, submitted.proposal_id)).proposal;
  assert.equal(refused.state, PROPOSAL_STATE.ACCEPTED, 'still accepted');
  assert.equal(refused.revision, mid.revision, 'and the refusals wrote nothing');

  const retry = await accept(forward, context, submitted.proposal_id);
  assert.equal(retry.ok, false, 'the retry must be refused');
  assert.equal(retry.error.code, 'PROPOSAL_REFUSED', `${retry.error.code}: ${retry.error.message}`);
  assert.equal(retry.error.details.agent_review.verdict, AGENT_REVIEW.STALE);
  assert.equal((await storedRunOf(directory, context.run.run_id)).revision, runBefore.revision, 'nothing here touched the run');
  await assert.rejects(
    forward.resolveProposal(OWNER, projectId, submitted.proposal_id, { resolution: 'withdraw', reason: 'After the refused retry.' }),
    error => error.code === 'PROPOSAL_CONFLICT',
    'nor does a refused retry make it withdrawable',
  );
}

test('on a run kept before the writer record existed, an older build\'s write after the acceptance keeps it from being withdrawn', async t => {
  // Every run on the record when this build is first deployed was last written
  // by the release before it, so it carries no writer record at all: not the
  // record of an earlier revision, but none. Rolled back after an acceptance,
  // that release's writes add none. A missing record names no writer, so each
  // of those writes is one the run cannot attribute, exactly as on a run this
  // build started; read as an attributed write, it would let an acceptance
  // that release applied be withdrawn.
  const variants = {
    'a bare write by the older build': ['older write'],
    'the older build\'s retry, stopped by a fault': ['older retry, fault'],
    'the older build\'s retry, stopped by its process dying': ['older retry, death'],
    'the older build\'s retry, stopped by its process dying, then a reviewer\'s resume through this build': ['older retry, death', 'resume'],
  };
  for (const [label, after] of Object.entries(variants)) {
    await t.test(label, () => withDirectory(async directory => {
      const accepted = await acceptedShortOfTheRun(directory, ['legacy']);
      for (const field of WRITER_FIELDS) {
        assert.equal(Object.hasOwn(accepted.atAcceptance, field), false, `the run the acceptance observed has no ${field}`);
      }
      let unattributed = null;
      for (const step of after) unattributed = (await writeToRun(directory, accepted.context, step, accepted.submitted)) ?? unattributed;
      assert.ok(unattributed > accepted.acceptedAt, 'the older build wrote after the acceptance');
      const stored = await storedRunOf(directory, accepted.context.run.run_id);
      if (after.at(-1) === 'resume') {
        assert.notEqual(stored.candidate_id, accepted.context.run.candidate_id, 'the reviewer\'s resume adopted what the older build\'s application minted');
      } else {
        assert.equal(Object.hasOwn(stored, 'revision_written_by'), false, 'and recorded no writer');
      }
      await assertNotTakenBack(directory, accepted, unattributed);
    }));
  }
});

test('a write the run could not attribute before the acceptance does not hide an older build\'s write after it', async t => {
  // Once this build has written over a write it could not attribute, the run
  // keeps that write's revision in `latest_unattributed_revision`, so the
  // acceptance finds one there already, below the revision it observed, and
  // rightly not counted. The older build's write after the acceptance is the
  // one that counts. The run must answer with the later of the two, not with
  // the one it already kept, both straight after that write and once this
  // build has written over it in turn.
  const before = {
    'an older build\'s write, then a resume through this build': ['older write', 'resume'],
    'a run kept before the writer record existed, then a resume through this build': ['legacy', 'resume'],
  };
  const after = {
    'a bare write by the older build': ['older write'],
    'a bare write by the older build, then a resume through this build': ['older write', 'resume'],
    'the older build\'s retry, stopped by a fault': ['older retry, fault'],
    'the older build\'s retry, stopped by its process dying': ['older retry, death'],
    'the older build\'s retry, stopped by its process dying, then a resume through this build': ['older retry, death', 'resume'],
  };
  for (const [earlierLabel, earlier] of Object.entries(before)) {
    for (const [laterLabel, later] of Object.entries(after)) {
      await t.test(`${earlierLabel}; accepted; ${laterLabel}`, () => withDirectory(async directory => {
        const accepted = await acceptedShortOfTheRun(directory, earlier);
        const kept = accepted.atAcceptance.latest_unattributed_revision;
        assert.ok(Number.isInteger(kept) && kept < accepted.acceptedAt, `the run kept a revision from before the acceptance that it could not attribute, got ${kept}`);
        assert.equal(accepted.atAcceptance.revision_written_by?.revision, accepted.acceptedAt, 'and this build wrote the revision the acceptance observed');
        let unattributed = null;
        for (const step of later) unattributed = (await writeToRun(directory, accepted.context, step, accepted.submitted)) ?? unattributed;
        assert.ok(unattributed > accepted.acceptedAt, 'the older build wrote after the acceptance');
        await assertNotTakenBack(directory, accepted, unattributed);
      }));
    }
  }
});

test('an older build\'s write the acceptance already saw does not keep an acceptance that never reached the run from being withdrawn', async () => {
  // A write the acceptance observed was made before it and is no part of its
  // application. Refusing every acceptance on a run an older build ever wrote
  // would be simpler, and would take away the withdrawal that exists for an
  // acceptance nothing of which reached the run.
  const variants = {
    'nothing but this build': { before: [], after: [] },
    'a reviewer\'s resume through this build after the acceptance': { before: [], after: ['resume'] },
    'the older build wrote last before the acceptance': { before: [olderBuildBump], after: [] },
    'the older build, then this build, before the acceptance': { before: [olderBuildBump, 'resume'], after: [] },
    'a run record kept before the writer record existed': { before: [legacy], after: [] },
    'a run record kept before the writer record existed, then a reviewer\'s resume through this build after the acceptance': { before: [legacy], after: ['resume'] },
  };
  const write = async (directory, context, step) => {
    if (step === 'resume') await reopened(directory).resumeRun(OWNER, context.fixture.projectId, context.run.run_id, {});
    else await rewriteStoredRun(directory, context.run.run_id, step);
  };
  for (const [label, { before, after }] of Object.entries(variants)) {
    await withDirectory(async directory => {
      const started = await runAwaitingReduction(reopened(directory));
      for (const step of before) await write(directory, started, step);

      // The run as the acceptance observes it, and its request as it now stands.
      const { app, fault } = translationFaulted({ dataDirectory: directory, durability: 'persistent' });
      const run = await runOf(app, started);
      const targets = await app.proposalTargets(OWNER, started.fixture.projectId, run.run_id);
      const context = { ...started, run, target: targets.targets.find(entry => entry.code === 'REDUCTION_DECISIONS_REQUIRED') };
      const submitted = (await proposeReduction(app, context, { decisions: REDUCTION_DECISIONS })).proposal;
      fault.armed = true;
      const first = await accept(app, context, submitted.proposal_id);
      assert.equal(first.ok, false, label);
      assert.equal(first.error.details.run_resume_called, false, `${label}: nothing reached the run`);
      for (const step of after) await write(directory, context, step);

      const withdrawn = await reopened(directory).resolveProposal(OWNER, context.fixture.projectId, submitted.proposal_id, { resolution: 'withdraw', reason: 'Nothing of it reached the run.' })
        .then(result => ({ ok: true, result }), error => ({ ok: false, error }));
      assert.ok(withdrawn.ok, `${label}: the withdrawal must stand, got ${withdrawn.error?.code}: ${withdrawn.error?.message}`);
      assert.equal(withdrawn.result.proposal.state, PROPOSAL_STATE.WITHDRAWN, label);
      assert.match(withdrawn.result.notice, /never reached the run/, label);
    });
  }
});

test('the open-proposal cap does not count an acceptance an older build may have applied as one that can be withdrawn', async () => {
  await withDirectory(async directory => {
    const app = reopened(directory);
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
    // As in the cap test above, the states are written directly: every open
    // proposal accepted and admitted, but one whose marker says the run
    // admitted none of its attempts.
    const at = new Date().toISOString();
    for (const name of await readdir(join(directory, 'records'))) {
      const path = join(directory, 'records', name);
      const body = await readFile(path, 'utf8');
      if (!body.includes(ids[0])) continue;
      const record = JSON.parse(body);
      for (const entry of record.proposals) {
        entry.state = PROPOSAL_STATE.ACCEPTED;
        entry.resolution = { resolution: 'accept', resolved_by: OWNER, accepted_by: RUN_REVIEWER, reason: null, at };
        entry.application = {
          idempotency_key: `proposal:${entry.proposal_id}:${entry.revision}`, expected_run_revision: started.run.revision, run_revision_at_attempt: null,
          run_resume_called: entry.proposal_id !== ids[0], accepted_by: RUN_REVIEWER, attempted_at: at,
          run_revision_after: null, run_state_after: null, candidate_id_after: null, derived: {},
          conflict: { code: 'RUN_CONFLICT', message: 'fixture', details: {}, at },
        };
      }
      await writeFile(path, JSON.stringify(record));
    }
    await assert.rejects(reopened(directory).proposeDecision(OWNER, fixture.projectId, describe(998)), error => {
      assert.equal(error.code, 'STORAGE_FULL');
      assert.equal(error.details.withdrawable_open_proposals, 1, 'nothing has written to the run since that acceptance');
      return true;
    });

    // Rolled back and forward: the older build wrote to the run after it.
    await rewriteStoredRun(directory, started.run.run_id, olderBuildBump);
    const forward = reopened(directory);
    await assert.rejects(forward.proposeDecision(OWNER, fixture.projectId, describe(999)), error => {
      assert.equal(error.code, 'STORAGE_FULL');
      assert.equal(error.details.withdrawable_open_proposals, 0);
      assert.match(error.message, /none of them can be rejected or withdrawn/);
      return true;
    });
    await assert.rejects(
      forward.resolveProposal(OWNER, fixture.projectId, ids[0], { resolution: 'withdraw', reason: 'Freeing a slot.' }),
      error => error.code === 'PROPOSAL_CONFLICT',
      'and the withdrawal the count no longer offers is refused',
    );
  });
});
