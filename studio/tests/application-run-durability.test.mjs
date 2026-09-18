// Replay, staleness, concurrency and interruption.
//
// A resumable run is only worth having if resuming is safe, and "safe" here has
// four separate meanings that are easy to confuse:
//
//   replay          the same request twice must not apply anything twice. Not
//                   "must not usually", and not "must not, because the engine
//                   happens to be content-addressed": the run must refuse.
//   staleness       an approval, plan or PASS that described material which has
//                   since changed must not be reused — and, equally, supplying
//                   one more piece of evidence must not wedge the run forever.
//   concurrency     a run takes the project lock per step, so it must neither
//                   lose another writer's update nor deadlock against the
//                   public operation it is composing.
//   interruption    three distinct classes: before the effect, after the effect
//                   but before its receipt, and after the receipt but before
//                   the response. Each has a different right answer, and the
//                   fourth possibility — "cannot tell" — has to be said out
//                   loud rather than guessed.
//
// The fault injection below uses the documented `runHooks` seam, in the same
// spirit as `loadEngines`, and a second Application Service is constructed over
// the same data directory to stand in for a process restart.

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createStudioApplication, ERROR_CODES, RUN_STATE, RUN_STEP, RUN_STEP_STATUS } from '../backend/application/index.mjs';
import { enginesWith } from './support/real-engines.mjs';
import { FIXTURE_CONFIRMATIONS, RUN_REVIEWER, mobileProfile, projectWithSymbolicAsset, runDecisionsFor, sixRoleBaseline, sixRoleBaselineWithVolumes } from './fixtures/run-fixtures.mjs';

const OWNER = 'owner:run-durability';

const statusOf = (run, step) => run.steps.find(entry => entry.step === step)?.status ?? null;
const receiptOf = (run, step) => run.steps.find(entry => entry.step === step) ?? null;
const rejects = (promise, code) => assert.rejects(promise, error => error.code === code || assert.fail(`expected ${code}, got ${error.code}: ${error.message}`));

const withDirectory = async body => {
  const directory = await mkdtemp(join(tmpdir(), 'mml-run-durability-'));
  try { return await body(directory); } finally { await rm(directory, { recursive: true, force: true }); }
};

/** A project with one symbolic asset and a prepared G11-D candidate. */
async function preparedCandidate(app, { project = sixRoleBaseline() } = {}) {
  const fixture = await projectWithSymbolicAsset(app, OWNER, { project });
  await app.analyzeSources(OWNER, fixture.projectId, { assetIds: [fixture.assetId] });
  const applied = await app.applyDecisions(OWNER, fixture.projectId, { decisions: runDecisionsFor(project) });
  return { ...fixture, candidateId: applied.decisions.candidate_id };
}

// ─── replay ─────────────────────────────────────────────────────────────────

test('the same idempotent start request applies nothing twice and produces no second Final', async () => {
  const app = createStudioApplication({});
  const fixture = await preparedCandidate(app);
  const request = { target_candidate_id: fixture.candidateId, confirmations: FIXTURE_CONFIRMATIONS, idempotency_key: 'one-click-1' };

  const first = await app.startRun(OWNER, fixture.projectId, request);
  assert.equal(first.replayed, false);
  assert.equal(first.run.state, RUN_STATE.COMPLETED, JSON.stringify(first.run.blockers));
  const artifactId = first.run.final_artifact_id;
  assert.ok(artifactId);

  const second = await app.startRun(OWNER, fixture.projectId, request);
  assert.equal(second.replayed, true);
  assert.equal(second.advanced, false);
  assert.equal(second.run.run_id, first.run.run_id, 'the same key returns the same run');
  assert.equal(second.run.revision, first.run.revision, 'a replay takes no revision');
  assert.equal(second.run.final_artifact_id, artifactId, 'a replay produces no second Final');
  assert.match(second.notice, /nothing was applied, no revision was taken and no artifact was produced/);

  // And the project holds one Final for that candidate, not two.
  const record = (await app.getProject(OWNER, fixture.projectId)).project;
  assert.equal(record.artifacts.filter(entry => entry.type === 'final_mml').length, 1);
  assert.equal(record.runs, undefined, 'the run record is not exposed in the project view');
  assert.equal((await app.getRun(OWNER, fixture.projectId)).runs.length, 1, 'one run, not two');
});

