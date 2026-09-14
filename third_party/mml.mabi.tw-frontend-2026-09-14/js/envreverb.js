// ────────────────────────────────────────────────────────────────────────────
//  環境殘響：DSP 核心
//
//  **這一支不碰 Web Audio 的任何東西。** 它吃 `Float32Array`、吐 `Float32Array`，連
//  `sampleRate` 都是參數而不是全域 —— 因為同一份程式碼要同時被兩個地方用：
//
//    即時試聽  envreverb-worklet.js  在 `AudioWorklet` 裡逐 128 frame 跑
//    離線烘焙  envmix.js             在 Worker 裡一次跑完整條母帶
//
//  兩邊各寫一份最佳化過的版本是很自然的誘惑，但那樣的話**試聽與成品會慢慢分岔**，而分岔的
//  症狀是「聽起來不太一樣」—— 沒有錯誤訊息、沒有失敗的測試，而且要有人同時盯著兩邊才發現。
//
//  ─── 為什麼離線那趟不走 OfflineAudioContext ───
//
//  那條路要先把整條母帶做成 `AudioBuffer`，而 5 分鐘的曲子是再多 100 MB —— `mixdown.js` 的
//  `renderPcm` 已經有一條 `oom` 的路，記憶體峰值是整條匯出路徑上最緊的東西。純函式的版本
//  直接在既有的陣列上跑，不多配一個 byte，而且可以丟進 Worker（那裡根本沒有 AudioContext）。
//
//  ─── 這是 Freeverb，不是卷積 ───
//
//  8 個 comb ＋ 4 個 allpass，兩聲道的延遲長度差 23 個 sample（Schroeder 的老配方，那個質數
//  差就是左右不對稱、聽起來有寬度的全部原因）。選它而不是卷積殘響，是因為卷積要一份脈衝響應
//  檔 —— 那是又一批要下載、要快取、要維護的素材，而這裡要的是「有個空間感」，不是「這是聖保
//  羅大教堂」。
//
//  參數是從遊戲的 EAX/I3DL2 preset 換算過來的（`REVERB_PROFILES`），單位是毫貝（millibel）
//  與秒，那是那組 preset 的原生單位 —— 換算只寫在 `profileParams` 一個地方。
// ────────────────────────────────────────────────────────────────────────────

/** Freeverb 的 comb 延遲（sample @44.1k）。 */
const COMB_DELAYS = [1116, 1188, 1277, 1356, 1422, 1491, 1557, 1617];

/** Freeverb 的 allpass 延遲（sample @44.1k）。負責把 comb 的梳狀共振抹散成擴散場。 */
const ALLPASS_DELAYS = [556, 441, 341, 225];

/** 右聲道的延遲偏移。**質數，而且不能是 0** —— 0 的話兩聲道逐 sample 相同，就是單聲道。 */
const SPREAD = 23;

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

/** 毫貝 → 線性增益。EAX 的音量單位是毫貝（1/100 dB），這是唯一該做這個換算的地方。 */
const mb = v => Math.pow(10, v / 2000);

/**
 * 一個殘響 profile。欄位名照 EAX/I3DL2 的原名，**不要改成好懂的名字** —— 這些數字是從遊戲
 * 那邊抄過來的，改名之後就對不回去了。
 *
 * @typedef {object} ReverbProfile
 * @property {string} id
 * @property {number} room             整體音量，毫貝
 * @property {number} roomHF           高頻衰減，毫貝（越負越悶）
 * @property {number} decayTime        殘響時間，秒
 * @property {number} decayHFRatio     高頻衰減比
 * @property {number} reflections      早期反射音量，毫貝
 * @property {number} reflectionsDelay 早期反射延遲，秒
 * @property {number} reverb           後期殘響音量，毫貝
 * @property {number} reverbDelay      後期殘響延遲，秒
 * @property {number} diffusion        擴散度 0..100
 * @property {number} density          密度 0..100
 */
const profile = (id, room, roomHF, decayTime, decayHFRatio,
  reflections, reflectionsDelay, reverb, reverbDelay, diffusion, density) =>
  ({ id, room, roomHF, decayTime, decayHFRatio,
    reflections, reflectionsDelay, reverb, reverbDelay, diffusion, density });

/**
 * 可用的殘響。**使用者選不到這一層** —— 每個環境 preset 自己綁一個（見 `envaudio.js`）。
 *
 * 這是刻意的：原型的清單長成 `reverb_006`、`reverb_010`，而使用者沒有任何依據去判斷 6 跟 10
 * 差在哪。這個站對選項的態度一向如此（mp3 位元率、影片解析度都不做成選項）—— **使用者做不了
 * 的決定就不要問他**。這裡改成用空間的名字命名，是為了讓 `envaudio.js` 那張表讀得懂。
 */
