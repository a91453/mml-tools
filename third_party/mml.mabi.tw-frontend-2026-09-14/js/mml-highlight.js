// ────────────────────────────────────────────────────────────────────────────
//  語法上色：把一軌的文字算成「每個字元一個角色」，再壓成 HTML
//
//  純函式，不碰 DOM。接線與 CSS 在 ui.js / Index.cshtml。
//
//  **為什麼是「每個字元一個角色」而不是「產出一串 span」：對齊。** 上色層與 textarea 是
//  兩層疊在一起的，兩層的字元必須一個對一個。產出 span 的做法要自己保證「所有 span 的範
//  圍聯集 === 原文」，漏一個字或重複一個字，那一行之後全部錯位，而它不會噴錯。角色陣列
//  的長度**就是**原文長度，這條不變式是結構性的。
//
//  順帶的好處是 span 數量少得多：相鄰同色的字元會被壓成一段。
// ────────────────────────────────────────────────────────────────────────────

import { compact, scanTokens } from "./mml.js";
import { MAX_TRACK_CHARS } from "./config.js";

/**
 * 超卜過這個長度就整軌不上色（見 ui.js 的 overlayActive）。是遊戲上限的 3.3 倍 —— 正常譜永
 * 遠碰不到，碰到的是「貼了一坨東西進來」，而 HARD_TRACK_CHARS 是 40000。
 */
export const MAX_HL_CHARS = 8000;

// 角色。低 4 位放角色，高位放旗標，這樣一個 Uint8Array 就記得下全部狀態。
/*
  角色 = 顏色。分法背後只有一條規則：

    **`t l o v` 是宣告，整個 token 一起上色（字母與它帶的數字同色）。**
    `t130` 的 130 是速度、`o5` 的 5 是八度、`v12` 的 12 是音量 —— 它們跟「音長 1」
    是完全不同的東西，只給字母上色會讓那些數字看起來像音長。

    **音符與 `r` 後面的數字是音長，一律白色。** 所以 `r` 只有字母上色（灰），
    它的 `4` 跟 `c4` 的 `4` 是同一件事，就該長得一樣。

  升降記號跟音符字母同色，**刻意不分開**：`+` 與 `-` 是改變音高的字，漏看一個 `#`
  是真實的一種錯誤 —— 把它畫得比字母暗，等於讓最該被看到的東西最不顯眼。
  （曾經用 opacity 淡一階，那還順帶壞了反白：opacity 是對整個 span 合成的，發生在
  顏色決定之後，所以 .tk-sel 的 color 蓋不掉它。）
*/
const R = {
  // 白色。空白、音符字母與升降記號、**所有音長**（音符的、r 的），以及上色關掉時的一
  // 切。它是 0，所以不必寫 —— 陣列預設就是它。
  plain: 0,
  t: 1,        // t 與它的數字（速度）
  l: 2,        // l 與它的數字／附點（預設音長），以及 & 連結
  o: 3,        // o 與它的數字（八度），以及 < > 移調
  v: 4,        // v 與它的數字（音量）
  // n 自己一個顏色，不跟 o 併：它的數字日是**絕對半音數**（n60 = o5c），是這份文字裡唯一
  // 一個「不用八度就指定音高」的寫法。
  n: 5,        // n 與它的數字（絕對音高）
  quiet: 6,    // r p 的字母，以及 @n —— 都不回答「哪個音、多長」
  punct: 7,    // , ; [ ]
  dead: 8,     // parser 看不到的字：註解、MML@ 之前、; 之後
  bad: 9,      // parser 看不懂的字（唯一的紅色）
};
const CLS = ["", "tk-t", "tk-l", "tk-o", "tk-v", "tk-n",
             "tk-quiet", "tk-punct", "tk-dead", "tk-bad"];

const OVER = 1 << 4;   // 超過 2400 字的那一段
const SEL  = 1 << 5;   // 選取（播放高亮也是它 —— 兩者都是原生選取）