test('the same idempotent resume neither re-applies a step nor stacks a volume offset', async () => {
  const app = createStudioApplication({});
  const fixture = await preparedCandidate(app);
  const started = await app.startRun(OWNER, fixture.projectId, { target_candidate_id: fixture.candidateId });

  const profile = mobileProfile({ Chord5: { defaultVolume: 9 } });
  const plan = (await app.planMobileAdaptation(OWNER, fixture.projectId, { candidateId: fixture.candidateId, profile })).adaptation.plan;
  const resume = { mobile_adaptation: { profile, expected_plan_id: plan.id, accepted_by: RUN_REVIEWER }, idempotency_key: 'adapt-1' };

  const first = await app.resumeRun(OWNER, fixture.projectId, started.run.run_id, resume);
  const adapted = first.run.candidate_id;
  assert.equal(statusOf(first.run, RUN_STEP.MOBILE_ADAPTATION), RUN_STEP_STATUS.COMPLETED);

  const second = await app.resumeRun(OWNER, fixture.projectId, started.run.run_id, resume);
  assert.equal(second.replayed, true);
  assert.equal(second.advanced, false);
  assert.equal(second.run.revision, first.run.revision);
  assert.equal(second.run.candidate_id, adapted, 'no second adaptation revision');
  assert.ok(second.idempotency_receipt.request_fingerprint);

  // One adaptation revision exists, so the offset was applied exactly once.
  const record = (await app.getProject(OWNER, fixture.projectId)).project;
  assert.equal(record.candidates.filter(entry => entry.stage === 'MOBILE_ADAPTATION_V1').length, 1);
});

test('one idempotency key cannot be bound to two different payloads', async () => {
  const app = createStudioApplication({});
  const fixture = await preparedCandidate(app);
  const first = await app.startRun(OWNER, fixture.projectId, { target_candidate_id: fixture.candidateId, idempotency_key: 'shared' });

  await rejects(
    app.startRun(OWNER, fixture.projectId, { target_candidate_id: fixture.candidateId, confirmations: FIXTURE_CONFIRMATIONS, idempotency_key: 'shared' }),
    ERROR_CODES.IDEMPOTENCY_CONFLICT,
  );
  // The original run is untouched by the refusal.
  const after = await app.getRun(OWNER, fixture.projectId, first.run.run_id);
  assert.equal(after.run.revision, first.run.revision);
  assert.equal((await app.getRun(OWNER, fixture.projectId)).runs.length, 1);

  // And the same rule holds for a resume key on an existing run.
  await app.resumeRun(OWNER, fixture.projectId, first.run.run_id, { confirmations: FIXTURE_CONFIRMATIONS, idempotency_key: 'resume-shared' });
  await rejects(
    app.resumeRun(OWNER, fixture.projectId, first.run.run_id, { idempotency_key: 'resume-shared' }),
    ERROR_CODES.IDEMPOTENCY_CONFLICT,
  );
});

test('a stale expected run revision is refused rather than overwritten', async () => {
  const app = createStudioApplication({});
  const fixture = await preparedCandidate(app);
  const started = await app.startRun(OWNER, fixture.projectId, { target_candidate_id: fixture.candidateId });
  const observed = started.run.revision;

  await app.resumeRun(OWNER, fixture.projectId, started.run.run_id, { confirmations: FIXTURE_CONFIRMATIONS });
  await rejects(
    app.resumeRun(OWNER, fixture.projectId, started.run.run_id, { expected_run_revision: observed }),
    ERROR_CODES.RUN_CONFLICT,
  );
  // The current revision is accepted.
  const current = (await app.getRun(OWNER, fixture.projectId, started.run.run_id)).run.revision;
  const ok = await app.resumeRun(OWNER, fixture.projectId, started.run.run_id, { expected_run_revision: current });
  assert.equal(ok.replayed, false);
});

// ─── concurrency ────────────────────────────────────────────────────────────

