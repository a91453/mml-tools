import assert from 'node:assert/strict';
import { crc32 } from 'node:zlib';
import { BasicSoundBank } from 'spessasynth_core';

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
  await page.locator('#dlsName').filter({ hasText: 'saw.sf2' }).waitFor();
  await closeSettings();
  assert.equal(await page.locator('#play').isEnabled(), true);

  // ── a bank picked while the engine boots is not replaced ─────────────────
  // At boot the Workshop loads the bank kept in the store (saw.sf2), which is
  // older than any pick. On a slow device the pick can come while the synth
  // processor is still loading and before its own store write has landed (a
  // big bank hashes slowly; one over the store's limit is refused), so the
  // boot-time read still finds saw.sf2. Here the processor is held until the
  // pick is made, and the pick's store write is refused.
  await page.addInitScript(() => {
    if (sessionStorage.getItem('workshopRefuseBankStore') !== 'yes') return;
    sessionStorage.removeItem('workshopRefuseBankStore');
    crypto.subtle.digest = () => Promise.reject(Error('bank store write refused (browser check)'));
  });
  const PROCESSOR = '**/vendor/spessasynth/processor.js';
  let releaseProcessor;
  const processorHeld = new Promise(resolve => { releaseProcessor = resolve; });
  await page.route(PROCESSOR, async route => { await processorHeld; await route.continue(); });
  await page.evaluate(() => sessionStorage.setItem('workshopRefuseBankStore', 'yes'));
  await page.reload(); await page.locator('#unverified').waitFor();
  await page.evaluate(() => {
    const label = document.querySelector('#dlsName');
    window.bankLabels = [];
    new MutationObserver(() => window.bankLabels.push(label.textContent)).observe(label, { childList: true, characterData: true, subtree: true });
  });
  await page.locator('#dls').setInputFiles({ name: 'picked.sf2', mimeType: 'application/octet-stream', buffer: Buffer.from(BasicSoundBank.getSampleSoundBankFile()) });
  releaseProcessor();
  await page.waitForFunction(() => window.bankLabels.some(text => text.startsWith('picked.sf2')));
  // The stored bank never replaces a pick, however late it is asked for. A
  // stored-bank load queued behind the pick would run before this one ends,
  // so every label the page showed is recorded by the time it returns.
  await page.evaluate(async () => (await import('./ui.mjs')).loadStoredBank());
  const labels = await page.evaluate(() => window.bankLabels);
  const sincePick = labels.slice(labels.findIndex(text => text.startsWith('picked.sf2')));
  assert.ok(sincePick.every(text => text.startsWith('picked.sf2')), `the bank picked during boot is never replaced: ${labels.join(' → ')}`);
  assert.match(await page.locator('#dlsName').textContent(), /^picked\.sf2 /, 'the bank picked during boot is the one loaded');
  assert.equal(await page.evaluate(async () => (await (await import('../preview/soundbank-store.mjs')).loadBank())?.name), 'saw.sf2', 'the refused pick left saw.sf2 in the store');
  await page.unroute(PROCESSOR);
  await page.reload(); await page.locator('#unverified').waitFor();
  await page.waitForFunction(() => document.querySelector('#dlsName')?.textContent.startsWith('saw.sf2'));
  await page.locator('#play:enabled').waitFor();

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
  const drawnPixels = await page.evaluate(() => {
    const c = document.querySelector('#wfStage');
    const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
    let lit = 0;
    for (let i = 0; i < d.length; i += 4) if (d[i] + d[i + 1] + d[i + 2] > 60) lit++;
    return lit;
  });
  assert.ok(drawnPixels > 100, 'the waterfall preview is drawn');
  await screenshot('workshop-video');
  await page.locator('#videoClose').click();

  // ── Workshop → Studio: a derived candidate, never a verified one ─────────
  await command('#studioSend');
  await page.locator('#studioSendBox.on').waitFor();
  const sent = await page.locator('#studioSendText').inputValue();
  assert.match(sent, /^MML@([^,;]*,){5}[^,;]*;$/, 'six role slots');
  await Promise.all([page.waitForURL(url => new URL(url).pathname === '/' || new URL(url).pathname.endsWith('/index.html')), page.locator('#studioSendGo').click()]);
  await page.locator('#workshop-return .workshop-return').waitFor();
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
}
