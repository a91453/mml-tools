import test from 'node:test';
import assert from 'node:assert/strict';
import { createSource, createCanonicalNoteEvent, createCanonicalProject } from '../backend/canonical/index.mjs';
import { mergeCanonicalProjects } from '../backend/canonical/merge.mjs';

function singleProject({ projectId, sourceId, kind, authority, pitch, complete = true }) {
  const source = createSource({ id: sourceId, label: sourceId, kind, authority });
  const event = createCanonicalNoteEvent({
    id: `${sourceId}:n1`, pitch, start: '0', end: '1', sourceIds: [sourceId],
  });
  return createCanonicalProject({
    id: projectId,
    title: projectId,
    sources: [source],
    events: [event],
    metadata: { ingestion: kind, sourceComplete: complete },
  });
}

test('merging independent source projects preserves both sources and events', () => {
  const official = singleProject({
    projectId: 'official-project', sourceId: 'official', kind: 'official-musicxml', authority: 'primary-symbolic', pitch: 60,
  });
  const thirdParty = singleProject({
    projectId: 'third-project', sourceId: 'thirdparty', kind: 'third-party-musicxml', authority: 'supporting', pitch: 64,
  });

  const merged = mergeCanonicalProjects([official, thirdParty], { id: 'song-workspace', title: 'Song Workspace' });
  assert.equal(merged.sources.length, 2);
  assert.equal(merged.events.length, 2);
  assert.deepEqual(new Set(merged.events.flatMap(event => event.sourceIds)), new Set(['official', 'thirdparty']));
  assert.equal(merged.metadata.sourceComplete, true);
  assert.match(merged.metadata.notes, /does not reconcile/i);
});

test('incomplete component remains visible after merge', () => {
  const official = singleProject({
    projectId: 'official-project', sourceId: 'official', kind: 'official-musicxml', authority: 'primary-symbolic', pitch: 60,
  });
  const repeatSource = singleProject({
    projectId: 'repeat-project', sourceId: 'repeat-score', kind: 'third-party-musicxml', authority: 'supporting', pitch: 64, complete: false,
  });
  const merged = mergeCanonicalProjects([official, repeatSource]);
  assert.equal(merged.metadata.sourceComplete, false);
  assert.deepEqual(merged.metadata.incompleteInputs, ['repeat-project']);
});

test('duplicate source ids with conflicting identity fail closed', () => {
  const first = singleProject({
    projectId: 'a', sourceId: 'same', kind: 'official-musicxml', authority: 'primary-symbolic', pitch: 60,
  });
  const second = singleProject({
    projectId: 'b', sourceId: 'same', kind: 'third-party-musicxml', authority: 'supporting', pitch: 64,
  });
  assert.throws(() => mergeCanonicalProjects([first, second]), /conflicting duplicate source id/);
});

test('duplicate event ids with conflicting contents fail closed', () => {
  const sourceA = createSource({ id: 'a', label: 'A', kind: 'official-musicxml', authority: 'primary-symbolic' });
  const sourceB = createSource({ id: 'b', label: 'B', kind: 'third-party-musicxml', authority: 'supporting' });
  const p1 = createCanonicalProject({
    id: 'p1', title: 'P1', sources: [sourceA],
    events: [createCanonicalNoteEvent({ id: 'collision', pitch: 60, start: '0', end: '1', sourceIds: ['a'] })],
  });
  const p2 = createCanonicalProject({
    id: 'p2', title: 'P2', sources: [sourceB],
    events: [createCanonicalNoteEvent({ id: 'collision', pitch: 61, start: '0', end: '1', sourceIds: ['b'] })],
  });
  assert.throws(() => mergeCanonicalProjects([p1, p2]), /conflicting duplicate event id/);
});
