// What a run refuses, and the fact that it refuses honestly.
//
// A one-click orchestrator is the most dangerous place in this repository to
// put a convenience: every shortcut is a gate that stops meaning anything. So
// these regressions are all of the form "the run stops, and it stops for the
// real reason the owning module gave". None of them uses a mock engine to
// produce a verdict; where an engine is substituted at all, exactly one
// function is wrapped and every other answer stays real.
//
// The cases pinned here are the ones an adversarial reading of the run asked
// for directly:
//
//   - no Published Canonical means no run, and no legacy fallback;
//   - a recording is not a symbolic source, and no capability transcribes one;
//   - a baseline that reports unsupported material cannot be confirmed complete;
//   - the two Core3 questions never answer each other;
//   - reduction OVERFLOW / PENDING material is retained, not deleted, and
//     unmapped General MIDI percussion never lands in a pitched role;
//   - the Lead-bound Mobile adaptation refusal survives, with its own code;
//   - a missing audio report, player readback, Gate 8 or Gate 9 stops the run
//     rather than being filled in;
//   - a readiness blocker the run has never heard of still blocks it.

import test from 'node:test';
import assert from 'node:assert/strict';

import { createStudioApplication, ERROR_CODES, READINESS_BLOCKER_WITHOUT_OPERATION, RUN_STATE, RUN_STEP, RUN_STEP_STATUS } from '../backend/application/index.mjs';
import { createArbitrationDecision, createCanonicalNoteEvent, createCanonicalProject, createCanonicalRestEvent, createCanonicalTempoEvent } from '../backend/canonical/index.mjs';
import { MICRO_TIMING_KEEP_ACTION, createIntervalIdentity } from '../backend/canonical/micro-timing.mjs';
import { enginesWith } from './support/real-engines.mjs';
import { baselineWithOverflowLane, baselineWithPercussion, baselineWithoutLead, leadEvidenceFor, FIXTURE_SOURCE_ID } from './fixtures/g12-fixtures.mjs';
import { FIXTURE_CONFIRMATIONS, RUN_REVIEWER, mobileProfile, projectWithSymbolicAsset, runDecisionsFor, sixRoleBaseline } from './fixtures/run-fixtures.mjs';
import { LISTEN_FIRST_RELEASES_ACTIVE, MACHINE_DELIVERY_ACTIVE, assertRunHeldOrDeliveredUnresolved } from './support/loaded-release.mjs';

const OWNER = 'owner:run-blocking';

const statusOf = (run, step) => run.steps.find(entry => entry.step === step)?.status ?? null;
const requestFor = (run, code) => run.review_requests.find(entry => entry.code === code) ?? null;
const gateRequest = (run, gate) => run.review_requests.find(entry => entry.gate === gate) ?? null;
const rejects = (promise, code) => assert.rejects(promise, error => error.code === code || assert.fail(`expected ${code}, got ${error.code}: ${error.message}`));

// ─── Canonical ──────────────────────────────────────────────────────────────

test('without Published Canonical there is no run, no plan and no legacy fallback', async () => {
  const app = createStudioApplication({ loadEngines: async () => { throw Error('Published Manifest is unavailable'); } });
  const project = (await app.createProject(OWNER, { title: 'Unloaded' })).project;

  // The read-only plan still answers — discovery must work while Canonical is
  // unavailable — and it answers with the refusal, not with a plan.
  const planned = await app.planRun(OWNER, project.project_id, {});
  assert.equal(planned.plan.canonical.status, ERROR_CODES.CANONICAL_NOT_LOADED);
  assert.equal(planned.plan.canonical.legacy_fallback_allowed, false);
  assert.equal(planned.plan.canonical.rules_snapshot_sha, null, 'a failed load must not report a snapshot');
  assert.deepEqual(planned.plan.planned_steps, []);
  assert.deepEqual(planned.plan.capability_blockers, [ERROR_CODES.CANONICAL_NOT_LOADED]);

  // Starting a run creates the record — a caller asked for one — and it halts
  // at once with the Canonical refusal rather than degrading to anything.
  const started = await app.startRun(OWNER, project.project_id, {});
  assert.equal(started.run.state, RUN_STATE.BLOCKED);
  assert.equal(started.run.halt.reason, ERROR_CODES.CANONICAL_NOT_LOADED);
  assert.deepEqual(started.run.blockers, [ERROR_CODES.CANONICAL_NOT_LOADED]);
  assert.equal(started.run.baseline_id, null);
  assert.equal(started.run.candidate_id, null);
  assert.equal(started.run.gates, null);
  assert.equal(started.run.canonical.rules_snapshot_sha, null);
  const request = requestFor(started.run, 'READINESS_GATE_BLOCKED');
  assert.ok(request.missing.join(' ').includes('no legacy fallback'), JSON.stringify(request.missing));
  assert.ok(request.missing.join(' ').includes('Draft2'), 'the refusal names what may not stand in for the snapshot');

  // And the run stays refused on resume: nothing accumulates towards a PASS.
  const resumed = await app.resumeRun(OWNER, project.project_id, started.run.run_id, { confirmations: FIXTURE_CONFIRMATIONS });
  assert.equal(resumed.run.state, RUN_STATE.BLOCKED);
  assert.equal(resumed.run.halt.reason, ERROR_CODES.CANONICAL_NOT_LOADED);
  assert.equal(resumed.run.final_artifact_id, null);
});

// ─── sources ────────────────────────────────────────────────────────────────

test('a project holding only a recording is a capability blocker, not a run', async () => {
  const app = createStudioApplication({});
  const project = (await app.createProject(OWNER, { title: 'Audio only' })).project;
  await app.uploadAsset(OWNER, project.project_id, {
    kind: 'original_audio', filename: 'song.m4a', mediaType: 'audio/mp4', bytes: new Uint8Array([0, 1, 2, 3]),
  });

  const started = await app.startRun(OWNER, project.project_id, {});
  assert.equal(started.run.state, RUN_STATE.AWAITING_REVIEW);
  assert.equal(started.run.halt.reason, 'RUN_CAPABILITY_UNSUPPORTED');
  assert.equal(statusOf(started.run, RUN_STEP.INTAKE), RUN_STEP_STATUS.AWAITING_INPUT);
  assert.equal(started.run.baseline_id, null);

  const request = requestFor(started.run, 'SYMBOLIC_SOURCE_REQUIRED');
  assert.ok(request, JSON.stringify(started.run.review_requests));
  assert.deepEqual(request.blockers, [ERROR_CODES.SOURCE_INCOMPLETE]);
  assert.equal(request.detail.symbolic_asset_count, 0);
  assert.equal(request.detail.original_audio_asset_count, 1);
  assert.equal(request.detail.audio_to_midi_supported, false);
  assert.match(request.missing.join(' '), /no audio-to-MIDI, no stem separation, no vocal isolation and no pitch transcription/);
  assert.match(request.missing.join(' '), /song title alone cannot either/);

  // The capability record agrees, and adding a run changed none of it.
  const caps = await app.capabilities();
  for (const name of ['audio_to_midi', 'source_separation', 'vocal_isolation', 'exact_pitch_transcription_from_audio', 'in_game_test']) {
    assert.equal(caps.capabilities[name], false, `${name} must stay false`);
  }
  assert.equal(caps.capabilities.one_click_run_orchestration, true);
});

