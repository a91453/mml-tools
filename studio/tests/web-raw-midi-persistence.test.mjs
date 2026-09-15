import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { intakeMidi, intake, newWorkspace, analyzeWorkspace, invalidate, importWorkspace, recordReview, recordAcceptance, REVIEW_NAMES } from '../web/model.mjs';
import { decodeSourceBytes, verifySourceBytes } from '../web/midi-source.mjs';
import * as fixtures from './fixtures/midi-fixtures.mjs';

// Persistence and revision safety for Raw MIDI.
//
// Studio Web stores a workspace in IndexedDB, which persists it by structured
// clone, and exports it as JSON. Both paths are exercised here with the real
// model: the question is not whether the object survives but whether the exact
// byte sequence does, and whether anything judged against the old bytes can
// still be presented as current after they change.
//
// Real IndexedDB, a real reload and a real service worker are covered in
// studio/browser-tests, against Chromium and WebKit.

const settings = { meterText: '0 4/4', recording: 'synthetic', offset: '0', end: '2', audioRequired: 'no', preview: 'none' };
const asset = (name, bytes, id = 'midi') => intakeMidi({ name, bytes, id });
const nodeDigest = bytes => createHash('sha256').update(Buffer.from(bytes)).digest('hex');
const workspaceWith = record => ({ ...newWorkspace(), title: 'fixture', settings, assets: { candidate: record } });

// What IndexedDB does to a stored record, and what saveProject adds to it.
const persist = workspace => ({ ...structuredClone(workspace), saveToken: 'token', savedAt: new Date().toISOString() });

test('a stored workspace keeps the MIDI bytes byte-for-byte', () => {
  const bytes = fixtures.format1();
  const workspace = workspaceWith(asset('song.mid', bytes, 'srcA'));
  const restored = persist(workspace);

  const record = restored.assets.candidate;
  assert.deepEqual([...decodeSourceBytes(record.source.bytesBase64)], [...bytes]);
  assert.equal(record.source.sha256, nodeDigest(bytes));
  assert.equal(record.source.byteLength, bytes.length);
  assert.equal(verifySourceBytes(record).verified, true);
  assert.equal(JSON.stringify(record.project), JSON.stringify(workspace.assets.candidate.project));
});

test('a JSON backup keeps them too, and survives a round trip through text', () => {
  const bytes = fixtures.percussion();
  const workspace = workspaceWith(asset('drums.mid', bytes, 'srcA'));
  const backup = JSON.stringify({ ...workspace, canonical: { canonical_version: '2026-09-13-v1' } });
  const record = JSON.parse(backup).assets.candidate;
  assert.deepEqual([...decodeSourceBytes(record.source.bytesBase64)], [...bytes]);
  assert.equal(nodeDigest(decodeSourceBytes(record.source.bytesBase64)), record.source.sha256);
  // Base64 is the reason: the raw bytes are not valid UTF-8 and a text encoding
  // would have replaced them.
  assert.throws(() => JSON.parse(JSON.stringify({ text: new TextDecoder('utf-8', { fatal: true }).decode(bytes) })), /./);
});

test('reloading re-derives the analysis from the stored bytes and gets the same answer', () => {
  const workspace = workspaceWith(asset('six.mid', fixtures.sixSourceVoices(), 'six'));
  const before = analyzeWorkspace(workspace);
  const after = analyzeWorkspace(persist(workspace));

  assert.equal(before.rawMidi[0].integrity.verified, true);
  assert.equal(after.rawMidi[0].integrity.verified, true);
  assert.equal(JSON.stringify(after.rawMidi[0].arrangement), JSON.stringify(before.rawMidi[0].arrangement));
  assert.equal(after.gates.rawMidiSource.status, 'PASS');
  assert.equal(after.state, before.state);
});

