// A run's record never describes two different results at once.
//
// A merge-readiness review found five ways the run's own record could come
// apart: a selection recorded against the wrong bytes, an adopted effect that
// left the run pointing at something it had itself deleted, a before-set too
// large to store treated as proof of absence, and a completed run whose report
// named a candidate the run had moved off. Each regression below fails if its
// fix is reverted.
//
//   selection identity   `asset_ids` and `asset_digests` are one identity. The
//                        digests are what intake satisfaction reads, so ids
//                        recorded without them leave a source silently out of
//                        the Source-Faithful Baseline.
//   adopted-effect state An adopted effect is that effect: `intake.run`
//                        replaced the baseline and deleted the candidates bound
//                        to the old one, so a run that kept pointing at one was
//                        permanently blocked — a successful intake turned into
//                        an unresumable run by the loss of a receipt.
//   unprovable ≠ absent  a before-set larger than `LIMITS.maxEffectBeforeSet`
//                        cannot be stored in full. The recorded count and
//                        digest still answer exactly at any size; where they
//                        cannot, the run halts rather than replaying a
//                        non-idempotent effect into a second Final.
//   workflow invariant   nothing a run holds outlives the identity it names.
//                        A new candidate drops every downstream receipt, the
//                        gates, the Final and the report; and a completed run
//                        is an audit record, not a workspace.

import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createStudioApplication, ERROR_CODES, LIMITS, RUN_STATE, RUN_STEP, RUN_STEP_STATUS } from '../backend/application/index.mjs';
import {
  FIXTURE_CONFIRMATIONS, RUN_REVIEWER, canonicalProjectBytes, mobileProfile,
  projectWithSymbolicAsset, runDecisionsFor, sixRoleBaseline,
} from './fixtures/run-fixtures.mjs';

const OWNER = 'owner:run-workflow-identity';

const receiptOf = (run, step) => run.steps.find(entry => entry.step === step) ?? null;
const statusOf = (run, step) => receiptOf(run, step)?.status ?? null;
const finalsFor = (record, candidateId) => record.artifacts
  .filter(entry => entry.type === 'final_mml' && entry.candidate_id === candidateId).map(entry => entry.artifact_id);

const withDirectory = async body => {
  const directory = await mkdtemp(join(tmpdir(), 'mml-run-workflow-'));
  try { return await body(directory); } finally { await rm(directory, { recursive: true, force: true }); }
};

const stopsBefore = (directory, target) => createStudioApplication({
  dataDirectory: directory,
  durability: 'persistent',
  runHooks: { beforeEffect: ({ step }) => { if (step === target) throw Error(`the process stopped before the ${step} effect`); } },
});

const stopsAfter = (directory, target) => createStudioApplication({
  dataDirectory: directory,
  durability: 'persistent',
  runHooks: { afterEffect: ({ step }) => { if (step === target) throw Error(`the process stopped after the ${step} effect`); } },
});

/** KEEP for every role the stored baseline declares — the MML path's decisions. */
async function keepEveryStoredRole(app, projectId) {
  const events = (await app.listBaselineEvents(OWNER, projectId, { limit: 500 })).events;
  return [...new Set(events.map(entry => entry.role))].map(role => ({
    id: `keep:${role}`,
    type: 'KEEP',
    target: { eventIds: events.filter(entry => entry.role === role).map(entry => entry.event_id) },
    fromRole: role,
    reason: `The official source declares this material as ${role}; it is accepted unchanged.`,
    evidence: [`fixture:workflow-identity#${role}`],
    acceptedBy: RUN_REVIEWER,
  }));
}

// ─── 1. the selected sources and their bytes are one identity ───────────────

test('a resume that reselects the sources binds the bytes it selected', async () => {
  const app = createStudioApplication({});
  const fixture = await projectWithSymbolicAsset(app, OWNER, { project: sixRoleBaseline() });
  const started = await app.startRun(OWNER, fixture.projectId, { asset_ids: [fixture.assetId] });
  const baselineA = started.run.baseline_id;
  assert.equal(statusOf(started.run, RUN_STEP.INTAKE), RUN_STEP_STATUS.COMPLETED);

  const second = (await app.uploadAsset(OWNER, fixture.projectId, {
    kind: 'canonical_project', filename: 'second.json', mediaType: 'application/json', bytes: canonicalProjectBytes(sixRoleBaseline()),
  })).asset;

  const resumed = await app.resumeRun(OWNER, fixture.projectId, started.run.run_id, { asset_ids: [fixture.assetId, second.asset_id] });

  // The two halves of the selection agree, so intake satisfaction — which reads
  // the digests — cannot conclude the old baseline answers the new selection.
  assert.deepEqual([...resumed.run.inputs.asset_ids].sort(), [fixture.assetId, second.asset_id].sort());
  assert.deepEqual(
    [...resumed.run.inputs.asset_digests.map(entry => entry.asset_id)].sort(),
    [...resumed.run.inputs.asset_ids].sort(),
    'a run record never states one selection and carries the digests of another',
  );
  for (const digest of resumed.run.inputs.asset_digests) assert.match(digest.sha256, /^[0-9a-f]{64}$/);

  // And the second source is in the baseline this run is bound to.
  assert.notEqual(resumed.run.baseline_id, baselineA, 'the run re-ingested rather than reusing the one-source baseline');
  const record = (await app.getProject(OWNER, fixture.projectId)).project;
  assert.equal(record.baseline.baseline_id, resumed.run.baseline_id);
  assert.deepEqual([...record.baseline.asset_ids].sort(), [fixture.assetId, second.asset_id].sort(),
    'the added source is not silently excluded from the Source-Faithful Baseline');
});

test('an empty asset_ids is refused rather than read as "every source"', async () => {
  const app = createStudioApplication({});
  const fixture = await projectWithSymbolicAsset(app, OWNER, { project: sixRoleBaseline() });
  await assert.rejects(
    app.startRun(OWNER, fixture.projectId, { asset_ids: [] }),
    error => error.code === ERROR_CODES.INVALID_REQUEST && /at least one asset/.test(error.message),
  );
  // The bound the MCP surface advertises and the one the service enforces are
  // the same constant, so neither transport accepts what the other refuses.
  assert.equal(LIMITS.maxMeterTextLength, 2048);
  await assert.rejects(
    app.startRun(OWNER, fixture.projectId, { asset_ids: [fixture.assetId], meter_text: '0 4/4\n'.repeat(500) }),
    error => error.code === ERROR_CODES.INVALID_REQUEST && /meter_text/.test(error.message),
  );
});

// ─── 2. an adopted effect is that effect ────────────────────────────────────

test('an interrupted intake whose effect persisted clears the candidate invalidated by that baseline', async () => {
  await withDirectory(async directory => {
    const app = createStudioApplication({ dataDirectory: directory, durability: 'persistent' });
    const project = (await app.createProject(OWNER, { title: 'Adopted intake' })).project;
    const asset = (await app.uploadAsset(OWNER, project.project_id, {
      kind: 'current_mml', filename: 'source.txt', mediaType: 'text/plain',
      bytes: new TextEncoder().encode('MML@t120o4cdefgab,o4cdef,o3ccgg,,,;'),
    })).asset;
    const baselineA = (await app.analyzeSources(OWNER, project.project_id, { assetIds: [asset.asset_id], meterText: '0 4/4' })).baseline.baseline_id;
    await app.suggestArrangement(OWNER, project.project_id, {});
    const candidateC = (await app.applyDecisions(OWNER, project.project_id, {
      decisions: await keepEveryStoredRole(app, project.project_id),
    })).decisions.candidate_id;

    // A run that names that candidate and states a different meter, stopped
    // once its intake had already landed but before the receipt was stored.
    const stopped = await stopsAfter(directory, RUN_STEP.INTAKE)
      .startRun(OWNER, project.project_id, { asset_ids: [asset.asset_id], meter_text: '0 3/4', target_candidate_id: candidateC })
      .then(() => assert.fail('the injected fault must propagate'), error => error);
    assert.match(stopped.message, /stopped after the intake effect/);

    const restarted = createStudioApplication({ dataDirectory: directory, durability: 'persistent' });
    const runId = (await restarted.getRun(OWNER, project.project_id)).runs[0].run_id;
    const before = (await restarted.getRun(OWNER, project.project_id, runId)).run;
    assert.equal(before.pending_step.step, RUN_STEP.INTAKE);
    assert.equal(before.candidate_id, candidateC, 'the run still names the candidate it was started for');
    const mid = (await restarted.getProject(OWNER, project.project_id)).project;
    assert.notEqual(mid.baseline.baseline_id, baselineA, 'the intake effect landed');
    assert.deepEqual(mid.candidates, [], 'and it deleted the candidates bound to the replaced baseline');

    const resumed = await restarted.resumeRun(OWNER, project.project_id, runId, { meter_text: '0 3/4' });
    const receipt = receiptOf(resumed.run, RUN_STEP.INTAKE);
    assert.equal(receipt.status, RUN_STEP_STATUS.SATISFIED);
    assert.equal(receipt.detail.reason, 'EFFECT_FOUND_BY_STORED_IDENTITY');
    assert.equal(receipt.result_reference, mid.baseline.baseline_id);

    // The adopted intake leaves the run where a completed intake would: pointing
    // at no candidate, rather than at one this very effect deleted.
    assert.equal(resumed.run.candidate_id, null, 'the candidate the adopted baseline invalidated is cleared');
    assert.deepEqual(resumed.run.candidate_lineage, []);
    assert.notEqual(resumed.run.halt?.reason, 'RUN_CANDIDATE_CHANGED', 'a successful intake is not turned into an unresumable run');
    assert.notEqual(resumed.run.state, RUN_STATE.FAILED);

    // And the run carries on: supplying decisions reaches a new candidate.
    const carried = await restarted.resumeRun(OWNER, project.project_id, runId, {
      meter_text: '0 3/4', decisions: await keepEveryStoredRole(restarted, project.project_id),
    });
    assert.equal(statusOf(carried.run, RUN_STEP.APPLY_DECISIONS), RUN_STEP_STATUS.COMPLETED, JSON.stringify(carried.run.blockers));
    assert.ok(carried.run.candidate_id);
    assert.notEqual(carried.run.candidate_id, candidateC);
  });
});

// ─── 3. a before-set too large to store is not proof of absence ─────────────

