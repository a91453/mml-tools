// What a step produced is never confused with what was already there.
//
// A second independent review of the One-Click Orchestrator found four places
// where a run could accept a baseline, a candidate or a Final that existed
// BEFORE the effect in question was attempted — or where the read-only plan
// described a run the start would not take. Each regression below fails if its
// fix is reverted, and each proves the same sentence for a different record:
//
//   plan/start agreement    a plan that omits `asset_ids` describes the same
//                           intake a start performs, which resolves the omitted
//                           list to every symbolic asset in the project NOW.
//                           A project that gained a source since its baseline
//                           re-ingests, and a plan saying "satisfied" would
//                           describe a run that will not happen. A plan whose
//                           own intake replaces the baseline cannot then report
//                           a candidate derived from the OLD baseline as a
//                           satisfied downstream result: `intake.run` clears it.
//   intake-input identity   an interrupted intake's marker carries the meter
//                           map it was about and the baseline that was already
//                           committed, so the old baseline — whose asset list
//                           matches exactly — is never adopted as this step's
//                           output.
//   candidate identity      G11-D names no accepted plan, so a parent and a
//                           stage match every sibling candidate applied earlier
//                           from the same parent. The marker records the
//                           candidates that already matched, and adoption is
//                           restricted to what was not among them.
//   artifact identity       the explicit remedy obeys the same rule as the
//                           automatic one: naming an artifact settles WHICH of
//                           a step's possible outputs it produced, and cannot
//                           make an artifact that predates the marker into one.

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createStudioApplication, ERROR_CODES, RUN_STATE, RUN_STEP, RUN_STEP_STATUS } from '../backend/application/index.mjs';
import {
  FIXTURE_CONFIRMATIONS, RUN_REVIEWER, canonicalProjectBytes, projectWithSymbolicAsset, runDecisionsFor, sixRoleBaseline,
} from './fixtures/run-fixtures.mjs';

const OWNER = 'owner:run-effect-identity';
const MML_SOURCE = 'MML@t120o4cdefgab,o4cdef,o3ccgg,,,;';

const receiptOf = (run, step) => run.steps.find(entry => entry.step === step) ?? null;
const statusOf = (run, step) => receiptOf(run, step)?.status ?? null;
const stepOf = (plan, step) => plan.planned_steps.find(entry => entry.step === step) ?? null;

const withDirectory = async body => {
  const directory = await mkdtemp(join(tmpdir(), 'mml-run-effect-'));
  try { return await body(directory); } finally { await rm(directory, { recursive: true, force: true }); }
};

/** A service over the same records that stops before one step's effect. */
const stopsBefore = (directory, target) => createStudioApplication({
  dataDirectory: directory,
  durability: 'persistent',
  runHooks: { beforeEffect: ({ step }) => { if (step === target) throw Error(`the process stopped before the ${step} effect`); } },
});

/** A project holding one MML source, whose baseline is parsed against a meter. */
async function mmlProject(app) {
  const project = (await app.createProject(OWNER, { title: 'Effect identity' })).project;
  const asset = (await app.uploadAsset(OWNER, project.project_id, {
    kind: 'current_mml', filename: 'source.txt', mediaType: 'text/plain', bytes: new TextEncoder().encode(MML_SOURCE),
  })).asset;
  return { projectId: project.project_id, assetId: asset.asset_id };
}

/** KEEP for every role the stored baseline declares — the MML path's decisions. */
async function keepEveryStoredRole(app, projectId, { acceptedBy = RUN_REVIEWER } = {}) {
  const events = (await app.listBaselineEvents(OWNER, projectId, { limit: 500 })).events;
  return [...new Set(events.map(entry => entry.role))].map(role => ({
    id: `keep:${role}`,
    type: 'KEEP',
    target: { eventIds: events.filter(entry => entry.role === role).map(entry => entry.event_id) },
    fromRole: role,
    reason: `The official source declares this material as ${role}; it is accepted unchanged.`,
    evidence: [`fixture:effect-identity#${role}`],
    acceptedBy,
  }));
}

// ─── 1. a plan describes the start it names ─────────────────────────────────