test('a stored record whose bytes no longer parse is refused, not analysed anyway', () => {
  const record = persist(workspaceWith(asset('zero.mid', fixtures.format0(), 'zero'))).assets.candidate;
  // Internally consistent: the stored bytes, the stored length and both digests
  // all agree. They simply are not a MIDI file any more. A digest check alone
  // clears this record; re-reading the bytes through the decoder does not.
  const corrupted = structuredClone(record);
  const text = fixtures.notMidiAtAll();
  corrupted.source.bytesBase64 = Buffer.from(text).toString('base64');
  corrupted.source.byteLength = text.length;
  corrupted.source.sha256 = nodeDigest(text);
  corrupted.project.sources[0].sha256 = corrupted.source.sha256;
  assert.equal(verifySourceBytes(corrupted).verified, true, 'the record is self-consistent');

  const entry = analyzeWorkspace(workspaceWith(corrupted)).rawMidi[0];
  assert.equal(entry.integrity.verified, false);
  assert.ok(entry.integrity.reasons.some(reason => reason.startsWith('SOURCE_BYTES_NO_LONGER_PARSE')));
  assert.equal(entry.arrangement, null, 'no candidate is derived from a source that cannot be re-read');
  assert.equal(analyzeWorkspace(workspaceWith(corrupted)).gates.rawMidiSource.status, 'UNSUPPORTED');
});

// ─── revision safety ────────────────────────────────────────────────────────

test('the same filename with different bytes is a different source', () => {
  const first = asset('song.mid', fixtures.format0(), 'a');
  const second = asset('song.mid', fixtures.format1(), 'b');
  assert.equal(first.name, second.name);
  assert.notEqual(first.source.sha256, second.source.sha256);
  assert.notEqual(first.source.byteLength, second.source.byteLength);
  assert.notEqual(first.project.events.length, second.project.events.length);

  // And the same bytes under a different name are the same source identity.
  const renamed = asset('renamed.mid', fixtures.format0(), 'a');
  assert.equal(renamed.source.sha256, first.source.sha256);
});

test('replacing the source drops every review, decision and acceptance it was judged under', () => {
  let workspace = workspaceWith(asset('song.mid', fixtures.format0(), 'a'));
  workspace.harmonyDecisions = [{ id: 'd1', revision: 0 }];
  workspace.core3Approvals = [{ eventId: 'e1', revision: 0 }];
  workspace.leadEvidence = [{ eventId: 'e1', revision: 0, sourceIdentity: { sourceId: 'a', sourceEventId: 'track:0/event:0' } }];
  workspace.audio = { revision: 0, report: {} };
  for (const name of REVIEW_NAMES) workspace = recordReview(workspace, name, 'reviewed', 'synthetic');
  assert.equal(Object.keys(workspace.reviews).length, REVIEW_NAMES.length);

  // Exactly the transaction putMidiSource performs: invalidate, then install.
  const next = invalidate(workspace);
  next.assets.candidate = asset('song.mid', fixtures.format1(), 'b');

  assert.equal(next.revision, workspace.revision + 1);
  assert.deepEqual(next.reviews, {});
  assert.deepEqual(next.harmonyDecisions, []);
  assert.deepEqual(next.core3Approvals, []);
  assert.deepEqual(next.leadEvidence, []);
  assert.equal(next.audio, null);
  assert.equal(next.acceptance, null);
});

test('a review carried over at the old revision does not count for the new bytes', () => {
  let workspace = workspaceWith(asset('song.mid', fixtures.format0(), 'a'));
  for (const name of REVIEW_NAMES) workspace = recordReview(workspace, name, 'reviewed', 'synthetic');
  const reviewedAt = workspace.revision;

  // A record that kept its reviews across a source change -- the shape a
  // corrupted store or a hand-edited backup could produce.
  const smuggled = structuredClone(workspace);
  smuggled.revision = reviewedAt + 1;
  smuggled.assets.candidate = asset('song.mid', fixtures.format1(), 'b');

  const report = analyzeWorkspace(smuggled);
  for (const name of REVIEW_NAMES) {
    assert.equal(smuggled.reviews[name].revision, reviewedAt, 'the old review text is kept as history');
  }
  assert.equal(report.gates.source.status, 'PENDING', 'but it grants nothing at this revision');
  assert.equal(report.state, 'CANDIDATE');
  assert.ok(report.blockers.includes('source'));
});

test('an accepted in-game record cannot survive a source replacement', () => {
  const mml = 'MML@t120o4c1,t120o3e1,t120o2c1,,,;';
  let workspace = { ...newWorkspace(), title: 'fixture', settings };
  workspace.assets.candidate = intake({ name: 'candidate.mml', content: mml, id: 'c', meterText: '0 4/4' });
  workspace.assets.baseline = intake({ name: 'baseline.mml', content: mml, id: 'b', meterText: '0 4/4' });
  for (const name of REVIEW_NAMES) workspace = recordReview(workspace, name, 'reviewed', 'synthetic');
  assert.equal(analyzeWorkspace(workspace).state, 'VALIDATED');
  workspace = recordAcceptance(workspace, { client: 'synthetic', instrument: 'three-role', evidence: 'synthetic' });
  assert.equal(analyzeWorkspace(workspace).state, 'IN_GAME_ACCEPTED');

  const next = invalidate(workspace);
  next.assets.candidate = asset('song.mid', fixtures.format0(), 'a');
  assert.equal(next.acceptance, null);
  assert.equal(analyzeWorkspace(next).state, 'CANDIDATE');
});

