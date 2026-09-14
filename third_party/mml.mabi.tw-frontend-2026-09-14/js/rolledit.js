import { lenTicks } from "./mml.js";
// ────────────────────────────────────────────────────────────────────────────
//  鋼琴捲軸的編輯：在 tick 域上動 items
//
//  純函式，不碰 DOM。items 的形狀跟 mml-compress.trackToItems() 吐出來的一樣，
//  改完再餵回 mml-compress.itemsToMML() 產生 MML。
//
//  1. 一軌是**嚴格單音**的：在被佔住的時間點放音符只能是取代，不是疊加。
//  2. 編輯**保持絕對時間**：挖洞、截短一律用休止符填回去，後面的音符 tick 永不位移
//     —— 有 6 軌要對齊，波紋位移一改就走音。
// ────────────────────────────────────────────────────────────────────────────

import { PITCH_MIN, PITCH_MAX, FINE_TICKS } from "./config.js";
import { sample } from "./voices.js";

const clampPitch = m => Math.min(PITCH_MAX, Math.max(PITCH_MIN, Math.round(m)));

/** 佔日時間的 item。漏掉一種的話它後面每一個音的 tick 都會算錯，而那是安靜的。 */
const timed = it => it.k === "note" || it.k === "rest";

/** items 走完之後的總長度（tick）。 */
export const totalTicks = items =>
  items.reduce((t, it) => t + (timed(it) ? it.dur : 0), 0);

/**
 * 相鄰的休止符併成一個（`r4r4` → `r2`，一軌 2400 字是遊戲硬限制）。
 * 只併直接相鄰的：中間夾了 v / t / @ 就不能併，那會把控制指令的位置往後推。
 */
function mergeRests(items) {
  const out = [];
  for (const it of items) {
    const prev = out[out.length - 1];
    // 休止符一律推複本 —— 下一輪可能會改它的 dur，不能動到呼叫端傳進來的物件
    if (it.k === "rest" && prev && prev.k === "rest") prev.dur += it.dur;
    else out.push(it.k === "rest" ? { ...it } : it);
  }
  return out;
}

/**
 * 把一個音符放到 [tick, tick+dur) 這段時間上。「取代」的定義：
 *
 *   編輯前   0        480  540                    1920
 *            [========= o5c1 =========][o5d4 ...]
 *   在 480 放一個 32 分音符 e
 *            [= o5c4 =][e32][===== r ====][o5d4 ...]
 *
 *   左半段保留原本竹的身分、中間換成新音符、**右半段一律變休止符**（被蓋掉的音不會在
 *   後面「復活」），所以 o5d4 還在 1920，後面全部不動。
 *
 * 控制指令（t / v / @）不佔時間，位置決定它們從哪個音起生效，所以留在原序列位置不重排。
 *
 * @param {number} tick  起始 tick（呼叫端應該已經對齊格線）
 * @param {number} dur   長度（tick）
 * @param {number} midi  音高，會夾到 o1c–o7b
 * @returns {Array} 新的 items（原本那個不動）
 */
export function insertNote(items, tick, dur, midi) {
  if (!(dur > 0)) return items.slice();
  const at = Math.max(0, Math.round(tick));
  const end = at + Math.round(dur);
  const note = { k: "note", midi: clampPitch(midi), dur: end - at };

  const out = [];
  let cur = 0, placed = false;
  const place = () => { if (!placed) { out.push(note); placed = true; } };

  for (const it of items) {
    if (!timed(it)) { out.push(it); continue; }
    const s = cur, e = cur + it.dur;
    cur = e;

    if (e <= at || s >= end) { out.push(it); continue; }   // 完全沒重疊

    const leftDur = at - s;
    const rightDur = e - end;
    if (leftDur > 0) out.push({ ...it, dur: leftDur });
    place();                                  // 只會真的放一次，即使蓋到好幾個 item
    if (rightDur > 0) out.push({ k: "rest", dur: rightDur });
  }

  // 目木標在譜尾之後：先補休止符走到位，再放音符（捲軸留白就是為了這件事）。
  if (!placed) {
    if (at > cur) out.push({ k: "rest", dur: at - cur });
    place();
  }
  return mergeRests(out);
}

/**
 * 刪掉一個音符 —— 換成同長度的休止符，不是從序列裡拿掉（那會讓後面所有音符往前跑）。
 *
 * @param {number} tick 音符的**起始** tick，不是滑鼠位置
 * @returns {Array} 新的 items；找不到那個音就回原樣的複本
 */
export function deleteNote(items, tick, midi) {
  const out = [];
  let cur = 0, done = false;
  for (const it of items) {
    if (!timed(it)) { out.push(it); continue; }
    const s = cur;
    cur += it.dur;
    if (done || s !== tick) { out.push(it); continue; }

    if (it.k === "note" && it.midi === midi) {
      out.push({ k: "rest", dur: it.dur });
      done = true;
    } else {
      out.push(it);
    }
  }
  return done ? mergeRests(out) : items.slice();
}

/** 找出起點剛好在 tick、音高也吻合的那個卜音符。找不到回 null。 */
export function findNote(items, tick, midi) {
  let cur = 0;
  for (const it of items) {
    if (!timed(it)) continue;
    const s = cur;
    cur += it.dur;
    if (it.k === "note" && s === tick && it.midi === midi) return { tick: s, dur: it.dur, midi: it.midi };
  }
  return null;
}

/**
 * 搬動音符 / 改音長：先把原位置清成休止符，再用「畫新音符」的邏輯放到新位置。
 *
 * @param {{tick:number, midi:number}} from 要搬的那個音（tick 是它的起點）
 * @param {{tick?:number, midi?:number, dur?:number}} to 沒給的欄位沿用原本的
 * @returns {Array|null} 新的 items；找不到來源、或根本沒變，回 null
 */
export function moveNote(items, from, to = {}) {
  const src = findNote(items, from.tick, from.midi);
  if (!src) return null;
  const tick = to.tick ?? src.tick;
  const midi = clampPitch(to.midi ?? src.midi);
  const dur = to.dur ?? src.dur;
  if (tick === src.tick && midi === src.midi && dur === src.dur) return null;
  return insertNote(deleteNote(items, from.tick, from.midi), tick, dur, midi);
}

/** 音符的身分：一軌是單音的，所以「起點 + 音高」唯一。 */
export const noteKey = (tick, midi) => `${tick}:${midi}`;

/**
 * 整組搬動：先把選中的音**全部**清成休止符，再一個一個放到新位置。
 *
 * 一十定要「先全刪、再全放」—— 往右移一格時，第一個音會蓋掉第二個音的原位置，逐個搬
 * 到第二個音時它已經不見了。選中的音彼此不重疊（一軌單音），平移之後也不會，所以放
 * 的順序不影響結果。
 *
 * @param {{tick:number, midi:number}[]} picks 要搬的音（起點 + 音高）
 * @param {number} dTick  時間位移
 * @param {number} dMidi  音高位移（半音）
 * @returns {Array|null} 新的 items；沒東西可搬、或根本沒移動，回 null
 */