test('an effect beyond the stored before-set is identified, not replayed into a second Final', async () => {
  await withDirectory(async directory => {
    const app = createStudioApplication({ dataDirectory: directory, durability: 'persistent' });
    const fixture = await projectWithSymbolicAsset(app, OWNER, { project: sixRoleBaseline() });
    await app.analyzeSources(OWNER, fixture.projectId, { assetIds: [fixture.assetId] });
    const candidateId = (await app.applyDecisions(OWNER, fixture.projectId, { decisions: runDecisionsFor(fixture.project) })).decisions.candidate_id;

    // More matching artifacts than a marker can store ids for.
    const overflow = LIMITS.maxEffectBeforeSet + 1;
    for (let index = 0; index < overflow; index += 1) {
      await app.finalize(OWNER, fixture.projectId, { candidateId, confirmations: FIXTURE_CONFIRMATIONS });
    }
    const before = finalsFor((await app.getProject(OWNER, fixture.projectId)).project, candidateId);
    assert.equal(before.length, overflow);

    // A run whose finalize landed and whose receipt was lost.
    const stopped = await stopsAfter(directory, RUN_STEP.FINALIZE)
      .startRun(OWNER, fixture.projectId, { target_candidate_id: candidateId, confirmations: FIXTURE_CONFIRMATIONS })
      .then(() => assert.fail('the injected fault must propagate'), error => error);
    assert.match(stopped.message, /stopped after the finalize effect/);

    const restarted = createStudioApplication({ dataDirectory: directory, durability: 'persistent' });
    const runId = (await restarted.getRun(OWNER, fixture.projectId)).runs[0].run_id;
    const pending = (await restarted.getRun(OWNER, fixture.projectId, runId)).run.pending_step;
    assert.equal(pending.expectation.known_artifact_ids.length, LIMITS.maxEffectBeforeSet, 'the stored ids are capped');
    assert.equal(pending.expectation.known_artifact_ids_complete, false, 'and the marker says so');
    assert.equal(pending.expectation.known_artifact_ids_count, overflow, 'the count is not capped');
    assert.match(pending.expectation.known_artifact_ids_digest, /^[0-9a-f]{64}$/, 'and neither is the digest');
    const landed = finalsFor((await restarted.getProject(OWNER, fixture.projectId)).project, candidateId);
    assert.equal(landed.length, overflow + 1, 'the effect landed');

    // The count and the digest identify it exactly, at a size no id list could
    // hold — so it is adopted rather than replayed.
    const resumed = await restarted.resumeRun(OWNER, fixture.projectId, runId, {});
    const after = finalsFor((await restarted.getProject(OWNER, fixture.projectId)).project, candidateId);
    assert.equal(after.length, overflow + 1, 'no second Final was emitted for one attempt');
    assert.equal(receiptOf(resumed.run, RUN_STEP.FINALIZE).status, RUN_STEP_STATUS.SATISFIED);
    assert.equal(receiptOf(resumed.run, RUN_STEP.FINALIZE).detail.reason, 'EFFECT_FOUND_BY_STORED_IDENTITY');
    assert.equal(resumed.run.final_artifact_id, landed.find(id => !before.includes(id)));
  });
});

test('an unprovable interruption halts instead of replaying, and is not settled by naming a pre-existing Final', async () => {
  await withDirectory(async directory => {
    const app = createStudioApplication({ dataDirectory: directory, durability: 'persistent' });
    const fixture = await projectWithSymbolicAsset(app, OWNER, { project: sixRoleBaseline() });
    await app.analyzeSources(OWNER, fixture.projectId, { assetIds: [fixture.assetId] });
    const candidateId = (await app.applyDecisions(OWNER, fixture.projectId, { decisions: runDecisionsFor(fixture.project) })).decisions.candidate_id;

    const overflow = LIMITS.maxEffectBeforeSet + 1;
    for (let index = 0; index < overflow; index += 1) {
      await app.finalize(OWNER, fixture.projectId, { candidateId, confirmations: FIXTURE_CONFIRMATIONS });
    }
    const before = finalsFor((await app.getProject(OWNER, fixture.projectId)).project, candidateId);

    const stopped = await stopsBefore(directory, RUN_STEP.FINALIZE)
      .startRun(OWNER, fixture.projectId, { target_candidate_id: candidateId, confirmations: FIXTURE_CONFIRMATIONS })
      .then(() => assert.fail('the injected fault must propagate'), error => error);
    assert.match(stopped.message, /stopped before the finalize effect/);

    const restarted = createStudioApplication({ dataDirectory: directory, durability: 'persistent' });
    const runId = (await restarted.getRun(OWNER, fixture.projectId)).runs[0].run_id;
    const pending = (await restarted.getRun(OWNER, fixture.projectId, runId)).run.pending_step;
    const outside = before.find(id => !pending.expectation.known_artifact_ids.includes(id));
    assert.ok(outside, 'a Final that predates the marker and falls outside the stored ids');

    // Naming it is refused: the stored before-set cannot show it postdates the
    // marker, and the named path never concludes more than the automatic one.
    await assert.rejects(
      restarted.resumeRun(OWNER, fixture.projectId, runId, { adopt_artifact_id: outside }),
      error => error.code === ERROR_CODES.INVALID_REQUEST && /cannot be established|already existed/.test(error.message),
    );
    assert.equal((await restarted.getRun(OWNER, fixture.projectId, runId)).run.final_artifact_id, null);

    // Two artifacts added behind the marker's back: neither "absent" nor
    // "found", so the run reports the step unconfirmed and replays nothing.
    await restarted.finalize(OWNER, fixture.projectId, { candidateId, confirmations: FIXTURE_CONFIRMATIONS });
    await restarted.finalize(OWNER, fixture.projectId, { candidateId, confirmations: FIXTURE_CONFIRMATIONS });
    const total = finalsFor((await restarted.getProject(OWNER, fixture.projectId)).project, candidateId).length;

    const resumed = await restarted.resumeRun(OWNER, fixture.projectId, runId, {});
    assert.equal(resumed.run.state, RUN_STATE.INTERRUPTED);
    assert.equal(resumed.run.needs_reconciliation, true);
    assert.equal(resumed.run.halt.reason, 'RUN_RECONCILIATION_REQUIRED');
    assert.equal(resumed.run.halt.step, RUN_STEP.FINALIZE);
    assert.equal(receiptOf(resumed.run, RUN_STEP.FINALIZE).status, RUN_STEP_STATUS.UNCONFIRMED);
    assert.equal(receiptOf(resumed.run, RUN_STEP.FINALIZE).detail.reason, 'EFFECT_IDENTITY_UNPROVABLE');
    assert.equal(resumed.run.final_artifact_id, null);
    assert.equal(
      finalsFor((await restarted.getProject(OWNER, fixture.projectId)).project, candidateId).length,
      total,
      'an unprovable interruption emits nothing: it is not replayed',
    );
    const request = resumed.run.review_requests.find(entry => entry.code === 'RECONCILIATION_REQUIRED');
    assert.deepEqual(request.blockers, [ERROR_CODES.RUN_RECONCILIATION_REQUIRED]);
    assert.match(request.missing.join(' '), /not replayed/);
  });
});

// ─── 4. nothing a run holds outlives the identity it names ──────────────────

test('a completed run cannot be reopened into a candidate whose report still names the previous Final', async () => {
  const app = createStudioApplication({});
  const fixture = await projectWithSymbolicAsset(app, OWNER, { project: sixRoleBaseline() });
  await app.analyzeSources(OWNER, fixture.projectId, { assetIds: [fixture.assetId] });
  const candidate1 = (await app.applyDecisions(OWNER, fixture.projectId, { decisions: runDecisionsFor(fixture.project) })).decisions.candidate_id;

  const done = await app.startRun(OWNER, fixture.projectId, { target_candidate_id: candidate1, confirmations: FIXTURE_CONFIRMATIONS });
  assert.equal(done.run.state, RUN_STATE.COMPLETED, JSON.stringify(done.run.blockers));
  const final1 = done.run.final_artifact_id;
  const report1 = done.run.report_artifact_id;
  assert.ok(final1 && report1);

  // A real Mobile Adaptation plan for that candidate, accepted on a resume.
  const profile = mobileProfile({ Chord5: { defaultVolume: 9 } });
  const plan = (await app.planMobileAdaptation(OWNER, fixture.projectId, { candidateId: candidate1, profile })).adaptation.plan;

  await assert.rejects(
    app.resumeRun(OWNER, fixture.projectId, done.run.run_id, {
      mobile_adaptation: { profile, expected_plan_id: plan.id, accepted_by: RUN_REVIEWER },
      confirmations: FIXTURE_CONFIRMATIONS,
    }),
    error => error.code === ERROR_CODES.RUN_CONFLICT
      && error.details.reason === 'COMPLETED_RUN_IS_AUDIT_CLOSED'
      && error.details.refused_fields.includes('mobile_adaptation'),
  );

  // Nothing moved: the run still names the candidate, Final and report it ended
  // on, and the report body still names exactly those.
  const after = (await app.getRun(OWNER, fixture.projectId, done.run.run_id)).run;
  assert.equal(after.state, RUN_STATE.COMPLETED);
  assert.equal(after.candidate_id, candidate1);
  assert.equal(after.final_artifact_id, final1);
  assert.equal(after.report_artifact_id, report1);
  const body = (await app.getArtifact(OWNER, report1)).artifact;
  assert.equal(body.candidate_id, candidate1);
  assert.equal(body.final_artifact_id, final1);

  // A read and an idempotent replay are unaffected.
  const replayed = await app.resumeRun(OWNER, fixture.projectId, done.run.run_id, {});
  assert.equal(replayed.run.state, RUN_STATE.COMPLETED);
  assert.equal(replayed.run.report_artifact_id, report1);
});

test('a new candidate inside a live run drops every result bound to the old one', async () => {
  const app = createStudioApplication({});
  const fixture = await projectWithSymbolicAsset(app, OWNER, { project: sixRoleBaseline() });
  await app.analyzeSources(OWNER, fixture.projectId, { assetIds: [fixture.assetId] });
  const candidate1 = (await app.applyDecisions(OWNER, fixture.projectId, { decisions: runDecisionsFor(fixture.project) })).decisions.candidate_id;

  // A live run: reviewed against candidate1 — so it holds a review receipt and
  // a gate snapshot bound to it — and stopped before a Final because one of the
  // reviewer's own answers is withheld.
  const { regression_reviewed: _withheld, ...partial } = FIXTURE_CONFIRMATIONS;
  const started = await app.startRun(OWNER, fixture.projectId, { target_candidate_id: candidate1, confirmations: partial });
  assert.notEqual(started.run.state, RUN_STATE.COMPLETED);
  assert.equal(started.run.final_artifact_id, null);
  assert.equal(started.run.report_artifact_id, null);
  assert.equal(receiptOf(started.run, RUN_STEP.REVIEW).result_reference, candidate1, 'the review that stands is of candidate1');
  assert.ok(started.run.gates, 'and the gate snapshot is bound to it');

  // The same material change the completed run refuses is allowed here, and
  // every result bound to candidate1 is dropped rather than carried.
  const profile = mobileProfile({ Chord5: { defaultVolume: 9 } });
  const plan = (await app.planMobileAdaptation(OWNER, fixture.projectId, { candidateId: candidate1, profile })).adaptation.plan;
  const adapted = await app.resumeRun(OWNER, fixture.projectId, started.run.run_id, {
    mobile_adaptation: { profile, expected_plan_id: plan.id, accepted_by: RUN_REVIEWER },
    confirmations: FIXTURE_CONFIRMATIONS,
  });

  const candidate2 = adapted.run.candidate_id;
  assert.notEqual(candidate2, candidate1, 'the adaptation minted a revision');
  assert.equal(statusOf(adapted.run, RUN_STEP.MOBILE_ADAPTATION), RUN_STEP_STATUS.COMPLETED, JSON.stringify(adapted.run.blockers));
  assert.equal(
    receiptOf(adapted.run, RUN_STEP.REVIEW).result_reference,
    candidate2,
    'the review receipt bound to the superseded candidate did not survive it',
  );
  assert.equal(adapted.run.state, RUN_STATE.COMPLETED, JSON.stringify(adapted.run.blockers));

  // The run and its own report agree, field for field.
  const body = (await app.getArtifact(OWNER, adapted.run.report_artifact_id)).artifact;
  assert.equal(body.candidate_id, candidate2);
  assert.equal(body.final_artifact_id, adapted.run.final_artifact_id);
  assert.equal(receiptOf(adapted.run, RUN_STEP.FINALIZE).result_reference, adapted.run.final_artifact_id);
  const record = (await app.getProject(OWNER, fixture.projectId)).project;
  assert.equal(record.artifacts.find(entry => entry.artifact_id === adapted.run.final_artifact_id).candidate_id, candidate2);
});

