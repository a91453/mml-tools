// Studio Workshop — ported from the owner's earlier frontend (owner-authorized port).
// Waterfall video export (WebCodecs H.264 + AAC, MP4), as a dialog in the
// Workshop page. The audio is the offline mixdown (mixdown.mjs) with the
// user's own bank; the preview plays the very same PCM that is encoded.
// Workshop edits sit outside the Canonical/verified pipeline and are never evidence.
import { GAME_TRACKS, NOTE_COLORS, NOTE_COLOR_ORDER } from "./config.mjs";
import * as i18n from "./i18n.mjs";
import { $, safeFileName } from "./util.mjs";
import { renderPcm } from "./mixdown.mjs";
import { gainForLoudness, TARGET_LUFS } from "./mixmath.mjs";
import * as wf from "./waterfall.mjs";
import { NOTE_STYLES, HIT_FX, noteStyle, hitFx } from "./wfstyles.mjs";
import { loadedWaterfall, saveWaterfall } from "./storage.mjs";
import { muxMp4 } from "./mp4.mjs";
import { setIcon } from "./icons.mjs";

const SHAPES = {
  portrait: [9, 16],
  landscape: [16, 9],
};

const shortSide = () =>
  (matchMedia("(pointer: coarse)").matches ? 720 : 1080);

function sizeOf(name) {
  const [a, b] = SHAPES[name];
  const s = shortSide();
  const unit = s / Math.min(a, b);
  return { w: a * unit, h: b * unit };
}

const FPS_HI = 60, FPS_LO = 30;

let fps = FPS_HI;

const BITRATE = { 1080: 10_000_000, 720: 5_000_000 };

const SPEED = { slower: 6, slow: 4, normal: wf.LOOK_AHEAD_SEC, fast: 1.6 };

const KEYFRAME_SEC = 2;

const QUEUE_MAX = 4;

const AAC_BPS = 192_000;

const AUDIO_BLOCK = 8192;

let song = null;
let notes = null;
let pcm = null;
let masterGain = 1;

let dry = null;
let handoffName = "";
let setupToken = 0;
let shape = "portrait";
let busy = null;

let styleId = NOTE_STYLES[0].id;
let fxId = HIT_FX[0].id;

let speedTier = "normal";

const speedSec = () => SPEED[speedTier] ?? SPEED.normal;

const COLORS = "colors";
const STYLE = "style";
const FX = "fx";
const TABS = [COLORS, STYLE, FX];
const THUMB_TABS = [STYLE, FX];
let tab = COLORS;


let colorPick = wf.colorIds(null);
let colors = wf.colorsOf(colorPick);

let gridFor = -1;

let actx = null, source = null, buffer = null, startedAt = 0, pausedAt = 0, playing = false;

const tl = () => wf.timeline(pcm.left.length / pcm.sampleRate);

async function prepareAudio(setup, token) {
  const out = await renderPcm({
    song, presets: setup.presets, bank: setup.bank,
    onProgress: p => { if (token === setupToken) setLoad(p); },
  });
  if (token !== setupToken) return false;
  dry = out;
  pcm = dry;
  masterGain = normalizeMusic(dry.left, dry.right, dry.sampleRate);
  return true;
}

function normalizeMusic(l, r, sr) {
  const g = gainForLoudness(l, r, sr, TARGET_LUFS);
  console.info(`[Workshop video] 響度 ${g.lufs.toFixed(1)} LUFS → ×${g.gain.toFixed(3)} → ` +
    `${g.reached.toFixed(1)} LUFS（目標 ${TARGET_LUFS}）`);
  return g.gain;
}

function makeBuffer() {
  const { left, right, sampleRate } = pcm;
  buffer = actx.createBuffer(2, left.length, sampleRate);
  const l = buffer.getChannelData(0), r = buffer.getChannelData(1);
  for (let i = 0; i < left.length; i++) {
    l[i] = left[i] * masterGain;
    r[i] = right[i] * masterGain;
  }
}

function play(at = pausedAt) {
  stop();
  const from = Math.max(0, at);
  source = actx.createBufferSource();
  source.buffer = buffer;
  source.connect(actx.destination);
  source.start(0, from);
  startedAt = actx.currentTime - at;
  playing = true;
  syncPlay();
}

function stop() {
  if (source) { try { source.stop(); } catch {  } source.disconnect(); }
  source = null;
}

