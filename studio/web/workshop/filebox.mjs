// Studio Workshop — ported from the owner's earlier frontend (owner-authorized port).
// File dialog: MIDI / MML / MMI / MusicXML import and export.
// Workshop edits sit outside the Canonical/verified pipeline and are never evidence.
import {
  MAX_TRACKS, MIN_TRACKS, GAME_TRACKS, MAX_TRACK_CHARS, HARD_TRACK_CHARS,
} from "./config.mjs";
import { $, say, slotToIndex, gridSlotAt } from "./util.mjs";
import { toMIDI } from "./midi-out.mjs";
import * as meters from "./meters.mjs";
import * as marks from "./marks.mjs";
import {
  parseSMF, inventory, buildImport, fileOrigin, shiftToOrigin, trimWarnings, VOICE_LANES, MidiError,
} from "./midi-in.mjs";
import { parseScore } from "./mml-in.mjs";
import { parseMusicXML, MusicXmlError } from "./musicxml-in.mjs";
import { toMml, toMmi, safeFileName, stripExt } from "./mml-out.mjs";
import * as tracks from "./tracks.mjs";
import * as i18n from "./i18n.mjs";
import * as release from "./release.mjs";

let onImport = () => {};
let onMix = () => {};
let onClear = () => {};
let onNew = () => {};
let wrapEdit = fn => fn();
let getSong = () => null;

let rows = [];

let kind = "midi";

let append = false;

let appendAt = 0;

let origin = 0;

let tempos = [];
let fileMeters = [];
let fileMarks = [];

let srcName = "";

const fileBox = () => $("#fileBox");
const midiBox = () => $("#midiBox");

// The labels are looked up when the list is drawn, not when this module is
// evaluated: main.mjs switches to the page language only after every module
// has loaded, so a module-level lookup would always read Traditional Chinese.
const MODES = ["melody", "root", "both", "voices", "all"];

const modeLabels = () => ({
  melody: i18n.t("fileBox.mode.melody"),
  root:   i18n.t("fileBox.mode.root"),
  both:   i18n.t("fileBox.mode.both"),
  voices: i18n.t("fileBox.mode.voices", { n: VOICE_LANES }),
  all:    i18n.t("fileBox.mode.all", { n: MAX_TRACKS }),
});

const MODE_COST = { both: 2, voices: VOICE_LANES, all: MAX_TRACKS };

const cost = row => (row.on ? (MODE_COST[row.mode] ?? 1) : 0);

const budget = () => MAX_TRACKS - (append ? appendAt : 0);

const PICK_LIMIT = MAX_TRACKS;

function pickAll(on) {
  rows.forEach((r, i) => { r.on = on && i < PICK_LIMIT; });
}

function syncPickAll() {
  const box = $("#pickAll");
  if (!box) return;
  const full = rows.length > 0 && rows.every((r, i) => r.on === (i < PICK_LIMIT));
  box.checked = full;
  box.indeterminate = !full && rows.some(r => r.on);
}

const nameField = () => $("#expName");

export const songName = () => nameField()?.value ?? "";
export const setSongName = v => { const el = nameField(); if (el) el.value = v; };

function download(data, mime, ext) {
  const blob = new Blob([data], { type: mime });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = `${safeFileName(nameField()?.value)}.${ext}`;
  a.click();
  URL.revokeObjectURL(a.href);
}

function save() {
  const song = getSong();
  if (!song) return;

  const fmt = $("#expFmt")?.value ?? "mid";
  if (fmt === "mid") {
    download(toMIDI(song, tracks.programs(), meters.stored(), marks.stored()), "audio/midi", "mid");
    return;
  }

  const texts = tracks.trackTexts();
  const title = (nameField()?.value ?? "").trim();
  const text = fmt === "mml"
    ? toMml(texts, { title, programs: tracks.programs(), meters: meters.stored(), marks: marks.stored() })
    : toMmi(texts, {
      title, programs: tracks.programs(),
      bpm: song.tempos?.[0]?.bpm ?? 120, meters: meters.stored(), marks: marks.stored(),
    });
  download(text, "text/plain;charset=utf-8", fmt);

  if (fmt === "mml" && meters.stored().some(m => m.tick > 0))
    say(i18n.t("fileBox.savedMmlMeters"));

  if (fmt === "mmi" && texts.length > GAME_TRACKS)
    say(i18n.t("fileBox.savedMmi", { n: texts.length }));
}

let hasNotes = false;
let bankReady = false;

