import test from 'node:test';
import assert from 'node:assert/strict';
import { applyAcceptedArrangement, DECISION_APPLICATION_STATUS } from '../backend/arrangement/decision-application.mjs';
import { reviewAppliedCandidate } from '../backend/arrangement/decision-review.mjs';
import { analyzeCrossSourceHarmony } from '../backend/arbitration/harmony.mjs';
import { createCanonicalProject, createArbitrationDecision } from '../backend/canonical/index.mjs';
import { roleDeclaredBaseline, acceptanceFor, CANONICAL_IDENTITY, SOURCE_ID, SECOND_SOURCE_ID } from './fixtures/g11d-fixtures.mjs';

// G11-D residual D: what a derived revision carries from the project it is
// applied onto, and on what terms.
//
// The fixture has one real cross-source conflict: `harm-1` (official score,
// pitch 64, beats 0-2, Chord1) against `alt-1` (third-party MIDI, pitch 64,
// beats 0-2, no role). An accepted arbitration decision `h1` on that pair marks
// it resolved. Every test below changes something about those events through an
// accepted arrangement decision and asks whether `h1` is still allowed to say
// "resolved" about the result.

const withDecisions = (project, decisions) => createCanonicalProject({ ...project, decisions: decisions.map(createArbitrationDecision) });
const keep = (id, eventIds, status = 'accepted') => ({ id, eventIds, action: 'keep', status, reason: 'Reviewed: intentional doubling.', evidence: ['fixture:review'] });

const baseline = withDecisions(roleDeclaredBaseline({ extraSource: true }), [keep('h1', ['harm-1', 'alt-1'])]);
const accept = overrides => acceptanceFor(baseline, overrides);
const apply = (decisions, extra = {}) => applyAcceptedArrangement({ baseline, decisions, canonicalIdentity: CANONICAL_IDENTITY, ...extra });

const decisionIn = (candidate, id) => candidate.decisions.find(decision => decision.id === id);
const marker = decision => decision.metadata.g11d.carriedForward;
const conflictOf = (report, left, right) => report.conflicts.find(item => [item.leftEventId, item.rightEventId].sort().join('|') === [left, right].sort().join('|'));

const move = (id, eventIds, fromRole, toRole, extra = {}) => ({ id, type: 'MOVE_ROLE', target: { eventIds }, fromRole, toRole, reason: `Reviewed: ${id}.`, evidence: ['fixture:score'], acceptance: accept(), ...extra });
const assign = (id, eventIds, toRole, extra = {}) => ({ id, type: 'ASSIGN_ROLE', target: { eventIds }, toRole, reason: `Reviewed: ${id}.`, evidence: ['fixture:score'], acceptance: accept(), ...extra });
const omit = (id, eventIds, extra = {}) => ({ id, type: 'OMIT_FROM_SIX', target: { eventIds }, reason: `Reviewed: ${id}.`, evidence: ['fixture:score'], acceptance: accept(), ...extra });
const keepDecision = (id, eventIds, extra = {}) => ({ id, type: 'KEEP', target: { eventIds }, reason: `Reviewed: ${id}.`, evidence: ['fixture:score'], acceptance: accept(), ...extra });
const duplicate = (id, eventIds, toRoles, extra = {}) => ({ id, type: 'DUPLICATE_WITH_JUSTIFICATION', target: { eventIds }, toRoles, reason: `Reviewed: ${id}.`, evidence: ['fixture:score'], acceptance: accept(), ...extra });

test('the fixture really has the conflict, and h1 really resolves it on the baseline', () => {
  const report = analyzeCrossSourceHarmony(baseline);
  const conflict = conflictOf(report, 'harm-1', 'alt-1');
  assert.ok(conflict, 'harm-1 and alt-1 must conflict cross-source');
  assert.equal(conflict.resolved, true);
  assert.equal(conflict.decision.id, 'h1');
});

// ─── 1, 7. baseline provenance stays traceable ──────────────────────────────

