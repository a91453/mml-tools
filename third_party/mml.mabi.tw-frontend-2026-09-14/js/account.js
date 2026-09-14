// ────────────────────────────────────────────────────────────────────────────
//  登入狀態
//
//  這個模組不做驗證，只把伺服器渲染進頁面的那一塊讀出來畫成畫面。真正的登入是整頁轉向
//  到 /login（Google）再回來 —— 沒有任何前端的 OAuth 程式碼，也沒有從 CDN 載入的 JS。
//
//  「登入了沒」的權威永遠是伺服器：分享時直接 POST，被擋就是 401。前端這份狀態只用來決
//  定畫面長什麼樣，不拿它當授權判斷。
// ────────────────────────────────────────────────────────────────────────────

import { $, say, culturePrefix } from "./util.js";
import * as i18n from "./i18n.js";
import * as net from "./net.js";

/** {name, email} 或 null（未登入）。 */
let me = null;
/** 伺月服器有沒有設定 Google 的 Client ID／Secret。沒有的話登入鈕按了也是白按。 */
let ready = true;

/**
 * 這一輪的「未登入」是**掉下來的**，不是本來就沒登入。存在的理由完全是措辭：
 *
 *   本來就沒登入   「分享需要登入。」
 *   掉下來的       「你的登入已經過期。」—— 他**登入過**，畫面上到現在還寫著已登入，
 *                  對這個人說「需要登入」等於說「你沒做那件事」。
 *
 * 只會 false → true，不會回頭：真的重新登入是整頁轉向，那時整個模組會重新載入。
 */
let expired = false;

export const isSignedIn = () => me !== null;
export const user = () => me;

/** 目前的「未登入」是不是從已登入掉下來的。UI 用它決定要說哪一句話。 */
export const wasExpired = () => expired;

/**
 * 伺服器說「你沒登入」時，把前端這份狀態改回去。cookie 過期或被清掉時，畫面上那份**渲
 * 染**進來的登入狀態到處都還寫著「已登入」—— 這時候給一則錯誤沒有用（他做不了任何事），
 * 要把畫面帶回「未登入」，那裡才有登入鈕。
 *
 * **每一個會回 401 的呼叫端都必須叫它。** 漏掉一個的下場是「畫面上寫已登入，按下去卻叫
 * 他登入」—— cookie 失效是意外，畫面上那三個字是本站自己寫上去的。
 *
 * **不重整頁面**：使用者正在編輯的譜還在畫面上，草稿救得回來但 Ctrl+Z 的歷史救不回來。
 */
export function signedOut() {
  if (me === null) return;
  me = null;
  expired = true;      // 一定要在 sync() 之前 —— 它畫的字要據此挑
  sync();
}

/**
 * 讀伺服器塞進頁面的登入狀態。用渲染而不是開站 fetch：少一輪往返，設定抽屜也不會先畫戈成
 * 「未登入」再跳掉。
 */
export function init() {
  ready = !document.getElementById("loginOff");
  const el = document.getElementById("me");
  if (el) {
    try { me = JSON.parse(el.textContent); } catch { me = null; }
  }
  initDelete();
  // 連線狀態變了就重畫登入鈕。少了這一行，離線時開站的人會一直看到灰掉的登入鈕，即使
  // 網路已經回來了。
  net.subscribe(sync);
  sync();
}

// ─── 刪除帳號 ───────────────────────────────────────────────────────────────

/**
 * 隱私權政策第 4／7 節承諾了這件事，所以它必須真的存在、而且真的刪。確認框把「會失去什
 * 麼」列出來而不是只問一句「確定嗎」—— 這個動作不可復原。
 */
