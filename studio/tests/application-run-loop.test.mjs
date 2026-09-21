// The closed loop the One-Click Orchestrator exists to complete.
//
//   selected symbolic assets
//     → intake                     (real adapters, real Source-Faithful Baseline)
//     → suggestion                 (real G11-C lanes and role candidates)
//     → awaiting_review            (no accepted decisions: no candidate, no Final)
//     → resume with decisions      (real G11-D application)
//     → awaiting_review            (reduction decisions the ledger asks for)
//     → resume with the plan       (real G12 reduction revision)
//     → resume with the profile    (real Mobile adaptation revision)
//     → resume with confirmations  (real review, real finalize, real emitter)
//     → completed                  (Final artifact + run report)
//
// Every assertion here is one a unit test of a single stage cannot make: that
// the run stops in the right place, that resuming continues *the same run*
// rather than starting again, that the Final artifact names the exact candidate
// the run ended on, and that reaching `completed` moves no gate that was not
// separately answered. No mock engine is used anywhere: the Canonical engines,
// the real Final emitter and the real round-trip readback all run.

import test from 'node:test';
import assert from 'node:assert/strict';

import { createStudioApplication, RUN_STATE, RUN_STEP, RUN_STEP_STATUS } from '../backend/application/index.mjs';
import { summarizeLegacyMergeDiagnostics } from '../backend/application/run-service.mjs';
import { LIMITS } from '../backend/application/contracts.mjs';
import { baselineWithUnassignedRole, FIXTURE_SOURCE_ID } from './fixtures/g12-fixtures.mjs';
import { FIXTURE_CONFIRMATIONS, RUN_REVIEWER, mobileProfile, projectWithSymbolicAsset, runDecisionsFor, sixRoleBaseline } from './fixtures/run-fixtures.mjs';

const OWNER = 'owner:run-loop';

const statusOf = (run, step) => run.steps.find(entry => entry.step === step)?.status ?? null;
const requestFor = (run, code) => run.review_requests.find(entry => entry.code === code) ?? null;

test('bounded reduction merge diagnostics disclose omitted lanes instead of looking complete', () => {
  const total = LIMITS.maxReviewRequestEventIds + 3;
  const diagnostics = Array.from({ length: total }, (_, index) => ({
    laneId: `lane:${index}`,
    sourceEventIds: [`event:${index}`],
    authority: 'SUGGESTION_ONLY',
    targets: [],
  }));
  const summary = summarizeLegacyMergeDiagnostics(diagnostics);
  assert.equal(summary.lane_total, total);
  assert.equal(summary.lane_returned, LIMITS.maxReviewRequestEventIds);
  assert.equal(summary.truncated, true);
  assert.equal(summary.lanes.length, LIMITS.maxReviewRequestEventIds);
  assert.equal(summary.lanes.at(-1).lane_id, `lane:${LIMITS.maxReviewRequestEventIds - 1}`);
});

// ─── A. selected symbolic assets → awaiting review, with nothing invented ───

