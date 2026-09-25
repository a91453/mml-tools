import assert from 'node:assert/strict';
import { BasicSoundBank } from 'spessasynth_core';
import { BANK_CHECKER_LOAD_TIMEOUT_MS, bankCheckTimeoutMs } from '../web/preview/soundbank-store.mjs';
import { SYNTH_READY_TIMEOUT_MS } from '../web/preview/bank-check.mjs';
import { bankSendCounter, countBankSends } from './bank-sends.mjs';
import { readyGate, withholdSynthReady } from './synth-ready.mjs';
import { bankSendHold, keptBankReadHold, processorHold, synthReadyHold } from './workshop-boot.mjs';
import { namedBank, watchBanks } from './bank-invariant.mjs';

// How a check drives the Workshop page, as a user of this profile would. A
// touch profile taps, and reaches the header commands through the phone
// menu, whose button has to show its icon.
export function workshopDriver({ page, profile = {} }) {
  const press = locator => (profile.hasTouch ? locator.tap() : locator.click());
  const command = async id => {
    const toggle = page.locator('#navToggle');
    if (await toggle.isVisible()) {
      assert.ok((await toggle.locator('svg').boundingBox())?.width > 0, 'the menu button shows its icon');
      await press(toggle);
      await page.locator('#navMenu').waitFor();
    }
    await press(page.locator(id));
  };
  // The settings drawer slides out; on a phone it covers nearly the whole
  // width until it has gone, so wait for that rather than tap through it.
  const closeSettings = async () => {
    await (profile.hasTouch ? press(page.locator('#settingsClose')) : page.keyboard.press('Escape'));
    await page.waitForFunction(() => document.querySelector('#settings').getBoundingClientRect().left >= innerWidth - 1);
  };
  // Waits for the bank label to name `name`, not followed by "reading" (a
  // pick still being read). A load that never lands says where it stopped
  // -- still reading, a refused load, the engine's own boot step, the audio
  // context, the bank in the store -- instead of only that a 30 s wait ran
  // out (desktop Chromium, once in CI on 2b5fe41).
  const bankLoaded = async name => {
    try {
      const reading = await page.evaluate(() => import('./i18n.mjs').then(i18n => i18n.t('ui.bankReading')));
      await page.waitForFunction(([name, reading]) => {
        const text = document.querySelector('#dlsName')?.textContent ?? '';
        return text.startsWith(`${name} · `) && !text.endsWith(reading);
      }, [name, reading]);
    } catch (error) {
      const seen = await page.evaluate(async () => {
        const engine = await import('./engine.mjs').catch(e => ({ unreadable: e.message }));
        const stored = await import('../preview/soundbank-store.mjs').then(store => store.loadBank()).then(bank => bank?.name ?? null, e => `unreadable: ${e.message}`);
        return {
          url: location.href,
          label: document.querySelector('#dlsName')?.textContent,
          engine_status: document.querySelector('#engine')?.textContent,
          audio_context: engine.context ? engine.context()?.state ?? 'not created' : engine,
          play_enabled: document.querySelector('#play')?.disabled === false,
          log: document.querySelector('#log')?.textContent?.trim().slice(0, 500),
          stored_bank: stored,
        };
      }).catch(e => ({ unreadable: e.message }));
      throw Object.assign(new Error(`The Workshop never showed ${name} as its bank: ${JSON.stringify(seen)}`), { cause: error });
    }
  };
  return { press, command, closeSettings, bankLoaded };
}

async function download(page, action) {
  const [file] = await Promise.all([page.waitForEvent('download'), action()]);
  const chunks = [];
  for await (const chunk of await file.createReadStream()) chunks.push(chunk);
  return { name: file.suggestedFilename(), bytes: Buffer.concat(chunks) };
}

export const WORKSHOP_BANK_SCENARIOS = Object.freeze([
  'damaged picks',
  'a pick whose check runs out of time or whose checker never loads',
  'overlapping picks: the last one wins',
  'a refused pick after an older pick\'s write',
  'an overtaken refusal during the store re-read',
  'a play and an export while a pick is pending',
  'a play while an older write lands and a newer pick is checked',
  'a load overtaken after its send',
  'a bank another tab keeps',
  'a pick while the engine loads its processor',
  'a pick while the kept bank is read',
  'a pick overtaken while it waits for the engine',
  'a pick while the synth gets ready',
  'a kept bank failing at boot after a pick',
  'a synth that never reports ready',
]);