test('a baseline that reports unsupported source material cannot be confirmed complete by a run', async () => {
  const app = createStudioApplication({});
  // The adapters' own `unsupported` is what refuses the confirmation, so it is
  // produced rather than asserted: an MML source with no source-confirmed meter
  // map cannot be ingested at all, and a baseline that does report unsupported
  // material refuses `source_complete` in `review.record`.
  const fixture = await projectWithSymbolicAsset(app, OWNER);
  await app.analyzeSources(OWNER, fixture.projectId, { assetIds: [fixture.assetId] });
  const record = (await app.getProject(OWNER, fixture.projectId)).project;
  assert.deepEqual(record.baseline.unsupported, {}, 'this fixture is clean, so the refusal below is exercised on a dirtied one');

  // Dirty exactly one thing: a baseline that declares unsupported material.
  const dirty = createStudioApplication({
    loadEngines: enginesWith(engines => ({
      merge: engines.merge,
      canonical: {
        ...engines.canonical,
        createCanonicalProject: input => engines.canonical.createCanonicalProject({
          ...input,
          metadata: { ...(input.metadata ?? {}), unsupported: [{ code: 'FIXTURE_UNSUPPORTED_CONSTRUCT' }] },
        }),
      },
    })),
  });
  const dirtyFixture = await projectWithSymbolicAsset(dirty, OWNER);
  const started = await dirty.startRun(OWNER, dirtyFixture.projectId, {
    asset_ids: [dirtyFixture.assetId],
    decisions: runDecisionsFor(dirtyFixture.project),
    accepted_by: RUN_REVIEWER,
  });
  const intake = started.run.steps.find(entry => entry.step === RUN_STEP.INTAKE);
  assert.equal(intake.detail.source_complete, false, 'the adapters\' own verdict is carried through');
  assert.deepEqual(intake.detail.unsupported, { FIXTURE_UNSUPPORTED_CONSTRUCT: 1 });
  assert.ok(started.run.warnings.some(entry => entry.code === 'FIXTURE_UNSUPPORTED_CONSTRUCT'), JSON.stringify(started.run.warnings));

  // Resuming with `source_complete: true` is refused by the review service,
  // which the run does not catch and convert into a pass.
  await rejects(
    dirty.resumeRun(OWNER, dirtyFixture.projectId, started.run.run_id, { confirmations: FIXTURE_CONFIRMATIONS }),
    ERROR_CODES.SOURCE_INCOMPLETE,
  );
  const after = await dirty.getRun(OWNER, dirtyFixture.projectId, started.run.run_id);
  assert.notEqual(after.run.state, RUN_STATE.COMPLETED);
  assert.equal(after.run.final_artifact_id, null);
});

// ─── Core3: two questions, neither answering the other ──────────────────────

test('a Core3 with no Lead is never reviewed into existence by a run', async () => {
  const app = createStudioApplication({});
  const fixture = await projectWithSymbolicAsset(app, OWNER, { project: baselineWithoutLead() });

  const started = await app.startRun(OWNER, fixture.projectId, {
    asset_ids: [fixture.assetId],
    decisions: runDecisionsFor(fixture.project, { exclude: ['Melody'] }),
    accepted_by: RUN_REVIEWER,
    // Every reviewable confirmation, including the Core3 completeness review.
    confirmations: FIXTURE_CONFIRMATIONS,
  });

  // The run stops at the reduction, because the reduction stage itself refuses
  // to plan over a Core3 it reports incomplete. The upstream code is carried
  // through unchanged rather than re-worded.
  assert.equal(started.run.state, RUN_STATE.AWAITING_REVIEW);
  assert.equal(statusOf(started.run, RUN_STEP.FINAL_REDUCTION), RUN_STEP_STATUS.AWAITING_INPUT);
  assert.equal(started.run.final_artifact_id, null);
  const request = requestFor(started.run, 'REDUCTION_DECISIONS_REQUIRED');
  assert.ok(request, JSON.stringify(started.run.review_requests));
  assert.ok(request.blockers.some(entry => (entry.code ?? entry) === 'REDUCTION_CORE3_INCOMPLETE'), JSON.stringify(request.blockers));

  // The run halted before the review step, so it recorded no confirmation at
  // all: a candidate-bound answer is never filed against an intermediate
  // candidate the run might yet replace.
  assert.equal((await app.getProject(OWNER, fixture.projectId)).project.confirmations, undefined);

  // And the reviewer's Gate 4 completeness review, recorded explicitly against
  // that candidate, does not review an absent Lead into existence: the gate
  // FAILs, with the missing function named.
  const reviewed = (await app.reviewCandidate(OWNER, fixture.projectId, {
    candidateId: started.run.candidate_id, confirmations: FIXTURE_CONFIRMATIONS,
  })).review;
  assert.equal(reviewed.readiness.gates.core3Completeness.status, 'FAIL');
  assert.equal(reviewed.readiness.gates.core3Completeness.reviewed, true, 'the review was recorded and still did not clear it');
  assert.deepEqual(reviewed.readiness.gates.core3Completeness.blockers, ['CORE3_INCOMPLETE']);
  assert.deepEqual(reviewed.readiness.gates.core3Completeness.missingFunctions, ['lead-continuity']);
  assert.ok(reviewed.readiness.preGameBlocking.includes('core3Completeness'));
});

test('the two Core3 questions never clear each other, in either direction', async () => {
  // Omitting a Chord1 lane from the six roles is both a Core3 source change the
  // continuity audit reports unapproved, and a Core3 whose principal-harmony
  // function the completeness evaluator cannot certify. Two independent
  // questions about one candidate, each answered by its own operation.
  const omissionCandidate = async app => {
    const fixture = await projectWithSymbolicAsset(app, OWNER, { project: sixRoleBaseline() });
    await app.analyzeSources(OWNER, fixture.projectId, { assetIds: [fixture.assetId] });
    const decisions = [
      ...runDecisionsFor(fixture.project, { exclude: ['Chord1'] }),
      {
        id: 'omit-chord1',
        type: 'OMIT_FROM_SIX',
        target: { eventIds: fixture.project.events.filter(event => event.role === 'Chord1').map(event => event.id) },
        fromRole: 'Chord1',
        reason: 'The fixture drops this lane so the continuity audit has an unapproved Core3 change to report.',
        evidence: [`${FIXTURE_SOURCE_ID}#Chord1`],
        acceptedBy: RUN_REVIEWER,
      },
    ];
    const applied = await app.applyDecisions(OWNER, fixture.projectId, { decisions });
    assert.equal(applied.decisions.applied, true, JSON.stringify(applied.decisions.rejected));
    return { fixture, candidateId: applied.decisions.candidate_id };
  };

  // Direction 1: the Gate 4 completeness review does not clear the continuity
  // audit. The completeness gate passes; `core3` still reports the unapproved
  // source change, and it points at its own operation.
  const completenessOnly = createStudioApplication({});
  const first = await omissionCandidate(completenessOnly);
  const afterCompleteness = (await completenessOnly.reviewCandidate(OWNER, first.fixture.projectId, {
    candidateId: first.candidateId,
    confirmations: { core3_completeness_reviewed: FIXTURE_CONFIRMATIONS.core3_completeness_reviewed },
  })).review;
  assert.equal(afterCompleteness.readiness.gates.core3Completeness.status, 'PASS');
  assert.equal(afterCompleteness.readiness.gates.core3.status, 'PENDING');
  assert.deepEqual(afterCompleteness.readiness.gates.core3.blockers, ['UNAPPROVED_CORE3_SOURCE_CHANGE']);
  assert.ok(afterCompleteness.readiness.preGameBlocking.includes('core3'));

  // Direction 2: the per-change continuity approvals do not clear the
  // completeness gate. `core3` passes; `core3Completeness` still reports its
  // own unresolved residue.
  const continuityOnly = createStudioApplication({});
  const second = await omissionCandidate(continuityOnly);
  const unapproved = (await continuityOnly.reviewCandidate(OWNER, second.fixture.projectId, { candidateId: second.candidateId })).review.core3.unapproved;
  assert.ok(unapproved.length, 'the continuity audit has changes to approve');
  for (const item of unapproved) {
    await continuityOnly.approveCore3SourceChange(OWNER, second.fixture.projectId, {
      candidateId: second.candidateId,
      approval: { event_id: item.eventId, type: item.type, reason: 'The fixture reviewed and approved this omission.', evidence: ['fixture:core3/continuity'] },
    });
  }
  const afterContinuity = (await continuityOnly.reviewCandidate(OWNER, second.fixture.projectId, { candidateId: second.candidateId })).review;
  assert.equal(afterContinuity.readiness.gates.core3.status, 'PASS');
  assert.equal(afterContinuity.readiness.gates.core3Completeness.status, 'PENDING');
  assert.deepEqual(afterContinuity.readiness.gates.core3Completeness.blockers, ['CORE3_COMPLETENESS_UNRESOLVED']);
  assert.equal(afterContinuity.readiness.gates.core3Completeness.reviewed, false);

  // A run over that candidate, with only one of the two answered, still stops.
  const started = await continuityOnly.startRun(OWNER, second.fixture.projectId, {
    target_candidate_id: second.candidateId,
    confirmations: { source_complete: FIXTURE_CONFIRMATIONS.source_complete, original_audio_required: FIXTURE_CONFIRMATIONS.original_audio_required },
  });
  assert.notEqual(started.run.state, RUN_STATE.COMPLETED);
  assert.equal(started.run.final_artifact_id, null);
});

