// 這一段是 PwaAssets.Prelude 產生的，本體從下一個分隔線開始。
const VERSION = "ebe2df5d0ce5e0c3";
const ASSETS_FRESH = ["/css/editor.css","/css/legal.css","/css/waterfall.css","/js/account.js","/js/bzip2.js","/js/clipboard.js","/js/config.js","/js/engine.js","/js/envaudio.js","/js/envlive.js","/js/envreverb-worklet.js","/js/envreverb.js","/js/filebox.js","/js/handoff.js","/js/history.js","/js/i18n.js","/js/i18n/en.js","/js/i18n/ja.js","/js/i18n/ko.js","/js/i18n/zh-Hant.js","/js/instruments.js","/js/lang.js","/js/library.js","/js/main.js","/js/marks.js","/js/mediakeys.js","/js/meters.js","/js/midi-in.js","/js/midi-out.js","/js/midi.js","/js/mix-worker.js","/js/mixdown.js","/js/mixmath.js","/js/mixnotes.js","/js/mixstage.js","/js/mml-compress.js","/js/mml-ext.js","/js/mml-highlight.js","/js/mml-in.js","/js/mml-out.js","/js/mml.js","/js/mp3-worker.js","/js/mp4.js","/js/musicxml-in.js","/js/net.js","/js/offline.js","/js/pianoroll.js","/js/player.js","/js/pwa.js","/js/rolledit.js","/js/rolljoy.js","/js/rollmenu.js","/js/savebox.js","/js/select.js","/js/share.js","/js/sharebox.js","/js/storage.js","/js/strings.js","/js/theme.js","/js/tracks.js","/js/ui.js","/js/util.js","/js/video.js","/js/voices.js","/js/waterfall.js","/js/websave.js","/js/wfstyles.js","/js/zip.js","/worklet-boot.js"];
const ASSETS_STATIC = ["/Fury_Sound_Pack_v150.def","/vendor/fontawesome/css/fontawesome.min.css","/vendor/fontawesome/css/regular.min.css","/vendor/fontawesome/css/solid.min.css","/vendor/fontawesome/webfonts/fa-regular-400.woff2","/vendor/fontawesome/webfonts/fa-solid-900.woff2","/vendor/lamejs.js","/vendor/spessasynth_core.js","/vendor/spessasynth_lib.js","/vendor/spessasynth_processor.js"];
const SHELLS = [["en","/en/shell"],["ja","/ja/shell"],["ko","/ko/shell"]];
const SHELL_DEFAULT = "/shell";
const BANK = "/Fury_Sound_Pack_v150.dls";
const FONT_HOSTS = ["fonts.googleapis.com","fonts.gstatic.com"];

// ────────────────────────────────────────────────────────────────────────────
//  Service Worker 本體
//
//  **這個檔案在 content root 的 Pwa\ 底下，不在 wwwroot** —— UseStaticFiles 只送
//  wwwroot，所以它不會被當成靜態檔送出去（放進 wwwroot 反而會無聲地蓋掉對外的動態版
//  本）。對外的 /sw.js 是 PwaController 組出來的：它把資產清單與版本雜湊寫成一段 const
//  宣告，接在這個檔案的內容前面。
//
//  也就是說**這個檔案裡看不到 VERSION／ASSETS 的定義，但它們一定存在**。要改注入的名字
//  就得兩邊一起改 —— 少改一邊的症狀是 SW 直接拋 ReferenceError 然後整個註冊失敗，而失敗
//  是安靜的：頁面照常運作，只是永遠沒有離線能力。
//
//  本體是一個真的 .js 檔而不是 C# 裡的字串，是為了 eslint 掃得到、山出錯有行號。
//
//    VERSION        資產內容雜湊。改一行 js/css/vendor 它就變，於是這份檔案的位元組也
//                   變 —— 而瀏覽器判斷「SW 有沒有更新」靠的正是位元組比對。
//    ASSETS_FRESH   自己的程式碼（/js/、/css/、worklet-boot）。precache，但線上一律以
//                   網路為準 —— 理由見下面 fetch 那段。
//    ASSETS_STATIC  換版就換檔名的東西（/vendor/、.def）。cache-first。
//    SHELLS         [[語言前綴, shell 路徑], …]，只有非預設語言。
//    SHELL_DEFAULT  繁中（無前綴）那一份的路徑。
//    BANK           內建音色庫的路徑。
//    FONT_HOSTS     要 runtime cache 的字型網域。
// ────────────────────────────────────────────────────────────────────────────

// ─── 快取分層 ───
//
// **這個分層是必要的，不是整理癖。** VERSION 由 js/css/vendor 的內容算出來，所以改一行
// CSS 它就變；如果 15 MB 的音色庫跟 shell 放在同一個 versioned cache 裡，activate 清舊快
// 取時會把它一起丟掉 —— 於是**每次發佈，每一個使用者重下 15 MB**。
//
// 音色庫的 cache 名字用**檔名**當 key，剛好對上「換內容就一定要換檔名」那條規則：同一個
// 檔名的內容永遠不變，所以這個 cache 永遠不需要失效；換版時檔名變了，舊的在 activate 被
// 水清掉。
const SHELL_CACHE = "shell-" + VERSION;
const BANK_CACHE  = "bank-" + BANK.split("/").pop();
const FONT_CACHE  = "fonts";