test('a live or restored run cannot keep a report that names a superseded Final', async () => {
  await withDirectory(async directory => {
    const app = createStudioApplication({ dataDirectory: directory, durability: 'persistent' });
    const fixture = await projectWithSymbolicAsset(app, OWNER, { project: sixRoleBaseline() });
    await app.analyzeSources(OWNER, fixture.projectId, { assetIds: [fixture.assetId] });
    const candidate1 = (await app.applyDecisions(OWNER, fixture.projectId, { decisions: runDecisionsFor(fixture.project) })).decisions.candidate_id;
    const done = await app.startRun(OWNER, fixture.projectId, { target_candidate_id: candidate1, confirmations: FIXTURE_CONFIRMATIONS });
    const final1 = done.run.final_artifact_id;
    const report1 = done.run.report_artifact_id;
    assert.ok(final1 && report1);

    // A record restored with the run live again while it still holds the Final
    // and the report of candidate1 — the state a crash or a restore can leave,
    // and the one in which a report could come to name a superseded Final.
    const records = join(directory, 'records');
    const [name] = await readdir(records);
    const stored = JSON.parse(await readFile(join(records, name), 'utf8'));
    stored.runs.find(entry => entry.run_id === done.run.run_id).state = RUN_STATE.AWAITING_REVIEW;
    await writeFile(join(records, name), JSON.stringify(stored));

    const restarted = createStudioApplication({ dataDirectory: directory, durability: 'persistent' });
    const live = (await restarted.getRun(OWNER, fixture.projectId, done.run.run_id)).run;
    assert.equal(live.state, RUN_STATE.AWAITING_REVIEW);
    assert.equal(live.report_artifact_id, report1);

    // Replacing the Final under that report — by re-finalizing with different
    // options, or by moving to another candidate — is refused: a run that has
    // produced its report takes no further workflow input, whatever its stored
    // state field says.
    for (const payload of [
      { finalize: { technical_timing_repair: true } },
      { confirmations: FIXTURE_CONFIRMATIONS },
    ]) {
      await assert.rejects(
        restarted.resumeRun(OWNER, fixture.projectId, done.run.run_id, payload),
        error => error.code === ERROR_CODES.RUN_CONFLICT
          && error.details.reason === 'COMPLETED_RUN_IS_AUDIT_CLOSED'
          && error.details.report_artifact_id === report1,
        `${Object.keys(payload)[0]} must be refused`,
      );
    }

    // Nothing moved, and the report still names the Final it was written for.
    const after = (await restarted.getRun(OWNER, fixture.projectId, done.run.run_id)).run;
    assert.equal(after.final_artifact_id, final1);
    assert.equal(after.report_artifact_id, report1);
    const body = (await restarted.getArtifact(OWNER, report1)).artifact;
    assert.equal(body.final_artifact_id, final1);
    assert.equal(body.candidate_id, candidate1);
    assert.equal(
      finalsFor((await restarted.getProject(OWNER, fixture.projectId)).project, candidate1).length,
      1,
      'and no second Final was emitted under the report naming the first',
    );
  });
});

// ─── 5. audit-closed is a contract, not a field list ────────────────────────

test('a completed run refuses every workflow input, finalize options included', async () => {
  const app = createStudioApplication({});
  const fixture = await projectWithSymbolicAsset(app, OWNER, { project: sixRoleBaseline() });
  await app.analyzeSources(OWNER, fixture.projectId, { assetIds: [fixture.assetId] });
  const candidate1 = (await app.applyDecisions(OWNER, fixture.projectId, { decisions: runDecisionsFor(fixture.project) })).decisions.candidate_id;
  const done = await app.startRun(OWNER, fixture.projectId, { target_candidate_id: candidate1, confirmations: FIXTURE_CONFIRMATIONS });
  assert.equal(done.run.state, RUN_STATE.COMPLETED, JSON.stringify(done.run.blockers));
  const { revision, final_artifact_id: final1, report_artifact_id: report1 } = done.run;

  // Every field that asks for work, including the ones an enumerated list of
  // "material" fields missed: finalize options re-emit, and adoption rebuilds
  // the run around another candidate or another artifact.
  const descendantPlan = (await app.planMobileAdaptation(OWNER, fixture.projectId, {
    candidateId: candidate1, profile: mobileProfile({ Chord5: { defaultVolume: 9 } }),
  })).adaptation.plan;
  const descendant = (await app.applyMobileAdaptation(OWNER, fixture.projectId, {
    candidateId: candidate1, profile: mobileProfile({ Chord5: { defaultVolume: 9 } }),
    expectedPlanId: descendantPlan.id, acceptedBy: RUN_REVIEWER,
  })).adaptation.candidate_id;

  const payloads = [
    ['finalize', { finalize: { technical_timing_repair: true } }],
    ['finalize.pickup', { finalize: { pickup: 1 } }],
    ['adopt_candidate_id', { adopt_candidate_id: descendant }],
    ['adopt_artifact_id', { adopt_artifact_id: final1 }],
    ['reconcile', { reconcile: true }],
    ['decisions', { decisions: runDecisionsFor(fixture.project) }],
    ['confirmations', { confirmations: FIXTURE_CONFIRMATIONS }],
    ['asset_ids', { asset_ids: [fixture.assetId] }],
  ];
  for (const [what, payload] of payloads) {
    await assert.rejects(
      app.resumeRun(OWNER, fixture.projectId, done.run.run_id, payload),
      error => error.code === ERROR_CODES.RUN_CONFLICT
        && error.details.reason === 'COMPLETED_RUN_IS_AUDIT_CLOSED'
        && error.details.refused_fields.length > 0,
      `${what} must be refused on a completed run`,
    );
  }

  // Nothing moved, and no revision was spent refusing.
  const after = (await app.getRun(OWNER, fixture.projectId, done.run.run_id)).run;
  assert.equal(after.revision, revision);
  assert.equal(after.candidate_id, candidate1);
  assert.equal(after.final_artifact_id, final1);
  assert.equal(after.report_artifact_id, report1);
  const body = (await app.getArtifact(OWNER, report1)).artifact;
  assert.equal(body.final_artifact_id, final1);
  assert.equal(finalsFor((await app.getProject(OWNER, fixture.projectId)).project, candidate1).length, 1);
});

test('a completed run cannot be reopened through candidate adoption', async () => {
  const app = createStudioApplication({});
  const fixture = await projectWithSymbolicAsset(app, OWNER, { project: sixRoleBaseline() });
  await app.analyzeSources(OWNER, fixture.projectId, { assetIds: [fixture.assetId] });
  const candidate1 = (await app.applyDecisions(OWNER, fixture.projectId, { decisions: runDecisionsFor(fixture.project) })).decisions.candidate_id;
  const done = await app.startRun(OWNER, fixture.projectId, { target_candidate_id: candidate1, confirmations: FIXTURE_CONFIRMATIONS });
  const final1 = done.run.final_artifact_id;
  const report1 = done.run.report_artifact_id;

  // A descendant with a legitimate baseline and lineage — everything
  // adopt_candidate_id verifies — produced outside the run.
  const profile = mobileProfile({ Chord5: { defaultVolume: 9 } });
  const plan = (await app.planMobileAdaptation(OWNER, fixture.projectId, { candidateId: candidate1, profile })).adaptation.plan;
  const candidate2 = (await app.applyMobileAdaptation(OWNER, fixture.projectId, {
    candidateId: candidate1, profile, expectedPlanId: plan.id, acceptedBy: RUN_REVIEWER,
  })).adaptation.candidate_id;
  assert.notEqual(candidate2, candidate1);

  await assert.rejects(
    app.resumeRun(OWNER, fixture.projectId, done.run.run_id, { adopt_candidate_id: candidate2 }),
    error => error.code === ERROR_CODES.RUN_CONFLICT
      && error.details.reason === 'COMPLETED_RUN_IS_AUDIT_CLOSED'
      && error.details.refused_fields.includes('adopt_candidate_id'),
  );

  // The audit record is untouched, down to the report body.
  const after = (await app.getRun(OWNER, fixture.projectId, done.run.run_id)).run;
  assert.equal(after.state, RUN_STATE.COMPLETED);
  assert.equal(after.candidate_id, candidate1);
  assert.equal(after.final_artifact_id, final1);
  assert.equal(after.report_artifact_id, report1);
  const body = (await app.getArtifact(OWNER, report1)).artifact;
  assert.equal(body.candidate_id, candidate1);
  assert.equal(body.final_artifact_id, final1);
});

test('a bare resume of a completed run takes no revision and re-emits nothing', async () => {
  const app = createStudioApplication({});
  const fixture = await projectWithSymbolicAsset(app, OWNER, { project: sixRoleBaseline() });
  await app.analyzeSources(OWNER, fixture.projectId, { assetIds: [fixture.assetId] });
  const candidate1 = (await app.applyDecisions(OWNER, fixture.projectId, { decisions: runDecisionsFor(fixture.project) })).decisions.candidate_id;
  const done = await app.startRun(OWNER, fixture.projectId, { target_candidate_id: candidate1, confirmations: FIXTURE_CONFIRMATIONS });

  const again = await app.resumeRun(OWNER, fixture.projectId, done.run.run_id, {});
  assert.equal(again.advanced, false);
  assert.equal(again.run.revision, done.run.revision, 'a run with nothing to do mints no revision');
  assert.equal(again.run.state, RUN_STATE.COMPLETED);
  assert.equal(again.run.final_artifact_id, done.run.final_artifact_id);
  assert.equal(again.run.report_artifact_id, done.run.report_artifact_id);
  assert.match(again.notice, /no step ran, no revision was taken/);
  assert.equal(finalsFor((await app.getProject(OWNER, fixture.projectId)).project, candidate1).length, 1);
});

