// Studio Workshop — ported from the owner's earlier frontend (owner-authorized port).
// Track tabs, text panes and per-track instruments.
// Workshop edits sit outside the Canonical/verified pipeline and are never evidence.
import {
  MAX_TRACKS, GAME_TRACKS, MIN_TRACKS, MAX_TRACK_CHARS, HARD_TRACK_CHARS,
  TRACK_COLORS, DEMO, ZIP_LOSSLESS,
} from "./config.mjs";
import { $, clamp, shiftIndex, slotToIndex, indexAfterRemove } from "./util.mjs";
import { nonstdCount } from "./mml-in.mjs";
import { say } from "./util.mjs";
import { bareTrack } from "./mml.mjs";
import {
  presetLabel, presetName, MOBILE_INSTRUMENTS, mobilePresetValue, mobileName, mobileForProgram,
  mobileInstrument, DEFAULT_PRESET_VALUE,
} from "./instruments.mjs";
import { icon, setIcon } from "./icons.mjs";
import * as storage from "./storage.mjs";
import * as meters from "./meters.mjs";
import * as marks from "./marks.mjs";
import * as i18n from "./i18n.mjs";

const cap = s => (s ?? "").slice(0, HARD_TRACK_CHARS);

export const effectiveLength = text => bareTrack(text).length;

const picked = Array(MAX_TRACKS).fill(null);

const muted = Array(MAX_TRACKS).fill(false);

const ghost = Array(MAX_TRACKS).fill(true);

const zip = Array(MAX_TRACKS).fill(null);

let count = MIN_TRACKS;

let active = 0;
let restoredAtMs = null;

let onChange = () => {};
let onInstrument = () => {};
let onMute = () => {};
let onSelect = () => {};
let onReorder = () => {};
let onRemove = () => {};
let onAdd = () => {};
let onTyping = () => {};
let onFocusRoll = () => {};

export const trackCount = () => count;
export const activeTrack = () => active;

export const restoredAt = () => restoredAtMs;

const selects = () => [...document.querySelectorAll(".trk-inst")];
const areas   = () => [...document.querySelectorAll(".pane textarea")];

export const trackTexts = () => areas().slice(0, count).map(a => a.value);

export function persist() {
  if (!areas().length) return;
  storage.save({
    count, active,
    texts: areas().map(a => a.value),
    presets: [...picked],
    ghosts: [...ghost],
    zip: [...zip],
    meters: meters.stored(),
    marks: marks.stored(),
  });
}

function touch() {
  persist();
  onChange();
}

