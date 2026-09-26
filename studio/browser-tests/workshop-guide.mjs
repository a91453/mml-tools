import assert from 'node:assert/strict';
import en from '../web/workshop/guide/i18n/en.mjs';

// The Workshop's help pages in a real browser: reachable from the About
// panel, drawn in the shared language and theme before they are shown, the
// article swapped for its translation, the language switch on the page, and
// no console error or CSP violation on any of the seven.
const PAGES = ['editor', 'reference', 'keys', 'mobile', 'mml', 'midi', 'faq'];
const h1Of = html => /<h1[^>]*>([\s\S]*?)<\/h1>/.exec(html)[1].replace(/<[^>]+>/g, '').trim();

export async function runWorkshopGuideChecks({ browser, base, profile }) {
  const context = await browser.newContext({ viewport: profile.viewport, isMobile: profile.isMobile, hasTouch: profile.hasTouch, serviceWorkers: 'block', locale: 'zh-TW', colorScheme: 'dark' });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
  const shown = () => page.waitForFunction(() => !document.documentElement.hasAttribute('data-i18n-pending'));
  try {
    for (const name of PAGES) {
      await page.goto(`${base}/studio/web/workshop/guide/${name}.html`);
      await shown();
      assert.equal(await page.evaluate(() => document.documentElement.lang), 'zh-Hant');
      assert.equal(await page.locator('.guide-nav [aria-current="page"]').getAttribute('href'), `./${name}.html`);
      assert.match(await page.title(), / · 工作坊說明$/);
      assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), `${name}: no horizontal overflow`);
    }
    // Reached from the Workshop's About panel.
    await page.goto(`${base}/studio/web/workshop/index.html`);
    if (await page.locator('#navToggle').isVisible()) await page.locator('#navToggle').click();
    await page.locator('#aboutBtn').click();
    await Promise.all([page.waitForURL(/guide\/keys\.html$/), page.locator('#aboutPanel a[href="./guide/keys.html"]').click()]);
    await shown();
    // The language switch on the page, stored in the shared preference.
    await Promise.all([page.waitForEvent('load'), page.locator('#guideLang').selectOption('en')]);
    await shown();
    assert.equal(await page.evaluate(() => document.documentElement.lang), 'en');
    assert.equal(await page.locator('#guide h1').textContent(), h1Of(en.keys));
    assert.equal(await page.evaluate(() => JSON.parse(localStorage.getItem('studio-workshop/ui')).lang), 'en');
    // The theme the Workshop and Studio share: light here too.
    await page.evaluate(() => localStorage.setItem('studio-workshop/ui', JSON.stringify({ ...JSON.parse(localStorage.getItem('studio-workshop/ui')), theme: 'light' })));
    await page.goto(`${base}/studio/web/workshop/guide/mml.html`);
    await shown();
    assert.equal(await page.evaluate(() => document.documentElement.dataset.theme), 'light');
    assert.equal(await page.locator('#guide h1').textContent(), h1Of(en.mml));
    assert.ok(await page.locator('#guide .workshop-only').count() > 0, 'the Workshop-only boxes survive translation');
    await page.evaluate(() => localStorage.setItem('studio-workshop/ui', JSON.stringify({ lang: 'zh-Hant' })));
    assert.deepEqual(errors, []);
  } finally {
    await context.close();
  }
}
