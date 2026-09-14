// ────────────────────────────────────────────────────────────────────────────
//  環境音：素材載入與即時試聽
//
//  `envaudio.js` 是純函式（吃 `Float32Array`），這一支是它跟瀏覽器之間的那一層：抓檔案、
//  解碼、以及「選下去就立刻聽到」的那個即時播放圖。
//
//  ─── 為什麼即時試聽與烘焙是兩條路 ───
//
//  它們回答的是不同的問題。**即時試聽回答「這個環境音是什麼聲音」**，要的是零等待；而按下
//  播放鍵聽到的（烘好的母帶）回答「配起來如何」。中間那 1～3 秒的重算就藏在使用者聽第一遍
//  環境音的時候。
//
//  混音舞台框那邊本來就非有即時圖不可 —— 那一頁的試聽是 `player.js` 即時合成的，根本沒有母
//  帶可以烘。既然那套要寫，影片頁拿來當試聽就是免費的。
//
//  ─── 快取的是 ArrayBuffer，不是 AudioBuffer ───
//
//  因為同一個檔案要被解碼成兩種取樣率：即時試聽用裝置的（可能是 48k），烘焙固定用母帶的
//  44.1k（`mixdown.SAMPLE_RATE`）。快取解碼結果的話就得雙份，而慢的那一段是網路不是解碼。
//
//  **`decodeAudioData` 會把傳進去的 `ArrayBuffer` 吃掉**（detach），所以每次解碼前都要
//  `slice()` 一份 —— 少了那個 slice 的症狀是第二次選同一個環境時整段沒有聲音。
// ────────────────────────────────────────────────────────────────────────────

import { assetURL } from "./config.js";
import { ENV_ASSET_DIR, THUNDER_FILES, filesOf } from "./envaudio.js";
import { REVERB_PROFILES } from "./envreverb.js";

/** 抓回來的原始位元組，key 是檔名。**只快取網路那一段。** */
const bytes = new Map();

const fail = (code, message) => Object.assign(new Error(message), { code });

/**
 * 抓一個素材。**抓不到就丟例外，不退回靜音** —— 這條規矩跟 `renderPcm` 寧可丟 `nopos` 也不
 * 讓一軌無聲消失是同一條：安靜地少一塊，症狀會晚到使用者把影片發佈出去才出現。
 */
function fetchAsset(file) {
  if (!bytes.has(file)) {
    bytes.set(file, fetch(assetURL(ENV_ASSET_DIR + file))
      .then(r => {
        if (!r.ok) throw fail("envload", `${file} HTTP ${r.status}`);
        return r.arrayBuffer();
      })
      .catch(e => { bytes.delete(file); throw e; }));
  }
  return bytes.get(file);
}

/** 先把這個 preset 要的東西抓齊。抓不到會丟 `code: "envload"`。 */
export const prefetch = preset => Promise.all(filesOf(preset).map(fetchAsset));

/** `AudioBuffer` → 烘焙吃的那個形狀。單聲道的素材左右共用同一條，不複製。 */
const toPcm = buf => ({
  left: buf.getChannelData(0),
  right: buf.numberOfChannels > 1 ? buf.getChannelData(1) : buf.getChannelData(0),
});

async function decode(actx, file) {
  return actx.decodeAudioData((await fetchAsset(file)).slice(0));
}

/**
 * 烘焙要用的素材，解碼到母帶的取樣率。
 *
 * 解碼走 `OfflineAudioContext` 而不是真的 `AudioContext`：**它會順便幫我們重取樣**（素材是
 * 48k、母帶是 44.1k），而且不佔用音訊輸出裝置 —— 這支函式在影片頁是進頁面就跑的，那時候使
 * 用者還沒有按過任何東西。
 *
 * @returns {Promise<{bed:{left,right}|null, thunders:({left,right}|null)[]}>}
 */
export async function loadForBake(preset, sampleRate) {
  const actx = new OfflineAudioContext(2, 1, sampleRate);
  const bed = preset.file ? toPcm(await decode(actx, preset.file)) : null;
  const thunders = preset.thunder
    ? await Promise.all(THUNDER_FILES.map(t => decode(actx, t.file).then(toPcm)))
    : [];
  return { bed, thunders };
}

// ─── 即時試聽 ───────────────────────────────────────────────────────────────

let actx = null;
let bedGain = null;
let bedSrc = null;
/** 這一次試聽的世代。換得比載入快的時候，舊的那次回來要認得自己已經過期。 */
let generation = 0;

/**
 * 試聽的音量。
 *
 * **這是一個聽感上的絕對值，跟烘焙那邊的「比音樂低 16 dB」不是同一件事** —— 試聽時沒有音樂
 * 可以當基準（影片頁的預覽是暫停的、舞台框可能根本沒在播）。刻意訂得比烘焙後的結果響一些：
 * 使用者要聽的是「這是什麼聲音」，那一刻它就是主角。
 */
const AUDITION_GAIN = 0.5;

/** 淡入淡出，秒。硬切的話快速換 preset 會一直「啪」。 */
const FADE = 0.18;

