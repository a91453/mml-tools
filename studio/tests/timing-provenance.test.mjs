import test from 'node:test';
import assert from 'node:assert/strict';
import {
  TIMING_ORIGINS,
  TIMING_ARTIFACT_KINDS,
  createTimingProvenance,
} from '../backend/canonical/timing.mjs';
import { normalizeMMLSource, mmlFragmentToProject } from '../backend/mml/canonicalize.mjs';
import { ingestMusicXML, musicXMLFragmentToProject } from '../backend/score/index.mjs';
import { mergeCanonicalProjects } from '../backend/canonical/merge.mjs';
import { f } from '../backend/mml/index.mjs';
import { readCanonical } from '../web/model.mjs';

const six = raw => `MML@${Array(6).fill(raw).join(',')};`;
const MML_ADAPTER = 'studio/backend/mml/canonicalize.mjs';
const MUSICXML_ADAPTER = 'studio/backend/score/musicxml.mjs';

const SCORE = `<?xml version="1.0" encoding="UTF-8"?>
<score-partwise version="4.0">
  <part-list><score-part id="P1"><part-name>Piano</part-name></score-part></part-list>
  <part id="P1">
    <measure number="1">
      <attributes><divisions>4</divisions><time><beats>4</beats><beat-type>4</beat-type></time></attributes>
      <note><pitch><step>C</step><octave>4</octave></pitch><duration>6</duration><voice>1</voice><type>quarter</type><dot/></note>
      <note><rest/><duration>2</duration><voice>1</voice><type>eighth</type></note>
      <note><pitch><step>D</step><octave>4</octave></pitch><duration>8</duration><voice>1</voice></note>
    </measure>
  </part>
</score-partwise>`;

const mml = (raw, options = {}) => normalizeMMLSource(six(raw), {
  sourceId: 'mml', label: 'MML fixture', kind: 'current-mml', meterText: '0 4/4', ...options,
});
const score = (options = {}) => ingestMusicXML(SCORE, { sourceId: 'xml', label: 'Score fixture', ...options });
const timings = events => events.map(event => event.metadata.timing);

// ---------------------------------------------------------------------------
// Provenance record shape. These values are descriptive only: the record says
// how a time value came to exist, never what it means. C1 adds no classifier.
// ---------------------------------------------------------------------------

test('timing provenance keeps three distinct factual origins', () => {
  assert.deepEqual([...TIMING_ORIGINS], ['source-notated', 'source-derived', 'tool-derived']);
  for (const origin of TIMING_ORIGINS) {
    assert.equal(createTimingProvenance({ origin, adapter: 'x' }).origin, origin);
  }
  assert.throws(() => createTimingProvenance({ origin: 'guessed', adapter: 'x' }), /unsupported timing.origin/);
  assert.throws(() => createTimingProvenance({ origin: 'source-notated', adapter: '  ' }), /adapter must be a non-empty string/);
});

test('an unclaimed quantum or written form stays null rather than being invented', () => {
  const bare = createTimingProvenance({ origin: 'source-derived', adapter: 'x' });
  assert.equal(bare.unit, null);
  assert.equal(bare.writtenForm, null);
  assert.equal(bare.artifact, null);

  const stated = createTimingProvenance({ origin: 'source-notated', adapter: 'x', unit: '1/16', writtenForm: 'eighth.' });
  assert.equal(stated.unit, '1/16');
  assert.equal(stated.writtenForm, 'eighth.');
  assert.throws(() => createTimingProvenance({ origin: 'source-notated', adapter: 'x', unit: '0' }), /unit must be > 0/);
});

