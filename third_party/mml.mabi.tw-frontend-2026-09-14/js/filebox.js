// ────────────────────────────────────────────────────────────────────────────
//  檔案：匯入 .mid / .mml / .mmi / 裸 MML@ / 五線譜圖片，以及另存 MIDI
//
//  三個對話框接力，任何時候只有一個開著：#fileBox、#omrBox、#midiBox。換頁不疊加，
//  沒有堆疊也沒有「返回」。解析全在別處：midi-in.js、mml-in.js、musicxml-in.js。
//
//  MML 不繞 items → itemsToMML（重新壓縮平均 +56 字，並丟掉原作者的排版與小節標記），
//  直接搬文字。列的形狀因此有兩種，月用 kind 分辨：
//    kind "midi"  { on, mode, notes:[], index, label, noteCount, drum }
//    kind "mml"   { on, index, label, text, program, notes, chars, readonly }
// ────────────────────────────────────────────────────────────────────────────

import {
  MAX_TRACKS, MIN_TRACKS, GAME_TRACKS, MAX_TRACK_CHARS, HARD_TRACK_CHARS,
} from "./config.js";
import { $, say, slotToIndex, gridSlotAt } from "./util.js";
import { toMIDI } from "./midi-out.js";
import * as meters from "./meters.js";
import * as marks from "./marks.js";
import {
  parseSMF, inventory, buildImport, fileOrigin, trimWarnings, VOICE_LANES, MidiError,
} from "./midi-in.js";
import { parseScore } from "./mml-in.js";
import { parseMusicXML, MusicXmlError } from "./musicxml-in.js";
import { toMml, toMmi, safeFileName, stripExt } from "./mml-out.js";
import * as tracks from "./tracks.js";
import * as i18n from "./i18n.js";

let onImport = () => {};
let onMix = () => {};
let onClear = () => {};         // 清空之後要停播 + 重新解析，但**不重置換行設定**
let onNew = () => {};           // 「新增」多做的那一件（儲存框要把未儲存的基準清掉）
let wrapEdit = fn => fn();      // 匯入要能復原，由 ui 注入 history.edit
let getSong = () => null;       // 另存 MIDI 要目前的解析結果，由 ui 注入 refresh

/** 目前卜這個檔案盤點出來的列。每一列多 on（以及 midi 的 mode）記使用者的選擇。 */
let rows = [];

/** 這一批列是哪一種："midi" | "mml"。決定畫哪些欄、以及按哪條路落地。 */
let kind = "midi";

/**
 * 這一次要「取代全部」還是「接在後面」。預設 false（新採譜）—— 它**會**毀掉已有的工作，
 * 所以匯入包成一步 history.edit（警示見 syncAppend）。
 */
let append = false;

/**
 * 追加要從第幾軌開始寫。**在切換模式時算一次就好** —— `tracks.appendAt()` 要對 15 個
 * textarea 各跑一次 `bareTrack`，不能放進每次勾選都會跑的 `syncFoot`。
 */
let appendAt = 0;

/** 整個檔案裡最早的音符 tick。**與勾了哪幾列無關**，見 midi-in.fileOrigin。 */
let origin = 0;

/** 目前這個檔案的速度圖（parseSMF 已經去重過）。只有第 1 軌會用到。 */
let tempos = [];
// 這個檔案帶進來的拍號。MIDI／MusicXML／MML 三條路都往這裡放，落地時再套用。
let fileMeters = [];
let fileMarks = [];

/** 聲部清單是不是從 #omrBox 走過來的。只決定那個框按「取消」是關掉還是退回 #omrBox。 */
let midiFromOmr = false;

/** 剛才讀的那個檔案叫什麼。**匯入成功時**才填，不是選檔時。 */
let srcName = "";

const fileBox = () => $("#fileBox");
const midiBox = () => $("#midiBox");

const MODES = [
  ["melody", i18n.t("fileBox.mode.melody")],
  ["root",   i18n.t("fileBox.mode.root")],
  ["both",   i18n.t("fileBox.mode.both")],
  ["voices", i18n.t("fileBox.mode.voices", { n: VOICE_LANES })],
  ["all",    i18n.t("fileBox.mode.all", { n: MAX_TRACKS })],
];

/**
 * 一人個模式**最多**會佔掉幾個軌位。**這是上限不是實際值** —— 真實軌數要跑完聲部分離才
 * 知道，而那可能要跑一秒，不能在勾選時跑。匯入完成的訊息裡才講真實值。
 */
const MODE_COST = { both: 2, voices: VOICE_LANES, all: MAX_TRACKS };

const cost = row => (row.on ? (MODE_COST[row.mode] ?? 1) : 0);

/** 追加時還剩幾個軌位。新採譜是全部 15 軌。 */
const budget = () => MAX_TRACKS - (append ? appendAt : 0);

/**
 * 開清單時預設勾到第幾列、表頭的全選最多勾到第幾列 —— `MAX_TRACKS`，第 16 列之後
 * **沒有地方可以放**。
 */
const PICK_LIMIT = MAX_TRACKS;

/** 全選／全部取消。**全選也會把第 16 列之後取消掉**。 */
function pickAll(on) {
  rows.forEach((r, i) => { r.on = on && i < PICK_LIMIT; });
}

/** 表頭那顆勾的三態，對齊「按下去會發生什麼」而不是「有沒有東西被選」。 */
function syncPickAll() {
  const box = $("#pickAll");
  if (!box) return;
  const full = rows.length > 0 && rows.every((r, i) => r.on === (i < PICK_LIMIT));
  box.checked = full;
  box.indeterminate = !full && rows.some(r => r.on);
}

// ─── 匯出 ───────────────────────────────────────────────────────────────────

/** 三個山出口共用的檔名欄。 */
const nameField = () => $("#expName");

/** **這首曲子叫什麼**，這個欄位是正本 —— 儲存框的檔名欄是它的第二個視窗。 */
export const songName = () => nameField()?.value ?? "";
export const setSongName = v => { const el = nameField(); if (el) el.value = v; };

/** 丟一個檔案給瀏覽器下載。**成功時不說話**。 */
function download(data, mime, ext) {
  const blob = new Blob([data], { type: mime });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = `${safeFileName(nameField()?.value)}.${ext}`;
  a.click();
  URL.revokeObjectURL(a.href);
}

/**
 * 按下「下載」：照下拉選的格式產一個檔。`.mml` / `.mmi` 的字串全在 mml-out.js。標題用
 * 檔名欄裡的**原始**文字，不套 safeFileName —— 那些保留字元是檔案系統的規矩，不是 INI
 * 的。不加 BOM：3MLE 只會把它當成 `[Settings]` 前面的垃圾字元。
 */
function save() {
  const song = getSong();
  if (!song) return;

  const fmt = $("#expFmt")?.value ?? "mid";
  if (fmt === "mid") {
    // 拍號寫成 0x58。**這是唯一無損的出口**：`.mmi` 的 `[time-signature]` 是私有區塊、
    // `.mml` 只裝得下一個拍號，只有 SMF 是木標準又支援變拍。
    download(toMIDI(song, tracks.programs(), meters.stored(), marks.stored()), "audio/midi", "mid");
    return;
  }

  const texts = tracks.trackTexts();
  const title = (nameField()?.value ?? "").trim();
  const text = fmt === "mml"
    // programs 有給就會寫出 [3MLE EXTENSION]（樂器與軌名），見 mml-out.toMml
    ? toMml(texts, { title, programs: tracks.programs(), meters: meters.stored(), marks: marks.stored() })
    // 跟 MML 文字裡的第一個 t 是同一個值 —— parseAll 已經算好了
    : toMmi(texts, {
      title, programs: tracks.programs(),
      bpm: song.tempos?.[0]?.bpm ?? 120, meters: meters.stored(), marks: marks.stored(),
    });
  download(text, "text/plain;charset=utf-8", fmt);

  // **`.mml` 帶不走變拍**：那個格式的拍號住在擴充區塊的 tag 0x04，那筆記錄沒有位置欄位。
  if (fmt === "mml" && meters.stored().some(m => m.tick > 0))
    say(i18n.t("fileBox.savedMmlMeters"));

  // `.mmi` 的 mml-track 在格式上是「一個樂器含最多 3 個聲部」，15 個單聲部 mml-track
  // 在 3MLE 裡的行為**沒有人驗過**，所以要講一聲。
  if (fmt === "mmi" && texts.length > GAME_TRACKS)
    say(i18n.t("fileBox.savedMmi", { n: texts.length }));
}

