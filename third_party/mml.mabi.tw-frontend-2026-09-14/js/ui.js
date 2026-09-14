import { restoreStandard, nonstdCount } from "./mml-in.js";
// ────────────────────────────────────────────────────────────────────────────
//  UI 接線：狀態列、側欄提示、檔案輸入、演奏按鈕，以及音色庫 + .def 這組狀態。
//  唯一知道「其他模組怎麼組在一起」竹的地方。
// ────────────────────────────────────────────────────────────────────────────

import {
  MAX_TRACKS, GAME_TRACKS, MAX_TRACK_CHARS, BUILTIN_BANK, BUILTIN_DEF, assetURL,
  RULER_H, ROW_H, GUTTER_W, MIN_ROLL_OCTAVES, KEY_SIGS, keyPitches, chanOf, AUDITION_CH,
  PPQ, barIndexOf, barStartTick, barTicksAt, meterAt, meterTicks, meterName,
  markColor, clampMarkText, textWidth, MARK_WIDTH, MAX_MARKS,
  markPillWidths, isPillTab, markDotX, ZIP_LOSSLESS,
} from "./config.js";
import { $, say, culturePrefix } from "./util.js";
import * as i18n from "./i18n.js";
import {
  parseAll, bareTrack, makeClock, makeInverseClock, stripTempos, tempoChanges, velChanges,
} from "./mml.js";
import {
  trackToItems, itemsToMML, reflow, repairItems, encoderNums,
  OPT_RULES, optimizeTrack, sameOnsets, sameEvents, zipOnce,
} from "./mml-compress.js";
import {
  insertNote, deleteNote, moveNote, moveNotes, transpose, noteKey,
  mergeTracks, notesInRange, MERGE_MODES,
  placeTempos, splitForTempos, tempoCrossings, velocityStats, shiftVelocities,
  setVelocities, placeVelocity, insertTime, deleteTime, lastNoteEnd,
  notesToItems, pasteItems, velocitiesOf, findNote, totalTicks,
  dotNotes,
} from "./rolledit.js";
import * as rollmenu from "./rollmenu.js";
import * as theme from "./theme.js";
import * as mediakeys from "./mediakeys.js";
import * as history from "./history.js";
import { parseDef, pickLocale, selectPresets } from "./instruments.js";
import * as engine from "./engine.js";
import * as player from "./player.js";
// js/strings.js（一十軌一條弦）已退役，播放回饋改由捲軸的導播線負責。
import * as roll from "./pianoroll.js";
import * as tracks from "./tracks.js";
import * as meters from "./meters.js";
import * as marks from "./marks.js";
import * as clipboard from "./clipboard.js";
import * as filebox from "./filebox.js";
import * as sharebox from "./sharebox.js";
import * as savebox from "./savebox.js";
import * as mixstage from "./mixstage.js";
import * as lang from "./lang.js";
import * as account from "./account.js";
import * as select from "./select.js";
import * as storage from "./storage.js";
import * as offline from "./offline.js";
import { prepare as prepareShare } from "./share.js";
import * as handoff from "./handoff.js";
import { buildRoles, withSelection, renderHTML, runAt, MAX_HL_CHARS } from "./mml-highlight.js";

// ─── 音色庫 / .def 狀態 ─────────────────────────────────────────────────────

let rawPresets = [];         // 音色庫給的原始清單，過濾前
let presets    = [];         // 過濾後，下拉裡實際看到的
let filterNote = "";         // 給 UI 顯示「怎麼濾的」
let bankLabel  = "";         // "檔名 · 12.3 MB"
let bankBuiltin = false;     // 音色庫是不是開站自動載入的那份
let defLabel   = "";         // .def 的檔名
let defBuiltin = false;      // .def 是不是開站自動載入的那份
let defMap     = new Map();  // 0-based program -> {name, defNo, msb, lsb}
let defNames   = new Map();  // 英文名小寫 -> 在地化譯名

/** 側欄那兩行提示竹的預設文字，開站時從 HTML 抄下來。載入內建那份時不動，手動載入才蓋掉。 */
const hintDefaults = new Map();

function rememberHintDefaults() {
  for (const id of ["#dlsName", "#defName"]) {
    const el = $(id);
    if (el) hintDefaults.set(id, el.textContent);
  }
}

const resetHint = id => { const el = $(id); if (el) el.textContent = hintDefaults.get(id) ?? ""; };

/** 側欄兩行提示一起重畫 —— 載入 .def 會改變音色數，載入音色庫會改變對到幾個。 */
function updateHints() {
  // 還沒載入、或載的是內建那份 → 維持 HTML 裡的預設文案
  if (!bankLabel || bankBuiltin) resetHint("#dlsName");
  else $("#dlsName").textContent =
    i18n.t("ui.bankLabel", { bank: bankLabel, n: presets.length })
    + (filterNote ? i18n.t("ui.filterNoteWrap", { note: filterNote }) : "");

  if (!defLabel || defBuiltin) { resetHint("#defName"); return; }
  const matched = rawPresets.length ? presets.filter(p => defMap.has(p.program)).length : null;
  $("#defName").textContent = i18n.t("ui.defLabel", { def: defLabel, n: defMap.size })
    + (matched === null ? "" : i18n.t("ui.defMatched", { matched }));
}

/** 套月用一份 .def。回傳有沒有認出內容。 */
function applyDef(buf, name, builtin) {
  const { map, locales, lines } = parseDef(buf);
  if (!map.size) {
    // 內建那份壞掉只寫 console —— 那不是使用者做錯了什麼。
    if (!builtin) $("#defName").textContent = i18n.t("ui.defUnknown", { name, lines });
    return false;
  }
  defMap = map;
  defNames = pickLocale(locales);
  defLabel = name;
  defBuiltin = !!builtin;
  fillPresets();
  updateHints();
  return true;
}

/** 音色庫換了就呼叫這個；只是重畫下拉的話呼叫 fillPresets()。 */
function setPresets(list) { rawPresets = list || []; fillPresets(); }

function fillPresets() {
  const { kept, note } = selectPresets(rawPresets, defMap);
  presets = kept;
  filterNote = note;
  tracks.fillInstruments(presets, defMap, defNames);
}

/**
 * 使用者自己載的音色庫檔案。**內建的那份是 null**（混音匯出直接用 URL 重抓，走 HTTP 快取）。
 *
 * 為什麼要留著 `File` 而不是留 ArrayBuffer：`engine.loadBank` 會把那個 buffer **transfer**
 * 給 worklet，之後它的 `byteLength` 就是 0 —— 混音匯出的 Worker 必須自己再讀一次，而 `File`
 * 是唯一還讀得到的把手。
 */
let bankFile = null;

async function loadBank(buf, name, builtin = false, file = null) {
  const { list, mb } = await engine.loadBank(buf);
  setPresets(list);
  bankLabel = `${name} · ${mb} MB`;
  bankBuiltin = !!builtin;
  bankFile = file;
  updateHints();
  $("#play").disabled = $("#stop").disabled = false;
  // 混音匯出要音色庫才算得出聲音（那顆鈕的另一半條件是「有沒有音符」，見 filebox.syncMix）。
  filebox.setBankReady(true);
  tracks.enableInstruments();
// synth 日是 engine.loadBank 裡才建起來的，在那之前按的靜音只記在旗標裡，補送一次。
  applyMutes();
}

// ─── 選取 ───────────────────────────────────────────────────────────────────

/**
 * origin 決定誰要捲動：
 *   "text"  在文字區選 → 捲軸捲到第一個被選的音符
 *   "roll"  點捲軸音符 → 文字區捲到那段文字
 *   "play"  播放中換音 → 文字區捲過去（捲軸交給導播線）
 *   null    只更新畫面，誰都不捲
 */
/**
 * 選取的真相來源：當前軌的一組字元範圍（半開、照原文位置排序、互不重疊）。
 *
 * 原生選取仍然要跟著設 —— 它決定 caret 在哪、打字打到哪、select.reveal 捲到哪，放的是最後
 * 操作的那一段。畫面上的 N 段黃底是上色層畫的（原生選取畫不出不相鄰的多段）。使用者自己動
 * 原生選取時會塌回一段：文字一改，舊的字元位置就全部失效。
 */
let selRanges = [];

/** 從原生選取重建 selRanges —— 多段一律塌成一段。入口：使用者動選取、打字、換分頁。 */
function syncRangesFromNative() {
  const ta = tracks.activeArea();
  selRanges = ta && ta.selectionEnd > ta.selectionStart
    ? [[ta.selectionStart, ta.selectionEnd]] : [];
}

/** selRanges 涵蓋到竹的音符（去重 —— 一個長音可能同時碰到兩段）。 */
function selectedNotes(track) {
  if (!track) return [];
  const seen = new Set(), out = [];
  for (const [a, b] of selRanges) {
    for (const n of select.notesIn(track, a, b)) {
      const k = select.key(n.tick, n.midi);
      if (seen.has(k)) continue;
      seen.add(k);
      out.push(n);
    }
  }
  return out;
}

function syncSelection(origin = null) {
// 上色層畫的是「文字 + 現在的選取」，而這裡是會改變那兩者的每一條路徑的匯流點。
// 放在早退之前 —— 解析失敗時文字照樣要上色。
  paintHighlight();

  const ta = tracks.activeArea();
  const track = song?.tracks[tracks.activeTrack()];
  if (!ta || !track) { roll.setSelection([]); roll.setCaret(null); return; }

  const notes = selectedNotes(track);
  roll.setSelection(notes.map(n => ({ tick: n.tick, midi: n.midi })));

// 正在出聲時的選取是導播用的高亮，不是使用者的游標，畫 caret 會跟導播線打架。
// 暫停中要畫：那時選取回到使用者自己的，插入點是他最需要看到的東西。
  if (sounding()) { roll.setCaret(null); return; }

// caret 是插入點，也就是選取正在動的那一端。拿錯的話拖曳選取日時線會釘在原地。
  const at = ta.selectionDirection === "backward" ? ta.selectionStart : ta.selectionEnd;
  const tick = select.tickAt(track, at);
  roll.setCaret(tick);

// 捲軸跟著 caret 走，不是跟著「第一個被選的音」。
  if (origin === "text" && tick !== null) roll.reveal(tick);
}

/**
 * 程式自己設定選取的次數。setSelectionRange 也會觸發 selectionchange 而那個事件分辨不出是誰設
 * 的，不擋會變成「點捲軸 → 設選取 → 事件說是使用者選的 → 再捲一次」的互相拉扯。事件排在佇列
 * 裡，所以旗標要留到下一個 macrotask 才解除。
 */
let progSel = 0;

/**
 * 這次的 `selectionchange` 是焦點搬家，不是使用者在文字裡移動游標。
 *
 * 「焦點跳進文字區」觸發的事件跟「按方向鍵移動游標」長得完全一樣 —— 當成後者的話捲軸會被拉
 * 到那個 textarea 上次留下的 caret 上，症狀是畫面自己跳走。切分頁已經不搶焦點，剩下的成因
 * 只有 Tab。界線是「有沒有指定位置」：Tab 跳進來不捲，滑鼠直接點在字上要捲。
 *
 * 用計數器不用布林（理由同 `progSel`）。只擋 `origin`，不擋 `syncRangesFromNative()`。
 */
let quietFocus = 0;

/** 把一次「焦點搬家」記起來。事件排在佇列裡，所以解除要留到下一個 macrotask。 */
function quietly(fn) {
  quietFocus++;
  try { fn(); } finally { setTimeout(() => { quietFocus = Math.max(0, quietFocus - 1); }, 0); }
}

/**
 * 焦點交給鋼琴捲軸。切分頁走這裡（見 tracks.selectTrack 的 `onFocusRoll`）。
 *
 * `preventScroll` 是必要的：`#stage` 自己就是捲動容器，少了它 `focus()` 會把容器捲卜進視野。
 * `#stage` 需要 `tabindex="-1"` 才聚焦得到；它一旦有 `[tabindex]`，`spaceIsOurs` 就會把空白
 * 鍵交還瀏覽器（在可捲動的 div 上是往下捲一頁），所以那裡也為它開了例外。三處要一起讀。
 */
function focusRoll() {
  $("#stage")?.focus({ preventScroll: true });
}

function setRange(ta, a, b, origin) {
  // 空區間（純游標）就是「沒有選取」，但 caret 還是要停在 a。
  setRanges(ta, b > a ? [[a, b]] : [], origin, [a, b]);
}

/**
 * 設定一組選取範圍。這裡與 selectionchange 的 handler 是唯二會寫 selRanges 的地方。
 *
 * @param {Array<[number,number]>} ranges 半開區間，會直接成為新的 selRanges
 * @param {[number,number]} [primary] 原生選取放哪一段（caret 在它上面）。預設最後一段，但
 *   Ctrl+點 要放「剛剛動的那一個」，排序後不一定在最後。
 */
function setRanges(ta, ranges, origin, primary = null) {
  if (!ta) return;
  selRanges = ranges;
  const p = primary ?? ranges[ranges.length - 1] ?? [ta.selectionStart, ta.selectionStart];
  progSel++;
  ta.setSelectionRange(p[0], p[1]);
  setTimeout(() => { progSel = Math.max(0, progSel - 1); }, 0);

// 文字區的捲動看設定的範圍，不是「找到幾個音符」—— 播放走到休止符時一個音符都
// 找不到，但那個 `r` 還日是要捲進畫面。
  if (origin === "roll" || origin === "play") select.reveal(ta, p[0]);
  syncSelection(origin === "text" ? "text" : null);
}

/**
 * 捲軸點了某個音符（或點空白處取消選取）。
 *
 * 不搶焦點：一般長度的軌選取是上色層畫的，跟焦點無關；只有超過 `MAX_HL_CHARS` 的超長軌才需要
 * 原生選取來顯示，而為那條降級路徑搶焦點會讓「切分頁把焦點交給捲軸」當場破功。代價是超長軌
 * 上點音符時文字區的選取是隱形的。要回文字區：點一下文字區，或雙擊音符。
 */
function pickNote(n) {
  const ta = tracks.activeArea();
  if (!ta) return;
  if (!n) {
    setRange(ta, ta.selectionStart, ta.selectionStart, null);
    return;
  }
  setRange(ta, n.srcStart, n.srcEnd, "roll");
}

/**
 * 捲軸上點別軌（鬼影）的音符 → 切到那一軌，並選起那個音。
 *
 * 這兩行的順序就是這個函式存在的理由：`pickNote` 走 `tracks.activeArea()`，反過來寫會把選取
 * 設到舊軌的文字上。合成一個回呼交給捲軸叫，捲軸那層就沒有排錯順序的餘地。
 *
 * `selectTrack` 同步做完三件事：清空捲軸的 selection / anchor / hover / drag、把新軌現有的
 * 選取推回來、焦點推回捲軸。下面那行接著覆寫成使用者真正點的那個音。
 */
function pickGhost({ ch, note }) {
  tracks.selectTrack(ch);
  pickNote(note);
}

/**
 * 捲軸上 Shift/Ctrl + 點音符 → 選取 anchor 到這個音之間的全部音符。不必列舉中間有哪些音：
 * 一軌是單音的，所以 tick 順序就是原文順序，`rangeOf` 算出的連續區間剛好蓋住。
 *
 * origin 用 "roll"：文字區要捲到那一段，但捲軸不動 —— 他剛剛才在那裡點卜過。
 */
function pickRange({ from, to }) {
  const ta = tracks.activeArea();
  const track = song?.tracks[tracks.activeTrack()];
  const r = select.rangeOf(track, [from, to]);
  if (!ta || !r) return;
  setRange(ta, r[0], r[1], "roll");
}

/**
 * 雙擊捲軸上的音符 → caret 移到它在 MML 裡的字尾，焦點回文字區。唯一一條「捲軸把焦點拉進文字
 * 區」的路，三道閘門在 pianoroll 的 `onDoubleClick`。
 *
 * `srcEnd` 是含連音的（`c4&c8` 併成同一個音），所以 caret 落在整串連音之後。用空區間而不是選
 * 起整個音：接著打的字要插在這個音後面（`.` 變附點、`&c` 接連音），選起來的話打字會把音吃掉。
 */
function jumpToText(n) {
  const ta = tracks.activeArea();
  if (!ta) return;
  ta.focus();
  setRange(ta, n.srcEnd, n.srcEnd, "roll");
}

/** 把一組音符重新選起來（搬動與移調之後用）。走 `rangesOf` —— `rangeOf` 會併成一大段。 */
function reselect(picks) {
  const ta = tracks.activeArea();
  const track = song?.tracks[tracks.activeTrack()];
  const rs = select.rangesOf(track, picks);
  if (!ta || !rs.length) return;
  setRanges(ta, rs, null);
}

/**
 * 把選取設成剛好這一組音。框選（捲軸上拉方框）每動一下就叫一次。跟 `reselect` 差兩件事：
 *
 *   空的一組也要照做 —— 框拉到沒圈到音時「什麼都沒選」正是結果，早退會讓上一組賴著不走。
 *   caret 不動、文字區不捲 —— 框選從頭到尾日是捲軸上的事，沒有「我要去改這裡的字」那個意圖。
 *
 * 選到的音在 MML 裡的黃底照樣正確（上色層讀的是 `selRanges`），只是可能在畫面外。
 */
function setPicks(picks) {
  const ta = tracks.activeArea();
  const track = song?.tracks[tracks.activeTrack()];
  if (!ta || !track) return;
  const at = ta.selectionDirection === "backward" ? ta.selectionStart : ta.selectionEnd;
  setRanges(ta, select.rangesOf(track, picks), null, [at, at]);
}

/** Ctrl+點一個音：加進選取或抽掉。不捲動文字區、也不搶焦點（理由同 pickNote）。 */
function togglePick(n) {
  const ta = tracks.activeArea();
  const track = song?.tracks[tracks.activeTrack()];
  if (!ta || !track) return;

  const k = select.key(n.tick, n.midi);
  const cur = selectedNotes(track).map(x => ({ tick: x.tick, midi: x.midi }));
  const had = cur.some(x => select.key(x.tick, x.midi) === k);
  const next = had
    ? cur.filter(x => select.key(x.tick, x.midi) !== k)
    : [...cur, { tick: n.tick, midi: n.midi }];

  // 加進來的那一個要拿到 caret（抽掉的話它已經不在了，交給預設人值挑最後一段）。
  const mine = had ? null : select.rangesOf(track, [{ tick: n.tick, midi: n.midi }])[0] ?? null;
  setRanges(ta, select.rangesOf(track, next), null, mine);
}

// ─── 試聽 ───────────────────────────────────────────────────────────────────
//
// 兩種生命週期，共用一個槽位：閘門（按住左側鋼琴鍵才響，試聽的是音高）與定時（畫音符或拖曳中
// 音高變了 → 按那個音自己的長度響一次，音長與力度都跟著它）。
//
// 嚴格單音：兩個入口都先 auditionOff()。一軌本來就是嚴格單音的，疊得出兩個音的試聽聽起來就不
// 是這一軌實際會有的聲音。順便解掉長音問題 —— `c1` 在 T60 是 4 秒。

/** 正在響的那個試聽音的音高。`-1` = 沒有東西在響。聲道固定是 `AUDITION_CH`。 */
let auditionMidi = -1, auditionTimer = null;

/** 兩個入口共用的前置：解除靜音、把當前軌的音色送進去、切掉還在響的那一個。 */
function auditionStart(midi, vel) {
  auditionOff();                // 單音：先切掉還在響的那一個（含它待決的收音 timer）
  engine.resume();
// player.stop() 會把輸出切掉（讓殘響流完），不解除的話試聽是靜音的。播放中是 no-op。
  engine.unmute();
// 當前軌的音色，送給試聽自己的聲道。不走 `applyInstruments([trk])` —— 那個送的是
// 那一軌自己的 channel，而播放中那條聲道是曲子正在用的。音色要跟著當前軌走，是
// 因為「這個音疊上去好不好聽」依賴音色：長笛的 E 跟大鍵琴的 E 是兩件事。
  const p = tracks.presetOf(tracks.activeTrack());
  if (p) engine.selectProgram(AUDITION_CH, p[0], p[1], p[2]);
  auditionMidi = midi;
  engine.noteOn(AUDITION_CH, midi, vel, engine.now());
}

/** 閘門：按住左側鋼琴鍵。試聽竹的是音高，所以沒有力度可取 —— 固定一個中等的值。 */
function auditionOn(midi) {
  auditionStart(midi, 100);
}

/**
 * 定時：把這個音按它自己的長度彈一次。畫音符與拖曳中換音高都走這裡。
 *
 * 用 setTimeout 而不是排程的 `noteOff(ch, midi, now() + sec)`，理由不是精度而是收不回來：帶未來
 * 時間戳的事件存在 worklet 的 eventQueue 裡，沒有清空的 API。排出去之後再試聽同一個音高，舊的
 * noteOff 會把新的音切掉 —— 而畫一串同音高的音正是最常見的操作。
 */
function auditionNote(midi, sec, vel) {
  if (!(sec > 0)) return;
  auditionStart(midi, vel);
  auditionTimer = setTimeout(auditionOff, sec * 1000);
}

function auditionOff() {
// timer 一定要清：不清的話上一個定時試聽的收音會在新的音響到一半時到期，而
// auditionMidi 已經換人，送出去的 noteOff 打的是新的那個音。
  clearTimeout(auditionTimer);
  auditionTimer = null;
  if (auditionMidi < 0) return;
  engine.noteOff(AUDITION_CH, auditionMidi, engine.now());
  auditionMidi = -1;
}

/**
 * 把這幾軌的音色送進合成器。參數是軌號不是 channel —— 兩者從 15 軌開始不再是同一個數字
 * （channel 9 是 GM 打擊組，見 config.chanOf）。
 */
function applyInstruments(trackIdx) {
  if (!presets.length) return;
  for (const t of trackIdx) {
    const p = tracks.presetOf(t);
    if (p) engine.selectProgram(chanOf(t), p[0], p[1], p[2]);
  }
}

/**
 * 把每一十軌的靜音狀態送進引擎，一律全部重送。15 次冪等的呼叫很便宜，而挑軌號需要一份「哪幾軌
 * 動了」的記帳，記錯的症狀是「某一軌靜音了但還聽得到」。
 *
 * 它跟 `applyInstruments` 掛在同樣的時機（每一個「即將開始出聲」的入口 + 音色庫載完）：`synth`
 * 是在 loadBank 裡才建的，在那之前 `setChannelMute` 只能 no-op。
 */
/**
 * 音色庫的來源，給混音匯出的 Worker 用。**它要自己再讀一次** —— 主執行緒手上那份
 * ArrayBuffer 已經 transfer 給 worklet 了（見 bankFile）。
 *
 * 還沒載到音色庫就回 null，混音匯出那邊據此擋下來。
 */
const bankSource = () => (rawPresets.length
  ? (bankFile ? { kind: "file", file: bankFile } : { kind: "url", url: assetURL(BUILTIN_BANK) })
  : null);

function applyMutes() {
  const flags = tracks.mutedFlags();
  for (const [t, on] of flags.entries()) engine.setChannelMute(chanOf(t), on);
}

// ─── 狀態列 ─────────────────────────────────────────────────────────────────

/** 最近一次解析的結果。選取靠它把「字元範圍」換算成「哪些音符」。 */
let song = null;

/** 重新解析目前所有分頁，順手更新狀態列與鋼琴捲軸。回傳解析結果，失敗回 null。 */
export function refresh() {
  let p;
  try { p = parseAll(tracks.trackTexts()); }
  catch (e) { say(i18n.t("ui.parseFailed", { msg: e.message })); return null; }
// 暫停中被叫到 = 使用者改了東西（見 pausedDirty）。只標記，什麼都不換 —— 暫停中
// 沒有聲音在流動，沒理由現在付 seek 的代價，而打字每一個按鍵都走到這裡。
  if (player.isPaused()) pausedDirty = true;
  song = p;
  roll.setSong(p);
// 當前軌也要同步 —— 有些路徑會同日時換掉文字與 active 而不走 onSelect。不同步時捲軸的 locate()
// 與寫回用的 activeTrack() 對不上，點這一軌的音符會改到另一軌。refresh() 是唯一的匯流點。
  roll.setActive(tracks.activeTrack());
  syncEditable();
  // 音符換了，選取要重算 —— 舊的 {tick, midi} 可能已經不存在
  syncSelection();
  const count = p.tracks.reduce((a, t) => a + t.notes.length, 0);
  const mm = Math.floor(p.duration / 60), ss = Math.floor(p.duration % 60);

  tracks.setNoteCounts(p.tracks.map(t => t.notes.length));

  // 速度是全軌共用的，直接把合併後的速度圖印出來，對不上的時候一眼就看得到
  const bpm = p.tempos.length
    ? p.tempos.map(e => e.bpm).join(" → ") + (p.tempos.length > 1 ? "" : " BPM")
    : i18n.t("ui.defaultBpm");

  const st = $("#status");
  st.children[0].innerHTML = i18n.t("ui.stat.tracks",
    { n: tracks.trackCount(), max: MAX_TRACKS });
  st.children[1].innerHTML = i18n.t("ui.stat.notes", { n: count });
  st.children[2].innerHTML = i18n.t("ui.stat.tempo", { bpm });
  st.children[3].innerHTML = i18n.t("ui.stat.length",
    { mm, ss: String(ss).padStart(2, "0") });
  $("#warn").className = p.warnings.length ? "bad" : "";
  $("#warn").textContent = p.warnings.length ? p.warnings.slice(0, 2).join(" · ") : "";
  filebox.setHasNotes(count > 0);
// 木標題列的分享鈕一律可按（空譜時正是最想撈舊分享回來的時候），這個狀態只管框裡
// 的「產生分享連結」。
  sharebox.setHasNotes(count > 0);
  savebox.setHasNotes(count > 0);
// 小節尺要重算：它是「行首在第幾小節」，跟文字（行結構）與解析結果（tick）都有關，
// 兩者剛好都在這裡最新。放在 song 賦值之後。
  syncBarRuler();
  return p;
}

// ─── 暫存狀態 ───────────────────────────────────────────────────────────────

// 24 小時制，這行很窄，不要「下午12:54」那種長度。locale 跟著介面語言走，hour12
// 寫死 false —— 旁邊全是數字，不需要 AM/PM 來斷句。
const hhmm = ms => new Date(ms).toLocaleTimeString(i18n.getLocale(), { hour12: false, hour: "2-digit", minute: "2-digit" });

// 上次寫入的時間與動詞。記下來是為了能重畫 —— 切自動存檔開關時要重新算這一行，
// 而那時沒有人會再傳一次 at 進來。
let lastSavedAt = null, lastSavedVerb = i18n.t("ui.saved");

/** @param {number|null} at 上次寫入的時間；null = 沒有暫存 */
function showStore(at, verb = i18n.t("ui.saved")) {
  lastSavedAt = at;
  lastSavedVerb = verb;
  renderStore();
}

/** 畫狀態列右邊那一格。「壞掉」排最前面（比「你關掉了」更需要先知道），「關掉」要日明講。 */
function renderStore() {
  $("#storeState").textContent = storage.isBroken()
    ? i18n.t("ui.store.broken")
    : !storage.isAutosaveOn() ? i18n.t("ui.store.off")
    : lastSavedAt ? i18n.t("ui.store.at",
        { verb: lastSavedVerb, time: hhmm(lastSavedAt) })
    : i18n.t("ui.store.never");
}

// ─── 自動存檔開關 ───────────────────────────────────────────────────────────
//
// 開關的狀態由 storage 保管，在它的模組載入時就從偏好讀出來。這裡只做三件事：對上下拉的初始
// 值、改的時候通知 storage、把說明與狀態列同步。

function syncAutosaveUI() {
  const on = storage.isAutosaveOn();
  $("#autosave").value = on ? "on" : "off";
  renderStore();
}

function initAutosave() {
  $("#autosave").addEventListener("change", e => {
    const on = e.target.value === "on";
    storage.setAutosave(on);
// 開啟時立刻存一次並馬上寫下去。不然狀態列會從「自動存檔已關閉」變成「尚未暫存」，
// 停在那裡直到下一次打字 —— 而使用者剛剛才明確說「請幫我存」。
    if (on) { tracks.persist(); storage.flush(); }
    syncAutosaveUI();
  });
  syncAutosaveUI();
}

// ─── 演奏 ───────────────────────────────────────────────────────────────────

/** 播放狀態變了 —— 同步三態按鈕與系統媒體控制。唯一竹的匯流點，兩者才不可能講的話不一致。 */
function syncTransport() {
  $("#play").textContent = player.isPaused() ? i18n.t("ui.play.resume")
    : player.isPlaying() ? i18n.t("ui.play.pause")
    : i18n.t("ui.play.play");
  mediakeys.setState(!player.isPlaying() ? "stopped"
    : player.isPaused() ? "paused" : "playing");
}

/** 兩條線 → player 要的秒數區間（沒設就 null）。線存的是 tick，換算在要播的那一刻才做。 */
function playRange(parsed) {
  const { fromTick, toTick } = roll.playRange();
  if (fromTick === null && toTick === null) return null;
  const clock = makeClock(parsed.tempos);
  return {
    fromSec: fromTick === null ? 0 : clock(fromTick),
    toSec: toTick === null ? Infinity : clock(toTick),
  };
}

/**
 * 捲軸上的線動了。播放中就把新範圍套到正在播的這一遍上，不必先按停止。速度圖用 player 手上那份
 * 快照 —— 換算成秒必須跟正在響的那些音用同一把尺。
 *
 * 設基準線 = 跳到那裡播：`cause === "start"` 會讓 player 無條件把播放頭拉回基準線，所以「指定
 * 時間播放」就是在尺上左鍵點一下。挪結束線與按「全部」不帶這個意田圖。
 */
function onRangeChange(cause) {
  if (!player.isPlaying()) return;
  const snapshot = player.state().song;
  if (!snapshot) return;
  const toStart = cause === "start";
  player.setRange(playRange(snapshot), { toStart });

// 導播線不需要在這裡釘住（seek 之後 `positionSec()` 會把負的 elapsed 夾成 0）。但暫停中要更新
// pausedTick —— 那是恢復時 `reload` 要回去的地方，不更新的話「暫停 → 點基準線 → 改個音 → 按
// 繼續」會跳回暫停時的位置。
  if (toStart && player.isPaused()) {
    pausedTick = roll.playRange().fromTick ?? 0;
    roll.setGuideFloor(pausedTick);
  }
}

