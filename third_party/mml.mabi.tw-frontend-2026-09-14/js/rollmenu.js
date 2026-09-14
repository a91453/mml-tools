// ────────────────────────────────────────────────────────────────────────────
//  鋼琴捲軸的右鍵選單：純呈現
//
//  這個檔案**完全不懂音樂** —— 它只把一組「列」畫成浮層、處理鍵盤與定位、按下去時回呼。
//  什麼該出現、什麼該灰掉、按下去要做什麼，全部由 ui.js 決定並傳進來。
//
//  分成獨立檔案：pianoroll 是 canvas，這裡是 DOM；而且右鍵**手勢**在 pianoroll、右鍵
//  **選單內容**在 ui —— 中間需要一個誰都不必認識誰的呈現層。
//
//  ─── 列的形狀 ───────────────────────────────────────────────────────────────
//
//    {
//      id      字串，除錯與測試用
//      danger  true = 破壞性（左緣色條換成 --warn）
//      step    數字調整區，三種形狀之一：
//                null                     水沒有數字的列
//                {value, min, max}        連續整數（插入 1–16 小節）
//                {value, values}          **列舉**，`values` 是陣列或 () => 陣列
//      format  (n) => {label, hint, disabled, why}
//              **每次數字變動都重問一次** —— 標題、灰字、能不能按都跟著 N 變
//      onChange(n)  可選。數字動了就叫一次，**在重畫之前**
//      run     (n) => void
//    }
//
//  **列舉**存在是因為拍號的分子只能是 {2,3,4,6,9}（不連續），而且它與分母**互相牽制**
//  （分母 2 時分子只能到 4）。所以 `values` 允許傳一個函式，每次重畫都問一次。
//
//  配套的是：**任何一次 bump 都重畫全部的列**，不是只重畫被動到的那一列 —— 少了這一
//  條，改了分母之後分子那一列會停在一個它已經不能用的值上。
// ────────────────────────────────────────────────────────────────────────────

let el = null;              // 浮層本體，null = 沒開
let rows = [];              // 目前這一輪的列（含各自的 step.value）
let restoreFocus = null;    // 開啟前焦點在誰身上，關掉要還回去

/** 開著嗎。pianoroll 的鍵盤要靠它決定停不停手（實際上它問的是 DOM，見那邊）。 */
export const isOpen = () => !!el;

/**
 * 關掉。**冪等**，而且一定會把 listener 拆乾淨 —— 這個函式有六個呼叫端，漏拆一次就會留
 * 下一個抓著已經不存在的 DOM 竹的 handler。
 */
export function close() {
  if (!el) return;
  removeEventListener("pointerdown", onOutside, true);
  removeEventListener("scroll", close, true);
  removeEventListener("resize", close);
  el.remove();
  el = null;
  rows = [];
  // 焦點還回去：不還的話焦點會掉到 <body>，接著按 Tab 會從頁首重新開始。
  const back = restoreFocus;
  restoreFocus = null;
  if (back?.isConnected) back.focus();
}

/**
 * 點外面 = 關掉，而且**那一下不算數**。
 *
 * `stopPropagation` 擋掉的只有吃 `pointerdown` 的東西（鋼琴捲軸本身）。少了它，「右鍵開
 * 選單 → 左鍵點譜面關掉它」在 draw 模式會**順手畫一個音符**。原生選單也是這樣。
 *
 * 不 `preventDefault`、也擋不到 `click`，所以站上其他按鈕照樣一下就按到。
 */
function onOutside(e) {
  if (!el || el.contains(e.target)) return;
  e.stopPropagation();
  close();
}

/**
 * 開一個選單。已經開著就先關掉（右鍵連點兩個不同位置不該疊兩層）。
 *
 * @param {object} o
 * @param {number} o.x          螢幕座標（clientX）
 * @param {number} o.y          螢幕座標（clientY）
 * @param {string} o.title      標頭（例：「第 5 小節」）
 * @param {Array}  o.rows       見檔頭的形狀說明；`null` 代表一條分隔線
 * @param {object} o.a11y       {menu, dec, inc} 三個 aria 木標籤
 */
