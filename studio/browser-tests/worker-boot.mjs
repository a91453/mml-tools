import assert from 'node:assert/strict';

// CI once left Studio on its boot screen with "CANONICAL_NOT_LOADED: Failed to
// fetch dynamically imported module: …/studio/web/model.mjs": the analysis
// Worker's import of its model was refused, and the page never recovered.
// Here requests of the Worker's module graph are refused or altered on
// purpose, each boot in a context of its own. The service worker is blocked so
// that its install-time precache fetches of the same modules do not reach the
// route, and the counts below are the analysis Workers' own requests.
export async function runWorkerBootChecks({ browser, base }) {
  const boot = async (pattern, handle) => {
    const context = await browser.newContext({ serviceWorkers: 'block' });
    let requests = 0;
    await context.route(pattern, route => handle(route, ++requests));
    const page = await context.newPage();
    let workers = 0;
    page.on('worker', worker => { if (new URL(worker.url()).pathname === '/studio/web/worker.mjs') workers++; });
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.goto(base);
    await page.waitForFunction(() => document.querySelector('#boot')?.className === 'boot-error' || (document.querySelector('#app h1') && document.querySelector('#app')?.getAttribute('aria-busy') === 'false'), null, { timeout: 60000 });
    const seen = await page.evaluate(() => ({ boot_error: document.querySelector('#boot')?.className === 'boot-error', boot: document.querySelector('#boot')?.textContent, app_hidden: document.querySelector('#app')?.hidden }));
    await context.close();
    return { ...seen, requests, workers, errors };
  };
  const refuse = when => (route, n) => (when(n) ? route.abort('failed') : route.continue());

  // A module the Worker imports dynamically, refused once: the Worker answers
  // that a replacement may succeed, the next one fetches the graph again, and
  // the page boots.
  const once = await boot('**/studio/web/model.mjs', refuse(n => n === 1));
  assert.equal(once.boot_error, false, `a Worker that could not fetch its model once is replaced: ${JSON.stringify(once)}`);
  assert.equal(once.app_hidden, false);
  assert.equal(once.requests, 2, 'the replacement fetched model.mjs again');
  assert.equal(once.workers, 2);
  assert.deepEqual(once.errors, []);

  // Every request refused: the budget is spent and the page says why, instead
  // of waiting or retrying forever.
  const always = await boot('**/studio/web/model.mjs', refuse(() => true));
  assert.equal(always.boot_error, true);
  assert.match(always.boot, /^CANONICAL_NOT_LOADED: /, 'the boot error names the load failure, not a generic one');
  assert.equal(always.requests, 4, 'the first Worker and three replacements, then no more');

  // A module the Worker imports statically, refused once: that Worker fails to
  // start (onerror), and boot asks the replacement again.
  const staticOnce = await boot('**/studio/web/canonical-package.mjs', refuse(n => n === 1));
  assert.equal(staticOnce.boot_error, false, `a Worker whose own script could not be fetched once is replaced and asked again: ${JSON.stringify(staticOnce)}`);
  assert.equal(staticOnce.requests, 2);
  assert.equal(staticOnce.workers, 2);
  assert.deepEqual(staticOnce.errors, []);
  const staticAlways = await boot('**/studio/web/canonical-package.mjs', refuse(() => true));
  assert.equal(staticAlways.boot_error, true);
  assert.match(staticAlways.boot, /反覆失敗/, `the spent budget is named: ${staticAlways.boot}`);
  assert.equal(staticAlways.workers, 4, 'boot stops asking once the budget is spent');

  // What a new Worker cannot fix is not retried: a model that fetched but does
  // not parse, and a Canonical package whose digest does not verify, each end
  // boot on the first Worker.
  const parse = await boot('**/studio/web/model.mjs', route => route.fulfill({ status: 200, contentType: 'text/javascript', body: 'export const = ;' }));
  assert.equal(parse.workers, 1, `a model that fetched but does not parse is not retried: ${JSON.stringify(parse)}`);
  assert.match(parse.boot, /^CANONICAL_NOT_LOADED: /);
  const published = await (await fetch(`${base}/studio/web/published.mjs`)).text();
  const tampered = published.replace(/(canonicalDigest = ')([0-9a-f])/, (_, head, first) => head + (first === '0' ? '1' : '0'));
  assert.notEqual(tampered, published);
  const verify = await boot('**/studio/web/published.mjs', route => route.fulfill({ status: 200, contentType: 'text/javascript', body: tampered }));
  assert.equal(verify.workers, 1, `a package that fails verification is not retried: ${JSON.stringify(verify)}`);
  assert.match(verify.boot, /^CANONICAL_NOT_LOADED: /);
}
