// The AI Proposal Protocol — what a proposal does, and what it does not.
//
// The whole protocol rests on one asymmetry: submitting a proposal is free and
// changes nothing, and accepting one is an explicit act that goes through the
// operation that already exists. These regressions pin both halves, with the
// real Canonical engines, the real G11-C suggestion, the real G11-D
// application and the real readiness modules — no mock stands in anywhere.
//
// The most important test in this file is the last one. If the accepted-
// proposal path and the manual path ever produce different candidate ids for
// the same decisions, then the proposal layer has grown a second mutation
// engine, and every other guarantee here is about the wrong object.

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  AGENT_REVIEW,
  PROPOSAL_KIND,
  PROPOSAL_STATE,
  RUN_STATE,
  createStudioApplication,
} from '../backend/application/index.mjs';
import { FIXTURE_CONFIRMATIONS, RUN_REVIEWER, projectWithSymbolicAsset, runDecisionsFor } from './fixtures/run-fixtures.mjs';

const OWNER = 'owner:proposal-protocol';
const AGENT = 'some-external-agent';

/** What a proposal may carry: never the reviewer, never a note inside the acceptance. */
const proposable = project => runDecisionsFor(project, {}).map(({ acceptedBy, note, ...rest }) => rest);

/** A run stopped at ARRANGEMENT_DECISIONS_REQUIRED, with the target it exposes. */
async function runAwaitingDecisions(app, owner = OWNER) {
  const fixture = await projectWithSymbolicAsset(app, owner);
  const started = await app.startRun(owner, fixture.projectId, { asset_ids: [fixture.assetId] });
  assert.equal(started.run.state, RUN_STATE.AWAITING_REVIEW);
  const targets = await app.proposalTargets(owner, fixture.projectId, started.run.run_id);
  const target = targets.targets.find(entry => entry.admissible_kinds.includes(PROPOSAL_KIND.ARRANGEMENT_DECISION));
  assert.ok(target, 'the run must expose an arrangement decision target');
  const events = await app.listBaselineEvents(owner, fixture.projectId, { limit: 3 });
  return { fixture, run: started.run, targets, target, eventIds: events.events.map(entry => entry.event_id) };
}

const arrangementProposal = (context, overrides = {}) => ({
  run_id: context.run.run_id,
  request_key: context.target.request_key,
  kind: PROPOSAL_KIND.ARRANGEMENT_DECISION,
  proposed_by: AGENT,
  rationale: 'Every lane is source-supported and keeps its baseline role; nothing is omitted and no Lead move is proposed.',
  action: { decisions: proposable(context.fixture.project) },
  cites: { event_ids: context.eventIds },
  ...overrides,
});

// ─── A. submitting is free, and free means free ─────────────────────────────

test('submitting a proposal changes nothing about the project, the candidate or the run', async () => {
  const app = createStudioApplication({});
  const context = await runAwaitingDecisions(app);
  const before = (await app.getProject(OWNER, context.fixture.projectId)).project;
  const runBefore = (await app.getRun(OWNER, context.fixture.projectId, context.run.run_id)).run;

  const submitted = await app.proposeDecision(OWNER, context.fixture.projectId, arrangementProposal(context));
  assert.equal(submitted.proposal.state, PROPOSAL_STATE.SUBMITTED);
  assert.equal(submitted.applied, false);

  const after = (await app.getProject(OWNER, context.fixture.projectId)).project;
  const runAfter = (await app.getRun(OWNER, context.fixture.projectId, context.run.run_id)).run;

  // Nothing downstream moved, field by field rather than by a single summary.
  assert.deepEqual(after.candidates, before.candidates, 'no candidate was minted');
  assert.deepEqual(after.artifacts, before.artifacts, 'no artifact was produced');
  assert.deepEqual(after.jobs, before.jobs, 'no job ran');
  assert.deepEqual(after.audio_evidence, before.audio_evidence, 'no evidence was attached');
  assert.equal(after.baseline.baseline_id, before.baseline.baseline_id, 'the baseline is untouched');
  assert.equal(runAfter.revision, runBefore.revision, 'the run did not even take a revision');
  assert.equal(runAfter.state, runBefore.state);
  assert.equal(runAfter.candidate_id, runBefore.candidate_id);
  assert.deepEqual(runAfter.steps, runBefore.steps, 'no step ran');
  assert.deepEqual(runAfter.gates, runBefore.gates, 'no gate moved');
  assert.deepEqual(runAfter.readiness_blockers, runBefore.readiness_blockers);
  // The review requests are what a confirmation would have changed, and they
  // are identical -- including the keys an agent addresses them by, so the
  // proposal did not even move the thing it is about.
  assert.deepEqual(runAfter.review_requests, runBefore.review_requests, 'no confirmation was recorded and no request was answered');

  // The proposal itself is the only thing that appeared. The project view
  // carries no proposals by design -- identities and counts, fetched by their
  // own operation -- so this is read where it lives.
  assert.equal((await app.listProposals(OWNER, context.fixture.projectId)).proposals.length, 1);
  assert.equal(submitted.proposal.run_id, context.run.run_id);
});

