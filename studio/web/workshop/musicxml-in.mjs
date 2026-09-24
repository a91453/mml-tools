// Studio Workshop — ported from the owner's earlier frontend (owner-authorized port).
// MusicXML import.
// Workshop edits sit outside the Canonical/verified pipeline and are never evidence.
import { PPQ, CELL_TICKS, chanOf } from "./config.mjs";
import { tempoChanges } from "./mml.mjs";
import * as i18n from "./i18n.mjs";

const GRID = CELL_TICKS;

const DEFAULT_VEL = 68;

const STEP_SEMITONE = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 };

const MAX_WARNINGS = 6;

const BAR_EPS = 0.5;

const MAX_REPEAT_TIMES = 8;

const newStats = () => ({
  graces: 0, tuplets: 0, slurs: 0, ties: 0, straySlurs: 0,
  unclosedSlurs: 0, unclosedTies: 0, repeats: 0, repeatGuessedStart: 0,
  pitchless: 0, measures: 0, badMeasures: 0,
});

export class MusicXmlError extends Error {}

export function parseXml(src) {
  let i = 0;

  const fail = msg => { throw new MusicXmlError(`${msg}（位置 ${i}）`); };
  const ws = () => { while (i < src.length && " \t\r\n".includes(src[i])) i++; };

  const junk = () => {
    for (;;) {
      ws();
      if (src.startsWith("<?", i)) {
        const e = src.indexOf("?>", i); if (e < 0) fail("XML 宣告沒有結束");
        i = e + 2;
      } else if (src.startsWith("<!--", i)) {
        const e = src.indexOf("-->", i); if (e < 0) fail("註解沒有結束");
        i = e + 3;
      } else if (src.startsWith("<!", i)) {
        const sub = src.indexOf("[", i);
        const end = src.indexOf(">", i);
        if (end < 0) fail("DOCTYPE 沒有結束");
        if (sub >= 0 && sub < end) {
          const close = src.indexOf("]", sub); if (close < 0) fail("DOCTYPE 的內部子集沒有結束");
          const e2 = src.indexOf(">", close); if (e2 < 0) fail("DOCTYPE 沒有結束");
          i = e2 + 1;
        } else i = end + 1;
      } else return;
    }
  };

  const unescape = s => (s.includes("&") ? s.replace(
    /&(?:#x([0-9a-fA-F]+)|#(\d+)|(lt|gt|amp|quot|apos));/g,
    (m, hex, dec, name) => hex ? String.fromCodePoint(parseInt(hex, 16))
      : dec ? String.fromCodePoint(Number(dec))
        : { lt: "<", gt: ">", amp: "&", quot: '"', apos: "'" }[name]) : s);

  const name = () => {
    const s = i;
    while (i < src.length && !" \t\r\n/>=".includes(src[i])) i++;
    if (i === s) fail("這裡應該是一個名字");
    return src.slice(s, i);
  };

  const element = () => {
    if (src[i] !== "<") fail("這裡應該是一個標籤");
    i++;
    const tag = name();
    const attrs = {};
    for (;;) {
      ws();
      if (src.startsWith("/>", i)) { i += 2; return { tag, attrs, kids: [], text: "" }; }
      if (src[i] === ">") { i++; break; }
      const k = name();
      ws();
      if (src[i] !== "=") fail(`屬性 ${k} 少了 =`);
      i++; ws();
      const q = src[i];
      if (q !== '"' && q !== "'") fail(`屬性 ${k} 的值沒有引號`);
      i++;
      const e = src.indexOf(q, i); if (e < 0) fail(`屬性 ${k} 的引號沒有結束`);
      attrs[k] = unescape(src.slice(i, e));
      i = e + 1;
    }

    const kids = [];
    let text = "";
    for (;;) {
      const lt = src.indexOf("<", i);
      if (lt < 0) fail(`<${tag}> 沒有結束標籤`);
      text += src.slice(i, lt);
      i = lt;
      if (src.startsWith("</", i)) {
        i += 2;
        const close = name();
        if (close !== tag) fail(`</${close}> 對不上 <${tag}>`);
        ws();
        if (src[i] !== ">") fail(`</${close}> 沒有 >`);
        i++;
        return { tag, attrs, kids, text: unescape(text).trim() };
      }
      if (src.startsWith("<!--", i)) { const e = src.indexOf("-->", i); if (e < 0) fail("註解沒有結束"); i = e + 3; continue; }
      kids.push(element());
    }
  };

  junk();
  if (i >= src.length) throw new MusicXmlError("這個檔案是空的");
  const root = element();
  return root;
}

const kid = (node, tag) => node.kids.find(k => k.tag === tag);

const kidsOf = (node, tag) => node.kids.filter(k => k.tag === tag);

const textOf = (node, tag) => kid(node, tag)?.text;

const intOf = (node, tag, dflt = 0) => {
  const v = Number(textOf(node, tag));
  return Number.isFinite(v) ? Math.round(v) : dflt;
};

function midiOf(note) {
  const p = kid(note, "pitch");
  if (!p) return null;
  const semi = STEP_SEMITONE[(textOf(p, "step") ?? "").toUpperCase()];
  if (semi === undefined) return null;
  const oct = Number(textOf(p, "octave"));
  if (!Number.isFinite(oct)) return null;
  const alter = Number(textOf(p, "alter") ?? 0);
  return (oct + 1) * 12 + semi + (Number.isFinite(alter) ? Math.round(alter) : 0);
}

// A tie (or a same-pitch slur) merges a note into the note that started the
// chain. The merged note is dropped and remembers where it went, so the chain
// head is always the note that is kept.
function chainHead(note) {
  while (note.into) note = note.into;
  return note;
}

function mergeInto(head, note) {
  head = chainHead(head);
  if (head === chainHead(note)) return false;
  if (note.endTick > head.endTick) head.endTick = note.endTick;
  note.dropped = true;
  note.into = head;
  return true;
}

// A note's tie and slur stops are read before its starts, whatever order the
// file lists them in: a note that ends one tie or slur and begins the next
// closes the first before it opens the second.
const stopsFirst = list => [
  ...list.filter(x => x.attrs.type === "stop"),
  ...list.filter(x => x.attrs.type === "start"),
];

function repeatPlan(root, stats, atPieceStart) {
  const parts = kidsOf(root, "part");
  if (!parts.length) return null;

  const starts = new Set();
  const ends = new Map();
  let endings = 0;
  let total = 0;

  for (const part of parts) {
    const ms = kidsOf(part, "measure");
    if (ms.length > total) total = ms.length;
    ms.forEach((m, i) => {
      for (const bl of kidsOf(m, "barline")) {
        if (kid(bl, "ending")) endings++;
        const rep = kid(bl, "repeat");
        if (!rep) continue;
        if (rep.attrs.direction === "forward") starts.add(i);
        else if (rep.attrs.direction === "backward") {
          const t = Math.round(Number(rep.attrs.times));
          ends.set(i, Math.max(ends.get(i) ?? 2,
            Number.isFinite(t) && t >= 2 ? Math.min(t, MAX_REPEAT_TIMES) : 2));
        }
      }
    });
  }
  if (!starts.size && !ends.size) return null;

  const seq = [];
  let from = 0;
  let pending = false;
  let expanded = 0;

  for (let i = 0; i < total; i++) {
    if (starts.has(i)) { from = i; pending = true; }
    seq.push({ i, repeat: false });

    const times = ends.get(i);
    if (times === undefined) continue;

    const guessed = !pending && (from > 0 || atPieceStart);
    if (endings || !(pending || guessed)) stats.repeats++;
    else {
      if (guessed) stats.repeatGuessedStart++;
      for (let r = 1; r < times; r++)
        for (let k = from; k <= i; k++) seq.push({ i: k, repeat: true });
      expanded++;
    }
    from = i + 1;
    pending = false;
  }
  if (pending) stats.repeats++;

  return expanded ? seq : null;
}

function readPart(part, outStats, carriedBeats = 0, plan = null) {
  let divisions = 1;
  const ticks = el => intOf(el, "duration", 0) * PPQ / divisions;
  let quarters = carriedBeats;
  let sigNum = 0, sigDen = 0;
  const meters = [];
  const marks = [];
  let barLen = quarters > 0 ? quarters * PPQ : 0;
  let cursor = 0;
  let lastOnset = 0;
  let length = 0;
  let barStart = 0;
  const lines = new Map();
  const tempos = [];
  const openSlurs = new Map();
  const openTies = new Map();

  const push = (staff, note) => {
    if (!lines.has(staff)) lines.set(staff, []);
    lines.get(staff).push(note);
  };

  const all = kidsOf(part, "measure");
  const seq = plan ?? all.map((_, i) => ({ i, repeat: false }));
  const sink = newStats();

  for (const step of seq) {
    const measure = all[step.i];
    const stats = step.repeat ? sink : outStats;

    if (!measure) {
      if (barLen > 0) { cursor = barStart; barStart += barLen; }
      continue;
    }

    const aligned = barLen > 0 && measure.attrs.implicit !== "yes";
    if (aligned) cursor = barStart;

    const measureStart = cursor;
    let reach = cursor;
    const mark = () => {
      if (cursor > length) length = cursor;
      if (cursor > reach) reach = cursor;
    };

    for (const el of measure.kids) {
      switch (el.tag) {
        case "attributes": {
          const d = intOf(el, "divisions", 0);
          if (d > 0) divisions = d;
          const time = kid(el, "time");
          if (time) {
            const beats = intOf(time, "beats", 0), unit = intOf(time, "beat-type", 0);
            if (beats > 0 && unit > 0) {
              quarters = beats * 4 / unit;
              barLen = quarters * PPQ;
              if (beats !== sigNum || unit !== sigDen) {
                sigNum = beats; sigDen = unit;
                if (!meters.some(x => x.tick === measureStart))
                  meters.push({ tick: measureStart, num: beats, den: unit });
              }
            }
          }
          break;
        }

        case "backup":
          cursor = Math.max(0, cursor - ticks(el));
          break;

        case "forward":
          cursor += ticks(el);
          mark();
          break;

        case "direction": {
          const bpm = Number(kid(el, "sound")?.attrs.tempo);
          if (Number.isFinite(bpm) && bpm > 0) tempos.push({ tick: cursor, bpm });

          const reh = kid(kid(el, "direction-type") ?? { kids: [] }, "rehearsal");
          const text = (reh?.text ?? "").trim();
          if (text && !marks.some(x => x.tick === measureStart))
            marks.push({ tick: measureStart, text });
          break;
        }

        case "sound": {
          const bpm = Number(el.attrs.tempo);
          if (Number.isFinite(bpm) && bpm > 0) tempos.push({ tick: cursor, bpm });
          break;
        }

        case "barline":
          break;

        case "note": {
          const isChord = !!kid(el, "chord");
          const dur = ticks(el);
          const staff = textOf(el, "staff") ?? "1";

          if (kid(el, "grace")) { stats.graces++; break; }

          const onset = isChord ? lastOnset : cursor;
          if (!isChord) lastOnset = cursor;

          if (kid(el, "time-modification")) stats.tuplets++;

          const midi = midiOf(el);
          if (midi === null) {
            if (!kid(el, "rest")) stats.pitchless++;
          } else {
            const note = { ch: 0, tick: onset, endTick: onset + dur, midi, vel: DEFAULT_VEL };
            push(staff, note);

            // A chain's middle note (stop + start) first joins the chain, then
            // passes on its head, so later stops extend the head and a tie
            // over three or more notes keeps its whole length.
            for (const t of stopsFirst([...kidsOf(el, "tie"), ...kidsOf(el, "notations")
              .flatMap(n => kidsOf(n, "tied"))])) {
              const key = `${staff}/${midi}`;
              if (t.attrs.type === "start") openTies.set(key, chainHead(note));
              else {
                const head = openTies.get(key);
                if (head) mergeInto(head, note);
                openTies.delete(key);
              }
            }

            for (const s of stopsFirst(kidsOf(el, "notations").flatMap(n => kidsOf(n, "slur")))) {
              const num = s.attrs.number ?? "1";
              if (s.attrs.type === "start") openSlurs.set(num, { note: chainHead(note), midi, staff });
              else {
                const open = openSlurs.get(num);
                openSlurs.delete(num);
                if (!open) { stats.straySlurs++; continue; }
                if (open.midi === midi && open.staff === staff) {
                  if (mergeInto(open.note, note)) stats.ties++;
                } else stats.slurs++;
              }
            }
          }

          if (!isChord) {
            cursor += dur;
            mark();
          }
          break;
        }

        default:
          break;
      }
    }

    if (barLen > 0 && Math.abs(reach - measureStart - barLen) > BAR_EPS) stats.badMeasures++;
    stats.measures++;

    barStart = barLen > 0 && measure.attrs.implicit !== "yes"
      ? measureStart + barLen
      : reach;
  }

  outStats.unclosedSlurs += openSlurs.size;
  outStats.unclosedTies += openTies.size;

  for (const [staff, notes] of lines) lines.set(staff, notes.filter(n => !n.dropped));

  return { lines, tempos, length, quarters, meters, marks };
}

export function parseMusicXML(pages) {
  const list = Array.isArray(pages) ? pages : [pages];
  if (!list.length) throw new MusicXmlError(i18n.t("musicxmlIn.err.empty"));

  const stats = newStats();

  const lanes = new Map();
  const names = new Map();
  const tempos = [];
  const meters = [];
  const marks = [];
  const carried = new Map();
  let offset = 0;

  for (const [pageIdx, src] of list.entries()) {
    const root = parseXml(String(src));
    if (root.tag !== "score-partwise") {
      throw new MusicXmlError(i18n.t(root.tag === "score-timewise"
        ? "musicxmlIn.err.timewise" : "musicxmlIn.err.notMusicXml"));
    }

    const plan = repeatPlan(root, stats, pageIdx === 0);

    const partNames = new Map();
    for (const sp of kidsOf(kid(root, "part-list") ?? { kids: [] }, "score-part")) {
      partNames.set(sp.attrs.id, textOf(sp, "part-name") || "");
    }
    const title = textOf(kid(root, "work") ?? { kids: [] }, "work-title") || "";

    let pageTicks = 0;
    for (const part of kidsOf(root, "part")) {
      const pid = part.attrs.id ?? "P1";
      const { lines, tempos: pt, length, quarters, meters: pm, marks: pk } =
        readPart(part, stats, carried.get(pid) ?? 0, plan);
      carried.set(pid, quarters);

      const q = t => Math.round(t / GRID) * GRID;

      for (const [staff, notes] of lines) {
        const key = `${pid}/${staff}`;
        if (!lanes.has(key)) {
          lanes.set(key, []);
          const base = partNames.get(pid) || title || pid;
          names.set(key, lines.size > 1 ? `${base} (${staff})` : base);
        }
        const out = lanes.get(key);
        for (const n of notes) {
          const tick = offset + q(n.tick);
          let endTick = offset + q(n.endTick);
          if (endTick <= tick) endTick = tick + GRID;
          out.push({ ...n, tick, endTick });
        }
      }

      for (const e of pt) tempos.push({ tick: offset + q(e.tick), bpm: clampBpm(e.bpm) });
      for (const m of pm) meters.push({ tick: offset + q(m.tick), num: m.num, den: m.den });
      for (const m of pk) marks.push({ tick: offset + q(m.tick), text: m.text });
      pageTicks = Math.max(pageTicks, q(length));
    }
    offset += pageTicks;
  }

  const tracks = [];
  for (const [key, notes] of lanes) {
    notes.sort((a, b) => a.tick - b.tick || a.midi - b.midi);
    tracks.push({ key, name: names.get(key) ?? key, instName: "", notes, programs: new Map(), truncated: false });
  }
  tracks.sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));

  tracks.forEach((tr, idx) => { const ch = chanOf(idx); for (const n of tr.notes) n.ch = ch; });

  if (!tracks.some(t => t.notes.length)) throw new MusicXmlError(i18n.t("musicxmlIn.err.noNotes"));

  return {
    srcPpq: PPQ,
    format: 1,
    tracks,
    tempos: tempoChanges(dedupeTempos(tempos)),
    meters,
    marks,
    warnings: buildWarnings(stats, tempos.length),
  };
}

