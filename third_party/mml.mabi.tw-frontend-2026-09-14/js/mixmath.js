// ────────────────────────────────────────────────────────────────────────────
//  混音匯出：舞台幾何與母帶的算術
//
//  峰值、音量係數、裁尾、舞台座標、分段接合 —— 全部是純函式，所以測得到。
//  真正碰 WebAudio 與 Worker 的那些留在 mixdown.js 與 mixstage.js，那兩層寫薄。
// ────────────────────────────────────────────────────────────────────────────

// ─── 舞台 ───────────────────────────────────────────────────────────────────

/**
 * 舞台幾何的單位是**公尺**，不是像素也不是 0..1 —— `PannerNode` 的 `refDistance` /
 * `maxDistance` 講的就是公尺，換一套單位就得在每個交界處換算，而換算寫錯的症狀是「拖遠一點聲音
 * 就整個不見了」。12 公尺見方，座標範圍 ±6。
 */
export const STAGE_M = 12;
export const STAGE_HALF = STAGE_M / 2;

/**
 * 距離衰減。**`refDistance = 2` 不只是調味，它解掉一個一定會發生的邊界情況**：inverse 模型在
 * 距離趨近 0 時會發散，而 `refDistance` 以內增益固定為 1，所以「把樂器壓在聽者身上」自動沒事。
 *
 * `rolloffFactor = 0.5` 是溫和衰減（最遠約 −11 dB）—— 寫實的 1.0 會變成「後排的人聽不到」。
 */
export const PANNER = {
  distanceModel: "inverse",
  refDistance: 2,
  rolloffFactor: 0.5,
  maxDistance: 20,
};

/** 聽者的預設位置：偏舞台前緣（畫面下方），面向畫面上方。 */
export const DEFAULT_LISTENER = { x: 0, z: 4 };

/** 預設半圓弧的半徑與張角（度）。 */
const ARC_R = 4.5;
const ARC_SPREAD = 75;

/** 夾在舞台範圍內。拖出去就停在邊上 —— 舞台外沒有定義。 */
export const clampPos = ({ x, z }) => ({
  x: Math.min(Math.max(x, -STAGE_HALF), STAGE_HALF),
  z: Math.min(Math.max(z, -STAGE_HALF), STAGE_HALF),
});

/**
 * 還沒排過時的預設佈局：以聽者為圓心的一段圓弧。不能讓大家疊在原點 —— 那樣所有樂器的方位角完全
 * 相同，空間化等於沒開。角度由**軌序**決定，所以每次打開拿到的位置一樣，而且分頁列上的左右
 * 順序跟舞台上的一致。
 *
 * @param {number} n 要排幾個
 * @param {{x:number,z:number}} [listener]
 * @returns {{x:number,z:number}[]}
 */
export function defaultLayout(n, listener = DEFAULT_LISTENER) {
  if (n <= 0) return [];
  const rad = d => (d * Math.PI) / 180;
  return Array.from({ length: n }, (_, i) => {
    // 只有一個就放正前方；多個才把張角平均分掉。`n - 1` 當分母在 n === 1 時是 0，那個 NaN
    // 會一路傳到 PannerNode 然後整段靜音。
    const a = n === 1 ? 0 : rad(-ARC_SPREAD + (2 * ARC_SPREAD * i) / (n - 1));
    return clampPos({
      x: listener.x + ARC_R * Math.sin(a),
      // 畫面上方是 −z，也是聽者的正前方（聽者朝向固定，見 mixstage）。
      z: listener.z - ARC_R * Math.cos(a),
    });
  });
}

// ─── 母帶 ───────────────────────────────────────────────────────────────────

/**
 * 輸出的上限，−1 dBFS。不用滿刻度 1.0：mp3 是有損的，解碼出來的波形會比原始 PCM 稍微高一點點
 * （尤其在陡峭的暫態上），留 1 dB 讓解碼端不會削到。
 */
export const CEILING = 0.891;

/** 尾巴裁到哪：低於這個振幅就算靜音。−80 dBFS，聽不見。 */
const SILENCE = 1e-4;

/** 裁掉之前留一點餘裕，避免在殘響還有一絲絲的時候硬切。 */
const PAD_SEC = 0.05;

/** 兩個聲道的絕對值最大值。 */
export function peakOf(left, right) {
  let peak = 0;
  for (let i = 0; i < left.length; i++) {
    const l = left[i] < 0 ? -left[i] : left[i];
    const r = right[i] < 0 ? -right[i] : right[i];
    if (l > peak) peak = l;
    if (r > peak) peak = r;
  }
  return peak;
}

/**
 * 母帶要乘上的係數。**只縮不放。** 六個樂器疊起來很容易超過 ±1，而匯出這條路會在轉
 * Int16 的時候被夾。離線渲染讓這件事免費：整首算完才編碼，所以峰值是**已知的**。
 *
 * 「只縮不放」保住使用者的意圖 —— 純正規化會把一首刻意寫得很輕柔的曲子拉到滿刻度，那是竄改。
 */
