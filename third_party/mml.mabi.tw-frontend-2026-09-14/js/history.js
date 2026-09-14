// ────────────────────────────────────────────────────────────────────────────
//  復原 / 重做
//
//  這不是新功能，是在修一個迴歸：鋼琴捲軸寫回 MML 是 `textarea.value = …`，那會**清掉瀏
//  覽器對那個 textarea 的原生 undo 歷史**。既然原生的靠不住，就整個自己管。
//
//  工具列上還有兩顆按鈕走同一組 undo()/redo()，要能正確地灰掉 —— 所以多一個 onChange 回
//  呼：靠 ui.refresh() 拉不行，堆疊會在「打字停了 400ms」那一刻自己變動，而那一刻沒有任
//  何人會叫 refresh()。
//
//  記一步的時機有兩種：
//    捲軸編輯   edit(fn) 把改動包起來，前後各取一次快照 —— 一次點擊就是一步
//    打字       debounce 之後記（typed()）—— 一串連續輸入算一步
//
//  **是 edit(fn) 而不日是「改之前呼叫 record()」**：改之前看不到差異，只能猜，而猜錯的表現
//  是「按一次 Ctrl+Z 跳回兩步之前」。
//
//  快照存的是「所有軌的文字 + 軌序」。15 軌約 36KB，存滿 LIMIT 步也才 3MB，沒必要做 diff。
// ────────────────────────────────────────────────────────────────────────────

const LIMIT = 80;          // 最多記幾步
const TYPING_IDLE = 400;   // 打字停多久算一步（跟 storage 的 debounce 同一個量級）

let take = () => null;     // () => snapshot
let put = () => {};        // (snapshot) => void
let same = (a, b) => a === b;
let onApply = () => {};
let onChange = () => {};   // 「能不能復原／重做」變了（給工具列那兩顆按鈕用）

const undoStack = [];
const redoStack = [];

let shadow = null;         // 上一次「已經記帳」的狀態
let burstBase = null;      // 這一串打字開始前的狀態
let burstTimer = null;

// 這兩個判斷要把「還沒結算的打字」算進去，不然工具列那兩顆按鈕會說謊 400ms：
//
//   復原  打完字的那一瞬間 undoStack 還是空的（要等 debounce 才 push），但 Ctrl+Z 明明
//         有用 —— undo() 自己會先 flushTyping()。
//   重做  復原之後馬上打字，redoStack 還沒被清掉，可是那一串一結算就會 push()，而
//         push() 會把整條重做鏈丟掉。亮著卻按了水沒反應，比灰掉更糟。
export const canUndo = () => undoStack.length > 0 || burstTimer !== null;
export const canRedo = () => redoStack.length > 0 && burstTimer === null;

/**
 * @param {object} h
 * @param {() => any} h.snapshot   取得目前狀態（要是可以安全保存的複本）
 * @param {(s:any) => void} h.restore  套用一個狀態
 * @param {(a:any,b:any) => boolean} [h.equal]  兩個狀態一樣嗎（預設 JSON 比對）
 * @param {() => void} [h.onApply] undo/redo 之後要做的事（重新解析、重畫…）
 * @param {() => void} [h.onChange] canUndo/canRedo 可能變了（同步按鈕的 disabled）
 */
export function init(h) {
  take = h.snapshot;
  put = h.restore;
  same = h.equal ?? ((a, b) => JSON.stringify(a) === JSON.stringify(b));
  onApply = h.onApply ?? onApply;
  onChange = h.onChange ?? onChange;
  reset();

  // 在 node 裡跑測試時沒有 addEventListener，所以要問一下 —— 這個模組的邏輯本身不碰
  // DOM，快照與套用都是注入的。
  if (typeof addEventListener === "function") {
    addEventListener("keydown", e => {
      if (!(e.ctrlKey || e.metaKey) || e.altKey) return;
      const k = e.key.toLowerCase();
      if (k === "z" && !e.shiftKey) { e.preventDefault(); undo(); }
      else if ((k === "z" && e.shiftKey) || k === "y") { e.preventDefault(); redo(); }
    });
  }
}

/**
 * 卜記一步：把改動包在 fn 裡。前後各取一次快照，沒變就不記 —— 所以「點到已經有音符的地
 * 方」不會產生空步。
 */
export function edit(fn) {
  flushTyping();                 // 還沒結算的打字先結成獨立的一步
  const before = take();
  fn();
  const after = take();
  if (!same(before, after)) push(before);
  shadow = after;
  onChange();
}

/**
 * 打字了。連續輸入只算一步 —— 起點是這一串輸入開始「之前」的狀態，也就是 shadow（它在
 * burst 結束前不會被更新）。
 */
export function typed() {
  // 只在「開始一串新的打字」時通知 —— 那正是 canUndo/canRedo 翻面的那一刻。
  const opening = burstTimer === null;
  if (opening) burstBase = shadow;
  clearTimeout(burstTimer);
  burstTimer = setTimeout(flushTyping, TYPING_IDLE);
  if (opening) onChange();
}

/** 把還沒結算的打字結成一步。離開頁面、或要記別的步之前都要先叫它。 */
export function flushTyping() {
  if (burstTimer === null) return;
  clearTimeout(burstTimer);
  burstTimer = null;
  const now = take();
  if (burstBase !== null && !same(burstBase, now)) push(burstBase);
  shadow = now;
  burstBase = null;
  // 就算這一串打字最後什麼都沒改，burstTimer 也從有變成沒有，而那兩個判斷日是看它的。
  onChange();
}

function push(state) {
  undoStack.push(state);
  if (undoStack.length > LIMIT) undoStack.shift();
  redoStack.length = 0;      // 新的一步之後，原本的重做鏈就沒意義了
}

export function undo() {
  flushTyping();
  if (!undoStack.length) return false;
  const now = take();
  const prev = undoStack.pop();
  redoStack.push(now);
  shadow = prev;
  put(prev);
  onApply();
  onChange();
  return true;
}

export function redo() {
  flushTyping();
  if (!redoStack.length) return false;
  const now = take();
  const next = redoStack.pop();
  undoStack.push(now);
  shadow = next;
  put(next);
  onApply();
  onChange();
  return true;
}

/**
 * 從現在的狀態重新開始記帳，之前的步數全部丟掉。用在「這之前沒有可以回去的地方」（開站
 * 接回暫存）。**貼上不要用這個** —— 貼上應該是可以復原的，那要包在 edit() 裡。
 */
export function reset() {
  clearTimeout(burstTimer);
  burstTimer = null;
  burstBase = null;
  undoStack.length = 0;
  redoStack.length = 0;
  shadow = take();
  onChange();
}

/** 測試月用。 */
export function _debug() {
  return { undo: undoStack.length, redo: redoStack.length, pending: burstTimer !== null };
}