let hasNotes = false;
let bankReady = false;

/**
 * 沒有音符就沒有東西可以存。ui.refresh() 每次解析完都會叫。
 *
 * 混音與影片匯出多一個條件（音色庫），所以兩顆鈕的 disabled 由 syncMedia() 一處算 —— 兩個地方各
 * 設一次的話，後叫到的那個會把另一個的判斷擦掉。
 */
export const setHasNotes = has => {
  hasNotes = has;
  const b = $("#expGo"); if (b) b.disabled = !has;
  syncMedia();
};

/** 音色庫載好了沒。混音與影片入口一起等它，避免相鄰輸出功能一亮一灰卻沒有原因。 */
export const setBankReady = ok => { bankReady = ok; syncMedia(); };

function syncMedia() {
  const title = !bankReady ? i18n.t("fileBox.mixNeedBank")
              : !hasNotes ? i18n.t("fileBox.mixEmptyScore")
              : "";
  for (const id of ["#mixGo", "#videoOpen"]) {
    const b = $(id);
    if (!b) continue;
    b.disabled = !hasNotes || !bankReady;
    b.title = title;
  }
}

// ─── 讀檔 ───────────────────────────────────────────────────────────────────

const showErr = msg => {
  const el = $("#fileErr");
  el.textContent = msg;
  el.hidden = false;
};
const clearErr = () => { $("#fileErr").hidden = true; };

/**
 * 讀一個檔案並開啟聲部清單。選檔與拖放都走這裡。**靠內容分派，不靠副檔名** —— `.mml`
 * 至少裝過兩種東西（3MLE 專案檔、裸的 MML 文字）。
 */
async function read(file) {
  if (!file) return;
  clearErr();
  srcName = file.name ?? "";
  midiFromOmr = false;

  let buf;
  try {
    buf = new Uint8Array(await file.arrayBuffer());
  } catch (err) {
    showErr(i18n.t("fileBox.readFailed", { msg: err.message }));
    return;
  }

  // SMF 的前四個位元組一定是 "MThd"。先問它 —— 二進位檔硬解成文字會 sniff 回 null，
  // 錯誤訊息就變成「認不出木格式」。
  if (buf.length >= 4 && buf[0] === 0x4d && buf[1] === 0x54 && buf[2] === 0x68 && buf[3] === 0x64)
    return readMidi(buf, file.name);

  return readText(buf, file.name);
}

function readMidi(buf, name) {
  let smf, list;
  try {
    smf = parseSMF(buf);
    list = inventory(smf);
  } catch (err) {
    showErr(err instanceof MidiError ? err.message
      : i18n.t("fileBox.readFailed", { msg: err.message }));
    return;
  }
  if (!list.length) { showErr(i18n.t("fileBox.noNotes")); return; }

  // Format 2 的每個 MTrk 是獨立的樂段、不是同時發生的聲部。這裡一列 = 一組
  // (MTrk, channel)，只勾一個樂段完全正確，同時勾多個才會疊錯。所以不拒絕。
  const notes = [...smf.warnings];
  if (smf.format === 2)
    notes.push(i18n.t("fileBox.format2"));

  kind = "midi";
  rows = list.map(r => ({ ...r, on: false, mode: "melody" }));
  tempos = smf.tempos;
  fileMeters = smf.meters ?? [];
  fileMarks = smf.marks ?? [];
  // **整個檔案**的起點，不是被勾起來那幾列的起點 —— 這樣同一個檔案採幾次都對得齊。
  origin = fileOrigin(list);

  fileBox().classList.remove("on");     // 換頁，不是疊上去
  openList(name, notes);
}

/**
 * .mml / .mmi / 裸 MML@。編碼：3MLE 會在 `[Settings]` 裡宣告 `Encoding=big5`，而標題欄
 * 可以是中文（MML 本文是純 ASCII）。先月用 UTF-8 解一次讀那個宣告，宣告了 big5 就整份重解。
 */
function readText(buf, name) {
  let text = new TextDecoder("utf-8").decode(buf);
  if (/^\s*Encoding\s*=\s*big5\s*$/im.test(text)) {
    try { text = new TextDecoder("big5").decode(buf); }
    catch { /* 這個瀏覽器沒有 big5，就用 UTF-8 那份 —— MML 本文照樣是對的 */ }
  }

  const r = parseScore(text);
  if (!r) {
    showErr(i18n.t("fileBox.unknownFile"));
    return;
  }
  if (!r.parts.length) { showErr(r.warnings[0] ?? i18n.t("fileBox.noNotes")); return; }

  kind = "mml";
  // `.mml` 的標籤補上樂器名 —— mml-in 只給得出**軌名**（它一行 DOM 都不碰）。`.mmi` 不補：
  // 它的標籤本來就是檔案寫的 `name=`（`lute` / `piano`）。音色庫沒載完時 programName 回空。
  rows = r.parts.map(p => ({
    ...p,
    on: false,
    label: r.kind === "mml"
      ? [p.label, tracks.programName(p.program)].filter(Boolean).join(" · ")
      : p.label,
  }));
  tempos = [];
  fileMeters = r.meters ?? [];
  fileMarks = r.marks ?? [];
  origin = 0;                            // MML 是直接搬文字，沒有經過 origin 那條路

  const label = r.title ? `${name} · ${r.title}` : name;
  fileBox().classList.remove("on");
  openList(label, r.warnings);
}

// ─── 匯入五線譜（圖片） ─────────────────────────────────────────────────────
//
//  N 弓張圖 → N 份 MusicXML → parseMusicXML(pages) → 跟 MIDI 完全同一個聲部清單。縫合
//  （拍號跨頁帶、每頁用自己的 divisions、tick 依序接）在 musicxml-in.js。
//
//  **頁序拼歪不會報錯** —— 辨識照跑、MML 照產出，只是曲子錯了。所以有縮圖、拖曳、←／→。
//
//  送出後**鎖住整個框**：輪詢綁在 readSheets() 的呼叫堆疊上，框關掉那個 await 還在跑但
//  沒有人接結果。三個狀態由 omrState() 算出來，能做什麼全部由 omrSync() 一處決定。

//  ─── 上限：跟伺服器的同一組數字 ───
//
//  **這四個是複製品**，正本在 Omr/OmrOptions.cs（MaxPages / MaxUploadMb / MaxTotalMb /
//  MaxPdfPages）。兩邊會漂移，唯一會發出聲音的是 test/omrbox.test.mjs 那條斷言。
export const OMR_MAX_PAGES = 12;
export const OMR_MAX_MB = 20;
export const OMR_MAX_TOTAL_MB = 25;

//   **PDF 的頁數上限這裡只用來顯示，擋不了。** 頁數是伺服器數的，超過是 /api/omr
//  擋的（前端沒有 PDF 解析器，見 omrAdd）。這個常數只是為了讓文案講得出數字。
export const OMR_MAX_PDF_PAGES = 40;

/**
 * PDF 的進度估算：一頁大約幾秒。**一份 PDF 是一個請求**，沒有真的逐頁進度可拿。
 * 7 是實測：七頁竹的 PDF 48.8 秒（含 JVM 啟動），Audiveris 5.11.0、2 顆 CPU。
 */
const OMR_PDF_SEC_PER_PAGE = 7;

