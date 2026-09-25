import assert from 'node:assert/strict';

// CI once left Studio on its boot screen with "CANONICAL_NOT_LOADED: Failed to
// fetch dynamically imported module: …/studio/web/model.mjs": the analysis
// Worker's import of its model was refused, and the page never recovered.
// Here the Worker's first request for model.mjs is refused on purpose, in a
// context of its own with the service worker blocked, so the request reaches
// the network, where it can be routed.
export async function runWorkerBootChecks({ browser, base }) {
  const boot = async refuse => {
    const context = await browser.newContext({ serviceWorkers: 'block' });
    let requests = 0;
    await context.route('**/studio/web/model.mjs', route => (refuse(++requests) ? route.abort('failed') : route.continue()));
    const page = await context.newPage();
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.goto(base);
    await page.waitForFunction(() => document.querySelector('#boot')?.className === 'boot-error' || (document.querySelector('#app h1') && document.querySelector('#app')?.getAttribute('aria-busy') === 'false'), null, { timeout: 60000 });
    const seen = await page.evaluate(() => ({ boot_error: document.querySelector('#boot')?.className === 'boot-error', boot: document.querySelector('#boot')?.textContent, app_hidden: document.querySelector('#app')?.hidden }));
    await context.close();
    return { ...seen, requests, errors };
  };

  // One refused request: the next Worker fetches the graph again and the page boots.
  const once = await boot(n => n === 1);
  assert.equal(once.boot_error, false, `a Worker that could not fetch its model once is replaced: ${JSON.stringify(once)}`);
  assert.equal(once.app_hidden, false);
  assert.equal(once.requests, 2, 'the replacement fetched model.mjs again');
  assert.deepEqual(once.errors, []);

  // Every request refused: the budget is spent and the page says why, instead
  // of waiting or retrying forever.
  const always = await boot(() => true);
  assert.equal(always.boot_error, true);
  assert.match(always.boot, /^CANONICAL_NOT_LOADED: /, 'the boot error names the load failure, not a generic one');
  assert.equal(always.requests, 4, 'the first Worker and three replacements, then no more');
}
