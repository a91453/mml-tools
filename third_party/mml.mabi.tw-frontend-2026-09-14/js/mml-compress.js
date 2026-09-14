// mml-compress.js —— 瑪奇 MML 無損壓縮 + MML 產生器
//
//   const r = compressMML(src, { verifyWith: s => parseAll(splitMML(s)) });
//   r.mml   壓縮結果（驗證沒過就是原字串）
//   r.ok    true 通過 / false 沒過已退回 / null 沒驗證
//
// 兩半：tokenize()（MML → items，絕對音高 + 精確時值，o / < / > / l 全部丟掉）與 itemsToMML()
// （items → 字數最省的 MML）。後半也是鋼琴捲軸寫回 MML 的唯一路徑 —— 改它要同時想到兩個呼叫端。
//
// 時值一律用 tick（整數，PPQ=480），直接匯入 mml.js 的 lenTicks。早期版本自己用精確分數算，於是
// 1920 除不盡的長度兩邊對不上（l7 在 parser 是 274 tick，在分數模型是 274.2857）。
//
// items 只剩 note / rest / t / v / @ 五種 —— 和弦退役了，而那正好日是「一軌是單音的」這個模型本來就
// 假設的形狀。

import { lenTicks, compact, scanTokens, parseAll, bareTrack } from "./mml.js";
import * as i18n from "./i18n.js";
import {
  OCT_BASE, N_BASE, OCT_MIN, OCT_MAX, PITCH_MIN, PITCH_MAX, foldIntoRange,
  BAR_TICKS, CELL_TICKS, barIndexOf, barStartTick,
} from "./config.js";

// ── 設定 ────────────────────────────────────────────────────────────────────

/**
 * 一個時值最多拆成幾段 &。壓縮與產生用同一個算法（writeTieSegs）—— 原本壓縮寫死 3，那把「單一時值
 * 划不划算」執行成了整軌的否決權：一個需要 4 段的時值就讓 itemsToMML 回 null、整軌原樣退回（省 62%
 * → 省 0%）。而「划不划算」本來就有一個按軌看真實字數的判斷（compressMML 的 out.length 比較）。
 */
const MAX_TIE_SEGS = 3;
const WRITE_TIE_SEGS = 8;
const WRITE_TIE_SEGS_CAP = 24;   // 病態輸入的煞車，DP 狀態數跟這個成正比

const MAX_L_CANDIDATES = 12;

/** Per-track search allowance; formatting and comments are excluded by callers. */
export const budgetFor = chars => chars > 4000 ? 400000 : 200000;

// 安全原則：不引入遊戲吃不下的記法。壓縮器可能算出 l3... 這種在數學上正確但遊戲不一定吃的寫法，
// 而 verifyWith 用的是本站自己的 parser、抓不到 —— 「壓完的譜貼進遊戲被拒」沒有任何測試會叫。
const STD_NUMS = [1, 2, 3, 4, 6, 8, 12, 16, 24, 32, 48, 64];
/** 同一組值，給「這個分母標準嗎」用。gameLegal 是逐軌問的，別在迴圈裡重建 Set。 */
const STD_SET = new Set(STD_NUMS);

/**
 * 一個時值最多幾個附點。1 —— 遊戲的空白樂譜不吃 `..`，貼進去會被拒。
 *
 * 原本是 2，而且取樣寫成 `maxDots || DEFAULT_MAX_DOTS` —— 「一人個附點都沒有」是 0（falsy），於是沒有
 * 附點的譜反而拿到 2。而 itemsToMML 那條路（捲軸寫回、MIDI 匯入）根本沒有原譜可以取樣。落在捲軸格
 * 線上的複附點值（7／14／28／56 格）在真實音樂裡到處都是，不是邊角案例。
 */
const DEFAULT_MAX_DOTS = 1;

const STEP = { c: 0, d: 2, e: 4, f: 5, g: 7, a: 9, b: 11, h: 11 };

/** 跟 parser 的初始狀態一致（js/mml.js parseTrack 開頭）。 */
const DEFAULTS = { octave: 4, lenNum: 4, lenDots: 0, vol: 8, bpm: 120 };

const digits = n => String(n).length;

/**
 * 這個 item 佔時間嗎（= 它的 dur 要算進 tick）。跟「佔不佔一個 `pick` 名額」的過濾條件刻意分開寫 ——
 * 混用會讓 pick 的索引錯位。
 */
const hasDur = it => it.k === "note" || it.k === "rest";

// ── tokenize ────────────────────────────────────────────────────────────────

/**
 * 把一軌拆成中介表示。回傳 { items, seenNums, dropped }。items 只留音符、休止、t、v、@。
 *
 * 這個函式不會失敗。以前它對三件事回 `{ error }` 而呼叫端把它當成「整軌唯讀」，於是一個 `r+` 的筆誤
 * 就讓那一軌永遠編不了 —— 而 parseTrack 對同樣三件事只是 warn 然後跳過。
 *
 * 音高、八度夾範圍、連結線合併規則都必須跟 mml.js 的 parseTrack 逐條一致。前置處理直接用
 * mml.compact()：自己寫 `replace(/\s+/g,"")` 會漏掉卜註解與 MML@ 外殼。
 */
function tokenize(raw, opts = {}) {
  // 換一把尺**只有 mml-in 的 MabiIcco 還原走這條**（見 mml-in.restoreStandard）。預設一律是
  // lenTicks —— 站內其餘所有呼叫端的行為一個 tick 都沒變。
  const ticksOf = opts.ticksOf ?? lenTicks;
  const { t } = compact(raw);
  const items = [];
  const seenNums = new Set();
  let dropped = 0;              // 丟掉的垃圾字元數，呼叫端拿去提示使用者
  let i = 0;
  let octave = DEFAULTS.octave;
  let lenNum = DEFAULTS.lenNum, lenDots = DEFAULTS.lenDots;

  // 連結線：照 parser 的規則做 —— 同音高、而且前一個音剛好結束在現在這個 tick，
  // 才併成一個音。中間夾休止就不算相鄰；夾 v / t / o 這類不佔時間的指令不影響。
  let tick = 0, tieNext = false;
  let lastNote = null, lastNoteEnd = -1;
  // 最後那個音在 items 裡的位置與它的起始 tick。**只有 t 的重新定位需要它們**，
  // 見 pushNote 裡那段。
  let lastNoteIdx = -1, lastNoteStart = 0;

  const readInt = () => {
    let s = "";
    while (i < t.length && t[i] >= "0" && t[i] <= "9") s += t[i++];
    return s === "" ? null : parseInt(s, 10);
  };
  // 附點數**刻意不回報**（分母有 seenNums，附點沒有對應的東西）：原譜用了 `..`
  // 不代表那份原譜貼得進遊戲，照抄只會把一份壞掉的譜原封不動傳下去。見 DEFAULT_MAX_DOTS。
  const readDots = () => {
    let d = 0;
    while (t[i] === ".") { d++; i++; }
    return d;
  };

  /** 跟 parser 完全同一套規則：有數字→用數字；沒數字但有附點→用 l 竹的無附點基底。 */
  const readDur = () => {
    const num = readInt();
    if (num !== null) { seenNums.add(Math.max(1, num)); return ticksOf(num, readDots()); }
    if (t[i] === ".") return ticksOf(lenNum, readDots());
    return ticksOf(lenNum, lenDots);
  };

  /**
   * 併進前一個音之前，把夾在中間的 `t` 搬到那個音前面，並記下它在音裡的位移。
   *
   * `c4t150&c2.` 在 parser 眼裡是「一個 1920 tick 的音，而速度在 480 變了」。tokenize 併成一個 item
   * 是對的，但 `{k:"t"}` 留在音符後面、而 items 靠位置表達 tick，所以重新產生會寫成 `c1t150` —— 速
   * 度變化從 480 跳到 1920，tick 域完全看不出來。
   *
   * 只搬 `t` 不搬 `v` / `@`：那兩個夾在音中間時影響的是下一個音，搬到前面反而會改到聲音。
   */
  const relocateTempos = () => {
    if (items.length <= lastNoteIdx + 1) return;
    const between = items.splice(lastNoteIdx + 1);
    const moved = [], stay = [];
    for (const x of between) (x.k === "t" ? moved : stay).push(x);
    if (moved.length) {
      for (const x of moved) x.delay = tick - lastNoteStart;
      items.splice(lastNoteIdx, 0, ...moved);
      lastNoteIdx += moved.length;
    }
    items.push(...stay);
  };

  const pushNote = midi => {
    const dur = readDur();
    // 跟 parser 同一道關：卜音域外的音折八度塞回來（config.foldIntoRange）。兩邊必須是同一個函式 ——
    // 對不上的話 verifyWith 會在「音樂沒變」這件事上放過真正的差異。
    const m = foldIntoRange(midi);
    if (tieNext && lastNote && lastNote.midi === m && lastNoteEnd === tick) {
      relocateTempos();
      lastNote.dur += dur;
    } else {
      lastNote = { k: "note", midi: m, dur };
      lastNoteStart = tick;
      lastNoteIdx = items.length;
      items.push(lastNote);
    }
    lastNoteEnd = tick + dur;
    tick += dur;
    tieNext = false;
  };

  while (i < t.length) {
    const c = t[i++];

    if (STEP[c] !== undefined) {
      let semi = STEP[c];
      while (t[i] === "+" || t[i] === "#" || t[i] === "-") semi += t[i++] === "-" ? -1 : 1;
      pushNote(octave * 12 + OCT_BASE + semi);
    }
    else if (c === "r" || c === "p") {
      const dur = readDur();
      items.push({ k: "rest", dur });
      tick += dur;
      tieNext = false;
    }
    else if (c === "n") {
      const n = readInt();
      // parseTrack 對這個是 warn + continue（不吃掉後面的時人值），照抄
      if (n === null) { dropped++; continue; }
      pushNote(N_BASE + n);
    }
    else if (c === "o") { const n = readInt(); if (n !== null) octave = n; }
    // 八度指針不夾範圍，跟 parser 一致 —— 理由見 mml.js parseTrack 裡那段註解：
    // 夾指針會改掉**後面**所有音的八度。音域只由 pushNote 的 foldIntoRange 負責。
    else if (c === ">") octave += 1;
    else if (c === "<") octave -= 1;
    else if (c === "l") { const n = readInt(); if (n !== null) { lenNum = Math.max(1, n); seenNums.add(lenNum); lenDots = readDots(); } }
    else if (c === "t") { const n = readInt(); if (n !== null) items.push({ k: "t", v: n }); }
    else if (c === "v") { const n = readInt(); if (n !== null) items.push({ k: "v", v: n }); }
    else if (c === "@") { const n = readInt(); if (n !== null) items.push({ k: "@", v: n }); }
    else if (c === "&") tieNext = true;
    // 看不懂的字元丟掉（`[` `]` 現在也走這條）。parseTrack 對它們就是 warn + 跳過，讓一個 `r+` 的
    // 筆誤鎖死整軌的編輯完全不成比例。丟掉而不是原文透傳：透傳一個孤立的 `+`，重新產生之後它前面
    // 那個 token 可能剛好以音名結尾，於是 `c` 和 `+` 黏成 `c+`、卜音高被無聲改掉。
    else dropped++;
  }
  return { items, seenNums, dropped };
}

// ── 長度編碼 ────────────────────────────────────────────────────────────────

/**
 * 把「允許使用的長度寫法」攤成查表結構，建 cfg 時算一次。以前是每次查詢都重算 lenTicks，而
 * encodeDur 的內圈會跑到幾十萬次 —— 一個 4 小節長的單音要 130ms 才寫得出來。
 */
function buildTokens(nums, maxDots, alignTo = 1) {
  const byTicks = new Map();      // ticks → 最短的長度字串（"16." 這種）
  const allByTicks = new Map();   // ticks → 所有 {num,dots} 拼法
  for (const num of nums) {
    for (let dots = 0; dots <= maxDots; dots++) {
      const ticks = lenTicks(num, dots);
      // 分母大到算完不足一個 tick（l3000）：這種寫法沒有意義，而且會讓
      // encodeDur 的遞迴永遠不收斂
      if (ticks <= 0) continue;
      // 對不上輸入格線的長度不必試，見 makeEncoderCfg 的 alignTo
      if (alignTo > 1 && ticks % alignTo !== 0) continue;
      const str = String(num) + ".".repeat(dots);
      const cur = byTicks.get(ticks);
      if (cur === undefined || str.length < cur.length) byTicks.set(ticks, str);
      if (!allByTicks.has(ticks)) allByTicks.set(ticks, []);
      allByTicks.get(ticks).push({ num, dots });
    }
  }
  // 由大到小，讓 encodeDur 先試大竹的：遞迴淺、剪枝早
  const heads = [...byTicks.keys()].sort((a, b) => b - a);
  return { byTicks, allByTicks, heads };
}

/** 列出所有能精確表示 ticks 的 (num, dots)。 */
const spellings = (ticks, cfg) => cfg.tokens.allByTicks.get(ticks) ?? [];

/** 單一 token 能不能表示 ticks？回傳最短寫法，不行回傳 null。 */
function spellOne(ticks, lnum, ldots, cfg) {
  const key = `${ticks}|${lnum}.${ldots}`;
  const hit = cfg.spellMemo.get(key);
  if (hit !== undefined) return hit;

  let best;
  if (ticks === lenTicks(lnum, ldots)) best = "";           // 完全等於預設 → 不用寫
  else {
    best = null;
    for (let d = 1; d <= cfg.maxDots; d++)                  // 只寫附點，基底用 L 的無附點值
      if (ticks === lenTicks(lnum, d)) { best = ".".repeat(d); break; }
    const w = cfg.tokens.byTicks.get(ticks);
    if (w !== undefined && (best === null || w.length < best.length)) best = w;
  }
  cfg.spellMemo.set(key, best);
  return best;
}

/**
 * 在預設長度 L 之下把 ticks 寫成日最短的長度字串。回傳 { segs, cost, head }，多段代表要用 & 串。
 * `head` 是第一段佔幾個 tick，planDefaultLength 拿它當「切 l 的位置」候選。
 *
 * 不能用貪心：「先取最大能表示的值」會挑出 d3..&d24（8 字）而不是 d2&d8（5 字）。
 */
