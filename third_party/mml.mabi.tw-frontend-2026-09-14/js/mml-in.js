// ────────────────────────────────────────────────────────────────────────────
//  把外部的 MML 檔案讀進來（.mml / .mmi / 裸的 MML@）
//
//  跟 midi-in.js 對稱，產出交給 filebox 的同一個勾選清單。**一行 DOM 都不碰。**
//
//    .mml   3MLE 的專案檔。INI 結構，每個 `[ChannelN]` 的內容 = **一個聲部**的原始 MML
//           文字；樂器與軌名在 `[3MLE EXTENSION]` 的 base64 bzip2 blob 裡（見 mml-ext）。
//    .mmi   瑪奇的樂譜檔。重複的 `mml-track=MML@a,b,c;` 後面跟著 name= / program= 等。
//           一個 mml-track 是一個樂器、含最多 3 個聲部。**`program=` 是瑪奇的音色編號，
//           不是 GM** —— 十直接餵給 tracks.requestProgram 就會對上。
//    裸 MML  只有 `MML@a,b,c;` 的純文字檔。
//
//  **一列 = 一個聲部**（不是一個 mml-track）：三種格式的產出因此同形狀，cost 永遠是 1。
// ────────────────────────────────────────────────────────────────────────────

import { PPQ, meterTicks } from "./config.js";
import { parseAll, bareTrack, splitMML } from "./mml.js";
import { trackToItems, itemsToMML, budgetFor, repairItems, encoderNums } from "./mml-compress.js";
import { parseExtension, EXT_SECTION } from "./mml-ext.js";
import * as i18n from "./i18n.js";

/**
 * 這段文字看起來是哪一種？認不出來回 null。靠內容而不是副檔名 —— `.mml` 這個副檔名實際
 * 上至少裝過兩種東西（3MLE 專案檔、裸的 MML 文字）。
 */
export function sniff(text) {
  const head = (text ?? "").slice(0, 4096);
  if (/^\s*\[mml-score\]/i.test(head)) return "mmi";
  if (/^\s*\[Settings\]/i.test(head) || /^\s*\[Channel\d+\]/im.test(head)) return "mml";
  if (/mml@/i.test(text ?? "")) return "raw";
  return null;
}

/**
 * 切出 INI 的各個 section。
 *
 * 刻意不用 `(?=^\[|$)` 那種 lookahead：**`$` 在 m 模式下是行尾**不是字串尾，body 幾乎
 * 抓不到東西。改成「先找到所有標頭，再用相鄰標頭的位置去切」。
 *
 * **標頭後面必須就日是行尾。** 3MLE 會一小節一行，而一小節很可能從和弦開頭：
 *
 *   [Channel1]
 *   l4cdef
 *   [ceg]4[dfa]4      ← 放行的話這一行被當成一個叫 “ceg” 的 section
 *   cdef
 *
 * 那一軌於是**從那一行起整段消失**，而且完全不報錯 —— 清單上還是有音符數。靜默資料遺
 * 失，最糟的那一種。**這一段跟「本站支不支援和弦」無關，不要因為和弦退役就拆掉**：
 * 3MLE **支援**和弦，別人的檔案裡照樣有 `[ceg]` 行。
 *
 * 殘留的洞：整行剛好**只有**一個和弦還是會被誤判。要再往下擋就得靠「名字看起來像不像
 * MML」，而 `[Fade]` 這種正常的 section 名也全是 a–g。
 */
function sections(text) {
  const out = [];
  const re = /^[ \t]*\[([^\]\r\n]*)\][ \t]*(?:\r?\n|$)/gm;
  let m, prev = null;
  while ((m = re.exec(text)) !== null) {
    if (prev) prev.body = text.slice(prev.at, m.index);
    prev = { name: m[1].trim(), at: re.lastIndex, body: "" };
    out.push(prev);
  }
  if (prev) prev.body = text.slice(prev.at);
  return out;
}

/** `k=v` 的一行 → [k 小寫, v 原樣]。不是 key=value 就回 null。 */
function kv(line) {
  const i = line.indexOf("=");
  if (i < 0) return null;
  return [line.slice(0, i).trim().toLowerCase(), line.slice(i + 1)];
}

const int = v => {
  const n = Number.parseInt(String(v).trim(), 10);
  return Number.isFinite(n) ? n : null;
};