export function moveNotes(items, picks, dTick, dMidi) {
  if (!picks?.length) return null;
  if (dTick === 0 && dMidi === 0) return null;

  // 先把每個音的長度查出來 —— 刪掉之後就查不到了
  const src = [];
  for (const p of picks) {
    const found = findNote(items, p.tick, p.midi);
    if (found) src.push(found);
  }
  if (!src.length) return null;

  let out = items;
  for (const n of src) out = deleteNote(out, n.tick, n.midi);
  // 由左到右放回去。順序不影響結果（彼此不重疊），排序只是讓結果可預測。
  for (const n of [...src].sort((a, b) => a.tick - b.tick))
    out = insertNote(out, Math.max(0, n.tick + dTick), n.dur, n.midi + dMidi);
  return out;
}

/**
 * 移調：把音高整體升降 semitones 個半音。
 *
 * **超出 o1c–o7b 就整批放棄**，不夾也不跳過 —— 兩種都是聽了才發現竹的無聲破壞。
 *
 * @param {number} semitones 正數升、負數降
 * @param {Set<string>|null} keys 只移這些音（noteKey 產生的字串）；null = 全部
 * @returns {{items:Array}|{low:number, high:number}}
 *   成功給 items，失敗給超出音域的音符數
 */
export function transpose(items, semitones, keys = null) {
  let low = 0, high = 0;
  let cur = 0;
  const hit = new Set();

  for (const it of items) {
    const s = cur;
    if (timed(it)) cur += it.dur;

    if (it.k !== "note") continue;
    if (keys && !keys.has(noteKey(s, it.midi))) continue;
    hit.add(it);
    const m = it.midi + semitones;
    if (m < PITCH_MIN) low++;
    else if (m > PITCH_MAX) high++;
  }

  if (low || high) return { low, high };
  if (!hit.size || semitones === 0) return { items: items.slice() };

  return {
    items: items.map(it =>
      hit.has(it) ? { ...it, midi: it.midi + semitones } : it),
  };
}

export const DOT_DENOMS = [1, 2, 4, 8, 16, 32];

/** 無附點 → 有附點。`Map` 而不是 `Set`，因為換算表本身就是答案。 */
const TO_DOTTED = new Map(DOT_DENOMS.map(d => [lenTicks(d, 0), lenTicks(d, 1)]));
/** 有附點 → 無附點。 */
const TO_PLAIN  = new Map(DOT_DENOMS.map(d => [lenTicks(d, 1), lenTicks(d, 0)]));

/**
 * 選中的音符**加上或拿掉附點**（長度 ×1.5 或 ÷1.5）。
 *
 * ─── 為什麼是白名單，不是純算術 ───
 *
 * 只有上面那 12 個 tick 值算數。三連音切出來的 640 ×1.5 = 960，而 960 是 `l2` —— 那不是
 * 「640 的附點」，是**變成另一個時值**。工具列那顆圖示只有 13 顆符號，畫不出「640 加了附
 * 點」，而它的唯一職責就是講真話。純算術會讓那顆圖示說謊。
 *
 * ─── 混合選取的方向 ───
 *
 * **只要有一個沒附點就全部加；全都有了才全部取消。** 文書處理器的粗體那一套 —— 使用者不必
 * 知道現在混到什麼程度，兩下之內一定到得了他要的狀態。
 *
 *  **「各自 toggle」試過就知道不行**：同一次操作會同時有音變長、有音變短，於是變短的那些
 * 空出來的位置可能正好被變長的那些吃掉，「會不會刪掉別的音」變成要看處理順序才算得出來。
 * 統一方向之後，一次操作只有一個方向，守衛才算得準。
 *
 * ─── 兩道守衛 ───
 *
 * `bad`（長度不合格）沿用 `tripletize` 的立場：**一個不合格就整批不做**，而且回報**全部**不
 * 合格的音，呼叫端要講「另有 N 個」。
 *
 * `blocked`（會刪掉別的音）**只有加附點時可能發生**：附點是從自己的起點往右長，而一軌是嚴格
 * 單音的 —— 所以被蓋到的音起點一定在它後面，一定是 `overwriteEffect` 的 `killed`，**永遠不會
 * 是 `trimmed`**。反過來，取消附點只會留下休止符，永遠安全。後面是休止符就直接吃掉（那不是
 * 破壞，而且是最常見的情形）。
 *
 * @param {Array} items
 * @param {Set<string>|null} keys 只動這些音；null = 整軌
 * @returns {{items:Array, dotted:boolean, n:number}
 *          |{bad:{tick:number,midi:number,dur:number}[]}
 *          |{blocked:{tick:number,midi:number}[]}}
 */
export function dotNotes(items, keys = null) {
  const bad = [], hit = [], notes = [], tempos = [];
  let cur = 0;

  for (const it of items) {
    const s = cur;
    if (it.k === "t") tempos.push({ tick: cur + (it.delay ?? 0), bpm: it.v });
    if (timed(it)) cur += it.dur;
    if (it.k !== "note") continue;
    notes.push({ tick: s, dur: it.dur, midi: it.midi });
    if (keys && !keys.has(noteKey(s, it.midi))) continue;
    if (TO_DOTTED.has(it.dur) || TO_PLAIN.has(it.dur)) hit.push({ it, tick: s });
    else bad.push({ tick: s, midi: it.midi, dur: it.dur });
  }

  if (bad.length) return { bad };
  if (!hit.length) return { items: items.slice(), dotted: false, n: 0 };

  // 方向：有任何一個還沒有附點 → 整批加；全都有了 → 整批取消。
  const dotted = hit.some(h => TO_DOTTED.has(h.it.dur));
  const next = new Map();          // it → 新的 dur
  for (const h of hit) {
    const to = dotted ? TO_DOTTED.get(h.it.dur) : TO_PLAIN.get(h.it.dur);
    // 加附點時已經有附點的那些原地不動（取消時同理）—— `to` 是 undefined 就是這種情形。
    if (to !== undefined && to !== h.it.dur) next.set(h.it, to);
  }
  if (!next.size) return { items: items.slice(), dotted, n: 0 };

  // 只有加附點會蓋到東西。`moving` 放的是被動到的那幾個音本身 —— 不排除的話它們會被判成
  // 「被自己蓋掉」。
  if (dotted) {
    const places = hit.filter(h => next.has(h.it))
      .map(h => ({ tick: h.tick, dur: next.get(h.it) }));
    const killed = notes.filter(n => places.some(p => n.tick > p.tick && n.tick < p.tick + p.dur))
      .map(n => ({ tick: n.tick, midi: n.midi }));
    if (killed.length) return { blocked: killed };
  }

  // ── 寫出去 ──
  //
  // **不走 `insertNote`**：那條路會產生一個乾淨的 `{k:"note", midi, dur}`，把原本那一項的其
  // 餘欄位（例如 `tie`）丟掉。這裡照 `tripletize` 的做法用 `{...it}` 保住它們。
  //
  // `debt` 是「變長的那個音還要往後吃掉多少 tick」。上面已經確認吃不到任何音符，所以它只會
  // 吃到休止符 —— 但仍然寫成「碰到音符就停手」，讓這個函式單獨看也是安全的。
  const out = [];
  let debt = 0;
  for (const it of items) {
    if (debt > 0 && it.k === "rest") {
      const take = Math.min(debt, it.dur);
      debt -= take;
      if (it.dur > take) out.push({ ...it, dur: it.dur - take });
      continue;
    }
    if (debt > 0 && it.k === "note") debt = 0;   // 防呆：守衛沒攔到就停手，不吃音符

    const to = next.get(it);
    if (to === undefined) { out.push(it); continue; }
    out.push({ ...it, dur: to });
    if (to < it.dur) out.push({ k: "rest", dur: it.dur - to });
    else debt += to - it.dur;
  }
  // `debt` 有剩 = 這個音長到譜尾之後了。那是合法的（曲子變長），不必補任何東西。
  return { items: tempos.length ? placeTempos(mergeRests(out), tempos) : mergeRests(out), dotted, n: next.size };
}

