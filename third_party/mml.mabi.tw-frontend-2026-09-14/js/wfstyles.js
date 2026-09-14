// ────────────────────────────────────────────────────────────────────────────
//  鋼琴瀑布：音符樣式與落鍵特效
//
//  **這一支是「畫法」，waterfall.js 是「幾何」。** 分家的理由只有一個，但它很硬：
//
//    幾何是這個功能唯一有測試在守的不變式 —— `layout()` 的每個數字都是 (W, H) 的**線性**
//    函式（沒有 clamp、沒有 round），所以 `layout(960,540)` 的每個值剛好是 `layout(1920,1080)`
//    的一半。那條就是「預覽即成品」的形式化。如果樣式可以自己算位置，那個保證就從「型別上
//    的事實」退回「一個要守的約定」，而破壞它的症狀是**影片做完才看得出來**。
//
//  所以樣式拿到的是一個**算好的盒子**，不是 `view`：它知道要畫多寬多高、什麼顏色、按下了
//  沒有，但它不知道畫布多大、也拿不到 `layout` 的任何一個中間值。
//
//  **樣式也不知道畫面是直的還是橫的，而且不該知道。** 直式（9:16）是把整個場景轉 90° 貼上
//  畫布的（鍵盤立在左邊、音符由右往左飛），但那個變換套在 `draw` 的最外層 —— 下面每一個
//  座標都還是「鍵盤在下、音符往下落」那一套場景座標。所以樣式一行都不用改就同時支援兩種
//  比例，而「音符往下」這句話在這裡永遠是真的。
//
//  **代價寫在這裡，不要之後才發現**：這個切法做不到跨音符的效果 —— 軌跡線、同時按下的音之
//  間的連線、整層的色差，那些都要看得到全部音符。真的需要時該做的是在 waterfall.js 開第二
//  種契約（整層的畫法），不是把 `view` 偷渡進 `box`。
//
//  ─── 決定論是硬性的，不是風格 ───
//
//  **每一種樣式與特效都必須是 `box` 或 `hit` 的封閉解。** 不准讀 `Math.random`、`Date.now`、
//  `performance.now`，不准保存跨幀的狀態。理由是匯出必須可重現：同一首譜匯出兩次應該得到同
//  一支影片，而預覽（短邊 540）與匯出（短邊 1080）畫同一個 `t` 必須畫出同一個構圖。
//
//  `test/waterfall.test.mjs` 會**走過下面每一項**，把那三個全域換成會丟例外的函式再跑一遍
//  `draw`。所以新增樣式不必記得去加測試 —— 加進陣列就被守住了。要亂數就用 `rng(hit.seed)`。
//
//  ─── 怎麼新增一種 ───
//
//    1. 在 `NOTE_STYLES` 或 `HIT_FX` 加一個物件：`{ id, composite, draw }`（特效還要 `span`）
//    2. 四個語言檔各加一行 `waterfall.style.<id>` / `waterfall.fx.<id>`
//    3. 沒有第三步。UI 的清單、縮圖、決定論測試都是從這個陣列長出來的
//
//  第 2 步漏掉哪個語言，`test/i18n.test.mjs` 就會紅 —— `video.js` 那兩處是寫成
//  `` i18n.t(`waterfall.style.${s.id}`) `` 的模板字面值，而那個測試認得這種寫法。
//
//  **不要動第一項。** `NOTE_STYLES[0]` 與 `HIT_FX[0]` 是預設值，換掉它等於「同一份譜、同一
//  個按鈕，這禮拜做出來的影片跟上禮拜不一樣」。測試有一條專門釘住這件事。
// ────────────────────────────────────────────────────────────────────────────

// ─── 畫圖用的小工具 ─────────────────────────────────────────────────────────
//
// 這幾個住在這裡而不是 waterfall.js，是為了讓相依是**單向**的（waterfall.js → wfstyles.js）。
// 反過來的話兩支互相 import，而 ESM 的循環相依只有靠函式宣告提升才不會炸 —— 那是一個沒有
// 錯誤訊息、只在改動順序時才爆的地雷。各留一份複本更糟：`mixWhite` 的係數在兩邊漂掉的症狀
// 是「音符尾端跟琴鍵的亮度對不起來」，而那沒有人看得出來是 bug。

/**
 * mulberry32。**這是整條繪製路徑上唯一的亂數來源，而且它不是為了「隨機」，是為了「每次都
 * 一樣」。** 種子一律來自 `note.seed`（`prepare` 排序後的索引），所以同一個音每次都噴出同
 * 一個形狀。
 */
export function rng(seed) {
  let s = seed | 0;
  return () => {
    s = (s + 0x6D2B79F5) | 0;
    let x = Math.imul(s ^ (s >>> 15), 1 | s);
    x = (x + Math.imul(x ^ (x >>> 7), 61 | x)) ^ x;
    return ((x ^ (x >>> 14)) >>> 0) / 4294967296;
  };
}

/** `[224,174,90]` ＋ alpha → `"rgba(224,174,90,0.5)"`。 */
export const rgba = (c, a) => `rgba(${c[0]},${c[1]},${c[2]},${a})`;

/** 往白色混。`k = 1` 就是純白。音符尾端靠它做出「打到底發亮」。 */
export const mixWhite = (c, k) => [
  c[0] + (255 - c[0]) * k,
  c[1] + (255 - c[1]) * k,
  c[2] + (255 - c[2]) * k,
];

/**
 * 往黑色壓。`k = 1` 就是全黑。
 *
 * 跟 `mixWhite` 是一對：立體感需要**同一個色相的明暗兩端**（受光面往亮的走、背光面往暗的
 * 走），而只有 `mixWhite` 的話，暗的那一端只能寫死一個灰 —— 於是按下的琴鍵會變成「彩色的
 * 上半 ＋ 灰色的下半」，看起來是兩個東西疊在一起，不是同一顆鍵。
 */
export const mixBlack = (c, k) => [c[0] * (1 - k), c[1] * (1 - k), c[2] * (1 - k)];

/** 膠囊。`ctx.roundRect` 不用 —— 相容性下限是 Safari 16.4，而 `arcTo` 這條是原型驗過的。 */
export function capsule(ctx, x, y, w, h, r) {
  const rr = Math.min(r, w / 2, h / 2);
  ctx.beginPath();
  ctx.moveTo(x + rr, y);
  ctx.arcTo(x + w, y, x + w, y + h, rr);
  ctx.arcTo(x + w, y + h, x, y + h, rr);
  ctx.arcTo(x, y + h, x, y, rr);
  ctx.arcTo(x, y, x + w, y, rr);
  ctx.closePath();
}

/**
 * 自帶動畫的樣式，週期一律取這兩個值之一。**它們是 2.4 的因數，而那不是巧合** —— video.js
 * 的縮圖把 `t` 對 `THUMB_LOOP`（＝2.4 秒）取餘數，所以週期除不盡 2.4 的話，縮圖每 2.4 秒會
 * 可見地閃斷一次。真實影片的 `t` 不歸零，那邊怎麼樣都不會斷；這個限制純粹是為了縮圖 —— 而
 * 縮圖是使用者**唯一**用來挑樣式的依據，在那裡閃斷會被讀成「這個樣式壞了」。
 *
 * 原型（`simple/waterfall-note-styles-final10.html`）的 2.2 / 5.0 / 2.6 秒都收進 `SLOW`，
 * 1.1 / 1.4 秒都收進 `FAST`。差距在真實影片裡感知不到。
 */
const SLOW = 2.4;
const FAST = 1.2;

/**
 * 相位打散的幅度，0..1。`1` 是完全打散，`0` 是整個畫面同步。
 *
 * **這是預期會被調的旋鈕。** 打散得越開，畫面越自然；但對電光、故障這種「間歇閃一下」的樣
 * 式，完全打散的意思是**畫面上永遠有幾顆正在閃**，密集的譜底下會很吵。調小它會讓閃爍聚成一
 * 陣一陣的。
 */
const SPREAD = 1;

/**
 * 自帶動畫的相位，0..1。`period` 用 `SLOW` 或 `FAST`。
 *
 * 每顆音符每幀呼叫一次，所以裡面只能有算術 —— `rng` 是五個整數運算，比一次 `createLinearGradient`
 * 便宜兩個數量級。
 */
const phase = (b, period) => (b.t / period + rng(b.seed)() * SPREAD) % 1;

/**
 * 階梯式關鍵影格：`table` 是 `[[相位, 值], ...]`，回傳最後一個相位不大於 `p` 的值。
 *
 * 對應 CSS 的 `animation-timing-function: steps(1)` —— 電光的不規則閃爍與故障的錯位都是
 * 「跳到下一格」而不是「平滑補間」，用 `sin` 做出來的是呼吸不是故障。`table` 必須依相位遞增，
 * 而且第一項的相位要是 `0`。
 */
function stepAt(table, p) {
  let v = table[table.length - 1][1];
  for (const [at, x] of table) {
    if (p < at) break;
    v = x;
  }
  return v;
}

/** 只有下緣圓角的矩形，供卡通鍵盤使用。 */
export function keyPath(ctx, x, y, w, h, r) {
  const rr = Math.max(0, Math.min(r, w / 2, h));
  ctx.beginPath();
  ctx.moveTo(x, y);
  ctx.lineTo(x + w, y);
  ctx.lineTo(x + w, y + h - rr);
  ctx.arcTo(x + w, y + h, x + w - rr, y + h, rr);
  ctx.lineTo(x + rr, y + h);
  ctx.arcTo(x, y + h, x, y + h - rr, rr);
  ctx.closePath();
}

/**
 * 切角矩形：四個角各切掉一道 45° 的斜邊。
 *
 * 冰晶用它而不是 `capsule`，因為**圓角是磨出來的，而冰是劈開的**。切角的斜邊在視覺上等同一
 * 道解理面 —— 光是換掉這個路徑，同一組漸層就從果凍變成礦石。
 *
 * `k` 會被夾在 `w/2` 與 `h/2` 之內：黑鍵只有白鍵一半寬，切角大過半寬的話四道斜邊會交叉，
 * 畫出一個沙漏形而不是音符。很短的音在 `h` 那一側有同樣的問題。
 */
export function chamfer(ctx, x, y, w, h, c) {
  const k = Math.min(c, w / 2, h / 2);
  ctx.beginPath();
  ctx.moveTo(x + k, y);
  ctx.lineTo(x + w - k, y);
  ctx.lineTo(x + w, y + k);
  ctx.lineTo(x + w, y + h - k);
  ctx.lineTo(x + w - k, y + h);
  ctx.lineTo(x + k, y + h);
  ctx.lineTo(x, y + h - k);
  ctx.lineTo(x, y + k);
  ctx.closePath();
}

// ─── 音符樣式 ───────────────────────────────────────────────────────────────

/**
 * 一顆落下中的音符。**所有座標都已經算好，樣式只負責上色。**
 *
 * @typedef {object} NoteBox
 * @property {number} x       膠囊左緣（已扣掉貼齊琴鍵用的內縮）
 * @property {number} w       膠囊寬
 * @property {number} top     **未裁切**的頂端 y。可能是負的
 * @property {number} bottom  **未裁切**的落點 y。可能在打擊線之下
 * @property {number} fullH   `bottom - top`。比例要用這個，不是 `h`
 * @property {number} y       裁切後的頂端 y —— 真正要畫的範圍
 * @property {number} h       裁切後的高度。保證 > 0
 * @property {number} r       圓角半徑（`w / 2`）
 * @property {number[]} color 軌道顏色 `[r, g, b]`
 * @property {boolean} active 這一刻正在響
 * @property {number} vel     力度 0..1
 * @property {number} u       「1080p 下的 1 像素」。**每一個像素常數都要乘它**
 * @property {number} kbTop   打擊線的 y
 * @property {number} cx      這個音落在哪個琴鍵的中心 x
 * @property {number} kw      那個琴鍵有多寬
 * @property {number} t       曲子時間，秒。**自帶動畫的樣式只能吃這個**
 * @property {number} seed    `note.seed`。要讓每顆音符相位不同就用 `rng(seed)`
 * @property {number} age     這顆音**發聲之後**過了幾秒。還沒發聲是負的，所以要配 `active` 用
 *
 * ─── 為什麼 `top`/`bottom` 與 `y`/`h` 都給 ───
 *
 * 漸層必須錨在**整根音符**上（`createLinearGradient(0, top, 0, bottom)`），否則一根長音從
 * 畫面頂端捲進來的時候，顏色分佈會隨著露出多少而變 —— 看起來像音符自己在變色。而填色只能
 * 填**露出來的那一段**，不然長音的 `fill` 面積會大到不合理。兩者是不同的東西，所以都給。
 *
 * ─── 為什麼有 `t` 與 `seed` ───
 *
 * 有幾種樣式的賣點就是它會動 —— 流光的描邊在跑、電光在閃、泡泡在浮。**時間基準只能是 `t`
 * （曲子時間），不能是牆鐘時間**：牆鐘會讓同一支譜每次匯出長得不一樣，而 seek 之後畫面會跟
 * 音訊對不上。`t` 是純函式的輸入，所以決定論仍然成立（`HIT_FX` 的 `age` 早就是同一件事）。
 *
 * `seed` 是拿來**錯開相位**的。整幀所有音符共用同一個 `t`，直接用的話畫面會在同一瞬間一起
 * 閃 —— 那看起來像燈牌，不像特效。而且 `seed` 是排序後的**連續索引**，不打散就直接當相位的
 * 話會變成一道由低音掃到高音的線性波，比同步更假。所以一律走 `rng(seed)`。
 *
 * `age` 是給**觸發式**的效果用的，跟 `t` 分工：`t` 驅動一直在跑的循環（流光、電光），`age`
 * 驅動「從觸鍵那一刻開始、然後衰減掉」的一次性動作（泡泡的落地彈動、光暈的斷電）。這跟
 * `HitBox.age` 是
 * 同一個概念，命名也刻意一樣。
 *
 * 用 `age` 的效果**必須寫成封閉解，不能逐幀積分** —— 積分的話 30fps 與 60fps 會彈出兩種形狀，
 * 而那正是 `HIT_FX` 的噴發刻意不做空氣阻力的同一個理由。
 */

