import test from 'node:test';
import assert from 'node:assert/strict';
import { ingestMusicXML, musicXMLFragmentToProject } from '../backend/score/index.mjs';

const note = '<note><pitch><step>C</step><octave>4</octave></pitch><duration>4</duration><type>whole</type></note>';
const meter = '<time><beats>4</beats><beat-type>4</beat-type></time>';
const metro = (bpm = 90) => `<direction-type><metronome><beat-unit>quarter</beat-unit><per-minute>${bpm}</per-minute></metronome></direction-type>`;
const score = (time = meter, direction = '', later = '') => `<score-partwise version="4.0"><part-list><score-part id="P1"><part-name>Piano</part-name></score-part></part-list><part id="P1"><measure number="1"><attributes><divisions>1</divisions>${time}</attributes>${direction}${note}</measure>${later}</part></score-partwise>`;

test('MusicXML reads metronome after other direction-type children without losing tempo', () => {
  const fragment = ingestMusicXML(score(meter, `<direction><direction-type><words>Andante</words></direction-type>${metro()}</direction>`));
  assert.equal(fragment.complete, true);
  assert.deepEqual(fragment.tempoEvents.map(e => [e.beat, e.bpm]), [['0', 90]]);
  assert.equal(fragment.events[0].end, '4');
});

test('MusicXML keeps late metronome changes at their source beat, including a direction offset', () => {
  const later = `<measure number="2"><direction><direction-type><words>rit.</words></direction-type>${metro(72)}<offset>1</offset></direction>${note}</measure>`;
  const fragment = ingestMusicXML(score(meter, `<direction>${metro(120)}</direction>`, later));
  assert.deepEqual(fragment.tempoEvents.map(e => [e.beat, e.bpm]), [['0', 120], ['5', 72]]);
});

test('MusicXML does not invent a single meter from the first pair of a composite time signature', () => {
  const time = '<time><beats>2</beats><beat-type>4</beat-type><beats>3</beats><beat-type>8</beat-type></time>';
  const fragment = ingestMusicXML(score(time));
  assert.equal(fragment.complete, false);
  assert.equal(fragment.meterEvents.length, 0);
  const finding = fragment.unsupported.find(item => item.code === 'COMPLEX_METER');
  assert.ok(finding);
  assert.deepEqual(finding.beats, ['2', '3']);
  assert.deepEqual(finding.beatTypes, ['4', '8']);
  assert.equal(fragment.events.length, 1, 'unsupported meter must not erase source notes');
  assert.equal(musicXMLFragmentToProject(fragment).metadata.sourceComplete, false);
});

test('MusicXML marks a later unmetered passage unsupported rather than silently retaining the earlier meter', () => {
  const later = `<measure number="2"><attributes><time><senza-misura/></time></attributes>${note}</measure>`;
  const fragment = ingestMusicXML(score(meter, '', later));
  assert.equal(fragment.complete, false);
  assert.ok(fragment.unsupported.some(item => item.code === 'UNMETERED_TIME' && item.location.measureNumber === '2'));
  assert.deepEqual(fragment.meterEvents.map(e => [e.beat, e.numerator, e.denominator]), [['0', 4, 4]]);
  assert.equal(fragment.events.length, 2);
});

test('MusicXML simple and additive signatures keep their supported/unsupported status', () => {
  assert.equal(ingestMusicXML(score()).complete, true);
  const additive = ingestMusicXML(score('<time><beats>3+2</beats><beat-type>8</beat-type></time>'));
  assert.equal(additive.complete, false);
  assert.ok(additive.unsupported.some(item => item.code === 'COMPLEX_METER'));
});

test('MusicXML sound tempo still takes precedence over visual marks', () => {
  const fragment = ingestMusicXML(score(meter, `<direction><direction-type><words>Moderato</words></direction-type>${metro(90)}<sound tempo="96"/></direction>`));
  assert.deepEqual(fragment.tempoEvents.map(e => e.bpm), [96]);
});

test('MusicXML multiple visual metronomes are not silently collapsed to the first mark', () => {
  const fragment = ingestMusicXML(score(meter, `<direction>${metro(90)}${metro(120)}</direction>`));
  assert.equal(fragment.complete, false);
  assert.equal(fragment.tempoEvents.length, 0);
  assert.ok(fragment.unsupported.some(item => item.code === 'MULTIPLE_METRONOME_MARKS'));
});