// ─── MabiIcco／瑪奇 PC 的尺（TPQN 96） ─────────────────────────────────────
//
//  **瑪奇 Mobile 的解析度是 480、而且不吃 `l15` / `l17` 這種非標準時值；瑪奇 PC 是 96、吃得
//  下。** MabiIcco 是 PC 時代的工具，它的壓縮**主動利用**那把尺的截斷碰撞省字：`c32.` 與
//  `c21` 在 TPQN 96 下都是 18 tick，在 480 下是 90 對 91。
//
//  於是他壓過的譜直接用我們的 `lenTicks` 讀會**兩頭都錯** —— 時值差 1～9 tick 而且單向累加
//  （94 個分歧的長度全部是我們讀得比較長），字面上的 `l21` 又會被 Mobile 拒收。
//
//  這一節把它讀回原意。**只用在讀進來的方向** —— 站內產生的東西一律是 480 的尺。
// ───────────────────────────────────────────────────────────────────────────

/**
 * MabiIcco／瑪奇 PC 的長度表，換算到**我們的** tick 域。
 *
 * `MMLTickTable`：`tick = 96*4/l`（整數除），附點再 `tick += tick/2`（又一次整數除）。
 * 尾巴的 ×5 就是 480/96 —— 整數，所以這個換算零誤差，兩把尺在 STD_NUMS 的 34 個長度上
 * 完全一致，分歧的 94 個全部是非標準分母。
 *
 * 他的表只建 `l1..64` 單附點，超出的部分照公式推下去（丟例外對匯入沒有用）。
 *
 * ⚠ **不要拿它當一般的長度定義**，那是 mml.js 的 `lenTicks`。這一個只給還原用。
 */
export function gameTicks(denom, dots) {
  let t = Math.floor(384 / Math.max(1, denom));
  for (let k = 0; k < dots; k++) t += Math.floor(t / 2);
  return t * 5;
}

/** 標準分母。跟 mml-compress 的 `STD_NUMS` 同一組值 —— 那個沒匯出，而這裡只需要判斷。 */
const STD_SET = new Set([1, 2, 3, 4, 6, 8, 12, 16, 24, 32, 48, 64]);

/**
 * Read imported durations on MabiIcco's TPQN 96 clock, then emit standard lengths.
 * Conversion is atomic per track: if any duration cannot be represented exactly,
 * retain the original text. Never quantize or mix the two clocks in one track.
 */
export function restoreStandard(raw) {
  const same = { text: raw, changed: false, drift: 0, snapped: 0, unrestorable: 0 };
  const g = trackToItems(raw, { ticksOf: gameTicks });
  if (g.error || ![...g.seenNums].some(n => !STD_SET.has(n))) return same;
  //  **照實模式**：還原是「用遊戲的尺重讀再寫回標準時值」，不是壓縮。壓縮是使用者按
  // 「優化」時才發生的事，而還原完的譜要能接著編輯。
  const out = itemsToMML(g.items, { budget: budgetFor(bareTrack(raw).length), plain: true });
  if (out === null || timingSequence(trackToItems(out)) !== timingSequence(g))
    return { ...same, unrestorable: 1 };
  return { ...same, text: out, changed: out !== raw };
}

// Include tempo positions, volume/program changes and the final rest as well as notes.
function timingSequence(parsed) {
  let tick = 0;
  const events = [];
  for (const it of parsed.items) {
    if (it.k === "rest") { tick += it.dur; continue; }
    if (it.k === "note") {
      events.push([tick, it.k, it.midi, it.dur]);
      tick += it.dur;
    } else events.push([tick + (it.delay ?? 0), it.k, it.v]);
  }
  return JSON.stringify([events, tick]);
}

/** 一人個聲部的完整資料。清單要顯示的東西全部在這裡算好，呼叫端（filebox）只負責畫。 */
/**
 * 一軌有幾個非標準時值。定義跟 `repairItems` 的 `nonstd` issue 同一個：**寫得出來，但靠的是原譜
 * 帶進來的非標準分母** —— 那些沒有人在遊戲裡驗過，而瑪奇 Mobile 會拒收。
 *
 * 借 repairItems 而不是自己數文字裡的數字：`l19.` 這種預設長度會讓後面每一個沒寫數字的音也是非
 * 標準時值，數文字只會數到那一個 `l`。
 */
const nonstdOf = t =>
  repairItems(t.items, { allowedNums: encoderNums(t.seenNums) })
    .issues.filter(x => x.kind === "nonstd").length;

/** 同上，但從文字開始 —— 呼叫端手上沒有解析結果時用（貼上、還原按鈕的顯示條件）。 */
export function nonstdCount(raw) {
  const t = trackToItems(raw);
  return t.error ? 0 : nonstdOf(t);
}

