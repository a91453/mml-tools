import test from 'node:test';
import assert from 'node:assert/strict';

import { MML_ENGINE_ADAPTER, f } from '../backend/mml/index.mjs';
import {
  createSource,
  createCanonicalNoteEvent,
  createArbitrationDecision,
  createCanonicalProject,
} from '../backend/canonical/index.mjs';

test('Studio MML facade owns parsing while retaining legacy rational implementation', () => {
  assert.equal(MML_ENGINE_ADAPTER.finalParser, './parser.mjs');
  assert.equal(MML_ENGINE_ADAPTER.legacyParserAllowedForFinalGate, false);
  assert.ok(MML_ENGINE_ADAPTER.reusableLegacyAreas.includes('exact-rational-arithmetic'));
  assert.equal(f('1/3').add('2/3').toString(), '1');
});

test('canonical events preserve exact beat values and source traceability', () => {
  const source = createSource({
    id: 'official-score',
    label: 'Official MusicXML',
    kind: 'official-musicxml',
    authority: 'primary-symbolic',
  });

  const event = createCanonicalNoteEvent({
    id: 'official-score:n1',
    pitch: 69,
    start: '1/3',
    end: '5/6',
    sourceIds: [source.id],
    sourceEventIds: ['part:P1/measure:1/voice:1/note:1'],
    role: null,
    tags: ['source-faithful'],
  });

  assert.equal(event.start, '1/3');
  assert.equal(event.end, '5/6');
  assert.deepEqual(event.sourceIds, ['official-score']);
});

test('arbitration remains a separate record from the source event', () => {
  const source = createSource({
    id: 'score-a',
    label: 'Trusted score',
    kind: 'official-musicxml',
    authority: 'primary-symbolic',
  });
  const event = createCanonicalNoteEvent({
    id: 'score-a:n1', pitch: 60, start: '0', end: '1', sourceIds: ['score-a'],
  });
  const decision = createArbitrationDecision({
    id: 'decision-1',
    eventIds: [event.id],
    action: 'assign-role:Melody',
    status: 'accepted',
    reason: 'Source-supported lead event.',
    evidence: ['score-a'],
  });
  const project = createCanonicalProject({
    id: 'song-1', title: 'Fixture', sources: [source], events: [event], decisions: [decision],
  });

  assert.equal(project.events[0].role, null);
  assert.equal(project.decisions[0].action, 'assign-role:Melody');
});

test('canonical project rejects broken source references', () => {
  const event = createCanonicalNoteEvent({
    id: 'ghost:n1', pitch: 60, start: '0', end: '1', sourceIds: ['missing-source'],
  });
  assert.throws(
    () => createCanonicalProject({ id: 'broken', title: 'Broken', sources: [], events: [event] }),
    /unknown source/,
  );
});