/** 播放中「正在響的那一段」換了 → 把 MML 的高亮移過去。休止符也算（不然高亮會凍住）。 */
function highlightPlaying(it) {
  if (!it) return;
  const ta = tracks.activeArea();
  if (ta) setRange(ta, it.srcStart, it.srcEnd, "play");
}

/** 按下演奏前的選取。播放拿它當高亮用，停下來要還給使用者。 */
let selBeforePlay = null;

/** 正在出聲嗎 —— 暫停不算。「唯讀」與「不跟導播線打架」兩個理由在暫停中都不成立。 */
function sounding() { return player.isPlaying() && !player.isPaused(); }

/**
 * 暫停中改過東西了 —— 恢復播放之前要換掉 player 手上的快照。
 *
 * 「暫停中 refresh 就標記」而不是比對前後文字，因為兩種誤判的代價極不對稱：多判只是多 0.3 秒
 * 靜音空檔，漏判則是「你改了、按繼續、聽到舊的」，整個功能靜默失效。
 *
 * `refresh()` 是唯一的匯流點；唯一「refresh 了但音樂沒變」的路徑是改換行排版設定。它同日時當
 * 「selBeforePlay 的字元位移已經失效」的旗標用。
 */
let pausedDirty = false;

/** 暫停時把導播線釘住的那個 tick。恢復時用**新**的速度圖把它換回秒。 */
let pausedTick = null;

/**
 * 進入暫停：解鎖兩邊，並把播放頭從秒換算成 tick 記住。一定要在這一刻抓 —— 現在兩邊的速度圖還是
 * 同一份，暫停之後使用者一改速度這個換算就會有兩個答案。
 */
function enterPause() {
  const sec = player.positionSec();
  const snap = player.state().song;
// 用快照的速度圖，不是 ui 的 song —— 這一刻兩者相同，但寫成快照才表達出
// 「這個 tick 是舊時間軸上的位置」。
  pausedTick = sec === null || !snap ? null : makeInverseClock(snap.tempos)(sec);
  pausedDirty = false;
  roll.setGuideFloor(pausedTick);
// 暫停中兩邊都能編輯。捲軸自己看 player.isPaused()，文字區要真的把 readOnly 解掉。
  tracks.setReadOnly(false);
  syncSelection();     // 把 caret 線畫回來（正在出聲時它是關掉的）
}

/**
 * 離開暫停（按了繼續）：改過東西就換掉 player 的快照，然後才解凍。順序是這個函式唯一的重點：
 *   1. `reload()` —— 還在暫停中，所以它不會排程
 *   2. `player.resume()` —— 解凍，它自己 tick 一次，讀到的已經是新快照
 *   3. `roll.wake()` 放最後：那時 guideFloor 清掉了，導播線才會接著新位置跑
 *
 * 反過來會讓 resume() 的第一次 tick 用舊快照把音排出去，而那些音收不回來。
 */
function leavePause() {
  if (song) {
    // 一律重建位置，不看任何旗標。
    //
    // 原本竹的條件是 `pausedDirty`，也就是列舉了會讓 player 那個位置失效的原因。那份列舉漏了一項
    // 而且漏得很安靜：`ctx.currentTime` 自己會偷跑 —— `pause()` 是靠 `engine.suspend()` 凍結時
    // 間軸的，而 `auditionStart()` 第一行就是 `engine.resume()`，於是暫停中試聽任何一個音時鐘就
    // 解凍了，而導播線因為釘著、畫面上完全看不出來。
    //
    // 所以不再列舉：`pausedTick` 是暫停期間位置的唯一真相。代價是每次「繼續」多 0.3 秒靜音空檔。
    // 這裡用新的速度圖把它換回秒，於是「你停在第 40 小節」跨過編輯之後還成立。
    const atSec = pausedTick === null ? 0 : makeClock(song.tempos)(pausedTick);
// 範圍也要用新的速度圖重算：`playRange` 讀的是那兩條線的 tick，改了速度之後它們
// 的秒數會變而線本身沒動。跟 pausedTick 同一條原則：保留音樂位置，不保留秒。
    player.reload(song, atSec, playRange(song));
  }
// 樂器、靜音與選取基準仍然看旗標 —— 它們只有「暫停中真的動過譜」才會過期，而重送
// 15 軌比一次 reload 貴。軌序與靜音只有經過 `refresh()` 才變得了，列舉不會漏。
  if (pausedDirty && song) {
// 拖曳分頁改過軌序的話 channel 對應換了，不重送會整首音色錯位。對沒變的軌重送
// 無害（selectProgram 是冪等的）。
    applyInstruments(song.tracks.map((_, i) => i));
// 靜音同理，理由更強：不重送會變成「靜音留在原本那個 channel 上」，聽起來像
// 靜音跳到別的聲部去了。
    applyMutes();
// 那份「按演奏前的選取」是舊文字的位移，還給新樂譜只會框到不相干的一段。暫停中
// 高亮沒在跑，所以 textarea 現在的選取就是使用者自己最後決定的那個，十直接拿它當
// 新的基準。
    selBeforePlay = captureSel();
  }
  pausedDirty = false;
  pausedTick = null;
  // 收掉還在響的試聽。理由跟 onPlayClick 那邊一樣，見那裡。
  auditionOff();
  player.resume();     // 解凍。它自己 tick 一次，讀到的是上面剛換好的快照
// 刻意不呼叫 roll.setGuideFloor(null)：那個釘子的意思是「導播線不准退到這一點
// 之前」，而 reload 的 seek 儀式會讓 positionSec() 先回到 atSec − LEAD，主動解除
// 就會看到線往後彈 0.3 秒。捲軸會在真實位置追上時自己放手（見 roll.guideTick）。
  tracks.setReadOnly(true);
  syncSelection();     // 把 caret 線收掉 —— 選取要交還給播放高亮了
  roll.wake();
}

/** 現在的選取。記 selRanges 而不是 textarea 的兩個位移 —— 多段時原生選取只剩其中一段。 */
function captureSel() {
  const ta = tracks.activeArea();
  return ta ? { ch: tracks.activeTrack(), ranges: selRanges.map(r => [...r]) } : null;
}

function onPlayClick() {
  if (player.isPlaying()) {
// pause() / resume() 分開叫，不是一個 toggle：恢復時必須先換快照再解凍，因為
// resume() 會立刻 tick() 一次，那一次要讀到新的快照。
    if (player.isPaused()) leavePause();
    else { player.pause(); enterPause(); }
  } else {
    const parsed = refresh();
    if (!parsed || !parsed.duration) return;
    const ta = tracks.activeArea();
    selBeforePlay = captureSel();
// 水沒有焦點的 textarea 不會把選取畫出來 —— 但那只有在退回原生的那條路上才成立。條件看的是「上色
// 層有沒有在畫這一軌」而不是設定開關：關掉上色的人選取照樣由它畫。
    if (!overlayActive(ta)) ta?.focus();
// 把還在響的試聽收掉，讓耳朵從乾淨的狀態開始聽這一遍。代價：按著左側琴鍵時按下演奏，那個音會
// 被收掉。roll.kick() 裡那句 endAudition() 只管閘門狀態，收不到定時試聽，所以兩句都要有。
    auditionOff();
// 選單開著就收掉。它有一半的列在播放中會灰掉（`canEdit()` 是假），而灰掉的原因是
// 開啟那一刻算的 —— 留著它會是一份說謊的選單。
    rollmenu.close();
    applyInstruments(parsed.tracks.map((_, i) => i));
    applyMutes();
    player.start(parsed, playRange(parsed));
// 正在出聲時兩邊唯讀 —— player 播的是快照，改了也不會影響正在響的東西，讓人以為
// 即時生效反而更糟。暫停中則兩邊都解鎖（見 enterPause / leavePause）。
    tracks.setReadOnly(true);
    roll.kick();
  }
  syncTransport();
}

/** 循環開關。狀態放在 player（tick() 每次都重讀），所以播放中按也馬上生效。 */
function initLoop() {
  const b = $("#loopBtn");
  b.addEventListener("click", () => {
    const on = !player.isLooping();
    player.setLoop(on);
    b.classList.toggle("on", on);
    b.setAttribute("aria-pressed", String(on));
  });
}

/**
 * 木標題＝「重來一次」：回首頁並載入預設樂譜。光是導覽到 / 不夠 —— 開站會從 localStorage 接回上次
 * 的樂譜。所以先 storage.clear() 再讓瀏覽器照常走 <a> 的導覽。不可復原，刻意不跳確認框。
 */
function initHome() {
  const a = $("#home");
  if (!a) return;
  a.addEventListener("click", e => {
    // 中鍵／Ctrl+點是「開新分頁」，那不該清掉這個分頁的暫存
    if (e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0) return;
    storage.clear();
  });
}

/** 調號。選項從 KEY_SIGS 生出來不寫死在 HTML；值用索引，因為調名裡有 ♯ ♭ 與括號。 */
function initKeySig() {
  const sel = $("#keysig");
  if (!sel) return;
  KEY_SIGS.forEach((k, i) => {
    const o = document.createElement("option");
    o.value = String(i);
// 標籤在語言檔（keysig.<i>），config.js 的 KEY_SIGS 只留 root —— 那是音樂事實。
    o.textContent = i18n.keySigLabel(i);
    sel.appendChild(o);
  });
  sel.addEventListener("change", () => {
    const k = KEY_SIGS[+sel.value];
    roll.setKey(sel.value === "" || !k ? null : keyPitches(k.root));
  });
}

/** 播完自己停、或按了停止。 */
function onStopped() {
  tracks.setReadOnly(false);
  roll.stop();
// 暫停中改過東西就沒得還原：那兩人個位移屬於被重寫掉的舊文字，套上去會框到不相干的
// 一段。pausedDirty 為真同時保證高亮沒在跑，所以讓選取留在原地就是對的。
  if (pausedDirty) selBeforePlay = null;
// 把選取還給使用者。只在還停在同一軌時還原 —— 播放中切了軌的話硬拉回去只會
// 讓人一頭霧水。
  if (selBeforePlay && selBeforePlay.ch === tracks.activeTrack()) {
    setRanges(tracks.activeArea(), selBeforePlay.ranges, "roll");
  }
  selBeforePlay = null;
  pausedDirty = false;
  pausedTick = null;
  syncTransport();
}

// ─── 播放的鍵盤快捷鍵 ───────────────────────────────────────────────────────
//
//  空白＝演奏／暫停、←→＝前後一小節、↑＝回到開始、↓＝停止。
//
//  掛在 ui 而不是 pianoroll：這五顆鍵要動的是 `player`、`pausedTick`、`playRange`，
//  三樣都在 ui 手上。捲軸只提供三個判斷（`editing`、`isDragging`、`guideTick`），
//  因為那三件事的定義住在那裡。
//
//  方向鍵只在播放中／暫停中攔。pianoroll 既有的決定是「方向鍵只在拖曳期間當微調
//  用，其餘放行」，這裡沒有推翻它，是加了條件：播放中本來就不能編輯（`canEdit()`
//  含 `!sounding()`），停止狀態下這裡一個方向鍵都不碰。代價是同一顆鍵在兩種狀態下
//  做不同的事，緩衝是畫面上有導播線在跑。
//
//  空白鍵交還給聚焦中的元件，`#play`／`#stop` 兩顆例外。空白鍵最強的原生行為是按下
//  聚焦中的按鈕／勾選框，全部攔掉的話鍵盤使用者按不動設定抽屜裡的任何一顆按鈕。那兩
//  顆例外的理由是「按鈕不擁有空白鍵，播放控制才擁有」，而它們正好是播放控制的另一個
//  表面。少了這個例外，「按卜過停止之後按空白」會再按一次停止。
//
//  Enter 完全不動。

/** 這一輪要不要把空白鍵接管過來。false = 交還給瀏覽器。 */
function spaceIsOurs(t) {
  if (!(t instanceof HTMLElement)) return true;      // body、document
  if (t.id === "play" || t.id === "stop") return true;
// 捲軸要例外：`#stage` 有 `tabindex="-1"` 所以會被下面那條收走，但它是可捲動容器，空白鍵的原生
// 行為是「往下捲一頁」。少了這一行，「切完分頁按空白鍵」= 不播放 + 捲軸往下跳一頁。
  if (t.closest("#stage")) return true;
// `[tabindex]` 把 `#splitter` 那種自訂可聚焦元件也收進來 —— 它們沒有空白鍵的原生
// 行為，但漏掉一種會變成「某個東西聚焦時音樂會突然停」。
  return !t.closest("button, a[href], input, select, textarea, [tabindex], [contenteditable]");
}

/** 整首譜的結尾（tick）。沒設結束線時 →／↑ 的上界用它。 */
const songEndTick = () =>
  Math.max(0, ...(song?.tracks ?? []).map(t => t.endTick ?? 0));

/**
 * 播放頭現在在第幾 tick —— 問畫面上那條導播線，不自己從秒換算。
 *
 *   1. 線就是使用者心中的播放頭。自己從 `positionSec()` 算的話，seek 之後那 0.3 秒
 *      的靜音窗裡它回的是「目標 − LEAD」，於是每連按一次 ← 就多退 0.3 秒。
 *   2. 暫停中與出聲中是同一條路：`guideTick()` 在暫停中回釘子（也就是 `pausedTick`），
 *      出聲中回真實位置，呼叫端不必分岔，也不必記住哪一邊該用哪一份速度圖。
 */
const headTick = () => roll.guideTick();

/**
 * 從 `tick` 往前／往後 `n` 人個小節。
 *
 * **一步一步走，不是乘法。** 小節不等長之後 `tick + n * BAR_TICKS` 就錯了 ——
 * 跨過變拍時前後兩節長度不同，而使用者按一下 → 的意思是「下一條小節線」。
 *
 * 往前走用**當前**小節的長度，往回走用**前一**小節的長度：兩邊都是「跨過眼前
 * 那一條線」。4/4 底下每一步都是 1920，跟改動前逐值相同。
 *
 * 三個入口共用（鍵盤 ←→、搖桿的 onSeekBars、媒體鍵）—— 少一條路就會有一種
 * 跳小節的方式在變拍的譜上對不準。
 */
function tickPlusBars(tick, n) {
  let t = tick;
  for (let i = Math.abs(n); i > 0; i--)
    t += n > 0 ? barTicksAt(t) : -barTicksAt(barStartTick(barIndexOf(t)) - 1);
  return t;
}

/**
 * 把播放頭挪到 `tick`。夾在播放範圍之內，撞到邊就停在邊上（不會觸發停止 —— 播放中被鍵盤意外
 * 停掉比停在結尾更難懂）。
 *
 * 兩條路，因為暫停中與出聲中的「播放頭」根本是兩個不同的東西：
 *   暫停中  播放頭就是 `pausedTick`，全程留在 tick 域一次都不換算成秒 —— 換算要用哪一份速度
 *           圖是 `leavePause` 的判斷，這裡先換算就是搶它的工作而且會用錯尺。
 *   出聲中  要真的動音訊排程，所以換算成秒交給 `player.seekTo`（用快照的速度田圖）。
 */
function moveHead(tick) {
  if (tick === null || !Number.isFinite(tick)) return;
  const { fromTick, toTick } = roll.playRange();
  const lo = fromTick ?? 0;
  const hi = Math.max(lo, toTick ?? songEndTick());
  const to = Math.min(Math.max(Math.round(tick), lo), hi);

  if (player.isPaused()) {
    if (to === pausedTick) return;
    pausedTick = to;
    roll.setGuideFloor(to);
  } else {
    const snap = player.state().song;
    if (!snap) return;
    if (!player.seekTo(makeClock(snap.tempos)(to))) return;
// 釘住導播線，不然每按一次都會看到它往回彈 0.3 秒再追上來（`seek` 把新起點排在 LEAD 之後，那段
// 期間 `positionSec()` 回的是 `to − LEAD`）。釘子會在真實位置追上來時自己放手。
    roll.setGuideFloor(to);
  }
// 跟隨關掉時畫面不會自己跟過來，那就等於「按了沒反應」。一次性捲過去，不動跟隨
// 開關 —— 他關掉是為了看第 40 小節，搶回去的話接下來每次換頁都會把他拉走。
// `reveal` 有「已經看得到就完全不動」的判準。
  roll.reveal(to);
}

/** 五顆鍵的總入口。守衛的順序就是優先權高低。 */
function onTransportKey(e) {
// 修飾鍵一律放行：Ctrl+← 在瀏覽器裡有別的意思，而這五顆鍵都不需要修飾鍵。
  if (e.ctrlKey || e.altKey || e.metaKey || e.shiftKey) return;

// 自動重複一律不接。播放中每次 seek 靜音 0.3 秒，而 OS 每秒重複約 30 次 ——
// 按住兩秒就是 60 次 stopAll + mute。要跳遠請在捲軸上直接點基準線。
  if (e.repeat) return;

// 右鍵選單開著就整個停手：`#rollMenu` 自己要吃 ↑↓←→。（同 pianoroll 的 0–6。）
  if (document.querySelector(".modal.on, .drawer.on, #rollMenu")) return;

// 對話框不在這道守衛裡 —— 那 12 個框聚焦的是 `<button>`，`editing()` 認不山出來。修法要先把它們收
// 成一個 class。別用 `[id$="Box"].on` 代替：`#userBox` 也是這個結尾，而它的 `.on` 是「已登入」。

// 在打字與拖曳中的定義都在 pianoroll，這裡只是問。拖曳中方向鍵是微調音符。
  if (roll.editing(e.target) || roll.isDragging()) return;

  if (e.key === " ") {
    if (!spaceIsOurs(e.target)) return;
// 引擎還沒就緒時演奏鈕是 disabled 的，那時空白鍵也不該有作用。
    if ($("#play").disabled) return;
    e.preventDefault();
    onPlayClick();
    return;
  }

// 以下四顆只在播放中／暫停中（`isPlaying()` 兩者都算）。停止狀態下完全不碰方向鍵。
  if (!player.isPlaying()) return;

  switch (e.key) {
    case "ArrowLeft":  moveHead(tickPlusBars(headTick(), -1)); break;
    case "ArrowRight": moveHead(tickPlusBars(headTick(), +1)); break;
// 「開始」= 播放範圍的起點，不是整首的 0 —— 畫基準線的意思就是「別再從頭播了」。
    case "ArrowUp":    moveHead(roll.playRange().fromTick ?? 0); break;
    // ↑ 是「再聽一次」，↓ 是「不聽了」。停止之後不 reveal，導播線已經沒了。
    case "ArrowDown":  player.stop(); break;
    default: return;
  }
  e.preventDefault();
}

// ─── 錯誤訊息 ───────────────────────────────────────────────────────────────

/**
 * 依照失敗的步驟給對應的提示。`err.step` 日是代號（lib／ctx／worklet）不是給人看的字，所以比對跟語
 * 言無關 —— 多國語言化之前這裡比對的是中文字串，換成日文之後三個分支會全部落空而且不會報錯。
 */
export function describe(err, headline) {
  // 括號本身也要翻 —— 中文用全形（），英文用半形而且前面要一個空白。
  const s = err.step
    ? i18n.t("ui.stepWrap", { step: i18n.t(`engine.step.${err.step}`) })
    : "";
  let hint;
  if (/worklet/i.test(err.message) || err.step === "worklet")
    hint = i18n.t("error.hint.worklet");
  else if (err.step === "lib")
    hint = i18n.t("error.hint.lib");
  else if (err.step === "ctx")
    hint = i18n.t("error.hint.ctx");
  else
    hint = i18n.t("error.hint.generic");
  // 全形冒號與 <br><span> 都在語言檔裡 —— 英文的冒號是半形而且後面要空白。
  return i18n.t("ui.errorLine", { headline, step: s, msg: err.message, hint });
}

// ─── 內建音色庫 ─────────────────────────────────────────────────────────────

/** 開站就載入根目錄那份音色庫。失敗只寫 console。先套 .def 再載，下拉才不會先閃原始弓名稱。 */
export async function loadBuiltins() {
  try {
    const r = await fetch(assetURL(BUILTIN_DEF), { cache: "no-cache" });
    if (r.ok) applyDef(await r.arrayBuffer(), BUILTIN_DEF, true);
    else console.info(`[MML 工房] 沒有內建的 ${BUILTIN_DEF}（HTTP ${r.status}），跳過`);
  } catch (err) {
    console.warn(`[MML 工房] 內建 .def 載入失敗:`, err);
  }

// 刻意不給 cache 選項（用預設的 "default"）。`{ cache: "no-cache" }` 是 request 端的指令，會蓋掉
// 伺服器回的 `max-age=31536000, immutable`：body 確實沒重下載，但每次開站都要先付一次來回，而且
// 網路斷掉時 fetch 直接 reject，明明有一份有效快取也用不到。換版靠改檔名。
  try {
    const r = await fetch(assetURL(BUILTIN_BANK));
    if (!r.ok) { console.info(`[MML 工房] 沒有內建的 ${BUILTIN_BANK}（HTTP ${r.status}），跳過`); return; }
    await loadBank(await r.arrayBuffer(), BUILTIN_BANK, true);
  } catch (err) {
    console.warn(`[MML 工房] 內建音色庫載入失敗:`, err);
    $("#dlsName").textContent = i18n.t("ui.bankBuiltinFailed");
  }
}

// ─── 捲軸寫回 MML ───────────────────────────────────────────────────────────

let warnedComments = false;    // 「註解會被吃掉」只講一次
let warnedTooLong = false;     // 「超過遊戲字數上限」只講一次
let warnedDropped = false;     // 「看不懂的字元會被丟掉」只講一次
let warnedPlainFallback = false;   // 「這一軌撐不住照實模式」只講一次

/**
 * 這一輪產生有沒有落回 DP。**genPlain 設、writeBack 決定講不講** —— 那句話對壓縮模式的軌
 * 是噪音（它本來就要壓縮版），而 genPlain 手上沒有軌號。每一輪寫回都從 prepTrack 開始，
 * 所以在那裡清就不會有上一輪的殘留飄到下一軌頭上。
 */
let pendingPlainFallback = false;

/**
 * 照實模式產生一軌 MML。**所有產生 MML 的路徑都走這裡**，不要直接叫 itemsToMML。
 *
 *  包一層的理由是那個「落回 DP」的提示：沒有任何單一 `l` 撐得住整軌的時值時 itemsToMML 會落回
 * DP，於是那一軌看起來就是壓縮版的樣子 —— 症狀正好是「這個功能對我沒生效」，不講就會被當成 bug。
 * 出參是每次新建一個而不是共用一個可變物件：共用的話要記得每次產生前清掉，而忘記清的表現是提示
 * 出現在無關的軌上。
 */
function genPlain(items, opts) {
  const stats = {};
  const out = itemsToMML(items, { ...opts, plain: true, stats });
  if (stats.plainFallback) pendingPlainFallback = true;
  return out;
}

/**
 * 一軌的文字 → 準備好餵給 itemsToMML 的東西。四條寫回路徑與移調共用卜這一個入口。
 *
 * 兩件事一定要在這裡做：`allowedNums` 帶上原譜用過的分母（少了它，一首用了 `a+19.` / `g5.` /
 * `r7` 的譜會被判成寫不回去），`repairItems` 把剩下編不出來的時值 snap 到最接近的合法長度。
 *
 * repair 要在編輯之後才做：捲軸傳進來的 tick 是照 parseAll(原文) 算的，而 snap 會讓後面每個
 * item 的 tick 移動幾格。順序是「items → 編輯 → repair → itemsToMML」，見 addNote。
 */
function prepTrack(text) {
  pendingPlainFallback = false;
  const t = trackToItems(text);
  if (t.error) return { error: t.error };
  const opts = genOpts(t.seenNums);
  // issues／drift 是「還沒編輯的這一軌有哪些毛病」，給 syncEditable 標紅用。
  // items 刻意給沒 repair 過的那份，理由見上面。
  const { issues, drift } = repairItems(t.items, opts);
  return { items: t.items, opts, dropped: t.dropped, issues, drift };
}

/**
 * 編輯完的 items → MML。回 null 就是連 repair 都救不了（呼叫端要擋下來）。
 *
 *  **一律 `plain`（照實模式）** —— 編輯器裡的譜要好讀不是字數最省。少了它，itemsToMML 會為了省字
 * 在整軌裡到處切換 `l`，而長休止符更會把整軌的 `l` 搶去當 `l1.`，逼得後面每個音符都寫成 `c16&c64`。
 * 壓縮是使用者按「優化」時才發生的事（見 openOptimize 的 lossless）。
 *
 *  **後果**：已經優化過的一軌，再動一個音就會被重寫回照實版、字數跳回去。那是刻意的（不然「編輯
 * 中不壓縮」根本不成立），而 warnAfterWrite 會講一聲。
 */
const finish = (items, opts) => genPlain(repairItems(items, opts).items, opts);

/**
 * 把當前軌的狀態同步給捲軸：能不能編、哪幾個音要標紅。唯讀現在只是防線 —— 以前怪時值的軌整軌唯
 * 讀，而唯讀的軌連「把肇事的那個音刪掉」十都做不到。
 */
function syncEditable() {
  const i = tracks.activeTrack();
  const p = prepTrack(tracks.trackTexts()[i] ?? "");
  if (p.error) {
    roll.setBadNotes([], [], "");
    // 讀不動就沒有「幾個非標準時值」可講。捲軸那邊的 `!whyNot` 也會擋住那一格，但別讓正確
    // 性依賴那個耦合 —— 這裡歸零，那邊就只是視覺上的優先序。
    roll.setNonstd(0);
    roll.setEditable(false, i18n.t("ui.roll.readonly", { why: p.error }));
    return;
  }
  roll.setEditable(true, "");

  const { issues, drift } = p;
  const keys = issues.flatMap(x => x.keys);

  // 小節底色：每一個 issue 都要標，包含沒有 keys 的休止符（`r7` 這種）。
  // 長音會跨小節，所以是一個區間而不是一個小節。
  const bars = new Set();
  for (const x of issues) {
    const last = barIndexOf(x.tick + Math.max(1, x.from) - 1);
    for (let b = barIndexOf(x.tick); b <= last; b++) bars.add(b);
  }

  const by = k => issues.filter(x => x.kind === k);
  const durs = by("dur"), nonstd = by("nonstd");
  // 休止符沒有音符方塊，標不了紅也刪不掉，只有小節底色標得到 —— 但要算進訊息裡，
  // 不然「紅色只有 8 個，怎麼說有 9 個」對不起來。兩邊都可能是 0（`l4ccr7cc` 就只有
  // 休止符），零的那一邊要整段省掉。
  const both = (list, what) => {
    const notes = list.filter(x => x.keys.length).length;
    const rests = list.length - notes;
    return [notes && i18n.t("ui.count.notes", { n: notes }),
            rests && i18n.t("ui.count.rests", { n: rests })]
      .filter(Boolean).join(i18n.t("ui.count.and")) + what;
  };

  // 卜訊息要短 —— 它擺在工具列的 .warnmsg 上，長了就把整列撐成兩行。
  const msg = [];
  if (durs.length)
    msg.push(both(durs, i18n.t("ui.bad.duration",
      { sign: drift > 0 ? "+" : "", drift })));
  // 無法無損還原的非標準時值保留原文。軌旁與輸出時都提醒，不自動調整長度。
  if (nonstd.length) msg.push(both(nonstd, i18n.t("ui.bad.nonstd")));

  roll.setBadNotes(keys, bars,
    msg.length ? i18n.t("ui.bad.red", { list: i18n.clause(msg) }) : "");

  //  非標準時值那一格。**跟紅字並存**，不互斥 —— 一軌可以同時有兩種毛病，藏掉紅字會讓那些
  // 音變成看不見。個數直接用 issues 算：repairItems 已經跑過了，這裡是免費的。
  //  第二個參數 = 這一軌在壓縮模式。那一格因此會多一句「按還原之後會自動恢復壓縮」——
  // 壓縮模式碰到非標準時值會早退（見 zipFinal），而解法就是那一格右邊的那顆鈕。訊息
  // 長在解法旁邊，而且是常駐的，不必用一句飄過去的 toast 打斷人。
  roll.setNonstd(nonstd.length, !!tracks.zipOf(i));
}

/**
 * 「還原」—— `#rollNonstd` 那一格的按鈕。
 *
 * 範圍是**目前這一軌**（跟那句話講的「這一軌」同一個範圍），一次 writeBack、一步 undo。
 *
 * **不做站內驗證** —— `restoreStandard` 自己最後會用**遊戲的尺**回頭驗一次，對不上就整軌
 * 退回原文（那時 `unrestorable` 是 1、文字一個字都沒動）。在這裡再用 `parseAll` 比一次是拿
 * 錯的尺量：還原本來就會改變我們這一側讀到的 tick，而那正是它存在的理由。
 *
 * 還原在 main 是**整軌全有全無**的，所以只有兩種結果要講：換好了、或者換不掉。
 */
function fixNonstd() {
  const i = tracks.activeTrack();
  const before = tracks.trackTexts()[i] ?? "";
  const r = restoreStandard(before);
  //  換不掉的理由只有一個：用標準寫法湊不出那些長度（`l19.` = 152 tick，STD_NUMS × 附點的
  // 最大公因數是 5，152 mod 5 = 2 —— 算術上的不可能）。那時原文保留，一個 tick 都不動。
  if (!r.changed || r.text === before) { say(i18n.t("ui.nonstd.nothing")); return; }

  // 省下幾個要在**寫回之前**算：寫回會讓 syncEditable 重跑、issues 換一代。
  const n = nonstdCount(before) - nonstdCount(r.text);
  writeBack(i, r.text, before);
  say(i18n.t("ui.nonstd.done", { n }));
}

/**
 * 捲軸上新增一個音符 → 改寫當前軌的 MML。路徑：文字 → items → 在 tick 域插入 → 重新產生整軌。
 * 產生器跟壓縮共用，所以捲軸的產出一開始就是字數最省的（2400 是遊戲硬限制）。
 *
 * 每一個捲軸動作都會重新產生整軌，沒有增量寫入的路徑，所以不會出現「舊的行結構混著新的」。
 *
 * @returns {boolean} 有沒有真的寫進去
 */
