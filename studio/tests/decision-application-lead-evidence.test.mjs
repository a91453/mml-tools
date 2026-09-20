import test from 'node:test';
import assert from 'node:assert/strict';
import {
  applyAcceptedArrangement,
  leadEvidenceIdentityBlockers,
  LEAD_EVIDENCE_IDENTITY_MISMATCH,
  LEAD_EVIDENCE_PROVENANCE_PAIR_AMBIGUOUS,
  DECISION_REJECTION,
} from '../backend/arrangement/decision-application.mjs';
import { leadDemotionReportsFromApplication, leadPromotionReportsFromApplication, reviewAppliedCandidate } from '../backend/arrangement/decision-review.mjs';
import { suggestRoleCandidates } from '../backend/arrangement/role-candidates.mjs';
import {
  roleDeclaredBaseline,
  acceptanceFor,
  leadDemotionEvidence,
  leadPromotionEvidence,
  CANONICAL_IDENTITY,
  SOURCE_ID,
  SECOND_SOURCE_ID,
} from './fixtures/g11d-fixtures.mjs';

// Lead evidence must describe the event it is attached to.
//
// External review P1. `evaluateLeadDemotion()` asks only that a source identity
// be *present*, and the promotion interlock asked the same, so evidence gathered
// about event B satisfied a gate asked about event A -- and the report that came
// back carried A's id, which is the key the readiness Lead gate matches on. A
// citation about one event could therefore be re-packaged as another event's
// Lead PASS.
//
// SOURCE_POLICY.md §4 lists source identity as the first thing a Lead move must
// inspect. These regressions are what "inspect" means: the citation has to be in
// scope for the event being moved.

const baseline = roleDeclaredBaseline();
const suggestion = suggestRoleCandidates(baseline);
const accept = () => acceptanceFor(baseline, { suggestion });

const apply = (decisions, extra = {}) => applyAcceptedArrangement({
  baseline, suggestion, decisions, canonicalIdentity: CANONICAL_IDENTITY, ...extra,
});

const demote = (id, eventIds, overrides = {}) => ({
  id, type: 'MOVE_ROLE', target: { eventIds }, fromRole: 'Melody', toRole: 'Chord3',
  reason: 'Reviewed: inner-staff doubling, not the lead.',
  evidence: ['fixture:score inner staff'],
  acceptance: accept(),
  ...overrides,
});

const promote = (id, eventIds, overrides = {}) => ({
  id, type: 'ASSIGN_ROLE', target: { eventIds }, toRole: 'Melody',
  reason: 'Reviewed: this material carries the lead here.',
  evidence: ['fixture:score top staff'],
  acceptance: accept(),
  ...overrides,
});

const sourceEventIdOf = eventId => `${SOURCE_ID}#${eventId}`;
const blockersOf = (result, code) => result.rejected
  .find(item => item.code === code)?.events.flatMap(item => [...item.blockers]) ?? [];

// ─── A. correct identity does not block ─────────────────────────────────────

test('A: a citation naming the target event passes the identity binding', () => {
  const result = apply([demote('a1', ['lead-1'], {
    leadEvidence: leadDemotionEvidence({ sourceEventId: sourceEventIdOf('lead-1') }),
  })]);
  assert.equal(result.status, 'PASS', 'identity binding must not block correct evidence');
  assert.equal(result.candidate.events.find(event => event.id === 'lead-1').role, 'Chord3');

  // The binding is a scope check, not a verdict: weak evidence naming the right
  // event still fails the existing gate, on the existing blockers.
  const weak = apply([demote('a2', ['lead-1'], {
    leadEvidence: leadDemotionEvidence({ sourceEventId: sourceEventIdOf('lead-1'), scoreClassification: 'unknown', audioClassification: 'unknown' }),
  })]);
  assert.equal(weak.status, 'PENDING');
  const blockers = blockersOf(weak, DECISION_REJECTION.LEAD_DEMOTION_EVIDENCE_REQUIRED);
  assert.ok(blockers.includes('POSITIVE_ROLE_EVIDENCE_MISSING'));
  assert.equal(blockers.includes(LEAD_EVIDENCE_IDENTITY_MISMATCH), false, 'a correct citation is never reported as out of scope');
});

