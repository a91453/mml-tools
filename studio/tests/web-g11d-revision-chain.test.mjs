import test from 'node:test';
import assert from 'node:assert/strict';
import {
  intakeMidi,
  newWorkspace,
  analyzeWorkspace,
  invalidate,
  importWorkspace,
  recordAcceptedDecision,
  recordReview,
  acceptedDecisionBindings,
  readCanonical,
  WORKSPACE_SCHEMA,
} from '../web/model.mjs';
import { deriveArrangement } from '../web/midi-source.mjs';
import {
  ACCEPTED_ARRANGEMENT_PIPELINE,
  PARENT_MODEL,
  acceptedArrangementBinding,
  acceptedRevisionHead,
  deriveAcceptedArrangement,
} from '../web/arrangement-decisions.mjs';
import { revisionIdentityMatches, candidateDigestOf, baselineIdentityOf, createAcceptedDecision } from '../backend/arrangement/decision-application.mjs';
import { acceptedDecisionRecordDigest } from '../web/arrangement-decisions.mjs';
import * as fixtures from './fixtures/midi-fixtures.mjs';

// G11-D residual B: Web revision chaining.
//
// The backend has had a real revision model since PR #28 (content-addressed
// revision ids, verified parents). The Web model only ever produced revision 1.
// It now chains -- and the whole question is how it chains without ever
// trusting a stored parent: every step's parent is the application the same
// analysis produced one step earlier, and a stored record's reviewed revision
// is checked against the head the chain actually reached.
//
// Two revision namespaces appear here and are kept apart on purpose:
// `workspace.revision` (an integer the model bumps on invalidation, scoping
// which records are considered at all) and the G11-D revision id
// (`g11d:rev:<sha256>`, what a decision is reviewed against).

const settings = { meterText: '0 4/4', recording: 'synthetic', offset: '0', end: '2', audioRequired: 'no', preview: 'none' };
const persist = workspace => structuredClone(workspace);
const applied = workspace => analyzeWorkspace(workspace).rawMidi[0].acceptedArrangement;

function fixtureWorkspace(bytes = fixtures.sixSourceVoices()) {
  const workspace = { ...newWorkspace(), title: 'fixture', settings, assets: { candidate: intakeMidi({ name: 'song.mid', bytes }) } };
  const project = readCanonical(workspace.assets.candidate.project);
  const suggestion = deriveArrangement(project, { sourceSha256: workspace.assets.candidate.source.sha256 }).candidate;
  return { workspace, project, suggestion };
}

// The decision a reviewer would submit: everything but the bindings is stated
// by the test; the bindings come from what is loaded, plus the head it names.
const decision = (context, { id, reviewedRevisionId = null, ...fields }) => ({
  id,
  reason: `Reviewed in Studio: ${id}.`,
  evidence: [`fixture:${id}`],
  acceptance: { ...acceptedDecisionBindings({ ...context, reviewedRevisionId }), acceptedBy: 'fixture-reviewer' },
  ...fields,
});

const laneId = (context, index) => context.suggestion.lanes[index].id;

// baseline -> rev1 (assign lane 0) -> rev2 (move lane 0) -> rev3 (assign lane 1)
function chainOf(context) {
  const step1 = recordAcceptedDecision(context.workspace, decision(context, { id: 'r1-assign', type: 'ASSIGN_ROLE', target: { laneId: laneId(context, 0) }, toRole: 'Chord3' }));
  const head1 = acceptedRevisionHead(applied(step1));
  const step2 = recordAcceptedDecision(step1, decision(context, { id: 'r2-move', type: 'MOVE_ROLE', target: { laneId: laneId(context, 0) }, fromRole: 'Chord3', toRole: 'Chord4', reviewedRevisionId: head1 }), { reviewedRevisionId: head1 });
  const head2 = acceptedRevisionHead(applied(step2));
  const step3 = recordAcceptedDecision(step2, decision(context, { id: 'r3-assign', type: 'ASSIGN_ROLE', target: { laneId: laneId(context, 1) }, toRole: 'Chord5', reviewedRevisionId: head2 }), { reviewedRevisionId: head2 });
  return { step1, step2, step3, head1, head2, head3: acceptedRevisionHead(applied(step3)) };
}

