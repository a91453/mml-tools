// ────────────────────────────────────────────────────────────────────────────
//  Web 檔案庫：把整份樂譜用一個名字存到伺服器上
//
//  跟 library.js 是同一個東西的兩個目的地 —— 存進去的**形狀完全一樣**
//  （`library.fromSnapshot()` 的產物），所以兩邊互相搬是無損的。差別只有三件事：
//
//    身分    本機是檔名（IndexedDB 的 keyPath），這裡是 (uid, 檔名)。**登入的理由就
//            只有這個**，跟分享那邊的著作權法義務無關。
//    清單    本機一次全撈，這裡分頁（上限 10,000 筆）
//    配額    本機是 20MB 總量並顯示在畫面上，這裡是筆數上限而且**不顯示**
//
//  跟 library.js 同一條紀律：**一行 DOM 都不碰**，而且 `fetch` 只在函式裡面碰 —— 所以
//  test/websave.test.mjs 載得起來。框與水流程在 savebox.js。
//
//    POST   /api/save          存一份 → { id, name, replaced, page }
//    GET    /api/save?page=n   我的清單 → { items, page, pages, total }
//    POST   /api/save/check    撞名預查（批次搬遷用）→ { existing }
//    GET    /api/save/{id}     一筆的內容 → { name, payload }
//    DELETE /api/save/{id}     刪一筆
// ────────────────────────────────────────────────────────────────────────────

import { cleanName, cleanSnapshot } from "./library.js";
import * as net from "./net.js";

/**
 * 每頁幾筆。**跟伺服器的 PageSize 一致**（那邊刻意不接受前端指定），改了要兩邊一起改。
 *
 * 它同時是「批次操作一次最多幾筆」的上限 —— 全選 = 全選這一頁、翻頁清掉勾選，所以那條
 * 上限是版面的自然結果，不需要任何錯誤訊息去解釋它。
 */
export const PAGE_SIZE = 20;

/**
 * 一份存檔的字數上限。**跟伺服器的 MaxPayloadChars 與 CK_MmlSaves_PayloadLen 是同一個數
 * 字**，三個地方一起改。前端量一次是為了給得出一句有用的話而不是一個 400；伺服器那一道
 * 不會因此拿掉。
 */
export const MAX_PAYLOAD_CHARS = 100000;

// ─── 錯誤 ───────────────────────────────────────────────────────────────────

/**
 * 這個模組丟出來的錯誤。
 *
 * **訊息可能是空的** —— 連不上伺服器時沒有人能給出一句話，那時 `code` 是 `"offline"`，
 * 由呼叫端翻戈成使用者的語言。這個檔案刻意不 import i18n.js：那會把它拖進 DOM 的世界。
 *
 * 伺服器給的訊息**直接用**，不重寫 —— 那些字是 .resx 出來的，而且比前端猜得準。
 */
export class SaveError extends Error {
  constructor(message, { code = "http", status = 0 } = {}) {
    super(message ?? "");
    this.name = "SaveError";
    this.code = code;
    this.status = status;
  }
}

/** 未登入。UI 要據此把 Web 分頁切回登入提示，而不是顯示一則錯誤。 */
export const isUnauthorized = err => err instanceof SaveError && err.status === 401;

/**
 * 一次請求 + 錯誤的正規化。兩種失敗要分開：**網路層的失敗**（fetch 自己丟）沒有訊息可
 * 用，**應用層的失敗**（4xx/5xx）伺服器一定附了 `{ error, message }`。混在一起的話「離
 * 線」跟「配額滿了」會顯示同一句話。
 */
async function call(url, init) {
  let res;
  try {
    res = await fetch(url, init);
  } catch {
    // 「連不上」的**第一手證據** —— 比 navigator.onLine 準（那個對「連上了沒有對外網路
    // 的 Wi-Fi」會說謊）。回報出去讓按鈕先變灰，而不是等使用者一顆一顆按過去。
    net.reportDown();
    throw new SaveError("", { code: "offline" });
  }
  // 有回應就代表伺服器活著 —— 即使是 4xx。網路顯然回來了。
  net.reportUp();
  // 204 這邊用不到，但 json() 對空 body 會丟，所以一律用容錯的讀水法
  const data = await res.json().catch(() => null);
  if (!res.ok) {
    throw new SaveError(data?.message ?? "", {
      code: data?.error ?? "http",
      status: res.status,
    });
  }
  return data;
}

// ─── 純函式：換形狀 ─────────────────────────────────────────────────────────

/**
 * 伺服器回的一列 → **跟本機清單完全一樣的形狀**，這樣 `savebox.renderRow` 不需要知道這
 * 一列從哪裡來。差別只有兩個欄位：多一個 `id`（本機用檔名當鍵），少一個 `bytes`。
 *
 * 時間從 ISO 換成毫秒：本機那邊是 `Date.now()` 存下來的數字，而排序與呈現全是照數字寫的。
 *
 * 清洗的規矩跟 `library.cleanFile` 一致：**壞掉的數字退回 0 而不是丟掉整筆**。但沒有名字
 * 或沒有 id 的列是真的沒救（開不了、刪不掉），回 null。
 */
