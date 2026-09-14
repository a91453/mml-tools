// ────────────────────────────────────────────────────────────────────────────
//  MML 解析器
//  純函式，不碰 DOM、不碰音訊。行為對照 MabiMmlPlayer。
// ────────────────────────────────────────────────────────────────────────────

import {
  OCT_BASE, N_BASE, PPQ,
  PITCH_MIN, PITCH_MAX, pitchName, foldIntoRange,
} from "./config.js";
import { clamp } from "./util.js";
// 具名 import 一個叫 t 的東西會被 parseTrack 的 `const { t, map }` **安靜地**遮掉
// （t("…") 會變成對字串取索引）。整個專案都用 namespace import。
import * as i18n from "./i18n.js";

// h 日是德式記法的 b，3MLE 匯出的譜偶爾會出現
const STEP = { c:0, d:2, e:4, f:5, g:7, a:9, b:11, h:11 };

/** 附點的長度倍率：1 個 → ×1.5、2 個 → ×1.75、3 個 → ×1.875… */
export function dotMul(dots) {
  let mul = 1, add = 1;
  for (let k = 0; k < dots; k++) { add /= 2; mul += add; }
  return mul;
}

/**
 * 長度分母 + 附點數 → tick。**先取整再乘附點**（不是先乘再取整），跟 MabiMmlPlayer 對
 * 齊：`l6` 這種除不盡的長度兩種順序會差一個 tick。
 *
 * **這是「MML 長度」的唯一定義**，mml-compress.js 也匯入它。
 */
export function lenTicks(denom, dots) {
  return Math.round(Math.floor(PPQ * 4 / Math.max(1, denom)) * dotMul(dots));
}

// ─── 速度圖 ─────────────────────────────────────────────────────────────────

/** tempos → 折線點 {tick, bpm, sec}。兩個方向共用同一組點才不會漂移。 */
function tempoPoints(tempos) {
  const pts = [{ tick: 0, bpm: 120, sec: 0 }];
  for (const ev of tempos) {
    if (ev.tick <= 0) { pts[0].bpm = ev.bpm; continue; }
    const p = pts[pts.length - 1];
    pts.push({ tick: ev.tick, bpm: ev.bpm, sec: p.sec + (ev.tick - p.tick) * 60 / (p.bpm * PPQ) });
  }
  return pts;
}

/**
 * 共月用的速度圖 → tick 轉秒。速度是整首歌的屬性不是某一軌的，所以這張圖由所有軌合併而
 * 成；而一個音的長度要用「結束時間 − 開始時間」算，跨過速度變化才不會算錯。
 */
export function makeClock(tempos) {
  const pts = tempoPoints(tempos);
  return tick => {
    let lo = 0, hi = pts.length - 1;
    while (lo < hi) { const m = (lo + hi + 1) >> 1; if (pts[m].tick <= tick) lo = m; else hi = m - 1; }
    const p = pts[lo];
    return p.sec + (tick - p.tick) * 60 / (p.bpm * PPQ);
  };
}

/**
 * 速度事件裡**真的有變化**的那些。有些工具會在每一小節開頭都寫一次 `t113`，照單全收的
 * 話 90 小節就是 90 個一模一樣的標記把尺塞爆。
 */
export const tempoChanges = tempos =>
  (tempos ?? []).filter((e, i, a) => i === 0 || e.bpm !== a[i - 1].bpm);

/** 力度事件裡真正「有變化」的那幾個。跟 tempoChanges 同一條規則、同一個理由。 */
export const velChanges = vels =>
  (vels ?? []).filter((e, i, a) => i === 0 || e.v !== a[i - 1].v);

/** makeClock 的反函式：秒 → tick。導播線要它 —— 播放時手上只有 AudioContext 竹的秒數。 */
export function makeInverseClock(tempos) {
  const pts = tempoPoints(tempos);
  return sec => {
    let lo = 0, hi = pts.length - 1;
    while (lo < hi) { const m = (lo + hi + 1) >> 1; if (pts[m].sec <= sec) lo = m; else hi = m - 1; }
    const p = pts[lo];
    return p.tick + (sec - p.sec) * p.bpm * PPQ / 60;
  };
}

// ─── 前置處理 ───────────────────────────────────────────────────────────────

/** 剝掉 `MML@` … `;` 的外殼跟註解，留下裸的軌道內容（可能還含逗號）。 */
export function stripWrapper(src) {
  let s = src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");
  const at = s.toLowerCase().indexOf("mml@");
  if (at >= 0) s = s.slice(at + 4);
  return s.replace(/;[\s\S]*$/, "");
}

