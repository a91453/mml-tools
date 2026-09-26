import assert from 'node:assert/strict';
import { toMml, toMmi } from '../web/workshop/mml-out.mjs';

// A 3MLE .mml and an .mmi picked through the ordinary source picker (the
// bytes-sniffing path in app.mjs → Worker intake), in a context of its own:
// the file becomes an MML candidate with the file's metadata beside it, and
// nothing is certified by the intake.
export async function runCommunityFormatChecks({ browser, base, profile }) {
  const context = await browser.newContext({ viewport: profile.viewport, isMobile: profile.isMobile, hasTouch: profile.hasTouch, serviceWorkers: 'block', locale: 'zh-TW' });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  const settled = () => page.waitForFunction(() => document.querySelector('#app h1') && document.querySelector('#app')?.getAttribute('aria-busy') === 'false', null, { timeout: 60000 });
  try {
    await page.goto(base);
    await settled();
    const whole = ['t120o4c1', 't120o3e1', 't120o2c1'];
    const pick = async (slot, name, text) => {
      await page.locator(`[data-intake="${slot}"]`).setInputFiles({ name, mimeType: 'application/octet-stream', buffer: Buffer.from(text) });
      await page.waitForFunction(name => document.querySelector('#intake')?.textContent.includes(name), name);
      await settled();
    };
    await pick('candidate', 'song.mml', toMml(whole, { title: '三軌測試', programs: [24, 40, 0], meters: [{ tick: 0, num: 3, den: 4 }] }));
    const card = page.locator('#intake .card').filter({ hasText: 'song.mml' });
    const text = await card.textContent();
    assert.match(text, /MML · 3MLE \.mml/);
    assert.match(text, /Melody: main \(program 24\)/);
    assert.match(text, /檔案宣告拍號 3\/4（未套用/);
    assert.equal(await page.locator('.hero .badge').textContent(), 'CANDIDATE', 'an intake certifies nothing');
    assert.equal(await card.locator('[data-listen-asset]').count(), 1, 'the MML read out of the file can be listened to');
    assert.equal(await card.locator('.workshop-link').count(), 1, 'and opened in the Workshop as a copy');
    await pick('baseline', 'song.mmi', toMmi(whole, { title: 'mmi', programs: [0, 0, 0] }));
    assert.match(await page.locator('#intake .card').filter({ hasText: 'song.mmi' }).textContent(), /MML · \.mmi/);
    // More tracks than six role slots: refused, with the reason on screen.
    await page.locator('[data-intake="previous"]').setInputFiles({ name: 'seven.mml', mimeType: 'application/octet-stream', buffer: Buffer.from(toMml(['o4c', 'o4d', 'o4e', 'o4f', 'o4g', 'o4a', 'o4b'])) });
    await page.waitForFunction(() => /UNSUPPORTED: .*does not drop tracks/.test(document.querySelector('#message')?.textContent ?? ''));
    await settled();
    assert.equal(await page.locator('#intake .card').filter({ hasText: 'seven.mml' }).count(), 0);
    assert.deepEqual(errors, []);
  } finally {
    await context.close();
  }
}
