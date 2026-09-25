import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import * as core from 'spessasynth_core';
import { BANK_LOAD_TIMEOUT_MS, SYNTH_READY_TIMEOUT_MS, addSoundBankOrFail, checkSoundBank, synthReadyOrFail } from '../web/preview/bank-check.mjs';
import { BANK_CHECKER_LOAD_TIMEOUT_MS, MAX_BANK_BYTES, bankCheckTimeoutMs, checkBankInWorker, clearBank, loadBank, storeBank } from '../web/preview/soundbank-store.mjs';
import { bankLoadMessage } from '../web/preview/player.mjs';

// The real timer functions, for stand-ins that must keep time while a test
// replaces or records the global ones.
const { setTimeout: realSetTimeout } = globalThis;

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

// Studio's pickBank passes `current`, so that when picks overlap the last one
// wins (the browser check in default-bank.mjs drives the page itself).
test('storeBank writes a bank only while it is still the one wanted', async () => {
  await withMemoryIndexedDB(async memory => {
    // A newer pick was made while this one was checked: refused before the
    // store is opened, saying it was not kept because of the newer pick.
    const overtaken = await storeBank(new File([bank], 'older.sf2'), { check, current: () => false }).then(() => null, error => error);
    assert.equal(overtaken?.code, 'BANK_SUPERSEDED');
    assert.equal(overtaken.message, '已選擇較新的音色庫，這個音色庫沒有儲存');
    assert.deepEqual(memory.log, [], 'the store is never opened');

    // One made while its digest was computed or the store opened: asked
    // again inside the write's transaction, and stopped before the write.
    let asked = 0;
    const late = await storeBank(new File([bank], 'older.sf2'), { check, current: () => (asked += 1) === 1 }).then(() => null, error => error);
    assert.equal(late?.code, 'BANK_SUPERSEDED');
    assert.equal(asked, 2, 'asked after the check, and again right before the write');
    assert.deepEqual(memory.log.filter(([kind]) => kind === 'put'), [], 'nothing was written');
    assert.equal(await loadBank(), null);

    // Still the one wanted: kept.
    assert.equal((await storeBank(new File([bank], 'wanted.sf2'), { check, current: () => true })).name, 'wanted.sf2');
    assert.equal((await loadBank()).name, 'wanted.sf2');
  });
});

// Removing the bank is a choice too (preview/bank-choices.mjs): its delete is
// sent only while it is still the latest choice.
test('clearBank deletes the kept bank only while the removal is still the latest choice', async () => {
  await withMemoryIndexedDB(async memory => {
    await storeBank(new File([bank], 'kept.sf2'), { check });
    let asked = 0;
    const overtaken = await clearBank({ current: () => { asked += 1; return false; } }).then(() => null, error => error);
    assert.equal(overtaken?.code, 'BANK_SUPERSEDED');
    assert.equal(asked, 1, 'asked inside the delete\'s own transaction');
    assert.deepEqual(memory.log.filter(([kind]) => kind === 'delete'), [], 'nothing was deleted');
    assert.equal((await loadBank()).name, 'kept.sf2');
    await clearBank({ current: () => true });
    assert.equal(await loadBank(), null);
    await clearBank();
    assert.equal(await loadBank(), null, 'removing when nothing is kept keeps nothing');
  });
});