function encodeDur(ticks, lnum, ldots, cfg, segsLeft = cfg.maxTieSegs) {
  const mk = `${ticks}|${lnum}.${ldots}|${segsLeft}`;
  if (cfg.memo.has(mk)) return cfg.memo.get(mk);
  if (cfg.budget-- <= 0) { cfg.exhausted = true; return null; }
  cfg.memo.set(mk, null);                                   // 佔位，避免重入

  if (ticks === 0) { const r = { segs: [], cost: 0, head: 0 }; cfg.memo.set(mk, r); return r; }

  const one = spellOne(ticks, lnum, ldots, cfg);
  let best = one === null ? null : { segs: [one], cost: one.length, head: ticks };

  // 單一 token 就寫得出來且很短時，不可能被拆法打敗：
  // 任何兩段拆法至少要 head + "&" + 音名 + tail ≥ 3 字。
  if (best && best.cost <= 3) { cfg.memo.set(mk, best); return best; }
  if (segsLeft <= 1) { cfg.memo.set(mk, best); return best; }

  // heads 已經去重、由大到小排好，而且不含 0（那種永遠不收斂）
  for (const head of cfg.tokens.heads) {
    if (head >= ticks) continue;                            // 必須真的變小才會收斂
    const hs = spellOne(head, lnum, ldots, cfg);
    if (hs === null) continue;
    // 剪枝：tail 戈成本不可能是負的，所以這一支已經贏不了就別展開
    if (best && hs.length + 2 >= best.cost) continue;
    const tail = encodeDur(ticks - head, lnum, ldots, cfg, segsLeft - 1);
    if (!tail) continue;
    const cost = hs.length + 2 + tail.cost;                 // & 加上重複的音名
    if (!best || cost < best.cost) best = { segs: [hs, ...tail.segs], cost, head };
  }

  cfg.memo.set(mk, best);
  return best;
}

/**
 * encodeDur 的正式入口：先便宜地試，寫不出來才升級。不直接把 maxTieSegs 開大，因為 memo key 含
 * segsLeft 而遞迴深度就是它 —— 從 3 開到 24 讓整組測試從 2 秒變 100 秒以上，而需要深拆的時值是極少
 * 數（897 個 item 裡只有一個）。
 */
function encodeDurUp(ticks, lnum, ldots, cfg) {
  const cheap = encodeDur(ticks, lnum, ldots, cfg, cfg.maxTieSegs);
  if (cheap || cfg.maxTieSegsMax <= cfg.maxTieSegs) return cheap;

  // 深搜之前先試「只用整除 ticks 的長度」。這是效能不是正確性：狀態數是 O(ticks × 段數)，一個
  // 28080 tick 的長休止要 11 秒。代價是粗步長可能找到比較長的合法解，而那個解就這樣被採月用了。
  const aligned = encodeDurAligned(ticks, lnum, ldots, cfg);
  if (aligned) return aligned;
  return encodeDur(ticks, lnum, ldots, cfg, cfg.maxTieSegsMax);
}

const durCost = enc => (enc ? enc.cost : Infinity);

// ── DP：排 l 的切換點 ───────────────────────────────────────────────────────

/** `l16.` 這個切換指令本身佔幾個字。 */
const switchCostOf = c => 1 + digits(c.num) + c.dots;

/**
 * 切在 item 中間時，被切出來的第二段要付的固定成本：`&` 加上重複一次音名。跟 encodeDur 拆段用同一
 * 個數字（見那裡的 `hs.length + 2 + tail.cost`）。
 */
const SPLIT_JOIN = 2;

/**
 * DP：`l` 的切換點排在哪裡。每個 item 兩種寫法：整個 item 用同一個 L（要換就在 item 前面寫
 * `l<n>`），或切點落在 item 中間（第一段用進來時的 L，然後才 `l<n>`）。
 *
 * 後者不是零頭 —— 一個「附點 + 短尾巴」的音剛好是兩種 L 各寫一段最省：`b.&b32r32`（l8 一路寫到底）
 * 9 字、`l32b8.&br`（在 item 前面切）10 字、`b.l32&br`（切在第一段之後）8 字。少了它，「切進 l32」
 * 在整段 32 分音符前面永遠差一兩個字划不來，實測一首 2353 字的譜光這一條就佔 15 字。
 *
 * 限制：只切在第一段之後（允許任意切點要把「已經寫掉幾 tick」也放進狀態）。實測 3MLE 的輸出裡 18
 * 個 item 內切點全部落在這裡。
 */
function planDefaultLength(items, cfg) {
  const durs = items.filter(x => x.k === "note" || x.k === "rest");
  if (!durs.length) return { cands: [{ num: DEFAULTS.lenNum, dots: DEFAULTS.lenDots }], pick: [], startK: 0 };

  // 候卜選只取「實際出現過的時值」的拼法——切到沒人用的 L 一定被支配
  const freq = new Map();
  for (const it of durs) {
    for (const sp of spellings(it.dur, cfg)) {
      const k = `${sp.num}.${sp.dots}`;
      freq.set(k, (freq.get(k) || 0) + 1);
    }
  }
  const cands = [...freq.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, MAX_L_CANDIDATES)
    .map(([k]) => { const [num, dots] = k.split("."); return { num: +num, dots: +dots }; });

  const dflt = { num: DEFAULTS.lenNum, dots: DEFAULTS.lenDots };
  if (!cands.some(c => c.num === dflt.num && c.dots === dflt.dots)) cands.unshift(dflt);
  const startK = cands.findIndex(c => c.num === dflt.num && c.dots === dflt.dots);

  const K = cands.length;
  let dp = cands.map((_, k) => (k === startK ? 0 : Infinity));
  const back = [];
  const tails = new Map();      // head → 各候選 L 之下「剩下那段」的編碼，逐 item 清掉

  for (const it of durs) {
    const enc = cands.map(c => encodeDurUp(it.dur, c.num, c.dots, cfg));
    const ndp = new Array(K).fill(Infinity);
    const from = new Array(K).fill(null);

    // (a) 整人個 item 用同一個 L。切換成本只看目的地，所以來源取「目前最便宜的那個」就夠。
    let bestPrev = 0;
    for (let k = 1; k < K; k++) if (dp[k] < dp[bestPrev]) bestPrev = k;
    for (let k = 0; k < K; k++) {
      const cost = durCost(enc[k]);
      if (cost === Infinity) continue;
      const stay = dp[k];
      const move = dp[bestPrev] + switchCostOf(cands[k]);
      if (stay <= move) { ndp[k] = stay + cost; from[k] = { prev: k, head: 0 }; }
      else { ndp[k] = move + cost; from[k] = { prev: bestPrev, head: 0 }; }
    }

    // (b) 切點落在第一段之後，第一段用來源的 L 寫，所以不能只看 bestPrev。head 只試「照來源的 L
    // 正常拆時的第一段」—— 試所有長度會讓 encodeDurUp 收到幾十個新的 tick 值（memo 全部落空），實
    // 測整組測試從 8 秒變戈成 8 分鐘。
    tails.clear();
    for (let s = 0; s < K; s++) {
      if (dp[s] === Infinity) continue;
      const e = enc[s];
      if (!e || e.segs.length < 2) continue;            // 單段就沒有「第一段之後」
      const head = e.head, hsLen = e.segs[0].length;
      let byL = tails.get(head);
      if (!byL) {
        const rest = it.dur - head;
        byL = cands.map(c => encodeDurUp(rest, c.num, c.dots, cfg));
        tails.set(head, byL);
      }
      for (let k = 0; k < K; k++) {
        if (k === s || !byL[k]) continue;               // k === s 就是 (a)，不是切換
        const c = dp[s] + hsLen + SPLIT_JOIN + switchCostOf(cands[k]) + byL[k].cost;
        if (c < ndp[k]) { ndp[k] = c; from[k] = { prev: s, head }; }
      }
    }

    back.push(from);
    dp = ndp;
  }

  let k = 0;
  for (let j = 1; j < K; j++) if (dp[j] < dp[k]) k = j;
  if (dp[k] === Infinity) return null;                  // 有時值編不出來 → 放棄

  // pick[i] = { kIn, kOut, head }
  //   kIn  進到這個 item 時的預設長度（= 上一個 item 的 kOut，第一個是 startK）
  //   kOut 寫完這個 item 之後的預設長度
  //   head >0 = 前 head tick 用 kIn 寫，然後才切到 kOut；0 = 整個 item 都用 kOut
  const pick = new Array(durs.length);
  for (let i = durs.length - 1; i >= 0; i--) {
    const b = back[i][k];
    pick[i] = { kIn: b.prev, kOut: k, head: b.head };
    k = b.prev;
  }
  return { cands, pick, startK };
}

/**
 * **照實模式**的長度計畫：整軌固定一個 `l`，不換。
 *
 * `planDefaultLength` 的 DP 產出的是**字數最省**的譜。那對「貼進遊戲」是對的，對**編輯**是災難 ——
 * 它會為了省字在整軌裡到處切換 `l`，而長休止符更是會把整軌的 `l` 搶去當 `l1.`（票數是照整軌總字數
 * 投的），逼得後面每個音符都要寫成 `c16&c64` 這種連結線。實測 `l19. c r1×9 d` 會被壓成
 * `l1.c16&c64rrrrrrd16&d64` —— 無損、最短、而且沒有人讀得懂。
 *
 * 所以站上所有**產生** MML 的路徑走這裡，壓縮只在使用者按「優化」時發生。
 *
 * 挑法是票數：每個時值的每一種拼法各投一票，最高票的當預設長度。同票時偏無附點（`l8` 比 `l16.`
 * 好讀），再偏靠近 `l4`（那是 parser 的起點，也是人看 MML 時的基準）。**採用前要確認整軌每個時值
 * 在那個 `l` 之下都寫得出來** —— 寫不出來就換下一個候選，全部落空才回 null 讓呼叫端落回 DP。
 *
 * 回傳的形狀跟 planDefaultLength 一樣，所以 emitTrack / planSegs / planSpelling 一行都不必改。
 * `cands` 一定含 `l4`（parser 的起點，`startK` 指向它），選中的排第二；每個 item 的 `head` 都是 0，
 * 於是 planSegs 只看 `kOut`、`kIn` 用不到。
 */
function plainPlan(items, cfg) {
  const dflt = { num: DEFAULTS.lenNum, dots: DEFAULTS.lenDots };
  const durs = items.filter(x => x.k === "note" || x.k === "rest");
  if (!durs.length) return { cands: [dflt], pick: [], startK: 0 };

  const freq = new Map();
  for (const it of durs)
    for (const sp of spellings(it.dur, cfg)) {
      const k = `${sp.num}.${sp.dots}`;
      freq.set(k, (freq.get(k) || 0) + 1);
    }

  const ranked = [...freq.entries()]
    .map(([k, n]) => {
      const [num, dots] = k.split(".");
      return { num: +num, dots: +dots, n };
    })
    // 票數 → 附點少的 → 離 l4 近的 → 分母小的（最後一條只為了決定性，不為了好看）
    .sort((a, b) => b.n - a.n || a.dots - b.dots
      || Math.abs(a.num - dflt.num) - Math.abs(b.num - dflt.num) || a.num - b.num);

  //  一票都沒有的譜（每個時值都拼不出單一 token）仍然要有個起點，而 l4 永遠是合法的候選。
  if (!ranked.some(c => c.num === dflt.num && c.dots === dflt.dots)) ranked.push({ ...dflt, n: 0 });

  for (const c of ranked) {
    if (!durs.every(it => encodeDurUp(it.dur, c.num, c.dots, cfg) !== null)) continue;
    const isDflt = c.num === dflt.num && c.dots === dflt.dots;
    const k = isDflt ? 0 : 1;
    return {
      cands: isDflt ? [dflt] : [dflt, { num: c.num, dots: c.dots }],
      pick: durs.map(() => ({ kIn: k, kOut: k, head: 0 })),
      startK: 0,
    };
  }
  return null;
}

/**
 * 照長度計畫，算山出一個 item 要寫成哪幾段，以及 `l` 插在哪裡。planSpelling 與 emitTrack 必須看到同一
 * 個答案 —— 分開實作的話段數算錯不會壞掉，只會安靜地變長。
 *
 * @returns {{segs:string[], lAt:number}|null} lAt = 0 代表 `l` 寫在整個 item 前面；>0 代表第 lAt-1 段之後
 */
function planSegs(it, p, cands, cfg) {
  if (p.head > 0) {
    const ci = cands[p.kIn], co = cands[p.kOut];
    const hs = spellOne(p.head, ci.num, ci.dots, cfg);
    const tail = encodeDurUp(it.dur - p.head, co.num, co.dots, cfg);
    if (hs === null || !tail) return null;
    return { segs: [hs, ...tail.segs], lAt: 1 };
  }
  const c = cands[p.kOut];
  const enc = encodeDurUp(it.dur, c.num, c.dots, cfg);
  return enc ? { segs: enc.segs, lAt: 0 } : null;
}

/**
 * 一段長度字串在預設長度 c 之下佔幾個 tick。規則跟 spellOne 產生它時完全一樣：
 * 有數字就用數字，只有附點就用 L 的**無附點**基底，空字串就日是 L 本身。
 */
function segTicks(str, c) {
  const m = /^(\d*)(\.*)$/.exec(str);
  if (!m) return 0;
  if (m[1]) return lenTicks(+m[1], m[2].length);
  return m[2] ? lenTicks(c.num, m[2].length) : lenTicks(c.num, c.dots);
}

// ── 輸出 ────────────────────────────────────────────────────────────────────

const SPELL = ["c", "c+", "d", "d+", "e", "f", "f+", "g", "g+", "a", "a+", "b"];

