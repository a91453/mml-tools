// ────────────────────────────────────────────────────────────────────────────
//  混音匯出：舞台
//
//   **拖任何一張就自動把它勾起來**。畫面上排開
//  卻聽不到空間感只會讓人以為壞了，而「疊在正中間當作預設」則是連拖都拖不開。折衷是：
//  排開給你看，但要動過才算數。
//
//  不能用「所有 panner 擺在同一點」來當平面混音的代替品：`PannerNode` 會把每個 channel
//  自己的立體聲像塌成一個點音源，聽起來比編輯器窄（見 mixdown.renderPcm 的 stage 參數）。
// ────────────────────────────────────────────────────────────────────────────

import { $, say } from "./util.js";
import * as i18n from "./i18n.js";
import { TRACK_COLORS, GAME_TRACKS, chanOf } from "./config.js";
import * as tracks from "./tracks.js";
import * as storage from "./storage.js";
import * as engine from "./engine.js";
import * as player from "./player.js";
import { notedTracks, droppedTracks } from "./mixnotes.js";
import { defaultLayout, clampPos, PANNER, STAGE_M, STAGE_HALF, DEFAULT_LISTENER } from "./mixmath.js";
import { exportMp3, SAMPLE_RATE } from "./mixdown.js";
import { ENV_PRESETS, envPreset, seedOfSong } from "./envaudio.js";
import * as envlive from "./envlive.js";
import { safeFileName } from "./mml-out.js";

/** 鍵盤方向鍵一次挪多遠（公尺）。滑鼠是連續的，鍵盤要一個看得見又不會太粗的步進。 */
const STEP_M = 0.25;

/** 同心圓畫到幾公尺。最內圈就是 refDistance（圈內不衰減），所以從 2 開始。 */
const RINGS = [2, 4, 6, 8];

let getSong = () => null;
let getBank = () => null;
/**
 * 按下試聽之前要做的準備（送音色）。由 ui 提供，**不能省** —— 不送的話用的會是合成器上一次
 * 留下的音色，改過軌序就整首錯位。
 */
let prepare = () => {};
/**
 * 試聽結束後把編輯器的靜音狀態放回去。**跟 `prepare` 是一對，少一邊就會有殘留** ——
 * 試聽期間這裡會把靜音整組改掉（見 armPreviewMutes）。
 */
let restore = () => {};

/** 使用者**明確拖過**的位置，照軌序。沒拖過的軌不在這裡（會落到預設佈局）。 */
let placed = {};
let listener = { ...DEFAULT_LISTENER };
let headphones = true;
/** 空間混音開著嗎。預設關 —— 見檔頭。 */
let spatial = false;

/**
 * 選了哪一層環境音，以及音量倍率。**跟影片頁共用同一格偏好**（`storage.saveEnv`）——
 * 兩個頁面在使用者心裡是同一件事（「我這首要配森林」）。
 *
 * 存 id 不存物件，理由同舞台佈局：寫進 localStorage 的東西必須是「那個環境被刪掉之後還能
 * 安全讀回來」的，而 `envPreset(id)` 查不到就回「無」。
 */
let envId = ENV_PRESETS[0].id;
let envAmt = 1;

/** 這次打開時舞台上有哪些軌、各自在哪。`open()` 算好之後就固定，直到關掉。 */
let shown = [];
let pos = new Map();

let busy = null;      // 匯出中的 AbortController；null = 沒在匯出

/** 試聽是不是這個框自己按起來的。是的話關框要收掉，不是的話別動人家的播放。 */
let previewing = false;
let raf = 0;
/** 拖動進度條的期間不要被時鐘覆寫，不然滑桿會一直被拉回去。 */
let scrubbing = false;

const box = () => $("#stageBox");
const plot = () => $("#stagePlot");

// ─── 座標換算 ───────────────────────────────────────────────────────────────

/** 公尺 → 舞台方框裡的百分比。 */
const pct = v => ((v + STAGE_HALF) / STAGE_M) * 100;

/** 指標位置 → 公尺。夾限交給 clampPos（那是被測過的那一份）。 */
function toMetres(e) {
  const r = plot().getBoundingClientRect();
  return {
    x: ((e.clientX - r.left) / r.width) * STAGE_M - STAGE_HALF,
    z: ((e.clientY - r.top) / r.height) * STAGE_M - STAGE_HALF,
  };
}

// ─── 佈局 ───────────────────────────────────────────────────────────────────