// ─── B / C. another event's evidence ────────────────────────────────────────

test('B: demoting event A with event B\'s evidence is refused', () => {
  const result = apply([demote('b1', ['lead-3'], {
    leadEvidence: leadDemotionEvidence({ sourceEventId: sourceEventIdOf('lead-1') }),
  })]);
  assert.equal(result.status, 'PENDING');
  assert.equal(result.candidate, null, 'nothing is applied');
  assert.deepEqual(blockersOf(result, DECISION_REJECTION.LEAD_DEMOTION_EVIDENCE_REQUIRED), [LEAD_EVIDENCE_IDENTITY_MISMATCH]);
  assert.equal(result.immutability.baselineUnchanged, true);
});

test('C: same source, wrong source event is still refused', () => {
  // lead-1 and lead-3 are both from fixture:symbolic, so the sourceId agrees.
  const evidence = leadDemotionEvidence({ sourceEventId: sourceEventIdOf('lead-1') });
  assert.equal(evidence.sourceIdentity.sourceId, SOURCE_ID);
  const target = baseline.events.find(event => event.id === 'lead-3');
  assert.ok(target.sourceIds.includes(SOURCE_ID), 'the fixture must really share a sourceId');

  assert.deepEqual(leadEvidenceIdentityBlockers(evidence, target), [LEAD_EVIDENCE_IDENTITY_MISMATCH]);
  assert.equal(apply([demote('c1', ['lead-3'], { leadEvidence: evidence })]).status, 'PENDING');
});

test('D: the right source event under the wrong source is refused', () => {
  const crossBaseline = roleDeclaredBaseline({ extraSource: true });
  const target = crossBaseline.events.find(event => event.id === 'alt-1');
  const evidence = {
    ...leadPromotionEvidence(),
    // The source event id really is this event's; the source id is not.
    sourceIdentity: { sourceId: SOURCE_ID, sourceEventId: `${SECOND_SOURCE_ID}#alt-1` },
  };
  assert.ok(target.sourceEventIds.includes(`${SECOND_SOURCE_ID}#alt-1`));
  assert.equal(target.sourceIds.includes(SOURCE_ID), false);
  assert.deepEqual(leadEvidenceIdentityBlockers(evidence, target), [LEAD_EVIDENCE_IDENTITY_MISMATCH]);
});

test('E: a missing source event id is reported as a missing identity, not a mismatch', () => {
  const target = baseline.events.find(event => event.id === 'lead-1');
  for (const identity of [undefined, null, {}, { sourceId: SOURCE_ID }, { sourceId: SOURCE_ID, sourceEventId: '  ' }, { sourceEventId: sourceEventIdOf('lead-1') }]) {
    assert.deepEqual(
      leadEvidenceIdentityBlockers({ ...leadDemotionEvidence(), sourceIdentity: identity }, target),
      ['SOURCE_IDENTITY_MISSING'],
      `identity ${JSON.stringify(identity)} must read as missing`,
    );
  }
  assert.deepEqual(leadEvidenceIdentityBlockers(null, target), ['LEAD_EVIDENCE_MISSING']);
});

test('an arbitrary non-empty identifier is not an identity', () => {
  const target = baseline.events.find(event => event.id === 'lead-1');
  for (const identity of [
    { sourceId: 'anything', sourceEventId: 'anything' },
    { sourceId: SOURCE_ID, sourceEventId: 'lead-1' },          // the event id, not the source event id
    { sourceId: SOURCE_ID, sourceEventId: sourceEventIdOf('lead-1').toUpperCase() },
  ]) {
    assert.deepEqual(
      leadEvidenceIdentityBlockers({ ...leadDemotionEvidence(), sourceIdentity: identity }, target),
      [LEAD_EVIDENCE_IDENTITY_MISMATCH],
      `identity ${JSON.stringify(identity)} must not bind`,
    );
  }
});

// ─── membership, not equality ───────────────────────────────────────────────

