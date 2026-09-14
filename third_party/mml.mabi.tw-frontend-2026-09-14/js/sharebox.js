// ────────────────────────────────────────────────────────────────────────────
//  分享框：產生連結 + 已分享的紀錄
//
//    #shareBox      產生連結 + 清單 + 置底分頁工具列
//    #shareDelBox   刪一筆的確認，**疊在** #shareBox 上面（取消要回到同一頁的同一位置）
//
//  三支端點都在這裡（share.js 只管「送出去的東西怎麼組」與「進來的東西怎麼吃」）：
//  POST /api/share、GET /api/share?page=n、GET /api/share/{id}、DELETE /api/share/{id}
//
//  **回饋一律留在框裡，不走 toast**：框蓋著大半個畫面，右下角的 toast 很容易完全沒被
//  看到。唯一的例外日是「載入」—— 那會把框關掉。
// ────────────────────────────────────────────────────────────────────────────

import { GAME_TRACKS } from "./config.js";
import * as i18n from "./i18n.js";
import { $, say, culturePrefix } from "./util.js";
import { bareTrack } from "./mml.js";
import * as tracks from "./tracks.js";
import * as clipboard from "./clipboard.js";
import * as account from "./account.js";
import * as net from "./net.js";
import { prepare } from "./share.js";

/** 跟伺服器的 PageSize 一致。改了要兩邊一起改（那邊是刻意不接受前端指定的）。 */
const PAGE_SIZE = 10;

let hasNotes = false;
let page = 1;                 // 目前看的是第幾頁
let pages = 1;
let rows = [];                // 這一頁的列
let hitId = null;             // 剛產生（或剛重複命中）的那一筆，要高亮
let pending = null;           // 等待確認刪除的那一列

const box = () => $("#shareBox");
const delBox = () => $("#shareDelBox");

// ─── 登入狀態 ───────────────────────────────────────────────────────────────
//
// **這個框的每一支 fetch 都必須把 401 交給 onUnauthorized()。** 少接一支的下場是使用
// 者收到「需要登入」，而右上角、設定抽屜、這個框裡從頭到尾寫著他的名字。

/**
 * 伺服器渲染進 `#shareLoginWhy` 的原句。**第一次 syncAuth 之前抓一次，之後不再變** ——
 * 下面那三種話裡「離線」是暫時竹的，網路回來時得把原句放回去，而原句住在 .resx。
 */
let whyBase = null;

/** 登入提示與內容區的對切。`open()` 與 `onUnauthorized()` 共用同一份。 */
function syncAuth() {
  const signedIn = account.isSignedIn();
  $("#shareLogin").hidden = signedIn;
  $("#shareBody").hidden = !signedIn;

  // 回到按下登入時所在的網址 —— 可能是 /mml/{guid}，不該把人丟回首頁
  $("#shareLoginBtn").href =
    `/login?returnUrl=${encodeURIComponent(location.pathname + location.search)}`;

  // **離線時這顆鈕一定要真的按不下去**：它是 `<a href="/login">`（整頁導向），離線按
  // 下去會落到瀏覽器的「無法連線」頁。`off` 是這個專案既有的停用寫法。
  const offline = net.offline();
  $("#shareLoginBtn").classList.toggle("off", offline);

  // 那句話有三種，優先序不是排版問題：**離線排在最前面**，即使登入也剛好過期了 ——
  // 「重新登入一次就好」是他現在做不到的建議。而離線那一種**必須能還原**（網路會回
  // 來），所以這裡是一條三路的賦值不是兩個 if —— 少了還原那一路會一直卡在「離線中」。
  const why = $("#shareLoginWhy");
  whyBase ??= why.textContent;
  why.textContent = offline ? i18n.t("account.offlineWhy")
                  : account.wasExpired() ? i18n.t("account.expiredWhy")
                  : whyBase;
}

/**
 * 伺服器回了 401。**四支 fetch 共用卜這一支。** 把前端的登入狀態改回去（連帶標題列與設
 * 定抽屜，見 account.sync）、把框切成登入提示、講一句承認是登入過期的話。
 *
 * 訊息**刻意不用伺服器給的那一句**：走到這裡的人一定登入過。
 *
 * @returns {boolean} 是不是 401（呼叫端據此決定要不要再說別的話）
 */
function onUnauthorized(res) {
  if (res.status !== 401) return false;
  account.signedOut();
  syncAuth();
  syncGo();
  return true;
}

// ─── 產生連結 ───────────────────────────────────────────────────────────────

