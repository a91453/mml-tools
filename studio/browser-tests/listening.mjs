import assert from 'node:assert/strict';
import zlib from 'node:zlib';
import { encodeListenLink } from '../web/listen-link.mjs';

// Listening sessions through the real page and the real preview engine. Runs
// after the player-readback checks, so a user bank (SpessaSynth's generated
// one-preset saw wave) is already stored on this origin. Synthetic MML only.
const codec = { deflateRaw: bytes => new Uint8Array(zlib.deflateRawSync(bytes)), inflateRaw: (bytes, max) => new Uint8Array(zlib.inflateRawSync(bytes, { maxOutputLength: max })) };
// t120 in 4/4: one bar is exactly two seconds.
const CURRENT = 'MML@t120o4l4cdefgabcdefgabcdefgabc,t120o3l1ccccc,,,,;';
const PREVIOUS = 'MML@t120o4l4cdefgabc>d<efgabcdefgabc,t120o3l1ccccc,,,,;';

export async function runListeningChecks({ page, base }) {
  const projectsBefore = await page.locator('#projects option').allTextContents();
  const payload = await encodeListenLink({
    schema: 'mml-studio/listen-link@1', mml: CURRENT, title: '<img src=x onerror=alert(1)> 試聽', meter_text: '0 4/4', start: { bar: 2 },
    markers: [{ beat: '12', end_beat: '14', role: 'Melody', kind: 'lead-unverified', label: 'Lead <b>待確認</b>' }, { beat: '6', kind: 'pending', label: '暫定' }],
    compare_mml: PREVIOUS, source: { project_id: 'prj_synthetic', artifact_id: 'art_synthetic' },
  }, codec);

  // A fresh load with the link: count every AudioContext the page constructs.
  await page.addInitScript(() => {
    const Native = window.AudioContext;
    if (!Native || Native.__counted) return;
    window.__audioContexts = 0;
    window.AudioContext = class extends Native { constructor(...args) { super(...args); window.__audioContexts += 1; } };
    window.AudioContext.__counted = true;
  });
  await page.goto(`${base}/?listen=${payload}`);
  await page.locator('#listen-head').waitFor();
  await page.locator('#app h1').waitFor();
  await page.waitForFunction(() => document.querySelector('#app')?.getAttribute('aria-busy') === 'false' && document.querySelectorAll('#projects option').length > 0);
  // The link is gone from the address bar, a session exists, no project was made.
  assert.equal(await page.evaluate(() => location.search + location.hash), '', 'the listen payload is cleared from the address bar');
  assert.deepEqual(await page.locator('#projects option').allTextContents(), projectsBefore, 'opening a link neither creates nor replaces a project');
  const stored = await page.evaluate(() => new Promise((resolve, reject) => {
    const request = indexedDB.open('mml-studio-listening');
    request.onsuccess = () => { const tx = request.result.transaction('sessions', 'readonly'); const all = tx.objectStore('sessions').getAll(); all.onsuccess = () => { request.result.close(); resolve(all.result); }; };
    request.onerror = () => reject(request.error);
  }));
  assert.equal(stored.length, 1);
  assert.equal(stored[0].mml, CURRENT);
  assert.equal(stored[0].origin.kind, 'link');
  // Never plays by itself.
  const position = page.locator('#listen-position');
  assert.equal(await position.getAttribute('data-state'), 'stopped');
  assert.equal(await position.getAttribute('data-from-seconds'), '');
  assert.equal(await page.evaluate(() => window.__audioContexts), 0, 'no AudioContext before a user gesture');
  // Untrusted text is shown as text.
  assert.equal(await page.locator('#listen-head h3').textContent(), '<img src=x onerror=alert(1)> 試聽');
  assert.equal(await page.locator('#listening img').count(), 0);
  assert.ok((await page.locator('#listen-markers').textContent()).includes('Lead <b>待確認</b>'));
  assert.equal(await page.locator('#listen-markers b').count(), 0);
  // A bank of the user's own (stored by the readback checks) takes precedence
  // over the default bank, and the picker lists its own presets.
  await page.locator('#listen-bank').filter({ hasText: 'saw.sf2' }).waitFor();
  assert.equal((await page.locator('#listen-bank').textContent()).includes('免費通用音色'), false);
  // The link's start point is the cue: bar 2 is two seconds in.
  assert.ok((await page.locator('#listen-cue').textContent()).includes('第 2 小節'));
  assert.equal(await position.getAttribute('data-seconds'), '2');

  // L2: changed bars are listed from the compared version.
  assert.deepEqual(await page.locator('#listen-changed-bars li').allTextContents(), ['▶ 第 3 小節Melody · 修改 1']);

  // L1: play from bar 3 starts the scheduler at exactly four seconds.
  await page.locator('#listen-from-bar [name="bar"]').fill('3');
  await page.locator('#listen-from-bar button').click();
  await page.waitForFunction(() => document.querySelector('#listen-position')?.dataset.state === 'playing' && Number(document.querySelector('#listen-position').dataset.seconds) > 4);
  assert.equal(await position.getAttribute('data-from-seconds'), '4');
  assert.equal(await position.getAttribute('data-from-beat'), '8');
  assert.equal(await position.getAttribute('data-bar'), '3');
  assert.match(await position.textContent(), /^第 3 小節 · 第 \d 拍 · 0:0[45]\.\d \/ 0:11\.0$/);
  assert.equal(await page.evaluate(() => window.__audioContexts), 1, 'the gesture created the one AudioContext');
  const presets = await page.locator('[data-listen-instrument="0"] option').allTextContents();
  assert.ok(presets.length >= 1 && presets.every(text => /^\d{3} /.test(text)), `the user bank's own presets are offered: ${presets}`);
  // Stop returns to the same point; replay starts from it again.
  await page.locator('#listen-stop').click();
  await page.waitForFunction(() => document.querySelector('#listen-position')?.dataset.state === 'stopped');
  assert.equal(await position.getAttribute('data-seconds'), '4');
  await page.locator('#listen-replay').click();
  await page.waitForFunction(() => document.querySelector('#listen-position')?.dataset.state === 'playing');
  assert.equal(await position.getAttribute('data-from-seconds'), '4');
  await page.locator('#listen-stop').click();
  // Solo is a toggle button that says whether it is pressed.
  await page.locator('[data-listen-solo="0"]').click();
  assert.equal(await page.locator('[data-listen-solo="0"]').getAttribute('aria-pressed'), 'true');
  await page.locator('[data-listen-solo="0"]').click();

  // A marker plays from one bar before the bar it is in.
  await page.locator('[data-listen-marker]').filter({ hasText: 'Melody' }).click();
  await page.waitForFunction(() => document.querySelector('#listen-position')?.dataset.state === 'playing');
  assert.equal(await position.getAttribute('data-from-seconds'), '4', 'marker at beat 12 (bar 4) with one bar of lead-in starts at bar 3');
  // Play from a time.
  await page.locator('#listen-from-time [name="time"]').fill('0:07.5');
  await page.locator('#listen-from-time button').click();
  await page.waitForFunction(() => document.querySelector('#listen-position')?.dataset.fromSeconds === '7.5');
  await page.locator('#listen-stop').click();

  // "Play changed bars only": bar 3 with one bar of lead-in, ending at bar 3's end.
  await page.locator('#listen-play-changed').click();
  await page.waitForFunction(() => document.querySelector('#listen-position')?.dataset.state === 'playing');
  assert.equal(await position.getAttribute('data-from-seconds'), '2');
  assert.equal(await position.getAttribute('data-until-seconds'), '6');
  // A/B: the same bars in the previous version.
  await page.locator('[data-listen-version="compare"]').click();
  await page.waitForFunction(() => document.querySelector('#listen-position')?.dataset.version === 'compare');
  assert.equal(await page.locator('[data-listen-version="compare"]').getAttribute('aria-pressed'), 'true');
  assert.equal(await position.getAttribute('data-until-seconds'), '6');
  // The ranged playback ends on its own at the region end.
  await page.waitForFunction(() => document.querySelector('#listen-position')?.dataset.state === 'stopped', null, { timeout: 15000 });
  await page.locator('[data-listen-version="current"]').click();

  // L3: add a note at a bar, edit it, and copy the notes for an AI.
  await page.locator('#listen-note-form [value="bar"]').check();
  await page.locator('#listen-note-form [name="bar"]').fill('2');
  await page.locator('#listen-note-form [name="role"]').selectOption('Melody');
  await page.locator('#listen-note-form [name="kind"]').selectOption('too-loud');
  await page.locator('#listen-note-form [name="text"]').fill('這裡太吵');
  await page.locator('#listen-note-form button', { hasText: '加入備註' }).click();
  await page.locator('#listen-note-list li').first().waitFor();
  assert.equal(await page.locator('#listen-note-form [name="text"]').inputValue(), '', 'a saved note clears the field');
  assert.ok((await page.locator('#listen-markers').textContent()).includes('太吵／太大聲：這裡太吵'), 'the note is listed as a marker');
  await page.locator('[data-listen-note-edit]').click();
  await page.locator('#listen-note-form [name="text"]').fill('主旋律不對');
  await page.locator('#listen-note-form [name="kind"]').selectOption('wrong-note');
  await page.locator('#listen-note-form button', { hasText: '更新備註' }).click();
  await page.locator('#listen-note-list li', { hasText: '主旋律不對' }).waitFor();
  assert.equal(await page.locator('#listen-note-list li').count(), 1);
  await page.evaluate(() => { window.copied = null; Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: async text => { window.copied = text; } } }); });
  await page.locator('#listen-copy-ai').click();
  await page.waitForFunction(() => typeof window.copied === 'string');
  const copied = (await page.evaluate(() => window.copied)).split('\n');
  const sha = await page.locator('#listen-sha').textContent();
  assert.equal(copied[1], 'title: <img src=x onerror=alert(1)> 試聽');
  assert.equal(copied[2], `mml_sha256: ${sha}`);
  assert.equal(copied.at(-1), 'bar 2 | beat 1 | q=4 | 0:02.00 | Melody | wrong-note | 主旋律不對');
  // The session's own share link carries the note back as a marker.
  await page.evaluate(() => { window.copied = null; });
  await page.locator('#listen-copy-link').click();
  await page.waitForFunction(() => typeof window.copied === 'string');
  assert.match(await page.evaluate(() => window.copied), new RegExp(`^${base.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}/#listen=[A-Za-z0-9_-]+$`));

  // A link opened while the app is running (a hash change) makes a second session.
  const second = await encodeListenLink({ schema: 'mml-studio/listen-link@1', mml: PREVIOUS, title: 'Second' }, codec);
  await page.evaluate(value => { location.hash = `listen=${value}`; }, second);
  await page.locator('#listen-head h3', { hasText: 'Second' }).waitFor();
  assert.equal(await page.evaluate(() => location.hash), '');
  assert.equal(await page.locator('#listen-session-select option').count(), 2);
  assert.ok((await page.locator('#listen-meter-assumed').textContent()).includes('4/4 假設'), 'a link without a meter says its bars are assumed');

  // 送到試聽 from the open project: notes on that session are mirrored onto the project.
  await page.locator('#listen-mml').click();
  await page.locator('#listen-head h3', { hasText: '候選 MML' }).waitFor();
  await page.locator('#listen-note-form [value="bar"]').check();
  await page.locator('#listen-note-form [name="bar"]').fill('1');
  await page.locator('#listen-note-form [name="text"]').fill('節奏太趕');
  await page.locator('#listen-note-form [name="kind"]').selectOption('timing');
  await page.locator('#listen-note-form button', { hasText: '加入備註' }).click();
  await page.locator('#listen-note-list li').first().waitFor();
  await page.waitForFunction(async () => {
    const { listProjects } = await import('./studio/web/storage.mjs');
    return (await listProjects()).some(w => w.listeningNotes?.some(note => note.text === '節奏太趕'));
  });
  assert.deepEqual(await page.locator('#projects option').allTextContents(), projectsBefore);

  // Deleting a session takes two presses and leaves projects alone.
  await page.locator('#listen-session-delete').click();
  assert.equal(await page.locator('#listen-session-delete').textContent(), '再按一次確認刪除');
  await page.locator('#listen-session-delete').click();
  await page.waitForFunction(() => document.querySelectorAll('#listen-session-select option').length === 2);
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), 'no horizontal overflow with the listening panel open');
  await page.locator('#listen-close').click();
  assert.equal(await page.locator('#listening').isHidden(), true);

  await runPasteChecks({ page, projectsBefore });
}

