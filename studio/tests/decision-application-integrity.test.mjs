import test from 'node:test';
import assert from 'node:assert/strict';
import {
  applyAcceptedArrangement,
  createAcceptedDecision,
  snapshotDigestOf,
  DECISION_REJECTION,
  CANONICAL_PROJECT_SCHEMA,
} from '../backend/arrangement/decision-application.mjs';
import { reviewAppliedCandidate, leadDemotionReportsFromApplication, applicationIntegrity } from '../backend/arrangement/decision-review.mjs';
import { suggestRoleCandidates } from '../backend/arrangement/role-candidates.mjs';
import { createCanonicalRestEvent, createCanonicalProject } from '../backend/canonical/index.mjs';
import { roleDeclaredBaseline, acceptanceFor, leadDemotionEvidence, CANONICAL_IDENTITY } from './fixtures/g11d-fixtures.mjs';

// Findings from a full re-read of the stage after the external-review P1.
//
// Two were the same class as that P1 -- trusting a caller-supplied object as
// if it were an outcome -- and the rest are contract gaps. Each regression
// below reproduced the defect against the previous code before the fix.

const baseline = roleDeclaredBaseline();
const suggestion = suggestRoleCandidates(baseline);
const accept = (b = baseline, s = suggestion) => acceptanceFor(b, { suggestion: s });
const apply = (decisions, extra = {}) => applyAcceptedArrangement({
  baseline, suggestion, decisions, canonicalIdentity: CANONICAL_IDENTITY, ...extra,
});
const demote = (id, eventId, overrides = {}) => ({
  id, type: 'MOVE_ROLE', target: { eventIds: [eventId] }, fromRole: 'Melody', toRole: 'Chord3',
  reason: 'Reviewed: inner-staff doubling.', evidence: ['fixture:score'],
  leadEvidence: leadDemotionEvidence({ sourceEventId: `fixture:symbolic#${eventId}` }),
  acceptance: accept(), ...overrides,
});

// ─── S1: a lane naming a rest cannot be applied ─────────────────────────────

test('a lane target that names a rest event is refused, not carried through with a lying trace', () => {
  // Before the fix: PASS, the rest carried through unchanged with role null,
  // and the trace reported `toRole: Chord3` for it.
  const rest = createCanonicalRestEvent({ id: 'rest-1', start: '4', end: '5', sourceIds: ['fixture:symbolic'], sourceEventIds: ['fixture:symbolic#rest-1'], metadata: {} });
  const withRest = createCanonicalProject({ ...baseline, events: [...baseline.events, rest] });
  const real = suggestRoleCandidates(withRest);
  // The suggestion is caller-supplied data: a forged lane that includes the rest.
  const forged = { ...real, lanes: [...real.lanes, { id: 'lane:forged#0', eventIds: ['rest-1', 'tex-1'] }] };

  const result = applyAcceptedArrangement({
    baseline: withRest, suggestion: forged, canonicalIdentity: CANONICAL_IDENTITY,
    decisions: [{ id: 's1', type: 'ASSIGN_ROLE', target: { laneId: 'lane:forged#0' }, toRole: 'Chord3', reason: 'r', evidence: ['e'], acceptance: accept(withRest, forged) }],
  });
  assert.equal(result.status, 'FAIL');
  assert.equal(result.candidate, null);
  const rejection = result.rejected.find(item => item.code === DECISION_REJECTION.TARGET_EVENT_NOT_A_NOTE);
  assert.ok(rejection, `expected TARGET_EVENT_NOT_A_NOTE, got ${result.rejected.map(item => item.code).join(',')}`);
  assert.deepEqual([...rejection.eventIds], ['rest-1']);
  assert.equal(rejection.laneId, 'lane:forged#0');
  assert.deepEqual([...result.trace], [], 'no trace entry can claim a role was applied');
});

// ─── S34: the review facade verifies the application it is handed ──────────

function honestDemotion() {
  const application = apply([demote('m1', 'lead-1')]);
  assert.equal(application.status, 'PASS');
  return application;
}