test('an artifact attestation must be affirmed literally by the module that produced it', () => {
  const attested = createTimingProvenance({
    origin: 'tool-derived',
    adapter: 'synthetic-producer',
    artifact: { kind: 'decomposition-residue', producedBy: 'synthetic-producer', inputUnit: '1/64', carriesNoMusicalMeaning: true },
  });
  assert.equal(attested.artifact.kind, 'decomposition-residue');
  assert.equal(attested.artifact.carriesNoMusicalMeaning, true);
  assert.ok(TIMING_ARTIFACT_KINDS.includes(attested.artifact.kind));

  const base = { kind: 'decomposition-residue', producedBy: 'synthetic-producer', inputUnit: '1/64' };
  // Absence is never consent, and a merely truthy value is not an affirmation.
  for (const carriesNoMusicalMeaning of [undefined, null, false, 'true', 1]) {
    assert.throws(
      () => createTimingProvenance({ origin: 'tool-derived', adapter: 'synthetic-producer', artifact: { ...base, carriesNoMusicalMeaning } }),
      /carriesNoMusicalMeaning must be literally true/,
    );
  }
  // No module may retro-label an interval it merely carried.
  assert.throws(
    () => createTimingProvenance({ origin: 'tool-derived', adapter: 'other-module', artifact: { ...base, carriesNoMusicalMeaning: true } }),
    /producedBy must be the attesting adapter/,
  );
  assert.throws(
    () => createTimingProvenance({ origin: 'tool-derived', adapter: 'synthetic-producer', artifact: { ...base, kind: 'looks-quantized', carriesNoMusicalMeaning: true } }),
    /unsupported timing.artifact.kind/,
  );
});

// ---------------------------------------------------------------------------
// Ingest adapters.
// ---------------------------------------------------------------------------

test('MML ingest records derived provenance without claiming a notated symbol', () => {
  const fragment = mml('t120o4c4r4d4');
  const notes = fragment.events.filter(event => event.kind === 'note');
  const rests = fragment.events.filter(event => event.kind === 'rest');
  assert.ok(notes.length && rests.length);

  for (const timing of timings([...notes, ...rests])) {
    // Onsets are positional and a tie chain collapses several written tokens
    // into one event, so this adapter cannot attest a single notated symbol.
    assert.equal(timing.origin, 'source-derived');
    assert.equal(timing.adapter, MML_ADAPTER);
    assert.equal(timing.unit, null);
    assert.equal(timing.writtenForm, null);
    assert.equal(timing.artifact, null);
  }
  // Reconstructed silence keeps its existing inference marker alongside timing.
  assert.equal(rests[0].metadata.inference, 'gap-between-expanded-note-events');
  assert.ok(rests[0].tags.includes('inferred-silence'));
});

test('MusicXML ingest reports the notated duration and the quantum the file encodes on', () => {
  const fragment = score();
  const note = fragment.events.find(event => event.kind === 'note');
  const rest = fragment.events.find(event => event.kind === 'rest');

  for (const timing of timings([note, rest])) {
    assert.equal(timing.origin, 'source-notated');
    assert.equal(timing.adapter, MUSICXML_ADAPTER);
    // <divisions>4</divisions> ⇒ one division is a 1/16 whole note.
    assert.equal(timing.unit, '1/16');
    assert.equal(timing.artifact, null);
  }
  assert.equal(note.metadata.timing.writtenForm, 'quarter.');
  assert.equal(rest.metadata.timing.writtenForm, 'eighth');
  // A note without <type> claims no written form rather than guessing one.
  assert.equal(fragment.events.filter(event => event.kind === 'note').at(-1).metadata.timing.writtenForm, null);
});

test('no production ingest path emits an artifact attestation', () => {
  const events = [...mml('t120o4c64r64c32', { finalPartial: '1/4' }).events, ...score().events];
  assert.ok(events.length);
  assert.deepEqual(events.filter(event => event.metadata.timing?.artifact !== null), []);
  // Nothing in C1 may classify an interval in either direction.
  const text = JSON.stringify(events);
  for (const token of ['SOURCE_SUPPORTED', 'TECHNICAL_RESIDUE', 'carriesNoMusicalMeaning', 'verdict']) {
    assert.equal(text.includes(token), false, `C1 must not emit ${token}`);
  }
});

// ---------------------------------------------------------------------------
// C1 invariants: nothing that already existed may move.
// ---------------------------------------------------------------------------

