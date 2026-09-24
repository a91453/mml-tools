import test from 'node:test';
import assert from 'node:assert/strict';
import { ingestMusicXML, musicXMLFragmentToProject } from '../backend/score/index.mjs';
import { ingestMIDI, midiFragmentToProject } from '../backend/source/index.mjs';
import { mergeCanonicalProjects, meterMapText } from '../backend/canonical/merge.mjs';
import { createSource, createCanonicalNoteEvent, createCanonicalRestEvent, createCanonicalTempoEvent, createCanonicalMeterEvent, createCanonicalProject } from '../backend/canonical/index.mjs';
import { emitFinalMml, EMIT_DIAGNOSTICS } from '../backend/final/index.mjs';
import { analyzeProjectMicroTiming } from '../backend/canonical/micro-timing.mjs';
import { buildMidi, buildTrack, setTempo, timeSig, notesToEntries } from './fixtures/midi-fixtures.mjs';

const partList = '<part-list><score-part id="P1"><part-name>Piano</part-name></score-part></part-list>';
const pitchNote = (step, duration, extra = '') => `<note><pitch><step>${step}</step><octave>4</octave></pitch><duration>${duration}</duration><voice>1</voice>${extra}</note>`;

// Measure 1 holds `first` (divisions 2); measure 2 is a full 4/4 whole note.
function pickupScore({ first, implicit = null, tempo = 120 } = {}) {
  const implicitAttr = implicit === null ? '' : ` implicit="${implicit}"`;
  return `<?xml version="1.0"?><score-partwise version="4.0">${partList}<part id="P1">`
    + `<measure number="1"${implicitAttr}><attributes><divisions>2</divisions><time><beats>4</beats><beat-type>4</beat-type></time></attributes>`
    + `<direction><sound tempo="${tempo}"/></direction>${first}</measure>`
    + `<measure number="2">${pitchNote('C', 8)}</measure></part></score-partwise>`;
}
const ONE_AND_A_HALF = pitchNote('G', 1) + pitchNote('A', 2);
const meters = fragmentOrProject => fragmentOrProject.meterEvents.map(event => [event.beat, `${event.numerator}/${event.denominator}`]);
const notesOf = fragmentOrProject => fragmentOrProject.events.filter(event => event.kind === 'note').map(event => [event.pitch, event.start, event.end]);

// ── pickup ────────────────────────────────────────────────────────────────

test('an unmarked short first measure is a declared inference: PICKUP_INFERRED, ending a partial first bar', () => {
  const fragment = ingestMusicXML(pickupScore({ first: ONE_AND_A_HALF }), { sourceId: 'xml', label: 'Pickup' });
  assert.equal(fragment.complete, true);
  const inferred = fragment.warnings.find(item => item.code === 'PICKUP_INFERRED');
  assert.ok(inferred);
  assert.equal(inferred.pickupBeats, '3/2');
  assert.equal(inferred.writtenBarBeats, '4');
  assert.equal(inferred.partialBarBeats, '2');
  assert.equal(inferred.leadingSilenceBeats, '1/2');
  // A 1.5-beat pickup under 4/4 ends a 2/4 first bar: bar 2 starts at beat 2,
  // on a barline of the source's own meter map.
  assert.deepEqual(meters(fragment), [['0', '2/4'], ['2', '4/4']]);
  assert.deepEqual(notesOf(fragment), [[67, '1/2', '1'], [69, '1', '2'], [60, '2', '6']]);
  // The initial tempo stays at beat 0, before the silence the placement leaves.
  assert.deepEqual(fragment.tempoEvents.map(event => [event.beat, event.bpm]), [['0', 120]]);
  assert.equal(fragment.meterEvents[0].metadata.partialFirstBar, true);
  assert.equal(fragment.pickup.status, 'inferred');
  assert.equal(musicXMLFragmentToProject(fragment).sources[0].metadata.pickup.partialBarBeats, '2');
});

test('implicit="yes" is honoured as a declared pickup, with no inference diagnostic', () => {
  const fragment = ingestMusicXML(pickupScore({ first: pitchNote('G', 2), implicit: 'yes' }), { sourceId: 'xml', label: 'Pickup' });
  assert.equal(fragment.warnings.some(item => item.code === 'PICKUP_INFERRED'), false);
  assert.equal(fragment.pickup.status, 'declared');
  assert.deepEqual(meters(fragment), [['0', '1/4'], ['1', '4/4']]);
  assert.deepEqual(notesOf(fragment), [[67, '0', '1'], [60, '1', '5']]);
});