test('a candidate whose embedded snapshot was swapped for itself is refused by the review facade', () => {
  const ok = honestDemotion();
  // Before the fix: REVIEWED, baseline gate PASS, and the Lead gate collapsed to
  // N/A because the diff against the forged snapshot found no Lead move.
  const forgedCandidate = createCanonicalProject({
    ...ok.candidate,
    metadata: { ...ok.candidate.metadata, sourceFaithfulBaseline: { snapshot: { ...ok.candidate, metadata: {} } } },
  });
  const forged = { ...ok, candidate: forgedCandidate };

  const integrity = applicationIntegrity(forged, baseline);
  assert.equal(integrity.ok, false);
  assert.ok(integrity.reasons.includes('CANDIDATE_SNAPSHOT_NOT_THE_BASELINE'));
  assert.ok(integrity.reasons.includes('CANDIDATE_DIGEST_MISMATCH'), 'the swapped snapshot also changes the candidate digest the revision addresses');

  const review = reviewAppliedCandidate({ application: forged, baseline });
  assert.equal(review.status, 'NOT_APPLICABLE');
  assert.equal(review.readiness, null, 'readiness is never run against a candidate that disagrees with its own revision');
  assert.equal(review.integrity.ok, false);
  assert.deepEqual(leadDemotionReportsFromApplication(forged, baseline), [], 'and no Lead report is manufactured for it');
});

test('every other way an application can disagree with itself is named', () => {
  const ok = honestDemotion();
  const cases = [
    ['REVISION_IDENTITY_TAMPERED', { ...ok, revision: { ...ok.revision, index: 7 } }],
    ['CANDIDATE_DIGEST_MISMATCH', { ...ok, candidate: createCanonicalProject({ ...ok.candidate, events: ok.candidate.events.filter(event => event.id !== 'tex-2') }) }],
    ['CANDIDATE_REVISION_MISMATCH', { ...ok, candidate: createCanonicalProject({ ...ok.candidate, metadata: { ...ok.candidate.metadata, g11d: { ...ok.candidate.metadata.g11d, revision: { ...ok.candidate.metadata.g11d.revision, id: 'g11d:rev:other' } } } }) }],
    ['CANDIDATE_SNAPSHOT_MISSING', { ...ok, candidate: createCanonicalProject({ ...ok.candidate, metadata: { g11d: ok.candidate.metadata.g11d } }) }],
    ['APPLICATION_NOT_PASS', { ...ok, status: 'PENDING' }],
    ['CANDIDATE_NOT_A_CANONICAL_PROJECT', { ...ok, candidate: { ...ok.candidate, schema: 'something-else' } }],
  ];
  for (const [reason, forged] of cases) {
    const integrity = applicationIntegrity(forged, baseline);
    assert.equal(integrity.ok, false, `${reason} must fail integrity`);
    assert.ok(integrity.reasons.includes(reason), `${reason} expected in ${integrity.reasons.join(',')}`);
    assert.equal(reviewAppliedCandidate({ application: forged, baseline }).status, 'NOT_APPLICABLE');
    assert.deepEqual(leadDemotionReportsFromApplication(forged, baseline), []);
  }
  // A different baseline than the one the revision was made against.
  const other = roleDeclaredBaseline({ id: 'fixture:other' });
  const against = applicationIntegrity(ok, other);
  assert.equal(against.ok, false);
  assert.ok(against.reasons.includes('REVISION_BASELINE_MISMATCH'));
});

