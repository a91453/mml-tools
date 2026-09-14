// ────────────────────────────────────────────────────────────────────────────
//  鋼琴瀑布影片頁（/waterfall/{guid}）
//
//  這一頁把七支既有模組接起來，**刻意不碰 `ui.js` / `engine.js` / `player.js`** ——
//  那三支是編輯器的，拉進來等於為了用七支而下載四十幾支。
//
//    樂譜   分享入口由伺服器印 {id, mml}；本機入口從 Cache Storage token 取回同一種 MML
//    音訊   進頁面就跑一次 `mixdown.renderPcm`，得到整首的 Float32 PCM
//    預覽   播那份 PCM（`AudioBufferSourceNode`）＋ `waterfall.draw`
//    匯出   **重用同一份 PCM**，逐幀 draw → VideoEncoder，PCM → AudioEncoder，`mp4.muxMp4`
//
//  ─── 為什麼預覽要先把整首算完，而不是即時合成 ───
//
//  因為這樣「預覽聽到的」與「檔案裡的」是**同一段取樣**，byte-identical。即時合成走
//  `WorkletSynthesizer`、匯出走 `SpessaSynthProcessor`，`mix-worker.js` 的檔頭花了一整段
//  解釋為什麼 BLOCK 必須是 128 才能讓兩者「很接近」—— 先算完就讓那個問題不存在。
//
//  順帶兩件事：匯出時最慢的一段（合成）已經在使用者看瀑布的時候做完了；而 seek 從
//  「look-ahead 排程器」變成 `source.start(0, offset)` 一行。
//
//  ─── 音量：影片是發佈物，所以走響度正規化，不是 renderPcm 的「只縮不放」───
//
//  `renderPcm` 回傳的 `gain` 只保證不削波，那對 mp3 是對的（**那是你的曲子的檔案**）。
//  影片不是 —— 每個平台都會把收到的東西推到 −14 LUFS 附近，而一首 −18.7 LUFS 的曲子被
//  平台推 5 dB 之後，六軌的高潮頂到天花板、三軌的間奏還是小聲。與其讓平台推，不如自己
//  推到位：推完平台就不會再動它，而段落之間的對比原封不動（**我們只改整體音量，不壓縮**）。
//
//  用 `mixmath.gainForLoudness`，它同時受峰值上限約束 —— 推不到目標時寧可小聲一點，
//  削波是回不去的。
//
//  **這個係數預覽與編碼兩邊都要乘，而且必須是同一個** —— 少了任何一邊，「預覽等於成品」
//  這個唯一的賣點就沒了。所以它算一次存在 `masterGain`，兩邊都讀它。
// ────────────────────────────────────────────────────────────────────────────

import {
  assetURL, BUILTIN_BANK, BUILTIN_DEF, GAME_TRACKS, NOTE_COLORS, NOTE_COLOR_ORDER,
} from "./config.js";
import * as i18n from "./i18n.js";
import { $, safeFileName } from "./util.js";
import { parseAll, splitMML, stripPrograms } from "./mml.js";
import { parseDef } from "./instruments.js";
import { renderPcm } from "./mixdown.js";
import { gainForLoudness, TARGET_LUFS } from "./mixmath.js";
import * as wf from "./waterfall.js";
import { NOTE_STYLES, HIT_FX, noteStyle, hitFx } from "./wfstyles.js";
import { ENV_PRESETS, envPreset, bakeSteps, seedOfSong } from "./envaudio.js";
import * as envlive from "./envlive.js";
import { loadedWaterfall, saveWaterfall, loadedEnv, saveEnv } from "./storage.js";
import { muxMp4 } from "./mp4.js";
import * as handoff from "./handoff.js";

// ─── 匯出規格 ───────────────────────────────────────────────────────────────

/**
 * 兩種比例。**預設 9:16** —— 這個功能存在的理由是讓人發佈，而發佈的主戰場是短影音。
 * 預設 16:9 等於預設讓每個人多按一次。
 */
const SHAPES = {
  portrait: [9, 16],
  landscape: [16, 9],
};

/**
 * 短邊幾個像素。**依裝置自動，不做成選項** —— 使用者無從判斷自己的手機撐不撐得住 1080p，
 * 而猜錯的下場不是「畫質差一點」，是**分頁被系統殺掉**（見 syncEstimate 的說明）。
 *
 * 判斷用 `pointer: coarse`（主要輸入是手指）。它會把觸控筆電也判成手機 —— 那台機器會拿到
 * 720p，畫面軟一點但一定做得完。**反過來錯（把手機判成桌機）沒有這種餘地**，所以往保守那
 * 邊倒。
 */
const shortSide = () =>
  (matchMedia("(pointer: coarse)").matches ? 720 : 1080);

/** 比例 ＋ 短邊 → 實際的長寬。長邊由比例推，所以 9:16 的 720p 是 720×1280。 */
function sizeOf(name) {
  const [a, b] = SHAPES[name];
  const s = shortSide();
  const unit = s / Math.min(a, b);
  return { w: a * unit, h: b * unit };
}

/**
 * 影格率。**60，編不出來才退回 30。**
 *
 * 曾經固定 30，而當時寫的理由（「瀑布是等速直線運動 —— 那正是 30fps 最擅長、60fps 最看不
 * 出差別的運動型態」）**剛好講反了**：等速直線、高對比邊緣、零動態模糊，是 judder 最明顯
 * 的組合，不是最不明顯的。有隨機快速位移的遊戲畫面反而比較藏得住。
 *
 * 數字在 `waterfall` 那邊：`pps = kbTop / LOOK_AHEAD_SEC`，1080 高時約 359 px/s —— 30fps
 * 下每一幀跳 12px，而整個落程 2.5 秒掃過八成畫面高度，比電影搖鏡的建議快得多。
 *
 * 那句理由還有後半段「渲染時間與檔案大小都加倍」，**後半是假的**：`BITRATE` 是 per second，
 * 跟 fps 無關，所以檔案大小不因 fps 而變（見 `syncEstimate`）。加倍的只有渲染時間。
 *
 * **不做成選項**（同 `BITRATE`、同 mixdown 的 `KBPS`）：使用者無從判斷，代價也不是他能預估的。
 */
const FPS_HI = 60, FPS_LO = 30;

/**
 * 這次匯出用的影格率。**`probe()` 決定，其他地方只讀。**
 *
 * ⚠️ 它要一路穿到 `muxMp4` 的 `frameRate`，而那是 video track 的 timescale ——
 * **跟實際幀距對不上的話整支片的時間軸就歪了**，而且是靜音的（檔案合法、畫面清楚，只有
 * 快慢不對）。
 */
let fps = FPS_HI;

/**
 * 位元率。**不做成選項**，同 `mixdown.js` 對 `KBPS` 的立場：那是使用者做不了的決定。
 *
 * 60fps 之後從 8M／4M 抬成 **1.25 倍**。不是 1.5 倍（那是 YouTube 對 1080p60 的建議）——
 * 那個比例配的是一般實拍內容，而我們的幀間位移從 12px 減半成 6px，**相鄰幀更像**、每幀殘差
 * 更小，邊際成本比一般內容低。多抬那 0.25 換來的是實打實多一截的峰值記憶體，而影片這條路
 * 沒有分段（見 `syncEstimate`）。
 *
 * ⚠️ 「大面積深色 ＋ 漸層，H.264 壓得極好」**只對一半**：省位元是真的，不出色帶不是。位元
 * 預算砍半最先壞的就是光暈邊緣與底板漸層，而那是「換掉頓挫、換來一坨糊」的失敗模式。
 */
const BITRATE = { 1080: 10_000_000, 720: 5_000_000 };

/**
 * 落下速度的檔位 → `waterfall.layout` 的 look-ahead 秒數。**試作中**（見 `syncSpeed`）。
 *
 * ⚠️ **「掉得多慢」跟「一次看得到幾個音符」是同一個旋鈕的兩面。** 使用者說「想慢一點」和
 * 「想一次看到更多音符」講的是同一句話 —— look-ahead 的定義就是「畫面上有幾秒的音樂」，
 * 落下速度只是它除出來的結果。所以**不會有人同時想要「更慢」和「更少音符」**，那個組合在
 * 這個設計裡不存在。
 *
 * **它不改曲速，也不改片長。** 音訊完全不經過 `layout`，而片長是 `tl()` 算的（只吃
 * `LEAD_IN_SEC` / `OUTRO_SEC`）。所以這顆旋鈕**不影響檔案大小** —— `syncEstimate` 不必動。
 *
 * 選值：以 `normal`（＝ `wf.LOOK_AHEAD_SEC`）為軸，兩邊各跨約 1.6 倍一檔。1080 高時的
 * `pps` 分別是 149 / 224 / 359 / 560 px/s。
 *
 * ⚠️ **慢檔不是免費的**：音符的視覺長度也是 `dur × pps`（`waterfall.draw`），而那裡有個
 * `10 * u` 的下限。撞到下限的門檻（`14 / pps` 秒）隨著變慢一路放寬：
 *
 *     fast   560 px/s → 短於 0.025 秒的音符擠成一樣高
 *     normal 359 px/s → 0.039 秒
 *     slow   224 px/s → 0.0625 秒 ← **120 BPM 的 32 分音符剛好就是這個數**
 *     slower 149 px/s → 0.094 秒
 *
 * 也就是說 120 BPM 之下，32 分音符在 `slow` 正好站在邊緣、到 `slower` 就整排變成一樣高的
 * 小方塊，長短資訊消失。**這才是這顆旋鈕真正的代價**，不是速度本身 —— 而且它跟曲子的
 * BPM 有關，所以快歌比慢歌更早撞到。
 *
 * 另一面是這一頁的 `LEAD_IN_SEC` 是 **0**（見 `waterfall.js`，而且它跟 look-ahead 是解耦
 * 的）：調慢只會讓開場那一幀的瀑布更滿，不會變成「空畫面等音符掉下來」。
 */