export function init({ onChange: change, onInstrumentChange, onSelect: select,
                       onTyping: typing, onReorder: reorderCb, onRemove: removeCb,
                       onAdd: addCb, onMuteChange, onFocusRoll: focusRoll } = {}) {
  onChange = change ?? onChange;
  onInstrument = onInstrumentChange ?? onInstrument;
  onMute = onMuteChange ?? onMute;
  onSelect = select ?? onSelect;
  onTyping = typing ?? onTyping;
  onReorder = reorderCb ?? onReorder;
  onRemove = removeCb ?? onRemove;
  onAdd = addCb ?? onAdd;
  onFocusRoll = focusRoll ?? onFocusRoll;

  const saved = storage.load();
  if (saved) {
    restoredAtMs = saved.at;
    if (saved.count !== null) count = clamp(saved.count, MIN_TRACKS, MAX_TRACKS);
    active = clamp(saved.active, 0, count - 1);
    for (let i = 0; i < MAX_TRACKS; i++) if (saved.presets[i]) picked[i] = saved.presets[i];
    setGhosts(saved.ghosts);
    setZip_all(saved.zip);
    meters.set(saved.meters);
    marks.set(saved.marks);
  }

  const tabs = $("#tabs"), panes = $("#panes");

  for (let i = 0; i < MAX_TRACKS; i++) {
    const tab = document.createElement("button");
    tab.className = "tab";
    tab.style.setProperty("--tab", TRACK_COLORS[i]);
    tab.innerHTML = `<i></i><span class="nm">${i18n.trackName(i)}</span><span class="inst"></span>`;
    tab.title = tabTitle(i);
    tab.addEventListener("click", () => selectTrack(i));
    initTabDrag(tab, i);

    const dot = tab.querySelector("i");
    dot.title = i18n.t("tracks.ghostHint");
    dot.addEventListener("click", e => { e.stopPropagation(); toggleGhost(i); });

    const x = document.createElement("span");
    x.className = "x"; x.textContent = "✕"; x.title = i18n.t("tracks.removeTitle");
    x.draggable = false;
    x.addEventListener("click", e => { e.stopPropagation(); onRemove(i); });
    tab.appendChild(x);
    tabs.appendChild(tab);

    const pane = document.createElement("div");
    pane.className = "pane";

    const bar = document.createElement("div");
    bar.className = "panebar";
    bar.innerHTML = `<span class="lbl">${i18n.t("tracks.instrumentLabel")}</span>`;

    const sel = document.createElement("select");
    sel.className = "trk-inst";
    fillSelect(sel, picked[i]);
    picked[i] = sel.value;
    sel.addEventListener("change", () => {
      picked[i] = sel.value;
      syncTabLabels();
      persist();
      onInstrument(i);
    });
    bar.appendChild(sel);

    const toggles = document.createElement("span");
    toggles.className = "grp";
    bar.appendChild(toggles);

    const mute = document.createElement("button");
    mute.type = "button";
    mute.className = "iconbtn toggle trk-mute";
    mute.setAttribute("aria-pressed", "false");
    mute.setAttribute("aria-label", i18n.t("tracks.muteAria", { track: i18n.trackName(i) }));
    mute.innerHTML = icon("volume-high");
    mute.addEventListener("click", () => toggleMute(i));
    toggles.appendChild(mute);

    const soloPlayBtn = document.createElement("button");
    soloPlayBtn.type = "button";
    soloPlayBtn.className = "iconbtn toggle trk-soloplay";
    soloPlayBtn.setAttribute("aria-pressed", "false");
    soloPlayBtn.setAttribute("aria-label",
      i18n.t("tracks.soloPlayAria", { track: i18n.trackName(i) }));
    soloPlayBtn.innerHTML = icon("bullhorn");
    soloPlayBtn.addEventListener("click", () => soloPlay(i));
    toggles.appendChild(soloPlayBtn);

    const ghostBtn = document.createElement("button");
    ghostBtn.type = "button";
    ghostBtn.className = "iconbtn toggle trk-ghost";
    ghostBtn.setAttribute("aria-pressed", "false");
    ghostBtn.setAttribute("aria-label",
      i18n.t("tracks.ghostAria", { track: i18n.trackName(i) }));
    ghostBtn.innerHTML = icon("eye");
    ghostBtn.addEventListener("click", () => toggleGhost(i));
    toggles.appendChild(ghostBtn);

    const soloBtn = document.createElement("button");
    soloBtn.type = "button";
    soloBtn.className = "iconbtn toggle trk-solo";
    soloBtn.setAttribute("aria-pressed", "false");
    soloBtn.setAttribute("aria-label",
      i18n.t("tracks.soloAria", { track: i18n.trackName(i) }));
    soloBtn.innerHTML = icon("arrows-to-eye");
    soloBtn.addEventListener("click", () => soloGhost(i));
    toggles.appendChild(soloBtn);

    for (const b of [mute, soloPlayBtn, ghostBtn, soloBtn]) {
      b.addEventListener("mousedown", e => e.preventDefault());
    }

    const meta = document.createElement("span");
    meta.className = "meta";
    bar.appendChild(meta);

    const ta = document.createElement("textarea");
    ta.spellcheck = false;
    ta.value = cap(saved ? saved.texts[i] : DEMO[i]);
    ta.addEventListener("input", e => {
      if (e.inputType === "insertFromPaste") {
        const n = nonstdCount(ta.value);
        if (n) say(i18n.t("clip.nonstd", { n }));
      }
      zip[i] = null;
      onTyping(); touch();
    });

    const row = document.createElement("div");
    row.className = "tarow";
    const gut = document.createElement("div");
    gut.className = "barnum";
    gut.setAttribute("aria-hidden", "true");
    gut.appendChild(document.createElement("div")).className = "barnum-in";

    const clip = document.createElement("div");
    clip.className = "taclip";
    const hlclip = document.createElement("div");
    hlclip.className = "hlclip";
    hlclip.setAttribute("aria-hidden", "true");
    hlclip.appendChild(document.createElement("pre")).className = "mml-hl";
    clip.append(hlclip, ta);

    row.append(gut, clip);

    pane.append(bar, row);
    panes.appendChild(pane);
  }

  const add = document.createElement("button");
  add.className = "tab add"; add.id = "addTab"; add.textContent = i18n.t("tracks.addTab");
  add.addEventListener("click", () => onAdd());
  tabs.appendChild(add);

  syncTabs();
  syncGhosts();
}

