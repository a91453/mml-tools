import test from 'node:test';
import assert from 'node:assert/strict';
import {
  intakeMidi,
  newWorkspace,
  analyzeWorkspace,
  importWorkspace,
  recordAcceptedDecision,
  acceptedDecisionBindings,
  readCanonical,
  WORKSPACE_SCHEMA,
} from '../web/model.mjs';
import { deriveArrangement } from '../web/midi-source.mjs';
import {
  ACCEPTED_DECISION_RECORD_SCHEMA,
  ACCEPTED_DECISION_RECORD_KEYS,
  ACCEPTED_ARRANGEMENT_PIPELINE,
  ACCEPTED_DECISION_AUTHORSHIP,
  ACCEPTED_DECISION_INTEGRITY,
  acceptedDecisionRecordDigest,
  acceptedRevisionHead,
  decisionRecordIntegrity,
  deriveAcceptedArrangement,
} from '../web/arrangement-decisions.mjs';
import { contentDigest } from '../backend/arrangement/decision-application.mjs';
import * as fixtures from './fixtures/midi-fixtures.mjs';

// G11-D residual C: accepted-decision record integrity and its boundary.
//
// A stored record is the reviewer's own data and is mutable. What this layer
// can establish about it is exactly three things, and it says which:
//
//   structural   it has the shape this pipeline writes and constructs;
//   envelope     it agrees with a digest taken over every one of its fields;
//   current      it was accepted at the workspace revision loaded now;
//
// and one thing it cannot: who wrote it. `acceptedBy` is an assertion. A digest
// beside mutable data is not a signature, and no trust root exists to make it
// one. These regressions edit every field one at a time and show each edit is
// detected; then re-sign the record and show that the bindings, not the digest,
// are what refuse a self-consistent record naming other inputs.

const settings = { meterText: '0 4/4', recording: 'synthetic', offset: '0', end: '2', audioRequired: 'no', preview: 'none' };
const persist = workspace => structuredClone(workspace);
const applied = workspace => analyzeWorkspace(workspace).rawMidi[0].acceptedArrangement;

function fixtureWorkspace(bytes = fixtures.sixSourceVoices()) {
  const workspace = { ...newWorkspace(), title: 'fixture', settings, assets: { candidate: intakeMidi({ name: 'song.mid', bytes }) } };
  const project = readCanonical(workspace.assets.candidate.project);
  const suggestion = deriveArrangement(project, { sourceSha256: workspace.assets.candidate.source.sha256 }).candidate;
  return { workspace, project, suggestion };
}

const decisionFor = (context, overrides = {}) => ({
  id: 'web-d1',
  type: 'ASSIGN_ROLE',
  target: { laneId: context.suggestion.lanes[0].id },
  toRole: 'Chord3',
  section: { start: '0', end: '64' },
  reason: 'Reviewed in Studio: this voice is accepted as enrichment.',
  evidence: ['fixture:web review note'],
  acceptance: { ...acceptedDecisionBindings(context), acceptedBy: 'fixture-reviewer', note: 'as reviewed' },
  ...overrides,
});

// One honest recorded workspace, and a way to apply one edit to its record.
function recorded() {
  const context = fixtureWorkspace();
  const workspace = recordAcceptedDecision(context.workspace, decisionFor(context));
  assert.equal(applied(workspace).status, 'PASS');
  return { context, workspace };
}
const edited = (workspace, mutate) => { const next = persist(workspace); mutate(next.acceptedDecisions[0], next); return next; };
const resign = record => { record.recordDigest = acceptedDecisionRecordDigest(record); };

// ─── the envelope covers every field ────────────────────────────────────────

