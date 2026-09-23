// Studio Workshop — ported from the owner's earlier frontend (owner-authorized port).
// Constants: track limits, timing grid, pitch range, meters, marks, colours.
// Workshop edits sit outside the Canonical/verified pipeline and are never evidence.
// The SpessaSynth build Studio Web already vendors (scripts/build-studio-web.mjs);
// the Workshop never ships a second copy and never ships a sound bank.
export const VENDOR = new URL("../../../vendor/spessasynth/", import.meta.url);
export const WORKLET = new URL("processor.js", VENDOR).href;
export const ENGINE_LIB = new URL("lib.js", VENDOR).href;
export const ENGINE_CORE = new URL("core.js", VENDOR).href;
export const BOOT = new URL("../preview/worklet-console.mjs", import.meta.url).href;

export const MAX_TRACKS = 15;
export const GAME_TRACKS = 6;
export const MIN_TRACKS = 3;

export const chanOf = track => (track < 9 ? track : track + 1);

export const AUDITION_CH = 16;

export const MAX_TRACK_CHARS = 2400;

export const HARD_TRACK_CHARS = 40000;

export const ZIP_LOSSLESS = "lossless";

export const TRACK_COLORS = [
  "#e0ae5a", "#57b6a4", "#b487c9", "#7aa5e0", "#e0788f", "#a3c464",
  "#db7e66", "#64b9ce", "#74bc5c", "#c577be", "#cfcb59",
  "#8585d6", "#56b36d", "#d373a6", "#9f84cd",
];

export const NOTE_COLORS = [
  "#4FC3F7", "#FF9F45", "#4CD97B", "#FF6E9C",
  "#FFC93C", "#B06AF0", "#45E0C0", "#FF5C5C",
  "#5B8DEF", "#A8E05F", "#E06AD4", "#35C9DD",
  "#8B7BF7", "#F2E25C", "#FF8A65", "#E8ECF4",
  "#8A4B32", "#FF6A00", "#66712D", "#246B4A",
  "#126C78", "#00D9FF", "#1677FF", "#505C78",
  "#243B7A", "#43327A", "#7D35FF", "#FF2DAA",
  "#87354F", "#FF2442",
];

export const NOTE_COLOR_ORDER = [
  7, 14, 16, 17, 1, 4, 13, 18, 9, 2, 19, 6, 20, 11, 21,
  0, 22, 8, 23, 24, 12, 25, 26, 5, 10, 27, 28, 3, 29, 15,
];

export const NOTE_DEFAULTS = [4, 6, 5, 8, 3, 9];

export const OCT_BASE = 12;
export const N_BASE   = OCT_BASE;
export const PPQ      = 480;

export const OCT_MIN = 1;
export const OCT_MAX = 7;

export const PITCH_MIN = 1 * 12 + OCT_BASE;
export const PITCH_MAX = 7 * 12 + OCT_BASE + 11;

export const GAME_MIN = 1 * 12 + OCT_BASE + 4;
export const GAME_MAX = 7 * 12 + OCT_BASE + 4;

export const soundsAsWritten = midi => midi >= GAME_MIN && midi <= GAME_MAX;

export const ROLL_MIN = PITCH_MIN;
export const ROLL_MAX = PITCH_MAX;
export const PITCH_ROWS = ROLL_MAX - ROLL_MIN + 1;

export const playable = midi => midi >= PITCH_MIN && midi <= PITCH_MAX;

export const foldIntoRange = midi => {
  let m = midi;
  while (m < PITCH_MIN) m += 12;
  while (m > PITCH_MAX) m -= 12;
  return m;
};

const SEMI_NAMES = ["c", "c+", "d", "d+", "e", "f", "f+", "g", "g+", "a", "a+", "b"];
export const pitchName = midi =>
  `o${Math.floor((midi - OCT_BASE) / 12)}${SEMI_NAMES[((midi - OCT_BASE) % 12 + 12) % 12]}`;

export const BAR_TICKS = PPQ * 4;

export const CELL_TICKS = PPQ / 8;
export const CELLS_PER_BAR = BAR_TICKS / CELL_TICKS;

export const FINE_TICKS = 30;

export const CELL_W = 12;
export const ROW_H  = 12;

export const ZOOM_W = [2, 4, 6, 8, 12, 16, 24, 32];
export const ZOOM_H = [6, 8, 12, 16, 24, 32];

export const zoomStep = (steps, cur, dir) => {
  const i = steps.indexOf(cur);
  if (i < 0) return null;
  const n = i + dir;
  return n >= 0 && n < steps.length ? steps[n] : null;
};

export const zoomScroll = (scroll, anchor, oldSize, newSize) =>
  Math.max(0, ((scroll + anchor) / oldSize) * newSize - anchor);

export const gridStep = cellW => (cellW >= 12 ? 1 : cellW >= 8 ? 2 : cellW >= 6 ? 4 : 8);

