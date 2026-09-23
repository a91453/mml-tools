import test from 'node:test';
import assert from 'node:assert/strict';
import zlib from 'node:zlib';
import { readFile } from 'node:fs/promises';
import {
  LISTEN_LIMITS, LISTEN_LINK_SCHEMA, ListenLinkError, base64UrlDecode, base64UrlEncode, decodeListenLink, encodeListenLink,
  listenPayloadFromUrl, listenUrl, streamCodec, validateListenLink, withoutListenPayload,
} from '../web/listen-link.mjs';

// Node's zlib stands in for the browser's CompressionStream here; both speak
// raw deflate. The cap is enforced by the codec (maxOutputLength) and again by
// decodeListenLink itself.
const zlibCodec = {
  deflateRaw: bytes => new Uint8Array(zlib.deflateRawSync(bytes)),
  inflateRaw: (bytes, max) => {
    try { return new Uint8Array(zlib.inflateRawSync(bytes, { maxOutputLength: max })); }
    catch (error) { if (error.code === 'ERR_BUFFER_TOO_LARGE' || error instanceof RangeError) throw new ListenLinkError('LISTEN_LINK_TOO_LARGE', 'zlib cap'); throw error; }
  },
};
const { vectors } = JSON.parse(await readFile(new URL('./fixtures/listen-link-vectors.json', import.meta.url), 'utf8'));
const MML = 'MML@t120o4l4cdec,t120o3l2eg,,,,;';
const payloadOf = json => base64UrlEncode(new Uint8Array(zlib.deflateRawSync(Buffer.from(typeof json === 'string' ? json : JSON.stringify(json)))));
const rejects = (promise, code, field) => assert.rejects(promise, error => error instanceof ListenLinkError && error.code === code && (!field || error.message.includes(field)));

test('the golden vectors decode, re-encode byte-for-byte with zlib, and decode through the platform stream codec', async () => {
  assert.equal(vectors.length, 2);
  for (const vector of vectors) {
    assert.equal(JSON.stringify(vector.json), vector.json_text, `${vector.name}: json_text is the serialized json`);
    assert.deepEqual(await decodeListenLink(vector.payload, zlibCodec), vector.json, vector.name);
    assert.equal(await encodeListenLink(vector.json, zlibCodec), vector.payload, `${vector.name}: zlib encoding is deterministic`);
    // The browser path: DecompressionStream('deflate-raw') reads the same bytes.
    assert.deepEqual(await decodeListenLink(vector.payload, streamCodec), vector.json, `${vector.name} via DecompressionStream`);
    // And whatever CompressionStream writes decodes to the same document.
    assert.deepEqual(await decodeListenLink(await encodeListenLink(vector.json, streamCodec), zlibCodec), vector.json);
    assert.match(vector.payload, /^[A-Za-z0-9_-]+$/, 'base64url without padding');
  }
  const full = vectors.find(v => v.name === 'full').json;
  assert.equal(full.markers.length, 5);
  assert.deepEqual(full.start, { bar: 2 });
});

test('base64url round-trips every length and refuses padding or foreign characters', () => {
  for (let n = 0; n < 40; n++) {
    const bytes = Uint8Array.from({ length: n }, (_, i) => (i * 37 + n) & 255);
    const text = base64UrlEncode(bytes);
    assert.equal(text, Buffer.from(bytes).toString('base64url'));
    assert.deepEqual(base64UrlDecode(text), bytes);
  }
  for (const bad of ['abc=', 'ab+c', 'ab/c', 'a', 'abcde', 'ab cd']) assert.throws(() => base64UrlDecode(bad), /LISTEN_LINK_CORRUPT/);
});

test('an unknown or missing schema is refused before anything else is read', async () => {
  await rejects(decodeListenLink(payloadOf({ schema: 'mml-studio/listen-link@2', mml: MML }), zlibCodec), 'LISTEN_LINK_UNKNOWN_SCHEMA');
  await rejects(decodeListenLink(payloadOf({ mml: MML }), zlibCodec), 'LISTEN_LINK_UNKNOWN_SCHEMA');
  await rejects(decodeListenLink(payloadOf([LISTEN_LINK_SCHEMA]), zlibCodec), 'LISTEN_LINK_INVALID', 'link');
});

