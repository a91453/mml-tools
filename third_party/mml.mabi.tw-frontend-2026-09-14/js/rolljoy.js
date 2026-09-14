// ────────────────────────────────────────────────────────────────────────────
//  觸控用的虛擬遙桿面板：純呈現
//
//  這個檔案**完全不懂音樂** —— 它只把兩根桿子的推力翻成一串「往這個方向走幾 px」的回
//  呼。什麼叫一步、走了會發生什麼，全部在 pianoroll。分成獨立檔案的理由同 rollmenu.js：
//  pianoroll 是 canvas，這裡是 DOM。
//
//  存在的理由：手機上沒有方向鍵，也沒辦法「按住的同時做別的事」，而捲軸的微調正好掛在
//  「按住不放的那段期間」上。所以**粗調用手指直接拖，微調用桿子**。它同時是**音符選單
//  與刪除在手機上唯一的入口** —— 一根手指只有一個長按，而那個長按讓給了「拿起來搬」。
//
//  ─── 位置是方向鍵，長度是推桿 ───
//
//  **位置那一半曾經也是類比推桿，而且這裡曾經寫著「它是一支虛擬滑鼠，不是一組方向鍵」。**
//  那段話否決方向鍵的理由有兩條，而真機用下來只有一條活著：
//
//    死的那條  「時間軸半格 6px、音高一列 12px，同一個推力往兩個方向跑的距離差一倍，
//              手建立不起肌肉記憶」—— 按鍵**沒有推力**，一按一格就是一格，這條不成立
//    活的那條  軸鎖定把「搬到那裡」這一件事拆成兩次操作，斜著搬做不到
//
//  第二條由**長按拿起來搬**承接（那條路本來就在，而且更快）。面板接手的本來就只有微調，
//  而微調正是最需要軸隔離、也最不能靠推力猜的那一段 —— 類比桿在這裡實測「太難精準」。
//
//  於是位置改成**四顆方向鍵**。這個檔案仍然不懂音樂 —— 它只回報「哪個方向被按了一下」，
//  一步是多少由 pianoroll 決定。
//
//  **曾經有外圈的四顆三角形**（一步跳一個八度／一拍），實測拿掉了：它們為了塞進同一個
//  高度預算，把內圈壓到 31×39，於是**兩圈一起變得容易誤觸** —— 而內圈才是核心，外圈那
//  種距離本來就有更好的路（長按把音符拿起來拖）。拿掉之後同一個 `--fit` 下內圈直接大一
//  圈，四顆都穩穩超過 44。**少一組功能換到另一組真的按得準**，那是划算的。
//
//  **長度維持類比推桿。** 它實測好用，而且它要的東西跟位置不同：長度是「推到差不多長」，
//  位置是「對到那一格」。速度照力度的**三次方**映射：線性映射在剛離開死區時就已經衝過好
//  幾格。
// ────────────────────────────────────────────────────────────────────────────

import * as i18n from "./i18n.js";

// 下面五個是**整個面板的手感**。export 出去是為了 test/rolljoy.test.mjs —— 其餘的部分
// 全部要 DOM，而這幾行是唯一有東西可以驗、也是之後調校時唯一會動的地方。

/**
 * 死區。推不到這個比例就當成沒推。**兩根桿子同一個值** —— 給寬度桿更小的死區會讓它明顯
 * 更靈敏（死區小 = 同樣的手指位移換到更大的力度，而它的 `maxR` 又比較短），而長度正是
 * 最不該手滑的那一項。
 */
export const DEAD = 0.18;

