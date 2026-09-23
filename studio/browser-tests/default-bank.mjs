import assert from 'node:assert/strict';
import zlib from 'node:zlib';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import * as core from 'spessasynth_core';
import { encodeListenLink } from '../web/listen-link.mjs';
import { DEFAULT_BANK_DOWNLOAD_NOTICE, DEFAULT_BANK_SUBSET, DEFAULT_BANK_UPSTREAM } from '../web/preview/default-bank.mjs';
import { trimDefaultBank } from '../web/preview/default-bank-trim.mjs';
import { syntheticUpstreamBank } from '../tests/support/synthetic-soundbank.mjs';

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

async function upstreamFixture() {
  const source = process.env.STUDIO_DEFAULT_BANK_SOURCE;
  if (source) {
    const body = await readFile(source);
    assert.equal(sha256(body), DEFAULT_BANK_UPSTREAM.sha256, 'STUDIO_DEFAULT_BANK_SOURCE is the pinned upstream file');
    return { body, subsetSha256: DEFAULT_BANK_SUBSET.sha256, swap: null, real: true };
  }
  const body = Buffer.from(syntheticUpstreamBank());
  const subsetSha256 = sha256(trimDefaultBank(body, core).bytes);
  return { body, subsetSha256, swap: [[DEFAULT_BANK_UPSTREAM.sha256, sha256(body)], [DEFAULT_BANK_SUBSET.sha256, subsetSha256]], real: false };
}

export async function runDefaultBankChecks({ browser, base, profile }) {
  const fixture = await upstreamFixture();
  const context = await browser.newContext({ viewport: profile.viewport, isMobile: profile.isMobile, hasTouch: profile.hasTouch, serviceWorkers: 'block' });
  const errors = [], upstreamRequests = [];
  try {
    if (fixture.swap) {
      await context.route('**/studio/web/preview/default-bank.mjs', async route => {
        const response = await route.fetch();
        let text = await response.text();
        for (const [pinned, stand] of fixture.swap) { assert.ok(text.includes(pinned), 'the module carries the pinned digest'); text = text.replaceAll(pinned, stand); }
        await route.fulfill({ response, body: text });
      });
    }
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

    // A bank of the user's own takes precedence and needs no download.
    mode = 'serve';
    await page.locator('#listen-bank-file').setInputFiles({ name: 'saw.sf2', mimeType: 'application/octet-stream', buffer: Buffer.from(core.BasicSoundBank.getSampleSoundBankFile()) });
    await page.locator('#listen-bank').filter({ hasText: 'saw.sf2' }).waitFor();
    assert.equal((await page.locator('#listen-bank').textContent()).includes(LABEL), false);
    await page.locator('#listen-play').click();
    await played();
    await page.locator('#listen-stop').click();
    assert.equal(upstreamRequests.length, 3, 'the user bank plays without contacting the upstream');
    assert.ok((await page.locator('[data-listen-instrument="0"] option').allTextContents()).every(text => /^\d{3} /.test(text)), 'the picker lists the user bank\'s presets');
    assert.deepEqual(errors, []);
    return { upstream: fixture.real ? 'pinned upstream file' : 'synthetic stand-in with swapped pins' };
  } finally {
    await context.close();
  }
}
