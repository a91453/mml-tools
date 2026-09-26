import assert from 'node:assert/strict';
import { cp, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { BasicSoundBank } from 'spessasynth_core';
import { serveStudio } from '../../scripts/serve-studio-web.mjs';
import { watchPage, workshopShown } from './workshop-ready.mjs';

// The Workshop and a new Studio Web release (studio/web/workshop/release.mjs),
// end to end through the real Service Worker. The check serves its own copy of
// the build and publishes each "new release" by renaming the cache in that
// copy's sw.js, which is what a real release changes.
//
//   * a waiting release is offered in the Workshop too, not only in Studio;
//   * applied from a Studio tab, it leaves the open Workshop stale: exporting,
//     opening from and sending to Studio are refused until the Workshop reloads,
//     and the Workshop's button turns into 「重新載入」;
//   * with autosave off and edits not in the library, applying is refused, and
//     nothing reloads; with autosave back on it applies and reloads this tab
//     only, leaving the Studio tab stale;
//   * a failed debounced save is visible and retryable; failure in the final
//     flush prevents both applying a waiting worker and reloading a stale tab.
const build = fileURLToPath(new URL('../web-build/', import.meta.url));
const WORKSHOP = '/studio/web/workshop/index.html';

const log = page => page.locator('#logMsg').textContent();
const clearLog = page => page.evaluate(() => { document.querySelector('#logMsg').textContent = ''; });

export async function runWorkshopUpdateChecks({ browser }) {
  const dir = await mkdtemp(join(tmpdir(), 'studio-release-'));
  let server = null, context = null;
  try {
    await cp(build, dir, { recursive: true });
    const worker = join(dir, 'sw.js');
    let release = 0;
    const publish = async () => {
      release += 1;
      const text = await readFile(worker, 'utf8');
      const next = text.replace(/^const CACHE = '([^']+?)(?:-next\d+)?';/m, `const CACHE = '$1-next${release}';`);
      assert.notEqual(next, text, 'the copied worker names its cache');
      await writeFile(worker, next);
    };
    const ask = page => page.evaluate(async () => (await navigator.serviceWorker.getRegistration()).update());

    server = await serveStudio({ port: 0, root: dir });
    const base = `http://127.0.0.1:${server.address().port}`;
    context = await browser.newContext({ locale: 'zh-TW' });
    const errors = [];

    const studio = await context.newPage();
    studio.on('pageerror', e => errors.push(`studio: ${e.message}`));
    await studio.goto(`${base}/index.html`);
    await studio.evaluate(() => navigator.serviceWorker.ready);
    await studio.waitForFunction(() => navigator.serviceWorker.controller !== null);
    await studio.waitForFunction(() => document.querySelector('#app')?.getAttribute('aria-busy') === 'false');

    const workshop = await context.newPage();
    workshop.on('pageerror', e => errors.push(`workshop: ${e.message}`));
    watchPage(workshop);
    await workshop.goto(`${base}${WORKSHOP}`);
    await workshopShown(workshop);
    await workshop.waitForFunction(() => navigator.serviceWorker.controller !== null);
    assert.equal(await workshop.locator('#pwaUpdate').isHidden(), true, 'no release is offered on a first visit');
    // A bank (SpessaSynth's own one-preset saw wave), so the WAV export can open.
    await workshop.locator('#gear').click();
    await workshop.locator('#dls').setInputFiles({ name: 'saw.sf2', mimeType: 'application/octet-stream', buffer: Buffer.from(BasicSoundBank.getSampleSoundBankFile()) });
    await workshop.waitForFunction(() => document.querySelector('#mixGo')?.disabled === false, null, { timeout: 60000 });
    await workshop.keyboard.press('Escape');

    // ── a new release is offered in the Workshop as well as in Studio ──────
    await publish();
    await ask(workshop);
    await workshop.locator('#pwaUpdate').waitFor({ state: 'visible' });
    assert.equal((await workshop.locator('#pwaUpdate').textContent()).trim(), '套用新版');
    assert.match(await log(workshop), /新版已下載/);
    await ask(studio);
    await studio.locator('#apply-update').waitFor({ state: 'visible' });

    // ── Studio applies it: the Workshop is left on the old modules ─────────
    await Promise.all([studio.waitForEvent('load'), studio.locator('#apply-update').click()]);
    await workshop.waitForFunction(() => document.querySelector('#pwaUpdate span')?.textContent === '重新載入');
    assert.match(await log(workshop), /其他分頁套用新版/);

    await clearLog(workshop);
    await workshop.locator('#file').click();
    await workshop.locator('#mixGo').click();
    await workshop.waitForFunction(() => document.querySelector('#logMsg')?.textContent.includes('其他分頁套用新版'));
    assert.equal(await workshop.locator('#wavBox.on').count(), 0, 'a stale Workshop does not load the WAV exporter');
    await workshop.keyboard.press('Escape');

    await clearLog(workshop);
    await workshop.locator('#studioOpen').click();
    await workshop.waitForFunction(() => document.querySelector('#logMsg')?.textContent.includes('其他分頁套用新版'));
    assert.equal(await workshop.locator('#studioBox.on').count(), 0, 'a stale Workshop does not read Studio projects');
    await clearLog(workshop);
    await workshop.locator('#studioSend').click();
    await workshop.waitForFunction(() => document.querySelector('#logMsg')?.textContent.includes('其他分頁套用新版'));
    assert.equal(await workshop.locator('#studioSendBox.on').count(), 0, 'a stale Workshop does not write into Studio');

    await Promise.all([workshop.waitForEvent('load'), workshop.locator('#pwaUpdate').click()]);
    await workshopShown(workshop);
    assert.equal(await workshop.locator('#pwaUpdate').isHidden(), true, 'the reloaded Workshop runs the current release');

    // ── unsaved edits hold a release back; autosave lets it through ────────
    await studio.waitForFunction(() => document.querySelector('#app')?.getAttribute('aria-busy') === 'false');
    await workshop.locator('#gear').click();
    await workshop.locator('#autosave').selectOption('off');
    await workshop.keyboard.press('Escape');
    await publish();
    await ask(workshop);
    await workshop.locator('#pwaUpdate').waitFor({ state: 'visible' });
    await clearLog(workshop);
    const marker = await workshop.evaluate(() => { window.releaseMarker = Math.random(); return window.releaseMarker; });
    await workshop.locator('#pwaUpdate').click();
    await workshop.waitForFunction(() => document.querySelector('#logMsg')?.textContent.includes('自動暫存已關閉'));
    assert.equal(await workshop.evaluate(() => window.releaseMarker), marker, 'a refused apply does not reload');
    assert.equal(await workshop.evaluate(async () => Boolean((await navigator.serviceWorker.getRegistration()).waiting)), true, 'the release is still waiting');

    await workshop.locator('#gear').click();
    await workshop.locator('#autosave').selectOption('on');
    await workshop.keyboard.press('Escape');
    await ask(studio);
    await studio.locator('#apply-update').waitFor({ state: 'visible' });
    await Promise.all([workshop.waitForEvent('load'), workshop.locator('#pwaUpdate').click()]);
    await workshopShown(workshop);
    assert.equal(await workshop.locator('#pwaUpdate').isHidden(), true);
    await studio.waitForFunction(() => document.querySelector('#message')?.textContent.includes('其他分頁套用新版'));
    assert.equal(await studio.locator('#apply-update').isHidden(), true, 'the Studio tab is stale, not offered the release again');

    // ── quota failure is visible, and retry needs no further edit ──────────
    const denyScoreWrites = async (editAndUpdate = null) => workshop.evaluate(text => {
      window.auditSetItem = Storage.prototype.setItem;
      Storage.prototype.setItem = function (key, value) {
        if (key === 'studio-workshop/score') throw new DOMException('Synthetic storage full', 'QuotaExceededError');
        return window.auditSetItem.call(this, key, value);
      };
      // Edit and click in the same task: the debounce timer cannot fire before
      // the update handler. This proves the last flush, not an earlier check.
      if (text !== null) {
        const area = document.querySelector('.pane textarea');
        area.value = text;
        area.dispatchEvent(new Event('input', { bubbles: true }));
        document.querySelector('#pwaUpdate').click();
      }
    }, editAndUpdate);
    const allowScoreWrites = () => workshop.evaluate(() => {
      Storage.prototype.setItem = window.auditSetItem;
      delete window.auditSetItem;
    });
    const storedText = () => workshop.evaluate(() => JSON.parse(localStorage.getItem('studio-workshop/score')).texts[0]);
    const editor = workshop.locator('.pane textarea').first();
    await editor.fill('t120o4c1');
    await workshop.evaluate(() => import('./storage.mjs').then(storage => storage.flush()));
    await denyScoreWrites();
    await editor.fill('t120o4d1');
    await workshop.locator('#storeState').filter({ hasText: '暫存失敗' }).waitFor();
    assert.equal(await storedText(), 't120o4c1', 'a failed save leaves the last saved score intact');
    assert.equal(await editor.inputValue(), 't120o4d1', 'the current edit remains in memory');
    assert.ok(await workshop.locator('#storeRetry').isVisible());
    assert.match(await log(workshop), /暫存失敗/);
    const viewport = workshop.viewportSize();
    await workshop.setViewportSize({ width: 390, height: 844 });
    await editor.focus();
    assert.ok(await workshop.locator('body.kbd').count(), 'the narrow editor hides ordinary status while typing');
    assert.ok(await workshop.locator('#storeState').isVisible(), 'a save failure stays visible while typing on a narrow screen');
    const retryBox = await workshop.locator('#storeRetry').boundingBox();
    assert.ok(retryBox && retryBox.x >= 0 && retryBox.x + retryBox.width <= 390, 'the retry control fits on a narrow screen');
    await workshop.locator('#viewStatus').click();
    assert.ok(await workshop.locator('body.no-status').count());
    assert.ok(await workshop.locator('#storeRetry').isVisible(), 'collapsing status cannot hide recovery from a save failure');
    await allowScoreWrites();
    await workshop.locator('#storeRetry').click();
    assert.equal(await storedText(), 't120o4d1', 'retry writes the pending edit without typing it again');
    assert.match(await workshop.locator('#storeState').textContent(), /已暫存/);
    assert.equal(await workshop.locator('#storeRetry').isHidden(), true);
    await workshop.locator('#status').waitFor({ state: 'hidden' });
    await workshop.locator('#viewStatus').click();
    await workshop.setViewportSize(viewport);

    // ── a first failure in the apply flush holds the pending release back ──
    await publish();
    await ask(workshop);
    await workshop.locator('#pwaUpdate').waitFor({ state: 'visible' });
    await denyScoreWrites('t120o4e1');
    await workshop.locator('#logMsg').filter({ hasText: '已停止重新載入' }).waitFor();
    assert.equal(await editor.inputValue(), 't120o4e1');
    assert.equal(await storedText(), 't120o4d1');
    assert.equal(await workshop.evaluate(async () => Boolean((await navigator.serviceWorker.getRegistration()).waiting)), true,
      'a failed final write does not activate the waiting release');
    await allowScoreWrites();
    // Applying again retries the retained queue before checking whether it is
    // safe to leave. No intervening edit or separate retry button is needed.
    await Promise.all([workshop.waitForEvent('load'), workshop.locator('#pwaUpdate').click()]);
    await workshopShown(workshop);
    assert.equal(await editor.inputValue(), 't120o4e1', 'the new release restores the edit the retry saved');

    // ── the same last-write failure also holds a stale-tab reload back ─────
    await studio.reload();
    await studio.waitForFunction(() => document.querySelector('#app')?.getAttribute('aria-busy') === 'false');
    await publish();
    await ask(studio);
    await studio.locator('#apply-update').waitFor({ state: 'visible' });
    await Promise.all([studio.waitForEvent('load'), studio.locator('#apply-update').click()]);
    await workshop.waitForFunction(() => document.querySelector('#pwaUpdate span')?.textContent === '重新載入');
    await denyScoreWrites('t120o4g1');
    await workshop.locator('#logMsg').filter({ hasText: '已停止重新載入' }).waitFor();
    assert.equal(await editor.inputValue(), 't120o4g1');
    assert.equal(await storedText(), 't120o4e1');
    assert.equal(await workshop.evaluate(() => import('./release.mjs').then(release => release.isStale())), true);
    await allowScoreWrites();
    await Promise.all([workshop.waitForEvent('load'), workshop.locator('#pwaUpdate').click()]);
    await workshopShown(workshop);
    assert.equal(await editor.inputValue(), 't120o4g1', 'the reloaded stale tab restores the last edit');

    assert.deepEqual(errors, []);
  } finally {
    await context?.close();
    if (server?.listening) { server.closeAllConnections(); await new Promise(done => server.close(done)); }
    await rm(dir, { recursive: true, force: true });
  }
}
