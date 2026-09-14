// ────────────────────────────────────────────────────────────────────────────
//  選取：MML 的字元範圍 ↔ 捲軸上的音符
//
//  **MML 的選取是唯一的真相來源。** 捲軸不自己維護一份「被選中的音符」—— 點捲軸上的音
//  符也是先去設定 textarea 的選取，再繞回來變成捲軸上的白框。兩份狀態一定會有對不上的
//  時候，一份就沒有這個問題。
//
//  這裡只做範圍 ↔ 音符的換算與捲動；誰該被選、什麼時候選是 ui.js 的事。
// ────────────────────────────────────────────────────────────────────────────

/**
 * 選取範圍 [start, end) 涵蓋了哪些音符。**有重疊就算**，不要求完全包含 —— 手拖選取很容易
 * 差一個字元。空選取（純游標）不算任何音符，所以在文字區點一下就等於取消卜選取。
 */
export function notesIn(track, start, end) {
  if (!track || end <= start) return [];
  return track.notes.filter(n => n.srcStart < end && n.srcEnd > start);
}

/** 同上，但回傳休止符與音符都算的「有沒有碰到東西」——目前只有偵錯用得到。 */
export const key = (tick, midi) => `${tick}:${midi}`;

/**
 * 這些音符（用 tick+midi 指認）在原文裡的涵蓋範圍。
 *
 * 寫回 MML 之後整軌文字會重新產生，舊的字元位置全部失效 —— 要讓選取跟著搬動或移調走，
 * 就得用「音符的身分」重新算一次。一軌是單音的，所以 tick+midi 唯一。
 *
 * 回傳連續區間 [min(srcStart), max(srcEnd)]。
 */
export function rangeOf(track, picks) {
  if (!track || !picks?.length) return null;
  const want = new Set(picks.map(p => key(p.tick, p.midi)));
  let lo = Infinity, hi = -Infinity;
  for (const n of track.notes) {
    if (!want.has(key(n.tick, n.midi))) continue;
    if (n.srcStart < lo) lo = n.srcStart;
    if (n.srcEnd > hi) hi = n.srcEnd;
  }
  return lo <= hi ? [lo, hi] : null;
}

/**
 * 同上，但**不併成一段** —— 回傳一組區間，相鄰的才併。兩個函式回答的是不同的問題：
 *
 *   rangeOf   「從這個音**到**那個音」 → 一定是一段（Shift 範圍選取）
 *   rangesOf  「就**這幾個**音」       → 可能好幾段（Ctrl 多選，以及編輯後把選取接回去）
 *
 * **相鄰的要併**：`c4d4` 在原文裡是貼著的，畫成兩條分開竹的帶子會看起來像有東西沒選到。
 * 判準是「下一段的開頭 <= 上一段的結尾」，中間連一個字都沒有才併 —— 夾了 `l8` 就會斷
 * 開，而那是對的：那個 `l8` 沒有被選。
 *
 * @returns {Array<[number,number]>} 半開區間，照原文位置排序，互不重疊；沒有就回 []
 */
export function rangesOf(track, picks) {
  if (!track || !picks?.length) return [];
  const want = new Set(picks.map(p => key(p.tick, p.midi)));
  const spans = track.notes
    .filter(n => want.has(key(n.tick, n.midi)))
    .map(n => [n.srcStart, n.srcEnd])
    .sort((a, b) => a[0] - b[0] || a[1] - b[1]);

  const out = [];
  for (const [a, b] of spans) {
    const last = out[out.length - 1];
    if (last && a <= last[1]) last[1] = Math.max(last[1], b);
    else out.push([a, b]);
  }
  return out;
}

/**
 * 原文的第 index 個字元落在時間軸的哪個 tick。定義是「**到這裡為止已經走過多少時間**」：
 * 找出第一個「原文結束位置在 index 之後」的音符或休止符，回傳它的起始 tick。三種情形都
 * 自然成立：
 *
 *   游標在 c4 中間      → c4 的 tick（這個音的起點）
 *   游標在 c4 與 d4 之間 → d4 的 tick（也就是 c4 的結束時間）
 *   游標在 l8 這種指令上 → 它後面第一個發聲的東西的 tick（指令不佔時間）
 *
 * 走到全部之後就是整軌的結尾。找不到軌回 null。音符與休止符各自照原文位置排好，所以兩
 * 個指標併著走就好 —— 這個函式在拖曳卜選取時每動一下就會被叫一次。
 */
