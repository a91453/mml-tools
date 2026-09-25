import assert from 'node:assert/strict';
import zlib from 'node:zlib';
import { encodeListenLink } from '../web/listen-link.mjs';

// CI once left Studio on its boot screen with "CANONICAL_NOT_LOADED: Failed to
// fetch dynamically imported module: …/studio/web/model.mjs": the analysis
// Worker's import of its model was refused, and the page never recovered.
// Here requests of the Worker's module graph are refused or altered on
// purpose, each boot in a context of its own. The service worker is blocked so
// that its install-time precache fetches of the same modules do not reach the
// route, and the counts below are the analysis Workers' own requests.
export async function runWorkerBootChecks({ browser, base }) {
  // With a listen link, boot and the session the link opens are both awaited,
  // and every status line the page showed is recorded (a later line, or the
  // timeout, may replace one).
  const boot = async (pattern, handle, { listen = null } = {}) => {
    const context = await browser.newContext({ serviceWorkers: 'block' });
    let requests = 0;
    await context.route(pattern, route => handle(route, ++requests));
    const page = await context.newPage();
    let workers = 0;
    page.on('worker', worker => { if (new URL(worker.url()).pathname === '/studio/web/worker.mjs') workers++; });
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    if (listen) {
      await page.addInitScript(() => {
        window.messages = [];
        new MutationObserver(() => { const text = document.querySelector('#message')?.textContent; if (text && window.messages.at(-1) !== text) window.messages.push(text); }).observe(document, { subtree: true, childList: true, characterData: true });
      });
    }
    await page.goto(listen ? `${base}/?listen=${listen}` : base);
    await page.waitForFunction(() => document.querySelector('#boot')?.className === 'boot-error' || (document.querySelector('#app h1') && document.querySelector('#app')?.getAttribute('aria-busy') === 'false'), null, { timeout: 60000 });
    if (listen) await page.waitForFunction(() => { const root = document.querySelector('#listening'); return root && !root.hidden && !root.textContent.includes('正在讀取試聽內容') && (root.querySelector('#listen-head') || root.querySelector('.empty')); }, null, { timeout: 60000 });
    const seen = await page.evaluate(() => ({
      boot_error: document.querySelector('#boot')?.className === 'boot-error', boot: document.querySelector('#boot')?.textContent, app_hidden: document.querySelector('#app')?.hidden,
      ...(document.querySelector('#listening')?.hidden === false ? {
        listen_title: document.querySelector('#listen-head h3')?.textContent ?? null, listen_error: document.querySelector('#listening .empty')?.textContent ?? null,
        listen_sessions: (select => (select.disabled ? 0 : select.options.length))(document.querySelector('#listen-session-select')), messages: window.messages,
      } : {}),
    }));
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

  // A listen link opened on a fresh load. The listen model is imported on the
  // Worker's first listening request rather than at boot, so a failed fetch of
  // it used to fail that session and every later one until a reload.
  const listen = await encodeListenLink({ schema: 'mml-studio/listen-link@1', mml: 'MML@t120o4l4cdef,,,,,;', title: 'Worker 載入試聽' }, { deflateRaw: bytes => new Uint8Array(zlib.deflateRawSync(bytes)) });
  const opened = '已從試聽連結建立新的試聽工作階段；按「播放」才會發出聲音。沒有建立或覆寫任何專案。';
  const listenOnce = await boot('**/studio/web/listen-model.mjs', refuse(n => n === 1), { listen });
  assert.equal(listenOnce.listen_title, 'Worker 載入試聽', `a Worker that could not fetch the listen model once is replaced and the session opens: ${JSON.stringify(listenOnce)}`);
  assert.ok(listenOnce.messages.includes(opened));
  assert.equal(listenOnce.requests, 2, 'the replacement fetched listen-model.mjs again');
  assert.equal(listenOnce.workers, 2);
  assert.equal(listenOnce.boot_error, false);
  assert.deepEqual(listenOnce.errors, []);
}