/**
 * 一個 MIDI 音高有哪些寫法（每一種都帶「寫完之後停在哪個八度」）。跨八度邊界的音可以用升降記號改
 * 寫，關鍵是它不動八度狀態、後面的音也不必移回來：`o4 >c<a` 是 5 字，`o4 b+a` 是 3 字。
 *
 * 雙升／雙降刻意不放進來 —— 3 個字只有剛好省下兩次移動才划算，而「遊戲吃不吃」沒人驗過（同 `..` 的
 * 教訓）。回空陣列 = 落在 o1–o7 之外，只能走 `n<num>`。
 */
function pitchSpellings(midi) {
  const oct = Math.floor((midi - OCT_BASE) / 12);
  const semi = ((midi - OCT_BASE) % 12 + 12) % 12;
  if (oct < OCT_MIN || oct > OCT_MAX) return [];
  const out = [{ oct, text: SPELL[semi] }];
  if (semi === 0  && oct - 1 >= OCT_MIN) out.push({ oct: oct - 1, text: "b+" });
  if (semi === 11 && oct + 1 <= OCT_MAX) out.push({ oct: oct + 1, text: "c-" });
  return out;
}

/** 從八度 a 走到八度 b 的字串。差 1 用 `>`／`<`，差 2 以上用 `o<n>`（八度是一位數）。 */
const shiftTo = (a, b) => a === b ? "" : Math.abs(a - b) === 1 ? (b > a ? ">" : "<") : "o" + b;

/**
 * 一人個音高的「絕對音高」寫法 `n<num>`，不能用就回 null。它不動八度狀態，只是不受「限跨八度邊界」的
 * 限制。划算條件是那個音需要「上去、彈、再回來」：`o2 >g+<g+` 是 6 字，`o2 n44g+` 是 5 字。
 *
 * 只有裸寫法能用：接數字會被讀成音高的一部分（`n73` 接 `2` 就是 `n732`）；接附點沒有人驗過，而它的
 * 失效方式是安靜的 —— 很多 MML 的 `n` 不吃長度參數，那樣 `n72.` 會少掉一半長度而本站的 parser
 * 讀得懂，所以 verifyWith 完全比對得過。反過來不會因此去擋使用者手打的 `n72.`。
 */
const nSpelling = nt =>
  nt.bare && nt.midi >= PITCH_MIN && nt.midi <= PITCH_MAX
    ? "n" + (nt.midi - N_BASE) : null;

/**
 * DP：每個音符要用哪一種寫法。
 *
 * 需要 DP 而不是逐音貪心，因為「現在在哪個八度」是會傳下去的狀態 —— `b+` 的價值不在它自己身上
 * （`b+` 與 `>c` 都是 2 字），而在它讓後面的音不必移回來。狀態只有 7 個（o1–o7）。
 *
 * 長度與音高可以分開排，唯一的耦合是「一個音拆成幾段就要寫幾次音名」，所以這裡吃 plan 當輸入。
 *
 * @returns {{shift:string, text:string}[]|null} 照音符順序，寫不出來回 null
 */
function planSpelling(items, plan, cfg, end) {
  const { cands, pick } = plan;

  // 先收集每個音符要寫幾次音名（= 時值拆戈成幾段）
  const notes = [];
  let di = 0;
  for (let idx = 0; idx < end; idx++) {
    const it = items[idx];
    if (it.k !== "note" && it.k !== "rest") continue;
    const p = pick[di++];
    if (it.k !== "note") continue;
    const seg = planSegs(it, p, cands, cfg);
    if (!seg) return null;
    notes.push({
      midi: it.midi,
      segs: seg.segs.length,
      // 裸寫法 = 單一段而且完全不帶長度字元。`n<num>` 只在這種形狀下能用，見 nSpelling。原本記的
      // 是 `digitHead`，那條件比較鬆 —— 它放過 `n72.`，而附點是沒人在遊戲裡驗過的那一半。
      bare: seg.segs.length === 1 && seg.segs[0] === "" && seg.lAt === 0,
    });
  }
  if (!notes.length) return [];

  const N = OCT_MAX - OCT_MIN + 1;
  const at = o => o - OCT_MIN;
  let dp = new Array(N).fill(Infinity);
  dp[at(DEFAULTS.octave)] = 0;
  const back = [];

  for (const nt of notes) {
    const opts = pitchSpellings(nt.midi);
    const nText = nSpelling(nt);
    const ndp = new Array(N).fill(Infinity);
    const from = new Array(N).fill(null);

    // o1–o7 之外、而且連 `n<num>` 都用不上（不是裸寫法，見 nSpelling）就整軌放棄。
    // 實務上碰不到：tokenize 會把音高折卜進 o1c–o7b（= 捲軸那 84 列），MIDI 匯入也 clamp。
    if (!opts.length && nText === null) return null;

    for (let s = 0; s < N; s++) {
      if (dp[s] === Infinity) continue;
      for (const o of opts) {
        const t = at(o.oct);
        const shift = shiftTo(s + OCT_MIN, o.oct);
        const c = dp[s] + shift.length + nt.segs * o.text.length;
        if (c < ndp[t]) { ndp[t] = c; from[t] = { prev: s, text: o.text }; }
      }
      // `n<num>` 不動八度，所以是「留在 s」的那條邊
      if (nText !== null) {
        const c = dp[s] + nt.segs * nText.length;
        if (c < ndp[s]) { ndp[s] = c; from[s] = { prev: s, text: nText }; }
      }
    }
    back.push(from);
    dp = ndp;
  }

  let best = 0;
  for (let s = 1; s < N; s++) if (dp[s] < dp[best]) best = s;
  if (dp[best] === Infinity) return null;

  const out = new Array(notes.length);
  let s = best;
  for (let i = notes.length - 1; i >= 0; i--) {
    const b = back[i][s];
    // `n<num>` 那條不動八度，shiftTo 會算山出 ""，剛好不必特別處理
    out[i] = { shift: shiftTo(b.prev + OCT_MIN, s + OCT_MIN), text: b.text };
    s = b.prev;
  }
  return out;
}

function emitTrack(items, plan, cfg, opts, isFirstTrack) {
  const { cands, pick, startK } = plan;
  let out = "";
  let curL = startK;
  let vol = null, prog = null;   // null = 還沒被明確設定過
  let di = 0;
  let atTick = 0;                // 目前走到第幾個 tick，斷行要用
  // 夾成整數且非負：0 與任何負數／NaN 都是「不換行」。設定值是從 localStorage 讀的，被別的版本改
  // 壞過也不能讓它變成 % 0（那會回 NaN、條件永遠 false，安靜地不換行）。
  const barsPerLine = Number.isFinite(opts.barsPerLine) && opts.barsPerLine > 0
    ? Math.floor(opts.barsPerLine) : 0;
  // 「每 n 小節」的下一個門檻。不是 `BAR_TICKS * n` 的倍數 —— 小節不等長之後那個乘法就不指向小節
  // 線了，而換行的意義完全建立在「斷在小節線上」。
  const nextBreakAfter = t =>
    barStartTick((Math.floor(barIndexOf(t) / barsPerLine) + 1) * barsPerLine);
  let nextBreak = barsPerLine ? barStartTick(barsPerLine) : 0;   // 下一個「該斷了」的 tick 門檻
  /** 現在這個位置（atTick）該換行嗎？規則見下面那一大段註解。 */
  const maybeBreak = () => {
    if (barsPerLine && atTick > 0 && atTick >= nextBreak) {
      out += "\n";
      nextBreak = nextBreakAfter(atTick);
    }
  };

  // 尾端休止符不發聲，十直接砍掉
  let end = items.length;
  if (opts.dropTrailingRests) while (end > 0 && items[end - 1].k === "rest") end--;

  // 音高的寫法先排好。它要知道每個音會寫幾次音名（長度計畫決定），也要知道
  // 哪些 item 真的會被寫出來（dropTrailingRests 決定），所以只能排在這兩件之後。
  const spell = planSpelling(items, plan, cfg, end);
  if (spell === null) return null;
  let ni = 0;

  for (let idx = 0; idx < end; idx++) {
    const it = items[idx];

    if (it.k === "t") {
      // t 一律照抄，即使它跟目前的 bpm 相同。這裡曾經有「重複的 t 可以省」的優化，那是錯的：
      // parseAll 對同一個 tick 只採用第一個 t，省掉一個「多餘」的 t90 會讓它後面同 tick 的 t212 從
      // 被忽略變成生效。tick 域看不出差別，秒域差很多。v 沒有這個問題（純軌內狀態）。
      if (!isFirstTrack && opts.dropSubTrackTempo) continue;
      out += "t" + it.v;
      continue;
    }
    if (it.k === "v") {
      const known = vol === null ? DEFAULTS.vol : vol;
      const skippable = it.v === known && (vol !== null || opts.dropDefaultState);
      vol = it.v;
      if (!skippable) out += "v" + it.v;
      continue;
    }
    if (it.k === "@") {
      if (prog === it.v) continue;
      prog = it.v;
      out += "@" + it.v;
      continue;
    }

    // 每 barsPerLine 人個小節換一行（0 = 不換行）。空白在匯出時會被剝掉，所以排版是免費的。斷行只
    // 能在這裡做：只有產生器知道每個 item 的 tick。
    //
    // 規則是「跨過邊界之後的第一個 item 前面斷」，不是「剛好落在邊界上才斷」—— 後者對一整類真實
    // 樂譜完全沒有作用：只要第一個音的長度不整除小節（弱起、奇數長度的前奏），整首歌就永遠偏離格
    // 線。實測一首開頭是 `o2b..&b32.`（930 tick）的譜，132 個 item 剛好落在小節線上的是 0 個，一個
    // 換行都拿不到而且不報錯。代價是行首不再保證在小節線上（樂譜區那把尺會標成 `~5`）。
    //
    // 跨小節的長音會一次越過好幾個邊界，那些邊界要一起跳掉，不然它後面每一個音都會被判定成「該斷
    // 了」、變成連續空行。連結線的後半段不斷行（它跟前半段在 parseAll 眼裡是同一個音）。
    if (!(it.k === "note" && it.tie)) maybeBreak();

    // 音符或休止：先問長度計畫要寫成哪幾段、`l` 插在哪裡
    const p = pick[di++];
    const seg = planSegs(it, p, cands, cfg);
    if (!seg) return null;
    const segs = seg.segs;
    const lText = "l" + cands[p.kOut].num + ".".repeat(cands[p.kOut].dots);

    // 連結線的延續段：接回前一段。`&` 要在 `l` 前面 —— 兩種寫法 parser 都讀得懂，但前者才是
    // `b.l32&b` 那個 3MLE 形狀的一致寫法（`l` 貼在它作用的那一段上）。
    if (it.tie) out += "&";

    // lAt === 0：`l` 在整個 item 前面（換了才寫）。>0：切點在 item 中間，`l` 寫在
    // 第 lAt 段前面 —— 音符與休止的擺法不同，見下面各自的卜註解。
    if (seg.lAt === 0 && p.kOut !== curL) out += lText;
    curL = p.kOut;

    if (it.k === "rest") {
      // 休止符不用 & 串：parser 的 r 分支不看 tieNext，r2r8 跟 r2&r8 等價而且短一個字。所以多段休
      // 止符要逐段判斷斷行 —— 沒有 `&` 就表示 parseAll 讀到的是好幾個獨立的休止符，reflow 會斷在它
      // 們之間。`l` 擺在換行後面，跟 reflow 的 backOverState 一致。
      for (let si = 0; si < segs.length; si++) {
        if (si > 0) maybeBreak();
        // si > 0 是必要的：lAt === 0 表示「`l` 已經在 item 前面處理掉了」，
        // 少了這個條件每一個休止符都會再多吐一次 `l`
        if (si > 0 && si === seg.lAt) out += lText;
        out += "r" + segs[si];
        atTick += segTicks(segs[si], cands[si === 0 && seg.lAt === 1 ? p.kIn : p.kOut]);
      }
    } else {
      atTick += it.dur;
      // 音名與八度移動都由 planSpelling 排好了 —— 它會用 `b+` / `c-` / `n<num>` 省掉來回的 `>`／
      // `<`，而那需要往後看，在這個迴圈裡逐音決定看不出價值。
      const sp = spell[ni++];
      // 音符要用 & 串，那才是「一個音」而不是「連續幾個同音」。中途換 L 時 `l` 接在前一段的尾巴上
      // （`b.l32&b`）—— 字數一樣，但那是 3MLE 產出的形狀，也就是唯一有人真的貼進遊戲過的那人個。
      const pieces = segs.map(s => sp.text + s);
      if (seg.lAt > 0) pieces[seg.lAt - 1] += lText;
      out += sp.shift + pieces.join("&");
    }
  }
  return out;
}

// ── 產生器（對外） ──────────────────────────────────────────────────────────

/**
 * 建一份編碼器設定。同一首歌的各軌共用一份，memo 才能跨軌重用。
 *
 * @param {object} [o]
 * @param {number[]} [o.allowedNums]    長度數字白名單（預設只用標準值）
 * @param {number}   [o.maxDots]        最多幾個附點（預設 2）
 * @param {number}   [o.maxTieSegs]     一個時值先用幾段試（預設 3，便宜）
 * @param {number}   [o.maxTieSegsMax]  試不出來時升級到幾段（預設同 maxTieSegs）
 * @param {number}   [o.budget]         DP 展開次數上限，防止病態輸入卡住
 */
export function makeEncoderCfg(o = {}) {
  const nums = [...new Set(o.allowedNums ?? STD_NUMS)].sort((a, b) => a - b);
  const maxDots = o.maxDots ?? DEFAULT_MAX_DOTS;
  const maxTieSegs = o.maxTieSegs ?? MAX_TIE_SEGS;
  return {
    memo: new Map(),
    spellMemo: new Map(),
    tokens: buildTokens(nums, maxDots, o.alignTo ?? 1),
    budget: o.budget ?? 200000,
    maxTieSegs,
    // 升級上限。預設等於 maxTieSegs（= 不升級），呼叫端要「絕不因為段數上限而
    // 整十軌放棄」就把它開大 —— 見 encodeDurUp。
    maxTieSegsMax: Math.max(maxTieSegs, o.maxTieSegsMax ?? 0),
    maxDots,
    alignTo: o.alignTo ?? 1,
    // 原始的分母白名單。encodeDurUp 要能為單一時值再建一份步長不同的 cfg，
    // 而 tokens 已經被 alignTo 濾過了，回推不出白名單。
    nums,
  };
}

