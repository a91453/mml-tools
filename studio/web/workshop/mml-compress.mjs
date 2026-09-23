// Studio Workshop — ported from the owner's earlier frontend (owner-authorized port).
// MML encoder/optimizer (lossless re-spelling and opt-in duration rules).
// Workshop edits sit outside the Canonical/verified pipeline and are never evidence.
import { lenTicks, compact, scanTokens, parseAll, bareTrack } from "./mml.mjs";
import * as i18n from "./i18n.mjs";
import {
  OCT_BASE, N_BASE, OCT_MIN, OCT_MAX, PITCH_MIN, PITCH_MAX, foldIntoRange,
  BAR_TICKS, CELL_TICKS, barIndexOf, barStartTick,
} from "./config.mjs";

const MAX_TIE_SEGS = 3;
const WRITE_TIE_SEGS = 8;
const WRITE_TIE_SEGS_CAP = 24;

const MAX_L_CANDIDATES = 12;

export const budgetFor = chars => chars > 4000 ? 400000 : 200000;

const STD_NUMS = [1, 2, 3, 4, 6, 8, 12, 16, 24, 32, 48, 64];
const STD_SET = new Set(STD_NUMS);

const DEFAULT_MAX_DOTS = 1;

const STEP = { c: 0, d: 2, e: 4, f: 5, g: 7, a: 9, b: 11, h: 11 };

const DEFAULTS = { octave: 4, lenNum: 4, lenDots: 0, vol: 8, bpm: 120 };

const digits = n => String(n).length;

const hasDur = it => it.k === "note" || it.k === "rest";

function tokenize(raw, opts = {}) {
  const ticksOf = opts.ticksOf ?? lenTicks;
  const { t } = compact(raw);
  const items = [];
  const seenNums = new Set();
  let dropped = 0;
  let i = 0;
  let octave = DEFAULTS.octave;
  let lenNum = DEFAULTS.lenNum, lenDots = DEFAULTS.lenDots;

  let tick = 0, tieNext = false;
  let lastNote = null, lastNoteEnd = -1;
  let lastNoteIdx = -1, lastNoteStart = 0;

  const readInt = () => {
    let s = "";
    while (i < t.length && t[i] >= "0" && t[i] <= "9") s += t[i++];
    return s === "" ? null : parseInt(s, 10);
  };
  const readDots = () => {
    let d = 0;
    while (t[i] === ".") { d++; i++; }
    return d;
  };

  const readDur = () => {
    const num = readInt();
    if (num !== null) { seenNums.add(Math.max(1, num)); return ticksOf(num, readDots()); }
    if (t[i] === ".") return ticksOf(lenNum, readDots());
    return ticksOf(lenNum, lenDots);
  };

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
      if (n === null) { dropped++; continue; }
      pushNote(N_BASE + n);
    }
    else if (c === "o") { const n = readInt(); if (n !== null) octave = n; }
    else if (c === ">") octave += 1;
    else if (c === "<") octave -= 1;
    else if (c === "l") { const n = readInt(); if (n !== null) { lenNum = Math.max(1, n); seenNums.add(lenNum); lenDots = readDots(); } }
    else if (c === "t") { const n = readInt(); if (n !== null) items.push({ k: "t", v: n }); }
    else if (c === "v") { const n = readInt(); if (n !== null) items.push({ k: "v", v: n }); }
    else if (c === "@") { const n = readInt(); if (n !== null) items.push({ k: "@", v: n }); }
    else if (c === "&") tieNext = true;
    else dropped++;
  }
  return { items, seenNums, dropped };
}