test('a run and the public operations it composes interleave without a lost update or a deadlock', async () => {
  const app = createStudioApplication({});
  const fixture = await preparedCandidate(app);

  // A run holds the project lock per step. If it called a public method the
  // whole thing would deadlock on one project key and this test would never
  // finish; that it finishes at all is the assertion.
  const [runA, runB, confirmed] = await Promise.all([
    app.startRun(OWNER, fixture.projectId, { target_candidate_id: fixture.candidateId, idempotency_key: 'race-a' }),
    app.startRun(OWNER, fixture.projectId, { target_candidate_id: fixture.candidateId, idempotency_key: 'race-b' }),
    app.recordConfirmations(OWNER, fixture.projectId, {
      version_drift_reviewed: { ...FIXTURE_CONFIRMATIONS.version_drift_reviewed, candidate_id: fixture.candidateId },
    }),
  ]);

  assert.notEqual(runA.run.run_id, runB.run.run_id, 'two keys are two runs');
  assert.ok(confirmed.confirmations.version_drift_reviewed);

  // Nothing was lost: both runs and the confirmation are all on the record.
  const listed = await app.getRun(OWNER, fixture.projectId);
  assert.equal(listed.runs.length, 2);
  assert.deepEqual(listed.runs.map(entry => entry.run_id).sort(), [runA.run.run_id, runB.run.run_id].sort());
  const reviewed = (await app.reviewCandidate(OWNER, fixture.projectId, { candidateId: fixture.candidateId })).review;
  assert.equal(reviewed.confirmations.version_drift_reviewed.value, true, 'the concurrent confirmation survived both runs');
});

test('a concurrent intake between two steps invalidates the run rather than being ignored', async () => {
  const app = createStudioApplication({});
  const fixture = await projectWithSymbolicAsset(app, OWNER);
  const second = (await app.uploadAsset(OWNER, fixture.projectId, {
    kind: 'canonical_project', filename: 'again.json', mediaType: 'application/json',
    bytes: new TextEncoder().encode(JSON.stringify({ ...sixRoleBaseline({ id: 'fixture:second', title: 'Second' }) })),
  })).asset;

  const started = await app.startRun(OWNER, fixture.projectId, { asset_ids: [fixture.assetId] });
  assert.equal(started.run.state, RUN_STATE.AWAITING_REVIEW);
  const boundBaseline = started.run.baseline_id;

  // Another caller replaces the baseline from a different source selection.
  await app.analyzeSources(OWNER, fixture.projectId, { assetIds: [second.asset_id] });

  const resumed = await app.resumeRun(OWNER, fixture.projectId, started.run.run_id, {
    decisions: runDecisionsFor(fixture.project), accepted_by: RUN_REVIEWER,
  });
  assert.equal(resumed.run.state, RUN_STATE.BLOCKED);
  assert.equal(resumed.run.halt.reason, 'RUN_BASELINE_CHANGED');
  assert.equal(resumed.run.candidate_id, null, 'no candidate was applied against a baseline the run is not bound to');
  const request = resumed.run.review_requests.find(entry => entry.code === 'RUN_INPUT_CHANGED');
  assert.ok(request, JSON.stringify(resumed.run.review_requests));
  assert.equal(request.detail.run_baseline_id, boundBaseline);
  assert.notEqual(request.detail.project_baseline_id, boundBaseline);
  assert.match(request.missing.join(' '), /is not reusable here/);

  // A read-only status call says the same thing without changing anything.
  const status = await app.getRun(OWNER, fixture.projectId, started.run.run_id);
  assert.ok(status.staleness.some(entry => entry.code === 'RUN_BASELINE_CHANGED'));
  assert.equal(status.run.revision, resumed.run.revision, 'reading a run does not advance it');
});

// ─── staleness ──────────────────────────────────────────────────────────────

test('a plan accepted under different inputs is refused as stale rather than applied', async () => {
  const app = createStudioApplication({});
  const fixture = await preparedCandidate(app);
  const started = await app.startRun(OWNER, fixture.projectId, { target_candidate_id: fixture.candidateId });

  const profile = mobileProfile({ Chord5: { defaultVolume: 9 } });
  const plan = (await app.planMobileAdaptation(OWNER, fixture.projectId, { candidateId: fixture.candidateId, profile })).adaptation.plan;
  // A different profile is a different decision, so the plan id it was reviewed
  // under does not describe it.
  const changed = mobileProfile({ Chord5: { defaultVolume: 11 } });

  const resumed = await app.resumeRun(OWNER, fixture.projectId, started.run.run_id, {
    mobile_adaptation: { profile: changed, expected_plan_id: plan.id, accepted_by: RUN_REVIEWER },
  });
  assert.equal(statusOf(resumed.run, RUN_STEP.MOBILE_ADAPTATION), RUN_STEP_STATUS.BLOCKED);
  const request = resumed.run.review_requests.find(entry => entry.code === 'MOBILE_ADAPTATION_BLOCKED');
  assert.ok(request.blockers.some(entry => (entry.code ?? entry) === 'STALE_MOBILE_ADAPTATION_PLAN'), JSON.stringify(request.blockers));
  assert.equal(resumed.run.candidate_id, fixture.candidateId, 'nothing was applied');
  assert.match(request.missing.join(' '), /the plan must be re-previewed and re-accepted/);
});