// ─── 1-3. baseline -> rev1 -> rev2 -> rev3 ──────────────────────────────────

test('1-3: three accepted applications chain baseline -> rev1 -> rev2 -> rev3, each on the previous', () => {
  const context = fixtureWorkspace();
  const { step1, step2, step3, head1, head2, head3 } = chainOf(context);

  const one = applied(step1);
  assert.equal(one.status, 'PASS');
  assert.equal(one.chain.length, 1);
  assert.equal(one.chain[0].reviewedRevisionId, null);
  assert.equal(one.head.index, 1);
  assert.match(head1, /^g11d:rev:[0-9a-f]{64}$/);

  const two = applied(step2);
  assert.equal(two.status, 'PASS');
  assert.deepEqual(two.chain.map(step => step.status), ['PASS', 'PASS']);
  assert.equal(two.chain[1].reviewedRevisionId, head1);
  assert.equal(two.application.revision.parentRevisionId, head1);
  assert.equal(two.application.revision.index, 2);
  assert.equal(two.head.revisionId, head2);

  const three = applied(step3);
  assert.equal(three.status, 'PASS');
  assert.deepEqual(three.chain.map(step => step.index), [1, 2, 3]);
  assert.equal(three.application.revision.parentRevisionId, head2);
  assert.equal(three.application.revision.index, 3);
  assert.equal(three.head.revisionId, head3);
  assert.equal(three.derivation.chainLength, 3);
  assert.equal(three.derivation.headRevisionId, head3);
  assert.equal(three.parentModel, PARENT_MODEL);
  assert.equal(three.pipeline, ACCEPTED_ARRANGEMENT_PIPELINE);

  // The candidate at revision 3 carries revision 1's and revision 2's work.
  const roleOf = id => three.application.candidate.events.find(event => event.id === id).role;
  for (const id of context.suggestion.lanes[0].eventIds) assert.equal(roleOf(id), 'Chord4');
  for (const id of context.suggestion.lanes[1].eventIds) assert.equal(roleOf(id), 'Chord5');
  // Every revision names the same baseline and Canonical release; parents verify.
  assert.equal(three.application.revision.baselineIdentity.contentDigest, one.application.revision.baselineIdentity.contentDigest);
  assert.equal(revisionIdentityMatches(three.application.revision), true);
  // And the chain, like a single application, makes nothing ready.
  assert.notEqual(analyzeWorkspace(step3).state, 'VALIDATED');
});

// ─── 4-5. determinism and immutability ──────────────────────────────────────

test('4: revision ids are deterministic across analyses and a storage round trip', () => {
  const context = fixtureWorkspace();
  const { step3, head3 } = chainOf(context);
  const again = applied(persist(step3));
  assert.equal(again.head.revisionId, head3);
  assert.deepEqual(again.chain.map(step => step.revisionId), applied(step3).chain.map(step => step.revisionId));
  assert.equal(JSON.stringify(again), JSON.stringify(applied(step3)));
  // The chain is a function of the records, not of the order they are stored in.
  const reversed = persist(step3);
  reversed.acceptedDecisions.reverse();
  assert.equal(JSON.stringify(applied(reversed)), JSON.stringify(applied(step3)));
});

test('5: a previous revision is immutable -- the later step reads it, verifies it, and changes nothing', () => {
  const context = fixtureWorkspace();
  const { step1, step2, step3, head1 } = chainOf(context);
  const one = applied(step1);
  const two = applied(step2);
  const three = applied(step3);
  // Revision 2's parent is exactly revision 1: same id, same candidate.
  assert.equal(two.chain[0].revisionId, one.application.revision.id);
  assert.equal(two.application.revision.parentRevisionId, one.application.revision.id);
  assert.equal(two.application.revision.parentCandidateIdentity.contentDigest, baselineIdentityOf(one.application.candidate).contentDigest);
  assert.equal(two.chain[0].candidateDigest, candidateDigestOf(one.application.candidate));
  // Revision 1 re-derived inside the three-step chain is the same revision 1.
  assert.equal(three.chain[0].revisionId, head1);
  assert.equal(three.chain[0].candidateDigest, one.application.revision.candidateDigest);
  assert.equal(three.application.immutability.parentUnchanged, true);
  assert.equal(three.application.immutability.baselineUnchanged, true);
});