function pause() {
  pausedAt = now();
  stop();
  playing = false;
  syncPlay();
}

const now = () => (playing ? actx.currentTime - startedAt : pausedAt);

let view = null;

const PREVIEW_SHORT = 540;

function relayout() {
  const [a, b] = SHAPES[shape];
  const unit = PREVIEW_SHORT / Math.min(a, b);
  const cv = $("#wfStage");
  cv.width = a * unit;
  cv.height = b * unit;
  cv.style.aspectRatio = `${a} / ${b}`;
  view = wf.layout(cv.width, cv.height, speedSec());
  pumpWidth();
}

function syncWidth() {
  const w = $("#wfStage").getBoundingClientRect().width;
  if (w) $("#wfPage").style.setProperty("--wfw", `${Math.round(w)}px`);
}

function pumpWidth() {
  requestAnimationFrame(() => {
    syncWidth();
    requestAnimationFrame(syncWidth);
  });
}

let framing = 0;
function frame() {
  framing = 0;
  if (!$("#videoBox").classList.contains("on") || document.hidden) return;
  framing = requestAnimationFrame(frame);
  if (!view || !pcm) return;
  if (busy) return;
  const t = now();
  const { start, end } = tl();
  if (playing && t >= end) pause();
  draw($("#wfStage").getContext("2d"), Math.min(t, end), view);
  $("#wfSeek").value = String(Math.min(1, Math.max(0, (t - start) / (end - start))));
  $("#wfTime").textContent = `${clock(t)} / ${clock(end)}`;
}

const clock = s => {
  const v = Math.max(0, s);
  return `${Math.floor(v / 60)}:${String(Math.floor(v % 60)).padStart(2, "0")}`;
};

const draw = (ctx, t, v) => wf.draw(ctx, t, v, notes, {
  style: noteStyle(styleId),
  fx: hitFx(fxId),
  colors,
  mark: { text: i18n.t("waterfall.mark") },
});

const fail = (code, message) => Object.assign(new Error(message), { code });

const yielder = new MessageChannel();
const waiting = [];
yielder.port1.onmessage = () => waiting.shift()?.();
const tick = () => new Promise(r => { waiting.push(r); yielder.port2.postMessage(0); });

const reclaimed = e => e.name === "QuotaExceededError" || /reclaim/i.test(e.message ?? "");

const shut = enc => { if (enc.state !== "closed") enc.close(); };

async function probe() {
  if (typeof VideoEncoder === "undefined" || typeof AudioEncoder === "undefined") {
    return { ok: false, why: "nocodecs" };
  }
  const { w, h } = sizeOf(shape);
  let rate = 0;
  for (const r of [FPS_HI, FPS_LO]) {
    if ((await VideoEncoder.isConfigSupported(videoConfig(w, h, r))).supported) { rate = r; break; }
  }
  if (!rate) return { ok: false, why: "novideo" };
  if (rate !== FPS_HI) {
    console.warn(`[Workshop video] 這台裝置編不出 ${Math.min(w, h)}p${FPS_HI}`
      + `（${avcCodec(w, h, FPS_HI)} 不支援），退回 ${rate}fps`);
  }
  const a = await AudioEncoder.isConfigSupported(audioConfig());
  if (!a.supported) return { ok: false, why: "noaudio" };
  fps = rate;
  return { ok: true };
}

const avcCodec = (w, h, rate) =>
  (Math.ceil(w / 16) * Math.ceil(h / 16) * rate > 245_760
    ? "avc1.64002A"
    : "avc1.640028");

const videoConfig = (w, h, rate) => ({
  codec: avcCodec(w, h, rate),
  width: w, height: h,
  bitrate: BITRATE[Math.min(w, h)] ?? BITRATE[720],
  framerate: rate,
  latencyMode: "quality",
  avc: { format: "avc" },
});

const audioConfig = () => ({
  codec: "mp4a.40.2",
  sampleRate: pcm.sampleRate,
  numberOfChannels: 2,
  bitrate: AAC_BPS,
});