/** 像素樣式的格線有多大（會再乘 u）。 */
const PIXEL_GRID = 3;

/** 像素樣式由上到下分幾階明暗。 */
const PIXEL_BANDS = 4;

/**
 * 電光的閃爍表：`[相位, 光暈強度]`。直接抄原型 `elec-flicker` 的關鍵影格 —— **那組不平均的間
 * 隔就是它看起來像壞掉的電線、而不是像心跳的全部原因**，把它平均化之後它就只是在呼吸。
 */
const ELECTRIC_STEPS = [
  [0.00, 0.55], [0.08, 1.00], [0.12, 0.30],
  [0.30, 0.80], [0.34, 0.45],
  [0.62, 1.00], [0.66, 0.50],
];

/**
 * 電光**落下中**的閃爍表。跟上面那張是兩件事：
 *
 * 觸鍵那張走 `FAST`（1.2 秒）而且到處都在閃 —— 那是「正在通電」。這一張走 `SLOW`（2.4 秒），
 * 而且**八成九的時間是安靜的**：從 0 到 0.55 完全不動，接著在 0.55～0.66 這 0.26 秒之內連著
 * 放三下，然後又安靜到週期結束。
 *
 * 為什麼是「一串」而不是「一下」：真實的電弧不會只跳一次，它會在極短時間內連續打幾下再熄。
 * 單獨一下讀起來像閃光燈，連著三下才像放電。
 *
 * 為什麼要有長靜默：每顆音符的相位由 `rng(seed)` 打散，所以任何一刻大約只有一成的音符在閃。
 * 沒有靜默的話滿畫面都在動，那是雜訊；靜默夠長，閃的那幾顆才會被看見。
 */
const ELECTRIC_IDLE = [
  [0.000, 0.42],
  [0.550, 1.00], [0.575, 0.45],
  [0.600, 0.90], [0.615, 0.40],
  [0.640, 0.75], [0.660, 0.42],
];

/**
 * 泡泡的落地彈動：頻率（Hz）、衰減、橫向幅度。
 *
 * **這是一次性的觸發，不是循環** —— 以觸鍵那一刻為起點，來回幾下之後被 `exp` 衰減掉，約 0.3
 * 秒收乾淨。所以它吃 `age` 不吃 `t`，週期也不必是 2.4 的因數（縮圖裡音符每一輪重新落下，彈動
 * 自然跟著重播）。
 *
 * **只有橫向。** 縱向一格都不能動 —— 音符的高度就是它的長度，縮放它等於在說謊。
 *
 * ─── 幅度為什麼是 0.45，而不是「剛好不超出琴鍵」的 0.16 ───
 *
 * 0.16 是「撐開之後仍然壓在自己那一鍵上」的上限，量出來的：最吃緊的黑鍵（midi 22，音符寬
 * 17.4px）每側只有 2.75px 餘裕。但**那個幅度小到看不出來** —— 一顆 17px 寬的泡泡撐開 1.5px，
 * 在 1080p 的畫面上等於沒發生。
 *
 * 所以這裡刻意放棄那條界線：撐到最寬時會蓋過鍵緣，甚至碰到相鄰音符。可以這樣做，是因為**音
 * 高的資訊不是靠寬度傳遞的，是靠中心位置** —— 而中心一格都沒動（`xx` 是對稱撐開的）。彈動只
 * 有 0.5 秒，而那 0.5 秒裡使用者在看的是「這顆音打到了」，不是「它壓在哪一鍵上」。
 *
 * 頻率與衰減也一起放慢了（5Hz/7 → 4.5Hz/5）：原本 0.3 秒就收乾淨，短音還沒看清楚就結束了。
 * 現在大約 0.5 秒、看得到兩到三次來回。
 */
/**
 * 霓虹「被點亮」那一下的衰減。跟泡泡的彈動一樣吃 `age`、一樣是封閉解，但沒有來回 —— 通電是
 * 單向的：一下閃到最亮，然後落回穩定的點亮狀態。所以只有 `exp`，沒有 `cos`。
 *
 * 9 大約是 0.25 秒收乾淨。再慢就不像「啪一聲亮起來」，像調光旋鈕。
 */
const NEON_FLARE = 9;

/**
 * 光暈的三圈外光：`[blur（會再乘 u）, 光暈的 alpha]`，由外而內、由淡而濃。
 *
 * 對應原型的 `0 0 6px c, 0 0 14px c, 0 0 30px c@60%`，但**尺度放大了約 1.6 倍** —— 原型那三個
 * 數字是對一顆 28px 寬的示意方塊講的，而 1080p 的白鍵有三十幾像素寬，照抄的話三圈會擠成貼著
 * 邊的一圈。
 *
 * 三圈都是同一個 `capsule` 只換 `shadowBlur`：canvas 的陰影本來就沿著形狀外緣散開，所以「多層
 * 光暈」在這裡不必畫多個形狀 —— 代價是三次 `shadowBlur`，而那是這支檔案裡最貴的操作。
 *
 * **這幾個 alpha 只有配上加色合成才成立**（見 `draw` 裡那段）。在 `source-over` 底下三圈是互相
 * 蓋，不是相加，同一組數字畫出來的是一圈幾乎看不見的暈邊。
 */
const GLOW_HALOS = [[64, 0.55], [30, 0.75], [13, 0.95]];

/** 光暈落下中的亮度，以及觸鍵時琴鍵 flare 的衰減。 */
const GLOW_IDLE = 0.67;
const GLOW_FLARE = 9;

/**
 * 流光有幾段亮弧。**2 是照原型來的** —— `conic-gradient` 的色標在 0% 與 50% 各有一個亮點，
 * 也就是兩個相隔 180° 的弧。改成 1 會變成一顆繞圈的球，改成 4 以上在窄音符上會連成一整圈。
 */
const FLOW_LOBES = 2;

/**
 * 流光每個**暗缺口**的疊法：`[佔一段的比例, 疊上去的暗度]`，由寬而淡到窄而濃。
 *
 * ─── 為什麼是暗的在動，不是亮的 ───
 *
 * 把原型的 `conic-gradient` 色標展開算過：`c(0%) → transparent(30%) → c(50%) →
 * transparent(80%) → c(100%)`，而 conic 是**平滑內插**的，所以繞一圈的 alpha 是
 *
 *   0% → 1.0 ‧ 15% → 0.5 ‧ 30% → 0 ‧ 40% → 0.5 ‧ 50% → 1.0 ‧ 65% → 0.5 ‧ 80% → 0 ‧ 90% → 0.5
 *
 * **完全透明的只有 30% 與 80% 那兩個「點」，不是兩段弧。** 平均 alpha 剛好 0.5，而 alpha
 * 大於 0.2 的部分佔了八成 —— 也就是「整圈幾乎都亮著，兩個暗缺口在繞」。
 *
 * 第一版做反了（暗環 ＋ 兩道亮彗星），亮的部分只佔兩三成。
 *
 * 四道**同心**（都以 `FLOW_NOTCH_AT` 為中心），寬而淡的在外、窄而濃的在內 —— 疊起來就是一個
 * 雙邊的凹陷。第一版只做單邊斜坡（尾端對齊），算出來平均 alpha 是 0.70，比原型的 0.50 亮太多：
 * 原型的凹陷橫跨整段，只有兩個「瞬間」的亮峰，所以最寬那道要幾乎鋪滿一整段。
 *
 * 疊出來的平均 alpha 是 0.51，跟原型的 0.50 對得上。
 *
 * `setLineDash` 本身只給得出硬邊，疊四道是用硬邊逼近那條三角波的辦法。
 */
const FLOW_NOTCH = [[0.90, 0.20], [0.66, 0.32], [0.40, 0.45], [0.17, 0.90]];

/**
 * 凹陷的中心落在一段的哪裡。0.53 而不是 0.5 是照原型的不對稱來的 —— 從亮峰滑到暗點要走 30%，
 * 從暗點爬回亮峰只要 20%。（不能再往後推：最寬那道有 0.90 段長，中心太靠後會讓它超出這一段。）
 */
const FLOW_NOTCH_AT = 0.53;

const BOUNCE_HZ = 4.5;
const BOUNCE_DECAY = 5;
const BOUNCE_W = 0.45;

/**
 * 冰晶的切角有多大（會再乘 u，另外夾 `w` 的比例）。
 *
 * **從 7 降到 4，而那是被「正八角形」這個症狀逼出來的。** 1080p 的白鍵扣掉貼齊琴鍵用的內縮之後
 * 只剩二十出頭像素，7u 的切角每一邊都吃掉三成寬 —— 四道斜邊長得跟四道直邊差不多，整顆音符就讀
 * 成一個正八角形，而不是「一塊被劈過的冰」。切角要小到只像一道倒角，稜線才回得到主角的位置。
 */
const FROST_CUT = 4;

/**
 * 寒氣有幾縷。三縷是「看起來是連續在流」與「數得出來是幾團」之間的那一格 —— 兩縷會露出明顯的
 * 空檔，四縷以上在一顆音符的寬度裡會糊成一條白柱。
 */
const FROST_MIST = 3;

/** 一縷寒氣從凝出來到散掉要幾秒。 */
const FROST_FALL = 1.1;

/** 一縷寒氣的行程有多長（會再乘 u）。**終點固定在打擊線上**，理由寫在 `draw` 裡。 */
const FROST_DROP = 46;

/** 碰到打擊線那一刻先凍住多高（會再乘 u）。沒有它的話霜線是從零開始長的，第一幀看不到東西。 */
const FROST_BITE = 30;

/**
 * 霜往上長的速度，u/秒。**是速度不是「幾秒凍完一根」**，而那個差別是整件事的重點：
 *
 * 「幾秒凍完」的寫法會讓長音的霜線飛快掃過去 —— 一根四秒的音要在同樣的時間裡凍完，霜線的速度
 * 就得是短音的好幾倍，看起來是一道閃光，不是結霜。固定速度的意思是**長音本來就要凍比較久**，
 * 而那正是「整條慢慢凍起來」要的感覺。
 *
 * 620 大約是落下速度（`pps` ＝ `kbTop / 2.5`）的兩倍。兩者都跟畫面短邊成正比，所以這個比例在
 * 每一種解析度下都一樣 —— 換算下來，一顆音大約在自己長度的三分之一時間內凍滿，跟它多長無關。
 */
const FROST_SPEED = 620;

/** 霜線本身的羽化帶有多寬（會再乘 u）。羽化帶之後是**均勻**的霜，不是一路淡到底。 */
const FROST_EDGE = 40;

/** 從落點端往上刺的冰針有幾根。 */
const FROST_SPIKE = 5;

/**
 * 冰針最長多高（會再乘 u）。**跟 `fullH` 無關**：一根三百像素的冰針不是冰，是一條白線。長音變
 * 的是霜爬多高，不是霜的顆粒變大。
 */
const FROST_SPIKE_LEN = 60;

/**
 * 故障的錯位表：`[相位, 錯位 | null]`。`dx` 是整顆音符的橫向抖動（單位 `u`），`r`／`c` 是紅、青
 * 兩個色版的 `[dx, dy, 起點, 終點]` —— 起點與終點是 `fullH` 的比例，也就是「切哪一段橫條」。
 *
 * 前 85% 是安靜空窗，最後 15% 集中三次 3% 的短閃；再配合 `GLITCH_SHARE`，畫面不會一直抖。
 *
 * ─── 切片要短，位移要大 ───
 *
 * 第一版每片切 `fullH` 的 35%，兩片就蓋掉七成的音符 —— 那不是「訊號破了一小塊」，那是整顆音符
 * 換了配色。現在每片只有 7～10%，兩片加起來不到兩成。
 *
 * 位移放大到 ±9（原本 ±3），而且刻意**偏左** —— 原型的 `translate(-3px,-2px)` 就是往左上甩。
 * 搭配 `draw` 裡拿掉的裁切，那一小條會短暫突出到自己的琴鍵之外，那是「訊號跑掉了」最直接的讀法。
 */
const GLITCH_STEPS = [
  [0.00, null],
  [0.85, { dx:  1, r: [-9, -1, 0.22, 0.32], c: [ 4,  1, 0.55, 0.62] }],
  [0.88, null],
  [0.91, { dx: -1, r: [ 5,  1, 0.62, 0.70], c: [-7,  0, 0.30, 0.38] }],
  [0.94, null],
  [0.97, { dx:  0, r: [-6, -1, 0.44, 0.51], c: [ 3, -1, 0.12, 0.19] }],
];

/** 只有三分之一的音符會故障；每顆的選取對 seed 固定。 */
const GLITCH_SHARE = 1 / 3;

/** 卡通音符與專屬鍵盤共用的平塗色票。 */
const TOON = {
  ink: "#14141c",
  bed: "#241f3d",
  white: "#f7f2e0",
  black: "#332f4e",
  blackTop: "#4a4668",
  line: "#e8556d",
};
const TOON_FOOT = 9;
const TOON_GLINT = 26;