/** 一整串 MML → 各軌的文字。給「貼上」用。 */
export function splitMML(src) {
  return stripWrapper(src).split(",").map(s => s.trim());
}

/**
 * 一軌 → 真正貼進遊戲的形式：剝掉外殼與註解，再去掉所有空白。**「匯出」與「字數還剩多
 * 少」必須用同一個定義**，不然畫面上寫還有額度、貼進遊戲卻被拒絕。
 */
export const bareTrack = src => stripWrapper(src ?? "").replace(/\s+/g, "");

/**
 * 去掉所有 `@n`（樂器指定）。
 *
 * **遊戲的空白樂譜不吃 `@n`**，它只是讓音色選擇跟著譜走過純文字通道（分享）的載具：
 * share.withProgram() 插進去、clipboard.importText() 讀出來設下拉後**立刻拿掉**、
 * clipboard.exportText() 再保險一次。
 *
 * 拿掉不會動到卜音樂：`@` 不佔時間，而那個狀態的真相來源是樂器下拉不是 MML 文字。全部拿
 * 掉而不只是開頭那個：「軌中途換樂器」本站表達不出來。
 */
export const stripPrograms = src => (src ?? "").replace(/@\d+/g, "");

/**
 * 去掉所有 `t123`（速度記號）。編輯器把速度收斂成「**只有主旋律持有**」：設速度時清掉所
 * 有軌的 `t`，再把整張圖重寫進第 1 軌。
 *
 * **刻意用文字刪除，不走 items 重新產生**：重新產生會吃掉註解與手排換行（多數譜每一軌
 * 開頭都有 `t`），而寫不回去的唯讀軌會擋住整件事。
 *
 * 跟 `stripPrograms` 同一種東西，差別是**這裡跳過註解**（每次設速度都要掃過 15 軌）。
 * 未關閉的 `/*` 不算註解，跟 `compact()` 一致。
 */
export function stripTempos(src) {
  const s = src ?? "";
  let out = "", i = 0;
  while (i < s.length) {
    if (s[i] === "/" && s[i + 1] === "*") {
      const e = s.indexOf("*/", i + 2);
      if (e >= 0) { out += s.slice(i, e + 2); i = e + 2; continue; }
    }
    if (s[i] === "/" && s[i + 1] === "/") {
      const e = s.indexOf("\n", i);
      const to = e < 0 ? s.length : e;
      out += s.slice(i, to); i = to; continue;
    }
    if (s[i] === "t" || s[i] === "T") {
      let j = i + 1;
      while (j < s.length && s[j] >= "0" && s[j] <= "9") j++;
      if (j > i + 1) { i = j; continue; }     // `t` 後面真的有數字才算速度記號
    }
    out += s[i++];
  }
  return out;
}

/**
 * 把原始文字壓戈成 parseTrack 真正要掃的形式，同時記下每個字元在**原文**的位置 —— 鋼琴捲
 * 軸靠這張表把方塊對回 MML 文字，沒有它就只剩「第幾個音符」這種會被任何一次編輯打亂的
 * 間接指標。步驟順序刻意跟舊版的 replace 鏈一致，test/mml.test.mjs 有一條測試釘住。
 *
 * @returns {{t:string, map:number[], hasComma:boolean}}
 *   t 壓縮後的字串、map[i] = t[i] 在原文的索引、hasComma 有沒有吃掉逗號
 */
export function compact(src) {
  // 1. 去註解。位置一路帶著走，所以後面算出來的偏移量是對原文的。
  const keep = [];
  for (let i = 0; i < src.length; ) {
    if (src[i] === "/" && src[i + 1] === "*") {
      const e = src.indexOf("*/", i + 2);
      // 沒有關閉的 /* 不算註解。刻意的：留著它，後面的字元會變成「看不懂的字元」警告；
      // 當成註解吞掉的話剩下的音符會無聲消失，那是更難查的壞法。
      if (e >= 0) { i = e + 2; continue; }
    }
    if (src[i] === "/" && src[i + 1] === "/") {
      while (i < src.length && src[i] !== "\n") i++;
      continue;
    }
    keep.push(i++);
  }

  // 2. MML@ 前綴：有就從它後面開始
  const bare = keep.map(at => src[at]).join("").toLowerCase();
  const at = bare.indexOf("mml@");
  const from = at >= 0 ? at + 4 : 0;

  // 3. 第一人個 ; 之後全部丟掉。註解已經去掉了，所以註解裡的 ; 不算。
  let to = keep.length;
  for (let k = from; k < keep.length; k++) if (bare[k] === ";") { to = k; break; }

  // 4. 去逗號與空白
  let t = "", hasComma = false;
  const map = [];
  for (let k = from; k < to; k++) {
    const c = bare[k];
    if (c === ",") { hasComma = true; continue; }
    if (/\s/.test(c)) continue;
    t += c; map.push(keep[k]);
  }
  return { t, map, hasComma };
}

