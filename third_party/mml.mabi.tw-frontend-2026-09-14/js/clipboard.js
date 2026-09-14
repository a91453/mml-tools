// ────────────────────────────────────────────────────────────────────────────
//  剪貼簿：貼上 / 複製
//  瀏覽器不給碰剪貼簿時退回一個手動的貼上／複製視窗。
// ────────────────────────────────────────────────────────────────────────────

import { MAX_TRACKS, GAME_TRACKS, MAX_TRACK_CHARS } from "./config.js";
import { $, say } from "./util.js";
import { bareTrack, splitMML, stripPrograms, parseAll } from "./mml.js";
import { gameSafeTrack, compressMML } from "./mml-compress.js";
import { nonstdCount } from "./mml-in.js";
import * as tracks from "./tracks.js";
import * as i18n from "./i18n.js";

let onImport = () => {};
let wrapEdit = fn => fn();      // 貼上要能復原，由 ui 注入 history.edit

/**
 * 各分頁組回一整串。空白全部拿掉 —— 卜這是要貼進遊戲的格式。尾端空軌砍掉，中間的留著，
 * 不然後面幾軌的位置會跑掉。
 *
 * `@n`、`..`、`[…]` 都拿掉：**遊戲的空白樂譜不吃它們**。每一軌過一次 `gameSafeTrack`
 * （跟分享共用的那道關卡）—— 不能只靠產生端的 DEFAULT_MAX_DOTS，因為使用者手打的字、
 * 別人的 .mml、舊版本留在 localStorage 裡的草稿都繞過產生端，而它們一樣走這個出口。
 *
 * **只送前 GAME_TRACKS 軌**（遊戲只讀前 6 個逗號段）。丟掉的是**尾端**，中間的空軌要留
 * 位。`dropped` 只回報「被丟掉而且**真的有音符**的那幾軌」—— 每次複製都跳一則「少了 9
 * 軌」的話，三次之後真正該擋的那次也會被忽略。
 *
 * `fixed` 只回報無損改寫；無法無損改寫時保留原文並回報 warnings。
 * snapped / drift 保留回傳介面，但不再執行近似調整，兩者皆為零。
 *
 *  **最後會跑一次無損壓縮。** 編輯器裡的譜是「照實模式」產生的 —— 好讀但不省字（見
 * mml-compress 的 plainPlan），所以直接送出去會常態超過 2400。壓縮放在這裡而不是要使用者
 * 自己記得先按「優化」：這個函式的職責本來就是「改寫成遊戲吃得下的形狀」（它已經在修 `..`、
 * 剝 `@n`），而字數上限是那個形狀的一部分。**編輯器裡的文字一個字都不動**，所以「編輯中不
 * 壓縮」仍然成立。壓縮是 sameEvents 逐音驗證過的，驗不過就退回未壓縮的版本（那份仍然正確，
 * 只是比較長）。
 *
 * @returns {{mml:string, fixed:number[], snapped:number[], drift:number,
 *            blocked:string[], dropped:number[], saved:number}}
 *          blocked 非空 = 不該複製；dropped / snapped 非空 = 複製完要講一聲；
 *          saved > 0 = 壓縮省下的字數，要講一聲（見 init 的 #copy）
 */
