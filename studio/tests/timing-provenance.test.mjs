import test from 'node:test';
import assert from 'node:assert/strict';
import {
  TIMING_ORIGINS,
  TIMING_COMPONENTS,
  createTimingProvenance,
} from '../backend/canonical/timing.mjs';
import { normalizeMMLSource, mmlFragmentToProject } from '../backend/mml/canonicalize.mjs';
import { ingestMusicXML, musicXMLFragmentToProject } from '../backend/score/index.mjs';
import { mergeCanonicalProjects } from '../backend/canonical/merge.mjs';
import { evaluateProjectReadiness } from '../backend/final/readiness.mjs';
import { validateMML } from '../backend/mml/parser.mjs';
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
const origins = timing => TIMING_COMPONENTS.map(name => timing[name].origin);

// ---------------------------------------------------------------------------
// Provenance record shape. These values are descriptive only: the record says
// how each time value came to exist, never what it means. C1 adds no classifier.
// ---------------------------------------------------------------------------

test('timing provenance is recorded per component, never as one event-wide origin', () => {
  assert.deepEqual([...TIMING_ORIGINS], ['source-notated', 'source-derived', 'tool-derived']);
  assert.deepEqual([...TIMING_COMPONENTS], ['start', 'duration', 'end']);

  const record = createTimingProvenance({
    adapter: 'x',
    start: { origin: 'source-derived' },
    duration: { origin: 'source-notated', unit: '1/16', writtenForm: 'quarter.' },
    end: { origin: 'source-derived' },
  });
  assert.deepEqual(origins(record), ['source-derived', 'source-notated', 'source-derived']);
  assert.equal(record.duration.unit, '1/16');
  assert.equal(record.duration.writtenForm, 'quarter.');
  // A coarse event-level origin is not accepted in place of the components.
  assert.equal(record.origin, undefined);
  assert.throws(() => createTimingProvenance({ adapter: 'x', origin: 'source-notated' }), /timing.start must be an object/);
});

test('every component must be stated explicitly and independently', () => {
  const full = { start: { origin: 'source-derived' }, duration: { origin: 'source-derived' }, end: { origin: 'source-derived' } };
  for (const missing of TIMING_COMPONENTS) {
    const partial = { ...full, [missing]: undefined };
    assert.throws(() => createTimingProvenance({ adapter: 'x', ...partial }), new RegExp(`timing.${missing} must be an object`));
  }
  assert.throws(() => createTimingProvenance({ adapter: 'x', ...full, start: { origin: 'guessed' } }), /unsupported timing.start.origin/);
  assert.throws(() => createTimingProvenance({ adapter: ' ', ...full }), /adapter must be a non-empty string/);

  // Components are deliberately not ranked against one another: a format that
  // notates absolute endpoints yields notated start and end with a derived
  // duration, and no cross-component rule may reject that.
  const endpoints = createTimingProvenance({
    adapter: 'x',
    start: { origin: 'source-notated' },
    duration: { origin: 'source-derived' },
    end: { origin: 'source-notated' },
  });
  assert.deepEqual(origins(endpoints), ['source-notated', 'source-derived', 'source-notated']);
});

test('an unclaimed quantum or written form stays null rather than being invented', () => {
  const bare = createTimingProvenance({
    adapter: 'x',
    start: { origin: 'source-derived' },
    duration: { origin: 'source-derived' },
    end: { origin: 'source-derived' },
  });
  for (const name of TIMING_COMPONENTS) {
    assert.equal(bare[name].unit, null);
    assert.equal(bare[name].writtenForm, null);
  }
  assert.throws(() => createTimingProvenance({
    adapter: 'x',
    start: { origin: 'source-derived' },
    duration: { origin: 'source-notated', unit: '0' },
    end: { origin: 'source-derived' },
  }), /timing.duration.unit must be > 0/);
});

// ---------------------------------------------------------------------------
// Ingest adapters.
// ---------------------------------------------------------------------------

