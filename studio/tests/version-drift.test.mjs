import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeMMLSource, mmlFragmentToProject } from '../backend/mml/canonicalize.mjs';
import { compareCanonicalVersions, compareCandidateLineage } from '../backend/compare/version-drift.mjs';
import { createSource, createCanonicalNoteEvent, createCanonicalProject } from '../backend/canonical/index.mjs';

const six = raw => `MML@${Array(6).fill(raw).join(',')};`;
const projectFromMml = (id, raw) => mmlFragmentToProject(normalizeMMLSource(six(raw), {
  sourceId: id,
  label: id,
  kind: id === 'current' ? 'current-mml' : 'historical-mml',
  meterText: '0 4/4',
}), { id });

test('version drift reports pitch edits instead of hiding them in a similarity score', () => {
  const before = projectFromMml('v13', 't120o4c2d2');
  const after = projectFromMml('current', 't120o4c2e2');
  const diff = compareCanonicalVersions(before, after);

  assert.equal(diff.structurallyIdentical, false);
  assert.equal(diff.summary.noteModified, 6);
  assert.equal(diff.summary.noteAdded, 0);
  assert.equal(diff.summary.noteRemoved, 0);
  assert.ok(diff.notes.modified.every(pair => pair.changes.pitch));
  assert.match(diff.notice, /diagnostic/i);
});

test('tempo edits are reported separately from note edits', () => {
  const before = projectFromMml('v13', 't120o4c1');
  const after = projectFromMml('current', 't121o4c1');
  const diff = compareCanonicalVersions(before, after);

  assert.equal(diff.summary.noteModified, 0);
  assert.equal(diff.summary.tempoChanged, 1);
  assert.deepEqual(diff.tempo.changed.map(item => [item.beat, item.before, item.after]), [['0', 120, 121]]);
});

test('pure cross-track movement is classified as a role move', () => {
  const sourceA = createSource({ id: 'a', label: 'A', kind: 'historical-mml', authority: 'derived' });
  const sourceB = createSource({ id: 'b', label: 'B', kind: 'current-mml', authority: 'derived' });
  const before = createCanonicalProject({
    id: 'before', title: 'Before', sources: [sourceA],
    events: [createCanonicalNoteEvent({ id: 'a:n1', pitch: 69, start: '0', end: '1', role: 'Melody', sourceIds: ['a'] })],
  });
  const after = createCanonicalProject({
    id: 'after', title: 'After', sources: [sourceB],
    events: [createCanonicalNoteEvent({ id: 'b:n1', pitch: 69, start: '0', end: '1', role: 'Chord1', sourceIds: ['b'] })],
  });
  const diff = compareCanonicalVersions(before, after);
  assert.equal(diff.summary.roleMoved, 1);
  assert.equal(diff.summary.noteAdded, 0);
  assert.equal(diff.summary.noteRemoved, 0);
  assert.deepEqual(diff.notes.roleMoved[0].changes.role, { before: 'Melody', after: 'Chord1' });
});

test('rest and onset changes remain visible as explicit structural changes', () => {
  const before = projectFromMml('v13', 't120o4c4r4d2');
  const after = projectFromMml('current', 't120o4c4r2d4');
  const diff = compareCanonicalVersions(before, after);
  assert.equal(diff.summary.restAdded, 6);
  assert.equal(diff.summary.restRemoved, 6);
  assert.equal(diff.summary.noteAdded, 6);
  assert.equal(diff.summary.noteRemoved, 6);
});

test('lineage comparison flags increased source divergence only as a review trigger', () => {
  const source = projectFromMml('source', 't120o4c2d2');
  const previous = projectFromMml('v13', 't120o4c2d2');
  const candidate = projectFromMml('current', 't120o4c2e2');
  const report = compareCandidateLineage({ sourceBaseline: source, acceptedPrevious: previous, candidate });

  assert.equal(report.sourceToPrevious.diagnosticChangeCount, 0);
  assert.ok(report.sourceToCandidate.diagnosticChangeCount > 0);
  assert.equal(report.divergenceIncreased, true);
  assert.equal(report.reviewRequired, true);
  assert.match(report.notice, /not proof/i);
});