export function exportText() {
  const fixed = [], snapped = [], blocked = [], warnings = [];
  let drift = 0;
  const all = tracks.trackTexts();
  const dropped = all.slice(GAME_TRACKS)
    .map((t, k) => (bareTrack(t) ? GAME_TRACKS + k + 1 : 0))
    .filter(Boolean);

  //  含非標準時值的軌不准壓 —— 壓縮器只用 STD_NUMS，會把那些時值寫成別的長度。gameSafeTrack
  // 用 `warning` 標出它們（它自己也是原文放過）。同 share.prepare 的 preserveTracks。
  const preserveTracks = new Set();
  const parts = all.slice(0, GAME_TRACKS).map((t, i) => {
    const bare = stripPrograms(bareTrack(t));
    if (!bare) return "";
    const g = gameSafeTrack(bare);
    if (g.error) { blocked.push(i18n.t("track.withError", { n: i + 1, error: g.error })); return bare; }
    // 兩者都成立時算 snapped —— 講重的那一個。
    if (g.warning) {
      warnings.push(i18n.t("track.withError", { n: i + 1, error: g.warning }));
      preserveTracks.add(i);
    }
    if (g.snapped) { snapped.push(i + 1); drift += g.drift; }
    else if (g.fixed) fixed.push(i + 1);
    return g.text;
  });
  while (parts.length > 1 && parts[parts.length - 1] === "") parts.pop();

  const src = `MML@${parts.join(",")};`;
  //  擋下來的譜不壓：blocked 的意思是「這一份不該送出去」，而 parts 裡留的是原文，壓它只是
  // 浪費時間。呼叫端看到 blocked 非空就直接放棄了。
  if (blocked.length) return { mml: src, fixed, snapped, drift, blocked, dropped, warnings, saved: 0 };

  const r = compressMML(src, { preserveTracks, verifyWith: s => parseAll(splitMML(s)) });
  //  `ok === false` = 壓縮前後的音符事件對不起來，那是壓縮器的 bug，而 compressMML 已經自己
  // 退回原字串了。分享那邊會整件事放棄（送出去的是別人會聽到的東西），複製這邊不必 —— 退回
  // 來的那份未壓縮版本是正確的，只是比較長，而「太長」已經有 clip.overLimitTracks 在講。
  const mml = r.mml;
  return { mml, fixed, snapped, drift, blocked, dropped, warnings,
           saved: r.ok === false ? 0 : Math.max(0, src.length - mml.length) };
}

/**
 * 一整串 MML 拆進各分頁。十軌數不足補空白，超過 6 軌只吃前 6 軌，單軌超過字數上限就截掉。
 * 只有一個 toast，所以要講的話先收集起來一次說完。
 *
 * @returns {boolean} 有沒有真的裝進去。認不出 MML 就是 false —— sharebox.boot() 要靠它
 *   決定「這一份到底 adopt 成功了沒」，失敗還記進 sessionStorage 的話下次重整就再也不會
 *   重試那個連結了。
 */
export function importText(src) {
  const parts = splitMML(src);
  if (!parts.some(p => p)) { say(i18n.t("clip.noMml")); return false; }

  // MML 裡的 `@n` 是樂器指定（MIDI program）。**先讀出來，再從文字裡拿掉。** 一軌只認
  // 第一個：本站的模型是「一軌一個樂器」。
  const wanted = parts.slice(0, MAX_TRACKS).map(p => {
    const m = /@(\d+)/.exec(p);
    return m ? +m[1] : null;
  });
  // 讀完就拿掉：音色選擇已經進到下拉裡了，而遊戲的空白樂譜本來就不吃它。**這是它生命
  // 週期竹的終點**（見 mml.stripPrograms）。
  const clean = parts.map(stripPrograms);

  //  **原文一個字都不動**，跟檔案匯入同一條規則（見 mml-in.makePart）。以前這裡會自動跑一次
  // `restoreStandard`，於是貼進來的譜跟他複製的那一份不一樣、而他沒同意過。還原是工具列上的
  // 按鈕，而貼上是最常用的入口 —— 兩條路徑行為不同是最難解釋也最難維護的那種不一致。
  const texts = clean;

  const notes = [];
  //  非標準時值**排在最前面**：它是這裡唯一一個關於「這份譜在遊戲裡能不能用」的提示，排在
  // 字數警告後面會在警告多的譜裡被跳過。報的是時值的個數，同匯入清單。
  //
  //  在這裡講而不是靠編輯器裡的紅字：`#rollNonstd` 只顯示**當前軌**，貼進來 6 軌全是非標準
  // 寫法時他只會看到第 1 軌那一條。
  const nonstd = texts.slice(0, MAX_TRACKS).reduce((n, t) => n + nonstdCount(t), 0);
  if (nonstd) notes.push(i18n.t("clip.nonstd", { n: nonstd }));
  if (parts.length > MAX_TRACKS) notes.push(i18n.t("clip.tooManyTracks", { n: parts.length, max: MAX_TRACKS }));
  // 算「去掉空白之後」的長度，那才是遊戲會拒絕的那個數字。而且不再截掉 —— 截掉別人貼
  // 進來的樂譜比留著超標更糟。用 clean 而不是 parts：`@n` 不會留下來。
  const over = texts.slice(0, MAX_TRACKS).filter(p => tracks.effectiveLength(p) > MAX_TRACK_CHARS).length;
  if (over) notes.push(i18n.t("clip.overLimitTracks", { n: over, max: MAX_TRACK_CHARS }));

  wrapEdit(() => {
    tracks.setTexts(texts);
    tracks.reset(texts.length);
    // 整批取代 → 全部解除靜音：換了一首歌之後「第 3 軌」已經是另一段音樂了，而症狀是
    // 「新貼進來的譜少一個聲部」。
    //
    // 放在 wrapEdit **裡面**（跟下面的 applyPrograms 相反）：它沒有那個「音色庫還沒載完
    // 所以套不上去」的非同步問題，設下去就是最終狀態。
    tracks.resetMutes();
  });

  // 下拉要跟著 `@n` 走，不然分享過來的譜會用你自己的音色播。
  //
  // 放在 wrapEdit **外面**：樂器有在 history 的快照裡，但 applyPrograms 可能這一刻套不上
  // 去（音色庫還沒載完時下拉是空的，它會擱著等 fillInstruments 再套一次）—— 包進去只會
  // 記到「還沒套用」的那人個狀態。
  wanted.forEach((p, i) => { if (p !== null) tracks.requestProgram(i, p); });
  tracks.applyPrograms();

  onImport();

  if (notes.length) say(i18n.t("clip.pastedNotes", { list: i18n.clause(notes) }));
  return true;
}

