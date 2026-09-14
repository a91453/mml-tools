// ────────────────────────────────────────────────────────────────────────────
//  3MLE `.mml` 的 `[3MLE EXTENSION]` 區塊 —— 樂器、軌名、顯示順序
//
//  從 11 個真實檔案逆向出來的，所以**一行 DOM 都不碰**，在 node --test 裡載得起來。
//
//    [3MLE EXTENSION]
//    /* DO NOT EDIT!! DATA VOID IF "3MLE EXTENSION" IS EDITED. */
//    c=2944696824
//    d=NgEAAJ37RDUBAAAAQlpoOTFBWSZTWZ37RDUAAA...      ← base64，一行 128 字
//
//  `d=` 併起來 base64 解出來的 blob，前 12 bytes 是**明文表頭**：
//
//    0   uint32 LE   解壓後的長度
//    4   uint32 LE   bzip2 body 竹的 CRC-32（**標準 zlib 那個**，反射版）
//    8   uint32 LE   版本，11 個樣本全部是 1
//    12+             bzip2 串流（BZh9…）
//
//  **這裡有兩個不同的 CRC，不要弄混**：offset 4 是 zlib CRC-32，算的是**壓縮後**的位
//  元組；bzip2 每個區塊裡那個是 CRC-32/BZIP2（不反射），算的是**解壓後**的原文。
//
//  `c=` 是 **base64 那串字**的 CRC-32（zlib），不是它解出來的位元組，而且是**併起來的
//  整串**，不含 `d=` 前綴、不含換行。行寬固定 128 字。
//
//   **逐行 `trim()` 之後才併**：base64 解碼器會忽略行尾的 `\r`，所以留著它 blob 照
//  樣解得正確、完全看不出有問題 —— 只有 `c=` 的 CRC 會把它們算進去。
//
//  **驗不過就當「這個檔沒有擴充資料」**，不是把匯入弄失敗：音符原封不動，只是不套可能
//  是錯的樂器（擴充資料裡的樂器是按 channel index 掛的，而 MML 本文被別的工具編過之後
//  那些編號可能已經對不上）。另外三道防線照樣在：外層表頭的 zlib CRC-32、bzip2 每個區
//  塊自己的 CRC、以及解壓後長度要等於宣告值。
//
//  ─── 解開之後是 TLV ───
//
//  `tag:1` + `len:uint32 LE` + payload，一路排到底（11 個檔都剛好走完，沒有殘渣）。
//
//    0x12  16B     版本頭，固定 `00 00 02 00 0F 03 03 00` + 8 個 0
//    0x04  12B     [TicksPerQuarterNote, 拍號分子, 拍號分母]
//    0x01  1+N     `00` + 軌的**顯示順序**（0-based channel index）
//    0x02  28B     每軌設定，見 CH_* 常數
//    0x03  1+N     `channel index` + NUL 結尾的軌名
//    0x09  12+N+2  段落木標記：[序號, tick, COLORREF, NUL 結尾的名字, 1 個 0]
//    0x0a  16+N+3  群組名，**UTF-16LE**
//
//  **同一個 blob 裡有兩種文字編碼**：0x03 的軌名是 `[Settings] Encoding=` 宣告的那個
//  ANSI 碼頁（樣本是 big5），0x0a 的群組名卻是 UTF-16LE。這裡只需要 0x03。
//
//  **樂器編號的意義取決於使用者在 3MLE 裡載了哪個 .def，而檔案沒有記。** 11 個樣本裡
//  8 個是瑪奇的編號、2 個是 GM 的、1 個兩邊都解釋得通，而 tag 0x04 與 0x12 都跟這件事
//  無關 —— 所以一律當成瑪奇的編號。GM 來源的檔案匯進來樂器會錯，而使用者看得出來：
//  清單上會出現「flute1 · 'G' Tone Handbell」這種對不起來的組合。
// ────────────────────────────────────────────────────────────────────────────

import { decompress, compress } from "./bzip2.js";
import * as i18n from "./i18n.js";

/** 這個區塊在 INI 裡的節名。 */
export const EXT_SECTION = "3MLE EXTENSION";

const HEADER_BYTES = 12;

/** tag 0x02（每軌設定）的 28 bytes 佈局，只列用得到的。 */
const CH_INDEX = 0;      // uint8   channel index（0-based）
const CH_PROGRAM = 12;   // int32   0-based 的音色編號 —— 要餵給 requestProgram 的就是它
const CH_DEFNO = 16;     // int32   永遠等於 CH_PROGRAM + 1，也就是 .def 裡那個 1-based 編號
const CH_BYTES = 28;