const SPEED = { slower: 6, slow: 4, normal: wf.LOOK_AHEAD_SEC, fast: 1.6 };

/** 幾秒一顆關鍵幀。2 秒：拖進度條的體驗好、檔案大小也還合理。 */
const KEYFRAME_SEC = 2;

/** 編碼佇列裡最多壓幾幀。**沒有這個背壓長曲會 OOM** —— VideoFrame 是未壓縮的。 */
const QUEUE_MAX = 4;

/** AAC 位元率。192k stereo 對這種素材夠透明。 */
const AAC_BPS = 192_000;

/** 一次餵給 AudioEncoder 幾個取樣。太小會讓呼叫次數爆炸，太大會讓進度條一格一格跳。 */
const AUDIO_BLOCK = 8192;

// ─── 狀態 ───────────────────────────────────────────────────────────────────

let song = null;        // parseAll 的結果
let notes = null;       // waterfall.prepare 的結果
let pcm = null;         // { left, right, sampleRate, gain }。**烘過環境音的那一份**
let masterGain = 1;     // 響度正規化之後的係數。**預覽與編碼共用這一個**

/**
 * 還沒有環境音的乾聲母帶。`renderPcm` 的原始輸出，**整頁生命期都留著**。
 *
 * 留著是為了換環境音時不必重跑合成 —— 那是整條路上最慢的一段，而它早在使用者看瀑布的時候
 * 就做完了。重算的只有殘響一趟加鋪一層床，5 分鐘的曲子大約 1～3 秒。
 *
 * 代價是選了環境音的人會同時持有兩份母帶（5 分鐘約 200 MB）。**選「無」的時候 `pcm === dry`
 * 是同一個物件**，一個 byte 都不會多 —— 那也是為什麼 `envaudio.bake` 對「無」是原樣傳回。
 */
let dry = null;
let shareId = "";
let handoffName = "";
let shape = "portrait";
let busy = null;        // 匯出中的 AbortController；null = 沒在匯出

/**
 * 音符樣式與落鍵特效，存 **id** 不存物件。
 *
 * 存 id 的理由是它同時要往 localStorage 寫，而寫進去的必須是「刪掉那種樣式之後還能安全讀回
 * 來」的東西 —— `wfstyles.noteStyle(id)` 查不到就回第一項，所以一個已經不存在的 id 只會讓
 * 使用者退回預設，不會讓這一頁打不開。
 */
let styleId = NOTE_STYLES[0].id;
let fxId = HIT_FX[0].id;

/** 使用者選的落下速度檔位，見 `SPEED`。認不出來的值一律落回 `normal`。 */
let speedTier = "normal";

/** 這個檔位是幾秒。**預覽與匯出共用這一個** —— 兩邊都餵給 `wf.layout`。 */
const speedSec = () => SPEED[speedTier] ?? SPEED.normal;

/**
 * 外觀對話框停在哪一頁。
 *
 * **刻意不記憶** —— storage 的規矩是「習慣性的記，一次性的不記」，而分頁停在哪裡是後者。
 * `#saveBox` 那組分頁會記，是因為「本機／雲端」對應的是兩種工作習慣；這裡不是。
 *
 * 預設是第一頁。**第一頁不是預設頁的話，使用者會以為自己上次離開時停在那裡** —— 而這個框
 * 明明不記憶。代價是想挑樣式要多按一下。
 */
const COLORS = "colors";
const STYLE = "style";
const FX = "fx";
const TABS = [COLORS, STYLE, FX];
/** 有活縮圖的分頁。顏色那一頁是 CSS，不必跑 rAF。 */
const THUMB_TABS = [STYLE, FX];
let tab = COLORS;

/**
 * 選了哪一個環境音，以及使用者的音量倍率。跟樣式一樣**存 id 不存物件**，理由也一樣。
 *
 * **環境音有自己的按鈕與對話框，不是外觀框的第四頁。** 外觀那三頁全部是「這支影片長什麼
 * 樣」、而且都靠活縮圖回答；環境音是「聽起來怎樣」，唯一的預覽是放出來聽。而且它們改的東西
 * 量級不同：外觀改的是逐幀的畫法（換一下是零成本），環境音改的是母帶（要重算 1～3 秒）。
 */
let envId = ENV_PRESETS[0].id;
let envAmt = 1;
/** 烘焙的世代。使用者一個一個試過去時，回來的舊結果要認得自己已經過期。 */
let envGen = 0;
/** 正在重算嗎。重算期間不能匯出 —— 匯到一半的母帶是半首有環境音、半首沒有。 */
let baking = false;

/**
 * 六軌的配色。存的是**調色盤索引**（`NOTE_COLORS` 的第幾個），不是色碼。
 *
 * 索引是持久化 ID，不能隨 UI 色相排序重排；`NOTE_COLOR_ORDER` 只控制顯示。這次 16→30 色因此
 * 採追加方式，舊使用者的 0–15 仍指向原本顏色。
 *
 * `colors` 是它換算成 `[r,g,b]` 的結果，只在 `colorPick` 變動時重算 —— `wf.draw` 每一幀都要
 * 用，而每幀跑一次 `map(hexRgb)` 是白花的。
 */
let colorPick = wf.colorIds(null);
let colors = wf.colorsOf(colorPick);

/** 色票格正在替哪一軌選色。`-1` 是沒開 —— 顏色頁停在六列那個狀態。 */
let gridFor = -1;

let actx = null, source = null, buffer = null, startedAt = 0, pausedAt = 0, playing = false;

const tl = () => wf.timeline(pcm.left.length / pcm.sampleRate);

// ─── 讀樂譜 ─────────────────────────────────────────────────────────────────

/**
 * 每一軌開頭的 `@n`。**這是分享出去的 MML 唯一帶得動的音色資訊**（見 share.js 的
 * withProgram），而把它對回 `[msb, lsb, program]` 要等 Worker 載完音色庫，所以這裡只讀
 * 出數字，交給 `renderPcm` 的 `programs` 參數。
 *
 * 讀完就從文字裡拿掉 —— 跟 `clipboard.importText` 同一條規矩，`@n` 不是音符。
 */
function readShare(raw) {
  const parts = splitMML(raw).slice(0, GAME_TRACKS);
  const programs = parts.map(p => {
    const m = /@(\d+)/.exec(p);
    return m ? +m[1] : null;
  });
  return { programs, song: parseAll(parts.map(stripPrograms)) };
}

// ─── 音訊 ───────────────────────────────────────────────────────────────────

/** 進頁面就跑。整首合成完才有預覽，所以這一段一定要有像樣的進度顯示。 */
async function prepareAudio(programs) {
  const defBuf = await fetch(assetURL(BUILTIN_DEF)).then(r => r.arrayBuffer());
  const { map: defMap } = parseDef(defBuf);

  dry = await renderPcm({
    song, programs, defMap,
    bank: { kind: "url", url: assetURL(BUILTIN_BANK) },
    onProgress: p => setLoad(p),
  });
  pcm = dry;
}

/**
 * 響度正規化。**影片是發佈物，所以推到目標，不是只保證不削波**（見檔頭）。
 *
 * 交給 `envaudio.bake` 當 `normalize` 用，所以它算的一定是「還沒有環境床」的訊號 —— 那正是
 * 「選一個吵的環境不會讓鋼琴變小聲」的實作位置。
 */
function normalizeMusic(l, r, sr) {
  const g = gainForLoudness(l, r, sr, TARGET_LUFS);
  // 推不到目標是常態（峰值受限），值得能查 —— 但不必打擾使用者。
  console.info(`[鋼琴瀑布] 響度 ${g.lufs.toFixed(1)} LUFS → ×${g.gain.toFixed(3)} → ` +
    `${g.reached.toFixed(1)} LUFS（目標 ${TARGET_LUFS}）`);
  return g.gain;
}

/**
 * 把目前選的環境音烘進母帶。
 *
 * ─── 為什麼要烘，而不是播放時即時疊 ───
 *
 * 因為這一頁唯一的賣點是「預覽聽到的與檔案裡的是同一段取樣」。即時疊的話使用者聽到的雷聲位
 * 置跟檔案裡的不一樣，而那個落差**沒有任何錯誤訊息**。
 *
 * ─── 為什麼在主執行緒分段跑 ───
 *
 * 丟 Worker 的話，要嘛把 100 MB 的乾聲複製一份過去（記憶體峰值變三倍），要嘛轉移過去（取消
 * 的時候就回不來了）。逐段 `yield` ＋ `tick()` 兩個問題都沒有，而且取消只是停止迭代 ——
 * 同 `encodeVideo` 每 10 幀讓出去一次的做法。
 */