function buildTokens(nums, maxDots, alignTo = 1) {
  const byTicks = new Map();
  const allByTicks = new Map();
  for (const num of nums) {
    for (let dots = 0; dots <= maxDots; dots++) {
      const ticks = lenTicks(num, dots);
      if (ticks <= 0) continue;
      if (alignTo > 1 && ticks % alignTo !== 0) continue;
      const str = String(num) + ".".repeat(dots);
      const cur = byTicks.get(ticks);
      if (cur === undefined || str.length < cur.length) byTicks.set(ticks, str);
      if (!allByTicks.has(ticks)) allByTicks.set(ticks, []);
      allByTicks.get(ticks).push({ num, dots });
    }
  }
  const heads = [...byTicks.keys()].sort((a, b) => b - a);
  return { byTicks, allByTicks, heads };
}

const spellings = (ticks, cfg) => cfg.tokens.allByTicks.get(ticks) ?? [];

function spellOne(ticks, lnum, ldots, cfg) {
  const key = `${ticks}|${lnum}.${ldots}`;
  const hit = cfg.spellMemo.get(key);
  if (hit !== undefined) return hit;

  let best;
  if (ticks === lenTicks(lnum, ldots)) best = "";
  else {
    best = null;
    for (let d = 1; d <= cfg.maxDots; d++)
      if (ticks === lenTicks(lnum, d)) { best = ".".repeat(d); break; }
    const w = cfg.tokens.byTicks.get(ticks);
    if (w !== undefined && (best === null || w.length < best.length)) best = w;
  }
  cfg.spellMemo.set(key, best);
  return best;
}

function encodeDur(ticks, lnum, ldots, cfg, segsLeft = cfg.maxTieSegs) {
  const mk = `${ticks}|${lnum}.${ldots}|${segsLeft}`;
  if (cfg.memo.has(mk)) return cfg.memo.get(mk);
  if (cfg.budget-- <= 0) { cfg.exhausted = true; return null; }
  cfg.memo.set(mk, null);

  if (ticks === 0) { const r = { segs: [], cost: 0, head: 0 }; cfg.memo.set(mk, r); return r; }

  const one = spellOne(ticks, lnum, ldots, cfg);
  let best = one === null ? null : { segs: [one], cost: one.length, head: ticks };

  if (best && best.cost <= 3) { cfg.memo.set(mk, best); return best; }
  if (segsLeft <= 1) { cfg.memo.set(mk, best); return best; }

  for (const head of cfg.tokens.heads) {
    if (head >= ticks) continue;
    const hs = spellOne(head, lnum, ldots, cfg);
    if (hs === null) continue;
    if (best && hs.length + 2 >= best.cost) continue;
    const tail = encodeDur(ticks - head, lnum, ldots, cfg, segsLeft - 1);
    if (!tail) continue;
    const cost = hs.length + 2 + tail.cost;
    if (!best || cost < best.cost) best = { segs: [hs, ...tail.segs], cost, head };
  }

  cfg.memo.set(mk, best);
  return best;
}

function encodeDurUp(ticks, lnum, ldots, cfg) {
  const cheap = encodeDur(ticks, lnum, ldots, cfg, cfg.maxTieSegs);
  if (cheap || cfg.maxTieSegsMax <= cfg.maxTieSegs) return cheap;

  const aligned = encodeDurAligned(ticks, lnum, ldots, cfg);
  if (aligned) return aligned;
  return encodeDur(ticks, lnum, ldots, cfg, cfg.maxTieSegsMax);
}

const durCost = enc => (enc ? enc.cost : Infinity);

const switchCostOf = c => 1 + digits(c.num) + c.dots;

const SPLIT_JOIN = 2;