/**
 * 滿推時長度推桿的速度（px/秒）。
 *
 *  **降速要動這個常數，不要去動 `speed()` 的次方**：`max` 砍半是把整條曲線等比壓下
 * 來，加次方只壓慢速段、滿推一點都不變。
 *
 * **它曾經跟位置桿綁著一個 0.4375 的比例**，而那個比例有一條測試釘著，理由是「只動其中
 * 一個就等於同時改了『多慢』與『差多少』兩件事」。位置桿改成方向鍵之後那個對照組沒了，
 * 比例失去意義，測試也一起退役 —— **這個數字現在只跟自己負責**。它守的仍然是同一件事：
 * 長度要夠難推（位置錯一格是搶拍，長度錯一格會改變它跟**下一個音**的關係，`insertNote`
 * 會把後面的音截短甚至吃掉）。
 */
export const MAX_SPEED_SIZE = 35;

/** 旋鈕能離開中心多遠（px）。也是力度 1.0 的定義。 */
const SIZE_R = 52;

/**
 * 方向鍵的長按節奏。
 *
 * `HOLD_MS` **刻意比 `LONG_MS`（400，長按拿起音符）短**。一度讓兩者相等，理由是「同一
 * 塊面板上兩個『按住多久』不該不同」—— 那個理由站不住，因為**提早觸發的代價不對稱**：
 *
 *   LONG_MS 提早   拿起一個音符開始搬。貴，而且要 Esc 或 Ctrl+Z 才收得回來
 *   HOLD_MS 提早   多走一個 1/64。按一下反方向就回來
 *
 * 代價便宜的那個可以更敏感。300 是「刻意的單次點擊」的安全下限：一般點擊 80–150ms、
 * 慢的到 250ms，再往下就會讓單點變成雙步。
 *
 * 只剩一種重複速率：外圈退役之後沒有「一步跳很遠」的鍵了，而 `REP_COARSE`（360ms）存在
 * 的唯一理由就是壓住那種鍵。
 */
export const HOLD_MS = 300;
export const REP_FINE = 180;

let el = null;              // 面板本體，null = 沒開
let warnEl = null;
let multiBtn = null;
let sizePad = null;
let axes = [];              // 類比桿，現在只剩長度那一根
let steps = [];             // 方向鍵的「停掉計時器」，hide() 要全部叫一次
let raf = 0;
let hooks = {};

/**
 * 旋鈕離中心的比例（0–1）→ 死區外重新映射過的力度（0–1）。死區內一律 0。
 *
 * 重映射而不是直接用原值：不映射的話推出死區的**瞬間**力度就已經是 0.18，起步會有一個
 * 看得見的跳動。映射過之後桿子推出去是連續的。
 */
export const throttle = (mag, dead) => (mag <= dead ? 0 : (mag - dead) / (1 - dead));

/**
 * 力度 → 速度。**三次方**（見檔頭）：半推只剩滿速的八分之一，而滿推維持不變 —— 這條曲
 * 線只動慢速段，不會讓長距離搬動更難熬。
 *
 *  **次方不要再加了**：後來還是嫌快，但那一輪兩端都嫌，而加次方只壓得到慢速段。改的
 * 是 `MAX_SPEED` / `MAX_SPEED_SIZE`。
 */
export const speed = (m, max) => max * m * m * m;

export const isOpen = () => !!el;

/**
 * 面板上緣在視窗裡的 y。沒開就是 Infinity。pianoroll 用它算「捲軸的下緣被蓋掉多少」。
 */
export const top = () => (el ? el.getBoundingClientRect().top : Infinity);

/**
 * @param {object} h
 * @param {(dir:string)=>void} h.onStep  方向鍵按了一下（`"up"|"down"|"left"|"right"`）。
 *        **一步是多少由 pianoroll 決定** —— 這個檔案不知道什麼是半音、什麼是 1/64。
 *        長按的連續觸發也從這裡出來，呼叫端分不出（也不需要分）哪一下是手按的。
 * @param {()=>void} h.onStepEnd  方向鍵放開了。**提交計時器要等這一下才上膛** ——
 *        手指還按著就不算「停手」，見 pianoroll 的 padArm。
 * @param {(kind:string)=>void} h.onStart  按下長度旋鈕（kind 恆為 `"size"`）
 * @param {(kind:string, dx:number, dy:number)=>void} h.onMove  這一幀虛擬滑鼠要移動
 *        幾個 **px**（螢幕方向：dy 為正 = 往下）。積分在這裡做，落點換算在 pianoroll。
 * @param {(kind:string)=>void} h.onEnd    放開長度旋鈕
 * @param {()=>void} h.onMenu
 * @param {(on:boolean)=>void} h.onMulti
 * @param {()=>void} h.onDelete 刪掉目前選取的音符
 * @param {()=>void} h.onClear  清空選取（面板跟著收，因為它的開關就是選取）
 */
