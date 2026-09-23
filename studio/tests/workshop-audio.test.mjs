// Studio Workshop: the offline mixdown's pure parts. The render itself runs
// SpessaSynth in a worker with the user's own bank (browser suite); here the
// event flattening, the Mobile instrument table and the WAV writer are pinned
// so the same song always gives the same events and the same bytes.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { parseAll } from '../web/workshop/mml.mjs';
import { buildEvents, buildSetup, EV_STRIDE, VEL_OFF } from '../web/workshop/mixnotes.mjs';
import { encodeWav, peakOf, gainFor, trimTail, CEILING } from '../web/workshop/mixmath.mjs';
import { MOBILE_INSTRUMENTS, mobilePresetValue, soundingKey, isKit, mobileForProgram } from '../web/workshop/instruments.mjs';

test('the eleven Mabinogi Mobile instruments map to the agreed GM programs and kit keys', () => {
  assert.deepEqual(MOBILE_INSTRUMENTS.map(m => [m.name, m.kit ? m.kit.join('/') : m.program]), [
    ['Lute', 24], ['Mandolin', 25], ['Chalumeau', 71], ['Xylophone', 13], ['Flute', 73], ['Violin', 40],
    ['Piano', 0], ['Harp', 46], ['Music Box', 10], ['BassDrum', '35/36'], ['Cymbals', '49/57'],
  ]);
  const drum = JSON.parse(mobilePresetValue(MOBILE_INSTRUMENTS.find(m => m.id === 'bassdrum')));
  assert.equal(isKit(drum), true);
  assert.deepEqual([soundingKey(drum, 48), soundingKey(drum, 60), soundingKey(drum, 72)], [35, 36, 36]);
  const cymbals = JSON.parse(mobilePresetValue(MOBILE_INSTRUMENTS.find(m => m.id === 'cymbals')));
  assert.deepEqual([soundingKey(cymbals, 59), soundingKey(cymbals, 60)], [49, 57]);
  assert.equal(soundingKey([0, 0, 24, 'lute'], 61), 61);
  assert.equal(soundingKey([0, 0, 24], 61), 61, 'a bank preset plays the written pitch');
  assert.equal(mobileForProgram(40).id, 'violin');
  assert.equal(mobileForProgram(0).id, 'piano', 'program 0 is Piano, never a kit');
});

test('events are sample-accurate, note-off first on a shared frame, six tracks only, kits mapped', () => {
  const texts = ['t120l4o4cc', 't120l4o4r4e', 'l4o3c', '', '', '', 't120l1o5c'];
  const song = parseAll(texts);
  const presets = [[0, 0, 24, 'lute'], [0, 0, 40, 'violin'], [0, 0, 0, 'bassdrum']];
  const a = buildEvents(song, { sampleRate: 44100, presets });
  const b = buildEvents(song, { sampleRate: 44100, presets });
  assert.deepEqual(a.events, b.events, 'deterministic');
  const rows = [];
  for (let i = 0; i < a.count; i++) rows.push([...a.events.slice(i * EV_STRIDE, i * EV_STRIDE + EV_STRIDE)]);
  // v8 default = velocity 68; 120 bpm quarter = 22050 frames at 44.1 kHz.
  assert.deepEqual(rows, [
    [0, 0, 60, 68], [0, 2, 35, 68],
    [22050, 0, 60, VEL_OFF], [22050, 2, 35, VEL_OFF], [22050, 0, 60, 68], [22050, 1, 64, 68],
    [44100, 0, 60, VEL_OFF], [44100, 1, 64, VEL_OFF],
  ], 'track 7 is not rendered; the BassDrum track sounds kit key 35; offs precede ons');
  assert.equal(a.totalFrames, Math.ceil((song.duration + 3) * 44100));
  assert.deepEqual(buildSetup(presets), [
    { ch: 0, msb: 0, lsb: 0, prog: 24, drum: false },
    { ch: 1, msb: 0, lsb: 0, prog: 40, drum: false },
    { ch: 2, msb: 0, lsb: 0, prog: 0, drum: true },
  ]);
});

test('the worker reads the same event layout', async () => {
  const worker = await readFile(new URL('../web/workshop/mix-worker.mjs', import.meta.url), 'utf8');
  assert.match(worker, new RegExp(`export const EV_STRIDE = ${EV_STRIDE};`));
  assert.match(worker, /from "\.\.\/\.\.\/\.\.\/vendor\/spessasynth\/core\.js"/, 'Studio\'s vendored engine, not a second copy');
});

test('WAV output is a deterministic 16-bit stereo RIFF with only-downward gain', () => {
  const n = 1000;
  const left = new Float32Array(n), right = new Float32Array(n);
  for (let i = 0; i < n; i++) { left[i] = Math.sin(i / 7) * 1.2; right[i] = Math.cos(i / 9) * 0.5; }
  const gain = gainFor(peakOf(left, right));
  assert.ok(gain < 1 && Math.abs(gain * 1.2 - CEILING) < 1e-3, 'a peak above the ceiling is brought down to it');
  assert.equal(gainFor(0.5), 1, 'quiet material is never boosted');
  const a = encodeWav(left, right, 44100, gain), b = encodeWav(left, right, 44100, gain);
  assert.deepEqual(a, b);
  const v = new DataView(a.buffer);
  const tag = at => String.fromCharCode(...a.slice(at, at + 4));
  assert.deepEqual([tag(0), tag(8), tag(12), tag(36)], ['RIFF', 'WAVE', 'fmt ', 'data']);
  assert.equal(v.getUint32(4, true), a.length - 8);
  assert.deepEqual([v.getUint16(20, true), v.getUint16(22, true), v.getUint32(24, true), v.getUint16(34, true)], [1, 2, 44100, 16]);
  assert.equal(v.getUint32(40, true), n * 4);
  assert.equal(a.length, 44 + n * 4);
  const loud = encodeWav(new Float32Array([2, -2]), new Float32Array([0, 0]), 8000);
  const lv = new DataView(loud.buffer);
  assert.deepEqual([lv.getInt16(44, true), lv.getInt16(48, true)], [32767, -32768], 'clipped, never wrapped');

  const tail = new Float32Array(44100 * 2); tail[100] = 0.5;
  const len = trimTail(tail, new Float32Array(tail.length), 44100);
  assert.ok(len > 100 && len < tail.length, 'silence after the last sound is trimmed');
});