// ─── reduction: nothing disappears ──────────────────────────────────────────

test('reduction OVERFLOW material is retained and reported, never deleted to fit six roles', async () => {
  const app = createStudioApplication({});
  const fixture = await projectWithSymbolicAsset(app, OWNER, { project: baselineWithOverflowLane() });

  const started = await app.startRun(OWNER, fixture.projectId, {
    asset_ids: [fixture.assetId],
    decisions: runDecisionsFor(fixture.project),
    accepted_by: RUN_REVIEWER,
  });

  assert.equal(started.run.state, RUN_STATE.AWAITING_REVIEW);
  assert.equal(started.run.halt.reason, 'AWAITING_ACCEPTED_REDUCTION_DECISIONS');
  const request = requestFor(started.run, 'REDUCTION_DECISIONS_REQUIRED');
  assert.ok(request, JSON.stringify(started.run.review_requests));
  // Every source event is still accounted for, and the three that cannot be
  // placed are OVERFLOW rather than gone.
  assert.equal(request.detail.accounting.total, 21);
  assert.equal(request.detail.accounting.retained, 18);
  assert.equal(request.detail.accounting.overflow, 3);
  assert.equal(request.detail.accounting.omitted, 0);
  assert.equal(request.detail.outcomes.OVERFLOW, 3);
  assert.ok(request.blockers.some(entry => (entry.code ?? entry) === 'OVERFLOW_MATERIAL_RETAINED'), JSON.stringify(request.blockers));
  assert.match(request.missing.join(' '), /character limit is never a reason to delete it/);
  // And no revision was minted, so nothing was silently dropped either.
  const record = (await app.getProject(OWNER, fixture.projectId)).project;
  assert.equal(record.candidates.length, 1, 'only the G11-D candidate exists');
});

test('unmapped General MIDI percussion is reported as pending, never assigned to a pitched role by a run', async () => {
  const app = createStudioApplication({});
  const fixture = await projectWithSymbolicAsset(app, OWNER, { project: baselineWithPercussion() });

  const started = await app.startRun(OWNER, fixture.projectId, {
    asset_ids: [fixture.assetId],
    decisions: runDecisionsFor(fixture.project),
    accepted_by: RUN_REVIEWER,
  });

  const request = requestFor(started.run, 'REDUCTION_DECISIONS_REQUIRED');
  assert.ok(request, JSON.stringify(started.run.review_requests));
  assert.equal(request.detail.accounting.total, 20);
  assert.equal(request.detail.accounting.retained, 18);
  assert.equal(request.detail.accounting.pending, 2);
  assert.equal(request.detail.accounting.omitted, 0);
  assert.ok(request.detail.reason_codes.includes('PERCUSSION_DRUM_FACE_MAPPING_REQUIRED'), JSON.stringify(request.detail.reason_codes));
  assert.ok(request.blockers.some(entry => (entry.code ?? entry) === 'PERCUSSION_MATERIAL_RETAINED'), JSON.stringify(request.blockers));
  assert.match(request.missing.join(' '), /never assigned to a pitched role/);
  // The run proposed no role for it: the drum events are still role-less.
  const events = await app.listBaselineEvents(OWNER, fixture.projectId, { eventIds: ['drum-1', 'drum-2'] });
  assert.deepEqual(events.events.map(event => event.role), [null, null]);
});

// ─── Mobile adaptation: the Lead binding survives ───────────────────────────

test('a run cannot adapt an event a Lead evidence record still binds', async () => {
  const app = createStudioApplication({});
  const fixture = await projectWithSymbolicAsset(app, OWNER, { project: sixRoleBaseline() });
  const boundEvent = fixture.project.events.find(event => event.id === 'chord3-1');
  const move = (id, fromRole, toRole, leadEvidence) => ({
    id, type: 'MOVE_ROLE', target: { eventIds: ['chord3-1'] }, fromRole, toRole,
    reason: 'Reviewed against the cited score and mix for this window.',
    evidence: [`${FIXTURE_SOURCE_ID}#score`], leadEvidence, acceptedBy: RUN_REVIEWER,
  });

  // A promotion into Melody and then a move back out of it, both applied inside
  // one run by two resumes. The surviving Lead evidence record binds this
  // event's pitch, timing and volume, so a later re-pitch would leave a gate no
  // review could answer.
  const started = await app.startRun(OWNER, fixture.projectId, {
    asset_ids: [fixture.assetId], decisions: runDecisionsFor(fixture.project), accepted_by: RUN_REVIEWER,
  });
  const runId = started.run.run_id;
  const promoted = await app.resumeRun(OWNER, fixture.projectId, runId, {
    decisions: [move('promote', 'Chord3', 'Melody', leadEvidenceFor(boundEvent, { sectionRole: 'instrumental', classification: 'lead', audio: 'foreground' }))],
  });
  assert.equal(statusOf(promoted.run, RUN_STEP.APPLY_DECISIONS), RUN_STEP_STATUS.COMPLETED, JSON.stringify(promoted.run.steps.find(entry => entry.step === RUN_STEP.APPLY_DECISIONS)?.detail));
  const demoted = await app.resumeRun(OWNER, fixture.projectId, runId, {
    decisions: [move('demote', 'Melody', 'Chord3', leadEvidenceFor(boundEvent, { classification: 'inner', audio: 'background' }))],
  });
  const candidateId = demoted.run.candidate_id;
  assert.equal(statusOf(demoted.run, RUN_STEP.APPLY_DECISIONS), RUN_STEP_STATUS.COMPLETED, JSON.stringify(demoted.run.steps.find(entry => entry.step === RUN_STEP.APPLY_DECISIONS)?.detail));
  assert.equal(demoted.run.candidate_lineage.length, 3, 'three revisions, one run');

  // A profile that would move that event's register is refused with the
  // existing code, unchanged, naming the event it is about.
  const profile = mobileProfile({ Chord3: { pitchRange: [30, 40] } });
  const preview = await app.planMobileAdaptation(OWNER, fixture.projectId, { candidateId, profile });
  assert.deepEqual(
    preview.adaptation.plan.blockers.filter(entry => entry.code === 'LEAD_ROLE_ADAPTATION_REVIEW_UNSUPPORTED'),
    [{ code: 'LEAD_ROLE_ADAPTATION_REVIEW_UNSUPPORTED', eventId: 'chord3-1', fromRole: 'Chord3', toRole: 'Chord3', boundBy: 'lead-evidence-lineage' }],
  );

  const resumed = await app.resumeRun(OWNER, fixture.projectId, runId, {
    mobile_adaptation: { profile, expected_plan_id: preview.adaptation.plan.id, accepted_by: RUN_REVIEWER },
  });
  assert.equal(statusOf(resumed.run, RUN_STEP.MOBILE_ADAPTATION), RUN_STEP_STATUS.BLOCKED);
  const request = requestFor(resumed.run, 'MOBILE_ADAPTATION_BLOCKED');
  assert.ok(request, JSON.stringify(resumed.run.review_requests));
  assert.ok(request.blockers.some(entry => (entry.code ?? entry) === 'LEAD_ROLE_ADAPTATION_REVIEW_UNSUPPORTED'), JSON.stringify(request.blockers));
  assert.ok(request.event_ids.includes('chord3-1'), JSON.stringify(request.event_ids));
  assert.match(request.missing.join(' '), /never by clearing the evidence, changing the baseline role, copying an older PASS or relaxing the profile/);
  // The candidate is unchanged and no adaptation revision was minted.
  assert.equal(resumed.run.candidate_id, candidateId);
  const record = (await app.getProject(OWNER, fixture.projectId)).project;
  assert.equal(record.candidates.filter(entry => entry.stage === 'MOBILE_ADAPTATION_V1').length, 0);
});

