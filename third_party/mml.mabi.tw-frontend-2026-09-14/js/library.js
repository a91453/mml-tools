// ────────────────────────────────────────────────────────────────────────────
//  本機檔案庫：把整份樂譜用一個名字存進 IndexedDB
//
//  **跟自動暫存（storage.js）是兩件事**：暫存是一份、永遠是「現在畫面上的樣子」、開站自
//  動接回；這裡是多份、各自凍結在按下儲存的那一刻、開站不接回。兩者互不影響。
//
//  **IndexedDB 而不是 localStorage**：後者約 5MB／origin 而且跟暫存草稿共用配額，更致命
//  的是它沒辦法只讀一部分 —— 「畫出檔案清單」會變成「把全部的 MML 讀出來 parse 一遍」。
//  兩個 store 就解決了：清單只讀 `files`，`data` 只有真的要開啟時才碰。**不壓縮**（20MB
//  對 MML 文字綽綽有餘）。
//
//  **一份存檔裝全部 15 軌，一個字都不截** —— 跟分享相反（那邊只送 6 個遊戲軌、還壓縮
//  過）：分享是「送出去給別人看的最省形式」，存檔日是「我明天要接著編的工作檔」。
//
//  **一行 DOM 都不碰**，而且 `indexedDB` 只在函式裡面碰 —— test/library.test.mjs 才載得
//  起來。框與流程在 savebox.js。
// ────────────────────────────────────────────────────────────────────────────

import { MAX_TRACKS, MIN_TRACKS, cleanMeters, cleanMarks, cleanZip, anyZip } from "./config.js";
import { safeFileName } from "./mml-out.js";

/** 資料庫名。命名空間跟 storage.KEY（`mml-workshop/…`）同一組。 */
const DB_NAME = "mml-workshop";
const DB_VERSION = 1;

/** 清單只讀這個。一筆幾十個位元組。 */
const STORE_META = "files";
/** 快照本文。只有「開啟」與「批次下載」會碰。 */
const STORE_DATA = "data";

/** 快照的形狀版本。形狀一改就要 +1，讀到不認得的版本就當那一筆壞掉。 */
export const SNAPSHOT_VERSION = 1;

/** 整個檔案庫的上限。IndexedDB 給得起更多，這個數字是為了不讓使用者塞爆自己的磁碟。 */
export const MAX_BYTES = 20 * 1024 * 1024;

/** 檔名的字數上限。這個名字**不是**檔案系統的名字（見 cleanName），限制只是清單那一欄。 */
export const MAX_NAME = 100;

// ─── 純函式：檔名 ───────────────────────────────────────────────────────────

/**
 * 使用者打的字 → 存檔名。**刻意不套 `safeFileName`**：那一支處理的是檔案系統的規矩，而
 * 這個名字只活在 IndexedDB 裡（`AC/DC - 雷電` 完全合法）。真正要套的是**組 zip 內檔名**
 * 竹的時候，見 zipEntryNames。
 *
 * 先 trim 再切，切完再 trim 一次 —— 第 100 個字元剛好是空白時，只 trim 一次會留下一個
 * 尾端有空白的名字，而它跟使用者看到的字串長得一模一樣卻比對不相等。
 */
export function cleanName(input) {
  return String(input ?? "").trim().slice(0, MAX_NAME).trim();
}

/**
 * 一批存檔名 → zip 裡的檔名（含 `.mml`）。
 *
 * **是 `.mml` 不是 `.mmi`**：`.mmi` 的 `mml-track=` 是 INI 的 key=value ——**一行**，排版
 * 會被剝光；`.mml` 的 `[ChannelN]` body 是多行的，而且擴充區塊還帶得走樂器與軌名。
 *
 * 兩件事一起做，順序不能反：`safeFileName` **會製造碰撞**（`a/b` 與 `a-b` 都變成 `ab`），
 * 而 zip 允許重複檔名、解壓時後者**靜默地**覆蓋前者。去重用 `-2`、`-3`…，而且**比對時不
 * 分大小寫**：Windows 與 macOS 的檔案系統預設不分大小寫。
 *
 * @param {string[]} names 存檔名
 * @returns {string[]} 對應的 zip 內檔名，長度與順序跟輸入一致
 */
export function zipEntryNames(names) {
  const used = new Set();
  return names.map(n => {
    const base = safeFileName(n);
    let name = `${base}.mml`;
    // 從 2 開始數：沒有 `x-1.mml`，那會讓人以為原本那個檔案不見了。
    for (let i = 2; used.has(name.toLowerCase()); i++) name = `${base}-${i}.mml`;
    used.add(name.toLowerCase());
    return name;
  });
}

