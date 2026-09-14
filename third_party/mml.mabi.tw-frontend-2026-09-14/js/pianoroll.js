// ────────────────────────────────────────────────────────────────────────────
//  鋼琴捲軸 —— 繪製與輸入。不自己寫回 MML，只把意圖交給 ui.js。
//
//  選取（含多選）不是這裡的狀態：真相來源是 MML 的選取範圍，ui 用 setSelection() 推進來。
//  拖曳中只畫預覽，放開左鍵才真的改 MML（每動一格就重寫會產生幾十步 undo，而且中途每一步
//  都會蓋掉路上的音）。畫新音符也走同一條路（drag 的 "create"）。
//
//  觸控（`#roll` 設 `touch-action:none`）：單指按下一律待判定，位移 > TAP_SLOP 就平移到放開
//  為止；雙指張合只縮一軸，軸向判定完鎖到放開。滑鼠完全不走觸控那一套。
//
//  畫法：一張只有可視區大小的 canvas。#stage 提供原生捲軸、#rollpad 撐出整首歌的尺寸、
//  #roll 是 position:sticky 釘在左上角的 canvas。不畫大 canvas 竹的理由：90 小節在 12px 格寬、
//  dpr=2 下是 557 MB，而極端譜可以到一千多小節。
// ────────────────────────────────────────────────────────────────────────────

// `BAR_TICKS` 與 `CELLS_PER_BAR` 刻意不在清單裡：小節邊界一律問拍號圖。少了那兩個
// 名字，下次有人寫 `tick / BAR_TICKS` 會直接是未定義變數。
import {
  PITCH_MIN, PITCH_MAX, PITCH_ROWS, ROLL_MAX, playable, soundsAsWritten,
  GAME_MIN, GAME_MAX, OCT_BASE,
  CELL_TICKS, FINE_TICKS,
  CELL_W as CELL_W0, ROW_H as ROW_H0,
  GUTTER_W, RULER_H,
  TRACK_COLORS, MAX_TRACKS, GAME_TRACKS,
  midiToRow, tickToPx, pxToTick, barsFor,
  PPQ, barIndexOf, barStartTick, barTicksAt, meterAt, meterName, meters, contentTicks,
  ZOOM_W, ZOOM_H, zoomStep, zoomScroll, gridStep, rowLinesAt,
  PINCH_SPAN, pinchAxis, zoomTick,
} from "./config.js";
import { makeClock, makeInverseClock, lenTicks, tempoChanges, velChanges } from "./mml.js";
import { snapDown, overwriteEffect } from "./rolledit.js";
import { ghostAt } from "./select.js";
import { say, clamp } from "./util.js";
import * as player from "./player.js";
import * as rolljoy from "./rolljoy.js";
import * as i18n from "./i18n.js";
import * as theme from "./theme.js";

// ─── 顏色 ───────────────────────────────────────────────────────────────────
//
//  **這是一份退路，不是來源。** 真正的值在 editor.css 的 `:root` 與
//  `:root[data-theme="light"]`，`readTheme()` 在開站與換主題時把它抄進來。
//  留一份的理由有兩個：CSS 讀不到時畫面不會整片壞掉，以及深色主題的值有個地方可以看。
//
//  鍵名跟 CSS 是機械對應的（`rowKeyIn` ↔ `--roll-row-key-in`），**兩邊由
//  test/theme.test.mjs 逐項比對** —— 抄錯不會報錯，只會顏色不一樣。
const C = {
  bg:        "#0d1a1b",   // --bg
  rowWhite:  "#12201f",
  rowBlack:  "#0b1516",
  // 黑 = 可以填、灰 = 佔住了。選了調號就放棄黑白鍵的圖樣 —— 底色一次只講一件事，
  // 兩套訊息疊在同一個位置會變成四種深淺互相干擾。音高看左邊的鍵盤。
  rowKeyIn:  "#070d0e",   // 調內：黑，空的，把音填這裡
  rowKeyOff: "#2c3937",   // 調外：灰，佔住了
  // 音高不準的那幾列（見 config 的 GAME_MIN / GAME_MAX）照樣按得下去，所以不用「灰 = 佔
  // 住了」那組語彙，改成蓋一層半透明的暗色。琴鍵那層更重，因為白鍵很亮。
  dimRow:    "rgba(6,12,13,.34)",
  dimKey:    "rgba(6,12,13,.55)",
  // 半格（64 分）。**只在選了 64 分音符、而且縮放在最大兩檔時才畫**（見 drawGrid）。
  // 比 gridCell 更淡是必要的而不是品味：它畫在既有格線**之間**，一樣深的話會讀成「格線
  // 突然變密了兩倍」而不是「多了一層更細的」。
  gridHalf:  "rgba(35,64,63,.18)",    // 半格（64 分）
  gridCell:  "rgba(35,64,63,.35)",    // 每格（32 分）
  gridBeat:  "rgba(35,64,63,.75)",    // 每拍（8 格）
  gridBar:   "rgba(87,182,164,.30)",  // 每小節（32 格）
  gridOct:   "rgba(87,182,164,.16)",  // C 與 B 之間那條
  // 音高準／不準的兩條分界（n15|n16 與 n88|n89）。用中性的灰跟青色系的木格線分開。
  gridEdge:  "rgba(176,192,189,.55)",
  gutterBg:  "#16292b",   // --panel
  keyWhite:  "#c9d8d5",
  keyBlack:  "#1a3032",   // --panel2
  // **鍵上的字全部走這一個**：目前只有 C 音的音名那一條。
  //
  // **不能沿用 C.bg** —— 淺色主題的底是近白（`#e9eeec`），寫在白鍵（`#ffffff`）上是
  // 1.13:1，等於沒有。新增任何「畫在鍵上的字」都從這裡取色，不要再回去拿 C.bg。
  //
  // （這一格原本是一個從來沒有人用過的 keyEdge。）
  keyLabel:  "#0d1a1b",
  rulerBg:   "#122325",   // --bg2
  line:      "#23403f",   // --line
  dim:       "#7f9b98",   // --dim
  dimmer:    "#547370",   // --dimmer
  guide:     "#e0ae5a",   // --t1
  // **畫在背景上的那幾條白線**：拖曳中的原位置框、群組拖曳的預覽框、打擊的十字游標，
  // 以及當前軌的音符外框（淺色主題下最後這個改成推導，見 noteEdgeShade）。
  activeEdge: "#ffffff",
  // 被選中的音符外面那一圈（`markSelection`）。**深色主題下跟 activeEdge 同一個白**，
  // 拆出來是為了讓淺色主題把「選中」換成自己的顏色 —— 深色這邊一個像素都沒動。
  selEdge:   "#ffffff",
  hover:     "rgba(255,255,255,.6)",   // 「按下去會畫在這」的虛線框
  markStart: "#8ecdf5",   // 部份播放的基準線（淡藍）
  markEnd:   "#f2a0bb",   // 部份播放的結束線（淡粉紅）
  // 尺上的虛線游標，以及拖曳中的對齊導引（見 drawEdgeGuide）。兩者是同一種東西 ——
  // 一條「參考位置在這裡」的垂直虛線 —— 而且不會同時出現，所以共用一個顏色是對的。
  markHover: "rgba(255,255,255,.45)",
  // 框選的方框刻意偏青，跟 markStart 的淡藍分得開 —— 兩者會同時在畫面上。填色壓到
  // .16，底下的音符與格線要看得穿。
  marquee:   "rgba(126,214,223,.16)",  // 框選的填色（淡水藍）
  marqueeEdge: "rgba(168,235,240,.9)", // 框選的虛線外框
  caret:     "rgba(200,214,211,.55)",  // MML 游標在時間軸上的位置（細灰線）
  tempo:     "#57b6a4",   // --t2，小節尺上的速度標記
  // 力度標記刻意跟 tempo 是不同色相（青綠 ↔ 橘）而不是同色系的深淺：兩者會並排在
  // 同一個標籤裡（`T120 V15`），靠明度區分在 10px 的字上讀不出來。
  vel:       "#e08b4a",
  // 「這個音有問題」。用大紅色而不是軌色的深淺：它要在整片同色的音符裡一眼跳出來，
  // 而紅色在捲軸裡沒有別的用途。用途見 setBadNotes。
  bad:       "#ff3b30",
  // 有問題的小節整段染紅。底色回答「往哪邊找」（32 分卜音符只有 12px，而底色貫穿整個音域），
  // 音符大紅回答「就是這一個」。休止符只有底色標得到 —— 捲軸上休止符沒有方塊。
  badBar:    "rgba(255,59,48,.16)",
  // 拖曳中「這個音要出事了」的兩種描邊必須長得不一樣：willKill 是頭被切、整個變成休止符
  // （用跟 bad 同一個紅），willTrim 是尾巴被切、只是變短（琥珀）。這是方向鍵微調唯一的安全
  // 網 —— 往左微調 30 只是截短前一個音、往右卻會讓下一個音消失，畫面上只差 6px。
  willKill:  "#ff3b30",
  willTrim:  "#e0ae5a",
};

/**
 * **把 CSS 的 `--roll-*` 抄進上面那張 C 表。**
 *
 * canvas 沒有辦法像 CSS 那樣「宣告一次、換主題自己跟著變」—— 每一次 `fillStyle` 都是一個當
 * 下求值的字串。所以主題的真正來源放在 editor.css 的 `:root`，這裡在開站時抄一次、**主題切
 * 換時再抄一次**（`theme.onChange`，登記在 `init` 裡）。
 *
 * 上面那張表因此降級成**退路**：CSS 沒載到（離線第一次開、或 /css 被擋）時畫面還是深色可用
 * 的，而不是整片透明。兩份值必須一致，`test/theme.test.mjs` 逐項比對。
 *
 * **一次 getComputedStyle 抄 37 個，不是每次 draw 都問。** getPropertyValue 每一次都會強迫
 * 瀏覽器把樣式算完（layout thrash），而 draw() 在拖曳中是每幀都跑的。
 *
 * 讀不到（值是空字串）就**留著退路的值**：那代表這一版 CSS 還沒有這個 token，而讓它變成空
 * 字串會讓 canvas 把那一筆畫成透明黑 —— 症狀是「某一種格線整個不見了」，而且不報錯。
 */
export function readTheme(root = document.documentElement) {
  // 沒有 getComputedStyle 就留著退路表。**這不是只為了測試**：那正是「CSS 讀不到」
  // 的那條路，而讓它丟例外會讓整個 draw() 中途死掉 —— 症狀是畫面空白，不是顏色不對。
  if (typeof getComputedStyle !== "function") return;
  const cs = getComputedStyle(root);
  const ga = parseFloat(cs.getPropertyValue("--roll-ghost-alpha"));
  ghostAlpha = Number.isFinite(ga) && ga > 0 ? ga : GHOST_ALPHA;
  const aa = parseFloat(cs.getPropertyValue("--roll-aux-alpha"));
  auxAlpha = Number.isFinite(aa) && aa > 0 ? aa : AUX_ALPHA;
  const gf = parseFloat(cs.getPropertyValue("--roll-ghost-fill-alpha"));
  ghostFillAlpha = Number.isFinite(gf) && gf > 0 ? gf : GHOST_FILL_ALPHA;
  const es = parseFloat(cs.getPropertyValue("--roll-note-edge-shade"));
  noteEdgeShade = Number.isFinite(es) && es > 0 ? es : 0;
  for (const k of Object.keys(C)) {
    const v = cs.getPropertyValue("--roll-" + k.replace(/[A-Z]/g, c => "-" + c.toLowerCase())).trim();
    if (v) C[k] = v;
  }
}

const ACTIVE_ALPHA = 0.9;    // 當前軌：實心填滿
const GHOST_ALPHA  = 0.6;    // 其他的主軌：外框。**深色主題的值**，見 ghostAlpha
/**
 * 輔助軌（第 7 軌之後）的外框再淡一級：「外框疊再多層都讀得出輪廓」那句話是在 5 條別軌時
 * 取得的證據，而現在是 14 條。輔助軌被選為當前軌時照舊實心全亮。
 *
 * **深色主題的值**，見 auxAlpha。
 */
const AUX_ALPHA = 0.28;

/** 別軌音符**填色**的 alpha。**深色主題的值**，見 ghostFillAlpha。 */
const GHOST_FILL_ALPHA = 0.06;

/**
 * 別軌外框的 alpha，**跟著主題走**（`--roll-ghost-alpha` / `--roll-aux-alpha`）。
 *
 * 淺色主題下要加濃（.6 → .9、.28 → .42）：軌色是為深底調的中飽和色，同一條 .6 的線壓在
 * `#0d1a1b` 上很清楚，壓在 `#e9eeec` 上大約只有 1.5:1。
 *
 * 上面兩個常數留著當**退路**（CSS 讀不到時）與深色主題的值，同 C 表。
 */
let ghostAlpha = GHOST_ALPHA;
let auxAlpha = AUX_ALPHA;

/**
 * 別軌音符**填色**的 alpha，**跟著主題走**（`--roll-ghost-fill-alpha`）。
 *
 * 原本別軌是純外框，而一個只有框的音符在密一點的譜上要盯著看才找得到 —— 尤其是短音（一格
 * 的音框起來只有幾 px 寬，四條邊幾乎黏成一條線）。填一層薄的補上「這裡有東西」。
 *
 * **遊戲軌與輔助軌共用同一個值**，不跟著外框那邊分兩級 —— 分級由外框扛（.6 對 .28）。
 *
 * **深色 .06、淺色 .12**，跟 `ghostAlpha` 同向但幅度小得多。兩邊講的是同一句話：軌色是為
 * 深底調的中飽和色。**線**在深底上一條就夠、到淺底上要加濃；**面**在深底上一點點就亮起來，
 * 那是加法，而淺底上同樣的量是往下壓，看不太出來。
 *
 * 疊起來的濃度是 1-(1-a)^n。最壞情況 14 條別軌：深色 .58、淺色 .83。真的疊滿還是靠**逐軌的
 * 顯示開關**（見 getGhosts）。
 */
let ghostFillAlpha = GHOST_FILL_ALPHA;

/**
 * 當前軌音符外框的**加深係數**（`--roll-note-edge-shade`）。0 = 不推導，用 `C.activeEdge`。
 *
 * 淺色主題下固定色做不到：框要同時對**背景**（才看得見）與對**自己的填色**（才切得開相鄰
 * 的同音）有對比，而 15 個軌色散在整個色相環上。推導成「音符自己的顏色 × 0.45」兩邊都成立。
 */
let noteEdgeShade = 0;

const BLACK_KEYS = new Set([1, 3, 6, 8, 10]);

const rgba = (hex, a) => {
  const n = parseInt(hex.slice(1), 16);
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${a})`;
};

/** 同色相、暗一階，**不透明**。推導當前軌的音符外框用，見 noteEdgeShade。
 *  乘上係數而不是往背景色混 —— 背景偏青，往那邊混會把 15 個色相全部拉向青。 */
const dim = (hex, k) => {
  const n = parseInt(hex.slice(1), 16);
  const f = c => Math.round(c * k);
  return `rgb(${f((n >> 16) & 255)},${f((n >> 8) & 255)},${f(n & 255)})`;
};

// ─── 狀態 ───────────────────────────────────────────────────────────────────

let cv = null, g = null, pad = null, box = null;   // box = #stage，捲動容器
let song = null;          // 目前 textarea 內容解析出來的（會跟著打字變）
let active = 0;
let trackCount = () => MAX_TRACKS;
// 哪幾軌要畫（照軌號索引，true = 顯示）。這一層只讀不寫，水沒接就當全部顯示。
let getGhosts = () => [];
let onPick = () => {};
let onAdd = () => false;  // 新增音符；回傳有沒有真的寫進去
let onDelete = () => false;
let onMove = () => false; // 搬動／改音長（放開左鍵才呼叫）
let onAudition = () => {};    // 按住左側鍵盤：發出這個音（閘門，試聽的是音高）
let onAuditionEnd = () => {}; // 放開：停掉它
// 畫了一個音符、或拖曳中音高變了：把那個音符按它自己的長度彈一次（定時，不是閘門）。
let onAuditionNote = () => {};
let onPlayItem = () => {};    // 播放中「正在響的那一段原文」換了
let onRange = () => {};       // 部份播放的兩條線動了（設了、挪了、清掉）
// Shift 範圍選取：{from, to} 兩個 {tick, midi}。ui 去算原文區間並設選取，再照原路投影回來。
let onRangePick = () => {};
// Ctrl/⌘ 點一個音：加進選取或抽掉。同樣不自己維護狀態，照原路投影回來。
let onTogglePick = () => {};
/**
 * 框選：把選取設成剛好這一組音（見 ui 的 setPicks）。傳「最終想要的那一組」而不是差量 ——
 * 用 toggle 疊出來的話得靠「上一幀選了什麼」推，那份帳一定會跟真相對不上。
 */
let onSetPicks = () => {};
// 點別軌的音：切到那一軌，並選起那個音。`{ch, note}`。一個回呼而不是兩個，因為順序
// 是它的全部意義 —— `pickNote` 走 `tracks.activeArea()`，切軌前選就選到舊軌的文字上了。
let onPickGhost = () => {};
/** 一整組選取換成同長度的休止符。Delete 鍵與選單的「刪除音符」走的是同一個 ui 函式。 */
let onDeleteSel = () => {};
// 右鍵（或觸控長按）開選單。卜這一層只回報「在哪裡按了」。兩個 hook 而不是同一個加
// `note` 參數：空白處管時間軸（插刪小節、貼上），音符上管音符本身，每一列都不一樣。
let onRollMenu = () => {};
let onNoteMenu = () => {};
// 左上角那一格的右鍵。第三個 hook：那裡的位置不代表任何 tick，它問的是整首歌的拍號。
let onMeterMenu = () => {};
// 視野變了（捲動、縮放、換尺寸）。膠囊層是 DOM，自己看不到這些。
let onView = () => {};

/**
 * 段落標記在譜面上的對齊線，常駐（由 ui 在標記變動時推進來）。用壓低的透明度換「不吵」
 * （見 drawMarkLines）。
 *
 * @type {{tick:number,color:string}[]}
 */
let markLines = [];
// 小節尺上的右鍵。帶兩個 tick：連續的（兩條演奏線、力度用）與對齊到小節線的（變拍用）。
let onBarMenu = () => {};

/**
 * 拍號的 UI 要不要出現，由 ui 推進來 —— 拍號圖在「設定關掉」與「開著但這首是 4/4」兩種情況
 * 下長得一模一樣（都是 `[{0,4,4}]`），問它決定不了。
 */
let timeSigUI = false;
// 雙擊音符 → 焦點回文字區、caret 停在字尾。帶解析出來的音符物件（`srcEnd` 在它身上）。
let onJumpText = () => {};
let editable = true;      // 當前軌能不能用捲軸編輯
// 「有問題」的音符（`tick:midi`）與說明。唯讀是另一回事 —— 這些軌照樣能編。
let badKeys = new Set();
let badBars = new Set();      // 小節序號（0 起算）
let badNote = "";
let whyNot = "";          // 不能編輯的原因，顯示在工具列
// 這一軌有幾個非標準時值。**0 就是那一格不出現。** 跟 badNotes 分兩個 setter 而不是多一個
// 參數：呼叫端在這兩件事上做的是獨立的判斷，分開寫讓那個獨立性在呼叫端看得見。
let nonstdN = 0;
let onNonstdFix = null;   // 「還原」鈕。ui 沒注入就整顆不畫
let nonstdZip = false;    // 當前軌在壓縮模式嗎（那時這一格要多講一句，見 syncToolbar）

/** 滑鼠現在會畫在哪 —— 用虛線框先框出來，不然很容易畫錯一格或錯一列。 */
let hover = null;         // {tick, midi} 或 null

/**
 * **最後一次滑鼠／觸控筆在捲軸上的位置**，`Ctrl+V` 的落點就從它算（見 initClipboard）。
 *
 * 為什麼不共用既有的兩個：`hover` 只在繪製模式有值（select 模式刻意不畫那個框），
 * `markCursor` 是「按下去演奏線會落在這」而且被清得很勤 —— 兩個都不是「游標現在在哪」。
 * 這也是為什麼那行 `locate(ptr)` 從來沒接上：當時沒有東西可以接。
 *
 * **存 client 座標，不是 tick。** 畫面捲動時同一個螢幕位置指的是不同的音樂位置，而使用者
 * 要的是「現在指著的那一格」。
 *
 * **不收觸控**（`pointerType === "touch"` 在 `onPointerMove` 就分流走了）。「游標懸停在哪」
 * 是滑鼠的概念，手指抬起來之後不存在這個東西；而觸控的貼上入口是長按選單，那條路直接用
 * 長按的位置。收了手指只會製造一個沒人看得見的狀態：在第 3 小節點一下、半分鐘後接上鍵盤
 * 按 Ctrl+V，貼在一個他早就忘記的地方。
 */
let hoverPt = null;       // {clientX, clientY} 或 null

/**
 * 拖曳中竹的狀態。放開左鍵才真的改 MML。
 *
 * fineTick / fineRows 是方向鍵累積的偏移量，不能併進 `to`（updatePreview 每次都從
 * `drag.from` 重建）。lastTick / lastMidi 存 tick 而不是螢幕座標 —— xToTick 含 scrollX()。
 *
 * mode 五種：`move`、`resize`、`group`、`create`、`marquee`。`marquee` 是唯一唯讀的，而
 * `paintTrack`／`draw`／`nudge`／`endDrag` 四處都要能認出它。
 */
let drag = null;   // {mode, from, to, grabTick, grabMidi, fineTick, fineRows, lastTick, lastMidi, effect, moved, pid}
                   // create 另外有：cancel（拖進取消區）、clock（試聽算秒用）
                   // marquee 另外有：add、base、baseKeys、sig（見 startMarquee）

/**
 * 空白處按下了，但還不知道要做什麼：點一下是「設基準線」，拖一下是「框選」，由後續的位移
 * 仲裁。不先設線再收回 —— `setMarkStart` 會把播放頭拉回基準線，那是聽得出來的。
 *
 * @property {number} pid        指標編號。按下就抓 capture
 * @property {number} x0,y0      按下的螢幕座標，門檻從這裡量
 * @property {number} markTick   放開（沒拖動）要設的基準線位置，已對齊 32 分格
 * @property {number} grabTick   框的錨點（精確 tick，不吸附）
 * @property {number} grabMidi   框的錨點（音高）
 * @property {boolean} add       按下那一刻有沒有按著 Ctrl／⌘ = 這個框日是追加的
 */
let pend = null;

const RESIZE_ZONE = 5;    // 音符右邊框的抓取寬度（px）。CELL_W 至少 12 就是為了這個
                          // 縮放讓「至少 12」降級成建議 —— 縮到 4px 檔時抓取區只剩
                          // 2px，實質上抓不到。見 config.ZOOM_W

// ─── 觸控 ───────────────────────────────────────────────────────────────────
//
// `#roll` 是 `touch-action:none`，所以捲動也要自己做 —— 瀏覽器的手勢仲裁跑在合成器執行緒
// 上，比 JS 早一步收走指標。代價是原生的慣性捲動沒了。

const TAP_SLOP = 8;       // px。超過這個位移就不是「輕觸」了，改判平移
const LONG_MS = 400;      // ms。按住不動這麼久 = 長按

/**
 * px。空白處按下之後位移超過這麼多 = 這一下是框選，不是設基準線（見 `pend`）。滑鼠的門檻，
 * 比 `TAP_SLOP`（8）小一半，而且遠小於一格（12px），「想框一格」仍然表達得出來。
 */
const MARQUEE_SLOP = 4;

const EDGE_ZONE = 40;     // px。拖曳到離邊緣這麼近就開始自動捲動（約一指寬）
const EDGE_MAX = 1000;    // px/s。自動捲動的最高速（進得越深越快）

/** 目前壓在畫面上的觸控點（pointerId → client 座標）。平移要算它們的質心。 */
const touchPts = new Map();

/**
 * 觸控手勢的狀態機。滑鼠一律是 null —— 滑鼠按下時意圖就確定了，觸控按下時還沒有。
 *
 *   {kind:"pending", pid, x0, y0, at, timer}  動了 → 平移；放開 → 輕觸；不動夠久 → 長按
 *   {kind:"two", cx0, cy0, sx0, sy0}          雙指還沒判十定（見 twoMove）
 *   {kind:"pan", cx, cy}                      平移中。cx/cy 是上一幀的質心
 *   {kind:"zoom", axis, ref}                  縮放中。axis 鎖死不會中途改
 */
let gesture = null;

/** 遙桿面板上的「多選」鍵亮著沒有。亮著時輕觸一個音是加入／抽掉，而不是取代選取。 */
let multiPick = false;

/**
 * 最後一次「點鬼影切軌」的時刻。只有 `onDoubleClick` 讀它 —— 切軌之後那個音變成當前軌的音，
 * 雙擊的第二下會命中它。用時間戳而不是記音符，因為時間戳會自己過期。
 */
let ghostSwitchAt = -Infinity;

/** 上面那道閘門的窗口（ms）。比瀏覽器的雙擊容差（多為 500ms）略寬。 */
const GHOST_DBL_MS = 600;

/**
 * 遙桿驅動的虛擬滑鼠位置，內容座標 px（不含捲動位移），null = 沒在推。存 px 是因為那正是這
 * 個模型要買的東西：兩軸同一個速度單位，各方向手感一致。
 */
let padCur = null;
let onCopy = () => "";
let onPaste = () => {};
let onVelocity = () => {};
let onSelectAll = () => {};
let onDuplicate = () => {};
let isLaneArea = () => false;

// 模組層變數而不是常數：縮放就是改這兩個值然後重畫。繪圖與命中判定全部走
// tickToX / xToTick / midiToY / yToMidi / contentW / contentH，那六個都讀這裡。
let CELL_W = CELL_W0, ROW_H = ROW_H0;

/**
 * 工具列選的音符長度（也是虛線框的寬度）。
 *
 * **64 是唯一一個工具列上沒有按鈕的值**（鍵盤 `7`，見那個 keydown）。它同時是**滑鼠對齊改成
 * 半格的那個開關** —— 見 `snapDraw()` 與 `snapMove()`。
 */
let noteLen = 32;

/**
 * 接下來畫的音符帶不帶附點（長度 ×1.5）。
 *
 * **只影響「繪入」，不影響任何既有音符** —— 改既有音符走**音符選單**那一列（ui.applyDot）。
 * 兩者刻意分開，而且**入口也刻意分開**：`.` 只改工具，選單只改音符。混在一顆鍵上試過，
 * 死在「畫完會自動選起剛畫的音」這條路上（見那個 keydown branch）。
 *
 * 常用的節奏是「畫兩個八分 → `.` → 畫一個八分附點 → `.` → 繼續」，所以這顆鍵**任何時候都
 * 要切得動**，不能被選取狀態綁住。
 *
 * **不落地**，每次開站從無附點開始 —— 跟縮放同一個立場（見 config.CELL_W 那段）。一個只用
 * 一顆鍵就切得回來、而且畫面上一直看得見的狀態，不值得進偏好檔。
 *
 * `noteLen === 64` 時恆為 false（見 setNoteLength 與 toggleNoteDot）。
 */
let noteDot = false;

/**
 * 工具列七顆一組，**最多**只有一顆亮著：`"draw"`（數字鍵那六顆，點空白處畫一個 noteLen 長的音
 * 符）與 `"select"`（箭頭那顆，只搬動／改長度／刪除）。
 *
 *  **「最多」不是「永遠」**：`noteLen` 有第八種狀態（64，鍵盤 `7`），而它**不在工具列上**。
 * 那時七顆全暗 —— 那不是壞掉，是「現在的狀態不是這七顆的任何一顆」的誠實表達。看得見的回饋
 * 由別處給：虛線框變窄，以及最大兩檔縮放下多出來的那層半格線（見 drawGrid）。
 *
 * select 模式連虛線**框**都不出現：不會畫東西的時候框「會畫在這」是在騙人。它在空白處出現的
 * 是一條貫穿全高的虛線**線**（markCursor），講的是「按下去，播放範圍的線會落在這」。
 *
 * **預設是 select** —— 開站第一件事通常是看譜、點音符對照 MML。
 */
let tool = "select";

