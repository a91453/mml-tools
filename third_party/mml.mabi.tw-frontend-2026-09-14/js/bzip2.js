// ────────────────────────────────────────────────────────────────────────────
//  bzip2 解壓縮與壓縮
//
//  存在的唯一理由：3MLE 的 `.mml` 把樂器與軌名鎖在 `[3MLE EXTENSION]` 的 bzip2 blob
//  裡，而**瀏覽器的 DecompressionStream 只有 gzip / deflate / deflate-raw**。
//
//  **壓縮端不追求跟 libbzip2 逐位元組相同**，只追求「解得開、而且是合法的 bzip2」。
//  跟 MML 完全無關 —— 進來 Uint8Array、出去 Uint8Array，所以它自己就測得完。
//
//  **randomized block** 沒有實作，會丟例外：bzip2 0.9.0 之後的壓縮器一個都不會產生
//  它，而它真的出現時安靜地解出垃圾更糟。
//
//  每個區塊的 CRC 都驗。bzip2 用的**不是** zlib 那個 CRC-32：多項式一木樣（0x04C11DB7）
//  但不做位元反射、而且是 MSB-first 進料，也就是 CRC-32/BZIP2 —— 拿 zlib.crc32 來驗會
//  每一塊都失敗。（`[3MLE EXTENSION]` 外層表頭裡那個又是**另一個**：標準 zlib CRC-32，
//  算的是壓縮後的位元組。見 mml-ext.js。）
// ────────────────────────────────────────────────────────────────────────────

/** 碼長上限，跟 bzip2 的 BZ_MAX_CODE_LEN 一致。 */
const MAX_CODE_LEN = 23;

/** 一個 selector 管幾個符號。bzip2 的 BZ_G_SIZE。 */
const GROUP_SIZE = 50;

const BLOCK_MAGIC = "314159265359";
const END_MAGIC   = "177245385090";

/**
 * 解壓縮的產出上限（bytes）。**壓縮炸彈的煞車**：bzip2 的膨脹率上限很高，而這個 decoder
 * 吃的是使用者拖進來的檔案。3MLE 實際產出的 payload 是 217–690 bytes，所以 8 MB 離真實
 * 用量有四個數量級的餘裕，卻仍然擋得住「10 KB 的 d= 解出 1 GB」。呼叫端可以指定更小的值。
 */
const DEFAULT_MAX_OUT = 8 << 20;

/** CRC-32/BZIP2 的查表。反射版（zlib 那個）在這裡是錯的，見檔頭。 */
const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i << 24;
    for (let k = 0; k < 8; k++) c = (c << 1) ^ (c & 0x80000000 ? 0x04C11DB7 : 0);
    t[i] = c;
  }
  return t;
})();

/**
 * MSB-first 的位元讀取器。bzip2 的每一個欄位都是**大端、不對齊**竹的（區塊魔數 48 bits、
 * origPtr 24 bits、Huffman 碼一次一個 bit），沒有任何位元組對齊的捷徑可走。
 */
class BitReader {
  constructor(bytes) {
    this.b = bytes;
    this.pos = 0;      // 下一個要讀的位元組
    this.bit = 0;      // 目前位元組裡讀到第幾個 bit（0 = 最高位）
  }
  /** 讀一個 bit。讀過頭丟例外 —— 回 0 會讓損壞的檔案安靜地解出垃圾。 */
  read1() {
    if (this.pos >= this.b.length) throw new Error("bzip2: 資料在中途就結束了");
    const v = (this.b[this.pos] >> (7 - this.bit)) & 1;
    if (++this.bit === 8) { this.bit = 0; this.pos++; }
    return v;
  }
  /** 讀 n 個 bit（n ≤ 24，回傳無號整數）。 */
  read(n) {
    let v = 0;
    for (let i = 0; i < n; i++) v = (v << 1) | this.read1();
    return v >>> 0;
  }
  /** 讀 n 個 bit 並回傳 16 進位字串。48 bits 的魔數超過 32 bit，只能這樣比。 */
  readHex(n) {
    let s = "";
    for (let i = 0; i < n; i += 4) s += this.read(4).toString(16);
    return s;
  }
}

/**
 * 建 Huffman 解碼表（照參考實作的 hbCreateDecodeTables）。不是一般的「查表 → 符號」，而
 * 是**按碼長逐級比較**：limit[len] 是長度為 len 的碼的最大值，讀到的值超過它就再多讀一個
 * bit。表因此只跟 alphaSize 成正比 —— maxLen 可以到 20，攤平成查表會日是幾 MB。
 */
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

/** 用一張表解出一人個符號。 */
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

