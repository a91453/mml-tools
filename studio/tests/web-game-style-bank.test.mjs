import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { GAME_INSTRUMENTS, GAME_STYLE_BANK_LABEL, GAME_STYLE_BANK_NAME, GAME_STYLE_PROGRAMS, resolveRoleVoices, uniformProgram, voiceFor } from '../web/preview/instruments.mjs';
import { GAME_STYLE_BANK, GAME_STYLE_DEF, GAME_STYLE_DOWNLOAD_NOTICE, loadGameStyleBank, siteUrl } from '../web/preview/game-style-bank.mjs';

const sha256 = value => createHash('sha256').update(value).digest('hex');
const pins = JSON.parse(await readFile(new URL('../../ops/permanent/sound-banks.json', import.meta.url), 'utf8'));

test('the page pins the same game-style files the Studio Web function serves', () => {
  const bank = pins.banks.find(item => item.id === 'game-style');
  const byExt = Object.fromEntries(bank.files.map(pin => [pin.extension, pin]));
  for (const [page, served] of [[GAME_STYLE_BANK, byExt['.dls']], [GAME_STYLE_DEF, byExt['.def']]]) {
    assert.deepEqual({ ...page }, { path: served.path, sha256: served.sha256, bytes: served.bytes });
  }
  // The build keeps the repository layout (studio/web/… at /studio/web/…), so
  // the site root is the repository root.
  assert.equal(siteUrl(GAME_STYLE_BANK.path), new URL(GAME_STYLE_BANK.path, new URL('../../', import.meta.url)).href, 'served from the site root');
  assert.equal(GAME_STYLE_DOWNLOAD_NOTICE, '第一次使用遊戲風格音色：將從本網站下載約 15.3 MB，只存在這台裝置');
  assert.equal(GAME_STYLE_BANK_NAME, '遊戲風格音色');
  assert.doesNotMatch(`${GAME_STYLE_BANK_NAME}${GAME_STYLE_BANK_LABEL}${GAME_STYLE_BANK.path}`, /fury/i);
});

test('with the game-style bank every game instrument plays its own melodic preset', () => {
  assert.deepEqual(Object.keys(GAME_STYLE_PROGRAMS).sort(), GAME_INSTRUMENTS.map(item => item.id).sort());
  const voices = resolveRoleVoices(['lute', 'harp', 'piano', 'bass-drum', 'cymbals', 'nonsense'], { gameStyle: true });
  assert.deepEqual(voices.map(v => [v.program, v.drumNote]), [[0, null], [24, null], [21, null], [66, null], [68, null], [0, null]]);
  assert.equal(uniformProgram(resolveRoleVoices(Array(6).fill('violin'), { gameStyle: true })), 22);
  assert.equal(voiceFor('bass-drum').drumNote, 35, 'the free default bank still uses the GM kit');
  assert.deepEqual(voiceFor('p:5', { gameStyle: true }), { program: 5, drumNote: null, label: '006' });
});

function fixture(bytes) {
  const pin = { path: 'banks/game-style/x.dls', sha256: sha256(bytes), bytes: bytes.length };
  const stored = new Map();
  const cache = { load: async sha => stored.get(sha) ?? null, store: async record => { stored.set(record.sha256, record); } };
  return { pin, stored, cache };
}
const respond = (bytes, status = 200) => async () => new Response(status === 200 ? bytes : 'Not found', { status });

test('the game-style bank is downloaded once, verified, kept, and a kept copy is checked again', async () => {
  const bytes = new TextEncoder().encode('RIFF game-style fixture DLS ');
  const { pin, stored, cache } = fixture(bytes);
  let requests = 0;
  const fetchImpl = async (url, init) => { requests++; assert.equal(init.credentials, 'same-origin'); assert.ok(url.endsWith(pin.path)); return new Response(bytes); };
  const progress = [];
  const first = await loadGameStyleBank({ fetchImpl, cache, pin, onProgress: p => progress.push(p.phase) });
  assert.equal(first.downloaded, true); assert.equal(first.stored, true);
  assert.equal(first.name, '遊戲風格音色'); assert.equal(first.isDefault, true); assert.equal(first.preset, 'game-style');
  assert.deepEqual(new Uint8Array(first.bytes), bytes);
  assert.equal(progress.at(-1), 'done');
  const second = await loadGameStyleBank({ fetchImpl, cache, pin });
  assert.equal(second.downloaded, false); assert.equal(requests, 1);
  // A kept copy that no longer matches is replaced by a fresh download.
  new Uint8Array(stored.get(pin.sha256).bytes)[0] ^= 1;
  assert.equal((await loadGameStyleBank({ fetchImpl, cache, pin })).downloaded, true);
  assert.equal(requests, 2);
  // A browser that cannot keep it still plays the verified bytes.
  const unkept = await loadGameStyleBank({ fetchImpl, cache: { load: async () => null, store: async () => { throw Error('quota'); } }, pin });
  assert.equal(unkept.stored, false);
});

test('an altered, oversized, absent or unreachable game-style bank is refused and never kept', async () => {
  const bytes = new TextEncoder().encode('RIFF game-style fixture DLS ');
  const { pin, stored, cache } = fixture(bytes);
  const altered = bytes.slice(); altered[3] ^= 1;
  await assert.rejects(loadGameStyleBank({ fetchImpl: respond(altered), cache, pin }), { code: 'GAME_STYLE_BANK_MISMATCH' });
  await assert.rejects(loadGameStyleBank({ fetchImpl: respond(new Uint8Array([...bytes, 0])), cache, pin }), { code: 'GAME_STYLE_BANK_MISMATCH', message: /大於/ });
  await assert.rejects(loadGameStyleBank({ fetchImpl: respond(bytes, 404), cache, pin }), { code: 'GAME_STYLE_BANK_ABSENT', message: /這個網站沒有提供遊戲風格音色/ });
  await assert.rejects(loadGameStyleBank({ fetchImpl: respond(bytes, 503), cache, pin }), { code: 'GAME_STYLE_BANK_DOWNLOAD_FAILED', message: /HTTP 503/ });
  await assert.rejects(loadGameStyleBank({ fetchImpl: async () => { throw TypeError('Failed to fetch'); }, cache, pin }), { code: 'GAME_STYLE_BANK_DOWNLOAD_FAILED', message: /可能離線/ });
  assert.equal(stored.size, 0);
});