test('a proposal cannot move a Canonical gate, and cannot reach in_game at all', async () => {
  const app = createStudioApplication({});
  const context = await runAwaitingDecisions(app);
  await app.proposeDecision(OWNER, context.fixture.projectId, arrangementProposal(context));

  // Drive the run to a candidate the ordinary way so there are real gates to
  // look at, then confirm the stored proposal moved none of them.
  const resumed = await app.resumeRun(OWNER, context.fixture.projectId, context.run.run_id, {
    decisions: runDecisionsFor(context.fixture.project, { acceptedBy: RUN_REVIEWER }),
  });
  const review = await app.reviewCandidate(OWNER, context.fixture.projectId, { candidateId: resumed.run.candidate_id });
  assert.equal(review.review.gates.in_game, 'PENDING', 'in_game is never set by this service');

  // And no proposal of any class may even name the gate axes: the only class a
  // readiness gate request admits is the one that applies nothing.
  const targets = await app.proposalTargets(OWNER, context.fixture.projectId, context.run.run_id);
  const gateTargets = targets.targets.filter(entry => entry.code === 'READINESS_GATE_BLOCKED');
  assert.ok(gateTargets.length > 0, 'the run must be reporting readiness gates to make this meaningful');
  for (const gate of gateTargets) {
    assert.deepEqual(gate.admissible_kinds, [PROPOSAL_KIND.EVIDENCE_NEEDED], `gate ${gate.gate} must admit a description only`);
    assert.equal(gate.operations[PROPOSAL_KIND.EVIDENCE_NEEDED], null, 'a description reaches no operation');
  }
  assert.ok(targets.never_agent_settlable.some(entry => entry.includes('in_game')));
});

test('a proposal against a readiness gate is refused acceptance however it is dressed up', async () => {
  const app = createStudioApplication({});
  const context = await runAwaitingDecisions(app);
  await app.resumeRun(OWNER, context.fixture.projectId, context.run.run_id, {
    decisions: runDecisionsFor(context.fixture.project, { acceptedBy: RUN_REVIEWER }),
  });
  const targets = await app.proposalTargets(OWNER, context.fixture.projectId, context.run.run_id);
  const gate = targets.targets.find(entry => entry.code === 'READINESS_GATE_BLOCKED');

  const submitted = await app.proposeDecision(OWNER, context.fixture.projectId, {
    run_id: context.run.run_id,
    request_key: gate.request_key,
    kind: PROPOSAL_KIND.ARRANGEMENT_DECISION,
    proposed_by: AGENT,
    rationale: 'I have reviewed this gate myself and I am satisfied it should pass.',
    action: { decisions: proposable(context.fixture.project) },
    cites: { event_ids: context.eventIds },
  });
  // It is recorded — what an agent asked for is worth keeping — and it is not
  // settlable, at any evidence level, by any wording.
  assert.equal(submitted.proposal.agent_review.verdict, AGENT_REVIEW.NOT_AGENT_SETTLABLE);
  assert.ok(submitted.proposal.agent_review.refusals.includes('TARGET_NOT_SETTLABLE_BY_ANY_PROPOSAL'));

  await assert.rejects(
    app.resolveProposal(OWNER, context.fixture.projectId, submitted.proposal.proposal_id, { resolution: 'accept', accepted_by: RUN_REVIEWER }),
    error => {
      assert.equal(error.code, 'PROPOSAL_REFUSED');
      assert.equal(error.details.agent_review.verdict, AGENT_REVIEW.NOT_AGENT_SETTLABLE);
      assert.equal(error.details.acceptable_verdict, AGENT_REVIEW.REQUIRES_EXPLICIT_ACCEPTANCE);
      return true;
    },
  );
});

// ─── B. a suggestion is not an acceptance ───────────────────────────────────