/**
 * **落點的對齊單位** —— 虛線框畫在哪、音符畫在哪。唯一的消費者是 `locate()`。
 *
 * **滑鼠與觸控筆**：平常一格（`CELL_TICKS` 60 = 32 分音符），選了 64 分音符時是**半格**
 * （`FINE_TICKS` 30）。實測 1/32 用滑鼠很好畫，所以這一半**一個 tick 都沒動**。
 *
 * **觸控**：對齊到「這個音符自己的長度」，最粗到四分音符 —— 全音符與二分音符跟四分音符
 * 一樣對齊 480。手指瞄不準 12px 一格，而畫錯一格的代價不只是位置歪掉：`insertNote` 是取代
 * 語意，往右差一格會把下一個音的**頭**切掉，那個音**整個消失**（見 nudge 那張表）。
 *
 *     noteLen   1     2     4     8    16    32    64
 *     觸控     480   480   480   240   120    60    30
 *     滑鼠      60    60    60    60    60    60    30
 *
 * 最後兩欄兩列相同，所以這不是「多加一條規則」，是把既有的兩種行為收進同一條式子 ——
 * `noteLen === 64` 那個特例在觸控這一半自然就成立。
 *
 * **對齊到固定 480，不是「小節的四分之一」。** 拍號對聲音零影響（MML 裡寫不下拍號，見
 * README「拍號」那節），把落點綁在一個純視覺的東西上，等於讓「改拍號」意外改掉畫音符的手
 * 感；而奇數拍號的 bar/4 會產生寫不出來的 tick（5/4 的 bar/4 = 600，不在 `STD_NUMS` 裡）。
 *
 * **附點不參與** —— 它只改長度不改落點，跟 `drawLen()` 那條規則一致。
 *
 * **讀 `e.pointerType`，不讀 `lastDownTouch`。** 那個旗標是**黏性**的（只在 pointerdown
 * 更新），用它的話混合裝置會漏一拍：手指碰一下之後改用滑鼠，移動游標只發 `pointermove`，
 * 於是懸停的虛線框畫在粗格上、按下去卻畫在細格上 —— **框說謊**，而 README 對虛線框的立場
 * 是會騙人就不畫。事件自己帶著「這一次是什麼輸入」，那才是這裡該問的。拿不到事件時
 * `pointerType` 是 `undefined`，落在滑鼠那條路 —— 安全的預設。
 *
 * （`body.touch` 用的是黏性的 `lastDownTouch`，那邊是對的：整站版面不能跟著每一個事件跳。
 * 同一個專案兩種判準，各有各的理由，不要順手統一它們。）
 *
 * **一定要連 `tool` 一起問，不能只看 `noteLen`。** 按 `7` 之後再按 `0` 切回箭頭時
 * `noteLen` 還留著 64 —— 少了 `tool` 這一半，使用者會在「箭頭亮著、看起來完全正常」的狀態下
 * 發現精度被永久改掉了，而畫面上沒有任何東西解釋為什麼。
 *
 * 半格落在整數像素上是**設計好的**，不是巧合：`ZOOM_W` 每一檔都取偶數，理由就寫在那裡。
 */
const snapDraw = (e) => {
  if (tool !== "draw") return CELL_TICKS;
  if (e?.pointerType === "touch") return Math.min(lenTicks(noteLen, 0), PPQ);
  return noteLen === 64 ? FINE_TICKS : CELL_TICKS;
};

/**
 * **位移量的對齊單位** —— 拖曳搬動、改長度、群組拖曳。**逐值等於分家之前的那一份**，
 * 一個 tick 都沒動。兩個消費者：`updatePreview()`、`drawGrid` 的半格線（`wantHalfGrid()`）。
 *
 * **它跟 `snapDraw()` 分家，就是「粗畫入、細微調」那條規則的全部實作。** 觸控在繪製模式下
 * 落點對齊到四分音符，但**調整**仍然是一格：長按生框後拖曳微調、長按既有音符拖移，兩條都
 * 走這裡。所以離拍的音符照樣放得進去，**不需要任何對齊開關** —— 逃生門是既有的手勢本身。
 *
 * `noteLen === 64` 那條例外**必須留在這裡**：它同時管改長度，而單位若留在一格，`to.dur`
 * 從 30 只跳得到 90，中間的 60（`l32`）表達不出來。
 *
 * **`markTickAt()` 兩個都不問** —— 演奏線與小節尺在任何工具模式下都能用，把它們的吸附精度
 * 綁在一個音符長度設定上，等於讓兩件無關的事互相影響。
 */
const snapMove = () => (tool === "draw" && noteLen === 64 ? FINE_TICKS : CELL_TICKS);

/**
 * 接下來畫出來的音符有多長（含附點）。**兩個消費者共用它**：虛線預覽框的寬度，與真的畫下去
 * 的那個音 —— 兩份會漂開的話，症狀是「框跟畫出來的不一樣長」。
 *
 * **附點不參與 `snapDraw()`** —— 它只改長度不改落點。而 `noteLen === 64` 時附點必定是關的，
 * 所以那條半格規則跟這裡碰不到。
 */
const drawLen = () => lenTicks(noteLen, noteDot ? 1 : 0);

/**
 * 被選中的音符（當前軌），畫白框標出來。唯一的真相來源是 MML 的選取範圍，這裡只是投影。
 * 存 {tick, midi} 而不是音符物件 —— 每打一個字整個 song 就被換掉。
 */
let selection = [];
/** selection 竹的 "tick:midi" 集合，拖曳與繪製時要頻繁查詢。 */
let selKeys = new Set();

const selKey = (tick, midi) => `${tick}:${midi}`;

/** ui 算好「MML 選到哪些音」之後推進來。 */
export function setSelection(list) {
  selection = Array.isArray(list) ? list : [];
  selKeys = new Set(selection.map(n => selKey(n.tick, n.midi)));
  // 選取是遙桿面板的開關，所以每次都要問一次。它也負責把新選中的音符捲進可視區。
  syncJoy();
  draw();
}

export const selectedNotes = () => selection;

/**
 * MML 游標（caret）在時間軸上的位置，畫成一條細灰線。null = 不畫。回答「我圈到哪裡了」與
 * 「現在打字進去的音會出現在哪」。只有橫向意義。
 */
let caret = null;

export function setCaret(tick) {
  const t = Number.isFinite(tick) ? tick : null;
  if (t === caret) return;
  caret = t;
  draw();
}
/**
 * 部份播放的兩條線（tick，null = 沒設）。存 tick 而不是秒：改速度之後線還要停在同一個小節
 * 上。換算成秒是要播的那一刻才做的事。
 */
let markStart = null;     // 基準線，播放從這裡開始
let markEnd = null;       // 結束線，播放到這裡停

/**
 * 那條「按下去線會落在哪」的虛線游標（已對齊 32 分音符），null = 不畫。小節尺與 select 模式
 * 的空白處共用同一個變數 —— 一個變數才保證兩邊不會漸行漸遠。
 */
let markCursor = null;

/**
 * Shift/Ctrl 範圍選取的起點，{tick, midi} 戈或 null。純左鍵點音符時更新、Shift/Ctrl 點時不動
 * —— 移動的 anchor 只會愈選愈多。認不到人時（那個音被編掉了）把 Shift+點當成純點擊。
 */
let anchor = null;

/** 左側鍵盤試聽中的音。{midi, pid} 或 null。用當前軌的音色發聲。 */
let audition = null;

/**
 * 選中的調號用到哪些音級（0–11 的 Set），null = 不使用。純視覺輔助，什麼都不擋。刻意不記進
 * 暫存：調是某一首曲子的屬性，記住反而會在載入別的曲子時給出錯的底色。
 */
let keyPcs = null;

export function setKey(pcs) {
  keyPcs = pcs instanceof Set && pcs.size ? pcs : null;
  draw();
}

let invClock = null;      // 播放中的「秒 → tick」，從 player 的快照建
/**
 * 導播線不准退到這一點之前（null = 沒有下限）。ui 在暫停時與 seek 之後設，兩個用途是同一件
 * 事：真實位置追上來之前先講一個不會騙人的答案。追上了就自己放手。見 guideTick。
 */
let guideFloor = null;
let follow = true;        // 導播線走到右緣要不要換頁
let expectScrollLeft = 0; // 用來分辨「捲動是我造成的」還是使用者自己捲的
let centered = false;     // 開站置中過了沒
let rafOn = false;

// ─── 座標 ───────────────────────────────────────────────────────────────────

// `songEndTick` 宣告在下面（1548 行附近）。這裡引用得到是因為兩個都只在**呼叫時**
// 才求值，而那時整個模組早就跑完了。
const bars = () => barsFor(songEndTick());

// 不能寫成 `bars() * CELLS_PER_BAR * CELL_W`：小節不再等長之後那個乘法沒有卜意義（3/4 是
// 24 格不是 32），而它正是捲軸能捲多遠的來源 —— 算多了尾巴有一片點不到的空白。
const contentW = () => tickToPx(contentTicks(songEndTick()), CELL_W);
const contentH = () => PITCH_ROWS * ROW_H;

const scrollX = () => box.scrollLeft;
const scrollY = () => box.scrollTop;

/** tick → 螢幕 x。內容區從 GUTTER_W 開始。 */
const tickToX = tick => GUTTER_W + tickToPx(tick, CELL_W) - scrollX();
const xToTick = x => pxToTick(x - GUTTER_W + scrollX(), CELL_W);

/** midi → 螢幕 y。高音在上。 */
const midiToY = midi => RULER_H + midiToRow(midi) * ROW_H - scrollY();
const yToMidi = y => ROLL_MAX - Math.floor((y - RULER_H + scrollY()) / ROW_H);

// ─── 建立 ───────────────────────────────────────────────────────────────────

export function init({ canvas, padEl, scroller, getTrackCount, getGhostFlags,
                       onPickNote, onAddNote, onDeleteNote, onMoveNote,
                       onAudition: audOn, onAuditionEnd: audOff, onAuditionNote: audNote,
                       onPlayItem: playItem, onRangeChange, onRangePick: rangePick,
                       onTogglePick: togglePick, onSetPicks: setPicks,
                       onPickGhost: pickGhost,
                       onDeleteSelection: delSel,
                       onCopySelection: copySel, onPasteAt: pasteTo, onVelocity: velNudge,
                       onSelectAll: selAll, onDuplicate: dupSel, isLaneArea: laneArea,
                       onContextMenu: rollMenu, onNoteMenu: noteMenu, onMeterMenu: meterMenu,
                       onViewChange: viewChange,
                       onBarMenu: barMenu,
                       onJumpText: jumpText,
                       onNonstdFix: nonstdFix } = {}) {
  cv = canvas; pad = padEl; box = scroller;
  g = cv.getContext("2d");
  // 顏色要在第一次 draw 之前就位，不然開站會閃一次退路色。
  readTheme();
  // canvas 不會自己跟著 CSS 走 —— 換主題時要重讀色票再重畫一次。
  theme.onChange(() => { readTheme(); draw(); });
  trackCount = getTrackCount ?? trackCount;
  getGhosts = getGhostFlags ?? getGhosts;
  onNonstdFix = nonstdFix ?? onNonstdFix;
  onPick = onPickNote ?? onPick;
  onAdd = onAddNote ?? onAdd;
  onDelete = onDeleteNote ?? onDelete;
  onMove = onMoveNote ?? onMove;
  onAudition = audOn ?? onAudition;
  onAuditionEnd = audOff ?? onAuditionEnd;
  onAuditionNote = audNote ?? onAuditionNote;
  onPlayItem = playItem ?? onPlayItem;
  onRange = onRangeChange ?? onRange;
  onRangePick = rangePick ?? onRangePick;
  onTogglePick = togglePick ?? onTogglePick;
  onSetPicks = setPicks ?? onSetPicks;
  onPickGhost = pickGhost ?? onPickGhost;
  onDeleteSel = delSel ?? onDeleteSel;
  onCopy = copySel ?? onCopy;
  onPaste = pasteTo ?? onPaste;
  onVelocity = velNudge ?? onVelocity;
  onSelectAll = selAll ?? onSelectAll;
  onDuplicate = dupSel ?? onDuplicate;
  isLaneArea = laneArea ?? isLaneArea;
  onRollMenu = rollMenu ?? onRollMenu;
  onNoteMenu = noteMenu ?? onNoteMenu;
  onMeterMenu = meterMenu ?? onMeterMenu;
  onView = viewChange ?? onView;
  onBarMenu = barMenu ?? onBarMenu;
  onJumpText = jumpText ?? onJumpText;

  box.addEventListener("scroll", () => {
    // 人使用者自己動水平捲軸就把跟隨關掉，不然「我想看第 30 小節」會一直被導播線拉回去。
    if (Math.abs(box.scrollLeft - expectScrollLeft) > 1) setFollow(false);
    expectScrollLeft = box.scrollLeft;
    // 導播線的 rAF 迴圈在跑的時候**不必自己畫**：捲動事件是在 scroll steps 發的，而那一步
    // 排在同一輪的 rAF 回呼**之前** —— 迴圈緊接著就會用同一個 scrollLeft 畫一次。這裡再畫
    // 一次是整張 canvas 白重畫一遍，而換頁那一幀本來就會發一個捲動事件（見 followGuide）。
    // 迴圈那一支是「draw() 之後才判斷要不要停」，所以 rafOn 為真就保證這一輪畫得到。
    if (rafOn) return;
    draw();
  }, { passive: true });

  // 用 ResizeObserver 而不是 window resize：可視區還會因為拖分隔線、捲軸出現／消失、
  // 字型載入而變化。只聽 window resize 的話最下面那列會畫不出來。
  new ResizeObserver(() => { resize(); draw(); }).observe(box);
  // passive:false 是必要的：預設 wheel 是 passive 的，那時 preventDefault() 無效。
  box.addEventListener("wheel", onWheel, { passive: false });

  // iOS Safari 竹的整頁縮放保險：`touch-action:none` 對頁面層級的 pinch 不一定攔得住，而
  // `user-scalable=no` 從 iOS 10 起就被忽略。只掛在 `#stage` 上。
  for (const t of ["gesturestart", "gesturechange", "gestureend"])
    box.addEventListener(t, e => e.preventDefault(), { passive: false });
  cv.addEventListener("pointerdown", onPointerDown);
  cv.addEventListener("pointermove", onPointerMove);
  cv.addEventListener("pointerup", e => onPointerUp(e, true));
  cv.addEventListener("pointercancel", e => onPointerUp(e, false));
  // 保險絲：指標捕捉被系統收走日時（切視窗、觸控被瀏覽器接管）也要把音停掉。
  cv.addEventListener("lostpointercapture", endAudition);
  cv.addEventListener("pointerleave", () => {
    endAudition();           // 捕捉沒抓成功時，游標離開就當作放開
    // Ctrl+V 的落點跟著游標走掉。**判準是 pointerleave，不是「locate() 回 null」** ——
    // 後者在滑過小節尺與琴鍵欄時也成立，而那時游標還在捲軸上，落點不該消失。
    hoverPt = null;
    if (drag) return;
    if (hover || markCursor !== null) { hover = null; markCursor = null; draw(); }
  });
  // 捲軸上不要跳瀏覽器的選單 —— 右鍵在這裡是刪除音符
  // ── 滑鼠一動就把面板收掉 ──────────────────────────────────────────────
  //
  // **面板是手機平板專用的**，而 `lastDownTouch` 是黏性的：它只在 `pointerdown` 更新，
  // 於是在**觸控筆電／二合一**上碰過一次螢幕之後，接下來用滑鼠移動、捲動、點工具列，
  // 面板都還賴在畫面下緣 —— 那正是「PC 跳出遙控面板」的實際成因（純滑鼠的機器叫不出
  // 它，`wantJoy` 第一項就擋掉了）。
  //
  // **移動**是比按下更早、也更明確的訊號：觸控沒有 hover，游標會動就表示手已經離開螢幕
  // 回到滑鼠上了。明文列舉 `mouse` / `pen` 而不是寫 `!== "touch"` —— 後者會把
  // `undefined`（某些瀏覽器合成的事件）也算進來，那會讓真的觸控裝置上的面板莫名閃掉。
  //
  // 只在旗標真的翻面時才 `syncToolbar()`：那一條會重算整條工具列，不能每一次 mousemove
  // 都跑。掛在 document 上而不是 canvas —— 滑鼠移到工具列上也算切回來了。
  addEventListener("pointermove", e => {
    if (!lastDownTouch) return;
    if (e.pointerType !== "mouse" && e.pointerType !== "pen") return;
    lastDownTouch = false;
    syncToolbar();
  }, { capture: true, passive: true });

  // 焦點進出文字框要重新判斷面板該不該開（見 wantJoy）。`focusout` 延到下一個 task ——
  // 從一個元素跳到另一個時它排在 `focusin` 之前，當場問 `activeElement` 會拿到 `body`，
  // 於是面板每換一次焦點都閃一下。這跟 ui 的 `initKeyboardHide` 是同一個處理。
  addEventListener("focusin", () => syncJoy());
  addEventListener("focusout", () => setTimeout(syncJoy, 0));

  cv.addEventListener("contextmenu", onContextMenu);
  // ── 觸控長按：把瀏覽器自己的選單擋掉，文字區除外 ────────────────────────
  //
  // canvas 上那個 `onContextMenu` 擋不住它，時間差在這裡：我們的選單在 `LONG_MS`（400ms）
  // 就浮出來，而瀏覽器的長按門檻更晚（Android Chrome 約 500ms）—— 那時手指底下已經是
  // `#rollMenu` 不是 canvas，事件根本不經過上面那個 listener。所以掛在 document 的**捕獲
  // 相**，跟目標是誰無關。
  //
  // **文字區刻意放行。** 在 MML 編輯框裡長按要的就是瀏覽器那套（複製、貼上、選字），那是
  // 合理的；其餘地方它只會打斷工作 —— 使用者要的選單我們自己已經開了一個。
  //
  // 只在 `lastDownTouch` 時擋：滑鼠右鍵在捲軸以外的地方（工具列、標題列）仍然拿得到瀏覽器
  // 選單，那條路沒有人抱怨過，也不該順手拿掉。
  //
  // `preventDefault` 不影響傳遞，所以 canvas 那個 handler 照樣跑、右鍵選單照樣開。
  addEventListener("contextmenu", e => {
    if (!lastDownTouch || editing(e.target)) return;
    e.preventDefault();
  }, { capture: true });
  // 雙擊音符 → MML 的 caret 跳到它的字尾（見 onDoubleClick）
  cv.addEventListener("dblclick", onDoubleClick);
  // 拖到一半後悔：Esc 取消。方向鍵微調也掛這裡 —— 它只在 drag 存在時有效，而 drag
  // 期間有 pointer capture。修飾鍵一律放行：Alt+←→ 在 Windows 是上一頁／下一頁。
  addEventListener("keydown", e => {
    // ── Esc：取水消「正在進行的那件事」；沒有進行中的事時，要取消的就是選取本身 ──
    //
    //   待判定中    丟掉，線不設、選取不動
    //   框選中      正在進行的就是選取 → 中止並清空（見 endDrag 的 marquee 分支）
    //   音符拖曳中  只取消搬動，選取保留（框好 20 個音、拖錯了不該連那 20 個一起賠掉）
    //   什麼都沒有  清空選取
    //
    // 最後那條一定要擋掉對話框與右鍵選單：這個 handler 掛在 window 上，而力度／移調那幾個
    // 框各自掛了自己的 Escape，不擋的話關框會順手清掉背後的選取。`editing()` 一起擋。
    if (e.key === "Escape") {
      endAudition();
      if (pend) {
        try { cv.releasePointerCapture(pend.pid); } catch { /* 沒抓到就算了 */ }
        pend = null;
        return;
      }
      if (drag) { endDrag(false); return; }
      if (!editing(e.target) && !document.querySelector(MODAL_SEL)
          && selection.length) {
        // 多選一起歸零：Esc 跟面板上的「取消選擇」是同一個意思（我做完了），而多選只在
        // 那兩個出口收掉。見 rolljoy.init 的 onClear。
        multiPick = false;
        onPick(null);
        draw();
      }
      return;
    }
    if (document.querySelector(MODAL_SEL)) return;
    if ((e.key === "Delete" || e.key === "Backspace") && !e.ctrlKey && !e.metaKey && !e.altKey && !e.shiftKey) {
      if (editing(e.target) || drag || !canEdit() || !selection.length) return;
      e.preventDefault(); onDeleteSel(selection); return;
    }
    if ((e.key === "+" || e.key === "-") && !e.ctrlKey && !e.metaKey && !e.altKey) {
      if (editing(e.target) || drag || !canEdit() || !selection.length) return;
      e.preventDefault(); onVelocity(e.key === "+" ? 1 : -1); return;
    }
    if ((e.ctrlKey || e.metaKey) && !e.altKey && !e.shiftKey
        && (e.key === "a" || e.key === "A")) {
      if (editing(e.target) || drag) return;
      e.preventDefault();
      onSelectAll();
      return;
    }

    // ── Ctrl+D：把選取的那一段複製接在自己後面 ──
    //
    //  **這是兩個世界唯一的例外，而例外是有理由的**：Ctrl+D 在文字區的原生行為是瀏覽器
    // 的**加入書籤**，那不是文字行為 —— 沒有東西可以讓給它。而 `selRanges` 是兩個世界共用
    // 的真相來源，所以在文字區選一段 MML 按下去，跟在捲軸框起同一段按下去**完全同義**。
    //
    // 判準是 `isLaneArea()` 而不是 `editing()` 取反：譜名輸入框、分享框、對話框裡照舊不攔
    // （在那些地方複製音符是莫名其妙的）。
    //
    // **`e.repeat` 一定要擋**：按住是 ~30 次/秒，一秒鋪 30 小節、吃掉 30 步 undo（上限
    // 80），而且每一步都真的寫進譜裡。
    if ((e.ctrlKey || e.metaKey) && !e.altKey && !e.shiftKey
        && (e.key === "d" || e.key === "D")) {
      // 焦點在**別的**輸入框（譜名、分享框…）→ 完全不管，連書籤都不擋
      if (editing(e.target) && !isLaneArea(e.target)) return;
      // 到這裡只剩兩種：捲軸的世界，或當前 lane 的文字區。**兩種都要擋掉加入書籤** ——
      // 即使這一下最後什麼都不做（沒選取、播放中），跳出書籤對話框都是純粹的干擾。
      e.preventDefault();
      if (e.repeat || drag || !canEdit()) return;
      const at = dupTick();
      if (at !== null) onDuplicate(at);
      return;
    }

    // ── `.`：切換「接下來要畫的」附點 ──
    //
    //  **它只改工具狀態，跟 `1`–`6` 完全同族**，不管有沒有選取。
    //
    //  **「有選取就改那幾個音」做過，實測拿掉了。** 那一版讓 `.` 成為全站唯一一顆意思
    // 隨狀態改變的鍵，理由是「附點同時是接下來要畫多長、與這個音多長」—— 聽起來對，實際
    // 上死在一條每次都會走到的路徑上：**畫完一個音會自動選起它**（見 commitCreate 的
    // `onPick`），於是畫完之後 `.` 永遠打在那個音上，**工具狀態再也切不回來**。
    // 而「畫一個附點音、再按 `.` 關掉」正是最自然的一組動作。
    //
    // 改既有音符的附點沒有消失，它在**音符選單**那一列（ui.applyDot）—— 那條路本來就更
    // 適合它：選單會先算合不合格，灰字在按之前就講真話，而鍵盤只能按了才報。
    //
    // 掛在這個 keydown 而不是數字鍵那個：這裡有 `editing`／`drag`／modal 三道守衛，而
    // `.` 在文字區是一個句點、拖曳中不該改工具 —— 那兩件事數字鍵那個 handler 沒有。
    if (e.key === "." && !e.ctrlKey && !e.altKey && !e.metaKey && !e.shiftKey) {
      if (editing(e.target)) return;   // 文字區裡 `.` 是打一個句點
      if (drag) return;
      e.preventDefault();
      // 箭頭模式下什麼都不做（`toggleNoteDot` 自己擋）：那時標籤顯示的是虛線框，附點沒有
      // 可見的載體（見 syncLensIcon）。要畫東西本來就得先按 1–6 切過去，那一下本來就要按。
      toggleNoteDot();
      return;
    }

    if (!drag || e.ctrlKey || e.altKey || e.metaKey) return;
    // **preventDefault 是這個功能能成立的關鍵，不是順手加的**：它擋的是 #stage 的捲動，
    // 而 xToTick 含 scrollX() —— 畫面被捲走，預覽就對不上滑鼠了。drag 期間有 pointer
    // capture，所以攔下方向鍵不會影響任何其他地方。
    //
    // **Shift 不再被擋在門外**：Shift+↑↓ 是八度、Shift+←→ 是一小節（見 nudge）。Shift 在
    // 文字區的原生行為是「延伸選取」，而拖曳中那件事本來就已經被上面那條 preventDefault
    // 擋掉了 —— 多收四顆鍵不會多影響任何地方。
    if (nudge(e.key, e.shiftKey)) e.preventDefault();
  });

  rolljoy.init({
    onStep: padStep,
    onStepEnd: padStepEnd,
    onStart: padStart,
    onMove: padMove,
    onEnd: padEnd,
    onMenu: openSelMenu,
    // 按亮／按暗多選要重跑 syncToolbar：面板那一行的「拖曳＝框選 · 雙指捲動」掛在它上面，
    // 而那句話正是在講「這顆鍵改變了單指拖曳的意思」—— 慢一拍出現等於沒有。
    onMulti: on => { multiPick = on; syncToolbar(); },
    // 刪除鍵走 Delete 的同一條路。`drag` 那道閘門也一樣：拖曳中 `drag.picks` 正指著
    // 這些音，抽掉會讓收尾對不上。
    onDelete: () => {
      if (drag || !canEdit() || !selection.length) return;
      onDeleteSel(selection.map(n => ({ tick: n.tick, midi: n.midi })));
    },
    // 取消選擇 = 清空選取，而面板的開關就掛在選取上（見 wantJoy），所以順手也收了。
    //
    // **多選也在這裡歸零，而且只在這裡。** 這顆鍵是唯一一個意思是「我做完了」的出口，其餘
    // 讓面板收起來的原因（刪光、切軌、播放、改用滑鼠）都是「還在做」，把多選一起收掉會讓
    // 「框一片 → 刪掉 → 框下一片」每一輪多三次點擊。Esc 走 onPick(null) 的另一條路，那裡
    // 也一起歸零（見 onScoreKeyDown）。
    onClear: () => { if (!drag) { multiPick = false; onPick(null); draw(); } },
  });

  initClipboard();
  initToolbar();
  resize();
}

/** canvas 只要可視區那麼大。devicePixelRatio 在這裡吃掉，之後全部用 CSS px 思考。 */
export function resize() {
  if (!cv) return;
  const w = Math.max(1, box.clientWidth), h = Math.max(1, box.clientHeight);
  const d = devicePixelRatio || 1;
  cv.style.width = w + "px";
  cv.style.height = h + "px";
  cv.width = Math.round(w * d);
  cv.height = Math.round(h * d);
  g.setTransform(d, 0, 0, d, 0, 0);
  syncPad();
  // 遙桿面板是 position:fixed 貼在狀態列上方，而狀態列會田因為視窗縮放、拖分隔線、
  // 開關狀態列、編輯區退場而移動。ResizeObserver 掛在 #stage 上，四種都涵蓋得到。
  rolljoy.place();
}

/** 讓 spacer 撐出整首歌的尺寸，捲軸才有東西可捲。 */
function syncPad() {
  // `init()` 之前呼叫是安靜的 no-op，不是 TypeError。踩過三次的坑：那個例外會一路逃出
  // `ui.init()` 讓後面每一行都不執行 —— 表現是「整個編輯器像死了但沒有明顯錯誤」。
  if (!pad) return;
  pad.style.width = (GUTTER_W + contentW()) + "px";
  pad.style.height = (RULER_H + contentH()) + "px";
}

// ─── 縮放 ───────────────────────────────────────────────────────────────────

/**
 * 換一個格寬／列高，並且讓錨點底下的那一格、那一列留在原地。
 *
 * 只收檔位表裡的值，不在表裡就當那一軸不動。預設錨點是內容區自己的中心，傳進來的也要夾
 * 進 `GUTTER_W..W` / `RULER_H..H` —— 指標停在鋼琴鍵上時算出來的「第幾格」是負的。
 *
 * @param {{w?:number, h?:number, anchor?:{x:number, y:number}}} [opts] anchor 是螢幕座標
 * @returns {boolean} 有沒有真的換檔
 */
export function setZoom({ w, h, anchor } = {}) {
  const nw = ZOOM_W.includes(w) ? w : CELL_W;
  const nh = ZOOM_H.includes(h) ? h : ROW_H;
  if (nw === CELL_W && nh === ROW_H) return false;
  if (!box) { CELL_W = nw; ROW_H = nh; return true; }

  const W = box.clientWidth, H = box.clientHeight;
  // 錨點離內容區左上角有多遠（螢幕上竹的距離，不隨縮放變）
  const ax = clamp(anchor ? anchor.x : GUTTER_W + (W - GUTTER_W) / 2, GUTTER_W, W) - GUTTER_W;
  const ay = clamp(anchor ? anchor.y : RULER_H + (H - RULER_H) / 2, RULER_H, H) - RULER_H;
  const sx = zoomScroll(scrollX(), ax, CELL_W, nw);
  const sy = zoomScroll(scrollY(), ay, ROW_H, nh);

  CELL_W = nw; ROW_H = nh;
  syncPad();
  // 上限交給瀏覽器夾（設超過 scrollWidth 會自己收回來）；下限 zoomScroll 已經夾了
  box.scrollLeft = sx;
  box.scrollTop  = sy;
  // 必須在這裡標記：上面那行會觸發 scroll 事件，而那個 handler 發現 scrollLeft 對不上就判定
  // 「使用者自己捲了」→ 關掉跟隨。讀回來而不是用算出來的值：瀏覽器夾過上限。
  expectScrollLeft = box.scrollLeft;
  syncToolbar();
  draw();
  return true;
}