const clampBpm = bpm => Math.min(255, Math.max(32, Math.round(bpm)));

function dedupeTempos(list) {
  const seen = new Map();
  for (const e of [...list].sort((a, b) => a.tick - b.tick)) seen.set(e.tick, e.bpm);
  return [...seen.entries()].sort((a, b) => a[0] - b[0]).map(([tick, bpm]) => ({ tick, bpm }));
}

function buildWarnings(s, tempoCount) {
  const w = [];
  if (s.badMeasures) w.push(i18n.t("musicxmlIn.warn.badMeasures", { n: s.badMeasures, of: s.measures }));
  if (!tempoCount) w.push(i18n.t("musicxmlIn.warn.noTempo"));
  if (s.ties) w.push(i18n.t("musicxmlIn.warn.tiesMerged", { n: s.ties }));
  if (s.tuplets) w.push(i18n.t("musicxmlIn.warn.tuplets", { n: s.tuplets }));
  if (s.graces) w.push(i18n.t("musicxmlIn.warn.graces", { n: s.graces }));
  if (s.slurs) w.push(i18n.t("musicxmlIn.warn.slurs", { n: s.slurs }));
  if (s.repeats) w.push(i18n.t("musicxmlIn.warn.repeats", { n: s.repeats }));
  if (s.repeatGuessedStart) {
    w.push(i18n.t("musicxmlIn.warn.repeatGuessedStart", { n: s.repeatGuessedStart }));
  }
  if (s.unclosedSlurs + s.unclosedTies + s.straySlurs) {
    w.push(i18n.t("musicxmlIn.warn.unclosed", { n: s.unclosedSlurs + s.unclosedTies + s.straySlurs }));
  }
  if (s.pitchless) w.push(i18n.t("musicxmlIn.warn.pitchless", { n: s.pitchless }));
  if (w.length <= MAX_WARNINGS) return w;
  return [...w.slice(0, MAX_WARNINGS), i18n.t("musicxmlIn.moreWarnings", { n: w.length })];
}
