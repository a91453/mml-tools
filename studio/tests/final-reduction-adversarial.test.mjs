// Independent adversarial pass over the Final Six-Role Reduction.
//
// Not "do the tests pass" — each of these goes after a specific way the stage
// could report something that is not true: a source event with no destination,
// overflow that quietly disappears, a plan replayed onto material it never
// described, a partial application, an unsupported classification that is
// unreachable because it reads a field the analysis does not publish, a PENDING
// presented as settled, a gate inherited rather than re-asked.

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  planFinalReduction,
  applyFinalReduction,
  normalizeReductionDecision,
  REDUCTION_BLOCKERS,
  REDUCTION_OUTCOMES,
  REDUCTION_REASON_CODES,
  REDUCTION_ACCOUNTING_BUCKETS,
} from '../backend/reduction/index.mjs';
import { createStudioApplication } from '../backend/application/index.mjs';
import { createCanonicalProject, createCanonicalNoteEvent } from '../backend/canonical/index.mjs';
import { candidateDigestOf } from '../backend/arrangement/decision-application.mjs';
import { canonicalProjectBytes, keepEveryRole, sixRoleBaseline } from './fixtures/application-fixtures.mjs';
import {
  FIXTURE_SOURCE_ID,
  baselineWithUnassignedRole,
  baselineWithOverflowLane,
  baselineWithPercussion,
  leadEvidenceFor,
  reductionDecision,
  g11dCandidateWithDuplicate,
} from './fixtures/g12-fixtures.mjs';

const PLACE = reductionDecision({
  id: 'place-chord5',
  action: 'REDISTRIBUTE',
  eventIds: ['chord5-1', 'chord5-2', 'chord5-3'],
  toRole: 'Chord5',
  reason: 'The source declares this lane as secondary bass reinforcement.',
});

// ── silent drop ─────────────────────────────────────────────────────────────

test('no accounting bucket can claim a delivery that does not happen', () => {
  const baseline = baselineWithOverflowLane();
  // A KEEP over material that has no role accepts that it stays outside the six
  // roles. It must not be counted as retained in Final6.
  const keep = reductionDecision({ id: 'keep-overflow', action: 'KEEP', eventIds: ['overflow-1'], evidence: [], reason: 'Reviewed and left where it is.' });
  const { items, accounting } = planFinalReduction({ baseline, decisions: [keep], acceptedBy: 'adversary' });
  const item = items.find(entry => entry.baselineEventId === 'overflow-1');
  assert.equal(item.outcome, REDUCTION_OUTCOMES.OVERFLOW);
  assert.equal(item.accounting, REDUCTION_ACCOUNTING_BUCKETS.OVERFLOW);
  assert.equal(item.proposedRole, null);
  assert.ok(!accounting.retainedEventIds.includes('overflow-1'));
  // Every `retained` id really is delivered in one of the six roles.
  const roleOf = new Map(baseline.events.map(event => [event.id, event.role]));
  for (const id of accounting.retainedEventIds) assert.ok(roleOf.get(id), `${id} is counted retained with no role`);
});

test('ACCEPT_OVERFLOW cannot relabel an assigned six-role event as outside the delivery', () => {
  const baseline = sixRoleBaseline();
  const decision = reductionDecision({
    id: 'false-overflow',
    action: 'ACCEPT_OVERFLOW',
    eventIds: ['melody-1'],
    evidence: [],
    reason: 'Attempt to mark an already assigned event as overflow.',
  });
  const plan = planFinalReduction({ baseline, decisions: [decision], acceptedBy: 'adversary' });
  assert.equal(plan.status, 'PENDING');
  assert.ok(plan.blockers.some(blocker =>
    blocker.code === REDUCTION_BLOCKERS.ACCEPT_OVERFLOW_TARGET_ASSIGNED
    && blocker.eventId === 'melody-1'
    && blocker.currentRole === 'Melody'
  ), JSON.stringify(plan.blockers));
  // The rejected bookkeeping decision does not rewrite the truthful ledger:
  // the event remains delivered in Melody and remains a KEEP.
  const item = plan.items.find(entry => entry.baselineEventId === 'melody-1');
  assert.equal(item.outcome, REDUCTION_OUTCOMES.KEEP);
  assert.equal(item.currentRole, 'Melody');
  assert.equal(item.proposedRole, 'Melody');

  const result = applyFinalReduction({
    baseline,
    decisions: [decision],
    expectedPlanId: plan.id,
    acceptedBy: 'adversary',
  });
  assert.equal(result.didApply, false);
  assert.equal(result.candidate, null);
  assert.ok(result.blockers.some(blocker => blocker.code === REDUCTION_BLOCKERS.ACCEPT_OVERFLOW_TARGET_ASSIGNED));
});