test('implicit="no" is a statement, not a gap to infer across; a full first measure is not a pickup', () => {
  const literal = ingestMusicXML(pickupScore({ first: ONE_AND_A_HALF, implicit: 'no' }), { sourceId: 'xml', label: 'Pickup' });
  assert.equal(literal.pickup, null);
  assert.deepEqual(meters(literal), [['0', '4/4']]);
  assert.deepEqual(notesOf(literal).at(-1), [60, '3/2', '11/2']);
  const full = ingestMusicXML(pickupScore({ first: pitchNote('G', 8) }), { sourceId: 'xml', label: 'Pickup' });
  assert.equal(full.pickup, null);
  assert.equal(full.warnings.some(item => item.code === 'PICKUP_INFERRED'), false);
});

// ── merged sources ─────────────────────────────────────────────────────────

// A synthetic MIDI of the same music. `firstBar` is its own meter map.
function midiProject({ firstBar = '2/4', bpm = 120, pickupAt = 180 } = {}) {
  const tempoUs = Math.round(60_000_000 / bpm);
  const conductor = firstBar === '2/4'
    ? [[0, ...setTempo(tempoUs)], [0, ...timeSig(2, 2)], [720, ...timeSig(4, 2)]]
    : [[0, ...setTempo(tempoUs)], [0, ...timeSig(4, 2)]];
  const bar2 = pickupAt + 540;
  const notes = notesToEntries([[0, 67, pickupAt, pickupAt + 180], [0, 69, pickupAt + 180, pickupAt + 540], [0, 60, bar2, bar2 + 1440]]);
  const bytes = buildMidi({ division: 360, tracks: [buildTrack(conductor), buildTrack(notes)] });
  return midiFragmentToProject(ingestMIDI(bytes, { sourceId: 'midi', label: 'MIDI', kind: 'third-party-midi', authority: 'supporting' }));
}
const xmlProject = (options = {}) => musicXMLFragmentToProject(ingestMusicXML(pickupScore({ first: ONE_AND_A_HALF, ...options }), { sourceId: 'xml', label: 'Pickup', kind: 'third-party-musicxml' }));

test('a MusicXML pickup and a MIDI whose first bar is 2/4 with a half-beat rest line up, and their equal controls merge', () => {
  const merged = mergeCanonicalProjects([xmlProject(), midiProject()], { id: 'merged' });
  assert.deepEqual(merged.metadata.controlMap.conflicts, []);
  assert.deepEqual(meters(merged), [['0', '2/4'], ['2', '4/4']]);
  assert.deepEqual(merged.meterEvents.map(event => event.sourceIds), [['xml', 'midi'], ['xml', 'midi']]);
  assert.deepEqual(merged.tempoEvents.map(event => [event.beat, event.bpm, event.sourceIds]), [['0', 120, ['xml', 'midi']]]);
  const byPitch = pitch => merged.events.filter(event => event.kind === 'note' && event.pitch === pitch).map(event => [event.sourceIds[0], event.start]);
  assert.deepEqual(byPitch(67), [['xml', '1/2'], ['midi', '1/2']]);
  assert.deepEqual(byPitch(60), [['xml', '2'], ['midi', '2']]);
  assert.equal(meterMapText(merged.meterEvents).text, '0 2/4\n2 4/4');
});

test('different meter maps are not aligned by the merge: the conflict is named and blocks the Final meter map', () => {
  // The MIDI here starts its pickup on beat 0 under 4/4. Nothing in either
  // file says how to align the two, so the merge keeps both timelines as they
  // are and reports the disagreement.
  const merged = mergeCanonicalProjects([xmlProject(), midiProject({ firstBar: '4/4', pickupAt: 0 })], { id: 'merged' });
  const [conflict] = merged.metadata.controlMap.conflicts;
  assert.equal(conflict.code, 'METER_CONFLICT_AT_POSITION');
  assert.equal(conflict.beat, '0');
  assert.deepEqual(conflict.values.map(item => [item.value, item.sourceIds]), [['2/4', ['xml']], ['4/4', ['midi']]]);
  assert.ok(merged.metadata.unsupported.some(item => item.code === 'METER_CONFLICT_AT_POSITION'));
  const byPitch = pitch => merged.events.filter(event => event.kind === 'note' && event.pitch === pitch).map(event => [event.sourceIds[0], event.start]);
  assert.deepEqual(byPitch(67), [['xml', '1/2'], ['midi', '0']]);
  const map = meterMapText(merged.meterEvents);
  assert.equal(map.text, null);
  assert.match(map.conflicts[0].message, /2\/4 \(xml\) vs 4\/4 \(midi\)/);
});