function planDefaultLength(items, cfg) {
  const durs = items.filter(x => x.k === "note" || x.k === "rest");
  if (!durs.length) return { cands: [{ num: DEFAULTS.lenNum, dots: DEFAULTS.lenDots }], pick: [], startK: 0 };

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
  const tails = new Map();

  for (const it of durs) {
    const enc = cands.map(c => encodeDurUp(it.dur, c.num, c.dots, cfg));
    const ndp = new Array(K).fill(Infinity);
    const from = new Array(K).fill(null);

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

    tails.clear();
    for (let s = 0; s < K; s++) {
      if (dp[s] === Infinity) continue;
      const e = enc[s];
      if (!e || e.segs.length < 2) continue;
      const head = e.head, hsLen = e.segs[0].length;
      let byL = tails.get(head);
      if (!byL) {
        const rest = it.dur - head;
        byL = cands.map(c => encodeDurUp(rest, c.num, c.dots, cfg));
        tails.set(head, byL);
      }
      for (let k = 0; k < K; k++) {
        if (k === s || !byL[k]) continue;
        const c = dp[s] + hsLen + SPLIT_JOIN + switchCostOf(cands[k]) + byL[k].cost;
        if (c < ndp[k]) { ndp[k] = c; from[k] = { prev: s, head }; }
      }
    }

    back.push(from);
    dp = ndp;
  }

  let k = 0;
  for (let j = 1; j < K; j++) if (dp[j] < dp[k]) k = j;
  if (dp[k] === Infinity) return null;

  const pick = new Array(durs.length);
  for (let i = durs.length - 1; i >= 0; i--) {
    const b = back[i][k];
    pick[i] = { kIn: b.prev, kOut: k, head: b.head };
    k = b.prev;
  }
  return { cands, pick, startK };
}

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
    .sort((a, b) => b.n - a.n || a.dots - b.dots
      || Math.abs(a.num - dflt.num) - Math.abs(b.num - dflt.num) || a.num - b.num);

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

function segTicks(str, c) {
  const m = /^(\d*)(\.*)$/.exec(str);
  if (!m) return 0;
  if (m[1]) return lenTicks(+m[1], m[2].length);
  return m[2] ? lenTicks(c.num, m[2].length) : lenTicks(c.num, c.dots);
}

const SPELL = ["c", "c+", "d", "d+", "e", "f", "f+", "g", "g+", "a", "a+", "b"];

function pitchSpellings(midi) {
  const oct = Math.floor((midi - OCT_BASE) / 12);
  const semi = ((midi - OCT_BASE) % 12 + 12) % 12;
  if (oct < OCT_MIN || oct > OCT_MAX) return [];
  const out = [{ oct, text: SPELL[semi] }];
  if (semi === 0  && oct - 1 >= OCT_MIN) out.push({ oct: oct - 1, text: "b+" });
  if (semi === 11 && oct + 1 <= OCT_MAX) out.push({ oct: oct + 1, text: "c-" });
  return out;
}

const shiftTo = (a, b) => a === b ? "" : Math.abs(a - b) === 1 ? (b > a ? ">" : "<") : "o" + b;

const nSpelling = nt =>
  nt.bare && nt.midi >= PITCH_MIN && nt.midi <= PITCH_MAX
    ? "n" + (nt.midi - N_BASE) : null;

function planSpelling(items, plan, cfg, end) {
  const { cands, pick } = plan;

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

    if (!opts.length && nText === null) return null;

    for (let s = 0; s < N; s++) {
      if (dp[s] === Infinity) continue;
      for (const o of opts) {
        const t = at(o.oct);
        const shift = shiftTo(s + OCT_MIN, o.oct);
        const c = dp[s] + shift.length + nt.segs * o.text.length;
        if (c < ndp[t]) { ndp[t] = c; from[t] = { prev: s, text: o.text }; }
      }
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
    out[i] = { shift: shiftTo(b.prev + OCT_MIN, s + OCT_MIN), text: b.text };
    s = b.prev;
  }
  return out;
}

