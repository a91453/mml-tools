import test from 'node:test';
import assert from 'node:assert/strict';
import {
  planFinalReduction,
  applyFinalReduction,
  normalizeReductionDecision,
  normalizeInstrumentProfile,
  FINAL_REDUCTION_STAGE,
  REDUCTION_BLOCKERS,
  REDUCTION_WARNINGS,
  REDUCTION_OUTCOMES,
  REDUCTION_REASON_CODES,
  FINAL_REDUCTION_STATUS,
  INSTRUMENT_PROFILE_SCHEMA,
} from '../backend/reduction/index.mjs';
import { createCanonicalProject, createCanonicalNoteEvent } from '../backend/canonical/index.mjs';
import { applicationIntegrity } from '../backend/arrangement/decision-review.mjs';
import { candidateDigestOf, revisionIdentityMatches } from '../backend/arrangement/decision-application.mjs';
import { emitFinalMml } from '../backend/final/index.mjs';
import { sixRoleBaseline } from './fixtures/application-fixtures.mjs';
import {
  FIXTURE_SOURCE_ID,
  baselineWithUnassignedRole,
  baselineWithOverflowLane,
  baselineWithPercussion,
  baselineWithoutLead,
  leadEvidenceFor,
  reductionDecision,
} from './fixtures/g12-fixtures.mjs';

const placeChord5 = reductionDecision({
  id: 'place-chord5',
  action: 'REDISTRIBUTE',
  eventIds: ['chord5-1', 'chord5-2', 'chord5-3'],
  toRole: 'Chord5',
  reason: 'The source declares this lane as secondary bass reinforcement; it is placed in the one free enrichment role.',
});

const apply = (baseline, decisions, extra = {}) => {
  const plan = planFinalReduction({ baseline, decisions, acceptedBy: 'test-reviewer', ...extra });
  return { plan, result: applyFinalReduction({ baseline, decisions, expectedPlanId: plan.id, acceptedBy: 'test-reviewer', ...extra }) };
};

// ─── plan identity and determinism ──────────────────────────────────────────

test('a plan is deterministic, content-bound and identical across equal inputs', () => {
  const baseline = baselineWithUnassignedRole();
  const one = planFinalReduction({ baseline, decisions: [placeChord5], acceptedBy: 'test-reviewer' });
  const two = planFinalReduction({ baseline: structuredClone(baseline), decisions: [structuredClone(placeChord5)], acceptedBy: 'test-reviewer' });
  assert.equal(one.id, two.id);
  assert.deepEqual(one, two);
  assert.equal(one.stage, FINAL_REDUCTION_STAGE);
  assert.match(one.id, /^g12:plan:[a-f0-9]{64}$/);
  assert.deepEqual(one.certifiesGates, []);
  // A different decision set, a different plan.
  const other = planFinalReduction({ baseline, decisions: [{ ...placeChord5, toRole: 'Chord4' }], acceptedBy: 'test-reviewer' });
  assert.notEqual(one.id, other.id);
  // A different reviewer, a different plan: the acceptance bindings differ.
  assert.notEqual(one.id, planFinalReduction({ baseline, decisions: [placeChord5], acceptedBy: 'someone-else' }).id);
});

test('a plan mutates neither the baseline nor the candidate', () => {
  const baseline = baselineWithUnassignedRole();
  const snapshot = structuredClone(baseline);
  planFinalReduction({ baseline, decisions: [placeChord5], acceptedBy: 'test-reviewer' });
  assert.deepEqual(baseline, snapshot);
  const applied = apply(baseline, [placeChord5]);
  assert.equal(applied.result.status, 'PASS');
  assert.deepEqual(baseline, snapshot);
});

test('a stale plan id is refused and applies nothing', () => {
  const baseline = baselineWithUnassignedRole();
  const plan = planFinalReduction({ baseline, decisions: [placeChord5], acceptedBy: 'test-reviewer' });
  const stale = applyFinalReduction({ baseline, decisions: [placeChord5], expectedPlanId: `${plan.id}x`, acceptedBy: 'test-reviewer' });
  assert.equal(stale.didApply, false);
  assert.equal(stale.candidate, null);
  assert.equal(stale.revision, null);
  assert.equal(stale.blockers[0].code, REDUCTION_BLOCKERS.STALE_PLAN);
  // A plan previewed for one decision set cannot be replayed onto another.
  const swapped = applyFinalReduction({ baseline, decisions: [{ ...placeChord5, toRole: 'Chord4' }], expectedPlanId: plan.id, acceptedBy: 'test-reviewer' });
  assert.equal(swapped.blockers[0].code, REDUCTION_BLOCKERS.STALE_PLAN);
  // And neither can a plan accepted by one reviewer be applied under another.
  const reviewer = applyFinalReduction({ baseline, decisions: [placeChord5], expectedPlanId: plan.id, acceptedBy: 'another-reviewer' });
  assert.equal(reviewer.blockers[0].code, REDUCTION_BLOCKERS.STALE_PLAN);
});

