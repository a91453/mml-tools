// Studio Workshop — ported from the owner's earlier frontend (owner-authorized port).
// Wiring of the workshop page.
// Workshop edits sit outside the Canonical/verified pipeline and are never evidence.
import { restoreStandard, nonstdCount } from "./mml-in.mjs";

import {
  MAX_TRACKS, GAME_TRACKS, MAX_TRACK_CHARS,
  RULER_H, ROW_H, GUTTER_W, MIN_ROLL_OCTAVES, KEY_SIGS, keyPitches, chanOf, AUDITION_CH,
  PPQ, barIndexOf, barStartTick, barTicksAt, meterAt, meterTicks, meterName,
  markColor, clampMarkText, textWidth, MARK_WIDTH, MAX_MARKS,
  markPillWidths, isPillTab, markDotX, ZIP_LOSSLESS,
} from "./config.mjs";
import { $, say } from "./util.mjs";
import * as i18n from "./i18n.mjs";
import {
  parseAll, bareTrack, makeClock, makeInverseClock, stripTempos, tempoChanges, velChanges,
} from "./mml.mjs";
import {
  trackToItems, itemsToMML, reflow, repairItems, encoderNums,
  OPT_RULES, optimizeTrack, sameOnsets, sameEvents, zipOnce,
} from "./mml-compress.mjs";
import {
  insertNote, deleteNote, moveNote, moveNotes, transpose, noteKey,
  mergeTracks, notesInRange, MERGE_MODES,
  placeTempos, splitForTempos, tempoCrossings, velocityStats, shiftVelocities,
  setVelocities, placeVelocity, insertTime, deleteTime, lastNoteEnd,
  notesToItems, pasteItems, velocitiesOf, findNote, totalTicks,
  dotNotes,
} from "./rolledit.mjs";
import * as rollmenu from "./rollmenu.mjs";
import * as theme from "./theme.mjs";
import * as mediakeys from "./mediakeys.mjs";
import * as history from "./history.mjs";
import { parseDef, pickLocale, selectPresets, isKit, soundingKey, bankPreset } from "./instruments.mjs";
import * as engine from "./engine.mjs";
import * as player from "./player.mjs";
import * as roll from "./pianoroll.mjs";
import * as tracks from "./tracks.mjs";
import * as meters from "./meters.mjs";
import * as marks from "./marks.mjs";
import * as clipboard from "./clipboard.mjs";
import * as filebox from "./filebox.mjs";
import * as savebox from "./savebox.mjs";
import * as select from "./select.mjs";
import * as storage from "./storage.mjs";
import { setIcon } from "./icons.mjs";
import * as studio from "./studio-bridge.mjs";
import * as release from "./release.mjs";
import * as bankStore from "../preview/soundbank-store.mjs";
import { GameStyleBankError, loadGameStyleBank, loadGameStyleDef } from "../preview/game-style-bank.mjs";
import { buildRoles, withSelection, renderHTML, runAt, MAX_HL_CHARS } from "./mml-highlight.mjs";

let rawPresets = [];
let presets    = [];
let filterNote = "";
let bankLabel  = "";
let bankBuiltin = false;
// The synth holds the game-style bank: Mobile instruments play its own presets.
let bankGameStyle = false;
let defLabel   = "";
let defBuiltin = false;
let defMap     = new Map();
let defNames   = new Map();

const hintDefaults = new Map();

function rememberHintDefaults() {
  for (const id of ["#dlsName", "#defName"]) {
    const el = $(id);
    if (el) hintDefaults.set(id, el.textContent);
  }
}

const resetHint = id => { const el = $(id); if (el) el.textContent = hintDefaults.get(id) ?? ""; };

// The bank the synth holds, as the label names it; empty when none is named.
const namedBank = () => (!bankLabel || bankBuiltin ? "" :
  i18n.t("ui.bankLabel", { bank: bankLabel, n: presets.length })
  + (filterNote ? i18n.t("ui.filterNoteWrap", { note: filterNote }) : ""));

function updateHints() {
  if (!bankLabel || bankBuiltin) resetHint("#dlsName");
  else $("#dlsName").textContent = namedBank();

  if (!defLabel || defBuiltin) { resetHint("#defName"); return; }
  const matched = rawPresets.length ? presets.filter(p => defMap.has(p.program)).length : null;
  $("#defName").textContent = i18n.t("ui.defLabel", { def: defLabel, n: defMap.size })
    + (matched === null ? "" : i18n.t("ui.defMatched", { matched }));
}

function applyDef(buf, name, builtin) {
  const { map, locales, lines } = parseDef(buf);
  if (!map.size) {
    if (!builtin) $("#defName").textContent = i18n.t("ui.defUnknown", { name, lines });
    return false;
  }
  defMap = map;
  defNames = pickLocale(locales);
  defLabel = name;
  defBuiltin = !!builtin;
  fillPresets();
  updateHints();
  return true;
}

function setPresets(list) { rawPresets = list || []; fillPresets(); }

function fillPresets() {
  const { kept, note } = selectPresets(rawPresets, defMap);
  presets = kept;
  filterNote = note;
  tracks.fillInstruments(presets, defMap, defNames, bankLabel.split(" · ")[0]);
}

let bankFile = null;

// Bank loads run one at a time, and a load only runs while nothing newer
// was asked for, so the synth, the label and the bank store end on the last
// choice. A pick takes its number the moment it is made, before any file is
// read; the stored bank read at boot counts as older than any pick: otherwise
// a slow boot load finishing last would replace the bank just chosen.
let bankQueue = Promise.resolve();
let bankPicks = 0;
function queueBank(task) {
  const run = bankQueue.then(task);
  bankQueue = run.catch(() => {});
  return run;
}

async function loadBank(buf, name, builtin = false, file = null, { gameStyle = false } = {}) {
  const { list, mb } = await engine.loadBank(buf);
  bankGameStyle = gameStyle;
  bankLabel = `${name} · ${mb} MB`;
  setPresets(list);
  bankBuiltin = !!builtin;
  bankFile = file;
  updateHints();
  $("#play").disabled = $("#stop").disabled = false;
  filebox.setBankReady(true);
  tracks.enableInstruments();
  applyMutes();
  // Programs are bank-specific (bankPreset): a bank changed mid-play re-selects them.
  if (player.isPlaying()) applyInstruments(tracks.trackTexts().map((_, i) => i));
}

let selRanges = [];

function syncRangesFromNative() {
  const ta = tracks.activeArea();
  selRanges = ta && ta.selectionEnd > ta.selectionStart
    ? [[ta.selectionStart, ta.selectionEnd]] : [];
}

function selectedNotes(track) {
  if (!track) return [];
  const seen = new Set(), out = [];
  for (const [a, b] of selRanges) {
    for (const n of select.notesIn(track, a, b)) {
      const k = select.key(n.tick, n.midi);
      if (seen.has(k)) continue;
      seen.add(k);
      out.push(n);
    }
  }
  return out;
}

function syncSelection(origin = null) {
  paintHighlight();

  const ta = tracks.activeArea();
  const track = song?.tracks[tracks.activeTrack()];
  if (!ta || !track) { roll.setSelection([]); roll.setCaret(null); return; }

  const notes = selectedNotes(track);
  roll.setSelection(notes.map(n => ({ tick: n.tick, midi: n.midi })));

  if (sounding()) { roll.setCaret(null); return; }

  const at = ta.selectionDirection === "backward" ? ta.selectionStart : ta.selectionEnd;
  const tick = select.tickAt(track, at);
  roll.setCaret(tick);

  if (origin === "text" && tick !== null) roll.reveal(tick);
}

let progSel = 0;

let quietFocus = 0;

function quietly(fn) {
  quietFocus++;
  try { fn(); } finally { setTimeout(() => { quietFocus = Math.max(0, quietFocus - 1); }, 0); }
}

function focusRoll() {
  $("#stage")?.focus({ preventScroll: true });
}

function setRange(ta, a, b, origin) {
  setRanges(ta, b > a ? [[a, b]] : [], origin, [a, b]);
}

function setRanges(ta, ranges, origin, primary = null) {
  if (!ta) return;
  selRanges = ranges;
  const p = primary ?? ranges[ranges.length - 1] ?? [ta.selectionStart, ta.selectionStart];
  progSel++;
  ta.setSelectionRange(p[0], p[1]);
  setTimeout(() => { progSel = Math.max(0, progSel - 1); }, 0);

  if (origin === "roll" || origin === "play") select.reveal(ta, p[0]);
  syncSelection(origin === "text" ? "text" : null);
}

function pickNote(n) {
  const ta = tracks.activeArea();
  if (!ta) return;
  if (!n) {
    setRange(ta, ta.selectionStart, ta.selectionStart, null);
    return;
  }
  setRange(ta, n.srcStart, n.srcEnd, "roll");
}

function pickGhost({ ch, note }) {
  tracks.selectTrack(ch);
  pickNote(note);
}

function pickRange({ from, to }) {
  const ta = tracks.activeArea();
  const track = song?.tracks[tracks.activeTrack()];
  const r = select.rangeOf(track, [from, to]);
  if (!ta || !r) return;
  setRange(ta, r[0], r[1], "roll");
}

function jumpToText(n) {
  const ta = tracks.activeArea();
  if (!ta) return;
  ta.focus();
  setRange(ta, n.srcEnd, n.srcEnd, "roll");
}

function reselect(picks) {
  const ta = tracks.activeArea();
  const track = song?.tracks[tracks.activeTrack()];
  const rs = select.rangesOf(track, picks);
  if (!ta || !rs.length) return;
  setRanges(ta, rs, null);
}

function setPicks(picks) {
  const ta = tracks.activeArea();
  const track = song?.tracks[tracks.activeTrack()];
  if (!ta || !track) return;
  const at = ta.selectionDirection === "backward" ? ta.selectionStart : ta.selectionEnd;
  setRanges(ta, select.rangesOf(track, picks), null, [at, at]);
}

function togglePick(n) {
  const ta = tracks.activeArea();
  const track = song?.tracks[tracks.activeTrack()];
  if (!ta || !track) return;

  const k = select.key(n.tick, n.midi);
  const cur = selectedNotes(track).map(x => ({ tick: x.tick, midi: x.midi }));
  const had = cur.some(x => select.key(x.tick, x.midi) === k);
  const next = had
    ? cur.filter(x => select.key(x.tick, x.midi) !== k)
    : [...cur, { tick: n.tick, midi: n.midi }];

  const mine = had ? null : select.rangesOf(track, [{ tick: n.tick, midi: n.midi }])[0] ?? null;
  setRanges(ta, select.rangesOf(track, next), null, mine);
}

let auditionMidi = -1, auditionTimer = null;

function auditionStart(midi, vel) {
  auditionOff();
  engine.resume();
  engine.unmute();
  const p = soundPreset(tracks.activeTrack());
  if (p) engine.selectProgram(AUDITION_CH, p[0], p[1], p[2], isKit(p));
  auditionMidi = soundingKey(p, midi);
  engine.noteOn(AUDITION_CH, auditionMidi, vel, engine.now());
}

function auditionOn(midi) {
  auditionStart(midi, 100);
}

function auditionNote(midi, sec, vel) {
  if (!(sec > 0)) return;
  auditionStart(midi, vel);
  auditionTimer = setTimeout(auditionOff, sec * 1000);
}

function auditionOff() {
  clearTimeout(auditionTimer);
  auditionTimer = null;
  if (auditionMidi < 0) return;
  engine.noteOff(AUDITION_CH, auditionMidi, engine.now());
  auditionMidi = -1;
}

// A track's instrument as the loaded bank plays it (instruments.bankPreset):
// what the synth, the key mapping and the offline render all use.
const soundPreset = t => bankPreset(tracks.presetOf(t), { gameStyle: bankGameStyle });

function applyInstruments(trackIdx) {
  if (!presets.length) return;
  for (const t of trackIdx) {
    const p = soundPreset(t);
    if (p) engine.selectProgram(chanOf(t), p[0], p[1], p[2], isKit(p));
  }
}

// The bank for offline rendering: exactly the bytes the synth was loaded
// with, whether picked here or read from Studio's local bank store at boot
// (preview/soundbank-store.mjs), so an export renders the bank the page names
// even after another tab or an overtaken pick changed what the store keeps.
// The store itself is read only when no such copy exists. Never a URL.
const bankSource = () => (rawPresets.length
  ? (bankFile ? { kind: "file", file: bankFile } : { kind: "store" })
  : null);

function applyMutes() {
  const flags = tracks.mutedFlags();
  for (const [t, on] of flags.entries()) engine.setChannelMute(chanOf(t), on);
}

let song = null;

export function refresh() {
  let p;
  try { p = parseAll(tracks.trackTexts()); }
  catch (e) { say(i18n.t("ui.parseFailed", { msg: e.message })); return null; }
  if (player.isPaused()) pausedDirty = true;
  song = p;
  roll.setSong(p);
  roll.setActive(tracks.activeTrack());
  syncEditable();
  syncSelection();
  const count = p.tracks.reduce((a, t) => a + t.notes.length, 0);
  const mm = Math.floor(p.duration / 60), ss = Math.floor(p.duration % 60);

  tracks.setNoteCounts(p.tracks.map(t => t.notes.length));

  const bpm = p.tempos.length
    ? p.tempos.map(e => e.bpm).join(" → ") + (p.tempos.length > 1 ? "" : " BPM")
    : i18n.t("ui.defaultBpm");

  const st = $("#status");
  st.children[0].innerHTML = i18n.t("ui.stat.tracks",
    { n: tracks.trackCount(), max: MAX_TRACKS });
  st.children[1].innerHTML = i18n.t("ui.stat.notes", { n: count });
  st.children[2].innerHTML = i18n.t("ui.stat.tempo", { bpm });
  st.children[3].innerHTML = i18n.t("ui.stat.length",
    { mm, ss: String(ss).padStart(2, "0") });
  $("#warn").className = p.warnings.length ? "bad" : "";
  $("#warn").textContent = p.warnings.length ? p.warnings.slice(0, 2).join(" · ") : "";
  filebox.setHasNotes(count > 0);
  savebox.setHasNotes(count > 0);
  syncBarRuler();
  return p;
}

const hhmm = ms => new Date(ms).toLocaleTimeString(i18n.getLocale(), { hour12: false, hour: "2-digit", minute: "2-digit" });

let lastSavedAt = null, lastSavedVerb = i18n.t("ui.saved");

function showStore(at, verb = i18n.t("ui.saved")) {
  lastSavedAt = at;
  lastSavedVerb = verb;
  renderStore();
}

function renderStore() {
  const broken = storage.isBroken();
  $("#status").classList.toggle("store-failed", broken);
  $("#storeState").classList.toggle("bad", broken);
  $("#storeRetry").hidden = !broken || !storage.isAutosaveOn();
  $("#storeState").textContent = broken
    ? i18n.t("ui.store.broken")
    : !storage.isAutosaveOn() ? i18n.t("ui.store.off")
    : lastSavedAt ? i18n.t("ui.store.at",
        { verb: lastSavedVerb, time: hhmm(lastSavedAt) })
    : i18n.t("ui.store.never");
}

function syncAutosaveUI() {
  const on = storage.isAutosaveOn();
  $("#autosave").value = on ? "on" : "off";
  renderStore();
}

function initAutosave() {
  $("#storeRetry").addEventListener("click", () => {
    tracks.persist();
    say(i18n.t(storage.flush() ? "ui.store.recovered" : "ui.store.failed"));
  });
  $("#autosave").addEventListener("change", e => {
    const on = e.target.value === "on";
    storage.setAutosave(on);
    if (on) { tracks.persist(); storage.flush(); }
    syncAutosaveUI();
  });
  syncAutosaveUI();
}

