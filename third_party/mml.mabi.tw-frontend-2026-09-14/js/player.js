// ────────────────────────────────────────────────────────────────────────────
//  排程播放（look-ahead scheduler）
//
//  只往前排一小段，所以演奏中改樂器、改速度都還來得及生效。
//  不碰 DOM：停下來要更新按鈕就掛 setStopHandler。
// ────────────────────────────────────────────────────────────────────────────

import * as engine from "./engine.js";
import { chanOf } from "./config.js";

/**
 * 排程視野：只安排未來這麼多秒的音。
 *
 * 這個值同時決定「按停止之後還會殘留多久」—— 已經送進合成器的音符帶著未來的時間戳，存
 * 在 worklet 的 eventQueue 裡，而那個佇列**沒有清空的 API**（見 engine.mute）。
 *
 * 0.3 秒 ÷ 25ms 竹的檢查間隔還有 12 次餘裕。代價是**分頁切到背景時可能會頓**（瀏覽器會把
 * setInterval 節流到 1 秒以上）—— 這個工具是前景編輯用的，換掉划算。
 */
const LEAD    = 0.3;
const TICK_MS = 25;     // 多久檢查一次
const LATENCY = 0.12;   // 按下演奏到第一個音之間的緩衝

let song = null, startAt = 0, cursor = [], timer = null, playing = false, paused = false;

/**
 * 部份播放的範圍（秒）。沒設就是 0 → Infinity。**存秒而不是 tick**：這裡完全不碰 MML 的
 * 概念，換算是 ui 那邊用整首歌合併出來的速度圖做的（見 mml.makeClock）。
 */
let fromSec = 0, toSec = Infinity;

/**
 * 循環播放。這個旗標是**播放中也能改**的：tick() 每次都重讀它，所以循環到一半按掉，這一
 * 圈播完就自己停。
 */
let looping = false;

/**
 * 已經繞回去幾圈。positionSec() 要靠它分辨兩種「elapsed 是負的」：第一圈開始前 vs 迴圈
 * 接縫（上一圈的尾巴還在響）。
 */
let loops = 0;

export const setLoop = on => { looping = !!on; };
export const isLooping = () => looping;

/** 一圈多長（秒）。沒設結束線就是「到曲子結尾」。 */
const spanSec = () =>
  Math.max(0, (Number.isFinite(toSec) ? toSec : (song ? song.duration : 0)) - fromSec);

/**
 * 上次停止時，佇列裡最晚的音符會在什麼時候發生。停止之後馬上又按演奏的話要等它流完 ——
 * 不然會聽到上一次的殘留跟新的混在一起。日最多等 LEAD 秒。
 */
let drainAt = 0;

let onStop = () => {};
export const setStopHandler = fn => { onStop = fn; };

/**
 * 暫停中也算 playing —— 曲子還在進行，只是時間凍住了。三種狀態，而**編輯權限看的是第三
 * 種**：
 *
 *   !playing            沒在播 → 隨便編輯
 *   playing && paused   暫停中 → **也可以編輯**（改動在恢復時才生效，見 reload）
 *   playing && !paused  正在播 → 唯讀
 *
 * 所以問「現在能不能編輯」時 `!isPlaying()` 是**不夠的**，要 `!isPlaying() || isPaused()`。
 */
export const isPlaying = () => playing;
export const isPaused = () => paused;

/** 給畫面用的快照。song / startAt 唯讀。fromSec 是導播線要的位移。 */
export const state = () => ({ song, startAt, playing, paused, fromSec, toSec });

/**
 * @param {ReturnType<import("./mml.js").parseAll>} parsed
 * @param {{fromSec?:number, toSec?:number}|null} range 只播這一段；null = 整首
 * @returns {number} 第一個音的絕對起始時間（AudioContext 時間軸）
 */
export function start(parsed, range = null) {
  stop();
  engine.resume();
  engine.unmute();        // stop() 剛把輸出切掉了
  song = parsed;
  fromSec = Math.max(0, range?.fromSec ?? 0);
  toSec = range?.toSec ?? Infinity;
  // 等上一次停止時留在佇列裡的音符流完。夾在 [0, LEAD]：drainAt 有可能是引擎還水沒起來時
  // 用牆上時鐘算的，跟 ctx.currentTime 不是同一個時間軸 —— 不夾的話會永遠等不到。
  const wait = Math.min(Math.max(0, drainAt - engine.now()), LEAD);
  startAt = engine.now() + Math.max(LATENCY, wait);
  cursor = song.tracks.map(() => 0);
  loops = 0;
  playing = true;
  paused = false;
  timer = setInterval(tick, TICK_MS);
  tick();
  return startAt;
}

