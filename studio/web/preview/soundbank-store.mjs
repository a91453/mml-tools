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
// Parses a bank off the main thread, in a module Worker with the vendored
// spessasynth_core (bank-check-worker.mjs), the way the default bank is
// trimmed. `bytes` (an ArrayBuffer) is transferred to the Worker: pass a copy.
// Rejects with the loader's message when the bank does not parse, and with
// code BANK_CHECK_UNAVAILABLE when the Worker itself cannot run.
export function checkBankInWorker(bytes) {
  return new Promise((resolve, reject) => {
    const unavailable = message => Object.assign(Error(message || 'Worker 無法啟動'), { code: BANK_CHECK_UNAVAILABLE });
    let worker;
    try { worker = new Worker(new URL('./bank-check-worker.mjs', import.meta.url), { type: 'module' }); }
    catch (error) { reject(unavailable(error?.message)); return; }
    const done = () => worker.terminate();
    worker.onmessage = ({ data }) => { done(); if (data?.ok) resolve({ presets: data.presets }); else reject(Error(data?.message || '無法解析')); };
    worker.onerror = event => { event.preventDefault?.(); done(); reject(unavailable(event.message)); };
    worker.postMessage({ bytes }, [bytes]);
  });
}

// Accept a user-picked File, verify its container, check that it parses, and
// keep it. The RIFF header alone does not make a bank: one cut short or
// corrupt past its header would be kept and then fail every later load, after
// every reload, so it is parsed first and refused, with nothing written,
// unless it parses. `check` receives a copy of the bytes; tests pass one that
// runs the npm spessasynth_core in-process instead of the Worker.
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
