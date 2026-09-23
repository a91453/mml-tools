// Release representation through the Studio Application Service.
//
// Synthetic fixture (fixtures/release-fixtures.mjs) with the real 《怪獸之歌》
// one-tick shape; it proves nothing about that song. What it pins is the path:
// evidence decides, the source release survives, and nothing else about the
// music moves.
import test from 'node:test';
import assert from 'node:assert/strict';

import { createStudioApplication } from '../backend/application/index.mjs';
import { f } from '../backend/mml/index.mjs';
import { createCanonicalProject, createSource } from '../backend/canonical/index.mjs';
import { OWNER, TICK, ALL_RELEASE_EVENTS as ALL, HUMAN_SUBMITTER, candidateWithAudio, audioReviewDecision, oneTickEarlyBaseline, roleDecisions } from './fixtures/release-fixtures.mjs';

test('RRA-1 the read-only plan reports every non-representable release and what still needs a profile', async () => {
  const service = createStudioApplication();
  const { projectId, candidateId } = await candidateWithAudio(service);
  const { plan } = (await service.planMobileAdaptation(OWNER, projectId, { candidateId, releaseRepresentation: { decisions: [] } })).adaptation;
  assert.equal(plan.status, 'PASS', 'executable, and changes nothing');
  assert.deepEqual(plan.changes, []);
  assert.deepEqual(plan.releaseRepresentation.changes, []);
  assert.equal(plan.releaseTiming.targetCount, 8);
  assert.deepEqual(plan.releaseTiming.targets.map(target => target.eventId).sort(), [...ALL].sort());
  assert.ok(plan.releaseTiming.targets.every(target => target.recommended === 'EXTEND_TO_NEXT_GRID'));
  assert.equal(plan.releaseTiming.targets.find(target => target.eventId === 'lead-2').analysis.nextIsSamePitchRepeatedAttack, true);
  assert.equal(plan.profileRequirement.status, 'NOT_SUPPLIED');
  const review = (await service.reviewCandidate(OWNER, projectId, { candidateId })).review;
  assert.equal(review.readiness.gates.microTiming.status, 'PENDING');
  assert.ok(review.readiness.gates.microTiming.blockers.includes('MICRO_TIMING_RELEASE_NOT_FINAL_REPRESENTABLE'), 'the release before a real rest and the role ends are no longer invisible');
  // The open releases are blocked on named evidence the project could supply,
  // never on who would have to supply it.
  assert.ok(review.readiness.gates.microTiming.blockers.includes('MICRO_TIMING_RELEASE_EVIDENCE_REQUIRED'));
  assert.deepEqual(review.readiness.gates.microTiming.releaseEvidenceRequirement.anyOf.map(item => [item.code, item.availableRefs.length]), [['ORIGINAL_AUDIO_ARTICULATION_REVIEW_REQUIRED', 1], ['INDEPENDENT_SYMBOLIC_SOURCE_REQUIRED', 0]]);
  assert.doesNotMatch(JSON.stringify(review.readiness.gates.microTiming), /HUMAN|human|NOT_LISTENING/);
});