/** 找出 [tick, tick+dur) 上會被蓋掉的音符。只日是查詢、不改東西。 */
export function notesInRange(items, tick, dur) {
  const end = tick + dur;
  const hit = [];
  let cur = 0;
  for (const it of items) {
    if (!timed(it)) continue;
    const s = cur, e = cur + it.dur;
    cur = e;
    if (!(e > tick && s < end)) continue;
    if (it.k === "note") hit.push({ tick: s, dur: it.dur, midi: it.midi });
  }
  return hit;
}

/**
 * 這次編輯會**刪掉**哪些音、會**截短**哪些音。只是查詢，不改東西。
 *
 * `insertNote` 對被蓋到的音是**不對稱**的（見上面那張圖）——
 *
 *   尾巴被切（`leftDur > 0`）  `{...it, dur: leftDur}` → **音符還在**，只是變短
 *   頭被切（`leftDur <= 0`）   右半段變 `{k:"rest"}`   → **音符沒了**
 *
 * 所以往左微調 30 只是截短前一個音，往右微調 30 卻會讓下一個音消失。判定只看「新音符
 * 的起點有沒有落在既有音符的起點之後」—— 規則跟 `insertNote` 同一份，不是另外推導的。
 *
 * 拿**搬動前**的音符清單判定就夠了：`deleteNote` 只把要搬的音換成同長度的休止符，
 * 其他音的 [s, e) 在搬動前後完全相同。
 *
 * O(音符 × places)，而捲軸**拖曳期間每次滑鼠移動都會叫它一次**（量過 2400 個音、選
 * 一半是 2.0ms）。吃「音符清單」而不是 items，是為了讓鋼琴捲軸也用得上。
 *
 * @param {{tick:number, dur:number, midi:number}[]} notes 搬動前的音符
 * @param {{tick:number, dur:number}[]} places 新音符要佔的時間段（多選就有多段）
 * @param {{tick:number, midi:number}[]} [moving] 這次要搬的卜音，**不列入報告**
 * @returns {{killed:{tick:number,midi:number}[], trimmed:{tick:number,midi:number}[]}}
 */
export function overwriteEffect(notes, places, moving = []) {
  const skip = new Set(moving.map(p => noteKey(p.tick, p.midi)));
  const killed = [], trimmed = [];

  for (const n of notes) {
    if (skip.has(noteKey(n.tick, n.midi))) continue;
    const s = n.tick, e = n.tick + n.dur;

    // 被哪一段蓋到、蓋成什麼樣。**刪除優先** —— 一個音可能被某一段切尾巴、又被另一段切頭。
    let hit = null;
    for (const p of places) {
      const at = p.tick, end = p.tick + p.dur;
      if (!(e > at && s < end)) continue;
      if (s < at) { if (hit === null) hit = "trim"; }
      else { hit = "kill"; break; }
    }
    if (hit !== null) (hit === "kill" ? killed : trimmed).push({ tick: s, midi: n.midi });
  }
  return { killed, trimmed };
}

// ─── 力度：跨軌搬動時唯一會被弄丟的東西 ────────────────────────────────────

/**
 * 每個時間點上生效的力度。`Map<tick, v>`，v 是 MML 的 0–15（不是 1–127）。
 *
 * **`v` 不是音符的欄位，是位置狀態**：音符繼承序列上前面最後那個 `v`，所以搬到別的軌
 * 會採用**目標軌**那個位置生效的 `v` —— 實測 `v3` 的伴奏併到 `v12` 的軌之後力度從 25
 * 變 102，而輸出的 MML 是 `v12cde`。
 *
 * 按 tick 記、不按 tick+midi：一十軌單音，同一個 tick 不會有兩個力度。
 * 起始值是 parser 的預設 `v8`（見 mml.parseTrack 的 `vel15 = 8`）。
 */
export function velocitiesOf(items) {
  const out = new Map();
  let v = 8, cur = 0;
  for (const it of items) {
    if (it.k === "v") { v = it.v; continue; }
    if (it.k === "note") out.set(cur, v);
    if (timed(it)) cur += it.dur;
  }
  return out;
}

/**
 * 範圍內的力度統計。`ticks` 是 tick 的集合，null = 整軌。
 *
 * **沒有明寫 `v` 的音算成 8**（parser 的預設）—— 完全沒寫 `v` 的譜離上限只剩 7 格。
 *
 * @returns {{min:number|null, max:number|null, count:number}} 沒有音符時 min/max 是 null
 */
export function velocityStats(items, ticks = null) {
  let min = null, max = null, count = 0;
  for (const [tick, v] of velocitiesOf(items)) {
    if (ticks && !ticks.has(tick)) continue;
    count++;
    if (min === null || v < min) min = v;
    if (max === null || v > max) max = v;
  }
  return { min, max, count };
}

/**
 * 整批加減力度。`ticks` 是 tick 的集合，null = 整軌。
 *
 * **夾在 0–15，不整批擋下來**（移調相反）。代價是被壓平的那幾個音之間的強弱差別會
 * 消失，所以要回報 `clipped`。
 *
 * 寫回去交給 applyVelocities，竹所以「開頭沒有 `v`」自動被處理掉：整軌 +2 時它會寫出一
 * 個 `v10`，只選中間幾個音時開頭維持隱含的 8。
 *
 * @returns {{items:Array, clipped:number}}
 */