export function init(h) {
  hooks = h ?? {};
}

/**
 * 開面板（已經開著就只更新狀態）。
 *
 * @param {object} o
 * @param {boolean} o.canResize 寬度桿能不能用。多選時是 false —— 一組音符各自的長度不
 *                              同，「一起改長度」在這個編輯器裡不支援（PC 也一樣）。
 * @param {boolean} o.multi     多選鍵亮不亮
 */
export function show({ canResize = true, multi = false } = {}) {
  if (!el) build();
  sizePad.classList.toggle("off", !canResize);
  multiBtn.classList.toggle("on", multi);
  multiBtn.setAttribute("aria-pressed", String(multi));
}

export function hide() {
  if (!el) return;
  stopAll();
  el.remove();
  el = null; warnEl = null; multiBtn = null; sizePad = null;
  axes = []; steps = [];
}

/**
 * 面板最上面那一行。兩種內容共用它，而它們**在時間上互斥**：
 *
 *   警告（`tone: "warn"`）  「放開會刪掉 N 個音」。手機上**唯一看得到的破壞警告**
 *                           —— 工具列那一份在畫面另一端，窄視窗還會被 CSS 藏起來
 *   說明（`tone: "note"`）  多選亮著時的「拖曳＝框選 · 雙指捲動」
 *
 * 互斥是因為警告只在**拖曳中**出現，而那句說明講的正是「拖曳會發生什麼」—— 已經在拖了
 * 就不必再講。呼叫端（pianoroll 的 syncToolbar）用 `||` 挑，警告優先。
 *
 * **兩種語氣要分開上色。** 說明用警告的紅色會讓人以為做錯了什麼，而它其實是在幫忙。
 *
 * 高度永遠保留，不然它一出現就會把整個面板往下推 —— 手指瞄準的位置在最需要穩定的時候跳掉。
 */
export function setEffect(msg, tone = "warn") {
  if (!warnEl) return;
  warnEl.textContent = msg || "";
  warnEl.classList.toggle("on", !!msg);
  warnEl.classList.toggle("note", !!msg && tone === "note");
}

/**
 * 貼到**畫面最底部、狀態列上方**，滿版寬度。蓋住樂譜分頁列與捲軸下緣是刻意的：遙桿模式
 * 的注意力只有捲軸上那個音跟手上的桿子。
 *
 * 用 `bottom` 而不是 `top`：不必先量自己的高度，而那個高度會隨警告行有沒有內容變。狀態
 * 列被關掉時問 `offsetParent` 而不是問 class —— 那條 CSS 只在手機斷點生效。
 *
 * 用 `position:fixed` 而不是塞進 `#stage`：那是捲動容器，放進去會跟著內容捲走。
 */
export function place() {
  if (!el) return;
  const st = document.getElementById("status");
  const shown = st && st.offsetParent !== null;
  const gap = shown ? Math.max(0, innerHeight - st.getBoundingClientRect().top) : 0;
  el.style.bottom = `${Math.round(gap)}px`;
}

// ─── 建立 ───────────────────────────────────────────────────────────────────