// ─── 6, 14. wrong or sibling parent ─────────────────────────────────────────

test('6/14: a decision reviewed against a sibling revision is refused, not applied onto the head', () => {
  const context = fixtureWorkspace();
  // Two possible revision-1s from the same baseline: the real one, and a
  // sibling produced by a different decision set.
  const real = recordAcceptedDecision(context.workspace, decision(context, { id: 'r1-assign', type: 'ASSIGN_ROLE', target: { laneId: laneId(context, 0) }, toRole: 'Chord3' }));
  const sibling = recordAcceptedDecision(context.workspace, decision(context, { id: 'r1-other', type: 'ASSIGN_ROLE', target: { laneId: laneId(context, 0) }, toRole: 'Chord5' }));
  const realHead = acceptedRevisionHead(applied(real));
  const siblingHead = acceptedRevisionHead(applied(sibling));
  assert.notEqual(realHead, siblingHead);

  // Record time: the sibling is not the head of this workspace's chain.
  assert.throws(
    () => recordAcceptedDecision(real, decision(context, { id: 'r2', type: 'MOVE_ROLE', target: { laneId: laneId(context, 0) }, fromRole: 'Chord3', toRole: 'Chord4', reviewedRevisionId: siblingHead }), { reviewedRevisionId: siblingHead }),
    /DECISION_REVIEWED_REVISION_NOT_CHAIN_HEAD/,
  );

  // Storage: a record that claims the sibling is applied as the next step
  // against the verified head and refused there by the backend's own code.
  const forged = persist(real);
  const stolen = persist(recordAcceptedDecision(sibling, decision(context, { id: 'r2', type: 'MOVE_ROLE', target: { laneId: laneId(context, 0) }, fromRole: 'Chord5', toRole: 'Chord4', reviewedRevisionId: siblingHead }), { reviewedRevisionId: siblingHead }));
  forged.acceptedDecisions.push(stolen.acceptedDecisions[1]);
  const result = applied(forged);
  assert.equal(result.status, 'FAIL');
  assert.equal(result.chain.length, 2);
  assert.equal(result.chain[0].status, 'PASS', 'the real revision 1 still derives');
  assert.equal(result.chain[1].status, 'FAIL');
  assert.deepEqual(result.chain[1].rejectedCodes, ['STALE_DECISION_REVISION_MISMATCH']);
  assert.equal(result.head.revisionId, realHead, 'the head is the last revision that passed, never the forged step');
  assert.deepEqual(result.staleRevisionClaims, [siblingHead]);
  assert.equal(result.application.candidate, null, 'the refused step produced no candidate');
  assert.equal(result.application.requiresFreshReview, true);
});

// ─── 7, 11, 12. stored / imported parent data is a claim ────────────────────

test('7/12: a stored application with an edited revision or head is reported stale and never used as a parent', () => {
  const context = fixtureWorkspace();
  const { step2 } = chainOf(context);
  const derived = applied(step2);

  const stored = persist(step2);
  stored.assets.candidate.acceptedArrangement = structuredClone(derived);
  const current = analyzeWorkspace(stored).rawMidi[0];
  assert.equal(current.persistedAcceptedArrangement.current, true, 'an honest stored record describes what is loaded');
  assert.equal(current.acceptedArrangement.head.revisionId, derived.head.revisionId);

  // Edit the stored head: the claim no longer matches the re-derived chain.
  const edited = persist(stored);
  edited.assets.candidate.acceptedArrangement.derivation.headRevisionId = 'g11d:rev:' + 'e'.repeat(64);
  edited.assets.candidate.acceptedArrangement.status = 'PASS';
  const report = analyzeWorkspace(edited).rawMidi[0];
  assert.equal(report.persistedAcceptedArrangement.current, false);
  assert.ok(report.persistedAcceptedArrangement.reasons.includes('ACCEPTED_ARRANGEMENT_HEAD_CHANGED'));
  // And the re-derived chain is exactly what it was: the stored record fed nothing.
  assert.equal(JSON.stringify(report.acceptedArrangement), JSON.stringify(derived));

  // Edit the stored revision record itself: reported, not believed.
  const tampered = persist(stored);
  tampered.assets.candidate.acceptedArrangement.application.revision.index = 9;
  assert.equal(revisionIdentityMatches(tampered.assets.candidate.acceptedArrangement.application.revision), false);
  assert.equal(JSON.stringify(analyzeWorkspace(tampered).rawMidi[0].acceptedArrangement), JSON.stringify(derived));
});