test('applying nothing does not mint a reduction candidate', () => {
  const baseline = baselineWithUnassignedRole();
  const plan = planFinalReduction({ baseline, acceptedBy: 'test-reviewer' });
  const result = applyFinalReduction({ baseline, expectedPlanId: plan.id, acceptedBy: 'test-reviewer' });
  assert.equal(result.didApply, false);
  assert.equal(result.unchanged, true);
  assert.equal(result.blockers[0].code, REDUCTION_BLOCKERS.NOTHING_TO_APPLY);
});

// ─── revision, provenance and rollback ──────────────────────────────────────

test('apply mints a reduction-stage revision that keeps baseline and parent provenance', () => {
  const baseline = baselineWithUnassignedRole();
  const { result } = apply(baseline, [placeChord5]);
  assert.equal(result.status, 'PASS');
  assert.equal(result.revision.stage, FINAL_REDUCTION_STAGE);
  assert.equal(result.revision.stageKind, 'FINAL_SIX_ROLE_REDUCTION_REVISION');
  assert.equal(result.candidate.id, `${baseline.id}#g12-r1`);
  assert.equal(revisionIdentityMatches(result.revision), true);
  assert.equal(candidateDigestOf(result.candidate), result.revision.candidateDigest);
  assert.equal(applicationIntegrity(result.roleApplication, baseline).ok, true);
  assert.deepEqual(result.certifiesGates, []);
  assert.deepEqual(result.candidate.metadata.g11d.certifiesGates, []);
  assert.deepEqual(result.candidate.metadata.g12.certifiesGates, []);
  // The Source-Faithful Baseline travels with the candidate, unchanged.
  assert.deepEqual(result.candidate.metadata.sourceFaithfulBaseline.snapshot.events.map(e => e.id).sort(), baseline.events.map(e => e.id).sort());
  // Rollback is the parent: the reduction candidate is derived, never in place.
  assert.notEqual(result.candidate.id, baseline.id);
  assert.equal(result.revision.parentRevisionId, null);
});

test('a reduction revision is not a G11-D role decision even over identical inputs', () => {
  const baseline = baselineWithUnassignedRole();
  const { result } = apply(baseline, [placeChord5]);
  assert.notEqual(result.revision.stage, 'G11-D');
  assert.equal(result.candidate.metadata.g11d.revision.stage, FINAL_REDUCTION_STAGE);
  assert.equal(result.candidate.metadata.g12.planId, result.plan.id);
  assert.equal(result.candidate.metadata.g12.inputDigest, result.plan.inputDigest);
});

test('an edited ledger no longer hashes to the revision that names it', () => {
  const baseline = baselineWithUnassignedRole();
  const { result } = apply(baseline, [placeChord5]);
  const tampered = createCanonicalProject({
    ...result.candidate,
    metadata: { ...result.candidate.metadata, g12: { ...result.candidate.metadata.g12, accounting: { ...result.candidate.metadata.g12.accounting, omitted: 99 } } },
  });
  assert.notEqual(candidateDigestOf(tampered), result.revision.candidateDigest);
  assert.equal(applicationIntegrity({ ...result.roleApplication, candidate: tampered }, baseline).ok, false);
});

// ─── event accounting invariant ─────────────────────────────────────────────

test('every source-supported baseline event lands in exactly one accounting bucket', () => {
  for (const baseline of [sixRoleBaseline(), baselineWithUnassignedRole(), baselineWithOverflowLane(), baselineWithPercussion()]) {
    const plan = planFinalReduction({ baseline, acceptedBy: 'test-reviewer' });
    const noteCount = baseline.events.filter(event => event.kind === 'note').length;
    const { retained, redistributed, overflow, pending, omitted, total } = plan.accounting;
    assert.equal(total, noteCount);
    assert.equal(retained + redistributed + overflow + pending + omitted, noteCount);
    assert.equal(new Set(plan.items.map(item => item.baselineEventId)).size, noteCount);
    for (const item of plan.items) assert.ok(Object.values(REDUCTION_OUTCOMES).includes(item.outcome));
  }
});