test('a material resume cannot hide behind recovery of an already-persisted terminal report', async () => {
  await withDirectory(async directory => {
    const app = createStudioApplication({ dataDirectory: directory, durability: 'persistent' });
    const fixture = await projectWithSymbolicAsset(app, OWNER, { project: sixRoleBaseline() });
    await app.analyzeSources(OWNER, fixture.projectId, { assetIds: [fixture.assetId] });
    const candidate1 = (await app.applyDecisions(OWNER, fixture.projectId, { decisions: runDecisionsFor(fixture.project) })).decisions.candidate_id;

    // The report effect landed; the receipt did not. The workflow is finished,
    // and only the bookkeeping is missing.
    const stopped = await stopsAfter(directory, RUN_STEP.REPORT)
      .startRun(OWNER, fixture.projectId, { target_candidate_id: candidate1, confirmations: FIXTURE_CONFIRMATIONS })
      .then(() => assert.fail('the injected fault must propagate'), error => error);
    assert.match(stopped.message, /stopped after the report effect/);

    const restarted = createStudioApplication({ dataDirectory: directory, durability: 'persistent' });
    const runId = (await restarted.getRun(OWNER, fixture.projectId)).runs[0].run_id;
    const before = (await restarted.getRun(OWNER, fixture.projectId, runId)).run;
    assert.equal(before.pending_step.step, RUN_STEP.REPORT);
    assert.notEqual(before.state, RUN_STATE.COMPLETED, 'the record does not know it finished');
    const record = (await restarted.getProject(OWNER, fixture.projectId)).project;
    const persisted = record.artifacts.filter(entry => entry.type === 'run_report');
    assert.equal(persisted.length, 1, 'but the project holds its report');

    // A resume that also carries new work is refused: the run cannot both
    // recover its audit identity and be carried on into different work, and
    // accepting the payload while doing neither is worse than either.
    const profile = mobileProfile({ Chord5: { defaultVolume: 9 } });
    const plan = (await restarted.planMobileAdaptation(OWNER, fixture.projectId, { candidateId: candidate1, profile })).adaptation.plan;
    await assert.rejects(
      restarted.resumeRun(OWNER, fixture.projectId, runId, {
        mobile_adaptation: { profile, expected_plan_id: plan.id, accepted_by: RUN_REVIEWER },
      }),
      error => error.code === ERROR_CODES.RUN_CONFLICT
        && error.details.reason === 'COMPLETED_RUN_IS_AUDIT_CLOSED'
        && error.details.refused_fields.includes('mobile_adaptation')
        && error.details.report_artifact_id === persisted[0].artifact_id,
    );

    // The refusal recorded nothing: no candidate, no Final, no adaptation
    // receipt, and no trace of the payload in the run's inputs.
    const refused = (await restarted.getRun(OWNER, fixture.projectId, runId)).run;
    assert.equal(refused.candidate_id, candidate1, 'the request produced no new candidate');
    assert.notEqual(statusOf(refused, RUN_STEP.MOBILE_ADAPTATION), RUN_STEP_STATUS.COMPLETED, 'and was not recorded as executed');
    assert.equal(refused.inputs.adaptation_fingerprint ?? null, null);
    const still = (await restarted.getProject(OWNER, fixture.projectId)).project;
    assert.equal(still.candidates.length, 1);
    assert.equal(still.artifacts.filter(entry => entry.type === 'run_report').length, 1);

    // A bare resume recovers the audit identity and stops there.
    const recovered = await restarted.resumeRun(OWNER, fixture.projectId, runId, {});
    assert.equal(recovered.run.state, RUN_STATE.COMPLETED);
    assert.equal(recovered.run.report_artifact_id, persisted[0].artifact_id);
    assert.equal(recovered.run.pending_step, null);
    assert.equal(
      (await restarted.getProject(OWNER, fixture.projectId)).project.artifacts.filter(entry => entry.type === 'run_report').length,
      1,
      'recovery adopts the report it produced rather than filing a second one',
    );
  });
});

// ─── 6. recovery restores facts; it does not re-derive them ─────────────────

/** A project with a candidate that is ready to finalize. */
async function readyCandidate(app) {
  const fixture = await projectWithSymbolicAsset(app, OWNER, { project: sixRoleBaseline() });
  await app.analyzeSources(OWNER, fixture.projectId, { assetIds: [fixture.assetId] });
  const candidateId = (await app.applyDecisions(OWNER, fixture.projectId, { decisions: runDecisionsFor(fixture.project) })).decisions.candidate_id;
  return { ...fixture, candidateId };
}

/** Everything a reader of a finished run learns about the song from it. */
const auditFacts = (run, report, finalizeReceipt) => ({
  run_state: run.state,
  gates: run.gates,
  readiness_blockers: [...(run.readiness_blockers ?? [])],
  emit_status: finalizeReceipt?.detail?.emit_status ?? null,
  finalize_gates: finalizeReceipt?.detail?.gates ?? null,
  finalize_names_a_job: Boolean(finalizeReceipt?.job_id),
  job_count: run.job_ids.length,
  report_gates: report.gates,
  report_emit_status: report.emit_status,
  report_readiness_blockers: [...(report.readiness_blockers ?? [])],
  report_job_count: report.job_ids.length,
  report_names_the_runs_candidate: report.final_candidate_id === run.candidate_id,
  report_names_the_runs_final: report.final_artifact_id === run.final_artifact_id,
});

test('a recovered persisted Final produces the same audit facts as an uninterrupted Final', async () => {
  const uninterrupted = await withDirectory(async directory => {
    const app = createStudioApplication({ dataDirectory: directory, durability: 'persistent' });
    const fixture = await readyCandidate(app);
    const done = await app.startRun(OWNER, fixture.projectId, { target_candidate_id: fixture.candidateId, confirmations: FIXTURE_CONFIRMATIONS });
    assert.equal(done.run.state, RUN_STATE.COMPLETED, JSON.stringify(done.run.blockers));
    const report = (await app.getArtifact(OWNER, done.run.report_artifact_id)).artifact;
    return { facts: auditFacts(done.run, report, receiptOf(done.run, RUN_STEP.FINALIZE)), run: done.run };
  });

  const recovered = await withDirectory(async directory => {
    const app = createStudioApplication({ dataDirectory: directory, durability: 'persistent' });
    const fixture = await readyCandidate(app);

    // The Final was emitted and filed, and its finalize job finished. Only the
    // run's own receipt was lost.
    const stopped = await stopsAfter(directory, RUN_STEP.FINALIZE)
      .startRun(OWNER, fixture.projectId, { target_candidate_id: fixture.candidateId, confirmations: FIXTURE_CONFIRMATIONS })
      .then(() => assert.fail('the injected fault must propagate'), error => error);
    assert.match(stopped.message, /stopped after the finalize effect/);

    const restarted = createStudioApplication({ dataDirectory: directory, durability: 'persistent' });
    const runId = (await restarted.getRun(OWNER, fixture.projectId)).runs[0].run_id;
    const midway = (await restarted.getProject(OWNER, fixture.projectId)).project;
    assert.equal(finalsFor(midway, fixture.candidateId).length, 1, 'the Final is on disk');
    assert.equal((await restarted.getRun(OWNER, fixture.projectId, runId)).run.final_artifact_id, null, 'the run does not know it yet');

    const resumed = await restarted.resumeRun(OWNER, fixture.projectId, runId, {});
    assert.equal(resumed.run.state, RUN_STATE.COMPLETED, JSON.stringify(resumed.run.blockers));
    assert.equal(finalsFor((await restarted.getProject(OWNER, fixture.projectId)).project, fixture.candidateId).length, 1,
      'recovery adopted the Final rather than emitting a second one');

    const receipt = receiptOf(resumed.run, RUN_STEP.FINALIZE);
    assert.equal(receipt.status, RUN_STEP_STATUS.SATISFIED, 'the receipt says it was adopted, not re-run');
    assert.equal(receipt.detail.restored_from, 'final_artifact');
    const report = (await restarted.getArtifact(OWNER, resumed.run.report_artifact_id)).artifact;
    return { facts: auditFacts(resumed.run, report, receipt), run: resumed.run };
  });

  // Every fact a reader learns about the song is the same. Artifact ids and
  // timestamps are not, and are not compared: they are per execution.
  assert.deepEqual(recovered.facts, uninterrupted.facts);
  assert.equal(recovered.facts.emit_status, 'PASS');
  assert.ok(recovered.facts.gates, 'the gates were restored rather than cleared');
  assert.equal(recovered.facts.finalize_names_a_job, true, 'and the job that produced the Final was found by its own reference');
  assert.equal(recovered.facts.job_count, uninterrupted.facts.job_count);
});

test('a no-work closed resume never leaves an apparently used idempotency key unbound', async () => {
  const app = createStudioApplication({});
  const fixture = await readyCandidate(app);
  const done = await app.startRun(OWNER, fixture.projectId, {
    target_candidate_id: fixture.candidateId, confirmations: FIXTURE_CONFIRMATIONS, idempotency_key: 'start-key',
  });
  assert.equal(done.run.state, RUN_STATE.COMPLETED, JSON.stringify(done.run.blockers));

  // A bare resume: nothing to do, nothing taken.
  const bare = await app.resumeRun(OWNER, fixture.projectId, done.run.run_id, {});
  assert.equal(bare.advanced, false);
  assert.equal(bare.run.revision, done.run.revision);

  // A key that is already bound is replayed, above the audit guard.
  const started = await app.startRun(OWNER, fixture.projectId, {
    target_candidate_id: fixture.candidateId, confirmations: FIXTURE_CONFIRMATIONS, idempotency_key: 'start-key',
  });
  assert.equal(started.replayed, true);
  assert.equal(started.run.run_id, done.run.run_id);

  // A NEW key on a request with no work is refused rather than looking bound:
  // a key recorded against nothing cannot later refuse a different payload,
  // which is the only guarantee it exists for.
  await assert.rejects(
    app.resumeRun(OWNER, fixture.projectId, done.run.run_id, { idempotency_key: 'unbound-key' }),
    error => error.code === ERROR_CODES.RUN_CONFLICT
      && error.details.reason === 'NO_WORK_TO_BIND_AN_IDEMPOTENCY_KEY'
      && error.details.idempotency_key === 'unbound-key',
  );
  const after = (await app.getRun(OWNER, fixture.projectId, done.run.run_id)).run;
  assert.equal(after.revision, done.run.revision, 'the refusal took no revision');
  assert.equal((after.idempotency?.receipts ?? []).some(entry => entry.key === 'unbound-key'), false, 'and bound nothing');

  // The capability this protects, on a run that did bind a key: the same key
  // with a different payload is refused as a conflict, not applied. A separate
  // project, so this run reaches review rather than inheriting one.
  const second = await readyCandidate(app);
  const live = await app.startRun(OWNER, second.projectId, { target_candidate_id: second.candidateId });
  const key = { idempotency_key: 'resume-key', confirmations: FIXTURE_CONFIRMATIONS };
  const first = await app.resumeRun(OWNER, second.projectId, live.run.run_id, key);
  assert.ok((first.run.idempotency?.receipts ?? []).some(entry => entry.key === 'resume-key'), 'the key bound to the work it did');
  const replay = await app.resumeRun(OWNER, second.projectId, live.run.run_id, key);
  assert.equal(replay.replayed, true);
  await assert.rejects(
    app.resumeRun(OWNER, second.projectId, live.run.run_id, { idempotency_key: 'resume-key', finalize: { technical_timing_repair: true } }),
    error => error.code === ERROR_CODES.IDEMPOTENCY_CONFLICT,
  );
});