/**
 * 往上／往下挪一檔。工具列的 stepper、滾輪與雙指張合都走這裡。到頂就不動（第二道防線 ——
 * 滾輪與手勢繞得過按鈕狀態）。
 *
 * @returns {boolean} 有沒有真的換檔。呼叫端靠它知道撞到底了，好把累積的位移歸零。
 */
function stepZoom(axis, dir, anchor) {
  const steps = axis === "w" ? ZOOM_W : ZOOM_H;
  const next = zoomStep(steps, axis === "w" ? CELL_W : ROW_H, dir);
  return next === null ? false : setZoom({ [axis]: next, anchor });
}

/**
 * Duplicate the selection at the same phase of a following bar.
 */
function dupTick() {
  const notes = song?.tracks[active]?.notes ?? [];
  const sel = notes.filter(n => selKeys.has(selKey(n.tick, n.midi)));
  if (!sel.length) return null;

  const start = Math.min(...sel.map(n => n.tick));
  const span = Math.max(1, Math.max(...sel.map(n => n.tick + n.durTick)) - start);
  const n0 = barIndexOf(start);
  const from = barStartTick(n0);
  // 上限只是防呆：`barStartTick` 是遞增的，正常情況下幾步就跨過 span。
  let k = 1;
  while (k < 4096 && barStartTick(n0 + k) - from < span) k++;
  return start + (barStartTick(n0 + k) - from);
}

function initClipboard() {
  const blocked = e => editing(e.target) || !!document.querySelector(MODAL_SEL) || !!drag;

  /**
   * `Ctrl+V` 貼在哪個 tick。四段優先序，第一個給得出答案的就是答案：
   *
   *   選取非空    最早那個選中音的 tick
   *   游標在捲軸上 游標指的那一格（**不夾曲末**，見 markTickAt）
   *   有基準線    演奏基準線 —— 使用者刻意設過的、而且畫面上看得見的一個時間位置
   *   都沒有      `null`，什麼都不做
   *
   * **選取排在游標前面**是知情的取捨。它的代價是「複製完馬上 Ctrl+V」會貼回原處（內容
   * 一樣，畫面上等於什麼都沒發生），要貼到別處得先點空白處取消選取 —— 而那一下本身就是
   * 一個明確的動作。反過來讓游標永遠贏則會讓「選好一組、原地覆蓋貼上」做不到。
   *
   * 退到基準線而不是退到「接在譜尾」：後者正是這次要修掉的行為，不該留成退路。
   */
  const pasteTick = () => {
    if (selection.length) return Math.min(...selection.map(n => n.tick));
    if (hoverPt) return markTickRaw(hoverPt);
    return markStart;
  };
  addEventListener("copy", e => {
    if (blocked(e) || !selection.length) return;
    const text = onCopy();
    if (!text) return;
    e.clipboardData.setData("text/plain", text); e.preventDefault();
  });
  addEventListener("cut", e => {
    if (blocked(e) || !canEdit() || !selection.length) return;
    const text = onCopy();
    if (!text) return;
    e.clipboardData.setData("text/plain", text); e.preventDefault();
    onDeleteSel(selection);
  });
  addEventListener("paste", e => {
    if (blocked(e) || !canEdit()) return;
    const at = pasteTick();
    // 四段都給不出落點時**要說話**。這條路的整個病灶就是「按了沒反應」，而靜靜地 return
    // 是同一種病 —— 說明頁（/guide/reference）本來就承諾了這句提醒，只是從來沒實作。
    if (at === null || at === undefined) { say(i18n.t("roll.paste.noWhere")); return; }
    const text = e.clipboardData?.getData("text/plain");
    if (!text?.trim()) return;
    e.preventDefault(); onPaste(at, text);
  });
}

const MODAL_SEL = ".modal.on, #rollMenu, .drawer.on";

/**
 * 滾輪一木格的位移量（正規化成像素）。必須累積而不是每個事件換一檔 —— 觸控板兩指一滑會連發
 * 二三十個 `deltaY = 4~12` 的事件，一個事件一檔的話 8 檔一滑就撞底。
 */
const WHEEL_STEP = 100;
let wheelAcc = 0, wheelAxis = null;

/**
 * Ctrl＋滾輪縮放。只掛在 `#stage` 上 —— 文字區要留給瀏覽器的整頁縮放。`Ctrl`＝格寬、
 * `Ctrl+Shift` 或 `Alt`＝列高，判斷順序上 Shift 那條必須排最前面。手機的 pinch 不產生
 * wheel，走 twoMove／zoomMove。
 */
function onWheel(e) {
  const zoomKey = e.ctrlKey || e.metaKey;
  const axis = zoomKey && e.shiftKey ? "h"
    : e.altKey && !zoomKey ? "h"
      : zoomKey ? "w"
        : null;

  // 沒有修飾鍵就交回瀏覽器：`#stage` 是原生捲動容器，垂直滾輪、Shift+滾輪、觸控板的
  // 橫向滑動全部是它自己的事。
  if (axis === null) return;
  // 攔在有沒有真的換檔之前：這個手勢是站上的，撞到底也不該掉回瀏覽器的整頁縮放
  e.preventDefault();

  // deltaMode 一定要正規化：Firefox 可能送 DOM_DELTA_LINE（`deltaY = 3` 代表一格），
  // 跟 Chrome 的 100 差 33 倍。
  const px = e.deltaMode === 1 ? e.deltaY * 16
    : e.deltaMode === 2 ? e.deltaY * box.clientHeight
      : e.deltaY;

  // 換軸或反向都把累積歸零：留著反向殘值的卜話，前幾格會被拿去抵銷，手感像卡住。
  if (axis !== wheelAxis || Math.sign(px) !== Math.sign(wheelAcc)) wheelAcc = 0;
  wheelAxis = axis;
  wheelAcc += px;

  // 往上滾（deltaY 為負）＝放大。方向看這一個事件就夠 —— 反向時累積已經歸零。
  const dir = px < 0 ? 1 : -1;
  const r = cv.getBoundingClientRect();
  const anchor = { x: e.clientX - r.left, y: e.clientY - r.top };
  while (Math.abs(wheelAcc) >= WHEEL_STEP) {
    wheelAcc -= Math.sign(wheelAcc) * WHEEL_STEP;
    if (!stepZoom(axis, dir, anchor)) {
      // 撞到頂／底：殘值不留。留著的話往回滾時會一次跳好幾檔。
      wheelAcc = 0;
      break;
    }
  }
}

// ─── 對外：內容變更 ─────────────────────────────────────────────────────────

/** MML 改了（打字、貼上、增減軌）→ 重算尺寸並重畫。 */
export function setSong(parsed) {
  song = parsed;
  syncPad();
  // 開站時把畫面對到實際有音符的音域 —— 84 列裡多數譜只用到中間三個八度。只做一次。
  if (!centered && song && song.tracks.some(t => t.notes.length)) { centered = true; centerOnNotes(); }
  draw();
}

/** 切分頁 → 實心／外框對調。不需要重新解析，只重畫。 */
export function setActive(i) {
  // 沒變就什麼都不做。這個守衛讓它變成冪等的，而那是 ui.refresh() 能無條件呼叫它的前提 ——
  // refresh() 每打一個字就跑一次，而下面那幾行會把 selection、anchor、拖曳狀態全部水清掉。
  if (i === active) return;
  active = i;
  // 選取歸零：它是「當前軌的某些音」，換軌就沒意義了。新軌的選取由 ui 推進來。
  selection = []; selKeys = new Set();
  anchor = null;      // 範圍選取的起點是「當前軌的某個音」，換軌就沒意義了（同 selection）
  lastPlayKey = null; // 換軌了，播放高亮要重新回報一次
  hover = null;       // 別軌的音符分布不同，框的位置要重新算
  drag = null;        // 拖到一半切軌就取消，不要把音符搬到別軌去
  syncToolbar();
  draw();
}

/**
 * 把某個音捲進可視範圍。已經看得到就完全不動 —— 每次點音符都置中的話畫面會一直跳，而點音符
 * 最常見的情境正是「它就在眼前」。邊界留 4 格／4 列的餘裕。
 */
export function reveal(tick, midi = null) {
  if (!box) return;
  const W = box.clientWidth, H = box.clientHeight;
  const mx = CELL_W * 4, my = ROW_H * 4;
  let dx = 0, dy = 0;

  const x = tickToX(tick);
  if (x < GUTTER_W + mx) dx = x - (GUTTER_W + mx);
  else if (x > W - mx) dx = x - (W - mx);

  // midi 是 null 表示只有時間意義（MML 的游標位置），那就不要動垂直捲動 —— 打字時
  // 畫面上下亂跳會完全沒辦法讀卜譜。
  if (midi !== null) {
    const y = midiToY(midi);
    if (y < RULER_H + my) dy = y - (RULER_H + my);
    else if (y + ROW_H > H - my) dy = y + ROW_H - (H - my);
  }

  if (!dx && !dy) return;
  const maxX = Math.max(0, GUTTER_W + contentW() - W);
  const maxY = Math.max(0, RULER_H + contentH() - H);
  const nx = Math.min(maxX, Math.max(0, box.scrollLeft + dx));
  // 標記成「這次是我捲的」，不然 scroll handler 會以為使用者動了而關掉跟隨
  expectScrollLeft = nx;
  box.scrollLeft = nx;
  box.scrollTop = Math.min(maxY, Math.max(0, box.scrollTop + dy));
}

function centerOnNotes() {
  const all = song.tracks.flatMap(t => t.notes.map(n => n.midi));
  if (!all.length) return;
  const mid = (Math.min(...all) + Math.max(...all)) / 2;
  const y = midiToRow(mid) * ROW_H - (box.clientHeight - RULER_H) / 2;
  box.scrollTop = Math.max(0, Math.min(y, RULER_H + contentH() - box.clientHeight));
}

// ─── 對外：播放 ─────────────────────────────────────────────────────────────

/**
 * 導播線的「秒 → tick」要用 player 手上那份快照的速度圖 —— 換算必須跟正在響的那些音用同一把
 * 尺。兩個時機要建：kick 與 wake，後者容易漏。
 */
function rebuildInvClock() {
  const s = player.state().song;
  invClock = s ? makeInverseClock(s.tempos) : null;
}

/** 開始演奏：導播線的時鐘要月用 player 手上那份快照的速度圖。 */
export function kick() {
  rebuildInvClock();
  setFollow(true);          // 每次重新演奏都把跟隨打開
  hover = null;             // 播放中不能編輯，框留著會騙人
  markCursor = null;
  drag = null;
  endAudition();            // 按著琴鍵時按下演奏：那個音要收掉，不然會一直疊在曲子上
  startRaf();
}

/**
 * 從暫停恢復：導播線重新開始跑（暫停時 rAF 會停下來不空轉）。一定要重建 invClock —— 暫停中
 * 編輯過的話 `player.reload()` 會換掉快照。
 */
export function wake() {
  rebuildInvClock();
  syncToolbar();
  startRaf();
}

/**
 * 把導播線釘在這個 tick，直到真實位置追上來（傳 null 立刻解除）。要 ui 給而不是捲軸自己算：
 * 暫停那一刻兩邊的速度圖還是同一份，之後一編輯就有兩個答案了。語意見 guideTick。
 */
export function setGuideFloor(tick) {
  const t = Number.isFinite(tick) ? tick : null;
  if (t === guideFloor) return;
  guideFloor = t;
  syncToolbar();     // 「演奏中」↔「暫停中」，而暫停中是可以編輯的
  draw();
}

export function stop() {
  invClock = null;
  guideFloor = null;
  lastPlayKey = null;
  syncToolbar();     // 「演奏中」變回「編輯中」
  draw();
}

function startRaf() {
  if (rafOn) return;
  rafOn = true;
  requestAnimationFrame(function loop() {
    const { playing, paused } = player.state();
    draw();
    // 暫停日時 engine.now() 是凍住的，繼續用 rAF 只是重畫同一張圖。停在這裡等 wake()。
    if (!playing || paused) { rafOn = false; return; }
    requestAnimationFrame(loop);
  });
}

/**
 * 導播線現在在哪個 tick。沒在播就回 null。匯出是因為播放快捷鍵要拿它當「播放頭現在在哪」的
 * 答案 —— 不能改用 `player.positionSec()`：seek 之後的靜音窗裡它回「目標 − LEAD」，每按一次
 * ← 就多退 0.3 秒。
 */
export function guideTick() {
  const sec = player.positionSec();
  const live = sec === null || !invClock ? null : invClock(sec);
  if (guideFloor === null) return live;

  // 有下限時導播線錨在 tick 上而不是秒上：暫停中就是要它不動，而 seek 儀式會把播放頭排在
  // LEAD 秒之後、直接放手會看到線往後彈。意思是「不准退到這一點之前」，追上來就自己放手。
  // 暫停中不放手 —— 時間沒在走就沒有「追上」這件事。
  if (!player.isPaused() && live !== null && live >= guideFloor) guideFloor = null;
  return guideFloor ?? live;
}

// ─── 繪製 ───────────────────────────────────────────────────────────────────

/**
 * 正在畫。**重入保護用的**，見 draw()。
 */
let drawing = false;

/**
 * 重畫。**外面看到的入口只有這一個**，裡面的本體是 paint()。
 *
 * 中間隔一層是為了擋掉一條繞回來的路：paint() 會叫 `reportPlayItem()` 通知 ui「現在響到哪
 * 一段原文」，而 ui 收到之後會回頭呼叫 `setSelection()` —— 那一支的最後一行是 `draw()`。
 * 於是**播放中每響一個音就會在 paint() 中間再整張重畫一次**（實測 90 幀裡多 25 次），而那
 * 一次完全是白畫的：外層還沒畫完，接下來就會把整張蓋過去。
 *
 * 丟掉是安全的，而且**一幀都不會晚**：
 *
 *   - 唯一會繞回來的路徑是播放中（`reportPlayItem` 只在 `gt !== null` 時叫），而那時 rAF
 *     迴圈每一幀都會再畫一次。
 *   - 更直接的理由是 paint() 把 `reportPlayItem()` 排在**所有繪製之前**：選取換完才開始
 *     畫，所以這一幀畫出來的就已經是新的選取了。
 */
export function draw() {
  if (drawing) return;
  drawing = true;
  try { paint(); } finally { drawing = false; }
}

function paint() {
  if (!cv) return;
  const W = box.clientWidth, H = box.clientHeight;
  if (W !== parseFloat(cv.style.width) || H !== parseFloat(cv.style.height)) resize();

  // 導播線在哪、要不要換頁 —— **都在畫之前決定**。
  //
  // 跟隨以前掛在這一支的最後面，那是錯的：畫完才捲的話，這一幀畫出來的是**舊捲動位置**
  // 的內容，而畫面已經捲到新位置了 —— 換頁的那一幀會閃一下上一頁。捲動事件要到下一輪
  // 的 scroll steps 才發得出來（它排在 rAF 回呼之前，但那是**下一輪**），補不回這一幀。
  //
  // 挪到前面之後，捲動與內容在同一幀裡就是一致的，一次就畫對。
  const gt = guideTick();
  // 只有真的在出聲時才跟隨。暫停中導播線不會前進，而 followGuide 會設 `box.scrollLeft` ——
  // 暫停中可以拖音符，而拖曳每動一下就 draw() 一次，畫面會在游標底下被反覆拉回去。
  if (gt !== null && sounding()) followGuide(gt, W);
  // 通知 ui 換段落**也在畫之前**：它會繞回來換掉選取（見 draw() 的重入保護），而選取是
  // `drawNotes` 要畫的東西之一 —— 排在畫之後的話白框會一直慢一幀。
  if (gt !== null) reportPlayItem(gt);

  g.clearRect(0, 0, W, H);
  g.fillStyle = C.bg;
  g.fillRect(0, 0, W, H);

  // 可視範圍。上下左右各留一木格餘裕，邊界上的音符才不會半截不見。
  const t0 = Math.max(0, xToTick(GUTTER_W) - CELL_TICKS);
  const t1 = xToTick(W) + CELL_TICKS;
  const rowTop = Math.max(0, Math.floor((scrollY()) / ROW_H) - 1);
  const rowBot = Math.min(PITCH_ROWS - 1, Math.ceil((scrollY() + H) / ROW_H));

  drawRows(W, rowTop, rowBot);
  // 夾在列底色與格線之間：蓋掉底色（那正是「這個小節不對」要講的），但格線與音符要
  // 留在上面 —— 染紅是背景資訊。
  drawBadBars(W, H, t0, t1);
  drawGrid(W, H, t0, t1, rowTop, rowBot);
  drawNotes(t0, t1);
  // 框選不走 drawDrag —— 它畫在最上層，因為它是「我正在圈這一塊」，蓋過音符才對。
  if (drag && drag.mode !== "marquee") drawDrag();
  else if (!drag && hover) drawHover();
  // 虛擬滑鼠畫在預覽之後：它是「我的手指指著這裡」，該壓在最上面。
  if (drag && padCur) drawPadCursor();

  if (gt !== null) drawGuide(gt, H);

  // 段落標記的對齊線畫在音符之後（被音符蓋掉就沒用了）、鍵盤與尺之前（它屬於內容區）。
  drawMarkLines(H);

  drawKeyboard(H, rowTop, rowBot);
  drawRuler(W, t0, t1);
  // 兩條範圍線與尺上竹的虛線游標畫在尺之後：它們要貫穿整張 canvas，先畫的話上面 18px
  // 會被尺的底色蓋掉，看起來像線被切了一截。
  drawMarks(H);

  // 框選的方框畫在所有東西之後：它是當下唯一在動的東西，壓在下面會被鍵盤與尺切掉兩邊。
  if (drag?.mode === "marquee") drawMarquee();

  // 畫完才通知：膠囊要對齊的是這一幀的格寬與捲動量。
  onView();
}

/**
 * 疊起來的兩個數字（中間不畫橫線 —— 18px 高的尺塞不下）。三個地方共用，必須長得一模一樣。
 *
 * @param {number} cx 水平中心
 * @param {number} cy 垂直中心（兩個數字各偏 3px）
 */
function stackedMeter(num, den, cx, cy, color) {
  g.font = 'bold 9px "IBM Plex Mono",ui-monospace,Consolas,monospace';
  g.textAlign = "center";
  g.textBaseline = "middle";
  g.fillStyle = color;
  g.fillText(String(num), cx, cy - 3);
  g.fillText(String(den), cx, cy + 3);
}

/** 疊起來之後有多寬。位數多的拍號（`12/8`）要寬一點才不會互相碰到。 */
function stackedWidth(num, den) {
  g.font = 'bold 9px "IBM Plex Mono",ui-monospace,Consolas,monospace';
  return Math.max(g.measureText(String(num)).width, g.measureText(String(den)).width) + 4;
}

/**
 * 尺上的變拍卜記號，以及「這個變拍已經捲出畫面」時的沿用指示。在尺上而不是譜面上 —— 畫在譜面
 * 會讓最上面一列音符永遠被壓著一排標籤。tick 0 不畫（曲首拍號在左上角那一格）。
 */
function drawMeterOnRuler(W, t0, t1) {
  if (!timeSigUI) return;
  g.save();
  g.beginPath();
  g.rect(GUTTER_W, 0, W - GUTTER_W, RULER_H);
  g.clip();

  // ── 沿用指示：畫面左緣生效中的拍號是某個已經捲出去的變拍 ──
  const live = meterAt(Math.max(0, t0));
  let guardRight = GUTTER_W;
  if (live.tick > 0 && live.tick < t0) {
    const w = stackedWidth(live.num, live.den);
    g.fillStyle = C.rulerBg;                     // 蓋掉底下的小節號與小節線
    g.fillRect(GUTTER_W, 1, w + 4, RULER_H - 2);
    stackedMeter(live.num, live.den, GUTTER_W + 2 + w / 2, RULER_H / 2, C.dimmer);
    guardRight = GUTTER_W + w + 6;
  }

  // 真正的變拍記號，對齊各自的小節線。偏左：記號屬於它右邊那一小節的開頭，而小節號畫在線的
  // 右邊（x+4）。樂譜上的拍號本來就寫在小節線之後、第一個音之前。
  let lastRight = -Infinity;
  for (const m of meters()) {
    if (m.tick <= 0 || m.tick < t0 || m.tick > t1) continue;
    const w = stackedWidth(m.num, m.den);
    const x = Math.round(tickToX(m.tick));
    const left = x - w - 1;
    // 擠在一起就跳過（木格寬縮到底時相鄰的變拍會疊在一起），也不要壓到沿用指示
    if (left < lastRight + 2 || left < guardRight) continue;
    lastRight = x;

    g.fillStyle = C.rulerBg;
    g.fillRect(left, 1, w, RULER_H - 2);
    stackedMeter(m.num, m.den, left + w / 2, RULER_H / 2, C.dim);
  }
  g.restore();
}

/** 黑鍵那幾列底色深一點，看譜時不用數就知道音高。 */
function drawRows(W, rowTop, rowBot) {
  for (let r = rowTop; r <= rowBot; r++) {
    const midi = ROLL_MAX - r;
    const pc = midi % 12;
    // 沒選調號 → 黑白鍵的兩色。選了 → 換成調內／調外的兩色。判斷只看音級。
    g.fillStyle = keyPcs === null
      ? (BLACK_KEYS.has(pc) ? C.rowBlack : C.rowWhite)
      : (keyPcs.has(pc) ? C.rowKeyIn : C.rowKeyOff);
    g.fillRect(GUTTER_W, midiToY(midi), W - GUTTER_W, ROW_H);
    // 音高不準的那幾列再蓋一層暗色 —— 疊在上面而不是換一組顏色，底下的圖樣才留得住
    if (!soundsAsWritten(midi)) {
      g.fillStyle = C.dimRow;
      g.fillRect(GUTTER_W, midiToY(midi), W - GUTTER_W, ROW_H);
    }
  }
}

/**
 * 有問題的小節整段染紅（見 C.badBar）。日是小節而不是那一格，因為使用者要的是「哪邊有錯」，
 * 而一格 12px 在一首兩百小節的譜裡等於看不見。高度取整個音域，同理。
 */
function drawBadBars(W, H, t0, t1) {
  if (!badBars.size) return;
  const yTop = Math.max(RULER_H, midiToY(PITCH_MAX));
  const yBot = Math.min(H, midiToY(PITCH_MIN) + ROW_H);
  if (yBot <= yTop) return;

  g.fillStyle = C.badBar;
  for (let b = Math.max(0, barIndexOf(t0)); b <= barIndexOf(t1) + 1; b++) {
    if (!badBars.has(b)) continue;
    const x0 = Math.max(GUTTER_W, Math.round(tickToX(barStartTick(b))));
    const x1 = Math.min(W, Math.round(tickToX(barStartTick(b + 1))));
    if (x1 > x0) g.fillRect(x0, yTop, x1 - x0, yBot - yTop);
  }
}

/**
 * 三層縱線（每格 / 每拍 / 每小節）＋ 橫線。同一種樣式的線收在一個 path 裡再 stroke —— 一屏
 * 可以有兩百多條縱線。
 */
const wantHalfGrid = () => snapMove() === FINE_TICKS && CELL_W >= 24;
function drawGrid(W, H, t0, t1, rowTop, rowBot) {
  const c0 = Math.max(0, Math.floor(t0 / CELL_TICKS));
  const c1 = Math.ceil(t1 / CELL_TICKS);
  const yTop = Math.max(RULER_H, midiToY(PITCH_MAX));
  const yBot = Math.min(H, midiToY(PITCH_MIN) + ROW_H);

  // 縮小時直線減層（見 config.gridStep），減竹的方式是「跳過」。小節線一律不跳過 —— 舊版靠的
  // 是算術巧合（小節線是 32 的倍數而 step 全部整除），而 3/8 的小節線落在第 12 格，step=8
  // 時會被跳掉，可是縮到底時小節線是唯一還在承載結構的東西。拍線照分母。
  const step = gridStep(CELL_W);
  const cell = new Path2D(), beat = new Path2D(), bar = new Path2D();
  for (let c = c0; c <= c1; c++) {
    const tick = c * CELL_TICKS;
    const bs = barStartTick(barIndexOf(tick));
    const isBar = tick === bs;
    if (!isBar && c % step !== 0) continue;
    const x = Math.round(tickToX(tick)) + 0.5;
    if (x < GUTTER_W || x > W) continue;
    const beatTicks = PPQ * 4 / meterAt(tick).den;
    const p = isBar ? bar : (tick - bs) % beatTicks === 0 ? beat : cell;
    p.moveTo(x, yTop); p.lineTo(x, yBot);
  }
  // 半格那層走**自己的迴圈**而不是擠進上面那個：它跟減層（`step`）、拍線、小節線都無關，
  // 而且只有一種顏色。混在一起要多兩個判斷、每一格都跑，換來的只有少一個迴圈。
  const half = new Path2D();
  if (wantHalfGrid()) {
    for (let c = c0; c <= c1; c++) {
      const x = Math.round(tickToX(c * CELL_TICKS + FINE_TICKS)) + 0.5;
      if (x < GUTTER_W || x > W) continue;
      half.moveTo(x, yTop); half.lineTo(x, yBot);
    }
  }

  g.lineWidth = 1;
  // 半格先畫：它是最細的一層，讓別的線壓在上面（實際上不會重疊 —— 半格線永遠落在兩條格線
  // 中間 —— 但順序照層級寫，下一個人才不必去驗證這件事）。
  g.strokeStyle = C.gridHalf; g.stroke(half);
  g.strokeStyle = C.gridCell; g.stroke(cell);
  g.strokeStyle = C.gridBeat; g.stroke(beat);
  g.strokeStyle = C.gridBar;  g.stroke(bar);

  // 橫線也要減層（見 config.rowLinesAt）。減的是每列那層，八度線一律留著 —— 縮到底時
  // 它是唯一卜還在承載結構的東西。
  const rowLines = rowLinesAt(ROW_H);
  const row = new Path2D(), oct = new Path2D(), edge = new Path2D();
  for (let r = rowTop; r <= rowBot + 1; r++) {
    const midi = ROLL_MAX - r;
    const y = Math.round(midiToY(midi) + ROW_H) + 0.5;
    if (y < RULER_H || y > H) continue;
    // 每一條線畫在那一列的下緣，所以「準／不準」的兩條分界是 GAME_MIN 那列的下緣
    // （n15|n16）與 GAME_MAX + 1 那列的下緣（n88|n89）
    const isEdge = midi === GAME_MIN || midi === GAME_MAX + 1;
    // midi % 12 === 0 是 C，它下面那條就是八度的分界
    const isOct = midi % 12 === 0;
    // 分界跟八度線一樣不受減層影響：縮到底時它反而更需要看得見
    if (!isOct && !isEdge && !rowLines) continue;
    const p = isEdge ? edge : isOct ? oct : row;
    p.moveTo(GUTTER_W, y);
    p.lineTo(W, y);
  }
  g.strokeStyle = C.gridCell; g.stroke(row);
  g.strokeStyle = C.gridOct;  g.stroke(oct);
  // 最後畫，所以跟八度線重疊時分界贏 —— 兩條線只能有一個顏色，而分界比較稀有。
  g.strokeStyle = C.gridEdge; g.stroke(edge);
}

/**
 * 音符。其他軌先畫（只有外框），當前軌最後畫（實心）。不用 50% 填滿，因為 alpha 0.5 疊三層
 * 就到 0.875。順序是三段：輔助軌 → 其他主軌 → 當前軌，主軌的外框才不會被淡外框弄髒。
 */
function drawNotes(t0, t1) {
  const n = Math.min(trackCount(), song ? song.tracks.length : 0);
  // 人使用者關掉顯示的軌整條跳過（見 tracks 的 ghost）。當前軌也不例外 ——「隱藏」就是
  // 隱藏。它照樣編得動（選取、Delete、文字區都在），只是看不見。
  const shown = getGhosts();
  const on = ch => shown[ch] !== false;
  for (let ch = GAME_TRACKS; ch < n; ch++) if (ch !== active && on(ch)) paintTrack(ch, t0, t1, false);
  for (let ch = 0; ch < Math.min(n, GAME_TRACKS); ch++) if (ch !== active && on(ch)) paintTrack(ch, t0, t1, false);
  if (active < n && on(active)) paintTrack(active, t0, t1, true);
  // 拖曳中不畫選取框：那些框會落在原位置，跟虛線框打架
  if (selection.length && active < n && on(active) && !drag) markSelection(t0, t1);
}

/**
 * 被選中的音符外面套一圈白框。沒有它的話「點音符 → 游標跳到 MML」只有畫面下半部一個 2 個
 * 字元的選取在動，眼睛還在捲軸上根本看不到。
 */
function markSelection(t0, t1) {
  const notes = song.tracks[active].notes;
  // **不是 C.activeEdge** —— 那個是「畫在背景上的線」，這個是「選中的高亮」。深色主題下
  // 兩者同一個白，淺色主題下分開（見 C.selEdge）。
  g.strokeStyle = C.selEdge;
  g.lineWidth = 2;
  for (const nt of notes) {
    if (nt.tick > t1) break;
    if (nt.tick + nt.durTick < t0) continue;
    if (!selKeys.has(selKey(nt.tick, nt.midi))) continue;
    const { x0, x1, y } = noteRect(nt.tick, nt.durTick, nt.midi);
    g.strokeRect(x0 - 1, y, x1 - x0 + 2, ROW_H);
  }
  g.lineWidth = 1;
}

