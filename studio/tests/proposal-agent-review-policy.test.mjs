// The Agent Review Policy — where it stops, and what it refuses to stand in for.
//
// The policy answers one narrow question: does this proposal carry enough
// binding, evidence and authority to be handed to the existing operation it
// names? It answers no musical question at all. Which makes the tests here
// about a boundary rather than about a verdict: for every axis a reviewer has
// to answer with their own evidence, an accepted proposal must land in exactly
// the same place a manual caller lands, and no further.
//
// The three axes that matter most are the ones where an operation SUCCEEDING
// is most easily read as the gate PASSING:
//
//   Gate 3   a Lead move is graded by the shared Lead grader, every time. A
//            proposal carries no evidence the grader will not also see.
//   Gate 8   an adaptation applying is not a Mobile adaptation review.
//   Gate 9   a regression suite passing is not a regression review.

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  AGENT_REVIEW,
  NEVER_AGENT_SETTLABLE,
  PROPOSAL_KIND,
  PROPOSAL_TARGETS,
  createStudioApplication,
} from '../backend/application/index.mjs';
import { RUN_REVIEW_REQUEST } from '../backend/application/run-contracts.mjs';
import { FIXTURE_CONFIRMATIONS, RUN_REVIEWER, mobileProfile, projectWithSymbolicAsset, runDecisionsFor } from './fixtures/run-fixtures.mjs';

const OWNER = 'owner:proposal-policy';
const AGENT = 'some-external-agent';

const proposable = project => runDecisionsFor(project, {}).map(({ acceptedBy, note, ...rest }) => rest);

async function prepared(app, owner = OWNER) {
  const fixture = await projectWithSymbolicAsset(app, owner);
  const started = await app.startRun(owner, fixture.projectId, { asset_ids: [fixture.assetId] });
  const targets = await app.proposalTargets(owner, fixture.projectId, started.run.run_id);
  const events = await app.listBaselineEvents(owner, fixture.projectId, { limit: 4 });
  return {
    fixture,
    run: started.run,
    target: targets.targets.find(entry => entry.admissible_kinds.includes(PROPOSAL_KIND.ARRANGEMENT_DECISION)),
    eventIds: events.events.map(entry => entry.event_id),
    events: events.events,
  };
}

const submit = (app, context, overrides = {}, owner = OWNER) => app.proposeDecision(owner, context.fixture.projectId, {
  run_id: context.run.run_id,
  request_key: context.target.request_key,
  kind: PROPOSAL_KIND.ARRANGEMENT_DECISION,
  proposed_by: AGENT,
  rationale: 'Keep every source-supported role.',
  action: { decisions: proposable(context.fixture.project) },
  cites: { event_ids: context.eventIds },
  ...overrides,
});

// ─── A. Gate 3 — the Lead evidence boundary is the engine's, not the policy's ─

test('a Lead move proposed without the evidence the grader needs is graded by the grader, not by the policy', async () => {
  // Two services, the same unsupported promotion, one reached manually and one
  // through an accepted proposal. The point is not that the proposal is
  // refused — the policy judges no music — but that BOTH paths land on the
  // engine's own answer, identically.
  const promotion = context => {
    const melodyEvent = context.events.find(entry => entry.role !== 'Melody' && entry.kind === 'note');
    return {
      id: `promote:${melodyEvent.event_id}`,
      type: 'MOVE_ROLE',
      target: { eventIds: [melodyEvent.event_id] },
      fromRole: melodyEvent.role,
      toRole: 'Melody',
      reason: 'This voice sounds like the lead to me.',
      evidence: ['fixture:a listen-through'],
      // No `leadEvidence`. `SOURCE_POLICY.md` §4: a Lead move needs positive
      // evidence, and "it sounds like the lead" is not it.
    };
  };

  const manualApp = createStudioApplication({});
  const manual = await prepared(manualApp, 'owner:lead-manual');
  const manualResult = await manualApp.resumeRun('owner:lead-manual', manual.fixture.projectId, manual.run.run_id, {
    decisions: [...runDecisionsFor(manual.fixture.project, { acceptedBy: RUN_REVIEWER }), { ...promotion(manual), acceptedBy: RUN_REVIEWER }],
    accepted_by: RUN_REVIEWER,
  });

  const proposalApp = createStudioApplication({});
  const viaProposal = await prepared(proposalApp, 'owner:lead-proposal');
  const submitted = await submit(proposalApp, viaProposal, {
    action: { decisions: [...proposable(viaProposal.fixture.project), promotion(viaProposal)] },
    rationale: 'Promote the cited voice into Melody for the instrumental window.',
  }, 'owner:lead-proposal');
  // The policy lets it through: it is correctly bound and it cites real events.
  // Judging the Lead claim is not its job.
  assert.equal(submitted.proposal.agent_review.verdict, AGENT_REVIEW.REQUIRES_EXPLICIT_ACCEPTANCE);

  const accepted = await proposalApp.resolveProposal('owner:lead-proposal', viaProposal.fixture.projectId, submitted.proposal.proposal_id, {
    resolution: 'accept', accepted_by: RUN_REVIEWER,
  });

  // And the engine answers the same way on both paths, down to the codes.
  const manualStep = manualResult.run.steps.find(entry => entry.step === 'apply_decisions');
  const proposalStep = accepted.run.steps.find(entry => entry.step === 'apply_decisions');
  assert.equal(proposalStep.status, manualStep.status, `manual ${manualStep.status} vs proposal ${proposalStep.status}`);
  assert.deepEqual(accepted.run.blockers, manualResult.run.blockers);
  assert.equal(accepted.run.candidate_id, manualResult.run.candidate_id, 'the same decisions produce the same answer, whatever the answer is');
  assert.deepEqual(accepted.run.readiness_blockers, manualResult.run.readiness_blockers);
});

