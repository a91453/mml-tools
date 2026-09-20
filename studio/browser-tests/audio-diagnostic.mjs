// A generated, private review pack; does not change the service or song gates.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { chromium, webkit } from 'playwright';

const directory = resolve(process.argv[2]);
const report = JSON.parse(await readFile(join(directory, 'diagnostic.json'), 'utf8'));
for (const { name, engine, viewport, isMobile } of [
  { name: 'desktop', engine: chromium, viewport: { width: 1440, height: 1000 }, isMobile: false },
  { name: 'iphone', engine: webkit, viewport: { width: 390, height: 844 }, isMobile: true },
]) {
  const browser = await engine.launch();
  try {
    const page = await browser.newPage({ viewport, isMobile, acceptDownloads: true });
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.goto(pathToFileURL(join(directory, 'review.html')).href);
    assert.equal(await page.locator('tbody tr').count(), report.sections.length);
    await page.waitForFunction(() => document.querySelector('audio').readyState >= 1);
    const duration = await page.locator('audio').evaluate(audio => audio.duration);
    assert.ok(Math.abs(duration - report.audio_duration_seconds) < .1);
    const last = report.sections.at(-1);
    await page.getByRole('button', { name: '播放這段', exact: true }).last().click();
    await page.waitForFunction(start => {
      const audio = document.querySelector('audio');
      return !audio.paused && audio.currentTime >= start;
    }, last.projected_start_seconds);
    await page.waitForFunction(() => document.querySelector('audio').paused, null, { timeout: 10000 });
    await page.locator('textarea').first().fill('TEST ONLY: export/readback; no listening conclusion.');
    const downloadPromise = page.waitForEvent('download');
    await page.getByRole('button', { name: '下載本次段落聽驗紀錄' }).click();
    const download = await downloadPromise;
    const exported = JSON.parse(await readFile(await download.path(), 'utf8'));
    assert.equal(exported.audio_sha256, report.audio_sha256);
    assert.equal(exported.project_sha256, report.project_sha256);
    assert.equal(exported.gate_confirmation, null);
    assert.equal(exported.notes[0].note, 'TEST ONLY: export/readback; no listening conclusion.');
    assert.deepEqual(exported.notes.at(-1).section, last);
    await page.locator('textarea').first().fill('');
    await page.evaluate(() => window.scrollTo(0, 0));
    await page.screenshot({ path: join(directory, `${name}.png`), fullPage: false });
    assert.deepEqual(errors, []);
    console.log(JSON.stringify({ name, status: 'PASS', sections: report.sections.length, duration, mediaPlayback: true, gateConfirmation: null }));
  } finally {
    await browser.close();
  }
}