function paintTrack(ch, t0, t1, isActive) {
  const notes = song.tracks[ch].notes;
  const col = TRACK_COLORS[ch];
  g.lineWidth = 1;
  if (isActive) {
    g.fillStyle = rgba(col, ACTIVE_ALPHA);
    // 邊框月用白色不用軌色 —— 同色邊框在同色填滿上等於沒有，於是 c4 c4 這種連續同音會
    // 看起來是一整條長音。
    //
    // **淺色主題下改成推導**（見 noteEdgeShade）：那裡沒有一個固定色能同時對背景與對
    // 自己的填色都有對比，而 15 個軌色散在整個色相環上。
    g.strokeStyle = noteEdgeShade > 0 ? dim(col, noteEdgeShade) : C.activeEdge;
  } else {
    // **別軌也填色。** 原本是純外框，而短音的框在密的譜上幾乎看不到（見 ghostFillAlpha）
    // —— 填色答的是「這裡有東西」，分級仍然由外框的 alpha 扛（遊戲軌 vs 輔助軌）。
    g.fillStyle = rgba(col, ghostFillAlpha);
    g.strokeStyle = rgba(col, ch < GAME_TRACKS ? ghostAlpha : auxAlpha);
  }

  // notes 的 tick 是不遞減的，所以看到超出右界就可以停。
  for (const nt of notes) {
    if (nt.tick > t1) break;
    if (nt.tick + nt.durTick < t0) continue;
    // 正在拖的音不畫實心 —— 它們的原位置由 drawDrag() 用虛線框標出來。框選一個音都
    // 不藏：它不搬東西，也沒有 `drag.from` 可讀。
    if (isActive && drag && drag.mode !== "marquee" && (drag.mode === "group"
      ? selKeys.has(selKey(nt.tick, nt.midi))
      : nt.tick === drag.from.tick && nt.midi === drag.from.midi)) continue;
    const { x0, x1, y } = noteRect(nt.tick, nt.durTick, nt.midi);
    const w = x1 - x0;
    // 有問題竹的音塗大紅色。只塗當前軌 —— 別軌編不到，十幾軌的紅框同時亮起來只會讓人
    // 不知道該看哪一個。（別軌現在也有薄填色了，但那一層不吃 bad。）
    const bad = isActive && badKeys.has(selKey(nt.tick, nt.midi));
    if (bad) g.fillStyle = rgba(C.bad, ACTIVE_ALPHA);
    // **兩級都填色。** 見上面的 ghostFillAlpha。
    g.fillRect(x0 + 1, y + 2, Math.max(1, w - 2), ROW_H - 4);
    // 還原，下一個音是好的。**別軌回到薄填而不是實心** —— 兩級的 fillStyle 不一樣。
    if (bad) g.fillStyle = rgba(col, isActive ? ACTIVE_ALPHA : ghostFillAlpha);
    g.strokeRect(x0 + 0.5, y + 1.5, Math.max(1, w - 1), ROW_H - 3);
  }
}

/** 音符方塊在螢幕上的位置。起點與終點各自四捨五入，相鄰的音才會剛好共邊。 */
function noteRect(tick, dur, midi) {
  const x0 = Math.round(tickToX(tick));
  const x1 = Math.max(x0 + 2, Math.round(tickToX(tick + dur)));
  return { x0, x1, y: Math.round(midiToY(midi)) };
}

const offscreen = r => r.x1 < GUTTER_W || r.x0 > box.clientWidth;

/** 虛線框（「會畫在這」、以及拖曳時的原位置）。 */
function dashedBox(tick, dur, midi) {
  const r = noteRect(tick, dur, midi);
  if (offscreen(r)) return;
  g.save();
  g.setLineDash([3, 3]);
  g.strokeStyle = C.hover;
  g.lineWidth = 1;
  g.strokeRect(r.x0 + 0.5, r.y + 1.5, Math.max(1, r.x1 - r.x0 - 1), ROW_H - 3);
  g.restore();
}

/**
 * 按下去會畫在哪：虛線框。
 * 框的寬度就是工具列選的長度，所以換音符長度時馬上看得出差別。
 */
const drawHover = () => dashedBox(hover.tick, drawLen(), hover.midi);

/** 拖曳中：原位置畫虛線框，目的地畫一個 50% 透明的音符，兩個都要畫才看得出「從哪到哪」。 */
/**
 * 拖曳中會被蓋掉的音：加一圈警告描邊，畫在預覽之後（先畫的話那個環會被蓋掉一半）。長度去
 * song 裡查（effect 只存 tick:midi），查不到就跳過。
 */
function drawEffect() {
  if (!drag.effect) return;
  const { kill, trim } = drag.effect;
  g.save();
  g.lineWidth = 2;
  for (const nt of song?.tracks[active]?.notes ?? []) {
    const k = selKey(nt.tick, nt.midi);
    const color = kill.has(k) ? C.willKill : trim.has(k) ? C.willTrim : null;
    if (!color) continue;
    const r = noteRect(nt.tick, nt.durTick, nt.midi);
    if (offscreen(r)) continue;
    g.strokeStyle = color;
    g.strokeRect(r.x0 + 1, r.y + 2, Math.max(1, r.x1 - r.x0 - 2), ROW_H - 4);
  }
  g.restore();
}

/**
 * 拖曳中的**對齊導引**：在行進方向的最前緣畫一條貫穿全高的虛線。
 *
 * 往右標**音尾**、往左標**音頭** —— 前緣正好是危險的那一邊，而那個危險是不對稱的（見
 * nudge 那張表）：往右 +30 會把下一個音的**頭**切掉，那個音**整個消失**；往左 −30 只是把
 * 前一個音的尾巴截短。畫面上兩者只差 6px，而這條線把「我這一邊現在停在哪」講清楚。
 *
 * 多選只標**最前面那一個**。每個音都標會變成一片柵欄，而要對的本來就是最外側那一條。
 *
 * **跟 `markCursor` 用同一條 `vline`**（`C.markHover`、虛線、貫穿全高），所以它也住在
 * `drawMarks()` 裡而不是 `drawDrag()` 裡 —— 那一層畫在鍵盤與尺**之後**，線才不會被尺的
 * 底色切掉最上面 18px。同一種東西（「一條垂直的參考線」）就該長得一樣、畫在同一層；兩者
 * 不會同時出現，因為 `markCursor` 只在沒有拖曳的懸停時才有值。
 *
 * 跟 `drawEffect()` 的紅／琥珀描邊分工明確：那個回答「會出事的是哪幾個音」，這條回答
 * 「我的邊現在停在哪」。
 *
 * **沒有位移就不畫** —— 還沒動的時候沒有「行進方向」，畫了是在回答一個沒被問的問題。
 */
function drawEdgeGuide(H) {
  const tick = edgeGuideAt();
  if (tick !== null) vline(tick, H, C.markHover, true);
}

/**
 * 導引線畫在哪個 tick。三種 mode 各自回答，沒有位移就回 `null`。
 * `create` 不在裡面：那個框自己就是落點，框裡再加一條線是雜訊。
 */
function edgeGuideAt() {
  if (drag.mode === "group") {
    if (!drag.dTick) return null;
    const notes = song?.tracks[active]?.notes ?? [];
    const byKey = new Map();
    for (const nt of notes) byKey.set(selKey(nt.tick, nt.midi), nt);
    let tick = null;
    for (const p of drag.picks) {
      const nt = byKey.get(selKey(p.tick, p.midi));
      if (!nt) continue;
      const t = drag.dTick > 0 ? nt.tick + drag.dTick + nt.durTick : nt.tick + drag.dTick;
      tick = tick === null ? t : (drag.dTick > 0 ? Math.max(tick, t) : Math.min(tick, t));
    }
    return tick;
  }
  if (drag.mode === "resize") {
    // 改長度只有音尾在動，方向不影響標哪一邊。
    return drag.to.dur === drag.from.dur ? null : drag.to.tick + drag.to.dur;
  }
  if (drag.mode !== "move") return null;
  const d = drag.to.tick - drag.from.tick;
  if (!d) return null;
  return d > 0 ? drag.to.tick + drag.to.dur : drag.to.tick;
}

function drawDrag() {
  if (drag.mode === "group") { drawGroupDrag(); drawEffect(); return; }
  const r = noteRect(drag.to.tick, drag.to.dur, drag.to.midi);
  if (!offscreen(r)) {
    g.fillStyle = rgba(TRACK_COLORS[active], 0.5);
    g.fillRect(r.x0 + 1, r.y + 2, Math.max(1, r.x1 - r.x0 - 2), ROW_H - 4);
    g.strokeStyle = C.activeEdge;
    g.lineWidth = 1;
    g.strokeRect(r.x0 + 0.5, r.y + 1.5, Math.max(1, r.x1 - r.x0 - 1), ROW_H - 3);
  }
  // 虛線框畫在半透明卜音符之後：改音長時兩者同一列、起點也相同。create 不畫它 —— 那個框的意思
  // 是「原本在這裡」，而新畫的音沒有原本。
  if (drag.mode !== "create") dashedBox(drag.from.tick, drag.from.dur, drag.from.midi);
  drawEffect();
}

/**
 * 多選拖曳的預覽：每個選中的音都在原位置留一個虛線框、在目的地畫半透明方塊。長度要去 song
 * 裡查（selection 只存 tick/midi），查不到就跳過。
 */
function drawGroupDrag() {
  const notes = song?.tracks[active]?.notes ?? [];
  const byKey = new Map();
  for (const nt of notes) byKey.set(selKey(nt.tick, nt.midi), nt);

  g.lineWidth = 1;
  for (const p of drag.picks) {
    const nt = byKey.get(selKey(p.tick, p.midi));
    if (!nt) continue;
    const r = noteRect(nt.tick + drag.dTick, nt.durTick, nt.midi + drag.dMidi);
    if (!offscreen(r)) {
      g.fillStyle = rgba(TRACK_COLORS[active], 0.5);
      g.fillRect(r.x0 + 1, r.y + 2, Math.max(1, r.x1 - r.x0 - 2), ROW_H - 4);
      g.strokeStyle = C.activeEdge;
      g.strokeRect(r.x0 + 0.5, r.y + 1.5, Math.max(1, r.x1 - r.x0 - 1), ROW_H - 3);
    }
    dashedBox(nt.tick, nt.durTick, nt.midi);
  }
}

/**
 * 播放中：現在響到當前十軌的哪一段原文，換了就通知 ui。休止符也算 —— 不然高亮會凍在前一個音。
 * 只在「那一段換了」時回報，不是每幀。
 */
let lastPlayKey = null;

function reportPlayItem(tick) {
  // 用 player 手上那份快照，不是目前的 song —— 導播線的 tick 是照快照算的。
  const tr = player.state().song?.tracks[active];
  const it = tr ? itemAt(tr, tick) : null;
  const key = it ? `${it.srcStart}:${it.srcEnd}` : null;
  if (key === lastPlayKey) return;
  lastPlayKey = key;
  onPlayItem(it);
}

/** 這個 tick 落在哪個音符或休止符上。兩邊都照 tick 排序，看到超過就可以停。 */
function itemAt(tr, tick) {
  for (const n of tr.notes) {
    if (n.tick > tick) break;
    if (tick < n.tick + n.durTick) return n;
  }
  for (const r of tr.rests ?? []) {
    if (r.tick > tick) break;
    if (tick < r.tick + r.dur) return r;
  }
  return null;
}

/** 貫穿竹所有列的垂直導播線。只有一個小三角在尺上的話，換頁會顯得莫名其妙。 */
function drawGuide(tick, H) {
  const x = Math.round(tickToX(tick)) + 0.5;
  if (x < GUTTER_W || x > box.clientWidth) return;
  g.strokeStyle = C.guide;
  g.lineWidth = 1;
  g.beginPath(); g.moveTo(x, RULER_H); g.lineTo(x, H); g.stroke();
}

// ─── 部份播放：基準線與結束線 ───────────────────────────────────────────────

/**
 * 一條貫穿整張 canvas 的縱線。dash 給尺上的虛線游標用；plain 表示不要在尺上加那個小方塊
 * （caret 用）。
 */
function vline(tick, H, color, dash, plain = false) {
  const x = Math.round(tickToX(tick)) + 0.5;
  if (x < GUTTER_W || x > box.clientWidth) return;
  g.save();
  if (dash) g.setLineDash([4, 4]);
  g.strokeStyle = color;
  g.lineWidth = 1;
  g.beginPath(); g.moveTo(x, 0); g.lineTo(x, H); g.stroke();
  // 尺上加一個小方塊：線本身只有 1px，捲到別的地方再捲回來時很難一眼找到。
  // caret 不加 —— 它一直在動，尺上多一個跟著跑的方塊只是雜訊。
  if (!dash && !plain) {
    g.setLineDash([]);
    g.fillStyle = color;
    g.fillRect(x - 3.5, 1, 7, 5);
  }
  g.restore();
}

function drawMarks(H) {
  // caret 畫在日最底層：它會頻繁移動，蓋掉基準線／結束線那種「設定好的東西」會很吵
  if (caret !== null) vline(caret, H, C.caret, false, true);
  if (markStart !== null) vline(markStart, H, C.markStart, false);
  if (markEnd !== null) vline(markEnd, H, C.markEnd, false);
  // 虛線游標畫最後：它跟已經設好的線重疊時，要看得出「按下去就是設在這」
  if (markCursor !== null) vline(markCursor, H, C.markHover, true);
  // 拖曳中的對齊導引跟它是同一種東西（一條垂直的參考線），所以同樣式、同一層。兩者
  // 不會同時出現：markCursor 只在沒有拖曳的懸停時才有值。
  if (drag) drawEdgeGuide(H);
}

/** 按下演奏時要播哪一段。null = 沒設限。 */
export const playRange = () => ({ fromTick: markStart, toTick: markEnd });

// ─── 給膠囊層用的三個座標 ───────────────────────────────────────────────────
//
//  段落標記的膠囊是 DOM，但要跟 canvas 對齊而格寬會被縮放改掉。與其把 CELL_W 公開讓呼叫端
//  自己算，不如直接給答案。`viewX` 回的是內容座標（不扣捲動）。

/** tick → 內容座標 x（不含左側鍵盤的寬，也不扣捲動）。 */
export const viewX = tick => tickToPx(tick, CELL_W);
/** 目前的水平捲動量。 */
export const viewScrollX = () => (box ? box.scrollLeft : 0);
/** 整首歌的內容寬度（總覽尺要算比例）。 */
export const viewWidth = () => contentW();

/**
 * 捲到某個 tick，一律捲（不像 `reveal` 那樣「看得到就不動」）—— 點段落標記的意思是「帶我
 * 去那裡」。停在左緣往右一點點，留白至少 12px。
 *
 * 用 smooth，因為這是站上唯一一個「憑空跳到很遠的地方」的操作 —— 動畫本身就是「往哪個方向、
 * 跳了多遠」那人個資訊。尊重 `prefers-reduced-motion`。副作用是「跟隨」會被關掉，而那正是要的。
 */
export function jumpTo(tick) {
  if (!box) return;
  const max = Math.max(0, GUTTER_W + contentW() - box.clientWidth);
  const left = Math.min(max, Math.max(0, viewX(tick) - Math.max(12, CELL_W)));
  // `matchMedia` 在 node 的測試環境裡不存在（見 test/_roll.mjs 的替身清單）
  const still = typeof matchMedia === "function"
    && matchMedia("(prefers-reduced-motion: reduce)").matches;
  if (box.scrollTo) box.scrollTo({ left, behavior: still ? "auto" : "smooth" });
  else box.scrollLeft = left;
  draw();
}

/**
 * 換掉對齊線的清單。比對過才重畫：這個函式跟著 `paintMarks` 走，而那個每次自動存檔、每次
 * `refresh()` 都可能被叫到。
 */
export function setMarkLines(list) {
  const next = (list ?? []).map(m => ({ tick: m.tick, color: m.color }));
  const same = next.length === markLines.length
    && next.every((m, i) => m.tick === markLines[i].tick && m.color === markLines[i].color);
  if (same) return;
  markLines = next;
  draw();
}

export const setPlayStart = tick => setMarkStart(tick);
/**
 * 回到整首播放。小節尺竹的右鍵選單用，跟工具列那顆「全部」走同一個 `clearMarks()`，所以「一律
 * 往下通知」那條規則兩邊都成立 —— 那是它唯一的逃生門語意。
 */
export const clearPlayRange = () => clearMarks();
export const setPlayEnd = tick => setMarkEnd(tick);

/**
 * 時間軸位移之後，把兩條演奏線搬到新的時間軸上。不搬的話症狀是安靜的：插了一小節之後「從
 * 第 8 小節開始播」會變成第 7 小節，而畫面上那條線看起來還在原地。用的是跟
 * `rolledit.insertTime` 同一份映射。兩條線塌到同一點就整組清掉。
 *
 * @param {number} at    位移點
 * @param {number} delta 正 = 插入，負 = 刪除
 */
export function remapMarks(at, delta) {
  const gone = [at, at - delta];        // 刪除時被吃掉的區間（delta < 0）
  const map = m => {
    if (m === null) return null;
    if (delta > 0) return m >= at ? m + delta : m;
    if (m >= gone[1]) return m + delta;
    return m > gone[0] ? gone[0] : m;   // 落在被刪區間 → 塌到接縫
  };
  markStart = map(markStart);
  markEnd = map(markEnd);
  if (markStart !== null && markEnd !== null && markEnd <= markStart) {
    clearMarks();
    return;
  }
  syncRange("shift");
  draw();
}

// ─── 左側鍵盤：按住試聽 ─────────────────────────────────────────────────────

/** 滑鼠在左側鍵盤上嗎？回傳那一列的 midi，不在就 null。 */
function keyAt(e) {
  const r = cv.getBoundingClientRect();
  const x = e.clientX - r.left, y = e.clientY - r.top;
  if (x < 0 || x >= GUTTER_W || y < RULER_H) return null;
  const midi = yToMidi(y);
  return playable(midi) ? midi : null;
}

/**
 * 開始試聽。按住不放期日間持續發聲，滑到別的鍵就換音。抓住指標，游標移出視窗也還收得到放開的
 * 事件 —— 收不到的話那個音會一直響下去。
 */
function startAudition(midi, pid) {
  if (audition?.midi === midi) return;
  if (audition) onAuditionEnd();          // 換音：先停掉上一個，不要疊在一起
  audition = { midi, pid };
  try { cv.setPointerCapture(pid); } catch { /* 抓不到也還是能用 */ }
  onAudition(midi);
  draw();
}

function endAudition() {
  if (!audition) return;
  try { cv.releasePointerCapture(audition.pid); } catch { /* 沒抓到就算了 */ }
  audition = null;
  onAuditionEnd();
  draw();
}

/** 樂曲真正結束在第幾個 tick。畫布比這個長，見 barsFor 的留白。 */
const songEndTick = () => (song ? Math.max(0, ...song.tracks.map(t => t.endTick)) : 0);

/**
 * 事件位置 → 對齊到 32 分格的 tick，**不夾**。用四捨五入而不是往下取整：這個 tick 的消費者
 * 都是「沒有寬度的一個位置」，使用者是對著格線點的（畫音符的 `snapDown` 刻意不同 —— 那個
 * 要的是「這一格」，有寬度）。
 *
 * 兩個消費者，而它們**對曲末之後的看法相反**，所以分成兩層：
 *
 *   `markTickAt()`    夾到曲末。演奏線、力度、小節增刪用
 *   這一份（不夾）     貼上用，見下面 markTickAt 的說明
 */
function markTickRaw(e) {
  const r = cv.getBoundingClientRect();
  return Math.max(0, Math.round(xToTick(e.clientX - r.left) / CELL_TICKS) * CELL_TICKS);
}

/**
 * 同上，但**夾到樂曲結尾**。
 *
 * 夾是必要的：畫布刻意比樂曲長（見 `barsFor` 的留白），而在曲末之後框出來的範圍會讓 player
 * 把播放頭 seek 過去，而那個狀態按「全部」也回不來（`setRange(null)` 走 keep 分支不動它）。
 * 表現是「只能在那個範圍播放、選全部也清不掉」。
 *
 * **貼上刻意不走這一份。** 那個夾子保護的是演奏線，而貼上被它連坐了 —— 在最後一個音右邊的
 * 空白處右鍵，`markTick` 一律等於 `songEndTick()`，於是貼上落在譜尾，跟「接在字串後面」
 * 完全一樣。而貼到曲末之後是**合理的動作**，底層早就支援（`insertNote` 會先補休止走到位，
 * 見 rolledit）。兩個消費者要的東西不同，就不該共用同一個回傳值 —— 同 `markTickAt` 刻意
 * 不問 `snapTicks()` 的理由。
 *
 * **`barTick`（小節增刪）跟著夾**，理由跟貼上相反：插入小節是「把後面的東西往後推」，而
 * 曲末之後沒有東西可推；鬆掉只會讓那兩列變成「按了沒反應」。
 *
 * 空譜不夾（維持「空譜也該能先框好要試聽的範圍」）—— 沒有音的譜按不下演奏，所以不可能卡
 * 進上面說的那個狀態。
 */
function markTickAt(e) {
  const raw = markTickRaw(e);
  const end = songEndTick();
  return end > 0 ? Math.min(end, raw) : raw;
}

/** 滑鼠在小節尺上嗎？在就回傳對齊後的 tick，不在就 null。 */
function rulerTick(e) {
  const r = cv.getBoundingClientRect();
  const x = e.clientX - r.left, y = e.clientY - r.top;
  if (y < 0 || y >= RULER_H || x < GUTTER_W || x > box.clientWidth) return null;
  return markTickAt(e);
}

function setMarkStart(tick) {
  // 先畫結束線再畫開始線的情況。擋下來而不是自動對調 —— 對調會把使用者剛設好的那條
  // 線悄悄搬走，比不動更難理解。
    if (markEnd !== null && tick >= markEnd) { say(i18n.t("roll.markStartAfterEnd")); return; }
  markStart = tick;
  // "start" 這個原因會讓 player 把播放頭拉回基準線（見 player.setRange 的 toStart）。
  // 三人個入口要分得出來 —— 挪結束線與按「全部」都不該把播放頭拉走。
  syncRange("start");
  draw();
}

function setMarkEnd(tick) {
    if (markStart !== null && tick <= markStart) { say(i18n.t("roll.markEndBeforeStart")); return; }
  markEnd = tick;
  syncRange("end");
  draw();
}

/**
 * 回到整首播放：兩條線一起清掉。不管現在有沒有線一律往下通知 —— 「捲軸上的線」與「player 手
 * 上的範圍」是兩份分開的狀態，一旦不同步，提早返回會讓「全部」變成按了沒反應的按鈕。
 */
function clearMarks() {
  markStart = markEnd = null;
  syncRange("clear");
  draw();
}

/**
 * 「全部 / 部份」不是獨立的狀態，而是兩條線的投影。三個改動入口都經過這裡，所以「線動了」
 * 的通知也掛在這裡。
 *
 * `cause` 一定要傳：播放中設基準線的意思是「從這裡播」，而挪結束線、按「全部」都不該動播放
 * 頭 —— 這三件事在 `onRange` 那端看到的新範圍可能一模一樣。init 時不傳。
 */
function syncRange(cause = null) {
  const part = markStart !== null || markEnd !== null;
  document.querySelectorAll("#rangeSel button[data-range]").forEach(b => {
    const on = (b.dataset.range === "part") === part;
    b.classList.toggle("on", on);
    b.setAttribute("aria-checked", String(on));
  });
  onRange(cause);
}

/**
 * 段落標記的對齊線，一個標記一條，常駐。
 *
 * 透日明度壓到 .38：捲軸上已經有六種線，一條全不透明的彩色線會變成畫面上最搶眼的東西，
 * 而它只是路標。不用 `vline()` —— 那個會在尺上加一個小方塊，而這裡最多 16 條，16 個
 * 方塊會把 18px 的尺塞爆。
 */
function drawMarkLines(H) {
  if (!markLines.length) return;
  g.save();
  g.globalAlpha = 0.5;
  g.lineWidth = 1;
  for (const m of markLines) {
    const x = Math.round(tickToX(m.tick)) + 0.5;
    if (x < GUTTER_W || x > box.clientWidth) continue;
    g.strokeStyle = m.color;
    g.beginPath(); g.moveTo(x, RULER_H); g.lineTo(x, H); g.stroke();
  }
  g.restore();
}

/** 左側鋼琴鍵盤。用螢幕座標畫，所以水平捲動時它自己就固定住了。 */
function drawKeyboard(H, rowTop, rowBot) {
  g.fillStyle = C.gutterBg;
  g.fillRect(0, 0, GUTTER_W, H);

  g.font = '10px "IBM Plex Mono",ui-monospace,Consolas,monospace';
  g.textAlign = "right";
  g.textBaseline = "middle";

  for (let r = rowTop; r <= rowBot; r++) {
    const midi = ROLL_MAX - r;
    const y = midiToY(midi);
    if (y + ROW_H < RULER_H || y > H) continue;
    const black = BLACK_KEYS.has(midi % 12);
    // 正在試聽的那個鍵用當前軌的顏色 —— 同時回答「按到哪一列」與「哪一軌的卜音色」
    const down = audition?.midi === midi;
    const kw = black && !down ? GUTTER_W - 14 : GUTTER_W - 1;
    g.fillStyle = down ? TRACK_COLORS[active] : black ? C.keyBlack : C.keyWhite;
    g.fillRect(0, y, kw, ROW_H - 1);
    // 音高不準的琴鍵壓暗一點。按得下去（keyAt 只看 playable），這一層只是「這裡聽到
    // 的音高不是你寫的那個」。壓在 o<n>C 標籤之前，標籤要留著看得清楚。
    if (!soundsAsWritten(midi)) {
      g.fillStyle = C.dimKey;
      g.fillRect(0, y, kw, ROW_H - 1);
    }
    if (midi % 12 === 0) {
      g.fillStyle = C.keyLabel;
      g.fillText(`o${(midi - OCT_BASE) / 12}C`, GUTTER_W - 4, y + ROW_H / 2);
    }
  }

  // 右邊界，跟內容區分開
  g.fillStyle = C.line;
  g.fillRect(GUTTER_W - 1, 0, 1, H);
  // 尺與鍵盤的交角，蓋掉伸進來的鍵
  g.fillStyle = C.rulerBg;
  g.fillRect(0, 0, GUTTER_W, RULER_H);
  g.fillStyle = C.line;
  g.fillRect(0, RULER_H - 1, GUTTER_W, 1);
  drawHeadMeter();
}

/**
 * 曲首拍號，畫在左上角那一格（鍵盤正上方、尺的左端，46×18）。
 *
 * 在這裡而不是尺上第一條小節線，因為它是「這首曲子的拍號」而不是「第 1 小節的拍號」，
 * 該一直看得到 —— 這一格用螢幕座標畫，捲到第 80 小節時它還在。而且那條 18px 的尺上
 * 已經有三樣東西在搶位置（小節號、速度、力度）。
 *
 * 兩人個數字上下各偏 3px，中間不畫橫線 —— 18px 高的格子裡再塞一條橫線只會讓兩個數字
 * 各剩 6px。
 */
function drawHeadMeter() {
  if (!timeSigUI) return;
  const m = meterAt(0);
  g.save();
  stackedMeter(m.num, m.den, GUTTER_W / 2, RULER_H / 2, C.dim);
  g.restore();
}

/** 滑鼠在左上角那一格上嗎。拍號的 UI 關掉時一律回 false（那一格就只是底色）。 */
function onHeadMeter(e) {
  if (!timeSigUI) return false;
  const r = cv.getBoundingClientRect();
  const x = e.clientX - r.left, y = e.clientY - r.top;
  return x >= 0 && x < GUTTER_W && y >= 0 && y < RULER_H;
}

/** 上方小節號尺。同理，用螢幕座標畫就不會隨垂直捲動跑掉。 */
function drawRuler(W, t0, t1) {
  g.fillStyle = C.rulerBg;
  g.fillRect(GUTTER_W, 0, W - GUTTER_W, RULER_H);
  g.fillStyle = C.line;
  g.fillRect(GUTTER_W, RULER_H - 1, W - GUTTER_W, 1);

  g.font = '10px "IBM Plex Mono",ui-monospace,Consolas,monospace';
  g.textAlign = "left";
  g.textBaseline = "middle";
  const b0 = Math.max(0, barIndexOf(t0));
  const b1 = barIndexOf(t1) + 1;
  for (let b = b0; b <= b1; b++) {
    const x = tickToX(barStartTick(b));
    if (x < GUTTER_W - 1 || x > W) continue;
    g.fillStyle = C.line;
    g.fillRect(Math.round(x), 0, 1, RULER_H);
    g.fillStyle = C.dim;
    g.fillText(String(b + 1), Math.round(x) + 4, RULER_H / 2);
  }

  // 變拍排在速度／力度之前：那兩個竹的標籤帶自己的底色會蓋過重疊到的東西，而既有的優先序是
  // 「速度與力度優先於小節號」。實際上很少撞到 —— 拍號畫在線左邊，T／V 從線往右長。
  drawMeterOnRuler(W, t0, t1);
  drawRulerMarks(W, t1);
}

