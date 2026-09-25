import assert from 'node:assert/strict';
import zlib from 'node:zlib';
import { createHash } from 'node:crypto';
import { encodeListenLink } from '../web/listen-link.mjs';
import { GAME_STYLE_BANK, GAME_STYLE_DEF, GAME_STYLE_DOWNLOAD_NOTICE } from '../web/preview/game-style-bank.mjs';
import { syntheticUpstreamBank } from '../tests/support/synthetic-soundbank.mjs';

// The game-style bank through the real page and engine, in a browser context
// of its own. The bank is never in this repository and the test servers have
// no /banks route, so a small synthetic bank stands in for it: the test swaps
// the pinned digest and size for the stand-in's in the module response and
// answers the bank's path itself (served, altered by one byte, or absent, as
// a server without the bank answers). Service Workers are blocked so every
// module comes from the server, where the swap happens.
const codec = { deflateRaw: bytes => new Uint8Array(zlib.deflateRawSync(bytes)), inflateRaw: (bytes, max) => new Uint8Array(zlib.inflateRawSync(bytes, { maxOutputLength: max })) };
const LABEL = '遊戲風格音色（模擬），不是實機';
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');

export async function runGameStyleBankChecks({ browser, base, profile }) {
  const body = Buffer.from(syntheticUpstreamBank());
  const stand = sha256(body);
  // The page's notice names the size it pins: here, the stand-in's.
  const notice = GAME_STYLE_DOWNLOAD_NOTICE.replace(/約 [\d.]+ MB/, `約 ${(body.length / 1e6).toFixed(1)} MB`);
  const context = await browser.newContext({ viewport: profile.viewport, isMobile: profile.isMobile, hasTouch: profile.hasTouch, serviceWorkers: 'block' });
  const errors = [], bankRequests = [];
  try {
    await context.route('**/studio/web/preview/game-style-bank.mjs', async route => {
      const response = await route.fetch();
      let text = await response.text();
      const pinnedBytes = `bytes: ${GAME_STYLE_BANK.bytes},`;
      assert.ok(text.includes(GAME_STYLE_BANK.sha256) && text.includes(pinnedBytes), 'the module carries the pinned digest and size');
      text = text.replaceAll(GAME_STYLE_BANK.sha256, stand).replace(pinnedBytes, `bytes: ${body.length},`);
      await route.fulfill({ response, body: text });
    });
    // The free default bank is never needed here; its download is refused.
    await context.route('https://raw.githubusercontent.com/**', route => route.abort('blockedbyclient'));
    let mode = 'serve';
    await context.route(`**/banks/game-style/${stand}.dls`, async route => {
      bankRequests.push(route.request().url());
      if (mode === 'absent') return route.fulfill({ status: 404, body: 'Not found' });
      const bytes = Buffer.from(body);
      if (mode === 'altered') bytes[bytes.length - 1] ^= 1;
      await route.fulfill({ status: 200, headers: { 'content-type': 'application/octet-stream', 'content-length': String(bytes.length) }, body: bytes });
    });
    const page = await context.newPage();
    page.on('pageerror', error => errors.push(error.message));
    const settled = () => page.waitForFunction(() => document.querySelector('#app')?.getAttribute('aria-busy') === 'false' && document.querySelector('#app h1'));
    const kept = () => page.evaluate(async sha => {
      const record = await (await import('./studio/web/preview/soundbank-store.mjs')).loadPresetBank(sha);
      if (!record) return null;
      return [...new Uint8Array(await crypto.subtle.digest('SHA-256', record.bytes))].map(b => b.toString(16).padStart(2, '0')).join('');
    }, stand);
    const played = () => page.waitForFunction(() => Number(document.querySelector('#listen-position')?.dataset.seconds) > 0.5, null, { timeout: 60000 });

    await page.goto(base); await settled();
    const payload = await encodeListenLink({ schema: 'mml-studio/listen-link@1', title: 'Game-style fixture', mml: 'MML@t120o4l4cdefgabc,t120o3l1cc,,,,t120o3l4cccccccc;' }, codec);
    await page.evaluate(value => { location.hash = `listen=${value}`; }, payload);
    await page.locator('#listen-head h3', { hasText: 'Game-style fixture' }).waitFor();
    assert.equal(await page.locator('#listen-preset-bank').inputValue(), 'free', 'the free default bank is the first choice');
    assert.deepEqual(await page.locator('#listen-preset-bank option').allTextContents(), ['免費通用音色（近似）', '遊戲風格音色']);

    // Choosing it: both players name it and what the first playback fetches;
    // nothing is downloaded yet, and the instruments are the same eleven.
    await page.locator('#listen-preset-bank').selectOption('game-style');
    await page.locator('#listen-bank').filter({ hasText: notice }).waitFor();
    assert.equal(GAME_STYLE_DOWNLOAD_NOTICE, '第一次使用遊戲風格音色：將從本網站下載約 15.3 MB，只存在這台裝置');
    assert.ok((await page.locator('#listen-bank').textContent()).includes(LABEL));
    assert.ok((await page.locator('#bank-status').textContent()).includes(LABEL), 'section 06 names the chosen bank too');
    assert.equal(await page.locator('#preset-bank').inputValue(), 'game-style', 'both players share the choice');
    assert.equal(await page.locator('[data-listen-instrument="0"] option').count(), 11);
    assert.ok(!(await page.locator('body').textContent()).includes('Fury'), 'the bank is never named by its file');
    assert.equal(bankRequests.length, 0, 'nothing is downloaded on choosing');

    // First play: downloaded from this site, verified, played and kept.
    await page.locator('#listen-play').click();
    await played();
    await page.locator('#listen-bank').filter({ hasText: '遊戲風格音色已存在這台裝置' }).waitFor();
    assert.equal(await kept(), stand, 'the verified bank is kept under its own digest');
    assert.equal(bankRequests.length, 1);
    assert.ok(new URL(bankRequests[0]).pathname.endsWith(`/banks/game-style/${stand}.dls`) && new URL(bankRequests[0]).origin === new URL(base).origin, 'fetched from this site');
    await page.locator('#listen-stop').click();

    // The choice and the bank stay on this device: no second download.
    await page.reload(); await settled();
    await page.locator('#open-listening').click();
    await page.locator('#listen-head h3', { hasText: 'Game-style fixture' }).waitFor();
    assert.equal(await page.locator('#listen-preset-bank').inputValue(), 'game-style', 'the choice is remembered');
    await page.locator('#listen-play').click();
    await played();
    await page.locator('#listen-stop').click();
    assert.equal(bankRequests.length, 1, 'a kept bank is never downloaded again');

    // Deleted from this device; an altered download is refused and never
    // kept, and a server without the bank says so.
    await page.locator('#listen-game-style-bank-clear').click();
    await page.locator('#listen-bank').filter({ hasText: notice }).waitFor();
    assert.equal(await kept(), null);
    mode = 'altered';
    await page.locator('#listen-play').click();
    await page.locator('#listen-status').filter({ hasText: '下載的遊戲風格音色與固定的 SHA-256 不符，已拒絕使用' }).waitFor();
    assert.equal(await kept(), null, 'an altered download is never kept');
    mode = 'absent';
    await page.locator('#listen-play').click();
    await page.locator('#listen-status').filter({ hasText: '這個網站沒有提供遊戲風格音色' }).waitFor();
    assert.equal(await page.locator('#listen-position').getAttribute('data-state'), 'stopped');
    assert.deepEqual(errors, []);
    return { bank: 'synthetic stand-in with swapped pin' };
  } finally {
    await context.close();
  }
}