async function applyEnv() {
  const token = ++envGen;
  const preset = envPreset(envId);
  const at = playing ? now() : pausedAt;
  const wasPlaying = playing;
  pause();

  envNote("");
  baking = true;
  syncEnvBusy();
  try {
    // 抓素材。**抓不到就說，不安靜地退回乾聲** —— 那種錯誤要等影片發佈出去才會被發現。
    const assets = preset.file || preset.thunder
      ? await envlive.loadForBake(preset, dry.sampleRate)
      : { bed: null, thunders: [] };
    if (token !== envGen) return;

    const it = bakeSteps({
      ...dry, preset, amount: envAmt,
      bed: assets.bed, thunders: assets.thunders,
      seed: seedOfSong(song),
      normalize: normalizeMusic,
    });
    for (let r = it.next(); ; r = it.next()) {
      if (r.done) { pcm = r.value; break; }
      envNote(i18n.t("waterfall.env.working", { p: Math.round(r.value * 100) }));
      await tick();
      if (token !== envGen) return;      // 使用者已經換到別的環境了
    }
    masterGain = pcm.gain;
    makeBuffer();
  } catch (err) {
    if (token !== envGen) return;
    console.error("[鋼琴瀑布]", err);
    // 退回「無」而不是留在一個載不到素材的選擇上 —— 留著的話下一次按匯出會再失敗一次
    envId = ENV_PRESETS[0].id;
    $("#envPick").value = envId;
    pcm = dry;
    masterGain = normalizeMusic(dry.left, dry.right, dry.sampleRate);
    makeBuffer();
    envNote(i18n.t("waterfall.env.failed"));
    return;
  } finally {
    if (token === envGen) {
      baking = false;
      syncEnvBusy();
      syncEstimate();
      syncPlay();
      // 母帶長度會因為殘響尾巴而變 —— 起播位置夾回新的長度裡，不然 seek 會落在檔案外面
      pausedAt = Math.min(at, tl().duration);
      if (wasPlaying) play(pausedAt);
    }
  }
  envNote("");
}

/** 重算期間鎖住製作鈕：匯到一半換母帶的下場是半首有環境音、半首沒有。 */
function syncEnvBusy() {
  $("#wfGo").disabled = baking;
  $("#wfPlayBtn").disabled = baking;
  $("#envPick").disabled = baking;
}

const envNote = msg => {
  const e = $("#envNote");
  e.textContent = msg;
  e.hidden = !msg;
};

/** 滑桿旁邊的讀數。整數百分比 —— 小數點在這裡沒有任何人做得了決定。 */
const syncEnvAmt = () => {
  $("#envAmt").value = envAmt;
  $("#envAmtValue").textContent = `${Math.round(envAmt * 100)}%`;
};

function openEnv() {
  if (busy) return;
  $("#envBox").classList.add("on");
  // 開框就先讓目前選的那個響起來 —— 這個框沒有別的預覽，靜悄悄地打開等於什麼都沒說。
  envlive.audition(envPreset(envId), envAmt)
    .catch(() => envNote(i18n.t("waterfall.env.failed")));
}

/** 關框一定要停試聽 —— 不停的話環境音會在使用者回去看瀑布的時候一直響。 */
function closeEnv() {
  envlive.stop();
  $("#envBox").classList.remove("on");
}

/** 環境音**不跟比例／樣式存在同一格**：混音框也讀它，見 storage 的 `saveEnv`。 */
const persistEnv = () => saveEnv({ id: envId, amount: envAmt });

/**
 * PCM → 一顆可以播的 `AudioBuffer`。**母帶增益在這裡套上**（見檔頭），所以預覽的音量跟
 * 匯出的檔案完全一致。
 */
function makeBuffer() {
  const { left, right, sampleRate } = pcm;
  buffer = actx.createBuffer(2, left.length, sampleRate);
  const l = buffer.getChannelData(0), r = buffer.getChannelData(1);
  for (let i = 0; i < left.length; i++) {
    l[i] = left[i] * masterGain;
    r[i] = right[i] * masterGain;
  }
}

/** `t` 是歌曲時間（前導期間為負），所以起播位置要夾在 0 以上。 */
function play(at = pausedAt) {
  stop();
  const from = Math.max(0, at);
  source = actx.createBufferSource();
  source.buffer = buffer;
  source.connect(actx.destination);
  source.start(0, from);
  startedAt = actx.currentTime - at;
  playing = true;
  syncPlay();
}

function stop() {
  if (source) { try { source.stop(); } catch { /* 已經停了 */ } source.disconnect(); }
  source = null;
}

function pause() {
  pausedAt = now();
  stop();
  playing = false;
  syncPlay();
}

const now = () => (playing ? actx.currentTime - startedAt : pausedAt);

// ─── 預覽 ───────────────────────────────────────────────────────────────────

let view = null;

/** 預覽畫布的短邊。**固定值，不跟著匯出解析度走** —— 見 relayout。 */
const PREVIEW_SHORT = 540;

/**
 * 預覽的畫布，再用 CSS 縮到容器裡。
 *
 * 這是「所見即所得」的實作：`waterfall.layout` 的每個值都是 (W,H) 的線性函式，所以**不管
 * 畫在多大的畫布上，構圖都跟匯出的完全一樣**。預覽因此不必付 1080p 的繪製成本。
 *
 * **短邊固定 540，刻意不跟 `sizeOf()` 走。** 跟著走的話手機（720p）的預覽會變成 360 寬 ——
 * 而那台裝置的螢幕就是主要的觀看區，預覽反而比桌機糊。匯出解析度只該影響檔案，不該影響
 * 使用者在這一頁看到的東西。
 */
function relayout() {
  const [a, b] = SHAPES[shape];
  const unit = PREVIEW_SHORT / Math.min(a, b);
  const cv = $("#wfStage");
  cv.width = a * unit;
  cv.height = b * unit;
  cv.style.aspectRatio = `${a} / ${b}`;
  view = wf.layout(cv.width, cv.height, speedSec());
  pumpWidth();
}

/**
 * 把畫布的實際寬度寫成 `--wfw`，讓 header 與工具列跟著收窄（規則在 waterfall.css）。
 *
 * 量的是 `getBoundingClientRect().width` 而不是 `cv.width` —— 後者是畫布的**內部**像素數
 * （固定 540 短邊），跟它在畫面上佔多寬是兩回事。
 */
function syncWidth() {
  const w = $("#wfStage").getBoundingClientRect().width;
  if (w) $("#page").style.setProperty("--wfw", `${Math.round(w)}px`);
}

/**
 * 量兩次。
 *
 * 第一次寫上去之後工具列可能因為變窄而換行，於是它變高、畫布變矮、畫布也就變窄 —— 第一次
 * 量到的值就過期了。第二次收掉這個差。
 *
 * **兩次就夠，不會沒完沒了**：`max-width` 有下限（見 waterfall.css），窄到那裡工具列就不再
 * 跟著縮，高度也不再變。沒有那個下限的話這裡要寫成迴圈，而那是一個會轉起來的迴圈。
 *
 * 用 rAF 而不是直接量：`relayout` 才剛改完 style，這一刻量到的是上一次的版面。
 */
function pumpWidth() {
  requestAnimationFrame(() => {
    syncWidth();
    requestAnimationFrame(syncWidth);
  });
}

function frame() {
  if (!view || !pcm) return requestAnimationFrame(frame);
  // **匯出中畫布歸 `encodeVideo` 管** —— 而它一幀都不畫給畫面看（見那邊的說明），所以這條
  // 迴圈繼續跑只是用整個場景的成本，一秒重畫六十次一張不會動的畫面。第一列的讀數（時間、
  // 進度條）暫停時本來就是不動的，所以整個跳過不會少掉任何東西。
  if (busy) return requestAnimationFrame(frame);
  const t = now();
  const { start, end } = tl();
  if (playing && t >= end) pause();
  draw($("#wfStage").getContext("2d"), Math.min(t, end), view);
  $("#wfSeek").value = String(Math.min(1, Math.max(0, (t - start) / (end - start))));
  $("#wfTime").textContent = `${clock(t)} / ${clock(end)}`;
  return requestAnimationFrame(frame);
}

const clock = s => {
  const v = Math.max(0, s);
  return `${Math.floor(v / 60)}:${String(Math.floor(v % 60)).padStart(2, "0")}`;
};

/**
 * 預覽與匯出的唯一入口。浮水印在兩邊都畫，所以預覽看得到它會在哪。
 *
 * 樣式與特效在**這裡**由 id 查成物件，而不是存物件在狀態裡：查表是 `wfstyles` 的事，而它
 * 查不到就落回第一項 —— 那條退路只有在每次都經過它的時候才有用。
 */
const draw = (ctx, t, v) => wf.draw(ctx, t, v, notes, {
  style: noteStyle(styleId),
  fx: hitFx(fxId),
  colors,
  // **只有署名，不帶網域。** 浮水印要讓人記得住的是一個**搜尋得到的詞**，不是一串要照著打的
  // 網址 —— 影片被轉貼之後網址打錯一個字就到不了，而「夜光MML」搜尋是唯一解。
  // `drawMark` 的 `sub` 仍然收，只是這裡不傳。
  mark: { text: i18n.t("waterfall.mark") },
});

// ─── 匯出 ───────────────────────────────────────────────────────────────────

const fail = (code, message) => Object.assign(new Error(message), { code });

/**
 * 讓出事件迴圈一輪。背壓與「匯出中進度條與取消鈕還動得了」都靠它。
 *
 * ⚠️ **不能用 `setTimeout`。** 分頁一切到背景，計時器就被節流成一秒一次，隱藏超過五分鐘後更掉
 * 到一分鐘一次 —— 編碼器久久等不到下一幀，瀏覽器就判定它閒置把它收走（`Codec reclaimed due to
 * inactivity`），匯出從中間斷掉。MessageChannel 的訊息不吃節流，背景分頁照原速跑完。
 */
const yielder = new MessageChannel();
const waiting = [];
yielder.port1.onmessage = () => waiting.shift()?.();
const tick = () => new Promise(r => { waiting.push(r); yielder.port2.postMessage(0); });

/**
 * 是不是「編碼器被瀏覽器收走」。**被回收跟這台機器編不出來是兩件事** —— 前者下次不要切走就好。
 * Chromium 給的是 QuotaExceededError，而 WebCodecs 的訊息沒有在地化，比對得起來。
 */