// ─── 詞法 ───────────────────────────────────────────────────────────────────

/**
 * compact() 之後的字串 → token 串流。**這是 MML 詞法的唯一定義**，parseTrack 與語法上色
 * 層都走這裡 —— 兩邊各掃一遍的話「上色層說這是音符、播放卻不這麼認為」就會變成一種可
 * 能，而那種 bug 沒有任何測試抓得到。座標是**壓縮字串**的索引（換回原文用 compact() 的
 * map）。刻意是 parseTrack 的 superset：多吐的 token（`o` 後面沒數字之類）上色層要標，
 * parseTrack 一律忽略。
 *
 * 每個 token 的邊界（半開區間，壓縮座標）：
 *
 *   note   [a,a+1) 字母  [a+1,accEnd) 升降  [accEnd,numEnd) 分母  [numEnd,b) 附點
 *   rest   [a,a+1) 字母  [a+1,numEnd) 分母  [numEnd,b) 附點
 *   n      [a,a+1) 字母  [a+1,pitchEnd) 卜音高  [pitchEnd,numEnd) 分母  [numEnd,b) 附點
 *   o l t v prog       [a,a+1) 字母  [a+1,numEnd) 數字  [numEnd,b) 附點（只有 l 有）
 *   oct tie bad        整個 token 就一個字元
 *
 * @param {string} t compact() 的結果（已去空白、去註解、轉小寫）
 */
export function* scanTokens(t) {
  const n = t.length;
  let i = 0;

  const readInt = () => {
    let s = "";
    while (i < n && t[i] >= "0" && t[i] <= "9") s += t[i++];
    return s === "" ? null : parseInt(s, 10);
  };
  const readDots = () => {
    let d = 0;
    while (t[i] === ".") { d++; i++; }
    return d;
  };

  while (i < n) {
    const a = i;
    const c = t[i++];

    if (STEP[c] !== undefined) {
      let semi = STEP[c];
      while (t[i] === "+" || t[i] === "#" || t[i] === "-") semi += t[i++] === "-" ? -1 : 1;
      const accEnd = i;
      const num = readInt();
      const numEnd = i;
      const dots = readDots();
      yield { kind: "note", a, b: i, accEnd, numEnd, semi, num, dots };
    }
    else if (c === "r" || c === "p") {
      const num = readInt();
      const numEnd = i;
      const dots = readDots();
      yield { kind: "rest", a, b: i, numEnd, num, dots };
    }
    else if (c === "n") {
      const pitch = readInt();
      const pitchEnd = i;
      // 水沒有音高就到此為止，**不去讀長度**：`n.` 的那個點要留給下一輪變成看不懂的字元。
      if (pitch === null) { yield { kind: "n", a, b: i, pitchEnd, numEnd: i, pitch, num: null, dots: 0 }; continue; }
      const num = readInt();
      const numEnd = i;
      const dots = readDots();
      yield { kind: "n", a, b: i, pitchEnd, numEnd, pitch, num, dots };
    }
    else if (c === "l") {
      const num = readInt();
      const numEnd = i;
      // 附點只在真的有分母時才吃。`l.` 的點同上，留給下一輪報錯。
      const dots = num === null ? 0 : readDots();
      yield { kind: "l", a, b: i, numEnd, num, dots };
    }
    // o t v 與 @ 都只吃一個整數，不吃附點：`o5.` 的那個點是看不懂的字元。
    else if (c === "o" || c === "t" || c === "v") {
      const num = readInt();
      yield { kind: c, a, b: i, numEnd: i, num, dots: 0 };
    }
    // @ 是 3MLE 系工具的樂器指令。這裡不模擬換樂器，但要吃掉它 —— 不吃的卜話 @1 會被當成
    // 兩個看不懂的字元報兩條警告。mml-compress.js 讀得也吐得出 @，兩邊要認同一套字彙。
    else if (c === "@") {
      const num = readInt();
      yield { kind: "prog", a, b: i, numEnd: i, num, dots: 0 };
    }
    else if (c === ">" || c === "<") yield { kind: "oct", a, b: i, dir: c === ">" ? 1 : -1 };
    else if (c === "&") yield { kind: "tie", a, b: i };
    // 和弦 `[ceg]` **退役了**：瑪奇的空白樂譜每軌只收單音，而 `gameSafeTrack` 一直都在
    // 兩個出口把它擋掉 —— 它沒有一條路通到遊戲。`[` `]` 現在落到最後那個 else 變成 bad。
    // 後果要知道：裡面的 `c` `e` `g` 是**照單音讀進來的**，所以舊譜不是整段消失，而是變
    // 成三個依序的音（那一拍變成三拍，後面整段往後位移）。
    else yield { kind: "bad", a, b: i };
  }
}

