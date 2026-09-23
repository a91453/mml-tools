// Studio Workshop — ported from the owner's earlier frontend (owner-authorized port).
// Deterministic waterfall renderer.
// Workshop edits sit outside the Canonical/verified pipeline and are never evidence.
import { NOTE_COLORS, NOTE_DEFAULTS, GAME_TRACKS } from "./config.mjs";
import { MIN_DUR } from "./mixnotes.mjs";
import { rng, rgba, mixWhite, mixBlack, NOTE_STYLES, HIT_FX } from "./wfstyles.mjs";

export { rng };

export const KEY_LOW = 21;
export const KEY_HIGH = 108;

export const WHITE_KEYS = 52;

const KB_FRAC = 0.17;

export const BLACK_FRAC = 0.62;

const BLACK_W = 0.62;

const NOTE_W_WHITE = 0.8125;
const NOTE_W_BLACK = 0.65;

const WHITE_CUT = 0.13;

const BLACK_FACE = 0.18;

export const LOOK_AHEAD_SEC = 2.5;

export const LEAD_IN_SEC = 0;

export const OUTRO_SEC = 1.5;

const DUST_N = 130;

const MIDI_VEL_MAX = 127;

export function hexRgb(hex) {
  const n = parseInt(hex.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

export const trackColors = () => NOTE_DEFAULTS.map(k => hexRgb(NOTE_COLORS[k]));

export const colorsOf = ids => Array.from({ length: GAME_TRACKS }, (_, i) =>
  hexRgb(NOTE_COLORS[ids?.[i]] ?? NOTE_COLORS[NOTE_DEFAULTS[i]]));

export const colorIds = spec => {
  const want = String(spec ?? "").split(",");
  return Array.from({ length: GAME_TRACKS }, (_, i) => {
    const raw = (want[i] ?? "").trim();
    const k = /^\d+$/.test(raw) ? +raw : -1;
    return k >= 0 && k < NOTE_COLORS.length ? k : NOTE_DEFAULTS[i];
  });
};

export const isBlack = m => [1, 3, 6, 8, 10].includes(((m % 12) + 12) % 12);

export function layout(W, H, lookAhead = LOOK_AHEAD_SEC) {
  const portrait = H > W;
  const sw = portrait ? H : W;
  const sh = portrait ? W : H;

  const u = Math.min(sw, sh) / 1080;
  const kbH = sh * KB_FRAC;
  const kbTop = sh - kbH;
  const whiteW = sw / WHITE_KEYS;

  const keys = [];
  const whiteX = new Map();
  let wx = 0;
  for (let m = KEY_LOW; m <= KEY_HIGH; m++) {
    if (isBlack(m)) continue;
    whiteX.set(m, wx);
    keys.push({ midi: m, x: wx, w: whiteW, black: false });
    wx += whiteW;
  }
  const bw = whiteW * BLACK_W;
  for (let m = KEY_LOW; m <= KEY_HIGH; m++) {
    if (!isBlack(m)) continue;
    keys.push({ midi: m, x: whiteX.get(m - 1) + whiteW - bw / 2, w: bw, black: true });
  }

  return {
    W: sw, H: sh, u, kbTop, kbH, whiteW, keys,
    outW: W, outH: H, portrait,
    keyOf: new Map(keys.map(k => [k.midi, k])),
    pps: kbTop / (lookAhead > 0 ? lookAhead : LOOK_AHEAD_SEC),
    dust: makeDust(),
  };
}

export function makeDust(n = DUST_N, seed = 20260829) {
  const r = rng(seed);
  return Array.from({ length: n }, () => ({
    x: r(),
    y0: r(),
    rad: r() * 1.5 + 0.75,
    vy: (r() * 6 + 2) / 1000,
    a: r() * 0.35 + 0.08,
    ph: r() * Math.PI * 2,
  }));
}

const dustY = (p, t) => {
  const y = (p.y0 - p.vy * t) % 1;
  return y < 0 ? y + 1 : y;
};

export function prepare(song) {
  const out = [];
  song.tracks.slice(0, GAME_TRACKS).forEach((tr, track) => {
    for (const n of tr.notes) {
      if (n.dur < MIN_DUR) continue;
      out.push({ track, midi: n.midi, start: n.start, dur: n.dur, vel: n.vel / MIDI_VEL_MAX });
    }
  });
  out.sort((a, b) => a.start - b.start || a.midi - b.midi || a.track - b.track);
  out.forEach((n, i) => { n.seed = i; });
  return out;
}

export const timeline = musicEnd => ({
  start: -LEAD_IN_SEC,
  end: musicEnd + OUTRO_SEC,
  duration: LEAD_IN_SEC + musicEnd + OUTRO_SEC,
});

function drawBackground(ctx, t, v) {
  const { W, H, kbTop, u } = v;

  const g = ctx.createLinearGradient(0, 0, 0, H);
  g.addColorStop(0, "#04060f");
  g.addColorStop(0.65, "#081020");
  g.addColorStop(1, "#0c1630");
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, W, H);

  const glow = ctx.createRadialGradient(W / 2, kbTop, 10 * u, W / 2, kbTop, H * 0.55);
  glow.addColorStop(0, "rgba(70,110,220,0.10)");
  glow.addColorStop(1, "rgba(70,110,220,0)");
  ctx.fillStyle = glow;
  ctx.fillRect(0, 0, W, H);

  ctx.strokeStyle = "rgba(130,160,230,0.06)";
  ctx.lineWidth = u;
  for (const k of v.keys) {
    if (k.black || k.midi % 12 !== 0) continue;
    ctx.beginPath();
    ctx.moveTo(k.x, 0);
    ctx.lineTo(k.x, kbTop);
    ctx.stroke();
  }

  for (const p of v.dust) {
    const tw = 0.625 + 0.375 * Math.sin(t * 1.3 + p.ph);
    ctx.fillStyle = `rgba(160,190,255,${p.a * tw})`;
    ctx.beginPath();
    ctx.arc(p.x * W, dustY(p, t) * kbTop, Math.max(0.6, p.rad * u), 0, Math.PI * 2);
    ctx.fill();
  }
}

function drawNotes(ctx, t, v, notes, colors, style) {
  const { kbTop, pps, u, whiteW } = v;
  ctx.save();
  ctx.globalCompositeOperation = style.composite;

  for (const n of notes) {
    const bottom = kbTop - (n.start - t) * pps;
    const fullH = Math.max(10 * u, n.dur * pps - 4 * u);
    const top = bottom - fullH;
    if (bottom < -10 * u || top > kbTop) continue;

    const k = v.keyOf.get(n.midi);
    if (!k) continue;

    const w = whiteW * (k.black ? NOTE_W_BLACK : NOTE_W_WHITE);
    const x = k.x + k.w / 2 - w / 2;

    const clipBottom = Math.min(bottom, kbTop);
    const clipTop = Math.max(top, -20 * u);
    const h = clipBottom - clipTop;
    if (h <= 0) continue;

    style.draw(ctx, {
      x, w, top, bottom, fullH,
      y: clipTop, h, r: w / 2,
      color: colors[n.track % colors.length],
      active: t >= n.start && t < n.start + n.dur,
      vel: n.vel, u, kbTop, t, seed: n.seed, age: t - n.start,
      cx: k.x + k.w / 2, kw: k.w,
    });
  }
  ctx.restore();
}

function drawHits(ctx, t, v, notes, colors, fx) {
  if (!fx.span) return;
  const { kbTop, u } = v;
  ctx.save();
  ctx.globalCompositeOperation = fx.composite;
  for (const n of notes) {
    const age = t - n.start;
    if (age < 0 || age >= fx.span) continue;
    const k = v.keyOf.get(n.midi);
    if (!k) continue;
    fx.draw(ctx, {
      x: k.x + k.w / 2, y: kbTop, w: k.w,
      age, vel: n.vel,
      color: colors[n.track % colors.length],
      u, seed: n.seed,
    });
  }
  ctx.restore();
}

function activeKeys(t, notes, colors) {
  const m = new Map();
  for (const n of notes) {
    if (t >= n.start && t < n.start + n.dur) m.set(n.midi, colors[n.track % colors.length]);
  }
  return m;
}

function whiteKeyPath(ctx, x, y, w, h, cut) {
  ctx.beginPath();
  ctx.moveTo(x, y);
  ctx.lineTo(x + w, y);
  ctx.lineTo(x + w, y + h - cut);
  ctx.lineTo(x + w - cut, y + h);
  ctx.lineTo(x + cut, y + h);
  ctx.lineTo(x, y + h - cut);
  ctx.closePath();
}

function drawKeyboard(ctx, t, v, notes, colors, style) {
  const kb = {
    keys: v.keys, act: activeKeys(t, notes, colors),
    kbTop: v.kbTop, kbH: v.kbH, blackH: v.kbH * BLACK_FRAC, W: v.W, H: v.H, u: v.u,
  };
  (style.keyboard ?? defaultKeyboard)(ctx, kb);
}

function defaultKeyboard(ctx, kb) {
  const { W, H, kbTop, kbH, u, act } = kb;

  ctx.fillStyle = "rgba(140,170,255,0.35)";
  ctx.fillRect(0, kbTop - 1.5 * u, W, 1.5 * u);
  ctx.save();
  ctx.shadowColor = "rgba(120,160,255,0.6)";
  ctx.shadowBlur = 10 * u;
  ctx.fillRect(0, kbTop - 1.5 * u, W, 1.5 * u);
  ctx.restore();

  for (const k of kb.keys) {
    if (k.black) continue;
    const c = act.get(k.midi);
    const x = k.x + u / 2;
    const w = k.w - u;
    const cut = k.w * WHITE_CUT;

    const g = ctx.createLinearGradient(0, kbTop, 0, H);
    if (c) {
      g.addColorStop(0, rgba(c, 0.95));
      g.addColorStop(1, "rgba(235,240,255,0.92)");
    } else {
      g.addColorStop(0, "#d7dcea");
      g.addColorStop(1, "#f4f6fc");
    }

    ctx.save();
    if (c) {
      ctx.shadowColor = rgba(c, 0.9);
      ctx.shadowBlur = 18 * u;
    }
    ctx.fillStyle = g;
    whiteKeyPath(ctx, x, kbTop, w, kbH, cut);
    ctx.fill();
    ctx.restore();

    ctx.fillStyle = "rgba(20,30,60,0.14)";
    ctx.fillRect(x + cut, kbTop + kbH - u * 1.5, w - cut * 2, u * 1.5);

    ctx.fillStyle = "rgba(20,30,60,0.25)";
    ctx.fillRect(k.x, kbTop, u, kbH - cut);
  }

  const bh = kbH * BLACK_FRAC;
  const face = bh * BLACK_FACE;

  for (const k of kb.keys) {
    if (!k.black) continue;
    const c = act.get(k.midi);
    const { x, w } = k;
    const faceTop = kbTop + bh - face;

    if (c) {
      ctx.save();
      ctx.shadowColor = rgba(c, 0.95);
      ctx.shadowBlur = 16 * u;
      ctx.fillStyle = rgba(c, 1);
      ctx.fillRect(x, kbTop, w, bh);
      ctx.restore();
    }

    const top = ctx.createLinearGradient(0, kbTop, 0, faceTop);
    top.addColorStop(0, c ? rgba(mixWhite(c, 0.28), 1) : "#252d44");
    top.addColorStop(1, c ? rgba(mixBlack(c, 0.34), 1) : "#0a0e1a");
    ctx.fillStyle = top;
    ctx.fillRect(x, kbTop, w, bh - face);

    const front = ctx.createLinearGradient(0, faceTop, 0, kbTop + bh);
    front.addColorStop(0, c ? rgba(mixWhite(c, 0.40), 1) : "#4b5672");
    front.addColorStop(0.5, c ? rgba(c, 1) : "#2c344a");
    front.addColorStop(1, c ? rgba(mixBlack(c, 0.5), 1) : "#10151f");
    ctx.fillStyle = front;
    ctx.fillRect(x, faceTop, w, face);

    ctx.fillStyle = c ? rgba(mixWhite(c, 0.7), 0.6) : "rgba(160,175,210,0.45)";
    ctx.fillRect(x, faceTop, w, u);

    ctx.fillStyle = "rgba(255,255,255,0.09)";
    ctx.fillRect(x, kbTop, u, bh);
    ctx.fillStyle = "rgba(0,0,0,0.32)";
    ctx.fillRect(x + w - u, kbTop, u, bh);

    ctx.fillStyle = "rgba(0,0,0,0.55)";
    ctx.fillRect(x, kbTop + bh - u, w, u);
  }
}

function drawMark(ctx, v, mark) {
  const { u } = v;
  const font = mark.font ?? "system-ui, sans-serif";

  const x = v.outW - 28 * u;
  const base = v.portrait ? v.outH - 30 * u : v.outH - v.kbH - 46 * u;

  ctx.save();
  ctx.globalCompositeOperation = "source-over";
  ctx.textAlign = "right";
  ctx.textBaseline = "alphabetic";
  ctx.fillStyle = "rgba(200,215,255,0.34)";
  ctx.font = `${20 * u}px ${font}`;
  ctx.fillText(mark.text, x, base);
  if (mark.sub) {
    ctx.fillStyle = "rgba(200,215,255,0.22)";
    ctx.font = `${14 * u}px ${font}`;
    ctx.fillText(mark.sub, x, base + 22 * u);
  }
  ctx.restore();
}

export function draw(ctx, t, view, notes, opts = {}) {
  const colors = opts.colors ?? trackColors();
  const style = opts.style ?? NOTE_STYLES[0];
  const fx = opts.fx ?? HIT_FX[0];

  ctx.save();
  if (view.portrait) orient(ctx, view);
  drawBackground(ctx, t, view);
  drawNotes(ctx, t, view, notes, colors, style);
  drawHits(ctx, t, view, notes, colors, fx);
  drawKeyboard(ctx, t, view, notes, colors, style);
  ctx.restore();

  if (opts.mark) drawMark(ctx, view, opts.mark);
}

function orient(ctx, v) {
  ctx.transform(0, -1, -1, 0, v.outW, v.outH);
}