export const REVERB_PROFILES = {
  hall:    profile("hall",    -1000, -698,   7.24, 0.33, -1166, 0.020,   16, 0.030, 100, 100),
  cavern:  profile("cavern",  -1000, -1000, 10.05, 0.23,  -602, 0.020,  198, 0.030, 100, 100),
  vault:   profile("vault",   -1000, -500,   3.92, 0.70, -1230, 0.020,   -2, 0.029, 100, 100),
  alley:   profile("alley",   -1000, -270,   1.49, 0.86, -1204, 0.007,   -4, 0.011, 100, 100),
  forest:  profile("forest",  -1000, -3300,  1.49, 0.54, -2560, 0.162, -229, 0.088,  79, 100),
  passage: profile("passage", -1000, -100,   1.49, 0.83, -2602, 0.007,  200, 0.011, 100, 100),
  room:    profile("room",    -1000, -300,   1.49, 0.59, -1219, 0.007,  441, 0.011, 100, 100),
};

/**
 * 這個 profile 的尾巴要留多久（秒）。**離線烘焙靠它決定母帶要往後延多少** —— 延不夠的症狀是
 * 殘響被切一刀，聽起來像有人把門關上；延太多只是檔案多幾秒近乎無聲，而 `trimTail` 那一套在
 * 這之前就跑完了，不會再幫我們收。
 */
export const tailSeconds = p => (p ? p.decayTime + p.reverbDelay + 0.2 : 0);

// ─── 濾波器 ─────────────────────────────────────────────────────────────────

/** 純延遲線。早期反射與 pre-delay 用它。 */
class Delay {
  constructor(n) { this.buf = new Float32Array(Math.max(1, n)); this.i = 0; }
  process(x, n) {
    const len = Math.max(1, Math.min(this.buf.length, n | 0));
    if (this.i >= len) this.i %= len;
    const y = this.buf[this.i];
    this.buf[this.i] = x;
    this.i = (this.i + 1) % len;
    return y;
  }
  clear() { this.buf.fill(0); this.i = 0; }
}

/**
 * 帶阻尼的 comb。回授量從 `decayTime` 反推（`0.001 = fb^(len/decay)`，也就是 −60 dB 的定義），
 * 所以改 profile 的 `decayTime` 就是直接改殘響長度，不必另外調係數。
 *
 * 輸入增益取 `sqrt(1 - fb²)`：回授越大輸入就要越小，否則長殘響的 profile 會直接爆掉。
 */
class Comb {
  constructor(n, sampleRate) {
    this.buf = new Float32Array(Math.max(1, n));
    this.rate = sampleRate;
    this.i = 0; this.store = 0;
    this.lastDecay = NaN; this.fb = 0; this.inGain = 1;
  }
  process(x, decay, damping) {
    const d = Math.max(0.05, decay);
    if (d !== this.lastDecay) {
      const len = Math.max(0.001, this.buf.length / Math.max(1, this.rate));
      this.fb = clamp(Math.pow(0.001, len / d), 0.05, 0.96);
      this.inGain = Math.sqrt(Math.max(0, 1 - this.fb * this.fb));
      this.lastDecay = d;
    }
    const y = this.buf[this.i];
    this.store = y * (1 - damping) + this.store * damping;
    // 夾在 ±1：回授迴路是這支檔案裡唯一會發散的東西，而發散的症狀是整首變成白噪音
    this.buf[this.i] = clamp(x * this.inGain + this.store * this.fb, -1, 1);
    this.i = (this.i + 1) % this.buf.length;
    return y;
  }
  clear() { this.buf.fill(0); this.i = 0; this.store = 0; }
}

/** Schroeder allpass。不改頻譜，只打散相位 —— comb 的梳狀共振就是靠這四級抹平的。 */
class AllPass {
  constructor(n) { this.buf = new Float32Array(Math.max(1, n)); this.i = 0; }
  process(x, fb) {
    const d = this.buf[this.i];
    this.buf[this.i] = clamp(x + d * fb, -1, 1);
    this.i = (this.i + 1) % this.buf.length;
    return d - x;
  }
  clear() { this.buf.fill(0); this.i = 0; }
}

/**
 * profile → 每 sample 要用的那組數字。**每換一次 profile 算一次，不要放進取樣迴圈** ——
 * 裡面有 `Math.pow`，一秒鐘四萬四千次會很明顯。
 */
