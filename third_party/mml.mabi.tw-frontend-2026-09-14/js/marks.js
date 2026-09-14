// ────────────────────────────────────────────────────────────────────────────
//  段落標記：這首曲子的路標
//
//  「前奏 / A段 / 副歌」。**對聲音零影響** —— MML 裡寫不下它（同拍號）。
//
//  形狀刻意跟 meters.js 平行（`stored()` / `set()` / `remap()`），但少了一半：
//
//    · **沒有設定開關。** 拍號需要開關是因為它會改變小節線、插刪小節、MML 換行；標記是
//      純加法的（沒有標記的譜畫面上一個像素都不會變）。
//    · **沒有 apply()。** 拍號要推進 config 的拍號圖，標記不改變任何計算。
//    · **tick 0 那一筆會跟著位移** —— 拍號的 tick 0 是「曲首拍號」，是曲子的屬性；標記
//      的 tick 0 只是「在第 1 小節的一個路標」。**這是兩者唯一語意相反的地方**，見 remap。
//
//  **顏色不在卜這裡**：由「照 tick 排序後的第幾個」算出來（`config.markColor`）。
// ────────────────────────────────────────────────────────────────────────────

import { cleanMarks, MAX_MARKS } from "./config.js";

/** 這首曲子的標記。永遠是洗過的（照 tick 排序、最多 MAX_MARKS 筆）。 */
let list = [];

let onChange = () => {};

/** 標記動了 —— ui 要重畫膠囊與總覽尺。 */
export const setChangeHandler = fn => { onChange = fn; };

/** 這首曲子的標記。存檔與暫存要寫的就是這一份。 */
export const stored = () => list;

/** 滿了嗎。選單那一列要據此灰掉並說明原因。 */
export const isFull = () => list.length >= MAX_MARKS;

/** 這個 tick **正好**有標記嗎？有就回它。 */
export const at = tick => list.find(m => m.tick === tick) ?? null;

/**
 * 換一份標記（載入樂譜、匯入、使用者編輯都走這裡）。
 * @returns {boolean} 真的變了嗎 —— 沒變就不必重畫。
 */
export function set(next) {
  const clean = cleanMarks(next);
  if (same(clean, list)) return false;
  list = clean;
  onChange();
  return true;
}

const same = (a, b) =>
  a.length === b.length && a.every((m, i) => m.tick === b[i].tick && m.text === b[i].text);

/**
 * 加一個，或改掉這個 tick 上原本那一個。兩者走同一個函式，因為差別只有「這個 tick 上有水沒
 * 有東西」，而 `cleanMarks` 的「同 tick 取後者」本來就會處理掉。呼叫端的 UI 仍然分得清楚
 * （小節尺只給「加入」，膠囊上才是「修改」）。
 *
 * @returns {boolean} 真的變了嗎
 */
export function put(tick, text) {
  // 滿了就不給加**新的**；改現有的那一個永遠可以（那不會讓數量變多）。
  if (isFull() && !at(tick)) return false;
  return set([...list.filter(m => m.tick !== tick), { tick, text }]);
}

/** 移除一個。 */
export const remove = tick => set(list.filter(m => m.tick !== tick));

/**
 * 時間軸位移之後，把標記搬到新的時間軸上。跟兩條演奏線、跟拍號是同一個問題（見
 * pianoroll.remapMarks），映射也刻意寫成一樣的形狀 —— 不搬的話症狀是安靜的。
 *
 * **tick 0 那一筆會動**，這一點跟 `meters.remap` 相反：標記只是一個路標，在它前面插一小
 * 節時它該跟著音樂走。
 *
 * @param {number} at    位移點
 * @param {number} delta 正 = 插入，負 = 刪除
 */
export function remap(at, delta) {
  if (!delta) return false;
  const gone = [at, at - delta];
  const map = t => {
    if (delta > 0) return t >= at ? t + delta : t;
    if (t >= gone[1]) return t + delta;
    return t > gone[0] ? gone[0] : t;   // 落在被刪區間 → 塌到接縫
  };
  // 塌到同一個 tick 的那幾筆由 cleanMarks 收斂成一筆（取後者）—— 一整段被刪掉時，該留下
  // 的是那一段**結束後**的那個標卜記。
  return set(list.map(m => ({ ...m, tick: map(m.tick) })));
}