function build() {
  el = document.createElement("div");
  el.id = "rollJoy";

  warnEl = document.createElement("div");
  warnEl.className = "warn";
  el.appendChild(warnEl);

  const ctl = document.createElement("div");
  ctl.className = "ctl";
  el.appendChild(ctl);

  ctl.appendChild(buildDpad());

  // ── 右：上排兩顆鍵、下排寬度桿 ──
  const right = document.createElement("div");
  right.className = "right";
  ctl.appendChild(right);

  const keys = document.createElement("div");
  keys.className = "keys";
  right.appendChild(keys);

  multiBtn = mkKey(i18n.t("roll.pad.multi"), "fa-solid fa-chart-gantt", "multi");
  multiBtn.setAttribute("aria-pressed", "false");
  multiBtn.addEventListener("click", () => {
    const on = !multiBtn.classList.contains("on");
    multiBtn.classList.toggle("on", on);
    multiBtn.setAttribute("aria-pressed", String(on));
    hooks.onMulti?.(on);
  });
  keys.appendChild(multiBtn);

  const menuBtn = mkKey("☰ " + i18n.t("roll.pad.menu"), null, "menu");
  // 卜選單長在**按鈕上**（`place()` 會因為下方沒空間自動往上翻）：錨到被選中的音符會讓
  // 手指在右下角、選單卻跳到畫面別處，而多選時「哪一個音」也沒有答案。
  menuBtn.addEventListener("click", () => {
    const r = menuBtn.getBoundingClientRect();
    hooks.onMenu?.(r.left + r.width / 2, r.top);
  });
  keys.appendChild(menuBtn);

  sizePad = document.createElement("div");
  sizePad.className = "size pad";
  sizePad.setAttribute("role", "application");
  sizePad.setAttribute("aria-label", i18n.t("roll.pad.size"));
  sizePad.innerHTML = '<span class="knob"></span>';
  right.appendChild(sizePad);

  // ── 第三排：兩端各一顆，中日間空著 ──
  //
  // 這一排是「離開／毀掉」，跟上面兩排的「調整」分開。刪除是這個面板上唯一不可逆的鍵，
  // 它旁邊不該有別的東西。之後要加的鍵往中間放，兩端這兩顆不動。
  const exits = document.createElement("div");
  exits.className = "keys exits";
  right.appendChild(exits);

  // 取消選擇 = 清空選取。面板的開關掛在選取上，所以按下去面板自己就收了。
  const clearBtn = mkKey(i18n.t("roll.pad.clear"), null, "clear");
  clearBtn.addEventListener("click", () => hooks.onClear?.());
  exits.appendChild(clearBtn);

  const delBtn = mkKey(i18n.t("roll.pad.del"), null, "del");
  delBtn.classList.add("del");
  // 不做二次確認：undo 收得回來（一次刪除就是一步），而確認框在單手操作竹的面板上要多戳
  // 一次，代價比它擋掉的那次誤按還高。
  delBtn.addEventListener("click", () => hooks.onDelete?.());
  exits.appendChild(delBtn);

  document.body.appendChild(el);

  axes = [
    bindAxis(sizePad, { kind: "size", maxR: SIZE_R, dead: DEAD, lockY: true, max: MAX_SPEED_SIZE }),
  ];
}

// ─── 方向鍵 ─────────────────────────────────────────────────────────────────

/**
 * 方向鍵：四顆五邊形（長方形＋朝內的尖端）。
 *
 * **四顆同一份 CSS，靠 rotate 定位**：先把自己置中、轉到朝向、再沿自身方向往外推，所以
 * 四個鍵的尖端離中心、外緣離圓圈都完全一致 —— 不必為每個方向各寫一組座標，也就不會有
 * 「上面那顆看起來比較遠」這種只有在某個尺寸下才看得出來的歪斜。
 *
 * 整組用一個 `--fit` 等比縮放（見 editor.css）：真機上調大小只要改那一個數字。
 *
 * **沒有外框的圓。** 一度畫了一個 —— 它在雙圈時代有用（外圈三角形一半在圓內一半在圓外，
 * 那條線是它們的參考）。外圈退役之後它只是一圈裝飾，而四顆鍵朝內的尖端已經把「這是一組」
 * 講完了。
 *
 * **`aria-hidden`。** 捲簾是一張 canvas，對螢幕閱讀器完全不存在 —— 選中了哪個音、按下去
 * 之後移到哪裡都沒有可讀的表示。在那個前提下替這四顆寫標籤只是替一個用不了的功能加旁白；
 * 而**留著四顆沒有名字的 `<button>` 比跳過去更糟**（會被唸成四次「按鈕」）。所以誠實地宣
 * 告「這一組沒有無障礙對應」，並用 `tabindex="-1"` 一起退出焦點順序。多選／選單／取消選擇
 * ／刪除**留著**：那四個不依賴空間資訊。
 */