const omrErrEl = () => $("#omrErr");

/** 送出到拿到結果之間都是 true。擋重複送出、而且**鎖住整個框**（見下）。 */
let omrBusy = false;

//  ─── 這疊圖與它的結果活得比框久 ───
//
//  關掉再打開就是原來那一頁。因此 `url` **不能在關框時 revoke** —— revoke 過的 object
//  URL 當 <img src> 是一片空白，而且**不觸發 onerror**。
/** @type {{file:File, url:string|null, name:string, pdf:boolean}[]} */
let omrPages = [];
/** pollOmr 拿回來的那份狀態（含 pages / warnings）。null = 還沒辨識。 */
let omrResult = null;
/** 伺服器數出來的 PDF 頁數。0 = 還不知道（或這次上傳的是圖片）。 */
let omrPdfPages = 0;

/** 準備中 / 辨識中 / 已完成。整個框的行為都由它決定。 */
const omrState = () => (omrBusy ? "busy" : omrResult ? "done" : "prep");

/** 這一疊是一份 PDF 嗎。**PDF 與圖片不會混**（omrAdd 整批拒絕），一個元素就決定得了。 */
const omrIsPdf = () => omrPages.length === 1 && omrPages[0].pdf;

const omrBox = () => $("#omrBox");

const omrSay = msg => {
  const el = $("#omrStat");
  if (el) el.textContent = msg;
};

const omrFail = msg => {
  const el = omrErrEl();
  if (!el) return;
  el.textContent = msg;
  el.hidden = false;
};

const omrClear = () => {
  omrSay("");
  const el = omrErrEl();
  if (el) el.hidden = true;
};

/**
 * worker 的錯誤碼 → 站台自己的字串。**不要十直接顯示 worker 回的 message**：它是另一個
 * repo（omr-workers）寫死的繁體中文，而且認不出來的失敗會帶著原始 stderr 尾段回來。
 *
 * 表裡放的是 key 的**尾段**，湊成 `omr.err.<x>` 才送進 i18n.t —— 語言檔的孤兒檢查認得
 * 這種動態前綴，直接放整條 key 的話那七條會被判成沒有呼叫端。
 */
const OMR_ERR_KEYS = {
  RECOGNITION_FAILED: "notScore",
  TIMEOUT: "timeout",
  UNREACHABLE: "unreachable",
  BUSY: "busy",
  FILE_TOO_LARGE: "tooLarge",
  INVALID_INPUT: "invalidInput",
  INTERNAL_ERROR: "internal",
};

/**
 * 失敗的工作 → 要顯示給使用者的一句話。多頁時要講出是**哪一頁**壞掉；頁碼不必伺服器給：
 * `done` 是「成功跑完幾頁」，壞掉的就是下一頁（OmrRunner 成功之後才 `DonePages = i + 1`）。
 */
const omrErrorText = s => {
  // 原始訊息只進 console —— 查問題時要的是這個。
  if (s.code || s.message) console.warn("OMR 失敗：", s.code, s.message);

  const known = OMR_ERR_KEYS[s.code];
  const body = known ? i18n.t(`omr.err.${known}`) : i18n.t("omr.failed");
  return s.total > 1
    ? i18n.t("omr.err.onPage", { page: s.done + 1, total: s.total, msg: body })
    : body;
};

/**
 * 讀伺月服器的回應。**一定要防「回來的不是 JSON」**：401 之後的登入導向、IIS 擋下的 413、
 * 反向代理的 502 回的都是 HTML，而 `res.json()` 會丟「Unexpected token '&lt;'」。
 */
async function omrJson(res) {
  const text = await res.text();
  try { return JSON.parse(text); }
  catch { return { code: "bad_response", message: i18n.t("omr.badResponse", { code: res.status }) }; }
}

// ─── 整理圖片／PDF ──────────────────────────────────────────────────────────

/** 瀏覽器報的 type 認得的三種。PDF 只收單獨一份（見 omrAdd）。 */
const OMR_TYPES = ["image/png", "image/jpeg", "application/pdf"];

/**
 * 把選到的檔案加進清單尾巴。上限在**加入的當下**就講，而且**逐張說明理由**。
 *
 * **PDF 與圖片不能混，整批拒絕** —— PDF 的頁序在檔案裡面，沒有東西可以拖曳排序。而且
 * **頁數不在這裡數**：前端沒有 PDF 解析器（零相依、零建置的原生 ESM），頁數由 /api/omr
 * 數（`Omr/OmrApiController.cs` 竹的 CountPdfPages）。
 */
function omrAdd(files) {
  if (omrState() !== "prep") return;
  omrClear();

  const list = [...files];
  if (!list.length) return;

  const pdfs = list.filter(f => f.type === "application/pdf").length;
  const mixedInBatch = pdfs > 0 && pdfs < list.length;
  const clashesWithList = omrPages.length > 0 && (omrIsPdf() || pdfs > 0);
  if (mixedInBatch || clashesWithList || pdfs > 1) {
    omrFail(i18n.t("omr.mixedKinds"));
    return;
  }

  const errs = [];
  let total = omrPages.reduce((n, p) => n + p.file.size, 0);

  for (const f of list) {
    // **PDF 不佔張數配額** —— 它的配額是頁數，而頁數要問伺服器
    if (pdfs === 0 && omrPages.length >= OMR_MAX_PAGES) {
      errs.push(i18n.t("omr.tooManyPages", { max: OMR_MAX_PAGES }));
      break;
    }
    // 前端只看得到瀏覽器報的 type。魔術位元組檢查在伺服器那邊。
    if (!OMR_TYPES.includes(f.type)) {
      errs.push(i18n.t("omr.notSupported", { name: f.name }));
      continue;
    }
    if (f.size > OMR_MAX_MB * 1024 * 1024) {
      errs.push(i18n.t("omr.fileTooLarge", { name: f.name, max: OMR_MAX_MB }));
      continue;
    }
    if (total + f.size > OMR_MAX_TOTAL_MB * 1024 * 1024) {
      errs.push(i18n.t("omr.totalTooLarge", { max: OMR_MAX_TOTAL_MB }));
      break;
    }
    total += f.size;
    const pdf = f.type === "application/pdf";
    // PDF 水沒有縮圖，所以**不建 object URL** —— 建了就要記得撤。
    omrPages.push({ file: f, url: pdf ? null : URL.createObjectURL(f), name: f.name, pdf });
  }

  if (errs.length) omrFail(i18n.clause([...new Set(errs)]));
  omrRender();
}

/** 把第 from 張搬到第 to 個位置。←／→ 與拖曳都走這裡。 */
function omrMove(from, to) {
  if (omrState() !== "prep") return;
  if (to < 0 || to >= omrPages.length || to === from) return;
  const [p] = omrPages.splice(from, 1);
  omrPages.splice(to, 0, p);
  omrRender();
}

function omrRemove(i) {
  if (omrState() !== "prep") return;
  const [p] = omrPages.splice(i, 1);
  if (p?.url) URL.revokeObjectURL(p.url);   // 這一張真的沒了，可以撤（PDF 沒有 URL）
  omrClear();
  omrRender();
}

/** 清空重來：圖片與結果一起丟掉。**這裡沒有 undo** —— 靠這顆鈕的名字說明。 */
function omrReset() {
  omrRevokeAll();
  omrPages = [];
  omrResult = null;
  omrPdfPages = 0;
  omrClear();
  omrRender();
}

/** 只撤 object URL，不動清單 —— 給 pagehide 月用（見 init）。PDF 沒有 URL 可撤。 */
const omrRevokeAll = () => { for (const p of omrPages) if (p.url) URL.revokeObjectURL(p.url); };