test('a plan and a start agree on intake when the asset list is omitted', async () => {
  const app = createStudioApplication({});
  const fixture = await projectWithSymbolicAsset(app, OWNER, { project: sixRoleBaseline() });
  const baselineA = (await app.analyzeSources(OWNER, fixture.projectId, { assetIds: [fixture.assetId] })).baseline.baseline_id;

  // A second symbolic source, uploaded AFTER the baseline. Omitting `asset_ids`
  // means "every symbolic asset in the project", which is now two, not one.
  const second = (await app.uploadAsset(OWNER, fixture.projectId, {
    kind: 'canonical_project', filename: 'second.json', mediaType: 'application/json', bytes: canonicalProjectBytes(sixRoleBaseline()),
  })).asset;

  const plan = (await app.planRun(OWNER, fixture.projectId, {})).plan;
  const intake = stepOf(plan, RUN_STEP.INTAKE);
  assert.equal(intake.status, RUN_STEP_STATUS.PLANNED, 'the stored baseline does not answer a selection that has grown');
  assert.deepEqual([...intake.will_select_asset_ids].sort(), [fixture.assetId, second.asset_id].sort());
  assert.deepEqual([...plan.existing_results.baseline_asset_ids], [fixture.assetId]);

  // And the start it describes re-ingests, rather than reusing the baseline.
  const started = await app.startRun(OWNER, fixture.projectId, {});
  assert.equal(statusOf(started.run, RUN_STEP.INTAKE), RUN_STEP_STATUS.COMPLETED, 'the start took the step the plan planned');
  assert.notEqual(started.run.baseline_id, baselineA, 'the run is bound to a baseline built from both sources');
  assert.deepEqual([...started.run.inputs.asset_digests.map(entry => entry.asset_id)].sort(), [fixture.assetId, second.asset_id].sort());

  // The unchanged case still agrees the other way: no new source, no re-intake.
  const settled = (await app.planRun(OWNER, fixture.projectId, {})).plan;
  assert.equal(stepOf(settled, RUN_STEP.INTAKE).status, RUN_STEP_STATUS.SATISFIED);
  assert.equal(stepOf(settled, RUN_STEP.INTAKE).existing.baseline_id, started.run.baseline_id);
});

test('a plan does not report a candidate its own re-intake would remove', async () => {
  const app = createStudioApplication({});
  const fixture = await mmlProject(app);
  const baselineA = (await app.analyzeSources(OWNER, fixture.projectId, { assetIds: [fixture.assetId], meterText: '0 4/4' })).baseline.baseline_id;
  await app.suggestArrangement(OWNER, fixture.projectId, {});
  const decisions = await keepEveryStoredRole(app, fixture.projectId);
  const candidateId = (await app.applyDecisions(OWNER, fixture.projectId, { decisions })).decisions.candidate_id;

  // The caller names that candidate, and states a different source-confirmed
  // meter — which re-ingests the MML source, replacing the baseline the
  // candidate descends from.
  const plan = (await app.planRun(OWNER, fixture.projectId, {
    asset_ids: [fixture.assetId], target_candidate_id: candidateId, meter_text: '0 3/4',
  })).plan;

  const intake = stepOf(plan, RUN_STEP.INTAKE);
  assert.equal(intake.status, RUN_STEP_STATUS.PLANNED);
  assert.match(intake.rebuild_reason, /different meter map/);
  assert.equal(intake.invalidates_candidate_id, candidateId);

  // The named candidate is echoed as the caller's input, and flagged — not
  // reported as a satisfied downstream result.
  assert.equal(plan.existing_results.target_candidate_id, candidateId);
  assert.equal(plan.existing_results.target_candidate_invalidated_by_intake, true);
  const apply = stepOf(plan, RUN_STEP.APPLY_DECISIONS);
  assert.notEqual(apply.status, RUN_STEP_STATUS.SATISFIED);
  assert.equal(apply.status, RUN_STEP_STATUS.AWAITING_INPUT);
  assert.equal(apply.invalidated_candidate_id, candidateId);
  assert.match(apply.invalidated_reason, /clears the candidates derived from it/);
  assert.equal(stepOf(plan, RUN_STEP.SUGGEST).status, RUN_STEP_STATUS.PLANNED, 'a rebuilt baseline needs its own suggestion');

  // The start that plan describes: the baseline is replaced, the candidate is
  // gone, and the run stops for a decision set rather than reusing it.
  const started = await app.startRun(OWNER, fixture.projectId, {
    asset_ids: [fixture.assetId], target_candidate_id: candidateId, meter_text: '0 3/4',
  });
  assert.equal(statusOf(started.run, RUN_STEP.INTAKE), RUN_STEP_STATUS.COMPLETED);
  assert.notEqual(started.run.baseline_id, baselineA);
  assert.equal(statusOf(started.run, RUN_STEP.APPLY_DECISIONS), RUN_STEP_STATUS.AWAITING_INPUT);
  assert.equal(started.run.candidate_id, null, 'the named candidate was not carried across the rebuild');
  const record = (await app.getProject(OWNER, fixture.projectId)).project;
  assert.deepEqual(record.candidates, [], 'the candidates bound to the replaced baseline are gone');

  // And the plan still reports a candidate as satisfied when nothing replaces it.
  const stable = (await app.planRun(OWNER, fixture.projectId, { asset_ids: [fixture.assetId], meter_text: '0 4/4' })).plan;
  assert.equal(stepOf(stable, RUN_STEP.INTAKE).status, RUN_STEP_STATUS.PLANNED, 'the meter-4/4 baseline was replaced by the run above');
  assert.equal(stable.existing_results.target_candidate_invalidated_by_intake, false, 'nothing is flagged when nothing was named');
});

