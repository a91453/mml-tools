import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import * as core from 'spessasynth_core';
import { BANK_LOAD_TIMEOUT_MS, addSoundBankOrFail, checkSoundBank } from '../web/preview/bank-check.mjs';
import { bankCheckTimeoutMs, checkBankInWorker, loadBank, storeBank } from '../web/preview/soundbank-store.mjs';
import { bankLoadMessage } from '../web/preview/player.mjs';

// A user's sound bank whose RIFF header is intact but whose body is cut short
// or damaged. The synth worklet cannot parse it and says so only through a
// `soundBankError` event, so it must never be kept (every later load, after
// every reload, would fail again) and a load must stop waiting for it.
const bank = new Uint8Array(core.BasicSoundBank.getSampleSoundBankFile());
const truncated = bank.slice(0, bank.length >> 1);
const headerOnly = bank.slice(0, 12);
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
const check = bytes => checkSoundBank(bytes, core);
const CONTROL = /[\u0000-\u001f\u007f-\u009f]/;

// An in-memory IndexedDB with just what soundbank-store.mjs uses, recording
// every request so a test can see that a refused bank never reached it.
function memoryIndexedDB() {
  const records = new Map(), log = [];
  const later = fn => setTimeout(fn, 0);
  let upgraded = false;
  const indexedDB = {
    open(name, version) {
      log.push(['open', name, version]);
      const request = {};
      later(() => {
        request.result = {
          createObjectStore: store => { log.push(['createObjectStore', store]); },
          transaction(store, mode) {
            const tx = {};
            let pending = 0;
            const op = (kind, key, run) => {
              const r = {};
              pending += 1; log.push([kind, key, mode]);
              later(() => { r.result = run(); pending -= 1; r.onsuccess?.(); later(() => { if (!pending) tx.oncomplete?.(); }); });
              return r;
            };
            tx.objectStore = () => ({
              put: (value, key) => op('put', key, () => { records.set(key, structuredClone(value)); return key; }),
              get: key => op('get', key, () => structuredClone(records.get(key))),
              delete: key => op('delete', key, () => { records.delete(key); }),
              count: key => op('count', key, () => (records.has(key) ? 1 : 0)),
            });
            return tx;
          },
          close() {},
        };
        if (!upgraded) { upgraded = true; request.onupgradeneeded?.(); }
        request.onsuccess?.();
      });
      return request;
    },
  };
  return { indexedDB, records, log };
}
async function withMemoryIndexedDB(work) {
  const memory = memoryIndexedDB();
  const had = Object.hasOwn(globalThis, 'indexedDB'), previous = globalThis.indexedDB;
  globalThis.indexedDB = memory.indexedDB;
  try { await work(memory); } finally { if (had) globalThis.indexedDB = previous; else delete globalThis.indexedDB; }
}

test('the check parses with the engine core: a complete bank passes, a truncated or header-only one does not', () => {
  assert.deepEqual(check(bank.slice().buffer), { presets: 1 });
  // The same view, not the whole buffer, is what is parsed.
  const padded = new Uint8Array(bank.length + 8); padded.set(bank, 4);
  assert.deepEqual(check(padded.subarray(4, 4 + bank.length)), { presets: 1 });
  for (const damaged of [truncated, headerOnly]) {
    assert.equal(String.fromCharCode(...damaged.slice(0, 4)) + String.fromCharCode(...damaged.slice(8, 12)), 'RIFFsfbk', 'the header alone looks like a bank');
    assert.throws(() => check(damaged.slice()), /SF parsing error/);
  }
});

test('storeBank refuses a bank that does not parse before anything is written, and keeps a good one unchanged', async () => {
  await withMemoryIndexedDB(async memory => {
    for (const [name, bytes] of [['truncated.sf2', truncated], ['header-only.sf2', headerOnly]]) {
      const refusal = await storeBank(new File([bytes], name), { check }).then(() => null, error => error);
      assert.ok(refusal, `${name} is refused`);
      assert.match(refusal.message, /^音色庫無法解析，沒有儲存（SF parsing error: Invalid chunk header!/);
      assert.doesNotMatch(refusal.message, CONTROL, 'the bank\'s own bytes quoted by the engine are not shown raw');
    }
    assert.deepEqual(memory.log, [], 'a refused bank never opens the store');

    // The check runs on a copy: a Worker takes (detaches) what it is given,
    // and what is kept is still the whole file.
    let given = null;
    const detaching = buffer => { given = buffer.byteLength; return check(structuredClone(buffer, { transfer: [buffer] })); };
    const kept = await storeBank(new File([bank], 'saw.sf2'), { check: detaching });
    assert.equal(given, bank.length);
    assert.deepEqual(Object.keys(kept), ['name', 'size', 'sha256', 'format', 'savedAt']);
    assert.deepEqual({ ...kept, savedAt: null }, { name: 'saw.sf2', size: bank.length, sha256: sha256(bank), format: 'sfbk', savedAt: null });
    // The stored record keeps its format: the description plus the bytes, under one key.
    assert.deepEqual([...memory.records.keys()], ['current']);
    const record = memory.records.get('current');
    assert.deepEqual(Object.keys(record), ['name', 'size', 'sha256', 'format', 'savedAt', 'bytes']);
    assert.ok(record.bytes instanceof ArrayBuffer);
    assert.deepEqual(new Uint8Array(record.bytes), bank);
    assert.deepEqual(new Uint8Array((await loadBank()).bytes), bank);

    // A refused bank leaves the kept one in place.
    await assert.rejects(storeBank(new File([truncated], 'truncated.sf2'), { check }), /音色庫無法解析，沒有儲存/);
    assert.equal((await loadBank()).name, 'saw.sf2');
    // A browser that cannot run the check says so; it does not call the bank damaged.
    const unavailable = () => Promise.reject(Object.assign(Error('Worker 無法啟動'), { code: 'BANK_CHECK_UNAVAILABLE' }));
    await assert.rejects(storeBank(new File([bank], 'saw.sf2'), { check: unavailable }), /^Error: 無法在這個瀏覽器檢查音色庫，沒有儲存（Worker 無法啟動）$/);
    assert.equal(memory.log.filter(([kind]) => kind === 'put').length, 1, 'only the good bank was ever written');
  });
});

