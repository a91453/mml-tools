import assert from 'node:assert/strict';
import zlib from 'node:zlib';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import * as core from 'spessasynth_core';
import { encodeListenLink } from '../web/listen-link.mjs';
import { DEFAULT_BANK_DOWNLOAD_NOTICE, DEFAULT_BANK_SUBSET, DEFAULT_BANK_UPSTREAM } from '../web/preview/default-bank.mjs';
import { trimDefaultBank } from '../web/preview/default-bank-trim.mjs';
import { syntheticUpstreamBank } from '../tests/support/synthetic-soundbank.mjs';
import { countBankSends } from './bank-sends.mjs';

// The free default preview bank through the real page, Worker and engine, in a
// browser context of its own: its storage starts empty, and the upstream URL
// is answered locally, so nothing here reaches the network.
//
// With STUDIO_DEFAULT_BANK_SOURCE (a local copy of the pinned upstream file)
// the page verifies the real digests it ships. Without it, a small synthetic
// stand-in is served and the test swaps the two pinned digests for the
// stand-in's in the module response itself. That exists only in this harness:
// the page reads its pins from its own code, so nothing a user can do (a link,
// a file, storage) changes them. Service Workers are blocked in this context
// so every module comes from the server, where the swap happens.
const codec = { deflateRaw: bytes => new Uint8Array(zlib.deflateRawSync(bytes)), inflateRaw: (bytes, max) => new Uint8Array(zlib.inflateRawSync(bytes, { maxOutputLength: max })) };
const LABEL = '免費通用音色（近似），不是遊戲音色';
const NAMES = ['魯特琴（Lute）', '曼陀林（Mandolin）', '夏盧莫管（Chalumeau）', '木琴（Xylophone）', '長笛（Flute）', '小提琴（Violin）', '鋼琴（Piano）', '豎琴（Harp）', '音樂盒（Music Box）', '大鼓（BassDrum）', '鈸（Cymbals）'];
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');

// The upstream file served in place of the real one, and the subset the page
// derives from it (`subset`, the bytes its engine plays).
export async function upstreamFixture() {
  const source = process.env.STUDIO_DEFAULT_BANK_SOURCE;
  if (source) {
    const body = await readFile(source);
    assert.equal(sha256(body), DEFAULT_BANK_UPSTREAM.sha256, 'STUDIO_DEFAULT_BANK_SOURCE is the pinned upstream file');
    return { body, subset: Buffer.from(trimDefaultBank(body, core).bytes), subsetSha256: DEFAULT_BANK_SUBSET.sha256, swap: null, real: true };
  }
  const body = Buffer.from(syntheticUpstreamBank());
  const subset = Buffer.from(trimDefaultBank(body, core).bytes);
  const subsetSha256 = sha256(subset);
  return { body, subset, subsetSha256, swap: [[DEFAULT_BANK_UPSTREAM.sha256, sha256(body)], [DEFAULT_BANK_SUBSET.sha256, subsetSha256]], real: false };
}
// With the synthetic stand-in, the two pinned digests are swapped for its
// own in the module response (see above).
export async function swapPinnedDigests(context, fixture) {
  if (!fixture.swap) return;
  await context.route('**/studio/web/preview/default-bank.mjs', async route => {
    const response = await route.fetch();
    let text = await response.text();
    for (const [pinned, stand] of fixture.swap) { assert.ok(text.includes(pinned), 'the module carries the pinned digest'); text = text.replaceAll(pinned, stand); }
    await route.fulfill({ response, body: text });
  });
}