export function selectTrack(i) {
  if (i >= count) return;
  active = i;
  syncTabs();
  onFocusRoll();
  persist();
  onSelect(i);
}

export function setReadOnly(ro) {
  for (const a of areas()) a.readOnly = ro;
}

export const activeArea = () => areas()[active] ?? null;

export const activeGutter = () => document.querySelectorAll(".pane .barnum")[active] ?? null;

export const activeOverlay = () => document.querySelectorAll(".pane .mml-hl")[active] ?? null;

export function setTrackText(i, text) {
  const a = areas()[i];
  if (!a) return;
  a.value = text;
  touch();
}

export const zipOf = i => zip[i] ?? null;

export function setZip(i, mode) {
  if (i < 0 || i >= MAX_TRACKS) return;
  zip[i] = mode === ZIP_LOSSLESS ? ZIP_LOSSLESS : null;
}

export const snapshot = () => ({
  texts: areas().map(a => a.value),
  presets: [...picked],
  mutes: [...muted],
  zip: [...zip],
  count, active,
});

export function applySnapshot(s) {
  const a = areas();
  for (let i = 0; i < MAX_TRACKS; i++) a[i].value = s.texts[i] ?? "";
  if (Array.isArray(s.presets)) setPicked(s.presets);
  if (Array.isArray(s.mutes)) setMuted(s.mutes);
  if (Array.isArray(s.ghosts)) setGhosts(s.ghosts);
  if (Array.isArray(s.zip)) setZip_all(s.zip);
  count = clamp(s.count, MIN_TRACKS, MAX_TRACKS);
  active = clamp(s.active, 0, count - 1);
  syncTabs();
  syncTabLabels();
  syncMutes();
  syncGhosts();
  persist();
  onMute();
  onSelect(active);
}

function setPicked(list) {
  const sel = selects();
  for (let i = 0; i < MAX_TRACKS; i++) {
    const v = list[i] ?? null;
    picked[i] = v;
    const s = sel[i];
    if (s && v && [...s.options].some(o => o.value === v)) s.value = v;
  }
}

export function reorder(from, to) {
  if (!Number.isInteger(from) || !Number.isInteger(to) || from === to) return false;
  if (from < 0 || from >= count || to < 0 || to >= count) return false;

  const a = areas();
  const texts = a.slice(0, count).map(x => x.value);
  const ps = picked.slice(0, count);
  const ms = muted.slice(0, count);
  const gs = ghost.slice(0, count);
  const zs = zip.slice(0, count);
  const move = arr => { const [x] = arr.splice(from, 1); arr.splice(to, 0, x); };
  move(texts);
  move(ps);
  move(ms);
  move(gs);
  move(zs);

  for (let i = 0; i < count; i++) a[i].value = texts[i];
  setPicked([...ps, ...picked.slice(count)]);
  setMuted([...ms, ...muted.slice(count)]);
  setGhosts([...gs, ...ghost.slice(count)]);
  setZip_all([...zs, ...zip.slice(count)]);

  active = shiftIndex(active, from, to);

  syncTabs();
  syncTabLabels();
  syncMutes();
  syncGhosts();
  touch();
  onMute();
  onSelect(active);
  return true;
}