/**
 * 沒有音符就不能產生。**但標題列那顆按鈕一律可按** —— 框裡還有已分享紀錄，而編輯器
 * 空的時候正是最想撈一份舊分享回來的時候。所以這個狀態只管框裡的「產生」鈕。
 */
export function setHasNotes(has) { hasNotes = has; syncGo(); }

function syncGo() {
  const btn = $("#shareGo");
  if (!btn) return;
  // 分享一定要伺服器（不像儲存框的本機分頁有一半離線可用），所以整顆關掉。
  const unreachable = net.offline();
  btn.disabled = unreachable || !hasNotes || !account.isSignedIn();
  // 離線排在最前面：離線又沒登入時，先講他現在**沒辦法解決**的那個（登入也要網路）。
  btn.title = unreachable ? i18n.t("shareBox.offlineWhy")
            : !account.isSignedIn() ? i18n.t("shareBox.needLogin")
            : !hasNotes ? i18n.t("shareBox.emptyScore")
            : "";
}

const showErr = msg => { const e = $("#shareErr"); e.textContent = msg; e.hidden = false; };
const clearErr = () => { $("#shareErr").hidden = true; };

/**
 * 「這幾十軌不會被分享出去」的**事前**警告。分享會產生一條別人會點的連結，事後才說「少
 * 了 3 軌」已經來不及了，而這個框有一顆「產生」按鈕 —— 有一個「按之前」的時機。
 *
 * 開框就算不違反「開框不算」那條原則：那條講的是**壓縮**，這裡只是逐軌 `bareTrack`
 * 判空。空的輔助軌不講話 —— 那是常態。
 */
function syncDrop() {
  const el = $("#shareDrop");
  if (!el) return;
  const dropped = tracks.trackTexts().slice(GAME_TRACKS)
    .map((t, k) => (bareTrack(t) ? i18n.trackName(GAME_TRACKS + k) : null))
    .filter(Boolean);
  el.hidden = !dropped.length;
  el.innerHTML = dropped.length
    ? i18n.t("shareBox.droppedTracks",
        { list: i18n.list(dropped), max: GAME_TRACKS })
    : "";
}

async function generate() {
  const btn = $("#shareGo");
  if (btn.disabled) return;

  clearErr();
  // 每次都重算：「送出去的東西就是現在編輯器裡的東西」比省 17ms 人值得。
  const r = prepare(tracks.trackTexts(), tracks.programs());
  if (r.error) { showErr(r.error); return; }

  btn.disabled = true;                       // 連點只會多燒一次額度
  try {
    const res = await fetch("/api/share", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ mml: r.mml }),
    });
    // 有回應就代表伺服器活著 —— 即使是 4xx。同 websave.call。
    net.reportUp();
    const data = await res.json().catch(() => null);
    if (!res.ok) {
      // 401 先攔 —— 這是「畫面說已登入、伺服器說沒有」那一種，不是普通的失敗
      if (onUnauthorized(res)) { showErr(i18n.t("account.expired")); return; }
      showErr(data?.message ?? i18n.t("shareBox.postFailed", { status: res.status }));
      return;
    }

    report(r, data.reused);
    fillUrl(data.url);
    await copy(data.url, $("#shareCopy"));

    // 新增與重複走**同一條規則**：跳到伺服器算出來的那一頁。reused 的那一筆可能在第
    // 5 頁，只重抓第 1 頁的話使用者會看到清單毫無反應。
    hitId = data.id;
    await load(data.page ?? 1);
  } catch {
    // **第一手證據**：真的有一個 /api/* 請求真的失敗了，比 navigator.onLine 準（那個
    // 對「連上了沒有對外網路的 Wi-Fi」會說謊）。net.js 的檔頭寫著「呼叫端只有
    // websave.call」—— /api/* 這日是第二個，改了要順手更新那句。
    net.reportDown();
    showErr(i18n.t("shareBox.postOffline"));
  } finally {
    syncGo();
  }
}

