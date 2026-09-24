// Studio Workshop — ported from the owner's earlier frontend (owner-authorized port).
// Standard MIDI File import.
// Workshop edits sit outside the Canonical/verified pipeline and are never evidence.
import {
  PPQ, CELL_TICKS, BAR_TICKS, PITCH_MIN, PITCH_MAX, pitchName, MAX_TRACK_CHARS, MAX_TRACKS,
  makeBarMap,
} from "./config.mjs";
import { tempoChanges, bareTrack } from "./mml.mjs";
import { itemsToMML, MAX_NOTE_TICKS } from "./mml-compress.mjs";
import {
  separateVoices, hasMelody, melodyKind, melodyRatio, sample, onsetGroups, mergeUnisons,
} from "./voices.mjs";
import { clamp } from "./util.mjs";
import * as i18n from "./i18n.mjs";

export { sample };

const GRID = CELL_TICKS;

const MAX_TEMPO_EVENTS = 32;

const MAX_VEL_EVENTS = 60;

export const VOICE_LANES = 4;

const MAX_WARNINGS = 6;

const SHIFTS = [0, 12, -12, 24, -24, 36, -36, 48, -48, 60, -60];

export class MidiError extends Error {}

const GM_NAMES = (
  "Acoustic Grand Piano,Bright Acoustic Piano,Electric Grand Piano,Honky-tonk Piano," +
  "Electric Piano 1,Electric Piano 2,Harpsichord,Clavi," +
  "Celesta,Glockenspiel,Music Box,Vibraphone,Marimba,Xylophone,Tubular Bells,Dulcimer," +
  "Drawbar Organ,Percussive Organ,Rock Organ,Church Organ,Reed Organ,Accordion,Harmonica,Tango Accordion," +
  "Acoustic Guitar (nylon),Acoustic Guitar (steel),Electric Guitar (jazz),Electric Guitar (clean)," +
  "Electric Guitar (muted),Overdriven Guitar,Distortion Guitar,Guitar Harmonics," +
  "Acoustic Bass,Electric Bass (finger),Electric Bass (pick),Fretless Bass," +
  "Slap Bass 1,Slap Bass 2,Synth Bass 1,Synth Bass 2," +
  "Violin,Viola,Cello,Contrabass,Tremolo Strings,Pizzicato Strings,Orchestral Harp,Timpani," +
  "String Ensemble 1,String Ensemble 2,Synth Strings 1,Synth Strings 2,Choir Aahs,Voice Oohs,Synth Voice,Orchestra Hit," +
  "Trumpet,Trombone,Tuba,Muted Trumpet,French Horn,Brass Section,Synth Brass 1,Synth Brass 2," +
  "Soprano Sax,Alto Sax,Tenor Sax,Baritone Sax,Oboe,English Horn,Bassoon,Clarinet," +
  "Piccolo,Flute,Recorder,Pan Flute,Blown Bottle,Shakuhachi,Whistle,Ocarina," +
  "Lead 1 (square),Lead 2 (sawtooth),Lead 3 (calliope),Lead 4 (chiff)," +
  "Lead 5 (charang),Lead 6 (voice),Lead 7 (fifths),Lead 8 (bass + lead)," +
  "Pad 1 (new age),Pad 2 (warm),Pad 3 (polysynth),Pad 4 (choir),Pad 5 (bowed),Pad 6 (metallic),Pad 7 (halo),Pad 8 (sweep)," +
  "FX 1 (rain),FX 2 (soundtrack),FX 3 (crystal),FX 4 (atmosphere),FX 5 (brightness),FX 6 (goblins),FX 7 (echoes),FX 8 (sci-fi)," +
  "Sitar,Banjo,Shamisen,Koto,Kalimba,Bag pipe,Fiddle,Shanai," +
  "Tinkle Bell,Agogo,Steel Drums,Woodblock,Taiko Drum,Melodic Tom,Synth Drum,Reverse Cymbal," +
  "Guitar Fret Noise,Breath Noise,Seashore,Bird Tweet,Telephone Ring,Helicopter,Applause,Gunshot"
).split(",");

class Reader {
  constructor(b) { this.b = b; this.i = 0; }
  u8()  { const v = this.b[this.i++]; return v === undefined ? 0 : v; }
  u16() { return (this.u8() << 8) | this.u8(); }
  u32() { return ((this.u8() << 24) | (this.u8() << 16) | (this.u8() << 8) | this.u8()) >>> 0; }
  str(n) { let s = ""; for (let k = 0; k < n; k++) s += String.fromCharCode(this.u8()); return s; }
  vlq() {
    let n = 0;
    for (let k = 0; k < 4; k++) {
      const c = this.u8();
      n = (n << 7) | (c & 127);
      if (!(c & 128)) break;
    }
    return n;
  }
}