// ─── 拖曳排序 ───────────────────────────────────────────────────────────────
//
//  用 pointer events **不是 HTML5 DnD**：圖片大宗是手機拍的樂譜，而 `draggable` 在
//  觸控上連 dragstart 都不會發，而且壞得沒有症狀（按住拖，畫面就是不動）。
//
//  **拖曳中絕對不移動 DOM**，只畫一條插入線 —— 移動的話游標底下的元素會換人 → 算出別的
//  插入點 → 再移動一次 → 抖動迴圈。也因為不動版面，dragstart 當下的 rect 一路有效。

let omrDrag = -1;        // 正在拖第幾張，-1 = 沒在拖
let omrSlot = -1;        // 插入線畫在第幾個縫
let omrRects = [];       // pointerdown 當下的位置快照
let omrFrom = null;      // pointerdown 的座標，用來過濾「其實是點一下」

const OMR_DRAG_SLOP = 6; // px。低於這個距離不算拖曳 —— 手指點下去一定會有幾 px 位移

function omrClearMarks() {
  for (const el of $("#omrGrid").children) el.classList.remove("dropL", "dropR");
  omrSlot = -1;
}

function omrMarkSlot(slot) {
  if (omrSlot === slot) return;          // 拖曳中每一幀都會進來，同一個縫就別重畫
  omrClearMarks();
  omrSlot = slot;
  const cells = [...$("#omrGrid").children];
  // 最後一個縫沒有「右邊那一格」可以掛，掛在前一格竹的右緣
  if (slot < cells.length) cells[slot]?.classList.add("dropL");
  else cells[cells.length - 1]?.classList.add("dropR");
}

function omrDragMove(e) {
  if (omrDrag < 0 || !omrFrom) return;
  // 還沒超過門檻：可能只是點一下，先不要進入拖曳狀態
  if (omrRects.length === 0) {
    if (Math.hypot(e.clientX - omrFrom.x, e.clientY - omrFrom.y) < OMR_DRAG_SLOP) return;
    omrRects = [...$("#omrGrid").children].map(el => el.getBoundingClientRect());
    $("#omrGrid").children[omrDrag]?.classList.add("dragging");
  }
  omrMarkSlot(gridSlotAt(e.clientX, e.clientY, omrRects));
}

function omrDragEnd(apply) {
  const from = omrDrag, slot = omrSlot, moved = omrRects.length > 0;
  omrDrag = -1; omrFrom = null; omrRects = [];
  $("#omrGrid").children[from]?.classList.remove("dragging");
  omrClearMarks();
  if (!apply || !moved || from < 0 || slot < 0) return;
  // 縫 → 目標索引。用 util.slotToIndex（分頁重排共用、帶窮舉測試）—— 同一種差一錯誤。
  omrMove(from, slotToIndex(from, slot));
}

// ─── 畫面 ───────────────────────────────────────────────────────────────────

/** 重畫縮圖再把 foot 對齊狀態。**整個 grid 重建** —— 每次改動十都會讓後面的頁碼變動。 */
function omrRender() {
  const grid = $("#omrGrid");
  if (!grid) return;
  const done = omrState() === "done";

  grid.textContent = "";

  // PDF：一張檔案卡。grid 的縮圖／拖曳／←／→／頁碼都是為了頁序而存在，而 PDF 的頁序在
  // 檔案裡面。頁數前端數不出來（見 omrAdd），要等伺服器回。
  if (omrIsPdf()) {
    grid.classList.add("pdf");
    const p = omrPages[0];
    const cell = document.createElement("div");
    cell.className = "page pdf";

    const nm = document.createElement("span");
    nm.className = "nm";
    nm.textContent = p.name;
    nm.title = p.name;

    const tag = document.createElement("span");
    tag.className = "no";
    tag.textContent = "PDF";

    cell.append(tag, nm);
    if (!done) {
      const ops = document.createElement("div");
      ops.className = "ops";
      ops.append(omrOpBtn("✕", i18n.t("omr.removePdf"), false, () => omrRemove(0), "del"));
      cell.append(ops);
    }
    grid.append(cell);
    omrSync();
    return;
  }
  grid.classList.remove("pdf");

  omrPages.forEach((p, i) => {
    const cell = document.createElement("div");
    cell.className = "page";

    const no = document.createElement("span");
    no.className = "no";
    no.textContent = String(i + 1);

    const img = document.createElement("img");
    img.src = p.url;
    img.alt = "";                      // 純裝飾：頁碼與檔名才是資訊，alt 重複只是噪音

    const nm = document.createElement("span");
    nm.className = "nm";
    nm.textContent = p.name;
    nm.title = p.name;                 // 檔名被 ellipsis 切掉時還看得到全名

    cell.append(no, img, nm);

    if (!done) {
      const ops = document.createElement("div");
      ops.className = "ops";
      ops.append(
        omrOpBtn("←", i18n.t("omr.moveLeft", { n: i + 1 }), i === 0,
          () => omrMove(i, i - 1)),
        omrOpBtn("→", i18n.t("omr.moveRight", { n: i + 1 }), i === omrPages.length - 1,
          () => omrMove(i, i + 1)),
        omrOpBtn("✕", i18n.t("omr.remove", { n: i + 1 }), false,
          () => omrRemove(i), "del"),
      );
      cell.append(ops);

      cell.addEventListener("pointerdown", e => {
        if (e.button) return;                       // 只認主鍵
        if (e.target.closest("button")) return;     // ←／→／✕ 自己處理
        omrDrag = i;
        omrFrom = { x: e.clientX, y: e.clientY };
        omrRects = [];                              // 超過門檻才快照，見 omrDragMove
        cell.setPointerCapture(e.pointerId);
      });
      cell.addEventListener("pointermove", omrDragMove);
      cell.addEventListener("pointerup", () => omrDragEnd(true));
      // pointercancel 要當戈成取消**不是**放下：系統把手勢搶走時（來電、通知）位置是最後
      // 一次 move 的，照那個放下等於隨機搬一格。
      cell.addEventListener("pointercancel", () => omrDragEnd(false));
    }

    grid.append(cell);
  });

  omrSync();
}

function omrOpBtn(text, label, disabled, onClick, cls) {
  const b = document.createElement("button");
  b.type = "button";
  b.textContent = text;
  b.setAttribute("aria-label", label);
  b.title = label;
  b.disabled = disabled;
  if (cls) b.classList.add(cls);
  b.addEventListener("click", onClick);
  return b;
}

/** foot 竹的按鈕與計數對齊三個狀態。「現在能做什麼」只由這裡決定。 */
function omrSync() {
  if (!$("#omrGrid")) return;        // 這個框不在畫面上（測試、或別的版面）
  const st = omrState(), n = omrPages.length;

  $("#omrEmpty").hidden = n > 0;
  $("#omrGrid").hidden = n === 0;
  $("#omrGrid").classList.toggle("done", st === "done");
  // 那句提示講的是「拖曳排序」，對 PDF 顯示只會誤導
  $("#omrHint").hidden = st !== "prep" || omrIsPdf();
  $("#omrBusy").hidden = st !== "busy";

  // PDF 的計數講「頁」而不是「張」，而且**辨識之前講不出數字**（頁數是伺服器數的）。
  const pdf = omrIsPdf();
  const count = $("#omrCount");
  count.textContent = !n ? ""
    : pdf ? (omrPdfPages
      ? i18n.t(st === "done" ? "omr.pdfPagesDone" : "omr.pdfPages", { n: omrPdfPages })
      : i18n.t("omr.pdfOne"))
    : st === "done" ? i18n.t("omr.countDone", { n })
    : i18n.t("omr.count", { n, max: OMR_MAX_PAGES });
  count.classList.toggle("over", !pdf && st === "prep" && n >= OMR_MAX_PAGES);

  const prep = st === "prep", done = st === "done";
  // PDF 已經在水清單裡就不能再加東西（不能混，見 omrAdd）
  $("#omrAdd").hidden = !prep || pdf;
  $("#omrAdd").disabled = n >= OMR_MAX_PAGES;
  $("#omrGo").hidden = !prep;
  $("#omrGo").disabled = !n;
  $("#omrReset").hidden = !done;
  $("#omrBack").hidden = !done;
  // 辨識中遮罩蓋住整張卡片，這幾顆本來就點不到 —— disabled 是為了鍵盤與螢幕閱讀器，
  // 它們不受一層半透明的 div 影響。
  $("#omrCancel").disabled = st === "busy";
}