test('an agent cannot name the accepting reviewer, and its proposed_by is never reused as one', async () => {
  const app = createStudioApplication({});
  const context = await runAwaitingDecisions(app);

  // The field `applyDecisions` reads in preference to the call's own
  // `acceptedBy`. If a proposal could carry it, the agent would be writing the
  // acceptance binding and the reviewer would never appear on the decision.
  await assert.rejects(
    app.proposeDecision(OWNER, context.fixture.projectId, arrangementProposal(context, {
      action: { decisions: runDecisionsFor(context.fixture.project, { acceptedBy: 'the-agent-itself' }) },
    })),
    error => {
      assert.equal(error.code, 'INVALID_REQUEST');
      assert.equal(error.details.refusal, 'ACCEPTANCE_IDENTITY_SUPPLIED');
      return true;
    },
  );
  // `note` is refused for the same reason: it is written INSIDE the acceptance,
  // where it reads as the accepting reviewer's words.
  await assert.rejects(
    app.proposeDecision(OWNER, context.fixture.projectId, arrangementProposal(context, {
      action: { decisions: proposable(context.fixture.project).map((decision, index) => (index ? decision : { ...decision, note: 'accepted after review' })) },
    })),
    error => error.details.refusal === 'ACCEPTANCE_IDENTITY_SUPPLIED',
  );

  // Accepting without naming a reviewer is refused too: the agent's own label
  // is not a fallback.
  const submitted = await app.proposeDecision(OWNER, context.fixture.projectId, arrangementProposal(context));
  await assert.rejects(
    app.resolveProposal(OWNER, context.fixture.projectId, submitted.proposal.proposal_id, { resolution: 'accept' }),
    error => error.code === 'INVALID_REQUEST' && /accepted_by/.test(error.message),
  );

  // Accepted properly, the decision carries the REVIEWER, not the agent.
  const resolved = await app.resolveProposal(OWNER, context.fixture.projectId, submitted.proposal.proposal_id, {
    resolution: 'accept', accepted_by: RUN_REVIEWER,
  });
  const candidate = (await app.getProject(OWNER, context.fixture.projectId)).project.candidates.find(entry => entry.candidate_id === resolved.run.candidate_id);
  assert.deepEqual(candidate.accepted_by, [RUN_REVIEWER], 'the acceptance binding names the reviewer who accepted');
  assert.ok(!JSON.stringify(candidate.accepted_by).includes(AGENT), 'the agent never appears as an acceptor');
  assert.equal(resolved.proposal.proposed_by, AGENT, 'and the agent is still on the record as the proposer');
  assert.equal(resolved.proposal.resolution.accepted_by, RUN_REVIEWER);
  assert.equal(resolved.proposal.submitted_by, OWNER);
});

test('a proposal that admits it lacks evidence is not overruled into having enough', async () => {
  const app = createStudioApplication({});
  const context = await runAwaitingDecisions(app);

  // PENDING is a legitimate result, and this is where that is true in code.
  const thin = await app.proposeDecision(OWNER, context.fixture.projectId, arrangementProposal(context, {
    missing_evidence: ['The score for bars 17-24 has not been read, so the inner-voice role is not established.'],
  }));
  assert.equal(thin.proposal.agent_review.verdict, AGENT_REVIEW.REQUIRES_MORE_EVIDENCE);
  assert.ok(thin.proposal.agent_review.refusals.includes('MISSING_EVIDENCE_DECLARED'));
  await assert.rejects(
    app.resolveProposal(OWNER, context.fixture.projectId, thin.proposal.proposal_id, { resolution: 'accept', accepted_by: RUN_REVIEWER }),
    error => error.code === 'PROPOSAL_REFUSED',
  );

  // Two authorities disagreeing is the same answer. MASTER_RULES.md §0: do not
  // guess; record the conflict.
  const conflicted = await app.proposeDecision(OWNER, context.fixture.projectId, arrangementProposal(context, {
    unresolved_conflicts: [{ summary: 'The official score puts this line in the left hand; the recording puts it forward in the mix.', truth_classes: ['symbolic', 'audio'] }],
  }));
  assert.equal(conflicted.proposal.agent_review.verdict, AGENT_REVIEW.REQUIRES_MORE_EVIDENCE);
  assert.ok(conflicted.proposal.agent_review.refusals.includes('UNRESOLVED_CONFLICT_DECLARED'));

  // A mutating class with nothing this service can resolve is the same answer
  // again: a proposal does not become evidence by being detailed.
  const uncited = await app.proposeDecision(OWNER, context.fixture.projectId, arrangementProposal(context, { cites: {} }));
  assert.equal(uncited.proposal.agent_review.verdict, AGENT_REVIEW.REQUIRES_MORE_EVIDENCE);
  assert.ok(uncited.proposal.agent_review.refusals.includes('NO_VERIFIABLE_CITATION'));
});

