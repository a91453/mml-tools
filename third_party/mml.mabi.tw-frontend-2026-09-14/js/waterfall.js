// ────────────────────────────────────────────────────────────────────────────
//  鋼琴瀑布：幾何與繪製
//
//  **純函式，不碰 DOM、不碰音訊、不讀時鐘。** 預覽與匯出共用這一份 —— 差別只在誰提供
//  `t`：預覽是 `AudioContext` 的時鐘，匯出是 `frameIndex / fps`。兩邊各寫一份的下場是
//  「預覽好看、匯出不一樣」，而那要等到影片做完才會發現。
//
//  ─── 為什麼連粒子都是 t 的封閉解，而不是「固定步長 + 種子亂數」 ───
//
//  原型的粒子是 `dt` 積分（`p.x += p.vx*dt`），那有三個獨立的毛病：跨 fps 不一致（`vx *= 0.985`
//  是**每幀**衰減不是每秒）、不能 seek（跳到 30 秒得先把前 30 秒模擬完）、而且要保存狀態。
//  種子亂數只解掉其中一個。
//
//  所以這裡走更遠一步：**每一顆粒子的位置都是 `t` 的封閉解**。星塵是等速直線加 `sin` 閃爍，
//  擊鍵噴發是彈道公式（初速種子化、只有重力、不做空氣阻力）。結果是這個模組**完全無狀態** ——
//  `draw(ctx, t, …)` 對任何 `t` 都能單獨算，seek 是精確的，30fps 與 60fps 畫出來的同一個 `t`
//  完全相同，而「兩次渲染是否一致」變成型別上的事實而不是一個要守的約定。
//
//  ─── 幾何在這裡，畫法在 wfstyles.js ───
//
//  音符與落鍵是**可以換樣式的**，而這一支只算幾何：算出膠囊該畫在哪、多寬多高、有沒有在響，
//  然後把畫筆交給 `style.draw(ctx, box)` 與 `fx.draw(ctx, hit)`。樣式也可提供專屬鍵盤；背景、
//  星塵與浮水印仍由這裡統一繪製。
//
//  **那條線不能移。** 幾何是下面「沒有 clamp」那一段在守的東西，而它守的其實是「預覽即成品」；
//  一旦樣式可以自己算位置，那個保證就退回成一個約定，而破壞它要等影片做完才看得出來。上面那
//  個封閉解的紀律同樣延伸過去 —— 契約與理由寫在 `wfstyles.js` 的檔頭。
//
//  ─── 幾何一律由 (W, H) 推導 ───
//
//  一行都不能讀 `window.innerWidth`：同一份程式碼要畫 16:9 與 9:16。所有「像素常數」（線寬、
//  光暈半徑、圓角）都乘上 `u`，而 `u = min(W, H) / 1080` —— 1920×1080 與 1080×1920 都剛好
//  是 1，也就是兩種比例的筆觸粗細一致。**不要改成 H/1080**：直式的 H 是 1920，描邊會粗一倍，
//  而音符反而更窄。
//
//  ─── 沒有 clamp ───
//
//  原型的鍵盤高度是 `max(80, min(150, H*0.17))`。那個夾在這裡**必須拿掉** —— 有它的話幾何
//  就不是 (W,H) 的線性函式，960×540 的預覽跟 1920×1080 的匯出會是兩種構圖，而「所見即所得」
//  整個不成立。測試直接斷言「半尺寸的每個值剛好是一半」，那條就是這件事的形式化。
// ────────────────────────────────────────────────────────────────────────────

import { NOTE_COLORS, NOTE_DEFAULTS, GAME_TRACKS } from "./config.js";
import { MIN_DUR } from "./mixnotes.js";
import { rng, rgba, mixWhite, mixBlack, NOTE_STYLES, HIT_FX } from "./wfstyles.js";

/**
 * `rng` 從 `wfstyles.js` 轉出去。**相依是單向的**（這一支 → wfstyles），所以那幾個畫圖用的
 * 小工具住在那邊；但 `rng` 是這一支的 `makeDust` 也要用的東西，而且它本來就是這個模組的公開
 * 介面（測試直接 import 它）。轉出去比搬走再改所有呼叫端便宜，也比各留一份安全。
 */
export { rng };

// ─── 常數 ───────────────────────────────────────────────────────────────────

/**
 * 標準 88 鍵鋼琴：A0(21) – C8(108)。
 *
 * **這個範圍完整涵蓋 `config.PITCH_MIN`(24) – `PITCH_MAX`(107)**，而 `mml.js` 的
 * `foldIntoRange` 保證每個音都被折進那個範圍 —— 所以「音高超出鍵盤」是一個**永遠不會發生**
 * 的情況，畫面上不會有聽得到卻看不見的音。原型寫死的 36–96 沒有這個性質：o1 的低音與 o7 的
 * 高音在那裡會 `keyOf` 查不到而被 `continue` 掉，安靜地消失。
 */
