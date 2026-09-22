// From release evidence to a delivered, VALIDATED Final — through the one run.
//
// Synthetic fixture with the real 《怪獸之歌》 one-tick release shape
// (fixtures/release-fixtures.mjs). It proves the workflow, not the song:
//
//   run start (decisions)        → deterministic intake, suggestion, G11-D, review
//                                  stops on the micro-timing gate and says exactly
//                                  what evidence would answer it
//   resume (release evidence)    → Mobile adaptation represents the releases,
//                                  review runs again by itself
//   resume (reviewer statements) → review, finalize, report: a VALIDATED Final with
//                                  paste-ready MML, and in-game still PENDING
//
// Nothing here fabricates a gate: every confirmation is a statement the fixture
// reviewer makes, stated where it is made, and in_game is never set.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

import { createStudioApplication, RUN_STATE, RUN_STEP, RUN_STEP_STATUS } from '../backend/application/index.mjs';
import { splitMML, parseTrack } from '../backend/mml/parser.mjs';
import { ROLES } from '../backend/mml/index.mjs';
import { RELEASE_REGRID_CANDIDATE } from '../backend/canonical/release-regrid-candidate.mjs';
import { OWNER, listeningDecision, oneTickEarlyBaseline, roleDecisions, ALL_RELEASE_EVENTS } from './fixtures/release-fixtures.mjs';

const statusOf = (run, step) => run.steps.find(entry => entry.step === step)?.status ?? null;
const receiptOf = (run, step) => [...run.steps].reverse().find(entry => entry.step === step) ?? null;

const REVIEWER_STATEMENTS = candidateId => ({
  source_complete: { value: true, reason: 'The synthetic fixture project is the complete material.' },
  version_drift_reviewed: { value: true, reason: 'The accepted role and release decisions are the fixture reviewer\'s own.' },
  player_readback: { value: 'N/A', reason: 'No preview or verification player is used for this synthetic cue.' },
  core3_completeness_reviewed: { value: true, reason: 'Melody, Chord1 and Chord2 stand as a one-player arrangement in the fixture.', evidence: ['fixture:gate-4'] },
  mobile_adaptation_reviewed: { value: true, reason: 'The release representation was reviewed against Gate 8: minimal, evidence-backed, reported as adaptation.', evidence: ['fixture:gate-8/release-representation'] },
  regression_reviewed: { value: true, reason: 'Compared against the Source-Faithful Baseline: only releases moved, each by one tick, each recorded.', evidence: ['fixture:gate-9'] },
  original_audio_reviewed: { value: true, reason: 'Role, prominence, sustain and articulation reviewed against the recording.', evidence: ['fixture:gate-7 listening notes'], candidate_id: candidateId },
});

async function setUp(app, { title = 'Release delivery run' } = {}) {
  const baseline = oneTickEarlyBaseline();
  const created = (await app.createProject(OWNER, { title })).project;
  const symbolic = (await app.uploadAsset(OWNER, created.project_id, { kind: 'canonical_project', filename: 'b.json', mediaType: 'application/json', bytes: new TextEncoder().encode(JSON.stringify(baseline)) })).asset;
  const audio = (await app.uploadAsset(OWNER, created.project_id, { kind: 'original_audio', filename: 'song.m4a', mediaType: 'audio/mp4', bytes: new TextEncoder().encode('synthetic audio bytes') })).asset;
  return { baseline, projectId: created.project_id, symbolicAssetId: symbolic.asset_id, audio };
}

const alignmentReport = (baseline, audio, candidateProjectId) => ({
  schema: 'mabinogi-mobile-mml-studio/audio-alignment@1',
  audio: { sha256: audio.sha256, filename: 'song.m4a' },
  symbolic: { project_id: candidateProjectId },
  evidence_policy: { changes_symbolic_truth: false },
  alignment: { control_points: [{ beat: 0, seconds: 0 }, { beat: 4, seconds: 1.6 }], metrics: { confidence: 0.93, score_frame_coverage: 0.99, audio_frame_coverage: 0.96 } },
});