async function encodeVideo(signal) {
  const { w, h } = sizeOf(shape);
  const { start, end } = tl();
  const total = Math.ceil((end - start) * fps);

  const cv = document.createElement("canvas");
  cv.width = w; cv.height = h;
  const ctx = cv.getContext("2d", { alpha: false });
  const full = wf.layout(w, h, speedSec());

  const samples = [];
  let description = null;
  let broke = null;
  const encoder = new VideoEncoder({
    output: (chunk, meta) => {
      description ??= meta?.decoderConfig?.description;
      const data = new Uint8Array(chunk.byteLength);
      chunk.copyTo(data);
      samples.push({ data, timestamp: chunk.timestamp, duration: chunk.duration, type: chunk.type });
    },
    error: e => { broke ??= fail(reclaimed(e) ? "reclaimed" : "video", e.message); },
  });
  encoder.configure(videoConfig(w, h, fps));

  for (let f = 0; f < total; f++) {
    if (broke) { shut(encoder); throw broke; }
    if (signal.aborted) { shut(encoder); throw fail("cancelled", "已取消"); }
    const t = start + f / fps;
    draw(ctx, t, full);

    const frameObj = new VideoFrame(cv, { timestamp: Math.round(f * 1e6 / fps) });
    try {
      encoder.encode(frameObj, { keyFrame: f % (fps * KEYFRAME_SEC) === 0 });
    } catch (e) {
      throw broke ?? e;
    } finally {
      frameObj.close();
    }

    while (!broke && encoder.encodeQueueSize > QUEUE_MAX) await tick();
    if (f % 10 === 0) { setExport(f / total * 0.8, "video"); await tick(); }
  }
  if (broke) { shut(encoder); throw broke; }
  await encoder.flush().catch(e => { throw broke ?? e; });
  encoder.close();
  if (!description) throw fail("nodesc", "編碼器沒有給 avcC —— avc.format 設錯了");
  checkFrames(samples, total);
  return { samples, description };
}

function checkFrames(samples, total) {
  if (samples.length !== total) {
    console.warn(`[Workshop video] 送了 ${total} 幀進編碼器，只吐回 ${samples.length} 幀`);
  }
  const step = 1e6 / fps;
  const odd = [];
  for (let i = 1; i < samples.length; i++) {
    const d = samples[i].timestamp - samples[i - 1].timestamp;
    if (Math.abs(d - step) > 1 && odd.length < 8) {
      odd.push(`第 ${i} 幀 @${(samples[i].timestamp / 1e6).toFixed(2)}s 間距 ${d}µs`);
    }
  }
  if (odd.length) console.warn("[Workshop video] 時間戳不等距：" + odd.join("、"));
}

async function encodeAudio(signal) {
  const { left, right, sampleRate } = pcm;
  const lead = Math.round(wf.LEAD_IN_SEC * sampleRate);
  const total = lead + left.length;

  const samples = [];
  let description = null;
  let broke = null;
  const encoder = new AudioEncoder({
    output: (chunk, meta) => {
      description ??= meta?.decoderConfig?.description;
      const data = new Uint8Array(chunk.byteLength);
      chunk.copyTo(data);
      samples.push({ data, timestamp: chunk.timestamp, duration: chunk.duration, type: chunk.type });
    },
    error: e => { broke ??= fail(reclaimed(e) ? "reclaimed" : "audio", e.message); },
  });
  encoder.configure(audioConfig());

  for (let at = 0; at < total; at += AUDIO_BLOCK) {
    if (broke) { shut(encoder); throw broke; }
    if (signal.aborted) { shut(encoder); throw fail("cancelled", "已取消"); }
    const n = Math.min(AUDIO_BLOCK, total - at);
    const planes = new Float32Array(n * 2);
    for (let i = 0; i < n; i++) {
      const src = at + i - lead;
      planes[i] = src < 0 ? 0 : left[src] * masterGain;
      planes[n + i] = src < 0 ? 0 : right[src] * masterGain;
    }
    const audioData = new AudioData({
      format: "f32-planar", sampleRate, numberOfFrames: n, numberOfChannels: 2,
      timestamp: Math.round(at * 1e6 / sampleRate), data: planes,
    });
    try {
      encoder.encode(audioData);
    } catch (e) {
      throw broke ?? e;
    } finally {
      audioData.close();
    }
    while (!broke && encoder.encodeQueueSize > QUEUE_MAX) await tick();
    setExport(0.8 + (at / total) * 0.15, "audio");
  }
  if (broke) { shut(encoder); throw broke; }
  await encoder.flush().catch(e => { throw broke ?? e; });
  encoder.close();
  if (!description) throw fail("nodesc", "編碼器沒有給 AudioSpecificConfig");
  return { samples, description };
}