test('11: an imported backup claiming a three-revision PASS chain imports no chain at all', () => {
  const context = fixtureWorkspace();
  const { step3 } = chainOf(context);
  const derived = applied(step3);
  assert.equal(derived.status, 'PASS');
  const backup = JSON.stringify({
    ...step3,
    schema: WORKSPACE_SCHEMA,
    assets: { candidate: { ...step3.assets.candidate, acceptedArrangement: { ...derived, status: 'PASS' } } },
  });
  const imported = importWorkspace(backup);
  assert.deepEqual(imported.acceptedDecisions, []);
  assert.equal(imported.importedHistory.acceptedDecisions.length, 3, 'kept as history only');
  const report = analyzeWorkspace(imported).rawMidi[0];
  assert.equal(report.acceptedArrangement.status, 'NOT_REQUESTED');
  assert.equal(report.acceptedArrangement.head, null);
  assert.equal(report.persistedAcceptedArrangement, null, 'the claimed application does not survive re-ingest');
});

test('12: a persisted chain is re-derived and verified before use, never restored', () => {
  const context = fixtureWorkspace();
  const { step3 } = chainOf(context);
  // Nothing derived is stored on the workspace: only the records are.
  assert.equal(step3.assets.candidate.acceptedArrangement, undefined);
  assert.equal(step3.acceptedArrangement, undefined);
  assert.equal(step3.acceptedDecisions.length, 3);
  for (const record of step3.acceptedDecisions) {
    assert.equal(record.decision.acceptance.state, 'ACCEPTED');
    assert.equal(Object.hasOwn(record, 'candidate'), false);
    assert.equal(Object.hasOwn(record, 'application'), false);
  }
  const restored = applied(persist(step3));
  assert.equal(restored.status, 'PASS');
  assert.equal(restored.chain.length, 3);
});

// ─── 8-10. stale baseline / Canonical / reviewed revision ───────────────────

test('8: a chain accepted against one file is entirely refused against another', () => {
  const context = fixtureWorkspace(fixtures.format1());
  const step1 = recordAcceptedDecision(context.workspace, decision(context, { id: 'r1', type: 'ASSIGN_ROLE', target: { laneId: laneId(context, 0) }, toRole: 'Chord3' }));
  const head1 = acceptedRevisionHead(applied(step1));
  const step2 = recordAcceptedDecision(step1, decision(context, { id: 'r2', type: 'MOVE_ROLE', target: { laneId: laneId(context, 0) }, fromRole: 'Chord3', toRole: 'Chord4', reviewedRevisionId: head1 }), { reviewedRevisionId: head1 });
  assert.equal(applied(step2).status, 'PASS');

  const swapped = persist(step2);
  swapped.assets.candidate = intakeMidi({ name: 'other.mid', bytes: fixtures.format1Variant() });
  const result = applied(swapped);
  assert.equal(result.status, 'FAIL');
  assert.equal(result.head, null, 'no revision derives against the other file');
  assert.equal(result.chain[0].status, 'FAIL');
  assert.ok(result.chain[0].rejectedCodes.includes('STALE_DECISION_BASELINE_CHANGED'));
  assert.ok(result.chain[0].rejectedCodes.includes('STALE_DECISION_SOURCE_CHANGED'));
  assert.equal(result.chain.length, 1, 'revision 2 is never attempted when revision 1 did not derive');
});

test('9: a Canonical snapshot the chain was not reviewed under refuses every step', () => {
  const context = fixtureWorkspace();
  const { step2 } = chainOf(context);
  const records = persist(step2).acceptedDecisions;
  // The backend binding is the one that refuses; drive the derivation directly
  // with a project whose Canonical identity is asked to match a different sha.
  const other = structuredClone(records);
  for (const record of other) record.decision.acceptance.canonicalRulesSnapshotSha = 'f'.repeat(40);
  const result = deriveAcceptedArrangement({ project: context.project, suggestion: context.suggestion, records: other, revision: 0 });
  // The record envelope catches the edit first; the binding is what a
  // re-signed record would hit. Both directions are closed.
  assert.notEqual(result.status, 'PASS');
  assert.equal(result.head, null);
});