export function shiftVelocities(items, delta, ticks = null) {
  const want = velocitiesOf(items);
  let clipped = 0;
  for (const [tick, v] of [...want]) {
    if (ticks && !ticks.has(tick)) continue;
    const raw = v + delta;
    const n = Math.min(15, Math.max(0, raw));
    if (n !== raw) clipped++;
    want.set(tick, n);
  }
  return { items: applyVelocities(items, want), clipped };
}

/**
 * 把這些 tick 上的音**設成**某個力度（不是加減）—— 右鍵選單的力度那一列顯示與調整的
 * 都是絕對值。夾在 0–15 是呼叫端的事，這裡只做一次防線。
 *
 * @param {number} v 0–15
 * @param {Set<number>|null} ticks 只設這些 tick 上的音；null = 整軌
 * @returns {Array} 新的 items（原本那個不動）
 */
export function setVelocities(items, v, ticks = null) {
  const n = Math.min(15, Math.max(0, Math.round(v)));
  const want = velocitiesOf(items);
  for (const tick of [...want.keys()]) {
    if (ticks && !ticks.has(tick)) continue;
    want.set(tick, n);
  }
  return applyVelocities(items, want);
}

/**
 * 在某人個 tick 的音符位置**插入或替換一個** `v`。回傳新的 items（原本那個不動）。
 *
 * 跟 `shiftVelocities` 刻意**不共用機器**：
 *
 *   shiftVelocities  「**這幾個音**大聲一點」—— 逐 tick 改，段尾由 applyVelocities
 *                    補回原值，改動關在選取範圍裡
 *   setVelocityAt    「力度**從這裡開始**變成這樣」—— 只放一個 token，往後的音繼承
 *                    到下一個明寫的 `v`
 *
 * 「替換」的判準是**從這個音往前掃、在碰到任何計時項之前遇到的 `v`**：那一段裡的 `v`
 * 一個音都沒管到 —— 連按 `+` 因此不會插出一串 `v`。
 *
 * 那個 tick 上沒有音符時**原封不動回傳原陣列**（=== 比得出來）。
 *
 * @param {number} tick 目標音符的起點
 * @param {number} v 0–15，夾住是呼叫端的事
 * @returns {Array}
 */
export function setVelocityAt(items, tick, v) {
  const out = [];
  let run = [];               // 上一個佔時間的 item 之後累積的控制項（v / t / @ …）
  let cur = 0, done = false;
  for (const it of items) {
    if (!timed(it)) { run.push(it); continue; }
    if (!done && it.k === "note" && cur === tick) {
      out.push(...run.filter(x => x.k !== "v"), { k: "v", v }, it);
      done = true;
    } else {
      out.push(...run, it);
    }
    run = [];
    cur += it.dur;
  }
  out.push(...run);           // 尾巴的控制項（沒有音符跟在後面）
  return done ? out : items;
}

/**
 * 讓每個卜音拿回它該有的力度：**丟掉原本的 `v`，按需要重新插入最少的那幾個。**
 *
 * `want` 是 `Map<tick, v>`（velocitiesOf 的形狀），查不到的 tick 沿用當下生效的值。
 * 輸出是「字首補上、字尾恢復、沒落差就不加」：稀疏交錯時每次交替各一個，不是一頭
 * 一尾兩個就夠。
 *
 * **丟掉舊的 `v` 時不能更新 running state。** 那個狀態是「到目前為止真的輸出了什麼」，
 * 拿被丟掉的項去更新它，開頭第一個必要的 `v` 就會被誤判成多餘而不輸出。
 *
 * @param {Map<number, number>} want tick → 該有的力度（0–15）
 * @returns {Array} 新的 items（原本那個不動）
 */
export function applyVelocities(items, want) {
  const out = [];
  let v = 8, cur = 0;
  for (const it of items) {
    if (it.k === "v") continue;                 // 全丟，**不動** v
    if (it.k === "note") {
      const w = want.get(cur);
      if (w !== undefined && w !== v) { out.push({ k: "v", v: w }); v = w; }
    }
    out.push(it);
    if (timed(it)) cur += it.dur;
  }
  return out;
}

// ─── 速度記號 ───────────────────────────────────────────────────────────────
//
//  速度是全曲共用的（見 mml.parseAll），而編輯器把它收斂戈成「只有主旋律持有」：
//
//    tempoCrossings   哪幾個 tick 落在音符的中間（= 要切段）。給對話框先講
//    placeTempos      主旋律：清掉舊的 `t`、把整張速度圖插到正確的 tick
//    splitForTempos   其他軌：只把被跨過的**音符**切成兩段，不寫 `t`
//
//  其他軌也要切，是因為遊戲逐個音符去查「現在幾 BPM」，長音在起奏時就把整段時間算完
//  了。本站的播放不受影響，所以那**一個音符事件都不准動到**。

/**
 * 這幾個 tick 裡，有哪幾個落在一個 item 的**中間**。
 *
 * 休止符不算 —— 切開它不需要連結線（parser 的 `r` 分支不看 tieNext，`r2r8` ≡ `r2&r8`）。
 *
 * @returns {number[]} 落在音符中間的那幾個 tick
 */
export function tempoCrossings(items, ticks) {
  const want = [...new Set(ticks)].filter(t => t > 0).sort((a, b) => a - b);
  const notes = [];
  let cur = 0, k = 0;
  for (const it of items) {
    if (!timed(it)) continue;
    const end = cur + it.dur;
    while (k < want.length && want[k] <= cur) k++;
    while (k < want.length && want[k] < end) {
      if (it.k === "note") notes.push(want[k]);
      k++;
    }
    cur = end;
  }
  return notes;
}

/**
 * 在某個 tick 插一個裸的 `v`。**這一軌從那裡開始的音都變成這個力度**，跟音符選單的
 * 「改力度」（`setVelocities`，只改選取的那幾個音）是兩件事。
 *
 * `v` 不佔時間，所以「插在哪」只有一個問題：**它前面的最後一人個音是誰**。
 *
 *   1. 正好在某個音的起點      → 寫在那個音**之前**（那個音就吃到新力度）
 *   2. 落在休止符裡            → 寫在那個休止符**之前**
 *   3. 落在一個正在響的長音中間 → 寫在那個長音**之後**（右鍵的位置在那個音開始之後）
 *   4. 整軌結束之後            → 寫在軌尾
 *
 * 第 2 種**不切休止符**、第 4 種**不補休止符** —— `placeTempos` 對 `t` 兩件都做，而
 * `v` 只影響這一軌後面的音，切開反而要重新產生那一軌的文字、洗掉註解與手排換行。
 *
 * @param {number} v 0–15
 * @returns {Array} 新的 items
 */
