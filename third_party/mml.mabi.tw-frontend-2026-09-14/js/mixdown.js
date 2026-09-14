// ────────────────────────────────────────────────────────────────────────────
//  混音匯出：流程協調
//
//  三段各自在自己該在的地方，這裡只負責接起來、報進度、能取消：
//
//    合成      mix-worker.js        純 JS 的 SpessaSynthProcessor，分軌逐段吐 PCM
//    空間混音  OfflineAudioContext  只能在主執行緒（Worker 裡沒有 AudioContext）
//    編碼      mp3-worker.js        LAME
//
//  中間那段為什麼要分段：天真的做法（每個樂器一條全長的 buffer）在 5 分鐘的曲子上是好幾百
//  MB，而 `AudioBuffer` 還要自己一份。分段之後記憶體只跟段長有關。
//
//  接縫用**重疊相加**，而它是數學上精確的而不是「聽不太出來」—— 位置在渲染期間是靜態的，
//  所以空間化是一個線性非時變系統（見 mixmath.addInto）。
//
//  ─── 為什麼分成 renderPcm 與 encodeMp3 兩支 ───
//
//  mp3 只是母帶的其中一個出海口。鋼琴瀑布影片要的是**LAME 之前**那份 Float32 PCM（它要餵給
//  WebCodecs 的 AudioEncoder 再 mux 進 MP4）。合成那一段一模一樣，所以切在這裡；`exportMp3`
//  只是把兩支接起來並且把兩段進度併成一條。
// ────────────────────────────────────────────────────────────────────────────

import { assetURL, chanOf } from "./config.js";
import { buildEvents, buildSetup, notedTracks } from "./mixnotes.js";
import { peakOf, gainFor, trimTail, planSegments, addInto, PANNER } from "./mixmath.js";
import { bakeSteps } from "./envaudio.js";

/**
 * 輸出取樣率。**固定 44100，不跟裝置的 `ctx.sampleRate` 走** —— 同一份譜在不同機器上要匯出成同
 * 一個檔案，而 48000 的機器算出來的 mp3 會大一成、長度也差幾個 sample。
 */
export const SAMPLE_RATE = 44100;

/**
 * 位元率。CBR —— lamejs 的 VBR 有已知問題。
 * 192 對這種素材夠透明，5 分鐘約 7 MB。不做成選項：那是使用者做不了的決定。
 */
export const KBPS = 192;

/**
 * 合成器要開幾條 channel。**同 `engine.loadBank`**：16 條加上 `config.AUDITION_CH`（第 17 條，
 * 試聽專用）。匯出實際只用到前 6 軌對到的 channel，但這個數字要跟編輯器一模一樣 —— 它決定
 * `processSplit` 的 `channel % outputs.length` 會不會繞回去。
 */
const CHANNELS = 17;

/**
 * 一段多長。段長只影響記憶體與乒乓的次數，不影響結果（重疊相加是精確的）。10 秒：一段是
 * `10 × 44100 × 2ch × 4B × 6 條` ≈ 21 MB，手機也吃得下。
 */
const SEG_SEC = 10;

/**
 * 每段多渲染這麼久，讓 HRTF 的卷積尾巴走完，然後把它加進下一段的開頭。WebAudio 的 HRTF 脈衝
 * 響應遠短於 50 ms；不夠的話症狀是每 10 秒一個很輕微的斷點，聽起來像「有點髒」而不像「有 bug」。
 */
const OVERLAP_SEC = 0.05;

/**
 * 進度權重：合成 + 空間混音佔 72%，環境音佔 8%，編碼佔 20%。原本規劃是 70/10/20，但合成與空間
 * 混音是交錯跑的（一段合成完就馬上混），分不開來報。
 *
 * 環境音那一段**選「無」時是零成本的**（`bakeSteps` 直接把乾聲原樣傳回），所以進度會從 72%
 * 一口氣跳到 80% —— 那是對的，不是卡住。
 */
const W_RENDER = 0.72;
const W_ENV = 0.08;

const fail = (code, message) => Object.assign(new Error(message), { code });

/**
 * 開一個 Worker，把它的訊息一路轉給 `onMessage`，直到 done / error / 取消。取消就是
 * `terminate()` —— 這是整個功能選擇把重活放進 Worker 的主要理由。
 *
 * `onMessage` 可以回傳 Promise，這裡會等它，而且它丟出來的錯誤要能讓整個匯出失敗。
 */