// ─── 送出與等待 ─────────────────────────────────────────────────────────────

async function readSheets() {
  if (omrState() !== "prep" || !omrPages.length) return;
  omrClear();
  clearErr();

  const fd = new FormData();
  for (const p of omrPages) fd.append("files", p.file);
  // **不送 tempoBpm。** 曾經有一個「速度」欄位、預設 120 —— 讀不到譜上的速度記號時
  // 那個 120 會被注入進去，於日是 musicxmlIn.warn.noTempo **永遠不會亮**。

  const pdf = omrIsPdf();
  omrPdfPages = 0;        // 上一次的頁數不能留著，這次的還沒問到
  omrBusy = true;
  omrSync();

  try {
    omrSay(pdf ? i18n.t("omr.uploadingPdf") : i18n.t("omr.uploading", { n: omrPages.length }));

    let res;
    try {
      res = await fetch("/api/omr", { method: "POST", body: fd });
    } catch {
      // fetch 只有網路層失敗才 reject —— HTTP 錯誤碼不會。
      omrFail(i18n.t("omr.netError"));
      return;
    }

    const started = await omrJson(res);
    if (!res.ok) { omrFail(started.message || i18n.t("omr.netError")); return; }
    if (!started.id) { omrFail(i18n.t("omr.netError")); return; }

    // 頁數在**這裡**就拿到，不等第一次輪詢（那是 2 秒之後）。
    omrPdfPages = started.pageCount ?? 0;
    omrSync();

    const done = await pollOmr(started.id);
    if (done) finishSheets(done);              // 失敗的訊息已經由 pollOmr 顯示了
  } finally {
    // 一定要在重畫之前放掉，不然狀態算出來還是 busy、遮罩就撤不掉。
    omrBusy = false;
    // **重畫而不是只 omrSync()**：那些格子要連同拖曳的處理常式一起換掉。
    omrRender();
  }
}

/**
 * 「辨識中」那一行要說什麼。多張圖是一張一個請求，「第 2 / 3 頁」是**真的**進度；
 * 一份多頁 PDF（`total === 1` 但頁數 > 1）整本一個請求，只有估算 ——  **不要**為了統一
 * 把上面那條真進度也降級成估算。估算走完之後改口說「已經等了 N 秒」：顯示「還要 0 秒」
 * 會讓正常跑的工人作看起來卡住。
 */
function omrRunningText(s, runningSince) {
  const sec = Math.round((Date.now() - runningSince) / 1000);

  if (s.total === 1 && s.pageCount > 1) {
    const left = s.pageCount * OMR_PDF_SEC_PER_PAGE - sec;
    return left > 0
      ? i18n.t("omr.runningPdf", { total: s.pageCount, sec: left })
      : i18n.t("omr.runningPdfLong", { sec });
  }
  return s.total > 1
    ? i18n.t("omr.runningPage", { done: s.done + 1, total: s.total })
    : i18n.t("omr.running");
}

/** 輪詢到有結果為止。成功回那份狀態，失敗回 null（訊息自己顯示）。2 秒一次。 */
async function pollOmr(id) {
  // 開始跑的時刻。**不從送出算** —— 排隊的時間不該算進估算裡。
  let runningSince = 0;

  for (;;) {
    await new Promise(r => setTimeout(r, 2000));

    let res;
    try {
      res = await fetch(`/api/omr/${id}`);
    } catch {
      // 一次失敗不放棄 —— 筆電闔上、換 Wi-Fi 接入點都會這樣，伺服器還在跑。
      omrSay(i18n.t("omr.reconnecting"));
      continue;
    }

    const s = await omrJson(res);

    if (res.status === 404) {
      // 伺服器重啟了 —— 工作存在記憶體裡。訊息要直接卜說「重新上傳」。
      omrFail(s.message || i18n.t("omr.gone"));
      return null;
    }
    if (!res.ok) { omrFail(s.message || i18n.t("omr.netError")); return null; }

    if (s.state === "queued") {
      omrSay(s.position > 0 ? i18n.t("omr.queuedBehind", { n: s.position }) : i18n.t("omr.queued"));
      continue;
    }
    if (s.state === "running") {
      if (!runningSince) runningSince = Date.now();
      omrSay(omrRunningText(s, runningSince));
      continue;
    }
    if (s.state === "done") return s;
    // **這一條的 message 不能直接顯示**：404 / 非 2xx 是控制器回的、已翻好；這裡的是
    // worker 回的。見 omrErrorText。
    if (s.state === "failed") { omrFail(omrErrorText(s)); return null; }

    omrFail(i18n.t("omr.netError"));
    return null;
  }
}

/** 辨識完成：記住結果再走進聲部清單。解析失敗時**不記** —— 會卡在按什麼都沒用的狀態。 */
function finishSheets(s) {
  if (!omrToList(s)) return;
  omrResult = s;
}

/** 一份辨識結果 → 聲部清單。剛辨識完與按「回到聲部清單」走同一段程式碼。 */
function omrToList(s) {
  const pages = s.pages ?? [];
  if (!pages.length) { omrFail(i18n.t("omr.noResult")); return false; }

  let smf, list;
  try {
    smf = parseMusicXML(pages);
    list = inventory(smf);
  } catch (err) {
    omrFail(err instanceof MusicXmlError ? err.message
      : i18n.t("fileBox.readFailed", { msg: err.message }));
    return false;
  }
  if (!list.length) { omrFail(i18n.t("fileBox.noNotes")); return false; }

  // 兩種警告十都要帶：引擎丟掉了什麼（從 stderr 撈的），以及解析時發現的（小節時值對不上、
  // 連結線沒收尾）—— 圖上跟 MML 上都看不出來。
  const notes = [...(s.warnings ?? []), ...smf.warnings];

  kind = "midi";                 // parseMusicXML 的形狀跟 parseSMF 一樣，走同一條路
  rows = list.map(r => ({ ...r, on: false, mode: "melody" }));
  tempos = smf.tempos;
  fileMeters = smf.meters ?? [];
  fileMarks = smf.marks ?? [];
  origin = fileOrigin(list);     // **整個檔案**的起點，同 readMidi 的理由

  midiFromOmr = true;            // 聲部清單按「取消」要退回這個框，不是整個關掉
  omrClear();
  omrBox().classList.remove("on");   // 換頁，不是疊上去
  // 名字取第一張圖的檔名 —— 掃描檔通常叫「曲名 p1」。
  openList(stripExt(omrPages[0]?.name ?? "") || i18n.t("omr.defaultName"), notes);
  return true;
}

// ─── 音軌清單 ───────────────────────────────────────────────────────────────

function openList(name, notes) {
  $("#midiName").textContent = notes.length
    ? i18n.t("fileBox.midiName", { name, list: i18n.clause(notes) })
    : name;
  // 表頭與卜說明依格式切換：MML 沒有「採樣模式」（它本來就是單音）。
  const midi = kind === "midi";
  $("#midiBox").dataset.kind = kind;
  $("#colMode").hidden = !midi;
  $("#colUnit").textContent = midi ? "Channel" : i18n.t("fileBox.colUnit");
  $("#midiHint").hidden = !midi;
  $("#mmlHint").hidden = midi;
  append = false;                 // 每次開清單都退回新採譜；追加是要刻意選的
  syncAppend();

  $("#pickAll")?.setAttribute("aria-label", i18n.t("fileBox.pickAllAria", { max: PICK_LIMIT }));
  pickAll(true);
  renderRows();
  midiBox().classList.add("on");
  $("#midiOk").focus();
}