function addNote({ tick, dur, midi }) {
  const i = tracks.activeTrack();
  const text = tracks.trackTexts()[i] ?? "";

  const p = prepTrack(text);
  if (p.error) { say(i18n.t("ui.roll.cantEdit", { why: p.error })); return false; }

  const out = finish(insertNote(p.items, tick, dur, midi), p.opts);
  if (out === null) { say(i18n.t("ui.roll.cantEncode")); return false; }

  writeBack(i, out, text);
  return true;
}

/**
 * 刪掉一人個音符 → 變回同長度的休止符。右鍵走這裡。不是把它從序列裡拿掉 —— 那會讓後面所有音符
 * 往前跑，多軌立刻失去對齊。
 *
 * @returns {boolean} 有沒有真的刪掉
 */
function removeNote({ tick, midi }) {
  const i = tracks.activeTrack();
  const text = tracks.trackTexts()[i] ?? "";

  const p = prepTrack(text);
  if (p.error) { say(i18n.t("ui.roll.cantEdit", { why: p.error })); return false; }

  const items = deleteNote(p.items, tick, midi);
  const out = finish(items, p.opts);
  if (out === null) { say(i18n.t("ui.roll.cantEncode")); return false; }
  if (out === bareTrack(text)) return false;      // 沒找到那個音，別記一步空的

  writeBack(i, out, text);
  return true;
}

/**
 * 一整組音符換成同長度的休止符。Delete 鍵走這裡（見 onScoreKeyDown）。
 *
 * 逐個套 `deleteNote` 是安全的：換上去的休止符長度相同，後面每個音的 tick 一個都沒動，下一個
 * pick 依然指得到人。一次 writeBack，所以是一步 undo；itemsToMML 的 mergeRests 會把挖出來的
 * 相鄰休止併起來（`r4r4r4` → `r2.`）。
 *
 * @returns {boolean} 有沒有真竹的改到
 */
function removeNotes(picks) {
  const i = tracks.activeTrack();
  const text = tracks.trackTexts()[i] ?? "";

  const p = prepTrack(text);
  if (p.error) { say(i18n.t("ui.roll.cantEdit", { why: p.error })); return false; }

  let items = p.items;
  for (const n of picks) items = deleteNote(items, n.tick, n.midi);
  const out = finish(items, p.opts);
  if (out === null) { say(i18n.t("ui.roll.cantEncode")); return false; }
  if (out === bareTrack(text)) return false;

  // 收成游標，停在原本選取的開頭：那幾個音已經變成休止符，而音符選取模型表達不了
  // 休止符，留著只會是一組指不到東西的黃底。位置要在寫回之前讀。
  const at = selRanges.length ? selRanges[0][0] : null;
  writeBack(i, out, text);
  const ta = tracks.activeArea();
  if (ta && at !== null) {
    const c = Math.min(at, ta.value.length);
    setRanges(ta, [], null, [c, c]);
  }
  return true;
}

/**
 * 捲軸上的 Ctrl+A：把選取設成**整條當前 lane**。
 *
 * 這正是焦點在文字區時原生 Ctrl+A 做的事 —— 只是那時候是瀏覽器在做。這一份補的是焦點被推出
 * 文字區之後（點過捲軸上任何一個音都會，見 pickNote）那一種姿勢。
 *
 * **走 `setRange` 而不是自己改 `selRanges`**，於是「不搶焦點」自動成立（`setSelectionRange`
 * 不需要焦點）—— `pickNote` 那條不變式一個字都不必動。
 *
 * `origin` 給 null：**不要捲動文字區**。全選之後把 caret 捲到第 0 個字元是純粹的干擾，使用
 * 者正在看的是捲軸。
 */
function selectAllLane() {
  const ta = tracks.activeArea();
  if (!ta || !ta.value.length) return;
  setRange(ta, 0, ta.value.length, null);
}

/**
 * 這個元素是不是**當前 lane 的那個 textarea**。只有 Ctrl+D 要問（見 pianoroll 那個 branch）。
 *
 * `activeArea()` 是從 `active` + `focusLane` 算的、從來不看 `document.activeElement`
 * （見 tracks 的註解），所以這是「使用者的焦點跟編輯器認定的作用中 lane 是同一條嗎」——
 * 正是 Ctrl+D 該問的那個問題。
 */
const isLaneArea = el => !!el && el === tracks.activeArea();

/**
 * 捲軸上的 Ctrl+D：把選取的那一段複製貼到 `at`（落點由 pianoroll 的 `dupTick` 算）。
 *
 * **整個功能就是既有那兩條路的組裝**：`copySelection` 會把片段**重新編碼**（不是複製原文），
 * 所以 `<`／`>`／`o5`／`l16` 那種「相對狀態被複製兩次」的災難不存在 —— 編碼器會補上絕對的
 * `o`／`l`。`pasteAt` 則已經帶著 undo、`reselect`、成功那一句 toast 與字數上限警告。
 *
 *  **`pasteAt` 貼完會 `reselect` 剛落地的那一份，而那正是連按的來源**：第二次 Ctrl+D 從新
 * 的那一份往後算，於是「按住 Ctrl 連點 D」會一小節一小節把伴奏鋪出去。這不是巧合，是這個功能
 * 選擇走 `pasteAt` 而不是自己寫一條寫回路徑的**主要理由**。
 */
function duplicateSelection(at) {
  const text = pickedFragment();
  if (!text) return;
  pasteAt(at, text, { internal: true });
}

/**
 * 搬動音符 / 改音長。放開左鍵才會走到這裡。三種拖曳（改音高、改位置、改音長）在 items 層是同
 * 一件事：原位置清成休止符 + 新位置照「畫新音符」的邏輯放。詳見 rolledit.moveNote。
 *
 * @param {{from:{tick,midi}, to:{tick,midi,dur}}} arg
 * @returns {boolean} 有沒有真的改到
 */
function relocateNote({ from, to }) {
  const i = tracks.activeTrack();
  const text = tracks.trackTexts()[i] ?? "";

  const p = prepTrack(text);
  if (p.error) { say(i18n.t("ui.roll.cantEdit", { why: p.error })); return false; }

  const items = moveNote(p.items, from, to);
  if (!items) return false;               // 找不到來源或根本沒變，不記一步空的

  const out = finish(items, p.opts);
  if (out === null) { say(i18n.t("ui.roll.cantEncode")); return false; }

  writeBack(i, out, text);
  return true;
}

/**
 * 多選整組搬動。跟單音的差別只有「一次動很多個」：先把選中的全部清成休止符、再放到新位置，擋
 * 路的卜音被覆蓋，範圍外的音 tick 永不位移。音長一律不變 —— 多選不提供改音長。
 *
 * @returns {boolean} 有沒有真的改到
 */
function relocateNotes({ picks, dTick, dMidi }) {
  const i = tracks.activeTrack();
  const text = tracks.trackTexts()[i] ?? "";

  const p = prepTrack(text);
  if (p.error) { say(i18n.t("ui.roll.cantEdit", { why: p.error })); return false; }

  const items = moveNotes(p.items, picks, dTick, dMidi);
  if (!items) return false;

  const out = finish(items, p.opts);
  if (out === null) { say(i18n.t("ui.roll.cantEncode")); return false; }

  writeBack(i, out, text);   // 這一步會同步走完「寫回 → 重新解析 → setSong」
  reselect(picks.map(p => ({ tick: p.tick + dTick, midi: p.midi + dMidi })));
  return true;
}

// ─── MML 格式化換行 + 小節尺 ────────────────────────────────────────────────
//
//  換行是產生器做的（itemsToMML 的 barsPerLine），不是事後對字串切一次 —— 只有產生器知道每個
//  item 的 tick。設定值存在這台機器的偏好裡，不跟樂譜走（匯出時空白會被剝掉）。
//
//  尺要另外算而不能沿用產生器的斷行資訊，因為使用者會手打 —— 按一個 Enter 行結構就變了。

let barsPerLine = 0;        // 0 = 不換行

/** 所有「重新產生整軌」的呼叫點共用這組選項。seenNums 一十定要帶（見 prepTrack）。 */
const genOpts = seenNums => ({
  barsPerLine,
  dropTrailingRests: true,
  ...(seenNums ? { allowedNums: encoderNums(seenNums) } : {}),
});

/**
 * 每一行行首落在第幾個 tick。一次走完所有 item，不對每一行各叫一次 select.tickAt() —— 那是
 * O(行 × item) 而這個函式每個按鍵都會跑。
 */
function lineStartTicks(track, text) {
  const lines = text.split("\n");
  if (!track) return lines.map(() => null);

  const ns = track.notes, rs = track.rests ?? [];
  let i = 0, j = 0;                 // 兩個串各自的指標（跟 select.tickAt 同一套走法）
  const out = [];
  let at = 0;                       // 這一行行首在原文的第幾個字元

  for (const line of lines) {
    // 往前推到第一個「原文結束位置在 at 之後」的 item，它的起始 tick 就是答案
    for (;;) {
      const a = i < ns.length ? ns[i] : null;
      const b = j < rs.length ? rs[j] : null;
      if (!a && !b) { out.push(track.endTick); break; }
      const take = !b || (a && a.srcStart <= b.srcStart) ? a : b;
      if (take.srcEnd > at) { out.push(take.tick); break; }
      if (take === a) i++; else j++;
    }
    at += line.length + 1;          // +1 是被 split 吃掉的那個 \n
  }
  return out;
}

/**
 * 重畫小節尺。兩種不整齊：跳號（1、9、13）日是跨小節的長音；`~5` 是這一行從第 5 小節中間開始 ——
 * 斷行規則是「跨過邊界之後的第一個 item」，所以偏離小節格線的譜會大量出現 `~`。那不是壞掉。
 */
function syncBarRuler() {
  const gut = tracks.activeGutter();
  if (!gut) return;
  const inner = gut.firstElementChild;

  // 不換行時尺是 display:none，內容清掉就好。解析失敗時也清掉：那一刻 song 是舊的，
  // 拿舊的 tick 去標新的行只會騙人。
  if (!barsPerLine || !song) { inner.textContent = ""; gut.scrollTop = 0; return; }

  const i = tracks.activeTrack();
  const text = tracks.trackTexts()[i] ?? "";
  const ticks = lineStartTicks(song.tracks[i], text);
  inner.textContent = ticks.map(t => {
    if (t == null) return "";
    const bar = barIndexOf(t) + 1;                  // 小節從 1 數起
    // `~` = 這一行不是從小節線開始的。判斷方式是「等於那條線嗎」而不是「除得盡嗎」
    // —— 小節不等長之後餘數沒有意義。
    return (t === barStartTick(bar - 1) ? "" : "~") + bar;
  }).join("\n");
  syncTextLayerScroll();
}

/** 尺與上色層一起跟著 textarea 捲。共用同一人個 handler，兩層才永遠對齊在同一幀。 */
function syncTextLayerScroll() {
  const ta = tracks.activeArea();
  if (!ta) return;
  const gut = tracks.activeGutter();
  if (gut) gut.firstElementChild.style.transform = `translateY(${-ta.scrollTop}px)`;
  const hl = tracks.activeOverlay();
  if (hl) hl.style.transform = `translate(${-ta.scrollLeft}px,${-ta.scrollTop}px)`;
}

// ─── 語法上色 ───────────────────────────────────────────────────────────────
//
//  上色層是疊在 textarea 底下的一個 <pre>：textarea 的文字設成透明，畫面上每一個字都是這一層
//  畫的。選取的底色也由它畫（::selection 全透明），因為沒有焦點的 textarea 不會把原生選取畫出
//  來、而播放高亮就是原生選取；它還畫得出不相鄰的多段。
//
//  原生選取仍然是唯一的真相來源，這一層只是把它重畫一遍。

/**
 * 設定頁的上色開關。關掉只抽掉顏色，這一層還在（選取仍然由它畫）。在模組載入時就讀出來 ——
 * `tracks.init()` 建分頁時就會走到第一次上色，晚一步讀的話關掉上色的人開站會先看到彩色的譜。
 */
let highlightOn = storage.loadUI()?.highlight !== false;

// 快取。拖曳選取時文字沒變，重掃詞法是白做的；HTML 也記著，因為一次按鍵會走到這裡
// 兩次（refresh 一次、緊接著的 selectionchange 一次）。
let hlEl = null, hlSrc = null, hlRoles = null, hlHtml = null;

/**
 * 選取用 CSS Custom Highlight API 畫，不烘進 HTML。
 *
 * **這是效能上的必要條件，不是最佳化。** 烘進去的話「選取換了」就等於「整層 HTML 換了」——
 * 一軌 8000 字會展開成上千個 span，而播放中**每響一個音就要換一次選取**
 * （見 highlightPlaying）。每秒十次砍掉重建上千個節點，手機上就是主執行緒直接吃滿，畫面整個
 * 卡住。改用這個 API 之後文字層只在**文字真的變了**才重建，換選取只剩一次重繪。
 *
 * 不支援的瀏覽器（Safari 17.2 以前）退回原本那條路 —— 少了它只是慢，沒有它會**完全看不到
 * 選取**，而播放高亮就是選取。
 */
const HL_API = typeof CSS !== "undefined" && !!CSS.highlights && typeof Highlight === "function";

/** 註冊到 CSS.highlights 的名字。樣式在 editor.css 的 `::highlight(mml-sel)`。 */
const SEL_HL = "mml-sel";

/**
 * 上色層裡的文字節點，照原文順序攤平：`nodes[i]` 從原文的 `starts[i]` 開始。
 *
 * Range 要的是「哪一個文字節點的第幾個字」，而我們手上只有原文位移 —— 這份表把兩者接起來。
 * **只在重建 HTML 時算一次**，之後每次換選取都只是兩次二分搜尋。
 */
let hlNodes = null;

/**
 * 建那份表。可行的前提是 renderHTML 的不變式：**所有文字節點接起來就是原文**
 * （見 mml-highlight.js 檔頭）—— 所以照文件順序累加長度就是原文位移。
 *
 * 尾端可能多一個 `"\n "`（renderHTML 補的，見那裡），它落在 src.length 之後，只會被
 * 「選到最後一個字」那種邊界用到，位置剛好也是對的。
 */
function indexTextNodes(root) {
  const nodes = [], starts = [];
  let at = 0;
  const walk = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  for (let n = walk.nextNode(); n; n = walk.nextNode()) {
    nodes.push(n);
    starts.push(at);
    at += n.data.length;
  }
  return { nodes, starts, end: at };
}

/** 原文位移 → Range 要的 `{node, offset}`。換算本身在 mml-highlight.runAt（那半段可測）。 */
function nodeAt(tbl, i) {
  const { run, offset } = runAt(tbl.starts, tbl.end, i);
  return { node: tbl.nodes[run], offset };
}

/**
 * 把 selRanges 疊到上色層上。**不碰 DOM** —— 這正是它比烘進 HTML 快的地方。
 *
 * 畫 selRanges 而不是原生選取：多段選取時原生的只剩其中一段（見 selRanges）。
 */
function paintSelHighlight() {
  if (!HL_API) return;
  if (!hlNodes || !hlNodes.nodes.length || !selRanges.length) {
    CSS.highlights.delete(SEL_HL);
    return;
  }
  const h = new Highlight();
  for (const [a, b] of selRanges) {
    if (b <= a) continue;
    const s = nodeAt(hlNodes, a), e = nodeAt(hlNodes, b);
    const r = document.createRange();
    r.setStart(s.node, s.offset);
    r.setEnd(e.node, e.offset);
    h.add(r);
  }
  if (h.size) CSS.highlights.set(SEL_HL, h);
  else CSS.highlights.delete(SEL_HL);
}

/** 收掉選取。退回原生 textarea 的兩種情形都要叫，不然會留下一條畫在空層上的黃底。 */
function dropSelHighlight() {
  hlNodes = null;
  if (HL_API) CSS.highlights.delete(SEL_HL);
}

/** 這一軌有沒有在用上色層。太長就整軌退回原生 textarea（每打一個字都要重建上萬個節點）。 */
const overlayActive = ta => !!ta && ta.value.length <= MAX_HL_CHARS;

/**
 * 上色層竹的可用寬度要跟 textarea 的內容寬度一樣，不然軟換行會斷在不同的字。用 clientWidth：它不
 * 含 border 也不含捲軸，而「有沒有垂直捲軸」正是兩層寬度會差開的唯一原因。
 */
function syncOverlayWidth() {
  const ta = tracks.activeArea(), hl = tracks.activeOverlay();
  // 排版還沒發生時 clientWidth 是 0，設下去會讓上色層每個字都換行。留著不設，
  // 緊接著 ResizeObserver 的第一次回呼就會補上真正的值。
  if (!ta || !hl || ta.clientWidth <= 0) return;
  // **一樣的值就不要寫。** 這一支在播放中每響一個音就會走到（見 paintHighlight），而寫
  // style.width 會把整個文字區的排版弄髒 —— 下一個音的 select.reveal 就得付一次強制重排。
  const w = ta.clientWidth + "px";
  if (hl.style.width !== w) hl.style.width = w;
}

/**
 * 重畫當前那一軌的上色層。掛在 syncSelection() 的第一行，四條路徑一次罩住：打字、使用者選取、
 * 程式設定選取（播放高亮走這條）、換分頁。
 *
 * 同步畫不用 rAF：文字是透明的，晚一幀就等於剛打的字有一幀看不見。一次按鍵走到這裡兩次的代價
 * 用「HTML 沒變就不寫」擋掉。
 */
function paintHighlight() {
  const ta = tracks.activeArea(), hl = tracks.activeOverlay();
  if (!hl) return;
  const on = overlayActive(ta);
  // 一個 class 管三件事（見 CSS）：textarea 的文字要不要透明、::selection 要不要
  // 讓位、上色層要不要顯示。放在 body 上，只有當前那一軌看得到，狀態一定一致。
  document.body.classList.toggle("hl-off", !on);
  if (!on) { hl.textContent = ""; hlEl = null; dropSelHighlight(); return; }

  const src = ta.value;
  // hl !== hlEl 是換分頁：文字剛好一樣時 HTML 也一樣，但那是另一個空的元素。
  const fresh = src !== hlSrc || hl !== hlEl;
  if (fresh) { hlSrc = src; hlRoles = buildRoles(src, highlightOn); }

  if (HL_API) {
    // **文字層只跟文字有關。** 選取是另一層（見 HL_API 那段），所以打字以外的路徑
    // —— 拖曳選取、播放高亮每一個音 —— 一個節點都不用重建。
    if (fresh) {
      hl.innerHTML = renderHTML(src, hlRoles);
      hlEl = hl;
      hlNodes = indexTextNodes(hl);
    }
    paintSelHighlight();
  } else {
    // 退回原路：選取烘進 HTML。慢，但是有畫（見 HL_API）。
    const html = renderHTML(src, withSelection(hlRoles, selRanges));
    if (html !== hlHtml || hl !== hlEl) { hl.innerHTML = html; hlHtml = html; hlEl = hl; }
  }
  syncOverlayWidth();
  syncTextLayerScroll();
}

/**
 * 深色／淺色。
 *
 * **不必重載**：色票整組掛在 `<html data-theme>` 上，CSS 自己會跟。唯一要通知的是捲軸
 * 那片 canvas —— 它讀不到 CSS 變數，由 `theme.onChange` 叫它重讀色票再重畫一次
 * （登記在 `pianoroll.init` 裡）。
 *
 * 下拉的初值以 **DOM 為準**（`theme.current()`），不是再讀一次 localStorage：開機腳本
 * 已經把選擇套進去了，第二個來源只會製造「下拉寫著深色、畫面是淺色」這種不一致。
 */
function initTheme() {
  const sel = $("#theme");
  if (!sel) return;
  sel.value = theme.current();
  sel.addEventListener("change", () => theme.apply(sel.value));
}

function initHighlight() {
  const sel = $("#mmlHighlight");
  sel.value = highlightOn ? "on" : "off";
  sel.addEventListener("change", () => {
    highlightOn = sel.value === "on";
    storage.saveUI({ highlight: highlightOn });
    hlSrc = null;              // 角色要重算（顏色是在 buildRoles 裡決定的）
    paintHighlight();
  });
}

/**
 * 把每一軌的換行重排成目前設定，只記一步 undo。走 `reflow()` 而不是「重新產生一次」：唯讀軌也
 * 要能排（有 `r+` 這種筆誤的軌用產生器一輩子排不了版，而真實的 .mml 很容易帶），而且切設定不
 * 該改動音樂（重新產生會順手重新壓縮，平均 +56 字）。
 *
 * 代價：註解會被剝掉（reflow 必須先拿掉舊換行，而 `//` 是吃到行尾竹的）。
 */
function reformatAll() {
  const list = [];
  for (const [i, before] of tracks.trackTexts().entries()) {
    const out = reflow(before, barsPerLine);
    if (out === before) continue;
    list.push({ i, out, before });
  }
  if (!list.length) return;
  writeBackMany(list);
  refresh();
}

/** 開站時把預設樂譜排成目前設定。只有預設樂譜，接回的暫存原地不動。不記 undo。 */
function formatInitialTracks() {
  if (!barsPerLine || tracks.restoredAt()) return;
  for (const [i, before] of tracks.trackTexts().entries()) {
    // 走 reflow 而不是重新產生 —— 只搬空白，預設樂譜手寫的緊湊形式就留著
    // （重新產生會正規化成產生器的輸出，實測從 1020 字變 1033）。
    const out = reflow(before, barsPerLine);
    if (out !== before) tracks.setTrackText(i, out);
  }
}

/** 下拉自己的選項就是白名單 —— 清單只維護一份。 */
const barChoices = () => new Set([...$("#barsPerLine").options].map(o => Number(o.value)));

/**
 * 換一個換行設定。`reformat` 決定要不要順手把現有文字重排。
 *
 * @param {number} n 每幾小節一行；0 = 不換行
 * @param {boolean} reformat 使用者自己改設定時是 true；外面來的文字重置時是 false
 */
function setBarsPerLine(n, reformat) {
  if (!barChoices().has(n) || n === barsPerLine) return;
  barsPerLine = n;
  $("#barsPerLine").value = String(n);
  storage.saveUI({ barsPerLine });
  applyWrapMode();
  if (reformat) reformatAll();
  syncBarRuler();
}

/**
 * 外面來的文字整批取代了分頁（貼上、載入分享、匯入）—— 換行卜設定一律退回「不換行」。別人的譜有自
 * 己的排版，而這些路徑刻意不重排，一份單行的譜配上 `white-space:pre` 會變成一條很長的線。
 */
function onExternalText() {
  // 播放中換譜 → 先停。排程用的是舊的解析結果，讓它繼續跑就是拿新樂譜的畫面配舊樂譜的聲音。
  // 停而不是接著播新的：整批取代等於換了一首歌。而且 refresh() 在播放中會走另一條路（不畫
  // caret），所以要停在它前面。
  if (player.isPlaying()) {
    // 那份「按演奏前的選取」是**舊文字**的位移，還給新樂譜只會框到不相干的一段
    // （然後 selectionchange 會把捲軸上一堆莫名其妙的音符點亮）。先丟掉再停。
    selBeforePlay = null;
    player.stop();
  }
  setBarsPerLine(0, false);
  // 「這已經不是你上次存的那一份檔案了」—— 這一行是 Ctrl+S 的安全帶。這裡是三條整批取代路徑的
  // 交會點，而那三條都不會動到檔名欄；少了這一行，貼上別人的譜之後按 Ctrl+S 會不問就把它寫進使
  // 用者自己的存檔裡。見 savebox.detach。
  savebox.detach();
  refresh();
}

/**
 * 拍號的設定開關。三個東西要同步：下拉的值、捲軸要不要畫左上角那一格、以及 config 的拍號圖。
 *
 * 改開關要重排 MML 換行 —— 換行的落點是小節線，而小節線剛剛整批移動了。不重排的話「開了拍號，
 * 可是文字還照 4/4 斷行」看起來就是壞的。
 */
function initTimeSig() {
  const sel = $("#timeSig");
  if (!sel) return;
  sel.value = meters.isOn() ? "on" : "off";
  roll.setTimeSigUI(meters.isOn());

  // 變更處理器只管重畫。它女以前還會呼叫 `reflowForMeter()`，而那裡面是 `history.edit()` —— 於是
  // 一次 undo 進行中會往 undoStack 再推一步。重排與 undo 步由改動的那個呼叫端負責。
  // 要 persist：拍號與標記不經過 `tracks.setTrackText`，「只改拍號」時自動存檔不會被觸發。
  meters.setChangeHandler(() => {
    roll.setTimeSigUI(meters.isOn());
    tracks.persist();
    refresh();
  });

  // 開關本身是這台機器的偏好，不進快照 —— 復原會把文字排版退回去，但開關留在使用者
  // 最後選的狀態。它看得見、一鍵就改得回來。
  sel.addEventListener("change", () => withMeterEdit(() => meters.setOn(sel.value === "on")));
}

/** 小節線移動了 → 重排 MML 換行。走 `reflow` 只搬空白。undo 步由 `withMeterEdit` 統一包。 */
function reflowForMeter() {
  if (!barsPerLine) return;
  for (const [i, before] of tracks.trackTexts().entries()) {
    const out = reflow(before, barsPerLine);
    if (out !== before) tracks.setTrackText(i, out);
  }
}

/**
 * 一次拍號改動 = 一步 undo。拍號進快照，而小節線動了之後換行落點也跟著動 —— 分兩步的話按一次
 * Ctrl+Z 會得到「拍號回去了但文字還是新的斷行」。
 */
function withMeterEdit(fn) {
  history.edit(() => { fn(); reflowForMeter(); });
}

function initBarsPerLine() {
  const sel = $("#barsPerLine");
  // localStorage 裡竹的值可能是別的版本寫的，認不出來就當「不換行」
  const saved = Number(storage.loadUI()?.barsPerLine);
  barsPerLine = barChoices().has(saved) ? saved : 0;
  sel.value = String(barsPerLine);
  applyWrapMode();

  // 使用者自己改設定 → 立刻重排，不然「改了設定畫面沒反應」看起來就是壞的。
  // 包成一步 undo，反悔按 Ctrl+Z 就好。
  sel.addEventListener("change", () => setBarsPerLine(Number(sel.value), true));
}

/** 一個 class 管兩件事（見 CSS）：尺要不要出現、textarea 要不要軟換行。放在 body 上。 */
function applyWrapMode() {
  document.body.classList.toggle("wrapmml", barsPerLine > 0);
}

// ─── 壓縮模式 ───────────────────────────────────────────────────────────────
//
//  `finish` 永遠只吐照實版（見它的說明），壓縮是**包在寫回外面的一層**。這樣分工有兩個好處：
//  照實版同時是壓縮的輸入與壓不動時的退路，而 14 個 `finish` 呼叫點一個都不用改。
//
//  壓縮發生在 `setTrackText` **之前**，所以樂器列右邊的字數從頭到尾不會閃一下膨脹的數字。

/**
 * 寫回前的閘門：這一軌要不要壓、壓不壓得成。壓縮本身在 `mml-compress.zipOnce`（純函式，
 * 兩種早退的理由都寫在那裡）；這裡只做「這一軌記著要壓嗎」與「失敗了要說什麼」。
 *
 *  **每一種 `skip` 都不清旗標，也都不說話。** 非標準時值是等使用者按工具列的「還原」，而那
 * 一格本來就常駐、訊息長在解法旁邊；其餘幾種他做不了任何事，講一句只是打斷他。只有驗證沒過
 * 要退出模式並講一聲 —— 那不是打擾是求救。
 *
 * @returns {{out:string, drop?:boolean, msg?:string}}
 */
function zipFinal(i, plain) {
  if (!tracks.zipOf(i)) return { out: plain };
  const r = zipOnce(plain, genOpts());
  if (r.out) return { out: r.out };
  //  驗證沒過就退出模式。留著的話每一次編輯都會再撞一次同一個 bug、再唸一次同一句話。
  // 這一句**每次都講、而且帶軌號**：它跟那幾個「只講一次」的提醒不同類 —— 那些報告的是
  // 可預期的正常後果，這一句報告的是壓縮器差點寫壞使用者的音樂，而第二軌也中的話那是第
  // 二份可回報的樣本。
  if (r.bug) return { out: plain, drop: true,
    msg: i18n.t("ui.opt.zipVerifyFailed", { track: i18n.trackName(i) }) };
  return { out: plain };
}

/**
 * 寫回 textarea：記一步、順手壓縮、順手提醒註解消失與字數超標。
 *
 * `raw` = 這份文字已經是最終形態，不要再壓（只有「優化」自己會用 —— 它的輸出本來就是
 * 壓縮版，再壓一次是白工）。
 */
function writeBack(i, out, before, { raw = false } = {}) {
  const z = raw ? { out } : zipFinal(i, out);
  history.edit(() => {
    // setZip 排在 setTrackText **之前**：排後面的話那次 persist 寫進 localStorage 的
    // 還是舊的 zip（見 tracks.setZip 的說明）。
    if (z.drop) tracks.setZip(i, null);
    tracks.setTrackText(i, z.out);
  });
  warnAfterWrite(i, z.out, before);
  if (z.msg) say(z.msg);
  return true;
}

/**
 * 一次寫好幾軌但只記一步 undo。移調「全部音軌」要用它，不然一次移調要按六次 Ctrl+Z。
 *
 * `also` 是要跟這些文字**進同一步**的改動（插刪小節要搬的拍號與段落標記）。分成兩步的話按一次
 * Ctrl+Z 只會退回文字，而且 history 的 shadow 會停在半途 —— 接著打字再復原，那一半就永久留下
 * 來了。
 */
function writeBackMany(list, also = null) {
  //  壓縮**全部先算完再寫**。邊算邊寫的話，中途某一軌驗證失敗要退出模式時，前面幾軌已經
  // 進到這一步 undo 裡了。
  const zs = list.map(w => (w.raw ? { out: w.out } : zipFinal(w.i, w.out)));
  history.edit(() => {
    for (let k = 0; k < list.length; k++)
      if (zs[k].drop) tracks.setZip(list[k].i, null);
    for (let k = 0; k < list.length; k++) tracks.setTrackText(list[k].i, zs[k].out);
    also?.();
    //  `also` 可能只改了壓縮模式而沒動文字（優化框的 arm），而上面那幾次 setTrackText
    // 的 persist 已經帶著舊的 zip 排進佇列了。再排一次 —— storage 自己 debounce，免費。
    tracks.persist();
  });
  for (let k = 0; k < list.length; k++)
    warnAfterWrite(list[k].i, zs[k].out, list[k].before);
  for (const z of zs) if (z.msg) say(z.msg);
}