test('1/7: untouched baseline provenance remains traceable, and the baseline diff is available', () => {
  const result = apply([assign('a1', ['tex-1'], 'Chord3')]);
  assert.equal(result.status, 'PASS', JSON.stringify(result.rejected));
  const snapshot = result.candidate.metadata.sourceFaithfulBaseline.snapshot;
  // The embedded baseline is the baseline: its decisions verbatim, its sources,
  // its events with their provenance.
  assert.deepEqual(JSON.parse(JSON.stringify(snapshot.decisions)), JSON.parse(JSON.stringify(baseline.decisions)));
  assert.deepEqual(snapshot.sources.map(source => source.id), baseline.sources.map(source => source.id));
  for (const event of baseline.events) {
    const carried = result.candidate.events.find(item => item.id === event.id);
    assert.deepEqual([...carried.sourceIds], [...event.sourceIds]);
    assert.deepEqual([...carried.sourceEventIds], [...event.sourceEventIds]);
  }
  assert.ok(result.diffFromBaseline);
  assert.equal(result.diffFromBaseline.summary.roleMoved, 1);
  const review = reviewAppliedCandidate({ application: result, baseline });
  assert.equal(review.readiness.gates.baseline.status, 'PASS');
  // h1 names events this revision did not touch: carried as it was.
  const h1 = decisionIn(result.candidate, 'h1');
  assert.equal(h1.status, 'accepted');
  assert.equal(marker(h1).currentStatus, 'CURRENT');
  assert.equal(marker(h1).fromRevisionId, null);
  assert.equal(conflictOf(analyzeCrossSourceHarmony(result.candidate), 'harm-1', 'alt-1').resolved, true);
  assert.ok(result.diagnostics.find(item => item.code === 'ARBITRATION_DECISIONS_CARRIED_FORWARD').acceptedDecisionIds.includes('h1'));
});

// ─── 3. omitted event ───────────────────────────────────────────────────────

test('3: an arbitration decision naming an omitted event is dropped, and the drop is reported', () => {
  const result = apply([omit('o1', ['harm-1'], { fromRole: 'Chord1' })]);
  assert.equal(result.status, 'PASS', JSON.stringify(result.rejected));
  assert.equal(decisionIn(result.candidate, 'h1'), undefined);
  const dropped = result.diagnostics.find(item => item.code === 'ARBITRATION_DECISION_DROPPED_WITH_OMITTED_EVENT');
  assert.deepEqual([...dropped.decisionIds], ['h1']);
  // And the baseline still has it: the snapshot is the baseline, not the candidate.
  assert.equal(result.candidate.metadata.sourceFaithfulBaseline.snapshot.decisions.length, 1);
});

// ─── 4. moved / re-roled event ──────────────────────────────────────────────

test('4: an accepted arbitration decision naming an event whose role moved is re-reported as unresolved, never silently current', () => {
  const result = apply([move('m1', ['harm-1'], 'Chord1', 'Chord4')]);
  assert.equal(result.status, 'PASS', JSON.stringify(result.rejected));
  const h1 = decisionIn(result.candidate, 'h1');
  assert.ok(h1, 'retained as history');
  assert.equal(h1.status, 'pending', 'no longer accepted');
  assert.deepEqual(marker(h1), {
    fromRevisionId: null,
    intoRevisionIndex: 1,
    previousStatus: 'accepted',
    currentStatus: 'REQUIRES_REREVIEW',
    reasons: ['EVENT_ROLE_CHANGED'],
    affectedEventIds: ['harm-1'],
    nonCurrentSince: { fromRevisionId: null, intoRevisionIndex: 1 },
    history: [],
    notice: marker(h1).notice,
  });
  assert.match(marker(h1).notice, /Not current/);
  // Harmony sees the conflict unresolved again; readiness blocks on the pending decision.
  const harmony = analyzeCrossSourceHarmony(result.candidate);
  assert.equal(conflictOf(harmony, 'harm-1', 'alt-1').resolved, false);
  assert.equal(harmony.status, 'PENDING');
  const review = reviewAppliedCandidate({ application: result, baseline });
  assert.equal(review.readiness.gates.pendingDecisions.status, 'PENDING');
  assert.deepEqual([...review.readiness.gates.pendingDecisions.decisionIds], ['h1']);
  assert.equal(review.readiness.gates.crossSourceHarmony.status, 'PENDING');
  const diagnostic = result.diagnostics.find(item => item.code === 'ARBITRATION_DECISION_REREVIEW_REQUIRED');
  assert.deepEqual(JSON.parse(JSON.stringify(diagnostic.decisions)), [{ decisionId: 'h1', previousStatus: 'accepted', reasons: ['EVENT_ROLE_CHANGED'], affectedEventIds: ['harm-1'] }]);

  // Assigning a role to the other, unassigned side is a role change too.
  const assigned = apply([assign('a1', ['alt-1'], 'Chord5')]);
  assert.equal(assigned.status, 'PASS');
  assert.equal(decisionIn(assigned.candidate, 'h1').status, 'pending');
  assert.deepEqual([...marker(decisionIn(assigned.candidate, 'h1')).affectedEventIds], ['alt-1']);

  // KEEP touches nothing, so the decision stays current.
  const kept = apply([keepDecision('k1', ['harm-1'])]);
  assert.equal(decisionIn(kept.candidate, 'h1').status, 'accepted');
  assert.equal(marker(decisionIn(kept.candidate, 'h1')).currentStatus, 'CURRENT');
});