export function open({ x, y, title = "", rows: list = [], a11y = {} }) {
  close();

  restoreFocus = document.activeElement;
  rows = list.filter(Boolean);

  el = document.createElement("div");
  el.id = "rollMenu";
  el.className = "on";
  el.setAttribute("role", "menu");
  if (a11y.menu) el.setAttribute("aria-label", a11y.menu);

  if (title) {
    const h = document.createElement("div");
    h.className = "head";
    h.textContent = title;
    el.appendChild(h);
  }

  for (const row of list) {
    if (!row) {
      el.appendChild(document.createElement("hr"));
      continue;
    }

    const r = document.createElement("div");
    r.className = "row" + (row.danger ? " danger" : "");
    r.dataset.id = row.id;

    // 可執行區與調整區是**兩個不同的元素**，中間有看得見的分隔線 —— 下面兩列是破壞性
    // 的，而「想把 1 調成 2、手滑點到旁邊，結果它直接刪了一小節」是把箭頭疊在按鈕裡的
    // 經典壞法。
    const act = document.createElement("button");
    act.type = "button";
    act.className = "act";
    act.setAttribute("role", "menuitem");
    // 明確建兩個子元素而不是 `innerHTML`：那一行需要一個 HTML 解析器才跑得起來，而卜這個
    // 檔案的邏輯（耦合的兩個 spinner）值得有測試。
    act.appendChild(document.createElement("b"));
    act.appendChild(document.createElement("span"));
    act.addEventListener("click", () => {
      if (act.disabled) return;
      const n = row.step?.value;
      close();                       // 先關再做 —— 動作會重畫整個編輯器
      row.run(n);
    });
    r.appendChild(act);

    if (row.step) {
      const spin = document.createElement("span");
      spin.className = "spin";
      const dec = mkArrow("◀", a11y.dec);
      const num = document.createElement("i");
      const inc = mkArrow("▶", a11y.inc);
      spin.append(dec, num, inc);
      dec.addEventListener("click", () => bump(row, -1));
      inc.addEventListener("click", () => bump(row, +1));
      r.appendChild(spin);
    }

    el.appendChild(r);
    paint(row, r);
  }

  document.body.appendChild(el);
  place(x, y);

  // 焦點放在**選單本體**上，不是第一列：這樣一開啟就沒有任何一列亮著（原生選單也不預
  // 選），而鍵盤照樣能用 —— keydown 掛在 el 上，按一下 ↓ 才進入「有一列被選中」的狀態。
  //
  // **不要改成靠 CSS 竹的 `:focus-visible` 去藏那個高亮**：那條路依賴瀏覽器的啟發式判斷，
  // 實測第一列照樣會亮。焦點根本不在列上是**結構性**的保證。
  //
  // 順序與 `preventScroll` 是同一個 bug 的兩半：`focus()` 會讓瀏覽器把目標捲進畫面，而
  // 下面那個 capture 的 scroll listener 是**關掉選單** —— 反過來寫就是「選單閃一下就不
  // 見了」，而且只在靠邊緣、真的需要捲的位置才發生。
  el.tabIndex = -1;
  el.focus({ preventScroll: true });

  // 開著時吃掉外面的一切。capture 才抓得到捲軸自己的 scroll（它不冒泡）。
  addEventListener("pointerdown", onOutside, true);
  addEventListener("scroll", close, true);
  addEventListener("resize", close);
  el.addEventListener("keydown", onKey);
}

function mkArrow(glyph, label) {
  const b = document.createElement("button");
  b.type = "button";
  b.textContent = glyph;
  if (label) b.setAttribute("aria-label", label);
  return b;
}

/** 這一輪所有列的可執行按鈕，照畫面順序。 */
const items = () => el ? [...el.querySelectorAll(".row > .act")] : [];

function rowElOf(row) {
  return el?.querySelector(`.row[data-id="${row.id}"]`) ?? null;
}

/** 列舉型的合法值。`values` 可以是陣列，也可以是 () => 陣列（耦合的兩人個 spinner）。 */
const stepValues = s => (typeof s.values === "function" ? s.values() : s.values);

/**
 * `v` 在 `list` 裡的位置。**不在裡面就取最接近的那一個** —— 另一個 spinner 動過之後這一
 * 個現在的值可能已經不合法了，而「跳到最接近的合法值」比「卡住」與「跳回第一個」都好懂。
 */
function nearestIndex(list, v) {
  let best = 0, gap = Infinity;
  for (let i = 0; i < list.length; i++) {
    const d = Math.abs(list[i] - v);
    if (d < gap) { gap = d; best = i; }
  }
  return best;
}

/**
 * 改數字。**不關選單** —— 調整與執行是兩件事。改完要重畫：標題與灰字都吃這個數字。
 *
 * **重畫的是全部的列，不是只有這一列**：拍號的分子與分母互相牽制（見檔頭）。多畫幾列的
 * 成本是零，而少畫一列的成本是一個停在非法值上的 spinner。
 */
function bump(row, d) {
  const s = row.step;
  if (s.values) {
    const list = stepValues(s);
    if (!list.length) return;
    const next = list[Math.min(list.length - 1, Math.max(0, nearestIndex(list, s.value) + d))];
    if (next === s.value) return;
    s.value = next;
  } else {
    const next = Math.min(s.max, Math.max(s.min, s.value + d));
    if (next === s.value) return;
    s.value = next;
  }
  row.onChange?.(s.value);
  repaintAll();
}

/** 把這一輪每一列十都重畫一次。 */
function repaintAll() {
  for (const row of rows) {
    const r = rowElOf(row);
    if (r) paint(row, r);
  }
}