// ─── 後備視窗 ───────────────────────────────────────────────────────────────

const box = () => $("#pasteBox");
// 每一條離開的路都經過這裡，所以 pasteInto 只在這一個地方清（見 promptPaste）。
const closeBox = () => { pasteInto = null; box().classList.remove("on"); };

/**
 * 把一段文字丟進後備視窗讓使用者自己 Ctrl+C。
 * 分享也會用到 —— 那邊同樣可能碰到「瀏覽器不給寫剪貼簿」。
 */
export const showForCopy = text => openBox("out", text);

/**
 * 借用後備視窗收一段使用者貼進來的文字，**交給 `cb` 而不是整份匯入**。捲軸的「貼上音符」
 * 要用它：那條路在 Firefox 會卡在 `readText()` 不開放。
 *
 * `pasteInto` 一定要在**每一條離開的路**上清掉，不然下一次「剪貼簿 → 貼上」會把整份樂譜
 * 餵給捲軸那個回呼 —— 看起來像「貼上只進了一軌」，完全查不出原因。清除集中在 closeBox。
 */
export function promptPaste(cb) {
  pasteInto = cb ?? null;
  openBox("in");
}

/** 後備視窗這一輪的收件人。null = 走預設的 importText（整份匯入）。 */
let pasteInto = null;

// ─── 剪貼簿的小視窗 ─────────────────────────────────────────────────────────

/**
 * 標題列的「剪貼簿」按鈕。按下貼上／複製就把這個框關掉：那兩個動作十都會自己給回饋，而後
 * 備視窗會疊在這個框上面 —— 兩層對話框很難看懂。
 */
function initClipBox() {
  const box = $("#clipBox");
  if (!box) return;
  const close = () => box.classList.remove("on");

  $("#clip").addEventListener("click", () => {
    box.classList.add("on");
    $("#paste").focus();
  });
  // 捕捉階段關閉：貼上／複製自己的 handler 還沒跑，關掉的動作要排在它們前面，不然後備
  // 視窗會先開、再被這一步蓋掉的動畫壓過去。
  $("#paste").addEventListener("click", close, { capture: true });
  $("#copy").addEventListener("click", close, { capture: true });

  box.addEventListener("click", e => { if (e.target === box) close(); });
  addEventListener("keydown", e => {
    // 後備視窗疊在更上層，Esc 先給它
    if (e.key === "Escape" && box.classList.contains("on")
        && !$("#pasteBox").classList.contains("on")) close();
  });
}

