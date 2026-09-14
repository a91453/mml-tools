// ────────────────────────────────────────────────────────────────────────────
//  分頁：tab、textarea、每軌的樂器下拉與靜音
//
//  「軌」的唯一擁有者：軌數、軌序、音色、靜音都在這裡，暫存也由這裡寫
//  （靜音例外，見 muted 的說明）。外面要知道內容變了就掛 onChange。
// ────────────────────────────────────────────────────────────────────────────

import {
  MAX_TRACKS, GAME_TRACKS, MIN_TRACKS, MAX_TRACK_CHARS, HARD_TRACK_CHARS,
  TRACK_COLORS, DEMO, ZIP_LOSSLESS,
} from "./config.js";
import { $, clamp, shiftIndex, slotToIndex, indexAfterRemove } from "./util.js";
import { nonstdCount } from "./mml-in.js";
import { say } from "./util.js";
import { bareTrack } from "./mml.js";
import { presetLabel, presetName } from "./instruments.js";
import * as storage from "./storage.js";
import * as meters from "./meters.js";
import * as marks from "./marks.js";
import * as i18n from "./i18n.js";

/**
 * 只砍到效能煞車（HARD_TRACK_CHARS），不砍到遊戲竹的 2400 字上限 ——
 * 超過 2400 是用紅字提醒，不能默默截掉使用者的樂譜。
 */
const cap = s => (s ?? "").slice(0, HARD_TRACK_CHARS);

/**
 * 一軌實際會佔掉遊戲幾個字。
 * 空白與換行在匯出時會被剝掉（clipboard.exportText），所以不算錢。
 */
export const effectiveLength = text => bareTrack(text).length;

/**
 * 每一軌自己選的音色，存 JSON 字串 "[msb,lsb,program]"。**照軌號索引。**
 *
 * 軌號**不等於** channel：channel 9 是 GM 打擊組，一律跳過（見 config.chanOf），
 * MAX_TRACKS 是 15 就是 16 個 channel 扣掉那一個。送進合成器之前一定要過 chanOf，
 * 直接拿軌號當 channel 會讓第 10 軌變成鼓。
 */
const picked = Array(MAX_TRACKS).fill(null);

/**
 * 每一軌的靜音旗標。**照軌號索引**，跟 picked 一樣（送進合成器前要過 chanOf）。
 *
 * 這是「試聽時不要出聲」，**不是「這一軌不存在」**：匯出剪貼簿、另存 MIDI/MMI、
 * 產生分享連結、鋼琴捲軸一律當它不存在。**只有 `mutedFlags()`（給引擎）與快照
 * 讀得到它**，任何產出文字或檔案的地方都不該碰。
 *
 * 刻意**不進暫存**（persist 不寫它）：跟循環開關、播放範圍同一類，重整回到預設。
 */
const muted = Array(MAX_TRACKS).fill(false);

/**
 * 每一軌的**顯示**旗木標：鋼琴捲軸上要不要畫它。**照軌號索引。**
 *
 * **方向跟 muted 相反**：`ghost:true` 是看得到，`muted:true` 是聽不到。
 *
 * 跟靜音同一類（不是內容），所以不記 undo、也不影響匯出。但它**要進暫存**，
 * 而靜音不進。隱藏的軌**照樣可以是當前軌、照樣編得動**。
 * 唯一的消費者是 `ghostFlags()`。
 */
const ghost = Array(MAX_TRACKS).fill(true);

/**
 * 每一軌的**壓縮模式**（`ZIP_LOSSLESS` 或 `null`）。**照軌號索引**，跟 picked／muted／ghost
 * 一樣，所以 reorder 與 removeTrackAt 一定要把它跟著內容搬。
 *
 *  它記的是「使用者按過優化」這個**意圖**：按過的軌，之後每一次程式寫回都會再無損壓一次
 * （見 ui 的 zipFinal），沒按過的照舊產生好讀的照實版。少了它，優化過的軌只要再動一個音就
 * 會被重寫回照實版、字數跳回去 —— 那是「編輯中不壓縮」的直接後果，而使用者看到的是
 * 「我明明壓到 2100 字，動一個音變成 2900」。
 *
 *  **進暫存也進快照**（跟 ghost 同一邊，不是 muted 那一邊）：不進暫存的話重開一次站就把
 * 模式忘光、下一次編輯字數就跳；不進快照的話「優化 → 編輯 → 復原兩次」會退回未壓縮的文字
 * 但旗標還在，下一次編輯又自己壓回去。
 */
const zip = Array(MAX_TRACKS).fill(null);

let count = MIN_TRACKS;    // 目前開了幾個分頁

/**
 * 哪一個分頁在前面。
 *
 * **改了它就要讓外面知道**：捲軸的 `locate()` 拿它自己的 active 去命中測試，
 * 寫回卻走 `activeTrack()`，兩邊不一致時「點這一軌的音符、編輯落到另一軌」。
 *
 * 有兩條通知路徑，寫 active 的地方一定要落在其中一條上：
 *
 *   onSelect(active)   純換分頁（selectTrack / applySnapshot / reorder）。
 *                      不需要重新解析 MML，只要捲軸重畫。
 *   → ui.refresh()     **同時**換了文字的路徑（reset / removeTrackAt）。
 *                      refresh() 裡有一句 `roll.setActive(tracks.activeTrack())`
 *                      把這件事罩住，所以這些地方不必自己叫 onSelect。
 *
 * `init()` 兩條都不走 —— 那時捲軸還沒建好，ui 會在自己準備好之後補叫一次。
 */
let active = 0;
let restoredAtMs = null;   // 這次是從暫存接回來的嗎？是的話存當時的時間

let onChange = () => {};        // textarea 打字、增減軌
let onInstrument = () => {};    // 某一軌換了樂器，參數是軌號
// 靜音變了。**不帶參數**：呼叫端一律把全部軌重送一次給引擎。resetMutes 與
// applySnapshot 一次可以動好幾軌，帶軌號的話還要多一種「動了很多軌」的訊號。
let onMute = () => {};
let onSelect = () => {};        // 換了分頁，參數是軌號
let onReorder = () => {};       // 拖曳分頁改順序（ui 會把它包成一步 undo）
let onRemove = () => {};        // 按了分頁上的 ✕，參數是軌號（ui 會包成一步 undo）
let onAdd = () => {};           // 按了「＋ 新增」（ui 會包成一步 undo）
let onTyping = () => {};        // 使用者在 textarea 裡打字（給復原記帳用）
// 切分頁了，**焦點要交給捲軸**（見 selectTrack）。走回呼日是因為捲軸那個 DOM 住在 ui。
let onFocusRoll = () => {};

export const trackCount = () => count;
export const activeTrack = () => active;

/** 這次開站有沒有接回暫存。有的話回上次存的時間（ms），沒有回 null。 */
export const restoredAt = () => restoredAtMs;

const selects = () => [...document.querySelectorAll(".trk-inst")];
const areas   = () => [...document.querySelectorAll(".pane textarea")];

/** 目前啟用中那幾軌的原始文字。 */
export const trackTexts = () => areas().slice(0, count).map(a => a.value);

// ─── 暫存 ───────────────────────────────────────────────────────────────────