test('multi-source provenance cannot prove a (sourceId, sourceEventId) pair and fails closed', () => {
  // The IR carries sourceIds and sourceEventIds as two independent arrays. With
  // two sources, nothing says which source event belongs to which source, and a
  // source event id is source-local, so it is not globally unique either.
  const multi = roleDeclaredBaseline({ multiProvenance: true });
  const target = multi.events.find(event => event.id === 'multi-1');
  assert.equal(target.sourceIds.length, 2);
  assert.equal(target.sourceEventIds.length, 2);

  for (const [label, sourceId, sourceEventId] of [
    // Cross-paired: both values are present in their arrays, and that proves
    // nothing about the pair. This used to bind; it must not.
    ['cross-paired', SOURCE_ID, `${SECOND_SOURCE_ID}#multi-1`],
    // Apparently correct pairs. The program cannot tell these from the
    // cross-paired one, so it must not guess in their favour either.
    ['apparently correct A/a', SOURCE_ID, `${SOURCE_ID}#multi-1`],
    ['apparently correct B/b', SECOND_SOURCE_ID, `${SECOND_SOURCE_ID}#multi-1`],
    // A citation naming neither.
    ['foreign', SOURCE_ID, sourceEventIdOf('lead-1')],
  ]) {
    assert.deepEqual(
      leadEvidenceIdentityBlockers({ ...leadPromotionEvidence(), sourceIdentity: { sourceId, sourceEventId } }, target),
      [LEAD_EVIDENCE_PROVENANCE_PAIR_AMBIGUOUS],
      `${label} must fail closed on pairing ambiguity`,
    );
  }
});

test('a multi-source Lead decision is PENDING, never silently applied', () => {
  const multi = roleDeclaredBaseline({ multiProvenance: true });
  const multiSuggestion = suggestRoleCandidates(multi);
  const result = applyAcceptedArrangement({
    baseline: multi, suggestion: multiSuggestion, canonicalIdentity: CANONICAL_IDENTITY,
    decisions: [{
      id: 'p1', type: 'MOVE_ROLE', target: { eventIds: ['multi-1'] }, fromRole: 'Chord3', toRole: 'Melody',
      reason: 'Reviewed: this doubled line leads the phrase.', evidence: ['fixture:score'],
      leadEvidence: leadPromotionEvidence({ sourceEventId: `${SOURCE_ID}#multi-1` }),
      acceptance: acceptanceFor(multi, { suggestion: multiSuggestion }),
    }],
  });
  assert.equal(result.status, 'PENDING');
  assert.equal(result.candidate, null);
  assert.deepEqual(blockersOf(result, DECISION_REJECTION.LEAD_PROMOTION_EVIDENCE_REQUIRED), [LEAD_EVIDENCE_PROVENANCE_PAIR_AMBIGUOUS]);
  assert.equal(result.diagnostics.some(item => /PAIR_AMBIGUOUS/.test(item.code)), false, 'the ambiguity is a blocker, not a diagnostic');
});

test('the downstream report builder carries the ambiguity as PENDING, never PASS', async () => {
  // A baseline in which the multi-source event already is the Lead, so an
  // honest application exists against it and a report about multi-1 would not
  // be N/A. The per-entry check is what is under test, so the honest
  // application (lead-1 demoted) is kept and its `applied` entry is swapped to
  // claim multi-1 was demoted with an apparently correct citation.
  const { createCanonicalProject } = await import('../backend/canonical/index.mjs');
  const multi = roleDeclaredBaseline({ multiProvenance: true });
  const multiLead = createCanonicalProject({
    ...multi,
    events: multi.events.map(event => (event.id === 'multi-1' ? { ...event, role: 'Melody' } : event)),
  });
  const multiSuggestion = suggestRoleCandidates(multiLead);
  const clean = applyAcceptedArrangement({
    baseline: multiLead, suggestion: multiSuggestion, canonicalIdentity: CANONICAL_IDENTITY,
    decisions: [demote('l1', ['lead-1'], {
      leadEvidence: leadDemotionEvidence({ sourceEventId: sourceEventIdOf('lead-1') }),
      acceptance: acceptanceFor(multiLead, { suggestion: multiSuggestion }),
    })],
  });
  assert.equal(clean.status, 'PASS');
  const forged = {
    ...clean,
    applied: clean.applied.map(entry => ({
      ...entry,
      leadEvidence: { ...leadDemotionEvidence(), sourceIdentity: { sourceId: SOURCE_ID, sourceEventId: `${SOURCE_ID}#multi-1` } },
      events: [{ eventId: 'multi-1', fromRole: 'Melody', toRole: 'Chord3', outputEventIds: ['multi-1'] }],
    })),
  };
  const reports = leadDemotionReportsFromApplication(forged, multiLead);
  assert.equal(reports.length, 1);
  assert.equal(reports[0].eventId, 'multi-1');
  assert.equal(reports[0].status, 'PENDING');
  assert.deepEqual([...reports[0].blockers], [LEAD_EVIDENCE_PROVENANCE_PAIR_AMBIGUOUS], 'the ambiguity is carried as itself, not relabelled');

  // And readiness never sees a Lead PASS for it.
  const review = reviewAppliedCandidate({ application: forged, baseline: multiLead, leadDemotionReports: reports });
  assert.equal(review.readiness.gates.leadDemotion.status, 'PENDING');
});