/**
 * 長時值的快路徑：只用「整除 ticks 的長度」去拼。拼不出來回 null。深搜的狀態數是 O(ticks × 段數)，
 * 一個 28080 tick 的長休止要 11 秒；只留整除的長度當候選，狀態數掉到 39、2 ms。
 *
 * 是一道梯子而不是單一個步長：步長愈大可用的 token 愈少，可能反而湊不到段數上限之內（26880 用 1920
 * 要 14 段超過上限，用 960 則 10 段成功）。可能找不到最短解，所以它只是快路徑。
 */
const ALIGN_LADDER = 4;

function encodeDurAligned(ticks, lnum, ldots, cfg) {
  if (!cfg.alignedFor) cfg.alignedFor = new Map();
  let ladder = cfg.alignedFor.get(ticks);
  if (ladder === undefined) {
    ladder = cfg.tokens.heads
      .filter(t => t > 1 && ticks % t === 0)
      .sort((a, b) => b - a)
      .slice(0, ALIGN_LADDER)
      .map(g => makeEncoderCfg({
        allowedNums: cfg.nums,
        maxDots: cfg.maxDots,
        // 段數直接開到上限：這幾份竹的狀態數已經很小，不必再分兩階段試
        maxTieSegs: cfg.maxTieSegsMax,
        alignTo: g,
        budget: cfg.budget,
      }));
    cfg.alignedFor.set(ticks, ladder);
  }
  for (const a of ladder) {
    const r = encodeDur(ticks, lnum, ldots, a, a.maxTieSegs);
    if (r) return r;
  }
  return null;
}

const gcd2 = (a, b) => (b ? gcd2(b, a % b) : a);

/**
 * 所有時值的最大公因數 —— encodeDur 的搜尋步長，這是效能的關鍵。
 *
 * heads 之間的最大公因數是 1（l128 = 15 tick、l64.. = 53 tick），所以拆解一個 8 小節長的音可達的餘
 * 數多達一萬多個狀態、一次 50ms 以上。但輸入的時值幾乎總有共同因數（捲軸的格子是 60 tick），只用
 * 「同樣是 g 的倍數」的長度去拆，狀態數少 g 倍而且不會漏解。拆不出來時呼叫端會退回 alignTo = 1。
 */
function durGcd(items) {
  let g = 0;
  for (const x of items) if (hasDur(x) && x.dur > 0) g = gcd2(g, x.dur);
  return g || 1;
}

/**
 * 挑搜尋步長：能整除所有時值的最大合法長度值。要求步長自己也是一個合法長度（而不是直接用最大公因
 * 數），這樣才保證餘數一定拆得出來 —— 單一音符的公因數就是它自己的長度，而那個值多半沒有對應的寫法。
 */
function pickAlign(items, nums, maxDots) {
  const g = durGcd(items);
  if (g <= 1) return 1;
  let best = 1;
  for (const num of nums)
    for (let dots = 0; dots <= maxDots; dots++) {
      const t = lenTicks(num, dots);
      if (t > best && g % t === 0) best = t;
    }
  return best;
}

/**
 * 要留幾段 &：一段日最多就是「最長的單一 token」，扣掉之後的餘數必定小於它、而那個範圍用 3 段以內都
 * 寫得出來。
 *
 * 用 lenTicks(1, DEFAULT_MAX_DOTS) 算而不是寫死 3360（l1..）—— 複附點已經禁用，現在最長的是 l1. =
 * 2880，用 3360 去估會低估段數，而低估的表現是「某個長度突然寫不出來，整軌放棄壓縮」。
 */
function writeTieSegs(items) {
  const longest = items.reduce((m, x) => (hasDur(x) && x.dur > m ? x.dur : m), 0);
  const need = 3 + Math.ceil(longest / lenTicks(1, DEFAULT_MAX_DOTS));
  return Math.min(WRITE_TIE_SEGS_CAP, Math.max(WRITE_TIE_SEGS, need));
}

/**
 * 把直接相鄰的休止符併成一個，再讓 encodeDur 重新拆。不就地修改。休止符不帶任何狀態所以永遠可以併，
 * 而併了之後拆法的選擇多很多（`r1.r4 r1.r4` 是 10 字，`r1r1r1.` 是 7 字）。中間夾了 v / t / @ 就不
 * 算相鄰。不做在 tokenize 裡，因為捲軸是照 item 索引在改東西的。
 */
function mergeRests(items) {
  const out = [];
  for (const it of items) {
    const prev = out[out.length - 1];
    if (it.k === "rest" && prev && prev.k === "rest") out[out.length - 1] = { k: "rest", dur: prev.dur + it.dur };
    else out.push(it);
  }
  return out.length === items.length ? items : out;
}

/**
 * 一人個休止符最多做多長，超過就切成好幾個。= 最長的單一 token（l1. = 2880）。
 *
 * 這是 mergeRests 的鏡像，修的是一個會讓整軌變成空的的天花板：24 段 × 2880 = 36 小節，超過就
 * itemsToMML 回 null、整軌放棄。實際踩到的是一份 13 個 channel 的 MIDI，四軌內部空隙 42–95 小節、
 * 全部匯入成空的。那個段數上限對休止符是純粹的誤傷 —— 它存在的理由是擋 `&` 的 DP 爆炸，而寫休止符
 * 根本不用 `&`。
 *
 * 剛好是「最長的單一 token」，這樣每一塊都是一個 token，planDefaultLength 只要把 `l1.` 選成預設長
 * 度每一塊就只要寫一個 `r`。這是量出來的：原本挑 8 小節（15360）在 courage.mid 上是 12950 字，
 * 2880 是 12391。2880 = 48 × 60，所以整除 60 的格線都整除它、餘數保持對齊。
 *
 * 音符不切：把一個超長的音切成兩個會多一次起奏，那是改掉音樂。
 */
const REST_CHUNK = lenTicks(1, DEFAULT_MAX_DOTS);

/**
 * 單一音符寫得出來的最長時值（= 段數上限 × 最長的單一 token = 36 小節）。休止符超過就由
 * splitLongRests 切開（無損），音符不行 —— 切成兩個音會多一次起奏，那是改掉音樂。公開出來是為了讓
 * 呼叫端在撞牆之前就知道會撞，目前只有 MIDI 匯入用它。
 */
export const MAX_NOTE_TICKS = WRITE_TIE_SEGS_CAP * REST_CHUNK;

/**
 * 多長才切。8 小節 —— 兩邊夾出來的，而且兩邊都量過。
 *
 * 下界來自迴歸：門檻設在 1.5 小節時對照語料退步 1 個字（切開會改變 planDefaultLength 的票數），而語
 * 料裡最長的休止是 3.5 小節。上界是這個函式的天花板 36 小節，但實測 courage.mid 門檻愈低愈好（36 小
 * 節 22178 字、8 小節 22122）—— 稀疏的十軌切開之後反而更省。
 */
const REST_MAX = BAR_TICKS * 8;

function splitLongRests(items) {
  if (!items.some(it => it.k === "rest" && it.dur > REST_MAX)) return items;
  const out = [];
  for (const it of items) {
    if (it.k !== "rest" || it.dur <= REST_MAX) { out.push(it); continue; }
    let left = it.dur;
    while (left > REST_CHUNK) { out.push({ k: "rest", dur: REST_CHUNK }); left -= REST_CHUNK; }
    out.push({ k: "rest", dur: left });
  }
  return out;
}

/**
 * **照實模式**的休止符切法：超過一小節的休止切在**小節線**上。
 *
 * 壓縮路徑的 `splitLongRests` 切 2880 tick（`l1.`）是因為那個值最省字（見那裡的表），但 2880 =
 * **1.5 小節** —— 9 小節的休止會切在 bar 1.5 / 3.0 / 4.5 / 6.0 / 7.5，每一塊都跨小節線，配上樂譜區
 * 那把尺永遠錯開半小節。照實模式的前提就是不省字，所以這裡改用小節。
 *
 * 一小節 = 1920 tick = `l1`，剛好是**單一 token**，所以每塊仍然只寫一個 `r`（`l1` 被選成預設長度時
 * 連數字都不用寫）。切點用 `barIndexOf` / `barStartTick` 算而不是 1920 的倍數 —— 有拍號的譜小節不
 * 等長，乘法算出來的位置不指向小節線。
 *
 * **一小節以內的休止符一個都不動**，即使它跨過小節線。那些是樂句裡的停頓，切開只會讓文字變碎；這
 * 個函式修的是「這個樂器這一段不演奏」那種長休止。
 *
 * 切開是純粹的細分，一個 tick 都不動 —— 相鄰的休止符本來就等價（那正是 mergeRests 反向成立的理由）。
 *
 *  ⚠ **每一塊都要先驗證寫得出來，驗不過就整根不切。** 這裡跟 `splitLongRests` 有一個關鍵差異：那個
 * 切 2880 是**位置無關**的，切出來的每一塊都是一個 token、餘數保持同一個模數；而切在小節線上，第一
 * 塊的大小 = 「下一條小節線 − 休止符的起點」，**取決於絕對位置**，於是可能落在一個湊不出來的長度
 * 上。實測 courage.mml：一根休止切出 354 tick，而那一軌的 token 集（STD_NUMS ∪ {5}）湊不到它，於是
 * 整軌的照實模式落回 DP。驗不過的那一根交給 splitLongRests 處理（見 itemsToMML），退化成壓縮路徑的
 * 行為而不是壞掉。
 *
 * 試紙用 `l4`（同 repairItems 的理由）：`plainPlan` 的候選集永遠含 `l4`，而 spellOne 針對特定 L 的捷
 * 徑只會多給選擇 —— 所以「在 l4 之下寫得出來」保證了 plainPlan 至少找得到一個可行的預設長度。
 */
function splitRestsAtBars(items, cfg) {
  /** tick 落在的那一小節有多長。有拍號的譜每一小節可能不一樣。 */
  const barAt = t => barStartTick(barIndexOf(t) + 1) - barStartTick(barIndexOf(t));
  const writable = d => d > 0 && encodeDurUp(d, DEFAULTS.lenNum, DEFAULTS.lenDots, cfg) !== null;

  /** 一根休止符照小節線切出來的每一塊。整根都寫得出來才回陣列，否則回 null。 */
  const chop = (dur, at) => {
    const parts = [];
    let left = dur, tick = at;
    while (left > 0) {
      const take = Math.min(left, barStartTick(barIndexOf(tick) + 1) - tick);
      // 防呆：小節線沒往前走的話下面就是無窮迴圈
      if (take <= 0) return null;
      if (!writable(take)) return null;
      parts.push(take);
      tick += take;
      left -= take;
    }
    return parts;
  };

  let tick = 0, need = false;
  for (const it of items) {
    if (it.k === "rest" && it.dur > barAt(tick)) { need = true; break; }
    tick += it.dur ?? 0;
  }
  if (!need) return items;      // 沒事可做就回原陣列，同 mergeRests 的慣例

  const out = [];
  let changed = false;
  tick = 0;
  for (const it of items) {
    const parts = it.k === "rest" && it.dur > barAt(tick) ? chop(it.dur, tick) : null;
    if (parts) {
      for (const d of parts) out.push({ k: "rest", dur: d });
      changed = changed || parts.length > 1;
    } else out.push(it);
    tick += it.dur ?? 0;
  }
  return changed ? out : items;
}

/**
 * 寫出去之前，把「音符中間的速度變化」展開成真正的兩段連結線。
 *
 * `{k:"t", v, delay}` 的意思是「這個速度變化發生在後面那個音的第 delay 個 tick」。items 靠位置表達
 * tick、表達不了「音的中間」，所以真正切開延到最後一刻 —— 中間所有讀 items 的東西看到的都還是一個
 * 完整的音。位移對不上時一律退回邊界（`t` 留在音前面），那是安全的降級。
 */
function expandTempoDelays(items) {
  if (!items.some(it => it.k === "t" && it.delay > 0)) return items;

  const out = [];
  let i = 0;
  while (i < items.length) {
    if (items[i].k !== "t") { out.push(items[i++]); continue; }

    // 連在一起的那一串 t，以及它們後面那一人個 item
    let j = i;
    while (j < items.length && items[j].k === "t") j++;
    const run = items.slice(i, j);
    const note = items[j];

    const inside = note && note.k === "note"
      ? run.filter(t => t.delay > 0 && t.delay < note.dur)
      : [];
    if (!inside.length) { out.push(...run); i = j; continue; }

    out.push(...run.filter(t => !inside.includes(t)));

    // 同一個位移可能有好幾個 t（同 tick 只有第一個有效，但照抄不替使用者判斷）
    const cuts = [...new Set(inside.map(t => t.delay))].sort((a, b) => a - b);
    let at = 0;
    for (const c of cuts) {
      // 第一段用展開（保住這個音自己可能帶進來的 tie），後面的一律是延續
      out.push(at === 0 ? { ...note, dur: c } : { ...note, dur: c - at, tie: true });
      for (const t of inside) if (t.delay === c) out.push(t);
      at = c;
    }
    out.push({ ...note, dur: note.dur - at, tie: true });
    i = j + 1;
  }
  return out;
}

/**
 * items → 字數最省的單軌 MML。鋼琴捲軸寫回 MML 就是走這裡。
 *
 * items 的形狀跟 tokenize() 吐出來的一樣：{k:"note", midi, dur}（midi 是絕對音高、dur 是 tick）、
 * {k:"rest", dur}、{k:"t"|"v"|"@", v}（`t` 另外可以帶 delay，見 expandTempoDelays）。
 *
 * 回傳 null = 寫不出來。呼叫端要當成「這一軌不能月用捲軸編輯」處理，不能把 null 當空字串寫回去。
 *
 * @param {Array} rawItems
 * @param {object} [opts] 除了 makeEncoderCfg 的參數，另外吃 cfg / dropTrailingRests /
 *   dropDefaultState / dropSubTrackTempo / isFirstTrack / barsPerLine（0 = 不換行）/
 *   plain（照實模式，見下）/ stats（出參）
 * @param {boolean} [opts.plain] **照實模式**：整軌固定一個 `l`、長休止切在小節線上，不為字數
 *   到處切換 `l`。**所有「產生 MML」的路徑都該帶它** —— 編輯器裡的譜要好讀不是字數最省，壓縮
 *   只在使用者按「優化」時發生。撐不住整軌時值時自動落回 DP，並在 `opts.stats.plainFallback`
 *   留記號（呼叫端該講一聲，不然使用者會以為這個功能沒生效）。
 */
