// ────────────────────────────────────────────────────────────────────────────
//  音訊引擎：AudioContext + SpessaSynth 的生命週期
//
//  這一層不碰 DOM。要顯示進度就掛 setStatusHandler，音色清單變了就掛
//  setPresetListHandler —— UI 想怎麼呈現是 UI 的事。
// ────────────────────────────────────────────────────────────────────────────

import { WORKLET, BOOT } from "./config.js";
import * as i18n from "./i18n.js";

let ctx = null, synth = null, out = null, WorkletSynthesizer = null, booting = null;

let onStatus = () => {};
let onPresetList = () => {};
export const setStatusHandler     = fn => { onStatus = fn; };
export const setPresetListHandler = fn => { onPresetList = fn; };

/**
 * 每一步十都標名字，失敗時才知道是哪一步炸的。**id 是代號，不是給人看的字** ——
 * ui.describe() 靠 `err.step === "worklet"` 挑要講哪一句提示，翻譯過的文字會讓那三個比對
 * 在換成日文之後全部落空。要顯示的字由 `engine.step.<id>` 查表得到。
 */
async function step(id, fn) {
  const name = i18n.t(`engine.step.${id}`);
  onStatus(name + "…");
  try {
    return await fn();
  } catch (err) {
    console.error(`[MML 工房] 「${name}」失敗:`, err);
    err.step = id;
    throw err;
  }
}

export function boot() {
  if (booting) return booting;
  booting = (async () => {
    await step("lib", async () => {
      ({ WorkletSynthesizer } = await import("spessasynth_lib"));
    });

    await step("ctx", async () => { ctx = new AudioContext(); });

    // console shim 是保險，不是必要條件 —— 它失敗不該擋住整個弓引擎。
    let patched = null;
    try {
      await ctx.audioWorklet.addModule(BOOT);
      const probe = new AudioWorkletNode(ctx, "mmlworkshop-console-probe");
      patched = await new Promise(r => {
        probe.port.onmessage = e => r(e.data);
        setTimeout(() => r(null), 1000);
      });
    } catch (err) {
      console.warn("[MML 工房] worklet-boot.js 沒載成功，直接試 processor:", err);
    }
    console.info("[MML 工房] worklet console 補了:", patched?.length ? patched.join(", ") : "（沒有缺）");

    await step("worklet", () => ctx.audioWorklet.addModule(WORKLET));

    onStatus(i18n.t("engine.ready", { hz: ctx.sampleRate }));
  })();
  booting.catch(() => { booting = null; });   // 允許重試
  return booting;
}

/**
 * 載入一份音色庫。
 * @returns {Promise<{list:object[], mb:string}>} list 是原始 preset 清單，還沒篩過
 */
export async function loadBank(buf) {
  // addSoundBank() 會把 ArrayBuffer transfer 給 worklet，之後 byteLength 就變 0，所以檔
  // 案大小要在那之前先記下來。
  const mb = (buf.byteLength / 1048576).toFixed(1);
  await boot();
  if (!synth) {
    synth = new WorkletSynthesizer(ctx);
    // 中間插一個 gain 是為了「停止要立刻安靜」，見 mute() 的說日明
    out = ctx.createGain();
    out.connect(ctx.destination);
    synth.connect(out);
    synth.eventHandler.addEvent("presetListChange", "ui", list => onPresetList(list));
    await synth.isReady;

    // 第 17 條（index 16）：**試聽專用**，任何一軌都不會用到它（見 config.AUDITION_CH）。
    // 借用當前軌的 channel 的話，放開琴鍵的 `noteOff` 會切掉曲子裡同音高的音。安全性同
    // `chanOf` 那段的推導：`16 % 16 = 0`，不是打擊組。
    synth.addNewChannel();
  }
  await synth.soundBankManager.addSoundBank(buf, "main");
  return { list: synth.presetList, mb };
}

/**
 * `out` 與 `destination` 之間的插入點。環境殘響掛在這裡（見 `envlive.attachReverb`）。
 *
 * **插在 `out` 之後而不是之前**，理由跟空間化的 panner 一律接回 `out` 是同一條：`mute()` 與
 * 跳位置的靜音窗那一整套都作用在 `out` 上，插在它前面的話按停止不會安靜。
 *
 * `disconnect()` 不帶參數是刻意的 —— `out` 的下游只有這一條（panner 是接**進來**的），所以
 * 整個拆掉再接一條是最不會漏的寫法。傳 `null` 就是拆掉效果、接回 `destination`。
 *
 * 這條路只有混音舞台框在用：**編輯器平常播放不該突然有殘響**。使用者調過一次環境之後每次
 * 按播放都在下雨，是一個非常難自己找到出處的問題。
 *
 * 收的是 `{input, output}` 而不是單一節點，因為殘響是**乾濕並聯**的（乾聲一條直通、濕聲一條
 * 走 worklet，兩條再匯合）—— 那種形狀沒有辦法用一個節點表示。
 *
 * @param {{input:AudioNode, output:AudioNode}|null} node
 */