test('an event stating no source-event identity cannot carry Lead evidence', () => {
  assert.deepEqual(
    leadEvidenceIdentityBlockers(leadDemotionEvidence(), { id: 'x', sourceIds: [SOURCE_ID], sourceEventIds: [] }),
    ['TARGET_EVENT_SOURCE_EVENT_IDS_MISSING'],
  );
  assert.deepEqual(
    leadEvidenceIdentityBlockers(leadDemotionEvidence(), { id: 'x', sourceIds: [], sourceEventIds: [] }),
    ['TARGET_EVENT_SOURCE_IDS_MISSING', 'TARGET_EVENT_SOURCE_EVENT_IDS_MISSING'],
  );
});

// ─── F / G. promotion and duplication ───────────────────────────────────────

test('a role-less multi-event Melody assignment may materialize a review-pending candidate without Lead evidence', () => {
  const result = apply([promote('preview-roleless', ['tex-1', 'tex-2'])]);
  assert.equal(result.status, 'PASS');
  assert.ok(result.candidate, 'a reversible candidate is available for audition/review');
  assert.equal(result.candidate.events.find(event => event.id === 'tex-1').role, 'Melody');
  assert.equal(result.candidate.events.find(event => event.id === 'tex-2').role, 'Melody');
  assert.equal(result.applied[0].leadEvidence, null);

  const diagnostic = result.diagnostics.find(item => item.code === 'ROLELESS_LEAD_ASSIGNMENT_REVIEW_PENDING');
  assert.ok(diagnostic, 'the application must state that Lead review is still missing');
  assert.deepEqual([...diagnostic.eventIds], ['tex-1', 'tex-2']);
  assert.equal(diagnostic.blocker, 'LEAD_PROMOTION_EVIDENCE_MISSING');

  const reports = leadPromotionReportsFromApplication(result, baseline);
  assert.equal(reports.length, 2);
  assert.deepEqual(reports.map(report => report.eventId).sort(), ['tex-1', 'tex-2']);
  assert.ok(reports.every(report => report.status === 'PENDING'), 'candidate materialization must not manufacture a Lead PASS');
});

test('a role move into Melody still requires positive Lead evidence before a candidate exists', () => {
  const result = apply([{
    ...promote('preview-move-still-blocked', ['harm-1']),
    type: 'MOVE_ROLE',
    fromRole: 'Chord1',
  }]);
  assert.equal(result.status, 'PENDING');
  assert.equal(result.candidate, null);
  assert.deepEqual(blockersOf(result, DECISION_REJECTION.LEAD_PROMOTION_EVIDENCE_REQUIRED), ['LEAD_PROMOTION_EVIDENCE_MISSING']);
});