// ─── missing evidence stops the run, it is never filled in ──────────────────

test('a missing audio report, player readback, Gate 8 or Gate 9 each stay unresolved on their own, and v1 stops the run', async () => {
  const app = createStudioApplication({});
  const fixture = await projectWithSymbolicAsset(app, OWNER, { project: sixRoleBaseline() });
  await app.analyzeSources(OWNER, fixture.projectId, { assetIds: [fixture.assetId] });
  const prepared = (await app.applyDecisions(OWNER, fixture.projectId, { decisions: runDecisionsFor(fixture.project) })).decisions.candidate_id;

  // Each case withholds exactly one of the reviewer's answers.
  const cases = [
    ['original_audio_required', 'originalAudio', 'AUDIO_ALIGNMENT_EVIDENCE_MISSING', 'non_blocking_pending'],
    ['player_readback', 'playerReadback', null, 'post_delivery'],
    ['mobile_adaptation_reviewed', 'mobileAdaptation', 'MOBILE_ADAPTATION_REVIEW_REQUIRED', 'non_blocking_pending'],
    ['regression_reviewed', 'regression', 'REGRESSION_REVIEW_REQUIRED', 'non_blocking_pending'],
  ];
  for (const [withheld, gate, blocker, phase] of cases) {
    const isolated = createStudioApplication({});
    const own = await projectWithSymbolicAsset(isolated, OWNER, { project: sixRoleBaseline() });
    await isolated.analyzeSources(OWNER, own.projectId, { assetIds: [own.assetId] });
    const candidate = (await isolated.applyDecisions(OWNER, own.projectId, { decisions: runDecisionsFor(own.project) })).decisions.candidate_id;
    const { [withheld]: _dropped, ...rest } = FIXTURE_CONFIRMATIONS;

    const started = await isolated.startRun(OWNER, own.projectId, { target_candidate_id: candidate, confirmations: rest });
    assertRunHeldOrDeliveredUnresolved(started.run, [[gate, phase]]);
    if (MACHINE_DELIVERY_ACTIVE) {
      // Delivered for listening first: the answer is still missing, never filled in.
      const entry = started.run.machine_delivery[phase].find(item => item.gate === gate);
      if (blocker) assert.ok(entry.blockers.includes(blocker), `${gate}: ${JSON.stringify(entry.blockers)}`);
      continue;
    }
    const request = gateRequest(started.run, gate);
    assert.ok(request, `withholding ${withheld} must report the ${gate} gate; got ${JSON.stringify(started.run.review_requests.map(entry => entry.gate))}`);
    if (blocker) assert.ok(request.blockers.some(entry => (entry.code ?? entry) === blocker), `${gate}: ${JSON.stringify(request.blockers)}`);
    assert.ok(request.available_operations.length, `${gate} must name an operation that answers it`);
  }

  // The control: with every answer supplied the same candidate does finish, so
  // the four cases above are not failing for some unrelated reason.
  const control = await app.startRun(OWNER, fixture.projectId, { target_candidate_id: prepared, confirmations: FIXTURE_CONFIRMATIONS });
  assert.equal(control.run.state, RUN_STATE.COMPLETED, JSON.stringify(control.run.blockers));
});

// ─── a blocker no operation answers is said so ──────────────────────────────

test('a micro-timing boundary Final cannot reach names no operation, says why, and still blocks', async () => {
  // Chord5's last note starts one 480-tick past the 1/64 grid after a rest of
  // more than the grid: no sub-grid interval, no release, only an onset no
  // admitted Final token sequence reaches. The gate hint used to send a caller
  // to release representation, which never moves an onset.
  const BOUNDARY = 'MICRO_TIMING_BOUNDARY_NOT_FINAL_REPRESENTABLE';
  const shifted = (changes) => {
    const source = sixRoleBaseline();
    return createCanonicalProject({
      ...source,
      events: source.events.map(event => (changes[event.id] ? createCanonicalNoteEvent({ ...event, ...changes[event.id] }) : event)),
    });
  };
  const runOn = async project => {
    const isolated = createStudioApplication({});
    const own = await projectWithSymbolicAsset(isolated, OWNER, { project });
    await isolated.analyzeSources(OWNER, own.projectId, { assetIds: [own.assetId] });
    const candidate = (await isolated.applyDecisions(OWNER, own.projectId, { decisions: runDecisionsFor(own.project) })).decisions.candidate_id;
    return (await isolated.startRun(OWNER, own.projectId, { target_candidate_id: candidate, confirmations: FIXTURE_CONFIRMATIONS })).run;
  };

  const onsetOnly = await runOn(shifted({ 'chord5-3': { start: '991/480' } }));
  assert.notEqual(onsetOnly.state, RUN_STATE.COMPLETED);
  assert.equal(onsetOnly.final_artifact_id, null);
  const request = gateRequest(onsetOnly, 'microTiming');
  assert.ok(request, JSON.stringify(onsetOnly.review_requests.map(entry => entry.gate)));
  assert.equal(request.known, true);
  assert.deepEqual(request.blockers, [BOUNDARY]);
  assert.deepEqual(request.available_operations, [], 'no operation is offered that cannot answer the gate');
  assert.deepEqual(request.missing, [READINESS_BLOCKER_WITHOUT_OPERATION.microTiming[BOUNDARY]]);
  assert.match(request.missing[0], /No operation in this build answers it/);
  assert.match(request.missing[0], /the gate still blocks/);
  assert.deepEqual(request.detail.unsupportedBoundaries.filter(entry => entry.coverage === 'none').map(entry => [entry.role, entry.eventId, entry.boundary, entry.position]),
    [['Chord5', 'chord5-3', 'start', '991/480']], 'the request says where');

  // Beside a blocker release representation does answer -- the sub-grid gap an
  // unreachable Melody release leaves before the next attack -- the gate's hint
  // stays, and the boundary is still said to have none.
  const mixed = await runOn(shifted({ 'chord5-3': { start: '991/480' }, 'melody-1': { end: '479/480' } }));
  const both = gateRequest(mixed, 'microTiming');
  assert.ok(both, JSON.stringify(mixed.review_requests.map(entry => entry.gate)));
  assert.deepEqual(both.blockers, ['MICRO_TIMING_CLASSIFICATION_UNKNOWN', BOUNDARY, 'MICRO_TIMING_RELEASE_EVIDENCE_REQUIRED']);
  assert.deepEqual(both.available_operations, ['planMobileAdaptation', 'applyMobileAdaptation.release_representation']);
  assert.deepEqual(both.missing, [READINESS_BLOCKER_WITHOUT_OPERATION.microTiming[BOUNDARY]]);

  // The capability record says the same thing a request does.
  const caps = await createStudioApplication({}).capabilities();
  assert.ok(caps.runs.refuses.some(entry => entry.includes(BOUNDARY) && entry.includes('lists no operation')), JSON.stringify(caps.runs.refuses));
});