test('a run from selected symbolic assets really analyses them and then stops for decisions', async () => {
  const app = createStudioApplication({});
  const fixture = await projectWithSymbolicAsset(app, OWNER);

  const started = await app.startRun(OWNER, fixture.projectId, { asset_ids: [fixture.assetId] });
  const run = started.run;

  // Intake and the suggestion really ran: a Source-Faithful Baseline exists and
  // the suggestion recorded the real lane count.
  assert.equal(statusOf(run, RUN_STEP.INTAKE), RUN_STEP_STATUS.COMPLETED);
  assert.match(run.baseline_id, /^bas:[0-9a-f]{64}$/);
  assert.equal(statusOf(run, RUN_STEP.SUGGEST), RUN_STEP_STATUS.COMPLETED);
  assert.ok(run.steps.find(entry => entry.step === RUN_STEP.SUGGEST).detail.lane_count > 0, 'the suggestion reports real lanes');
  // The run's own record of the selected inputs is the actual stored bytes
  // digest, not the upload filename and not a caller's claim about it.
  const stored = (await app.getAsset(OWNER, fixture.projectId, fixture.assetId)).asset;
  assert.deepEqual(run.inputs.asset_digests, [{ asset_id: fixture.assetId, kind: 'canonical_project', sha256: stored.sha256, size: stored.size }]);

  // And then it stopped, because a suggestion is not an acceptance.
  assert.equal(run.state, RUN_STATE.AWAITING_REVIEW);
  assert.equal(run.halt.reason, 'AWAITING_ACCEPTED_DECISIONS');
  assert.equal(statusOf(run, RUN_STEP.APPLY_DECISIONS), RUN_STEP_STATUS.AWAITING_INPUT);

  // No false success anywhere: no candidate, no artifact, no gate answered.
  assert.equal(run.candidate_id, null);
  assert.deepEqual(run.artifact_ids, []);
  assert.equal(run.final_artifact_id, null);
  assert.equal(run.gates, null);
  const record = (await app.getProject(OWNER, fixture.projectId)).project;
  assert.deepEqual(record.candidates, []);
  assert.deepEqual(record.artifacts, []);

  // The review request is actionable: the upstream code, the binding, the
  // operations that answer it, and what expires it.
  const request = requestFor(run, 'ARRANGEMENT_DECISIONS_REQUIRED');
  assert.ok(request, JSON.stringify(run.review_requests));
  assert.deepEqual(request.blockers, ['DECISION_REQUIRED']);
  assert.equal(request.baseline_id, run.baseline_id);
  assert.ok(request.available_operations.includes('applyDecisions'));
  assert.ok(request.missing.join(' ').includes('leadEvidence'), 'the request says a Lead move needs its evidence chain');
  assert.ok(request.invalidated_by.length, 'the request says what would expire it');
});

// ─── B. resume through the real stages, in one run ──────────────────────────