test('ingest timing metadata changes no event timing, identity or source traceability', () => {
  const fragment = mml('t120o4c4r4d4');
  const melodyNotes = fragment.events.filter(event => event.kind === 'note' && event.role === 'Melody');
  const melodyRests = fragment.events.filter(event => event.kind === 'rest' && event.role === 'Melody');
  assert.deepEqual(melodyNotes.map(event => [event.pitch, event.start, event.end]), [[60, '0', '1'], [62, '2', '3']]);
  assert.deepEqual(melodyRests.map(event => [event.start, event.end]), [['1', '2']]);
  assert.deepEqual(melodyNotes[0].sourceIds, ['mml']);
  assert.deepEqual(melodyNotes[0].sourceEventIds, ['track:Melody/note:1']);
  assert.deepEqual(melodyRests[0].sourceEventIds, ['track:Melody/silence:1']);

  const notes = score().events.filter(event => event.kind === 'note');
  assert.deepEqual(notes.map(event => [event.pitch, event.start, event.end]), [[60, '0', '3/2'], [62, '2', '4']]);
  // The measure sequence counter spans every child, so <attributes> takes 1.
  assert.deepEqual(notes[0].sourceEventIds, ['part:P1/measure:1/note:2']);
});

test('exactly 1/64 keeps its existing expansion and gains no classification', () => {
  const melody = mml('t120o4c64r64c32', { finalPartial: '1/4' }).events
    .filter(event => event.role === 'Melody')
    .sort((a, b) => f(a.start).cmp(b.start));
  // A 1/64 note is 1/16 of a quarter-note beat; C1 only annotates it.
  assert.deepEqual(melody.map(event => [event.kind, event.start, event.end]), [
    ['note', '0', '1/16'],
    ['rest', '1/16', '1/8'],
    ['note', '1/8', '1/4'],
  ]);
  assert.ok(melody.every(event => event.metadata.timing.origin === 'source-derived'));
});

test('merge carries timing metadata through byte-identically and relabels nothing', () => {
  const mmlProject = mmlFragmentToProject(mml('t120o4c4d4'), { id: 'mml-project' });
  const scoreProject = musicXMLFragmentToProject(score(), { id: 'score-project' });
  const before = new Map([...mmlProject.events, ...scoreProject.events]
    .map(event => [event.id, JSON.stringify(event.metadata.timing)]));

  const merged = mergeCanonicalProjects([mmlProject, scoreProject], { id: 'merged' });
  assert.equal(merged.events.length, before.size);
  for (const event of merged.events) {
    assert.equal(JSON.stringify(event.metadata.timing), before.get(event.id), `merge altered timing for ${event.id}`);
    // Carried-through source events are never restamped as tooling output.
    assert.notEqual(event.metadata.timing.origin, 'tool-derived');
  }
});

test('import preserves timing metadata instead of stripping or relabelling it', () => {
  const project = mmlFragmentToProject(mml('t120o4c4r4d4'), { id: 'imported' });
  const restored = readCanonical(JSON.parse(JSON.stringify(project)));
  assert.equal(restored.events.length, project.events.length);
  for (const [index, event] of restored.events.entries()) {
    assert.deepEqual(event.metadata.timing, project.events[index].metadata.timing);
    assert.equal(event.metadata.timing.origin, 'source-derived');
  }
});

test('a project saved before timing provenance stays valid and simply carries none', () => {
  const project = mmlFragmentToProject(mml('t120o4c4d4'), { id: 'legacy' });
  const legacy = JSON.parse(JSON.stringify(project));
  for (const event of legacy.events) delete event.metadata.timing;

  const restored = readCanonical(legacy);
  assert.equal(restored.events.length, project.events.length);
  assert.ok(restored.events.every(event => event.metadata.timing === undefined));
  // It also still merges, so no consumer may assume the field is present.
  const merged = mergeCanonicalProjects([restored], { id: 'legacy-merged' });
  assert.equal(merged.events.length, restored.events.length);
});
