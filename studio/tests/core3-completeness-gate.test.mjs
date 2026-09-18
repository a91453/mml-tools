// Core3: the source-continuity audit and Gate 4 musical completeness are two
// gates, and a candidate-bound approval path for a reviewed source change.
//
// `evaluateCore3Continuity()` answers "what did this candidate change away from
// the baseline, and was it approved". That is a real gate and it catches
// cleanup damage, but it is not ACCEPTANCE_CRITERIA Gate 4, which asks whether
// Melody + Chord1 + Chord2 stand up as a one-player arrangement at all. A
// candidate identical to its baseline passes the first trivially and can fail
// the second completely.
//
// Two things must therefore be true at once, and they pull in opposite
// directions, which is why both are pinned here:
//
//   * "unchanged from baseline" must not read as Gate 4 PASS;
//   * "Chord1 and Chord2 must contain notes" must never be the rule either --
//     true rests, sparse sources and source-supported reduced textures stay
//     legal, and the only automatic FAIL is the one the silence-gap test
//     against the source can prove.
//
// The second half covers the approval path: a legitimate, evidence-backed Core3
// source change was unclearable because Finalize called the continuity engine
// with `approvedChanges: []`.

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  createSource,
  createCanonicalNoteEvent,
  createCanonicalTempoEvent,
  createCanonicalMeterEvent,
  createCanonicalProject,
} from '../backend/canonical/index.mjs';
import { evaluateCore3Continuity } from '../backend/arbitration/core3.mjs';
import { evaluateCore3Completeness, CORE3_COMPLETENESS_BLOCKERS } from '../backend/arbitration/core3-completeness.mjs';
import { evaluateProjectReadiness } from '../backend/final/readiness.mjs';
import { ERROR_CODES, createStudioApplication } from '../backend/application/index.mjs';
import { canonicalProjectBytes, sixRoleBaseline } from './fixtures/application-fixtures.mjs';

const OFFICIAL = createSource({ id: 'official', label: 'Official MusicXML', kind: 'official-musicxml', authority: 'primary-symbolic' });
const note = ({ id, pitch, start, end, role }) => createCanonicalNoteEvent({
  id, pitch, start: String(start), end: String(end), role, voice: role, volume: 8, sourceIds: ['official'], sourceEventIds: [`official#${id}`],
});

function project(id, events) {
  return createCanonicalProject({
    id, title: 'Core3 gate fixture', sources: [OFFICIAL], events,
    tempoEvents: [createCanonicalTempoEvent({ id: 't1', beat: '0', bpm: 120, sourceIds: ['official'] })],
    meterEvents: [createCanonicalMeterEvent({ id: 'm1', beat: '0', numerator: 4, denominator: 4, sourceIds: ['official'] })],
    decisions: [], metadata: { sourceComplete: true },
  });
}

// A source that carries only a Melody. Nothing was removed and nothing moved,
// so the continuity audit has nothing to report.
const MELODY_ONLY = [
  note({ id: 'm1', pitch: 72, start: 0, end: 1, role: 'Melody' }),
  note({ id: 'm2', pitch: 74, start: 1, end: 2, role: 'Melody' }),
  note({ id: 'm3', pitch: 76, start: 2, end: 4, role: 'Melody' }),
];

// A complete three-role arrangement.
const FULL_CORE3 = [
  ...MELODY_ONLY,
  note({ id: 'h1', pitch: 64, start: 0, end: 2, role: 'Chord1' }),
  note({ id: 'h2', pitch: 65, start: 2, end: 4, role: 'Chord1' }),
  note({ id: 'b1', pitch: 48, start: 0, end: 2, role: 'Chord2' }),
  note({ id: 'b2', pitch: 43, start: 2, end: 4, role: 'Chord2' }),
];

// ─── the two questions are not one question ─────────────────────────────────

test('an unchanged candidate passes source continuity and does not thereby pass Gate 4', () => {
  const baseline = project('fixture:baseline', MELODY_ONLY);
  const candidate = project('fixture:candidate', MELODY_ONLY);

  const continuity = evaluateCore3Continuity({ baseline, candidate, approvedChanges: [] });
  assert.equal(continuity.status, 'PASS', 'nothing was removed, modified or moved');
  assert.deepEqual([...continuity.blockers], []);

  // Gate 4 is a different question and it has not been answered.
  const completeness = evaluateCore3Completeness({ candidate });
  assert.equal(completeness.status, 'PENDING');
  assert.deepEqual([...completeness.blockers], [CORE3_COMPLETENESS_BLOCKERS.UNRESOLVED]);
  assert.ok(completeness.missingFunctions.length > 0, 'the report names which musical functions are missing');
  assert.equal(completeness.reviewable, true);
});