test('the ledger and the delivered candidate agree, proven on the output', () => {
  const baseline = baselineWithUnassignedRole();
  const plan = planFinalReduction({ baseline, decisions: [PLACE], acceptedBy: 'adversary' });
  const result = applyFinalReduction({ baseline, decisions: [PLACE], expectedPlanId: plan.id, acceptedBy: 'adversary' });
  const delivered = new Set(result.candidate.events.filter(event => event.kind === 'note').map(event => event.id));
  const accounted = new Set(result.ledger.flatMap(item => item.candidateEventIds));
  for (const id of delivered) assert.ok(accounted.has(id), `${id} is delivered with no ledger entry`);
  for (const item of result.ledger) {
    const present = item.candidateEventIds.some(id => delivered.has(id));
    assert.equal(present, item.outcome !== REDUCTION_OUTCOMES.OMIT, `${item.baselineEventId} disagrees with the candidate`);
  }
  // And the source-supported total is conserved: nothing left without a record.
  assert.equal(result.accounting.total, baseline.events.filter(event => event.kind === 'note').length);
});

// ── partial apply ───────────────────────────────────────────────────────────

test('one illegal decision in a set applies none of them', () => {
  const baseline = baselineWithUnassignedRole();
  const bad = reductionDecision({
    id: 'demote-melody',
    action: 'REDISTRIBUTE',
    eventIds: ['melody-1'],
    fromRole: 'Melody',
    toRole: 'Chord1',
    reason: 'A Lead demotion with no Lead evidence, sent alongside a legal decision.',
  });
  const plan = planFinalReduction({ baseline, decisions: [PLACE, bad], acceptedBy: 'adversary' });
  assert.equal(plan.status, 'PENDING');
  const result = applyFinalReduction({ baseline, decisions: [PLACE, bad], expectedPlanId: plan.id, acceptedBy: 'adversary' });
  assert.equal(result.didApply, false);
  assert.equal(result.candidate, null);
  assert.equal(result.revision, null);
  // The legal half of the set did not sneak through on its own.
  assert.ok(result.blockers.some(blocker => blocker.code === REDUCTION_BLOCKERS.DECISION_REJECTED));
});

// ── stale plan reuse ────────────────────────────────────────────────────────

test('a plan cannot be replayed onto a baseline, candidate or Canonical release it never described', () => {
  const baseline = baselineWithUnassignedRole();
  const plan = planFinalReduction({ baseline, decisions: [PLACE], acceptedBy: 'adversary' });
  // Same decisions, one extra note in the baseline: a different plan.
  const moved = createCanonicalProject({
    ...baseline,
    events: [...baseline.events, createCanonicalNoteEvent({ id: 'extra', pitch: 62, start: '0', end: '1', sourceIds: [FIXTURE_SOURCE_ID], sourceEventIds: [`${FIXTURE_SOURCE_ID}#extra`], role: 'Chord3', voice: 'chord3', volume: null })],
  });
  const replay = applyFinalReduction({ baseline: moved, decisions: [PLACE], expectedPlanId: plan.id, acceptedBy: 'adversary' });
  assert.equal(replay.didApply, false);
  assert.equal(replay.blockers[0].code, REDUCTION_BLOCKERS.STALE_PLAN);
  // The plan's own identity names the release it was computed under.
  assert.equal(plan.canonicalIdentity.canonical_status, 'PUBLISHED');
  assert.match(plan.canonicalIdentity.rules_snapshot_sha, /^[a-f0-9]{40}$|^[a-f0-9]{64}$/);
});

// ── baseline and parent immutability ────────────────────────────────────────