test('a run bound to one rules snapshot will not continue under another', async () => {
  await withDirectory(async directory => {
    const app = createStudioApplication({ dataDirectory: directory, durability: 'persistent' });
    const fixture = await preparedCandidate(app);
    const started = await app.startRun(OWNER, fixture.projectId, { target_candidate_id: fixture.candidateId });
    const boundSnapshot = started.run.canonical.rules_snapshot_sha;
    assert.match(boundSnapshot, /^[0-9a-f]{40}$/);

    // A second service over the same records, reporting a different published
    // release. Everything else about the load is real.
    const relabelled = createStudioApplication({
      dataDirectory: directory,
      durability: 'persistent',
      loadEngines: enginesWith(engines => ({
        rules: {
          ...engines.rules,
          PUBLISHED_CANONICAL: {
            ...engines.rules.PUBLISHED_CANONICAL,
            metadata: { ...engines.rules.PUBLISHED_CANONICAL.metadata, rules_snapshot_sha: 'f'.repeat(40) },
          },
        },
      })),
    });

    const resumed = await relabelled.resumeRun(OWNER, fixture.projectId, started.run.run_id, { confirmations: FIXTURE_CONFIRMATIONS });
    assert.equal(resumed.run.state, RUN_STATE.BLOCKED);
    assert.equal(resumed.run.halt.reason, 'RUN_CANONICAL_SNAPSHOT_CHANGED');
    assert.equal(resumed.run.final_artifact_id, null);
    const request = resumed.run.review_requests.find(entry => entry.code === 'RUN_INPUT_CHANGED');
    assert.equal(request.detail.run_rules_snapshot_sha, boundSnapshot);
    assert.equal(request.detail.loaded_rules_snapshot_sha, 'f'.repeat(40));
    // The Canonical identity and the implementation identity stay separate
    // records; a code change is not a release change and vice versa.
    assert.equal(resumed.run.implementation.run_schema, 'mabinogi-mobile-mml-studio/application-run@1');
    assert.match(resumed.run.implementation.notice, /not a new Canonical release/);
  });
});

test('supplying one more piece of evidence lets the run continue rather than wedging it', async () => {
  const app = createStudioApplication({});
  // A role move out of Core3 keeps every source event in the candidate, so the
  // reduction is a clean no-op and the run reaches the review step. What the
  // continuity audit then reports is three unapproved role-moves, and the
  // per-change approval is the ordinary way to answer them.
  const fixture = await projectWithSymbolicAsset(app, OWNER, { project: sixRoleBaseline() });
  await app.analyzeSources(OWNER, fixture.projectId, { assetIds: [fixture.assetId] });
  const decisions = [
    ...runDecisionsFor(fixture.project, { exclude: ['Chord1'] }),
    {
      id: 'reseat-chord1',
      type: 'MOVE_ROLE',
      target: { eventIds: fixture.project.events.filter(event => event.role === 'Chord1').map(event => event.id) },
      fromRole: 'Chord1',
      toRole: 'Chord4',
      reason: 'The reviewer re-seats this lane as enrichment for the fixture, which the continuity audit reports for approval.',
      evidence: ['fixture:official-midi#Chord1'],
      acceptedBy: RUN_REVIEWER,
    },
  ];
  const applied = await app.applyDecisions(OWNER, fixture.projectId, { decisions });
  assert.equal(applied.decisions.applied, true, JSON.stringify(applied.decisions.rejected));
  const candidateId = applied.decisions.candidate_id;

  const started = await app.startRun(OWNER, fixture.projectId, { target_candidate_id: candidateId, confirmations: FIXTURE_CONFIRMATIONS });
  assert.equal(started.run.halt.reason, 'AWAITING_REVIEW_EVIDENCE');
  assert.ok(started.run.readiness_blockers.includes('core3'), JSON.stringify(started.run.readiness_blockers));
  assert.equal(statusOf(started.run, RUN_STEP.FINAL_REDUCTION), RUN_STEP_STATUS.SKIPPED, 'no no-op reduction revision was minted');
  const request = started.run.review_requests.find(entry => entry.gate === 'core3');
  assert.deepEqual(request.blockers, ['UNAPPROVED_CORE3_SOURCE_CHANGE']);
  assert.deepEqual(request.available_operations, ['approveCore3SourceChange']);

  // Normal evidence top-up: approve each reported change, then resume.
  const unapproved = (await app.reviewCandidate(OWNER, fixture.projectId, { candidateId })).review.core3.unapproved;
  assert.equal(unapproved.length, 3);
  for (const item of unapproved) {
    await app.approveCore3SourceChange(OWNER, fixture.projectId, {
      candidateId,
      approval: { event_id: item.eventId, type: item.type, reason: 'Reviewed against the cited source for this fixture.', evidence: ['fixture:core3/continuity'] },
    });
  }

  const resumed = await app.resumeRun(OWNER, fixture.projectId, started.run.run_id, { confirmations: FIXTURE_CONFIRMATIONS });
  assert.equal(resumed.run.run_id, started.run.run_id, 'the same run continued');
  assert.ok(!resumed.run.readiness_blockers.includes('core3'), `core3 should be answered, got ${JSON.stringify(resumed.run.readiness_blockers)}`);
  // One more piece of evidence did not permanently wedge the run: it advanced.
  assert.ok(resumed.run.revision > started.run.revision);
});

