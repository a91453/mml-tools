// Studio Workshop — ported from the owner's earlier frontend (owner-authorized port).
// Standard MIDI File export.
// Workshop edits sit outside the Canonical/verified pipeline and are never evidence.
import { PPQ, chanOf } from "./config.mjs";

export function toMIDI(parsed, programs = [], meters = [], marks = []) {
  const bytes = [];
  const u32 = n => [n >> 24 & 255, n >> 16 & 255, n >> 8 & 255, n & 255];
  const vlq = n => { const o = [n & 127]; n >>= 7; while (n > 0) { o.unshift(n & 127 | 128); n >>= 7; } return o; };
  const rank = k => (k === "m" ? 0 : k === "k" ? 1 : 2);
  const chunk = (id, data) => [...id].map(c => c.charCodeAt(0)).concat(u32(data.length), data);

  bytes.push(...chunk("MThd", [0, 1, 0, parsed.tracks.length + 1, PPQ >> 8, PPQ & 255]));

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
      const b = [...new TextEncoder().encode(ev.text)];
      td.push(...vlq(ev.tick - lastT), 0xFF, 0x06, ...vlq(b.length), ...b);
    } else if (ev.kind === "t") {
      const us = Math.round(60000000 / ev.bpm);
      td.push(...vlq(ev.tick - lastT), 0xFF, 0x51, 3, us >> 16 & 255, us >> 8 & 255, us & 255);
    } else {
      td.push(...vlq(ev.tick - lastT), 0xFF, 0x58, 4, ev.num, Math.log2(ev.den), 24, 8);
    }
    lastT = ev.tick;
  }
  td.push(0, 0xFF, 0x2F, 0);
  bytes.push(...chunk("MTrk", td));

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