// The user's bank in the Workshop, kept in Studio's local bank store: the
// single source of truth the Workshop shares with Studio (preview/
// bank-choices.mjs). A pick only decides what the store keeps; the latest
// choice says its own outcome (a refusal, in the log) and is then
// reconciled, which loads, names, plays and exports exactly the bank the
// store keeps. From the first scenario on, bankProbe (bank-invariant.mjs)
// follows every bank the page sends to its synth and every note and render
// it plays, each with the bank the page named at that moment: banks.check
// asserts that no note and no render ever used a bank other than the one
// named; banks.settled also asserts that, once a choice has settled, the
// page names exactly the bank the store keeps and the synth holds no other.
// Every bank picked here has bytes of its own (namedBank). Each scenario
// starts from saw.sf2 kept and loaded, and can run on its own (`only`, a
// list of scenario names; all of them by default). The page is the
// Workshop, opened with a score to play, and the settings drawer closed.
export async function runWorkshopBankChecks({ page, profile = {}, only = null }) {
  const { press, command, bankLoaded } = workshopDriver({ page, profile });
  const sampleBank = Buffer.from(BasicSoundBank.getSampleSoundBankFile());
  const banks = await watchBanks(page);
  const bank = async name => { const bytes = namedBank(sampleBank, name); await banks.add({ [name]: bytes }); return bytes; };
  const sawBank = await bank('saw.sf2');
  const truncatedBank = sawBank.subarray(0, sawBank.length >> 1);
  const pick = async (name, buffer) => page.locator('#dls').setInputFiles({ name, mimeType: 'application/octet-stream', buffer: buffer ?? await bank(name) });
  const t = (key, vars = null) => page.evaluate(([key, vars]) => import('./i18n.mjs').then(i18n => i18n.t(key, vars)), [key, vars]);
  const storedBankName = () => page.evaluate(async () => (await (await import('../preview/soundbank-store.mjs')).loadBank())?.name);
  const logNow = () => page.evaluate(() => document.querySelector('#logMsg')?.textContent ?? '');
  const clearLog = () => page.evaluate(() => { document.querySelector('#logMsg').textContent = ''; });
  const logSays = (text, timeout = 30000) => page.waitForFunction(text => document.querySelector('#logMsg')?.textContent.includes(text), text, { timeout });
  // Every text the bank label and the log line show, in order.
  const watchLabels = () => page.evaluate(() => {
    const label = document.querySelector('#dlsName'), log = document.querySelector('#logMsg');
    window.bankLabels = []; window.logLines = [];
    window.bankLabelWatch?.disconnect();
    window.bankLabelWatch = new MutationObserver(() => {
      if (window.bankLabels.at(-1) !== label.textContent) window.bankLabels.push(label.textContent);
      if (log.textContent && window.logLines.at(-1) !== log.textContent) window.logLines.push(log.textContent);
    });
    window.bankLabelWatch.observe(label, { childList: true, characterData: true, subtree: true });
    window.bankLabelWatch.observe(log, { childList: true, characterData: true, subtree: true });
  });
  const labels = () => page.evaluate(() => window.bankLabels);
  // Until the label no longer says a pick is being read: the latest choice
  // has ended and the page names what it names now.
  const labelSettles = async () => {
    const reading = await t('ui.bankReading');
    await page.waitForFunction(reading => { const text = document.querySelector('#dlsName')?.textContent ?? ''; return text !== reading && !text.endsWith(reading); }, reading);
  };
  const arm = (what, options = {}) => page.evaluate(([what, options]) => { window.bankHolds.arm(what, options); }, [what, options]);
  const held = what => page.waitForFunction(what => window.bankHolds[what]?.held === 1, what);
  const release = async what => {
    await page.evaluate(what => window.bankHolds[what].release(), what);
    await page.waitForFunction(what => window.bankHolds[what].answered === 1, what);
  };
  const label = () => page.locator('#dlsName').textContent();
  const playing = () => page.evaluate(async () => (await import('./player.mjs')).isPlaying());
  const stopPlay = () => page.evaluate(() => document.querySelector('#stop:enabled')?.click());
  const notesOn = name => page.waitForFunction(name => window.bankProbe.notes.some(note => note.bank === window.bankProbe.names[name]), name);
  const wavNow = async () => {
    await command('#file');
    await page.locator('#mixGo').click();
    await page.locator('#wavBox.on').waitFor();
    const wav = await download(page, () => page.locator('#wavGo').click());
    await page.locator('#wavCancel').click();
    assert.equal(wav.bytes.subarray(0, 4).toString('latin1'), 'RIFF');
    return wav;
  };
  const bankSends = await countBankSends(page);
  const unparsable = (await t('ui.bankUnparsable', { detail: '\u0001' })).split('\u0001')[0];
  const loadError = await t('ui.bankLoadError');
  const notKept = (await t('ui.bankNotKept', { detail: '\u0001' })).split('\u0001')[0];
  const workletStep = `${await t('engine.step.worklet')}…`;
  const baseline = async where => {
    await pick('saw.sf2', sawBank);
    await bankLoaded('saw.sf2');
    await banks.settled(`${where}: saw.sf2 kept`, { stored: 'saw.sf2' });
    await clearLog();
    await watchLabels();
  };
  // Holds for the Workshop's boot (workshop-boot.mjs), a refused store write,
  // a synth that never reports ready and its shortened limit, each armed for
  // one page load by a sessionStorage flag; every load counts the banks it
  // sends (bankSendCounter), a held send before it is counted.
  await page.addInitScript(() => {
    if (sessionStorage.getItem('workshopRefuseBankStore') !== 'yes') return;
    sessionStorage.removeItem('workshopRefuseBankStore');
    crypto.subtle.digest = () => Promise.reject(Error('bank store write refused (browser check)'));
  });
  await page.addInitScript(processorHold);
  await page.addInitScript(keptBankReadHold);
  await page.addInitScript(bankSendCounter);
  await page.addInitScript(synthReadyHold);
  await page.addInitScript(bankSendHold);
  await page.addInitScript(readyGate);
  await page.addInitScript(limit => {
    if (sessionStorage.getItem('workshopShortReadyLimit') !== 'yes') return;
    sessionStorage.removeItem('workshopShortReadyLimit');
    const realSetTimeout = window.setTimeout;
    window.setTimeout = (callback, ms, ...rest) => realSetTimeout(callback, ms === limit ? 300 : ms, ...rest);
  }, SYNTH_READY_TIMEOUT_MS);
  const reload = async (where, flags = []) => {
    await banks.check(where);
    await page.evaluate(flags => { for (const flag of flags) sessionStorage.setItem(flag, 'yes'); }, flags);
    await page.reload(); await page.locator('#unverified').waitFor();
  };
  // Boot: the bank the store keeps is read as the engine boots, a reconcile
  // older than any pick. A pick is made while the step named by `hold` is
  // held (workshop-boot.mjs), then the step is let through. The pick is
  // kept, and the boot-time read, however late it ends or is asked for
  // again, changes nothing: saw.sf2 is never named or sent to the synth,
  // only the pick is. When the pick is refused instead (its store write
  // fails), the log says so and the page names what the store keeps,
  // saw.sf2, loaded once, by the pick's own reconcile.
  const pickWhileHeld = async (flag, hold, { refused = false } = {}) => {
    await reload(`before ${hold}`, refused ? [flag, 'workshopRefuseBankStore'] : [flag]);
    await page.waitForFunction(hold => window[hold]?.held === 1, hold);
    await watchLabels();
    const before = await page.evaluate(() => ({ label: document.querySelector('#dlsName')?.textContent ?? '', engine: document.querySelector('#engine')?.textContent, sends: window.bankSends }));
    assert.ok(!before.label.startsWith('saw.sf2'), `${hold}: no bank is loaded yet when the pick is made: ${before.label}`);
    assert.equal(before.sends, 0, `${hold}: no bank has been sent to a synth yet`);
    await pick('picked.sf2');
    await page.evaluate(hold => window[hold].release(), hold);
    const kept = refused ? 'saw.sf2' : 'picked.sf2';
    await labelSettles();
    await banks.settled(`${hold}${refused ? ', refused' : ''}: once the pick has ended`, { stored: kept });
    await bankLoaded(kept);
    await page.evaluate(async () => (await import('./ui.mjs')).loadStoredBank());
    await page.waitForTimeout(300);
    const seen = await labels();
    if (refused) {
      assert.ok((await logNow()).includes(notKept), `${hold}: the pick's refusal says the bank could not be kept`);
      assert.ok(seen.every(text => !text.startsWith('picked.sf2')), `${hold}: the refused pick is never named: ${seen.join(' → ')}`);
    } else assert.ok(seen.every(text => !text.startsWith('saw.sf2')), `${hold}: the bank picked during boot is never replaced: ${seen.join(' → ')}`);
    assert.ok((await label()).startsWith(`${kept} · `), `${hold}: the page names ${kept}`);
    assert.equal(await page.evaluate(() => window.bankSends), 1, `${hold}: ${kept} is the only bank sent to the synth`);
    await banks.settled(`${hold}${refused ? ', refused' : ''}`, { stored: kept });
    return before;
  };

  const scenarios = {
    // A bank cut short behind an intact header is refused before it is kept
    // or handed to the synth: the log says, in the page language, that it
    // does not parse, quoting the engine, and the page goes on naming
    // saw.sf2, which the store keeps and the synth holds. So is one whose
    // bytes carry markup: the log line is HTML, and a chunk name written as
    // markup is shown as text.
    async 'damaged picks'() {
      await baseline('damaged picks');
      const marked = Buffer.from(sawBank);
      marked.write('<b>A', 12, 'latin1');
      for (const [name, bytes] of [['truncated.sf2', truncatedBank], ['marked.sf2', marked]]) {
        const sentBefore = await bankSends();
        await clearLog();
        await pick(name, bytes);
        await logSays(loadError, 20000);
        await labelSettles();
        await banks.settled(`${name} refused`, { stored: 'saw.sf2' });
        await logSays(unparsable);
        await bankLoaded('saw.sf2');
        const shown = await logNow();
        assert.ok(shown.includes(await t('ui.bankLoadError')) && shown.includes('SF parsing error'), `${name}: the parse error is shown: ${shown}`);
        assert.equal(await storedBankName(), 'saw.sf2', `${name}: the refused bank is not kept`);
        assert.equal(await bankSends(), sentBefore, `${name}: nor sent to the synth`);
      }
      const quoted = await logNow();
      assert.ok(quoted.includes('got "<b>a"'), `the bank's bytes are quoted as text: ${quoted}`);
      assert.equal(await page.locator('#logMsg b').count(), 0, 'nothing from the bank becomes markup');
    },
    // A pick whose check does not answer in time (a damaged bank can keep
    // the parser allocating until the tab crashes; here a stand-in check
    // Worker loads and then never answers) is refused in the page language,
    // saying only that it could not be checked: the check's Worker is
    // stopped, nothing is kept or sent to the synth, and the page goes on
    // naming the bank the store keeps. So is one whose check Worker never
    // loads its parser (a download that hangs), with its own message, and
    // the bank is never handed to it. Only the limit that ends each case is
    // shortened for the run: it is the one timer the page arms with that delay.
    async 'a pick whose check runs out of time or whose checker never loads'() {
      await baseline('checks out of time');
      const checkLimit = bankCheckTimeoutMs(sawBank.length);
      for (const [stage, loads, limit, refusal] of [
        ['check', true, checkLimit, await t('ui.bankCheckTimeout', { s: Math.round(checkLimit / 1000) })],
        ['checker load', false, BANK_CHECKER_LOAD_TIMEOUT_MS, await t('ui.bankCheckerLoadTimeout', { s: BANK_CHECKER_LOAD_TIMEOUT_MS / 1000 })],
      ]) {
        await page.evaluate(([loads, limit]) => {
          const RealWorker = window.Worker, realSetTimeout = window.setTimeout;
          window.checks = { stopped: 0, handed: 0 };
          window.Worker = function (url, options) {
            if (!String(url).endsWith('/preview/bank-check-worker.mjs')) return new RealWorker(url, options);
            const worker = { postMessage() { window.checks.handed += 1; }, terminate() { worker.stopped = true; window.checks.stopped += 1; } };
            if (loads) realSetTimeout(() => { if (!worker.stopped) worker.onmessage?.({ data: { loaded: true } }); }, 1);
            return worker;
          };
          window.setTimeout = (callback, ms, ...rest) => realSetTimeout(callback, ms === limit ? 200 : ms, ...rest);
          window.restoreBankCheck = () => { window.Worker = RealWorker; window.setTimeout = realSetTimeout; };
        }, [loads, limit]);
        const sentBefore = await bankSends();
        await clearLog();
        await pick('unchecked.sf2');
        await logSays(loadError);
        await labelSettles();
        await banks.settled(`${stage}: refused`, { stored: 'saw.sf2' });
        await logSays(refusal);
        await bankLoaded('saw.sf2');
        assert.ok(!(await logNow()).includes(unparsable), `${stage}: the refusal does not call the bank damaged`);
        assert.deepEqual(await page.evaluate(() => window.checks), { stopped: 1, handed: loads ? 1 : 0 }, `${stage}: the check Worker is stopped, and is handed the bank only once it has loaded`);
        assert.equal(await bankSends(), sentBefore, `${stage}: the bank is never sent to the synth`);
        assert.equal(await storedBankName(), 'saw.sf2', `${stage}: nor kept`);
        await page.evaluate(() => window.restoreBankCheck());
      }
    },
    // Picks that overlap: the check of the first pick is held (its Worker's
    // answer, or, for a slow first download of the parser, its "loaded"
    // message, whose own clock starts only then) until a second pick has
    // been kept and loaded. Once let through, the first pick has been
    // overtaken: it is not written to the store, not sent to the synth, and
    // its name is never shown.
    async 'overlapping picks: the last one wins'() {
      for (const stage of ['answer', 'loaded']) {
        const [older, newer] = stage === 'answer' ? ['first.sf2', 'second.sf2'] : ['slow-parser.sf2', 'after-slow.sf2'];
        await baseline(`overlapping picks (${stage})`);
        await page.evaluate(() => {
          const put = IDBObjectStore.prototype.put;
          window.bankWrites = [];
          IDBObjectStore.prototype.put = function (value, key, ...rest) {
            if (key === 'current') window.bankWrites.push(value?.name);
            return put.call(this, value, key, ...rest);
          };
          window.restoreWrites = () => { IDBObjectStore.prototype.put = put; };
        });
        const sentBefore = await bankSends();
        await arm('check', { stage });
        await pick(older);
        await held('check');
        await pick(newer);
        await bankLoaded(newer);
        await release('check');
        // Checked (and, for a slow parser, parsed) after release: well within 2 s.
        for (let i = 0; i < 20; i += 1) {
          assert.ok((await label()).startsWith(`${newer} · `), `${stage}: the page stays on ${newer}`);
          await page.waitForTimeout(100);
        }
        const overlap = await page.evaluate(() => ({ labels: window.bankLabels, writes: window.bankWrites, log: window.logLines }));
        assert.ok(overlap.labels.every(text => !text.startsWith(older)), `${stage}: the overtaken pick is never shown: ${overlap.labels.join(' → ')}`);
        assert.deepEqual(overlap.log, [], `${stage}: the overtaken pick says nothing, and the kept one has nothing to say`);
        assert.deepEqual(overlap.writes, [newer], `${stage}: the overtaken pick is never written to the store`);
        assert.equal(await bankSends(), sentBefore + 1, `${stage}: only the later pick is sent to the synth`);
        await page.evaluate(() => window.restoreWrites());
        await banks.settled(`${stage}: overlapping picks`, { stored: newer });
      }
    },
    // Round 4: a newer pick refused after an older pick's store write had
    // been sent (it cannot be stopped). The store keeps the older pick, so
    // the page names it, the synth loads it and an export renders it, while
    // the newer pick's refusal is what the log says. The older pick's own
    // result, arriving last, changes nothing.
    async 'a refused pick after an older pick\'s write'() {
      // `released`: the older write's completion reaches the page right after
      // the newer pick is made (the order round 4's review used); `held`: the
      // newer pick is refused and settled while it is still held.
      for (const order of ['released', 'held']) {
        const older = `written-${order}.sf2`;
        await baseline(`a refused pick after an older write (${order})`);
        await arm('write', { name: older });
        await pick(older);
        await held('write');
        await pick('damaged.sf2', truncatedBank);
        if (order === 'released') await release('write');
        await logSays(loadError);
        await labelSettles();
        await banks.settled(`${order}: a refused pick after an older pick's write`, { stored: older });
        assert.ok((await logNow()).includes(unparsable), `${order}: the refusal says the bank does not parse`);
        await bankLoaded(older);
        if (order === 'held') await release('write');
        for (let i = 0; i < 10; i += 1) {
          assert.ok((await label()).startsWith(`${older} · `), `${order}: the page stays on the bank the store keeps`);
          assert.ok((await logNow()).includes(unparsable), `${order}: the refusal stays the last word`);
          await page.waitForTimeout(100);
        }
        await banks.settled(`${order}: a refused pick after an older pick's write`, { stored: older });
        await wavNow();
        assert.equal((await banks.seen()).renders.at(-1)?.bank, banks.names[older], `${order}: the export renders the bank the store keeps and the page names`);
        await banks.check(`${order}: the export after a refused pick`);
      }
    },
    // A damaged pick re-reads the store, after its refusal has been said,
    // to name what the store keeps; a newer pick made during that read
    // overtakes it. The refusal is never said again once the newer pick has
    // been made, and the overtaken re-read names and loads nothing.
    async 'an overtaken refusal during the store re-read'() {
      await baseline('an overtaken refusal');
      await arm('read');
      await pick('damaged.sf2', truncatedBank);
      await held('read');
      assert.ok((await logNow()).includes(unparsable), 'the refusal was said when the pick ended, before the store is read again');
      const linesBefore = (await page.evaluate(() => window.logLines)).length;
      await pick('newer.sf2');
      await bankLoaded('newer.sf2');
      const labelsBefore = (await labels()).length;
      await release('read');
      for (let i = 0; i < 20; i += 1) {
        const now = await page.evaluate(() => ({ lines: window.logLines, labels: window.bankLabels }));
        assert.ok(now.lines.slice(linesBefore).every(line => !line.includes(unparsable)), `the overtaken refusal is never said again: ${now.lines.join(' → ')}`);
        assert.ok(now.labels.slice(labelsBefore - 1).every(text => text.startsWith('newer.sf2 · ')), `the overtaken re-read names and loads nothing: ${now.labels.join(' → ')}`);
        await page.waitForTimeout(100);
      }
      await banks.settled('an overtaken refusal', { stored: 'newer.sf2' });
    },
    // A play and an export asked for while a pick is still being checked
    // wait for it: nothing sounds and nothing is rendered until the pick has
    // been kept and the synth loaded with it, and then both use it.
    async 'a play and an export while a pick is pending'() {
      await baseline('a play and an export while a pick is pending');
      const before = await banks.check('before a play during a pending pick');
      await arm('check');
      await pick('pending.sf2');
      await held('check');
      await page.evaluate(() => document.querySelector('#play').click());
      await command('#file');
      await page.locator('#mixGo').click();
      await page.locator('#wavBox.on').waitFor();
      const pendingWav = download(page, () => page.locator('#wavGo').click());
      // Awaited below; a failed assertion before then must not leave it unhandled.
      pendingWav.catch(() => {});
      await page.waitForTimeout(1000);
      const waiting = await banks.check('while a pick is pending');
      assert.equal(waiting.notes, before.notes, 'no note is played while a pick is pending');
      assert.equal(waiting.renders, before.renders, 'nothing is rendered while a pick is pending');
      assert.equal(await playing(), false, 'the play waits');
      await release('check');
      await bankLoaded('pending.sf2');
      await pendingWav;
      await page.locator('#wavCancel').click();
      await notesOn('pending.sf2');
      await stopPlay();
      const after = await banks.settled('a play and an export during a pending pick', { stored: 'pending.sf2' });
      assert.ok(after.notes > before.notes, 'the waiting play played once the pick was kept');
      assert.equal((await banks.seen()).renders.at(-1)?.bank, banks.names['pending.sf2'], 'the waiting export rendered the kept pick');
    },
    // first.sf2's write lands while the newer second.sf2 is still being
    // checked, so the store keeps first.sf2 while the page names saw.sf2 and
    // says it is reading. A play asked for then waits for second.sf2, and
    // plays what the page names then.
    async 'a play while an older write lands and a newer pick is checked'() {
      await baseline('a play while an older write lands');
      await arm('write', { name: 'first.sf2' });
      await pick('first.sf2');
      await held('write');
      await arm('check');
      await pick('second.sf2');
      await held('check');
      await release('write');
      assert.equal(await storedBankName(), 'first.sf2', 'the older write has landed');
      const before = await banks.counts();
      await page.evaluate(() => document.querySelector('#play').click());
      await page.waitForTimeout(1000);
      await banks.check('a play while first.sf2 is kept and second.sf2 is checked');
      const during = await banks.counts();
      assert.deepEqual([during.notes, during.sends], [before.notes, before.sends], 'the play waits for second.sf2');
      await release('check');
      await bankLoaded('second.sf2');
      await notesOn('second.sf2');
      await stopPlay();
      assert.ok((await labels()).every(text => !text.startsWith('first.sf2')), `the overtaken first.sf2 is never named: ${(await labels()).join(' → ')}`);
      await banks.settled('a play while an older write landed', { stored: 'second.sf2' });
    },
    // A load overtaken once its bank has been sent: sent.sf2 is kept and
    // sent to the synth, whose receipt is held (bankHolds send), and
    // after.sf2 is picked meanwhile. sent.sf2 is never named, nothing plays
    // it, and the page ends on after.sf2.
    async 'a load overtaken after its send'() {
      await baseline('a load overtaken after its send');
      await arm('send');
      await pick('sent.sf2');
      await held('send');
      await pick('after.sf2');
      await release('send');
      await bankLoaded('after.sf2');
      assert.ok((await labels()).every(text => !text.startsWith('sent.sf2')), `the load overtaken after its send is never named: ${(await labels()).join(' → ')}`);
      await banks.settled('a load overtaken after its send', { stored: 'after.sf2' });
    },
    // Another tab keeps another bank in the same store (written straight
    // into it) while the Workshop names saw.sf2, which its synth holds. An
    // export reads the store as it starts: it finds a bank the page does not
    // name, renders nothing and says so, and the page then names, and loads,
    // the bank the store keeps. The next export renders that bank.
    async 'a bank another tab keeps'() {
      await baseline('a bank another tab keeps');
      await writeStraight(page, 'other-tab.sf2', await bank('other-tab.sf2'));
      const before = await banks.check('before an export finds another tab\'s bank');
      await command('#file');
      await page.locator('#mixGo').click();
      await page.locator('#wavBox.on').waitFor();
      await page.locator('#wavGo').click();
      // Until the export has either said why it stopped or handed a bank to the render.
      await page.waitForFunction(renders => !document.querySelector('#wavErr').hidden || window.bankProbe.counts().renders > renders, before.renders);
      const found = await banks.check('an export that finds another tab\'s bank');
      assert.equal(found.renders, before.renders, 'nothing is rendered from a bank the page does not name');
      assert.equal(await page.locator('#wavErr').textContent(), await t('stage.err.bankChanged'), 'the export says the kept bank changed');
      await page.locator('#wavCancel').click();
      await bankLoaded('other-tab.sf2');
      await banks.settled('an export that found another tab\'s bank', { stored: 'other-tab.sf2' });
      await wavNow();
      assert.equal((await banks.seen()).renders.at(-1)?.bank, banks.names['other-tab.sf2'], 'the next export renders the bank the page now names');
      await banks.check('the export after another tab\'s bank was named');
    },
    // The processor is still loading: the engine is at its worklet step.
    async 'a pick while the engine loads its processor'() {
      await baseline('a pick while the engine boots');
      const booting = await pickWhileHeld('holdProcessor', 'processorHold');
      assert.equal(booting.engine, workletStep, 'the pick is made while the engine loads its processor');
    },
    // The engine is ready and the kept bank has been asked for, not read yet;
    // then the same with the pick's store write refused.
    async 'a pick while the kept bank is read'() {
      await baseline('a pick while the kept bank is read');
      const reading = await pickWhileHeld('holdKeptBankRead', 'keptBankReadHold');
      const hz = await page.evaluate(async () => (await import('./engine.mjs')).context().sampleRate);
      assert.equal(reading.engine, await t('engine.ready', { hz }), 'the engine has booted before this pick');
      await baseline('a refused pick while the kept bank is read');
      await pickWhileHeld('holdKeptBankRead', 'keptBankReadHold', { refused: true });
    },
    // A pick overtaken while it waits for the engine: its bank has been
    // checked and kept, and its reconcile has read it from the store, but
    // the processor is still loading, so it has not been sent. A newer pick
    // is made then. Once the processor loads, the older pick's bank is not
    // sent to the synth and never shown; the newer pick's is.
    async 'a pick overtaken while it waits for the engine'() {
      await baseline('a pick overtaken while it waits for the engine');
      await reload('before a pick waits on the boot', ['holdProcessor']);
      await page.waitForFunction(() => window.processorHold?.held === 1);
      await watchLabels();
      await arm('read');
      await pick('waiting.sf2');
      await held('read');
      await release('read');
      await page.waitForTimeout(100);
      assert.equal(await page.locator('#engine').textContent(), workletStep, 'the older pick waits for the processor');
      assert.equal(await storedBankName(), 'waiting.sf2', 'the older pick was kept before the newer one was made');
      await pick('newer.sf2');
      await page.evaluate(() => window.processorHold.release());
      await bankLoaded('newer.sf2');
      const waited = await labels();
      assert.ok(waited.every(text => !text.startsWith('waiting.sf2')), `the pick overtaken while the engine booted is never shown: ${waited.join(' → ')}`);
      assert.equal(await page.evaluate(() => window.bankSends), 1, 'only the newer pick is sent to the synth');
      await banks.settled('a pick overtaken while the engine boots', { stored: 'newer.sf2' });
    },
    // A pick made while the boot-time load of the kept bank waits for the
    // new synth to be ready (its first reply is held, workshop-boot.mjs):
    // once the synth is ready, the kept bank is not sent and never shown;
    // the pick is.
    async 'a pick while the synth gets ready'() {
      await baseline('a pick while the synth gets ready');
      await reload('before the synth gets ready', ['holdSynthReady']);
      await page.waitForFunction(() => window.synthReadyHold?.held === 1);
      await watchLabels();
      await pick('picked.sf2');
      await page.evaluate(() => window.synthReadyHold.release());
      await bankLoaded('picked.sf2');
      const readied = await labels();
      assert.ok(readied.every(text => !text.startsWith('saw.sf2')), `the kept bank saw.sf2 never replaces a pick made while the synth got ready: ${readied.join(' → ')}`);
      assert.equal(await page.evaluate(() => window.bankSends), 1, 'only the pick is sent to the synth');
      await banks.settled('a pick while the synth gets ready', { stored: 'picked.sf2' });
    },
    // A kept bank that fails to load at boot after a pick has been made
    // says nothing: the pick's own result is the one shown. The kept bank is
    // one stored before banks were checked (cut short behind an intact
    // header); its send to the synth is held (workshop-boot.mjs) until the
    // pick has been made. The synth's parse error then ends the boot-time
    // load, and the pick loads.
    async 'a kept bank failing at boot after a pick'() {
      await baseline('a kept bank failing at boot after a pick');
      await banks.add({ 'kept-truncated.sf2': truncatedBank });
      await writeStraight(page, 'kept-truncated.sf2', truncatedBank);
      const bootWarnings = [];
      const onConsole = message => { if (message.type() === 'warning') bootWarnings.push(message.text()); };
      page.on('console', onConsole);
      await reload('before the kept bank fails at boot', ['holdBankSend']);
      await page.waitForFunction(() => window.bankSendHold?.held === 1);
      await watchLabels();
      await clearLog();
      await pick('saw.sf2', sawBank);
      await page.evaluate(() => window.bankSendHold.release());
      await bankLoaded('saw.sf2');
      page.off('console', onConsole);
      assert.ok(bootWarnings.some(text => text.includes('[Workshop] stored bank failed to load')), `the kept bank did fail to load at boot: ${bootWarnings.join(' | ')}`);
      const afterPick = await page.evaluate(() => ({ labels: window.bankLabels, log: document.querySelector('#logMsg')?.textContent ?? '' }));
      const failedLabel = await t('ui.bankFailed');
      assert.ok(afterPick.labels.every(text => text !== failedLabel), `the boot-time failure does not replace the pick's label: ${afterPick.labels.join(' → ')}`);
      assert.equal(afterPick.log, '', 'nor write to the log once a pick has been made');
      assert.equal(await page.evaluate(() => window.bankSends), 2, 'the kept bank and then the pick were sent');
      await banks.settled('a kept bank failing at boot after a pick', { stored: 'saw.sf2' });
    },
    // With the processor's first reply withheld, as from one that never
    // finishes starting (synth-ready.mjs), the boot-time load of the kept
    // bank and then a pick each end as a failed load with the page's
    // not-ready message in the log, instead of leaving the label reading
    // and every later load waiting, and no bank is sent to a synth that is
    // not ready; each load tries a new synth. Only the readiness limit is
    // shortened for the run: it is the one timer the page arms with that
    // delay.
    async 'a synth that never reports ready'() {
      await baseline('a synth that never reports ready');
      await withholdSynthReady(page, true);
      await reload('before the synth never reports ready', ['workshopShortReadyLimit']);
      // The limit counts only while the audio context runs, and one made as
      // the page loads may wait for a user gesture first: a tap on a button
      // that only resumes it, as the page's own play or audition would.
      await page.waitForFunction(async () => Boolean((await import('./engine.mjs')).context()));
      await page.evaluate(async () => {
        const engine = await import('./engine.mjs');
        const button = Object.assign(document.createElement('button'), { id: 'resumeAudio', type: 'button', textContent: 'resume audio' });
        button.style.cssText = 'position:fixed;left:0;top:0;z-index:2147483647';
        button.onclick = () => { engine.resume(); button.remove(); };
        document.body.append(button);
      });
      await press(page.locator('#resumeAudio'));
      await page.waitForFunction(async () => (await import('./engine.mjs')).context().state === 'running');
      // The boot-time load of the kept bank: the banks sent are counted from
      // the moment the page loaded (bankSendCounter).
      await page.waitForFunction(failed => document.querySelector('#dlsName')?.textContent === failed, await t('ui.bankFailed'));
      const notReady = await t('engine.synthTimeout', { s: SYNTH_READY_TIMEOUT_MS / 1000 });
      const bootShown = await logNow();
      assert.ok(bootShown.includes(await t('ui.bankLoadError')) && bootShown.includes(notReady), `the boot-time load says why it stopped: ${bootShown}`);
      const readySends = await countBankSends(page);
      assert.equal(await readySends(), 0, 'the kept bank is not sent to a synth that is not ready');
      // Then a pick; the log is emptied first, so the message waited for is the pick's.
      await clearLog();
      await pick('saw.sf2', sawBank);
      await logSays(notReady);
      assert.equal(await label(), await t('ui.bankFailed'), 'the pick ends as a failed load');
      assert.equal(await readySends(), 0, 'no bank is sent to a synth that is not ready');
      await banks.check('a synth that never reports ready');
      await withholdSynthReady(page, false);
      await reload('after the synth never reported ready');
      await bankLoaded('saw.sf2');
      await page.locator('#play:enabled').waitFor();
      await banks.settled('the kept bank at boot', { stored: 'saw.sf2' });
    },
  };
  assert.deepEqual(Object.keys(scenarios), WORKSHOP_BANK_SCENARIOS);
  const ran = [];
  for (const name of WORKSHOP_BANK_SCENARIOS) {
    if (only && !only.includes(name)) continue;
    try { await scenarios[name](); }
    catch (error) { throw Object.assign(Error(`${name}: ${error.message}`), { cause: error }); }
    ran.push(name);
  }
  // Every scenario ends with saw.sf2, or a bank of its own, kept and loaded.
  await baselineEnd();
  return { ran, banks };

  async function baselineEnd() {
    await pick('saw.sf2', sawBank);
    await bankLoaded('saw.sf2');
    await banks.settled('saw.sf2 again', { stored: 'saw.sf2' });
  }
}

// Writes a bank straight into the store, as a build from before banks were
// checked would have kept it.
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