export const gainFor = peak => (peak > CEILING ? CEILING / peak : 1);

/**
 * 尾端的靜音要從哪裡切。渲染時固定多算 `TAIL_SEC` 秒，那是**估的上限**，所以估多的要在這裡還
 * 回去 —— 反過來說，因為這裡會裁，那個估值寧可大不可小。整首都是靜音就回 0。
 */
export function trimTail(left, right, sampleRate) {
  let last = -1;
  for (let i = left.length - 1; i >= 0; i--) {
    if (Math.abs(left[i]) > SILENCE || Math.abs(right[i]) > SILENCE) { last = i; break; }
  }
  if (last < 0) return 0;
  return Math.min(left.length, last + 1 + Math.round(PAD_SEC * sampleRate));
}

// ─── 分段 ───────────────────────────────────────────────────────────────────

/**
 * 把整首切成一段一段。天真的做法（每個樂器一條全長的 buffer）在 5 分鐘的曲子上峰值是 3.4 GiB；
 * 分段之後記憶體只跟**段長**有關。最後一段通常不滿，不切對長度的話結尾會多出殘餘或一截靜音。
 */
export function planSegments(totalFrames, segFrames) {
  const out = [];
  for (let at = 0; at < totalFrames; at += segFrames) {
    out.push({ at, frames: Math.min(segFrames, totalFrames - at) });
  }
  return out;
}

/**
 * 把一段渲染結果**加進**母帶，而不是覆蓋 —— 這是整個分段做法能成立的關鍵。每一段都渲染成「段長
 * + 重疊」那麼長，多出來的那截是 HRTF 卷積的尾巴，屬於下一段的開頭；直接寫的話它會被蓋掉，症狀
 * 是每 10 秒一個聽起來像「有點髒」的斷點。
 *
 * 重疊相加是**數學上精確**的，不是「聽不太出來」：位置在渲染期間是靜態的，所以整個空間化是一個
 * 線性非時變系統。
 */
export function addInto(master, src, at) {
  const n = Math.min(src.length, master.length - at);
  for (let i = 0; i < n; i++) master[at + i] += src[i];
  return n > 0 ? n : 0;
}

// ─── 響度（ITU-R BS.1770 / EBU R128）─────────────────────────────────────────
//
//  ─── 為什麼影片要，而 mp3 不要 ───
//
//  `gainFor` 的立場是「只縮不放，不竄改使用者的意圖」，而那對 mp3 是對的：**那是你的曲子的
//  檔案**。影片不是 —— 它是**發佈物**，而每一個平台（YouTube／IG／TikTok／Spotify）都會把
//  收到的東西正規化到 −14 LUFS 附近。
//
//  差別很實際：一首 −18.7 LUFS 的曲子上傳之後平台會推 5 dB，於是六軌的高潮頂到天花板、三軌
//  的間奏還是小聲 —— 使用者聽到的就是「忽大忽小」。**與其讓平台推，不如自己推**：推完之後
//  平台不會再動它，段落之間的對比也原封不動（我們只改整體音量，不做壓縮）。
//
//  這條路只有影片走。mp3 那條完全不碰。

/** 發佈用的目標響度。YouTube／Spotify 都在 −14 附近，IG／TikTok 也是同一個量級。 */
export const TARGET_LUFS = -14;

/** 400 ms 一塊、每 100 ms 前進一塊（75% 重疊）—— 規格寫死的，不是可調參數。 */
const BLOCK_SEC = 0.4;
const STEP_SEC = 0.1;

/** 絕對閘：比這還小聲的塊不算進去（−70 LUFS）。相對閘是「未設閘的響度 − 10 LU」。 */
const ABS_GATE = -70;
const REL_GATE_OFFSET = -10;

/**
 * BS.1770 的常數 −0.691。它讓「兩聲道各一個 0 dBFS 的 1 kHz 正弦」讀出 0 LUFS ——
 * 也就是把 K 加權在 1 kHz 的增益校正回去。
 */
const LUFS_OFFSET = -0.691;

/**
 * K 加權的兩級 biquad。**係數要按取樣率算，不能抄 48 kHz 那組** —— 這個站固定 44.1 kHz，
 * 抄 48k 的常數會讓讀數差幾個 tenth，而那正好是「有沒有推到目標」的解析度。
 *
 * 參數（f0 / G / Q）來自 BS.1770-4 的類比原型，`tan(π f0 / fs)` 是雙線性轉換。
 */