function warnAfterWrite(i, out, before) {
  //  「這一軌撐不住照實模式」延後到這裡才講 —— 壓縮模式的軌本來就要最省字的寫法，
  // 對它們那句話是噪音。旗標無論講不講都要清掉，不然會飄到下一軌頭上。
  const fellBack = pendingPlainFallback;
  pendingPlainFallback = false;
  if (fellBack && !warnedPlainFallback && !tracks.zipOf(i)) {
    warnedPlainFallback = true;
    say(i18n.t("ui.roll.plainFallback"));
  }

  // 重生戈成會把註解與手排的換行吃掉。第一次發生時講一聲，之後不再囉唆。
  // 不提「改成幾小節一行」—— 那由設定決定，寫死在訊息裡會過期。
  if (!warnedComments && /\/\*|\/\//.test(before)) {
    warnedComments = true;
    say(i18n.t("ui.roll.regenWarn"));
  }

  // 看不懂的字元（`r+` 這種筆誤）在重新產生時會被丟掉。對音樂零影響，但這是編輯
  // 真的改掉了原文的地方，不是排版，所以要講一聲。
  if (!warnedDropped && trackToItems(before).dropped > 0) {
    warnedDropped = true;
    say(i18n.t("ui.roll.droppedBadChars"));
  }

  // 不擋你超過（擋住的話「點一格結果沒反應」更難用），但要講一聲 —— 樂器列右邊的
  // 紅字很小，第一次跨過去容易沒注意到。
  if (!warnedTooLong && bareTrack(out).length > MAX_TRACK_CHARS) {
    warnedTooLong = true;
    say(i18n.t("ui.roll.overLimit", { max: MAX_TRACK_CHARS }));
  }
}

// ─── 鋼琴捲軸的右鍵選單 ─────────────────────────────────────────────────────
//
//  選單長什麼樣在 rollmenu.js（純呈現），右鍵手勢在 pianoroll（只回報「在哪裡按了右鍵」）。
//  內容全部在這裡 —— 那些列要看譜、看模式、看歷史，那三樣只有 ui 手上有。
//
//  兩個 scope 貫穿插入／刪除小節："track"（當前這一軌，它一定會讓其他軌錯開，那是刻意的）與
//  "song"（目前存在的所有分頁）。`"song"` 是全部軌而不是前 6 軌 —— 後面 9 軌跟正式軌一起播，
//  只推前 6 軌的話對照用的輔助軌會整片錯開一小節，而那要播放才聽得出來。
//
//  兩個 scope 十都用同一個 at 餵給每一軌，那是「同時響的東西還是同時響」的唯一條件。

/** tick 落在第幾小節（0 起算；尺上顯示的是 +1）。拍號圖說了算。 */
const barOf = tick => barIndexOf(tick);

/** 這個 scope 動到哪幾軌。 */
const scopeTracks = scope =>
  scope === "song"
    ? Array.from({ length: tracks.trackCount() }, (_, i) => i)
    : [tracks.activeTrack()];

/**
 * 這一軌在 `at` 之後還有東西要推嗎。
 *
 * 用 `lastNoteEnd` 而不是整軌長度 —— 後者含尾端休止符，會把一條只剩 `r` 尾巴的軌當成
 * 有內容，白白吃掉字數上限換到零效果。
 */
function trackBusyAfter(i, at) {
  const p = prepTrack(tracks.trackTexts()[i] ?? "");
  if (p.error) return false;
  return lastNoteEnd(p.items) > at;
}

/** scope 裡真的會被改到的那幾軌。全空 = 那一列該灰掉，而不是變成一顆按了沒反應的鈕。 */
const busyTracks = (scope, at) => scopeTracks(scope).filter(i => trackBusyAfter(i, at));

/** `at` 到 scope 裡最長那一軌的結尾還有幾小節 —— 刪除的數量上限。 */
function barsLeft(scope, at) {
  let end = 0;
  for (const i of scopeTracks(scope)) {
    const p = prepTrack(tracks.trackTexts()[i] ?? "");
    if (!p.error) end = Math.max(end, lastNoteEnd(p.items));
  }
  // 「還剩幾小節」= 兩個小節號的差 + 1，不是距離除以小節長 —— 中間可能變卜過拍。
  return end > at ? barIndexOf(end - 1) - barIndexOf(at) + 1 : 0;
}

/**
 * 插入／刪除小節。這是站上唯一會位移時間軸的編輯，語意全部在 rolledit 的
 * `insertTime` / `deleteTime`。
 *
 * 這裡只做四件事：挑軌、逐軌走「文字 → items → 純函式 → MML」、一次寫回、把釘在
 * 絕對 tick 上的東西搬到新的時間軸上。
 *
 * 一軌解析不了就整個放棄，不做一半 ——「六軌插了五軌」看起來成功了，而錯開的那一軌
 * 要等到播放時才聽得出來。
 */
function barEdit({ insert, scope, at, bars }) {
  // 這 n 個小節加起來多長。跨過變拍時每一節不一樣長，所以是查表相減而不是乘法。
  const len = barStartTick(barIndexOf(at) + bars) - at;
  const targets = busyTracks(scope, at);
  if (!targets.length || !(len > 0)) return;

  const texts = tracks.trackTexts();
  const writes = [];
  for (const i of targets) {
    const text = texts[i] ?? "";
    const p = prepTrack(text);
    if (p.error) { say(i18n.t("ui.roll.cantEdit", { why: p.error })); return; }

    const items = insert ? insertTime(p.items, at, len) : deleteTime(p.items, at, len);
    const out = finish(items, p.opts);
    if (out === null) { say(i18n.t("ui.roll.cantEncode")); return; }
    if (out === bareTrack(text)) continue;      // 真的沒改到，別記一步空的
    writes.push({ i, out, before: text });
  }
  if (!writes.length) return;

  // 釘在絕對 tick 上的東西要搬到新的時間軸上，不搬的話症狀全部是安靜的
  const delta = insert ? len : -len;

  // 動了 6 十軌也只記一步 undo —— 一軌一步的話一次插入要按六次 Ctrl+Z 才回得去。
  //
  // 拍號與段落標記**只有 `全部軌` 才跟著推**。它們釘在「整首曲子」的時間軸上，而只有全部軌
  // 一起位移時那條時間軸才真的動了。`本軌` 刻意讓其他軌錯開（見 README 的那一節），那時整首
  // 歌的小節線一格都沒動 —— 跟著推的話，使用者只修了一軌，別軌的變拍與路標卻被一起搬走，而
  // 那要播放才聽得出來。
  //
  // 這兩樣**進快照**，所以要跟文字擠進同一步 undo（見 writeBackMany 的 `also`）。
  writeBackMany(writes, scope !== "song" ? null : () => {
    // 變拍記號（曲首那一筆不動，見 meters.remap）。它一動小節線就跟著動，而上面那幾軌的換行
    // 落點是用**舊的**拍號圖排出來的 —— 不重排的話小節尺會從這裡開始整片對錯，看起來就像拍號
    // 沒被推走。同 withMeterEdit 的理由，只是這裡的 undo 步由 writeBackMany 包。
    if (meters.remap(at, delta)) reflowForMeter();
    marks.remap(at, delta);          // 段落標記（tick 0 那一筆**會**動，見 marks.remap）
  });

  roll.remapMarks(at, delta);        // 兩條演奏線（畫面狀態，不進快照）
  shiftPausedTick(at, delta);        // 暫停中的播放頭
  pickNote(null);                    // 選取清掉，見下面 selectSide 上方那段
}

/**
 * 暫停中的播放頭也釘在絕對 tick 上。`canEdit()` 允許暫停中編輯，所以這個情境一定會發生 —— 不搬
 * 的話按「繼續」會從別的音樂接下去。
 */
function shiftPausedTick(at, delta) {
  if (pausedTick === null) return;
  const next = delta > 0
    ? (pausedTick >= at ? pausedTick + delta : pausedTick)
    // 刪除：落在被刪區間裡就塌到接縫，區間之後的往前挪
    : (pausedTick >= at - delta ? pausedTick + delta : Math.min(pausedTick, at));
  if (next === pausedTick) return;
  pausedTick = next;
  roll.setGuideFloor(pausedTick);
}

/**
 * 卜選單的「前方／後方全選」：把 `at` 前面／後面的音符全部選起來。只能是當前這一軌 —— 選取的真相
 * 是「當前軌的一組字元範圍」，而那綁在一個 textarea 上。邊界用音頭判定，所以「前方 ∪ 後方 =
 * 全部、交集 = 空」。
 *
 * 範圍取「第一個音的起點 → 最後一個音的終點」而不是從 0 到全文結尾 —— 軌首的 `t180 v12 @1 l8
 * o5` 是這一軌的初始設定，圈進去之後一按 Delete 就把整軌的速度與樂器一起清掉了。
 */
function sideNotes(at, before) {
  const notes = song?.tracks[tracks.activeTrack()]?.notes ?? [];
  return notes.filter(n => before ? n.tick < at : n.tick >= at);
}

function selectSide(at, before) {
  const ta = tracks.activeArea();
  const track = song?.tracks[tracks.activeTrack()];
  const r = select.rangeOf(track, sideNotes(at, before));
  if (!ta || !r) return;
  setRange(ta, r[0], r[1], "roll");
}

// ─── 複製／剪下／貼上 ───────────────────────────────────────────────────────
//
// 語意全部在 rolledit（notesToItems / pasteItems，純函式所以測得到），這裡只做「文字 ↔ items」
// 與剪貼簿那兩段膠水。

/** 選單作用的那一組音：一律是選取，不是被右鍵的那一個（見下面那段長註解）。 */
const menuPicks = () => roll.selectedNotes();

/** 選取的那幾個音 → 一段獨立的 MML 片段。水沒有音就回空字串。 */
function pickedFragment() {
  const p = prepTrack(tracks.trackTexts()[tracks.activeTrack()] ?? "");
  if (p.error) return "";
  const vel = velocitiesOf(p.items);
  const notes = [];
  for (const pick of menuPicks()) {
    const found = findNote(p.items, pick.tick, pick.midi);
    if (found) notes.push({ tick: found.tick, dur: found.dur, midi: pick.midi,
                            vel: vel.get(found.tick) ?? 8 });
  }
  if (!notes.length) return "";
  // 照實模式：這是要被貼回編輯器（或別的 MML 工具）的片段，不是給遊戲的成品
  return genPlain(notesToItems(notes), p.opts) ?? "";
}

/** 複製到系統剪貼簿。寫不進去（權限、http）就退回手動複製框。 */
async function copyPicked() {
  const text = pickedFragment();
  if (!text) { say(i18n.t("ui.roll.copyNone")); return false; }
  try {
    await navigator.clipboard.writeText(text);
    say(i18n.t("ui.roll.copied", { n: menuPicks().length }));
  } catch {
    // 瀏覽器不給寫剪貼簿（權限、非 https）→ 退回讓使用者自己 Ctrl+C 的後備視窗
    clipboard.showForCopy(text);
  }
  return true;
}

/** 剪下 = 複製 + 刪除。複製失敗就不刪 —— 不然那段譜哪裡十都不存在了。 */
async function cutPicked() {
  const picks = menuPicks().map(p => ({ tick: p.tick, midi: p.midi }));
  if (!await copyPicked()) return;
  removeNotes(picks);
}

/**
 * 從剪貼簿貼到 `at`。不是 MML 的東西要擋下來：音名是 a–g、休止是 r、指令是 l/o/t/v/n，所以任何
 * 英文句子都會殘留出幾個假音符 —— 而貼上是取代。守衛是 `trackToItems` 的 `dropped`。
 */
function pasteAt(at, text, { internal = false } = {}) {
  const i = tracks.activeTrack();
  const target = tracks.trackTexts()[i] ?? "";
  const p = prepTrack(target);
  if (p.error) { say(i18n.t("ui.roll.cantEdit", { why: p.error })); return; }

  //  外面貼進來的片段**一個字都不動**（同 clipboard.importText / tracks 的文字區）。以前這裡
  // 會先跑一次還原，於是貼進捲軸的音跟他複製的那一份時值不同。內部複製的片段本來就是我們產生
  // 的，連數都不用數。
  if (!internal) {
    const n = nonstdCount(text);
    if (n) say(i18n.t("clip.nonstd", { n }));
  }
  const frag = trackToItems(text);
  if (frag.error) { say(i18n.t("ui.roll.pasteBad")); return; }
  if (frag.dropped > 0) { say(i18n.t("ui.roll.pasteJunk", { n: frag.dropped })); return; }

  const r = pasteItems(p.items, at, frag.items);
  if (r.block === "empty") { say(i18n.t("ui.roll.pasteEmpty")); return; }

  const out = genPlain(r.items, { ...p.opts,
    allowedNums: [...new Set([...(p.opts.allowedNums ?? []), ...frag.seenNums])],
  });
  if (out === null) { say(i18n.t("ui.roll.cantEncode")); return; }
  const pasted = [];
  let tick = at;
  for (const item of frag.items) {
    if (item.k === "note") pasted.push({ tick, midi: item.midi });
    if (item.k === "note" || item.k === "rest") tick += item.dur;
  }
  const end = at + lastNoteEnd(frag.items);
  const overwritten = (song?.tracks[i]?.notes ?? []).filter(n => n.tick < end && n.tick + n.durTick > at).length;
  writeBack(i, out, target);
  reselect(pasted);
  say(i18n.t("ui.roll.pasted", { n: countNotes(frag.items) })
    + " " + i18n.t("roll.duplicate.overwritten", { n: overwritten }));
  return true;
}

async function pasteFromMenu(at) {
  let text;
  try {
    text = await navigator.clipboard.readText();
  } catch {
    // Firefox 不給 readText —— 水沒有這條後備，那一列在 Firefox 上就是按了沒反應
    clipboard.promptPaste(v => pasteAt(at, v));
    return;
  }
  if (!text.trim()) { say(i18n.t("clip.empty")); return; }
  pasteAt(at, text);
}

/** 兩個選單共用的「貼上音符」那一列 —— 空白處用 markTick，音符上用那個音的起點。 */
function pasteRow(at, usable, blocked) {
  const { bar, beat } = barBeatOf(at);
  return {
    id: "paste",
    step: null,
    format: () => ({
      label: i18n.t("roll.note.paste"),
      // 不寫「會取代掉幾個音」：取代範圍是剪貼簿內容的長度，而按之前讀不到剪貼簿。
      // 事後那句 toast 才講得準。
      hint: i18n.t("roll.note.pasteAt", { bar, beat }),
      disabled: !usable,
      why: blocked,
    }),
    run: () => pasteFromMenu(at),
  };
}

/** 這段 items 裡有幾個音符。貼上之後的 toast 要報數字。 */
const countNotes = its => its.filter(it => it.k === "note").length;

/** tick → 第幾小節第幾拍（都是 1 起算，跟尺上顯示的一致）。 */
function barBeatOf(tick) {
  const bar = barIndexOf(tick);
  // 一拍 = 一個「分母音符」（4/4 → 四分音符 480、6/8 → 八分卜音符 240）。
  const beat = Math.floor((tick - barStartTick(bar)) / (PPQ * 4 / meterAt(tick).den));
  return { bar: bar + 1, beat: beat + 1 };
}

/**
 * 組出空白處那幾列。每次打開都重新算，而且 `format` 是每次改數字都會被重問一次的 —— 標題與灰字
 * 都吃那個數字。
 *
 * 數量每次打開重設回 1，四列各自獨立：黏著的數量是陷阱（為了某次編輯設成 8，一小時後回來按
 * 「刪除」以為是 1）。
 */
function openRollMenu({ x, y, markTick, pasteTick, barTick, canEdit, whyNot }) {
  const bar = barOf(barTick);
  const usable = canEdit && !!song;
  // 灰掉時要說原因。只是暗掉不說話的話，使用者唯一能做的事是猜。
  const blocked = whyNot || i18n.t("roll.menu.playing");

  const barRow = (insert, scope) => {
    const left = barsLeft(scope, barTick);
    const idle = !busyTracks(scope, barTick).length;
    return {
      id: `${insert ? "ins" : "del"}-${scope}`,
      danger: !insert,
      // 插入沒有內容上限（1–16）；刪除收窄到「這裡到最長那一軌的結尾還剩幾小節」，
      // 標題才不會山出現「刪除第 90–97 小節」而實際上只有 90–91 存在。
      step: { value: 1, min: 1, max: insert ? 16 : Math.max(1, Math.min(16, left)) },
      format: n => ({
        label: insert
          ? i18n.t(scope === "song" ? "roll.menu.insertSong" : "roll.menu.insertTrack", { n })
          : i18n.t(scope === "song" ? "roll.menu.deleteSong" : "roll.menu.deleteTrack", { n }),
        hint: insert ? i18n.t("roll.menu.insertAt", { bar: bar + 1 })
          : n === 1 ? i18n.t("roll.menu.deleteOne", { bar: bar + 1 })
            : i18n.t("roll.menu.deleteRange", { from: bar + 1, to: bar + n }),
        disabled: !usable || idle,
        why: usable ? i18n.t("roll.menu.idle") : blocked,
      }),
      run: n => barEdit({ insert, scope, at: barTick, bars: n }),
    };
  };

  const sideRow = before => {
    const n = sideNotes(barTick, before).length;
    return {
      id: before ? "sel-before" : "sel-after",
      step: null,
      format: () => ({
        label: i18n.t(before ? "roll.menu.selectBefore" : "roll.menu.selectAfter"),
        hint: i18n.t("roll.menu.selectCount", { n }),
        disabled: !n,
        why: i18n.t("roll.menu.selectNone"),
      }),
      run: () => selectSide(barTick, before),
    };
  };

  rollmenu.open({
    x, y,
    title: i18n.t("roll.menu.title", { bar: bar + 1 }),
    a11y: {
      menu: i18n.t("roll.menu.aria"),
      dec: i18n.t("roll.menu.less"),
      inc: i18n.t("roll.menu.more"),
    },
    rows: [
      // 前兩項月用 markTick（32 分格）而不是 barTick —— 線是連續的位置，小節是離散的
      // 單位。把線吸到小節線上會讓「聽這一句到這裡」變成做不到的事。
      {
        id: "play-start", step: null,
        format: () => ({ label: i18n.t("roll.menu.playStart") }),
        run: () => roll.setPlayStart(markTick),
      },
      {
        id: "play-end", step: null,
        format: () => ({ label: i18n.t("roll.menu.playEnd") }),
        run: () => roll.setPlayEnd(markTick),
      },
      // 段落標記併進這一組，不多開一條分隔線：三者都是「在你右鍵的這個位置釘一個
      // 東西」。這個選單已經有 11 列 4 條分隔線，而 rollmenu 承諾過「最壞壓在 271px
      // 上下」—— 多一條分隔線就是多 9px。
      markAddRow(barTick, barOf(barTick)),
      null,
      sideRow(true),
      sideRow(false),
      null,
      // 貼上自成一組：它跟上下兩組都不是同一類事（上面是選取、下面是時間軸位移），
      // 而且是這個選單裡唯一會動到音符內容的一項。
      //
      // 落點用 `pasteTick` 而**不是** `markTick`：那一份夾到曲末（為了保護演奏線，見
      // pianoroll 的 markTickAt），於是在最後一個音右邊右鍵時它一律等於譜尾，貼上就變成
      // 「接在後面」。貼到曲末之後是合理的動作，底層會先補休止走到位。
      // `??` 是給還沒送這個欄位的呼叫端的後備 —— 少了它會變成貼在 tick 0。
      pasteRow(pasteTick ?? markTick, usable, blocked),
      null,
      barRow(true, "track"),
      barRow(true, "song"),
      null,
      barRow(false, "track"),
      barRow(false, "song"),
    ],
  });
}

// ─── 拍號的右鍵選單（左上角那一格） ─────────────────────────────────────────
//
//  兩列：改拍號（兩個耦合的 spinner）與修改曲速。曲速直接開既有的 `#tempoBox` —— 那個框已經有數
//  字輸入、滑桿、節拍器試聽與切段警告，而多一個輸入框會跟 rollmenu 的鍵盤模型打架。

/** 使用者能設的分子與分母。匯入帶進來的值不受這兩份清單限制（見 config.cleanMeters）。 */
const METER_NUMS = [2, 3, 4, 6, 9];
const METER_DENS = [2, 4, 8];

/**
 * 一小節的長度要落在 `3/8`（720）到 `4/2`（3840）之間。兩端各有一個具體的壞處：更短的（`2/8`）
 * 在最小格寬時整個小節只有 32px 而拍號標籤約 20px，標籤會把小節線整條蓋掉；更長的（`9/2`）在
 * 最大格寬時一小節 4608px，尺上兩個小節號之間會是一片空白。
 *
 * 擋在輸入端不擋在資料端：匯進來的 `5/8` 照存照畫，只是 spinner 選不到 —— 硬轉成 4/4 會讓整首歌
 * 的小節線錯位。
 */
const METER_MIN = 720, METER_MAX = 3840;
const meterOk = (num, den) => {
  const t = meterTicks({ num, den });
  return t >= METER_MIN && t <= METER_MAX;
};

/**
 * 曲首拍號的選單。分母是主的、分子跟著被夾 —— 兩邊都過濾的話會有死路：`9/8` 時沒有任何一個分母
 * 能讓 9 合法，於是那一顆整個轉不動而使用者看不山出為什麼。
 */
function openMeterMenu({ x, y }) {
  const head = meters.stored()[0];
  // 選單自己的一份，按下「改成 x/y」才寫回去 —— 轉 spinner 的過程中不該一直重畫譜。
  const cur = { num: head.num, den: head.den };
  const now = () => meterName(cur);

  rollmenu.open({
    x, y,
    title: i18n.t("meter.menu.title"),
    a11y: {
      menu: i18n.t("meter.menu.aria"),
      dec: i18n.t("meter.menu.less"),
      inc: i18n.t("meter.menu.more"),
    },
    rows: [
      {
        id: "meter-num",
        step: { value: cur.num, values: () => METER_NUMS.filter(n => meterOk(n, cur.den)) },
        onChange: v => { cur.num = v; },
        format: () => ({
          label: i18n.t("meter.menu.apply", { meter: now() }),
          hint: i18n.t("meter.menu.beats"),
          disabled: cur.num === head.num && cur.den === head.den,
          why: i18n.t("meter.menu.same", { meter: now() }),
        }),
        run: () => applyHeadMeter(cur),
      },
      {
        id: "meter-den",
        step: { value: cur.den, values: METER_DENS },
        onChange: v => { cur.den = v; },
        format: () => ({
          label: i18n.t("meter.menu.apply", { meter: now() }),
          hint: i18n.t("meter.menu.unit"),
          disabled: cur.num === head.num && cur.den === head.den,
          why: i18n.t("meter.menu.same", { meter: now() }),
        }),
        run: () => applyHeadMeter(cur),
      },
      null,
      {
        id: "meter-tempo", step: null,
        format: () => ({
          label: i18n.t("meter.menu.tempo"),
          hint: i18n.t("meter.menu.tempoHint", { bpm: bpmAt(0) }),
        }),
        run: () => { tempoWhere = "head"; openTempo(); },
      },
    ],
  });
}

/** 換掉曲首拍號。**只動第一筆**，後面竹的變拍記號原封不動。 */
function applyHeadMeter({ num, den }) {
  const rest = meters.stored().slice(1);
  let ok = false;
  withMeterEdit(() => { ok = meters.set([{ tick: 0, num, den }, ...rest]); });
  if (ok) say(i18n.t("meter.menu.applied", { meter: meterName({ num, den }) }));
}

// ─── 小節尺的右鍵選單 ───────────────────────────────────────────────────────
//
//  五項：兩條演奏線、清空範圍、變拍、力度。取代的是「尺上右鍵 = 直接設結束線」，那一手從一下變
//  成兩下 —— 是退步而且是知道的。換到的是另外四件在尺上原本沒有入口的事，其中兩件在觸控裝置上
//  原本根本做不到。
//
//  前三項與力度用 `markTick`（32 分格，連續人位置）；變拍用 `barTick`（對齊小節線）—— 落在小節中間
//  的變拍會把前一小節截短。

function openBarMenu({ x, y, markTick, barTick, bar, canEdit, whyNot }) {
  const usable = canEdit && !!song;
  const blocked = whyNot || i18n.t("roll.menu.playing");
  const hasRange = roll.playRange().fromTick !== null || roll.playRange().toTick !== null;

  // 這一小節正好有變拍記號嗎（tick 0 不算 —— 那是曲首拍號，不是變拍）。
  const here = meters.stored().find(m => m.tick === barTick && m.tick > 0) ?? null;
  const cur = meterAt(barTick);
  const pick = { num: here?.num ?? cur.num, den: here?.den ?? cur.den };

  // 變拍那一列的三種灰掉理由，各說各的 —— 只是暗掉不說話的話使月用者只能猜。
  const meterWhy =
    !meters.isOn() ? i18n.t("bar.menu.meterOff")
      : barTick === 0 ? i18n.t("bar.menu.meterHead")
        : "";

  rollmenu.open({
    x, y,
    title: i18n.t("bar.menu.title", { bar: bar + 1 }),
    a11y: {
      menu: i18n.t("bar.menu.aria"),
      dec: i18n.t("roll.menu.less"),
      inc: i18n.t("roll.menu.more"),
    },
    rows: [
      {
        id: "play-start", step: null,
        format: () => ({ label: i18n.t("roll.menu.playStart") }),
        run: () => roll.setPlayStart(markTick),
      },
      {
        id: "play-end", step: null,
        format: () => ({ label: i18n.t("roll.menu.playEnd") }),
        run: () => roll.setPlayEnd(markTick),
      },
      {
        id: "play-clear", step: null,
        format: () => ({
          label: i18n.t("bar.menu.clear"),
          hint: i18n.t("bar.menu.clearHint"),
          disabled: !hasRange,
          why: i18n.t("bar.menu.clearNone"),
        }),
        run: () => roll.clearPlayRange(),
      },
      null,
      // 變拍。分母是主的、分子跟著被夾，同曲首那個卜選單（見 openMeterMenu）。
      {
        id: "bar-meter-num",
        step: { value: pick.num, values: () => METER_NUMS.filter(n => meterOk(n, pick.den)) },
        onChange: v => { pick.num = v; },
        format: () => ({
          label: i18n.t("bar.menu.meter", { meter: meterName(pick) }),
          hint: i18n.t("bar.menu.meterHint"),
          disabled: !!meterWhy,
          why: meterWhy,
        }),
        run: () => applyBarMeter(barTick, bar, pick),
      },
      {
        id: "bar-meter-den",
        step: { value: pick.den, values: METER_DENS },
        onChange: v => { pick.den = v; },
        format: () => ({
          label: i18n.t("bar.menu.meter", { meter: meterName(pick) }),
          hint: i18n.t("bar.menu.meterHint"),
          disabled: !!meterWhy,
          why: meterWhy,
        }),
        run: () => applyBarMeter(barTick, bar, pick),
      },
      {
        id: "bar-meter-del", danger: true, step: null,
        format: () => ({
          // 只有這一小節正好有記號時才能按 —— 同 #tempoBox 的「刪除這人個記號」。
          label: i18n.t("bar.menu.meterRemove"),
          hint: here ? i18n.t("bar.menu.meterRemoveHint", { meter: meterName(meterBefore(barTick)) }) : "",
          disabled: !!meterWhy || !here,
          why: meterWhy || i18n.t("bar.menu.meterRemoveHint", { meter: meterName(cur) }),
        }),
        run: () => removeBarMeter(barTick, bar),
      },
      null,
      {
        // 力度。這一軌從這裡開始 —— 跟音符選單那個「改選取的力度」長得像但不是同一
        // 件事（`v` 是軌內狀態，見 rolledit.placeVelocity）。
        id: "bar-velocity",
        step: { value: velAt(markTick), min: 0, max: 15 },
        format: () => ({
          label: i18n.t("bar.menu.velocity"),
          hint: i18n.t("bar.menu.velocityHint", { track: tracks.activeTrack() + 1 }),
          disabled: !usable,
          why: blocked,
        }),
        run: v => addVelocityAt(markTick, bar, v),
      },
      markAddRow(barTick, bar),
    ],
  });
}

/** `tick` **之前**生效的拍號（移除這個變拍之後會接回去的那個）。 */
const meterBefore = tick => {
  const before = meters.stored().filter(m => m.tick < tick);
  return before.length ? before[before.length - 1] : meters.stored()[0];
};

/** 這一軌在這個 tick 生效的力度。spinner 竹的初值 —— 從現況開始調才不會跳。 */
function velAt(tick) {
  const evs = velChanges(song?.tracks?.[tracks.activeTrack()]?.vels);
  let v = 8;                       // 解析器的預設
  for (const e of evs) { if (e.tick > tick) break; v = e.v; }
  return v;
}

/** 加／改一個變拍記號。 */
function applyBarMeter(tick, bar, { num, den }) {
  if (tick <= 0) return;
  const rest = meters.stored().filter(m => m.tick !== tick);
  let ok = false;
  withMeterEdit(() => { ok = meters.set([...rest, { tick, num, den }]); });
  if (ok) say(i18n.t("bar.menu.meterDone", { bar: bar + 1, meter: meterName({ num, den }) }));
}

/** 移除一個變拍記號。**曲首那一筆移不掉** —— 移掉就沒有曲首拍號了。 */
function removeBarMeter(tick, bar) {
  if (tick <= 0) return;
  let ok = false;
  withMeterEdit(() => { ok = meters.set(meters.stored().filter(m => m.tick !== tick)); });
  if (ok) say(i18n.t("bar.menu.meterGone", { bar: bar + 1 }));
}

/** 在這個 tick 插一個裸的 `v`（當前十軌）。 */
function addVelocityAt(tick, bar, v) {
  const i = tracks.activeTrack();
  const text = tracks.trackTexts()[i] ?? "";
  const p = prepTrack(text);
  if (p.error) { say(i18n.t("ui.roll.cantEdit", { why: p.error })); return; }

  const out = finish(placeVelocity(p.items, tick, v), p.opts);
  if (out === null) { say(i18n.t("ui.roll.cantEncode")); return; }
  writeBack(i, out, text);
  say(i18n.t("bar.menu.velocityDone", { track: i + 1, bar: bar + 1, v }));
}