/** 壓縮結果與截斷警告。這兩行的高度是預留的，所以清空也不會讓版面跳。 */
function report(r, reused) {
  const stat = $("#shareStat"), cut = $("#shareCut");
  if (reused) {
    // 這份內容之前分享過，所以「壓縮了多少」不是這次發生的事，講了會誤導
    stat.textContent = i18n.t("shareBox.reused");
    stat.classList.remove("saved");
  } else if (r.after >= r.before) {
    // 省 0 字是**常態**：在鋼琴捲軸裡編輯過的譜本來就已經是最省的寫法，而硬寫一個
    // 「省 0%」會讓人以為壞了。
    stat.textContent = i18n.t("shareBox.alreadyTight", { before: r.before, after: r.after });
    stat.classList.remove("saved");
  } else {
    const saved = r.before - r.after;
    const pct = Math.round(saved / r.before * 100);
    stat.textContent = i18n.t("shareBox.saved",
      { before: r.before, after: r.after, saved, pct });
    stat.classList.add("saved");
  }
  // 改寫與截斷共用這一行：兩件事都是「送出去的跟你編輯器裡的不一木樣」。
  //
  // 時值被 snap 排在最前面：另外兩件事都不會動到音樂（改寫是零漂移、截斷是整軌不送），
  // 只有它會讓對方聽到跟你不一樣的音符。
  const warns = [
    ...(r.snapped?.length
      ? [i18n.t("shareBox.durSnapped", { list: i18n.list(r.snapped), drift: r.drift })]
      : []),
    ...(r.fixes?.length
      ? [i18n.t("shareBox.doubleDotFixed", { list: i18n.list(r.fixes) })]
      : []),
    ...(r.warnings ?? []),
    ...r.cuts,
  ];
  cut.textContent = warns.length
    ? i18n.t("shareBox.warnPrefix", { list: i18n.clause(warns) }) : "";
}

function fillUrl(url) {
  const input = $("#shareUrl");
  input.value = url;
  $("#shareCopy").disabled = false;
}

/** 複製到剪貼簿，回饋放在**剛剛按的那顆按鈕上**。不發 toast —— 眼睛還在按鈕上。 */
async function copy(url, btn) {
  try {
    await navigator.clipboard.writeText(url);
    if (btn) flash(btn, i18n.t("shareBox.copied"));
    return true;
  } catch {
    // Firefox 之類不給 writeText 的，退回既有的手動複製視窗
    clipboard.showForCopy(url);
    return false;
  }
}

const flashing = new WeakMap();
function flash(btn, text) {
  clearTimeout(flashing.get(btn));
  const original = btn.dataset.label ?? btn.textContent;
  btn.dataset.label = original;
  btn.textContent = text;
  flashing.set(btn, setTimeout(() => { btn.textContent = btn.dataset.label; }, 2000));
}

// ─── 清單 ───────────────────────────────────────────────────────────────────

/** 抓某一頁。頁碼由伺月服器夾範圍（它才知道總共有幾頁）。 */
async function load(want = page) {
  if (!account.isSignedIn()) return;
  const tb = $("#shareRows");

  try {
    const res = await fetch(`/api/share?page=${Math.max(1, want)}`);
    if (!res.ok) {
      // **這一支是最重要的那一個**：開框就會走到它（open → load），所以畫面在使用者
      // 按下產生鈕**之前**就已經是誠實的。
      if (onUnauthorized(res)) return;
      const d = await res.json().catch(() => null);
      tb.innerHTML = "";
      tb.appendChild(emptyRow(d?.message ?? i18n.t("shareBox.listFailed", { status: res.status })));
      return;
    }
    const d = await res.json();
    rows = d.items ?? [];
    page = d.page;
    pages = d.pages;
    render(d.total);
  } catch {
    tb.innerHTML = "";
    tb.appendChild(emptyRow(i18n.t("shareBox.listOffline")));
  }
}

function emptyRow(text) {
  const tr = document.createElement("tr");
  const td = document.createElement("td");
  td.className = "empty";
  td.colSpan = 5;
  td.textContent = text;
  tr.appendChild(td);
  return tr;
}

function render(total) {
  const tb = $("#shareRows");
  tb.innerHTML = "";

  if (!rows.length) {
    tb.appendChild(emptyRow(i18n.t("shareBox.listEmpty")));
  } else {
    // 序號日是**全域連續**的（第 2 頁顯示 11–20）：每頁都從 1 數的話序號等於沒有資訊。
    const base = (page - 1) * PAGE_SIZE;
    rows.forEach((row, i) => tb.appendChild(renderRow(row, base + i + 1)));
  }

  $("#shareTotal").textContent = total ? i18n.t("shareBox.total", { n: total }) : "";
  $("#sharePage").textContent = `${page} / ${pages}`;
  $("#sharePrev").disabled = page <= 1;
  $("#shareNext").disabled = page >= pages;
}

const short = id => id.slice(0, 8);