function syncTransport() {
  $("#play").textContent = player.isPaused() ? i18n.t("ui.play.resume")
    : player.isPlaying() ? i18n.t("ui.play.pause")
    : i18n.t("ui.play.play");
  mediakeys.setState(!player.isPlaying() ? "stopped"
    : player.isPaused() ? "paused" : "playing");
}

function playRange(parsed) {
  const { fromTick, toTick } = roll.playRange();
  if (fromTick === null && toTick === null) return null;
  const clock = makeClock(parsed.tempos);
  return {
    fromSec: fromTick === null ? 0 : clock(fromTick),
    toSec: toTick === null ? Infinity : clock(toTick),
  };
}

function onRangeChange(cause) {
  if (!player.isPlaying()) return;
  const snapshot = player.state().song;
  if (!snapshot) return;
  const toStart = cause === "start";
  player.setRange(playRange(snapshot), { toStart });

  if (toStart && player.isPaused()) {
    pausedTick = roll.playRange().fromTick ?? 0;
    roll.setGuideFloor(pausedTick);
  }
}

function highlightPlaying(it) {
  if (!it) return;
  const ta = tracks.activeArea();
  if (ta) setRange(ta, it.srcStart, it.srcEnd, "play");
}

let selBeforePlay = null;

function sounding() { return player.isPlaying() && !player.isPaused(); }

let pausedDirty = false;

let pausedTick = null;

function enterPause() {
  const sec = player.positionSec();
  const snap = player.state().song;
  pausedTick = sec === null || !snap ? null : makeInverseClock(snap.tempos)(sec);
  pausedDirty = false;
  roll.setGuideFloor(pausedTick);
  tracks.setReadOnly(false);
  syncSelection();
}

function leavePause() {
  if (song) {
    const atSec = pausedTick === null ? 0 : makeClock(song.tempos)(pausedTick);
    player.reload(song, atSec, playRange(song));
  }
  if (pausedDirty && song) {
    applyInstruments(song.tracks.map((_, i) => i));
    applyMutes();
    selBeforePlay = captureSel();
  }
  pausedDirty = false;
  pausedTick = null;
  auditionOff();
  player.resume();
  tracks.setReadOnly(true);
  syncSelection();
  roll.wake();
}

function captureSel() {
  const ta = tracks.activeArea();
  return ta ? { ch: tracks.activeTrack(), ranges: selRanges.map(r => [...r]) } : null;
}

function onPlayClick() {
  if (player.isPlaying()) {
    if (player.isPaused()) leavePause();
    else { player.pause(); enterPause(); }
  } else {
    const parsed = refresh();
    if (!parsed || !parsed.duration) return;
    const ta = tracks.activeArea();
    selBeforePlay = captureSel();
    if (!overlayActive(ta)) ta?.focus();
    auditionOff();
    rollmenu.close();
    applyInstruments(parsed.tracks.map((_, i) => i));
    applyMutes();
    player.start(parsed, playRange(parsed));
    tracks.setReadOnly(true);
    roll.kick();
  }
  syncTransport();
}

function initLoop() {
  const b = $("#loopBtn");
  b.addEventListener("click", () => {
    const on = !player.isLooping();
    player.setLoop(on);
    b.classList.toggle("on", on);
    b.setAttribute("aria-pressed", String(on));
  });
}

function initHome() {
  const a = $("#home");
  if (!a) return;
  a.addEventListener("click", e => {
    if (e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0) return;
    storage.clear();
  });
}

function initKeySig() {
  const sel = $("#keysig");
  if (!sel) return;
  KEY_SIGS.forEach((k, i) => {
    const o = document.createElement("option");
    o.value = String(i);
    o.textContent = i18n.keySigLabel(i);
    sel.appendChild(o);
  });
  sel.addEventListener("change", () => {
    const k = KEY_SIGS[+sel.value];
    roll.setKey(sel.value === "" || !k ? null : keyPitches(k.root));
  });
}

function onStopped() {
  tracks.setReadOnly(false);
  roll.stop();
  if (pausedDirty) selBeforePlay = null;
  if (selBeforePlay && selBeforePlay.ch === tracks.activeTrack()) {
    setRanges(tracks.activeArea(), selBeforePlay.ranges, "roll");
  }
  selBeforePlay = null;
  pausedDirty = false;
  pausedTick = null;
  syncTransport();
}

function spaceIsOurs(t) {
  if (!(t instanceof HTMLElement)) return true;
  if (t.id === "play" || t.id === "stop") return true;
  if (t.closest("#stage")) return true;
  return !t.closest("button, a[href], input, select, textarea, [tabindex], [contenteditable]");
}

const songEndTick = () =>
  Math.max(0, ...(song?.tracks ?? []).map(t => t.endTick ?? 0));

const headTick = () => roll.guideTick();

function tickPlusBars(tick, n) {
  let t = tick;
  for (let i = Math.abs(n); i > 0; i--)
    t += n > 0 ? barTicksAt(t) : -barTicksAt(barStartTick(barIndexOf(t)) - 1);
  return t;
}

function moveHead(tick) {
  if (tick === null || !Number.isFinite(tick)) return;
  const { fromTick, toTick } = roll.playRange();
  const lo = fromTick ?? 0;
  const hi = Math.max(lo, toTick ?? songEndTick());
  const to = Math.min(Math.max(Math.round(tick), lo), hi);

  if (player.isPaused()) {
    if (to === pausedTick) return;
    pausedTick = to;
    roll.setGuideFloor(to);
  } else {
    const snap = player.state().song;
    if (!snap) return;
    if (!player.seekTo(makeClock(snap.tempos)(to))) return;
    roll.setGuideFloor(to);
  }
  roll.reveal(to);
}

function onTransportKey(e) {
  if (e.ctrlKey || e.altKey || e.metaKey || e.shiftKey) return;

  if (e.repeat) return;

  if (document.querySelector(".modal.on, .drawer.on, #rollMenu")) return;

  if (roll.editing(e.target) || roll.isDragging()) return;

  if (e.key === " ") {
    if (!spaceIsOurs(e.target)) return;
    if ($("#play").disabled) return;
    e.preventDefault();
    onPlayClick();
    return;
  }

  if (!player.isPlaying()) return;

  switch (e.key) {
    case "ArrowLeft":  moveHead(tickPlusBars(headTick(), -1)); break;
    case "ArrowRight": moveHead(tickPlusBars(headTick(), +1)); break;
    case "ArrowUp":    moveHead(roll.playRange().fromTick ?? 0); break;
    case "ArrowDown":  player.stop(); break;
    default: return;
  }
  e.preventDefault();
}