function run(url, msg, transfer, onMessage, signal) {
  return new Promise((resolve, reject) => {
    const worker = new Worker(url, { type: "module" });
    const stop = () => { worker.terminate(); signal?.removeEventListener("abort", onAbort); };
    const onAbort = () => { stop(); reject(fail("cancelled", "已取消")); };

    if (signal?.aborted) return onAbort();
    signal?.addEventListener("abort", onAbort);

    worker.onmessage = e => {
      const d = e.data;
      if (d.type === "error") { stop(); reject(fail("worker", d.message)); return; }
      if (d.type === "done") { stop(); resolve(d); return; }
      Promise.resolve(onMessage(d, worker)).catch(err => { stop(); reject(err); });
    };
    // Worker 自己爆掉（多半是 OOM，手機上很常見）。這裡不能只說「匯出失敗」—— 使用者要知道
    // 下一步該做什麼。
    worker.onerror = err => {
      stop();
      reject(fail("oom", err?.message || "Worker 意外終止（多半是記憶體不足）"));
    };
    worker.postMessage(msg, transfer ?? []);
  });
}

/**
 * 聽者。**朝向固定：永遠面向畫面上方（−z）** —— 「畫面上方 = 正前方」是一條學一次就永遠成立的
 * 規則，而旋轉能表達的東西，「把樂器拖到聽者下面」全都做得到。
 *
 * `positionX` 那組 AudioParam 是後來才加的，舊的 Safari 只有 `setPosition`。兩條路都留著，因為
 * 少了 fallback 的症狀是整首歌完全靜音。
 */
function setListener(l, { x, z }) {
  if (l.positionX) {
    l.positionX.value = x; l.positionY.value = 0; l.positionZ.value = z;
    l.forwardX.value = 0; l.forwardY.value = 0; l.forwardZ.value = -1;
    l.upX.value = 0; l.upY.value = 1; l.upZ.value = 0;
  } else {
    l.setPosition(x, 0, z);
    l.setOrientation(0, 0, -1, 0, 1, 0);
  }
}

/**
 * 一段乾聲 → 一段 2ch 空間混音。渲染長度是「段長 + 重疊」：多出來的那截是卷積的尾巴，由呼叫端
 * 加進下一段的開頭。
 */
function spatialize(seg, { positions, listener, model, sampleRate, tailFrames }) {
  const ctx = new OfflineAudioContext(2, seg.frames + tailFrames, sampleRate);
  setListener(ctx.listener, listener);

  for (const d of seg.dry) {
    const p = positions.get(d.ch);
    if (!p) continue;
    const buf = ctx.createBuffer(2, seg.frames, sampleRate);
    buf.copyToChannel(d.left, 0);
    buf.copyToChannel(d.right, 1);
    const src = new AudioBufferSourceNode(ctx, { buffer: buf });
    const panner = new PannerNode(ctx, {
      panningModel: model, ...PANNER,
      positionX: p.x, positionY: 0, positionZ: p.z,
    });
    src.connect(panner).connect(ctx.destination);
    src.start(0);
  }
  return ctx.startRendering();
}

/**
 * 整首歌 → 一對 Float32 母帶。**這是 mp3 與影片共用的那一段。**
 *
 * 回傳的 `gain` 是「只縮不放」的音量係數，而且**故意不套上去** —— 套用的最便宜的地方是轉成
 * 目標格式的那一趟（mp3 是轉 Int16 的迴圈），在這裡先乘一遍等於白跑一億次乘法。
 *
 * @param {object}   o
 * @param {object}   o.song      `mml.parseAll` 的結果
 * @param {(number[]|null)[]} [o.presets]  每一軌的 `[msb, lsb, program]`。編輯器那條路用它
 *        —— 使用者在下拉裡選的，是精確的
 * @param {number[]} [o.programs] 每一軌只有 `@n`（MIDI program）時給這個，**與 `presets` 二選一**。
 *        影片匯出走這條：分享出去的 MML 只帶得動 program，而把它對回 `[msb, lsb, program]` 需要
 *        音色庫篩過的清單，那份清單只有 Worker 載完 bank 之後才有（見 mix-worker.setupFor）
 * @param {Map} [o.defMap] 配 `programs` 用的 `.def` 對照表（`instruments.parseDef().map`）
 * @param {{kind:"url",url:string}|{kind:"file",file:File}} o.bank 音色庫的來源
 * @param {{positions:({x:number,z:number}|null)[], listener:{x:number,z:number}, headphones:boolean}|null} [o.stage]
 *        舞台佈局（`positions` 照軌序）。**給 null 就是平面混音**，聽起來跟編輯器一樣。
 *        不能用「所有 panner 擺在同一點」來代替平面：`PannerNode` 會把每個 channel 自己的
 *        立體聲像塌成點音源，聽起來比編輯器窄。
 * @param {(p:number)=>void} [o.onProgress] p 是 0..1
 * @param {AbortSignal} [o.signal]
 * @returns {Promise<{left:Float32Array, right:Float32Array, sampleRate:number, gain:number}>}
 */