const fieldEdits = [
  ['1 target', record => { record.decision.target = { laneId: null, eventIds: ['some-other-event'] }; }],
  ['2 type', record => { record.decision.type = 'OMIT_FROM_SIX'; record.decision.toRole = null; }],
  ['3 toRole', record => { record.decision.toRole = 'Chord5'; }],
  ['3 toRoles', record => { record.decision.toRoles = ['Chord5']; }],
  ['4 section', record => { record.decision.section = { start: '0', end: '8' }; }],
  ['5 reason', record => { record.decision.reason = 'Rewritten in storage.'; }],
  ['5 evidence', record => { record.decision.evidence = ['fixture:forged']; }],
  ['6 leadEvidence', record => { record.decision.leadEvidence = { sourceIdentity: { sourceId: 'x', sourceEventId: 'y' } }; }],
  ['7 acceptance.reviewedRevisionId', record => { record.decision.acceptance.reviewedRevisionId = 'g11d:rev:invented'; }],
  ['8 acceptance.baselineContentDigest', record => { record.decision.acceptance.baselineContentDigest = 'f'.repeat(64); }],
  ['9 acceptance.sourceIdentityDigest', record => { record.decision.acceptance.sourceIdentityDigest = 'a'.repeat(64); }],
  ['10 acceptance.laneDecompositionDigest', record => { record.decision.acceptance.laneDecompositionDigest = 'b'.repeat(64); }],
  ['11 acceptance.canonicalRulesSnapshotSha', record => { record.decision.acceptance.canonicalRulesSnapshotSha = 'c'.repeat(40); }],
  ['12 acceptance.acceptedBy', record => { record.decision.acceptance.acceptedBy = 'someone-else'; }],
  ['12 acceptance.note', record => { record.decision.acceptance.note = 'edited note'; }],
  ['12 acceptance.state', record => { record.decision.acceptance.state = 'SUGGESTED'; }],
  ['13 record.revision', (record, workspace) => { record.revision = 7; workspace.revision = 7; }],
  ['14 record.pipeline', record => { record.pipeline = 'studio-web/accepted-arrangement@1'; }],
  ['metadata', record => { record.decision.metadata = { forged: true }; }],
];

for (const [label, mutate] of fieldEdits) {
  test(`${label}: an edit to this field leaves a record that no longer agrees with itself, and nothing is applied`, () => {
    const { workspace } = recorded();
    const forged = edited(workspace, mutate);
    const result = applied(forged);
    assert.equal(result.status, 'FAIL');
    assert.equal(result.application, null, 'nothing is applied from an inconsistent record');
    assert.equal(result.head, null);
    assert.equal(result.invalidRecords.length, 1);
    const record = forged.acceptedDecisions[0];
    const integrity = decisionRecordIntegrity(record, forged.revision);
    assert.equal(integrity.envelope, false);
    assert.equal(integrity.usable, false);
    assert.equal(integrity.authorship, ACCEPTED_DECISION_AUTHORSHIP);
    assert.ok(
      ['DECISION_RECORD_DIGEST_MISMATCH', 'DECISION_RECORD_PIPELINE_VERSION_CHANGED'].includes(result.invalidRecords[0].reason)
        || /^DECISION_RECORD_MALFORMED/.test(result.invalidRecords[0].reason),
      `${label}: ${result.invalidRecords[0].reason}`,
    );
  });
}

test('14: a record with an unknown schema is reported as unsupported, not skipped', () => {
  const { workspace } = recorded();
  const forged = edited(workspace, record => { record.schema = 'mml-studio-web/accepted-arrangement-decision@1'; });
  const result = applied(forged);
  assert.equal(result.status, 'FAIL');
  assert.deepEqual(result.invalidRecords.map(item => item.reason), ['DECISION_RECORD_SCHEMA_UNSUPPORTED']);
  const garbage = edited(workspace, (record, next) => { next.acceptedDecisions = ['not a record', null, 42]; });
  assert.equal(applied(garbage).invalidRecords.length, 3);
  assert.ok(applied(garbage).invalidRecords.every(item => item.reason === 'DECISION_RECORD_MALFORMED'));
});