test('F: promoting event A into Melody with event B\'s evidence is refused', () => {
  for (const [id, eventId] of [['f1', 'tex-1'], ['f2', 'harm-1']]) {
    const decision = eventId === 'harm-1'
      ? { ...promote(id, [eventId]), type: 'MOVE_ROLE', fromRole: 'Chord1' }
      : promote(id, [eventId]);
    const result = apply([{ ...decision, leadEvidence: leadPromotionEvidence({ sourceEventId: sourceEventIdOf('lead-1') }) }]);
    assert.equal(result.status, 'PENDING', `${eventId} -> Melody with foreign evidence must not apply`);
    assert.equal(result.candidate, null);
    assert.deepEqual(blockersOf(result, DECISION_REJECTION.LEAD_PROMOTION_EVIDENCE_REQUIRED), [LEAD_EVIDENCE_IDENTITY_MISMATCH]);
  }

  // The same promotion with its own citation is allowed through the binding.
  const correct = apply([promote('f3', ['tex-1'], {
    leadEvidence: leadPromotionEvidence({ sourceEventId: sourceEventIdOf('tex-1') }),
  })]);
  assert.equal(correct.status, 'PASS');
});

test('G: duplicating into Melody with foreign evidence is refused', () => {
  const duplicate = (id, overrides) => ({
    id, type: 'DUPLICATE_WITH_JUSTIFICATION', target: { eventIds: ['harm-1'] }, toRoles: ['Melody'],
    reason: 'Reviewed: the harmony also carries the lead here.',
    evidence: ['fixture:score bar 1'],
    acceptance: accept(),
    ...overrides,
  });
  const foreign = apply([duplicate('g1', { leadEvidence: leadPromotionEvidence({ sourceEventId: sourceEventIdOf('lead-1') }) })]);
  assert.equal(foreign.status, 'PENDING');
  assert.deepEqual(blockersOf(foreign, DECISION_REJECTION.LEAD_PROMOTION_EVIDENCE_REQUIRED), [LEAD_EVIDENCE_IDENTITY_MISMATCH]);

  const correct = apply([duplicate('g2', { leadEvidence: leadPromotionEvidence({ sourceEventId: sourceEventIdOf('harm-1') }) })]);
  assert.equal(correct.status, 'PASS');
});

test('a derived duplicate binds to its origin provenance, never to its own event id', () => {
  const first = apply([{
    id: 'd1', type: 'DUPLICATE_WITH_JUSTIFICATION', target: { eventIds: ['harm-1'] }, toRoles: ['Chord3'],
    reason: 'Reviewed: doubled for enrichment.', evidence: ['fixture:score'], acceptance: accept(),
  }]);
  assert.equal(first.status, 'PASS');
  const derived = first.candidate.events.find(event => event.metadata?.g11d?.derivedFromEventId === 'harm-1');
  assert.ok(derived);

  const promoteDerived = (id, sourceEventId) => applyAcceptedArrangement({
    baseline, suggestion, canonicalIdentity: CANONICAL_IDENTITY,
    parent: { revision: first.revision, candidate: first.candidate },
    decisions: [{
      id, type: 'MOVE_ROLE', target: { eventIds: [derived.id] }, fromRole: 'Chord3', toRole: 'Melody',
      reason: 'Reviewed: the doubled line leads this phrase.',
      evidence: ['fixture:score'],
      leadEvidence: leadPromotionEvidence({ sourceEventId }),
      acceptance: { ...accept(), reviewedRevisionId: first.revision.id },
    }],
  });

  // The derived event id is a different namespace and is not a source event id.
  const asEventId = promoteDerived('n1', derived.id);
  assert.equal(asEventId.status, 'PENDING');
  assert.deepEqual(blockersOf(asEventId, DECISION_REJECTION.LEAD_PROMOTION_EVIDENCE_REQUIRED), [LEAD_EVIDENCE_IDENTITY_MISMATCH]);

  // Its origin's source-event identity is the provenance it actually carries.
  const asOrigin = promoteDerived('n2', sourceEventIdOf('harm-1'));
  assert.equal(asOrigin.status, 'PASS');
  assert.deepEqual([...derived.sourceEventIds], [...baseline.events.find(event => event.id === 'harm-1').sourceEventIds]);
});

// ─── H / I / J / K. multi-event containment ─────────────────────────────────

