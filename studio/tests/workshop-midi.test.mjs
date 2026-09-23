// Studio Workshop: Standard MIDI File export and import round trip.
import test from 'node:test';
import assert from 'node:assert/strict';
import { parseAll } from '../web/workshop/mml.mjs';
import { toMIDI } from '../web/workshop/midi-out.mjs';
import { parseSMF, inventory, buildImport, fileOrigin } from '../web/workshop/midi-in.mjs';

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