test('a release no release representation can move names no operation in a run, whatever follows it, and one it can move keeps the hint', async () => {
  // Chord5 of the six-role fixture is [0,1) [1,2) [2,4). Each case puts one of
  // its releases one 480-tick short of the 1/64 grid:
  //   K0  chord5-2 ends at 719/480 and an explicit rest runs from there to 2;
  //   K1  chord5-2 ends at 719/480 with implicit silence to 2;
  //   K2  chord5-3 ends at 1919/480, the role's end.
  // A keep claim on the release (accepted or pending) takes away every
  // representation, and in K0 the rest refuses both of them anyway, so K0 with
  // the claim rejected or absent is the same case. Before, K1 and K2 under a
  // claim passed microTiming and the run went on to a finalize the emitter
  // could not serialize, and K0 without a claim named release representation,
  // which refuses both options.
  const BOUNDARY = 'MICRO_TIMING_BOUNDARY_NOT_FINAL_REPRESENTABLE';
  const gap = { type: 'inter-event-gap', previousEventId: 'chord5-2', nextEventId: 'chord5-3', start: '719/480', end: '3/2' };
  const shapes = {
    K0: { changes: { 'chord5-2': { end: '719/480' } }, rest: true, identity: gap, claimed: ['chord5-2', 'chord5-3'] },
    K1: { changes: { 'chord5-2': { end: '719/480' } }, rest: false, identity: gap, claimed: ['chord5-2', 'chord5-3'] },
    K2: { changes: { 'chord5-3': { end: '1919/480' } }, rest: false, identity: { type: 'event-duration', eventId: 'chord5-3', start: '2', end: '1919/480' }, claimed: ['chord5-3'] },
  };
  const runOn = async (name, status) => {
    const shape = shapes[name];
    const source = sixRoleBaseline();
    const events = source.events.map(event => (shape.changes[event.id] ? createCanonicalNoteEvent({ ...event, ...shape.changes[event.id] }) : event));
    if (shape.rest) {
      events.push(createCanonicalRestEvent({ id: 'chord5-breath', start: '719/480', end: '2', role: 'Chord5', voice: 'chord5', sourceIds: [FIXTURE_SOURCE_ID], sourceEventIds: [`${FIXTURE_SOURCE_ID}#chord5-breath`] }));
    }
    const decisions = status ? [createArbitrationDecision({
      id: `keep-${status}`,
      eventIds: shape.claimed,
      action: MICRO_TIMING_KEEP_ACTION,
      status,
      reason: 'claimed musically meaningful',
      metadata: { intervalIdentity: createIntervalIdentity(shape.identity) },
    })] : [];
    const project = createCanonicalProject({ ...source, events, decisions });
    const isolated = createStudioApplication({});
    const own = await projectWithSymbolicAsset(isolated, OWNER, { project });
    await isolated.analyzeSources(OWNER, own.projectId, { assetIds: [own.assetId] });
    // An arrangement decision targets notes only; the explicit rest is carried.
    const notes = new Set(project.events.filter(event => event.kind === 'note').map(event => event.id));
    const accepted = runDecisionsFor(own.project).map(decision => ({ ...decision, target: { ...decision.target, eventIds: decision.target.eventIds.filter(id => notes.has(id)) } }));
    const candidate = (await isolated.applyDecisions(OWNER, own.projectId, { decisions: accepted })).decisions.candidate_id;
    return (await isolated.startRun(OWNER, own.projectId, { target_candidate_id: candidate, confirmations: FIXTURE_CONFIRMATIONS })).run;
  };
  const none = request => request.detail.unsupportedBoundaries.filter(entry => entry.coverage === 'none')
    .map(entry => [entry.role, entry.eventId, entry.kind, entry.boundary, entry.position, entry.reason]);
  const REST_START = ['Chord5', 'chord5-breath', 'rest', 'start', '719/480', 'REST_START_NOT_FINAL_REPRESENTABLE'];
  const claimedRelease = (eventId, position) => ['Chord5', eventId, 'note', 'end', position, 'RELEASE_UNDER_A_KEEP_CLAIM_NOT_FINAL_REPRESENTABLE'];

  const cases = [
    ['K0', 'accepted', [REST_START]],
    ['K0', 'pending', [REST_START]],
    ['K0', 'rejected', [REST_START]],
    ['K0', null, [REST_START]],
    ['K1', 'accepted', [claimedRelease('chord5-2', '719/480')]],
    ['K1', 'pending', [claimedRelease('chord5-2', '719/480')]],
    ['K2', 'accepted', [claimedRelease('chord5-3', '1919/480')]],
    ['K2', 'pending', [claimedRelease('chord5-3', '1919/480')]],
  ];
  for (const [name, status, expected] of cases) {
    const label = `${name} ${status ?? 'no'} keep`;
    const run = await runOn(name, status);
    assert.notEqual(run.state, RUN_STATE.COMPLETED, label);
    assert.equal(run.final_artifact_id, null, label);
    const request = gateRequest(run, 'microTiming');
    assert.ok(request, `${label}: ${JSON.stringify(run.review_requests.map(entry => entry.gate))}`);
    assert.deepEqual(request.blockers, [BOUNDARY], label);
    assert.deepEqual(request.available_operations, [], `${label}: no operation is offered that cannot answer the gate`);
    assert.deepEqual(request.missing, [READINESS_BLOCKER_WITHOUT_OPERATION.microTiming[BOUNDARY]], label);
    assert.deepEqual(none(request), expected, `${label}: the request says where, as G10 and the emitter do`);
    // A pending claim is an open decision besides, with its own answer.
    const pendingRequest = gateRequest(run, 'pendingDecisions');
    assert.equal(Boolean(pendingRequest), status === 'pending', label);
    if (pendingRequest) assert.deepEqual(pendingRequest.available_operations, ['applyDecisions'], label);
  }
  const text = READINESS_BLOCKER_WITHOUT_OPERATION.microTiming[BOUNDARY];
  assert.match(text, /a note release no release representation can move \(one under a keep claim, or one whose every representation is invalid\)/);
  assert.match(text, /RELEASE_EVENT_HAS_A_SOURCE_SUPPORTED_KEEP_CLAIM/);
  assert.match(text, /RELEASE_REPRESENTATION_NOT_VALID_FOR_EVENT/);

  // Control: K1 and K2 with the claim rejected or absent have a valid
  // representation, so G10 raises the release code, whose hint is true. Under
  // the listen-first schema the run holds the release provisionally and
  // delivers it for listening instead of asking.
  for (const [name, status] of [['K1', 'rejected'], ['K1', null], ['K2', null]]) {
    const label = `${name} ${status ?? 'no'} keep`;
    const run = await runOn(name, status);
    if (LISTEN_FIRST_RELEASES_ACTIVE) {
      assertRunHeldOrDeliveredUnresolved(run, [['microTiming', 'non_blocking_pending']]);
      const entry = run.machine_delivery.non_blocking_pending.find(item => item.gate === 'microTiming');
      assert.deepEqual(entry.blockers, ['MICRO_TIMING_RELEASE_NOT_FINAL_REPRESENTABLE', 'MICRO_TIMING_RELEASE_EVIDENCE_REQUIRED', 'MICRO_TIMING_RELEASE_PROVISIONAL'], label);
      continue;
    }
    const request = gateRequest(run, 'microTiming');
    assert.ok(request, label);
    assert.deepEqual(request.blockers, ['MICRO_TIMING_RELEASE_NOT_FINAL_REPRESENTABLE', 'MICRO_TIMING_RELEASE_EVIDENCE_REQUIRED', 'MICRO_TIMING_RELEASE_PROVISIONAL'], label);
    assert.deepEqual(request.available_operations, ['planMobileAdaptation', 'applyMobileAdaptation.release_representation'], label);
    assert.deepEqual(request.missing, [], label);
  }
});

