// The four identity questions a run must never answer by guessing.
//
// An independent review of the One-Click Orchestrator found four places where
// the run picked an answer instead of establishing one. Each is a different
// identity, and each regression below fails if its fix is reverted:
//
//   candidate identity      a read-only plan treated "the newest candidate in
//                           the project" as the run's candidate, while a start
//                           adopts only a named one. The plan described a run
//                           that would not happen, and it selected a candidate
//                           for being newest — which this service refuses
//                           everywhere else.
//   request identity        a resume carrying both an idempotency key and
//                           `expected_run_revision` advances the revision when
//                           it succeeds, so the network retry of that exact
//                           request was answered RUN_CONFLICT instead of being
//                           replayed. The precondition was checked before the
//                           key, which is the one order that breaks it.
//   intake-input identity   the meter map is an intake input — an MML source is
//                           parsed against it — but intake satisfaction
//                           compared asset ids alone, so a run stating meter B
//                           carried on using a baseline built from meter A.
//   artifact identity       a pending artifact effect was matched on candidate
//                           id and type, which do not identify one artifact: a
//                           candidate can hold several Final artifacts and
//                           several runs can each file a report for it. The
//                           ambiguity was reported with a remedy
//                           (`adopt_candidate_id`) that cannot resolve an
//                           artifact, leaving a state that claimed to be
//                           reconcilable and never was.

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createStudioApplication, ERROR_CODES, RUN_STATE, RUN_STEP, RUN_STEP_STATUS } from '../backend/application/index.mjs';
import { FIXTURE_CONFIRMATIONS, RUN_REVIEWER, projectWithSymbolicAsset, runDecisionsFor, sixRoleBaseline } from './fixtures/run-fixtures.mjs';

const OWNER = 'owner:run-identity';

const statusOf = (run, step) => run.steps.find(entry => entry.step === step)?.status ?? null;
const receiptOf = (run, step) => run.steps.find(entry => entry.step === step) ?? null;
const stepOf = (plan, step) => plan.planned_steps.find(entry => entry.step === step) ?? null;
const requestFor = (run, code) => run.review_requests.find(entry => entry.code === code) ?? null;
const rejects = (promise, code) => assert.rejects(promise, error => error.code === code || assert.fail(`expected ${code}, got ${error.code}: ${error.message}`));

const withDirectory = async body => {
  const directory = await mkdtemp(join(tmpdir(), 'mml-run-identity-'));
  try { return await body(directory); } finally { await rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); }
};

const finalsFor = (record, candidateId) => record.artifacts
  .filter(entry => entry.type === 'final_mml' && entry.candidate_id === candidateId)
  .map(entry => entry.artifact_id);

const reportsFor = (record, candidateId) => record.artifacts
  .filter(entry => entry.type === 'run_report' && entry.candidate_id === candidateId)
  .map(entry => entry.artifact_id);

/** A project holding one MML source, whose baseline is parsed against a meter. */
async function mmlProject(app, { mml = 'MML@t120o4cdef,,,,,;' } = {}) {
  const project = (await app.createProject(OWNER, { title: 'Meter binding' })).project;
  const asset = (await app.uploadAsset(OWNER, project.project_id, {
    kind: 'current_mml', filename: 'source.txt', mediaType: 'text/plain', bytes: new TextEncoder().encode(mml),
  })).asset;
  return { projectId: project.project_id, assetId: asset.asset_id };
}

// ─── 1. candidate identity ──────────────────────────────────────────────────