/**
 * 伺服器一律回 UTC，本地時間的呈現是前端的事。locale 跟著介面語言走，不是寫死
 * zh-TW —— 日期順序在各語言不同。時區不動：那才是他要的「什麼時候分享的」。
 */
const when = iso => new Date(iso).toLocaleString(i18n.getLocale(), {
  year: "numeric", month: "2-digit", day: "2-digit",
  hour: "2-digit", minute: "2-digit", hour12: false,
});

const urlOf = row => `${location.origin}/mml/${row.id}`;

function renderRow(row, seq) {
  const tr = document.createElement("tr");
  // 整列的 title 放完整網址 —— 表木格裡只顯示 guid 前 8 字（十列的前 24 個字元完全一樣）。
  tr.title = urlOf(row);
  if (row.id === hitId) tr.classList.add("hit");

  tr.append(
    cell(String(seq), "n"),
    cell(`${short(row.id)}…`, "link"),
    cell(i18n.t("shareBox.cell.sum", { tracks: row.tracks, chars: row.chars }), "sum"),
    cell(when(row.createdUtc), "when"),
    opsCell(row));
  return tr;
}

function cell(text, cls) {
  const td = document.createElement("td");
  td.className = cls;
  td.textContent = text;
  return td;
}

function opsCell(row) {
  const td = document.createElement("td");
  td.className = "ops";

  td.append(
    op(i18n.t("shareBox.op.load"), i18n.t("shareBox.op.loadTitle"), () => loadIntoEditor(row)),
    op(i18n.t("shareBox.op.copyLink"), i18n.t("shareBox.op.copyLinkTitle"), btn => copy(urlOf(row), btn)),
    videoLink(row),
    op(i18n.t("shareBox.op.delete"), i18n.t("shareBox.op.deleteTitle"), () => askDelete(row), "del"));
  return td;
}

/**
 * 「製作影片」。**是 `<a target="_blank">` 而不是 `<button>`**，兩個理由：
 *
 * 1. **同分頁導向會把使用者踢出編輯階段。** 這個框是開在編輯器裡的 —— 草稿雖然有進
 *    localStorage，但 `history.js` 的復原堆疊在記憶體裡，導走再回來 Ctrl+Z 就全沒了。
 * 2. 真正的 `<a>` 讓中鍵、Ctrl＋點、手機長按「在新分頁開啟」全部自動可用，也是對的
 *    無障礙語意（那是一次導覽，不是一個動作）。
 *
 * 離線不必特別處理：離線時 `load()` 的 fetch 會失敗，清單一列都渲染不出來。
 *
 * ─── 連結一定要帶語言前綴 ───
 *
 * **這是一個被回報過的 bug。** 編輯器在 `/` 是強制繁中（不看 cookie 也不看瀏覽器），而
 * `/waterfall/{guid}` 沒有前綴的話會落到 `cookie → Accept-Language` —— 於是**試過一次日文
 * 介面的人（cookie 存一年），從此每次按這顆都會拿到日文頁**，而編輯器本身看起來一切正常。
 *
 * 帶上前綴之後，這一頁的語言就是使用者剛才在用的那一個。`culturePrefix()` 讀的是
 * `<html lang>`，也就是伺服器已經決定好的那個答案。
 */
function videoLink(row) {
  const a = document.createElement("a");
  a.href = `${culturePrefix()}/waterfall/${row.id}`;
  a.target = "_blank";
  a.rel = "noopener";
  a.textContent = i18n.t("shareBox.op.video");
  a.title = i18n.t("shareBox.op.videoTitle");
  return a;
}

function op(label, title, fn, cls) {
  const b = document.createElement("button");
  b.type = "button";
  b.textContent = label;
  b.title = title;
  if (cls) b.className = cls;
  b.addEventListener("click", () => fn(b));
  return b;
}

// ─── 載入到編輯器 ───────────────────────────────────────────────────────────

/**
 * 把一份分享竹的 MML 裝進編輯器。importText 內部已經包了 wrapEdit(history.edit) 並在最
 * 後叫 onImport（= ui.refresh），所以這裡什麼都不用補。
 */
const adopt = mml => clipboard.importText(mml);

/**
 * 這個瀏覽器分頁已經吃過哪些分享（guid 的陣列）。**用 sessionStorage 而不是
 * localStorage**：它綁的是「分頁 × origin」—— 換成 localStorage 的話，開新分頁貼同一
 * 個連結會變成打不開那份譜。
 */
const ADOPTED_KEY = "mml-workshop/adopted";