export const rowLinesAt = rowH => rowH >= 8;

export const PINCH_SLOP = 12;
export const PINCH_SPAN = 40;
export const PINCH_STEP = 1.35;

export function pinchAxis(span, span0, dPan) {
  const dx = span0.x >= PINCH_SPAN ? Math.abs(span.x - span0.x) : 0;
  const dy = span0.y >= PINCH_SPAN ? Math.abs(span.y - span0.y) : 0;
  const dSpan = Math.max(dx, dy);
  if (dSpan < PINCH_SLOP || dSpan <= dPan) return null;
  return dx >= dy ? "w" : "h";
}

export const zoomTick = (cur, ref) =>
  (cur / ref >= PINCH_STEP ? 1 : cur / ref <= 1 / PINCH_STEP ? -1 : 0);

export const PAD_BARS = 4;
export const MIN_BARS = 16;

export const GUTTER_W = 46;
export const RULER_H  = 18;

export const MIN_ROLL_OCTAVES = 1;

export const midiToRow = midi => ROLL_MAX - midi;
export const rowToMidi = row => ROLL_MAX - row;
export const tickToPx = (tick, cellW = CELL_W) => (tick / CELL_TICKS) * cellW;
export const pxToTick = (px, cellW = CELL_W) => (px / cellW) * CELL_TICKS;

export const DEFAULT_METER = Object.freeze({ num: 4, den: 4 });

export const meterTicks = ({ num, den }) => num * (PPQ * 4 / den);

export const meterName = ({ num, den }) => `${num}/${den}`;

const DEN_OK = new Set([1, 2, 4, 8, 16, 32]);
const NUM_MAX = 99;

export function cleanMeters(raw) {
  const ok = [];
  if (Array.isArray(raw)) {
    for (const m of raw) {
      if (!m || typeof m !== "object") continue;
      const { tick, num, den } = m;
      if (!Number.isInteger(tick) || tick < 0) continue;
      if (!Number.isInteger(num) || num < 1 || num > NUM_MAX) continue;
      if (!Number.isInteger(den) || !DEN_OK.has(den)) continue;
      ok.push({ tick, num, den });
    }
  }
  ok.sort((a, b) => a.tick - b.tick);

  const out = [];
  for (const m of ok) {
    if (out.length && out[out.length - 1].tick === m.tick) out[out.length - 1] = m;
    else out.push(m);
  }
  if (!out.length || out[0].tick !== 0) out.unshift({ tick: 0, ...DEFAULT_METER });
  return out;
}

export function makeBarMap(rawMeters) {
  const meters = cleanMeters(rawMeters);

  const segs = meters.map((m, i) => {
    const start = m.tick;
    const end = meters[i + 1]?.tick ?? Infinity;
    const len = meterTicks(m);
    const bars = end === Infinity ? Infinity : Math.ceil((end - start) / len);
    return { start, end, len, bars, meter: m };
  });
  let acc = 0;
  for (const s of segs) { s.bar0 = acc; acc += s.bars; }

  const segAtTick = tick => {
    const t = Math.max(0, tick);
    for (let i = segs.length - 1; i >= 0; i--) if (t >= segs[i].start) return segs[i];
    return segs[0];
  };
  const segAtBar = n => {
    for (let i = segs.length - 1; i >= 0; i--) if (n >= segs[i].bar0) return segs[i];
    return segs[0];
  };

  const meterAt = tick => segAtTick(tick).meter;

  const barIndexOf = tick => {
    const s = segAtTick(tick);
    return s.bar0 + Math.floor((Math.max(0, tick) - s.start) / s.len);
  };

  const barStartTick = n => {
    const b = Math.max(0, Math.floor(n));
    const s = segAtBar(b);
    const t = s.start + (b - s.bar0) * s.len;
    return s.end === Infinity ? t : Math.min(t, s.end);
  };

  const barTicksAt = tick => {
    const s = segAtTick(tick);
    const start = barStartTick(barIndexOf(tick));
    return s.end === Infinity ? s.len : Math.min(s.len, s.end - start);
  };

  const barCountFor = endTick =>
    endTick <= 0 ? 0 : barIndexOf(endTick - 1) + 1;

  const barsFor = endTick =>
    Math.max(MIN_BARS, barCountFor(Math.max(0, endTick)) + PAD_BARS);

  const contentTicks = endTick => barStartTick(barsFor(endTick));

  return {
    meters, segs,
    meterAt, barIndexOf, barStartTick, barTicksAt, barCountFor, barsFor, contentTicks,
  };
}

let live = makeBarMap([]);

export function setMeters(list) { live = makeBarMap(list); return live.meters; }

export const meters       = () => live.meters;
export const meterAt      = tick => live.meterAt(tick);
export const barIndexOf   = tick => live.barIndexOf(tick);
export const barStartTick = n => live.barStartTick(n);
export const barTicksAt   = tick => live.barTicksAt(tick);
export const barCountFor  = endTick => live.barCountFor(endTick);
export const contentTicks = endTick => live.contentTicks(endTick);