/**
 * 讀一個區塊的符號表（哪些位元組值有出現過）。兩層 bitmap：先 16 bits 說哪 16 個「群」
 * 有東西，每個有東西的群再讀 16 bits。回傳的順序由小到大 —— 它同時是 MTF 清單的初始
 * 狀態。
 */
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

/** 讀 selector 序列（MTF 過的群編號，一元編碼）。 */
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

/** 讀各群竹的碼長（差分編碼：起始值 5 bits，之後每個符號用 ±1 走過去）。 */
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

/**
 * 解一個區塊的 MTF + RLE2 層，得到 BWT 之後的位元組序列。兩件事同時在做：**MTF 反轉**
 * （符號 2..alphaSize-2 代表「MTF 清單的第 (sym-1) 項」，取出來之後搬到最前面），以及
 * **RUNA / RUNB 的零長度解碼**（用 bijective base-2 表達「連續幾個 MTF 索引 0」，也就是
 * 連續幾個跟上一次相同的位元組 —— bzip2 對長重複串的主要壓縮手段，一人個 `es` 動輒上千）。
 */
function decodeMTF(br, used, tables, selectors, maxBlock) {
  const alphaSize = used.length + 2;
  const EOB = alphaSize - 1;
  const mtf = used.slice();                 // 直接放位元組值，省一層 seqToUnseq
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
      // RUNA=0 貢獻 1×N、RUNB=1 貢獻 2×N，N 每次翻倍（bijective base 2）
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

/**
 * 反轉 BWT。木標準的 T 向量法：先數出每個位元組值在排序後的起始位置（cftab），再走一遍
 * 原序列把「第 i 個位置在排序後排第幾」記進 T，然後從 origPtr 順著鏈走出原文。
 */
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

/**
 * 最後那層 RLE：**連續 4 個相同的位元組後面跟一個長度位元組**，表示再多幾個。
 *
 * 這一層在 BWT **之前**做（所以解的時候在最後），而且是無條件的 —— 即使那 4 個位元組
 * 之後一個十都不重複，那個 0 也一定寫出來了。少解一次就會把後面整段位移。
 *
 * **膨脹率是 259/5 ≈ 52 倍**，所以「一個區塊解出來不會超過 blockSize100k」是**錯的**：
 * 一個 1 MB 全是 0 的檔案在 `-1` 之下只佔一個 100 KB 的區塊，卻要吐出 1 MB。真正的保
 * 護是呼叫端的 `maxOut`，而那個上限跟區塊大小無關。
 *
 * @param {Uint8Array} data BWT 反轉之後的位元組
 * @param {number} limit 這一塊最多能吐幾個位元組
 */
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

/** CRC-32/BZIP2。跟 zlib 竹的 CRC-32 同多項式但不反射，見檔頭。 */
function crcOf(bytes) {
  let c = -1;
  for (let i = 0; i < bytes.length; i++)
    c = (c << 8) ^ CRC_TABLE[((c >>> 24) ^ bytes[i]) & 0xff];
  return (~c) >>> 0;
}

/**
 * 解壓縮一整個 bzip2 串流。
 *
 * @param {Uint8Array} bytes  `BZh1`–`BZh9` 開頭的完整串流
 * @param {{maxOut?: number}} [opts] maxOut 是產出上限，預設 8 MB（壓縮炸彈的煞車）
 * @returns {Uint8Array}
 * @throws {Error} 格式不合、CRC 對不上、或超過 maxOut
 */
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
    if (magic === END_MAGIC) { br.read(32); break; }   // 後面是整串流的合併 CRC
    if (magic !== BLOCK_MAGIC) throw new Error("bzip2: 區塊魔數不對");

    const wantCrc = br.read(32);
    // randomised 人位元。bzip2 0.9.0 之後不再產生，支援它要一張 512 項的表 —— 見檔頭。
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

    // 先收成一塊再驗 CRC —— CRC 算的是**這個區塊解完的原文**，不是 BWT 的中日間結果。
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

// ── 壓縮 ────────────────────────────────────────────────────────────────────
//
// 解壓縮那一半的每一步反過來走：RLE1 → BWT → MTF+RLE2 → Huffman。這裡只寫「反過來時
// 多出來的決定」。

/** MSB-first 的位元寫入器，跟 BitReader 對稱。 */
class BitWriter {
  constructor() { this.bytes = []; this.cur = 0; this.n = 0; }
  write1(b) {
    this.cur = (this.cur << 1) | (b & 1);
    if (++this.n === 8) { this.bytes.push(this.cur & 0xff); this.cur = 0; this.n = 0; }
  }
  write(v, bits) { for (let i = bits - 1; i >= 0; i--) this.write1((v >>> i) & 1); }
  /** 16 進位字串（48 bits 的魔數超過 32 bit，只能這樣寫）。 */
  writeHex(s) { for (const c of s) this.write(parseInt(c, 16), 4); }
  /** 補 0 到人位元組邊界並收尾。 */
  finish() {
    while (this.n) this.write1(0);
    return Uint8Array.from(this.bytes);
  }
}

/**
 * RLE1：**連續 4 個相同的位元組後面接一個長度位元組**，見 undoRLE。一次最多表達 259 個
 * （4 + 255），超過就再起一組 —— 那個欄位就是一個位元組。
 */
function doRLE(data) {
  const out = [];
  let i = 0;
  while (i < data.length) {
    const b = data[i];
    let run = 1;
    while (i + run < data.length && data[i + run] === b && run < 259) run++;
    if (run >= 4) {
      out.push(b, b, b, b, run - 4);
    } else {
      for (let k = 0; k < run; k++) out.push(b);
    }
    i += run;
  }
  return Uint8Array.from(out);
}

/**
 * BWT。回傳 { L, origPtr }。
 *
 * 用倍增法排循環位移（每輪用「自己的名次」加上「往後 k 格那個位置的名次」當鍵），
 * O(n log²n)。直接比字串是 O(n² log n) —— 這個函式的輸入是**使用者的譜**，一首 16 分頁
 * 的曲子擴充區塊可以到幾 KB，那時天真版已經日是幾千萬次位元組比較。
 */
function bwt(data) {
  const n = data.length;
  const sa = new Int32Array(n);
  for (let i = 0; i < n; i++) sa[i] = i;
  let rank = new Int32Array(n);
  for (let i = 0; i < n; i++) rank[i] = data[i];

  const tmp = new Int32Array(n);
  for (let k = 1; k < n; k <<= 1) {
    const key2 = new Int32Array(n);
    for (let i = 0; i < n; i++) key2[i] = rank[(i + k) % n];
    const arr = Array.from(sa);
    arr.sort((a, b) => (rank[a] - rank[b]) || (key2[a] - key2[b]));
    let r = 0;
    tmp[arr[0]] = 0;
    for (let i = 1; i < n; i++) {
      if (rank[arr[i]] !== rank[arr[i - 1]] || key2[arr[i]] !== key2[arr[i - 1]]) r++;
      tmp[arr[i]] = r;
    }
    for (let i = 0; i < n; i++) sa[i] = arr[i];
    rank.set(tmp);
    if (r === n - 1) break;                 // 名次已經全相異，再倍增也不會變
  }

  const L = new Uint8Array(n);
  let origPtr = 0;
  for (let i = 0; i < n; i++) {
    L[i] = data[(sa[i] + n - 1) % n];
    if (sa[i] === 0) origPtr = i;
  }
  return { L, origPtr };
}

/** MTF + RLE2。回傳 { syms, used, eob }，syms 是要餵給 Huffman 的符號序列。 */
function mtfRLE2(L) {
  const seen = new Uint8Array(256);
  for (const b of L) seen[b] = 1;
  const used = [];
  for (let i = 0; i < 256; i++) if (seen[i]) used.push(i);

  const mtf = used.slice();
  const syms = [];
  let zeros = 0;
  /** 把累積竹的「MTF 索引 0」用 bijective base-2 寫成 RUNA/RUNB，見 decodeMTF。 */
  const flush = () => {
    while (zeros > 0) {
      syms.push((zeros - 1) & 1);            // 偶數個 → RUNA(0)，奇數 → RUNB(1)
      zeros = (zeros - 1) >> 1;
    }
  };
  for (const b of L) {
    const j = mtf.indexOf(b);
    if (j === 0) { zeros++; continue; }
    flush();
    mtf.splice(j, 1);
    mtf.unshift(b);
    syms.push(j + 1);
  }
  flush();
  const eob = used.length + 1;               // = alphaSize - 1
  syms.push(eob);
  return { syms, used, eob };
}

/**
 * 依頻率算 Huffman 碼長，並把最長碼壓在 `limit`（bzip2 是 20）以內。超長時把所有頻率折
 * 半再重算 —— 跟 libbzip2 的 hbMakeCodeLengths 同一招。不保證最佳，但一定收斂。
 */
function codeLengths(freq, alphaSize, limit = 20) {
  let f = Array.from({ length: alphaSize }, (_, i) => Math.max(1, freq[i] | 0));
  for (;;) {
    // 每個節點 = { w, len 累加 }。用日最簡單的 O(n²) 取兩小 —— alphaSize ≤ 258。
    const nodes = f.map((w, i) => ({ w, syms: [i] }));
    const lens = new Uint8Array(alphaSize);
    while (nodes.length > 1) {
      nodes.sort((a, b) => a.w - b.w);
      const a = nodes.shift(), b = nodes.shift();
      for (const s of a.syms) lens[s]++;
      for (const s of b.syms) lens[s]++;
      nodes.push({ w: a.w + b.w, syms: [...a.syms, ...b.syms] });
    }
    // 只有一個符號時樹深是 0，但碼長不能是 0（解碼器的 minLen 會變成 0 而讀不到位元）
    for (let i = 0; i < alphaSize; i++) if (lens[i] === 0) lens[i] = 1;
    if (Math.max(...lens) <= limit) return lens;
    f = f.map(w => (w >> 1) + 1);
  }
}

/** 由碼長排出正典編碼，順序必須跟 buildTable 的 perm 一致（長度優先、同長按符號序）。 */
function canonicalCodes(lens, alphaSize) {
  const codes = new Int32Array(alphaSize);
  const maxLen = Math.max(...lens), minLen = Math.min(...lens);
  let vec = 0;
  for (let len = minLen; len <= maxLen; len++) {
    for (let s = 0; s < alphaSize; s++) if (lens[s] === len) codes[s] = vec++;
    vec <<= 1;
  }
  return codes;
}

/**
 * 壓縮成 bzip2 串流。
 *
 * **只產生一個區塊**：輸入是幾百到幾千個位元組，離 900 KB 的區塊上限有三個數量級。超
 * 過就丟例外而不是默默切段 —— 安靜地產出一個沒測過的多區塊串流不是好的失敗方式。
 *
 * **固定寫兩張 Huffman 表**（內容相同、selector 全指向第 0 弓張）：格式規定表數是 2–6，
 * 所以一張是不合法的；而真正的多表分群是為了長資料的壓縮率。
 *
 * @param {Uint8Array} bytes
 * @returns {Uint8Array} `BZh9…` 的完整串流
 */
export function compress(bytes) {
  const data = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  const w = new BitWriter();
  w.write(0x42, 8); w.write(0x5A, 8); w.write(0x68, 8);   // "BZh"
  w.write(0x39, 8);                                        // 等級 9 = 900k
  let combined = 0;

  if (data.length) {
    const rle = doRLE(data);
    if (rle.length > 9 * 100000) throw new Error("bzip2: 資料超過單一區塊");

    const { L, origPtr } = bwt(rle);
    const { syms, used, eob } = mtfRLE2(L);
    const alphaSize = used.length + 2;

    const crc = crcOf(data);
    combined = (((combined << 1) | (combined >>> 31)) ^ crc) >>> 0;

    w.writeHex(BLOCK_MAGIC);
    w.write(crc, 32);
    w.write1(0);                                           // randomised = 0
    w.write(origPtr, 24);

    // 符號表：先 16 bits 卜說哪些「群」有東西，再逐群 16 bits
    let groups = 0;
    for (const b of used) groups |= 0x8000 >> (b >> 4);
    w.write(groups, 16);
    for (let g = 0; g < 16; g++) {
      if (!(groups & (0x8000 >> g))) continue;
      let bits = 0;
      for (const b of used) if ((b >> 4) === g) bits |= 0x8000 >> (b & 15);
      w.write(bits, 16);
    }

    const nGroups = 2;
    const nSelectors = Math.ceil(syms.length / GROUP_SIZE);
    w.write(nGroups, 3);
    w.write(nSelectors, 15);
    // selector 全部是第 0 張表。MTF 之後索引都是 0，一元編碼就是單一個 0 位元。
    for (let i = 0; i < nSelectors; i++) w.write1(0);

    const freq = new Int32Array(alphaSize);
    for (const s of syms) freq[s]++;
    const lens = codeLengths(freq, alphaSize);
    const codes = canonicalCodes(lens, alphaSize);

    // 碼長是差分編碼的：5 bits 起始值，之後每個符號用 ±1 走過去再寫一個 0 收尾。
    // 兩張表寫一樣竹的內容。
    for (let g = 0; g < nGroups; g++) {
      let cur = lens[0];
      w.write(cur, 5);
      for (let s = 0; s < alphaSize; s++) {
        while (cur < lens[s]) { w.write1(1); w.write1(0); cur++; }
        while (cur > lens[s]) { w.write1(1); w.write1(1); cur--; }
        w.write1(0);
      }
    }

    for (const s of syms) w.write(codes[s], lens[s]);
    if (syms[syms.length - 1] !== eob) throw new Error("bzip2: 內部錯誤，缺 EOB");
  }

  w.writeHex(END_MAGIC);
  w.write(combined, 32);
  return w.finish();
}