test('RRA-2 a metric-only or locator-only decision changes nothing and says why, whoever submits it', async () => {
  const service = createStudioApplication();
  const { projectId, candidateId, audioAssetId } = await candidateWithAudio(service);
  const weak = [];
  for (const submitter of [HUMAN_SUBMITTER, undefined]) {
    for (const basis of ['machine-metric', 'alignment-locator']) weak.push(audioReviewDecision(audioAssetId, ALL, { submitter, basis }));
  }
  for (const decision of weak) {
    const releaseRepresentation = { decisions: [decision] };
    const { plan } = (await service.planMobileAdaptation(OWNER, projectId, { candidateId, releaseRepresentation })).adaptation;
    assert.equal(plan.status, 'PENDING');
    assert.deepEqual(plan.blockers.map(item => item.code), ['RELEASE_DECISION_EVIDENCE_NOT_ADMISSIBLE']);
    assert.deepEqual(plan.blockers[0].reasons, ['NO_ADMISSIBLE_EVIDENCE']);
    assert.deepEqual([...plan.releaseRepresentation.pending[0].items[0].reasons], ['EVIDENCE_BASIS_IS_NOT_A_DIRECT_SOURCE_REVIEW']);
    // What would settle it is named from the project's sources, not from who may submit it.
    assert.deepEqual(plan.releaseEvidenceRequirement.anyOf.map(item => item.code), ['ORIGINAL_AUDIO_ARTICULATION_REVIEW_REQUIRED', 'INDEPENDENT_SYMBOLIC_SOURCE_REQUIRED']);
    const applied = await service.applyMobileAdaptation(OWNER, projectId, { candidateId, releaseRepresentation, expectedPlanId: plan.id, acceptedBy: 'user:listener' });
    assert.equal(applied.operation, 'blocked');
    assert.equal(applied.adaptation.applied, false);
  }
  const record = await service.getProject(OWNER, projectId);
  assert.equal(record.project.candidates.length, 1, 'no revision was minted');
});

test('RRA-3 a source-backed decision submitted by a conversational AI represents the releases, keeps the source releases and every attack, and clears micro-timing', async () => {
  const service = createStudioApplication();
  const { projectId, candidateId, audioAssetId } = await candidateWithAudio(service);
  const before = (await service.reviewCandidate(OWNER, projectId, { candidateId })).review;
  assert.equal(before.readiness.gates.leadPromotion.status, 'PASS', 'the promotions carry complete evidence');

  const releaseRepresentation = { decisions: [audioReviewDecision(audioAssetId, ALL)] };
  const { plan } = (await service.planMobileAdaptation(OWNER, projectId, { candidateId, releaseRepresentation })).adaptation;
  assert.equal(plan.status, 'PASS');
  assert.equal(plan.releaseRepresentation.changes.length, 8);
  assert.ok(plan.releaseRepresentation.changes.every(change => change.delta === '1/480' && change.representation === 'EXTEND_TO_NEXT_GRID'));
  assert.equal(plan.releaseRepresentation.unresolvedTargetCount, 0);

  const applied = await service.applyMobileAdaptation(OWNER, projectId, { candidateId, releaseRepresentation, expectedPlanId: plan.id, acceptedBy: 'agent:assistant' });
  assert.equal(applied.operation, 'succeeded');
  assert.equal(applied.adaptation.applied, true);
  const adaptedId = applied.adaptation.candidate_id;
  assert.notEqual(adaptedId, candidateId);

  // Layer A survives in the baseline diff; Layer C is the candidate. Each change
  // is one modified event, never a removal plus an unrelated addition.
  const diff = applied.adaptation.diff_from_baseline;
  assert.equal(diff.summary.noteAdded, 0);
  assert.equal(diff.summary.noteRemoved, 0);
  const ends = Object.fromEntries(diff.notes.modified.map(pair => [pair.before.id, [pair.before.end, pair.after.end, pair.after.id]]));
  for (const id of ALL) {
    assert.equal(ends[id][2], id, 'same event identity');
    assert.equal(f(ends[id][0]).add(TICK).cmp(ends[id][1]), 0, `${id} moved by exactly one tick`);
  }
  const parentDiff = applied.adaptation.diff_from_parent;
  assert.equal(parentDiff.summary.noteModified, 8);
  assert.ok(parentDiff.notes.modified.every(pair => Object.keys(pair.changes).join() === 'end'), 'only releases changed');

  const review = (await service.reviewCandidate(OWNER, projectId, { candidateId: adaptedId })).review;
  assert.equal(review.readiness.gates.microTiming.status, 'PASS');
  assert.equal(review.readiness.gates.microTiming.releaseRepresentationRecords.recordCount, 8);
  // The Lead evidence recorded with the promotions still describes the
  // represented events: neither EVENT_CHANGED nor CONTEXT_CHANGED.
  assert.equal(review.readiness.gates.leadPromotion.status, 'PASS');
  assert.ok(review.lead_promotion.every(report => report.status === 'PASS'));
  // Gate 8 is not certified by any of this.
  assert.equal(review.readiness.gates.mobileAdaptation.status, 'PENDING');
});

