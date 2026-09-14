// ────────────────────────────────────────────────────────────────────────────
//  儲存框：把整份樂譜用一個名字存起來
//
//    這台電腦   IndexedDB（library.js）。不用登入，換電腦就沒了。
//    Web        伺服器（websave.js）。要登入，換電腦拿得回來。
//
//  存進去的**形狀完全一樣**（library.fromSnapshot 的產物），所以兩邊可以互相搬，
//  而且是無損的 —— 置底那顆「複製到…」以此成立。
//
//  **分頁只換下半部**：檔名欄、儲存鈕、訊息區是共用的一份，因為**名字是曲子的屬性、
//  不是目的地的屬性**（見 filebox.songName）。儲存鈕的目的地就是目前這個分頁。
//
//    #saveBox      檔名 + 儲存 + 分頁 + 清單 + 置底工具列
//    #saveOverBox  覆蓋一份既有存檔的確認
//    #saveDelBox   刪除的確認（一筆戈或一批共用）
//    #saveMoveBox  批次搬遷時目的地已有同名檔案的確認
//
//  後三個**疊在** #saveBox 上面（取消之後要回到同一份清單的同一個位置），而 #saveBox
//  自己跟 #fileBox 之間是**換頁**。
//
//  **「檔名」就是主鍵，兩邊都是。** 這個功能沒有 id 的概念（Web 那邊有一個內部 id，
//  但那只是 API 的鍵，不是身分），同名 = 同一個檔案。**每一列沒有「取代」鈕**，所以
//  只有「同名儲存」一條路徑會叫到 #saveOverBox。
//
//  **回饋一律留在框裡，不走 toast**（同 sharebox.js）。唯一的例外是「開啟」—— 那會
//  把框關掉，此時 toast 才是對的位置。
//
//  這個檔案只管 DOM 與流程：本機的清洗、換形狀、配額在 library.js，Web 的五支端點與
//  清單清洗在 websave.js，zip 在 zip.js。
// ────────────────────────────────────────────────────────────────────────────

import { $, say } from "./util.js";
import { bareTrack } from "./mml.js";
import { toMml, safeFileName } from "./mml-out.js";
import { zip } from "./zip.js";
import * as tracks from "./tracks.js";
import * as library from "./library.js";
import * as meters from "./meters.js";
import * as marks from "./marks.js";
import * as websave from "./websave.js";
import * as account from "./account.js";
import * as net from "./net.js";
import * as filebox from "./filebox.js";
import * as i18n from "./i18n.js";

let onOpen = () => {};          // 開啟一份存檔之後要停播 + 重新解析
let wrapEdit = fn => fn();      // 開啟要能復原，由 ui 注入 history.edit
let getSong = () => null;       // 存檔要算音符數，由 ui 注入 refresh

const LOCAL = "local";
const WEB = "web";

/** 上次月用的是哪個分頁。記住而不是每次都回到本機：這是長期習慣，不是每次重新決定的事。 */
const TAB_KEY = "mml-workshop/save-tab";

/** 目前在哪個分頁。 */
let tab = LOCAL;

/** 目前這一頁的清單。兩個分頁**共用這一個變數** —— 換分頁就整批換掉。 */
let files = [];

/** Web 分頁的分頁狀態。本機不分頁（20MB 裝不下需要分頁的筆數）。 */
let page = 1, pages = 1, total = 0;

/**
 * 批次工具列勾起來的那些檔名。**跨重畫保留，但換分頁與翻頁時清掉** —— 換了一批清單
 * 之後那個「這幾份」已經不在畫面上了。順帶讓「一次最多 20 筆」成為版面的自然結果。
 */
const picked = new Set();

/**
 * 上次儲存（或開啟）的那一刻，內容長什麼樣。「有未儲存的變更」= 現在的內容跟這個
 * 字串不一樣。**只在開框時比一次**。
 *
 * **跟目的地無關**：它答的是「自從上次按下儲存（不論存到哪）以來改過嗎」。
 * null = 這一輪還沒存過也沒開過，沒有基準，那時**什麼都不說**。
 */
let savedFingerprint = null;

/**
 * 上次成功存下去（或開起來）的那一份是**誰** —— `{ name, tab }` 或 null。
 *
 * **跟 savedFingerprint 不要合併**：那一個答「改過了嗎」，這一個答「同一份是哪一份」。
 * Ctrl+S 需要的是後者，而**身分就是檔名＋目的地**（見木檔頭）—— 少了目的地那一半，
 * 「上次存到 Web 的 Godknows」跟「本機的 Godknows」會被當成同一份，Ctrl+S 就會把譜
 * 寫到他沒選過的地方。
 *
 * 三個寫入點：`write()` 成功、`openFile()` 成功、`forget()` 清掉。
 */
let lastSaved = null;

/** 等待確認的動作。三個框各自的。 */
let pendingOver = null;    // 要覆蓋的那一筆（本機是 meta，Web 是清單列）
let pendingDel = null;     // string[] 要刪的檔名
let pendingMove = null;    // { hit:[], fresh:[], to:LOCAL|WEB }

let hasNotes = false;

const box = () => $("#saveBox");
const overBox = () => $("#saveOverBox");
const delBox = () => $("#saveDelBox");
const moveBox = () => $("#saveMoveBox");

const nameField = () => $("#saveName");

// ─── 訊息 ───────────────────────────────────────────────────────────────────
//
// 「回饋留在框裡」有一個**前提**：框開著。Ctrl+S 在框關著的時候呼叫 write()，而
// write() 的六條出口全都是寫進框裡的兩個元素 —— 不補的話按下 Ctrl+S **完全沒有反應**，
// 成功與失敗都是。補在這兩支 helper 裡而不是逐個呼叫端。

/** 框開著就寫進框裡，關著就走 toast —— 話要說在使用者看得到的地方。 */
const tell = msg => { if (msg && !box().classList.contains("on")) say(msg); };