test('resuming with explicit decisions, plan and profile drives one run through G11-D, G12, Mobile, review and finalize', async () => {
  const app = createStudioApplication({});
  // A baseline whose Chord5 material carries no role at all: the reduction is
  // what has to decide where it goes, so the run cannot skip that stage.
  const fixture = await projectWithSymbolicAsset(app, OWNER, { project: baselineWithUnassignedRole() });

  const started = await app.startRun(OWNER, fixture.projectId, {
    asset_ids: [fixture.assetId],
    decisions: runDecisionsFor(fixture.project, { exclude: ['Chord5'] }),
    accepted_by: RUN_REVIEWER,
  });
  const runId = started.run.run_id;
  const g11dCandidate = started.run.candidate_id;

  // G11-D really applied, and the run stopped at the reduction because the
  // ledger has material it cannot retain without a decision.
  assert.equal(statusOf(started.run, RUN_STEP.APPLY_DECISIONS), RUN_STEP_STATUS.COMPLETED);
  assert.match(g11dCandidate, /^g11d:rev:[0-9a-f]{64}$/);
  assert.equal(started.run.state, RUN_STATE.AWAITING_REVIEW);
  assert.equal(started.run.halt.reason, 'AWAITING_ACCEPTED_REDUCTION_DECISIONS');

  const arrangementReceipt = started.run.steps.find(entry => entry.step === RUN_STEP.SUGGEST);
  assert.equal(arrangementReceipt.detail.merge_diagnostics.authority, 'SUGGESTION_ONLY');
  assert.deepEqual(arrangementReceipt.detail.merge_diagnostics.certifies_gates, []);

  const reductionRequest = requestFor(started.run, 'REDUCTION_DECISIONS_REQUIRED');
  assert.ok(reductionRequest, JSON.stringify(started.run.review_requests));
  // The ledger's own accounting, projected: three events are not retained.
  assert.equal(reductionRequest.detail.accounting.total, 18);
  assert.equal(reductionRequest.detail.accounting.retained, 15);
  assert.deepEqual(reductionRequest.detail.legacy_merge_diagnostics, {
    lane_total: 0,
    lane_returned: 0,
    truncated: false,
    lanes: [],
  });
  assert.equal(reductionRequest.detail.outcomes.PENDING, 3);
  assert.equal(reductionRequest.event_id_total, 3);
  // The analysis plan is named as an analysis plan, and the request says in so
  // many words that its id is not the one to resume with — because a reduction
  // plan id is bound to its decision set, and this one carries no decisions.
  assert.match(reductionRequest.detail.analysis_plan_id, /^g12:plan:[0-9a-f]{64}$/);
  assert.equal(reductionRequest.detail.analysis_plan_decision_count, 0);
  assert.equal(reductionRequest.detail.plan_accepted_by, RUN_REVIEWER);
  assert.equal(reductionRequest.detail.plan_id, undefined, 'the analysis plan id must not be presented as the id to accept');
  assert.ok(reductionRequest.missing.some(entry => entry.includes('NOT the expected_plan_id')));
  assert.deepEqual(reductionRequest.detail.certifies_gates, []);

  // ── resume with the accepted reduction, naming the plan derived for it ──
  const reductionDecisions = [{
    id: 'place-chord5',
    action: 'REDISTRIBUTE',
    eventIds: ['chord5-1', 'chord5-2', 'chord5-3'],
    toRole: 'Chord5',
    reason: 'The official source carries this lane as secondary bass reinforcement; it is placed in the one free enrichment role.',
    evidence: [`${FIXTURE_SOURCE_ID}#Chord5`],
  }];
  const acceptedPlan = (await app.planFinalReduction(OWNER, fixture.projectId, {
    candidateId: g11dCandidate, decisions: reductionDecisions, acceptedBy: RUN_REVIEWER,
  })).reduction.plan;
  assert.equal(acceptedPlan.status, 'PASS', JSON.stringify(acceptedPlan.blockers));
  assert.notEqual(acceptedPlan.id, reductionRequest.detail.analysis_plan_id);

  const resumedReduction = await app.resumeRun(OWNER, fixture.projectId, runId, {
    final_reduction: {
      decisions: reductionDecisions,
      expected_plan_id: acceptedPlan.id,
      accepted_by: RUN_REVIEWER,
    },
  });
  const reducedCandidate = resumedReduction.run.candidate_id;
  assert.equal(statusOf(resumedReduction.run, RUN_STEP.FINAL_REDUCTION), RUN_STEP_STATUS.COMPLETED);
  assert.notEqual(reducedCandidate, g11dCandidate, 'the reduction derived a new candidate');
  assert.equal(resumedReduction.run.run_id, runId, 'this is the same run, not a new one');
  // Applying certified nothing: the review the apply already ran re-opened the
  // gates the reduction touched.
  const afterApply = resumedReduction.run.steps.find(entry => entry.step === RUN_STEP.FINAL_REDUCTION).detail.gates_after_apply;
  assert.equal(afterApply.mobile_adaptation, 'PENDING');
  assert.equal(afterApply.regression, 'PENDING');
  // No Mobile profile was supplied, so no adaptation was attempted — and that
  // is explicitly not a Gate 8 result.
  assert.equal(statusOf(resumedReduction.run, RUN_STEP.MOBILE_ADAPTATION), RUN_STEP_STATUS.SKIPPED);
  assert.match(resumedReduction.run.steps.find(entry => entry.step === RUN_STEP.MOBILE_ADAPTATION).detail.notice, /not a Gate 8 result/);
  assert.equal(resumedReduction.run.state, RUN_STATE.AWAITING_REVIEW);
  assert.equal(resumedReduction.run.gates.mobile_adaptation, 'PENDING');

  // ── resume with a cited Mobile profile for the reduced candidate ──
  const profile = mobileProfile({ Chord5: { pitchRange: [36, 59], defaultVolume: 9 } });
  const mobilePlan = (await app.planMobileAdaptation(OWNER, fixture.projectId, { candidateId: reducedCandidate, profile })).adaptation.plan;
  assert.equal(mobilePlan.status, 'PASS', JSON.stringify(mobilePlan.blockers));

  const resumedMobile = await app.resumeRun(OWNER, fixture.projectId, runId, {
    mobile_adaptation: { profile, expected_plan_id: mobilePlan.id, accepted_by: RUN_REVIEWER },
  });
  const adaptedCandidate = resumedMobile.run.candidate_id;
  assert.equal(statusOf(resumedMobile.run, RUN_STEP.MOBILE_ADAPTATION), RUN_STEP_STATUS.COMPLETED);
  assert.notEqual(adaptedCandidate, reducedCandidate);
  assert.equal(resumedMobile.run.state, RUN_STATE.AWAITING_REVIEW, 'applying an adaptation is still not a review');

  // The lineage is the run's own record, and each stage is named as itself.
  const record = (await app.getProject(OWNER, fixture.projectId)).project;
  const stageOf = id => record.candidates.find(candidate => candidate.candidate_id === id);
  assert.deepEqual(resumedMobile.run.candidate_lineage, [g11dCandidate, reducedCandidate, adaptedCandidate]);
  assert.equal(stageOf(reducedCandidate).stage, 'FINAL_SIX_ROLE_REDUCTION_V1');
  assert.equal(stageOf(adaptedCandidate).stage, 'MOBILE_ADAPTATION_V1');
  assert.equal(stageOf(adaptedCandidate).parent_candidate_id, reducedCandidate);

  // ── resume with the reviewer's own confirmations ──
  const finished = await app.resumeRun(OWNER, fixture.projectId, runId, { confirmations: FIXTURE_CONFIRMATIONS });
  assert.equal(finished.run.state, RUN_STATE.COMPLETED, JSON.stringify(finished.run.halt ?? finished.run.blockers));
  assert.equal(finished.run.candidate_id, adaptedCandidate, 'the run ended on the adapted candidate');
  assert.equal(statusOf(finished.run, RUN_STEP.FINALIZE), RUN_STEP_STATUS.COMPLETED);
  assert.deepEqual(finished.run.review_requests, []);

  // A real Final, from the real emitter, for the exact candidate the run ended on.
  const artifact = (await app.getArtifact(OWNER, finished.run.final_artifact_id)).artifact;
  assert.equal(artifact.type, 'final_mml');
  assert.equal(artifact.candidate_id, adaptedCandidate);
  assert.notEqual(artifact.candidate_id, reducedCandidate);
  assert.notEqual(artifact.candidate_id, g11dCandidate);
  assert.equal(artifact.gates.technical, 'PASS');
  assert.equal(artifact.round_trip.status, 'PASS', JSON.stringify(artifact.round_trip));
  assert.equal(artifact.readiness_summary.technical_validation.run, true);
  assert.equal(artifact.readiness_summary.technical_validation.ok, true);
  // The delivered MML is re-read here rather than trusted: the round-trip is
  // executed against the string that was actually handed over.
  assert.equal(artifact.mml.split(',').length, 6);
  assert.ok(artifact.mml.split(',')[5].replace(/;$/, '').trim().length, 'the reduction placed material in Chord5, so the sixth role is delivered');
  // The emitter's own round-trip is asserted above. The delivered string is put
  // through the Published Canonical technical validator again here, from
  // outside the run, so the MML a caller was actually handed is graded rather
  // than only the emitter's report about it.
  const revalidated = await app.validateTechnicalMml({ mml: artifact.mml, meter_text: artifact.final_bar.meter_text });
  assert.equal(revalidated.technical_ok, true, JSON.stringify(revalidated.errors ?? revalidated).slice(0, 400));

  // A completed run is not an acceptance.
  assert.equal(artifact.gates.in_game, 'PENDING');
  assert.equal(finished.run.gates.in_game, 'PENDING');
  assert.match(finished.run.separation_notice, /A completed run, a succeeded operation and a succeeded job are each independent of TECHNICAL_PASS/);

  // The run report names the exact candidate and artifact, and nothing else.
  const report = (await app.getArtifact(OWNER, finished.run.report_artifact_id)).artifact;
  assert.equal(report.schema, 'mabinogi-mobile-mml-studio/application-run-report@1');
  assert.equal(report.final_candidate_id, adaptedCandidate);
  assert.equal(report.final_artifact_id, finished.run.final_artifact_id);
  assert.equal(report.run_id, runId);
  assert.match(report.acceptance_notice, /never implies IN_GAME_ACCEPTED/);
  // The Final artifact is untouched by the report being written.
  const artifactAgain = (await app.getArtifact(OWNER, finished.run.final_artifact_id)).artifact;
  assert.deepEqual(artifactAgain, artifact);
});