/**
 * 這次要畫哪些軌、各自在哪。**只有前 GAME_TRACKS 軌，而且要有音符** —— 舞台上看得到一張牌
 * 子、匯出卻沒有那一軌是最難解釋的一種錯，所以問的是 mixnotes 那一支（匯出自己也問它）。
 *
 * 靜音的軌照常在裡面：匯出不看靜音（見 mixnotes 檔頭），舞台當然也不能看，不然畫面會宣告
 * 一件檔案裡不成立的事。
 *
 * 沒拖過的軌落到預設半圓弧的對應名次，所以中途新增軌時既有的位置不動。
 */
function layout() {
  const song = getSong();
  if (!song) { shown = []; pos = new Map(); return; }

  shown = notedTracks(song);
  const slots = defaultLayout(shown.length, listener);
  pos = new Map(shown.map((t, i) => [t, placed[t] ?? slots[i]]));
}

/** 拖過的位置寫回暫存。拖曳**結束**才叫，不是拖曳中。 */
function persist() {
  placed = Object.fromEntries([...pos].map(([t, p]) => [t, p]));
  storage.saveStage({ pos: placed, listener, headphones, spatial });
  // 環境音存在**自己那一格**，不是舞台佈局裡面 —— 影片頁也讀它（見 storage 的 `saveEnv`）。
  storage.saveEnv({ id: envId, amount: envAmt });
}

// ─── 試聽 ───────────────────────────────────────────────────────────────────

/**
 * 把目前的佈局套進即時播放的音訊圖。走的是跟匯出**同一組 panner 參數**與同一條「效果匯流排
 * 不定位」的規則 —— 所以試聽順便成為離線那條路的驗證器。
 *
 * 空間混音關著就把它拆乾淨：試聽必須跟匯出出來的檔案是同一件事，不然這個框上唯一能驗證
 * 設定的工具就在說謊。
 */
function applySpatial() {
  if (!spatial) { engine.disableSpatial(); return false; }
  const map = new Map();
  for (const [t, p] of pos) map.set(chanOf(t), p);
  return engine.enableSpatial({
    positions: map, listener, panner: PANNER,
    model: headphones ? "HRTF" : "equalpower",
  });
}