test('readiness blocks an unchanged-but-unresolved Core3 even with a clean continuity report', () => {
  const candidate = project('fixture:candidate', MELODY_ONLY);
  const withBaseline = createCanonicalProject({
    ...candidate,
    metadata: { ...candidate.metadata, sourceFaithfulBaseline: { snapshot: project('fixture:baseline', MELODY_ONLY) } },
  });
  const readiness = evaluateProjectReadiness({
    project: withBaseline,
    mmlValidation: { ok: true, errors: [] },
    core3Report: { status: 'PASS', blockers: [] },
    core3CompletenessReport: evaluateCore3Completeness({ candidate: withBaseline }),
    harmonyReport: { status: 'PASS', unresolvedCount: 0 },
    leadDemotionReports: [],
    leadPromotionReports: [],
    playerReadback: 'PASS',
    originalAudioRequired: false,
    mobileAdaptation: 'PASS',
    regressionReviewed: true,
  });
  assert.equal(readiness.gates.core3.status, 'PASS', 'the continuity gate is clean');
  assert.equal(readiness.gates.core3Completeness.status, 'PENDING');
  assert.ok(readiness.preGameBlocking.includes('core3Completeness'));
  assert.equal(readiness.candidateReady, false, 'a clean continuity audit cannot carry the candidate on its own');
});

test('a complete Core3 passes Gate 4 without anyone reviewing it', () => {
  const candidate = project('fixture:candidate', FULL_CORE3);
  const completeness = evaluateCore3Completeness({ candidate });
  assert.equal(completeness.status, 'PASS');
  assert.equal(completeness.evaluation, 'COMPLETE');
  assert.equal(completeness.reviewed, false, 'nothing was reviewed away; the functions are satisfied');
});

test('Gate 4 is not a track-density rule', () => {
  // A source that carries no bass material at all. An empty Chord2 here is a
  // legitimately reduced texture, not a deficiency, so it must not FAIL -- and
  // it must not silently PASS either.
  const sparse = project('fixture:candidate', [
    ...MELODY_ONLY,
    note({ id: 'h1', pitch: 64, start: 0, end: 4, role: 'Chord1' }),
  ]);
  const report = evaluateCore3Completeness({ candidate: sparse });
  assert.equal(report.status, 'PENDING', 'an absent function is unresolved, never an automatic failure');
  assert.equal(report.reviewable, true);

  // A reviewer can answer Gate 4 for it, with candidate-bound evidence.
  assert.equal(evaluateCore3Completeness({ candidate: sparse, reviewed: true }).status, 'PASS');

  // True rests do not make a complete arrangement incomplete: the same three
  // roles with a silent stretch in every one of them still reads COMPLETE.
  const withRests = project('fixture:candidate', [
    note({ id: 'm1', pitch: 72, start: 0, end: 1, role: 'Melody' }),
    note({ id: 'm3', pitch: 76, start: 3, end: 4, role: 'Melody' }),
    note({ id: 'h1', pitch: 64, start: 0, end: 1, role: 'Chord1' }),
    note({ id: 'h2', pitch: 65, start: 3, end: 4, role: 'Chord1' }),
    note({ id: 'b1', pitch: 48, start: 0, end: 1, role: 'Chord2' }),
    note({ id: 'b2', pitch: 43, start: 3, end: 4, role: 'Chord2' }),
  ]);
  assert.equal(evaluateCore3Completeness({ candidate: withRests }).status, 'PASS', 'a true source rest is not a gap');
});