// ─── interruption ───────────────────────────────────────────────────────────

test('an interruption before a step mutates anything leaves the step to run again, once', async () => {
  await withDirectory(async directory => {
    const fixture = await preparedCandidate(createStudioApplication({ dataDirectory: directory, durability: 'persistent' }));
    const interrupted = createStudioApplication({
      dataDirectory: directory,
      durability: 'persistent',
      runHooks: { beforeEffect: ({ step }) => { if (step === RUN_STEP.FINALIZE) throw Error('the process stopped before the effect'); } },
    });

    const started = await interrupted.startRun(OWNER, fixture.projectId, { target_candidate_id: fixture.candidateId, confirmations: FIXTURE_CONFIRMATIONS })
      .then(() => assert.fail('the injected fault must propagate'), error => error);
    assert.match(started.message, /stopped before the effect/);

    // A fresh service over the same records: the marker is there, the effect is not.
    const restarted = createStudioApplication({ dataDirectory: directory, durability: 'persistent' });
    const runId = (await restarted.getRun(OWNER, fixture.projectId)).runs[0].run_id;
    const before = await restarted.getRun(OWNER, fixture.projectId, runId);
    assert.equal(before.run.pending_step.step, RUN_STEP.FINALIZE);
    const record = (await restarted.getProject(OWNER, fixture.projectId)).project;
    assert.deepEqual(record.artifacts, [], 'nothing was emitted');

    // Resuming re-runs the step and produces exactly one Final.
    const resumed = await restarted.resumeRun(OWNER, fixture.projectId, runId, {});
    assert.equal(resumed.run.state, RUN_STATE.COMPLETED, JSON.stringify(resumed.run.blockers));
    assert.equal(resumed.run.pending_step, null);
    assert.equal(receiptOf(resumed.run, RUN_STEP.FINALIZE).status, RUN_STEP_STATUS.COMPLETED);
    const after = (await restarted.getProject(OWNER, fixture.projectId)).project;
    assert.equal(after.artifacts.filter(entry => entry.type === 'final_mml').length, 1);
  });
});

