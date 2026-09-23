// Studio Workshop — ported from the owner's earlier frontend (owner-authorized port).
// 3MLE extension block reader/writer (bzip2 + base64 channel data).
// Workshop edits sit outside the Canonical/verified pipeline and are never evidence.
import { decompress, compress } from "./bzip2.mjs";
import * as i18n from "./i18n.mjs";

export const EXT_SECTION = "3MLE EXTENSION";

const HEADER_BYTES = 12;

const CH_INDEX = 0;
const CH_PROGRAM = 12;
const CH_DEFNO = 16;
const CH_BYTES = 28;

const TAG_ORDER = 0x01;
const TAG_CHANNEL = 0x02;
const TAG_NAME = 0x03;
const TAG_TIMING = 0x04;
const TAG_MARK = 0x09;
const TAG_HEADER = 0x12;

const HEADER_RECORD = Uint8Array.from([0, 0, 2, 0, 15, 3, 3, 0, 0, 0, 0, 0, 0, 0, 0, 0]);

const OUT_PPQ = 96;
const DEFAULT_BEATS = [4, 4];

const OUT_VOLUME = 100;
const OUT_PAN = 64;

const B64_LINE = 128;

const MAX_NAME_BYTES = 256;

const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (c & 1 ? 0xEDB88320 : 0);
    t[i] = c;
  }
  return t;
})();

function crc32(bytes) {
  let c = -1;
  for (let i = 0; i < bytes.length; i++) c = (c >>> 8) ^ CRC_TABLE[(c ^ bytes[i]) & 0xff];
  return (~c) >>> 0;
}

const ENCODING_ALIASES = new Map(Object.entries({
  "big5": "big5", "big-5": "big5", "cp950": "big5", "ms950": "big5",
  "gb2312": "gbk", "gbk": "gbk", "gb18030": "gbk", "cp936": "gbk", "ms936": "gbk",
  "shift_jis": "shift_jis", "shift-jis": "shift_jis", "sjis": "shift_jis",
  "cp932": "shift_jis", "ms932": "shift_jis", "windows-31j": "shift_jis",
  "euc-kr": "euc-kr", "euckr": "euc-kr", "ks_c_5601-1987": "euc-kr",
  "cp949": "euc-kr", "ms949": "euc-kr", "uhc": "euc-kr",
  "utf-8": "utf-8", "utf8": "utf-8",
  "windows-1252": "windows-1252", "cp1252": "windows-1252",
  "iso-8859-1": "windows-1252", "latin1": "windows-1252", "ansi": "windows-1252",
}));

const LOCALE_CODEPAGE = { "zh-Hant": "big5", "ja": "shift_jis", "ko": "euc-kr", "en": "windows-1252" };

const guessLegacy = () => LOCALE_CODEPAGE[i18n.getLocale()] ?? "big5";

const encoderCache = new Map();

function legacyEncoder(label) {
  const hit = encoderCache.get(label);
  if (hit) return hit;
  const dec = new TextDecoder(label);
  const map = new Map();
  const buf = new Uint8Array(2);
  const one = buf.subarray(0, 1);
  for (let b = 0; b < 0x100; b++) {
    buf[0] = b;
    const s = dec.decode(one);
    if (s.length === 1 && s !== "�" && !map.has(s)) map.set(s, [b]);
  }
  for (let lead = 0x81; lead <= 0xfe; lead++) {
    buf[0] = lead;
    for (let trail = 0x40; trail <= 0xfe; trail++) {
      buf[1] = trail;
      const s = dec.decode(buf);
      if (s.length === 1 && s !== "�" && !map.has(s)) map.set(s, [lead, trail]);
    }
  }
  encoderCache.set(label, map);
  return map;
}

function encodeLegacy(s, label) {
  const out = [];
  if (/^[\x00-\x7f]*$/.test(s)) {
    for (let i = 0; i < s.length; i++) out.push(s.charCodeAt(i));
    return Uint8Array.from(out);
  }
  const map = legacyEncoder(label);
  for (const ch of s) {
    const bytes = map.get(ch);
    if (bytes) out.push(...bytes);
    else out.push(0x3f);
  }
  return Uint8Array.from(out);
}