test('a kept sub-grid rest at a release no representation can move does not let the run past microTiming', async () => {
  // chord5-2 ends at 719/480, one 480-tick short of the grid, and an explicit
  // rest one 480-tick long runs from there to the grid point 3/2, kept as
  // notated with admissible evidence. The rest refuses both representations of
  // chord5-2, so nothing moves its release, and the rest's own preserved
  // interval decides only the rest's start. Before, that interval was counted
  // as covering the release: microTiming passed, and the run went on to a
  // finalize the emitter could not write and halted on the technical gate,
  // whose request named finalize again. The kept rest is itself preserved
  // material no Final token can carry, so the gate states that too.
  const BOUNDARY = 'MICRO_TIMING_BOUNDARY_NOT_FINAL_REPRESENTABLE';
  const SOURCE_SUPPORTED = 'MICRO_TIMING_SOURCE_SUPPORTED_NOT_FINAL_REPRESENTABLE';
  const source = sixRoleBaseline();
  const events = source.events.map(event => (event.id === 'chord5-2' ? createCanonicalNoteEvent({ ...event, end: '719/480' }) : event));
  events.push(createCanonicalRestEvent({ id: 'chord5-breath', start: '719/480', end: '3/2', role: 'Chord5', voice: 'chord5', sourceIds: [FIXTURE_SOURCE_ID], sourceEventIds: [`${FIXTURE_SOURCE_ID}#chord5-breath`] }));
  const decisions = [createArbitrationDecision({
    id: 'keep-breath',
    eventIds: ['chord5-breath'],
    action: MICRO_TIMING_KEEP_ACTION,
    status: 'accepted',
    reason: 'notated breath',
    evidence: ['official MIDI, bar 1: notated separation'],
    metadata: { evidenceSourceIds: [FIXTURE_SOURCE_ID], intervalIdentity: createIntervalIdentity({ type: 'event-duration', eventId: 'chord5-breath', start: '719/480', end: '3/2' }) },
  })];
  const project = createCanonicalProject({ ...source, events, decisions });
  const isolated = createStudioApplication({});
  const own = await projectWithSymbolicAsset(isolated, OWNER, { project });
  await isolated.analyzeSources(OWNER, own.projectId, { assetIds: [own.assetId] });
  const notes = new Set(project.events.filter(event => event.kind === 'note').map(event => event.id));
  const accepted = runDecisionsFor(own.project).map(decision => ({ ...decision, target: { ...decision.target, eventIds: decision.target.eventIds.filter(id => notes.has(id)) } }));
  const candidate = (await isolated.applyDecisions(OWNER, own.projectId, { decisions: accepted })).decisions.candidate_id;
  const { run } = await isolated.startRun(OWNER, own.projectId, { target_candidate_id: candidate, confirmations: FIXTURE_CONFIRMATIONS });

  assert.notEqual(run.state, RUN_STATE.COMPLETED);
  assert.equal(run.final_artifact_id, null);
  assert.equal(run.review_requests.some(entry => entry.code === 'FINALIZE_BLOCKED' || entry.gate === 'technical'), false,
    `the run stops at microTiming, before finalize: ${JSON.stringify(run.review_requests.map(entry => [entry.code, entry.gate]))}`);
  const request = gateRequest(run, 'microTiming');
  assert.ok(request, JSON.stringify(run.review_requests.map(entry => entry.gate)));
  assert.deepEqual(request.blockers, [BOUNDARY, SOURCE_SUPPORTED]);
  assert.deepEqual(request.available_operations, [], 'no operation is offered that cannot answer the gate');
  assert.deepEqual(request.missing, [
    READINESS_BLOCKER_WITHOUT_OPERATION.microTiming[BOUNDARY],
    READINESS_BLOCKER_WITHOUT_OPERATION.microTiming[SOURCE_SUPPORTED],
  ]);
  assert.deepEqual(request.detail.unsupportedBoundaries.map(entry => [entry.role, entry.eventId, entry.kind, entry.boundary, entry.position, entry.coverage]), [
    ['Chord5', 'chord5-breath', 'rest', 'start', '719/480', 'analysed-interval'],
    ['Chord5', 'chord5-2', 'note', 'end', '719/480', 'none'],
  ], 'the rest\'s start is decided by its interval; the release is the position nothing decides');
});