/**
 * sessionStorage 隨時可能丟例外（無痕、關掉 cookie、企業政策）。**壞掉時一律往「照樣
 * 載入」倒**：反過來（讀不到記錄就拒絕載入）會讓分享連結整個打不開，而那是這個網址存
 * 在的理由。
 */
function adoptedIds() {
  try {
    const v = JSON.parse(sessionStorage.getItem(ADOPTED_KEY) ?? "[]");
    return Array.isArray(v) ? v.filter(x => typeof x === "string") : [];
  } catch { return []; }
}

function rememberAdopted(id) {
  try {
    // 留最後 20 筆就夠：它跟著分頁一起水消失，不會長期累積。
    const next = [...adoptedIds().filter(x => x !== id), id].slice(-20);
    sessionStorage.setItem(ADOPTED_KEY, JSON.stringify(next));
  } catch { /* 記不住就記不住，見 adoptedIds */ }
}

/**
 * 開站時看伺服器有沒有把分享的樂譜塞進頁面，有就直接載入。
 *
 * **`/mml/{guid}` 就是完整的編輯器**（HomeController.Shared 回的是 View("Index")），所
 * 以使用者很可能點開連結之後**就停在那個網址上繼續編輯**。撞上「每次整頁載入都 adopt
 * 一次」的結果是**任何整頁載入都會把他的編輯整批洗掉** —— 而觸發整頁載入的東西到處都
 * 是（登入、登出、換語言、F5）。所以只 adopt **這個分頁第一次看到這個 guid** 那一次。
 *
 * 第一次**不問、不擋、也不說**（意圖很明確，而草稿 Ctrl+Z 就回得去）；第二次**要說**
 * ——他人在 `/mml/{guid}` 上，畫面上卻不是那份譜，不講的話他無從理解為什麼。
 *
 * 要在 tracks 初始化之後才叫：importText 需要分頁已經建好。
 */
export function boot() {
  if (document.getElementById("sharedMissing")) {
    say(i18n.t("shareBox.linkNotFound"));
    return;
  }
  const el = document.getElementById("sharedMml");
  if (!el) {
    // 網址要一份分享，但頁面上**兩種標記都不在** —— 連線時這個組合不可能出現，所以它
    // 只會是 Service Worker 離線時送出的那份匿名 shell（見 Pwa/sw.js 的 navigate）。
    //
    // **正確性靠的是上面那個 early return**：查不到的連結在那裡已經被說掉了，順序換掉
    // 會把「這個連結被刪了」誤報成「你離線了」。只在路徑真的是 /mml/ 時說卜話。
    if (location.pathname.startsWith("/mml/")) say(i18n.t("shareBox.offlineLink"));
    return;
  }

  let data = null;
  try { data = JSON.parse(el.textContent); } catch { /* 壞了就當作沒有 */ }
  if (!data?.mml) return;

  // id 認不出來就照舊載入。**不能拿 mml 當鍵**：那是幾十 KB 的字串，而且同一份譜重新
  // 分享一次會得到不同的 guid 卻相同的內容。
  const id = typeof data.id === "string" ? data.id : null;
  if (id && adoptedIds().includes(id)) {
    say(i18n.t("shareBox.alreadyAdopted"));
    return;
  }

  if (!adopt(data.mml)) return;
  // 成功了才記 —— 格式認不出來時（adopt 回 false）下次重整還該再試一次。
  if (id) rememberAdopted(id);
}

/**
 * 清單那一列不帶 MML 本文（一頁 10 筆 × 最多 14410 字 ≈ 144KB），所以載入時才單獨拿。
 * **不問、不擋**：importText 包在 history.edit 裡，Ctrl+Z 就回得去。
 */
async function loadIntoEditor(row) {
  clearErr();
  try {
    const res = await fetch(`/api/share/${row.id}`);
    if (!res.ok) {
      if (onUnauthorized(res)) { showErr(i18n.t("account.expired")); return; }
      const d = await res.json().catch(() => null);
      showErr(d?.message ?? i18n.t("shareBox.loadFailed", { status: res.status }));
      return;
    }
    const { mml } = await res.json();
    if (!mml) { showErr(i18n.t("shareBox.emptyShare")); return; }

    close();                    // 載入的意義是「我要看／聽這一份」，框留著只是遮住結果
    // 這裡一十定要講 —— 使用者眼前正在編輯的東西剛剛被蓋掉了（跟 boot() 不同）。
    const had = tracks.trackTexts().some(t => bareTrack(t));
    adopt(mml);
    say(had
      ? i18n.t("shareBox.loadedReplaced", { id: short(row.id) })
      : i18n.t("shareBox.loaded", { id: short(row.id) }));
  } catch {
    showErr(i18n.t("shareBox.loadOffline"));
  }
}