// Every refusal carries a code, so a page can say it in its own language
// (the Workshop's four) and never has to parse Studio's words.
test('every refusal of a pick carries a code and what the page needs to say it', async () => {
  await withMemoryIndexedDB(async memory => {
    const refused = (file, options = {}) => storeBank(file, { check, ...options }).then(() => null, error => error);
    const notBank = await refused(new File([bank], 'saw.txt'));
    assert.deepEqual([notBank.code, notBank.message], ['BANK_NOT_A_BANK', '音色庫需為 .dls、.sf2 或 .sf3 檔案']);
    const notRiff = await refused(new File([new Uint8Array(64)], 'zeros.sf2'));
    assert.deepEqual([notRiff.code, notRiff.message], ['BANK_NOT_A_BANK', '檔案不是 RIFF DLS／SoundFont 音色庫']);
    const huge = Object.defineProperty(new File([bank], 'huge.sf2'), 'size', { value: MAX_BANK_BYTES + 1 });
    const tooLarge = await refused(huge);
    assert.deepEqual([tooLarge.code, tooLarge.maxBytes, tooLarge.message], ['BANK_TOO_LARGE', MAX_BANK_BYTES, '音色庫超過 64 MiB 上限']);
    const unparsable = await refused(new File([truncated], 'truncated.sf2'));
    assert.equal(unparsable.code, 'BANK_DOES_NOT_PARSE');
    assert.match(unparsable.detail, /^SF parsing error: Invalid chunk header!/);
    assert.equal(unparsable.message, `音色庫無法解析，沒有儲存（${unparsable.detail}）`);
    const unavailable = await refused(new File([bank], 'saw.sf2'), { check: () => Promise.reject(Object.assign(Error('Worker 無法啟動'), { code: 'BANK_CHECK_UNAVAILABLE' })) });
    assert.deepEqual([unavailable.code, unavailable.detail], ['BANK_CHECK_UNAVAILABLE', 'Worker 無法啟動']);
    for (const [code, timeoutMs] of [['BANK_CHECK_TIMEOUT', 7000], ['BANK_CHECKER_LOAD_TIMEOUT', 30000]]) {
      const timedOut = await refused(new File([bank], 'saw.sf2'), { check: () => Promise.reject(Object.assign(Error('late'), { code, timeoutMs })) });
      assert.deepEqual([timedOut.code, timedOut.timeoutMs], [code, timeoutMs]);
    }
    assert.deepEqual(memory.log, [], 'no refusal so far opened the store');
    // A store that will not keep the bank (a full disk, a blocked database):
    // refused as not kept, quoting the store, and nothing is left behind.
    const realOpen = memory.indexedDB.open;
    memory.indexedDB.open = () => { const request = {}; setTimeout(() => { request.error = new DOMException('quota exceeded (unit test)', 'QuotaExceededError'); request.onerror?.(); }, 0); return request; };
    const notStored = await refused(new File([bank], 'saw.sf2'));
    memory.indexedDB.open = realOpen;
    assert.deepEqual([notStored.code, notStored.detail, notStored.message], ['BANK_NOT_STORED', 'quota exceeded (unit test)', '音色庫無法存進這台裝置，沒有儲存（quota exceeded (unit test)）']);
    assert.equal(await loadBank(), null);
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
// terminated. Like the real one, it reports {loaded: true} once its parser
// module has loaded, here after `loadMs` (never, when null: a download or
// module load that hangs). `answer` (a message) is posted back `answerMs`
// after it is handed the bank; without one it never answers, like a parser
// that allocates until the tab crashes. `events` records, in order, when it
// reported loaded and when it was handed the bank; a test adds its timers.
function checkWorkers({ answer = null, loadMs = 1, early = null, answerMs = 1 } = {}) {
  const made = [], events = [];
  class StandInWorker {
    constructor(url, options) {
      Object.assign(this, { url: String(url), options, posted: [], terminated: false });
      made.push(this);
      const post = data => { if (!this.terminated) this.onmessage?.({ data }); };
      if (early) realSetTimeout(() => post(early), 1);
      if (loadMs !== null) realSetTimeout(() => { if (!this.terminated) events.push('loaded'); post({ loaded: true }); }, loadMs);
    }
    postMessage(message, transfer) {
      this.posted.push({ message, transfer });
      events.push('handed the bank');
      if (answer) realSetTimeout(() => { if (!this.terminated) this.onmessage?.({ data: answer }); }, answerMs);
    }
    terminate() { this.terminated = true; }
  }
  return { StandInWorker, made, events };
}
// Records every timer armed while `work` runs into `events`, as `timer <ms>`,
// and lets it run as usual. The in-memory store's zero-delay steps are left out.
async function recordTimers(events, work) {
  const { setTimeout: set } = globalThis;
  globalThis.setTimeout = (callback, ms, ...args) => { if (ms > 0) events.push(`timer ${ms}`); return set(callback, ms, ...args); };
  try { return await work(); } finally { globalThis.setTimeout = set; }
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

  // Without limits given, the check of a bank arms the parser's load limit,
  // then, once the parser has loaded, its size's limit.
  const sized = checkWorkers({ answer: { ok: true, presets: 1 } });
  await withWorker(sized.StandInWorker, () => recordTimers(sized.events, () => checkBankInWorker(new ArrayBuffer(3 * 1048576))));
  assert.deepEqual(sized.events, ['timer 30000', 'loaded', 'timer 7000', 'handed the bank']);

  // A check that answers is not cut short, and leaves no Worker or timer.
  const answering = checkWorkers({ answer: { ok: true, presets: 1 } });
  const answered = await withWorker(answering.StandInWorker, () => loadTimers(bankCheckTimeoutMs(bank.length), () => checkBankInWorker(bank.slice().buffer)));
  assert.deepEqual(answered.result, { presets: 1 });
  assert.deepEqual(answered.timers, ['cleared']);
  assert.equal(answering.made[0].terminated, true);
});

test('the check\'s limit starts once the Worker has loaded its parser, and a parser that never loads ends at a limit of its own', async () => {
  const check = options => bytes => checkBankInWorker(bytes, { timeoutMs: 1000, ...options });

  // A slow first download of the parser (core.js, about 740 KB) followed by a
  // quick parse: the bank is checked and kept. Counted from the Worker's
  // start, the 1 s limit would have run out before the parser had loaded.
  const slowLoad = checkWorkers({ loadMs: 1500, answer: { ok: true, presets: 1 } });
  await withWorker(slowLoad.StandInWorker, () => withMemoryIndexedDB(async memory => {
    const ran = await loadTimers(1000, () => recordTimers(slowLoad.events, () => storeBank(new File([bank], 'slow-load.sf2'), { check: check() })));
    assert.equal(ran.result.name, 'slow-load.sf2', 'a valid bank whose checker loaded slowly is kept');
    assert.deepEqual(new Uint8Array(memory.records.get('current').bytes), bank);
    assert.deepEqual(slowLoad.events, [`timer ${BANK_CHECKER_LOAD_TIMEOUT_MS}`, 'loaded', 'timer 1000', 'handed the bank'], 'the check\'s clock starts as the bank is handed to the loaded parser');
    assert.deepEqual(ran.timers, ['cleared']);
    assert.equal(slowLoad.made[0].terminated, true);
  }));

  // Loaded, then the parse never answers: refused at the check's limit,
  // counted from the load, as not checked.
  const silent = checkWorkers({ loadMs: 500 });
  await withWorker(silent.StandInWorker, () => withMemoryIndexedDB(async memory => {
    const started = performance.now();
    const ran = await loadTimers(1000, () => recordTimers(silent.events, () => storeBank(new File([bank], 'silent.sf2'), { check: check() }).then(() => null, error => error)));
    const elapsed = performance.now() - started;
    assert.equal(ran.result?.code, 'BANK_CHECK_TIMEOUT');
    assert.equal(ran.result.message, '音色庫在 1 秒內沒有完成檢查，沒有儲存');
    assert.deepEqual(silent.events, [`timer ${BANK_CHECKER_LOAD_TIMEOUT_MS}`, 'loaded', 'timer 1000', 'handed the bank']);
    assert.deepEqual(ran.timers, ['ran'], 'the check\'s limit is what ended it');
    assert.ok(elapsed >= 1450 && elapsed < 5000, `at the limit counted from the load (about 1.5 s), not from the start: ${Math.round(elapsed)} ms`);
    assert.equal(silent.made[0].terminated, true);
    assert.deepEqual(memory.log, [], 'nothing was written');
  }));

  // The parser never loads (a download that hangs): refused at the load
  // limit, saying the checker did not load, never that the bank is damaged
  // or that its check ran out of time. The bank is never handed over.
  assert.equal(BANK_CHECKER_LOAD_TIMEOUT_MS, 30000);
  const hung = checkWorkers({ loadMs: null });
  await withWorker(hung.StandInWorker, () => withMemoryIndexedDB(async memory => {
    const started = performance.now();
    const ran = await loadTimers(1000, () => storeBank(new File([bank], 'hung.sf2'), { check: check({ timeoutMs: 60000, loadTimeoutMs: 1000 }) }).then(() => null, error => error));
    const refusal = ran.result;
    assert.ok(performance.now() - started < 5000, 'at the load limit, not later');
    assert.equal(refusal?.code, 'BANK_CHECKER_LOAD_TIMEOUT');
    assert.equal(refusal.timeoutMs, 1000, 'the Workshop words it from the limit that ran out');
    assert.equal(refusal.message, '檢查音色庫的程式在 1 秒內沒有載入，音色庫沒有檢查，也沒有儲存');
    assert.doesNotMatch(refusal.message, /無法解析|沒有完成檢查/);
    assert.deepEqual(ran.timers, ['ran']);
    assert.equal(hung.made[0].terminated, true, 'the Worker, and its download, is stopped');
    assert.deepEqual(hung.made[0].posted, [], 'the bank was never handed over');
    assert.deepEqual(memory.log, [], 'nothing was written');
  }));

  // Loaded well inside the load limit, then still parsing when that limit,
  // counted from the Worker's start, would run out: the load limit was
  // cleared as the parser reported loaded, so only the check's own, longer
  // limit applies, and the bank is kept. Left armed, it would stop the Worker
  // and refuse the bank as one whose checker did not load, which is untrue.
  const longParse = checkWorkers({ loadMs: 100, answer: { ok: true, presets: 1 }, answerMs: 1500 });
  await withWorker(longParse.StandInWorker, () => withMemoryIndexedDB(async memory => {
    const ran = await loadTimers(1000, () => storeBank(new File([bank], 'long-parse.sf2'), { check: check({ timeoutMs: 3000, loadTimeoutMs: 1000 }) }).then(value => value, error => error));
    assert.equal(ran.result?.name, 'long-parse.sf2', `a bank whose parse outlasts the load limit is checked and kept: ${ran.result?.message ?? ''}`);
    assert.deepEqual(ran.timers, ['cleared'], 'the load limit is cleared once the parser has loaded');
    assert.deepEqual(longParse.events, ['loaded', 'handed the bank']);
    assert.deepEqual(new Uint8Array(memory.records.get('current').bytes), bank);
  }));

  // A Worker that answers before it says it has loaded is not believed.
  const early = checkWorkers({ loadMs: null, early: { ok: true, presets: 1 } });
  const premature = await withWorker(early.StandInWorker, () => checkBankInWorker(bank.slice().buffer, { loadTimeoutMs: 1000 }).then(() => null, error => error));
  assert.equal(premature?.code, 'BANK_CHECK_UNAVAILABLE');
  assert.equal(early.made[0].terminated, true);
  assert.deepEqual(early.made[0].posted, []);
});

// A stand-in for a WorkletSynthesizer just made on an audio context, as the
// preview and the Workshop wait for it: `isReady` settles only when ready()
// is called (the processor's first reply, which the vendored lib's isReady
// waits for), the node can dispatch `processorerror`, and the context's state
// and its statechange event are the test's to set. Listeners are counted.
class CountedTarget extends EventTarget {
  listening = new Map();
  addEventListener(type, ...rest) { this.listening.set(type, (this.listening.get(type) ?? 0) + 1); super.addEventListener(type, ...rest); }
  removeEventListener(type, ...rest) { this.listening.set(type, (this.listening.get(type) ?? 0) - 1); super.removeEventListener(type, ...rest); }
}
function newSynth(state) {
  const worklet = new CountedTarget(), context = Object.assign(new CountedTarget(), { state });
  let ready;
  const synth = { worklet, isReady: new Promise(resolve => { ready = resolve; }) };
  const setState = next => { context.state = next; context.dispatchEvent(new Event('statechange')); };
  const unheard = () => worklet.listening.get('processorerror') === 0 && context.listening.get('statechange') === 0;
  return { synth, context, worklet, ready: () => ready(), setState, unheard };
}
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));

test('a new synth that never reports ready, or whose processor fails, ends the wait instead of holding every load behind it', async () => {
  assert.equal(SYNTH_READY_TIMEOUT_MS, 20000);

  // Never ready while its context runs: the limit ends the wait.
  const silent = newSynth('running');
  const waited = await loadTimers(1000, () => synthReadyOrFail(silent.synth, silent.context, { timeoutMs: 1000 }).then(() => null, error => error));
  assert.equal(waited.result?.code, 'SYNTH_READY_TIMEOUT');
  assert.equal(waited.result.timeoutMs, 1000);
  assert.equal(bankLoadMessage(waited.result), '音色試聽引擎在 1 秒內沒有就緒，已停止載入');
  assert.deepEqual(waited.timers, ['ran']);
  assert.ok(silent.unheard(), 'no listener is left behind');

  // The processor stops with an error while starting: at once, with its text.
  const broken = newSynth('running');
  const failing = loadTimers(SYNTH_READY_TIMEOUT_MS, () => synthReadyOrFail(broken.synth, broken.context).then(() => null, error => error));
  await pause(5);
  broken.worklet.dispatchEvent(Object.assign(new Event('processorerror'), { message: 'Uncaught Error: decoder\u0000 failed' }));
  const failed = await failing;
  assert.equal(failed.result?.code, 'SYNTH_FAILED');
  assert.equal(bankLoadMessage(failed.result), '音色試聽引擎無法啟動，已停止載入（Uncaught Error: decoder failed）');
  assert.deepEqual(failed.timers, ['cleared']);
  assert.ok(broken.unheard());

  // A context not yet running (made before any user gesture) is not timed:
  // the processor may rightly wait for it. Once it runs, the clock starts.
  const early = newSynth('suspended');
  let outcome = null;
  const later = loadTimers(300, () => synthReadyOrFail(early.synth, early.context, { timeoutMs: 300 }).then(() => 'ready', error => error)).then(value => { outcome = value; return value; });
  await pause(600);
  assert.equal(outcome, null, 'still waiting while the context is suspended');
  early.setState('running');
  const timed = await later;
  assert.equal(timed.result?.code, 'SYNTH_READY_TIMEOUT');
  assert.deepEqual(timed.timers, ['ran']);
  assert.ok(early.unheard());
  // ... and a processor that answers once the context runs is ready.
  const woken = newSynth('suspended');
  const waking = loadTimers(SYNTH_READY_TIMEOUT_MS, () => synthReadyOrFail(woken.synth, woken.context));
  woken.setState('running');
  woken.ready();
  assert.deepEqual((await waking).timers, ['cleared']);
  assert.ok(woken.unheard());

  // A closed context never runs again.
  const closed = newSynth('closed');
  const refused = await loadTimers(SYNTH_READY_TIMEOUT_MS, () => synthReadyOrFail(closed.synth, closed.context).then(() => null, error => error));
  assert.equal(refused.result?.code, 'SYNTH_FAILED');
  assert.equal(refused.result.message, 'the audio context was closed');
  assert.deepEqual(refused.timers, []);

  // Ready: nothing is left behind.
  const fine = newSynth('running');
  const readying = loadTimers(SYNTH_READY_TIMEOUT_MS, () => synthReadyOrFail(fine.synth, fine.context));
  fine.ready();
  assert.deepEqual((await readying).timers, ['cleared']);
  assert.ok(fine.unheard());
});