export const setHasNotes = has => {
  hasNotes = has;
  const b = $("#expGo"); if (b) b.disabled = !has;
  syncMedia();
};

export const setBankReady = ok => { bankReady = ok; syncMedia(); };

function syncMedia() {
  const title = !bankReady ? i18n.t("fileBox.mixNeedBank")
              : !hasNotes ? i18n.t("fileBox.mixEmptyScore")
              : "";
  for (const id of ["#mixGo", "#videoOpen"]) {
    const b = $(id);
    if (!b) continue;
    b.disabled = !hasNotes || !bankReady;
    b.title = title;
  }
}

const showErr = msg => {
  const el = $("#fileErr");
  el.textContent = msg;
  el.hidden = false;
};
const clearErr = () => { $("#fileErr").hidden = true; };

// Each read() takes a number; one that finishes after a newer read() began
// is dropped, so the list shown is always the last file chosen.
let reads = 0;

async function read(file) {
  if (!file) return;
  const token = ++reads;
  clearErr();
  srcName = file.name ?? "";

  let buf;
  try {
    buf = new Uint8Array(await file.arrayBuffer());
  } catch (err) {
    if (token === reads) showErr(i18n.t("fileBox.readFailed", { msg: err.message }));
    return;
  }
  if (token !== reads) return;

  if (buf.length >= 4 && buf[0] === 0x4d && buf[1] === 0x54 && buf[2] === 0x68 && buf[3] === 0x64)
    return readMidi(buf, file.name);

  // Compressed MusicXML (.mxl) is a ZIP archive, whatever the file is called.
  if (buf.length >= 4 && buf[0] === 0x50 && buf[1] === 0x4b && buf[2] === 0x03 && buf[3] === 0x04)
    return readMxl(buf, file.name, token);

  const head = new TextDecoder("utf-8").decode(buf.subarray(0, 2048));
  if (/<score-(partwise|timewise)\b/.test(head) || /\.(musicxml|xml)$/i.test(file.name ?? ""))
    return readXml(new TextDecoder("utf-8").decode(buf), file.name);

  return readText(buf, file.name);
}

function readMidi(buf, name) {
  let smf, list;
  try {
    smf = parseSMF(buf);
    list = inventory(smf);
  } catch (err) {
    showErr(err instanceof MidiError ? err.message
      : i18n.t("fileBox.readFailed", { msg: err.message }));
    return;
  }
  if (!list.length) { showErr(i18n.t("fileBox.noNotes")); return; }

  const notes = [...smf.warnings];
  if (smf.format === 2)
    notes.push(i18n.t("fileBox.format2"));

  kind = "midi";
  rows = list.map(r => ({ ...r, on: false, mode: "melody" }));
  tempos = smf.tempos;
  useFileTimeline(list, smf);

  fileBox().classList.remove("on");
  openList(name, notes);
}

// The lanes are written from the file's origin (the bar holding its first
// note), so its meters and marks are moved onto the same clock.
function useFileTimeline(list, smf) {
  origin = fileOrigin(list, smf.meters ?? []);
  fileMeters = shiftToOrigin(smf.meters, origin);
  fileMarks = shiftToOrigin(smf.marks, origin);
}

function readText(buf, name) {
  let text = new TextDecoder("utf-8").decode(buf);
  if (/^\s*Encoding\s*=\s*big5\s*$/im.test(text)) {
    try { text = new TextDecoder("big5").decode(buf); }
    catch {  }
  }

  const r = parseScore(text);
  if (!r) {
    showErr(i18n.t("fileBox.unknownFile"));
    return;
  }
  if (!r.parts.length) { showErr(r.warnings[0] ?? i18n.t("fileBox.noNotes")); return; }

  kind = "mml";
  rows = r.parts.map(p => ({
    ...p,
    on: false,
    label: r.kind === "mml"
      ? [p.label, tracks.programName(p.program)].filter(Boolean).join(" · ")
      : p.label,
  }));
  tempos = [];
  fileMeters = r.meters ?? [];
  fileMarks = r.marks ?? [];
  origin = 0;

  const label = r.title ? `${name} · ${r.title}` : name;
  fileBox().classList.remove("on");
  openList(label, r.warnings);
}

// Compressed MusicXML (.mxl): the same container reader Studio's intake uses
// finds the score inside; it is loaded only when an archive is picked. The
// score then reads like a .musicxml.
async function readMxl(buf, name, token) {
  if (release.blocked()) return;
  let xml;
  try {
    const { extractMusicXmlFromMxl } = await import("../../backend/score/mxl.mjs");
    xml = extractMusicXmlFromMxl(buf).xml;
  } catch (err) {
    if (token === reads) showErr(i18n.t("fileBox.notMxl", { msg: err.message }));
    return;
  }
  if (token !== reads) return;
  return readXml(xml, name);
}