// The Workshop's 「使用遊戲風格音色」: the bank and its instrument list come
// from this site, verified; the list names and filters the bank's presets in
// the page language; the choice and both files stay on this device, so the
// next visit loads them without a download. The stand-ins' pins are swapped
// in the module response as above. The instrument list stand-in names two
// of the synthetic bank's programs (1-based, as a .def does).
const FIXTURE_DEF = Buffer.from('\uFEFF[Instrument presets]\r\nLute = 25, 0, 0\r\nHarp = 47, 0, 0\r\n\r\n[1028]\r\nLute = 魯特琴\r\nHarp = 豎琴\r\n', 'utf8');

export async function runWorkshopGameStyleChecks({ browser, base, profile }) {
  const bank = Buffer.from(syntheticUpstreamBank());
  const swaps = [[GAME_STYLE_BANK, bank], [GAME_STYLE_DEF, FIXTURE_DEF]].map(([pin, body]) => ({ pin, body, sha: sha256(body) }));
  const context = await browser.newContext({ viewport: profile.viewport, isMobile: profile.isMobile, hasTouch: profile.hasTouch, serviceWorkers: 'block', locale: 'zh-TW' });
  const errors = [], requests = [];
  let mode = 'serve';
  try {
    await context.route('**/studio/web/preview/game-style-bank.mjs', async route => {
      const response = await route.fetch();
      let text = await response.text();
      for (const { pin, body, sha } of swaps) {
        const pinnedBytes = `bytes: ${pin.bytes},`;
        assert.ok(text.includes(pin.sha256) && text.includes(pinnedBytes));
        text = text.replaceAll(pin.sha256, sha).replace(pinnedBytes, `bytes: ${body.length},`);
      }
      await route.fulfill({ response, body: text });
    });
    for (const { body, sha, pin } of swaps) {
      await context.route(`**/banks/game-style/${sha}${pin.path.slice(pin.path.lastIndexOf('.'))}`, async route => {
        requests.push(route.request().url());
        if (mode === 'absent') return route.fulfill({ status: 404, body: 'Not found' });
        await route.fulfill({ status: 200, headers: { 'content-type': 'application/octet-stream', 'content-length': String(body.length) }, body });
      });
    }
    const page = await context.newPage();
    page.on('pageerror', error => errors.push(error.message));
    const url = new URL('studio/web/workshop/index.html', base).href;
    const label = () => page.locator('#dlsName').textContent();
    const loaded = () => page.waitForFunction(() => /^遊戲風格音色 · [\d.]+ MB · 2 個音色/.test(document.querySelector('#dlsName')?.textContent ?? ''), null, { timeout: 60000 });
    const bankOptions = () => page.locator('.trk-inst').first().locator('optgroup').last().locator('option').allTextContents();

    // A server without the bank says so and loads nothing.
    mode = 'absent';
    await page.goto(url); await page.locator('#unverified').waitFor();
    // The page's handlers are bound once it has translated itself (main.mjs);
    // the engine boots on the bank load itself, as on a phone it may only
    // after a gesture.
    await page.waitForFunction(() => !document.documentElement.hasAttribute('data-i18n-pending'));
    await page.evaluate(() => document.querySelector('#gameStyleBank').click());
    await page.locator('#log').filter({ hasText: '這個網站沒有提供遊戲風格音色' }).waitFor();
    assert.equal(await label(), '載入失敗');

    // Served: loaded, named without its file name, the presets filtered and
    // named by the instrument list in the page language.
    mode = 'serve';
    await page.evaluate(() => document.querySelector('#gameStyleBank').click());
    await loaded();
    assert.deepEqual((await bankOptions()).map(text => text.replace(/\s+/g, ' ')), ['025 魯特琴', '047 豎琴']);
    assert.ok(!(await page.locator('body').textContent()).includes('Fury'));
    assert.equal(requests.length, 4, 'the refused try and this one each asked for both files');

    // The next visit: loaded from this device, nothing downloaded.
    await page.reload(); await page.locator('#unverified').waitFor();
    await loaded();
    assert.equal(requests.length, 4, 'a kept bank is never downloaded again');
    assert.deepEqual(errors, []);
    return { workshop: 'synthetic stand-ins with swapped pins' };
  } finally {
    await context.close();
  }
}