// A stand-in for the spessasynth_lib WorkletSynthesizer as the preview and the
// Workshop use it: addSoundBank waits for the worklet's reply, and a bank the
// worklet cannot parse is only reported through the `soundBankError` event
// (vendored lib.js; web-build.test.mjs holds the vendored code to that).
function worklet({ reply }) {
  const events = new Map();
  const listeners = name => events.get(name)?.size ?? 0;
  const synth = {
    listenersAtSend: null,
    eventHandler: {
      addEvent: (name, id, callback) => { if (!events.has(name)) events.set(name, new Map()); events.get(name).set(id, callback); },
      removeEvent: (name, id) => { events.get(name)?.delete(id); },
    },
    soundBankManager: {
      addSoundBank(buffer, id) {
        synth.listenersAtSend = listeners('soundBankError');
        synth.sent = { buffer, id };
        return new Promise(resolve => setTimeout(() => {
          if (reply === 'ready') resolve();
          else if (reply === 'error') for (const callback of [...(events.get('soundBankError')?.values() ?? [])]) callback(Error('SF parsing error: Invalid chunk header! Expected "list" got "\u0000\u0000\u0000\u0000" The file may be corrupted.'));
          // 'silent': the worklet never answers at all.
        }, 5));
      },
    },
    listeners,
  };
  return synth;
}

// The load's own timer: every timer armed with `timeoutMs` while `work`
// runs, and whether it was cleared or ran. Timers with other delays (the
// stand-in worklet's reply) are not followed. One left armed is reported by
// the caller's assertions and cleared here, so it cannot also hold the test
// process open for a minute.
async function loadTimers(timeoutMs, work) {
  const { setTimeout: set, clearTimeout: clear } = globalThis;
  const timers = [];
  globalThis.setTimeout = (callback, ms, ...args) => {
    const timer = { state: 'armed' };
    timer.id = set((...values) => { timer.state = 'ran'; callback(...values); }, ms, ...args);
    if (ms === timeoutMs) timers.push(timer);
    return timer.id;
  };
  globalThis.clearTimeout = id => {
    const timer = timers.find(t => t.id === id);
    if (timer?.state === 'armed') timer.state = 'cleared';
    return clear(id);
  };
  try { return { result: await work(), timers: timers.map(t => t.state) }; }
  finally {
    globalThis.setTimeout = set; globalThis.clearTimeout = clear;
    for (const timer of timers) if (timer.state === 'armed') clear(timer.id);
  }
}

test('a load stops waiting for a bank the worklet cannot parse, or that never loads, and the preview says why', async () => {
  assert.equal(BANK_LOAD_TIMEOUT_MS, 60000);
  const unparsable = worklet({ reply: 'error' });
  const failed = await loadTimers(BANK_LOAD_TIMEOUT_MS, () => addSoundBankOrFail(unparsable, truncated.slice().buffer, 'studio-user-bank').then(() => null, error => error));
  const refusal = failed.result;
  assert.ok(refusal, 'an unparsable bank rejects instead of waiting forever');
  assert.equal(refusal.code, 'BANK_UNPARSABLE');
  assert.equal(refusal.message, 'SF parsing error: Invalid chunk header! Expected "list" got " " The file may be corrupted.');
  assert.equal(bankLoadMessage(refusal), '音色庫無法解析，已停止載入（SF parsing error: Invalid chunk header! Expected "list" got " " The file may be corrupted.）');
  assert.equal(unparsable.listenersAtSend, 1, 'the error listener is in place before the bank is sent');
  assert.equal(unparsable.listeners('soundBankError'), 0, 'and removed once the load is settled');
  assert.deepEqual(failed.timers, ['cleared'], 'the load\'s timer is cleared once the parse error ends it');

  const silent = worklet({ reply: 'silent' });
  const waited = await loadTimers(1000, () => addSoundBankOrFail(silent, bank.slice().buffer, 'studio-user-bank', { timeoutMs: 1000 }).then(() => null, error => error));
  const timedOut = waited.result;
  assert.equal(timedOut?.code, 'BANK_LOAD_TIMEOUT');
  assert.equal(bankLoadMessage(timedOut), '音色庫在 1 秒內沒有載入完成，已停止載入');
  assert.equal(silent.listeners('soundBankError'), 0);
  assert.deepEqual(waited.timers, ['ran'], 'the timer is what ended the wait');

  const ready = worklet({ reply: 'ready' });
  const loaded = await loadTimers(BANK_LOAD_TIMEOUT_MS, () => addSoundBankOrFail(ready, bank.slice().buffer, 'studio-user-bank'));
  assert.equal(ready.sent.id, 'studio-user-bank');
  assert.equal(ready.listeners('soundBankError'), 0, 'a loaded bank leaves no listener behind');
  assert.deepEqual(loaded.timers, ['cleared'], 'and no timer: its timeout is cleared, not left to run a minute later');
});