// ── tempo at one position through Final ───────────────────────────────────

function finalCandidate(project) {
  // Every note placed in a role (as an accepted arrangement would); source
  // rests are carried exactly as the baseline holds them: role-less.
  const roles = ['Melody', 'Chord1', 'Chord2', 'Chord3', 'Chord4', 'Chord5'];
  const bySource = new Map();
  const events = project.events.map(event => {
    if (event.kind !== 'note') return event;
    const source = event.sourceIds[0];
    if (!bySource.has(source)) bySource.set(source, roles[bySource.size]);
    return createCanonicalNoteEvent({ ...event, role: bySource.get(source), volume: 10 });
  });
  return createCanonicalProject({ ...project, events });
}

test('merged sources with the same tempo at the same beat keep one tempo: no TEMPO_POSITION_NOT_STRICTLY_INCREASING', () => {
  const merged = mergeCanonicalProjects([xmlProject(), midiProject()], { id: 'merged' });
  const result = emitFinalMml(finalCandidate(merged));
  const codes = result.diagnostics.map(item => item.code);
  assert.equal(codes.includes(EMIT_DIAGNOSTICS.TEMPO_POSITION_NOT_STRICTLY_INCREASING), false);
  assert.equal(codes.includes(EMIT_DIAGNOSTICS.EVENT_ROLE_UNASSIGNED), false);
});

test('different tempi at one beat stay a named, blocking disagreement', () => {
  const merged = mergeCanonicalProjects([xmlProject(), midiProject({ bpm: 100 })], { id: 'merged' });
  assert.deepEqual(merged.tempoEvents.map(event => [event.beat, event.bpm]), [['0', 120], ['0', 100]]);
  assert.ok(merged.metadata.unsupported.some(item => item.code === 'TEMPO_CONFLICT_AT_POSITION' && item.beat === '0'));
  const result = emitFinalMml(finalCandidate(merged));
  assert.equal(result.status, 'FAIL');
  const finding = result.diagnostics.find(item => item.code === EMIT_DIAGNOSTICS.TEMPO_POSITION_NOT_STRICTLY_INCREASING);
  assert.ok(finding);
  assert.deepEqual([...finding.bpms].sort(), [100, 120]);
  assert.match(finding.message, /120/);
  assert.match(finding.message, /100/);
});

// ── source rests are silence, not unassigned material ─────────────────────

test('role-less MusicXML rests do not block Final: they are silence, as the gaps of a MIDI source are', () => {
  const xml = `<?xml version="1.0"?><score-partwise version="4.0">${partList}<part id="P1"><measure number="1">`
    + '<attributes><divisions>1</divisions><time><beats>4</beats><beat-type>4</beat-type></time></attributes><direction><sound tempo="120"/></direction>'
    + `${pitchNote('C', 1)}<note><rest/><duration>1</duration><voice>1</voice></note>${pitchNote('E', 2)}</measure></part></score-partwise>`;
  const baseline = musicXMLFragmentToProject(ingestMusicXML(xml, { sourceId: 'xml', label: 'Rests' }));
  assert.equal(baseline.events.filter(event => event.kind === 'rest').length, 1);
  const candidate = finalCandidate(baseline);
  assert.equal(candidate.events.find(event => event.kind === 'rest').role, null);
  const result = emitFinalMml(candidate);
  assert.equal(result.status, 'PASS', JSON.stringify(result.diagnostics.map(item => item.code)));
  // The silence is still written, from the gap in the Melody's own onsets.
  assert.match(result.roles.find(role => role.role === 'Melody').mml, /r/);
});

test('a role-less rest in a merged baseline does not open a sub-grid stream question against an assigned note', () => {
  const source = createSource({ id: 'xml', label: 'xml', kind: 'third-party-musicxml', authority: 'supporting' });
  const JUST_BELOW = '31/32';
  const project = createCanonicalProject({
    id: 'merged',
    title: 'merged',
    sources: [source],
    events: [
      createCanonicalRestEvent({ id: 'r', start: '0', end: JUST_BELOW, sourceIds: ['xml'] }),
      createCanonicalNoteEvent({ id: 'n', pitch: 60, start: '1', end: '2', role: 'Melody', volume: 10, sourceIds: ['xml'] }),
      createCanonicalNoteEvent({ id: 'm', pitch: 64, start: '0', end: '1', role: 'Chord1', volume: 10, sourceIds: ['xml'] }),
    ],
    tempoEvents: [createCanonicalTempoEvent({ id: 't', beat: '0', bpm: 120, sourceIds: ['xml'] })],
    meterEvents: [createCanonicalMeterEvent({ id: 'm44', beat: '0', numerator: 4, denominator: 4, sourceIds: ['xml'] })],
  });
  const report = analyzeProjectMicroTiming(project);
  assert.equal(report.unresolvedStreamIssues.some(item => item.eventIds.includes('r')), false);
  // A rest a role does hold is still analysed.
  const held = createCanonicalProject({ ...project, events: project.events.map(event => (event.id === 'r' ? createCanonicalRestEvent({ ...event, role: 'Melody' }) : event)) });
  assert.equal(report.hasUnknown, false);
  assert.equal(analyzeProjectMicroTiming(held).intervals.length, 1);
});

