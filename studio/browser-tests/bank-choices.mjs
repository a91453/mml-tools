import assert from 'node:assert/strict';
import zlib from 'node:zlib';
import * as core from 'spessasynth_core';
import { encodeListenLink } from '../web/listen-link.mjs';
import { DEFAULT_BANK_LABEL } from '../web/preview/instruments.mjs';
import { DEFAULT_BANK_UPSTREAM } from '../web/preview/default-bank.mjs';
import { swapPinnedDigests, upstreamFixture } from './default-bank.mjs';
import { namedBank, watchBanks } from './bank-invariant.mjs';

// Studio's bank choices through the real page, store, check Worker and
// engine, in a browser context of its own (its storage starts empty; the
// free default bank is served locally, as in default-bank.mjs).
//
// The bank store is the single source of truth (preview/bank-choices.mjs): a
// pick or a removal only decides what it keeps; the latest choice says its
// own outcome and is then reconciled, which names, and lets the engine play,
// exactly the bank the store keeps; plays wait for a pending choice. Each
// scenario below makes one interleaving happen by holding one step in the
// page (bank-invariant.mjs bankHolds), and bankProbe checks, at every note
// the engine plays and once each choice has settled, that the page named the
// bank played and names the bank the store keeps (watchBanks check/settled).
// Every scenario starts from saw.sf2 kept and named, and can run on its own
// (`only`, a list of scenario names; all of them by default).
const codec = { deflateRaw: bytes => new Uint8Array(zlib.deflateRawSync(bytes)), inflateRaw: (bytes, max) => new Uint8Array(zlib.inflateRawSync(bytes, { maxOutputLength: max })) };
const TITLE = 'Bank choices fixture';
const REFUSED = '音色庫無法解析，沒有儲存';
const REMOVED = '已移除你的音色庫；試聽改用預設音色。';
const KEPT = name => `已載入音色庫 ${name}；只保存在這台裝置。`;
const CHOICE_DURING_LOAD = '載入期間又選擇或移除了音色庫，這次的載入已停止；請再按一次播放。';
const BANK_CHANGED = '音色庫已更換，請再按一次播放。';

export const STUDIO_BANK_SCENARIOS = Object.freeze([
  'overlapping picks: the last one wins',
  'a pick overtaken by a removal',
  'a refused pick after an older pick\'s write',
  'a removal while an older pick\'s write is under way',
  'a failed removal',
  'an overtaken refusal during the store re-read',
  'a play while a pick is pending',
  'a play while an older write lands and a newer pick is checked',
  'an engine load overtaken by a choice',
  'the page\'s first read of the store against a pick',
  'damaged banks',
  'a bank another tab keeps',
]);

