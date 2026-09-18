import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeMobileProfile, planMobileAdaptation, applyMobileAdaptation, MOBILE_ADAPTATION_SCHEMA } from '../backend/adaptation/index.mjs';
import { applicationIntegrity } from '../backend/arrangement/decision-review.mjs';
import { createCanonicalProject, createCanonicalNoteEvent, createCanonicalRestEvent } from '../backend/canonical/index.mjs';
import { createStudioApplication, OPERATION_STATUS } from '../backend/application/index.mjs';
import { sixRoleBaseline, applyKeepOnlyCandidate } from './fixtures/application-fixtures.mjs';
import { emitFinalMml } from '../backend/final/index.mjs';
import { newWorkspace, analyzeWorkspace, previewMobileAdaptation, applyWorkspaceMobileAdaptation, clearMobileAdaptation, importWorkspace, invalidate } from '../web/model.mjs';

const profile = (roles = { Melody: { pitchRange: [48, 64], defaultVolume: 10 } }) => ({ schema: MOBILE_ADAPTATION_SCHEMA, id: 'fixture-target', reason: 'Synthetic target register and measured volume fixture; not an instrument recommendation.', evidence: ['fixture:target-client/register-and-volume'], roles });
const planFor = (baseline, p = profile(), candidate = baseline) => planMobileAdaptation({ baseline, candidate, profile: p });
const apply = (baseline, p = profile(), candidate = baseline, parent = null) => {
  const plan = planFor(baseline, p, candidate);
  return applyMobileAdaptation({ baseline, candidate, parent, profile: p, expectedPlanId: plan.id, acceptedBy: 'test-reviewer' });
};
// Isolate Lead so octave adaptation introduces no same-pitch collision with
// accompaniment. Sequential repeated attacks and a real breath must survive.
function baseline() {
  const source = sixRoleBaseline();
  const lead = source.events.filter(event => event.role === 'Melody').map((event, index) => createCanonicalNoteEvent({ ...event, pitch: [72, 74, 76][index], volume: [8, 10, 9][index], start: [0, 1, 3][index], end: [1, 2, 4][index] }));
  return createCanonicalProject({ ...source, events: [...lead, createCanonicalRestEvent({ id: 'breath', role: 'Melody', start: 2, end: 3, sourceIds: lead[0].sourceIds })] });
}

test('minimal uniform octave shift preserves intervals, breath, attack identity and dynamics', () => {
  const original = baseline(), snapshot = structuredClone(original);
  const p = profile({ Melody: { pitchRange: [48, 64], volumeDelta: 2 } });
  const result = apply(original, p);
  assert.equal(result.didApply, true);
  assert.deepEqual(result.candidate.events.filter(e => e.kind === 'note').map(e => [e.pitch, e.volume]), [[60, 10], [62, 12], [64, 11]]);
  assert.deepEqual(result.candidate.events.map(e => [e.id, e.role, e.start, e.end, e.sourceIds, e.sourceEventIds]), original.events.map(e => [e.id, e.role, e.start, e.end, e.sourceIds, e.sourceEventIds]));
  assert.deepEqual(result.candidate.events.at(-1), original.events.at(-1));
  assert.deepEqual(original, snapshot);
  assert.equal(applicationIntegrity(result, original).ok, true);
  assert.deepEqual(result.certifiesGates, []);
  assert.equal(result.candidate.metadata.sourceComplete, undefined);
  assert.equal(result.trace.length, 3);
  assert.equal(result.revision.stage, 'MOBILE_ADAPTATION_V1');
  const emitted = emitFinalMml(result.candidate);
  assert.equal(emitted.status, 'PASS', JSON.stringify(emitted.diagnostics));
});

test('no-op does not mint a revision, repeated application to the same input is deterministic', () => {
  const original = baseline();
  const noop = apply(original, profile({ Melody: { pitchRange: [60, 90], volumeDelta: 0 } }));
  assert.equal(noop.unchanged, true);
  assert.equal(noop.candidate, null);
  const one = apply(original), two = apply(structuredClone(original));
  assert.deepEqual(one, two);
  const again = apply(original, profile(), one.candidate, one);
  assert.equal(again.unchanged, true);
});

