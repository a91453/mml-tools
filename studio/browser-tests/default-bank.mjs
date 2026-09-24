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

    // A pick that is refused leaves the playing engine alone: the bank is
    // checked and kept before the engine is reset, so the playback goes on,
    // the kept bank stays, and the next play needs no second load.
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

    // Picks that overlap: the last one wins. Each pick's bank is checked off
    // the main thread, and a big bank takes longer, so here the check of the
    // first pick is held in the page (its Worker's answer, not its loaded
    // message, waits for release) until the pick after it has been checked,
    // kept and shown, and has played. Once released, the first pick is
    // neither kept nor shown, whether its bank parsed or not, and does not
    // reset the engine that plays the later pick. Removing the bank is a
    // later choice too.
    await page.evaluate(() => {
      const RealWorker = window.Worker;
      const onmessage = Object.getOwnPropertyDescriptor(RealWorker.prototype, 'onmessage');
      window.holdNextCheck = () => {
        let release;
        window.heldCheck = { armed: true, held: 0, answered: 0, released: new Promise(resolve => { release = resolve; }), release: () => release() };
      };
      window.Worker = function (url, options) {
        const worker = new RealWorker(url, options);
        const hold = window.heldCheck;
        if (!hold?.armed || !String(url).endsWith('/preview/bank-check-worker.mjs')) return worker;
        hold.armed = false;
        Object.defineProperty(worker, 'onmessage', {
          configurable: true,
          get() { return onmessage.get.call(this); },
          set(handler) {
            onmessage.set.call(this, typeof handler !== 'function' ? handler : function (event) {
              if (event.data?.loaded) return handler.call(this, event);
              hold.held += 1;
              hold.released.then(() => { hold.answered += 1; handler.call(this, event); });
              return undefined;
            });
          },
        });
        return worker;
      };
      window.restoreWorker = () => { window.Worker = RealWorker; };
    });
    const clearMessage = () => page.evaluate(() => { document.querySelector('#message').textContent = ''; });
    // After the held answer is let through, nothing the older pick would do
    // may happen: checked every 100 ms for 2 s (storing and showing a bank
    // this small takes well under that).
    const staysOn = async (older, kept, line) => {
      await page.evaluate(() => window.heldCheck.release());
      await page.waitForFunction(() => window.heldCheck.answered === 1);
      for (let i = 0; i < 20; i += 1) {
        const seen = await page.evaluate(() => ({ message: document.querySelector('#message')?.textContent ?? '', line: document.querySelector('#listen-bank')?.textContent ?? '' }));
        assert.ok(!seen.message.includes(older) && !seen.message.includes('沒有儲存'), `the older pick ${older} shows nothing: ${seen.message}`);
        assert.ok(line(seen.line) && !seen.line.includes(older), `the bank line stays on the later choice: ${seen.line}`);
        await page.waitForTimeout(100);
      }
      assert.equal(await storedUserBank(), kept, `the older pick ${older} is not kept`);
    };
    const pickHeld = async (name, bytes) => {
      await page.evaluate(() => window.holdNextCheck());
      await page.locator('#listen-bank-file').setInputFiles({ name, mimeType: 'application/octet-stream', buffer: bytes });
      await page.waitForFunction(() => window.heldCheck.held === 1);
    };

    // A bank that parses, overtaken by a later pick.
    await clearMessage();
    await pickHeld('first.sf2', sample);
    await page.locator('#listen-bank-file').setInputFiles({ name: 'second.sf2', mimeType: 'application/octet-stream', buffer: sample });
    await page.locator('#listen-bank').filter({ hasText: 'second.sf2' }).waitFor();
    assert.equal(await storedUserBank(), 'second.sf2');
    await page.locator('#listen-play').click();
    await played();
    await page.evaluate(() => document.querySelector('#listen-stop:enabled')?.click());
    await page.locator('#listen-position[data-state="stopped"]').waitFor();
    const loadsWithSecond = await bankSends();
    await clearMessage();
    await staysOn('first.sf2', 'second.sf2', line => line.includes('second.sf2'));
    await page.locator('#listen-play').click();
    await played();
    await page.evaluate(() => document.querySelector('#listen-stop:enabled')?.click());
    await page.locator('#listen-position[data-state="stopped"]').waitFor();
    assert.equal(await bankSends(), loadsWithSecond, 'the older pick did not reset the engine: the later pick plays on without a new load');

    // A damaged bank, overtaken by a later pick: its refusal is not shown.
    await pickHeld('damaged.sf2', truncated);
    await page.locator('#listen-bank-file').setInputFiles({ name: 'saw.sf2', mimeType: 'application/octet-stream', buffer: sample });
    await page.locator('#listen-bank').filter({ hasText: 'saw.sf2' }).waitFor();
    await clearMessage();
    await staysOn('damaged.sf2', 'saw.sf2', line => line.includes('saw.sf2'));

    // A pick overtaken by removing the bank (section 06's button): nothing
    // is kept, and the default bank stays in place.
    await pickHeld('late.sf2', sample);
    await page.evaluate(() => document.querySelector('#bank-clear').click());
    await page.locator('#listen-bank').filter({ hasText: LABEL }).waitFor();
    assert.equal(await storedUserBank(), null);
    await clearMessage();
    await staysOn('late.sf2', null, line => line.includes(LABEL));
    await page.evaluate(() => window.restoreWorker());

    // A newer choice made while an older pick's store write is already under
    // way: the write cannot be stopped, but the page names only the bank the
    // store keeps. The older pick's write is held in the page from the
    // moment it has been sent: the write itself runs, and only the page's
    // handler for its transaction's completion waits for release, so the
    // older pick's result arrives after the newer choice has settled.
    await page.evaluate(() => {
      const put = IDBObjectStore.prototype.put, del = IDBObjectStore.prototype.delete;
      const complete = Object.getOwnPropertyDescriptor(IDBTransaction.prototype, 'oncomplete');
      window.holdNextWrite = name => {
        let release;
        window.heldWrite = { name, sent: 0, answered: 0, released: new Promise(resolve => { release = resolve; }), release: () => release() };
      };
      IDBObjectStore.prototype.put = function (value, key, ...rest) {
        const request = put.call(this, value, key, ...rest);
        const hold = window.heldWrite;
        if (hold && !hold.sent && key === 'current' && value?.name === hold.name) {
          hold.sent += 1;
          Object.defineProperty(this.transaction, 'oncomplete', {
            configurable: true,
            get() { return complete.get.call(this); },
            set(handler) {
              complete.set.call(this, typeof handler !== 'function' ? handler : function (event) {
                hold.released.then(() => { hold.answered += 1; handler.call(this, event); });
              });
            },
          });
        }
        return request;
      };
      // The next delete of the kept bank is refused, as by a failing store.
      window.refuseNextDelete = () => {
        IDBObjectStore.prototype.delete = function () {
          IDBObjectStore.prototype.delete = del;
          throw new DOMException('bank delete refused (browser check)', 'UnknownError');
        };
      };
      window.restoreStore = () => { IDBObjectStore.prototype.put = put; IDBObjectStore.prototype.delete = del; };
    });
    const lineNow = () => page.evaluate(() => document.querySelector('#listen-bank')?.textContent ?? '');
    const pickWriteHeld = async name => {
      await page.evaluate(name => window.holdNextWrite(name), name);
      await page.locator('#listen-bank-file').setInputFiles({ name, mimeType: 'application/octet-stream', buffer: sample });
      await page.waitForFunction(() => window.heldWrite.sent === 1);
    };
    // Once the held write is let through, for 2 s: the message and the bank
    // line keep what the newer choice left, and so does the store.
    const settlesOn = async (older, kept, shown) => {
      await page.evaluate(() => window.heldWrite.release());
      await page.waitForFunction(() => window.heldWrite.answered === 1);
      for (let i = 0; i < 20; i += 1) {
        const seen = await page.evaluate(() => ({ message: document.querySelector('#message')?.textContent ?? '', line: document.querySelector('#listen-bank')?.textContent ?? '' }));
        assert.ok(!seen.message.includes(`已載入音色庫 ${older}`), `the overtaken pick ${older} shows nothing: ${seen.message}`);
        assert.ok(shown(seen), `the page stays on what the store keeps: ${JSON.stringify(seen)}`);
        await page.waitForTimeout(100);
      }
      assert.equal(await storedUserBank(), kept, `the store keeps ${kept ?? 'no bank'}`);
    };
    const playOnce = async () => {
      await page.locator('#listen-play').click();
      await played();
      await page.evaluate(() => document.querySelector('#listen-stop:enabled')?.click());
      await page.locator('#listen-position[data-state="stopped"]').waitFor();
    };
    await page.locator('#listen-bank-file').setInputFiles({ name: 'saw.sf2', mimeType: 'application/octet-stream', buffer: sample });
    await page.locator('#listen-bank').filter({ hasText: 'saw.sf2' }).waitFor();
    await playOnce();

    // A damaged bank is picked while first.sf2's write is under way. It is
    // refused and changes nothing, so the store keeps first.sf2, written
    // before the damaged pick was made, and the page names first.sf2, not
    // saw.sf2, which it showed before and the store no longer keeps. The
    // engine, loaded with saw.sf2, is let go: the next play loads first.sf2.
    await clearMessage();
    await pickWriteHeld('first.sf2');
    await page.locator('#listen-bank-file').setInputFiles({ name: 'damaged.sf2', mimeType: 'application/octet-stream', buffer: truncated });
    await page.locator('#message').filter({ hasText: '音色庫無法解析，沒有儲存' }).waitFor();
    await page.locator('#listen-bank').filter({ hasText: 'first.sf2' }).waitFor({ timeout: 10000 }).catch(async () => {
      assert.fail(`after the refusal the page names the bank the store keeps (${await storedUserBank()}): ${await lineNow()}`);
    });
    assert.equal(await storedUserBank(), 'first.sf2');
    await settlesOn('first.sf2', 'first.sf2', seen => seen.line.includes('first.sf2') && seen.message.includes('音色庫無法解析，沒有儲存'));
    const sendsBeforeKept = await bankSends();
    await playOnce();
    assert.equal(await bankSends(), sendsBeforeKept + 1, 'the next play loads the bank the store keeps, not the engine\'s saw.sf2');

    // A removal that fails leaves the bank in the store, and the page goes
    // on naming it instead of the default bank.
    await clearMessage();
    await page.evaluate(() => window.refuseNextDelete());
    await page.evaluate(() => document.querySelector('#bank-clear').click());
    await page.locator('#message').filter({ hasText: 'bank delete refused (browser check)' }).waitFor();
    for (let i = 0; i < 10; i += 1) {
      const line = await lineNow();
      assert.ok(line.includes('first.sf2') && !line.includes(LABEL), `a failed removal leaves the kept bank named: ${line}`);
      await page.waitForTimeout(100);
    }
    assert.equal(await storedUserBank(), 'first.sf2', 'the failed removal left the bank in the store');

    // The bank is removed while overtaken.sf2's write is under way. The
    // delete runs after that write, so the store ends empty; the removal
    // says so, and overtaken.sf2 is never named.
    await clearMessage();
    await pickWriteHeld('overtaken.sf2');
    await page.evaluate(() => document.querySelector('#bank-clear').click());
    await page.locator('#listen-bank').filter({ hasText: LABEL }).waitFor();
    await page.locator('#message').filter({ hasText: '已移除你的音色庫；試聽改用預設音色。' }).waitFor();
    assert.equal(await storedUserBank(), null, 'the delete ran after the write already under way');
    assert.equal(await page.evaluate(() => window.heldWrite.answered), 0, 'overtaken.sf2\'s result is still held');
    await settlesOn('overtaken.sf2', null, seen => seen.line.includes(LABEL) && !seen.line.includes('overtaken.sf2') && seen.message.includes('已移除你的音色庫'));
    await page.evaluate(() => window.restoreStore());
    assert.equal(upstreamRequests.length, 3, 'nothing here asked for the default bank');
    assert.deepEqual(errors, []);
    return { upstream: fixture.real ? 'pinned upstream file' : 'synthetic stand-in with swapped pins' };
  } finally {
    await context.close();
  }
}
