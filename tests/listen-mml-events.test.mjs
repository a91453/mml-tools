// The listening widget times notes with server/listen/mml-events.mjs, a
// dependency-free copy of the Studio parser's ingest reading. These tests pin
// that the two agree note for note on synthetic MML, so a player can never
// sound a note somewhere the Studio does not place it. They also cover the
// timeline helpers and the in-memory SF2 reader the widget inlines.

import test from 'node:test';
import assert from 'node:assert/strict';

import { validateMML } from '../studio/backend/mml/parser.mjs';
import { F } from '../dist/core.js';
import {
  parseListenMml, listenTempoMap, listenSecondsAt, listenBeatAt, listenBars, listenBarAt, listenBeatNumber,
} from '../server/listen/mml-events.mjs';
import { parseSoundFont, soundFontRegions, soundFontSampleData, SoundFontError } from '../server/listen/sf2.mjs';
import { syntheticBank } from './fixtures/synthetic-soundfont.mjs';

const CASES = [
  // plain notes, accidentals, octave steps, dots, ties, rests
  'MML@t120o4c4d8.e16f+4&f4g-2r4a#8b8>c1,t120o3l8cdefgab>c<<c2,,,,;',
  // triplet and odd lengths, numeric notes, a volume out of range
  'MML@t90l3o5c.d.e&e<b12a24g48f64,t90o4n60n48l16n0,t90o4c4&c4&c2,t90o4c4&d4e2,t90o4l65c4c,t90o4l0cc4v12d4v99e4;',
  // tempo changes in every role, one role longer than the rest
  'MML@t120o4c4t140d4t150e4t160f4,t120o4c4t140d4t150e4t160f4,,,,t120o4r1r4;',
  // uppercase, default lengths
  'MML@T120O4C4D4E4F4,T120O4CDEF,,,,;',
  // recoverable findings: unknown characters, doubled ties, out-of-range lengths, dots
  'MML@t120o4cx4d4&&e4,t120c4o4d4,t120o4c128d4,t120o4c4.....d4,t120o4c4 d4,t120o4c4&r4;',
  // numeric notes out of range and a missing octave, no tempo anywhere
  'MML@o4n200c4,l8cde,,,,n60;',
  // long ties across bar lines and octave jumps inside ties
  'MML@t100o4c1&c1&c2&c4&c8&c16&c32&c64,t100o4c2&>c2<c1,t100o3a2.&a8.&a16,,,;',
];

const eventsOf = track => track.events.map(event => `${event.pitch}:${event.start}:${event.end}:${event.volume}`);

test('the listening parser places every note exactly where the Studio ingest parser does', () => {
  for (const mml of CASES) {
    const repo = validateMML(mml, { validationMode: 'ingest', meterText: '0 4/4' });
    const listen = parseListenMml(mml);
    assert.equal(listen.tracks.length, 6, mml);
    for (let index = 0; index < 6; index++) {
      const expected = repo.song.tracks[index];
      const actual = listen.tracks[index];
      assert.deepEqual(eventsOf(actual), eventsOf(expected), `${mml} role ${index}`);
      assert.equal(actual.total, expected.total, `${mml} role ${index} total`);
      assert.deepEqual(actual.tempo, expected.tempo, `${mml} role ${index} tempo`);
      assert.equal(actual.empty, expected.empty);
    }
    assert.equal(listen.total, repo.song.total, `${mml} song total`);
    assert.deepEqual(listen.tempo, repo.song.tempo, `${mml} song tempo`);
    // Beats are printed exactly as the repository's F prints them.
    for (const track of listen.tracks) for (const event of track.events) assert.equal(new F(event.end).toString(), event.end);
  }
});