// The line is shown as HTML (say), and an error can quote a file's own bytes
// (a damaged bank's chunk name, bank-check.mjs), so its message is escaped.
const escHtml = v => String(v ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

export function describe(err, headline) {
  const s = err.step
    ? i18n.t("ui.stepWrap", { step: i18n.t(`engine.step.${err.step}`) })
    : "";
  let hint;
  if (/worklet/i.test(err.message) || err.step === "worklet")
    hint = i18n.t("error.hint.worklet");
  else if (err.step === "lib")
    hint = i18n.t("error.hint.lib");
  else if (err.step === "ctx")
    hint = i18n.t("error.hint.ctx");
  else
    hint = i18n.t("error.hint.generic");
  return i18n.t("ui.errorLine", { headline, step: s, msg: escHtml(err.message), hint });
}

// The sound bank is the one the user keeps in Studio Web's local bank store
// (the same store the Studio timbre preview reads); without one, the
// game-style bank when it was chosen and this device keeps it. Nothing is
// fetched.
// It is asked for at boot, before the user can pick anything, so it is older
// than every pick: once any bank has been picked it is never applied, not
// even when the pick came while the engine was still booting and its own
// store write has not finished (or failed), leaving the older bank in the
// store for this read to find.
export async function loadStoredBank() {
  const picked = () => bankPicks > 0;
  if (picked()) return;
  let stored = null;
  try { stored = await bankStore.loadBank(); }
  catch (err) { console.warn("[Workshop] stored bank:", err); }
  if (!stored) return loadKeptGameStyle(picked);
  // A copy of the bytes the synth gets, taken before they are handed over, is
  // what an export renders (bankSource).
  try { await queueBank(() => picked() ? undefined : loadBank(stored.bytes, stored.name, false, new Blob([stored.bytes]))); }
  catch (err) {
    console.warn("[Workshop] stored bank failed to load:", err);
    // Said on the page, as a failed pick is, unless a pick has been made
    // since: that pick's own label and message are the ones shown.
    if (picked()) return;
    $("#dlsName").textContent = i18n.t("ui.bankFailed");
    say(describe(err, i18n.t("ui.bankLoadError")));
  }
}

// The game-style bank the site serves (game-style-bank.mjs), with its own
// instrument list for the names and the whitelist. Studio's players remember
// the same choice under this key (app.mjs); a bank of the user's own still
// comes first at boot.
const PRESET_BANK_KEY = "mml-studio-preset-bank";
const gameStyleChosen = () => { try { return localStorage.getItem(PRESET_BANK_KEY) === "game-style"; } catch { return false; } };
const chooseGameStyle = () => { try { localStorage.setItem(PRESET_BANK_KEY, "game-style"); } catch { /* this page only */ } };
const gameStyleMessage = err => i18n.t(err?.code === "GAME_STYLE_BANK_ABSENT" ? "ui.gameStyleAbsent"
  : err?.code === "GAME_STYLE_BANK_MISMATCH" ? "ui.gameStyleMismatch" : "ui.gameStyleDownloadFailed");

async function useGameStyle(bank, def) {
  const name = i18n.t("ui.gameStyleName");
  // A copy for exports, taken before the synth gets the bytes (bankSource).
  await loadBank(bank.bytes, name, false, new Blob([bank.bytes]), { gameStyle: true });
  applyDef(def, name, true);
}

// Kept on this device and chosen before: used at boot without a download.
async function loadKeptGameStyle(picked) {
  if (!gameStyleChosen()) return;
  let bank = null, def = null;
  try { [bank, def] = await Promise.all([loadGameStyleBank({ keptOnly: true }), loadGameStyleDef({ keptOnly: true })]); }
  catch (err) { console.warn("[Workshop] game-style bank:", err); }
  if (!bank || !def || picked()) return;
  try { await queueBank(() => picked() ? undefined : useGameStyle(bank, def)); }
  catch (err) {
    console.warn("[Workshop] game-style bank failed to load:", err);
    if (picked()) return;
    $("#dlsName").textContent = i18n.t("ui.bankFailed");
    say(describe(err, i18n.t("ui.gameStyleLoadError")));
  }
}

let warnedComments = false;
let warnedTooLong = false;
let warnedDropped = false;
let warnedPlainFallback = false;

let pendingPlainFallback = false;

function genPlain(items, opts) {
  const stats = {};
  const out = itemsToMML(items, { ...opts, plain: true, stats });
  if (stats.plainFallback) pendingPlainFallback = true;
  return out;
}

function prepTrack(text) {
  pendingPlainFallback = false;
  const t = trackToItems(text);
  if (t.error) return { error: t.error };
  const opts = genOpts(t.seenNums);
  const { issues, drift } = repairItems(t.items, opts);
  return { items: t.items, opts, dropped: t.dropped, issues, drift };
}

const finish = (items, opts) => genPlain(repairItems(items, opts).items, opts);

function syncEditable() {
  const i = tracks.activeTrack();
  const p = prepTrack(tracks.trackTexts()[i] ?? "");
  if (p.error) {
    roll.setBadNotes([], [], "");
    roll.setNonstd(0);
    roll.setEditable(false, i18n.t("ui.roll.readonly", { why: p.error }));
    return;
  }
  roll.setEditable(true, "");

  const { issues, drift } = p;
  const keys = issues.flatMap(x => x.keys);

  const bars = new Set();
  for (const x of issues) {
    const last = barIndexOf(x.tick + Math.max(1, x.from) - 1);
    for (let b = barIndexOf(x.tick); b <= last; b++) bars.add(b);
  }

  const by = k => issues.filter(x => x.kind === k);
  const durs = by("dur"), nonstd = by("nonstd");
  const both = (list, what) => {
    const notes = list.filter(x => x.keys.length).length;
    const rests = list.length - notes;
    return [notes && i18n.t("ui.count.notes", { n: notes }),
            rests && i18n.t("ui.count.rests", { n: rests })]
      .filter(Boolean).join(i18n.t("ui.count.and")) + what;
  };

  const msg = [];
  if (durs.length)
    msg.push(both(durs, i18n.t("ui.bad.duration",
      { sign: drift > 0 ? "+" : "", drift })));
  if (nonstd.length) msg.push(both(nonstd, i18n.t("ui.bad.nonstd")));

  roll.setBadNotes(keys, bars,
    msg.length ? i18n.t("ui.bad.red", { list: i18n.clause(msg) }) : "");

  roll.setNonstd(nonstd.length, !!tracks.zipOf(i));
}

function fixNonstd() {
  const i = tracks.activeTrack();
  const before = tracks.trackTexts()[i] ?? "";
  const r = restoreStandard(before);
  if (!r.changed || r.text === before) { say(i18n.t("ui.nonstd.nothing")); return; }

  const n = nonstdCount(before) - nonstdCount(r.text);
  writeBack(i, r.text, before);
  say(i18n.t("ui.nonstd.done", { n }));
}

function addNote({ tick, dur, midi }) {
  const i = tracks.activeTrack();
  const text = tracks.trackTexts()[i] ?? "";

  const p = prepTrack(text);
  if (p.error) { say(i18n.t("ui.roll.cantEdit", { why: p.error })); return false; }

  const out = finish(insertNote(p.items, tick, dur, midi), p.opts);
  if (out === null) { say(i18n.t("ui.roll.cantEncode")); return false; }

  writeBack(i, out, text);
  return true;
}

function removeNote({ tick, midi }) {
  const i = tracks.activeTrack();
  const text = tracks.trackTexts()[i] ?? "";

  const p = prepTrack(text);
  if (p.error) { say(i18n.t("ui.roll.cantEdit", { why: p.error })); return false; }

  const items = deleteNote(p.items, tick, midi);
  const out = finish(items, p.opts);
  if (out === null) { say(i18n.t("ui.roll.cantEncode")); return false; }
  if (out === bareTrack(text)) return false;

  writeBack(i, out, text);
  return true;
}

function removeNotes(picks) {
  const i = tracks.activeTrack();
  const text = tracks.trackTexts()[i] ?? "";

  const p = prepTrack(text);
  if (p.error) { say(i18n.t("ui.roll.cantEdit", { why: p.error })); return false; }

  let items = p.items;
  for (const n of picks) items = deleteNote(items, n.tick, n.midi);
  const out = finish(items, p.opts);
  if (out === null) { say(i18n.t("ui.roll.cantEncode")); return false; }
  if (out === bareTrack(text)) return false;

  const at = selRanges.length ? selRanges[0][0] : null;
  writeBack(i, out, text);
  const ta = tracks.activeArea();
  if (ta && at !== null) {
    const c = Math.min(at, ta.value.length);
    setRanges(ta, [], null, [c, c]);
  }
  return true;
}

function selectAllLane() {
  const ta = tracks.activeArea();
  if (!ta || !ta.value.length) return;
  setRange(ta, 0, ta.value.length, null);
}

const isLaneArea = el => !!el && el === tracks.activeArea();

function duplicateSelection(at) {
  const text = pickedFragment();
  if (!text) return;
  pasteAt(at, text, { internal: true });
}

function relocateNote({ from, to }) {
  const i = tracks.activeTrack();
  const text = tracks.trackTexts()[i] ?? "";

  const p = prepTrack(text);
  if (p.error) { say(i18n.t("ui.roll.cantEdit", { why: p.error })); return false; }

  const items = moveNote(p.items, from, to);
  if (!items) return false;

  const out = finish(items, p.opts);
  if (out === null) { say(i18n.t("ui.roll.cantEncode")); return false; }

  writeBack(i, out, text);
  return true;
}

function relocateNotes({ picks, dTick, dMidi }) {
  const i = tracks.activeTrack();
  const text = tracks.trackTexts()[i] ?? "";

  const p = prepTrack(text);
  if (p.error) { say(i18n.t("ui.roll.cantEdit", { why: p.error })); return false; }

  const items = moveNotes(p.items, picks, dTick, dMidi);
  if (!items) return false;

  const out = finish(items, p.opts);
  if (out === null) { say(i18n.t("ui.roll.cantEncode")); return false; }

  writeBack(i, out, text);
  reselect(picks.map(p => ({ tick: p.tick + dTick, midi: p.midi + dMidi })));
  return true;
}

let barsPerLine = 0;

const genOpts = seenNums => ({
  barsPerLine,
  dropTrailingRests: true,
  ...(seenNums ? { allowedNums: encoderNums(seenNums) } : {}),
});

function lineStartTicks(track, text) {
  const lines = text.split("\n");
  if (!track) return lines.map(() => null);

  const ns = track.notes, rs = track.rests ?? [];
  let i = 0, j = 0;
  const out = [];
  let at = 0;

  for (const line of lines) {
    for (;;) {
      const a = i < ns.length ? ns[i] : null;
      const b = j < rs.length ? rs[j] : null;
      if (!a && !b) { out.push(track.endTick); break; }
      const take = !b || (a && a.srcStart <= b.srcStart) ? a : b;
      if (take.srcEnd > at) { out.push(take.tick); break; }
      if (take === a) i++; else j++;
    }
    at += line.length + 1;
  }
  return out;
}

function syncBarRuler() {
  const gut = tracks.activeGutter();
  if (!gut) return;
  const inner = gut.firstElementChild;

  if (!barsPerLine || !song) { inner.textContent = ""; gut.scrollTop = 0; return; }

  const i = tracks.activeTrack();
  const text = tracks.trackTexts()[i] ?? "";
  const ticks = lineStartTicks(song.tracks[i], text);
  inner.textContent = ticks.map(t => {
    if (t == null) return "";
    const bar = barIndexOf(t) + 1;
    return (t === barStartTick(bar - 1) ? "" : "~") + bar;
  }).join("\n");
  syncTextLayerScroll();
}

function syncTextLayerScroll() {
  const ta = tracks.activeArea();
  if (!ta) return;
  const gut = tracks.activeGutter();
  if (gut) gut.firstElementChild.style.transform = `translateY(${-ta.scrollTop}px)`;
  const hl = tracks.activeOverlay();
  if (hl) hl.style.transform = `translate(${-ta.scrollLeft}px,${-ta.scrollTop}px)`;
}

let highlightOn = storage.loadUI()?.highlight !== false;

let hlEl = null, hlSrc = null, hlRoles = null, hlHtml = null;

const HL_API = typeof CSS !== "undefined" && !!CSS.highlights && typeof Highlight === "function";

const SEL_HL = "mml-sel";

let hlNodes = null;

function indexTextNodes(root) {
  const nodes = [], starts = [];
  let at = 0;
  const walk = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  for (let n = walk.nextNode(); n; n = walk.nextNode()) {
    nodes.push(n);
    starts.push(at);
    at += n.data.length;
  }
  return { nodes, starts, end: at };
}

function nodeAt(tbl, i) {
  const { run, offset } = runAt(tbl.starts, tbl.end, i);
  return { node: tbl.nodes[run], offset };
}

function paintSelHighlight() {
  if (!HL_API) return;
  if (!hlNodes || !hlNodes.nodes.length || !selRanges.length) {
    CSS.highlights.delete(SEL_HL);
    return;
  }
  const h = new Highlight();
  for (const [a, b] of selRanges) {
    if (b <= a) continue;
    const s = nodeAt(hlNodes, a), e = nodeAt(hlNodes, b);
    const r = document.createRange();
    r.setStart(s.node, s.offset);
    r.setEnd(e.node, e.offset);
    h.add(r);
  }
  if (h.size) CSS.highlights.set(SEL_HL, h);
  else CSS.highlights.delete(SEL_HL);
}

function dropSelHighlight() {
  hlNodes = null;
  if (HL_API) CSS.highlights.delete(SEL_HL);
}

const overlayActive = ta => !!ta && ta.value.length <= MAX_HL_CHARS;

function syncOverlayWidth() {
  const ta = tracks.activeArea(), hl = tracks.activeOverlay();
  if (!ta || !hl || ta.clientWidth <= 0) return;
  const w = ta.clientWidth + "px";
  if (hl.style.width !== w) hl.style.width = w;
}

function paintHighlight() {
  const ta = tracks.activeArea(), hl = tracks.activeOverlay();
  if (!hl) return;
  const on = overlayActive(ta);
  document.body.classList.toggle("hl-off", !on);
  if (!on) { hl.textContent = ""; hlEl = null; dropSelHighlight(); return; }

  const src = ta.value;
  const fresh = src !== hlSrc || hl !== hlEl;
  if (fresh) { hlSrc = src; hlRoles = buildRoles(src, highlightOn); }

  if (HL_API) {
    if (fresh) {
      hl.innerHTML = renderHTML(src, hlRoles);
      hlEl = hl;
      hlNodes = indexTextNodes(hl);
    }
    paintSelHighlight();
  } else {
    const html = renderHTML(src, withSelection(hlRoles, selRanges));
    if (html !== hlHtml || hl !== hlEl) { hl.innerHTML = html; hlHtml = html; hlEl = hl; }
  }
  syncOverlayWidth();
  syncTextLayerScroll();
}

function initTheme() {
  const sel = $("#theme");
  if (!sel) return;
  sel.value = theme.current();
  sel.addEventListener("change", () => theme.apply(sel.value));
}

function initHighlight() {
  const sel = $("#mmlHighlight");
  sel.value = highlightOn ? "on" : "off";
  sel.addEventListener("change", () => {
    highlightOn = sel.value === "on";
    storage.saveUI({ highlight: highlightOn });
    hlSrc = null;
    paintHighlight();
  });
}

function reformatAll() {
  const list = [];
  for (const [i, before] of tracks.trackTexts().entries()) {
    const out = reflow(before, barsPerLine);
    if (out === before) continue;
    list.push({ i, out, before });
  }
  if (!list.length) return;
  writeBackMany(list);
  refresh();
}

function formatInitialTracks() {
  if (!barsPerLine || tracks.restoredAt()) return;
  for (const [i, before] of tracks.trackTexts().entries()) {
    const out = reflow(before, barsPerLine);
    if (out !== before) tracks.setTrackText(i, out);
  }
}

const barChoices = () => new Set([...$("#barsPerLine").options].map(o => Number(o.value)));

function setBarsPerLine(n, reformat) {
  if (!barChoices().has(n) || n === barsPerLine) return;
  barsPerLine = n;
  $("#barsPerLine").value = String(n);
  storage.saveUI({ barsPerLine });
  applyWrapMode();
  if (reformat) reformatAll();
  syncBarRuler();
}

function onExternalText() {
  if (player.isPlaying()) {
    selBeforePlay = null;
    player.stop();
  }
  setBarsPerLine(0, false);
  savebox.detach();
  studio.clearOrigin();
  refresh();
}

function initTimeSig() {
  const sel = $("#timeSig");
  if (!sel) return;
  sel.value = meters.isOn() ? "on" : "off";
  roll.setTimeSigUI(meters.isOn());

  meters.setChangeHandler(() => {
    roll.setTimeSigUI(meters.isOn());
    tracks.persist();
    refresh();
  });

  sel.addEventListener("change", () => withMeterEdit(() => meters.setOn(sel.value === "on")));
}

function reflowForMeter() {
  if (!barsPerLine) return;
  for (const [i, before] of tracks.trackTexts().entries()) {
    const out = reflow(before, barsPerLine);
    if (out !== before) tracks.setTrackText(i, out);
  }
}

function withMeterEdit(fn) {
  history.edit(() => { fn(); reflowForMeter(); });
}

function initBarsPerLine() {
  const sel = $("#barsPerLine");
  const saved = Number(storage.loadUI()?.barsPerLine);
  barsPerLine = barChoices().has(saved) ? saved : 0;
  sel.value = String(barsPerLine);
  applyWrapMode();

  sel.addEventListener("change", () => setBarsPerLine(Number(sel.value), true));
}

function applyWrapMode() {
  document.body.classList.toggle("wrapmml", barsPerLine > 0);
}

function zipFinal(i, plain) {
  if (!tracks.zipOf(i)) return { out: plain };
  const r = zipOnce(plain, genOpts());
  if (r.out) return { out: r.out };
  if (r.bug) return { out: plain, drop: true,
    msg: i18n.t("ui.opt.zipVerifyFailed", { track: i18n.trackName(i) }) };
  return { out: plain };
}

function writeBack(i, out, before, { raw = false } = {}) {
  const z = raw ? { out } : zipFinal(i, out);
  history.edit(() => {
    if (z.drop) tracks.setZip(i, null);
    tracks.setTrackText(i, z.out);
  });
  warnAfterWrite(i, z.out, before);
  if (z.msg) say(z.msg);
  return true;
}

function writeBackMany(list, also = null) {
  const zs = list.map(w => (w.raw ? { out: w.out } : zipFinal(w.i, w.out)));
  history.edit(() => {
    for (let k = 0; k < list.length; k++)
      if (zs[k].drop) tracks.setZip(list[k].i, null);
    for (let k = 0; k < list.length; k++) tracks.setTrackText(list[k].i, zs[k].out);
    also?.();
    tracks.persist();
  });
  for (let k = 0; k < list.length; k++)
    warnAfterWrite(list[k].i, zs[k].out, list[k].before);
  for (const z of zs) if (z.msg) say(z.msg);
}

function warnAfterWrite(i, out, before) {
  const fellBack = pendingPlainFallback;
  pendingPlainFallback = false;
  if (fellBack && !warnedPlainFallback && !tracks.zipOf(i)) {
    warnedPlainFallback = true;
    say(i18n.t("ui.roll.plainFallback"));
  }

  if (!warnedComments && /\/\*|\/\//.test(before)) {
    warnedComments = true;
    say(i18n.t("ui.roll.regenWarn"));
  }

  if (!warnedDropped && trackToItems(before).dropped > 0) {
    warnedDropped = true;
    say(i18n.t("ui.roll.droppedBadChars"));
  }

  if (!warnedTooLong && bareTrack(out).length > MAX_TRACK_CHARS) {
    warnedTooLong = true;
    say(i18n.t("ui.roll.overLimit", { max: MAX_TRACK_CHARS }));
  }
}

const barOf = tick => barIndexOf(tick);

const scopeTracks = scope =>
  scope === "song"
    ? Array.from({ length: tracks.trackCount() }, (_, i) => i)
    : [tracks.activeTrack()];

function trackBusyAfter(i, at) {
  const p = prepTrack(tracks.trackTexts()[i] ?? "");
  if (p.error) return false;
  return lastNoteEnd(p.items) > at;
}

const busyTracks = (scope, at) => scopeTracks(scope).filter(i => trackBusyAfter(i, at));

function barsLeft(scope, at) {
  let end = 0;
  for (const i of scopeTracks(scope)) {
    const p = prepTrack(tracks.trackTexts()[i] ?? "");
    if (!p.error) end = Math.max(end, lastNoteEnd(p.items));
  }
  return end > at ? barIndexOf(end - 1) - barIndexOf(at) + 1 : 0;
}

function barEdit({ insert, scope, at, bars }) {
  const len = barStartTick(barIndexOf(at) + bars) - at;
  const targets = busyTracks(scope, at);
  if (!targets.length || !(len > 0)) return;

  const texts = tracks.trackTexts();
  const writes = [];
  for (const i of targets) {
    const text = texts[i] ?? "";
    const p = prepTrack(text);
    if (p.error) { say(i18n.t("ui.roll.cantEdit", { why: p.error })); return; }

    const items = insert ? insertTime(p.items, at, len) : deleteTime(p.items, at, len);
    const out = finish(items, p.opts);
    if (out === null) { say(i18n.t("ui.roll.cantEncode")); return; }
    if (out === bareTrack(text)) continue;
    writes.push({ i, out, before: text });
  }
  if (!writes.length) return;

  const delta = insert ? len : -len;

  writeBackMany(writes, scope !== "song" ? null : () => {
    if (meters.remap(at, delta)) reflowForMeter();
    marks.remap(at, delta);
  });

  roll.remapMarks(at, delta);
  shiftPausedTick(at, delta);
  pickNote(null);
}

function shiftPausedTick(at, delta) {
  if (pausedTick === null) return;
  const next = delta > 0
    ? (pausedTick >= at ? pausedTick + delta : pausedTick)
    : (pausedTick >= at - delta ? pausedTick + delta : Math.min(pausedTick, at));
  if (next === pausedTick) return;
  pausedTick = next;
  roll.setGuideFloor(pausedTick);
}

function sideNotes(at, before) {
  const notes = song?.tracks[tracks.activeTrack()]?.notes ?? [];
  return notes.filter(n => before ? n.tick < at : n.tick >= at);
}

function selectSide(at, before) {
  const ta = tracks.activeArea();
  const track = song?.tracks[tracks.activeTrack()];
  const r = select.rangeOf(track, sideNotes(at, before));
  if (!ta || !r) return;
  setRange(ta, r[0], r[1], "roll");
}

const menuPicks = () => roll.selectedNotes();

function pickedFragment() {
  const p = prepTrack(tracks.trackTexts()[tracks.activeTrack()] ?? "");
  if (p.error) return "";
  const vel = velocitiesOf(p.items);
  const notes = [];
  for (const pick of menuPicks()) {
    const found = findNote(p.items, pick.tick, pick.midi);
    if (found) notes.push({ tick: found.tick, dur: found.dur, midi: pick.midi,
                            vel: vel.get(found.tick) ?? 8 });
  }
  if (!notes.length) return "";
  return genPlain(notesToItems(notes), p.opts) ?? "";
}

async function copyPicked() {
  const text = pickedFragment();
  if (!text) { say(i18n.t("ui.roll.copyNone")); return false; }
  try {
    await navigator.clipboard.writeText(text);
    say(i18n.t("ui.roll.copied", { n: menuPicks().length }));
  } catch {
    clipboard.showForCopy(text);
  }
  return true;
}

async function cutPicked() {
  const picks = menuPicks().map(p => ({ tick: p.tick, midi: p.midi }));
  if (!await copyPicked()) return;
  removeNotes(picks);
}

function pasteAt(at, text, { internal = false } = {}) {
  const i = tracks.activeTrack();
  const target = tracks.trackTexts()[i] ?? "";
  const p = prepTrack(target);
  if (p.error) { say(i18n.t("ui.roll.cantEdit", { why: p.error })); return; }

  if (!internal) {
    const n = nonstdCount(text);
    if (n) say(i18n.t("clip.nonstd", { n }));
  }
  const frag = trackToItems(text);
  if (frag.error) { say(i18n.t("ui.roll.pasteBad")); return; }
  if (frag.dropped > 0) { say(i18n.t("ui.roll.pasteJunk", { n: frag.dropped })); return; }

  const r = pasteItems(p.items, at, frag.items);
  if (r.block === "empty") { say(i18n.t("ui.roll.pasteEmpty")); return; }

  const out = genPlain(r.items, { ...p.opts,
    allowedNums: [...new Set([...(p.opts.allowedNums ?? []), ...frag.seenNums])],
  });
  if (out === null) { say(i18n.t("ui.roll.cantEncode")); return; }
  const pasted = [];
  let tick = at;
  for (const item of frag.items) {
    if (item.k === "note") pasted.push({ tick, midi: item.midi });
    if (item.k === "note" || item.k === "rest") tick += item.dur;
  }
  const end = at + lastNoteEnd(frag.items);
  const overwritten = (song?.tracks[i]?.notes ?? []).filter(n => n.tick < end && n.tick + n.durTick > at).length;
  writeBack(i, out, target);
  reselect(pasted);
  say(i18n.t("ui.roll.pasted", { n: countNotes(frag.items) })
    + " " + i18n.t("roll.duplicate.overwritten", { n: overwritten }));
  return true;
}

async function pasteFromMenu(at) {
  let text;
  try {
    text = await navigator.clipboard.readText();
  } catch {
    clipboard.promptPaste(v => pasteAt(at, v));
    return;
  }
  if (!text.trim()) { say(i18n.t("clip.empty")); return; }
  pasteAt(at, text);
}

function pasteRow(at, usable, blocked) {
  const { bar, beat } = barBeatOf(at);
  return {
    id: "paste",
    step: null,
    format: () => ({
      label: i18n.t("roll.note.paste"),
      hint: i18n.t("roll.note.pasteAt", { bar, beat }),
      disabled: !usable,
      why: blocked,
    }),
    run: () => pasteFromMenu(at),
  };
}

const countNotes = its => its.filter(it => it.k === "note").length;

function barBeatOf(tick) {
  const bar = barIndexOf(tick);
  const beat = Math.floor((tick - barStartTick(bar)) / (PPQ * 4 / meterAt(tick).den));
  return { bar: bar + 1, beat: beat + 1 };
}

function openRollMenu({ x, y, markTick, pasteTick, barTick, canEdit, whyNot }) {
  const bar = barOf(barTick);
  const usable = canEdit && !!song;
  const blocked = whyNot || i18n.t("roll.menu.playing");

  const barRow = (insert, scope) => {
    const left = barsLeft(scope, barTick);
    const idle = !busyTracks(scope, barTick).length;
    return {
      id: `${insert ? "ins" : "del"}-${scope}`,
      danger: !insert,
      step: { value: 1, min: 1, max: insert ? 16 : Math.max(1, Math.min(16, left)) },
      format: n => ({
        label: insert
          ? i18n.t(scope === "song" ? "roll.menu.insertSong" : "roll.menu.insertTrack", { n })
          : i18n.t(scope === "song" ? "roll.menu.deleteSong" : "roll.menu.deleteTrack", { n }),
        hint: insert ? i18n.t("roll.menu.insertAt", { bar: bar + 1 })
          : n === 1 ? i18n.t("roll.menu.deleteOne", { bar: bar + 1 })
            : i18n.t("roll.menu.deleteRange", { from: bar + 1, to: bar + n }),
        disabled: !usable || idle,
        why: usable ? i18n.t("roll.menu.idle") : blocked,
      }),
      run: n => barEdit({ insert, scope, at: barTick, bars: n }),
    };
  };

  const sideRow = before => {
    const n = sideNotes(barTick, before).length;
    return {
      id: before ? "sel-before" : "sel-after",
      step: null,
      format: () => ({
        label: i18n.t(before ? "roll.menu.selectBefore" : "roll.menu.selectAfter"),
        hint: i18n.t("roll.menu.selectCount", { n }),
        disabled: !n,
        why: i18n.t("roll.menu.selectNone"),
      }),
      run: () => selectSide(barTick, before),
    };
  };

  rollmenu.open({
    x, y,
    title: i18n.t("roll.menu.title", { bar: bar + 1 }),
    a11y: {
      menu: i18n.t("roll.menu.aria"),
      dec: i18n.t("roll.menu.less"),
      inc: i18n.t("roll.menu.more"),
    },
    rows: [
      {
        id: "play-start", step: null,
        format: () => ({ label: i18n.t("roll.menu.playStart") }),
        run: () => roll.setPlayStart(markTick),
      },
      {
        id: "play-end", step: null,
        format: () => ({ label: i18n.t("roll.menu.playEnd") }),
        run: () => roll.setPlayEnd(markTick),
      },
      markAddRow(barTick, barOf(barTick)),
      null,
      sideRow(true),
      sideRow(false),
      null,
      pasteRow(pasteTick ?? markTick, usable, blocked),
      null,
      barRow(true, "track"),
      barRow(true, "song"),
      null,
      barRow(false, "track"),
      barRow(false, "song"),
    ],
  });
}

const METER_NUMS = [2, 3, 4, 6, 9];
const METER_DENS = [2, 4, 8];

const METER_MIN = 720, METER_MAX = 3840;
const meterOk = (num, den) => {
  const t = meterTicks({ num, den });
  return t >= METER_MIN && t <= METER_MAX;
};

function openMeterMenu({ x, y }) {
  const head = meters.stored()[0];
  const cur = { num: head.num, den: head.den };
  const now = () => meterName(cur);

  rollmenu.open({
    x, y,
    title: i18n.t("meter.menu.title"),
    a11y: {
      menu: i18n.t("meter.menu.aria"),
      dec: i18n.t("meter.menu.less"),
      inc: i18n.t("meter.menu.more"),
    },
    rows: [
      {
        id: "meter-num",
        step: { value: cur.num, values: () => METER_NUMS.filter(n => meterOk(n, cur.den)) },
        onChange: v => { cur.num = v; },
        format: () => ({
          label: i18n.t("meter.menu.apply", { meter: now() }),
          hint: i18n.t("meter.menu.beats"),
          disabled: cur.num === head.num && cur.den === head.den,
          why: i18n.t("meter.menu.same", { meter: now() }),
        }),
        run: () => applyHeadMeter(cur),
      },
      {
        id: "meter-den",
        step: { value: cur.den, values: METER_DENS },
        onChange: v => { cur.den = v; },
        format: () => ({
          label: i18n.t("meter.menu.apply", { meter: now() }),
          hint: i18n.t("meter.menu.unit"),
          disabled: cur.num === head.num && cur.den === head.den,
          why: i18n.t("meter.menu.same", { meter: now() }),
        }),
        run: () => applyHeadMeter(cur),
      },
      null,
      {
        id: "meter-tempo", step: null,
        format: () => ({
          label: i18n.t("meter.menu.tempo"),
          hint: i18n.t("meter.menu.tempoHint", { bpm: bpmAt(0) }),
        }),
        run: () => { tempoWhere = "head"; openTempo(); },
      },
    ],
  });
}

function applyHeadMeter({ num, den }) {
  const rest = meters.stored().slice(1);
  let ok = false;
  withMeterEdit(() => { ok = meters.set([{ tick: 0, num, den }, ...rest]); });
  if (ok) say(i18n.t("meter.menu.applied", { meter: meterName({ num, den }) }));
}

function openBarMenu({ x, y, markTick, barTick, bar, canEdit, whyNot }) {
  const usable = canEdit && !!song;
  const blocked = whyNot || i18n.t("roll.menu.playing");
  const hasRange = roll.playRange().fromTick !== null || roll.playRange().toTick !== null;

  const here = meters.stored().find(m => m.tick === barTick && m.tick > 0) ?? null;
  const cur = meterAt(barTick);
  const pick = { num: here?.num ?? cur.num, den: here?.den ?? cur.den };

  const meterWhy =
    !meters.isOn() ? i18n.t("bar.menu.meterOff")
      : barTick === 0 ? i18n.t("bar.menu.meterHead")
        : "";

  rollmenu.open({
    x, y,
    title: i18n.t("bar.menu.title", { bar: bar + 1 }),
    a11y: {
      menu: i18n.t("bar.menu.aria"),
      dec: i18n.t("roll.menu.less"),
      inc: i18n.t("roll.menu.more"),
    },
    rows: [
      {
        id: "play-start", step: null,
        format: () => ({ label: i18n.t("roll.menu.playStart") }),
        run: () => roll.setPlayStart(markTick),
      },
      {
        id: "play-end", step: null,
        format: () => ({ label: i18n.t("roll.menu.playEnd") }),
        run: () => roll.setPlayEnd(markTick),
      },
      {
        id: "play-clear", step: null,
        format: () => ({
          label: i18n.t("bar.menu.clear"),
          hint: i18n.t("bar.menu.clearHint"),
          disabled: !hasRange,
          why: i18n.t("bar.menu.clearNone"),
        }),
        run: () => roll.clearPlayRange(),
      },
      null,
      {
        id: "bar-meter-num",
        step: { value: pick.num, values: () => METER_NUMS.filter(n => meterOk(n, pick.den)) },
        onChange: v => { pick.num = v; },
        format: () => ({
          label: i18n.t("bar.menu.meter", { meter: meterName(pick) }),
          hint: i18n.t("bar.menu.meterHint"),
          disabled: !!meterWhy,
          why: meterWhy,
        }),
        run: () => applyBarMeter(barTick, bar, pick),
      },
      {
        id: "bar-meter-den",
        step: { value: pick.den, values: METER_DENS },
        onChange: v => { pick.den = v; },
        format: () => ({
          label: i18n.t("bar.menu.meter", { meter: meterName(pick) }),
          hint: i18n.t("bar.menu.meterHint"),
          disabled: !!meterWhy,
          why: meterWhy,
        }),
        run: () => applyBarMeter(barTick, bar, pick),
      },
      {
        id: "bar-meter-del", danger: true, step: null,
        format: () => ({
          label: i18n.t("bar.menu.meterRemove"),
          hint: here ? i18n.t("bar.menu.meterRemoveHint", { meter: meterName(meterBefore(barTick)) }) : "",
          disabled: !!meterWhy || !here,
          why: meterWhy || i18n.t("bar.menu.meterRemoveHint", { meter: meterName(cur) }),
        }),
        run: () => removeBarMeter(barTick, bar),
      },
      null,
      {
        id: "bar-velocity",
        step: { value: velAt(markTick), min: 0, max: 15 },
        format: () => ({
          label: i18n.t("bar.menu.velocity"),
          hint: i18n.t("bar.menu.velocityHint", { track: tracks.activeTrack() + 1 }),
          disabled: !usable,
          why: blocked,
        }),
        run: v => addVelocityAt(markTick, bar, v),
      },
      markAddRow(barTick, bar),
    ],
  });
}

const meterBefore = tick => {
  const before = meters.stored().filter(m => m.tick < tick);
  return before.length ? before[before.length - 1] : meters.stored()[0];
};

function velAt(tick) {
  const evs = velChanges(song?.tracks?.[tracks.activeTrack()]?.vels);
  let v = 8;
  for (const e of evs) { if (e.tick > tick) break; v = e.v; }
  return v;
}

function applyBarMeter(tick, bar, { num, den }) {
  if (tick <= 0) return;
  const rest = meters.stored().filter(m => m.tick !== tick);
  let ok = false;
  withMeterEdit(() => { ok = meters.set([...rest, { tick, num, den }]); });
  if (ok) say(i18n.t("bar.menu.meterDone", { bar: bar + 1, meter: meterName({ num, den }) }));
}

function removeBarMeter(tick, bar) {
  if (tick <= 0) return;
  let ok = false;
  withMeterEdit(() => { ok = meters.set(meters.stored().filter(m => m.tick !== tick)); });
  if (ok) say(i18n.t("bar.menu.meterGone", { bar: bar + 1 }));
}

function addVelocityAt(tick, bar, v) {
  const i = tracks.activeTrack();
  const text = tracks.trackTexts()[i] ?? "";
  const p = prepTrack(text);
  if (p.error) { say(i18n.t("ui.roll.cantEdit", { why: p.error })); return; }

  const out = finish(placeVelocity(p.items, tick, v), p.opts);
  if (out === null) { say(i18n.t("ui.roll.cantEncode")); return; }
  writeBack(i, out, text);
  say(i18n.t("bar.menu.velocityDone", { track: i + 1, bar: bar + 1, v }));
}

function paintDots() {
  const box = $("#markdots");
  if (!box) return;
  box.textContent = "";

  marks.stored().forEach((m, i) => {
    const dot = document.createElement("div");
    dot.className = "dot";
    dot.dataset.tick = String(m.tick);
    dot.style.background = markColor(i);
    dot.title = i18n.t("mark.menu.title", { bar: barOf(m.tick) + 1, text: m.text });
    dot.addEventListener("click", () => roll.jumpTo(m.tick));
    box.appendChild(dot);
  });
  layoutDots();
}

function layoutDots() {
  const box = $("#markdots");
  if (!box || !box.children.length) return;

  const track = $("#stage").clientWidth;
  const scrollW = GUTTER_W + roll.viewWidth();

  for (const dot of box.children) {
    const left = `${markDotX(roll.viewX(+dot.dataset.tick), scrollW, track)}px`;
    if (dot.style.left !== left) dot.style.left = left;
  }
}

const markAddRow = (barTick, bar) => ({
  id: "mark-add", step: null,
  format: () => ({
    label: i18n.t("mark.menu.add"),
    hint: i18n.t("mark.menu.addHint", { bar: bar + 1 }),
    disabled: !!marks.at(barTick) || marks.isFull(),
    why: marks.at(barTick)
      ? i18n.t("mark.menu.exists")
      : i18n.t("mark.menu.full", { n: MAX_MARKS }),
  }),
  run: () => openMarkBox(barTick, ""),
});

function paintMarks() {
  const strip = $("#flagsStrip");
  if (!strip) return;
  strip.textContent = "";

  marks.stored().forEach((m, i) => {
    const el = document.createElement("button");
    el.type = "button";
    el.className = "pill";
    el.dataset.tick = String(m.tick);
    el.textContent = m.text;
    el.style.background = markColor(i);
    el.title = i18n.t("mark.menu.title", { bar: barOf(m.tick) + 1, text: m.text });

    el.addEventListener("click", () => roll.jumpTo(m.tick));
    el.addEventListener("contextmenu", e => {
      e.preventDefault();
      openPillMenu(e.clientX, e.clientY, m.tick);
    });
    strip.appendChild(el);
  });
  roll.setMarkLines(marks.stored().map((m, i) => ({ tick: m.tick, color: markColor(i) })));
  paintDots();
  layoutMarks();
}

function layoutMarks() {
  const strip = $("#flagsStrip");
  if (!strip) return;
  syncFlagBounds();
  layoutDots();
  const tf = `translateX(${-roll.viewScrollX()}px)`;
  if (strip.style.transform !== tf) strip.style.transform = tf;

  const pills = strip.children;
  if (!pills.length) return;

  const xs = marks.stored().map(m => roll.viewX(m.tick));
  const widths = markPillWidths(xs);
  for (let i = 0; i < pills.length; i++) {
    const left = `${xs[i]}px`, max = `${widths[i]}px`;
    if (pills[i].style.left !== left) pills[i].style.left = left;
    if (pills[i].style.maxWidth !== max) pills[i].style.maxWidth = max;
    pills[i].classList.toggle("tab", isPillTab(widths[i]));
  }
}

function openPillMenu(x, y, tick) {
  const m = marks.at(tick);
  if (!m) return;
  rollmenu.open({
    x, y,
    title: i18n.t("mark.menu.title", { bar: barOf(tick) + 1, text: m.text }),
    a11y: { menu: i18n.t("mark.menu.aria") },
    rows: [
      {
        id: "mark-edit", step: null,
        format: () => ({ label: i18n.t("mark.menu.edit") }),
        run: () => openMarkBox(tick, m.text),
      },
      {
        id: "mark-del", danger: true, step: null,
        format: () => ({ label: i18n.t("mark.menu.remove") }),
        run: () => {
          const bar = barOf(tick) + 1;
          history.edit(() => marks.remove(tick));
          say(i18n.t("mark.removed", { bar }));
        },
      },
    ],
  });
}

let markTick = 0;
let markWasThere = false;

function openMarkBox(tick, text) {
  markTick = tick;
  markWasThere = !!marks.at(tick);
  $("#markTitle").textContent = i18n.t(markWasThere ? "mark.box.editTitle" : "mark.box.addTitle");
  $("#markWhat").textContent = i18n.t("mark.box.at", { bar: barOf(tick) + 1 });
  const input = $("#markText");
  input.value = text ?? "";
  syncMarkLeft();
  $("#markBox").classList.add("on");
  input.focus();
  input.select();
}

const closeMarkBox = () => $("#markBox").classList.remove("on");

function syncMarkLeft() {
  const input = $("#markText");
  const cut = clampMarkText(input.value);
  if (cut !== input.value && textWidth(input.value) > MARK_WIDTH) input.value = cut;
  const left = MARK_WIDTH - textWidth(input.value);
  const el = $("#markLeft");
  el.textContent = i18n.t("mark.box.left", { n: left });
  el.classList.toggle("over", left <= 0);
}

function confirmMarkBox() {
  const text = clampMarkText($("#markText").value);
  closeMarkBox();
  if (!text) return;
  const bar = barOf(markTick) + 1;
  let ok = false;
  history.edit(() => { ok = marks.put(markTick, text); });
  if (!ok) return;
  say(i18n.t(markWasThere ? "mark.edited" : "mark.added", { bar, text }));
}

let flagGut = null, flagBar = null;

function syncFlagBounds() {
  const wrap = $("#rollwrap"), stage = $("#stage");
  if (!wrap || !stage) return;
  if (flagGut !== GUTTER_W) { wrap.style.setProperty("--gut", `${GUTTER_W}px`); flagGut = GUTTER_W; }
  const bar = Math.max(8, stage.offsetHeight - stage.clientHeight);
  if (flagBar !== bar) { wrap.style.setProperty("--hbar", `${bar}px`); flagBar = bar; }
}

function initMarkBox() {
  const box = $("#markBox");
  if (!box) return;
  $("#markText").addEventListener("input", syncMarkLeft);
  $("#markText").addEventListener("keydown", e => {
    if (e.key === "Enter") { e.preventDefault(); confirmMarkBox(); }
  });
  $("#markOk").addEventListener("click", confirmMarkBox);
  $("#markCancel").addEventListener("click", closeMarkBox);
  box.addEventListener("click", e => { if (e.target === box) closeMarkBox(); });

  marks.setChangeHandler(() => {
    tracks.persist();
    paintMarks();
  });

  paintMarks();
}

function openNoteMenu({ x, y, note, canEdit, whyNot }) {
  const picks = menuPicks();
  const n = picks.length;
  const usable = canEdit && !!song;
  const blocked = whyNot || i18n.t("roll.menu.playing");

  const p = prepTrack(tracks.trackTexts()[tracks.activeTrack()] ?? "");
  const items = p.items ?? [];
  const spans = picks.map(q => findNote(items, q.tick, q.midi)).filter(Boolean);
  const from = spans.length ? Math.min(...spans.map(s => s.tick)) : note.tick;
  const to = spans.length ? Math.max(...spans.map(s => s.tick + s.dur)) : note.tick + note.dur;

  const sideRow = before => {
    const k = sideNotes(note.tick, before).length;
    return {
      id: before ? "sel-before" : "sel-after",
      step: null,
      format: () => ({
        label: i18n.t(before ? "roll.menu.selectBefore" : "roll.menu.selectAfter"),
        hint: i18n.t("roll.menu.selectCount", { n: k }),
        disabled: !k,
        why: i18n.t("roll.menu.selectNone"),
      }),
      run: () => selectSide(note.tick, before),
    };
  };

  const dotCalc = dotNotes(items, new Set(picks.map(p => noteKey(p.tick, p.midi))));
  const vel = velocityStats(items, new Set(picks.map(q => q.tick)));
  const now = velocitiesOf(items).get(note.tick) ?? 8;

  rollmenu.open({
    x, y,
    title: i18n.t("roll.note.title", { bar: barBeatOf(note.tick).bar, n }),
    a11y: {
      menu: i18n.t("roll.note.aria"),
      dec: i18n.t("roll.note.less"),
      inc: i18n.t("roll.note.more"),
    },
    rows: [
      {
        id: "play-start", step: null,
        format: () => ({ label: i18n.t("roll.note.playStart") }),
        run: () => roll.setPlayStart(from),
      },
      {
        id: "play-end", step: null,
        format: () => ({ label: i18n.t("roll.note.playEnd") }),
        run: () => roll.setPlayEnd(to),
      },
      null,
      sideRow(true),
      sideRow(false),
      null,
      {
        id: "dot", step: null,
        format: () => ({
          label: i18n.t(dotCalc.items && !dotCalc.dotted
            ? "roll.note.dotRemove" : "roll.note.dotAdd"),
          hint: dotCalc.items
            ? i18n.t("roll.note.dotHint", { n: dotCalc.n })
            : i18n.t("roll.note.dotBad"),
          disabled: !usable,
          why: blocked,
        }),
        run: applyDot,
      },
      {
        id: "velocity",
        step: { value: now, min: 0, max: 15 },
        format: v => ({
          label: i18n.t("roll.note.velocity"),
          hint: vel.min === vel.max
            ? i18n.t("roll.note.velocityOne", { v: vel.min })
            : i18n.t("roll.note.velocityHint", { min: vel.min, max: vel.max }),
          disabled: !usable,
          why: blocked,
        }),
        run: v => setPickedVelocity(v),
      },
      null,
      pasteRow(note.tick, usable, blocked),
      null,
      {
        id: "copy", step: null,
        format: () => ({
          label: i18n.t("roll.note.copy"),
          hint: i18n.t("roll.menu.selectCount", { n }),
        }),
        run: () => copyPicked(),
      },
      {
        id: "cut", danger: true, step: null,
        format: () => ({
          label: i18n.t("roll.note.cut"),
          hint: i18n.t("roll.menu.selectCount", { n }),
          disabled: !usable,
          why: blocked,
        }),
        run: () => cutPicked(),
      },
      {
        id: "delete", danger: true, step: null,
        format: () => ({
          label: i18n.t("roll.note.delete"),
          hint: i18n.t("roll.menu.selectCount", { n }),
          disabled: !usable,
          why: blocked,
        }),
        run: () => removeNotes(picks.map(q => ({ tick: q.tick, midi: q.midi }))),
      },
    ],
  });
}

function applyDot() {
  const i = tracks.activeTrack();
  const text = tracks.trackTexts()[i] ?? "";
  const p = prepTrack(text);
  if (p.error) { say(i18n.t("ui.roll.cantEdit", { why: p.error })); return; }
  const picks = menuPicks();
  const r = dotNotes(p.items, new Set(picks.map(n => noteKey(n.tick, n.midi))));
  if (r.bad || r.blocked) {
    const first = (r.bad ?? r.blocked)[0];
    say(i18n.t(r.bad ? "roll.note.dotBlockedLen" : "roll.note.dotBlockedKill", {
      bar: barBeatOf(first.tick).bar, note: first.midi,
    }) + (r.bad?.length > 1 ? i18n.t("roll.note.dotBlockedMore", { n: r.bad.length - 1 }) : ""));
    return;
  }
  if (!r.n) return;
  const out = genPlain(r.items, p.opts);
  if (out === null) { say(i18n.t("ui.roll.cantEncode")); return; }
  writeBack(i, out, text);
  reselect(picks);
  say(i18n.t(r.dotted ? "roll.note.dotDone" : "roll.note.dotUndone", { n: r.n }));
}

function nudgeVelocity(delta) {
  const i = tracks.activeTrack(), text = tracks.trackTexts()[i] ?? "";
  const p = prepTrack(text), picks = menuPicks();
  if (p.error || !picks.length) return;
  const r = shiftVelocities(p.items, delta, new Set(picks.map(n => n.tick)));
  const out = genPlain(r.items, p.opts);
  if (out === null) { say(i18n.t("ui.roll.cantEncode")); return; }
  writeBack(i, out, text); reselect(picks);
}

function setPickedVelocity(v) {
  const i = tracks.activeTrack();
  const text = tracks.trackTexts()[i] ?? "";
  const p = prepTrack(text);
  if (p.error) { say(i18n.t("ui.roll.cantEdit", { why: p.error })); return; }

  const picks = menuPicks();
  const out = finish(setVelocities(p.items, v, new Set(picks.map(q => q.tick))), p.opts);
  if (out === null) { say(i18n.t("ui.roll.cantEncode")); return; }
  if (out === bareTrack(text)) { say(i18n.t("roll.note.velocitySame", { v })); return; }
  writeBack(i, out, text);
  say(i18n.t("roll.note.velocityDone", { n: picks.length, v }));
}

let transScope = "track";
let transSemis = 0;

function buildTransKeys() {
  const wrap = $("#transKeys");
  if (!wrap || wrap.childElementCount) return;
  const mk = n => {
    const b = document.createElement("button");
    b.type = "button";
    b.setAttribute("role", "radio");
    b.setAttribute("aria-checked", "false");
    b.dataset.semis = String(n);
    const oct = Math.abs(n) === 12
      ? i18n.t("ui.trans.octave",
          { dir: i18n.t(n > 0 ? "ui.trans.high" : "ui.trans.low") })
      : "";
    b.innerHTML = i18n.t("ui.trans.button", {
      dir: i18n.t(n > 0 ? "ui.trans.up" : "ui.trans.down"),
      n: Math.abs(n), oct,
    });
    return b;
  };
  for (let n = 1; n <= 12; n++) wrap.appendChild(mk(n));
  for (let n = 1; n <= 12; n++) wrap.appendChild(mk(-n));
}

function openTranspose() {
  buildTransKeys();
  transSemis = 0;

  const hasSel = roll.selectedNotes().length > 0;
  const selBtn = $("#transScope button[data-scope='sel']");
  selBtn.disabled = !hasSel;
  selBtn.title = hasSel ? "" : i18n.t("ui.needSelection");
  if (transScope === "sel" && !hasSel) transScope = "track";

  syncTransUI();
  $("#transNote").textContent = "";
  $("#transBox").classList.add("on");
  $("#transScope button.on")?.focus();
}

const closeTranspose = () => $("#transBox").classList.remove("on");

function syncTransUI() {
  document.querySelectorAll("#transScope button").forEach(b => {
    const on = b.dataset.scope === transScope;
    b.classList.toggle("on", on);
    b.setAttribute("aria-checked", String(on));
  });
  document.querySelectorAll("#transKeys button").forEach(b => {
    const on = +b.dataset.semis === transSemis;
    b.classList.toggle("on", on);
    b.setAttribute("aria-checked", String(on));
  });
  $("#transOk").disabled = transSemis === 0;
}

function transTargets() {
  const texts = tracks.trackTexts();
  if (transScope === "all") {
    return texts.map((text, i) => ({ i, text })).filter(t => bareTrack(t.text));
  }
  const i = tracks.activeTrack();
  return [{ i, text: texts[i] ?? "" }];
}

function applyTranspose() {
  const targets = transTargets();
  const semis = transSemis;
  const keys = transScope === "sel"
    ? new Set(roll.selectedNotes().map(n => noteKey(n.tick, n.midi)))
    : null;

  const writes = [];
  let low = 0, high = 0;
  for (const { i, text } of targets) {
    const p = prepTrack(text);
    if (p.error) {
      fail(i18n.t("ui.trans.failTrack", { n: i + 1, why: p.error }));
      return;
    }
    const r = transpose(p.items, semis, keys);
    if (!r.items) { low += r.low; high += r.high; continue; }
    const out = finish(r.items, p.opts);
    if (out === null) {
      fail(i18n.t("ui.trans.failEncode", { n: i + 1 }));
      return;
    }
    writes.push({ i, out, before: text });
  }

  if (low || high) {
    const parts = [];
    if (low) parts.push(i18n.t("ui.trans.tooLow", { n: low }));
    if (high) parts.push(i18n.t("ui.trans.tooHigh", { n: high }));
    fail(i18n.t("ui.trans.failReasons", { list: i18n.list(parts) }));
    return;
  }
  if (!writes.length) { fail(i18n.t("ui.noNotesInRange")); return; }

  const picks = keys
    ? roll.selectedNotes().map(n => ({ tick: n.tick, midi: n.midi + semis }))
    : null;

  writeBackMany(writes);
  closeTranspose();
  if (picks) reselect(picks);
}

function fail(msg) { $("#transNote").textContent = msg; }

function initTranspose() {
  $("#transBtn").addEventListener("click", openTranspose);
  $("#transCancel").addEventListener("click", closeTranspose);
  $("#transOk").addEventListener("click", applyTranspose);
  $("#transBox").addEventListener("click", e => {
    if (e.target === $("#transBox")) closeTranspose();
  });
  $("#transScope").addEventListener("click", e => {
    const b = e.target.closest("button[data-scope]");
    if (!b || b.disabled) return;
    transScope = b.dataset.scope;
    $("#transNote").textContent = "";
    syncTransUI();
  });
  $("#transKeys").addEventListener("click", e => {
    const b = e.target.closest("button[data-semis]");
    if (!b) return;
    transSemis = +b.dataset.semis;
    $("#transNote").textContent = "";
    syncTransUI();
  });
  addEventListener("keydown", e => {
    if (e.key === "Escape" && $("#transBox").classList.contains("on")) closeTranspose();
  });
}

const BPM_MIN = 32, BPM_MAX = 255;

let tempoWhere = "head";
let tempoBpm = 120;
let tempoPlan = { split: [] };

function tempoTick() {
  if (tempoWhere === "head") return 0;
  const sel = roll.selectedNotes();
  return sel.length ? Math.min(...sel.map(n => n.tick)) : 0;
}

const tempoMap = () => tempoChanges(song?.tempos ?? []);

function bpmAt(tick) {
  let bpm = 120;
  for (const e of tempoMap()) { if (e.tick > tick) break; bpm = e.bpm; }
  return bpm;
}

const tempoAtExactly = tick => tempoMap().find(e => e.tick === tick) ?? null;

function tempoEdited(tick, bpm) {
  const rest = tempoMap().filter(e => e.tick !== tick);
  const map = bpm === null ? rest : [...rest, { tick, bpm }];
  map.sort((a, b) => a.tick - b.tick);
  return map.filter((e, i, a) => e.tick === tick || i === 0 || e.bpm !== a[i - 1].bpm);
}

function computeTempoPlan() {
  const ticks = tempoEdited(tempoTick(), tempoBpm).map(e => e.tick);
  const texts = tracks.trackTexts();
  const split = [];
  for (const [i, text] of texts.entries()) {
    const p = prepTrack(stripTempos(text));
    if (p.error) continue;
    if (tempoCrossings(p.items, ticks).length) split.push(i);
  }
  tempoPlan = { split };
}

const trackList = list => i18n.list(list.map(i => i18n.trackName(i)));

const CLICK_LEAD = 0.35;
const CLICK_MS   = 40;
const CLICK_DUR  = 0.06;
const CLICK_HI   = 67;
const CLICK_LO   = 60;

let clickTimer = null, clickNext = 0, clickBeat = 0, clickTrack = 0;
let clickHold = false;

function clickTick() {
  const horizon = engine.now() + CLICK_LEAD;
  const ch = chanOf(clickTrack);
  for (let guard = 0; clickNext < horizon && guard < 64; guard++) {
    const one = clickBeat % 4 === 0;
    const midi = one ? CLICK_HI : CLICK_LO;
    engine.noteOn(ch, midi, one ? 112 : 64, clickNext);
    engine.noteOff(ch, midi, clickNext + CLICK_DUR);
    clickNext += 60 / Math.max(BPM_MIN, tempoBpm);
    clickBeat++;
  }
}

const clicking = () => clickTimer !== null;

function startClicks() {
  if (clicking() || !canClick()) return;
  clickTrack = tracks.activeTrack();
  engine.resume();
  engine.unmute();
  applyInstruments([clickTrack]);
  applyMutes();
  clickNext = engine.now() + 0.08;
  clickBeat = 0;
  clickTimer = setInterval(clickTick, CLICK_MS);
  clickTick();
  syncTempoTry();
}

function stopClicks() {
  if (!clicking()) return;
  clearInterval(clickTimer); clickTimer = null;
  engine.stopAll();
  engine.setChannelMute(chanOf(clickTrack), true);
  setTimeout(applyMutes, CLICK_LEAD * 1000 + 60);
  syncTempoTry();
}

function canClick() {
  if (sounding()) return false;
  if (!presets.length) return false;
  return true;
}

function syncTempoTry() {
  const b = $("#tempoTry");
  if (!b) return;
  const ok = canClick();
  b.disabled = !ok;
  b.classList.toggle("on", clicking());
  b.setAttribute("aria-pressed", String(clicking()));
  setIcon(b, clicking() ? "stop" : "play");
}

function openTempo() {
  const hasSel = roll.selectedNotes().length > 0;
  const selBtn = $("#tempoWhere button[data-where='sel']");
  selBtn.disabled = !hasSel;
  selBtn.title = hasSel ? "" : i18n.t("ui.needSelection");
  if (tempoWhere === "sel" && !hasSel) tempoWhere = "head";

  tempoBpm = bpmAt(tempoTick());
  computeTempoPlan();
  $("#tempoNote").textContent = "";
  syncTempoUI();
  $("#tempoBox").classList.add("on");
  $("#tempoWhere button.on")?.focus();
}

function closeTempo() {
  stopClicks();
  $("#tempoBox").classList.remove("on");
}

const failTempo = msg => { $("#tempoNote").textContent = msg; };

function setTempoBpm(v) {
  const n = Math.round(Number(v));
  if (!Number.isFinite(n)) return;
  tempoBpm = Math.min(BPM_MAX, Math.max(BPM_MIN, n));
  syncTempoUI();
}

function syncTempoUI() {
  document.querySelectorAll("#tempoWhere button").forEach(b => {
    const on = b.dataset.where === tempoWhere;
    b.classList.toggle("on", on);
    b.setAttribute("aria-checked", String(on));
  });
  if (document.activeElement !== $("#tempoNum")) $("#tempoNum").value = String(tempoBpm);
  $("#tempoSlider").value = String(tempoBpm);

  const tick = tempoTick();
  const cur = tempoAtExactly(tick);
  $("#tempoDel").hidden = !cur;

  const parts = [];
    if (cur) parts.push(i18n.t("ui.tempo.replace", { from: cur.bpm, to: tempoBpm }));
    else parts.push(i18n.t("ui.tempo.insert", { to: tempoBpm, at: bpmAt(tick) }));
  if (tempoPlan.split.length) {
      parts.push(i18n.t("ui.tempo.willSplit", { list: trackList(tempoPlan.split) }));
  }
  if (!canClick()) {
      parts.push(i18n.t(sounding() ? "ui.tempo.noPreviewPlaying" : "ui.tempo.noPreviewBank"));
  } else if (tracks.mutedFlags()[tracks.activeTrack()]) {
      parts.push(i18n.t("ui.tempo.trackMuted",
        { track: i18n.trackName(tracks.activeTrack()) }));
  }
  $("#tempoInfo").innerHTML = parts.join(" ");
  syncTempoTry();
}

function applyTempo(remove = false) {
  const tick = tempoTick();
  const map = tempoEdited(tick, remove ? null : tempoBpm);
  const ticks = map.map(e => e.tick);
  const texts = tracks.trackTexts();
  const writes = [];

  for (const [i, before] of texts.entries()) {
    const stripped = stripTempos(before);
    const p = prepTrack(stripped);

    if (i === 0) {
      if (p.error) { failTempo(i18n.t("ui.tempo.failParse",
        { track: i18n.trackName(0), why: p.error })); return; }
      const out = finish(placeTempos(p.items, map), p.opts);
      if (out === null) { failTempo(i18n.t("ui.tempo.failEncode",
        { track: i18n.trackName(0) })); return; }
      if (out !== before) writes.push({ i, out, before });
      continue;
    }

    if (p.error) {
      if (stripped !== before) writes.push({ i, out: stripped, before });
      continue;
    }
    if (!tempoCrossings(p.items, ticks).length) {
      if (stripped !== before) writes.push({ i, out: stripped, before });
      continue;
    }
    const r = splitForTempos(p.items, ticks);
    const out = finish(r.items, p.opts);
    if (out === null) { failTempo(i18n.t("ui.tempo.failEncodeN",
      { track: i18n.trackName(i) })); return; }
    if (out !== before) writes.push({ i, out, before });
  }

  if (!writes.length) { closeTempo(); say(i18n.t("ui.tempo.noChange")); return; }

  say(remove
    ? i18n.t("ui.tempo.removed")
    : i18n.t("ui.tempo.written", {
        bpm: tempoBpm, track: i18n.trackName(0),
        where: i18n.t(tick === 0 ? "ui.tempo.atStart" : "ui.tempo.atPos"),
      }));
  writeBackMany(writes);
  closeTempo();
}

function initTempo() {
  $("#tempoBtn").addEventListener("click", openTempo);
  $("#tempoCancel").addEventListener("click", closeTempo);
  $("#tempoOk").addEventListener("click", () => applyTempo(false));
  $("#tempoDel").addEventListener("click", () => applyTempo(true));
  $("#tempoBox").addEventListener("click", e => {
    if (e.target === $("#tempoBox")) closeTempo();
  });
  $("#tempoWhere").addEventListener("click", e => {
    const b = e.target.closest("button[data-where]");
    if (!b || b.disabled) return;
    tempoWhere = b.dataset.where;
    tempoBpm = bpmAt(tempoTick());
    computeTempoPlan();
    $("#tempoNote").textContent = "";
    syncTempoUI();
  });

  $("#tempoSlider").addEventListener("input", e => setTempoBpm(e.target.value));
  $("#tempoNum").addEventListener("input", e => {
    const n = Number(e.target.value);
    if (e.target.value !== "" && Number.isFinite(n)) setTempoBpm(n);
  });
  $("#tempoNum").addEventListener("blur", () => syncTempoUI());

  const replan = () => { computeTempoPlan(); syncTempoUI(); };
  $("#tempoSlider").addEventListener("change", replan);
  $("#tempoNum").addEventListener("change", replan);

  $("#tempoSlider").addEventListener("pointerdown", () => {
    if (clicking()) return;
    clickHold = true;
    startClicks();
  });
  const release = () => { if (clickHold) { clickHold = false; stopClicks(); } };
  addEventListener("pointerup", release);
  addEventListener("pointercancel", release);

  $("#tempoTry").addEventListener("click", () => {
    clickHold = false;
    clicking() ? stopClicks() : startClicks();
  });

  addEventListener("keydown", e => {
    if (e.key === "Escape" && $("#tempoBox").classList.contains("on")) closeTempo();
  });
}

let velScope = "track";
let velDelta = 0;

function buildVelKeys() {
  const wrap = $("#velKeys");
  if (!wrap || wrap.childElementCount) return;
  const mk = n => {
    const b = document.createElement("button");
    b.type = "button";
    b.setAttribute("role", "radio");
    b.setAttribute("aria-checked", "false");
    b.dataset.delta = String(n);
    b.innerHTML = i18n.t("ui.vel.button", {
      dir: i18n.t(n > 0 ? "ui.vel.up" : "ui.vel.down"),
      sign: n > 0 ? "+" : "−", n: Math.abs(n),
    });
    return b;
  };
  for (let n = 1; n <= 10; n++) wrap.appendChild(mk(n));
  for (let n = 1; n <= 10; n++) wrap.appendChild(mk(-n));
}

function velTargets() {
  const texts = tracks.trackTexts();
  if (velScope === "all") {
    return texts.map((text, i) => ({ i, text })).filter(t => bareTrack(t.text));
  }
  const i = tracks.activeTrack();
  return [{ i, text: texts[i] ?? "" }];
}

const velTicks = () =>
  velScope === "sel" ? new Set(roll.selectedNotes().map(n => n.tick)) : null;

function openVelocity() {
  buildVelKeys();
  velDelta = 0;

  const hasSel = roll.selectedNotes().length > 0;
  const selBtn = $("#velScope button[data-scope='sel']");
  selBtn.disabled = !hasSel;
  selBtn.title = hasSel ? "" : i18n.t("ui.needSelection");
  if (velScope === "sel" && !hasSel) velScope = "track";

  $("#velNote").textContent = "";
  syncVelUI();
  $("#velBox").classList.add("on");
  $("#velScope button.on")?.focus();
}

const closeVelocity = () => $("#velBox").classList.remove("on");

function velStats() {
  const ticks = velTicks();
  let min = null, max = null, count = 0, clipped = 0;
  for (const { text } of velTargets()) {
    const p = prepTrack(text);
    if (p.error) continue;
    const s = velocityStats(p.items, ticks);
    count += s.count;
    if (s.min !== null) min = min === null ? s.min : Math.min(min, s.min);
    if (s.max !== null) max = max === null ? s.max : Math.max(max, s.max);
    if (velDelta) clipped += shiftVelocities(p.items, velDelta, ticks).clipped;
  }
  return { min, max, count, clipped };
}

function syncVelUI() {
  document.querySelectorAll("#velScope button").forEach(b => {
    const on = b.dataset.scope === velScope;
    b.classList.toggle("on", on);
    b.setAttribute("aria-checked", String(on));
  });
  document.querySelectorAll("#velKeys button").forEach(b => {
    const on = +b.dataset.delta === velDelta;
    b.classList.toggle("on", on);
    b.setAttribute("aria-checked", String(on));
  });

  const s = velStats();
  $("#velRange").innerHTML = s.count
      ? i18n.t("ui.vel.range", { n: s.count, min: s.min, max: s.max })
      : i18n.t("ui.vel.noNotes");
  $("#velNote").textContent = s.clipped
      ? i18n.t("ui.vel.clipped", { n: s.clipped,
          a: velDelta > 0 ? 15 : 0, b: velDelta > 0 ? 15 : 0 })
    : "";
  $("#velOk").disabled = velDelta === 0 || s.count === 0;
}

function applyVelocity() {
  const ticks = velTicks();
  const writes = [];
  for (const { i, text } of velTargets()) {
    const p = prepTrack(text);
    if (p.error) { $("#velNote").textContent = i18n.t("ui.vel.failParse",
      { track: i18n.trackName(i), why: p.error }); return; }
    const r = shiftVelocities(p.items, velDelta, ticks);
    const out = finish(r.items, p.opts);
    if (out === null) { $("#velNote").textContent = i18n.t("ui.vel.failEncode",
      { track: i18n.trackName(i) }); return; }
    if (out !== text) writes.push({ i, out, before: text });
  }
  if (!writes.length) { closeVelocity(); say(i18n.t("ui.vel.noChange")); return; }
  writeBackMany(writes);
  closeVelocity();
}

function initVelocity() {
  $("#velBtn").addEventListener("click", openVelocity);
  $("#velCancel").addEventListener("click", closeVelocity);
  $("#velOk").addEventListener("click", applyVelocity);
  $("#velBox").addEventListener("click", e => {
    if (e.target === $("#velBox")) closeVelocity();
  });
  $("#velScope").addEventListener("click", e => {
    const b = e.target.closest("button[data-scope]");
    if (!b || b.disabled) return;
    velScope = b.dataset.scope;
    syncVelUI();
  });
  $("#velKeys").addEventListener("click", e => {
    const b = e.target.closest("button[data-delta]");
    if (!b) return;
    velDelta = +b.dataset.delta;
    syncVelUI();
  });
  addEventListener("keydown", e => {
    if (e.key === "Escape" && $("#velBox").classList.contains("on")) closeVelocity();
  });
}

const MERGE_WAYS = MERGE_MODES;

let mergeScope = "track";
let mergeWay = null;
let mergeCalc = null;

const trackName = i => i18n.trackName(i);

function buildMergeTargets() {
  const sel = $("#mergeTo");
  const cur = tracks.activeTrack();
  const prev = sel.value;
  sel.innerHTML = "";
  for (let i = 0; i < tracks.trackCount(); i++) {
    if (i === cur) continue;
    const o = document.createElement("option");
    o.value = String(i);
    o.textContent = trackName(i);
    sel.appendChild(o);
  }
  if ([...sel.options].some(o => o.value === prev)) sel.value = prev;
}

const frame = () => new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));