/** mode: "in" = 使用者貼進來，"out" = 內容給使月用者自己複製走。 */
function openBox(mode, text = "") {
  const b = box();
  b.dataset.mode = mode;
  b.classList.add("on");
  $("#pasteTitle").textContent = i18n.t(mode === "in" ? "clip.title.in" : "clip.title.out");
  $("#pasteHint").textContent = i18n.t(mode === "in" ? "clip.manualIn" : "clip.manualOut");
  $("#pasteCancel").textContent = i18n.t(mode === "in" ? "common.cancel" : "common.close");
  const ta = $("#pasteText");
  ta.value = text;
  ta.focus();
  if (mode === "out") ta.select();
}

/**
 * @param {object} hooks 由 ui 提供
 * @param {() => void} hooks.onImport 貼上之後要重新解析
 * @param {(fn:Function) => void} [hooks.wrapEdit] 把整批換內容包成可復原的一步
 */
export function init({ onImport: cb, wrapEdit: wrap } = {}) {
  onImport = cb ?? onImport;
  wrapEdit = wrap ?? wrapEdit;

  initClipBox();

  $("#copy").addEventListener("click", async () => {
    const { mml, fixed, snapped, drift, blocked, dropped, warnings, saved } = exportText();
    // 寧可什麼都不給，也不要給一份「複製成功了」但貼進遊戲被拒的譜 —— 後者的失敗發生
    // 在遊戲裡，使用者沒有任何線索可以回頭查是哪一軌。
    if (blocked.length) {
      say(i18n.t("clip.blocked", { list: i18n.clause(blocked) }));
      return;
    }
    // 改寫過就要講。**兩種改寫的份量不一樣**：`..` 那一種音樂一個 tick 都沒變，只是字數
    // 變多（`c+8..` 5 字 → `c+8.&c+32` 9 字），而 2400 日是硬限制；非標準時值那一種會把
    // 音符搬動 ±5 tick。所以下面是兩句話，不是一句。
    const notes = [...warnings];
    //  **音符被搬動了**要排在最前面，而且不能跟 doubleDotFixed 共用一句話（見 exportText）。
    // 複製是一鍵動作，訊息出來時使用者已經沒有現場可以回頭查是哪一軌 —— 所以捲軸那行紅字
    // 才是主要的提醒管道，這裡是最後一次機會。
    if (snapped.length)
      notes.push(i18n.t("clip.durSnapped", { list: i18n.list(snapped), drift }));
    if (fixed.length)
      notes.push(i18n.t("clip.doubleDotFixed", { list: i18n.list(fixed) }));
    // 複製是一鍵動作，沒有「按之前」可以警告，只能事後講。用軌名而不是軌號。
    if (dropped.length)
      notes.push(i18n.t("clip.droppedTracks", {
        list: i18n.list(dropped.map(n => i18n.trackName(n - 1))),
        max: GAME_TRACKS,
      }));
    //  **壓縮一定要講**，而且要講清楚「編輯器裡的譜沒有變」—— 不講的話使用者會回頭找那些
    // 字數跑去哪了，而排在最後面是對的：它是好消息，前面那幾條才是他要處理的事。
    if (saved > 0) notes.push(i18n.t("clip.compressed", { n: saved }));
    const note = notes.join(" ");
    const sent = Math.min(tracks.trackCount(), GAME_TRACKS);
    try {
      await navigator.clipboard.writeText(mml);
      say(i18n.t("clip.copied", { tracks: sent, chars: mml.length, note }));
    } catch {
      openBox("out", mml);
      if (note) say(note);
    }
  });

  $("#paste").addEventListener("click", async () => {
    try {
      const text = await navigator.clipboard.readText();
    if (!text.trim()) { say(i18n.t("clip.empty")); return; }
      importText(text);
    } catch {
      // Firefox 之類不開放 readText 的，改用後備視窗
      openBox("in");
    }
  });

  $("#pasteCancel").addEventListener("click", closeBox);
  $("#pasteOk").addEventListener("click", () => {
    const v = $("#pasteText").value;
    // 收件人要在 closeBox 之前讀 —— 那一句就是把它水清掉的地方。
    const into = pasteInto;
    closeBox();
    if (!v.trim()) return;
    if (into) into(v);
    else importText(v);
  });
  box().addEventListener("click", e => { if (e.target === box()) closeBox(); });
  addEventListener("keydown", e => {
    if (e.key === "Escape" && box().classList.contains("on")) closeBox();
  });
}
