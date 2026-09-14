// ────────────────────────────────────────────────────────────────────────────
//  聲部分離 —— Contig Mapping（Chew & Wu 2004）
//
//  一堆同時發聲的音符 → 最多 cap 條「單音的、在時間上不重疊的」旋律線。
//
//    ① contigs()        切段：每當「同時發聲的音數」改變 → 一個段落邊界
//    ② strandsOf()      段內：同時發聲數固定，按音高由高到低排成 strand
//    ③ reduceStrands()  降維：段內超過 cap 條就砍掉（論文沒有這一步）
//    ④ connect()        段間：最小音高距離的二分圖配對，把相鄰段的 strand 接起來
//
//  最後把接起來的「鏈」裝進固定數量的聲部槽（packing），輸出成 lane。
//
//  ③ 是加的：論文的輸出是「聲部數 = 全曲最多同時發聲數」，而這裡的輸出是**固定數量
//  的 MML 音十軌**。插在 ② 之後、④ 之前，④ 的配對規模才是固定的。
//
//  **處理邊界的順序不影響結果**：每個邊界的配對是各自獨立的最佳解（成本只看邊界兩側
//  的音高），而配對是單射的，所以鏈永遠是一條穿過連續段落的簡單路徑。論文的錨點在這
//  裡只剩兩個作用：決定聲部數 V（＝最多聲部段落的 strand 數），以及決定槽的初始音高。
// ────────────────────────────────────────────────────────────────────────────

import { CELL_TICKS, FINE_TICKS } from "./config.js";

/** 一格。量化後的音符最短就是這麼長，長度 0 的音（極短裝飾音）也給它一格。 */
const GRID = CELL_TICKS;

/** 音符真正的結束點。量化把長度壓成 0 的音會讓 ① 切出退化的空段落。 */
const endOf = n => Math.max(n.endTick, n.tick + GRID);

/** strand（fragment 陣列）的音高，用時值加權 —— 一個長音比一個裝飾音更能代表這條線。 */
function avgPitch(frags) {
  let sum = 0, len = 0;
  for (const f of frags) { const d = f.to - f.from; sum += f.midi * d; len += d; }
  return len ? sum / len : (frags[0]?.midi ?? 0);
}

// ─── 採樣：複音 → 一條單音線 ────────────────────────────────────────────────

/**
 * note-on 依 onset 分組。**跟本組起點差不到 `FINE_TICKS`（30 = 寫得出來的最短音）就算
 * 同一組** —— 合併音軌的輸入來自 MML，`l6`／`l12` 會產生非 30 倍數的 tick，沒有容差就
 * 會採出一個寫不出來的 10 tick 音。基準取本組起點，位移量因此有硬上界，不會沿著一串
 * 密集 onset 鏈式累積。對 MIDI 匯入日是 no-op（量化後兩個不同 onset 至少差 60）。
 *
 * 抽出來共用是因為「旋律 + 根音」的去重必須用**完全同一份**分組。
 */
export function onsetGroups(notes) {
  // 排序是穩定的，所以同一個 onset 內沿用輸入順序 —— 音高相同時結果才可預測。
  const sorted = [...notes].sort((a, b) => a.tick - b.tick);

  const groups = [];
  for (const n of sorted) {
    const g = groups[groups.length - 1];
    if (g && n.tick - g.tick < FINE_TICKS) g.notes.push(n);
    else groups.push({ tick: n.tick, notes: [n] });
  }
  return groups;
}

/**
 * 齊奏（同一個 tick 上同一個音高的好幾個 note-on）→ 只留一個。
 *
 * **一定要在分弦之前做**：`separateVoices` 認的是 note **物件**，齊奏是兩個不同的物
 * 件，兩條 lane 會各拿一個 —— 白白吃掉一個軌位而聽起來一模一樣。而且分弦照「同時有
 * 幾條線」決定，`[60, 60, 52, 45]` 是三個聲部不是四個。
 *
 * **留最長的那一個音符本體**。**只管同一個 tick**：同音高、重疊但 onset 不同（踏板上
 * 重複彈同一個音）不併。沒有齊奏時回傳**原陣列本身**，呼叫端可以用 === 判斷。
 */
