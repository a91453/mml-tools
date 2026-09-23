// Studio Workshop — ported from the owner's earlier frontend (owner-authorized port).
// MML tokenizer and parser (workshop dialect).
// Workshop edits sit outside the Canonical/verified pipeline and are never evidence.
import {
  OCT_BASE, N_BASE, PPQ,
  PITCH_MIN, PITCH_MAX, pitchName, foldIntoRange,
} from "./config.mjs";
import { clamp } from "./util.mjs";
import * as i18n from "./i18n.mjs";

const STEP = { c:0, d:2, e:4, f:5, g:7, a:9, b:11, h:11 };

export function dotMul(dots) {
  let mul = 1, add = 1;
  for (let k = 0; k < dots; k++) { add /= 2; mul += add; }
  return mul;
}

export function lenTicks(denom, dots) {
  return Math.round(Math.floor(PPQ * 4 / Math.max(1, denom)) * dotMul(dots));
}

function tempoPoints(tempos) {
  const pts = [{ tick: 0, bpm: 120, sec: 0 }];
  for (const ev of tempos) {
    if (ev.tick <= 0) { pts[0].bpm = ev.bpm; continue; }
    const p = pts[pts.length - 1];
    pts.push({ tick: ev.tick, bpm: ev.bpm, sec: p.sec + (ev.tick - p.tick) * 60 / (p.bpm * PPQ) });
  }
  return pts;
}

export function makeClock(tempos) {
  const pts = tempoPoints(tempos);
  return tick => {
    let lo = 0, hi = pts.length - 1;
    while (lo < hi) { const m = (lo + hi + 1) >> 1; if (pts[m].tick <= tick) lo = m; else hi = m - 1; }
    const p = pts[lo];
    return p.sec + (tick - p.tick) * 60 / (p.bpm * PPQ);
  };
}

export const tempoChanges = tempos =>
  (tempos ?? []).filter((e, i, a) => i === 0 || e.bpm !== a[i - 1].bpm);

export const velChanges = vels =>
  (vels ?? []).filter((e, i, a) => i === 0 || e.v !== a[i - 1].v);

export function makeInverseClock(tempos) {
  const pts = tempoPoints(tempos);
  return sec => {
    let lo = 0, hi = pts.length - 1;
    while (lo < hi) { const m = (lo + hi + 1) >> 1; if (pts[m].sec <= sec) lo = m; else hi = m - 1; }
    const p = pts[lo];
    return p.tick + (sec - p.sec) * p.bpm * PPQ / 60;
  };
}

export function stripWrapper(src) {
  let s = src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");
  const at = s.toLowerCase().indexOf("mml@");
  if (at >= 0) s = s.slice(at + 4);
  return s.replace(/;[\s\S]*$/, "");
}

export function splitMML(src) {
  return stripWrapper(src).split(",").map(s => s.trim());
}

export const bareTrack = src => stripWrapper(src ?? "").replace(/\s+/g, "");

export const stripPrograms = src => (src ?? "").replace(/@\d+/g, "");

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
      if (j > i + 1) { i = j; continue; }
    }
    out += s[i++];
  }
  return out;
}

export function compact(src) {
  const keep = [];
  for (let i = 0; i < src.length; ) {
    if (src[i] === "/" && src[i + 1] === "*") {
      const e = src.indexOf("*/", i + 2);
      if (e >= 0) { i = e + 2; continue; }
    }
    if (src[i] === "/" && src[i + 1] === "/") {
      while (i < src.length && src[i] !== "\n") i++;
      continue;
    }
    keep.push(i++);
  }

  const bare = keep.map(at => src[at]).join("").toLowerCase();
  const at = bare.indexOf("mml@");
  const from = at >= 0 ? at + 4 : 0;

  let to = keep.length;
  for (let k = from; k < keep.length; k++) if (bare[k] === ";") { to = k; break; }

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
      if (pitch === null) { yield { kind: "n", a, b: i, pitchEnd, numEnd: i, pitch, num: null, dots: 0 }; continue; }
      const num = readInt();
      const numEnd = i;
      const dots = readDots();
      yield { kind: "n", a, b: i, pitchEnd, numEnd, pitch, num, dots };
    }
    else if (c === "l") {
      const num = readInt();
      const numEnd = i;
      const dots = num === null ? 0 : readDots();
      yield { kind: "l", a, b: i, numEnd, num, dots };
    }
    else if (c === "o" || c === "t" || c === "v") {
      const num = readInt();
      yield { kind: c, a, b: i, numEnd: i, num, dots: 0 };
    }
    else if (c === "@") {
      const num = readInt();
      yield { kind: "prog", a, b: i, numEnd: i, num, dots: 0 };
    }
    else if (c === ">" || c === "<") yield { kind: "oct", a, b: i, dir: c === ">" ? 1 : -1 };
    else if (c === "&") yield { kind: "tie", a, b: i };
    else yield { kind: "bad", a, b: i };
  }
}

export function parseAll(texts) {
  const warnings = [];
  const raws = texts.map((raw, idx) => parseTrack(raw, idx, warnings));

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
    rests: tr.rests,
    vels: tr.vels,
    end: clock(tr.endTick),
    endTick: tr.endTick,
  }));

  const duration = Math.max(0, ...tracks.map(t => t.end));
  return { tracks, tempos, duration, warnings };
}

export function parseTrack(raw, idx, warnings) {
  const label = i18n.trackName(idx);
  const { t, map, hasComma } = compact(raw);

  if (hasComma) warnings.push(i18n.t("mml.warn.comma", { track: label }));

  const notes = [], rests = [], tempos = [], vels = [];
  let tick = 0, endTick = 0;
  let octave = 4, vel15 = 8;
  let defLen = 4, defDots = 0;
  let tieNext = false;
  let foldWarned = false;

  const durOf = tok =>
    tok.num !== null ? lenTicks(tok.num, tok.dots)
      : tok.dots > 0 ? lenTicks(defLen, tok.dots)
        : lenTicks(defLen, defDots);
  function span(a, b) {
    const s = map[a] ?? 0;
    return { srcStart: s, srcEnd: (map[b - 1] ?? s) + 1 };
  }
  function push(midi, dur, a, b) {
    const m = foldIntoRange(midi);
    if (m !== midi && !foldWarned) {
      warnings.push(i18n.t("mml.warn.pitchFolded",
        { track: label, lo: pitchName(PITCH_MIN), hi: pitchName(PITCH_MAX) }));
      foldWarned = true;
    }
    const { srcStart, srcEnd } = span(a, b);
    const prev = notes[notes.length - 1];
    if (tieNext && prev && prev.midi === m && prev.tick + prev.dur === tick) {
      prev.dur += dur;
      prev.srcEnd = srcEnd;
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
    else if (kind === "o") { if (tok.num !== null) octave = tok.num; }
    else if (kind === "oct") octave += tok.dir > 0 ? 1 : -1;
    else if (kind === "l") { if (tok.num !== null) { defLen = Math.max(1, tok.num); defDots = tok.dots; } }
    else if (kind === "t") { if (tok.num !== null) tempos.push({ tick, bpm: clamp(tok.num, 32, 255) }); }
    else if (kind === "v") {
      if (tok.num !== null) { vel15 = clamp(tok.num, 0, 15); vels.push({ tick, v: vel15 }); }
    }
    else if (kind === "tie") tieNext = true;
    else if (kind === "prog") continue;
    else warnings.push(i18n.t("mml.warn.badChar", { track: label, char: t[a] }));
  }
  return { notes, rests, tempos, vels, endTick };
}
