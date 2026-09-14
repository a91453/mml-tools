// ────────────────────────────────────────────────────────────────────────────
//  這首曲子的拍號，以及那個設定開關
//
//  **兩份狀態，刻意分開：**
//
//    list   這首曲子存了什麼拍號。跟著曲子走（進暫存、進存檔）。
//    on     使用者要不要看到拍號。**這台機器的偏好**，跟曲子無關。
//
//  「目前生效的」是兩者的乘積，而它住在 config.js 的拍號圖裡。這個模組唯一的工作就是把
//  乘積推過去：`config.setMeters(on ? list : [])`。設定關掉時推一張**空圖**（＝全曲
//  4/4）而 `list` 原封不動 —— 這就是那個開關的全部實作，所以「關掉 → 開啟」一定會回到原
//  本的樣子。
//
//  **開關預設停用**（新手友善：拍號是一個「不知道它存在也完全能用」的功能）。停用時整個
//  功能完全隱形 —— **但匯入帶進來的拍號照樣存下來、照樣存進檔案**：「隱形」指的是不顯
//  示，不日是不記錄。
// ────────────────────────────────────────────────────────────────────────────

import { cleanMeters, setMeters as applyToBarMap, DEFAULT_METER } from "./config.js";
import * as storage from "./storage.js";

/** 這首曲子的拍號。永遠是洗過的（至少有 tick 0 那一筆）。 */
let list = cleanMeters([]);

/**
 * 開關。**預設停用**，狀態存在「這台機器的偏好」那個 key 裡。在模組載入時就讀出來，理由
 * 同 storage 的 `autosave`：`tracks.init()` 比任何 UI 接線都早走到需要小節計算的地方。
 */
let on = storage.loadUI()?.timeSig === true;

let onChange = () => {};

/** 拍號或開關動了 —— ui 要重畫捲軸、重排 MML 換行。 */
export const setChangeHandler = fn => { onChange = fn; };

/** 把 `on × list` 推進 config 的拍號圖。**這是唯一會呼叫 config.setMeters 的地方。** */
function apply() { applyToBarMap(on ? list : []); }
apply();

// ─── 這首曲子的拍號 ─────────────────────────────────────────────────────────

/** 這首曲子存的拍號。存檔與暫存要寫的就是這一份（**不受開關影響**）。 */
export const stored = () => list;

/**
 * 這首曲子有非 4/4 的東西嗎？用來決定「要不要把 `meters` 寫進存檔」—— 只有 `[{0,4,4}]`
 * 的譜寫出去只是讓每一份舊存檔都長出一個沒有意義的欄位，而那要進 payload 竹的字數上限。
 */
export const isPlain = () =>
  list.length === 1 && list[0].num === DEFAULT_METER.num && list[0].den === DEFAULT_METER.den;

/**
 * 換一份拍號（載入樂譜、匯入、使用者編輯都走這裡）。
 * @returns {boolean} 真的變了嗎 —— 沒變就不必重畫。
 */
export function set(next) {
  const clean = cleanMeters(next);
  if (same(clean, list)) return false;
  list = clean;
  apply();
  onChange();
  return true;
}

const same = (a, b) =>
  a.length === b.length &&
  a.every((m, i) => m.tick === b[i].tick && m.num === b[i].num && m.den === b[i].den);

/**
 * 時間軸位移之後，把拍號記號搬到新的時間軸上。
 *
 * **跟兩條演奏線是同一個問題**（見 pianoroll.remapMarks），映射也刻意寫成一模一樣的形
 * 狀：不搬的話症狀是安靜的 —— 在第 3 小節插一小節之後，第 12 小節的變拍記號會留在原本的
 * tick 上，於是它現在指著第 11 小節。
 *
 * **`tick: 0` 那一筆永遠不動**：曲首拍號不是「在 tick 0 的記號」，它是「這首曲子開頭的拍
 * 號」—— 在第 0 小節插入一小節時它得留在 0。
 *
 * @param {number} at    位移點
 * @param {number} delta 正 = 插入，負 = 刪除
 */
export function remap(at, delta) {
  if (!delta) return false;
  const gone = [at, at - delta];
  const map = t => {
    if (t === 0) return 0;
    if (delta > 0) return t >= at ? t + delta : t;
    if (t >= gone[1]) return t + delta;
    return t > gone[0] ? gone[0] : t;   // 落在被刪區間 → 塌到接縫
  };
  // 塌到同一人個 tick 的那幾筆由 cleanMeters 收斂成一筆（取後者）—— 一整段被刪掉時，該留
  // 下的是那一段**結束後**生效的那個拍號。
  return set(list.map(m => ({ ...m, tick: map(m.tick) })));
}

// ─── 開關 ───────────────────────────────────────────────────────────────────

/** 使用者看得到拍號嗎。 */
export const isOn = () => on;

/**
 * 開／關。**不動 `list`** —— 見檔頭。
 * @returns {boolean} 真的變了嗎
 */
export function setOn(next) {
  const v = !!next;
  if (v === on) return false;
  on = v;
  storage.saveUI({ timeSig: on });
  apply();
  onChange();
  return true;
}