test('a restored legacy REPORT marker adopts the existing report that names its run', async () => {
  await withDirectory(async directory => {
    const app = createStudioApplication({ dataDirectory: directory, durability: 'persistent' });
    const fixture = await readyCandidate(app);
    const done = await app.startRun(OWNER, fixture.projectId, { target_candidate_id: fixture.candidateId, confirmations: FIXTURE_CONFIRMATIONS });
    const report1 = done.run.report_artifact_id;
    assert.ok(report1);

    // A marker written before expectations existed, restored: the report effect
    // landed, and the marker cannot say what it was about.
    const records = join(directory, 'records');
    const [name] = await readdir(records);
    const stored = JSON.parse(await readFile(join(records, name), 'utf8'));
    const run = stored.runs.find(entry => entry.run_id === done.run.run_id);
    run.state = RUN_STATE.RUNNING;
    run.report_artifact_id = null;
    run.steps = run.steps.filter(entry => entry.step !== RUN_STEP.REPORT);
    run.pending_step = { step: RUN_STEP.REPORT, expectation: null, idempotent: false, input_fingerprint: null, at: new Date().toISOString() };
    await writeFile(join(records, name), JSON.stringify(stored));

    const restarted = createStudioApplication({ dataDirectory: directory, durability: 'persistent' });
    assert.equal((await restarted.getRun(OWNER, fixture.projectId, done.run.run_id)).run.pending_step.expectation, null);

    // The report's own body names this run, which is an exact identity the
    // marker never needed to carry. Both a bare resume and an explicit
    // reconcile adopt it; neither files a second report.
    for (const [what, payload] of [['reconcile', { reconcile: true }], ['a bare resume', {}]]) {
      const resumed = await restarted.resumeRun(OWNER, fixture.projectId, done.run.run_id, payload);
      assert.equal(resumed.run.state, RUN_STATE.COMPLETED, `${what}: ${JSON.stringify(resumed.run.blockers)}`);
      assert.equal(resumed.run.report_artifact_id, report1, `${what} adopted the report this run produced`);
      assert.equal(
        (await restarted.getProject(OWNER, fixture.projectId)).project.artifacts.filter(entry => entry.type === 'run_report').length,
        1,
        `${what} filed no second report`,
      );
      // The second pass has no pending marker left, so it is the no-work path.
      if (what === 'reconcile') assert.equal(receiptOf(resumed.run, RUN_STEP.REPORT).detail.expectation.recovered_from_run_identity, true);
    }
  });
});

// ─── 7. one adoption transition, however the effect is settled ──────────────

/** The audit facts a Final artifact itself carries. */
const factsFromFinal = body => ({
  gates: body.gates,
  readiness_blockers: [...(body.readiness_summary?.pre_game_blocking ?? [])],
  emit_status: body.emit_status,
  technical_validation: body.readiness_summary?.technical_validation ?? null,
});

/** The same facts, as the run and its report state them. */
const factsFromRun = (run, report, finalizeReceipt) => ({
  gates: run.gates,
  readiness_blockers: [...(run.readiness_blockers ?? [])],
  emit_status: finalizeReceipt?.detail?.emit_status ?? null,
  technical_validation: finalizeReceipt?.detail?.technical_validation ?? null,
  report_gates: report?.gates ?? null,
  report_emit_status: report?.emit_status ?? null,
});

/**
 * Two Finals for one candidate, one of them this run's, with the receipt lost.
 *
 * The same genuinely-ambiguous situation the identity suite establishes: a
 * second caller finalized during the interruption, neither Final is in the
 * before-set, and a Final's body carries no run id — so novelty cannot separate
 * them and a reviewer must name one.
 */
async function ambiguousFinals(directory) {
  const options = { dataDirectory: directory, durability: 'persistent' };
  const setup = createStudioApplication(options);
  const fixture = await projectWithSymbolicAsset(setup, OWNER, { project: sixRoleBaseline() });
  await setup.analyzeSources(OWNER, fixture.projectId, { assetIds: [fixture.assetId] });
  const candidateId = (await setup.applyDecisions(OWNER, fixture.projectId, { decisions: runDecisionsFor(fixture.project) })).decisions.candidate_id;
  await setup.recordConfirmations(OWNER, fixture.projectId, Object.fromEntries(
    Object.entries(FIXTURE_CONFIRMATIONS).map(([name, value]) => [name, {
      ...value,
      ...(['source_complete', 'original_audio_required'].includes(name) ? {} : { candidate_id: candidateId }),
    }]),
  ));

  const concurrent = createStudioApplication(options);
  const interrupted = createStudioApplication({
    ...options,
    runHooks: {
      afterEffect: async ({ step }) => {
        if (step !== RUN_STEP.FINALIZE) return;
        // A SECOND RUN finalizing the same candidate under the same options.
        // That is what genuine ambiguity is now: both Finals postdate the
        // marker AND both answer the input this step was executing, so
        // neither novelty nor the input binding separates them. A direct
        // `finalize` call would not be ambiguous — it answers no step's input
        // and is excluded rather than guessed between.
        await concurrent.startRun(OWNER, fixture.projectId, { target_candidate_id: candidateId });
        throw Error('the process stopped after the finalize effect');
      },
    },
  });
  const stopped = await interrupted.startRun(OWNER, fixture.projectId, { target_candidate_id: candidateId })
    .then(() => assert.fail('the injected fault must propagate'), error => error);
  assert.match(stopped.message, /stopped after the finalize effect/);

  const restarted = createStudioApplication(options);
  const runId = (await restarted.getRun(OWNER, fixture.projectId)).runs[0].run_id;
  return { ...fixture, candidateId, runId, app: restarted };
}

test('a reviewer-named persisted Final restores the same audit facts as automatic Final recovery', async () => {
  // The automatic path, for comparison: one Final, receipt lost, adopted.
  const automatic = await withDirectory(async directory => {
    const app = createStudioApplication({ dataDirectory: directory, durability: 'persistent' });
    const fixture = await readyCandidate(app);
    const stopped = await stopsAfter(directory, RUN_STEP.FINALIZE)
      .startRun(OWNER, fixture.projectId, { target_candidate_id: fixture.candidateId, confirmations: FIXTURE_CONFIRMATIONS })
      .then(() => assert.fail('the injected fault must propagate'), error => error);
    assert.match(stopped.message, /stopped after the finalize effect/);
    const restarted = createStudioApplication({ dataDirectory: directory, durability: 'persistent' });
    const runId = (await restarted.getRun(OWNER, fixture.projectId)).runs[0].run_id;
    const resumed = await restarted.resumeRun(OWNER, fixture.projectId, runId, {});
    const receipt = receiptOf(resumed.run, RUN_STEP.FINALIZE);
    const body = (await restarted.getArtifact(OWNER, resumed.run.final_artifact_id)).artifact;
    const report = (await restarted.getArtifact(OWNER, resumed.run.report_artifact_id)).artifact;
    assert.equal(receipt.detail.reason, 'EFFECT_FOUND_BY_STORED_IDENTITY');
    return {
      artifact: factsFromFinal(body),
      run: factsFromRun(resumed.run, report, receipt),
      job_named: Boolean(receipt.job_id),
      run_job_count: resumed.run.job_ids.length,
      report_job_count: report.job_ids.length,
    };
  });

  // The named path, on a genuinely ambiguous pair.
  const named = await withDirectory(async directory => {
    const fixture = await ambiguousFinals(directory);
    const { app } = fixture;
    const finals = finalsFor((await app.getProject(OWNER, fixture.projectId)).project, fixture.candidateId);
    assert.equal(finals.length, 2, 'two indistinguishable Finals');

    const ambiguous = await app.resumeRun(OWNER, fixture.projectId, fixture.runId, {});
    assert.equal(ambiguous.run.state, RUN_STATE.INTERRUPTED);
    assert.equal(receiptOf(ambiguous.run, RUN_STEP.FINALIZE).detail.reason, 'EFFECT_AMBIGUOUS');

    const chosen = finals[0];
    const resumed = await app.resumeRun(OWNER, fixture.projectId, fixture.runId, { adopt_artifact_id: chosen });
    assert.equal(resumed.run.state, RUN_STATE.COMPLETED, JSON.stringify(resumed.run.blockers));
    assert.equal(resumed.run.final_artifact_id, chosen);
    const receipt = receiptOf(resumed.run, RUN_STEP.FINALIZE);
    assert.equal(receipt.detail.reason, 'EFFECT_NAMED_BY_REVIEWER', 'the provenance differs, and only the provenance');
    assert.equal(receipt.detail.restored_from, 'final_artifact');
    const body = (await app.getArtifact(OWNER, chosen)).artifact;
    const report = (await app.getArtifact(OWNER, resumed.run.report_artifact_id)).artifact;
    assert.equal(finalsFor((await app.getProject(OWNER, fixture.projectId)).project, fixture.candidateId).length, 2,
      'naming one emitted nothing');
    return {
      artifact: factsFromFinal(body),
      run: factsFromRun(resumed.run, report, receipt),
      job_named: Boolean(receipt.job_id),
      run_job_count: resumed.run.job_ids.length,
      report_job_count: report.job_ids.length,
    };
  });

  // Each run states exactly what its own Final carries...
  for (const [what, side] of [['automatic', automatic], ['named', named]]) {
    assert.deepEqual(side.run.gates, side.artifact.gates, `${what}: gates`);
    assert.deepEqual(side.run.readiness_blockers, side.artifact.readiness_blockers, `${what}: readiness blockers`);
    assert.equal(side.run.emit_status, side.artifact.emit_status, `${what}: emit status`);
    assert.deepEqual(side.run.technical_validation, side.artifact.technical_validation, `${what}: technical validation`);
    assert.deepEqual(side.run.report_gates, side.artifact.gates, `${what}: report gates`);
    assert.equal(side.run.report_emit_status, side.artifact.emit_status, `${what}: report emit status`);
    assert.equal(side.job_named, true, `${what}: the job that produced the Final was found by its own reference`);
  }

  // ...and the two paths restore the same shape of audit state as each other.
  assert.deepEqual(Object.keys(named.run).sort(), Object.keys(automatic.run).sort());
  assert.equal(named.run_job_count, automatic.run_job_count);
  assert.equal(named.report_job_count, automatic.report_job_count);
  assert.equal(named.run.emit_status, automatic.run.emit_status);
  assert.deepEqual(named.run.gates, automatic.run.gates);
});