// Raw MML pasted, picked and dropped straight into the listening panel: one
// local session with A, B and a third selectable version; nothing uploaded, no
// project made.
const THIRD = 'MML@t120o4l4ddefgabcdefgabcdefgabc,t120o3l1ccccc,,,,;';
async function runPasteChecks({ page, projectsBefore }) {
  await page.locator('#open-listening').click();
  // The panel reopens the newest session; wait for it so its render does not race the clicks below.
  await page.locator('#listen-head').waitFor();
  const sessionsBefore = await page.locator('#listen-session-select option').count();
  // The form opens by itself only when there is nothing else to show.
  if (await page.locator('#listen-mml-paste').getAttribute('open') === null) await page.locator('#listen-mml-paste summary').click();
  await page.locator('[data-listen-vmml="0"]').waitFor();
  // A text that is not a complete MML string is refused beside the form; no session is made.
  await page.locator('[data-listen-vmml="0"]').fill('t120cde');
  // Counts are painted on the next animation frame.
  await page.waitForFunction(() => document.querySelector('[data-listen-vcounts="0"]')?.textContent === '尚未是完整的 MML@…; 字串。');
  await page.locator('#listen-mml-open').click();
  await page.locator('#listen-mml-error').filter({ hasText: '不是完整的 MML@…; 字串' }).waitFor();
  assert.equal(await page.locator('#listen-session-select option').count(), sessionsBefore);
  // Typed: highlighted, with the per-role counts of the project paste box.
  await page.locator('[data-listen-vmml="0"]').fill(CURRENT);
  await page.locator('[data-listen-vlabel="0"]').fill('我的版本');
  await page.waitForFunction(() => document.querySelector('[data-listen-vcounts="0"]')?.textContent.startsWith('Melody 30／2400'));
  assert.ok(await page.locator('[data-listen-vlayer="0"] span').count() > 0, 'the pasted MML is highlighted');
  // Picked from a file: the label is the file name.
  await page.locator('[data-listen-vfile="1"]').setInputFiles({ name: 'someone-else.mml', mimeType: 'text/plain', buffer: Buffer.from(`${PREVIOUS}\n`) });
  await page.locator('[data-listen-vlabel="1"][value="someone-else"]').waitFor();
  assert.equal(await page.locator('[data-listen-vmml="0"]').inputValue(), CURRENT, 'loading a file keeps what was typed in the other slots');
  // Dropped onto a third slot.
  await page.locator('#listen-mml-add').click();
  const transfer = await page.evaluateHandle(text => { const dt = new DataTransfer(); dt.items.add(new File([text], 'third.txt', { type: 'text/plain' })); return dt; }, THIRD);
  await page.locator('[data-listen-slot="2"]').dispatchEvent('drop', { dataTransfer: transfer });
  await page.waitForFunction(value => document.querySelector('[data-listen-vmml="2"]')?.value === value, THIRD);
  await page.locator('#listen-mml-form [name="title"]').fill('A/B 比較 <b>x</b>');
  await page.locator('#listen-mml-form [name="meter"]').fill('0 4/4');
  await page.locator('#listen-mml-open').click();
  await page.locator('#listen-head h3', { hasText: 'A/B 比較 <b>x</b>' }).waitFor();
  assert.equal(await page.locator('#listen-head b').count(), 0);
  assert.equal(await page.locator('#listen-session-select option').count(), sessionsBefore + 1);
  assert.deepEqual(await page.locator('#projects option').allTextContents(), projectsBefore, 'pasting MML neither creates nor replaces a project');
  const stored = await page.evaluate(() => new Promise((resolve, reject) => {
    const request = indexedDB.open('mml-studio-listening');
    request.onsuccess = () => { const tx = request.result.transaction('sessions', 'readonly'); const all = tx.objectStore('sessions').getAll(); all.onsuccess = () => { request.result.close(); resolve(all.result); }; };
    request.onerror = () => reject(request.error);
  }));
  const session = stored.find(item => item.origin?.kind === 'paste');
  assert.equal(session.mml, CURRENT);
  assert.equal(session.meterText, '0 4/4');
  assert.equal(session.compareMml, PREVIOUS);
  assert.deepEqual(session.alternatives.map(item => item.label), ['someone-else', 'third']);
  assert.equal(await page.locator('#listen-meter-assumed').count(), 0, 'the given meter is used, not assumed');
  // The pasted form is emptied once its session exists.
  assert.equal(await page.locator('[data-listen-vmml="0"]').inputValue(), '');
  // A/B, changed bars and ranged playback work as for a link.
  assert.equal(await page.locator('[data-listen-version="current"]').textContent(), 'A 我的版本');
  assert.equal(await page.locator('[data-listen-version="compare"]').textContent(), 'B someone-else');
  assert.deepEqual(await page.locator('#listen-changed-bars li').allTextContents(), ['▶ 第 3 小節Melody · 修改 1']);
  const position = page.locator('#listen-position');
  await page.locator('#listen-play-changed').click();
  await page.waitForFunction(() => document.querySelector('#listen-position')?.dataset.state === 'playing');
  assert.equal(await position.getAttribute('data-from-seconds'), '2');
  assert.equal(await position.getAttribute('data-until-seconds'), '6');
  await page.locator('#listen-stop').click();
  // The third version can be chosen as B.
  await page.locator('#listen-changes details summary', { hasText: '改用其他前一版' }).click();
  await page.locator('#listen-compare-form [name="compare"]').selectOption({ label: '貼上：third' });
  await page.locator('#listen-compare-form button').click();
  await page.locator('[data-listen-version="compare"]', { hasText: 'B third' }).waitFor();
  assert.deepEqual(await page.locator('#listen-changed-bars li').allTextContents(), ['▶ 第 1 小節Melody · 修改 1']);
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), 'no horizontal overflow with the paste form');
  await page.locator('#listen-close').click();
}