function buildDpad() {
  const fit = document.createElement("div");
  fit.className = "dpad-fit";
  fit.setAttribute("aria-hidden", "true");

  const wrap = document.createElement("div");
  wrap.className = "dpad-wrap";
  fit.appendChild(wrap);

  steps = [];
  for (const dir of ["up", "down", "left", "right"]) {
    const b = document.createElement("button");
    b.type = "button";
    b.className = `key-d ${dir}`;
    b.tabIndex = -1;
    wrap.appendChild(b);
    steps.push(bindStep(b, dir));
  }
  return fit;
}

/**
 * 一顆方向鍵。按下就走一步，按住滿 `HOLD_MS` 之後開始連續觸發。
 *
 * **按下那一刻就先走一步**，不等 `HOLD_MS` —— 這個面板最常做的事是「點一下、看一眼」，
 * 讓每一下都先付 400ms 會把它變成另一個功能。
 *
 * `pointerleave` 也算放開：手指按著滑出鍵外時要停，不然它會在手指已經離開的鍵上繼續跑。
 * 回傳一個 `stop`，`stopAll()` 用它把計時器收乾淨。
 */
function bindStep(btn, dir) {
  let hold = 0, rep = 0;
  const stop = () => {
    // 只有真的按過才回報放開 —— 這幾個事件在沒按下的情況下也收得到（例如手指從別的
    // 地方滑過來再抬起），那時上膛會對著一個不存在的段落計時。
    const wasDown = !!(hold || rep);
    clearTimeout(hold); clearInterval(rep);
    hold = 0; rep = 0;
    btn.classList.remove("on");
    if (wasDown) hooks.onStepEnd?.();
  };
  btn.addEventListener("pointerdown", e => {
    if (hold || rep) return;
    e.preventDefault();
    try { btn.setPointerCapture(e.pointerId); } catch { /* 抓不到也還是能用 */ }
    btn.classList.add("on");
    hooks.onStep?.(dir);
    hold = setTimeout(() => { rep = setInterval(() => hooks.onStep?.(dir), REP_FINE); }, HOLD_MS);
  });
  for (const t of ["pointerup", "pointercancel", "pointerleave"]) btn.addEventListener(t, stop);
  return stop;
}

/**
 * 一顆鍵。`icon` 是 Font Awesome 的 class（省略就純文字）。圖示用 `createElement` 疊上去
 * 而不是 `innerHTML` —— 文字來自語言檔，不該有機會變成標籤。
 */
function mkKey(text, icon, k) {
  const b = document.createElement("button");
  b.type = "button";
  b.className = "key";
  // 穩定的識別，給測試用。以前 rolltouch.test.mjs 是靠**位置索引**抓這四顆的，而方向鍵
  // 插進來就會全部錯位 —— 那種壞法不會報錯，只會讓斷言測到別顆。
  if (k) b.setAttribute("data-k", k);
  if (icon) {
    const i = document.createElement("i");
    i.className = icon;
    i.setAttribute("aria-hidden", "true");
    b.appendChild(i);
  }
  b.appendChild(document.createTextNode(text));
  return b;
}

// ─── 桿子 ───────────────────────────────────────────────────────────────────

