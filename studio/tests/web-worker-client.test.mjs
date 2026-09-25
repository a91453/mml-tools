import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFile } from 'node:fs/promises';
import { createWorkerClient, WORKER_TIMEOUT, WORKER_UNAVAILABLE, WORKER_GIVEN_UP } from '../web/worker-client.mjs';

// A fake Worker with the same contract as the real module Worker: one
// computation at a time, messages answered in order, and a terminate() that
// makes anything still in flight unanswerable.
function fakeWorkers() {
  const instances = [];
  const spawn = () => {
    const instance = {
      onmessage: null,
      onerror: null,
      alive: true,
      inbox: [],
      postMessage(request) { if (this.alive) this.inbox.push(request); },
      terminate() { this.alive = false; },
      answer(result) { const request = this.inbox.shift(); this.onmessage({ data: { id: request.id, result } }); },
      fail(error) { const request = this.inbox.shift(); this.onmessage({ data: { id: request.id, error } }); },
      crash() { this.onerror(new Error('module load failed')); },
      // What worker.mjs answers once it could not fetch part of its module graph.
      failInitialization(error = 'CANONICAL_NOT_LOADED: Failed to fetch dynamically imported module: model.mjs', id = this.inbox.shift().id) { this.onmessage({ data: { id, error, initializationRetryable: true } }); },
    };
    instances.push(instance);
    return instance;
  };
  return { instances, spawn };
}

test('a healthy request resolves and the Worker is reused', async () => {
  const { instances, spawn } = fakeWorkers();
  const client = createWorkerClient({ spawn, timeoutMs: 50 });
  const first = client.call('identity');
  instances[0].answer({ ok: 1 });
  assert.deepEqual(await first, { ok: 1 });
  const second = client.call('analyzeWorkspace', {});
  instances[0].answer({ ok: 2 });
  assert.deepEqual(await second, { ok: 2 });
  assert.equal(instances.length, 1, 'a working Worker is never replaced');
  assert.deepEqual(client.state, { pending: 0, restarts: 0, givenUp: false, running: true });
});

test('a reported worker error rejects that call without discarding the Worker', async () => {
  const { instances, spawn } = fakeWorkers();
  const client = createWorkerClient({ spawn, timeoutMs: 50 });
  const call = client.call('intake', {});
  instances[0].fail('UNSUPPORTED: Canonical IR schema');
  await assert.rejects(call, /UNSUPPORTED: Canonical IR schema/);
  assert.equal(instances.length, 1, 'a rejected request is not a broken Worker');
});

// The failure this guards: a timed-out computation still owns the Worker, so
// every later request queues behind work nobody is waiting for and times out in
// turn, leaving the session permanently wedged.
test('a timed-out request kills its computation so the next request is not stuck behind it', async () => {
  const { instances, spawn } = fakeWorkers();
  const client = createWorkerClient({ spawn, timeoutMs: 20 });
  const abandoned = client.call('analyzeWorkspace', {});
  await assert.rejects(abandoned, error => error.message === WORKER_TIMEOUT);

  assert.equal(instances[0].alive, false, 'the stuck computation is terminated, not left running');
  assert.equal(instances.length, 2, 'a replacement Worker is started');
  assert.equal(client.state.pending, 0);

  // The replacement answers immediately; the abandoned computation cannot.
  const next = client.call('analyzeWorkspace', {});
  assert.equal(instances[1].inbox.length, 1, 'the next request reaches the replacement, not the dead instance');
  instances[1].answer({ state: 'CANDIDATE' });
  assert.deepEqual(await next, { state: 'CANDIDATE' });
  assert.equal(client.state.restarts, 0, 'a real answer clears the restart budget');
});

test('everything in flight when the Worker is replaced fails closed rather than waiting out its own deadline', async () => {
  const { spawn } = fakeWorkers();
  const client = createWorkerClient({ spawn, timeoutMs: 40 });
  const first = client.call('analyzeWorkspace', {});
  // Staggered, so the second request's own deadline is still well in the future
  // when the first one takes the Worker down with it.
  await new Promise(resume => setTimeout(resume, 20));
  const second = client.call('intake', {});
  await assert.rejects(first, error => error.message === WORKER_TIMEOUT);
  assert.equal(client.state.pending, 0, 'in-flight work is rejected with the Worker, not left waiting on an instance that is gone');
  await assert.rejects(second, error => error.message === WORKER_TIMEOUT);
});