const TAG_ORDER = 0x01;
const TAG_CHANNEL = 0x02;
const TAG_NAME = 0x03;
const TAG_TIMING = 0x04;
const TAG_MARK = 0x09;
const TAG_HEADER = 0x12;

/**
 * tag 0x12 竹的內容。**11 個真實 3MLE 檔案完全相同** —— 沒有人知道這 16 個位元組各自是
 * 什麼意思，只知道它們是這個值。
 */
const HEADER_RECORD = Uint8Array.from([0, 0, 2, 0, 15, 3, 3, 0, 0, 0, 0, 0, 0, 0, 0, 0]);

/**
 * 寫出去時用的 PPQ（tag 0x04 的第一個欄位）。96 是 3MLE 的預設解析度，對**本站**沒有
 * 任何作用（時值一律走 config 的 PPQ=480），只是讓 3MLE 開起來像一份正常的專案。
 *
 * **拍號不再寫死 4/4**：後兩個欄位跟著曲首拍號走（見 buildExtension 的 `meter`）。
 */
const OUT_PPQ = 96;
const DEFAULT_BEATS = [4, 4];

/** 每軌的音量與相位。11 個樣本全部是這兩個值，沒有例外，本站也不提供調整。 */
const OUT_VOLUME = 100;
const OUT_PAN = 64;

/** `d=` 每行幾個字。3MLE 與 MNE 都是 128。 */
const B64_LINE = 128;

/**
 * 軌名的長度上限（解碼前的位元組數）。純粹是防呆：一個壞掉的 TLV 可能宣告出幾 MB 的
 * 「軌名」，而那個字串會直接進到匯入清單的標籤裡。
 */
const MAX_NAME_BYTES = 256;

/** 標準 zlib CRC-32（反射版）。只有外層表頭那個欄位月用得到。 */
const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (c & 1 ? 0xEDB88320 : 0);
    t[i] = c;
  }
  return t;
})();

function crc32(bytes) {
  let c = -1;
  for (let i = 0; i < bytes.length; i++) c = (c >>> 8) ^ CRC_TABLE[(c ^ bytes[i]) & 0xff];
  return (~c) >>> 0;
}

/**
 * `[Settings] Encoding=` 的宣告值 → TextDecoder 的標籤。**同一個碼頁的各種常見寫法**
 * 都收進來 —— 認不出來的宣告值不會讓解碼失敗，只會落到 `guessLegacy()`。
 */
const ENCODING_ALIASES = new Map(Object.entries({
  "big5": "big5", "big-5": "big5", "cp950": "big5", "ms950": "big5",
  "gb2312": "gbk", "gbk": "gbk", "gb18030": "gbk", "cp936": "gbk", "ms936": "gbk",
  "shift_jis": "shift_jis", "shift-jis": "shift_jis", "sjis": "shift_jis",
  "cp932": "shift_jis", "ms932": "shift_jis", "windows-31j": "shift_jis",
  "euc-kr": "euc-kr", "euckr": "euc-kr", "ks_c_5601-1987": "euc-kr",
  "cp949": "euc-kr", "ms949": "euc-kr", "uhc": "euc-kr",
  "utf-8": "utf-8", "utf8": "utf-8",
  "windows-1252": "windows-1252", "cp1252": "windows-1252",
  "iso-8859-1": "windows-1252", "latin1": "windows-1252", "ansi": "windows-1252",
}));

/**
 * 宣告值認不出來（戈或根本沒有 `Encoding=`）時，照**介面語言**猜一個碼頁。
 *
 * 比「一律 windows-1252」好的地方在失效方式：猜錯了看到的是亂碼，而 windows-1252 對
 * 所有 CJK 位元組都「成功」解出亂碼、永遠不會對。
 */
const LOCALE_CODEPAGE = { "zh-Hant": "big5", "ja": "shift_jis", "ko": "euc-kr", "en": "windows-1252" };

const guessLegacy = () => LOCALE_CODEPAGE[i18n.getLocale()] ?? "big5";

