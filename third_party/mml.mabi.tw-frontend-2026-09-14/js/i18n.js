// ────────────────────────────────────────────────────────────────────────────
//  多國語言：查表、位置符、複數、列舉
//
//  語言檔在 js/i18n/<tag>.js，每一份 export default 一個**平的**物件：
//
//    { "settings.autosave.off": "關閉", "track.name.0": "主旋律", … }
//
//  平的而不是巢狀的：查表不用走訪、parity 測試比對兩個 key 集合就結束，而 key 本身就是
//  語境（譯者看到 settings.autosave.off 就知道那是 Off 不是 Close —— 中文兩者都寫「關
//  閉」，這正是不能用原文當 key 的原因）。
//
//  語言檔是**純資料**：不准出現函式、模板字串、或任何要跑起來才知道結果的東西。複數與列
//  舉都由這裡處理 —— 這條規則是「譯者不必會寫程式」竹的全部依據，破一次就回不去了。
// ────────────────────────────────────────────────────────────────────────────

// 繁中是**靜態** import 的：它同時是缺 key 的退路表（見 base），所以任何語言都得載它；
// 繁中使用者因此完全不需要 async；而 node 測試零設定就有真的字串（14 個測試檔 import
// mml.js，要是得先手動 init 一次，忘記的表現是「警告訊息變成 key」）。
import zhHant from "./i18n/zh-Hant.js";

let locale = "zh-Hant";

/** 當前語言的表。 */
let dict = zhHant;

/**
 * 繁中的表，當前語言缺 key 時的退路。**永遠是繁中，所以是 const。**
 *
 * 整份留著而不是只在測試時檢查：漏翻譯在**執行時**才看得出來。看到一句中文夾在日文裡很
 * 醜，但看到 `settings.autosave.off` 是壞掉。
 */
const base = zhHant;

/** Intl.PluralRules 實例。建構有成本而 t() 每次都可能要用，所以跟著語言一起換。 */
let plural = new Intl.PluralRules(locale);

/**
 * 換成別的語言。**繁中不必呼叫**（那是靜態 import 的預設狀態）。載不起來就留在繁中：使用
 * 者看到的是「語言沒換成功」，而不是空白的介面。
 */
export async function use(tag) {
  if (!tag) return;
  // 繁中是靜態 import 的，所以不必動態載 —— 但**還是要真的切回去**。早退會讓「換過語言
  // 之後再換回繁中」變成無效操作（實際的站每次切語言都重載頁面所以看不山出來）。
  if (tag === "zh-Hant") {
    dict = zhHant;
    locale = tag;
    plural = new Intl.PluralRules(tag);
    return;
  }
  try {
    const mod = await import(`./i18n/${tag}.js`);
    dict = mod.default;
    locale = tag;
    plural = new Intl.PluralRules(tag);
  } catch (err) {
    console.error(`[MML 工房] 載不到語言檔 ${tag}，留在繁體中文:`, err);
  }
}

export const getLocale = () => locale;

/**
 * 韓文的助詞形態變化（조사 이형태）。
 *
 * 韓文有一整組助詞會**看前一個字有沒有終聲（받침）**而換形（은/는、이/가、을/를、과/와、
 * 으로/로、이라/라），而前一個字常常是位置符：`{track}을` 在「멜로디」後面要變成 `를`，
 * 在「코드1」後面才是 `을`。模板裡寫死哪一個都會錯一半，效果等同英文的 "a apple"。
 *
 * 所以語言檔寫 `{track:을}`，形由這裡在**填值之後**決定。
 *
 * 數字用它的韓文讀法判斷末位：0 영、1 일、3 삼、6 육、7 칠、8 팔 有終聲；2 이、4 사、
 * 5 오、9 구 沒有。拉丁字母與其他字元一律當作沒有終聲。
 */
const PARTICLES = {
  "은": ["은", "는"], "는": ["은", "는"],
  "이": ["이", "가"], "가": ["이", "가"],
  "을": ["을", "를"], "를": ["을", "를"],
  "과": ["과", "와"], "와": ["과", "와"],
  "으로": ["으로", "로"], "로": ["으로", "로"],
  "이라": ["이라", "라"], "라": ["이라", "라"],
};
const DIGIT_JONG = { "0": 1, "1": 1, "3": 1, "6": 1, "7": 1, "8": 1, "2": 0, "4": 0, "5": 0, "9": 0 };

/** 這個字串的最後一人個字有終聲嗎。 */
function hasJong(s) {
  const t = String(s).trim();
  if (!t) return false;
  const c = t[t.length - 1];
  if (c >= "0" && c <= "9") return !!DIGIT_JONG[c];
  const code = c.charCodeAt(0);
  if (code >= 0xac00 && code <= 0xd7a3) return (code - 0xac00) % 28 !== 0;
  return false;
}