export function mergeUnisons(notes) {
  const keep = new Map();
  for (const n of notes) {
    const k = `${n.tick}:${n.midi}`;
    const cur = keep.get(k);
    if (!cur || n.endTick - n.tick > cur.endTick - cur.tick) keep.set(k, n);
  }
  if (keep.size === notes.length) return notes;
  // Map.set 打在已存在竹的 key 上不會改變它的位置，所以輸入照 tick 排好、輸出就照樣有序。
  return [...keep.values()];
}

/**
 * 一堆同時發聲的音符 → 一條單音旋律線。MIDI 匯入與合併音軌的「旋律／根音重視」共用。
 * **onset 驅動**，只有一條規則：
 *
 *   1. note-on 依 onset 分組（見 `onsetGroups`）
 *   2. 每組挑一個：melody = 最高音，root = 最低音
 *   3. 音長 = min(下一組 onset − 本組 onset, max(floor, 自身音長))
 *   4. 沒填滿到下一組 onset 的部分 → 休止符（呼叫端補）
 *
 * **任何新的 onset 都切斷目前這個音**，不管新的音比較高還是比較低 —— 分解和弦就是靠
 * 這條採到的。**被挑中的音結束之後不會接回還在響的低音**，所以兩個模式是正交的。
 *
 * `floor` 是保險（量化後長度變 0 的裝飾音至少要給一格）。合併傳 `FINE_TICKS` 就好 ——
 * 給 60 會把一個合法的 `c64`（30 tick）拉長成 `c32`。
 *
 * @param {{tick:number, endTick:number, midi:number, vel:number}[]} notes 已排序
 * @param {"melody"|"root"} mode
 * @param {{floor?:number}} [opts] floor 預設一格（MIDI 匯入用），合併傳 FINE_TICKS
 * @returns {{tick:number, midi:number, vel:number, dur:number, src:object}[]}
 *   `src` 是被挑中的那個音符物件本身 —— 合併靠它認出「勝者是哪一軌的哪個卜音」。
 */
export function sample(notes, mode, { floor = GRID } = {}) {
  const groups = onsetGroups(notes);

  const picks = [];
  for (let i = 0; i < groups.length; i++) {
    const g = groups[i];
    let best = g.notes[0];
    for (const n of g.notes)
      if (mode === "root" ? n.midi < best.midi : n.midi > best.midi) best = n;

    // 不同組至少差 30，所以取 min 之後也不會低於「寫得出來的最短音」。
    const own = Math.max(floor, best.endTick - best.tick);
    const next = groups[i + 1]?.tick;
    const dur = next === undefined ? own : Math.min(next - g.tick, own);
    picks.push({ tick: g.tick, midi: best.midi, vel: best.vel, dur, src: best });
  }
  return picks;
}

// ─── 有沒有主旋律 ───────────────────────────────────────────────────────────

/**
 * `melodyRatio` 低於這個值 → 這一列**沒有主旋律，只有和弦伴奏**。拿真實檔案對出來的：
 * 純和弦伴奏 0～11%、旋律+和弦 48～66%、單音旋律 100%。中間那段很寬的空白正是這個門檻
 * 值得存在的理由。
 */
export const MELODY_MIN_RATIO = 0.25;

/**
 * onset 少於這麼多就不判定，一律當成「有主旋律」：比例在樣本小的時候極不穩定，而
 * **猜錯的代價是不對稱的**（把旋律當伴奏會讓主旋律整條被降級去跟別的線搶位子）。
 */
const MELODY_MIN_ONSETS = 20;

/**
 * 最高聲部有多少比例的 onset 是**它自己動、別人沒動**的 —— 「有沒有主旋律」唯一夠力的
 * 訊號：旋律會在和弦不動的時候自己走，純和弦伴奏竹的最高音永遠跟著整個和弦換。
 *
 * **不用「與次高的音程固定率」**（那個數字分得更開）：平行移動最常見的原因是旋律被八度
 * 或三度重疊，拿它去判「沒有旋律」會把重疊的主旋律整條降級。條件裡的「而且它是這一刻
 * 最高的音」不能省 —— 低音線在長和弦底下自己走也是單獨 onset。
 *
 * @returns {number} 0–1。沒有音符回 1（當成有旋律）
 */