export const barsFor = endTick => live.barsFor(endTick);

export const MARK_COLORS = [
  "#ef7d7d",
  "#4ec9b0",
  "#e08bd4",
  "#a8d05f",
  "#f2c744",
  "#a89bf0",
  "#f0995a",
  "#7ab8f5",
];

export const markColor = i => MARK_COLORS[((i % MARK_COLORS.length) + MARK_COLORS.length) % MARK_COLORS.length];

export const MAX_MARKS = 16;

export const MARK_WIDTH = 20;

export function textWidth(str) {
  let w = 0;
  for (const ch of String(str ?? "")) {
    const c = ch.codePointAt(0);
    w += (
      (c >= 0x1100 && c <= 0x115F) ||
      (c >= 0x2E80 && c <= 0x303E) ||
      (c >= 0x3041 && c <= 0x33FF) ||
      (c >= 0x3400 && c <= 0x4DBF) ||
      (c >= 0x4E00 && c <= 0x9FFF) ||
      (c >= 0xA000 && c <= 0xA4CF) ||
      (c >= 0xAC00 && c <= 0xD7A3) ||
      (c >= 0xF900 && c <= 0xFAFF) ||
      (c >= 0xFE30 && c <= 0xFE6F) ||
      (c >= 0xFF00 && c <= 0xFF60) ||
      (c >= 0xFFE0 && c <= 0xFFE6) ||
      (c >= 0x1F300 && c <= 0x1F64F) ||
      (c >= 0x1F900 && c <= 0x1F9FF) ||
      (c >= 0x20000 && c <= 0x3FFFD)
    ) ? 2 : 1;
  }
  return w;
}

export function clampMarkText(str) {
  const flat = String(str ?? "")
    .replace(/[ -]/g, " ")
    .trim();
  let out = "", w = 0;
  for (const ch of flat) {
    const cw = textWidth(ch);
    if (w + cw > MARK_WIDTH) break;
    out += ch; w += cw;
  }
  return out;
}

export function cleanMarks(raw) {
  const ok = [];
  if (Array.isArray(raw)) {
    for (const m of raw) {
      if (!m || typeof m !== "object") continue;
      if (!Number.isInteger(m.tick) || m.tick < 0) continue;
      const text = clampMarkText(m.text);
      if (!text) continue;
      ok.push({ tick: m.tick, text });
    }
  }
  ok.sort((a, b) => a.tick - b.tick);
  const out = [];
  for (const m of ok) {
    if (out.length && out[out.length - 1].tick === m.tick) out[out.length - 1] = m;
    else out.push(m);
  }
  return out.slice(0, MAX_MARKS);
}

export function cleanZip(raw) {
  const out = Array(MAX_TRACKS).fill(null);
  if (Array.isArray(raw))
    for (let i = 0; i < MAX_TRACKS; i++)
      if (raw[i] === ZIP_LOSSLESS) out[i] = ZIP_LOSSLESS;
  return out;
}

export const anyZip = list => Array.isArray(list) && list.some(z => z === ZIP_LOSSLESS);

export const PILL_MIN = 14;
export const PILL_MAX = 150;
const PILL_GAP = 2;

export function markPillWidths(xs) {
  return xs.map((x, i) => {
    const next = i + 1 < xs.length ? xs[i + 1] : Infinity;
    return Math.max(PILL_MIN, Math.min(PILL_MAX, next - x - PILL_GAP));
  });
}

export const isPillTab = w => w <= PILL_MIN;

const SCROLLBAR_CAP = 10;

export function markDotX(contentX, scrollW, track) {
  if (!(scrollW > 0) || !(track > 0)) return 0;
  const usable = Math.max(1, track - SCROLLBAR_CAP * 2 - DOT_W);
  const r = Math.min(1, Math.max(0, (GUTTER_W + contentX) / scrollW));
  const hi = Math.max(0, track - DOT_W);
  return Math.min(hi, Math.max(0, SCROLLBAR_CAP + r * usable));
}

export const DOT_W = 8;

const MAJOR_STEPS = [0, 2, 4, 5, 7, 9, 11];

export const KEY_SIGS = [
  { root: 0  },
  { root: 7  },
  { root: 2  },
  { root: 9  },
  { root: 4  },
  { root: 11 },
  { root: 6  },
  { root: 5  },
  { root: 10 },
  { root: 3  },
  { root: 8  },
  { root: 1  },
];

export const keyPitches = root =>
  new Set(MAJOR_STEPS.map(s => (root + s) % 12));

// A short original sample for an empty first visit (three tracks, four bars).
export const DEMO = [
  "t120v12l8o5ceg>c<gec4dfa>c<afd4<b>dgbgd<b>dc2r2",
  "t120v10l2o4egfadge1",
  "t120v10l1o3cfgc",
];