// ─── 2. intake-input identity across an interruption ────────────────────────

test('an interruption before a meter-changing intake never adopts the old baseline', async () => {
  await withDirectory(async directory => {
    const app = createStudioApplication({ dataDirectory: directory, durability: 'persistent' });
    const fixture = await mmlProject(app);
    const baselineA = (await app.analyzeSources(OWNER, fixture.projectId, { assetIds: [fixture.assetId], meterText: '0 4/4' })).baseline.baseline_id;
    await app.suggestArrangement(OWNER, fixture.projectId, {});
    const candidateA = (await app.applyDecisions(OWNER, fixture.projectId, {
      decisions: await keepEveryStoredRole(app, fixture.projectId),
    })).decisions.candidate_id;

    // A run stating the SAME asset and a DIFFERENT meter, stopped before its
    // intake writes anything. The asset list of the meter-A baseline matches
    // this step's exactly, which is all the old matcher compared.
    const stopped = await stopsBefore(directory, RUN_STEP.INTAKE)
      .startRun(OWNER, fixture.projectId, { asset_ids: [fixture.assetId], meter_text: '0 3/4' })
      .then(() => assert.fail('the injected fault must propagate'), error => error);
    assert.match(stopped.message, /stopped before the intake effect/);

    const restarted = createStudioApplication({ dataDirectory: directory, durability: 'persistent' });
    const runId = (await restarted.getRun(OWNER, fixture.projectId)).runs[0].run_id;
    const pending = (await restarted.getRun(OWNER, fixture.projectId, runId)).run.pending_step;
    assert.equal(pending.step, RUN_STEP.INTAKE);
    assert.deepEqual(pending.expectation.asset_ids, [fixture.assetId]);
    assert.equal(pending.expectation.known_baseline_id, baselineA, 'the marker records the baseline that was already there');
    assert.ok(pending.expectation.meter_text_sha256, 'and the intake input this step was about');
    assert.equal((await restarted.getProject(OWNER, fixture.projectId)).project.baseline.baseline_id, baselineA, 'the meter-B intake never happened');

    // A resume that omits the meter cannot re-ingest under the one this run
    // states — only the request carries the text — so it blocks rather than
    // building a baseline from an empty meter and calling it this run's.
    const bare = await restarted.resumeRun(OWNER, fixture.projectId, runId, {});
    assert.equal(bare.run.state, RUN_STATE.BLOCKED);
    assert.equal(bare.run.halt.reason, 'RUN_BASELINE_INTAKE_INPUT_UNPROVABLE');
    assert.equal(statusOf(bare.run, RUN_STEP.INTAKE), RUN_STEP_STATUS.AWAITING_INPUT);
    assert.equal(bare.run.pending_step, null, 'the marker is settled: the effect was absent');
    assert.equal((await restarted.getProject(OWNER, fixture.projectId)).project.baseline.baseline_id, baselineA, 'and nothing was ingested');

    const resumed = await restarted.resumeRun(OWNER, fixture.projectId, runId, { meter_text: '0 3/4' });
    const receipt = receiptOf(resumed.run, RUN_STEP.INTAKE);

    // The old baseline is not adopted: the step ran, under the meter it states.
    assert.equal(receipt.status, RUN_STEP_STATUS.COMPLETED, 'not SATISFIED-by-adoption');
    assert.notEqual(receipt.detail?.reason, 'EFFECT_FOUND_BY_STORED_IDENTITY');
    assert.notEqual(receipt.result_reference, baselineA);
    assert.equal(resumed.run.pending_step, null);

    const record = (await app.getProject(OWNER, fixture.projectId)).project;
    assert.notEqual(record.baseline.baseline_id, baselineA, 'the committed baseline is the one this run states');
    assert.equal(record.baseline.baseline_id, receipt.result_reference);
    assert.equal(record.baseline.intake_inputs.meter_text_sha256, pending.expectation.meter_text_sha256, 'built from meter B');
    assert.deepEqual(record.candidates, [], 'nothing bound to the meter-A baseline was carried over');
    assert.equal(record.candidates.some(entry => entry.candidate_id === candidateA), false);
    assert.equal(resumed.run.candidate_id, null);

    // The receipt's own input fingerprint still describes this run's inputs.
    assert.equal(receipt.input_fingerprint, receiptOf(resumed.run, RUN_STEP.INTAKE).input_fingerprint);
    assert.ok(receipt.input_fingerprint, 'the step is fingerprinted, so it is not run a third time');
  });
});