// ─── 刪除 ───────────────────────────────────────────────────────────────────

function askDelete(row) {
  pending = row;
  $("#shareDelWhat").textContent =
    i18n.t("shareBox.delWhat", {
      id: short(row.id), tracks: row.tracks, chars: row.chars, when: when(row.createdUtc),
    });
  delBox().classList.add("on");
  $("#shareDelCancel").focus();      // 預設落在「取消」上，不是「確定刪除」
}

const closeDelete = () => { delBox().classList.remove("on"); pending = null; };

async function doDelete() {
  const row = pending;
  if (!row) return;
  const btn = $("#shareDelOk");
  btn.disabled = true;
  try {
    const res = await fetch(`/api/share/${row.id}`, { method: "DELETE" });
    if (!res.ok) {
      closeDelete();      // 確認框一定要收 —— 那一筆沒被刪掉，留著會讓人以為還在跑
      if (onUnauthorized(res)) { showErr(i18n.t("account.expired")); return; }
      const d = await res.json().catch(() => null);
      showErr(d?.message ?? i18n.t("shareBox.delFailed", { status: res.status }));
      return;
    }
    closeDelete();
    hitId = null;

    // 剛才刪掉竹的是這一頁的最後一筆時這個頁碼可能已經不存在了；伺服器會把頁碼夾進合法
    // 範圍，所以直接要 page - 1 是安全的 —— 停在空白的第 2 頁看起來像資料全沒了。
    await load(rows.length === 1 && page > 1 ? page - 1 : page);
  } catch {
    closeDelete();
    showErr(i18n.t("shareBox.delOffline"));
  } finally {
    btn.disabled = false;
  }
}

// ─── 開關 ───────────────────────────────────────────────────────────────────

function open() {
  // 開框這一刻只知道「渲染時是登入的」。真正的答案由下面的 load() 帶回來。
  syncAuth();

  clearErr();
  // 每次開框都清掉上一次的結果：那些數字是「上次按下產生時」的，而中間譜可能改過了
  $("#shareStat").textContent = "";
  $("#shareCut").textContent = "";
  $("#shareUrl").value = "";
  $("#shareCopy").disabled = true;
  hitId = null;

  syncDrop();
  syncGo();
  box().classList.add("on");
  // 未登入就不抓水清單（那一定是 401）。cookie 過期時 onUnauthorized 會把上面 syncAuth()
  // 剛畫好的「已登入」就地改對。
  if (account.isSignedIn()) load(1);
}

const close = () => box().classList.remove("on");

export function init() {
  const b = box(), d = delBox();
  if (!b || !d) return;

  $("#share").addEventListener("click", open);

  // 連線狀態變了就重畫登入提示。框關著的時候呼叫也無害（改的是看不見的東西）。
  net.subscribe(syncAuth);
  // **兩支都要**：syncAuth 管未登入時那片登入提示，syncGo 管已登入時那顆「產生連結」。
  // 只訂閱前者的話，已登入的人離線時那顆鈕會一直是可以按的。
  net.subscribe(syncGo);
  $("#shareGo").addEventListener("click", generate);
  $("#shareCopy").addEventListener("click", () => {
    const url = $("#shareUrl").value;
    if (url) copy(url, $("#shareCopy"));
  });

  // 手動翻頁就把高亮清掉：那個高亮的意思日是「你剛剛要的就是這一列」。
  $("#sharePrev").addEventListener("click", () => { hitId = null; load(page - 1); });
  $("#shareNext").addEventListener("click", () => { hitId = null; load(page + 1); });

  $("#shareDelCancel").addEventListener("click", closeDelete);
  $("#shareDelOk").addEventListener("click", doDelete);

  b.addEventListener("click", e => { if (e.target === b) close(); });
  d.addEventListener("click", e => { if (e.target === d) closeDelete(); });

  addEventListener("keydown", e => {
    if (e.key !== "Escape") return;
    // 確認框疊在分享框上面，Esc 先給它 —— 不然按一次 Esc 會把兩層一起關掉。
    if (d.classList.contains("on")) closeDelete();
    else if (b.classList.contains("on")) close();
  });

  syncGo();
}
