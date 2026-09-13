import test from 'node:test';
import assert from 'node:assert/strict';
import { newWorkspace, intake, analyzeWorkspace, invalidate, recordReview, recordAcceptance, importWorkspace, readCanonical, REVIEW_NAMES } from '../web/model.mjs';
import { verifyCanonicalPackage } from '../web/canonical-package.mjs';
import { loadPublishedCanonical } from '../backend/bootstrap/index.mjs';
import { createHash } from 'node:crypto';

const mml = 'MML@t120o4c1,t120o3e1,t120o2c1,,,;';
function workspace() {
  const w = newWorkspace();
  w.title = 'Synthetic test';
  w.settings = { meterText: '0 4/4', recording: 'synthetic version 1', offset: '0', end: '2', audioRequired: 'no', preview: 'none' };
  for (const slot of ['candidate', 'baseline', 'previous']) w.assets[slot] = intake({ name: `${slot}.mml`, content: mml, id: slot, meterText: w.settings.meterText });
  return w;
}
test('existing parsers run locally and syntax success never promotes a song', () => {
  const report = analyzeWorkspace(workspace());
  assert.equal(report.technical.ok, true);
  assert.equal(report.state, 'CANDIDATE');
  assert.ok(report.blockers.includes('core3'));
  assert.equal(report.tracks.length, 6);
});
test('layered review can validate; only an explicit exact-MML user record accepts', () => {
  let w = workspace();
  assert.throws(() => recordAcceptance(w, {}));
  for (const name of REVIEW_NAMES) w = recordReview(w, name, 'Reviewed synthetic fixture', 'fixture:whole-piece');
  assert.equal(analyzeWorkspace(w).state, 'VALIDATED');
  w = recordAcceptance(w, { client: 'test-client', instrument: 'three-role piano', evidence: 'controlled fixture only' });
  assert.equal(analyzeWorkspace(w).state, 'IN_GAME_ACCEPTED');
  assert.equal(analyzeWorkspace(invalidate(w)).state, 'CANDIDATE');
  assert.equal(analyzeWorkspace(importWorkspace(JSON.stringify(w))).state, 'CANDIDATE');
});
test('unsupported navigation stays blocked despite all human reviews', () => {
  let w = workspace();
  w.assets.baseline.unsupported = [{ code: 'REPEAT_BARLINE' }];
  for (const name of REVIEW_NAMES) w = recordReview(w, name, 'reviewed', 'source');
  assert.equal(analyzeWorkspace(w).gates.source.status, 'UNSUPPORTED');
  assert.equal(analyzeWorkspace(w).state, 'CANDIDATE');
});
test('malformed IR and imported PASS metadata do not grant authority', () => {
  const w = workspace();
  const project = structuredClone(w.assets.candidate.project);
  project.events[0].kind = 'unknown';
  assert.throws(() => readCanonical(project), /UNSUPPORTED/);
  w.assets.candidate.project = { ...w.assets.candidate.project, metadata: { sourceComplete: true, inGameAcceptance: 'PASS', audioAlignmentEvidence: [{ warnings: [] }] } };
  w.settings.audioRequired = 'yes';
  assert.equal(analyzeWorkspace(w).gates.originalAudio.status, 'PENDING');
});
test('missing meter and mismatched delivery cannot be copied as verified MML', () => {
  const w = workspace();
  w.settings.meterText = '';
  assert.equal(analyzeWorkspace(w).tracks, null);
  w.settings.meterText = '0 4/4';
  w.assets.candidate.format = 'Canonical IR';
  w.deliveryMml = mml.replace('o4c1', 'o4d1');
  assert.equal(analyzeWorkspace(w).tracks, null);
});
test('browser package validates exact published bytes and fails closed on corruption', async () => {
  const bundle = loadPublishedCanonical();
  const digest = createHash('sha256').update(JSON.stringify(bundle)).digest('hex');
  await verifyCanonicalPackage(bundle, digest);
  await assert.rejects(verifyCanonicalPackage({ ...bundle, documents: [] }, digest), /CANONICAL_NOT_LOADED/);
  await assert.rejects(verifyCanonicalPackage(bundle, null), /CANONICAL_NOT_LOADED/);
});

test('manual reviews cannot validate or expose delivery with an unverified high named pitch', () => {
  let w = workspace();
  for (const slot of ['candidate', 'baseline']) w.assets[slot] = intake({
    name: `${slot}.mml`, id: slot, meterText: w.settings.meterText,
    content: mml.replace('o4c1', 'o8c1'),
  });
  for (const name of REVIEW_NAMES) w = recordReview(w, name, 'reviewed', 'fixture');
  const r = analyzeWorkspace(w);
  assert.equal(r.state, 'CANDIDATE');
  assert.equal(r.gates.technical.status, 'FAIL');
  assert.equal(r.rawMml, null);
  assert.equal(r.tracks, null);
  assert.throws(() => recordAcceptance(w, { client: 'fixture', instrument: 'piano', evidence: 'fixture' }));
});
