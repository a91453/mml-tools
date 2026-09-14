// ────────────────────────────────────────────────────────────────────────────
//  MusicXML 匯入（五線譜 OMR 的下半段）
//
//  後端的 OMR worker 吐 MusicXML，這裡把它變成 **`parseSMF()` 完全同形的產出**，
//  `inventory()`／`sample()`／`buildImport()` 一行都不用改地重用。
//
//  **一行 DOM 都不碰**：`DOMParser` 在 node 裡不存在，XML 用自己寫的極小讀取器解。
//
//  **一列 = 一組 (part, staff)**，不是 (part, voice)：`<voice>` 的編號每小節各自重編，
//  拿它當跨曲的軌身分會斷。
//
//  **`<backup>` 錯了就全毀。** homr 把 staff 1 與 staff 2 的音符交錯輸出，所以「照順序
//  累加 duration」的解析器會從第一個 backup 之後全錯，而且音符都在、只是人位置不對。
//
//  **譜號與調號不用處理**：`<pitch>` 的 `alter` 本身就是絕對的升降。
//  裝飾音（`<grace>`）的 `<duration>` 是 0 或不存在，留著會污染游標算術，丟掉。
//  三連音（`<time-modification>`）不做任何事（60 tick 的格線會把它打歪）。兩者都出警告。
//
//  **tie 與 slur 不能照標籤名字信**：homr 把連結線標成 `<slur>`。規則是**看兩端** ——
//  音高與 staff 完全相同才合併成一個長音，否則丟掉（不同音高合併會把兩個音併成一個）。
//
//  **多頁兩種形狀**：上傳圖片是多份各自從第 1 小節編號的 MusicXML，縫合在這裡做；
//  上傳 PDF 是一份連續編號的文件（`pages.length === 1`），不必縫合。
//
//   但 PDF 那一份裡 **`<divisions>` 一頁一個而且值不一樣**，所以換算必須在
//  `readPart` 裡逐個時值做。

import { PPQ, CELL_TICKS, chanOf } from "./config.js";
import { tempoChanges } from "./mml.js";
import * as i18n from "./i18n.js";

/** 量化格線 = 60 tick = 1/32 音符 = 鋼琴捲軸的一格。跟 `midi-in.js` 同一個值。 */
const GRID = CELL_TICKS;

/**
 * 沒有力度資訊時每個音的 vel。這條路上**沒有任何力度來源**，所以每個音同值 ——
 * `velPlan()` 因此不會寫任何 `v`。68 換算後落在 **v8**，也就是 velPlan 自己的退路。
 */
const DEFAULT_VEL = 68;

/** `<step>` → 半音數。MIDI 音高 = (octave + 1) * 12 + 這個 + alter。 */
const STEP_SEMITONE = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 };

/** 警告最多列幾條。跟 `midi-in.js` 竹的理由相同：走到這裡還超過表示檔案真的有問題。 */
const MAX_WARNINGS = 6;

/** 小節長度檢查的容差（tick）：480 / divisions 不保證整除。只擋得掉浮點雜訊。 */
const BAR_EPS = 0.5;

/** `<repeat times=>` 最多認到幾遍。上限是為了輸出長度 —— 下游只會默默在 2400 字截斷。 */
const MAX_REPEAT_TIMES = 8;

/** 一份空的統計。反覆的第二遍要往一個丟掉的副本記，所以需要一個工廠而不是字面值。 */
const newStats = () => ({
  graces: 0, tuplets: 0, slurs: 0, ties: 0, straySlurs: 0,
  unclosedSlurs: 0, unclosedTies: 0, repeats: 0, repeatGuessedStart: 0,
  pitchless: 0, measures: 0, badMeasures: 0,
});

/** 這個檔案不是 MusicXML，或壞得無法解析。 */
export class MusicXmlError extends Error {}

// ─── 極小 XML 讀取器 ────────────────────────────────────────────────────────