test('the envelope is refused the same way, and an all-empty song is not playable', () => {
  for (const bad of ['c4d4', 'MML@c4,,,,;', 'MML@c4,,,,,,;', 'MML@c4,,,,,', 42]) {
    const listen = parseListenMml(bad);
    assert.equal(listen.ok, false);
    assert.equal(listen.tracks.length, 0);
    assert.ok(listen.error);
  }
  const empty = parseListenMml('MML@,,,,,;');
  assert.equal(empty.ok, false);
  assert.equal(empty.tracks.length, 6);
  assert.equal(parseListenMml(`MML@${'c'.repeat(40001)},,,,,;`).ok, false);
});

test('tempo map, seconds and beats agree with the repository timing', () => {
  const song = parseListenMml('MML@t120o4c4t60d4t240e4f4,,,,,;');
  const map = listenTempoMap(song.tempo);
  assert.deepEqual(map, [{ beat: 0, bpm: 120 }, { beat: 1, bpm: 60 }, { beat: 2, bpm: 240 }]);
  assert.equal(listenSecondsAt(map, 0), 0);
  assert.equal(listenSecondsAt(map, 1), 0.5);
  assert.equal(listenSecondsAt(map, 2), 1.5);
  assert.equal(listenSecondsAt(map, 4), 2);
  for (const beat of [0, 0.5, 1, 1.25, 2, 3.5, 4]) assert.ok(Math.abs(listenBeatAt(map, listenSecondsAt(map, beat)) - beat) < 1e-9);
  // No T at all previews at 120, and a later entry at the same beat wins.
  assert.deepEqual(listenTempoMap([]), [{ beat: 0, bpm: 120 }]);
  assert.deepEqual(listenTempoMap([{ beat: '0', bpm: 90 }, { beat: '0', bpm: 100 }]), [{ beat: 0, bpm: 100 }]);
  assert.equal(listenBeatNumber('177/2'), 88.5);
  assert.ok(Number.isNaN(listenBeatNumber('1.5')));
});

test('bars follow the stated meter map and never invent one', () => {
  const bars = listenBars('0 2/4\n2 4/4\n10 3/4', 16);
  assert.deepEqual(bars.map(bar => [bar.index, bar.start, bar.end, `${bar.numerator}/${bar.denominator}`]), [
    [1, 0, 2, '2/4'], [2, 2, 6, '4/4'], [3, 6, 10, '4/4'], [4, 10, 13, '3/4'], [5, 13, 16, '3/4'],
  ]);
  assert.equal(listenBarAt(bars, 0).index, 1);
  assert.equal(listenBarAt(bars, 6).index, 3);
  assert.equal(listenBarAt(bars, 12.99).index, 4);
  // A pickup shortens the first bar; a partial last bar is kept.
  assert.deepEqual(listenBars('0 4/4', 9, { pickup: '1' }).map(bar => [bar.start, bar.end, bar.partial]), [[0, 1, true], [1, 5, false], [5, 9, false]]);
  assert.deepEqual(listenBars('0 4/4', 6).map(bar => [bar.start, bar.end, bar.partial]), [[0, 4, false], [4, 6, true]]);
  // No meter, a malformed one, or one that does not start at 0: no bars.
  for (const meter of [null, '', '4/4', '1 4/4', '0 4/3']) assert.equal(listenBars(meter, 8), null, String(meter));
  assert.equal(listenBarAt(null, 3), null);
});

// ─── SF2 ─────────────────────────────────────────────────────────────────────

test('a synthetic SF2 bank is read into presets and key regions, in memory only', () => {
  const bank = parseSoundFont(syntheticBank());
  assert.equal(bank.compressed, false);
  assert.deepEqual(bank.presets.map(preset => [preset.name, preset.bank, preset.program]), [['Synthetic Lead', 0, 5]]);
  const [region] = soundFontRegions(bank, 0, 72, 100);
  assert.ok(region, 'a key inside the zone sounds');
  // Root 60 (overridden), +1 coarse, -5 cents correction.
  assert.ok(Math.abs(region.semitones - (72 - 60 + 1 - 0.05)) < 1e-9);
  assert.equal(region.loop, true);
  assert.equal(region.sampleRate, 22050);
  assert.ok(Math.abs(region.gain - 10 ** (-20 / 200)) < 1e-9, 'preset attenuation is added');
  assert.equal(region.pan, 0.5);
  assert.ok(Math.abs(region.attack - 0.5) < 1e-9, 'the global zone supplies the attack');
  const data = soundFontSampleData(bank, region);
  assert.equal(data.length, 100);
  assert.ok(Math.abs(data[25] - 16000 / 32768) < 1e-3);
  assert.deepEqual(soundFontRegions(bank, 0, 40, 100), [], 'a key outside the zone is silent');
  assert.deepEqual(soundFontRegions(bank, 3, 72, 100), [], 'an unknown preset is silent');
});