test('neither a plan nor a start adopts a candidate for being the newest', async () => {
  const app = createStudioApplication({});
  const fixture = await projectWithSymbolicAsset(app, OWNER, { project: sixRoleBaseline() });
  await app.analyzeSources(OWNER, fixture.projectId, { assetIds: [fixture.assetId] });

  // Two candidates on one baseline, from two different accepted sets.
  const first = (await app.applyDecisions(OWNER, fixture.projectId, { decisions: runDecisionsFor(fixture.project) })).decisions.candidate_id;
  const second = (await app.applyDecisions(OWNER, fixture.projectId, {
    decisions: runDecisionsFor(fixture.project).map(decision => ({ ...decision, reason: `${decision.reason} Reviewed again, separately.` })),
  })).decisions.candidate_id;
  assert.notEqual(first, second);
  const record = (await app.getProject(OWNER, fixture.projectId)).project;
  assert.equal(record.candidates.length, 2);
  assert.equal(record.candidates[record.candidates.length - 1].candidate_id, second, 'the fixture really does have a "newest" to be tempted by');

  // The plan does not choose one. It offers both and says it will not choose.
  const planned = (await app.planRun(OWNER, fixture.projectId, {})).plan;
  assert.equal(planned.existing_results.target_candidate_id, null, 'the plan named no candidate');
  assert.deepEqual([...planned.existing_results.candidate_ids].sort(), [first, second].sort());
  assert.match(planned.existing_results.candidate_selection_notice, /never adopts a candidate for being the newest/);
  assert.equal(stepOf(planned, RUN_STEP.APPLY_DECISIONS).status, RUN_STEP_STATUS.AWAITING_INPUT);
  assert.notEqual(stepOf(planned, RUN_STEP.APPLY_DECISIONS).status, RUN_STEP_STATUS.SATISFIED);
  const request = planned.review_requests.find(entry => entry.code === 'ARRANGEMENT_DECISIONS_REQUIRED');
  assert.ok(request, JSON.stringify(planned.review_requests.map(entry => entry.code)));
  assert.ok(request.missing.some(entry => entry.includes('never selected for being the newest')));
  assert.ok(request.available_operations.includes('startRun.target_candidate_id'));

  // A start over the same inputs agrees with the plan: it adopts nothing.
  const started = await app.startRun(OWNER, fixture.projectId, {});
  assert.equal(started.run.candidate_id, null, 'the run adopted no candidate');
  assert.equal(started.run.state, RUN_STATE.AWAITING_REVIEW);
  assert.equal(started.run.halt.reason, 'AWAITING_ACCEPTED_DECISIONS');
  assert.equal(statusOf(started.run, RUN_STEP.APPLY_DECISIONS), RUN_STEP_STATUS.AWAITING_INPUT);

  // Naming one is what adopts it — and it is the named one, not the newest.
  const namedPlan = (await app.planRun(OWNER, fixture.projectId, { target_candidate_id: first })).plan;
  assert.equal(namedPlan.existing_results.target_candidate_id, first);
  assert.equal(stepOf(namedPlan, RUN_STEP.APPLY_DECISIONS).status, RUN_STEP_STATUS.SATISFIED);
  const namedRun = await app.startRun(OWNER, fixture.projectId, { target_candidate_id: first });
  assert.equal(namedRun.run.candidate_id, first);
  assert.notEqual(namedRun.run.candidate_id, second);
});

// ─── 2. request identity ────────────────────────────────────────────────────