// ─── 5. derived duplicate ───────────────────────────────────────────────────

test('5: a derived duplicate never inherits its origin\'s arbitration, and its origin\'s decision is re-asked', () => {
  const result = apply([duplicate('d1', ['harm-1'], ['Chord3'])]);
  assert.equal(result.status, 'PASS', JSON.stringify(result.rejected));
  const derived = result.candidate.events.find(event => event.metadata?.g11d?.derivedFromEventId === 'harm-1');
  assert.ok(derived);
  assert.deepEqual([...derived.sourceIds], [SOURCE_ID], 'the copy carries its origin provenance, not new provenance');
  const harmony = analyzeCrossSourceHarmony(result.candidate);
  // The copy against the third-party event is a conflict of its own, unresolved:
  // no decision names the derived id, and h1 does not stretch to cover it.
  const copyConflict = conflictOf(harmony, derived.id, 'alt-1');
  assert.ok(copyConflict, 'the duplicate conflicts with the foreign-source event on its own account');
  assert.equal(copyConflict.resolved, false);
  // The copy against its own origin is not a cross-source conflict (same source).
  assert.equal(conflictOf(harmony, derived.id, 'harm-1'), undefined);
  // And h1 itself is re-asked: its origin now sounds twice.
  const h1 = decisionIn(result.candidate, 'h1');
  assert.equal(h1.status, 'pending');
  assert.deepEqual([...marker(h1).reasons], ['EVENT_DUPLICATED']);
  assert.equal(conflictOf(harmony, 'harm-1', 'alt-1').resolved, false);
  assert.equal(DECISION_APPLICATION_STATUS.derivedDuplicateInheritsArbitrationDecision, false);
});

// ─── 2, 6. gate evidence never rides forward ────────────────────────────────

test('2/6: no gate PASS rides forward from the baseline or a parent as if recomputed', () => {
  // Baseline-level: the caller owns the baseline, so it may carry gate evidence.
  const tainted = createCanonicalProject({
    ...baseline,
    metadata: { sourceComplete: true, audioAlignmentEvidence: [{ section: 'all', warnings: [] }], incompleteInputs: [], note: 'kept' },
  });
  const first = applyAcceptedArrangement({
    baseline: tainted, canonicalIdentity: CANONICAL_IDENTITY,
    decisions: [assign('a1', ['tex-1'], 'Chord3', { acceptance: acceptanceFor(tainted) })],
  });
  assert.equal(first.status, 'PASS');
  for (const key of ['sourceComplete', 'audioAlignmentEvidence', 'incompleteInputs']) assert.equal(first.candidate.metadata[key], undefined, key);
  assert.equal(first.candidate.metadata.note, 'kept');
  assert.deepEqual([...first.diagnostics.find(item => item.code === 'PARENT_GATE_METADATA_NOT_INHERITED').keys], ['audioAlignmentEvidence', 'incompleteInputs', 'sourceComplete']);
  assert.deepEqual([...first.diagnostics.find(item => item.code === 'PARENT_METADATA_INHERITED').keys], ['note']);
  const review = reviewAppliedCandidate({ application: first, baseline: tainted });
  assert.equal(review.readiness.gates.source.status, 'PENDING', 'sourceComplete was not inherited');
  assert.equal(review.readiness.gates.originalAudio.status, 'PENDING', 'audio evidence was not inherited');

  // Parent-level: an honest parent carries its own g11d record and snapshot;
  // both are replaced, never inherited, and the new revision certifies nothing.
  const second = applyAcceptedArrangement({
    baseline: tainted, canonicalIdentity: CANONICAL_IDENTITY,
    parent: { revision: first.revision, candidate: first.candidate },
    decisions: [move('m1', ['tex-1'], 'Chord3', 'Chord4', { acceptance: acceptanceFor(tainted, { reviewedRevisionId: first.revision.id }) })],
  });
  assert.equal(second.status, 'PASS', JSON.stringify(second.rejected));
  assert.equal(second.candidate.metadata.g11d.revision.id, second.revision.id);
  assert.deepEqual([...second.candidate.metadata.g11d.certifiesGates], []);
  assert.deepEqual([...second.diagnostics.find(item => item.code === 'PARENT_GATE_METADATA_NOT_INHERITED').keys], ['g11d', 'sourceFaithfulBaseline']);
  assert.equal(second.candidate.metadata.sourceComplete, undefined);

  // A parent whose metadata was edited to claim gate evidence is not a parent:
  // its candidate no longer matches the revision that describes it.
  const forgedParent = createCanonicalProject({ ...first.candidate, metadata: { ...first.candidate.metadata, sourceComplete: true } });
  const refused = applyAcceptedArrangement({
    baseline: tainted, canonicalIdentity: CANONICAL_IDENTITY,
    parent: { revision: first.revision, candidate: forgedParent },
    decisions: [move('m1', ['tex-1'], 'Chord3', 'Chord4', { acceptance: acceptanceFor(tainted, { reviewedRevisionId: first.revision.id }) })],
  });
  assert.equal(refused.status, 'FAIL');
  assert.ok(refused.rejected.some(item => item.code === 'PARENT_CANDIDATE_DIGEST_MISMATCH'));
});