test('a Worker that fails to start rejects in flight work and is replaced', async () => {
  const { instances, spawn } = fakeWorkers();
  const client = createWorkerClient({ spawn, timeoutMs: 5000 });
  const call = client.call('identity');
  instances[0].crash();
  await assert.rejects(call, error => error.message === WORKER_UNAVAILABLE);
  assert.equal(instances[0].alive, false);
  assert.equal(instances.length, 2);
});

// Respawning on every failure would loop forever when the Worker module itself
// cannot load, so the budget is finite and the client then stays refusing.
test('a Worker that keeps failing gives up instead of respawning forever', async () => {
  const { instances, spawn } = fakeWorkers();
  const client = createWorkerClient({ spawn, timeoutMs: 5000, maxRestarts: 3 });
  for (let attempt = 0; attempt < 4; attempt++) {
    const call = client.call('identity');
    instances.at(-1).crash();
    await assert.rejects(call, error => [WORKER_UNAVAILABLE, WORKER_GIVEN_UP].includes(error.message));
  }
  assert.equal(client.state.givenUp, true);
  assert.equal(client.state.running, false);
  assert.equal(instances.length, 4, 'the replacement budget is spent, not unbounded');
  await assert.rejects(client.call('analyzeWorkspace', {}), error => error.message === WORKER_GIVEN_UP);
  assert.equal(instances.length, 4, 'a given-up client rejects immediately instead of spawning again');
});

// CI once left Studio on its boot error: the Worker's import of model.mjs was
// refused ("Failed to fetch dynamically imported module"), and that instance
// answered every request with the failure for the rest of its life.
test('a Worker that could not fetch its module graph is replaced, and the request is answered by the replacement', async () => {
  const { instances, spawn } = fakeWorkers();
  const client = createWorkerClient({ spawn, timeoutMs: 5000 });
  const call = client.call('analyzeWorkspace', { revision: 3 });
  const sent = instances[0].inbox[0];
  instances[0].failInitialization();
  assert.equal(instances[0].alive, false, 'the instance that cannot initialise is terminated');
  assert.equal(instances.length, 2);
  assert.deepEqual(instances[1].inbox, [sent], 'the same request, unchanged, goes to the replacement');
  assert.equal(client.state.restarts, 1, 'the replacement is spent from the restart budget');
  instances[1].answer({ state: 'CANDIDATE' });
  assert.deepEqual(await call, { state: 'CANDIDATE' });
  assert.deepEqual(client.state, { pending: 0, restarts: 0, givenUp: false, running: true });
});

test('every request held by that instance moves to the replacement in order, and the replaced instance is not heard again', async () => {
  const { instances, spawn } = fakeWorkers();
  const client = createWorkerClient({ spawn, timeoutMs: 5000 });
  const identity = client.call('identity');
  const analysis = client.call('analyzeWorkspace', { revision: 4 });
  const [first, second] = instances[0].inbox;
  instances[0].failInitialization();
  // The second request's own failure arrives after the replacement started.
  instances[0].failInitialization(undefined, second.id);
  assert.equal(instances.length, 2, 'one replacement, not one per queued request');
  assert.deepEqual(instances[1].inbox, [first, second]);
  instances[0].onmessage({ data: { id: second.id, result: 'from the replaced instance' } });
  instances[1].answer({ metadata: 'm' });
  instances[1].answer({ state: 'PENDING' });
  assert.deepEqual(await identity, { metadata: 'm' });
  assert.deepEqual(await analysis, { state: 'PENDING' });
});