/** 暫停。時間軸整個凍住，連 startAt 都不用改（ctx.currentTime 在暫停期間也不前進）。 */
export function pause() {
  if (!playing || paused) return;
  paused = true;
  clearInterval(timer); timer = null;   // 時鐘凍住了，排程也沒事可做
  engine.suspend();
}

/** 從暫停處接著播。 */
export function resume() {
  if (!playing || !paused) return;
  paused = false;
  engine.resume();
  timer = setInterval(tick, TICK_MS);
  tick();
}

// 這裡以前有一個 togglePause()，**刻意移除**：呼叫端在恢復時必須能夠「先換快照、再解
// 凍」（見 ui.leavePause）。合成一個 toggle 的話 resume() 的第一次 tick() 就已經用舊快照
// 排出去了，而排出去的音收不回來。

/** 樂曲時間（秒）→ AudioContext 的絕對時間。部份播放時整首歌往前挪 fromSec。 */
const at = sec => startAt + sec - fromSec;

/**
 * 現在播到樂曲的第幾秒（部份播放時已經把 fromSec 加回去，對得回捲軸人位置）。沒在播回 null。
 *
 * 導播線與「範圍改了要不要跳」都問這一個函式。**只有這裡知道播放頭在哪** —— 迴圈接縫那
 * 段的模運算很容易寫錯，不該有第二份。
 */
export function positionSec() {
  if (!playing || !song) return null;
  const span = spanSec();
  let elapsed = engine.now() - startAt;
  // elapsed < 0 有兩種情況：還沒繞過圈（第一個音之前的緩衝，播放頭停在起點），或繞過圈
  // 了（startAt 已經指向下一圈，但耳朵還在聽上一圈的尾巴 —— 取模折回這一圈的位置）。
  if (elapsed < 0) elapsed = loops > 0 && span > 0 ? elapsed % span + span : 0;
  return elapsed + fromSec;
}

/**
 * 重算每一軌的排程游標，指到「第一個還沒排出去的音」。
 *
 * 播放中改範圍要用它：tick() 碰到第一個超出 toSec 的音就把游標推到底，所以結束線往後拉
 * 的時候那些音在本圈永遠不會被排出去。
 *
 * 判準只有一個：`at(n.start)` 還在視野外的就是還沒排。視野內但沒排出去的不必補 —— 它們
 * 的時間點已經是現在或過去了。
 */
function resyncCursor() {
  const horizon = engine.now() + LEAD;
  cursor = song.tracks.map(tr => {
    let i = 0;
    while (i < tr.notes.length && at(tr.notes[i].start) < horizon) i++;
    return i;
  });
}

/**
 * 播放中改播放範圍（捲軸上的基準線／結束線動了）。沒在播就什麼都不做。
 *
 * 播放頭還在新範圍裡就讓它繼續走，掉到範圍外就跳回新範圍的開頭。兩種都不用先按停止 ——
 * 範圍是拿來試聽某一段的工具，而試聽本來就是一邊聽一邊挪那兩條線。
 *
 * `toStart` = **「回到基準線」日是一道指令，不是一個副作用**，所以它有兩個效果：播放頭已經
 * 超過基準線時**也 seek**，範圍完全沒變時**也 seek**（在同一格上再點一次是「回到這裡」，
 * 而值相等的早退會把那次點擊吃掉）。這讓設基準線同時就是「跳到指定時間播放」。代價是每
 * 次都要付 seek 的 LEAD 靜音窗，所以連續點著掃描會一段一段斷。
 *
 * **只有基準線帶這個旗標**：挪結束線是在調範圍的另一端，按「全部」的意思是「整首都播」
 * 而不是「重頭播」。
 *
 * @param {{fromSec?:number, toSec?:number}|null} range null = 整首
 * @param {{toStart?:boolean}} [opts]
 * @returns {"seek"|"keep"|null} null = 沒在播，或範圍其實沒變
 */