export const KEY_LOW = 21;
export const KEY_HIGH = 108;

/** 白鍵數。88 鍵裡有 52 白 36 黑 —— 寫成常數是為了讓 `whiteW` 的除法看得懂。 */
export const WHITE_KEYS = 52;

/** 鍵盤佔畫面高度的比例。**比例而不是像素**，理由見檔頭「沒有 clamp」。 */
const KB_FRAC = 0.17;

/** 黑鍵高度佔鍵盤高度的比例。export 是為了讓測試算得出黑鍵的縱向範圍。 */
export const BLACK_FRAC = 0.62;

/** 黑鍵寬度佔白鍵寬度的比例。 */
const BLACK_W = 0.62;

/** 音符寬度以白鍵寬為基準；中心仍然對齊原本琴鍵。 */
const NOTE_W_WHITE = 0.8125;
const NOTE_W_BLACK = 0.65;

/**
 * 白鍵下緣切掉多大的角，佔**鍵寬**的比例。**是切角不是圓角** —— 真的鋼琴白鍵前緣是一道
 * 斜面，磨圓會變成塑膠玩具。
 *
 * 比例對著鍵寬而不是鍵高：45° 的切角在 x 與 y 上吃掉一樣多，而鍵寬是兩者中小的那個
 * （52 個白鍵鋪滿 1080 寬 → 一個鍵 20.8 寬、326 高）。對著鍵高算的話，切角會比整個鍵還寬。
 *
 * **0.13，而且是往下調過的。** 第一版寫 0.28，結果相鄰兩鍵的切角在中間湊成一個 20px 寬的
 * V，整排下緣變成鋸齒 —— 那不是「角被切掉」，那是「鍵盤破了」。切角要小到讓人覺得是邊緣的
 * 一道斜面，而不是一個造型。
 */
const WHITE_CUT = 0.13;

/**
 * 黑鍵最下面那一塊「前緣面」佔黑鍵高度的比例。
 *
 * **立體感幾乎全部來自這一塊。** 真的黑鍵是一個有厚度的方塊，頂面朝上、前緣面朝向演奏者；
 * 前緣面接到的光跟頂面不同，所以它明顯亮一階。少了它，黑鍵就只是一個深色長方形。
 */
const BLACK_FACE = 0.18;

/**
 * 畫面上看得到多少秒的音樂。**落下速度由它推導**（`pps = 落下距離 / 這個數`），不是反過來。
 *
 * 原型用固定的 `170 px/s`，於是同一首曲子在 16:9 與 9:16 底下看得到的音樂份量差一倍，而直式
 * 影片開頭要空轉 10 秒才有聲音。改成前瞻秒數之後，比例與解析度怎麼換都一樣。
 *
 * 它同時就是**前導長度**：`t = -LOOK_AHEAD_SEC` 那一幀，第一個音剛好在畫面頂端；`t = 0` 時
 * 它觸底發聲。
 *
 * **這是預設值，不是唯一值**：`layout()` 收一個可選的覆寫（影片頁的「落下速度」，見
 * `video.SPEED`）。⚠️ 而**「掉得多慢」跟「一次看得到幾個音符」是同一件事，不是兩件** ——
 * 這個常數的定義就是後者，而前者是它除出來的結果，調它等於同時調兩邊。
 *
 * 它**不影響曲速，也不影響影片長度**：音訊完全不經過這裡，而片長是 `video.tl()` 算的，
 * 只吃 `LEAD_IN_SEC` 與 `OUTRO_SEC`。
 */
export const LOOK_AHEAD_SEC = 2.5;

/**
 * 影片在音樂開始**之前**先播多久。
 *
 * **這跟 `LOOK_AHEAD_SEC` 是兩件事，本來被我綁在一起，那是設計上的失誤。** 前瞻秒數決定
 * 「畫面上看得到多少音樂」（＝落下速度）；前導秒數決定「影片開頭空轉多久」。綁在一起的
 * 意思是「畫面必須從空的開始填」，但那不是必要的 —— `t = 0` 那一幀畫面上本來就已經有
 * 未來 2.5 秒的音符在落下了。
 *
 * 所以預設 **0**：影片第一幀就是**已經填滿的瀑布**，而且音樂立刻開始。對短影音這是對的 ——
 * 前三秒沒抓住人就滑掉了，而「看著空畫面等音符落下來」剛好是最糟的開場。
 *
 * 想要有一點呼吸就改成 0.5–1；想回到「從空畫面開始填」就設成 `LOOK_AHEAD_SEC`。
 */
export const LEAD_IN_SEC = 0;

/** 音樂結束後還要再播多久，讓最後一個音的光暈與噴發散掉。 */
export const OUTRO_SEC = 1.5;

/** 星塵幾顆。 */
const DUST_N = 130;

