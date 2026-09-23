// Studio Workshop: offline WAV export dialog. Loaded on first use.
// The mixdown (mixdown.mjs) renders the six game tracks through SpessaSynth
// core with the user's own bank and writes 16-bit PCM WAV. It is a listening
// aid: not the game's timbre, never Studio evidence.
import * as i18n from "./i18n.mjs";
import { $, safeFileName } from "./util.mjs";
import { renderPcm, pcmToWav } from "./mixdown.mjs";
import { droppedTracks } from "./mixnotes.mjs";
import { GAME_TRACKS } from "./config.mjs";

let setup = null;
let busy = null;
let ready = false;

const box = () => $("#wavBox");

function syncBusy(on) {
  $("#wavGo").disabled = on;
  $("#wavName").disabled = on;
  $("#wavProg").hidden = !on;
  $("#wavCancel").textContent = i18n.t(on ? "common.cancel" : "common.close");
}

function showErr(msg) {
  const e = $("#wavErr");
  e.textContent = msg;
  e.hidden = !msg;
}

function setProgress(p, phase) {
  $("#wavBar").value = p;
  $("#wavPhase").textContent = i18n.t(`stage.phase.${phase}`);
}

export function download(blob, name) {
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 0);
}

async function go() {
  if (busy || !setup) return;
  showErr("");
  busy = new AbortController();
  syncBusy(true);
  setProgress(0, "render");
  try {
    const pcm = await renderPcm({
      song: setup.song, presets: setup.presets, bank: setup.bank, signal: busy.signal,
      onProgress: p => setProgress(p * 0.95, "render"),
    });
    setProgress(0.97, "encode");
    const blob = pcmToWav(pcm);
    const name = safeFileName($("#wavName").value || setup.name || "workshop");
    download(blob, `${name}.wav`);
    setProgress(1, "done");
    lastExport = blob;
  } catch (err) {
    if (err.code !== "cancelled") {
      console.error("[Workshop WAV]", err);
      showErr(i18n.has(`stage.err.${err.code}`) ? i18n.t(`stage.err.${err.code}`) : i18n.t("stage.err.unknown"));
    }
  } finally {
    busy = null;
    syncBusy(false);
  }
}

// The most recent export, for the page's own checks (browser tests).
export let lastExport = null;

function close() {
  if (busy) { busy.abort(); return; }
  box().classList.remove("on");
}

function initOnce() {
  if (ready) return;
  ready = true;
  $("#wavGo").addEventListener("click", go);
  $("#wavCancel").addEventListener("click", close);
  box().addEventListener("click", e => { if (e.target === box() && !busy) close(); });
  addEventListener("keydown", e => { if (e.key === "Escape" && box().classList.contains("on") && !busy) close(); });
}

// `next`: { song, presets, bank, name } from the editor (ui.renderSetup).
export function open(next) {
  initOnce();
  if (busy) return;
  setup = next;
  showErr("");
  $("#wavName").value = "";
  $("#wavName").placeholder = safeFileName(setup.name || "workshop");
  const dropped = droppedTracks(setup.song);
  const drop = $("#wavDrop");
  drop.hidden = !dropped.length;
  drop.textContent = dropped.length
    ? i18n.t("stage.dropped", { list: i18n.list(dropped.map(n => i18n.trackName(n - 1))), kept: GAME_TRACKS })
    : "";
  if (!setup.bank) { showErr(i18n.t("stage.err.nobank")); $("#wavGo").disabled = true; }
  else syncBusy(false);
  box().classList.add("on");
  $("#wavGo").focus();
}