test('an effect persisted without its receipt is adopted by its stored identity, not replayed', async () => {
  await withDirectory(async directory => {
    const fixture = await preparedCandidate(createStudioApplication({ dataDirectory: directory, durability: 'persistent' }), { project: sixRoleBaselineWithVolumes(10) });
    const profile = mobileProfile({ Chord5: { volumeDelta: 2 } });
    const plan = (await createStudioApplication({ dataDirectory: directory, durability: 'persistent' })
      .planMobileAdaptation(OWNER, fixture.projectId, { candidateId: fixture.candidateId, profile })).adaptation.plan;

    const interrupted = createStudioApplication({
      dataDirectory: directory,
      durability: 'persistent',
      runHooks: { afterEffect: ({ step }) => { if (step === RUN_STEP.MOBILE_ADAPTATION) throw Error('the process stopped after the effect'); } },
    });
    const error = await interrupted.startRun(OWNER, fixture.projectId, {
      target_candidate_id: fixture.candidateId,
      mobile_adaptation: { profile, expected_plan_id: plan.id, accepted_by: RUN_REVIEWER },
    }).then(() => assert.fail('the injected fault must propagate'), problem => problem);
    assert.match(error.message, /stopped after the effect/);

    const restarted = createStudioApplication({ dataDirectory: directory, durability: 'persistent' });
    const runId = (await restarted.getRun(OWNER, fixture.projectId)).runs[0].run_id;
    const before = await restarted.getRun(OWNER, fixture.projectId, runId);
    assert.equal(before.run.pending_step.step, RUN_STEP.MOBILE_ADAPTATION);
    assert.equal(before.run.candidate_id, fixture.candidateId, 'the receipt never landed, so the run still points at the parent');
    // The effect itself did land.
    const midway = (await restarted.getProject(OWNER, fixture.projectId)).project;
    const adapted = midway.candidates.find(entry => entry.stage === 'MOBILE_ADAPTATION_V1');
    assert.ok(adapted, 'the adaptation revision was persisted');
    assert.deepEqual(midway.artifacts, [], 'no artifact exists yet');

    // Resuming adopts it rather than applying a second offset.
    const resumed = await restarted.resumeRun(OWNER, fixture.projectId, runId, { confirmations: FIXTURE_CONFIRMATIONS });
    const receipt = receiptOf(resumed.run, RUN_STEP.MOBILE_ADAPTATION);
    assert.equal(receipt.status, RUN_STEP_STATUS.SATISFIED);
    assert.equal(receipt.detail.reason, 'EFFECT_FOUND_BY_STORED_IDENTITY');
    assert.equal(receipt.result_reference, adapted.candidate_id);
    assert.equal(resumed.run.candidate_id, adapted.candidate_id);
    const after = (await restarted.getProject(OWNER, fixture.projectId)).project;
    assert.equal(after.candidates.filter(entry => entry.stage === 'MOBILE_ADAPTATION_V1').length, 1, 'the offset was not stacked by a replay');
    assert.equal(resumed.run.state, RUN_STATE.COMPLETED, JSON.stringify(resumed.run.blockers));
    assert.equal(after.artifacts.filter(entry => entry.type === 'final_mml').length, 1);
    // The volume moved by the one offset the reviewer accepted. Re-deriving the
    // same profile over the adapted candidate reports nothing left to change,
    // which is the adaptation stage's own statement that this offset is already
    // in place and will not be added a second time.
    const reread = (await restarted.planMobileAdaptation(OWNER, fixture.projectId, { candidateId: adapted.candidate_id, profile })).adaptation.plan;
    assert.deepEqual(reread.changes, [], JSON.stringify(reread.changes.map(change => change.before)));
  });
});

test('a receipt stored without its response is not repeated on the next call', async () => {
  await withDirectory(async directory => {
    const fixture = await preparedCandidate(createStudioApplication({ dataDirectory: directory, durability: 'persistent' }));
    const interrupted = createStudioApplication({
      dataDirectory: directory,
      durability: 'persistent',
      runHooks: { beforeResponse: ({ step }) => { if (step === RUN_STEP.FINALIZE) throw Error('the response never reached the caller'); } },
    });
    const error = await interrupted.startRun(OWNER, fixture.projectId, { target_candidate_id: fixture.candidateId, confirmations: FIXTURE_CONFIRMATIONS })
      .then(() => assert.fail('the injected fault must propagate'), problem => problem);
    assert.match(error.message, /never reached the caller/);

    const restarted = createStudioApplication({ dataDirectory: directory, durability: 'persistent' });
    const runId = (await restarted.getRun(OWNER, fixture.projectId)).runs[0].run_id;
    const before = await restarted.getRun(OWNER, fixture.projectId, runId);
    // The receipt is on the record, so the step is done and the marker cleared.
    assert.equal(before.run.pending_step, null);
    assert.equal(receiptOf(before.run, RUN_STEP.FINALIZE).status, RUN_STEP_STATUS.COMPLETED);
    assert.ok(before.run.final_artifact_id);
    const oneFinal = (await restarted.getProject(OWNER, fixture.projectId)).project.artifacts.filter(entry => entry.type === 'final_mml');
    assert.equal(oneFinal.length, 1);

    // Resuming continues from there and does not finalize twice.
    const resumed = await restarted.resumeRun(OWNER, fixture.projectId, runId, {});
    assert.equal(resumed.run.state, RUN_STATE.COMPLETED);
    assert.equal(resumed.run.final_artifact_id, before.run.final_artifact_id);
    const after = (await restarted.getProject(OWNER, fixture.projectId)).project;
    assert.equal(after.artifacts.filter(entry => entry.type === 'final_mml').length, 1);
  });
});