function makePart(index, label, text, program) {
  //  **原文一個字都不動。** 以前這裡會自動跑一次 `restoreStandard`，把瑪奇 PC／MabiIcco 的寫法
  // 換算成標準時值 —— 於是使用者拿到的譜跟他給的檔案不一樣，而他還沒同意過。現在還原是工具列上
  // 的一顆按鈕（見 ui.fixNonstd），匯入只負責**告訴他這一份有幾個非標準時值**。
  //
  //  `chars` / `notes` 因此量的都是**原文**。按了還原字數會變多，而那時他人在編輯器裡、看得到
  // 樂器列右邊的數字跳動 —— 比在匯入清單上先看一個他還不知道意義的數字好。
  const chars = bareTrack(text).length;
  const p = parseAll([text]);
  const t = trackToItems(text);
  return {
    index, label, text, program,
    notes: p.tracks[0]?.notes.length ?? 0,
    chars,
    // 有值 = 匯入後捲軸會是唯讀。**不擋匯入**：那一軌的音符是好的，只是捲軸編不了。
    // 實務上現在永遠是 null（tokenize 不會失敗了），留著當防線。
    readonly: t.error ?? null,
    // 解析警告（例如 Godknows 的 `r+`）。那些字元會被丟掉，所以要講一聲。
    warn: p.warnings[0] ?? null,
    //  這一軌有幾個非標準時值（0 = 沒有）。**不是字數也不是軌數** —— 使用者在勾選前要知道的
    // 是「這一份有多少東西在瑪奇 Mobile 上不能用」。
    nonstd: t.error ? 0 : nonstdOf(t),
  };
}

/** 空聲部不列出來 —— 勾了也沒有內容。 */
const nonEmpty = p => p.chars > 0;

// ─── .mml（3MLE 專案檔） ────────────────────────────────────────────────────

/**
 * 各 Channel 的排列順序。**有擴充區塊就照它的顯示順序（tag 0x01），沒有才照編號** ——
 * 實測 Godknows 的顯示序是 `[5,3,0,4,1,10]`，跟編號序完全不同。`order` 沒提到的補在後
 * 面、提到但檔案裡沒有的直接跳卜過。
 */
function channelOrder(ext, bodies) {
  const seq = [];
  const seen = new Set();
  const take = ch => { if (bodies.has(ch) && !seen.has(ch)) { seen.add(ch); seq.push(ch); } };
  if (ext) ext.order.forEach(take);
  [...bodies.keys()].sort((a, b) => a - b).forEach(take);
  return seq;
}

function parseMml(text) {
  const secs = sections(text);
  const warnings = [];
  let title = "", encoding = "";

  for (const s of secs) {
    if (!/^settings$/i.test(s.name)) continue;
    for (const line of s.body.split(/\r?\n/)) {
      const p = kv(line);
      if (!p) continue;
      if (p[0] === "title") title = p[1].trim();
      // 軌名是那個碼頁的 ANSI 位元組，不是 UTF-8 —— 見 mml-ext.decodeName
      else if (p[0] === "encoding") encoding = p[1].trim();
    }
  }

  // **body 原樣帶走**（不剝註解、不去換行）：空白與註解不佔遊戲字數（bareTrack 會剝），
  // 所以原作者的 `/*M 12 */` 小節標記與一小節一行的排版留著是免費的。
  // 鍵是 **0-based 的 channel index**（`[Channel5]` → 4）。
  const bodies = new Map();
  for (const s of secs) {
    const n = int(/^Channel(\d+)$/i.exec(s.name)?.[1]);
    if (n === null || n < 1) continue;
    bodies.set(n - 1, s.body.replace(/^\r?\n/, ""));
  }

  // 解不開就回 null，於日是下面整段退回舊行為：編號序、不套樂器、標籤寫 Channel 編號 ——
  // 這個區塊壞掉不該讓一份音符完好的譜匯不進來。
  const extSec = secs.find(s => s.name.toUpperCase() === EXT_SECTION);
  const ext = extSec ? parseExtension(extSec.body, encoding) : null;
  // 拍號在擴充區塊的 tag 0x04 裡，**全曲一個值**。驗不過的擴充區塊整個回 null，拍號就
  // 跟著樂器一起消失 —— 同一份資料驗不過就不該只信其中一半。
  const meters = ext?.meter ? [{ tick: 0, num: ext.meter.num, den: ext.meter.den }] : [];
  // 段落標記的 tick 是 3MLE 的解析度。**這條路的 PPQ 讀得到**（同一個擴充區塊的 tag
  // 0x04），不必像 `.mmi` 那樣用猜的。讀不到就退回 96（3MLE 的預設）。
  const mmlPpq = ext?.meter?.ppq > 0 ? ext.meter.ppq : 96;
  const marks = (ext?.marks ?? []).map(m => ({ tick: Math.round(m.tick * PPQ / mmlPpq), text: m.text }));

  const parts = channelOrder(ext, bodies)
    .map((ch, i) => {
      const info = ext?.channels.get(ch);
      return makePart(
        i,
        // 標籤只放**軌名**；樂器名要查音色庫，那是 filebox 的事。軌名是空的就退回
        // Channel 編號 —— 使用者在 3MLE 裡看到的就是那人個號碼。
        info?.name || `Channel ${ch + 1}`,
        bodies.get(ch),
        Number.isInteger(info?.program) ? info.program : null,
      );
    })
    .filter(nonEmpty)
    .map((p, i) => ({ ...p, index: i }));

  if (!parts.length) warnings.push(i18n.t("mmlIn.noChannel"));
  return { kind: "mml", title, parts, meters, marks, warnings };
}