test('kept sub-grid material no Final token can carry holds the run at microTiming and names no operation', async () => {
  // The owner's two shapes in Chord5 of the six-role fixture, each kept as
  // notated with admissible evidence: (a) chord5-2 attacks one 480-tick after
  // chord5-1's release on the beat, and the sub-grid gap between them is kept;
  // (b) chord5-1 releases one 480-tick short of the beat into a legato sub-grid
  // note chord5-z whose own duration is kept. Every position either one has to
  // reach is decided by the kept interval ('analysed-interval'), and preserved
  // material used to raise nothing, so microTiming passed and the run went on
  // to a finalize the emitter refused (SOURCE_SUPPORTED_INTERVAL_NOT_REPRESENTABLE),
  // halting on the technical gate with a request that named finalize again.
  const SOURCE_SUPPORTED = 'MICRO_TIMING_SOURCE_SUPPORTED_NOT_FINAL_REPRESENTABLE';
  const keep = (id, eventIds, identity) => createArbitrationDecision({
    id,
    eventIds,
    action: MICRO_TIMING_KEEP_ACTION,
    status: 'accepted',
    reason: 'notated',
    evidence: ['official MIDI, bar 1: notated as written'],
    metadata: { evidenceSourceIds: [FIXTURE_SOURCE_ID], intervalIdentity: createIntervalIdentity(identity) },
  });
  const runOn = async ({ changes = {}, added = [], decisions }) => {
    const source = sixRoleBaseline();
    const events = [
      ...source.events.map(event => (changes[event.id] ? createCanonicalNoteEvent({ ...event, ...changes[event.id] }) : event)),
      ...added,
    ];
    const project = createCanonicalProject({ ...source, events, decisions });
    const isolated = createStudioApplication({});
    const own = await projectWithSymbolicAsset(isolated, OWNER, { project });
    await isolated.analyzeSources(OWNER, own.projectId, { assetIds: [own.assetId] });
    const notes = new Set(project.events.filter(event => event.kind === 'note').map(event => event.id));
    const accepted = runDecisionsFor(own.project).map(decision => ({ ...decision, target: { ...decision.target, eventIds: decision.target.eventIds.filter(id => notes.has(id)) } }));
    const candidate = (await isolated.applyDecisions(OWNER, own.projectId, { decisions: accepted })).decisions.candidate_id;
    return (await isolated.startRun(OWNER, own.projectId, { target_candidate_id: candidate, confirmations: FIXTURE_CONFIRMATIONS })).run;
  };
  const chord5z = createCanonicalNoteEvent({ id: 'chord5-z', pitch: 50, start: '479/480', end: '1', role: 'Chord5', voice: 'chord5', volume: null, sourceIds: [FIXTURE_SOURCE_ID], sourceEventIds: [`${FIXTURE_SOURCE_ID}#chord5-z`] });
  const cases = {
    'a kept sub-grid gap before an unreachable onset': {
      changes: { 'chord5-2': { start: '481/480' } },
      decisions: [keep('keep-gap', ['chord5-1', 'chord5-2'], { type: 'inter-event-gap', previousEventId: 'chord5-1', nextEventId: 'chord5-2', start: '1', end: '481/480' })],
      entries: [['Chord5', 'chord5-2', 'note', 'start', '481/480', 'analysed-interval']],
    },
    'a legato join into a kept sub-grid note': {
      changes: { 'chord5-1': { end: '479/480' } },
      added: [chord5z],
      decisions: [keep('keep-z', ['chord5-z'], { type: 'event-duration', eventId: 'chord5-z', start: '479/480', end: '1' })],
      entries: [
        ['Chord5', 'chord5-1', 'note', 'end', '479/480', 'analysed-interval'],
        ['Chord5', 'chord5-z', 'note', 'start', '479/480', 'analysed-interval'],
      ],
    },
  };
  for (const [label, shape] of Object.entries(cases)) {
    const run = await runOn(shape);
    assert.notEqual(run.state, RUN_STATE.COMPLETED, label);
    assert.equal(run.final_artifact_id, null, label);
    assert.equal(run.review_requests.some(entry => entry.code === 'FINALIZE_BLOCKED' || entry.gate === 'technical'), false,
      `${label}: the run stops at microTiming, before finalize: ${JSON.stringify(run.review_requests.map(entry => [entry.code, entry.gate]))}`);
    const request = gateRequest(run, 'microTiming');
    assert.ok(request, `${label}: ${JSON.stringify(run.review_requests.map(entry => entry.gate))}`);
    assert.deepEqual(request.blockers, [SOURCE_SUPPORTED], label);
    assert.deepEqual(request.available_operations, [], `${label}: no operation is offered that cannot answer the gate`);
    assert.deepEqual(request.missing, [READINESS_BLOCKER_WITHOUT_OPERATION.microTiming[SOURCE_SUPPORTED]], label);
    assert.match(request.missing[0], /No operation in this build answers it/, label);
    assert.match(request.missing[0], /the gate still blocks/, label);
    assert.deepEqual(request.detail.unsupportedBoundaries.map(entry => [entry.role, entry.eventId, entry.kind, entry.boundary, entry.position, entry.coverage]),
      shape.entries, `${label}: the entries and their coverage are what they were`);
    assert.equal(request.detail.preservedIntervalKeys.length, 1, label);
  }

  // Beside a blocker release representation does answer -- the sub-grid gap an
  // unreachable Melody release leaves before the next attack -- the gate keeps
  // its hint, and the preserved material is still said to have no answer.
  const legato = cases['a legato join into a kept sub-grid note'];
  const mixed = await runOn({ ...legato, changes: { ...legato.changes, 'melody-1': { end: '479/480' } } });
  const both = gateRequest(mixed, 'microTiming');
  assert.ok(both, JSON.stringify(mixed.review_requests.map(entry => entry.gate)));
  assert.deepEqual(both.blockers, ['MICRO_TIMING_CLASSIFICATION_UNKNOWN', SOURCE_SUPPORTED, 'MICRO_TIMING_RELEASE_EVIDENCE_REQUIRED']);
  assert.deepEqual(both.available_operations, ['planMobileAdaptation', 'applyMobileAdaptation.release_representation']);
  assert.deepEqual(both.missing, [READINESS_BLOCKER_WITHOUT_OPERATION.microTiming[SOURCE_SUPPORTED]]);

  // The capability record says the same thing a request does.
  const caps = await createStudioApplication({}).capabilities();
  assert.ok(caps.runs.refuses.some(entry => entry.includes(SOURCE_SUPPORTED) && entry.includes('MICRO_TIMING_BOUNDARY_NOT_FINAL_REPRESENTABLE')
    && entry.includes('lists no operation')), JSON.stringify(caps.runs.refuses));
});

test('a role that starts after a silence shorter than any Final token holds the run at microTiming and names no operation', async () => {
  // Chord5's first note attacks at 1/240 of a beat. No admitted token is
  // shorter than 1/16 beat, so the role cannot reach it, although its
  // denominator divides the admitted lcm. G10 used to PASS it, and the run
  // went on to a finalize the emitter refused, halting with FINALIZE_BLOCKED
  // and a technical request that named finalize again.
  const BOUNDARY = 'MICRO_TIMING_BOUNDARY_NOT_FINAL_REPRESENTABLE';
  const source = sixRoleBaseline();
  const project = createCanonicalProject({
    ...source,
    events: source.events.map(event => (event.id === 'chord5-1' ? createCanonicalNoteEvent({ ...event, start: '1/240' }) : event)),
  });
  const isolated = createStudioApplication({});
  const own = await projectWithSymbolicAsset(isolated, OWNER, { project });
  await isolated.analyzeSources(OWNER, own.projectId, { assetIds: [own.assetId] });
  const candidate = (await isolated.applyDecisions(OWNER, own.projectId, { decisions: runDecisionsFor(own.project) })).decisions.candidate_id;
  const { run } = await isolated.startRun(OWNER, own.projectId, { target_candidate_id: candidate, confirmations: FIXTURE_CONFIRMATIONS });

  assert.notEqual(run.state, RUN_STATE.COMPLETED);
  assert.equal(run.final_artifact_id, null);
  assert.equal(run.review_requests.some(entry => entry.code === 'FINALIZE_BLOCKED' || entry.gate === 'technical'), false,
    `the run stops at microTiming, before finalize: ${JSON.stringify(run.review_requests.map(entry => [entry.code, entry.gate]))}`);
  const request = gateRequest(run, 'microTiming');
  assert.ok(request, JSON.stringify(run.review_requests.map(entry => entry.gate)));
  assert.deepEqual(request.blockers, [BOUNDARY]);
  assert.deepEqual(request.available_operations, [], 'no operation moves an attack');
  assert.deepEqual(request.missing, [READINESS_BLOCKER_WITHOUT_OPERATION.microTiming[BOUNDARY]]);
  assert.deepEqual(request.detail.unsupportedBoundaries.map(entry => [entry.role, entry.eventId, entry.kind, entry.boundary, entry.position, entry.reason, entry.coverage]), [
    ['Chord5', 'chord5-1', 'note', 'start', '1/240', 'LEADING_SILENCE_SHORTER_THAN_ANY_FINAL_TOKEN', 'none'],
  ], 'the request says where, and why');
});

// ─── a finalize the Final emitter refused ───────────────────────────────────