// ─── 段落標記的色點：疊在原生水平捲軸上 ─────────────────────────────────────
//
//  這裡曾經是一條自訂的總覽尺。換回原生捲軸是因為它穩定得多，而自製的那條丟掉了鍵盤、中鍵與各平
//  台自己的手感。好處還有一個：色點浮在捲軸上，一個像素的版面高度都不吃。

//  **色點跟膠囊走同一組分工**（見下面那一節的 paintMarks／layoutMarks）：
//
//    paintDots()   重建節點。只有標記變了才做。
//    layoutDots()  只動位置。每一幀都做。
//
//  這裡以前是合成一支的：每一幀 `textContent = ""` 再把 16 個節點連同 16 個 click listener
//  重新建一次。**那是播放中最貴的一件事之一** —— 導播線每一幀都會叫到它（roll.draw → onView），
//  60fps × 16 個節點 = 每秒建掉又建回將近一千個節點，而它們的位置**根本沒變**：`viewX` 是內容
//  座標、`markDotX` 是純函式，兩者都跟捲動無關，只有縮放與曲長會動到。

/** 重建色點。標記變了才叫（跟膠囊同一個時機）。 */
function paintDots() {
  const box = $("#markdots");
  if (!box) return;
  box.textContent = "";

  marks.stored().forEach((m, i) => {
    const dot = document.createElement("div");
    dot.className = "dot";
    // 位置在 layoutDots 裡設。tick 記在節點上而不是靠索引對回 marks.stored() ——
    // 兩份順序要一直對得上是一條沒有人在守的不變式，而記在節點上就不可能歪。
    dot.dataset.tick = String(m.tick);
    dot.style.background = markColor(i);
    dot.title = i18n.t("mark.menu.title", { bar: barOf(m.tick) + 1, text: m.text });
    dot.addEventListener("click", () => roll.jumpTo(m.tick));
    box.appendChild(dot);
  });
  layoutDots();
}

/** 只動位置。每一幀都叫，所以只碰 style，而且**值一樣就不寫**。 */
function layoutDots() {
  const box = $("#markdots");
  if (!box || !box.children.length) return;

  const track = $("#stage").clientWidth;
  // 捲軸的軌道對應的是 `scrollWidth`，而 `#rollpad` 是「左側鍵盤 + 內容」寬。
  const scrollW = GUTTER_W + roll.viewWidth();

  for (const dot of box.children) {
    const left = `${markDotX(roll.viewX(+dot.dataset.tick), scrollW, track)}px`;
    // 寫下去會弄髒排版，而下一幀（以及播放高亮那條路）就得付一次強制重排。
    if (dot.style.left !== left) dot.style.left = left;
  }
}

/**
 * 「加入段落木標記」那一列，兩個選單共用同一份（小節尺的右鍵、捲軸空白處的右鍵）—— 那兩處的灰掉
 * 條件與 why 必須一模一樣。
 *
 * 只有「加入」，修改與移除在膠囊上右鍵（見 openPillMenu）—— 而使用者是靠這一列灰掉時那句 why 才
 * 知道膠囊可以按。落點用 `barTick` 而不是 `markTick`：段落標記在音樂上就是小節的東西。
 */
const markAddRow = (barTick, bar) => ({
  id: "mark-add", step: null,
  format: () => ({
    label: i18n.t("mark.menu.add"),
    hint: i18n.t("mark.menu.addHint", { bar: bar + 1 }),
    disabled: !!marks.at(barTick) || marks.isFull(),
    why: marks.at(barTick)
      ? i18n.t("mark.menu.exists")
      : i18n.t("mark.menu.full", { n: MAX_MARKS }),
  }),
  run: () => openMarkBox(barTick, ""),
});

// ─── 段落標記：膠囊 ─────────────────────────────────────────────────────────
//
//  膠囊是 DOM，不是畫在 canvas 上 —— 理由同 `rollmenu.js`：會互動的東西用 DOM。hover 浮起、左鍵
//  跳轉、右鍵選單、文字截斷在 DOM 上全部免費，在 canvas 上是四份自己寫的命中判定。最多 16 個節
//  點。分層照原型：`#flagsLayer` 穿透、膠囊自己 `auto`，`#flagsStrip` 月用 transform 平移。
//
//    paintMarks()   重建節點。只有標記變了才做。
//    layoutMarks()  只動位置。每一幀都做。
//
//  合成一個的話，拖曳捲動時每一幀都在建 16 個 DOM 節點。

/** 重建膠囊。標記變了才叫。 */
function paintMarks() {
  const strip = $("#flagsStrip");
  if (!strip) return;
  strip.textContent = "";

  marks.stored().forEach((m, i) => {
    const el = document.createElement("button");
    el.type = "button";
    el.className = "pill";
    el.dataset.tick = String(m.tick);
    el.textContent = m.text;
    el.style.background = markColor(i);
    el.title = i18n.t("mark.menu.title", { bar: barOf(m.tick) + 1, text: m.text });

    // 左鍵跳轉。不是 pointerdown —— 那會讓「右鍵開選單」也先跳一次。
    el.addEventListener("click", () => roll.jumpTo(m.tick));
    el.addEventListener("contextmenu", e => {
      e.preventDefault();
      openPillMenu(e.clientX, e.clientY, m.tick);
    });
    strip.appendChild(el);
  });
  // 譜面上的對齊線常駐（不再是 hover 才出現），所以跟膠囊同一份資料、同一個時機推。
  roll.setMarkLines(marks.stored().map((m, i) => ({ tick: m.tick, color: markColor(i) })));
  paintDots();     // 色點跟膠囊同一份資料，就該同一個時機重建（見 paintDots）
  layoutMarks();
}

/**
 * 只動位置。每一幀都叫，所以只碰 style，不碰結構 —— 而且**值一樣就不寫**。
 *
 * 那條「不寫」的規矩是效能上的必要條件：這一支在導播線跑的時候是每一幀都走一次
 * （roll.draw → onView），而寫任何一個 style 都會把排版弄髒，於是同一幀稍後的每一次量測
 * （`select.reveal`、`syncOverlayWidth`、下一幀的 `clientWidth`）都得付一次強制重排。
 *
 * 而這裡**幾乎每一幀都寫一樣的值**：膠囊的 x 是內容座標（`viewX`），只有縮放與曲長會動到
 * 它；跟著捲動走的只有 strip 那一個 transform。
 */
function layoutMarks() {
  const strip = $("#flagsStrip");
  if (!strip) return;
  syncFlagBounds();
  layoutDots();
  const tf = `translateX(${-roll.viewScrollX()}px)`;
  if (strip.style.transform !== tf) strip.style.transform = tf;

  const pills = strip.children;
  if (!pills.length) return;

  const xs = marks.stored().map(m => roll.viewX(m.tick));
  // 寬度的規則在 config.markPillWidths —— 放在那裡是為了能在 node 裡測。
  const widths = markPillWidths(xs);
  for (let i = 0; i < pills.length; i++) {
    const left = `${xs[i]}px`, max = `${widths[i]}px`;
    if (pills[i].style.left !== left) pills[i].style.left = left;
    if (pills[i].style.maxWidth !== max) pills[i].style.maxWidth = max;
    // 連字都放不下就只剩色塊，連 padding 都收掉（見 CSS 的 .pill.tab）
    pills[i].classList.toggle("tab", isPillTab(widths[i]));
  }
}

/** 膠囊的右鍵選單：修改文字、移除。這是這兩件事唯一竹的入口（小節尺那邊只有「加入」）。 */
function openPillMenu(x, y, tick) {
  const m = marks.at(tick);
  if (!m) return;
  rollmenu.open({
    x, y,
    title: i18n.t("mark.menu.title", { bar: barOf(tick) + 1, text: m.text }),
    a11y: { menu: i18n.t("mark.menu.aria") },
    rows: [
      {
        id: "mark-edit", step: null,
        format: () => ({ label: i18n.t("mark.menu.edit") }),
        run: () => openMarkBox(tick, m.text),
      },
      {
        id: "mark-del", danger: true, step: null,
        format: () => ({ label: i18n.t("mark.menu.remove") }),
        run: () => {
          const bar = barOf(tick) + 1;
          history.edit(() => marks.remove(tick));
          say(i18n.t("mark.removed", { bar }));
        },
      },
    ],
  });
}

// ─── 段落標記：輸入框 ───────────────────────────────────────────────────────

let markTick = 0;         // 這次在編哪一個
let markWasThere = false; // 加入還是修改（決定標題與訊息）

/** 開輸入框。超過就擋住輸入而不是事後報錯 —— 20 個顯示寬度不是使用者算得出來的東西。 */
function openMarkBox(tick, text) {
  markTick = tick;
  markWasThere = !!marks.at(tick);
  $("#markTitle").textContent = i18n.t(markWasThere ? "mark.box.editTitle" : "mark.box.addTitle");
  $("#markWhat").textContent = i18n.t("mark.box.at", { bar: barOf(tick) + 1 });
  const input = $("#markText");
  input.value = text ?? "";
  syncMarkLeft();
  $("#markBox").classList.add("on");
  input.focus();
  input.select();
}

const closeMarkBox = () => $("#markBox").classList.remove("on");

/** 剩餘寬度。超卜過就把輸入夾回去 —— 擋在這裡，使用者永遠打不出超長的字串。 */
function syncMarkLeft() {
  const input = $("#markText");
  const cut = clampMarkText(input.value);
  // 只在真的被夾到時才寫回去：每次 input 都無條件賦值會把游標推到尾巴，使用者就
  // 沒辦法在字串中間插字了。
  if (cut !== input.value && textWidth(input.value) > MARK_WIDTH) input.value = cut;
  const left = MARK_WIDTH - textWidth(input.value);
  const el = $("#markLeft");
  el.textContent = i18n.t("mark.box.left", { n: left });
  el.classList.toggle("over", left <= 0);
}

/** 確定。空字串 = 取消（空膠囊沒有意義）。 */
function confirmMarkBox() {
  const text = clampMarkText($("#markText").value);
  closeMarkBox();
  if (!text) return;
  const bar = barOf(markTick) + 1;
  let ok = false;
  history.edit(() => { ok = marks.put(markTick, text); });
  if (!ok) return;
  say(i18n.t(markWasThere ? "mark.edited" : "mark.added", { bar, text }));
}

/** 上次寫進去的那兩個值。**是快取，不是狀態** —— 只有這一支寫得到那兩個自訂屬性。 */
let flagGut = null, flagBar = null;

/**
 * 膠囊層竹的邊界。兩個值都量出來：`--gut`（左側鍵盤的寬，膠囊要被它裁掉）與 `--hbar`（水平捲軸吃
 * 掉的高度，各平台不同，macOS 的 overlay scrollbar 是 0）。
 *
 * **兩個都是「變了才寫」。** `layoutMarks` 每一幀都會叫到這裡，而寫一個自訂屬性會讓
 * `#rollwrap` 整個子樹的樣式失效 —— 代價是同一幀稍後的每一次量測都得重算樣式與排版
 * （見 layoutMarks 的說明）。而這兩個值一年也動不了幾次：`--gut` 是常數（GUTTER_W），
 * `--hbar` 只在水平捲軸出現／消失時變。
 */

function syncFlagBounds() {
  const wrap = $("#rollwrap"), stage = $("#stage");
  if (!wrap || !stage) return;
  if (flagGut !== GUTTER_W) { wrap.style.setProperty("--gut", `${GUTTER_W}px`); flagGut = GUTTER_W; }
  // 量它而不是寫死 15px —— 各平台不同，macOS 的 overlay scrollbar 是 0。兩個地方吃
  // 這個值：色點浮層的高度，以及膠囊的下緣。量到 0 時退回 8px，不然色點會沒有高度
  // 整個消失。
  const bar = Math.max(8, stage.offsetHeight - stage.clientHeight);
  if (flagBar !== bar) { wrap.style.setProperty("--hbar", `${bar}px`); flagBar = bar; }
}

function initMarkBox() {
  const box = $("#markBox");
  if (!box) return;
  $("#markText").addEventListener("input", syncMarkLeft);
  $("#markText").addEventListener("keydown", e => {
    if (e.key === "Enter") { e.preventDefault(); confirmMarkBox(); }
  });
  $("#markOk").addEventListener("click", confirmMarkBox);
  $("#markCancel").addEventListener("click", closeMarkBox);
  box.addEventListener("click", e => { if (e.target === box) closeMarkBox(); });

  // 標記的變更處理器掛在這裡而不是 initTimeSig：那人個函式在找不到拍號的下拉時會提早
  // return，掛在那裡等於讓標記的重畫依賴一個無關的元素存在。
  marks.setChangeHandler(() => {
    tracks.persist();
    paintMarks();
  });

  // 主動畫一次：`tracks.init()` 接回暫存的標記時這個處理器還沒裝上，所以沒有人畫過
  // 它們。少了這一行，重新整理之後標記在資料裡但畫面上一個都沒有。
  paintMarks();
}

// ─── 音符的右鍵選單 ─────────────────────────────────────────────────────────
//
//  跟上面那個共用 rollmenu 的呈現層，但每一列都不一樣：那個管時間軸，這個管音符本身。
//
//  貫穿這一整節的一條規則：作用對象永遠是「選取」。八列裡有六列作用在一組音上，而那一組一律是
//  `roll.selectedNotes()` 不是被右鍵的那一個音 —— 單選只是「選取剛好只有一個」，所以單選與多選共
//  用同一份實作。被右鍵的那個音只在需要單一錨點的地方用得到（力度的初值、前方／後方的切點）。

/**
 * 組出音符選單的八列。每次打開都重新算 —— 能不能按、力度多少都跟當下的選取與譜有關。
 *
 * @param {{tick:number, midi:number, dur:number}} note 被右鍵的那一個音（單一錨點用）
 */
function openNoteMenu({ x, y, note, canEdit, whyNot }) {
  const picks = menuPicks();
  const n = picks.length;
  const usable = canEdit && !!song;
  const blocked = whyNot || i18n.t("roll.menu.playing");

  // 兩條演奏線用整個選取的跨度：用被右鍵那個音的話，選了 3 個音卻只框住中日間一個。
  const p = prepTrack(tracks.trackTexts()[tracks.activeTrack()] ?? "");
  const items = p.items ?? [];
  const spans = picks.map(q => findNote(items, q.tick, q.midi)).filter(Boolean);
  const from = spans.length ? Math.min(...spans.map(s => s.tick)) : note.tick;
  const to = spans.length ? Math.max(...spans.map(s => s.tick + s.dur)) : note.tick + note.dur;

  // 前方／後方要的是一個切點，所以用被右鍵的那個音。沿用空白處選單的邊界規則
  // （音頭判定、後方含錨點自己），「前方 ∪ 後方 = 全部、交集 = 空」在這裡也成立。
  const sideRow = before => {
    const k = sideNotes(note.tick, before).length;
    return {
      id: before ? "sel-before" : "sel-after",
      step: null,
      format: () => ({
        label: i18n.t(before ? "roll.menu.selectBefore" : "roll.menu.selectAfter"),
        hint: i18n.t("roll.menu.selectCount", { n: k }),
        disabled: !k,
        why: i18n.t("roll.menu.selectNone"),
      }),
      run: () => selectSide(note.tick, before),
    };
  };

  const dotCalc = dotNotes(items, new Set(picks.map(p => noteKey(p.tick, p.midi))));
  const vel = velocityStats(items, new Set(picks.map(q => q.tick)));
  const now = velocitiesOf(items).get(note.tick) ?? 8;

  rollmenu.open({
    x, y,
    title: i18n.t("roll.note.title", { bar: barBeatOf(note.tick).bar, n }),
    a11y: {
      menu: i18n.t("roll.note.aria"),
      dec: i18n.t("roll.note.less"),
      inc: i18n.t("roll.note.more"),
    },
    rows: [
      {
        id: "play-start", step: null,
        format: () => ({ label: i18n.t("roll.note.playStart") }),
        run: () => roll.setPlayStart(from),
      },
      {
        id: "play-end", step: null,
        format: () => ({ label: i18n.t("roll.note.playEnd") }),
        run: () => roll.setPlayEnd(to),
      },
      null,
      sideRow(true),
      sideRow(false),
      null,
      {
        id: "dot", step: null,
        format: () => ({
          // `dotted` 是「**按下去會發生什麼**」，不是「現在是什麼」。只有算得出結果的那一
          // 種（有 `items`）才有方向；`bad`／`blocked` 沒有算，那時一律講「加上」——
          // 那是使用者想做的事，而按下去會得到一句解釋為什麼不行。
          label: i18n.t(dotCalc.items && !dotCalc.dotted
            ? "roll.note.dotRemove" : "roll.note.dotAdd"),
          // 數字用 `dotCalc.n`（**真的會變的那幾個**）而不是選取數 —— 一組裡已經有附點的
          // 那些在「加上」時原地不動，把它們算進去是虛報。
          hint: dotCalc.items
            ? i18n.t("roll.note.dotHint", { n: dotCalc.n })
            : i18n.t("roll.note.dotBad"),
          disabled: !usable,
          why: blocked,
        }),
        run: applyDot,
      },
      {
        // 力度。初人值取被右鍵那個音的現值 —— 選取裡本來就深淺不一時，「從我點的這個
        // 開始調」是唯一講得清楚的起點。灰字報整組的範圍。
        id: "velocity",
        step: { value: now, min: 0, max: 15 },
        format: v => ({
          label: i18n.t("roll.note.velocity"),
          hint: vel.min === vel.max
            ? i18n.t("roll.note.velocityOne", { v: vel.min })
            : i18n.t("roll.note.velocityHint", { min: vel.min, max: vel.max }),
          disabled: !usable,
          why: blocked,
        }),
        run: v => setPickedVelocity(v),
      },
      null,
      pasteRow(note.tick, usable, blocked),
      null,
      {
        id: "copy", step: null,
        format: () => ({
          label: i18n.t("roll.note.copy"),
          hint: i18n.t("roll.menu.selectCount", { n }),
        }),
        run: () => copyPicked(),
      },
      {
        id: "cut", danger: true, step: null,
        format: () => ({
          label: i18n.t("roll.note.cut"),
          hint: i18n.t("roll.menu.selectCount", { n }),
          disabled: !usable,
          why: blocked,
        }),
        run: () => cutPicked(),
      },
      {
        id: "delete", danger: true, step: null,
        format: () => ({
          label: i18n.t("roll.note.delete"),
          hint: i18n.t("roll.menu.selectCount", { n }),
          disabled: !usable,
          why: blocked,
        }),
        run: () => removeNotes(picks.map(q => ({ tick: q.tick, midi: q.midi }))),
      },
    ],
  });
}

/** 把卜選取的那幾個音設成某個力度（絕對值）。名字要跟對話框那個相對的 `applyVelocity` 分開。 */
function applyDot() {
  const i = tracks.activeTrack();
  const text = tracks.trackTexts()[i] ?? "";
  const p = prepTrack(text);
  if (p.error) { say(i18n.t("ui.roll.cantEdit", { why: p.error })); return; }
  const picks = menuPicks();
  const r = dotNotes(p.items, new Set(picks.map(n => noteKey(n.tick, n.midi))));
  if (r.bad || r.blocked) {
    const first = (r.bad ?? r.blocked)[0];
    say(i18n.t(r.bad ? "roll.note.dotBlockedLen" : "roll.note.dotBlockedKill", {
      bar: barBeatOf(first.tick).bar, note: first.midi,
    }) + (r.bad?.length > 1 ? i18n.t("roll.note.dotBlockedMore", { n: r.bad.length - 1 }) : ""));
    return;
  }
  if (!r.n) return;
  const out = genPlain(r.items, p.opts);
  if (out === null) { say(i18n.t("ui.roll.cantEncode")); return; }
  writeBack(i, out, text);
  reselect(picks);
  say(i18n.t(r.dotted ? "roll.note.dotDone" : "roll.note.dotUndone", { n: r.n }));
}

function nudgeVelocity(delta) {
  const i = tracks.activeTrack(), text = tracks.trackTexts()[i] ?? "";
  const p = prepTrack(text), picks = menuPicks();
  if (p.error || !picks.length) return;
  const r = shiftVelocities(p.items, delta, new Set(picks.map(n => n.tick)));
  const out = genPlain(r.items, p.opts);
  if (out === null) { say(i18n.t("ui.roll.cantEncode")); return; }
  writeBack(i, out, text); reselect(picks);
}

function setPickedVelocity(v) {
  const i = tracks.activeTrack();
  const text = tracks.trackTexts()[i] ?? "";
  const p = prepTrack(text);
  if (p.error) { say(i18n.t("ui.roll.cantEdit", { why: p.error })); return; }

  const picks = menuPicks();
  const out = finish(setVelocities(p.items, v, new Set(picks.map(q => q.tick))), p.opts);
  if (out === null) { say(i18n.t("ui.roll.cantEncode")); return; }
  if (out === bareTrack(text)) { say(i18n.t("roll.note.velocitySame", { v })); return; }
  writeBack(i, out, text);
  say(i18n.t("roll.note.velocityDone", { n: picks.length, v }));
}

// ─── 移調 ───────────────────────────────────────────────────────────────────

let transScope = "track";   // "all" | "track" | "sel"
let transSemis = 0;         // 0 = 還沒選

/** 24 顆按鈕：升 1–12、降 1–12。12 那兩顆木標出「高八度／低八度」，不是每個人都會換算。 */
function buildTransKeys() {
  const wrap = $("#transKeys");
  if (!wrap || wrap.childElementCount) return;
  const mk = n => {
    const b = document.createElement("button");
    b.type = "button";
    b.setAttribute("role", "radio");
    b.setAttribute("aria-checked", "false");
    b.dataset.semis = String(n);
    const oct = Math.abs(n) === 12
      ? i18n.t("ui.trans.octave",
          { dir: i18n.t(n > 0 ? "ui.trans.high" : "ui.trans.low") })
      : "";
    b.innerHTML = i18n.t("ui.trans.button", {
      dir: i18n.t(n > 0 ? "ui.trans.up" : "ui.trans.down"),
      n: Math.abs(n), oct,
    });
    return b;
  };
  for (let n = 1; n <= 12; n++) wrap.appendChild(mk(n));    // 左欄：升
  for (let n = 1; n <= 12; n++) wrap.appendChild(mk(-n));   // 右欄：降
}

function openTranspose() {
  buildTransKeys();
  transSemis = 0;

  // 「已卜選擇音符」沒有選取時按不下去 —— 開著讓人點了才說「你沒選」很煩
  const hasSel = roll.selectedNotes().length > 0;
  const selBtn = $("#transScope button[data-scope='sel']");
  selBtn.disabled = !hasSel;
  selBtn.title = hasSel ? "" : i18n.t("ui.needSelection");
  if (transScope === "sel" && !hasSel) transScope = "track";

  syncTransUI();
  $("#transNote").textContent = "";
  $("#transBox").classList.add("on");
  $("#transScope button.on")?.focus();
}

const closeTranspose = () => $("#transBox").classList.remove("on");

function syncTransUI() {
  document.querySelectorAll("#transScope button").forEach(b => {
    const on = b.dataset.scope === transScope;
    b.classList.toggle("on", on);
    b.setAttribute("aria-checked", String(on));
  });
  document.querySelectorAll("#transKeys button").forEach(b => {
    const on = +b.dataset.semis === transSemis;
    b.classList.toggle("on", on);
    b.setAttribute("aria-checked", String(on));
  });
  // 水沒選幅度就不給按確認：預設一個值再讓人誤按，比擋住更糟
  $("#transOk").disabled = transSemis === 0;
}

/** 這次移調要動哪幾軌。回傳 [{i, text}]。 */
function transTargets() {
  const texts = tracks.trackTexts();
  if (transScope === "all") {
    return texts.map((text, i) => ({ i, text })).filter(t => bareTrack(t.text));
  }
  const i = tracks.activeTrack();
  return [{ i, text: texts[i] ?? "" }];
}

/** 確認移調。整批原則：任何一軌編不了、或任何一個音會超出 o1c–o7b，就一個音都不動。 */
function applyTranspose() {
  const targets = transTargets();
  const semis = transSemis;
  // 「已卜選擇音符」只動當前軌那幾個音；其他範圍動整軌
  const keys = transScope === "sel"
    ? new Set(roll.selectedNotes().map(n => noteKey(n.tick, n.midi)))
    : null;

  const writes = [];
  let low = 0, high = 0;
  for (const { i, text } of targets) {
    const p = prepTrack(text);
    if (p.error) {
      fail(i18n.t("ui.trans.failTrack", { n: i + 1, why: p.error }));
      return;
    }
    const r = transpose(p.items, semis, keys);
    if (!r.items) { low += r.low; high += r.high; continue; }
    const out = finish(r.items, p.opts);
    if (out === null) {
      fail(i18n.t("ui.trans.failEncode", { n: i + 1 }));
      return;
    }
    writes.push({ i, out, before: text });
  }

  if (low || high) {
    const parts = [];
    if (low) parts.push(i18n.t("ui.trans.tooLow", { n: low }));
    if (high) parts.push(i18n.t("ui.trans.tooHigh", { n: high }));
    fail(i18n.t("ui.trans.failReasons", { list: i18n.list(parts) }));
    return;
  }
  if (!writes.length) { fail(i18n.t("ui.noNotesInRange")); return; }

  // 移調不改變 tick，竹所以選取的那幾個音只有音高變了
  const picks = keys
    ? roll.selectedNotes().map(n => ({ tick: n.tick, midi: n.midi + semis }))
    : null;

  writeBackMany(writes);
  closeTranspose();
  if (picks) reselect(picks);
}

/** 擋下來的原因寫在對話框裡，不用 toast —— 使用者的眼睛就在對話框上。 */
function fail(msg) { $("#transNote").textContent = msg; }

function initTranspose() {
  $("#transBtn").addEventListener("click", openTranspose);
  $("#transCancel").addEventListener("click", closeTranspose);
  $("#transOk").addEventListener("click", applyTranspose);
  $("#transBox").addEventListener("click", e => {
    if (e.target === $("#transBox")) closeTranspose();
  });
  $("#transScope").addEventListener("click", e => {
    const b = e.target.closest("button[data-scope]");
    if (!b || b.disabled) return;
    transScope = b.dataset.scope;
    $("#transNote").textContent = "";
    syncTransUI();
  });
  $("#transKeys").addEventListener("click", e => {
    const b = e.target.closest("button[data-semis]");
    if (!b) return;
    transSemis = +b.dataset.semis;
    $("#transNote").textContent = "";
    syncTransUI();
  });
  addEventListener("keydown", e => {
    if (e.key === "Escape" && $("#transBox").classList.contains("on")) closeTranspose();
  });
}

// ─── 速度／拍速 ─────────────────────────────────────────────────────────────
//
//  速度日是全曲共用的（見 mml.parseAll），所以這個功能做的是編輯全曲的速度圖。每次確認都跑同一套
//  儀式：算出目前實際生效的速度圖 → 套用這次的編輯 → `stripTempos` 從文字上清掉所有軌的 `t` →
//  整張圖寫回主旋律 → 其他軌只切「被跨過的音符」。
//
//  第 1 步是「零音樂變化」的來源：別軌的 `t` 可能正在生效（第 3 軌在 tick 5000 寫 t90 而主旋律那
//  之後沒有任何 t），直接清掉就是整首後半段變速。
//
//  第 3 步刻意用文字刪除而不是重新產生：多數譜每一軌開頭都有 `t`，走 items 的話第一次設速度就把
//  全曲的註解與手排換行洗掉一次，而且唯讀軌會擋住整件事。

/** 遊戲與 mml.js 的 clamp 範圍。這裡不自己定義數字，避免兩邊漂移。 */
const BPM_MIN = 32, BPM_MAX = 255;

let tempoWhere = "head";     // "head" | "sel"
let tempoBpm = 120;
/** 重的那一半（要 tokenize 全部 15 十軌），只在位置變的時候重算 —— 見 syncTempoUI。 */
let tempoPlan = { split: [] };

/** 這次要寫在哪個 tick。 */
function tempoTick() {
  if (tempoWhere === "head") return 0;
  const sel = roll.selectedNotes();
  return sel.length ? Math.min(...sel.map(n => n.tick)) : 0;
}

/** 目前實際生效的速度圖（去掉連續重複的 —— 有些工具每小節都寫一次 t113）。 */
const tempoMap = () => tempoChanges(song?.tempos ?? []);

/** 在這個 tick 生效的 BPM。沒有任何 `t` 就是解析器的預設 120。 */
function bpmAt(tick) {
  let bpm = 120;
  for (const e of tempoMap()) { if (e.tick > tick) break; bpm = e.bpm; }
  return bpm;
}

/** 這個 tick **正好**有記號嗎？有的話回它。 */
const tempoAtExactly = tick => tempoMap().find(e => e.tick === tick) ?? null;

/**
 * 套用這次編輯之後的速度圖。`bpm === null` = 移除。去掉「跟前一個一樣」的多餘記號，但使用者這一
 * 次設的那個一定留著 —— 之後改動前面的速度時它就會開始有作用。
 */
function tempoEdited(tick, bpm) {
  const rest = tempoMap().filter(e => e.tick !== tick);
  const map = bpm === null ? rest : [...rest, { tick, bpm }];
  map.sort((a, b) => a.tick - b.tick);
  return map.filter((e, i, a) => e.tick === tick || i === 0 || e.bpm !== a[i - 1].bpm);
}

/** 哪幾軌會被切段。只跟 tick 有關、跟 BPM 無關，竹所以拖滑桿時不必重算（它要掃全部 15 軌）。 */
function computeTempoPlan() {
  const ticks = tempoEdited(tempoTick(), tempoBpm).map(e => e.tick);
  const texts = tracks.trackTexts();
  const split = [];
  for (const [i, text] of texts.entries()) {
    const p = prepTrack(stripTempos(text));
    if (p.error) continue;                       // 讀不出來的軌在 apply 時才擋
    if (tempoCrossings(p.items, ticks).length) split.push(i);
  }
  tempoPlan = { split };
}

const trackList = list => i18n.list(list.map(i => i18n.trackName(i)));