const multiEventCases = [
  {
    name: 'H: a Melody demotion targeting two events',
    decision: demote('h1', ['lead-1', 'lead-2'], { leadEvidence: leadDemotionEvidence({ sourceEventId: sourceEventIdOf('lead-1') }) }),
  },
  {
    name: 'I: a Melody omission targeting two events',
    decision: {
      id: 'i1', type: 'OMIT_FROM_SIX', target: { eventIds: ['lead-1', 'lead-2'] }, fromRole: 'Melody',
      reason: 'Reviewed: dropped from the six roles.', evidence: ['fixture:score'],
      leadEvidence: leadDemotionEvidence({ sourceEventId: sourceEventIdOf('lead-1') }),
      acceptance: accept(),
    },
  },
  {
    name: 'J: a promotion into Melody targeting two events',
    decision: promote('j1', ['tex-1', 'tex-2'], { leadEvidence: leadPromotionEvidence({ sourceEventId: sourceEventIdOf('tex-1') }) }),
  },
  {
    name: 'K: a lane-targeted Melody demotion covering four Lead events',
    decision: {
      id: 'k1', type: 'MOVE_ROLE', target: { laneId: 'lane:lead#0' }, fromRole: 'Melody', toRole: 'Chord3',
      reason: 'Reviewed: the whole lane is inner material.', evidence: ['fixture:score'],
      leadEvidence: leadDemotionEvidence({ sourceEventId: sourceEventIdOf('lead-1') }),
      acceptance: accept(),
    },
  },
];

for (const scenario of multiEventCases) {
  test(`${scenario.name} is refused rather than bound to one of them`, () => {
    const result = apply([scenario.decision]);
    assert.equal(result.status, 'UNSUPPORTED');
    assert.equal(result.candidate, null, 'nothing is applied');
    const rejection = result.rejected.find(item => item.code === DECISION_REJECTION.LEAD_EVIDENCE_MULTI_EVENT_SCOPE_UNSUPPORTED);
    assert.ok(rejection, `expected multi-event containment, got ${result.rejected.map(item => item.code).join(', ')}`);
    assert.ok(rejection.targetEventIds.length > 1);
    assert.ok(rejection.leadAffectingEventIds.length > 1);
    // Not resolved by taking the first event, and not silently split.
    assert.deepEqual([...result.applied], []);
    assert.deepEqual([...result.trace], []);
  });
}

test('a lane naming exactly one Lead event is still allowed', () => {
  // Containment is about how many events the decision resolved to, not about
  // whether a lane was used to name them.
  const single = apply([{
    id: 'k2', type: 'MOVE_ROLE', target: { laneId: 'lane:lead#0' }, fromRole: 'Melody', toRole: 'Chord3',
    section: { start: '0', end: '1' },
    reason: 'Reviewed: only the first beat is inner material.',
    evidence: ['fixture:score bar 1'],
    leadEvidence: leadDemotionEvidence({ sourceEventId: sourceEventIdOf('lead-1') }),
    acceptance: accept(),
  }]);
  assert.equal(single.status, 'PASS');
  assert.equal(single.candidate.events.find(event => event.id === 'lead-1').role, 'Chord3');
  assert.equal(single.candidate.events.find(event => event.id === 'lead-2').role, 'Melody');
});

test('a multi-event decision that touches no Lead event is unaffected', () => {
  const result = apply([{
    id: 'm1', type: 'ASSIGN_ROLE', target: { eventIds: ['tex-1', 'tex-2'] }, toRole: 'Chord3',
    reason: 'Reviewed: texture accepted as enrichment.', evidence: ['fixture:score'], acceptance: accept(),
  }]);
  assert.equal(result.status, 'PASS', 'containment applies to Lead-affecting decisions only');
});

// ─── L. downstream defence in depth ─────────────────────────────────────────