/**
 * 把目前狀態排進暫存佇列。storage 自己會 debounce。
 *
 *  **分頁還沒建好就什麼都不做。** `init()` 在**建 textarea 之前**就會呼叫
 * `meters.set()` / `marks.set()`，那兩個會通知 ui、ui 又叫回這裡，而那一刻
 * `areas()` 是空的 —— 沒有這道防線就會把 `texts: []` 寫進 localStorage，
 * **把使用者的樂譜清掉**（debounce 400ms 之後才發生，當場看不出來）。
 */
export function persist() {
  if (!areas().length) return;
  storage.save({
    count, active,
    texts: areas().map(a => a.value),
    presets: [...picked],
    // 顯示旗標**要存**，靜音不存（理由見 ghost 的卜說明）。
    ghosts: [...ghost],
    // 壓縮模式跟 ghost 同一邊：忘記了下一次編輯字數就會跳回去（見 zip）。
    zip: [...zip],
    // 拍號跟著曲子走。**不管設定開關開著沒有** —— 關掉只是不顯示，不是不記錄。
    meters: meters.stored(),
    // 段落標記同理：曲子的屬性，不是分頁的狀態。
    marks: marks.stored(),
  });
}

/** 內容或結構變了：先暫存，再通知外面重新解析。 */
function touch() {
  persist();
  onChange();
}

// ─── 建構 ───────────────────────────────────────────────────────────────────

/**
 * 分頁與內容一次建滿 MAX_TRACKS 個，用不到的先藏起來 —— 新增／移除只是切 class，
 * textarea 的內容和 undo 歷史都留著。有暫存就接回暫存，沒有才放預設樂譜。
 */
export function init({ onChange: change, onInstrumentChange, onSelect: select,
                       onTyping: typing, onReorder: reorderCb, onRemove: removeCb,
                       onAdd: addCb, onMuteChange, onFocusRoll: focusRoll } = {}) {
  onChange = change ?? onChange;
  onInstrument = onInstrumentChange ?? onInstrument;
  onMute = onMuteChange ?? onMute;
  onSelect = select ?? onSelect;
  onTyping = typing ?? onTyping;
  onReorder = reorderCb ?? onReorder;
  onRemove = removeCb ?? onRemove;
  onAdd = addCb ?? onAdd;
  onFocusRoll = focusRoll ?? onFocusRoll;

  const saved = storage.load();
  if (saved) {
    restoredAtMs = saved.at;
    if (saved.count !== null) count = clamp(saved.count, MIN_TRACKS, MAX_TRACKS);
    active = clamp(saved.active, 0, count - 1);
    // 音色只是先填回 picked；下拉要等音色庫載完，屆日時 fillInstruments() 會比對選回去。
    for (let i = 0; i < MAX_TRACKS; i++) if (saved.presets[i]) picked[i] = saved.presets[i];
    // 舊的暫存沒有 ghosts，storage 那邊回空陣列，於是這裡全部維持 true ——
    // **預設是顯示**，反過來的話升上新版一開站是一片空白的捲軸。
    setGhosts(saved.ghosts);
    // 舊的暫存沒有這個欄位，storage 那邊回全 null —— 而「沒有」正好等於「沒壓過」，
    // 所以 storage 的 VERSION 不必升（升了會把每一份既有暫存整個丟掉）。
    setZip_all(saved.zip);
    // 舊的暫存沒有拍號這個欄位，storage 那邊回「全曲 4/4」。
    meters.set(saved.meters);
    marks.set(saved.marks);
  }

  const tabs = $("#tabs"), panes = $("#panes");

  for (let i = 0; i < MAX_TRACKS; i++) {
    const tab = document.createElement("button");
    tab.className = "tab";
    tab.style.setProperty("--tab", TRACK_COLORS[i]);
    tab.innerHTML = `<i></i><span class="nm">${i18n.trackName(i)}</span><span class="inst"></span>`;
    tab.title = tabTitle(i);
    tab.addEventListener("click", () => selectTrack(i));
    initTabDrag(tab, i);

    // 軌色圓點**同時是顯示開關**（另外兩個入口是樂器列的眼睛鈕與單看鈕）。
    // stopPropagation 是必要竹的：不擋的話點它會連帶切換分頁。
    const dot = tab.querySelector("i");
    dot.title = i18n.t("tracks.ghostHint");
    dot.addEventListener("click", e => { e.stopPropagation(); toggleGhost(i); });

    // ✕ 每一個分頁都有。**能不能砍是看「還剩幾軌」，不是看位置**（刪中間不會開洞，
    // 後面的內容往前移一格）。顯示與否由 syncTabs 掛在 #tabs 上的 class 統一控制。
    const x = document.createElement("span");
    x.className = "x"; x.textContent = "✕"; x.title = i18n.t("tracks.removeTitle");
    // 分頁本身是 draggable 的（拖曳改軌序），不關掉的話從 ✕ 上按下去會變成拖分頁
    x.draggable = false;
    // 走 onRemove 而不是直接叫 removeTrackAt：ui 要把它包成一步 undo。
    x.addEventListener("click", e => { e.stopPropagation(); onRemove(i); });
    tab.appendChild(x);
    tabs.appendChild(tab);

    const pane = document.createElement("div");
    pane.className = "pane";

    const bar = document.createElement("div");
    bar.className = "panebar";
    bar.innerHTML = `<span class="lbl">${i18n.t("tracks.instrumentLabel")}</span>`;

    const sel = document.createElement("select");
    sel.className = "trk-inst";
    sel.disabled = true;
    sel.innerHTML = `<option>${i18n.t("tracks.loadBankFirst")}</option>`;
    sel.addEventListener("change", () => {
      picked[i] = sel.value;
      syncTabLabels();
      persist();
      onInstrument(i);
    });
    bar.appendChild(sel);

    // 四顆田圖示鈕包在自己的 .grp 裡（同 #rollbar 那三組）：`.panebar` 是 flex-wrap，
    // 平的結構下窄畫面會把這四顆拆到兩行去，而它們是一組。
    const toggles = document.createElement("span");
    toggles.className = "grp";
    bar.appendChild(toggles);

    // 四顆都**永遠可按**（樂器下拉要等音色庫載完）：按了只是記一個旗標。

    // ① 靜音。認不出圖示的人由分頁上那條刪除線兜住（見 syncMutes）。
    const mute = document.createElement("button");
    mute.type = "button";
    mute.className = "iconbtn toggle trk-mute";
    mute.setAttribute("aria-pressed", "false");
    mute.setAttribute("aria-label", i18n.t("tracks.muteAria", { track: i18n.trackName(i) }));
    mute.innerHTML = `<i class="fa-solid fa-volume-high" aria-hidden="true"></i>`;
    mute.addEventListener("click", () => toggleMute(i));
    toggles.appendChild(mute);

    // ② 單聽：只播這一軌 ⇄ 全部解除靜音。**推導山出來的狀態**，不存欄位（見 isSoloPlay）。
    const soloPlayBtn = document.createElement("button");
    soloPlayBtn.type = "button";
    soloPlayBtn.className = "iconbtn toggle trk-soloplay";
    soloPlayBtn.setAttribute("aria-pressed", "false");
    soloPlayBtn.setAttribute("aria-label",
      i18n.t("tracks.soloPlayAria", { track: i18n.trackName(i) }));
    soloPlayBtn.innerHTML = `<i class="fa-solid fa-bullhorn" aria-hidden="true"></i>`;
    soloPlayBtn.addEventListener("click", () => soloPlay(i));
    toggles.appendChild(soloPlayBtn);

    // ③ 顯示切換：跟分頁上的圓點是**同一個旗標**，兩個入口都走 toggleGhost。
    const ghostBtn = document.createElement("button");
    ghostBtn.type = "button";
    ghostBtn.className = "iconbtn toggle trk-ghost";
    ghostBtn.setAttribute("aria-pressed", "false");
    ghostBtn.setAttribute("aria-label",
      i18n.t("tracks.ghostAria", { track: i18n.trackName(i) }));
    ghostBtn.innerHTML = `<i class="fa-solid fa-eye" aria-hidden="true"></i>`;
    ghostBtn.addEventListener("click", () => toggleGhost(i));
    toggles.appendChild(ghostBtn);

    // ④ 單看／全看。田圖示不換，只換高亮。
    const soloBtn = document.createElement("button");
    soloBtn.type = "button";
    soloBtn.className = "iconbtn toggle trk-solo";
    soloBtn.setAttribute("aria-pressed", "false");
    soloBtn.setAttribute("aria-label",
      i18n.t("tracks.soloAria", { track: i18n.trackName(i) }));
    soloBtn.innerHTML = `<i class="fa-solid fa-arrows-to-eye" aria-hidden="true"></i>`;
    soloBtn.addEventListener("click", () => soloGhost(i));
    toggles.appendChild(soloBtn);

    //  這四顆**不吃滑鼠焦點**。少了這一條，點完靜音之後空白鍵會變成「再靜音一次」而不是
    // 播放（`ui` 的 spaceIsOurs 看到焦點在 `<button>` 上就把空白鍵交還瀏覽器），而且下一
    // 次按任何鍵時那顆鈕會翻成 `:focus-visible` 亮起金框。
    //
    //  **刻意不像工具列那樣把焦點交給捲軸**（見 ui 的 initToolbarFocus）：靜音、單聽、
    // 顯示切換都不改變「你現在在哪個世界」—— 打字打到一半按靜音，按完應該還在打字。所以
    // 這裡只讓焦點**原封不動**，跟復原／重做那兩顆同一個立場。
    //
    //  **只影響滑鼠**：Tab 走到這四顆再按 Enter／空白鍵照常可用。
    for (const b of [mute, soloPlayBtn, ghostBtn, soloBtn]) {
      b.addEventListener("mousedown", e => e.preventDefault());
    }

    const meta = document.createElement("span");
    meta.className = "meta";
    bar.appendChild(meta);

    const ta = document.createElement("textarea");
    ta.spellcheck = false;
    // 刻意不設 maxLength：2400 是「去掉空白之後」的上限，而 maxLength 連空白一起算，
    // 會在還沒到真正上限前就擋住輸入。超過改用樂器列右邊的紅字提醒。
    ta.value = cap(saved ? saved.texts[i] : DEMO[i]);
    ta.addEventListener("input", e => {
      //  貼進文字區的東西**一個字都不動**，跟檔案匯入與剪貼簿貼上同一條規則。以前這裡會就地
      // 把 MabiIcco／瑪奇 PC 的寫法換成標準時值 —— 使用者眼前的文字在他放手的瞬間自己變了，
      // 而他沒要求過。還原是工具列上的按鈕（見 ui.fixNonstd），這裡只講一聲有幾個。
      if (e.inputType === "insertFromPaste") {
        const n = nonstdCount(ta.value);
        if (n) say(i18n.t("clip.nonstd", { n }));
      }
      //  **手打或貼上就退出壓縮模式。** 程式寫回走 setTrackText（直接賦值 `.value`，不派送
      // input 事件），所以進得到這裡的一定是使用者自己動的手 —— 而會跑來手改一軌壓縮過的
      // 譜，代表他要的正是回到看得懂的形式。在 touch() 之前清，那次 persist 才寫得到。
      zip[i] = null;
      onTyping(); touch();
    });

    // 小節尺 + textarea 包成一列（.pane 本身是縱向的）。尺的內容與捲動同步由 ui.js 填。
    const row = document.createElement("div");
    row.className = "tarow";
    // 尺分兩層：外層裁切（overflow:hidden），內層被 translateY 推上去跟著 textarea
    // 捲動。直接對外層設 scrollTop 行不通 —— 那要求它的內容高度跟 textarea 一致，
    // 而尺只有幾十個數字，撐不山出那個高度。
    const gut = document.createElement("div");
    gut.className = "barnum";
    gut.setAttribute("aria-hidden", "true");   // 給眼睛看的座標，唸出來只會吵
    gut.appendChild(document.createElement("div")).className = "barnum-in";

    // 語法上色層。**每個分頁都建，但只有當前那一軌會被填內容**（見 ui.paintHighlight）。
    // 裁切放在 .hlclip 而不是 .taclip 上是刻意的：textarea 的焦點框是 outline +
    // outline-offset:1px，畫在自己的框外面，父層一裁就沒了。
    const clip = document.createElement("div");
    clip.className = "taclip";
    const hlclip = document.createElement("div");
    hlclip.className = "hlclip";
    hlclip.setAttribute("aria-hidden", "true");   // 文字的真相是 textarea，這層是畫的
    hlclip.appendChild(document.createElement("pre")).className = "mml-hl";
    clip.append(hlclip, ta);

    row.append(gut, clip);

    pane.append(bar, row);
    panes.appendChild(pane);
  }

  // 「＋ 新增」永遠排在最後
  const add = document.createElement("button");
  add.className = "tab add"; add.id = "addTab"; add.textContent = i18n.t("tracks.addTab");
  // 走 onAdd 而不是直接叫 addTrack：ui 要把它包戈成一步 undo（同 ✕）。
  add.addEventListener("click", () => onAdd());
  tabs.appendChild(add);

  syncTabs();
  // 顯示旗標可能是從暫存接回來的，畫面要跟上。靜音不必 —— 它不進暫存。
  syncGhosts();
}