test('pitch-class folding, clipping and undecided-volume guesses fail atomically', () => {
  const source = baseline();
  const cases = [
    [profile({ Melody: { pitchRange: [60, 62], volumeDelta: 1 } }), 'REGISTER_REQUIRES_PHRASE_REVIEW'],
    [profile({ Melody: { volumeDelta: 10 } }), 'VOLUME_WOULD_CLIP'],
    [profile({ Melody: { volumeDelta: -10 } }), 'VOLUME_WOULD_CLIP'],
  ];
  for (const [p, code] of cases) {
    const result = apply(source, p);
    assert.equal(result.candidate, null);
    assert.ok(result.blockers.some(item => item.code === code));
  }
  const undecided = sixRoleBaseline();
  assert.ok(planFor(undecided, profile({ Melody: { volumeDelta: 1 } })).blockers.some(item => item.code === 'VOLUME_REFERENCE_REQUIRED'));
  const mapped = apply(undecided, profile({ Melody: { defaultVolume: 8, volumeDelta: 2 } }));
  assert.equal(mapped.didApply, true);
  assert.ok(mapped.candidate.events.filter(e => e.role === 'Melody').every(e => e.volume === 10));
  assert.ok(mapped.candidate.events.filter(e => e.role !== 'Melody').every(e => e.volume === null));
});

test('new sustained same-source collisions block, unchanged old risks remain visible', () => {
  const original = sixRoleBaseline();
  const plan = planFor(original);
  assert.ok(plan.blockers.some(item => item.code === 'NEW_COLLISION_REQUIRES_REVIEW'));
  assert.ok(plan.collisions.introduced.some(item => item.kind === 'same-pitch-overlap'));
  assert.equal(apply(original).candidate, null);
  const duplicate = createCanonicalProject({ ...original, events: original.events.map(e => e.role === 'Chord1' ? createCanonicalNoteEvent({ ...e, pitch: 72 }) : e) });
  const volumeOnly = planFor(duplicate, profile({ Melody: { defaultVolume: 10 } }));
  assert.equal(volumeOnly.status, 'PASS');
  assert.ok(volumeOnly.warnings.some(w => w.code === 'EXISTING_COLLISIONS_REQUIRE_REVIEW'));
});

test('candidate and profile edits invalidate the preview; stale apply changes nothing', () => {
  const original = baseline(), plan = planFor(original);
  const result = applyMobileAdaptation({ baseline: original, profile: profile({ Melody: { pitchRange: [36, 52] } }), expectedPlanId: plan.id, acceptedBy: 'test' });
  assert.equal(result.candidate, null);
  assert.equal(result.blockers[0].code, 'STALE_MOBILE_ADAPTATION_PLAN');
  assert.throws(() => applyMobileAdaptation({ baseline: original, profile: profile(), acceptedBy: 'test' }), /expectedPlanId/);
  assert.throws(() => applyMobileAdaptation({ baseline: original, profile: profile(), expectedPlanId: plan.id }), /acceptedBy/);
});

test('event ordering does not change a content-bound Mobile plan', () => {
  const original = sixRoleBaseline(), reversed = structuredClone(original);
  reversed.events.reverse();
  assert.deepEqual(planFor(original), planFor(reversed));
});

test('pathological collision density is explicitly bounded rather than reported safe', () => {
  const source = baseline(), template = source.events[0];
  const dense = createCanonicalProject({ ...source, events: Array.from({ length: 318 }, (_, i) => createCanonicalNoteEvent({ ...template, id: `dense-${i}`, start: 0, end: 4 })) });
  const plan = planFor(dense, profile({ Melody: { volumeDelta: 1 } }));
  assert.equal(plan.status, 'PENDING');
  assert.equal(plan.collisions.scanLimited, true);
  assert.ok(plan.blockers.some(b => b.code === 'COLLISION_SCAN_LIMIT'));
  assert.equal(apply(dense, profile({ Melody: { volumeDelta: 1 } })).candidate, null);
});

test('profile is strict, evidence-backed, bounded and never accepts instrument claims as a rule', () => {
  for (const p of [ { ...profile(), evidence: [] }, { ...profile(), instrument: 'piano' }, profile({ Vocal: { volumeDelta: 1 } }), profile({ Melody: {} }), profile({ Melody: { pitchRange: [0, 108] } }), profile({ Melody: { volumeDelta: 0.5 } }), profile({ Melody: { defaultVolume: 16 } }), profile({ Melody: { pitchRange: [70, 60] } }) ]) assert.throws(() => normalizeMobileProfile(p));
});