// A stand-in for the browser's module Worker running bank-check-worker.mjs:
// it records what it was made with and given, and whether it was
// terminated. `answer` (a message) is posted back after a tick; without one it
// never answers, like a parser that allocates until the tab crashes.
function checkWorkers(answer = null) {
  const made = [];
  class StandInWorker {
    constructor(url, options) { Object.assign(this, { url: String(url), options, posted: [], terminated: false }); made.push(this); }
    postMessage(message, transfer) {
      this.posted.push({ message, transfer });
      if (answer) setTimeout(() => this.onmessage?.({ data: answer }), 1);
    }
    terminate() { this.terminated = true; }
  }
  return { StandInWorker, made };
}
async function withWorker(Worker, work) {
  const had = Object.hasOwn(globalThis, 'Worker'), previous = globalThis.Worker;
  globalThis.Worker = Worker;
  try { return await work(); } finally { if (had) globalThis.Worker = previous; else delete globalThis.Worker; }
}

test('a bank check that does not answer in time is stopped, and the bank refused as not checked, not as damaged', async () => {
  // The limit grows with the bank, in whole seconds: 5 s, plus 1 s for every 2 MiB begun.
  assert.equal(bankCheckTimeoutMs(0), 5000);
  assert.equal(bankCheckTimeoutMs(bank.length), 6000);
  assert.equal(bankCheckTimeoutMs(64 * 1048576), 37000);

  const silent = checkWorkers();
  await withWorker(silent.StandInWorker, () => withMemoryIndexedDB(async memory => {
    const check = bytes => checkBankInWorker(bytes, { timeoutMs: 1000 });
    const started = performance.now();
    const ran = await loadTimers(1000, () => storeBank(new File([bank], 'slow.sf2'), { check }).then(() => null, error => error));
    const refusal = ran.result;
    assert.ok(refusal, 'a check that never answers ends in a refusal');
    assert.ok(performance.now() - started < 5000, 'at its limit, not later');
    assert.equal(refusal.message, '音色庫在 1 秒內沒有完成檢查，沒有儲存');
    assert.doesNotMatch(refusal.message, /無法解析/, 'a bank that could not be checked in time is not called damaged');
    assert.equal(refusal.code, 'BANK_CHECK_TIMEOUT');
    assert.equal(refusal.timeoutMs, 1000, 'the Workshop words it from the limit that ran out');
    assert.deepEqual(ran.timers, ['ran']);
    assert.equal(silent.made.length, 1);
    const [worker] = silent.made;
    assert.match(worker.url, /\/preview\/bank-check-worker\.mjs$/);
    assert.deepEqual(worker.options, { type: 'module' });
    assert.equal(worker.posted[0].message.bytes.byteLength, bank.length, 'the whole bank was sent to be checked');
    assert.equal(worker.terminated, true, 'the Worker, and whatever it was still allocating, is stopped');
    assert.deepEqual(memory.log, [], 'nothing was written');
  }));

  // Without a limit given, the check of a bank arms its size's limit.
  const armed = [];
  const { setTimeout: set } = globalThis;
  globalThis.setTimeout = (callback, ms) => { armed.push(ms); return 0; };
  try { await withWorker(checkWorkers().StandInWorker, () => { checkBankInWorker(new ArrayBuffer(3 * 1048576)); }); }
  finally { globalThis.setTimeout = set; }
  assert.deepEqual(armed, [7000]);

  // A check that answers is not cut short, and leaves no Worker or timer.
  const answering = checkWorkers({ ok: true, presets: 1 });
  const answered = await withWorker(answering.StandInWorker, () => loadTimers(bankCheckTimeoutMs(bank.length), () => checkBankInWorker(bank.slice().buffer)));
  assert.deepEqual(answered.result, { presets: 1 });
  assert.deepEqual(answered.timers, ['cleared']);
  assert.equal(answering.made[0].terminated, true);
});
