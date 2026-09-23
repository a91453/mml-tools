// Studio Workshop — ported from the owner's earlier frontend (owner-authorized port).
// Autosave and UI preferences in localStorage.
// Workshop edits sit outside the Canonical/verified pipeline and are never evidence.
import { cleanMeters, cleanMarks, cleanZip } from "./config.mjs";

export const KEY = "studio-workshop/score";
export const UI_KEY = "studio-workshop/ui";
const VERSION = 1;
const DEBOUNCE = 400;

let timer = null, queued = null, broken = false;

let autosave = true;

let onSaved = () => {};
export const setSavedHandler = fn => { onSaved = fn; };

export const isBroken = () => broken;

function guard(fn, fallback) {
  if (broken) return fallback;
  try {
    return fn();
  } catch (err) {
    broken = true;
    console.warn("[Workshop] localStorage 不能用，這次不暫存:", err);
    return fallback;
  }
}

export function load() {
  const raw = guard(() => localStorage.getItem(KEY), null);
  if (raw == null) return null;

  let s;
  try {
    s = JSON.parse(raw);
  } catch (err) {
    console.warn("[Workshop] 暫存的內容認不出來，這次用預設樂譜:", err);
    return null;
  }
  if (!s || s.v !== VERSION || !Array.isArray(s.texts)) return null;

  return {
    texts:   s.texts.map(t => typeof t === "string" ? t : ""),
    presets: Array.isArray(s.presets) ? s.presets : [],
    ghosts:  Array.isArray(s.ghosts) ? s.ghosts : [],
    zip:     cleanZip(s.zip),
    meters:  cleanMeters(s.meters),
    marks:   cleanMarks(s.marks),
    count:   Number.isInteger(s.count) ? s.count : null,
    active:  Number.isInteger(s.active) ? s.active : 0,
    at:      Number.isFinite(s.at) ? s.at : null,
  };
}

export function save(state) {
  if (!autosave) return;
  queued = state;
  clearTimeout(timer);
  timer = setTimeout(flush, DEBOUNCE);
}

export function flush() {
  clearTimeout(timer); timer = null;
  if (!autosave || !queued) return;
  const state = queued;
  queued = null;
  const at = Date.now();
  guard(() => localStorage.setItem(KEY, JSON.stringify({ v: VERSION, at, ...state })));
  if (!broken) onSaved(at);
}

export function clear() {
  clearTimeout(timer); timer = null; queued = null;
  guard(() => localStorage.removeItem(KEY));
  onSaved(null);
}

export const isAutosaveOn = () => autosave;

export function setAutosave(on) {
  autosave = !!on;
  saveUI({ autosave });
  if (!autosave) { clearTimeout(timer); timer = null; queued = null; }
}

export function loadUI() {
  const raw = guard(() => localStorage.getItem(UI_KEY), null);
  if (raw == null) return null;
  try {
    const s = JSON.parse(raw);
    return s && typeof s === "object" ? s : null;
  } catch (err) {
    console.warn("[Workshop] 版面偏好認不出來，用預設值:", err);
    return null;
  }
}

export function saveUI(prefs) {
  const cur = loadUI() ?? {};
  guard(() => localStorage.setItem(UI_KEY, JSON.stringify({ ...cur, ...prefs })));
}

function cleanWaterfall(w) {
  if (!w || typeof w !== "object") return null;
  const s = v => (typeof v === "string" && v ? v : null);
  return {
    shape: s(w.shape), style: s(w.style), fx: s(w.fx), colors: s(w.colors), speed: s(w.speed),
  };
}

export const saveWaterfall = wf => saveUI({ wf });

export const loadedWaterfall = () =>
  cleanWaterfall(loadUI()?.wf)
  ?? { shape: null, style: null, fx: null, colors: null, speed: null };

autosave = loadUI()?.autosave !== false;

addEventListener("pagehide", flush);
addEventListener("visibilitychange", () => {
  if (document.visibilityState === "hidden") flush();
});
