import test from 'node:test';
import assert from 'node:assert/strict';
import { acceptPreviewedDecision, analyzeWorkspace, clearAcceptedDecisions, intakeMidi, invalidate, newWorkspace, previewAcceptedDecision, readCanonical, COMPOSER_ACCEPTED_BY } from '../web/model.mjs';
import { deriveArrangement } from '../web/midi-source.mjs';
import * as fixtures from './fixtures/midi-fixtures.mjs';

// The Decision Composer: the page names the events and the move; the Worker
// fills every binding, previews without writing, and records only the record
// whose digest was previewed.

const settings = { meterText: '0 4/4', recording: 'synthetic', offset: '0', end: '2', audioRequired: 'no', preview: 'none' };
function fixture() {
  const workspace = { ...newWorkspace(), title: 'fixture', settings, assets: { candidate: intakeMidi({ name: 'song.mid', bytes: fixtures.sixSourceVoices() }) } };
  const project = readCanonical(workspace.assets.candidate.project);
  const suggestion = deriveArrangement(project, { sourceSha256: workspace.assets.candidate.source.sha256 }).candidate;
  return { workspace, lanes: suggestion.lanes };
}
const draft = (eventIds, fields = {}) => ({ type: 'ASSIGN_ROLE', eventIds, toRole: 'Chord3', reason: 'Reviewed on the roll: this voice is enrichment.', evidence: 'fixture:roll review', ...fields });

test('a preview fills the bindings itself, writes nothing, and projects the would-be roll', () => {
  const { workspace, lanes } = fixture();
  const before = structuredClone(workspace);
  const ids = lanes[0].eventIds;
  const preview = previewAcceptedDecision(workspace, draft(ids));
  assert.deepEqual(workspace, before, 'a preview never mutates the workspace');
  assert.equal(preview.status, 'PASS');
  assert.equal(preview.reviewedRevisionId, null);
  assert.equal(preview.decision.id, `web:g11d:${workspace.revision}:1`);
  assert.equal(preview.decision.acceptance.acceptedBy, COMPOSER_ACCEPTED_BY);
  assert.match(preview.decision.acceptance.baselineContentDigest, /\S/);
  assert.match(preview.recordDigest, /^[0-9a-f]{64}$|^sha256:/);
  assert.deepEqual(preview.applied[0].events.map(e => e.toRole), ids.map(() => 'Chord3'));
  const chord3 = preview.roll.lanes.find(lane => lane.role === 'Chord3');
  assert.deepEqual(chord3.events.map(e => e.id).sort(), [...ids].sort());
  assert.equal(previewAcceptedDecision(workspace, draft(ids)).recordDigest, preview.recordDigest, 'the digest is deterministic');
});

test('the page cannot supply an acceptance, an id or an unknown field', () => {
  const { workspace, lanes } = fixture();
  const ids = lanes[0].eventIds;
  for (const extra of [{ acceptance: {} }, { id: 'mine' }, { target: { laneId: 'x' } }, { reviewedRevisionId: 'r' }]) {
    assert.throws(() => previewAcceptedDecision(workspace, { ...draft(ids), ...extra }), /may not carry/);
  }
  assert.throws(() => previewAcceptedDecision(workspace, draft([])), /至少一個事件/);
  assert.throws(() => previewAcceptedDecision(workspace, draft(['no-such-event'])), /不在目前的來源/);
  assert.throws(() => previewAcceptedDecision(workspace, draft(ids, { type: 'TRANSFORM_TIMING' })), /unsupported decision type/);
});