/** 試聽掛在哪個 `AudioContext` 上。影片頁給自己的，舞台框給 `engine.context()`。 */
export function attach(audioCtx) {
  if (actx === audioCtx) return;
  stop();
  actx = audioCtx;
  bedGain = null;
}

function ensureGain() {
  if (!bedGain && actx) {
    bedGain = actx.createGain();
    bedGain.gain.value = 0;
    bedGain.connect(actx.destination);
  }
  return bedGain;
}

/**
 * 開始試聽一個環境。**不含雷聲**：雷是每十幾秒才一發的，而使用者在選單上停留的時間遠短於
 * 那個間隔 —— 等它等不到，而等到了也只會蓋掉正在比較的那個底噪。雷聲是烘焙才有的東西。
 *
 * @returns {Promise<void>} 素材抓不到時 reject（`code: "envload"`），呼叫端要顯示出來
 */
export async function audition(preset, amount = 1) {
  const token = ++generation;
  if (!actx || !preset.file) { stop(); return; }
  if (actx.state !== "running") await actx.resume();

  const buf = await decode(actx, preset.file);
  if (token !== generation) return;      // 已經換到別的 preset 了

  const g = ensureGain();
  fadeOutCurrent();

  const src = actx.createBufferSource();
  const own = actx.createGain();
  src.buffer = buf;
  src.loop = true;
  own.gain.setValueAtTime(0, actx.currentTime);
  own.gain.linearRampToValueAtTime(1, actx.currentTime + FADE);
  src.connect(own).connect(g);
  src.start();
  bedSrc = { src, own };

  g.gain.cancelScheduledValues(actx.currentTime);
  g.gain.setTargetAtTime(AUDITION_GAIN * preset.amount * amount, actx.currentTime, 0.05);
}

function fadeOutCurrent() {
  if (!bedSrc || !actx) return;
  const { src, own } = bedSrc;
  const t = actx.currentTime;
  own.gain.cancelScheduledValues(t);
  own.gain.setValueAtTime(own.gain.value, t);
  own.gain.linearRampToValueAtTime(0, t + FADE);
  // 停在淡出結束之後一點點，不然最後一小段會被切掉而聽到「喀」
  try { src.stop(t + FADE + 0.02); } catch { /* 已經停了 */ }
  bedSrc = null;
}

/** 改試聽的音量（滑桿拖動時）。 */
export function setAmount(preset, amount) {
  if (!bedGain || !actx) return;
  bedGain.gain.setTargetAtTime(
    AUDITION_GAIN * preset.amount * amount, actx.currentTime, 0.05);
}

/** 停掉試聽。關對話框、離開頁面都要叫 —— 不叫的話環境音會一直響下去。 */
export function stop() {
  generation++;
  fadeOutCurrent();
  if (bedGain && actx) {
    bedGain.gain.cancelScheduledValues(actx.currentTime);
    bedGain.gain.setTargetAtTime(0, actx.currentTime, 0.05);
  }
}

// ─── 即時殘響 ───────────────────────────────────────────────────────────────

let workletReady = null;
let reverbNode = null;

/**
 * 把殘響掛到音樂上（舞台框的試聽）。`profileId` 是空的就拆掉。
 *
 * DSP 跟離線烘焙**是同一份**（`envreverb.js`），所以試聽跟成品聽到的是同一個空間 —— 兩邊各
 * 寫一份的話會慢慢分岔，而症狀是「試聽跟成品不太一樣」，沒有人抓得到是哪一行。
 *
 * @param {AudioContext} audioCtx
 * @param {(node:AudioNode|null)=>void} insert  把節點掛進音樂鏈路的函式（`engine.setTail`）
 * @param {string} profileId
 */
export async function attachReverb(audioCtx, insert, profileId) {
  const profile = REVERB_PROFILES[profileId] ?? null;
  if (!profile) {
    insert(null);
    reverbNode = null;
    return;
  }
  if (!workletReady) {
    workletReady = audioCtx.audioWorklet.addModule(assetURL("js/envreverb-worklet.js"));
  }
  await workletReady;

  if (!reverbNode || reverbNode.input.context !== audioCtx) {
    // **乾濕並聯，不是串聯。** worklet 只吐濕聲（見 `envreverb.js` 的 `process`），串在鏈路
    // 上的話音樂會整個變成殘響、直達聲不見了。所以乾聲要自己走一條直通。
    //
    // 濕聲的量交給 profile 自己的 `reverb`／`reflections` 增益決定（`envreverb` 已經套上），
    // 這裡的 wet 直通 1 —— 跟 `envaudio.bake` 那邊直接相加是同一個比例，兩邊才對得起來。
    const wet = new AudioWorkletNode(audioCtx, "env-reverb", {
      numberOfInputs: 1, numberOfOutputs: 1,
      outputChannelCount: [2], channelCount: 2, channelCountMode: "explicit",
    });
    const input = audioCtx.createGain();
    const output = audioCtx.createGain();
    input.connect(output);
    input.connect(wet);
    wet.connect(output);
    reverbNode = { input, output, port: wet.port };
  }
  reverbNode.port.postMessage({ type: "profile", profile });
  insert(reverbNode);
}