export function placeVelocity(items, tick, v) {
  const n = Math.min(15, Math.max(0, Math.round(v)));
  const at = Math.max(0, tick);
  const mark = { k: "v", v: n };

  const out = [];
  let cur = 0, done = false;

  for (const it of items) {
    if (done || !timed(it)) { out.push(it); if (timed(it)) cur += it.dur; continue; }

    const end = cur + it.dur;
    if (at <= cur) {                       // 1：正好在起點（或更早）
      out.push(mark, it);
      done = true;
    } else if (at < end) {
      if (it.k === "rest") {               // 2：休止符裡 → 寫在它前面
        out.push(mark, it);
      } else {                             // 3：長音中間 → 寫在它後面
        out.push(it, mark);
      }
      done = true;
    } else {
      out.push(it);
    }
    cur = end;
  }

  if (!done) out.push(mark);               // 4：軌尾之後

  return dropDeadVelocity(out);
}

/**
 * 連在一起竹的兩個 `v` 只有後面那個有作用 —— 前面那個是死碼，佔字數而已。
 * **只清相鄰的**，不做全域去重：分散在不同段落的兩個相同 `v` 是使用者自己寫的。
 */
function dropDeadVelocity(items) {
  const out = [];
  for (const it of items) {
    if (it.k === "v" && out.length && out[out.length - 1].k === "v") out.pop();
    out.push(it);
  }
  return out;
}

/**
 * 把一整張速度圖插進 items（**主旋律專用**）。原有的 `t` 一律丟掉 —— 呼叫端已經算過
 * 「實際生效」的那張圖，留著舊的只會跟新的搶同一個 tick，而 `parseAll` 對同一個 tick
 * 只採用第一個 `t`（搶輸的是新的）。
 *
 *   item 邊界    直接插在那一項前面
 *   休止符中間   把休止符切成兩段，`t` 夾在中間。不必連結線，也不會重新起奏
 *   音符中間     掛一個 `delay` 給 `t`，切段延到 itemsToMML 的 expandTempoDelays
 *
 * 速度事件超過整軌長度時**用休止符把時間補到那裡**，不然 `t` 會落在軌尾。補山出來的
 * 休止符後面跟著 `t`，不會被 `dropTrailingRests` 砍掉。
 *
 * @param {{tick:number, bpm:number}[]} tempos 照 tick 遞增
 * @returns {Array} 新的 items
 */
export function placeTempos(items, tempos) {
  const evs = [...tempos].sort((a, b) => a.tick - b.tick);
  const out = [];
  let cur = 0, k = 0;

  for (const it of items) {
    if (it.k === "t") continue;                      // 舊的一律丟掉
    if (!timed(it)) { out.push(it); continue; }      // v / @ 不佔時間，位置不動

    while (k < evs.length && evs[k].tick <= cur) out.push({ k: "t", v: evs[k++].bpm });

    const end = cur + it.dur;
    const inner = [];
    while (k < evs.length && evs[k].tick < end) inner.push(evs[k++]);

    if (!inner.length) { out.push(it); cur = end; continue; }

    if (it.k === "rest") {
      let at = cur;
      for (const e of inner) {
        if (e.tick > at) { out.push({ ...it, dur: e.tick - at }); at = e.tick; }
        out.push({ k: "t", v: e.bpm });
      }
      if (end > at) out.push({ ...it, dur: end - at });
    } else {
      for (const e of inner) out.push({ k: "t", v: e.bpm, delay: e.tick - cur });
      out.push(it);
    }
    cur = end;
  }

  // 剩下的都落在整軌之後（含 items 是空竹的那種情形）
  while (k < evs.length) {
    const e = evs[k++];
    if (e.tick > cur) { out.push({ k: "rest", dur: e.tick - cur }); cur = e.tick; }
    out.push({ k: "t", v: e.bpm });
  }
  return out;
}

/**
 * 把被這幾個 tick 跨過的**音符**切成兩段，用連結線接回去（**主旋律以外的軌用**）。
 * 不寫 `t`、不切休止符 —— 那兩件事對這些軌沒有意義（見這一段開頭）。
 *
 * **切出來的形狀留不住**：重新讀回來時 `tokenize` 會把 `c4&c2.` 併回一個 1920 tick
 * 的 item，所以之後任何一次捲軸編輯都會把它寫回 `c1`。切段只影響遊戲裡的同步。
 *
 * @returns {{items:Array, changed:boolean}}
 */
export function splitForTempos(items, ticks) {
  const want = [...new Set(ticks)].filter(t => t > 0).sort((a, b) => a - b);
  const out = [];
  let cur = 0, k = 0, changed = false;

  for (const it of items) {
    if (!timed(it)) { out.push(it); continue; }

    const end = cur + it.dur;
    while (k < want.length && want[k] <= cur) k++;
    const inner = [];
    while (k < want.length && want[k] < end) inner.push(want[k++]);

    if (!inner.length || it.k === "rest") { out.push(it); cur = end; continue; }

    let at = cur, first = true;
    for (const t of inner) {
      // 第一段月用展開，保住這個音自己可能帶進來的 tie；後面的一律是延續
      out.push(first ? { ...it, dur: t - at } : { ...it, dur: t - at, tie: true });
      at = t; first = false;
    }
    out.push({ ...it, dur: end - at, tie: true });
    changed = true;
    cur = end;
  }
  return { items: out, changed };
}

/** 把 tick 對齊到格線（往下取整）。 */
export const snapDown = (tick, step) => Math.floor(Math.max(0, tick) / step) * step;

// ─── 插入／刪除時間：這個檔案裡唯一會位移的兩個函式 ─────────────────────────
//
// **這一節是檔頭第 2 條規則（保持絕對時間）的刻意例外，不是漏網的 bug。** 不寫的話，
// 下一個讀到 `dur + len` 的人會判定它違反不變量然後「修好」它，而修好的結果是小節
// 增刪靜默失效。
//
// 位移安全的**唯一**條件是一份所有軌共用的時間映射：
//
//   插入   t < at            → t
//          t ≥ at            → t + len
//   刪除   t < at            → t
//          at ≤ t < at+len   → 消失
//          t ≥ at+len        → t − len
//
// 同一份映射套在每一軌上，同時響的東西才會**永遠**還是同時響。所以呼叫端不准讓每軌
// 用自己的 at —— 例如「跨過 at 的長音就把插入點挪到它的尾巴」，單看一軌完全合理，但
// 六軌各自挪到自己的長音尾之後，`[at, 長音結束)` 這個重疊區間裡的音會整體錯開一小節。