export function addTrack() {
  if (count >= MAX_TRACKS) return false;
  count++;
  resetMutes(count - 1, count);
  ghost[count - 1] = true;
  zip[count - 1] = null;
  syncGhosts();
  selectTrack(count - 1);
  touch();
  return true;
}

export function removeTrackAt(i) {
  if (count <= MIN_TRACKS) return false;
  if (!Number.isInteger(i) || i < 0 || i >= count) return false;

  const a = areas();
  if (a[i].value.trim() &&
      !confirm(i18n.t("tracks.confirmRemove", { track: i18n.trackName(i) }))) return false;

  const texts = a.slice(0, count).map(x => x.value);
  const ps = picked.slice(0, count);
  const ms = muted.slice(0, count);
  const gs = ghost.slice(0, count);
  const zs = zip.slice(0, count);
  texts.splice(i, 1); texts.push("");
  ps.splice(i, 1); ps.push(null);
  ms.splice(i, 1); ms.push(false);
  gs.splice(i, 1); gs.push(true);
  zs.splice(i, 1); zs.push(null);
  for (let k = 0; k < count; k++) a[k].value = texts[k];
  setPicked([...ps, ...picked.slice(count)]);
  setMuted([...ms, ...muted.slice(count)]);
  setGhosts([...gs, ...ghost.slice(count)]);
  setZip_all([...zs, ...zip.slice(count)]);

  count--;
  active = indexAfterRemove(active, i, count);

  resetInstruments(count, count + 1);

  syncTabs();
  syncTabLabels();
  syncMutes();
  syncGhosts();
  touch();
  onMute();
  return true;
}

let dragTab = -1;
let dropSlot = -1;

const clearDropMarks = () => {
  dropSlot = -1;
  document.querySelectorAll("#tabs .tab.dropL, #tabs .tab.dropR")
    .forEach(t => t.classList.remove("dropL", "dropR"));
};

function markSlot(slot) {
  if (dropSlot === slot) return;
  clearDropMarks();
  dropSlot = slot;
  const tabs = [...document.querySelectorAll("#tabs .tab:not(.add)")];
  if (slot < count) tabs[slot]?.classList.add("dropL");
  else tabs[count - 1]?.classList.add("dropR");
}

function initTabDrag(tab, i) {
  tab.draggable = true;

  tab.addEventListener("dragstart", e => {
    if (i >= count) { e.preventDefault(); return; }
    dragTab = i;
    e.dataTransfer.effectAllowed = "move";
    e.dataTransfer.setData("text/plain", String(i));
    tab.classList.add("dragging");
    $("#tabs").classList.add("dragging");
  });

  tab.addEventListener("dragend", () => {
    dragTab = -1;
    tab.classList.remove("dragging");
    $("#tabs").classList.remove("dragging");
    clearDropMarks();
  });

  tab.addEventListener("dragover", e => {
    if (dragTab < 0 || i >= count) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = "move";
    const r = tab.getBoundingClientRect();
    markSlot(e.clientX < r.left + r.width / 2 ? i : i + 1);
  });

  tab.addEventListener("drop", e => {
    e.preventDefault();
    const from = dragTab, slot = dropSlot;
    dragTab = -1;
    clearDropMarks();
    if (from < 0 || slot < 0) return;
    const to = slotToIndex(from, slot);
    if (to !== from) onReorder(from, to);
  });
}