export async function runDefaultBankChecks({ browser, base, profile }) {
  const fixture = await upstreamFixture();
  const context = await browser.newContext({ viewport: profile.viewport, isMobile: profile.isMobile, hasTouch: profile.hasTouch, serviceWorkers: 'block' });
  const errors = [], upstreamRequests = [];
  try {
    await swapPinnedDigests(context, fixture);
    // The upstream answer is switchable: held (to watch the progress note),
    // served, altered by one byte, or unreachable.
    let mode = 'serve', release = null, arrived = null;
    const hold = () => { mode = 'hold'; return new Promise(resolve => { arrived = resolve; }); };
    await context.route(DEFAULT_BANK_UPSTREAM.url, async route => {
      if (mode === 'hold') await new Promise(resolve => { release = resolve; arrived(); });
      if (mode === 'offline') return route.abort('internetdisconnected');
      const body = Buffer.from(fixture.body);
      if (mode === 'altered') body[body.length - 1] ^= 1;
      await route.fulfill({ status: 200, headers: { 'content-type': 'application/octet-stream', 'access-control-allow-origin': '*', 'content-length': String(body.length) }, body });
    });
    const page = await context.newPage();
    page.on('pageerror', error => errors.push(error.message));
    page.on('request', request => { if (request.url() === DEFAULT_BANK_UPSTREAM.url) upstreamRequests.push(request.url()); });
    const settled = () => page.waitForFunction(() => document.querySelector('#app')?.getAttribute('aria-busy') === 'false' && document.querySelector('#app h1'));
    const cachedSubset = () => page.evaluate(async sha => {
      const record = await (await import('./studio/web/preview/soundbank-store.mjs')).loadDefaultSubset(sha);
      if (!record) return null;
      return [...new Uint8Array(await crypto.subtle.digest('SHA-256', record.bytes))].map(b => b.toString(16).padStart(2, '0')).join('');
    }, fixture.subsetSha256);
    const played = () => page.waitForFunction(() => Number(document.querySelector('#listen-position')?.dataset.seconds) > 0.5, null, { timeout: 60000 });

    // Page load: nothing is downloaded, and both players say what the first
    // playback will fetch before anything is pressed.
    await page.goto(base); await settled();
    const payload = await encodeListenLink({ schema: 'mml-studio/listen-link@1', title: 'Default bank fixture', mml: 'MML@t120o4l4cdefgabc,t120o3l1cc,,,,t120o3l4cccccccc;' }, codec);
    await page.evaluate(value => { location.hash = `listen=${value}`; }, payload);
    await page.locator('#listen-head h3', { hasText: 'Default bank fixture' }).waitFor();
    await page.locator('#listen-bank').filter({ hasText: DEFAULT_BANK_DOWNLOAD_NOTICE }).waitFor();
    assert.equal(DEFAULT_BANK_DOWNLOAD_NOTICE, '第一次使用免費音色：將從 MuseScore 官方來源下載約 14.6 MB，只存在這台裝置');
    assert.ok((await page.locator('#listen-bank').textContent()).includes(LABEL));
    assert.ok((await page.locator('#bank-status').textContent()).includes(LABEL), 'section 06 labels the default bank the same way');
    assert.ok((await page.locator('#default-bank-note').textContent()).includes(DEFAULT_BANK_DOWNLOAD_NOTICE));
    assert.deepEqual(await page.locator('[data-listen-instrument="0"] option').allTextContents(), NAMES, 'the eleven game instrument names, per role');
    assert.equal(await page.locator('[data-listen-instrument="0"]').inputValue(), 'lute');
    await page.locator('[data-listen-instrument="5"]').selectOption('bass-drum');
    assert.equal(await page.locator('[data-preview-instrument="5"]').inputValue(), 'bass-drum', 'both players share the instrument choice');
    assert.equal(upstreamRequests.length, 0, 'nothing is downloaded on page load');
    assert.equal(await cachedSubset(), null);

    // First play: the notice and the download's progress, then the verified
    // subset plays, labelled, and is kept in this browser.
    const reached = hold();
    await page.locator('#listen-play').click();
    await page.locator('#listen-bank [data-default-bank-note]').filter({ hasText: '下載中' }).waitFor();
    await reached;
    assert.ok((await page.locator('#listen-bank').textContent()).includes(DEFAULT_BANK_DOWNLOAD_NOTICE), 'the notice stays visible while downloading');
    assert.equal(upstreamRequests.length, 1);
    mode = 'serve'; release();
    await played();
    await page.locator('#listen-bank').filter({ hasText: '已存在這台裝置' }).waitFor();
    assert.ok((await page.locator('#listen-bank').textContent()).includes(LABEL), 'the playing default bank is labelled');
    assert.equal(await cachedSubset(), fixture.subsetSha256, 'the verified subset is cached under its own digest');
    await page.locator('#listen-stop').click();
    assert.equal(upstreamRequests.length, 1);

    // Another session on this device: played from the cache, no request.
    await page.reload(); await settled();
    await page.locator('#open-listening').click();
    await page.locator('#listen-head h3', { hasText: 'Default bank fixture' }).waitFor();
    await page.locator('#listen-bank').filter({ hasText: '已存在這台裝置' }).waitFor();
    await page.locator('#listen-play').click();
    await played();
    await page.locator('#listen-stop').click();
    assert.equal(upstreamRequests.length, 1, 'a cached subset is never downloaded again');

    // Deleting it from this device; an altered download is then refused, and
    // an unreachable source says so. Both point to the user's own bank.
    await page.locator('#listen-default-bank-clear').click();
    await page.locator('#listen-bank').filter({ hasText: DEFAULT_BANK_DOWNLOAD_NOTICE }).waitFor();
    assert.equal(await cachedSubset(), null, 'the cached subset is deleted');
    mode = 'altered';
    await page.locator('#listen-play').click();
    await page.locator('#listen-status').filter({ hasText: '無法播放：下載的音色庫與固定的上游 SHA-256 不符，已拒絕使用。可改為選擇自己的音色庫' }).waitFor();
    assert.equal(await cachedSubset(), null, 'an altered download is never kept');
    assert.equal(await page.locator('#listen-position').getAttribute('data-state'), 'stopped');
    mode = 'offline';
    await page.locator('#listen-play').click();
    await page.locator('#listen-status').filter({ hasText: '無法播放：無法下載免費音色（可能離線或被阻擋' }).waitFor();
    assert.ok((await page.locator('#listen-status').textContent()).includes('可改為選擇自己的音色庫'));
    assert.equal(upstreamRequests.length, 3);

    // A truncated bank of the user's own: its RIFF header is intact, so only
    // parsing it shows it is damaged. It is refused with a visible message
    // before anything is kept, and the default bank stays in place.
    mode = 'serve';
    const sample = Buffer.from(core.BasicSoundBank.getSampleSoundBankFile());
    const truncated = sample.subarray(0, sample.length >> 1);
    assert.equal(truncated.toString('latin1', 0, 4) + truncated.toString('latin1', 8, 12), 'RIFFsfbk');
    const storedUserBank = () => page.evaluate(async () => (await (await import('./studio/web/preview/soundbank-store.mjs')).loadBank())?.name ?? null);
    await page.locator('#listen-bank-file').setInputFiles({ name: 'truncated.sf2', mimeType: 'application/octet-stream', buffer: truncated });
    await page.locator('#message').filter({ hasText: '音色庫無法解析，沒有儲存' }).waitFor();
    assert.equal(await storedUserBank(), null, 'the truncated bank is not kept');
    assert.ok((await page.locator('#listen-bank').textContent()).includes(LABEL), 'the default bank stays in place');

    // One kept before banks were parsed (only the header was checked then)
    // stops loading with a visible message instead of leaving the engine
    // loading forever, after a reload too, and every later play tries again.
    await page.evaluate(async bytes => {
      const db = await new Promise((resolve, reject) => { const request = indexedDB.open('mml-studio-soundbank', 1); request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error); });
      const buffer = new Uint8Array(bytes).buffer;
      const sha256 = [...new Uint8Array(await crypto.subtle.digest('SHA-256', buffer))].map(b => b.toString(16).padStart(2, '0')).join('');
      await new Promise((resolve, reject) => {
        const tx = db.transaction('banks', 'readwrite');
        tx.objectStore('banks').put({ name: 'truncated.sf2', size: buffer.byteLength, sha256, format: 'sfbk', savedAt: new Date().toISOString(), bytes: buffer }, 'current');
        tx.oncomplete = resolve; tx.onerror = () => reject(tx.error);
      });
      db.close();
    }, [...truncated]);
    await page.reload(); await settled();
    await page.locator('#open-listening').click();
    await page.locator('#listen-head h3', { hasText: 'Default bank fixture' }).waitFor();
    await page.locator('#listen-bank').filter({ hasText: 'truncated.sf2' }).waitFor();
    // Each play loads the bank again: one handed an earlier play's failed
    // load back would show the same message but send the engine nothing.
    const bankSends = await countBankSends(page);
    for (const attempt of ['first play', 'retry']) {
      const sent = await bankSends();
      await page.evaluate(() => { document.querySelector('#listen-status').textContent = ''; });
      await page.locator('#listen-play').click();
      // Well inside the engine's load timeout: the worklet's parse error ends the load.
      await page.locator('#listen-status').filter({ hasText: '無法播放：音色庫無法解析，已停止載入' }).waitFor({ timeout: 20000 });
      assert.equal(await bankSends(), sent + 1, `${attempt}: this play sent the bank to the engine itself`);
      assert.equal(await page.locator('#listen-position').getAttribute('data-state'), 'stopped', `${attempt}: the player is not left playing`);
    }
    assert.equal(upstreamRequests.length, 3, 'a damaged bank of the user\'s own never falls back to a download');

    // A bank of the user's own takes precedence and needs no download.
    await page.locator('#listen-bank-file').setInputFiles({ name: 'saw.sf2', mimeType: 'application/octet-stream', buffer: Buffer.from(core.BasicSoundBank.getSampleSoundBankFile()) });
    await page.locator('#listen-bank').filter({ hasText: 'saw.sf2' }).waitFor();
    assert.equal((await page.locator('#listen-bank').textContent()).includes(LABEL), false);
    await page.locator('#listen-play').click();
    await played();

    // A pick that is refused leaves the playing engine alone: the store still
    // keeps saw.sf2, so the refused pick's reconcile finds the bank the page
    // names and the engine plays, the playback goes on, and the next play
    // needs no second load. Overlapping picks, removals and the other
    // interleavings of bank choices are checked in bank-choices.mjs.
    const loadsBefore = await bankSends();
    await page.evaluate(() => { document.querySelector('#message').textContent = ''; });
    await page.locator('#listen-bank-file').setInputFiles({ name: 'truncated.sf2', mimeType: 'application/octet-stream', buffer: truncated });
    await page.locator('#message').filter({ hasText: '音色庫無法解析，沒有儲存' }).waitFor();
    assert.equal(await page.locator('#listen-position').getAttribute('data-state'), 'playing', 'a refused pick does not stop the playback');
    assert.equal(await storedUserBank(), 'saw.sf2', 'the refused pick leaves the kept bank');
    // Stopped in the page, not by a click that would wait on a button the
    // playback's own end may have just disabled.
    await page.evaluate(() => document.querySelector('#listen-stop:enabled')?.click());
    await page.locator('#listen-position[data-state="stopped"]').waitFor();
    // Back at the start: the position moves again only once an engine plays.
    assert.equal(await page.locator('#listen-position').getAttribute('data-seconds'), '0');
    await page.locator('#listen-play').click();
    await played();
    assert.equal(await bankSends(), loadsBefore, 'the engine loaded before the refused pick plays on without a second load');
    await page.locator('#listen-stop').click();
    assert.equal(upstreamRequests.length, 3, 'the user bank plays without contacting the upstream');
    assert.ok((await page.locator('[data-listen-instrument="0"] option').allTextContents()).every(text => /^\d{3} /.test(text)), 'the picker lists the user bank\'s presets');
    assert.deepEqual(errors, []);
    return { upstream: fixture.real ? 'pinned upstream file' : 'synthetic stand-in with swapped pins' };
  } finally {
    await context.close();
  }
}
