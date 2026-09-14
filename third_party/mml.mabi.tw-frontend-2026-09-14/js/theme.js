// ────────────────────────────────────────────────────────────────────────────
//  主題（深色／淺色）
//
//  真正的色票在 editor.css 的 `:root` 與 `:root[data-theme="light"]`。這個模組只做四件事：
//  記住選擇、把 `data-theme` 掛上去、通知 canvas 重讀、把狀態列的顏色換掉。
//
//  ⚠️ **開機時第一次套用不在這裡**，在 Index.cshtml 的行內腳本裡。理由是這個模組要等
//  **整份模組圖**載完才跑，而 /js/ 是刻意的 network-first（見 Pwa/sw.js）—— 中間那段空窗
//  會閃一整片深色。兩處**刻意各寫一份**，它們壞掉的症狀不同（這裡壞 = 切換沒反應，那裡壞
//  = 開站閃一下），不會互相提醒。
//
//  沒有「跟隨系統」這一檔。不是漏掉：這個站一直是深色的，把 `prefers-color-scheme` 當預設
//  等於讓一群沒有要求過任何事的既有使用者在升級後看到一個白色的編輯器。要加的話，加的是
//  第三個選項，不是換掉預設。
//
//  範圍**只有編輯器**。說明頁與條文頁沒有掛開機腳本，所以永遠是深色的 —— 已知的代價是
//  選了淺色的人從編輯器點說明連結會換一次臉。
// ────────────────────────────────────────────────────────────────────────────

import * as storage from "./storage.js";

export const DARK = "dark";
export const LIGHT = "light";

/** 狀態列／網址列那一條。**深色那個值跟 _PwaHead.cshtml 的 <meta> 寫死的是同一個** ——
 *  那邊是「還沒安裝、還沒跑 JS」時的值，這邊是切換之後的值。改色票要兩邊一起改。 */
const BAR = { [DARK]: "#122325", [LIGHT]: "#f5f7f7" };

const listeners = new Set();

/** 目前是哪一個。**以 DOM 為準而不是以 localStorage 為準** —— 開機腳本已經寫進去了，
 *  再讀一次 localStorage 等於讓兩個來源有機會不一致。 */
export const current = () =>
  document.documentElement.dataset.theme === LIGHT ? LIGHT : DARK;

/**
 * 套用並記住。
 *
 * 深色是**移除屬性**而不是寫 `data-theme="dark"`：CSS 的預設分支就是深色，多一個屬性值
 * 等於讓「沒有屬性」與「屬性是 dark」兩條路要各自維護。
 */
export function apply(name) {
  const t = name === LIGHT ? LIGHT : DARK;
  const root = document.documentElement;
  if (t === LIGHT) root.dataset.theme = LIGHT;
  else delete root.dataset.theme;

  const meta = document.querySelector('meta[name="theme-color"]');
  if (meta) meta.content = BAR[t];

  storage.saveUI({ theme: t });
  for (const fn of listeners) fn(t);
}

/** 換完之後要重畫的人在這裡登記（canvas 讀不到 CSS 變數，見 pianoroll.readTheme）。 */
export const onChange = fn => { listeners.add(fn); return () => listeners.delete(fn); };