test('every field is validated and the first wrong one is named', async () => {
  const base = { schema: LISTEN_LINK_SCHEMA, mml: MML };
  const cases = [
    [{ mml: undefined }, 'mml'], [{ mml: 'MML@c,d;' }, 'mml'], [{ mml: 'c,d,e,f,g,a;' }, 'mml'], [{ mml: `MML@${'c'.repeat(40000)},,,,,;` }, 'mml'],
    [{ mml: 'MML@c\u0000,,,,,;' }, 'mml'], [{ mml: 'MML@ｃ,,,,,;' }, 'mml'],
    [{ title: 'x'.repeat(121) }, 'title'], [{ title: 'a\nb' }, 'title'], [{ title: 3 }, 'title'],
    [{ meter_text: '1 4/4' }, 'meter_text'], [{ meter_text: '0 4/3' }, 'meter_text'], [{ meter_text: '0 4/4\n0 3/4' }, 'meter_text'], [{ meter_text: '0 four/4' }, 'meter_text'],
    [{ start: { bar: 0 } }, 'start.bar'], [{ start: { bar: 1.5 } }, 'start.bar'], [{ start: { bar: 1, beat: '0' } }, 'start'], [{ start: { beat: '-1' } }, 'start.beat'], [{ start: { beat: 4 } }, 'start.beat'], [{ start: 'bar 3' }, 'start'],
    [{ markers: {} }, 'markers'], [{ markers: Array.from({ length: 501 }, () => ({ beat: '0', kind: 'note' })) }, 'markers'],
    [{ markers: [{ beat: '4', kind: 'loud' }] }, 'markers[0].kind'], [{ markers: [{ kind: 'note' }] }, 'markers[0].beat'],
    [{ markers: [{ beat: '4', end_beat: '3', kind: 'note' }] }, 'markers[0].end_beat'], [{ markers: [{ beat: '4', role: 'Drums', kind: 'note' }] }, 'markers[0].role'],
    [{ markers: [{ beat: '4', kind: 'note', label: 'x'.repeat(201) }] }, 'markers[0].label'], [{ markers: [{ beat: '4', kind: 'note' }, null] }, 'markers[1]'],
    [{ compare_mml: 'MML@;' }, 'compare_mml'],
    [{ source: { project_id: '../etc' } }, 'source.project_id'], [{ source: { artifact_id: 'a b' } }, 'source.artifact_id'], [{ source: [] }, 'source'],
  ];
  for (const [patch, field] of cases) {
    const value = { ...base, ...patch };
    for (const key of Object.keys(patch)) if (patch[key] === undefined) delete value[key];
    assert.throws(() => validateListenLink(value), error => error.code === 'LISTEN_LINK_INVALID' && error.message.includes(field), `${JSON.stringify(patch).slice(0, 80)} should name ${field}`);
    await rejects(decodeListenLink(payloadOf(value), zlibCodec), 'LISTEN_LINK_INVALID', field);
  }
});

test('valid input is normalised into contract order, unknown keys are dropped and nothing extra is carried', () => {
  const out = validateListenLink({ extra: '<script>', source: { project_id: 'prj_a', note: 'x' }, markers: [{ label: 'L', kind: 'note', beat: '177/2', color: 'red' }], meter_text: '0 3/4\r\n12 4/4\n', title: '  標題  ', mml: `  ${MML}\n`, schema: LISTEN_LINK_SCHEMA, start: { beat: '6' } });
  assert.deepEqual(Object.keys(out), ['schema', 'mml', 'title', 'meter_text', 'start', 'markers', 'source']);
  assert.equal(out.mml, MML);
  assert.equal(out.title, '標題');
  assert.equal(out.meter_text, '0 3/4\n12 4/4');
  assert.deepEqual(out.markers, [{ beat: '177/2', kind: 'note', label: 'L' }]);
  assert.deepEqual(out.source, { project_id: 'prj_a' });
  assert.equal(JSON.stringify(out).includes('script'), false);
  // Decimal meter beats are accepted as the Studio meter text writes them.
  assert.equal(validateListenLink({ schema: LISTEN_LINK_SCHEMA, mml: MML, meter_text: '0 4/4\n6.5 3/8' }).meter_text, '0 4/4\n6.5 3/8');
});