const showErr = msg => { const e = $("#saveErr"); e.textContent = msg; e.hidden = false; tell(msg); };
const clearErr = () => { $("#saveErr").hidden = true; };
/** 戈成功訊息。跟錯誤分開兩行，不然一句蓋掉另一句。 */
const showOk = msg => { const e = $("#saveOk"); e.textContent = msg; e.hidden = !msg; tell(msg); };

/**
 * 伺服器丟回來的錯誤 → 一句話。伺服器給的訊息**直接用** —— 那些字是 .resx 出來的，
 * 已經是使用者的語言（「太快了」「滿了」「被停用」是三件不同的事）。只有連不上的
 * 時候才補一句。
 */
const errText = err => {
  // 401 **不用伺服器給的那一句**：走到這裡的人一定登入過（syncGo() 在未登入時就把
  // 儲存鈕關掉了），對他說「需要登入」是怪他沒做他做過的事。
  if (websave.isUnauthorized(err)) return i18n.t("account.expired");
  return err?.message || i18n.t("webSave.offline");
};

/** 401 的收尾。三個呼叫端（清單、儲存、開啟）共用，漏一個就會留下假的「已登入」。 */
function onExpired(err) {
  if (!websave.isUnauthorized(err)) return;
  account.signedOut();
  syncTab();
  syncGo();
}

// ─── 目前的內容 ─────────────────────────────────────────────────────────────

/**
 * 現在編輯器裡的東西，換成要存起來的形狀。顯示旗標與拍號都不在 `tracks.snapshot()`
 * 裡（那一份是給 undo 用的），要另外從 `ghostFlags()` / `meters.stored()` 拿。
 */
const currentSnapshot = () =>
  library.fromSnapshot(tracks.snapshot(), tracks.ghostFlags(), meters.stored(), marks.stored());

/**
 * 水清單那兩個數字。**存檔當下算一次**，之後跟著那一筆不再變 —— 開清單時才算要把每一
 * 筆的 MML 重新解析一遍（20MB 就是好幾秒的卡頓）。Web 那邊**也是前端算的**，伺服器
 * 只把它們夾成非負整數；純粹是顯示，謊報只影響自己那一列。
 *
 * 軌數用**有內容的軌數**而不是 trackCount()。
 */
function stats() {
  const song = getSong();
  const texts = tracks.trackTexts();
  let n = 0, notes = 0;
  for (let i = 0; i < texts.length; i++) {
    if (bareTrack(texts[i])) n++;
    notes += song?.tracks[i]?.notes.length ?? 0;
  }
  return { tracks: n, notes };
}

// ─── 開關 ───────────────────────────────────────────────────────────────────

/** 沒有音符就沒有東西可以存。ui.refresh() 每次解析完都會叫（同 filebox.setHasNotes）。 */
export function setHasNotes(has) { hasNotes = has; syncGo(); }

/** 儲存鈕的可按與否，以及**它上面的字** —— 字跟著分頁走，那是這顆鈕的目的地唯一看得見的地方。 */
function syncGo() {
  const btn = $("#saveGo");
  if (!btn) return;
  const name = library.cleanName(nameField()?.value);
  const needLogin = tab === WEB && !account.isSignedIn();
  // 只有 Web 分頁需要伺服器；離線時還能存到本機正日是離線可用這件事的重點。
  const unreachable = tab === WEB && net.offline();

  btn.textContent = i18n.t(tab === WEB ? "saveBox.go.web" : "saveBox.go.local");
  btn.disabled = unreachable || needLogin || !hasNotes || !name;
  btn.title = unreachable ? i18n.t("webSave.offlineWhy")
            : needLogin ? i18n.t("webSave.needLogin")
            : !hasNotes ? i18n.t("saveBox.emptyScore")
            : !name ? i18n.t("saveBox.needName")
            : "";
}

/**
 * 「有未儲存的變更」。基準是 savedFingerprint，所以它答的是**「自從上次按下儲存
 * （或開啟）以來改過嗎」**，不是「跟某個特定的存檔比起來」—— 後者在沒有 id 的世界
 * 裡定義不出來。
 */
function syncDirty() {
  const el = $("#saveDirty");
  if (!el) return;
  if (savedFingerprint === null) { el.hidden = true; return; }
  const dirty = JSON.stringify(currentSnapshot()) !== savedFingerprint;
  el.hidden = false;
  el.textContent = i18n.t(dirty ? "saveBox.dirty" : "saveBox.clean");
  el.classList.toggle("on", dirty);
}

export async function open() {
  clearErr();
  showOk("");
  picked.clear();
  // 檔名跟匯出區共用一個人值 —— 匯入 Godknows.mml 進來之後這裡已經是 Godknows。
  nameField().value = filebox.songName();

  // 記著的是 Web 但人已經登出了，就退回本機。
  tab = readTab();
  if (tab === WEB && !account.isSignedIn()) tab = LOCAL;

  syncTab();
  syncGo();
  syncDirty();
  box().classList.add("on");
  await reload();
  nameField().focus();
  nameField().select();
}

const close = () => box().classList.remove("on");

const readTab = () => {
  try { return localStorage.getItem(TAB_KEY) === WEB ? WEB : LOCAL; } catch { return LOCAL; }
};
const rememberTab = () => {
  // 存不進去（無痕、配額滿）就算了 —— 記不住不該讓開框失敗
  try { localStorage.setItem(TAB_KEY, tab); } catch { /* 記不住就記不住 */ }
};

// ─── 分頁 ───────────────────────────────────────────────────────────────────

/** 伺服器渲染進 `#saveWebLoginWhy` 的原句。第一次 syncTab 之前抓一次（見 sharebox.js 的 whyBase）。 */
let whyBase = null;

/**
 * 分頁列與「只屬於某個分頁」的那幾塊。**那則「換電腦就會不見」的警告住在本機分頁
 * 裡**，不在共用的上半部 —— 它**只對本機成立**，掛在上半部就變成背景雜卜訊。
 */