export async function renderPcm({
  song, presets = null, programs = null, defMap = null,
  bank, stage = null, onProgress = () => {}, signal,
}) {
  if (!presets && !programs) throw fail("nopresets", "沒有指定音色（presets 或 programs 給一個）");
  const sampleRate = SAMPLE_RATE;
  const { events, count, totalFrames } = buildEvents(song, { sampleRate });
  if (!count) throw fail("silent", "這首曲子沒有任何會發聲的音符");

  const spatial = !!stage;
  const segFrames = Math.round(SEG_SEC * sampleRate);
  const tailFrames = spatial ? Math.round(OVERLAP_SEC * sampleRate) : 0;

  // 舞台上的位置照**軌序**，而合成器認的是 channel。這個對照只在這裡做一次。
  const sounding = notedTracks(song);
  const positions = new Map(spatial
    ? sounding.map(t => [chanOf(t), stage.positions[t]]).filter(([, p]) => p)
    : []);
  const buses = [...positions.keys()];
  if (spatial) {
    if (!buses.length) throw fail("silent", "沒有任何一軌需要混音");
    // 有聲音卻沒有位置的軌會**整軌消失**：它的乾聲被 `processSplit` 寫進共用的 buffer，而
    // 沒有 panner 去接。所以缺位置就整件事不做，不讓它靜靜不見。
    if (buses.length !== sounding.length) {
      throw fail("nopos", `有 ${sounding.length - buses.length} 軌在舞台上沒有位置`);
    }
  }

  // 母帶要多留重疊那一截：最後一段的尾巴會落在 totalFrames 之外，而那段本來就在 TAIL_SEC 的
  // 估算裡。
  let left, right;
  try {
    left = new Float32Array(totalFrames + tailFrames);
    right = new Float32Array(totalFrames + tailFrames);
  } catch {
    // 一億個 sample × 2 聲道 × 4 bytes ≈ 100 MB／5 分鐘。桌機沒問題，手機不一定。
    throw fail("oom", "記憶體不足，配置不出這首曲子的母帶");
  }

  const segs = planSegments(totalFrames, spatial ? segFrames : totalFrames).length;
  let done = 0, got = 0;

  const rendered = await run(assetURL("js/mix-worker.js"),
    {
      type: "render", spatial, bank, events, count, totalFrames,
      // 二選一：`setup` 是算好的，`programs` 要 Worker 載完 bank 才解得開。
      setup: presets ? buildSetup(presets) : null,
      programs, defMap,
      sampleRate, channels: CHANNELS,
      buses, segFrames,
    },
    [events.buffer],
    async (d, worker) => {
      if (d.type === "segment") {
        const out = await spatialize(d, {
          positions, listener: stage.listener, sampleRate, tailFrames,
          model: stage.headphones ? "HRTF" : "equalpower",
        });
        // 乾聲：**加**進去而不是覆蓋 —— 上一段的卷積尾巴已經寫在這裡了。
        addInto(left, out.getChannelData(0), d.at);
        addInto(right, out.getChannelData(1), d.at);
        // 濕聲不定位（殘響是全體共用的一組 stereo，`processSplit` 分不開它），所以直接接上去。
        //
        // **目前這一條實際上永遠是零。** `reverbDepth`（CC91）在 `DEFAULT_MIDI_CONTROLLERS`
        // 裡沒有重置值，而站上從來沒有送過 CC91 —— **這個站本來就沒有殘響**，即時播放與匯出
        // 都一樣。留著這條路是因為它是對的架構。連帶的後果：因為沒有殘響，**深度只剩音量**
        // 這一個線索。
        addInto(left, d.wetLeft, d.at);
        addInto(right, d.wetRight, d.at);
        got += d.frames;
        onProgress(++done / segs);
        worker.postMessage({ type: "next" });     // 乒乓：算下一段
      } else if (d.type === "chunk") {
        left.set(d.left, d.at);
        right.set(d.right, d.at);
        got += d.frames;
        onProgress(got / totalFrames);
      }
    }, signal);

  // 收到的 frame 數要跟 Worker 說它渲染了多少完全相等 —— 少一段的症狀是「中間有一段是靜音」，
  // 而那不會丟例外。
  if (got !== rendered.totalFrames) {
    throw fail("truncated", `音訊搬運不完整：收到 ${got} / ${rendered.totalFrames} frame`);
  }

  // 尾巴那 3 秒是估的上限（見 mixnotes.TAIL_SEC），估多的在這裡還回去。
  const len = trimTail(left, right, sampleRate);
  if (!len) throw fail("silent", "算出來整首都是靜音");

  const l = left.subarray(0, len), r = right.subarray(0, len);
  // 只縮不放：除非會爆，否則不碰使用者的音量。
  return { left: l, right: r, sampleRate, gain: gainFor(peakOf(l, r)) };
}

