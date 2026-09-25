import assert from 'node:assert/strict';
import { BasicSoundBank } from 'spessasynth_core';
import { SYNTH_READY_TIMEOUT_MS } from '../web/preview/bank-check.mjs';
import { countBankSends } from './bank-sends.mjs';
import { readyGate, withholdSynthReady } from './synth-ready.mjs';

// Gate 6 through a real engine: a project that declares a verification player
// stays PENDING until a complete playback of its exact delivery string is
// captured from the SpessaSynth worklet and recorded. The bank is SpessaSynth's
// own one-preset saw wave, generated here; no real instrument bank is used.
export async function runPlayerReadbackChecks({ page, idle, file }) {
  const song = 'MML@t120o4l4cdec,t120o3l2eg,,,,;';
  await page.locator('#new-project').click(); await idle();
  await page.getByLabel('專案／歌曲名稱', { exact: true }).fill('Readback fixture');
  await page.getByLabel('錄音版本（專輯／MV／Live 等）', { exact: true }).fill('Synthetic readback v1');
  await page.getByLabel('有效音樂起點（秒）', { exact: true }).fill('0');
  await page.getByLabel('有效音樂終點（秒）', { exact: true }).fill('2');
  await page.getByLabel('來源確認的拍號圖', { exact: true }).fill('0 4/4');
  await page.locator('[name="audioRequired"]').selectOption('no');
  await page.locator('[name="preview"]').selectOption('used');
  await page.getByRole('button', { name: '儲存專案設定', exact: true }).click();
  await page.locator('h1').filter({ hasText: 'Readback fixture' }).waitFor(); await idle();
  await file('candidate', song, 'readback.mml');
  await page.locator('#review-form [name="name"]').selectOption('tempo');
  await page.locator('#review-form [name="evidence"]').fill('synthetic fixture: full piece');
  await page.locator('#review-form [name="note"]').fill('Reviewed tempo');
  await page.getByRole('button', { name: '記錄已完成審核', exact: true }).click();
  await page.locator('.review-log').filter({ hasText: 'Reviewed tempo' }).waitFor(); await idle();

  const gate = page.locator('#gates .gate').filter({ hasText: '播放器實際回讀' });
  assert.equal(await gate.locator('.badge').textContent(), 'PENDING');
  assert.ok((await gate.textContent()).includes('PLAYER_READBACK_NOT_RECORDED'));

  // A truncated bank (intact RIFF header) is refused here too, before it is
  // kept. One kept before banks were parsed ends the load with the card's
  // message, and the card leaves its loading state so play can be pressed
  // again; a valid bank picked next plays through the checks below.
  const sample = Buffer.from(BasicSoundBank.getSampleSoundBankFile());
  const truncated = sample.subarray(0, sample.length >> 1);
  const storedName = () => page.evaluate(async () => (await (await import('./studio/web/preview/soundbank-store.mjs')).loadBank())?.name ?? null);
  const before = await storedName();
  await page.locator('#bank-file').setInputFiles({ name: 'truncated.sf2', mimeType: 'application/octet-stream', buffer: truncated });
  await page.locator('#timbre-preview .note').filter({ hasText: '音色庫無法解析，沒有儲存' }).waitFor();
  assert.equal(await storedName(), before, 'the truncated bank is not kept');
  await page.evaluate(async bytes => {
    const db = await new Promise((resolve, reject) => { const request = indexedDB.open('mml-studio-soundbank', 1); request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error); });
    const buffer = new Uint8Array(bytes).buffer;
    await new Promise((resolve, reject) => {
      const tx = db.transaction('banks', 'readwrite');
      tx.objectStore('banks').put({ name: 'truncated.sf2', size: buffer.byteLength, sha256: '0'.repeat(64), format: 'sfbk', savedAt: new Date().toISOString(), bytes: buffer }, 'current');
      tx.oncomplete = resolve; tx.onerror = () => reject(tx.error);
    });
    db.close();
  }, [...truncated]);
  // Written straight into the store, as another tab would, it is not the bank
  // the card names: the first play plays nothing, names the bank the store
  // now keeps, and asks for play again (the page plays only the bank it
  // names). Then each play loads the bank again. A play handed the first
  // play's failed load back would show the same message but send the engine
  // nothing, so the banks sent to the worklet are counted. Pressing play
  // clears the card's error before anything is awaited, so the message
  // waited for is this play's.
  const bankSends = await countBankSends(page);
  const beforeNamed = await bankSends();
  await page.locator('#preview-play').click();
  await page.locator('#timbre-preview .note').filter({ hasText: '音色庫已更換，請再按一次播放。' }).waitFor();
  assert.match(await page.locator('#bank-status').textContent(), /^truncated\.sf2 /, 'the card now names the bank the store keeps');
  assert.equal(await bankSends(), beforeNamed, 'a bank the card did not name was never sent to the engine');
  for (const attempt of ['first play', 'retry']) {
    const sent = await bankSends();
    await page.locator('#preview-play').click();
    // Well inside the engine's load timeout: the worklet's parse error ends the load.
    await page.locator('#timbre-preview .note').filter({ hasText: '音色庫無法解析，已停止載入' }).waitFor({ timeout: 20000 });
    assert.equal(await bankSends(), sent + 1, `${attempt}: this play sent the bank to the engine itself`);
    assert.equal((await page.locator('#preview-play').textContent()).trim(), '▶ 播放', `${attempt}: the card is not left loading`);
    assert.equal(await page.locator('#preview-play').isEnabled(), true, `${attempt}: play can be pressed again`);
  }

  await page.locator('#bank-file').setInputFiles({ name: 'saw.sf2', mimeType: 'application/octet-stream', buffer: sample });
  await page.locator('#bank-status').filter({ hasText: /saw\.sf2.*sha256/ }).waitFor();
  assert.equal(await storedName(), 'saw.sf2');

  // A synth whose processor never reports ready (its first reply withheld,
  // synth-ready.mjs) ends the load with the card's message instead of
  // leaving it loading, and no bank is sent to it; the playbacks below start
  // a new engine. Only the readiness limit is shortened for the run: it is
  // the one timer the page arms with that delay.
  await page.evaluate(readyGate);
  await withholdSynthReady(page, true);
  await page.evaluate(limit => {
    const realSetTimeout = window.setTimeout;
    window.setTimeout = (callback, ms, ...rest) => realSetTimeout(callback, ms === limit ? 300 : ms, ...rest);
    window.restoreReadyLimit = () => { window.setTimeout = realSetTimeout; };
  }, SYNTH_READY_TIMEOUT_MS);
  const sentBeforeReady = await bankSends();
  await page.locator('#preview-play').click();
  await page.locator('#timbre-preview .note').filter({ hasText: `音色試聽引擎在 ${SYNTH_READY_TIMEOUT_MS / 1000} 秒內沒有就緒，已停止載入` }).waitFor();
  assert.equal(await bankSends(), sentBeforeReady, 'no bank is sent to a synth that is not ready');
  assert.equal((await page.locator('#preview-play').textContent()).trim(), '▶ 播放', 'the card is not left loading');
  await page.evaluate(() => window.restoreReadyLimit());
  await withholdSynthReady(page, false);

  // A playback with a role muted is captured but cannot be recorded.
  await page.locator('[data-preview-role="1"]').uncheck();
  await page.locator('#preview-play').click();
  await page.locator('#player-readback').filter({ hasText: '沒有涵蓋整首' }).waitFor({ timeout: 30000 });
  assert.equal(await page.locator('#record-readback').count(), 0);
  await page.locator('[data-preview-role="1"]').check();

  await page.locator('#preview-play').click();
  await page.locator('#record-readback').waitFor({ timeout: 30000 });
  assert.ok((await page.locator('#player-readback').textContent()).includes('與目前的 exact MML 一致'), await page.locator('#player-readback').textContent());
  await page.locator('#record-readback').click(); await idle();
  assert.equal(await gate.locator('.badge').textContent(), 'PASS');
  assert.ok((await gate.textContent()).includes('ENGINE_EVENTS_MATCH_EXACT_MML'));
  const stored = await page.evaluate(async () => (await (await import('./studio/web/storage.mjs')).listProjects()).find(w => w.title === 'Readback fixture').playerReadback);
  assert.equal(stored.exactMml, 'MML@t120o4l4cdec,t120o3l2eg,,,,;');
  assert.equal(stored.capture.scope, 'processed_engine_events_not_hardware_audio');
  assert.equal(stored.capture.gameTimbreEquivalent, false);
  assert.equal(stored.capture.events.filter(event => event[1] === 1).length, 6);
  assert.equal(await page.locator('.hero .badge').textContent(), 'CANDIDATE', 'readback alone validates nothing');
}