const reclaimed = e => e.name === "QuotaExceededError" || /reclaim/i.test(e.message ?? "");

/** 關掉編碼器。**已經關掉的不要再關** —— 被回收與錯誤路徑上它可能早就自己關了。 */
const shut = enc => { if (enc.state !== "closed") enc.close(); };

/**
 * 這台機器編得出什麼。**在按下去之前就要知道** —— 讓人等三十秒再說「你的瀏覽器不支援」
 * 是最糟的順序。
 *
 * **順便決定這次用幾 fps。** 60 編不出來就退回 30，而不是報「這台裝置編不出 H.264」——
 * 那句話對一台上週還好好匯出過同一支曲子的裝置來說是假的，而且指的方向也是錯的（他換了
 * 瀏覽器一樣不會過）。退回照 `checkFrames` 的前例：**不擋匯出、只在主控台講清楚**，因為
 * 30fps 的成品正是上週的成品。
 *
 * ⚠️ **退的是 fps，不是解析度。** 解析度這一頁是依裝置自動判的（見 `shortSide`），而那個
 * 判斷已經替弱裝置選過 720p 了 —— 在它上面再退一次等於把同一件事罰兩遍，而且 720p 是**看
 * 得見**的降級（整個畫面變軟），30fps 的頓挫則是這個功能上線以來的既有水準。
 */
async function probe() {
  if (typeof VideoEncoder === "undefined" || typeof AudioEncoder === "undefined") {
    return { ok: false, why: "nocodecs" };
  }
  const { w, h } = sizeOf(shape);
  let rate = 0;
  for (const r of [FPS_HI, FPS_LO]) {
    if ((await VideoEncoder.isConfigSupported(videoConfig(w, h, r))).supported) { rate = r; break; }
  }
  if (!rate) return { ok: false, why: "novideo" };
  if (rate !== FPS_HI) {
    console.warn(`[鋼琴瀑布] 這台裝置編不出 ${Math.min(w, h)}p${FPS_HI}`
      + `（${avcCodec(w, h, FPS_HI)} 不支援），退回 ${rate}fps`);
  }
  const a = await AudioEncoder.isConfigSupported(audioConfig());
  // 音訊編不出來時**不是**整件事做不了 —— 但 Phase 1 先不做 MP3 那條退路，見 README。
  if (!a.supported) return { ok: false, why: "noaudio" };
  fps = rate;
  return { ok: true };
}

/**
 * High Profile 的 codec string。**level 要看「解析度 × fps」，不能只看解析度。**
 *
 * level 是**解碼端的門檻宣告**：標高了，內容明明塞得進低 level 的檔案也會被只支援到那一檔
 * 的舊裝置硬解拒收。而 720p 正是弱裝置那條路（`shortSide` 判給手機的）、1080p30 又是
 * 1080p60 編不出來時的退路 —— 兩個都標成 4.2 的話，等於專門懲罰我們正想救的那批人。
 *
 *     macroblocks = ceil(w/16) × ceil(h/16)，level 管的是 macroblocks × fps
 *     1920×1080 ＝ 8160：@30 → 244,800  4.0 的上限是 245,760，**只剩 960 的餘裕**
 *                                       （那是巧合，不是設計出來的安全邊界）
 *                        @60 → 489,600  超標一倍，要 4.2 的 522,240
 *     1280×720  ＝ 3600：@60 → 216,000  4.0 就夠
 *
 * Level 4.1 幫不上忙 —— 它的 MaxMBPS 跟 4.0 一樣是 245,760。直立（1080×1920）的 macroblock
 * 數跟橫的相同，所以同一條規則兩種比例都成立，不必分開判。
 *
 * ⚠️ **檔案裡真正宣告的 level 來自編碼器吐出來的 SPS**（→ `description` → avcC box），不是
 * 這一串。這一串管的是 `isConfigSupported` 的門檻，以及給編碼器的目標。
 */
const avcCodec = (w, h, rate) =>
  (Math.ceil(w / 16) * Math.ceil(h / 16) * rate > 245_760
    ? "avc1.64002A"    // High 4.2
    : "avc1.640028");  // High 4.0

const videoConfig = (w, h, rate) => ({
  codec: avcCodec(w, h, rate),
  width: w, height: h,
  bitrate: BITRATE[Math.min(w, h)] ?? BITRATE[720],
  framerate: rate,
  latencyMode: "quality",
  // `format: "avc"`（＝ AVCC）才會給 `description`（AVCDecoderConfigurationRecord），
  // 那正是 `avcC` box 的內容。預設的 `annexb` **不給 description**，於是 muxer 寫不出 avcC，
  // 檔案打得開卻解不出畫面。
  avc: { format: "avc" },
});

const audioConfig = () => ({
  codec: "mp4a.40.2",              // AAC-LC
  sampleRate: pcm.sampleRate,
  numberOfChannels: 2,
  bitrate: AAC_BPS,
});

/**
 * 逐幀畫 → 編碼。**在主執行緒跑，每一幀 `await` 讓出事件迴圈。**
 *
 * Worker ＋ OffscreenCanvas 的主要好處是「匯出中 UI 不卡，使用者可以繼續編輯」，而**這一頁
 * 沒有編輯器**：匯出中唯一要動得了的是進度條與取消鈕，那靠每一幀那個 `await` 就夠。換來的是
 * 浮水印可以直接 `fillText`（Worker 裡沒有 DOM 字型，得先 rasterize 成 ImageBitmap），而且
 * 狀態不必序列化。
 *
 * ⚠️ **匯出中畫布一次都不畫，聲音也不放。** 曾經每一幀都把正在編的那一幀畫給使用者看，而那
 * 不是免費的：它是**再跑一次完整的場景**（同一批繪圖指令、同一個音符迴圈，只有像素少四分之
 * 三），光柵化那一份多付約 25%，而螢幕一秒只更新 60 次 —— 編碼快的時候畫出來的有一大半沒被
 * 看到就被蓋掉了。進度條講的是同一件事，那份 GPU 時間該全部留給編碼。
 *
 * 聲音在 `exportMp4` 開頭的 `pause()` 就停了；rAF 那條預覽迴圈也在 `frame()` 裡看 `busy`
 * 跳過 —— 不跳的話它會用整個場景的成本，一秒重畫六十次一張不會動的畫面。
 */
async function encodeVideo(signal) {
  const { w, h } = sizeOf(shape);
  const { start, end } = tl();
  const total = Math.ceil((end - start) * fps);

  const cv = document.createElement("canvas");
  cv.width = w; cv.height = h;
  const ctx = cv.getContext("2d", { alpha: false });
  const full = wf.layout(w, h, speedSec());

  const samples = [];
  let description = null;
  let broke = null;
  const encoder = new VideoEncoder({
    output: (chunk, meta) => {
      description ??= meta?.decoderConfig?.description;
      const data = new Uint8Array(chunk.byteLength);
      chunk.copyTo(data);
      samples.push({ data, timestamp: chunk.timestamp, duration: chunk.duration, type: chunk.type });
    },
    // ⚠️ **這裡不能 `throw`。** 這是非同步 callback，沒有人在等它 —— 丟出去只會變成主控台上
    // 一行沒人接的 Uncaught，迴圈根本不知道編碼器已經死了，一路餵到下一幀撞出 InvalidStateError，
    // 於是使用者看到的是「未知錯誤」而不是真正的原因。存起來，讓迴圈自己去看。
    error: e => { broke ??= fail(reclaimed(e) ? "reclaimed" : "video", e.message); },
  });
  encoder.configure(videoConfig(w, h, fps));

  for (let f = 0; f < total; f++) {
    if (broke) { shut(encoder); throw broke; }
    if (signal.aborted) { shut(encoder); throw fail("cancelled", "已取消"); }
    const t = start + f / fps;
    draw(ctx, t, full);

    const frameObj = new VideoFrame(cv, { timestamp: Math.round(f * 1e6 / fps) });
    // finally：`encode()` 丟例外時（編碼器已經關了）這一幀也要關，不然它會活到 GC 才被收，
    // 主控台上就是那句「A VideoFrame was garbage collected without being closed」。
    try {
      encoder.encode(frameObj, { keyFrame: f % (fps * KEYFRAME_SEC) === 0 });
    } catch (e) {
      throw broke ?? e;   // 剛死掉的那一刻丟的是 InvalidStateError，真正的原因在 broke
    } finally {
      frameObj.close();
    }

    // 背壓：不擋的話未壓縮的幀會在佇列裡疊起來。**要看 broke** —— 等的途中編碼器死掉的話，
    // 佇列不一定會歸零，不看就是在這裡空轉到天荒地老。
    while (!broke && encoder.encodeQueueSize > QUEUE_MAX) await tick();
    if (f % 10 === 0) { setExport(f / total * 0.8, "video"); await tick(); }
  }
  if (broke) { shut(encoder); throw broke; }
  await encoder.flush().catch(e => { throw broke ?? e; });
  encoder.close();
  if (!description) throw fail("nodesc", "編碼器沒有給 avcC —— avc.format 設錯了");
  checkFrames(samples, total);
  return { samples, description };
}

/**
 * 送進去幾幀、吐出來幾幀，以及時間戳等不等距。
 *
 * **這兩件事都是無聲的。** 編碼器少吐一幀，muxer 會忠實地把前一幀寫成兩倍長 —— 檔案完全
 * 合法、畫面依然清楚，只有動作會頓一下，而使用者只能形容成「好像卡了一下」。
 *
 * 不擋下匯出：少一幀的影片仍然是一支能用的影片，而重編一次的代價是幾十分鐘。所以只在主控台
 * 講，而且**講清楚是第幾幀、第幾秒** —— 「好像會頓」跟「第 3241 幀那裡少了一幀」差在能不能修。
 */