export async function runStudioBankChoiceChecks({ browser, base, profile, only = null }) {
  const fixture = await upstreamFixture();
  const context = await browser.newContext({ viewport: profile.viewport, isMobile: profile.isMobile, hasTouch: profile.hasTouch, serviceWorkers: 'block' });
  const errors = [], ran = [];
  try {
    await swapPinnedDigests(context, fixture);
    await context.route(DEFAULT_BANK_UPSTREAM.url, route => route.fulfill({ status: 200, headers: { 'content-type': 'application/octet-stream', 'access-control-allow-origin': '*', 'content-length': String(fixture.body.length) }, body: fixture.body }));
    const page = await context.newPage();
    page.on('pageerror', error => errors.push(error.message));
    const idle = () => page.waitForFunction(() => document.querySelector('#app')?.getAttribute('aria-busy') === 'false' && document.querySelector('#app h1'));
    await page.goto(base); await idle();
    const banks = await watchBanks(page, { defaultBank: fixture.subset, defaultLabel: DEFAULT_BANK_LABEL });
    // The listening player, whose bank line (#listen-bank) and section 06's
    // (#bank-status) must name the same bank at every moment (bankProbe).
    const payload = await encodeListenLink({ schema: 'mml-studio/listen-link@1', title: TITLE, mml: 'MML@t120o4l4cdefgabc,t120o3l1cc,,,,t120o3l4cccccccc;' }, codec);
    await page.evaluate(value => { location.hash = `listen=${value}`; }, payload);
    await page.locator('#listen-head h3', { hasText: TITLE }).waitFor();
    const reopen = async () => {
      await page.reload(); await idle();
      await page.locator('#open-listening').click();
      await page.locator('#listen-head h3', { hasText: TITLE }).waitFor();
    };

    const sample = Buffer.from(core.BasicSoundBank.getSampleSoundBankFile());
    const bank = async name => { const bytes = namedBank(sample, name); await banks.add({ [name]: bytes }); return bytes; };
    const sawBank = await bank('saw.sf2');
    const truncated = sawBank.subarray(0, sawBank.length >> 1);
    const pick = async (name, bytes) => page.locator('#listen-bank-file').setInputFiles({ name, mimeType: 'application/octet-stream', buffer: bytes ?? await bank(name) });
    const remove = () => page.evaluate(() => document.querySelector('#bank-clear').click());
    const named = () => page.evaluate(() => window.bankProbe.named());
    const names = async (name, timeout = 30000) => {
      await page.waitForFunction(name => window.bankProbe.named().name === name, name, { timeout }).catch(async () => {
        assert.fail(`the page never named ${name}: ${JSON.stringify(await named())}`);
      });
    };
    const storedName = () => page.evaluate(async () => (await (await import('./studio/web/preview/soundbank-store.mjs')).loadBank())?.name ?? null);
    // Every text #message shows, in order, from the moment it is cleared.
    const watchMessages = () => page.evaluate(() => {
      const box = document.querySelector('#message');
      box.textContent = '';
      window.messages = [];
      window.messageWatch?.disconnect();
      window.messageWatch = new MutationObserver(() => { const text = box.textContent ?? ''; if (text && window.messages.at(-1) !== text) window.messages.push(text); });
      window.messageWatch.observe(box, { childList: true, characterData: true, subtree: true });
    });
    const messages = () => page.evaluate(() => window.messages);
    // Every bank the page names, in order, from now on (the card is drawn
    // anew on each change, so the whole document is watched).
    const watchNamed = () => page.evaluate(() => {
      window.namedHistory = [window.bankProbe.named().name];
      window.namedWatch?.disconnect();
      window.namedWatch = new MutationObserver(() => { const name = window.bankProbe.named().name; if (window.namedHistory.at(-1) !== name) window.namedHistory.push(name); });
      window.namedWatch.observe(document.body, { childList: true, characterData: true, subtree: true });
    });
    const namedHistory = () => page.evaluate(() => window.namedHistory);
    const neverNamed = async (name, where) => {
      const history = await namedHistory();
      assert.ok(!history.includes(name), `${where}: ${name} is never named: ${history.join(' → ')}`);
    };
    const says = text => page.waitForFunction(text => window.messages.some(m => m.includes(text)), text);
    const arm = (what, options = {}) => page.evaluate(([what, options]) => { window.bankHolds.arm(what, options); }, [what, options]);
    const held = what => page.waitForFunction(what => window.bankHolds[what]?.held === 1, what);
    const release = async what => {
      await page.evaluate(what => window.bankHolds[what].release(), what);
      await page.waitForFunction(what => window.bankHolds[what].answered === 1, what);
    };
    // For 2 s after a held step is let through (checking, storing and naming a
    // bank this small takes well under that), what the page says and names.
    const staysFor = async (what, assertion) => {
      for (let i = 0; i < 20; i += 1) {
        const now = await page.evaluate(() => ({ named: window.bankProbe.named(), messages: window.messages }));
        assertion(now, what);
        await page.waitForTimeout(100);
      }
    };
    const played = () => page.waitForFunction(() => Number(document.querySelector('#listen-position')?.dataset.seconds) > 0.5, null, { timeout: 60000 });
    const stop = async () => {
      await page.evaluate(() => document.querySelector('#listen-stop:enabled')?.click());
      await page.locator('#listen-position[data-state="stopped"]').waitFor();
    };
    const playOnce = async () => { await page.locator('#listen-play').click(); await played(); await stop(); };
    const statusSays = text => page.locator('#listen-status').filter({ hasText: text }).waitFor();
    // Until the play asked for last has either played a note or said it could not play.
    const playEnds = (before, timeout = 30000) => page.waitForFunction(before => document.querySelector('#listen-status')?.textContent.includes('無法播放') || window.bankProbe.counts().notes > before, before.notes, { timeout });
    // saw.sf2 kept again, a record of its own: the engine is let go, so the
    // next play builds one. With `engine`, a play then builds it.
    const baseline = async ({ engine = false } = {}) => {
      await watchMessages();
      await pick('saw.sf2', sawBank);
      await says(KEPT('saw.sf2'));
      await names('saw.sf2');
      await banks.settled('saw.sf2 kept', { stored: 'saw.sf2' });
      if (engine) { await playOnce(); await banks.settled('saw.sf2 played', { stored: 'saw.sf2' }); }
      await watchMessages();
      await watchNamed();
    };

    const scenarios = {
      // Round 3: each pick is checked off the main thread, and a big bank
      // takes longer. The older pick's check is held (its answer, or its
      // parser's first load) until a newer pick has been kept, named and
      // played. Once let through, the older pick is not kept and says
      // nothing, whether its bank parsed or not.
      async 'overlapping picks: the last one wins'() {
        for (const [stage, older, newer, bytes] of [['answer', 'first.sf2', 'second.sf2'], ['loaded', 'slow-parser.sf2', 'after-slow.sf2'], ['answer', 'damaged.sf2', 'newer.sf2', truncated]]) {
          await baseline();
          await arm('check', { stage });
          await pick(older, bytes);
          await held('check');
          await pick(newer);
          await says(KEPT(newer));
          await names(newer);
          await playOnce();
          await banks.check(`${older} overtaken by ${newer}`);
          const loaded = await banks.counts();
          await release('check');
          await staysFor(older, ({ named, messages }) => {
            assert.equal(named.name, newer, `${older}: the page stays on ${newer}: ${named.text}`);
            assert.ok(messages.every(m => !m.includes(older) && !m.includes('沒有儲存')), `the overtaken pick ${older} says nothing: ${messages.join(' → ')}`);
          });
          await banks.settled(`${older} overtaken by ${newer}`, { stored: newer });
          await neverNamed(older, `${older} overtaken by ${newer}`);
          await playOnce();
          assert.equal((await banks.counts()).sends, loaded.sends, `${older}: the overtaken pick did not reset the engine: ${newer} plays on without a new load`);
        }
      },
      async 'a pick overtaken by a removal'() {
        await baseline();
        await arm('check');
        await pick('late.sf2');
        await held('check');
        await remove();
        await says(REMOVED);
        await names('(default)');
        await release('check');
        await staysFor('late.sf2', ({ named, messages }) => {
          assert.equal(named.name, '(default)', `the page stays on the default bank: ${named.text}`);
          assert.ok(messages.every(m => !m.includes('late.sf2') && !m.includes('沒有儲存')), `the overtaken pick says nothing: ${messages.join(' → ')}`);
        });
        await banks.settled('a pick overtaken by a removal', { stored: null });
        await neverNamed('late.sf2', 'a pick overtaken by a removal');
      },
      // Round 4: a newer choice cannot stop an older pick's store write that
      // was already sent. first.sf2's write is sent (its completion reaches
      // the page only once let through), then a damaged bank is picked and
      // refused: the store keeps first.sf2, so the page names first.sf2, and
      // the next play loads it. first.sf2's own result, arriving last, says
      // nothing.
      async 'a refused pick after an older pick\'s write'() {
        await baseline({ engine: true });
        await arm('write', { name: 'first.sf2' });
        await pick('first.sf2');
        await held('write');
        await pick('damaged.sf2', truncated);
        await says(REFUSED);
        await names('first.sf2', 10000);
        assert.equal(await storedName(), 'first.sf2');
        await release('write');
        await staysFor('first.sf2', ({ named, messages }) => {
          assert.equal(named.name, 'first.sf2', `the page names the bank the store keeps: ${named.text}`);
          assert.ok(!messages.some(m => m.includes(KEPT('first.sf2'))), `the overtaken pick says nothing: ${messages.join(' → ')}`);
          assert.ok(messages.at(-1).includes(REFUSED), 'the refusal stays the last word');
        });
        await banks.settled('a refused pick after an older write', { stored: 'first.sf2' });
        const before = await banks.counts();
        await playOnce();
        const after = await banks.counts();
        assert.equal(after.sends, before.sends + 1, 'the next play loads first.sf2, not the engine\'s saw.sf2');
        await banks.settled('first.sf2 played', { stored: 'first.sf2' });
      },
      async 'a removal while an older pick\'s write is under way'() {
        await baseline();
        await arm('write', { name: 'overtaken.sf2' });
        await pick('overtaken.sf2');
        await held('write');
        await remove();
        await says(REMOVED);
        await names('(default)');
        assert.equal(await storedName(), null, 'the delete ran after the write already under way');
        assert.equal(await page.evaluate(() => window.bankHolds.write.answered), 0, 'overtaken.sf2\'s result is still held');
        await release('write');
        await staysFor('overtaken.sf2', ({ named, messages }) => {
          assert.equal(named.name, '(default)', `the page stays on the default bank: ${named.text}`);
          assert.ok(!messages.some(m => m.includes('overtaken.sf2')), `overtaken.sf2 says nothing: ${messages.join(' → ')}`);
        });
        await banks.settled('a removal during an older write', { stored: null });
        await neverNamed('overtaken.sf2', 'a removal during an older write');
        await playOnce();
        await banks.settled('the default bank played', { stored: null });
      },
      async 'a failed removal'() {
        await baseline();
        await page.evaluate(() => {
          const del = IDBObjectStore.prototype.delete;
          IDBObjectStore.prototype.delete = function () {
            IDBObjectStore.prototype.delete = del;
            throw new DOMException('bank delete refused (browser check)', 'UnknownError');
          };
        });
        await remove();
        await page.waitForFunction(() => window.messages.length > 0);
        const said = await messages();
        assert.ok(said.some(m => m.includes('bank delete refused (browser check)')) && !said.some(m => m.includes(REMOVED)), `a failed removal says why, and never that the bank was removed: ${said.join(' → ')}`);
        await staysFor('a failed removal', ({ named }) => assert.equal(named.name, 'saw.sf2', `a failed removal leaves the kept bank named: ${named.text}`));
        await banks.settled('a failed removal', { stored: 'saw.sf2' });
      },
      // Round 4 (review): a refused pick re-reads the store before the page
      // names what it keeps; a newer choice made during that read overtakes
      // it. The refusal was said when the pick ended, before the read; after
      // the newer choice has said its own outcome, the refusal is never shown
      // again, and the overtaken re-read names nothing.
      async 'an overtaken refusal during the store re-read'() {
        for (const newer of ['removal', 'pick']) {
          await baseline();
          await arm('read');
          await pick('damaged.sf2', truncated);
          await held('read');
          const newerSays = newer === 'removal' ? REMOVED : KEPT('newer.sf2');
          if (newer === 'removal') await remove(); else await pick('newer.sf2');
          await says(newerSays);
          await names(newer === 'removal' ? '(default)' : 'newer.sf2');
          await release('read');
          await staysFor(newer, ({ named, messages }) => {
            const from = messages.findIndex(m => m.includes(newerSays));
            assert.ok(messages.slice(from).every(m => !m.includes(REFUSED)), `${newer}: the overtaken refusal is never shown after the newer choice: ${messages.join(' → ')}`);
            assert.equal(named.name, newer === 'removal' ? '(default)' : 'newer.sf2', `${newer}: the overtaken re-read names nothing: ${named.text}`);
          });
          assert.ok((await messages()).findIndex(m => m.includes(REFUSED)) < (await messages()).findIndex(m => m.includes(newerSays)), `${newer}: the refusal was said when the pick ended, before the newer choice`);
          await banks.settled(`an overtaken refusal (${newer})`, { stored: newer === 'removal' ? null : 'newer.sf2' });
        }
      },
      // A play asked for while a pick is being checked waits: nothing is
      // played, no bank is sent, until the pick has been kept and named;
      // then the play plays it. With an engine already loaded, and without.
      async 'a play while a pick is pending'() {
        for (const engine of [true, false]) {
          await baseline({ engine });
          await arm('check');
          await pick('pending.sf2');
          await held('check');
          const before = await banks.counts();
          await page.locator('#listen-play').click();
          await page.waitForTimeout(1000);
          await banks.check(`engine ${engine}: a play while a pick is pending`);
          const during = await banks.counts();
          assert.deepEqual([during.notes, during.sends], [before.notes, before.sends], `engine ${engine}: nothing is played and no bank is sent while the pick is pending`);
          await release('check');
          await names('pending.sf2');
          await played();
          await stop();
          const after = await banks.check(`engine ${engine}: the play once the pick was kept`);
          assert.ok(after.notes > during.notes, `engine ${engine}: the waiting play played once the pick was kept`);
          await banks.settled(`engine ${engine}: a play while a pick is pending`, { stored: 'pending.sf2' });
        }
      },
      // Round 4 (review): first.sf2's write lands while the newer
      // second.sf2 is still being checked, so the store keeps first.sf2
      // while the page still names saw.sf2. A play asked for then waits for
      // second.sf2, and plays what the page names then.
      async 'a play while an older write lands and a newer pick is checked'() {
        await baseline();
        await arm('write', { name: 'first.sf2' });
        await pick('first.sf2');
        await held('write');
        await arm('check');
        await pick('second.sf2');
        await held('check');
        await release('write');
        assert.equal(await storedName(), 'first.sf2', 'the older write has landed');
        const before = await banks.counts();
        await page.locator('#listen-play').click();
        await page.waitForTimeout(1000);
        await banks.check('a play while first.sf2 is kept and second.sf2 is checked');
        const during = await banks.counts();
        assert.deepEqual([during.notes, during.sends], [before.notes, before.sends], 'the play waits for second.sf2');
        await release('check');
        await names('second.sf2');
        await played();
        await stop();
        await banks.settled('a play while an older write landed', { stored: 'second.sf2' });
        await neverNamed('first.sf2', 'a play while an older write landed');
      },
      // Round 4 (review): a play is loading the engine, its bank's send held,
      // when a newer choice is made. The load, begun before that choice, is
      // destroyed when it ends, never installed, and the play says so; the
      // next play plays the bank the page names.
      async 'an engine load overtaken by a choice'() {
        for (const newer of ['removal', 'pick']) {
          await baseline();
          await arm('send');
          await page.locator('#listen-play').click();
          await held('send');
          if (newer === 'removal') { await remove(); await says(REMOVED); await names('(default)'); }
          else { await pick('newer.sf2'); await says(KEPT('newer.sf2')); await names('newer.sf2'); }
          const sent = await banks.counts();
          await release('send');
          // The load ends once the synth has its bank (well within 5 s): no
          // engine it made may be left holding it.
          await playEnds(sent, 5000).catch(() => {});
          await page.waitForTimeout(500);
          await banks.settled(`${newer}: the overtaken load`, { stored: newer === 'removal' ? null : 'newer.sf2' });
          await statusSays(CHOICE_DURING_LOAD);
          const before = await banks.counts();
          await playOnce();
          const after = await banks.settled(`${newer}: the next play`, { stored: newer === 'removal' ? null : 'newer.sf2' });
          assert.ok(after.notes > before.notes, `${newer}: the next play plays`);
        }
      },
      // The page reads the store as it loads (a reconcile older than every
      // choice). A pick made while that read is held is kept and named; the
      // first read, let through last, never names the bank it read.
      async 'the page\'s first read of the store against a pick'() {
        await baseline();
        await banks.armOnLoad('read');
        await reopen();
        await held('read');
        await watchMessages();
        await pick('picked.sf2');
        await says(KEPT('picked.sf2'));
        await names('picked.sf2');
        await release('read');
        await staysFor('the first read', ({ named }) => assert.equal(named.name, 'picked.sf2', `the first read never replaces the pick: ${named.text}`));
        await banks.settled('the first read against a pick', { stored: 'picked.sf2' });
      },
      // A pick cut short behind an intact header is refused before it is
      // kept; the page stays on the kept bank. One kept before banks were
      // checked (written straight into the store) is named, and every play
      // tries to load it and says it does not parse: no other bank plays.
      async 'damaged banks'() {
        await baseline({ engine: true });
        await pick('truncated.sf2', truncated);
        await says(REFUSED);
        await banks.settled('a damaged pick refused', { stored: 'saw.sf2' });
        await banks.add({ 'kept-damaged.sf2': truncated });
        await writeStraight(page, 'kept-damaged.sf2', truncated);
        await reopen();
        await names('kept-damaged.sf2');
        for (const attempt of ['first play', 'retry']) {
          const before = await banks.counts();
          await page.evaluate(() => { document.querySelector('#listen-status').textContent = ''; });
          await page.locator('#listen-play').click();
          await statusSays('無法播放：音色庫無法解析，已停止載入');
          assert.equal((await banks.counts()).sends, before.sends + 1, `${attempt}: this play sent the kept bank to the engine itself`);
          await banks.settled(`${attempt}: a kept damaged bank`, { stored: 'kept-damaged.sf2' });
        }
      },
      // Another tab keeps another bank in the same store: this page names it
      // before it plays it. The play that finds it says the bank changed; the
      // next one plays it.
      async 'a bank another tab keeps'() {
        await baseline();
        await writeStraight(page, 'other-tab.sf2', await bank('other-tab.sf2'));
        const before = await banks.counts();
        await page.evaluate(() => { document.querySelector('#listen-status').textContent = ''; });
        await page.locator('#listen-play').click();
        await playEnds(before);
        await banks.check('a play that finds another tab\'s bank');
        assert.equal((await banks.counts()).notes, before.notes, 'nothing played the bank the page did not name');
        await statusSays(BANK_CHANGED);
        await banks.settled('another tab\'s bank named', { stored: 'other-tab.sf2' });
        await playOnce();
        await banks.settled('another tab\'s bank played', { stored: 'other-tab.sf2' });
      },
    };
    assert.deepEqual(Object.keys(scenarios), STUDIO_BANK_SCENARIOS);
    for (const name of STUDIO_BANK_SCENARIOS) {
      if (only && !only.includes(name)) continue;
      try { await scenarios[name](); }
      catch (error) { throw Object.assign(Error(`${name}: ${error.message}`), { cause: error }); }
      ran.push(name);
    }
    assert.deepEqual(errors, []);
    return { ran };
  } finally {
    await context.close();
  }
}

// Writes a bank straight into the store, as another tab, or a build from
// before banks were checked, would.
async function writeStraight(page, name, bytes) {
  await page.evaluate(async ([name, bytes]) => {
    const db = await new Promise((resolve, reject) => { const request = indexedDB.open('mml-studio-soundbank', 1); request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error); });
    const buffer = new Uint8Array(bytes).buffer;
    const sha256 = [...new Uint8Array(await crypto.subtle.digest('SHA-256', buffer))].map(b => b.toString(16).padStart(2, '0')).join('');
    await new Promise((resolve, reject) => {
      const tx = db.transaction('banks', 'readwrite');
      tx.objectStore('banks').put({ name, size: buffer.byteLength, sha256, format: 'sfbk', savedAt: new Date().toISOString(), bytes: buffer }, 'current');
      tx.oncomplete = resolve; tx.onerror = () => reject(tx.error);
    });
    db.close();
  }, [name, [...bytes]]);
}