/**
 * `composite` 是**每一層設一次**（waterfall.js 在迴圈外設），不是每顆音符設一次。
 *
 * `lighter`（加法混色）是玻璃與霓虹的前提：光暈疊在一起才會亮。但**實心的畫法在 `lighter`
 * 底下會失真** —— 不透明的色塊加上背景漸層之後就不是原本那個顏色了，而「像素」這種樣式的
 * 賣點正好是「顏色是準的」。所以它自己宣告 `source-over`。
 */
export const NOTE_STYLES = [
  {
    // ── 玻璃：預設，也是這個功能出生時的樣子 ──
    //
    // 管身漸層 ＋ 內芯 ＋ 左緣反光 ＋ 尾端透光 ＋ 描邊。厚、亮、飽和。
    // **這一項的輸出必須逐項等於重構之前**，所以改它之前先想清楚。
    id: "glass",
    composite: "lighter",
    draw(ctx, b) {
      const { x, w, y, h, r, top, bottom, fullH, color: c, active, u, kbTop, cx, kw } = b;
      const tip = mixWhite(c, active ? 0.85 : 0.65);
      const lite = mixWhite(c, 0.45);

      ctx.shadowColor = rgba(c, active ? 0.85 : 0.45);
      ctx.shadowBlur = (active ? 26 : 14) * u;

      const grad = ctx.createLinearGradient(0, top, 0, bottom);
      grad.addColorStop(0.00, rgba(c, active ? 0.10 : 0.05));
      grad.addColorStop(0.35, rgba(c, active ? 0.42 : 0.28));
      grad.addColorStop(0.80, rgba(lite, active ? 0.72 : 0.52));
      grad.addColorStop(1.00, rgba(tip, active ? 0.95 : 0.80));
      ctx.fillStyle = grad;
      capsule(ctx, x, y, w, h, r);
      ctx.fill();
      ctx.shadowBlur = 0;

      // ── 玻璃質感，裁在膠囊內 ──
      ctx.save();
      capsule(ctx, x, y, w, h, r);
      ctx.clip();

      // 內芯光管：管中有管的厚度
      const coreW = Math.max(2 * u, w * 0.40);
      const coreGrad = ctx.createLinearGradient(0, top, 0, bottom);
      coreGrad.addColorStop(0.00, "rgba(255,255,255,0)");
      coreGrad.addColorStop(0.55, rgba(lite, active ? 0.30 : 0.14));
      coreGrad.addColorStop(1.00, `rgba(255,255,255,${active ? 0.60 : 0.32})`);
      ctx.fillStyle = coreGrad;
      capsule(ctx, x + (w - coreW) / 2, y + 2 * u, coreW,
        Math.max(0, h - 4 * u), coreW / 2);
      ctx.fill();

      // 左緣鏡面反光帶
      const sheen = ctx.createLinearGradient(x, 0, x + w, 0);
      sheen.addColorStop(0.06, `rgba(255,255,255,${active ? 0.30 : 0.17})`);
      sheen.addColorStop(0.32, "rgba(255,255,255,0)");
      sheen.addColorStop(0.86, "rgba(255,255,255,0)");
      sheen.addColorStop(1.00, `rgba(255,255,255,${active ? 0.10 : 0.05})`);
      ctx.fillStyle = sheen;
      ctx.fillRect(x, y, w, h);

      // 尾端徑向透光：光從落點端往音符內部透出
      const tipR = Math.max(w * 1.6, 18 * u);
      const tg = ctx.createRadialGradient(x + w / 2, bottom, u, x + w / 2, bottom, tipR);
      tg.addColorStop(0, `rgba(255,255,255,${active ? 0.85 : 0.45})`);
      tg.addColorStop(0.45, rgba(tip, active ? 0.35 : 0.18));
      tg.addColorStop(1, "rgba(255,255,255,0)");
      ctx.fillStyle = tg;
      ctx.fillRect(x, bottom - tipR, w, tipR);

      // 頂端冷色暗緣。`lighter` 底下畫不出暗色，所以這一筆要切回 source-over。
      ctx.globalCompositeOperation = "source-over";
      const capH = Math.min(14 * u, fullH * 0.3);
      const cap = ctx.createLinearGradient(0, top, 0, top + capH);
      cap.addColorStop(0, "rgba(10,16,34,0.30)");
      cap.addColorStop(1, "rgba(10,16,34,0)");
      ctx.fillStyle = cap;
      ctx.fillRect(x, y, w, capH);
      ctx.globalCompositeOperation = "lighter";

      ctx.restore();

      // 輪廓：把膠囊從背景裡收出來
      ctx.strokeStyle = rgba(lite, active ? 0.55 : 0.26);
      ctx.lineWidth = u;
      capsule(ctx, x + u / 2, y + u / 2, w - u, Math.max(0, h - u), r);
      ctx.stroke();

      // 觸底時打擊線上的光斑
      if (active) {
        const rad = kw * 2.4;
        const rg = ctx.createRadialGradient(cx, kbTop, 2 * u, cx, kbTop, rad);
        rg.addColorStop(0, rgba(c, 0.5));
        rg.addColorStop(1, rgba(c, 0));
        ctx.fillStyle = rg;
        ctx.fillRect(cx - rad, kbTop - rad, rad * 2, rad);
      }
    },
  },

  {
    // ── 霓虹：落下時是一條線，觸鍵時整根被點亮 ──
    //
    // 玻璃是「一根發光的管子」，這個是「一條發光的線」。密集的譜在玻璃底下會糊成一片亮，
    // 因為每根管子都在加法混色 —— 霓虹**落下中**的管身幾乎透明，所以再密也還數得出幾根。
    //
    // ─── 觸鍵時管身整根亮起來，外面再罩一層光暈 ───
    //
    // 那是「通電」：霓虹燈管沒通電時只是一根玻璃，通了電才整根發光。所以觸鍵那一刻管身從
    // 幾乎透明（alpha 0.02）跳到 0.34～0.62，外面再加一圈比本體大一號的光暈。
    //
    // **這不違背「再密也數得出幾根」**：亮起來的永遠只有正在響的那幾顆，而那正是使用者這一刻
    // 要找的。落下中的那一大片仍然是細線。
    //
    // 點亮的瞬間多一下爆發（`NEON_FLARE`，吃 `age`，約 0.25 秒收乾淨）。**只有 `exp` 沒有
    // `cos`** —— 通電是單向的，不像泡泡落地會回彈。
    id: "neon",
    composite: "lighter",
    draw(ctx, b) {
      const { x, w, y, h, r, top, bottom, color: c, active, u, kbTop, cx, kw } = b;
      const lite = mixWhite(c, 0.55);
      const flare = active ? Math.exp(-b.age * NEON_FLARE) : 0;

      // 光暈：同一個膠囊放大一圈、低透明度、大 blur，光就沿著形狀外緣散開。**畫在管身之前**，
      // 所以它是襯在後面的一層，不會把描邊糊掉。
      if (active) {
        const pad = 3 * u;
        ctx.shadowColor = rgba(lite, 0.85);
        ctx.shadowBlur = (24 + flare * 26) * u;
        ctx.fillStyle = rgba(c, 0.1 + flare * 0.14);
        capsule(ctx, x - pad, y - pad, w + pad * 2, h + pad * 2, r + pad);
        ctx.fill();
        ctx.shadowBlur = 0;
      }

      // 管身。落下中保留一點餘光但仍是空心框；觸鍵時整根點亮。
      const grad = ctx.createLinearGradient(0, top, 0, bottom);
      grad.addColorStop(0, rgba(c, active ? 0.34 + flare * 0.28 : 0.08));
      grad.addColorStop(1, rgba(c, active ? 0.62 + flare * 0.28 : 0.20));
      ctx.fillStyle = grad;
      capsule(ctx, x, y, w, h, r);
      ctx.fill();

      // 描邊就是這個樣式的全部
      const lw = (active ? 2.6 : 2.0) * u;
      ctx.shadowColor = rgba(lite, active ? 1 : 0.95);
      ctx.shadowBlur = (active ? 24 + flare * 14 : 18) * u;
      ctx.strokeStyle = rgba(active ? mixWhite(c, 0.9) : mixWhite(c, 0.7), active ? 0.95 : 0.88);
      ctx.lineWidth = lw;
      capsule(ctx, x + lw / 2, y + lw / 2, w - lw, Math.max(0, h - lw), r);
      ctx.stroke();
      ctx.shadowBlur = 0;

      // 落點端的亮頭。裁在膠囊裡，不然長音捲進畫面時這一段會露在外面
      ctx.save();
      capsule(ctx, x, y, w, h, r);
      ctx.clip();
      const headH = 16 * u;
      const cg = ctx.createLinearGradient(0, bottom - headH, 0, bottom);
      cg.addColorStop(0, rgba(lite, 0));
      cg.addColorStop(1, `rgba(255,255,255,${active ? 0.9 : 0.62})`);
      ctx.fillStyle = cg;
      ctx.fillRect(x, bottom - headH, w, headH);
      ctx.restore();

      if (active) {
        const rad = kw * 1.9 * (1 + flare * 0.35);
        const rg = ctx.createRadialGradient(cx, kbTop, 2 * u, cx, kbTop, rad);
        rg.addColorStop(0, rgba(lite, 0.55 + flare * 0.3));
        rg.addColorStop(1, rgba(c, 0));
        ctx.fillStyle = rg;
        ctx.fillRect(cx - rad, kbTop - rad, rad * 2, rad);
      }
    },
  },

  {
    // ── 像素：硬邊、四階明暗、**一次 shadowBlur 都沒有** ──
    //
    // 這一種順便是效能的逃生門。`shadowBlur` 是 canvas 2D 最貴的操作，而玻璃每顆音符要用兩
    // 次（管身 ＋ 光暈）；六軌大譜 1080p 逐幀匯出時，選這個樣式的差別是「會不會做完」而不是
    // 「好不好看」。README 的「還沒做」有一條在講預烘焙 glow sprite —— 這是那條的一個部分解。
    //
    // ─── 只量化垂直方向 ───
    //
    // 水平位置**一格都不能動**：音符必須壓在自己的琴鍵上，那是這個畫面唯一在傳遞的資訊。
    // 量化 x 會讓相鄰的兩個半音對到同一格，看起來就是「音高畫錯了」。
    //
    // 副作用要知道：格線是 `PIXEL_GRID * u`，而 720p 預覽的 u 是 1080p 匯出的三分之二 —— 所以
    // **這一種樣式的預覽與成品，方塊的切點會略有不同**。決定論不受影響（仍是 (W,H,t) 的純函
    // 式），變的只是「所見即所得」在這一項上退化成「所見幾乎即所得」。
    id: "pixel",
    composite: "source-over",
    draw(ctx, b) {
      const { x, w, y, h, color: c, active, u, kbTop, cx, kw } = b;
      const g = PIXEL_GRID * u;
      const y0 = Math.round(y / g) * g;
      const hh = Math.max(g, Math.round((y + h) / g) * g - y0);

      // 四階明暗，由上往下變亮。**畫成 4 個 fillRect 而不是逐格** —— 一根 1080p 的長音有
      // 五百多格，逐格畫等於每幀多幾千次呼叫，而看起來完全一樣。
      for (let i = 0; i < PIXEL_BANDS; i++) {
        const b0 = y0 + Math.round((hh * i / PIXEL_BANDS) / g) * g;
        const b1 = y0 + Math.round((hh * (i + 1) / PIXEL_BANDS) / g) * g;
        if (b1 <= b0) continue;
        const k = i / (PIXEL_BANDS - 1);
        ctx.fillStyle = rgba(mixWhite(c, (active ? 0.22 : 0.04) + k * 0.48),
          active ? 1 : 0.9);
        ctx.fillRect(x, b0, w, b1 - b0);
      }

      // 頂端一格暗邊、底端一格亮邊。像素風的立體感全靠這兩條
      ctx.fillStyle = "rgba(8,12,28,0.55)";
      ctx.fillRect(x, y0, w, g);
      ctx.fillStyle = `rgba(255,255,255,${active ? 0.95 : 0.62})`;
      ctx.fillRect(x, y0 + hh - g, w, g);

      // 觸底：琴鍵正上方一塊實心亮條。**不用漸層** —— 這個樣式裡沒有柔邊
      if (active) {
        ctx.fillStyle = rgba(mixWhite(c, 0.45), 0.5);
        ctx.fillRect(cx - kw, kbTop - g * 2, kw * 2, g * 2);
      }
    },
  },

  {
    // ── 光劍：白核心 ＋ 彩色外緣 ──
    //
    // 跟霓虹剛好是對照組：霓虹把光放在**邊界**上，光劍把光放在**中心**。所以密集的譜底下光
    // 劍會比霓虹先糊成一片（中心的光彼此靠得更近），但單獨一顆音符的存在感強得多。
    id: "saber",
    composite: "lighter",
    draw(ctx, b) {
      const { x, w, y, h, r, top, bottom, fullH, color: c, active, u, kbTop, cx, kw } = b;

      // 外緣整根同一個顏色，**刻意不做漸層** —— 光劍的刃是均勻的，漸層會讓它看起來像在漏電
      ctx.shadowColor = rgba(c, active ? 0.95 : 0.6);
      ctx.shadowBlur = (active ? 24 : 13) * u;
      ctx.fillStyle = rgba(c, active ? 0.88 : 0.62);
      capsule(ctx, x, y, w, h, r);
      ctx.fill();
      ctx.shadowBlur = 0;

      // 白核心。原型是 `inset: 4px 28%`，這裡照搬成比例但要夾最小值 —— 黑鍵只有白鍵一半寬，
      // 純按比例的核心在那上面會細到看不見，而看不見白核心的光劍就只是一根霓虹。
      ctx.save();
      capsule(ctx, x, y, w, h, r);
      ctx.clip();
      const coreW = Math.max(1.5 * u, w * 0.44);
      const inset = Math.min(4 * u, fullH / 3);
      const cg = ctx.createLinearGradient(0, top, 0, bottom);
      cg.addColorStop(0, `rgba(255,255,255,${active ? 0.88 : 0.6})`);
      cg.addColorStop(1, `rgba(255,255,255,${active ? 1 : 0.82})`);
      ctx.fillStyle = cg;
      capsule(ctx, x + (w - coreW) / 2, top + inset, coreW,
        Math.max(0, fullH - inset * 2), coreW / 2);
      ctx.fill();
      ctx.restore();

      if (active) {
        const rad = kw * 2.1;
        const rg = ctx.createRadialGradient(cx, kbTop, 2 * u, cx, kbTop, rad);
        rg.addColorStop(0, "rgba(255,255,255,0.6)");
        rg.addColorStop(0.4, rgba(c, 0.4));
        rg.addColorStop(1, rgba(c, 0));
        ctx.fillStyle = rg;
        ctx.fillRect(cx - rad, kbTop - rad, rad * 2, rad);
      }
    },
  },

  {
    // ── 流光描邊：深色內芯 ＋ 一條沿著音符跑的亮帶 ──
    //
    // ─── 光是「繞著跑」的，不是「往下流」的 ───
    //
    // 原型是 `conic-gradient(from var(--spin), c, transparent 30%, c 50%, transparent 80%, c)`
    // 繞著中心轉 —— 也就是**兩個相隔 180° 的亮弧繞著邊框跑**：下去一邊、過底、上來另一邊。
    //
    // 第一版做成「一條亮帶沿著音符長度往下墜」，方向感完全不同 —— 那是流水，不是旋轉。
    //
    // 但 `conic` 本身也不能照抄：它錨在圖形中心，而一根長音可以高達整個畫面，那樣的 conic 只有
    // 兩側在動、頭尾幾乎靜止。**所以改成沿著周長跑**：`setLineDash` 把描邊切成兩段亮弧，
    // `lineDashOffset` 推著它們沿路徑前進。長音短音都成立，而且它真的在繞。
    //
    // 每個亮弧疊三道（長而暗 → 短而亮），用 `[0, lead, lit, rest]` 這種「前面補一段零長度的
    // dash」的寫法讓三道**尾端對齊** —— 於是短亮的那道在頭、長暗的拖在後面，成為一顆彗星。
    //
    // 內芯是深色，所以 `composite` 只能是 `source-over`：`lighter` 畫不出比背景暗的東西，而
    // 「亮邊框包著暗芯」的對比就是這個樣式的全部。
    id: "flowborder",
    composite: "source-over",
    draw(ctx, b) {
      const { x, w, y, h, r, top, fullH, color: c, active, u, kbTop, cx, kw } = b;
      const lw = Math.min((active ? 2.8 : 2.1) * u, w / 3);

      // 底框：**整圈都是亮的**。暗缺口是等一下疊上去的，不是這裡留白的
      ctx.fillStyle = rgba(mixWhite(c, 0.45), active ? 1 : 0.82);
      capsule(ctx, x, y, w, h, r);
      ctx.fill();

      // 內芯把中間挖回深色，剩下的那一圈就是描邊。**錨在 top/fullH 不是 y/h** —— 錨在裁切
      // 後的範圍上，長音被打擊線切掉時會在切點畫出一條假的底邊
      ctx.fillStyle = `rgba(16,24,42,${active ? 0.88 : 0.94})`;
      capsule(ctx, x + lw, top + lw, Math.max(0, w - lw * 2),
        Math.max(0, fullH - lw * 2), Math.max(0, r - lw));
      ctx.fill();

      // ── 兩個暗缺口繞著那一圈跑 ──
      //
      // 描邊的中線：外框往內縮半個線寬。周長也照這一圈算，`lineDashOffset` 才會是真的「走了
      // 多少距離」—— 用外框的周長算，亮弧的速度會比看起來的快一點點。
      const bw = Math.max(0, w - lw);
      const bh = Math.max(0, fullH - lw);
      const rr = Math.min(Math.max(0, r - lw / 2), bw / 2, bh / 2);
      const per = 2 * (bw - 2 * rr) + 2 * (bh - 2 * rr) + 2 * Math.PI * rr;
      if (per > 0) {
        const seg = per / FLOW_LOBES;
        ctx.lineWidth = lw;
        for (const [frac, a] of FLOW_NOTCH) {
          const cut = seg * frac;
          // `[0, pre, cut, post]`：先補一段零長度的 dash，暗的那一段從 `pre` 開始。四道的
          // **中心**都落在 `FLOW_NOTCH_AT`，所以是同心的凹陷而不是單邊斜坡。
          // `pre` 夾在 `[0, seg - cut]` 內，而 `post` 由減法補回 —— 三段加起來永遠等於 `seg`，
          // 不然圖樣的週期會跑掉，兩個缺口就不再相隔 180°。
          const pre = Math.max(0, Math.min(seg - cut, seg * FLOW_NOTCH_AT - cut / 2));
          ctx.setLineDash([0, pre, cut, seg - pre - cut]);
          ctx.lineDashOffset = -phase(b, SLOW) * per;
          // 疊的是**暗色**，跟內芯同一個色 —— 缺口要讀成「這一段邊框不見了」，而不是「這一段
          // 變成另一個顏色」
          ctx.strokeStyle = `rgba(16,24,42,${a})`;
          capsule(ctx, x + lw / 2, top + lw / 2, bw, bh, rr);
          ctx.stroke();
        }
        ctx.setLineDash([]);
        ctx.lineDashOffset = 0;
      }

      if (active) {
        const rad = kw * 1.8;
        const rg = ctx.createRadialGradient(cx, kbTop, 2 * u, cx, kbTop, rad);
        rg.addColorStop(0, rgba(mixWhite(c, 0.7), 0.5));
        rg.addColorStop(1, rgba(c, 0));
        ctx.fillStyle = rg;
        ctx.fillRect(cx - rad, kbTop - rad, rad * 2, rad);
      }
    },
  },

  {
    // ── 光暈：落下中維持三分之二亮度，觸鍵全亮並在琴鍵爆出 flare ──
    // 本體仍用 source-over 保住軌道色；只有多層外光與琴鍵 flare 局部借用 lighter。
    id: "glow",
    composite: "source-over",
    draw(ctx, b) {
      const { x, w, y, h, r, bottom, color: c, active, u, kbTop, cx, kw } = b;
      const pw = active ? 1 : GLOW_IDLE;
      const flare = active ? Math.exp(-b.age * GLOW_FLARE) : 0;
      // 原型的 `border-radius: 6px`：圓的一點點，但還是一根燈管，不是藥丸
      const rr = Math.min(r, 6 * u);
      // 核心：滿電是加了白的亮色，沒電沉到接近全黑 —— 但**留一點軌道色**，暗掉的音符仍然要看
      // 得出是哪一軌
      const core = mixBlack(mixWhite(c, 0.30 * pw), 0.30 * (1 - pw));

      // ─── 多層外光暈 ───
      //
      // **這三圈跑在 `lighter` 底下，畫完手動切回 `source-over`。** 光要相加才會亮：source-over
      // 底下後畫的那圈會把前一圈**蓋掉**，三層疊完比一層還暗 —— 那正是「光散不出去」的樣子。
      // 本體仍然是 source-over（沒電要畫得出比背景暗的東西），所以這裡是**局部**借用加色。
      //
      // **填色一定要不透明。** canvas 的陰影是來源形狀 alpha 的模糊複本，所以陰影的濃度會被
      // 來源的 alpha 乘掉一次 —— 用 `rgba(core, 0.16)` 去填，最外圈只剩下 0.38×0.16 ≈ 0.06，
      // 那個數字在 50u 的模糊上攤開之後等於沒有。填不透明的色不會弄髒本體：下面那一筆核心用
      // 同一條路徑蓋回去。
      //
      // 只畫在還有電的音符上，所以正在響的那幾顆連 `shadowBlur` 都不用付。代價要講清楚：
      // 落下中的**每一顆**音符都要付三次 `shadowBlur`，而那是這支檔案裡最貴的操作 —— 這一種
      // 大約是玻璃的三倍。大譜 1080p 匯出想省時間，逃生門仍然是像素／卡通／復古那幾種。
      ctx.globalCompositeOperation = "lighter";
      for (const [blur, alpha] of GLOW_HALOS) {
        ctx.shadowColor = rgba(mixWhite(c, 0.15), alpha * pw);
        ctx.shadowBlur = blur * u * (0.4 + pw * 0.6);
        ctx.fillStyle = rgba(c, 1);
        capsule(ctx, x, y, w, h, rr);
        ctx.fill();
      }
      ctx.shadowBlur = 0;
      ctx.globalCompositeOperation = "source-over";

      ctx.fillStyle = rgba(core, 1);
      capsule(ctx, x, y, w, h, rr);
      ctx.fill();

      // 內緣的亮邊。滿電時它跟核心一起亮到發白，沒電就只剩一條幾乎看不見的描邊 —— 那條描邊是
      // 「這裡還有一根管子」的唯一證據
      const lw = Math.max(u, Math.min(1.6 * u, w * 0.12));
      ctx.strokeStyle = rgba(mixWhite(c, 0.55), 0.12 + 0.68 * pw);
      ctx.lineWidth = lw;
      capsule(ctx, x + lw / 2, y + lw / 2, Math.max(0, w - lw), Math.max(0, h - lw), rr);
      ctx.stroke();

      // 落點端的亮頭，裁在本體裡 —— 不然長音捲進畫面時這一段會露在外面
      ctx.save();
      capsule(ctx, x, y, w, h, rr);
      ctx.clip();
      const headH = 14 * u;
      const hg = ctx.createLinearGradient(0, bottom - headH, 0, bottom);
      hg.addColorStop(0, "rgba(255,255,255,0)");
      hg.addColorStop(1, `rgba(255,255,255,${0.55 * pw})`);
      ctx.fillStyle = hg;
      ctx.fillRect(x, bottom - headH, w, headH);
      ctx.restore();

      if (active) {
        ctx.globalCompositeOperation = "lighter";
        const rad = kw * 1.9 * (1 + flare * 0.35);
        const rg = ctx.createRadialGradient(cx, kbTop, 2 * u, cx, kbTop, rad);
        rg.addColorStop(0, rgba(mixWhite(c, 0.55), 0.55 + flare * 0.3));
        rg.addColorStop(1, rgba(c, 0));
        ctx.fillStyle = rg;
        ctx.fillRect(cx - rad, kbTop - rad, rad * 2, rad);
        ctx.globalCompositeOperation = "source-over";
      }
    },
  },

  {
    // ── 電光：直角的燈管，觸鍵才放電 ──
    //
    // **落下中與觸鍵時各走一張表。** 落下中偶爾放一串電（`ELECTRIC_IDLE`，八成九的時間是安靜
    // 的），觸到打擊線才轉成連續的不規則放電（`ELECTRIC_STEPS`）。
    //
    // 中間值是調過的：全程照觸鍵那張閃，滿畫面的音符各自亂閃會變成雜訊，而且把視線從打擊線拉
    // 走；完全不閃又沒有電感。長靜默 ＋ 短促一串，配上 `rng(seed)` 打散的相位，任何一刻大約只
    // 有一成的音符在閃 —— 看得到電，但看得到的仍然是打擊線。
    //
    // 兩張表都走 `stepAt` 的階梯而不是 `sin`：**平滑補間做出來的是呼吸，不是放電**。觸鍵那張
    // 的相位直接抄原型的 `elec-flicker` 關鍵影格（8/12/30/34/62/66%），那組不平均的間隔正是它
    // 看起來像壞掉的電線而不是像心跳的原因。
    //
    // 直角而不是圓角：燈管的兩端是切齊的，圓角會讓它變成藥丸。沒有圓角也就不需要路徑 ——
    // 整根音符一次 `fillRect` 畫完，白芯也是，所以這一種連 `save`/`clip`/`restore` 都省了。
    id: "electric",
    composite: "lighter",
    draw(ctx, b) {
      const { x, w, y, h, top, bottom, color: c, active, u, kbTop, cx, kw } = b;
      const k = active
        ? stepAt(ELECTRIC_STEPS, phase(b, FAST))
        : stepAt(ELECTRIC_IDLE, phase(b, SLOW));
      const lite = mixWhite(c, 0.8);

      // 管身：上淺下深，原型的 `#d9fbff → #37c8ff → #0a86d4`。三段都從軌道色長出來
      const g = ctx.createLinearGradient(0, top, 0, bottom);
      g.addColorStop(0.0, rgba(mixWhite(c, 0.88), active ? 0.95 : 0.66));
      g.addColorStop(0.3, rgba(lite, active ? 0.85 : 0.55));
      g.addColorStop(1.0, rgba(mixBlack(c, 0.25), active ? 0.8 : 0.5));
      ctx.fillStyle = g;
      ctx.shadowColor = rgba(lite, Math.min(1, (active ? 0.9 : 0.62) * k));
      // 落下中的峰值刻意只有觸鍵的一半上下 —— 兩者要分得出來，不然「碰到鍵了」就沒有份量
      ctx.shadowBlur = (active ? 26 : 14) * k * u;
      ctx.fillRect(x, y, w, h);
      ctx.shadowBlur = 0;

      // 閃到最亮的那幾格補一條白芯 —— 光暈變強但管身不變的話，看起來是外面在閃、裡面沒事
      if (active && k > 0.9) {
        const coreW = Math.max(u, w * 0.3);
        ctx.fillStyle = "rgba(255,255,255,0.5)";
        ctx.fillRect(x + (w - coreW) / 2, y, coreW, h);
      }

      if (active) {
        const rad = kw * 2.2 * (0.7 + k * 0.3);
        const rg = ctx.createRadialGradient(cx, kbTop, 2 * u, cx, kbTop, rad);
        rg.addColorStop(0, rgba(mixWhite(c, 0.9), 0.55 * k));
        rg.addColorStop(1, rgba(c, 0));
        ctx.fillStyle = rg;
        ctx.fillRect(cx - rad, kbTop - rad, rad * 2, rad);
      }
    },
  },

  {
    // ── 冰晶：切角的冰塊，落到鍵盤才結霜 ──
    //
    // **圓角換成切角**（`chamfer`）：圓角是磨出來的，而冰是劈開的 —— 換掉路徑就足以讓同一組
    // 漸層從果凍變成礦石。
    //
    // **顏色只在觸鍵那一刻變。** 落下時是一塊安靜的半透明冰，還帶著軌道色；碰到打擊線才整顆
    // 泛白、稜線亮起、白煙往下淌。「結霜」是一個發生在某一瞬間的事件，而一直在呼吸的冰看起來
    // 只是在發光 —— 所以呼吸也綁在 `active` 上，落下中的音符一動都不動。
    //
    // **觸鍵時真正在講話的是那幾縷寒氣，不是泛白。** 泛白與呼吸只是「這一顆變亮了」，跟其他樣
    // 式的觸鍵沒有差別；而白煙往下沉是冰**獨有**的物理，看到煙才會讀成「凍住了」而不是「亮了」。
    //
    // ─── 結霜長在音符身上，不是罩在鍵盤上 ───
    //
    // 這一種**不畫琴鍵上的圓形光暈**，而其他每一種觸鍵時都畫。那個光暈是「這裡發生了什麼事」的
    // 通用寫法，十二種樣式做的是同一件事；更要命的是它畫在音符**外面**，看起來像音符底下擺了一
    // 盞燈，而不像音符被凍住 —— 燈跟冰是兩回事。
    //
    // 改成畫在音符自己身上：碰到打擊線的那一點開始，霜往上爬（`FROST_GROW` / `FROST_REACH`），
    // 爬過的地方泛白、長出冰針。**「凍住」是一個從接觸點蔓延開的過程，而那個過程只能發生在被凍
    // 的那個東西身上。** 鍵盤那一側的回饋交給 `HIT_FX`，那本來就是它的工作（光暈也是這樣做的）。
    //
    // 這一種**必須是 `source-over`**：冰的賣點是「看得到後面」，而 `lighter` 底下半透明會變成
    // 加亮，透不出背景反而更實心。
    id: "frost",
    composite: "source-over",
    draw(ctx, b) {
      const { x, w, y, h, top, bottom, fullH, color: c, active, u, kbTop, cx } = b;
      const cut = Math.min(w * 0.18, FROST_CUT * u);
      // 呼吸只在觸鍵時跑。落下中固定為 0，所以整顆音符是靜止的
      const breath = active ? 0.5 + 0.5 * Math.sin(2 * Math.PI * phase(b, SLOW)) : 0;
      // 結霜的程度：落下是 0（保留軌道色），觸鍵是 0.30～0.50。
      //
      // **這個數字往下調過**（原本 0.55～0.85）：整顆音符在觸鍵那一幀就全白的話，後面那條往上
      // 掃的霜線就沒有東西可以掃了 —— 已經凍過的與還沒凍到的分不出來，看起來只是「亮了一下」。
      // 現在整根的泛白只負責「這一顆在響」，「凍到哪裡了」交給霜線。
      const ice = active ? 0.30 + breath * 0.2 : 0;
      const body = mixWhite(c, 0.3 + ice * 0.5);
      const pale = mixWhite(c, 0.72);

      const g = ctx.createLinearGradient(0, top, 0, bottom);
      g.addColorStop(0, rgba(mixWhite(body, 0.25), active ? 0.92 : 0.58));
      g.addColorStop(1, rgba(body, active ? 0.78 : 0.4));
      ctx.fillStyle = g;
      ctx.shadowColor = rgba(pale, active ? 0.35 + breath * 0.4 : 0);
      ctx.shadowBlur = active ? (10 + breath * 16) * u : 0;
      chamfer(ctx, x, y, w, h, cut);
      ctx.fill();
      ctx.shadowBlur = 0;

      ctx.save();
      chamfer(ctx, x, y, w, h, cut);
      ctx.clip();

      // 兩道冰裂稜線。原型的 55° 與 125° 是對一個小方塊而言 —— 音符是細長的，照抄角度會變成
      // 兩條幾乎水平的線。這裡改成沿著音符長度斜切，用 `fullH` 的比例定位，長音短音都有兩道。
      //
      // **落下時只是隱約的紋路，觸鍵才變成白色的裂痕** —— 那一下才是「凍住了」。
      const lwx = Math.max(u, w * 0.09);
      ctx.strokeStyle = `rgba(255,255,255,${0.18 + ice * 0.55})`;
      ctx.lineWidth = lwx;
      for (const [at, dir] of [[0.34, 1], [0.68, -1]]) {
        const my = top + fullH * at;
        ctx.beginPath();
        ctx.moveTo(x, my - fullH * 0.06 * dir);
        ctx.lineTo(x + w, my + fullH * 0.06 * dir);
        ctx.stroke();
      }

      // 內緣霜白
      ctx.strokeStyle = `rgba(255,255,255,${0.16 + ice * 0.45})`;
      ctx.lineWidth = 2 * u;
      chamfer(ctx, x + u, y + u, Math.max(0, w - 2 * u), Math.max(0, h - 2 * u), cut);
      ctx.stroke();

      // ─── 霜從落點端往上長，長到整根凍完 ───
      //
      // **錨在 `kbTop` 不是音符底端。** 觸鍵中的音符仍然在往下走，`bottom` 已經跑到打擊線底下
      // 了 —— 錨在那裡的話霜會跟著音符一起往下滑出畫面，而霜是長在「碰到鍵的那一點」上的，那
      // 一點不會動。上限夾 `fullH`（整根的長度），所以霜最多就是把這一根凍滿。
      //
      // **霜線之後是均勻的霜，不是一路淡到底。** 一條橫跨整根的線性漸層在長音上只有最底下看得
      // 出白色，讀起來是「底部有點亮」；要讀成「這一段已經凍過了」，凍過的地方就得一樣白，而
      // 變化只發生在霜線那一條羽化帶上。三個色標就是在講這件事。
      if (active) {
        const reach = Math.min(fullH, (FROST_BITE + FROST_SPEED * b.age) * u);
        const fy = kbTop - reach;
        const a = 0.42 + breath * 0.18;
        const fg = ctx.createLinearGradient(0, fy, 0, kbTop);
        fg.addColorStop(0, "rgba(240,250,255,0)");
        fg.addColorStop(Math.min(FROST_EDGE * u, reach * 0.8) / reach, `rgba(240,250,255,${a})`);
        fg.addColorStop(1, `rgba(240,250,255,${a})`);
        ctx.fillStyle = fg;
        ctx.fillRect(x, fy, w, reach);

        // 冰針：從落點端往上刺的短硬線。**硬邊、不模糊** —— 柔邊的話它只是另一道光暈。
        // 位置與長短走 `rng(seed)`，所以同一顆音每次匯出都是同一叢；種子錯開一點，才不會跟
        // 寒氣那幾縷用到同一串數，那會讓煙剛好從冰針的位置吐出來
        const spike = Math.min(reach, FROST_SPIKE_LEN * u);
        const rs = rng(b.seed ^ 0x5f);
        ctx.strokeStyle = `rgba(255,255,255,${0.45 + breath * 0.3})`;
        ctx.lineWidth = Math.max(u, w * 0.07);
        for (let i = 0; i < FROST_SPIKE; i++) {
          const sx = x + w * (0.12 + 0.76 * rs());
          const len = spike * (0.3 + 0.6 * rs());
          const lean = (rs() - 0.5) * w * 0.3;
          ctx.beginPath();
          ctx.moveTo(sx, kbTop);
          ctx.lineTo(sx + lean, kbTop - len);
          ctx.stroke();
        }
      }
      ctx.restore();

      // 外框：冰的邊緣是硬的，這一條讓那八道邊從背景裡切出來
      ctx.strokeStyle = `rgba(255,255,255,${active ? 0.85 : 0.4})`;
      ctx.lineWidth = u;
      chamfer(ctx, x + u / 2, y + u / 2, Math.max(0, w - u), Math.max(0, h - u), cut);
      ctx.stroke();

      if (active) {
        // ─── 寒氣：白煙沿著音符往下淌，淌到鍵盤上緣就攤開 ───
        //
        // 冷空氣是往下沉的，所以煙往下走 —— 這是這個樣式唯一一件別人做不到的事，其他樣式的觸
        // 鍵都是「變亮」，只有這裡是「有東西流下來」。
        //
        // **每一縷的終點固定是 `kbTop`，不能越線。** 鍵盤是在音符之後才畫的（`draw()` 的順序是
        // 背景 → 音符 → 落鍵特效 → 鍵盤），越過打擊線的那一段會被鍵盤蓋掉，看起來像煙被切了一
        // 刀。收在線上讀起來反而正好：寒氣淌到鍵上就攤開了。
        //
        // 相位吃 `age` 不吃 `t`：寒氣是**從凍住那一刻開始**的，跟泡泡的落地彈動同一種分工。起相
        // 與側偏都走 `rng(seed)`，所以同一顆音每次匯出都是同一團煙，而相鄰的音符不會一起吐煙。
        const rand = rng(b.seed);
        for (let i = 0; i < FROST_MIST; i++) {
          const k = (b.age / FROST_FALL + i / FROST_MIST + rand() * 0.4) % 1;
          // 兩端都要收乾淨：0 是還沒凝出來，1 是已經散在鍵盤上。中間最濃
          const a = Math.sin(Math.PI * k) * 0.42;
          const sway = (rand() - 0.5) * w * 1.6 * k;
          if (a < 0.02) continue;
          const px = cx + sway;
          const py = kbTop - FROST_DROP * u * (1 - k);
          // 越往下越開 —— 煙落下去是散掉的，不是一顆球在掉
          const rad = w * (0.55 + k * 0.9);
          const mg = ctx.createRadialGradient(px, py, 0, px, py, rad);
          mg.addColorStop(0, `rgba(236,248,255,${a})`);
          mg.addColorStop(1, "rgba(236,248,255,0)");
          // 壓扁成橫的。正圓看起來是一顆水滴在掉，橫的才像貼著往下流的一層冷空氣。
          // 漸層是在**填的那一刻**才套 CTM 的，所以縮放會連著漸層一起壓扁 —— 不必另外算橢圓
          ctx.save();
          ctx.translate(px, py);
          ctx.scale(1, 0.55);
          ctx.fillStyle = mg;
          ctx.translate(-px, -py);
          ctx.fillRect(px - rad, py - rad, rad * 2, rad * 2);
          ctx.restore();
        }
      }
    },
  },

  {
    // ── 賽博故障：RGB 色版分離 ＋ 間歇錯位 ──
    //
    // ─── 為什麼是 `source-over` 而不是 `lighter` ───
    //
    // 原型用 `mix-blend-mode: screen`，對應到 canvas 是 `lighter`。但故障的基底是不透明亮色，
    // `lighter` 底下整顆會糊成一團白光，而**「顏色是準的」對一個吃軌道色的樣式比加色感重要**
    // —— 這正是像素當初選 `source-over` 的同一個理由。加色感改用手調的紅／青透明度補。
    //
    // 前 85% 保持乾淨，尾端以三次 3% 關鍵幀快閃；而且只有三分之一音符會被固定選中。
    //
    // ─── 掃描線拿掉了 ───
    //
    // 這裡本來每 3px 畫一條貫穿全長的暗線。**那不在原型裡，而且太花**：整個畫面每一顆音符都
    // 佈滿橫紋，故障那幾格反而被淹沒。
    //
    // 回頭看原型才發現關鍵：`glitch-r`／`glitch-c` 的 `0%` 與 `100%` 是 `clip-path: inset(0)`
    // 加 `translate(0,0)` —— 也就是**靜止時紅青兩層完整覆蓋、零偏移**，在 `screen` 底下疊成一
    // 塊近白的純色。原型的常態是「一塊乾淨的色塊」，只有那三個關鍵影格才切出橫條並錯位。
    //
    // 所以正確的讀法是「純色 ＋ 偶爾幾個色塊會閃」，不是「一直有雜訊紋理」。
    id: "glitch",
    composite: "source-over",
    draw(ctx, b) {
      const { x, w, y, h, top, fullH, color: c, active, u, kbTop, cx, kw } = b;
      const glitchy = rng(b.seed * 4271 + 9)() < GLITCH_SHARE;
      const gl = glitchy ? stepAt(GLITCH_STEPS, phase(b, FAST)) : null;
      const dx = gl ? gl.dx * u : 0;
      // 原型是 `border-radius: 3px` —— 幾乎是方的。不用 `r`（＝ w/2，藥丸形）：數位訊號的
      // 破圖是方塊，圓角會把它讀成別的東西
      const rr = Math.min(3 * u, w * 0.2);

      ctx.fillStyle = rgba(mixWhite(c, active ? 0.82 : 0.66), active ? 0.95 : 0.8);
      capsule(ctx, x + dx, y, w, h, rr);
      ctx.fill();

      // 紅／青兩個色版，各自切**一小條**橫條再位移。
      //
      // **刻意不裁切。** 第一版把它們裁在音符的形狀裡，理由是「不然位移出去的色版會掛在音符外
      // 面」—— 但那正是要的效果：訊號跑掉的時候，那一條本來就該突出到自己的琴鍵之外。裁掉之後
      // 位移再大也只是在音符內部換色，看起來像配色壞了，不像訊號壞了。
      //
      // 突出去的只有那三格、每格 0.04 個週期（`FAST` 是 1.2 秒，所以每次約 50 毫秒），所以它不
      // 會真的讓人分不出音高 —— 而音高是這個畫面唯一不能出錯的資訊。
      if (gl) {
        for (const [col, o] of [["255,45,85", gl.r], ["0,229,255", gl.c]]) {
          const y0 = top + fullH * o[2];
          const y1 = top + fullH * o[3];
          ctx.fillStyle = `rgba(${col},${active ? 0.75 : 0.6})`;
          ctx.fillRect(x + dx + o[0] * u, y0 + o[1] * u, w, y1 - y0);
        }
      }

      if (active) {
        const rad = kw * 1.9;
        const rg = ctx.createRadialGradient(cx, kbTop, 2 * u, cx, kbTop, rad);
        rg.addColorStop(0, rgba(mixWhite(c, 0.8), 0.45));
        rg.addColorStop(1, rgba(c, 0));
        ctx.fillStyle = rg;
        ctx.fillRect(cx - rad, kbTop - rad, rad * 2, rad);
      }
    },
  },

  {
    // ── 泡泡：透明球膜 ＋ 邊緣彩光 ＋ 高光點 ──
    //
    // 原型的 wobble 是 `scale: 1.05 .96`，**縱向那一半不能照抄**：音符的高度就是它的長度，縮放
    // 它等於在說謊。所以只晃寬度。
    //
    // ─── 落下時微晃，落地時彈一下 ───
    //
    // 落下中是 ±2% 的緩慢浮動 —— 泡泡本來就不會靜止不動，但那不該是主角。**主角是觸鍵那一下**：
    // 以 `age` 為起點的阻尼彈簧，一碰到打擊線就撐到 ×1.47（squash），回彈到 ×0.76，來回兩三次
    // 之後被 `exp` 衰減掉，約 0.5 秒收乾淨。**最寬時會蓋過鍵緣，那是刻意的**（見 `BOUNCE_W`）。
    //
    // 用 `cos` 不用 `sin`：`sin(0) = 0` 代表「碰到的那一瞬間完全沒有變形」，那看起來是慢半拍才
    // 反應過來。`cos(0) = 1`，撞擊與變形同一幀發生。
    //
    // **封閉解，不逐幀積分** —— 積分的話 30fps 與 60fps 會彈出兩種形狀，跟噴發特效刻意不做空氣
    // 阻力是同一條規矩。
    id: "bubble",
    composite: "source-over",
    draw(ctx, b) {
      const { x, w, y, h, r, top, bottom, color: c, active, u, kbTop, cx, kw } = b;
      const bounce = active
        ? Math.exp(-b.age * BOUNCE_DECAY) * Math.cos(2 * Math.PI * BOUNCE_HZ * b.age)
        : 0;
      // 夾一個下限：`BOUNCE_W` 調過 1 的話寬度會變成負的，而負寬度畫出來是一個翻面的膠囊 ——
      // 沒有錯誤訊息，只是圖形忽然變得很奇怪。
      const wob = Math.max(0.35,
        1 + 0.02 * Math.sin(2 * Math.PI * phase(b, SLOW)) + BOUNCE_W * bounce);
      const ww = w * wob;
      const xx = x + (w - ww) / 2;
      const rr = Math.min(r, ww / 2);
      const mid = (top + bottom) / 2;

      // 球膜：中心幾乎全透，往邊緣才浮出顏色與白邊。原型的 `radial-gradient(120% 120%)`
      const g = ctx.createRadialGradient(xx + ww / 2, mid, 0,
        xx + ww / 2, mid, Math.max(ww, bottom - top) * 0.62);
      g.addColorStop(0.00, "rgba(255,255,255,0.02)");
      g.addColorStop(0.55, rgba(c, active ? 0.2 : 0.1));
      g.addColorStop(0.86, rgba(mixWhite(c, 0.35), active ? 0.62 : 0.42));
      g.addColorStop(1.00, `rgba(255,255,255,${active ? 0.8 : 0.6})`);
      ctx.fillStyle = g;
      capsule(ctx, xx, y, ww, h, rr);
      ctx.fill();

      ctx.strokeStyle = `rgba(255,255,255,${active ? 0.72 : 0.5})`;
      ctx.lineWidth = u;
      capsule(ctx, xx + u / 2, y + u / 2, Math.max(0, ww - u), Math.max(0, h - u), rr);
      ctx.stroke();

      // 高光點。原型釘在 `30% 20%`，這裡跟著**音符頂端**走而不是跟著可見範圍 —— 跟著可見範圍
      // 的話，長音捲進畫面時高光會黏在畫面上緣滑動，像沾了灰塵
      ctx.save();
      capsule(ctx, xx, y, ww, h, rr);
      ctx.clip();
      const hr = Math.max(2 * u, ww * 0.3);
      const hy = top + Math.min((bottom - top) * 0.2, ww * 1.2);
      const hg = ctx.createRadialGradient(xx + ww * 0.32, hy, 0, xx + ww * 0.32, hy, hr);
      hg.addColorStop(0, `rgba(255,255,255,${active ? 0.85 : 0.62})`);
      hg.addColorStop(1, "rgba(255,255,255,0)");
      ctx.fillStyle = hg;
      ctx.fillRect(xx, hy - hr, ww, hr * 2);
      ctx.restore();

      if (active) {
        const rad = kw * 1.8;
        const rg = ctx.createRadialGradient(cx, kbTop, 2 * u, cx, kbTop, rad);
        rg.addColorStop(0, rgba(mixWhite(c, 0.6), 0.4));
        rg.addColorStop(1, rgba(c, 0));
        ctx.fillStyle = rg;
        ctx.fillRect(cx - rad, kbTop - rad, rad * 2, rad);
      }
    },
  },

  {
    // ── 賽璐璐卡通：平塗、底部暗面、粗黑描邊與圓角直高光 ──
    // 專屬鍵盤沿用同一組平塗色與描邊，不使用漸層或 shadowBlur。
    id: "toon",
    composite: "source-over",
    draw(ctx, b) {
      const { x, w, y, h, r, top, bottom, color: c, active, u, kbTop, cx, kw } = b;
      const rr = Math.min(r, w * 0.22);
      const line = Math.max(u, 2 * u);

      // 平塗。`active` 只往白走、不改飽和 —— 卡通的高光是畫上去的，不是打上去的
      ctx.fillStyle = rgba(mixWhite(c, active ? 0.25 : 0), 1);
      capsule(ctx, x, y, w, h, rr);
      ctx.fill();

      // 底部暗面錨在未裁切的 bottom，讓落過打擊線的部分自然消失。
      ctx.save();
      capsule(ctx, x, y, w, h, rr);
      ctx.clip();
      const foot = Math.min(TOON_FOOT * u, h * 0.35);
      ctx.fillStyle = rgba(mixBlack(c, 0.22), 1);
      ctx.fillRect(x, bottom - foot, w, foot);
      ctx.restore();

      ctx.strokeStyle = TOON.ink;
      ctx.lineWidth = line;
      capsule(ctx, x, y, w, h, rr);
      ctx.stroke();

      // 靠左的圓角直高光，長度同時受固定尺度與短音高度限制。
      const gw = Math.max(u, w * 0.22);
      const gx = x + w * 0.26;
      const gy = top + line + gw;
      const glint = Math.min(TOON_GLINT * u, h * 0.45, Math.max(0, h - line * 2 - gw * 2));
      if (glint > 0) {
        ctx.save();
        capsule(ctx, x, y, w, h, rr);
        ctx.clip();
        ctx.strokeStyle = "rgba(255,255,255,0.9)";
        ctx.lineCap = "round";
        ctx.lineWidth = gw;
        ctx.beginPath();
        ctx.moveTo(gx, gy + gw / 2);
        ctx.lineTo(gx, gy + glint);
        ctx.stroke();
        ctx.lineCap = "butt";
        ctx.restore();
      }

      if (active) {
        // 觸底：實心的卡通光環 ＋ 一條黑邊。沒有漸層，跟像素同一個道理
        ctx.fillStyle = rgba(mixWhite(c, 0.5), 0.55);
        ctx.fillRect(cx - kw, kbTop - 4 * u, kw * 2, 4 * u);
        ctx.fillStyle = TOON.ink;
        ctx.fillRect(cx - kw, kbTop - 5 * u, kw * 2, u);
      }
    },

    keyboard(ctx, kb) {
      const { keys, act, kbTop, kbH, blackH, W, u } = kb;
      const line = Math.max(u, 2 * u);
      const press = 2.5 * u;

      ctx.fillStyle = TOON.bed;
      ctx.fillRect(0, kbTop, W, kbH);
      ctx.fillStyle = TOON.line;
      ctx.fillRect(0, kbTop - 2.5 * u, W, 2.5 * u);

      for (const k of keys) {
        if (k.black) continue;
        const c = act.get(k.midi);
        const p = c ? press : 0;
        const gap = line;
        const x = k.x + gap / 2 + p;
        const w = k.w - gap - p * 2;
        if (w <= 0) continue;

        ctx.fillStyle = c ? rgba(mixWhite(c, 0.35), 1) : TOON.white;
        keyPath(ctx, x, kbTop, w, kbH - gap / 2 - p, k.w * 0.22);
        ctx.fill();
        ctx.strokeStyle = TOON.ink;
        ctx.lineWidth = line;
        ctx.stroke();
      }

      for (const k of keys) {
        if (!k.black) continue;
        const c = act.get(k.midi);
        const p = c ? press : 0;
        const x = k.x + p;
        const w = k.w - p * 2;
        const h = blackH - p;
        if (w <= 0 || h <= 0) continue;

        ctx.fillStyle = c ? rgba(mixWhite(c, 0.2), 1) : TOON.black;
        keyPath(ctx, x, kbTop, w, h, k.w * 0.3);
        ctx.fill();
        ctx.strokeStyle = TOON.ink;
        ctx.lineWidth = line;
        ctx.stroke();

        if (!c) {
          const hw = w * 0.42;
          const hh = h * 0.5;
          ctx.fillStyle = TOON.blackTop;
          keyPath(ctx, x + (w - hw) / 2, kbTop + line * 1.5, hw, hh, hw / 2);
          ctx.fill();
        }
      }
    },
  },

  {
    // ── 復古：直角、硬階調的斜面，8-bit 遊戲感 ──
    //
    // **跟像素是兩種不同的復古，不要合併。** 像素做的是「把音符量化到格線上」（切在 3u 的網格、
    // 明暗分四階）；復古一格都不量化，靠的是一圈**硬邊的斜面** —— 左上打亮、右下壓暗、外面一圈
    // 純黑。那是紅白機的按鈕、磚塊、血條的畫法，而它跟解析度無關，所以這一種**沒有像素那個「預
    // 覽與成品切點不同」的副作用**。
    //
    // 一樣**一次 `shadowBlur` 都沒有**：整顆音符六個 `fillRect` 畫完，大譜匯出時跟像素、卡通同
    // 一級便宜。
    //
    // 黑框與斜面都夾在 `w` 的比例內。原型的 2px／4px 是對一顆 28px 寬的示意方塊講的，而黑鍵在
    // 1080p 下只有十幾像素 —— 照抄的話左右兩道斜面會在中間相接，整顆音符只剩下框跟斜面，看不出
    // 是什麼顏色。跟卡通的描邊夾 `w * 0.22` 是同一件事。
    //
    // **暗面畫在亮面之後**，所以左下與右上兩個角是暗的贏。那是照原型 `box-shadow` 的疊法來的
    // （暗的那條列在前面，也就是蓋在上面）。兩面改成 45° 斜接會變成一個相框 —— 而 8-bit 的斜面
    // 本來就是直接切的。
    id: "retro",
    composite: "source-over",
    draw(ctx, b) {
      const { x, w, y, h, color: c, active, u, kbTop, cx, kw } = b;
      const ink = "#08080f";
      const line = Math.max(u, Math.min(4 * u, w * 0.18, h * 0.25));
      const body = mixWhite(c, active ? 0.28 : 0);

      // 黑框**是底色不是描邊** —— 先鋪滿再把內容畫在裡面，框就一定是等寬的，也不必算路徑
      ctx.fillStyle = ink;
      ctx.fillRect(x, y, w, h);

      const ix = x + line, iy = y + line;
      const iw = w - line * 2, ih = h - line * 2;
      if (iw <= 0 || ih <= 0) return;

      // 平塗。`active` 只往白走 —— 8-bit 沒有「打光」這回事，亮起來就是換一個色階
      ctx.fillStyle = rgba(body, 1);
      ctx.fillRect(ix, iy, iw, ih);

      // 硬階調的斜面：上、左打亮，下、右壓暗。沒有漸層，這個風格裡連一絲柔邊都不能有
      const bw = Math.min(4 * u, iw * 0.3), bh = Math.min(4 * u, ih * 0.3);
      ctx.fillStyle = rgba(mixWhite(body, 0.45), 1);
      ctx.fillRect(ix, iy, iw, bh);
      ctx.fillRect(ix, iy, bw, ih);
      ctx.fillStyle = rgba(mixBlack(body, 0.45), 1);
      ctx.fillRect(ix, iy + ih - bh, iw, bh);
      ctx.fillRect(ix + iw - bw, iy, bw, ih);

      // 觸底：琴鍵正上方一條實心亮帶 ＋ 一條黑邊。跟像素、卡通一樣**不用漸層**
      if (active) {
        ctx.fillStyle = rgba(mixWhite(c, 0.5), 1);
        ctx.fillRect(cx - kw, kbTop - 5 * u, kw * 2, 4 * u);
        ctx.fillStyle = ink;
        ctx.fillRect(cx - kw, kbTop - u, kw * 2, u);
      }
    },
  },
];