async function exportMp4() {
  if (busy) return;
  const check = await probe();
  if (!check.ok) { say(i18n.t(`waterfall.err.${check.why}`)); return; }

  pause();
  busy = new AbortController();
  setBusy(true);
  const awake = await navigator.wakeLock?.request("screen").catch(() => null) ?? null;
  try {
    const { w, h } = sizeOf(shape);
    const audio = await encodeAudio(busy.signal);
    const video = await encodeVideo(busy.signal);
    setExport(0.97, "mux");
    await tick();

    const bytes = muxMp4({
      video: { width: w, height: h, frameRate: fps, description: video.description,
        samples: video.samples },
      audio: { sampleRate: pcm.sampleRate, numberOfChannels: 2,
        description: audio.description, samples: audio.samples },
    });

    const blob = new Blob([bytes], { type: "video/mp4" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `${safeFileName($("#wfName").value || defaultName())}.mp4`;
    a.click();
    URL.revokeObjectURL(a.href);
    setExport(1, "done");
  } catch (err) {
    if (err.code !== "cancelled") {
      console.error("[Workshop video]", err);
      say(i18n.has(`waterfall.err.${err.code}`)
        ? i18n.t(`waterfall.err.${err.code}`)
        : i18n.t("waterfall.err.unknown"));
    }
  } finally {
    awake?.release().catch(() => {});
    busy = null;
    setBusy(false);
  }
}

const setLoad = p => { $("#wfLoadBar").value = p; };
const say = msg => { const e = $("#wfErr"); e.textContent = msg; e.hidden = false; };

const defaultName = () => handoffName || "waterfall";

function setExport(p, phase) {
  $("#wfExpBar").value = p;
  $("#wfPhase").textContent = i18n.t(`waterfall.phase.${phase}`);
}

const leaveGuard = e => { e.preventDefault(); e.returnValue = ""; };

function setBusy(on) {
  $("#wfMake").hidden = on;
  $("#wfExp").hidden = !on;
  $("#wfPlayBtn").disabled = on;
  $("#wfSeek").disabled = on;
  if (on) closeLook();
  if (on) addEventListener("beforeunload", leaveGuard);
  else removeEventListener("beforeunload", leaveGuard);
}

const syncPlay = () => {
  const btn = $("#wfPlayBtn");
  setIcon(btn, playing ? "pause" : "play");
  const label = i18n.t(playing ? "waterfall.pause" : "waterfall.play");
  btn.title = label;
  btn.setAttribute("aria-label", label);
};

function syncEstimate() {
  if (!pcm) return;
  const { w, h } = sizeOf(shape);
  const secs = tl().duration;
  const mb = (BITRATE[Math.min(w, h)] * secs / 8 / 1048576);
  const el = $("#wfSize");
  el.textContent = i18n.t("waterfall.estimate", { mb: mb.toFixed(0) });
  el.classList.toggle("warn", mb > 312);
}

function syncSpeed() {
  for (const b of $("#wfSpeed").children) {
    const on = b.dataset.speed === speedTier;
    b.classList.toggle("on", on);
    b.setAttribute("aria-checked", String(on));
  }
}

const THUMB_W = 300;
const THUMB_H = 210;

const THUMB_LOOP = 2.4;

const THUMB_KEYS = 10;

const THUMB_PATTERN = [
  [0.00, 0.55, 60, 105, 0], [0.60, 0.55, 64, 96, 0],
  [1.20, 0.55, 67, 118, 0], [1.80, 0.55, 64, 92, 0],
  [0.00, 1.10, 55, 74, 1], [1.20, 1.10, 57, 74, 1],
  [0.30, 0.25, 62, 110, 2], [0.90, 0.30, 61, 100, 2], [1.50, 0.25, 69, 112, 2],
];

let thumbView = null;
let thumbNotes = null;
let thumbCrop = null;
let thumbRaf = 0;

function thumbScene() {
  if (thumbView) return;
  thumbView = wf.layout(1920, 1080);

  const notes = [];
  for (const loop of [0, THUMB_LOOP]) {
    for (const [start, dur, midi, vel, track] of THUMB_PATTERN) {
      (notes[track] ??= []).push({ start: start + loop, dur, midi, vel });
    }
  }
  thumbNotes = wf.prepare({ tracks: notes.map(n => ({ notes: n })) });

  const used = [...new Set(THUMB_PATTERN.map(p => p[2]))].map(m => thumbView.keyOf.get(m));
  const lo = Math.min(...used.map(k => k.x));
  const hi = Math.max(...used.map(k => k.x + k.w));
  const w = thumbView.whiteW * THUMB_KEYS;
  const h = w * THUMB_H / THUMB_W;
  thumbCrop = {
    w, h,
    y: thumbView.kbTop - h * 0.78,
    x: Math.max(0, Math.min(thumbView.W - w, (lo + hi) / 2 - w / 2)),
  };
}

function drawThumb(cv, t, style, fx) {
  const ctx = cv.getContext("2d");
  const s = cv.width / thumbCrop.w;
  ctx.setTransform(s, 0, 0, s, -thumbCrop.x * s, -thumbCrop.y * s);
  wf.draw(ctx, t, thumbView, thumbNotes, { style, fx, colors });
  ctx.setTransform(1, 0, 0, 1, 0, 0);
}

function buildPicks(host, list, current, label, onPick) {
  host.textContent = "";
  const dpr = Math.min(2, globalThis.devicePixelRatio || 1);
  for (const item of list) {
    const b = document.createElement("button");
    b.type = "button";
    b.className = "pick";
    b.dataset.id = item.id;
    b.setAttribute("role", "radio");

    const cv = document.createElement("canvas");
    cv.width = Math.round(THUMB_W * dpr);
    cv.height = Math.round(THUMB_H * dpr);

    const span = document.createElement("span");
    span.textContent = label(item);

    b.append(cv, span);
    b.addEventListener("click", () => onPick(item.id));
    host.append(b);
  }
  markPicked(host, current);
}

function markPicked(host, id) {
  for (const b of host.children) {
    const on = b.dataset.id === id;
    b.classList.toggle("on", on);
    b.setAttribute("aria-checked", String(on));
  }
}

function buildColors() {
  const host = $("#lookColors");
  host.replaceChildren();
  for (let i = 0; i < GAME_TRACKS; i++) {
    const lab = document.createElement("label");
    lab.htmlFor = `lookColor${i}`;
    lab.textContent = i18n.trackName(i);

    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "pickc";
    btn.id = `lookColor${i}`;
    btn.append(document.createElement("i"), document.createElement("span"));
    btn.firstElementChild.className = "sw";
    btn.addEventListener("click", () => openGrid(i));

    host.append(lab, btn);
  }

  const grid = $("#lookSwatches");
  grid.replaceChildren();
  for (const k of NOTE_COLOR_ORDER) {
    const b = document.createElement("button");
    b.type = "button";
    b.dataset.k = String(k);
    b.setAttribute("role", "radio");

    const sw = document.createElement("i");
    sw.style.setProperty("--c", NOTE_COLORS[k]);
    const nm = document.createElement("span");
    nm.textContent = i18n.t(`waterfall.color.${k}`);
    b.append(sw, nm);

    b.addEventListener("click", () => {
      if (gridFor < 0) return;
      colorPick[gridFor] = k;
      syncColors();
      persist();
      closeGrid();
    });
    grid.append(b);
  }

  syncColors();
}

function syncColors() {
  colors = wf.colorsOf(colorPick);
  for (let i = 0; i < GAME_TRACKS; i++) {
    const btn = $(`#lookColor${i}`);
    const k = colorPick[i];
    btn.firstElementChild.style.setProperty("--c", NOTE_COLORS[k]);
    btn.lastElementChild.textContent = i18n.t(`waterfall.color.${k}`);
  }
}

function openGrid(i) {
  gridFor = i;
  $("#lookBack").textContent = `← ${i18n.trackName(i)}`;
  for (const b of $("#lookSwatches").children) {
    const on = +b.dataset.k === colorPick[i];
    b.classList.toggle("on", on);
    b.setAttribute("aria-checked", String(on));
  }
  $("#lookColors").hidden = true;
  $("#lookReset").hidden = true;
  $("#lookGrid").hidden = false;
  $("#lookBack").focus();
}

function closeGrid() {
  const back = gridFor;
  gridFor = -1;
  $("#lookGrid").hidden = true;
  $("#lookColors").hidden = false;
  $("#lookReset").hidden = false;
  if (back >= 0) $(`#lookColor${back}`).focus();
}

function thumbFrame() {
  if (!$("#lookBox").classList.contains("on") || document.hidden || !THUMB_TABS.includes(tab)) {
    thumbRaf = 0;
    return;
  }
  const t = performance.now() / 1000 % THUMB_LOOP;
  if (tab === STYLE) {
    const none = hitFx("none");
    for (const b of $("#lookStyle").children) drawThumb(b.firstChild, t, noteStyle(b.dataset.id), none);
  } else {
    const style = noteStyle(styleId);
    for (const b of $("#lookFx").children) drawThumb(b.firstChild, t, style, hitFx(b.dataset.id));
  }
  thumbRaf = requestAnimationFrame(thumbFrame);
}

function syncTab() {
  for (const b of $("#lookTabs").children) {
    const on = b.dataset.tab === tab;
    b.classList.toggle("on", on);
    b.setAttribute("aria-selected", String(on));
  }
  for (const g of $("#lookBox").querySelectorAll(".tgroup")) g.hidden = g.dataset.tab !== tab;
  if (tab !== COLORS && gridFor >= 0) closeGrid();
  pumpThumbs();
}

function pumpThumbs() {
  if (!thumbRaf && THUMB_TABS.includes(tab) && $("#lookBox").classList.contains("on")) {
    thumbRaf = requestAnimationFrame(thumbFrame);
  }
}

function openLook() {
  if (busy) return;
  thumbScene();
  tab = COLORS;
  syncTab();
  $("#lookBox").classList.add("on");
  pumpThumbs();
}

function closeLook() {
  if (gridFor >= 0) closeGrid();
  $("#lookBox").classList.remove("on");
  if (thumbRaf) { cancelAnimationFrame(thumbRaf); thumbRaf = 0; }
}

const persist = () =>
  saveWaterfall({
    shape, style: styleId, fx: fxId, colors: colorPick.join(","), speed: speedTier,
  });

function restorePrefs() {
  const pref = loadedWaterfall();
  if (SHAPES[pref.shape]) shape = pref.shape;
  styleId = noteStyle(pref.style).id;
  fxId = hitFx(pref.fx).id;
  colorPick = wf.colorIds(pref.colors);
  colors = wf.colorsOf(colorPick);
  speedTier = pref.speed && SPEED[pref.speed] ? pref.speed : "normal";
  for (const el of $("#wfShape").children) {
    const on = el.dataset.shape === shape;
    el.classList.toggle("on", on);
    el.setAttribute("aria-checked", String(on));
  }
  syncSpeed();
}

let ready = false;

function initOnce() {
  if (ready) return;
  ready = true;

  $("#wfGo").lastElementChild.textContent = i18n.t("waterfall.export");
  $("#wfCancel").lastElementChild.textContent = i18n.t("waterfall.cancel");
  $("#wfLook").lastElementChild.textContent = i18n.t("waterfall.look");
  $("#wfLook").title = i18n.t("waterfall.look.title");
  $("#wfSeek").setAttribute("aria-label", i18n.t("waterfall.seek"));
  $("#wfShape").setAttribute("aria-label", i18n.t("waterfall.shape"));
  $("#wfSpeed").setAttribute("aria-label", i18n.t("waterfall.speed"));
  for (const b of $("#wfSpeed").children) b.textContent = i18n.t(`waterfall.speed.${b.dataset.speed}`);
  $("#lookTitle").textContent = i18n.t("waterfall.look.title");
  $("#lookTabColors").textContent = i18n.t("waterfall.look.colors");
  $("#lookTabStyle").textContent = i18n.t("waterfall.look.style");
  $("#lookTabFx").textContent = i18n.t("waterfall.look.fx");
  $("#lookStyle").setAttribute("aria-label", i18n.t("waterfall.look.style"));
  $("#lookFx").setAttribute("aria-label", i18n.t("waterfall.look.fx"));
  $("#lookReset").textContent = i18n.t("waterfall.look.reset");
  $("#lookBack").setAttribute("aria-label", i18n.t("waterfall.look.back"));
  $("#lookDone").textContent = i18n.t("waterfall.look.done");
  $("#wfName").setAttribute("aria-label", i18n.t("waterfall.name"));

  $("#wfPlayBtn").addEventListener("click", () => {
    if (!buffer) return;
    actx.resume?.();
    if (playing) pause(); else play();
  });
  $("#wfSeek").addEventListener("input", e => {
    if (!pcm) return;
    const { start, end } = tl();
    pausedAt = start + (end - start) * +e.target.value;
    if (playing) play(pausedAt);
  });
  for (const el of $("#wfShape").children) {
    el.addEventListener("click", () => {
      shape = el.dataset.shape;
      for (const b of $("#wfShape").children) {
        b.classList.toggle("on", b === el);
        b.setAttribute("aria-checked", String(b === el));
      }
      relayout();
      syncEstimate();
      persist();
    });
  }

  for (const b of $("#wfSpeed").children) {
    b.addEventListener("click", () => {
      speedTier = b.dataset.speed;
      syncSpeed();
      relayout();
      persist();
    });
  }
  $("#wfGo").addEventListener("click", exportMp4);
  $("#wfCancel").addEventListener("click", () => busy?.abort());
  $("#videoClose").addEventListener("click", close);

  buildColors();
  $("#lookBack").addEventListener("click", closeGrid);
  $("#lookReset").addEventListener("click", () => {
    colorPick = wf.colorIds(null);
    syncColors();
    persist();
  });

  buildPicks($("#lookStyle"), NOTE_STYLES, styleId,
    s => i18n.t(`waterfall.style.${s.id}`),
    id => { styleId = id; markPicked($("#lookStyle"), id); persist(); });
  buildPicks($("#lookFx"), HIT_FX, fxId,
    f => i18n.t(`waterfall.fx.${f.id}`),
    id => { fxId = id; markPicked($("#lookFx"), id); persist(); });

  for (const b of $("#lookTabs").children) {
    b.addEventListener("click", () => {
      const next = TABS.includes(b.dataset.tab) ? b.dataset.tab : COLORS;
      if (next === tab) return;
      tab = next;
      syncTab();
    });
  }

  $("#wfLook").addEventListener("click", openLook);
  $("#lookDone").addEventListener("click", closeLook);
  $("#lookBox").addEventListener("click", e => { if (e.target === $("#lookBox")) closeLook(); });
  addEventListener("keydown", e => {
    if (e.key !== "Escape") return;
    if ($("#lookBox").classList.contains("on")) {
      if (gridFor >= 0) closeGrid();
      else closeLook();
      return;
    }
    if ($("#videoBox").classList.contains("on") && !busy) close();
  });
  addEventListener("resize", pumpWidth);

  document.addEventListener("visibilitychange", () => {
    if (document.hidden) { if (thumbRaf) { cancelAnimationFrame(thumbRaf); thumbRaf = 0; } }
    else { pumpThumbs(); pumpFrames(); }
  });
}

const pumpFrames = () => { if (!framing) framing = requestAnimationFrame(frame); };

export function close() {
  if (busy) return;
  setupToken++;
  if (pcm) pause();
  closeLook();
  $("#videoBox").classList.remove("on");
}

// `setup`: { song, presets, bank, name } from the editor (ui.renderSetup).
export async function open(setup) {
  initOnce();
  const token = ++setupToken;
  if (pcm) pause();
  pcm = null; dry = null; buffer = null; pausedAt = 0;
  song = setup.song;
  notes = wf.prepare(song);
  handoffName = setup.name ?? "";
  $("#wfName").value = "";
  $("#wfName").placeholder = defaultName();
  $("#wfErr").hidden = true;
  $("#wfLoad").hidden = false;
  $("#wfPlay").hidden = true;
  $("#wfMake").hidden = true;
  setLoad(0);
  $("#videoBox").classList.add("on");
  pumpFrames();

  restorePrefs();
  relayout();

  actx ??= new (window.AudioContext || window.webkitAudioContext)();
  try {
    if (!await prepareAudio(setup, token)) return;
  } catch (err) {
    if (token !== setupToken) return;
    console.error("[Workshop video]", err);
    say(i18n.has(`stage.err.${err.code}`) ? i18n.t(`stage.err.${err.code}`)
      : i18n.t("waterfall.err.unknown"));
    return;
  }
  makeBuffer();
  $("#wfLoad").hidden = true;
  $("#wfPlay").hidden = false;
  $("#wfMake").hidden = false;
  syncEstimate();
  syncPlay();
}
