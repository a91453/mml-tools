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

// Adversarial audit (pre-Studio-Web). `sourceComplete` is not decoration: it is
// read straight out of project metadata by the Gate 2 source readiness check in
// backend/final/readiness.mjs. Caller-supplied merge metadata used to be spread
// last, so it could overwrite the merge's own findings and present a merge of
// incomplete inputs as source-complete. ACCEPTANCE_CRITERIA Gate 2 and
// MASTER_RULES §3 make that verdict the merge's to state, not its caller's.
test('caller metadata cannot overwrite the merge findings it did not compute', async () => {
  const { evaluateProjectReadiness } = await import('../backend/final/readiness.mjs');
  const incomplete = singleProject({
    projectId: 'incomplete-project', sourceId: 'partial', kind: 'third-party-midi', authority: 'supporting', pitch: 60, complete: false,
  });

  const laundered = mergeCanonicalProjects([incomplete], {
    id: 'merged',
    metadata: { sourceComplete: true, incompleteInputs: [], merge: 'not-a-merge', componentProjects: [] },
  });

  assert.equal(laundered.metadata.sourceComplete, false);
  assert.deepEqual(laundered.metadata.incompleteInputs, ['incomplete-project']);
  assert.equal(laundered.metadata.merge, 'canonical-project-merge-v1');
  assert.deepEqual(laundered.metadata.componentProjects.map(item => item.id), ['incomplete-project']);

  // The readiness source gate must still see an incomplete merge.
  const readiness = evaluateProjectReadiness({ project: laundered, mmlValidation: { ok: true, errors: [] } });
  assert.equal(readiness.gates.source.status, 'PENDING');
  assert.deepEqual(readiness.gates.source.blockers, ['SOURCE_COMPLETENESS_NOT_CONFIRMED']);

  // Metadata the merge does not compute is still the caller's to supply.
  const annotated = mergeCanonicalProjects([incomplete], { id: 'merged', metadata: { reviewTicket: 'AUDIT-1' } });
  assert.equal(annotated.metadata.reviewTicket, 'AUDIT-1');
  assert.equal(annotated.metadata.sourceComplete, false);
});