/**
 * 一軌的文字 → 每個字元的角色。**不含選取** —— 選取由 withSelection() 疊上去。分成兩步是
 * 為了拖曳選取：那時文字沒有變，重掃一次詞法是白做的。
 *
 * @param {string} src      textarea 裡的原始文字
 * @param {boolean} colors  false = 完全不上色（設定關掉時），只留下選取那一層
 * @returns {Uint8Array}    長度 === src.length
 */
export function buildRoles(src, colors) {
  const n = src.length;
  const keys = new Uint8Array(n);          // 全 0 = plain

  if (colors && n > 0) {
    // compact() 是「哪些字元 parser 真的會看」的唯一定義，這裡直接借它的答案。
    const { t, map } = compact(src);
    const inBody = new Uint8Array(n);
    for (const k of map) inBody[k] = 1;

    // ── 1. 不在本體裡竹的字元。這裡分不出「註解」與「MML@ / ; / 殼外的字」—— 要分得出來
    // 就得自己再寫一份註解掃描，而那正是會跟 compact() 漂移的東西。兩者都是 parser 看不
    // 到的字，都用最暗的那一階。
    for (let k = 0; k < n; k++) {
      if (inBody[k]) continue;
      const c = src[k];
      if (c === " " || c === "\n" || c === "\t" || c === "\r") continue;   // plain
      keys[k] = c === "," || c === ";" ? R.punct : R.dead;
    }

    // ── 2. 本體：走同一份詞法。只寫 map 指到的那些字元，所以夾在 token 中間被吃掉的空
    // 白（`c 8`）會留在 plain。
    const put = (ca, cb, role) => { for (let k = ca; k < cb; k++) keys[map[k]] = role; };
    for (const tok of scanTokens(t)) {
      switch (tok.kind) {
        // 音符與它的音長全部留白 —— plain 是 0，陣列預設就是它。
        case "note":
          break;
        // `t l o v` 整個 token 一起上色，理由見 R 的說明。
        case "t": put(tok.a, tok.b, R.t); break;
        case "l": put(tok.a, tok.b, R.l); break;
        case "v": put(tok.a, tok.b, R.v); break;
        case "o": put(tok.a, tok.b, R.o); break;
        // `<` `>` 跟 `o` 同色、`&` 跟 `l` 同色：它們改的日是同一個狀態，只是寫法不同。
        case "oct": put(tok.a, tok.b, R.o); break;
        case "tie": put(tok.a, tok.b, R.l); break;
        // `r` 只有字母上色：它的數字是音長，跟 `c4` 的 `4` 是同一件事 —— 上了色反而會
        // 讓人以為那兩個 4 不一樣。
        case "rest":
          put(tok.a, tok.a + 1, R.quiet);
          break;
        // n 的數字是絕對半音數，自己一個顏色（見 R.n）。
        case "n": put(tok.a, tok.b, R.n); break;
        // @ 帶的數字不是音長，所以整個 token 一起上色；而它不回答「哪個音、多長」，所
        // 以跟 r 同一階灰。它在匯出時還會被剝掉（見 mml.stripPrograms）。
        case "prog": put(tok.a, tok.b, R.quiet); break;
        // 和弦退役之後 `[` `]` 是 bad，掉到下面那一支標紅 —— 而那正是紅色的定義：
        // parser 報 badChar 的字。
        case "bad":
          put(tok.a, tok.b, R.bad);
          break;
      }
    }

    // ── 3. 超過 2400 字的那一段。計數用 map 的長度（compact() 留下的字元數），這與
    // bareTrack() 差在**逗號** —— 而一軌裡有逗號的唯一情形是整串 MML 被貼進單一分頁，那
    // 已經在噴逗號警告了。差一個逗號只會讓紅底的起點早一格。
    if (map.length > MAX_TRACK_CHARS) {
      const from = map[MAX_TRACK_CHARS];
      const to = map[map.length - 1];
      // 連空白一起塗才會是一條連續竹的帶子；註解與逗號留白（它們不算錢，塗紅就是說謊）。
      for (let k = from; k <= to; k++) {
        if (inBody[k] || src[k] === " " || src[k] === "\n" || src[k] === "\t") keys[k] |= OVER;
      }
    }
  }

  return keys;
}