test('size limits: the decoded JSON is capped at 256 KiB and reading stops at the cap', async () => {
  // A tiny payload that inflates far past the cap (a decompression bomb).
  const bomb = base64UrlEncode(new Uint8Array(zlib.deflateRawSync(Buffer.alloc(8 * 1024 * 1024, 32))));
  assert.ok(bomb.length < 20000);
  await rejects(decodeListenLink(bomb, zlibCodec), 'LISTEN_LINK_TOO_LARGE');
  await rejects(decodeListenLink(bomb, streamCodec), 'LISTEN_LINK_TOO_LARGE');
  // A codec that ignores the cap is still refused by the decoder itself.
  const careless = { inflateRaw: bytes => new Uint8Array(zlib.inflateRawSync(bytes)) };
  await rejects(decodeListenLink(bomb, careless), 'LISTEN_LINK_TOO_LARGE');
  // Just under the cap is fine; the payload-length cap comes first for huge input.
  const labels = Array.from({ length: 500 }, (_, i) => ({ beat: String(i), kind: 'note', label: `${i}`.padEnd(200, 'x') }));
  const big = { schema: LISTEN_LINK_SCHEMA, mml: `MML@${'c'.repeat(39990)},,,,,;`, markers: labels };
  assert.ok(JSON.stringify(big).length < LISTEN_LIMITS.jsonBytes);
  assert.deepEqual(await decodeListenLink(await encodeListenLink(big, zlibCodec), zlibCodec), big);
  await rejects(decodeListenLink('A'.repeat(LISTEN_LIMITS.payloadChars + 4), zlibCodec), 'LISTEN_LINK_TOO_LARGE');
  // The encoder refuses a document over the JSON cap.
  const over = { schema: LISTEN_LINK_SCHEMA, mml: `MML@${'c'.repeat(39990)},,,,,;`, compare_mml: `MML@${'d'.repeat(39990)},,,,,;`, markers: labels.map(m => ({ ...m, label: '字'.repeat(200) })) };
  await rejects(encodeListenLink(over, zlibCodec), 'LISTEN_LINK_TOO_LARGE');
});

test('corrupt payloads are refused as corrupt, never half-read', async () => {
  await rejects(decodeListenLink('', zlibCodec), 'LISTEN_LINK_CORRUPT');
  await rejects(decodeListenLink('not base64!', zlibCodec), 'LISTEN_LINK_CORRUPT');
  await rejects(decodeListenLink(base64UrlEncode(Uint8Array.from([255, 254, 253, 1, 2, 3])), zlibCodec), 'LISTEN_LINK_CORRUPT');
  await rejects(decodeListenLink(base64UrlEncode(new Uint8Array(zlib.deflateRawSync(Buffer.from([0xff, 0xfe, 0x7b])))), zlibCodec), 'LISTEN_LINK_CORRUPT');
  await rejects(decodeListenLink(payloadOf('{"schema":'), zlibCodec), 'LISTEN_LINK_CORRUPT');
});

test('the payload is found in #listen= or ?listen=, and removed again for replaceState', () => {
  const payload = vectors[0].payload;
  assert.deepEqual(listenPayloadFromUrl(`https://studio.example/app/#listen=${payload}`), { payload, from: 'hash' });
  assert.deepEqual(listenPayloadFromUrl(`https://studio.example/app/?listen=${payload}`), { payload, from: 'query' });
  assert.deepEqual(listenPayloadFromUrl(`https://studio.example/app/?x=1#main&listen=${payload}`), { payload, from: 'hash' });
  assert.equal(listenPayloadFromUrl('https://studio.example/app/#main'), null);
  assert.equal(withoutListenPayload(`https://studio.example/app/#listen=${payload}`), 'https://studio.example/app/');
  assert.equal(withoutListenPayload(`https://studio.example/app/?a=1&listen=${payload}#main`), 'https://studio.example/app/?a=1#main');
  assert.equal(withoutListenPayload(`https://studio.example/app/#main&listen=${payload}`), 'https://studio.example/app/#main');
  assert.equal(listenUrl('https://studio.example/app/?listen=old#main', payload), `https://studio.example/app/#listen=${payload}`);
});
