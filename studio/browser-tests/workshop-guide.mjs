import assert from 'node:assert/strict';

// The Workshop's help pages in a real browser: reachable from the About
// panel, zh-Hant whatever language the Workshop uses (with a line saying only
// the Chinese version exists), drawn in the Workshop's theme, and no console
// error or CSP violation on any of the seven.
const PAGES = ['editor', 'reference', 'keys', 'mobile', 'mml', 'midi', 'faq'];

export async function runWorkshopGuideChecks({ browser, base, profile }) {
  const context = await browser.newContext({ viewport: profile.viewport, isMobile: profile.isMobile, hasTouch: profile.hasTouch, serviceWorkers: 'block', locale: 'zh-TW', colorScheme: 'dark' });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
  const ready = () => page.waitForFunction(() => document.querySelector('.guide-nav [aria-current="page"]'));
  try {
    for (const name of PAGES) {
      await page.goto(`${base}/studio/web/workshop/guide/${name}.html`);
      await ready();
      assert.equal(await page.evaluate(() => document.documentElement.lang), 'zh-Hant');
      assert.equal(await page.locator('.guide-nav [aria-current="page"]').getAttribute('href'), `./${name}.html`);
      assert.match(await page.title(), / · 工作坊說明$/);
      assert.equal(await page.locator('#zhOnly').isVisible(), false, 'no zh-only line for a zh-Hant Workshop');
      assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), `${name}: no horizontal overflow`);
    }
    // Reached from the Workshop's About panel.
    await page.goto(`${base}/studio/web/workshop/index.html`);
    if (await page.locator('#navToggle').isVisible()) await page.locator('#navToggle').click();
    await page.locator('#aboutBtn').click();
    await Promise.all([page.waitForURL(/guide\/keys\.html$/), page.locator('#aboutPanel a[href="./guide/keys.html"]').click()]);
    await ready();
    // A Workshop in English: the page stays zh-Hant and says so; the theme is the Workshop's.
    await page.evaluate(() => localStorage.setItem('studio-workshop/ui', JSON.stringify({ lang: 'en', theme: 'light' })));
    await page.goto(`${base}/studio/web/workshop/guide/mml.html`);
    await ready();
    assert.equal(await page.evaluate(() => document.documentElement.lang), 'zh-Hant');
    assert.equal(await page.locator('#zhOnly').isVisible(), true);
    assert.equal(await page.locator('#zhOnly').textContent(), '目前只有中文版');
    assert.equal(await page.evaluate(() => document.documentElement.dataset.theme), 'light');
    assert.ok(await page.locator('#guide .workshop-only').count() > 0);
    // And the Workshop's own interface is still in English.
    await page.goto(`${base}/studio/web/workshop/index.html`);
    await page.waitForFunction(() => !document.documentElement.hasAttribute('data-i18n-pending'));
    assert.equal(await page.evaluate(() => document.documentElement.lang), 'en');
    await page.evaluate(() => localStorage.setItem('studio-workshop/ui', JSON.stringify({ lang: 'zh-Hant' })));
    assert.deepEqual(errors, []);
  } finally {
    await context.close();
  }
}