function renderRows() {
  const tb = $("#midiRows");
  tb.textContent = "";
  for (const row of rows) {
    const tr = document.createElement("tr");
    tr.classList.toggle("on", row.on);

    const cb = document.createElement("input");
    cb.type = "checkbox";
    cb.checked = row.on;
    cb.setAttribute("aria-label", i18n.t("fileBox.importAria", { label: row.label }));

    // 只改這一列，不重建整人個 tbody —— 重建會讓 checkbox 失去焦點。
    const setOn = v => {
      row.on = v;
      cb.checked = v;
      tr.classList.toggle("on", v);
      syncFoot();
    };

    // 不停用任何 checkbox：超額改用「紅字 + 匯入鈕停用」表達 —— 灰掉的說不出「超了幾軌」。
    cb.addEventListener("change", () => setOn(cb.checked));

    // 整列都是勾選的靶。點 checkbox 自己與點下拉要跳過：前者的 change 已經處理過，
    // 後者是另一個控制項。
    tr.addEventListener("click", e => {
      if (e.target === cb || e.target.closest("select")) return;
      setOn(!row.on);
    });

    tr.append(
      cell(cb), cell(String(row.index + (kind === "midi" ? 0 : 1)), "n"),
      cell(nameCell(row), "name"),
      cell(String(kind === "midi" ? row.noteCount : row.notes), "cnt"));

    if (kind === "midi") {
      const sel = document.createElement("select");
      for (const [v, label] of MODES) {
        const o = document.createElement("option");
        o.value = v; o.textContent = label;
        sel.appendChild(o);
      }
      sel.value = row.mode;
    sel.title = i18n.t("fileBox.modeTitle");
      sel.addEventListener("change", () => { row.mode = sel.value; syncFoot(); });
      tr.append(cell(sel));
    }
    tb.appendChild(tr);
  }
  syncFoot();
}

function cell(content, cls) {
  const td = document.createElement("td");
  if (cls) td.className = cls;
  if (typeof content === "string") td.textContent = content;
  else td.appendChild(content);
  return td;
}

function nameCell(row) {
  const span = document.createElement("span");
  span.append(row.label);
  const tag = (text, title, cls = "") => {
    const el = document.createElement("span");
    el.className = `drum ${cls}`.trim();      // 同一套小標籤樣式
    el.textContent = text;
    el.title = title;
    span.appendChild(el);
  };

  // 有水沒有主旋律。**放在最前面** —— 它是唯一會改變「該選哪個模式」的資訊。
  if (row.melody === "melody")
    tag(i18n.t("fileBox.tag.melody"), i18n.t("fileBox.tag.melodyTitle"), "lead");
  else if (row.melody === "chords")
    tag(i18n.t("fileBox.tag.chords"), i18n.t("fileBox.tag.chordsTitle"));
  // 不擋它選智能分弦／和弦全採，但要說：聲部分離建立在音高上，而鼓的「音高」是編號。
  if (row.drum)
    tag(i18n.t("fileBox.tag.drum"), i18n.t("fileBox.tag.drumTitle"));
  // 匯入後這一軌的捲軸會是唯讀（`r+` 這種筆誤、或 [ceg] 和弦）。不擋勾選，但要先說。
  if (row.readonly)
    tag(i18n.t("fileBox.tag.readonly"),
      i18n.t("fileBox.tag.readonlyTitle", { why: row.readonly }));
  //  這一軌有非標準時值。**不擋、也不在這裡報字數** —— 還原之後字數會變多，而這個記號的作用
  // 就是讓他知道「這一列的字數還會動」，免得在 2400 邊緣挑錯（挑了 2300 字，還原完變 2600）。
  if (row.nonstd)
    tag(i18n.t("fileBox.tag.nonstd", { n: row.nonstd }),
      i18n.t("fileBox.tag.nonstdTitle"));
  // 卜這一軌本身就超過遊戲上限，貼不回遊戲。不擋，只說。
  if (row.chars > MAX_TRACK_CHARS)
    tag(i18n.t("fileBox.tag.chars", { n: row.chars }),
      i18n.t("fileBox.tag.charsTitle", { max: MAX_TRACK_CHARS }));
  // 這一條**真的會少內容**（跟上面那個只是「貼不進遊戲」不同）：tracks.setTexts 會把
  // 每一軌切到 HARD_TRACK_CHARS，而清單上的音符數是**整軌**算出來的。
  if (row.chars > HARD_TRACK_CHARS)
    tag(i18n.t("fileBox.tag.willCut"),
      i18n.t("fileBox.tag.willCutTitle", { max: HARD_TRACK_CHARS }));
  return span;
}

function syncFoot() {
  const n = rows.reduce((a, r) => a + cost(r), 0);
  const room = budget();
  const over = n > room;
  const el = $("#midiCount");

  const cap = append ? i18n.t("fileBox.capLeft", { n: room })
                     : i18n.t("fileBox.capTotal", { n: MAX_TRACKS });
  let text = over ? i18n.t("fileBox.pickedOver", { n, cap, extra: n - room })
                  : i18n.t("fileBox.picked", { n, cap });
  // 超額又有人選了和弦全採：那多半就日是原因，直接講。
  if (over && rows.some(r => r.on && r.mode === "all"))
    text += append && room < MAX_TRACKS
      ? i18n.t("fileBox.allNoRoom", { max: MAX_TRACKS })
      : i18n.t("fileBox.allTakesAll", { max: MAX_TRACKS });

  el.textContent = text;
  el.classList.toggle("over", over);
  $("#midiOk").disabled = n === 0 || over;
  syncPickAll();
}

/** 「新採譜 / 追加採譜」兩顆單選鈕。兩種匯入都有。 */
function syncAppend() {
  appendAt = tracks.appendAt();
  for (const el of document.querySelectorAll("#midiMode input[name=impMode]"))
    el.checked = (el.value === "append") === append;

  // 「新採譜而且目前真的有東西」= 這一次會毀掉現有的卜譜。
  const wipes = !append && appendAt > 0;

  const hint = $("#midiAppendHint");
  if (hint) {
    hint.hidden = !append && !wipes;
    hint.classList.toggle("warn", wipes);
    if (wipes)
      hint.textContent = i18n.t("fileBox.wipeHint");
    else if (append)
      hint.textContent = appendAt
        ? i18n.t("fileBox.appendHint", { from: appendAt + 1, keep: appendAt })
        : i18n.t("fileBox.appendEmpty");
  }

  // 第二道：破壞發生在按下匯入的那一刻，警告要跟著那顆按鈕。不攔確認框 —— Ctrl+Z 救得回來。
  const ok = $("#midiOk");
  if (ok) {
    ok.classList.toggle("danger", wipes);
    ok.textContent = i18n.t(wipes ? "fileBox.okWipe" : "fileBox.okImport");
  }

  syncFoot();
}

// ─── 新增與清空 ─────────────────────────────────────────────────────────────
//
// 兩個都會把音符清光，分界線是「這首曲子的編制要不要留下來」：
//
//   新增         開一份新檔案。軌數、樂器、曲名全部回原廠。
//   清空所有音符  這首的編制留著，只清文字。
//
// 都不跳確認框：`history.edit` 的 snapshot 涵蓋 texts / presets / mutes / count / active。

/**
 * 新增：開一份新檔案。**每一軌都回到原廠**，軌數回 MIN_TRACKS，曲名也清掉（Ctrl+S 會不問
 * 就覆寫，見 savebox.quickSave）。調號與換行設定留著 —— 那些不屬於這個檔案。
 *
 * **樂器回原廠是這一支跟「清空」唯一實質的差別**：不跑 `resetInstruments` 的話選單上寫著
 * 長笛而 preset 還留著上一首的值 —— 播放讀的是 preset，不日是選單。
 */