export function melodyRatio(notes) {
  if (!notes?.length) return 1;

  const src = [...notes].sort((a, b) => a.tick - b.tick || b.midi - a.midi);
  const byTick = new Map();
  for (const n of src) {
    if (!byTick.has(n.tick)) byTick.set(n.tick, []);
    byTick.get(n.tick).push(n);
  }
  const ticks = [...byTick.keys()].sort((a, b) => a - b);

  let lone = 0, idx = 0, live = [];
  for (const t of ticks) {
    while (idx < src.length && src[idx].tick <= t) live.push(src[idx++]);
    live = live.filter(n => endOf(n) > t);
    const starting = byTick.get(t);
    if (starting.length !== 1) continue;
    let top = -Infinity;
    for (const n of live) if (n.midi > top) top = n.midi;
    if (starting[0].midi >= top) lone++;
  }
  return lone / ticks.length;
}

/**
 * 這一列是哪一種：`"melody"` / `"chords"` / `"unknown"`（木樣本太少）。**整列一次判定**
 * ——逐段判定會讓降維規則在段落之間跳來跳去。三態是因為清單上要標給使用者看。
 */
export function melodyKind(notes) {
  if (!notes?.length) return "unknown";
  const onsets = new Set(notes.map(n => n.tick)).size;
  if (onsets < MELODY_MIN_ONSETS) return "unknown";
  return melodyRatio(notes) >= MELODY_MIN_RATIO ? "melody" : "chords";
}

/** 這一列有沒有獨立的主旋律。`false` = 純和弦伴奏。**不確定時回 true**（代價不對稱）。 */
export const hasMelody = notes => melodyKind(notes) !== "chords";

// ─── ① 切段 ─────────────────────────────────────────────────────────────────

/**
 * 音符 → 段落。**每當同時發聲的音數改變就是一個邊界。**
 *
 * 條件是「數量」改變不是「集合」改變：三個音同時放開、三個新音同時按下時**不切**。
 * 切太細會讓段落數暴增，④ 的配對次數跟著暴增。靜音不屬於任何段落，而且會切斷段落的
 * 相鄰性 —— 中間隔著靜音的兩段不做接合。
 *
 * @param {{tick:number, endTick:number, midi:number, vel:number}[]} notes
 * @returns {{from:number, to:number, count:number, slices:object[]}[]}
 */
export function contigs(notes) {
  if (!notes?.length) return [];

  // 自己排一次：leftover 那條路徑餵進來的音符是重新組出來的，順序沒有人保證。
  const src = [...notes].sort((a, b) => a.tick - b.tick || b.midi - a.midi);

  const times = new Set();
  for (const n of src) { times.add(n.tick); times.add(endOf(n)); }
  const ts = [...times].sort((a, b) => a - b);

  // 相鄰兩個事件點之間，響著的那組音是固定的 —— 這是最小的觀察單位（slice）。
  const slices = [];
  let idx = 0;
  let live = [];
  for (let i = 0; i + 1 < ts.length; i++) {
    const t0 = ts[i], t1 = ts[i + 1];
    while (idx < src.length && src[idx].tick <= t0) live.push(src[idx++]);
    live = live.filter(n => endOf(n) > t0);
    if (!live.length) continue;
    slices.push({ from: t0, to: t1, notes: [...live].sort((a, b) => b.midi - a.midi) });
  }

  // 數量相同、時間相接的 slice 併成一個段落
  const out = [];
  for (const s of slices) {
    const last = out[out.length - 1];
    if (last && last.to === s.from && last.count === s.notes.length) {
      last.slices.push(s);
      last.to = s.to;
    } else {
      out.push({ from: s.from, to: s.to, count: s.notes.length, slices: [s] });
    }
  }
  return out;
}

// ─── ② 段內排序 ─────────────────────────────────────────────────────────────

/**
 * 一個段落 → count 條 strand，第 0 條日是最高的。每個 slice 裡的音已經按音高排好，所以
 * 第 r 條 strand 就是「每個 slice 的第 r 高」—— 論文對段內的假設是「聲部不交叉」。
 *
 * 同一個音連續佔住好幾個 slice 時併成一個 fragment，不然一個全音符會變成十幾段。
 */
export function strandsOf(contig) {
  const strands = Array.from({ length: contig.count }, () => []);
  for (const s of contig.slices) {
    for (let r = 0; r < contig.count; r++) {
      const n = s.notes[r];
      const st = strands[r];
      const last = st[st.length - 1];
      if (last && last.note === n && last.to === s.from) last.to = s.to;
      else st.push({ note: n, midi: n.midi, vel: n.vel, from: s.from, to: s.to });
    }
  }
  return strands;
}

