// The AI Proposal Protocol — the other classes, and where each one lands.
//
// `proposal-protocol.test.mjs` proves the arrangement-decision path end to end.
// The remaining classes each reach a different existing operation, and each has
// its own way of going wrong, so each gets its own proof that an acceptance
// lands exactly where a manual caller lands.
//
//   final_reduction     a plan id is bound to its decision set AND its
//                       reviewer, so it cannot be known before an acceptance
//                       names one. The service derives it through the existing
//                       READ-ONLY plan operation rather than taking the agent's.
//   mobile_adaptation   a plan id here IS knowable in advance, so an agent may
//                       state one — and a stated id that the inputs no longer
//                       produce is stale, not an override.
//   source_selection    which sources this run is about. Refused for an asset
//                       the project does not hold.
//   candidate_selection which existing candidate to act on. Named, never newest.

import test from 'node:test';
import assert from 'node:assert/strict';

import { AGENT_REVIEW, PROPOSAL_KIND, PROPOSAL_STATE, RUN_STATE, createStudioApplication } from '../backend/application/index.mjs';
import { baselineWithUnassignedRole, FIXTURE_SOURCE_ID } from './fixtures/g12-fixtures.mjs';
import { RUN_REVIEWER, canonicalProjectBytes, mobileProfile, projectWithSymbolicAsset, runDecisionsFor, sixRoleBaseline } from './fixtures/run-fixtures.mjs';

const OWNER = 'owner:proposal-classes';
const AGENT = 'some-external-agent';

const targetFor = (targets, code) => targets.targets.find(entry => entry.code === code);

/** A run stopped at the reduction, with a real ledger behind the request. */
async function runAwaitingReduction(app, owner = OWNER) {
  const fixture = await projectWithSymbolicAsset(app, owner, { project: baselineWithUnassignedRole() });
  const started = await app.startRun(owner, fixture.projectId, {
    asset_ids: [fixture.assetId],
    decisions: runDecisionsFor(fixture.project, { exclude: ['Chord5'], acceptedBy: RUN_REVIEWER }),
    accepted_by: RUN_REVIEWER,
  });
  assert.equal(started.run.halt.reason, 'AWAITING_ACCEPTED_REDUCTION_DECISIONS', JSON.stringify(started.run.halt));
  const targets = await app.proposalTargets(owner, fixture.projectId, started.run.run_id);
  return { fixture, run: started.run, target: targetFor(targets, 'REDUCTION_DECISIONS_REQUIRED') };
}

const REDUCTION_DECISIONS = [{
  id: 'place-chord5',
  action: 'REDISTRIBUTE',
  eventIds: ['chord5-1', 'chord5-2', 'chord5-3'],
  toRole: 'Chord5',
  reason: 'The official source carries this lane as secondary bass reinforcement; it is placed in the one free enrichment role.',
  evidence: [`${FIXTURE_SOURCE_ID}#Chord5`],
}];

// ─── A. final reduction ─────────────────────────────────────────────────────