test('a Worker that can never fetch its module graph fails closed with that failure once the budget is spent', async () => {
  const { instances, spawn } = fakeWorkers();
  const client = createWorkerClient({ spawn, timeoutMs: 5000, maxRestarts: 3 });
  const call = client.call('identity');
  for (let attempt = 0; attempt < 4; attempt++) instances.at(-1).failInitialization();
  await assert.rejects(call, error => error.message === 'CANONICAL_NOT_LOADED: Failed to fetch dynamically imported module: model.mjs');
  assert.equal(instances.length, 4, 'the first instance and three replacements');
  assert.ok(instances.every(instance => !instance.alive));
  assert.deepEqual(client.state, { pending: 0, restarts: 4, givenUp: true, running: false });
  await assert.rejects(client.call('identity'), error => error.message === WORKER_GIVEN_UP);
  assert.equal(instances.length, 4);
});

test('an initialization failure a replacement cannot fix is answered as it is, and the Worker is kept', async () => {
  const { instances, spawn } = fakeWorkers();
  const client = createWorkerClient({ spawn, timeoutMs: 5000 });
  const call = client.call('identity');
  instances[0].fail('CANONICAL_NOT_LOADED: Runtime Canonical differs from verified package');
  await assert.rejects(call, /Runtime Canonical differs/);
  assert.equal(instances.length, 1, 'a verification failure is not retried on a fresh Worker');
});

test('a moved request keeps the deadline it was given', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const { instances, spawn } = fakeWorkers();
  const client = createWorkerClient({ spawn, timeoutMs: 40 });
  let settled = null;
  client.call('analyzeWorkspace', {}).catch(error => { settled = error.message; });
  t.mock.timers.tick(25);
  instances[0].failInitialization();
  t.mock.timers.tick(15);
  await Promise.resolve();
  assert.equal(settled, WORKER_TIMEOUT, 'the replacement does not restart the clock');
  assert.equal(instances[1].alive, false, 'the replacement that never answered is terminated with the timeout');
});

// Chromium delivers an error event from a Worker after terminate(), though it
// drops its messages.
test('an error from a replaced instance does not take down its replacement', async () => {
  const { instances, spawn } = fakeWorkers();
  const client = createWorkerClient({ spawn, timeoutMs: 5000 });
  const call = client.call('analyzeWorkspace', {});
  instances[0].failInitialization();
  instances[0].crash();
  assert.equal(instances.length, 2, 'no second replacement');
  assert.equal(instances[1].alive, true);
  instances[1].answer({ state: 'CANDIDATE' });
  assert.deepEqual(await call, { state: 'CANDIDATE' });
});

// worker.mjs itself, one context per instance with its imports doubled, so
// what it answers is checked against the client that acts on it. As in a
// browser, an instance keeps the outcome of each import for its lifetime, and
// every message crosses in a task of its own. While offline, as on a page no
// service worker controls, a new instance's own script cannot be fetched.
const workerSource = (await readFile(new URL('../web/worker.mjs', import.meta.url), 'utf8')).replace(/^import .*$/gm, '').replaceAll('import(', 'load(');
const canonical = { metadata: { fixture: 1 }, documents: [] };
function realWorkers({ listen, online = () => true }) {
  const instances = [], ran = [];
  const spawn = () => {
    if (!online()) {
      const unloaded = { onmessage: null, onerror: null, postMessage() {}, terminate() {} };
      setTimeout(() => unloaded.onerror?.({ message: 'worker.mjs could not be fetched' }));
      instances.push(unloaded);
      return unloaded;
    }
    const number = instances.length, imports = new Map();
    const instance = {
      onmessage: null,
      onerror: null,
      alive: true,
      postMessage(data) { setTimeout(() => { if (instance.alive) context.self.onmessage({ data }); }); },
      terminate() { instance.alive = false; },
    };
    const modules = {
      './model.mjs': async () => ({ newWorkspace: () => { ran.push(['newWorkspace', number]); return { id: 'fixture' }; } }),
      '../backend/rules/index.mjs': async () => ({ PUBLISHED_CANONICAL: canonical }),
      './listen-model.mjs': () => listen(number, realm),
    };
    const context = vm.createContext({
      self: { postMessage: data => setTimeout(() => { if (instance.alive) instance.onmessage({ data }); }) },
      canonical, canonicalDigest: 'fixture', verifyCanonicalPackage: async () => {},
      load: specifier => { if (!imports.has(specifier)) imports.set(specifier, modules[specifier]()); return imports.get(specifier); },
    });
    // The Worker tells a failed fetch from other failures by its own TypeError.
    const realm = vm.runInContext('({ TypeError, SyntaxError })', context);
    vm.runInContext(workerSource, context);
    instances.push(instance);
    return instance;
  };
  return { instances, ran, spawn };
}
const listenModel = { parseListening: mml => ({ ok: true, mml }) };
const unfetched = ({ TypeError }) => Promise.reject(new TypeError('Failed to fetch dynamically imported module: listen-model.mjs'));

