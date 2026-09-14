// ────────────────────────────────────────────────────────────────────────────
//  環境殘響：AudioWorklet 的外殼
//
//  **這支檔案刻意沒有 DSP。** 所有濾波器都在 `envreverb.js`，這裡只做三件事：把
//  `AudioWorkletProcessor` 的 128-frame 介面轉成那支的 `process()`、收 profile 的訊息、
//  在沒有 profile 時輸出靜音。
//
//  理由寫在 `envreverb.js` 的檔頭：即時試聽與離線烘焙必須是**同一份 DSP**，否則兩者會慢慢
//  分岔，而症狀是「試聽跟成品聽起來不太一樣」—— 沒有錯誤訊息、沒有失敗的測試。
//
//  ─── 為什麼可以直接 import ───
//
//  AudioWorklet 的 scope 支援 ES module（`addModule` 載入的就是模組），所以這裡的 import
//  是真的 import，不是打包出來的。`envreverb.js` 因此不能碰 `window`／`document`／
//  `AudioContext` 任何一個 —— 那也正是它被寫成純函式的原因之一。
// ────────────────────────────────────────────────────────────────────────────

import { createReverb } from "./envreverb.js";

class EnvironmentReverb extends AudioWorkletProcessor {
  constructor() {
    super();
    // `sampleRate` 是 AudioWorkletGlobalScope 的全域，不是 window 上的東西
    this.reverb = createReverb(sampleRate);
    this.port.onmessage = ({ data }) => {
      if (data?.type === "profile") this.reverb.setProfile(data.profile ?? null);
      if (data?.type === "reset") this.reverb.clear();
    };
  }

  process(inputs, outputs) {
    const out = outputs[0];
    if (!out?.[0]) return true;
    const outL = out[0], outR = out[1] ?? out[0];
    const inp = inputs[0];
    this.reverb.process(inp?.[0] ?? null, inp?.[1] ?? inp?.[0] ?? null,
      outL, outR, outL.length);
    // **一律回 true。** 回 false 是「這個節點以後都不會再有輸出」，而殘響在輸入停掉之後
    // 還要吐好幾秒的尾巴 —— 提早收掉的症狀是放開琴鍵那一刻殘響被切斷。
    return true;
  }
}

registerProcessor("env-reverb", EnvironmentReverb);
