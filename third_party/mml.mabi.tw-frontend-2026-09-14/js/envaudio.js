// ────────────────────────────────────────────────────────────────────────────
//  環境音：preset 表與離線烘焙
//
//  匯出 mp3 與製作影片時，可以在音樂底下鋪一層遊戲裡的環境音（森林、雨、城鎮…），並且讓
//  音樂帶上那個空間的殘響。**這一支不碰 DOM 也不碰 AudioContext**，所以測試載得起來，也可
//  以整個丟進 Worker —— 素材的解碼在呼叫端（那件事非要 AudioContext 不可），這裡只吃已經
//  解好的 `Float32Array`。
//
//  ─── 為什麼要烘進母帶，而不是播放時即時疊 ───
//
//  因為影片頁唯一的賣點是「預覽聽到的與檔案裡的是同一段取樣，byte-identical」（見 video.js
//  的檔頭）。即時疊上去的話，使用者聽到的雷聲位置跟檔案裡的不一樣 —— 而那個落差**沒有任何
//  錯誤訊息**，要有人真的比對兩邊才會發現。
//
//  代價是換一個 preset 要重算。但重算的**不包含合成**（那是最慢的一段，早在使用者看瀑布的
//  時候就做完了），只有殘響一趟加鋪一層床，5 分鐘的曲子大約 1～3 秒。乾聲母帶因此要留在記
//  憶體裡，也就是選了環境音的人會付兩份母帶的記憶體 —— **選「無」的時候一個 byte 都不會多**。
//
//  ─── 管線的順序是被兩件事逼出來的，不要重排 ───
//
//      renderPcm 乾聲母帶
//        → 殘響一趟（母帶往後延 decayTime）
//        → 響度正規化（只看音樂）
//        → 鋪環境床
//        → 峰值保護
//
//  **環境床一定在 `trimTail` 之後。** `trimTail` 靠「尾巴變安靜」把估多的 3 秒還回去，而一層
//  恆定的雨聲讓它永遠找不到安靜 —— 先鋪床的話每一次匯出都會多帶最多 3 秒。
//
//  **殘響會把尾巴拉長**（`decayTime` 最長 10 秒），所以那一趟之後母帶要往後延，否則殘響被切
//  一刀，聽起來像有人把門關上。
//
//  **正規化只看音樂。** 算「音樂＋環境」的總響度在技術上更「正確」，但症狀不能接受：選一個
//  吵的環境會讓鋼琴變小聲，而使用者不會把這兩件事連在一起。環境床改成**相對於音樂的響度**
//  往下坐固定的量（`AMBIENT_BELOW_DB`），所以換環境不會動到音樂的音量。
//
//  ─── 決定論是硬性的 ───
//
//  同一首譜 ＋ 同一個 preset，烘兩次必須逐 byte 相同，否則「重匯出一次得到同一個檔」就破了。
//  所以這裡**不准出現 `Math.random` / `Date.now` / `performance.now`**，雷聲的排程走
//  `rng(seed)`，種子由呼叫端從樂譜本身長出來。`test/env.test.mjs` 會把那三個全域換成會丟例
//  外的函式再跑一遍。
// ────────────────────────────────────────────────────────────────────────────

import { REVERB_PROFILES, createReverb, tailSeconds } from "./envreverb.js";
import { peakOf, gainFor, loudnessLufs } from "./mixmath.js";

/** 素材放哪。`assetURL()` 由呼叫端套上 —— 這一支不知道站台掛在哪個路徑下。 */
export const ENV_ASSET_DIR = "audio/env/";

/**
 * 環境床要坐在音樂底下幾 dB。
 *
 * **這個數字是相對於音樂的整合響度，不是絕對電平**，所以它在響度正規化過的影片與只做峰值
 * 保護的 mp3 上是同一件事 —— 而那正是它非得是相對值不可的原因：mp3 那條路的音樂電平取決於
 * 曲子本身，固定的絕對電平會讓安靜的曲子被環境音蓋掉。
 *
 * −16 是「聽得出來在下雨，但沒有人會覺得雨是主角」。使用者的滑桿再乘上去。
 */
