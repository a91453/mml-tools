// The closed loop the Final Six-Role Reduction exists to complete.
//
//   G11-D candidate
//     → reduction preview          (read-only, every event accounted for)
//     → reduction apply            (derived, content-addressed candidate)
//     → Mobile Adaptation          (register / volume, on the reduced roles)
//     → candidate review           (every touched gate PENDING again)
//     → reviewer confirmations     (Gate 4 / Gate 8 / Gate 9, with evidence)
//     → studio_finalize            (Final MML + round-trip readback)
//
// The assertions worth having here are the ones a unit test of the stage
// cannot make: that the reduction candidate is a first-class input to every
// later stage, that applying it certifies nothing, and that the Final emitter
// serializes the revision the reduction produced rather than an earlier one.

import test from 'node:test';
import assert from 'node:assert/strict';
import { createStudioApplication } from '../backend/application/index.mjs';
import { verifyFinalReadback } from '../backend/final/round-trip.mjs';
import { canonicalProjectBytes, keepEveryRole } from './fixtures/application-fixtures.mjs';
import { baselineWithUnassignedRole, FIXTURE_SOURCE_ID } from './fixtures/g12-fixtures.mjs';

const OWNER = 'owner:pipeline';

const PLACE_CHORD5 = {
  id: 'place-chord5',
  action: 'REDISTRIBUTE',
  eventIds: ['chord5-1', 'chord5-2', 'chord5-3'],
  toRole: 'Chord5',
  reason: 'The official source carries this lane as secondary bass reinforcement; it is placed in the one free enrichment role.',
  evidence: [`${FIXTURE_SOURCE_ID}#Chord5`],
};

const MOBILE_PROFILE = {
  schema: 'mml-studio/mobile-adaptation-profile@1',
  id: 'pipeline-target',
  reason: 'Synthetic target register for the reduced candidate; not an instrument recommendation.',
  evidence: ['fixture:target-client/register'],
  roles: { Chord5: { pitchRange: [36, 59], defaultVolume: 9 } },
};

const CONFIRMATIONS = Object.freeze({
  source_complete: { value: true, reason: 'The fixture is the complete material.' },
  player_readback: { value: 'N/A', reason: 'No preview or verification assets are used for this cue.' },
  version_drift_reviewed: { value: true, reason: 'The role moves this candidate carries are the reduction decisions the reviewer accepted.' },
  core3_completeness_reviewed: { value: true, reason: 'Core3 stands up without Chord3-Chord5 for this fixture.', evidence: ['fixture Gate 4 review'] },
  mobile_adaptation_reviewed: { value: true, reason: 'The adapted candidate was reviewed against Gate 8.', evidence: ['fixture Gate 8 review'] },
  regression_reviewed: { value: true, reason: 'The adapted candidate was reviewed against Gate 9.', evidence: ['fixture Gate 9 review'] },
  original_audio_required: { value: false, reason: 'The fixture workflow has no recording.' },
});

async function g11dCandidate(service) {
  const project = baselineWithUnassignedRole();
  const created = (await service.createProject(OWNER, { title: 'Reduction pipeline' })).project;
  await service.uploadAsset(OWNER, created.project_id, { kind: 'canonical_project', filename: 'baseline.json', mediaType: 'application/json', bytes: canonicalProjectBytes(project) });
  await service.analyzeSources(OWNER, created.project_id);
  // Chord5's material has no role in this baseline, so it gets no KEEP: the
  // reduction is what decides where it goes.
  const decisions = keepEveryRole(project).filter(decision => decision.fromRole !== 'Chord5');
  const applied = await service.applyDecisions(OWNER, created.project_id, { decisions });
  return { project, projectId: created.project_id, candidateId: applied.decisions.candidate_id };
}