/**
 * XML 字串 → `{ tag, attrs, kids, text }` 的樹。
 *
 * **刻意只支援 MusicXML 用得到的那個子集**：元素、屬性、文字、自閉合標籤、XML 宣告、
 * 註解、DOCTYPE、五個內建實體與數值參照。不支援 namespace 語意、CDATA、外部實體。
 *
 * @param {string} src
 * @returns {{tag:string, attrs:Record<string,string>, kids:object[], text:string}}
 */
export function parseXml(src) {
  let i = 0;

  const fail = msg => { throw new MusicXmlError(`${msg}（位置 ${i}）`); };
  const ws = () => { while (i < src.length && " \t\r\n".includes(src[i])) i++; };

  /** 跳卜過宣告、註解、DOCTYPE。DOCTYPE 的內部子集（`[...]`）一併吃掉。 */
  const junk = () => {
    for (;;) {
      ws();
      if (src.startsWith("<?", i)) {
        const e = src.indexOf("?>", i); if (e < 0) fail("XML 宣告沒有結束");
        i = e + 2;
      } else if (src.startsWith("<!--", i)) {
        const e = src.indexOf("-->", i); if (e < 0) fail("註解沒有結束");
        i = e + 3;
      } else if (src.startsWith("<!", i)) {
        // DOCTYPE：可能夾一段 [ ... ]，要先跳過它再找 '>'
        const sub = src.indexOf("[", i);
        const end = src.indexOf(">", i);
        if (end < 0) fail("DOCTYPE 沒有結束");
        if (sub >= 0 && sub < end) {
          const close = src.indexOf("]", sub); if (close < 0) fail("DOCTYPE 的內部子集沒有結束");
          const e2 = src.indexOf(">", close); if (e2 < 0) fail("DOCTYPE 沒有結束");
          i = e2 + 1;
        } else i = end + 1;
      } else return;
    }
  };

  /** 五個內建實體 + 數值參照。其他 `&名字;` 原木樣留著（MusicXML 不該有）。 */
  const unescape = s => (s.includes("&") ? s.replace(
    /&(?:#x([0-9a-fA-F]+)|#(\d+)|(lt|gt|amp|quot|apos));/g,
    (m, hex, dec, name) => hex ? String.fromCodePoint(parseInt(hex, 16))
      : dec ? String.fromCodePoint(Number(dec))
        : { lt: "<", gt: ">", amp: "&", quot: '"', apos: "'" }[name]) : s);

  const name = () => {
    const s = i;
    while (i < src.length && !" \t\r\n/>=".includes(src[i])) i++;
    if (i === s) fail("這裡應該是一個名字");
    return src.slice(s, i);
  };

  /** 一個元素。呼叫時 `i` 指在 `<` 上。 */
  const element = () => {
    if (src[i] !== "<") fail("這裡應該是一個標籤");
    i++;
    const tag = name();
    const attrs = {};
    for (;;) {
      ws();
      if (src.startsWith("/>", i)) { i += 2; return { tag, attrs, kids: [], text: "" }; }
      if (src[i] === ">") { i++; break; }
      const k = name();
      ws();
      if (src[i] !== "=") fail(`屬性 ${k} 少了 =`);
      i++; ws();
      const q = src[i];
      if (q !== '"' && q !== "'") fail(`屬性 ${k} 的值沒有引號`);
      i++;
      const e = src.indexOf(q, i); if (e < 0) fail(`屬性 ${k} 的引號沒有結束`);
      attrs[k] = unescape(src.slice(i, e));
      i = e + 1;
    }

    // MusicXML 竹的葉節點只有文字、中間節點只有子元素，所以把文字全部串起來當 text。
    const kids = [];
    let text = "";
    for (;;) {
      const lt = src.indexOf("<", i);
      if (lt < 0) fail(`<${tag}> 沒有結束標籤`);
      text += src.slice(i, lt);
      i = lt;
      if (src.startsWith("</", i)) {
        i += 2;
        const close = name();
        if (close !== tag) fail(`</${close}> 對不上 <${tag}>`);
        ws();
        if (src[i] !== ">") fail(`</${close}> 沒有 >`);
        i++;
        return { tag, attrs, kids, text: unescape(text).trim() };
      }
      if (src.startsWith("<!--", i)) { const e = src.indexOf("-->", i); if (e < 0) fail("註解沒有結束"); i = e + 3; continue; }
      kids.push(element());
    }
  };

  junk();
  if (i >= src.length) throw new MusicXmlError("這個檔案是空的");
  const root = element();
  return root;
}

/** 第一個叫 `tag` 的子元素，水沒有就 undefined。 */
const kid = (node, tag) => node.kids.find(k => k.tag === tag);

/** 所有叫 `tag` 的子元素。 */
const kidsOf = (node, tag) => node.kids.filter(k => k.tag === tag);

/** 子元素的文字內容，沒有那個子元素就 undefined。 */
const textOf = (node, tag) => kid(node, tag)?.text;

/** 子元素的文字內容當整數。不是有效數字就回 `dflt`。 */
const intOf = (node, tag, dflt = 0) => {
  const v = Number(textOf(node, tag));
  return Number.isFinite(v) ? Math.round(v) : dflt;
};

// ─── MusicXML → parseSMF 同形 ───────────────────────────────────────────────

/**
 * `<note>` → MIDI 音高。沒有 `<pitch>`（休止符）回 null。`<alter>` 是絕對的升降半音
 * 數，調號已經算在裡面了 —— 所以這裡看不到、也不需要看到 `<key>`（見檔頭）。
 */
function midiOf(note) {
  const p = kid(note, "pitch");
  if (!p) return null;
  const semi = STEP_SEMITONE[(textOf(p, "step") ?? "").toUpperCase()];
  if (semi === undefined) return null;
  const oct = Number(textOf(p, "octave"));
  if (!Number.isFinite(oct)) return null;
  const alter = Number(textOf(p, "alter") ?? 0);
  return (oct + 1) * 12 + semi + (Number.isFinite(alter) ? Math.round(alter) : 0);
}

/**
 * 一份文件竹的反覆記號 → 小節的**播放順序**。
 *
 * **展開在小節這一層做，不是事後複製音符** —— 照 tick 區間複製會把硬對齊留下的溢出音
 * 切掉。**各聲部取聯集**（OMR 漏比多認常見得多）。
 *
 * 三種情況不展開（計進 `stats.repeats`，由警告說出來）：有一房二房（`<ending>`，展開
 * 會得到 `A B A B C` 而正確答案是 `A B A C`）、起點在別的文件裡、`|:` 沒有等到 `:|`。
 *
 * 只印 `:|` 的照樣展開（那是正常寫法），但 OMR 漏掉 `|:` 的長相跟它一樣 —— 計進
 * `stats.repeatGuessedStart` 讓警告講出來。
 *
 * @param {object} root `<score-partwise>`
 * @param {object} stats 沒展開的反覆記號記進 `stats.repeats`
 * @param {boolean} atPieceStart 這份文件是不是曲子的開頭（多頁時只有第 1 頁是）
 * @returns {{i:number, repeat:boolean}[]|null} 小節序號的播放順序，`repeat` 標記
 *          「這是第二遍以後的副本」。null = 沒有東西要展開，照原順序走。
 */
function repeatPlan(root, stats, atPieceStart) {
  const parts = kidsOf(root, "part");
  if (!parts.length) return null;

  const starts = new Set();   // 小節序號：這裡有 `|:`
  const ends = new Map();     // 小節序號 → 這一段總共播幾遍（`:|` 的 times，預設 2）
  let endings = 0;            // 一房二房的括號數
  let total = 0;              // 最長的那個 part 有幾小節

  for (const part of parts) {
    const ms = kidsOf(part, "measure");
    if (ms.length > total) total = ms.length;
    ms.forEach((m, i) => {
      for (const bl of kidsOf(m, "barline")) {
        if (kid(bl, "ending")) endings++;
        const rep = kid(bl, "repeat");
        if (!rep) continue;
        // `location` 不看：`direction` 已經講完了，而 location 在真實輸山出裡不保證填。
        if (rep.attrs.direction === "forward") starts.add(i);
        else if (rep.attrs.direction === "backward") {
          const t = Math.round(Number(rep.attrs.times));
          ends.set(i, Math.max(ends.get(i) ?? 2,
            Number.isFinite(t) && t >= 2 ? Math.min(t, MAX_REPEAT_TIMES) : 2));
        }
      }
    });
  }
  if (!starts.size && !ends.size) return null;

  const seq = [];
  let from = 0;          // 這一段反覆的起點（小節序號）
  let pending = false;   // 有一個 `|:` 還在等它的 `:|`
  let expanded = 0;

  for (let i = 0; i < total; i++) {
    if (starts.has(i)) { from = i; pending = true; }
    seq.push({ i, repeat: false });

    const times = ends.get(i);
    if (times === undefined) continue;

    // `pending` = 卜譜上真的有 `|:`；`guessed` = 只有 `:|`，起點照慣例補。兩者都展開。
    const guessed = !pending && (from > 0 || atPieceStart);
    if (endings || !(pending || guessed)) stats.repeats++;
    else {
      if (guessed) stats.repeatGuessedStart++;
      for (let r = 1; r < times; r++)
        for (let k = from; k <= i; k++) seq.push({ i: k, repeat: true });
      expanded++;
    }
    from = i + 1;
    pending = false;
  }
  if (pending) stats.repeats++;

  return expanded ? seq : null;
}

/**
 * 一個 `<part>` → 每個 staff 一條音符線。tick 的單位是 **PPQ**（還沒量化到 60 的格線）。
 *
 *  換算在這裡做而不是留給呼叫端，因為 **`<divisions>` 會在一份文件的中途改變**。
 * 拿單一值套用到整個 part 會把 272 小節的譜解析成 1187 小節。
 *
 * @param {{i:number, repeat:boolean}[]|null} plan 小節的播放順序（見 `repeatPlan`）。
 *        null = 照原順序播一遍。**每個 part 吃的必須是同一份 plan**，否則反覆展開之後
 *        各聲部會長短不一。
 * @returns {{lines:Map<string,object[]>, tempos:{tick:number,bpm:number}[],
 *            length:number, quarters:number}}
 */
function readPart(part, outStats, carriedBeats = 0, plan = null) {
  let divisions = 1;
  /** 一人個 `<duration>` → PPQ tick。**用當下生效的 divisions**（見上面）。 */
  const ticks = el => intOf(el, "duration", 0) * PPQ / divisions;
  // 一個小節幾拍。0 = 還不知道。**跨頁要帶過來**：拍號只在開頭寫一次，OMR 對第 2 頁
  // 之後的圖看不到它，不帶的話下面那個小節長度檢查會從第 2 頁開始整個失效。
  let quarters = carriedBeats;
  // 拍號的**原始配對**。`quarters` 把 6/8 與 3/4 都變成 3，分不出來；對齊邏輯只用它。
  let sigNum = 0, sigDen = 0;
  const meters = [];
  const marks = [];
  // 一小節幾個 tick。**跟 divisions 無關**，所以拍號一帶過來就算得出來。
  let barLen = quarters > 0 ? quarters * PPQ : 0;
  let cursor = 0;              // 目前的時間游標（PPQ tick）
  let lastOnset = 0;           // 上一個非 chord 音符的 onset，`<chord>` 要回到它
  let length = 0;              // 這個 part 的總長 = 游標到過的最遠處
  let barStart = 0;            // 這一小節「照節拍格算」應該開始的地方（見下面的硬對齊）
  const lines = new Map();     // staff → notes[]
  const tempos = [];
  const openSlurs = new Map(); // slur number → { note, midi, staff }
  const openTies = new Map();  // `${staff}/${midi}` → note

  const push = (staff, note) => {
    if (!lines.has(staff)) lines.set(staff, []);
    lines.get(staff).push(note);
  };

  // 反覆已經在 `repeatPlan` 展開戈成一串小節序號了，這個迴圈**不需要知道反覆記號存在**。
  const all = kidsOf(part, "measure");
  const seq = plan ?? all.map((_, i) => ({ i, repeat: false }));
  // 第二遍以後的統計往這裡丟：同一個讀錯的小節播兩遍還是同一個錯，報成兩個會讓數字
  // 失去意義。
  const sink = newStats();

  for (const step of seq) {
    const measure = all[step.i];
    const stats = step.repeat ? sink : outStats;

    // 這個聲部的小節數比別的聲部少（OMR 漏掉小節線）。節拍格照樣往前走 —— 直接
    // continue 會讓後面的小節整批往前擠一格，跟別的聲部差一整小節。
    if (!measure) {
      if (barLen > 0) { cursor = barStart; barStart += barLen; }
      continue;
    }

    // ── 硬對齊到節拍格 ──
    //
    // 小節起點用**累積的 bar 起點**，不是上一小節結束的游標：節拍格是已知的（拍號），
    // 音符時值是 OMR 猜的。忠實照走會累積漂移，對齊之後一個讀錯的時值只弄壞它自己
    // 那一小節。
    //
    // 兩個例外都退回忠實模式：`barLen === 0`（不知道一小節多長就不能對齊），以及
    // `implicit="yes"`（弱起小節本來就比一小節短，對齊會把後面整首往後推一小節）。
    const aligned = barLen > 0 && measure.attrs.implicit !== "yes";
    if (aligned) cursor = barStart;

    const measureStart = cursor;
    // 卜這一小節內游標到過的最遠處。不能用 `length`（那是整個 part 的最遠處，而對齊之
    // 後前一小節的溢出音符會讓它超過這一小節的起點）。
    let reach = cursor;
    const mark = () => {
      if (cursor > length) length = cursor;
      if (cursor > reach) reach = cursor;
    };

    for (const el of measure.kids) {
      switch (el.tag) {
        case "attributes": {
          // divisions 中途改是**常態**。換了之後先前的 tick 不必重算，它們早就是 PPQ。
          const d = intOf(el, "divisions", 0);
          if (d > 0) divisions = d;
          const time = kid(el, "time");
          if (time) {
            const beats = intOf(time, "beats", 0), unit = intOf(time, "beat-type", 0);
            if (beats > 0 && unit > 0) {
              quarters = beats * 4 / unit;
              barLen = quarters * PPQ;
              // 只在**真的變了**的時候記一筆。位置用 `measureStart`：`cursor` 這時
              // 可能已經被 backup／forward 移走。
              if (beats !== sigNum || unit !== sigDen) {
                sigNum = beats; sigDen = unit;
                // 反覆展開日時同一個 <measure> 會落在**兩個不同的 tick** 上，那是對的
                // ——所以只去重同一個 tick。
                if (!meters.some(x => x.tick === measureStart))
                  meters.push({ tick: measureStart, num: beats, den: unit });
              }
            }
          }
          break;
        }

        case "backup":
          cursor = Math.max(0, cursor - ticks(el));
          break;

        case "forward":
          cursor += ticks(el);
          mark();
          break;

        case "direction": {
          // `<sound tempo=>` 可以掛在 direction 上，也可以是 measure 的直接子元素。
          const bpm = Number(kid(el, "sound")?.attrs.tempo);
          if (Number.isFinite(bpm) && bpm > 0) tempos.push({ tick: cursor, bpm });

          // 排練記號 → 段落標記。**只讀 `<rehearsal>`，不讀 `<words>`** —— 後者是譜
          // 上任何一段文字，讀進來會把整首譜的註記全變成段落標記。
          //  還沒有真實樣本驗過，是照規格推的。位置月用 `measureStart`。
          const reh = kid(kid(el, "direction-type") ?? { kids: [] }, "rehearsal");
          const text = (reh?.text ?? "").trim();
          if (text && !marks.some(x => x.tick === measureStart))
            marks.push({ tick: measureStart, text });
          break;
        }

        case "sound": {
          const bpm = Number(el.attrs.tempo);
          if (Number.isFinite(bpm) && bpm > 0) tempos.push({ tick: cursor, bpm });
          break;
        }

        case "barline":
          // 反覆記號在進到這裡之前就處理完了。小節線沒有時值，游標一步都不能動。
          break;

        case "note": {
          const isChord = !!kid(el, "chord");
          const dur = ticks(el);
          const staff = textOf(el, "staff") ?? "1";

          // 裝飾音：duration 是 0 或不存在，游標一步都不能動（見檔頭）
          if (kid(el, "grace")) { stats.graces++; break; }

          const onset = isChord ? lastOnset : cursor;
          if (!isChord) lastOnset = cursor;

          if (kid(el, "time-modification")) stats.tuplets++;

          const midi = midiOf(el);
          if (midi === null) {
            // 休止符（或壞掉的 pitch）：不產生卜音符，只前進時間
            if (!kid(el, "rest")) stats.pitchless++;
          } else {
            const note = { ch: 0, tick: onset, endTick: onset + dur, midi, vel: DEFAULT_VEL };
            push(staff, note);

            // `<tie>` / `<tied>`：照標籤合併。homr 不吐這個，但別的引擎會。
            for (const t of [...kidsOf(el, "tie"), ...kidsOf(el, "notations")
              .flatMap(n => kidsOf(n, "tied"))]) {
              const key = `${staff}/${midi}`;
              if (t.attrs.type === "start") openTies.set(key, note);
              else if (t.attrs.type === "stop") {
                const head = openTies.get(key);
                if (head && head !== note) { head.endTick = note.endTick; note.dropped = true; }
                openTies.delete(key);
              }
            }

            // `<slur>`：**兩端音高與 staff 全同才是連結線**（見木檔頭）
            for (const n of kidsOf(el, "notations")) for (const s of kidsOf(n, "slur")) {
              const num = s.attrs.number ?? "1";
              if (s.attrs.type === "start") openSlurs.set(num, { note, midi, staff });
              else if (s.attrs.type === "stop") {
                const open = openSlurs.get(num);
                openSlurs.delete(num);
                if (!open) { stats.straySlurs++; continue; }
                if (open.midi === midi && open.staff === staff) {
                  open.note.endTick = note.endTick;   // 併成一個長音
                  note.dropped = true;
                  stats.ties++;
                } else stats.slurs++;                 // 真的圓滑線：丟掉
              }
            }
          }

          if (!isChord) {
            cursor += dur;
            mark();
          }
          break;
        }

        default:
          break;   // print / harmony / lyric …：跟時間與音高都無關
      }
    }

    // 這個小節的內容加起來是不是剛好一個小節。**在 OMR 上是常態而不是例外。**
    // 硬對齊（見上面）讓超長的小節不再把後面往後推，代價是它尾巴的音符會**溢出去跟
    // 下一小節重疊** —— 而重疊是下游本來就在處理的情況（`sample()` / `onsetGroups`）。
    // 這個計數的意義是讓那件事說得山出來。
    if (barLen > 0 && Math.abs(reach - measureStart - barLen) > BAR_EPS) stats.badMeasures++;
    stats.measures++;

    // 下一小節的起點。**不能用上面那個 `aligned`** —— 它是在小節開頭算的，而拍號往往
    // 就寫在這一小節的 `<attributes>` 裡。
    barStart = barLen > 0 && measure.attrs.implicit !== "yes"
      ? measureStart + barLen
      : reach;
  }

  outStats.unclosedSlurs += openSlurs.size;
  outStats.unclosedTies += openTies.size;

  // 被併掉的音符（tie / slur 的後半段）現在才移除 —— 併的時候還要用它的 endTick
  for (const [staff, notes] of lines) lines.set(staff, notes.filter(n => !n.dropped));

  return { lines, tempos, length, quarters, meters, marks };
}

/**
 * MusicXML（一頁或多頁）→ `parseSMF()` 同形的產出。
 *
 * @param {string|string[]} pages 一份或多份 MusicXML。多份**按樂譜順序**排列
 *        （第 1 頁在前），tick 會依序接起來。
 * @returns {{srcPpq:number, format:number, tracks:object[],
 *            tempos:{tick:number,bpm:number}[], warnings:string[]}}
 * @throws {MusicXmlError} 不是 MusicXML、XML 壞掉、或一個音符都水沒有
 */
export function parseMusicXML(pages) {
  const list = Array.isArray(pages) ? pages : [pages];
  if (!list.length) throw new MusicXmlError(i18n.t("musicxmlIn.err.empty"));

  const stats = newStats();

  // (part, staff) → 累積的音符。key 跨頁穩定，所以左右手不會錯位。
  const lanes = new Map();
  const names = new Map();
  const tempos = [];
  const meters = [];
  const marks = [];
  const carried = new Map();   // partId → 上一頁的拍號（見 readPart 的註解）
  let offset = 0;              // 前面各頁的總長（PPQ tick，已量化）

  for (const [pageIdx, src] of list.entries()) {
    const root = parseXml(String(src));
    if (root.tag !== "score-partwise") {
      // score-timewise 是另一種排法（先小節再聲部）。沒有引擎吐它，支援它等於寫第二
      // 個解析器 —— 講清楚比默默給出空結果好。
      throw new MusicXmlError(i18n.t(root.tag === "score-timewise"
        ? "musicxmlIn.err.timewise" : "musicxmlIn.err.notMusicXml"));
    }

    // 反覆記號 → 小節的播放順序。**一份文件算一次**，每個 part 共用同一份。只有第 1
    // 頁能把「`:|` 沒有 `|:`」解讀成「從頭反覆」。
    const plan = repeatPlan(root, stats, pageIdx === 0);

    // 軌名：`<part-name>`，退回 `<work-title>`。homr 的標題偵測不可靠，只是個木標籤。
    const partNames = new Map();
    for (const sp of kidsOf(kid(root, "part-list") ?? { kids: [] }, "score-part")) {
      partNames.set(sp.attrs.id, textOf(sp, "part-name") || "");
    }
    const title = textOf(kid(root, "work") ?? { kids: [] }, "work-title") || "";

    let pageTicks = 0;
    for (const part of kidsOf(root, "part")) {
      const pid = part.attrs.id ?? "P1";
      const { lines, tempos: pt, length, quarters, meters: pm, marks: pk } =
        readPart(part, stats, carried.get(pid) ?? 0, plan);
      carried.set(pid, quarters);

      // 只剩量化到 60 的格線。**divisions → PPQ 的換算在 readPart 裡面做**（那個值會
      // 在一份文件的中途改變）。
      const q = t => Math.round(t / GRID) * GRID;

      for (const [staff, notes] of lines) {
        const key = `${pid}/${staff}`;
        if (!lanes.has(key)) {
          lanes.set(key, []);
          const base = partNames.get(pid) || title || pid;
          names.set(key, lines.size > 1 ? `${base} (${staff})` : base);
        }
        const out = lanes.get(key);
        for (const n of notes) {
          const tick = offset + q(n.tick);
          let endTick = offset + q(n.endTick);
          // 量化把極短竹的音壓成零長度時給它一格 —— 0 長度的音在捲軸上不存在。
          if (endTick <= tick) endTick = tick + GRID;
          out.push({ ...n, tick, endTick });
        }
      }

      for (const e of pt) tempos.push({ tick: offset + q(e.tick), bpm: clampBpm(e.bpm) });
      // 拍號跟速度一樣是**整首共用的**，所以每個 part 都收；同 tick 的重複由
      // cleanMeters 收斂。
      for (const m of pm) meters.push({ tick: offset + q(m.tick), num: m.num, den: m.den });
      for (const m of pk) marks.push({ tick: offset + q(m.tick), text: m.text });
      pageTicks = Math.max(pageTicks, q(length));
    }
    offset += pageTicks;
  }

  const tracks = [];
  for (const [key, notes] of lanes) {
    notes.sort((a, b) => a.tick - b.tick || a.midi - b.midi);
    tracks.push({ key, name: names.get(key) ?? key, instName: "", notes, programs: new Map(), truncated: false });
  }
  // 軌序：key 是 `partId/staff`，字串排序就日是「part 依序、staff 由上而下」
  tracks.sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));

  // channel 由軌序決定，而且**跳過 9** —— 瑪奇／3MLE／DAW 都把 channel 10 當打擊組。
  tracks.forEach((tr, idx) => { const ch = chanOf(idx); for (const n of tr.notes) n.ch = ch; });

  if (!tracks.some(t => t.notes.length)) throw new MusicXmlError(i18n.t("musicxmlIn.err.noNotes"));

  return {
    srcPpq: PPQ,          // 上面已經換算並量化過了，所以這裡就是 PPQ
    format: 1,            // SMF 才有的概念。填 1（多軌同步）讓形狀對得上
    tracks,
    tempos: tempoChanges(dedupeTempos(tempos)),
    // 排序交給 cleanMeters（它同時處理同 tick 去重與補 tick 0）。
    meters,
    // 同理交給 cleanMarks（排序、同 tick 取後者、夾長度、取前 16）。
    marks,
    warnings: buildWarnings(stats, tempos.length),
  };
}