test('10: a reviewed revision that stopped existing when its step changed is refused', () => {
  const context = fixtureWorkspace();
  const { step2, head1 } = chainOf(context);
  assert.equal(applied(step2).status, 'PASS');
  // Add a decision to revision 1's step in storage. Revision 1 is content-
  // addressed, so it becomes a different revision; revision 2's record still
  // names the old one.
  const drifted = persist(step2);
  const extra = recordAcceptedDecision(context.workspace, decision(context, { id: 'r1-extra', type: 'ASSIGN_ROLE', target: { laneId: laneId(context, 2) }, toRole: 'Chord5' }));
  drifted.acceptedDecisions.push(extra.acceptedDecisions[0]);
  const result = applied(drifted);
  assert.equal(result.chain[0].status, 'PASS');
  assert.notEqual(result.chain[0].revisionId, head1, 'revision 1 is a different revision now');
  assert.equal(result.chain[1].status, 'FAIL');
  assert.deepEqual(result.chain[1].rejectedCodes, ['STALE_DECISION_REVISION_MISMATCH']);
  assert.equal(result.status, 'FAIL');
  assert.deepEqual(result.staleRevisionClaims, [head1]);

  // Record time refuses the same thing up front.
  assert.throws(
    () => recordAcceptedDecision(step2, decision(context, { id: 'r3', type: 'ASSIGN_ROLE', target: { laneId: laneId(context, 1) }, toRole: 'Chord5', reviewedRevisionId: head1 }), { reviewedRevisionId: head1 }),
    /DECISION_REVIEWED_REVISION_NOT_CHAIN_HEAD/,
  );
  assert.throws(
    () => recordAcceptedDecision(step2, decision(context, { id: 'r3', type: 'ASSIGN_ROLE', target: { laneId: laneId(context, 1) }, toRole: 'Chord5' })),
    /DECISION_REVIEWED_REVISION_NOT_CHAIN_HEAD/,
    'a decision reviewed against the baseline cannot be recorded once a revision exists',
  );
});

test('a decision is applied at exactly the step whose parent it names, and re-addressing a step orphans everything after it', () => {
  const context = fixtureWorkspace();
  const { step3, head1, head2 } = chainOf(context);
  const records = persist(step3).acceptedDecisions;
  const rev3Record = records.find(record => record.decision.id === 'r3-assign');
  assert.equal(rev3Record.decision.acceptance.reviewedRevisionId, head2);

  // Only revision 1 and the revision-3 record: revision 2 is missing, so the
  // record names a parent the chain never reaches. It is not applied onto
  // revision 1 in its place.
  const missingMiddle = deriveAcceptedArrangement({ project: context.project, suggestion: context.suggestion, revision: 0, records: records.filter(record => record.decision.id !== 'r2-move') });
  assert.equal(missingMiddle.status, 'FAIL');
  assert.equal(missingMiddle.head.revisionId, head1);
  assert.deepEqual(missingMiddle.chain[1].rejectedCodes, ['STALE_DECISION_REVISION_MISMATCH']);

  // A record re-signed in storage to claim revision 1 as its parent joins
  // revision 1's step -- the step its claim names -- and nothing else. That
  // re-addresses revision 2, so the honest revision-3 record, which names the
  // old revision 2, is refused rather than applied onto the new one.
  const late = records.map(record => structuredClone(record));
  const moved = structuredClone(rev3Record);
  moved.decision.id = 'r4';
  moved.decision.acceptance.reviewedRevisionId = head1;
  moved.recordDigest = acceptedDecisionRecordDigest(moved);
  late.push(moved);
  const lateResult = deriveAcceptedArrangement({ project: context.project, suggestion: context.suggestion, revision: 0, records: late });
  assert.equal(lateResult.status, 'FAIL');
  assert.equal(lateResult.chain[0].revisionId, head1);
  assert.deepEqual(lateResult.chain[1].decisionIds, ['r2-move', 'r4']);
  assert.equal(lateResult.chain[1].status, 'PASS');
  assert.notEqual(lateResult.chain[1].revisionId, head2, 'revision 2 is a different revision once its step changed');
  assert.equal(lateResult.head.revisionId, lateResult.chain[1].revisionId);
  assert.deepEqual(lateResult.chain[2].decisionIds, ['r3-assign']);
  assert.deepEqual(lateResult.chain[2].rejectedCodes, ['STALE_DECISION_REVISION_MISMATCH']);
  assert.deepEqual(lateResult.staleRevisionClaims, [head2]);
});