// ─── 純函式：清洗 ───────────────────────────────────────────────────────────

/**
 * 一十軌的清洗。**每個欄位都當成不可信的**（可能是別的版本寫的，也可能是使用者在 DevTools
 * 裡改過的）。
 *
 * `ghost` 用 `!== false` 而不是 `=== true`：顯示旗標的預設是**開著**，所以「沒寫過」要當
 * 成開 —— 反過來寫的話，這個欄位加進來之前存的檔案開回來會整份看不見。
 *
 * 沒有共用 storage.js 的清洗是因為那個檔案在模組頂層就叫 `addEventListener`。
 */
function cleanTab(t) {
  return {
    text: typeof t?.text === "string" ? t.text : "",
    preset: typeof t?.preset === "string" ? t.preset : null,
    ghost: t?.ghost !== false,
  };
}

const int = (v, lo, hi, fallback) =>
  (Number.isInteger(v) ? Math.min(hi, Math.max(lo, v)) : fallback);

/**
 * 一份存檔快照的清洗。認不出來就回 null（呼叫端要當成「這一筆壞了」）。
 */
export function cleanSnapshot(s) {
  if (!s || typeof s !== "object" || s.v !== SNAPSHOT_VERSION) return null;
  if (!Array.isArray(s.tabs)) return null;

  const tabs = s.tabs.slice(0, MAX_TRACKS).map(cleanTab);
  if (!tabs.length) return null;

  const count = int(s.count, MIN_TRACKS, MAX_TRACKS, MIN_TRACKS);
  return {
    v: SNAPSHOT_VERSION,
    tabs,
    count,
    active: int(s.active, 0, count - 1, 0),
    // **卜選填。** 版本號刻意沒有跟著升 —— 升了的話這個函式會對每一份既有存檔回 null
    // （開不起來），而伺服器那邊寫死 `ver != 1` 也會直接拒收。沒有拍號時**不寫這個欄
    // 位**，所以只有 4/4 的譜存出來跟以前逐位元組相同。
    ...(s.meters === undefined ? {} : { meters: cleanMeters(s.meters) }),
    ...(s.marks === undefined ? {} : { marks: cleanMarks(s.marks) }),
    // 壓縮模式同上：**沒有任何一軌壓過的譜整個不放這個 key**，所以絕大多數存檔存出來
    // 跟以前逐位元組相同。放在頂層而不是每個 tab 裡，也是為了這件事 —— 塞進 tab 的話
    // 每一份存檔都會多 15 個 `"zip":null`。
    ...(s.zip === undefined ? {} : { zip: cleanZip(s.zip) }),
  };
}

/**
 * 一筆 metadata 的清洗。清單畫得出來就好，所以壞掉的數字退回 0 而不是丟掉整筆 —— 一個
 * 「音符數顯示 0」的列還救得回來（開啟它就對了）。
 */
export function cleanFile(f) {
  const name = cleanName(f?.name);
  if (!name) return null;
  const num = v => (Number.isFinite(v) && v >= 0 ? v : 0);
  const created = num(f?.createdMs);
  return {
    name,
    createdMs: created,
    // 更新時間比建立時間早是不可能的，那種資料排序出來會很怪。取大的那個。
    updatedMs: Math.max(created, num(f?.updatedMs)),
    tracks: num(f?.tracks),
    notes: num(f?.notes),
    bytes: num(f?.bytes),
  };
}

// ─── 純函式：換形狀 ─────────────────────────────────────────────────────────

/**
 * `tracks.snapshot()` ＋ `tracks.ghostFlags()` → 存進 DB 竹的形狀。
 *
 * **逐欄挑**而不是 `{ ...snap }` 整包搬：快照是給 undo 用的執行期物件，以後多長出一個欄
 * 位就會被順手寫進資料庫，而結構化複製碰到 DOM 節點會直接丟例外。
 *
 * **`mutes` 刻意不進來**，而 `ghost` 進來：把 15 軌一顆顆關到只剩兩軌是很費工的設定，而
 * 靜音只是「這一遍先別聽和弦」。15 軌全存，`count` 只是「開著幾個分頁」。
 *
 * @param {object} snap    tracks.snapshot()
 * @param {boolean[]} ghosts tracks.ghostFlags()
 */