// ─── C. a prepared candidate is a first-class run input ─────────────────────

test('a run can start from a prepared candidate without re-running intake or minting a pointless revision', async () => {
  const app = createStudioApplication({});
  const fixture = await projectWithSymbolicAsset(app, OWNER);
  await app.analyzeSources(OWNER, fixture.projectId, { assetIds: [fixture.assetId] });
  const prepared = (await app.applyDecisions(OWNER, fixture.projectId, { decisions: runDecisionsFor(fixture.project) })).decisions.candidate_id;
  const baselineBefore = (await app.getProject(OWNER, fixture.projectId)).project.baseline.baseline_id;

  const started = await app.startRun(OWNER, fixture.projectId, {
    target_candidate_id: prepared,
    confirmations: FIXTURE_CONFIRMATIONS,
  });
  const run = started.run;

  // Intake was satisfied, not re-run: the baseline is the same one, and the
  // candidate was not rebuilt.
  assert.equal(statusOf(run, RUN_STEP.INTAKE), null, 'intake was not attempted at all');
  assert.equal(run.baseline_id, baselineBefore);
  assert.equal(statusOf(run, RUN_STEP.SUGGEST), null, 'no suggestion was derived for a candidate that already exists');
  assert.equal(statusOf(run, RUN_STEP.APPLY_DECISIONS), null);

  // Nothing needed reducing or adapting, so no no-op revision was minted.
  assert.equal(statusOf(run, RUN_STEP.FINAL_REDUCTION), RUN_STEP_STATUS.SKIPPED);
  assert.equal(run.steps.find(entry => entry.step === RUN_STEP.FINAL_REDUCTION).detail.reason, 'REDUCTION_NOTHING_TO_APPLY');
  assert.equal(statusOf(run, RUN_STEP.MOBILE_ADAPTATION), RUN_STEP_STATUS.SKIPPED);
  assert.equal(run.candidate_id, prepared, 'the run finalized the candidate it was given');
  assert.deepEqual(run.candidate_lineage, [prepared]);

  const record = (await app.getProject(OWNER, fixture.projectId)).project;
  assert.equal(record.candidates.length, 1, 'no revision was created for a run with no transformation to make');

  // And it still produced a real Final for that candidate.
  assert.equal(run.state, RUN_STATE.COMPLETED, JSON.stringify(run.halt ?? run.blockers));
  const artifact = (await app.getArtifact(OWNER, run.final_artifact_id)).artifact;
  assert.equal(artifact.candidate_id, prepared);
  assert.equal(artifact.gates.technical, 'PASS');
  assert.equal(artifact.gates.in_game, 'PENDING');
  // The repair stayed off: nobody opted in.
  assert.equal(artifact.technical_timing_repair.requested, false);
  assert.equal(artifact.technical_timing_repair.applied, false);
});

