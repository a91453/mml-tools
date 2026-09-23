// Studio Workshop — ported from the owner's earlier frontend (owner-authorized port).
// 3MLE .mml/.mmi and plain MML score reader.
// Workshop edits sit outside the Canonical/verified pipeline and are never evidence.
import { PPQ, meterTicks } from "./config.mjs";
import { parseAll, bareTrack, splitMML } from "./mml.mjs";
import { trackToItems, itemsToMML, budgetFor, repairItems, encoderNums } from "./mml-compress.mjs";
import { parseExtension, EXT_SECTION } from "./mml-ext.mjs";
import * as i18n from "./i18n.mjs";

export function sniff(text) {
  const head = (text ?? "").slice(0, 4096);
  if (/^\s*\[mml-score\]/i.test(head)) return "mmi";
  if (/^\s*\[Settings\]/i.test(head) || /^\s*\[Channel\d+\]/im.test(head)) return "mml";
  if (/mml@/i.test(text ?? "")) return "raw";
  return null;
}

function sections(text) {
  const out = [];
  const re = /^[ \t]*\[([^\]\r\n]*)\][ \t]*(?:\r?\n|$)/gm;
  let m, prev = null;
  while ((m = re.exec(text)) !== null) {
    if (prev) prev.body = text.slice(prev.at, m.index);
    prev = { name: m[1].trim(), at: re.lastIndex, body: "" };
    out.push(prev);
  }
  if (prev) prev.body = text.slice(prev.at);
  return out;
}

function kv(line) {
  const i = line.indexOf("=");
  if (i < 0) return null;
  return [line.slice(0, i).trim().toLowerCase(), line.slice(i + 1)];
}

const int = v => {
  const n = Number.parseInt(String(v).trim(), 10);
  return Number.isFinite(n) ? n : null;
};

export function gameTicks(denom, dots) {
  let t = Math.floor(384 / Math.max(1, denom));
  for (let k = 0; k < dots; k++) t += Math.floor(t / 2);
  return t * 5;
}

const STD_SET = new Set([1, 2, 3, 4, 6, 8, 12, 16, 24, 32, 48, 64]);

export function restoreStandard(raw) {
  const same = { text: raw, changed: false, drift: 0, snapped: 0, unrestorable: 0 };
  const g = trackToItems(raw, { ticksOf: gameTicks });
  if (g.error || ![...g.seenNums].some(n => !STD_SET.has(n))) return same;
  const out = itemsToMML(g.items, { budget: budgetFor(bareTrack(raw).length), plain: true });
  if (out === null || timingSequence(trackToItems(out)) !== timingSequence(g))
    return { ...same, unrestorable: 1 };
  return { ...same, text: out, changed: out !== raw };
}

function timingSequence(parsed) {
  let tick = 0;
  const events = [];
  for (const it of parsed.items) {
    if (it.k === "rest") { tick += it.dur; continue; }
    if (it.k === "note") {
      events.push([tick, it.k, it.midi, it.dur]);
      tick += it.dur;
    } else events.push([tick + (it.delay ?? 0), it.k, it.v]);
  }
  return JSON.stringify([events, tick]);
}

const nonstdOf = t =>
  repairItems(t.items, { allowedNums: encoderNums(t.seenNums) })
    .issues.filter(x => x.kind === "nonstd").length;

export function nonstdCount(raw) {
  const t = trackToItems(raw);
  return t.error ? 0 : nonstdOf(t);
}

function makePart(index, label, text, program) {
  const chars = bareTrack(text).length;
  const p = parseAll([text]);
  const t = trackToItems(text);
  return {
    index, label, text, program,
    notes: p.tracks[0]?.notes.length ?? 0,
    chars,
    readonly: t.error ?? null,
    warn: p.warnings[0] ?? null,
    nonstd: t.error ? 0 : nonstdOf(t),
  };
}

const nonEmpty = p => p.chars > 0;

function channelOrder(ext, bodies) {
  const seq = [];
  const seen = new Set();
  const take = ch => { if (bodies.has(ch) && !seen.has(ch)) { seen.add(ch); seq.push(ch); } };
  if (ext) ext.order.forEach(take);
  [...bodies.keys()].sort((a, b) => a - b).forEach(take);
  return seq;
}

function parseMml(text) {
  const secs = sections(text);
  const warnings = [];
  let title = "", encoding = "";

  for (const s of secs) {
    if (!/^settings$/i.test(s.name)) continue;
    for (const line of s.body.split(/\r?\n/)) {
      const p = kv(line);
      if (!p) continue;
      if (p[0] === "title") title = p[1].trim();
      else if (p[0] === "encoding") encoding = p[1].trim();
    }
  }

  const bodies = new Map();
  for (const s of secs) {
    const n = int(/^Channel(\d+)$/i.exec(s.name)?.[1]);
    if (n === null || n < 1) continue;
    bodies.set(n - 1, s.body.replace(/^\r?\n/, ""));
  }

  const extSec = secs.find(s => s.name.toUpperCase() === EXT_SECTION);
  const ext = extSec ? parseExtension(extSec.body, encoding) : null;
  const meters = ext?.meter ? [{ tick: 0, num: ext.meter.num, den: ext.meter.den }] : [];
  const mmlPpq = ext?.meter?.ppq > 0 ? ext.meter.ppq : 96;
  const marks = (ext?.marks ?? []).map(m => ({ tick: Math.round(m.tick * PPQ / mmlPpq), text: m.text }));

  const parts = channelOrder(ext, bodies)
    .map((ch, i) => {
      const info = ext?.channels.get(ch);
      return makePart(
        i,
        info?.name || `Channel ${ch + 1}`,
        bodies.get(ch),
        Number.isInteger(info?.program) ? info.program : null,
      );
    })
    .filter(nonEmpty)
    .map((p, i) => ({ ...p, index: i }));

  if (!parts.length) warnings.push(i18n.t("mmlIn.noChannel"));
  return { kind: "mml", title, parts, meters, marks, warnings };
}