test('the accepted previous candidate is a valid reference for reports, but not for readiness', () => {
  const first = apply([{ id: 'a1', type: 'ASSIGN_ROLE', target: { eventIds: ['tex-1'] }, toRole: 'Chord3', reason: 'r', evidence: ['e'], acceptance: accept() }]);
  const second = applyAcceptedArrangement({
    baseline, suggestion, canonicalIdentity: CANONICAL_IDENTITY,
    parent: { revision: first.revision, candidate: first.candidate },
    decisions: [demote('m2', 'lead-1', { acceptance: { ...accept(), reviewedRevisionId: first.revision.id } })],
  });
  assert.equal(second.status, 'PASS');

  // The revision names both the baseline and the parent; either is a reference
  // it was actually made against.
  assert.equal(applicationIntegrity(second, baseline).against, 'baseline');
  assert.equal(applicationIntegrity(second, first.candidate).against, 'parent');
  assert.equal(leadDemotionReportsFromApplication(second, first.candidate).length, 1, 'reports against the step just taken');
  assert.equal(leadDemotionReportsFromApplication(second, baseline).length, 1, 'and against the Source-Faithful baseline');

  // Readiness reads the Source-Faithful baseline, so the review refuses to run
  // against the parent rather than quietly reviewing against the wrong thing.
  const review = reviewAppliedCandidate({ application: second, baseline: first.candidate });
  assert.equal(review.status, 'NOT_APPLICABLE');
  assert.deepEqual([...review.integrity.reasons], ['REVIEW_REQUIRES_SOURCE_FAITHFUL_BASELINE']);
  assert.equal(reviewAppliedCandidate({ application: second, baseline }).status, 'REVIEWED');

  // A third, unrelated project is neither.
  const stranger = roleDeclaredBaseline({ id: 'fixture:stranger' });
  assert.equal(applicationIntegrity(second, stranger).against, null);
  assert.deepEqual(leadDemotionReportsFromApplication(second, stranger), []);
});

test('an honest application passes integrity and still reaches every downstream gate', () => {
  const ok = honestDemotion();
  const integrity = applicationIntegrity(ok, baseline);
  assert.deepEqual([integrity.ok, [...integrity.reasons]], [true, []]);
  const review = reviewAppliedCandidate({ application: ok, baseline, leadDemotionReports: leadDemotionReportsFromApplication(ok, baseline) });
  assert.equal(review.status, 'REVIEWED');
  assert.equal(review.integrity.ok, true);
  assert.equal(review.readiness.gates.baseline.status, 'PASS');
  assert.equal(review.readiness.gates.leadDemotion.status, 'PASS');
  assert.equal(review.readiness.candidateReady, false, 'still not ready: every other gate is still there');
});

test('integrity survives a JSON round trip of an honest application', () => {
  const ok = honestDemotion();
  const restored = JSON.parse(JSON.stringify(ok));
  assert.equal(applicationIntegrity(restored, baseline).ok, true);
  assert.equal(reviewAppliedCandidate({ application: restored, baseline }).status, 'REVIEWED');
});

// ─── S29: an omitted event with surviving derived copies is reported ────────

test('omitting the origin of an earlier duplicate reports the copies that remain', () => {
  const first = apply([{
    id: 'd1', type: 'DUPLICATE_WITH_JUSTIFICATION', target: { eventIds: ['harm-1'] }, toRoles: ['Chord3'],
    reason: 'Reviewed: doubled for enrichment.', evidence: ['fixture:score'], acceptance: accept(),
  }]);
  assert.equal(first.status, 'PASS');
  const derived = first.candidate.events.find(event => event.metadata?.g11d?.derivedFromEventId === 'harm-1');

  const second = applyAcceptedArrangement({
    baseline, suggestion, canonicalIdentity: CANONICAL_IDENTITY,
    parent: { revision: first.revision, candidate: first.candidate },
    decisions: [{
      id: 'o1', type: 'OMIT_FROM_SIX', target: { eventIds: ['harm-1'] },
      reason: 'Reviewed: the original is dropped from the six roles.', evidence: ['fixture:score'],
      acceptance: { ...accept(), reviewedRevisionId: first.revision.id },
    }],
  });
  assert.equal(second.status, 'PASS');
  assert.equal(second.candidate.events.some(event => event.id === 'harm-1'), false);
  assert.equal(second.candidate.events.some(event => event.id === derived.id), true, 'the earlier duplicate is its own event and survives');

  const diagnostic = second.diagnostics.find(item => item.code === 'DERIVED_DUPLICATE_OUTLIVES_ORIGIN');
  assert.ok(diagnostic, 'a copy that still sounds after its origin was omitted is never left unmentioned');
  assert.equal(diagnostic.deleted, false);
  assert.deepEqual(diagnostic.pairs[0].omittedEventId, 'harm-1');
  assert.deepEqual([...diagnostic.pairs[0].derivedEventIds], [derived.id]);
});

