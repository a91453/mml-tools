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
//     only, leaving the Studio tab stale.
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

    assert.deepEqual(errors, []);
  } finally {
    await context?.close();
    if (server?.listening) { server.closeAllConnections(); await new Promise(done => server.close(done)); }
    await rm(dir, { recursive: true, force: true });
  }
}