test('the SF2 reader refuses what it cannot play instead of guessing', () => {
  const refuses = (buffer, pattern) => assert.throws(() => parseSoundFont(buffer), error => error instanceof SoundFontError && pattern.test(error.message));
  const dls = Buffer.concat([Buffer.from('RIFF'), Buffer.from([4, 0, 0, 0]), Buffer.from('DLS ')]);
  refuses(dls.buffer.slice(dls.byteOffset, dls.byteOffset + dls.byteLength), /DLS/);
  refuses(new TextEncoder().encode('not a riff file').buffer, /RIFF/);
  const good = syntheticBank();
  refuses(good.slice(0, good.byteLength - 60), /截斷/);
  assert.throws(() => parseSoundFont('text'), SoundFontError);
  // A sample header addressing points outside the smpl chunk (146 points here)
  // is a damaged bank: refused when read, not a RangeError while playing.
  for (const sample of [{ start: 100000, end: 100100, startLoop: 100010, endLoop: 100090 }, { end: 147 }, { start: 60, end: 50 }]) {
    refuses(syntheticBank({ sample }), /Synthetic Sine.*超出取樣資料範圍/);
  }
  assert.equal(parseSoundFont(syntheticBank({ sample: { end: 146 } })).samples[0].end, 146, 'a range ending at the last point is inside');
  // ROM samples address ROM, compressed (SF3) ones address Ogg bytes: neither is
  // measured in smpl points, and a compressed bank keeps its own refusal.
  assert.equal(parseSoundFont(syntheticBank({ sample: { start: 100000, end: 100100, sampleType: 0x8001 } })).samples.length, 1);
  assert.equal(parseSoundFont(syntheticBank({ sample: { start: 100000, end: 100100, sampleType: 0x11 } })).compressed, true);
});

test('SF2 sample data is read only inside the smpl chunk', () => {
  const bank = parseSoundFont(syntheticBank());
  const [region] = soundFontRegions(bank, 0, 72, 100);
  const points = bank.smpl.size / 2;
  assert.equal(points, 146);
  const read = (start, end) => soundFontSampleData(bank, { ...region, start, end });
  // Ranges past the data, reversed or empty read as nothing instead of throwing.
  for (const [start, end] of [[100000, 100100], [points, points + 10], [points + 1, 50], [60, 50], [40, 40], [-20, -10], [Number.NaN, 10]]) {
    const data = read(start, end);
    assert.ok(data instanceof Float32Array, `${start}..${end}`);
    assert.equal(data.length, 0, `${start}..${end}`);
  }
  // A range reaching past either edge keeps only the part inside.
  assert.equal(read(140, 10000).length, points - 140);
  assert.equal(read(-30, 10).length, 10);
  assert.deepEqual([...read(-30, 10)], [...read(0, 10)]);
  assert.ok(Math.abs(read(20, 200)[5] - 16000 / 32768) < 1e-3, 'offset 25 of the sine, read from 20');
  // A zone's address offsets can move a region of a valid bank past the data;
  // that region reads as empty (the player then sounds the note with its synth).
  const shifted = parseSoundFont(syntheticBank({ zoneGenerators: [[4, 1]] }));
  const [moved] = soundFontRegions(shifted, 0, 72, 100);
  assert.equal(moved.start, 32768);
  assert.equal(soundFontSampleData(shifted, moved).length, 0);
});