const AMBIENT_BELOW_DB = -16;

/** 音樂安靜到量不出響度時（整首極輕），環境床退回這個絕對電平，免得除出 Infinity。 */
const AMBIENT_FALLBACK_DB = -34;

/** 環境床頭端淡入幾秒。防的是第一個 mp3 frame 的爆音。 */
const FADE_IN_SEC = 0.5;

/**
 * 環境床尾端淡出幾秒。
 *
 * 不淡出的症狀很具體：檔案最後一個 sample 是一段全音量的雨，播放器一停就是「喀」的一刀，
 * 而使用者會覺得是檔案壞了。2 秒讀起來是鏡頭拉遠。
 */
const FADE_OUT_SEC = 2;

/**
 * 環境床迴圈接縫的交叉淡化長度，秒。
 *
 * 素材**大多**是為了無縫循環做的，但不是每一個都是。做法是先把素材摺成一個真正無縫的循環
 * 週期（尾巴交叉淡進頭部），之後鋪滿就只是複製 —— 這樣接縫只需要處理一次，而不是每鋪一圈
 * 處理一次。
 */
const LOOP_XF_SEC = 0.25;

/** 一次處理幾個 sample。只影響暫存大小，不影響結果（殘響是一條連續的訊號跑完的）。 */
const CHUNK = 8192;

// ─── 亂數 ───────────────────────────────────────────────────────────────────

/**
 * mulberry32。**跟 `wfstyles.rng` 是同一個演算法，而這裡刻意重寫一次。**
 *
 * 不 import 的理由是相依方向：`wfstyles.js` 是鋼琴瀑布的畫法，一千五百行的繪圖程式碼，而
 * 編輯器頁根本不載它。為了八行 PRNG 把它拉進 mp3 匯出的路徑上，等於每個開混音框的人多下載
 * 75 KB 的畫圖程式。
 *
 * 這是這份 codebase 裡少數「複製比共用好」的地方，而條件很明確：演算法是公開且固定的
 * （mulberry32 有標準實作），所以兩份不會分岔 —— 分岔的風險才是共用的理由。
 */