/**
 * 速度與力度：在那個 tick 上畫一個倒三角，右邊寫 `T100`（青綠）或 `V15`（橘），意思都是
 * 「從這裡開始是這個值」。標籤底下墊一塊尺的底色蓋掉小節號 —— 18px 高的尺塞不下兩行字。
 *
 * 重複的值不畫（有些工具每小節都重寫一次 t113）。同一個 tick 上兩者都有的話只畫一個三角
 * 形，標籤併成 `T120 V15`。力度是當前那一軌的、速度是全曲的 —— `v` 是純軌內狀態，而 `t`
 * 從任一軌寫下去就對所有軌生效（見 mml.parseAll）。
 */
// 名字不能叫 drawMarks —— 上面那個畫的是演奏線，同名的函式宣告會直接把它蓋掉。
function drawRulerMarks(W, t1) {
  const tEvs = tempoChanges(song?.tempos);
  const vEvs = velChanges(song?.tracks?.[active]?.vels);
  if (!tEvs.length && !vEvs.length) return;

  // 併成「一個 tick 一筆」。同 tick 的 T 與 V 共用一個三角形與一塊底色，所以必須先合併
  // 才知道每一筆要畫多寬 —— 分兩輪畫的卜話後畫的那一輪會把前一輪蓋掉。
  const byTick = new Map();
  const at = tick => {
    let m = byTick.get(tick);
    if (!m) byTick.set(tick, m = { tick });
    return m;
  };
  for (const e of tEvs) if (e.tick <= t1) at(e.tick).bpm = e.bpm;
  for (const e of vEvs) if (e.tick <= t1) at(e.tick).v = e.v;

  g.save();
  // 標籤有寬度，會往左溢出到鍵盤上面去 —— 裁掉，不然會蓋到尺與鍵盤的交角
  g.beginPath();
  g.rect(GUTTER_W, 0, W - GUTTER_W, RULER_H);
  g.clip();
  g.font = 'bold 10px "IBM Plex Mono",ui-monospace,Consolas,monospace';
  g.textAlign = "left";
  g.textBaseline = "middle";

  for (const m of [...byTick.values()].sort((a, b) => a.tick - b.tick)) {
    const x = Math.round(tickToX(m.tick)) + 0.5;
    // 兩段各自有顏色，所以要分開量、分開寫。順序固定 T 先 V 後 —— 尺上同一個位置的
    // 標籤在整首歌裡都是同一個排法，眼睛才掃得快。
    const tLab = m.bpm !== undefined ? `T${m.bpm}` : "";
    const vLab = m.v !== undefined ? `V${m.v}` : "";
    const tw = g.measureText(tLab).width;
    const vw = g.measureText(vLab).width;
    const gap = tLab && vLab ? g.measureText(" ").width : 0;
    const total = tw + gap + vw;
    // 完全在可視區外才跳過（標籤往右延伸，所以左界要放寬一個標籤竹的寬度）
    if (x > W || x < GUTTER_W - total - 12) continue;

    g.fillStyle = C.rulerBg;
    g.fillRect(x - 5, 1, total + 12, RULER_H - 2);

    // 倒三角，尖端指在正確的 tick 上，跟文字一起垂直置中（尺只有 18px 高）。
    // 顏色跟著「這一筆的第一段」：有速度就是速度的色，只有力度才是橘的。
    g.fillStyle = tLab ? C.tempo : C.vel;
    g.beginPath();
    g.moveTo(x - 4, 4);
    g.lineTo(x + 4, 4);
    g.lineTo(x, 11);
    g.closePath();
    g.fill();

    if (tLab) {
      g.fillStyle = C.tempo;
      g.fillText(tLab, x + 6, RULER_H / 2);
    }
    if (vLab) {
      g.fillStyle = C.vel;
      g.fillText(vLab, x + 6 + tw + gap, RULER_H / 2);
    }
  }
  g.restore();
}

/**
 * 換頁式跟隨：導播線走出可視區就跳一整屏。連續平滑捲動看起來像 FL Studio，但畫面一直
 * 動的時候沒辦法編輯，而且手動捲去看別的地方會被一直拉回來。
 */
function followGuide(tick, W) {
  if (!follow) return;
  const pageW = Math.max(1, W - GUTTER_W);
  const cx = (tick / CELL_TICKS) * CELL_W;
  const want = Math.floor(cx / pageW) * pageW;
  const max = Math.max(0, GUTTER_W + contentW() - W);
  const target = Math.min(want, max);
  if (Math.abs(box.scrollLeft - target) < 1) return;
  expectScrollLeft = target;      // 標記成「這次是我捲的」，不要當成使用者操作
  box.scrollLeft = target;
}

// ─── 左鍵：畫音符、選音符、拖曳 ─────────────────────────────────────────────

/**
 * 左鍵：空白處畫卜音符、音符上選它並開始拖曳。「點音符 → MML 游標跳過去」同時是驗收工具 ——
 * 對得上就證明 tick ↔ 像素 ↔ 原文位置三方一致。
 */
function onPointerDown(e) {
  lastDownTouch = e.pointerType === "touch";

  // 只吃主鍵。右鍵走 contextmenu，不檢查的話右鍵點空白處會畫出音符。
  if (e.button !== 0) return;

  // 第二根手指排在所有位置判斷之前：雙指平移的兩根手指不會同時落下，而第二根落在哪裡
  // 都不該改變「這是要平移」這件事。
  if (e.pointerType === "touch") {
    touchPts.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (touchPts.size >= 2) { secondTouch(); return; }
  }

  // 尺上左鍵 = 設基準線。放在 !song 之前：空譜也該能先框好要試聽的範圍。觸控也是按下
  // 就設，不進仲裁 —— 尺只有 18px 高，在那麼窄的帶子上還要分辨「輕觸 vs 想捲動」只會
  // 讓它難按，而想捲動的手指本來就不會落在那裡。
  const rt = rulerTick(e);
  if (rt !== null) {
    if (e.pointerType !== "touch") { e.preventDefault(); setMarkStart(rt); return; }

    // 觸控要多等一下：尺上有兩種手勢，輕觸＝設基準線，長按＝開選單（觸控裝置唯一碰得
    // 到那五項的入口）。所女以設線從「按下就設」延到「放開才設」。上面那段「不進仲裁」講
    // 的是輕觸與捲動之間，那條還在 —— `menuOnly` 這個手勢對移動不敏感。
    gesture = {
      kind: "pending", pid: e.pointerId,
      x0: e.clientX, y0: e.clientY,
      at: null, menuOnly: true, rulerTick: rt,
      timer: setTimeout(holdFire, LONG_MS),
    };
    return;
  }

  // 左側鍵盤 = 按住試聽這一列的音高。跟樂譜內容無關，所以也放在 !song 之前。
  //
  // 播放中照樣作用：試聽搬到 `AUDITION_CH` 之後跟曲子沒有交集了，而「對著正在播的伴奏試
  // 和音」正是使用者要的。開放的只有左側鍵盤 —— 另外三個試聽入口播放中仍然不發聲。
  const key = keyAt(e);
  if (key !== null) {
    if (e.pointerType !== "touch") e.preventDefault();
    startAudition(key, e.pointerId);
    return;
  }

  if (!song) return;

  // 觸控從這裡分岔。下面全部是滑鼠的路，它們共同的前提是「按下的那一刻意圖就確定了」，
  // 而觸控沒有這個前提（見 gesture）。分岔而不是在每條裡加 `pointerType` 判斷 —— 那些
  // 分支已經有好幾層條件，再乘一個輸入種類會讀不動。
  if (e.pointerType === "touch") { touchDown(e); return; }

  const at = locate(e);
  if (!at) return;                              // 點在鍵盤或尺上

  // 一定要擋掉預設行為，不然焦點會被搶走：這個 listener 先跑、onPick 把游標移到
  // textarea 並 focus()，接著瀏覽器的預設行為產生 mousedown，焦點又回到 canvas —— 而
  // 水沒有焦點的 textarea 不會把選取畫出來。走到這裡的一定是滑鼠。
  const grab = () => e.preventDefault();

  // 點到已經有的音符 → 選它，並準備拖曳。真正改 MML 要等放開左鍵。
  if (at.hit) {
    grab();

    // Ctrl／⌘ + 點（不含 Shift）= toggle 這一個音。以前 Ctrl 跟 Shift 是同義的，因為選取
    // 的真相來源只能是一段連續區間；現在真相是「一組區間」（見 ui.js 的 selRanges）。
    // 試聽只在「加進來」時響，所以這個分支要排在下面那個無條件試聽的前面。
    if ((e.ctrlKey || e.metaKey) && !e.shiftKey && !sounding()) {
      if (!selKeys.has(selKey(at.hit.tick, at.hit.midi))) {
        onAuditionNote(at.hit.midi, at.hit.dur, at.hit.vel);
      }
      onTogglePick({ tick: at.hit.tick, midi: at.hit.midi });
      // 加進來的那個成為新 anchor —— 不然接著按 Shift 會從很久以前點的那個音量起來。
      anchor = { tick: at.hit.tick, midi: at.hit.midi };
      hover = null;
      draw();
      return;
    }

    // 左鍵點到音符就發一聲。放在這裡，剩下走這條分支的情形都涵蓋（純點擊、Shift 範圍
    // 選取、按在多選裡準備拖整組）。這裡必須自己擋播放中：另外兩個試聽觸發點都在
    // `canEdit()` 之下（已含 `!sounding()`），而「點音符選它」在播放中照樣會跑。
    if (!sounding()) onAuditionNote(at.hit.midi, at.hit.dur, at.hit.vel);

    // Shift + 點 = 從 anchor 到卜這個音的範圍選取，取代整個選取。選完就 return，不進拖曳
    // —— 延伸選取的手一放通常還要再看一眼，順手把整組搬走幾乎一定是意外。
    if (e.shiftKey) {
      // 播放中不做：那時的 selection 是導播高亮。anchor 認不到人（被編掉了）就退化成
      // 純點擊 —— 比什麼都不做好懂。
      const live = anchor && (song.tracks[active]?.notes ?? [])
        .some(n => n.tick === anchor.tick && n.midi === anchor.midi);
      if (live && !sounding()) {
        onRangePick({ from: { ...anchor }, to: { tick: at.hit.tick, midi: at.hit.midi } });
        hover = null;
        draw();
        return;
      }
    }

    // 按在「已經在多選裡」的音上 → 拖整組，選取不動（DAW 與檔案管理員的標準行為）。
    // 按在選取外的音 → 改成只選它，然後拖它。
    const inSel = selection.length > 1 && selKeys.has(selKey(at.hit.tick, at.hit.midi));
    if (!inSel) onPick(at.hit);
    // 純點擊才更新 anchor —— 這是「連續 Shift+點都從同一個起點量」的來源。拖整組時不
    // 動它：那不是「重新指定起點」的動作。
    if (!inSel) anchor = { tick: at.hit.tick, midi: at.hit.midi };

    if (canEdit()) {
      hover = null;
      if (inSel) {
        // 多選拖曳不提供改音長 —— 一組音符各自的長度不同，「拖右邊框」沒有一致竹的意義。
        drag = {
          mode: "group",
          picks: selection.map(n => ({ ...n })),
          dTick: 0, dMidi: 0,
          grabTick: at.rawTick,
          grabMidi: at.midi,
          ...fineInit(at),
          moved: false,
          pid: e.pointerId,
        };
      } else {
        const from = { tick: at.hit.tick, midi: at.hit.midi, dur: at.hit.durTick };
        drag = {
          mode: at.onEdge ? "resize" : "move",
          from,
          to: { ...from },
          grabTick: at.rawTick,
          grabMidi: at.midi,
          ...fineInit(at),
          moved: false,
          pid: e.pointerId,
        };
      }
      // 拖曳一開始就要重畫工具列：#rollHint 要追加「↑↓←→微調」那一句。提示只在拖曳期
      // 間出現，因為方向鍵也只在那時候有效 —— 選取時就寫的話使用者照著按會得到「選取
      // 消失」（文字區把方向鍵吃掉了），比沒有提示更糟。
      syncToolbar();
      // 抓住指標，游標移出 canvas（甚至移出視窗）也還收得到事件
      try { cv.setPointerCapture(e.pointerId); } catch { /* 抓不到也還是能用 */ }
    }
    draw();
    return;
  }

  // ── 別軌的音符上 → 切到那一軌，並選起那個音 ──
  //
  // 排在空白處那條之前（鬼影格在 `locate` 眼裡也是空白），代價日是 select 模式的鬼影格再也
  // 設不了基準線。順序：`onPickGhost` 是先 `selectTrack` 再 `pickNote`，而 `selectTrack`
  // 會走回 `setActive` 把 selection / anchor / hover / drag 全部清掉 —— 所以 anchor 只能
  // 在回呼之後設。
  //
  // 不進 drag（切軌那一瞬間畫面整批重排，手抖 2px 就搬在一條上一秒還不在的軌上）、不試聽
  // （切軌是導覽）、修飾鍵一律忽略（跨軌選取在結構上不可能）。
  if (at.ghost) {
    grab();
    onPickGhost({ ch: at.ghost.ch, note: at.ghost.note });
    anchor = { tick: at.ghost.note.tick, midi: at.ghost.note.midi };
    // 雙擊的第二下會落在「剛剛還是鬼影、現在是當前軌」的那個音上，於是 onDoubleClick
    // 會命中它、把焦點搶進文字區。記下時間，由那道閘門擋掉。
    ghostSwitchAt = performance.now();
    hover = null;
    markCursor = null;
    draw();
    return;
  }

  // 空白處 + select 模式 → 設基準線（右鍵設結束線，見 onContextMenu）。draw 模式往下走去
  // 畫音符。
  //
  // 放開才設，跟尺上不一樣（尺上維持按下就設）—— 現在空白處有兩個主人（設線／框選），要
  // 等位移仲裁，見 `pend`。尺上只有一個主人，沒有東西要仲裁。
  //
  // 點空白也順手取消選取（播放中不清 —— 那時的選取是播放高亮）。觸控有自己的一份，見
  // tapPick。
  if (!canDraw()) {
    // ── select 模式：按下先不決定，交給位移仲裁（見 pend）──
    //
    // 兩件事都延後，不是只延後設線 —— 按下就把選取清掉的話，Ctrl＋框（追加）要疊上去的那
    // 組基準當場就水沒了。
    //
    // 播放中不進這條路（走下面的舊路，按下就設線）：畫面會自動翻頁把內容從靜止的滑鼠底下
    // 抽走，框的兩端會量在不同的捲動位置上。想框就先暫停。
    //
    // `tool === "select"` 是明文閘門而不是 `!canDraw()` 的副產品（後者還含唯讀與播放中），
    // 規則才能一句話講完：箭頭工具才框選，唯讀譜照樣進得來。
    if (tool === "select" && !sounding()) {
      grab();
      pend = {
        pid: e.pointerId,
        x0: e.clientX, y0: e.clientY,
        markTick: markTickAt(e),
        grabTick: at.rawTick, grabMidi: at.midi,
        add: e.ctrlKey || e.metaKey,
      };
      // 舊路不抓 capture（按下就做完了）。這條路需要：快速拖出畫布時沒有 capture 就
      // 收不到 pointerup，pend 會卡在那裡。
      try { cv.setPointerCapture(e.pointerId); } catch { /* 抓不到也還是能用 */ }
      return;
    }

    if (!sounding()) onPick(null);
    if (tool === "select") {
      grab();
      setMarkStart(markTickAt(e));
    }
    draw();
    return;
  }
  grab();
  startCreate(e.pointerId, at);
}

/**
 * 開始畫一個音符 —— 框先出現，放開才寫進去（drag 的 "create" 模式）。
 *
 * 改掉「按下就 onAdd()」的理由是觸控：手指按下的那一刻落點就定案了，而手指本來就蓋著目標。
 * 延後到放開，中間那段就變成可以拖、可以微調、可以反悔的視窗。滑鼠竹的純點擊完全不變。
 *
 * 它是 `drag` 的一個 mode 而不是另一套狀態，於是整套既有機制自動接上。觸控兩個入口只有長按
 * 那個拿得到那段視窗（輕觸是進來就馬上 commit）。收 `pid` 而不是事件 —— 長按啟動時事件早
 * 就結束了。
 */
function startCreate(pid, at) {
  const from = { tick: at.tick, midi: at.midi, dur: drawLen() };
  drag = {
    mode: "create",
    from, to: { ...from },
    grabTick: at.rawTick,
    grabMidi: at.midi,
    ...fineInit(at),
    moved: false,
    pid,
    // 拖進左側琴鍵或上方小節尺 → 放開不寫入。觸控唯一的反悔手段（沒有 Esc）。
    cancel: false,
    // 拖曳中試聽要秒數，而框裡還沒有音符可查 —— 用速度圖現算。建一次存起來：拖曳中
    // song 不會變。
    clock: makeClock(song.tempos ?? []),
  };
  // fineInit 的力度是給「抓住的那個音」用的，create 沒有那個音 —— 改用這個位置之前
  // 最後一個音的力度當估計值（新畫的音不帶 v，它就是繼承那一個）。
  drag.audVel = velAt(at.tick);
  // 按下就響。這是畫音符最基本的回饋，不能等到放開 —— 觸控上手指還蓋著框，聲音是唯一
  // 告訴你「畫在哪一列」的東西。不必問 sounding()：canDraw() 已經含 !sounding()。
  auditionDrag(at.midi);
  hover = null;
  // 框一生成就可能已經蓋到別的音（框有長度，右邊可能壓在下一個音上），所以覆蓋預告
  // 要在這裡先算一次。
  refreshEffect();
  // #rollHint 要追加「↑↓←→微調」那一句。refreshEffect 只在計數變了才同步。
  syncToolbar();
  try { cv.setPointerCapture(pid); } catch { /* 抓不到也還是能用 */ }
  draw();
}

/**
 * 卜這個位置畫下去的音大概會多大聲：當前軌在它之前最後一個音的力度（沒有就 100）。只給
 * 拖曳中的試聽用 —— 真正寫進去之後走的是解析後的 `note.vel`。
 */
function velAt(tick) {
  let v = 100;
  for (const n of song?.tracks[active]?.notes ?? []) {
    if (n.tick > tick) break;
    v = n.vel;
  }
  return v;
}

// ─── 觸控：手勢仲裁 ─────────────────────────────────────────────────────────

/**
 * 單指按下（尺與琴鍵已經在 onPointerDown 分流掉了）。
 *
 * 一律進待判定，繪圖模式的空白處也不例外 —— 使用者是先捲動找到位置才畫，讓它例外的話每一
 * 次「我只是想捲一下」都會先生出一個不要的框。
 *
 * 分流交給後續的位移／時間：位移 > TAP_SLOP 是平移（到放開為止）、未逾時放開是輕觸、按住
 * LONG_MS 是搬動／生成框／選單。等待期間畫面完全不變 —— 那段期間手勢還可能變成捲動。
 */
function touchDown(e) {
  if (drag || gesture) return;      // 已經有手勢在跑，多的指標交給 secondTouch

  const at = locate(e);
  if (!at) return;

  gesture = {
    kind: "pending", pid: e.pointerId,
    x0: e.clientX, y0: e.clientY,
    at,
    timer: setTimeout(holdFire, LONG_MS),
  };
}

/**
 * 第二根手指落下。框已經出來就一律忽略，不管拖過沒有 —— 手掌誤觸不該抹掉一個特地按住
 * LONG_MS 才招出來的框，而它也不會擋住捲動。還在待判定時第二指仍然收掉計日時器改平移。
 */
function secondTouch() {
  if (audition) return;                 // 琴鍵試聽中：第二指不作用
  if (drag) return;                     // 已經在拖了：專心拖完
  if (gesture?.kind === "pending") clearTimeout(gesture.timer);

  // 已經鎖定的手勢不因為多一根手指改變模式（見 twoMove 的「鎖定」）。第三根手指落下時只
  // 重取一次基準 —— 質心與間距都會因為多一個點而瞬間跳掉，不重取的話那段跳會被當成位移。
  if (gesture?.kind === "zoom") { gesture.ref = spanOf(gesture.axis) ?? gesture.ref; return; }
  if (gesture?.kind === "pan") { const c = centroid(); gesture.cx = c.x; gesture.cy = c.y; return; }

  // 單指還在待判定（或什麼都沒有）→ 進雙指的待判定。**這裡刻意什麼都不做**，
  // 連平移都不先開始：pinch 的兩指幾乎同時落下，先開平移的話張合的前十幾像素
  // 會先把畫面捲走一段，而那正是使用者要縮放的那一段。
  const c = centroid(), s = span();
  gesture = s
    ? { kind: "two", cx0: c.x, cy0: c.y, sx0: s.x, sy0: s.y }
    : { kind: "pan", cx: c.x, cy: c.y };
}

/** 目前所有觸控點的質心。手指數量變了就重取一次，平移才不會跳。 */
function centroid() {
  let x = 0, y = 0;
  for (const p of touchPts.values()) { x += p.x; y += p.y; }
  const n = Math.max(1, touchPts.size);
  return { x: x / n, y: y / n };
}

/**
 * 前兩木根手指在各軸上的間距（絕對值）。少於兩指回 null。拿兩軸的間距而不是直線距離與角度，
 * 理由見 `config.pinchAxis`。三根以上只取前兩根 —— 多的那根通常是握著裝置的手掌。
 */
function span() {
  if (touchPts.size < 2) return null;
  const it = touchPts.values();
  const a = it.next().value, b = it.next().value;
  return { x: Math.abs(a.x - b.x), y: Math.abs(a.y - b.y) };
}

/** 某一軸的間距，低於 PINCH_SPAN 時回 null（不可信，見那個常數）。 */
function spanOf(axis) {
  const s = span();
  if (!s) return null;
  const v = axis === "w" ? s.x : s.y;
  return v >= PINCH_SPAN ? v : null;
}

function startPan() {
  const c = centroid();
  gesture = { kind: "pan", cx: c.x, cy: c.y };
}

/**
 * 雙指待判定 → 鎖定成「平移」或「縮放某一軸」，判完就鎖到放開為止。張合量間距變化、平移量
 * 質心位移，兩指一起移動時間距幾乎不變所以不會同時大（純算術在 `config.pinchAxis`）。不重
 * 新判定 —— 手勢進行中換模式會讓畫面跳，而使用者沒辦法靠「手穩一點」避開。
 */
function twoMove() {
  const g = gesture, s = span();
  if (!s) return;
  const c = centroid();
  const dPan = Math.hypot(c.x - g.cx0, c.y - g.cy0);

  const axis = pinchAxis(s, { x: g.sx0, y: g.sy0 }, dPan);
  if (axis) {
    gesture = { kind: "zoom", axis, ref: axis === "w" ? s.x : s.y };
    return;
  }
  if (dPan >= TAP_SLOP) startPan();
}

/**
 * 縮放中。日間距每變成 `PINCH_STEP` 倍就換一檔（判準見 `config.zoomTick`）。錨點是兩指的
 * 質心。撞到頂／底時基準照樣往前推，理由同 onWheel 的「殘值不留」。
 */
function zoomMove() {
  const g = gesture;
  const cur = spanOf(g.axis);
  if (cur === null) return;             // 那一軸縮到快重疊了：比值不可信
  const dir = zoomTick(cur, g.ref);
  if (!dir) return;
  g.ref = cur;
  const c = centroid(), rect = cv.getBoundingClientRect();
  stepZoom(g.axis, dir, { x: c.x - rect.left, y: c.y - rect.top });
}

/**
 * 平移。不做慣性 —— 這裡的捲動幾乎都是短距離對位。逐幀重取質心而不是累加位移：手指
 * 數量變化（2→1、1→2）自動就對了。
 */
function panMove() {
  const c = centroid();
  box.scrollLeft -= c.x - gesture.cx;
  box.scrollTop  -= c.y - gesture.cy;
  gesture.cx = c.x; gesture.cy = c.y;
}

/**
 * 按住滿 LONG_MS。手指還壓著，所以前兩個出口都是「接手這根手指」而不是「做完一件事」。
 *
 *   音符上（可編輯）  拿起來搬（見 holdDrag）
 *   空白處（繪圖）    生成虛線框（見 startCreate）
 *   其餘              右鍵選單
 *
 * 出口互斥，於是手機上長按不再叫得出音符卜選單。自己計時而不是聽 `contextmenu`：Android
 * Chrome 會發它、iOS Safari 在 canvas 上不可靠。
 */
function holdFire() {
  if (gesture?.kind !== "pending") return;
  const g0 = gesture;
  gesture = null;      // 手指還壓著，但這個手勢已經用掉了：放開時不要再算成輕觸
  // 尺上的長按沒有 `at`，而且只有開選單這一種結果。
  if (g0.menuOnly) { openMenu(g0.x0, g0.y0); return; }
  if (g0.at.hit && canEdit()) { holdDrag(g0); return; }
  if (!g0.at.hit && canDraw()) { startCreate(g0.pid, g0.at); return; }
  openMenu(g0.x0, g0.y0);
}

/**
 * 長按音符 → 拿起來搬。這推翻了「觸控不拖動既有音符」那條決定，而推翻它的正是長按門檻本身
 * —— 想捲動的手指一定在動，一動就判成平移且到放開為止都是平移。
 *
 * 跟滑鼠共用 `drag` 的既有 mode，覆蓋預告、破壞警告、試聽、預覽、自動捲動全部自動接上。
 * 差別只有兩條：不做改長度（手指瞄不準那條窄邊，而拉長會吃掉下一個音）、不做修飾鍵。
 */
function holdDrag(g0) {
  const at = g0.at, hit = at.hit;
  const inSel = selection.length > 1 && selKeys.has(selKey(hit.tick, hit.midi));

  const base = {
    grabTick: at.rawTick, grabMidi: at.midi,
    ...fineInit(at),
    moved: false, pid: g0.pid,
  };
  // 先建 drag 再改選取：onPick 會一路走到 syncJoy，而面板剛打開時會把選中的音符捲進
  // 可視區 —— 那一下捲動會把音符從手指底下抽走。syncJoy 田因此問 `!drag`。
  if (inSel) {
    drag = { mode: "group", picks: selection.map(n => ({ ...n })), dTick: 0, dMidi: 0, ...base };
  } else {
    const from = { tick: hit.tick, midi: hit.midi, dur: hit.durTick };
    drag = { mode: "move", from, to: { ...from }, ...base };
    onPick(hit);
    // 純點擊才更新 anchor，跟滑鼠一致 —— 拖整組不是「重新指定起點」。
    anchor = { tick: hit.tick, midi: hit.midi };
  }

  // 拿起來就響，跟畫音符按下就響同一個理由：手指蓋著音符，聲音是唯一告訴你「抓到的是
  // 哪一個」的東西。`canEdit()` 已含 `!sounding()`。
  onAuditionNote(hit.midi, hit.dur, hit.vel);
  hover = null;
  syncToolbar();
  try { cv.setPointerCapture(g0.pid); } catch { /* 抓不到也還是能用 */ }
  draw();
}

/**
 * 輕觸（沒超過門檻就放開）。按下時不選、放開才選是刻意的：按下就選的話，想捲動時會順手改掉
 * 選取，而選取連動 MML 的文字選取 —— 捲個畫面就把 caret 拉走。
 */
