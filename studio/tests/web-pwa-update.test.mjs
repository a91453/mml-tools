import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createUpdateFlow } from '../web/pwa-update.mjs';

class Emitter {
  constructor() { this.listeners = {}; }
  addEventListener(type, fn) { (this.listeners[type] ??= []).push(fn); }
  emit(type) { for (const fn of this.listeners[type] ?? []) fn(); }
}
class FakeWorker extends Emitter {
  constructor(state) { super(); this.state = state; this.messages = []; }
  postMessage(value) { this.messages.push(value); }
  become(state) { this.state = state; this.emit('statechange'); }
}
function harness({ controlled = true, clock = { t: 0 } } = {}) {
  const serviceWorker = new Emitter();
  serviceWorker.controller = controlled ? {} : null;
  const log = [];
  const flow = createUpdateFlow({
    serviceWorker,
    now: () => clock.t,
    reload: () => log.push('reload'),
    onDownloading: () => log.push('downloading'),
    onOffer: () => log.push('offer'),
    onStale: () => log.push('stale'),
  });
  const reg = new Emitter();
  reg.waiting = null;
  reg.installing = null;
  reg.updates = 0;
  reg.update = () => { reg.updates += 1; return Promise.resolve(); };
  return { serviceWorker, flow, reg, log, clock };
}

test('a waiting release left by a closed tab is offered at attach', () => {
  const { flow, reg, log } = harness();
  reg.waiting = new FakeWorker('installed');
  flow.attach(reg);
  assert.deepEqual(log, ['offer']);
  assert.equal(flow.pending, reg.waiting);
});

test('a release already installing before the page listened is still offered (the missed-updatefound race)', () => {
  const { flow, reg, log } = harness();
  reg.installing = new FakeWorker('installing');
  flow.attach(reg);
  assert.deepEqual(log, ['downloading']);
  reg.installing.become('installed');
  assert.deepEqual(log, ['downloading', 'offer']);
});

test('updatefound after attach is tracked until installed', () => {
  const { flow, reg, log } = harness();
  flow.attach(reg);
  const next = new FakeWorker('installing');
  reg.installing = next;
  reg.emit('updatefound');
  next.become('installed');
  assert.deepEqual(log, ['downloading', 'offer']);
  assert.equal(flow.pending, next);
});

test('a first visit is never offered an update or reloaded by clients.claim()', () => {
  const { serviceWorker, flow, reg, log } = harness({ controlled: false });
  const first = new FakeWorker('installing');
  reg.installing = first;
  flow.attach(reg);
  first.become('installed');
  assert.equal(flow.pending, null);
  first.become('activated');
  serviceWorker.controller = {};
  serviceWorker.emit('controllerchange');
  assert.deepEqual(log, []);
  assert.equal(flow.stale, false);
});

test('apply posts SKIP_WAITING to the newest pending worker and reloads only this tab', () => {
  const { serviceWorker, flow, reg, log } = harness();
  flow.attach(reg);
  assert.equal(flow.apply(), false, 'nothing to apply yet');
  const older = new FakeWorker('installed');
  const newer = new FakeWorker('installed');
  reg.installing = older; reg.emit('updatefound');
  reg.installing = newer; reg.emit('updatefound');
  assert.equal(flow.apply(), true);
  assert.deepEqual(older.messages, []);
  assert.deepEqual(newer.messages, [{ type: 'SKIP_WAITING' }]);
  serviceWorker.emit('controllerchange');
  assert.equal(log.at(-1), 'reload');
  assert.equal(flow.stale, false);
});

test('a controlled tab that did not request the change becomes stale instead of mixing releases', () => {
  const { serviceWorker, flow, reg, log } = harness();
  flow.attach(reg);
  serviceWorker.emit('controllerchange');
  assert.equal(flow.stale, true);
  assert.deepEqual(log, ['stale']);
  serviceWorker.emit('controllerchange');
  assert.deepEqual(log, ['stale'], 'stale is announced once');
  assert.ok(!log.includes('reload'), 'a tab that did not ask is never reloaded under its user');
});

test('update checks are throttled and start after the registration check', () => {
  const clock = { t: 1000 };
  const { flow, reg } = harness({ clock });
  assert.equal(flow.check(), false, 'no registration yet');
  flow.attach(reg);
  assert.equal(flow.check(), false, 'register() already checked');
  clock.t += 60 * 60 * 1000;
  assert.equal(flow.check(), true);
  assert.equal(flow.check(), false);
  assert.equal(reg.updates, 1);
});

test('an offline update check failure is swallowed', async () => {
  const clock = { t: 0 };
  const { flow, reg } = harness({ clock });
  flow.attach(reg);
  reg.update = () => Promise.reject(new TypeError('offline'));
  clock.t += 60 * 60 * 1000;
  assert.equal(flow.check(), true);
  await new Promise(resolve => setImmediate(resolve));
});

test('the worker template bypasses the HTTP cache at install and never skips waiting on its own', async () => {
  const template = await readFile(new URL('../web/sw.js', import.meta.url), 'utf8');
  assert.match(template, /new Request\(path, \{ cache: 'reload' \}\)/);
  const install = template.split('\n').find(line => line.includes("addEventListener('install'"));
  assert.ok(install && !install.includes('skipWaiting'), 'install must not skipWaiting');
  assert.match(template, /event\.data\?\.type === 'SKIP_WAITING'/);
  assert.match(template, /key\.startsWith\('mml-studio-v1-'\)/, 'cleanup stays scoped to Studio caches');
});