test('an idempotent resume is replayed even though its own success made the expected revision stale', async () => {
  const app = createStudioApplication({});
  const fixture = await projectWithSymbolicAsset(app, OWNER, { project: sixRoleBaseline() });
  await app.analyzeSources(OWNER, fixture.projectId, { assetIds: [fixture.assetId] });
  const candidateId = (await app.applyDecisions(OWNER, fixture.projectId, { decisions: runDecisionsFor(fixture.project) })).decisions.candidate_id;
  const started = await app.startRun(OWNER, fixture.projectId, { target_candidate_id: candidateId });

  // One request, carrying both an idempotency key and the revision the caller
  // last observed. This is the shape a careful client sends.
  const request = {
    confirmations: FIXTURE_CONFIRMATIONS,
    idempotency_key: 'resume-with-precondition',
    expected_run_revision: started.run.revision,
  };
  const first = await app.resumeRun(OWNER, fixture.projectId, started.run.run_id, request);
  assert.equal(first.replayed, false);
  assert.equal(first.run.state, RUN_STATE.COMPLETED, JSON.stringify(first.run.blockers));
  assert.ok(first.run.revision > started.run.revision, 'succeeding advanced the revision the request named');
  const artifactId = first.run.final_artifact_id;
  assert.ok(artifactId);

  // The network retry of that exact request. The revision it names is stale
  // *because the request itself succeeded*, so a precondition check that ran
  // first would refuse the one case the key exists to answer.
  const retry = await app.resumeRun(OWNER, fixture.projectId, started.run.run_id, request);
  assert.equal(retry.replayed, true);
  assert.equal(retry.advanced, false);
  assert.equal(retry.run.revision, first.run.revision, 'a replay takes no revision');
  assert.equal(retry.run.final_artifact_id, artifactId, 'a replay produces no second Final');
  const record = (await app.getProject(OWNER, fixture.projectId)).project;
  assert.equal(finalsFor(record, candidateId).length, 1, 'exactly one Final for this candidate');

  // The precondition still does its job for a request that is NOT a replay: a
  // new key with the same stale revision is refused.
  await rejects(
    app.resumeRun(OWNER, fixture.projectId, started.run.run_id, { ...request, idempotency_key: 'a-different-key' }),
    ERROR_CODES.RUN_CONFLICT,
  );
  // And the same key with a different payload is still a conflict, not a replay.
  await rejects(
    app.resumeRun(OWNER, fixture.projectId, started.run.run_id, { ...request, confirmations: { ...FIXTURE_CONFIRMATIONS, version_drift_reviewed: { value: true, reason: 'Reworded, so a different payload.' } } }),
    ERROR_CODES.IDEMPOTENCY_CONFLICT,
  );
  assert.equal((await app.getRun(OWNER, fixture.projectId, started.run.run_id)).run.revision, first.run.revision, 'neither refusal moved the run');
});

// ─── 3. intake-input identity ───────────────────────────────────────────────

test('a baseline built from one meter map is not reused for a run stating another', async () => {
  const app = createStudioApplication({});
  const fixture = await mmlProject(app);

  const started = await app.startRun(OWNER, fixture.projectId, { asset_ids: [fixture.assetId], meter_text: '0 4/4' });
  const baselineA = started.run.baseline_id;
  assert.match(baselineA, /^bas:[0-9a-f]{64}$/);
  assert.equal(statusOf(started.run, RUN_STEP.INTAKE), RUN_STEP_STATUS.COMPLETED);
  // The baseline records which meter input it consumed, and which asset read it.
  const withA = (await app.getProject(OWNER, fixture.projectId)).project;
  assert.equal(withA.baseline.baseline_id, baselineA);
  assert.ok(withA.baseline.intake_inputs.meter_text_sha256, 'an MML baseline records the meter it was built from');
  assert.deepEqual(withA.baseline.intake_inputs.meter_text_consumed_by, [fixture.assetId]);

  // Same asset, different source-confirmed meter. The asset ids match exactly,
  // which is all the old satisfaction check compared.
  const resumed = await app.resumeRun(OWNER, fixture.projectId, started.run.run_id, { meter_text: '0 3/4' });
  const baselineB = resumed.run.baseline_id;
  assert.notEqual(baselineB, baselineA, 'intake ran again under the stated meter');
  assert.equal(statusOf(resumed.run, RUN_STEP.INTAKE), RUN_STEP_STATUS.COMPLETED);
  assert.equal(receiptOf(resumed.run, RUN_STEP.INTAKE).result_reference, baselineB);
  const withB = (await app.getProject(OWNER, fixture.projectId)).project;
  assert.equal(withB.baseline.baseline_id, baselineB);
  assert.notEqual(withB.baseline.intake_inputs.meter_text_sha256, withA.baseline.intake_inputs.meter_text_sha256);

  // Nothing bound to the old baseline was carried over.
  assert.deepEqual(withB.candidates, [], 'candidates derived from the old baseline are gone');
  assert.equal(resumed.run.candidate_id, null);
  assert.deepEqual(resumed.run.candidate_lineage, []);
});