// ─── ③ 降維 ─────────────────────────────────────────────────────────────────

/**
 * 段內超過 cap 條 strand 時砍到剩 cap 條。回傳的仍然是**音高由高到低**的順序。
 *
 *   保留 = [0（旋律）, 1（最高的和弦音）, k−1（最低＝根音）] + 中間補到 cap 條
 *
 * 「相對中間」= 音高最接近「和弦部份最高與最低的中點」的那幾條。**平手時丟掉 index
 * 比較小的那條**（優先犧牲靠近旋律的內聲部，把根音留到最後）。被砍掉的 strand 會變成
 * leftover，和弦全採竹的第二輪再分一次。
 */
export function reduceStrands(strands, cap, melody = true) {
  const k = strands.length;
  if (cap >= k) return strands;
  if (cap <= 0) return [];

  // 錨：有旋律時是「旋律 + 最高的和弦音 + 最低音」，沒有旋律時只有「最高 + 最低」。
  // **`melody = false` 時不能再優待 index 1** —— 全部都是和弦時再留兩條最高的會讓中
  // 音域變薄，而純伴奏的中音域正是和聲的厚度所在。
  const anchors = [];
  for (const i of (melody ? [0, 1, k - 1] : [0, k - 1]))
    if (i >= 0 && i < k && !anchors.includes(i)) anchors.push(i);
  const keep = new Set(anchors.slice(0, cap));

  // 中點取自「和弦部份」的最高與最低：把旋律算進來會讓中點被一個常常特別高的聲部拉歪。
  const lo = avgPitch(strands[k - 1]);
  const hi = avgPitch(strands[melody ? Math.min(1, k - 1) : 0]);
  const mid = (hi + lo) / 2;

  const rest = [];
  for (let i = 0; i < k; i++) if (!keep.has(i)) rest.push(i);
  rest.sort((a, b) => {
    const da = Math.abs(avgPitch(strands[a]) - mid);
    const db = Math.abs(avgPitch(strands[b]) - mid);
    // 距離相同 → index 大的（比較低的）優先留下，等於優先犧牲靠近第 2 十軌的那條
    return da - db || b - a;
  });
  for (const i of rest) {
    if (keep.size >= cap) break;
    keep.add(i);
  }

  return [...keep].sort((a, b) => a - b).map(i => strands[i]);
}

// ─── ④ 段間接合 ─────────────────────────────────────────────────────────────

/**
 * 最小成本二分圖配對（Hungarian，e-maxx 的 O(n³) 版本）。n 最大是 15，所以微不足道。
 * 自己寫是因為這個專案不裝任何相依套件。演算法本體要求列數 ≤ 行數，不成立就轉置。
 *
 * @returns {number[]} colOf[i] = 配到第 i 列的行號，沒配到是 −1
 */
function hungarian(cost, nR, nC) {
  if (nR > nC) {
    const t = Array.from({ length: nC }, (_, j) =>
      Array.from({ length: nR }, (_, i) => cost[i][j]));
    const back = hungarian(t, nC, nR);
    const out = new Array(nR).fill(-1);
    for (let j = 0; j < nC; j++) if (back[j] >= 0) out[back[j]] = j;
    return out;
  }

  const n = nR, m = nC, INF = Infinity;
  const u = new Array(n + 1).fill(0), v = new Array(m + 1).fill(0);
  const p = new Array(m + 1).fill(0), way = new Array(m + 1).fill(0);

  for (let i = 1; i <= n; i++) {
    p[0] = i;
    let j0 = 0;
    const minv = new Array(m + 1).fill(INF);
    const used = new Array(m + 1).fill(false);
    do {
      used[j0] = true;
      const i0 = p[j0];
      let delta = INF, j1 = 0;
      for (let j = 1; j <= m; j++) {
        if (used[j]) continue;
        const cur = cost[i0 - 1][j - 1] - u[i0] - v[j];
        if (cur < minv[j]) { minv[j] = cur; way[j] = j0; }
        if (minv[j] < delta) { delta = minv[j]; j1 = j; }
      }
      for (let j = 0; j <= m; j++) {
        if (used[j]) { u[p[j]] += delta; v[j] -= delta; }
        else minv[j] -= delta;
      }
      j0 = j1;
    } while (p[j0] !== 0);
    do { const j1 = way[j0]; p[j0] = p[j1]; j0 = j1; } while (j0);
  }

  const out = new Array(n).fill(-1);
  for (let j = 1; j <= m; j++) if (p[j] > 0) out[p[j] - 1] = j - 1;
  return out;
}