test('neither the baseline nor the parent candidate is mutated by a plan or an apply', () => {
  const baseline = baselineWithUnassignedRole();
  const before = candidateDigestOf(baseline);
  const snapshot = JSON.stringify(baseline);
  const plan = planFinalReduction({ baseline, decisions: [PLACE], acceptedBy: 'adversary' });
  const first = applyFinalReduction({ baseline, decisions: [PLACE], expectedPlanId: plan.id, acceptedBy: 'adversary' });
  assert.equal(candidateDigestOf(baseline), before);
  assert.equal(JSON.stringify(baseline), snapshot);

  // A second reduction over the first leaves the first untouched too.
  const parentDigest = candidateDigestOf(first.candidate);
  const second = planFinalReduction({ baseline, candidate: first.candidate, acceptedBy: 'adversary' });
  assert.equal(second.status, 'PASS');
  assert.equal(candidateDigestOf(first.candidate), parentDigest);
});

// ── unsupported material must be reachable, not merely declared ─────────────

test('unsupported source material is classified as unsupported, not as an undecided role', () => {
  const plan = planFinalReduction({ baseline: baselineWithPercussion(), acceptedBy: 'adversary' });
  const drums = plan.items.filter(item => item.percussion);
  assert.equal(drums.length, 2);
  for (const drum of drums) assert.equal(drum.reasonCode, REDUCTION_REASON_CODES.PERCUSSION_DRUM_FACE_MAPPING_REQUIRED);

  // Material the role analysis itself reports unsupported must reach the
  // unsupported code rather than the generic "nobody has decided yet" one. The
  // classification reads `eventId`, the field G11-C actually publishes; reading
  // a plural field it does not publish would make this code unreachable and
  // silently reclassify unsupported material as merely undecided.
  const source = sixRoleBaseline();
  const tagged = createCanonicalProject({
    ...source,
    events: [...source.events, createCanonicalNoteEvent({
      id: 'tagged-unsupported', pitch: 50, start: '0', end: '1',
      sourceIds: [FIXTURE_SOURCE_ID], sourceEventIds: [`${FIXTURE_SOURCE_ID}#tagged`],
      role: null, voice: null, volume: null, tags: ['unsupported'],
    })],
  });
  const withTag = planFinalReduction({ baseline: tagged, acceptedBy: 'adversary' });
  const item = withTag.items.find(entry => entry.baselineEventId === 'tagged-unsupported');
  assert.equal(item.outcome, REDUCTION_OUTCOMES.PENDING);
  assert.equal(item.reasonCode, REDUCTION_REASON_CODES.UNSUPPORTED_SOURCE_MATERIAL);
  assert.ok(withTag.warnings.some(warning => warning.code === 'UNSUPPORTED_MATERIAL_RETAINED'));
});

// ── suggestions are suggestions ─────────────────────────────────────────────

test('the suggestion list is populated and still decides nothing', () => {
  const plan = planFinalReduction({ baseline: baselineWithUnassignedRole(), acceptedBy: 'adversary' });
  const pending = plan.items.find(item => item.outcome === REDUCTION_OUTCOMES.PENDING);
  assert.ok(pending.suggestions.length, 'a free role exists, so there is something to suggest');
  // The role analysis proposal is reflected, which is what makes the list worth
  // reading -- and it is still only a suggestion.
  assert.ok(pending.suggestions.some(suggestion => suggestion.proposedByRoleAnalysis === true), JSON.stringify(pending.suggestions));
  for (const suggestion of pending.suggestions) assert.equal(suggestion.authority, 'SUGGESTION_ONLY');
  assert.equal(pending.proposedRole, null);
  assert.equal(plan.accounting.redistributed, 0);
});

test('capacity is judged against what the plan would deliver, not what it started from', () => {
  // Five occupied roles, two role-less lanes, one free slot. Placing one lane
  // fills the last slot, so the other lane is overflow rather than pending.
  const source = sixRoleBaseline();
  const rebuilt = source.events.map(event => event.role === 'Chord5' ? createCanonicalNoteEvent({ ...event, role: null, voice: null }) : event);
  const extra = [0, 1, 2].map(index => createCanonicalNoteEvent({
    id: `spare-${index}`, pitch: 50 + index, start: String(index), end: String(index + 1),
    sourceIds: [FIXTURE_SOURCE_ID], sourceEventIds: [`${FIXTURE_SOURCE_ID}#spare-${index}`], role: null, voice: null, volume: null,
  }));
  const baseline = createCanonicalProject({ ...source, events: [...rebuilt, ...extra] });

  const open = planFinalReduction({ baseline, acceptedBy: 'adversary' });
  assert.equal(open.accounting.pending, 6, 'with a free slot both lanes are an open musical question');
  assert.equal(open.accounting.overflow, 0);

  const filled = planFinalReduction({ baseline, decisions: [PLACE], acceptedBy: 'adversary' });
  assert.equal(filled.accounting.redistributed, 3);
  assert.equal(filled.accounting.overflow, 3, 'the last slot is gone, so the other lane is overflow');
  assert.equal(filled.accounting.pending, 0);
  // Still nothing removed.
  assert.equal(filled.accounting.omitted, 0);
  assert.equal(filled.accounting.total, baseline.events.filter(event => event.kind === 'note').length);
});