export function syncTabs() {
  const tabs = [...document.querySelectorAll("#tabs .tab:not(.add)")];
  tabs.forEach((t, i) => {
    t.classList.toggle("hidden", i >= count);
    t.classList.toggle("on", i === active);
  });
  $("#tabs").classList.toggle("noremove", count <= MIN_TRACKS);
  document.querySelectorAll(".pane").forEach((p, i) => p.classList.toggle("on", i === active));
  $("#addTab").classList.toggle("hidden", count >= MAX_TRACKS);

  $("#tabs").classList.toggle("wrap", count > GAME_TRACKS);
}

export const instNameOf = i => selects()[i]?.selectedOptions[0]?.dataset.name ?? "";

export function syncTabLabels() {
  const sel = selects();
  document.querySelectorAll("#tabs .tab:not(.add) .inst").forEach((el, i) => {
    const name = sel[i]?.selectedOptions[0]?.dataset.name;
    el.textContent = name ? `(${name})` : "";
  });
}

const tabTitle = i =>
  i18n.t("tracks.tabTitle", {
    track: i18n.trackName(i),
    muted: muted[i] ? i18n.t("tracks.mutedSuffix") : "",
  });

export const mutedFlags = () => [...muted];

export function syncMutes() {
  document.querySelectorAll(".pane .trk-mute").forEach((b, i) => {
    const on = muted[i];
    b.classList.toggle("on", on);
    b.setAttribute("aria-pressed", String(on));
    b.title = i18n.t(on ? "tracks.muteOnHint" : "tracks.muteOffHint",
      { track: i18n.trackName(i) });
    setIcon(b, on ? "volume-xmark" : "volume-high");
  });
  document.querySelectorAll(".pane .trk-soloplay").forEach((b, i) => {
    const solo = isSoloPlay(i);
    b.classList.toggle("on", solo);
    b.setAttribute("aria-pressed", String(solo));
    b.title = i18n.t(solo ? "tracks.soloPlayOnHint" : "tracks.soloPlayOffHint",
      { track: i18n.trackName(i) });
  });
  document.querySelectorAll("#tabs .tab:not(.add)").forEach((t, i) => {
    t.classList.toggle("muted", muted[i]);
    t.title = tabTitle(i);
  });
}

export function toggleMute(i) {
  if (!Number.isInteger(i) || i < 0 || i >= MAX_TRACKS) return;
  muted[i] = !muted[i];
  syncMutes();
  onMute();
}

function setMuted(list) {
  for (let i = 0; i < MAX_TRACKS; i++) muted[i] = !!list?.[i];
}

const isSoloPlay = i =>
  !muted[i] && muted.every((m, j) => j === i || j >= count || m);

export function soloPlay(i) {
  if (!Number.isInteger(i) || i < 0 || i >= MAX_TRACKS) return;
  const solo = isSoloPlay(i);
  for (let j = 0; j < count; j++) muted[j] = !solo && j !== i;
  syncMutes();
  onMute();
}

export const ghostFlags = () => [...ghost];

export function syncGhosts() {
  document.querySelectorAll(".pane .trk-ghost").forEach((b, i) => {
    const shown = ghost[i];
    b.classList.toggle("on", !shown);
    b.setAttribute("aria-pressed", String(!shown));
    b.title = i18n.t(shown ? "tracks.ghostOffHint" : "tracks.ghostOnHint",
      { track: i18n.trackName(i) });
    setIcon(b, shown ? "eye" : "eye-slash");
  });
  document.querySelectorAll(".pane .trk-solo").forEach((b, i) => {
    const solo = isSolo(i);
    b.classList.toggle("on", solo);
    b.setAttribute("aria-pressed", String(solo));
    b.title = i18n.t(solo ? "tracks.soloOnHint" : "tracks.soloOffHint",
      { track: i18n.trackName(i) });
  });
  document.querySelectorAll("#tabs .tab:not(.add) i").forEach((dot, i) => {
    dot.classList.toggle("off", !ghost[i]);
    dot.title = i18n.t("tracks.ghostHint");
  });
}