function newSong() {
  wrapEdit(() => {
    tracks.setTexts([]);
    tracks.reset(MIN_TRACKS);
    tracks.resetMutes();
    // 拍號與段落標記跟軌數、樂器一樣是**這首曲子的屬性**，開新檔案要一起回原廠 ——
    // 留著的話新檔案第 5 小節就莫名變成 3/4、尺上還掛著上一首的「副歌」。
    // 在 wrapEdit 裡面：快照涵蓋這兩樣（見 ui 的 history.init），所以這一步復原得回去。
    // **拍號的顯示開關不動** —— 那是這台機器的偏好，不是這個檔案的（見 meters.js 檔頭）。
    meters.set([]);        // 洗完 = 只剩曲首 4/4
    marks.set([]);
  });
  // 樂器在 wrapEdit 外面，理由同匯入那邊（applyPrograms 是非同步的）。
  tracks.resetInstruments();
  setSongName("");
  // 走 onClear 而不是 onImport：**onImport 會把「MML 格式化換行」退回不換行**，而這裡
  // 根本沒有文字。
  onClear();
  // 清掉儲存框的基準（連同 lastSaved），所以接下來的 Ctrl+S 會開框問，不是寫回上一份。
  onNew();
  fileBox().classList.remove("on");     // 動作做完了，框沒有理由留著
  say(i18n.t("fileBox.newed", { n: MIN_TRACKS }));
}

/**
 * 清掉所有樂譜文字，留下 MIN_TRACKS 個空白音軌。
 *
 * **只清音符，不清設定**：樂器、匯出檔名、調號、換行設定全部保留。**靜音是唯一的例外**。
 *
 * `setTexts` 是 `for i < MAX_TRACKS` 的迴圈，傳空陣列就會把全部 15 軌寫成空字串 ——
 * 輔助軌不會有殘留。不跳確認框：snapshot 涵蓋 texts / presets / count / active。
 */
function clearAll() {
  wrapEdit(() => {
    tracks.setTexts([]);
    tracks.reset(MIN_TRACKS);
    // 靜音解除 —— 樂器是為下一首準備好的配置，靜音已經沒有指涉的對象了。
    tracks.resetMutes();
  });
  // 走 onClear 而不是 onImport，理由同 newSong。（停止播放那部分兩者十都要。）
  onClear();
  fileBox().classList.remove("on");     // 動作做完了，框沒有理由留著
    say(i18n.t("fileBox.cleared", { n: MIN_TRACKS }));
}

// ─── 落地 ───────────────────────────────────────────────────────────────────

/**
 * 讓出一幀，讓瀏覽器有機會把遮罩畫出來。聲部分離是一段同步的 JS 迴圈，`hidden = false`
 * 之後立刻開始算的話那個遮罩一次都不會被畫出來；兩次 rAF 才保證中間發生過一次繪製。
 *
 * （遮罩裡的動畫只動 transform 與 opacity —— 動到 top / width / color 會跟著凍住。）
 */
const frame = () => new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));

/**
 * 算出這一批的 MML 文字。兩種格式在這裡分家 —— 共通的是**落地方式**（`doImport` 後半段）。
 *
 * @param {object[]} picked 勾起來的列
 * @param {number} at       這一批要寫進第幾軌（0 = 取代全部）
 */
function makeTexts(picked, at) {
  if (kind === "midi") {
    const song = getSong();
    return buildImport(picked.map(r => ({
      notes: r.notes, mode: r.mode, drum: r.drum, label: r.label,
    })), tempos, {
      origin, append: at > 0, existingTempos: song?.tempos ?? [], base: at,
    });
  }

  // MML 直接搬文字，**不重新產生**：繞一趟 items → itemsToMML 只會重新壓縮（平均
  // +56 字）並丟掉原作者的排版與 /*M 12 */ 小節標卜記。
  //
  // **現在沒有例外**：以前 MabiIcco／瑪奇 PC 的還原會在 makePart 裡自動做掉，那是這條線唯一的
  // 破口。還原改成工具列上的按鈕之後，匯入真的一個字都不動。
  const warnings = [];

  //  **非標準時值一定要講，而且排在最前面** —— trimWarnings 是從頭保留的，排後面會在警告多的
  // 檔案裡被吃掉。而它是這裡唯一一個關於「這份譜在遊戲裡能不能用」的提示，其餘幾條都只關於字數。
  //
  //  報的是**時值的個數**，不是字數也不是軌數：使用者要決定的是「要不要收這一份」，而那取決於
  // 有多少東西在瑪奇 Mobile 上不能用。字數要等他按了還原才會變，在這裡先報一個預估值只會讓他
  // 對著兩個都還不確定的數字做決定（而且每一軌都要試跑一次還原，那正是原文讀取想省掉的成本）。
  const nonstd = picked.reduce((n, r) => n + (r.nonstd ?? 0), 0);
  if (nonstd) warnings.push(i18n.t("fileBox.warn.nonstd", {
    n: nonstd, tracks: picked.filter(r => r.nonstd).length,
  }));

  const ro = picked.filter(r => r.readonly).length;
  if (ro) warnings.push(i18n.t("fileBox.warn.readonly", { n: ro }));
  const over = picked.filter(r => r.chars > MAX_TRACK_CHARS).length;
  if (over) warnings.push(i18n.t("fileBox.warn.overLimit", { n: over, max: MAX_TRACK_CHARS }));
  const cut = picked.filter(r => r.chars > HARD_TRACK_CHARS).length;
  if (cut) warnings.push(i18n.t("fileBox.warn.cut", { n: cut, max: HARD_TRACK_CHARS }));
  // 追加時**不剝掉**別人譜裡的 `t`，但速度是全曲共用的（parseAll 合併所有軌的 t）。
  if (at > 0 && picked.some(r => /t\s*\d/i.test(r.text)))
    warnings.push(i18n.t("fileBox.warn.tempoInAppend"));

  return { texts: picked.map(r => r.text), warnings: trimWarnings(warnings) };
}

/**
 * 把採樣結果寫進分頁。做的事跟 clipboard.importText 對齊 —— 取代全部（或接在後面）、
 * 包成一步可復原、然後叫 onImport 重新解析。
 */
async function doImport() {
  const picked = rows.filter(r => r.on);
  if (!picked.length) return;

  const at = append ? appendAt : 0;

  const busy = $("#midiBusy");
  if (busy) busy.hidden = false;
  await frame();

  // try/finally 只為了那人個遮罩：makeTexts 丟例外的話會留下一張蓋住整個對話框、關不掉
  // 的遮罩 —— 連取消都按不到。
  let texts, warnings;
  try {
    ({ texts, warnings } = makeTexts(picked, at));
  } finally {
    if (busy) busy.hidden = true;
  }
  midiBox().classList.remove("on");

  wrapEdit(() => {
    tracks.setTexts(texts, at);
    // 拍號：**只有取代全部時才套** —— 它是整首歌的屬性（同 `t` 那條判斷）。設定關掉時
    // 照樣存下來、只是不生效（見 meters.js 檔頭）。
    if (at === 0 && fileMeters.length) meters.set(fileMeters);
    // 標記同理：整首歌的屬性，追加時不套。
    if (at === 0 && fileMarks.length) marks.set(fileMarks);
    tracks.reset(at + texts.length, at);
    // 靜音：**只解除這一批寫到的那幾軌**，區間同下面的 resetInstruments。它在 wrapEdit
    // **裡面**、resetInstruments 在外面 —— 那個例外的理由是 applyPrograms 的非同步。
    tracks.resetMutes(at, at + texts.length);
  });

  // 樂器：放在 wrapEdit 外面 —— applyPrograms 可能這一刻套不上去（音色庫還沒載完時下拉
  // 是空的，它會先擱著等 fillInstruments 再套一次）。
  //
  // **先全部重設，再套已知的**：resetInstruments 會把 wantProg 清掉並設回下拉第一項，
  // 所以「有些聲部帶 program、有些沒帶」的 .mmi 不會留下上一首的殘留選擇。**只重設這一
  // 批寫到的那幾軌** —— 追加日時前面那些是這一首歌正在用的設定。
  //
  // .mmi 的 program= 是瑪奇的音色編號、不是 GM；.mml 的樂器在 [3MLE EXTENSION] 的 bzip2
  // blob 裡（見 mml-ext.js）。MIDI 的 Program Change 對瑪奇音色庫是假訊號。
  tracks.resetInstruments(at, at + texts.length);
  if (kind === "mml") {
    let any = false;
    picked.forEach((r, i) => {
      if (r.program === null || r.program === undefined) return;
      tracks.requestProgram(at + i, r.program);
      any = true;
    });
    if (any) tracks.applyPrograms();
  }

  onImport();

  // 匯出的檔名跟著來源走：Godknows.mml 進來，按 .mmi 就存成 Godknows.mmi。
  const nf = nameField();
  if (nf && srcName) nf.value = stripExt(srcName);

  // 軌數講的是**實際產出**的，不是勾選時算的上限。
  const head = at > 0
    ? i18n.t("fileBox.appended",
        { n: texts.length, from: at + 1, to: at + texts.length })
    : i18n.t("fileBox.imported", { n: texts.length });
  const tail = texts.length > GAME_TRACKS
    ? i18n.t("fileBox.beyondGame", { n: GAME_TRACKS + 1 })
    : "";
  say(warnings.length
    ? i18n.t("fileBox.sayWithWarnings",
        { head, warnings: i18n.clause(warnings), tail })
    : i18n.t("fileBox.sayLine", { head, tail }));
}