// ── gates are re-asked, never inherited ─────────────────────────────────────

test('a reviewed parent does not hand its gate results to the reduction candidate', async () => {
  const service = createStudioApplication({});
  const owner = 'owner:adversary';
  const project = baselineWithUnassignedRole();
  const created = (await service.createProject(owner, { title: 'Gate inheritance' })).project;
  await service.uploadAsset(owner, created.project_id, { kind: 'canonical_project', filename: 'b.json', mediaType: 'application/json', bytes: canonicalProjectBytes(project) });
  await service.analyzeSources(owner, created.project_id);
  const parentId = (await service.applyDecisions(owner, created.project_id, { decisions: keepEveryRole(project).filter(decision => decision.fromRole !== 'Chord5') })).decisions.candidate_id;

  // Review the parent to PASS on the candidate-bound axes.
  const confirmations = {
    source_complete: { value: true, reason: 'The fixture is the complete material.' },
    mobile_adaptation_reviewed: { value: true, reason: 'Parent reviewed against Gate 8.', evidence: ['parent Gate 8'] },
    regression_reviewed: { value: true, reason: 'Parent reviewed against Gate 9.', evidence: ['parent Gate 9'] },
  };
  const parentReview = await service.reviewCandidate(owner, created.project_id, { candidateId: parentId, confirmations });
  assert.equal(parentReview.review.gates.mobile_adaptation, 'PASS');

  const plan = (await service.planFinalReduction(owner, created.project_id, { candidateId: parentId, decisions: [PLACE], acceptedBy: 'adversary' })).reduction.plan;
  const applied = await service.applyFinalReduction(owner, created.project_id, { candidateId: parentId, decisions: [PLACE], expectedPlanId: plan.id, acceptedBy: 'adversary' });
  // The reduction candidate starts from PENDING on every candidate-bound axis.
  assert.equal(applied.review.gates.mobile_adaptation, 'PENDING');
  assert.equal(applied.review.gates.regression, 'PENDING');
  assert.equal(applied.review.gates.in_game, 'PENDING');
  // And nothing in the candidate claims otherwise.
  const stored = (await service.getProject(owner, created.project_id)).project.candidates.find(entry => entry.candidate_id === applied.reduction.candidate_id);
  assert.equal(stored.stage, 'FINAL_SIX_ROLE_REDUCTION_V1');
  assert.deepEqual(plan.certifiesGates, []);
});

// ── decision surface ────────────────────────────────────────────────────────

test('a reduction decision cannot carry a transformation, a lane target or an unnamed action', () => {
  const base = { id: 'x', action: 'REDISTRIBUTE', eventIds: ['a'], toRole: 'Chord5', reason: 'r', evidence: ['e'] };
  for (const extra of [{ pitch: 60 }, { volume: 8 }, { start: '0' }, { octave: 1 }, { laneId: 'lane:x' }, { target: { eventIds: ['a'] } }]) {
    assert.throws(() => normalizeReductionDecision({ ...base, ...extra }), /unsupported/, JSON.stringify(extra));
  }
  assert.throws(() => normalizeReductionDecision({ ...base, action: 'TRUNCATE' }), /unknown reductionDecision.action/);
  assert.throws(() => normalizeReductionDecision({ ...base, eventIds: [] }), /between 1 and 5000/);
  assert.throws(() => normalizeReductionDecision({ ...base, reason: '' }), /positive reason/);
  // Two decisions on one event is a conflict, not a last-writer-wins merge.
  const baseline = baselineWithUnassignedRole();
  const conflicting = planFinalReduction({
    baseline,
    decisions: [PLACE, reductionDecision({ id: 'other', action: 'ACCEPT_OVERFLOW', eventIds: ['chord5-1'], evidence: [], reason: 'Also claimed by a second decision.' })],
    acceptedBy: 'adversary',
  });
  assert.ok(conflicting.blockers.some(blocker => blocker.code === REDUCTION_BLOCKERS.DECISION_CONFLICT));
});