test('accepting records exactly the previewed record, and refuses anything else', () => {
  const { workspace, lanes } = fixture();
  const ids = lanes[0].eventIds;
  const preview = previewAcceptedDecision(workspace, draft(ids));
  assert.throws(() => acceptPreviewedDecision(workspace, draft(ids), { expectedRecordDigest: 'other' }), /STALE_ACCEPTED_DECISION/);
  assert.throws(() => acceptPreviewedDecision(workspace, draft(ids, { reason: 'A different reason.' }), { expectedRecordDigest: preview.recordDigest }), /STALE_ACCEPTED_DECISION/);
  const next = acceptPreviewedDecision(workspace, draft(ids), { expectedRecordDigest: preview.recordDigest });
  assert.equal(next.acceptedDecisions.length, 1);
  assert.equal(next.acceptedDecisions[0].recordDigest, preview.recordDigest);
  const report = analyzeWorkspace(next);
  const accepted = report.rawMidi.find(entry => entry.slot === 'candidate').acceptedArrangement;
  assert.equal(accepted.status, 'PASS');
  assert.deepEqual(report.acceptedRoll.lanes.find(lane => lane.role === 'Chord3').events.map(e => e.id).sort(), [...ids].sort());
  assert.equal(report.state, 'CANDIDATE', 'an accepted arrangement decision validates nothing');

  // The next decision is reviewed against the new head, and MOVE_ROLE takes
  // its fromRole from that head, never from the page.
  const move = previewAcceptedDecision(next, draft(ids, { type: 'MOVE_ROLE', toRole: 'Chord4' }));
  assert.equal(move.reviewedRevisionId, accepted.head.revisionId);
  assert.equal(move.decision.fromRole, 'Chord3');
  assert.equal(move.decision.id, `web:g11d:${next.revision}:2`);
  assert.equal(move.status, 'PASS');
  // The same preview no longer matches once the chain has moved on.
  assert.throws(() => acceptPreviewedDecision(next, draft(ids), { expectedRecordDigest: preview.recordDigest }), /STALE_ACCEPTED_DECISION/);
});

test('a decision the backend refuses previews as not PASS and cannot be accepted', () => {
  const { workspace, lanes } = fixture();
  const ids = lanes[0].eventIds;
  // MOVE_ROLE needs the events to be assigned already; on the baseline they are not.
  assert.throws(() => previewAcceptedDecision(workspace, draft(ids, { type: 'MOVE_ROLE', toRole: 'Chord4' })), /同屬一個角色/);
  const dup = previewAcceptedDecision(workspace, draft(ids, { type: 'OMIT_FROM_SIX', toRole: undefined }));
  assert.equal(dup.status, 'PASS');
  const bad = { ...draft(ids, { type: 'DUPLICATE_WITH_JUSTIFICATION', toRole: undefined, toRoles: ['Chord4'] }) };
  delete bad.toRole;
  assert.throws(() => previewAcceptedDecision(workspace, bad), /同屬一個角色/);
  // Moving assigned material into Melody needs Lead evidence the composer does
  // not collect: the backend holds it, and the preview says so.
  const first = previewAcceptedDecision(workspace, draft(ids));
  const next = acceptPreviewedDecision(workspace, draft(ids), { expectedRecordDigest: first.recordDigest });
  const lead = previewAcceptedDecision(next, draft(ids, { type: 'MOVE_ROLE', toRole: 'Melody' }));
  assert.notEqual(lead.status, 'PASS');
  assert.equal(lead.roll, null);
  assert.ok([...lead.rejected, ...lead.diagnostics].some(item => /LEAD/.test(item.code)), JSON.stringify([lead.rejected, lead.diagnostics]));
  assert.throws(() => acceptPreviewedDecision(next, draft(ids, { type: 'MOVE_ROLE', toRole: 'Melody' }), { expectedRecordDigest: lead.recordDigest }), /不能接受/);
});

test('the composer is closed where decisions cannot hold', () => {
  const { workspace, lanes } = fixture();
  const ids = lanes[0].eventIds;
  assert.throws(() => previewAcceptedDecision({ ...workspace, finalReduction: { plan: {} } }, draft(ids)), /UNSUPPORTED/);
  assert.throws(() => previewAcceptedDecision({ ...workspace, mobileAdaptation: { plan: {} } }, draft(ids)), /UNSUPPORTED/);
  const preview = previewAcceptedDecision(workspace, draft(ids));
  const next = acceptPreviewedDecision(workspace, draft(ids), { expectedRecordDigest: preview.recordDigest });
  assert.equal(invalidate(next).acceptedDecisions.length, 0);
  assert.equal(clearAcceptedDecisions(next).acceptedDecisions.length, 0);
});