function profileParams(p, sampleRate) {
  if (!p) return null;
  const diffusion = clamp(p.diffusion / 100, 0, 1);
  const roomGain = mb(p.room);
  // 阻尼由兩件事合成：高頻衰減得比低頻快（decayHFRatio），以及整個空間本身就悶（roomHF）
  const decayDamp = 1 - clamp(p.decayHFRatio, 0.05, 1.3) / 1.3;
  const roomDamp = 1 - clamp(mb(p.roomHF), 0, 1);
  const sec = v => clamp(Math.round(Math.max(0.001, v) * sampleRate), 1, sampleRate);
  return {
    early: sec(p.reflectionsDelay),
    late: sec(p.reverbDelay),
    decay: Math.max(0.05, p.decayTime),
    earlyGain: roomGain * mb(p.reflections),
    lateGain: roomGain * mb(p.reverb),
    diffusion,
    density: clamp(p.density / 100, 0, 1),
    damping: clamp(decayDamp * 0.55 + roomDamp * 0.45, 0.02, 0.92),
    apFeedback: clamp(0.35 + diffusion * 0.15, 0.25, 0.55),
  };
}

/**
 * 開一組殘響。
 *
 * **`process` 只吐濕聲**，不含乾聲 —— 乾濕比由呼叫端決定，因為即時那邊是用 `GainNode` 混的、
 * 離線那邊是一次乘加，兩者對「濕度」的套法本來就不同。
 *
 * 有狀態（延遲線裡有東西），所以**一個 instance 只能餵一條連續的訊號**。離線烘焙靠這個特性
 * 一次跑完整首：不分段就沒有接縫，而那正是不把殘響塞進 `renderPcm` 分段迴圈的理由 ——
 * 那裡的重疊只有 50 ms，而這裡的尾巴最長 10 秒。
 *
 * @param {number} sampleRate
 */
export function createReverb(sampleRate) {
  // 延遲長度是照 44.1k 定的，換算到實際取樣率 —— 不換的話 48k 的機器殘響會短一成
  const scale = n => Math.max(1, Math.round(n * sampleRate / 44100));
  const earlyL = new Delay(sampleRate), earlyR = new Delay(sampleRate);
  const preL = new Delay(sampleRate), preR = new Delay(sampleRate);
  const combL = COMB_DELAYS.map(n => new Comb(scale(n), sampleRate));
  const combR = COMB_DELAYS.map(n => new Comb(scale(n + SPREAD), sampleRate));
  const apL = ALLPASS_DELAYS.map(n => new AllPass(scale(n)));
  const apR = ALLPASS_DELAYS.map(n => new AllPass(scale(n + SPREAD)));
  const all = [earlyL, earlyR, preL, preR, ...combL, ...combR, ...apL, ...apR];

  let params = null, id = "";

  const late = (combs, aps, x, p) => {
    let v = 0;
    for (const c of combs) v += c.process(x, p.decay, p.damping);
    v /= combs.length;
    for (const a of aps) v = a.process(v, p.apFeedback);
    return v;
  };

  return {
    setProfile(p) {
      // 換 profile 一定要清空：舊空間的尾巴留在延遲線裡，聽起來是換場那一瞬間有東西碎掉
      if ((p?.id ?? "") !== id) for (const f of all) f.clear();
      id = p?.id ?? "";
      params = profileParams(p, sampleRate);
    },
    clear() { for (const f of all) f.clear(); },
    /**
     * 算 `n` 個 sample 的濕聲。`at` 是**輸入**的起點（輸出一律從 0 開始寫），這樣離線那趟就
     * 可以拿整條母帶當輸入、一小塊暫存當輸出，不必先切一份出來。
     */
    process(inL, inR, outL, outR, n, at = 0) {
      const p = params;
      for (let i = 0; i < n; i++) {
        if (!p) { outL[i] = 0; outR[i] = 0; continue; }
        const l = inL ? (inL[at + i] || 0) : 0;
        const r = inR ? (inR[at + i] || 0) : l;
        const eL = earlyL.process(l, p.early);
        const eR = earlyR.process(r, p.early);
        // 後期殘響吃的是**混成單聲道**的訊號：真實空間的擴散場早就沒有方向了，分左右各跑一條
        // 的話兩邊的尾巴互不相關，聽起來是兩個房間而不是一個
        const mono = (l + r + (eL + eR) * p.diffusion * 0.35) * 0.5;
        const lL = late(combL, apL, preL.process(mono, p.late), p);
        const lR = late(combR, apR, preR.process(mono, p.late), p);
        outL[i] = eL * p.earlyGain + lL * p.lateGain * p.density;
        outR[i] = eR * p.earlyGain + lR * p.lateGain * p.density;
      }
    },
  };
}
