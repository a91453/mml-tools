import test from 'node:test';
import assert from 'node:assert/strict';
import {
  intakeMidi,
  newWorkspace,
  analyzeWorkspace,
  importWorkspace,
  recordAcceptedDecision,
  recordLeadEvidence,
  acceptedDecisionBindings,
  readCanonical,
  WORKSPACE_SCHEMA,
} from '../web/model.mjs';
import { deriveArrangement } from '../web/midi-source.mjs';
import { acceptedDecisionRecordDigest, acceptedRevisionHead } from '../web/arrangement-decisions.mjs';
import * as fixtures from './fixtures/midi-fixtures.mjs';

// Persisted and imported workspace data is a set of claims. Each case below
// hands the model a workspace that claims something it should not get, and
// checks that the claim buys nothing: not because its status says PASS, not
// because its digests agree with each other, not because it is newer, and not
// because it once described a real result.

const settings = { meterText: '0 4/4', recording: 'synthetic', offset: '0', end: '2', audioRequired: 'no', preview: 'none' };
const persist = workspace => structuredClone(workspace);
const applied = workspace => analyzeWorkspace(workspace).rawMidi[0].acceptedArrangement;
// Re-sign a record after an edit. A record whose decision no longer constructs
// cannot be signed at all -- the digest function refuses it the way the model
// will -- so such an edit is left with its stale digest and is caught either way.
const resign = record => { try { record.recordDigest = acceptedDecisionRecordDigest(record); } catch { /* unsignable: left stale */ } };

function fixtureWorkspace(bytes = fixtures.sixSourceVoices()) {
  const workspace = { ...newWorkspace(), title: 'fixture', settings, assets: { candidate: intakeMidi({ name: 'song.mid', bytes }) } };
  const project = readCanonical(workspace.assets.candidate.project);
  const suggestion = deriveArrangement(project, { sourceSha256: workspace.assets.candidate.source.sha256 }).candidate;
  return { workspace, project, suggestion };
}
const decisionFor = (context, { id = 'd1', reviewedRevisionId = null, laneIndex = 0, toRole = 'Chord3' } = {}) => ({
  id, type: 'ASSIGN_ROLE', target: { laneId: context.suggestion.lanes[laneIndex].id }, toRole,
  reason: `Reviewed in Studio: ${id}.`, evidence: [`fixture:${id}`],
  acceptance: { ...acceptedDecisionBindings({ ...context, reviewedRevisionId }), acceptedBy: 'fixture-reviewer' },
});
function twoRevisions(context = fixtureWorkspace()) {
  const one = recordAcceptedDecision(context.workspace, decisionFor(context));
  const head1 = acceptedRevisionHead(applied(one));
  const two = recordAcceptedDecision(one, decisionFor(context, { id: 'd2', laneIndex: 1, toRole: 'Chord4', reviewedRevisionId: head1 }), { reviewedRevisionId: head1 });
  return { context, workspace: two, head1 };
}

test('missing fields: a record without a digest, decision, revision or schema is invalid, never applied', () => {
  const { workspace } = twoRevisions();
  for (const field of ['recordDigest', 'decision', 'revision', 'schema', 'pipeline']) {
    const forged = persist(workspace);
    delete forged.acceptedDecisions[0][field];
    const result = applied(forged);
    assert.equal(result.status, field === 'revision' ? 'FAIL' : 'FAIL', field);
    assert.equal(result.application, null, field);
  }
  // A workspace with no acceptedDecisions array at all analyses as having none.
  const bare = persist(workspace);
  delete bare.acceptedDecisions;
  assert.equal(applied(bare).status, 'NOT_REQUESTED');
});

test('unknown fields: an extra field on the record or the decision is not silently honoured', () => {
  const { workspace } = twoRevisions();
  const onRecord = persist(workspace);
  onRecord.acceptedDecisions[0].trusted = true;
  onRecord.acceptedDecisions[0].status = 'PASS';
  // Record-level extras are outside the envelope and outside what is read;
  // the record still applies exactly as before, and the extras do nothing.
  assert.equal(applied(onRecord).status, 'PASS');
  assert.equal(JSON.stringify(applied(onRecord)), JSON.stringify(applied(workspace)));
  const onDecision = persist(workspace);
  onDecision.acceptedDecisions[0].decision.octaveShift = -1;
  assert.throws(() => acceptedDecisionRecordDigest(onDecision.acceptedDecisions[0]), /unsupported field: octaveShift/, 'a decision with an unknown field cannot even be signed');
  const result = applied(onDecision);
  assert.equal(result.status, 'FAIL');
  assert.match(result.invalidRecords[0].reason, /DECISION_RECORD_MALFORMED.*unsupported field/);
});