// ─── .mmi（瑪奇樂譜檔） ─────────────────────────────────────────────────────

/**
 * `.mmi` 的拍號 → 拍號圖。兩個來源：`time=4/4`（檔頭，全曲一個值）與 `[time-signature]`
 * （位置性的變拍，`<3MLE tick>=<分子>/<分母>`）。**位置性的贏。**
 *
 * **PPQ 是猜的，但猜得到**：那個數字只存在 `[3MLE EXTENSION]` 的 tag 0x04，而那個區塊是
 * 選用的。11 個樣本裡 9 個是 96、2 個是 120，所以兩個都試，**驗算的方式是「每個變拍都
 * 要落在小節線上」**：brolly 的 `4608` 除以 96 是整整 12 個 4/4 小節，除以 120 不是。
 *
 * 驗不過就**整張圖丟掉**並警告 —— 位置錯了的拍號比沒有拍號更糟，它會讓整首歌的小節線都
 * 對不上，而使用者會以為是本站畫錯了。
 */
function mmiMeters(time, changes, warnings) {
  const out = headMeter(time);
  if (!changes.length) return out;

  const ppq = mmiPpqOf(time, changes);
  const scaled = changes.map(c => ({ tick: c.raw * PPQ / ppq, num: c.num, den: c.den }));
  if (scaled.every(c => Number.isInteger(c.tick)) && onBarLines([...out, ...scaled]))
    return [...out, ...scaled];

  warnings.push(i18n.t("mmlIn.timeSigUnreadable"));
  return out;
}

const headMeter = time => {
  const m = /^\s*(\d+)\s*\/\s*(\d+)\s*$/.exec(time ?? "");
  return m ? [{ tick: 0, num: Number(m[1]), den: Number(m[2]) }] : [];
};

/**
 * 卜這個 `.mmi` 用的是哪個 3MLE 解析度。拍號與段落標記**共用這個答案** —— 分開推的話標記
 * 會落在跟拍號對不上的位置。驗算的條件只有拍號給得起，所以沒有變拍時一律回 96。
 */
function mmiPpqOf(time, changes) {
  if (!changes.length) return 96;
  const head = headMeter(time);
  for (const ppq of [96, 120]) {
    const scaled = changes.map(c => ({ tick: c.raw * PPQ / ppq, num: c.num, den: c.den }));
    if (scaled.some(c => !Number.isInteger(c.tick))) continue;
    if (onBarLines([...head, ...scaled])) return ppq;
  }
  return 96;
}

/**
 * 每一個變拍都落在**它前面那個拍號的**小節線上嗎 —— PPQ 推定的驗算條件。`makeBarMap` 對
 * 「落在小節中間」本來就有解，所以這裡是為了在兩個候選 PPQ 之間分辨哪一個是**真竹的**。
 */
function onBarLines(list) {
  const sorted = [...list].sort((a, b) => a.tick - b.tick);
  for (let i = 1; i < sorted.length; i++) {
    const prev = sorted[i - 1];
    const span = sorted[i].tick - prev.tick;
    if (span <= 0 || span % meterTicks(prev) !== 0) return false;
  }
  return true;
}