/**
 * 綁一根桿子。回傳它的狀態物件（單位向量 + 力度），積分迴圈直接讀它。
 *
 * `setPointerCapture` 是必要的而不是保險：132px 的靶，手指推到滿時本來就會滑山出邊界，收
 * 不到 pointermove 的話桿子會卡在最後一個位置繼續走。
 */
function bindAxis(pad, { kind, maxR, dead, lockY, max }) {
  const knob = pad.querySelector(".knob");
  const a = { kind, pad, knob, maxR, dead, lockY, max, pid: null, ux: 0, uy: 0, mag: 0 };

  pad.addEventListener("pointerdown", e => {
    if (a.pid !== null || pad.classList.contains("off")) return;
    // **一次只有一根桿子**。兩根同時按住的話第二次 onStart 會被 pianoroll 擋掉，但放開
    // 任何一根都會 commit —— 那個歧義沒有正確答案。
    if (axes.some(x => x.pid !== null)) return;
    a.pid = e.pointerId;
    try { pad.setPointerCapture(a.pid); } catch { /* 抓不到也還是能用 */ }
    pad.classList.add("active");
    hooks.onStart?.(kind);
    move(e);
    startLoop();
  });
  pad.addEventListener("pointermove", e => { if (e.pointerId === a.pid) move(e); });
  for (const t of ["pointerup", "pointercancel"]) {
    pad.addEventListener(t, e => {
      if (e.pointerId !== a.pid) return;
      release(a);
      hooks.onEnd?.(kind);
    });
  }

  function move(e) {
    const r = pad.getBoundingClientRect();
    let dx = e.clientX - (r.left + r.width / 2);
    let dy = lockY ? 0 : e.clientY - (r.top + r.height / 2);

    const dist = Math.hypot(dx, dy);
    if (dist > maxR) { dx = dx / dist * maxR; dy = dy / dist * maxR; }
    knob.style.transform = `translate(${dx}px, ${dy}px)`;

    const len = Math.hypot(dx, dy);
    const m = throttle(Math.min(len / maxR, 1), dead);
    if (!m) { a.mag = 0; a.ux = 0; a.uy = 0; return; }
    a.mag = m;
    a.ux = dx / len;
    a.uy = dy / len;
  }

  return a;
}

function release(a) {
  if (a.pid === null) return;
  try { a.pad.releasePointerCapture(a.pid); } catch { /* 沒抓到就算了 */ }
  a.pid = null;
  a.mag = 0; a.ux = 0; a.uy = 0;
  a.pad.classList.remove("active");
  a.knob.style.transform = "translate(0,0)";
}

function stopAll() {
  for (const a of axes) release(a);
  // 方向鍵的自動重複也要停。面板收起來時手指可能還按著（切軌、播放、改用滑鼠都會收），
  // 不停的話那個 setInterval 會對著一個已經不存在的面板繼續發 onStep。
  for (const stop of steps) stop();
  if (raf) cancelAnimationFrame(raf);
  raf = 0; last = 0;
}

function startLoop() {
  if (!raf) { last = 0; raf = requestAnimationFrame(loop); }
}

/**
 * 把推力積分戈成位移。`dt` 夾在 50ms：切到別的分頁再回來時 `now - last` 會是好幾秒，不夾
 * 的話音符會瞬間飛到譜的另一端 —— 而那是一次不可逆的編輯（放開就寫回去了）。
 */
let last = 0;
function loop(now) {
  raf = 0;
  const dt = last ? Math.min(0.05, (now - last) / 1000) : 0;
  last = now;

  let live = false;
  for (const a of axes) {
    if (a.pid === null) continue;
    live = true;
    if (!a.mag || !dt) continue;
    const v = speed(a.mag, a.max) * dt;
    hooks.onMove?.(a.kind, a.ux * v, a.uy * v);
  }
  if (live) raf = requestAnimationFrame(loop);
  else last = 0;
}