function decodeName(bytes, declared) {
  if (!bytes.length) return "";
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    const named = ENCODING_ALIASES.get(String(declared ?? "").trim().toLowerCase());
    const label = !named || named === "utf-8" ? guessLegacy() : named;
    try { return new TextDecoder(label).decode(bytes); }
    catch { return new TextDecoder("windows-1252").decode(bytes); }
  }
}

const asciiBytes = s => Uint8Array.from(s, c => c.charCodeAt(0) & 0xff);

function fromBase64(s) {
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function walkTLV(d, onRecord) {
  let i = 0;
  while (i + 5 <= d.length) {
    const tag = d[i];
    const len = (d[i + 1] | (d[i + 2] << 8) | (d[i + 3] << 16) | (d[i + 4] << 24)) >>> 0;
    if (len > d.length - i - 5) throw new Error("TLV 長度超出資料");
    onRecord(tag, d.subarray(i + 5, i + 5 + len));
    i += 5 + len;
  }
  if (i !== d.length) throw new Error("TLV 沒有走完");
}

export function parseExtension(body, declaredEncoding) {
  try {
    const lines = (body ?? "").split(/\r?\n/);
    const b64 = lines
      .map(l => /^\s*d\s*=(.*)$/.exec(l)?.[1]?.trim())
      .filter(Boolean)
      .join("");
    if (!b64) return null;

    const declared = lines.map(l => /^\s*c\s*=\s*(\d+)\s*$/.exec(l)?.[1]).find(Boolean);
    if (declared === undefined) return null;
    if (crc32(asciiBytes(b64)) !== Number(declared) >>> 0) return null;

    const blob = fromBase64(b64);
    if (blob.length <= HEADER_BYTES) return null;

    const dv = new DataView(blob.buffer, blob.byteOffset, blob.byteLength);
    const rawLen = dv.getUint32(0, true);
    const bodyCrc = dv.getUint32(4, true);
    const stream = blob.subarray(HEADER_BYTES);

    if (crc32(stream) !== bodyCrc) return null;
    const data = decompress(stream, { maxOut: rawLen });
    if (data.length !== rawLen) return null;

    const channels = new Map();
    let order = null;
    let meter = null;
    const marks = [];
    walkTLV(data, (tag, p) => {
      if (tag === TAG_TIMING && p.length >= 12) {
        const v = new DataView(p.buffer, p.byteOffset, p.byteLength);
        const num = v.getInt32(4, true), den = v.getInt32(8, true);
        if (num > 0 && den > 0) meter = { ppq: v.getInt32(0, true), num, den };
        return;
      }
      if (tag === TAG_MARK && p.length >= 13) {
        const v = new DataView(p.buffer, p.byteOffset, p.byteLength);
        let end = 12;
        while (end < p.length && p[end] !== 0 && end - 12 < MAX_NAME_BYTES) end++;
        const text = decodeName(p.subarray(12, end), declaredEncoding);
        if (text) marks.push({ tick: v.getInt32(4, true), text });
        return;
      }
      if (tag === TAG_ORDER && p.length >= 1) {
        order = Array.from(p.subarray(1));
      } else if (tag === TAG_CHANNEL && p.length >= CH_BYTES) {
        const v = new DataView(p.buffer, p.byteOffset, p.byteLength);
        const ch = p[CH_INDEX];
        const rec = channels.get(ch) ?? { program: null, defNo: null, name: "" };
        rec.program = v.getInt32(CH_PROGRAM, true);
        rec.defNo = v.getInt32(CH_DEFNO, true);
        channels.set(ch, rec);
      } else if (tag === TAG_NAME && p.length >= 1) {
        const ch = p[0];
        let end = 1;
        while (end < p.length && p[end] !== 0 && end - 1 < MAX_NAME_BYTES) end++;
        const rec = channels.get(ch) ?? { program: null, defNo: null, name: "" };
        rec.name = decodeName(p.subarray(1, end), declaredEncoding);
        channels.set(ch, rec);
      }
    });

    if (!channels.size) return null;
    return { order: order ?? [...channels.keys()].sort((a, b) => a - b), channels, meter, marks };
  } catch {
    return null;
  }
}

function record(tag, payload) {
  const out = new Uint8Array(payload.length + 5);
  out[0] = tag;
  new DataView(out.buffer).setUint32(1, payload.length, true);
  out.set(payload, 5);
  return out;
}

function nameBytes(name, channelNumber) {
  const s = String(name ?? "").trim() || `Track${channelNumber}`;
  const label = guessLegacy();
  const parts = [];
  let n = 0;
  for (const ch of s) {
    const b = encodeLegacy(ch, label);
    if (n + b.length > MAX_NAME_BYTES) break;
    parts.push(b);
    n += b.length;
  }
  const out = new Uint8Array(n + 2);
  out[0] = Math.min(255, Math.max(0, channelNumber - 1));
  let at = 1;
  for (const b of parts) { out.set(b, at); at += b.length; }
  return out;
}

function channelRecord({ channelNumber, program }) {
  const p = new Uint8Array(CH_BYTES);
  const idx = Math.min(255, Math.max(0, channelNumber - 1));
  const prog = Math.min(127, Math.max(0, program | 0));
  p[CH_INDEX] = idx;
  p[1] = OUT_VOLUME;
  p[2] = OUT_PAN;
  p[3] = idx;
  const v = new DataView(p.buffer);
  v.setInt32(4, -1, true);
  v.setInt32(CH_PROGRAM, prog, true);
  v.setInt32(CH_DEFNO, prog + 1, true);
  return p;
}

const toBase64 = bytes => btoa(String.fromCharCode(...bytes));

function markRecord(index, tick, text, color) {
  const label = guessLegacy();
  const parts = [];
  let n = 0;
  for (const ch of String(text ?? "")) {
    const b = encodeLegacy(ch, label);
    if (n + b.length > MAX_NAME_BYTES) break;
    parts.push(b);
    n += b.length;
  }
  const out = new Uint8Array(12 + n + 2);
  const v = new DataView(out.buffer);
  v.setInt32(0, index, true);
  v.setInt32(4, Math.max(0, Math.round(tick)), true);
  v.setInt32(8, color, true);
  let at = 12;
  for (const b of parts) { out.set(b, at); at += b.length; }
  return out;
}

const toColorRef = hex => {
  const n = parseInt(String(hex).replace("#", ""), 16) || 0;
  return ((n & 255) << 16) | (n & 0xff00) | ((n >> 16) & 255);
};

export function buildExtension(channels, meter = null, marks = []) {
  const list = (channels ?? []).filter(c => Number.isInteger(c?.channelNumber));
  if (!list.length) return null;

  const beats = meter?.num > 0 && meter?.den > 0 ? [meter.num, meter.den] : DEFAULT_BEATS;
  const timing = new Uint8Array(12);
  const tv = new DataView(timing.buffer);
  tv.setInt32(0, OUT_PPQ, true);
  tv.setInt32(4, beats[0], true);
  tv.setInt32(8, beats[1], true);

  const order = new Uint8Array(list.length + 1);
  list.forEach((c, i) => { order[i + 1] = Math.min(255, Math.max(0, c.channelNumber - 1)); });

  const parts = [record(TAG_HEADER, HEADER_RECORD), record(TAG_TIMING, timing), record(TAG_ORDER, order)];
  for (const c of list) {
    parts.push(record(TAG_CHANNEL, channelRecord(c)));
    parts.push(record(TAG_NAME, nameBytes(c.name, c.channelNumber)));
  }
  (marks ?? []).forEach((m, i) =>
    parts.push(record(TAG_MARK, markRecord(i, m.tick, m.text, toColorRef(m.color)))));

  let n = 0;
  for (const p of parts) n += p.length;
  const payload = new Uint8Array(n);
  let at = 0;
  for (const p of parts) { payload.set(p, at); at += p.length; }

  const body = compress(payload);
  const blob = new Uint8Array(HEADER_BYTES + body.length);
  const bv = new DataView(blob.buffer);
  bv.setUint32(0, payload.length, true);
  bv.setUint32(4, crc32(body), true);
  bv.setUint32(8, 1, true);
  blob.set(body, HEADER_BYTES);

  const text = toBase64(blob);
  const lines = [
    "[3MLE EXTENSION]",
    '/* DO NOT EDIT!! DATA VOID IF "3MLE EXTENSION" IS EDITED. */',
    `c=${crc32(asciiBytes(text))}`,
  ];
  for (let i = 0; i < text.length; i += B64_LINE) lines.push(`d=${text.slice(i, i + B64_LINE)}`);
  return lines.join("\r\n") + "\r\n";
}