// Local MusicXML (uncompressed score-partwise), read in this browser only.
function readXml(text, name) {
  let smf, list;
  try {
    smf = parseMusicXML([text]);
    list = inventory(smf);
  } catch (err) {
    showErr(err instanceof MusicXmlError ? err.message
      : i18n.t("fileBox.readFailed", { msg: err.message }));
    return;
  }
  if (!list.length) { showErr(i18n.t("fileBox.noNotes")); return; }

  kind = "midi";
  rows = list.map(r => ({ ...r, on: false, mode: "melody" }));
  tempos = smf.tempos;
  useFileTimeline(list, smf);

  fileBox().classList.remove("on");
  openList(stripExt(name), [...smf.warnings]);
}

function openList(name, notes) {
  $("#midiName").textContent = notes.length
    ? i18n.t("fileBox.midiName", { name, list: i18n.clause(notes) })
    : name;
  const midi = kind === "midi";
  $("#midiBox").dataset.kind = kind;
  $("#colMode").hidden = !midi;
  $("#colUnit").textContent = midi ? i18n.t("fileBox.colChannel") : i18n.t("fileBox.colUnit");
  $("#midiHint").hidden = !midi;
  $("#mmlHint").hidden = midi;
  append = false;
  syncAppend();

  $("#pickAll")?.setAttribute("aria-label", i18n.t("fileBox.pickAllAria", { max: PICK_LIMIT }));
  pickAll(true);
  renderRows();
  midiBox().classList.add("on");
  $("#midiOk").focus();
}

function renderRows() {
  const tb = $("#midiRows");
  tb.textContent = "";
  const labels = modeLabels();
  for (const row of rows) {
    const tr = document.createElement("tr");
    tr.classList.toggle("on", row.on);

    const cb = document.createElement("input");
    cb.type = "checkbox";
    cb.checked = row.on;
    cb.setAttribute("aria-label", i18n.t("fileBox.importAria", { label: row.label }));

    const setOn = v => {
      row.on = v;
      cb.checked = v;
      tr.classList.toggle("on", v);
      syncFoot();
    };

    cb.addEventListener("change", () => setOn(cb.checked));

    tr.addEventListener("click", e => {
      if (e.target === cb || e.target.closest("select")) return;
      setOn(!row.on);
    });

    tr.append(
      cell(cb), cell(String(row.index + (kind === "midi" ? 0 : 1)), "n"),
      cell(nameCell(row), "name"),
      cell(String(kind === "midi" ? row.noteCount : row.notes), "cnt"));

    if (kind === "midi") {
      const sel = document.createElement("select");
      for (const v of MODES) {
        const o = document.createElement("option");
        o.value = v; o.textContent = labels[v];
        sel.appendChild(o);
      }
      sel.value = row.mode;
    sel.title = i18n.t("fileBox.modeTitle");
      sel.addEventListener("change", () => { row.mode = sel.value; syncFoot(); });
      tr.append(cell(sel));
    }
    tb.appendChild(tr);
  }
  syncFoot();
}

function cell(content, cls) {
  const td = document.createElement("td");
  if (cls) td.className = cls;
  if (typeof content === "string") td.textContent = content;
  else td.appendChild(content);
  return td;
}

function nameCell(row) {
  const span = document.createElement("span");
  span.append(row.label);
  const tag = (text, title, cls = "") => {
    const el = document.createElement("span");
    el.className = `drum ${cls}`.trim();
    el.textContent = text;
    el.title = title;
    span.appendChild(el);
  };

  if (row.melody === "melody")
    tag(i18n.t("fileBox.tag.melody"), i18n.t("fileBox.tag.melodyTitle"), "lead");
  else if (row.melody === "chords")
    tag(i18n.t("fileBox.tag.chords"), i18n.t("fileBox.tag.chordsTitle"));
  if (row.drum)
    tag(i18n.t("fileBox.tag.drum"), i18n.t("fileBox.tag.drumTitle"));
  if (row.readonly)
    tag(i18n.t("fileBox.tag.readonly"),
      i18n.t("fileBox.tag.readonlyTitle", { why: row.readonly }));
  if (row.nonstd)
    tag(i18n.t("fileBox.tag.nonstd", { n: row.nonstd }),
      i18n.t("fileBox.tag.nonstdTitle"));
  if (row.chars > MAX_TRACK_CHARS)
    tag(i18n.t("fileBox.tag.chars", { n: row.chars }),
      i18n.t("fileBox.tag.charsTitle", { max: MAX_TRACK_CHARS }));
  if (row.chars > HARD_TRACK_CHARS)
    tag(i18n.t("fileBox.tag.willCut"),
      i18n.t("fileBox.tag.willCutTitle", { max: HARD_TRACK_CHARS }));
  return span;
}