export function tickAt(track, index) {
  if (!track) return null;
  const ns = track.notes, rs = track.rests ?? [];
  let i = 0, j = 0;
  while (i < ns.length || j < rs.length) {
    const a = i < ns.length ? ns[i] : null;
    const b = j < rs.length ? rs[j] : null;
    const take = !b || (a && a.srcStart <= b.srcStart) ? a : b;
    if (take.srcEnd > index) return take.tick;
    if (take === a) i++; else j++;
  }
  return track.endTick;
}

// ─── 鬼影：別軌的音符 ────────────────────────────────────────────────────────

/**
 * 落在 (rawTick, midi) 這個位置上的**別軌**音符。`{ ch, note }`，沒有就 null。
 *
 * 「箭頭模式下 hover 鬼影 → 按下去切到那一軌」唯一的判定。住在這裡而不是
 * `pianoroll.locate()` 裡面，是因為 `pianoroll.js` 在 node 裡載不起來 —— 而下面三條規則
 * 錯掉的症狀全部是「大部分時候是對的」，那種東西一定要有測試。
 *
 *   排除當前軌   呼叫端已經確定當前軌沒命中才會問這裡（當前軌的音永遠贏）
 *   跳過隱藏軌   `shown[ch] === false` 的整條跳過 —— 一個看不見的音符會把點擊吃掉
 *   取最小軌號   疊軌時取分頁順序最小的。**不用繪製順序**：鬼影是空心外框，兩個長度相
 *                同的音疊起來像素級重合，使用者看不出誰在上面
 *
 * 每一次 `pointermove` 都會跑而且最多掃 15 軌，所以早退是必要的：`notes` 竹的 tick 不遞
 * 減，看到超過 rawTick 就可以停。
 */
export function ghostAt(tracks, { active, count, shown, rawTick, midi }) {
  if (!tracks) return null;
  const n = Math.min(count ?? tracks.length, tracks.length);
  for (let ch = 0; ch < n; ch++) {
    if (ch === active) continue;
    if (shown && shown[ch] === false) continue;
    const note = noteAt(tracks[ch], rawTick, midi);
    if (note) return { ch, note };
  }
  return null;
}

/** 一軌裡蓋住 (rawTick, midi) 的那個音。tick 不遞減，所以超過就停。 */
function noteAt(track, rawTick, midi) {
  const ns = track?.notes;
  if (!ns) return null;
  for (const n of ns) {
    if (n.tick > rawTick) break;
    if (n.midi === midi && rawTick < n.tick + n.durTick) return n;
  }
  return null;
}

// ─── 把 textarea 捲到某個字元位置 ───────────────────────────────────────────

/**
 * textarea **沒有 API 可以「捲到選取處」** —— setSelectionRange 只改選取，不捲動。所以自
 * 己量：做一個隱藏的 div，複製字型、行高、內距與內容寬度，塞進同一份文字，量出來的高度就
 * 是那個位置的 y。
 *
 * 不用「數換行乘行高」是因為那完全不懂**軟換行**：單行長譜會整人個算錯，永遠捲到第一行。
 *
 * ─── 為什麼下面兩個快取是必要條件，不是最佳化 ───
 *
 * 寫 `mir.style` 或 `mir.textContent` 都會把鏡子的排版弄髒，於是緊接著的量測是一次**完整
 * 的重新排版**。而 `reveal()` 在播放中是**每響一個音就走一次**（見 ui.highlightPlaying），
 * 一軌上限 8000 字 —— 每秒十次重排一整軌的文字，手機上就是主執行緒直接吃滿。
 *
 * 所以這裡的規矩是：**值沒變就一個字都不要寫。** 不弄髒排版，量測讀到的就是快取好的那一
 * 份，成本從「重排一整軌」掉到一次矩形查詢。
 *
 * **代價是整首譜會一直留在這個隱藏的 div 裡**（以前每次量完都清掉）。那是刻意換的：清掉等
 * 於下一次要重排，而重排正是這裡唯一貴的東西。`visibility:hidden` 的元素照樣要排版，所以這
 * 是多一份文字的排版 —— 跟上色層本來就有的那一份同一個量級。
 *
 * 快取的是**輸入**（排版屬性與文字），不是量出來的 y。所以字型晚一步載進來時不必自己作廢：
 * 瀏覽器會把鏡子的排版標髒，下一次讀矩形讀到的就是新的。
 */