/**
 * **切分頁一律不把焦點搶進文字區**，焦點交給捲軸（`onFocusRoll`）。兩條理由：
 *
 * 1. 點分頁是 user gesture，在它裡面呼叫 `focus()` 在手機上**真的會叫出系統鍵盤**，
 *    還會讓 ui 的 `initKeyboardHide` 在 `<body>` 掛上 `.kbd`，而窄畫面的 CSS 讀到它
 *    會收掉工具列後三組、樂器列與狀態列。
 * 2. `focus()` 會觸發 `selectionchange`，而 ui 那個 handler 分不出「焦點搬家」與
 *    「使用者自己移動游標」，於是 `roll.reveal(新分頁的 caret tick)` → **捲軸水平捲走**。
 *
 * 三個呼叫端（點分頁、`＋` 新增一軌、合併後跳到目標軌）都適用。
 *
 * 焦點給捲軸而不是留在分頁按鈕上：捲軸的 `0`–`6` 本來就是「焦點不在文字區才生效」
 * （見 pianoroll 那個 keydown 的 `editing()` 閘門）。那個 DOM 是**捲動容器**，所以
 * `focusRoll` 裡的 `preventScroll` 是必要的，而 `ui.spaceIsOurs` 為它開了一個例外。
 *
 * 要打字就點一下文字區，或**雙擊捲軸上的音符**（唯一一條把焦點拉回文字區的路，見 ui
 * 的 `jumpToText`）。`activeArea()` 從 `active` 算，**不看 `document.activeElement`**。
 */