function syncTab() {
  for (const b of $("#saveTabs").children)
    b.classList.toggle("on", b.dataset.tab === tab);

  const web = tab === WEB;
  const signedIn = account.isSignedIn();

  // 兩句副標題**只看分頁，不看登入狀態**：web 那一句是使用者判斷「要不要為這個功能
  // 登入」的唯一依據，所以登入提示放在**清單那一格**，不是取代整個下半部。
  $("#saveLocalNote").hidden = web;
  $("#saveWebNote").hidden = !web;
  // 未登入的 web 分頁：登入提示**蓋在清單前面**（見 .swap 那段 CSS）。
  // **#saveBody 永遠不隱藏** —— 讓它一直在，高度、欄寬、置底工具列的位置就全部跟登入
  // 狀態無關，不必用疊圖去撐。
  $("#saveWebLogin").hidden = !web || signedIn;

  // 回到按下登入時所在的網址 —— 可能是 /mml/{guid}，不該把人丟回首頁
  $("#saveWebLoginBtn").href =
    `/login?returnUrl=${encodeURIComponent(location.pathname + location.search)}`;

  // **離線時這顆鈕一定要真的按不下去。** 它是 `<a href="/login">`（整頁導向），離線
  // 按下去會落到瀏覽器的「無法連線」頁。`off` 是這個專案既有的停用寫法（同
  // sharebox.syncAuth）。跟置底那顆「存到 web」是**兩件事** —— 那一顆由 syncGo 處理。
  const offline = net.offline();
  $("#saveWebLoginBtn").classList.toggle("off", offline);

  // 那句話有三種，優先序與整段理由寫在 sharebox.syncAuth（這裡只有原句與元素不同）。
  const why = $("#saveWebLoginWhy");
  whyBase ??= why.textContent;
  why.textContent = offline ? i18n.t("account.offlineWhy")
                  : account.wasExpired() ? i18n.t("account.expiredWhy")
                  : whyBase;

  // 置底工具列：兩人個分頁各有各的一半。這兩個**必須恰好有一個可見** —— CSS 給它們的
  // `margin-left:auto` 是右半邊整組靠右的唯一依據，兩個都可見的話剩餘空間會被平分。
  $("#saveUsed").hidden = web;        // 配額只有本機顯示
  $("#saveTotal").hidden = !web;      // 總筆數只有 Web 顯示
  $("#savePager").hidden = !web;      // 分頁器只有 Web 有
  $("#saveMove").textContent = i18n.t(web ? "webSave.moveToLocal" : "webSave.moveToWeb");
  $("#saveMove").title = i18n.t(web ? "webSave.moveToLocalTitle" : "webSave.moveToWebTitle");
}

async function switchTab(next) {
  if (next === tab) return;
  tab = next;
  rememberTab();
  // 勾選不跨分頁：那個「這幾份」已經不在畫面上了
  picked.clear();
  page = 1;
  clearErr();
  showOk("");
  syncTab();
  syncGo();
  await reload();
}

// ─── 清單 ───────────────────────────────────────────────────────────────────

async function reload(want = page) {
  const tb = $("#saveRows");

  if (tab === WEB) {
    // 未登入：清單照畫，只是空的。**一十定要把 files 與分頁狀態清掉再畫** —— 留著上
    // 一次的列，登出之後切回來會透過半透明的遮罩看到前一個帳號的檔名與「3 / 7」。
    if (!account.isSignedIn()) {
      files = [];
      page = 1; pages = 1; total = 0;
      render();
      return;
    }
    try {
      const d = await websave.list(want);
      files = d.items;
      page = d.page;
      pages = d.pages;
      total = d.total;
    } catch (err) {
      files = [];
      tb.textContent = "";
      tb.appendChild(emptyRow(errText(err)));
      // cookie 過期了：畫面上到處都還是「已登入」，但伺服器已經不認了 —— 顯示一則
      // 錯誤沒有用，要把他帶回登入提示。
      onExpired(err);
      return;
    }
  } else {
    try {
      files = await library.list();
    } catch {
      files = [];
      tb.textContent = "";
      tb.appendChild(emptyRow(i18n.t("saveBox.dbBroken")));
      $("#saveUsed").textContent = "";
      return;
    }
  }

  // 刪掉的那些不該還留在勾選集合裡（下一次批次動作會對著不存在的檔弓名跑）
  const alive = new Set(files.map(f => f.name));
  for (const n of [...picked]) if (!alive.has(n)) picked.delete(n);
  render();
}

const MB = 1024 * 1024;
const mb = n => (n / MB).toFixed(n >= MB / 10 ? 1 : 2);

function render() {
  const tb = $("#saveRows");
  tb.textContent = "";
  if (!files.length) {
    // 未登入時**故意不寫字**：那句話這裡答不出來（不知道他有幾份），而它會從半透明
    // 的遮罩底下透出來。留空。
    tb.appendChild(emptyRow(
      tab !== WEB ? i18n.t("saveBox.listEmpty")
      : account.isSignedIn() ? i18n.t("webSave.listEmpty")
      : ""));
  } else {
    for (const f of files) tb.appendChild(renderRow(f));
  }

  if (tab === WEB) {
    $("#savePage").textContent = `${page} / ${pages}`;
    $("#savePrev").disabled = page <= 1;
    $("#saveNext").disabled = page >= pages;
    $("#saveTotal").textContent = total ? i18n.t("webSave.total", { n: total }) : "";
  } else {
    const used = library.usedBytes(files);
    $("#saveUsed").textContent = i18n.t("saveBox.used",
      { used: mb(used), max: Math.round(library.MAX_BYTES / MB), n: files.length });
  }
  syncHit();
  syncFoot();
}