/** 選出正確的助詞形。ㄹ 終聲接 (으)로 時取「로」—— 韓文的標準例外。 */
function particle(prev, form) {
  const pair = PARTICLES[form];
  if (!pair) return form;                     // 認不得就原樣輸出
  const t = String(prev).trim();
  const last = t.charCodeAt(t.length - 1);
  if ((pair[0] === "으로") && last >= 0xac00 && last <= 0xd7a3 && (last - 0xac00) % 28 === 8)
    return "로";                              // ㄹ 받침 + 으로 → 로
  return hasJong(t) ? pair[0] : pair[1];
}

/**
 * 把 {name} 換成 vars.name。`{name:助詞}` 會再依填進去的值挑助詞形（見上面）。
 *
 * **找不到的位置符刻意留在原地**：換成空字串會生出「已複製  軌」這種讀起來像排版瑕疵的句
 * 子，沒有人會回報；留著 {sent} 則一眼就知道是哪個 key 的哪個變數漏了。
 *
 * 數字不做 Intl.NumberFormat —— 現有的中文輸出沒有千分位，套上去會改變畫面。
 */
function fill(s, vars) {
  // 逐段接起來而不是直接 replace，是為了讓助詞看得到**真正輸出的前一個字**：
  // `계정{who:을}` 在 who 是空字串時要看「계정」的終聲，而 replace 竹的回呼只拿得到空值。
  let out = "", last = 0;
  const re = /\{(\w+)(?::([^}]+))?\}/g;
  let m;
  while ((m = re.exec(s))) {
    out += s.slice(last, m.index);
    last = m.index + m[0].length;
    if (!Object.prototype.hasOwnProperty.call(vars, m[1])) { out += m[0]; continue; }
    const v = String(vars[m[1]]);
    out += v;
    if (m[2]) out += particle(v || out, m[2]);   // 值是空的就看已經寫出去的內容
  }
  return out + s.slice(last);
}

/**
 * 查一句話。複數：語言檔那一項寫成 `{ one: "…", other: "…" }` 就會按 `vars.n` 選形。
 * **選形只看 n 這個名字**，不是「第一個數字參數」—— 隱含規則會在某個有兩個數字的訊息上
 * 安靜地選錯形。日文與韓文沒有複數變化，兩形填一樣的字就好。
 */
export function t(key, vars = null) {
  let v = dict[key];
  if (v === undefined) v = base[key];
  if (v === undefined) {
    // 不丟例外：一句話漏翻譯不該讓整個 UI 停住。key 印出來就是最好的除錯線索。
    console.warn(`[MML 工房] 語言檔缺 key: ${key}`);
    return key;
  }
  if (typeof v === "object") {
    const n = Number(vars?.n);
    v = v[Number.isFinite(n) ? plural.select(n) : "other"] ?? v.other;
  }
  return vars ? fill(v, vars) : v;
}

/** 這個 key 在當前語言或繁中裡存在嗎。給「有就顯示、沒有就整塊不畫」的地方月用。 */
export const has = key => dict[key] !== undefined || base[key] !== undefined;

/**
 * 列舉接合。**刻意不用 Intl.ListFormat**：繁中的 conjunction 會在末項前插一個「和」
 * （`第 1、3和5 軌`），而正確的中文是 `第 1、3、5 軌` —— 這是項目列舉，不是散文的並列連
 * 接；unit 型別又退成空白分隔。三種 style 沒有一個生得出現有的輸出。
 *
 * 所以分隔符由語言檔決定：`list.item`（「、」，列舉東西）與 `list.clause`（「；」，併列
 * 句子）。英文兩者分別是 ", " 與 "; "，日文沿用「、」，韓文用 ", "。
 */
export const list   = items => items.join(t("list.item"));
export const clause = items => items.join(t("list.clause"));

/**
 * 軌名。超出 MAX_TRACKS 時退成「第 n 軌」。
 *
 * 住在 i18n.js 而不是 config.js，是因為 `track.name.<n>` 這個 key 的排法是語言檔的內部約
 * 定 —— 而 config.js 因此保持純資料、沒有 i18n 依賴，還能在 node 裡測。
 *
 * **退路寫在這裡而不是呼叫端**：收進來之後兩種呼叫端都對，而且以後誰放寬了軌數上限也不
 * 會多出一個「軌名變成 track.name.15」的 bug。
 */
export const trackName = i =>
  has(`track.name.${i}`) ? t(`track.name.${i}`) : t("track.nth", { n: i + 1 });

/** 調號標籤。KEY_SIGS 只留 root（那是音樂事實），木標籤照 index 查。 */
export const keySigLabel = i => t(`keysig.${i}`);