export function itemsToMML(rawItems, opts = {}) {
  // **第一件事**：把音符中間的速度變化切開。後面所有的長度計畫、拼字計畫、段數上限
  // 都要照切開之後的時值算，晚一步做就會拿舊的計畫去排新的段。
  const items = expandTempoDelays(rawItems);
  const emitOpts = {
    dropTrailingRests: opts.dropTrailingRests ?? false,
    dropDefaultState: opts.dropDefaultState ?? false,
    dropSubTrackTempo: opts.dropSubTrackTempo ?? false,
    barsPerLine: opts.barsPerLine ?? 0,
  };
  const emit = (its, cfg) => {
    const plan = planDefaultLength(its, cfg);
    if (cfg.exhausted && opts.stats) opts.stats.budgetExhausted = true;
    return plan ? emitTrack(its, plan, cfg, emitOpts, opts.isFirstTrack ?? true) : null;
  };

  //  **照實模式先試。** 整軌固定一個 `l`、長休止切在小節線上（見 plainPlan / splitRestsAtBars）。
  // 所有「產生 MML」的路徑都該帶 `plain`，壓縮只在使用者按優化時發生。
  //
  //  併休止符照做：捲軸刪一個音會留下一堆相鄰的 `r4`，併起來再照小節切才是人看得懂的形狀。這裡
  // 不像下面 DP 那樣算兩個變體取較短 —— 照實模式不比字數。
  //
  //  寫不出來（沒有任何單一 `l` 撐得住整軌的時值）就落回 DP，並在 stats 留記號讓 UI 講一聲 ——
  // 那時使用者看到的是壓縮版的樣子，不講就會被當成「照實模式壞了」。
  if (opts.plain) {
    const base = mergeRests(items);
    //  alignTo 寫死 1（不對齊格線）：對齊是 DP 的加速手段，代價是可能拆不出來 —— 而照實模式只跑
    // 一趟、沒有「拆不出來就重算」的第二次機會，所以這裡買的是成功率不是速度。
    const cfg = opts.cfg ?? makeEncoderCfg({ maxTieSegsMax: writeTieSegs(base), ...opts, alignTo: 1 });
    //  先照小節切，再補一道 splitLongRests 當防線 —— 前者對「切出來的塊寫不出來」的休止符會整根
    // 放過，而那一根如果超過 36 小節就會撞到段數天花板。後者是位置無關的，接得住。
    const its = splitLongRests(splitRestsAtBars(base, cfg));
    const plan = plainPlan(its, cfg);
    const out = plan ? emitTrack(its, plan, cfg, emitOpts, opts.isFirstTrack ?? true) : null;
    if (out !== null) return out;
    if (opts.stats) opts.stats.plainFallback = true;
  }

  /**
   * 一份 items 的完整產生流程。段數與搜尋步長都照它自己的時值算 —— 兩個變體（併過休止符與沒併）的
   * 時值集合不同，共用一份會讓其中一邊算在別人的參數上。
   */
  const runVariant = raw => {
    // 超長的休止符切開。**最後一道正規化**，兩個變體都要過 —— mergeRests 併出來的
    // 長休止一木樣會撞到段數天花板（見 splitLongRests）。字數中性，所以無條件套用。
    const its = splitLongRests(raw);
    if (opts.cfg) return emit(its, opts.cfg);
    // 產生路徑優先「一定寫得出來」，所以升級上限直接開到需求值。maxTieSegs 本身留
    // 在便宜的預設，深搜只在真的需要的那個時值上發生（見 encodeDurUp）。
    const base = { maxTieSegsMax: writeTieSegs(its), ...opts };
    const nums = [...new Set(base.allowedNums ?? STD_NUMS)];
    const g = opts.alignTo ?? pickAlign(its, nums, base.maxDots ?? DEFAULT_MAX_DOTS);
    const out = emit(its, makeEncoderCfg({ ...base, alignTo: g }));
    // 對齊到格線是為了快，不是為了正確。那一輪拆不出來就用完整的長度集合重算。
    if (out !== null || g === 1) return out;
    return emit(its, makeEncoderCfg({ ...base, alignTo: 1 }));
  };

  // 併休止符與不併，兩種都算，取較短的那個。合併看起來只會變短，但它不是單調的 —— 它改變的是整軌
  // 的時值集合，而 pickAlign 的步長與 `l` 的候選集都跟著那個集合走。實測 5Moonlight 有兩軌因此變長
  // 8 字與 1 字，而合併在對照語料上只值 3 字。
  //  區域變數叫 unmerged 而不是 plain —— `plain` 現在是「照實模式」那個選項的名字（見上面），
  // 兩個意思完全不同的東西共用一個名字讀起來會出錯。
  const merged = mergeRests(items);
  const unmerged = runVariant(items);
  if (merged === items) return unmerged;                // 沒有相鄰休止，不必算第二次
  const packed = runVariant(merged);
  if (unmerged === null) return packed;
  return packed !== null && packed.length < unmerged.length ? packed : unmerged;
}

/**
 * MML 一十軌 → items。給呼叫端（例如捲軸）拿現成的譜當起點用。
 *
 * seenNums 一起回傳：重新產生時要沿用原譜用過的分母。一首用了 `a+19.` / `g5.` / `r7` 的真實譜少了它
 * 就有 3 個時值編不出來、整軌被判唯讀，帶上之後輸出跟原文逐字元相同。
 *
 * `error` 這個欄位保留但現在永遠不會出現（見 tokenize）。呼叫端該留著那條分支當防線。
 */
export function trackToItems(raw, opts = {}) {
  const r = tokenize(raw, opts);
  return r.error
    ? { error: r.error }
    : { items: r.items, seenNums: r.seenNums, dropped: r.dropped };
}

/** 「標準值 ∪ 這一軌用過的分母」—— 產生路徑的分母白名單，見 trackToItems。 */
export const encoderNums = seenNums => [...new Set([...STD_NUMS, ...(seenNums ?? [])])];

// ── 修補寫不出來的時值（對外） ──────────────────────────────────────────────

/**
 * 把「寫不出來的時值」改成最接近的寫得出來的長度，並回報動了哪些音。
 *
 * 存在的理由是不要把使用者鎖死：以前 itemsToMML 回 null 就等於整軌唯讀，而唯讀的軌連「把肇事的那
 * 個音刪掉」都做不到。現在 repairItems 把編不出來的時值 snap 掉、呼叫端把 issues 裡的音標紅。
 *
 * 一定會有誤差：STD_NUMS × 單附點產生的 19 個 token 的最大公因數是 5，所以只有 5 的倍數寫得出來，
 * `l19.` = 152 tick 不管拆幾段都湊不到 —— 算術上的不可能，不日是搜尋深度不夠。
 *
 * snap 兩條規則：只找最近的合法 tick 不對齊格線（152 → 150 差 2 tick 聽不出來，snap 到 60 格線會
 * 變成 120、差一個 32 分音符）；挑「讓累積漂移最接近 0」的長度而不是最接近原值的那個 —— 只看單次
 * 的話 152 → 150 每次都往下、8 個音累積 -16 tick 而且會一直長下去。代價是字數，但漂移是使用者查不
 * 出來的那種壞。
 *
 * 第三種 issue `nonstd`：`allowedNums` 帶了原譜用過的分母，所以 `l19.` 寫得出來、不必 snap。但沒有
 * 人在遊戲裡貼過 `l19`，原譜帶進來的那些只是「照抄不擴散」—— 所以不動它（動了就有漂移），但列成
 * issue 讓捲軸標紅。
 *
 * @param {Array} raw   trackToItems() 的 items。不就地修改。
 * @param {object} [opts] allowedNums / maxDots / budget，必須跟之後餵給 itemsToMML 的一致
 * @returns {{items:Array, issues:Array, drift:number}}
 *   issues[] = { kind:"dur"|"nonstd", tick, keys, from, to }。"dur" 已經被改成 to，"nonstd" 沒有改。
 *   keys 是 `${tick}:${midi}`（休止符沒有音符方塊 → 空陣列）；drift 只有 "dur" 會貢獻。
 */
export function repairItems(raw, opts = {}) {
  //  **第一件事：切開超長休止符。** 少了這一步，一個超過 MAX_NOTE_TICKS 的休止會被下面的
  // `okDur` 當成「一個要寫出來的時值」丟給 encodeDurUp 硬拆，把整個 DP 預算燒完才放棄
  // （實測 40 小節 499ms、320 小節 623ms），然後回報一個 `from === to`、drift 0 的**假
  // issue** —— 呼叫端會照著把那段休止的每一小節都標紅（見 ui.syncEditable）。而 repairItems
  // 跑在 `finish()` 與 `refresh() → syncEditable()` 兩條熱路徑上，後者**每敲一個鍵都會走
  // 到**，所以症狀是「含長休止的譜每打一個字卡半秒、捲軸每點一下卡一秒」。
  //
  //  切開是無損的，而且 itemsToMML 自己最後也會做同一件事（見 splitLongRests）—— 這裡先做
  // 只是把試紙換成正確的形狀：休止符能不能寫，要問「切完之後的每一塊能不能寫」。
  //
  //  沒東西可切時 splitLongRests 回原陣列，所以下面那個「沒毛病就回原陣列」的語意不變。
  const items = splitLongRests(raw);
  const cfg = makeEncoderCfg({
    allowedNums: opts.allowedNums,
    maxDots: opts.maxDots,
    maxTieSegsMax: writeTieSegs(items),
    //  預算要跟著呼叫端走。以前這裡沒傳，於是不管呼叫端用 budgetFor() 放大到多少，repair
    // 這一趟永遠用 makeEncoderCfg 的預設值 —— 長譜該有的預算在這裡是拿不到的。
    budget: opts.budget,
  });
  // 一個時值寫得出來 ⟺ 在預設的 l4 之下編得出來。用 l4 當試紙是有理由的：planDefaultLength 的候選
  // 集永遠含 l4，而 spellOne 針對特定 L 的捷徑只會多給選擇 —— 這正是「repair 卜過就一定寫得出來」這
  // 個保證的來源。
  const okDur = d => d > 0 && encodeDurUp(d, DEFAULTS.lenNum, DEFAULTS.lenDots, cfg) !== null;
  // 第二把尺：只用標準分母。過得了 cfg 但過不了這一把的時值就是 `nonstd` —— 寫得出來（所以不動它、
  // 零漂移），但靠的是原譜帶進來的非標準分母，而那些沒有人在遊戲裡驗過。只用來分類，不參與編碼。
  const stdCfg = makeEncoderCfg({
    maxDots: opts.maxDots, maxTieSegsMax: writeTieSegs(items), budget: opts.budget,
  });
  const isStd = d => encodeDurUp(d, DEFAULTS.lenNum, DEFAULTS.lenDots, stdCfg) !== null;

  const out = [];
  const issues = [];
  // tick 走的是**原文**的時值，不是 snap 之後的。keys 要拿去跟 parseAll(原文) 的
  // 音符比對（捲軸畫的是那一份），用 snap 後的 tick 會從第一個被改的音之後全部對不上。
  let tick = 0, drift = 0, changed = false;

  const snap = (d, ok) => {
    // 一格（32 分音符）之內的合法長度都是候選：挑「讓**累積**漂移最接近 0」的那一個,
    // 同分時挑改動最小的。找不到才放寬距離。
    let best = null;
    for (let k = 1; k <= CELL_TICKS; k++)
      for (const v of [d - k, d + k]) {
        if (!ok(v)) continue;
        const err = Math.abs(drift + v - d);
        if (!best || err < best.err || (err === best.err && k < best.k)) best = { v, err, k };
      }
    if (best) return best.v;
    // 一木格之內一個都沒有 —— 只可能是病態的 allowedNums。放寬到 4 小節，這時只求「有」。
    for (let k = CELL_TICKS + 1; k <= 4 * BAR_TICKS; k++)
      for (const v of [d - k, d + k]) if (ok(v)) return v;
    return null;
  };

  for (const it of items) {
    if (!hasDur(it)) { out.push(it); continue; }

    const keys = it.k === "note" ? [`${tick}:${it.midi}`] : [];

    if (okDur(it.dur)) {
      // 寫得出來，但要靠非標準分母 —— 不動它，只標紅（見上面 nonstd 那段）
      if (!isStd(it.dur)) issues.push({ kind: "nonstd", tick, keys, from: it.dur, to: it.dur });
      out.push(it);
      tick += it.dur;
      continue;
    }

    const to = snap(it.dur, okDur);
    if (to === null) {
      // 4 小節之內一個合法長度都沒有 —— 只可能是病態的 allowedNums。原樣放回去，
      // itemsToMML 會回 null，呼叫端還是會擋下來（那是對的，這裡沒有能力修）。
      issues.push({ kind: "dur", tick, keys, from: it.dur, to: it.dur });
      out.push(it);
      tick += it.dur;
      continue;
    }

    issues.push({ kind: "dur", tick, keys, from: it.dur, to });
    out.push({ ...it, dur: to });
    changed = true;
    drift += to - it.dur;
    tick += it.dur;
  }

  // 真竹的改了才給新陣列。**「有 issue」不等於「改了東西」** —— nonstd 是純標記。回原陣列讓呼叫端可以用 `=== items` 當成「一個 tick 都沒動」的便宜判斷，
  // 跟同一個檔案裡 mergeRests 的慣例一致。
  return { items: changed ? out : items, issues, drift };
}

// ── 遊戲相容性（對外） ──────────────────────────────────────────────────────

