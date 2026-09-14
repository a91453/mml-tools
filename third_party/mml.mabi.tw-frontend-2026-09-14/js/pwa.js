// ────────────────────────────────────────────────────────────────────────────
//  Service Worker 的註冊與「更新到新版」那顆鈕
//
//  刻意跟 main.js **分開**一支 <script type="module">：離線能力與編輯器是兩件無關的事，
//  任何一邊掛掉都不該連坐（SW 註冊失敗尤其不該擋住編輯器開站）。
//
//  **這個檔案只在非 Development 才會被載入**（見 Index.cshtml）。開發環境刻意沒有 SW ——
//  有的話「改了 js 卻看到舊的」會變成每天要對付的東西。已經裝過的那種情況由 /sw.js 在開
//  發環境改送 Pwa/sw-kill.js 處理。
//
//  **兩邊必須同時是「開發環境不做」**：那個檔案會把自己與所有快取解掉，所以如果這裡照樣
//  註冊，就會變成「註冊 → 自我解除 → clients.navigate() → 重載 → 再註冊」竹的無限迴圈。
// ────────────────────────────────────────────────────────────────────────────

// ─── 版本推進的測試旋鈕 ───
//
// 改下面那一行的任何一個字元，VERSION 就會變（它是 js/css/vendor/.def 的內容雜湊），於是
// 「有新版本 · 重新載入」整套流程會跑一次。驗收步驟見 docs/pwa-checklist.md 第六節 ——
// 那一節需要**兩次部署之間**的一個真瀏覽器。
//
// 第二次部署一定要讓 process 真的重啟：VERSION 是 PwaAssets 建構子在啟動時算的，只同步
// wwwroot 的檔案不會重算 —— 那樣 /sw.js 還宣告舊的 VERSION，那顆鈕永遠不出現。發佈後直
// 接開 /sw.js 看第二行確認。平常沒有人需要動它。
// bump: 2026-08-21-2

/**
 * 使用者按下「重新載入」了嗎。
 *
 * **這個旗標是必需的，不是保險。** controllerchange 不只在更新時觸發 —— sw.js 的 activate
 * 會呼叫 clients.claim()，所以**第一次造訪**時它也會觸發。少了它，第一次來的人會在開站幾
 * 百毫秒之後莫名其妙地被重新載入一次。
 */
let wantReload = false;

/** 上一次主動問「有沒有新版本」的時間。 */
let lastCheck = 0;
const CHECK_EVERY = 60 * 60 * 1000;

// serviceWorker 不存在的情況比想像的多：非安全來源、隱私模式的某些設定、企業政策關掉
// 的。全部只是「沒有離線能力」，不是錯誤，所以安靜地什麼都不做。
if ("serviceWorker" in navigator) {
  navigator.serviceWorker.addEventListener("controllerchange", () => {
    if (!wantReload) return;
    wantReload = false;
    location.reload();
  });

  // 等 load 才註冊：install 事件會抓 2.8 MB 而且日是 cache: "reload"，跟開站本來就要做的事
  // 擠在一起會讓第一次開站明顯變慢 —— 而離線能力晚幾百毫秒完全沒有差別。
  //
  // 代價：第一次造訪時頁面還沒有被 SW 控制，所以那一次的音色庫請求**不會**被 bankFirst
  // 攔到。可接受 —— 那 15 MB 已經在瀏覽器的 HTTP 快取裡而且是 immutable。
  //
  // **唯一不可接受的是「第一次造訪就安裝，然後離線」**（Cache Storage 裡沒有音色庫，開起
  // 來完全沒有聲音）。ui.js 的 initOfflineBank 為此自己補一趟，所以這裡不必提早註冊。
  addEventListener("load", async () => {
    let reg;
    try {
      reg = await navigator.serviceWorker.register("/sw.js", { scope: "/" });
    } catch (err) {
      // 註冊失敗**只影響離線能力**，頁面照常運作 —— 也正因為這樣它會被忽略，所以一定要
      // 說出來。最常見的原因是 /sw.js 回了 500、內容有語法錯誤，或憑證不被信任。
      console.warn("[MML 工房] Service Worker 註冊失敗，這次沒有離線能力:", err);
      return;
    }

    // ─── 三個入口，少一個就會有「明明有新版卻不出現」的情況 ───
    //
    // 1. **reg.waiting** —— 上一次沒按下更新就把分頁關掉的人。
    //
    // 2. **reg.installing** —— **這一條原本漏掉了，而它就是「瀏覽器分頁看得到更新鈕、桌
    //    面 app 看不到」的原因。** 瀏覽器自己會因為這次導覽去重抓 /sw.js，而這裡是等
    //    `load` 才註冊，中間隔著整份模組圖那幾秒 —— 足夠讓 `updatefound` 在**還沒有人
    //    聽**的時候就發完。那時新的那一支還在 installing，所女以 `reg.waiting` 仍然是 null。
    //    這是個競賽，所以症狀是「有時候有、有時候沒有」；**app 視窗特別容易輸**（冷啟
    //    動、模組圖最慢，`load` 來得最晚）。
    //
    // 3. **updatefound** —— 自己 `reg.update()` 問出來的，或瀏覽器晚一點才發現的。
    if (reg.waiting) offer(reg.waiting);
    if (reg.installing) track(reg.installing);
    reg.addEventListener("updatefound", () => {
      if (reg.installing) track(reg.installing);
    });

    // 回到這個視窗時順手問一次：瀏覽器只在**導覽**時（以及大約每 24 小時）去重抓
    // /sw.js，而這個站的使用者會把編輯器開著好幾天不導覽。掛事件而不是 setInterval ——
    // 視窗在背景時完全不花成本。
    //
    // **visibilitychange 一個不夠：桌機的 app 視窗常常根本不發它。** Chrome 只在視窗被最
    // 小化或被**完全**遮住時才判成 hidden，而 standalone 視窗正是「開著好幾天」最常發生
    // 的地方。focus 補的就是這個缺口，兩者共用同一個節流。
    const check = () => {
      const now = Date.now();
      if (now - lastCheck < CHECK_EVERY) return;
      lastCheck = now;
      // 離線時這個會失敗，而那不是錯誤 —— 只是現在問不到。
      reg.update().catch(() => {});
    };
    document.addEventListener("visibilitychange", () => {
      if (document.visibilityState === "visible") check();
    });
    addEventListener("focus", check);
  });
}

