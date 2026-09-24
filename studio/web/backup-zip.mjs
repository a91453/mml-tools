// ZIP container for "back up every project at once" (Safari may evict local
// data; one file is easier to keep than one per project). The idea comes from
// the owner's earlier frontend batch download; the code is written here and adds the
// reader Studio needs for restore.
//
// Writer: deflate-raw through CompressionStream when available, stored
// otherwise. Reader: stored and deflate entries, CRC-32 verified, with entry
// and size limits so a hostile archive cannot exhaust memory. Restore still
// goes through importWorkspace() for every entry, which re-validates each
// project and turns its reviews into history.

export const MAX_ENTRIES = 500;
export const MAX_ENTRY_BYTES = 16 * 1024 * 1024;
export const MAX_TOTAL_BYTES = 256 * 1024 * 1024;

// The backup JSON of one project. Restore (model.mjs importWorkspace) rebuilds
// a Raw MIDI asset from the source bytes it carries and never reads the
// project, event list or diagnostics stored beside them, so those are left
// out. They were over 90% of a MIDI project's backup: a 5,000-note MIDI in two
// slots came to 16.2 MiB, over the 16 MiB a restore accepts, so the backups
// the page asks the owner to keep could not be restored. 'MIDI' is
// midi-source.mjs MIDI_SOURCE_FORMAT, inlined so the page does not load the
// MIDI decoder to write a backup.
export function portableBackup(workspace, canonical) {
  const assets = {};
  for (const [slot, asset] of Object.entries(workspace?.assets ?? {})) {
    assets[slot] = asset?.format === 'MIDI' && typeof asset.source?.bytesBase64 === 'string'
      ? { format: asset.format, name: asset.name, source: asset.source }
      : asset;
  }
  return JSON.stringify({ ...workspace, assets, canonical }, null, 2);
}

const TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();
export function crc32(bytes) {
  let crc = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) crc = TABLE[(crc ^ bytes[i]) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

async function transform(bytes, stream) {
  const out = new Blob([bytes]).stream().pipeThrough(stream);
  return new Uint8Array(await new Response(out).arrayBuffer());
}
// Inflates no more than `limit` bytes. An entry that declares a small size
// and inflates to far more used to be inflated in full before its declared
// size was compared: a 300 KB file reached 1.3 GB, enough to kill a phone
// tab. The stream is cancelled as soon as the output passes the declared size.
async function inflateAtMost(bytes, limit, name) {
  const reader = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('deflate-raw')).getReader();
  const chunks = [];
  let length = 0;
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    length += value.length;
    if (length > limit) {
      await reader.cancel().catch(() => {});
      throw Error(`${name} 的內容校驗失敗`);
    }
    chunks.push(value);
  }
  const out = new Uint8Array(length);
  let at = 0;
  for (const chunk of chunks) { out.set(chunk, at); at += chunk.length; }
  return out;
}
const canDeflate = () => typeof CompressionStream === 'function';
const canInflate = () => typeof DecompressionStream === 'function';