// ─── 接線 ───────────────────────────────────────────────────────────────────

/**
 * @param {object} hooks 由 ui 提供
 * @param {() => void}       hooks.onImport 匯入之後要重新解析
 * @param {() => void}       hooks.onClear  水清空之後要重新解析（不重置換行設定）
 * @param {() => void}       hooks.onNew    「新增」多做的那一件（清掉儲存框的基準）
 * @param {(fn:Function)=>void} hooks.wrapEdit 把整批換內容包成可復原的一步
 * @param {() => object|null}   hooks.getSong 目前的解析結果（另存 MIDI 用）
 */
export function init({ onImport: cb, onClear: clear, onNew: fresh,
                       wrapEdit: wrap, getSong: song, onMix: mix } = {}) {
  onImport = cb ?? onImport;
  onClear = clear ?? onImport ?? onClear;
  onNew = fresh ?? onNew;
  wrapEdit = wrap ?? wrapEdit;
  getSong = song ?? getSong;
  onMix = mix ?? onMix;

  const fb = fileBox(), mb = midiBox(), ob = omrBox();
  if (!fb || !mb) return;

  $("#file").addEventListener("click", () => {
    clearErr();
    fb.classList.add("on");
  });

  // 混音匯出：**換頁，不是疊上去**（同 #fileBox → #omrBox → #midiBox）。
  // 兩層對話框很難看懂，而且第二層要處理「Esc 該給誰」這種沒有好答案的問題。
  //
  // **開得起來才關掉這個框。** onMix 會再擋一次「這首是空的」（按鈕的狀態是上一次
  // refresh 的答案，而使用者可能在框開著的時候把譜清掉）—— 先關再失敗的話，畫面上
  // 會一個框都不剩，而使用者只看到一句飄過去的提示。
  $("#mixGo").addEventListener("click", () => {
    if (onMix()) fb.classList.remove("on");
  });

  $("#newSong").addEventListener("click", newSong);
  $("#clearAll").addEventListener("click", clearAll);

  $("#midFile").addEventListener("change", e => {
    const f = e.target.files[0];
    e.target.value = "";      // 清掉才選得了同一個檔案第二次
    read(f);
  });

  // ─── 匯入五線譜：整理圖片（#omrBox） ───────────────────────────────────────

  // 入口：換頁，不日是疊上去（同 #fileBox → #midiBox）
  $("#omrOpen")?.addEventListener("click", () => {
    fb.classList.remove("on");
    ob?.classList.add("on");
    omrRender();                 // 上次留下的圖與結果都還在，這裡把畫面補回來
  });

  for (const id of ["#omrPick", "#omrAdd"])
    $(id)?.addEventListener("click", () => $("#omrFile")?.click());

  // **value 一定要清**，不然同一批檔案選第二次不會觸發 change（同 #midFile）。
  // 這裡可以馬上清 —— omrAdd 是同步的，而且圖片已經進 omrPages 了。
  $("#omrFile")?.addEventListener("change", e => {
    omrAdd([...e.target.files]);
    e.target.value = "";
  });

  $("#omrGo")?.addEventListener("click", readSheets);
  $("#omrReset")?.addEventListener("click", omrReset);
  // 回到聲部清單：結果卜還在記憶體裡，重新解析一次就好
  $("#omrBack")?.addEventListener("click", () => { if (omrResult) omrToList(omrResult); });
  $("#omrCancel")?.addEventListener("click", () => ob?.classList.remove("on"));

  // **只在真的要丟掉這批圖時才 revoke** —— 關框不算，撤掉之後 <img> 是空白而且不觸發
  // onerror。
  addEventListener("pagehide", omrRevokeAll);

  $("#expGo").addEventListener("click", () => { fb.classList.remove("on"); save(); });

  // 這個框沒有 form，不攔的話在檔名欄按 Enter 什麼都不會發生。
  nameField()?.addEventListener("keydown", e => {
    if (e.key !== "Enter") return;
    e.preventDefault();
    if ($("#expGo")?.disabled) return;
    fb.classList.remove("on");
    save();
  });

  // 拖放：整張卡片都接得住，不是只有那顆按鈕。dragover 一定要 preventDefault，不然
  // 瀏覽器會直接用那個檔案取代整個分頁。
  const card = fb.querySelector(".card");
  fb.addEventListener("dragover", e => { e.preventDefault(); card.classList.add("drop"); });
  fb.addEventListener("dragleave", e => {
    if (e.target === fb || !fb.contains(e.relatedTarget)) card.classList.remove("drop");
  });
  fb.addEventListener("drop", e => {
    e.preventDefault();
    card.classList.remove("drop");
    read(e.dataTransfer?.files?.[0]);
  });

  // 取水消：從檔案來的就是關掉；從 #omrBox 來的**退回去**，圖與辨識結果都還在。
  $("#midiCancel").addEventListener("click", () => {
    mb.classList.remove("on");
    if (midiFromOmr) { ob?.classList.add("on"); omrRender(); }
  });
  $("#midiOk").addEventListener("click", doImport);

  // 新採譜 / 追加採譜。兩種匯入都有 —— 欄位可以隨格式變，**流程**不行（見檔頭）。
  for (const el of document.querySelectorAll("#midiMode input[name=impMode]"))
    el.addEventListener("change", () => { append = el.value === "append"; syncAppend(); });

  // 表頭的全選**重建整個 tbody**：焦點在表頭那顆勾上，不在 tbody 裡。
  $("#pickAll")?.addEventListener("change", e => {
    pickAll(e.target.checked);
    renderRows();
  });

  // **辨識中不關。** 輪詢綁在 readSheets() 的呼叫堆疊上，框關掉那個 await 還在跑但沒有
  // 人接結果，而畫面上什麼都不會說。Esc 同理。
  for (const box of [fb, mb, ob])
    box?.addEventListener("click", e => {
      if (e.target !== box) return;
      if (box === ob && omrBusy) return;
      box.classList.remove("on");
    });

  addEventListener("keydown", e => {
    if (e.key !== "Escape") return;
    // 三人個框接力，任何時候只有一個開著，所以逐一問誰開著
    if (mb.classList.contains("on")) mb.classList.remove("on");
    else if (ob?.classList.contains("on")) { if (!omrBusy) ob.classList.remove("on"); }
    else if (fb.classList.contains("on")) fb.classList.remove("on");
  });
}