// ── 試聽：4/4 的節拍型 ──────────────────────────────────────────────────────
//
//  不走 player：那是一台狀態機（playing / paused / 導播線 / textarea 唯讀 / onStop 回呼），借來播
//  四拍節拍器會把演奏鈕與捲軸全部弄亂。也不能用 channel 9（GM 打擊組，XG 下想改回旋律聲道會丟例
//  外），而且內建的 Fury 音色包沒有鼓組。所以走目前這一軌的 channel 與音色 —— 附帶後果是那一軌被
//  靜音時試聽不會有聲卜音，框裡要講一聲。

const CLICK_LEAD = 0.35;   // 往前排多久（同 player.LEAD 的角色）
const CLICK_MS   = 40;     // 多久檢查一次
const CLICK_DUR  = 0.06;   // 一下有多長
const CLICK_HI   = 67;     // 第一拍：高五度
const CLICK_LO   = 60;

let clickTimer = null, clickNext = 0, clickBeat = 0, clickTrack = 0;
/** 這次的節拍是「按住滑桿」開的嗎？（試聽鈕開的那種放開滑鼠不能關掉，見 initTempo） */
let clickHold = false;

function clickTick() {
  const horizon = engine.now() + CLICK_LEAD;
  const ch = chanOf(clickTrack);
  // 一次可能要排好幾拍（很快的速度、或分頁被節流過）。guard 是跑掉時的煞車。
  for (let guard = 0; clickNext < horizon && guard < 64; guard++) {
    const one = clickBeat % 4 === 0;
    const midi = one ? CLICK_HI : CLICK_LO;
    engine.noteOn(ch, midi, one ? 112 : 64, clickNext);
    engine.noteOff(ch, midi, clickNext + CLICK_DUR);
    // 用當下的 tempoBpm 推進下一拍，不是開始時的那個值 —— 拖著滑桿改速度是「從下一拍
    // 開始變」，跟真的節拍器一樣，已經排出去竹的不必收回來。
    clickNext += 60 / Math.max(BPM_MIN, tempoBpm);
    clickBeat++;
  }
}

const clicking = () => clickTimer !== null;

function startClicks() {
  if (clicking() || !canClick()) return;
  clickTrack = tracks.activeTrack();
  engine.resume();
  engine.unmute();                       // 上一次按停止把主輸出切掉了
  applyInstruments([clickTrack]);
  applyMutes();
  clickNext = engine.now() + 0.08;
  clickBeat = 0;
  clickTimer = setInterval(clickTick, CLICK_MS);
  clickTick();
  syncTempoTry();
}

function stopClicks() {
  if (!clicking()) return;
  clearInterval(clickTimer); clickTimer = null;
  engine.stopAll();
  // 已經排進 worklet 佇列、時間戳還沒到的那 CLICK_LEAD 秒照樣會響，而那個佇列清不掉。channel 的
  // isMuted 是在執行 noteOn 的那一刻才判斷的，所以它吃得掉那些 —— 靜音一小段再放回去。這裡敢動
  // channel 的靜音是因為 canClick() 保證沒在播。
  engine.setChannelMute(chanOf(clickTrack), true);
  setTimeout(applyMutes, CLICK_LEAD * 1000 + 60);
  syncTempoTry();
}

/** 試聽現在可不可以用。三個條件都是「用了會壞」而不是「不好看」。 */
function canClick() {
  // 演奏中：試聽走的是同一個 channel，結束時送出的 noteOff 會把曲子裡真正的一個音
  // 切掉。暫停中沒有聲音在流動，可女以。
  if (sounding()) return false;
  if (!presets.length) return false;               // 音色庫還沒載完，送出去也沒聲音
  return true;
}

function syncTempoTry() {
  const b = $("#tempoTry");
  if (!b) return;
  const ok = canClick();
  b.disabled = !ok;
  b.classList.toggle("on", clicking());
  b.setAttribute("aria-pressed", String(clicking()));
  b.firstElementChild.className = clicking() ? "fa-solid fa-stop" : "fa-solid fa-play";
}

// ── 對話框 ─────────────────────────────────────────────────────────────────

function openTempo() {
  const hasSel = roll.selectedNotes().length > 0;
  const selBtn = $("#tempoWhere button[data-where='sel']");
  selBtn.disabled = !hasSel;
  selBtn.title = hasSel ? "" : i18n.t("ui.needSelection");
  if (tempoWhere === "sel" && !hasSel) tempoWhere = "head";

  // 初始值 = 那個位置目前實際生效的速度，不是每次都從 120 開始。打開這個框多半是
  // 「卜這裡好像太快了，微調一下」。
  tempoBpm = bpmAt(tempoTick());
  computeTempoPlan();
  $("#tempoNote").textContent = "";
  syncTempoUI();
  $("#tempoBox").classList.add("on");
  $("#tempoWhere button.on")?.focus();
}

function closeTempo() {
  stopClicks();
  $("#tempoBox").classList.remove("on");
}

const failTempo = msg => { $("#tempoNote").textContent = msg; };

/** BPM 變了（滑桿、數字框）。**不重算 plan** —— 它跟 BPM 無關，見 computeTempoPlan。 */
function setTempoBpm(v) {
  const n = Math.round(Number(v));
  if (!Number.isFinite(n)) return;
  tempoBpm = Math.min(BPM_MAX, Math.max(BPM_MIN, n));
  syncTempoUI();
}

function syncTempoUI() {
  document.querySelectorAll("#tempoWhere button").forEach(b => {
    const on = b.dataset.where === tempoWhere;
    b.classList.toggle("on", on);
    b.setAttribute("aria-checked", String(on));
  });
  // 數字框正在打字時不要回頭改它的值 —— 那會把游標踢到最後面
  if (document.activeElement !== $("#tempoNum")) $("#tempoNum").value = String(tempoBpm);
  $("#tempoSlider").value = String(tempoBpm);

  const tick = tempoTick();
  const cur = tempoAtExactly(tick);
  $("#tempoDel").hidden = !cur;

  const parts = [];
  // 撞到既有記號時一定要取代：parseAll 對同一個 tick 只採用第一個 `t`，加在後面會被
  // 完全忽略（字數變多、速度沒變、沒有錯誤訊息）。這一行只是講給使用者聽的，真正做
  // 取代的日是 tempoEdited()。
    if (cur) parts.push(i18n.t("ui.tempo.replace", { from: cur.bpm, to: tempoBpm }));
    else parts.push(i18n.t("ui.tempo.insert", { to: tempoBpm, at: bpmAt(tick) }));
  if (tempoPlan.split.length) {
      parts.push(i18n.t("ui.tempo.willSplit", { list: trackList(tempoPlan.split) }));
  }
  if (!canClick()) {
      parts.push(i18n.t(sounding() ? "ui.tempo.noPreviewPlaying" : "ui.tempo.noPreviewBank"));
  } else if (tracks.mutedFlags()[tracks.activeTrack()]) {
      parts.push(i18n.t("ui.tempo.trackMuted",
        { track: i18n.trackName(tracks.activeTrack()) }));
  }
  $("#tempoInfo").innerHTML = parts.join(" ");
  syncTempoTry();
}

/** 寫入（或移除）。整批原則：任何一軌切不開就一個字都不動 —— 少切一軌會越走越歪。 */
function applyTempo(remove = false) {
  const tick = tempoTick();
  const map = tempoEdited(tick, remove ? null : tempoBpm);
  const ticks = map.map(e => e.tick);
  const texts = tracks.trackTexts();
  const writes = [];

  for (const [i, before] of texts.entries()) {
    // 先做純文字的清除。**這一步保住註解與手排換行**，也讓唯讀軌水清得掉。
    const stripped = stripTempos(before);
    const p = prepTrack(stripped);

    if (i === 0) {
      if (p.error) { failTempo(i18n.t("ui.tempo.failParse",
        { track: i18n.trackName(0), why: p.error })); return; }
      const out = finish(placeTempos(p.items, map), p.opts);
      if (out === null) { failTempo(i18n.t("ui.tempo.failEncode",
        { track: i18n.trackName(0) })); return; }
      if (out !== before) writes.push({ i, out, before });
      continue;
    }

    // 其他軌：只有「真的有音被跨過」才付重新產生的代價
    if (p.error) {
      if (stripped !== before) writes.push({ i, out: stripped, before });
      continue;
    }
    if (!tempoCrossings(p.items, ticks).length) {
      if (stripped !== before) writes.push({ i, out: stripped, before });
      continue;
    }
    const r = splitForTempos(p.items, ticks);
    const out = finish(r.items, p.opts);
    if (out === null) { failTempo(i18n.t("ui.tempo.failEncodeN",
      { track: i18n.trackName(i) })); return; }
    if (out !== before) writes.push({ i, out, before });
  }

  if (!writes.length) { closeTempo(); say(i18n.t("ui.tempo.noChange")); return; }

  // 先報告再寫入，順序是刻意的：writeBackMany 裡的 warnAfterWrite 可能會講「卜註解與
  // 手動排版會消失」那類只講一次的話，而那比「寫好了」重要得多。
  say(remove
    ? i18n.t("ui.tempo.removed")
    : i18n.t("ui.tempo.written", {
        bpm: tempoBpm, track: i18n.trackName(0),
        where: i18n.t(tick === 0 ? "ui.tempo.atStart" : "ui.tempo.atPos"),
      }));
  writeBackMany(writes);
  closeTempo();
}

function initTempo() {
  $("#tempoBtn").addEventListener("click", openTempo);
  $("#tempoCancel").addEventListener("click", closeTempo);
  $("#tempoOk").addEventListener("click", () => applyTempo(false));
  $("#tempoDel").addEventListener("click", () => applyTempo(true));
  $("#tempoBox").addEventListener("click", e => {
    if (e.target === $("#tempoBox")) closeTempo();
  });
  $("#tempoWhere").addEventListener("click", e => {
    const b = e.target.closest("button[data-where]");
    if (!b || b.disabled) return;
    tempoWhere = b.dataset.where;
    // 位置變了 → 初始值換成那裡實際生效竹的速度，plan 也要重算（它跟 tick 有關）
    tempoBpm = bpmAt(tempoTick());
    computeTempoPlan();
    $("#tempoNote").textContent = "";
    syncTempoUI();
  });

  $("#tempoSlider").addEventListener("input", e => setTempoBpm(e.target.value));
  $("#tempoNum").addEventListener("input", e => {
    // 打字中允許暫時的空字串／半成品，只有讀得出數字才套用
    const n = Number(e.target.value);
    if (e.target.value !== "" && Number.isFinite(n)) setTempoBpm(n);
  });
  // 失焦時把夾過的值寫回框裡（打了 999 要看到它變成 255）
  $("#tempoNum").addEventListener("blur", () => syncTempoUI());

  // 手放開之後才重算「哪幾軌要切段」。它幾乎跟 BPM 無關（tempoEdited 會丟掉多餘記號，所以改 BPM
  // 有可能讓某個記號從被丟掉變成留下來）。放在 input 裡會讓拖曳時每一幀都掃全部 15 軌。
  const replan = () => { computeTempoPlan(); syncTempoUI(); };
  $("#tempoSlider").addEventListener("change", replan);
  $("#tempoNum").addEventListener("change", replan);

  // 按住滑桿就試聽、放開就停。pointerup 一定要掛在 window 上：拖到滑桿外面才放開是常態，掛在元
  // 素上的話那一次收不到、節拍會一直響。clickHold 分辨「按住滑桿」與「按了試聽鈕」—— 後者日是切換
  // 式的，不能被一次無關的 pointerup 關掉。
  $("#tempoSlider").addEventListener("pointerdown", () => {
    if (clicking()) return;          // 試聽鈕已經開著，讓它繼續，放開時也不要關掉
    clickHold = true;
    startClicks();
  });
  const release = () => { if (clickHold) { clickHold = false; stopClicks(); } };
  addEventListener("pointerup", release);
  addEventListener("pointercancel", release);

  $("#tempoTry").addEventListener("click", () => {
    clickHold = false;
    clicking() ? stopClicks() : startClicks();
  });

  addEventListener("keydown", e => {
    if (e.key === "Escape" && $("#tempoBox").classList.contains("on")) closeTempo();
  });
}

// ─── 力度／音量 ─────────────────────────────────────────────────────────────
//
//  骨架跟移調逐項對應，差別只有動的是 `v`。真正的機器是 rolledit 那兩個現成的純函式，所以「開頭
//  沒有 `v` 要當成 8、改了要寫進去」不需要新程式碼 —— 整軌 +2 時它自己就會寫出一個 `v10`。

let velScope = "track";     // "all" | "track" | "sel"
let velDelta = 0;           // 0 = 還沒選

/** 20 顆按鈕：增強 +1…+10、減弱 −1…−10。標籤由 JS 生戈成避免手滑打錯。 */
function buildVelKeys() {
  const wrap = $("#velKeys");
  if (!wrap || wrap.childElementCount) return;
  const mk = n => {
    const b = document.createElement("button");
    b.type = "button";
    b.setAttribute("role", "radio");
    b.setAttribute("aria-checked", "false");
    b.dataset.delta = String(n);
    b.innerHTML = i18n.t("ui.vel.button", {
      dir: i18n.t(n > 0 ? "ui.vel.up" : "ui.vel.down"),
      sign: n > 0 ? "+" : "−", n: Math.abs(n),
    });
    return b;
  };
  for (let n = 1; n <= 10; n++) wrap.appendChild(mk(n));
  for (let n = 1; n <= 10; n++) wrap.appendChild(mk(-n));
}

/** 這次要動哪幾軌。回傳 [{i, text}]。跟移調的 transTargets 同一個形狀。 */
function velTargets() {
  const texts = tracks.trackTexts();
  if (velScope === "all") {
    return texts.map((text, i) => ({ i, text })).filter(t => bareTrack(t.text));
  }
  const i = tracks.activeTrack();
  return [{ i, text: texts[i] ?? "" }];
}

/** 「選擇的音符」要動哪些 tick。只有 tick 不含音高：力度是時間竹的函式（見 velocitiesOf）。 */
const velTicks = () =>
  velScope === "sel" ? new Set(roll.selectedNotes().map(n => n.tick)) : null;

function openVelocity() {
  buildVelKeys();
  velDelta = 0;

  const hasSel = roll.selectedNotes().length > 0;
  const selBtn = $("#velScope button[data-scope='sel']");
  selBtn.disabled = !hasSel;
  selBtn.title = hasSel ? "" : i18n.t("ui.needSelection");
  if (velScope === "sel" && !hasSel) velScope = "track";

  $("#velNote").textContent = "";
  syncVelUI();
  $("#velBox").classList.add("on");
  $("#velScope button.on")?.focus();
}

const closeVelocity = () => $("#velBox").classList.remove("on");

/** 這個範圍現在的力度分布，以及套用 delta 之後會壓平幾個音。 */
function velStats() {
  const ticks = velTicks();
  let min = null, max = null, count = 0, clipped = 0;
  for (const { text } of velTargets()) {
    const p = prepTrack(text);
    if (p.error) continue;
    const s = velocityStats(p.items, ticks);
    count += s.count;
    if (s.min !== null) min = min === null ? s.min : Math.min(min, s.min);
    if (s.max !== null) max = max === null ? s.max : Math.max(max, s.max);
    if (velDelta) clipped += shiftVelocities(p.items, velDelta, ticks).clipped;
  }
  return { min, max, count, clipped };
}

function syncVelUI() {
  document.querySelectorAll("#velScope button").forEach(b => {
    const on = b.dataset.scope === velScope;
    b.classList.toggle("on", on);
    b.setAttribute("aria-checked", String(on));
  });
  document.querySelectorAll("#velKeys button").forEach(b => {
    const on = +b.dataset.delta === velDelta;
    b.classList.toggle("on", on);
    b.setAttribute("aria-checked", String(on));
  });

  const s = velStats();
  $("#velRange").innerHTML = s.count
      ? i18n.t("ui.vel.range", { n: s.count, min: s.min, max: s.max })
      : i18n.t("ui.vel.noNotes");
  // 夾住不擋（見 rolledit.shiftVelocities），但代價要在按下確認之前講山出來
  $("#velNote").textContent = s.clipped
      ? i18n.t("ui.vel.clipped", { n: s.clipped,
          a: velDelta > 0 ? 15 : 0, b: velDelta > 0 ? 15 : 0 })
    : "";
  $("#velOk").disabled = velDelta === 0 || s.count === 0;
}

function applyVelocity() {
  const ticks = velTicks();
  const writes = [];
  for (const { i, text } of velTargets()) {
    const p = prepTrack(text);
    if (p.error) { $("#velNote").textContent = i18n.t("ui.vel.failParse",
      { track: i18n.trackName(i), why: p.error }); return; }
    const r = shiftVelocities(p.items, velDelta, ticks);
    const out = finish(r.items, p.opts);
    if (out === null) { $("#velNote").textContent = i18n.t("ui.vel.failEncode",
      { track: i18n.trackName(i) }); return; }
    if (out !== text) writes.push({ i, out, before: text });
  }
  if (!writes.length) { closeVelocity(); say(i18n.t("ui.vel.noChange")); return; }
  writeBackMany(writes);
  closeVelocity();
}

function initVelocity() {
  $("#velBtn").addEventListener("click", openVelocity);
  $("#velCancel").addEventListener("click", closeVelocity);
  $("#velOk").addEventListener("click", applyVelocity);
  $("#velBox").addEventListener("click", e => {
    if (e.target === $("#velBox")) closeVelocity();
  });
  $("#velScope").addEventListener("click", e => {
    const b = e.target.closest("button[data-scope]");
    if (!b || b.disabled) return;
    velScope = b.dataset.scope;
    syncVelUI();
  });
  $("#velKeys").addEventListener("click", e => {
    const b = e.target.closest("button[data-delta]");
    if (!b) return;
    velDelta = +b.dataset.delta;
    syncVelUI();
  });
  addEventListener("keydown", e => {
    if (e.key === "Escape" && $("#velBox").classList.contains("on")) closeVelocity();
  });
}

// ─── 合併音軌 ───────────────────────────────────────────────────────────────
//
// 把來源十軌（＝目前軌）的內容併進另一軌，來源留下同長度的休止符。結構照壓縮優化抄（開框先算 /
// sync / apply / fail），對使用者來說它們是同一類東西。決定誰贏的那五條規則全部在
// `rolledit.mergeTracks`（純函式、有測試），這裡只做算、畫、寫回。
//
// 四件跟直覺不一樣的事：
//   1. 開框要先算 —— 五種方式的破壞程度差三個級距，使用者要靠那些數字取捨。
//   2. 代價 0 不 disable —— 跟優化相反：合併「丟 0 個音」是最好的結果。
//   3. 範圍不沿用上次 —— 沿用「目前音軌」的話，選了 8 個音、開框、隨手確認，整軌就被併走了。
//   4. 方式不預設 —— 誤按「目前取代目標」會清掉目標軌整段內容。
//
// 動兩軌，所以 writeBackMany 收成一步 undo。

/** 方式清單，順序就是畫面上的順序。 */
const MERGE_WAYS = MERGE_MODES;

let mergeScope = "track";    // "track" | "sel"
let mergeWay = null;         // null = 還沒選
let mergeCalc = null;        // 開框時算好的結果，見 recalcMerge

const trackName = i => i18n.trackName(i);

/** 目木標軌的下拉：除了當前軌以外全部，含空軌（合併到空軌就是單純搬移）。 */
function buildMergeTargets() {
  const sel = $("#mergeTo");
  const cur = tracks.activeTrack();
  const prev = sel.value;
  sel.innerHTML = "";
  for (let i = 0; i < tracks.trackCount(); i++) {
    if (i === cur) continue;
    const o = document.createElement("option");
    o.value = String(i);
    o.textContent = trackName(i);
    sel.appendChild(o);
  }
  // 換軌之後盡量沿用上次選的目標 —— 連續把好幾軌合併到同一軌是主要用法。這一項刻意
  // 跟「範圍」不同：選錯目標軌是可見且可逆的。
  if ([...sel.options].some(o => o.value === prev)) sel.value = prev;
}

/** 讓山出一幀。兩次 rAF 才保證中間真的發生過一次繪製 —— 同 filebox 的 `frame()`。 */
const frame = () => new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));

/**
 * 一段同步計算最多佔住主執行緒幾毫秒。25ms 是「掉一幀但不掉第二幀」—— 一個方式是不可分割的，所以
 * 真正的下限是最慢那個方式自己的耗時。
 */
const MERGE_SLICE_MS = 25;

/** 這一輪計算的序號。換範圍／換目標軌／關框都會 ++，過期的工作自己收手。 */
let mergeJob = 0;

/**
 * 開一輪重算：同步擺出骨架，非同步填數字。整軌那條路最壞 107ms，而「按下按鈕之後 107ms 什麼都沒
 * 出現」看起來就是壞了。算完之前「執行」按不下去 —— 半套數字做不了取捨。
 */
function recalcMerge() {
  const from = tracks.activeTrack();
  const to = +$("#mergeTo").value;
  const texts = tracks.trackTexts();
  const job = ++mergeJob;

  if (!Number.isInteger(to) || to === from) { mergeCalc = null; syncMergeUI(); return; }

  // 字數竹的「現在」先算 —— `bareTrack` 只是剝空白，便宜，而它讓字數那一行在第一幀就
  // 有內容。
  mergeCalc = { to, per: {}, fail: "", done: false, now: bareTrack(texts[to] ?? "").length };
  syncMergeUI();
  void fillMerge(job, from, to, texts);
}

/**
 * 把五種方式各跑一遍，算出真實的代價與結果字數。整批原則：任一軌讀不出來就五種全部擋下；單一方式
 * 寫不回去則只擋那一顆。
 *
 * 成本量過（最壞情形）：1126 字／700 音是 43ms，2400 字／1500 音是 107ms。慢的是整軌那條路。
 *
 * 每個 await 之後都要檢查 `job`：使用者在算的過程中換目標軌、換範圍、關掉框都會開新的一輪，不收
 * 手的話舊的那一輪會把過期的數字寫進畫面。
 */
async function fillMerge(job, from, to, texts) {
  // 這一輪自己的收件匣。寫進 `calc` 而不是 `mergeCalc` —— 就算哪天 job 的檢查漏了一個
  // await，過期的工作也只會寫進一個水沒人看的死物件。那種錯誤看起來完全像「數字算錯了」。
  const calc = mergeCalc;

  await frame();
  if (job !== mergeJob) return;

  const src = prepTrack(texts[from] ?? "");
  const tgt = prepTrack(texts[to] ?? "");
  if (src.error || tgt.error) {
    calc.done = true;
    calc.fail = src.error ? i18n.t("ui.merge.failSrc", { why: src.error })
                          : `${trackName(to)}${tgt.error}`;
    syncMergeUI();
    return;
  }

  // 「已選擇音符」→ 只併這些；「目前音軌」→ null＝整軌（同 optimizeTrack 的 keys）
  const keys = mergeScope === "sel"
    ? new Set(roll.selectedNotes().map(n => noteKey(n.tick, n.midi)))
    : null;

  let since = performance.now();
  for (const way of MERGE_WAYS) {
    const r = mergeTracks(src.items, tgt.items, way, keys);
    if (r.block) {
      calc.per[way] = { block: r.block, count: r.count };
    } else {
      const tOut = finish(r.tgt, tgt.opts);
      const sOut = finish(r.src, src.opts);
      calc.per[way] = tOut === null || sOut === null ? { block: "encode" } : {
        dropped: r.dropped, trimmed: r.trimmed, tOut, sOut,
        // 字數一律用 bareTrack 量，跟 optimizeTrack 裡面同一把尺 —— 開了「MML 格式化
        // 換行」時輸出帶著 `\n`，而換行在遊戲裡不佔字數（見 emitTrack 竹的註解）。
        after: bareTrack(tOut).length,
        // 併完要選起來的那一段。用**視窗內的音**而不是「搬過去的那幾個」：三種方式
        // 之後那幾個音可能根本不存在（被丟掉、或被採樣改掉音高），而 rangeOf 一律
        // 回連續區間，所以「整個視窗」本來就是選取模型唯一表達得出來的東西。
        picks: notesInRange(r.tgt, r.from, r.to - r.from)
          .map(n => ({ tick: n.tick, midi: n.midi })),
      };
    }

    // 超過預算才讓出去。便宜的情形（已選擇音符）因此一次都不讓，數字在第二幀就全部
    // 到位 —— 為了進度條而故意變慢是本末倒置。
    if (performance.now() - since > MERGE_SLICE_MS) {
      syncMergeUI();                 // 讓出去之前先把已經算好的畫上去
      await frame();
      if (job !== mergeJob) return;
      since = performance.now();
    }
  }

  calc.done = true;
  syncMergeUI();
}

function openMerge() {
  mergeWay = null;
  const hasSel = roll.selectedNotes().length > 0;

  const selBtn = $("#mergeScope button[data-scope='sel']");
  selBtn.disabled = !hasSel;
  selBtn.title = hasSel ? "" : i18n.t("ui.needSelection");
  // 範圍每次重算、不沿用（見本節開頭第 3 點）。有選取就是選取 —— 他剛剛才選的。
  mergeScope = hasSel ? "sel" : "track";

  buildMergeTargets();
  // 框先開，再開始算：`recalcMerge` 只擺骨架、把真正的計算丟到下一幀，所女以要讓框在
  // 那一幀之前就已經是 `.on` 的，不然讓出去的那一幀畫的還是沒有框的畫面。
  $("#mergeBox").classList.add("on");
  recalcMerge();
  $("#mergeTo").focus();
}

/** 關框就讓在跑的那一輪計算收手 —— 它接下來每個 await 都會看到 job 過期。 */
const closeMerge = () => {
  mergeJob++;
  $("#mergeBox").classList.remove("on");
};

/** 這個 block 代碼要跟使用者說什麼。回空字串＝不必說（不會發生）。 */
function blockWhy(block, count, to) {
  switch (block) {
    case "empty":     return i18n.t("ui.merge.why.empty");
    case "encode":    return i18n.t("ui.merge.why.encode");
    default:          return "";
  }
}

function syncMergeUI() {
  const cur = tracks.activeTrack();

  document.querySelectorAll("#mergeScope button").forEach(b => {
    const on = b.dataset.scope === mergeScope;
    b.classList.toggle("on", on);
    b.setAttribute("aria-checked", String(on));
  });

  // 「和弦1　64 個音符 → [和弦2 ▾]」。數字跟著範圍走 —— 換了範圍卻看到同一個數字會
  // 讓人以為範圍沒生效。（「和弦1／2」是遊戲的軌名，跟 [ceg] 那個退役的語水法無關。）
  const all = song?.tracks[cur]?.notes?.length ?? 0;
  const n = mergeScope === "sel" ? roll.selectedNotes().length : all;
  $("#mergeFrom").textContent = i18n.t("ui.merge.from",
    { track: trackName(cur), n });

  // 三種狀態，而「還在算」跟「不能用」一定要分得出來 —— 兩者都是灰按鈕，但一個是等
  // 一下就好、一個是永遠不行。混在一起使用者會一直等一個不會來的東西。
  const per = mergeCalc?.per ?? {};
  const busy = !!mergeCalc && !mergeCalc.done;
  const whys = new Set();
  let alive = 0;

  document.querySelectorAll("#mergeWays button").forEach(b => {
    const way = b.dataset.way;
    const s = per[way];
    const pending = !s && busy;              // 還沒輪到它算
    const dead = !s || !!s.block;
    b.disabled = dead;
    b.setAttribute("aria-busy", String(pending));
    // 只有確定不能用才把選擇清掉。還在算的時候留著 —— 換目標軌時使用者的「我要哪
    // 一種」沒有改變，清掉等於逼他重選一次。
    if (dead && !pending && mergeWay === way) mergeWay = null;
    if (!dead) alive++;
    // 還在算的時候保留高亮。它是 disabled 的（代價還沒出來），但高亮要留著 —— 讓
    // 選擇閃掉再閃回來看起來像自己被取消了。disabled + on 在 CSS 上是「暗一點竹的藍」。
    const on = way === mergeWay && !(dead && !pending);
    b.classList.toggle("on", on);
    b.setAttribute("aria-checked", String(on));

    if (dead) {
      b.querySelector(".n").textContent = pending ? i18n.t("ui.calculating") : "—";
      const why = s ? blockWhy(s.block, s.count, mergeCalc?.to) : "";
      if (why) whys.add(why);
    } else {
      // 兩行都要顯示，即使是 0 —— 「丟掉 0 個音」正是使用者最想看到的那一行。
      b.querySelector(".n").textContent = i18n.t("ui.merge.cost",
        { dropped: s.dropped, trimmed: s.trimmed });
    }
  });

  // 算完之前一律按不下去，即使那個方式的數字已經到位 —— 五個數字是拿來互相比的。
  $("#mergeOk").disabled = mergeWay === null || busy;

  // 字數／上限。選了方式就把箭頭後面的結果一起顯示。講的是目標軌那一軌 —— 上限是按
  // 軌算的，而合併就是把兩軌塞成一軌。
  const chars = $("#mergeChars");
  const now = mergeCalc?.now ?? 0;
  const after = mergeWay ? per[mergeWay]?.after ?? null : null;
  chars.innerHTML = mergeCalc && !mergeCalc.fail
    ? `${trackName(mergeCalc.to)} <b>${now}</b>${after !== null ? ` → <b>${after}</b>` : ""}`
      + i18n.t("ui.charsOfLimit", { max: MAX_TRACK_CHARS })
    : "";
  chars.classList.toggle("over", (after ?? now) > MAX_TRACK_CHARS);

  // 五人個都灰掉時一定要說話，不然畫面就是「一個開著的框，什麼都不能按」。但還在算的時候不算「都
  // 灰掉」—— 那時原因寫在每顆按鈕的「計算中…」上了。最後那個 fallback 照理走不到。
  const notes = mergeCalc?.fail ? [mergeCalc.fail] : [...whys];
  if (!alive && !busy && !notes.length) notes.push(i18n.t("ui.merge.cantMerge"));
  $("#mergeNote").textContent = notes.length
    ? i18n.t("ui.mergeNoteLine", { list: i18n.list(notes) }) : "";
}

/**
 * 確認合併。要寫的兩份文字在 `fillMerge` 就算好了，這裡只負責寫回去 —— 所以「算出來能寫」跟「真
 * 的寫進去的」保證是同一份。`done` 也要擋：Enter 鍵與「算到一半換了目標軌」都繞得過按鈕的 disabled。
 */