export function toggleGhost(i) {
  if (!Number.isInteger(i) || i < 0 || i >= MAX_TRACKS) return;
  ghost[i] = !ghost[i];
  syncGhosts();
  persist();
  onSelect(active);
}

const isSolo = i =>
  ghost[i] && ghost.every((g, j) => j === i || j >= count || !g);

export function soloGhost(i) {
  if (!Number.isInteger(i) || i < 0 || i >= MAX_TRACKS) return;
  const solo = isSolo(i);
  for (let j = 0; j < count; j++) ghost[j] = solo || j === i;
  syncGhosts();
  persist();
  onSelect(active);
}

function setGhosts(list) {
  for (let i = 0; i < MAX_TRACKS; i++) ghost[i] = list?.[i] !== false;
}

function setZip_all(list) {
  for (let i = 0; i < MAX_TRACKS; i++)
    zip[i] = list?.[i] === ZIP_LOSSLESS ? ZIP_LOSSLESS : null;
}

export function resetMutes(from = 0, to = MAX_TRACKS) {
  let changed = false;
  for (let i = Math.max(0, from); i < Math.min(MAX_TRACKS, to); i++) {
    if (muted[i]) { muted[i] = false; changed = true; }
  }
  if (changed) { syncMutes(); onMute(); }
  return changed;
}

export function setTexts(parts, from = 0) {
  const a = areas();
  for (let i = Math.max(0, from); i < MAX_TRACKS; i++) {
    a[i].value = cap(parts[i - from]);
    zip[i] = null;
  }
}

export function reset(n, to = 0) {
  count = clamp(n, MIN_TRACKS, MAX_TRACKS);
  active = clamp(to, 0, count - 1);
  syncTabs();
  persist();
}

export function appendAt() {
  const a = areas();
  let last = -1;
  for (let i = 0; i < MAX_TRACKS; i++) if (bareTrack(a[i].value)) last = i;
  return last + 1;
}

export function enableInstruments() {
  for (const sel of selects()) sel.disabled = false;
}

const wantProg = Array(MAX_TRACKS).fill(null);
let presetList = [];
let progNames = new Map();
let bankNames = { defMap: new Map(), defNames: new Map(), label: "" };

export const programName = prog =>
  progNames.get(prog) ?? (mobileForProgram(prog) ? mobileName(mobileForProgram(prog)) : "");

export function requestProgram(ch, program) {
  if (ch >= 0 && ch < MAX_TRACKS && Number.isInteger(program)) wantProg[ch] = program;
}

// An imported program number picks the Mobile instrument with that GM program
// first, then a preset of the loaded bank; otherwise the track is left alone.
export function applyPrograms() {
  let changed = false;
  for (let i = 0; i < MAX_TRACKS; i++) {
    const want = wantProg[i];
    if (want === null) continue;
    const mobile = mobileForProgram(want);
    const hit = mobile ? null : presetList.find(p => p.program === want);
    if (!mobile && !hit) { if (presetList.length) wantProg[i] = null; continue; }
    wantProg[i] = null;
    const v = mobile ? mobilePresetValue(mobile) : JSON.stringify([hit.bankMSB, hit.bankLSB, hit.program]);
    picked[i] = v;
    const sel = selects()[i];
    if (sel && [...sel.options].some(o => o.value === v)) sel.value = v;
    changed = true;
  }
  if (changed) { syncTabLabels(); persist(); }
  return changed;
}