function tapPick(g0) {
  const at = g0.at;

  // ── 繪圖模式的空白處：輕點就是畫在按下的那一格 ──
  //
  // 沒有這條的話每一個音都要付 LONG_MS。三段語意各司其職：先移動＝捲動、輕點＝直接畫、
  // 按住＝出框微調。走完整的 startCreate → endDrag(true) 而不直接 onAdd，因為覆蓋預告、
  // 按下那一聲試聽、畫完選中新音符全十都掛在那條路上。
  if (!at.hit && canDraw()) {
    startCreate(g0.pid, at);
    endDrag(true);
    return;
  }

  if (at.hit) {
    const key = selKey(at.hit.tick, at.hit.midi);
    const picked = selKeys.has(key);

    // ── 多選模式：點一個音就加進來／抽掉，也就是 Ctrl+點的語意 ──
    //
    // 手機沒有修飾鍵，這是多選唯一的入口。抽掉時不試聽 —— 聽到它響會像是加進去了。
    if (multiPick) {
      if (!picked && !sounding()) onAuditionNote(at.hit.midi, at.hit.dur, at.hit.vel);
      onTogglePick({ tick: at.hit.tick, midi: at.hit.midi });
      anchor = { tick: at.hit.tick, midi: at.hit.midi };
      draw();
      return;
    }

    // ── 曾經有一條「再點一次唯一選中的那個音 = 取消選取」，退役了 ──
    //
    // 它存在的理由是「另一條出口（點空白處）在密譜上可能找不到空白」，而空白處**不再是
    // 出口**（見下面那一段）之後，它變成孤兒 —— 而且剛好是誤觸最容易踩到的形狀：想點音符、
    // 點到同一個、整組選取沒了。在一個專門為了防誤觸而做的改動裡，它是唯一沒堵的洞。
    //
    // 現在直接落到下面那條「點音符＝選它」：對已經選中的那一個而言選取沒有變化，只是重新
    // 試聽一次。**不早退成完全無反應**是刻意的 —— 手指蓋著音符時聲音是唯一的回饋，而「按了
    // 什麼都沒發生」比「按了聽到它響」更像壞掉。
    if (!sounding()) onAuditionNote(at.hit.midi, at.hit.dur, at.hit.vel);
    // 點任何音符都是取代選取。要同時選好幾個就先按面板上的「多選」鍵（見 multiPick）。
    onPick(at.hit);
    anchor = { tick: at.hit.tick, midi: at.hit.midi };
    draw();
    return;
  }

  // ── 面板開著時，這一下完全不算數 ──
  //
  // 選取不動、播放線也不動、什麼都不做。這條原本是「點外面＝關掉」（照 rollmenu 的
  // `onOutside`），而**那個類比是錯的**：右鍵選單是臨時浮層，點外面表示「我不選了」；
  // 遙桿面板是使用者正在裡面工作的地方，點外面通常表示「我手滑了」。
  //
  // 誤觸在手機平板上不是邊緣情況，是常態 —— 扶著平板的拇指、手掌邊緣、想捲動時落點沒對
  // 準。而在這個模式裡誤觸一次的代價是整組選取加上多選狀態一起沒了，重來要好幾步。
  //
  // 代價是**面板開著時設不了播放基準線**。那個入口沒有消失，先「取消選擇」就回來了；而在
  // 面板開著的時候，使用者的注意力明確在「調這個音」上，此時設線幾乎必然是誤觸。
  if (rolljoy.isOpen()) return;

  // 空白處：取消選取，並設播放基準線 —— 跟滑鼠完全一致。位移門檻消滅了「輕觸會在想捲
  // 動時誤設線」那條理由，手機因此第一次有了設播放範圍的入口。
  if (!sounding()) onPick(null);
  if (tool === "select") setMarkStart(markTickAt({ clientX: g0.x0, clientY: g0.y0 }));
  draw();
}

function onTouchMove(e) {
  const p = touchPts.get(e.pointerId);
  if (p) { p.x = e.clientX; p.y = e.clientY; }

  // 琴鍵上滑動換音（像在真的鍵盤上滑手指）
  if (audition && audition.pid === e.pointerId) {
    const k = keyAt(e);
    if (k !== null) startAudition(k, audition.pid);
    return;
  }
  // 雙指那三個狀態排在 drag 之前，同 `secondTouch` 排在所有位置判斷之前的理由。
  if (gesture?.kind === "two") { twoMove(); return; }
  if (gesture?.kind === "zoom") { zoomMove(); return; }
  if (gesture?.kind === "pan") { panMove(); return; }
  if (drag) { if (e.pointerId === drag.pid) onDragMove(e); return; }
  if (gesture?.kind !== "pending" || gesture.pid !== e.pointerId) return;

  // 待判定 → 動了。多選亮著時空白處是框選，其餘一律平移。長按的計時器要一起收掉：手指
  // 在動就不日是長按。
  if (Math.hypot(e.clientX - gesture.x0, e.clientY - gesture.y0) <= TAP_SLOP) return;
  clearTimeout(gesture.timer);
  if (wantTouchMarquee(gesture)) { startTouchMarquee(e); return; }
  startPan();
}

/**
 * **空白處的單指拖曳現在是不是框選。** 這是整件事的判準，而且**只有這一份** ——
 * 手勢（`wantTouchMarquee`）與面板上那行說明（`syncToolbar`）都問它。
 *
 * 分成兩層是踩過的：說明只問 `multiPick`、手勢多問一個 `tool` 的話，**繪製模式下多選亮
 * 著時那行字會說謊** —— 它寫著「拖曳空白處＝框選」，而實際上單指拖曳仍然是平移。說明文字
 * 不能說錯話，而唯一保證它不會漂開的辦法是讓兩邊讀同一個函式。
 *
 *   多選亮著  單指拖曳＝平移是承重牆。按亮多選是使用者明確表態「我現在在選東西」，
 *             那一刻才有資格把它借走
 *   只選取    繪製模式的空白處拖曳已經有主人（長按生框、拖曳微調），而那條路是手機上唯一
 *             的精確落點入口，不能拿走 —— **所以繪製模式下單指照樣捲得動畫面**
 *   不在播放  畫面會自動翻頁，框的兩端會量在不同的捲動位置上
 */
const marqueeArmed = () => multiPick && tool === "select" && !sounding();

/**
 * 這一次的拖曳該不該升級成框選 = `marqueeArmed()` 再加兩個**只有這一次手勢才知道**的條件：
 *
 *   空白起手  按在音符上仍然是平移。PC 的框選也只從空白起手，而它在觸控上順帶就是**捲動
 *             的逃生門** —— 多選亮著時，從任何一個音符上起手都還能單指捲動
 *   有 `at`   尺上的手勢沒有它（見 onTouchUp 的 menuOnly）
 *
 * 門檻沿用 `TAP_SLOP`（8px）而不是滑鼠那邊的 `MARQUEE_SLOP`（4px）：手指本來就抖，4px 會
 * 讓「想輕點一個音卻拉出一個框」變成常態。
 */
const wantTouchMarquee = g => marqueeArmed() && !!g.at && !g.at.hit;

/**
 * 待判定 → 框選。借 `pend` 那條既有的路：`startMarquee` 讀的就是它，於是 Esc 取消、
 * pointerup 路由、邊緣自動捲動、每幀重算與「命中的那組音變了才提交」那道閘門**一項都不用
 * 重做**。觸控框選因此不是一個新功能，是既有手勢多了一個入口。
 *
 * `add: true` 是寫死的 —— 觸控沒有修飾鍵，而多選亮著的語意就是 PC 的 <kbd>Ctrl</kbd>：
 * **純追加**，框到已經選中的音維持選中，不反向。要抽掉某一個仍然是輕觸它（`tapPick` 的
 * multiPick 分支，那裡是 toggle）。「點是 toggle、框是純加」這個不對稱跟 PC 逐字相同，
 * 所以一句話都不必多解釋。
 */
function startTouchMarquee(e) {
  const g0 = gesture;
  gesture = null;
  pend = {
    pid: g0.pid, x0: g0.x0, y0: g0.y0,
    markTick: 0,                                  // 框選不設線，這個欄位走不到
    grabTick: g0.at.rawTick, grabMidi: g0.at.midi,
    add: true,
  };
  // 滑鼠那條路在按下時就抓好了 capture，觸控的待判定沒抓 —— 這裡補上，不然手指滑出
  // canvas（或滑到面板上）之後就收不到 pointermove，框會停在半路。
  try { cv.setPointerCapture(g0.pid); } catch { /* 抓不到也還是能用 */ }
  startMarquee(e);
}

function onTouchUp(e, ok) {
  touchPts.delete(e.pointerId);
  if (audition?.pid === e.pointerId) endAudition();

  // 雙指的兩個狀態：少一根手指就結束，不接回平移。捏完鬆手時兩根手指幾乎不可能同時
  // 離開，接成平移的話畫面會在縮放結束之後莫名其妙滑一段。清成 null 也順便讓剩下那根
  // 手指變成啞的 —— 它抬起來時不會被算成輕觸。
  if (gesture?.kind === "two" || gesture?.kind === "zoom") {
    if (touchPts.size < 2) gesture = null;
    return;
  }
  if (gesture?.kind === "pan") {
    // 2→1 指：質心會瞬間跳到剩下那根手指上，重取一次才不會把那段跳當成位移
    if (touchPts.size === 0) gesture = null;
    else { const c = centroid(); gesture.cx = c.x; gesture.cy = c.y; }
    return;
  }
  if (gesture?.kind === "pending" && gesture.pid === e.pointerId) {
    clearTimeout(gesture.timer);
    const g0 = gesture;
    gesture = null;
    // 尺上的輕觸：這時才設基準線（長按已經把手勢用掉了）。`tapPick` 讀的是 `g0.at`，
    // 而這種手勢沒有。
    if (ok && g0.menuOnly) { setMarkStart(g0.rulerTick); return; }
    if (ok) tapPick(g0);
    return;
  }
  if (drag && drag.pid === e.pointerId) endDrag(ok);
}

function onPointerUp(e, ok) {
  if (e.pointerType === "touch") { onTouchUp(e, ok); return; }
  endAudition();

  // 待判十定中放開 = 沒超過門檻 = 這是一次點擊：取消選取 ＋ 設基準線。用的是按下那一刻的
  // tick，所以門檻內那幾個像素不會讓線飄走。`pointercancel`（ok=false）什麼都不做。
  // `pend` 與 `drag` 不會同時存在（升級成框選時 pend 就清掉了），所以這裡 return。
  if (pend) {
    const p = pend;
    pend = null;
    try { cv.releasePointerCapture(p.pid); } catch { /* 沒抓到就算了 */ }
    if (ok) {
      if (!sounding()) onPick(null);
      setMarkStart(p.markTick);
    }
    draw();
    return;
  }
  endDrag(ok);
}

// ─── 觸控：拖到邊緣就自動捲動 ───────────────────────────────────────────────
//
// 拖曳中沒有第二隻手可以捲動，於是它只拖得到眼前這一頁。離邊緣 EDGE_ZONE 內就開始捲，速度
// 依進得多深線性加到 EDGE_MAX。只有觸控 —— 滑鼠拖曳中本來就能用滾輪捲動。

let edgeRaf = 0;          // rAF handle，0 = 沒在跑
let edgePt = null;        // 最後一次的手指位置（client 座標）
let edgeVx = 0, edgeVy = 0;   // px/s
let edgeLast = 0;         // 上一幀的時間戳

/** 兩側各自的餘裕 → 速度。進得越深越快，都不在邊緣就日是 0。 */
function edgeV(near, far) {
  if (near < EDGE_ZONE) return -EDGE_MAX * Math.min(1, (EDGE_ZONE - near) / EDGE_ZONE);
  if (far  < EDGE_ZONE) return  EDGE_MAX * Math.min(1, (EDGE_ZONE - far)  / EDGE_ZONE);
  return 0;
}

function edgeScroll(pt) {
  edgePt = pt;
  if (!pt) { edgeVx = edgeVy = 0; return; }
  const r = cv.getBoundingClientRect();
  const x = pt.x - r.left, y = pt.y - r.top;
  edgeVx = edgeV(x - GUTTER_W, box.clientWidth - x);
  edgeVy = edgeV(y - RULER_H, box.clientHeight - y);
  if ((edgeVx || edgeVy) && !edgeRaf) {
    edgeLast = 0;
    edgeRaf = requestAnimationFrame(edgeStep);
  }
}

function edgeStep(t) {
  edgeRaf = 0;
  if (!drag || !edgePt || (!edgeVx && !edgeVy)) return;
  const dt = edgeLast ? Math.min(0.05, (t - edgeLast) / 1000) : 0;
  edgeLast = t;
  const x0 = box.scrollLeft, y0 = box.scrollTop;
  box.scrollLeft = x0 + edgeVx * dt;
  box.scrollTop  = y0 + edgeVy * dt;
  // 只有自動捲動的這一幀才用螢幕座標重算落點。規則是一句話：「畫面因為你的拖曳而動 →
  // 框跟著你；畫面因為別的原因而動 → 框待在原地。」後半正是 onDragMove 存 tick 而不是
  // 存 x 的理由，前半則是自動捲動存在的卜意義。
  if (box.scrollLeft !== x0 || box.scrollTop !== y0) {
    const r = cv.getBoundingClientRect();
    drag.lastTick = xToTick(edgePt.x - r.left);
    drag.lastMidi = yToMidi(edgePt.y - r.top);
    if (drag.mode === "marquee") marqueeMove();
    else updatePreview();
  }
  edgeRaf = requestAnimationFrame(edgeStep);
}

function stopEdgeScroll() {
  if (edgeRaf) cancelAnimationFrame(edgeRaf);
  edgeRaf = 0; edgePt = null; edgeVx = edgeVy = 0;
}

// ─── 框選：空白處拉一個方框圈起一段 ───────────────────────────────────────────
//
//  取代。框完之後選取就是剛好框到的那些，框到 0 個就是清空。按著 Ctrl 才是追加。
//
//  曾經是一律追加，理由是「捲一段框一次可以把散落在整首曲子裡的音湊齊」。那會踩到一個更嚴
//  重的東西：選取可以在視窗外而畫面上沒有任何線索 —— 在第 3 小節選好幾個音、捲到第 40 小節
//  框住眼前這幾個，改下去才發現第 3 小節那幾個也被改了。取代把它堵死。
//
//  一個知情的不對稱：Ctrl+點音符是 toggle，Ctrl+框是純追加 —— 框一次蓋到十幾個音、狀態有的
//  在有的不在，toggle 出來的結果看著像壞掉。檔案總管與 DAW 也是這樣分的。
//
//  這是 `drag` 的第五個 mode 而不是另一套狀態，所以整套既有機制自動接上。代價是它是唯讀的
//  mode，而另外四個都假設「拖曳中＝正在編輯」。
//
//  選取不存在這裡，而且每一幀提交的是完整結果、不是差量。追加那條一定要對著 `drag.base`
//  （按下之前的快照）算 —— 對著「現在的選取」算的話，框縮回去時剛加進來的音抽不掉。

/**
 * 框現在涵蓋竹的 tick／音高範圍（都含頭含尾）。
 *
 * 音高就是列 —— `midiToRow` 是單調的一對一（`ROLL_MAX - midi`），所以比 midi 等於比列。
 */
function marqueeBox() {
  return {
    t0: Math.min(drag.grabTick, drag.lastTick),
    t1: Math.max(drag.grabTick, drag.lastTick),
    m0: Math.min(drag.grabMidi, drag.lastMidi),
    m1: Math.max(drag.grabMidi, drag.lastMidi),
  };
}

/**
 * 框圈到當前軌的哪些音。
 *
 * 相交就算，不要求完整包在框裡（同 `select.notesIn` 對字元範圍的判準）—— 像素比字元更難對
 * 準。後果是長音會被小框吃到，而那是對的：框確實壓在那條橫條上。
 *
 * 邊界含頭含尾（`>=` / `<=`）。唯一碰得到這個差別的是純垂直的框：`t0 === t1` 時半開區間的
 * 寬度是 0，「拉了一個框卻什麼都沒選到」。框不吸附格線 —— 吸附會跟「相交就算」打架。
 *
 * 只看當前軌：跨軌的選取在結構上不可能（真相是當前軌那個 textarea 的原生選取）。所以框裡只
 * 有鬼影時就等於框到 0 個，而且不切軌 —— 框裡有兩軌的鬼影時「切哪一軌」沒有答案。
 */
function marqueeHits() {
  const { t0, t1, m0, m1 } = marqueeBox();
  const out = [];
  for (const n of song?.tracks[active]?.notes ?? []) {
    if (n.tick > t1) break;                       // notes 的 tick 不遞減，超過就可以停
    if (n.tick + n.durTick < t0) continue;
    if (n.midi < m0 || n.midi > m1) continue;
    out.push({ tick: n.tick, midi: n.midi });
  }
  return out;
}

/**
 * 框動了：算山出這一刻該選哪些音，只在那組音變了的時候才提交（每次提交都會走到 ui 的
 * `paintHighlight`）。畫框本身不受閘門管，所以框照樣跟手。
 */
function marqueeMove() {
  const hits = marqueeHits();
  const sig = hits.map(n => selKey(n.tick, n.midi)).join(",");
  if (sig !== drag.sig) {
    drag.sig = sig;
    // 純框直接送 `hits`（框到 0 個就送空陣列 = 清空），Ctrl 才去併按下之前那組快照。
    onSetPicks(drag.add
      ? [...drag.base, ...hits.filter(n => !drag.baseKeys.has(selKey(n.tick, n.midi)))]
      : hits);
  }
  draw();
}

/**
 * 位移超過門檻 → 從「待判定」升級成框選。取代還是追加是按下那一刻的修飾鍵決定的，拖到一半
 * 才按 Ctrl 不會改變這個框的意思 —— 中途換人會讓已經提交的那幾幀語意不同。
 */
function startMarquee(e) {
  const p = pend;
  pend = null;
  hover = null;
  // 「按下去線會落在這」那條虛線：已經決定拖曳就不設線了，留著是騙人。
  markCursor = null;
  drag = {
    mode: "marquee",
    pid: p.pid,
    add: p.add,
    grabTick: p.grabTick, grabMidi: p.grabMidi,
    lastTick: p.grabTick, lastMidi: p.grabMidi,
    // 快照無條件存，雖然只有追加讀得到 —— 分兩條路省下的是一次 map，換來的是一個
    // 「什麼時候有、什麼時候沒有」的條件要卜記。
    base: selection.map(n => ({ tick: n.tick, midi: n.midi })),
    baseKeys: new Set(selection.map(n => selKey(n.tick, n.midi))),
    sig: null,
  };
  // capture 在 pend 那一步就抓好了，這裡不必再抓。
  syncToolbar();
  onDragMove(e);
}

/**
 * 畫框：虛線外框 ＋ 淡水藍填色，畫在最上層（見 draw()）。座標每幀從 tick／音高重算不存像素
 * —— 拖曳中捲動時框要跟著內容走，而自動捲動時 `edgeStep` 改的是 `lastTick`／`lastMidi`。
 */
function drawMarquee() {
  const { t0, t1, m0, m1 } = marqueeBox();
  // midiToY 給的是那一列的上緣，而音越高 y 越小 —— 上緣取 m1、下緣取 m0 再加一列。
  const x0 = Math.max(GUTTER_W, Math.round(tickToX(t0)));
  const x1 = Math.min(box.clientWidth, Math.round(tickToX(t1)));
  const y0 = Math.max(RULER_H, Math.round(midiToY(m1)));
  const y1 = Math.min(box.clientHeight, Math.round(midiToY(m0)) + ROW_H);
  if (x1 < x0 || y1 < y0) return;               // 整個框都捲出畫面外了
  const w = Math.max(1, x1 - x0), h = Math.max(1, y1 - y0);

  g.save();
  g.fillStyle = C.marquee;
  g.fillRect(x0, y0, w, h);
  g.setLineDash([4, 4]);
  g.strokeStyle = C.marqueeEdge;
  g.lineWidth = 1;
  g.strokeRect(x0 + 0.5, y0 + 0.5, Math.max(1, w - 1), Math.max(1, h - 1));
  g.restore();
}

/** 拖曳中：算山出預覽的位置／長度。 */
function onDragMove(e) {
  const r = cv.getBoundingClientRect();
  const x = e.clientX - r.left, y = e.clientY - r.top;

  // 畫音符時拖進左側琴鍵或上方小節尺 = 放開就取消。只有 create 模式有這條路 —— 搬動／
  // 改長度不加，那會改掉既有的滑鼠行為。取消區選這兩塊，是因為它們在繪圖時本來就沒有
  // 別的語意（按下語意在 pointerdown 就分流掉了）。
  if (drag.mode === "create") {
    const off = x < GUTTER_W || y < RULER_H;
    if (off !== drag.cancel) { drag.cancel = off; refreshEffect(); draw(); }
    // 取消區裡不更新落點：框停在最後一個有效位置，放開才看得出「本來會畫在哪」
    if (off) { edgeScroll(null); return; }
  }

  // 記的是 tick 與音高而不是螢幕座標：xToTick 含 scrollX()，存 x 的話「拖曳中用滾輪捲動
  // 畫面」會讓同一個 x 對應到不同的 tick。自動捲動是刻意的例外，見 edgeStep。
  drag.lastTick = xToTick(x);
  drag.lastMidi = yToMidi(y);
  if (drag.mode === "marquee") marqueeMove();
  else updatePreview();
  // 邊緣自動捲動：觸控一律有，滑鼠只有框選有。上面那節的理由（滑鼠拖曳中本來就能用滾輪
  // 捲動）對搬動音符仍然成立，但框選的整個目的就是「圈起超出視野的一段」，而滾輪在拖曳
  // 中只捲得動一個軸、還會把框竹的另一端一起帶走。
  edgeScroll(e.pointerType === "touch" || drag.mode === "marquee"
    ? { x: e.clientX, y: e.clientY } : null);
}

/**
 * 方向鍵微調：把偏移量加進累加器，再走同一條合成路徑。
 *
 * 只在拖曳中有效，這是唯一可行的入口 —— 「有音符被選取」必然意味著文字區有焦點，那時方向鍵
 * 是原生的游標移動。時間軸一次 FINE_TICKS（半格），音高一次一列；音高上買到的不是精度而是
 * 軸隔離（垂直移動滑鼠 12px 很難不水平漂移幾 px，而那足以翻一格）。
 *
 * @returns {boolean} 有沒有吃掉這個按鍵
 */
function nudge(key, shift) {
  if (!drag) return false;
  // 框選沒有東西可微調（它不搬任何音），但方向鍵**還是要吃掉** —— 不吃的話 `#stage`
  // 會跟著捲動，而框拉到一半畫面被抽走比沒反應更糟。這跟改音長時上下鍵的處理是同一
  // 條規則（見下面那個 case 的註解）。**Shift 的四顆一起吃掉**，理由完全相同。
  if (drag.mode === "marquee")
    return key === "ArrowLeft" || key === "ArrowRight"
        || key === "ArrowUp"   || key === "ArrowDown";
  const resize = drag.mode === "resize";
  // Shift 的一步：時間軸**一小節**、音高**一個八度**。
  //
  //  **一小節是位移量，不是吸附到小節線。** 搬動的既有語意是「差幾格」（見
  // updatePreview），刻意保住 off-grid 音符原本的相位；吸附會把落在反拍的音甩到小節線
  // 上，那是另一個功能。所以 Shift+→ 的意思是「同一個相位、下一小節」。
  const dt = shift ? barTicksAt(barRefTick()) : FINE_TICKS;
  //  **打擊分頁上沒有「八度」可給。** PERC_PADS 的順序是鼓面的順序不是音高的順序，
  // 差 12 個位置沒有任何音樂意義（而且 15 個就到底了）。所以**吃掉按鍵但不動作** ——
  // 給一個假的八度比不給糟，這跟 drums.percShift「不是鼓面就原地不動」是同一條立場。
  const dead = false;
  switch (key) {
    case "ArrowLeft":  drag.fineTick -= dt; break;
    case "ArrowRight": drag.fineTick += dt; break;
    // 改音長時上下沒有意義（滑鼠拖右邊框也不改音高），但還是要吃掉按鍵 ——
    // 不吃的話捲動容器會跟著上下捲，拖曳中畫面被抽走比沒反應更糟。
    case "ArrowUp":    if (!resize && !dead) drag.fineRows += shift ? 12 : 1; break;
    case "ArrowDown":  if (!resize && !dead) drag.fineRows -= shift ? 12 : 1; break;
    default: return false;
  }
  updatePreview();
  return true;
}

/**
 * 「跳一小節」要問哪一個 tick 的小節長度。**拍號會變，所以沒有「一小節 = 1920」這回事。**
 *
 * 問的是**正在動的那一端**：改音長動的是尾巴（往後延就該用尾巴所在那一小節的長度），其餘動
 * 的是頭。多選拖曳沒有 `to`，用整組的起點加上目前位移。
 */
function barRefTick() {
  if (drag.mode === "group")
    return Math.max(0, Math.min(...drag.picks.map(n => n.tick)) + drag.dTick);
  if (drag.mode === "resize") return drag.to.tick + drag.to.dur;
  return drag.to.tick;
}

/**
 * 把「滑鼠停在哪」＋「方向鍵累積了多少」合成成預覽。
 *
 * 滑鼠的位移用「差幾格」算，不是把落點對齊格線 —— 這樣三連音之類的 off-grid 音符會保住它原本
 * 的偏移量，只是整體移動整數格（對齊落點的話節奏會被悄悄改掉）。方向鍵的量**加在那之上**。
 */
function updatePreview() {
  // **平常是滑鼠一格、方向鍵半格**，搬動與改長度都走這一條。試過把滑鼠**一律**改成半格，實
  // 測退回來了：半格是 6px，而格線畫在每 60 tick —— 於是**每一次**普通的拖曳都變成要瞄準。
  // 半格是偶爾要的，對齊格線是每一次都要的。
  //
  // 選了 64 分音符時例外（`snapMove()`）：那時整個模式的解析度就是半格，格線也跟著多一層
  // （最大兩檔縮放）。**這一條同時管改長度**，而它正是讓 64 分音符編輯得動的那一半 —— 單位
  // 若留在一格，`to.dur` 從 30 只跳得到 90，中間的 60（l32）用滑鼠表達不出來。
  //
  // **長度推桿一律半格**（`drag.pid === null` 就是它 —— 面板上的兩條路都沒有真的指標，
  // 而位置那條已經換成方向鍵、根本不走這裡）。它是這個面板上唯一還在推的桿子，而 1/32
  // 對「推到差不多長」太粗：實測要的是更細的落點，**不是更慢的速度**（`MAX_SPEED_SIZE`
  // 一個字都沒動）。同樣的推力位移下 step 減半只是把同一段距離切成兩倍多的階，音符成長
  // 的速率完全一樣。
  const step = drag.pid === null ? FINE_TICKS : snapMove();
  const dCells = Math.round((drag.lastTick - drag.grabTick) / step);
  const dTickRaw = dCells * step + drag.fineTick;
  const dRowsAll = (drag.lastMidi - drag.grabMidi) + drag.fineRows;

  if (drag.mode === "group") { groupDragMove(dTickRaw, dRowsAll); return; }

  const to = { ...drag.from };
  if (drag.mode === "resize") {
    // 下限是 FINE_TICKS 而不是一格：方向鍵能做到半格，音長下限就該是能表達的最短時值
    // （30 = l64）。代價是 30 tick 的音符只有 6px，右邊框實質抓不到。
    to.dur = Math.max(FINE_TICKS, drag.from.dur + dTickRaw);
  } else {
    to.tick = Math.max(0, drag.from.tick + dTickRaw);
    to.midi = Math.min(PITCH_MAX, Math.max(PITCH_MIN, drag.from.midi + dRowsAll));
  }

  if (to.tick === drag.to.tick && to.midi === drag.to.midi && to.dur === drag.to.dur) return;
  const pitchChanged = to.midi !== drag.to.midi;
  drag.to = to;
  drag.moved = to.tick !== drag.from.tick || to.midi !== drag.from.midi || to.dur !== drag.from.dur;
  // 卜音高變了就試聽一下。`resize` 自動不會觸發（那條分支只動 `to.dur`）。方向鍵 ↑/↓ 也走
  // 這裡，而那正是最需要聲音的情況：12px 的位移看不出來。
  if (pitchChanged) auditionDrag(to.midi);
  refreshEffect();
  draw();
}

/**
 * 拖曳中換音高 → 把被抓住的那個音按它自己的長度彈一次。不用判斷「是不是正在出聲」：
 * 拖曳只在 `canEdit()` 之下才建立得起來。
 */
const auditionDrag = midi => {
  // 畫新音符時沒有「被抓住的那個音」可以查長度 —— 用框自己的長度，秒數走速度圖現算。
  // 這是估計值，而拖曳中要確認的只有音高，那一項永遠是準的。
  if (drag.mode === "create") {
    const { tick, dur } = drag.to;
    onAuditionNote(midi, drag.clock(tick + dur) - drag.clock(tick), drag.audVel);
    return;
  }
  onAuditionNote(midi, drag.audSec, drag.audVel);
};

/**
 * 這次拖曳放開之後會刪掉哪些音、截短哪些音。要在放開之前算，因為 `insertNote` 對被蓋到的音
 * 是不對稱的：尾巴被切只是變短，頭被切直接變成休止符 —— 往左微調 30 與往右微調 30 都是 6px
 * 的操作，後果卻不同。判定的規則住在 rolledit.overwriteEffect。
 */
/**
 * 拖曳開始時的微調狀態。lastTick/lastMidi 用按下的那一點起頭，這樣「完全不動滑鼠、只按方向
 * 鍵」也算得出位移。
 */
const fineInit = at => ({
  fineTick: 0, fineRows: 0,
  lastTick: at.rawTick, lastMidi: at.midi,
  effect: null, effectSig: "",
  // 試聽用：被抓住那個音的秒長與力度。在這裡存一次而不是每次去 song 查 —— 拖曳中預覽
  // 還水沒 commit，那個音不會變。多選時 at.hit 就是被抓住的那一個。
  audSec: at.hit?.dur ?? 0, audVel: at.hit?.vel ?? 100,
});

/**
 * 重算 drag.effect，只有計數變了才去同步工具列 —— updatePreview 每次滑鼠移動都跑，而
 * syncToolbar 會做好幾次 DOM 查詢。描邊落在哪幾個音由 draw() 直接讀 drag.effect。
 */
function refreshEffect() {
  drag.effect = previewEffect();
  const sig = drag.effect ? `${drag.effect.nKill}/${drag.effect.nTrim}` : "";
  if (sig === drag.effectSig) return;
  drag.effectSig = sig;
  syncToolbar();
}