function mmiMeters(time, changes, warnings) {
  const out = headMeter(time);
  if (!changes.length) return out;

  const ppq = mmiPpqOf(time, changes);
  const scaled = changes.map(c => ({ tick: c.raw * PPQ / ppq, num: c.num, den: c.den }));
  if (scaled.every(c => Number.isInteger(c.tick)) && onBarLines([...out, ...scaled]))
    return [...out, ...scaled];

  warnings.push(i18n.t("mmlIn.timeSigUnreadable"));
  return out;
}

const headMeter = time => {
  const m = /^\s*(\d+)\s*\/\s*(\d+)\s*$/.exec(time ?? "");
  return m ? [{ tick: 0, num: Number(m[1]), den: Number(m[2]) }] : [];
};

function mmiPpqOf(time, changes) {
  if (!changes.length) return 96;
  const head = headMeter(time);
  for (const ppq of [96, 120]) {
    const scaled = changes.map(c => ({ tick: c.raw * PPQ / ppq, num: c.num, den: c.den }));
    if (scaled.some(c => !Number.isInteger(c.tick))) continue;
    if (onBarLines([...head, ...scaled])) return ppq;
  }
  return 96;
}

function onBarLines(list) {
  const sorted = [...list].sort((a, b) => a.tick - b.tick);
  for (let i = 1; i < sorted.length; i++) {
    const prev = sorted[i - 1];
    const span = sorted[i].tick - prev.tick;
    if (span <= 0 || span % meterTicks(prev) !== 0) return false;
  }
  return true;
}

function parseMmi(text) {
  const warnings = [];
  let title = "", time = "";
  const blocks = [];
  const changes = [];
  const rawMarks = [];

  let section = "";
  for (const line of text.split(/\r?\n/)) {
    const sec = /^\s*\[(.+?)\]\s*$/.exec(line);
    if (sec) { section = sec[1].trim().toLowerCase(); continue; }

    const p = kv(line);
    if (!p) continue;
    const [k, v] = p;

    if (section === "marker") {
      if (/^\d+$/.test(k) && v.trim()) rawMarks.push({ raw: Number(k), text: v.trim() });
      continue;
    }
    if (section === "time-signature") {
      const m = /^\d+$/.test(k) ? /^\s*(\d+)\s*\/\s*(\d+)\s*$/.exec(v) : null;
      if (m) changes.push({ raw: Number(k), num: Number(m[1]), den: Number(m[2]) });
      continue;
    }
    if (k === "mml-track") blocks.push({ mml: v, name: "", program: null });
    else if (k === "name" && blocks.length) blocks.at(-1).name = v.trim();
    else if (k === "program" && blocks.length) blocks.at(-1).program = int(v);
    else if (k === "title" && !title) title = v.trim();
    else if (k === "time" && !time) time = v.trim();
  }

  const meters = mmiMeters(time, changes, warnings);
  const mmiPpq = mmiPpqOf(time, changes);
  const marks = rawMarks.map(m => ({ tick: Math.round(m.raw * PPQ / mmiPpq), text: m.text }));

  const parts = [];
  blocks.forEach((b, bi) => {
    const raw = splitMML(b.mml);
    const live = raw.filter(t => bareTrack(t).length > 0).length;
    const name = b.name || `Track${bi + 1}`;
    raw.forEach((t, k) => {
      if (!bareTrack(t).length) return;
      parts.push(makePart(parts.length, live > 1 ? i18n.t("mmlIn.partOf", { name, n: k + 1 }) : name,
        t, b.program));
    });
  });

  if (!parts.length) warnings.push(i18n.t("mmlIn.noMmlTrack"));
  return { kind: "mmi", title, parts, meters, marks, warnings };
}

function parseRaw(text) {
  const raw = splitMML(text);
  const live = raw.filter(t => bareTrack(t).length > 0);
  const parts = [];
  raw.forEach((t, k) => {
    if (!bareTrack(t).length) return;
    parts.push(makePart(parts.length, live.length > 1 ? i18n.t("mmlIn.part", { n: k + 1 }) : "MML", t, null));
  });
  const warnings = parts.length ? [] : [i18n.t("mmlIn.emptyMmlAt")];

  const blocks = (text.match(/mml@/gi) ?? []).length;
  if (blocks > 1)
    warnings.push(i18n.t("mmlIn.multipleMmlAt", { n: blocks }));

  return { kind: "raw", title: "", parts, meters: [], marks: [], warnings };
}

export function parseScore(text) {
  switch (sniff(text)) {
    case "mmi": return parseMmi(text);
    case "mml": return parseMml(text);
    case "raw": return parseRaw(text);
    default:    return null;
  }
}