test('a pickup piece that repeats or returns to its first measure keeps a meter map with every change on a bar line', async () => {
  // Pickup of one beat, measure 1 of four, measure 2 of three closing the
  // pickup's bar; then a backward repeat, or D.C. al Fine, back to the start.
  // Replaying the pickup restated its written 4/4 one beat into a bar, a map
  // the Final validator refuses, so the source could never be delivered.
  const { buildBars, parseMeter } = await import('../../dist/core.js');
  const { f } = await import('../backend/mml/index.mjs');
  const note = (step, duration) => `<note><pitch><step>${step}</step><octave>4</octave></pitch><duration>${duration}</duration><voice>1</voice></note>`;
  const score = mode => {
    const pickup = `<measure number="0" implicit="yes"><attributes><divisions>1</divisions><time><beats>4</beats><beat-type>4</beat-type></time></attributes>${mode === 'repeat' ? '<barline location="left"><repeat direction="forward"/></barline>' : ''}${note('G', 1)}</measure>`;
    const one = mode === 'dc' ? `<measure number="1">${note('C', 4)}<direction><direction-type><words>Fine</words></direction-type><sound fine="yes"/></direction></measure>` : `<measure number="1">${note('C', 4)}</measure>`;
    const two = mode === 'repeat'
      ? `<measure number="2" implicit="yes">${note('D', 3)}<barline location="right"><repeat direction="backward"/></barline></measure><measure number="3">${note('E', 4)}</measure>`
      : `<measure number="2">${note('D', 3)}<direction placement="above"><direction-type><words>D.C. al Fine</words></direction-type><sound dacapo="yes"/></direction></measure>`;
    return `<?xml version="1.0"?><score-partwise version="3.1"><part-list><score-part id="P1"><part-name>P</part-name></score-part></part-list><part id="P1">${pickup}${one}${two}</part></score-partwise>`;
  };
  for (const mode of ['repeat', 'dc']) {
    const fragment = ingestMusicXML(score(mode), {});
    assert.equal(fragment.complete, true, mode);
    assert.deepEqual(fragment.meterEvents.map(event => `${event.numerator}/${event.denominator}@${event.beat}`), ['1/4@0', '4/4@1'], mode);
    const end = fragment.events.reduce((latest, event) => (f(event.end).cmp(latest) > 0 ? f(event.end) : latest), f(0));
    const map = meterMapText(fragment.meterEvents);
    assert.deepEqual(map.conflicts, [], mode);
    // The repeat case ends on measure 3 after a three-beat bar; the final bar
    // length is a source fact the caller states, as for any Final.
    assert.doesNotThrow(() => buildBars(String(end), parseMeter(map.text), '', mode === 'repeat' ? '3' : ''), mode);
  }
});

test('a repeat back to a first measure without a pickup still restates its meter on the bar line', () => {
  // The restatement that lands on a bar line is kept exactly as before, so the
  // meter maps, and the baselines, of existing scores do not change.
  const note = step => `<note><pitch><step>${step}</step><octave>4</octave></pitch><duration>4</duration><voice>1</voice></note>`;
  const xml = `<?xml version="1.0"?><score-partwise version="3.1"><part-list><score-part id="P1"><part-name>P</part-name></score-part></part-list><part id="P1"><measure number="1"><attributes><divisions>1</divisions><time><beats>4</beats><beat-type>4</beat-type></time></attributes><barline location="left"><repeat direction="forward"/></barline>${note('C')}</measure><measure number="2">${note('D')}<barline location="right"><repeat direction="backward"/></barline></measure></part></score-partwise>`;
  const fragment = ingestMusicXML(xml, {});
  assert.deepEqual(fragment.meterEvents.map(event => `${event.numerator}/${event.denominator}@${event.beat}`), ['4/4@0', '4/4@8']);
});