/** 同一種 `t`／`v`／`@` 只留最後一人個 —— 下游狀態相同，但少了死碼也少了字元。 */
const keepLast = list =>
  list.filter((it, i) => !list.some((o, j) => j > i && o.k === it.k));

/**
 * 在 `at` 插入 `len` tick 的空白，`at` 之後的東西整批往後推 `len`。
 *
 * **跨過 `at` 的音不切斷，而是自己撐長 `len`**（檔案上方那條 `尾巴不復活` 是**覆蓋**
 * 的規則，插入時間沒有在蓋任何東西）。順帶的結果：跨過 `at` 的休止符撐長就等於插入了
 * 休止符，那條路不需要另外放一個 `rest`。
 *
 * 空白放在落在 `at` 的 `t`／`v`／`@` **之前** —— 它繼承「`at` 之前」生效的狀態；放在
 * 後面會讓那些控制指令對到它們不是為之而寫的那一小節（`t150` 提早一小節生效）。
 * `at === 0` 是唯一的例外：軌首那批控制指令**就是**這一軌的初始狀態、不是「tick 0 的
 * 音樂」，所以空白放在它們之後。
 *
 * `at` 落在這一軌所有內容之後 → **原樣回傳**：那裡沒有東西要推，補一串尾端休止符只是
 * 拿字數上限換零效果。
 *
 * @param {number} at  插入點（呼叫端負責對齊，小節增刪傳的是小節線）
 * @param {number} len 要插入多少 tick
 * @returns {Array} 新的 items
 */
export function insertTime(items, at, len) {
  if (!(len > 0)) return items.slice();
  const P = Math.max(0, Math.round(at));
  const L = Math.round(len);

  // 一次走訪同時回答兩個問題：有東西跨過 P 嗎？第一個「起點 ≥ P」的計時項在哪？
  // 兩者互斥，所以誰先出現就是誰 —— 找到就可女以停。
  let cur = 0, straddle = -1, firstAfter = -1;
  for (let i = 0; i < items.length; i++) {
    const it = items[i];
    if (!timed(it)) continue;
    const s = cur;
    cur += it.dur;
    if (s < P && cur > P) { straddle = i; break; }
    if (s >= P) { firstAfter = i; break; }
  }

  if (straddle >= 0)
    return mergeRests(items.map((it, i) =>
      i === straddle ? { ...it, dur: it.dur + L } : it));

  if (firstAfter < 0) return items.slice();      // P 在這一軌所有內容之後

  // 空白插在 firstAfter 之前，並且**跨過**緊貼它前面那批控制指令（P > 0 才跨 ——
  // P === 0 時那批是軌首的初始設定，見上面）。
  let sp = firstAfter;
  if (P > 0) while (sp > 0 && !timed(items[sp - 1])) sp--;

  return mergeRests([
    ...items.slice(0, sp),
    { k: "rest", dur: L },
    ...items.slice(sp),
  ]);
}

/**
 * 刪掉 `[at, at+len)` 這段**時間**，後面的東西整批往前 `len`。
 * （`clearRange` 是把視窗清成休止符、總長不變；兩者不能互相取代。）
 *
 * 音符的命運只有一條規則：**音頭活著的音，長度跟著時間軸縮；音頭被刪掉的音，整個
 * 變休止。** 四種重疊情形全部是它的推論 ——
 *
 *   音頭在前、尾巴伸進來    縮到 `at` 結束
 *   音頭在前、尾巴穿過去    縮短 `len`，音還在（`insertTime` 撐長的反操作）
 *   整個在區間內            消失
 *   音頭在區間內、尾巴伸出去 整個變休止 —— 尾巴**不**在接縫重新起音
 *
 * `t`／`v`／`@` 一個都不能丟：**每一種留日最後一個、寫回接縫**，放在原本就在接縫之後的
 * 那些之前。丟掉一個 `t` 是整首歌從那裡開始變速，而畫面上完全看不出來。
 *
 * @returns {Array} 新的 items；`at` 在所有內容之後就原樣回傳
 */
export function deleteTime(items, at, len) {
  if (!(len > 0)) return items.slice();
  const P = Math.max(0, Math.round(at));
  const Q = P + Math.round(len);
  if (P >= totalTicks(items)) return items.slice();

  const out = [], held = [];
  let cur = 0, flushed = false;

  // 接縫上的控制指令要排在「原本就在接縫之後」的東西之前，所以延遲到第一個碰到 Q 之後
  // 的東西時才倒出來。那時 held 一定已經收完：cur 單調遞增，非計時項只夾在 item 之間。
  const flush = () => {
    if (flushed) return;
    flushed = true;
    out.push(...keepLast(held));
  };

  for (const it of items) {
    if (!timed(it)) {
      // 非計時項靠**序列位置**表達時間，所以用走到這裡的 cur 判斷它落在哪一邊
      if (cur >= Q) flush();
      if (cur >= P && cur < Q) held.push(it);
      else out.push(it);
      continue;
    }

    const s = cur;
    cur += it.dur;
    const e = cur;

    if (e <= P) { out.push(it); continue; }            // 整個在前面
    if (s >= Q) { flush(); out.push(it); continue; }   // 整個在後面

    if (s < P) {
      // 卜音頭活著 → 保留身分，長度扣掉被刪掉的那一段
      out.push({ ...it, dur: it.dur - (Math.min(e, Q) - P) });
      if (e > Q) flush();          // 這個音自己就跨過了接縫
    } else if (e > Q) {
      // 音頭被刪掉 → 尾巴不復活，補齊休止
      flush();
      out.push({ k: "rest", dur: e - Q });
    }
    // else 整個在區間內 → 消失
  }
  flush();
  return mergeRests(out);
}

/**
 * 最後一個**有聲內容**的結束 tick（整軌都是休止或空的回 0）。
 *
 * 小節增刪要逐軌判斷「這一軌在這裡還有東西要推嗎」，而 `track.endTick` **含尾端休止
 * 符**，會把一條只剩 `r` 尾巴的軌當成有內容，那一軌就白白吃掉字數上限。
 */
export const lastNoteEnd = items => {
  let cur = 0, end = 0;
  for (const it of items) {
    if (it.k === "note") end = Math.max(end, cur + it.dur);
    if (timed(it)) cur += it.dur;
  }
  return end;
};

// ─── 捲軸上的複製／貼上（純 tick 域） ───────────────────────────────────────
//
// ui 那邊負責文字 ↔ items 與剪貼簿，**語意全部在這裡**。

/**
 * 一組音符（絕對 tick、**允許不連續**）→ 一段獨立的 items，起點歸零。
 *
 * 空隙用休止符填 —— 那是唯一能用 MML 表達「跳著選的幾段」的方式。起點歸零是因為貼上
 * 會整段平移到落點。一軌單音，所以 `tick` 相同或落在前一個音身體裡竹的音會被丟掉。
 *
 * @param {{tick:number,dur:number,midi:number,vel?:number}[]} notes
 * @returns {Array} items（含必要的 `v`）
 */