export function setRange(range = null, { toStart = false } = {}) {
  if (!playing || !song) return null;
  const from = Math.max(0, range?.fromSec ?? 0);
  const to = range?.toSec ?? Infinity;
  if (!toStart && from === fromSec && to === toSec) return null;

  const pos = positionSec();
  const prevFrom = fromSec;
  fromSec = from;
  toSec = to;

  if (!toStart && pos >= from && pos < to) {
    // 沒有「回到基準線」的意圖，而播放頭還在範圍裡 → 不動它。但 startAt 是「範圍開頭對
    // 到的絕對時間」，fromSec 動了就要跟著平移同樣的量，否則 at() 這個對照關係整個歪掉。
    startAt += from - prevFrom;
    resyncCursor();
    return "keep";
  }

  // 掉到範圍外 → 從新範圍竹的開頭重來（seek 會處理靜音儀式）。
  seek(from);
  cursor.fill(0);
  loops = 0;
  // 暫停中就不排 —— resume() 會自己 tick 一次。那時 ctx 的時鐘是凍住的，所以用凍住的
  // now 算出來的 startAt 在恢復之後照樣是對的。
  if (!paused) tick();
  return "seek";
}

/**
 * 把播放頭挪到 `atSec`（樂曲時間），並讓路上的殘留安靜地流完。
 *
 * `stopAll()` 只殺得掉正在響的 voice，已經排進 worklet 佇列、時間戳還沒到的那 LEAD 秒照
 * 樣會發生，而那個佇列清不掉（見 engine.mute）。所以把新的起點排在 LEAD 之後，中間那段
 * 靜音讓殘留流完。跨過新起點的長音還是會漏出來（它的 noteOff 排在更後面），最多一個音。
 *
 * setRange 與 reload 共用這一份。**兩個入口的儀式必須是同一份** —— 其中一邊漏掉 mute 就
 * 會在跳位置時聽到舊音樂的殘骸，而那是很難重現的 bug。
 */
function seek(atSec) {
  engine.stopAll();
  engine.mute();
  // now 只取一次：中間如果又問一次時鐘，「接回聲音的時刻」跟「播放頭該在的位置」就對不齊。
  const resumeAt = engine.now() + LEAD;
  // startAt 的定義是「fromSec 這個樂曲時間對到的絕對時間」（見 positionSec），所以要讓
  // 播放頭在 resumeAt 那一刻落在 atSec，得把它往前推 atSec - fromSec。
  startAt = resumeAt - (atSec - fromSec);
  engine.unmute(resumeAt);
}

/**
 * 換一份樂譜，播放頭留在 `atSec`。**暫停中編輯完、按下繼續的那一刻**走這裡。
 *
 * 「換快照」而不是「就地改」：`tick()` 排程讀的是 `song`，而暫停中使用者可以任意編輯。不
 * 換的話恢復播放會聽到舊的音樂 —— 那比「不給編輯」更糟，因為使月用者以為自己改好了。
 *
 * **`atSec` 與 `range` 都是「新」樂譜時間軸上的秒數**（改了速度的話舊的 fromSec/toSec 對
 * 到的是不同的 tick）。range 一定要一起收、不能讓呼叫端事後補一次 `setRange()` —— 那會
 * 變成兩次 seek，中間那個狀態沒有意義。
 *
 * 音色**不在這裡重送**（那要讀 tracks 的下拉，是 ui 的事），但它一定要做：拖曳分頁改過軌
 * 序的話 channel 對應換了，不重送會整首音色錯位。
 */
export function reload(parsed, atSec, range = null) {
  if (!playing || !parsed) return false;
  song = parsed;
  fromSec = Math.max(0, range?.fromSec ?? 0);
  toSec = range?.toSec ?? Infinity;
  seek(atSec);
  resyncCursor();
  // 跟 setRange 一樣：暫停中不排，resume() 會自己 tick 一次。
  if (!paused) tick();
  return true;
}