test('a run that states no meter map will not reuse a baseline that was built from one', async () => {
  const app = createStudioApplication({});
  const fixture = await mmlProject(app);
  const baselineA = (await app.analyzeSources(OWNER, fixture.projectId, { assetIds: [fixture.assetId], meterText: '0 4/4' })).baseline.baseline_id;

  // The run cannot show that this baseline is the one its own inputs describe,
  // and re-ingesting under an empty meter would produce a third baseline. So it
  // stops and says which identity it is missing.
  const started = await app.startRun(OWNER, fixture.projectId, { asset_ids: [fixture.assetId] });
  assert.equal(started.run.state, RUN_STATE.BLOCKED);
  assert.equal(started.run.halt.reason, 'RUN_BASELINE_INTAKE_INPUT_UNPROVABLE');
  assert.equal(statusOf(started.run, RUN_STEP.INTAKE), RUN_STEP_STATUS.AWAITING_INPUT);
  const request = requestFor(started.run, 'SOURCE_METER_BINDING_REQUIRED');
  assert.ok(request, JSON.stringify(started.run.review_requests.map(entry => entry.code)));
  assert.deepEqual(request.blockers, ['RUN_BASELINE_INTAKE_INPUT_UNPROVABLE']);
  assert.equal(request.detail.baseline_id, baselineA);
  assert.equal(request.detail.run_meter_text_sha256, null);
  assert.ok(request.detail.baseline_meter_text_sha256);
  assert.ok(request.available_operations.includes('resumeRun with meter_text'));
  assert.ok(request.invalidated_by.some(entry => entry.includes('meter map')));

  // Crucially it did not quietly rebuild: the stored baseline is untouched.
  assert.equal((await app.getProject(OWNER, fixture.projectId)).project.baseline.baseline_id, baselineA);

  // The read-only plan gives the same answer for the same inputs.
  const planned = (await app.planRun(OWNER, fixture.projectId, { asset_ids: [fixture.assetId] })).plan;
  assert.equal(stepOf(planned, RUN_STEP.INTAKE).status, RUN_STEP_STATUS.AWAITING_INPUT);
  assert.ok(planned.review_requests.some(entry => entry.code === 'SOURCE_METER_BINDING_REQUIRED'));

  // Stating the meter the baseline was built from proves the binding, and the
  // baseline is reused rather than rebuilt.
  const resumed = await app.resumeRun(OWNER, fixture.projectId, started.run.run_id, { meter_text: '0 4/4' });
  assert.notEqual(resumed.run.state, RUN_STATE.BLOCKED);
  assert.equal(resumed.run.baseline_id, baselineA, 'the proven baseline was reused');
  assert.equal((await app.getProject(OWNER, fixture.projectId)).project.baseline.baseline_id, baselineA);
  // Intake did not re-run: the receipt records that the committed baseline
  // already answers this run's inputs, and names the baseline it proved.
  const proven = receiptOf(resumed.run, RUN_STEP.INTAKE);
  assert.equal(proven.status, RUN_STEP_STATUS.SATISFIED);
  assert.equal(proven.detail.reason, 'BASELINE_ALREADY_ANSWERS_THESE_INPUTS');
  assert.equal(proven.result_reference, baselineA);
  assert.ok(proven.detail.intake_inputs.meter_text_sha256, 'the proven meter identity is on the record');
  // A read-only status read reports the same staleness while it holds.
  const stale = await app.getRun(OWNER, fixture.projectId, started.run.run_id);
  assert.deepEqual(stale.staleness, [], 'once proven, nothing is reported stale');
});