function previewEffect() {
  // 拖進取消區 = 放開什麼都不會發生，那時警告是騙人的
  if (drag.cancel) return null;

  const notes = (song?.tracks[active]?.notes ?? [])
    .map(n => ({ tick: n.tick, dur: n.durTick, midi: n.midi }));
  if (!notes.length) return null;

  // 畫新音符：不看 `moved`。框一生成就有長度，右邊可能已經壓在下一個音上 ——「都還沒動
  // 就會刪掉一個音」正是最需要先講竹的情況。
  if (drag.mode === "create")
    return summarize(overwriteEffect(notes, [{ tick: drag.to.tick, dur: drag.to.dur }], []));

  if (drag.mode === "group") {
    if (!drag.dTick && !drag.dMidi) return null;
    const byKey = new Map(notes.map(n => [selKey(n.tick, n.midi), n]));
    const places = [];
    for (const p of drag.picks) {
      const n = byKey.get(selKey(p.tick, p.midi));
      if (n) places.push({ tick: Math.max(0, n.tick + drag.dTick), dur: n.dur });
    }
    // 只上下移動（dTick === 0）時每個音都蓋回自己原本的時間段，所以 moving 要把整組
    // 排除掉，不然整組會被報成「自己刪掉自己」。
    return summarize(overwriteEffect(notes, places, drag.picks));
  }
  if (!drag.moved) return null;
  return summarize(overwriteEffect(
    notes,
    [{ tick: drag.to.tick, dur: drag.to.dur }],
    [{ tick: drag.from.tick, midi: drag.from.midi }],
  ));
}

/** overwriteEffect 的結果 → 繪製要的 Set 與訊息要的計數。全空回 null。 */
function summarize({ killed, trimmed }) {
  if (!killed.length && !trimmed.length) return null;
  return {
    kill: new Set(killed.map(n => selKey(n.tick, n.midi))),
    trim: new Set(trimmed.map(n => selKey(n.tick, n.midi))),
    nKill: killed.length,
    nTrim: trimmed.length,
  };
}

/**
 * 多選拖曳的位移。夾範圍是夾整組的位移量而不是夾每個音 —— 逐音夾的話撞到邊界的那幾個
 * 音會疊在一起，和聲就毀了，而且日是不可逆的。
 */
function groupDragMove(dTickRaw, dRows) {
  const ticks = drag.picks.map(n => n.tick);
  const midis = drag.picks.map(n => n.midi);
  const dTick = Math.max(-Math.min(...ticks), dTickRaw);
  const dMidi = Math.min(PITCH_MAX - Math.max(...midis),
                Math.max(PITCH_MIN - Math.min(...midis), dRows));

  if (dTick === drag.dTick && dMidi === drag.dMidi) return;
  const pitchChanged = dMidi !== drag.dMidi;
  drag.dTick = dTick;
  drag.dMidi = dMidi;
  drag.moved = dTick !== 0 || dMidi !== 0;
  // 多選發被抓住的那個音（游標壓著的那一列 + 整組的位移），跟單音拖曳同一條規則。一軌
  // 是單音的，所以多選就是一段旋律不是和弦 —— 聽著那一個音跟著移動正好確認移調了幾個
  // 半音。
  if (pitchChanged) auditionDrag(drag.grabMidi + dMidi);
  refreshEffect();
  draw();
}

/** 放開左鍵才真的改 MML。中途按 Esc 或 pointercancel 就整個取消。 */
function endDrag(commit) {
  if (!drag) return;
  const d = drag;
  stopEdgeScroll();
  padDisarm();                // 方向鍵的提交計時器：這一段已經結束了
  padCur = null;              // 長度推桿的虛擬滑鼠（其他 mode 本來就是 null）
  try { cv.releasePointerCapture(d.pid); } catch { /* 沒抓到就算了 */ }
  drag = null;

  // 框選：卜選取在拖曳中就已經逐幀提交了，放開沒有第二步。中止（Esc／pointercancel）則是
  // 清空選取，不是還原成拖曳前那組 —— Esc 取消的是「正在進行的那件事」，而框選正在進行
  // 的就是選取本身。（音符拖曳中的 Esc 相反，見 keydown 的 Escape。）
  if (d.mode === "marquee") {
    if (!commit) onPick(null);
    syncToolbar();
    draw();
    return;
  }

  // 畫新音符：沒動過也要寫入（原地點一下就是最常用的手勢），所以不能跟下面共用
  // `d.moved` 這道閘門。拖進取消區則一律不寫。
  if (commit && d.mode === "create") { if (!d.cancel) commitCreate(d); }
  else if (commit && d.moved) {
    if (d.mode === "group") {
      // 寫回之後 ui 會把選取移到新位置（見 relocateNotes），這裡不用自己挑
      onMove({ picks: d.picks, dTick: d.dTick, dMidi: d.dMidi });
    } else if (onMove({ from: d.from, to: d.to })) {
      const n = song.tracks[active]?.notes.find(x => x.tick === d.to.tick && x.midi === d.to.midi);
      if (n) onPick(n);
    }
  }
  // 拖曳結束 → #rollHint 收回「↑↓←→微調」、#rollNote 收回破壞警告。一定要在
  // drag = null 之後（那兩句都是問 drag 的）。
  syncToolbar();
  draw();
}

/**
 * 放開 → 真的把音符寫進去。不試聽：聲音在按下的那一刻就發過了，拖曳中每換一列又發過，放開
 * 再響一次就是同一人個音連兩聲。
 */
function commitCreate(d) {
  const { tick, midi, dur } = d.to;
  if (!onAdd({ tick, dur, midi })) { onPick(null); return; }
  // onAdd 會同步走完「寫回 → 重新解析 → setSong」，所以這時 song 已經是新的了。
  // 把游標移到剛畫的那個音，跟「點音符」一致。
  const added = song.tracks[active]?.notes.find(n => n.tick === tick && n.midi === midi);
  onPick(added ?? null);
}

// ─── 虛擬遙桿面板（觸控專屬）─────────────────────────────────────────────────
//
// 面板本身在 rolljoy.js（DOM），這裡只負責三件事：什麼時候該出現、推一步是什麼意思、
// 被編輯的東西要留在看得到的地方。對 PC 一個字都不影響 —— 出現條件的第一項就是「最後
// 一次輸入是觸控」。

/** 選中的音符要離可視區邊界至少這麼遠，不然就捲動（px）。 */
const KEEP_MARGIN = 8;

/**
 * 面板該不該開著：`lastDownTouch`（觸控專屬）、選取非空、`canEdit()`、**焦點不在文字框**，
 * 任何一個不成立就收掉。
 *
 * 不問 `tool` —— 長按不再叫得出音符選單之後，面板的 ☰ 與刪除鍵是那些操作在手機上唯一的入口。
 * 連帶的一條規則寫在 tapPick：繪圖模式輕點空白照畫，不然連續輸入就死了。
 *
 * **焦點在文字框時一律不開。** 在 MML 裡拖選一段文字**也會選到音符**（`selectionchange`
 * 那條路），於是面板浮出來 —— 而 `body.joy` 做的第一件事就是把文字區整塊藏掉（`.tarow`
 * `display:none`）。淨效果是「選字選到一半，要選的東西在手指底下消失了」。
 *
 * 這條不會把面板鎖死：`#stage` 有 `tabindex="-1"`（可用點擊聚焦），而 pianoroll 一個
 * `.focus()` 都沒有，觸控的 `pointerdown` 也**不呼叫 `preventDefault`**（那三處全部只在
 * 非觸控時執行）—— 所以點一下捲軸，焦點自然離開文字框，面板就回來了。
 */
const wantJoy = () =>
  lastDownTouch && selection.length > 0 && canEdit()
  && !editing(document.activeElement);

/**
 * 開／關面板，並同步它的狀態。掛在 `syncToolbar()` 裡（那是這個檔案裡「狀態變了」的匯流
 * 點），所以播放一開始面板就自己收了。`guard` 是因為 `endDrag()` 會呼叫 `syncToolbar()`。
 */
let joySyncing = false;
function syncJoy() {
  if (joySyncing) return;
  joySyncing = true;
  try {
    if (wantJoy()) {
      // `body.joy` 讓 MML 編輯區整塊退場（見 editor.css）。獨立竹的 class，不去動使用者
      // 自己的 `no-editor`。
      document.body.classList.add("joy");
      const opening = !rolljoy.isOpen();
      rolljoy.show({ canResize: selection.length === 1, multi: multiPick });
      rolljoy.place();
      // 只在剛打開的那一次捲。每次都捲的話使用者根本捲不動畫面（手動捲動 → 判定「不是我
      // 捲的」→ syncToolbar() → 走到這裡 → 立刻拉回去）。拖曳中連「剛打開」也不捲：長按音符
      // 會在建立 drag 之後才改選取，這一捲會把音符從手指底下抽走。
      if (opening && !drag) keepSelVisible();
      return;
    }
    document.body.classList.remove("joy");
    if (!rolljoy.isOpen()) return;
    // 面板要收了，但桿子可能還按著。先取消那次拖曳 —— 不取消的話 drag 會留著，而它的
    // pid 是 null，沒有任何 pointerup 收得掉它。
    // **提交而不是取消。** 這一行原本是 `endDrag(false)`，寫在「桿子可能還按著、面板
    // 卻要收了」的年代 —— 那時取消是保守的選擇。方向鍵不一樣：使用者已經按完了，預覽
    // 上就是他要的結果，而收面板的原因（選取換了、開始播放、改用滑鼠、切軌）沒有一個
    // 代表「我不要這次修改」。靜靜丟掉一段已經看得見的編輯比留著它糟。真的要反悔有
    // Esc（那條走 endDrag(false)）與 Ctrl+Z。
    if (drag && drag.pid === null) endDrag(true);
    // **`multiPick` 刻意不在這裡歸零**，它歸零的地方在 `onClear`。面板收起的原因有很多種
    // （刪光、切軌、播放、改用滑鼠），而其中只有「取消選擇」代表使用者做完了。最常見的那
    // 條迴圈是「框一片 → 刪掉 → 框下一片」，在這裡歸零會讓每一輪都要重新點一個音、重新按
    // 亮多選，而那正是多選最主要的用途。
    rolljoy.hide();
  } finally {
    joySyncing = false;
  }
}

/**
 * 按下旋鈕 = 開始一次拖曳。放開才 commit，所以一次推動是一步 undo。`drag` 的既有模式原封不動
 * 接上，覆蓋預告、破壞警告、試聽、Esc 取消一項都不用重做。`pid: null` 日是唯一的新東西。
 */
/** 被選中的第一個音，pad 那兩條路都要它。找不到（剛被改掉）就回 null。 */
function padPick() {
  if (!canEdit() || !selection.length) return null;
  const notes = song?.tracks[active]?.notes ?? [];
  return notes.find(n => n.tick === selection[0].tick && n.midi === selection[0].midi) ?? null;
}

/** `drag` 的共用底：兩條 pad 路徑都沒有真的指標，所以 `pid` 是 null。 */
const padBase = (pick, grabTick) => ({
  grabTick, grabMidi: pick.midi,
  lastTick: grabTick, lastMidi: pick.midi,
  fineTick: 0, fineRows: 0,
  effect: null, effectSig: "",
  audSec: pick.dur, audVel: pick.vel,
  moved: false, pid: null,
});

/**
 * 按下長度旋鈕。**只有長度桿會走到這裡** —— 位置那一根已經換成方向鍵（見 padStep）。
 *
 * 虛擬滑鼠的起點放在音符的**右邊框**，也就是用滑鼠做同一件事時手會按下去的位置。存的是
 * 內容座標（不含捲動位移），所以拖曳中畫面捲動不會讓落點自己跑掉。
 */
function padStart() {
  if (drag) return;
  const pick = padPick();
  if (!pick || selection.length !== 1) return;   // 多選不改長度（PC 也是）
  padCur = {
    x: tickToPx(pick.tick + pick.durTick, CELL_W),
    y: (midiToRow(pick.midi) + 0.5) * ROW_H,
  };
  const from = { tick: pick.tick, midi: pick.midi, dur: pick.durTick };
  // grabTick 取自虛擬滑鼠的起點本身，所以按下去的瞬間位移是 0。
  drag = { mode: "resize", from, to: { ...from }, ...padBase(pick, pxToTick(padCur.x, CELL_W)) };
  syncToolbar();
  draw();
}

/**
 * 把虛擬滑鼠移動卜這麼多 px，再照它的落點更新預覽 —— 跟真的滑鼠走同一條路。位移是內容座標上
 * 的，所以「拖曳中畫面捲動了」不會讓落點自己跑掉。
 */
function padMove(kind, dx) {
  if (!drag || !padCur) return;
  padCur.x = clamp(padCur.x + dx, 0, contentW());
  // 改長度沒有音高的概念，縱向位移直接丟掉（桿子本身也已經鎖住 Y 了）。
  drag.lastTick = pxToTick(padCur.x, CELL_W);
  updatePreview();
  keepSelVisible();
  // updatePreview 只在落點換格時重畫，而虛擬滑鼠每一幀都在動 —— 十字游標要跟著。
  draw();
}

function padEnd() {
  endDrag(true);
}

// ─── 方向鍵 ─────────────────────────────────────────────────────────────────
//
// 面板上那八顆鍵。**它們是 PC 方向鍵在手指上的同一份東西** —— 走的也是 `drag.fineTick` /
// `fineRows`（見 nudge），而那正是唯一能表達半格的機制：`updatePreview` 的四捨五入只吃
// 滑鼠／推桿的位移，`fine*` 是加在**取整之後**的原始 tick。
//
// 級距**跟 PC 的方向鍵逐值相同**：上下一格音高、左右 1/64。
//
// **曾經有外圈的四顆（一個八度／一拍），實測拿掉了。** 兩圈為了塞進同一個高度預算會把
// 內圈壓到 31×39，於是**兩組一起變得容易誤觸** —— 而內圈才是核心。粗調本來就有更好的路：
// **長按把音符拿起來拖**。分工因此回到 README 一直寫著的那句話：粗調用手指直接拖，微調
// 用面板；面板只做「微調」那一半，而那一半現在按得準。

/** 停手多久算一段結束（ms）。**刻意等於 `LONG_MS`** —— 同一塊面板上兩個「停多久」不該不同。 */
const PAD_COMMIT_MS = 400;

let padCommit = 0;

/**
 * 方向鍵按了一下（長按的每一次重複也走這裡，呼叫端分不出）。
 *
 * **drag 的壽命跟任何一次按下都無關**：第一下建立它，之後每一下延後提交，停手
 * `PAD_COMMIT_MS` 才 `endDrag(true)`。所以「按住三秒」與「點十下」都是**一步 undo**，
 * 而那正是使用者心裡的一件事。
 *
 * 這跟推桿的「放開就 commit」不同，因為按鍵沒有「放開」這個對應物 —— 一次調整由好幾次
 * 獨立的按下組成。
 */
function padStep(dir) {
  if (!canEdit() || !selection.length) return;
  // 長度桿正在推：那是另一件事，先讓它落地再開新的一段（同 padStepArm 的其餘出口）。
  if (drag && drag.mode === "resize") endDrag(true);
  if (!drag) {
    const pick = padPick();
    if (!pick) return;
    const grabTick = pick.tick;
    if (selection.length > 1) {
      drag = { mode: "group", picks: selection.map(n => ({ ...n })), dTick: 0, dMidi: 0,
               ...padBase(pick, grabTick) };
    } else {
      const from = { tick: pick.tick, midi: pick.midi, dur: pick.durTick };
      drag = { mode: "move", from, to: { ...from }, ...padBase(pick, grabTick) };
    }
    syncToolbar();
  }

  if (dir === "left" || dir === "right") {
    drag.fineTick += dir === "right" ? FINE_TICKS : -FINE_TICKS;
  } else {
    drag.fineRows += dir === "up" ? 1 : -1;
  }
  updatePreview();
  keepSelVisible();
  draw();
  // **按下就拆膛**，上膛留給放開（padStepEnd）。手指還按著就不算「停手」——
  // 兩個計時器都是 400ms，在這裡上膛的話它會在長按剛開始連續觸發的那一刻先射，
  // 於是「按住一顆鍵」變成兩步以上的 undo。這是實測抓到的。
  padDisarm();
}

/** 方向鍵放開了：這才開始算「停手多久」。 */
function padStepEnd() {
  if (drag && drag.pid === null) padArm();
}

/**
 * 上膛：停手 `PAD_COMMIT_MS` 之後提交。
 *
 * **撞到邊界沒動也照樣上膛** —— 音高推到頂、tick 夾在 0 時 `updatePreview` 會早退，但那
 * 一下仍然算「手指在操作」。它跟有效的那些按下走完全同一條路（`padStep` 一律拆膛、
 * `padStepEnd` 一律上膛），所以撞牆不會讓一段提前結束。
 */
function padArm() {
  clearTimeout(padCommit);
  padCommit = setTimeout(() => {
    padCommit = 0;
    if (drag && drag.pid === null) endDrag(true);
  }, PAD_COMMIT_MS);
}

/** 計時器要跟著 drag 一起收 —— endDrag 與 syncJoy 的收尾都會叫它。 */
function padDisarm() {
  clearTimeout(padCommit);
  padCommit = 0;
}

/**
 * 虛擬滑鼠的十字游標。畫出來是為了讓「桿子在推的是一支滑鼠」看得見：音符是吸附到格子上
 * 的，推到一半時它不動 —— 水沒有游標的話那看起來像是桿子失靈。
 */
function drawPadCursor() {
  const x = Math.round(GUTTER_W + padCur.x - scrollX());
  const y = Math.round(RULER_H + padCur.y - scrollY());
  if (x < GUTTER_W || y < RULER_H) return;
  g.save();
  g.strokeStyle = C.activeEdge;
  g.lineWidth = 1;
  g.beginPath();
  g.moveTo(x - 7, y + 0.5); g.lineTo(x + 7, y + 0.5);
  g.moveTo(x + 0.5, y - 7); g.lineTo(x + 0.5, y + 7);
  g.stroke();
  g.restore();
}

/**
 * 面板上的「☰ 選單」→ 音符選單。不能走 `openMenu(x, y)`：那一份是用座標去 `locate()` 出「按
 * 在哪個音上」的，而這顆按鈕在面板上、不在譜面上。這裡直接把選取的第一個音交出去。
 */
function openSelMenu(x, y) {
  if (!song || !selection.length) return;
  const s = selection[0];
  const hit = (song.tracks[active]?.notes ?? []).find(n => n.tick === s.tick && n.midi === s.midi);
  if (!hit) return;
  onNoteMenu({
    x, y,
    note: { tick: hit.tick, midi: hit.midi, dur: hit.durTick },
    canEdit: canEdit(),
    whyNot: canEdit() ? "" : whyNot,
  });
}

/**
 * 把「正在編輯的東西」維持在看得到的地方，下邊界是面板上緣而不是視窗底。四個邊都做。跟「拖到
 * 邊緣自動捲動」同精神、不同觸發源，所以刻意不共月用。拖曳中看的是預覽（`drag.to`）。
 */
function keepSelVisible() {
  if (!rolljoy.isOpen() || !song) return;
  const b = editBox();
  if (!b) return;

  // 面板貼在視窗底部，所以它蓋住捲軸的只有重疊的那一段 —— 編輯區退場之後捲軸變高，
  // 重疊會變多。每次現算而不是記一個常數。
  const bottom = box.clientHeight - Math.max(0, box.getBoundingClientRect().bottom - rolljoy.top());
  const dx = overflow(tickToX(b.t0), tickToX(b.t1), GUTTER_W, box.clientWidth);
  // y 是反的（高音在上），所以上邊界對應的是最高的那個音
  const dy = overflow(midiToY(b.hi), midiToY(b.lo) + ROW_H, RULER_H, bottom);
  if (!dx && !dy) return;

  box.scrollLeft += dx;
  box.scrollTop += dy;
  // 標記成「這次是我捲的」，不然 scroll handler 會判定使用者自己捲了、把跟隨關掉
  expectScrollLeft = box.scrollLeft;
}

/** 一段 [a,b] 要往哪個方向移多少，才會落回 [lo,hi]。放不下就對齊起點。 */
function overflow(a, b, lo, hi) {
  const m = KEEP_MARGIN;
  if (b - a > hi - lo - m * 2) return Math.round(a - lo - m);   // 比可視區還長 → 對齊左／上緣
  if (a < lo + m) return Math.round(a - lo - m);
  if (b > hi - m) return Math.round(b - hi + m);
  return 0;
}

/** 現在該被看見的 tick／音高範圍。拖曳中用預覽，否則用卜選取。 */
function editBox() {
  const notes = song?.tracks[active]?.notes ?? [];
  const durOf = (tick, midi) =>
    notes.find(n => n.tick === tick && n.midi === midi)?.durTick ?? CELL_TICKS;

  if (drag?.mode === "move" || drag?.mode === "create" || drag?.mode === "resize") {
    const { tick, midi, dur } = drag.to;
    return { t0: tick, t1: tick + dur, lo: midi, hi: midi };
  }
  const picks = drag?.mode === "group"
    ? drag.picks.map(p => ({ tick: p.tick + drag.dTick, midi: p.midi + drag.dMidi,
                             dur: durOf(p.tick, p.midi) }))
    : selection.map(p => ({ tick: p.tick, midi: p.midi, dur: durOf(p.tick, p.midi) }));
  if (!picks.length) return null;

  return {
    t0: Math.min(...picks.map(p => p.tick)),
    t1: Math.max(...picks.map(p => p.tick + p.dur)),
    lo: Math.min(...picks.map(p => p.midi)),
    hi: Math.max(...picks.map(p => p.midi)),
  };
}

/**
 * 正在出聲嗎 —— 暫停不算。這個檔案裡幾乎每一個「播放中不給做」的判斷，真正的理由都是「那會
 * 干擾正在響的聲音」或「那時文字是唯讀的」，兩者在暫停中都不成立。只有 `syncToolbar` 竹的三態
 * 標示例外。
 */
const sounding = () => player.isPlaying() && !player.isPaused();

/** 現在能不能用捲軸改東西（搬動、改長度、刪除）。暫停中可以 —— 改動在恢復時生效。 */
const canEdit = () => editable && !sounding();

/** 能不能在空白處畫新音符。select 模式只搬不畫。 */
const canDraw = () => canEdit() && tool === "draw";

/**
 * 使用者現在是不是在打字。匯出是因為播放快捷鍵（ui 的 onTransportKey）問的是同一個問題，
 * 而那件事只能有一份定義 —— 兩份的話症狀是「在某個框裡按空白鍵會把音樂停掉」。
 * `select` 與 `contenteditable` 也算。
 */
export const editing = t =>
  t instanceof HTMLTextAreaElement || t instanceof HTMLInputElement
  || t instanceof HTMLSelectElement
  || (t instanceof HTMLElement && t.isContentEditable);

/**
 * 正在拖曳嗎。播放快捷鍵要問 —— 拖曳中方向鍵是微調音符（見 nudge），那個手勢已經佔住了
 * 那四顆鍵。暫停中照樣可以拖，所以這不是理論情況。
 */
export const isDragging = () => !!drag;

/**
 * 雙擊音符 → 把 MML 的 caret 移到這個音的字尾，焦點回到文字區。
 *
 * 這是整個站上唯一一條把焦點拉「進」文字區的路（其餘全部是推出去）。caret 落在字尾而不是字
 * 首，因為接下來要打的通常是接在音後面的東西（`.` 變附點、`&c` 接連音）。
 *
 * 三道閘門：`tool === "select"`（draw 模式連點兩下會「畫一個音 + 點到它」，而那兩下常在雙擊
 * 容差內）、非觸控（`dblclick` 是 MouseEvent 沒有 `pointerType`，所女以靠 `lastDownTouch`）、
 * `!sounding()`（出聲時 caret 會被下一幀的導播高亮覆寫掉）。
 */
function onDoubleClick(e) {
  if (lastDownTouch || tool !== "select" || sounding() || !song) return;
  // 第四道閘門：這一串點擊是從鬼影開始的（第一下切了軌，第二下才落在這個音上）。那時
  // 意圖是「切過去看」。見 ghostSwitchAt。
  if (performance.now() - ghostSwitchAt < GHOST_DBL_MS) return;
  const hit = locate(e)?.hit;
  if (!hit) return;
  e.preventDefault();
  onJumpText(hit);
}

/**
 * **觸控命中容差的半徑（px）。** 手指沒有精確命中時，往上下找列中心離指尖這麼近的音。
 *
 * 單位是 px 而不是「上下各一列」，因為手指的誤差是玻璃上的公釐數、跟縮放無關。淨效果是
 * 它會**自己退場**：`ROW_H` 24 以上時隔壁列的列中心已經超過 10px，大目標本來就不需要幫
 * 忙，行為逐值等於沒有這段程式；列高 6px 那幾檔則構得到上下各兩列。
 */
const TOUCH_PICK_R = 10;

/**
 * 觸控沒有精確命中時的補救：上下找**列中心**離 `y` 最近、而且蓋住 `rawTick` 的那個音。
 * 找不到就回 `undefined`，呼叫端照原本的「沒命中」走。
 *
 * **量列中心，不量「離開自己那一列多遠」。** 後者在 12px 的列高下等於整列都在容差內
 * （不管指尖落在哪，離某一條邊界都不到 10px），那太貪心 —— 想點空白處設演奏線會變成
 * 一直點到音符。量列中心則是「自己那一列的中心最遠 6px」，於是隔壁列實際上只多拿到
 * `R - ROW_H/2` 的餘裕（12px 列高是 4px），那才是「差一點點」該有的大小。
 *
 * 候選依 |d| 由小到大、同距先上後下。列高很小的時候上下兩列的列中心可能等距，順序固定
 * 才不會「同一個位置有時選到上面、有時選到下面」。
 */
function touchNear(rawTick, midi, y) {
  // 半徑構得到幾列：|d| 列的列中心最近就是 |d|*ROW_H - ROW_H/2，要它小於半徑。
  const rows = Math.floor((TOUCH_PICK_R + ROW_H / 2) / ROW_H);
  if (rows < 1) return undefined;
  const notes = song?.tracks[active]?.notes ?? [];
  let best, bestD = TOUCH_PICK_R;
  for (let k = 1; k <= rows; k++) {
    for (const d of [k, -k]) {
      const m = midi + d;
      if (!playable(m)) continue;
      const dist = Math.abs(midiToY(m) + ROW_H / 2 - y);
      if (dist >= bestD) continue;
      for (const n of notes) {
        if (n.tick > rawTick) break;
        if (n.midi === m && rawTick < n.tick + n.durTick) { best = n; bestD = dist; break; }
      }
    }
  }
  return best;
}

/**
 * 滑鼠位置 → {x, y, rawTick, tick, midi, hit, onEdge, ghost}。hit 是當前軌在那個位置的音符，
 * onEdge 表示落在它的右邊框上（要改音長）。觸控多一道容差，見 `touchNear`。
 *
 * `ghost` 是別軌在那個位置的音，只在 select 模式、而且當前軌沒命中時才算 —— 於是「當前軌的
 * 音永遠贏」不需要另外一道判斷。只有 `onPointerMove` 與 `onPointerDown` 會讀它。
 */
function locate(e) {
  const r = cv.getBoundingClientRect();
  const x = e.clientX - r.left, y = e.clientY - r.top;
  if (x < GUTTER_W || y < RULER_H) return null;
  const rawTick = xToTick(x), midi = yToMidi(y);
  if (!playable(midi) || rawTick < 0) return null;
  // 早退掃描而不是 `.find`：notes 的 tick 不遞減，超過就可以停。這裡每一次 pointermove
  // 都跑，而 `.find` 沒命中日時會掃完整條。
  let hit;
  for (const n of song?.tracks[active]?.notes ?? []) {
    if (n.tick > rawTick) break;
    if (n.midi === midi && rawTick < n.tick + n.durTick) { hit = n; break; }
  }
  // ── 觸控的命中容差 ──
  //
  // **精確命中永遠優先**，這一段只在完全沒命中時才跑。所以它是純粹的加法：今天選得到的
  // 明天一個不差，今天選不到的多一部分選得到 —— 零回歸風險。
  //
  // 它排在鬼影之前，於是容差**贏過切軌**。那是刻意的：誤觸切軌是個重副作用（連帶清掉選
  // 取），比誤觸選錯音嚴重得多。代價是「刻意點鬼影切軌」在手指底下變難了一點。
  if (!hit && e?.pointerType === "touch") hit = touchNear(rawTick, midi, y);
  // 當前軌沒命中才問鬼影 —— 詳細規則（跳過隱藏軌、疊軌取最小軌號）在 select.ghostAt
  const ghost = !hit && tool === "select" && song
    ? ghostAt(song.tracks, {
        active, count: trackCount(), shown: getGhosts(), rawTick, midi,
      })
    : null;

  let onEdge = false;
  if (hit) {
    const x0 = tickToX(hit.tick), x1 = tickToX(hit.tick + hit.durTick);
    // 很短的音符不能讓抓取區吃掉整格，不然就永遠拖不動它、只能改長度
    const zone = Math.min(RESIZE_ZONE, Math.max(2, (x1 - x0) / 3));
    onEdge = x >= x1 - zone;
  }
  return { x, y, rawTick, tick: snapDown(rawTick, snapDraw(e)), midi, hit, onEdge, ghost };
}