test('RRA-4 a stale plan id is refused and a decision id cannot be applied twice', async () => {
  const service = createStudioApplication();
  const { projectId, candidateId, audioAssetId } = await candidateWithAudio(service);
  const first = { decisions: [audioReviewDecision(audioAssetId, ['lead-1', 'lead-2'])] };
  const { plan } = (await service.planMobileAdaptation(OWNER, projectId, { candidateId, releaseRepresentation: first })).adaptation;
  const stale = await service.applyMobileAdaptation(OWNER, projectId, { candidateId, releaseRepresentation: { decisions: [audioReviewDecision(audioAssetId, ['lead-1'])] }, expectedPlanId: plan.id, acceptedBy: 'user:listener' });
  assert.equal(stale.adaptation.applied, false);
  assert.deepEqual(stale.adaptation.blockers.map(item => item.code), ['STALE_MOBILE_ADAPTATION_PLAN']);
  const applied = await service.applyMobileAdaptation(OWNER, projectId, { candidateId, releaseRepresentation: first, expectedPlanId: plan.id, acceptedBy: 'user:listener' });
  const adaptedId = applied.adaptation.candidate_id;
  // The rest of the song, under a new decision, on top of the first revision.
  const rest = { decisions: [audioReviewDecision(audioAssetId, ALL.filter(id => !['lead-1', 'lead-2'].includes(id)), { id: 'rr:rest' })] };
  const second = (await service.planMobileAdaptation(OWNER, projectId, { candidateId: adaptedId, releaseRepresentation: rest })).adaptation.plan;
  assert.equal(second.releaseTiming.representedCount, 2);
  assert.equal(second.releaseRepresentation.changes.length, 6);
  const secondApplied = await service.applyMobileAdaptation(OWNER, projectId, { candidateId: adaptedId, releaseRepresentation: rest, expectedPlanId: second.id, acceptedBy: 'user:listener' });
  const final = (await service.reviewCandidate(OWNER, projectId, { candidateId: secondApplied.adaptation.candidate_id })).review;
  assert.equal(final.readiness.gates.microTiming.status, 'PASS');
  assert.equal(final.readiness.gates.microTiming.releaseRepresentationRecords.recordCount, 8, 'the first revision\'s records still re-verify');
  // Re-using the first decision id on the final candidate is refused.
  const reuse = (await service.planMobileAdaptation(OWNER, projectId, { candidateId: secondApplied.adaptation.candidate_id, releaseRepresentation: first })).adaptation.plan;
  assert.deepEqual([...new Set(reuse.blockers.map(item => item.code))].sort(), ['RELEASE_DECISION_ID_ALREADY_APPLIED', 'RELEASE_EVENT_IS_NOT_A_REPRESENTATION_TARGET']);
});

