// Studio Workshop: 3MLE `.mml` / MabiIcco-style `.mmi` import and export,
// including the bzip2-compressed 3MLE EXTENSION block (programs, head meter,
// marks). Workshop files are outside the Canonical pipeline.
import test from 'node:test';
import assert from 'node:assert/strict';
import { toMml, toMmi } from '../web/workshop/mml-out.mjs';
import { parseScore, sniff } from '../web/workshop/mml-in.mjs';
import { buildExtension, parseExtension, EXT_SECTION } from '../web/workshop/mml-ext.mjs';
import { compress, decompress } from '../web/workshop/bzip2.mjs';

const texts = ['t120v12l8o5ceg>c<gec4', 't120v10l2o4eg', 't120l1o3c'];
const meters = [{ tick: 0, num: 3, den: 4 }, { tick: 1440, num: 4, den: 4 }];
const marks = [{ tick: 0, text: 'Intro' }, { tick: 1920, text: 'A 段' }];
const strip = parts => parts.map(p => p.text.replace(/\s+/g, ''));

test('.mml round trip keeps every channel, the programs, the head meter and the marks', () => {
  const file = toMml(texts, { title: 'Round trip', programs: [24, 40, 0], meters, marks });
  assert.match(file, /^\[Settings\]\r\nEncoding=utf-8\r\nTitle=Round trip\r\n/);
  assert.ok(file.includes(`[${EXT_SECTION}]`));
  assert.equal(sniff(file), 'mml');
  const back = parseScore(file);
  assert.equal(back.kind, 'mml');
  assert.equal(back.title, 'Round trip');
  assert.deepEqual(strip(back.parts), texts);
  assert.deepEqual(back.parts.map(p => p.program), [24, 40, 0]);
  assert.deepEqual(back.meters, [{ tick: 0, num: 3, den: 4 }], '3MLE stores one (head) time signature');
  assert.deepEqual(back.marks, marks);
});

test('.mmi round trip keeps tracks, programs, every meter change and the marks', () => {
  const file = toMmi(texts, { title: 'MMI', programs: [24, 40, 0], meters, marks, bpm: 120 });
  assert.equal(sniff(file), 'mmi');
  const back = parseScore(file);
  assert.equal(back.kind, 'mmi');
  assert.deepEqual(strip(back.parts), texts);
  assert.deepEqual(back.parts.map(p => p.program), [24, 40, 0]);
  assert.deepEqual(back.meters, meters);
  assert.deepEqual(back.marks, marks);
});

test('a damaged extension block is ignored instead of misread', () => {
  const file = toMml(texts, { title: 'x', programs: [24, 40, 0], meters, marks });
  const body = file.slice(file.indexOf(`[${EXT_SECTION}]`) + EXT_SECTION.length + 2);
  assert.ok(parseExtension(body, 'utf-8'), 'the intact block parses');
  const damaged = body.replace(/^(d=)(.)/m, (m, d, c) => d + (c === 'A' ? 'B' : 'A'));
  assert.equal(parseExtension(damaged, 'utf-8'), null, 'a checksum mismatch rejects the block');
  const back = parseScore(file.replace(body, damaged));
  assert.deepEqual(strip(back.parts), texts, 'the channels still import without the extension');
});

test('bzip2 compress/decompress round trip, and the extension builder is deterministic', () => {
  let seed = 7;
  const rnd = () => (seed = (seed * 1103515245 + 12345) >>> 0) / 2 ** 32;
  for (const size of [0, 1, 100, 5000, 70000]) {
    const bytes = new Uint8Array(size);
    for (let i = 0; i < size; i++) bytes[i] = rnd() < 0.7 ? 65 + (i % 7) : Math.floor(rnd() * 256);
    assert.deepEqual(decompress(compress(bytes)), bytes, `size ${size}`);
  }
  const channels = [{ channelNumber: 1, name: 'main', program: 24 }, { channelNumber: 2, name: 'chord1', program: 40 }];
  assert.equal(buildExtension(channels, meters[0], []), buildExtension(channels, meters[0], []));
});
