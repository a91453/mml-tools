// Studio Workshop — ported from the owner's earlier frontend (owner-authorized port).
// Clipboard import/export of whole-song MML.
// Workshop edits sit outside the Canonical/verified pipeline and are never evidence.
import { MAX_TRACKS, GAME_TRACKS, MAX_TRACK_CHARS } from "./config.mjs";
import { $, say } from "./util.mjs";
import { bareTrack, splitMML, stripPrograms, parseAll } from "./mml.mjs";
import { gameSafeTrack, compressMML } from "./mml-compress.mjs";
import { nonstdCount } from "./mml-in.mjs";
import * as tracks from "./tracks.mjs";
import * as i18n from "./i18n.mjs";

let onImport = () => {};
let wrapEdit = fn => fn();

export function exportText() {
  const fixed = [], snapped = [], blocked = [], warnings = [];
  let drift = 0;
  const all = tracks.trackTexts();
  const dropped = all.slice(GAME_TRACKS)
    .map((t, k) => (bareTrack(t) ? GAME_TRACKS + k + 1 : 0))
    .filter(Boolean);

  const preserveTracks = new Set();
  const parts = all.slice(0, GAME_TRACKS).map((t, i) => {
    const bare = stripPrograms(bareTrack(t));
    if (!bare) return "";
    const g = gameSafeTrack(bare);
    if (g.error) { blocked.push(i18n.t("track.withError", { n: i + 1, error: g.error })); return bare; }
    if (g.warning) {
      warnings.push(i18n.t("track.withError", { n: i + 1, error: g.warning }));
      preserveTracks.add(i);
    }
    if (g.snapped) { snapped.push(i + 1); drift += g.drift; }
    else if (g.fixed) fixed.push(i + 1);
    return g.text;
  });
  while (parts.length > 1 && parts[parts.length - 1] === "") parts.pop();

  const src = `MML@${parts.join(",")};`;
  if (blocked.length) return { mml: src, fixed, snapped, drift, blocked, dropped, warnings, saved: 0 };

  const r = compressMML(src, { preserveTracks, verifyWith: s => parseAll(splitMML(s)) });
  const mml = r.mml;
  return { mml, fixed, snapped, drift, blocked, dropped, warnings,
           saved: r.ok === false ? 0 : Math.max(0, src.length - mml.length) };
}

export function importText(src) {
  const parts = splitMML(src);
  if (!parts.some(p => p)) { say(i18n.t("clip.noMml")); return false; }

  const wanted = parts.slice(0, MAX_TRACKS).map(p => {
    const m = /@(\d+)/.exec(p);
    return m ? +m[1] : null;
  });
  const clean = parts.map(stripPrograms);

  const texts = clean;

  const notes = [];
  const nonstd = texts.slice(0, MAX_TRACKS).reduce((n, t) => n + nonstdCount(t), 0);
  if (nonstd) notes.push(i18n.t("clip.nonstd", { n: nonstd }));
  if (parts.length > MAX_TRACKS) notes.push(i18n.t("clip.tooManyTracks", { n: parts.length, max: MAX_TRACKS }));
  const over = texts.slice(0, MAX_TRACKS).filter(p => tracks.effectiveLength(p) > MAX_TRACK_CHARS).length;
  if (over) notes.push(i18n.t("clip.overLimitTracks", { n: over, max: MAX_TRACK_CHARS }));

  wrapEdit(() => {
    tracks.setTexts(texts);
    tracks.reset(texts.length);
    tracks.resetMutes();
  });

  wanted.forEach((p, i) => { if (p !== null) tracks.requestProgram(i, p); });
  tracks.applyPrograms();

  onImport();

  if (notes.length) say(i18n.t("clip.pastedNotes", { list: i18n.clause(notes) }));
  return true;
}

const box = () => $("#pasteBox");
const closeBox = () => { pasteInto = null; box().classList.remove("on"); };

export const showForCopy = text => openBox("out", text);

export function promptPaste(cb) {
  pasteInto = cb ?? null;
  openBox("in");
}

let pasteInto = null;

function initClipBox() {
  const box = $("#clipBox");
  if (!box) return;
  const close = () => box.classList.remove("on");

  $("#clip").addEventListener("click", () => {
    box.classList.add("on");
    $("#paste").focus();
  });
  $("#paste").addEventListener("click", close, { capture: true });
  $("#copy").addEventListener("click", close, { capture: true });

  box.addEventListener("click", e => { if (e.target === box) close(); });
  addEventListener("keydown", e => {
    if (e.key === "Escape" && box.classList.contains("on")
        && !$("#pasteBox").classList.contains("on")) close();
  });
}

function openBox(mode, text = "") {
  const b = box();
  b.dataset.mode = mode;
  b.classList.add("on");
  $("#pasteTitle").textContent = i18n.t(mode === "in" ? "clip.title.in" : "clip.title.out");
  $("#pasteHint").textContent = i18n.t(mode === "in" ? "clip.manualIn" : "clip.manualOut");
  $("#pasteCancel").textContent = i18n.t(mode === "in" ? "common.cancel" : "common.close");
  const ta = $("#pasteText");
  ta.value = text;
  ta.focus();
  if (mode === "out") ta.select();
}

export function init({ onImport: cb, wrapEdit: wrap } = {}) {
  onImport = cb ?? onImport;
  wrapEdit = wrap ?? wrapEdit;

  initClipBox();

  $("#copy").addEventListener("click", async () => {
    const { mml, fixed, snapped, drift, blocked, dropped, warnings, saved } = exportText();
    if (blocked.length) {
      say(i18n.t("clip.blocked", { list: i18n.clause(blocked) }));
      return;
    }
    const notes = [...warnings];
    if (snapped.length)
      notes.push(i18n.t("clip.durSnapped", { list: i18n.list(snapped), drift }));
    if (fixed.length)
      notes.push(i18n.t("clip.doubleDotFixed", { list: i18n.list(fixed) }));
    if (dropped.length)
      notes.push(i18n.t("clip.droppedTracks", {
        list: i18n.list(dropped.map(n => i18n.trackName(n - 1))),
        max: GAME_TRACKS,
      }));
    if (saved > 0) notes.push(i18n.t("clip.compressed", { n: saved }));
    const note = notes.join(" ");
    const sent = Math.min(tracks.trackCount(), GAME_TRACKS);
    try {
      await navigator.clipboard.writeText(mml);
      say(i18n.t("clip.copied", { tracks: sent, chars: mml.length, note }));
    } catch {
      openBox("out", mml);
      if (note) say(note);
    }
  });

  $("#paste").addEventListener("click", async () => {
    try {
      const text = await navigator.clipboard.readText();
    if (!text.trim()) { say(i18n.t("clip.empty")); return; }
      importText(text);
    } catch {
      openBox("in");
    }
  });

  $("#pasteCancel").addEventListener("click", closeBox);
  $("#pasteOk").addEventListener("click", () => {
    const v = $("#pasteText").value;
    const into = pasteInto;
    closeBox();
    if (!v.trim()) return;
    if (into) into(v);
    else importText(v);
  });
  box().addEventListener("click", e => { if (e.target === box()) closeBox(); });
  addEventListener("keydown", e => {
    if (e.key === "Escape" && box().classList.contains("on")) closeBox();
  });
}