const MERGE_SLICE_MS = 25;

let mergeJob = 0;

function recalcMerge() {
  const from = tracks.activeTrack();
  const to = +$("#mergeTo").value;
  const texts = tracks.trackTexts();
  const job = ++mergeJob;

  if (!Number.isInteger(to) || to === from) { mergeCalc = null; syncMergeUI(); return; }

  mergeCalc = { to, per: {}, fail: "", done: false, now: bareTrack(texts[to] ?? "").length };
  syncMergeUI();
  void fillMerge(job, from, to, texts);
}

async function fillMerge(job, from, to, texts) {
  const calc = mergeCalc;

  await frame();
  if (job !== mergeJob) return;

  const src = prepTrack(texts[from] ?? "");
  const tgt = prepTrack(texts[to] ?? "");
  if (src.error || tgt.error) {
    calc.done = true;
    calc.fail = src.error ? i18n.t("ui.merge.failSrc", { why: src.error })
                          : `${trackName(to)}${tgt.error}`;
    syncMergeUI();
    return;
  }

  const keys = mergeScope === "sel"
    ? new Set(roll.selectedNotes().map(n => noteKey(n.tick, n.midi)))
    : null;

  let since = performance.now();
  for (const way of MERGE_WAYS) {
    const r = mergeTracks(src.items, tgt.items, way, keys);
    if (r.block) {
      calc.per[way] = { block: r.block, count: r.count };
    } else {
      const tOut = finish(r.tgt, tgt.opts);
      const sOut = finish(r.src, src.opts);
      calc.per[way] = tOut === null || sOut === null ? { block: "encode" } : {
        dropped: r.dropped, trimmed: r.trimmed, tOut, sOut,
        after: bareTrack(tOut).length,
        picks: notesInRange(r.tgt, r.from, r.to - r.from)
          .map(n => ({ tick: n.tick, midi: n.midi })),
      };
    }

    if (performance.now() - since > MERGE_SLICE_MS) {
      syncMergeUI();
      await frame();
      if (job !== mergeJob) return;
      since = performance.now();
    }
  }

  calc.done = true;
  syncMergeUI();
}