/**
 * 移動：拖曳中就更新預覽，否則把「按下去會畫在哪」用虛線框出來並換游標。已經有音符的
 * 格子不框 —— 那裡按下去是選它或拖它。
 */
function onPointerMove(e) {
  if (e.pointerType === "touch") { onTouchMove(e); return; }
  // Ctrl+V 的落點。**存 client 座標而不是 tick**：拖曳中畫面捲動時，同一個螢幕位置指的是
  // 不同的音樂位置，而使用者要的是「現在指著的那一格」。排在 drag 之前 —— 拖曳中滑鼠仍然
  // 在捲軸上，位置照樣有效。
  hoverPt = { clientX: e.clientX, clientY: e.clientY };
  if (drag) { onDragMove(e); return; }

  // 待判定中：超過門檻就升級成框選，沒超過就什麼都不做。特別是不更新 `markCursor`
  // —— 提交月用的是按下那一刻的 tick，讓那條線跟著滑鼠跑會變成在騙人。
  if (pend) {
    if (Math.hypot(e.clientX - pend.x0, e.clientY - pend.y0) > MARQUEE_SLOP) startMarquee(e);
    return;
  }

  // 試聽中：在鍵盤上滑動就換音。滑出鍵盤範圍時不換也不停 —— 手抖一下就斷音會很難用。
  if (audition) {
    const k = keyAt(e);
    if (k !== null) startAudition(k, audition.pid);
    return;
  }

  // 左上角的拍號格：按下去（右鍵）會開選單
  if (onHeadMeter(e)) {
    cv.style.cursor = "context-menu";
    if (hover || markCursor !== null) { hover = null; markCursor = null; draw(); }
    return;
  }

  // 鍵盤上的游標形狀：這裡按下去會發出聲音（播放中不會，所以維持箭頭）
  if (keyAt(e) !== null) {
    cv.style.cursor = sounding() ? "default" : "pointer";
    if (hover || markCursor !== null) { hover = null; markCursor = null; draw(); }
    return;
  }

  // 在小節尺上：用一條貫穿整張 canvas 的虛線標出「按下去線會落在哪」。只在尺上畫小三角
  // 的話，你得自己把它往下延伸到音符那一列去對位置。
  const rt = rulerTick(e);
  if (rt !== null) {
    cv.style.cursor = "col-resize";
    if (rt !== markCursor || hover) { markCursor = rt; hover = null; draw(); }
    return;
  }
  const at = song ? locate(e) : null;

  // 別十軌的音符上：`alias` 游標（「按下去會跳到那一軌」）。排在空白處那條之前，因為鬼影
  // 格在 `locate` 眼裡也是空白。那條虛線要清掉：在鬼影上按下去不設線，留著就是騙人。
  // 代價是密譜上的閃爍變嚴重。`alias` 跟這張 canvas 上另外三種游標都不撞，而且「捷徑」
  // 的意思剛好就是「這不是它本人」。
  if (at?.ghost) {
    cv.style.cursor = "alias";
    if (hover || markCursor !== null) { hover = null; markCursor = null; draw(); }
    return;
  }

  // select 模式下的空白處：給它跟尺上一樣的虛線游標（點一下就是設線）。
  //
  // 但游標形狀是 `default` 而不是 `col-resize` —— 後者的左右箭頭承諾「這裡可以水平調整範圍」，
  // 而現在拖出來的是二維方框。也不換 `crosshair`：按下去會發生什麼取決於接下來拖不拖，沒有
  // 任何形狀表達得出「還沒決定」。密譜上橫向移動時那條虛線會閃爍（音符上沒有、空隙有），那是
  // 雙重身分的必然結果。
  const onBlank = at && !at.hit && tool === "select";
  if (onBlank) {
    cv.style.cursor = "default";
    const t = markTickAt(e);
    if (t !== markCursor || hover) { markCursor = t; hover = null; draw(); }
    return;
  }
  if (markCursor !== null) { markCursor = null; draw(); }

  // 游標形狀就是在講「現在按下去會發生什麼」
  cv.style.cursor = !at || !canEdit() ? "default"
    : at.hit ? (at.onEdge ? "col-resize" : "move")
    : "default";

  // 只有 draw 模式才框「卜音會畫在這」。select 模式的空白處走上面那條路（虛線游標）。
  const next = at && !at.hit && canDraw() ? { tick: at.tick, midi: at.midi } : null;
  if (next?.tick === hover?.tick && next?.midi === hover?.midi) return;   // 同一格不重畫
  hover = next;
  draw();
}

/**
 * 右鍵：尺上與 select 模式的空白處設結束線，音符上刪除它（變回同長度的休止符）。空白處
 * 那條跟左鍵不一樣不必等放開 —— 右鍵沒有拖曳語意，按下就是全部的意圖。
 */
/** 上一次按下是不是觸控。contextmenu 用它擋掉 Android 的重複開啟。 */
let lastDownTouch = false;

/**
 * 右鍵。每一個位置都開選單，只是開哪一個不一樣：左上角是拍號、小節尺是演奏範圍與變拍、音符上
 * 是那個音、其餘是時間軸。尺上這一手是退步而且是知道的（設結束線從一下變成兩下），換到的是另
 * 外四件在尺上原本沒有入口的事。
 */
function onContextMenu(e) {
  e.preventDefault();
  // 觸控的選單走自己的長按計時器（見 holdFire）。Android Chrome 長按也會發這個事件，
  // 不擋的話會跟計時器各開一次 —— 而 iOS 不發，所以也不能反過來只靠它。
  if (lastDownTouch) return;
  // 左上角那一格 = 曲首拍號。排在尺之前：兩者判定區不重疊，但順序寫死比依賴那個前提安全。
  if (onHeadMeter(e)) { onMeterMenu({ x: e.clientX, y: e.clientY }); return; }
  openMenu(e.clientX, e.clientY);
}

/**
 * 開音符／空白選單。滑鼠右鍵與觸控長按共用這一份 —— 兩個入口的判定條件不同，但「在哪裡
 * 按了、該開哪個選單」日是同一件事。
 */
function openMenu(cx, cy) {
  // locate / markTickAt 只讀 clientX/clientY，所以合成一個就夠 —— 長按沒有事件物件。
  const e = { clientX: cx, clientY: cy };

  // 左上角的拍號格。排在 `!song` 之前：空譜也該能先把拍號設好再開始寫。
  if (onHeadMeter(e)) { onMeterMenu({ x: cx, y: cy }); return; }

  // 小節尺。同樣排在 `!song` 之前 —— 空譜也該能先框好範圍。
  const rt = rulerTick(e);
  if (rt !== null) {
    onBarMenu({
      x: cx, y: cy,
      markTick: rt,                                  // 兩條演奏線與力度用（32 分格）
      barTick: barStartTick(barIndexOf(rt)),         // 變拍用（對齊到小節線）
      bar: barIndexOf(rt),
      canEdit: canEdit(),
      whyNot: canEdit() ? "" : whyNot,
    });
    return;
  }

  if (!song) return;

  const at = locate(e);
  // 左側鍵盤與尺以外的空白處（`locate` 回 null 表示落在鍵盤或尺上，那兩個不開選單）
  if (!at) return;

  if (at.hit) {
    // 右鍵沒選中的音 → 先單選它；右鍵選取內的音 → 整組原封不動。這是檔案總管與每一個
    // DAW 的行為，而它換到的是「單選與多選共用同一份選單」—— 選單的每一項都作用在選取。
    //
    // `onPick` 是同步的，所以下一行讀到的 `selection` 已經是新竹的。
    if (!selKeys.has(selKey(at.hit.tick, at.hit.midi))) onPick(at.hit);
    onNoteMenu({
      x: e.clientX, y: e.clientY,
      note: { tick: at.hit.tick, midi: at.hit.midi, dur: at.hit.durTick },
      canEdit: canEdit(),
      whyNot: canEdit() ? "" : whyNot,
    });
    return;
  }

  onRollMenu({
    x: e.clientX, y: e.clientY,
    markTick: markTickAt(e),                       // 兩條演奏線用這個（32 分格，夾到曲末）
    // 貼上用這個 —— **沒有夾**。理由見 markTickAt 上面那段：夾子是為演奏線做的，而貼到
    // 曲末之後是合理的動作。這一格是「使用者剛剛右鍵（或長按）的那個位置」，手機上尤其
    // 重要：他在正確的點長按叫出選單，貼上就該落在那裡。
    pasteTick: markTickRaw(e),
    // 小節增刪用這個。不能用 `snapDown(t, BAR_TICKS)` —— 小節不等長之後「往下取整到
    // 小節線」是查表，不是除法。跟著 markTick 夾，見上。
    barTick: barStartTick(barIndexOf(markTickAt(e))),
    canEdit: canEdit(),
    whyNot: canEdit() ? "" : whyNot,
  });
}

/**
 * 拍號的 UI 開著嗎（設定抽屜那個開關）。ui 在開關動、以及初始化時推進來。關掉時左上角
 * 那一格就只是底色，右鍵也不開選單 —— 整個功能完全隱形。
 */
export function setTimeSigUI(on) {
  const v = !!on;
  if (v === timeSigUI) return;
  timeSigUI = v;
  draw();
}

export function setEditable(ok, reason = "") {
  editable = ok;
  whyNot = ok ? "" : reason;
  // 不能編就不要框、也不要留著拖曳中的狀態。（`pend` 一起清：狀態換人之後那個決定已經
  // 無效了。）
  if (!ok) { hover = null; drag = null; pend = null; }
  syncToolbar();
  draw();
}

/**
 * 由 ui 告知「這裡有問題」。跟唯讀無關 —— 卜這一軌照樣能編。兩種問題（見
 * mml-compress.repairItems）：時值寫不出來（寫回時會被 snap）、非標準時值（`l19.` 這種）。
 *
 * 兩層標記都要：`bars` 是導航用的，而且休止符只有這一層標得到（捲軸上休止符沒有方塊）；
 * `keys` 是「就是這一個音」。這取代了「整軌唯讀」—— 唯讀會把使用者鎖死。
 *
 * @param {Iterable<string>} keys `${tick}:${midi}`，跟 setSelection 用同一套鍵
 * @param {Iterable<number>} bars 小節序號（0 起算）
 * @param {string} note 工具列要顯示的說明（空字串 = 沒問題）
 */
/**
 * 這一軌有幾個還原得掉的非標準時值。0 = 那一格不出現。
 *
 * 判定刻意是**便宜的**（呼叫端只問「seenNums 裡有沒有非標準分母」，不真的試跑一次還原）。
 * 支線那邊為了「按了會不會真的減少」跑了完整的 restoreStandard 並加了一層快取，理由是它那
 * 一格會蓋掉紅色音符、釘住就等於永久遮蔽；我們兩格並存，沒有那個陷阱，所以不必在「每敲一個
 * 鍵都會走到」的路徑上多跑一次產生器。按了沒東西可還原時由 ui 用一句 toast 講。
 */
export function setNonstd(n, zipped = false) {
  nonstdN = n | 0;
  nonstdZip = !!zipped;
  syncToolbar();
}

export function setBadNotes(keys, bars = [], note = "") {
  badKeys = new Set(keys);
  badBars = new Set(bars);
  badNote = badKeys.size || badBars.size ? note : "";
  syncToolbar();
  draw();
}

// ─── 工具列 ─────────────────────────────────────────────────────────────────

/**
 * 工具列現在選的音符長度與附點。
 *
 *  **產品端一個消費者都沒有，它們是 test seam** —— `test/rollmarquee.test.mjs` 用
 * `noteLength()` 當「真的切到繪製模式了嗎」的前提斷言，`test/rollkeys.test.mjs` 用
 * `noteDotted()` 驗附點。grep `wwwroot/js/` 會什麼都找不到，**那不代表可以刪**（做過一次，
 * 當場紅一條測試）。
 */
export const noteLength = () => noteLen;
export const noteDotted = () => noteDot;

export const isFollowing = () => follow;

/**
 * 開關跟隨換頁。動到水平捲軸會自動關掉（見 init 的 scroll handler），按開關可以再打開
 * —— 「關掉之後只能等下一次演奏」很煩。
 */
function setFollow(on) {
  follow = on;
  syncToolbar();
  // 播放中重新打開就立刻跳到導播線那一頁，不月用等它自己走過來
  if (on) {
    const t = guideTick();
    if (t !== null) followGuide(t, box.clientWidth);
  }
}

function initToolbar() {
  const fb = document.getElementById("followBtn");
  if (fb) fb.addEventListener("click", () => setFollow(!follow));

  // 「全部」是唯一按得動的那顆，作用是清掉兩條線。「部份」只是狀態顯示 —— 它用
  // aria-disabled 而不是 disabled，因為停用的按鈕在部分瀏覽器收不到滑鼠事件，那個
  // 「要去尺上設線」的 tooltip 就出不來。
  const rs = document.getElementById("rangeSel");
  if (rs) rs.addEventListener("click", e => {
    const b = e.target.closest("button[data-range]");
    if (b && b.dataset.range === "all") clearMarks();
  });
  syncRange();

  // 箭頭在 #lens 外面（它是模式不是長度），但跟六顆長度互斥
  const sel = document.getElementById("toolSelect");
  if (sel) sel.addEventListener("click", pickSelect);

  // 縮放：兩個 stepper，各兩個半格。事件走委派 + closest，認的是 data-zoom 不是位置。
  // 按鈕不傳錨點：按它的時候滑鼠在工具列上，`setZoom` 會退回內容區的中心。title 從
  // i18n 填 —— markup 那邊不再多開四人個 .resx key。
  const zg = document.getElementById("zoom");
  if (zg) {
    zg.addEventListener("click", e => {
      const b = e.target.closest("button[data-zoom]");
      if (!b) return;
      stepZoom(b.dataset.zoom[0], b.dataset.zoom[1] === "+" ? 1 : -1);
    });
    for (const b of zg.querySelectorAll("button[data-zoom]"))
      b.title = i18n.t(`roll.zoom.${b.dataset.zoom[0]}${b.dataset.zoom[1] === "+" ? "In" : "Out"}`);
  }

  // 音符圖示 = 附點的開關。**是 `<button>` 而不是加了 cursor 的 `<span>`** —— 「不要那個
  // 框」是 CSS 一行的事，而 `<button>` 免費給的三樣（Tab 到得了、Enter／Space 按得下去、
  // `aria-pressed` 講得出開關狀態）自己寫要三倍的碼。它跟 #lens 六顆的區別因此在**語意層**
  // 就成立了：那六顆是互斥單選，這顆是切換。
  document.getElementById("lensLbl")?.addEventListener("click", toggleNoteDot);

  const wrap = document.getElementById("lens");
  if (!wrap) return;
  wrap.addEventListener("click", e => {
    const b = e.target.closest("button[data-len]");
    if (b) setNoteLength(+b.dataset.len);
  });
  // FL Studio 那套：0 是箭頭（只選取），1–6 切音符長度。
  // 0 排在 1–6 前面是因為它在鍵盤上也排在前面，而且「回到不會畫東西的模式」
  // 是最常按的一個 —— 畫完幾個音就想回去點譜對照 MML。
  //
  //  **`7`（六十四分音符）刻意沒有按鈕，只有鍵**：它順著 1–6 這個看得見的序列藏著，
  // 而工具列多一顆會讓每個人都付出「這是什麼」的成本，換到的只有少數人偶爾要的東西。
  // 代價寫在 setNoteLength 與 syncToolbar 裡（七顆全暗、預設縮放下只有 6px）。
  addEventListener("keydown", e => {
    if (e.ctrlKey || e.altKey || e.metaKey) return;
    // 在 textarea 裡打字時不要攔
    if (editing(e.target)) return;
    // 對話框開著也不攔（同上面那個 keydown）—— 那些框聚焦的是 `<button>`，上面那道守衛認不
    // 出來，於是在合併音軌的框裡按 3 會默默把工具列的音符長度換掉。排在 textarea 那道之
    // 後：打字是最熱的路徑。`#rollMenu` 同理。
    if (document.querySelector(MODAL_SEL)) return;
    if (e.key === "0") { pickSelect(); e.preventDefault(); return; }
    const i = "1234567".indexOf(e.key);
    if (i >= 0) { setNoteLength([1, 2, 4, 8, 16, 32, 64][i]); e.preventDefault(); }
  });
  syncToolbar();
}

/**
 * 「↑↓←→微調」卜這一句只在拖曳期間出現。不能在選取音符時就寫：方向鍵那時候是文字區的
 * 原生游標移動，使用者照著按會把選取塌成游標 —— 提示騙人比沒有提示糟。
 */
function fineHint() {
  // 框選沒有微調（方向鍵只是被吃掉，見 nudge），工具列也不為它加提示 —— 框跟著滑鼠、
  // 圈到的音當場亮起白框，話已經講完了。
  if (!drag || drag.mode === "marquee") return "";
  return i18n.t(drag.mode === "resize" ? "roll.fineResize" : "roll.fineMove");
}

/**
 * 拖曳中「放開會發生什麼」的一句話。刪除與截短分開講、而且刪除排在前面 —— 一個動作可能
 * 同時造成兩種，而只有刪除是不可逆的。
 */
function effectMsg() {
  const eff = drag?.effect;
  if (!eff) return "";
  const parts = [];
  if (eff.nKill) parts.push(i18n.t("roll.willDelete", { n: eff.nKill }));
  if (eff.nTrim) parts.push(i18n.t("roll.willTrim", { n: eff.nTrim }));
  return parts.join(" · ");
}

/** 切到只選取模式。箭頭那顆與 0 鍵共用。 */
function pickSelect() {
  if (tool === "select") return;
  // 正在畫的那個框要收掉：切走之後 canDraw() 是 false，放開卻還是會寫進去。
  // setNoteLength 同理（框的長度已經定了，換長度不會反映到手上這人個框）。
  if (drag?.mode === "create") endDrag(false);
  tool = "select";
  // 兩個模式在空白處的游標提示不一樣，切過去的瞬間滑鼠可能停著不動 —— 不清掉的話會
  // 留著上一個模式的樣子直到使用者移動滑鼠。
  hover = null;
  syncToolbar();
  draw();
}

function setNoteLength(n) {
  if (drag?.mode === "create") endDrag(false);   // 理由同 pickSelect
  noteLen = n;
  //  **`7`（六十四分音符）會把附點關掉。** l64. = 45 tick，那個長度這個介面刻意不做
  // （見 rolledit.DOT_DENOMS）。三種處理裡選「靜靜關掉」而不是「拒絕切換」或「留著但不生
  // 效」—— 後者會讓那顆圖示說謊，而它的唯一職責就是講真話。1–6 則**保留**附點：附點是獨
  // 立的修飾，不是長度的一部分。
  if (n === 64) noteDot = false;
  tool = "draw";   // 挑長度就是要畫，順手從 select 模式切回來
  markCursor = null;   // draw 模式的空白處不設線，那條虛線留著是騙人（同 pickSelect）
  syncToolbar();
  draw();          // 虛線框的寬度就是音符長度，換了要馬上看得出差別
}

/**
 * 切換「接下來畫的音符帶不帶附點」。**只有繪製模式有這件事** —— 箭頭模式不畫東西，那時
 * 那顆標籤顯示的是虛線框，上面沒有音符可以加附點（見 syncToolbar）。
 *
 * `noteLen === 64` 時不作用：`7` 是「我要六十四分音符」，那是明確的主張該讓它成立；而附點
 * 在 64 上是「我要一個不存在的東西」，沒有東西可以給。
 */
function toggleNoteDot() {
  if (tool !== "draw") return;
  //  **六十四分音符報一句，不要靜靜不動。** 「按了沒反應」在一顆看得見的按鈕上是壞掉，
  // 而這裡有話可說。這不牴觸「不作用」—— 狀態確實一個都沒改，只是把理由講出來。
  if (noteLen === 64) { say(i18n.t("roll.len.noDot64")); return; }
  if (drag?.mode === "create") endDrag(false);   // 理由同 setNoteLength
  noteDot = !noteDot;
  syncToolbar();
  draw();          // 虛線框寬度變 1.5 倍，要馬上看得出來
}

/**
 * 音符長度那顆圖示（`#lensLbl`）。**它回答的是「空白處按下去會發生什麼」**，不是「音符長度
 * 是多少」—— 那個區別決定了只選取模式下要顯示什麼。
 *
 *   繪製模式    當下的時值符號（13 顆之一，含附點）。按鈕活的，按下去切換附點
 *   只選取模式  一圈虛線框 + 通用的 ♫。按鈕停用（順帶退出 Tab 順序）
 *
 *  **只選取模式為什麼不是「同一顆音符但變暗」**：`.lbl` 的顏色本來就是 `--dimmer`，那已經
 * 是調色盤最底層，「再暗一點」做出來是看不見的差別。換一個**形狀**才看得見。
 *
 *  **框裡放通用的 ♫ 而不是我們自己那 13 顆**：每一顆都是特定時值，放 `ni-4` 進去讀起來會
 * 變成「框選四分音符」。那是假話 —— 框選跟音符長度無關。
 *
 * 六十四分音符**不停用**：停用會讓它跟著變灰，而那顆圖示正是 `7` 唯一的顯示（工具列七顆全
 * 暗）。按下去改成報一句（見 toggleNoteDot）。
 */
function syncLensIcon() {
  const b = document.getElementById("lensLbl");
  if (!b) return;
  const drawing = tool === "draw";
  b.classList.toggle("sel", !drawing);
  b.disabled = !drawing;
  b.setAttribute("aria-pressed", String(noteDot));

  const use = b.querySelector("use");
  if (use) use.setAttribute("href", `#ni-${noteLen}${noteDot ? "d" : ""}`);

  // 可及名稱只講**時值**，開關狀態交給 `aria-pressed` —— 讀出來是「四分音符，切換鈕，已按
  // 下」，比塞成一句話好懂。
  const name = b.querySelector(".sr");
  if (name) {
    const len = i18n.t(`roll.len.n${noteLen}`);
    name.textContent = !drawing ? i18n.t("roll.len.idle")
      : noteDot ? i18n.t("roll.len.dotted", { name: len }) : len;
  }
  b.title = drawing
    ? i18n.t(noteLen === 64 ? "roll.len.noDot64" : "roll.len.toggle")
    : "";
}

function syncToolbar() {
  // 虛擬遙桿面板掛在這裡，因為 syncToolbar 就是這個檔案裡「狀態變了」的匯流點 ——
  // 掛在這裡，播放一開始面板就自己收了。
  syncJoy();

  // 箭頭與六顆長度互斥，永遠只有一個亮著
  const sel = document.getElementById("toolSelect");
  if (sel) sel.classList.toggle("on", tool === "select");
  document.querySelectorAll("#lens button[data-len]").forEach(b => {
    b.classList.toggle("on", tool === "draw" && +b.dataset.len === noteLen);
  });
  syncLensIcon();

  // 縮放：到頂／到底就灰掉。用 disabled 而不是只是不動 —— 按了沒反應的按鈕沒辦法告訴
  // 使用者「已經最大了」，而這一組沒有別的地方顯示目前在第幾檔。不跟著 `editable` 走：
  // 縮放是「怎麼看」不日是「改什麼」。
  document.querySelectorAll("#zoom button[data-zoom]").forEach(b => {
    const w = b.dataset.zoom[0] === "w";
    const dir = b.dataset.zoom[1] === "+" ? 1 : -1;
    b.disabled = zoomStep(w ? ZOOM_W : ZOOM_H, w ? CELL_W : ROW_H, dir) === null;
  });

  const t = document.getElementById("rollTrack");
  if (t) {
    t.textContent = i18n.trackName(active);
    t.style.color = TRACK_COLORS[active];
  }

  // 三個狀態，不是兩個。正在出聲時兩邊唯讀，寫「編輯中」是錯的；而暫停中是可以編輯的，
  // 寫「演奏中」也是錯的。「暫停中」同時回答了「曲子沒結束」與「現在可以改」。
  const mode = document.getElementById("rollMode");
  if (mode) {
    const paused = player.isPlaying() && player.isPaused();
    mode.textContent = i18n.t(sounding() ? "roll.mode.playing"
      : paused ? "roll.mode.paused" : "roll.mode.editing");
    // playing 這個 class 是「不能編輯」的視覺提示，所以暫停中不掛它
    mode.classList.toggle("playing", sounding());
  }
  const fb = document.getElementById("followBtn");
  if (fb) fb.classList.toggle("on", follow);

  // 唯讀的原因要講出來，不然「點空白處沒反應」找不到理由。紅色音符的說明走同一個位置
  // —— 真的同時有的話唯讀優先：那時你木根本編不了。
  const note = document.getElementById("rollNote");
  if (note) {
    // 拖曳中的破壞警告插在唯讀理由之後、紅色音符說明之前。順序就是急迫性：「放開就會
    // 刪掉一個音」是現在這一秒、按 Esc 還來得及的事。
    const msg = whyNot || effectMsg() || badNote;
    note.textContent = msg;
    note.classList.toggle("on", !!msg);
  }
  //  非標準時值那一格。**不跟 #rollNote 互斥** —— 一軌可以同時有非標準時值與寫不出來的時值，
  // 藏掉紅字會讓那些音變成看不見。唯讀時整格收掉：那時按了也編不了。
  //
  //  每次都整格重建（textContent 清空再 append），所以 click listener 不會累積。
  const ns = document.getElementById("rollNonstd");
  if (ns) {
    const show = nonstdN > 0 && !whyNot && !!onNonstdFix;
    ns.hidden = !show;
    if (show) {
      ns.textContent = "";
      const txt = document.createElement("span");
      txt.textContent = i18n.t("ui.nonstd.warn", { n: nonstdN });
      const btn = document.createElement("button");
      btn.type = "button";
      btn.textContent = i18n.t("ui.nonstd.fixBtn");
      btn.title = i18n.t("ui.nonstd.fixHint");
      btn.addEventListener("click", () => onNonstdFix());
      ns.append(txt, btn);
      //  壓縮模式碰到非標準時值會早退（見 ui 的 zipFinal），而解法就是左邊那顆鈕。
      // **話講在這裡而不是彈一句 toast** —— 這一格本來就常駐，訊息長在解法旁邊，而且
      // 不打斷任何事。每動一個音就唸一次的提示比字數跳回去還吵。
      if (nonstdZip) {
        const zipTxt = document.createElement("span");
        zipTxt.className = "zipnote";
        zipTxt.textContent = i18n.t("ui.nonstd.zipHint");
        ns.append(zipTxt);
      }
    }
  }

  // 同一句話在遙桿面板上也放一份。那是手機上唯一看得到的破壞警告 —— `#rollNote` 在工具
  // 列，離手指很遠，而且那一格在窄視窗會被 CSS 藏起來。
  //
  // 沒有警告、而框選正武裝著時，那一行改放「拖曳＝框選 · 雙指捲動」。**單指拖曳在那個狀
  // 態下不再是平移**，而 README 對這件事的原話是「沒有任何地方看得出來」—— 這就是那個地方。
  //
  // 條件問的是 `marqueeArmed()` 而不是 `multiPick`：繪製模式下多選也亮得起來（面板不問
  // `tool`），但那裡單指拖曳照樣是平移，寫那句話就是說謊。
  //
  // 放在面板上而不是 `#rollHint`，理由跟破壞警告一模一樣：工具列那一行會被 ellipsis 截成
  // 一個「…」，而它離手指最遠。警告優先，兩者在時間上本來就互斥（警告只在拖曳中出現）。
  const warn = effectMsg();
  if (warn) rolljoy.setEffect(warn);
  else rolljoy.setEffect(marqueeArmed() ? i18n.t("roll.pad.multiHint") : "", "note");
  document.querySelectorAll("#lens button[data-len]").forEach(b => { b.disabled = !editable; });
  if (sel) sel.disabled = !editable;

  // 說明文字要跟著模式走，不然 select 模式下寫著「左鍵畫」是錯的
  const hint = document.getElementById("rollHint");
  if (hint) {
    // 播放中一條都不成立（兩邊唯讀），照著寫是在騙人。但尺上那兩條線是例外：播放中挪它
    // 會立刻改變正在播的範圍，而那時它是唯一還活著的滑鼠操作。暫停中操作說明照常寫，但
    // 要多一句「改動恢復後生效」—— 那是這個狀態唯一不直覺的地方。
    const paused = player.isPlaying() && player.isPaused();
    hint.textContent = (sounding()
      ? i18n.t("roll.hint.playingReadonly")
      : i18n.t(tool === "draw" ? "roll.hint.edit" : "roll.hint.editNoDraw") + fineHint())
      + (paused && !sounding() ? i18n.t("roll.hint.pausedSuffix") : "");
    // 窄視窗會把卜這一行藏起來讓工具列不要換行，但這兩句不能藏 —— 它們不是操作說明，是在
    // 回答「我改了為什麼沒生效」。CSS 靠這個 class 分辨。
    hint.classList.toggle("keep", sounding() || paused);
  }
}