// ─── D. applied is not reviewed ─────────────────────────────────────────────

test('an applied Mobile adaptation leaves the run awaiting review, with the gates it touched re-opened', async () => {
  const app = createStudioApplication({});
  const fixture = await projectWithSymbolicAsset(app, OWNER);
  await app.analyzeSources(OWNER, fixture.projectId, { assetIds: [fixture.assetId] });
  const prepared = (await app.applyDecisions(OWNER, fixture.projectId, { decisions: runDecisionsFor(fixture.project) })).decisions.candidate_id;
  const profile = mobileProfile({ Chord5: { defaultVolume: 9 } });
  const plan = (await app.planMobileAdaptation(OWNER, fixture.projectId, { candidateId: prepared, profile })).adaptation.plan;

  // The Gate 8 review is deliberately withheld while the other confirmations
  // are supplied, so the only thing missing is the review of the adaptation
  // that was just applied.
  const { mobile_adaptation_reviewed: _withheld, ...withoutGate8 } = FIXTURE_CONFIRMATIONS;
  const started = await app.startRun(OWNER, fixture.projectId, {
    target_candidate_id: prepared,
    mobile_adaptation: { profile, expected_plan_id: plan.id, accepted_by: RUN_REVIEWER },
    confirmations: withoutGate8,
  });
  const run = started.run;

  // The adaptation really applied.
  assert.equal(statusOf(run, RUN_STEP.MOBILE_ADAPTATION), RUN_STEP_STATUS.COMPLETED);
  assert.notEqual(run.candidate_id, prepared);
  // And the run is still waiting, because applying is not reviewing.
  assert.equal(run.state, RUN_STATE.AWAITING_REVIEW);
  assert.equal(run.halt.reason, 'AWAITING_REVIEW_EVIDENCE');
  assert.equal(run.gates.mobile_adaptation, 'PENDING');
  assert.equal(run.final_artifact_id, null);
  const gate8 = run.review_requests.find(entry => entry.gate === 'mobileAdaptation');
  assert.ok(gate8, JSON.stringify(run.review_requests.map(entry => entry.gate)));
  assert.deepEqual(gate8.blockers, ['MOBILE_ADAPTATION_REVIEW_REQUIRED']);
  assert.ok(gate8.available_operations.includes('recordConfirmations.mobile_adaptation_reviewed'));

  // Supplying exactly that review, for this candidate, lets the run finish.
  const finished = await app.resumeRun(OWNER, fixture.projectId, run.run_id, { confirmations: FIXTURE_CONFIRMATIONS });
  assert.equal(finished.run.state, RUN_STATE.COMPLETED, JSON.stringify(finished.run.blockers));
  assert.equal(finished.run.gates.mobile_adaptation, 'PASS');
  assert.equal(finished.run.gates.in_game, 'PENDING');
});

