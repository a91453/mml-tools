// bzip2 decoder for the 3MLE extension block (community-formats.mjs).
// Ported from the owner's earlier frontend via the Studio Workshop
// (studio/web/workshop/bzip2.mjs; owner-authorized port, 2026-09-23).
// Decoding only: Studio intake reads a file and never writes one, so the
// compressor stays in the Workshop. Every block is CRC-checked and the output
// is bounded by `maxOut`.
const MAX_CODE_LEN = 23;

const GROUP_SIZE = 50;

const BLOCK_MAGIC = "314159265359";
const END_MAGIC   = "177245385090";

const DEFAULT_MAX_OUT = 8 << 20;

const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i << 24;
    for (let k = 0; k < 8; k++) c = (c << 1) ^ (c & 0x80000000 ? 0x04C11DB7 : 0);
    t[i] = c;
  }
  return t;
})();

class BitReader {
  constructor(bytes) {
    this.b = bytes;
    this.pos = 0;
    this.bit = 0;
  }
  read1() {
    if (this.pos >= this.b.length) throw new Error("bzip2: 資料在中途就結束了");
    const v = (this.b[this.pos] >> (7 - this.bit)) & 1;
    if (++this.bit === 8) { this.bit = 0; this.pos++; }
    return v;
  }
  read(n) {
    let v = 0;
    for (let i = 0; i < n; i++) v = (v << 1) | this.read1();
    return v >>> 0;
  }
  readHex(n) {
    let s = "";
    for (let i = 0; i < n; i += 4) s += this.read(4).toString(16);
    return s;
  }
}

function buildTable(lengths, alphaSize) {
  let minLen = 32, maxLen = 0;
  for (let i = 0; i < alphaSize; i++) {
    if (lengths[i] > maxLen) maxLen = lengths[i];
    if (lengths[i] < minLen) minLen = lengths[i];
  }

  const perm = new Int32Array(alphaSize);
  let pp = 0;
  for (let len = minLen; len <= maxLen; len++)
    for (let sym = 0; sym < alphaSize; sym++)
      if (lengths[sym] === len) perm[pp++] = sym;

  const base = new Int32Array(MAX_CODE_LEN + 2);
  const limit = new Int32Array(MAX_CODE_LEN + 2);
  for (let i = 0; i < alphaSize; i++) base[lengths[i] + 1]++;
  for (let i = 1; i < MAX_CODE_LEN + 2; i++) base[i] += base[i - 1];

  let vec = 0;
  for (let len = minLen; len <= maxLen; len++) {
    vec += base[len + 1] - base[len];
    limit[len] = vec - 1;
    vec <<= 1;
  }
  for (let len = minLen + 1; len <= maxLen; len++)
    base[len] = ((limit[len - 1] + 1) << 1) - base[len];

  return { limit, base, perm, minLen, maxLen };
}

function readSym(br, t) {
  let len = t.minLen;
  let v = br.read(len);
  while (len <= MAX_CODE_LEN && v > t.limit[len]) {
    v = (v << 1) | br.read1();
    len++;
  }
  const i = v - t.base[len];
  if (len > t.maxLen || i < 0 || i >= t.perm.length)
    throw new Error("bzip2: Huffman 碼壞了");
  return t.perm[i];
}

function readSymbolMap(br) {
  const groups = br.read(16);
  const used = [];
  for (let g = 0; g < 16; g++) {
    if (!(groups & (0x8000 >> g))) continue;
    const bits = br.read(16);
    for (let k = 0; k < 16; k++) if (bits & (0x8000 >> k)) used.push(g * 16 + k);
  }
  if (!used.length) throw new Error("bzip2: 區塊沒有任何符號");
  return used;
}

function readSelectors(br, nGroups, nSelectors) {
  const mtf = Array.from({ length: nGroups }, (_, i) => i);
  const out = new Uint8Array(nSelectors);
  for (let i = 0; i < nSelectors; i++) {
    let j = 0;
    while (br.read1()) {
      if (++j >= nGroups) throw new Error("bzip2: selector 超出範圍");
    }
    out[i] = mtf[j];
    mtf.splice(j, 1);
    mtf.unshift(out[i]);
  }
  return out;
}

function readLengths(br, nGroups, alphaSize) {
  const tables = [];
  for (let g = 0; g < nGroups; g++) {
    const lens = new Uint8Array(alphaSize);
    let cur = br.read(5);
    for (let s = 0; s < alphaSize; s++) {
      for (;;) {
        if (cur < 1 || cur > 20) throw new Error("bzip2: 碼長超出範圍");
        if (!br.read1()) break;
        cur += br.read1() ? -1 : 1;
      }
      lens[s] = cur;
    }
    tables.push(buildTable(lens, alphaSize));
  }
  return tables;
}

