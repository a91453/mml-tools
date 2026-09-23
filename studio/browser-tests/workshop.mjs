import assert from 'node:assert/strict';
import { BasicSoundBank } from 'spessasynth_core';

// The Workshop editor (studio/web/workshop/), end to end in a real browser:
// open a Studio MML as a copy, language switch, dark/light theme, a note drawn
// on the piano roll with undo/redo, 3MLE export and re-import, WAV export
// through the real SpessaSynth worker, the video dialog's preview, and the
// hand-back into Studio's ordinary candidate intake. The bank is SpessaSynth's
// own one-preset saw wave, generated here; no real instrument bank is used.
// Everything is driven by element ids, so the check is language-independent.
const texts = page => page.evaluate(() => [...document.querySelectorAll('.pane textarea')].map(t => t.value));
const bare = s => s.replace(/\s+/g, '');

async function download(page, action) {
  const [file] = await Promise.all([page.waitForEvent('download'), action()]);
  const chunks = [];
  for await (const chunk of await file.createReadStream()) chunks.push(chunk);
  return { name: file.suggestedFilename(), bytes: Buffer.concat(chunks) };
}

export async function runWorkshopChecks({ page, base, idle, file, screenshot }) {
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

  // ── language switch (reload keeps the score) ─────────────────────────────
  const before = await texts(page);
  await page.locator('#gear').click();
  await Promise.all([page.waitForEvent('load'), page.locator('#lang').selectOption('ja')]);
  await page.locator('#unverified').waitFor();
  assert.equal(await page.evaluate(() => document.documentElement.lang), 'ja');
  assert.equal((await page.locator('#studioOpen').textContent()).trim(), 'Studio から開く');
  assert.equal(await page.locator('#unverified').textContent(), 'ワークショップ編集（Studio 未検証）');
  assert.equal(await page.evaluate(() => document.documentElement.hasAttribute('data-i18n-pending')), false);
  assert.deepEqual(await texts(page), before, 'the score survives a language switch');
  await page.locator('#gear').click();
  await Promise.all([page.waitForEvent('load'), page.locator('#lang').selectOption('zh-Hant')]);
  await page.locator('#unverified').waitFor();
  assert.equal((await page.locator('#studioOpen').textContent()).trim(), '從 Studio 開啟');
  assert.equal(await page.locator('#unverified').textContent(), '工作坊編輯（未經 Studio 驗證）');

  // ── dark / light theme, applied before first paint on reload ─────────────
  const background = () => page.evaluate(() => getComputedStyle(document.body).backgroundColor);
  await page.locator('#gear').click();
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
  await page.locator('#gear').click();
  await page.locator('#dls').setInputFiles({ name: 'saw.sf2', mimeType: 'application/octet-stream', buffer: Buffer.from(BasicSoundBank.getSampleSoundBankFile()) });
  await page.locator('#dlsName').filter({ hasText: 'saw.sf2' }).waitFor();
  await page.keyboard.press('Escape');
  assert.equal(await page.locator('#play').isEnabled(), true);

  // ── draw a note on the roll, then undo / redo ─────────────────────────────
  const original = (await texts(page))[0];
  await page.locator('#lens button[data-len="4"]').click();
  const point = await page.evaluate(async () => (await import('./pianoroll.mjs')).pointFor(1920 * 2, 72));
  const box = await page.locator('#roll').boundingBox();
  await page.mouse.click(box.x + point.x, box.y + point.y);
  await page.waitForFunction(was => document.querySelector('.pane textarea').value !== was, original);
  const drawn = (await texts(page))[0];
  const notes = await page.evaluate(async text => (await import('./mml.mjs')).parseAll([text]).tracks[0].notes.map(n => [n.tick, n.midi]), drawn);
  assert.ok(notes.some(([tick, midi]) => tick === 3840 && midi === 72), `the drawn note is in the text: ${drawn}`);
  await page.locator('#undoBtn').click();
  await page.waitForFunction(was => document.querySelector('.pane textarea').value === was, original);
  await page.locator('#redoBtn').click();
  await page.waitForFunction(was => document.querySelector('.pane textarea').value === was, drawn);

  // ── 3MLE export and re-import ─────────────────────────────────────────────
  const edited = await texts(page);
  await page.locator('#file').click();
  await page.locator('#expName').fill('workshop-check');
  await page.locator('#expFmt').selectOption('mml');
  const mml = await download(page, () => page.locator('#expGo').click());
  assert.equal(mml.name, 'workshop-check.mml');
  const text = mml.bytes.toString('utf8');
  assert.match(text, /^\[Settings\]\r\nEncoding=utf-8\r\n/);
  assert.match(text, /\[3MLE EXTENSION\]\r\n\/\* DO NOT EDIT!!/);
  await page.locator('#file').click();
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

  // ── WAV export through the real render worker ─────────────────────────────
  await page.locator('#file').click();
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
  await page.locator('#file').click();
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
  await page.locator('#studioSend').click();
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