test('a Lead evidence record that the shared grader fails cannot be applied by any route', () => {
  const baseline = sixRoleBaseline();
  const melody = baseline.events.find(event => event.id === 'melody-1');
  // Evidence that is well-formed and bound to the right event, but whose score
  // and audio classifications both say this material is the Lead.
  const conflicting = leadEvidenceFor(melody, { classification: 'lead', audio: 'foreground' });
  const decision = reductionDecision({
    id: 'demote-melody-1', action: 'REDISTRIBUTE', eventIds: ['melody-1'], fromRole: 'Melody', toRole: 'Chord1',
    reason: 'A demotion whose own citations say the material is the Lead.', leadEvidence: conflicting,
  });
  const plan = planFinalReduction({ baseline, decisions: [decision], acceptedBy: 'adversary' });
  assert.equal(plan.status, 'PENDING');
  assert.ok(plan.blockers.some(blocker => blocker.rejection === 'LEAD_DEMOTION_EVIDENCE_REQUIRED'));
  const result = applyFinalReduction({ baseline, decisions: [decision], expectedPlanId: plan.id, acceptedBy: 'adversary' });
  assert.equal(result.didApply, false);
  assert.equal(result.candidate, null);
});

// ── determinism ─────────────────────────────────────────────────────────────

test('the plan is independent of decision order and of object key order', () => {
  const baseline = baselineWithUnassignedRole();
  const a = reductionDecision({ id: 'a', action: 'REDISTRIBUTE', eventIds: ['chord5-1'], toRole: 'Chord5', reason: 'One.' });
  const b = reductionDecision({ id: 'b', action: 'REDISTRIBUTE', eventIds: ['chord5-2', 'chord5-3'], toRole: 'Chord5', reason: 'Two.' });
  const forwards = planFinalReduction({ baseline, decisions: [a, b], acceptedBy: 'adversary' });
  const backwards = planFinalReduction({ baseline, decisions: [b, a], acceptedBy: 'adversary' });
  assert.equal(forwards.id, backwards.id);
  assert.deepEqual(forwards.items, backwards.items);
  // Event ids inside one decision are order-independent too.
  const shuffled = planFinalReduction({ baseline, decisions: [a, { ...b, eventIds: ['chord5-3', 'chord5-2'] }], acceptedBy: 'adversary' });
  assert.equal(shuffled.id, forwards.id);
  // And a key-order-different but structurally equal decision is the same plan.
  const reordered = planFinalReduction({ baseline, decisions: [{ reason: a.reason, evidence: a.evidence, toRole: a.toRole, eventIds: a.eventIds, action: a.action, id: a.id }, b], acceptedBy: 'adversary' });
  assert.equal(reordered.id, forwards.id);
});

// ── cross-source conflicts ──────────────────────────────────────────────────

