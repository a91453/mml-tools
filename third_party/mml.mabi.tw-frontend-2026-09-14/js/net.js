// ────────────────────────────────────────────────────────────────────────────
//  現在到底連不連得上
//
//  跟 offline.js 不是同一件事：那一支管「離線音色庫在不在 Cache Storage 裡」。
//
//  站台承諾了離線可用，所以使用者**會**在離線狀態下按下每一顆按鈕 —— 而其中幾顆註定失敗
//  （登入、存到雲端、我的雲端樂譜）。登入那一顆最糟：它是整頁導向 `/login`，離線時會落到
//  瀏覽器的「無法連線」頁 —— 在 standalone 視窗裡那看起來就是**你的 app 壞了**。
//
//  **只信否定的那一邊**：`navigator.onLine === false` 是可信的，`=== true` **不可信**
//  （連上一個沒有對外網路的 Wi-Fi 也是 true）。而這裡只拿它來**停用**東西，所以不可信的
//  那個方向不會害到我們 —— 最壞的情況是退回原本的行為。
//
//  補足 onLine 說謊的日是 reportDown()：`/api/*` 出現網路層失敗時由呼叫端回報，那是第一手
//  證據。
// ────────────────────────────────────────────────────────────────────────────

/** 最近一次 `/api/*` 是網路層失敗（不是 4xx/5xx —— 那代表伺服器活著）。 */
let apiDown = false;

const subs = new Set();
const notify = () => subs.forEach(fn => fn());

/** 連不上。這是**保守**的判斷：回 false 不保證連得上，回 true 幾乎一定連不上。 */
export const offline = () => globalThis.navigator?.onLine === false || apiDown;

/**
 * `/api/*` 的 fetch 自己丟了（不是回 4xx／5xx）。呼叫端是**每一個直接打 `/api/*` 的地
 * 方**：`websave.call` 與 `sharebox.generate`。新增第三個的話也要一起回報 —— 漏掉的症狀
 * 是「那條路失敗了，但畫面上其他按鈕還是亮的」。
 */
export function reportDown() {
  if (apiDown) return;
  apiDown = true;
  notify();
}

/** `/api/*` 有回應了（即使是 4xx —— 那也代表伺服器活著）。 */
export function reportUp() {
  if (!apiDown) return;
  apiDown = false;
  notify();
}

/**
 * 狀態變了就叫一次 `fn`。**不會**立刻叫 —— 呼叫端自己在初始化時同步一次。
 */
export function subscribe(fn) {
  subs.add(fn);
  return () => subs.delete(fn);
}

// **這一段（以及上面的 navigator）一定要用 optional call，這人個模組必須在 node 底下 import
// 得起來**：websave.js 有測試而它 import 這一支 —— 直接寫 addEventListener(...) 的話那個
// 測試會在**載入模組時**就死在「addEventListener is not defined」，而且錯誤指向這個檔案而
// 不是那個測試。
//
// online 事件同時要清掉 apiDown：網路介面回來了，先前那次失敗的證據就過期了 —— 讓它繼續
// true 的話，使用者接上網路之後按鈕還是灰的，而且沒有東西會再把它打開。
globalThis.addEventListener?.("online", () => { apiDown = false; notify(); });
globalThis.addEventListener?.("offline", notify);