function emptyRow(text) {
  const tr = document.createElement("tr");
  const td = document.createElement("td");
  td.className = "empty";
  td.colSpan = 7;
  td.textContent = text;
  tr.appendChild(td);
  return tr;
}

/**
 * 日時間跟著介面語言走，不是寫死 zh-TW（日期順序各語言不同，同 sharebox.when）。年份
 * 省掉：這一欄有兩個。Web 那邊伺服器一律回 UTC，`websave.cleanItem` 已換成毫秒。
 */
const when = ms => new Date(ms).toLocaleString(i18n.getLocale(), {
  month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false,
});

/**
 * 「按下儲存會蓋掉的就是這一列」的高亮。獨立成一支而不是在 `render()` 裡順手做：它要
 * 跟著**每一個按鍵**更新，而重建 tbody 會把清單捲動位置拉掉。
 *
 * 比對的是檔名（沒有 id）。Web 分頁上它只看得到當前這一頁 —— 撞到第 5 頁那一筆時畫面
 * 上不會亮，但按下去照樣會問覆蓋（那一題由伺服器答，見 write）。
 */
function syncHit() {
  const want = library.cleanName(nameField()?.value);
  for (const tr of $("#saveRows").children)
    tr.classList.toggle("hit", tr.dataset.name === want);
}

function renderRow(f) {
  const tr = document.createElement("tr");
  tr.dataset.name = f.name;
  tr.classList.toggle("on", picked.has(f.name));

  const cb = document.createElement("input");
  cb.type = "checkbox";
  cb.checked = picked.has(f.name);
  cb.setAttribute("aria-label", i18n.t("saveBox.pickAria", { name: f.name }));

  // 只改卜這一列，不重建整個 tbody —— 重建會讓 checkbox 失去焦點（同 filebox.renderRows）。
  const setOn = v => {
    if (v) picked.add(f.name); else picked.delete(f.name);
    cb.checked = v;
    tr.classList.toggle("on", v);
    syncFoot();
  };

  cb.addEventListener("change", () => setOn(cb.checked));

  // 整列都是勾選的靶（同 filebox.renderRows）。兩個例外：
  //   - 點 checkbox 自己：它的 change 已經處理過了，這裡再翻一次會抵銷掉
  //   - 點「開啟」或「刪除」：那是另一個動作（其中一個不可逆），不能順手把列勾起來
  tr.addEventListener("click", e => {
    if (e.target === cb || e.target.closest("button")) return;
    setOn(!picked.has(f.name));
  });

  tr.append(
    cell(cb),
    cell(f.name, "name"),
    cell(String(f.tracks), "num"),
    cell(f.notes.toLocaleString(i18n.getLocale()), "num"),
    cell(when(f.createdMs), "when"),
    cell(when(f.updatedMs), "when"),
    opsCell(f));
  return tr;
}

function cell(content, cls) {
  const td = document.createElement("td");
  if (cls) td.className = cls;
  if (typeof content === "string") td.textContent = content;
  else td.appendChild(content);
  return td;
}