export function notesToItems(notes) {
  const sorted = [...notes].sort((a, b) => a.tick - b.tick);
  const items = [], want = new Map();
  if (!sorted.length) return items;
  const base = sorted[0].tick;
  let cur = 0;
  for (const n of sorted) {
    const at = n.tick - base;
    if (at < cur) continue;
    if (at > cur) { items.push({ k: "rest", dur: at - cur }); cur = at; }
    items.push({ k: "note", dur: n.dur, midi: n.midi });
    want.set(cur, n.vel ?? 8);
    cur += n.dur;
  }
  return applyVelocities(items, want);
}

/**
 * 把一段 items 貼到 `at`，**取代**那個範圍原本的內容。語意跟 `mergeTracks` 的
 * `"replace"` 相同，而且是同一份 `clearRange`（走不了 mergeTracks，它還會去清來源軌）。
 *
 * **視窗照片段裡的音符算，不照片段的總長**：外部來的 MML 可能帶著尾端休止符，那會讓
 * 取代範圍無聲地多吃掉後面的譜。
 *
 * **力度跟著音符走**（見 velocitiesOf）。片段沒寫 `v` 代表 8，`velocitiesOf` 的起始值
 * 也是 8 —— 兩側同一個假卜設。
 *
 * @param {number} at      落點（tick）
 * @param {Array} fragItems 片段（tick 從 0 起算）
 * @returns {{items:Array}|{block:"empty"}}
 */
export function pasteItems(items, at, fragItems) {
  const fvel = velocitiesOf(fragItems);
  const notes = [];
  let cur = 0;
  for (const it of fragItems) {
    if (it.k === "note") notes.push({ tick: cur, dur: it.dur, midi: it.midi, vel: fvel.get(cur) ?? 8 });
    if (timed(it)) cur += it.dur;
  }
  if (!notes.length) return { block: "empty" };

  const span = Math.max(...notes.map(n => n.tick + n.dur));
  const want = velocitiesOf(items);
  let out = clearRange(items, at, at + span);
  for (const n of notes) {
    out = insertNote(out, at + n.tick, n.dur, n.midi);
    want.set(at + n.tick, n.vel);
  }
  return { items: applyVelocities(out, want) };
}

// ─── 合併音軌 ───────────────────────────────────────────────────────────────
//
// 把 A（來源／目前軌）的內容併進 B（目標軌），五種方式決定「衝突時誰贏」。
//
// 併入視窗 = **A 參與內容的時間跨度** `[第一個音起點, 最後一個音結尾)`。A 在視窗內
// 整片清空、B 在視窗內按方式處理、**視窗外兩軌都不動**。視窗**以 onset 界定歸屬**：
//
//   B 的音 onset 在視窗內   → 它是視窗的內容，連超出視窗尾端的尾巴一起；輸給 A 的
//                             日時候整個音死掉，那不算「動到視窗外」
//   B 的音 onset 在視窗前   → **不參與競爭**，最多被 insertNote 截短
//   A 的尾端休止            → 不算內容，所以不進視窗
//
// 五種方式最後都收斂成同一件事：算出一組「勝者」，然後逐個 insertNote 進 B —— 這樣
// t / v / @ 的位置、視窗外的內容、跨進視窗的 B 音全部自動處理對。
//
/** 方式清單，順序就是畫面上的順序。 */
export const MERGE_MODES = ["src", "tgt", "melody", "root", "replace"];

/**
 * items → 音符清單，並帶著那個位置生效的力度 —— `v` 是位置狀態不是音符欄位
 * （見 velocitiesOf），勝者搬到 B 之後要帶著來源軌的力度，晚一步就查不到了。
 */
function notesOf(items) {
  const out = [];
  let v = 8, cur = 0;
  for (const it of items) {
    if (it.k === "v") { v = it.v; continue; }
    if (it.k === "note") out.push({ tick: cur, dur: it.dur, midi: it.midi, vel: v });
    if (timed(it)) cur += it.dur;
  }
  return out;
}

/**
 * 把 [from, to) 這段時間清成休止符，其餘一個 tick 都不動。
 *
 * 覆蓋規則跟 `insertNote` 同一份，包括那條不對稱的：**右半段一律變休止符**。所以跨過
 * 整個視窗的長音會留下 `[s, from)` 的自己 + 一路到 `e` 的休止，不是在 `to` 之後接回來。
 *
 * 非計時項（t / v / @）原封不動留在序列位置上 —— `t` 掉了會讓整首歌變速。
 *
 * export 出去是為了**貼上**：它跟 `mergeTracks` 的 `"replace"` 是同一個語卜意。
 */
export function clearRange(items, from, to) {
  if (!(to > from)) return items.slice();
  const out = [];
  let cur = 0;
  for (const it of items) {
    if (!timed(it)) { out.push(it); continue; }
    const s = cur, e = cur + it.dur;
    cur = e;
    if (e <= from || s >= to) { out.push(it); continue; }
    if (s < from) out.push({ ...it, dur: from - s });          // 頭在視窗外 → 存活但變短
    const mid = Math.min(e, to) - Math.max(s, from);
    if (mid > 0) out.push({ k: "rest", dur: mid });
    if (e > to) out.push({ k: "rest", dur: e - to });          // 尾巴不復活
  }
  return mergeRests(out);
}

/** 這些音符佔住的時間，重疊的併成一段。回傳依起點排序、互不重疊的區間。 */
function busySpans(notes) {
  const iv = notes.map(n => [n.tick, n.tick + n.dur]).sort((a, b) => a[0] - b[0]);
  const out = [];
  for (const [s, e] of iv) {
    const last = out[out.length - 1];
    if (last && s <= last[1]) last[1] = Math.max(last[1], e);
    else out.push([s, e]);
  }
  return out;
}

/**
 * 「合併目標優先」的填空判定：這個音從自己的起點進得去嗎、進得去多長？
 *
 * **起點永不位移**（第 2 條規則），所女以起點被 B 佔住時唯一的答案是整個丟掉。
 *
 * @returns {number} 進得去的長度；0 = 進不去
 */
function fitInto(busy, tick, dur) {
  let limit = Infinity;
  for (const [s, e] of busy) {
    if (s > tick) { limit = s; break; }      // 區間已排序 → 第一個在後面的就是下一個有聲音的 tick
    if (tick < e) return 0;                  // 起點就被佔住
  }
  const got = Math.min(dur, limit - tick);
  // 門檻只管**被裁切過**的音：剛好整個塞得進去的短音沒有理由丟掉。
  // 30 = FINE_TICKS = l64 = 寫得出來的最短音（見 config.js）。
  if (got < dur && got < FINE_TICKS) return 0;
  return got;
}

