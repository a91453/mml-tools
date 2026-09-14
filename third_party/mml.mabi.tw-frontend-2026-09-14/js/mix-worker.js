// ────────────────────────────────────────────────────────────────────────────
//  混音匯出：離線合成 Worker
//
//  播放走的是 `WorkletSynthesizer` 加上 `player.js` 的 look-ahead 排程器，而**那條路離線用
//  不了**（排程器是 setInterval，而離線渲染沒有會前進的時鐘）。所以這裡直接開
//  `SpessaSynthProcessor` —— **純 JS**、跟 AudioContext 無關的合成器，自己逐塊往前推。
//
//  跑在 Worker 裡最重要的理由是取消（一行 terminate()）；另外兩個是不凍住畫面，以及音色庫
//  在這裡自己取得（主執行緒那份 ArrayBuffer 已經 transfer 給 worklet 了）。
// ────────────────────────────────────────────────────────────────────────────

import { SoundBankLoader, SpessaSynthProcessor } from "../vendor/spessasynth_core.js";
import { EV_STRIDE, buildSetup } from "./mixnotes.js";
import { presetsForPrograms } from "./instruments.js";

/**
 * 一次渲染幾個 sample。**必須是 128**，不是效能旋鈕：AudioWorklet 的 render quantum 就是 128，
 * 而合成器內部有一些「每塊更新一次」的量 —— 塊變大聲音會**很接近但不完全一樣**，而匯出的驗收
 * 標準是「跟編輯器聽起來一樣」。
 */
const BLOCK = 128;

/** 平面模式一次回傳幾秒。10 秒的 stereo float 約 3.5 MB，postMessage 的成本可以忽略。 */
const CHUNK_SEC = 10;

/** 音色庫：內建的自己 fetch（走 HTTP cache），使用者自己載的則是直接把 File 傳進來。 */
async function readBank(bank) {
  if (bank.kind === "file") return bank.file.arrayBuffer();
  const r = await fetch(bank.url);
  if (!r.ok) throw new Error(`音色庫取得失敗（HTTP ${r.status}）`);
  return r.arrayBuffer();
}

/**
 * 開場要送的音色。`setup` 直接給就直接用（編輯器那條路：使用者在下拉裡選的，是精確的）；
 * 只給 `programs` 就在**這裡**解析 —— 那是影片匯出那條路，它手上只有分享的 MML 帶得動的
 * `@n`，而把 `@n` 對回 `[msb, lsb, program]` 需要**音色庫篩過的清單**，那份清單只有載完
 * bank 的這裡才有（見 `instruments.presetsForPrograms`）。
 *
 * 規則跟 `tracks.applyPrograms` 是同一條，實作也是同一支函式 —— 各寫一份的症狀是「影片的
 * 某一軌是別的樂器」，聽得出來不對但查不出為什麼。
 */
function setupFor({ setup, programs, defMap }, synth) {
  if (setup) return setup;
  const presets = presetsForPrograms(programs, synth.soundBankManager.presetList, defMap);

  // **對不到的軌要講出來。** `presetsForPrograms` 對不到就回 null，而 `buildSetup` 會把 null
  // 跳過 —— 於是那條 channel 完全收不到 programChange，用的是合成器的預設音色。症狀是
  // 「某一軌聽起來是別的樂器」，而畫面、時間、音量全都正常，沒有任何地方會報錯。
  //
  // 分享出去的譜理論上不會發生（編輯器的下拉只給得出 .def 裡的音色），所以這裡不改行為、
  // 只讓它變成看得見的東西：真的發生了，就代表那份分享是用別的音色庫做出來的。
  const missing = programs
    .map((prog, i) => (prog !== null && prog !== undefined && !presets[i] ? `第 ${i + 1} 軌 @${prog}` : ""))
    .filter(Boolean);
  if (missing.length) {
    console.warn(`[混音] 這幾軌的 @n 在音色庫裡找不到，會用合成器的預設音色：${missing.join("、")}`);
  }
  return buildSetup(presets);
}

async function makeSynth({ bank, setup, programs, defMap, sampleRate, channels }) {
  const synth = new SpessaSynthProcessor(sampleRate, { maxBufferSize: BLOCK });
  await synth.processorInitialized;

  // 建構子只開 16 條，而站上要 17 條（16 ＋ config.AUDITION_CH）。順序刻意跟 `engine.loadBank`
  // 一模一樣（**等就緒 → 補 channel → 載音色庫**）：匯出要跟編輯器聽起來一樣，那就不能有任何
  // 一項初始狀態不同。
  while (synth.midiChannels.length < channels) synth.createMIDIChannel();

  synth.soundBankManager.addSoundBank(SoundBankLoader.fromArrayBuffer(await readBank(bank)), "main");
  postMessage({ type: "banked" });

  // 站上對合成器的 per-channel 控制只有這一種（見 mixnotes.buildSetup 的說明）。
  for (const s of setupFor({ setup, programs, defMap }, synth)) {
    synth.controllerChange(s.ch, 0, s.msb);
    synth.controllerChange(s.ch, 32, s.lsb);
    synth.programChange(s.ch, s.prog);
  }
  return synth;
}