function openMerge() {
  mergeWay = null;
  const hasSel = roll.selectedNotes().length > 0;

  const selBtn = $("#mergeScope button[data-scope='sel']");
  selBtn.disabled = !hasSel;
  selBtn.title = hasSel ? "" : i18n.t("ui.needSelection");
  mergeScope = hasSel ? "sel" : "track";

  buildMergeTargets();
  $("#mergeBox").classList.add("on");
  recalcMerge();
  $("#mergeTo").focus();
}

const closeMerge = () => {
  mergeJob++;
  $("#mergeBox").classList.remove("on");
};

function blockWhy(block, count, to) {
  switch (block) {
    case "empty":     return i18n.t("ui.merge.why.empty");
    case "encode":    return i18n.t("ui.merge.why.encode");
    default:          return "";
  }
}

function syncMergeUI() {
  const cur = tracks.activeTrack();

  document.querySelectorAll("#mergeScope button").forEach(b => {
    const on = b.dataset.scope === mergeScope;
    b.classList.toggle("on", on);
    b.setAttribute("aria-checked", String(on));
  });

  const all = song?.tracks[cur]?.notes?.length ?? 0;
  const n = mergeScope === "sel" ? roll.selectedNotes().length : all;
  $("#mergeFrom").textContent = i18n.t("ui.merge.from",
    { track: trackName(cur), n });

  const per = mergeCalc?.per ?? {};
  const busy = !!mergeCalc && !mergeCalc.done;
  const whys = new Set();
  let alive = 0;

  document.querySelectorAll("#mergeWays button").forEach(b => {
    const way = b.dataset.way;
    const s = per[way];
    const pending = !s && busy;
    const dead = !s || !!s.block;
    b.disabled = dead;
    b.setAttribute("aria-busy", String(pending));
    if (dead && !pending && mergeWay === way) mergeWay = null;
    if (!dead) alive++;
    const on = way === mergeWay && !(dead && !pending);
    b.classList.toggle("on", on);
    b.setAttribute("aria-checked", String(on));

    if (dead) {
      b.querySelector(".n").textContent = pending ? i18n.t("ui.calculating") : "—";
      const why = s ? blockWhy(s.block, s.count, mergeCalc?.to) : "";
      if (why) whys.add(why);
    } else {
      b.querySelector(".n").textContent = i18n.t("ui.merge.cost",
        { dropped: s.dropped, trimmed: s.trimmed });
    }
  });

  $("#mergeOk").disabled = mergeWay === null || busy;

  const chars = $("#mergeChars");
  const now = mergeCalc?.now ?? 0;
  const after = mergeWay ? per[mergeWay]?.after ?? null : null;
  chars.innerHTML = mergeCalc && !mergeCalc.fail
    ? `${trackName(mergeCalc.to)} <b>${now}</b>${after !== null ? ` → <b>${after}</b>` : ""}`
      + i18n.t("ui.charsOfLimit", { max: MAX_TRACK_CHARS })
    : "";
  chars.classList.toggle("over", (after ?? now) > MAX_TRACK_CHARS);

  const notes = mergeCalc?.fail ? [mergeCalc.fail] : [...whys];
  if (!alive && !busy && !notes.length) notes.push(i18n.t("ui.merge.cantMerge"));
  $("#mergeNote").textContent = notes.length
    ? i18n.t("ui.mergeNoteLine", { list: i18n.list(notes) }) : "";
}