/** 遊戲的 `t` 只吃 32–255。跟 `parseSMF()` 同一個夾法。 */
const clampBpm = bpm => Math.min(255, Math.max(32, Math.round(bpm)));

/** 同一個 tick 以最後一個為準（跟播放器的行為一致），並依 tick 排序。 */
function dedupeTempos(list) {
  const seen = new Map();
  for (const e of [...list].sort((a, b) => a.tick - b.tick)) seen.set(e.tick, e.bpm);
  return [...seen.entries()].sort((a, b) => a[0] - b[0]).map(([tick, bpm]) => ({ tick, bpm }));
}

/**
 * 統計 → 人使用者看得懂的警告。**丟掉資料一定要說**：OMR 這條路上使用者手上只有一張圖
 * 和一段 MML，中間發生的事全部不可見。
 */
function buildWarnings(s, tempoCount) {
  const w = [];
  if (s.badMeasures) w.push(i18n.t("musicxmlIn.warn.badMeasures", { n: s.badMeasures, of: s.measures }));
  if (!tempoCount) w.push(i18n.t("musicxmlIn.warn.noTempo"));
  if (s.ties) w.push(i18n.t("musicxmlIn.warn.tiesMerged", { n: s.ties }));
  if (s.tuplets) w.push(i18n.t("musicxmlIn.warn.tuplets", { n: s.tuplets }));
  if (s.graces) w.push(i18n.t("musicxmlIn.warn.graces", { n: s.graces }));
  if (s.slurs) w.push(i18n.t("musicxmlIn.warn.slurs", { n: s.slurs }));
  if (s.repeats) w.push(i18n.t("musicxmlIn.warn.repeats", { n: s.repeats }));
  if (s.repeatGuessedStart) {
    w.push(i18n.t("musicxmlIn.warn.repeatGuessedStart", { n: s.repeatGuessedStart }));
  }
  if (s.unclosedSlurs + s.unclosedTies + s.straySlurs) {
    w.push(i18n.t("musicxmlIn.warn.unclosed", { n: s.unclosedSlurs + s.unclosedTies + s.straySlurs }));
  }
  if (s.pitchless) w.push(i18n.t("musicxmlIn.warn.pitchless", { n: s.pitchless }));
  if (w.length <= MAX_WARNINGS) return w;
  return [...w.slice(0, MAX_WARNINGS), i18n.t("musicxmlIn.moreWarnings", { n: w.length })];
}