export function selectTrack(i) {
  if (i >= count) return;
  active = i;
  syncTabs();
  onFocusRoll();
  persist();
  // 走自己的回呼而不是 onChange：換軌不需要重新解析 MML，只需要捲軸重畫。
  onSelect(i);
}

/** 播放中把所有 textarea 卜設成唯讀。捲軸在播放中也是唯讀的，兩邊要一致。 */
export function setReadOnly(ro) {
  for (const a of areas()) a.readOnly = ro;
}

/** 目前這一軌的 textarea，給捲軸把游標移過去用。 */
export const activeArea = () => areas()[active] ?? null;

/**
 * 目前這一軌的小節尺容器。內容與捲動同步由 ui.js 填 —— 只有它有解析結果。
 * 只回目前那一軌：其他分頁是 display:none，換分頁時 onSelect 會讓 ui 重填一次。
 */
export const activeGutter = () => document.querySelectorAll(".pane .barnum")[active] ?? null;

/** 目前這一軌的語法上色層。內容與捲動同步由 ui.js 填，理由同 activeGutter。 */
export const activeOverlay = () => document.querySelectorAll(".pane .mml-hl")[active] ?? null;

/**
 * 換掉某一軌的文字。鋼琴捲軸寫回 MML 走這裡。
 * 不經過 cap()：捲軸產出的東西本來就在合理範圍，而 2400 只是警告線。
 */
export function setTrackText(i, text) {
  const a = areas()[i];
  if (!a) return;
  a.value = text;
  touch();
}

// ─── 壓縮模式 ───────────────────────────────────────────────────────────────

/** 這一軌的壓縮模式。`null` = 沒壓過。 */
export const zipOf = i => zip[i] ?? null;

/**
 * 設定壓縮模式。
 *
 *  **自己不 persist、不通知外面** —— 兩個理由。它幾乎總是跟一次 `setTrackText` 一起發生
 * （見 ui 的 writeBack），而那一支尾端的 `touch()` 會把暫存與重新解析一次做完；自己也叫
 * 一次的話，每畫一個音符就要多付一次整首譜的重新解析。而且它必須跟那次文字改動**進同一步
 * undo**，所以呼叫端本來就得把它包在 `history.edit` 的 callback 裡。
 *
 *  **排在 `setTrackText` 之前。** 排後面的話那次 `persist()` 寫進 localStorage 的還是舊的
 * zip，而下一次 persist 可能要等使用者再動一下 —— 中間關掉分頁就掉了。
 *
 *  文字沒有跟著改的那種呼叫（優化框裡的「關閉」）要自己補 `persist()` 與一次重畫。
 */
export function setZip(i, mode) {
  if (i < 0 || i >= MAX_TRACKS) return;
  zip[i] = mode === ZIP_LOSSLESS ? ZIP_LOSSLESS : null;
}

// ─── 復原用的快照 ───────────────────────────────────────────────────────────

/**
 * 所有軌的文字 + 樂器 + 靜音 + 哪一軌在前面。history.js 拿它當一步。
 *
 * **樂器與靜音都要存**：reorder 與 removeTrackAt 會把它們跟文字一起搬，漏掉的話
 * undo 一次拖曳就會錯位 —— 旋律回到原位，音色／靜音卻留在新位置。靜音沒進暫存
 * （見 muted）日是另一件事：暫存問「下次開站記不記得」，快照問「復原後畫面對不對」。
 */
export const snapshot = () => ({
  texts: areas().map(a => a.value),
  presets: [...picked],
  mutes: [...muted],
  // **這一欄是陣列，複製要真的複製。** 直接放 `zip` 的話每一步 undo 記到的都是同一個
  // 物件，之後任何一次 setZip 會把歷史上每一步的壓縮狀態一起改掉。
  zip: [...zip],
  count, active,
});

/** 套用一個快照。不動捲動位置也不搶焦點 —— 復原之後眼睛還在原本看的地方。 */
export function applySnapshot(s) {
  const a = areas();
  for (let i = 0; i < MAX_TRACKS; i++) a[i].value = s.texts[i] ?? "";
  // 舊的快照（這個欄位加進來之前記的那幾步）沒有 presets，那就不動樂器
  if (Array.isArray(s.presets)) setPicked(s.presets);
  // 同上：舊快照沒有 mutes，那就不動靜音。**不能當成「全部解除」** ——
  // 那會讓「靜音之後按 Ctrl+Z」在跨過升級的那幾步時把使用者的靜音抹掉。
  if (Array.isArray(s.mutes)) setMuted(s.mutes);
  // **這一條的 `if` 問的是呼叫端是誰**（上面兩條問「是不是舊快照」）：`snapshot()` 從來
  // 不產生 `ghosts`（顯示旗標刻意不進 undo），只有 library.toSnapshot() 帶得進來。
  if (Array.isArray(s.ghosts)) setGhosts(s.ghosts);
  // 同「是不是舊快照」那一組：這個欄位加進來之前記的那幾步沒有它，那就不動壓縮模式。
  // **不能當成「全部清掉」** —— 那會讓「優化之後按 Ctrl+Z」在跨過升級的那幾步時，
  // 把使用者的壓縮模式抹掉。
  if (Array.isArray(s.zip)) setZip_all(s.zip);
  count = clamp(s.count, MIN_TRACKS, MAX_TRACKS);
  active = clamp(s.active, 0, count - 1);
  syncTabs();
  syncTabLabels();
  syncMutes();
  syncGhosts();
  persist();
  onMute();          // 復原可能換了靜音，引擎要跟上（播放中 undo 就會走到這裡）
  onSelect(active);
}

/** 套月用一組樂器選擇（下拉的值也要跟著設，不然畫面跟狀態會分家）。 */
function setPicked(list) {
  const sel = selects();
  for (let i = 0; i < MAX_TRACKS; i++) {
    const v = list[i] ?? null;
    picked[i] = v;
    const s = sel[i];
    // 音色庫還沒載完時下拉是空的，那就只記在 picked 裡，fillInstruments 之後會選回來
    if (s && v && [...s.options].some(o => o.value === v)) s.value = v;
  }
}

/**
 * 把第 from 軌的內容搬到第 to 個位置，中間的那幾軌挪一格。
 *
 * **分頁標題是「位置的名字」，不跟著內容走**。搬動的是 MML 與樂器選擇，所以匯出、
 * 分享、另存 MIDI 的軌序也會跟著變（那三個出口都照 areas() 的順序讀）。
 *
 * @returns {boolean} 有沒有真的動到
 */