/**
 * 把 `[from, to)` 這一段推完，中途把到期的事件發出去。`write(startIndex, n)` 由呼叫端決定要渲染
 * 進哪裡 —— 兩種模式的差別只有這一行，而**這一份必須是同一份**：各寫一次事件迴圈的話兩者遲早會
 * 漂開，那時「分軌聽起來不一樣」就分不出是空間化還是迴圈寫錯。
 *
 * 停在事件上是 sample 精確的關鍵：塊的邊界不會把音符推到 128 的格子上。
 */
function advance(synth, ev, from, to, write) {
  let frame = from;
  while (frame < to) {
    // `<=` 而不是 `===`：四捨五入可能讓兩個事件落在同一個 frame，而落在過去的也要一起清掉。
    while (ev.i < ev.count && ev.events[ev.i * EV_STRIDE] <= frame) {
      const o = ev.i * EV_STRIDE;
      const ch = ev.events[o + 1], midi = ev.events[o + 2], vel = ev.events[o + 3];
      if (vel < 0) synth.noteOff(ch, midi);
      else synth.noteOn(ch, midi, vel);
      ev.i++;
    }
    const nextEvent = ev.i < ev.count ? ev.events[ev.i * EV_STRIDE] : to;
    const n = Math.min(nextEvent - frame, BLOCK, to - frame);
    if (n <= 0) throw new Error(`推不動：frame=${frame} next=${nextEvent} to=${to}`);
    write(frame - from, n);
    frame += n;
  }
}

/** 主執行緒說「下一段」之前先停在這裡。 */
let resume = null;
const waitNext = () => new Promise(r => { resume = r; });

/**
 * 分軌 + 分段。**每段算完就停下來等主執行緒**（嚴格乒乓）—— 不等的話每一段好幾十 MB 會在佇列裡
 * 疊起來，那正是分段要避免的那件事。
 *
 * 沒有在用的 channel **共用同一組 scratch buffer**：`processSplit` 的
 * `outputIndex = v.channel % outputs.length`，所以 outputs 一定要照 channel 數配滿否則會繞回去
 * （第 17 條的聲音會跑到第 1 條的匯流排）—— 但每一組都配獨立記憶體是浪費，指向同一塊就好。
 */
async function renderSpatial({ events, count, totalFrames, sampleRate, channels, buses, segFrames }, synth) {
  const ev = { events, count, i: 0 };
  const scratchL = new Float32Array(segFrames), scratchR = new Float32Array(segFrames);

  for (let at = 0; at < totalFrames; at += segFrames) {
    const frames = Math.min(segFrames, totalFrames - at);

    // 每段都要新的 buffer：上一段的已經 transfer 出去了，而 `renderVoice` 是**加**進 output
    // 竹的。
    const dry = buses.map(ch => ({ ch, left: new Float32Array(frames), right: new Float32Array(frames) }));
    const byCh = new Map(dry.map(d => [d.ch, d]));
    const outputs = Array.from({ length: channels }, (_, ch) => {
      const d = byCh.get(ch);
      return d ? [d.left, d.right] : [scratchL, scratchR];
    });
    const wetLeft = new Float32Array(frames), wetRight = new Float32Array(frames);

    advance(synth, ev, at, at + frames,
      (i, n) => synth.processSplit(outputs, wetLeft, wetRight, i, n));

    const move = [wetLeft.buffer, wetRight.buffer];
    for (const d of dry) move.push(d.left.buffer, d.right.buffer);
    postMessage({ type: "segment", at, frames, dry, wetLeft, wetRight }, move);
    postMessage({ type: "progress", frame: at + frames, totalFrames });
    await waitNext();
  }
}

/**
 * 平面 2ch，一路算到底。**舞台上「空間混音」沒勾的時候走的就是這一條**（`stage: null`，見
 * mixdown.renderPcm）—— 它不經過任何空間化，是「跟編輯器一樣」的基準，也是這個站的預設。
 *
 * 不能用「六個 panner 全部擺在同一點」來代替：`PannerNode` 會把每個 channel 自己的立體聲像
 * 塌成一個點音源，聽起來比編輯器窄。
 */
function renderFlat({ events, count, totalFrames, sampleRate }, synth) {
  const ev = { events, count, i: 0 };
  const chunkFrames = Math.max(BLOCK, Math.round(CHUNK_SEC * sampleRate));

  for (let at = 0; at < totalFrames; at += chunkFrames) {
    const frames = Math.min(chunkFrames, totalFrames - at);
    const left = new Float32Array(frames), right = new Float32Array(frames);
    advance(synth, ev, at, at + frames, (i, n) => synth.process(left, right, i, n));
    postMessage({ type: "chunk", at, frames, left, right }, [left.buffer, right.buffer]);
    postMessage({ type: "progress", frame: at + frames, totalFrames });
  }
}

async function render(msg) {
  const synth = await makeSynth(msg);
  if (msg.spatial) await renderSpatial(msg, synth);
  else renderFlat(msg, synth);
  synth.destroySynthProcessor();
  postMessage({ type: "done", totalFrames: msg.totalFrames });
}

onmessage = e => {
  const d = e.data;
  if (d?.type === "next") { const r = resume; resume = null; r?.(); return; }
  if (d?.type !== "render") return;
  render(d).catch(err => {
    postMessage({ type: "error", message: err?.message ?? String(err) });
  });
};