function applyMerge() {
  if (!mergeCalc?.done) return;
  const s = mergeCalc.per[mergeWay];
  if (!s || s.block) return;

  const from = tracks.activeTrack();
  const to = mergeCalc.to;
  const texts = tracks.trackTexts();

  writeBackMany([
    { i: to, out: s.tOut, before: texts[to] ?? "" },
    { i: from, out: s.sOut, before: texts[from] ?? "" },
  ]);
  closeMerge();

  tracks.selectTrack(to);
  reselect(s.picks);

  const cost = s.dropped === 0 && s.trimmed === 0
    ? i18n.t("ui.merge.noLoss")
    : i18n.t("ui.merge.lossSummary", { dropped: s.dropped, trimmed: s.trimmed });
  say(i18n.t("ui.merge.done", { track: trackName(to), cost }));
}

function initMerge() {
  $("#mergeBtn").addEventListener("click", openMerge);
  $("#mergeCancel").addEventListener("click", closeMerge);
  $("#mergeOk").addEventListener("click", applyMerge);
  $("#mergeBox").addEventListener("click", e => {
    if (e.target === $("#mergeBox")) closeMerge();
  });
  $("#mergeScope").addEventListener("click", e => {
    const b = e.target.closest("button[data-scope]");
    if (!b || b.disabled) return;
    mergeScope = b.dataset.scope;
    recalcMerge();
  });
  $("#mergeWays").addEventListener("click", e => {
    const b = e.target.closest("button[data-way]");
    if (!b || b.disabled) return;
    mergeWay = b.dataset.way;
    syncMergeUI();
  });
  $("#mergeTo").addEventListener("change", recalcMerge);
  addEventListener("keydown", e => {
    if (e.key === "Escape" && $("#mergeBox").classList.contains("on")) closeMerge();
  });
}

