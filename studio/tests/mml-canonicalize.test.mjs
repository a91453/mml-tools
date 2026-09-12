import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeMMLSource, mmlFragmentToProject } from '../backend/mml/canonicalize.mjs';

const six = raw => `MML@${Array(6).fill(raw).join(',')};`;

test('current MML normalizes expanded notes and meaningful silence into Canonical IR', () => {
  const fragment = normalizeMMLSource(six('t120o4c4r4d4r4'), {
    sourceId: 'current',
    label: 'Current candidate',
    kind: 'current-mml',
    meterText: '0 4/4',
  });

  assert.equal(fragment.complete, true, JSON.stringify(fragment.validation.errors));
  assert.equal(fragment.source.kind, 'current-mml');
  assert.equal(fragment.source.authority, 'derived');

  const melodyNotes = fragment.events.filter(event => event.kind === 'note' && event.role === 'Melody');
  const melodyRests = fragment.events.filter(event => event.kind === 'rest' && event.role === 'Melody');
  assert.deepEqual(melodyNotes.map(event => [event.pitch, event.start, event.end]), [
    [60, '0', '1'],
    [62, '2', '3'],
  ]);
  assert.deepEqual(melodyRests.map(event => [event.start, event.end]), [
    ['1', '2'],
    ['3', '4'],
  ]);
  assert.ok(melodyRests.every(event => event.tags.includes('inferred-silence')));

  assert.deepEqual(fragment.tempoEvents.map(event => [event.beat, event.bpm]), [['0', 120]]);
  assert.deepEqual(fragment.meterEvents.map(event => [event.beat, event.numerator, event.denominator]), [['0', 4, 4]]);

  const project = mmlFragmentToProject(fragment, { id: 'candidate-project' });
  assert.equal(project.schema, 'mabinogi-mobile-mml-studio/canonical-project@2');
  assert.equal(project.metadata.sourceComplete, true);
  assert.equal(project.metadata.totalBeats, '4');
});

test('historical MML stays a distinct evidence source rather than replacing the current candidate', () => {
  const old = normalizeMMLSource(six('t120o4c2d2'), {
    sourceId: 'v13', label: 'v13', kind: 'historical-mml', meterText: '0 4/4',
  });
  const current = normalizeMMLSource(six('t120o4c2e2'), {
    sourceId: 'current', label: 'Current', kind: 'current-mml', meterText: '0 4/4',
  });

  assert.equal(old.source.kind, 'historical-mml');
  assert.equal(current.source.kind, 'current-mml');
  assert.notEqual(old.events.find(event => event.kind === 'note' && event.role === 'Melody' && event.start === '2').pitch,
    current.events.find(event => event.kind === 'note' && event.role === 'Melody' && event.start === '2').pitch);
  assert.deepEqual(old.events[0].sourceIds, ['v13']);
  assert.deepEqual(current.events[0].sourceIds, ['current']);
});

test('source ingestion preserves caution plain lengths and Nxx instead of losing evidence', () => {
  const cautionLength = normalizeMMLSource(six('t120o4c48'), {
    sourceId: 'c48-source',
    label: 'C48 source',
    kind: 'historical-mml',
    meterText: '0 4/4',
    finalPartial: '1/12',
  });
  assert.equal(cautionLength.complete, true, JSON.stringify(cautionLength.validation.errors));
  assert.ok(cautionLength.validation.warnings.some(item => item.code === 'CAUTION_LENGTH'));

  const numeric = normalizeMMLSource(six('t120n60'), {
    sourceId: 'n-source',
    label: 'Nxx source',
    kind: 'historical-mml',
    meterText: '0 4/4',
    // Nxx uses the current default L4 here, which is one quarter-note beat.
    finalPartial: '1',
  });
  assert.equal(numeric.complete, true, JSON.stringify(numeric.validation.errors));
  assert.equal(numeric.events.find(event => event.kind === 'note' && event.role === 'Melody').pitch, 60);
  assert.ok(numeric.validation.warnings.some(item => item.code === 'NUMERIC_NOTE_CAUTION'));
});

test('technically invalid historical MML is retained as incomplete evidence, never silently certified', () => {
  const fragment = normalizeMMLSource(six('t256o4c1'), {
    sourceId: 'legacy-bad-tempo',
    label: 'Legacy bad tempo',
    kind: 'historical-mml',
    meterText: '0 4/4',
  });
  assert.equal(fragment.complete, false);
  assert.equal(fragment.source.metadata.technicalOk, false);
  assert.ok(fragment.validation.errors.some(error => /T256/.test(error.message)));
  assert.equal(fragment.events.filter(event => event.kind === 'note').length, 6);
});

test('missing meter keeps MML evidence but marks the source incomplete', () => {
  const fragment = normalizeMMLSource(six('t120o4c1'), {
    sourceId: 'no-meter', label: 'No meter', kind: 'historical-mml',
  });
  assert.equal(fragment.complete, false);
  assert.equal(fragment.meterEvents.length, 0);
  assert.ok(fragment.validation.errors.some(error => /拍號圖/.test(error.message)));
});
