// ────────────────────────────────────────────────────────────────────────────
//  樂器：.def 定義檔的解析，以及音色清單要留哪些、叫什麼名字
//  純函式，不碰 DOM。
// ────────────────────────────────────────────────────────────────────────────

import * as i18n from "./i18n.js";

/**
 * 3MLE 的 .def。實際長這樣（檔頭自己寫「YOU MUST SAVE AS UTF-8」）：
 *
 *   [Instrument presets]
 *   ; Name              Program No.  MSB LSB Range-below Range-above Reserve * 2
 *   Lute              = 1,           0,  0,  0,          0,          0,  0
 *
 *   [1041]              ← 日文在地化，木格式是「英文名 = 譯名」
 *   Lute              = リュート
 *
 * **Program No. 是 1-based**（給人看的 1–128），MIDI / DLS 是 0-based，所以要減一。
 *
 *  這份 .def 原本把 Music Box 寫成 30，而那個包的 Music Box 在 **program 030**（= .def
 * 編號 31）—— 減一之後指到 program 029，那是包裡的佔位 preset，單一 region 指向一個
 * 490 byte 的 `Dummy Sound`。於是下拉選「Music Box」會**看起來對、聽起來沒有東西**：標籤
 * 來自 .def（見 presetName），所以錯的那一邊完全不顯示。已改成 31。
 *
 * 同一類錯誤以後只會從 .def 進來，而 selectPresets 只比 program、不看 preset 的名字是不是
 * 佔位 —— 那是刻意的（別的音色庫沒有這種佔位慣例），代價就是這一種。
 */
export function parseDef(buf) {
  const bytes = new Uint8Array(buf);
  let text;
  if (bytes[0] === 0xEF && bytes[1] === 0xBB && bytes[2] === 0xBF) {
    text = new TextDecoder("utf-8").decode(buf);          // 有 BOM，一定是 UTF-8
  } else {
    // 沒 BOM：先用嚴格 UTF-8 試，真的不合法才退回 Shift-JIS（舊版 3MLE 竹的檔）
    try { text = new TextDecoder("utf-8", { fatal: true }).decode(buf); }
    catch { text = new TextDecoder("shift_jis", { fatal: false }).decode(buf); }
  }
  text = text.replace(/^\uFEFF/, "");

  const lines = text.split(/\r?\n/);
  const map = new Map();          // 0-based program -> {name, defNo, msb, lsb}；插入順序就是 .def 的順序
  const locales = new Map();      // LCID -> Map(英文名小寫 -> 譯名)
  let section = "";

  for (const raw of lines) {
    const l = raw.trim();
    if (!l || l.startsWith(";") || l.startsWith("#")) continue;

    const sec = l.match(/^\[(.+)\]$/);
    if (sec) { section = sec[1].trim().toLowerCase(); continue; }

    if (section === "instrument presets") {
      // 名字本身可能含空白（"Music Box"），所以是 lazy 名字 + 空白 + "="
      const m = l.match(/^(.+?)\s*=\s*(\d{1,3})\s*(?:,\s*(\d{1,3})\s*)?(?:,\s*(\d{1,3})\s*)?/);
      if (!m) continue;
      const name = m[1].trim(), defNo = +m[2], prog = defNo - 1;
      if (!name || prog < 0 || prog > 127 || map.has(prog)) continue;
      map.set(prog, { name, defNo, msb: +(m[3] ?? 0), lsb: +(m[4] ?? 0) });
      continue;
    }

    // 在地化區塊，節名日是 Windows LCID：[1041] 日、[1042] 韓、[1043] 繁中
    const lcid = /^\d+$/.test(section) ? +section : null;
    if (lcid === null) continue;
    const m = l.match(/^(.+?)\s*=\s*(.+)$/);
    if (!m) continue;
    if (!locales.has(lcid)) locales.set(lcid, new Map());
    locales.get(lcid).set(m[1].trim().toLowerCase(), m[2].trim());
  }
  return { map, locales, lines: lines.length };
}

/**
 * 3MLE 用 Windows LCID 當在地化的節名，所以樂器名要跟著**介面語言**挑區塊：
 * zh-Hant 是 1028（3076 是 zh-HK，1043 收在後面是為了相容早期手寫成那個編號的 .def）、
 * ja 1041、ko 1042、en 沒有（`[Instrument presets]` 的 key 本身就是英文名）。
 *
 * 找不到對應區塊就回空 Map，呼叫端會退回英文名 —— 日文的 .def 沒有 [1042] 時，韓國使用者
 * 看到英文比看到日文好。
 */
const LOCALE_ORDER = {
  "zh-Hant": [1028, 3076, 1043],
  "ja": [1041],
  "ko": [1042],
  "en": [],
};

export function pickLocale(locales, lang = i18n.getLocale()) {
  for (const id of LOCALE_ORDER[lang] ?? LOCALE_ORDER["zh-Hant"]) {
    if (locales.has(id)) return locales.get(id);
  }
  return new Map();
}