const OPT_WAYS = ["lossless", ...OPT_RULES];

let optScope = "track";
let optRule = null;
let optCalc = null;

function optTargets() {
  const texts = tracks.trackTexts();
  if (optScope === "all") {
    return texts.map((text, i) => ({ i, text })).filter(t => bareTrack(t.text));
  }
  const i = tracks.activeTrack();
  return [{ i, text: texts[i] ?? "" }];
}

function recalcOpt() {
  const keys = optScope === "sel"
    ? new Set(roll.selectedNotes().map(n => noteKey(n.tick, n.midi)))
    : null;

  const per = {};
  for (const way of OPT_WAYS) per[way] = [];
  const skipped = [];
  const baseOf = {};
  for (const { i, text } of optTargets()) {
    const r = optimizeTrack(text, { ...genOpts(), rules: OPT_RULES, keys });
    if (r.error) { skipped.push(i18n.t("ui.opt.skipTrack",
      { n: i + 1, why: r.error })); continue; }
    if (r.budgetExhausted) skipped.push(i18n.t("compress.note.budgetExhausted", { n: i + 1 }));
    baseOf[i] = r.base;

    const rawLen = bareTrack(text).length;
    const baseLen = bareTrack(r.base).length;
    per.lossless.push({
      i, out: r.base, changed: 0,
      before: rawLen, after: baseLen,
      write: baseLen < rawLen,
      saved: Math.max(0, rawLen - baseLen),
      result: Math.min(rawLen, baseLen),
    });

    for (const rule of OPT_RULES) {
      const g = r.rules[rule];
    if (g.error) { skipped.push(i18n.t("ui.opt.skipTrack",
      { n: i + 1, why: g.error })); continue; }
      per[rule].push({
        i, out: g.out, changed: g.changed, write: g.changed > 0,
        before: r.before, after: g.after, saved: r.before - g.after,
        result: g.after,
      });
    }
  }

  const sum = {};
  for (const way of OPT_WAYS) {
    sum[way] = {
      writes: per[way].filter(w => w.write),
      saved: per[way].reduce((a, w) => a + w.saved, 0),
      changed: per[way].reduce((a, w) => a + w.changed, 0),
      worst: per[way].reduce((m, w) => Math.max(m, w.result), 0),
    };
  }
  const worstNow = (per.lossless ?? []).reduce((m, w) => Math.max(m, w.before), 0);
  optCalc = { sum, skipped, baseOf, worstNow };
}

function openOptimize() {
  optRule = null;

  const hasSel = roll.selectedNotes().length > 0;
  const selBtn = $("#optScope button[data-scope='sel']");
  selBtn.disabled = !hasSel;
  selBtn.title = hasSel ? "" : i18n.t("ui.needSelection");
  if (optScope === "sel" && !hasSel) optScope = "track";

  recalcOpt();
  syncOptUI();
  $("#optBox").classList.add("on");
  $("#optScope button.on")?.focus();
}

const closeOptimize = () => $("#optBox").classList.remove("on");

function syncOptUI() {
  document.querySelectorAll("#optScope button").forEach(b => {
    const on = b.dataset.scope === optScope;
    b.classList.toggle("on", on);
    b.setAttribute("aria-checked", String(on));
  });

  const targets = optTargets();
  const unarmed = targets.some(t => !tracks.zipOf(t.i));

  let alive = 0;
  document.querySelectorAll("#optRules button").forEach(b => {
    const way = b.dataset.rule;
    const s = optCalc.sum[way];
    const armable = way === "lossless" && unarmed;
    const dead = !s || (s.saved <= 0 && !armable);
    b.disabled = dead;
    if (dead && optRule === way) optRule = null;
    if (!dead) alive++;
    const on = !dead && way === optRule;
    b.classList.toggle("on", on);
    b.setAttribute("aria-checked", String(on));
    b.querySelector(".n").textContent = dead
      ? "—"
      : way === "lossless"
      ? (s.saved > 0 ? i18n.t("ui.opt.saveLossless", { n: s.saved })
                     : i18n.t("ui.opt.keepZip"))
      : i18n.t("ui.opt.saveMore", { n: s.saved, changed: s.changed });
  });

  $("#optOk").disabled = optRule === null;

  const chars = $("#optChars");
  const now = optCalc.worstNow;
  const after = optRule ? optCalc.sum[optRule].worst : null;
  const scopeName = i18n.t(optScope === "all" ? "ui.opt.scopeAll" : "ui.opt.scopeOne");
  chars.innerHTML = now
    ? `${scopeName} <b>${now}</b>${after !== null ? ` → <b>${after}</b>` : ""}`
      + i18n.t("ui.charsOfLimit", { max: MAX_TRACK_CHARS })
    : "";
  chars.classList.toggle("over", (after ?? now) > MAX_TRACK_CHARS);

  const notes = [...optCalc.skipped];
  if (!alive) notes.push(i18n.t("ui.opt.nothingLeft"));
  if (optRule === "lossless" && optScope === "sel") notes.push(i18n.t("ui.opt.losslessWholeTrack"));

  const noteEl = $("#optNote");
  noteEl.replaceChildren();
  if (notes.length)
    noteEl.appendChild(document.createTextNode(
      i18n.t("ui.optNoteLine", { list: i18n.list(notes) })));

  const zipped = targets.filter(t => tracks.zipOf(t.i));
  if (zipped.length) {
    const off = document.createElement("button");
    off.type = "button";
    off.className = "link";
    off.textContent = i18n.t("ui.opt.zipOff", { n: zipped.length });
    off.title = i18n.t("ui.opt.zipOffHint");
    off.addEventListener("click", zipOff);
    noteEl.append(" ", off);
  }
}

function zipOff() {
  const zipped = optTargets().filter(t => tracks.zipOf(t.i));
  if (!zipped.length) return;
  history.edit(() => {
    for (const { i } of zipped) tracks.setZip(i, null);
    tracks.persist();
  });
  closeOptimize();
  refresh();
  say(i18n.t("ui.opt.zipOffDone", { n: zipped.length }));
}

function zipArm(targets) {
  history.edit(() => {
    for (const { i } of targets) tracks.setZip(i, ZIP_LOSSLESS);
    tracks.persist();
  });
  closeOptimize();
  refresh();
  say(i18n.t("ui.opt.zipArmed", { n: targets.length }));
}

function applyOptimize() {
  const s = optCalc.sum[optRule];
  const lossless = optRule === "lossless";
  const targets = optTargets();
  if (!s || !s.writes.length) {
    if (lossless && targets.some(t => !tracks.zipOf(t.i))) { zipArm(targets); return; }
    optFail(i18n.t(lossless ? "ui.opt.failLossless" : "ui.opt.failOptimize"));
    return;
  }

  const texts = tracks.trackTexts();
  const writes = s.writes.map(w =>
    ({ i: w.i, out: w.out, before: texts[w.i] ?? "", raw: true }));

  const base = texts.slice(), after = texts.slice();
  for (const w of s.writes) {
    base[w.i] = lossless ? texts[w.i] ?? "" : optCalc.baseOf[w.i];
    after[w.i] = w.out;
  }
  const ok = lossless
    ? sameEvents(parseAll(base), parseAll(after))
    : sameOnsets(parseAll(base), parseAll(after));
  if (!ok) {
    optFail(i18n.t("ui.opt.verifyFailed"));
    return;
  }

  const picks = optScope === "sel"
    ? roll.selectedNotes().map(n => ({ tick: n.tick, midi: n.midi }))
    : null;

  writeBackMany(writes, () => {
    for (const { i } of targets) tracks.setZip(i, ZIP_LOSSLESS);
  });
  closeOptimize();
  if (picks) reselect(picks);
  say(lossless
    ? i18n.t("ui.opt.doneLossless", { n: s.saved })
    : i18n.t("ui.opt.doneOptimize", { n: s.saved, changed: s.changed }));
}

function optFail(msg) { $("#optNote").textContent = msg; }

function initOptimize() {
  $("#optBtn").addEventListener("click", openOptimize);
  $("#optCancel").addEventListener("click", closeOptimize);
  $("#optOk").addEventListener("click", applyOptimize);
  $("#optBox").addEventListener("click", e => {
    if (e.target === $("#optBox")) closeOptimize();
  });
  $("#optScope").addEventListener("click", e => {
    const b = e.target.closest("button[data-scope]");
    if (!b || b.disabled) return;
    optScope = b.dataset.scope;
    recalcOpt();
    syncOptUI();
  });
  $("#optRules").addEventListener("click", e => {
    const b = e.target.closest("button[data-rule]");
    if (!b || b.disabled) return;
    optRule = b.dataset.rule;
    syncOptUI();
  });
  addEventListener("keydown", e => {
    if (e.key === "Escape" && $("#optBox").classList.contains("on")) closeOptimize();
  });
}

const minMainH = () => $("#tabs").offsetHeight + $("#status").offsetHeight;

function minRollH(avail) {
  const stage = $("#stage");
  const scrollbar = Math.max(0, stage.offsetHeight - stage.clientHeight);
  const octaves = RULER_H + MIN_ROLL_OCTAVES * 12 * ROW_H + scrollbar;
  return Math.min(octaves, Math.max(0, avail) / 2);
}

function maxMainH() {
  const avail = document.body.clientHeight
    - $("header").offsetHeight - $("#rollbar").offsetHeight - $("#splitter").offsetHeight;
  return Math.max(minMainH(), avail - minRollH(avail));
}

function setMainH(px) {
  const lo = minMainH(), hi = maxMainH();
  const h = Math.round(Math.min(hi, Math.max(lo, px)));
  $("main").style.flexBasis = h + "px";
  const sp = $("#splitter");
  sp.setAttribute("aria-valuenow", String(h));
  sp.setAttribute("aria-valuemin", String(Math.round(lo)));
  sp.setAttribute("aria-valuemax", String(Math.round(hi)));
  return h;
}

function initSplitter() {
  const sp = $("#splitter"), main = $("main");

  const saved = storage.loadUI()?.mainH;
  setMainH(Number.isFinite(saved) ? saved : main.offsetHeight);

  let startY = 0, startH = 0, dragging = false;
  const remember = () => storage.saveUI({ mainH: main.offsetHeight });

  sp.addEventListener("pointerdown", e => {
    if (e.button !== 0) return;
    dragging = true;
    startY = e.clientY;
    startH = main.offsetHeight;
    sp.classList.add("dragging");
    document.body.classList.add("splitting");
    try { sp.setPointerCapture(e.pointerId); } catch {  }
    e.preventDefault();
  });

  sp.addEventListener("pointermove", e => {
    if (dragging) setMainH(startH - (e.clientY - startY));
  });

  const end = () => {
    if (!dragging) return;
    dragging = false;
    sp.classList.remove("dragging");
    document.body.classList.remove("splitting");
    remember();
  };
  sp.addEventListener("pointerup", end);
  sp.addEventListener("pointercancel", end);

  sp.addEventListener("keydown", e => {
    const step = e.shiftKey ? 50 : 10;
    if (e.key === "ArrowUp") setMainH(main.offsetHeight + step);
    else if (e.key === "ArrowDown") setMainH(main.offsetHeight - step);
    else return;
    e.preventDefault();
    remember();
  });

  addEventListener("resize", () => setMainH(main.offsetHeight));
}