// ─── S33: only real Canonical projects are accepted ─────────────────────────

test('a baseline or parent candidate without the Canonical project schema is refused up front', () => {
  const { schema, ...bare } = baseline;
  assert.throws(() => applyAcceptedArrangement({ baseline: bare, decisions: [], canonicalIdentity: CANONICAL_IDENTITY }), new RegExp(CANONICAL_PROJECT_SCHEMA));
  const first = apply([{ id: 'a1', type: 'ASSIGN_ROLE', target: { eventIds: ['tex-1'] }, toRole: 'Chord3', reason: 'r', evidence: ['e'], acceptance: accept() }]);
  const { schema: _s, ...bareCandidate } = first.candidate;
  assert.throws(() => apply([], { parent: { revision: first.revision, candidate: bareCandidate } }), new RegExp(CANONICAL_PROJECT_SCHEMA));
});

// ─── F2: the reserved rejection codes are the ones actually emitted ─────────

test('constructor failures surface under their own rejection codes', () => {
  const base = { id: 'x', type: 'KEEP', target: { eventIds: ['lead-1'] }, reason: 'r', evidence: ['e'], acceptance: accept() };
  const codeFor = decision => apply([decision]).rejected.find(item => item.decisionId === 'x')?.code;
  assert.equal(codeFor({ ...base, type: 'MAKE_IT_BETTER' }), DECISION_REJECTION.UNKNOWN_DECISION_TYPE);
  assert.equal(codeFor({ ...base, acceptance: undefined }), DECISION_REJECTION.DECISION_NOT_ACCEPTED);
  assert.equal(codeFor({ ...base, acceptance: { ...base.acceptance, state: 'SUGGESTED' } }), DECISION_REJECTION.DECISION_NOT_ACCEPTED);
  assert.equal(codeFor({ ...base, target: {} }), DECISION_REJECTION.TARGET_MISSING);
  assert.equal(codeFor({ ...base, target: { laneId: 'lane:lead#0', eventIds: ['lead-1'] } }), DECISION_REJECTION.TARGET_AMBIGUOUS);
  // Anything without a more specific name stays DECISION_MALFORMED.
  assert.equal(codeFor({ ...base, octaveShift: -1 }), DECISION_REJECTION.DECISION_MALFORMED);
  // Every one of them still fails the set closed.
  for (const decision of [{ ...base, type: 'MAKE_IT_BETTER' }, { ...base, target: {} }]) assert.equal(apply([decision]).candidate, null);
});

// ─── F7: the lane digest is trimmed like every other digest ─────────────────

test('a padded lane-decomposition digest binds the same as a clean one', () => {
  const acceptance = accept();
  const padded = createAcceptedDecision({ id: 'p', type: 'KEEP', target: { eventIds: ['lead-1'] }, reason: 'r', evidence: ['e'], acceptance: { ...acceptance, laneDecompositionDigest: `  ${acceptance.laneDecompositionDigest}  ` } });
  assert.equal(padded.acceptance.laneDecompositionDigest, acceptance.laneDecompositionDigest);
  assert.equal(apply([padded]).status, 'PASS');
});

test('snapshotDigestOf ignores exactly the two nesting keys and nothing else', () => {
  const withGate = createCanonicalProject({ ...baseline, metadata: { sourceComplete: true } });
  assert.notEqual(snapshotDigestOf(withGate), snapshotDigestOf(baseline), 'gate evidence in metadata still changes the digest');
  const withNesting = createCanonicalProject({ ...baseline, metadata: { sourceFaithfulBaseline: { snapshot: {} }, g11d: {} } });
  assert.equal(snapshotDigestOf(withNesting), snapshotDigestOf(baseline));
});

test('the capability record names the guarantees added by the re-read', async () => {
  const { DECISION_APPLICATION_STATUS } = await import('../backend/arrangement/decision-application.mjs');
  for (const key of ['laneTargetsNoteEventsOnly', 'applicationIntegrityVerifiedDownstream', 'survivingDerivedCopiesReported']) {
    assert.equal(DECISION_APPLICATION_STATUS[key], true, `${key} must be true`);
  }
});
