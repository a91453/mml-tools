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
  // The browser receives the shipped runtime bundle, which excludes the dynamic
  // Git provenance the build records in build.json instead.
  const { provenance, ...bundle } = loadPublishedCanonical();
  const digestOf = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
  const digest = digestOf(bundle);
  await verifyCanonicalPackage(bundle, digest);
  await assert.rejects(verifyCanonicalPackage({ ...bundle, documents: [] }, digest), /CANONICAL_NOT_LOADED/);
  await assert.rejects(verifyCanonicalPackage(bundle, null), /CANONICAL_NOT_LOADED/);
  // Provenance inside the hashed bundle is what made buildId unreproducible.
  const contaminated = { ...bundle, provenance };
  await assert.rejects(verifyCanonicalPackage(contaminated, digestOf(contaminated)), /CANONICAL_NOT_LOADED/);
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

test('restored unknown or non-finite music ranges cannot pass intake even after review', () => {
  let w = workspace();
  for (const name of REVIEW_NAMES) w = recordReview(w, name, 'reviewed', 'fixture');
  for (const range of [{ end: 'Infinity' }, { end: Infinity }, { offset: null }, { offset: ' ' }, { offset: false }]) {
    const r = analyzeWorkspace({ ...w, settings: { ...w.settings, ...range } });
    assert.equal(r.gates.intake.status, 'PENDING', JSON.stringify(range));
    assert.equal(r.state, 'CANDIDATE');
  }
  assert.equal(analyzeWorkspace(w).gates.intake.status, 'PASS');
});

// G10 C2B. The web layer must surface the real backend micro-timing result and
// must not re-decide sub-grid meaning for itself.
const SUB_GRID_END = '1/17';
function canonicalIr({ events, decisions = [] }) {
  return JSON.stringify({
    schema: 'mabinogi-mobile-mml-studio/canonical-project@2',
    id: 'micro-timing-fixture',
    title: 'Micro-timing fixture',
    sources: [{ id: 'official', label: 'Official score', kind: 'official-musicxml', authority: 'primary-symbolic', sha256: null, metadata: {} }],
    events,
    tempoEvents: [],
    meterEvents: [],
    decisions,
    metadata: { sourceComplete: true },
  });
}
function irNote({ id, start, end, role = 'Melody', pitch = 60 }) {
  return { kind: 'note', id, pitch, start, end, role, voice: null, volume: null, sourceIds: ['official'], sourceEventIds: [`${id}/official`], tags: [], metadata: {} };
}
function irWorkspace(content) {
  const w = newWorkspace();
  w.title = 'Micro-timing fixture';
  w.settings = { meterText: '0 4/4', recording: 'synthetic version 1', offset: '0', end: '2', audioRequired: 'no', preview: 'none' };
  for (const slot of ['candidate', 'baseline']) w.assets[slot] = intake({ name: `${slot}.json`, content, id: slot, meterText: w.settings.meterText });
  return w;
}

test('the web report surfaces the backend micro-timing gate rather than its own verdict', () => {
  const report = analyzeWorkspace(workspace());
  assert.equal(Object.hasOwn(report.gates, 'microTiming'), true);
  // Identity, not a copy: the web layer passes the analyzed backend result
  // through untouched instead of reimplementing classification.
  assert.equal(report.gates.microTiming, report.readiness.gates.microTiming);
  assert.equal(report.gates.microTiming.status, 'PASS');
  assert.equal(report.gates.microTiming.finalRepresentable, null);
  assert.ok(!report.blockers.includes('microTiming'));
});

test('a sub-grid candidate blocks the web workspace even after every human review', () => {
  let w = irWorkspace(canonicalIr({ events: [irNote({ id: 'micro', start: '0', end: SUB_GRID_END })] }));
  for (const name of REVIEW_NAMES) w = recordReview(w, name, 'reviewed', 'fixture');
  const report = analyzeWorkspace(w);
  assert.equal(report.gates.microTiming.status, 'PENDING');
  assert.equal(report.gates.microTiming.candidateCount, 1);
  assert.equal(report.gates.microTiming.unknownCount, 1);
  assert.ok(report.blockers.includes('microTiming'));
  assert.equal(report.state, 'CANDIDATE');
});

test('an imported accepted micro-timing keep cannot grant a web micro-timing PASS', () => {
  const event = irNote({ id: 'micro', start: '0', end: SUB_GRID_END });
  let w = irWorkspace(canonicalIr({
    events: [event],
    decisions: [{
      id: 'imported:keep',
      eventIds: ['micro'],
      action: 'micro-timing:keep-as-source-supported',
      status: 'accepted',
      reason: 'Imported claim of source support',
      evidence: ['imported evidence string'],
      metadata: {
        intervalIdentity: { type: 'event-duration', eventId: 'micro', start: '0', end: SUB_GRID_END, length: SUB_GRID_END },
        evidenceSourceIds: ['official'],
      },
    }],
  }));
  for (const name of REVIEW_NAMES) w = recordReview(w, name, 'reviewed', 'fixture');
  const report = analyzeWorkspace(w);
  assert.equal(report.gates.microTiming.status, 'PENDING');
  assert.equal(report.gates.microTiming.sourceSupportedCount, 0);
  assert.equal(report.state, 'CANDIDATE');
  assert.ok(report.blockers.includes('microTiming'));
});

test('an unresolved role-null stream blocks the web workspace with its own reason', () => {
  let w = irWorkspace(canonicalIr({
    events: [
      irNote({ id: 'null-a', start: '0', end: '1', role: null }),
      irNote({ id: 'null-b', start: '18/17', end: '2', role: null, pitch: 64 }),
    ],
  }));
  for (const name of REVIEW_NAMES) w = recordReview(w, name, 'reviewed', 'fixture');
  const report = analyzeWorkspace(w);
  assert.equal(report.gates.microTiming.status, 'PENDING');
  assert.deepEqual(report.gates.microTiming.blockers, ['MICRO_TIMING_STREAM_IDENTITY_UNRESOLVED']);
  assert.equal(report.gates.microTiming.unresolvedStreamIssueCount, 1);
  assert.equal(report.state, 'CANDIDATE');
});

test('the web micro-timing gate keeps a Canonical status and is never rewritten to UNKNOWN', () => {
  let w = irWorkspace(canonicalIr({ events: [irNote({ id: 'plain', start: '0', end: '1' })] }));
  for (const name of REVIEW_NAMES) w = recordReview(w, name, 'reviewed', 'fixture');
  const report = analyzeWorkspace(w);
  assert.ok(['PASS', 'FAIL', 'PENDING'].includes(report.gates.microTiming.status));
  assert.equal(report.gates.microTiming.status, 'PASS');
  assert.equal(report.gates.microTiming, report.readiness.gates.microTiming);
});