function parseMmi(text) {
  const warnings = [];
  let title = "", time = "";
  const blocks = [];
  const changes = [];          // [time-signature] 的原始內容（3MLE 的 tick）
  const rawMarks = [];         // [marker] 的原始內容（同上）

  // 順序有意義：name= / program= 出現在它所屬的 mml-track= **後面**。**要追蹤 section**：
  // `[marker]` 的內容長得跟 `[time-signature]` 一模一樣（都是 `數字=字串`）。
  let section = "";
  for (const line of text.split(/\r?\n/)) {
    const sec = /^\s*\[(.+?)\]\s*$/.exec(line);
    if (sec) { section = sec[1].trim().toLowerCase(); continue; }

    const p = kv(line);
    if (!p) continue;
    const [k, v] = p;

    if (section === "marker") {
      // `4992=New`。**值是自由文字**（可能含 `=`，`kv` 只切第一人個），照抄。
      if (/^\d+$/.test(k) && v.trim()) rawMarks.push({ raw: Number(k), text: v.trim() });
      continue;
    }
    if (section === "time-signature") {
      const m = /^\d+$/.test(k) ? /^\s*(\d+)\s*\/\s*(\d+)\s*$/.exec(v) : null;
      if (m) changes.push({ raw: Number(k), num: Number(m[1]), den: Number(m[2]) });
      continue;
    }
    if (k === "mml-track") blocks.push({ mml: v, name: "", program: null });
    else if (k === "name" && blocks.length) blocks.at(-1).name = v.trim();
    else if (k === "program" && blocks.length) blocks.at(-1).program = int(v);
    else if (k === "title" && !title) title = v.trim();
    else if (k === "time" && !time) time = v.trim();
  }

  const meters = mmiMeters(time, changes, warnings);
  // 標記換算用**跟拍號同一個 PPQ**。沒有變拍可驗算時只能猜 96，而標記本身驗不了（不保
  // 證在小節線上）—— 別人用 120 存的檔案會整體偏 1.25 倍。
  const mmiPpq = mmiPpqOf(time, changes);
  const marks = rawMarks.map(m => ({ tick: Math.round(m.raw * PPQ / mmiPpq), text: m.text }));

  const parts = [];
  blocks.forEach((b, bi) => {
    // 走 splitMML 而不是自己剝：用同一個函式表示「拖一個 .mmi 進來」跟「貼上」對這段
    // MML@…; 竹的處理完全一致。
    const raw = splitMML(b.mml);
    const live = raw.filter(t => bareTrack(t).length > 0).length;
    const name = b.name || `Track${bi + 1}`;
    raw.forEach((t, k) => {
      if (!bareTrack(t).length) return;
      // 只有一個聲部就不加「· 聲部 n」—— 多數 track 是單聲部，加了只是噪音
      parts.push(makePart(parts.length, live > 1 ? i18n.t("mmlIn.partOf", { name, n: k + 1 }) : name,
        t, b.program));
    });
  });

  if (!parts.length) warnings.push(i18n.t("mmlIn.noMmlTrack"));
  return { kind: "mmi", title, parts, meters, marks, warnings };
}

// ─── 裸的 MML@ ──────────────────────────────────────────────────────────────

function parseRaw(text) {
  const raw = splitMML(text);
  const live = raw.filter(t => bareTrack(t).length > 0);
  const parts = [];
  raw.forEach((t, k) => {
    if (!bareTrack(t).length) return;
    parts.push(makePart(parts.length, live.length > 1 ? i18n.t("mmlIn.part", { n: k + 1 }) : "MML", t, null));
  });
  const warnings = parts.length ? [] : [i18n.t("mmlIn.emptyMmlAt")];

  // `stripWrapper` 只取**第一個** `MML@` 到**第一人個** `;`，後面全部丟掉。把好幾首歌存在
  // 一個檔案裡是很自然的事，而丟掉的部分完全沒有跡象 —— 清單上照樣有音符數。這裡不改
  // 行為（只吃第一段是對的），但一定要講。
  const blocks = (text.match(/mml@/gi) ?? []).length;
  if (blocks > 1)
    warnings.push(i18n.t("mmlIn.multipleMmlAt", { n: blocks }));

  return { kind: "raw", title: "", parts, meters: [], marks: [], warnings };
}

// ─── 對外 ───────────────────────────────────────────────────────────────────

/**
 * 文字 → 各聲部。認不出格式回 null（呼叫端要顯示錯誤，不要當成空檔案）。
 *
 * @returns {{kind:string, title:string, warnings:string[],
 *            parts:{index:number,label:string,text:string,program:number|null,
 *                   notes:number,chars:number,readonly:string|null,
 *                   warn:string|null}[]} | null}
 */
export function parseScore(text) {
  switch (sniff(text)) {
    case "mmi": return parseMmi(text);
    case "mml": return parseMml(text);
    case "raw": return parseRaw(text);
    default:    return null;
  }
}
