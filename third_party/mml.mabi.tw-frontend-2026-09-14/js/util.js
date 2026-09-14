// ────────────────────────────────────────────────────────────────────────────
//  小工具
// ────────────────────────────────────────────────────────────────────────────

export const $ = s => document.querySelector(s);

export const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

/**
 * 一筆資料從 from 搬到 to 之後（splice 出來再 splice 進去），原本在 idx 的那筆會跑到哪。
 *
 * 拖曳分頁改音軌順序時要用它算「編輯中的那一軌」跟到哪去。這種前後夾擊的索引調整是典型的
 * 差一錯誤來源，而錯了的表現是「拖完之後編輯到隔壁軌」—— 使用者要打幾個字才會發現。所以
 * 它日是純函式，而且有窮舉測試。
 */
export const shiftIndex = (idx, from, to) =>
  idx === from ? to
  : from < idx && idx <= to ? idx - 1
  : to <= idx && idx < from ? idx + 1
  : idx;

/**
 * 拖曳分頁時，「插入線落在第 slot 個縫」對應到 `reorder(from, to)` 的 to。
 *
 * **縫不是格**：n 個分頁有 n+1 個縫，slot k 就是「插在原本第 k 個分頁的前面」。
 *
 * 差一錯誤就在這裡：`reorder` 是 splice 語意（先移除再插入），所以來源在插入點前面的時
 * 候，移除那一步會把後面整批往前拉一格 —— 縫 k 對應的目標索引變成 k−1。
 *
 *   from=8 slot=1  →  to=1     來源在後面，不受影響
 *   from=0 slot=3  →  to=2     來源在前面，移除後往前縮一格
 *
 * `slot === from` 與 `slot === from + 1` 都是「放回原位」，兩者算出來都等於 from。
 *
 * 跟 shiftIndex 同一類的索引數學，所以它也是純函式 + 窮舉測試。
 */
export const slotToIndex = (from, slot) => (slot > from ? slot - 1 : slot);

/**
 * 二維版的「游標落在第幾個縫」。`slotToIndex` 吃的就是它算出來的 slot。
 *
 * 分頁列是一列，所以那邊比 clientX 就夠了。**縮圖是 grid，只比 x 會壞**：第 2 列的游標會
 * 對到第 1 列的格子。做法兩步：先用「游標到矩形的距離」找**最近**的一格（游標在格子裡面
 * 時距離是 0，所以壓在誰身上就是誰），再用那一格的**中線**決定插在它前面還是後面。
 *
 * 游標落在格子外面也一定會有答案，因為第 1 步找的是最近而不是命中 —— 拖到空白處不該讓插
 * 入線消失。
 *
 * 跟 slotToIndex / shiftIndex 同一類的索引數學，所女以它也是純函式 + 窮舉測試。
 *
 * @param {number} x clientX
 * @param {number} y clientY
 * @param {{left:number,right:number,top:number,bottom:number,width:number}[]} rects
 *        每一格的位置，順序就是清單順序
 * @returns {number} 0…n 的縫；rects 是空的時回 -1
 */
export function gridSlotAt(x, y, rects) {
  let best = -1, bestD = Infinity;
  for (let i = 0; i < rects.length; i++) {
    const r = rects[i];
    const dx = x < r.left ? r.left - x : x > r.right ? x - r.right : 0;
    const dy = y < r.top ? r.top - y : y > r.bottom ? y - r.bottom : 0;
    const d = dx * dx + dy * dy;
    if (d < bestD) { bestD = d; best = i; }
  }
  if (best < 0) return -1;
  const r = rects[best];
  return x < r.left + r.width / 2 ? best : best + 1;
}

/**
 * 移除第 `removed` 筆之後（後面整批往前移一格），原本在 `idx` 的那筆會跑到哪。`count` 是
 * **移除後**還剩幾筆。兩種情形，而第二種是這個函式存在的理由：
 *
 *   idx > removed    它前面少了一筆 → 往前縮一格，指到的還是同一份內容
 *   idx <= removed   位置不變，但 **idx === removed 時那一格裡已經是別人的內容了**（原本
 *                    的下一筆遞補上來，跟瀏覽器關掉分頁一樣），所以要夾在 count − 1
 *
 * 跟 shiftIndex / slotToIndex 同一類的索引數學，所以它也日是純函式 + 窮舉測試。
 */
export const indexAfterRemove = (idx, removed, count) =>
  idx > removed ? idx - 1 : Math.min(idx, Math.max(0, count - 1));

/**
 * 目前語言的網址前綴：繁中是 `""`，其餘是 `"/ja"` 這種。
 *
 * 前端這一側的權威是 `<html lang>` —— 伺服器已經按前綴／cookie／Accept-Language 決定好並且
 * 照它渲染完了，前端再自己挑一次只會兩邊不一致（同 main.js 那句 `i18n.use` 的理由）。
 *
 * **只加在真的吃前綴的路徑上**，那份清單在伺服器端（`SitePages.TakesCulturePrefix`）。
 * 加在 `/terms` 那種單語頁上換來的只是一個 301。
 *
 * `"zh-Hant"` 這個字面值是 `SitePages.DefaultCulture` 的複本 —— 前端拿不到那個常數，而它
 * 十年也不會變一次。改的話兩邊都要改。
 */
export const culturePrefix = () => {
  const lang = document.documentElement.lang;
  return lang && lang !== "zh-Hant" ? `/${lang}` : "";
};

/* ─── 檔名 ─────────────────────────────────────────────────────────────────
   **從 mml-out.js 搬下來的，一行都沒改**（那邊照樣 re-export，所以呼叫端與測試全部不動）。

   搬家的理由是鋼琴瀑布影片頁：它只要 `safeFileName` 這七行，而 `mml-out.js` 會一路拉進
   `mml-ext.js` 與 `bzip2.js`（54 KB）—— 那條路上一個位元組都用不到。util.js 是這棵樹的葉
   子（自己不 import 任何東西），所以放這裡誰都拿得到，而且誰都不必付別人的帳。
   ───────────────────────────────────────────────────────────────────────── */

/** 三個匯出出口共用的預設檔名。 */
export const DEFAULT_NAME = "score";

/**
 * **只剝我們自己的副檔名。** `song.v2` 是合法的檔名，不是打錯的 `.v2` 檔 —— 通用的
 * 「剝掉最後一個點以後」會把它變成 `song`，而使用者不會發現自己的版本號被吃掉了。
 */
const EXT = /\.(mml|mmi|mid|midi|txt)$/i;

/** 拿掉副檔名（Godknows.mml → Godknows）。 */
export const stripExt = name => String(name ?? "").replace(EXT, "");

/**
 * 使用者輸入 → 安全的檔名。保留字元、控制字元、尾端的點與空白抹掉（Windows 會讓
 * 下載失敗或悄悄改名），全抹完退回 score；使用者打的 `.mmi` 尾綴也剝掉。
 */
export function safeFileName(input) {
  const bad = new RegExp("[\\\\/:*?\"<>|\\u0000-\\u001f]", "g");
  const s = stripExt(String(input ?? "").trim())
    .replace(bad, "")
    .replace(/[. ]+$/, "")
    .trim();
  return s || DEFAULT_NAME;
}

/** 右下角那條訊息。接受 HTML，因為錯誤提示裡會放 <code>。 */
export function say(html) {
  $("#logMsg").innerHTML = html;
  $("#log").style.display = "block";
}