function initHeaderNav() {
  const btn = $("#navToggle");

  const name = (el, text) => {
    el.title = text;
    el.setAttribute("aria-label", text);
  };
  name(btn, i18n.t("ui.hdr.menu"));

  const navOpen = () => $("header").classList.contains("navopen");
  const openNav = on => {
    $("header").classList.toggle("navopen", on);
    btn.setAttribute("aria-expanded", String(on));
  };

  btn.addEventListener("click", () => openNav(!navOpen()));

  $("#navMenu").addEventListener("click", e => {
    if (e.target.closest("button")) openNav(false);
  });

  document.addEventListener("click", e => {
    if (!navOpen()) return;
    if (e.target.closest("#navMenu, #navToggle")) return;
    openNav(false);
  }, true);

  addEventListener("keydown", e => {
    if (e.key !== "Escape" || !navOpen()) return;
    openNav(false);
    btn.focus();
  });

  const wireView = (sel, cls, label) => {
    const b = $(sel);
    if (!b) return;
    name(b, label);
    b.addEventListener("click", () => {
      const hidden = document.body.classList.toggle(cls);
      b.classList.toggle("on", !hidden);
      b.setAttribute("aria-pressed", String(!hidden));
    });
  };
  wireView("#viewTools",  "no-tools",  i18n.t("ui.hdr.tools"));
  wireView("#viewRoll",   "no-roll",   i18n.t("ui.hdr.roll"));
  wireView("#viewEditor", "no-editor", i18n.t("ui.hdr.editor"));
  wireView("#viewStatus", "no-status", i18n.t("ui.hdr.status"));

  initKeyboardHide();
  initPointerClass();
}

function initKeyboardHide() {
  const inScore = el => el instanceof HTMLTextAreaElement && !!el.closest("#panes");
  const sync = () => document.body.classList.toggle("kbd", inScore(document.activeElement));

  addEventListener("focusin", sync);
  addEventListener("focusout", () => setTimeout(sync, 0));
}

function initPointerClass() {
  const cls = document.body.classList;
  if (typeof matchMedia === "function") {
    cls.toggle("coarse", matchMedia("(pointer: coarse)").matches);
  }
  addEventListener("pointerdown", e => {
    const touch = e.pointerType === "touch";
    cls.toggle("touch", touch);
    cls.toggle("fine", !touch);
  }, { capture: true, passive: true });
}

function initDrawers() {
  const scrim = $("#scrim");

  const drawers = [
    { panel: $("#settings"),   close: $("#settingsClose"), opener: "#gear" },
    { panel: $("#aboutPanel"), close: $("#aboutClose"),    opener: "#aboutBtn" },
  ];

  const isOpen = d => d.panel.classList.contains("on");

  const focusBack = sel => ($(sel)?.offsetParent ? $(sel) : $("#navToggle"))?.focus();

  const open = (d, on) => {
    if (on) drawers.forEach(o => { if (o !== d) o.panel.classList.remove("on"); });
    d.panel.classList.toggle("on", on);
    scrim.classList.toggle("on", drawers.some(isOpen));
    if (on) d.close.focus();
    else focusBack(d.opener);
  };

  const closeAll = () => drawers.filter(isOpen).forEach(d => open(d, false));

  for (const d of drawers) {
    $(d.opener).addEventListener("click", () => open(d, !isOpen(d)));
    d.close.addEventListener("click", () => open(d, false));
  }
  scrim.addEventListener("click", closeAll);
  addEventListener("keydown", e => {
    if (e.key === "Escape" && !$("#pasteBox").classList.contains("on")) closeAll();
  });
}

function syncHistoryButtons() {
  $("#undoBtn").disabled = !history.canUndo();
  $("#redoBtn").disabled = !history.canRedo();
}

function initHistoryButtons() {
  for (const [sel, act] of [["#undoBtn", history.undo], ["#redoBtn", history.redo]]) {
    const b = $(sel);
    b.addEventListener("mousedown", e => e.preventDefault());
    b.addEventListener("click", () => act());
  }
}

function initToolbarFocus() {
  for (const sel of ["#rollbar", "#viewToggles"]) {
    const bar = $(sel);
    if (!bar) continue;
    bar.addEventListener("mousedown", e => {
      if (!(e.target instanceof Element)) return;
      const b = e.target.closest("button");
      if (!b || !bar.contains(b)) return;
      if (b.id === "undoBtn" || b.id === "redoBtn") return;
      e.preventDefault();
      focusRoll();
    });
  }
}

function hasSound() {
  const parsed = refresh();
  if (!parsed || !parsed.tracks.slice(0, GAME_TRACKS).some(t => t.notes.length)) {
    say(i18n.t("stage.err.silent"));
    return null;
  }
  return parsed;
}

function renderSetup(parsed) {
  return {
    song: parsed,
    presets: parsed.tracks.map((_, i) => soundPreset(i)),
    bank: bankSource(),
    name: $("#expName")?.value ?? "",
  };
}

// The exporters, once loaded: a reload for a new release waits while one runs.
let wavExport = null, videoExport = null;

// What a reload would lose, or null. Autosave (flushed first) keeps the score
// unless it is off or cannot write; then only a score equal to the library's
// copy is safe.
export function leaveBlocker() {
  if (wavExport?.isBusy() || videoExport?.isBusy()) return i18n.t("pwa.busyExport");
  if ((!storage.isAutosaveOn() || storage.isBroken()) && !savebox.isSaved()) return i18n.t("pwa.unsaved");
  return null;
}

// Offline WAV mixdown (lazy: the exporter and its worker load on first use).
function openWav() {
  const parsed = hasSound();
  if (!parsed) return false;
  if (release.blocked()) return true;
  import("./audio-export.mjs").then(m => { wavExport = m; m.open(renderSetup(parsed)); })
    .catch(err => say(describe(err, i18n.t("wav.failed"))));
  return true;
}

// Waterfall video export, in this page (lazy).
function openVideo() {
  const parsed = hasSound();
  if (!parsed) return false;
  if (release.blocked()) return true;
  import("./video.mjs").then(m => { videoExport = m; m.open(renderSetup(parsed)); })
    .catch(err => say(describe(err, i18n.t("waterfall.err.unknown"))));
  return true;
}

export function init() {
  rememberHintDefaults();

  engine.setStatusHandler(text => { $("#engine").textContent = text; });
  engine.setPresetListHandler(list => setPresets(list));
  player.setStopHandler(onStopped);
  player.setKeyMapper((t, midi) => soundingKey(soundPreset(t), midi));
  storage.setSavedHandler(showStore);
  storage.setErrorHandler(() => {
    renderStore();
    say(i18n.t("ui.store.failed"));
  });

  initBarsPerLine();

  tracks.init({
    onChange: refresh,
    onFocusRoll: focusRoll,
    onInstrumentChange: i => { if (player.isPlaying()) applyInstruments([i]); },
    onSelect: i => {
      roll.setActive(i);
      syncEditable();
      syncRangesFromNative();
      syncSelection();
      syncBarRuler();
    },
    onReorder: (from, to) => history.edit(() => tracks.reorder(from, to)),
    onRemove: i => history.edit(() => tracks.removeTrackAt(i)),
    onAdd: () => history.edit(() => tracks.addTrack()),
    onTyping: () => { syncRangesFromNative(); history.typed(); },
    onMuteChange: applyMutes,
  });

  $("#panes").addEventListener("scroll", syncTextLayerScroll, true);

  initHighlight();
  initTheme();

  $("#panes").addEventListener("compositionstart", () => {
    document.body.classList.add("hl-composing");
  }, true);
  $("#panes").addEventListener("compositionend", () => {
    document.body.classList.remove("hl-composing");
    paintHighlight();
  }, true);

  if (window.ResizeObserver) {
    const ro = new ResizeObserver(syncOverlayWidth);
    for (const ta of document.querySelectorAll(".pane textarea")) ro.observe(ta);
  }

  initHistoryButtons();
  initToolbarFocus();
  history.init({
    snapshot: () => ({ ...tracks.snapshot(), meters: meters.stored(), marks: marks.stored() }),
    restore: s => {
      tracks.applySnapshot(s);
      meters.set(s.meters);
      marks.set(s.marks);
    },
    onApply: refresh,
    onChange: syncHistoryButtons,
  });

  roll.init({
    canvas: $("#roll"),
    padEl: $("#rollpad"),
    scroller: $("#stage"),
    getTrackCount: tracks.trackCount,
    getGhostFlags: tracks.ghostFlags,
    onPickNote: pickNote,
    onRangePick: pickRange,
    onTogglePick: togglePick,
    onSetPicks: setPicks,
    onPickGhost: pickGhost,
    onAddNote: addNote,
    onDeleteNote: removeNote,
    onDeleteSelection: removeNotes,
    onMoveNote: arg => arg.picks ? relocateNotes(arg) : relocateNote(arg),
    onAudition: auditionOn,
    onAuditionEnd: auditionOff,
    onAuditionNote: auditionNote,
    onPlayItem: highlightPlaying,
    onRangeChange,
    onCopySelection: pickedFragment,
    onPasteAt: pasteAt,
    onVelocity: nudgeVelocity,
    onSelectAll: selectAllLane,
    onDuplicate: duplicateSelection,
    isLaneArea,
    onContextMenu: openRollMenu,
    onNoteMenu: openNoteMenu,
    onMeterMenu: openMeterMenu,
    onViewChange: layoutMarks,
    onBarMenu: openBarMenu,
    onJumpText: jumpToText,
    onNonstdFix: fixNonstd,
  });
  roll.setActive(tracks.activeTrack());

  document.addEventListener("keydown", e => { if (e.key === "Tab") quietly(() => {}); }, true);

  document.addEventListener("selectionchange", () => {
    const ta = tracks.activeArea();
    if (document.activeElement !== ta) return;
    if (!progSel) syncRangesFromNative();
    syncSelection(progSel || quietFocus ? null : "text");
  });

  clipboard.init({ onImport: onExternalText, wrapEdit: history.edit });
  filebox.init({
    onImport: onExternalText,
    onClear: () => { if (player.isPlaying()) { selBeforePlay = null; player.stop(); } refresh(); },
    onNew: () => { savebox.forget(); studio.clearOrigin(); },
    wrapEdit: history.edit,
    getSong: refresh,
    onMix: openWav,
    onVideo: openVideo,
  });
  savebox.init({
    onOpen: () => {
      if (player.isPlaying()) { selBeforePlay = null; player.stop(); }
      // A library song is not the Studio copy that was open before it: its
      // source label (and the project Studio preselects on the way back) goes.
      studio.clearOrigin();
      setBarsPerLine(0, false);
      refresh();
    },
    wrapEdit: history.edit,
    getSong: refresh,
  });

  $("#saveOpen").addEventListener("click", () => {
    $("#fileBox").classList.remove("on");
    savebox.open();
  });

  addEventListener("keydown", e => {
    if (!(e.ctrlKey || e.metaKey) || e.altKey || e.shiftKey) return;
    if (e.key.toLowerCase() !== "s") return;
    e.preventDefault();
    savebox.quickSave();
  });

  studio.init({ getTexts: tracks.trackTexts, load: onStudioText });

  initSplitter();
  initHeaderNav();

    showStore(tracks.restoredAt(), i18n.t("ui.store.restored"));

  $("#play").addEventListener("click", onPlayClick);
  $("#stop").addEventListener("click", player.stop);
  addEventListener("keydown", onTransportKey);

  mediakeys.init({
    onPlay:  () => { if (!sounding() && !$("#play").disabled) onPlayClick(); },
    onPause: () => { if (sounding()) onPlayClick(); },
    onStop:  player.stop,
    onSeekBars: n => { if (player.isPlaying()) moveHead(tickPlusBars(headTick(), n)); },
  });
  initLoop();
  initHome();
  initTempo();
  initVelocity();
  initTranspose();
  initMerge();
  initOptimize();
  initKeySig();
  initAutosave();

  initDrawers();

  $("#dls").addEventListener("change", async e => {
    const f = e.target.files[0]; if (!f) return;
    e.target.value = "";
    const pick = ++bankPicks;
    if (defBuiltin) { defMap = new Map(); defNames = new Map(); defLabel = ""; defBuiltin = false; }
    // While the pick is read, play and audition still use the bank the synth
    // holds, so the label keeps naming it, followed by "reading".
    const had = namedBank();
    $("#dlsName").textContent = had ? `${had} · ${i18n.t("ui.bankReading")}` : i18n.t("ui.bankReading");
    // Kept in Studio's local bank store (never uploaded) so the Studio preview
    // and the next Workshop visit use the same bank.
    try {
      await queueBank(async () => {
        if (pick !== bankPicks) return;
        await bankStore.storeBank(f, { current: () => pick === bankPicks }).catch(err => {
          // A bank whose check ran out of time is refused, not handed to the
          // synth, whose worklet would run the same parse on it. So is one
          // that was never checked because the checker did not load in time.
          if (err?.code === "BANK_CHECK_TIMEOUT") throw Error(i18n.t("ui.bankCheckTimeout", { s: Math.round(err.timeoutMs / 1000) }));
          if (err?.code === "BANK_CHECKER_LOAD_TIMEOUT") throw Error(i18n.t("ui.bankCheckerLoadTimeout", { s: Math.round(err.timeoutMs / 1000) }));
          console.warn("[Workshop] bank not stored:", err);
        });
        // Overtaken while it was checked or kept: a newer pick is queued
        // behind it, and the store did not keep this one unless its write
        // had already been sent. It is not loaded.
        if (pick !== bankPicks) return;
        await loadBank(await f.arrayBuffer(), f.name, false, f);
      });
    }
    catch (err) {
      console.error(err);
      // A newer pick is loading or loaded; its label and errors are the ones shown.
      if (pick !== bankPicks) return;
    $("#dlsName").textContent = i18n.t("ui.bankFailed");
    say(describe(err, i18n.t("ui.bankLoadError")));
    }
  });

  $("#gameStyleBank").addEventListener("click", async () => {
    const pick = ++bankPicks;
    const had = namedBank();
    const show = text => { if (pick === bankPicks) $("#dlsName").textContent = had ? `${had} · ${text}` : text; };
    show(i18n.t("ui.bankReading"));
    try {
      await queueBank(async () => {
        if (pick !== bankPicks) return;
        const progress = p => { if (p.phase === "download") show(i18n.t("ui.gameStyleDownloading", { pct: Math.floor((p.received / p.total) * 100) })); };
        const [bank, def] = await Promise.all([loadGameStyleBank({ onProgress: progress }), loadGameStyleDef()]);
        if (pick !== bankPicks) return;
        chooseGameStyle();
        await useGameStyle(bank, def);
      });
    }
    catch (err) {
      console.error(err);
      if (pick !== bankPicks) return;
      $("#dlsName").textContent = i18n.t("ui.bankFailed");
      say(err instanceof GameStyleBankError ? escHtml(gameStyleMessage(err)) : describe(err, i18n.t("ui.gameStyleLoadError")));
    }
  });

  $("#def").addEventListener("change", async e => {
    const f = e.target.files[0]; if (!f) return;
    if (!applyDef(await f.arrayBuffer(), f.name, false)) {
    say(i18n.t("ui.defUnparsed"));
      return;
    }
    if (rawPresets.length && !presets.some(p => defMap.has(p.program)))
    say(i18n.t("ui.defNoMatch", { n: defMap.size }));
  });

  initTimeSig();
  initMarkBox();

  formatInitialTracks();
  history.reset();

  refresh();
}

// Text coming from Studio (a copy of a Studio MML): replaces every tab, like a
// paste, and stays undoable.
function onStudioText(text) {
  if (player.isPlaying()) { selBeforePlay = null; player.stop(); }
  savebox.forget();
  const ok = clipboard.importText(text);
  if (ok) setBarsPerLine(0, false);
  return ok;
}