/**
 * 相鄰兩段竹的 strand 怎麼接。成本 = |前一段結尾的音高 − 後一段開頭的音高|。
 *
 * **跨邊界的同一個音必須接回自己**，這是硬約束不是成本 —— 距離 0 的配對「通常」會做
 * 對，但只要旁邊有另一個同音高的音就可能被搶走，那個延音就會在軌之間跳。所以先把
 * 這種對子配掉，剩下的才進 Hungarian。
 *
 * @returns {number[]} out[i] = prev 第 i 條接到 next 的第幾條，沒接上是 −1
 */
export function connect(prev, next) {
  const n = prev.length, m = next.length;
  const out = new Array(n).fill(-1);
  if (!n || !m) return out;

  const tail = st => st[st.length - 1];
  const head = st => st[0];

  const rows = [], taken = new Set();
  for (let i = 0; i < n; i++) {
    let hit = -1;
    for (let j = 0; j < m; j++) {
      if (taken.has(j)) continue;
      if (head(next[j]).note === tail(prev[i]).note) { hit = j; break; }
    }
    if (hit >= 0) { out[i] = hit; taken.add(hit); }
    else rows.push(i);
  }

  const cols = [];
  for (let j = 0; j < m; j++) if (!taken.has(j)) cols.push(j);
  if (!rows.length || !cols.length) return out;

  const cost = rows.map(i => cols.map(j =>
    Math.abs(tail(prev[i]).midi - head(next[j]).midi)));
  const match = hungarian(cost, rows.length, cols.length);
  for (let r = 0; r < rows.length; r++)
    if (match[r] >= 0) out[rows[r]] = cols[match[r]];
  return out;
}

// ─── 組合 ───────────────────────────────────────────────────────────────────

/**
 * 一堆卜音符 → 最多 cap 條單音線。**這是這個檔案唯一對外的入口**，其餘 export 是為了讓
 * 每一條規則能被單獨釘死（見 test/voices.test.mjs）。
 *
 * `melody = false`（呼叫端用 `hasMelody()` 判定）代表純和弦伴奏：降維時不再優待第 1 條。
 *
 *   lanes    picks 陣列的陣列，照**平均音高由高到低**排。空的聲部不產出，所以
 *            lanes.length 可能小於 cap。
 *   leftover 沒被採進 lanes 的音（或音的一部分），形狀跟輸入一樣，可以直接再餵一次。
 *   dropped  完全沒有任何一段被採到的**來源音符數**。
 *
 * 每個 pick 帶 `src`：指回最原始的那個音符，多輪之後仍然指得回去。
 */