function fillSelect(sel, keep) {
  sel.replaceChildren();
  const mobile = document.createElement("optgroup");
  mobile.label = i18n.t("tracks.mobileGroup");
  for (const m of MOBILE_INSTRUMENTS) {
    const o = document.createElement("option");
    o.textContent = mobileName(m);
    o.dataset.name = mobileName(m);
    o.value = mobilePresetValue(m);
    o.title = m.kit ? i18n.t("tracks.kitHint", { keys: m.kit.join("/") }) : i18n.t("tracks.gmHint", { program: m.program });
    mobile.appendChild(o);
  }
  sel.appendChild(mobile);
  if (presetList.length) {
    const bank = document.createElement("optgroup");
    bank.label = bankNames.label ? i18n.t("tracks.bankGroupNamed", { bank: bankNames.label }) : i18n.t("tracks.bankGroup");
    for (const p of presetList) {
      const o = document.createElement("option");
      o.textContent = presetLabel(p, bankNames.defMap, bankNames.defNames);
      o.dataset.name = presetName(p, bankNames.defMap, bankNames.defNames);
      o.value = JSON.stringify([p.bankMSB, p.bankLSB, p.program]);
      bank.appendChild(o);
    }
    sel.appendChild(bank);
  } else if (keep && !isMobileValue(keep)) {
    // A bank preset chosen earlier stays selected until its bank is loaded again.
    const o = document.createElement("option");
    const p = parsePreset(keep);
    o.textContent = i18n.t("tracks.bankPresetPending", { program: String(p?.[2] ?? 0).padStart(3, "0") });
    o.dataset.name = o.textContent;
    o.value = keep;
    sel.appendChild(o);
  }
  sel.value = keep && [...sel.options].some(o => o.value === keep) ? keep : DEFAULT_PRESET_VALUE;
}

const parsePreset = raw => { try { const v = JSON.parse(raw); return Array.isArray(v) ? v : null; } catch { return null; } };
const isMobileValue = raw => !!mobileInstrument(parsePreset(raw)?.[3]);

export function fillInstruments(presets, defMap, defNames, label = "") {
  presetList = presets ?? [];
  bankNames = { defMap: defMap ?? new Map(), defNames: defNames ?? new Map(), label };
  progNames = new Map(presetList.map(p => [p.program, presetName(p, bankNames.defMap, bankNames.defNames)]));
  for (const [i, sel] of selects().entries()) {
    fillSelect(sel, picked[i]);
    picked[i] = sel.value;
  }
  syncTabLabels();

  applyPrograms();
}

export function resetInstruments(from = 0, to = MAX_TRACKS) {
  for (const [i, sel] of selects().entries()) {
    if (i < from || i >= to) continue;
    wantProg[i] = null;
    if (!sel?.options.length) continue;
    sel.value = DEFAULT_PRESET_VALUE;
    picked[i] = sel.value;
  }
  syncTabLabels();
  persist();
}

export function presetOf(ch) {
  const raw = picked[ch];
  if (!raw) return null;
  return parsePreset(raw);
}

export const programs = () =>
  Array.from({ length: MAX_TRACKS }, (_, ch) => presetOf(ch)?.[2] ?? 0);

// Per-track Mobile instrument ids (null for a bank preset), for exports that
// carry names rather than program numbers.
export const instrumentIds = () =>
  Array.from({ length: MAX_TRACKS }, (_, ch) => mobileInstrument(presetOf(ch)?.[3])?.id ?? null);

export function setNoteCounts(counts) {
  const a = areas();
  document.querySelectorAll(".pane .meta").forEach((m, i) => {
    if (i >= count) { m.replaceChildren(); m.classList.remove("full"); m.title = ""; return; }
    const len = effectiveLength(a[i].value);
    m.replaceChildren();
    if (zip[i]) {
      const z = document.createElement("span");
      z.className = "zip";
      z.innerHTML = icon("compress");
      z.title = i18n.t("tracks.zipLossless");
      z.setAttribute("role", "img");
      z.setAttribute("aria-label", i18n.t("tracks.zipLossless"));
      m.appendChild(z);
    }
    m.appendChild(document.createTextNode(i18n.t("tracks.counter",
      { notes: counts[i] ?? 0, len, max: MAX_TRACK_CHARS })));
    m.title = len > MAX_TRACK_CHARS
      ? i18n.t("tracks.overLimit", { n: len - MAX_TRACK_CHARS })
      : i18n.t("tracks.counterHint");
    m.classList.toggle("full", len > MAX_TRACK_CHARS);
  });
}