test('an unconfirmable step is reported as interrupted and is never replayed on a guess', async () => {
  await withDirectory(async directory => {
    const app = createStudioApplication({ dataDirectory: directory, durability: 'persistent' });
    const fixture = await preparedCandidate(app);
    const started = await app.startRun(OWNER, fixture.projectId, { target_candidate_id: fixture.candidateId });
    const runId = started.run.run_id;

    // Every step this build runs is either content-addressed or declared
    // repeatable, so the "cannot tell" case is unreachable through the service.
    // It is reachable in a restored or hand-edited record, which is exactly what
    // the defence is for, so the record is edited here to produce it.
    const records = join(directory, 'records');
    const [name] = await readdir(records);
    const stored = JSON.parse(await readFile(join(records, name), 'utf8'));
    const run = stored.runs.find(entry => entry.run_id === runId);
    run.pending_step = { step: RUN_STEP.REVIEW, expectation: null, idempotent: false, at: new Date().toISOString() };
    await writeFile(join(records, name), JSON.stringify(stored));

    const resumed = await app.resumeRun(OWNER, fixture.projectId, runId, { confirmations: FIXTURE_CONFIRMATIONS });
    assert.equal(resumed.run.state, RUN_STATE.INTERRUPTED);
    assert.equal(resumed.run.needs_reconciliation, true);
    assert.equal(resumed.run.halt.reason, 'RUN_RECONCILIATION_REQUIRED');
    assert.equal(resumed.run.halt.step, RUN_STEP.REVIEW);
    assert.equal(receiptOf(resumed.run, RUN_STEP.REVIEW).status, RUN_STEP_STATUS.UNCONFIRMED);
    assert.equal(resumed.run.final_artifact_id, null, 'nothing was replayed towards a Final');
    const request = resumed.run.review_requests.find(entry => entry.code === 'RECONCILIATION_REQUIRED');
    assert.deepEqual(request.blockers, [ERROR_CODES.RUN_RECONCILIATION_REQUIRED]);
    assert.equal(request.detail.unconfirmed_step, RUN_STEP.REVIEW);
    assert.match(request.missing.join(' '), /it is not replayed/);

    // An explicit reconciliation is what clears it, and only then does the run
    // continue.
    const reconciled = await app.resumeRun(OWNER, fixture.projectId, runId, { confirmations: FIXTURE_CONFIRMATIONS, reconcile: true });
    assert.equal(reconciled.run.needs_reconciliation, false);
    assert.equal(reconciled.run.state, RUN_STATE.COMPLETED, JSON.stringify(reconciled.run.blockers));
  });
});

