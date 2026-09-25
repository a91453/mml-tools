import assert from 'node:assert/strict';
import { crc32 } from 'node:zlib';
import { BasicSoundBank } from 'spessasynth_core';
import { BANK_CHECKER_LOAD_TIMEOUT_MS, bankCheckTimeoutMs } from '../web/preview/soundbank-store.mjs';
import { SYNTH_READY_TIMEOUT_MS } from '../web/preview/bank-check.mjs';
import { countBankSends } from './bank-sends.mjs';
import { holdNextBankCheck } from './bank-check-hold.mjs';
import { readyGate, withholdSynthReady } from './synth-ready.mjs';

// The Workshop editor (studio/web/workshop/), end to end in a real browser:
// open a Studio MML as a copy, language switch, dark/light theme, a bank
// picked while the engine boots, a note drawn on the piano roll with
// undo/redo, 3MLE export and re-import, MusicXML import, WAV export through
// the real SpessaSynth worker, the video dialog's preview, and the hand-back
// into Studio's ordinary candidate intake. The bank is SpessaSynth's
// own one-preset saw wave, generated here; no real instrument bank is used.
// Everything is driven by element ids, so the check is language-independent.
// Touch profiles tap, and reach the header commands through the phone menu.
const texts = page => page.evaluate(() => [...document.querySelectorAll('.pane textarea')].map(t => t.value));

// A stored (uncompressed) ZIP of the given entries: enough of an .mxl for the
// container reader, which accepts stored and deflated entries alike.
function storedZip(entries) {
  const locals = [], centrals = [];
  let offset = 0;
  for (const [name, text] of entries) {
    const path = Buffer.from(name), data = Buffer.from(text), crc = crc32(data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(20, 4); local.writeUInt16LE(0x0800, 6);
    local.writeUInt32LE(crc, 14); local.writeUInt32LE(data.length, 18); local.writeUInt32LE(data.length, 22); local.writeUInt16LE(path.length, 26);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0); central.writeUInt16LE(20, 4); central.writeUInt16LE(20, 6); central.writeUInt16LE(0x0800, 8);
    central.writeUInt32LE(crc, 16); central.writeUInt32LE(data.length, 20); central.writeUInt32LE(data.length, 24); central.writeUInt16LE(path.length, 28); central.writeUInt32LE(offset, 42);
    locals.push(local, path, data); centrals.push(central, path);
    offset += 30 + path.length + data.length;
  }
  const directory = Buffer.concat(centrals), end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(entries.length, 8); end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(directory.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, directory, end]);
}
const SCORE = '<?xml version="1.0" encoding="UTF-8"?><score-partwise version="4.0"><part-list><score-part id="P1"><part-name>Piano</part-name></score-part></part-list><part id="P1">'
  + '<measure number="1"><attributes><divisions>1</divisions><time><beats>4</beats><beat-type>4</beat-type></time></attributes><direction><sound tempo="120"/></direction>'
  + '<note><pitch><step>C</step><octave>4</octave></pitch><duration>2</duration></note><note><pitch><step>E</step><octave>4</octave></pitch><duration>2</duration></note></measure>'
  + '<measure number="2"><note><pitch><step>G</step><octave>4</octave></pitch><duration>4</duration></note></measure></part></score-partwise>';
// Bar 1 is empty; bar 3 turns to 3/4 and carries rehearsal mark B.
const LATE = '<?xml version="1.0" encoding="UTF-8"?><score-partwise version="4.0"><part-list><score-part id="P1"><part-name>Piano</part-name></score-part></part-list><part id="P1">'
  + '<measure number="1"><attributes><divisions>1</divisions><time><beats>4</beats><beat-type>4</beat-type></time></attributes><direction><sound tempo="120"/></direction><note><rest/><duration>4</duration></note></measure>'
  + '<measure number="2"><note><pitch><step>C</step><octave>4</octave></pitch><duration>4</duration></note></measure>'
  + '<measure number="3"><attributes><time><beats>3</beats><beat-type>4</beat-type></time></attributes><direction><direction-type><rehearsal>B</rehearsal></direction-type></direction><note><pitch><step>G</step><octave>4</octave></pitch><duration>3</duration></note></measure></part></score-partwise>';
const CONTAINER = '<?xml version="1.0" encoding="UTF-8"?><container><rootfiles><rootfile full-path="score.xml" media-type="application/vnd.recordare.musicxml+xml"/></rootfiles></container>';
const bare = s => s.replace(/\s+/g, '');

async function download(page, action) {
  const [file] = await Promise.all([page.waitForEvent('download'), action()]);
  const chunks = [];
  for await (const chunk of await file.createReadStream()) chunks.push(chunk);
  return { name: file.suggestedFilename(), bytes: Buffer.concat(chunks) };
}

