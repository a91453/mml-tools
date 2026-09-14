// ────────────────────────────────────────────────────────────────────────────
//  極簡 SMF 輸出
//  純函式：parseAll() 的結果 + 各軌的 program → .mid 的位元組。
// ────────────────────────────────────────────────────────────────────────────

import { PPQ, chanOf } from "./config.js";

/**
 * @param {ReturnType<import("./mml.js").parseAll>} parsed
 * @param {number[]} programs 第 i 軌要用的 MIDI program（0-based，**照軌號索引**）
 * @param {{tick:number,num:number,den:number}[]} [meters] 拍號圖。**這是拍號唯一
 *        無損的出口**：0x58 是木標準而且支援變拍（見速度軌那段）。
 * @param {{tick:number,text:string}[]} [marks] 段落標記 → meta 0x06（Marker）。
 */
export function toMIDI(parsed, programs = [], meters = [], marks = []) {
  const bytes = [];
  const u32 = n => [n >> 24 & 255, n >> 16 & 255, n >> 8 & 255, n & 255];
  const vlq = n => { const o = [n & 127]; n >>= 7; while (n > 0) { o.unshift(n & 127 | 128); n >>= 7; } return o; };
  // 同一個 tick 上的先後：拍號 → 標記 → 速度。純粹為了輸出穩定（來回轉換的測試要逐位元
  // 組相同），三者之間沒有語意上的先後。
  const rank = k => (k === "m" ? 0 : k === "k" ? 1 : 2);
  const chunk = (id, data) => [...id].map(c => c.charCodeAt(0)).concat(u32(data.length), data);

  // format 1, ntracks, division
  bytes.push(...chunk("MThd", [0, 1, 0, parsed.tracks.length + 1, PPQ >> 8, PPQ & 255]));

  // 速度軌：寫真正的 tempo 事件，音符軌就能直接用解析出來的 tick，不必先換成秒再用假的
  // 120 BPM 量化回去。
  //
  // **拍號（0x58）也寫在這一軌**：SMF 的慣例就是把整首共用的 meta 放在第 0 軌，而這是拍
  // 號唯一能無損帶走的出口（`.mmi` 的 `[time-signature]` 是私有區塊，`.mml` 的 tag 0x04
  // 只裝得下一個拍號，只有 0x58 是標準而且支援變拍）。
  //
  // 兩種事件按 tick 交錯寫 —— delta time 日是相對的，分兩輪寫會讓第二輪的時間全錯。
  const tempos = parsed.tempos.length ? parsed.tempos : [{ tick: 0, bpm: 120 }];
  const evs = [
    ...tempos.map(e => ({ tick: e.tick, kind: "t", bpm: e.bpm })),
    ...(meters ?? []).map(m => ({ tick: m.tick, kind: "m", num: m.num, den: m.den })),
    ...(marks ?? []).map(m => ({ tick: m.tick, kind: "k", text: m.text })),
  ].sort((a, b) => a.tick - b.tick || rank(a.kind) - rank(b.kind));

  const td = [];
  let lastT = 0;
  for (const ev of evs) {
    if (ev.kind === "k") {
      // Marker（0x06）。**UTF-8**：SMF 沒有規定 meta 文字的編碼，而 UTF-8 是現在的實務。
      const b = [...new TextEncoder().encode(ev.text)];
      td.push(...vlq(ev.tick - lastT), 0xFF, 0x06, ...vlq(b.length), ...b);
    } else if (ev.kind === "t") {
      const us = Math.round(60000000 / ev.bpm);
      td.push(...vlq(ev.tick - lastT), 0xFF, 0x51, 3, us >> 16 & 255, us >> 8 & 255, us & 255);
    } else {
      // 分母寫的是 **log2**（8 → 3）。cc=24 與 bb=8 是規格的常規值，跟本站的時人值無關。
      td.push(...vlq(ev.tick - lastT), 0xFF, 0x58, 4, ev.num, Math.log2(ev.den), 24, 8);
    }
    lastT = ev.tick;
  }
  td.push(0, 0xFF, 0x2F, 0);
  bytes.push(...chunk("MTrk", td));

  // 軌號與 channel 不再是同一個數字：channel 9 是 GM 的打擊組，跳過（見 chanOf）。
  // programs 照**軌號**索引，寫出去的 status byte 才用 channel —— 混用的話第 10 軌之後的
  // 樂器會整批錯位一格，而那要打開 .mid 才聽得出來。
  parsed.tracks.forEach((tr, i) => {
    const ch = chanOf(i);
    const ev = [];
    for (const n of tr.notes) {
      ev.push({ tick: n.tick, d: [0x90 | ch, n.midi, n.vel] });
      ev.push({ tick: n.tick + n.durTick, d: [0x80 | ch, n.midi, 0] });
    }
    ev.sort((a, b) => a.tick - b.tick);
    const data = [0, 0xC0 | ch, programs[i] ?? 0];
    let last = 0;
    for (const e of ev) { data.push(...vlq(e.tick - last), ...e.d); last = e.tick; }
    data.push(0, 0xFF, 0x2F, 0);
    bytes.push(...chunk("MTrk", data));
  });
  return new Uint8Array(bytes);
}