test('a Core3 with no Lead at all is a deficiency no review can clear', () => {
  // MASTER_RULES 5 makes Melody the Lead and Gate 4 requires the Lead to be
  // present. "The source has no lead voice" is not the reduced-texture case a
  // reviewer resolves -- an arrangement with no Lead is not a Core3 at all, and
  // Gate 3 asks the same question independently.
  const leadless = project('fixture:candidate', [
    note({ id: 'h1', pitch: 64, start: 0, end: 2, role: 'Chord1' }),
    note({ id: 'h2', pitch: 65, start: 2, end: 4, role: 'Chord1' }),
    note({ id: 'b1', pitch: 48, start: 0, end: 2, role: 'Chord2' }),
    note({ id: 'b2', pitch: 43, start: 2, end: 4, role: 'Chord2' }),
  ]);
  const report = evaluateCore3Completeness({ candidate: leadless });
  assert.equal(report.status, 'FAIL');
  assert.deepEqual([...report.blockers], [CORE3_COMPLETENESS_BLOCKERS.INCOMPLETE]);
  assert.ok(report.absentFunctions.includes('lead-continuity'));
  assert.equal(report.reviewable, false);
  assert.equal(evaluateCore3Completeness({ candidate: leadless, reviewed: true }).status, 'FAIL',
    'a reviewer cannot supply a Lead by confirming one');
});

test('proven-essential material left in enrichment is raised for review, not auto-failed', () => {
  // Core3 sounds at 0-1 and 3-4 and is silent in between, while a Chord3 lane
  // sounds right through that gap and inside the Core3 span -- so the window is
  // not the end-time question P14 sets aside, and the silence-gap test proves
  // the lane essential.
  //
  // Gate 4 does ask whether Core3 stays intelligible without Chord3-Chord5
  // there, so this cannot silently PASS. But an enrichment line across a Core3
  // rest is ordinary music, so it cannot be an unreviewable failure either --
  // that would be the density rule again from the other direction.
  const fill = project('fixture:candidate', [
    note({ id: 'm1', pitch: 72, start: 0, end: 1, role: 'Melody' }),
    note({ id: 'h1', pitch: 64, start: 0, end: 1, role: 'Chord1' }),
    note({ id: 'b1', pitch: 48, start: 0, end: 1, role: 'Chord2' }),
    note({ id: 'e1', pitch: 55, start: 1, end: 3, role: 'Chord3' }),
    note({ id: 'm2', pitch: 74, start: 3, end: 4, role: 'Melody' }),
    note({ id: 'h2', pitch: 65, start: 3, end: 4, role: 'Chord1' }),
    note({ id: 'b2', pitch: 43, start: 3, end: 4, role: 'Chord2' }),
  ]);
  const report = evaluateCore3Completeness({ candidate: fill });
  assert.equal(report.provenEssentialMisplaced, true, 'the silence-gap test proves the Chord3 lane essential');
  assert.ok(report.essentialEventIdsOutsideCore3.includes('e1'));
  assert.equal(report.status, 'PENDING', 'raised for review rather than passed or failed');
  assert.deepEqual([...report.blockers], [CORE3_COMPLETENESS_BLOCKERS.ENRICHMENT_DEPENDENCE_UNRESOLVED]);
  assert.equal(report.reviewable, true);
  assert.equal(evaluateCore3Completeness({ candidate: fill, reviewed: true }).status, 'PASS');
});

// ─── the candidate-bound Core3 approval path ────────────────────────────────

const OWNER = 'owner:alice';

async function applicationWithBaseline() {
  const service = createStudioApplication();
  const fixture = sixRoleBaseline();
  const created = (await service.createProject(OWNER, { title: 'Core3 approval' })).project;
  await service.uploadAsset(OWNER, created.project_id, {
    kind: 'canonical_project', filename: 'baseline.json', mediaType: 'application/json', bytes: canonicalProjectBytes(fixture),
  });
  await service.analyzeSources(OWNER, created.project_id);
  return { service, fixture, projectId: created.project_id };
}

/** Move Chord1 material out of Core3 -- a real, reviewable Core3 source change. */
const moveChord1Out = fixture => ({
  id: 'move:chord1',
  type: 'MOVE_ROLE',
  target: { eventIds: fixture.events.filter(event => event.role === 'Chord1').map(event => event.id) },
  fromRole: 'Chord1',
  toRole: 'Chord4',
  reason: 'Reviewed: the official score marks this line as enrichment, not core harmony.',
  evidence: ['fixture:score bar 1-4'],
  acceptedBy: 'reviewer:test',
});

