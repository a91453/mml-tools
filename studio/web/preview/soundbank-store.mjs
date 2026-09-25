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

const BANK_CHECK_UNAVAILABLE = 'BANK_CHECK_UNAVAILABLE';
export const BANK_CHECK_TIMEOUT = 'BANK_CHECK_TIMEOUT';
export const BANK_CHECKER_LOAD_TIMEOUT = 'BANK_CHECKER_LOAD_TIMEOUT';
// How long the check of a bank of `size` bytes may run before its Worker is
// stopped and the bank refused, in whole seconds: 5 s, plus 1 s for every
// 2 MiB begun (a 64 MiB bank gets 37 s), counted from the moment the Worker
// has loaded its parser and is handed the bank. A 60 MB bank is checked in
// under a second in desktop Chromium, so a slow phone has more than thirty
// times as long. A damaged bank can instead keep the parser allocating until
// the tab crashes (a DLS whose connection count reads as four billion), and a
// Workshop pick is checked inside its bank queue, so without a limit one such
// bank would also hold every later load.
export const bankCheckTimeoutMs = size => 5000 + Math.ceil(Math.max(0, size) / 2097152) * 1000;
// How long the Worker may take to load its parser (the vendored core.js,
// about 740 KB, downloaded on a first visit before the Service Worker has
// cached it) before it is stopped. The download is not the bank's doing, so
// it does not count against the check's own limit: a slow one would refuse a
// valid bank, and every retry too, since stopping the Worker cancels it. This
// limit only ends a load that hangs.
export const BANK_CHECKER_LOAD_TIMEOUT_MS = 30000;
// Parses a bank off the main thread, in a module Worker with the vendored
// spessasynth_core (bank-check-worker.mjs), the way the default bank is
// trimmed. `bytes` (an ArrayBuffer) is transferred to the Worker once it
// reports that its parser has loaded: pass a copy. Rejects with the loader's
// message when the bank does not parse, with code BANK_CHECK_UNAVAILABLE when
// the Worker itself cannot run, with code BANK_CHECKER_LOAD_TIMEOUT (and
// `timeoutMs`) when it has not loaded within `loadTimeoutMs`, and with code
// BANK_CHECK_TIMEOUT (and `timeoutMs`) when, once loaded, it has not answered
// within `timeoutMs`; the Worker is terminated then, and nothing is said
// about the bank itself.
export function checkBankInWorker(bytes, { timeoutMs = bankCheckTimeoutMs(bytes.byteLength), loadTimeoutMs = BANK_CHECKER_LOAD_TIMEOUT_MS } = {}) {
  return new Promise((resolve, reject) => {
    const unavailable = message => Object.assign(Error(message || 'Worker 無法啟動'), { code: BANK_CHECK_UNAVAILABLE });
    let worker;
    try { worker = new Worker(new URL('./bank-check-worker.mjs', import.meta.url), { type: 'module' }); }
    catch (error) { reject(unavailable(error?.message)); return; }
    let timer = 0, loaded = false;
    const done = () => { clearTimeout(timer); worker.terminate(); };
    const limit = (ms, code, what) => setTimeout(() => { done(); reject(Object.assign(Error(`${what} within ${ms} ms`), { code, timeoutMs: ms })); }, ms);
    timer = limit(loadTimeoutMs, BANK_CHECKER_LOAD_TIMEOUT, 'bank checker did not load');
    worker.onmessage = ({ data }) => {
      if (!loaded) {
        if (data?.loaded !== true) { done(); reject(unavailable('the bank checker answered before it had loaded')); return; }
        // Loaded: the check's own clock starts as the bank is handed over.
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
// Workshop can say it in its own language. `check` receives a copy of
// the bytes; tests pass one that runs the npm spessasynth_core in-process
// instead of the Worker.
export async function storeBank(file, { check = checkBankInWorker } = {}) {
  const name = String(file?.name ?? '');
  if (!BANK_EXTENSIONS.some(ext => name.toLowerCase().endsWith(ext))) throw Error('音色庫需為 .dls、.sf2 或 .sf3 檔案');
  if (file.size > MAX_BANK_BYTES) throw Error(`音色庫超過 ${MAX_BANK_BYTES / 1048576} MiB 上限`);
  const bytes = await file.arrayBuffer();
  const head = new Uint8Array(bytes, 0, Math.min(12, bytes.byteLength));
  const tag = String.fromCharCode(...head.slice(0, 4)), form = String.fromCharCode(...head.slice(8, 12));
  if (tag !== 'RIFF' || !['DLS ', 'sfbk'].includes(form)) throw Error('檔案不是 RIFF DLS／SoundFont 音色庫');
  try { await check(bytes.slice(0)); }
  catch (error) {
    if (error?.code === BANK_CHECK_TIMEOUT) throw Object.assign(Error(`音色庫在 ${Math.round(error.timeoutMs / 1000)} 秒內沒有完成檢查，沒有儲存`), { code: BANK_CHECK_TIMEOUT, timeoutMs: error.timeoutMs });
    if (error?.code === BANK_CHECKER_LOAD_TIMEOUT) throw Object.assign(Error(`檢查音色庫的程式在 ${Math.round(error.timeoutMs / 1000)} 秒內沒有載入，音色庫沒有檢查，也沒有儲存`), { code: BANK_CHECKER_LOAD_TIMEOUT, timeoutMs: error.timeoutMs });
    const detail = bankErrorDetail(error);
    const why = error?.code === BANK_CHECK_UNAVAILABLE ? '無法在這個瀏覽器檢查音色庫，沒有儲存' : '音色庫無法解析，沒有儲存';
    throw Error(detail ? `${why}（${detail}）` : why);
  }
  const record = { name, size: bytes.byteLength, sha256: await sha256Hex(bytes), format: form.trim(), savedAt: new Date().toISOString(), bytes };
  await transact('readwrite', store => request(store.put(record, KEY)));
  return describe(record);
}
export async function loadBank() {
  const record = await transact('readonly', store => request(store.get(KEY)));
  return record ? { ...describe(record), bytes: record.bytes } : null;
}
export async function clearBank() {
  await transact('readwrite', store => request(store.delete(KEY)));
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
