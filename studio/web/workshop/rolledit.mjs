// Studio Workshop — ported from the owner's earlier frontend (owner-authorized port).
// Piano-roll edit operations on MML text.
// Workshop edits sit outside the Canonical/verified pipeline and are never evidence.
import { lenTicks } from "./mml.mjs";

import { PITCH_MIN, PITCH_MAX, FINE_TICKS } from "./config.mjs";
import { sample } from "./voices.mjs";

const clampPitch = m => Math.min(PITCH_MAX, Math.max(PITCH_MIN, Math.round(m)));

const timed = it => it.k === "note" || it.k === "rest";

export const totalTicks = items =>
  items.reduce((t, it) => t + (timed(it) ? it.dur : 0), 0);

function mergeRests(items) {
  const out = [];
  for (const it of items) {
    const prev = out[out.length - 1];
    if (it.k === "rest" && prev && prev.k === "rest") prev.dur += it.dur;
    else out.push(it.k === "rest" ? { ...it } : it);
  }
  return out;
}

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

    if (e <= at || s >= end) { out.push(it); continue; }

    const leftDur = at - s;
    const rightDur = e - end;
    if (leftDur > 0) out.push({ ...it, dur: leftDur });
    place();
    if (rightDur > 0) out.push({ k: "rest", dur: rightDur });
  }

  if (!placed) {
    if (at > cur) out.push({ k: "rest", dur: at - cur });
    place();
  }
  return mergeRests(out);
}

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

export function moveNote(items, from, to = {}) {
  const src = findNote(items, from.tick, from.midi);
  if (!src) return null;
  const tick = to.tick ?? src.tick;
  const midi = clampPitch(to.midi ?? src.midi);
  const dur = to.dur ?? src.dur;
  if (tick === src.tick && midi === src.midi && dur === src.dur) return null;
  return insertNote(deleteNote(items, from.tick, from.midi), tick, dur, midi);
}

export const noteKey = (tick, midi) => `${tick}:${midi}`;

export function moveNotes(items, picks, dTick, dMidi) {
  if (!picks?.length) return null;
  if (dTick === 0 && dMidi === 0) return null;

  const src = [];
  for (const p of picks) {
    const found = findNote(items, p.tick, p.midi);
    if (found) src.push(found);
  }
  if (!src.length) return null;

  let out = items;
  for (const n of src) out = deleteNote(out, n.tick, n.midi);
  for (const n of [...src].sort((a, b) => a.tick - b.tick))
    out = insertNote(out, Math.max(0, n.tick + dTick), n.dur, n.midi + dMidi);
  return out;
}

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

const TO_DOTTED = new Map(DOT_DENOMS.map(d => [lenTicks(d, 0), lenTicks(d, 1)]));
const TO_PLAIN  = new Map(DOT_DENOMS.map(d => [lenTicks(d, 1), lenTicks(d, 0)]));

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

  const dotted = hit.some(h => TO_DOTTED.has(h.it.dur));
  const next = new Map();
  for (const h of hit) {
    const to = dotted ? TO_DOTTED.get(h.it.dur) : TO_PLAIN.get(h.it.dur);
    if (to !== undefined && to !== h.it.dur) next.set(h.it, to);
  }
  if (!next.size) return { items: items.slice(), dotted, n: 0 };

  if (dotted) {
    const places = hit.filter(h => next.has(h.it))
      .map(h => ({ tick: h.tick, dur: next.get(h.it) }));
    const killed = notes.filter(n => places.some(p => n.tick > p.tick && n.tick < p.tick + p.dur))
      .map(n => ({ tick: n.tick, midi: n.midi }));
    if (killed.length) return { blocked: killed };
  }

  const out = [];
  let debt = 0;
  for (const it of items) {
    if (debt > 0 && it.k === "rest") {
      const take = Math.min(debt, it.dur);
      debt -= take;
      if (it.dur > take) out.push({ ...it, dur: it.dur - take });
      continue;
    }
    if (debt > 0 && it.k === "note") debt = 0;

    const to = next.get(it);
    if (to === undefined) { out.push(it); continue; }
    out.push({ ...it, dur: to });
    if (to < it.dur) out.push({ k: "rest", dur: it.dur - to });
    else debt += to - it.dur;
  }
  return { items: tempos.length ? placeTempos(mergeRests(out), tempos) : mergeRests(out), dotted, n: next.size };
}

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