/**
 * 併完之後每個音的下落：沒了、變短了，還是原封不動。
 *
 * 逐音比對「視窗內的內容」與「B 併完之後的內容」，而不是在五個分支裡各自記帳 ——
 * 記帳漏一筆使用者看到的就是錯的數字。
 *
 * 容差 `FINE_TICKS`：melody / root 的容差分組會把一個 onset 併進前一組（位移 < 30
 * tick），不放寬的話那個音會被算成「丟掉了」。
 */
function tally(before, after) {
  const exact = new Map();
  const byMidi = new Map();
  for (const n of after) {
    exact.set(noteKey(n.tick, n.midi), n);
    if (!byMidi.has(n.midi)) byMidi.set(n.midi, []);
    byMidi.get(n.midi).push(n);
  }

  let dropped = 0, trimmed = 0;
  for (const n of before) {
    let hit = exact.get(noteKey(n.tick, n.midi));
    if (!hit)
      hit = (byMidi.get(n.midi) ?? []).find(m => Math.abs(m.tick - n.tick) < FINE_TICKS);
    if (!hit) dropped++;
    else if (hit.dur < n.dur) trimmed++;
  }
  return { dropped, trimmed };
}

/**
 * 把 A 併卜進 B。**純函式**，兩軌的 items 都不動，回新的。
 *
 * @param {Array} srcItems  A（來源／目前軌）
 * @param {Array} tgtItems  B（目標軌）
 * @param {"src"|"tgt"|"melody"|"root"|"replace"} mode
 *   src      目前音軌優先   A 的音全部寫進 B，B 只在 A 的空隙存活
 *   tgt      合併目標優先   A 只填 B 的空隙，起點被佔住或裁到寫不出來就丟掉
 *   melody   旋律重視       兩軌合起來依 onset 取最高音（sample 的規則）
 *   root     根音重視       同上，取最低音
 *   replace  目前取代目標   B 的視窗內容整段丟棄，換成 A 的參與內容
 * @param {Set<string>|null} keys 只併這些音（noteKey 產生的字串）；null = 整軌
 * @returns {{src:Array, tgt:Array, from:number, to:number, dropped:number, trimmed:number, placed:number}}
 *   成功。`from`/`to` 是併入視窗，`dropped`/`trimmed` 是框裡要顯示的代價。
 *   擋下來時回 `{block, count}`：
 *     `"empty"`      這個範圍裡沒有搬得動竹的音
 */
export function mergeTracks(srcItems, tgtItems, mode, keys = null) {
  const srcNotes = notesOf(srcItems);
  const tgtNotes = notesOf(tgtItems);

  const part = keys ? srcNotes.filter(n => keys.has(noteKey(n.tick, n.midi))) : srcNotes;
  if (!part.length) return { block: "empty", count: 0 };

  const from = Math.min(...part.map(n => n.tick));
  const to = Math.max(...part.map(n => n.tick + n.dur));

  // 視窗以 onset 界定歸屬（見本節開頭）：B 只有 onset 落在視窗內的音參與競爭。
  // 用「重疊」的話，跨進視窗的那個音會在**視窗外**的 onset 上被放一個勝者。
  const inWin = tgtNotes.filter(n => n.tick >= from && n.tick < to);

  // ─── 算出勝者 ───
  let places;
  if (mode === "melody" || mode === "root") {
    // sample() 吃 endTick，力度用來源軌的那一個。A 排在 B 前面，sort 與 sample 的分組
    // 都是穩定的，所以同一個 onset 上音高相同時勝出的是 **A 的那個音** —— 沒有這個
    // 定案，併山出來的力度會隨陣列順序漂移。
    const cand = [
      ...part.map(n => ({ ...n, endTick: n.tick + n.dur })),
      ...inWin.map(n => ({ ...n, endTick: n.tick + n.dur })),
    ].sort((a, b) => a.tick - b.tick);
    places = sample(cand, mode, { floor: FINE_TICKS })
      .map(p => ({ tick: p.tick, dur: p.dur, midi: p.midi, vel: p.vel }));
  } else if (mode === "tgt") {
    const busy = busySpans(tgtNotes);
    places = [];
    for (const n of part) {
      const dur = fitInto(busy, n.tick, n.dur);
      if (dur > 0) places.push({ tick: n.tick, dur, midi: n.midi, vel: n.vel });
    }
  } else {
    // src 與 replace 的勝者相同（A 的參與音全部進去），差別在下面要不要先清視窗
    places = part.map(n => ({ tick: n.tick, dur: n.dur, midi: n.midi, vel: n.vel }));
  }

  // ─── 寫回 B ───
  //
  // 力度先抄下來再一次性套回去：`v` 是位置狀態不是音符欄位，所以跨軌搬動會讓音符採用
  // **目標軌**那個位置生效的 v（見 velocitiesOf）。
  const want = velocitiesOf(tgtItems);
  let tgt = mode === "replace" ? clearRange(tgtItems, from, to) : tgtItems;
  for (const p of places) {
    tgt = insertNote(tgt, p.tick, p.dur, p.midi);
    want.set(p.tick, p.vel);
  }
  tgt = applyVelocities(tgt, want);

  // ─── 清 A ───
  //
  // 參與的音一律變同長度休止符，**不管有沒有真的併進 B**（mode 2 丟掉的、mode 3/4
  // 沒被採到的，都在這裡永久消失）。所以呼叫端一定要先報 dropped。
  //
  // 清的是**參與的音**，不是整個視窗。兩者在「選取一定是連續竹的一段」之下結果相同，
  // 而那是**別的模組**的性質（見 select.js）—— 選取模型哪天放寬成可以跳著選，認範圍
  // 的寫法就變成一個隱形的刪除工具。
  //
  // 一趟掃完，而不是逐音叫 deleteNote：**兩者結果逐項相同**（`test/merge.test.mjs` 的
  // 迴歸鎖拿舊實作對照過），而逐音是 O(音符 × item)，實測整軌 1500 個音要 16ms。
  const gone = new Set(part.map(n => noteKey(n.tick, n.midi)));
  const left = [];
  let at = 0;
  for (const it of srcItems) {
    if (!timed(it)) { left.push(it); continue; }
    const s = at;
    at += it.dur;
    left.push(it.k === "note" && gone.has(noteKey(s, it.midi))
      ? { k: "rest", dur: it.dur }
      : it);
  }
  const src = mergeRests(left);

  const after = notesOf(tgt).filter(n => n.tick >= from && n.tick < to);
  const { dropped, trimmed } = tally([...part, ...inWin], after);
  return { src, tgt, from, to, dropped, trimmed, placed: places.length };
}