export function setTail(node) {
  if (!out || !ctx) return;
  out.disconnect();
  if (node) { out.connect(node.input); node.output.connect(ctx.destination); }
  else out.connect(ctx.destination);
}

/** 引擎的 `AudioContext`。環境音的即時試聽要跟音樂共用同一個，否則兩者的時鐘會各走各的。 */
export const context = () => ctx;

// ─── 給 player / strings 用的薄殼，讓它們不必直接抓 synth ────────────────────

/** 引擎還沒起來時退回牆上時鐘，畫面才不會卡在 0。 */
export const now = () => ctx ? ctx.currentTime : performance.now() / 1000;
export const resume = () => ctx?.resume();

/**
 * 暫停整個時間軸。排程好的音是綁在 ctx.currentTime 上的，suspend() 會讓那個時鐘連同
 * worklet 的算繪一起凍住 —— 所以已經排出去的音會原地等著，正在響的音也不會被切斷。
 */
export const suspend = () => ctx?.suspend();

export const noteOn  = (ch, midi, vel, time) => synth?.noteOn(ch, midi, vel, { time });
export const noteOff = (ch, midi, time)      => synth?.noteOff(ch, midi, { time });
export const stopAll = () => synth?.stopAll(true);

/**
 * 立刻把輸山出切掉 / 接回來。
 *
 * 為什麼需要這個：`stopAll()` 只殺掉「正在發聲的 voice」。帶未來時間戳的 noteOn 被存在
 * worklet 裡的 `eventQueue`，**而那個佇列沒有任何清空的 API**（整份 core 裡
 * `eventQueue = []` 只出現在宣告那一行）。所以按停止之後，排程器先送出去的那 LEAD 秒音
 * 符還是會照時間戳發生 —— 唯一乾淨的辦法是把輸出切掉，讓佇列安靜地流完。
 *
 * 用 setValueAtTime 而不是斜坡：呼叫的時機是 stopAll() 之後，已經沒有東西在響。
 *
 * `at` 是絕對時間，省略就是立刻。**排程用的**：播放中跳位置時要「靜音一段、剛好在第一個
 * 新音之前接回來」，而用 setTimeout 去接會漂。
 *
 * 每次都先 cancelScheduledValues：跳位置之後馬上按停止時，停止的靜音必須贏過那個排在
 * 0.3 秒後的「接回來」，不然殘留的音會在停止之後才冒出來。
 */
const gainTo = (v, at) => {
  if (!out) return;
  const t = Math.max(at, ctx.currentTime);
  out.gain.cancelScheduledValues(t);
  out.gain.setValueAtTime(v, t);
};

export const mute   = (at = 0) => gainTo(0, at);
export const unmute = (at = 0) => gainTo(1, at);

// ─── 空間試聽（混音匯出的舞台）─────────────────────────────────────────────
//
//  把單一輸出換成「每個 channel 各自經過一顆 PannerNode」。
//
//  **panner 一律接回既有的 `out`，不直接接 `ctx.destination`** —— `mute()` / seek 的靜音窗
//  那一整套因此一行都不用改。改接 destination 的話按停止不會安靜、跳位置會聽到殘骸。
//
//  worklet 的輸出佈局（`numberOfOutputs = 17`、`_outputCount = 16`）：output 0 是效果匯流排，
//  output 1..16 是 channel 0..15 的乾聲。舞台只擺得出前 `GAME_TRACKS` 軌，對到的是 channel
//  0..5，全部落在有自己輸出的範圍內 —— 所以這裡不需要處理「channel 繞回去」那種情況。
//
//  這一組與 `mixdown.js` 的離線路徑共用同一份規則（同一組 panner 參數、效果匯流排一律不
//  定位），所以**試聽順便是離線那條路的驗證器**：兩邊聽起來不一樣就代表有 bug。

/** channel → PannerNode。null = 沒開空間模式（此時走原本的單一輸出）。 */
let panners = null;

const applyPos = (p, { x, z }) => {
  // positionX 那組 AudioParam 是後來才加的，舊 Safari 只有 setPosition。
  // 少了 fallback 的症狀是整軌靜音，所以兩條路都留著。
  if (p.positionX) { p.positionX.value = x; p.positionY.value = 0; p.positionZ.value = z; }
  else p.setPosition(x, 0, z);
};