export function fromSnapshot(snap, ghosts, meters, marks) {
  return {
    v: SNAPSHOT_VERSION,
    count: snap.count,
    active: snap.active,
    // 只有 4/4 的譜**整個不放這個 key**（不是放 undefined —— 那仍然是一個 key，而
    // `deepStrictEqual` 分得出來）。
    ...(meters?.length ? { meters } : {}),
    // 同上：沒有標記的譜整個不放這個 key，存出來跟以前逐位元組相同。
    ...(marks?.length ? { marks } : {}),
    //  壓縮模式。**本機存檔要帶，分享連結與匯出不帶** —— 存檔是「我自己的工作狀態」，
    // 不存的話優化、存檔、重開、編輯，字數就跳回去了（也就是這個功能本來要修的那個
    // 問題，只是換到存檔流程重演一次）。分享出去的是成品，收到的人不該繼承你的編輯器
    // 模式，而那一份本來在匯出時就會壓過一次。
    ...(anyZip(snap.zip) ? { zip: [...snap.zip] } : {}),
    tabs: Array.from({ length: MAX_TRACKS }, (_, i) => ({
      text: snap.texts[i] ?? "",
      preset: snap.presets[i] ?? null,
      ghost: ghosts[i] !== false,
    })),
  };
}

/**
 * 存在 DB 的形狀 → `tracks.applySnapshot()` 吃的形狀，讓「開啟存檔」跟 Ctrl+Z、跟換語言
 * 走**完全同一條路**。
 *
 * **這裡多產一個 `ghosts`，而 `tracks.snapshot()` 不產** —— 那是顯示旗標唯一的卜還原路徑
 * （`applySnapshot` 對它是「有給才動」，所以復原與換語言碰不到）。後果是開啟存檔後按
 * Ctrl+Z，顯示旗標會留在剛開起來那一份的樣子；它看得見、一鍵就改得回來。
 *
 * `mutes` **不在回傳值裡**，所以開啟存檔會沿用使用者現在的靜音。
 */
export function toSnapshot(saved) {
  return {
    texts: saved.tabs.map(t => t.text),
    presets: saved.tabs.map(t => t.preset),
    ghosts: saved.tabs.map(t => t.ghost),
    //  **一律給一份，沒有這個欄位的存檔給全 null。** 這裡跟 fromSnapshot 的規則不對稱是
    // 刻意的：寫出去是「沒用到就別佔位元組」，讀回來是「開一份檔就要把狀態說滿」。
    //
    //  少了它，`applySnapshot` 的 `if (Array.isArray(s.zip))` 會在開舊存檔時整個跳過，
    // 於是**上一首歌的壓縮模式留在新開的譜上** —— 同 metersOf 那段講的「開一份 4/4 的舊
    // 存檔之後還留著上一首的 3/4」，是最難查的那種錯。
    zip: cleanZip(saved.zip),
    count: saved.count,
    active: saved.active,
  };
}

/**
 * 存檔裡的拍號。**刻意不放進 `toSnapshot()`** —— 拍號是曲子的屬性不是分頁的狀態。
 * **沒有這一欄的存檔回全曲 4/4**，不是「不要動現在的拍號」：開啟一份 4/4 的舊存檔之後還
 * 留著上一首的 3/4 是最難查的那種錯。
 */
export const metersOf = saved => cleanMeters(saved?.meters);

/** 存檔裡的段落標記。**刻意不放進 `toSnapshot()`**，理由同 `metersOf`。 */
export const marksOf = saved => cleanMarks(saved?.marks);

// ─── 純函式：配額 ───────────────────────────────────────────────────────────

const utf8 = new TextEncoder();

/**
 * 一份快照佔多少空間。量的是 **JSON 的 UTF-8 位元組數**，跟 IndexedDB 實際存的結構化複製
 * 產物不會完全相等 —— 刻意的：使用者要的是一個跟「這份譜有多大」成正比的穩定數字。
 */
export const snapshotBytes = snap => utf8.encode(JSON.stringify(snap)).length;

/**
 * 存得下嗎？`replacing` 日是「這次會覆蓋掉的那一筆現在佔多少」—— 少了它，一個把庫塞到
 * 19.5MB 的使用者連「把某一份改一個音再存回去」都會被擋下來。
 *
 * @returns {{ok:boolean, used:number, need:number, free:number}}
 */
export function fits(used, bytes, replacing = 0) {
  const after = used - replacing + bytes;
  return {
    ok: after <= MAX_BYTES,
    used,
    need: bytes,
    free: Math.max(0, MAX_BYTES - used + replacing),
  };
}