// ─── 3. candidate identity across an interruption ───────────────────────────

test('an interruption before G11-D effect never adopts a pre-existing sibling candidate', async () => {
  await withDirectory(async directory => {
    const app = createStudioApplication({ dataDirectory: directory, durability: 'persistent' });
    const fixture = await projectWithSymbolicAsset(app, OWNER, { project: sixRoleBaseline() });
    await app.analyzeSources(OWNER, fixture.projectId, { assetIds: [fixture.assetId] });

    // C0: an earlier candidate from a DIFFERENT accepted decision set, sharing
    // this step's parent (none) and its stage (none) exactly.
    const c0 = (await app.applyDecisions(OWNER, fixture.projectId, {
      decisions: runDecisionsFor(fixture.project, { exclude: ['Chord3'] }),
    })).decisions.candidate_id;
    const d1 = runDecisionsFor(fixture.project);

    const stopped = await stopsBefore(directory, RUN_STEP.APPLY_DECISIONS)
      .startRun(OWNER, fixture.projectId, { asset_ids: [fixture.assetId], decisions: d1, accepted_by: RUN_REVIEWER })
      .then(() => assert.fail('the injected fault must propagate'), error => error);
    assert.match(stopped.message, /stopped before the apply_decisions effect/);

    const restarted = createStudioApplication({ dataDirectory: directory, durability: 'persistent' });
    const runId = (await restarted.getRun(OWNER, fixture.projectId)).runs[0].run_id;
    const pending = (await restarted.getRun(OWNER, fixture.projectId, runId)).run.pending_step;
    assert.equal(pending.step, RUN_STEP.APPLY_DECISIONS);
    assert.deepEqual(pending.expectation.known_candidate_ids, [c0], 'the marker records the sibling that was already there');
    assert.equal(pending.expectation.known_candidate_ids_complete, true);
    assert.equal((await restarted.getProject(OWNER, fixture.projectId)).project.candidates.length, 1, 'D1 was never applied');

    // A resume that supplies D1 applies D1. C0 is not adopted as its effect.
    const resumed = await restarted.resumeRun(OWNER, fixture.projectId, runId, { decisions: d1, accepted_by: RUN_REVIEWER });
    const receipt = receiptOf(resumed.run, RUN_STEP.APPLY_DECISIONS);
    assert.equal(receipt.status, RUN_STEP_STATUS.COMPLETED);
    assert.notEqual(receipt.detail?.reason, 'EFFECT_FOUND_BY_STORED_IDENTITY');
    assert.notEqual(receipt.result_reference, c0, 'the receipt names D1\'s candidate, not the sibling');
    assert.equal(resumed.run.candidate_id, receipt.result_reference);
    assert.notEqual(resumed.run.candidate_id, c0);
    assert.deepEqual(resumed.run.candidate_lineage, [receipt.result_reference], 'no pre-existing candidate entered this run\'s lineage');

    const record = (await app.getProject(OWNER, fixture.projectId)).project;
    assert.equal(record.candidates.length, 2, 'D1 produced a candidate of its own rather than reusing C0');
    assert.equal(record.candidates.some(entry => entry.candidate_id === c0), true, 'and C0 is untouched');
  });
});