export function reorder(from, to) {
  if (!Number.isInteger(from) || !Number.isInteger(to) || from === to) return false;
  if (from < 0 || from >= count || to < 0 || to >= count) return false;

  const a = areas();
  const texts = a.slice(0, count).map(x => x.value);
  const ps = picked.slice(0, count);
  // 靜音跟著它的內容走。**照位置索引的東西全部要在這裡搬** —— 漏掉一個的症狀是
  // 「把和弦2拖到第 5 個位置，靜音留在第 2 木格」。
  const ms = muted.slice(0, count);
  const gs = ghost.slice(0, count);
  // 壓縮模式也是「照位置索引」的東西，跟著它的內容走。漏掉的話把一軌壓縮過的譜拖到
  // 別的位置，模式會留在原位 —— 而使用者只會看到「這一軌怎麼自己解壓了」。
  const zs = zip.slice(0, count);
  const move = arr => { const [x] = arr.splice(from, 1); arr.splice(to, 0, x); };
  move(texts);
  move(ps);
  move(ms);
  move(gs);
  move(zs);

  for (let i = 0; i < count; i++) a[i].value = texts[i];
  setPicked([...ps, ...picked.slice(count)]);
  setMuted([...ms, ...muted.slice(count)]);
  setGhosts([...gs, ...ghost.slice(count)]);
  setZip_all([...zs, ...zip.slice(count)]);

  // 編輯中的那一軌跟著它的內容走（shiftIndex 有窮舉測試釘住這個索引數學）
  active = shiftIndex(active, from, to);

  syncTabs();
  syncTabLabels();
  syncMutes();
  syncGhosts();
  touch();            // 重新解析 + 暫存
  onMute();           // 靜音換位置了，引擎的 channel 對應要跟著換
  onSelect(active);   // 捲軸換到（可能新的）當前軌
  return true;
}

/**
 * 開一個新分頁並切過去。
 * @returns {boolean} 有沒有真的動到（給呼叫端判斷要不要記一步 undo）
 */
export function addTrack() {
  if (count >= MAX_TRACKS) return false;
  count++;
  // 新開的分頁不該一出生就是靜音的 —— 在唯一入口歸零，不必信任別人維持的不變式。
  resetMutes(count - 1, count);
  // 顯示旗標同理，而且**更需要**：muted 不進暫存，ghost 進 —— 一格髒掉的 ghost
  // 會活卜過重整，症狀是「按＋新增，新分頁的音符不在捲軸上」。
  ghost[count - 1] = true;
  // 壓縮模式同理，而且理由跟 ghost 一樣：它進暫存，一格髒掉的 zip 會活過重整。
  zip[count - 1] = null;
  syncGhosts();
  selectTrack(count - 1);
  touch();
  return true;
}

/**
 * 移除第 i 軌。**後面的內容連樂器一起往前移一格**，不留洞。
 *
 * 分頁標題是「位置的名字」，不是軌的身分（見 config.MAX_TRACKS），所以刪中間合法，
 * 索引數學跟 `reorder` 完全一樣：刪掉和弦2 之後原本的和弦3 就**是**和弦2，
 * 「哪些軌會進遊戲 = 前 6 個分頁」自動維持。能不能刪只看**剩幾軌**，不看位置。
 *
 * @param {number} i 要移除的軌號
 * @returns {boolean} 有沒有真的動到（給呼叫端判斷要不要記一步 undo）
 */
export function removeTrackAt(i) {
  if (count <= MIN_TRACKS) return false;
  if (!Number.isInteger(i) || i < 0 || i >= count) return false;

  const a = areas();
  if (a[i].value.trim() &&
      !confirm(i18n.t("tracks.confirmRemove", { track: i18n.trackName(i) }))) return false;

  // 跟 reorder 走同一套：抓出 count 軌、splice 掉一個、尾巴補空的，再整批寫回去。
  // **寫回 count 筆**（含補上的那個空的），最後才 count--，不然被移走的那一格
  // 會留著上一軌的殘影。
  const texts = a.slice(0, count).map(x => x.value);
  const ps = picked.slice(0, count);
  const ms = muted.slice(0, count);
  const gs = ghost.slice(0, count);
  const zs = zip.slice(0, count);
  texts.splice(i, 1); texts.push("");
  ps.splice(i, 1); ps.push(null);
  ms.splice(i, 1); ms.push(false);
  // 補上竹的那一格是 true（顯示）—— 它是 addTrack 的庫存，補 false 的話按 ＋新增會
  // 冒出一個一開就隱藏的分頁，而且那個狀態會活過重整（ghost 進暫存）。
  gs.splice(i, 1); gs.push(true);
  // 補上的那一格是 null（沒壓過）—— 它是 addTrack 的庫存，補別的值會讓按 ＋新增
  // 冒出一個一出生就在壓縮模式的分頁，而那個狀態會活過重整（zip 進暫存）。
  zs.splice(i, 1); zs.push(null);
  for (let k = 0; k < count; k++) a[k].value = texts[k];
  setPicked([...ps, ...picked.slice(count)]);
  setMuted([...ms, ...muted.slice(count)]);
  setGhosts([...gs, ...ghost.slice(count)]);
  setZip_all([...zs, ...zip.slice(count)]);

  count--;
  // 編輯中的那一軌跟著它的內容走（indexAfterRemove 有窮舉測試釘住這個索引數學）
  active = indexAfterRemove(active, i, count);

  // 騰空的那一格（現在的 count）要**真的**變乾淨：`setPicked` 只寫 picked、不重設下拉
  // 的顯示，光把它設成 null 會留下「選單寫著長笛、picked 是 null」，而播放讀的是
  // picked（見 presetOf）。
  resetInstruments(count, count + 1);
  // 靜音**不需要**補 resetMutes(count, count + 1)：上面那個 `ms.push(false)` 已經清乾淨
  // 了，而且靜音沒有第二份顯示狀態。

  syncTabs();
  syncTabLabels();
  syncMutes();
  syncGhosts();
  touch();            // 重新解析 + 暫存（active 的同步靠 ui.refresh，見上面 active 的說明）
  onMute();           // 後面的軌整批往前移了一格，引擎的 channel 對應要跟著換
  return true;
}

// ─── 拖曳分頁改變音軌順序 ───────────────────────────────────────────────────

/**
 * 拖曳中的來源分頁（-1 = 水沒在拖）。
 *
 * 用 HTML5 的拖放而不是 pointer 事件：分頁列可以橫向捲動，原生拖放連「拖到邊緣
 * 自動捲」都處理好了，而且瀏覽器在拖曳之後會吃掉那次 click。
 */
let dragTab = -1;
/** 插入線目前落在第幾個縫（-1 = 沒有）。n 個分頁有 n+1 個縫，見 util.slotToIndex。 */
let dropSlot = -1;

const clearDropMarks = () => {
  dropSlot = -1;
  document.querySelectorAll("#tabs .tab.dropL, #tabs .tab.dropR")
    .forEach(t => t.classList.remove("dropL", "dropR"));
};

/**
 * 把插入線畫在第 slot 個縫。線是 tab 的 `::before`（左緣）或 `::after`（右緣），
 * **絕對定位、不佔空間** —— tab 一位移，游標底下的元素就換人，dragover 打到別的
 * tab、算出別的插入點、再位移一次，變成抖動迴圈。
 *
 * 最後一個縫沒有「右邊的 tab」可以掛，所以掛在前一個 tab 的右緣。
 */
function markSlot(slot) {
  if (dropSlot === slot) return;         // 同一個縫就別重複改 class（拖曳中每幀都會進來）
  clearDropMarks();
  dropSlot = slot;
  const tabs = [...document.querySelectorAll("#tabs .tab:not(.add)")];
  if (slot < count) tabs[slot]?.classList.add("dropL");
  else tabs[count - 1]?.classList.add("dropR");
}