test('wrong or stale schema: a record from another schema or pipeline is reported, not read', () => {
  const { workspace } = twoRevisions();
  const wrongSchema = persist(workspace);
  wrongSchema.acceptedDecisions[1].schema = 'mml-studio-web/something-else@9';
  assert.deepEqual(applied(wrongSchema).invalidRecords.map(item => item.reason), ['DECISION_RECORD_SCHEMA_UNSUPPORTED']);
  const stalePipeline = persist(workspace);
  stalePipeline.acceptedDecisions[1].pipeline = 'studio-web/accepted-arrangement@1';
  resign(stalePipeline.acceptedDecisions[1]);
  assert.deepEqual(applied(stalePipeline).invalidRecords.map(item => item.reason), ['DECISION_RECORD_PIPELINE_VERSION_CHANGED']);
  const wrongWorkspace = JSON.stringify({ ...workspace, schema: 'mml-studio-web/workspace@0' });
  assert.throws(() => importWorkspace(wrongWorkspace), /UNSUPPORTED: workspace schema/);
});

test('malformed revision record: a reviewedRevisionId that is not a revision is stale at the backend, never applied', () => {
  const { workspace, head1 } = twoRevisions();
  for (const value of ['', 'g11d:rev:', 'not-a-revision', head1.toUpperCase(), 42]) {
    const forged = persist(workspace);
    forged.acceptedDecisions[1].decision.acceptance.reviewedRevisionId = value;
    resign(forged.acceptedDecisions[1]);
    const result = applied(forged);
    assert.notEqual(result.status, 'PASS', String(value));
    if (result.application) assert.equal(result.application.candidate, null, String(value));
  }
});

test('altered candidate: the stored project is data; the bytes are the source', () => {
  const { workspace } = twoRevisions();
  const forged = persist(workspace);
  forged.assets.candidate.project.events[0].role = 'Melody';
  const report = analyzeWorkspace(forged).rawMidi[0];
  assert.equal(report.integrity.verified, false);
  assert.ok(report.integrity.reasons.includes('STORED_PROJECT_DOES_NOT_MATCH_SOURCE_BYTES'));
  assert.equal(report.acceptedArrangement, null, 'nothing is derived over a project the bytes do not support');
});

test('altered decision and altered acceptance: detected by the envelope; re-signed, refused by the bindings', () => {
  const { workspace } = twoRevisions();
  const decisionEdit = persist(workspace);
  decisionEdit.acceptedDecisions[1].decision.toRole = 'Melody';
  assert.deepEqual(applied(decisionEdit).invalidRecords.map(item => item.reason), ['DECISION_RECORD_DIGEST_MISMATCH']);
  const acceptanceEdit = persist(workspace);
  acceptanceEdit.acceptedDecisions[1].decision.acceptance.baselineContentDigest = '0'.repeat(64);
  assert.deepEqual(applied(acceptanceEdit).invalidRecords.map(item => item.reason), ['DECISION_RECORD_DIGEST_MISMATCH']);
  resign(acceptanceEdit.acceptedDecisions[1]);
  const result = applied(acceptanceEdit);
  assert.equal(result.invalidRecords.length, 0);
  assert.equal(result.status, 'FAIL');
  assert.ok(result.application.stale.some(item => item.code === 'STALE_DECISION_BASELINE_CHANGED'));
  assert.equal(result.chain[0].status, 'PASS', 'the honest revision 1 still derives');
  assert.equal(result.head.index, 1);
});

test('forged stored application: a PASS on the asset, with agreeing digests, is a claim compared against the re-derived chain', () => {
  const { workspace } = twoRevisions();
  const derived = applied(workspace);
  const stored = persist(workspace);
  stored.assets.candidate.acceptedArrangement = { ...derived, status: 'PASS', application: { ...derived.application, status: 'PASS' } };
  // Honest copy: current, but still only reported.
  assert.equal(analyzeWorkspace(stored).rawMidi[0].persistedAcceptedArrangement.current, true);
  // Remove the records and keep the stored application: nothing is derived from it.
  const orphan = persist(stored);
  orphan.acceptedDecisions = [];
  const report = analyzeWorkspace(orphan).rawMidi[0];
  assert.equal(report.acceptedArrangement.status, 'NOT_REQUESTED');
  assert.equal(report.persistedAcceptedArrangement.current, false);
  assert.ok(report.persistedAcceptedArrangement.reasons.includes('ACCEPTED_ARRANGEMENT_HEAD_CHANGED'));
  assert.equal(report.persistedAcceptedArrangement.claimedStatus, 'PASS');
});