function emitTrack(items, plan, cfg, opts, isFirstTrack) {
  const { cands, pick, startK } = plan;
  let out = "";
  let curL = startK;
  let vol = null, prog = null;
  let di = 0;
  let atTick = 0;
  const barsPerLine = Number.isFinite(opts.barsPerLine) && opts.barsPerLine > 0
    ? Math.floor(opts.barsPerLine) : 0;
  const nextBreakAfter = t =>
    barStartTick((Math.floor(barIndexOf(t) / barsPerLine) + 1) * barsPerLine);
  let nextBreak = barsPerLine ? barStartTick(barsPerLine) : 0;
  const maybeBreak = () => {
    if (barsPerLine && atTick > 0 && atTick >= nextBreak) {
      out += "\n";
      nextBreak = nextBreakAfter(atTick);
    }
  };

  let end = items.length;
  if (opts.dropTrailingRests) while (end > 0 && items[end - 1].k === "rest") end--;

  const spell = planSpelling(items, plan, cfg, end);
  if (spell === null) return null;
  let ni = 0;

  for (let idx = 0; idx < end; idx++) {
    const it = items[idx];

    if (it.k === "t") {
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

    if (!(it.k === "note" && it.tie)) maybeBreak();

    const p = pick[di++];
    const seg = planSegs(it, p, cands, cfg);
    if (!seg) return null;
    const segs = seg.segs;
    const lText = "l" + cands[p.kOut].num + ".".repeat(cands[p.kOut].dots);

    if (it.tie) out += "&";

    if (seg.lAt === 0 && p.kOut !== curL) out += lText;
    curL = p.kOut;

    if (it.k === "rest") {
      for (let si = 0; si < segs.length; si++) {
        if (si > 0) maybeBreak();
        if (si > 0 && si === seg.lAt) out += lText;
        out += "r" + segs[si];
        atTick += segTicks(segs[si], cands[si === 0 && seg.lAt === 1 ? p.kIn : p.kOut]);
      }
    } else {
      atTick += it.dur;
      const sp = spell[ni++];
      const pieces = segs.map(s => sp.text + s);
      if (seg.lAt > 0) pieces[seg.lAt - 1] += lText;
      out += sp.shift + pieces.join("&");
    }
  }
  return out;
}

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
    maxTieSegsMax: Math.max(maxTieSegs, o.maxTieSegsMax ?? 0),
    maxDots,
    alignTo: o.alignTo ?? 1,
    nums,
  };
}

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

function durGcd(items) {
  let g = 0;
  for (const x of items) if (hasDur(x) && x.dur > 0) g = gcd2(g, x.dur);
  return g || 1;
}

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

function writeTieSegs(items) {
  const longest = items.reduce((m, x) => (hasDur(x) && x.dur > m ? x.dur : m), 0);
  const need = 3 + Math.ceil(longest / lenTicks(1, DEFAULT_MAX_DOTS));
  return Math.min(WRITE_TIE_SEGS_CAP, Math.max(WRITE_TIE_SEGS, need));
}

function mergeRests(items) {
  const out = [];
  for (const it of items) {
    const prev = out[out.length - 1];
    if (it.k === "rest" && prev && prev.k === "rest") out[out.length - 1] = { k: "rest", dur: prev.dur + it.dur };
    else out.push(it);
  }
  return out.length === items.length ? items : out;
}

const REST_CHUNK = lenTicks(1, DEFAULT_MAX_DOTS);

export const MAX_NOTE_TICKS = WRITE_TIE_SEGS_CAP * REST_CHUNK;

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