test('15: the pre-hardening body-only digest is not an envelope: recomputing it after an acceptance edit proves nothing', () => {
  const { workspace } = recorded();
  const forged = edited(workspace, record => {
    record.decision.acceptance.reviewedRevisionId = 'g11d:rev:invented';
    // The old scheme: a digest over the decision minus its acceptance block,
    // stored beside it. Recomputing it is exactly what an editor of the old
    // record could do while leaving the acceptance edit undetected.
    const { acceptance, ...body } = record.decision;
    record.contentDigest = contentDigest(body);
  });
  const result = applied(forged);
  assert.equal(result.status, 'FAIL');
  // The old digest is an unknown key now, and the acceptance edit is inside the
  // envelope either way: with the stray key removed the edit itself is caught.
  assert.deepEqual(result.invalidRecords.map(item => item.reason), ['DECISION_RECORD_UNSUPPORTED_FIELD: contentDigest']);
  delete forged.acceptedDecisions[0].contentDigest;
  assert.deepEqual(applied(forged).invalidRecords.map(item => item.reason), ['DECISION_RECORD_DIGEST_MISMATCH']);
});

test('the record key set is an exact allowlist, and the digest refuses anything outside it', () => {
  const { workspace } = recorded();
  const record = workspace.acceptedDecisions[0];
  assert.deepEqual(Object.keys(record).sort(), [...ACCEPTED_DECISION_RECORD_KEYS].sort());
  for (const key of ['status', 'trusted', 'candidate', 'application', 'contentDigest', 'signature']) {
    const forged = edited(workspace, item => { item[key] = 'anything'; });
    const integrity = decisionRecordIntegrity(forged.acceptedDecisions[0], forged.revision);
    assert.equal(integrity.structural, false, key);
    assert.equal(integrity.usable, false, key);
    assert.match(integrity.reasons[0], new RegExp(`^DECISION_RECORD_UNSUPPORTED_FIELD: ${key}$`));
    assert.throws(() => acceptedDecisionRecordDigest(forged.acceptedDecisions[0]), /unsupported field/, key);
    assert.equal(applied(forged).status, 'FAIL', key);
  }
});

// ─── re-signed records reach the bindings, and the bindings refuse them ─────

test('7-11 re-signed: a self-consistent record naming other inputs is refused by the backend bindings, not by the digest', () => {
  const { workspace } = recorded();
  for (const [field, value, code] of [
    ['reviewedRevisionId', 'g11d:rev:invented', 'STALE_DECISION_REVISION_MISMATCH'],
    ['baselineContentDigest', 'f'.repeat(64), 'STALE_DECISION_BASELINE_CHANGED'],
    ['sourceIdentityDigest', 'a'.repeat(64), 'STALE_DECISION_SOURCE_CHANGED'],
    ['laneDecompositionDigest', 'b'.repeat(64), 'STALE_DECISION_LANE_DECOMPOSITION_CHANGED'],
    ['canonicalRulesSnapshotSha', 'c'.repeat(40), 'STALE_DECISION_CANONICAL_CHANGED'],
  ]) {
    const forged = edited(workspace, record => { record.decision.acceptance[field] = value; resign(record); });
    assert.equal(decisionRecordIntegrity(forged.acceptedDecisions[0], forged.revision).usable, true, `${field}: the re-signed record agrees with itself`);
    const result = applied(forged);
    assert.equal(result.status, 'FAIL', field);
    assert.equal(result.invalidRecords.length, 0, `${field}: the digest is not what refuses it`);
    assert.equal(result.application.candidate, null);
    assert.equal(result.application.requiresFreshReview, true);
    assert.ok(result.application.stale.some(item => item.code === code), `${field}: expected ${code}`);
  }
});

test('12 re-signed: acceptedBy is an assertion -- a re-signed edit applies, and the result says authorship is not authenticated', () => {
  const { workspace } = recorded();
  const forged = edited(workspace, record => { record.decision.acceptance.acceptedBy = 'someone-else'; resign(record); });
  const result = applied(forged);
  // Every binding still names the loaded inputs, so the decision applies.
  // That is the honest reading: nothing here can tell a reviewer from an
  // editor of the reviewer's storage.
  assert.equal(result.status, 'PASS');
  assert.equal(result.application.applied[0].acceptedBy, 'someone-else');
  assert.equal(result.integrity.authorship, 'NOT_AUTHENTICATED');
  assert.equal(result.integrity, ACCEPTED_DECISION_INTEGRITY);
  assert.match(result.integrity.notice, /not authenticated/i);
  assert.match(result.integrity.notice, /neither proves who accepted/i);
});

