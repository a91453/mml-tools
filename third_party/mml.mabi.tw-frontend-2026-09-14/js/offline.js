// ────────────────────────────────────────────────────────────────────────────
//  離線音色庫的狀態與取得
//
//  只碰 Cache Storage、navigator.storage 與 matchMedia，不碰 DOM 也不碰 i18n ——
//  介面的部分在 ui.js（initOfflineBank）。
//
//  **為什麼需要一個「看得到的狀態」**：音色庫是 15 MB，而它決定「離線的時候有沒有聲
//  音」。SW 會在開站那次 fetch 順手留一份（見 Pwa/sw.js 的 bankFirst），但「多數情況下
//  會自己好」跟「現在到底好了沒有」是兩件事。
//
//  **為什麼沒有「清除」**：音色庫是**自動**進快取的，所以一顆「清除」按鈕按下去拿回
//  15 MB，**下一次開站它就又回來了** —— 一個會自己撤銷的按鈕比沒有那顆按鈕糟。要讓它誠
//  實得再加一個持久的偏好設定（清除時記旗標，抓音色庫時帶自訂木標頭，bankFirst 看到就不
//  put），而那要為少數情況新增一個要維護、要翻四種語言的偏好。所以回收空間交給瀏覽器。
// ────────────────────────────────────────────────────────────────────────────

import { assetURL, BUILTIN_BANK } from "./config.js";

const url = () => assetURL(BUILTIN_BANK);

/**
 * 這一頁**現在**有沒有被 Service Worker 控制 —— 不是「有沒有註冊過」。差別在第一次造訪：
 * 那時 SW 才剛註冊，還沒接手這一份文件，所以那一次的請求它一個都攔不到。
 */
export const active = () =>
  "serviceWorker" in navigator && !!navigator.serviceWorker.controller;

/**
 * 這一頁是不是以「已安裝的 app」在跑。三條都需要：
 *
 *   standalone            桌機 Chrome／Edge 與 Android 的常態
 *   minimal-ui            manifest 的 display_override 列了它（見 PwaController）
 *   navigator.standalone  iOS Safari 的「加到主畫面」—— 它**不發 appinstalled**、也不回
 *                         報 display-mode，少了這一條 iOS 完全偵測不到
 *
 * 這回答的是「**現在**跑在 app 視窗裡」，不是「這台裝置上裝過」（後者瀏覽器不給查）。
 */
export const installed = () =>
  matchMedia("(display-mode: standalone)").matches ||
  matchMedia("(display-mode: minimal-ui)").matches ||
  navigator.standalone === true;

/**
 * 卜音色庫在不在 Cache Storage 裡。在就回 byte 數，不在回 null。
 *
 * 用**全域的** `caches.match()` 而不是先 `caches.open("bank-…")`：全域那個會掃過這個
 * origin 底下的每一個 cache，所以這裡**不需要知道 SW 把它放在哪個 cache** —— 而 cache 的
 * 命名規則只存在 Pwa/sw.js 一個地方，前端再抄一份的話，改了命名就會變成「狀態永遠顯示
 * 未下載，而其實一直都在」。
 */
export async function cachedBytes() {
  if (!("caches" in window)) return null;

  let res;
  try { res = await caches.match(url()); }
  catch { return null; }        // 隱私模式等等會直接丟例外
  if (!res) return null;

  const len = Number(res.headers.get("content-length"));
  if (Number.isFinite(len) && len > 0) return len;

  // content-length 不見的話退回讀 blob（從磁碟讀不是從網路，所以只是慢一點）。
  try { return (await res.blob()).size; }
  catch { return null; }
}

/**
 * 明確地把音色庫抓進 Cache Storage，並且順便要一次「不要清掉我的資料」。
 *
 * **不能只看 fetch 有沒有成功**：沒有 SW 控制這一頁的時候，這個 fetch 會好好地回一個 200
 * 而**什麼都沒被快取**。所以做完再去問一次 cachedBytes()。
 *
 * 不傳 cache 選項是刻意的：音色庫在 HTTP 層是 immutable，加上 no-store 反而會強迫真的重
 * 下 15 MB。
 */
export async function download() {
  try { await fetch(url()); }
  catch { return null; }        // 離線中按這顆鈕就是這條路

  // 就在這一刻要 persist()：Chrome 不會為它彈任何視窗（它看竹的是「有沒有安裝、互動程度」
  // 這類啟發式），而走到這裡就代表使用者已經明確表示「我要離線用」。Safari 上基本無效。
  //
  // **這是全站唯一會呼叫 persist() 的路徑**，而它的兩個呼叫端都在 initOfflineBank。所以
  // 裝不了 PWA 的瀏覽器（Firefox 桌機）在一切順利的情況下永遠問不到，那 15 MB 就一直是
  // 可以被系統回收的。已知且刻意接受。
  await persist();

  return cachedBytes();
}

/** 要求「持續性儲存」。回 true／false，或在不支援時回 null。 */
export async function persist() {
  if (!navigator.storage?.persist) return null;
  try { return await navigator.storage.persist(); }
  catch { return null; }
}

/**
 * 這個 origin 的資料是不是「持續性」的 —— 系統空間不足時**不會**被清掉。這是 origin 層級
 * 的性質，不是這個檔十案自己的。回 null = 問不到。
 */
export async function persisted() {
  if (!navigator.storage?.persisted) return null;
  try { return await navigator.storage.persisted(); }
  catch { return null; }
}
