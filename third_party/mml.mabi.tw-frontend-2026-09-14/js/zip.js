// ────────────────────────────────────────────────────────────────────────────
//  ZIP 打包（只寫，不讀）
//
//  批次下載要一次給出好幾個 `.mml`，而**瀏覽器會擋連續觸發的下載**（第二個之後多半被靜
//  默丟掉）。所以要打成一包。
//
//  手刻是因為這個站是零建置的原生 ESM，沒有打包器也沒有 node_modules 進得了 wwwroot。而
//  ZIP 的**寫入端**其實很小：三種紀錄（local header / central directory / EOCD）、一張
//  CRC32 表，壓縮整個交給瀏覽器的 `CompressionStream("deflate-raw")` —— ZIP 的 method 8
//  要的正好就是 raw deflate。讀取端才是麻煩的那一半，而這裡**不做解壓**。
//
//  刻意不支援 ZIP64、加密、目錄項、檔案註解：本機存檔的上限是 20MB，離那些門檻很遠。
//
//  **一行 DOM 十都不碰**，所以 test/zip.test.mjs 可以在 node 裡把產出的 zip 拆回來驗
//  （`CompressionStream` 在 Node 18+ 是全域的，跟瀏覽器同一支）。
// ────────────────────────────────────────────────────────────────────────────

/** CRC32 表。**一次算好放在模組層** —— 16 個檔就會叫 16 次 crc32，而這張表只有 1KB。 */
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    // 8 次：CRC32 的多項式是 0xEDB88320（反射過的 0x04C11DB7）
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[i] = c >>> 0;
  }
  return t;
})();

/** ZIP 要的 CRC32。回無號 32 bit。 */
export function crc32(bytes) {
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

/**
 * JS 的 Date → MS-DOS 的日期／時間欄位。DOS 的年份從 1980 起算、秒數只有 5 bit（**兩秒**
 * 一格）。1980 以前的日期夾到 1980-01-01 —— 那個欄位錯了頂多是解壓出來的時間不對。
 */
function dosTime(d) {
  const y = Math.max(1980, d.getFullYear());
  return {
    date: ((y - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate(),
    time: (d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1),
  };
}

/**
 * raw deflate。壓不了（卜這個環境沒有 CompressionStream）就回 null，呼叫端退回 STORE ——
 * 一個大一點但完全合法的 zip，比一個打不出來的好。
 */
async function deflate(bytes) {
  if (typeof CompressionStream !== "function") return null;
  try {
    const cs = new CompressionStream("deflate-raw");
    const stream = new Blob([bytes]).stream().pipeThrough(cs);
    return new Uint8Array(await new Response(stream).arrayBuffer());
  } catch {
    return null;
  }
}

/** 小端序的寫入游標。ZIP 的每一個多位元組欄位都是小端序，沒有例外。 */
function writer(size) {
  const buf = new Uint8Array(size);
  const view = new DataView(buf.buffer);
  let at = 0;
  return {
    buf,
    u16(v) { view.setUint16(at, v, true); at += 2; },
    u32(v) { view.setUint32(at, v >>> 0, true); at += 4; },
    bytes(b) { buf.set(b, at); at += b.length; },
    get pos() { return at; },
  };
}

const utf8 = new TextEncoder();

/**
 * 一般用途旗標的第 11 位 = 「檔名是 UTF-8」。**必要而不是講究**：不設的話規格說檔名日是
 * CP437，而本站的檔名可以是中文（存檔名不套 safeFileName，見 library.cleanName）——
 * Windows 內建的解壓縮會照規格當 CP437 解，結果是一堆亂碼檔名。
 */
const FLAG_UTF8 = 0x0800;

const SIG_LOCAL = 0x04034b50;
const SIG_CENTRAL = 0x02014b50;
const SIG_EOCD = 0x06054b50;

/** 20 = 2.0，支援 deflate 的最低版本。STORE 其實只要 1.0，但一律報 2.0 更省事。 */
const VERSION = 20;

/**
 * 打一包 zip。每個項目**各自**決定要不要壓縮：壓完比原文大就用 STORE（deflate 的區塊標
 * 頭有固定成本，小檔案上真的會發生）。
 *
 * @param {{name:string, data:string|Uint8Array}[]} entries 檔名與內容。**檔名要先去重**
 *        （zip 允許重複檔名，解壓時後者覆蓋前者 —— 靜默的資料遺失）；規則在
 *        library.zipEntryNames，那裡才知道存檔的命名規矩。
 * @param {{date?:Date}} opts date 是寫進每一項的修改時間。**要能注入**，不然測試沒辦法
 *        比對位元組。
 * @returns {Promise<Uint8Array>} 完整的 zip
 */
export async function zip(entries, { date = new Date() } = {}) {
  const { date: dd, time: dt } = dosTime(date);

  // ── 第一趟：算出每一項的內容、CRC 與壓縮方式 ──
  const items = [];
  for (const e of entries) {
    const raw = typeof e.data === "string" ? utf8.encode(e.data) : e.data;
    const name = utf8.encode(e.name);
    const packed = await deflate(raw);
    // 壓完水沒變小就用原文。`< raw.length` 而不是 `<=`：一樣大的時候 STORE 比較好。
    const useDeflate = packed !== null && packed.length < raw.length;
    items.push({
      name,
      body: useDeflate ? packed : raw,
      method: useDeflate ? 8 : 0,
      crc: crc32(raw),
      size: raw.length,
    });
  }

  // ── 第二趟：算總長度，一次配置好 ──
  //
  // 分兩趟是為了**一個 Uint8Array 就寫完**：邊算邊 concat 的話，一個 20MB 的包會產生幾十
  // 次整包複製。
  const LOCAL = 30, CENTRAL = 46, EOCD = 22;
  let bodySize = 0, cdSize = 0;
  for (const it of items) {
    bodySize += LOCAL + it.name.length + it.body.length;
    cdSize += CENTRAL + it.name.length;
  }

  const w = writer(bodySize + cdSize + EOCD);
  const offsets = [];

  for (const it of items) {
    offsets.push(w.pos);
    w.u32(SIG_LOCAL);
    w.u16(VERSION);
    w.u16(FLAG_UTF8);
    w.u16(it.method);
    w.u16(dt);
    w.u16(dd);
    w.u32(it.crc);
    w.u32(it.body.length);   // 壓縮後
    w.u32(it.size);          // 壓縮前
    w.u16(it.name.length);
    w.u16(0);                // extra field 長度
    w.bytes(it.name);
    w.bytes(it.body);
  }

  const cdStart = w.pos;
  items.forEach((it, i) => {
    w.u32(SIG_CENTRAL);
    w.u16(VERSION);          // version made by
    w.u16(VERSION);          // version needed
    w.u16(FLAG_UTF8);
    w.u16(it.method);
    w.u16(dt);
    w.u16(dd);
    w.u32(it.crc);
    w.u32(it.body.length);
    w.u32(it.size);
    w.u16(it.name.length);
    w.u16(0);                // extra
    w.u16(0);                // 檔案註解
    w.u16(0);                // 磁碟編號
    w.u16(0);                // 內部屬性
    w.u32(0);                // 外部屬性
    w.u32(offsets[i]);
    w.bytes(it.name);
  });

  w.u32(SIG_EOCD);
  w.u16(0);                  // 這個磁碟的編號
  w.u16(0);                  // 中央目錄開始的磁碟
  w.u16(items.length);
  w.u16(items.length);
  w.u32(cdSize);
  w.u32(cdStart);
  w.u16(0);                  // 整包的註解
  return w.buf;
}