test('an evidence-needed proposal is a complete answer that still applies nothing', async () => {
  const app = createStudioApplication({});
  const context = await runAwaitingDecisions(app);
  const runBefore = (await app.getRun(OWNER, context.fixture.projectId, context.run.run_id)).run;

  const submitted = await app.proposeDecision(OWNER, context.fixture.projectId, {
    run_id: context.run.run_id,
    request_key: context.target.request_key,
    kind: PROPOSAL_KIND.EVIDENCE_NEEDED,
    proposed_by: AGENT,
    rationale: 'The lane roles cannot be settled from the material loaded: the piano top line and the vocal overlap for the whole first section.',
    missing_evidence: ['An official score or MusicXML covering bars 1-16, to establish which line carries the Lead.'],
  });
  // Complete, not incomplete: it escapes the evidence rung deliberately.
  assert.equal(submitted.proposal.agent_review.verdict, AGENT_REVIEW.PROPOSABLE);
  assert.ok(submitted.proposal.agent_review.refusals.includes('NO_DOWNSTREAM_OPERATION'));
  assert.equal(submitted.proposal.downstream_operation, null);

  // PROPOSABLE is not acceptable: there is nothing to apply, so accepting it
  // would be a state change that stood for no operation.
  await assert.rejects(
    app.resolveProposal(OWNER, context.fixture.projectId, submitted.proposal.proposal_id, { resolution: 'accept', accepted_by: RUN_REVIEWER }),
    error => error.code === 'PROPOSAL_REFUSED' && error.details.agent_review.verdict === AGENT_REVIEW.PROPOSABLE,
  );
  const runAfter = (await app.getRun(OWNER, context.fixture.projectId, context.run.run_id)).run;
  assert.equal(runAfter.revision, runBefore.revision, 'the run is exactly where it was');
});

test('a rejected proposal stays on the record and applies nothing', async () => {
  const app = createStudioApplication({});
  const context = await runAwaitingDecisions(app);
  const submitted = await app.proposeDecision(OWNER, context.fixture.projectId, arrangementProposal(context));
  const runBefore = (await app.getRun(OWNER, context.fixture.projectId, context.run.run_id)).run;

  const rejected = await app.resolveProposal(OWNER, context.fixture.projectId, submitted.proposal.proposal_id, {
    resolution: 'reject', reason: 'The inner voice this omits is source-supported.',
  });
  assert.equal(rejected.proposal.state, PROPOSAL_STATE.REJECTED);
  assert.equal(rejected.applied, false);
  assert.equal(rejected.run, null);
  const runAfter = (await app.getRun(OWNER, context.fixture.projectId, context.run.run_id)).run;
  assert.equal(runAfter.revision, runBefore.revision);
  assert.equal(runAfter.candidate_id, null);

  // A resolved proposal is an audit record, not a workspace.
  await assert.rejects(
    app.resolveProposal(OWNER, context.fixture.projectId, submitted.proposal.proposal_id, { resolution: 'accept', accepted_by: RUN_REVIEWER }),
    error => error.code === 'PROPOSAL_CONFLICT',
  );
  assert.equal((await app.getProposal(OWNER, context.fixture.projectId, submitted.proposal.proposal_id)).proposal.state, PROPOSAL_STATE.REJECTED);
});

// ─── C. acceptance reaches the operation that already exists ────────────────