test('overflow material stays in the ledger and in the candidate rather than being dropped', () => {
  const baseline = baselineWithOverflowLane();
  const plan = planFinalReduction({ baseline, acceptedBy: 'test-reviewer' });
  assert.deepEqual(plan.roleCapacity.free, []);
  assert.equal(plan.accounting.overflow, 3);
  assert.deepEqual(plan.accounting.overflowEventIds, ['overflow-1', 'overflow-2', 'overflow-3']);
  for (const item of plan.items.filter(entry => entry.outcome === REDUCTION_OUTCOMES.OVERFLOW)) {
    assert.equal(item.reasonCode, REDUCTION_REASON_CODES.SIX_ROLE_CAPACITY_EXCEEDED);
    assert.ok(item.suggestions.length, 'overflow should expose non-authoritative merge diagnostics');
    assert.ok(item.suggestions.every(suggestion => suggestion.authority === 'SUGGESTION_ONLY'));
    assert.ok(item.suggestions.every(suggestion => suggestion.wouldRequireTrimOrDropCount >= 0));
  }
  const diagnosed = [...new Set(plan.legacyMergeDiagnostics.flatMap(entry => entry.sourceEventIds))].sort();
  assert.deepEqual(diagnosed, ['overflow-1', 'overflow-2', 'overflow-3']);
  assert.ok(plan.legacyMergeDiagnostics.every(entry => entry.authority === 'SUGGESTION_ONLY'));
  assert.ok(plan.warnings.some(warning => warning.code === REDUCTION_WARNINGS.OVERFLOW_RETAINED));
  // Accepting the overflow records the review; it still removes nothing.
  const accept = reductionDecision({ id: 'accept-overflow', action: 'ACCEPT_OVERFLOW', eventIds: ['overflow-1', 'overflow-2', 'overflow-3'], evidence: [], reason: 'The reviewer accepts that this lane stays outside the six roles for this delivery.' });
  const { result } = apply(baseline, [accept]);
  assert.equal(result.status, 'PASS');
  const delivered = result.candidate.events.filter(event => event.id.startsWith('overflow-'));
  assert.equal(delivered.length, 3);
  assert.deepEqual(delivered.map(event => event.role), [null, null, null]);
  assert.equal(result.accounting.overflow, 3);
});

test('unresolved role material stays PENDING with suggestions that decide nothing', () => {
  const baseline = baselineWithUnassignedRole();
  const plan = planFinalReduction({ baseline, acceptedBy: 'test-reviewer' });
  assert.equal(plan.accounting.pending, 3);
  const pending = plan.items.find(item => item.outcome === REDUCTION_OUTCOMES.PENDING);
  assert.equal(pending.reasonCode, REDUCTION_REASON_CODES.ROLE_DECISION_REQUIRED);
  assert.equal(pending.proposedRole, null);
  assert.ok(pending.suggestions.length);
  for (const suggestion of pending.suggestions) assert.equal(suggestion.authority, 'SUGGESTION_ONLY');
  assert.ok(plan.warnings.some(warning => warning.code === REDUCTION_WARNINGS.PENDING_RETAINED));
});

test('a character budget over the limit reports pressure and removes nothing', () => {
  const source = sixRoleBaseline();
  // One role with enough separate attacks to pass the per-role character limit.
  const dense = Array.from({ length: 2400 }, (_, index) => createCanonicalNoteEvent({
    id: `dense-${index}`,
    pitch: 60 + (index % 12),
    start: String(index / 4),
    end: String((index + 1) / 4),
    sourceIds: [FIXTURE_SOURCE_ID],
    sourceEventIds: [`${FIXTURE_SOURCE_ID}#dense-${index}`],
    role: 'Chord5',
    voice: 'chord5',
    volume: null,
  }));
  const baseline = createCanonicalProject({ ...source, events: [...source.events.filter(event => event.role !== 'Chord5'), ...dense] });
  const plan = planFinalReduction({ baseline, acceptedBy: 'test-reviewer' });
  const budget = plan.characterBudget.after;
  assert.equal(budget.status, 'MEASURED');
  assert.ok(budget.overBudget.some(entry => entry.role === 'Chord5'), JSON.stringify(budget.perRole));
  assert.ok(plan.warnings.some(warning => warning.code === REDUCTION_WARNINGS.CHARACTER_BUDGET_EXCEEDED));
  // Budget pressure is reported, never spent: nothing is omitted for it.
  assert.equal(plan.accounting.omitted, 0);
  assert.equal(plan.accounting.total, baseline.events.filter(event => event.kind === 'note').length);
  assert.equal(plan.status, 'PASS');
});