// ─── 落鍵特效 ───────────────────────────────────────────────────────────────

/** 噴發的重力，px/s²（會再乘 u）。 */
const BURST_G = 220;

/**
 * 新星的六道星芒，角度（弧度）。**刻意不等分** —— 等分的星芒讀起來像一個圖示，不像爆炸。
 * 全部落在上半（`-PI` 到 `0`）：下半在鍵盤底下，畫了也會被蓋掉。
 */
const NOVA_SPIKES = [-Math.PI / 2, -0.18, -Math.PI + 0.18, -1.15, -2.05, -Math.PI / 2 + 0.02];

/**
 * 新星的整體尺度。核心、星芒、震波三層共用它，所以改這一個數字就是等比縮放整個特效。
 *
 * **縮過兩次**，`0.75 × 0.75`。原本的範圍會蓋掉相鄰兩三個鍵，而和弦底下六個新星疊在一起就是
 * 一片白 —— 看不出是哪幾個鍵在響，而那正是落鍵特效存在的理由。第一次縮到 0.75 仍然太大。
 */
const NOVA_SCALE = 0.5625;

/** 煙霧的團數倍率。 */
const SMOKE_MORE = 1.25;

/** 灰燼與水花的封閉解參數。 */
const EMBER_EASE = 0.72;
const EMBER_FLICKER = 5.5;
const SPLASH_G = 1400;
const SPLASH_JET = 0.42;
const SPLASH_CROWN = 0.2;