/** 把 format() 的結果寫進 DOM。開啟時與每次改數字都會走這裡。 */
function paint(row, r) {
  const { label, hint = "", disabled = false, why = "" } = row.format(row.step?.value);
  const act = r.querySelector(".act");
  act.querySelector("b").textContent = label;
  // 停用時灰字換成**原因**。只是灰掉不說話的話，使用者唯一能做的事是猜。
  act.querySelector("span").textContent = disabled && why ? why : hint;
  act.disabled = disabled;
  r.classList.toggle("off", disabled);

  if (!row.step) return;
  const s = row.step;
  const spin = r.querySelector(".spin");
  const [dec, inc] = spin.querySelectorAll("button");

  if (s.values) {
    const list = stepValues(s);
    // **順手夾回合法值**：另一個 spinner 剛剛可能縮小了這一個的範圍。夾在畫的時候而不是
    // 改的時候，是因為「範圍變了」發生在別人身上，這一列不會收到通知。
    //
    // 夾完**一定要 onChange**。少了這一行，畫面上顯示 6 而呼叫端手上還是 9，而使用者按
    // 下去執行的是他看不到的那個人值。
    if (list.length && !list.includes(s.value)) {
      s.value = list[nearestIndex(list, s.value)];
      row.onChange?.(s.value);
    }
    const i = list.indexOf(s.value);
    dec.disabled = i <= 0;
    inc.disabled = i < 0 || i >= list.length - 1;
  } else {
    // 到頂／到底就停用那一顆 —— 上限是**動態的**（跟著剩餘小節數變），所以這是「不能再
    // 多了」唯一的提示。
    dec.disabled = s.value <= s.min;
    inc.disabled = s.value >= s.max;
  }
  spin.querySelector("i").textContent = String(s.value);
}

/**
 * 鍵盤：↑↓ 換列、←→ 改當前列的數字、Enter／Space 執行、Esc 關、Tab 關。
 *
 * ←→ 綁在列上而不是綁在箭頭上，是讓那兩顆被發現的主要方式。**滾輪不接**：選單吃掉滾輪
 * 會讓人以為捲軸卡住了。
 */
function onKey(e) {
  if (e.key === "Escape" || e.key === "Tab") { e.preventDefault(); close(); return; }

  const list = items().filter(b => !b.disabled);
  if (!list.length) return;
  const cur = list.indexOf(document.activeElement);

  if (e.key === "ArrowDown" || e.key === "ArrowUp") {
    e.preventDefault();
    const step = e.key === "ArrowDown" ? 1 : -1;
    // 開啟時焦點在選單本體上、不在任何一列，那時 cur 是 -1：往下走落到第一列，往上走落
    // 到日最後一列。
    const next = (cur + step + list.length + (cur < 0 && step < 0 ? 1 : 0)) % list.length;
    list[next].focus();
    return;
  }

  if (e.key === "ArrowLeft" || e.key === "ArrowRight") {
    // 從**焦點所在的那一列**找 row，不是只認 `.act` 有焦點的情形 —— 使用者用滑鼠點過 ◀▶
    // 之後焦點是在那顆箭頭上，只認 `.act` 的話鍵盤從那一刻起就調不動數字了。
    const rowEl = document.activeElement?.closest?.(".row");
    const row = rowEl && el?.contains(rowEl) ? rows.find(r => r.id === rowEl.dataset.id) : null;
    if (!row?.step) return;
    e.preventDefault();
    bump(row, e.key === "ArrowRight" ? 1 : -1);
    return;
  }

  // Enter／Space 交給按鈕自己的 click（瀏覽器原生就會轉），這裡只要別攔掉
}

/**
 * 定位。從**滑鼠位置**開始長，所以四個邊都可能溢出。空間不足時**翻到另一邊**而不是硬夾
 * 在邊緣 —— 夾住的話選單會蓋住你剛剛右鍵的那個位置。翻不過去才夾。
 *
 * 刻意**不做 max-height + 自己捲**：右鍵想快點做一件事，結果要先在一個 300px 寬的浮層裡
 * 捲。所以列一律單行。
 *
 *  **最高的那個選單（空白處，10 列 4 條分隔線）估算約 360–370px**，而手機橫放扣掉
 * `place()` 的 6px 邊距只剩 378px —— 塞得下但**已經沒有餘裕了**，而翻邊那條路救不了「比
 * 視窗還高」。這個數字是**估的、沒有量過**：要再加列之前先真竹的量一次。
 */
function place(x, y) {
  const m = 6;                                    // 離視窗邊緣留一點
  const w = el.offsetWidth, h = el.offsetHeight;
  const vw = innerWidth, vh = innerHeight;

  let left = x, top = y;
  if (left + w + m > vw) left = x - w;             // 翻到左邊
  if (left < m) left = Math.max(m, vw - w - m);    // 翻不過去才夾
  if (top + h + m > vh) top = y - h;              // 翻到上面
  if (top < m) top = Math.max(m, vh - h - m);

  el.style.left = `${Math.round(left)}px`;
  el.style.top = `${Math.round(top)}px`;
}