function splitRestsAtBars(items, cfg) {
  const barAt = t => barStartTick(barIndexOf(t) + 1) - barStartTick(barIndexOf(t));
  const writable = d => d > 0 && encodeDurUp(d, DEFAULTS.lenNum, DEFAULTS.lenDots, cfg) !== null;

  const chop = (dur, at) => {
    const parts = [];
    let left = dur, tick = at;
    while (left > 0) {
      const take = Math.min(left, barStartTick(barIndexOf(tick) + 1) - tick);
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
  if (!need) return items;

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

function expandTempoDelays(items) {
  if (!items.some(it => it.k === "t" && it.delay > 0)) return items;

  const out = [];
  let i = 0;
  while (i < items.length) {
    if (items[i].k !== "t") { out.push(items[i++]); continue; }

    let j = i;
    while (j < items.length && items[j].k === "t") j++;
    const run = items.slice(i, j);
    const note = items[j];

    const inside = note && note.k === "note"
      ? run.filter(t => t.delay > 0 && t.delay < note.dur)
      : [];
    if (!inside.length) { out.push(...run); i = j; continue; }

    out.push(...run.filter(t => !inside.includes(t)));

    const cuts = [...new Set(inside.map(t => t.delay))].sort((a, b) => a - b);
    let at = 0;
    for (const c of cuts) {
      out.push(at === 0 ? { ...note, dur: c } : { ...note, dur: c - at, tie: true });
      for (const t of inside) if (t.delay === c) out.push(t);
      at = c;
    }
    out.push({ ...note, dur: note.dur - at, tie: true });
    i = j + 1;
  }
  return out;
}

export function itemsToMML(rawItems, opts = {}) {
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

  if (opts.plain) {
    const base = mergeRests(items);
    const cfg = opts.cfg ?? makeEncoderCfg({ maxTieSegsMax: writeTieSegs(base), ...opts, alignTo: 1 });
    const its = splitLongRests(splitRestsAtBars(base, cfg));
    const plan = plainPlan(its, cfg);
    const out = plan ? emitTrack(its, plan, cfg, emitOpts, opts.isFirstTrack ?? true) : null;
    if (out !== null) return out;
    if (opts.stats) opts.stats.plainFallback = true;
  }

  const runVariant = raw => {
    const its = splitLongRests(raw);
    if (opts.cfg) return emit(its, opts.cfg);
    const base = { maxTieSegsMax: writeTieSegs(its), ...opts };
    const nums = [...new Set(base.allowedNums ?? STD_NUMS)];
    const g = opts.alignTo ?? pickAlign(its, nums, base.maxDots ?? DEFAULT_MAX_DOTS);
    const out = emit(its, makeEncoderCfg({ ...base, alignTo: g }));
    if (out !== null || g === 1) return out;
    return emit(its, makeEncoderCfg({ ...base, alignTo: 1 }));
  };

  const merged = mergeRests(items);
  const unmerged = runVariant(items);
  if (merged === items) return unmerged;
  const packed = runVariant(merged);
  if (unmerged === null) return packed;
  return packed !== null && packed.length < unmerged.length ? packed : unmerged;
}

export function trackToItems(raw, opts = {}) {
  const r = tokenize(raw, opts);
  return r.error
    ? { error: r.error }
    : { items: r.items, seenNums: r.seenNums, dropped: r.dropped };
}

export const encoderNums = seenNums => [...new Set([...STD_NUMS, ...(seenNums ?? [])])];

export function repairItems(raw, opts = {}) {
  const items = splitLongRests(raw);
  const cfg = makeEncoderCfg({
    allowedNums: opts.allowedNums,
    maxDots: opts.maxDots,
    maxTieSegsMax: writeTieSegs(items),
    budget: opts.budget,
  });
  const okDur = d => d > 0 && encodeDurUp(d, DEFAULTS.lenNum, DEFAULTS.lenDots, cfg) !== null;
  const stdCfg = makeEncoderCfg({
    maxDots: opts.maxDots, maxTieSegsMax: writeTieSegs(items), budget: opts.budget,
  });
  const isStd = d => encodeDurUp(d, DEFAULTS.lenNum, DEFAULTS.lenDots, stdCfg) !== null;

  const out = [];
  const issues = [];
  let tick = 0, drift = 0, changed = false;

  const snap = (d, ok) => {
    let best = null;
    for (let k = 1; k <= CELL_TICKS; k++)
      for (const v of [d - k, d + k]) {
        if (!ok(v)) continue;
        const err = Math.abs(drift + v - d);
        if (!best || err < best.err || (err === best.err && k < best.k)) best = { v, err, k };
      }
    if (best) return best.v;
    for (let k = CELL_TICKS + 1; k <= 4 * BAR_TICKS; k++)
      for (const v of [d - k, d + k]) if (ok(v)) return v;
    return null;
  };

  for (const it of items) {
    if (!hasDur(it)) { out.push(it); continue; }

    const keys = it.k === "note" ? [`${tick}:${it.midi}`] : [];

    if (okDur(it.dur)) {
      if (!isStd(it.dur)) issues.push({ kind: "nonstd", tick, keys, from: it.dur, to: it.dur });
      out.push(it);
      tick += it.dur;
      continue;
    }

    const to = snap(it.dur, okDur);
    if (to === null) {
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

  return { items: changed ? out : items, issues, drift };
}

const DOUBLE_DOT = /\.\./;

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

const hasNonStdDenom = bare => {
  const t = trackToItems(bare);
  return !t.error && [...t.seenNums].some(n => !STD_SET.has(n));
};

export const gameLegal = bare =>
  !DOUBLE_DOT.test(bare) && !hasNonStdDenom(bare) && stripUnreadable(bare) === bare;

export function gameSafeTrack(bare, opts = {}) {
  bare = stripUnreadable(bare);

  const t = trackToItems(bare);
  const nonStd = !t.error && [...t.seenNums].some(n => !STD_SET.has(n));
  if (!DOUBLE_DOT.test(bare) && !nonStd) return { text: bare, fixed: false, snapped: 0, drift: 0 };
  if (t.error) return { error: i18n.t("compress.err.doubleDotFailed", { reason: t.error }) };
  if (nonStd) return { text: bare, fixed: false, snapped: 0, drift: 0, warning: i18n.t("compat.preserved") };

  const zero = itemsToMML(t.items, { budget: budgetFor(bareTrack(bare).length), ...opts, maxDots: 1 });
  if (zero !== null) return { text: zero, fixed: true, snapped: 0, drift: 0 };

  return { text: bare, fixed: false, snapped: 0, drift: 0,
    warning: i18n.t("compat.preserved") };
}

export function reflow(src, barsPerLine) {
  const flat = String(src ?? "")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/\/\/[^\n]*/g, "")
    .replace(/\s+/g, "");

  const n = Number.isFinite(barsPerLine) && barsPerLine > 0 ? Math.floor(barsPerLine) : 0;
  if (!n || !flat) return flat;

  const track = parseAll([flat]).tracks[0];
  if (!track) return flat;

  const nextBreakAfter = t => barStartTick((Math.floor(barIndexOf(t) / n) + 1) * n);
  const byTick = new Map();
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

function backOverState(s, at) {
  for (;;) {
    if (at > 0 && (s[at - 1] === "<" || s[at - 1] === ">")) { at--; continue; }
    const m = /[ol]\d+\.*$/.exec(s.slice(0, at));
    if (m) { at = m.index; continue; }
    return at;
  }
}

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

  const scans = parts.map(p => tokenize(p));
  const nums = new Set(STD_NUMS);
  for (const sc of scans) {
    if (sc.error) continue;
    sc.seenNums.forEach(n => nums.add(n));
  }
  const outParts = [], perTrack = [];

  for (let i = 0; i < parts.length; i++) {
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

const TOKEN_START = /[a-hnoltvrp@[]/i;
const TOKEN_TAIL = /[0-9.+\-#]/;

export function trimToToken(s, max) {
  if (s.length <= max) return s;
  let end = max;

  if (TOKEN_TAIL.test(s[end])) {
    while (end > 0 && !TOKEN_START.test(s[end - 1])) end--;
    if (end > 0) end--;
  }
  const out = s.slice(0, end);

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

export const OPT_RULES = ["fill", "partial", "release"];

const OPT_EXT_RATIO = 3;
const OPT_CUT_CAP = 240;

const OPT_MAX_NOTE = 3 * BAR_TICKS;

const OPT_MIN_GAIN = 1;

function pitchChars(midi) {
  return SPELL[((midi - OCT_BASE) % 12 + 12) % 12].length;
}

function noteChars(midi, dur, L, cfg) {
  const en = encodeDurUp(dur, L.num, L.dots, cfg);
  if (!en) return Infinity;
  const n = en.segs.length;
  return n * pitchChars(midi) + en.segs.reduce((a, s) => a + s.length, 0) + (n - 1);
}

function restChars(dur, L, cfg) {
  const en = encodeDurUp(dur, L.num, L.dots, cfg);
  if (!en) return Infinity;
  return en.segs.length + en.segs.reduce((a, s) => a + s.length, 0);
}

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

function groupChars(midi, noteDur, restDurs, Ls, cfg) {
  let best = Infinity;
  for (const L of Ls) {
    let c = noteChars(midi, noteDur, L, cfg);
    for (const d of restDurs) c += restChars(d, L, cfg);
    if (c < best) best = c;
  }
  return best;
}

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
      if (x.k === "t") { blocked = true; break; }
      extras.push(x);
    }
    if (!blocked && j < items.length) {
      out.push({ from: i, to: j, tick: noteTick, midi: it.midi, noteDur: it.dur, restDurs, extras });
    }
    i = j - 1;
  }
  return out;
}

function restOptions(cfg, grid) {
  return cfg.tokens.heads.filter(t => t % grid === 0).sort((a, b) => a - b);
}

function optCandidates(g, rule, cfg, grid) {
  const N = g.noteDur;
  const R = g.restDurs.reduce((a, b) => a + b, 0), T = N + R;

  const raw = [];
  if (rule === "fill") { if (R > 0) raw.push([T, 0]); }
  else if (rule === "partial") { for (const rp of restOptions(cfg, grid)) if (rp < R) raw.push([T - rp, rp]); }
  else for (const rp of restOptions(cfg, grid)) if (rp > R) raw.push([T - rp, rp]);

  return raw.filter(([np, rp]) => {
    if (np <= 0) return false;
    if (rp % grid !== 0) return false;
    if (np > N) return np - N <= N * OPT_EXT_RATIO && np <= OPT_MAX_NOTE;
    if (np < N) return N - np <= OPT_CUT_CAP;
    return true;
  });
}

function optBest(g, rule, cfg, Ls, grid) {
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

  const want = [];
  for (const g of groups) {
    if (keys && !keys.has(`${g.tick}:${g.midi}`)) continue;
    for (const [np, rp] of optCandidates(g, opts.rule, cfg, grid)) {
      want.push(np);
      if (rp > 0) want.push(rp);
    }
  }
  const Ls = lengthCandidates(items, cfg, want);
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

export function optimizeTrack(raw, opts = {}) {
  const t = tokenize(raw);
  if (t.error) return { error: t.error };

  const items = t.items;
  opts = { allowedNums: encoderNums(t.seenNums), budget: budgetFor(bareTrack(raw).length), ...opts };
  const stats = {};
  const base = itemsToMML(items, { ...opts, stats });
  if (base === null) return {
    error: i18n.t(stats.budgetExhausted ? "compress.err.budgetExhausted" : "compress.err.uncodable"),
    reason: stats.budgetExhausted ? "budgetExhausted" : "uncodable",
  };

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
    rules[rule] = chars(out) >= before ? none : { out, after: chars(out), changed: r.changed };
  }
  return { before, base, rules, budgetExhausted: !!stats.budgetExhausted };
}

const dpHazard = items =>
  durGcd(items) < 30 || items.some(x => hasDur(x) && x.dur % 5 !== 0);

export function zipOnce(raw, opts = {}) {
  const t = tokenize(raw);
  if (t.error) return { skip: "uncodable" };
  if ([...t.seenNums].some(n => !STD_SET.has(n))) return { skip: "nonstd" };
  if (dpHazard(t.items)) return { skip: "hazard" };

  const r = optimizeTrack(raw, { ...opts, rules: [] });
  if (r.error) return { skip: "uncodable" };
  const out = r.base;
  if (out === null || bareTrack(out).length >= bareTrack(raw).length) return { skip: "nogain" };
  if (!sameEvents(parseAll([raw]), parseAll([out]))) return { bug: true };
  return { out };
}

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