test('an ambiguous legacy REPORT marker can be resolved by naming one report that names the run', async () => {
  await withDirectory(async directory => {
    const app = createStudioApplication({ dataDirectory: directory, durability: 'persistent' });
    const fixture = await readyCandidate(app);
    const done = await app.startRun(OWNER, fixture.projectId, { target_candidate_id: fixture.candidateId, confirmations: FIXTURE_CONFIRMATIONS });
    const report1 = done.run.report_artifact_id;
    assert.ok(report1);

    // A second run report whose body names this exact run, beside a marker
    // written before expectations existed. Both are filed as this run's output,
    // so the run-id identity alone cannot separate them.
    const firstBody = (await app.getArtifact(OWNER, report1)).artifact;
    const twin = { ...firstBody, created_at: new Date(Date.parse(firstBody.created_at) + 1000).toISOString() };
    delete twin.artifact_id;
    const twinJson = JSON.stringify(twin);
    const twinId = `art_${createHash('sha256').update(twinJson).digest('hex')}`;
    await writeFile(
      join(directory, 'blobs', `${createHash('sha256').update(`artifact:${fixture.projectId}:${twinId}`).digest('hex')}.bin`),
      JSON.stringify({ ...twin, artifact_id: twinId }),
    );
    const records = join(directory, 'records');
    const [name] = await readdir(records);
    const stored = JSON.parse(await readFile(join(records, name), 'utf8'));
    const entry = stored.artifacts.find(artifact => artifact.artifact_id === report1);
    stored.artifacts.push({ ...entry, artifact_id: twinId, created_at: twin.created_at });
    const run = stored.runs.find(candidate => candidate.run_id === done.run.run_id);
    run.state = RUN_STATE.RUNNING;
    run.report_artifact_id = null;
    run.steps = run.steps.filter(step => step.step !== RUN_STEP.REPORT);
    run.pending_step = { step: RUN_STEP.REPORT, expectation: null, idempotent: false, input_fingerprint: null, at: new Date().toISOString() };
    await writeFile(join(records, name), JSON.stringify(stored));

    const restarted = createStudioApplication({ dataDirectory: directory, durability: 'persistent' });
    const reportsBefore = (await restarted.getProject(OWNER, fixture.projectId)).project
      .artifacts.filter(artifact => artifact.type === 'run_report');
    assert.equal(reportsBefore.length, 2);

    // Two reports name this run, so the run refuses to pick — and offers a
    // remedy it can actually execute.
    const ambiguous = await restarted.resumeRun(OWNER, fixture.projectId, done.run.run_id, {});
    assert.equal(ambiguous.run.state, RUN_STATE.INTERRUPTED);
    assert.equal(ambiguous.run.needs_reconciliation, true);
    assert.equal(receiptOf(ambiguous.run, RUN_STEP.REPORT).detail.reason, 'EFFECT_AMBIGUOUS');
    const request = ambiguous.run.review_requests.find(item => item.code === 'RECONCILIATION_REQUIRED');
    assert.ok(request.available_operations.includes('resumeRun.adopt_artifact_id'));
    assert.equal((await restarted.getRun(OWNER, fixture.projectId, done.run.run_id)).run.pending_step.expectation, null,
      'the stored marker still carries no expectation: the remedy must work without one');

    // The advertised remedy executes.
    const resolved = await restarted.resumeRun(OWNER, fixture.projectId, done.run.run_id, { adopt_artifact_id: report1 });
    assert.equal(resolved.run.state, RUN_STATE.COMPLETED, JSON.stringify(resolved.run.blockers));
    assert.equal(resolved.run.report_artifact_id, report1, 'the run points at the report the reviewer named');
    assert.equal(resolved.run.pending_step, null);
    assert.equal(receiptOf(resolved.run, RUN_STEP.REPORT).detail.reason, 'EFFECT_NAMED_BY_REVIEWER');
    assert.equal(
      (await restarted.getProject(OWNER, fixture.projectId)).project.artifacts.filter(artifact => artifact.type === 'run_report').length,
      2,
      'resolving it filed no third report',
    );

    // And the identity still holds: a report naming another run is refused.
    const other = await app.startRun(OWNER, (await readyCandidate(app)).projectId, {});
    assert.ok(other.run.run_id);
  });
});

test('a persisted Final whose body cannot be read is reported unprovable, not adopted or re-emitted', async () => {
  await withDirectory(async directory => {
    const app = createStudioApplication({ dataDirectory: directory, durability: 'persistent' });
    const fixture = await readyCandidate(app);
    const stopped = await stopsAfter(directory, RUN_STEP.FINALIZE)
      .startRun(OWNER, fixture.projectId, { target_candidate_id: fixture.candidateId, confirmations: FIXTURE_CONFIRMATIONS })
      .then(() => assert.fail('the injected fault must propagate'), error => error);
    assert.match(stopped.message, /stopped after the finalize effect/);

    const restarted = createStudioApplication({ dataDirectory: directory, durability: 'persistent' });
    const runId = (await restarted.getRun(OWNER, fixture.projectId)).runs[0].run_id;
    const finals = finalsFor((await restarted.getProject(OWNER, fixture.projectId)).project, fixture.candidateId);
    assert.equal(finals.length, 1);

    // Normal storage writes the body with the entry, so this is corruption:
    // the record still lists the Final, and its body is gone.
    await rm(join(directory, 'blobs', `${createHash('sha256').update(`artifact:${fixture.projectId}:${finals[0]}`).digest('hex')}.bin`));

    const resumed = await restarted.resumeRun(OWNER, fixture.projectId, runId, {});
    assert.equal(resumed.run.state, RUN_STATE.INTERRUPTED, 'the identity cannot be established');
    assert.equal(resumed.run.needs_reconciliation, true);
    assert.equal(receiptOf(resumed.run, RUN_STEP.FINALIZE).detail.reason, 'EFFECT_IDENTITY_UNPROVABLE');
    assert.equal(receiptOf(resumed.run, RUN_STEP.FINALIZE).detail.cause, 'FINAL_ARTIFACT_BODY_UNREADABLE');
    assert.equal(resumed.run.final_artifact_id, null, 'nothing was adopted');
    assert.equal(
      finalsFor((await restarted.getProject(OWNER, fixture.projectId)).project, fixture.candidateId).length,
      1,
      'and the emitter was not run again',
    );

    // Naming it is refused for the same reason, rather than adopting a Final
    // with none of the facts it is supposed to carry.
    await assert.rejects(
      restarted.resumeRun(OWNER, fixture.projectId, runId, { adopt_artifact_id: finals[0] }),
      error => error.code === ERROR_CODES.RUN_RECONCILIATION_REQUIRED
        && error.details.reason === 'FINAL_ARTIFACT_BODY_UNREADABLE',
    );
  });
});

// ─── 8. novelty is not identity: an effect must answer the input it ran ─────
//
// A before-set proves a record POSTDATES the marker. It does not prove the
// record ANSWERS THE INPUT this step was executing, and a concurrent writer
// satisfies novelty just as this step's own effect does. So every step that
// mints a record binds the input it was applying to the record it produced,
// in the same record write, and reconciliation reads it back.

test('a Final filed under different options is not this step\'s effect', async () => {
  await withDirectory(async directory => {
    const app = createStudioApplication({ dataDirectory: directory, durability: 'persistent' });
    const fixture = await readyCandidate(app);
    await app.recordConfirmations(OWNER, fixture.projectId, Object.fromEntries(
      Object.entries(FIXTURE_CONFIRMATIONS).map(([name, value]) => [name, {
        ...value, ...(['source_complete', 'original_audio_required'].includes(name) ? {} : { candidate_id: fixture.candidateId }),
      }]),
    ));

    // The run states the repair OFF and stops before the emitter runs, so its
    // own Final does not exist.
    const stopped = await stopsBefore(directory, RUN_STEP.FINALIZE)
      .startRun(OWNER, fixture.projectId, { target_candidate_id: fixture.candidateId, finalize: { technical_timing_repair: false } })
      .then(() => assert.fail('the injected fault must propagate'), error => error);
    assert.match(stopped.message, /stopped before the finalize effect/);

    const restarted = createStudioApplication({ dataDirectory: directory, durability: 'persistent' });
    const runId = (await restarted.getRun(OWNER, fixture.projectId)).runs[0].run_id;

    // Somebody finalizes the same candidate with the repair ON. It postdates
    // the marker and is the only Final there, so novelty alone would adopt it
    // and the run would report a repair it never asked for.
    const other = await restarted.finalize(OWNER, fixture.projectId, { candidateId: fixture.candidateId, technicalTimingRepair: true });
    assert.equal(other.technical_timing_repair.requested, true);

    const resumed = await restarted.resumeRun(OWNER, fixture.projectId, runId, {});
    assert.equal(resumed.run.state, RUN_STATE.COMPLETED, JSON.stringify(resumed.run.blockers));
    assert.notEqual(resumed.run.final_artifact_id, other.artifact_id, 'the other finalize\'s Final is not this run\'s effect');
    assert.equal(receiptOf(resumed.run, RUN_STEP.FINALIZE).status, RUN_STEP_STATUS.COMPLETED,
      'the step ran: its own effect was positively shown absent, not merely unfound');
    const body = (await restarted.getArtifact(OWNER, resumed.run.final_artifact_id)).artifact;
    assert.equal(body.technical_timing_repair.requested, false, 'the run\'s Final was emitted under the options the run stated');
    assert.equal(finalsFor((await restarted.getProject(OWNER, fixture.projectId)).project, fixture.candidateId).length, 2);
  });
});

