import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createCanonicalProject, createSource, createCanonicalNoteEvent,
  createCanonicalTempoEvent, createCanonicalMeterEvent, createArbitrationDecision,
} from '../backend/canonical/index.mjs';

function inputs() {
  return {
    id: 'collection-regression', title: 'Synthetic immutable collections',
    sources: [createSource({ id: 'score', label: 'Score', kind: 'official-musicxml', authority: 'primary-symbolic' })],
    events: [createCanonicalNoteEvent({ id: 'note', start: 0, end: 1, pitch: 60, sourceIds: ['score'] })],
    tempoEvents: [createCanonicalTempoEvent({ id: 'tempo', beat: 0, bpm: 120, sourceIds: ['score'] })],
    meterEvents: [createCanonicalMeterEvent({ id: 'meter', beat: 0, numerator: 4, denominator: 4, sourceIds: ['score'] })],
    decisions: [createArbitrationDecision({ id: 'decision', eventIds: ['note'], action: 'keep', reason: 'Source note retained' })],
  };
}

const collections = ['sources', 'events', 'tempoEvents', 'meterEvents', 'decisions'];
for (const key of collections) {
  test(`Canonical ${key} collection cannot change after construction`, () => {
    const project = createCanonicalProject(inputs());
    const before = JSON.stringify(project);
    const original = project[key][0];
    assert.throws(() => project[key].push(original), TypeError);
    assert.throws(() => project[key].pop(), TypeError);
    assert.throws(() => { project[key][0] = { id: 'injected' }; }, TypeError);
    assert.throws(() => { project[key].length = 0; }, TypeError);
    assert.equal(JSON.stringify(project), before);
    assert.equal(Object.isFrozen(project[key]), true);
  });
}

test('Canonical collection protection copies inputs and preserves Worker copy semantics', () => {
  const input = inputs();
  const project = createCanonicalProject(input);
  for (const key of collections) {
    assert.notStrictEqual(project[key], input[key]);
    input[key].length = 0;
    assert.equal(project[key].length, 1);
  }
  const transported = structuredClone(project);
  transported.events.push({ id: 'injected' });
  assert.equal(project.events.length, 1);
  const empty = createCanonicalProject({ id: 'empty', title: 'Empty', sources: [], events: [] });
  for (const key of collections) assert.equal(Object.isFrozen(empty[key]), true);
});