// ─── 解析 ───────────────────────────────────────────────────────────────────

/**
 * 每個分頁一軌，一起解析。**分兩階段**：先各軌獨立算出 tick，再用一張「所有軌合併出來的
 * 速度圖」把 tick 換成秒。每軌自己帶 tempo 邊走邊換算的話，只有第一軌寫 t100 的譜會變成
 * 第一軌 100 BPM、其餘 120 BPM，越播越歪。
 *
 * @param {string[]} texts 各分頁竹的原始文字
 * @returns {{tracks:{notes:{midi,start,dur,tick,durTick,vel,srcStart,srcEnd}[],
 *            rests:object[], vels:{tick:number,v:number}[],
 *            end:number, endTick:number}[],
 *            tempos:{tick:number,bpm:number}[], duration:number, warnings:string[]}}
 */
export function parseAll(texts) {
  const warnings = [];
  const raws = texts.map((raw, idx) => parseTrack(raw, idx, warnings));

  // 合併速度圖：任一軌寫的 t，從那個 tick 起對所有軌生效。
  // 同一個 tick 有多軌都寫（大家開頭都放 t100 是常態），以軌序小的為準。
  const evs = raws.flatMap((tr, trk) => tr.tempos.map(ev => ({ ...ev, trk })));
  evs.sort((a, b) => a.tick - b.tick || a.trk - b.trk);
  const tempos = [];
  for (const ev of evs) {
    if (tempos.length && tempos[tempos.length - 1].tick === ev.tick) continue;
    tempos.push({ tick: ev.tick, bpm: ev.bpm });
  }

  const clock = makeClock(tempos);
  const tracks = raws.map(tr => ({
    notes: tr.notes.map(n => {
      const start = clock(n.tick);
      return {
        midi: n.midi, vel: n.vel, tick: n.tick, durTick: n.dur,
        start, dur: Math.max(0.001, clock(n.tick + n.dur) - start),
        srcStart: n.srcStart, srcEnd: n.srcEnd,
      };
    }),
    // 休止符只有 tick 域的戈資訊。它存在的唯一理由是播放時要把 MML 的高亮停在 `r` 上。
    rests: tr.rests,
    // 力度事件**留在各軌**，不像 tempos 那樣合併成全曲一張圖：`v` 是純軌內狀態，合併就
    // 是說謊。所以尺上的力度標記顯示的是**當前那一軌**的，跟 T 標記（全曲共用）不同。
    vels: tr.vels,
    end: clock(tr.endTick),
    endTick: tr.endTick,
  }));

  const duration = Math.max(0, ...tracks.map(t => t.end));
  return { tracks, tempos, duration, warnings };
}

/**
 * 單軌 → tick 域的音符與速度事件。這裡完全不碰秒。每個音符帶 srcStart / srcEnd，是它在
 * **原始文字**裡的半開區間；連結線合併出來的音，區間會蓋住所有被併進來的段。
 */