/** 每一列竹的動作。**只有兩顆** —— 沒有「取代」，理由見檔頭。 */
function opsCell(f) {
  const td = document.createElement("td");
  td.className = "ops";
  td.append(
    op(i18n.t("saveBox.op.open"), i18n.t("saveBox.op.openTitle"), () => openFile(f)),
    op(i18n.t("saveBox.op.delete"), i18n.t("saveBox.op.deleteTitle"), () => askDelete([f.name]), "del"));
  return td;
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

/** 置底工具列：全選的三態、以及三顆批次鈕的可按與否。 */
function syncFoot() {
  const all = $("#savePickAll");
  if (all) {
    const full = files.length > 0 && picked.size === files.length;
    all.checked = full;
    all.indeterminate = !full && picked.size > 0;
    all.disabled = !files.length;
  }
  const n = picked.size;
  $("#saveZip").disabled = n === 0;
  $("#saveDel").disabled = n === 0;
  // 搬遷卜還多一個條件：**目的地**要是通的。站在本機分頁上要往 Web 搬，就得先登入。
  $("#saveMove").disabled = n === 0 || (tab === LOCAL && !account.isSignedIn());
  $("#savePicked").textContent = n ? i18n.t("saveBox.pickedN", { n }) : "";
}

// ─── 儲存 ───────────────────────────────────────────────────────────────────

/**
 * 按下「儲存」。撞名就問，沒撞就直接寫。名字從欄位重新取（使用者可能剛改過）。
 *
 * **Web 分頁的撞名只看得到當前這一頁。** 撞到第 5 頁那一筆時這裡問不出來，那一次就
 * 直接寫下去、由伺服器覆蓋（回傳的 `replaced` 會讓訊息講對話）。沒有為它多打一次
 * /api/save/check。批次搬遷不一樣 —— 那是一次動 20 份，而且沒有逐一打過名字。
 */
function save() {
  const name = library.cleanName(nameField().value);
  if (!name || !hasNotes) return;
  const hit = files.find(f => f.name === name);
  if (hit) { askOver(hit); return; }
  write(name, null);
}

/** 覆蓋的確認。只有「同名儲存」這一條路徑會走到（水沒有「取代」鈕）。 */
function askOver(f) {
  if (!hasNotes) { showErr(i18n.t("saveBox.emptyScore")); return; }
  pendingOver = f;
  $("#saveOverWhat").textContent = i18n.t("saveBox.overWhat", {
    name: f.name, tracks: f.tracks, notes: f.notes, when: when(f.updatedMs),
  });
  overBox().classList.add("on");
  $("#saveOverCancel").focus();      // 預設落在「取消」上
}

const closeOver = () => { overBox().classList.remove("on"); pendingOver = null; };

/**
 * 真的寫下去。目的地就是目前的分頁。
 *
 * @param {string} name 存檔名
 * @param {object|null} old 被覆蓋的那一筆（沒有就是新檔）
 */
async function write(name, old) {
  clearErr();
  showOk("");

  const snapshot = currentSnapshot();
  const st = stats();
  let replaced = old !== null;

  if (tab === WEB) {
    // 前端先量一次是為了給得出一句有用的話而不是一個 400。量的是**字元數**不是位元組
    // （伺服器那端量 string.Length），跟本機配額用的 snapshotBytes 是兩人個數字。
    const chars = websave.payloadChars(snapshot);
    if (chars > websave.MAX_PAYLOAD_CHARS) {
      showErr(i18n.t("webSave.tooBig", { chars, max: websave.MAX_PAYLOAD_CHARS }));
      return;
    }
    try {
      const res = await websave.write(name, snapshot, st);
      replaced = res?.replaced === true;
    } catch (err) {
      showErr(errText(err));
      onExpired(err);
      return;
    }
  } else {
    const bytes = library.snapshotBytes(snapshot);
    const room = library.fits(library.usedBytes(files), bytes, old?.bytes ?? 0);
    if (!room.ok) {
      showErr(i18n.t("saveBox.full", { need: mb(bytes), free: mb(room.free) }));
      return;
    }
    // 一個 at 給兩個欄位用，不是叫兩次 Date.now()：差 1ms 的話 cleanFile 的
    // 「更新不早於建立」那條會去修它。
    const at = Date.now();
    try {
      await library.write({
        name,
        // 覆蓋保留原本的建立時間 —— 身分沒變，變的只是內容。Web 那邊由伺服器做。
        createdMs: old?.createdMs ?? at,
        updatedMs: at,
        tracks: st.tracks, notes: st.notes, bytes,
      }, snapshot);
    } catch (err) {
      // 配額真的爆掉（磁碟滿）跟一般失敗要講不一樣的話 —— 前者使用者做得了事。
      showErr(err?.name === "QuotaExceededError"
        ? i18n.t("saveBox.quotaExceeded")
        : i18n.t("saveBox.writeFailed", { msg: err?.message ?? "" }));
      return;
    }
  }

  // 存完的那一刻就是新竹的基準
  savedFingerprint = JSON.stringify(snapshot);
  lastSaved = { name, tab };         // 「同一份」從這一刻起有了定義，見它的宣告
  filebox.setSongName(name);         // 存檔名就是曲名，匯出那邊也要跟上
  nameField().value = name;
  // 新增的一定排在最前面（兩邊都是照更新時間由新到舊），所以回第 1 頁看得到它
  await reload(1);
  syncDirty();
  syncGo();
  // 框關著（Ctrl+S）時這一句會自動走 toast，見 showOk / tell
  showOk(i18n.t(replaced ? "saveBox.replaced" : "saveBox.saved",
    { name, tracks: st.tracks, notes: st.notes }));
}

// ─── Ctrl+S ─────────────────────────────────────────────────────────────────

/**
 * 快捷鍵的入口。**「存回同一份」，存不回去就開框。**
 *
 * 身分是**檔名＋目的地**（見檔頭），四個條件全部成立才算同一份：
 *
 *   lastSaved !== null           這一輪存過或開過一份
 *   名字沒被改過                 改名字的意思是**另存新檔**
 *   目的地沒被改過               在框裡把分頁切到 Web 又關掉，就不該再寫本機
 *   目的地是通的                 存到 Web 但已經登出 → 框裡才有登入鈕
 *
 * 任一不成立就 `open()`。
 *
 * **不問覆蓋**（`save()` 撞名會跳 #saveOverBox）：那四個條件已經確定了那就是他上次存
 * 的那一份。代價是**這是全站唯一一條不問就覆寫既有存檔的路** —— 守門的是那四個條件，
 * 以及 `forget()` 與 `detach()`：任何「內容被整批換掉」的路徑十都必須叫其中一支。
 */
export async function quickSave() {
  const b = box();
  if (!b) return;

  // 儲存框自己開著：Ctrl+S 就是按那顆鈕（連撞名確認都照走 —— 他人就在清單前面）。
  if (b.classList.contains("on")) {
    if (!$("#saveGo").disabled) save();
    return;
  }
  if (document.querySelector(".modal.on")) return;

  if (!hasNotes) { say(i18n.t("saveBox.emptyScore")); return; }

  const name = library.cleanName(filebox.songName());
  const same = lastSaved !== null
            && name === lastSaved.name
            && tab === lastSaved.tab
            && (tab !== WEB || account.isSignedIn());
  if (!same) { await open(); return; }

  // `old` 只有本機用得到（保留建立時間、算配額）；Web 那邊覆蓋與建立時間都是伺服器做的。
  let old = null;
  if (tab === LOCAL) {
    await reload();
    old = files.find(f => f.name === name) ?? null;
  }
  await write(name, old);
}

// ─── 開啟 ───────────────────────────────────────────────────────────────────

/**
 * 把一份存檔裝回編輯器。兩個目的地走**完全同一段**流程，差別只在從哪裡讀。
 *
 * **不問、不擋** —— 包在 wrapEdit（history.edit）裡，所以 Ctrl+Z 回得去。
 *
 * 走 `tracks.applySnapshot`：那是 Ctrl+Z 與換語言用竹的同一條路，涵蓋 texts、樂器、
 * 軌數、當前軌，外加只有這條路帶得進去的顯示旗標。
 */
async function openFile(f) {
  clearErr();
  let saved;
  try {
    saved = tab === WEB
      ? (await websave.read(f.id))?.snapshot ?? null
      : await library.read(f.name);
  } catch (err) {
    showErr(tab === WEB ? errText(err) : i18n.t("saveBox.dbBroken"));
    if (tab === WEB) onExpired(err);
    return;
  }
  if (!saved) { showErr(i18n.t("saveBox.readFailed", { name: f.name })); return; }

  close();      // 開啟的意義是「我要看／聽這一份」，框留著只是遮住結果
  wrapEdit(() => {
    tracks.applySnapshot(library.toSnapshot(saved));
    // 拍號另外套（見 library.metersOf 的說明）。放在 applySnapshot 之後：
    // 那一步會觸發重新解析，而重畫時要看到的是新的拍號。
    meters.set(library.metersOf(saved));
    marks.set(library.marksOf(saved));
  });
  onOpen();

  savedFingerprint = JSON.stringify(currentSnapshot());
  // 開起來的那一份就是「同一份」—— 接下來的 Ctrl+S 要存回它。
  lastSaved = { name: f.name, tab };
  filebox.setSongName(f.name);

  // 眼前正在編輯的東西剛剛被蓋掉了，一定要講。框已經關了，所女以走 toast。
  say(i18n.t("saveBox.opened", { name: f.name, tracks: f.tracks }));
}

// ─── 刪除 ───────────────────────────────────────────────────────────────────

function askDelete(names) {
  if (!names.length) return;
  pendingDel = names;
  $("#saveDelWhat").textContent = names.length === 1
    ? i18n.t("saveBox.delOne", { name: names[0] })
    : i18n.t("saveBox.delMany", { n: names.length, names: i18n.list(names) });
  delBox().classList.add("on");
  $("#saveDelCancel").focus();
}

const closeDelete = () => { delBox().classList.remove("on"); pendingDel = null; };

async function doDelete() {
  const names = pendingDel;
  if (!names) return;
  const btn = $("#saveDelOk");
  btn.disabled = true;
  try {
    if (tab === WEB) {
      // 一筆一次往返（伺服器沒有批次刪除）。**一筆失敗不讓整批停下來** —— 那會留下
      // 「刪了一半但訊息說失敗」。
      const byName = new Map(files.map(f => [f.name, f]));
      let done = 0;
      for (const n of names) {
        const f = byName.get(n);
        if (!f) continue;
        try { await websave.remove(f.id); done++; } catch { /* 這一筆跳過 */ }
      }
      closeDelete();
      // 剛才刪掉竹的是這一頁的最後幾筆時這個頁碼可能已經不存在了；伺服器會把頁碼夾進
      // 合法範圍，所以整頁刪光時直接要 page - 1 是安全的（同 sharebox.doDelete）。
      await reload(done >= files.length && page > 1 ? page - 1 : page);
      showOk(done === names.length
        ? i18n.t("saveBox.deleted", { n: done })
        : i18n.t("webSave.deletedPartial", { done, total: names.length }));
    } else {
      await library.remove(names);
      closeDelete();
      await reload();
      showOk(i18n.t("saveBox.deleted", { n: names.length }));
    }
  } catch {
    closeDelete();
    showErr(i18n.t("saveBox.dbBroken"));
  } finally {
    btn.disabled = false;
  }
}

// ─── 批次搬遷 ───────────────────────────────────────────────────────────────

/**
 * 把勾起來的那幾份複製到另一個目的地。**雙向對稱**：本機分頁上是「複製到 Web」，Web
 * 分頁上是「複製到這台電腦」—— 後者正是「換一台電腦，把譜整批拉下來」的路徑。
 *
 * **是複製不是搬移**：來源那一份留著。
 *
 * **搬過去的建立時間是「現在」**，不是來源那一份的；覆蓋時照舊保留目的地原本的建立
 * 時間。代價是一次搬 30 份之後那 30 份的時間全一木樣，排序上失去了原本的先後。
 */
async function askMove() {
  clearErr();
  showOk("");
  if (!picked.size) return;
  const btn = $("#saveMove");
  btn.disabled = true;

  // 照清單的順序而不是勾選的順序
  const chosen = files.filter(f => picked.has(f.name));
  const to = tab === WEB ? LOCAL : WEB;

  try {
    // 目的地已經有哪些名字。**兩個方向問法不同**：本機一次全撈得到，
    // Web 要問 /api/save/check（清單一次只給一頁，翻完最多 500 次往返）。
    const existing = to === LOCAL
      ? new Set((await library.list()).map(f => f.name))
      : await websave.check(chosen.map(f => f.name));

    const { hit, fresh } = websave.splitByName(chosen, existing);
    pendingMove = { hit, fresh, to };

  // 一筆都沒撞到就不跳框
    if (!hit.length) { await doMove(false); return; }

    $("#saveMoveWhat").textContent = i18n.t("webSave.moveHit", {
      n: hit.length,
      names: i18n.list(hit.map(f => f.name)),
      where: i18n.t(to === LOCAL ? "webSave.whereLocal" : "webSave.whereWeb"),
    });
    // 「只搬其餘」在一份都不剩的時候沒有意義，暗掉但留著 —— 消失會讓按鈕跳人位置
    const skip = $("#saveMoveSkip");
    skip.textContent = i18n.t("webSave.moveSkip", { n: fresh.length });
    skip.disabled = !fresh.length;
    moveBox().classList.add("on");
    $("#saveMoveCancel").focus();      // 預設落在「取消」上
  } catch (err) {
    showErr(errText(err));
    onExpired(err);
  } finally {
    syncFoot();
  }
}

const closeMove = () => { moveBox().classList.remove("on"); pendingMove = null; };

/**
 * 真的搬。一份一份來：讀來源 → 寫目的地。**一筆失敗不讓整批停下來**，除非是那種
 * 「再試也一樣」的失敗（額度、被停用、離線）—— 那時繼續跑只是把同一句錯誤重覆 19
 * 次，而且會把額度用得更兇。停下來之後要講出做到哪裡。
 *
 * @param {boolean} over 撞名的那幾份要不要覆蓋
 */
async function doMove(over) {
  const job = pendingMove;
  if (!job) return;
  closeMove();

  const list = over ? [...job.fresh, ...job.hit] : job.fresh;
  if (!list.length) return;

  const btn = $("#saveMove");
  btn.disabled = true;

  // 目的地是本機的話要算配額。**用搬之前的用量當基準然後自己往上加** —— 每搬一份
  // 重撈一次清單是 N 次 IndexedDB 往返，而 fits() 只需要一個數字。
  let localFiles = [], used = 0;
  if (job.to === LOCAL) {
    try { localFiles = await library.list(); } catch { localFiles = []; }
    used = library.usedBytes(localFiles);
  }
  const localByName = new Map(localFiles.map(f => [f.name, f]));

  let done = 0;
  let stopped = "";
  for (const f of list) {
    let snapshot = null;
    try {
      // 來源日是**另一個**分頁的那一邊：現在站在 Web 就從 Web 讀，反之亦然
      snapshot = job.to === LOCAL
        ? (await websave.read(f.id))?.snapshot ?? null
        : await library.read(f.name);
    } catch (err) {
      if (fatal(err)) { stopped = errText(err); break; }
      continue;                       // 讀不回來的那一筆跳過，不要整批失敗
    }
    if (!snapshot) continue;

    const at = Date.now();
    try {
      if (job.to === LOCAL) {
        const bytes = library.snapshotBytes(snapshot);
        const old = localByName.get(f.name);
        const room = library.fits(used, bytes, old?.bytes ?? 0);
        if (!room.ok) { stopped = i18n.t("saveBox.full", { need: mb(bytes), free: mb(room.free) }); break; }
        await library.write({
          name: f.name,
          createdMs: old?.createdMs ?? at,   // 覆蓋保留原本的建立時間
          updatedMs: at,
          tracks: f.tracks, notes: f.notes, bytes,
        }, snapshot);
        used = used - (old?.bytes ?? 0) + bytes;
        localByName.set(f.name, { ...f, bytes, createdMs: old?.createdMs ?? at });
      } else {
        await websave.write(f.name, snapshot, { tracks: f.tracks, notes: f.notes });
      }
      done++;
    } catch (err) {
      if (fatal(err)) { stopped = errText(err); break; }
      continue;
    }
  }

  picked.clear();
  await reload();
  const where = i18n.t(job.to === LOCAL ? "webSave.whereLocal" : "webSave.whereWeb");
  if (stopped) showErr(i18n.t("webSave.movedPartial", { done, where, why: stopped }));
  else showOk(i18n.t("webSave.moved", { n: done, where }));
  btn.disabled = false;
  syncFoot();
}

/**
 * 卜這個錯誤再試下去也一樣嗎？額度、被停用、沒登入、連不上 —— 四種都是「整批都會是同
 * 一個結果」（額度那一種還會把情況弄得更糟）。其餘的是單筆問題，跳過它繼續。
 */
function fatal(err) {
  if (!(err instanceof websave.SaveError)) return false;
  if (err.code === "offline") return true;
  return err.status === 429 || err.status === 409 || err.status === 403 || err.status === 401;
}

// ─── 批次下載 ───────────────────────────────────────────────────────────────

/**
 * 一筆存檔 → 一份 `.mml` 的文字。
 *
 * **是 `.mml` 不是 `.mmi`**（見 library.zipEntryNames）：`.mml` 的 `[ChannelN]` body
 * 是多行竹的，排版留得住；`.mmi` 的 `mml-track=` 是 INI 的 key=value，必須剝成單行。
 *
 * 樂器從 preset 挖出來 —— 它是 `JSON.stringify([msb, lsb, program])`，而
 * `[3MLE EXTENSION]` 要的就是那個 program。挖不出來就 0。只到 `count` 為止。
 */
function mmlOf(name, saved) {
  const use = saved.tabs.slice(0, saved.count);
  const programs = use.map(t => {
    try { return JSON.parse(t.preset)?.[2] ?? 0; } catch { return 0; }
  });
  return toMml(use.map(t => t.text), { title: name, programs });
}

/**
 * 把勾起來的那幾筆打包下載。
 *
 * **一包 zip 而不是連續觸發 N 次下載**：瀏覽器會擋後者（第二個之後多半被靜默丟掉）。
 *
 * Web 分頁走的是**同一段程式**，只有「怎麼拿到內容」那一行不同：本機是 `library.read`，
 * Web 是最多 20 次併發的 GET（限流只卡寫入，不卡讀取）。沒有為它多開一支批次讀取
 * API —— 那會多一組跟「讀取詳細」重複的授權邏輯，而兩份重複的授權邏輯遲早會漂移。
 *
 * `.mml` 帶不走顯示旗標與當前軌 —— **不警告**，那是這個格式本來的範圍。拿回來的路
 * 是既有的匯入（`#fileBox` 讀得懂 `.mml`，連樂器十都讀得回來）。
 */
async function batchZip() {
  clearErr();
  showOk("");
  const btn = $("#saveZip");
  btn.disabled = true;
  try {
    const chosen = files.filter(f => picked.has(f.name));
    const names = library.zipEntryNames(chosen.map(f => f.name));

    const snapshots = tab === WEB
      // 併發而不是排隊：20 筆各自一次往返，排隊就是 20 倍的延遲。
      // 讀不回來的那一筆變成 null，下面跟本機走同一條「跳過」的路。
      ? await Promise.all(chosen.map(f =>
          websave.read(f.id).then(r => r?.snapshot ?? null).catch(() => null)))
      : await Promise.all(chosen.map(f => library.read(f.name).catch(() => null)));

    const entries = [];
    for (const [i, f] of chosen.entries()) {
      const saved = snapshots[i];
      if (!saved) continue;          // 讀不回來的那一筆就跳過，不要整包失敗
      entries.push({ name: names[i], data: mmlOf(f.name, saved) });
    }
    if (!entries.length) { showErr(i18n.t("saveBox.zipEmpty")); return; }

    const buf = await zip(entries);
    const a = document.createElement("a");
    const blob = new Blob([buf], { type: "application/zip" });
    a.href = URL.createObjectURL(blob);
    // 木檔名帶日期 —— 下載資料夾裡三個月後還認得出這是什麼
    a.download = `${safeFileName(i18n.t("saveBox.zipName"))}-${stamp()}.zip`;
    a.click();
    URL.revokeObjectURL(a.href);
    // 成功只報數字，**不自動刪** —— 讓使用者親眼確認檔案下載好了再按「刪除選取」。
    showOk(i18n.t("saveBox.zipped", { n: entries.length }));
  } catch (err) {
    showErr(i18n.t("saveBox.zipFailed", { msg: err?.message ?? "" }));
  } finally {
    btn.disabled = false;
    syncFoot();
  }
}

/** `20260817` —— 排序友善，而且不含任何語言相關的東西。 */
function stamp() {
  const d = new Date();
  const p = n => String(n).padStart(2, "0");
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}`;
}

// ─── 接線 ───────────────────────────────────────────────────────────────────

/**
 * @param {object} hooks 由 ui 提供
 * @param {() => void}          hooks.onOpen   開啟之後要停播 + 重新解析
 * @param {(fn:Function)=>void} hooks.wrapEdit 把整批換內容包成可復原的一步
 * @param {() => object|null}   hooks.getSong  目前的解析結果（算音符數月用）
 */
export function init({ onOpen: opened, wrapEdit: wrap, getSong: song } = {}) {
  onOpen = opened ?? onOpen;
  wrapEdit = wrap ?? wrapEdit;
  getSong = song ?? getSong;

  const b = box();
  if (!b) return;

  $("#saveGo").addEventListener("click", save);

  for (const t of $("#saveTabs").children)
    t.addEventListener("click", () => switchTab(t.dataset.tab));

  // 連線狀態變了就重算。**兩支都要訂閱**：syncGo 管置底那顆「存到 web」，syncTab 管
  // 未登入時蓋在清單上的登入提示 —— 只訂閱前者，離線時那顆登入鈕會一直是可以按的。
  net.subscribe(syncGo);
  net.subscribe(syncTab);

  // 檔名一改：儲存鈕的可按與否、清單的「就是這一份」高亮，以及匯出區的曲名都要跟上。
  nameField().addEventListener("input", () => {
    filebox.setSongName(nameField().value);
    syncGo();
    syncHit();
  });
  // 打完名字最想做的就是存下去。這個框沒有 form，不攔的話 Enter 什麼都不會發生。
  nameField().addEventListener("keydown", e => {
    if (e.key !== "Enter") return;
    e.preventDefault();
    if (!$("#saveGo").disabled) save();
  });

  $("#savePickAll").addEventListener("change", e => {
    picked.clear();
    // 全選 = 全選**這一頁**。Web 一頁就日是 20 筆，所以「批次一次最多 20 筆」是版面的
    // 自然結果。
    if (e.target.checked) for (const f of files) picked.add(f.name);
    render();
  });
  $("#saveZip").addEventListener("click", batchZip);
  $("#saveMove").addEventListener("click", askMove);
  $("#saveDel").addEventListener("click", () => askDelete([...picked]));

  // 手動翻頁就把勾選清掉：那個「這幾份」已經不在畫面上了
  $("#savePrev").addEventListener("click", () => { picked.clear(); reload(page - 1); });
  $("#saveNext").addEventListener("click", () => { picked.clear(); reload(page + 1); });

  $("#saveOverCancel").addEventListener("click", closeOver);
  $("#saveOverOk").addEventListener("click", () => {
    const f = pendingOver;
    closeOver();
    if (f) write(f.name, f);
  });

  $("#saveDelCancel").addEventListener("click", closeDelete);
  $("#saveDelOk").addEventListener("click", doDelete);

  $("#saveMoveCancel").addEventListener("click", closeMove);
  $("#saveMoveSkip").addEventListener("click", () => doMove(false));
  $("#saveMoveOver").addEventListener("click", () => doMove(true));

  // 點背景關掉。四人個框各自處理自己的。
  for (const el of [b, overBox(), delBox(), moveBox()])
    el.addEventListener("click", e => { if (e.target === el) el.classList.remove("on"); });

  addEventListener("keydown", e => {
    if (e.key !== "Escape") return;
    // 三個確認框疊在 #saveBox 之上，所以先問它們 —— 不然 Esc 會把底下的儲存框關掉，
    // 留下一個浮在半空中的確認框（同 sharebox）。
    if (overBox().classList.contains("on")) { closeOver(); return; }
    if (delBox().classList.contains("on")) { closeDelete(); return; }
    if (moveBox().classList.contains("on")) { closeMove(); return; }
    if (b.classList.contains("on")) close();
  });
}

/**
 * 「新增」按下之後要把基準清掉 —— 不清的話那個框會對著一份空白的新譜說「有未儲存的
 * 變更」。
 *
 * export 給 filebox 用。**單向依賴**：filebox 不 import 這個檔案（會變成循環），
 * 是 ui 在接線時把這一支交給它。
 */
export function forget() {
  savedFingerprint = null;
  detach();
}

/**
 * 「編輯器裡的東西被**整批換掉**了，所以它已經不是上次存的那一份檔案。」
 *
 * **每一條整批取代的路徑都必須叫它**（ui 的 onExternalText 是那個交會點：貼上取代、
 * 載入分享、匯入 MML／MIDI 都走它）。漏掉一條的下場：
 *
 *   存好 Godknows → 貼上別人竹的譜整批取代 → 檔名欄還是「Godknows」
 *   → Ctrl+S → **不問就把別人的譜寫進 Godknows**
 *
 * 不直接用 `forget()` 是因為 `savedFingerprint` 要**留著**：它答的是「自從上次儲存以
 * 來改過嗎」，那個問題在整批取代之後照樣有意義。一起清掉的話儲存框會正好在最該提醒
 * 的時候閉嘴。
 */
export function detach() { lastSaved = null; }