function decodeMTF(br, used, tables, selectors, maxBlock) {
  const alphaSize = used.length + 2;
  const EOB = alphaSize - 1;
  const mtf = used.slice();
  const out = new Uint8Array(maxBlock);
  let n = 0;

  let groupNo = -1, groupPos = 0, table = null;
  const next = () => {
    if (groupPos === 0) {
      if (++groupNo >= selectors.length) throw new Error("bzip2: selector 用完了");
      groupPos = GROUP_SIZE;
      table = tables[selectors[groupNo]];
    }
    groupPos--;
    return readSym(br, table);
  };

  const push = (byte, count) => {
    if (n + count > out.length) throw new Error("bzip2: 區塊比宣告的還大");
    out.fill(byte, n, n + count);
    n += count;
  };

  let sym = next();
  while (sym !== EOB) {
    if (sym <= 1) {
      let run = 0, N = 1;
      do {
        if (N > maxBlock) throw new Error("bzip2: run 長度失控");
        run += (sym + 1) * N;
        N <<= 1;
        sym = next();
      } while (sym <= 1);
      push(mtf[0], run);
      continue;
    }
    const j = sym - 1;
    if (j >= mtf.length) throw new Error("bzip2: MTF 索引超出範圍");
    const byte = mtf[j];
    mtf.splice(j, 1);
    mtf.unshift(byte);
    push(byte, 1);
    sym = next();
  }
  return out.subarray(0, n);
}

function inverseBWT(block, origPtr) {
  const n = block.length;
  if (origPtr >= n) throw new Error("bzip2: origPtr 超出區塊");
  const cftab = new Int32Array(257);
  for (let i = 0; i < n; i++) cftab[block[i] + 1]++;
  for (let i = 1; i < 257; i++) cftab[i] += cftab[i - 1];

  const T = new Int32Array(n);
  for (let i = 0; i < n; i++) T[cftab[block[i]]++] = i;

  const out = new Uint8Array(n);
  let p = T[origPtr];
  for (let i = 0; i < n; i++) { out[i] = block[p]; p = T[p]; }
  return out;
}

function undoRLE(data, limit) {
  let cap = Math.min(limit, Math.max(64, data.length * 2));
  let out = new Uint8Array(cap);
  let n = 0;
  const put = (byte, count) => {
    if (n + count > limit) throw new Error("bzip2: 解出來的資料超過上限");
    if (n + count > cap) {
      cap = Math.min(limit, Math.max(n + count, cap * 2));
      const bigger = new Uint8Array(cap);
      bigger.set(out.subarray(0, n));
      out = bigger;
    }
    if (count === 1) out[n++] = byte;
    else { out.fill(byte, n, n + count); n += count; }
  };

  let run = 0, prev = -1;
  for (let i = 0; i < data.length; i++) {
    const b = data[i];
    if (run === 4) {
      if (b) put(prev, b);
      run = 0; prev = -1;
      continue;
    }
    run = b === prev ? run + 1 : 1;
    prev = b;
    put(b, 1);
  }
  if (run === 4) throw new Error("bzip2: RLE 的長度位元組不見了");
  return out.subarray(0, n);
}

function crcOf(bytes) {
  let c = -1;
  for (let i = 0; i < bytes.length; i++)
    c = (c << 8) ^ CRC_TABLE[((c >>> 24) ^ bytes[i]) & 0xff];
  return (~c) >>> 0;
}

export function decompress(bytes, { maxOut = DEFAULT_MAX_OUT } = {}) {
  const b = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  if (b.length < 4 || b[0] !== 0x42 || b[1] !== 0x5A || b[2] !== 0x68)
    throw new Error("bzip2: 不是 BZh 開頭");
  const level = b[3] - 0x30;
  if (level < 1 || level > 9) throw new Error("bzip2: 區塊大小等級不合法");
  const maxBlock = level * 100000;

  const br = new BitReader(b);
  br.pos = 4;

  const chunks = [];
  let total = 0;

  for (;;) {
    const magic = br.readHex(48);
    if (magic === END_MAGIC) { br.read(32); break; }
    if (magic !== BLOCK_MAGIC) throw new Error("bzip2: 區塊魔數不對");

    const wantCrc = br.read(32);
    if (br.read1()) throw new Error("bzip2: 不支援 randomised 區塊");
    const origPtr = br.read(24);

    const used = readSymbolMap(br);
    const nGroups = br.read(3);
    if (nGroups < 2 || nGroups > 6) throw new Error("bzip2: Huffman 表數不合法");
    const nSelectors = br.read(15);
    if (nSelectors < 1) throw new Error("bzip2: 沒有 selector");
    const selectors = readSelectors(br, nGroups, nSelectors);
    const tables = readLengths(br, nGroups, used.length + 2);

    const mtfOut = decodeMTF(br, used, tables, selectors, maxBlock);
    const bwt = inverseBWT(mtfOut, origPtr);

    const out = undoRLE(bwt, maxOut - total);
    if (crcOf(out) !== wantCrc) throw new Error("bzip2: 區塊 CRC 對不上");

    chunks.push(out);
    total += out.length;
  }

  if (chunks.length === 1) return chunks[0];
  const all = new Uint8Array(total);
  let at = 0;
  for (const c of chunks) { all.set(c, at); at += c.length; }
  return all;
}

class BitWriter {
  constructor() { this.bytes = []; this.cur = 0; this.n = 0; }
  write1(b) {
    this.cur = (this.cur << 1) | (b & 1);
    if (++this.n === 8) { this.bytes.push(this.cur & 0xff); this.cur = 0; this.n = 0; }
  }
  write(v, bits) { for (let i = bits - 1; i >= 0; i--) this.write1((v >>> i) & 1); }
  writeHex(s) { for (const c of s) this.write(parseInt(c, 16), 4); }
  finish() {
    while (this.n) this.write1(0);
    return Uint8Array.from(this.bytes);
  }
}