test('13 re-signed: a record re-addressed to another workspace revision is still ignored until the revision really is current', () => {
  const { workspace } = recorded();
  const moved = edited(workspace, record => { record.revision = 3; resign(record); });
  const result = applied(moved);
  assert.equal(result.status, 'NOT_REQUESTED');
  assert.deepEqual(result.ignoredRecords.map(item => item.reason), ['DECISION_RECORD_WORKSPACE_REVISION_MISMATCH']);
});

// ─── honest records keep working ────────────────────────────────────────────

test('16: an unchanged record survives structured-clone persistence and a JSON round trip', () => {
  const { workspace } = recorded();
  const record = workspace.acceptedDecisions[0];
  assert.equal(record.schema, ACCEPTED_DECISION_RECORD_SCHEMA);
  assert.equal(record.pipeline, ACCEPTED_ARRANGEMENT_PIPELINE);
  assert.match(record.recordDigest, /^[0-9a-f]{64}$/);
  assert.equal(Object.hasOwn(record, 'contentDigest'), false, 'the body-only digest no longer exists');
  const integrity = decisionRecordIntegrity(record, workspace.revision);
  assert.deepEqual(integrity, { structural: true, envelope: true, workspaceRevisionCurrent: true, authorship: 'NOT_AUTHENTICATED', usable: true, reasons: [] });
  assert.equal(applied(persist(workspace)).status, 'PASS');
  const viaJson = { ...persist(workspace), acceptedDecisions: JSON.parse(JSON.stringify(workspace.acceptedDecisions)) };
  assert.equal(applied(viaJson).status, 'PASS');
  assert.equal(applied(viaJson).head.revisionId, applied(workspace).head.revisionId);
  // Key order is not part of the envelope.
  const reordered = persist(workspace);
  reordered.acceptedDecisions[0] = Object.fromEntries(Object.entries(record).reverse());
  assert.equal(applied(reordered).status, 'PASS');
});

test('17: an imported stored application is never trusted because its own digests agree', () => {
  const { workspace } = recorded();
  const derived = applied(workspace);
  // A backup carrying a fully self-consistent application (its revision
  // recomputes, its candidate digest matches) and the records that produced
  // it. After import: no records are current, the application is not restored,
  // and analysis reports NOT_REQUESTED. Self-consistency bought nothing.
  const backup = JSON.stringify({
    ...workspace,
    schema: WORKSPACE_SCHEMA,
    assets: { candidate: { ...workspace.assets.candidate, acceptedArrangement: derived } },
  });
  const imported = importWorkspace(backup);
  const report = analyzeWorkspace(imported).rawMidi[0];
  assert.equal(report.acceptedArrangement.status, 'NOT_REQUESTED');
  assert.equal(report.persistedAcceptedArrangement, null);
  // Even a stored application left on the asset in local storage, with a head
  // that agrees with itself, is a claim compared against the re-derived chain.
  const stored = persist(imported);
  stored.assets.candidate.acceptedArrangement = derived;
  const binding = analyzeWorkspace(stored).rawMidi[0].persistedAcceptedArrangement;
  assert.equal(binding.current, false);
  assert.ok(binding.reasons.includes('ACCEPTED_ARRANGEMENT_HEAD_CHANGED'));
  assert.equal(binding.claimedStatus, 'PASS');
});

test('the integrity vocabulary is stated as data on every derivation, including an empty one', () => {
  const context = fixtureWorkspace();
  const empty = deriveAcceptedArrangement({ project: context.project, suggestion: context.suggestion, records: [], revision: 0 });
  assert.equal(empty.integrity, ACCEPTED_DECISION_INTEGRITY);
  assert.equal(empty.integrity.recordEnvelope, 'CONTENT_ADDRESSED_SELF_CONSISTENCY');
  assert.equal(empty.integrity.bindings, 'RE_DERIVED_AT_APPLICATION');
  assert.equal(empty.integrity.authorship, 'NOT_AUTHENTICATED');
  assert.equal(acceptedRevisionHead(empty), null);
  // No export of this module calls the digest a signature or an authentication.
  for (const value of Object.values(ACCEPTED_DECISION_INTEGRITY)) {
    assert.doesNotMatch(String(value), /signature|authenticated by|proves authorship/i);
  }
});
