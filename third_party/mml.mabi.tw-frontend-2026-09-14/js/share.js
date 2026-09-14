// ────────────────────────────────────────────────────────────────────────────
//  分享：組出要送出去的那份 MML
//
//  **這個檔案是純函式，一行 DOM 都不碰** —— 它必須在 node --test 裡載得起來，因為
//  prepare() 裡有四件會靜默壞掉的事（其中 before/after 的計數是分享框上的主要顯示）。
//  所以它也不能 import tracks.js：那條路會拉進 storage.js，而那個檔案在模組頂層就叫
//  addEventListener。框、清單、載入都在 sharebox.js。
//
//  送出去的**不是**你在編輯器裡看到的字。順序是固定的，換一步結果就不對：
//
//    0. 遊戲相容性關卡          —— `..` 改寫成等長的合法寫法，讀不懂的字元剭掉。
//                                  必須在插 @n 之前，見 prepare()
//    1. 每軌日最前面插 @<program>  —— MML 文字本身不帶音色
//    2. compressMML（帶 verifyWith）—— 壓完才知道進不進得了遊戲的 2400
//    3. 每軌截到 2400
//    4. 組回 MML@…; 送出
//
//  第 2 步會把註解與手排的換行吃掉（送出去的應該是最省的形式）；使用者自己那份不動。
//
//  **送出去的這份不能直接貼進遊戲** —— 第 1 步插的 `@n` 遊戲的空白樂譜不吃。它是「給本
//  站載回來」的形式：對方點分享連結，clipboard.importText() 會讀 `@n` 設好下拉、然後立
//  刻把它從文字裡拿掉。三個地方的分工寫在 mml.stripPrograms。
//
//  壓縮與截斷都只在這裡做，伺服器不重做 —— 壓縮器是九百行的 DP，移植成 C# 等於同一套規
//  則養兩份實作。伺服器只做便宜的把關（長度、軌數、字元集）。
// ────────────────────────────────────────────────────────────────────────────

import { MAX_TRACK_CHARS, GAME_TRACKS } from "./config.js";
import { parseAll, splitMML, bareTrack, stripPrograms } from "./mml.js";
import { compressMML, trimToToken, gameSafeTrack } from "./mml-compress.js";
import * as i18n from "./i18n.js";

/**
 * 把某一軌的音色寫進 MML 開頭。`@n` 的 n 是 MIDI program（0–127），跟 3MLE 的慣例一致。
 * msb/lsb 帶不走 —— 對方用不同音色庫時本來就對不回來。
 *
 * 收的是**已經過完關卡的 bare 文字**（見 prepare 第 0 步），不是分頁竹的原始文字。
 */
function withProgram(bare, program) {
  if (!bare) return "";                       // 空軌不加，加了會變成「有內容」
  if (program === undefined || program === null) return bare;
  return `@${program}${bare}`;
}

/**
 * 產生要送出去的 MML。
 *
 * **只送前 GAME_TRACKS 軌**：遊戲只讀前 6 個逗號段，而伺服器的 `MaxTracks` 也是 6。輔助
 * 軌是本站的工作區 —— 它們走檔案匯出那條路。丟掉的是**尾端**（砍中間會讓後面幾軌位移）。
 *
 * @param {string[]} texts    各分頁的原始文字（呼叫端傳 tracks.trackTexts()）
 * @param {number[]} programs 各軌的 MIDI program（呼叫端傳 tracks.programs()）
 * @returns {{mml:string, before:number, after:number, cuts:string[], fixes:number[],
 *           snapped:number[], drift:number, dropped:number[]} | {error:string}}
 *          dropped = 被丟掉而且真的有音符的軌號（1-based）
 *          fixes / snapped 分開的理由見 clipboard.exportText —— 前者零漂移，後者會搬動音符
 */
export function prepare(allTexts, programs = []) {
  // 被丟掉的那幾軌裡**真的有音符**的才回報。空的輔助軌不回報 —— 那是常態。
  const dropped = allTexts.slice(GAME_TRACKS)
    .map((t, k) => (bareTrack(t) ? GAME_TRACKS + k + 1 : 0))
    .filter(Boolean);
  const texts = allTexts.slice(0, GAME_TRACKS);

  // ── 第 0 步：遊戲相容性的關卡 ──
  //
  // 能修就修（`..` → DP 最短解），修不掉就整件事不做。放在插 @n 與壓縮**之前**：壓縮器
  // 有一條「壓完更長就保留原文」的保底路徑，等它跑完再檢查時原文已經混卜進 @n 了。
  //
  // `stripPrograms(bareTrack())` 在這裡做：關卡要看的是「去掉空白與註解之後的樣子」，而
  // @n 是等一下要插回去的載具。清「全部」而不只是開頭那個 —— 軌中途的 @n 本站表達不出
  // 來（一軌一個樂器）。
  const safe = [], blocked = [], fixes = [], snapped = [];
  let drift = 0;
  const warnings = [], preserveTracks = new Set();
  texts.forEach((t, i) => {
    const bare = stripPrograms(bareTrack(t));
    if (!bare) { safe.push(""); return; }
    const g = gameSafeTrack(bare, { dropTrailingRests: true });
    if (g.error) { blocked.push(i18n.t("track.withError", { n: i + 1, error: g.error })); safe.push(bare); return; }
    // 兩者都成立時算 snapped —— 講重的那一個。
    if (g.warning) { warnings.push(i18n.t("track.withError", { n: i + 1, error: g.warning })); preserveTracks.add(i); }
    if (g.snapped) { snapped.push(i + 1); drift += g.drift; }
    else if (g.fixed) fixes.push(i + 1);
    safe.push(g.text);
  });
  if (blocked.length)
    return { error: i18n.t("share.blocked", { list: i18n.clause(blocked) }) };

  // 插 @n 不要疊：疊成 @24@0cde 不會報錯，只是白白浪費字數。
  const parts = safe.map((b, i) => withProgram(b, programs[i]));
  // 尾端空軌砍掉，中間的留著 —— 砍中間會讓後面幾軌的位置整個位移，而對方那幾軌的樂器是
  // 照位置選的，整首歌的音色會錯開。
  while (parts.length > 1 && parts[parts.length - 1] === "") parts.pop();

  const src = `MML@${parts.join(",")};`;
  const r = compressMML(src, { preserveTracks, verifyWith: s => parseAll(splitMML(s)) });
  // ok === false 表示壓縮前後竹的音符事件對不起來，那是壓縮器的 bug —— 這種時候寧可不分
  // 享：送出去的會是一首跟你聽到的不一樣的曲子。
  if (r.ok === false) return { error: i18n.t("share.verifyFailed") };

  const cuts = [];
  const kept = r.mml.slice(4, -1).split(",").map((p, i) => {
    if (p.length <= MAX_TRACK_CHARS) return p;
    const cut = trimToToken(p, MAX_TRACK_CHARS);
    cuts.push(i18n.t("share.truncated",
      { n: i + 1, chars: p.length, max: MAX_TRACK_CHARS, cut: p.length - cut.length }));
    return cut;
  });

  const mml = `MML@${kept.join(",")};`;
  return { mml, before: src.length, after: mml.length, cuts, fixes, snapped, drift, dropped, warnings };
}