test('a source that reads no meter map is never rebuilt over an irrelevant meter field', async () => {
  const app = createStudioApplication({});
  // A Canonical IR upload: no adapter in this selection reads a meter map, so
  // the field is irrelevant to it and must not invalidate anything.
  const fixture = await projectWithSymbolicAsset(app, OWNER, { project: sixRoleBaseline() });
  const baselineA = (await app.analyzeSources(OWNER, fixture.projectId, { assetIds: [fixture.assetId] })).baseline;
  assert.equal(baselineA.intake_inputs.meter_text_sha256, null, 'no adapter consumed a meter');
  assert.deepEqual(baselineA.intake_inputs.meter_text_consumed_by, []);
  const candidateId = (await app.applyDecisions(OWNER, fixture.projectId, { decisions: runDecisionsFor(fixture.project) })).decisions.candidate_id;

  // A run stating a meter anyway: irrelevant here, so intake stays satisfied
  // and the candidate survives.
  const started = await app.startRun(OWNER, fixture.projectId, {
    asset_ids: [fixture.assetId], target_candidate_id: candidateId, meter_text: '0 4/4', confirmations: FIXTURE_CONFIRMATIONS,
  });
  assert.equal(statusOf(started.run, RUN_STEP.INTAKE), null, 'intake was not attempted');
  assert.equal(started.run.baseline_id, baselineA.baseline_id);
  assert.equal(started.run.candidate_id, candidateId, 'the candidate was not invalidated by an irrelevant field');
  assert.equal(started.run.state, RUN_STATE.COMPLETED, JSON.stringify(started.run.blockers));
  const record = (await app.getProject(OWNER, fixture.projectId)).project;
  assert.equal(record.baseline.baseline_id, baselineA.baseline_id);
  assert.equal(record.candidates.length, 1);
});

// ─── 4. artifact identity ───────────────────────────────────────────────────

test('an interrupted finalize adopts the Final it produced, not one that was already there', async () => {
  await withDirectory(async directory => {
    const options = { dataDirectory: directory, durability: 'persistent' };
    const setup = createStudioApplication(options);
    const fixture = await projectWithSymbolicAsset(setup, OWNER, { project: sixRoleBaseline() });
    await setup.analyzeSources(OWNER, fixture.projectId, { assetIds: [fixture.assetId] });
    const candidateId = (await setup.applyDecisions(OWNER, fixture.projectId, { decisions: runDecisionsFor(fixture.project) })).decisions.candidate_id;

    // A Final for this candidate already exists, produced outside any run.
    const existing = (await setup.finalize(OWNER, fixture.projectId, { candidateId, confirmations: FIXTURE_CONFIRMATIONS })).artifact_id;
    assert.ok(existing);
    assert.deepEqual(finalsFor((await setup.getProject(OWNER, fixture.projectId)).project, candidateId), [existing]);

    // A run finalizes the same candidate and stops after the effect, before its
    // receipt. Candidate id and type now match two artifacts.
    const interrupted = createStudioApplication({
      ...options,
      runHooks: { afterEffect: ({ step }) => { if (step === RUN_STEP.FINALIZE) throw Error('the process stopped after the effect'); } },
    });
    const error = await interrupted.startRun(OWNER, fixture.projectId, { target_candidate_id: candidateId })
      .then(() => assert.fail('the injected fault must propagate'), problem => problem);
    assert.match(error.message, /stopped after the effect/);

    const restarted = createStudioApplication(options);
    const runId = (await restarted.getRun(OWNER, fixture.projectId)).runs[0].run_id;
    const midway = (await restarted.getProject(OWNER, fixture.projectId)).project;
    const finals = finalsFor(midway, candidateId);
    assert.equal(finals.length, 2, 'two Finals for one candidate is exactly the ambiguity');
    const mine = finals.find(id => id !== existing);
    assert.ok(mine);
    // The run's pending marker recorded what was already there.
    const before = await restarted.getRun(OWNER, fixture.projectId, runId);
    assert.equal(before.run.pending_step.step, RUN_STEP.FINALIZE);
    assert.deepEqual(before.run.pending_step.expectation.known_artifact_ids, [existing]);

    // Resuming adopts the one that was not there before, and re-runs nothing.
    const resumed = await restarted.resumeRun(OWNER, fixture.projectId, runId, {});
    const receipt = receiptOf(resumed.run, RUN_STEP.FINALIZE);
    assert.equal(receipt.status, RUN_STEP_STATUS.SATISFIED);
    assert.equal(receipt.detail.reason, 'EFFECT_FOUND_BY_STORED_IDENTITY');
    assert.equal(receipt.result_reference, mine);
    assert.equal(resumed.run.final_artifact_id, mine);
    assert.notEqual(resumed.run.final_artifact_id, existing, 'it did not adopt the Final that was already there');
    assert.equal(resumed.run.state, RUN_STATE.COMPLETED, JSON.stringify(resumed.run.blockers));
    const after = (await restarted.getProject(OWNER, fixture.projectId)).project;
    assert.equal(finalsFor(after, candidateId).length, 2, 'nothing was replayed, so no third Final');
    // The run report names the Final this run actually delivered.
    const report = (await restarted.getArtifact(OWNER, resumed.run.report_artifact_id)).artifact;
    assert.equal(report.final_artifact_id, mine);
    assert.equal(report.run_id, runId);
  });
});

