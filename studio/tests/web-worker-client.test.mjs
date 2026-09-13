import test from 'node:test';
import assert from 'node:assert/strict';
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

test('every failure message keeps the unfinished gates PENDING rather than claiming a result', () => {
  for (const reason of [WORKER_TIMEOUT, WORKER_UNAVAILABLE, WORKER_GIVEN_UP]) {
    assert.match(reason, /PENDING/);
    assert.doesNotMatch(reason, /PASS|VALIDATED|ACCEPTED/);
  }
});
