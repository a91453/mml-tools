// The game-style bank: the owner's own recordings of the 11 game instruments
// (a DLS and its instrument list). Like the free default bank it is never
// stored in this repository or shipped in the build; the permanent Studio Web
// serves it from its own origin at a path named by its SHA-256
// (ops/permanent/sound-banks.json pins the same digests).
//
// Only when a playback needs it and the user chose it, the page downloads the
// pinned file from this site, checks its size and SHA-256 and keeps it in this
// browser (soundbank-store.mjs) under its own digest. A mismatch is refused;
// nothing unverified is ever played. A server without the bank (a local or
// test server) answers 404, and the page says so.
//
// It is a listening aid: a simulation of the game's timbre, never the game
// itself and never evidence.
import { GAME_STYLE_BANK_LABEL, GAME_STYLE_BANK_NAME } from './instruments.mjs';

export const GAME_STYLE_BANK = Object.freeze({
  path: 'banks/game-style/7671125ed267c2ff9b0d05f10d64fe398d1606674d813fbcc3fbb3baa5a05983.dls',
  sha256: '7671125ed267c2ff9b0d05f10d64fe398d1606674d813fbcc3fbb3baa5a05983',
  bytes: 15324240,
});
export const GAME_STYLE_DEF = Object.freeze({
  path: 'banks/game-style/f224edf5b3c21bab3119e8c47230141dcdc6fb634b6c780779c4d8c20e137dc2.def',
  sha256: 'f224edf5b3c21bab3119e8c47230141dcdc6fb634b6c780779c4d8c20e137dc2',
  bytes: 4036,
});
// This module sits at studio/web/preview/; the banks are served at the root.
export const siteUrl = path => new URL(`../../../${path}`, import.meta.url).href;
const mb = bytes => (bytes / 1e6).toFixed(1);
export const GAME_STYLE_DOWNLOAD_NOTICE = `第一次使用遊戲風格音色：將從本網站下載約 ${mb(GAME_STYLE_BANK.bytes)} MB，只存在這台裝置`;

export class GameStyleBankError extends Error {
  constructor(code, message) { super(message); this.name = 'GameStyleBankError'; this.code = code; }
}

const hex = buffer => [...new Uint8Array(buffer)].map(b => b.toString(16).padStart(2, '0')).join('');
export const sha256Hex = async bytes => hex(await crypto.subtle.digest('SHA-256', bytes));

// Nothing is read past the pinned size: a longer response cannot match.
export async function readPinned(response, pin, onProgress = () => {}) {
  const tooLarge = () => new GameStyleBankError('GAME_STYLE_BANK_MISMATCH', '下載的檔案大於固定的遊戲風格音色，已拒絕使用。');
  if (!response.body?.getReader) {
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (bytes.byteLength > pin.bytes) throw tooLarge();
    onProgress({ phase: 'download', received: bytes.byteLength, total: pin.bytes });
    return bytes;
  }
  const reader = response.body.getReader();
  const chunks = [];
  let received = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    received += value.byteLength;
    if (received > pin.bytes) { reader.cancel().catch(() => {}); throw tooLarge(); }
    chunks.push(value);
    onProgress({ phase: 'download', received, total: pin.bytes });
  }
  const bytes = new Uint8Array(received);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  return bytes;
}

/**
 * Download one pinned file of the game-style bank from this site and check it.
 * @returns {Promise<Uint8Array>}
 */
export async function fetchPinned(pin, { fetchImpl = (...args) => fetch(...args), onProgress = () => {} } = {}) {
  let response;
  // The bank lives in this browser's store; the HTTP cache keeps no copy.
  try { response = await fetchImpl(siteUrl(pin.path), { credentials: 'same-origin', cache: 'no-store' }); }
  catch (error) { throw new GameStyleBankError('GAME_STYLE_BANK_DOWNLOAD_FAILED', `無法下載遊戲風格音色（可能離線：${error?.message ?? error}）。`); }
  if (response.status === 404) throw new GameStyleBankError('GAME_STYLE_BANK_ABSENT', '這個網站沒有提供遊戲風格音色（只有正式網站提供）。');
  if (!response.ok) throw new GameStyleBankError('GAME_STYLE_BANK_DOWNLOAD_FAILED', `無法下載遊戲風格音色（HTTP ${response.status}），請稍後再試。`);
  let bytes;
  try { bytes = await readPinned(response, pin, onProgress); }
  catch (error) { if (error instanceof GameStyleBankError) throw error; throw new GameStyleBankError('GAME_STYLE_BANK_DOWNLOAD_FAILED', `遊戲風格音色下載中斷（${error?.message ?? error}）。`); }
  if (bytes.byteLength !== pin.bytes || await sha256Hex(bytes) !== pin.sha256) throw new GameStyleBankError('GAME_STYLE_BANK_MISMATCH', '下載的遊戲風格音色與固定的 SHA-256 不符，已拒絕使用。');
  return bytes;
}

async function browserCache() {
  const { loadPresetBank, storePresetBank } = await import('./soundbank-store.mjs');
  return { load: loadPresetBank, store: storePresetBank };
}

const describe = record => ({ name: GAME_STYLE_BANK_NAME, label: GAME_STYLE_BANK_LABEL, size: record.size, sha256: record.sha256, format: 'DLS', bytes: record.bytes, isDefault: true, preset: 'game-style' });

// One pinned file from this browser's store or, on a miss, downloaded from
// this site, verified and kept. A kept copy is checked again before use; one
// that no longer matches is treated as absent and replaced. With `keptOnly`
// a miss answers null and nothing is downloaded.
async function loadKept(pin, { fetchImpl, cache = null, onProgress = () => {}, keptOnly = false }) {
  const store = cache ?? await browserCache();
  const cached = await store.load(pin.sha256).catch(() => null);
  if (cached?.bytes && await sha256Hex(cached.bytes) === pin.sha256) return { record: cached, downloaded: false };
  if (keptOnly) return null;
  onProgress({ phase: 'download', received: 0, total: pin.bytes });
  const bytes = await fetchPinned(pin, { fetchImpl, onProgress });
  const record = { sha256: pin.sha256, size: bytes.byteLength, savedAt: new Date().toISOString(), source: pin.path, bytes: bytes.buffer };
  // The verified file is still used when this browser cannot keep it.
  let stored = true;
  try { await store.store(record); } catch { stored = false; }
  onProgress({ phase: 'done', stored });
  return { record, downloaded: true, stored };
}

/**
 * The verified game-style bank. Everything that touches the outside is
 * injectable for tests. With `keptOnly`, null unless this browser keeps it.
 */
export async function loadGameStyleBank({ pin = GAME_STYLE_BANK, ...options } = {}) {
  const kept = await loadKept(pin, options);
  return kept && { ...describe(kept.record), downloaded: kept.downloaded, ...(kept.downloaded ? { stored: kept.stored } : {}) };
}

/** The bank's verified instrument list (.def), for the Workshop's names. */
export async function loadGameStyleDef({ pin = GAME_STYLE_DEF, ...options } = {}) {
  const kept = await loadKept(pin, options);
  return kept && kept.record.bytes;
}