test('an interrupted run report is identified by the run it names, not by another run\'s report', async () => {
  await withDirectory(async directory => {
    const options = { dataDirectory: directory, durability: 'persistent' };
    const setup = createStudioApplication(options);
    const fixture = await projectWithSymbolicAsset(setup, OWNER, { project: sixRoleBaseline() });
    await setup.analyzeSources(OWNER, fixture.projectId, { assetIds: [fixture.assetId] });
    const candidateId = (await setup.applyDecisions(OWNER, fixture.projectId, { decisions: runDecisionsFor(fixture.project) })).decisions.candidate_id;

    // Run one completes and files its report for this candidate.
    const runOne = await setup.startRun(OWNER, fixture.projectId, { target_candidate_id: candidateId, confirmations: FIXTURE_CONFIRMATIONS });
    assert.equal(runOne.run.state, RUN_STATE.COMPLETED, JSON.stringify(runOne.run.blockers));
    const theirReport = runOne.run.report_artifact_id;
    assert.ok(theirReport);

    // Run two, on the same candidate, stops after its report effect but before
    // the receipt. Candidate id and type now match two reports.
    const interrupted = createStudioApplication({
      ...options,
      runHooks: { afterEffect: ({ step }) => { if (step === RUN_STEP.REPORT) throw Error('the process stopped after the effect'); } },
    });
    const error = await interrupted.startRun(OWNER, fixture.projectId, { target_candidate_id: candidateId, confirmations: FIXTURE_CONFIRMATIONS })
      .then(() => assert.fail('the injected fault must propagate'), problem => problem);
    assert.match(error.message, /stopped after the effect/);

    const restarted = createStudioApplication(options);
    const runs = (await restarted.getRun(OWNER, fixture.projectId)).runs;
    const runTwoId = runs.find(entry => entry.run_id !== runOne.run.run_id).run_id;
    const midway = (await restarted.getProject(OWNER, fixture.projectId)).project;
    assert.equal(reportsFor(midway, candidateId).length, 2, 'two reports for one candidate is exactly the ambiguity');
    const mine = reportsFor(midway, candidateId).find(id => id !== theirReport);
    assert.ok(mine);
    const before = await restarted.getRun(OWNER, fixture.projectId, runTwoId);
    assert.equal(before.run.pending_step.step, RUN_STEP.REPORT);
    assert.equal(before.run.pending_step.expectation.expected_run_id, runTwoId);

    // Naming the other run's report is refused by identity, not accepted as a
    // convenient way out of the interruption.
    await rejects(
      restarted.resumeRun(OWNER, fixture.projectId, runTwoId, { adopt_artifact_id: theirReport }),
      ERROR_CODES.INVALID_REQUEST,
    );
    await assert.rejects(
      restarted.resumeRun(OWNER, fixture.projectId, runTwoId, { adopt_artifact_id: theirReport }),
      /names a different run/,
    );
    // Nor is a Final accepted where a report is expected.
    await rejects(
      restarted.resumeRun(OWNER, fixture.projectId, runTwoId, { adopt_artifact_id: runOne.run.final_artifact_id }),
      ERROR_CODES.INVALID_REQUEST,
    );

    // Resuming settles it on identity alone: the report whose body names run two.
    const resumed = await restarted.resumeRun(OWNER, fixture.projectId, runTwoId, {});
    const receipt = receiptOf(resumed.run, RUN_STEP.REPORT);
    assert.equal(receipt.status, RUN_STEP_STATUS.SATISFIED);
    assert.equal(receipt.result_reference, mine);
    assert.equal(resumed.run.report_artifact_id, mine);
    assert.notEqual(resumed.run.report_artifact_id, theirReport);
    assert.equal(resumed.run.state, RUN_STATE.COMPLETED);
    const body = (await restarted.getArtifact(OWNER, mine)).artifact;
    assert.equal(body.run_id, runTwoId, 'the adopted report is this run\'s');
    assert.equal(reportsFor((await restarted.getProject(OWNER, fixture.projectId)).project, candidateId).length, 2, 'no third report was filed');
  });
});