const FRESH_SET  = new Set(ASSETS_FRESH);
const STATIC_SET = new Set(ASSETS_STATIC);

// ────────────────────────────────────────────────────────────────────────────
//  install
// ────────────────────────────────────────────────────────────────────────────

self.addEventListener("install", e => {
  e.waitUntil((async () => {
    const c = await caches.open(SHELL_CACHE);

    // **音色庫絕對不能進這裡。** addAll 是全有全無的：任何一個請求失敗，整個 install 就
    // 失敗並重試 —— 把 15 MB 放進來等於「手機訊號抖一下 → 這個站的 PWA 裝不起來」。
    //
    // cache: "reload" 是必需的：不加的話 addAll 會走瀏覽器自己的 HTTP 快取，於是新版 SW
    // 可能把**舊版的檔案**precache 起來，湊出「一半新一半舊」的組合 —— 而這次連 F5 都救
    // 不了，因為 SW 會固執地餵那份舊的。
    const urls = ASSETS_FRESH
      .concat(ASSETS_STATIC, SHELLS.map(s => s[1]), [SHELL_DEFAULT]);
    await c.addAll(urls.map(u => new Request(u, { cache: "reload" })));
  })());

  // 刻意**不**呼叫 skipWaiting()：這個站的使用者會在編輯器裡坐很久，畫面上有未存檔的心智
  // 投入 —— 自動接手再重載會吃掉他正在打的譜。新版本停在 waiting，由前端在「關於」抽屜裡
  // 長出一顆「更新到新版」（為什麼是抽屜裡的鈕而不是橫幅，見 js/pwa.js 竹的 offer）。
});

// ────────────────────────────────────────────────────────────────────────────
//  activate
// ────────────────────────────────────────────────────────────────────────────

self.addEventListener("activate", e => {
  e.waitUntil((async () => {
    // 用「保留清單」而不是「刪 shell- 開頭的」：前者漏掉的東西會被清掉（成本是流量），
    // 後者漏掉的東西會永遠留著（成本是使用者的磁碟，而且沒有人會發現）。舊版音色庫那
    // 15 MB 正是後者會漏掉的東西。
    const keep = new Set([SHELL_CACHE, BANK_CACHE, FONT_CACHE]);
    const keys = await caches.keys();
    await Promise.all(keys.filter(k => !keep.has(k)).map(k => caches.delete(k)));
    await self.clients.claim();
  })());
});

// ────────────────────────────────────────────────────────────────────────────
//  message —— 使用者按下「重新載入以更新」
// ────────────────────────────────────────────────────────────────────────────

self.addEventListener("message", e => {
  if (e.data && e.data.type === "SKIP_WAITING") self.skipWaiting();
});

// ────────────────────────────────────────────────────────────────────────────
//  fetch
// ────────────────────────────────────────────────────────────────────────────

self.addEventListener("fetch", e => {
  const req = e.request;

  // 不日是 GET 就完全不碰 —— /api/save 的 POST 與 DELETE 走這一條離開。
  if (req.method !== "GET") return;

  const url = new URL(req.url);

  if (url.origin !== self.location.origin) {
    if (FONT_HOSTS.indexOf(url.host) !== -1) e.respondWith(fontFirst(req));
    return;
  }

  // /api/* 一律 network-only：那裡面有登入狀態與雲端樂譜，快取它就是把一個帳號的資料留在
  // 裝置上等著餵給下一個人。離線時它會失敗，而那是**刻意的**。
  if (url.pathname.indexOf("/api/") === 0) return;

  // 自己不要攔自己。
  if (url.pathname === "/sw.js") return;

  // HTML：network-first，而且**成功的回應不寫進快取**。頁面帶著登入者的名字與 email，而
  // **Cache Storage 完全不受 Cache-Control 約束** —— 存下去就是「登出後還看到自己的名
  // 字」，共用電腦上是「A 的名字出現在 B 的畫面」。離線時改送 precache 好的匿名 shell。
  if (req.mode === "navigate") { e.respondWith(navigate(req, url)); return; }

  if (url.pathname === BANK) { e.respondWith(bankFirst(req)); return; }

  // ─── 為什麼自己的程式碼是 network-first 而不是 cache-first ───
  //
  // **這一段是正確性，不是效能取捨。cache-first 會在每一次發佈十都壞一次。**
  //
  // HTML 走 network-first，而 SW 的新版本刻意停在 waiting（見 install）。兩件事放在一起
  // 看：發佈之後，一個把 app 開著的人按下重新載入，他會拿到**網路上的新 HTML**，而餵給
  // 那份 HTML 的 /js/ 是**舊 SW 快取裡的舊模組** —— 新 markup 呼叫舊模組還沒有的函式，
  // 就是 TypeError。而「有新版本」的提示救不了它：錯誤發生在使用者看到提示之前。
  //
  // 所以這裡照抄伺服器自己的政策，不去覆蓋它：線上走網路（伺服器是 no-cache，所以實際
  // 上是一個 304，幾十位元組），離線退回 precache 那份。
  //
  // 代價是「秒開」那個 PWA 賣點在這幾個檔案上拿不到 —— 而 /js/ 與 /css/ 設成 no-cache 就
  // 已經選了正確性，這裡只是不要偷偷改掉它。
  if (FRESH_SET.has(url.pathname)) { e.respondWith(networkFirst(req)); return; }

  // /vendor/ 與 .def：伺服器已經給它們 immutable（換內容就換檔名），所以 cache-first 沒有
  // 版本歪掉的可能。
  if (STATIC_SET.has(url.pathname)) { e.respondWith(cacheFirst(req)); return; }

  // 清單外的同源請求（分享頁的 og 圖、圖示、使用者自己丟進來的檔案…）原樣放行。
});