async function deliver(app, { acceptedBy = 'reviewer:fixture' } = {}) {
  const fixture = await setUp(app);
  const { projectId } = fixture;
  // 1. One call: everything deterministic runs; the run stops where evidence is missing.
  const started = await app.startRun(OWNER, projectId, { asset_ids: [fixture.symbolicAssetId], decisions: roleDecisions(), accepted_by: acceptedBy });
  const runId = started.run.run_id;
  const g11d = started.run.candidate_id;
  // 2. The reviewer previews the release representation the recording supports.
  const releaseRepresentation = { decisions: [listeningDecision(fixture.audio.asset_id, ALL_RELEASE_EVENTS)] };
  const plan = (await app.planMobileAdaptation(OWNER, projectId, { candidateId: g11d, releaseRepresentation })).adaptation.plan;
  // 3. One call: adaptation, re-review.
  const adapted = await app.resumeRun(OWNER, projectId, runId, { mobile_adaptation: { release_representation: releaseRepresentation, expected_plan_id: plan.id, accepted_by: acceptedBy } });
  const finalCandidate = adapted.run.candidate_id;
  const record = (await app.getProject(OWNER, projectId)).project;
  const stored = record.candidates.find(candidate => candidate.candidate_id === finalCandidate);
  await app.attachAudioAlignment(OWNER, projectId, { candidateId: finalCandidate, report: alignmentReport(fixture.baseline, fixture.audio, `${fixture.baseline.id}#mobile-r${stored.revision_index}`) });
  // 4. One call: the reviewer's statements; review, finalize and report follow by themselves.
  const finished = await app.resumeRun(OWNER, projectId, runId, { confirmations: REVIEWER_STATEMENTS(finalCandidate) });
  return { fixture, started, plan, adapted, finished, g11d, finalCandidate };
}

test('RDR-1 the run stops only where evidence is missing and says what would answer it', async () => {
  const app = createStudioApplication({});
  const fixture = await setUp(app);
  const started = await app.startRun(OWNER, fixture.projectId, { asset_ids: [fixture.symbolicAssetId], decisions: roleDecisions(), accepted_by: 'reviewer:fixture' });
  assert.equal(started.run.state, RUN_STATE.AWAITING_REVIEW);
  for (const step of [RUN_STEP.INTAKE, RUN_STEP.SUGGEST, RUN_STEP.APPLY_DECISIONS]) assert.equal(statusOf(started.run, step), RUN_STEP_STATUS.COMPLETED, step);
  // No profile, no release decision: nothing is invented, and the receipt says
  // which Mobile decisions the missing profile blocks and what the releases need.
  const adaptation = receiptOf(started.run, RUN_STEP.MOBILE_ADAPTATION);
  assert.equal(adaptation.status, RUN_STEP_STATUS.SKIPPED);
  assert.deepEqual(adaptation.detail.profile_not_required_for, ['release representation of releases Final cannot express']);
  assert.equal(adaptation.detail.release_timing.targetCount, 8);
  assert.equal(adaptation.detail.release_timing.decision_required, true);
  assert.deepEqual(adaptation.detail.release_timing.encoding_observations.map(item => [item.uniform, item.admissible_as_evidence]), [[true, false]]);
  const micro = started.run.review_requests.find(request => request.gate === 'microTiming');
  assert.ok(micro, JSON.stringify(started.run.review_requests.map(request => request.gate)));
  assert.deepEqual(micro.available_operations, ['planMobileAdaptation', 'applyMobileAdaptation.release_representation']);
  assert.ok(micro.blockers.includes('MICRO_TIMING_RELEASE_NOT_FINAL_REPRESENTABLE'));
  // Nothing was delivered and the song is a CANDIDATE.
  assert.equal(started.run.final_artifact_id ?? null, null);
  const direct = await app.finalize(OWNER, fixture.projectId, { candidateId: started.run.candidate_id });
  assert.equal(direct.artifact_id, null);
  assert.equal(direct.mml, null);
  assert.equal(direct.song_state, 'CANDIDATE');
});

