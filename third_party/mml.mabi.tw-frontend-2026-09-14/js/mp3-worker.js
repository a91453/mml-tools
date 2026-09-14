// ────────────────────────────────────────────────────────────────────────────
//  混音匯出：MP3 編碼 Worker
//
//  瀏覽器沒有內建的 mp3 編碼器（WebCodecs 的 `AudioEncoder` 只有 opus / aac / flac / pcm，
//  而 mp3 是唯讀的），所以走 LAME。獨立成一個 Worker 而不是接在合成 Worker 後面：那一個抱著
//  30 MB 音色庫，合成一結束就該 terminate() 放掉。
//
//   `vendor/lamejs.js` 是 **LGPL**，原封不動放著、不打包也不改名。
// ────────────────────────────────────────────────────────────────────────────

import { Mp3Encoder } from "../vendor/lamejs.js";

/**
 * 一次餵給編碼器幾個 sample。1152 是 MPEG-1 Layer III 一個 frame 的 sample 數。
 */
const GRAIN = 1152;

/**
 * Float32（±1）→ Int16，順便套上音量係數。兩件事一起做是因為母帶有一億個 sample。
 *
 * 夾限要留著：`gain` 算的是整體峰值，浮點誤差可能讓最大的那個 sample 剛好越界，而 Int16 溢位
 * 是會回繞的 —— 那在耳朵裡是一聲爆音，不是「有點大聲」。
 */
function toInt16(src, from, n, gain, dst) {
  for (let i = 0; i < n; i++) {
    const v = Math.round(src[from + i] * gain * 32767);
    dst[i] = v > 32767 ? 32767 : v < -32768 ? -32768 : v;
  }
  return dst;
}

function encode({ left, right, sampleRate, kbps, gain }) {
  const enc = new Mp3Encoder(2, sampleRate, kbps);
  const total = left.length;
  const l = new Int16Array(GRAIN), r = new Int16Array(GRAIN);
  const parts = [];

  let lastReport = 0;
  for (let at = 0; at < total; at += GRAIN) {
    const n = Math.min(GRAIN, total - at);
    toInt16(left, at, n, gain, l);
    toInt16(right, at, n, gain, r);
    // 日最後一塊不滿 GRAIN 時長度要切對：`l`／`r` 是重複使用的，尾端還留著**上一塊**的資料。
    const buf = n === GRAIN
      ? enc.encodeBuffer(l, r)
      : enc.encodeBuffer(l.subarray(0, n), r.subarray(0, n));
    if (buf.length) parts.push(buf);
    if (at - lastReport >= sampleRate * 5) {
      lastReport = at;
      postMessage({ type: "progress", frame: at, totalFrames: total });
    }
  }

  const tail = enc.flush();
  if (tail.length) parts.push(tail);
  postMessage({ type: "done", parts });
}

onmessage = e => {
  if (e.data?.type !== "encode") return;
  try {
    encode(e.data);
  } catch (err) {
    postMessage({ type: "error", message: err?.message ?? String(err) });
  }
};