function kWeightingStages(fs) {
  // 第一級：高頻棚（模擬頭部的聲學遮蔽，+4 dB）
  const f1 = 1681.974450955533, G = 3.999843853973347, Q1 = 0.7071752369554196;
  const K1 = Math.tan(Math.PI * f1 / fs);
  const Vh = Math.pow(10, G / 20);
  const Vb = Math.pow(Vh, 0.4996667741545416);
  const a0s = 1 + K1 / Q1 + K1 * K1;
  const shelf = {
    b0: (Vh + Vb * K1 / Q1 + K1 * K1) / a0s,
    b1: 2 * (K1 * K1 - Vh) / a0s,
    b2: (Vh - Vb * K1 / Q1 + K1 * K1) / a0s,
    a1: 2 * (K1 * K1 - 1) / a0s,
    a2: (1 - K1 / Q1 + K1 * K1) / a0s,
  };
  // 第二級：高通（RLB，把低頻的能量拿掉）
  const f2 = 38.13547087602444, Q2 = 0.5003270373238773;
  const K2 = Math.tan(Math.PI * f2 / fs);
  const a0h = 1 + K2 / Q2 + K2 * K2;
  const hp = {
    b0: 1, b1: -2, b2: 1,
    a1: 2 * (K2 * K2 - 1) / a0h,
    a2: (1 - K2 / Q2 + K2 * K2) / a0h,
  };
  return [shelf, hp];
}

/** 一條 biquad，直接第二型轉置。原地寫回 —— 這裡的陣列是我們自己配的暫存。 */
function biquad(x, { b0, b1, b2, a1, a2 }) {
  let z1 = 0, z2 = 0;
  for (let i = 0; i < x.length; i++) {
    const v = x[i];
    const y = b0 * v + z1;
    z1 = b1 * v - a1 * y + z2;
    z2 = b2 * v - a2 * y;
    x[i] = y;
  }
  return x;
}

/**
 * 整合響度，LUFS。**與 ffmpeg 的 `ebur128` 對得上**（見 test/mixmath.test.mjs 的說明）。
 *
 * 兩道閘是規格的核心，不能省：絕對閘拿掉靜音，相對閘拿掉「明顯比全曲安靜」的段落 ——
 * 沒有它們的話，一首開頭有長休止的曲子會被算得太小聲，然後被推得太大。
 *
 * @param {Float32Array} left
 * @param {Float32Array} right
 * @param {number} sampleRate
 * @returns {number} LUFS。整首都算不出有效塊（太短或全靜音）時回 `-Infinity`
 */
export function loudnessLufs(left, right, sampleRate) {
  const blockLen = Math.round(BLOCK_SEC * sampleRate);
  const step = Math.round(STEP_SEC * sampleRate);
  if (left.length < blockLen) return -Infinity;

  const stages = kWeightingStages(sampleRate);
  // 加權要對**整條**做（濾波器有記憶），不能逐塊做 —— 逐塊會在每個塊頭引入暫態。
  const weighted = [left, right].map(ch => {
    const y = Float32Array.from(ch);
    for (const s of stages) biquad(y, s);
    return y;
  });

  // 每塊每聲道的均方
  const zs = [];
  for (let at = 0; at + blockLen <= weighted[0].length; at += step) {
    let z = 0;
    for (const ch of weighted) {
      let s = 0;
      for (let i = at; i < at + blockLen; i++) s += ch[i] * ch[i];
      z += s / blockLen;                 // 聲道權重 L/R 都是 1.0
    }
    zs.push(z);
  }
  if (!zs.length) return -Infinity;

  const loudnessOf = sum => LUFS_OFFSET + 10 * Math.log10(sum);
  const mean = arr => arr.reduce((a, b) => a + b, 0) / arr.length;

  // 絕對閘
  const pass1 = zs.filter(z => z > 0 && loudnessOf(z) > ABS_GATE);
  if (!pass1.length) return -Infinity;

  // 相對閘：門檻由通過絕對閘的那些塊自己算出來
  const relGate = loudnessOf(mean(pass1)) + REL_GATE_OFFSET;
  const pass2 = pass1.filter(z => loudnessOf(z) > relGate);
  if (!pass2.length) return -Infinity;

  return loudnessOf(mean(pass2));
}

/**
 * 發佈用的音量係數：把整首推到 `target` LUFS，**但絕不推到削波**。
 *
 * 兩個上限取小的那一個。峰值那一道用的是跟 `gainFor` 同一個 `CEILING`（−1 dBFS），所以
 * 「推不到目標」時的行為是可預期的：推到差一點點，而不是爆掉。這在動態範圍大的曲子上很常
 * 發生，而**寧可小聲一點也不要削波** —— 削波是回不去的。
 *
 * 也**不放大到超過需要**：已經比目標大聲的曲子會被縮小（那正是平台會做的事），比目標小聲
 * 的才推。
 *
 * @returns {{gain:number, lufs:number, reached:number}} `reached` 是套上去之後的實際響度
 */
export function gainForLoudness(left, right, sampleRate, target = TARGET_LUFS) {
  const lufs = loudnessLufs(left, right, sampleRate);
  if (!Number.isFinite(lufs)) return { gain: 1, lufs, reached: lufs };

  const wanted = Math.pow(10, (target - lufs) / 20);
  const peak = peakOf(left, right);
  const headroom = peak > 0 ? CEILING / peak : Infinity;
  const gain = Math.min(wanted, headroom);
  return { gain, lufs, reached: lufs + 20 * Math.log10(gain) };
}