// ─── 13. invalidation ───────────────────────────────────────────────────────

test('13: a source or settings invalidation drops the chain; a presentation-only review does not', () => {
  const context = fixtureWorkspace();
  const { step3 } = chainOf(context);
  assert.equal(applied(step3).chain.length, 3);

  const bumped = invalidate(step3);
  assert.deepEqual(bumped.acceptedDecisions, []);
  assert.equal(applied(bumped).status, 'NOT_REQUESTED');

  // Records that somehow survive a bump are superseded: reported, not applied.
  const smuggled = { ...persist(step3), revision: step3.revision + 1 };
  const result = applied(smuggled);
  assert.equal(result.status, 'NOT_REQUESTED');
  assert.equal(result.ignoredRecords.length, 3);
  assert.ok(result.ignoredRecords.every(item => item.reason === 'DECISION_RECORD_WORKSPACE_REVISION_MISMATCH'));

  // A human review is presentation at this workspace revision and leaves the chain alone.
  const reviewed = recordReview(step3, 'source', 'reviewed', 'evidence');
  assert.equal(reviewed.revision, step3.revision);
  assert.equal(applied(reviewed).head.revisionId, applied(step3).head.revisionId);
});

// ─── 15. export / import determinism ────────────────────────────────────────

test('15: re-recording the imported history against the same bytes reproduces the same verified chain identity', () => {
  const context = fixtureWorkspace();
  const { step3, head3 } = chainOf(context);
  const imported = importWorkspace(JSON.stringify({ ...step3, schema: WORKSPACE_SCHEMA }));
  assert.equal(applied(imported).status, 'NOT_REQUESTED', 'import grants nothing');

  // The history is data. Re-accepting each decision in order, through the
  // model, against the re-ingested bytes, reproduces the content-addressed
  // chain exactly -- and nothing shorter than that does.
  const rebuilt = { workspace: imported, project: readCanonical(imported.assets.candidate.project), suggestion: null };
  rebuilt.suggestion = deriveArrangement(rebuilt.project, { sourceSha256: imported.assets.candidate.source.sha256 }).candidate;
  let workspace = imported;
  for (const record of imported.importedHistory.acceptedDecisions) {
    const head = acceptedRevisionHead(applied(workspace));
    const { acceptance, schema, supported, ...body } = record.decision;
    workspace = recordAcceptedDecision(workspace, decision(rebuilt, { ...body, reviewedRevisionId: head }), { reviewedRevisionId: head });
  }
  assert.equal(acceptedRevisionHead(applied(workspace)), head3);
  assert.deepEqual(applied(workspace).chain.map(step => step.revisionId), applied(step3).chain.map(step => step.revisionId));
});

test('acceptedArrangementBinding compares a stored head claim only when a derivation is supplied', () => {
  const context = fixtureWorkspace();
  const derived = deriveAcceptedArrangement({ project: context.project, suggestion: context.suggestion, records: [], revision: 0 });
  const stored = { pipeline: ACCEPTED_ARRANGEMENT_PIPELINE, status: 'PASS', derivation: { ...derived.derivation, headRevisionId: 'g11d:rev:claimed' } };
  assert.equal(acceptedArrangementBinding({ stored, project: context.project, revision: 0, derived }).reasons.includes('ACCEPTED_ARRANGEMENT_HEAD_CHANGED'), true);
  const older = { pipeline: 'studio-web/accepted-arrangement@1', status: 'PASS', derivation: {} };
  assert.ok(acceptedArrangementBinding({ stored: older, project: context.project, revision: 0 }).reasons.includes('ACCEPTED_ARRANGEMENT_PIPELINE_VERSION_CHANGED'));
});