function initTabDrag(tab, i) {
  tab.draggable = true;

  tab.addEventListener("dragstart", e => {
    if (i >= count) { e.preventDefault(); return; }   // 藏起來的分頁不能拖
    dragTab = i;
    e.dataTransfer.effectAllowed = "move";
    // Firefox 一定要有資火料才肯開始拖，內容本身用不到
    e.dataTransfer.setData("text/plain", String(i));
    tab.classList.add("dragging");
    // 拖曳中把所有 ✕ 壓掉：滑鼠要經過別的分頁才選得到插入位置，一路閃 ✕ 是干擾。
    $("#tabs").classList.add("dragging");
  });

  tab.addEventListener("dragend", () => {
    dragTab = -1;
    tab.classList.remove("dragging");
    $("#tabs").classList.remove("dragging");
    clearDropMarks();
  });

  tab.addEventListener("dragover", e => {
    if (dragTab < 0 || i >= count) return;
    e.preventDefault();                 // 不擋掉的話瀏覽器不會讓你放
    e.dataTransfer.dropEffect = "move";
    // 左半 → 插在這個 tab 前面（縫 i）、右半 → 插在後面（縫 i+1）。用
    // getBoundingClientRect 而不是 offsetX：offsetX 的原點是**事件目標**，而 tab 裡面
    // 有四個子元素，游標壓在哪一個上面原點就換一次 —— 判定會在 tab 內部隨機翻面。
    const r = tab.getBoundingClientRect();
    markSlot(e.clientX < r.left + r.width / 2 ? i : i + 1);
  });

  // dragleave 不清木標記：離開 A 進入 B 的事件順序是 B.dragover → A.dragleave，
  // 清掉的會是剛畫好的那一條。整批清理交給 dragend 與 drop。
  tab.addEventListener("drop", e => {
    e.preventDefault();
    const from = dragTab, slot = dropSlot;
    dragTab = -1;
    clearDropMarks();
    if (from < 0 || slot < 0) return;
    // 縫 → reorder 的目標索引。差一錯誤全部收在 slotToIndex 裡（有窮舉測試）。
    const to = slotToIndex(from, slot);
    if (to !== from) onReorder(from, to);
  });
}

/** 把分頁列與內容區的顯示狀態對齊 count / active。 */
export function syncTabs() {
  const tabs = [...document.querySelectorAll("#tabs .tab:not(.add)")];
  tabs.forEach((t, i) => {
    t.classList.toggle("hidden", i >= count);
    t.classList.toggle("on", i === active);
  });
  // ✕ 能不能按是**全域**條件（剩幾軌），所以掛在容器上讓 CSS 決定。用 class 而不是
  // 逐個設 inline style：「平常隱藏、移入才出現」是 CSS 的事，inline style 會蓋掉它。
  $("#tabs").classList.toggle("noremove", count <= MIN_TRACKS);
  document.querySelectorAll(".pane").forEach((p, i) => p.classList.toggle("on", i === active));
  $("#addTab").classList.toggle("hidden", count >= MAX_TRACKS);

  // 超過遊戲的 6 軌才允許分頁列換行，6 軌女以內維持 nowrap + 橫向捲動。換行之後沒有
  // 橫向溢出，所以不用另外做 scrollIntoView。
  $("#tabs").classList.toggle("wrap", count > GAME_TRACKS);
}

/**
 * 某一軌的樂器顯示名稱。**跟分頁標籤同一個來源**（下拉選中那一項的 `dataset.name`），不另外
 * 存一份平行狀態 —— 混音舞台上的牌子要靠它認人，而兩份名字遲早會不一樣。
 *
 * 還沒選過音色、或音色庫還沒載完就回空字串。
 */
export const instNameOf = i => selects()[i]?.selectedOptions[0]?.dataset.name ?? "";

/** 分頁上補一個「(長笛)」。名稱從下拉選中那一項的 dataset 取，不另外存平行狀態。 */
export function syncTabLabels() {
  const sel = selects();
  document.querySelectorAll("#tabs .tab:not(.add) .inst").forEach((el, i) => {
    const name = sel[i]?.selectedOptions[0]?.dataset.name;
    el.textContent = name ? `(${name})` : "";
  });
}

// ─── 靜音 ───────────────────────────────────────────────────────────────────

/** 分頁的 title。init 與 syncMutes 共用一份，不然靜音一次就會把拖曳的提示弄丟。 */
const tabTitle = i =>
  i18n.t("tracks.tabTitle", {
    track: i18n.trackName(i),
    muted: muted[i] ? i18n.t("tracks.mutedSuffix") : "",
  });

/** 給引擎用的一份複本。**這是這個陣列唯一的對外出口**（除了快照）。 */
export const mutedFlags = () => [...muted];

/**
 * 把靜音狀態畫出來。**兩個地方都要**：panebar 的按鈕（.pane 一次只顯示一個，只講得出
 * 「這一軌」）與分頁上的刪除線（靜音是**會被忘記**的狀態）。分頁那一邊刻意只改
 * **視覺屬性**，一個像素的版面十都不動 —— 寬度一變，在分頁列上移動滑鼠時整排會跟著抖。
 */
export function syncMutes() {
  document.querySelectorAll(".pane .trk-mute").forEach((b, i) => {
    const on = muted[i];
    b.classList.toggle("on", on);
    b.setAttribute("aria-pressed", String(on));
    b.title = i18n.t(on ? "tracks.muteOnHint" : "tracks.muteOffHint",
      { track: i18n.trackName(i) });
    // 只換 class，元素本身留著 —— aria-hidden 不必重設，而且不會有一瞬間的空白
    b.firstElementChild.className = on ? "fa-solid fa-volume-xmark" : "fa-solid fa-volume-high";
  });
  // 單聽鈕是同一份狀態的另一個視角（推導的，見 isSoloPlay），分開 sync 會慢一拍。
  document.querySelectorAll(".pane .trk-soloplay").forEach((b, i) => {
    const solo = isSoloPlay(i);
    b.classList.toggle("on", solo);
    b.setAttribute("aria-pressed", String(solo));
    b.title = i18n.t(solo ? "tracks.soloPlayOnHint" : "tracks.soloPlayOffHint",
      { track: i18n.trackName(i) });
  });
  document.querySelectorAll("#tabs .tab:not(.add)").forEach((t, i) => {
    t.classList.toggle("muted", muted[i]);
    t.title = tabTitle(i);
  });
}

/** 切換某一軌的靜音。播放中按也馬上生效（見 engine.setChannelMute）。 */
export function toggleMute(i) {
  if (!Number.isInteger(i) || i < 0 || i >= MAX_TRACKS) return;
  muted[i] = !muted[i];
  // 刻卜意不 persist()（靜音不進暫存，見 muted）也不記一步 undo —— 同樂器選擇的慣例。
  syncMutes();
  onMute();
}

/** 套用一組靜音旗標。只寫狀態，畫面交給呼叫端統一 syncMutes()。 */
function setMuted(list) {
  for (let i = 0; i < MAX_TRACKS; i++) muted[i] = !!list?.[i];
}

/**
 * 這一軌現在是不是「只聽這一份」—— 只有它沒被靜音，其他開著的全靜音。
 *
 * **推導出來的，不存欄位**：存一個「第幾軌在 solo」就得回答重整、拖曳重排、刪中間
 * 一軌、solo 期間手動按靜音這四件事，每一條都會靜默對不上。`i` 自己**必須沒被靜音**
 * —— 全部靜音時不算 solo，那時這顆的下一下要是「全部解除」。
 */
const isSoloPlay = i =>
  !muted[i] && muted.every((m, j) => j === i || j >= count || m);