/**
 * 母帶 → mp3 的 Blob。
 *
 * **會把 `left` / `right` 的底層 buffer 交出去**（transfer 而不是複製：那是 100 MB／5 分鐘，
 * 複製一份等於把記憶體峰值加倍）。呼叫端在這之後不能再讀它們。
 *
 * @param {{left:Float32Array, right:Float32Array, sampleRate:number, gain?:number,
 *          onProgress?:(p:number)=>void, signal?:AbortSignal}} o
 * @returns {Promise<Blob>}
 */
export async function encodeMp3({ left, right, sampleRate, gain = 1, onProgress = () => {}, signal }) {
  const { parts } = await run(assetURL("js/mp3-worker.js"),
    { type: "encode", left, right, sampleRate, kbps: KBPS, gain },
    [left.buffer, right.buffer],
    d => { if (d.type === "progress") onProgress(d.frame / d.totalFrames); },
    signal);
  return new Blob(parts, { type: "audio/mpeg" });
}

/**
 * 整首歌 → 一個 mp3 的 Blob。`renderPcm` 與 `encodeMp3` 接起來，兩段進度併成一條。
 *
 * 參數同 `renderPcm`，多一個 `onProgress(p, stage)` —— `stage` 是 `"render"` / `"encode"` /
 * `"done"`，給 UI 顯示現在在做哪一段。
 *
 * @returns {Promise<Blob>}
 */
export async function exportMp3({
  song, presets, bank, stage = null, env = null, onProgress = () => {}, signal,
}) {
  const dry = await renderPcm({
    song, presets, bank, stage, signal,
    onProgress: p => onProgress(p * W_RENDER, "render"),
  });

  const pcm = env ? await bakeEnv(dry, env, onProgress, signal) : dry;

  const blob = await encodeMp3({
    ...pcm, signal,
    onProgress: p => onProgress(W_RENDER + W_ENV + p * (1 - W_RENDER - W_ENV), "encode"),
  });

  onProgress(1, "done");
  return blob;
}

/**
 * 把環境音烘進母帶。
 *
 * ─── 為什麼在這裡，而不是 `renderPcm` 裡面 ───
 *
 * `renderPcm` 是 10 秒一段、段間重疊 50 ms 的，而那個 50 ms 的合法性建立在「空間化是線性非時
 * 變」上。殘響的尾巴最長 10 秒，塞不進去 —— 跟著分段跑的話每 10 秒一個接縫。
 *
 * 而且環境床**必須在 `trimTail` 之後**：`trimTail` 靠「尾巴變安靜」把估多的 3 秒還回去，一層
 * 恆定的雨聲會讓它永遠找不到安靜。`renderPcm` 的最後一件事就是 `trimTail`，所以「它回來之後」
 * 剛好是唯一正確的時機。
 *
 * ─── 為什麼逐段 yield ───
 *
 * 5 分鐘的曲子這一段要跑 1～3 秒。整段同步跑的話進度條會凍住，而使用者分不出「在算」與「當
 * 掉了」。`bakeSteps` 每算完一塊就讓出去一次，順便把進度報出來。
 *
 * 這裡**不丟 Worker**：那樣要嘛複製 100 MB 的母帶過去（記憶體峰值變三倍），要嘛轉移過去（取消
 * 時就回不來了）。
 */
async function bakeEnv(dry, env, onProgress, signal) {
  const it = bakeSteps({
    ...dry,
    preset: env.preset, amount: env.amount,
    bed: env.bed, thunders: env.thunders, seed: env.seed,
    // mp3 是**你的曲子的檔案**，所以只保證不削波，不做響度正規化 —— 那條線是影片頁才跨的
    // （見 video.js 的檔頭）。
    normalize: (l, r) => gainFor(peakOf(l, r)),
  });
  for (let r = it.next(); ; r = it.next()) {
    if (r.done) return r.value;
    if (signal?.aborted) throw fail("cancelled", "已取消");
    onProgress(W_RENDER + r.value * W_ENV, "env");
    await new Promise(res => setTimeout(res, 0));
  }
}