// ─── Core3 ──────────────────────────────────────────────────────────────────

test('a complete Full6 cannot hide an absent Core3 Lead', () => {
  const baseline = baselineWithoutLead();
  const plan = planFinalReduction({ baseline, acceptedBy: 'test-reviewer' });
  assert.equal(plan.core3.after.status, 'FAIL');
  assert.equal(plan.status, 'PENDING');
  assert.ok(plan.blockers.some(blocker => blocker.code === REDUCTION_BLOCKERS.CORE3_INCOMPLETE));
  const result = applyFinalReduction({ baseline, decisions: [], expectedPlanId: plan.id, acceptedBy: 'test-reviewer' });
  assert.equal(result.didApply, false);
  assert.equal(result.candidate, null);
});

test('a reduction that empties Core3 is blocked, whatever the enrichment roles hold', () => {
  const baseline = sixRoleBaseline();
  const evidence = baseline.events.filter(event => event.role === 'Melody');
  const decisions = evidence.map(event => reductionDecision({
    id: `demote-${event.id}`,
    action: 'REDISTRIBUTE',
    eventIds: [event.id],
    fromRole: 'Melody',
    toRole: 'Chord5',
    reason: 'A demotion the Lead evidence supports on paper; Core3 is still left without a Lead.',
    leadEvidence: leadEvidenceFor(event),
  }));
  const plan = planFinalReduction({ baseline, decisions, acceptedBy: 'test-reviewer' });
  assert.equal(plan.status, 'PENDING');
  assert.ok(plan.blockers.some(blocker => [REDUCTION_BLOCKERS.CORE3_INCOMPLETE, REDUCTION_BLOCKERS.CORE3_REGRESSION].includes(blocker.code)), JSON.stringify(plan.blockers.map(b => b.code)));
});

// ─── Lead contract ──────────────────────────────────────────────────────────

test('moving material out of Melody without Lead evidence is refused by the shared gate', () => {
  const baseline = sixRoleBaseline();
  const decision = reductionDecision({
    id: 'demote-melody-1',
    action: 'REDISTRIBUTE',
    eventIds: ['melody-1'],
    fromRole: 'Melody',
    toRole: 'Chord1',
    reason: 'Attempted demotion with no Lead evidence record at all.',
  });
  const plan = planFinalReduction({ baseline, decisions: [decision], acceptedBy: 'test-reviewer' });
  assert.equal(plan.status, 'PENDING');
  const rejected = plan.blockers.filter(blocker => blocker.code === REDUCTION_BLOCKERS.DECISION_REJECTED);
  assert.ok(rejected.some(blocker => blocker.rejection === 'LEAD_DEMOTION_EVIDENCE_REQUIRED'), JSON.stringify(plan.blockers));
  const item = plan.items.find(entry => entry.baselineEventId === 'melody-1');
  assert.equal(item.leadImpact.affectsLead, true);
  assert.equal(item.leadImpact.kind, 'demotion');
  assert.equal(item.leadImpact.evidenceSupplied, false);
  assert.equal(item.leadImpact.resolvedBy, 'LEAD_GATE_NOT_SATISFIED');
});

test('moving material into Melody without Lead evidence is refused by the shared gate', () => {
  const baseline = sixRoleBaseline();
  const decision = reductionDecision({
    id: 'promote-chord1-1',
    action: 'REDISTRIBUTE',
    eventIds: ['chord1-1'],
    fromRole: 'Chord1',
    toRole: 'Melody',
    reason: 'Attempted promotion with no Lead evidence record at all.',
  });
  const plan = planFinalReduction({ baseline, decisions: [decision], acceptedBy: 'test-reviewer' });
  assert.ok(plan.blockers.some(blocker => blocker.rejection === 'LEAD_PROMOTION_EVIDENCE_REQUIRED'), JSON.stringify(plan.blockers));
  assert.equal(plan.items.find(item => item.baselineEventId === 'chord1-1').leadImpact.kind, 'promotion');
});