test('naming a pre-existing candidate never settles an interrupted effect as if it had happened', async () => {
  await withDirectory(async directory => {
    const app = createStudioApplication({ dataDirectory: directory, durability: 'persistent' });
    const fixture = await projectWithSymbolicAsset(app, OWNER, { project: sixRoleBaseline() });
    await app.analyzeSources(OWNER, fixture.projectId, { assetIds: [fixture.assetId] });
    const c0 = (await app.applyDecisions(OWNER, fixture.projectId, {
      decisions: runDecisionsFor(fixture.project, { exclude: ['Chord3'] }),
    })).decisions.candidate_id;
    const d1 = runDecisionsFor(fixture.project);

    await stopsBefore(directory, RUN_STEP.APPLY_DECISIONS)
      .startRun(OWNER, fixture.projectId, { asset_ids: [fixture.assetId], decisions: d1, accepted_by: RUN_REVIEWER })
      .then(() => assert.fail('the injected fault must propagate'), error => error);

    const restarted = createStudioApplication({ dataDirectory: directory, durability: 'persistent' });
    const runId = (await restarted.getRun(OWNER, fixture.projectId)).runs[0].run_id;

    // The explicit remedy obeys the same rule as the automatic one: settling an
    // interrupted effect and adopting a candidate produced outside the run are
    // two different statements, and a candidate that predates the marker cannot
    // be recorded as this step's output by either of them.
    await assert.rejects(
      restarted.resumeRun(OWNER, fixture.projectId, runId, { adopt_candidate_id: c0 }),
      error => error.code === ERROR_CODES.INVALID_REQUEST
        && /already existed when this step was marked pending/.test(error.message)
        && error.details.known_candidate_ids.includes(c0),
    );

    // Refusing wrote nothing: the marker is still there and C0 is still not this
    // run's candidate.
    const after = (await restarted.getRun(OWNER, fixture.projectId, runId)).run;
    assert.equal(after.pending_step.step, RUN_STEP.APPLY_DECISIONS);
    assert.equal(after.candidate_id, null);
    assert.equal((await restarted.getProject(OWNER, fixture.projectId)).project.candidates.length, 1);
  });
});

// ─── 4. artifact identity, named explicitly ─────────────────────────────────

test('explicit artifact reconciliation rejects a Final that predates the pending effect', async () => {
  await withDirectory(async directory => {
    const app = createStudioApplication({ dataDirectory: directory, durability: 'persistent' });
    const fixture = await projectWithSymbolicAsset(app, OWNER, { project: sixRoleBaseline() });
    await app.analyzeSources(OWNER, fixture.projectId, { assetIds: [fixture.assetId] });
    const candidateId = (await app.applyDecisions(OWNER, fixture.projectId, { decisions: runDecisionsFor(fixture.project) })).decisions.candidate_id;

    // Final A, filed by an earlier run, before the second run exists at all.
    const first = await app.startRun(OWNER, fixture.projectId, { target_candidate_id: candidateId, confirmations: FIXTURE_CONFIRMATIONS });
    const finalA = first.run.final_artifact_id;
    assert.match(finalA, /^art_[0-9a-f]{64}$/);

    const stopped = await stopsBefore(directory, RUN_STEP.FINALIZE)
      .startRun(OWNER, fixture.projectId, { target_candidate_id: candidateId, confirmations: FIXTURE_CONFIRMATIONS })
      .then(() => assert.fail('the injected fault must propagate'), error => error);
    assert.match(stopped.message, /stopped before the finalize effect/);

    const restarted = createStudioApplication({ dataDirectory: directory, durability: 'persistent' });
    const runId = (await restarted.getRun(OWNER, fixture.projectId)).runs.find(entry => entry.run_id !== first.run.run_id).run_id;
    const pending = (await restarted.getRun(OWNER, fixture.projectId, runId)).run.pending_step;
    assert.equal(pending.step, RUN_STEP.FINALIZE);
    assert.deepEqual(pending.expectation.known_artifact_ids, [finalA]);
    assert.equal(pending.expectation.known_artifact_ids_complete, true);

    // Naming it is refused: it was already there when the marker was written.
    await assert.rejects(
      restarted.resumeRun(OWNER, fixture.projectId, runId, { adopt_artifact_id: finalA }),
      error => error.code === ERROR_CODES.INVALID_REQUEST
        && /already existed when this step was marked pending/.test(error.message)
        && error.details.known_artifact_ids.includes(finalA),
    );

    // Nothing was written, and the run still knows which step is unsettled.
    const after = (await restarted.getRun(OWNER, fixture.projectId, runId)).run;
    assert.equal(after.pending_step.step, RUN_STEP.FINALIZE);
    assert.equal(after.final_artifact_id, null);

    // Resuming normally runs the step: this run's Final is one it produced.
    const resumed = await restarted.resumeRun(OWNER, fixture.projectId, runId, {});
    assert.notEqual(resumed.run.final_artifact_id, finalA);
    assert.equal(receiptOf(resumed.run, RUN_STEP.FINALIZE).result_reference, resumed.run.final_artifact_id);
    const record = (await app.getProject(OWNER, fixture.projectId)).project;
    assert.equal(record.artifacts.filter(entry => entry.type === 'final_mml' && entry.candidate_id === candidateId).length, 2);
  });
});