test('RRA-5 review re-grades a recorded representation against the project\'s current evidence, not the stored citation', async () => {
  const service = createStudioApplication();
  const { projectId, candidateId, audioAssetId } = await candidateWithAudio(service);
  const releaseRepresentation = { decisions: [audioReviewDecision(audioAssetId, ALL)] };
  const { plan } = (await service.planMobileAdaptation(OWNER, projectId, { candidateId, releaseRepresentation })).adaptation;
  const applied = await service.applyMobileAdaptation(OWNER, projectId, { candidateId, releaseRepresentation, expectedPlanId: plan.id, acceptedBy: 'user:listener' });
  const adaptedId = applied.adaptation.candidate_id;
  const before = (await service.reviewCandidate(OWNER, projectId, { candidateId: adaptedId })).review.readiness.gates.microTiming;
  assert.equal(before.status, 'PASS');
  assert.equal(before.releaseRepresentationRecords.registryChecked, true);

  // The cited recording turns out to share its bytes with a supporting file:
  // it is no longer independent, and the stored record still says it was.
  await service.uploadAsset(OWNER, projectId, { kind: 'third_party_midi', filename: 'relabel.mid', mediaType: 'audio/midi', bytes: new TextEncoder().encode('synthetic audio bytes') });
  const after = (await service.reviewCandidate(OWNER, projectId, { candidateId: adaptedId })).review.readiness.gates.microTiming;
  assert.equal(after.status, 'FAIL');
  assert.ok(after.blockers.includes('MICRO_TIMING_RELEASE_REPRESENTATION_RECORD_INVALID'));
  assert.equal(after.releaseRepresentationRecords.violations.length, 8);
  assert.ok(after.releaseRepresentationRecords.violations.every(item => item.code === 'RELEASE_RECORD_DECISION_EVIDENCE_NOT_ADMISSIBLE'));
  const finalized = await service.finalize(OWNER, projectId, { candidateId: adaptedId });
  assert.equal(finalized.artifact_id, null, 'nothing is delivered on a citation review refuses');
  assert.ok(finalized.blockers.includes('microTiming'));
  assert.equal(finalized.song_state, 'CANDIDATE');
});

test('RRA-6 a recording or score an uploaded IR only declares, with no bytes in the project, is never evidence', async () => {
  const service = createStudioApplication();
  const baseline = oneTickEarlyBaseline();
  const declared = createCanonicalProject({ ...baseline, sources: [...baseline.sources,
    createSource({ id: 'claimed:original-audio', label: 'declared recording', kind: 'original-audio', authority: 'primary-audio', sha256: null }),
    createSource({ id: 'claimed:official-score', label: 'declared score', kind: 'official-midi', authority: 'primary-symbolic', sha256: 'f'.repeat(64) }),
  ] });
  const { project } = await service.createProject(OWNER, { title: 'declared sources' });
  await service.uploadAsset(OWNER, project.project_id, { kind: 'canonical_project', filename: 'b.json', mediaType: 'application/json', bytes: new TextEncoder().encode(JSON.stringify(declared)) });
  await service.analyzeSources(OWNER, project.project_id);
  const candidateId = (await service.applyDecisions(OWNER, project.project_id, { decisions: roleDecisions() })).decisions.candidate_id;
  for (const submitter of [HUMAN_SUBMITTER, undefined]) {
    for (const ref of ['claimed:original-audio', 'claimed:official-score']) {
      const decision = audioReviewDecision(ref, ALL, { submitter });
      if (ref.includes('score')) decision.evidence = decision.evidence.map(item => ({ ...item, class: 'primary-symbolic' }));
      const { plan } = (await service.planMobileAdaptation(OWNER, project.project_id, { candidateId, releaseRepresentation: { decisions: [decision] } })).adaptation;
      assert.equal(plan.status, 'PENDING', ref);
      assert.equal(plan.releaseRepresentation.changes.length, 0);
      assert.deepEqual([...plan.releaseRepresentation.pending[0].items[0].reasons], ['EVIDENCE_REFERENCE_NOT_BACKED_BY_PROJECT_BYTES']);
    }
  }
  // Nor are they offered as a way to settle the releases.
  const review = (await service.reviewCandidate(OWNER, project.project_id, { candidateId })).review;
  assert.deepEqual(review.readiness.gates.microTiming.releaseEvidenceRequirement.anyOf.map(item => [item.code, item.availableRefs]), [['ORIGINAL_AUDIO_SOURCE_REQUIRED', []], ['INDEPENDENT_SYMBOLIC_SOURCE_REQUIRED', []]]);
});