function checkFrames(samples, total) {
  if (samples.length !== total) {
    console.warn(`[鋼琴瀑布] 送了 ${total} 幀進編碼器，只吐回 ${samples.length} 幀`);
  }
  // 時間戳是整數微秒，而 30 與 60 的間距都除不盡（33333／33334、16666／16667），所以會在
  // 相鄰兩個整數之間跳 —— 容差 1µs 剛好只放過取整，兩種影格率共用同一條線。
  const step = 1e6 / fps;
  const odd = [];
  for (let i = 1; i < samples.length; i++) {
    const d = samples[i].timestamp - samples[i - 1].timestamp;
    if (Math.abs(d - step) > 1 && odd.length < 8) {
      odd.push(`第 ${i} 幀 @${(samples[i].timestamp / 1e6).toFixed(2)}s 間距 ${d}µs`);
    }
  }
  if (odd.length) console.warn("[鋼琴瀑布] 時間戳不等距：" + odd.join("、"));
}

/**
 * PCM → AAC。**母帶增益在這裡套上**，跟預覽那條路乘的是同一個數。
 *
 * `AudioData` 收的是 planar float，而我們手上剛好就是兩條 `Float32Array` —— 但要**複製**
 * 而不是 subarray 直接送：`AudioData` 會接管那塊記憶體，而那兩條 PCM 預覽還要繼續用。
 */
async function encodeAudio(signal) {
  const { left, right, sampleRate } = pcm;
  const lead = Math.round(wf.LEAD_IN_SEC * sampleRate);
  const total = lead + left.length;

  const samples = [];
  let description = null;
  let broke = null;
  const encoder = new AudioEncoder({
    output: (chunk, meta) => {
      description ??= meta?.decoderConfig?.description;
      const data = new Uint8Array(chunk.byteLength);
      chunk.copyTo(data);
      samples.push({ data, timestamp: chunk.timestamp, duration: chunk.duration, type: chunk.type });
    },
    // 同 `encodeVideo`：非同步 callback 裡 `throw` 沒有人接得到。
    error: e => { broke ??= fail(reclaimed(e) ? "reclaimed" : "audio", e.message); },
  });
  encoder.configure(audioConfig());

  // 前導在音訊前面補靜音，而不是把視訊的 timestamp 往前推：補靜音只有這一個地方要記得，
  // 位移則是每一個比對 `t >= n.start` 的地方都要記得（見 waterfall.timeline）。
  // `LEAD_IN_SEC` 預設是 0，所以這一段通常不做事 —— 留著是因為那個常數是可以調的。
  for (let at = 0; at < total; at += AUDIO_BLOCK) {
    if (broke) { shut(encoder); throw broke; }
    if (signal.aborted) { shut(encoder); throw fail("cancelled", "已取消"); }
    const n = Math.min(AUDIO_BLOCK, total - at);
    const planes = new Float32Array(n * 2);
    for (let i = 0; i < n; i++) {
      const src = at + i - lead;
      planes[i] = src < 0 ? 0 : left[src] * masterGain;
      planes[n + i] = src < 0 ? 0 : right[src] * masterGain;
    }
    // **一定要 close()。** WebCodecs 的資源是引用計數的，不關就要等 GC —— 三分鐘的曲子
    // 有近千個 AudioData，Chrome 會開始警告，而記憶體峰值本來就已經是這條路上最緊的東西。
    // `VideoFrame` 那邊一直有關，這裡漏了。
    const audioData = new AudioData({
      format: "f32-planar", sampleRate, numberOfFrames: n, numberOfChannels: 2,
      timestamp: Math.round(at * 1e6 / sampleRate), data: planes,
    });
    try {
      encoder.encode(audioData);
    } catch (e) {
      throw broke ?? e;
    } finally {
      audioData.close();
    }
    while (!broke && encoder.encodeQueueSize > QUEUE_MAX) await tick();
    setExport(0.8 + (at / total) * 0.15, "audio");
  }
  if (broke) { shut(encoder); throw broke; }
  await encoder.flush().catch(e => { throw broke ?? e; });
  encoder.close();
  if (!description) throw fail("nodesc", "編碼器沒有給 AudioSpecificConfig");
  return { samples, description };
}

