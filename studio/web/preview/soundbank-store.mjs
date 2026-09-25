// The user's sound bank for the timbre preview, kept on this device only.
//
// A separate IndexedDB database from projects (storage.mjs), so the bank is
// never part of a project, a backup export or an import, and never travels
// with a workspace. Nothing here makes a network request: the bytes come from
// a file the user picks and stay in this browser. The free default bank's
// verified subset (default-bank.mjs) is kept here too, under its own key.
import { bankErrorDetail } from './bank-check.mjs';

const DB = 'mml-studio-soundbank';
const STORE = 'banks';
const KEY = 'current';
export const MAX_BANK_BYTES = 64 * 1024 * 1024;
export const BANK_EXTENSIONS = Object.freeze(['.dls', '.sf2', '.sf3']);

function open() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB, 1);
    request.onupgradeneeded = () => request.result.createObjectStore(STORE);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? Error('音色庫儲存區無法開啟'));
    request.onblocked = () => reject(Error('音色庫儲存區被其他分頁占用，請關閉其他 Studio 分頁後重試'));
  });
}
async function transact(mode, work) {
  const db = await open();
  try {
    return await new Promise((resolve, reject) => {
      const tx = db.transaction(STORE, mode);
      let result;
      Promise.resolve(work(tx.objectStore(STORE))).then(value => { result = value; }, reject);
      tx.oncomplete = () => resolve(result);
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error ?? Error('音色庫儲存已中止'));
    });
  } finally { db.close(); }
}
const request = r => new Promise((resolve, reject) => { r.onsuccess = () => resolve(r.result); r.onerror = () => reject(r.error); });

export async function sha256Hex(bytes) {
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(digest)].map(b => b.toString(16).padStart(2, '0')).join('');
}

export const BANK_CHECK_UNAVAILABLE = 'BANK_CHECK_UNAVAILABLE';
export const BANK_CHECK_TIMEOUT = 'BANK_CHECK_TIMEOUT';
export const BANK_CHECKER_LOAD_TIMEOUT = 'BANK_CHECKER_LOAD_TIMEOUT';
// How long the check of a bank of `size` bytes may run before its Worker is
// stopped and the bank refused, in whole seconds: 5 s, plus 1 s for every
// 2 MiB begun (a 64 MiB bank gets 37 s), counted from the moment the Worker
// has loaded its parser and is handed the bank. A 60 MB bank is checked in
// under a second in desktop Chromium, so a slow phone has more than thirty
// times as long. A damaged bank can instead keep the parser allocating until
// the tab crashes (a DLS whose connection count reads as four billion), and
// a pick stays pending while it is checked, with plays and exports waiting
// for it (bank-choices.mjs), so without a limit one such bank would also hold
// them.
export const bankCheckTimeoutMs = size => 5000 + Math.ceil(Math.max(0, size) / 2097152) * 1000;
// How long the Worker may take to load its parser (the vendored core.js,
// about 740 KB, fetched the first time the Worker starts unless the Service
// Worker has cached it) before it is stopped. The download is not the bank's
// doing, so it does not count against the check's own limit; this limit only
// ends a download or module load that hangs.
export const BANK_CHECKER_LOAD_TIMEOUT_MS = 30000;
// Parses a bank off the main thread, in a module Worker with the vendored
// spessasynth_core (bank-check-worker.mjs), the way the default bank is
// trimmed. `bytes` (an ArrayBuffer) is transferred to the Worker once it
// reports that its parser has loaded: pass a copy. Rejects with the loader's
// message when the bank does not parse, with code BANK_CHECK_UNAVAILABLE when
// the Worker itself cannot run, with code BANK_CHECKER_LOAD_TIMEOUT (and
// `timeoutMs`) when it has not loaded within `loadTimeoutMs`, and with code
// BANK_CHECK_TIMEOUT (and `timeoutMs`) when, once loaded, it has not answered
// within `timeoutMs`. The Worker is terminated then, and nothing is said
// about the bank itself.
export function checkBankInWorker(bytes, { timeoutMs = bankCheckTimeoutMs(bytes.byteLength), loadTimeoutMs = BANK_CHECKER_LOAD_TIMEOUT_MS } = {}) {
  return new Promise((resolve, reject) => {
    const unavailable = message => Object.assign(Error(message || 'Worker 無法啟動'), { code: BANK_CHECK_UNAVAILABLE });
    let worker;
    try { worker = new Worker(new URL('./bank-check-worker.mjs', import.meta.url), { type: 'module' }); }
    catch (error) { reject(unavailable(error?.message)); return; }
    let timer = null, loaded = false;
    const done = () => { clearTimeout(timer); worker.terminate(); };
    const limit = (ms, code, what) => setTimeout(() => { done(); reject(Object.assign(Error(`${what} within ${ms} ms`), { code, timeoutMs: ms })); }, ms);
    timer = limit(loadTimeoutMs, BANK_CHECKER_LOAD_TIMEOUT, 'bank checker did not load');
    worker.onmessage = ({ data }) => {
      if (!loaded) {
        if (data?.loaded !== true) { done(); reject(unavailable('the bank checker answered before it had loaded')); return; }
        // The check's own clock starts now, as the bank is handed over.
        loaded = true;
        clearTimeout(timer);
        timer = limit(timeoutMs, BANK_CHECK_TIMEOUT, 'bank check did not finish');
        worker.postMessage({ bytes }, [bytes]);
        return;
      }
      done();
      if (data?.ok) resolve({ presets: data.presets }); else reject(Error(data?.message || '無法解析'));
    };
    worker.onerror = event => { event.preventDefault?.(); done(); reject(unavailable(event.message)); };
  });
}