/**
 * 只聽這一份 ⇄ 全部解除靜音。
 *
 * 已經在只聽它 → 全部解除；否則 → 只留這一份（**含把自己解除** —— 不然 solo 一個
 * 已經靜音的軌會得到一片安靜）。回程是**全部解除**而不是「還原到 solo 之前」：
 * 後者要存一份得跟著拖曳重排搬、在刪軌後重新對位的快照。
 */
export function soloPlay(i) {
  if (!Number.isInteger(i) || i < 0 || i >= MAX_TRACKS) return;
  const solo = isSoloPlay(i);
  // **只動看得到的那幾軌**（`j < count`）。後面那些是 addTrack 的庫存，在這裡順手
  // 靜音會變戈成「按＋新增冒出一個一開就靜音的軌」。
  for (let j = 0; j < count; j++) muted[j] = !solo && j !== i;
  syncMutes();
  onMute();
}

// ─── 顯示：ghost ────────────────────────────────────────────────────────────

/** 給捲軸用的一份複本。**這是這個陣列唯一的對外出口。** */
export const ghostFlags = () => [...ghost];

/**
 * 把顯示狀態畫出來。跟 syncMutes 同構，**兩個地方都要**：panebar 的眼睛鈕與分頁上的
 * 空心圓點（隱藏是**會被忘記**的狀態）。**空心圓點以前是靜音的標記，現在是隱藏的
 * 標記** —— 靜音還有軌名刪除線。分頁那一邊照樣只改**視覺屬性**（理由見 syncMutes）。
 */
export function syncGhosts() {
  document.querySelectorAll(".pane .trk-ghost").forEach((b, i) => {
    const shown = ghost[i];
    // `.on` 是「這顆按鈕是按下去的狀態」，而按下去 = 隱藏 —— 所以是 `!shown`。
    b.classList.toggle("on", !shown);
    b.setAttribute("aria-pressed", String(!shown));
    b.title = i18n.t(shown ? "tracks.ghostOffHint" : "tracks.ghostOnHint",
      { track: i18n.trackName(i) });
    b.firstElementChild.className = shown ? "fa-solid fa-eye" : "fa-solid fa-eye-slash";
  });
  document.querySelectorAll(".pane .trk-solo").forEach((b, i) => {
    const solo = isSolo(i);
    b.classList.toggle("on", solo);
    b.setAttribute("aria-pressed", String(solo));
    b.title = i18n.t(solo ? "tracks.soloOnHint" : "tracks.soloOffHint",
      { track: i18n.trackName(i) });
  });
  document.querySelectorAll("#tabs .tab:not(.add) i").forEach((dot, i) => {
    dot.classList.toggle("off", !ghost[i]);
    dot.title = i18n.t("tracks.ghostHint");
  });
}

/**
 * 切這一軌竹的顯示開關（鋼琴捲軸上要不要畫它）。
 * **刻意不記 undo、也不重新解析**（不是內容），但**要進暫存**（見 ghost 的說明）。
 */
export function toggleGhost(i) {
  if (!Number.isInteger(i) || i < 0 || i >= MAX_TRACKS) return;
  ghost[i] = !ghost[i];
  syncGhosts();
  persist();
  onSelect(active);   // 捲軸重畫（不需要重新解析）
}

/** 這一軌現在是不是「獨看」—— 只有它在畫，其他開著的全關。推導，理由同 isSoloPlay。 */
const isSolo = i =>
  ghost[i] && ghost.every((g, j) => j === i || j >= count || !g);

/** 只看這一份 ⇄ 全開。回程是全開而不是還原，理由同 soloPlay。 */
export function soloGhost(i) {
  if (!Number.isInteger(i) || i < 0 || i >= MAX_TRACKS) return;
  const solo = isSolo(i);
  for (let j = 0; j < count; j++) ghost[j] = solo || j === i;
  syncGhosts();
  persist();
  onSelect(active);
}

/** 套用一組顯示旗標。只寫狀態，畫面交給呼叫端（同 setMuted）。 */
function setGhosts(list) {
  for (let i = 0; i < MAX_TRACKS; i++) ghost[i] = list?.[i] !== false;
}

/**
 * 整批套用壓縮模式（暫存接回、快照復原、開存檔）。
 * **認不得的值一律當 null** —— 外面來的資料只有這一個安全的預設。
 */
function setZip_all(list) {
  for (let i = 0; i < MAX_TRACKS; i++)
    zip[i] = list?.[i] === ZIP_LOSSLESS ? ZIP_LOSSLESS : null;
}

/**
 * 解除某個區日間的靜音。半開區間，跟 `resetInstruments` 同形、掛在同樣的呼叫點、
 * 傳同樣的區間 —— 那個對稱是刻意的，兩者要一起讀。
 *
 * **整批取代（貼上、載入分享、清空所有音符、匯入取代）全部解除**（症狀是「新貼進來
 * 的譜少一個聲部」）；**追加採譜只解除新加入的那幾軌**（前面那些不是殘留）。
 *
 * @returns {boolean} 有沒有真的動到
 */
export function resetMutes(from = 0, to = MAX_TRACKS) {
  let changed = false;
  for (let i = Math.max(0, from); i < Math.min(MAX_TRACKS, to); i++) {
    if (muted[i]) { muted[i] = false; changed = true; }
  }
  if (changed) { syncMutes(); onMute(); }
  return changed;
}

// ─── 整批換內容（貼上、回復範例） ───────────────────────────────────────────

/**
 * 一次寫滿所有分頁，少的補空白、長的截掉。
 *
 * `from > 0` 是**追加**：從第 from 軌開始寫，前面那幾軌原封不動（「追加採譜」）。
 * from = 0（預設）**清空全部 15 軌再寫**，不然上一首歌會留在輔助軌裡。
 */
export function setTexts(parts, from = 0) {
  const a = areas();
  for (let i = Math.max(0, from); i < MAX_TRACKS; i++) {
    a[i].value = cap(parts[i - from]);
    //  **換掉內容就退出壓縮模式**，範圍跟寫進去的範圍一模一樣（追加採譜時前面那幾軌
    // 原封不動，它們的模式也該原封不動）。清在這裡而不是在五個呼叫端，是因為壓縮模式
    // 講的就是「這一軌的文字」—— 文字整個被換掉，那個意圖必然過期。
    zip[i] = null;
  }
}

/**
 * 重設軌數並切到某一軌。`to` 預設是第一軌；追加採譜會傳「第一個新加入的軌」——
 * 跳回第 1 軌會讓使用者以為什麼事都水沒發生。
 */
export function reset(n, to = 0) {
  count = clamp(n, MIN_TRACKS, MAX_TRACKS);
  active = clamp(to, 0, count - 1);
  syncTabs();
  persist();
}

/**
 * 最後一個有內容的分頁的**下一個**位置 —— 追加採譜要從這裡開始寫。
 * **中間的空軌原地保留**（回傳的是最後一個有內容的位置 + 1，不是空位的數量）：
 * 砍中間會讓後面幾軌的位置整個位移，而位置就是身分。
 */
export function appendAt() {
  const a = areas();
  let last = -1;
  for (let i = 0; i < MAX_TRACKS; i++) if (bareTrack(a[i].value)) last = i;
  return last + 1;
}

// ─── 樂器下拉 ───────────────────────────────────────────────────────────────

export function enableInstruments() {
  for (const sel of selects()) sel.disabled = false;
}

