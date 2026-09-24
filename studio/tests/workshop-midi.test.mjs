// Studio Workshop: Standard MIDI File export and import round trip.
import test from 'node:test';
import assert from 'node:assert/strict';
import { parseAll } from '../web/workshop/mml.mjs';
import { toMIDI } from '../web/workshop/midi-out.mjs';
import { parseSMF, inventory, buildImport, fileOrigin, shiftToOrigin } from '../web/workshop/midi-in.mjs';
import { parseMusicXML } from '../web/workshop/musicxml-in.mjs';

const sig = song => song.tracks.map(t => t.notes.map(n => [n.tick, n.durTick, n.midi, n.vel].join(':')));

test('MIDI export → import gives back the same notes, tempo, meter and marks', () => {
  const texts = ['t120v12l8o5ceg>c<gec4dfa>c<afd4', 't120v10l2o4egfa', 't120l1o3cf'];
  const song = parseAll(texts);
  const bytes = toMIDI(song, [24, 40, 0], [{ tick: 0, num: 4, den: 4 }], [{ tick: 0, text: 'Intro' }]);
  assert.deepEqual([...bytes.slice(0, 4)], [0x4d, 0x54, 0x68, 0x64]);
  const smf = parseSMF(bytes);
  assert.deepEqual(smf.tempos, [{ tick: 0, bpm: 120 }]);
  assert.deepEqual(smf.meters, [{ tick: 0, num: 4, den: 4 }]);
  assert.deepEqual(smf.marks, [{ tick: 0, text: 'Intro' }]);
  const rows = inventory(smf);
  assert.equal(rows.length, 3);
  assert.deepEqual(rows.map(r => r.notes.length), [14, 4, 2]);
  const imported = buildImport(rows.map(r => ({ ...r, on: true, mode: 'melody' })), smf.tempos, { origin: fileOrigin(rows) });
  assert.deepEqual(sig(parseAll(imported.texts)), sig(song));
});

test('export is byte-for-byte deterministic', () => {
  const song = parseAll(['t90l4o4cdefg2', 'l2o3c<g']);
  assert.deepEqual(toMIDI(song, [0, 0]), toMIDI(song, [0, 0]));
});

// What the import dialog does with a MIDI or MusicXML file (filebox.mjs):
// the lanes are written from the file's origin, and the file's meters and
// marks are moved onto the same clock before they are applied.
function importFile(smf) {
  const rows = inventory(smf);
  const origin = fileOrigin(rows, smf.meters);
  const { texts } = buildImport(rows.map(r => ({ ...r, on: true, mode: 'melody' })), smf.tempos, { origin });
  return {
    origin,
    notes: parseAll(texts).tracks.flatMap(t => t.notes.map(n => [n.tick, n.midi])),
    meters: shiftToOrigin(smf.meters, origin),
    marks: shiftToOrigin(smf.marks, origin),
  };
}

test('a leading empty bar is trimmed, and the meter change and marks move with the notes', () => {
  // Bar 1 is empty; bar 3 turns to 3/4 and is marked B, on the G.
  const song = parseAll(['t120r1c1g2.']);
  const smf = parseSMF(toMIDI(song, [0], [{ tick: 0, num: 4, den: 4 }, { tick: 3840, num: 3, den: 4 }], [{ tick: 0, text: 'Intro' }, { tick: 3840, text: 'B' }]));
  const got = importFile(smf);
  assert.equal(got.origin, 1920);
  assert.deepEqual(got.notes, [[0, 60], [1920, 67]]);
  assert.deepEqual(got.meters, [{ tick: 0, num: 4, den: 4 }, { tick: 1920, num: 3, den: 4 }], 'the 3/4 bar still starts on the G');
  assert.deepEqual(got.marks, [{ tick: 0, text: 'Intro' }, { tick: 1920, text: 'B' }], 'B stays on the G; the section in force at the origin opens the song');
});

test('a pickup keeps its place in its bar, so the bar grid is kept', () => {
  const note = (step, d) => `<note><pitch><step>${step}</step><octave>4</octave></pitch><duration>${d}</duration></note>`;
  const rest = d => `<note><rest/><duration>${d}</duration></note>`;
  const xml = '<score-partwise version="4.0"><part-list><score-part id="P1"><part-name>P</part-name></score-part></part-list><part id="P1">'
    + `<measure number="1"><attributes><divisions>1</divisions><time><beats>4</beats><beat-type>4</beat-type></time></attributes><direction><sound tempo="120"/></direction>${rest(4)}</measure>`
    + `<measure number="2">${rest(3)}${note('C', 1)}</measure>`
    + `<measure number="3"><attributes><time><beats>3</beats><beat-type>4</beat-type></time></attributes><direction><direction-type><rehearsal>B</rehearsal></direction-type></direction>${note('G', 3)}</measure>`
    + '</part></score-partwise>';
  const got = importFile(parseMusicXML([xml]));
  assert.equal(got.origin, 1920, 'the empty bar goes; the pickup bar stays');
  assert.deepEqual(got.notes, [[1440, 60], [1920, 67]], 'the pickup is still on beat 4');
  assert.deepEqual(got.meters, [{ tick: 0, num: 4, den: 4 }, { tick: 1920, num: 3, den: 4 }]);
  assert.deepEqual(got.marks, [{ tick: 1920, text: 'B' }]);
});

test('shiftToOrigin: the entry in force at the origin moves to tick 0, earlier ones go', () => {
  const list = [{ tick: 3840, text: 'C' }, { tick: 0, text: 'A' }, { tick: 1920, text: 'B' }];
  assert.deepEqual(shiftToOrigin(list, 0), [{ tick: 0, text: 'A' }, { tick: 1920, text: 'B' }, { tick: 3840, text: 'C' }]);
  assert.deepEqual(shiftToOrigin(list, 1920), [{ tick: 0, text: 'B' }, { tick: 1920, text: 'C' }]);
  assert.deepEqual(shiftToOrigin(list, 2400), [{ tick: 0, text: 'B' }, { tick: 1440, text: 'C' }]);
  assert.deepEqual(shiftToOrigin([], 1920), []);
  assert.deepEqual(shiftToOrigin(undefined, 1920), []);
  assert.deepEqual(list.map(m => m.tick), [3840, 0, 1920], 'the file\'s own list is not changed');
});
