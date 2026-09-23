// The free default preview bank: a deterministic General MIDI subset of
// FluidR3Mono_GM.sf3 (MIT). Neither the upstream file nor the subset is stored
// in this repository or shipped in the build: the upstream file asks not to be
// redistributed, so each browser fetches it from its original source.
//
// Only when a playback needs it (no bank of the user's own) and this browser
// has no verified subset yet, the page downloads the pinned upstream file from
// MuseScore's own repository, checks its SHA-256, trims it in a Worker
// (default-bank-trim.mjs, the same operations as
// scripts/build-default-soundbank.mjs) and checks the subset's SHA-256. Both
// digests are pinned below and in studio/web/default-bank/provenance.json. A
// mismatch is refused; nothing unverified is ever played. Only the subset is
// kept, in this browser (soundbank-store.mjs), under its own digest.
//
// A bank the user picks always takes precedence. The default is a generic,
// approximate sound: never the game's timbre and never evidence.
import { DEFAULT_BANK_LABEL, DEFAULT_BANK_NAME } from './instruments.mjs';

export const DEFAULT_BANK_UPSTREAM = Object.freeze({
  url: 'https://raw.githubusercontent.com/musescore/MuseScore/v2.3.2/share/sound/FluidR3Mono_GM.sf3',
  sha256: 'cfcd66d89e8386823400eca64934b14fbea7bf48ba1f00d21189af1262794ec2',
  bytes: 14563174,
});
export const DEFAULT_BANK_SUBSET = Object.freeze({
  sha256: 'f41a3077bd83b81b1c64e2bc3eb1d9a30ff1907e674ab805da3fcb805354a633',
  bytes: 1628214,
});
const mb = bytes => (bytes / 1e6).toFixed(1);
export const DEFAULT_BANK_DOWNLOAD_NOTICE = `第一次使用免費音色：將從 MuseScore 官方來源下載約 ${mb(DEFAULT_BANK_UPSTREAM.bytes)} MB，只存在這台裝置`;
const OWN_BANK_HINT = '可改為選擇自己的音色庫（.sf2／.sf3／.dls）後再播放。';

export class DefaultBankError extends Error {
  constructor(code, message) { super(`${message}${OWN_BANK_HINT}`); this.name = 'DefaultBankError'; this.code = code; }
}

const hex = buffer => [...new Uint8Array(buffer)].map(b => b.toString(16).padStart(2, '0')).join('');
const sha256Hex = async bytes => hex(await crypto.subtle.digest('SHA-256', bytes));

// Nothing is read past the pinned size: a longer response cannot match.
async function readBody(response, limit, onProgress) {
  const total = Math.min(Number(response.headers.get('content-length')) || limit, limit);
  if (!response.body?.getReader) {
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (bytes.byteLength > limit) throw new DefaultBankError('DEFAULT_BANK_UPSTREAM_MISMATCH', '下載的檔案大於固定的上游音色庫，已拒絕使用。');
    onProgress({ phase: 'download', received: bytes.byteLength, total });
    return bytes;
  }
  const reader = response.body.getReader();
  const chunks = [];
  let received = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    received += value.byteLength;
    if (received > limit) { reader.cancel().catch(() => {}); throw new DefaultBankError('DEFAULT_BANK_UPSTREAM_MISMATCH', '下載的檔案大於固定的上游音色庫，已拒絕使用。'); }
    chunks.push(value);
    onProgress({ phase: 'download', received, total });
  }
  const bytes = new Uint8Array(received);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  return bytes;
}

// The trim runs in a module Worker with the vendored spessasynth_core.
export function trimInWorker(upstream) {
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL('./default-bank-worker.mjs', import.meta.url), { type: 'module' });
    const done = () => worker.terminate();
    worker.onmessage = ({ data }) => { done(); if (data?.ok) resolve(data.bytes); else reject(Error(data?.message ?? 'Worker 沒有回傳子集')); };
    worker.onerror = event => { event.preventDefault?.(); done(); reject(Error(event.message || 'Worker 無法啟動')); };
    worker.postMessage({ upstream }, [upstream]);
  });
}

async function browserCache() {
  const { loadDefaultSubset, storeDefaultSubset } = await import('./soundbank-store.mjs');
  return { load: loadDefaultSubset, store: storeDefaultSubset };
}

const describe = record => ({ name: DEFAULT_BANK_NAME, label: DEFAULT_BANK_LABEL, size: record.size, sha256: record.sha256, format: 'sfbk', bytes: record.bytes, isDefault: true });

/**
 * The verified default subset: from this browser's cache, or, on a miss,
 * downloaded, verified, trimmed, verified again and cached.
 * Everything that touches the outside is injectable for tests.
 * @returns {Promise<{ name, label, size, sha256, format, bytes: ArrayBuffer, isDefault: true, downloaded: boolean }>}
 */
export async function loadDefaultBank({
  fetchImpl = (...args) => fetch(...args), trim = trimInWorker, cache = null, onProgress = () => {},
  upstream = DEFAULT_BANK_UPSTREAM, subset = DEFAULT_BANK_SUBSET,
} = {}) {
  const store = cache ?? await browserCache();
  // A cached subset is checked again before use; one that no longer matches
  // is treated as absent and replaced.
  const cached = await store.load(subset.sha256).catch(() => null);
  if (cached?.bytes && await sha256Hex(cached.bytes) === subset.sha256) return { ...describe(cached), downloaded: false };

  onProgress({ phase: 'download', received: 0, total: upstream.bytes });
  let response;
  // No cookies, no referrer, and no copy of the upstream file in the HTTP cache.
  try { response = await fetchImpl(upstream.url, { credentials: 'omit', referrerPolicy: 'no-referrer', cache: 'no-store' }); }
  catch (error) { throw new DefaultBankError('DEFAULT_BANK_DOWNLOAD_FAILED', `無法下載免費音色（可能離線或被阻擋：${error?.message ?? error}）。`); }
  if (!response.ok) throw new DefaultBankError('DEFAULT_BANK_DOWNLOAD_FAILED', `無法下載免費音色（HTTP ${response.status}）。`);
  let bytes;
  try { bytes = await readBody(response, upstream.bytes, onProgress); }
  catch (error) { if (error instanceof DefaultBankError) throw error; throw new DefaultBankError('DEFAULT_BANK_DOWNLOAD_FAILED', `免費音色下載中斷（${error?.message ?? error}）。`); }
  if (await sha256Hex(bytes) !== upstream.sha256) throw new DefaultBankError('DEFAULT_BANK_UPSTREAM_MISMATCH', '下載的音色庫與固定的上游 SHA-256 不符，已拒絕使用。');

  onProgress({ phase: 'trim' });
  let trimmed;
  try { trimmed = new Uint8Array(await trim(bytes.buffer)); }
  catch (error) { throw new DefaultBankError('DEFAULT_BANK_TRIM_FAILED', `無法在這個瀏覽器產生免費音色子集（${error?.message ?? error}）。`); }
  if (await sha256Hex(trimmed) !== subset.sha256) throw new DefaultBankError('DEFAULT_BANK_SUBSET_MISMATCH', '這個瀏覽器產生的音色子集與固定的 SHA-256 不符，已拒絕使用。');

  const record = { sha256: subset.sha256, size: trimmed.byteLength, savedAt: new Date().toISOString(), upstream: { url: upstream.url, sha256: upstream.sha256 }, bytes: trimmed.buffer };
  // The verified subset still plays when this browser cannot keep it.
  let stored = true;
  try { await store.store(record); } catch { stored = false; }
  onProgress({ phase: 'done', stored });
  return { ...describe(record), downloaded: true, stored };
}