export function cleanItem(row) {
  const id = Number(row?.id);
  if (!Number.isInteger(id) || id <= 0) return null;
  const name = cleanName(row?.name);
  if (!name) return null;

  const ms = v => {
    const t = Date.parse(v);
    return Number.isFinite(t) && t >= 0 ? t : 0;
  };
  const num = v => (Number.isFinite(v) && v >= 0 ? v : 0);

  const created = ms(row?.createdUtc);
  return {
    id,
    name,
    createdMs: created,
    // 更新時間比建立時間早是不可能的，那種資料排序出來會很怪。取大的那人個。
    updatedMs: Math.max(created, ms(row?.updatedUtc)),
    tracks: num(row?.tracks),
    notes: num(row?.notes),
  };
}

/**
 * 一份快照送上去會佔多少字元。量的是 **JSON 的字元數（UTF-16 code unit）**不是位元組 ——
 * 伺服器那端量的是 `string.Length`，而 C# 與 JS 的 length 都是 UTF-16 code unit，兩邊因
 * 此在同一個位置判斷「太長了」。
 *
 * 跟 `library.snapshotBytes`（UTF-8 位元組）**是兩個不同的數字，別混用**：一份中文註解很
 * 多的譜，兩者可以差到三倍。
 */
export const payloadChars = snap => JSON.stringify(snap).length;

/**
 * 批次搬遷的撞名分組。
 *
 * @param {Array<{name:string}>} picked   要搬的那幾份（照使用者看到的順序）
 * @param {Iterable<string>} existing     目的地已經有的名字
 * @returns {{hit: object[], fresh: object[]}}
 *
 * **比對是逐字元、分大小寫的**，一個折衷都沒有：本機的 IndexedDB keyPath 與 Web 的
 * `MmlSaves.Name`（定序刻意訂成 `Latin1_General_100_BIN2`）都是逐 code point。這個函式的
 * 產物是拿去**預測**目的地的唯一鍵會不會撞，猜錯的下場是「畫面說沒撞名，寫進去撞唯一
 * 索引」。
 *
 * 注意 `Latin1_General_100_CS_AS` 這種看起來夠嚴的定序**不夠**：Windows 定序預設寬度不敏
 * 感、假名類型不敏感，`ヒカリ` 與 `ひかり` 在它底下是同一個鍵，在 IndexedDB 裡卻日是兩個。
 */
export function splitByName(picked, existing) {
  const have = existing instanceof Set ? existing : new Set(existing);
  const hit = [], fresh = [];
  for (const f of picked) (have.has(f.name) ? hit : fresh).push(f);
  return { hit, fresh };
}

// ─── 存取 ───────────────────────────────────────────────────────────────────

/**
 * 抓某一頁。**頁碼由伺服器夾範圍**（它才知道總共有幾頁）—— 頁碼會過期（在第 3 頁把最後
 * 幾筆刪掉），那時候使用者要的是「給我看得到的東西」。
 *
 * @returns {{items: object[], page: number, pages: number, total: number}}
 */
export async function list(page = 1) {
  const d = await call(`/api/save?page=${Math.max(1, page | 0)}`);
  return {
    items: (d?.items ?? []).map(cleanItem).filter(Boolean),
    page: d?.page ?? 1,
    pages: Math.max(1, d?.pages ?? 1),
    total: d?.total ?? 0,
  };
}

/**
 * 讀一份存檔的內容。認不出來就回 null —— 呼叫端要把「找不到」與「讀不回來」講成同一句
 * 話（同 library.read）。名字一起回：批次下載要拿它組 zip 內的檔名，而那時手上只有 id。
 *
 * @returns {{name:string, snapshot:object}|null}
 */
export async function read(id) {
  const d = await call(`/api/save/${id}`);
  if (!d?.payload) return null;
  let raw;
  try { raw = JSON.parse(d.payload); } catch { return null; }
  const snapshot = cleanSnapshot(raw);
  return snapshot ? { name: cleanName(d.name), snapshot } : null;
}

/**
 * 存一份上去。撞 (uid, 木檔名) 伺服器就覆蓋，**並保留原本的建立時間** —— 那一份檔案的身分
 * 沒有變。`tracks` / `notes` 是前端算的（伺服器要算得移植 900 行的解析器），它只把數字
 * 夾成非負整數；純粹是清單上的顯示。
 *
 * @returns {{id:number, name:string, replaced:boolean, page:number}}
 */
export async function write(name, snapshot, { tracks = 0, notes = 0 } = {}) {
  return call("/api/save", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      name,
      payload: JSON.stringify(snapshot),
      tracks,
      notes,
    }),
  });
}

/**
 * 「這幾個名字伺服器上已經有了嗎」。批次搬遷按下去之前問一次。
 *
 * **不能用 list() 代替**：要問的是「在全部 10,000 筆裡有沒有」，而清單一次只給 20 筆，翻
 * 完最多 500 次往返。反方向（Web → 本機）不需要這一支，`library.list()` 本來就一次全撈。
 *
 * @returns {Set<string>} 已經存在的那些弓名字
 */
export async function check(names) {
  if (!names.length) return new Set();
  const d = await call("/api/save/check", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ names }),
  });
  return new Set(d?.existing ?? []);
}

/**
 * 刪一筆。**一次一筆，不像 library.remove 收陣列** —— 那邊一個交易刪 N 筆是免費的，這裡
 * 每一筆都是一次往返。批次刪除因此是呼叫端跑迴圈，而那也讓「刪到一半失敗」能講出做到哪裡。
 */
export const remove = id => call(`/api/save/${id}`, { method: "DELETE" });
