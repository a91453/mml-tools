import assert from 'node:assert/strict';
import { BasicSoundBank } from 'spessasynth_core';

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

  await page.locator('#bank-file').setInputFiles({ name: 'saw.sf2', mimeType: 'application/octet-stream', buffer: Buffer.from(BasicSoundBank.getSampleSoundBankFile()) });
  await page.locator('#bank-status').filter({ hasText: 'sha256' }).waitFor();

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