test('a finalize the Final emitter refused names no operation and carries the emitter\'s own codes', async () => {
  // A real Tempo change one 480-tick before beat 3 of the six-role fixture. G10
  // does not read the Tempo Map, so every gate finalize grades before emission
  // is satisfied; the emitter then refuses to split the Chord notes the change
  // crosses at a position no admitted token sequence reaches. The run used to
  // name reviewCandidate, recordConfirmations, approveCore3SourceChange,
  // reviewLeadEvidence and attachAudioAlignment on FINALIZE_BLOCKED, and
  // finalize again on the technical request. None of them changes the refusal.
  const source = sixRoleBaseline({ id: 'fixture:unreachable-tempo' });
  const project = createCanonicalProject({
    ...source,
    tempoEvents: [
      ...source.tempoEvents,
      createCanonicalTempoEvent({ id: 'tempo-2', beat: '1439/480', bpm: 100, sourceIds: [FIXTURE_SOURCE_ID], sourceEventIds: [`${FIXTURE_SOURCE_ID}#tempo-2`] }),
    ],
  });
  const isolated = createStudioApplication({});
  const own = await projectWithSymbolicAsset(isolated, OWNER, { project });
  await isolated.analyzeSources(OWNER, own.projectId, { assetIds: [own.assetId] });
  const candidate = (await isolated.applyDecisions(OWNER, own.projectId, { decisions: runDecisionsFor(own.project) })).decisions.candidate_id;
  const { run } = await isolated.startRun(OWNER, own.projectId, { target_candidate_id: candidate, confirmations: FIXTURE_CONFIRMATIONS });

  assert.equal(run.state, RUN_STATE.AWAITING_REVIEW, JSON.stringify(run.blockers));
  assert.equal(run.final_artifact_id, null);
  assert.equal(statusOf(run, RUN_STEP.FINALIZE), RUN_STEP_STATUS.BLOCKED);
  const finalize = run.steps.find(entry => entry.step === RUN_STEP.FINALIZE);
  assert.equal(finalize.detail.operation, 'failed', 'the emitter refused: finalize reports failed');
  assert.equal(finalize.detail.emit_status, 'FAIL');

  const blocked = requestFor(run, 'FINALIZE_BLOCKED');
  assert.ok(blocked, JSON.stringify(run.review_requests.map(entry => entry.code)));
  assert.deepEqual(blocked.available_operations, [], 'no operation answers the emitter\'s refusal');
  assert.deepEqual(blocked.detail.emitter_blockers, ['BOUNDARY_NOT_FINAL_REPRESENTABLE'], 'the emitter\'s own code, so an agent can see why');
  assert.equal(blocked.detail.emit_status, 'FAIL');
  assert.match(blocked.missing.join(' '), /The Final emitter refused this candidate \(emit_status FAIL: BOUNDARY_NOT_FINAL_REPRESENTABLE\)/);
  const technical = gateRequest(run, 'technical');
  assert.ok(technical, JSON.stringify(run.review_requests.map(entry => entry.gate)));
  assert.deepEqual(technical.available_operations, [], 'finalizing the same candidate again returns the same refusal');
  assert.match(technical.missing.join(' '), /BOUNDARY_NOT_FINAL_REPRESENTABLE/);
  assert.deepEqual(run.review_requests.flatMap(entry => entry.available_operations), [], 'the run names no operation at all');

  // The read-only next-step projection says the same thing.
  const next = await isolated.nextRun(OWNER, own.projectId, run.run_id, {});
  assert.deepEqual(next.reviewer_operations, []);
  // And so does the capability record.
  const caps = await createStudioApplication({}).capabilities();
  assert.ok(caps.runs.refuses.some(entry => entry.includes('Final emitter refused') && entry.includes('detail.emitter_blockers')), JSON.stringify(caps.runs.refuses));
});

test('a finalize the Final parser refused after emission keeps the operations that answer it', async () => {
  // Control. One extra Melody beat past the last full 4/4 bar: the emitter
  // writes it, the Final parser rejects the partial bar, and finalize with the
  // source-confirmed final_partial is the answer that exists. A refusal that is
  // not the emitter's keeps every hint it had.
  const source = sixRoleBaseline({ id: 'fixture:partial-bar' });
  const project = createCanonicalProject({
    ...source,
    events: [...source.events, createCanonicalNoteEvent({ id: 'melody-4', pitch: 74, start: '4', end: '5', sourceIds: [FIXTURE_SOURCE_ID], sourceEventIds: [`${FIXTURE_SOURCE_ID}#melody-4`], role: 'Melody', voice: 'melody', volume: null, metadata: {} })],
  });
  const isolated = createStudioApplication({});
  const own = await projectWithSymbolicAsset(isolated, OWNER, { project });
  await isolated.analyzeSources(OWNER, own.projectId, { assetIds: [own.assetId] });
  const candidate = (await isolated.applyDecisions(OWNER, own.projectId, { decisions: runDecisionsFor(own.project) })).decisions.candidate_id;
  const { run } = await isolated.startRun(OWNER, own.projectId, { target_candidate_id: candidate, confirmations: FIXTURE_CONFIRMATIONS });

  assert.equal(run.state, RUN_STATE.AWAITING_REVIEW, JSON.stringify(run.blockers));
  const finalize = run.steps.find(entry => entry.step === RUN_STEP.FINALIZE);
  assert.equal(finalize.detail.operation, 'blocked');
  assert.equal(finalize.detail.emit_status, 'PASS');
  const blocked = requestFor(run, 'FINALIZE_BLOCKED');
  assert.deepEqual(blocked.available_operations, ['reviewCandidate', 'recordConfirmations', 'approveCore3SourceChange', 'reviewLeadEvidence', 'attachAudioAlignment']);
  assert.equal(Object.hasOwn(blocked.detail, 'emitter_blockers'), false);
  assert.deepEqual(gateRequest(run, 'technical').available_operations, ['finalize']);
  assert.deepEqual(gateRequest(run, 'technical').missing, []);
});

// ─── an unknown blocker still blocks ────────────────────────────────────────

test('a readiness blocker the run has never heard of is reported and still stops it', async () => {
  // One function wrapped: readiness gains a gate this layer does not know. Every
  // other verdict in the run is the real one.
  const app = createStudioApplication({
    loadEngines: enginesWith(engines => ({
      final: {
        ...engines.final,
        evaluateProjectReadiness: input => {
          const real = engines.final.evaluateProjectReadiness(input);
          return Object.freeze({
            ...real,
            candidateReady: false,
            preGameBlocking: Object.freeze([...real.preGameBlocking, 'futureGateNobodyHasSeen']),
            gates: Object.freeze({ ...real.gates, futureGateNobodyHasSeen: Object.freeze({ status: 'PENDING', blockers: ['A_BLOCKER_FROM_THE_FUTURE'] }) }),
          });
        },
      },
    })),
  });
  const fixture = await projectWithSymbolicAsset(app, OWNER, { project: sixRoleBaseline() });

  const started = await app.startRun(OWNER, fixture.projectId, {
    asset_ids: [fixture.assetId],
    decisions: runDecisionsFor(fixture.project),
    accepted_by: RUN_REVIEWER,
    confirmations: FIXTURE_CONFIRMATIONS,
  });

  // The run did not complete, and it did not quietly drop the gate it cannot
  // name: no allow-list decided this.
  assert.notEqual(started.run.state, RUN_STATE.COMPLETED);
  assert.equal(started.run.final_artifact_id, null);
  assert.ok(started.run.readiness_blockers.includes('futureGateNobodyHasSeen'));
  const unknown = gateRequest(started.run, 'futureGateNobodyHasSeen');
  assert.ok(unknown, JSON.stringify(started.run.review_requests.map(entry => entry.gate)));
  assert.equal(unknown.known, false, 'the run says it has no hint for this gate');
  assert.deepEqual(unknown.blockers, ['A_BLOCKER_FROM_THE_FUTURE'], 'the upstream code is carried through unchanged');
  assert.deepEqual(unknown.available_operations, [], 'no operation is invented for a gate the run does not know');
  assert.match(unknown.missing.join(' '), /It still blocks/);
});