test('an unapproved Core3 source change blocks, and a reviewed candidate-bound approval clears continuity', async () => {
  const { service, fixture, projectId } = await applicationWithBaseline();
  const applied = await service.applyDecisions(OWNER, projectId, { decisions: [moveChord1Out(fixture)] });
  assert.equal(applied.decisions.applied, true);
  const candidateId = applied.decisions.candidate_id;

  const before = (await service.reviewCandidate(OWNER, projectId, { candidateId })).review;
  assert.equal(before.core3.status, 'PENDING');
  assert.ok(before.core3.blockers.includes('UNAPPROVED_CORE3_SOURCE_CHANGE'));
  assert.ok(before.core3.unapproved.length > 0);

  // Approve each reported change, with a reason and explicit evidence.
  for (const change of before.core3.unapproved) {
    await service.approveCore3SourceChange(OWNER, projectId, {
      candidateId,
      approval: {
        event_id: change.eventId,
        type: change.type,
        reason: 'Reviewed against the official score: this line is enrichment.',
        evidence: ['fixture:score bar 1-4'],
      },
    });
  }

  const after = (await service.reviewCandidate(OWNER, projectId, { candidateId })).review;
  assert.equal(after.core3.status, 'PASS', 'the reviewed change now passes continuity');
  assert.deepEqual([...after.core3.blockers], []);
  assert.equal(after.core3_approvals.length, before.core3.unapproved.length);
  assert.equal(after.blockers.includes('core3'), false);
});

test('an approval is refused for a change this candidate does not report', async () => {
  const { service, fixture, projectId } = await applicationWithBaseline();
  const applied = await service.applyDecisions(OWNER, projectId, { decisions: [moveChord1Out(fixture)] });
  const candidateId = applied.decisions.candidate_id;

  // An event with no reported change: an approval would be a standing
  // permission rather than a review of something that happened.
  await assert.rejects(
    () => service.approveCore3SourceChange(OWNER, projectId, {
      candidateId,
      approval: { event_id: 'melody-1', type: 'remove', reason: 'Reviewed.', evidence: ['fixture:score'] },
    }),
    error => error.code === ERROR_CODES.INVALID_REQUEST,
  );

  // And an approval with no evidence is refused outright.
  const real = (await service.reviewCandidate(OWNER, projectId, { candidateId })).review.core3.unapproved[0];
  await assert.rejects(
    () => service.approveCore3SourceChange(OWNER, projectId, {
      candidateId,
      approval: { event_id: real.eventId, type: real.type, reason: 'Reviewed.', evidence: [] },
    }),
    error => error.code === ERROR_CODES.INVALID_REQUEST,
  );
});

test('a Core3 approval does not travel to another candidate', async () => {
  const { service, fixture, projectId } = await applicationWithBaseline();
  const first = await service.applyDecisions(OWNER, projectId, { decisions: [moveChord1Out(fixture)] });
  const firstId = first.decisions.candidate_id;

  const unapproved = (await service.reviewCandidate(OWNER, projectId, { candidateId: firstId })).review.core3.unapproved;
  for (const change of unapproved) {
    await service.approveCore3SourceChange(OWNER, projectId, {
      candidateId: firstId,
      approval: { event_id: change.eventId, type: change.type, reason: 'Reviewed.', evidence: ['fixture:score'] },
    });
  }
  assert.equal((await service.reviewCandidate(OWNER, projectId, { candidateId: firstId })).review.core3.status, 'PASS');

  // A second revision is a different candidate. The approvals recorded against
  // the first do not carry over to it.
  const second = await service.applyDecisions(OWNER, projectId, {
    parentCandidateId: firstId,
    decisions: [{
      id: 'move:chord2',
      type: 'MOVE_ROLE',
      target: { eventIds: fixture.events.filter(event => event.role === 'Chord2').map(event => event.id) },
      fromRole: 'Chord2',
      toRole: 'Chord5',
      reason: 'Reviewed: a second, separate change.',
      evidence: ['fixture:score bar 5-8'],
      acceptedBy: 'reviewer:test',
    }],
  });
  const secondReview = (await service.reviewCandidate(OWNER, projectId, { candidateId: second.decisions.candidate_id })).review;
  assert.equal(secondReview.core3.status, 'PENDING');
  assert.deepEqual(secondReview.core3_approvals, [], 'approvals are bound to the candidate they were recorded against');
});