// ─── 8, 9. across a chain: parent diff, and history stays history ───────────

test('8/9: a demoted decision stays non-current through later revisions, and the parent diff is available', () => {
  const first = apply([move('m1', ['harm-1'], 'Chord1', 'Chord4')]);
  assert.equal(decisionIn(first.candidate, 'h1').status, 'pending');
  const second = apply([assign('a2', ['tex-1'], 'Chord3', { acceptance: accept({ reviewedRevisionId: first.revision.id }) })], { parent: { revision: first.revision, candidate: first.candidate } });
  assert.equal(second.status, 'PASS', JSON.stringify(second.rejected));
  const h1 = decisionIn(second.candidate, 'h1');
  // Revision 2 touched nothing h1 names, so it is carried as it was -- and as
  // it was is non-current: the status, the reasons and the revision that made
  // it non-current all survive, and the earlier marker is kept as history.
  assert.equal(h1.status, 'pending');
  assert.equal(marker(h1).currentStatus, 'REQUIRES_REREVIEW', 'an untouched revision does not make a stale decision current again');
  assert.deepEqual([...marker(h1).reasons], ['EVENT_ROLE_CHANGED']);
  assert.deepEqual([...marker(h1).affectedEventIds], ['harm-1']);
  assert.deepEqual(marker(h1).nonCurrentSince, { fromRevisionId: null, intoRevisionIndex: 1 });
  assert.equal(marker(h1).previousStatus, 'pending');
  assert.equal(marker(h1).fromRevisionId, first.revision.id);
  assert.equal(marker(h1).history.length, 1);
  assert.equal(marker(h1).history[0].currentStatus, 'REQUIRES_REREVIEW');
  assert.deepEqual([...marker(h1).history[0].reasons], ['EVENT_ROLE_CHANGED']);
  assert.equal(Object.hasOwn(marker(h1).history[0], 'history'), false, 'history entries do not nest');
  assert.deepEqual(JSON.parse(JSON.stringify(second.diagnostics.find(item => item.code === 'ARBITRATION_DECISION_STILL_NON_CURRENT').decisions)), [{ decisionId: 'h1', status: 'pending', currentStatus: 'REQUIRES_REREVIEW', reasons: ['EVENT_ROLE_CHANGED'], nonCurrentSince: { fromRevisionId: null, intoRevisionIndex: 1 } }]);
  assert.equal(reviewAppliedCandidate({ application: second, baseline }).readiness.gates.pendingDecisions.status, 'PENDING');

  // A third untouched revision keeps the same non-current state and grows the history.
  const third = apply([assign('a3', ['tex-2'], 'Chord5', { acceptance: accept({ reviewedRevisionId: second.revision.id }) })], { parent: { revision: second.revision, candidate: second.candidate } });
  assert.equal(third.status, 'PASS', JSON.stringify(third.rejected));
  assert.equal(marker(decisionIn(third.candidate, 'h1')).currentStatus, 'REQUIRES_REREVIEW');
  assert.deepEqual(marker(decisionIn(third.candidate, 'h1')).nonCurrentSince, { fromRevisionId: null, intoRevisionIndex: 1 });
  assert.equal(marker(decisionIn(third.candidate, 'h1')).history.length, 2);

  // Only a fresh arbitration review -- the decision re-accepted on the parent --
  // makes it current again.
  const reReviewed = createCanonicalProject({ ...second.candidate, decisions: second.candidate.decisions.map(item => (item.id === 'h1' ? createArbitrationDecision({ ...item, status: 'accepted' }) : item)) });
  const reReviewedRevision = { ...second.revision };
  // The re-accepted parent no longer matches its revision's candidate digest,
  // so it is refused as a parent: a reviewer's re-acceptance is a new baseline-
  // level fact, not something a revision chain can absorb silently.
  const refused = apply([assign('a3', ['tex-2'], 'Chord5', { acceptance: accept({ reviewedRevisionId: reReviewedRevision.id }) })], { parent: { revision: reReviewedRevision, candidate: reReviewed } });
  assert.equal(refused.status, 'FAIL');
  assert.ok(refused.rejected.some(item => item.code === 'PARENT_CANDIDATE_DIGEST_MISMATCH'));
  // As a baseline-level decision it is accepted and untouched, so it is CURRENT.
  const fresh = withDecisions(roleDeclaredBaseline({ extraSource: true }), [{ ...keep('h1', ['harm-1', 'alt-1']), metadata: { g11d: { carriedForward: { currentStatus: 'REQUIRES_REREVIEW', reasons: ['EVENT_ROLE_CHANGED'], affectedEventIds: ['harm-1'], history: [] } } } }]);
  const freshResult = applyAcceptedArrangement({ baseline: fresh, canonicalIdentity: CANONICAL_IDENTITY, decisions: [assign('a1', ['tex-1'], 'Chord3', { acceptance: acceptanceFor(fresh) })] });
  assert.equal(freshResult.status, 'PASS');
  assert.equal(marker(decisionIn(freshResult.candidate, 'h1')).currentStatus, 'CURRENT');
  assert.equal(marker(decisionIn(freshResult.candidate, 'h1')).history.length, 1, 'the earlier non-current marker is kept as history');
  assert.ok(second.diffFromParent);
  assert.equal(second.diffFromParent.summary.roleMoved, 1);
  assert.equal(second.diffFromBaseline.summary.roleMoved, 2);

  // A pending or rejected decision whose event moves keeps its status and is
  // marked historical, never promoted.
  const pendingBaseline = withDecisions(roleDeclaredBaseline({ extraSource: true }), [keep('h1', ['harm-1', 'alt-1'], 'pending'), keep('h2', ['harm-1', 'alt-1'], 'rejected')]);
  const moved = applyAcceptedArrangement({
    baseline: pendingBaseline, canonicalIdentity: CANONICAL_IDENTITY,
    decisions: [move('m1', ['harm-1'], 'Chord1', 'Chord4', { acceptance: acceptanceFor(pendingBaseline) })],
  });
  assert.equal(moved.status, 'PASS');
  assert.equal(decisionIn(moved.candidate, 'h1').status, 'pending');
  assert.equal(decisionIn(moved.candidate, 'h2').status, 'rejected');
  assert.equal(marker(decisionIn(moved.candidate, 'h2')).currentStatus, 'HISTORICAL');
  assert.deepEqual([...moved.diagnostics.find(item => item.code === 'ARBITRATION_DECISION_HISTORICAL').decisionIds], ['h1', 'h2']);
});

test('the capability record states the carry-forward terms as data', () => {
  for (const key of ['arbitrationDecisionsReboundToUnchangedEvents', 'staleArbitrationDecisionsDemotedToPending', 'arbitrationDecisionsDroppedWithOmittedEvents', 'parentMetadataInheritanceReported']) {
    assert.equal(DECISION_APPLICATION_STATUS[key], true, key);
  }
  for (const key of ['staleArbitrationDecisionsCarriedAsAccepted', 'derivedDuplicateInheritsArbitrationDecision', 'parentGatePassInherited']) {
    assert.equal(DECISION_APPLICATION_STATUS[key], false, key);
  }
  assert.equal(SECOND_SOURCE_ID !== SOURCE_ID, true);
});
