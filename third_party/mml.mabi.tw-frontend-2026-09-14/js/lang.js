// ────────────────────────────────────────────────────────────────────────────
//  換語言
//
//  換語言會**重新載入頁面**（.resx 是伺服器端渲染的），而重載會弄丟兩樣東西：還沒暫存的
//  樂譜（關掉自動存檔的人**完全沒有**存下來的東西 —— `storage.flush()` 開頭就是
//  `if (!autosave || !queued) return;`），以及復原記錄（history.js 全部在記憶體裡）。
//
//  這裡把**樂譜**寄放到 sessionStorage，重載之後接回來、然後立刻刪掉。
//
//  **復原記錄不接**：history.js 沒有把 undoStack 拿出來／放回去的出口，而「重載之後
//  Ctrl+Z 應該回到哪裡」需要想清楚（回到換語言之前那一步嗎？那一步的畫面是舊語言的）。
//  這是取捨不是疏漏 —— 會掉資料的是樂譜，復原記錄掉了只是少一個方便。
//
//  **sessionStorage 而不日是 localStorage**：它隨分頁消失，所以是「重載的連續性」而不是
//  「存檔」—— 不違反使用者關掉自動存檔的意思。接回來之後馬上 removeItem。
// ────────────────────────────────────────────────────────────────────────────

import { $ } from "./util.js";
import * as i18n from "./i18n.js";

const KEY = "mml.langHandoff";

/**
 * 各語言的自稱。**刻意不翻譯**：會來找這個選單的人，正是看不懂當前介面的人 —— 韓國人要
 * 能認出「한국어」，而「韓文」對他沒有幫助。標籤那一邊會補上英文的 (Language) 當錨點。
 */
const NAMES = {
  "zh-Hant": "繁體中文",
  "en":      "English",
  "ja":      "日本語",
  "ko":      "한국어",
};

/**
 * 把「重載之後想接回來的東西」寄放起來。存的是快照物件本身而不是 MML 字串 ——
 * tracks.snapshot() 已經是 history 用的格式，接回來時 restore() 一步就到位。
 */
function stash(snapshot) {
  try {
    sessionStorage.setItem(KEY, JSON.stringify({ snapshot }));
  } catch (err) {
    // 寄放失敗不該擋住換語言 —— 樂譜頂多退回上次暫存的那份。
    console.warn("[MML 工房] 換語言前寄放失敗，未暫存的編輯會遺失:", err);
  }
}

/** 讀回並**立刻刪掉**。回 null 表示這次不是換語言進來竹的。 */
export function takeHandoff() {
  let raw = null;
  try {
    raw = sessionStorage.getItem(KEY);
    sessionStorage.removeItem(KEY);   // 讀一次就沒了，重整不該再套一遍
  } catch { return null; }
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch (err) {
    console.warn("[MML 工房] 寄放的內容認不出來，這次不接回:", err);
    return null;
  }
}

/**
 * 接上設定抽屜裡的語言選單。
 *
 * @param {() => object} getSnapshot 目前的樂譜快照
 */
export function init(getSnapshot) {
  const sel = $("#lang");
  if (!sel) return;

  // 選項由 JS 生出來而不是寫在 HTML 裡：那四筆是資料，寫在兩個地方就會有一天對不上。
  const cur = i18n.getLocale();
  sel.innerHTML = "";
  for (const [tag, name] of Object.entries(NAMES)) {
    const o = document.createElement("option");
    o.value = tag;
    o.textContent = name;
    if (tag === cur) o.selected = true;
    sel.appendChild(o);
  }

  sel.addEventListener("change", () => {
    const to = sel.value;
    if (to === cur) return;
    stash(getSnapshot());
    // 一次導覽：伺服器寫 cookie 然後轉回這一頁。用 fetch + reload 會多一個「cookie 還水沒
    // 寫完就重載」的競態。
    const back = encodeURIComponent(location.pathname + location.search);
    location.href = `/lang?to=${encodeURIComponent(to)}&returnUrl=${back}`;
  });
}