test('an accepted role decision and its Lead evidence are not a Core3 approval', async () => {
  const { service, fixture, projectId } = await applicationWithBaseline();
  // A Lead promotion with complete positive evidence, which also moves Core3
  // material: the promotion gate passes and the Core3 change stays unapproved.
  const applied = await service.applyDecisions(OWNER, projectId, {
    decisions: [{
      id: 'promote:chord1',
      type: 'MOVE_ROLE',
      target: { eventIds: ['chord1-1'] },
      fromRole: 'Chord1',
      toRole: 'Melody',
      reason: 'Reviewed: this cited voice carries the foreground lead here.',
      evidence: ['fixture:score top line', 'fixture:audio foreground'],
      leadEvidence: {
        sourceIdentity: { sourceId: 'fixture:official-midi', sourceEventId: 'fixture:official-midi#chord1-1' },
        sectionRole: 'instrumental',
        scoreEvidence: { availability: 'available', classification: 'lead', citation: 'fixture:score top staff' },
        audioEvidence: { availability: 'available', classification: 'foreground', citation: 'fixture:audio 0:00' },
        continuity: { checked: true, createsLeadGap: false, replacementEventIds: [] },
        core3: { checked: true, status: 'PASS' },
        positiveReason: 'The score places this attack on the top staff and the mix carries it in front.',
      },
      acceptedBy: 'reviewer:test',
    }],
  });
  assert.equal(applied.decisions.applied, true);

  const review = (await service.reviewCandidate(OWNER, projectId, { candidateId: applied.decisions.candidate_id })).review;
  assert.equal(review.lead_promotion.length, 1);
  assert.equal(review.lead_promotion[0].status, 'PASS', 'the Lead promotion gate is satisfied');
  assert.equal(review.readiness.gates.leadPromotion.status, 'PASS');
  // ...and that says nothing about Core3. The role move out of Chord1 is still
  // an unapproved Core3 source change.
  assert.equal(review.core3.status, 'PENDING');
  assert.ok(review.core3.blockers.includes('UNAPPROVED_CORE3_SOURCE_CHANGE'));
  assert.deepEqual(review.core3_approvals, []);
  assert.ok(review.blockers.includes('core3'));
});

test('a Core3 completeness review is candidate-bound and does not clear the continuity gate', async () => {
  const { service, fixture, projectId } = await applicationWithBaseline();
  const applied = await service.applyDecisions(OWNER, projectId, { decisions: [moveChord1Out(fixture)] });
  const candidateId = applied.decisions.candidate_id;

  await service.recordConfirmations(OWNER, projectId, {
    core3_completeness_reviewed: {
      value: true,
      reason: 'Gate 4 reviewed: the reduced Core3 is the complete realization of this source.',
      evidence: ['fixture:score bar 1-4'],
      candidate_id: candidateId,
    },
  });

  const review = (await service.reviewCandidate(OWNER, projectId, { candidateId })).review;
  // The completeness review answers Gate 4...
  assert.equal(review.core3_completeness.reviewed, true);
  // ...and leaves the source-continuity question exactly where it was.
  assert.equal(review.core3.status, 'PENDING');
  assert.ok(review.core3.blockers.includes('UNAPPROVED_CORE3_SOURCE_CHANGE'));
  assert.ok(review.blockers.includes('core3'));
});

// ─── both gates reach Finalize, not just review ─────────────────────────────

test('Finalize reads the recorded Core3 approvals rather than passing none', async () => {
  const { service, fixture, projectId } = await applicationWithBaseline();
  const applied = await service.applyDecisions(OWNER, projectId, { decisions: [moveChord1Out(fixture)] });
  const candidateId = applied.decisions.candidate_id;

  // Finalize used to call the continuity engine with `approvedChanges: []`, so
  // a reviewed change stayed blocked here even once review reported it clear.
  const before = await service.finalize(OWNER, projectId, { candidateId });
  assert.equal(before.mml, null);
  assert.ok(before.blockers.includes('core3'), 'the unapproved Core3 change blocks emission');

  for (const change of (await service.reviewCandidate(OWNER, projectId, { candidateId })).review.core3.unapproved) {
    await service.approveCore3SourceChange(OWNER, projectId, {
      candidateId,
      approval: { event_id: change.eventId, type: change.type, reason: 'Reviewed against the official score.', evidence: ['fixture:score bar 1-4'] },
    });
  }

  const after = await service.finalize(OWNER, projectId, { candidateId });
  assert.equal(after.blockers.includes('core3'), false, 'the approvals must reach the Finalize continuity call too');
  assert.equal(after.readiness.gates.core3.status, 'PASS');
});

