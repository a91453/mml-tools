// Studio Workshop: 「從 Studio 開啟」 and 「送回 Studio 驗證」.
//
// Opening reads a project straight from Studio Web's own IndexedDB
// (../storage.mjs, read-only here) and loads a COPY of one of its MML strings
// into the editor. Sending leaves the six game tracks for Studio
// (../workshop-link.mjs) and navigates there; Studio imports them through its
// normal source intake as a derived candidate and validates them itself.
// Nothing in the Workshop is a Studio check, and nothing here can mark a
// project VALIDATED or accepted.
import * as i18n from "./i18n.mjs";
import { $, say } from "./util.mjs";
import { listProjectSummaries, loadProject } from "../storage.mjs";
import { projectSources, parseWorkshopHash, putReturn } from "../workshop-link.mjs";
import { studioToWorkshop, workshopToStudio } from "./studio-mml.mjs";

export const ORIGIN_KEY = "studio-workshop/origin";
const STUDIO_HOME = new URL("../../../index.html", import.meta.url);

let hooks = { getTexts: () => [], load: () => false };
let projects = [];
let current = null;
let pending = null;

const esc = v => String(v ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

function readOrigin() {
  try { const o = JSON.parse(localStorage.getItem(ORIGIN_KEY) ?? "null"); return o && typeof o === "object" ? o : null; }
  catch { return null; }
}
function writeOrigin(origin) {
  try {
    if (origin) localStorage.setItem(ORIGIN_KEY, JSON.stringify(origin));
    else localStorage.removeItem(ORIGIN_KEY);
  } catch { }
  syncOrigin();
}
export const clearOrigin = () => writeOrigin(null);
export const origin = readOrigin;

function syncOrigin() {
  const o = readOrigin();
  const chip = $("#studioOrigin");
  if (!chip) return;
  chip.hidden = !o;
  $("#studioOriginText").textContent = o ? i18n.t("studio.origin", { title: o.title || "—", source: o.label || o.slot }) : "";
}

// ─── Open from Studio ───────────────────────────────────────────────────────

const box = () => $("#studioBox");
const showErr = msg => { const e = $("#studioErr"); e.textContent = msg; e.hidden = !msg; };

async function openBox() {
  showErr("");
  box().classList.add("on");
  const sel = $("#studioProject");
  sel.replaceChildren();
  $("#studioRows").replaceChildren();
  try { projects = await listProjectSummaries(); }
  catch (err) { projects = []; showErr(i18n.t("studio.dbFailed", { msg: err?.message ?? "" })); return; }
  if (!projects.length) { showErr(i18n.t("studio.noProjects")); return; }
  for (const p of projects) {
    const o = document.createElement("option");
    o.value = p.id;
    o.textContent = p.title || p.id;
    sel.append(o);
  }
  const want = readOrigin()?.projectId;
  if (want && projects.some(p => p.id === want)) sel.value = want;
  await showProject(sel.value);
  sel.focus();
}

async function showProject(id) {
  const rows = $("#studioRows");
  rows.replaceChildren();
  showErr("");
  try { current = await loadProject(id); }
  catch (err) { current = null; showErr(i18n.t("studio.dbFailed", { msg: err?.message ?? "" })); return; }
  const sources = projectSources(current);
  if (!sources.length) { showErr(i18n.t("studio.noMml")); return; }
  for (const s of sources) {
    const tr = document.createElement("tr");
    tr.innerHTML = `<td>${esc(s.label)}<br><small>${esc(s.name)}</small></td><td class="num">${s.mml.length.toLocaleString(i18n.getLocale())}</td><td class="ops"></td>`;
    const b = document.createElement("button");
    b.type = "button";
    b.className = "act";
    b.dataset.slot = s.slot;
    b.textContent = i18n.t("studio.openCopy");
    b.addEventListener("click", () => openSource(current, s));
    tr.lastElementChild.append(b);
    rows.append(tr);
  }
}

function openSource(workspace, source) {
  const { mml, warnings } = studioToWorkshop(source.mml);
  if (!hooks.load(mml)) return false;
  writeOrigin({ projectId: workspace.id, title: workspace.title ?? "", slot: source.slot, label: source.label, revision: workspace.revision ?? null, at: Date.now() });
  box().classList.remove("on");
  const notes = [i18n.t("studio.opened", { title: workspace.title || "—", source: source.label })];
  const codes = new Set(warnings.map(w => w.code));
  if (codes.has("N_REWRITTEN")) notes.push(i18n.t("studio.nWarning"));
  if (codes.has("N_BELOW_WORKSHOP_RANGE")) notes.push(i18n.t("studio.nLowWarning"));
  say(notes.join(" "));
  return true;
}

// A Studio page link: #studio-project=<id>&asset=<slot>.
async function openFromHash() {
  const want = parseWorkshopHash(location.hash);
  if (!want) return;
  history.replaceState(null, "", location.pathname + location.search);
  try {
    const workspace = await loadProject(want.projectId);
    const source = projectSources(workspace).find(s => s.slot === want.slot);
    if (!source) { say(i18n.t("studio.noMml")); return; }
    openSource(workspace, source);
  } catch (err) {
    say(i18n.t("studio.dbFailed", { msg: err?.message ?? "" }));
  }
}

// ─── Send back to Studio ────────────────────────────────────────────────────

const sendBox = () => $("#studioSendBox");

function describeWarning(w) {
  const track = i18n.trackName(w.track);
  return i18n.t(`studio.warn.${w.code}`, { track });
}

function openSend() {
  pending = workshopToStudio(hooks.getTexts());
  const empty = pending.mml === "MML@,,,,,;";
  $("#studioSendText").value = pending.mml;
  const list = $("#studioSendNotes");
  list.replaceChildren();
  const notes = pending.warnings.map(describeWarning);
  if (pending.dropped.length) notes.push(i18n.t("studio.dropped", { list: i18n.list(pending.dropped.map(i => i18n.trackName(i))) }));
  if (empty) notes.push(i18n.t("studio.emptySend"));
  for (const n of notes) { const li = document.createElement("li"); li.textContent = n; list.append(li); }
  list.hidden = !notes.length;
  $("#studioSendGo").disabled = empty;
  sendBox().classList.add("on");
  $("#studioSendGo").focus();
}

function send() {
  if (!pending) return;
  let id;
  try {
    id = putReturn({
      mml: pending.mml,
      name: $("#expName")?.value ?? "",
      origin: readOrigin(),
      warnings: pending.warnings.map(describeWarning),
    });
  } catch (err) {
    say(i18n.t("studio.sendFailed", { msg: err?.message ?? "" }));
    return;
  }
  sendBox().classList.remove("on");
  const url = new URL(STUDIO_HOME);
  url.hash = new URLSearchParams({ "workshop-return": id }).toString();
  location.assign(url.href);
}

export function init(next = {}) {
  hooks = { ...hooks, ...next };
  $("#studioOpen")?.addEventListener("click", openBox);
  $("#studioSend")?.addEventListener("click", openSend);
  $("#studioProject")?.addEventListener("change", e => showProject(e.target.value));
  $("#studioCancel")?.addEventListener("click", () => box().classList.remove("on"));
  $("#studioSendCancel")?.addEventListener("click", () => sendBox().classList.remove("on"));
  $("#studioSendGo")?.addEventListener("click", send);
  $("#studioOriginClear")?.addEventListener("click", clearOrigin);
  for (const el of [box(), sendBox()]) el?.addEventListener("click", e => { if (e.target === el) el.classList.remove("on"); });
  addEventListener("keydown", e => {
    if (e.key !== "Escape") return;
    box()?.classList.remove("on");
    sendBox()?.classList.remove("on");
  });
  syncOrigin();
  openFromHash();
}