function applyMerge() {
  if (!mergeCalc?.done) return;
  const s = mergeCalc.per[mergeWay];
  if (!s || s.block) return;

  const from = tracks.activeTrack();
  const to = mergeCalc.to;
  const texts = tracks.trackTexts();

  // 兩軌一起寫、只記一步 undo。選錯方式或目標軌 Ctrl+Z 就整個回來 —— 這也是「丟掉
  // N 個音」只在框裡報一次、不再跳確認框的理由。
  writeBackMany([
    { i: to, out: s.tOut, before: texts[to] ?? "" },
    { i: from, out: s.sOut, before: texts[from] ?? "" },
  ]);
  closeMerge();

  // 切到目木標軌並把併出來的那一段選起來：東西被放到別的地方去了，就要帶人去看。
  // 留在來源軌會給出最糟的畫面 —— 一整片休止符，看起來像「我的音符不見了」。
  tracks.selectTrack(to);
  reselect(s.picks);

  const cost = s.dropped === 0 && s.trimmed === 0
    ? i18n.t("ui.merge.noLoss")
    : i18n.t("ui.merge.lossSummary", { dropped: s.dropped, trimmed: s.trimmed });
  say(i18n.t("ui.merge.done", { track: trackName(to), cost }));
}

function initMerge() {
  $("#mergeBtn").addEventListener("click", openMerge);
  $("#mergeCancel").addEventListener("click", closeMerge);
  $("#mergeOk").addEventListener("click", applyMerge);
  $("#mergeBox").addEventListener("click", e => {
    if (e.target === $("#mergeBox")) closeMerge();
  });
  // 換範圍、換目標軌都要重算 —— 十個數字全部會變。`recalcMerge` 自己會畫骨架、也自己
  // 會讓上一輪計算過期，所以卜這裡不必再叫 syncMergeUI。
  $("#mergeScope").addEventListener("click", e => {
    const b = e.target.closest("button[data-scope]");
    if (!b || b.disabled) return;
    mergeScope = b.dataset.scope;
    recalcMerge();
  });
  $("#mergeWays").addEventListener("click", e => {
    const b = e.target.closest("button[data-way]");
    if (!b || b.disabled) return;
    mergeWay = b.dataset.way;
    syncMergeUI();
  });
  $("#mergeTo").addEventListener("change", recalcMerge);
  addEventListener("keydown", e => {
    if (e.key === "Escape" && $("#mergeBox").classList.contains("on")) closeMerge();
  });
}

// ─── 壓縮優化 ───────────────────────────────────────────────────────────────
//
// 結構刻意照移調抄（開框 / sync / targets / apply / fail），對使用者來說它們是同一類東西。唯一的
// 結構差異是開框要先算：每個方式的代價只有真的跑一遍編碼才知道（一軌 900 個 item 是 3–7ms，四個
// 方式 × 六軌 ≈ 60ms）。
//
// 四個方式分成兩層，而那個分界是這個框的重點：`lossless`（DP 重算寫法，一個音都不動）與
// `OPT_RULES`（三個有損規則，微調音符長度換字數，會改變聲音）。
//
// 兩層的數字是相加的：`optimizeTrack` 的 `before` 已經是無損壓縮後的長度，所以三個有損規則報的是
// 「在無損之上還能再省多少」—— 拿原文當基準的話，手寫譜的無損壓縮功勞會被算到有損優化頭上。

/** 方式清單，順序就是畫面上的順序。lossless 一定在最前面 —— 見上面那段。 */
const OPT_WAYS = ["lossless", ...OPT_RULES];

let optScope = "track";     // "all" | "track" | "sel"
let optRule = null;         // null = 還沒選
let optCalc = null;         // 開框時算好的結果，見 recalcOpt

/** 這次優化要動哪幾十軌。跟 transTargets 同一套規則。 */
function optTargets() {
  const texts = tracks.trackTexts();
  if (optScope === "all") {
    return texts.map((text, i) => ({ i, text })).filter(t => bareTrack(t.text));
  }
  const i = tracks.activeTrack();
  return [{ i, text: texts[i] ?? "" }];
}

/**
 * 把四個方式各跑一遍，算出真實的省字數與影響組數。先跑無損壓縮再算省了多少 —— `optimizeTrack` 的
 * before 是壓縮後的長度不是原文長度，拿原文當基準的話無損壓縮的功勞會被算到優化頭上。
 *
 * 無損那一層就是把那個差額單獨列出來當一個方式，兩層相加等於原文到最終結果。
 */
function recalcOpt() {
  const keys = optScope === "sel"
    ? new Set(roll.selectedNotes().map(n => noteKey(n.tick, n.midi)))
    : null;

  const per = {};
  for (const way of OPT_WAYS) per[way] = [];
  const skipped = [];
  // 每軌無損壓縮後的文字。有損那三個的驗證要拿它當基準，不能拿原文 —— 壓縮本身會砍
  // 掉尾端休止，用原文比 endTick 會對不上。
  const baseOf = {};
  for (const { i, text } of optTargets()) {
    const r = optimizeTrack(text, { ...genOpts(), rules: OPT_RULES, keys });
    if (r.error) { skipped.push(i18n.t("ui.opt.skipTrack",
      { n: i + 1, why: r.error })); continue; }
    if (r.budgetExhausted) skipped.push(i18n.t("compress.note.budgetExhausted", { n: i + 1 }));
    baseOf[i] = r.base;

    // 無損：out 就日是 r.base，基準是原文而不是 r.before（那已經含了它自己的功勞）。壓完沒變短的軌
    // 一樣要記進來，因為「最長的一軌會變成幾字」要算它。字數一律用 bareTrack 量 —— 換行不佔字數。
    const rawLen = bareTrack(text).length;
    const baseLen = bareTrack(r.base).length;
    per.lossless.push({
      i, out: r.base, changed: 0,
      before: rawLen, after: baseLen,
      // 壓完更長就不寫那一軌（同 compressMML 的 keep()），所以那一軌省 0 字、
      // 結果長度還是原文長度
      write: baseLen < rawLen,
      saved: Math.max(0, rawLen - baseLen),
      result: Math.min(rawLen, baseLen),
    });

    for (const rule of OPT_RULES) {
      const g = r.rules[rule];
    if (g.error) { skipped.push(i18n.t("ui.opt.skipTrack",
      { n: i + 1, why: g.error })); continue; }
      per[rule].push({
        i, out: g.out, changed: g.changed, write: g.changed > 0,
        before: r.before, after: g.after, saved: r.before - g.after,
        result: g.after,
      });
    }
  }

  const sum = {};
  for (const way of OPT_WAYS) {
    sum[way] = {
      writes: per[way].filter(w => w.write),
      saved: per[way].reduce((a, w) => a + w.saved, 0),
      changed: per[way].reduce((a, w) => a + w.changed, 0),
      // 遊戲竹的字數上限是按軌算的，所以看最長的那一軌而不是全曲總和：6 軌各 500 字
      // 完全沒問題，單軌 2500 字貼不進去。
      worst: per[way].reduce((m, w) => Math.max(m, w.result), 0),
    };
  }
  // 「現在」是使用者手上真的有幾個字，也就是原文（去空白）的最長軌 —— 不是 r.before。
  // 拿 r.before 當「現在」的話，無損那一顆會顯示「2300 → 2300」而它明明省了 50 字。
  const worstNow = (per.lossless ?? []).reduce((m, w) => Math.max(m, w.before), 0);
  optCalc = { sum, skipped, baseOf, worstNow };
}

function openOptimize() {
  optRule = null;

  const hasSel = roll.selectedNotes().length > 0;
  const selBtn = $("#optScope button[data-scope='sel']");
  selBtn.disabled = !hasSel;
  selBtn.title = hasSel ? "" : i18n.t("ui.needSelection");
  if (optScope === "sel" && !hasSel) optScope = "track";

  recalcOpt();
  syncOptUI();
  $("#optBox").classList.add("on");
  $("#optScope button.on")?.focus();
}

const closeOptimize = () => $("#optBox").classList.remove("on");

function syncOptUI() {
  document.querySelectorAll("#optScope button").forEach(b => {
    const on = b.dataset.scope === optScope;
    b.classList.toggle("on", on);
    b.setAttribute("aria-checked", String(on));
  });

  const targets = optTargets();
  const unarmed = targets.some(t => !tracks.zipOf(t.i));

  let alive = 0;
  document.querySelectorAll("#optRules button").forEach(b => {
    const way = b.dataset.rule;
    const s = optCalc.sum[way];
    //  無損那顆多一個活著的理由：這個範圍裡還有軌沒進壓縮模式。那時它一個字都省不了
    // （譜已經夠緊了，或是外面匯進來時就已經壓過），但它記得住「以後的編輯都要維持
    // 壓縮」—— 而那正是使用者按它的目的。少了這一條，一份匯進來就很緊的譜按不下去，
    // 於是它每編輯一次字數就漲一點，而畫面上沒有任何地方看得出為什麼。
    const armable = way === "lossless" && unarmed;
    // 省 0 字（戈或負的）就不給按。這個範圍裡它真的無事可做，開著只會讓人點了才發現。
    const dead = !s || (s.saved <= 0 && !armable);
    b.disabled = dead;
    if (dead && optRule === way) optRule = null;
    if (!dead) alive++;
    const on = !dead && way === optRule;
    b.classList.toggle("on", on);
    b.setAttribute("aria-checked", String(on));
    // 無損那顆寫「省」，有損三顆寫「再省」—— 它們的基準是無損之後的長度，兩層相加
    // 才等於下面那行的「原文 → 結果」。無損的代價是零，所以直接把那件事說出來。
    b.querySelector(".n").textContent = dead
      ? "—"
      : way === "lossless"
      ? (s.saved > 0 ? i18n.t("ui.opt.saveLossless", { n: s.saved })
                     : i18n.t("ui.opt.keepZip"))
      : i18n.t("ui.opt.saveMore", { n: s.saved, changed: s.changed });
  });

  $("#optOk").disabled = optRule === null;

  // 字數／上限。「現在」一律日是原文的長度（見 recalcOpt 的 worstNow），所以無論選的
  // 是哪一層，這一行講的都是同一件事：執行之後最長的那一軌會變成幾字。有損那三個的
  // worst 已經含了無損壓縮。
  const chars = $("#optChars");
  const now = optCalc.worstNow;
  const after = optRule ? optCalc.sum[optRule].worst : null;
  const scopeName = i18n.t(optScope === "all" ? "ui.opt.scopeAll" : "ui.opt.scopeOne");
  chars.innerHTML = now
    ? `${scopeName} <b>${now}</b>${after !== null ? ` → <b>${after}</b>` : ""}`
      + i18n.t("ui.charsOfLimit", { max: MAX_TRACK_CHARS })
    : "";
  // 超了不擋執行（優化正是他用來壓下去的工具），只是把數字標紅
  chars.classList.toggle("over", (after ?? now) > MAX_TRACK_CHARS);

  // 四個都灰掉時一定要說話。不說的話畫面就是「一個開著的框，什麼都不能按」，看起來
  // 像壞了，而它其實是正確答案（這個範圍已經沒有字可以省）。
  const notes = [...optCalc.skipped];
  if (!alive) notes.push(i18n.t("ui.opt.nothingLeft"));
  // 「已選擇音符」對無損沒有意義（它一定整軌重算），而使用者選了範圍卻看到一個不吃
  // 那個範圍的方式會以為壞了。卜說一聲，不擋。
  if (optRule === "lossless" && optScope === "sel") notes.push(i18n.t("ui.opt.losslessWholeTrack"));

  const noteEl = $("#optNote");
  noteEl.replaceChildren();
  if (notes.length)
    noteEl.appendChild(document.createTextNode(
      i18n.t("ui.optNoteLine", { list: i18n.list(notes) })));

  //  這個範圍裡有軌在壓縮模式 → 給一顆關閉。
  //
  //  **放在說明行，不做成第五個方式。** 它不是「再壓一點」而是「停止自動壓縮」，混進
  // 同一組單選鈕裡會讓人以為關掉就會把譜展開回去 —— 而**關閉只停止未來的自動壓縮，
  // 已經壓好的文字一個字都不動**（要回到好讀的形式是另一件事）。
  const zipped = targets.filter(t => tracks.zipOf(t.i));
  if (zipped.length) {
    const off = document.createElement("button");
    off.type = "button";
    off.className = "link";
    off.textContent = i18n.t("ui.opt.zipOff", { n: zipped.length });
    off.title = i18n.t("ui.opt.zipOffHint");
    off.addEventListener("click", zipOff);
    noteEl.append(" ", off);
  }
}

/**
 * 退出壓縮模式。**只改旗標，不動文字** —— 展開回好讀的形式是另一件事，而使用者按這顆
 * 是為了「別再自己壓了」，不是為了把現在這一份重寫掉。
 *
 * 一步 undo：`zip` 在快照裡，所以按錯了 Ctrl+Z 回得來。
 */
function zipOff() {
  const zipped = optTargets().filter(t => tracks.zipOf(t.i));
  if (!zipped.length) return;
  history.edit(() => {
    for (const { i } of zipped) tracks.setZip(i, null);
    // 文字沒動 = 沒有人會替我們 persist（見 tracks.setZip）。
    tracks.persist();
  });
  closeOptimize();
  refresh();          // 樂器列右邊那個標記要跟著消失
  say(i18n.t("ui.opt.zipOffDone", { n: zipped.length }));
}

/**
 * 只記住意圖，不動文字。無損那顆在「沒字可省但還有軌沒進壓縮模式」時做的就是這件事。
 */
function zipArm(targets) {
  history.edit(() => {
    for (const { i } of targets) tracks.setZip(i, ZIP_LOSSLESS);
    tracks.persist();
  });
  closeOptimize();
  refresh();
  say(i18n.t("ui.opt.zipArmed", { n: targets.length }));
}

/**
 * 執行優化。跳過壞軌、其餘照做 —— 移調整批放棄是因為「有一個音會超出 o1–o7」是整首歌的性質，而這
 * 裡各軌狀態互相獨立。
 */
function applyOptimize() {
  const s = optCalc.sum[optRule];
  const lossless = optRule === "lossless";
  //  arm 的範圍是**這次瞄準的軌**，不是「真的被寫入的軌」。差別在「本來就已經很緊、DP
  // 壓不贏原文」那幾軌 —— 它們不在 writes 裡，漏掉的話使用者按過優化、那一軌卻沒記住，
  // 之後編輯字數照樣漲。arm 一條壓不動的軌是零成本的：zipFinal 在壓不短時本來就回照實版。
  const targets = optTargets();
  if (!s || !s.writes.length) {
    if (lossless && targets.some(t => !tracks.zipOf(t.i))) { zipArm(targets); return; }
    optFail(i18n.t(lossless ? "ui.opt.failLossless" : "ui.opt.failOptimize"));
    return;
  }

  const texts = tracks.trackTexts();
  //  `raw` —— 這裡的 `w.out` **本身就已經是 DP 壓縮版**（無損那層是 r.base，三個有損是
  // 不帶 plain 的 itemsToMML），再讓 zipFinal 壓一次是白工。
  const writes = s.writes.map(w =>
    ({ i: w.i, out: w.out, before: texts[w.i] ?? "", raw: true }));

  // 驗證。兩層用不同的判準，而那正是它們的差別：無損用 sameEvents（逐音比對，基準是原文，因為它
  // 的承諾就是「跟你現在聽到的完全一樣」），有損用 sameOnsets（時值本來就會變，基準是壓縮後竹的文
  // 字 —— 無損壓縮本身會砍掉尾端休止）。
  const base = texts.slice(), after = texts.slice();
  for (const w of s.writes) {
    base[w.i] = lossless ? texts[w.i] ?? "" : optCalc.baseOf[w.i];
    after[w.i] = w.out;
  }
  const ok = lossless
    ? sameEvents(parseAll(base), parseAll(after))
    : sameOnsets(parseAll(base), parseAll(after));
  if (!ok) {
    optFail(i18n.t("ui.opt.verifyFailed"));
    return;
  }

  const picks = optScope === "sel"
    ? roll.selectedNotes().map(n => ({ tick: n.tick, midi: n.midi }))
    : null;

  //  旗標跟文字**擠進同一步 undo**：分成兩步的話按一次 Ctrl+Z 只會退回文字，而旗標還
  // 留著，下一次編輯又自己壓回去。四個方式都 arm，但一律只 arm 成無損 —— 自動重跑有損
  // 等於每動一個音就悄悄改一次音樂，而且是累積的（第二次會在第一次的結果上再修一次）。
  writeBackMany(writes, () => {
    for (const { i } of targets) tracks.setZip(i, ZIP_LOSSLESS);
  });
  closeOptimize();
  if (picks) reselect(picks);
  say(lossless
    ? i18n.t("ui.opt.doneLossless", { n: s.saved })
    : i18n.t("ui.opt.doneOptimize", { n: s.saved, changed: s.changed }));
}

/** 擋下來的原因寫在對話框裡，同 transpose 的 fail()。 */
function optFail(msg) { $("#optNote").textContent = msg; }

function initOptimize() {
  $("#optBtn").addEventListener("click", openOptimize);
  $("#optCancel").addEventListener("click", closeOptimize);
  $("#optOk").addEventListener("click", applyOptimize);
  $("#optBox").addEventListener("click", e => {
    if (e.target === $("#optBox")) closeOptimize();
  });
  $("#optScope").addEventListener("click", e => {
    const b = e.target.closest("button[data-scope]");
    if (!b || b.disabled) return;
    optScope = b.dataset.scope;
    recalcOpt();                 // 換範圍就要重算 —— 三個數字全部會變
    syncOptUI();
  });
  $("#optRules").addEventListener("click", e => {
    const b = e.target.closest("button[data-rule]");
    if (!b || b.disabled) return;
    optRule = b.dataset.rule;
    syncOptUI();
  });
  addEventListener("keydown", e => {
    if (e.key === "Escape" && $("#optBox").classList.contains("on")) closeOptimize();
  });
}

// ─── 分隔線 ─────────────────────────────────────────────────────────────────

/** 樂卜譜區的下限：只留分頁列與狀態列。量出來而不是寫死 —— 狀態列會因為警告文字換行而變高。 */
const minMainH = () => $("#tabs").offsetHeight + $("#status").offsetHeight;

/**
 * 捲軸的下限，兩條規則取小的那一個：MIN_ROLL_OCTAVES 個八度看得到（小節號尺 + 12 列 × `ROW_H` +
 * 捲軸高），或可用高度的一半。捲軸的高度要量而不是寫死 15px（macOS 的 overlay scrollbar 是 0）。
 *
 * 第 2 條修的是一個看不出成因的壞法：矮螢幕上分隔線完全拖不動。只有第 1 條時下限是一個固定高度，
 * 手機橫放（844×390）扣掉標題列、工具列後只剩約 300px —— `maxMainH()` 的 `avail - minRollH()` 是
 * 負的，於是上限等於下限、行程是 0。臨界值大約是視窗高 466px。夠高的螢幕行為一個像素都不變。
 *
 * @param {number} avail 捲軸與樂譜區可以分的總高度（見 maxMainH）
 */
function minRollH(avail) {
  const stage = $("#stage");
  const scrollbar = Math.max(0, stage.offsetHeight - stage.clientHeight);
  // 色點浮層不吃高度（它疊在捲軸上），竹所以這裡不必為它加任何東西。
  const octaves = RULER_H + MIN_ROLL_OCTAVES * 12 * ROW_H + scrollbar;
  return Math.min(octaves, Math.max(0, avail) / 2);
}

/**
 * 樂譜區的高度上限。
 *
 * 視窗太矮時兩個下限會打架，這時以樂譜區的下限為準，讓捲軸低於它的下限 —— 捲軸本來
 * 就有垂直捲軸可以捲，而分頁列與狀態列少了就不能切軌、也看不到狀態。
 *
 * 它現在是第二道防線：`minRollH` 自己會先讓到「可用高度的一半」。
 */
function maxMainH() {
  const avail = document.body.clientHeight
    - $("header").offsetHeight - $("#rollbar").offsetHeight - $("#splitter").offsetHeight;
  return Math.max(minMainH(), avail - minRollH(avail));
}

/** 設定樂譜區高度（夾在上下限之間）。捲軸會靠自己的 ResizeObserver 跟著重畫。 */
function setMainH(px) {
  const lo = minMainH(), hi = maxMainH();
  const h = Math.round(Math.min(hi, Math.max(lo, px)));
  $("main").style.flexBasis = h + "px";
  const sp = $("#splitter");
  sp.setAttribute("aria-valuenow", String(h));
  sp.setAttribute("aria-valuemin", String(Math.round(lo)));
  sp.setAttribute("aria-valuemax", String(Math.round(hi)));
  return h;
}

/** 3px 的分隔線，按住可女以改上下兩區的高度。取代了原本的「收起樂譜區」按鈕。 */
function initSplitter() {
  const sp = $("#splitter"), main = $("main");

  // 接回上次拖到哪。夾範圍在 setMainH 裡做，所以換了螢幕也不會出界。
  const saved = storage.loadUI()?.mainH;
  setMainH(Number.isFinite(saved) ? saved : main.offsetHeight);
  // main 的 CSS 初始值是 300px，剛好在新的上下限之間，所以第一次開站就是 300。

  let startY = 0, startH = 0, dragging = false;
  const remember = () => storage.saveUI({ mainH: main.offsetHeight });

  sp.addEventListener("pointerdown", e => {
    if (e.button !== 0) return;
    dragging = true;
    startY = e.clientY;
    startH = main.offsetHeight;
    sp.classList.add("dragging");
    document.body.classList.add("splitting");
    try { sp.setPointerCapture(e.pointerId); } catch { /* 抓不到也還是能用 */ }
    e.preventDefault();      // 不要順手選到文字
  });

  sp.addEventListener("pointermove", e => {
    if (dragging) setMainH(startH - (e.clientY - startY));
  });

  const end = () => {
    if (!dragging) return;
    dragging = false;
    sp.classList.remove("dragging");
    document.body.classList.remove("splitting");
    remember();
  };
  sp.addEventListener("pointerup", end);
  sp.addEventListener("pointercancel", end);

  sp.addEventListener("keydown", e => {
    const step = e.shiftKey ? 50 : 10;
    if (e.key === "ArrowUp") setMainH(main.offsetHeight + step);
    else if (e.key === "ArrowDown") setMainH(main.offsetHeight - step);
    else return;
    e.preventDefault();
    remember();
  });

  // 視窗變矮日時要重新夾一次，不然樂譜區會把捲軸擠到只剩幾十像素
  addEventListener("resize", () => setMainH(main.offsetHeight));
}

// ─── 標題列：四顆顯示開關 ───────────────────────────────────────────────────

/** 標題列上只在窄畫面出現的兩組：四顆顯示開關，以及收起四顆按鈕的漢堡選單（見 editor.css）。 */
function initHeaderNav() {
  const btn = $("#navToggle");

  // 名字從 js/i18n 填，不在 .cshtml 開 .resx key —— 那份是抽取工具產的，手加會讓既有
  // 的編號漂掉。
  const name = (el, text) => {
    el.title = text;
    el.setAttribute("aria-label", text);
  };
  name(btn, i18n.t("ui.hdr.menu"));

  const navOpen = () => $("header").classList.contains("navopen");
  const openNav = on => {
    $("header").classList.toggle("navopen", on);
    btn.setAttribute("aria-expanded", String(on));
  };

  btn.addEventListener("click", () => openNav(!navOpen()));

  // 點了面板裡任何一顆就收起來 —— 那四顆本來就各自開自己竹的框或抽屜。
  $("#navMenu").addEventListener("click", e => {
    if (e.target.closest("button")) openNav(false);
  });

  // 點外面收起來。掛捕獲階段：面板裡的 click 已經由上面那條處理掉，而別處的 handler
  // 可能 stopPropagation（例如對話框），冒泡階段會漏。
  document.addEventListener("click", e => {
    if (!navOpen()) return;
    if (e.target.closest("#navMenu, #navToggle")) return;
    openNav(false);
  }, true);

  addEventListener("keydown", e => {
    if (e.key !== "Escape" || !navOpen()) return;
    openNav(false);
    btn.focus();          // Esc 關掉的東西，焦點要回到開它的那顆
  });

  /**
   * 一個顯示開關。`cls` 掛在 body 上，CSS 在斷點裡靠它把對應的東西藏掉。class 名是「藏」、按鈕
   * 的 `.on` 是「顯示」，兩者刻意相反 —— CSS 那邊寫 `body.no-editor … {display:none}` 好讀得多，
   * 而按鈕上「亮著 = 看得到」才符合全站 toggle 的卜語言。
   *
   * 狀態不落地：它是「我現在想專心看捲軸」這種一次性的東西，落地的代價是「開站看不到文字區，
   * 以為壞了」。
   */
  const wireView = (sel, cls, label) => {
    const b = $(sel);
    if (!b) return;
    name(b, label);
    b.addEventListener("click", () => {
      const hidden = document.body.classList.toggle(cls);
      b.classList.toggle("on", !hidden);
      b.setAttribute("aria-pressed", String(!hidden));
      // 捲軸不用手動重畫：高度變了會觸發它掛在 #stage 上的 ResizeObserver。
    });
  };
  // 攤開寫而不是跑一張表：i18n 的 key 要以字面量出現在 `i18n.t(...)` 裡面，不然 grep
  // 不到、孤兒 key 測試也會把它們判成沒人用。順序照畫面由上到下。
  wireView("#viewTools",  "no-tools",  i18n.t("ui.hdr.tools"));
  wireView("#viewRoll",   "no-roll",   i18n.t("ui.hdr.roll"));
  wireView("#viewEditor", "no-editor", i18n.t("ui.hdr.editor"));
  wireView("#viewStatus", "no-status", i18n.t("ui.hdr.status"));

  initKeyboardHide();
  initPointerClass();
}

/**
 * 軟鍵盤頂上來時收掉打字用不到的那幾條，把高度讓給捲軸，離開文字區再放回來。手機上系統鍵盤會蓋
 * 掉半個畫面，剩下的那半要擠進捲軸、樂譜文字、工具列、樂器列與狀態列。
 *
 * 這一段換過方向：`.kbd` 原本是「自動收起鋼琴捲軸」，而打字的人要一邊看捲軸上的結果。現在收的日是
 * 工具列後三組、樂器列與狀態列，捲軸、播放組、分頁列全部留著（規則在 editor.css）。
 *
 * 用第二個 class（`.kbd`）而不是去動 `.no-tools` / `.no-status`：兩個位元分開記，自動與手動才互
 * 不干擾 —— 手動關掉工具列之後打字再離開不會被放回來，開關的高亮永遠反映他的選擇。
 *
 * `focusout` 要延到下一個 task 才判斷：從一個分頁的文字區跳到另一個時它排在 `focusin` 之前，當場
 * 收掉的話每換一次分頁那幾條都會閃回來一幀。
 */
function initKeyboardHide() {
  const inScore = el => el instanceof HTMLTextAreaElement && !!el.closest("#panes");
  const sync = () => document.body.classList.toggle("kbd", inScore(document.activeElement));

  addEventListener("focusin", sync);
  addEventListener("focusout", () => setTimeout(sync, 0));
}

/**
 * `body.coarse` / `body.touch` / `body.fine`：**觸控目標該做多大**。
 *
 * 判準是「實際輸入是什麼」而不是「螢幕多窄」—— 那正是 `body.joy` 已經選過的那一條
 * （README「遙桿模式下編輯區退場」：「遙桿的判準是『用手指』不是『螢幕窄』，平板橫放照
 * 樣會進這個模式」）。而 44×44 那組規則原本綁在 528px／480px 的斷點上，於是**平板橫放進
 * 得了遙桿模式、卻拿不到大的觸控目標** —— 1024×768 兩個條件一個都不符合。這裡把兩邊對齊。
 *
 * 三個 class，兩段時間：
 *
 *   `coarse`  還沒有任何輸入時的**猜測**，問 `pointer: coarse`。它當猜測沒問題（猜錯的
 *             成本只是第一次輸入前目標偏大或偏小），它有問題的是**當唯一真相** —— 接了
 *             滑鼠的平板照樣說自己是 coarse
 *   `touch`   第一次輸入是手指之後。壓過那個猜測
 *   `fine`    第一次輸入是滑鼠或觸控筆之後。**它的工作是把 coarse 的猜測關掉**，不然接
 *             滑鼠的平板會永遠停在大目標
 *
 * 掛 capture 相，這樣元件自己 `stopPropagation` 也還收得到。
 *
 * **這裡刻意用黏性的「最後一次輸入」，而 `pianoroll` 的 `snapDraw()` 用的是事件自己的
 * `pointerType`。** 兩邊判準不同是對的：整站版面不能跟著每一個事件跳，而單獨一次的落點
 * 就該看當下那一次是誰按的。不要順手統一它們。
 */
function initPointerClass() {
  const cls = document.body.classList;
  if (typeof matchMedia === "function") {
    cls.toggle("coarse", matchMedia("(pointer: coarse)").matches);
  }
  addEventListener("pointerdown", e => {
    const touch = e.pointerType === "touch";
    cls.toggle("touch", touch);
    cls.toggle("fine", !touch);
  }, { capture: true, passive: true });
}

// ─── 抽屜（設定、關於） ─────────────────────────────────────────────────────

/**
 * 兩個從右邊滑入的抽屜：
 *
 *   #settings    帳號、語言、自動存檔、調號、拍號、音色庫、樂器定義檔、刪除帳號
 *   #aboutPanel  站台說明、說明頁連結、特別感謝、使用技術、法律、版本
 *
 * 這些東西一年動不了幾次，卻原本固定佔走 264px 的側欄。開關方式跟既有的 #pasteBox 一致。
 *
 * 一支函式吃兩個抽屜，因為兩者的開合邏輯逐字相同（切 .on、切 scrim、聚焦關閉鈕、關的時候把焦點
 * 還給開它的那顆鈕、Esc 讓給 #pasteBox）—— 複製一份的話遲早會有人只修一邊。互斥是唯一新增的規
 * 則：兩個抽屜的 z-index 與位置完全相同，同時開著會看到一層點不掉竹的 scrim。
 */