// ─── existing source types stay compatible ──────────────────────────────────

test('a workspace stored before Raw MIDI existed still analyses unchanged', () => {
  const mml = 'MML@t120o4c1,t120o3e1,t120o2c1,,,;';
  let legacy = { ...newWorkspace(), title: 'legacy', settings };
  legacy.assets.candidate = intake({ name: 'candidate.mml', content: mml, id: 'c', meterText: '0 4/4' });
  legacy.assets.baseline = intake({ name: 'baseline.mml', content: mml, id: 'b', meterText: '0 4/4' });
  for (const name of REVIEW_NAMES) legacy = recordReview(legacy, name, 'reviewed', 'synthetic');

  const report = analyzeWorkspace(persist(legacy));
  assert.equal(report.state, 'VALIDATED');
  assert.deepEqual(report.rawMidi, [], 'no Raw MIDI section and no new gate for a project without one');
  assert.equal(report.gates.rawMidiSource, undefined, 'the new gate never appears where it has nothing to say');
  assert.ok(report.tracks, 'the MML delivery path is untouched');
});

test('a backup of a mixed workspace restores every source type', () => {
  const mml = 'MML@t120o4c1,t120o3e1,t120o2c1,,,;';
  let workspace = { ...newWorkspace(), title: 'mixed', settings };
  workspace.assets.candidate = asset('candidate.mid', fixtures.format1(), 'midi');
  workspace.assets.baseline = intake({ name: 'baseline.mml', content: mml, id: 'b', meterText: '0 4/4' });
  workspace.assets.previous = intake({ name: 'previous.mml', content: mml, id: 'p', meterText: '0 4/4' });
  for (const name of REVIEW_NAMES) workspace = recordReview(workspace, name, 'reviewed', 'synthetic');

  const restored = importWorkspace(JSON.stringify(persist(workspace)));
  assert.equal(restored.assets.candidate.format, 'MIDI');
  assert.equal(restored.assets.baseline.format, 'MML');
  assert.equal(restored.assets.previous.format, 'MML');
  assert.equal(restored.assets.candidate.source.sha256, workspace.assets.candidate.source.sha256);
  assert.deepEqual([...decodeSourceBytes(restored.assets.candidate.source.bytesBase64)], [...fixtures.format1()]);

  // A portable backup cannot attest who reviewed what, so its reviews come back
  // as history and this round has to be reviewed again.
  assert.deepEqual(restored.reviews, {});
  assert.equal(Object.keys(restored.importedHistory.reviews).length, REVIEW_NAMES.length);
  assert.equal(analyzeWorkspace(restored).state, 'CANDIDATE');
});

test('a backup missing its MIDI bytes is refused rather than restored empty', () => {
  const workspace = workspaceWith(asset('song.mid', fixtures.format0(), 'a'));
  const stripped = JSON.parse(JSON.stringify(workspace));
  delete stripped.assets.candidate.source.bytesBase64;
  assert.throws(() => importWorkspace(JSON.stringify(stripped)), /MIDI source bytes are missing/);
});

test('a record claiming the MIDI format without a source block is a verdict, not a crash', () => {
  const broken = { name: 'claims.mid', format: 'MIDI', project: asset('zero.mid', fixtures.format0(), 'zero').project, complete: true, warnings: [], errors: [], unsupported: [] };
  const report = analyzeWorkspace(workspaceWith(broken));
  const entry = report.rawMidi[0];
  assert.equal(entry.integrity.verified, false);
  assert.deepEqual(entry.integrity.reasons, ['SOURCE_BYTES_MISSING']);
  assert.equal(entry.source.sha256, null);
  assert.equal(entry.complete, false, 'the record\'s own claim grants nothing');
  assert.equal(entry.claimedComplete, true);
  assert.equal(entry.arrangement, null);
  assert.equal(report.gates.rawMidiSource.status, 'UNSUPPORTED');
  assert.equal(report.state, 'CANDIDATE');
});