let mir = null;
let mirSig = null;    // 上次抄進鏡子的那一組排版屬性
let mirSrc = null;    // 上次放進鏡子的那一份文字
let mirLine = 18;     // 行高，跟著 mirSig 一起更新（reveal 要用，順手省一次 getComputedStyle）

/**
 * 要照抄的排版屬性。**一個都不能漏，也不能寫死。**
 *
 * whiteSpace / overflowWrap：MML 換行設定開著時 textarea 是 white-space:pre（不軟換行、改
 * 用橫向捲動，這樣左邊那把小節尺才能一行對一列）。鏡子跟本體的換行行為不一致，量出來的 y
 * 就是錯的。**斷字那兩個同理**（`wordBreak` / `lineBreak`）：本體是逐字元斷（見 editor.css
 * 那組基礎規則），漏掉的話鏡子會退回「只在 `-` `+` `.` 後面斷」，行數不一樣、y 就整片偏掉。
 *
 * `width` 抄的是**內容寬度**（不含 padding／border），配上 content-box 量出來的座標才跟
 * textarea 的捲動原點一致。
 */
const MIR_PROPS = ["fontFamily", "fontSize", "fontWeight", "fontStyle",
                   "letterSpacing", "lineHeight", "tabSize", "textIndent",
                   "whiteSpace", "overflowWrap", "wordBreak", "lineBreak",
                   "paddingTop", "paddingRight", "paddingBottom", "paddingLeft",
                   "width"];

function mirror(ta) {
  if (!mir) {
    mir = document.createElement("div");
    mir.setAttribute("aria-hidden", "true");
    Object.assign(mir.style, {
      position: "absolute", left: "-9999px", top: "0",
      visibility: "hidden", pointerEvents: "none",
      // 用 content-box + 內容寬度，量出來的座標才跟 textarea 的捲動原點一致
      boxSizing: "content-box",
    });
    document.body.appendChild(mir);
  }
  const cs = getComputedStyle(ta);
  // 先比對再寫（見上面那段長註解）。比對本身只讀 computed style，不弄髒任何東西。
  const sig = MIR_PROPS.map(p => cs[p]).join("\n");
  if (sig !== mirSig) {
    for (const p of MIR_PROPS) mir.style[p] = cs[p];
    mirSig = sig;
    mirLine = parseFloat(cs.lineHeight) || 18;
    mirSrc = null;   // 排版換了，文字要重新排一次
  }
  return mir;
}

/**
 * 那個字元位置在 textarea 竹的捲動座標裡的 y（含上內距）。
 *
 * **放整份文字，不是切到 index。** 切一次就得重排一次，而**逐字元斷行**（見 editor.css 那
 * 組基礎規則）保證「index 落在哪一列」只跟它前面的字有關 —— 放整份跟放前半段量出來是同一
 * 個答案，但整份只要文字沒變就一次都不用重排。
 *
 * 尾巴補一個零寬空白：`index === value.length` 要有一個字元可以量，而它落的位置正是原本那
 * 個 marker span 落的位置（文字以換行結尾時在下一列）。
 */
function topOf(ta, index) {
  const m = mirror(ta);
  const src = ta.value;
  if (src !== mirSrc) { m.textContent = src + "\u200b"; mirSrc = src; }
  const node = m.firstChild;
  if (!node) return 0;
  // 量一個字元寬的範圍，不是塌掉的游標 —— 塌掉的 Range 在部分瀏覽器回空矩形。
  const a = Math.min(Math.max(0, index), node.data.length - 1);
  const r = document.createRange();
  r.setStart(node, a);
  r.setEnd(node, a + 1);
  // 兩個矩形都是排版乾淨時的快取查詢。相減是因為要的是「鏡子內部的 y」，不是視窗座標。
  return r.getBoundingClientRect().top - m.getBoundingClientRect().top;
}

/**
 * 把 index 捲進可視範圍。**已經看得到就不動** —— 每次都置中的話，播放中每換一個音畫面就
 * 跳一次。
 */
export function reveal(ta, index) {
  if (!ta) return;
  // 先量位置：topOf() 會經過 mirror()，而行高就是在那裡跟著排版一起更新的（見 mirLine）。
  const top = topOf(ta, index);
  const lh = mirLine;
  const view = ta.clientHeight;
  // 上下各留一行的餘裕，剛好卡在邊緣時也看得舒月服
  if (top >= ta.scrollTop + lh && top + lh <= ta.scrollTop + view - lh) return;
  ta.scrollTop = Math.max(0, top - view / 3);
}