/**
 * 貼上／載入分享時，MML 裡帶的 `@n`（MIDI program）。不能馬上套用：下拉的選項要等
 * 音色庫載完才存在，而匯入通常發生在那之前（開站順序是 ui.init → 匯入 →
 * engine.boot → 載音色庫 → fillInstruments）。
 */
const wantProg = Array(MAX_TRACKS).fill(null);
let presetList = [];       // fillInstruments 最後一次拿到的清單
let progNames = new Map(); // 0-based program → 顯示名稱（跟下拉的 dataset.name 同一份）

/**
 * 一個 0-based program 的顯示名稱。查不到回空字串。
 *
 * 給**還沒進到分頁**的東西用（目前是匯入清單，它要在按下匯入**之前**就說出「這一軌
 * 是魯特」，而下拉的 dataset.name 要先有一個選好的分頁）。弓名字來源刻意跟分頁標籤相同。
 */
export const programName = prog => progNames.get(prog) ?? "";

/** MML 帶了 `@n`：等下拉有選項時把它對回去。 */
export function requestProgram(ch, program) {
  if (ch >= 0 && ch < MAX_TRACKS && Number.isInteger(program)) wantProg[ch] = program;
}

/**
 * 把等待中的 `@n` 對回下拉。音色庫還沒載完就先擱著，fillInstruments 會再叫一次。
 * 只比對 program，不比 msb/lsb —— `@n` 帶不動那兩個值。對不到就**不動也不報錯**：
 * 對方用的音色庫這裡沒有，是常態不是錯誤。
 */
export function applyPrograms() {
  if (!presetList.length) return false;
  let changed = false;
  for (let i = 0; i < MAX_TRACKS; i++) {
    const want = wantProg[i];
    if (want === null) continue;
    wantProg[i] = null;                   // 只套一次，之後換音色庫不再重來
    const hit = presetList.find(p => p.program === want);
    if (!hit) continue;
    const v = JSON.stringify([hit.bankMSB, hit.bankLSB, hit.program]);
    picked[i] = v;
    const sel = selects()[i];
    if (sel && [...sel.options].some(o => o.value === v)) sel.value = v;
    changed = true;
  }
  // 這裡要 persist（跟 fillInstruments 相反）：這是使月用者的動作造成的選擇改變，
  // 不寫進暫存的話重整一次樂器就跳回舊的。
  if (changed) { syncTabLabels(); persist(); }
  return changed;
}

/** 重畫所有分頁的樂器下拉。presets 已經篩好、排好了。 */
export function fillInstruments(presets, defMap, defNames) {
  presetList = presets ?? [];
  // 建在 selects 迴圈**外面**：這張表跟軌無關，放進去只會為 15 軌各重算一次。
  progNames = new Map(presetList.map(p => [p.program, presetName(p, defMap, defNames)]));
  for (const [i, sel] of selects().entries()) {
    if (!presets.length) { sel.innerHTML = `<option>${i18n.t("tracks.bankEmpty")}</option>`; continue; }

    const keep = picked[i];
    sel.innerHTML = "";
    for (const p of presets) {
      const o = document.createElement("option");
      o.textContent = presetLabel(p, defMap, defNames);
      o.dataset.name = presetName(p, defMap, defNames);   // 分頁標籤用的，不含編號
      o.value = JSON.stringify([p.bankMSB, p.bankLSB, p.program]);
      sel.appendChild(o);
    }
    // 換音色庫（或載入 .def 重畫、或從暫存接回來）時盡量保住原本選的那個
    sel.value = [...sel.options].some(o => o.value === keep) ? keep : sel.options[0].value;
    picked[i] = sel.value;
  }
  syncTabLabels();
  // 這裡刻意不 persist()：載音色庫日是開站就會發生的事，寫進去會讓首次造訪就產生暫存、
  // 把「已接回上次的樂譜」那行提示蓋掉；而臨時載入別的音色庫時 keep 比不到會退回第
  // 一項，那時也不該把使用者原本選的那個從暫存裡抹掉。

  // 選項現在才存在，所以擱著的 @n 要在這裡才對得回去
  applyPrograms();
}

/**
 * 把樂器下拉設回預設。`from` / `to` 是半開區間，預設是全部。
 *
 * **匯入 MIDI 之後是全部重設，而不是照 MIDI 的 Program Change 設**：Fury 音色包不是
 * GM 排序的（Harp 在 024、Music Box 在 029、Xylophone 在 077，GM 分別是 046、010、
 * 013），拿 MIDI 的 program 去對一定對到無關的音色。同時清掉 wantProg —— 擱著的
 * `@n` 不該在匯入之後才突然套上去。
 *
 * **追加採譜只重設新加入的那幾軌**（前面那些不是殘留），但新加入的軌位可能留著更早
 * 以前的選擇，那個還是要重設。
 */
export function resetInstruments(from = 0, to = MAX_TRACKS) {
  for (const [i, sel] of selects().entries()) {
    if (i < from || i >= to) continue;
    wantProg[i] = null;
    if (!sel?.options.length) continue;
    sel.value = sel.options[0].value;
    picked[i] = sel.value;
  }
  syncTabLabels();
  persist();
}

/** 某一軌選到的 [msb, lsb, program]。沒選過或壞掉回 null。 */
export function presetOf(ch) {
  const raw = picked[ch];
  if (!raw) return null;
  try { return JSON.parse(raw); } catch { return null; }
}

/** 各軌的 program，存 MIDI 用。水沒選過就 0。 */
export const programs = () =>
  Array.from({ length: MAX_TRACKS }, (_, ch) => presetOf(ch)?.[2] ?? 0);

/**
 * 各分頁自己的音符數與字數，顯示在該頁的樂器列右邊。到遊戲上限就變紅。
 * 字數算的是匯出後的長度（不含空白），那才是遊戲會拒絕的那個數字。
 */
export function setNoteCounts(counts) {
  const a = areas();
  document.querySelectorAll(".pane .meta").forEach((m, i) => {
    if (i >= count) { m.replaceChildren(); m.classList.remove("full"); m.title = ""; return; }
    const len = effectiveLength(a[i].value);
    //  壓縮模式的標記排在字數前面。**用節點而不是 innerHTML** —— 這一格的內容全部來自
    // 語言檔，而語言檔裡有帶 HTML 的句子；這裡一旦開了 innerHTML，之後有人把 counter
    // 換成帶標籤的字串，就會靜默地把一個顯示欄位變成注入面。
    //
    //  它是**純標示不是按鈕**：關掉壓縮模式在優化框裡（那一格本來就是死的），這裡做成可點
    // 的話要多處理鍵盤焦點與 aria，而樂器列右邊這個位置太小、誤觸的代價是整軌被解壓。
    m.replaceChildren();
    if (zip[i]) {
      const z = document.createElement("i");
      z.className = "zip fa-solid fa-compress";
      z.title = i18n.t("tracks.zipLossless");
      z.setAttribute("role", "img");
      z.setAttribute("aria-label", i18n.t("tracks.zipLossless"));
      m.appendChild(z);
    }
    m.appendChild(document.createTextNode(i18n.t("tracks.counter",
      { notes: counts[i] ?? 0, len, max: MAX_TRACK_CHARS })));
    m.title = len > MAX_TRACK_CHARS
      ? i18n.t("tracks.overLimit", { n: len - MAX_TRACK_CHARS })
      : i18n.t("tracks.counterHint");
    m.classList.toggle("full", len > MAX_TRACK_CHARS);
  });
}