test('two Finals for one candidate are told apart by the attempt that produced each', async () => {
  await withDirectory(async directory => {
    const options = { dataDirectory: directory, durability: 'persistent' };
    const setup = createStudioApplication(options);
    const fixture = await projectWithSymbolicAsset(setup, OWNER, { project: sixRoleBaseline() });
    await setup.analyzeSources(OWNER, fixture.projectId, { assetIds: [fixture.assetId] });
    const candidateId = (await setup.applyDecisions(OWNER, fixture.projectId, { decisions: runDecisionsFor(fixture.project) })).decisions.candidate_id;
    await setup.recordConfirmations(OWNER, fixture.projectId, Object.fromEntries(
      Object.entries(FIXTURE_CONFIRMATIONS).map(([name, value]) => [name, { ...value, ...(['source_complete', 'original_audio_required'].includes(name) ? {} : { candidate_id: candidateId }) }]),
    ));

    // Two Finals appear for this candidate while a receipt is lost: this run's,
    // and one a second RUN filed under the same options during the
    // interruption. Neither is in the before-set, a Final's body names no run,
    // and every explicit input of the two steps is identical — so nothing about
    // what the step was ASKED to do separates them. What does is that each
    // filing recorded the attempt that produced it.
    const concurrent = createStudioApplication(options);
    let other = null;
    const interrupted = createStudioApplication({
      ...options,
      runHooks: {
        afterEffect: async ({ step }) => {
          if (step !== RUN_STEP.FINALIZE) return;
          other = (await concurrent.startRun(OWNER, fixture.projectId, { target_candidate_id: candidateId })).run;
          throw Error('the process stopped after the effect');
        },
      },
    });
    const error = await interrupted.startRun(OWNER, fixture.projectId, { target_candidate_id: candidateId })
      .then(() => assert.fail('the injected fault must propagate'), problem => problem);
    assert.match(error.message, /stopped after the effect/);

    const restarted = createStudioApplication(options);
    const runId = (await restarted.getRun(OWNER, fixture.projectId)).runs.find(entry => entry.run_id !== other.run_id).run_id;
    const finals = finalsFor((await restarted.getProject(OWNER, fixture.projectId)).project, candidateId);
    assert.equal(finals.length, 2, 'two Finals, neither naming a run');
    assert.ok(other.final_artifact_id);

    // No guess, and no "which one did you mean": the interrupted run recovers
    // the Final ITS attempt filed, and the other run keeps its own.
    const resumed = await restarted.resumeRun(OWNER, fixture.projectId, runId, {});
    assert.equal(resumed.run.state, RUN_STATE.COMPLETED, JSON.stringify(resumed.run.blockers));
    assert.equal(receiptOf(resumed.run, RUN_STEP.FINALIZE).detail.reason, 'EFFECT_FOUND_BY_STORED_IDENTITY');
    assert.notEqual(resumed.run.final_artifact_id, other.final_artifact_id, 'the other run\'s Final is not this one\'s effect');
    assert.ok(finals.includes(resumed.run.final_artifact_id));
    assert.equal(
      finalsFor((await restarted.getProject(OWNER, fixture.projectId)).project, candidateId).length, 2,
      'and nothing was replayed',
    );
    const report = (await restarted.getArtifact(OWNER, resumed.run.report_artifact_id)).artifact;
    assert.equal(report.final_artifact_id, resumed.run.final_artifact_id, 'the report names the Final this run produced');
  });
});