function syncFoot() {
  const n = rows.reduce((a, r) => a + cost(r), 0);
  const room = budget();
  const over = n > room;
  const el = $("#midiCount");

  const cap = append ? i18n.t("fileBox.capLeft", { n: room })
                     : i18n.t("fileBox.capTotal", { n: MAX_TRACKS });
  let text = over ? i18n.t("fileBox.pickedOver", { n, cap, extra: n - room })
                  : i18n.t("fileBox.picked", { n, cap });
  if (over && rows.some(r => r.on && r.mode === "all"))
    text += append && room < MAX_TRACKS
      ? i18n.t("fileBox.allNoRoom", { max: MAX_TRACKS })
      : i18n.t("fileBox.allTakesAll", { max: MAX_TRACKS });

  el.textContent = text;
  el.classList.toggle("over", over);
  $("#midiOk").disabled = n === 0 || over;
  syncPickAll();
}

function syncAppend() {
  appendAt = tracks.appendAt();
  for (const el of document.querySelectorAll("#midiMode input[name=impMode]"))
    el.checked = (el.value === "append") === append;

  const wipes = !append && appendAt > 0;

  const hint = $("#midiAppendHint");
  if (hint) {
    hint.hidden = !append && !wipes;
    hint.classList.toggle("warn", wipes);
    if (wipes)
      hint.textContent = i18n.t("fileBox.wipeHint");
    else if (append)
      hint.textContent = appendAt
        ? i18n.t("fileBox.appendHint", { from: appendAt + 1, keep: appendAt })
        : i18n.t("fileBox.appendEmpty");
  }

  const ok = $("#midiOk");
  if (ok) {
    ok.classList.toggle("danger", wipes);
    ok.textContent = i18n.t(wipes ? "fileBox.okWipe" : "fileBox.okImport");
  }

  syncFoot();
}

function newSong() {
  wrapEdit(() => {
    tracks.setTexts([]);
    tracks.reset(MIN_TRACKS);
    tracks.resetMutes();
    meters.set([]);
    marks.set([]);
  });
  tracks.resetInstruments();
  setSongName("");
  onClear();
  onNew();
  fileBox().classList.remove("on");
  say(i18n.t("fileBox.newed", { n: MIN_TRACKS }));
}

function clearAll() {
  wrapEdit(() => {
    tracks.setTexts([]);
    tracks.reset(MIN_TRACKS);
    tracks.resetMutes();
  });
  onClear();
  fileBox().classList.remove("on");
    say(i18n.t("fileBox.cleared", { n: MIN_TRACKS }));
}

const frame = () => new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));

function makeTexts(picked, at) {
  if (kind === "midi") {
    const song = getSong();
    return buildImport(picked.map(r => ({
      notes: r.notes, mode: r.mode, drum: r.drum, label: r.label,
    })), tempos, {
      origin, append: at > 0, existingTempos: song?.tempos ?? [], base: at,
    });
  }

  const warnings = [];

  const nonstd = picked.reduce((n, r) => n + (r.nonstd ?? 0), 0);
  if (nonstd) warnings.push(i18n.t("fileBox.warn.nonstd", {
    n: nonstd, tracks: picked.filter(r => r.nonstd).length,
  }));

  const ro = picked.filter(r => r.readonly).length;
  if (ro) warnings.push(i18n.t("fileBox.warn.readonly", { n: ro }));
  const over = picked.filter(r => r.chars > MAX_TRACK_CHARS).length;
  if (over) warnings.push(i18n.t("fileBox.warn.overLimit", { n: over, max: MAX_TRACK_CHARS }));
  const cut = picked.filter(r => r.chars > HARD_TRACK_CHARS).length;
  if (cut) warnings.push(i18n.t("fileBox.warn.cut", { n: cut, max: HARD_TRACK_CHARS }));
  if (at > 0 && picked.some(r => /t\s*\d/i.test(r.text)))
    warnings.push(i18n.t("fileBox.warn.tempoInAppend"));

  return { texts: picked.map(r => r.text), warnings: trimWarnings(warnings) };
}