test('the Gate 4 completeness gate blocks Finalize and is cleared only by its own review', async () => {
  const service = createStudioApplication();
  const fixture = sixRoleBaseline();
  const created = (await service.createProject(OWNER, { title: 'Gate 4 at finalize' })).project;
  // A baseline whose Core3 the evaluator cannot prove complete: Melody only.
  const melodyOnly = createCanonicalProject({
    ...fixture,
    events: fixture.events.filter(event => event.kind !== 'note' || event.role === 'Melody'),
  });
  await service.uploadAsset(OWNER, created.project_id, {
    kind: 'canonical_project', filename: 'baseline.json', mediaType: 'application/json',
    bytes: new TextEncoder().encode(JSON.stringify(melodyOnly)),
  });
  await service.analyzeSources(OWNER, created.project_id);

  const applied = await service.applyDecisions(OWNER, created.project_id, {
    decisions: [{
      id: 'keep:melody', type: 'KEEP',
      target: { eventIds: melodyOnly.events.filter(event => event.kind === 'note').map(event => event.id) },
      fromRole: 'Melody', reason: 'Reviewed: the source is carried unchanged.', evidence: ['fixture:source'], acceptedBy: 'reviewer:test',
    }],
  });
  const candidateId = applied.decisions.candidate_id;

  // Unchanged from baseline, so source continuity is clean -- and Gate 4 is not
  // thereby answered.
  const review = (await service.reviewCandidate(OWNER, created.project_id, { candidateId })).review;
  assert.equal(review.core3.status, 'PASS', 'the continuity audit has nothing to report');
  assert.equal(review.core3_completeness.status, 'PENDING');
  assert.ok(review.blockers.includes('core3Completeness'));

  const blocked = await service.finalize(OWNER, created.project_id, { candidateId });
  assert.equal(blocked.mml, null);
  assert.ok(blocked.blockers.includes('core3Completeness'), 'a clean continuity audit cannot carry emission on its own');

  // Only the Gate 4 review clears it, and it is candidate-bound.
  await service.recordConfirmations(OWNER, created.project_id, {
    core3_completeness_reviewed: {
      value: true,
      reason: 'Gate 4 reviewed: the source carries a single line and this is its complete realization.',
      evidence: ['fixture:score whole piece'],
      candidate_id: candidateId,
    },
  });
  const cleared = await service.finalize(OWNER, created.project_id, { candidateId });
  assert.equal(cleared.blockers.includes('core3Completeness'), false);
  assert.equal(cleared.readiness.gates.core3Completeness.status, 'PASS');
});

test('Studio Web blocks on the same Gate 4 gate and on its own Core3 review', async () => {
  const { intake, newWorkspace, analyzeWorkspace, recordReview } = await import('../web/model.mjs');
  const asset = (name, value) => intake({ name, content: JSON.stringify(value), id: name });
  const melodyOnly = project('fixture:candidate', MELODY_ONLY);
  const workspace = {
    ...newWorkspace(),
    title: 'Gate 4 web',
    settings: { meterText: '0 4/4', recording: 'synthetic', offset: '0', end: '4', audioRequired: 'no', preview: 'none' },
    assets: { baseline: asset('b.json', project('fixture:baseline', MELODY_ONLY)), candidate: asset('c.json', melodyOnly) },
  };
  const before = analyzeWorkspace(workspace);
  assert.equal(before.core3.status, 'PASS', 'continuity is clean: the candidate is the baseline');
  assert.equal(before.gates.core3Completeness.status, 'PENDING');
  assert.ok(before.blockers.includes('core3Completeness'));

  // The Web Core3 review is the Gate 4 review, and it is what clears it.
  const after = analyzeWorkspace(recordReview(workspace, 'core3', 'Core3 單人完整性已審核：來源為單線，這是其完整實現。', 'fixture:score whole piece'));
  assert.equal(after.gates.core3Completeness.status, 'PASS');
});