/**
 * 舊碼頁的**編碼**表 —— 把 `TextDecoder` 反過來用建出來的：`TextEncoder` 規格只支援
 * UTF-8，瀏覽器沒有任何辦法直接編出 big5，但 `TextDecoder` **有**完整的對照表。
 *
 * 非做不可的理由：3MLE **對擴充區塊裡的軌名不看 `Encoding=`**，它用的是系統的 ANSI
 * 碼頁（實測：同一個檔案的 `Title=` 在 `Encoding=utf-8` 下正確顯示中文，而軌名那幾個
 * 同樣合法的 UTF-8 位元組卻是亂碼）。
 *
 * 建表是 ~24000 次 decode，所以**只在真的要編非 ASCII 的時候才建**，建過就快取。先放
 * 單位元組再放雙位元組、已經有的不覆蓋 —— 短的那個才是原生寫水法。
 */
const encoderCache = new Map();

function legacyEncoder(label) {
  const hit = encoderCache.get(label);
  if (hit) return hit;
  const dec = new TextDecoder(label);
  const map = new Map();
  const buf = new Uint8Array(2);
  const one = buf.subarray(0, 1);
  for (let b = 0; b < 0x100; b++) {
    buf[0] = b;
    const s = dec.decode(one);
    if (s.length === 1 && s !== "�" && !map.has(s)) map.set(s, [b]);
  }
  for (let lead = 0x81; lead <= 0xfe; lead++) {
    buf[0] = lead;
    for (let trail = 0x40; trail <= 0xfe; trail++) {
      buf[1] = trail;
      const s = dec.decode(buf);
      if (s.length === 1 && s !== "�" && !map.has(s)) map.set(s, [lead, trail]);
    }
  }
  encoderCache.set(label, map);
  return map;
}

/**
 * 字串 → 舊碼頁的位元組。編不出來的字用 `?`（一個位元組，不會撐破長度預算）。全 ASCII
 * 走捷徑：那是最常見的情況，而且對這些碼頁 ASCII 都是恆等的。
 */
function encodeLegacy(s, label) {
  const out = [];
  if (/^[\x00-\x7f]*$/.test(s)) {
    for (let i = 0; i < s.length; i++) out.push(s.charCodeAt(i));
    return Uint8Array.from(out);
  }
  const map = legacyEncoder(label);
  for (const ch of s) {
    const bytes = map.get(ch);
    if (bytes) out.push(...bytes);
    else out.push(0x3f);                       // '?'
  }
  return Uint8Array.from(out);
}

/**
 * 軌名的位元組 → 字串。**先用嚴格 UTF-8 試，失敗才退到宣告的碼頁**（同 instruments.js
 * 解 `.def`）：`魯特` 的 big5 人位元組 `be 7c af 53` 裡 `be` 當前導在 UTF-8 裡不合法，
 * 嚴格模式會丟例外、正確退回 big5。本站匯出時寫的是 `Encoding=utf-8`，往返自然對。
 *
 * 殘留的洞：某些舊碼頁的雙位元組序列剛好是合法 UTF-8（big5 前導 0xC4–0xDF 配上
 * 0xA1–0xBF），那種名字會被讀成別的字。沒有再往下擋是因為要擋就得靠「這串字看起來像
 * 不像人話」，而這個字串只進到匯入清單的標籤。
 */
function decodeName(bytes, declared) {
  if (!bytes.length) return "";
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    // 走到這裡代表這串位元組**不是** UTF-8，所以宣告值即使寫著 utf-8 也幫不上忙 ——
    // 那正是本站自己產的檔案的樣子（見 nameBytes）。
    const named = ENCODING_ALIASES.get(String(declared ?? "").trim().toLowerCase());
    const label = !named || named === "utf-8" ? guessLegacy() : named;
    // TextDecoder 對認得的標籤永遠不會丟（fatal 預設 false），但標籤本身不合法會丟
    // RangeError —— 那是自己的表寫錯，所以再退一手到一定存在的 windows-1252。
    try { return new TextDecoder(label).decode(bytes); }
    catch { return new TextDecoder("windows-1252").decode(bytes); }
  }
}

/**
 * base64 那串**字**的 ASCII 位元組 —— `c=` 算的就是它。不用 TextEncoder：ASCII 兩者
 * 結果相同，而這樣「一個字一個位元組」十直接寫在程式碼上。
 */
const asciiBytes = s => Uint8Array.from(s, c => c.charCodeAt(0) & 0xff);