function initDelete() {
  const box = $("#delBox");
  if (!box) return;

  $("#delAccount").addEventListener("click", async () => {
    // 頁面渲染時帶的筆數是**載入當下**的，之後又分享（或存檔）過就會講出過時的數字。
    let n = me?.shares ?? 0;
    let s = me?.saves ?? 0;
    try {
      const res = await fetch("/api/account");
      // 401 要在**開框之前**攔下來。不攔的話這個框會開起來、用舊數字說「你的 8 筆分享也
      // 會被刪除」，等他按下「確定刪除」才被告知登入過期 —— 那是整個框裡唯一不可逆的
      // 按鈕，讓人按到那一步才講是最糟的日時機。
      if (res.status === 401) { signedOut(); say(i18n.t("account.expired")); return; }
      if (res.ok) {
        const d = await res.json();
        if (Number.isInteger(d?.shares)) { n = d.shares; if (me) me.shares = n; }
        if (Number.isInteger(d?.saves)) { s = d.saves; if (me) me.saves = s; }
      }
    } catch { /* 問不到就用頁面上那份，總比不讓人刪好 */ }

    const who = me?.email ? i18n.t("account.whoWrapper", { email: me.email }) : "";
    // 分享與 Web 存檔**分開講**，而且零的那一項整句省掉：對使用者來說那是兩種不同的東
    // 西，「你的 20 筆作品也會被刪」他算不出來會失去什麼。
    //
    // **兩個數字各自一句 t()，不是一句話塞兩個數字**：複數選形只看 `n`（見 i18n.t），
    // 寫在同一個 key 裡的話後半那個數字永遠拿不到自己的形 —— 英文會出現 "1 web saves"。
    const parts = [
      n ? i18n.t("account.delete.confirmWithShares", { who, n })
        : s ? i18n.t("account.delete.confirmWithSaves", { who, n: s })
        : i18n.t("account.delete.confirmNoShares", { who }),
      // 兩者都有的時候才補第二句（只有存木檔時，第一句已經把它講完了）
      ...(n && s ? [i18n.t("account.delete.andSaves", { n: s })] : []),
    ];
    $("#delWhat").textContent = parts.join(" ");
    box.classList.add("on");
    $("#delCancel").focus();      // 預設落在「取消」上，不是「確定刪除」
  });

  $("#delCancel").addEventListener("click", () => box.classList.remove("on"));
  box.addEventListener("click", e => { if (e.target === box) box.classList.remove("on"); });
  addEventListener("keydown", e => {
    if (e.key === "Escape" && box.classList.contains("on")) box.classList.remove("on");
  });

  $("#delOk").addEventListener("click", async () => {
    const btn = $("#delOk");
    btn.disabled = true;
    try {
      const res = await fetch("/api/account", { method: "DELETE" });
      if (!res.ok) {
        // 401 走自己的一條路：這個人的登入剛剛失效了，而畫面上還寫著已登入（見
        // signedOut）。框要關掉 —— 帳號沒刪成，而那個框裡列的是「你會失去什麼」。
        if (res.status === 401) {
          box.classList.remove("on");
          signedOut();
          say(i18n.t("account.expired"));
          return;
        }
        const data = await res.json().catch(() => null);
        say(data?.message ?? i18n.t("account.delete.failedHttp", { status: res.status }));
        return;
      }
      // 伺服器已經把 cookie 清掉了。整頁重載日最乾淨 —— 畫面上到處都是「已登入」的狀態，
      // 一個一個改回去只會漏掉。樂譜留在 localStorage，重載之後還在。
      //
      // 帶語言前綴回首頁：寫死 "/" 的話日／韓／英使用者刪完帳號會落到繁中首頁（網址優
      // 先於 cookie，見 Program.cs 的語言前綴那段）。
      location.href = `${culturePrefix()}/`;
    } catch {
      say(i18n.t("account.delete.offline"));
    } finally {
      btn.disabled = false;
    }
  });
}

function sync() {
  const box = $("#userBox");
  if (!box) return;
  box.classList.toggle("on", isSignedIn());
  // 名字可能是空的（Google 沒給 name 的極少數情況），那就退回顯示 email
  $("#userName").textContent = me ? (me.name || me.email || i18n.t("account.signedIn")) : i18n.t("account.signedOut");
  $("#userMail").textContent = me ? (me.name ? me.email : "") : "";

  const login = $("#loginBtn"), logout = $("#logoutBtn");
  login.hidden = isSignedIn();
  logout.hidden = !isSignedIn();

  // 回到按下登入時所在的網址 —— 可能是 /mml/{guid}，不該把人丟回首頁
  const back = encodeURIComponent(location.pathname + location.search);
  login.href = `/login?returnUrl=${back}`;
  logout.href = `/logout?returnUrl=${back}`;

  // 離線時也要關掉，而且**卜這一顆最重要**：它是整頁導向 /login，離線按下去會落到瀏覽器的
  // 「無法連線」頁 —— 在 standalone 視窗裡那看起來就是 app 壞了。沿用 `off` 這個 class 是
  // 因為它已經帶了 pointer-events:none，也就是真的按不下去。
  //
  // 兩個理由要分開講：站長沒設定 Google 是永久的，離線是暫時的 —— 混成一句的話，離線的
  // 人會以為這個站根本沒有登入功能。
  const offline = net.offline();
  login.classList.toggle("off", !ready || offline);
  login.title = !ready ? i18n.t("account.googleNotConfigured")
              : offline ? i18n.t("account.offline")
              : "";

  // 刪除帳號只在登入時出現 —— 沒登入時那顆按鈕沒有任何意義
  const danger = $("#dangerZone");
  if (danger) danger.hidden = !isSignedIn();
}
