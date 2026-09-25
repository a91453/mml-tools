// Studio Workshop — ported from the owner's earlier frontend (owner-authorized port).
// Save dialog for the local library.
// Workshop edits sit outside the Canonical/verified pipeline and are never evidence.
import { $, say } from "./util.mjs";
import { bareTrack } from "./mml.mjs";
import { toMml, safeFileName } from "./mml-out.mjs";
import { zipFiles } from "../backup-zip.mjs";
import * as tracks from "./tracks.mjs";
import * as library from "./library.mjs";
import * as meters from "./meters.mjs";
import * as marks from "./marks.mjs";
import * as filebox from "./filebox.mjs";
import * as i18n from "./i18n.mjs";

let onOpen = () => {};
let wrapEdit = fn => fn();
let getSong = () => null;

let files = [];

const picked = new Set();

let savedFingerprint = null;

let lastSaved = null;

let pendingOver = null;
let pendingDel = null;

let hasNotes = false;

const box = () => $("#saveBox");
const overBox = () => $("#saveOverBox");
const delBox = () => $("#saveDelBox");

const nameField = () => $("#saveName");

const tell = msg => { if (msg && !box().classList.contains("on")) say(msg); };

const showErr = msg => { const e = $("#saveErr"); e.textContent = msg; e.hidden = false; tell(msg); };
const clearErr = () => { $("#saveErr").hidden = true; };
const showOk = msg => { const e = $("#saveOk"); e.textContent = msg; e.hidden = !msg; tell(msg); };

const currentSnapshot = () =>
  library.fromSnapshot(tracks.snapshot(), tracks.ghostFlags(), meters.stored(), marks.stored());

function stats() {
  const song = getSong();
  const texts = tracks.trackTexts();
  let n = 0, notes = 0;
  for (let i = 0; i < texts.length; i++) {
    if (bareTrack(texts[i])) n++;
    notes += song?.tracks[i]?.notes.length ?? 0;
  }
  return { tracks: n, notes };
}

export function setHasNotes(has) { hasNotes = has; syncGo(); }

// Nothing to lose on a reload that autosave cannot cover: the score is empty,
// or equal to what was last saved to or opened from the library.
export const isSaved = () => !hasNotes
  || (savedFingerprint !== null && JSON.stringify(currentSnapshot()) === savedFingerprint);

function syncGo() {
  const btn = $("#saveGo");
  if (!btn) return;
  const name = library.cleanName(nameField()?.value);
  btn.disabled = !hasNotes || !name;
  btn.title = !hasNotes ? i18n.t("saveBox.emptyScore")
            : !name ? i18n.t("saveBox.needName")
            : "";
}

function syncDirty() {
  const el = $("#saveDirty");
  if (!el) return;
  if (savedFingerprint === null) { el.hidden = true; return; }
  const dirty = JSON.stringify(currentSnapshot()) !== savedFingerprint;
  el.hidden = false;
  el.textContent = i18n.t(dirty ? "saveBox.dirty" : "saveBox.clean");
  el.classList.toggle("on", dirty);
}

export async function open() {
  clearErr();
  showOk("");
  picked.clear();
  nameField().value = filebox.songName();

  syncGo();
  syncDirty();
  box().classList.add("on");
  await reload();
  nameField().focus();
  nameField().select();
}

const close = () => box().classList.remove("on");

async function reload() {
  const tb = $("#saveRows");

  {
    try {
      files = await library.list();
    } catch {
      files = [];
      tb.textContent = "";
      tb.appendChild(emptyRow(i18n.t("saveBox.dbBroken")));
      $("#saveUsed").textContent = "";
      return;
    }
  }

  const alive = new Set(files.map(f => f.name));
  for (const n of [...picked]) if (!alive.has(n)) picked.delete(n);
  render();
}

const MB = 1024 * 1024;
const mb = n => (n / MB).toFixed(n >= MB / 10 ? 1 : 2);

function render() {
  const tb = $("#saveRows");
  tb.textContent = "";
  if (!files.length) {
    tb.appendChild(emptyRow(i18n.t("saveBox.listEmpty")));
  } else {
    for (const f of files) tb.appendChild(renderRow(f));
  }

  const used = library.usedBytes(files);
  $("#saveUsed").textContent = i18n.t("saveBox.used",
    { used: mb(used), max: Math.round(library.MAX_BYTES / MB), n: files.length });
  syncHit();
  syncFoot();
}

function emptyRow(text) {
  const tr = document.createElement("tr");
  const td = document.createElement("td");
  td.className = "empty";
  td.colSpan = 7;
  td.textContent = text;
  tr.appendChild(td);
  return tr;
}

const when = ms => new Date(ms).toLocaleString(i18n.getLocale(), {
  month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false,
});

function syncHit() {
  const want = library.cleanName(nameField()?.value);
  for (const tr of $("#saveRows").children)
    tr.classList.toggle("hit", tr.dataset.name === want);
}