async function exportMp4() {
  if (busy) return;
  const check = await probe();
  if (!check.ok) { say(i18n.t(`waterfall.err.${check.why}`)); return; }

  pause();
  busy = new AbortController();
  setBusy(true);
  // 擋住螢幕休眠。**拿不到就算了** —— 只有分頁在前景時給得到，而且沒有它匯出照樣跑完。
  const awake = await navigator.wakeLock?.request("screen").catch(() => null) ?? null;
  try {
    const { w, h } = sizeOf(shape);
    const audio = await encodeAudio(busy.signal);
    const video = await encodeVideo(busy.signal);
    setExport(0.97, "mux");
    await tick();

    const bytes = muxMp4({
      video: { width: w, height: h, frameRate: fps, description: video.description,
        samples: video.samples },
      audio: { sampleRate: pcm.sampleRate, numberOfChannels: 2,
        description: audio.description, samples: audio.samples },
    });

    const blob = new Blob([bytes], { type: "video/mp4" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `${safeFileName($("#wfName").value || defaultName())}.mp4`;
    a.click();
    URL.revokeObjectURL(a.href);
    setExport(1, "done");
  } catch (err) {
    if (err.code !== "cancelled") {
      console.error("[鋼琴瀑布]", err);
      say(i18n.has(`waterfall.err.${err.code}`)
        ? i18n.t(`waterfall.err.${err.code}`)
        : i18n.t("waterfall.err.unknown"));
    }
  } finally {
    awake?.release().catch(() => {});
    busy = null;
    setBusy(false);
  }
}

// ─── 畫面 ───────────────────────────────────────────────────────────────────

const setLoad = p => { $("#wfLoadBar").value = p; };
const say = msg => { const e = $("#wfErr"); e.textContent = msg; e.hidden = false; };

/** 本機交棒優先沿用檔案頁曲名；分享入口仍用 guid 前八碼辨識。 */
const defaultName = () =>
  handoffName || (shareId ? `waterfall-${shareId.slice(0, 8)}` : "waterfall");

function setExport(p, phase) {
  $("#wfExpBar").value = p;
  $("#wfPhase").textContent = i18n.t(`waterfall.phase.${phase}`);
}

/**
 * 匯出中：**第二列原地換成進度**，而不是多長一列。
 *
 * 畫布高度是 `flex:1` 算出來的，多一列會讓整個瀑布在按下匯出的那一刻往下跳一格 —— 而那正好
 * 是使用者盯著畫面看的時刻（正在編碼的那一幀就畫在上面）。
 *
 * 第二列上的每一個東西都要停掉，而不是只停匯出鈕：**匯出途中換樣式的下場是半支影片一種樣
 * 式**，而那要等檔案下載完才看得出來。`encodeVideo` 每一幀都重新讀 `styleId`，所以「鎖住
 * UI」就是這件事唯一的防線。縮圖的 rAF 也一起停 —— CPU 要留給編碼器。
 */
const leaveGuard = e => { e.preventDefault(); e.returnValue = ""; };

function setBusy(on) {
  $("#wfMake").hidden = on;
  $("#wfExp").hidden = !on;
  $("#wfPlayBtn").disabled = on;
  $("#wfSeek").disabled = on;
  if (on) { closeLook(); closeEnv(); }
  // 具名影片分頁可能被編輯器下一次交棒重導；編碼中先讓瀏覽器確認，避免無聲丟掉進度。
  if (on) addEventListener("beforeunload", leaveGuard);
  else removeEventListener("beforeunload", leaveGuard);
}

const syncPlay = () => {
  const btn = $("#wfPlayBtn");
  btn.innerHTML = `<i class="fa-solid fa-${playing ? "pause" : "play"}" aria-hidden="true"></i>`;
  const label = i18n.t(playing ? "waterfall.pause" : "waterfall.play");
  btn.title = label;
  btn.setAttribute("aria-label", label);
};

/**
 * 匯出前先講預估大小。**iOS 被 jetsam 殺掉時連 try/catch 都跑不到**，所以預防要在按下去之前。
 *
 * 預估只看 `BITRATE × 秒數`，**跟 fps 無關** —— bitrate 是 per second，60fps 不會讓檔案變大。
 *
 * ⚠️ **這條路沒有分段。** mp3 那邊為了記憶體改成十秒一段（見 README 的混音章節），影片這邊
 * 做不到：`samples` 陣列跟 `muxMp4` 吐出來的 `Uint8Array` 同時活著，峰值大約是檔案的兩倍。
 * 所以影片的記憶體體質比 mp3 差，那也是這條線存在的理由。
 *
 * 警示線 312 MB ＝ 舊的 250 × 1.25，跟著 `BITRATE` 一起抬，維持「大約四分半以上才算長」的
 * 相對位置。**要知道的是：250 從來沒有被校準過**（跟影片功能同一個 commit 進來，沒有留下
 * 依據），所以 312 一樣是猜的，只是往寬鬆的方向猜。真要釘死它需要一台 iOS 實機。
 */
function syncEstimate() {
  if (!pcm) return;
  const { w, h } = sizeOf(shape);
  const secs = tl().duration;
  const mb = (BITRATE[Math.min(w, h)] * secs / 8 / 1048576);
  const el = $("#wfSize");
  el.textContent = i18n.t("waterfall.estimate", { mb: mb.toFixed(0) });
  el.classList.toggle("warn", mb > 312);
}

/**
 * 落下速度選鈕。**試作中** —— 這顆旋鈕要不要留、四檔夠不夠、最慢那一檔要不要砍，是等實際
 * 看過效果再決定的。所以它刻意跟 `#wfShape` 用同一套寫法（`.seg` ＋ radiogroup ＋ `data-`
 * ＋ 一個 sync ＋ 一個 handler），整組拔掉或留下都不會牽動別的東西。
 *
 * 位置在比例與外觀那一段：照 Waterfall.cshtml 立的分界，檔名左邊是**規格**，而速度跟外觀
 * 同類 —— 改的是逐幀的畫法，換一下零成本，而且**不影響檔案大小**（見 `SPEED`）。
 */
function syncSpeed() {
  for (const b of $("#wfSpeed").children) {
    const on = b.dataset.speed === speedTier;
    b.classList.toggle("on", on);
    b.setAttribute("aria-checked", String(on));
  }
}

// ─── 外觀：音符樣式與落鍵特效 ───────────────────────────────────────────────
//
//  ─── 為什麼縮圖是「真的畫一遍再放大」，而不是幾張圖 ───
//
//  因為那讓「縮圖跟成品不一樣」在物理上不可能：縮圖走的是 `wf.draw`，跟預覽、跟匯出是**同一
//  個函式**。而且未來加一種樣式時**縮圖是免費的** —— 不用另外畫一張圖、不用記得更新它。
//
//  ─── 為什麼要裁切放大，而不是把整個畫面縮小 ───
//
//  鍵盤是 88 鍵。整個畫面縮到 300px 寬的話每個鍵只有 3.4px，而音符比鍵還窄 —— 玻璃的內芯、
//  霓虹的描邊、像素的四階明暗全部落在一個像素以內，三種看起來會一模一樣，那個框就白開了。
//
//  作法是**先用 transform 把場景推到裁切框上，再讓 canvas 自己裁掉外面**：場景維持 1920×1080
//  （也就是 `u = 1`，跟匯出同一個筆觸粗細），但只有落在 300×210 那塊裡的像素會被光柵化。所以
//  成本跟「畫一張 300×210 的圖」同一級，而不是「畫一張 1920×1080 的再縮」。
//
//  ─── 會動 ───
//
//  靜態一幀的噴發就是一坨點，分不出「噴發」跟「漣漪」跟「光柱」—— 特效本來就是時間的函式。
//  rAF 只在框開著時跑，關框、切到背景、開始匯出都會停（見 `closeLook` 與 `setBusy`）。

/** 縮圖的內部像素基準。`10 / 7` 必須跟 waterfall.css 的 `aspect-ratio` 是同一個比例。 */
const THUMB_W = 300;
const THUMB_H = 210;

/** 縮圖動畫的週期，秒。樣本譜剛好排滿這麼長，然後整段複製一份接在後面（見 thumbScene）。 */
const THUMB_LOOP = 2.4;

/** 裁切框裡看得到幾個白鍵。10 個大約是一隻手的跨度 —— 再多就看不清楚單一顆音符。 */
const THUMB_KEYS = 10;

/**
 * 縮圖用的樣本譜：`[起點, 長度, 音高, 力度, 第幾軌]`。
 *
 * 三軌是為了讓三種軌道顏色都出現（單色的縮圖看不出「同時很多軌」長什麼樣）；長短混搭是為了
 * 讓漸層與四階明暗兩種畫法都有東西可以表現；61 是黑鍵 —— 黑鍵比白鍵窄，而窄的那一根正是每
 * 種樣式最容易糊掉的地方。
 */
const THUMB_PATTERN = [
  [0.00, 0.55, 60, 105, 0], [0.60, 0.55, 64, 96, 0],
  [1.20, 0.55, 67, 118, 0], [1.80, 0.55, 64, 92, 0],
  [0.00, 1.10, 55, 74, 1], [1.20, 1.10, 57, 74, 1],
  [0.30, 0.25, 62, 110, 2], [0.90, 0.30, 61, 100, 2], [1.50, 0.25, 69, 112, 2],
];

let thumbView = null;   // wf.layout(1920, 1080)
let thumbNotes = null;  // wf.prepare 的結果
let thumbCrop = null;   // { x, y, w, h }，場景座標
let thumbRaf = 0;

/**
 * 樣本場景。**只建一次**，而且刻意用 16:9：那個比例的 `whiteW` 比 9:16 大一倍，而
 * `pps`（落下速度）小一半 —— 兩件事都讓「一個裁切框裡塞得下幾顆看得清楚的音符」變好。
 * 縮圖不必跟使用者選的比例一致：它要回答的是「這種樣式長什麼樣」，不是「我的影片長什麼樣」。
 *
 * ⚠️ **同一個理由，這裡也不餵 `speedSec()`。** 餵進去的話十二種樣式會在不同速度下長不一樣，
 * 而縮圖存在的意義正是讓它們**互相比較得起來** —— 而且「只建一次」也就不成立了。
 */
function thumbScene() {
  if (thumbView) return;
  thumbView = wf.layout(1920, 1080);

  // 整段複製一份接在後面：不然 `t` 走到週期尾端時，打擊線上方會是空的。
  const notes = [];
  for (const loop of [0, THUMB_LOOP]) {
    for (const [start, dur, midi, vel, track] of THUMB_PATTERN) {
      (notes[track] ??= []).push({ start: start + loop, dur, midi, vel });
    }
  }
  thumbNotes = wf.prepare({ tracks: notes.map(n => ({ notes: n })) });

  // 裁切框由**樣本譜實際用到的鍵**推出來，不是寫死在某個音高上 —— 改了上面那張表，
  // 這裡自己跟著動。
  const used = [...new Set(THUMB_PATTERN.map(p => p[2]))].map(m => thumbView.keyOf.get(m));
  const lo = Math.min(...used.map(k => k.x));
  const hi = Math.max(...used.map(k => k.x + k.w));
  const w = thumbView.whiteW * THUMB_KEYS;
  const h = w * THUMB_H / THUMB_W;
  thumbCrop = {
    w, h,
    // 打擊線放在框高的 78%：上面留給落下的音符，下面留一截琴鍵當地平線。
    y: thumbView.kbTop - h * 0.78,
    x: Math.max(0, Math.min(thumbView.W - w, (lo + hi) / 2 - w / 2)),
  };
}

/**
 * 畫一張縮圖。`setTransform` 把場景座標推到這塊小畫布上，canvas 自己會裁掉框外的東西 ——
 * 所以不必先畫一張大的再縮。`drawBackground` 的滿版 `fillRect` 順便就是清除上一幀。
 */
function drawThumb(cv, t, style, fx) {
  const ctx = cv.getContext("2d");
  const s = cv.width / thumbCrop.w;
  ctx.setTransform(s, 0, 0, s, -thumbCrop.x * s, -thumbCrop.y * s);
  wf.draw(ctx, t, thumbView, thumbNotes, { style, fx, colors });
  ctx.setTransform(1, 0, 0, 1, 0, 0);
}

/**
 * 一排選項。**清單從註冊表長出來，不是寫死的** —— 未來在 `wfstyles.js` 加一種樣式，這裡與
 * markup 都一個字都不用改。
 *
 * `label` 收的是函式而不是一段前綴字串，理由是 i18n 的檢查：`test/i18n.test.mjs` 認得
 * `` i18n.t(`前綴.${x}`) `` 這種寫法並把前綴登記起來，於是那些 key 不會被當成沒人用的孤兒。
 * 前綴如果變成一個變數，那個偵測就失效了。
 */
function buildPicks(host, list, current, label, onPick) {
  host.textContent = "";
  const dpr = Math.min(2, globalThis.devicePixelRatio || 1);
  for (const item of list) {
    const b = document.createElement("button");
    b.type = "button";
    b.className = "pick";
    b.dataset.id = item.id;
    b.setAttribute("role", "radio");

    const cv = document.createElement("canvas");
    cv.width = Math.round(THUMB_W * dpr);
    cv.height = Math.round(THUMB_H * dpr);

    const span = document.createElement("span");
    span.textContent = label(item);

    b.append(cv, span);
    b.addEventListener("click", () => onPick(item.id));
    host.append(b);
  }
  markPicked(host, current);
}

/** 選中的那一顆。`aria-checked` 跟 `.on` 一起動 —— 只動一邊的話螢幕閱讀器講的是舊的。 */
function markPicked(host, id) {
  for (const b of host.children) {
    const on = b.dataset.id === id;
    b.classList.toggle("on", on);
    b.setAttribute("aria-checked", String(on));
  }
}

/**
 * 顏色頁的兩塊：六列軌道，以及點下去展開的 30 格色票。
 *
 * **列數是 `GAME_TRACKS` ＝ 6，色票是 `NOTE_COLORS` 的 30 格** —— 兩個不同的數字。第 7 軌以後
 * 的音符連 `prepare()` 都進不來（`song.tracks.slice(0, GAME_TRACKS)`），給它們顏色是給看不到
 * 的東西上色；而可以挑的是整個調色盤。
 *
 * 每一列不是 `<select>`。原生下拉的 `<option>` **顯示不了顏色** —— 各家瀏覽器對 option 背景
 * 色的支援差很多、深色模式下更糟，於是選色會退化成照著名字盲選。換成按鈕之後，收合時看得到
 * 目前的顏色，展開時 30 色依色相順序由左至右、由上而下一次看完。
 *
 * **不擋兩軌選同一色。** 擋掉的話「想把第 2 軌換成第 5 軌現在的顏色」得先去改第 5 軌，而且
 * 使用者可能是故意的（伴奏全部同色、只讓主旋律突出）。
 */
function buildColors() {
  const host = $("#lookColors");
  host.replaceChildren();
  for (let i = 0; i < GAME_TRACKS; i++) {
    const lab = document.createElement("label");
    lab.htmlFor = `lookColor${i}`;
    lab.textContent = i18n.trackName(i);

    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "pickc";
    btn.id = `lookColor${i}`;
    btn.append(document.createElement("i"), document.createElement("span"));
    btn.firstElementChild.className = "sw";
    btn.addEventListener("click", () => openGrid(i));

    host.append(lab, btn);
  }

  const grid = $("#lookSwatches");
  grid.replaceChildren();
  for (const k of NOTE_COLOR_ORDER) {
    const b = document.createElement("button");
    b.type = "button";
    b.dataset.k = String(k);
    b.setAttribute("role", "radio");

    const sw = document.createElement("i");
    sw.style.setProperty("--c", NOTE_COLORS[k]);
    const nm = document.createElement("span");
    nm.textContent = i18n.t(`waterfall.color.${k}`);
    b.append(sw, nm);

    // **點下去就選定並關掉。** 不做「選了再按確定」—— 結果一眼就看得到（那一列的色塊立刻
    // 變色），多一步確認買不到任何東西。
    b.addEventListener("click", () => {
      if (gridFor < 0) return;
      colorPick[gridFor] = k;
      syncColors();
      persist();
      closeGrid();
    });
    grid.append(b);
  }

  syncColors();
}

/** 把六列的色塊與色名同步到 `colorPick`，順便重算 `colors`（`wf.draw` 每幀要用的那一份）。 */
function syncColors() {
  colors = wf.colorsOf(colorPick);
  for (let i = 0; i < GAME_TRACKS; i++) {
    const btn = $(`#lookColor${i}`);
    const k = colorPick[i];
    btn.firstElementChild.style.setProperty("--c", NOTE_COLORS[k]);
    btn.lastElementChild.textContent = i18n.t(`waterfall.color.${k}`);
  }
}

/**
 * 展開色票格。**整塊換掉六列，不做浮層** —— `#lookBox .card` 是 `overflow-y:auto`，而
 * `overflow` 不是 `visible` 的容器會裁掉溢出的子元素，最後一列的浮層會被卡片下緣切掉一半。
 *
 * 「恢復預設」也一起收起來：它是對六列的操作，在選色的當下沒有意義。
 */
function openGrid(i) {
  gridFor = i;
  $("#lookBack").textContent = `← ${i18n.trackName(i)}`;
  for (const b of $("#lookSwatches").children) {
    const on = +b.dataset.k === colorPick[i];
    b.classList.toggle("on", on);
    b.setAttribute("aria-checked", String(on));
  }
  $("#lookColors").hidden = true;
  $("#lookReset").hidden = true;
  $("#lookGrid").hidden = false;
  $("#lookBack").focus();
}

/** 收起色票格，焦點回到剛才那一列 —— 不還焦點的話鍵盤使用者會被丟回文件開頭。 */
function closeGrid() {
  const back = gridFor;
  gridFor = -1;
  $("#lookGrid").hidden = true;
  $("#lookColors").hidden = false;
  $("#lookReset").hidden = false;
  if (back >= 0) $(`#lookColor${back}`).focus();
}

function thumbFrame() {
  // **顏色頁一幀都不畫。** 那一頁上沒有 canvas —— 六列色塊與六條色帶都是 CSS，改 `--c` 就自己
  // 更新。所以停掉整個迴圈，而不是跑一圈什麼都不做；切回另外兩頁時由 `pumpThumbs` 重新接上。
  if (!$("#lookBox").classList.contains("on") || document.hidden || !THUMB_TABS.includes(tab)) {
    thumbRaf = 0;
    return;
  }
  const t = performance.now() / 1000 % THUMB_LOOP;
  // **樣式那一排一律配「無」，特效那一排配目前選的樣式。** 這個不對稱是故意的，因為兩排在問
  // 不同的問題。
  //
  // 特效那一排問的是「這個特效噴出來長怎樣」，而答案跟音符樣式有關（硬邊的音符配柔邊的特效
  // 會對不上，碎裂就是為了補那個缺口才有的），所以那一排必須配真的樣式。
  //
  // 樣式那一排問的是「這顆音符長怎樣」，而落鍵特效每 2.4 秒在十二張縮圖上**同時**爆一次 ——
  // 十二團一模一樣的東西一起搶視線，正好蓋住最該比的那一段：音符的落點端。所以那一排關掉特
  // 效。**代價是那一排看不到真正的搭配**，但那件事在特效那一排看得到，而且是那一排的主題。
  //
  // 「無」的 `span` 是 0，`drawHits` 因此整層都不進 —— 關掉是零成本，不是畫一個空的東西。
  //
  // **只畫看得見的那一頁。** 這是分頁換來的第二件事（第一件是版面）：十二種樣式加八種特效
  // 全部重畫是每幀二十張，而任何一刻使用者只看得到其中一頁。
  if (tab === STYLE) {
    const none = hitFx("none");
    for (const b of $("#lookStyle").children) drawThumb(b.firstChild, t, noteStyle(b.dataset.id), none);
  } else {
    const style = noteStyle(styleId);
    for (const b of $("#lookFx").children) drawThumb(b.firstChild, t, style, hitFx(b.dataset.id));
  }
  thumbRaf = requestAnimationFrame(thumbFrame);
}

/**
 * 把分頁列與兩塊內容同步到 `tab`。
 *
 * 藏的那一頁走 `hidden` 屬性而不是自訂 class：`editor.css` 已經有 `[hidden]` 的規則，而且
 * 屬性本身帶語意 —— 讀螢幕不必等 CSS 載進來才知道那一頁不在。
 */
function syncTab() {
  for (const b of $("#lookTabs").children) {
    const on = b.dataset.tab === tab;
    b.classList.toggle("on", on);
    b.setAttribute("aria-selected", String(on));
  }
  for (const g of $("#lookBox").querySelectorAll(".tgroup")) g.hidden = g.dataset.tab !== tab;
  if (tab !== COLORS && gridFor >= 0) closeGrid();
  pumpThumbs();
}

/**
 * 需要的話把縮圖的 rAF 接上。**顏色頁不接** —— 見 `thumbFrame` 的註解。
 *
 * 三個地方要起動它（開框、切分頁、從背景切回來），而三個地方各寫一次條件的話，之後多一個
 * 不用畫圖的分頁就會漏掉其中一個 —— 而漏掉的症狀是「有一頁在背景空轉」，看不出來。
 */
function pumpThumbs() {
  if (!thumbRaf && THUMB_TABS.includes(tab) && $("#lookBox").classList.contains("on")) {
    thumbRaf = requestAnimationFrame(thumbFrame);
  }
}

function openLook() {
  if (busy) return;
  thumbScene();
  tab = COLORS;   // 不記憶，見 `tab` 的宣告
  syncTab();
  $("#lookBox").classList.add("on");
  pumpThumbs();
}

function closeLook() {
  if (gridFor >= 0) closeGrid();
  $("#lookBox").classList.remove("on");
  if (thumbRaf) { cancelAnimationFrame(thumbRaf); thumbRaf = 0; }
}

/** 比例、樣式、特效一起存。**「習慣性的記，一次性的不記」**，見 storage 的 `saveWaterfall`。 */
const persist = () =>
  saveWaterfall({
    shape, style: styleId, fx: fxId, colors: colorPick.join(","), speed: speedTier,
  });

/** 起動時把偏好套回來。**一律經過 `noteStyle`/`hitFx` 查一次** —— 那是舊 id 落回預設的地方。 */
function restorePrefs() {
  const pref = loadedWaterfall();
  if (SHAPES[pref.shape]) shape = pref.shape;
  styleId = noteStyle(pref.style).id;
  fxId = hitFx(pref.fx).id;
  // 一律經過 `colorIds` —— 那是壞掉／缺格／舊格式落回原色的地方，跟樣式走 `noteStyle(id)`
  // 同一條規矩。`colors` 在這裡就先算好，因為第一幀可能比 `buildColors()` 早跑。
  colorPick = wf.colorIds(pref.colors);
  colors = wf.colorsOf(colorPick);
  // 環境音走自己那一格（混音框也讀它）。**一律經過 `envPreset`** —— 那是舊 id 落回「無」的
  // 地方，跟樣式走 `noteStyle(id)` 是同一條規矩。音量在 storage 那邊就夾過了。
  const env = loadedEnv();
  envId = envPreset(env.id).id;
  envAmt = env.amount ?? 1;
  // 認不出來的檔位（舊值、手改 localStorage、日後改名）落回 normal，同 `noteStyle` 那條退路。
  speedTier = pref.speed && SPEED[pref.speed] ? pref.speed : "normal";
  for (const el of $("#wfShape").children) {
    const on = el.dataset.shape === shape;
    el.classList.toggle("on", on);
    el.setAttribute("aria-checked", String(on));
  }
  syncSpeed();
}

// ─── 起動 ───────────────────────────────────────────────────────────────────

/** 將分享頁與本機交棒兩個入口正規化成相同的 payload。 */
async function scoreSource() {
  const raw = $("#shareData")?.textContent;
  if (raw) {
    const share = JSON.parse(raw);
    return { payload: share.mml, id: share.id };
  }

  const match = /(?:^|[#&])h=([^&]*)/.exec(location.hash);
  return match ? handoff.take(decodeURIComponent(match[1])) : null;
}

/** 本機交棒失效時收起影片 UI，改顯示可復原的操作指引。 */
function showGone() {
  $("#wfbar").hidden = true;
  $("#wfStageWrap").hidden = true;
  $("#wfFoot").hidden = true;
  $("#wfGone").hidden = false;
}

async function boot() {
  await i18n.use(document.documentElement.lang);

  const page = $("#page");
  page.dataset.origin ||= location.host;

  const src = await scoreSource();
  if (!src) { showGone(); return; }
  shareId = src.id ?? "";
  handoffName = src.name ?? "";
  $("#wfBankNote").hidden = src.builtinBank !== false;

  const parsed = readShare(src.payload);
  song = parsed.song;
  notes = wf.prepare(song);

  // **在 relayout 之前** —— 偏好裡的比例決定畫布的尺寸。
  restorePrefs();
  relayout();
  requestAnimationFrame(frame);

  // 見 Waterfall.cshtml 的「字串的所有權」：這幾塊的字一個都不從 .resx 來。
  $("#wfGo").lastElementChild.textContent = i18n.t("waterfall.export");
  $("#wfCancel").lastElementChild.textContent = i18n.t("waterfall.cancel");
  $("#wfLook").lastElementChild.textContent = i18n.t("waterfall.look");
  $("#wfLook").title = i18n.t("waterfall.look.title");
  $("#wfEnv").lastElementChild.textContent = i18n.t("waterfall.env");
  $("#wfEnv").title = i18n.t("waterfall.env.title");
  $("#wfSeek").setAttribute("aria-label", i18n.t("waterfall.seek"));
  $("#wfShape").setAttribute("aria-label", i18n.t("waterfall.shape"));
  $("#wfSpeed").setAttribute("aria-label", i18n.t("waterfall.speed"));
  for (const b of $("#wfSpeed").children) b.textContent = i18n.t(`waterfall.speed.${b.dataset.speed}`);
  $("#lookTitle").textContent = i18n.t("waterfall.look.title");
  $("#lookTabColors").textContent = i18n.t("waterfall.look.colors");
  $("#lookTabStyle").textContent = i18n.t("waterfall.look.style");
  $("#lookTabFx").textContent = i18n.t("waterfall.look.fx");
  $("#lookStyle").setAttribute("aria-label", i18n.t("waterfall.look.style"));
  $("#lookFx").setAttribute("aria-label", i18n.t("waterfall.look.fx"));
  $("#lookReset").textContent = i18n.t("waterfall.look.reset");
  // 返回鈕看得見的字是「← 軌名」（開的時候才填），但那讀起來是軌名不是「返回」，所以
  // 無障礙名稱另外給。
  $("#lookBack").setAttribute("aria-label", i18n.t("waterfall.look.back"));
  $("#lookDone").textContent = i18n.t("waterfall.look.done");

  // 檔名。**預設值放 placeholder 不放 value** —— 放 value 的話使用者得先全選再刪才打得了
  // 自己的名字，而空著送出本來就會落回同一個字串（見 defaultName）。
  $("#wfName").placeholder = defaultName();
  $("#wfName").setAttribute("aria-label", i18n.t("waterfall.name"));

  $("#wfPlayBtn").addEventListener("click", () => (playing ? pause() : play()));
  $("#wfSeek").addEventListener("input", e => {
    const { start, end } = tl();
    pausedAt = start + (end - start) * +e.target.value;
    if (playing) play(pausedAt);
  });
  for (const el of $("#wfShape").children) {
    el.addEventListener("click", () => {
      shape = el.dataset.shape;
      for (const b of $("#wfShape").children) {
        b.classList.toggle("on", b === el);
        b.setAttribute("aria-checked", String(b === el));
      }
      relayout();
      syncEstimate();
      persist();
    });
  }

  // 落下速度。**要 `relayout()` 而不只是重畫** —— 速度住在 `view.pps` 裡，而 `view` 是
  // `wf.layout` 的產物，不重建的話下一幀畫的還是舊速度。**不必 `syncEstimate()`**：預估是
  // 位元率 × 秒數，而片長跟這個選擇無關（見 `SPEED`）—— 這也是它跟比例那顆的差別。
  for (const b of $("#wfSpeed").children) {
    b.addEventListener("click", () => {
      speedTier = b.dataset.speed;
      syncSpeed();
      relayout();
      persist();
    });
  }
  $("#wfGo").addEventListener("click", exportMp4);
  $("#wfCancel").addEventListener("click", () => busy?.abort());

  // ── 外觀 ──
  buildColors();
  $("#lookBack").addEventListener("click", closeGrid);
  $("#lookReset").addEventListener("click", () => {
    colorPick = wf.colorIds(null);
    syncColors();
    persist();
  });

  buildPicks($("#lookStyle"), NOTE_STYLES, styleId,
    s => i18n.t(`waterfall.style.${s.id}`),
    id => { styleId = id; markPicked($("#lookStyle"), id); persist(); });
  buildPicks($("#lookFx"), HIT_FX, fxId,
    f => i18n.t(`waterfall.fx.${f.id}`),
    id => { fxId = id; markPicked($("#lookFx"), id); persist(); });

  // ── 環境音 ──
  //
  // 下拉而不是縮圖格：這個框選的是聲音，而聲音的「縮圖」就是放出來聽。選下去先讓即時試聽
  // 立刻響（零等待），重算在背後跑 —— 兩者回答的是不同問題，見 `envlive.js` 的檔頭。
  const sel = $("#envPick");
  for (const p of ENV_PRESETS) {
    const o = document.createElement("option");
    o.value = p.id;
    o.textContent = i18n.t(`env.preset.${p.id}`);
    sel.append(o);
  }
  sel.value = envId;
  $("#envTitle").textContent = i18n.t("waterfall.env.title");
  $("#envPickLabel").textContent = i18n.t("waterfall.env.preset");
  $("#envAmtLabel").textContent = i18n.t("waterfall.env.amount");
  $("#envDone").textContent = i18n.t("waterfall.look.done");
  syncEnvAmt();

  sel.addEventListener("change", () => {
    envId = envPreset(sel.value).id;
    persistEnv();
    envlive.audition(envPreset(envId), envAmt).catch(() => envNote(i18n.t("waterfall.env.failed")));
    applyEnv();
  });
  // 滑桿走 `change` 而不是 `input`：`input` 在拖動途中每一格都發，而每一格都重算一次母帶
  // 等於整條拖不動。試聽的音量倒是即時跟著走 —— 那一段是零成本的。
  $("#envAmt").addEventListener("input", () => {
    envAmt = +$("#envAmt").value;
    syncEnvAmt();
    envlive.setAmount(envPreset(envId), envAmt);
  });
  $("#envAmt").addEventListener("change", () => { persistEnv(); applyEnv(); });

  $("#wfEnv").addEventListener("click", openEnv);
  $("#envDone").addEventListener("click", closeEnv);
  $("#envBox").addEventListener("click", e => { if (e.target === $("#envBox")) closeEnv(); });

  for (const b of $("#lookTabs").children) {
    b.addEventListener("click", () => {
      // markup 打錯字就落回音符頁，跟 `noteStyle(id)` 查不到落回第一項是同一個哲學：
      // 這個框壞掉的代價是使用者完全選不了外觀，而那不值得為了抓一個錯字付出。
      const next = TABS.includes(b.dataset.tab) ? b.dataset.tab : COLORS;
      if (next === tab) return;
      tab = next;
      syncTab();
    });
  }

  $("#wfLook").addEventListener("click", openLook);
  $("#lookDone").addEventListener("click", closeLook);
  // 點背景關、Escape 關。跟 ui.js 每個對話框逐字同一招 —— 那邊沒有可以 import 的 helper。
  $("#lookBox").addEventListener("click", e => { if (e.target === $("#lookBox")) closeLook(); });
  addEventListener("keydown", e => {
    if (e.key === "Escape" && $("#envBox").classList.contains("on")) return closeEnv();
    if (e.key !== "Escape" || !$("#lookBox").classList.contains("on")) return;
    // 巢狀的東西一律由內而外關：色票格開著時先關它，不然按一次 Escape 會直接掉出整個對話
    // 框 —— 而使用者只是想放棄選色。
    if (gridFor >= 0) closeGrid();
    else closeLook();
  });
  // 切到背景時把縮圖的 rAF 停掉；回來再接上。rAF 在隱藏的分頁本來就會被節流，但 iOS 上
  // 「回來時一次補跑好幾幀」是真的會發生的，而那一瞬間的 CPU 尖峰沒有任何價值。
  addEventListener("resize", pumpWidth);

  document.addEventListener("visibilitychange", () => {
    if (document.hidden) { if (thumbRaf) { cancelAnimationFrame(thumbRaf); thumbRaf = 0; } }
    else pumpThumbs();
  });

  try {
    await prepareAudio(parsed.programs);
  } catch (err) {
    console.error("[鋼琴瀑布]", err);
    say(i18n.has(`stage.err.${err.code}`) ? i18n.t(`stage.err.${err.code}`)
      : i18n.t("waterfall.err.unknown"));
    return;
  }

  actx = new (window.AudioContext || window.webkitAudioContext)();
  envlive.attach(actx);
  // 兩列同時就位：第一列從「載入中」換成播放，第二列從沒有換成製作。
  $("#wfLoad").hidden = true;
  $("#wfPlay").hidden = false;
  $("#wfMake").hidden = false;
  // **一律走 `applyEnv`，連「無」也是** —— 那條路裡面就是「算響度增益 ＋ makeBuffer」，跟
  // 這個功能不存在時逐字相同。分成兩條的話，會多一個只有選了環境音才走得到的分支。
  await applyEnv();
}

boot();