test('unassigned roles, GM percussion and untraceable events cannot be adapted', () => {
  const original = baseline();
  for (const [edit, code] of [[{ role: null }, 'ROLE_ASSIGNMENT_REQUIRED'], [{ metadata: { channel: 9 } }, 'DRUM_FACE_MAPPING_REQUIRED'], [{ sourceEventIds: ['forged-source-event'] }, 'SOURCE_EVENT_NOT_TRACEABLE']]) {
    const candidate = createCanonicalProject({ ...original, events: original.events.map((e, i) => i === 0 ? createCanonicalNoteEvent({ ...e, ...edit }) : e) });
    assert.ok(planFor(original, profile(), candidate).blockers.some(item => item.code === code));
  }
});

test('empty roles stay empty and target boundaries 0 and 107 are accepted', () => {
  const original = baseline();
  const p = profile({ Melody: { pitchRange: [0, 107] }, Chord5: { defaultVolume: 8 } });
  const plan = planFor(original, p);
  assert.equal(plan.status, 'PASS');
  assert.equal(plan.changes.length, 0);
  assert.ok(plan.warnings.some(w => w.code === 'EMPTY_ROLE_UNCHANGED'));
});

test('a previously promoted Lead cannot acquire an unreviewable pitch/volume change', () => {
  const original = baseline();
  const source = createCanonicalProject({ ...original, events: original.events.map(e => e.kind === 'note' ? createCanonicalNoteEvent({ ...e, role: 'Chord1' }) : e) });
  const plan = planFor(source, profile(), original);
  assert.ok(plan.blockers.some(b => b.code === 'LEAD_ROLE_ADAPTATION_REVIEW_UNSUPPORTED'));
  assert.equal(apply(source, profile(), original).candidate, null);
});

test('a later edited adaptation target cannot silently reuse the same relative-volume profile', () => {
  const original = baseline(), result = apply(original);
  const edited = structuredClone(result.candidate);
  edited.events[0].volume = 6;
  assert.ok(planFor(original, profile(), edited).blockers.some(b => b.code === 'MOBILE_PROFILE_CONTEXT_CHANGED'));
});

test('derived revision reopens arbitration and strips inherited gate/audio claims', () => {
  const original = baseline();
  const candidate = createCanonicalProject({ ...original, decisions: [{ id: 'keep', eventIds: ['melody-1'], action: 'keep', status: 'accepted', reason: 'old review', evidence: ['old'] }], metadata: { sourceComplete: true, audioAlignmentEvidence: { status: 'PASS' } } });
  const result = apply(original, profile(), candidate);
  assert.equal(result.candidate.decisions[0].status, 'pending');
  assert.equal(result.candidate.metadata.audioAlignmentEvidence, undefined);
  const tampered = structuredClone(result);
  tampered.candidate.events[0].pitch++;
  assert.equal(applicationIntegrity(tampered, original).ok, false);
  assert.throws(() => apply(original, profile(), tampered.candidate, tampered), /integrity/);
});