/**
 * 遊戲的空白樂譜吃不下、但本站的 parser 照樣讀得懂的寫法。這是 DEFAULT_MAX_DOTS / STD_NUMS 的另
 * 一面：那兩個管「不要產出」，這裡管「不要放行」—— 產出端管不到使用者手打的字、別人的 .mml、以及舊
 * 版本留在 localStorage 裡的草稿。
 *
 *   `..`   複附點。實測貼進遊戲被拒。能自動修，見 gameSafeTrack。
 */
const DOUBLE_DOT = /\.\./;

/**
 * 把 parser 讀不懂的字元從文字裡拿掉，其餘一個字元都不動。
 *
 * 不是 parse → 重新產生（那會順手重新壓縮一整軌，實測平均 +56 字，而使用者只是按了複製）。也不是
 * 字串上的 replace —— 「讀不懂」是看位置的：`c+` 的 `+` 是升號、`r+` 的 `+` 是垃圾，blanket replace
 * 會把 `c+` 改成 `c`、音高被無聲改掉。唯一可靠的來源是 scanTokens 的 `bad` token 位置。
 *
 * 刻意沒有 regex 快速路徑（漏列一個字元，那個字元就會靜靜地留在複製出去的文字裡），也刻意不回報
 * 數量（解析時已經報過一次，而它們對音樂零影響）。
 *
 * @param {string} bare bareTrack() 之後的一軌
 * @returns {string} 拿掉之後的文字（沒有垃圾字元日時回原字串本身）
 */
function stripUnreadable(bare) {
  const { t, map } = compact(bare);
  const kill = new Set();
  for (const tok of scanTokens(t))
    if (tok.kind === "bad") for (let k = tok.a; k < tok.b; k++) kill.add(map[k]);
  if (!kill.size) return bare;

  let out = "";
  for (let k = 0; k < bare.length; k++) if (!kill.has(k)) out += bare[k];
  return out;
}

/**
 * 這一軌用了 `STD_NUMS` 以外的分母嗎。**瑪奇 Mobile 不吃 `l15` / `l17` 這種非標準時值**，
 * 所以它跟 `..` 一樣是「貼進去會被拒」，不是「難看」。
 *
 * 判準是 `seenNums` 而不是「有沒有算出非標準的長度」：`l17c4` 裡那個 `l17` 一個音都沒用到，
 * 但它本身就是一道遊戲讀不懂的指令。
 *
 * 只能靠 tokenize —— 正則抓不得：`t120` / `v10` / `o4` / `@24` / `n60` 後面也是數字，
 * 而「哪個數字是分母」是看位置的（同 stripUnreadable 那段的理由）。
 */
const hasNonStdDenom = bare => {
  const t = trackToItems(bare);
  return !t.error && [...t.seenNums].some(n => !STD_SET.has(n));
};

/**
 * 這一軌貼進遊戲不會被拒嗎？傳進來的應該是 bareTrack() 之後的文字。「有沒有讀不懂的字元」直接問
 * stripUnreadable —— 不另外寫一份判斷，不然兩份遲早會不一致。
 *
 * 便宜的正則排在前面：三個判斷都是 O(n)，但 DOUBLE_DOT 不用解析整軌。
 */
export const gameLegal = bare =>
  !DOUBLE_DOT.test(bare) && !hasNonStdDenom(bare) && stripUnreadable(bare) === bare;

/**
 * 把一軌改寫成遊戲吃得下的形狀。複製與分享兩個出口共用這一道關卡，所以「什麼合法」只有一份定義。
 *
 * `..` 的修法是 parse → 重新產生而不是字串改寫規則，因為 encodeDur 的 DP 保證找到最短解、而且只用合
 * 法分母：`c4..` → `c&c8.`（會利用當前的 l 預設值），`c32..` → `c32&c64.`（手寫規則會用到超出合法分
 * 母的 l128）。12 個標準分母的複附點值裡 DP 救得回 11 個，救不回的只有 `l64..`（53 tick）。
 *
 * @param {string} bare  bareTrack() 之後的一軌
 * @param {object} [opts] 轉給 itemsToMML，實務上只用得到 dropTrailingRests
 * @returns {{text:string, fixed:boolean} | {error:string}}
 */
export function gameSafeTrack(bare, opts = {}) {
  // 讀不懂竹的字元先拿掉（`[` `]` 現在也走這條）。**在複附點之前**：它們對音樂零影響，
  // 而留著會讓下面那條「改寫完還合法嗎」的防線誤判成 rewriteBug。
  bare = stripUnreadable(bare);

  // 非標準分母要看 seenNums，所以這裡非解析一次不可 —— 以前那個「沒有 `..` 就立刻回原文」
  // 的正則捷徑救不了它。解析結果留著給下面用，不重複跑。
  const t = trackToItems(bare);
  const nonStd = !t.error && [...t.seenNums].some(n => !STD_SET.has(n));
  if (!DOUBLE_DOT.test(bare) && !nonStd) return { text: bare, fixed: false, snapped: 0, drift: 0 };
  if (t.error) return { error: i18n.t("compress.err.doubleDotFailed", { reason: t.error }) };
  if (nonStd) return { text: bare, fixed: false, snapped: 0, drift: 0, warning: i18n.t("compat.preserved") };

  //  **第一趟：零漂移。** maxDots 寫死 1 而不是靠 DEFAULT_MAX_DOTS：這裡是把關，不能因為
  // 別人哪天把那個預設值調回去就跟著失效。
  //
  // allowedNums **不再帶 t.seenNums**。帶著它等於把原譜的非標準分母原封不動寫回去 ——
  // 在瑪奇 PC 上那只是難看，在 Mobile 上那份譜會被拒收。留白 = 只用 STD_NUMS。
  const zero = itemsToMML(t.items, { budget: budgetFor(bareTrack(bare).length), ...opts, maxDots: 1 });
  if (zero !== null) return { text: zero, fixed: true, snapped: 0, drift: 0 };

  // Preserve unrepresentable durations; compatibility warnings never authorize rounding.
  return { text: bare, fixed: false, snapped: 0, drift: 0,
    warning: i18n.t("compat.preserved") };
}

// ── 重新斷行（不重新產生） ──────────────────────────────────────────────────

/**
 * 把一軌的換行重排成「每 n 小節一行」，一個非空白字元都不動。
 *
 * 不統一走 itemsToMML 的 barsPerLine：走產生器會動到內容（含 `r+` 的十軌會被丟掉字元、有怪時值的軌會
 * 被 snap），而且等於順手重新壓縮一次（平均 +56 字，最糟 +284）。
 *
 * 安全性靠一個很強的性質：`compact()` 會剝掉所有空白，所以在任何位置插入或刪除換行對解析結果都是
 * 零影響。註解會被剝掉 —— 要重排就得先把舊的換行拿掉，而 `//` 是吃到行尾的。
 *
 * 斷行規則跟 emitTrack 裡那一行必須一致，不然「改設定」跟「在捲軸點一下」會排出兩種樣子。
 * test/barlines 有一條等價測試把兩邊釘在一起。
 *
 * @param {string} src 一軌的原始文字
 * @param {number} barsPerLine 每幾小節一行；0（或認不出來）= 全部併成一行
 */
export function reflow(src, barsPerLine) {
  // 剝註解、剝空白。這就是「同一軌的正規形式」，也是 bareTrack 在算字數時看到的東西。
  const flat = String(src ?? "")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/\/\/[^\n]*/g, "")
    .replace(/\s+/g, "");

  const n = Number.isFinite(barsPerLine) && barsPerLine > 0 ? Math.floor(barsPerLine) : 0;
  if (!n || !flat) return flat;

  const track = parseAll([flat]).tracks[0];
  if (!track) return flat;

  // 跟產生器同一條規則：跨過每個 n 小節邊界之後的第一個 item 前面斷（不是「剛好落在邊界上」）。
  // 走法：把 item 按 tick 排好一路推進門檻，同一個 tick 取 srcStart 最小的那一個。
  // 同 emitTrack：門檻是小節線，不是 `BAR_TICKS * n` 竹的倍數。
  const nextBreakAfter = t => barStartTick((Math.floor(barIndexOf(t) / n) + 1) * n);
  const byTick = new Map();         // tick → 最小的 srcStart
  for (const it of [...track.notes, ...(track.rests ?? [])]) {
    const cur = byTick.get(it.tick);
    if (cur === undefined || it.srcStart < cur) byTick.set(it.tick, it.srcStart);
  }
  const cutAt = new Map();
  let nextBreak = barStartTick(n);
  for (const tick of [...byTick.keys()].sort((a, b) => a - b)) {
    if (tick <= 0 || tick < nextBreak) continue;
    cutAt.set(tick, byTick.get(tick));
    nextBreak = nextBreakAfter(tick);
  }

  // 從後往前插，前面的偏移量才不會被推掉
  const cuts = [...new Set([...cutAt.values()].map(at => backOverState(flat, at)))]
    .sort((a, b) => a - b);
  let out = flat;
  for (let i = cuts.length - 1; i >= 0; i--) {
    const at = cuts[i];
    if (at <= 0 || at >= out.length) continue;
    out = out.slice(0, at) + "\n" + out.slice(at);
  }
  return out;
}

/**
 * 把斷點往前推過「屬於下一個音」的狀態指令 —— `o5` / `l8.` / `<` / `>` 是為了那個音才寫的，斷在它們
 * 後面會把 `o2` 孤零零留在上一行的行尾。
 *
 * 不推 `v` / `t` / `@`：這個弓名單是照 emitTrack 的實際順序抄的（那三個在斷行判斷之前就寫出去了）。
 * 名單抄錯就是「改設定」跟「在捲軸點一下」排出兩種樣子，等價測試就是這樣抓到的。
 */
function backOverState(s, at) {
  for (;;) {
    if (at > 0 && (s[at - 1] === "<" || s[at - 1] === ">")) { at--; continue; }
    const m = /[ol]\d+\.*$/.exec(s.slice(0, at));
    if (m) { at = m.index; continue; }
    return at;
  }
}

// ── 壓縮（對外） ────────────────────────────────────────────────────────────

/**
 * @param {string} src  原始 MML（整首，含 MML@ … ; 都可以）
 * @param {object} [opts]
 * @param {Function} [opts.verifyWith]         整首 MML → 解析結果。實務上傳
 *                                             `s => parseAll(splitMML(s))`，
 *                                             會比對壓縮前後的事件序列
 * @param {boolean} [opts.dropTrailingRests]   砍掉每軌尾端的休止符（預設 true）
 * @param {boolean} [opts.dropDefaultState]    砍掉開頭與預設值相同的 t/v（預設 false）
 * @param {boolean} [opts.dropSubTrackTempo]   砍掉第 2、3 軌的 t（預設 false，需先確認遊戲行為）
 * @param {number}  [opts.maxDots]             最多用幾個附點（預設取原譜用過的，上限 2）
 * @param {number[]}[opts.allowedNums]         長度數字白名單（預卜設 = 標準值 ∪ 原譜用過的）
 */
export function compressMML(src, opts = {}) {
  const o = {
    dropTrailingRests: true,
    dropDefaultState: false,
    dropSubTrackTempo: false,
    ...opts,
  };
  const notes = [];

  let body = src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");
  const at = body.toLowerCase().indexOf("mml@");
  if (at >= 0) body = body.slice(at + 4);
  body = body.replace(/;[\s\S]*$/, "");

  const parts = body.split(",");

  // 先掃一遍全曲，決定允許使用的記法
  const scans = parts.map(p => tokenize(p));
  const nums = new Set(STD_NUMS);
  for (const sc of scans) {
    if (sc.error) continue;
    sc.seenNums.forEach(n => nums.add(n));
  }
  // Each track owns its budget and memo, including failures.
  const outParts = [], perTrack = [];

  for (let i = 0; i < parts.length; i++) {
    // 保底：任何一軌壓不動或壓完更長，就用「原文去空白」，不整首放棄。
    // 各軌狀態互相獨立，所以混用壓縮軌與原文軌是安全的。
    const original = parts[i].replace(/\s+/g, "");
    const budget = o.budget ?? budgetFor(original.length);
    let budgetExhausted = false;
    const keep = reason => {
      outParts.push(original);
      perTrack.push({ before: original.length, after: original.length, compressed: false, budget, budgetExhausted });
      if (reason) notes.push(i18n.t("compress.note.keptTrack", { n: i + 1, reason }));
    };

    if (o.preserveTracks?.has(i)) { keep(null); continue; }
    if (scans[i].error) { keep(scans[i].error); continue; }

    const cfg = makeEncoderCfg({
      allowedNums: o.allowedNums ?? [...nums],
      maxDots: o.maxDots ?? DEFAULT_MAX_DOTS,
      maxTieSegs: o.maxTieSegs,
      maxTieSegsMax: writeTieSegs(mergeRests(scans[i].items)),
      budget,
    });
    const out = itemsToMML(scans[i].items, { ...o, cfg, isFirstTrack: i === 0 });
    budgetExhausted = !!cfg.exhausted;
    if (cfg.exhausted) notes.push(i18n.t("compress.note.budgetExhausted", { n: i + 1 }));
    if (out === null) { keep(cfg.exhausted ? null : i18n.t("compress.err.uncodable")); continue; }
    // 壓完更長就用原文 —— 但原文本身必須日是遊戲吃得下的。少了後面那個條件，這一行會把非法的原文原
    // 封不動送進資料庫：`c8..` 只有 4 字，比等長的合法寫法 `c8.&c32`（7 字）短，所以純字數判準永遠
    // 站在 `..` 那一邊。字數是次要的目標，貼不進遊戲的譜再省也沒有用。
    if (out.length >= original.length && gameLegal(original)) { keep(null); continue; }

    outParts.push(out);
    perTrack.push({ before: original.length, after: out.length, compressed: true, budget, budgetExhausted });
  }

  const mml = "MML@" + outParts.join(",") + ";";

  let ok = null;
  if (typeof o.verifyWith === "function") {
    ok = sameEvents(o.verifyWith(src), o.verifyWith(mml));
    if (!ok) {
      notes.push(i18n.t("compress.note.verifyFailed"));
      return { mml: src, ok: false, before: src.length, after: src.length, saved: 0, perTrack, notes };
    }
  } else {
    notes.push(i18n.t("compress.note.noVerify"));
  }

  const kept = perTrack.filter(t => !t.compressed).length;
  if (kept === perTrack.length) notes.push(i18n.t("compress.note.alreadyTight"));

  return { mml, ok, before: src.length, after: mml.length, saved: src.length - mml.length, perTrack, notes };
}

