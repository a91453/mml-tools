// ────────────────────────────────────────────────────────────────────────────
//  極簡 SMF 輸出
//  純函式：parseAll() 的結果 + 各軌的 program → .mid 的位元組。
// ────────────────────────────────────────────────────────────────────────────

import { PPQ } from "./config.js";

/**
 * @param {ReturnType<import("./mml.js").parseAll>} parsed
 * @param {number[]} programs 第 i 軌要用的 MIDI program（0-based）
 */
export function toMIDI(parsed, programs = []) {
  const bytes = [];
  const u32 = n => [n >> 24 & 255, n >> 16 & 255, n >> 8 & 255, n & 255];
  const vlq = n => { const o = [n & 127]; n >>= 7; while (n > 0) { o.unshift(n & 127 | 128); n >>= 7; } return o; };
  const chunk = (id, data) => [...id].map(c => c.charCodeAt(0)).concat(u32(data.length), data);

  // format 1, ntracks, division
  bytes.push(...chunk("MThd", [0, 1, 0, parsed.tracks.length + 1, PPQ >> 8, PPQ & 255]));

  // 速度軌：寫真正的 tempo 事件，音符軌就能直接用解析出來的 tick，
  // 不必先換成秒再用假的 120 BPM 量化回去（那樣譜面看起來會很醜）。
  const tempos = parsed.tempos.length ? parsed.tempos : [{ tick: 0, bpm: 120 }];
  const td = [];
  let lastT = 0;
  for (const ev of tempos) {
    const us = Math.round(60000000 / ev.bpm);
    td.push(...vlq(ev.tick - lastT), 0xFF, 0x51, 3, us >> 16 & 255, us >> 8 & 255, us & 255);
    lastT = ev.tick;
  }
  td.push(0, 0xFF, 0x2F, 0);
  bytes.push(...chunk("MTrk", td));

  parsed.tracks.forEach((tr, ch) => {
    const ev = [];
    for (const n of tr.notes) {
      ev.push({ tick: n.tick, d: [0x90 | ch, n.midi, n.vel] });
      ev.push({ tick: n.tick + n.durTick, d: [0x80 | ch, n.midi, 0] });
    }
    ev.sort((a, b) => a.tick - b.tick);
    const data = [0, 0xC0 | ch, programs[ch] ?? 0];
    let last = 0;
    for (const e of ev) { data.push(...vlq(e.tick - last), ...e.d); last = e.tick; }
    data.push(0, 0xFF, 0x2F, 0);
    bytes.push(...chunk("MTrk", data));
  });
  return new Uint8Array(bytes);
}