export function parseTrack(raw, idx, warnings) {
  const label = i18n.trackName(idx);
  const { t, map, hasComma } = compact(raw);

  // 一個分頁只放一軌。有逗號通常是整串 MML 被貼進單一分頁了。
  if (hasComma) warnings.push(i18n.t("mml.warn.comma", { track: label }));

  const notes = [], rests = [], tempos = [], vels = [];
  let tick = 0, endTick = 0;
  let octave = 4, vel15 = 8;
  let defLen = 4, defDots = 0;   // l 的分母與它自己的附點，分開存
  let tieNext = false;
  let foldWarned = false;        // 音高折八度只講一次，不然一軌可以噴幾百條

  /**
   * token 竹的長度 → tick：`c8.` 明寫分母、附點吃在分母上；`c.` 沒寫分母，附點吃在「l 的
   * 分母」上而**不是**「l 連同它的附點」（`l4.` 之後的 `c.` 是 1.5 拍不是 2.25 拍）；
   * `c` 什麼都沒寫，整個用 l 的分母加它的附點。
   */
  const durOf = tok =>
    tok.num !== null ? lenTicks(tok.num, tok.dots)
      : tok.dots > 0 ? lenTicks(defLen, tok.dots)
        : lenTicks(defLen, defDots);
  /** 壓縮索引的半開區間 [a,b) → 原文的半開區間。 */
  function span(a, b) {
    const s = map[a] ?? 0;
    return { srcStart: s, srcEnd: (map[b - 1] ?? s) + 1 };
  }
  function push(midi, dur, a, b) {
    // 折八度：`o<n>`、升降記號、`<` `>` 與 n 指令都能跑到 o1c–o7b 之外，而捲軸只有 84
    // 列。這裡是保證「每個音都畫得出來」的唯一一道關 —— **不是音域政策**。
    const m = foldIntoRange(midi);
    if (m !== midi && !foldWarned) {
      warnings.push(i18n.t("mml.warn.pitchFolded",
        { track: label, lo: pitchName(PITCH_MIN), hi: pitchName(PITCH_MAX) }));
      foldWarned = true;
    }
    const { srcStart, srcEnd } = span(a, b);
    const prev = notes[notes.length - 1];
    // 連結線：同音高且緊接在後面才併，否則當成獨立的音（時間一木樣往前走）
    if (tieNext && prev && prev.midi === m && prev.tick + prev.dur === tick) {
      prev.dur += dur;
      prev.srcEnd = srcEnd;      // 併進來的那段也算這個音的文字範圍
    } else {
      notes.push({
        midi: m, tick, dur,
        vel: Math.max(1, Math.round(vel15 * 127 / 15)),
        srcStart, srcEnd,
      });
    }
    tieNext = false;
    tick += dur;
    endTick = Math.max(endTick, tick);
  }

  for (const tok of scanTokens(t)) {
    const { kind, a, b } = tok;

    if (kind === "note") push(octave * 12 + OCT_BASE + tok.semi, durOf(tok), a, b);
    else if (kind === "rest") {
      // 休止符也要帶原文位置：播放時高亮走到這裡，MML 要停在這個 r 上。它不是音符，
      // 所以不進 notes。
      const dur = durOf(tok);
      const { srcStart, srcEnd } = span(a, b);
      rests.push({ tick, dur, srcStart, srcEnd });
      tick += dur;
      endTick = Math.max(endTick, tick);
      tieNext = false;
    }
    else if (kind === "n") {
      if (tok.pitch === null) { warnings.push(i18n.t("mml.warn.nNoNumber", { track: label })); continue; }
      push(N_BASE + tok.pitch, durOf(tok), a, b);
    }
    // **八度指針一律不夾範圍** —— 卜音域只由 push() 的 foldIntoRange 那一道關負責。夾指針
    // 壞掉的不是那個音本身，而是**它會改掉後面所有音的八度**：
    //
    //     o1a+>a+     夾指針：o1→o2，於是 `>a+` 變成 o3a+ —— 高了一個八度
    //                 不夾：  o1a+ 折成 o2a+，`>a+` 還是 o2a+ —— 對的
    //
    // DEMO 與 3MLE 的對照語料兩份都踩得到。
    else if (kind === "o") { if (tok.num !== null) octave = tok.num; }
    else if (kind === "oct") octave += tok.dir > 0 ? 1 : -1;
    else if (kind === "l") { if (tok.num !== null) { defLen = Math.max(1, tok.num); defDots = tok.dots; } }
    else if (kind === "t") { if (tok.num !== null) tempos.push({ tick, bpm: clamp(tok.num, 32, 255) }); }
    // v 記事件是為了小節尺上的力度標記。**留 0–15 的原始值**，不是 note.vel 那個換算過的
    // 1–127 —— 換回來會因為 round 而對不上（vel15 8 → 68 → 8.03）。
    else if (kind === "v") {
      if (tok.num !== null) { vel15 = clamp(tok.num, 0, 15); vels.push({ tick, v: vel15 }); }
    }
    else if (kind === "tie") tieNext = true;
    // prog（@n）是純粹被吃掉的 —— 理由見 scanTokens 那邊竹的註解。
    else if (kind === "prog") continue;
    // 和弦已退役（見 scanTokens）：`[` `]` 現在是 bad，掉到這裡跟其他看不懂的字元一起報。
    else warnings.push(i18n.t("mml.warn.badChar", { track: label, char: t[a] }));
  }
  return { notes, rests, tempos, vels, endTick };
}