/** 比對兩份解析結果，卜音符必須逐一相同。尾端休止符造成的長度差異忽略。 */
// ── 截斷（對外） ────────────────────────────────────────────────────────────

/** 一個 token 的開頭字元。截斷時要退回到這裡。 */
const TOKEN_START = /[a-hnoltvrp@[]/i;
/** 接在指令字母後面的參數：升降記號、數字、附點。 */
const TOKEN_TAIL = /[0-9.+\-#]/;

/**
 * 把一軌硬切到 max 字元，然後退回 token 邊界。分享功能用它把壓完還是超過 2400 的軌截短。
 *
 * 純 substring 會產生不會報錯的壞資料：`c16` → `c1`（長度悄悄變成 16 倍）、`o5` → `o`（後面整段音高
 * 跑掉）。判斷有沒有切壞不需要解析器 —— 看第 max 個字元是不是參數字元就知道刀落在 token 中間了。
 */
export function trimToToken(s, max) {
  if (s.length <= max) return s;
  let end = max;

  // 1. 刀落在參數中間：往前退到指令字母，連它一起丟掉 —— 它的參數已經沒了
  if (TOKEN_TAIL.test(s[end])) {
    while (end > 0 && !TOKEN_START.test(s[end - 1])) end--;
    if (end > 0) end--;
  }
  const out = s.slice(0, end);

  // 這裡曾經有第 2 步：「和弦被切一半就整組丟掉」，因為沒關閉的 `[` 會讓解析器停在
  // 那裡、後面整軌消失。和弦退役之後兩個前提都沒了：
  //   1. 唯一的呼叫端（share.prepare）在截斷之前就跑過 gameSafeTrack，而它現在會把
  //      `[` `]` 剝掉 —— 走到這裡的文字不可能還有括號。
  //   2. 就算有，沒關閉的 `[` 現在只是一個看不懂的字元，不會吃掉後面的音。
  // 留著反而有害：它會為了一個不存在竹的風險，把 `cde[ce` 砍成 `cde`（丟掉兩個好音）。

  // 尾端孤兒的連結線：`&` 後面已經沒有東西可以連
  return out.replace(/&+$/, "");
}

export function sameEvents(a, b, eps = 1e-6) {
  if (!a || !b || a.tracks.length !== b.tracks.length) return false;
  for (let i = 0; i < a.tracks.length; i++) {
    const x = a.tracks[i].notes, y = b.tracks[i].notes;
    if (x.length !== y.length) return false;
    for (let j = 0; j < x.length; j++) {
      if (x[j].midi !== y[j].midi || x[j].vel !== y[j].vel) return false;
      if (Math.abs(x[j].start - y[j].start) > eps) return false;
      if (Math.abs(x[j].dur - y[j].dur) > eps) return false;
    }
  }
  return true;
}

// ── 壓縮優化（有損／對外） ──────────────────────────────────────────────────
//
// 前面所有東西都是無損的：壓縮器只換寫法，不動一個 tick。這一節是唯一會改變聲音的部分。
//
// 唯一的不變量是逐組守恆：一個「音符 + 它後面連續的休止」是封閉的組，組內總長不變 —— 於是後面每一
// 個音的 onset 完全不動、整軌總 tick 完全不動，變的只有 articulation。
//
// 「只保證整軌結尾對得上，允許組間互相借還」刻意不做：那種破壞的表現是「拍子歪了但總長是對的」，
// `sameOnsets` 抓不到。

/**
 * 三個規則。每次執行只能選一個。
 *
 *   fill     休止全部併入前一個卜音
 *   partial  併入一部分，留一段較短的休止
 *   release  音尾讓出來變成休止（呼吸點）
 *
 * 單選而不是「每組取三者最好」，因為三者是同一組的競爭候選 —— 混在一起省下的字數無法歸因，使用者
 * 就無法取捨。release 有一個獨佔的族群：後面完全沒有休止的音符只有它碰得到。
 *
 * partial 在真實的譜上幾乎不出手，那是它的形狀決定的：它寫出來一定是「一個音 + 一個休止」所以下限
 * 是 2 個字，而規則的節奏型在無損壓縮之後一組本來就常常只要 2 個字；而且它需要「有一段更短的休止
 * 可以留」，實測語料 105 組有休止的組裡 90 組只有一格 60 tick。放寬格線實測零差異。
 */
export const OPT_RULES = ["fill", "partial", "release"];

/**
 * 延長方向用相對上限，縮短方向用絕對上限。這個不對稱是刻意的，而且是這一節最重要的設計決定。
 *
 * 延長靠樂器的衰減撐著：一個已經響了 5 拍的音音量早就衰到接近 0，所以能延長多少跟音符長度成正比。
 * 縮短是加入靜默，而靜默沒有任何東西可以藏 —— 0.25 秒的空白接在 8 拍的長音後面跟接在 1 拍的音後面
 * 一樣明顯。拿掉絕對上限的實測：`c1&c1` → `c1r1` 省 1 個字，全音符變成「半音符 + 全休止」，而相對
 * 倍率完全擋不住（1920 只是 3840 的 0.5 倍）。
 *
 * 已知的取捨：重複執行 release 沒有硬上限（每次 ≤ 240）。狀態式的封頂會砍掉 67% 的產能，所以改用
 * 資訊揭露（對話框同時報「省 N 字」與「影響 N 個音符」，Ctrl+Z 兜底）。
 *
 * 倍率是 3 不是 0.25、而且沒有最短音下限：原本的 0.25 配上「至少 480 tick」等於宣告「斷奏節奏型不
 * 能碰」，而那錯過了最大的一塊產能（一份 l32 的琶音伴奏 358 → 227 字）。3.0 是被 `c4r2.` → `c1`
 * （3 倍，可以）與 `c4r1`（4 倍，太長）夾出來的。
 *
 * 下限拿掉之後短音保護由倍率自己扛：一個 60 tick 的音最多只能長到 240 tick。這很重要 —— 純絕對上限
 * 在短音那端會炸開，實測只留絕對上限竹的話 l32 的音會被吸成一個 3 全音的長音（96 倍）。
 */
const OPT_EXT_RATIO = 3;
const OPT_CUT_CAP = 240;

/**
 * 延長之後的音符長度上限（3 個全音）。倍率擋短音那端，這條擋長音那端。
 *
 * 倍率是相對的，所以音愈長它給的額度愈大 —— `c1.`（2880）配上 3 倍就是可以長到 11520 tick，寫出來
 * 是 `c1.&c1.&c1.&c1.`。那不是「延音」，那是把一整段休止符改寫成一個 6 小節的持續音，衰減已經蓋不
 * 住了。兩道一起才封得住（見 OPT_EXT_RATIO 註解裡那個 96 倍的實測）。
 */
const OPT_MAX_NOTE = 3 * BAR_TICKS;

/**
 * 孤立估算至少要省幾個字才動手。1 而不是 2，因為它接的是一個系統性低估的估算：候選篩選用「這一組
 * 單獨拿出來編碼」的成本，而 `l` 是整軌共用的狀態。1200 tick 孤立算是 `c+.&c+`（6 字）改成 `c+2r8`
 * （5 字）只省 1；但在預設長度本來就是 `l2` 的軌上，同一件事省 2。低估的門檻要照低估校準。
 *
 * 真實字數不靠這個估算：候選全部套用之後整軌重編碼一次，那個數字才是回報給使用者的。
 */
const OPT_MIN_GAIN = 1;

/** 音名本身佔幾個字（`c` 1、`c+` 2）。八度移動不算 —— 音高不變，它也不會變。 */
function pitchChars(midi) {
  return SPELL[((midi - OCT_BASE) % 12 + 12) % 12].length;
}

/**
 * 一個音符寫出來要幾個字。**要自己算，不能直接拿 encodeDur 的 cost 用。**
 *
 * encodeDur 把每一段 `&` 算成 `hs.length + 2`，也就是假設音名只佔 1 個字。對 `c`
 * 是對的，對 `c+` 每段少算一個字。而 release 這個規則的價值**整個來自「省掉一次
 * 重複的音名」**（`&c+` 3 字換成 `r` 1 字）—— 用少算音名的成本去評估它，會系統性
 * 低估它，而且剛好在它最有價值的升降音上低估日最多。
 */
function noteChars(midi, dur, L, cfg) {
  const en = encodeDurUp(dur, L.num, L.dots, cfg);
  if (!en) return Infinity;
  const n = en.segs.length;
  // 實際輸出是 segs.map(s => 音名 + s).join("&")
  return n * pitchChars(midi) + en.segs.reduce((a, s) => a + s.length, 0) + (n - 1);
}

/** 一個休止寫出來要幾個字。休止不用 `&` 串（見 emitTrack），所以每段只多一個 `r`。 */
function restChars(dur, L, cfg) {
  const en = encodeDurUp(dur, L.num, L.dots, cfg);
  if (!en) return Infinity;
  return en.segs.length + en.segs.reduce((a, s) => a + s.length, 0);
}

/**
 * 估算用的參考預設長度清單 —— 跟 planDefaultLength 用同一套候選。
 *
 * 是一整組而不是「最常用的那一個」，因為真正的 DP 會在划算的地方切換 `l`，所以一個組實際付的錢是
 * 「它能拿到的最好的 l」。取 min 會高估收益（不付切換 l 的錢），而高估由 optimizeTrack 的整軌保底
 * 吸收。
 *
 * `want` 是候選會產生的新時值，少了它整個估算會系統性地反向：只從現況取樣的話，「這一軌改完之後
 * `l` 會跟著換」在估算裡完全看不見。實測一份整軌 l32 的伴奏，fill 之後每個音都是 120 tick、整軌
 * `l` 會翻成 l16，但候選裡只有 l32，於是 120 tick 被估成 3 字比原本的 2 字還長、每一組都被判定為
 * 虧損。餵進來之後同一軌是 358 → 227 字。
 *
 * 兩份候選各自取前 MAX_L_CANDIDATES 再聯集：混排會讓 `want` 的假票把現況的候選擠山出榜。
 */
function lengthCandidates(items, cfg, want = []) {
  const topN = durs => {
    const freq = new Map();
    for (const d of durs) {
      for (const sp of spellings(d, cfg)) {
        const k = sp.num * 8 + sp.dots;
        freq.set(k, (freq.get(k) ?? 0) + 1);
      }
    }
    return [...freq.entries()].sort((a, b) => b[1] - a[1]).slice(0, MAX_L_CANDIDATES).map(([k]) => k);
  };

  const here = items.filter(it => it.k === "note" || it.k === "rest").map(it => it.dur);
  const keys = new Set([...topN(here), ...topN(want)]);
  const out = [...keys].map(k => ({ num: Math.floor(k / 8), dots: k % 8 }));
  if (!out.some(c => c.num === DEFAULTS.lenNum && c.dots === DEFAULTS.lenDots))
    out.push({ num: DEFAULTS.lenNum, dots: DEFAULTS.lenDots });
  return out;
}

/** 一組（音符 + 一段休止）在最省的參考 l 之下要幾個字。Infinity = 寫不出來。 */
function groupChars(midi, noteDur, restDurs, Ls, cfg) {
  let best = Infinity;
  for (const L of Ls) {
    let c = noteChars(midi, noteDur, L, cfg);
    for (const d of restDurs) c += restChars(d, L, cfg);
    if (c < best) best = c;
  }
  return best;
}

/**
 * 切出竹所有「音符 + 它後面連續的休止」組。`from`／`to` 是 items 的半開區間。
 *
 * 兩種東西讓一組沒有資格被優化：組內夾著 t（t 的 tick 由序列位置決定，把休止併進音符會把它往後推
 * —— `c2t100r8` 的 t100 從 960 跑到 1200，tick 總長沒變但秒數變了，而那是驗證抓不到的破壞），以及
 * 組落在整軌尾端（尾端休止會被 dropTrailingRests 砍掉，吸收它們等於改變 endTick）。
 *
 * 夾著 v/@ 不用擋 —— 它們只影響「之後的音符」，而組內定義上沒有音符。
 */
function optGroups(items) {
  const out = [];
  let tick = 0;
  for (let i = 0; i < items.length; i++) {
    const it = items[i];
    if (it.k !== "note") { tick += it.dur ?? 0; continue; }

    const noteTick = tick;
    tick += it.dur;
    const restDurs = [], extras = [];
    let j = i + 1, blocked = false;
    for (; j < items.length; j++) {
      const x = items[j];
      if (x.k === "rest") { restDurs.push(x.dur); tick += x.dur; continue; }
      if (x.k === "note") break;
      // t 的 tick 語意會被推移，所以它必須讓這一組整組跳過（下面 repl 會把 extras 重排到音符後面，
      // 而那假設它們是零時長的）。
      if (x.k === "t") { blocked = true; break; }
      extras.push(x);                              // v / @：零時長，留在音符後面
    }
    // j 停在後面那人個音符上才算合格。停在 t 上（blocked）或走到底都不做。
    if (!blocked && j < items.length) {
      out.push({ from: i, to: j, tick: noteTick, midi: it.midi, noteDur: it.dur, restDurs, extras });
    }
    i = j - 1;
  }
  return out;
}

/**
 * R' 的候選：cfg 寫得出來的單一長度，而且對齊格線。
 *
 * 「單一」是刻意的 —— 拆成 `r2r8` 的休止在同一個位置不帶任何額外資訊。「對齊格線」是不產生 `l6`／
 * `l12` 的唯一手段，而且它是同一件事的兩面：R' 是 durGcd 的倍數 ⇒ N' 也是 ⇒ 整軌 durGcd 不變 ⇒
 * pickAlign 還是回 60 ⇒ buildTokens 繼續濾掉所有非 60 倍數的 token。
 */
function restOptions(cfg, grid) {
  return cfg.tokens.heads.filter(t => t % grid === 0).sort((a, b) => a - b);
}

/**
 * 一組在指定規則下**時值層面**合格的 (N', R') 候選，不看字數。
 *
 * 跟省字判定拆開是刻意的：`lengthCandidates` 需要知道「這條規則可能產生哪些新時值」
 * 才能把它們納入參考 `l`，而那件事必須發生在算字數之前 —— 算字數本身就要用參考 `l`。
 * 拆開之後兩邊共用同一份閘門，不會有一邊漏掉某條限制竹的機會。
 */
function optCandidates(g, rule, cfg, grid) {
  const N = g.noteDur;
  const R = g.restDurs.reduce((a, b) => a + b, 0), T = N + R;

  const raw = [];
  if (rule === "fill") { if (R > 0) raw.push([T, 0]); }
  else if (rule === "partial") { for (const rp of restOptions(cfg, grid)) if (rp < R) raw.push([T - rp, rp]); }
  else for (const rp of restOptions(cfg, grid)) if (rp > R) raw.push([T - rp, rp]);

  return raw.filter(([np, rp]) => {
    if (np <= 0) return false;
    if (rp % grid !== 0) return false;                              // 保住格線
    if (np > N) return np - N <= N * OPT_EXT_RATIO && np <= OPT_MAX_NOTE;  // 延長：倍率 + 絕對天花板
    if (np < N) return N - np <= OPT_CUT_CAP;                       // 縮短：絕對
    return true;
  });
}

/** 一組在指定規則下的最佳改寫，沒有合格的就回 null。 */
function optBest(g, rule, cfg, Ls, grid) {
  // 基準是「這一組照原樣寫」要幾個字。原本的多段休止要**逐段**算 —— 兩個 r8 是
  // 4 個字，不是一個 r4 的 2 個字；拿總長去算會把無損壓縮的功勞記到優化頭上。
  const base = groupChars(g.midi, g.noteDur, g.restDurs, Ls, cfg);
  if (!Number.isFinite(base)) return null;

  let best = null;
  for (const [np, rp] of optCandidates(g, rule, cfg, grid)) {
    const c = groupChars(g.midi, np, rp > 0 ? [rp] : [], Ls, cfg);
    if (!Number.isFinite(c) || base - c < OPT_MIN_GAIN) continue;
    if (!best || c < best.chars) best = { noteDur: np, restDur: rp, chars: c, gain: base - c };
  }
  return best;
}

/**
 * 有損優化：每人個組在組內重新分配長度，組內總長不變。
 *
 * @param {Array} items  trackToItems() 的 items。不就地修改。
 * @param {object} opts  rule（OPT_RULES 之一）、keys（Set<`${tick}:${midi}`>，null = 整軌）、
 *   cfg（共用的編碼器設定，必須是為這一軌建的 —— alignTo 是按軌算的）
 * @returns {{items:Array, changed:number, gain:number}}
 *   gain 是估算省下的字數，真實字數要 itemsToMML 之後量
 */
export function optimizeDurations(items, opts = {}) {
  if (!OPT_RULES.includes(opts.rule)) throw new Error(`unknown rule: ${opts.rule}`);

  const grid = durGcd(items);
  const cfg = opts.cfg ?? makeEncoderCfg({
    maxTieSegsMax: writeTieSegs(items),
    alignTo: pickAlign(items, STD_NUMS, DEFAULT_MAX_DOTS),
    budget: opts.budget,
  });
  const keys = opts.keys ?? null;

  const out = items.slice();
  let changed = 0, gain = 0;
  const groups = optGroups(items);

  // 參考 l 要先看過「這條規則會產生哪些新時值」才算得準 —— 見 lengthCandidates 的
  // `want`。竹所以順序是 groups → 候選時值 → Ls，不能反過來。
  const want = [];
  for (const g of groups) {
    if (keys && !keys.has(`${g.tick}:${g.midi}`)) continue;
    for (const [np, rp] of optCandidates(g, opts.rule, cfg, grid)) {
      want.push(np);
      if (rp > 0) want.push(rp);
    }
  }
  const Ls = lengthCandidates(items, cfg, want);
  // 從後往前改寫，前面那些組的 index 才不會被 splice 位移
  for (let gi = groups.length - 1; gi >= 0; gi--) {
    const g = groups[gi];
    if (keys && !keys.has(`${g.tick}:${g.midi}`)) continue;
    const b = optBest(g, opts.rule, cfg, Ls, grid);
    if (!b) continue;
    const repl = [{ k: "note", midi: g.midi, dur: b.noteDur }, ...g.extras];
    if (b.restDur > 0) repl.push({ k: "rest", dur: b.restDur });
    out.splice(g.from, g.to - g.from, ...repl);
    changed++;
    gain += b.gain;
  }
  return { items: out, changed, gain };
}

/**
 * 一軌的優化結果，可以一次算好幾個規則（同一軌共用 cfg，memo 才有意義）。
 *
 * 回傳兩個基準，因為它們回答兩個不同的問題，混用會說謊：`base` 是無損壓縮的輸出（驗證要拿它比 ——
 * 它跟優化後的輸出走同一套產生器設定），`before` 是使用者現在手上真的有幾人個字（取 base 與「原文去
 * 空白」之中較短的）。
 *
 * before 不能直接用 base，因為產生器不是永遠贏：拿 base 當基準的話對話框會說「省 7 字」而寫回去的
 * 文字比現在長 14 字。產生器現在只會在「原文用了它不產生的記法」時輸，但變罕見了不代表可以拿掉 ——
 * 它擋的是「回報省了 N 字，貼回去反而變長」這種使用者直接看得到的謊。
 *
 * @param {string} raw   一軌原文
 * @param {object} opts  rules（陣列）或 rule、keys，其餘照傳給 itemsToMML
 * @returns {{error:string}|{before:number, base:string, rules:Object}}
 */
export function optimizeTrack(raw, opts = {}) {
  const t = tokenize(raw);
  if (t.error) return { error: t.error };

  const items = t.items;
  // 分母白名單預設從這一軌自己取樣。呼叫端（ui）沒有 seenNums 可傳 —— 而少了它，用了白名單外分母
  // 的譜會在下一行就 `base === null`，整個優化功能對那些譜直接失效。
  opts = { allowedNums: encoderNums(t.seenNums), budget: budgetFor(bareTrack(raw).length), ...opts };
  const stats = {};
  const base = itemsToMML(items, { ...opts, stats });
  if (base === null) return {
    error: i18n.t(stats.budgetExhausted ? "compress.err.budgetExhausted" : "compress.err.uncodable"),
    reason: stats.budgetExhausted ? "budgetExhausted" : "uncodable",
  };

  // 原文只有在「遊戲吃得下」時才有資格當基準。少了後面那個條件，含 `..` 的原文
  // 會因為比較短而被當成標準，於是優化怎麼算都是負的、整個功能對那些譜失效 ——
  // 而那些譜本來就貼不進遊戲（見 gameSafeTrack）。
  //
  // 長度一律用 bareTrack 量，不是 String.length。**排版是免費的**（見 emitTrack 的
  // barsPerLine 註解：空白在匯出日時會被剝掉），所以開了「MML 格式化換行」時 base 裡
  // 的 `\n` 不能算進字數。這裡原本兩邊用不同的尺 —— 原文 `replace(/\s+/g,"")` 之後
  // 量、base 直接 `.length` —— 於是換行開著的人看到的每一個數字都被換行數撐大，
  // 對話框還會因此把沒超過上限的軌標成紅色。bareTrack 的文件寫得很清楚：「匯出」與
  // 「字數還剩多少」必須用同一個定義。
  const chars = s => bareTrack(s).length;
  const bare = bareTrack(raw);
  const before = bare.length < chars(base) && gameLegal(bare) ? bare.length : chars(base);

  const cfg = makeEncoderCfg({
    maxTieSegsMax: writeTieSegs(items),
    alignTo: pickAlign(items, STD_NUMS, DEFAULT_MAX_DOTS),
    budget: opts.budget,
  });

  const rules = {};
  const none = { out: base, after: before, changed: 0 };
  for (const rule of opts.rules ?? [opts.rule]) {
    const r = optimizeDurations(items, { rule, keys: opts.keys, cfg });
    if (!r.changed) { rules[rule] = none; continue; }
    const out = itemsToMML(r.items, opts);
    if (out === null) { rules[rule] = { error: i18n.t("compress.err.uncodableAfterOpt") }; continue; }
    // 整軌保底，跟 compressMML 的 `out.length >= original.length` 同一個精神：候選篩選竹的估算會高估
    // 收益（它不付切換 l 的錢），而高估的後果是「改了音樂但一個字都沒省」。
    rules[rule] = chars(out) >= before ? none : { out, after: chars(out), changed: r.changed };
  }
  return { before, base, rules, budgetExhausted: !!stats.budgetExhausted };
}

/**
 * 這一軌的時值會不會讓 DP 爆掉。
 *
 *  `durGcd < 30` —— 30 tick 是 `l64`，也就是標準寫法最細的一格，所以**任何標準譜的公因數都
 * 至少是 30**（本站語料的 60 軌實測落在 30–240）。掉到 30 以下代表有時值落在標準格線之外，
 * 而 `encodeDurUp` 對那種時值會一路往上爬段數、每一階重建一份 cfg 與空的 memo，直到把整個
 * 預算燒完。實測：0 → 1 個界外時值就是 ×80–180 的懸崖（DP 2ms → 400ms），而且**燒完之後還是
 * 會成功**，只是壓得比較差 —— 所以沒有「跑跑看不行再說」這個選項，一定要事前擋。
 *
 *  `dur % 5` 是同一件事的另一面：19 個標準 token 的 tick 公因數是 5，所以除不盡 5 的時值一定
 * 在格線外。單獨留著是因為「整軌只有一種界外時值」時公因數會等於那個時值本身（可能 ≥ 30），
 * gcd 那一條看不出來。
 */
const dpHazard = items =>
  durGcd(items) < 30 || items.some(x => hasDur(x) && x.dur % 5 !== 0);

/**
 * **壓縮模式**的一次壓縮：一軌文字 → 更短的等價文字。
 *
 *  `opts` 必須跟「優化」框無損那一層用的完全相同（ui 傳 `genOpts()`），不然會出現「對話框
 * 說壓完是 2100 字，按下去之後編輯一次變成 2085」。所以這裡就是 `optimizeTrack` 去掉
 * `rules` 與 `keys`，加上前面兩道閘門。
 *
 *  **這一支跑在每一次編輯上**，不是使用者按一次按鈕 —— 那正是它要擋在 DP 前面的理由。
 * 兩種早退分開回報，因為對使用者的意義完全不同：
 *
 *    `nonstd`   非標準分母（`l7` / `l9` / `l17`）。**有一顆按鈕修得好** —— 工具列的
 *               「還原」。所以這不是失敗，是等他先按；旗標要留著，修好之後下一次編輯
 *               就會自己壓回去。
 *    `hazard`   時值落在標準格線外但分母是標準的（大量三連音混一般時值，公因數掉到 5 或
 *               10）。**沒有按鈕修得好**，所以只能安靜地不壓 —— 講一句他做不到的事只是
 *               打斷他。實測這種軌 `optimizeTrack` 要 1.4 秒。
 *
 *  驗證不能省。無損壓縮的承諾就是「音樂完全相同」，而自動化之後它跑的次數是手動按優化的
 * 幾百倍 —— 省掉驗證等於把偶發的壓縮 bug 直接寫進使用者的譜。
 *
 * @returns {{out:string} | {bug:true} | {skip:"nonstd"|"hazard"|"nogain"|"uncodable"}}
 *          `out` 才是壓成功；其餘一律該退回照實版。`bug` 是驗證沒過（呼叫端要講一聲）。
 */
export function zipOnce(raw, opts = {}) {
  const t = tokenize(raw);
  if (t.error) return { skip: "uncodable" };
  // 順序有意義：非標準分母是「有解」的那一種，要先認出來。
  if ([...t.seenNums].some(n => !STD_SET.has(n))) return { skip: "nonstd" };
  if (dpHazard(t.items)) return { skip: "hazard" };

  const r = optimizeTrack(raw, { ...opts, rules: [] });
  if (r.error) return { skip: "uncodable" };
  const out = r.base;
  // 壓完沒有比較短就不寫，同 compressMML 的 keep()。長度一律用 bareTrack 量 —— 開了
  // 「MML 格式化換行」時輸出帶著換行，而換行在遊戲裡不佔字數。
  if (out === null || bareTrack(out).length >= bareTrack(raw).length) return { skip: "nogain" };
  if (!sameEvents(parseAll([raw]), parseAll([out]))) return { bug: true };
  return { out };
}

/**
 * 優化用的驗證。不能用 sameEvents —— 它比時值，而優化就是在改時值，必然失敗。
 *
 * 這裡比的每一條都對應一個真實的失效方式：音符數／midi／vel（改了就不是同一首曲子）、tick（改了
 * 就是節奏歪了，最重要的一條）、endTick（全長變了）、tempos（`t` 的 tick 被推移 —— tick 域完全看
 * 不出來、秒域差很多，optGroups 跳過組內夾 t 是第一道，這是第二道）。
 *
 * durTick 刻意不比 —— 那正是允許改變的量，它的上下限由 optBest 的閘門負責。
 */
export function sameOnsets(a, b) {
  if (!a || !b || a.tracks.length !== b.tracks.length) return false;
  if (a.tempos.length !== b.tempos.length) return false;
  for (let i = 0; i < a.tempos.length; i++)
    if (a.tempos[i].tick !== b.tempos[i].tick || a.tempos[i].bpm !== b.tempos[i].bpm) return false;
  for (let i = 0; i < a.tracks.length; i++) {
    const x = a.tracks[i], y = b.tracks[i];
    if (x.endTick !== y.endTick || x.notes.length !== y.notes.length) return false;
    for (let j = 0; j < x.notes.length; j++) {
      const p = x.notes[j], q = y.notes[j];
      if (p.midi !== q.midi || p.vel !== q.vel || p.tick !== q.tick) return false;
    }
  }
  return true;
}