test('duplicating into Melody without Lead evidence is refused by the shared gate', () => {
  const baseline = sixRoleBaseline();
  const decision = reductionDecision({
    id: 'double-chord1-1',
    action: 'DUPLICATE',
    eventIds: ['chord1-1'],
    toRoles: ['Melody'],
    reason: 'Attempted duplication into the Lead role with no Lead evidence record.',
  });
  const plan = planFinalReduction({ baseline, decisions: [decision], acceptedBy: 'test-reviewer' });
  assert.ok(plan.blockers.some(blocker => blocker.rejection === 'LEAD_PROMOTION_EVIDENCE_REQUIRED'), JSON.stringify(plan.blockers));
  assert.equal(plan.items.find(item => item.baselineEventId === 'chord1-1').leadImpact.kind, 'duplication');
});

test('omitting Lead material without Lead evidence is refused by the shared gate', () => {
  const baseline = sixRoleBaseline();
  const decision = reductionDecision({
    id: 'drop-melody-2',
    action: 'OMIT',
    eventIds: ['melody-2'],
    fromRole: 'Melody',
    reason: 'Attempted removal of source-supported Lead material with no Lead evidence.',
  });
  const plan = planFinalReduction({ baseline, decisions: [decision], acceptedBy: 'test-reviewer' });
  assert.ok(plan.blockers.some(blocker => blocker.rejection === 'LEAD_DEMOTION_EVIDENCE_REQUIRED'), JSON.stringify(plan.blockers));
  assert.equal(plan.items.find(item => item.baselineEventId === 'melody-2').leadImpact.kind, 'removal');
});

test('an out-of-scope Lead citation is refused by the shared identity binding', () => {
  const baseline = sixRoleBaseline();
  const other = baseline.events.find(event => event.id === 'melody-3');
  const decision = reductionDecision({
    id: 'demote-melody-1',
    action: 'REDISTRIBUTE',
    eventIds: ['melody-1'],
    fromRole: 'Melody',
    toRole: 'Chord1',
    reason: 'A citation that describes another source event entirely.',
    leadEvidence: leadEvidenceFor(other),
  });
  const plan = planFinalReduction({ baseline, decisions: [decision], acceptedBy: 'test-reviewer' });
  assert.equal(plan.status, 'PENDING');
  assert.ok(plan.blockers.some(blocker => blocker.code === REDUCTION_BLOCKERS.DECISION_REJECTED));
});

// ─── omission ───────────────────────────────────────────────────────────────

test('an omission is event-level, evidence-backed, reviewer-accepted and traceable', () => {
  const baseline = baselineWithOverflowLane();
  assert.throws(() => normalizeReductionDecision({ id: 'x', action: 'OMIT', eventIds: ['overflow-1'], reason: 'No citation.' }), /requires at least one evidence reference/);
  const decision = reductionDecision({
    id: 'omit-overflow-1',
    action: 'OMIT',
    eventIds: ['overflow-1'],
    reason: 'A doubling of Chord4 the reviewer accepts removing for this delivery.',
    evidence: [`${FIXTURE_SOURCE_ID}#overflow/doubling`],
  });
  const { plan, result } = apply(baseline, [decision]);
  assert.equal(result.status, 'PASS');
  const item = plan.items.find(entry => entry.baselineEventId === 'overflow-1');
  assert.equal(item.outcome, REDUCTION_OUTCOMES.OMIT);
  assert.equal(item.reasonCode, REDUCTION_REASON_CODES.REVIEWER_ACCEPTED_OMISSION);
  assert.deepEqual(item.evidence, [`${FIXTURE_SOURCE_ID}#overflow/doubling`]);
  assert.equal(result.candidate.events.some(event => event.id === 'overflow-1'), false);
  // The omission stays on the record with its citation and its origin.
  const ledgerEntry = result.candidate.metadata.g12.ledger.find(entry => entry.baselineEventId === 'overflow-1');
  assert.equal(ledgerEntry.outcome, REDUCTION_OUTCOMES.OMIT);
  assert.deepEqual(ledgerEntry.sourceEventIds, [`${FIXTURE_SOURCE_ID}#overflow-1`]);
});