test('RDR-2 evidence and reviewer statements take the same run to a VALIDATED paste-ready Final with in-game still pending', async () => {
  const app = createStudioApplication({});
  const { adapted, finished, finalCandidate, g11d } = await deliver(app);
  assert.equal(statusOf(adapted.run, RUN_STEP.MOBILE_ADAPTATION), RUN_STEP_STATUS.COMPLETED);
  assert.notEqual(finalCandidate, g11d);
  assert.equal(finished.run.state, RUN_STATE.COMPLETED, JSON.stringify(finished.run.halt ?? finished.run.review_requests));
  assert.equal(statusOf(finished.run, RUN_STEP.FINALIZE), RUN_STEP_STATUS.COMPLETED);

  const artifact = (await app.getArtifact(OWNER, finished.run.final_artifact_id)).artifact;
  assert.equal(artifact.candidate_id, finalCandidate);
  assert.equal(artifact.song_state, 'VALIDATED');
  assert.equal(artifact.delivery.delivered, true);
  assert.equal(artifact.delivery.validated_under.rules_snapshot_sha, '0a172900a01fdf39c2e9e84cf176961320b779ea');
  assert.deepEqual(artifact.delivery.post_delivery_evidence.map(item => [item.axis, item.status, item.blocks_delivery]), [['listening_feedback', 'NOT_YET_PROVIDED', false], ['in_game', 'PENDING', false]]);
  assert.equal(artifact.gates.in_game, 'PENDING', 'missing in-game acceptance did not block delivery and was not invented');
  assert.equal(artifact.mml_sha256, createHash('sha256').update(artifact.mml, 'utf8').digest('hex'));
  assert.equal(artifact.micro_gap.status, 'PASS');
  assert.equal(artifact.micro_gap.releaseRepresentationRecords.recordCount, 8);
  assert.equal(artifact.round_trip.status, 'PASS');
  assert.match(artifact.acceptance_notice, /never implies IN_GAME_ACCEPTED/);

  // The paste-ready string obeys the loaded Final syntax, from outside the run.
  const revalidated = await app.validateTechnicalMml({ mml: artifact.mml, meter_text: artifact.final_bar.meter_text });
  assert.equal(revalidated.technical_ok, true);
  const tracks = splitMML(artifact.mml);
  const read = role => parseTrack(tracks[ROLES.indexOf(role)], role, { mode: 'final' });
  // Repeated same-pitch attacks stay two attacks; no tie hides them.
  const melody = read('Melody');
  assert.deepEqual(melody.events.map(event => [event.pitch, event.start, event.end]), [[72, '0', '1'], [74, '1', '2'], [74, '2', '3'], [76, '3', '4']]);
  assert.equal(tracks[ROLES.indexOf('Melody')].includes('&'), false);
  // The real rest after bass-1 survives, one tick shorter than the source rest.
  assert.deepEqual(read('Chord2').events.map(event => [event.start, event.end]), [['0', '1'], ['2', '4']]);

  const report = (await app.getArtifact(OWNER, finished.run.report_artifact_id)).artifact;
  assert.equal(report.song_state, 'VALIDATED');
  assert.equal(report.final_mml_sha256, artifact.mml_sha256);
  // The unpublished release-regrid candidate played no part: it is still inactive.
  assert.deepEqual(RELEASE_REGRID_CANDIDATE.activeInCanonicalVersions, []);
});

test('RDR-3 the conversation provider named in the run changes no validation result and no MML', async () => {
  const appA = createStudioApplication({});
  const appB = createStudioApplication({});
  const a = await deliver(appA, { acceptedBy: 'conversation:chatgpt-relay' });
  const b = await deliver(appB, { acceptedBy: 'conversation:claude-relay' });
  assert.equal(a.finished.run.state, RUN_STATE.COMPLETED);
  assert.equal(b.finished.run.state, RUN_STATE.COMPLETED);
  const artifactA = (await appA.getArtifact(OWNER, a.finished.run.final_artifact_id)).artifact;
  const artifactB = (await appB.getArtifact(OWNER, b.finished.run.final_artifact_id)).artifact;
  assert.equal(artifactA.mml, artifactB.mml);
  assert.equal(artifactA.mml_sha256, artifactB.mml_sha256);
  assert.equal(artifactA.song_state, artifactB.song_state);
  assert.deepEqual(artifactA.gates, artifactB.gates);
  assert.deepEqual(artifactA.readiness_summary.gates, artifactB.readiness_summary.gates);
});

test('RDR-4 no parser, emitter, run or reviewer statement can set in-game acceptance', async () => {
  const app = createStudioApplication({});
  const { fixture, finished } = await deliver(app);
  await assert.rejects(() => app.recordConfirmations(OWNER, fixture.projectId, { in_game: { value: 'PASS', reason: 'played it' } }));
  await assert.rejects(() => app.resumeRun(OWNER, fixture.projectId, finished.run.run_id, { confirmations: { in_game_acceptance: { value: 'PASS', reason: 'played it' } } }));
  const artifact = (await app.getArtifact(OWNER, finished.run.final_artifact_id)).artifact;
  assert.notEqual(artifact.song_state, 'IN_GAME_ACCEPTED');
  assert.equal(artifact.gates.in_game, 'PENDING');
});

test('RDR-5 no executable module carries a song-specific identifier or bypass', () => {
  const roots = ['studio/backend', 'server', 'railway'].map(dir => join(process.cwd(), dir));
  const offenders = [];
  const walk = dir => {
    for (const name of readdirSync(dir)) {
      const path = join(dir, name);
      if (statSync(path).isDirectory()) { if (name !== 'node_modules') walk(path); continue; }
      if (!/\.(mjs|js)$/.test(name)) continue;
      if (/kaiju|怪獸|怪獣|hanauta|prj_a808b53c|5819c9c5e7b5/i.test(readFileSync(path, 'utf8'))) offenders.push(path);
    }
  };
  roots.forEach(walk);
  assert.deepEqual(offenders, []);
});