test('an interrupted step whose effect cannot be told from another is not adopted on a guess', async () => {
  await withDirectory(async directory => {
    const app = createStudioApplication({ dataDirectory: directory, durability: 'persistent' });
    const fixture = await projectWithSymbolicAsset(app, OWNER, { project: sixRoleBaseline() });
    await app.analyzeSources(OWNER, fixture.projectId, { assetIds: [fixture.assetId] });

    // A decision application is the one step whose stored result carries no
    // plan id to match on, so two of them from the same parent are the case
    // where "which effect was mine" genuinely cannot be answered.
    const interrupted = createStudioApplication({
      dataDirectory: directory,
      durability: 'persistent',
      runHooks: { afterEffect: ({ step }) => { if (step === RUN_STEP.APPLY_DECISIONS) throw Error('the process stopped after the effect'); } },
    });
    const error = await interrupted.startRun(OWNER, fixture.projectId, {
      asset_ids: [fixture.assetId], decisions: runDecisionsFor(fixture.project), accepted_by: RUN_REVIEWER,
    }).then(() => assert.fail('the injected fault must propagate'), problem => problem);
    assert.match(error.message, /stopped after the effect/);

    const restarted = createStudioApplication({ dataDirectory: directory, durability: 'persistent' });
    const runId = (await restarted.getRun(OWNER, fixture.projectId)).runs[0].run_id;
    const mine = (await restarted.getProject(OWNER, fixture.projectId)).project.candidates[0].candidate_id;

    // Another caller applies a different accepted set from the same parent, so
    // two candidates now match what the interrupted step was about.
    const other = (await restarted.applyDecisions(OWNER, fixture.projectId, {
      decisions: runDecisionsFor(fixture.project).map(decision => ({ ...decision, reason: `${decision.reason} Reviewed separately, outside the run.` })),
    })).decisions.candidate_id;
    assert.notEqual(other, mine);

    // The run refuses to pick one, names both, and applies nothing.
    const ambiguous = await restarted.resumeRun(OWNER, fixture.projectId, runId, {});
    assert.equal(ambiguous.run.state, RUN_STATE.INTERRUPTED);
    assert.equal(ambiguous.run.needs_reconciliation, true);
    assert.equal(receiptOf(ambiguous.run, RUN_STEP.APPLY_DECISIONS).detail.reason, 'EFFECT_AMBIGUOUS');
    assert.equal(ambiguous.run.candidate_id, null);
    const request = ambiguous.run.review_requests.find(entry => entry.code === 'RECONCILIATION_REQUIRED');
    assert.deepEqual([...request.detail.matches].sort(), [mine, other].sort());
    assert.ok(request.available_operations.includes('resumeRun.adopt_candidate_id'));
    // `reconcile: true` alone does not resolve it: the question is which one,
    // not whether something happened.
    const stillAmbiguous = await restarted.resumeRun(OWNER, fixture.projectId, runId, { reconcile: true });
    assert.equal(stillAmbiguous.run.state, RUN_STATE.INTERRUPTED);

    // Naming one settles it, after its baseline and lineage are checked.
    const settled = await restarted.resumeRun(OWNER, fixture.projectId, runId, { adopt_candidate_id: mine, confirmations: FIXTURE_CONFIRMATIONS });
    assert.equal(settled.run.needs_reconciliation, false);
    assert.equal(settled.run.candidate_id, mine);
    assert.equal(receiptOf(settled.run, RUN_STEP.APPLY_DECISIONS).detail.reason, 'EFFECT_NAMED_BY_REVIEWER');
    assert.equal(settled.run.state, RUN_STATE.COMPLETED, JSON.stringify(settled.run.blockers));
    const artifact = (await restarted.getArtifact(OWNER, settled.run.final_artifact_id)).artifact;
    assert.equal(artifact.candidate_id, mine, 'the Final names the candidate the reviewer named, not the other one');
  });
});

// ─── durability is reported, never assumed ──────────────────────────────────

test('a filesystem run survives a new service instance and a memory run honestly does not', async () => {
  await withDirectory(async directory => {
    const first = createStudioApplication({ dataDirectory: directory, durability: 'persistent' });
    const fixture = await preparedCandidate(first);
    const started = await first.startRun(OWNER, fixture.projectId, { target_candidate_id: fixture.candidateId });
    assert.equal(started.run.storage.durability, 'persistent');

    // A new service over the same directory finds the run and can finish it.
    const second = createStudioApplication({ dataDirectory: directory, durability: 'persistent' });
    const recovered = await second.getRun(OWNER, fixture.projectId, started.run.run_id);
    assert.equal(recovered.run.run_id, started.run.run_id);
    assert.equal(recovered.run.revision, started.run.revision);
    const finished = await second.resumeRun(OWNER, fixture.projectId, started.run.run_id, { confirmations: FIXTURE_CONFIRMATIONS });
    assert.equal(finished.run.state, RUN_STATE.COMPLETED, JSON.stringify(finished.run.blockers));
  });

  // With no directory configured the store is in memory and says so, and a new
  // instance has no project to find — no recovery is claimed.
  const memory = createStudioApplication({});
  const fixture = await preparedCandidate(memory);
  const started = await memory.startRun(OWNER, fixture.projectId, { target_candidate_id: fixture.candidateId });
  assert.equal(started.run.storage.durability, 'ephemeral');
  assert.match(started.run.storage.notice, /lost when it restarts/);
  const fresh = createStudioApplication({});
  await rejects(fresh.getRun(OWNER, fixture.projectId, started.run.run_id), ERROR_CODES.PROJECT_NOT_FOUND);
  const caps = await memory.capabilities();
  assert.equal(caps.runs.automatic_continuation, false);
  assert.equal(caps.runs.cross_process_run_coordination, false);
  assert.equal(caps.jobs.background_execution, false);
});
