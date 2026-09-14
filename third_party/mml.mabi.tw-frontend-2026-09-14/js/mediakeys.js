// ────────────────────────────────────────────────────────────────────────────
//  鍵盤上的媒體鍵（⏯ ⏮ ⏭ ⏹）與系統的媒體控制
//
//  這個檔案**完全不懂音樂** —— 它只讓瀏覽器相信這個分頁正在播媒體，然後把系統送來的指
//  令原樣轉給 ui。分成獨立檔案是因為整段都在對付一個**瀏覽器的實作細節**，它應該可以整
//  個刪掉而不影響其他功能。
//
//  ─── 為什麼需要一個無聲的 <audio> ──────────────────────────────────────────
//
//  媒體鍵**不是 keydown**：作業系統攔截之後透過 Media Session 送給瀏覽器認定「正在播媒
//  體」的那個分頁，而那個認定幾乎都綁在**媒體元素**上 —— 純 Web Audio（這個站的音訊全走
//  AudioContext + AudioWorklet）不算數，於是 action handler 註冊得再漂亮也不會被呼叫。
//
//  所以卜這裡播一段無聲的 <audio loop>。**這是對瀏覽器啟發式行為的利用，而那種東西會變** ——
//  哪天媒體鍵整組沒反應先來這裡看。三個最可能的斷點：元素的長度（見 SECONDS）、
//  `muted`／`volume`（見 startSilence）、自動播放政策。
//
//  ─── 已知的代價（都是刻意接受的） ─────────────────────────────────────────
//
//  按下演奏就會**搶走系統的媒體鍵**、跳出「正在播放」的系統通知、手機上可能中斷背景音
//  訊。這是這個功能的本質 —— 但它是這個站唯一一個**影響到站外體驗**的東西，所以「一進站
//  就播」那條路刻意沒有採用。
// ────────────────────────────────────────────────────────────────────────────

/**
 * 無聲音訊的長度（秒）。**不能太短**：Chrome 對「要不要給這個分頁媒體控制」有一條時長啟
 * 發式（大約 5 秒），太短的音訊會被當成音效而不是媒體 —— 那時 `loop` 也救不了，它看的是
 * 單次長度。成本只是 80KB 的記憶體。
 */
const SECONDS = 10;
const RATE = 8000;

let el = null;              // 那個隱藏的 <audio>，null = 還沒建
let hooks = {};

/**
 * 產生一段無聲 WAV 的 Blob URL。執行時生而不是放一個檔案進 `wwwroot`：那會是一個二進位
 * 資產，而它的內容從檔名完全看不出來。
 *
 * **8 位元 PCM 的靜音是 128，不是 0**：那個格式是**無號**的，0 代表滿幅負值 —— 填 0 會得
 * 到一段直流偏移，接上喇叭是「噗」竹的一聲，而且它會 loop 一輩子。
 */
function silentWavUrl() {
  const bytes = SECONDS * RATE;                  // 8 位元單聲道 → 一個取樣一個位元組
  const buf = new ArrayBuffer(44 + bytes);
  const v = new DataView(buf);
  const tag = (off, s) => {
    for (let i = 0; i < s.length; i++) v.setUint8(off + i, s.charCodeAt(i));
  };
  tag(0, "RIFF");   v.setUint32(4, 36 + bytes, true);
  tag(8, "WAVE");
  tag(12, "fmt ");  v.setUint32(16, 16, true);   // fmt 區塊長度
  v.setUint16(20, 1, true);                      // 1 = PCM
  v.setUint16(22, 1, true);                      // 單聲道
  v.setUint32(24, RATE, true);
  v.setUint32(28, RATE, true);                   // byteRate = 取樣率 × 聲道 × 位元組
  v.setUint16(32, 1, true);                      // blockAlign
  v.setUint16(34, 8, true);                      // 位元深度
  tag(36, "data");  v.setUint32(40, bytes, true);
  new Uint8Array(buf, 44).fill(128);             // 見上面那條 
  return URL.createObjectURL(new Blob([buf], { type: "audio/wav" }));
}

function startSilence() {
  if (!el) {
    el = document.createElement("audio");
    el.loop = true;
    el.src = silentWavUrl();
    // **`muted` 與 `volume` 兩個都不准動**：靜音的媒體不算「正在播音訊」，媒體 session
    // 不會啟動 —— 而卜這個元素存在的唯一理由就是被認定為在播。
    el.volume = 1;
    el.muted = false;
    el.setAttribute("aria-hidden", "true");
    document.body.appendChild(el);
  }
  // 自動播放政策擋下來就算了 —— 媒體鍵是加分項，不該讓它的失敗影響到真正的播放。
  el.play().catch(() => {});
}

const stopSilence = () => el?.pause();

/**
 * 播放狀態變了。**ui 的 `syncTransport` 是唯一的呼叫端。**
 *
 * 暫停中**不停掉**無聲音訊，只把 `playbackState` 改成 `paused`：媒體 session 綁在「元素正
 * 在播」上，暫停時停掉的話瀏覽器過一會兒就會撤掉媒體控制 —— 於是**按 ⏯ 想繼續播的時候，
 * 那顆鍵已經不歸我們管了**，而那正是媒體鍵最主要的用途。
 *
 * @param {"playing"|"paused"|"stopped"} state
 */
export function setState(state) {
  const ms = navigator.mediaSession;
  // "none" 是規格裡「沒有東西在播」的值，不是 "stopped"
  if (ms) ms.playbackState = state === "stopped" ? "none" : state;
  if (state === "stopped") stopSilence();
  else startSilence();
}

/**
 * 註冊 action handler。**一次就好**，之後靠 `setState` 開關。
 *
 * ⏮／⏭ 接成「前後一小節」而不是「上一首／下一首」：這個站沒有「下一首」，照語意接的話
 * ⏭ 會變成一顆出現在系統通知上、看得到、按得到、**沒反應**的鍵。而絕大多數鍵盤與耳機線
 * 控只有 ⏮ ⏯ ⏭。⏪／⏩ 接成同一件事。
 *
 * 逐個 try —— `setActionHandler` 碰到不認得竹的 action 會丟 TypeError，而各家支援的集合不
 * 一樣。
 *
 * @param {object} h
 * @param {() => void} h.onPlay      系統要求播放（只在沒出聲時會被 ui 接受）
 * @param {() => void} h.onPause     系統要求暫停
 * @param {() => void} h.onStop      系統要求停止
 * @param {(bars:number) => void} h.onSeekBars  ∓1 = 前後一小節
 */
export function init(h = {}) {
  hooks = h;
  const ms = navigator.mediaSession;
  if (!ms) return;                    // 這個瀏覽器沒有 Media Session，安靜地不做事
  const on = (name, fn) => { try { ms.setActionHandler(name, fn); } catch { /* 不支援 */ } };
  on("play",          () => hooks.onPlay?.());
  on("pause",         () => hooks.onPause?.());
  on("stop",          () => hooks.onStop?.());
  on("previoustrack", () => hooks.onSeekBars?.(-1));
  on("nexttrack",     () => hooks.onSeekBars?.(+1));
  on("seekbackward",  () => hooks.onSeekBars?.(-1));
  on("seekforward",   () => hooks.onSeekBars?.(+1));
}