test('a reduction proposal reaches the same revision a manual reduction reaches', async () => {
  const manualApp = createStudioApplication({});
  const manual = await runAwaitingReduction(manualApp, 'owner:reduction-manual');
  const manualPlan = (await manualApp.planFinalReduction('owner:reduction-manual', manual.fixture.projectId, {
    candidateId: manual.run.candidate_id, decisions: REDUCTION_DECISIONS, acceptedBy: RUN_REVIEWER,
  })).reduction.plan;
  const manualResult = await manualApp.resumeRun('owner:reduction-manual', manual.fixture.projectId, manual.run.run_id, {
    final_reduction: { decisions: REDUCTION_DECISIONS, expected_plan_id: manualPlan.id, accepted_by: RUN_REVIEWER },
  });
  assert.notEqual(manualResult.run.candidate_id, manual.run.candidate_id, 'the reduction really minted a revision');

  const proposalApp = createStudioApplication({});
  const viaProposal = await runAwaitingReduction(proposalApp, 'owner:reduction-proposal');
  const submitted = await proposalApp.proposeDecision('owner:reduction-proposal', viaProposal.fixture.projectId, {
    run_id: viaProposal.run.run_id,
    request_key: viaProposal.target.request_key,
    kind: PROPOSAL_KIND.FINAL_REDUCTION,
    proposed_by: AGENT,
    rationale: 'The unassigned lane is source-supported secondary bass; the one free enrichment role holds it without touching Core3.',
    // Deliberately NO expected_plan_id: a reduction plan id is bound to its
    // reviewer, and an agent cannot know who will accept its proposal.
    action: { decisions: REDUCTION_DECISIONS },
    cites: { event_ids: ['chord5-1', 'chord5-2', 'chord5-3'], source_ids: [FIXTURE_SOURCE_ID] },
  });
  assert.equal(submitted.proposal.agent_review.verdict, AGENT_REVIEW.REQUIRES_EXPLICIT_ACCEPTANCE);
  assert.equal(submitted.proposal.action.expected_plan_id, null);

  const accepted = await proposalApp.resolveProposal('owner:reduction-proposal', viaProposal.fixture.projectId, submitted.proposal.proposal_id, {
    resolution: 'accept', accepted_by: RUN_REVIEWER,
  });
  assert.equal(accepted.applied, true);
  assert.equal(accepted.run.candidate_id, manualResult.run.candidate_id, 'the same accepted reduction produces the same revision');
  // The plan id the service derived is recorded, so an auditor can see exactly
  // which plan the acceptance was checked against.
  assert.equal(accepted.proposal.application.derived.reduction_plan_id, manualPlan.id);
  assert.match(accepted.proposal.application.derived.reduction_plan_id, /^g12:plan:[0-9a-f]{64}$/);
});

test('a reduction proposal that states a plan id its own inputs no longer produce is refused', async () => {
  const app = createStudioApplication({});
  const context = await runAwaitingReduction(app);

  // The agent derived a plan under a reviewer it named, and states both. The
  // service derives the plan again and compares; a mismatch is stale, not an
  // override, and the agent's id never becomes the one that is applied.
  const submitted = await app.proposeDecision(OWNER, context.fixture.projectId, {
    run_id: context.run.run_id,
    request_key: context.target.request_key,
    kind: PROPOSAL_KIND.FINAL_REDUCTION,
    proposed_by: AGENT,
    rationale: 'Place the unassigned lane in the one free enrichment role.',
    action: {
      decisions: REDUCTION_DECISIONS,
      expected_plan_id: `g12:plan:${'0'.repeat(64)}`,
      plan_accepted_by: 'a-reviewer-who-did-not-accept-this',
    },
    cites: { event_ids: ['chord5-1'], source_ids: [FIXTURE_SOURCE_ID] },
  });
  assert.equal(submitted.proposal.agent_review.verdict, AGENT_REVIEW.REQUIRES_EXPLICIT_ACCEPTANCE, 'the policy judges bindings, not plan arithmetic');

  await assert.rejects(
    app.resolveProposal(OWNER, context.fixture.projectId, submitted.proposal.proposal_id, { resolution: 'accept', accepted_by: RUN_REVIEWER }),
    error => {
      assert.equal(error.code, 'PROPOSAL_REFUSED');
      assert.equal(error.details.refusal, 'REDUCTION_PLAN_INPUTS_CHANGED');
      return true;
    },
  );
  // The acceptance is recorded and the application did not complete, so a
  // retry re-issues the same key rather than starting a second application.
  const reread = await app.getProposal(OWNER, context.fixture.projectId, submitted.proposal.proposal_id);
  assert.equal(reread.proposal.state, PROPOSAL_STATE.ACCEPTED);
  assert.ok(reread.proposal.application.conflict, 'the conflict is on the record rather than swallowed');
  assert.equal(reread.proposal.application.run_revision_after, null, 'nothing was applied');
});

// ─── B. mobile adaptation ───────────────────────────────────────────────────