test('MusicXML notates only the duration; onset and end are reported as derived', () => {
  const fragment = score();
  const note = fragment.events.find(event => event.kind === 'note');
  const rest = fragment.events.find(event => event.kind === 'rest');

  for (const event of [note, rest]) {
    const timing = event.metadata.timing;
    assert.equal(timing.adapter, MUSICXML_ADAPTER);
    // The onset is positional — accumulated through the measure cursor,
    // backup / forward and measure extents — so it is never notated.
    assert.equal(timing.start.origin, 'source-derived');
    // The length is read literally from <duration> against <divisions>.
    assert.equal(timing.duration.origin, 'source-notated');
    // The end follows from a derived onset, so it cannot claim to be notated.
    assert.equal(timing.end.origin, 'source-derived');
    // <divisions>4</divisions> ⇒ one division is a 1/16 whole note.
    assert.equal(timing.duration.unit, '1/16');
    // Only the notated component carries the quantum and the written form.
    assert.equal(timing.start.unit, null);
    assert.equal(timing.end.unit, null);
    assert.equal(timing.start.writtenForm, null);
    assert.equal(timing.end.writtenForm, null);
  }
  assert.equal(note.metadata.timing.duration.writtenForm, 'quarter.');
  assert.equal(rest.metadata.timing.duration.writtenForm, 'eighth');
  // A note without <type> claims no written form rather than guessing one.
  assert.equal(fragment.events.filter(event => event.kind === 'note').at(-1).metadata.timing.duration.writtenForm, null);
});

test('MML stays conservative: no component claims a token-level fact the adapter lost', () => {
  const fragment = mml('t120o4c4&c4r4d4');
  const notes = fragment.events.filter(event => event.kind === 'note');
  const rests = fragment.events.filter(event => event.kind === 'rest');
  assert.ok(notes.length && rests.length);

  for (const event of [...notes, ...rests]) {
    const timing = event.metadata.timing;
    assert.equal(timing.adapter, MML_ADAPTER);
    // Onsets are positional, a tie chain collapses several written tokens into
    // one event, and silence is reconstructed from the absence of notes.
    assert.deepEqual(origins(timing), ['source-derived', 'source-derived', 'source-derived']);
    for (const name of TIMING_COMPONENTS) {
      assert.equal(timing[name].unit, null);
      assert.equal(timing[name].writtenForm, null);
    }
  }
  // The tie really does collapse two written tokens into one two-beat event,
  // which is why the duration component must not be called notated.
  const tied = notes.find(event => event.role === 'Melody');
  assert.deepEqual([tied.start, tied.end], ['0', '2']);
  assert.equal(rests[0].metadata.inference, 'gap-between-expanded-note-events');
  assert.ok(rests[0].tags.includes('inferred-silence'));
});

test('no artifact attestation or micro-timing verdict exists anywhere in C1', () => {
  const events = [...mml('t120o4c64r64c32', { finalPartial: '1/4' }).events, ...score().events];
  assert.ok(events.length);
  const text = JSON.stringify(events);
  // Attestation is deferred to C2, which must first define interval identity:
  // a gap belongs to a pair of events and has no home on a single event.
  for (const token of ['artifact', 'carriesNoMusicalMeaning', 'SOURCE_SUPPORTED', 'TECHNICAL_RESIDUE', 'verdict', 'classification']) {
    assert.equal(text.includes(token), false, `C1 must not emit ${token}`);
  }
  for (const event of events) {
    assert.deepEqual(Object.keys(event.metadata.timing).sort(), ['adapter', 'duration', 'end', 'start']);
    for (const name of TIMING_COMPONENTS) {
      assert.deepEqual(Object.keys(event.metadata.timing[name]).sort(), ['origin', 'unit', 'writtenForm']);
    }
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
  assert.ok(melody.every(event => origins(event.metadata.timing).every(origin => origin === 'source-derived')));
});

test('readiness and gate results are unchanged by the presence of timing provenance', () => {
  const raw = six('t120o4c4r4d4');
  const project = mmlFragmentToProject(mml('t120o4c4r4d4'), { id: 'readiness' });
  const stripped = JSON.parse(JSON.stringify(project));
  for (const event of stripped.events) delete event.metadata.timing;

  const evaluate = input => evaluateProjectReadiness({
    project: input,
    mmlValidation: validateMML(raw, { meterText: '0 4/4' }),
    core3Report: null,
    core3CompletenessReport: { status: 'PASS', blockers: [] },
    harmonyReport: null,
  });
  assert.equal(JSON.stringify(evaluate(project)), JSON.stringify(evaluate(stripped)));
  assert.equal(evaluate(project).candidateReady, false);
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
    assert.equal(origins(event.metadata.timing).includes('tool-derived'), false);
  }
});

test('import preserves refined provenance instead of stripping or relabelling it', () => {
  const project = mmlFragmentToProject(mml('t120o4c4r4d4'), { id: 'imported' });
  const restored = readCanonical(JSON.parse(JSON.stringify(project)));
  assert.equal(restored.events.length, project.events.length);
  for (const [index, event] of restored.events.entries()) {
    assert.deepEqual(event.metadata.timing, project.events[index].metadata.timing);
    assert.deepEqual(origins(event.metadata.timing), ['source-derived', 'source-derived', 'source-derived']);
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