export function separateVoices(notes, { cap = 4, melody = true } = {}) {
  const all = notes ?? [];
  if (!all.length || cap < 1)
    return { lanes: [], leftover: all.map(n => ({ ...n, src: n.src ?? n })), dropped: all.length };

  const segs = contigs(all);
  if (!segs.length)
    return { lanes: [], leftover: all.map(n => ({ ...n, src: n.src ?? n })), dropped: all.length };

  const reduced = segs.map(c => reduceStrands(strandsOf(c), cap, melody));
  const V = Math.max(...reduced.map(r => r.length));

  // ── 接合 ──
  // 順序不影響結果（見木檔頭），所以直接照時間順序跑。中間隔著靜音的不接。
  const width = Math.max(1, cap);
  const par = new Int32Array(segs.length * width);
  for (let i = 0; i < par.length; i++) par[i] = i;
  const find = x => { while (par[x] !== x) { par[x] = par[par[x]]; x = par[x]; } return x; };
  const union = (a, b) => { a = find(a); b = find(b); if (a !== b) par[a] = b; };

  for (let i = 0; i + 1 < segs.length; i++) {
    if (segs[i].to !== segs[i + 1].from) continue;
    const m = connect(reduced[i], reduced[i + 1]);
    for (let s = 0; s < m.length; s++)
      if (m[s] >= 0) union(i * width + s, (i + 1) * width + m[s]);
  }

  // ── 鏈 ──
  const chains = new Map();
  for (let i = 0; i < segs.length; i++) {
    for (let s = 0; s < reduced[i].length; s++) {
      const root = find(i * width + s);
      let c = chains.get(root);
      if (!c) chains.set(root, c = { frags: [], from: Infinity, to: -Infinity });
      for (const f of reduced[i][s]) {
        c.frags.push(f);
        if (f.from < c.from) c.from = f.from;
        if (f.to > c.to) c.to = f.to;
      }
    }
  }

  // ── packing：鏈 → V 人個聲部槽 ──
  //
  // 照開始時間排序後貪心找槽（區間圖著色的標準做法），而且**保證找得到**：任一時刻
  // 同時活著的鏈數 ≤ V。找不到槽只可能是 bug，那時退回 leftover 而不是丟例外。
  //
  // 槽的初始音高取自第一個「最多聲部」的段落：那是全曲最可靠的一張快照。
  const anchor = reduced.find(r => r.length === V) ?? [];
  const slots = Array.from({ length: V }, (_, k) => ({
    end: -Infinity,
    pitch: anchor[k] ? avgPitch(anchor[k]) : 0,
    frags: [],
  }));

  const list = [...chains.values()].sort((a, b) => a.from - b.from);
  const orphans = [];
  for (const c of list) {
    const p = avgPitch(c.frags);
    let best = -1, bestD = Infinity;
    for (let k = 0; k < slots.length; k++) {
      if (slots[k].end > c.from) continue;
      const d = Math.abs(slots[k].pitch - p);
      if (d < bestD) { bestD = d; best = k; }
    }
    if (best < 0) { orphans.push(c); continue; }
    slots[best].frags.push(...c.frags);
    slots[best].end = c.to;
    slots[best].pitch = p;
  }

  // ── 卜音符歸屬：一個音只採一次，而且只採連續的那一段 ──
  //
  // **取它最早出現的那個槽，並且只延續在時間上真正接得起來的片段**。中斷之後不再接
  // 回去 —— 接回去會變成「同一個音重新起奏一次」，那是原曲裡不存在的重擊。
  const byNote = new Map();
  slots.forEach((s, k) => {
    for (const f of s.frags) {
      if (!byNote.has(f.note)) byNote.set(f.note, []);
      byNote.get(f.note).push({ k, from: f.from, to: f.to });
    }
  });

  const laneNotes = slots.map(() => []);
  const leftover = [];
  const piece = (n, from, to) => ({ tick: from, endTick: to, midi: n.midi, vel: n.vel, src: n.src ?? n });

  for (const [note, fs] of byNote) {
    fs.sort((a, b) => a.from - b.from || a.k - b.k);
    const k = fs[0].k;
    let from = fs[0].from, to = fs[0].to;
    for (let x = 1; x < fs.length; x++)
      if (fs[x].k === k && fs[x].from === to) to = fs[x].to;

    laneNotes[k].push({ tick: from, midi: note.midi, vel: note.vel, dur: to - from, src: note.src ?? note });
    if (from > note.tick) leftover.push(piece(note, note.tick, from));
    if (to < endOf(note)) leftover.push(piece(note, to, endOf(note)));
  }

  for (const c of orphans)
    for (const f of c.frags)
      if (!byNote.has(f.note)) leftover.push(piece(f.note, f.from, f.to));

  let dropped = 0;
  for (const n of all) {
    if (byNote.has(n)) continue;
    dropped++;
    leftover.push(piece(n, n.tick, endOf(n)));
  }

  // 空竹的槽不產出（沒用到的軌不佔位），其餘照平均音高由高到低 —— 這就是軌序。
  const lanes = laneNotes
    .filter(l => l.length)
    .map(l => l.sort((a, b) => a.tick - b.tick))
    .sort((a, b) => avg(b) - avg(a));

  leftover.sort((a, b) => a.tick - b.tick || b.midi - a.midi);
  return { lanes, leftover, dropped };
}

/** picks 的時值加權平均音高。lane 的排序用它。 */
function avg(picks) {
  let sum = 0, len = 0;
  for (const p of picks) { sum += p.midi * p.dur; len += p.dur; }
  return len ? sum / len : 0;
}
