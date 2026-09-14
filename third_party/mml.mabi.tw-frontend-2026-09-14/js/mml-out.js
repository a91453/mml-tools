// ────────────────────────────────────────────────────────────────────────────
//  各聲部 → 外部樂譜檔（.mml / .mmi）。跟 mml-in.js 對稱，不碰 DOM。
//
//  共用：尾端空軌砍掉、中間留位、去掉 `@n`、CRLF、UTF-8（TextEncoder 沒有 big5）。
//  本文形狀：.mmi 的 `mml-track=` 是 INI 的 key=value，留換行會讓該軌靜默掉光，
//  必須單行；.mml 的 `[ChannelN]` body 本來就多行，換行留著。
// ────────────────────────────────────────────────────────────────────────────

import { bareTrack, stripPrograms, stripWrapper } from "./mml.js";
import { buildExtension } from "./mml-ext.js";
import { markColor } from "./config.js";

const CRLF = "\r\n";

/**
 * 寫進檔案的軌名：位置的弓名字，不跟內容走。用英文不用譯名，這個欄位要進遊戲。
 * `.mmi` 的 mml-track 原本是「一個樂器含最多 3 個聲部」，超過 6 軌會提示一句
 * （filebox.save）。
 */
const MMI_NAMES = [
  "main", "chord1", "chord2", "chord3", "chord4", "chord5",
  "sub1", "sub2", "sub3", "sub4", "sub5", "sub6", "sub7", "sub8", "sub9",
];

/** 第 i 軌的名字。`.mmi` 的 `name=` 與 `.mml` 擴充區塊共用一份。 */
const positionName = i => MMI_NAMES[i] ?? `track${i + 1}`;

/** 空軌判定：跟字數計算同一個定義。 */
const isEmpty = t => bareTrack(t).length === 0;

/**
 * 尾端空軌砍掉，中間留位 —— 擠掉「和弦1」會讓和弦2 靜默變成 chord1。
 * 匯入端會濾掉空聲部，所以中間空軌往返後仍會塌掉一格。
 */
function keep(texts) {
  const out = [...(texts ?? [])];
  while (out.length > 1 && isEmpty(out[out.length - 1])) out.pop();
  return out;
}

/** 貼進遊戲的形狀：剝外殼與註解、去空白、去 `@n`。 */
const oneLine = t => stripPrograms(bareTrack(t));

/**
 * 保留換行的形狀。每行去頭尾空白、丟空行 —— 剝掉 3MLE 的小節標記後只剩兩格縮排，
 * 整行只有標記的會變空行。內部換行不動。
 */
const multiLine = t =>
  stripPrograms(stripWrapper(t ?? ""))
    .split(/\r?\n/).map(s => s.trim()).filter(Boolean).join(CRLF);

/**
 * `.mml` 一軌的本文。行首 `[` 會切斷 INI 結構 —— `[ceg]` 是和弦擴充卜語法，而格式化
 * 換行按小節換，和弦落在小節開頭並不罕見；3MLE 與 sections() 都會把那行當成新的
 * section 標頭（容許前置空白，縮排救不了）。一有這種行就整軌退回單行。
 */