test('the accepted-proposal path and the manual path produce the same candidate identity', async () => {
  // The property the whole design rests on. If these ever differ, the proposal
  // layer has grown a second mutation engine.
  const manualApp = createStudioApplication({});
  const manual = await runAwaitingDecisions(manualApp, 'owner:manual-path');
  const manualResult = await manualApp.resumeRun('owner:manual-path', manual.fixture.projectId, manual.run.run_id, {
    decisions: runDecisionsFor(manual.fixture.project, { acceptedBy: RUN_REVIEWER }),
  });

  const proposalApp = createStudioApplication({});
  const viaProposal = await runAwaitingDecisions(proposalApp, 'owner:proposal-path');
  const submitted = await proposalApp.proposeDecision('owner:proposal-path', viaProposal.fixture.projectId, {
    run_id: viaProposal.run.run_id,
    request_key: viaProposal.target.request_key,
    kind: PROPOSAL_KIND.ARRANGEMENT_DECISION,
    proposed_by: AGENT,
    rationale: 'Keep every source-supported role.',
    action: { decisions: proposable(viaProposal.fixture.project) },
    cites: { event_ids: viaProposal.eventIds },
  });
  const accepted = await proposalApp.resolveProposal('owner:proposal-path', viaProposal.fixture.projectId, submitted.proposal.proposal_id, {
    resolution: 'accept', accepted_by: RUN_REVIEWER,
  });

  assert.equal(accepted.run.candidate_id, manualResult.run.candidate_id, 'the same decisions must produce the same content-addressed candidate');
  assert.equal(accepted.run.state, manualResult.run.state);
  assert.deepEqual(accepted.run.readiness_blockers, manualResult.run.readiness_blockers);
  assert.deepEqual(accepted.run.gates, manualResult.run.gates);
  assert.equal(accepted.proposal.state, PROPOSAL_STATE.APPLIED);
  assert.equal(accepted.proposal.application.candidate_id_after, manualResult.run.candidate_id);
});

test('an applied proposal is not a succeeded operation, a gate result or a song state', async () => {
  const app = createStudioApplication({});
  const context = await runAwaitingDecisions(app);
  const submitted = await app.proposeDecision(OWNER, context.fixture.projectId, arrangementProposal(context));
  const accepted = await app.resolveProposal(OWNER, context.fixture.projectId, submitted.proposal.proposal_id, {
    resolution: 'accept', accepted_by: RUN_REVIEWER,
  });

  // Applied, and the run is still blocked on the evidence nobody supplied.
  assert.equal(accepted.proposal.state, PROPOSAL_STATE.APPLIED);
  assert.equal(accepted.run.state, RUN_STATE.AWAITING_REVIEW);
  assert.ok(accepted.run.readiness_blockers.length > 0, 'applying decisions did not clear the readiness gates');
  assert.equal(accepted.run.final_artifact_id, null, 'no Final was emitted');
  assert.match(accepted.notice, /not a succeeded operation, not a gate result and not a song state/);
  assert.match(accepted.proposal.separation_notice, /in_game is never set here/);

  const review = await app.reviewCandidate(OWNER, context.fixture.projectId, { candidateId: accepted.run.candidate_id });
  assert.equal(review.review.gates.in_game, 'PENDING');
  assert.equal(review.review.gates.mobile_adaptation, 'PENDING', 'Gate 8 was not answered by an accepted proposal');
  assert.equal(review.review.gates.regression, 'PENDING', 'Gate 9 was not answered by an accepted proposal');
});

test('an accepted proposal lets the run resume to a Final through the ordinary evidence path', async () => {
  // The Definition of Done, end to end: a review request becomes a proposal,
  // an explicit acceptance applies it through the existing operation, and the
  // run then continues on the reviewer's own evidence — which the proposal
  // never supplied and could not have.
  const app = createStudioApplication({});
  const context = await runAwaitingDecisions(app);
  const submitted = await app.proposeDecision(OWNER, context.fixture.projectId, arrangementProposal(context));
  const accepted = await app.resolveProposal(OWNER, context.fixture.projectId, submitted.proposal.proposal_id, {
    resolution: 'accept', accepted_by: RUN_REVIEWER,
  });
  assert.equal(accepted.applied, true);

  const finished = await app.resumeRun(OWNER, context.fixture.projectId, context.run.run_id, { confirmations: FIXTURE_CONFIRMATIONS });
  assert.equal(finished.run.state, RUN_STATE.COMPLETED);
  assert.match(finished.run.final_artifact_id, /^art_[0-9a-f]{64}$/);
  // Completed is not accepted. The run says so itself.
  assert.match(finished.run.separation_notice, /in_game is never set by this service/);
  const review = await app.reviewCandidate(OWNER, context.fixture.projectId, { candidateId: finished.run.candidate_id });
  assert.equal(review.review.gates.in_game, 'PENDING');

  // And the proposal that started it is now stale, because everything it was
  // bound to moved. It is not re-appliable to the run it helped produce.
  const reread = await app.getProposal(OWNER, context.fixture.projectId, submitted.proposal.proposal_id);
  assert.equal(reread.proposal.state, PROPOSAL_STATE.APPLIED);
  assert.equal(reread.proposal.agent_review.verdict, AGENT_REVIEW.STALE);
});