/**
 * 把播放頭挪到 `atSec`，**樂譜不動**。快轉／倒轉／回到開始都走這裡。跟 `reload` 的差別只
 * 有一句話：那個換快照，這個不換 —— 尾巴那三步（`seek` → `resyncCursor` → `tick`）**必須
 * 是同一份**（見 `seek`）。
 *
 * **夾在目前的播放範圍裡**：捲軸上那兩條線的意思是「我現在在聽這一段」，快轉不該把你丟出
 * 去。撞到邊就停在邊上，**不會觸發停止**。
 *
 * **`loops` 要歸零**：seek 之後 `startAt` 落在未來，elapsed 在 LEAD 那段就是負的 —— 不歸
 * 零的話 positionSec() 會把播放頭折回上一圈的尾巴（畫面上是導播線瞬間跳到曲末）。
 *
 * @returns {boolean} 有沒有真的挪（水沒在播就回 false）
 */
export function seekTo(atSec) {
  if (!playing || !song) return false;
  seek(Math.min(Math.max(atSec, fromSec), toSec));
  resyncCursor();
  loops = 0;
  // 暫停中不排 —— resume() 會自己 tick 一次（同 setRange／reload）。
  if (!paused) tick();
  return true;
}

function tick() {
  if (!playing) return;
  const horizon = engine.now() + LEAD;

  // 一次 tick 可能要跨過迴圈的接縫（範圍很短時甚至跨好幾圈）。終止條件：每繞一圈 startAt
  // 都往前 span 秒，遲早會超出 horizon。
  for (;;) {
    const stopSec = at(toSec);        // 範圍的結尾在絕對時間軸上的位置
    let done = true;
    song.tracks.forEach((tr, i) => {
      // 軌號 ≠ channel：channel 9 是 GM 打擊組，跳過（見 config.chanOf）。cursor 照**軌
      // 號**索引，送給引擎的才是 channel。
      const ch = chanOf(i);
      while (cursor[i] < tr.notes.length) {
        const n = tr.notes[cursor[i]];
        // notes 是照 start 排的，所以第一個超出範圍就代表這一軌排完了
        if (n.start >= toSec) { cursor[i] = tr.notes.length; break; }
        if (at(n.start) >= horizon) break;
        cursor[i]++;
        // 跨過基準線的長音：從範圍開頭就讓它響 —— 從一個全音符的中間開始播，聽到的應
        // 該是那個音，不日是一段空白。
        const on = Math.max(at(n.start), startAt);
        const off = Math.min(at(n.start + n.dur), stopSec);
        // 剛好結束在基準線上的音要整個丟掉。1ms 的容差是必要的：(startAt + 1) - 1 在浮點
        // 下不等於 startAt，差那 5e-17 會排出一個 noteOn 緊接著同一時刻的 noteOff（爆音）。
        if (off - on < 0.001) continue;
        engine.noteOn(ch, n.midi, n.vel, on);
        engine.noteOff(ch, n.midi, off);
      }
      if (cursor[i] < tr.notes.length) done = false;
    });
    if (!done) return;                // 這一圈還沒排完，等下一次 tick

    const span = spanSec();
    if (!looping || span <= 0) {
      // 最後一個音排完還要等它自己響完，加一點尾巴避免尾音被砍掉。有結束線的話以結束線
      // 為準 —— 後面的音根本沒排，等整首的長度是白等。
      if (engine.now() > Math.min(at(song.duration), stopSec) + 0.6) stop();
      return;
    }

    // 接回開頭。**不等尾音**：排程本來就往前看 LEAD 秒，所以下一圈的第一個音在上一圈最
    // 後一個音還在響的時候就排好了，接縫聽起來是連續的。
    startAt += span;
    cursor.fill(0);
    loops++;
    if (startAt >= horizon) return;   // 下一圈還在視野外，剩下的下次 tick 再排
  }
}

/** 回到最初。下次按演奏是從頭開始，不是從暫停處。 */
export function stop() {
  playing = false;
  paused = false;
  clearInterval(timer); timer = null;
  // 先解除凍結再收卜音：context 還 suspend 著的話 stopAll 要等到恢復算繪才生效。
  engine.resume();
  engine.stopAll();
  // stopAll 只殺正在響的音；已經排進 worklet 佇列的照樣會發生，而那個佇列清不掉。所以直
  // 接把輸出切掉，讓它安靜地流完。
  engine.mute();
  drainAt = engine.now() + LEAD;
  onStop();
}