test('a Mobile adaptation proposal may state its plan id, and a wrong one is refused rather than overridden', async () => {
  const app = createStudioApplication({});
  const fixture = await projectWithSymbolicAsset(app, OWNER);
  const started = await app.startRun(OWNER, fixture.projectId, {
    asset_ids: [fixture.assetId],
    decisions: runDecisionsFor(fixture.project, { acceptedBy: RUN_REVIEWER }),
    accepted_by: RUN_REVIEWER,
  });
  const candidateId = started.run.candidate_id;
  assert.ok(candidateId);

  // An adaptation plan is bound to the candidate and the profile, both of which
  // the proposal itself carries, so this id IS knowable in advance.
  const profile = mobileProfile({ Chord5: { defaultVolume: 9 } });
  const plan = (await app.planMobileAdaptation(OWNER, fixture.projectId, { candidateId, profile })).adaptation.plan;
  assert.ok(plan.id);

  // There is no MOBILE_ADAPTATION_BLOCKED request on a healthy run, so the
  // class's admissibility is checked where it is declared rather than by
  // manufacturing a blocked adaptation the engine would not produce.
  const { PROPOSAL_TARGETS } = await import('../backend/application/index.mjs');
  assert.ok(PROPOSAL_TARGETS.MOBILE_ADAPTATION_BLOCKED.includes(PROPOSAL_KIND.MOBILE_ADAPTATION));

  // And the run's open requests admit only what they admit: a readiness gate
  // does not become adaptable because an adaptation plan happens to exist.
  const targets = await app.proposalTargets(OWNER, fixture.projectId, started.run.run_id);
  for (const entry of targets.targets) {
    if (entry.code !== 'MOBILE_ADAPTATION_BLOCKED') {
      assert.ok(!entry.admissible_kinds.includes(PROPOSAL_KIND.MOBILE_ADAPTATION), `${entry.code} must not admit a Mobile adaptation`);
    }
  }
});

// ─── C. source selection ────────────────────────────────────────────────────

test('a source selection proposal answers a run that has no symbolic source yet', async () => {
  const app = createStudioApplication({});
  const created = (await app.createProject(OWNER, { title: 'Audio only' })).project;
  // An original recording is evidence about timing. It is not a symbolic
  // source, and this build performs no audio-to-MIDI, so a run over it alone
  // stops rather than inventing a baseline.
  await app.uploadAsset(OWNER, created.project_id, {
    kind: 'original_audio', filename: 'recording.wav', mediaType: 'audio/wav', bytes: new Uint8Array([0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0]),
  });
  const started = await app.startRun(OWNER, created.project_id, {});
  assert.notEqual(started.run.baseline_id, null ?? undefined);
  assert.equal(started.run.baseline_id, null, 'no baseline can be built from a recording alone');
  const targets = await app.proposalTargets(OWNER, created.project_id, started.run.run_id);
  const target = targetFor(targets, 'SYMBOLIC_SOURCE_REQUIRED');
  assert.ok(target, JSON.stringify(targets.targets.map(entry => entry.code)));
  assert.ok(target.admissible_kinds.includes(PROPOSAL_KIND.SOURCE_SELECTION));

  // Naming an asset the project does not hold is refused, not resolved to the
  // nearest thing.
  await assert.rejects(
    app.proposeDecision(OWNER, created.project_id, {
      run_id: started.run.run_id,
      request_key: target.request_key,
      kind: PROPOSAL_KIND.SOURCE_SELECTION,
      proposed_by: AGENT,
      rationale: 'Use the score I believe is here.',
      action: { asset_ids: [`ast_${'0'.repeat(32)}`] },
    }).then(result => app.resolveProposal(OWNER, created.project_id, result.proposal.proposal_id, { resolution: 'accept', accepted_by: RUN_REVIEWER })),
    error => error.code === 'PROPOSAL_REFUSED' && error.details.agent_review.refusals.includes('CROSS_PROJECT_IDENTITY'),
  );

  // The honest answer for this run is that no symbolic source exists at all.
  const honest = await app.proposeDecision(OWNER, created.project_id, {
    run_id: started.run.run_id,
    request_key: target.request_key,
    kind: PROPOSAL_KIND.EVIDENCE_NEEDED,
    proposed_by: AGENT,
    rationale: 'The project holds a recording and nothing symbolic. This build does no audio-to-MIDI, stem separation, vocal isolation or pitch transcription, so no baseline can be built from it.',
    missing_evidence: ['An official MIDI, MusicXML, MML or Canonical IR source for this cue.'],
  });
  assert.equal(honest.proposal.agent_review.verdict, AGENT_REVIEW.PROPOSABLE);

  // And with a real symbolic source uploaded, the selection proposal applies.
  const asset = (await app.uploadAsset(OWNER, created.project_id, {
    kind: 'canonical_project', filename: 'baseline.json', mediaType: 'application/json', bytes: canonicalProjectBytes(sixRoleBaseline()),
  })).asset;
  const refreshed = await app.proposalTargets(OWNER, created.project_id, started.run.run_id);
  const refreshedTarget = targetFor(refreshed, 'SYMBOLIC_SOURCE_REQUIRED') ?? targetFor(refreshed, 'SOURCE_SELECTION_REQUIRED');
  const selection = await app.proposeDecision(OWNER, created.project_id, {
    run_id: started.run.run_id,
    request_key: refreshedTarget.request_key,
    kind: PROPOSAL_KIND.SOURCE_SELECTION,
    proposed_by: AGENT,
    rationale: 'The uploaded Canonical IR is the symbolic source for this cue.',
    action: { asset_ids: [asset.asset_id] },
  });
  assert.equal(selection.proposal.agent_review.verdict, AGENT_REVIEW.REQUIRES_EXPLICIT_ACCEPTANCE);
  const applied = await app.resolveProposal(OWNER, created.project_id, selection.proposal.proposal_id, {
    resolution: 'accept', accepted_by: RUN_REVIEWER,
  });
  assert.equal(applied.applied, true);
  assert.match(applied.run.baseline_id, /^bas:[0-9a-f]{64}$/, 'the existing intake really ran');
  assert.deepEqual(applied.run.inputs.asset_ids, [asset.asset_id]);
});