const JUNK_CHARS = /[\ufffd\ufffe\uffff\ufdd0-\ufdef\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g;

function metaText(bytes, at, len) {
  const raw = bytes.subarray(at, at + len);
  let s;
  try {
    s = new TextDecoder("utf-8", { fatal: true }).decode(raw);
  } catch {
    s = new TextDecoder("latin1").decode(raw);
  }
  return s.replace(JUNK_CHARS, "").replace(/\s+/g, " ").trim();
}

export function parseSMF(bytes) {
  const r = new Reader(bytes);
  if (bytes.length < 14 || r.str(4) !== "MThd")
    throw new MidiError(i18n.t("midiIn.err.notMidi"));

  const hlen = r.u32();
  const format = r.u16();
  const ntrks = r.u16();
  const division = r.u16();
  r.i = 8 + hlen;

  if (division & 0x8000)
    throw new MidiError(i18n.t("midiIn.err.smpte"));

  const srcPpq = division || PPQ;
  const q = t => Math.round(t * PPQ / srcPpq / GRID) * GRID;

  const warnings = [];
  const rawTempos = [];
  const rawMeters = [];
  const rawMarks = [];
  const tracks = [];

  while (r.i + 8 <= bytes.length && tracks.length < ntrks) {
    const id = r.str(4);
    const len = r.u32();
    const end = Math.min(bytes.length, r.i + len);
    if (id !== "MTrk") { r.i = end; continue; }
    tracks.push(readTrack(r, end, rawTempos, rawMeters, rawMarks, q));
    r.i = end;
  }

  if (tracks.some(t => t.truncated))
    warnings.push(i18n.t("midiIn.warn.truncated"));

  let clamped = false;
  const seen = new Map();
  for (const ev of rawTempos.sort((a, b) => a.tick - b.tick)) {
    const bpm = Math.round(ev.bpm);
    const v = clamp(bpm, 32, 255);
    if (v !== bpm) clamped = true;
    seen.set(ev.tick, v);
  }
  if (clamped) warnings.push(i18n.t("midiIn.warn.tempoClamped"));
  const tempos = tempoChanges(
    [...seen.entries()].sort((a, b) => a[0] - b[0]).map(([tick, bpm]) => ({ tick, bpm })));

  const byTick = new Map();
  for (const m of rawMeters.sort((a, b) => a.tick - b.tick)) byTick.set(m.tick, m);
  const meters = [...byTick.values()];

  const markByTick = new Map();
  for (const m of rawMarks.sort((a, b) => a.tick - b.tick)) markByTick.set(m.tick, m);
  const marks = [...markByTick.values()];

  return { srcPpq, format, tracks, tempos, meters, marks, warnings };
}

function readTrack(r, end, rawTempos, rawMeters, rawMarks, q) {
  let tick = 0, status = 0;
  let name = "", instName = "";
  let truncated = false;

  const open = new Map();
  const notes = [];
  const programs = new Map();

  const closeNote = (ch, midi, at) => {
    const k = ch * 128 + midi;
    const q2 = open.get(k);
    if (!q2 || !q2.length) return;
    const n = q2.shift();
    n.endTick = at;
    notes.push(n);
  };

  while (r.i < end) {
    tick += r.vlq();
    if (r.i >= end) { truncated = true; break; }

    let b = r.u8();
    if (b < 0x80) { r.i--; b = status; }
    else if (b < 0xF0) status = b;
    else status = 0;
    if (!b) { truncated = true; break; }

    if (b === 0xFF) {
      const type = r.u8();
      const len = r.vlq();
      const at = r.i;
      if (type === 0x51 && len >= 3) {
        const us = (r.b[at] << 16) | (r.b[at + 1] << 8) | r.b[at + 2];
        if (us > 0) rawTempos.push({ tick: q(tick), bpm: 60000000 / us });
      } else if (type === 0x58 && len >= 2) {
        const dd = r.b[at + 1];
        if (dd <= 5) rawMeters.push({ tick: q(tick), num: r.b[at], den: 1 << dd });
      } else if (type === 0x06 && len > 0) {
        const t = metaText(r.b, at, len).trim();
        if (t) rawMarks.push({ tick: q(tick), text: t });
      } else if (type === 0x03 && !name) name = metaText(r.b, at, len);
      else if (type === 0x04 && !instName) instName = metaText(r.b, at, len);
      r.i = at + len;
      if (type === 0x2F) break;
      continue;
    }
    if (b === 0xF0 || b === 0xF7) { r.i += r.vlq(); continue; }

    const hi = b & 0xF0, ch = b & 0x0F;
    if (hi === 0x90 || hi === 0x80) {
      const midi = r.u8() & 127, vel = r.u8() & 127;
      if (hi === 0x90 && vel > 0) {
        const k = ch * 128 + midi;
        if (!open.has(k)) open.set(k, []);
        open.get(k).push({ ch, tick: q(tick), endTick: 0, midi, vel });
      } else {
        closeNote(ch, midi, q(tick));
      }
    }
    else if (hi === 0xC0) {
      const prog = r.u8() & 127;
      if (!programs.has(ch)) programs.set(ch, []);
      const list = programs.get(ch);
      if (list[list.length - 1] !== prog) list.push(prog);
    }
    else if (hi === 0xD0) r.i += 1;
    else r.i += 2;

    if (r.i > end) { truncated = true; break; }
  }

  for (const q2 of open.values()) for (const n of q2) { n.endTick = q(tick); notes.push(n); }

  notes.sort((a, b) => a.tick - b.tick || a.midi - b.midi);
  return { name, instName, notes, programs, truncated };
}

export function inventory(smf) {
  const rows = [];
  smf.tracks.forEach((tr, mtrk) => {
    const byCh = new Map();
    for (const n of tr.notes) {
      if (!byCh.has(n.ch)) byCh.set(n.ch, []);
      byCh.get(n.ch).push(n);
    }
    for (const ch of [...byCh.keys()].sort((a, b) => a - b)) {
      const notes = byCh.get(ch);
      const programs = tr.programs.get(ch) ?? [];
      const drum = ch === 9;
      rows.push({
        mtrk, ch, notes,
        noteCount: notes.length,
        programs,
        drum,
        melody: drum ? "unknown" : melodyKind(notes),
        label: channelLabel(tr, ch, programs),
      });
    }
  });
  rows.forEach((row, i) => { row.index = i + 1; });
  return rows;
}

// Where an imported file's score starts: the start of the bar (in the file's
// own meter map) that holds its first note. Whole empty bars before it are
// trimmed; a pickup keeps its place in its bar, so the bar grid, and the
// meters and marks that sit on it, stay where they were against the notes.
export function fileOrigin(rows, meters = []) {
  let best = Infinity;
  for (const r of rows) {
    const t = r.notes?.[0]?.tick;
    if (t !== undefined && t < best) best = t;
  }
  if (!Number.isFinite(best)) return 0;
  const bars = makeBarMap(meters);
  return bars.barStartTick(bars.barIndexOf(best));
}

// Moves a file's meter or mark list onto the imported score's clock, which
// starts at `origin` (see fileOrigin): the lanes are written from the origin,
// so these move with them. The entry in force at the origin becomes the one
// at tick 0; earlier ones are dropped.
export function shiftToOrigin(list, origin) {
  const sorted = [...(list ?? [])].sort((a, b) => a.tick - b.tick);
  const head = sorted.filter(e => e.tick <= origin).at(-1);
  const rest = sorted.filter(e => e.tick > origin).map(e => ({ ...e, tick: e.tick - origin }));
  return head ? [{ ...head, tick: 0 }, ...rest] : rest;
}

function channelLabel(tr, ch, programs) {
  const gm = ch === 9 ? "" : (GM_NAMES[programs[0]] ?? "");
  const name = gm || tr.name || tr.instName || "";
  let s = `Ch ${ch + 1}`;
  if (name) s += ` · ${name}`;
  if (programs.length > 1) s += i18n.t("midiIn.multiProgram", { n: programs.length });
  return s;
}

export function bestShift(midis) {
  let best = 0, bestIn = -1;
  for (const k of SHIFTS) {
    let n = 0;
    for (const m of midis) if (m + k >= PITCH_MIN && m + k <= PITCH_MAX) n++;
    if (n > bestIn) { bestIn = n; best = k; }
    if (bestIn === midis.length) break;
  }
  return best;
}

export function velPlan(picks) {
  const vels = picks.map(p => clamp(Math.round(p.vel / 127 * 15), 1, 15));
  if (!vels.length) return { base: 8, at: [] };

  const sorted = [...vels].sort((a, b) => a - b);
  const base = clamp(sorted[sorted.length >> 1], 1, 15);

  for (let d = 0.25; d <= 2.001; d += 0.25) {
    const at = [];
    let cur = base, n = 0;
    for (const v of vels) {
      const hi = Math.ceil(cur * (1 + d)), lo = Math.floor(cur * (1 - d));
      if (v >= hi || v <= lo) { at.push(v); cur = v; n++; } else at.push(null);
    }
    if (n <= MAX_VEL_EVENTS) return { base, at };
  }
  return { base, at: vels.map(() => null) };
}

function laneItems(picks, { origin = 0, shift = 0 } = {}) {
  const items = [];
  const { base, at } = velPlan(picks);
  items.push({ k: "v", v: base });

  let cursor = origin;
  picks.forEach((p, i) => {
    if (p.tick > cursor) { items.push({ k: "rest", dur: p.tick - cursor }); }
    if (at[i] !== null) items.push({ k: "v", v: at[i] });
    items.push({ k: "note", midi: clamp(p.midi + shift, PITCH_MIN, PITCH_MAX), dur: p.dur });
    cursor = p.tick + p.dur;
  });
  return items;
}

function capLongNotes(items) {
  if (!items.some(it => it.k === "note" && it.dur > MAX_NOTE_TICKS)) return { items, capped: 0 };
  const out = [];
  let capped = 0;
  for (const it of items) {
    if (it.k !== "note" || it.dur <= MAX_NOTE_TICKS) { out.push(it); continue; }
    out.push({ ...it, dur: MAX_NOTE_TICKS });
    out.push({ k: "rest", dur: it.dur - MAX_NOTE_TICKS });
    capped++;
  }
  return { items: out, capped };
}

function insertTempos(items, tempos, origin) {
  if (!tempos.length) return items;

  const at = [];
  let t = origin;
  for (const it of items) { at.push(t); if (it.k === "note" || it.k === "rest") t += it.dur; }
  at.push(t);

  const slot = new Map();
  for (const ev of tempos) {
    let best = 0;
    for (let i = 1; i < at.length; i++)
      if (Math.abs(at[i] - ev.tick) < Math.abs(at[best] - ev.tick)) best = i;
    slot.set(best, ev.bpm);
  }

  const out = [];
  for (let i = 0; i < items.length; i++) {
    if (slot.has(i)) out.push({ k: "t", v: slot.get(i) });
    out.push(items[i]);
  }
  if (slot.has(items.length)) out.push({ k: "t", v: slot.get(items.length) });
  return out;
}

function rootInput(notes) {
  const out = [];
  for (const g of onsetGroups(notes)) {
    let lo = g.notes[0].midi, hi = lo;
    for (const n of g.notes) { if (n.midi < lo) lo = n.midi; if (n.midi > hi) hi = n.midi; }
    if (lo !== hi) out.push(...g.notes);
  }
  return out;
}

function expandRow(row, warnings) {
  if (row.mode !== "voices" && row.mode !== "all") {
    if (row.mode !== "both") return [{ row, mode: row.mode === "root" ? "root" : "melody" }];

    const mel = sample(row.notes, "melody");
    const root = sample(rootInput(row.notes), "root");
    const lanes = [{ row, mode: "melody", picks: mel }];
    if (root.length) lanes.push({ row, mode: "root", picks: root });
    else warnings.push(i18n.t("midiIn.warn.monoSame",
      { track: row.label ?? i18n.t("midiIn.someTrack") }));
    return lanes;
  }

  const notes = mergeUnisons(row.notes);

  const melody = hasMelody(notes);
  const head = melody ? VOICE_LANES : VOICE_LANES - 1;

  const first = separateVoices(notes, { cap: head, melody });
  const rest = row.mode === "all"
    ? separateVoices(mergeUnisons(first.leftover), { cap: MAX_TRACKS - head, melody: false })
    : { lanes: [] };
  const got = [...first.lanes, ...rest.lanes];

  const what = i18n.t(row.mode === "all" ? "midiIn.mode.all" : "midiIn.mode.smart");
  const label = row.label ?? i18n.t("midiIn.someTrack");
  if (!got.length) {
    warnings.push(i18n.t("midiIn.warn.nothingPicked", { track: label, mode: what }));
    return [];
  }

  if (!melody)
    warnings.push(i18n.t("midiIn.warn.chordOnly",
      { track: label, pct: Math.round(melodyRatio(notes) * 100) }));

  const covered = new Set(got.flat().map(p => p.src));
  const heard = new Set(got.flat().map(p => `${p.tick}:${p.midi}`));
  const lost = row.notes.reduce((n, x) =>
    n + (covered.has(x) || heard.has(`${x.tick}:${x.midi}`) ? 0 : 1), 0);
  if (lost) warnings.push(i18n.t("midiIn.warn.lostNotes", { track: label, n: lost }));

  const cap = row.mode === "all" ? MAX_TRACKS : head;
  if (got.length < cap)
    warnings.push(i18n.t("midiIn.warn.fewerLanes",
      { track: label, mode: what, n: got.length }));

  return got.map(picks => ({ row, mode: row.mode, picks }));
}

export function buildImport(sel, tempos = [], o = {}) {
  const { origin: fileOrigin = null, append = false, existingTempos = [], base = 0 } = o;
  const warnings = [];

  const lanes = [];
  for (const row of sel) lanes.push(...expandRow(row, warnings));

  for (const lane of lanes) if (!lane.picks) lane.picks = sample(lane.row.notes, lane.mode);

  const starts = lanes.filter(l => l.picks.length).map(l => l.picks[0].tick);
  const origin = fileOrigin !== null ? fileOrigin : (starts.length ? Math.min(...starts) : 0);

  let useTempos = tempos;
  if (tempos.length > MAX_TEMPO_EVENTS) {
    useTempos = tempos.slice(0, 1);
    warnings.push(i18n.t("midiIn.warn.manyTempos",
      { n: tempos.length, bpm: tempos[0].bpm }));
  }

  const writeTempo = !append || !existingTempos.length;
  if (!writeTempo && useTempos.length && useTempos[0].bpm !== existingTempos[0]?.bpm)
    warnings.push(i18n.t("midiIn.warn.tempoMismatch",
      { theirs: useTempos[0].bpm, ours: existingTempos[0].bpm }));

  const groups = new Map();
  for (const lane of lanes) {
    if (!groups.has(lane.row)) groups.set(lane.row, []);
    groups.get(lane.row).push(lane);
  }
  for (const [row, group] of groups) {
    const midis = group.flatMap(l => l.picks.map(p => p.midi));
    const shift = row.drum ? 0 : bestShift(midis);
    for (const l of group) l.shift = shift;
    const label = row.label ?? i18n.t("midiIn.someTrack");
    if (shift)
      warnings.push(i18n.t("midiIn.warn.octaveShift", {
        track: label,
        dir: i18n.t(shift > 0 ? "midiIn.up" : "midiIn.down"),
        n: Math.abs(shift) / 12,
      }));
    const outside = midis.filter(m => m + shift < PITCH_MIN || m + shift > PITCH_MAX).length;
    if (outside) warnings.push(i18n.t("midiIn.warn.outOfRange",
      { track: label, n: outside, lo: pitchName(PITCH_MIN), hi: pitchName(PITCH_MAX) }));
  }

  const texts = [];
  const over = [], capped = [], failed = [];
  lanes.forEach((lane, i) => {
    const no = base + i + 1;
    let items = laneItems(lane.picks, { origin, shift: lane.shift ?? 0 });
    const cap = capLongNotes(items);
    items = cap.items;
    if (cap.capped) capped.push(no);
    if (i === 0 && writeTempo) items = insertTempos(items, useTempos, origin);

    const mml = itemsToMML(items, {
      dropTrailingRests: true,
      isFirstTrack: base + i === 0,
      plain: true,
    });
    if (mml === null) {
      failed.push(no);
      texts.push("");
      return;
    }
    texts.push(mml);
    if (bareTrack(mml).length > MAX_TRACK_CHARS) over.push(no);
  });

  if (capped.length)
    warnings.push(i18n.t("midiIn.warn.tooLong",
      { list: i18n.list(capped), bars: MAX_NOTE_TICKS / BAR_TICKS }));
  if (failed.length)
    warnings.push(i18n.t("midiIn.warn.writeFailed", { list: i18n.list(failed) }));
  if (over.length)
    warnings.push(i18n.t("midiIn.warn.overLimit",
      { list: i18n.list(over), max: MAX_TRACK_CHARS }));

  return { texts, warnings: trimWarnings(warnings) };
}

export function trimWarnings(list) {
  if (list.length <= MAX_WARNINGS) return list;
  return [...list.slice(0, MAX_WARNINGS), i18n.t("midiIn.moreWarnings", { n: list.length })];
}