const mmss = s => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, "0")}`;

/** 進度條與按鈕跟著播放頭走。只在框開著時跑。 */
function tick() {
  raf = 0;
  if (!box().classList.contains("on")) return;

  const playing = player.isPlaying();
  const sounding = playing && !player.isPaused();
  const btn = $("#stagePlay");
  // 兩個 key 都寫成字面量：孤兒檢查是掃原始碼認 key 的（見 i18n.test.mjs）。
  if (btn.dataset.k !== String(sounding)) {
    btn.dataset.k = String(sounding);
    btn.textContent = sounding ? i18n.t("stage.pause") : i18n.t("stage.play");
  }

  const dur = getSong()?.duration ?? 0;
  const at = playing ? (player.positionSec() ?? 0) : 0;
  if (!scrubbing) {
    $("#stageSeek").value = dur > 0 ? Math.min(1, at / dur) : 0;
    $("#stageTime").textContent = mmss(at);
  }
  raf = requestAnimationFrame(tick);
}

const pump = () => { if (!raf) raf = requestAnimationFrame(tick); };

/**
 * 讓試聽跟匯出出來的檔案是**同一件事**。兩個差異都在這裡抹平：
 *
 *   1. 匯出只做前 `GAME_TRACKS` 軌 → 輔助軌在試聽時要靜音，不然試聽有、mp3 沒有。
 *   2. 匯出不看使用者的靜音（見 mixnotes 檔頭）→ 前 6 軌一律解除靜音。
 *
 * 走 `engine.setChannelMute` 而不是「不排那幾軌的音」：那是唯一穿得過 worklet 佇列的靜音
 * 路徑（見 engine.setChannelMute），而且切換是立即的。
 */
function armPreviewMutes() {
  const song = getSong();
  const n = song?.tracks.length ?? 0;
  for (let t = 0; t < n; t++) engine.setChannelMute(chanOf(t), t >= GAME_TRACKS);
}

function togglePlay() {
  if (busy) return;
  if (!player.isPlaying()) {
    const s = getSong();
    if (!s || !s.duration) return;
    prepare();
    armPreviewMutes();
    applySpatial();
    // **整首播，不套捲軸上的基準線／結束線** —— 匯出忽略那兩條，試聽要跟它一致。
    player.start(s);
    previewing = true;
    // **在這裡再套一次環境音。** 開框那一刻引擎可能還沒開機（使用者從沒按過播放），那時候
    // `engine.context()` 是 null、殘響掛不上去。按下試聽是引擎一定已經起來的第一個時刻。
    applyEnv();
  } else if (player.isPaused()) {
    player.resume();
  } else {
    player.pause();
  }
  pump();
}

/** 收掉試聽。**關框、開始匯出、還有任何離開這個框的路都要經過它。** */
function stopPreview() {
  if (previewing && player.isPlaying()) player.stop();
  previewing = false;
  cancelAnimationFrame(raf); raf = 0;
  // 兩個都是**無條件**呼叫：沒關乾淨的話之後所有的編輯播放都會帶著空間化、或是帶著試聽時
  // 動過的那組靜音，而兩者都不會有任何錯誤訊息。
  engine.disableSpatial();
  restore();
}

// ─── 畫面 ───────────────────────────────────────────────────────────────────

/** 同心圓跟著聽者走 —— 它們畫的是「離你多遠」，不是「離舞台中心多遠」。 */
function drawRings() {
  const svg = $("#stageRings");
  if (!svg) return;
  // viewBox 的單位就是公尺，所以圓心與半徑直接寫數值（從常數算，不寫死在 HTML 裡）。
  svg.setAttribute("viewBox", `${-STAGE_HALF} ${-STAGE_HALF} ${STAGE_M} ${STAGE_M}`);
  svg.innerHTML = RINGS.map(r =>
    `<circle cx="${listener.x}" cy="${listener.z}" r="${r}" />`).join("");
}

function place(el, p) {
  el.style.left = `${pct(p.x)}%`;
  el.style.top = `${pct(p.z)}%`;
}

/** 空間混音關著的時候舞台整片變淡 —— 位置擺在那裡但現在不算數，那要看得出來。 */
function syncSpatial() {
  $("#stageSpatial").checked = spatial;
  $("#stageSpk").disabled = !spatial || !!busy;
  plot().classList.toggle("flat", !spatial);
}

function render() {
  const host = plot();
  if (!host) return;

  // 保留 svg，其餘重建。chip 數量與內容只有在 open() 時才會變。
  for (const el of [...host.querySelectorAll(".chip, .ear")]) el.remove();

  for (const t of shown) {
    const el = document.createElement("button");
    el.type = "button";
    el.className = "chip";
    el.style.setProperty("--c", TRACK_COLORS[t] ?? "#888");
    // 兩行：軌名 + 樂器名。樂器名不是裝飾 —— 「誰站哪裡」靠它判斷。
    const nm = document.createElement("span");
    nm.className = "nm";
    nm.textContent = i18n.trackName(t);
    const inst = document.createElement("span");
    inst.className = "inst";
    inst.textContent = tracks.instNameOf(t);
    el.append(nm, inst);
    el.dataset.track = String(t);
    // 兩行拼成一句才是螢幕閱讀器該聽到的東西 —— 分兩個 span 會斷成兩截。
    el.setAttribute("aria-label",
      [i18n.trackName(t), tracks.instNameOf(t)].filter(Boolean).join(" · "));
    place(el, pos.get(t));
    host.appendChild(el);
  }

  const ear = document.createElement("button");
  ear.type = "button";
  ear.className = "ear";
  ear.setAttribute("aria-label", i18n.t("stage.listener"));
  place(ear, listener);
  host.appendChild(ear);

  drawRings();
  syncSpatial();
}

/**
 * 「第 7 軌之後不會出現在這個檔案裡」的**事前**警告。匯出會產生一個要拿去給人聽的檔案，事
 * 後才說「少了 3 軌」已經來不及了 —— 而這個框有一顆「開始匯出」按鈕，也就有一個「按之前」
 * 的時機。同 sharebox 那個先例。
 *
 * 只講**真的有音符**的輔助軌。空的不講話，那是常態。
 */
function syncDrop() {
  const el = $("#stageDrop");
  const song = getSong();
  const dropped = song ? droppedTracks(song) : [];
  el.hidden = !dropped.length;
  if (dropped.length) {
    el.textContent = i18n.t("stage.dropped",
      { list: i18n.clause(dropped.map(n => i18n.trackName(n - 1))), kept: GAME_TRACKS });
  }
}

// ─── 拖曳 ───────────────────────────────────────────────────────────────────

/**
 * 拖了就代表「我要空間感」。**自動勾起來而不是彈一句話** —— 使用者已經用動作表達了意圖，
 * 再問一次是多餘的；而拖完卻沒有任何變化才是真的困惑。
 */
function armSpatial() {
  if (spatial) return;
  spatial = true;
  syncSpatial();
  if (player.isPlaying()) applySpatial();
}

/**
 * 一套 Pointer Events 同時吃滑鼠與觸控。**不吸附** —— 位置是連續的物理量。
 */
function bindDrag(host) {
  let target = null, grab = null;

  host.addEventListener("pointerdown", e => {
    const el = e.target.closest(".chip, .ear");
    if (!el || busy) return;
    target = el;
    const m = toMetres(e);
    const cur = el.classList.contains("ear") ? listener : pos.get(Number(el.dataset.track));
    // 記下指標與中心的差，不然一按下去 chip 就會跳到指標底下。
    grab = { x: cur.x - m.x, z: cur.z - m.z };
    el.setPointerCapture(e.pointerId);
    el.classList.add("grab");
    e.preventDefault();
  });

  host.addEventListener("pointermove", e => {
    if (!target) return;
    armSpatial();
    const m = toMetres(e);
    const p = clampPos({ x: m.x + grab.x, z: m.z + grab.z });
    if (target.classList.contains("ear")) {
      listener = p;
      drawRings();
      engine.setSpatialListener(p);
    } else {
      const t = Number(target.dataset.track);
      pos.set(t, p);
      // 拖曳中就更新音訊圖 —— 一邊聽一邊挪才是這個介面存在的理由。
      engine.setSpatialPosition(chanOf(t), p);
    }
    place(target, p);
  });

  const drop = () => {
    if (!target) return;
    target.classList.remove("grab");
    target = null;
    persist();
  };
  host.addEventListener("pointerup", drop);
  host.addEventListener("pointercancel", drop);

  // 鍵盤也要能挪 —— 舞台是這個功能的主要操作介面。
  host.addEventListener("keydown", e => {
    const el = e.target.closest(".chip, .ear");
    if (!el || busy) return;
    const d = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] }[e.key];
    if (!d) return;
    e.preventDefault();
    armSpatial();
    const isEar = el.classList.contains("ear");
    const t = Number(el.dataset.track);
    const cur = isEar ? listener : pos.get(t);
    const p = clampPos({ x: cur.x + d[0] * STEP_M, z: cur.z + d[1] * STEP_M });
    if (isEar) { listener = p; drawRings(); engine.setSpatialListener(p); }
    else { pos.set(t, p); engine.setSpatialPosition(chanOf(t), p); }
    place(el, p);
    persist();
  });
}

// ─── 匯出 ───────────────────────────────────────────────────────────────────

function setBusy(on) {
  $("#stageProg").hidden = !on;
  $("#stageGo").hidden = on;
  $("#stageReset").disabled = on;
  $("#stageSpatial").disabled = on;
  $("#stagePlay").disabled = on;
  $("#stageSeek").disabled = on;
  plot().classList.toggle("busy", on);
  syncSpatial();
}

/** 滑桿旁邊的讀數。整數百分比 —— 小數點在這裡沒有任何人做得了決定。 */
function syncEnvAmt() {
  $("#stageEnvAmt").value = envAmt;
  $("#stageEnvAmtValue").textContent = `${Math.round(envAmt * 100)}%`;
}

const envNote = msg => {
  const e = $("#stageEnvNote");
  e.textContent = msg;
  e.hidden = !msg;
};

/**
 * 把目前選的環境音套到**試聽**上：環境床立刻響、殘響掛進音樂的鏈路。
 *
 * ─── 為什麼這裡是即時的，而影片頁是烘的 ───
 *
 * 因為這一頁的試聽本來就是 `player.js` **即時合成**的，根本沒有母帶可以烘 —— 而匯出走的是
 * 離線那條。所以這一頁本來就沒有「預覽等於成品」的承諾（兩套合成器連音符都不會逐 byte 相
 * 同），加一層即時的環境音不會讓它退步。
 *
 * 殘響的插點是 `engine.setTail`，也就是 `out` 與 `destination` 之間。**DSP 跟匯出是同一份**
 * （`envreverb.js`），所以試聽跟成品聽到的是同一個空間。
 */
async function applyEnv() {
  const preset = envPreset(envId);
  envNote("");
  try {
    // 先把這個環境**所有**的素材抓齊，包含雷聲 —— 試聽只會用到環境床，所以少了這一步的話
    // 「暴雨」的雷要等到按下匯出才發現抓不到，而那時候使用者已經等了合成那一整段。
    await envlive.prefetch(preset);
    const ctx = engine.context();
    if (ctx) {
      envlive.attach(ctx);
      await envlive.attachReverb(ctx, engine.setTail, preset.reverb);
      await envlive.audition(preset, envAmt);
    }
  } catch (err) {
    console.error("[混音匯出]", err);
    envNote(i18n.t("stage.err.envload"));
  }
}

/** 收掉試聽的環境音，並把音樂的鏈路接回去。**關框一定要叫** —— 不叫的話雨會一直下。 */
function stopEnv() {
  envlive.stop();
  engine.setTail(null);
}

/**
 * 匯出要用的環境音素材。選「無」就回 `null`（`exportMp3` 那邊 null 就是完全跳過）。
 *
 * **抓不到素材就往外丟**，不安靜地退回乾聲 —— 那種錯誤要等到使用者把檔案發出去才會被發現，
 * 而 `go()` 的 catch 會把它變成畫面上的一句話（`stage.err.envload`）。
 *
 * 種子從**樂譜本身**長出來：同一首譜每次匯出的雷都打在同一個地方，重匯一次得到同一個檔。
 */
async function envForExport() {
  const preset = envPreset(envId);
  if (preset.id === ENV_PRESETS[0].id) return null;
  const assets = await envlive.loadForBake(preset, SAMPLE_RATE);
  return {
    preset, amount: envAmt, ...assets,
    seed: seedOfSong(getSong()),
  };
}

async function go() {
  const song = getSong();
  const bank = getBank();
  if (!song || !bank || busy) return;

  // 匯出期間不要一邊放試聽 —— 使用者要看的是進度，而且試聽佔著 worklet。
  //
  // **環境音那一層也要收掉。** 殘響會被烘進檔案，同時還掛在試聽的鏈路上的話，它會跟匯出用掉
  // 的 CPU 搶同一顆 worklet；而環境床更明確 —— 匯出中還在放雨聲只會讓人以為那是檔案的聲音。
  stopPreview();
  stopEnv();

  busy = new AbortController();
  setBusy(true);
  const bar = $("#stageBar"), label = $("#stageStage");
  bar.value = 0;

  try {
    const blob = await exportMp3({
      song,
      // **只送前 GAME_TRACKS 軌的音色**，跟 mixnotes 只產生那幾軌的事件對齊。
      presets: Array.from({ length: GAME_TRACKS }, (_, i) => tracks.presetOf(i)),
      bank,
      // 空間混音關著就給 null —— mixdown 那邊 null 就是平面路徑。
      stage: spatial ? {
        // `positions` 照軌序，mixdown 自己去對 channel。
        positions: Array.from({ length: GAME_TRACKS }, (_, t) => pos.get(t) ?? null),
        listener, headphones,
      } : null,
      env: await envForExport(),
      signal: busy.signal,
      onProgress: (p, phase) => {
        bar.value = p;
        label.textContent = i18n.t(`stage.phase.${phase}`);
      },
    });

    // 檔名沿用檔案框那一欄 —— 只有一個「這首曲子叫什麼」。
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `${safeFileName($("#expName")?.value)}.mp3`;
    a.click();
    URL.revokeObjectURL(a.href);
    // **舞台不關。** 混音匯出本來就是「排 → 匯出 → 聽 → 再排」的迴圈。
  } catch (err) {
    // 取消是使用者自己按的，不必再說一次。
    if (err.code !== "cancelled") {
      console.error("[混音匯出]", err);
      // 認得的失敗給具體的一句話（尤其是 OOM），認不得的才落到通用句 —— `t()` 沒有
      // fallback 參數，所以先問 `has()`。兩邊都寫成完整的 `i18n.t(...)` 呼叫：語言檔的
      // 孤兒檢查是掃原始碼認 key 的。
      say(i18n.has(`stage.err.${err.code}`)
        ? i18n.t(`stage.err.${err.code}`)
        : i18n.t("stage.err.unknown"));
    }
  } finally {
    busy = null;
    setBusy(false);
  }
}

// ─── 對外 ───────────────────────────────────────────────────────────────────

export function open() {
  const saved = storage.loadedStage();
  if (saved) {
    placed = saved.pos ?? {};
    listener = saved.listener ?? { ...DEFAULT_LISTENER };
    headphones = saved.headphones !== false;
    spatial = !!saved.spatial;
  }
  const env = storage.loadedEnv();
  // **一律經過 `envPreset`** —— 那是舊 id 落回「無」的地方，同舞台佈局走 `clampPos`。
  envId = envPreset(env.id).id;
  envAmt = env.amount ?? 1;
  $("#stageEnv").value = envId;
  syncEnvAmt();
  applyEnv();

  $("#stageSpk").checked = !headphones;
  layout();
  render();
  syncDrop();
  box().classList.add("on");
  // 已經在播的話當場套上（不打斷它）；沒在播就等按下試聽。
  if (player.isPlaying()) { armPreviewMutes(); applySpatial(); }
  // 直接跑一次而不是只排一幀：等下一幀會閃一下空按鈕。
  tick();
}

export function isBusy() { return !!busy; }

/**
 * @param {object} hooks
 * @param {() => object|null} hooks.getSong 目前的解析結果
 * @param {() => object|null} hooks.getBank 音色庫來源（內建的 URL 或使用者載的 File）
 * @param {() => void} hooks.prepare 送音色，同編輯器按下演奏前那一步
 * @param {() => void} hooks.restore 把編輯器的靜音狀態放回去（試聽收掉之後）
 */
export function init({ getSong: song, getBank: bank, prepare: prep, restore: rest } = {}) {
  getSong = song ?? getSong;
  getBank = bank ?? getBank;
  prepare = prep ?? prepare;
  restore = rest ?? restore;

  const host = plot();
  if (!host) return;
  bindDrag(host);

  $("#stageGo").addEventListener("click", go);
  $("#stageCancel").addEventListener("click", () => busy?.abort());

  // ── 環境音 ──
  const sel = $("#stageEnv");
  for (const p of ENV_PRESETS) {
    const o = document.createElement("option");
    o.value = p.id;
    o.textContent = i18n.t(`env.preset.${p.id}`);
    sel.append(o);
  }
  sel.addEventListener("change", () => {
    if (busy) return;
    envId = envPreset(sel.value).id;
    persist();
    applyEnv();
  });
  // 滑桿走 `input`：這裡**沒有東西要重算**（匯出時才烘），所以每一格都跟上是免費的 ——
  // 跟影片頁不同，那邊拖一格就要重烘一次母帶，所以它只在 `change` 動。
  $("#stageEnvAmt").addEventListener("input", () => {
    if (busy) return;
    envAmt = +$("#stageEnvAmt").value;
    syncEnvAmt();
    envlive.setAmount(envPreset(envId), envAmt);
  });
  $("#stageEnvAmt").addEventListener("change", persist);

  $("#stageReset").addEventListener("click", () => {
    if (busy) return;
    placed = {};
    listener = { ...DEFAULT_LISTENER };
    // 重設也把空間混音關回去 —— 「重設」要能一步回到預設的那個狀態，不然它只重設了一半。
    spatial = false;
    engine.disableSpatial();
    layout();
    render();
    persist();
  });

  $("#stageSpatial").addEventListener("change", e => {
    if (busy) return;
    spatial = e.target.checked;
    syncSpatial();
    persist();
    applySpatial();
  });

  $("#stageSpk").addEventListener("change", e => {
    headphones = !e.target.checked;
    persist();
    // 換模型要重建 panner（順便把佈局重新套上）。
    if (engine.isSpatial()) applySpatial();
  });

  $("#stagePlay").addEventListener("click", togglePlay);

  // 拖動期間先掛旗標，不然時鐘每一幀都會把滑桿拉回播放頭的位置。
  const seek = $("#stageSeek");
  seek.addEventListener("pointerdown", () => { scrubbing = true; });
  seek.addEventListener("input", () => {
    const dur = getSong()?.duration ?? 0;
    $("#stageTime").textContent = mmss(seek.value * dur);
  });
  const land = () => {
    if (!scrubbing) return;
    scrubbing = false;
    const dur = getSong()?.duration ?? 0;
    // 沒在播就不動 —— seekTo 對停著的播放器沒有意義。
    if (player.isPlaying()) player.seekTo(seek.value * dur);
  };
  seek.addEventListener("pointerup", land);
  seek.addEventListener("pointercancel", land);
  seek.addEventListener("change", land);   // 鍵盤操作走這條

  // 關掉：匯出中先中斷、試聽要收乾淨。點背景與 Esc **都得經過這裡**。
  const close = () => { busy?.abort(); stopPreview(); stopEnv(); box().classList.remove("on"); };
  box().addEventListener("click", e => { if (e.target === box()) close(); });
  addEventListener("keydown", e => {
    if (e.key === "Escape" && box().classList.contains("on")) close();
  });
}