test('an omission the previous revision performed is recorded, not silently absent', () => {
  const baseline = baselineWithOverflowLane();
  const decision = reductionDecision({ id: 'omit-overflow-1', action: 'OMIT', eventIds: ['overflow-1'], reason: 'Accepted removal.', evidence: [`${FIXTURE_SOURCE_ID}#overflow/doubling`] });
  const { result } = apply(baseline, [decision]);
  const parent = result.roleApplication;
  const second = planFinalReduction({ baseline, candidate: result.candidate, parent, acceptedBy: 'test-reviewer' });
  const carried = second.items.find(item => item.baselineEventId === 'overflow-1');
  assert.equal(carried.outcome, REDUCTION_OUTCOMES.OMIT);
  assert.equal(carried.reasonCode, REDUCTION_REASON_CODES.OMITTED_BEFORE_REDUCTION);
  assert.equal(carried.upstreamOmissionVerified, null);
  assert.ok(second.warnings.some(warning => warning.code === REDUCTION_WARNINGS.UPSTREAM_OMISSION_NOT_VERIFIED));
  // With the lineage record supplied, the omission is verified rather than assumed.
  const verified = planFinalReduction({ baseline, candidate: result.candidate, parent, parentOmittedEventIds: ['overflow-1'], acceptedBy: 'test-reviewer' });
  assert.equal(verified.items.find(item => item.baselineEventId === 'overflow-1').upstreamOmissionVerified, true);
  assert.equal(verified.warnings.some(warning => warning.code === REDUCTION_WARNINGS.UPSTREAM_OMISSION_NOT_VERIFIED), false);
  // An event missing from both the candidate and the lineage record is a blocker.
  const unaccounted = planFinalReduction({ baseline, candidate: result.candidate, parent, parentOmittedEventIds: [], acceptedBy: 'test-reviewer' });
  assert.ok(unaccounted.blockers.some(blocker => blocker.code === REDUCTION_BLOCKERS.EVENT_UNACCOUNTED && blocker.baselineEventId === 'overflow-1'));
});

// ─── percussion ─────────────────────────────────────────────────────────────

test('GM drum material stays explicitly pending and is never given a pitched role', () => {
  const baseline = baselineWithPercussion();
  const plan = planFinalReduction({ baseline, acceptedBy: 'test-reviewer' });
  const drums = plan.items.filter(item => item.percussion);
  assert.equal(drums.length, 2);
  for (const drum of drums) {
    assert.equal(drum.outcome, REDUCTION_OUTCOMES.PENDING);
    assert.equal(drum.reasonCode, REDUCTION_REASON_CODES.PERCUSSION_DRUM_FACE_MAPPING_REQUIRED);
    assert.equal(drum.proposedRole, null);
  }
  assert.ok(plan.warnings.some(warning => warning.code === REDUCTION_WARNINGS.PERCUSSION_RETAINED));
  const assign = reductionDecision({ id: 'drum-into-chord5', action: 'REDISTRIBUTE', eventIds: ['drum-1'], toRole: 'Chord5', reason: 'Attempt to complete six tracks with an unmapped drum face.' });
  const refused = planFinalReduction({ baseline, decisions: [assign], acceptedBy: 'test-reviewer' });
  assert.ok(refused.blockers.some(blocker => blocker.code === REDUCTION_BLOCKERS.PERCUSSION_ROLE_ASSIGNMENT_REFUSED));
});

test('drum material already leaked into a pitched role blocks', () => {
  const plan = planFinalReduction({ baseline: baselineWithPercussion({ role: 'Chord4' }), acceptedBy: 'test-reviewer' });
  assert.ok(plan.blockers.some(blocker => blocker.code === REDUCTION_BLOCKERS.PERCUSSION_IN_PITCHED_ROLE));
});

// ─── harmony ────────────────────────────────────────────────────────────────