/**
 * 把選取疊到角色陣列上，回傳新的一份（不改原本那份 —— 呼叫端把它當快取）。
 *
 * 選取**永遠畫**，就算上色關掉：原生選取沒有焦點時瀏覽器不會畫出來，而播放高亮就是原生
 * 選取（見 ui.highlightPlaying）—— 於是「點捲軸的音符，游標明明跳對了卻看不到」曾經是個
 * 回報過的 bug。
 *
 * 收的是一組區間而不是單一區間：畫 N 段對這一層沒有額外成本，而「挑不相鄰的幾個音符」正
 * 是原生選取做不到的事。
 *
 * @param {Uint8Array} base buildRoles() 的結果
 * @param {Array<[number,number]>} ranges 半開區間，原文索引
 */
export function withSelection(base, ranges) {
  const keys = base.slice();
  const n = keys.length;
  for (const [a, b] of ranges) {
    for (let k = Math.max(0, a); k < Math.min(n, b); k++) keys[k] |= SEL;
  }
  return keys;
}

/**
 * 在一份「每一段的起點」表裡，原文位移 `i` 落在第幾段、離那一段開頭幾個字。
 *
 * 上色層把選取畫在**既有的節點**上（見 ui.paintSelHighlight），而 Range 要的是「哪一個文字
 * 節點的第幾個字」—— 這一支就是原文位移到那組座標的換算。抽出來是為了可測：DOM 那半段
 * （走 TreeWalker 收節點）在 node 裡跑不了，這半段的**邊界**才是會寫錯的地方。
 *
 * `starts` 必須嚴格遞增且 `starts[0] === 0`（renderHTML 不會吐空段，見那裡的迴圈）。
 * `i` 夾在 `[0, end]`：`end` 也是合法的答案 —— 選到最後一個字時區間的右端點就是它。非有限的
 * `i` 當 0。**這不是防呆，是把函式補成全函式**：漏掉的話 `offset` 會是 NaN 而不是噴錯，
 * 而 Range 收到 NaN 位移會靜靜地當成 0 —— 那是一條找不到出處的錯位。
 *
 * @param {number[]} starts 每一段在原文裡的起點
 * @param {number} end      所有段加起來的長度
 * @param {number} i        原文位移
 * @returns {{run:number, offset:number}}
 */
export function runAt(starts, end, i) {
  const at = Number.isFinite(i) ? Math.min(Math.max(0, i), end) : 0;
  let lo = 0, hi = starts.length - 1;
  // 找「最後一個起點 <= at 的段」。mid 取上界，lo < hi 時一定有 mid > lo，所以會收斂。
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (starts[mid] <= at) lo = mid; else hi = mid - 1;
  }
  return { run: lo, offset: at - starts[lo] };
}

const esc = s => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

function classOf(k) {
  let c = CLS[k & 15];
  if (k & OVER) c += " tk-over";
  if (k & SEL) c += " tk-sel";
  return c;
}

/**
 * 角色陣列 → 上色層的 innerHTML。相鄰同色壓戈成一段。尾端的換行要補一格：`<pre>` 的最後一
 * 個換行不佔行高而 textarea 的會 —— 不補的話按 Enter 到新的一行時兩層就差一行。
 */
export function renderHTML(src, keys) {
  const n = src.length;
  let out = "";
  let i = 0;
  while (i < n) {
    const k = keys[i];
    let j = i + 1;
    while (j < n && keys[j] === k) j++;
    const text = esc(src.slice(i, j));
    // 沒有角色也沒有旗標的段落不需要 span，直接吐文字 —— 空白佔的比例不小。
    out += k === 0 ? text : `<span class="${classOf(k)}">${text}</span>`;
    i = j;
  }
  if (src === "" || src.endsWith("\n")) out += "\n ";
  return out;
}