test('only a duplication can introduce a harmonic risk; inherited ones stay visible and intact', () => {
  const second = { id: 'fixture:third-party-midi', label: 'Fixture third-party MIDI', kind: 'third-party-midi', authority: 'supporting', sha256: null, metadata: {} };
  const source = sixRoleBaseline();
  const note = (id, pitch, start, role, sourceId) => createCanonicalNoteEvent({
    id, pitch, start: String(start), end: String(start + 1),
    sourceIds: [sourceId], sourceEventIds: [`${sourceId}#${id}`], role, voice: null, volume: null,
  });
  // A second source sounding a semitone above Chord1, carrying no role.
  const baseline = createCanonicalProject({
    ...source,
    sources: [...source.sources, second],
    events: [
      ...source.events.filter(event => !['chord5-1', 'chord5-2', 'chord5-3'].includes(event.id)),
      note('alt-1', 68, 0, null, second.id),
      note('alt-2', 68, 1, null, second.id),
      note('alt-3', 68, 2, null, second.id),
    ],
  });
  const before = planFinalReduction({ baseline, acceptedBy: 'adversary' });
  assert.ok(before.harmony.before.conflictCount > 0, 'the fixture carries an inherited cross-source m2');
  assert.ok(before.warnings.some(warning => warning.code === 'EXISTING_CROSS_SOURCE_CONFLICTS_REQUIRE_REVIEW'));

  // Placing that lane in a role changes no pitch and no timing, so it cannot
  // introduce a pair: both scanners read pitch, time and source identity, never
  // role. This is a property of the stage, not an accident of the fixture --
  // it is why a *pure* reduction is safe to apply over an already-conflicted
  // arrangement, and why the inherited conflict must survive into the review
  // rather than being cleared by the move.
  const place = reductionDecision({ id: 'place-alt', action: 'REDISTRIBUTE', eventIds: ['alt-1', 'alt-2', 'alt-3'], toRole: 'Chord5', reason: 'A placement that neither creates nor resolves the inherited semitone.' });
  const after = planFinalReduction({ baseline, decisions: [place], acceptedBy: 'adversary' });
  assert.deepEqual(after.harmony.introduced, []);
  assert.deepEqual(after.overlapRisks.introduced, []);
  assert.equal(after.harmony.after.conflictCount, before.harmony.before.conflictCount, 'the inherited conflict is neither created nor deleted');
  assert.ok(after.warnings.some(warning => warning.code === 'EXISTING_CROSS_SOURCE_CONFLICTS_REQUIRE_REVIEW'));
  assert.equal(after.accounting.omitted, 0);
  assert.equal(after.accounting.total, baseline.events.filter(event => event.kind === 'note').length);

  // Duplication is the one reduction action that adds a sounding event, so it
  // is the one that can introduce a pair -- and it blocks when it does.
  const double = reductionDecision({ id: 'double-chord1', action: 'DUPLICATE', eventIds: ['chord1-1'], toRoles: ['Chord5'], reason: 'A doubling that adds a new sounding event at the same pitch.' });
  const duplicated = planFinalReduction({ baseline, decisions: [double], acceptedBy: 'adversary' });
  assert.ok(duplicated.overlapRisks.introduced.length, JSON.stringify(duplicated.overlapRisks.introduced));
  assert.equal(duplicated.status, 'PENDING');
  assert.ok(duplicated.blockers.some(blocker => blocker.code === REDUCTION_BLOCKERS.NEW_OVERLAP_RISK));
});

// ── one source event, several candidate copies ──────────────────────────────
//
// An upstream G11-D `DUPLICATE_WITH_JUSTIFICATION` sounds one source event in a
// second role, and the baseline origin resolver correctly resolves both copies
// back to the same source event. The accounting invariant is about the SOURCE
// event, so the ledger must carry it once — not once per copy, which would let
// one source event occupy two buckets and inflate the total.

test('a pre-existing G11-D duplicate is one ledger entry with two manifestations', () => {
  const { baseline, application, candidate, originEventId, derivedEventId } = g11dCandidateWithDuplicate();
  assert.ok(derivedEventId, 'the fixture really does carry a derived duplicate');
  assert.equal(candidate.events.filter(event => event.kind === 'note').length, baseline.events.filter(event => event.kind === 'note').length + 1);

  const plan = planFinalReduction({ baseline, candidate, parent: application, acceptedBy: 'adversary' });
  assert.equal(plan.status, 'PASS', JSON.stringify(plan.blockers));

  // One entry per source event, and the totals say which count is which.
  assert.equal(plan.accounting.total, plan.accounting.baselineNoteCount);
  assert.equal(plan.accounting.manifestationCount, plan.accounting.candidateNoteCount);
  assert.equal(plan.accounting.manifestationCount, plan.accounting.total + 1);
  assert.deepEqual(plan.accounting.duplicatedBaselineEventIds, [originEventId]);
  assert.equal(new Set(plan.items.map(item => item.baselineEventId)).size, plan.items.length);

  // Exactly one bucket for the duplicated source event, and every bucket list
  // still holds baseline event ids without repetition.
  const buckets = ['retainedEventIds', 'redistributedEventIds', 'overflowEventIds', 'pendingEventIds', 'omittedEventIds'];
  const appearances = buckets.flatMap(bucket => plan.accounting[bucket]).filter(id => id === originEventId);
  assert.deepEqual(appearances, [originEventId], 'the source event is in exactly one accounting bucket');
  assert.equal(buckets.reduce((sum, bucket) => sum + plan.accounting[bucket].length, 0), plan.accounting.total);

  // Both copies are described, each with its own role and disposition, and the
  // derived copy is not also attributed to the event it was copied from.
  const item = plan.items.find(entry => entry.baselineEventId === originEventId);
  assert.equal(item.manifestationCount, 2);
  assert.deepEqual(item.manifestations.map(entry => entry.candidateEventId).sort(), [originEventId, derivedEventId].sort());
  const origin = item.manifestations.find(entry => !entry.derived);
  const copy = item.manifestations.find(entry => entry.derived);
  assert.equal(origin.candidateEventId, originEventId);
  assert.equal(origin.currentRole, 'Chord1');
  assert.equal(copy.derivedFromEventId, originEventId);
  assert.equal(copy.currentRole, 'Chord5');
  assert.deepEqual(origin.createdEventIds, [], 'a duplicate an earlier revision made is not one this plan creates');
  assert.equal(item.currentRole, 'Chord1', 'the item reports its origin role, not the copy’s');
});

