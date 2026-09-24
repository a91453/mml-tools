import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import * as core from 'spessasynth_core';
import { BANK_LOAD_TIMEOUT_MS, addSoundBankOrFail, checkSoundBank } from '../web/preview/bank-check.mjs';
import { loadBank, storeBank } from '../web/preview/soundbank-store.mjs';
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

test('a load stops waiting for a bank the worklet cannot parse, or that never loads, and the preview says why', async () => {
  assert.equal(BANK_LOAD_TIMEOUT_MS, 60000);
  const unparsable = worklet({ reply: 'error' });
  const refusal = await addSoundBankOrFail(unparsable, truncated.slice().buffer, 'studio-user-bank').then(() => null, error => error);
  assert.ok(refusal, 'an unparsable bank rejects instead of waiting forever');
  assert.equal(refusal.code, 'BANK_UNPARSABLE');
  assert.equal(refusal.message, 'SF parsing error: Invalid chunk header! Expected "list" got " " The file may be corrupted.');
  assert.equal(bankLoadMessage(refusal), '音色庫無法解析，已停止載入（SF parsing error: Invalid chunk header! Expected "list" got " " The file may be corrupted.）');
  assert.equal(unparsable.listenersAtSend, 1, 'the error listener is in place before the bank is sent');
  assert.equal(unparsable.listeners('soundBankError'), 0, 'and removed once the load is settled');

  const silent = worklet({ reply: 'silent' });
  const timedOut = await addSoundBankOrFail(silent, bank.slice().buffer, 'studio-user-bank', { timeoutMs: 1000 }).then(() => null, error => error);
  assert.equal(timedOut?.code, 'BANK_LOAD_TIMEOUT');
  assert.equal(bankLoadMessage(timedOut), '音色庫在 1 秒內沒有載入完成，已停止載入');
  assert.equal(silent.listeners('soundBankError'), 0);

  const ready = worklet({ reply: 'ready' });
  await addSoundBankOrFail(ready, bank.slice().buffer, 'studio-user-bank');
  assert.equal(ready.sent.id, 'studio-user-bank');
  assert.equal(ready.listeners('soundBankError'), 0, 'a loaded bank leaves no listener or timer behind');
});