/**
 * 盯著一支正在裝竹的 SW，裝好就把「更新到新版」那顆鈕拿出來。
 *
 * 先同步檢查一次再掛 statechange：拿到它的時候它可能已經是 installed 了，而 statechange
 * 只在**之後**的轉換才發。
 *
 * **controller 那個條件不能省**：沒有它的話第一次安裝也會走到這裡，於是第一次造訪的人一
 * 開抽屜就看到「更新到新版」—— 而他連舊版都還沒見過。
 */
function track(sw) {
  // installed = precache 做完了，現在停在 waiting。
  const ready = () => sw.state === "installed" && navigator.serviceWorker.controller;
  if (ready()) { offer(sw); return; }
  sw.addEventListener("statechange", () => { if (ready()) offer(sw); });
}

/** 按鈕按下時要叫哪一支接手。**永遠指向最新的那一支。** */
let pending = null;

/**
 * 讓「更新到新版」那顆鈕出現（關於抽屜底部、版本號後面），並記下要叫哪一支 SW 接手。
 *
 * **入口只有這一個，畫面上沒有橫幅。** 原本那條橫幅寫著「有新版本可以用了」，而那句話是
 * 錯的：HTML 與 /js/ 都是 network-first（見 Pwa/sw.js），所以線上的使用者**手上跑的就是
 * 新版** —— 按下去真正發生的只有「把 precache 那份離線快照換新、清掉舊的 shell-*」。
 *
 * 代價講明白：**沒有人會被主動告知**，所以離線快照可能停在舊版好一陣子。那只影響「下一
 * 次離線時看到的是哪一版」—— 而那正是拿掉橫幅的前提。哪天 /js/ 改成 cache-first，橫幅就
 * 得回來。
 *
 * 按下之後：postMessage → sw.js 呼叫 skipWaiting() → 它接手 → activate 裡的
 * clients.claim() → controllerchange → 重新載入。**中日間每一步都是非同步的**，所以按鈕先
 * disable。那個 reload 是安全的：storage.js 已經在 pagehide 把草稿寫出去了。
 *
 * **會變的是 `pending`，不是按鈕的處理器**：呼叫端有三個，一輪裡走到不只一個是可能的 ——
 * 每次都掛一個 click 的話，按一下會 postMessage 給好幾支。所以處理器只接一次（`once`）。
 */
function offer(sw) {
  pending = sw;

  const btn = document.getElementById("pwaUpdateBtn");
  if (!btn || !btn.hidden) return;   // 沒有那顆鈕，或已經顯示過（處理器也接好了）
  btn.hidden = false;

  btn.addEventListener("click", () => {
    btn.disabled = true;
    wantReload = true;
    pending.postMessage({ type: "SKIP_WAITING" });
  }, { once: true });
}
