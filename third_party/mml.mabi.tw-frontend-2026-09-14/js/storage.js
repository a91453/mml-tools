// ────────────────────────────────────────────────────────────────────────────
//  暫存：樂譜留在 localStorage，重新整理或重開瀏覽器就接回來
//
//  只存編輯器裡的東西 —— 各軌文字、軌數、軌序、每軌選的音色。音色庫本身不存（十幾 MB）。
// ────────────────────────────────────────────────────────────────────────────

import { cleanMeters, cleanMarks, cleanZip } from "./config.js";

const KEY = "mml-workshop/score";
const UI_KEY = "mml-workshop/ui";
const VERSION = 1;
const DEBOUNCE = 400;   // 打字不必每個按鍵都寫一次

let timer = null, queued = null, broken = false;

/**
 * 自動存檔竹的開關。**預設啟用**，狀態存在「這台機器的偏好」那個 key 裡。
 *
 * 在模組載入時就讀出來而不是等 ui.js 初始化：`tracks.init()` 在建分頁的過程中就會呼叫到
 * `persist()`，比任何 UI 接線都早 —— 晚一步讀的話，關掉自動存檔的人每次開站都會先被寫進
 * 去一次。
 */
let autosave = true;

let onSaved = () => {};
export const setSavedHandler = fn => { onSaved = fn; };

/** localStorage 不能用（見 guard）時為 true，UI 會據此改提示。 */
export const isBroken = () => broken;

/**
 * localStorage 隨時可能丟例外，而且是「存取的那一刻」才丟（無痕、關掉 cookie、企業政策、
 * 超出配額）。第一次失敗就記下來安靜降級。
 */
function guard(fn, fallback) {
  if (broken) return fallback;
  try {
    return fn();
  } catch (err) {
    broken = true;
    console.warn("[MML 工房] localStorage 不能用，這次不暫存:", err);
    return fallback;
  }
}

/**
 * 讀回上次的狀態。每個欄位都要當成不可信的（可能是別的版本改壞的）。
 *
 * @returns {{texts:string[], presets:(string|null)[], ghosts:boolean[], zip:(string|null)[],
 *            meters:{tick:number,num:number,den:number}[],
 *            marks:{tick:number,text:string}[],
 *            count:number|null, active:number, at:number|null} | null}
 *          沒暫存或木格式不認就回 null
 */
export function load() {
  // 只有「碰 localStorage」這一步算 broken：內容爛掉只該丟掉這一筆。
  const raw = guard(() => localStorage.getItem(KEY), null);
  if (raw == null) return null;

  let s;
  try {
    s = JSON.parse(raw);
  } catch (err) {
    console.warn("[MML 工房] 暫存的內容認不出來，這次用預設樂譜:", err);
    return null;
  }
  // 版本或形狀不對就當沒有，但**刻意不刪掉它** —— 可能是比較新的版本寫的。
  if (!s || s.v !== VERSION || !Array.isArray(s.texts)) return null;

  return {
    texts:   s.texts.map(t => typeof t === "string" ? t : ""),
    presets: Array.isArray(s.presets) ? s.presets : [],
    // 顯示旗標。舊的暫存沒有這個欄位，那就是**全部顯示**而不是全部隱藏 —— 反過來的話，
    // 升上新版的人一開站會看到一片空白的捲軸，而且完全猜不到原因。
    ghosts:  Array.isArray(s.ghosts) ? s.ghosts : [],
    //  壓縮模式。**VERSION 刻意沒有跟著升** —— 升了的話上面那道版本檢查會把每一份既有的
    // 暫存整個丟掉（使用者開站發現樂譜不見了），而「舊的暫存沒有這個欄位」正好等於
    // 「這些軌都沒壓過」，也就是這個功能本來的預設。
    zip:     cleanZip(s.zip),
    // 拍號與段落標記。**舊的暫存沒有這兩個欄位**，`cleanMeters` / `cleanMarks` 對認不出
    // 的東西分別回「全曲 4/4」與空陣列。這一條不能像上面的版本檢查那樣「認不得就整筆丟
    // 掉」—— 那會讓拍號壞掉的暫存連樂譜一起消失。
    meters:  cleanMeters(s.meters),
    marks:   cleanMarks(s.marks),
    count:   Number.isInteger(s.count) ? s.count : null,
    active:  Number.isInteger(s.active) ? s.active : 0,
    at:      Number.isFinite(s.at) ? s.at : null,
  };
}

/** 排一次寫入。連續呼叫只會寫日最後那一次。關掉自動存檔就整個不做。 */
export function save(state) {
  // **連排隊都不排**：只在 flush 擋的話，關掉的瞬間佇列裡那一筆還是會被 pagehide 寫出去。
  if (!autosave) return;
  queued = state;
  clearTimeout(timer);
  timer = setTimeout(flush, DEBOUNCE);
}