test('a newly introduced overlap risk blocks while the pre-existing one stays visible', () => {
  const source = sixRoleBaseline();
  // Chord4 a semitone from Chord3, both unassigned-free: moving Chord4 into
  // Chord3's register is what creates the new m2, not the source.
  const baseline = createCanonicalProject({
    ...source,
    events: source.events.map(event => event.role === 'Chord4' ? createCanonicalNoteEvent({ ...event, pitch: 61 }) : event),
  });
  const before = planFinalReduction({ baseline, acceptedBy: 'test-reviewer' });
  assert.equal(before.status, 'PASS');
  assert.ok(before.overlapRisks.before.some(risk => risk.intervalName === 'm2'));
  assert.ok(before.warnings.some(warning => warning.code === REDUCTION_WARNINGS.EXISTING_OVERLAP_RISKS));
  // Duplicating Chord2 into Chord5's slot at the same pitch introduces a new
  // same-pitch overlap that was not in the input.
  const duplicate = reductionDecision({ id: 'double-chord2', action: 'DUPLICATE', eventIds: ['chord2-1'], toRoles: ['Chord3'], reason: 'A doubling that introduces a new same-pitch overlap.' });
  const after = planFinalReduction({ baseline, decisions: [duplicate], acceptedBy: 'test-reviewer' });
  assert.ok(after.overlapRisks.introduced.length, JSON.stringify(after.overlapRisks.introduced));
  assert.ok(after.blockers.some(blocker => blocker.code === REDUCTION_BLOCKERS.NEW_OVERLAP_RISK));
  assert.equal(after.status, 'PENDING');
});

test('the planner never deletes notes to make a conflict metric smaller', () => {
  const source = sixRoleBaseline();
  const baseline = createCanonicalProject({
    ...source,
    events: source.events.map(event => event.role === 'Chord4' ? createCanonicalNoteEvent({ ...event, pitch: 61 }) : event),
  });
  const plan = planFinalReduction({ baseline, acceptedBy: 'test-reviewer' });
  assert.ok(plan.overlapRisks.before.length);
  assert.equal(plan.accounting.omitted, 0);
  assert.equal(plan.accounting.retained, baseline.events.filter(event => event.kind === 'note').length);
});

// ─── the instrument profile is inert ────────────────────────────────────────

const fixtureProfile = {
  schema: INSTRUMENT_PROFILE_SCHEMA,
  instrumentId: 'fixture:lute',
  targetClient: 'unverified simulation pack',
  evidence: ['fixture:sound-pack/regions'],
  verificationStatus: 'UNVERIFIED',
  pitch: { testedRange: [48, 84], usableRange: [55, 79], weakRegions: [[48, 54]] },
  dynamics: { volumeResponse: null },
  timbre: { attack: 'fast', sustain: 'short', decay: 'medium' },
};

test('an instrument profile changes no outcome, no blocker and not the plan identity', () => {
  const baseline = baselineWithUnassignedRole();
  const without = planFinalReduction({ baseline, decisions: [placeChord5], acceptedBy: 'test-reviewer' });
  const withProfile = planFinalReduction({ baseline, decisions: [placeChord5], acceptedBy: 'test-reviewer', instrumentProfile: fixtureProfile });
  assert.equal(without.id, withProfile.id);
  assert.equal(without.status, withProfile.status);
  assert.deepEqual(without.items, withProfile.items);
  assert.deepEqual(without.blockers, withProfile.blockers);
  assert.deepEqual(without.accounting, withProfile.accounting);
  assert.equal(without.timbre, null);
  assert.equal(withProfile.timbre.influencedOutcomes, false);
  assert.ok(withProfile.warnings.some(warning => warning.code === REDUCTION_WARNINGS.TIMBRE_DIAGNOSTIC_ONLY));
  // Even a VERIFIED claim buys nothing at this stage.
  const claimed = planFinalReduction({ baseline, decisions: [placeChord5], acceptedBy: 'test-reviewer', instrumentProfile: { ...fixtureProfile, verificationStatus: 'VERIFIED' } });
  assert.equal(claimed.id, without.id);
  assert.deepEqual(claimed.items, without.items);
});

test('the instrument profile is optional and normalized, never trusted', () => {
  const profile = normalizeInstrumentProfile(fixtureProfile);
  assert.equal(profile.authority, 'DIAGNOSTIC_ONLY');
  assert.throws(() => normalizeInstrumentProfile({ ...fixtureProfile, schema: 'other' }), /unsupported instrument profile schema/);
  assert.throws(() => normalizeInstrumentProfile({ ...fixtureProfile, verificationStatus: 'TRUSTED' }), /UNVERIFIED, PARTIAL or VERIFIED/);
  assert.equal(FINAL_REDUCTION_STATUS.instrumentProfileInfluencesOutcomes, false);
  assert.equal(FINAL_REDUCTION_STATUS.timbreAwareReduction, false);
  assert.deepEqual(FINAL_REDUCTION_STATUS.certifiesGates, []);
});

// ─── no register / volume / timing edits ────────────────────────────────────