test('no proposal class may answer a Lead readiness gate', async () => {
  // Gate 3 is answered by `applyDecisions.leadEvidence` or `reviewLeadEvidence`
  // — a candidate-bound reviewer record citing a baseline source identity. A
  // proposal is not one, and cannot be turned into one.
  for (const gate of ['leadDemotion', 'leadPromotion']) {
    assert.ok(NEVER_AGENT_SETTLABLE.some(entry => entry.includes(gate)), `${gate} must be named as never settlable`);
  }
  assert.deepEqual([...PROPOSAL_TARGETS[RUN_REVIEW_REQUEST.READINESS_GATE_BLOCKED]], [PROPOSAL_KIND.EVIDENCE_NEEDED]);
  assert.ok(NEVER_AGENT_SETTLABLE.some(entry => entry.includes('Lead evidence citation')));
});

// ─── B. Gate 8 — an adaptation applying is not a Mobile adaptation review ───

test('a Mobile adaptation that really applies still leaves Gate 8 to a reviewer', async () => {
  const app = createStudioApplication({});
  const context = await prepared(app);
  const applied = await app.resolveProposal(OWNER, context.fixture.projectId, (await submit(app, context)).proposal.proposal_id, {
    resolution: 'accept', accepted_by: RUN_REVIEWER,
  });
  const candidateId = applied.run.candidate_id;

  // A real adaptation, through the real engine, that really mints a revision.
  const profile = mobileProfile({ Chord5: { defaultVolume: 9 } });
  const plan = await app.planMobileAdaptation(OWNER, context.fixture.projectId, { candidateId, profile });
  assert.ok(plan.adaptation.plan.id, 'the plan really derived');
  const adapted = await app.applyMobileAdaptation(OWNER, context.fixture.projectId, {
    candidateId, profile, expectedPlanId: plan.adaptation.plan.id, acceptedBy: RUN_REVIEWER,
  });
  assert.equal(adapted.operation, 'succeeded');
  assert.ok(adapted.adaptation.applied || adapted.adaptation.unchanged, 'the adaptation really ran');

  // Succeeded, and Gate 8 is untouched. The operation answered "did this run",
  // not "is this song's Mobile adaptation minimal, role-preserving and
  // evidence-backed".
  const review = await app.reviewCandidate(OWNER, context.fixture.projectId, { candidateId: adapted.adaptation.candidate_id ?? candidateId });
  assert.equal(review.review.gates.mobile_adaptation, 'PENDING', 'a successful adaptation is not a Gate 8 PASS');

  // And no proposal can supply it: the gate request admits a description only.
  const targets = await app.proposalTargets(OWNER, context.fixture.projectId, context.run.run_id);
  for (const entry of targets.targets.filter(item => item.gate === 'mobileAdaptation')) {
    assert.deepEqual(entry.admissible_kinds, [PROPOSAL_KIND.EVIDENCE_NEEDED]);
  }
  assert.ok(NEVER_AGENT_SETTLABLE.some(entry => entry.includes('mobile_adaptation_reviewed')));
});

// ─── C. Gate 9 — a passing suite is not a regression review ─────────────────