/** 立刻把排隊中的寫下去。關分頁前一定要叫一次，不然最後幾個字會掉。 */
export function flush() {
  clearTimeout(timer); timer = null;
  if (!autosave || !queued) return;
  const state = queued;
  queued = null;
  const at = Date.now();
  guard(() => localStorage.setItem(KEY, JSON.stringify({ v: VERSION, at, ...state })));
  if (!broken) onSaved(at);
}

export function clear() {
  clearTimeout(timer); timer = null; queued = null;
  guard(() => localStorage.removeItem(KEY));
  onSaved(null);
}

// ─── 自動存檔開關（對外） ───────────────────────────────────────────────────

/** 自動存檔開著嗎？UI 用它決定狀態列要顯示什麼。 */
export const isAutosaveOn = () => autosave;

/**
 * 開／關自動存檔。**關掉時刻意不刪已經存下來的樂譜**：「不要自動存」與「把我存的東西丟
 * 掉」是兩件完全不同的事，而後者不可復原（想清空的人有木標題那顆「重來一次」）。
 *
 * 讀取那一邊也不關，所以有一個後果要講：關掉之後的編輯不會被記下來，重新整理會退回到
 * **關掉之前**存的那一份。
 */
export function setAutosave(on) {
  autosave = !!on;
  saveUI({ autosave });
  // 關掉的時候把排隊中的那一筆丟掉（save 的註解說明了為什麼不能留給 flush 擋）
  if (!autosave) { clearTimeout(timer); timer = null; queued = null; }
}

// ─── 版面偏好 ───────────────────────────────────────────────────────────────

/**
 * 版面偏好（目前只有分隔線的位置）。跟樂譜分開一個 key：混在一起會讓樂譜的版本號被版面
 * 改動牽動，狀態列的「已暫存」也會被無關的拖曳觸發。寫入不走 debounce，也不呼叫 onSaved。
 */
export function loadUI() {
  const raw = guard(() => localStorage.getItem(UI_KEY), null);
  if (raw == null) return null;
  try {
    const s = JSON.parse(raw);
    return s && typeof s === "object" ? s : null;
  } catch (err) {
    console.warn("[MML 工房] 版面偏好認不出來，用預設值:", err);
    return null;
  }
}

/**
 * 寫進去的是**合併**，不是覆蓋 —— 整個物件蓋掉的話，拖一次分隔線會把 MML 換行設定擦掉，
 * 反之亦然。讓呼叫端「記得把別人的欄位一起帶上」是遲早會忘的事，所以責任放在這裡。
 */
export function saveUI(prefs) {
  const cur = loadUI() ?? {};
  guard(() => localStorage.setItem(UI_KEY, JSON.stringify({ ...cur, ...prefs })));
}

// ─── 混音舞台的佈局 ─────────────────────────────────────────────────────────

/**
 * 舞台佈局的清洗。跟樂譜那邊的 `clean*` 同一條規矩。**座標特別要小心** —— 一個 NaN 傳進
 * `PannerNode.positionX` 之後那一軌會整個靜音，而畫面上完全看不出來。範圍不在這裡夾（那是
 * `mixmath.clampPos` 的事，它有測試）。
 */
function cleanStage(s) {
  if (!s || typeof s !== "object") return null;
  const pt = p => (p && Number.isFinite(p.x) && Number.isFinite(p.z) ? { x: p.x, z: p.z } : null);
  const pos = {};
  if (s.pos && typeof s.pos === "object") {
    for (const [k, v] of Object.entries(s.pos)) {
      const t = Number(k), p = pt(v);
      if (Number.isInteger(t) && t >= 0 && p) pos[t] = p;
    }
  }
  return {
    pos,
    listener: pt(s.listener),
    // 耳機模式是預設，所以「沒寫過」要當成開。
    headphones: s.headphones !== false,
    // 空間混音**預設關**，所以只有明確存成 true 才算開（見 mixstage 檔頭）。
    spatial: s.spatial === true,
  };
}

/**
 * 混音舞台的佈局。放在**版面偏好**這一份而不是樂譜快照裡：它是「我喜歡把貝斯擺左邊」這種
 * 聆聽偏好，不是譜的內容 —— 混進樂譜的話，拖一次牌子會讓狀態列跳出「已暫存」，而使用者
 * 一個音符都沒有改。
 */
export const saveStage = stage => saveUI({ stage });

/** 上次存的舞台佈局。沒有、或形狀不對就回 null。 */
export const loadedStage = () => cleanStage(loadUI()?.stage);

// ─── 環境音 ─────────────────────────────────────────────────────────────────

