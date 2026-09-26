import assert from 'node:assert/strict';
import { watchPage, workshopShown } from './workshop-ready.mjs';

// The Workshop's Studio source label follows the score on screen. A copy
// opened from Studio project A names A (and survives a reload); opening an
// unrelated song B from the Workshop's own library afterwards drops that
// label, its stored record, and A as the target Studio preselects on the way
// back -- B never came from A. A later reload does not bring A back.
const ORIGIN_KEY = 'studio-workshop/origin';
const WORKSHOP = '/studio/web/workshop/index.html';

export async function runWorkshopOriginChecks({ browser, base, profile }) {
  const context = await browser.newContext({ viewport: profile.viewport, isMobile: profile.isMobile, hasTouch: profile.hasTouch, serviceWorkers: 'block', locale: 'zh-TW' });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  watchPage(page);
  const press = locator => (profile.hasTouch ? locator.tap() : locator.click());
  const command = async id => {
    const toggle = page.locator('#navToggle');
    if (await toggle.isVisible()) { await press(toggle); await page.locator('#navMenu').waitFor(); }
    await press(page.locator(id));
  };
  const idle = () => page.waitForFunction(() => document.querySelector('#app')?.getAttribute('aria-busy') !== 'true' && document.querySelector('#app h1'));
  const firstTrack = () => page.evaluate(() => document.querySelector('.pane textarea')?.value.replace(/\s+/g, '') ?? null);
  const stored = () => page.evaluate(key => localStorage.getItem(key), ORIGIN_KEY);
  const chip = () => page.locator('#studioOrigin');
  const nameProject = async title => {
    await page.getByLabel('專案／歌曲名稱', { exact: true }).fill(title);
    await page.locator('#settings button').click(); await idle();
    await page.waitForFunction(title => document.querySelector('#app h1')?.textContent.includes(title), title);
  };
  // Reload only once the score is in autosave, so the reload reads B.
  const settledReload = async () => {
    await page.locator('#storeState').filter({ hasText: '已暫存' }).waitFor();
    await page.reload();
    await workshopShown(page);
  };
  try {
    // ── Studio project A, opened in the Workshop as a copy ───────────────────
    await page.goto(base); await page.locator('#app h1').waitFor(); await idle();
    await page.locator('#new-project').click(); await idle();
    await nameProject('Origin project A');
    await page.locator('[data-intake="candidate"]').setInputFiles({ name: 'origin-a.mml', mimeType: 'text/plain', buffer: Buffer.from('MML@t120o4l4cdec,,,,,;') });
    await page.waitForFunction(() => document.querySelector('#intake')?.textContent.includes('origin-a.mml')); await idle();
    const href = await page.locator('#intake a.workshop-link').first().getAttribute('href');
    const projectId = new URLSearchParams(href.split('#')[1]).get('studio-project');
    // A newer project Z is what Studio opens by itself, so the target it
    // preselects for the return below says whether A leaked into it.
    await page.locator('#new-project').click(); await idle();
    await nameProject('Origin project Z');
    await page.goto(new URL(href, page.url()).href);
    await workshopShown(page);
    await page.waitForFunction(() => document.querySelector('.pane textarea')?.value.replace(/\s+/g, '') === 't120o4l4cdec');
    assert.equal(await chip().isVisible(), true, 'the Studio copy names its source');
    assert.match(await page.locator('#studioOriginText').textContent(), /Origin project A/);
    assert.equal(JSON.parse(await stored())?.projectId, projectId);
    await settledReload();
    assert.equal(await chip().isVisible(), true, 'the Studio copy keeps its source over a reload');
    assert.equal(await firstTrack(), 't120o4l4cdec');

    // ── an unrelated song B in the Workshop library ──────────────────────────
    await page.evaluate(async () => {
      const library = await import('./library.mjs');
      const snapshot = library.fromSnapshot({ count: 1, active: 0, texts: ['t120o5l4gfe'], presets: [], zip: [] }, [], [], []);
      const now = Date.now();
      await library.write({ name: 'Library song B', createdMs: now, updatedMs: now, tracks: 1, notes: 3, bytes: library.snapshotBytes(snapshot) }, snapshot);
    });
    await command('#file');
    await page.locator('#fileBox.on').waitFor();
    await press(page.locator('#saveOpen'));
    const row = page.locator('#saveRows tr[data-name="Library song B"]');
    await row.waitFor();
    await press(row.locator('td.ops button').first());
    await page.waitForFunction(() => document.querySelector('.pane textarea')?.value.replace(/\s+/g, '') === 't120o5l4gfe');
    assert.equal(await chip().isVisible(), false, 'a library song is not labelled with the previous Studio project');
    assert.equal(await stored(), null, 'the previous Studio source is not kept for a library song');
    await settledReload();
    assert.equal(await firstTrack(), 't120o5l4gfe');
    assert.equal(await chip().isVisible(), false, 'a reload does not bring the previous Studio source back');
    assert.equal(await stored(), null);

    // ── sent back, Studio neither names nor preselects A ─────────────────────
    await command('#studioSend');
    await page.locator('#studioSendBox.on').waitFor();
    await Promise.all([page.waitForURL(url => new URL(url).pathname !== WORKSHOP), page.locator('#studioSendGo').click()]);
    const panel = page.locator('#workshop-return');
    await panel.locator('#workshop-import').waitFor();
    assert.match(await panel.textContent(), /來源：工作坊（非 Studio 副本）/, 'Studio is told the song is not a Studio copy');
    assert.doesNotMatch(await panel.textContent(), /Origin project A/, 'Studio neither names nor preselects project A');
    assert.match(await panel.locator('#workshop-import').textContent(), /Origin project Z/);
    assert.deepEqual(errors, []);
  } finally {
    await context.close();
  }
}