// ─── DB ─────────────────────────────────────────────────────────────────────

let dbPromise = null;
let broken = false;

/** IndexedDB 不能用（無痕、企業政策、配額）時為 true，UI 會據此改提示。 */
export const isBroken = () => broken;

/**
 * 開資料庫。整個模組**只在這裡碰 `indexedDB`**，而且是在函式裡面 —— 模組頂層碰它會讓這
 * 個檔案進不了 node --test。結果快取成一個 promise；失敗**不快取**（使用者可能剛把無痕
 * 視窗切回一般視窗）。
 */
function open() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    if (typeof indexedDB === "undefined") { reject(new Error("no indexedDB")); return; }
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      // keyPath 就是木檔名 —— 這個功能沒有 id 的概念，同名就是同一個檔案
      // （所以「儲存」撞名時要問覆蓋，見 savebox）。
      if (!db.objectStoreNames.contains(STORE_META))
        db.createObjectStore(STORE_META, { keyPath: "name" });
      if (!db.objectStoreNames.contains(STORE_DATA))
        db.createObjectStore(STORE_DATA, { keyPath: "name" });
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error("open failed"));
    // 別的分頁開著舊版本時會卡在這裡。當成不能用 —— 使用者看到的是一句提示，
    // 而不是一個永遠轉不完的框。
    req.onblocked = () => reject(new Error("blocked"));
  }).catch(err => {
    broken = true;
    dbPromise = null;
    throw err;
  });
  return dbPromise;
}

/** 一個 IDBRequest → promise。 */
const wrap = req => new Promise((resolve, reject) => {
  req.onsuccess = () => resolve(req.result);
  req.onerror = () => reject(req.error ?? new Error("request failed"));
});

/** 一個交易完成（**不是**最後一個 request 成功）→ promise。寫入一定要等這人個。 */
const done = tx => new Promise((resolve, reject) => {
  tx.oncomplete = () => resolve();
  tx.onerror = () => reject(tx.error ?? new Error("tx failed"));
  tx.onabort = () => reject(tx.error ?? new Error("tx aborted"));
});

/**
 * 全部的 metadata，**更新時間新到舊**。不做分頁（20MB 裝不下多到需要分頁的筆數），排序在
 * 這裡做而不是靠索引 —— 多一個索引就多一個 schema 版本要維護。
 */
export async function list() {
  const db = await open();
  const rows = await wrap(db.transaction(STORE_META, "readonly").objectStore(STORE_META).getAll());
  return rows.map(cleanFile).filter(Boolean).sort((a, b) => b.updatedMs - a.updatedMs);
}

/** 全庫用掉多少。清單那一行的「已用 x / 20 MB」就是它。 */
export const usedBytes = files => files.reduce((n, f) => n + f.bytes, 0);

/**
 * 讀一份存檔的內容。找不到、或內容認不出來都回 null —— 呼叫端要把兩者講成同一句話，因為
 * 對使用者來說它們是同一件事。
 */
export async function read(name) {
  const db = await open();
  const rec = await wrap(db.transaction(STORE_DATA, "readonly").objectStore(STORE_DATA).get(name));
  return rec ? cleanSnapshot(rec.snapshot) : null;
}

/**
 * 寫一份存檔。**metadata 與內容在同一個交易裡** —— 分兩次寫竹的話，中間斷電會留下一筆「清
 * 單看得到但開不起來」的檔案。
 *
 * @param {{name:string, createdMs:number, updatedMs:number,
 *          tracks:number, notes:number, bytes:number}} meta
 * @param {object} snapshot fromSnapshot() 的產物
 */
export async function write(meta, snapshot) {
  const db = await open();
  const tx = db.transaction([STORE_META, STORE_DATA], "readwrite");
  tx.objectStore(STORE_META).put(meta);
  tx.objectStore(STORE_DATA).put({ name: meta.name, snapshot });
  await done(tx);
}

/** 刪掉幾份。一樣同一個交易 —— 刪一半會留下孤兒。批次刪除是清空間的主要月用途。 */
export async function remove(names) {
  if (!names.length) return;
  const db = await open();
  const tx = db.transaction([STORE_META, STORE_DATA], "readwrite");
  const meta = tx.objectStore(STORE_META), data = tx.objectStore(STORE_DATA);
  for (const n of names) { meta.delete(n); data.delete(n); }
  await done(tx);
}