// DOS date/time for the local header (seconds halved, years from 1980).
function dosTime(date) {
  const time = (date.getHours() << 11) | (date.getMinutes() << 5) | Math.floor(date.getSeconds() / 2);
  const day = ((date.getFullYear() - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate();
  return { time, day };
}

/** @param {Array<{name:string, data:Uint8Array}>} files */
export async function zipFiles(files, { date = new Date(), compress = true } = {}) {
  if (files.length > MAX_ENTRIES) throw Error(`備份檔案數超過 ${MAX_ENTRIES}`);
  const encoder = new TextEncoder();
  const { time, day } = dosTime(date);
  const locals = [], centrals = [];
  let offset = 0;
  const seen = new Set();
  for (const file of files) {
    let name = file.name;
    // Case-insensitive de-duplication, so an archive never has two entries a
    // case-folding filesystem would merge.
    for (let n = 2; seen.has(name.toLowerCase()); n++) name = file.name.replace(/(\.[^.]*)?$/, ext => `-${n}${ext ?? ''}`);
    seen.add(name.toLowerCase());
    const nameBytes = encoder.encode(name);
    const crc = crc32(file.data);
    const deflated = compress && canDeflate() ? await transform(file.data, new CompressionStream('deflate-raw')) : null;
    const useDeflate = deflated && deflated.length < file.data.length;
    const body = useDeflate ? deflated : file.data;
    const method = useDeflate ? 8 : 0;
    const local = new DataView(new ArrayBuffer(30));
    local.setUint32(0, 0x04034b50, true); local.setUint16(4, 20, true); local.setUint16(6, 0x0800, true);
    local.setUint16(8, method, true); local.setUint16(10, time, true); local.setUint16(12, day, true);
    local.setUint32(14, crc, true); local.setUint32(18, body.length, true); local.setUint32(22, file.data.length, true);
    local.setUint16(26, nameBytes.length, true); local.setUint16(28, 0, true);
    locals.push(new Uint8Array(local.buffer), nameBytes, body);
    const central = new DataView(new ArrayBuffer(46));
    central.setUint32(0, 0x02014b50, true); central.setUint16(4, 20, true); central.setUint16(6, 20, true);
    central.setUint16(8, 0x0800, true); central.setUint16(10, method, true); central.setUint16(12, time, true);
    central.setUint16(14, day, true); central.setUint32(16, crc, true); central.setUint32(20, body.length, true);
    central.setUint32(24, file.data.length, true); central.setUint16(28, nameBytes.length, true);
    central.setUint32(42, offset, true);
    centrals.push(new Uint8Array(central.buffer), nameBytes);
    offset += 30 + nameBytes.length + body.length;
  }
  const centralSize = centrals.reduce((sum, part) => sum + part.length, 0);
  const end = new DataView(new ArrayBuffer(22));
  end.setUint32(0, 0x06054b50, true); end.setUint16(8, files.length, true); end.setUint16(10, files.length, true);
  end.setUint32(12, centralSize, true); end.setUint32(16, offset, true);
  return new Uint8Array(await new Blob([...locals, ...centrals, new Uint8Array(end.buffer)]).arrayBuffer());
}

/** @returns {Promise<Array<{name:string, data:Uint8Array}>>} */
export async function unzipFiles(input) {
  const bytes = input instanceof Uint8Array ? input : new Uint8Array(input);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let eocd = -1;
  for (let i = bytes.length - 22; i >= Math.max(0, bytes.length - 22 - 0xffff); i--) {
    if (view.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw Error('不是有效的 ZIP 備份檔');
  const count = view.getUint16(eocd + 10, true);
  if (count > MAX_ENTRIES) throw Error(`備份檔案數超過 ${MAX_ENTRIES}`);
  let at = view.getUint32(eocd + 16, true);
  const decoder = new TextDecoder();
  const files = [];
  let total = 0;
  for (let n = 0; n < count; n++) {
    if (at + 46 > bytes.length || view.getUint32(at, true) !== 0x02014b50) throw Error('ZIP 目錄損毀');
    const method = view.getUint16(at + 10, true);
    const crc = view.getUint32(at + 16, true);
    const packed = view.getUint32(at + 20, true);
    const size = view.getUint32(at + 24, true);
    const nameLength = view.getUint16(at + 28, true);
    const extra = view.getUint16(at + 30, true), comment = view.getUint16(at + 32, true);
    const localAt = view.getUint32(at + 42, true);
    const name = decoder.decode(bytes.subarray(at + 46, at + 46 + nameLength));
    at += 46 + nameLength + extra + comment;
    if (name.endsWith('/')) continue;
    if (size > MAX_ENTRY_BYTES) throw Error(`${name} 超過 ${MAX_ENTRY_BYTES / 1048576} MiB`);
    total += size;
    if (total > MAX_TOTAL_BYTES) throw Error('備份內容總量過大');
    if (view.getUint32(localAt, true) !== 0x04034b50) throw Error(`${name} 的檔頭損毀`);
    const start = localAt + 30 + view.getUint16(localAt + 26, true) + view.getUint16(localAt + 28, true);
    const body = bytes.subarray(start, start + packed);
    let data;
    if (method === 0) data = body;
    else if (method === 8) {
      if (!canInflate()) throw Error('此瀏覽器無法解壓縮 ZIP 備份');
      data = await inflateAtMost(body, size, name);
    } else throw Error(`${name} 使用不支援的壓縮方式`);
    if (data.length !== size || crc32(data) !== crc) throw Error(`${name} 的內容校驗失敗`);
    files.push({ name, data });
  }
  return files;
}