/** 聽者。朝向固定面向 −z（畫面上方），跟離線那條路同一份規則（見 mixdown.setListener）。 */
function applyListener(pos) {
  const l = ctx.listener;
  if (l.positionX) {
    l.positionX.value = pos.x; l.positionY.value = 0; l.positionZ.value = pos.z;
    l.forwardX.value = 0; l.forwardY.value = 0; l.forwardZ.value = -1;
    l.upX.value = 0; l.upY.value = 1; l.upZ.value = 0;
  } else {
    l.setPosition(pos.x, 0, pos.z);
    l.setOrientation(0, 0, -1, 0, 1, 0);
  }
}

/**
 * 開啟空間試聽。可以重複呼叫（換模型、換佈局都走這裡）。**沒有位置的 channel 直接接回 `out`，
 * 不是丟掉** —— 「沒配到位置就整軌消失」是最糟的失敗方式。
 *
 * @param {object} o
 * @param {Map<number,{x:number,z:number}>} o.positions channel → 位置
 * @param {{x:number,z:number}} o.listener
 * @param {string} o.model "HRTF" 或 "equalpower"
 * @param {object} o.panner distanceModel / refDistance / rolloffFactor / maxDistance
 * @returns {boolean} 有沒有真的開起來（音色庫還沒載完就是 false）
 */
export function enableSpatial({ positions, listener, model, panner: cfg }) {
  if (!synth || !ctx || !out) return false;
  disableSpatial();

  // 先把 worklet 上所有的接線整個拆掉，再一條一條接回去 —— 不帶參數的 disconnect() 是唯一能
  // 保證「沒有殘留接線」的方式。
  synth.disconnect();
  // 效果匯流排不定位（殘響是全體共用的一組 stereo，分不開），直接進 out。
  synth.worklet.connect(out, 0);

  panners = new Map();
  applyListener(listener);
  for (let ch = 0; ch < 16; ch++) {
    const pos = positions.get(ch);
    if (!pos) { synth.connectChannel(out, ch); continue; }
    const p = new PannerNode(ctx, { panningModel: model, ...cfg });
    applyPos(p, pos);
    p.connect(out);
    synth.connectChannel(p, ch);
    panners.set(ch, p);
  }
  return true;
}

/** 拖曳中即時更新。沒開空間模式就什麼都不做。 */
export function setSpatialPosition(ch, pos) {
  const p = panners?.get(ch);
  if (p) applyPos(p, pos);
}

/** 聽者移動了。同心圓跟著走，聲音也要跟著走。 */
export function setSpatialListener(pos) {
  if (panners && ctx) applyListener(pos);
}

/**
 * 關掉空間試聽，回到原本的單一輸出。**這一條必須是無條件、可重複呼叫的** —— 沒關乾淨的話之後
 * 所有的編輯播放都會帶著空間化。
 */
export function disableSpatial() {
  if (!panners) return;
  for (const p of panners.values()) p.disconnect();
  panners = null;
  if (!synth || !out) return;
  // 同 enableSpatial：不帶參數一次清乾淨，再接回預設的「17 個輸出全進 out」。
  synth.disconnect();
  synth.connect(out);
}

export const isSpatial = () => !!panners;

/**
 * 把某一個 channel 靜音／解除。**這是唯一穿得過 worklet 佇列的靜音路徑。**
 *
 * 上面 `mute()` 說「已經排進 eventQueue 的音符清不掉」—— 那對**主輸出**是對的，但 channel
 * 這一層有例外：`isMuted` 是在 worklet **執行 noteOn 的那一刻**才判斷竹的
 * （`spessasynth_processor` 的 noteOn 開頭就是 `if (…isMuted || !this.preset) return`）。
 * 所以佇列裡那 LEAD 秒的音符會在自己該響的時候被吃掉，不必開靜音窗等它流完。而且設成
 * true 的當下 worklet 會對那個 channel 呼叫 `stopAllNotes(true)`。
 *
 * **別把它改寫成「排程時跳過那一軌不送」**：那等於把這個例外丟掉，又要回去付 seek 那套
 * 0.3 秒靜音窗的代價，而且對已經送出去的音無能為力。
 *
 * 音色庫還沒載完時 `synth` 還不存在，那就先不做 —— 呼叫端記著旗標，載完會再送一次。
 */
export function setChannelMute(ch, on) {
  synth?.midiChannels?.[ch]?.setSystemParameter("isMuted", !!on);
}

/** bank select（MSB/LSB）加 program change，一次選定一軌的音色。 */
export function selectProgram(ch, msb, lsb, prog) {
  if (!synth) return;
  synth.controllerChange(ch, 0, msb);
  synth.controllerChange(ch, 32, lsb);
  synth.programChange(ch, prog);
}