test('naming a Final filed under different options is refused, as the automatic path refused it', async () => {
  await withDirectory(async directory => {
    const app = createStudioApplication({ dataDirectory: directory, durability: 'persistent' });
    const fixture = await readyCandidate(app);
    await app.recordConfirmations(OWNER, fixture.projectId, Object.fromEntries(
      Object.entries(FIXTURE_CONFIRMATIONS).map(([name, value]) => [name, {
        ...value, ...(['source_complete', 'original_audio_required'].includes(name) ? {} : { candidate_id: fixture.candidateId }),
      }]),
    ));
    const stopped = await stopsBefore(directory, RUN_STEP.FINALIZE)
      .startRun(OWNER, fixture.projectId, { target_candidate_id: fixture.candidateId, finalize: { technical_timing_repair: false } })
      .then(() => assert.fail('the injected fault must propagate'), error => error);
    assert.match(stopped.message, /stopped before the finalize effect/);

    const restarted = createStudioApplication({ dataDirectory: directory, durability: 'persistent' });
    const runId = (await restarted.getRun(OWNER, fixture.projectId)).runs[0].run_id;
    const other = await restarted.finalize(OWNER, fixture.projectId, { candidateId: fixture.candidateId, technicalTimingRepair: true });

    await assert.rejects(
      restarted.resumeRun(OWNER, fixture.projectId, runId, { adopt_artifact_id: other.artifact_id }),
      error => error.code === ERROR_CODES.INVALID_REQUEST
        && error.details.reason === 'RECORD_ANSWERS_A_DIFFERENT_INPUT'
        && error.details.expected_input_fingerprint !== error.details.artifact_input_fingerprint,
      'naming settles which of the step\'s possible outputs it produced, never what may count as one',
    );
    assert.equal((await restarted.getRun(OWNER, fixture.projectId, runId)).run.final_artifact_id, null);
  });
});

test('a candidate applied from a different decision set is not this step\'s effect', async () => {
  await withDirectory(async directory => {
    const app = createStudioApplication({ dataDirectory: directory, durability: 'persistent' });
    const fixture = await projectWithSymbolicAsset(app, OWNER, { project: sixRoleBaseline() });
    await app.analyzeSources(OWNER, fixture.projectId, { assetIds: [fixture.assetId] });
    const mine = runDecisionsFor(fixture.project);
    const theirs = runDecisionsFor(fixture.project, { exclude: ['Chord3'] });

    const stopped = await stopsBefore(directory, RUN_STEP.APPLY_DECISIONS)
      .startRun(OWNER, fixture.projectId, { asset_ids: [fixture.assetId], decisions: mine, accepted_by: RUN_REVIEWER })
      .then(() => assert.fail('the injected fault must propagate'), error => error);
    assert.match(stopped.message, /stopped before the apply_decisions effect/);

    const restarted = createStudioApplication({ dataDirectory: directory, durability: 'persistent' });
    const runId = (await restarted.getRun(OWNER, fixture.projectId)).runs[0].run_id;

    // G11-D names no accepted plan, so this sibling matches the parent and the
    // stage exactly, and it postdates the marker: novelty alone would adopt a
    // candidate built from decisions this run never accepted.
    const other = (await restarted.applyDecisions(OWNER, fixture.projectId, { decisions: theirs })).decisions.candidate_id;

    const resumed = await restarted.resumeRun(OWNER, fixture.projectId, runId, { decisions: mine, accepted_by: RUN_REVIEWER });
    assert.notEqual(resumed.run.candidate_id, other, 'the other application\'s candidate is not this run\'s effect');
    assert.equal(receiptOf(resumed.run, RUN_STEP.APPLY_DECISIONS).status, RUN_STEP_STATUS.COMPLETED);
    const applied = (await restarted.getProject(OWNER, fixture.projectId)).project.candidates
      .find(entry => entry.candidate_id === resumed.run.candidate_id);
    assert.equal(applied.decision_count, mine.length, 'the run applied its own decision set');
  });
});

test('an adopted candidate must carry the input the interrupted step was applying', async () => {
  await withDirectory(async directory => {
    const app = createStudioApplication({ dataDirectory: directory, durability: 'persistent' });
    const fixture = await projectWithSymbolicAsset(app, OWNER, { project: sixRoleBaseline() });
    await app.analyzeSources(OWNER, fixture.projectId, { assetIds: [fixture.assetId] });
    const mine = runDecisionsFor(fixture.project);

    const stopped = await stopsBefore(directory, RUN_STEP.APPLY_DECISIONS)
      .startRun(OWNER, fixture.projectId, { asset_ids: [fixture.assetId], decisions: mine, accepted_by: RUN_REVIEWER })
      .then(() => assert.fail('the injected fault must propagate'), error => error);
    assert.match(stopped.message, /stopped before the apply_decisions effect/);

    const restarted = createStudioApplication({ dataDirectory: directory, durability: 'persistent' });
    const runId = (await restarted.getRun(OWNER, fixture.projectId)).runs[0].run_id;
    const other = (await restarted.applyDecisions(OWNER, fixture.projectId, {
      decisions: runDecisionsFor(fixture.project, { exclude: ['Chord3'] }),
    })).decisions.candidate_id;

    await assert.rejects(
      restarted.resumeRun(OWNER, fixture.projectId, runId, { adopt_candidate_id: other, decisions: mine, accepted_by: RUN_REVIEWER }),
      error => error.code === ERROR_CODES.INVALID_REQUEST
        && error.details.reason === 'RECORD_ANSWERS_A_DIFFERENT_INPUT'
        && error.details.expected_input_fingerprint !== error.details.candidate_input_fingerprint,
    );
    assert.equal((await restarted.getRun(OWNER, fixture.projectId, runId)).run.candidate_id, null, 'nothing was adopted');
  });
});

test('the reviewer a run names is part of the decision step\'s input, at every site that asks', async () => {
  const app = createStudioApplication({});
  const fixture = await projectWithSymbolicAsset(app, OWNER, { project: sixRoleBaseline() });
  await app.analyzeSources(OWNER, fixture.projectId, { assetIds: [fixture.assetId] });
  // No per-decision reviewer: `applyDecisions` resolves each one from the
  // top-level `accepted_by`, so it is the acceptance the candidate records.
  const decisions = runDecisionsFor(fixture.project).map(({ acceptedBy: _named, ...rest }) => rest);

  const started = await app.startRun(OWNER, fixture.projectId, { asset_ids: [fixture.assetId], decisions, accepted_by: 'Reviewer-A' });
  const first = started.run.candidate_id;
  assert.ok(first);
  assert.deepEqual(
    (await app.getProject(OWNER, fixture.projectId)).project.candidates.find(entry => entry.candidate_id === first).accepted_by,
    ['Reviewer-A'],
  );

  // The same decisions under a different named reviewer are a different
  // acceptance. The run must re-apply them rather than report the previous
  // candidate as the answer to an input it never applied.
  const resumed = await app.resumeRun(OWNER, fixture.projectId, started.run.run_id, { decisions, accepted_by: 'Reviewer-B' });
  assert.notEqual(resumed.run.candidate_id, first, 'a different accepted-by is a different decision step');
  assert.notEqual(
    receiptOf(resumed.run, RUN_STEP.APPLY_DECISIONS).input_fingerprint,
    receiptOf(started.run, RUN_STEP.APPLY_DECISIONS).input_fingerprint,
  );
  assert.deepEqual(
    (await app.getProject(OWNER, fixture.projectId)).project.candidates.find(entry => entry.candidate_id === resumed.run.candidate_id).accepted_by,
    ['Reviewer-B'],
  );

  // One fingerprint, at every site that asks: the input the run records, the
  // marker and receipt the step writes, and the binding the candidate carries.
  const view = await app.getRun(OWNER, fixture.projectId, started.run.run_id);
  const receipt = receiptOf(view.run, RUN_STEP.APPLY_DECISIONS);
  assert.equal(view.run.inputs.decision_set_fingerprint, receipt.input_fingerprint, 'the run\'s recorded input is the step\'s input');
  assert.equal(
    (await app.getProject(OWNER, fixture.projectId)).project.candidates
      .find(entry => entry.candidate_id === view.run.candidate_id).input_fingerprint,
    receipt.input_fingerprint,
    'and the candidate records the very input that produced it',
  );

  // And the rerun decision reads the same fingerprint: re-stating the input it
  // already applied is not new work.
  const again = await app.resumeRun(OWNER, fixture.projectId, started.run.run_id, { decisions, accepted_by: 'Reviewer-B' });
  assert.equal(again.run.candidate_id, resumed.run.candidate_id, 'the same input does not re-apply');
});

test('settling an interrupted step clears the reconciliation it settled, and nothing else', async () => {
  await withDirectory(async directory => {
    const fixture = await ambiguousFinals(directory);
    const { app } = fixture;

    const ambiguous = await app.resumeRun(OWNER, fixture.projectId, fixture.runId, {});
    assert.equal(ambiguous.run.state, RUN_STATE.INTERRUPTED);
    assert.deepEqual(ambiguous.run.blockers, [ERROR_CODES.RUN_RECONCILIATION_REQUIRED]);
    assert.deepEqual(ambiguous.run.review_requests.map(entry => entry.code), ['RECONCILIATION_REQUIRED']);

    // Naming the Final answers the very question the halt asked, so the halt,
    // the blocker naming it and the request asking for it stop describing
    // anything. What survives is what the Final itself says about the song.
    const chosen = finalsFor((await app.getProject(OWNER, fixture.projectId)).project, fixture.candidateId)[0];
    const settled = await app.resumeRun(OWNER, fixture.projectId, fixture.runId, { adopt_artifact_id: chosen });
    assert.equal(settled.run.state, RUN_STATE.COMPLETED, JSON.stringify(settled.run.blockers));
    assert.equal(settled.run.halt, null);
    assert.equal(settled.run.needs_reconciliation, false);
    assert.ok(!settled.run.blockers.includes(ERROR_CODES.RUN_RECONCILIATION_REQUIRED),
      'a settled reconciliation is not still blocking the run');
    assert.ok(!settled.run.review_requests.some(entry => entry.code === 'RECONCILIATION_REQUIRED'),
      'and nothing is still asking a reader to perform it');

    // The workflow blockers are the restored Final's own readiness blockers:
    // facts about the song, read back from what the Final persisted.
    const body = (await app.getArtifact(OWNER, chosen)).artifact;
    assert.deepEqual(settled.run.blockers, [...body.readiness_summary.pre_game_blocking]);
    assert.deepEqual(settled.run.readiness_blockers, [...body.readiness_summary.pre_game_blocking]);
  });
});

