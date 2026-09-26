import assert from 'node:assert/strict';
import zhHant from '../web/i18n/zh-Hant.mjs';
import en from '../web/i18n/en.mjs';
import ja from '../web/i18n/ja.mjs';

// Studio main page: four languages and a light/dark theme (boot.js,
// i18n.mjs, ui-prefs.mjs). In a context of its own, with an English browser:
// the page follows the browser language before first paint, switches language
// and theme in place (no reload), keeps both across a reload, shares them
// with the Workshop, and never translates a status code.
const CJK = /[぀-ヿ㐀-鿿가-힯]/;

export async function runStudioI18nChecks({ browser, base, profile }) {
  const context = await browser.newContext({ viewport: profile.viewport, isMobile: profile.isMobile, hasTouch: profile.hasTouch, serviceWorkers: 'block', locale: 'en-US', colorScheme: 'light' });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  const settled = () => page.waitForFunction(() => document.querySelector('#app h1') && document.querySelector('#app')?.getAttribute('aria-busy') === 'false', null, { timeout: 60000 });
  const heading = () => page.locator('#intake h2').textContent();
  const background = () => page.evaluate(() => getComputedStyle(document.documentElement).backgroundColor);
  const stored = () => page.evaluate(() => JSON.parse(localStorage.getItem('studio-workshop/ui') || '{}'));
  try {
    await page.goto(base);
    await settled();
    // Chosen before first paint from the browser language.
    assert.equal(await page.evaluate(() => document.documentElement.lang), 'en');
    assert.equal(await page.evaluate(() => document.documentElement.hasAttribute('data-i18n-pending')), false, 'the page is shown once translated');
    assert.equal(await heading(), `01　${en['intake.title']}`);
    assert.equal(await page.locator('#new-project').textContent(), en['side.newProject']);
    assert.equal(await page.title(), en['page.title']);
    // The sidebar and every section heading are English; codes stay codes.
    const aside = await page.evaluate(() => { const a = document.querySelector('aside').cloneNode(true); a.querySelector('#lang')?.remove(); a.querySelector('#projects')?.remove(); return a.textContent; });
    assert.doesNotMatch(aside, CJK, 'no zh-Hant left in the sidebar');
    for (const text of await page.locator('#main h2').allTextContents()) assert.doesNotMatch(text, CJK, `heading "${text}"`);
    assert.equal(await page.locator('.hero .badge').textContent(), 'CANDIDATE', 'the state badge is the code itself');
    assert.equal(await page.evaluate(() => document.documentElement.dataset.theme), 'light', 'a light system gives the light theme');

    // Language switch in place: the same document, re-rendered.
    await page.evaluate(() => { window.sameDocument = true; });
    await page.locator('#lang').selectOption('ja');
    await page.waitForFunction(text => document.querySelector('#intake h2')?.textContent === text, `01　${ja['intake.title']}`);
    assert.equal(await page.evaluate(() => window.sameDocument), true, 'no reload');
    assert.equal(await page.evaluate(() => document.documentElement.lang), 'ja');
    assert.equal(await page.locator('#new-project').textContent(), ja['side.newProject']);
    assert.equal(await page.locator('.hero .badge').textContent(), 'CANDIDATE');

    // Theme switch in place, and both kept across a reload.
    const light = await background();
    await page.locator('#theme').selectOption('dark');
    assert.equal(await page.evaluate(() => document.documentElement.dataset.theme), 'dark');
    const dark = await background();
    assert.notEqual(dark, light, 'the dark theme changes the page background');
    assert.equal(await page.evaluate(() => document.querySelector('meta[name="theme-color"]').content), '#0b1a1f');
    assert.deepEqual({ lang: (await stored()).lang, theme: (await stored()).theme }, { lang: 'ja', theme: 'dark' });
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), 'no horizontal overflow in Japanese');
    await page.reload();
    await settled();
    assert.equal(await page.evaluate(() => document.documentElement.lang), 'ja');
    assert.equal(await page.evaluate(() => document.documentElement.dataset.theme), 'dark');
    assert.equal(await page.locator('#theme').inputValue(), 'dark');
    assert.equal(await heading(), `01　${ja['intake.title']}`);

    // "Follow the system" forgets the stored theme and follows the system live.
    await page.locator('#theme').selectOption('system');
    assert.equal((await stored()).theme, undefined);
    assert.equal(await page.evaluate(() => document.documentElement.dataset.theme), 'light');
    await page.emulateMedia({ colorScheme: 'dark' });
    await page.waitForFunction(() => document.documentElement.dataset.theme === 'dark');
    await page.emulateMedia({ colorScheme: 'light' });
    await page.waitForFunction(() => document.documentElement.dataset.theme === 'light');

    // One preference for Studio and the Workshop.
    await page.locator('#theme').selectOption('dark');
    const workshop = await context.newPage();
    workshop.on('pageerror', error => errors.push(`workshop: ${error.message}`));
    await workshop.goto(`${base}/studio/web/workshop/index.html`);
    await workshop.waitForFunction(() => !document.documentElement.hasAttribute('data-i18n-pending'));
    assert.equal(await workshop.evaluate(() => document.documentElement.lang), 'ja', 'the Workshop opens in the language chosen in Studio');
    assert.equal(await workshop.evaluate(() => document.documentElement.dataset.theme ?? 'dark'), 'dark', 'and in its theme');
    await workshop.close();

    // Back to zh-Hant, the page's own language.
    await page.locator('#lang').selectOption('zh-Hant');
    await page.waitForFunction(text => document.querySelector('#intake h2')?.textContent === text, `01　${zhHant['intake.title']}`);
    assert.equal(await page.evaluate(() => document.documentElement.lang), 'zh-Hant');
    assert.deepEqual(errors, []);
  } finally {
    await context.close();
  }
}