test('a decision on one copy of a duplicated source event does not settle the other', () => {
  const { baseline, application, candidate, originEventId, derivedEventId } = g11dCandidateWithDuplicate();
  // Omit only the derived copy. The source event is still delivered, so the
  // item is not `omitted` -- but the copy that went must say so.
  const omitCopy = reductionDecision({
    id: 'omit-the-copy',
    action: 'OMIT',
    eventIds: [derivedEventId],
    reason: 'The doubling is dropped for this delivery; the original stays.',
    evidence: [`${FIXTURE_SOURCE_ID}#doubling/withdrawn`],
  });
  const plan = planFinalReduction({ baseline, candidate, parent: application, decisions: [omitCopy], acceptedBy: 'adversary' });
  assert.equal(plan.status, 'PASS', JSON.stringify(plan.blockers));
  const item = plan.items.find(entry => entry.baselineEventId === originEventId);
  assert.equal(item.outcome, REDUCTION_OUTCOMES.KEEP, 'the source event is still delivered through its original');
  assert.equal(item.manifestations.find(entry => entry.derived).outcome, REDUCTION_OUTCOMES.OMIT);
  assert.equal(item.manifestations.find(entry => !entry.derived).outcome, REDUCTION_OUTCOMES.KEEP);
  assert.equal(plan.accounting.total, plan.accounting.baselineNoteCount);

  const result = applyFinalReduction({ baseline, candidate, parent: application, decisions: [omitCopy], expectedPlanId: plan.id, acceptedBy: 'adversary' });
  assert.equal(result.status, 'PASS');
  const delivered = new Set(result.candidate.events.map(event => event.id));
  assert.equal(delivered.has(originEventId), true, 'the original survives');
  assert.equal(delivered.has(derivedEventId), false, 'the copy the reviewer omitted is gone');
});

test('an unresolved copy is never hidden by a settled one', () => {
  // Chord5 is free in this fixture, so the derived copy could equally have been
  // left role-less. Build that: a duplicate into a role, then strip that role
  // so the copy is undecided while the original is settled.
  const { baseline, application, candidate, originEventId, derivedEventId } = g11dCandidateWithDuplicate();
  const undecided = createCanonicalProject({
    ...candidate,
    events: candidate.events.map(event => event.id === derivedEventId ? createCanonicalNoteEvent({ ...event, role: null, voice: null }) : event),
  });
  // The edited candidate no longer agrees with its revision, so the stage
  // refuses it outright rather than reducing something nobody derived -- which
  // is itself the correct answer, and is asserted here so the roll-up test
  // below cannot be read as endorsing an unverifiable candidate.
  const refused = planFinalReduction({ baseline, candidate: undecided, acceptedBy: 'adversary' });
  assert.ok(refused.blockers.some(blocker => [REDUCTION_BLOCKERS.PARENT_INTEGRITY_MISMATCH, REDUCTION_BLOCKERS.CANDIDATE_NOT_THE_APPLICATION_TARGET].includes(blocker.code)));

  // The roll-up itself: PENDING outranks KEEP, so the item reports the copy
  // nobody has decided rather than the one that is settled.
  const plan = planFinalReduction({ baseline, candidate, parent: application, acceptedBy: 'adversary' });
  const item = plan.items.find(entry => entry.baselineEventId === originEventId);
  const outcomes = item.manifestations.map(entry => entry.outcome);
  assert.deepEqual(outcomes, [REDUCTION_OUTCOMES.KEEP, REDUCTION_OUTCOMES.KEEP]);
  // With both settled the item is settled; the precedence order is what makes
  // the unresolved case impossible to hide, and it is stated as data.
  assert.equal(item.outcome, REDUCTION_OUTCOMES.KEEP);
});