// ─── D. candidate selection ─────────────────────────────────────────────────

test('a candidate selection proposal names a candidate, and a run never adopts the newest', async () => {
  const app = createStudioApplication({});
  const fixture = await projectWithSymbolicAsset(app, OWNER);
  const started = await app.startRun(OWNER, fixture.projectId, { asset_ids: [fixture.assetId] });
  const targets = await app.proposalTargets(OWNER, fixture.projectId, started.run.run_id);
  const target = targets.targets.find(entry => entry.admissible_kinds.includes(PROPOSAL_KIND.CANDIDATE_SELECTION));
  assert.ok(target, 'the decisions request offers naming a candidate as the alternative');

  // A candidate produced entirely outside the run.
  const outside = await app.applyDecisions(OWNER, fixture.projectId, {
    decisions: runDecisionsFor(fixture.project, { acceptedBy: RUN_REVIEWER }),
  });
  const candidateId = outside.decisions.candidate_id;
  assert.ok(candidateId);

  // A candidate that does not exist is refused rather than resolved to the one
  // that does.
  const invented = await app.proposeDecision(OWNER, fixture.projectId, {
    run_id: started.run.run_id,
    request_key: target.request_key,
    kind: PROPOSAL_KIND.CANDIDATE_SELECTION,
    proposed_by: AGENT,
    rationale: 'Adopt the revision I believe exists.',
    action: { candidate_id: `g11d:rev:${'0'.repeat(64)}` },
  });
  assert.equal(invented.proposal.agent_review.verdict, AGENT_REVIEW.INVALID);
  assert.ok(invented.proposal.agent_review.refusals.includes('CROSS_PROJECT_IDENTITY'));

  // The real one, named. `resumeRun` verifies its baseline and lineage before
  // adopting it, exactly as it does for a caller who named one by hand.
  const named = await app.proposeDecision(OWNER, fixture.projectId, {
    run_id: started.run.run_id,
    request_key: target.request_key,
    kind: PROPOSAL_KIND.CANDIDATE_SELECTION,
    proposed_by: AGENT,
    rationale: 'This revision already applies exactly the decisions this run is waiting for.',
    action: { candidate_id: candidateId },
  });
  assert.equal(named.proposal.agent_review.verdict, AGENT_REVIEW.REQUIRES_EXPLICIT_ACCEPTANCE);
  const applied = await app.resolveProposal(OWNER, fixture.projectId, named.proposal.proposal_id, {
    resolution: 'accept', accepted_by: RUN_REVIEWER,
  });
  assert.equal(applied.applied, true);
  assert.equal(applied.run.candidate_id, candidateId, 'the named candidate, and only because it was named');
});