function rng(seed) {
  let s = seed | 0;
  return () => {
    s = (s + 0x6D2B79F5) | 0;
    let x = Math.imul(s ^ (s >>> 15), 1 | s);
    x = (x + Math.imul(x ^ (x >>> 7), 61 | x)) ^ x;
    return ((x ^ (x >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * 樂譜 → 種子。**雷聲的位置由曲子本身決定**，所以同一首譜每次匯出的雷都打在同一個地方，而
 * 不同的曲子不會共用同一組。
 *
 * 走的是 `parseAll` 的結果而不是 MML 原文：mp3 那條路手上只有解析結果，而影片頁的原文還被
 * `stripPrograms` 動過 —— 兩邊拿同一份 `song` 才會得到同一個種子。用 tick 域的整數而不是秒，
 * 因為秒是浮點數換算出來的，改了速度圖以外的東西也可能在最後一位變動。
 */
export function seedOfSong(song) {
  let h = 0x811c9dc5;
  const bite = v => { h ^= v | 0; h = Math.imul(h, 0x01000193); };
  for (const tr of song?.tracks ?? []) {
    bite(tr.notes.length);
    for (const n of tr.notes) { bite(n.tick); bite(n.durTick); bite(n.midi); bite(n.vel); }
  }
  return h | 0;
}

// ─── preset ─────────────────────────────────────────────────────────────────

/**
 * 一個環境。
 *
 * @typedef {object} EnvPreset
 * @property {string} id       i18n 的鍵是 `env.preset.<id>`
 * @property {string} file     循環素材的檔名，空字串 = 只有殘響
 * @property {number} amount   這個素材自己的音量倍率（有些素材本身就錄得比較滿）
 * @property {string} reverb   `REVERB_PROFILES` 的鍵，空字串 = 不加殘響
 * @property {boolean} thunder 要不要隨機打雷
 */
const preset = (id, file, amount = 1, reverb = "", thunder = false) =>
  ({ id, file, amount, reverb, thunder });

/**
 * 可以選的環境。**第一項是「無」，而且不能動** —— 它是預設值，也是「這個功能等於不存在」
 * 的那條路（見 `bake`：選它的時候乾聲母帶原封不動地回去）。
 *
 * ─── 清單為什麼長這樣 ───
 *
 * 原型有 20 格，這裡拿掉了兩個、補上兩個：
 *
 *   · `custom`（自訂）—— 那是一個 UI 模式不是場景。連帶砍掉的是原型的自訂面板：它讓使用者
 *     選殘響 profile，而清單長成「Preset 17」「Preset 20」，**沒有任何依據去判斷 17 跟 20
 *     差在哪**。這個站對選項的態度一向如此（mp3 位元率、影片解析度都不做成選項）。
 *   · `snow`（雪地）—— 用的檔案與音量跟「冰峽谷・白天」完全相同，兩格的輸出逐 byte 一樣。
 *   · `swamp`（沼澤）、`altar`（祭壇）—— 素材本來就在，但原型裡沒有任何 preset 用得到，
 *     只出現在自訂面板的檔案下拉裡。砍掉那個面板之後它們會變成孤兒。
 *
 * 清單裡**全部都是地點**。原型還有「驚悚」「暖風」兩個素材，那是情緒不是地點 —— 混進一排
 * 地名裡會讓分類基準壞掉，而使用者挑選時靠的就是那個基準。那兩個檔案跟著刪了。
 *
 * ─── 殘響的配對 ───
 *
 * 大致照原型：森林配 `forest`、地城入口配 `vault`。另外補了三個原型漏掉、而缺了很奇怪的：
 * 礦坑配 `passage`（那是一條坑道）、冰峽谷配 `cavern`（峽谷會回音）、宮殿與祭壇配 `hall`。
 * 其餘的戶外場景**不配殘響** —— 曠野與城鎮沒有夠近的反射面，硬加只會讓它聽起來像在室內，
 * 而那比沒有空間感更糟。
 *
 * **每一格都要四個語言的名字**（`env.preset.<id>`），而 `test/i18n.test.mjs` 會抓漏。清單
 * 長度不是免費的，加一格之前先想想它跟隔壁那一格差在哪。
 */
export const ENV_PRESETS = [
  preset("none", ""),
  preset("village_day",     "SFX_ENV_Village_Day.mp3"),
  preset("village_night",   "SFX_ENV_Village_Night.mp3"),
  preset("forest_day",      "SFX_ENV_Forest_Day.mp3",      1,   "forest"),
  preset("forest_night",    "SFX_ENV_Forest_Night.mp3",    1,   "forest"),
  preset("town_day",        "SFX_ENV_Town_Day.mp3"),
  preset("town_night",      "SFX_ENV_Town_Night.mp3"),
  preset("mine_day",        "SFX_ENV_Mine_Day.mp3",        0.6, "passage"),
  preset("mine_night",      "SFX_ENV_Mine_Night.mp3",      0.6, "passage"),
  preset("wilderness_day",  "SFX_ENV_Wilderness_Day.mp3"),
  preset("wilderness_night", "SFX_ENV_Wilderness_Night.mp3"),
  preset("ice_canyon_day",  "SFX_ENV_IceCanyon_Day.mp3",   0.6, "cavern"),
  preset("ice_canyon_night", "SFX_ENV_IceCanyon_Night.mp3", 0.6, "cavern"),
  preset("swamp",           "SFX_ENV_Swamp.mp3"),
  preset("palace",          "SFX_ENV_EmainMachaPalace.mp3", 1,  "hall"),
  preset("altar",           "SFX_AltarOfMorrighan_EnvironmentWeak.mp3", 1, "hall"),
  preset("dungeon",         "",                            1,   "vault"),
  preset("drizzle",         "SFX_Rain_Drizzle.mp3",        0.4),
  preset("rain",            "wav_rain_0.mp3"),
  preset("storm",           "wav_rain_0.mp3",              1,   "",     true),
];

/**
 * 雷聲的素材，以及每一個的音高擺盪範圍。
 *
 * 三個檔案給了範圍、一個沒有（`SFX_Thunder_01` 的錄音本身特徵太明顯，變速會聽出來是同一
 * 聲）。範圍照原型。
 */
export const THUNDER_FILES = [
  { file: "SFX_Thunder_01.mp3", rate: [1.0, 1.0] },
  { file: "SFX_Thunder_02.mp3", rate: [0.7, 1.3] },
  { file: "SFX_Thunder_03.mp3", rate: [0.9, 1.5] },
  { file: "SFX_Thunder_04.mp3", rate: [0.7, 1.3] },
];

/** 第一聲雷落在哪個區間（秒）。 */
const THUNDER_FIRST = [3, 8];
/** 之後每一聲的間隔（秒）。 */
const THUNDER_GAP = [14, 32];
/** 雷聲相對於環境床的音量範圍。 */
const THUNDER_GAIN = [0.2, 1];

/** 查一個 preset。**查不到就回第一項（無）** —— 同 `wfstyles.noteStyle`，舊 id 安靜落回預設。 */
export const envPreset = id => ENV_PRESETS.find(p => p.id === id) ?? ENV_PRESETS[0];

/** 這個 preset 要用到哪些素材檔（給快取預熱與離線檢查用）。 */
export function filesOf(p) {
  const out = p.file ? [p.file] : [];
  if (p.thunder) for (const t of THUNDER_FILES) out.push(t.file);
  return out;
}

// ─── 雷聲的排程 ─────────────────────────────────────────────────────────────

/**
 * 這首曲子要在哪幾個時間點打雷。**純函式：同一個 `seed` ＋ 同一個長度永遠得到同一張表。**
 *
 * 原型用的是 `setTimeout` ＋ `Math.random`，也就是「牆鐘時間」—— 那在即時播放時沒問題，但
 * 烘進檔案的話同一首譜每次匯出的雷都不在同一個地方。改成一次算完整張表，時間軸就是曲子時
 * 間，跟播放與否無關。
 *
 * @param {number} seed
 * @param {number} durationSec  曲子多長（含殘響尾巴）
 * @returns {{at:number, index:number, rate:number, gain:number}[]}
 */
export function thunderPlan(seed, durationSec) {
  const r = rng(seed);
  const between = ([lo, hi]) => lo + r() * (hi - lo);
  const out = [];
  let at = between(THUNDER_FIRST);
  while (at < durationSec) {
    const index = Math.min(THUNDER_FILES.length - 1,
      Math.floor(r() * THUNDER_FILES.length));
    out.push({
      at,
      index,
      rate: between(THUNDER_FILES[index].rate),
      gain: between(THUNDER_GAIN),
    });
    at += between(THUNDER_GAP);
  }
  return out;
}

// ─── 環境床 ─────────────────────────────────────────────────────────────────

/**
 * 把素材摺成一個**真正無縫**的循環週期：尾巴那 `LOOP_XF_SEC` 交叉淡進頭部，週期因此比原素
 * 材短那麼多。
 *
 * 為什麼先摺一次而不是每鋪一圈淡一次：摺過之後鋪滿就只是複製，接縫只需要處理一次 —— 而每
 * 圈都淡的話，5 分鐘的曲子配 15 秒的素材要處理二十次，每一次都是一個可能對不齊的機會。
 *
 * 素材短到放不下交叉淡化時原樣退回（那種素材本來就只能硬接）。
 */
export function loopCycle(src, sampleRate) {
  const xf = Math.min(Math.round(LOOP_XF_SEC * sampleRate),
    Math.floor(src[0].length / 3));
  if (xf <= 0) return src;
  const n = src[0].length - xf;
  return src.map(ch => {
    const cycle = ch.slice(0, n);
    for (let i = 0; i < xf; i++) {
      const k = i / xf;
      cycle[i] = ch[i] * k + ch[n + i] * (1 - k);
    }
    return cycle;
  });
}

/**
 * 鋪一條 `frames` 長的環境床：循環週期重複鋪滿，頭端淡入、尾端淡出。
 *
 * @param {Float32Array[]} cycle 已經摺過的無縫循環（`loopCycle` 的結果），[L, R]
 * @param {number} frames
 * @param {number} sampleRate
 * @param {number} scale 整體音量
 * @returns {Float32Array[]} [L, R]
 */
export function buildBed(cycle, frames, sampleRate, scale) {
  const out = [new Float32Array(frames), new Float32Array(frames)];
  const n = cycle[0].length;
  if (!n) return out;

  for (let c = 0; c < 2; c++) {
    const src = cycle[Math.min(c, cycle.length - 1)];
    const dst = out[c];
    for (let i = 0; i < frames; i++) dst[i] = src[i % n] * scale;
  }

  const fin = Math.min(Math.round(FADE_IN_SEC * sampleRate), frames);
  const fout = Math.min(Math.round(FADE_OUT_SEC * sampleRate), frames);
  for (let i = 0; i < fin; i++) {
    const k = i / fin;
    out[0][i] *= k; out[1][i] *= k;
  }
  for (let i = 0; i < fout; i++) {
    const k = i / fout;
    const j = frames - 1 - i;
    out[0][j] *= k; out[1][j] *= k;
  }
  return out;
}

// ─── 烘焙 ───────────────────────────────────────────────────────────────────

const dbToLin = db => Math.pow(10, db / 20);

/**
 * 乾聲母帶 → 成品母帶。
 *
 * **回傳的形狀跟 `renderPcm` 一模一樣**（`{left, right, sampleRate, gain}`），所以它是一個
 * 可以插在 `renderPcm` 與下游之間的轉換 —— 而選「無」的時候它連陣列都原樣傳回去，也就是
 * **不選環境音的人拿到的檔案跟這個功能不存在時逐 byte 相同**。那不只是省效能，它是這整段
 * 程式碼可以放心加進既有匯出路徑的理由。
 *
 * @param {object} o
 * @param {Float32Array} o.left        乾聲母帶（未套增益）
 * @param {Float32Array} o.right
 * @param {number} o.sampleRate
 * @param {EnvPreset} o.preset
 * @param {number} o.amount            使用者滑桿，1 = preset 原本的量
 * @param {{left:Float32Array,right:Float32Array}|null} o.bed  已解碼的循環素材
 * @param {({left:Float32Array,right:Float32Array}|null)[]} [o.thunders] 對 `THUNDER_FILES`
 * @param {number} o.seed
 * @param {(l:Float32Array, r:Float32Array, sr:number)=>number} o.normalize
 *        音樂要乘的係數。影片頁給響度正規化、mp3 給峰值保護 —— **這一支不知道也不該知道
 *        呼叫端想要哪一種**，它只保證那個係數是在「還沒有環境音」的時候算出來的。
 * @returns {{left:Float32Array, right:Float32Array, sampleRate:number, gain:number}}
 */
export function* bakeSteps({
  left, right, sampleRate, preset, amount = 1,
  bed = null, thunders = [], seed = 0, normalize,
}) {
  const profile = REVERB_PROFILES[preset.reverb] ?? null;
  const hasBed = !!(bed && bed.left?.length);

  // 「無」，或者一個既沒有素材也沒有殘響的 preset：原樣回去
  if (!profile && !hasBed) {
    return { left, right, sampleRate, gain: normalize(left, right, sampleRate) };
  }

  const tail = Math.round(tailSeconds(profile) * sampleRate);
  const frames = left.length + tail;
  const outL = new Float32Array(frames);
  const outR = new Float32Array(frames);
  outL.set(left);
  outR.set(right);

  // ─── 殘響：一次跑完整條，不分段 ───
  //
  // `renderPcm` 是 10 秒一段、段間重疊 50 ms 的，而那個 50 ms 的合法性建立在「空間化是線性
  // 非時變」上。殘響的尾巴最長 10 秒，**塞不進 50 ms** —— 跟著分段跑的話每 10 秒一個接縫。
  // 所以它在這裡、在重疊相加已經完成之後才做。
  if (profile) {
    const reverb = createReverb(sampleRate);
    reverb.setProfile(profile);
    const wL = new Float32Array(CHUNK), wR = new Float32Array(CHUNK);
    for (let at = 0; at < frames; at += CHUNK) {
      const n = Math.min(CHUNK, frames - at);
      // 輸入讀的是**乾聲**（`left`/`right`），輸出寫進暫存 —— 直接讀 `outL` 的話濕聲會回授
      // 進自己的輸入。超過乾聲長度的部分讀到 undefined，`process` 當 0，那就是尾巴。
      reverb.process(left, right, wL, wR, n, at);
      for (let i = 0; i < n; i++) { outL[at + i] += wL[i]; outR[at + i] += wR[i]; }
      // 殘響是這裡最貴的一段（每 sample 二十幾次乘加），進度也幾乎全花在它身上
      yield 0.05 + 0.8 * ((at + n) / frames);
    }
  }
  yield 0.85;

  // ─── 響度正規化：只看音樂（含殘響），還沒有環境床 ───
  const gain = normalize(outL, outR, sampleRate);
  if (gain !== 1) {
    for (let i = 0; i < frames; i++) { outL[i] *= gain; outR[i] *= gain; }
  }
  yield 0.9;

  // ─── 環境床 ───
  if (hasBed) {
    const musicLufs = loudnessLufs(outL, outR, sampleRate);
    const bedLufs = loudnessLufs(bed.left, bed.right, sampleRate);
    // 音樂或素材量不出響度（整段近乎無聲）就退回一個絕對電平，不要算出 Infinity
    const scale = (Number.isFinite(musicLufs) && Number.isFinite(bedLufs)
      ? dbToLin(musicLufs + AMBIENT_BELOW_DB - bedLufs)
      : dbToLin(AMBIENT_FALLBACK_DB)) * preset.amount * amount;

    const cycle = loopCycle([bed.left, bed.right], sampleRate);
    const [bl, br] = buildBed(cycle, frames, sampleRate, scale);
    for (let i = 0; i < frames; i++) { outL[i] += bl[i]; outR[i] += br[i]; }

    if (preset.thunder) {
      for (const t of thunderPlan(seed, frames / sampleRate)) {
        mixOneShot(outL, outR, thunders[t.index], t, scale, sampleRate);
      }
    }
  }

  yield 1;
  // 只縮不放：除非會爆，否則不碰音量
  return { left: outL, right: outR, sampleRate, gain: gainFor(peakOf(outL, outR)) };
}

/**
 * `bakeSteps` 的同步版本，一口氣跑完。
 *
 * **測試用這一支，UI 用 `bakeSteps`。** 5 分鐘的曲子這裡要跑 1～3 秒，在主執行緒上就是一段
 * 畫面凍住 —— UI 那邊逐段 `yield` 之後在中間讓出去（同 `video.js` 匯出迴圈每 10 幀 `tick()`
 * 一次的做法），畫面才不會卡。取消也只是停止迭代，不必動到任何一條 buffer。
 *
 * 為什麼不丟 Worker：那樣要嘛把 100 MB 的母帶複製一份過去（記憶體峰值變三倍），要嘛轉移過
 * 去（取消的時候乾聲母帶就回不來了）。分段 yield 兩個問題都沒有。
 */
export function bake(opts) {
  const it = bakeSteps(opts);
  let r = it.next();
  while (!r.done) r = it.next();
  return r.value;
}

/**
 * 把一發雷聲混進母帶。
 *
 * 變速用**最近鄰取樣**而不是線性內插：雷聲是寬頻的噪音類素材，內插省下來的那點混疊在它身上
 * 聽不出來，而這裡最多打二十發、每發不到兩秒 —— 為了聽不出來的差別多寫一段內插不划算。
 */
function mixOneShot(outL, outR, src, ev, scale, sampleRate) {
  if (!src?.left?.length) return;
  const at = Math.round(ev.at * sampleRate);
  const g = scale * ev.gain;
  const n = Math.floor(src.left.length / ev.rate);
  for (let i = 0; i < n; i++) {
    const j = at + i;
    if (j >= outL.length) break;
    const k = Math.min(src.left.length - 1, Math.round(i * ev.rate));
    outL[j] += src.left[k] * g;
    outR[j] += (src.right ?? src.left)[k] * g;
  }
}