// ─── E. the fixture's declarations are not the service's defaults ───────────

test('a run given no confirmations leaves player readback NOT_RUN and original audio required', async () => {
  const app = createStudioApplication({});
  const fixture = await projectWithSymbolicAsset(app, OWNER, { project: sixRoleBaseline() });

  const started = await app.startRun(OWNER, fixture.projectId, {
    asset_ids: [fixture.assetId],
    decisions: runDecisionsFor(fixture.project),
    accepted_by: RUN_REVIEWER,
  });
  const run = started.run;

  assert.equal(run.state, RUN_STATE.AWAITING_REVIEW);
  // Nothing was assumed: no data is not `N/A`, and no data is not `false`.
  assert.equal(run.gates.player_readback, 'NOT_RUN');
  assert.equal(run.gates.audio, 'PENDING');
  assert.equal(run.gates.source, 'PENDING');
  const gates = run.review_requests.map(entry => entry.gate);
  for (const gate of ['source', 'originalAudio', 'playerReadback', 'mobileAdaptation', 'regression']) {
    assert.ok(gates.includes(gate), `${gate} must be reported as blocking, got ${JSON.stringify(gates)}`);
  }
  // Every one of them names the operation that answers it, and none of them was
  // answered by the run.
  const confirmations = (await app.getProject(OWNER, fixture.projectId)).project;
  assert.equal(confirmations.confirmations, undefined, 'the run recorded no confirmation of its own');
});