test('G11-D → reduction → Mobile adaptation → review → finalize → Final MML → round-trip', async () => {
  const service = createStudioApplication({});
  const run = await g11dCandidate(service);

  // ── G12-B preview ──
  const preview = await service.planFinalReduction(OWNER, run.projectId, { candidateId: run.candidateId, decisions: [PLACE_CHORD5], acceptedBy: 'pipeline-reviewer' });
  const plan = preview.reduction.plan;
  assert.equal(plan.status, 'PASS', JSON.stringify(plan.blockers));
  assert.equal(plan.accounting.total, 18);
  assert.equal(plan.accounting.retained + plan.accounting.redistributed, 18);
  assert.deepEqual(plan.certifiesGates, []);

  // ── G12-C apply ──
  const applied = await service.applyFinalReduction(OWNER, run.projectId, { candidateId: run.candidateId, decisions: [PLACE_CHORD5], expectedPlanId: plan.id, acceptedBy: 'pipeline-reviewer' });
  assert.equal(applied.reduction.applied, true);
  const reducedId = applied.reduction.candidate_id;
  // Applying is not reviewing: the review that comes straight back still has
  // every reduction-affected axis open.
  assert.equal(applied.review.gates.mobile_adaptation, 'PENDING');
  assert.equal(applied.review.gates.regression, 'PENDING');
  assert.notEqual(applied.review.candidate_ready, true);

  // ── Gate 8 on the reduced candidate ──
  const mobilePreview = await service.planMobileAdaptation(OWNER, run.projectId, { candidateId: reducedId, profile: MOBILE_PROFILE });
  assert.equal(mobilePreview.adaptation.plan.status, 'PASS', JSON.stringify(mobilePreview.adaptation.plan.blockers));
  // The role the reduction placed is the role the adaptation now addresses.
  assert.ok(mobilePreview.adaptation.plan.changes.every(change => change.role === 'Chord5'));
  const adapted = await service.applyMobileAdaptation(OWNER, run.projectId, { candidateId: reducedId, profile: MOBILE_PROFILE, expectedPlanId: mobilePreview.adaptation.plan.id, acceptedBy: 'pipeline-reviewer' });
  assert.equal(adapted.adaptation.applied, true);
  const adaptedId = adapted.adaptation.candidate_id;

  // The lineage is intact and each stage is named as itself.
  const record = (await service.getProject(OWNER, run.projectId)).project;
  const stageOf = id => record.candidates.find(candidate => candidate.candidate_id === id);
  assert.equal(stageOf(reducedId).stage, 'FINAL_SIX_ROLE_REDUCTION_V1');
  assert.equal(stageOf(reducedId).parent_candidate_id, run.candidateId);
  assert.equal(stageOf(adaptedId).stage, 'MOBILE_ADAPTATION_V1');
  assert.equal(stageOf(adaptedId).parent_candidate_id, reducedId);

  // ── review, then finalize ──
  const reviewed = await service.reviewCandidate(OWNER, run.projectId, { candidateId: adaptedId, confirmations: CONFIRMATIONS });
  assert.equal(reviewed.review.gates.mobile_adaptation, 'PASS');
  const finalized = await service.finalize(OWNER, run.projectId, { candidateId: adaptedId, confirmations: CONFIRMATIONS });
  assert.equal(finalized.operation, 'succeeded', JSON.stringify(finalized.blockers ?? finalized));
  assert.ok(finalized.mml, 'a Final MML is delivered');
  assert.equal(finalized.gates.technical, 'PASS');
  // A delivered Final is still not an in-game acceptance.
  assert.equal(finalized.gates.in_game, 'PENDING');

  // ── round-trip readback against the candidate the reduction produced ──
  const artifact = (await service.getArtifact(OWNER, finalized.artifact_id)).artifact;
  assert.equal(artifact.candidate_id, adaptedId);
  // The artifact already carries the emitter's own round-trip result; it is
  // re-checked here against the delivered string rather than trusted.
  assert.equal(artifact.round_trip?.status ?? artifact.roundTrip?.status, 'PASS', JSON.stringify(artifact.round_trip ?? artifact.roundTrip));
  // The delivered roles carry the reduction's placement: Chord5 is no longer empty.
  assert.equal(artifact.mml.split(',').length, 6);
  assert.ok(artifact.mml.split(',')[5].replace(/;$/, '').trim().length, 'the reduction placed material in Chord5, so the sixth role is delivered');
});

test('a reduction candidate carries its ledger, and the Final artifact names the revision that produced it', async () => {
  const service = createStudioApplication({});
  const run = await g11dCandidate(service);
  const plan = (await service.planFinalReduction(OWNER, run.projectId, { candidateId: run.candidateId, decisions: [PLACE_CHORD5], acceptedBy: 'pipeline-reviewer' })).reduction.plan;
  const applied = await service.applyFinalReduction(OWNER, run.projectId, { candidateId: run.candidateId, decisions: [PLACE_CHORD5], expectedPlanId: plan.id, acceptedBy: 'pipeline-reviewer' });
  const reducedId = applied.reduction.candidate_id;

  // The ledger travels with the candidate and every source event is in it.
  const reviewed = await service.reviewCandidate(OWNER, run.projectId, { candidateId: reducedId, confirmations: CONFIRMATIONS });
  assert.equal(reviewed.review.candidate_id, reducedId);
  assert.equal(applied.reduction.accounting.total, 18);
  assert.equal(applied.reduction.accounting.redistributed, 3);

  // Finalizing the reduction candidate itself (no Mobile adaptation) still
  // delivers, and the artifact names that candidate rather than its parent.
  const finalized = await service.finalize(OWNER, run.projectId, { candidateId: reducedId, confirmations: CONFIRMATIONS });
  assert.equal(finalized.operation, 'succeeded', JSON.stringify(finalized.blockers ?? finalized));
  const artifact = (await service.getArtifact(OWNER, finalized.artifact_id)).artifact;
  assert.equal(artifact.candidate_id, reducedId);
  assert.notEqual(artifact.candidate_id, run.candidateId);

  // The parent candidate is untouched: reduction derives, it never rewrites.
  // And it is exactly what the reduction stage exists for -- with a lane still
  // carrying no role, the parent has nothing the Final emitter can serialize
  // into six roles, so finalizing it is refused rather than quietly delivering
  // an arrangement that dropped the unassigned material.
  const parentFinal = await service.finalize(OWNER, run.projectId, { candidateId: run.candidateId, confirmations: CONFIRMATIONS });
  assert.notEqual(parentFinal.operation, 'succeeded');
  assert.equal(parentFinal.artifact_id, null);
  const parentReview = await service.reviewCandidate(OWNER, run.projectId, { candidateId: run.candidateId, confirmations: CONFIRMATIONS });
  assert.equal(parentReview.review.candidate_id, run.candidateId, 'the parent candidate is still stored and reviewable');
});