export function overwriteEffect(notes, places, moving = []) {
  const skip = new Set(moving.map(p => noteKey(p.tick, p.midi)));
  const killed = [], trimmed = [];

  for (const n of notes) {
    if (skip.has(noteKey(n.tick, n.midi))) continue;
    const s = n.tick, e = n.tick + n.dur;

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

export function setVelocities(items, v, ticks = null) {
  const n = Math.min(15, Math.max(0, Math.round(v)));
  const want = velocitiesOf(items);
  for (const tick of [...want.keys()]) {
    if (ticks && !ticks.has(tick)) continue;
    want.set(tick, n);
  }
  return applyVelocities(items, want);
}

export function setVelocityAt(items, tick, v) {
  const out = [];
  let run = [];
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
  out.push(...run);
  return done ? out : items;
}

export function applyVelocities(items, want) {
  const out = [];
  let v = 8, cur = 0;
  for (const it of items) {
    if (it.k === "v") continue;
    if (it.k === "note") {
      const w = want.get(cur);
      if (w !== undefined && w !== v) { out.push({ k: "v", v: w }); v = w; }
    }
    out.push(it);
    if (timed(it)) cur += it.dur;
  }
  return out;
}

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

export function placeVelocity(items, tick, v) {
  const n = Math.min(15, Math.max(0, Math.round(v)));
  const at = Math.max(0, tick);
  const mark = { k: "v", v: n };

  const out = [];
  let cur = 0, done = false;

  for (const it of items) {
    if (done || !timed(it)) { out.push(it); if (timed(it)) cur += it.dur; continue; }

    const end = cur + it.dur;
    if (at <= cur) {
      out.push(mark, it);
      done = true;
    } else if (at < end) {
      if (it.k === "rest") {
        out.push(mark, it);
      } else {
        out.push(it, mark);
      }
      done = true;
    } else {
      out.push(it);
    }
    cur = end;
  }

  if (!done) out.push(mark);

  return dropDeadVelocity(out);
}

function dropDeadVelocity(items) {
  const out = [];
  for (const it of items) {
    if (it.k === "v" && out.length && out[out.length - 1].k === "v") out.pop();
    out.push(it);
  }
  return out;
}

export function placeTempos(items, tempos) {
  const evs = [...tempos].sort((a, b) => a.tick - b.tick);
  const out = [];
  let cur = 0, k = 0;

  for (const it of items) {
    if (it.k === "t") continue;
    if (!timed(it)) { out.push(it); continue; }

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

  while (k < evs.length) {
    const e = evs[k++];
    if (e.tick > cur) { out.push({ k: "rest", dur: e.tick - cur }); cur = e.tick; }
    out.push({ k: "t", v: e.bpm });
  }
  return out;
}

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
      out.push(first ? { ...it, dur: t - at } : { ...it, dur: t - at, tie: true });
      at = t; first = false;
    }
    out.push({ ...it, dur: end - at, tie: true });
    changed = true;
    cur = end;
  }
  return { items: out, changed };
}

export const snapDown = (tick, step) => Math.floor(Math.max(0, tick) / step) * step;

const keepLast = list =>
  list.filter((it, i) => !list.some((o, j) => j > i && o.k === it.k));

export function insertTime(items, at, len) {
  if (!(len > 0)) return items.slice();
  const P = Math.max(0, Math.round(at));
  const L = Math.round(len);

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

  if (firstAfter < 0) return items.slice();

  let sp = firstAfter;
  if (P > 0) while (sp > 0 && !timed(items[sp - 1])) sp--;

  return mergeRests([
    ...items.slice(0, sp),
    { k: "rest", dur: L },
    ...items.slice(sp),
  ]);
}

export function deleteTime(items, at, len) {
  if (!(len > 0)) return items.slice();
  const P = Math.max(0, Math.round(at));
  const Q = P + Math.round(len);
  if (P >= totalTicks(items)) return items.slice();

  const out = [], held = [];
  let cur = 0, flushed = false;

  const flush = () => {
    if (flushed) return;
    flushed = true;
    out.push(...keepLast(held));
  };

  for (const it of items) {
    if (!timed(it)) {
      if (cur >= Q) flush();
      if (cur >= P && cur < Q) held.push(it);
      else out.push(it);
      continue;
    }

    const s = cur;
    cur += it.dur;
    const e = cur;

    if (e <= P) { out.push(it); continue; }
    if (s >= Q) { flush(); out.push(it); continue; }

    if (s < P) {
      out.push({ ...it, dur: it.dur - (Math.min(e, Q) - P) });
      if (e > Q) flush();
    } else if (e > Q) {
      flush();
      out.push({ k: "rest", dur: e - Q });
    }
  }
  flush();
  return mergeRests(out);
}

export const lastNoteEnd = items => {
  let cur = 0, end = 0;
  for (const it of items) {
    if (it.k === "note") end = Math.max(end, cur + it.dur);
    if (timed(it)) cur += it.dur;
  }
  return end;
};

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

export const MERGE_MODES = ["src", "tgt", "melody", "root", "replace"];

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

export function clearRange(items, from, to) {
  if (!(to > from)) return items.slice();
  const out = [];
  let cur = 0;
  for (const it of items) {
    if (!timed(it)) { out.push(it); continue; }
    const s = cur, e = cur + it.dur;
    cur = e;
    if (e <= from || s >= to) { out.push(it); continue; }
    if (s < from) out.push({ ...it, dur: from - s });
    const mid = Math.min(e, to) - Math.max(s, from);
    if (mid > 0) out.push({ k: "rest", dur: mid });
    if (e > to) out.push({ k: "rest", dur: e - to });
  }
  return mergeRests(out);
}

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

function fitInto(busy, tick, dur) {
  let limit = Infinity;
  for (const [s, e] of busy) {
    if (s > tick) { limit = s; break; }
    if (tick < e) return 0;
  }
  const got = Math.min(dur, limit - tick);
  if (got < dur && got < FINE_TICKS) return 0;
  return got;
}

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

export function mergeTracks(srcItems, tgtItems, mode, keys = null) {
  const srcNotes = notesOf(srcItems);
  const tgtNotes = notesOf(tgtItems);

  const part = keys ? srcNotes.filter(n => keys.has(noteKey(n.tick, n.midi))) : srcNotes;
  if (!part.length) return { block: "empty", count: 0 };

  const from = Math.min(...part.map(n => n.tick));
  const to = Math.max(...part.map(n => n.tick + n.dur));

  const inWin = tgtNotes.filter(n => n.tick >= from && n.tick < to);

  let places;
  if (mode === "melody" || mode === "root") {
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
    places = part.map(n => ({ tick: n.tick, dur: n.dur, midi: n.midi, vel: n.vel }));
  }

  const want = velocitiesOf(tgtItems);
  let tgt = mode === "replace" ? clearRange(tgtItems, from, to) : tgtItems;
  for (const p of places) {
    tgt = insertNote(tgt, p.tick, p.dur, p.midi);
    want.set(p.tick, p.vel);
  }
  tgt = applyVelocities(tgt, want);

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