async function doImport() {
  const picked = rows.filter(r => r.on);
  if (!picked.length) return;

  const at = append ? appendAt : 0;

  const busy = $("#midiBusy");
  if (busy) busy.hidden = false;
  await frame();

  let texts, warnings;
  try {
    ({ texts, warnings } = makeTexts(picked, at));
  } finally {
    if (busy) busy.hidden = true;
  }
  midiBox().classList.remove("on");

  wrapEdit(() => {
    tracks.setTexts(texts, at);
    if (at === 0 && fileMeters.length) meters.set(fileMeters);
    if (at === 0 && fileMarks.length) marks.set(fileMarks);
    tracks.reset(at + texts.length, at);
    tracks.resetMutes(at, at + texts.length);
  });

  tracks.resetInstruments(at, at + texts.length);
  if (kind === "mml") {
    let any = false;
    picked.forEach((r, i) => {
      if (r.program === null || r.program === undefined) return;
      tracks.requestProgram(at + i, r.program);
      any = true;
    });
    if (any) tracks.applyPrograms();
  }

  onImport();

  const nf = nameField();
  if (nf && srcName) nf.value = stripExt(srcName);

  const head = at > 0
    ? i18n.t("fileBox.appended",
        { n: texts.length, from: at + 1, to: at + texts.length })
    : i18n.t("fileBox.imported", { n: texts.length });
  const tail = texts.length > GAME_TRACKS
    ? i18n.t("fileBox.beyondGame", { n: GAME_TRACKS + 1 })
    : "";
  say(warnings.length
    ? i18n.t("fileBox.sayWithWarnings",
        { head, warnings: i18n.clause(warnings), tail })
    : i18n.t("fileBox.sayLine", { head, tail }));
}

export function init({ onImport: cb, onClear: clear, onNew: fresh,
                       wrapEdit: wrap, getSong: song, onMix: mix, onVideo: video } = {}) {
  onImport = cb ?? onImport;
  onClear = clear ?? onImport ?? onClear;
  onNew = fresh ?? onNew;
  wrapEdit = wrap ?? wrapEdit;
  getSong = song ?? getSong;
  onMix = mix ?? onMix;
  const onVideo = video ?? (() => false);

  const fb = fileBox(), mb = midiBox();
  if (!fb || !mb) return;

  $("#file").addEventListener("click", () => {
    clearErr();
    fb.classList.add("on");
  });

  $("#mixGo").addEventListener("click", () => {
    if (onMix()) fb.classList.remove("on");
  });
  $("#videoOpen")?.addEventListener("click", () => {
    if (onVideo()) fb.classList.remove("on");
  });

  $("#newSong").addEventListener("click", newSong);
  $("#clearAll").addEventListener("click", clearAll);

  // #midFile has no accept list: iPhone/iPad grey out an .xml they do not map
  // to one. read() routes by content, as it does for a dropped file.
  $("#midFile").addEventListener("change", e => {
    const f = e.target.files[0];
    e.target.value = "";
    read(f);
  });

  $("#expGo").addEventListener("click", () => { fb.classList.remove("on"); save(); });

  nameField()?.addEventListener("keydown", e => {
    if (e.key !== "Enter") return;
    e.preventDefault();
    if ($("#expGo")?.disabled) return;
    fb.classList.remove("on");
    save();
  });

  const card = fb.querySelector(".card");
  fb.addEventListener("dragover", e => { e.preventDefault(); card.classList.add("drop"); });
  fb.addEventListener("dragleave", e => {
    if (e.target === fb || !fb.contains(e.relatedTarget)) card.classList.remove("drop");
  });
  fb.addEventListener("drop", e => {
    e.preventDefault();
    card.classList.remove("drop");
    read(e.dataTransfer?.files?.[0]);
  });

  $("#midiCancel").addEventListener("click", () => {
    mb.classList.remove("on");
  });
  $("#midiOk").addEventListener("click", doImport);

  for (const el of document.querySelectorAll("#midiMode input[name=impMode]"))
    el.addEventListener("change", () => { append = el.value === "append"; syncAppend(); });

  $("#pickAll")?.addEventListener("change", e => {
    pickAll(e.target.checked);
    renderRows();
  });

  for (const box of [fb, mb])
    box?.addEventListener("click", e => {
      if (e.target !== box) return;
      box.classList.remove("on");
    });

  addEventListener("keydown", e => {
    if (e.key !== "Escape") return;
    if (mb.classList.contains("on")) mb.classList.remove("on");
    else if (fb.classList.contains("on")) fb.classList.remove("on");
  });
}