// Accept a user-picked File, verify its container, check that it parses, and
// keep it. The RIFF header alone does not make a bank: one cut short or
// corrupt past its header would be kept and then fail every later load, after
// every reload, so it is parsed first and refused, with nothing written,
// unless it parses. A check that runs out of time, or a checker that does not
// load in time, refuses the bank too, saying only that: the error keeps code
// BANK_CHECK_TIMEOUT or BANK_CHECKER_LOAD_TIMEOUT and `timeoutMs` so the
// Workshop can say it in its own language. Every other refusal carries a code
// as well: BANK_NOT_A_BANK, BANK_TOO_LARGE (with `maxBytes`),
// BANK_DOES_NOT_PARSE and BANK_CHECK_UNAVAILABLE (with the engine's
// `detail`), and BANK_NOT_STORED (the write itself failed, with the store's
// `detail`). `check` receives a copy of the bytes; tests pass one that runs
// the npm spessasynth_core in-process instead of the Worker.
//
// `current` says whether this pick is still the latest choice
// (bank-choices.mjs). It is asked after the check and again inside the
// write's own transaction, right before the write request, with nothing
// awaited in between; a pick that is no longer the latest writes nothing and
// rejects with code BANK_SUPERSEDED. A newer choice made after that write
// request has been sent cannot stop it, so the store keeps this bank until a
// later write or delete. IndexedDB runs every transaction made after it on
// this store after it: the newer choice's own write or delete, and the read
// its reconcile makes. Storing a bank shows and plays nothing by itself; only
// a reconcile, from what the store keeps, does.
export const BANK_SUPERSEDED = 'BANK_SUPERSEDED';
const refusal = (message, code, extra = {}) => Object.assign(Error(message), { code, ...extra });
const superseded = () => refusal('已選擇較新的音色庫，這個音色庫沒有儲存', BANK_SUPERSEDED);
export async function storeBank(file, { check = checkBankInWorker, current = () => true } = {}) {
  const name = String(file?.name ?? '');
  if (!BANK_EXTENSIONS.some(ext => name.toLowerCase().endsWith(ext))) throw refusal('音色庫需為 .dls、.sf2 或 .sf3 檔案', 'BANK_NOT_A_BANK');
  if (file.size > MAX_BANK_BYTES) throw refusal(`音色庫超過 ${MAX_BANK_BYTES / 1048576} MiB 上限`, 'BANK_TOO_LARGE', { maxBytes: MAX_BANK_BYTES });
  const bytes = await file.arrayBuffer();
  const head = new Uint8Array(bytes, 0, Math.min(12, bytes.byteLength));
  const tag = String.fromCharCode(...head.slice(0, 4)), form = String.fromCharCode(...head.slice(8, 12));
  if (tag !== 'RIFF' || !['DLS ', 'sfbk'].includes(form)) throw refusal('檔案不是 RIFF DLS／SoundFont 音色庫', 'BANK_NOT_A_BANK');
  try { await check(bytes.slice(0)); }
  catch (error) {
    if (error?.code === BANK_CHECK_TIMEOUT) throw refusal(`音色庫在 ${Math.round(error.timeoutMs / 1000)} 秒內沒有完成檢查，沒有儲存`, BANK_CHECK_TIMEOUT, { timeoutMs: error.timeoutMs });
    if (error?.code === BANK_CHECKER_LOAD_TIMEOUT) throw refusal(`檢查音色庫的程式在 ${Math.round(error.timeoutMs / 1000)} 秒內沒有載入，音色庫沒有檢查，也沒有儲存`, BANK_CHECKER_LOAD_TIMEOUT, { timeoutMs: error.timeoutMs });
    const detail = bankErrorDetail(error);
    const unavailable = error?.code === BANK_CHECK_UNAVAILABLE;
    const why = unavailable ? '無法在這個瀏覽器檢查音色庫，沒有儲存' : '音色庫無法解析，沒有儲存';
    throw refusal(detail ? `${why}（${detail}）` : why, unavailable ? BANK_CHECK_UNAVAILABLE : 'BANK_DOES_NOT_PARSE', { detail });
  }
  if (!current()) throw superseded();
  let record;
  try {
    record = { name, size: bytes.byteLength, sha256: await sha256Hex(bytes), format: form.trim(), savedAt: new Date().toISOString(), bytes };
    await transact('readwrite', store => {
      if (!current()) throw superseded();
      return request(store.put(record, KEY));
    });
  } catch (error) {
    if (error?.code === BANK_SUPERSEDED) throw error;
    const detail = bankErrorDetail(error);
    throw refusal(detail ? `音色庫無法存進這台裝置，沒有儲存（${detail}）` : '音色庫無法存進這台裝置，沒有儲存', 'BANK_NOT_STORED', { detail });
  }
  return describe(record);
}
export async function loadBank() {
  const record = await transact('readonly', store => request(store.get(KEY)));
  return record ? { ...describe(record), bytes: record.bytes } : null;
}
// Removes the kept bank. `current`, as for storeBank, is asked inside the
// delete's own transaction, right before the delete request: a removal that
// is no longer the latest choice deletes nothing and rejects with
// BANK_SUPERSEDED. A delete request already sent cannot be stopped either.
export async function clearBank({ current = () => true } = {}) {
  await transact('readwrite', store => {
    if (!current()) throw superseded();
    return request(store.delete(KEY));
  });
}
// The default bank's subset, keyed by its SHA-256 so a later pin never reads
// an older subset. Removing the user's bank leaves it; clearDefaultSubsets
// removes every cached subset.
const SUBSET_PREFIX = 'default-subset:';
export async function loadDefaultSubset(sha256) {
  return (await transact('readonly', store => request(store.get(`${SUBSET_PREFIX}${sha256}`)))) ?? null;
}
export async function hasDefaultSubset(sha256) {
  return (await transact('readonly', store => request(store.count(`${SUBSET_PREFIX}${sha256}`)))) > 0;
}
export async function storeDefaultSubset(record) {
  await transact('readwrite', store => request(store.put(record, `${SUBSET_PREFIX}${record.sha256}`)));
}
export async function clearDefaultSubsets() {
  await transact('readwrite', store => request(store.delete(IDBKeyRange.bound(SUBSET_PREFIX, `${SUBSET_PREFIX}\uffff`))));
}
export const describe = record => ({ name: record.name, size: record.size, sha256: record.sha256, format: record.format, savedAt: record.savedAt });
