// ────────────────────────────────────────────────────────────────────────────
//  MML 工房 — 進入點
//  MML 解析 → 排程 → SpessaSynth (AudioWorklet, 讀 DLS/SF2) → 喇叭
//
//  這裡只做兩件事：把 UI 接起來，然後決定要不要開引擎。
// ────────────────────────────────────────────────────────────────────────────

import { $, say, culturePrefix } from "./util.js";
import * as i18n from "./i18n.js";
import * as engine from "./engine.js";
import * as ui from "./ui.js";

// 語言必須在 ui.init() 之前換好 —— init() 會把分頁、下拉、提示全部畫出來，晚一步就會看到
// 中文閃一下再變成日文。
//
// 權威日是 <html lang>（伺服器按 cookie／Accept-Language 決定）而不是 localStorage：.resx 那
// 一側已經照它渲染完了，前端再自己挑一次只會兩邊不一致。
await i18n.use(document.documentElement.lang);

ui.init();

// ─── 離線時走到 /waterfall/{guid} ───────────────────────────────────────────
//
// 那一頁需要伺服器（要查 DB、要驗所有權），所以離線時 SW 的 navigate() 會退回 shell ——
// 而 shellFor() 對沒有語言前綴的路徑一律送**匿名編輯器**。於是使用者按下「製作影片」
// 看到的是一個空的編輯器，完全不對。
//
// 判斷條件跟 sharebox.js 用的是同一招（見 Pwa/sw.js 的 shellFor 註解）：**「路徑是
// /waterfall/ 但這份 HTML 是編輯器」這個組合在連線時永遠不會出現** —— 連線時伺服器送的
// 是 Waterfall.cshtml，它的 main.js 根本不會被載入。
//
// 前綴要一起比：這一頁的網址現在是 `/ja/waterfall/{guid}`（分享框帶著使用者的語言過去，
// 見 sharebox.videoLink）。而 `culturePrefix()` 讀的是這份 HTML 的 `<html lang>` —— 離線
// 時它就是 SW 挑的那份 shell 的語言，跟網址上的前綴是同一個，所以兩邊一定對得上。
if (location.pathname.startsWith(`${culturePrefix()}/waterfall/`)) {
  say(i18n.t("main.waterfallOffline"));
}

// AudioWorklet 需要真正的 origin。file:// 和 sandboxed iframe（opaque origin）都不行，而且
// 相對路徑的 vendor/ 也吃不到 —— 與其讓它撞出看不懂的 worklet 錯誤，不如講清楚。
if (location.protocol === "file:" || location.origin === "null") {
  $("#engine").textContent = i18n.t("main.needHttp");
  $("#dlsName").textContent = i18n.t("main.unavailable");
  say(i18n.t("main.fileProtocol"));
} else {
  // 內建音色庫的載入過程刻意不寫進側欄那行提示 —— 那一行是「點這裡換一份」的說明，閃一下
  // 「載入中…」再變回去只是雜訊。
  engine.boot().then(ui.loadBuiltins).catch(err => {
    console.error(err);
    $("#engine").textContent = i18n.t("main.engineFailed");
    // 側欄那行不動：引擎起不來時手動載入也沒月用，把「尚未載入」寫上去只是誤導。
    say(ui.describe(err, i18n.t("main.engineDown")));
  });
}