test('stale Canonical snapshot: a chain bound to another rules snapshot is refused at its first step', () => {
  const { workspace } = twoRevisions();
  const forged = persist(workspace);
  for (const record of forged.acceptedDecisions) {
    record.decision.acceptance.canonicalRulesSnapshotSha = '1'.repeat(40);
    resign(record);
  }
  const result = applied(forged);
  assert.equal(result.status, 'FAIL');
  assert.equal(result.head, null);
  assert.ok(result.chain[0].rejectedCodes.includes('STALE_DECISION_CANONICAL_CHANGED'));
});

test('same project id, different content: the id is derived from the bytes, so different bytes are a different project', () => {
  const { workspace } = twoRevisions(fixtureWorkspace(fixtures.format1()));
  const other = intakeMidi({ name: 'song.mid', bytes: fixtures.format1Variant() });
  assert.notEqual(other.project.id, workspace.assets.candidate.project.id);
  // Force the id to agree while the content does not: the bytes disagree with
  // the stored project and nothing is derived.
  const forged = persist(workspace);
  forged.assets.candidate = { ...other, project: { ...other.project, id: workspace.assets.candidate.project.id } };
  const report = analyzeWorkspace(forged).rawMidi[0];
  assert.equal(report.integrity.verified, false);
  assert.equal(report.acceptedArrangement, null);
});

test('same baseline content, different source identity: the source digest binding refuses it', () => {
  // The same MIDI bytes ingested under a different authority produce the same
  // events and a different source record, so the baseline content digest and
  // the source identity digest both move. A decision bound to one is refused
  // against the other on its own codes.
  const { workspace } = twoRevisions();
  const swapped = persist(workspace);
  swapped.assets.candidate = intakeMidi({ name: 'song.mid', bytes: fixtures.sixSourceVoices(), authority: 'primary-symbolic' });
  const result = applied(swapped);
  assert.equal(result.status, 'FAIL');
  assert.ok(result.chain[0].rejectedCodes.includes('STALE_DECISION_SOURCE_CHANGED'));
});

test('old revision chain imported into a new source workspace: history only, and re-attaching it is refused', () => {
  const { workspace } = twoRevisions();
  // A fresh workspace over different bytes, restored from a backup that carried
  // the old chain's records.
  const backup = JSON.parse(JSON.stringify({ ...workspace, schema: WORKSPACE_SCHEMA }));
  backup.assets.candidate = intakeMidi({ name: 'other.mid', bytes: fixtures.format1() });
  const imported = importWorkspace(JSON.stringify(backup));
  assert.deepEqual(imported.acceptedDecisions, []);
  assert.equal(applied(imported).status, 'NOT_REQUESTED');
  // Copying the history back in by hand -- what a hand-edited restore does --
  // is refused by the bindings at the first step.
  const reattached = persist(imported);
  reattached.acceptedDecisions = imported.importedHistory.acceptedDecisions;
  const result = applied(reattached);
  assert.equal(result.status, 'FAIL');
  assert.equal(result.head, null);
  assert.ok(result.chain[0].rejectedCodes.includes('STALE_DECISION_BASELINE_CHANGED'));
});

test('stored Lead evidence follows the same rule: an imported record is history and a hand-restored one is judged against the baseline event', () => {
  const baseline = intakeMidi({ name: 'song.mid', bytes: fixtures.sixSourceVoices() });
  const workspace = { ...newWorkspace(), title: 'fixture', settings, assets: { candidate: baseline, baseline } };
  // Raw MIDI baselines carry no Melody role, so no Lead record can be made
  // against them at all -- and one restored by hand is a PENDING report, never
  // a PASS.
  assert.throws(() => recordLeadEvidence(workspace, { eventId: baseline.project.events[0].id, destinationRole: 'Chord1' }), /Melody/);
  const restored = persist(workspace);
  restored.leadEvidence = [{ eventId: baseline.project.events[0].id, destinationRole: 'Chord1', revision: 0, sourceIdentity: { sourceId: baseline.source.id, sourceEventId: baseline.project.events[0].sourceEventIds[0] } }];
  const report = analyzeWorkspace(restored);
  assert.equal(report.leadReports.length, 1);
  assert.notEqual(report.leadReports[0].status, 'PASS');
});