function initDrawers() {
  const scrim = $("#scrim");

  const drawers = [
    { panel: $("#settings"),   close: $("#settingsClose"), opener: "#gear" },
    { panel: $("#aboutPanel"), close: $("#aboutClose"),    opener: "#aboutBtn" },
  ];

  const isOpen = d => d.panel.classList.contains("on");

  // 窄畫面上 #gear／#aboutBtn 住在收起來的 #navMenu 面板裡（display:none），那時
  // focus() 會安靜地失敗，焦點留在 body。面板收起來時漢堡鈕就是那條路的入口。
  const focusBack = sel => ($(sel)?.offsetParent ? $(sel) : $("#navToggle"))?.focus();

  const open = (d, on) => {
    // 先把另一個關掉。直接切 class 而不是呼叫 open(o, false)：那條路會把焦點還給舊
    // 抽屜的入口鈕，而下一行馬上又要搶到新抽屜的關閉鈕上。
    if (on) drawers.forEach(o => { if (o !== d) o.panel.classList.remove("on"); });
    d.panel.classList.toggle("on", on);
    // scrim 看的是「還有沒有人開著」，不是這一個的狀態 —— 寫成 toggle(on) 的話從一個
    // 抽屜切到另一個會把 scrim 關掉。
    scrim.classList.toggle("on", drawers.some(isOpen));
    if (on) d.close.focus();
    else focusBack(d.opener);
  };

  /** 全部關掉（scrim 與 Esc 用）。焦點還給**剛剛開著那一人個**的入口鈕。 */
  const closeAll = () => drawers.filter(isOpen).forEach(d => open(d, false));

  for (const d of drawers) {
    $(d.opener).addEventListener("click", () => open(d, !isOpen(d)));
    d.close.addEventListener("click", () => open(d, false));
  }
  scrim.addEventListener("click", closeAll);
  addEventListener("keydown", e => {
    // 貼上的後備視窗疊在更上層，Esc 先給它。這道閘門實測擋不住（原本的 initSettings 也擋不住）：
    // clipboard.js 在 window 上也掛了一個 keydown 而且先註冊先執行，Esc 進來時它已經把 #pasteBox
    // 的 .on 拿掉了。修法要動註冊順序或改用捕獲階段，那是兩邊的共同約定。
    if (e.key === "Escape" && !$("#pasteBox").classList.contains("on")) closeAll();
  });
}

/**
 * 設定抽屜裡的「離線音色庫」那一格。這一格在開發環境根本不存在（Index.cshtml 用
 * Env.IsDevelopment() 擋掉了），所以第一件事是確認元素在不在。
 *
 * 沒有「下載」按鈕，因為那個動作是多餘的：音色庫本來就會自己進快取（開站時無條件抓那 15 MB，而
 * SW 的 bankFirst 順手留一份），所以「未保留」通常只成立幾秒鐘。
 *
 * 剩下兩件真的要做的事都不需要使用者參與：已安裝但快取裡沒有 → 自己補一趟（只有「第一次造訪就
 * 安裝」的人會遇到，他一離線就完全沒有聲音；補那一趟不花流量，音色庫是 immutable），以及要一次
 * 持續性儲存（安裝是 Chrome 的啟發式最可能答應的時機）。按鈕只剩「失敗過之後的重試」這個用途。
 *
 * 代價：`persist()` 只有那兩條路問得到，所以裝不了 PWA 的瀏覽器（Firefox 桌機）永遠問不到它，
 * 那 15 MB 會一十直停在「系統空間不足時可能清除」。狀態列會照實說，而那才是這一格真正的內容。
 */
function initOfflineBank() {
  const box = $("#offlineBank");
  if (!box) return;

  const state = $("#offlineBankState");
  const btn   = $("#offlineBankGet");

  const mb = bytes => (bytes / 1048576).toFixed(1);

  /**
   * 自動那一趟只跑一次。這個旗標是必需的：render() 有四個觸發點，而「安裝完成」那一刻很容易同時
   * 滿足兩個 —— 少了它就是同時排兩趟 15 MB 的複製。失敗後的第二次機會由重試鈕負責。
   */
  let tried = false;

  /** 抓一趟，並把訊息與按鈕擺成結果該有的樣子。成功回 byte 數，失敗回 null。 */
  async function fetchNow() {
    state.textContent = i18n.t("ui.offlineBankWorking");
    btn.hidden = true;

    const bytes = await offline.download();
    // download() 回 null 有兩種原因（離線中、或沒有 SW 攔得到），對使用者來說都是
    // 「這次沒成功，可以再試」。
    if (bytes === null) {
      state.textContent = i18n.t("ui.offlineBankFailed");
      btn.hidden = false;
      btn.disabled = false;
    }
    return bytes;
  }

  async function render() {
    // 還沒被 SW 控制（第一次造訪就是這樣）—— 照實說。這時連「自己補一趟」都不能做：
    // 沒有人攔得下來，那個 fetch 會好好地回 200 而什麼都沒卜進 Cache Storage。
    if (!offline.active()) {
      state.textContent = i18n.t("ui.offlineBankInactive");
      btn.hidden = true;
      return;
    }

    let bytes = await offline.cachedBytes();

    // 整格唯一會主動花掉 15 MB 的地方，三個條件都要成立。`tried` 的檢查與設定之間
    // 沒有 await，所以並行的兩個 render() 不會都通過。
    if (bytes === null && offline.installed() && !tried) {
      tried = true;
      bytes = await fetchNow();
      if (bytes === null) return;   // 訊息與重試鈕已經由 fetchNow 擺好了
    }

    if (bytes === null) {
      // 沒安裝而且還沒進快取 —— 通常是開站那趟還在路上。不給按鈕：按了跟等著的結果
      // 一樣，只是把等待包裝成一個動作。
      state.textContent = i18n.t("ui.offlineBankAbsent");
      btn.hidden = true;
      return;
    }

    btn.hidden = true;
    state.textContent = await offline.persisted()
      ? i18n.t("ui.offlineBankReady", { mb: mb(bytes) })
      : i18n.t("ui.offlineBankReadyEvictable", { mb: mb(bytes) });
  }

  btn.addEventListener("click", async () => {
    btn.disabled = true;
    if ((await fetchNow()) !== null) await render();
  });

  // 第一次造訪日時這一格會先畫成「還沒啟用」，而那是對的（ui.js 跑的時候 SW 通常還在 install），但
  // 幾百毫秒後 clients.claim() 會接手這一頁、狀態就變舊了。它還多一個職責：第一次造訪就安裝的人
  // 靠這一刻補到音色庫。
  navigator.serviceWorker?.addEventListener("controllerchange", render);

  // 使用者在這個分頁按下安裝的那一刻。iOS 的「加到主畫面」不發這個事件，Firefox 桌機
  // 根本不能安裝 —— 所以這一條是加分而不是主力。主力是 offline.installed()。
  addEventListener("appinstalled", render);

  // 打開抽屜時重新問一次。沒有這一段的話「未保留」會是一句過期的話：它通常只成立幾
  // 秒鐘，而 render() 平常不會再跑。按鈕收起來之後，那句過期的話就是使用者唯一看得到
  // 的東西。掛在 #gear 而不是抽屜自己的開啟事件：initDrawers 沒有對外的開關事件。
  $("#gear").addEventListener("click", render);

  render();
}

// ─── 復原 / 重做 ────────────────────────────────────────────────────────────

/**
 * 工具列那兩顆按鈕的 disabled。只由 history 的 onChange 驅動 —— 堆疊會在「打字停了 400ms」那一刻
 * 自己變動，而那一刻沒有人會叫 refresh()。
 */
function syncHistoryButtons() {
  $("#undoBtn").disabled = !history.canUndo();
  $("#redoBtn").disabled = !history.canRedo();
}

function initHistoryButtons() {
  for (const [sel, act] of [["#undoBtn", history.undo], ["#redoBtn", history.redo]]) {
    const b = $(sel);
    // mousedown 上 preventDefault：按鈕不取得焦點，焦點原封不動留在原來那一十軌的
    // textarea 上，按完可以直接繼續打字。這也讓滑鼠跟 Ctrl+Z 收斂到同一個結果。
    // 只影響滑鼠，Tab 走到這兩顆再按 Enter 照常可用。
    b.addEventListener("mousedown", e => e.preventDefault());
    b.addEventListener("click", () => act());
  }
}

/**
 * 工具列的按鈕**不吃滑鼠焦點**，點完把焦點交給捲軸。
 *
 * 少了這一條，用滑鼠點過工具列之後那顆鈕會一直握著焦點，而那會壞掉兩件事：
 *
 *  1. **空白鍵不再是播放。** `spaceIsOurs` 看到焦點在 `<button>` 上就把空白鍵交還瀏覽器，
 *     於是它變成「再按一次剛剛那顆鈕」。
 *  2. **那顆鈕會莫名其妙亮起金框。** 用滑鼠點的當下不算 `:focus-visible`（所以看不出
 *     問題），但**下一次按任何鍵**時瀏覽器就會把焦點元素翻成 focus-visible —— 實際的症狀
 *     是「點了音長 2、畫完音符、按 `.` 切附點，那顆 2 突然亮起來」。
 *
 * 三個決定：
 *
 *  · **掛 `mousedown`，不是 `click`。** `#tempoBtn` / `#velBtn` / `#transBtn` / `#optBtn` /
 *    `#mergeBtn` 這五顆會開對話框，而對話框是在 `click` 裡把焦點放進自己的按鈕（見
 *    initTranspose 那幾支的開框那一行）。mousedown 早於 click，所以順序天然是對的：這裡先
 *    把焦點丟給捲軸，對話框再從那裡拿走。掛在 click 上會反過來把剛開好的對話框焦點打掉。
 *
 *  · **`#undoBtn` / `#redoBtn` 跳過。** 它們自己那一份 preventDefault 是刻意**不**搬焦點的
 *    （見 initHistoryButtons）—— 復原是「我打字打錯了」的動作，按完要能直接繼續打字。這裡
 *    套上 focusRoll 會把人踢出文字區。同一個立場也套在 tracks 那四顆圖示鈕上。
 *
 *  · **`#navMenu` / `#navToggle` 不在名單裡。** 那幾顆會開抽屜或選單，而全站的規矩是「Esc
 *    關掉的東西，焦點要回到開它的那顆」（見 initDrawers 的 `focusBack`）—— 焦點不進來就沒
 *    有東西可以還回去。`#viewToggles` 那四顆不開任何東西，所以納入。
 *
 *  **只影響滑鼠。** Tab 走到任何一顆再按 Enter／空白鍵照常可用，tabindex 一個字都沒動。
 */
function initToolbarFocus() {
  for (const sel of ["#rollbar", "#viewToggles"]) {
    const bar = $(sel);
    if (!bar) continue;
    bar.addEventListener("mousedown", e => {
      if (!(e.target instanceof Element)) return;
      const b = e.target.closest("button");
      if (!b || !bar.contains(b)) return;
      if (b.id === "undoBtn" || b.id === "redoBtn") return;
      e.preventDefault();
      focusRoll();
    });
  }
}

// ─── MP4 影片製作 ───────────────────────────────────────────────────────────

/**
 * 從檔案頁把目前樂譜交給另一個分頁的影片製作頁。
 *
 * window.open 必須在使用者點擊的同步呼叫鏈裡執行；先等待 Cache Storage 會讓瀏覽器把它視為
 * 彈出視窗。分頁使用固定名稱，使用者修改樂譜後重按會更新同一個影片分頁。
 */
async function openVideo() {
  const parsed = refresh();
  if (!parsed || !parsed.tracks.some(t => t.notes.length)) {
    say(i18n.t("stage.err.silent"));
    return;
  }

  // 沿用 main 的分享格式：影片目前只接收遊戲可用的前六軌平面 MML。
  const prepared = prepareShare(tracks.trackTexts(), tracks.programs());
  if (prepared.error) { say(prepared.error); return; }

  const tab = window.open("", "mml-video");
  if (!tab) { say(i18n.t("video.err.popup")); return; }

  try {
    const id = await handoff.put({
      payload: prepared.mml,
      name: $("#expName")?.value ?? "",
      builtinBank: bankBuiltin,
    });
    tab.location.replace(`${culturePrefix()}/waterfall#h=${id}`);
    tab.focus();
  } catch (err) {
    console.error("[影片製作] 交棒失敗", err);
    tab.close();
    say(i18n.t("video.err.store"));
  }
}

// ─── 接線 ───────────────────────────────────────────────────────────────────

export function init() {
  // 要在任何人動到那兩行提示之前抄下來
  rememberHintDefaults();

  engine.setStatusHandler(text => { $("#engine").textContent = text; });
  engine.setPresetListHandler(list => setPresets(list));
  player.setStopHandler(onStopped);
  storage.setSavedHandler(showStore);

  // 要在 tracks.init 之前 —— 它會把預設樂譜放進 textarea，而緊接著的
  // formatInitialTracks() 需要知道換行設定是什麼。
  initBarsPerLine();

  tracks.init({
    onChange: refresh,
    // 切分頁把焦點交給捲軸（而不是搶進文字區）。理由與代價見 tracks.selectTrack。
    onFocusRoll: focusRoll,
    // 演奏中換樂器，下一個音就生效
    onInstrumentChange: i => { if (player.isPlaying()) applyInstruments([i]); },
    // 換軌：捲軸重畫，選取改讀新那一軌竹的原生選取（每一軌各有自己的），不然上一軌的
    // 多段位移會套到這一軌的文字上。尺也要重畫 —— 每一軌各有自己的行結構。
    onSelect: i => {
      roll.setActive(i);
      syncEditable();
      syncRangesFromNative();
      syncSelection();
      syncBarRuler();
    },
    // 拖曳分頁改音軌順序。包成一步 undo —— 一次拖曳可能同時動到六軌的文字與樂器。
    onReorder: (from, to) => history.edit(() => tracks.reorder(from, to)),
    // 移除分頁。一定要能復原 —— 刪中間會把後面所有軌的內容往前移一格。history.edit
    // 的前後快照沒差就不記，所以按了確認框的「取消」不會留空步。
    onRemove: i => history.edit(() => tracks.removeTrackAt(i)),
    // 新增分頁也要記。不記的話它會被摺進下一步的 before 快照裡 —— 於是「編輯音符 →
    // ＋新增 → Ctrl+Z」會一次退掉兩件事。也順便補平「刪能復原、加不能」的不對稱。
    onAdd: () => history.edit(() => tracks.addTrack()),
    // 打字：先把多段選取塌掉再記帳。`input` 比 `selectionchange` 早，不塌的話緊接著
    // 的 refresh() 會拿改字前的位移去畫黃底，閃一幀錯的畫面。
    onTyping: () => { syncRangesFromNative(); history.typed(); },
    // 靜音變了就整批重送。沒有 `if (player.isPlaying())` 這道判斷，跟換樂器那條不同
    // —— 試聽走的是同一個 channel，而靜音那一軌的試聽也該是安靜的。
    onMuteChange: applyMutes,
  });

  // 尺與上色層跟著 textarea 捲。用捕獲階段掛在 #panes 上，一人個 listener 管六個分頁
  // —— scroll 不會冒泡，但捕獲階段抓得到。
  $("#panes").addEventListener("scroll", syncTextLayerScroll, true);

  initHighlight();
  initTheme();

  // Delete / Backspace：選取涵蓋到音符時填休止符而不是刪字（見 onScoreKeyDown）。
  // 捕獲階段掛在 #panes 上，搶在 textarea 自己處理之前 —— preventDefault 要來得及。

  // 同一件事的捲軸入口。掛在 #stage 上而不是 document —— 這條只在「焦點屬於捲軸」時
  // 才該生效，而那件事的定義就是「焦點在 #stage 裡面」。

  // IME 組字中把文字還給 textarea：組字中的字還沒進 value，而 value 的文字是透明的。
  // MML 本身是純 ASCII，但註解可以寫中文，而站上有日文與韓文版。
  $("#panes").addEventListener("compositionstart", () => {
    document.body.classList.add("hl-composing");
  }, true);
  $("#panes").addEventListener("compositionend", () => {
    document.body.classList.remove("hl-composing");
    paintHighlight();
  }, true);

  // 上色層的寬度要跟著 textarea 變。觀察 textarea 自己而不是視窗：小節尺出現時視窗
  // 沒變，但 textarea 窄了 46px —— 而寬度差一點點，軟換行就斷在不同竹的字。
  if (window.ResizeObserver) {
    const ro = new ResizeObserver(syncOverlayWidth);
    for (const ta of document.querySelectorAll(".pane textarea")) ro.observe(ta);
  }

  // 復原／重做：捲軸寫回是 textarea.value = …，那會清掉瀏覽器原生的 undo 歷史，
  // 所以 Ctrl+Z 整個自己管。工具列上另外有兩顆按鈕走同一組 undo()/redo()。
  initHistoryButtons();
  // 工具列與檢視開關的按鈕不吃滑鼠焦點（要跟 initHistoryButtons 一起讀：那兩顆是它的
  // 例外）。委派在容器上，所以之後新增的按鈕自動涵蓋。
  initToolbarFocus();
  // 快照包一層，把拍號與段落標記也記進 undo（插刪小節時它們的位移本來就在同一步裡）。不動
  // tracks.js：拍號與標記是曲子的屬性，不是分頁的狀態，包在這裡是唯一不讓 tracks 認識它們的做法。
  history.init({
    snapshot: () => ({ ...tracks.snapshot(), meters: meters.stored(), marks: marks.stored() }),
    restore: s => {
      tracks.applySnapshot(s);
      meters.set(s.meters);
      marks.set(s.marks);
    },
    onApply: refresh,
    onChange: syncHistoryButtons,     // init 裡的 reset() 會順便把初始狀態同步好
  });

  roll.init({
    canvas: $("#roll"),
    padEl: $("#rollpad"),
    scroller: $("#stage"),
    getTrackCount: tracks.trackCount,
    getGhostFlags: tracks.ghostFlags,
    // 點音符 → MML 游標跳到它對應的那段文字。這同時是驗收工具 —— 對得上就證明
    // tick ↔ 像素 ↔ 原文位置三方一致。
    onPickNote: pickNote,
    onRangePick: pickRange,
    onTogglePick: togglePick,
    // 空白處拉方框圈卜選 → 把選取設成剛好這一組音（Ctrl＋框則是「原本那組 ∪ 框到的」，
    // 併集在捲軸那邊就算好了）。這裡只負責一組音 → 一組字元範圍。
    onSetPicks: setPicks,
    onPickGhost: pickGhost,
    onAddNote: addNote,
    onDeleteNote: removeNote,
    // 遙桿面板的紅色刪除鍵。走 Delete 鍵與選單「刪除音符」的同一個函式。
    onDeleteSelection: removeNotes,
    onMoveNote: arg => arg.picks ? relocateNotes(arg) : relocateNote(arg),
    onAudition: auditionOn,
    onAuditionEnd: auditionOff,
    onAuditionNote: auditionNote,
    onPlayItem: highlightPlaying,
    onRangeChange,
    onCopySelection: pickedFragment,
    onPasteAt: pasteAt,
    onVelocity: nudgeVelocity,
    onSelectAll: selectAllLane,
    onDuplicate: duplicateSelection,
    isLaneArea,
    // 右鍵（或觸控長按）：pianoroll 只回報「在哪裡按了」，內容全部在這邊組
    onContextMenu: openRollMenu,
    onNoteMenu: openNoteMenu,
    onMeterMenu: openMeterMenu,
    onViewChange: layoutMarks,
    onBarMenu: openBarMenu,
    // 雙擊音符 → caret 跳到它的字尾。**唯一一條把焦點拉回文字區的路**，見 jumpToText。
    onJumpText: jumpToText,
    onNonstdFix: fixNonstd,
  });
  roll.setActive(tracks.activeTrack());

  // Tab／Shift+Tab 跳進文字區也是「焦點搬家」（見 quietFocus）。掛 capture：焦點的
  // 轉移就發生在這個 keydown 的預設行為裡，記帳一定要比它早。用 `key === "Tab"` 一次
  // 涵蓋 Shift+Tab。記帳多算一次竹的代價只是「這一輪不捲」。
  document.addEventListener("keydown", e => { if (e.key === "Tab") quietly(() => {}); }, true);

  // 使用者在文字區選取 → 捲軸把那些音符框起來。這是多選的入口。
  // 掛在 document 上：selectionchange 不會在 textarea 自己身上觸發。
  document.addEventListener("selectionchange", () => {
    const ta = tracks.activeArea();
    if (document.activeElement !== ta) return;
    // 使用者自己動了選取（不是 setRanges 設的）→ 多段塌回一段。理由見 selRanges。
    // `quietFocus` 刻意不放進這個判斷：焦點搬進另一軌之後選取本來就該改讀新那一軌的。
    if (!progSel) syncRangesFromNative();
    // origin 是 "text" 才會捲捲軸。`quietFocus` 期間一律當成「不是使用者在文字裡移動
    // 游標」—— 那是 Tab 跳進文字區時「畫面不跳」的那一刀。
    syncSelection(progSel || quietFocus ? null : "text");
  });

  // 貼上是可以復原的，所以包在 edit() 裡。這兩個模組的 onImport 收 onExternalText 而
  // 不是 refresh —— 它們的共同點是「外面來的文字整批取代了分頁」，那時換行設定要退回
  // 不換行。載入分享連結也走這裡（sharebox 呼叫 clipboard.importText()）。
  clipboard.init({ onImport: onExternalText, wrapEdit: history.edit });
  // 匯入走跟「貼上」完全一樣的落地路徑。getSong 仍然是 refresh —— 那是「給我目前的解析結果」，不
  // 是匯入事件。onClear 差一件事：不重置「MML 木格式化換行」，因為清空之後沒有文字。
  filebox.init({
    onImport: onExternalText,
    onClear: () => { if (player.isPlaying()) { selBeforePlay = null; player.stop(); } refresh(); },
    // 「新增」= 開一份新檔案，所以儲存框的基準與「同一份是哪一份」都要清掉。
    onNew: savebox.forget,
    wrapEdit: history.edit,
    getSong: refresh,
    // 混音匯出。**在這裡再擋一次「這首是空的」** —— 按鈕本身跟 setHasNotes 綁著，但
    // 那是上一次 refresh() 的答案，而使用者可能在框開著的時候把譜清掉。
    // 回傳「開起來了沒」：檔案框要等這個答案才關（見 filebox 的 #mixGo）。
    onMix: () => {
      const song = refresh();
      if (!song || !song.tracks.some(t => t.notes.length)) { say(i18n.t("stage.err.silent")); return false; }
      mixstage.open();
      return true;
    },
  });
  $("#videoOpen").addEventListener("click", openVideo);
  savebox.init({
    // 開啟一份存檔 = 整批換掉內容，跟貼上／載入分享同一條路。但不走 onExternalText
    // —— 那一支會叫 savebox.detach()，而開啟存檔的意思剛好相反（見 savebox.openFile）。
    onOpen: () => {
      if (player.isPlaying()) { selBeforePlay = null; player.stop(); }
      setBarsPerLine(0, false);
      refresh();
    },
    wrapEdit: history.edit,
    getSong: refresh,
  });

  // 儲存框的入口住在檔案框裡。換頁而不是疊層（同 #fileBox → #midiBox）：兩層對話框
  // 很難看懂，而且第二層要處理「Esc 該給誰」這種沒有好答案的問題。
  $("#saveOpen").addEventListener("click", () => {
    $("#fileBox").classList.remove("on");
    savebox.open();
  });

  // ─── Ctrl+S ───────────────────────────────────────────────────────────────
  //
  // 掛在 window 上（同 history.js 的 Ctrl+Z）—— 按下它的時候焦點幾乎一十定在某條 textarea 裡。
  // preventDefault 一定要無條件先做，即使 quickSave 最後什麼都不做：不擋的話瀏覽器會跳出「另存新
  // 檔」，而一個「有時候會跳出存網頁對話框」的快捷鍵比沒有這個快捷鍵更糟。不理 Alt 與 Shift。
  addEventListener("keydown", e => {
    if (!(e.ctrlKey || e.metaKey) || e.altKey || e.shiftKey) return;
    if (e.key.toLowerCase() !== "s") return;
    e.preventDefault();
    savebox.quickSave();
  });

  account.init();
  // 混音匯出的舞台。入口在檔案框的匯出區，**點下去會把檔案框關掉**（換頁，不是疊上去）。
  mixstage.init({
    getSong: refresh,
    getBank: bankSource,
    // 試聽前要做的，跟按下演奏前那一步是同一份：不送的話用的會是合成器上一次留下的
    // 音色，改過軌序就整首錯位。靜音由 mixstage 自己安排（它要讓試聽等於匯出）。
    prepare: () => {
      const parsed = refresh();
      if (parsed) applyInstruments(parsed.tracks.map((_, i) => i));
    },
    // 試聽收掉之後把編輯器的靜音放回去 —— mixstage 在試聽期間會把它整組改掉。
    restore: applyMutes,
  });

  sharebox.init();

  // 語言選單。傳 snapshot 進去 —— 換語言會重載頁面，而關掉自動存檔的人沒有任何存下
  // 來的東西（見 lang.js 開頭）。
  lang.init(tracks.snapshot);

  // 剛剛是換語言進來的？把寄放的樂譜接回來。要在 showStore 之前 —— 接回來之後狀態列
  // 該講的是這一份。applySnapshot 走 history 用的同一條路，所以樂器與靜音也一起回來。
  const handoff = lang.takeHandoff();
  if (handoff?.snapshot) {
    tracks.applySnapshot(handoff.snapshot);
    refresh();
  }

  initSplitter();
  initHeaderNav();

  // 接回暫存的話講一聲 —— 使用者看到的不是預設樂譜，要讓他知道為什麼
    showStore(tracks.restoredAt(), i18n.t("ui.store.restored"));

  $("#play").addEventListener("click", onPlayClick);
  $("#stop").addEventListener("click", player.stop);
  // 播放的快捷鍵。掛在 window 上（同 pianoroll 竹的兩個 keydown）—— canvas 沒有焦點可言。
  // 守衛全部在 onTransportKey 裡。
  addEventListener("keydown", onTransportKey);

  // 鍵盤上的媒體鍵與系統媒體控制。一條新的播放邏輯都沒有 —— 四個回呼全部接到上面那
  // 五顆鍵已經在用的東西，所以媒體鍵不可能跟快捷鍵做出不一樣的事。
  mediakeys.init({
    // `play` / `pause` 分開處理，不套 `onPlayClick` 這個 toggle：系統送 `play` 時它要
    // 的是「播」，而 toggle 在正在播時會去暫停。各自加上狀態守衛之後重複送是無害的。
    // `#play` 是灰的時一律不動作 —— 同空白鍵那條規則。
    onPlay:  () => { if (!sounding() && !$("#play").disabled) onPlayClick(); },
    onPause: () => { if (sounding()) onPlayClick(); },
    onStop:  player.stop,
    // 跟 ←→ 同一條路（含夾在播放範圍內、釘導播線、一次性 reveal）。
    onSeekBars: n => { if (player.isPlaying()) moveHead(tickPlusBars(headTick(), n)); },
  });
  initLoop();
  initHome();
  initTempo();
  initVelocity();
  initTranspose();
  initMerge();
  initOptimize();
  initKeySig();
  // 要在上面那個 showStore 之後 —— 它會 renderStore()，而「已接回上次的樂譜」那一行
  // 得先寫進 lastSavedAt 才重畫得出來。
  initAutosave();

  initDrawers();
  // 排在 initDrawers 之後：它會掛 #gear 的處理器，而這一格也要掛一個（打開抽屜日時重新
  // 問一次狀態，理由見 initOfflineBank）。
  initOfflineBank();

  $("#dls").addEventListener("change", async e => {
    const f = e.target.files[0]; if (!f) return;
    // 內建的 .def 只對內建音色庫有意義。換了音色庫還拿它當白名單，會用 6 個編號去篩
    // 人家的音色庫，看起來就像壞了。
    if (defBuiltin) { defMap = new Map(); defNames = new Map(); defLabel = ""; defBuiltin = false; }
  $("#dlsName").textContent = i18n.t("ui.bankReading");
    // 第四個參數是那個 File 本身：混音匯出的 Worker 要自己再讀一次（見 bankFile）。
    try { await loadBank(await f.arrayBuffer(), f.name, false, f); }
    catch (err) {
      console.error(err);
    $("#dlsName").textContent = i18n.t("ui.bankFailed");
    say(describe(err, i18n.t("ui.bankLoadError")));
    }
  });

  $("#def").addEventListener("change", async e => {
    const f = e.target.files[0]; if (!f) return;
    if (!applyDef(await f.arrayBuffer(), f.name, false)) {
    say(i18n.t("ui.defUnparsed"));
      return;
    }
    if (rawPresets.length && !presets.some(p => defMap.has(p.program)))
    say(i18n.t("ui.defNoMatch", { n: defMap.size }));
  });

  // 拍號與段落標記的接線。一定要在 roll.init() 之後，跟下面 `formatInitialTracks()` 同一條規則：
  // 卜這兩個 init 會裝上 `meters` / `marks` 的變更處理器，而那兩個處理器會呼叫 `refresh()` →
  // `roll.setSong()` → `syncPad()`，那裡的 `padEl` 在 roll.init 之前是 undefined、直接 TypeError。
  // 而處理器在 `tracks.init()` 裡就會被觸發，所以裝在它之前的話，只要使用者存過一個非 4/4 的拍
  // 號，開站就會逃出 init() —— 表現是「拍號和標記讀不回來」，實際上是整個編輯器已經死了。
  //
  // 代價是 `tracks.init()` 的還原不會觸發處理器，所以這兩個 init 各自要主動同步一次。
  initTimeSig();
  initMarkBox();

  // 預設樂譜照設定排一次。位置很敏感：一定要在 roll.init() 之後 —— setTrackText 會走
  // touch() → onChange() → refresh() → roll.setSong()，而捲軸還沒 init 時那裡的 padEl 是 null，
  // 直接 TypeError 而且會一路逃出 init()。表現是「整個編輯器像死了但沒有明顯錯誤」。
  formatInitialTracks();
  // 重排完才把 undo 的基準點訂在這裡。history.init 的 reset() 已經跑過了，那時的基準
  // 是還沒排版的文字；不重訂的話第一次打字按 Ctrl+Z 會跳回沒排版的樣子。
  history.reset();

  refresh();   // 這一步會把樂譜餵給捲軸並畫出來

  // 分享連結帶進來的樂譜。放在最後 —— 它會走 clipboard.importText()（要分頁已經建好），
  // 而且「要不要蓋掉你的草稿」這個問題要問 tracks 有水沒有接回暫存。
  sharebox.boot();
}