function renderRow(f) {
  const tr = document.createElement("tr");
  tr.dataset.name = f.name;
  tr.classList.toggle("on", picked.has(f.name));

  const cb = document.createElement("input");
  cb.type = "checkbox";
  cb.checked = picked.has(f.name);
  cb.setAttribute("aria-label", i18n.t("saveBox.pickAria", { name: f.name }));

  const setOn = v => {
    if (v) picked.add(f.name); else picked.delete(f.name);
    cb.checked = v;
    tr.classList.toggle("on", v);
    syncFoot();
  };

  cb.addEventListener("change", () => setOn(cb.checked));

  tr.addEventListener("click", e => {
    if (e.target === cb || e.target.closest("button")) return;
    setOn(!picked.has(f.name));
  });

  tr.append(
    cell(cb),
    cell(f.name, "name"),
    cell(String(f.tracks), "num"),
    cell(f.notes.toLocaleString(i18n.getLocale()), "num"),
    cell(when(f.createdMs), "when"),
    cell(when(f.updatedMs), "when"),
    opsCell(f));
  return tr;
}

function cell(content, cls) {
  const td = document.createElement("td");
  if (cls) td.className = cls;
  if (typeof content === "string") td.textContent = content;
  else td.appendChild(content);
  return td;
}

function opsCell(f) {
  const td = document.createElement("td");
  td.className = "ops";
  td.append(
    op(i18n.t("saveBox.op.open"), i18n.t("saveBox.op.openTitle"), () => openFile(f)),
    op(i18n.t("saveBox.op.delete"), i18n.t("saveBox.op.deleteTitle"), () => askDelete([f.name]), "del"));
  return td;
}

function op(label, title, fn, cls) {
  const b = document.createElement("button");
  b.type = "button";
  b.textContent = label;
  b.title = title;
  if (cls) b.className = cls;
  b.addEventListener("click", () => fn(b));
  return b;
}

function syncFoot() {
  const all = $("#savePickAll");
  if (all) {
    const full = files.length > 0 && picked.size === files.length;
    all.checked = full;
    all.indeterminate = !full && picked.size > 0;
    all.disabled = !files.length;
  }
  const n = picked.size;
  $("#saveZip").disabled = n === 0;
  $("#saveDel").disabled = n === 0;
  $("#savePicked").textContent = n ? i18n.t("saveBox.pickedN", { n }) : "";
}

function save() {
  const name = library.cleanName(nameField().value);
  if (!name || !hasNotes) return;
  const hit = files.find(f => f.name === name);
  if (hit) { askOver(hit); return; }
  write(name, null);
}

function askOver(f) {
  if (!hasNotes) { showErr(i18n.t("saveBox.emptyScore")); return; }
  pendingOver = f;
  $("#saveOverWhat").textContent = i18n.t("saveBox.overWhat", {
    name: f.name, tracks: f.tracks, notes: f.notes, when: when(f.updatedMs),
  });
  overBox().classList.add("on");
  $("#saveOverCancel").focus();
}

const closeOver = () => { overBox().classList.remove("on"); pendingOver = null; };

async function write(name, old) {
  clearErr();
  showOk("");

  const snapshot = currentSnapshot();
  const st = stats();
  let replaced = old !== null;

    const bytes = library.snapshotBytes(snapshot);
    const room = library.fits(library.usedBytes(files), bytes, old?.bytes ?? 0);
    if (!room.ok) {
      showErr(i18n.t("saveBox.full", { need: mb(bytes), free: mb(room.free) }));
      return;
    }
    const at = Date.now();
    try {
      await library.write({
        name,
        createdMs: old?.createdMs ?? at,
        updatedMs: at,
        tracks: st.tracks, notes: st.notes, bytes,
      }, snapshot);
    } catch (err) {
      showErr(err?.name === "QuotaExceededError"
        ? i18n.t("saveBox.quotaExceeded")
        : i18n.t("saveBox.writeFailed", { msg: err?.message ?? "" }));
      return;
    }

  savedFingerprint = JSON.stringify(snapshot);
  lastSaved = { name };
  filebox.setSongName(name);
  nameField().value = name;
  await reload();
  syncDirty();
  syncGo();
  showOk(i18n.t(replaced ? "saveBox.replaced" : "saveBox.saved",
    { name, tracks: st.tracks, notes: st.notes }));
}

export async function quickSave() {
  const b = box();
  if (!b) return;

  if (b.classList.contains("on")) {
    if (!$("#saveGo").disabled) save();
    return;
  }
  if (document.querySelector(".modal.on")) return;

  if (!hasNotes) { say(i18n.t("saveBox.emptyScore")); return; }

  const name = library.cleanName(filebox.songName());
  const same = lastSaved !== null
            && name === lastSaved.name;
  if (!same) { await open(); return; }

  await reload();
  const old = files.find(f => f.name === name) ?? null;
  await write(name, old);
}

