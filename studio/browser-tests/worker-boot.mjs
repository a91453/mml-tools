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
  // and the actions the page posted to its Workers and every status line it
  // showed are recorded (a later line, or the timeout, may replace one), as
  // they are when `then` goes on to use the page that booted.
  const listened = page => page.waitForFunction(() => { const root = document.querySelector('#listening'); return root && !root.hidden && !root.textContent.includes('正在讀取試聽內容') && (root.querySelector('#listen-head') || root.querySelector('.empty')); }, null, { timeout: 60000 });
  const boot = async (pattern, handle, { listen = null, then = null } = {}) => {
    const context = await browser.newContext({ serviceWorkers: 'block' });
    let requests = 0, page = null;
    await context.route(pattern, route => handle(route, ++requests, page));
    page = await context.newPage();
    let workers = 0;
    page.on('worker', worker => { if (new URL(worker.url()).pathname === '/studio/web/worker.mjs') workers++; });
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    if (listen || then) {
      await page.addInitScript(() => {
        const post = Worker.prototype.postMessage;
        window.postedActions = [];
        Worker.prototype.postMessage = function (message, ...rest) { if (message?.action) window.postedActions.push(message.action); return post.call(this, message, ...rest); };
        window.messages = [];
        new MutationObserver(() => { const text = document.querySelector('#message')?.textContent; if (text && window.messages.at(-1) !== text) window.messages.push(text); }).observe(document, { subtree: true, childList: true, characterData: true });
      });
    }
    await page.goto(listen ? `${base}/?listen=${listen}` : base);
    await page.waitForFunction(() => document.querySelector('#boot')?.className === 'boot-error' || (document.querySelector('#app h1') && document.querySelector('#app')?.getAttribute('aria-busy') === 'false'), null, { timeout: 60000 });
    if (listen) await listened(page);
    const after = then ? await then(page, context) : {};
    const seen = await page.evaluate(() => ({
      boot_error: document.querySelector('#boot')?.className === 'boot-error', boot: document.querySelector('#boot')?.textContent, app_hidden: document.querySelector('#app')?.hidden,
      ...(document.querySelector('#listening')?.hidden === false ? {
        listen_title: document.querySelector('#listen-head h3')?.textContent ?? null, listen_error: document.querySelector('#listening .empty')?.textContent ?? null,
        listen_sessions: (select => (select.disabled ? 0 : select.options.length))(document.querySelector('#listen-session-select')), messages: window.messages,
      } : {}),
    }));
    await context.close();
    return { ...seen, ...after, requests, workers, errors };
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

  // A listen link opened on a fresh load. The listen model is imported when
  // the Worker starts, so a failed fetch of it is retried as the model's is.
  // Fetched on the first listening request instead, it used to fail that
  // session and every later one until a reload.
  const listen = await encodeListenLink({ schema: 'mml-studio/listen-link@1', mml: 'MML@t120o4l4cdef,,,,,;', title: 'Worker 載入試聽' }, { deflateRaw: bytes => new Uint8Array(zlib.deflateRawSync(bytes)) });
  const opened = '已從試聽連結建立新的試聽工作階段；按「播放」才會發出聲音。沒有建立或覆寫任何專案。';
  const listenOnce = await boot('**/studio/web/listen-model.mjs', refuse(n => n === 1), { listen });
  assert.equal(listenOnce.listen_title, 'Worker 載入試聽', `a Worker that could not fetch the listen model once is replaced and the session opens: ${JSON.stringify(listenOnce)}`);
  assert.ok(listenOnce.messages.includes(opened));
  assert.equal(listenOnce.requests, 2, 'the replacement fetched listen-model.mjs again');
  assert.equal(listenOnce.workers, 2);
  assert.equal(listenOnce.boot_error, false);
  assert.deepEqual(listenOnce.errors, []);
  // A link opened offline, on a page no service worker controls (a first
  // visit before one takes control, or a browser without them), opens in the
  // Worker that started, and analysis goes on. Were the listen model fetched
  // for the link, that fetch would fail, and so would every replacement's
  // fetch of its own script, spending the budget: analysis would stop too.
  const offline = await boot('**/studio/web/listen-model.mjs', route => route.continue(), { then: async (page, context) => {
    await context.setOffline(true);
    await page.evaluate(payload => { location.hash = `listen=${payload}`; }, listen);
    await listened(page);
    const before = await page.locator('#projects option').count();
    await page.click('#new-project');
    await page.waitForFunction(before => document.querySelectorAll('#projects option').length > before || window.messages.some(text => text.includes('Worker')), before, { timeout: 60000 });
    return { projects: [before, await page.locator('#projects option').count()] };
  } });
  assert.equal(offline.listen_title, 'Worker 載入試聽', `a link opened offline opens in the Worker that started: ${JSON.stringify(offline)}`);
  assert.ok(offline.messages.includes(opened));
  assert.deepEqual(offline.projects, [1, 2], `a new project is analysed offline after the link: ${JSON.stringify(offline)}`);
  assert.equal(offline.requests, 1, 'the listen model was fetched once, when the Worker started');
  assert.equal(offline.workers, 1);
  assert.equal(offline.boot_error, false);
  assert.deepEqual(offline.errors, []);
  // A listen model that fetched but does not parse is not retried, and the
  // page says the link did not open rather than that it did. The session is
  // saved and listed, so it can be opened again.
  const listenParse = await boot('**/studio/web/listen-model.mjs', route => route.fulfill({ status: 200, contentType: 'text/javascript', body: 'export const = ;' }), { listen });
  assert.equal(listenParse.workers, 1, `a listen model that does not parse is not retried: ${JSON.stringify(listenParse)}`);
  assert.equal(listenParse.listen_title, null);
  assert.ok(!listenParse.messages.includes(opened), `the status line never reports a session that opened: ${JSON.stringify(listenParse)}`);
  assert.match(listenParse.listen_error, /^試聽連結無法開啟：/);
  assert.ok(listenParse.messages.includes(listenParse.listen_error), 'the status line reports the failure the panel shows');
  assert.equal(listenParse.listen_sessions, 1);
  assert.equal(listenParse.boot_error, false, 'analysis is unaffected');
  // The first Worker fails to start after the link asked it to parse: the
  // parse is rejected with WORKER_UNAVAILABLE alongside boot's identity, and
  // is asked again of the replacement as identity is.
  const listenStatic = await boot('**/studio/web/canonical-package.mjs', async (route, n, page) => {
    if (n !== 1) return route.continue();
    await page.waitForFunction(() => window.postedActions.includes('parseListening'));
    return route.abort('failed');
  }, { listen });
  assert.equal(listenStatic.listen_title, 'Worker 載入試聽', `a link opened while the first Worker fails to start still opens: ${JSON.stringify(listenStatic)}`);
  assert.ok(listenStatic.messages.includes(opened));
  assert.equal(listenStatic.requests, 2);
  assert.equal(listenStatic.workers, 2);
  assert.equal(listenStatic.boot_error, false);
  assert.deepEqual(listenStatic.errors, []);
}