test('service creates a parent-linked adaptation, re-runs review and refuses inherited Gate 8', async () => {
  const service = createStudioApplication(), owner = 'mobile-test';
  const run = await applyKeepOnlyCandidate(service, owner);
  await service.recordConfirmations(owner, run.projectId, { mobile_adaptation_reviewed: { value: true, reason: 'Old review', evidence: ['old-client-test'], candidate_id: run.candidateId }, regression_reviewed: { value: true, reason: 'Old regression', evidence: ['old-test'], candidate_id: run.candidateId } });
  const p = profile({ Melody: { defaultVolume: 10 } });
  const preview = await service.planMobileAdaptation(owner, run.projectId, { candidateId: run.candidateId, profile: p, apply: true });
  assert.equal((await service.getProject(owner, run.projectId)).project.candidates.length, 1, 'preview is read-only even with injected apply:true');
  const input = { candidateId: run.candidateId, profile: p, expectedPlanId: preview.adaptation.plan.id, acceptedBy: 'reviewer' };
  const result = await service.applyMobileAdaptation(owner, run.projectId, input);
  assert.equal(result.adaptation.applied, true);
  assert.equal(result.adaptation.parent_candidate_id, run.candidateId);
  assert.equal(result.review.integrity.ok, true);
  assert.equal(result.review.gates.mobile_adaptation, 'PENDING');
  assert.equal(result.review.gates.regression, 'PENDING');
  assert.notEqual(result.review.gates.in_game, 'PASS');
  const again = await service.applyMobileAdaptation(owner, run.projectId, input);
  assert.equal(again.adaptation.candidate_id, result.adaptation.candidate_id);
  assert.equal((await service.getProject(owner, run.projectId)).project.candidates.length, 2);
  const stale = await service.applyMobileAdaptation(owner, run.projectId, { ...input, profile: profile({ Melody: { defaultVolume: 11 } }) });
  assert.equal(stale.adaptation.applied, false);
  assert.equal((await service.getProject(owner, run.projectId)).project.candidates.length, 2);
  await assert.rejects(service.planMobileAdaptation('other-owner', run.projectId, input));
  const final = await service.finalize(owner, run.projectId, { candidateId: result.adaptation.candidate_id });
  assert.equal(final.operation, OPERATION_STATUS.BLOCKED);
  for (const change of result.review.core3.unapproved) await service.approveCore3SourceChange(owner, run.projectId, { candidateId: result.adaptation.candidate_id, approval: { event_id: change.eventId, type: change.type, reason: 'Reviewed the synthetic volume mapping', evidence: ['fixture:target-client'] } });
  const confirmations = Object.fromEntries(['source_complete', 'version_drift_reviewed', 'mobile_adaptation_reviewed', 'regression_reviewed', 'core3_completeness_reviewed'].map(name => [name, { value: true, reason: 'Reviewed adapted fixture against its baseline', evidence: ['fixture:adaptation-review'] }]));
  confirmations.player_readback = { value: 'N/A', reason: 'No verification player was used' };
  confirmations.original_audio_required = { value: false, reason: 'Synthetic cue without an original recording' };
  const ready = await service.finalize(owner, run.projectId, { candidateId: result.adaptation.candidate_id, confirmations });
  assert.equal(ready.operation, OPERATION_STATUS.SUCCEEDED, JSON.stringify(ready));
  assert.equal(ready.gates.mobile_adaptation, 'PASS');
});

function workspace() {
  const project = baseline(), asset = { name: 'mobile.json', content: JSON.stringify(project), project, format: 'Canonical IR', complete: true, warnings: [], errors: [], unsupported: [] };
  return { ...newWorkspace(), assets: { candidate: structuredClone(asset), baseline: structuredClone(asset) }, reviews: { adaptation: { revision: 0, note: 'old', evidence: 'old' } }, acceptance: { outcome: 'accepted' }, deliveryMml: 'old', finalDelivery: { status: 'PASS' } };
}

test('Web replays adaptation from preserved sources, invalidates reviews and supports rollback', () => {
  const w = workspace(), p = profile(), plan = previewMobileAdaptation(w, p);
  const result = applyWorkspaceMobileAdaptation(w, { profile: p, expectedPlanId: plan.id, acceptedBy: 'test' });
  assert.equal(result.applied, true);
  const next = result.workspace;
  assert.deepEqual(next.assets, w.assets);
  assert.deepEqual(next.reviews, {});
  assert.equal(next.acceptance, null);
  assert.equal(next.finalDelivery, undefined);
  assert.equal(next.deliveryMml, undefined);
  const report = analyzeWorkspace(next);
  assert.equal(report.mobileAdaptation.plan.changes.length, 3);
  assert.equal(report.gates.adaptation.status, 'PENDING');
  assert.equal(report.rawMml, null);
  assert.deepEqual(analyzeWorkspace(JSON.parse(JSON.stringify(next))), report);
  const rollback = clearMobileAdaptation(next);
  assert.equal(rollback.mobileAdaptation, undefined);
  assert.deepEqual(rollback.assets, w.assets);
  assert.equal(analyzeWorkspace(rollback).mobileAdaptation, null);
  assert.equal(invalidate(next).mobileAdaptation, undefined);
});

test('Web fails closed on a stale restored profile and treats backup adaptation as history', () => {
  const w = workspace(), p = profile(), plan = previewMobileAdaptation(w, p);
  const next = applyWorkspaceMobileAdaptation(w, { profile: p, expectedPlanId: plan.id, acceptedBy: 'test' }).workspace;
  const imported = importWorkspace(JSON.stringify(next));
  assert.equal(imported.mobileAdaptation, undefined);
  assert.ok(imported.importedHistory.mobileAdaptation);
  next.mobileAdaptation.profile.roles.Melody.pitchRange = [36, 52];
  const report = analyzeWorkspace(next);
  assert.equal(report.gates.mobileAdaptationIntegrity.status, 'PENDING');
  assert.ok(report.blockers.includes('mobileAdaptationIntegrity'));
});
