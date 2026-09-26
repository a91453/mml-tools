import assert from 'node:assert/strict';

// Studio main page light/dark theme (boot.js, ui-prefs.mjs), in a context of
// its own with a dark-preferring, Japanese-language browser: the page follows
// the system before first paint, switches in place, keeps a chosen theme
// across a reload, follows the system live when asked to, shares the theme
// with the Workshop, and, like the Workshop, stays zh-Hant in a Japanese browser.
export async function runStudioThemeChecks({ browser, base, profile }) {
  const context = await browser.newContext({ viewport: profile.viewport, isMobile: profile.isMobile, hasTouch: profile.hasTouch, serviceWorkers: 'block', locale: 'ja-JP', colorScheme: 'dark' });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  const settled = () => page.waitForFunction(() => document.querySelector('#app h1') && document.querySelector('#app')?.getAttribute('aria-busy') === 'false', null, { timeout: 60000 });
  const theme = () => page.evaluate(() => document.documentElement.dataset.theme);
  const background = () => page.evaluate(() => getComputedStyle(document.documentElement).backgroundColor);
  const stored = () => page.evaluate(() => JSON.parse(localStorage.getItem('studio-workshop/ui') || '{}'));
  try {
    // Painted dark before any module ran.
    await page.addInitScript(() => { window.firstPaintTheme = null; document.addEventListener('DOMContentLoaded', () => { window.firstPaintTheme = document.documentElement.dataset.theme; }, { once: true }); });
    await page.goto(base);
    await settled();
    assert.equal(await page.evaluate(() => window.firstPaintTheme), 'dark', 'the system theme is applied before the page is drawn');
    assert.equal(await page.locator('#theme').inputValue(), 'system');
    assert.equal(await page.evaluate(() => document.documentElement.lang), 'zh-Hant', 'a Japanese browser still gets the zh-Hant page');
    assert.equal(await page.evaluate(() => document.querySelector('meta[name="theme-color"]').content), '#0b1a1f');
    const dark = await background();

    // Switched in place, and kept across a reload.
    await page.evaluate(() => { window.sameDocument = true; });
    await page.locator('#theme').selectOption('light');
    assert.equal(await theme(), 'light');
    assert.equal(await page.evaluate(() => window.sameDocument), true, 'no reload');
    assert.notEqual(await background(), dark, 'the theme changes the page background');
    assert.equal(await page.evaluate(() => document.querySelector('meta[name="theme-color"]').content), '#122a32');
    assert.equal((await stored()).theme, 'light');
    await page.reload();
    await settled();
    assert.equal(await theme(), 'light');
    assert.equal(await page.locator('#theme').inputValue(), 'light');

    // "Follow the system" forgets the stored theme and follows it live.
    await page.locator('#theme').selectOption('system');
    assert.equal((await stored()).theme, undefined);
    assert.equal(await theme(), 'dark');
    await page.emulateMedia({ colorScheme: 'light' });
    await page.waitForFunction(() => document.documentElement.dataset.theme === 'light');
    await page.emulateMedia({ colorScheme: 'dark' });
    await page.waitForFunction(() => document.documentElement.dataset.theme === 'dark');
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), 'no horizontal overflow');

    // One theme for Studio and the Workshop, both zh-Hant.
    await page.locator('#theme').selectOption('light');
    const workshop = await context.newPage();
    workshop.on('pageerror', error => errors.push(`workshop: ${error.message}`));
    await workshop.goto(`${base}/studio/web/workshop/index.html`);
    await workshop.locator('#unverified').waitFor();
    assert.equal(await workshop.evaluate(() => document.documentElement.lang), 'zh-Hant', 'a Japanese browser still gets the zh-Hant Workshop');
    assert.equal(await workshop.evaluate(() => document.documentElement.dataset.theme), 'light', 'the Workshop opens in the theme chosen in Studio');
    await workshop.evaluate(() => localStorage.setItem('studio-workshop/ui', JSON.stringify({ ...JSON.parse(localStorage.getItem('studio-workshop/ui')), theme: 'dark', lang: 'ko' })));
    await workshop.close();
    // A theme chosen on the other page reaches this one without a reload.
    await page.waitForFunction(() => document.documentElement.dataset.theme === 'dark');
    assert.equal(await page.locator('#theme').inputValue(), 'dark');
    await page.reload();
    await settled();
    assert.equal(await theme(), 'dark');
    assert.equal(await page.evaluate(() => document.documentElement.lang), 'zh-Hant', 'a stored language does not change Studio');
    assert.deepEqual(errors, []);
  } finally {
    await context.close();
  }
}