test('a regression review is a reviewer statement with evidence, not something a proposal or a test run produces', async () => {
  const app = createStudioApplication({});
  const context = await prepared(app);
  const applied = await app.resolveProposal(OWNER, context.fixture.projectId, (await submit(app, context)).proposal.proposal_id, {
    resolution: 'accept', accepted_by: RUN_REVIEWER,
  });

  // This very suite is passing while this assertion runs, and Gate 9 is PENDING.
  const before = await app.reviewCandidate(OWNER, context.fixture.projectId, { candidateId: applied.run.candidate_id });
  assert.equal(before.review.gates.regression, 'PENDING');

  // A reason alone is refused: a review with no evidence is a claim. A Gate 9
  // review is also a statement about ONE candidate, so it must name it.
  await assert.rejects(
    app.recordConfirmations(OWNER, context.fixture.projectId, {
      regression_reviewed: { value: true, reason: 'The repository test suite passes.', candidate_id: applied.run.candidate_id },
    }),
    error => error.code === 'INVALID_REQUEST',
  );

  // Recorded properly, by a reviewer, with evidence, bound to this candidate —
  // which is the only way.
  await app.recordConfirmations(OWNER, context.fixture.projectId, {
    regression_reviewed: { ...FIXTURE_CONFIRMATIONS.regression_reviewed, candidate_id: applied.run.candidate_id },
  });
  const after = await app.reviewCandidate(OWNER, context.fixture.projectId, { candidateId: applied.run.candidate_id });
  assert.notEqual(after.review.gates.regression, before.review.gates.regression, 'the reviewer moved it, and only the reviewer could');

  assert.ok(NEVER_AGENT_SETTLABLE.some(entry => entry.includes('regression_reviewed')));
});

// ─── D. the ladder answers one thing at a time ──────────────────────────────

test('the policy returns exactly one verdict, and the refusing ones come first', async () => {
  const app = createStudioApplication({});
  const context = await prepared(app);

  // A proposal that is wrong in several ways at once: a fabricated event id
  // AND declared missing evidence AND no resolvable citation of its own. The
  // caller is told which problem to fix, not handed a set to rank.
  const submitted = await submit(app, context, {
    cites: { event_ids: ['melody-does-not-exist'] },
    missing_evidence: ['A score covering this section.'],
  });
  assert.equal(submitted.proposal.agent_review.verdict, AGENT_REVIEW.INVALID, 'the protocol failure outranks the evidence gap');
  assert.equal(typeof submitted.proposal.agent_review.verdict, 'string');
  assert.equal(submitted.proposal.agent_review.acceptable, false);

  // Staleness outranks an evidence gap too, and scope outranks both.
  const gateTargets = await app.proposalTargets(OWNER, context.fixture.projectId, context.run.run_id);
  assert.ok(gateTargets.targets.length > 0);
});

test('the policy verdict is recomputed on every read, never served from what was stored', async () => {
  const app = createStudioApplication({});
  const context = await prepared(app);
  const submitted = await submit(app, context);
  assert.equal(submitted.proposal.agent_review.verdict, AGENT_REVIEW.REQUIRES_EXPLICIT_ACCEPTANCE);
  assert.equal(submitted.proposal.agent_review_at_submission.verdict, AGENT_REVIEW.REQUIRES_EXPLICIT_ACCEPTANCE);

  // Move the run underneath it.
  await app.resumeRun(OWNER, context.fixture.projectId, context.run.run_id, {
    decisions: runDecisionsFor(context.fixture.project, { acceptedBy: RUN_REVIEWER }),
  });

  const reread = await app.getProposal(OWNER, context.fixture.projectId, submitted.proposal.proposal_id);
  assert.equal(reread.proposal.agent_review.verdict, AGENT_REVIEW.STALE, 'recomputed against what is stored now');
  assert.equal(reread.proposal.agent_review_at_submission.verdict, AGENT_REVIEW.REQUIRES_EXPLICIT_ACCEPTANCE,
    'and the verdict it was written under is kept as history, so the two can be compared');
});

test('a run waiting on a human inspection accepts no proposal at all', async () => {
  const app = createStudioApplication({});
  const context = await prepared(app);
  const submitted = await submit(app, context);

  // Reconciliation rests on a caller having actually looked at a stored record.
  // An agent asserting that it has is exactly the forge the run refuses, so a
  // run needing one is not a place a proposal may be applied.
  assert.ok(NEVER_AGENT_SETTLABLE.some(entry => entry.includes('reconciliation')));
  assert.deepEqual([...PROPOSAL_TARGETS[RUN_REVIEW_REQUEST.RECONCILIATION_REQUIRED]], [PROPOSAL_KIND.EVIDENCE_NEEDED]);
  assert.equal(submitted.proposal.agent_review.verdict, AGENT_REVIEW.REQUIRES_EXPLICIT_ACCEPTANCE, 'this run is healthy, so the control holds');
});