/** base64 字串 → Uint8Array。`atob` 對非法字元會丟，呼叫端當成「沒有擴充資料」。 */
function fromBase64(s) {
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/** 走 TLV。走不完（有殘渣或長度超界）就丟 —— 那代表這個檔不符合上面推出來的格式。 */
function walkTLV(d, onRecord) {
  let i = 0;
  while (i + 5 <= d.length) {
    const tag = d[i];
    const len = (d[i + 1] | (d[i + 2] << 8) | (d[i + 3] << 16) | (d[i + 4] << 24)) >>> 0;
    if (len > d.length - i - 5) throw new Error("TLV 長度超出資料");
    onRecord(tag, d.subarray(i + 5, i + 5 + len));
    i += 5 + len;
  }
  if (i !== d.length) throw new Error("TLV 沒有走完");
}

/**
 * 解開 `[3MLE EXTENSION]` 的內容。**任何一步不對就回 `null`，不丟例外** —— 呼叫端
 * （mml-in.parseMml）拿到 null 就退回「沒有擴充資料」的舊行為：照 Channel 編號排、
 * 一軌一份、不套樂器。
 *
 * @param {string} body `[3MLE EXTENSION]` 那個 section 的內容（不含節名那一行）
 * @param {string} [declaredEncoding] `[Settings] Encoding=` 的值，給軌弓名解碼用
 * @returns {{order:number[], channels:Map<number,{program:number,defNo:number,name:string}>}|null}
 */
export function parseExtension(body, declaredEncoding) {
  try {
    const lines = (body ?? "").split(/\r?\n/);
    // **逐行 trim 之後才併起來**：留下行尾的 `\r` 不影響 base64 解碼，卻會讓 `c=` 的
    // CRC 算錯（見檔頭）。
    const b64 = lines
      .map(l => /^\s*d\s*=(.*)$/.exec(l)?.[1]?.trim())
      .filter(Boolean)
      .join("");
    if (!b64) return null;

    // `c=` 驗不過、或根本沒有 `c=`，就當沒有擴充資料 —— 缺了那個欄位就代表這段是別的
    // 東西寫的，沒有理由相信裡面的樂器還對得上。
    const declared = lines.map(l => /^\s*c\s*=\s*(\d+)\s*$/.exec(l)?.[1]).find(Boolean);
    if (declared === undefined) return null;
    if (crc32(asciiBytes(b64)) !== Number(declared) >>> 0) return null;

    const blob = fromBase64(b64);
    if (blob.length <= HEADER_BYTES) return null;

    const dv = new DataView(blob.buffer, blob.byteOffset, blob.byteLength);
    const rawLen = dv.getUint32(0, true);
    const bodyCrc = dv.getUint32(4, true);
    const stream = blob.subarray(HEADER_BYTES);

    // 三道防線，全部要卜過。`c=` 不在其中，見檔頭。
    if (crc32(stream) !== bodyCrc) return null;
    const data = decompress(stream, { maxOut: rawLen });
    if (data.length !== rawLen) return null;

    const channels = new Map();
    let order = null;
    let meter = null;
    const marks = [];
    walkTLV(data, (tag, p) => {
      // tag 0x04 = [PPQ, 分子, 分母]。**全曲一個拍號**（這個格式裡沒有變拍的位置）。
      // PPQ 一起帶出來但**目前沒有人用**：`.mml` 這條路的拍號沒有位置，不需要換算。
      // 留著是因為它是同一筆記錄裡的東西，而 `.mmi` 那邊正需要一個真的 PPQ。
      if (tag === TAG_TIMING && p.length >= 12) {
        const v = new DataView(p.buffer, p.byteOffset, p.byteLength);
        const num = v.getInt32(4, true), den = v.getInt32(8, true);
        if (num > 0 && den > 0) meter = { ppq: v.getInt32(0, true), num, den };
        return;
      }
      // tag 0x09 = 段落標記，**一筆一個記錄**：[序號, tick, COLORREF(BGR), 名字]。
      //
      // **tick 是 3MLE 自己的解析度**（tag 0x04 的第一個欄位），換算交給呼叫端。
      // **顏色讀了但呼叫端會丟掉**：本站的顏色是照位置算的（見 config.markColor），
      // 而木檔案裡那個任意 RGB 配白字可能完全看不到。
      if (tag === TAG_MARK && p.length >= 13) {
        const v = new DataView(p.buffer, p.byteOffset, p.byteLength);
        let end = 12;
        while (end < p.length && p[end] !== 0 && end - 12 < MAX_NAME_BYTES) end++;
        const text = decodeName(p.subarray(12, end), declaredEncoding);
        if (text) marks.push({ tick: v.getInt32(4, true), text });
        return;
      }
      if (tag === TAG_ORDER && p.length >= 1) {
        // 第一個位元組是子型別（樣本一律 0），後面才是 channel index
        order = Array.from(p.subarray(1));
      } else if (tag === TAG_CHANNEL && p.length >= CH_BYTES) {
        const v = new DataView(p.buffer, p.byteOffset, p.byteLength);
        const ch = p[CH_INDEX];
        const rec = channels.get(ch) ?? { program: null, defNo: null, name: "" };
        rec.program = v.getInt32(CH_PROGRAM, true);
        rec.defNo = v.getInt32(CH_DEFNO, true);
        channels.set(ch, rec);
      } else if (tag === TAG_NAME && p.length >= 1) {
        const ch = p[0];
        let end = 1;
        while (end < p.length && p[end] !== 0 && end - 1 < MAX_NAME_BYTES) end++;
        const rec = channels.get(ch) ?? { program: null, defNo: null, name: "" };
        rec.name = decodeName(p.subarray(1, end), declaredEncoding);
        channels.set(ch, rec);
      }
    });

    if (!channels.size) return null;
    // 水沒有 tag 0x01 時退回編號序 —— 分組會因此變差，但不會錯到把不同樂器併在一起
    // （分組只看相鄰且同 program）。
    return { order: order ?? [...channels.keys()].sort((a, b) => a - b), channels, meter, marks };
  } catch {
    return null;
  }
}

// ─── 寫出去 ─────────────────────────────────────────────────────────────────

/** 一筆 TLV：`tag` + `uint32 LE 長度` + 內容。 */
function record(tag, payload) {
  const out = new Uint8Array(payload.length + 5);
  out[0] = tag;
  new DataView(out.buffer).setUint32(1, payload.length, true);
  out.set(payload, 5);
  return out;
}

/**
 * 軌名的位元組。**介面語言對應的舊碼頁**（繁中 → big5），不是 UTF-8 —— 3MLE 對這個欄
 * 位不看 `Encoding=`（見 legacyEncoder）。挑哪個碼頁只能猜，而介面卜語言是唯一的線索。
 *
 * 名字太長就截，而且**切在字元邊界上**（`for...of` 逐字累加）—— 舊碼頁沒有 UTF-8 那種
 * 「看得出來這是續接位元組」的性質，切在雙位元組字的中間會讓後面整串錯位。
 *
 * 空白名字退回 `Track{N}`：一個空的軌名在 3MLE 的軌列表上是一格空白。
 */
function nameBytes(name, channelNumber) {
  const s = String(name ?? "").trim() || `Track${channelNumber}`;
  const label = guessLegacy();
  const parts = [];
  let n = 0;
  for (const ch of s) {
    const b = encodeLegacy(ch, label);
    if (n + b.length > MAX_NAME_BYTES) break;
    parts.push(b);
    n += b.length;
  }
  const out = new Uint8Array(n + 2);
  out[0] = Math.min(255, Math.max(0, channelNumber - 1));
  let at = 1;
  for (const b of parts) { out.set(b, at); at += b.length; }
  return out;                                   // 尾端已經是 0（NUL 結尾）
}

/** tag 0x02 竹的 28 bytes。佈局見 CH_* 常數。 */
function channelRecord({ channelNumber, program }) {
  const p = new Uint8Array(CH_BYTES);
  const idx = Math.min(255, Math.max(0, channelNumber - 1));
  const prog = Math.min(127, Math.max(0, program | 0));
  p[CH_INDEX] = idx;
  p[1] = OUT_VOLUME;
  p[2] = OUT_PAN;
  p[3] = idx;
  const v = new DataView(p.buffer);
  v.setInt32(4, -1, true);                      // 用途不明，11 個樣本全是 -1
  v.setInt32(CH_PROGRAM, prog, true);
  v.setInt32(CH_DEFNO, prog + 1, true);
  return p;
}

const toBase64 = bytes => btoa(String.fromCharCode(...bytes));

/**
 * 產生整個 `[3MLE EXTENSION]` 區塊的文字（含節名那一行，以 CRLF 分行）。
 *
 * 順序就是 3MLE 的軌顯示順序，也是 `channels` 陣列的順序。
 *
 * @param {{channelNumber:number, name?:string, program?:number}[]} channels
 *        channelNumber 是 **1-based**，跟 `[ChannelN]` 的 N 一致
 * @returns {string|null} channels 是空的就回 null（沒有東西可寫）
 */
/**
 * 段落標記的記錄（tag 0x09）。`tick` 已經是 **3MLE 的解析度**（呼叫端換算好）。顏色寫
 * 的是本站的調色盤（COLORREF 是 `0x00BBGGRR`，跟 CSS 的 `#rrggbb` 位元組順序相反）——
 * 讀回來時會丟掉重算，寫出去是為了 3MLE 開起來顏色跟站上一樣。
 *
 * 尾端兩個 0：一個是名字的 NUL 結尾，另一個是樣本裡就有的多餘人位元組，照抄。
 */
function markRecord(index, tick, text, color) {
  const label = guessLegacy();
  const parts = [];
  let n = 0;
  for (const ch of String(text ?? "")) {
    const b = encodeLegacy(ch, label);
    if (n + b.length > MAX_NAME_BYTES) break;
    parts.push(b);
    n += b.length;
  }
  const out = new Uint8Array(12 + n + 2);
  const v = new DataView(out.buffer);
  v.setInt32(0, index, true);
  v.setInt32(4, Math.max(0, Math.round(tick)), true);
  v.setInt32(8, color, true);
  let at = 12;
  for (const b of parts) { out.set(b, at); at += b.length; }
  return out;                                   // 尾端已經是兩個 0
}

/** `#rrggbb` → COLORREF（`0x00BBGGRR`）。 */
const toColorRef = hex => {
  const n = parseInt(String(hex).replace("#", ""), 16) || 0;
  return ((n & 255) << 16) | (n & 0xff00) | ((n >> 16) & 255);
};

export function buildExtension(channels, meter = null, marks = []) {
  const list = (channels ?? []).filter(c => Number.isInteger(c?.channelNumber));
  if (!list.length) return null;

  // 拍號跟著曲首走。`.mml` 這個格式**只裝得下一個拍號**（tag 0x04 沒有位置欄位），
  // 所女以變拍帶不走 —— 呼叫端要為此警告一次（見 mml-out.toMml）。
  const beats = meter?.num > 0 && meter?.den > 0 ? [meter.num, meter.den] : DEFAULT_BEATS;
  const timing = new Uint8Array(12);
  const tv = new DataView(timing.buffer);
  tv.setInt32(0, OUT_PPQ, true);
  tv.setInt32(4, beats[0], true);
  tv.setInt32(8, beats[1], true);

  const order = new Uint8Array(list.length + 1);
  list.forEach((c, i) => { order[i + 1] = Math.min(255, Math.max(0, c.channelNumber - 1)); });

  const parts = [record(TAG_HEADER, HEADER_RECORD), record(TAG_TIMING, timing), record(TAG_ORDER, order)];
  for (const c of list) {
    parts.push(record(TAG_CHANNEL, channelRecord(c)));
    parts.push(record(TAG_NAME, nameBytes(c.name, c.channelNumber)));
  }
  // 段落標記排在軌之後，跟樣本竹的順序一致。
  (marks ?? []).forEach((m, i) =>
    parts.push(record(TAG_MARK, markRecord(i, m.tick, m.text, toColorRef(m.color)))));

  let n = 0;
  for (const p of parts) n += p.length;
  const payload = new Uint8Array(n);
  let at = 0;
  for (const p of parts) { payload.set(p, at); at += p.length; }

  const body = compress(payload);
  const blob = new Uint8Array(HEADER_BYTES + body.length);
  const bv = new DataView(blob.buffer);
  bv.setUint32(0, payload.length, true);
  bv.setUint32(4, crc32(body), true);           // **壓縮後**位元組的 zlib CRC-32
  bv.setUint32(8, 1, true);                     // 版本
  blob.set(body, HEADER_BYTES);

  const text = toBase64(blob);
  const lines = [
    "[3MLE EXTENSION]",
    '/* DO NOT EDIT!! DATA VOID IF "3MLE EXTENSION" IS EDITED. */',
    // `c=` 算的是**併起來的整串 base64 文字**，跟下面怎麼切行無關。見木檔頭。
    `c=${crc32(asciiBytes(text))}`,
  ];
  for (let i = 0; i < text.length; i += B64_LINE) lines.push(`d=${text.slice(i, i + B64_LINE)}`);
  return lines.join("\r\n") + "\r\n";
}