/**
 * 導覽：先走網路，網路不通才回對應語言的 shell。
 *
 * **只有網路層失敗才 fallback** —— 伺服器回 500 就讓那個 500 出去：拿 shell 蓋掉它會把
 * 「伺服器掛了」偽裝戈成「你離線了」。
 */
async function navigate(req, url) {
  try {
    return await fetch(req);
  } catch (err) {
    const c = await caches.open(SHELL_CACHE);
    const hit = await c.match(shellFor(url.pathname));
    return hit || Response.error();
  }
}

/**
 * 網址 → 該送哪一份 shell。
 *
 * 前綴比對要帶兩邊的斜線（`/ja/`）：只比 `/ja` 的話，將來若有一個叫 `/japan…` 的路徑就會
 * 被誤判成日文。`/mml/{guid}` 沒有語言前綴，所以落到預設那份 —— 而「路徑是 /mml/ 但頁面
 * 上沒有分享資料」這個組合在連線時永遠不會出現，所以 sharebox.js 拿它當離線的判斷依據。
 */
function shellFor(pathname) {
  for (let i = 0; i < SHELLS.length; i++) {
    if (pathname.indexOf("/" + SHELLS[i][0] + "/") === 0) return SHELLS[i][1];
  }
  return SHELL_DEFAULT;
}

/** precache 過的資產：直接給快取那份。沒有的話（理論上不會）退回網路。 */
async function cacheFirst(req) {
  const c = await caches.open(SHELL_CACHE);
  const hit = await c.match(req);
  return hit || fetch(req);
}

/**
 * 自己的程式碼：網路優先，網路不通才用 precache 那份。跟 navigate() 一樣**只在網路層失敗
 * 時退回**。
 *
 * 成功的回應**不寫回快取**：快取那份是由 install 一次性建立的、跟 VERSION 對齊的快照。在
 * 這裡回寫等於讓快取內容脫離 VERSION，於是離線時可能拿到「A 檔新、B 檔舊」。
 */
async function networkFirst(req) {
  try {
    return await fetch(req);
  } catch (err) {
    const c = await caches.open(SHELL_CACHE);
    const hit = await c.match(req);
    return hit || Response.error();
  }
}

/**
 * 卜音色庫：cache-first，抓到就留一份。攔它的附帶好處是**不會佔兩份 15 MB** —— ui.js 那個
 * fetch 從此不再打到網路，瀏覽器 HTTP 快取裡的那一份會自然被驅逐。
 */
async function bankFirst(req) {
  const c = await caches.open(BANK_CACHE);
  const hit = await c.match(req);
  if (hit) return hit;
  const res = await fetch(req);
  if (res.ok) await c.put(req, res.clone());
  return res;
}

/**
 * Google Fonts：cache-first，不 precache —— Noto CJK 是切成幾十片 unicode-range 子集送
 * 的，實際抓哪幾片取決於頁面上出現了哪些字，那份清單列不出來。改成「線上用過的字片留下
 * 來」，沒抓過的片就退回系統字型。
 *
 * **一定要自己發一個 CORS 請求。** `<link rel=stylesheet>` 發出的是 no-cors，回來的是
 * opaque 回應 —— `res.ok` 永遠 false、`status` 永遠 0，照著存就會把一次 404 或 503 當成
 * 字型存起來，而且**存了就一直是那樣**（症狀是「某個語言的字永遠不對」，清快取以外沒有
 * 別的辦法）。這兩個網域都給 CORS 標頭，所以換成 cors 模式就拿得到真的狀態碼。
 */
async function fontFirst(req) {
  const c = await caches.open(FONT_CACHE);
  const hit = await c.match(req.url);
  if (hit) return hit;
  try {
    const res = await fetch(new Request(req.url, { mode: "cors", credentials: "omit" }));
    if (res.ok) await c.put(req.url, res.clone());
    return res;
  } catch (err) {
    // 離線又水沒存過這一片：讓它失敗，瀏覽器會退回系統字型。
    return Response.error();
  }
}