// The listen model used to be imported on a Worker's first listening request.
// A fetch of it that failed then failed every later session, and replacing the
// Worker for that while the connection was still down spent the client's
// budget on replacements that could not start, so analysis stopped as well.
test('a Worker that started opens a listening session after the connection drops, and keeps analysing', async () => {
  let online = true;
  const { instances, ran, spawn } = realWorkers({ online: () => online, listen: (number, realm) => (online ? Promise.resolve(listenModel) : unfetched(realm)) });
  const client = createWorkerClient({ spawn, timeoutMs: 5000 });
  assert.deepEqual(await client.call('newWorkspace'), { id: 'fixture' });
  online = false;
  assert.deepEqual(await client.call('parseListening', 'MML@c;'), { ok: true, mml: 'MML@c;' });
  assert.deepEqual(await client.call('newWorkspace'), { id: 'fixture' });
  assert.equal(instances.length, 1, 'nothing is replaced');
  assert.deepEqual(ran, [['newWorkspace', 0], ['newWorkspace', 0]]);
  assert.deepEqual(client.state, { pending: 0, restarts: 0, givenUp: false, running: true });
});

test('a Worker that could not fetch the listen model is replaced before it runs a request, and each request runs once', async () => {
  const { instances, ran, spawn } = realWorkers({ listen: (number, realm) => (number === 0 ? unfetched(realm) : Promise.resolve(listenModel)) });
  const client = createWorkerClient({ spawn, timeoutMs: 5000 });
  const fresh = client.call('newWorkspace');
  const parsed = client.call('parseListening', 'MML@c;');
  assert.deepEqual(await fresh, { id: 'fixture' });
  assert.deepEqual(await parsed, { ok: true, mml: 'MML@c;' });
  assert.equal(instances.length, 2);
  assert.deepEqual(ran, [['newWorkspace', 1]], 'the instance that could not start ran nothing, and its replacement ran each request once');
  assert.deepEqual(client.state, { pending: 0, restarts: 0, givenUp: false, running: true });
});

test('a listen model that fetched but does not load, or a parse that throws, fails listening only and the Worker is kept', async () => {
  for (const listen of [
    (number, { SyntaxError }) => Promise.reject(new SyntaxError("Unexpected token '='")),
    (number, { TypeError }) => Promise.resolve({ parseListening: () => { throw new TypeError('parse failed'); } }),
  ]) {
    const { instances, ran, spawn } = realWorkers({ listen });
    const client = createWorkerClient({ spawn, timeoutMs: 5000 });
    await assert.rejects(client.call('parseListening', 'MML@c;'), /^Error: (Unexpected token '='|parse failed)$/);
    assert.deepEqual(await client.call('newWorkspace'), { id: 'fixture' });
    assert.equal(instances.length, 1, 'a new Worker would fail the same way, so none is started');
    assert.deepEqual(ran, [['newWorkspace', 0]]);
  }
});

test('every failure message keeps the unfinished gates PENDING rather than claiming a result', () => {
  for (const reason of [WORKER_TIMEOUT, WORKER_UNAVAILABLE, WORKER_GIVEN_UP]) {
    assert.match(reason, /PENDING/);
    assert.doesNotMatch(reason, /PASS|VALIDATED|ACCEPTED/);
  }
});