export async function runWorkshopChecks({ page, base, idle, file, screenshot, profile = {} }) {
  // A touch profile is driven the way a phone or tablet user drives the page:
  // taps, not mouse clicks.
  const press = locator => (profile.hasTouch ? locator.tap() : locator.click());
  // On a phone the header commands (Studio, clipboard, file, settings, about)
  // sit behind the menu button, so they are reached through it, as a phone
  // user reaches them. The button has to show its icon: an empty square is
  // not something a user can be expected to find.
  const command = async id => {
    const toggle = page.locator('#navToggle');
    if (await toggle.isVisible()) {
      assert.ok((await toggle.locator('svg').boundingBox())?.width > 0, 'the menu button shows its icon');
      await press(toggle);
      await page.locator('#navMenu').waitFor();
    }
    await press(page.locator(id));
  };
  // A mobile browser widens its layout viewport to fit what overflows, so
  // innerWidth would hide an overflow there; compare with the profile's width.
  const fitsWidth = async what => {
    const width = profile.viewport?.width ?? await page.evaluate(() => innerWidth);
    assert.ok(await page.evaluate(w => document.documentElement.scrollWidth <= w + 1, width), `${what}: no horizontal page scroll at ${width}px`);
  };
  // The settings drawer slides out; on a phone it covers nearly the whole
  // width until it has gone, so wait for that rather than tap through it.
  const closeSettings = async () => {
    await (profile.hasTouch ? press(page.locator('#settingsClose')) : page.keyboard.press('Escape'));
    await page.waitForFunction(() => document.querySelector('#settings').getBoundingClientRect().left >= innerWidth - 1);
  };
  // Waits for the bank label to name `name`. A load that never lands says
  // where it stopped -- still reading, a refused load, the engine's own boot
  // step, the audio context, the bank in the store -- instead of only that a
  // 30 s wait ran out (desktop Chromium, once in CI on 2b5fe41).
  const bankLoaded = async name => {
    try {
      await page.waitForFunction(name => document.querySelector('#dlsName')?.textContent.startsWith(name), name);
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
  // ── Studio → Workshop: the candidate MML opens as a copy ─────────────────
  // A project of its own, so the hand-back below touches no other fixture.
  await page.goto(base); await page.locator('#app h1').waitFor(); await idle();
  await page.locator('#new-project').click(); await idle();
  await file('candidate', 'MML@t120o4l4cdec,t120o3l2eg,t120o2c1,,,;', 'workshop-source.mml');
  const link = page.locator('#intake a.workshop-link').first();
  const href = await link.getAttribute('href');
  const params = new URLSearchParams(href.slice(href.indexOf('#') + 1));
  const projectId = params.get('studio-project'), slot = params.get('asset');
  const source = await page.evaluate(async ({ projectId, slot }) => {
    const storage = await import('./studio/web/storage.mjs');
    const w = await storage.loadProject(projectId);
    return slot === 'delivery' ? w.deliveryMml : w.assets[slot].content;
  }, { projectId, slot });
  await Promise.all([page.waitForURL(/\/studio\/web\/workshop\/index\.html/), link.click()]);
  await page.locator('#unverified').waitFor();
  const expected = source.replace(/^MML@/i, '').replace(/;\s*$/, '').split(',').map(bare);
  await page.waitForFunction(first => document.querySelector('.pane textarea')?.value.replace(/\s+/g, '') === first, expected[0]);
  assert.deepEqual((await texts(page)).slice(0, expected.length).map(bare), expected, 'the Studio MML is loaded unchanged (no Nxx in it)');
  assert.equal(await page.locator('#studioOrigin').isVisible(), true, 'the copy names its Studio source');
  assert.equal(new URL(page.url()).hash, '', 'the one-shot link is consumed');
  await fitsWidth('the Workshop as opened');

  // ── language switch (reload keeps the score) ─────────────────────────────
  const before = await texts(page);
  await command('#gear');
  await Promise.all([page.waitForEvent('load'), page.locator('#lang').selectOption('ja')]);
  await page.locator('#unverified').waitFor();
  assert.equal(await page.evaluate(() => document.documentElement.lang), 'ja');
  assert.equal((await page.locator('#studioOpen').textContent()).trim(), 'Studio から開く');
  assert.equal(await page.locator('#unverified').textContent(), 'ワークショップ編集（Studio 未検証）');
  assert.equal(await page.evaluate(() => document.documentElement.hasAttribute('data-i18n-pending')), false);
  assert.deepEqual(await texts(page), before, 'the score survives a language switch');
  // Text a module builds is looked up in the page language, which is chosen
  // only after every module has loaded: the import dialog's capture modes and
  // its column heading are Japanese too. Cancelled, so the score is untouched.
  await command('#file');
  await page.locator('#midFile').setInputFiles({ name: 'score.musicxml', mimeType: 'application/xml', buffer: Buffer.from(SCORE) });
  await page.locator('#midiBox.on').waitFor();
  assert.deepEqual(await page.locator('#midiRows select').first().locator('option').allTextContents(),
    ['メロディ優先', '根音優先', 'メロディ + 根音（2 トラック）', 'スマート声部分割（4 トラック）', '和音まるごと取り込み（15 トラック）'], 'the capture modes are in the page language');
  assert.equal(await page.locator('#colUnit').textContent(), 'チャンネル', 'the column heading is in the page language');
  await page.locator('#midiCancel').click();
  await page.waitForFunction(() => !document.querySelector('#midiBox')?.classList.contains('on'));
  assert.deepEqual(await texts(page), before, 'a cancelled import leaves the score alone');
  await command('#gear');
  await Promise.all([page.waitForEvent('load'), page.locator('#lang').selectOption('zh-Hant')]);
  await page.locator('#unverified').waitFor();
  assert.equal((await page.locator('#studioOpen').textContent()).trim(), '從 Studio 開啟');
  assert.equal(await page.locator('#unverified').textContent(), '工作坊編輯（未經 Studio 驗證）');
  await fitsWidth('the Workshop in Traditional Chinese');

  // ── dark / light theme, applied before first paint on reload ─────────────
  const background = () => page.evaluate(() => getComputedStyle(document.body).backgroundColor);
  await command('#gear');
  await page.locator('#theme').selectOption('dark');
  assert.equal(await page.evaluate(() => document.documentElement.dataset.theme ?? 'dark'), 'dark');
  assert.equal(await background(), 'rgb(13, 26, 27)');
  await page.locator('#theme').selectOption('light');
  assert.equal(await page.evaluate(() => document.documentElement.dataset.theme), 'light');
  const light = await background();
  assert.notEqual(light, 'rgb(13, 26, 27)');
  await page.locator('#theme').selectOption('dark');
  await page.reload(); await page.locator('#unverified').waitFor();
  assert.equal(await page.evaluate(() => document.documentElement.dataset.theme ?? 'dark'), 'dark', 'the stored theme is applied on load');
  await screenshot('workshop-dark');

  // ── the user's bank, kept in Studio's local bank store ────────────────────
  await command('#gear');
  await page.locator('#dls').setInputFiles({ name: 'saw.sf2', mimeType: 'application/octet-stream', buffer: Buffer.from(BasicSoundBank.getSampleSoundBankFile()) });
  await bankLoaded('saw.sf2');

  // A truncated bank (its RIFF header intact) is not kept in the store, and
  // the synth's parse error ends the load with the page's message instead of
  // leaving it, and every bank load queued behind it, reading forever. The
  // next pick loads.
  const t = (key, vars = null) => page.evaluate(([key, vars]) => import('./i18n.mjs').then(i18n => i18n.t(key, vars)), [key, vars]);
  const storedBankName = () => page.evaluate(async () => (await (await import('../preview/soundbank-store.mjs')).loadBank())?.name);
  const sawBank = Buffer.from(BasicSoundBank.getSampleSoundBankFile());
  await page.locator('#dls').setInputFiles({ name: 'truncated.sf2', mimeType: 'application/octet-stream', buffer: sawBank.subarray(0, sawBank.length >> 1) });
  await page.locator('#dlsName').filter({ hasText: await t('ui.bankFailed') }).waitFor({ timeout: 20000 });
  const shown = await page.locator('#logMsg').textContent();
  const unparsable = (await t('engine.bankUnparsable', { detail: '\u0001' })).split('\u0001')[0];
  assert.ok(shown.includes(await t('ui.bankLoadError')) && shown.includes(unparsable) && shown.includes('SF parsing error'), `the parse error is shown: ${shown}`);
  assert.equal(await storedBankName(), 'saw.sf2', 'the truncated bank is not kept');
  await page.locator('#dls').setInputFiles({ name: 'saw.sf2', mimeType: 'application/octet-stream', buffer: sawBank });
  await bankLoaded('saw.sf2');
  // The engine's error quotes the bank's own bytes (a chunk name), and the
  // log line is HTML: a chunk name written as markup is shown as text.
  const marked = Buffer.from(sawBank);
  marked.write('<b>A', 12, 'latin1');
  await page.locator('#dls').setInputFiles({ name: 'marked.sf2', mimeType: 'application/octet-stream', buffer: marked });
  await page.locator('#dlsName').filter({ hasText: await t('ui.bankFailed') }).waitFor({ timeout: 20000 });
  const quoted = await page.locator('#logMsg').textContent();
  assert.ok(quoted.includes('got "<b>a"'), `the bank's bytes are quoted as text: ${quoted}`);
  assert.equal(await page.locator('#logMsg b').count(), 0, 'nothing from the bank becomes markup');
  await page.locator('#dls').setInputFiles({ name: 'saw.sf2', mimeType: 'application/octet-stream', buffer: sawBank });
  await bankLoaded('saw.sf2');

  // A pick whose check does not answer in time (a damaged bank can keep the
  // parser allocating until the tab crashes; here a stand-in check Worker
  // loads and then never answers) is refused in the page language, saying
  // only that it could not be checked: the check's Worker is stopped, nothing
  // is kept, nothing is sent to the synth, and the bank queue goes on to the
  // next pick. So is a pick whose checker never loads its parser (a stand-in
  // that never says it loaded), saying that instead. Only the limit the run
  // is about is shortened: it is the one timer the page arms with that delay.
  const bankSends = await countBankSends(page);
  const checkLimit = bankCheckTimeoutMs(sawBank.length);
  for (const { name, loads, limit, refusal } of [
    { name: 'unchecked.sf2', loads: true, limit: checkLimit, refusal: await t('ui.bankCheckTimeout', { s: Math.round(checkLimit / 1000) }) },
    { name: 'checker-unloaded.sf2', loads: false, limit: BANK_CHECKER_LOAD_TIMEOUT_MS, refusal: await t('ui.bankCheckerLoadTimeout', { s: Math.round(BANK_CHECKER_LOAD_TIMEOUT_MS / 1000) }) },
  ]) {
    await page.evaluate(({ limit, loads }) => {
      const RealWorker = window.Worker, realSetTimeout = window.setTimeout;
      window.checksStopped = 0; window.checksHanded = 0;
      window.Worker = function (url, options) {
        if (!String(url).endsWith('/preview/bank-check-worker.mjs')) return new RealWorker(url, options);
        const stand = { postMessage() { window.checksHanded += 1; }, terminate() { window.checksStopped += 1; } };
        if (loads) realSetTimeout(() => stand.onmessage?.({ data: { loaded: true } }), 0);
        return stand;
      };
      window.setTimeout = (callback, ms, ...rest) => realSetTimeout(callback, ms === limit ? 200 : ms, ...rest);
      window.restoreBankCheck = () => { window.Worker = RealWorker; window.setTimeout = realSetTimeout; };
    }, { limit, loads });
    const sentBefore = await bankSends();
    await page.locator('#dls').setInputFiles({ name, mimeType: 'application/octet-stream', buffer: sawBank });
    // Settled: no longer reading, and no longer the bank loaded before.
    await page.waitForFunction(reading => {
      const label = document.querySelector('#dlsName')?.textContent ?? '';
      return label !== reading && !label.startsWith('saw.sf2');
    }, await t('ui.bankReading'));
    assert.equal(await page.locator('#dlsName').textContent(), await t('ui.bankFailed'), `${name}: a bank that could not be checked is not loaded`);
    const notChecked = await page.locator('#logMsg').textContent();
    assert.ok(notChecked.includes(refusal), `${name}: the refusal says why the bank could not be checked: ${notChecked}`);
    assert.ok(!notChecked.includes(unparsable), `${name}: and does not call it damaged`);
    assert.equal(await page.evaluate(() => window.checksStopped), 1, `${name}: the check Worker is stopped`);
    assert.equal(await page.evaluate(() => window.checksHanded), loads ? 1 : 0, `${name}: a checker is handed the bank only once it has loaded`);
    assert.equal(await bankSends(), sentBefore, `${name}: the bank is never sent to the synth`);
    assert.equal(await storedBankName(), 'saw.sf2', `${name}: nor kept`);
    await page.evaluate(() => window.restoreBankCheck());
    await page.locator('#dls').setInputFiles({ name: 'saw.sf2', mimeType: 'application/octet-stream', buffer: sawBank });
    await bankLoaded('saw.sf2');
  }

  // Overlapping picks: the last pick wins. Each pick is checked inside the
  // bank queue, and a big bank takes longer than a small one: here the first
  // pick's check is held while a second pick is made. Once released, the
  // first pick is neither kept nor loaded, and the second one is.
  await holdNextBankCheck(page);
  await page.evaluate(() => {
    const label = document.querySelector('#dlsName');
    window.overlapLabels = [];
    new MutationObserver(() => window.overlapLabels.push(label.textContent)).observe(label, { childList: true, characterData: true, subtree: true });
  });
  const sentBeforeOverlap = await bankSends();
  await page.locator('#dls').setInputFiles({ name: 'first.sf2', mimeType: 'application/octet-stream', buffer: sawBank });
  await page.waitForFunction(() => window.heldBankCheck?.handed);
  await page.locator('#dls').setInputFiles({ name: 'second.sf2', mimeType: 'application/octet-stream', buffer: sawBank });
  await page.evaluate(() => window.heldBankCheck.release());
  await bankLoaded('second.sf2');
  const overlapLabels = await page.evaluate(() => window.overlapLabels);
  assert.ok(!overlapLabels.some(text => text.startsWith('first.sf2')), `the overtaken pick is never loaded: ${overlapLabels.join(' → ')}`);
  assert.equal(await bankSends(), sentBeforeOverlap + 1, 'only the last pick is sent to the synth');
  assert.equal(await storedBankName(), 'second.sf2', 'and kept');
  assert.equal(await page.evaluate(() => window.heldBankCheck.stopped), true, 'the overtaken pick\'s check was answered and stopped');
  await page.locator('#dls').setInputFiles({ name: 'saw.sf2', mimeType: 'application/octet-stream', buffer: sawBank });
  await bankLoaded('saw.sf2');
  await closeSettings();
  await press(page.locator('#log button'));
  assert.equal(await page.locator('#play').isEnabled(), true);

  // ── a bank picked while the engine boots is not replaced ─────────────────
  // At boot the Workshop loads the bank kept in the store (saw.sf2), which is
  // older than any pick. On a slow device the pick can come while the synth
  // processor is still loading and before its own store write has landed (a
  // big bank hashes slowly; one over the store's limit is refused), so the
  // boot-time read still finds saw.sf2. Here the processor's module load is
  // held in the page until the pick is made, and the pick's store write is
  // refused. (Playwright does not route an AudioWorklet's module request, so
  // a page.route for processor.js sees nothing and holds nothing; the load
  // is held at Worklet.addModule instead, armed for one load.)
  await page.addInitScript(() => {
    if (sessionStorage.getItem('workshopRefuseBankStore') !== 'yes') return;
    sessionStorage.removeItem('workshopRefuseBankStore');
    crypto.subtle.digest = () => Promise.reject(Error('bank store write refused (browser check)'));
  });
  await page.addInitScript(() => {
    if (sessionStorage.getItem('workshopHoldProcessor') !== 'yes') return;
    sessionStorage.removeItem('workshopHoldProcessor');
    const addModule = Worklet.prototype.addModule;
    let release;
    const released = new Promise(resolve => { release = resolve; });
    window.processorHold = { held: 0, release: () => release() };
    Worklet.prototype.addModule = function (url, ...rest) {
      if (!String(url).endsWith('/vendor/spessasynth/processor.js')) return addModule.call(this, url, ...rest);
      window.processorHold.held += 1;
      return released.then(() => addModule.call(this, url, ...rest));
    };
  });
  await page.evaluate(() => { sessionStorage.setItem('workshopRefuseBankStore', 'yes'); sessionStorage.setItem('workshopHoldProcessor', 'yes'); });
  await page.reload(); await page.locator('#unverified').waitFor();
  await page.waitForFunction(() => window.processorHold?.held === 1);
  // No synth exists while the processor is held, so the count starts at 0.
  const bootSends = await countBankSends(page);
  await page.evaluate(() => {
    const label = document.querySelector('#dlsName');
    window.bankLabels = [];
    new MutationObserver(() => window.bankLabels.push(label.textContent)).observe(label, { childList: true, characterData: true, subtree: true });
  });
  assert.equal(await page.locator('#engine').textContent(), `${await t('engine.step.worklet')}…`, 'the pick is made while the engine loads its processor');
  assert.ok(!(await page.locator('#dlsName').textContent()).startsWith('saw.sf2'), 'and before the kept bank is loaded');
  await page.locator('#dls').setInputFiles({ name: 'picked.sf2', mimeType: 'application/octet-stream', buffer: Buffer.from(BasicSoundBank.getSampleSoundBankFile()) });
  await page.evaluate(() => window.processorHold.release());
  await page.waitForFunction(() => window.bankLabels.some(text => text.startsWith('picked.sf2')));
  // The stored bank never replaces a pick, however late it is asked for. A
  // stored-bank load queued behind the pick would run before this one ends,
  // so every label the page showed is recorded by the time it returns.
  await page.evaluate(async () => (await import('./ui.mjs')).loadStoredBank());
  const labels = await page.evaluate(() => window.bankLabels);
  assert.ok(labels.every(text => !text.startsWith('saw.sf2')), `the bank picked during boot is never replaced: ${labels.join(' → ')}`);
  assert.match(await page.locator('#dlsName').textContent(), /^picked\.sf2 /, 'the bank picked during boot is the one loaded');
  assert.equal(await bootSends(), 1, 'the picked bank is the only one sent to the synth');
  assert.equal(await page.evaluate(async () => (await (await import('../preview/soundbank-store.mjs')).loadBank())?.name), 'saw.sf2', 'the refused pick left saw.sf2 in the store');

  // ── a synth that never reports ready ends the load ───────────────────────
  // With the processor's first reply withheld, as from one that never
  // finishes starting (synth-ready.mjs), the boot-time load of the kept
  // bank and then a pick each end with the page's message, instead of
  // leaving the label reading and every bank load queued behind them
  // waiting, and no bank is sent to a synth that is not ready; each load
  // tries a new synth. Only the readiness limit is shortened for the run:
  // it is the one timer the page arms with that delay.
  await page.addInitScript(readyGate);
  await withholdSynthReady(page, true);
  await page.addInitScript(limit => {
    if (sessionStorage.getItem('workshopShortReadyLimit') !== 'yes') return;
    sessionStorage.removeItem('workshopShortReadyLimit');
    const realSetTimeout = window.setTimeout;
    window.setTimeout = (callback, ms, ...rest) => realSetTimeout(callback, ms === limit ? 300 : ms, ...rest);
  }, SYNTH_READY_TIMEOUT_MS);
  await page.evaluate(() => sessionStorage.setItem('workshopShortReadyLimit', 'yes'));
  await page.reload(); await page.locator('#unverified').waitFor();
  // The limit counts only while the audio context runs, and one made as the
  // page loads may wait for a user gesture first: a tap on a button that
  // only resumes it, as the page's own play or audition would.
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
  await page.waitForFunction(failed => document.querySelector('#dlsName')?.textContent === failed, await t('ui.bankFailed'));
  const readySends = await countBankSends(page);
  const notReady = await t('engine.synthTimeout', { s: SYNTH_READY_TIMEOUT_MS / 1000 });
  // The boot-time load of the kept bank says why it stopped on the page, as
  // a failed pick does, not only in the console.
  const bootShown = await page.locator('#logMsg').textContent();
  assert.ok(bootShown.includes(await t('ui.bankLoadError')) && bootShown.includes(notReady), `the boot-time load says why it stopped: ${bootShown}`);
  await page.evaluate(() => { document.querySelector('#logMsg').textContent = ''; });
  await page.locator('#dls').setInputFiles({ name: 'saw.sf2', mimeType: 'application/octet-stream', buffer: sawBank });
  await page.waitForFunction(text => document.querySelector('#logMsg')?.textContent.includes(text), notReady);
  assert.equal(await page.locator('#dlsName').textContent(), await t('ui.bankFailed'), 'the pick ends as a failed load');
  assert.equal(await readySends(), 0, 'no bank is sent to a synth that is not ready');
  await withholdSynthReady(page, false);
  await page.reload(); await page.locator('#unverified').waitFor();
  await bankLoaded('saw.sf2');
  await page.locator('#play:enabled').waitFor();

  // ── a kept bank that fails at boot after a pick says nothing ─────────────
  // A bank stored before banks were checked (cut short behind an intact
  // header) is written straight into the store, and its send to the synth at
  // boot is held until a pick has been made. The synth's parse error then
  // ends the boot-time load; the pick's label and log are the ones shown.
  await page.addInitScript(() => {
    if (sessionStorage.getItem('workshopHoldBankSend') !== 'yes') return;
    sessionStorage.removeItem('workshopHoldBankSend');
    const post = MessagePort.prototype.postMessage;
    let release;
    const released = new Promise(resolve => { release = resolve; });
    window.bankSendHold = { held: 0, release: () => release() };
    MessagePort.prototype.postMessage = function (message, ...rest) {
      if (message?.type !== 'soundBankManager' || message?.data?.type !== 'addSoundBank' || window.bankSendHold.held) return post.call(this, message, ...rest);
      window.bankSendHold.held += 1;
      released.then(() => post.call(this, message, ...rest));
      return undefined;
    };
  });
  const truncatedBank = sawBank.subarray(0, sawBank.length >> 1);
  await page.evaluate(bytes => new Promise((resolve, reject) => {
    const data = new Uint8Array(bytes).buffer;
    const open = indexedDB.open('mml-studio-soundbank', 1);
    open.onerror = () => reject(open.error);
    open.onsuccess = () => {
      const tx = open.result.transaction('banks', 'readwrite');
      tx.objectStore('banks').put({ name: 'kept-truncated.sf2', size: data.byteLength, sha256: '0'.repeat(64), format: 'sfbk', savedAt: new Date().toISOString(), bytes: data }, 'current');
      tx.oncomplete = () => { open.result.close(); resolve(); };
      tx.onerror = () => reject(tx.error);
    };
  }), [...truncatedBank]);
  const bootWarnings = [];
  const onBootConsole = message => { if (message.type() === 'warning') bootWarnings.push(message.text()); };
  page.on('console', onBootConsole);
  await page.evaluate(() => sessionStorage.setItem('workshopHoldBankSend', 'yes'));
  await page.reload(); await page.locator('#unverified').waitFor();
  await page.waitForFunction(() => window.bankSendHold?.held === 1);
  await page.evaluate(() => {
    const label = document.querySelector('#dlsName');
    window.bankLabels = [];
    new MutationObserver(() => window.bankLabels.push(label.textContent)).observe(label, { childList: true, characterData: true, subtree: true });
    document.querySelector('#logMsg').textContent = '';
  });
  await page.locator('#dls').setInputFiles({ name: 'saw.sf2', mimeType: 'application/octet-stream', buffer: sawBank });
  await page.evaluate(() => window.bankSendHold.release());
  await bankLoaded('saw.sf2');
  page.off('console', onBootConsole);
  assert.ok(bootWarnings.some(text => text.includes('[Workshop] stored bank failed to load')), `the kept bank did fail to load at boot: ${bootWarnings.join(' | ')}`);
  const afterPick = await page.evaluate(() => ({ labels: window.bankLabels, log: document.querySelector('#logMsg')?.textContent ?? '' }));
  const failedLabel = await t('ui.bankFailed');
  assert.ok(afterPick.labels.every(text => text !== failedLabel), `the boot-time failure does not replace the pick's label: ${afterPick.labels.join(' → ')}`);
  assert.equal(afterPick.log, '', 'nor writes to the log once a pick has been made');

  // ── draw a note on the roll, then undo / redo ─────────────────────────────
  const original = (await texts(page))[0];
  await press(page.locator('#lens button[data-len="4"]'));
  // The roll shows only part of the score: a phone shows less than one bar, a
  // portrait tablet about two, so bar 3 starts past the right edge of both.
  // Bring the cell into view first -- the roll's own reveal, as when the text
  // caret moves -- and refuse to aim anywhere but the visible roll.
  const target = await page.evaluate(async ([tick, midi]) => {
    const roll = await import('./pianoroll.mjs');
    roll.reveal(tick, midi);
    const point = roll.pointFor(tick, midi), box = document.querySelector('#roll').getBoundingClientRect();
    const x = box.left + point.x, y = box.top + point.y;
    const at = document.elementFromPoint(x, y);
    return { x, y, at: at?.id ?? null, what: at ? `${at.tagName.toLowerCase()}.${[...at.classList].join('.')} in #${at.closest('[id]')?.id}` : null };
  }, [1920 * 2, 72]);
  assert.equal(target.at, 'roll', `the target cell is on the visible roll: ${JSON.stringify(target)}`);
  if (profile.hasTouch) await page.touchscreen.tap(target.x, target.y);
  else await page.mouse.click(target.x, target.y);
  await page.waitForFunction(was => document.querySelector('.pane textarea').value !== was, original);
  const drawn = (await texts(page))[0];
  const notes = await page.evaluate(async text => (await import('./mml.mjs')).parseAll([text]).tracks[0].notes.map(n => [n.tick, n.midi]), drawn);
  assert.ok(notes.some(([tick, midi]) => tick === 3840 && midi === 72), `the drawn note is in the text: ${drawn}`);
  await press(page.locator('#undoBtn'));
  await page.waitForFunction(was => document.querySelector('.pane textarea').value === was, original);
  await press(page.locator('#redoBtn'));
  await page.waitForFunction(was => document.querySelector('.pane textarea').value === was, drawn);

  // ── 3MLE export and re-import ─────────────────────────────────────────────
  const edited = await texts(page);
  await command('#file');
  await page.locator('#expName').fill('workshop-check');
  await page.locator('#expFmt').selectOption('mml');
  const mml = await download(page, () => page.locator('#expGo').click());
  assert.equal(mml.name, 'workshop-check.mml');
  const text = mml.bytes.toString('utf8');
  assert.match(text, /^\[Settings\]\r\nEncoding=utf-8\r\n/);
  assert.match(text, /\[3MLE EXTENSION\]\r\n\/\* DO NOT EDIT!!/);
  await command('#file');
  // iPhone/iPad grey out an .xml an accept list does not map; read() routes by content.
  assert.equal(await page.locator('#midFile').getAttribute('accept'), null, 'the import picker carries no accept list');
  await page.locator('#midFile').setInputFiles({ name: 'workshop-check.mml', mimeType: 'text/plain', buffer: mml.bytes });
  await page.locator('#midiBox.on').waitFor();
  await page.locator('#midiMode input[value="new"]').check();
  await page.locator('#pickAll').check();
  await page.locator('#midiOk').click();
  await page.locator('#midiBox.on').waitFor({ state: 'detached' }).catch(() => {});
  await page.waitForFunction(() => !document.querySelector('#midiBox')?.classList.contains('on'));
  const reimported = await texts(page);
  const song = t => page.evaluate(async list => (await import('./mml.mjs')).parseAll(list).tracks.map(tr => tr.notes.map(n => [n.tick, n.durTick, n.midi, n.vel].join(':'))), t);
  assert.deepEqual(await song(reimported.filter(Boolean)), await song(edited.filter(Boolean)), '3MLE round trip keeps every note');

  // ── MusicXML, plain and compressed (.mxl), import to the same score ──────
  const importAll = async (name, buffer, mimeType) => {
    await command('#file');
    await page.locator('#midFile').setInputFiles({ name, mimeType, buffer });
    await page.locator('#midiBox.on').waitFor();
    await page.locator('#midiMode input[value="new"]').check();
    await page.locator('#pickAll').check();
    await page.locator('#midiOk').click();
    await page.waitForFunction(() => !document.querySelector('#midiBox')?.classList.contains('on'));
    return song((await texts(page)).filter(Boolean));
  };
  const fromXml = await importAll('score.musicxml', Buffer.from(SCORE), 'application/xml');
  assert.deepEqual(fromXml.flat().map(note => note.split(':')[2]), ['60', '64', '67'], 'the plain MusicXML score imports its three notes');
  assert.equal(await page.locator('#expName').inputValue(), 'score', 'the song is named without the .musicxml extension');
  const fromMxl = await importAll('score.mxl', storedZip([['mimetype', 'application/vnd.recordare.musicxml'], ['META-INF/container.xml', CONTAINER], ['score.xml', SCORE]]), 'application/octet-stream');
  assert.deepEqual(fromMxl, fromXml, 'an .mxl imports exactly as the MusicXML it carries');
  assert.equal(await page.locator('#expName').inputValue(), 'score', 'the song is named without the .mxl extension');
  // The empty first bar is trimmed; the 3/4 change and mark B move with the
  // notes, so both still sit on the G.
  const late = await importAll('late.musicxml', Buffer.from(LATE), 'application/xml');
  assert.deepEqual(late.flat().map(note => { const [tick, , midi] = note.split(':'); return `${tick}:${midi}`; }), ['0:60', '1920:67']);
  assert.deepEqual(await page.evaluate(async () => ({ meters: (await import('./meters.mjs')).stored(), marks: (await import('./marks.mjs')).stored() })), {
    meters: [{ tick: 0, num: 4, den: 4 }, { tick: 1920, num: 3, den: 4 }],
    marks: [{ tick: 1920, text: 'B' }],
  }, 'the meter change and the mark are on the G, as in the file');

  // ── WAV export through the real render worker ─────────────────────────────
  await command('#file');
  await page.locator('#mixGo').click();
  await page.locator('#wavBox.on').waitFor();
  const wav = await download(page, () => page.locator('#wavGo').click());
  assert.match(wav.name, /\.wav$/);
  assert.equal(wav.bytes.subarray(0, 4).toString('latin1'), 'RIFF');
  assert.equal(wav.bytes.subarray(8, 12).toString('latin1'), 'WAVE');
  assert.equal(wav.bytes.readUInt32LE(4), wav.bytes.length - 8);
  assert.ok(wav.bytes.length > 44 + 44100, 'a non-empty render');
  let peak = 0;
  for (let at = 44; at < wav.bytes.length; at += 2) peak = Math.max(peak, Math.abs(wav.bytes.readInt16LE(at)));
  assert.ok(peak > 100, 'the render is not silent');
  await page.locator('#wavCancel').click();

  // ── the video dialog renders its audio and draws a frame ──────────────────
  await command('#file');
  await page.locator('#videoOpen').click();
  await page.locator('#videoBox.on #wfMake').waitFor({ timeout: 60000 });
  // The preview is drawn on the animation frame after the render is ready,
  // not when the button appears (the stage is cleared by its layout first),
  // so a single read right away could find it blank on a slow machine, as
  // desktop Chromium once did in CI on 9324093. Wait for the drawn frame.
  const litPixels = () => {
    const c = document.querySelector('#wfStage');
    const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
    let lit = 0;
    for (let i = 0; i < d.length; i += 4) if (d[i] + d[i + 1] + d[i + 2] > 60) lit++;
    return lit;
  };
  const previewDrawn = await page.waitForFunction(`(${litPixels})() > 100`, null, { timeout: 15000 }).then(() => true, () => false);
  assert.ok(previewDrawn, `the waterfall preview is drawn: ${await page.evaluate(`(${litPixels})()`)} lit pixels after 15 s`);
  await screenshot('workshop-video');
  await page.locator('#videoClose').click();

  // ── Workshop → Studio: a derived candidate, never a verified one ─────────
  await command('#studioSend');
  await page.locator('#studioSendBox.on').waitFor();
  const sent = await page.locator('#studioSendText').inputValue();
  assert.match(sent, /^MML@([^,;]*,){5}[^,;]*;$/, 'six role slots');
  // Studio's page, not the Workshop's own .../workshop/index.html, which the
  // old endsWith('/index.html') test also accepted, so a send that never
  // navigated only surfaced 30 s later as a missing panel.
  const studioHome = url => ['/', '/index.html'].includes(new URL(url).pathname);
  await page.locator('#studioSendGo').click();
  try {
    await page.waitForURL(studioHome, { timeout: 15000 });
  } catch (error) {
    const seen = await page.evaluate(() => ({
      url: location.href,
      send_box_open: document.querySelector('#studioSendBox')?.classList.contains('on'),
      send_notes: document.querySelector('#studioSendNotes')?.textContent?.slice(0, 500),
      status: [...document.querySelectorAll('[role=status], #status, #say, .toast')].map(node => node.textContent.trim()).filter(Boolean).slice(0, 5),
    })).catch(e => ({ unreadable: e.message }));
    throw Object.assign(new Error(`The Workshop did not navigate to Studio: ${JSON.stringify(seen)}`), { cause: error });
  }
  try {
    await page.locator('#workshop-return .workshop-return').waitFor();
  } catch (error) {
    // Say what Studio showed instead: a boot error, a message about the
    // record, or a record still waiting in storage all point somewhere else.
    const seen = await page.evaluate(() => ({
      url: location.href,
      boot: { hidden: document.querySelector('#boot')?.hidden, text: document.querySelector('#boot')?.textContent },
      app_hidden: document.querySelector('#app')?.hidden,
      message: document.querySelector('#message')?.textContent,
      return_hidden: document.querySelector('#workshop-return')?.hidden,
      stored_return: (() => { try { return localStorage.getItem('studio-workshop/return')?.slice(0, 200) ?? null; } catch (e) { return `unreadable: ${e.message}`; } })(),
      controller: navigator.serviceWorker?.controller?.scriptURL ?? null,
      body: document.body?.innerText?.slice(0, 600),
    })).catch(e => ({ unreadable: e.message }));
    throw Object.assign(new Error(`Studio did not offer the Workshop return: ${JSON.stringify(seen)}`), { cause: error });
  }
  assert.match(await page.locator('#workshop-return').textContent(), /工作坊編輯（未經 Studio 驗證）/);
  assert.equal(await page.locator('#workshop-return-mml').inputValue(), sent);
  await idle();
  await page.locator('#workshop-import').click();
  await page.locator('#workshop-return').waitFor({ state: 'hidden' });
  await idle();
  const candidate = await page.locator('#intake .intake-grid .card').nth(0).locator('strong').textContent();
  assert.match(candidate, /workshop-edit-\d{12}\.mml$/);
  assert.notEqual(await page.locator('.hero .badge').textContent(), 'VALIDATED', 'a Workshop edit never arrives validated');
  assert.notEqual(await page.locator('.hero .badge').textContent(), 'IN_GAME_ACCEPTED');
  const stored = await page.evaluate(async () => (await (await import('./studio/web/storage.mjs')).listProjectSummaries())[0]);
  assert.ok(stored, 'the project with the imported candidate is saved');
  // Studio's own intake parsed the candidate (studio/backend/mml/parser.mjs,
  // ingest): what the Workshop sent must read there without a parser error —
  // no missing O before the first note, no dotted L or dotted N it cannot
  // read — and with the notes the Workshop played.
  const imported = await page.evaluate(async id => {
    const asset = (await (await import('./studio/web/storage.mjs')).loadProject(id)).assets.candidate;
    return { content: asset?.content ?? null, errors: asset?.errors ?? null, notes: asset?.project?.events?.filter(e => e.kind === 'note').length ?? 0 };
  }, stored.id);
  assert.equal(imported.content, sent, 'the stored candidate is the MML the Workshop sent');
  assert.ok(Array.isArray(imported.errors), 'the candidate carries its intake validation');
  assert.deepEqual(imported.errors.filter(e => e.position !== undefined), [], `the sent MML has no parser errors in Studio: ${JSON.stringify(imported.errors)}`);
  // The score on the page when it was sent is the last import above.
  assert.equal(imported.notes, late.flat().length, `Studio reads every note the Workshop sent: ${imported.notes}`);
}