/**
 * MIDI 力度的上限。`prepare` 用它把 parser 的 1–127 換成這個檔案裡到處假設的 0..1。
 *
 * 寫成具名常數而不是行內的 127：這個數字錯了不會有例外，只會讓畫面「怪怪的」，而具名之後
 * 至少搜尋得到它跟 `mml.js` 是同一個約定。
 */
const MIDI_VEL_MAX = 127;

// ─── 顏色 ───────────────────────────────────────────────────────────────────

/** `"#e0ae5a"` → `[224, 174, 90]`。 */
export function hexRgb(hex) {
  const n = parseInt(hex.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

/**
 * 每一軌的預設顏色。
 *
 * **不再是 `TRACK_COLORS` 的前六個。** 影片有自己的調色盤 —— 編輯器那組是為鋼琴捲軸調的中低
 * 飽和色，搬到「深底 ＋ `lighter` 加法混色」的瀑布上偏灰，發光感比該有的弱一截。
 *
 * 但「哪一軌是什麼色系」保住了：`NOTE_DEFAULTS` 是照色相把六軌各自對到最接近的新色（差只有
 * 1～10°），所以編輯器裡是紫色的第 3 軌，影片裡還是紫色的。那是使用者唯一能把「畫面上這條」
 * 對回「我寫的那一軌」的線索，換調色盤不該把它一起換掉。
 */
export const trackColors = () => NOTE_DEFAULTS.map(k => hexRgb(NOTE_COLORS[k]));

/**
 * 使用者自訂的配色，`ids` 是 `GAME_TRACKS` 個 `NOTE_COLORS` 的索引。**可選的顏色有 30 個，要
 * 指定的只有 6 軌** —— 那是兩個不同的數字：第 7 軌以後的音符連 `prepare()` 都進不來（見
 * `song.tracks.slice(0, GAME_TRACKS)`），給它們顏色是給看不到的東西上色。
 *
 * **每一格各自落回原色，不是整組落回。** 這個陣列的來源是 localStorage，所以永遠可能是舊的、
 * 缺的、壞的。整組落回的話，一格壞掉會讓另外五格也一起消失 —— 而使用者完全看不出為什麼。
 */
export const colorsOf = ids => Array.from({ length: GAME_TRACKS }, (_, i) =>
  hexRgb(NOTE_COLORS[ids?.[i]] ?? NOTE_COLORS[NOTE_DEFAULTS[i]]));

/**
 * 把 localStorage 裡的 `"0,1,2,3,4,5"` 拆回索引陣列，長度保證是 `GAME_TRACKS`，每一格保證
 * 是合法索引。
 *
 * **存成字串是刻意的**：`storage.js` 的 `cleanWaterfall` 一律當字串存、一個字都不驗，而那條
 * 規矩的理由 —— 多驗一次就多一個「以後改了東西忘記回去同步」的無聲失敗 —— 在這裡照樣成立。
 * 所以驗證留在這一側，跟 `noteStyle(id)` 查不到落回第一項是同一個形狀。
 *
 * 空字串、少給幾格、給了非數字、索引超出調色盤，全部落回 `NOTE_DEFAULTS` 給那一軌的預設。
 */
export const colorIds = spec => {
  const want = String(spec ?? "").split(",");
  return Array.from({ length: GAME_TRACKS }, (_, i) => {
    const raw = (want[i] ?? "").trim();
    const k = /^\d+$/.test(raw) ? +raw : -1;
    return k >= 0 && k < NOTE_COLORS.length ? k : NOTE_DEFAULTS[i];
  });
};

// ─── 鍵盤幾何 ───────────────────────────────────────────────────────────────

/** 黑鍵嗎。`m - 1` 對黑鍵一定是白鍵（`{1,3,6,8,10}` 減一是 `{0,2,5,7,9}`），黑鍵定位靠這點。 */
export const isBlack = m => [1, 3, 6, 8, 10].includes(((m % 12) + 12) % 12);

/**
 * 版面。**只回資料，一行都不碰 ctx** —— 呼叫端自己決定 DPR、transform 與畫布大小。
 *
 * ─── 鍵盤永遠沿著長邊 ───
 *
 * 88 個鍵鋪在短邊上會細到看不清楚：9:16 的短邊是 1080，一個白鍵只有 **20.8px**，而 16:9
 * 鋪在 1920 上有 36.9px。所以直式**把整個場景轉 90°**：鍵盤立起來貼在左邊，音符由右往左飛。
 *
 * 這不是兩套幾何。場景永遠是「鍵盤在下、低音在左、音符往下落」那一套，直式只是最後貼上畫布
 * 時多一個變換（見 `draw`）。**下面每一個數字都還是場景座標**，所以樣式、特效、以及那條
 * 「半尺寸的每個值剛好是一半」的不變式全部原封不動。
 *
 * 換來的是兩種比例的構圖**完全相同**：白鍵 36.9px、落下距離 896px，兩邊一模一樣。改版前
 * 直式是另一種手感（鍵細一半、落下距離長一倍）。
 *
 * 回傳的每一個數字都是**場景尺寸**的線性函式（沒有 clamp、沒有 round），所以
 * `layout(960, 540)` 的每個值剛好是 `layout(1920, 1080)` 的一半。
 *
 * @param {number} W 畫布寬
 * @param {number} H 畫布高
 * @param {number} [lookAhead] 畫面上看得到幾秒的音樂。預設 `LOOK_AHEAD_SEC`。**唯一的出口
 *                            是 `pps`** —— 幾何的其他每一項都還是只由 (W,H) 推導，所以上面
 *                            那條「`layout(960,540)` 剛好是 `layout(1920,1080)` 的一半」
 *                            不受它影響
 * @returns {{W:number, H:number, u:number, kbTop:number, kbH:number, whiteW:number,
 *            pps:number, outW:number, outH:number, portrait:boolean,
 *            keys:{midi:number,x:number,w:number,black:boolean}[],
 *            keyOf:Map<number,object>, dust:object[]}}
 */
export function layout(W, H, lookAhead = LOOK_AHEAD_SEC) {
  // 直式：場景是躺著的，長短邊對調。`portrait` 只有 `draw` 會讀 —— 它是「要不要轉」，
  // 不是幾何的一部分。
  const portrait = H > W;
  const sw = portrait ? H : W;
  const sh = portrait ? W : H;

  // 「1080p 下的 1 像素」。min 而不是 sh：見檔頭。
  const u = Math.min(sw, sh) / 1080;
  const kbH = sh * KB_FRAC;
  const kbTop = sh - kbH;
  const whiteW = sw / WHITE_KEYS;

  const keys = [];
  const whiteX = new Map();
  let wx = 0;
  for (let m = KEY_LOW; m <= KEY_HIGH; m++) {
    if (isBlack(m)) continue;
    whiteX.set(m, wx);
    keys.push({ midi: m, x: wx, w: whiteW, black: false });
    wx += whiteW;
  }
  const bw = whiteW * BLACK_W;
  for (let m = KEY_LOW; m <= KEY_HIGH; m++) {
    if (!isBlack(m)) continue;
    keys.push({ midi: m, x: whiteX.get(m - 1) + whiteW - bw / 2, w: bw, black: true });
  }

  return {
    W: sw, H: sh, u, kbTop, kbH, whiteW, keys,
    // 畫布本身的尺寸。**只有浮水印用得到** —— 它是唯一一個畫在畫布座標系、不跟著場景轉的
    // 東西（轉了字就側躺）。
    outW: W, outH: H, portrait,
    keyOf: new Map(keys.map(k => [k.midi, k])),
    // 落下距離就是畫面頂端到打擊線。除以前瞻秒數 → 每秒幾像素。
    // 0 或負數會算出 Infinity／負速度，落回預設 —— 同 `video.speedSec` 那條退路，兩邊都擋。
    pps: kbTop / (lookAhead > 0 ? lookAhead : LOOK_AHEAD_SEC),
    dust: makeDust(),
  };
}

// ─── 星塵（封閉解） ─────────────────────────────────────────────────────────

/**
 * 星塵。座標是 **0..1 正規化**的，所以跟解析度無關 —— 同一組資料畫在 960×540 與
 * 1920×1080 上是同一個構圖，這也是 `layout` 兩種尺寸能剛好差 2 倍的前提之一。
 *
 * 沒有速度積分：`y` 由 `t` 直接算（見 `dustY`）。
 */
export function makeDust(n = DUST_N, seed = 20260829) {
  const r = rng(seed);
  return Array.from({ length: n }, () => ({
    x: r(),
    y0: r(),
    rad: r() * 1.5 + 0.75,     // 半徑，畫的時候再乘 u
    vy: (r() * 6 + 2) / 1000,  // 每秒往上飄多少（正規化單位）
    a: r() * 0.35 + 0.08,
    ph: r() * Math.PI * 2,
  }));
}

/** 星塵在 `t` 的高度。往上飄、飄出去就從底下回來 —— 取小數部分就是「回來」。 */
const dustY = (p, t) => {
  const y = (p.y0 - p.vy * t) % 1;
  return y < 0 ? y + 1 : y;
};

// ─── 音符 ───────────────────────────────────────────────────────────────────

/**
 * `mml.parseAll` 的結果 → 一份攤平、排好、可以直接畫的音符陣列。
 *
 * **只做前 `GAME_TRACKS` 軌**，跟 `mixnotes.buildEvents` 同一條規矩：影片的定位是「別人在
 * 遊戲裡會聽到的那首曲子」。分享出去的本來就只有 6 軌，所以這一刀實務上切不到東西 —— 留著
 * 是因為這個函式從編輯器那邊呼叫也要是對的。
 *
 * `MIN_DUR` **是從 `mixnotes.js` import 的，不是抄一份**：兩邊的門檻分家的症狀是「畫面上有
 * 一根音符卻沒有聲音」，靠眼睛抓不到。
 *
 * `seed` 是排序後的索引，擊鍵噴發拿它當亂數種子。所以**排序鍵必須完全決定順序** —— 只比
 * `start` 的話同高度同時刻的兩個音順序不穩，同一首譜兩次匯出的噴發就會不一樣。
 */
export function prepare(song) {
  const out = [];
  song.tracks.slice(0, GAME_TRACKS).forEach((tr, track) => {
    for (const n of tr.notes) {
      if (n.dur < MIN_DUR) continue;
      // **力度在這裡換成 0..1，而 parser 給的是 MIDI 的 1–127**（見 mml.js 的
      // `vel15 * 127 / 15`）。這是原型與真實資料唯一的單位落差，而漏掉它的代價很具體：
      // 噴發的粒子數是 `8 + vel*10`、初速是 `60 + rnd*160*vel` —— 直接餵 127 進去會變成
      // 每個音 1278 顆、初速 20000 px/s，也就是「粒子飛滿整個畫面而且嚴重掉幀」。
      out.push({ track, midi: n.midi, start: n.start, dur: n.dur, vel: n.vel / MIDI_VEL_MAX });
    }
  });
  out.sort((a, b) => a.start - b.start || a.midi - b.midi || a.track - b.track);
  out.forEach((n, i) => { n.seed = i; });
  return out;
}

/**
 * 影片的時間軸。`t` 是**歌曲時間**，所以前導是負的 —— 音符的 `start` 完全不用位移，那是這個
 * 選擇的全部理由（位移的話每個比對 `t >= n.start` 的地方都得記得加上偏移量，而漏掉一個的
 * 症狀是整支影片音畫對不上）。
 *
 * 前導用 `LEAD_IN_SEC` 而**不是** `LOOK_AHEAD_SEC`：那是兩件事，見那兩個常數的說明。
 *
 * @param {number} musicEnd 音樂（含殘響尾巴）結束的秒數，也就是 PCM 的長度
 */
export const timeline = musicEnd => ({
  start: -LEAD_IN_SEC,
  end: musicEnd + OUTRO_SEC,
  duration: LEAD_IN_SEC + musicEnd + OUTRO_SEC,
});

// ─── 繪製 ───────────────────────────────────────────────────────────────────

function drawBackground(ctx, t, v) {
  const { W, H, kbTop, u } = v;

  const g = ctx.createLinearGradient(0, 0, 0, H);
  g.addColorStop(0, "#04060f");
  g.addColorStop(0.65, "#081020");
  g.addColorStop(1, "#0c1630");
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, W, H);

  // 鍵盤上方的微光暈
  const glow = ctx.createRadialGradient(W / 2, kbTop, 10 * u, W / 2, kbTop, H * 0.55);
  glow.addColorStop(0, "rgba(70,110,220,0.10)");
  glow.addColorStop(1, "rgba(70,110,220,0)");
  ctx.fillStyle = glow;
  ctx.fillRect(0, 0, W, H);

  // 八度分隔線（每個 C）
  ctx.strokeStyle = "rgba(130,160,230,0.06)";
  ctx.lineWidth = u;
  for (const k of v.keys) {
    if (k.black || k.midi % 12 !== 0) continue;
    ctx.beginPath();
    ctx.moveTo(k.x, 0);
    ctx.lineTo(k.x, kbTop);
    ctx.stroke();
  }

  for (const p of v.dust) {
    const tw = 0.625 + 0.375 * Math.sin(t * 1.3 + p.ph);
    ctx.fillStyle = `rgba(160,190,255,${p.a * tw})`;
    ctx.beginPath();
    ctx.arc(p.x * W, dustY(p, t) * kbTop, Math.max(0.6, p.rad * u), 0, Math.PI * 2);
    ctx.fill();
  }
}

/**
 * 落下中的音符。**這一層只算幾何，一筆都不上色** —— 顏色交給 `style.draw(ctx, box)`。
 *
 * 切在這裡的理由見 `wfstyles.js` 的檔頭：`layout()` 的線性性質是「預覽即成品」的形式化，
 * 而讓樣式自己算位置會把那條保證從「型別上的事實」退回「一個要守的約定」。
 *
 * `composite` 是**每一層設一次**，不是每顆音符設一次 —— 每顆設的話 `save`/`restore` 的次數
 * 會跟音符數成正比，而它們在 canvas 2D 上不是免費的。
 */
function drawNotes(ctx, t, v, notes, colors, style) {
  const { kbTop, pps, u, whiteW } = v;
  ctx.save();
  ctx.globalCompositeOperation = style.composite;

  for (const n of notes) {
    const bottom = kbTop - (n.start - t) * pps;
    const fullH = Math.max(10 * u, n.dur * pps - 4 * u);
    const top = bottom - fullH;
    if (bottom < -10 * u || top > kbTop) continue;

    const k = v.keyOf.get(n.midi);
    if (!k) continue;

    const w = whiteW * (k.black ? NOTE_W_BLACK : NOTE_W_WHITE);
    const x = k.x + k.w / 2 - w / 2;

    // 裁掉畫面外的部分。**漸層還是錨在未裁切的 top/bottom 上**（樣式自己會用），不然長音
    // 從畫面頂端捲進來時顏色分佈會隨著露出多少而變 —— 看起來像音符自己在變色。
    const clipBottom = Math.min(bottom, kbTop);
    const clipTop = Math.max(top, -20 * u);
    const h = clipBottom - clipTop;
    if (h <= 0) continue;

    style.draw(ctx, {
      x, w, top, bottom, fullH,
      y: clipTop, h, r: w / 2,
      color: colors[n.track % colors.length],
      active: t >= n.start && t < n.start + n.dur,
      vel: n.vel, u, kbTop, t, seed: n.seed, age: t - n.start,
      cx: k.x + k.w / 2, kw: k.w,
    });
  }
  ctx.restore();
}

/**
 * 落鍵特效。**`fx.span` 同時是生命期與剔除條件** —— 迴圈用它跳過還沒發聲、以及早就散掉的
 * 音，所以 `span` 寫得太大只是白算，太小會把效果切掉。
 *
 * `span: 0`（「無」）連整層都不進 —— 那一項因此是零成本，不是「畫一個空的東西」。
 */
function drawHits(ctx, t, v, notes, colors, fx) {
  if (!fx.span) return;
  const { kbTop, u } = v;
  ctx.save();
  ctx.globalCompositeOperation = fx.composite;
  for (const n of notes) {
    const age = t - n.start;
    if (age < 0 || age >= fx.span) continue;
    const k = v.keyOf.get(n.midi);
    if (!k) continue;
    fx.draw(ctx, {
      x: k.x + k.w / 2, y: kbTop, w: k.w,
      age, vel: n.vel,
      color: colors[n.track % colors.length],
      u, seed: n.seed,
    });
  }
  ctx.restore();
}

/** 現在按著哪些鍵 → 顏色。 */
function activeKeys(t, notes, colors) {
  const m = new Map();
  for (const n of notes) {
    if (t >= n.start && t < n.start + n.dur) m.set(n.midi, colors[n.track % colors.length]);
  }
  return m;
}

/**
 * 白鍵的輪廓。**下緣兩個角是切掉的，不是磨圓的** —— `capsule` 那條圓角在這裡用不得。
 *
 * 相鄰兩個鍵的切角會在中間湊成一個 V 形缺口，背景從那裡透出來 —— 那正是參考圖上看到的東西，
 * 而且它讓鍵盤下緣不再是一條死板的直線。
 */
function whiteKeyPath(ctx, x, y, w, h, cut) {
  ctx.beginPath();
  ctx.moveTo(x, y);
  ctx.lineTo(x + w, y);
  ctx.lineTo(x + w, y + h - cut);
  ctx.lineTo(x + w - cut, y + h);
  ctx.lineTo(x + cut, y + h);
  ctx.lineTo(x, y + h - cut);
  ctx.closePath();
}

/**
 * 鍵盤。
 *
 * ─── 黑鍵一律不透明 ───
 *
 * 按下的黑鍵本來是 `rgba(c, 1)` 漸層到 `rgba(c, 0.55)`，於是**底下白鍵的分隔線會從黑鍵裡透
 * 出來** —— 一顆按下的黑鍵中間憑空多一條黑線。半透明在這裡沒有換到任何東西：黑鍵要的是
 * 「被打亮」，而那靠的是色相與光暈，不是讓人看穿它。
 *
 * 白鍵的分隔線同時也**只畫到切角開始的地方**，不然它會穿過那個 V 形缺口，在鍵盤下緣留下
 * 幾根伸出去的鬚。
 */
function drawKeyboard(ctx, t, v, notes, colors, style) {
  const kb = {
    keys: v.keys, act: activeKeys(t, notes, colors),
    kbTop: v.kbTop, kbH: v.kbH, blackH: v.kbH * BLACK_FRAC, W: v.W, H: v.H, u: v.u,
  };
  (style.keyboard ?? defaultKeyboard)(ctx, kb);
}

/** 預設的漸層塑膠鍵盤；樣式可透過 `keyboard` 提供自己的畫法。 */
function defaultKeyboard(ctx, kb) {
  const { W, H, kbTop, kbH, u, act } = kb;

  // 打擊線
  ctx.fillStyle = "rgba(140,170,255,0.35)";
  ctx.fillRect(0, kbTop - 1.5 * u, W, 1.5 * u);
  ctx.save();
  ctx.shadowColor = "rgba(120,160,255,0.6)";
  ctx.shadowBlur = 10 * u;
  ctx.fillRect(0, kbTop - 1.5 * u, W, 1.5 * u);
  ctx.restore();

  // ── 白鍵 ──
  for (const k of kb.keys) {
    if (k.black) continue;
    const c = act.get(k.midi);
    const x = k.x + u / 2;
    const w = k.w - u;
    const cut = k.w * WHITE_CUT;

    const g = ctx.createLinearGradient(0, kbTop, 0, H);
    if (c) {
      g.addColorStop(0, rgba(c, 0.95));
      g.addColorStop(1, "rgba(235,240,255,0.92)");
    } else {
      g.addColorStop(0, "#d7dcea");
      g.addColorStop(1, "#f4f6fc");
    }

    ctx.save();
    if (c) {
      ctx.shadowColor = rgba(c, 0.9);
      ctx.shadowBlur = 18 * u;
    }
    ctx.fillStyle = g;
    whiteKeyPath(ctx, x, kbTop, w, kbH, cut);
    ctx.fill();
    ctx.restore();

    // 前緣的斜面。切角本身是一個朝下的面，給它一道暗一階的收邊，「被切掉」才會讀成
    // 一個有厚度的邊，而不是缺了一角。
    ctx.fillStyle = "rgba(20,30,60,0.14)";
    ctx.fillRect(x + cut, kbTop + kbH - u * 1.5, w - cut * 2, u * 1.5);

    // 左緣暗線。**只到切角開始的地方**，理由見函式說明。
    ctx.fillStyle = "rgba(20,30,60,0.25)";
    ctx.fillRect(k.x, kbTop, u, kbH - cut);
  }

  // ── 黑鍵 ──
  //
  // 由下往上四層：本體（頂面）、前緣面、兩者之間的轉折高光、左右側的倒角。**兩種狀態共用
  // 同一組結構**，差別只有色相 —— 各畫一套的話，按下去的那一瞬間會像換了一顆鍵，而不是
  // 同一顆被打亮。
  const bh = kbH * BLACK_FRAC;
  const face = bh * BLACK_FACE;

  for (const k of kb.keys) {
    if (!k.black) continue;
    const c = act.get(k.midi);
    const { x, w } = k;
    const faceTop = kbTop + bh - face;

    // 光暈。先把整顆鍵鋪一次當光源，細節再疊上去 —— 逐層都帶 shadowBlur 的話，
    // 一顆鍵要付四次 canvas 2D 最貴的那個操作。
    if (c) {
      ctx.save();
      ctx.shadowColor = rgba(c, 0.95);
      ctx.shadowBlur = 16 * u;
      ctx.fillStyle = rgba(c, 1);
      ctx.fillRect(x, kbTop, w, bh);
      ctx.restore();
    }

    // 頂面：光從上面來，所以上緣亮、往下沉
    const top = ctx.createLinearGradient(0, kbTop, 0, faceTop);
    top.addColorStop(0, c ? rgba(mixWhite(c, 0.28), 1) : "#252d44");
    top.addColorStop(1, c ? rgba(mixBlack(c, 0.34), 1) : "#0a0e1a");
    ctx.fillStyle = top;
    ctx.fillRect(x, kbTop, w, bh - face);

    // 前緣面：明顯亮一階，立體感就是這一塊。
    //
    // **按下時混白的量刻意壓在 0.4**：第一版是 0.62，結果亮到看不出是什麼顏色 —— 一顆按下
    // 的黑鍵變成「上半金色、下半白色」，讀起來是黏了一塊東西，不是同一顆鍵被打亮。要的是
    // 「亮一階」而不是「亮到爆」。
    const front = ctx.createLinearGradient(0, faceTop, 0, kbTop + bh);
    front.addColorStop(0, c ? rgba(mixWhite(c, 0.40), 1) : "#4b5672");
    front.addColorStop(0.5, c ? rgba(c, 1) : "#2c344a");
    front.addColorStop(1, c ? rgba(mixBlack(c, 0.5), 1) : "#10151f");
    ctx.fillStyle = front;
    ctx.fillRect(x, faceTop, w, face);

    // 轉折高光：頂面與前緣面之間那一道稜線
    ctx.fillStyle = c ? rgba(mixWhite(c, 0.7), 0.6) : "rgba(160,175,210,0.45)";
    ctx.fillRect(x, faceTop, w, u);

    // 側面倒角。左亮右暗 —— 跟頂面的漸層同一個光源方向
    ctx.fillStyle = "rgba(255,255,255,0.09)";
    ctx.fillRect(x, kbTop, u, bh);
    ctx.fillStyle = "rgba(0,0,0,0.32)";
    ctx.fillRect(x + w - u, kbTop, u, bh);

    // 底緣：把前緣面收掉，不然它會跟白鍵的亮面糊在一起
    ctx.fillStyle = "rgba(0,0,0,0.55)";
    ctx.fillRect(x, kbTop + bh - u, w, u);
  }
}

/**
 * 浮水印。**這條路沒有 Worker，所以可以直接 `fillText`** —— 那正是逐幀渲染選主執行緒的理由
 * 之一（`OffscreenCanvas` 裡沒有 DOM 字型，文字得先 rasterize 成 `ImageBitmap` 傳進去）。
 */
function drawMark(ctx, v, mark) {
  const { u } = v;
  const font = mark.font ?? "system-ui, sans-serif";

  // **畫在畫布座標系，不跟著場景轉。** 直式的場景是躺著再鏡射貼上去的（見 draw），字跟著轉
  // 就會側躺而且左右相反。所以這一段刻意排在 draw 的 restore 之後。
  //
  // 橫式的位置跟改版前逐字相同（`outH - kbH` 就是 `kbTop`）；直式的鍵盤立在左邊，右下角
  // 整片是空的，所以只留一個邊距。
  const x = v.outW - 28 * u;
  const base = v.portrait ? v.outH - 30 * u : v.outH - v.kbH - 46 * u;

  ctx.save();
  ctx.globalCompositeOperation = "source-over";
  ctx.textAlign = "right";
  ctx.textBaseline = "alphabetic";
  ctx.fillStyle = "rgba(200,215,255,0.34)";
  ctx.font = `${20 * u}px ${font}`;
  ctx.fillText(mark.text, x, base);
  if (mark.sub) {
    ctx.fillStyle = "rgba(200,215,255,0.22)";
    ctx.font = `${14 * u}px ${font}`;
    ctx.fillText(mark.sub, x, base + 22 * u);
  }
  ctx.restore();
}

/**
 * 畫一幀。**這個函式是整個影片功能的心臟，而它是純的** —— 同一組 `(t, view, notes, opts)`
 * 永遠畫出同一個東西，不管那是預覽的第 3 秒還是匯出的第 90 幀。
 *
 * `style` 與 `fx` **收物件不收 id**：查表（`wfstyles.noteStyle(id)`）是呼叫端的事，因為它才
 * 知道那個 id 是從哪裡來的、以及查不到時要不要講一聲。這一支收到什麼就畫什麼。
 *
 * @param {CanvasRenderingContext2D} ctx
 * @param {number} t       歌曲時間，秒。**前導期間是負的**（見 `timeline`）
 * @param {object} view    `layout(W, H)` 的結果
 * @param {object[]} notes `prepare(song)` 的結果
 * @param {{colors?:number[][], style?:object, fx?:object,
 *          mark?:{text:string, sub?:string, font?:string}}} [opts]
 */
export function draw(ctx, t, view, notes, opts = {}) {
  const colors = opts.colors ?? trackColors();
  const style = opts.style ?? NOTE_STYLES[0];
  const fx = opts.fx ?? HIT_FX[0];

  ctx.save();
  if (view.portrait) orient(ctx, view);
  drawBackground(ctx, t, view);
  drawNotes(ctx, t, view, notes, colors, style);
  drawHits(ctx, t, view, notes, colors, fx);
  drawKeyboard(ctx, t, view, notes, colors, style);
  ctx.restore();

  // 浮水印在 restore 之後 —— 它是唯一畫在畫布座標系的東西，見 drawMark。
  if (opts.mark) drawMark(ctx, view, opts.mark);
}

/**
 * 直式：把躺著的場景貼到直立的畫布上。
 *
 *   場景 (x, y)  →  畫布 (outW − y, outH − x)
 *
 * 四個角各自對到哪裡，就是「鍵盤在左、低音在下、音符由右往左」這三件事：
 *
 *   場景下緣（鍵盤，y = H）      → 畫布 x = 0        鍵盤貼左邊
 *   場景左緣（低音，x = 0）      → 畫布 y = outH     低音在下
 *   y 變大（音符往打擊線落）      → 畫布 x 變小       音符往左飛
 *
 * **這是鏡射，不是旋轉**（行列式 −1），而且那是幾何上跑不掉的：純旋轉只給得出「鍵盤在左
 * 但低音在上」或「鍵盤在右低音在下」。代價是音符的左緣反光與黑鍵的左右倒角會左右對調 ——
 * 那兩個轉了 90° 之後本來就不在原來的方位上了，看不出來。**文字會真的變成鏡像**，所以浮水
 * 印不走這條路。
 *
 * 用 `transform` 而不是 `setTransform`：後者會**蓋掉**呼叫端已經套好的變換，而外觀對話框
 * 的縮圖正是先 `setTransform` 再叫 `draw` 的。目前縮圖用橫式場景走不到這裡，但那是一個
 * 等著被踩的地雷。
 */
function orient(ctx, v) {
  ctx.transform(0, -1, -1, 0, v.outW, v.outH);
}