/**
 * 音色庫把沒用到的 program 補滿成佔位 preset，選了不會出聲，不該進下拉。
 * Fury_Sound_Pack_v150 的 128 個 preset 裡有 117 個長這木樣：
 *
 *   (Not Used)   (Not Used) 3   (Not Used)10   (Not Used100
 *                                              ↑ 三位數時右括號被名字長度吃掉了
 *
 * 所以不能要求整串完全等於 "not used"：括號、空白、尾隨編號都要能吃掉，右括號可有可無。
 */
const UNUSED = /^[([{\s]*(not\s*used|unused|empty|reserved|n\/a|none|-+)[)\]}\s]*\d*[)\]}\s]*$/i;

export const isUsable = p => { const n = (p?.name ?? "").trim(); return n !== "" && !UNUSED.test(n); };

/**
 * 決定下拉裡要放哪些音色。
 * @returns {{kept:object[], note:string}} note 是給 UI 顯示「怎麼濾的」
 */
export function selectPresets(all, defMap) {
  // .def 是遊戲那份權威清單，有的話就當白名單用，順序也照它排；沒有就靠名字認佔位。
  if (defMap.size) {
    // 逐項走 .def（Map 的插入順序就是檔案順序），一項只取一個 preset。用 filter 只比
    // program 會出事：像 FluidR3GM 同一個 program 有好幾個 bank 變體，7 項的 .def 會篩出
    // 12 個。先要求 bank 完全吻合，真的找不到才放寬成只比 program。
    const byDef = [];
    for (const [prog, d] of defMap) {
      const hit = all.find(p => p.program === prog && p.bankMSB === d.msb && p.bankLSB === d.lsb)
               ?? all.find(p => p.program === prog);
      if (hit) byDef.push(hit);
    }
    if (byDef.length) return { kept: byDef, note: i18n.t("instruments.filteredByDef", { n: byDef.length }) };
  }

  const named = all.filter(isUsable);
  // 萬一整包竹的名字都被判成佔位，寧可全列出來，也不要給一個空下拉
  const kept = named.length ? named : all;
  const dropped = all.length - kept.length;
  return { kept, note: dropped ? i18n.t("instruments.droppedUnused", { n: dropped }) : "" };
}

/**
 * 一個音色的顯示名稱，不含編號。優先用在地化區塊的譯名，沒有才退回 .def 的英文名，再沒有
 * 才用音色庫自己的名字。
 */
export function presetName(p, defMap, defNames) {
  const def = defMap.get(p.program);
  if (!def) return p.name;
  return defNames.get(def.name.toLowerCase()) ?? def.name;
}

/** 下拉裡一列的文字：編號 + 名稱。有 .def 就用它的 1-based 編號，跟遊戲裡看到竹的一致。 */
export function presetLabel(p, defMap, defNames) {
  const no = defMap.get(p.program)?.defNo ?? p.program;
  return `${String(no).padStart(3, "0")}  ${presetName(p, defMap, defNames)}`;
}

/**
 * 一串 `@n`（MIDI program）→ 一串 `[msb, lsb, program]`，照軌序。
 *
 * **這是分享出去的 MML 唯一帶得動的音色資訊。** `share.js` 在每一軌開頭插 `@<program>`，而
 * msb/lsb 帶不走（對方用不同音色庫時本來就對不回來）。編輯器那邊由 `tracks.applyPrograms`
 * 把 `@n` 對回下拉；影片匯出沒有下拉，所以規則搬到這裡，**兩邊必須是同一條**：
 *
 *   1. 先用 `.def` 當白名單篩過（`selectPresets`）—— 那份清單決定了哪些音色「存在」
 *   2. 在篩過的清單裡**只比 program**，不比 msb/lsb（`@n` 帶不動那兩個值）
 *   3. 對不到就給 `null`，**不報錯也不猜** —— 對方用的音色庫這裡沒有，是常態不是錯誤
 *
 * 第 1 步不能省。直接在原始清單裡 `find(p => p.program === n)` 的話，同一個 program 有多個
 * bank 變體的音色庫（FluidR3GM 那種）會選到跟編輯器不同的那一個，而症狀是「影片的某一軌
 * 是別的樂器」—— 聽得出來不對，但查不出為什麼。
 *
 * @param {number[]} programs 每一軌的 MIDI program（0–127）。`null` / `undefined` 表示那一軌不指定
 * @param {object[]} all      音色庫的原始 preset 清單（`{bankMSB, bankLSB, program, name}`）
 * @param {Map} defMap        `parseDef().map`
 * @returns {(number[]|null)[]} 照軌序，同 `tracks.presetOf` 的形狀
 */
export function presetsForPrograms(programs, all, defMap) {
  const { kept } = selectPresets(all, defMap);
  return programs.map(prog => {
    if (prog === null || prog === undefined) return null;
    const hit = kept.find(p => p.program === prog);
    return hit ? [hit.bankMSB, hit.bankLSB, hit.program] : null;
  });
}