test('reduction changes role only: pitch, onset, duration and volume are untouched', () => {
  const baseline = baselineWithUnassignedRole();
  const { result } = apply(baseline, [placeChord5]);
  const before = new Map(baseline.events.map(event => [event.id, event]));
  for (const event of result.candidate.events) {
    const origin = before.get(event.metadata?.g11d?.derivedFromEventId ?? event.id);
    assert.ok(origin, event.id);
    assert.equal(event.kind, origin.kind);
    if (event.kind !== 'note') continue;
    assert.equal(event.pitch, origin.pitch);
    assert.equal(event.start, origin.start);
    assert.equal(event.end, origin.end);
    assert.equal(event.volume ?? null, origin.volume ?? null);
    assert.deepEqual(event.sourceIds, origin.sourceIds);
    assert.deepEqual(event.sourceEventIds, origin.sourceEventIds);
  }
  assert.equal(FINAL_REDUCTION_STATUS.registerAdaptation, false);
  assert.equal(FINAL_REDUCTION_STATUS.volumeAdaptation, false);
  assert.equal(FINAL_REDUCTION_STATUS.timingEdits, false);
  // A register or prominence field cannot ride into this stage at all.
  assert.throws(() => normalizeReductionDecision({ id: 'x', action: 'REDISTRIBUTE', eventIds: ['a'], toRole: 'Chord5', reason: 'r', evidence: ['e'], pitch: 60 }), /unsupported/);
});

test('the reduction candidate still emits Final MML', () => {
  const baseline = baselineWithUnassignedRole();
  const { result } = apply(baseline, [placeChord5]);
  const emitted = emitFinalMml(result.candidate);
  assert.equal(emitted.status, 'PASS', JSON.stringify(emitted.diagnostics));
});

// ─── the application target ─────────────────────────────────────────────────

test('a candidate with no verifiable derivation from the baseline is refused, not reduced against the baseline', () => {
  const baseline = baselineWithUnassignedRole();
  // A candidate that is not the baseline and carries no revision: applying a
  // decision would land it on the baseline and throw away the candidate's own
  // roles, so the plan refuses instead.
  const candidate = createCanonicalProject({
    ...baseline,
    events: baseline.events.map(event => event.role === 'Chord4' ? createCanonicalNoteEvent({ ...event, role: 'Chord3' }) : event),
  });
  const plan = planFinalReduction({ baseline, candidate, acceptedBy: 'test-reviewer' });
  assert.equal(plan.status, 'PENDING');
  assert.ok(plan.blockers.some(blocker => blocker.code === REDUCTION_BLOCKERS.CANDIDATE_NOT_THE_APPLICATION_TARGET));
  const result = applyFinalReduction({ baseline, candidate, decisions: [placeChord5], expectedPlanId: planFinalReduction({ baseline, candidate, decisions: [placeChord5], acceptedBy: 'test-reviewer' }).id, acceptedBy: 'test-reviewer' });
  assert.equal(result.didApply, false);
  assert.equal(result.candidate, null);
});

test('a derived candidate carries the parent the reduction applies onto, and a forged one does not', () => {
  const baseline = baselineWithUnassignedRole();
  const { result } = apply(baseline, [placeChord5]);
  // Handed back without its stored application wrapper, the reduction candidate
  // still resolves its own parent from the provenance it carries.
  const second = planFinalReduction({ baseline, candidate: result.candidate, acceptedBy: 'test-reviewer' });
  assert.equal(second.status, 'PASS');
  assert.equal(second.parentRevisionId, result.revision.id);
  assert.equal(second.accounting.pending, 0);
  assert.equal(second.accounting.retained, 18);
  // A candidate whose events were edited after the revision was minted no
  // longer agrees with it, so no parent is recovered and the plan refuses.
  const forged = createCanonicalProject({
    ...result.candidate,
    events: result.candidate.events.map(event => event.id === 'chord3-1' ? createCanonicalNoteEvent({ ...event, role: 'Chord4' }) : event),
  });
  const refused = planFinalReduction({ baseline, candidate: forged, acceptedBy: 'test-reviewer' });
  assert.equal(refused.status, 'PENDING');
  assert.ok(refused.blockers.some(blocker => [REDUCTION_BLOCKERS.PARENT_INTEGRITY_MISMATCH, REDUCTION_BLOCKERS.CANDIDATE_NOT_THE_APPLICATION_TARGET].includes(blocker.code)));
});