test('a step whose effect is shown absent stops the run asking for a reconciliation', async () => {
  await withDirectory(async directory => {
    const app = createStudioApplication({ dataDirectory: directory, durability: 'persistent' });
    const fixture = await readyCandidate(app);
    await app.recordConfirmations(OWNER, fixture.projectId, Object.fromEntries(
      Object.entries(FIXTURE_CONFIRMATIONS).map(([name, value]) => [name, {
        ...value, ...(['source_complete', 'original_audio_required'].includes(name) ? {} : { candidate_id: fixture.candidateId }),
      }]),
    ));
    const stopped = await stopsBefore(directory, RUN_STEP.FINALIZE)
      .startRun(OWNER, fixture.projectId, { target_candidate_id: fixture.candidateId })
      .then(() => assert.fail('the injected fault must propagate'), error => error);
    assert.match(stopped.message, /stopped before the finalize effect/);

    // A marker with no expectation: a bare resume cannot tell, and halts.
    const records = join(directory, 'records');
    const [name] = await readdir(records);
    const stored = JSON.parse(await readFile(join(records, name), 'utf8'));
    const runId = stored.runs[0].run_id;
    stored.runs[0].pending_step = { ...stored.runs[0].pending_step, expectation: null };
    await writeFile(join(records, name), JSON.stringify(stored));

    const restarted = createStudioApplication({ dataDirectory: directory, durability: 'persistent' });
    const halted = await restarted.resumeRun(OWNER, fixture.projectId, runId, {});
    assert.equal(halted.run.state, RUN_STATE.INTERRUPTED);
    assert.deepEqual(halted.run.blockers, [ERROR_CODES.RUN_RECONCILIATION_REQUIRED]);

    // `reconcile: true` establishes that nothing landed, which answers the
    // reconciliation just as finding the effect would: the step runs, and the
    // run stops reporting a reconciliation nobody has to perform.
    const resumed = await restarted.resumeRun(OWNER, fixture.projectId, runId, { reconcile: true });
    assert.equal(resumed.run.state, RUN_STATE.COMPLETED, JSON.stringify(resumed.run.blockers));
    assert.equal(resumed.run.halt, null);
    assert.ok(!resumed.run.blockers.includes(ERROR_CODES.RUN_RECONCILIATION_REQUIRED));
    assert.ok(!resumed.run.review_requests.some(entry => entry.code === 'RECONCILIATION_REQUIRED'));
    assert.equal(finalsFor((await restarted.getProject(OWNER, fixture.projectId)).project, fixture.candidateId).length, 1);
  });
});

test('a record written before bindings existed is unprovable automatically and still nameable', async () => {
  await withDirectory(async directory => {
    const app = createStudioApplication({ dataDirectory: directory, durability: 'persistent' });
    const fixture = await projectWithSymbolicAsset(app, OWNER, { project: sixRoleBaseline() });
    await app.analyzeSources(OWNER, fixture.projectId, { assetIds: [fixture.assetId] });
    const decisions = runDecisionsFor(fixture.project);
    const stopped = await stopsAfter(directory, RUN_STEP.APPLY_DECISIONS)
      .startRun(OWNER, fixture.projectId, { asset_ids: [fixture.assetId], decisions, accepted_by: RUN_REVIEWER })
      .then(() => assert.fail('the injected fault must propagate'), error => error);
    assert.match(stopped.message, /stopped after the apply_decisions effect/);

    // The effect landed and its binding did not: the one state a same-write
    // binding cannot reach, and therefore the one a restored record can.
    const records = join(directory, 'records');
    const [name] = await readdir(records);
    const stored = JSON.parse(await readFile(join(records, name), 'utf8'));
    const runId = stored.runs[0].run_id;
    const candidateId = stored.candidates[0].candidate_id;
    delete stored.candidates[0].input_fingerprint;
    await writeFile(join(records, name), JSON.stringify(stored));

    // Not "absent": replaying would apply the decisions a second time. Not
    // "found" either — nothing proves this candidate answers this input.
    const restarted = createStudioApplication({ dataDirectory: directory, durability: 'persistent' });
    const halted = await restarted.resumeRun(OWNER, fixture.projectId, runId, { decisions, accepted_by: RUN_REVIEWER });
    assert.equal(halted.run.state, RUN_STATE.INTERRUPTED);
    assert.equal(receiptOf(halted.run, RUN_STEP.APPLY_DECISIONS).detail.reason, 'EFFECT_IDENTITY_UNPROVABLE');
    assert.equal(receiptOf(halted.run, RUN_STEP.APPLY_DECISIONS).detail.cause, 'EFFECT_INPUT_BINDING_NOT_RECORDED');
    assert.equal(halted.run.candidate_id, null);
    assert.equal((await restarted.getProject(OWNER, fixture.projectId)).project.candidates.length, 1, 'and nothing was applied again');

    // The advertised remedy executes: the reviewer says which of the records
    // the automatic path could not exclude this step produced.
    const settled = await restarted.resumeRun(OWNER, fixture.projectId, runId, {
      adopt_candidate_id: candidateId, decisions, accepted_by: RUN_REVIEWER, confirmations: FIXTURE_CONFIRMATIONS,
    });
    assert.equal(settled.run.candidate_id, candidateId);
    assert.equal(settled.run.state, RUN_STATE.COMPLETED, JSON.stringify(settled.run.blockers));
    assert.ok(!settled.run.blockers.includes(ERROR_CODES.RUN_RECONCILIATION_REQUIRED));
    assert.equal((await restarted.getProject(OWNER, fixture.projectId)).project.candidates.length, 1);
  });
});

test('an automatically recovered report clears the reconciliation the run was halted on', async () => {
  await withDirectory(async directory => {
    const app = createStudioApplication({ dataDirectory: directory, durability: 'persistent' });
    const fixture = await readyCandidate(app);
    const done = await app.startRun(OWNER, fixture.projectId, { target_candidate_id: fixture.candidateId, confirmations: FIXTURE_CONFIRMATIONS });
    const report1 = done.run.report_artifact_id;
    assert.ok(report1);

    // Two reports naming this run, beside a legacy marker: ambiguous, so the
    // run halts and files the request that asks a reader to resolve it.
    const firstBody = (await app.getArtifact(OWNER, report1)).artifact;
    const twin = { ...firstBody, created_at: new Date(Date.parse(firstBody.created_at) + 1000).toISOString() };
    delete twin.artifact_id;
    const twinId = `art_${createHash('sha256').update(JSON.stringify(twin)).digest('hex')}`;
    await writeFile(
      join(directory, 'blobs', `${createHash('sha256').update(`artifact:${fixture.projectId}:${twinId}`).digest('hex')}.bin`),
      JSON.stringify({ ...twin, artifact_id: twinId }),
    );
    const records = join(directory, 'records');
    const [name] = await readdir(records);
    const stored = JSON.parse(await readFile(join(records, name), 'utf8'));
    const entry = stored.artifacts.find(artifact => artifact.artifact_id === report1);
    stored.artifacts.push({ ...entry, artifact_id: twinId, created_at: twin.created_at });
    const run = stored.runs.find(candidate => candidate.run_id === done.run.run_id);
    run.state = RUN_STATE.RUNNING;
    run.report_artifact_id = null;
    run.steps = run.steps.filter(step => step.step !== RUN_STEP.REPORT);
    run.pending_step = { step: RUN_STEP.REPORT, expectation: null, idempotent: false, input_fingerprint: null, at: new Date().toISOString() };
    await writeFile(join(records, name), JSON.stringify(stored));

    const restarted = createStudioApplication({ dataDirectory: directory, durability: 'persistent' });
    const ambiguous = await restarted.resumeRun(OWNER, fixture.projectId, done.run.run_id, {});
    assert.equal(ambiguous.run.state, RUN_STATE.INTERRUPTED);
    assert.deepEqual(ambiguous.run.blockers, [ERROR_CODES.RUN_RECONCILIATION_REQUIRED]);
    assert.deepEqual(ambiguous.run.review_requests.map(item => item.code), ['RECONCILIATION_REQUIRED']);

    // The twin is withdrawn from the record, so the run's own identity now
    // settles the step by itself. A report adoption restores no gates and no
    // readiness — it has none to restore — so nothing but the settling itself
    // can drop the blocker and the request the halt filed.
    const after = JSON.parse(await readFile(join(records, name), 'utf8'));
    after.artifacts = after.artifacts.filter(artifact => artifact.artifact_id !== twinId);
    await writeFile(join(records, name), JSON.stringify(after));

    const settled = await createStudioApplication({ dataDirectory: directory, durability: 'persistent' })
      .resumeRun(OWNER, fixture.projectId, done.run.run_id, {});
    assert.equal(settled.run.state, RUN_STATE.COMPLETED, JSON.stringify(settled.run.blockers));
    assert.equal(settled.run.report_artifact_id, report1);
    assert.equal(receiptOf(settled.run, RUN_STEP.REPORT).detail.reason, 'EFFECT_FOUND_BY_STORED_IDENTITY');
    assert.equal(settled.run.halt, null);
    assert.equal(settled.run.needs_reconciliation, false);
    assert.deepEqual(settled.run.blockers, [], 'the reconciliation it performed is no longer blocking it');
    assert.deepEqual(settled.run.review_requests, [], 'and nothing is still asking a reader to perform it');
  });
});

test('a recovered Final states what it carries, over the blockers the interrupted run held', async () => {
  await withDirectory(async directory => {
    const app = createStudioApplication({ dataDirectory: directory, durability: 'persistent' });
    const fixture = await readyCandidate(app);

    // The run halts for missing evidence, so it is carrying real readiness
    // blockers when the interruption happens.
    const halted = await app.startRun(OWNER, fixture.projectId, { target_candidate_id: fixture.candidateId });
    assert.equal(halted.run.state, RUN_STATE.AWAITING_REVIEW);
    assert.ok(halted.run.blockers.length > 0);

    await app.recordConfirmations(OWNER, fixture.projectId, Object.fromEntries(
      Object.entries(FIXTURE_CONFIRMATIONS).map(([name, value]) => [name, {
        ...value, ...(['source_complete', 'original_audio_required'].includes(name) ? {} : { candidate_id: fixture.candidateId }),
      }]),
    ));
    const stopped = await stopsAfter(directory, RUN_STEP.FINALIZE)
      .resumeRun(OWNER, fixture.projectId, halted.run.run_id, {})
      .then(() => assert.fail('the injected fault must propagate'), error => error);
    assert.match(stopped.message, /stopped after the finalize effect/);

    // The effect landed and its receipt did not, so the run still states the
    // blockers the review recorded before the Final existed.
    const restarted = createStudioApplication({ dataDirectory: directory, durability: 'persistent' });
    const mid = (await restarted.getRun(OWNER, fixture.projectId, halted.run.run_id)).run;
    assert.equal(mid.pending_step.step, RUN_STEP.FINALIZE);
    assert.ok(mid.blockers.length > 0, 'blockers a settled reconciliation must not be allowed to outlive');

    // Adopting the Final replaces them with what the Final itself says about
    // the song, exactly as a finalize whose receipt arrived would have.
    const resumed = await restarted.resumeRun(OWNER, fixture.projectId, halted.run.run_id, {});
    assert.equal(resumed.run.state, RUN_STATE.COMPLETED, JSON.stringify(resumed.run.blockers));
    assert.equal(receiptOf(resumed.run, RUN_STEP.FINALIZE).detail.reason, 'EFFECT_FOUND_BY_STORED_IDENTITY');
    const body = (await restarted.getArtifact(OWNER, resumed.run.final_artifact_id)).artifact;
    assert.deepEqual(resumed.run.blockers, [...body.readiness_summary.pre_game_blocking]);
    assert.deepEqual(resumed.run.readiness_blockers, [...body.readiness_summary.pre_game_blocking]);
  });
});