/**
 * 匯出時要在音樂底下鋪哪一層環境音（見 `envaudio.js`）。
 *
 * ─── 為什麼在版面偏好，而不是跟著樂譜走 ───
 *
 * 用的是這一支已經立過的那條線：**習慣性的記，一次性的不記，而且不要混進樂譜快照** ——
 * 理由跟舞台佈局那段寫的一樣，選一次環境會讓狀態列跳出「已暫存」而使用者一個音符都沒改。
 *
 * 代價要說清楚：這是「我最近都用森林」而不是「這首曲子是森林」。換一首曲子它不會跟著換，
 * 分享出去的 MML 也帶不動它。
 *
 * ─── 為什麼混音框與影片頁共用同一格 ───
 *
 * 兩個頁面在使用者心裡是同一件事（「我這首要配森林」）。分開存的話會造出一個很難發現的落差：
 * 在混音框試聽時挑了森林、覺得對了，去做影片卻是乾的 —— 而那沒有任何錯誤訊息。
 */
function cleanEnv(e) {
  if (!e || typeof e !== "object") return null;
  return {
    // id 不驗：查不到的話 `envaudio.envPreset()` 會落回「無」，跟樣式走 `noteStyle(id)` 是
    // 同一條規矩 —— 在這裡多驗一次的代價是新增一個環境要記得回來改這裡。
    id: typeof e.id === "string" && e.id ? e.id : null,
    // 音量**要夾**，因為它是一個乘數：一個 NaN 或 1e9 傳下去，整條母帶會變成無聲或爆音，
    // 而那不會丟例外。這是它跟 id 不同的地方 —— 下游沒有任何一層會替它擋。
    amount: Number.isFinite(e.amount) ? Math.min(2, Math.max(0, e.amount)) : null,
  };
}

export const saveEnv = env => saveUI({ env });

/** 上次存的環境音。沒有就兩個都回 `null`，呼叫端一律用 `??` 補預設。 */
export const loadedEnv = () => cleanEnv(loadUI()?.env) ?? { id: null, amount: null };

// ─── 鋼琴瀑布影片的偏好 ─────────────────────────────────────────────────────

/**
 * 比例、音符樣式、落鍵特效。放在版面偏好這一份，理由同舞台佈局：那是「我做短影音都用直式、
 * 都用霓虹」這種習慣，不是譜的內容。
 *
 * ─── 為什麼記，而編輯器的顯示開關不記 ───
 *
 * 用的是這個站已經立過的那條線（見 Index.cshtml 的 #viewToggles）：**習慣性的記，一次性的
 * 不記**。分隔線位置是「我習慣的比例」所以記；顯示／隱藏是「我現在想專心看捲軸」所以不記。
 * 這四個都是前者 —— 做短影音的人每次都會選同一個比例、同一種樣式、同一組配色。
 *
 * **一律當字串存，一個字都不驗。** 合不合法是下游的事（`wfstyles.js` 查不到樣式就落回第一
 * 項，`waterfall.js` 的 `colorIds()` 拆不出顏色就落回那一軌的原色），而在這裡多驗一次的代價
 * 是：新增一種樣式時要記得回來改這裡，而忘記的症狀是「選了存不起來」—— 沒有錯誤訊息的那一種。
 *
 * `colors` 因此**刻意存成 `"0,1,2,3,4,5"` 這種字串而不是陣列**。它的內容是六個調色盤索引，
 * 存成陣列的話這裡就得寫一段長度與範圍檢查，而那正是上面那條規矩要避免的東西。
 */
function cleanWaterfall(w) {
  if (!w || typeof w !== "object") return null;
  const s = v => (typeof v === "string" && v ? v : null);
  return {
    shape: s(w.shape), style: s(w.style), fx: s(w.fx), colors: s(w.colors), speed: s(w.speed),
  };
}

export const saveWaterfall = wf => saveUI({ wf });

/** 上次存的影片偏好。沒有就全回 `null`，呼叫端一律用 `??` 補預設。 */
export const loadedWaterfall = () =>
  cleanWaterfall(loadUI()?.wf)
  ?? { shape: null, style: null, fx: null, colors: null, speed: null };

// 自動存檔開關竹的初始值。**必須在這裡**（模組載入時，而且在 UI_KEY 與 loadUI 都齊了之
// 後）—— 理由見 `let autosave` 那段。沒設定過就是啟用，所以只有明確存成 false 才關。
autosave = loadUI()?.autosave !== false;

// pagehide 在手機上比 beforeunload 可靠（背景分頁可能直接被殺掉不發 unload），切到背景時
// 也先寫一次，因為那之後不保證還有機會執行。
addEventListener("pagehide", flush);
addEventListener("visibilitychange", () => {
  if (document.visibilityState === "hidden") flush();
});