test('L: a forged application cannot produce a Lead PASS for the wrong event', () => {
  const clean = apply([demote('l1', ['lead-1'], {
    leadEvidence: leadDemotionEvidence({ sourceEventId: sourceEventIdOf('lead-1') }),
  })]);
  assert.equal(clean.status, 'PASS');
  assert.equal(leadDemotionReportsFromApplication(clean, baseline)[0].status, 'PASS');

  // The application object is data. A restored, hand-built or tampered one can
  // claim PASS while carrying a citation about a different event.
  const forged = {
    ...clean,
    applied: clean.applied.map(entry => ({ ...entry, leadEvidence: leadDemotionEvidence({ sourceEventId: sourceEventIdOf('lead-4') }) })),
  };
  const reports = leadDemotionReportsFromApplication(forged, baseline);
  assert.equal(reports.length, 1);
  assert.equal(reports[0].eventId, 'lead-1');
  assert.equal(reports[0].status, 'PENDING', 'foreign evidence must never be re-packaged as this event\'s PASS');
  assert.ok(reports[0].blockers.includes(LEAD_EVIDENCE_IDENTITY_MISMATCH));

  // A forged multi-event entry is not bound to its first event either.
  const forgedMulti = {
    ...clean,
    applied: clean.applied.map(entry => ({
      ...entry,
      events: [...entry.events, { eventId: 'lead-2', fromRole: 'Melody', toRole: 'Chord3', outputEventIds: ['lead-2'] }],
    })),
  };
  const multiReports = leadDemotionReportsFromApplication(forgedMulti, baseline);
  assert.equal(multiReports.length, 2);
  for (const report of multiReports) {
    assert.equal(report.status, 'PENDING');
    assert.ok(report.blockers.includes(DECISION_REJECTION.LEAD_EVIDENCE_MULTI_EVENT_SCOPE_UNSUPPORTED));
  }
});

// ─── M. readiness end to end ────────────────────────────────────────────────

test('M: no layer lets foreign evidence reach a readiness Lead PASS', () => {
  // Layer 1: application refuses it outright.
  const refused = apply([demote('m1', ['lead-3'], {
    leadEvidence: leadDemotionEvidence({ sourceEventId: sourceEventIdOf('lead-1') }),
  })]);
  assert.equal(refused.status, 'PENDING');
  assert.equal(reviewAppliedCandidate({ application: refused, baseline }).status, 'NOT_APPLICABLE');

  // Layer 2 and 3: a correctly applied result whose evidence is swapped
  // afterwards still cannot reach a Lead PASS at readiness.
  const clean = apply([demote('m2', ['lead-1'], {
    leadEvidence: leadDemotionEvidence({ sourceEventId: sourceEventIdOf('lead-1') }),
  })]);
  const forged = {
    ...clean,
    applied: clean.applied.map(entry => ({ ...entry, leadEvidence: leadDemotionEvidence({ sourceEventId: sourceEventIdOf('lead-4') }) })),
  };
  const review = reviewAppliedCandidate({
    application: forged,
    baseline,
    leadDemotionReports: leadDemotionReportsFromApplication(forged, baseline),
  });
  assert.equal(review.readiness.gates.leadDemotion.status, 'PENDING');
  assert.ok(review.readiness.gates.leadDemotion.pendingEventIds.includes('lead-1'));
  assert.equal(review.readiness.candidateReady, false);

  // And a caller who hands readiness a hand-written PASS report still gets
  // nothing, because the gate matches on the Lead events the baseline diff found.
  const fabricated = reviewAppliedCandidate({
    application: forged,
    baseline,
    leadDemotionReports: [{ status: 'PASS', pass: true, eventId: 'lead-4', destinationRole: 'Chord3', blockers: [], warnings: [] }],
  });
  assert.equal(fabricated.readiness.gates.leadDemotion.status, 'PENDING');
});

// ─── the stage states the new guarantees as data ────────────────────────────

test('the capability record names the binding it now enforces', async () => {
  const { DECISION_APPLICATION_STATUS } = await import('../backend/arrangement/decision-application.mjs');
  for (const key of [
    'leadEvidenceBoundToTargetEvent',
    'leadEvidenceSourceEventIdMembershipRequired',
    'leadAffectingDecisionLimitedToOneEvent',
    'leadEvidenceRevalidatedDownstream',
  ]) assert.equal(DECISION_APPLICATION_STATUS[key], true, `${key} must be true`);

  for (const key of [
    'leadEvidenceSharedAcrossEvents',
    'leadEvidenceBoundBySourceIdAlone',
    'derivedEventIdAcceptedAsSourceEventId',
  ]) assert.equal(DECISION_APPLICATION_STATUS[key], false, `${key} must stay false`);
});