function channelBody(t) {
  const s = multiLine(t);
  return /^[ \t]*\[/m.test(s) ? oneLine(t) : s;
}

/** INI 的值不能有換行。 */
const iniValue = s => String(s ?? "").replace(/[\r\n\t]+/g, " ").trim();

// ─── .mml（3MLE 專案檔） ────────────────────────────────────────────────────

/**
 * 各聲部 → 3MLE 專案檔。
 *
 * 給得出 `programs` 就寫 `[3MLE EXTENSION]`；這個 section 不能省，11 個真實檔案
 * 全都有。bzip2 走 js/bzip2.js，`c=` 是 `crc32(整串 base64 的 ASCII 文字)`，見
 * mml-ext.js。Channel 編號照陣列位置連號編 —— 擴充區塊按 index 掛樂器，錯位就是
 * 把長笛的音色掛到貝斯上。`programs` 用原始軌索引對齊。
 *
 * @param {string[]} texts 各分頁的原始文字
 * @param {{title?: string, programs?: number[],
 *          meters?: {tick:number,num:number,den:number}[]}} [opts]
 *        `programs` 沒給就不寫擴充區塊。
 *
 * 只帶得走曲首拍號（tag 0x04 沒有位置欄位），變拍請匯出 `.mid`。
 */
export function toMml(texts, { title = "", programs = null, meters = [], marks = [] } = {}) {
  const list = keep(texts);
  const lines = [
    "[Settings]",
    // TextEncoder 沒有 big5，而標題可能日是中文。擴充區塊的軌名不跟這個宣告走
    // （3MLE 看系統 ANSI 碼頁），見 mml-ext.nameBytes。
    "Encoding=utf-8",
    `Title=${iniValue(title)}`,
    "Source=",
    "Memo=",
  ];
  list.forEach((t, i) => lines.push(`[Channel${i + 1}]`, channelBody(t)));

  const ext = programs
    ? buildExtension(list.map((_, i) => ({
      channelNumber: i + 1,
      name: positionName(i),
      program: Number.isInteger(programs[i]) ? programs[i] : 0,
    })), meters.find(m => m.tick === 0) ?? null,
    // tick 換回 3MLE 的 PPQ 96（480/96 = 5）。
    marks.map((m, i) => ({ tick: Math.round(m.tick / 5), text: m.text, color: markColor(i) })))
    : null;
  // buildExtension 已以 CRLF 分行且結尾有一個，直接接。
  return lines.join(CRLF) + CRLF + (ext ?? "");
}

// ─── .mmi（瑪奇樂譜檔） ─────────────────────────────────────────────────────

/**
 * 各聲部 → 瑪奇樂譜木檔。
 *
 * 一軌一個 mml-track，補成樣本的三欄形狀 `MML@<本文>,,;`（瑪奇的一個 mml-track
 * 最多裝 3 個聲部，但那樣三個聲部要共用一個 program）。`program=` 有寫，匯入端已
 * 在讀它；songProgram / panpot / visible 照樣本寫死。
 *
 * @param {string[]} texts 各分頁的原始文字
 * @param {{title?: string, programs?: number[], bpm?: number,
 *          meters?: {tick:number,num:number,den:number}[]}} [opts]
 */
export function toMmi(texts, { title = "", programs = [], bpm = 120, meters = [], marks = [] } = {}) {
  const head = meters.find(m => m.tick === 0) ?? { num: 4, den: 4 };
  const changes = meters.filter(m => m.tick > 0);
  const lines = [
    "[mml-score]",
    "version=1",
    `title=${iniValue(title)}`,
    "author=",
    // 曲首拍號。
    `time=${head.num}/${head.den}`,
    // 只寫 tick 0 那一個，途中變速樣本裡沒有；t 本體照樣留在 MML 文字裡。
    `tempo=0T${Math.max(1, Math.round(bpm) || 120)}`,
  ];
  keep(texts).forEach((t, i) => lines.push(
    `mml-track=MML@${oneLine(t)},,;`,
    `name=${positionName(i)}`,
    `program=${Number.isInteger(programs?.[i]) ? programs[i] : 0}`,
    "songProgram=-1",
    "panpot=64",
    "visible=true"));

  // 變拍走 3MLE 自己的 `[time-signature]`（brolly-good-show.mmi 就有這一節），
  // 木格式 `<3MLE tick>=<分子>/<分母>`，tick 換回 PPQ 96。
  if (changes.length) {
    lines.push("[time-signature]");
    for (const m of changes) lines.push(`${Math.round(m.tick / 5)}=${m.num}/${m.den}`);
  }
  // 段落標記同樣是 3MLE 的區塊。換行會毀掉這個格式，cleanMarks 已換成空白。
  if (marks.length) {
    lines.push("[marker]");
    for (const m of marks) lines.push(`${Math.round(m.tick / 5)}=${m.text}`);
  }
  return lines.join(CRLF) + CRLF;
}

// ─── 檔名 ───────────────────────────────────────────────────────────────────

/**
 * 這三支**住在 util.js**，這裡只是轉出去 —— 呼叫端與測試因此一行都不用改。
 *
 * 搬下去的理由是鋼琴瀑布影片頁只要 `safeFileName` 這七行，而 import 這個模組會一路拉進
 * `mml-ext.js` 與 `bzip2.js`（54 KB），那條路上一個位元組都用不到。util.js 是這棵樹的葉子
 * （自己不 import 任何東西），放那裡誰都拿得到，而且誰都不必付別人的帳。
 */
export { DEFAULT_NAME, stripExt, safeFileName } from "./util.js";