/**
 * 一次落鍵。
 *
 * @typedef {object} HitBox
 * @property {number} x      琴鍵中心的 x
 * @property {number} y      打擊線的 y（＝鍵盤頂端）
 * @property {number} w      琴鍵有多寬
 * @property {number} age    這個音**發聲之後**過了幾秒。保證在 `[0, span)` 之內
 * @property {number} vel    力度 0..1
 * @property {number[]} color 軌道顏色
 * @property {number} u      「1080p 下的 1 像素」
 * @property {number} seed   `note.seed`。要亂數就用 `rng(seed)`，**不准用 Math.random**
 *
 * `span` 是這個特效最多活多久（秒）。waterfall.js 拿它來剔掉迴圈裡不用畫的音，所以**寫得太
 * 大只是白算**，寫得太小會讓效果被切掉。`span: 0` 是「這一項什麼都不畫」的意思，整層會被
 * 直接跳過。
 */
export const HIT_FX = [
  {
    // ── 噴發：預設。彈道封閉解 ──
    //
    // 位置只跟 `age` 有關，沒有狀態、沒有積分，所以 seek 與換 fps 都不會變。原型的
    // `vx *= 0.985` 空氣阻力刻意不做 —— 那是**每幀**衰減，30fps 與 60fps 會噴出兩種形狀。
    id: "burst",
    composite: "lighter",
    span: 0.75,
    draw(ctx, hit) {
      const { x: x0, y: y0, age, vel, color: c, u, seed } = hit;
      const r = rng(seed * 977 + 1);
      const cnt = 8 + Math.floor(vel * 10);
      for (let i = 0; i < cnt; i++) {
        const ang = -Math.PI / 2 + (r() - 0.5) * 1.6;
        const sp = (60 + r() * 160 * vel) * u;
        const rad = (1 + r() * 2.2) * u;
        // 逐粒子再各自短一點，不然十八顆會整齊地同時消失
        const life = 1 - age / (0.4 + r() * (0.75 - 0.4));
        if (life <= 0) continue;
        const px = x0 + Math.cos(ang) * sp * age;
        const py = y0 + Math.sin(ang) * sp * age + 0.5 * BURST_G * u * age * age;
        ctx.fillStyle = rgba(c, 0.7 * life);
        ctx.shadowColor = rgba(c, life);
        ctx.shadowBlur = 8 * u;
        ctx.beginPath();
        ctx.arc(px, py, rad * life + 0.4 * u, 0, Math.PI * 2);
        ctx.fill();
      }
    },
  },

  {
    // ── 漣漪：三圈同心半圓，以「水面傳遞」的速度往外走 ──
    //
    // ─── 為什麼從 0.6 秒放慢到 1.8 秒 ───
    //
    // 原本 0.6 秒之內從 0.35w 擴到 2.95w，換算大約每秒 160px。那個速度讀起來是「爆開」不是
    // 「傳遞」—— 水波的特徵是**慢、等速、走很遠**，而快到一定程度之後眼睛只看得到一個閃現的
    // 環，看不到它在走。現在是 1.8 秒走到 4.2w，大約每秒 80px：速度砍半、距離多四成。
    //
    // 半徑對 `age` 是**線性**的（不是 ease-out）：水波是等速傳遞的，加了緩動就變成聲波撞擊。
    //
    // 三圈而不是兩圈：真實的落水會打出一列波，不是一兩道。每圈晚 0.22 秒出發。
    //
    // 振幅隨半徑衰減（`1/(1+rad)` 那一項）而不只是隨時間：二維波front 的能量攤在越來越長的
    // 圓周上，所以走得越遠越淡。少了它，最外圈會在還很亮的時候忽然消失。
    //
    // **代價是 `span` 變成三倍**，而 `span` 同時是 waterfall.js 的剔除條件 —— 同一刻要畫的
    // 落點數也變三倍。這一項仍然是整條路上最便宜的特效（三次 `arc` ＋ `stroke`，沒有粒子迴圈、
    // 沒有 shadowBlur），所以付得起。
    //
    // 只畫上半圓（`PI` → `2PI`）—— 下半圓在鍵盤底下，畫了也會被鍵盤蓋掉，純粹白算。
    id: "ripple",
    composite: "lighter",
    span: 1.8,
    draw(ctx, hit) {
      const { x, y, w, age, vel, color: c, u } = hit;
      const lite = mixWhite(c, 0.5);
      for (let i = 0; i < 3; i++) {
        const born = i * 0.22;
        const k = (age - born) / (1.8 - born);
        if (k <= 0 || k >= 1) continue;
        const rad = w * (0.3 + 3.9 * k) * (0.75 + vel * 0.5);
        // 隨距離攤薄 ＋ 隨時間淡出。前者讓外圈自然變細，後者收尾
        const spread = 1 / (1 + rad / (w * 2.2));
        const fade = (1 - k) * spread;
        ctx.strokeStyle = rgba(i === 0 ? lite : c, fade * (0.5 + vel * 0.55));
        ctx.lineWidth = (2.2 * fade + 0.35) * u;
        ctx.beginPath();
        ctx.arc(x, y, rad, Math.PI, Math.PI * 2);
        ctx.stroke();
      }
    },
  },

  {
    // ── 光柱：琴鍵被打亮，一道光往上衝 ──
    //
    // 跟噴發的差別是它**貼著琴鍵**：噴發是散開的點，這個是一條有寬度的束，所以密集的和弦
    // 底下看得出來是哪幾個鍵在響（噴發會混成一團）。
    id: "beam",
    composite: "lighter",
    span: 0.5,
    draw(ctx, hit) {
      const { x, y, w, age, vel, color: c, u } = hit;
      const k = age / 0.5;
      const fade = (1 - k) * (1 - k);
      const lite = mixWhite(c, 0.55);

      // 光束：往上快速衰減。寬度隨時間收窄，看起來像被吸回琴鍵
      const hgt = (90 + 340 * vel) * u;
      const bw = w * (0.55 + 0.75 * fade);
      const g = ctx.createLinearGradient(0, y - hgt, 0, y);
      g.addColorStop(0, rgba(lite, 0));
      g.addColorStop(1, rgba(lite, fade * (0.3 + vel * 0.45)));
      ctx.fillStyle = g;
      ctx.fillRect(x - bw / 2, y - hgt, bw, hgt);

      // 落點的橫向亮斑，把光束的根部收在琴鍵上
      const rad = w * (1.2 + 1.8 * k);
      const rg = ctx.createRadialGradient(x, y, u, x, y, rad);
      rg.addColorStop(0, `rgba(255,255,255,${fade * 0.75})`);
      rg.addColorStop(0.4, rgba(lite, fade * 0.4));
      rg.addColorStop(1, rgba(c, 0));
      ctx.fillStyle = rg;
      ctx.fillRect(x - rad, y - rad, rad * 2, rad);
    },
  },

  {
    // ── 煙霧：幾團往上飄、邊飄邊散 ──
    //
    // **整份註冊表裡唯一一個 `source-over` 的特效。** 煙不發光 —— `lighter` 底下它會變成一團
    // 越疊越亮的霧，那是蒸氣不是煙。代價是它會遮住後面的音符，而那正是煙該有的行為。
    //
    // 每一團各自延遲出生（`dly`），所以是「一陣」不是「一坨」—— 同時出生同時消失的話，看起來
    // 是一個會呼吸的圓，不是煙。
    //
    // 橫向漂移是 `drift * t` 的**封閉解**，不是逐幀累加風速。逐幀積分的話 30fps 與 60fps 會
    // 飄出兩種形狀 —— 跟噴發刻意不做空氣阻力是同一條規矩。
    //
    // ─── 速度與團數是分開調的 ───
    //
    // 位移與擴張都是 `t = (age - dly) / (span - dly)` 的函式，也就是**正規化的**進度。所以
    // 「飄多快」完全由 `span` 決定，改係數反而會連總距離一起改掉。試過加倍到 2.4（半速），
    // **太慢了，退回 1.2**。
    //
    // 團數則是另一回事，走 `SMOKE_MORE` —— 那一項留著，煙比原本濃 25%。
    //
    // 團數乘上去之後這仍然是**偏貴的特效**：每一團都是一次 `createRadialGradient`，同一刻活著
    // 的落點數 × 每個八團。大譜匯出時它跟像素樣式是光譜的兩端。
    id: "smoke",
    composite: "source-over",
    span: 1.2,
    draw(ctx, hit) {
      const { x, y, w, age, vel, color: c, u, seed } = hit;
      const r = rng(seed * 5051 + 7);
      const cnt = Math.round((4 + vel * 3) * SMOKE_MORE);
      for (let i = 0; i < cnt; i++) {
        const dly = r() * 0.3;
        const t = (age - dly) / (1.2 - dly);
        const wob = r();
        const size = r();
        if (t <= 0 || t >= 1) continue;
        const px = x + (wob - 0.5) * w * 1.7 * t;
        const py = y - (44 + 96 * vel) * u * t;
        const rad = w * (0.26 + 0.95 * t) * (0.55 + size * 0.85);
        const a = (1 - t) * (1 - t) * 0.4;
        const g = ctx.createRadialGradient(px, py, 0, px, py, rad);
        g.addColorStop(0.0, rgba(mixWhite(c, 0.45), a));
        g.addColorStop(0.55, rgba(mixWhite(c, 0.2), a * 0.45));
        g.addColorStop(1.0, rgba(mixBlack(c, 0.35), 0));
        ctx.fillStyle = g;
        ctx.beginPath();
        ctx.arc(px, py, rad, 0, Math.PI * 2);
        ctx.fill();
      }
    },
  },

  {
    // ── 觸電火花：短促的鋸齒電弧 ──
    //
    // **折線而不是直線**：直線是雷射，折三次才是電。每一折的偏移量由 `rng(seed)` 決定，所以
    // 同一顆音每次匯出打出同一道電弧。
    //
    // 試過改成「沿射線走、往側向鼓出 `sin(π·f)`」的弧線（電弧是跨過去的、不是射出去的），
    // 而且長度砍到四分之三。**畫出來比折線差**，退回了 —— 弧線在這個尺寸下讀起來是軟的，
    // 而電花該是硬的。
    //
    // 淡出走**階梯**不走平滑：電花是斷續的，平滑淡出看起來像煙火的餘燼。表格只有五格，因為
    // 整個特效只有 0.34 秒 —— 再細分也看不出來。
    //
    // 這是所有特效裡最短的一個（0.34 秒對比噴發的 0.75）。電弧本來就是一瞬間的事，拖長會變成
    // 「一直在漏電」。
    id: "spark",
    composite: "lighter",
    span: 0.34,
    draw(ctx, hit) {
      const { x, y, w, age, vel, color: c, u, seed } = hit;
      const r = rng(seed * 7919 + 13);
      const k = age / 0.34;
      const flick = [1, 0.35, 0.9, 0.2, 0.55][Math.min(4, Math.floor(k * 5))];
      const fade = (1 - k) * flick;
      if (fade <= 0) return;

      const lite = mixWhite(c, 0.78);
      const cnt = 3 + Math.floor(vel * 4);
      ctx.shadowColor = rgba(lite, fade);
      ctx.shadowBlur = 7 * u;
      ctx.lineCap = "round";
      for (let i = 0; i < cnt; i++) {
        const ang = -Math.PI / 2 + (r() - 0.5) * 2.5;
        const len = w * (0.9 + r() * 2.0) * (0.5 + vel * 0.85) * k;
        ctx.strokeStyle = rgba(i % 2 ? lite : mixWhite(c, 0.95), fade * (0.55 + r() * 0.45));
        ctx.lineWidth = Math.max(0.4, 1.5 - 0.9 * k) * u;
        ctx.beginPath();
        ctx.moveTo(x, y);
        for (let st = 1; st <= 3; st++) {
          const f = st / 3;
          const jit = (r() - 0.5) * w * 0.55 * (st < 3 ? 1 : 0.4);
          ctx.lineTo(x + Math.cos(ang) * len * f + jit, y + Math.sin(ang) * len * f);
        }
        ctx.stroke();
      }
      ctx.lineCap = "butt";
      ctx.shadowBlur = 0;
    },
  },

  {
    // ── 新星光爆閃：核心爆白 ＋ 六道星芒 ＋ 一圈震波 ──
    //
    // 三層各有各的時間尺度，那是它看起來像「爆」而不是像「亮一下」的原因：
    //
    //   核心 `exp(-14·age)` —— 最快，約 0.15 秒就收乾淨，那是閃光本身
    //   星芒 `sin(π·min(1, 2.2k))` —— 先衝出去再收回來，衝出比收回快
    //   震波 線性擴散       —— 最慢，整個 span 都在走，收尾的那一圈
    //
    // 星芒**六道不是四道**：四道會讀成一個十字（那是準星），六道才是星。而且刻意不對稱
    // （`SPIKES` 的角度不是等分）—— 等分的星芒看起來像一個圖示。
    //
    // 全部畫在打擊線**上方**（`fillRect` 的高度只有 `rad` 不是 `rad*2`）：下面是鍵盤，畫了
    // 也會被蓋掉。
    id: "nova",
    composite: "lighter",
    span: 0.55,
    draw(ctx, hit) {
      const { x, y, w, age, vel, color: c, u } = hit;
      const k = age / 0.55;
      const lite = mixWhite(c, 0.72);
      const pow = (0.6 + vel * 0.7) * NOVA_SCALE;

      // ── 核心 ──
      const core = Math.exp(-age * 14);
      const crad = w * (0.55 + 2.4 * core) * pow;
      const rg = ctx.createRadialGradient(x, y, 0, x, y, crad);
      rg.addColorStop(0.0, `rgba(255,255,255,${core * 0.95})`);
      rg.addColorStop(0.3, rgba(lite, core * 0.7));
      rg.addColorStop(1.0, rgba(c, 0));
      ctx.fillStyle = rg;
      ctx.fillRect(x - crad, y - crad, crad * 2, crad);

      // ── 星芒 ──
      const spike = Math.sin(Math.PI * Math.min(1, k * 2.2));
      if (spike > 0) {
        const len = w * 4.6 * pow * spike;
        const half = w * 0.16 * spike;
        ctx.fillStyle = rgba(mixWhite(c, 0.85), spike * 0.55);
        for (const a of NOVA_SPIKES) {
          const dx = Math.cos(a), dy = Math.sin(a);
          ctx.beginPath();
          ctx.moveTo(x + dx * len, y + dy * len);
          ctx.lineTo(x - dy * half, y + dx * half);
          ctx.lineTo(x + dy * half, y - dx * half);
          ctx.closePath();
          ctx.fill();
        }
      }

      // ── 震波 ──
      if (k < 1) {
        const rad = w * (0.4 + 4.2 * k) * pow;
        const fade = (1 - k) * (1 - k);
        ctx.strokeStyle = rgba(lite, fade * 0.6);
        ctx.lineWidth = (2.4 * fade + 0.3) * u;
        ctx.beginPath();
        ctx.arc(x, y, rad, Math.PI, Math.PI * 2);
        ctx.stroke();
      }
    },
  },

  {
    // ── 碎裂：硬邊的碎片往外飛 ──
    //
    // ─── 為什麼需要一個「不發光」的落點特效 ───
    //
    // 另外五個有動作的特效全部是柔邊（噴發、漣漪、光柱、火花、新星還加上加法混色；煙霧至少
    // 是柔的）。可是音符樣式裡有三個是**硬邊**的 —— 像素、卡通、冰晶 —— 選了那三個之後，
    // 不管配哪個落點特效，畫面下緣都會糊出一團光，跟音符本身的語彙對不上。這一項補那個缺口。
    //
    // 所以它跟噴發刻意是對照組：
    //
    //   噴發  圓點 ‧ 會發光 ‧ `lighter`   ‧ 每顆一次 shadowBlur
    //   碎裂  三角 ‧ 平塗   ‧ `source-over` ‧ **一次 shadowBlur 都沒有**
    //
    // 沒有 shadowBlur 順帶讓它成為最便宜的粒子特效 —— 跟像素樣式是同一個理由，也同樣是大譜
    // 匯出時的逃生門。
    //
    // 位置與旋轉都是 `age` 的封閉解，沒有逐幀積分 —— 同噴發那條規矩：積分的話 30fps 與 60fps
    // 會碎出兩種形狀。
    id: "shatter",
    composite: "source-over",
    span: 0.6,
    draw(ctx, hit) {
      const { x, y, w, age, vel, color: c, u, seed } = hit;
      const r = rng(seed * 3163 + 5);

      // 落點的硬邊閃光。**方的不是圓的**，而且不做漸層 —— 這個特效裡沒有一絲柔邊
      const fl = 1 - age / 0.12;
      if (fl > 0) {
        ctx.fillStyle = rgba(mixWhite(c, 0.6), 0.5 * fl);
        const fw = w * (0.9 + 0.7 * (1 - fl));
        ctx.fillRect(x - fw / 2, y - 4 * u * fl, fw, 4 * u * fl);
      }

      const cnt = 5 + Math.floor(vel * 6);
      for (let i = 0; i < cnt; i++) {
        const ang = -Math.PI / 2 + (r() - 0.5) * 2.2;
        const sp = (70 + r() * 190 * vel) * u;
        const size = (2.6 + r() * 4.2) * u;
        const spin = (r() - 0.5) * 22;
        // 逐片各自短一點，不然十來片會整齊地同時消失
        const life = 1 - age / (0.3 + r() * 0.3);
        if (life <= 0) continue;

        const px = x + Math.cos(ang) * sp * age;
        const py = y + Math.sin(ang) * sp * age + 0.5 * BURST_G * u * age * age;
        const rot = spin * age;

        // 每一片是一個**不等邊**三角形。三個頂點的夾角寫死（2.4 / 2.4 / 1.48 弧度），只有大小
        // 隨機 —— 連頂點角度也抽亂數的話碎片會長得像雪花，而碎片該是「有稜有角但不對稱」的。
        ctx.fillStyle = rgba(mixWhite(c, 0.55 * life), 0.95 * life);
        ctx.beginPath();
        for (let v = 0; v < 3; v++) {
          const a = rot + v * 2.4 + 0.6;
          const d = size * (v === 1 ? 1.5 : 1) * life;
          const vx = px + Math.cos(a) * d;
          const vy = py + Math.sin(a) * d;
          if (v === 0) ctx.moveTo(vx, vy);
          else ctx.lineTo(vx, vy);
        }
        ctx.closePath();
        ctx.fill();
      }
    },
  },

  {
    // 灰燼：餘燼被熱氣往上帶，邊飄邊冷卻。
    id: "ember",
    composite: "lighter",
    span: 1.6,
    draw(ctx, hit) {
      const { x, y, w, age, vel, color: c, u, seed } = hit;
      const r = rng(seed * 8867 + 17);

      const bed = 1 - age / 0.3;
      if (bed > 0) {
        const brad = w * (0.6 + 0.9 * (1 - bed)) * (0.6 + vel * 0.6);
        const bg = ctx.createRadialGradient(x, y, 0, x, y, brad);
        bg.addColorStop(0, rgba(mixWhite(c, 0.65), bed * 0.8));
        bg.addColorStop(0.45, rgba(c, bed * 0.4));
        bg.addColorStop(1, rgba(c, 0));
        ctx.fillStyle = bg;
        ctx.fillRect(x - brad, y - brad, brad * 2, brad);
      }

      const cnt = 5 + Math.floor(vel * 7);
      for (let i = 0; i < cnt; i++) {
        const dly = r() * 0.35;
        const lane = r();
        const sway = r();
        const size = r();
        const t = (age - dly) / (1.6 - dly);
        if (t <= 0 || t >= 1) continue;

        const py = y - (70 + 150 * vel) * u * Math.pow(t, EMBER_EASE);
        const px = x + (lane - 0.5) * w * 0.8
          + Math.sin(t * EMBER_FLICKER + sway * 6.283) * w * 0.45 * t;
        const heat = 1 - t;
        const col = heat > 0.5
          ? mixWhite(c, (heat - 0.5) * 1.3)
          : mixBlack(c, (0.5 - heat) * 1.4);
        const flick = 0.72 + 0.28 * Math.sin(t * EMBER_FLICKER * 6.283 + sway * 11);
        const alpha = (1 - t) * (1 - t) * flick * 0.9;
        const rad = (0.8 + size * 1.4) * u * (0.45 + 0.55 * heat);

        ctx.fillStyle = rgba(col, alpha);
        ctx.shadowColor = rgba(mixWhite(c, 0.35), alpha * heat);
        ctx.shadowBlur = 6 * u;
        ctx.beginPath();
        ctx.arc(px, py, rad, 0, Math.PI * 2);
        ctx.fill();
      }
      ctx.shadowBlur = 0;
    },
  },

  {
    // 水花：水冠、水柱、水珠與一道收尾水紋。
    id: "splash",
    composite: "lighter",
    span: 0.9,
    draw(ctx, hit) {
      const { x, y, w, age, vel, color: c, u, seed } = hit;
      const r = rng(seed * 2699 + 23);
      const foam = mixWhite(c, 0.75);
      const pow = 0.6 + vel * 0.6;

      const crown = 1 - age / SPLASH_CROWN;
      if (crown > 0) {
        const rad = w * (0.45 + 1.3 * (1 - crown)) * pow;
        const hgt = w * 0.85 * crown * pow;
        ctx.strokeStyle = rgba(foam, crown * 0.8);
        ctx.lineWidth = (1.8 * crown + 0.3) * u;
        ctx.beginPath();
        ctx.moveTo(x - rad, y);
        ctx.lineTo(x - rad * 0.62, y - hgt);
        ctx.moveTo(x + rad, y);
        ctx.lineTo(x + rad * 0.62, y - hgt);
        ctx.stroke();
      }

      const jet = age < SPLASH_JET ? Math.sin(Math.PI * age / SPLASH_JET) : 0;
      if (jet > 0) {
        const hgt = w * 2.3 * jet * pow;
        const bw = w * 0.34 * (0.5 + 0.5 * jet);
        const tw = bw * 0.35;
        ctx.fillStyle = rgba(foam, jet * 0.55);
        ctx.beginPath();
        ctx.moveTo(x - bw / 2, y);
        ctx.lineTo(x + bw / 2, y);
        ctx.lineTo(x + tw / 2, y - hgt);
        ctx.lineTo(x - tw / 2, y - hgt);
        ctx.closePath();
        ctx.fill();
        ctx.beginPath();
        ctx.arc(x, y - hgt, tw * 0.9 + 0.4 * u, 0, Math.PI * 2);
        ctx.fill();
      }

      const cnt = 6 + Math.floor(vel * 8);
      for (let i = 0; i < cnt; i++) {
        const life = r();
        const side = r();
        const size = r();
        const tl = (0.3 + life * 0.42) * (0.75 + vel * 0.4);
        if (age >= tl) continue;
        const vy = SPLASH_G * u * tl / 2;
        const vx = (side - 0.5) * w * 5.5 * pow;
        const px = x + vx * age;
        const py = y - vy * age + 0.5 * SPLASH_G * u * age * age;
        const fade = Math.min(1, (tl - age) / 0.12);
        const rad = (0.9 + size * 1.6) * u;
        ctx.fillStyle = rgba(foam, fade * 0.85);
        ctx.beginPath();
        ctx.arc(px, py, rad, 0, Math.PI * 2);
        ctx.fill();
      }

      const k = age / 0.9;
      if (k < 1) {
        const rad = w * (0.4 + 3.0 * k) * pow;
        const fade = (1 - k) * (1 - k);
        ctx.strokeStyle = rgba(c, fade * 0.55);
        ctx.lineWidth = (1.8 * fade + 0.3) * u;
        ctx.beginPath();
        ctx.arc(x, y, rad, Math.PI, Math.PI * 2);
        ctx.stroke();
      }
    },
  },

  {
    // ── 無 ──
    //
    // 不是湊數的：本來就夠密的譜，任何落點特效都只是噪音，而有人要的就是一支乾淨的瀑布。
    // `span: 0` 讓 waterfall.js 連迴圈都不跑 —— 這一項因此也是最快的。
    id: "none",
    composite: "lighter",
    span: 0,
    draw() {},
  },
];

// ─── 查表 ───────────────────────────────────────────────────────────────────

/**
 * `id` → 那一項，查不到就回**第一項**（＝預設）。
 *
 * 這條退路是必要的而不是防禦性程式：使用者的選擇存在 localStorage，而**刪掉一種樣式之後，
 * 已經選過它的人下次進來會帶著一個不存在的 id**。丟例外的話那個人從此打不開這一頁，而且他
 * 自己完全不知道為什麼 —— 靜靜落回預設是唯一說得過去的行為。
 */
const pick = (list, id) => list.find(s => s.id === id) ?? list[0];

export const noteStyle = id => pick(NOTE_STYLES, id);
export const hitFx = id => pick(HIT_FX, id);