async function openFile(f) {
  clearErr();
  let saved;
  try {
    saved = await library.read(f.name);
  } catch {
    showErr(i18n.t("saveBox.dbBroken"));
    return;
  }
  if (!saved) { showErr(i18n.t("saveBox.readFailed", { name: f.name })); return; }

  close();
  wrapEdit(() => {
    tracks.applySnapshot(library.toSnapshot(saved));
    meters.set(library.metersOf(saved));
    marks.set(library.marksOf(saved));
  });
  onOpen();

  savedFingerprint = JSON.stringify(currentSnapshot());
  lastSaved = { name: f.name };
  filebox.setSongName(f.name);

  say(i18n.t("saveBox.opened", { name: f.name, tracks: f.tracks }));
}

function askDelete(names) {
  if (!names.length) return;
  pendingDel = names;
  $("#saveDelWhat").textContent = names.length === 1
    ? i18n.t("saveBox.delOne", { name: names[0] })
    : i18n.t("saveBox.delMany", { n: names.length, names: i18n.list(names) });
  delBox().classList.add("on");
  $("#saveDelCancel").focus();
}

const closeDelete = () => { delBox().classList.remove("on"); pendingDel = null; };

async function doDelete() {
  const names = pendingDel;
  if (!names) return;
  const btn = $("#saveDelOk");
  btn.disabled = true;
  try {
      await library.remove(names);
      closeDelete();
      await reload();
      showOk(i18n.t("saveBox.deleted", { n: names.length }));
  } catch {
    closeDelete();
    showErr(i18n.t("saveBox.dbBroken"));
  } finally {
    btn.disabled = false;
  }
}

function mmlOf(name, saved) {
  const use = saved.tabs.slice(0, saved.count);
  const programs = use.map(t => {
    try { return JSON.parse(t.preset)?.[2] ?? 0; } catch { return 0; }
  });
  return toMml(use.map(t => t.text), { title: name, programs });
}

async function batchZip() {
  clearErr();
  showOk("");
  const btn = $("#saveZip");
  btn.disabled = true;
  try {
    const chosen = files.filter(f => picked.has(f.name));
    const names = library.zipEntryNames(chosen.map(f => f.name));

    const snapshots = await Promise.all(chosen.map(f => library.read(f.name).catch(() => null)));

    const entries = [];
    for (const [i, f] of chosen.entries()) {
      const saved = snapshots[i];
      if (!saved) continue;
      entries.push({ name: names[i], data: new TextEncoder().encode(mmlOf(f.name, saved)) });
    }
    if (!entries.length) { showErr(i18n.t("saveBox.zipEmpty")); return; }

    const buf = await zipFiles(entries);
    const a = document.createElement("a");
    const blob = new Blob([buf], { type: "application/zip" });
    a.href = URL.createObjectURL(blob);
    a.download = `${safeFileName(i18n.t("saveBox.zipName"))}-${stamp()}.zip`;
    a.click();
    URL.revokeObjectURL(a.href);
    showOk(i18n.t("saveBox.zipped", { n: entries.length }));
  } catch (err) {
    showErr(i18n.t("saveBox.zipFailed", { msg: err?.message ?? "" }));
  } finally {
    btn.disabled = false;
    syncFoot();
  }
}

function stamp() {
  const d = new Date();
  const p = n => String(n).padStart(2, "0");
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}`;
}

export function init({ onOpen: opened, wrapEdit: wrap, getSong: song } = {}) {
  onOpen = opened ?? onOpen;
  wrapEdit = wrap ?? wrapEdit;
  getSong = song ?? getSong;

  const b = box();
  if (!b) return;

  $("#saveGo").addEventListener("click", save);


  nameField().addEventListener("input", () => {
    filebox.setSongName(nameField().value);
    syncGo();
    syncHit();
  });
  nameField().addEventListener("keydown", e => {
    if (e.key !== "Enter") return;
    e.preventDefault();
    if (!$("#saveGo").disabled) save();
  });

  $("#savePickAll").addEventListener("change", e => {
    picked.clear();
    if (e.target.checked) for (const f of files) picked.add(f.name);
    render();
  });
  $("#saveZip").addEventListener("click", batchZip);
  $("#saveDel").addEventListener("click", () => askDelete([...picked]));


  $("#saveOverCancel").addEventListener("click", closeOver);
  $("#saveOverOk").addEventListener("click", () => {
    const f = pendingOver;
    closeOver();
    if (f) write(f.name, f);
  });

  $("#saveDelCancel").addEventListener("click", closeDelete);
  $("#saveDelOk").addEventListener("click", doDelete);

  for (const el of [b, overBox(), delBox()])
    el.addEventListener("click", e => { if (e.target === el) el.classList.remove("on"); });

  addEventListener("keydown", e => {
    if (e.key !== "Escape") return;
    if (overBox().classList.contains("on")) { closeOver(); return; }
    if (delBox().classList.contains("on")) { closeDelete(); return; }
    if (b.classList.contains("on")) close();
  });
}

export function forget() {
  savedFingerprint = null;
  detach();
}

export function detach() { lastSaved = null; }
