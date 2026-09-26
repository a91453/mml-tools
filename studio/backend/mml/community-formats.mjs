// Community MML file formats: 3MLE `.mml` and `.mmi`.
//
// Ported from the owner's earlier frontend via the Studio Workshop
// (studio/web/workshop/mml-in.mjs and mml-ext.mjs; owner-authorized port,
// 2026-09-23). Only the reading half is here: file text → the raw MML the file
// carries, plus what the file says about it (title, track names, programs,
// declared meter, markers). It does not go through the Workshop's 480-tick
// model or its compressor, and it never rewrites a note: the MML it returns is
// handed to normalizeMMLSource like any pasted MML@ string, whose parser
// judges it.
//
// Position is role. The tracks are laid out in the file's own order and
// position n becomes the nth of the six role slots, as it does for a pasted
// MML@ string. In a `.mml` every [ChannelN] is a position (the extension
// block's channel order first, then channel number), empty ones included; in
// an `.mmi` see readMmi. Trailing empty positions are dropped; more than six
// positions is refused rather than cut.
//
// What the file declares about meter is file metadata, not a caller-confirmed
// meter map: it is reported, never applied.
import { decompress } from './bzip2-decode.mjs';

export const COMMUNITY_FORMATS = Object.freeze({ '3mle-mml': '3MLE .mml', mmi: '.mmi' });
const ROLE_SLOTS = 6;
const EXT_SECTION = '3MLE EXTENSION';
const MAX_NAME_BYTES = 256;
const HEADER_BYTES = 12;
const CH_INDEX = 0;
const CH_PROGRAM = 12;
const CH_BYTES = 28;
const TAG_ORDER = 0x01;
const TAG_CHANNEL = 0x02;
const TAG_NAME = 0x03;
const TAG_TIMING = 0x04;
const TAG_MARK = 0x09;

// `[Settings]`/`[ChannelN]` is a 3MLE .mml; `[mml-score]` is an .mmi. A pasted
// MML@ string is neither and keeps its own path.
export function sniffCommunityFormat(text) {
  const head = String(text ?? '').slice(0, 4096);
  if (/^\s*\[mml-score\]/i.test(head)) return 'mmi';
  if (/^\s*\[Settings\]/i.test(head) || /^\s*\[Channel\d+\]/im.test(head)) return '3mle-mml';
  return null;
}

function sections(text) {
  const out = [];
  const re = /^[ \t]*\[([^\]\r\n]*)\][ \t]*(?:\r?\n|$)/gm;
  let m, prev = null;
  while ((m = re.exec(text)) !== null) {
    if (prev) prev.body = text.slice(prev.at, m.index);
    prev = { name: m[1].trim(), at: re.lastIndex, body: '' };
    out.push(prev);
  }
  if (prev) prev.body = text.slice(prev.at);
  return out;
}

function kv(line) {
  const i = line.indexOf('=');
  if (i < 0) return null;
  return [line.slice(0, i).trim().toLowerCase(), line.slice(i + 1)];
}

const int = v => {
  const n = Number.parseInt(String(v).trim(), 10);
  return Number.isFinite(n) ? n : null;
};

// ─── 3MLE extension block (CRC-checked, bzip2, TLV records) ────────────────
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
  big5: 'big5', 'big-5': 'big5', cp950: 'big5', ms950: 'big5',
  gb2312: 'gbk', gbk: 'gbk', gb18030: 'gbk', cp936: 'gbk', ms936: 'gbk',
  shift_jis: 'shift_jis', 'shift-jis': 'shift_jis', sjis: 'shift_jis', cp932: 'shift_jis', ms932: 'shift_jis', 'windows-31j': 'shift_jis',
  'euc-kr': 'euc-kr', euckr: 'euc-kr', 'ks_c_5601-1987': 'euc-kr', cp949: 'euc-kr', ms949: 'euc-kr', uhc: 'euc-kr',
  'utf-8': 'utf-8', utf8: 'utf-8',
  'windows-1252': 'windows-1252', cp1252: 'windows-1252', 'iso-8859-1': 'windows-1252', latin1: 'windows-1252', ansi: 'windows-1252',
}));

// Names are display metadata. UTF-8 first; otherwise the encoding the file
// declares, and Big5 when it declares none (the Workshop guesses from its UI
// language; intake has none, and the owner's files are Traditional Chinese).
function decodeName(bytes, declared) {
  if (!bytes.length) return '';
  try { return new TextDecoder('utf-8', { fatal: true }).decode(bytes); }
  catch {
    const named = ENCODING_ALIASES.get(String(declared ?? '').trim().toLowerCase());
    const label = !named || named === 'utf-8' ? 'big5' : named;
    try { return new TextDecoder(label).decode(bytes); }
    catch { return new TextDecoder('windows-1252').decode(bytes); }
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
    if (len > d.length - i - 5) throw Error('TLV record overruns the block');
    onRecord(tag, d.subarray(i + 5, i + 5 + len));
    i += 5 + len;
  }
  if (i !== d.length) throw Error('TLV block has trailing bytes');
}

// null when the block is absent or fails any check (text CRC, body CRC,
// bzip2 block CRCs, declared length, TLV framing). A refused block only costs
// the names and programs: the tracks come from the [ChannelN] sections.
export function readExtension(body, declaredEncoding) {
  try {
    const lines = String(body ?? '').split(/\r?\n/);
    const b64 = lines.map(l => /^\s*d\s*=(.*)$/.exec(l)?.[1]?.trim()).filter(Boolean).join('');
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
    let order = null, meter = null;
    const marks = [];
    walkTLV(data, (tag, p) => {
      const v = new DataView(p.buffer, p.byteOffset, p.byteLength);
      if (tag === TAG_TIMING && p.length >= 12) {
        const num = v.getInt32(4, true), den = v.getInt32(8, true);
        if (num > 0 && den > 0) meter = { ppq: v.getInt32(0, true), numerator: num, denominator: den };
      } else if (tag === TAG_MARK && p.length >= 13) {
        let end = 12;
        while (end < p.length && p[end] !== 0 && end - 12 < MAX_NAME_BYTES) end++;
        const text = decodeName(p.subarray(12, end), declaredEncoding);
        if (text) marks.push({ tick: v.getInt32(4, true), text });
      } else if (tag === TAG_ORDER && p.length >= 1) {
        order = Array.from(p.subarray(1));
      } else if (tag === TAG_CHANNEL && p.length >= CH_BYTES) {
        const ch = p[CH_INDEX];
        const rec = channels.get(ch) ?? { program: null, name: '' };
        rec.program = v.getInt32(CH_PROGRAM, true);
        channels.set(ch, rec);
      } else if (tag === TAG_NAME && p.length >= 1) {
        const ch = p[0];
        let end = 1;
        while (end < p.length && p[end] !== 0 && end - 1 < MAX_NAME_BYTES) end++;
        const rec = channels.get(ch) ?? { program: null, name: '' };
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

// ─── track text ─────────────────────────────────────────────────────────────
// A 3MLE channel body may be wrapped over several lines. Line breaks (and the
// blanks at either end of a line) are layout, so the lines are joined; any
// other whitespace is left in place for the parser to report, because
// deleting it could join a note to a number it was not written with.
function joinLines(body) {
  const lines = String(body ?? '').split(/\r?\n/).map(line => line.trim());
  return { text: lines.join(''), joined: lines.filter(Boolean).length > 1 };
}

// The pieces of an .mmi `mml-track=MML@a,b,c;` value.
function splitWrapped(value) {
  const text = String(value ?? '').trim().replace(/^MML@/i, '').replace(/;\s*$/, '');
  return text.split(',').map(part => part.trim());
}

function refuse(message) { return Error(`UNSUPPORTED: ${message}`); }

function assemble(format, positions, facts) {
  for (const position of positions) {
    if (/MML@|[,;]/i.test(position.text)) throw refuse(`${COMMUNITY_FORMATS[format]} track "${position.label}" contains an MML@ wrapper or a track separator`);
  }
  let last = positions.length;
  while (last > 0 && !positions[last - 1].text) last--;
  const used = positions.slice(0, last);
  if (!used.some(position => position.text)) throw refuse(`${COMMUNITY_FORMATS[format]} file carries no MML track`);
  if (used.length > ROLE_SLOTS) {
    throw refuse(`${COMMUNITY_FORMATS[format]} file lays out ${used.length} tracks (${used.filter(p => p.text).length} non-empty); Studio reads six role slots and does not drop tracks`);
  }
  const slots = [...used, ...Array.from({ length: ROLE_SLOTS - used.length }, () => null)];
  const mml = `MML@${slots.map(slot => slot?.text ?? '').join(',')};`;
  return {
    format: COMMUNITY_FORMATS[format],
    mml,
    tracks: slots.map((slot, position) => (slot ? { position, label: slot.label, program: slot.program, channel: slot.channel ?? null, empty: !slot.text } : { position, label: null, program: null, channel: null, empty: true })),
    ...facts,
  };
}

function read3mle(text) {
  const secs = sections(text);
  const warnings = [];
  let title = '', encoding = '';
  for (const s of secs) {
    if (!/^settings$/i.test(s.name)) continue;
    for (const line of s.body.split(/\r?\n/)) {
      const p = kv(line);
      if (!p) continue;
      if (p[0] === 'title') title = p[1].trim();
      else if (p[0] === 'encoding') encoding = p[1].trim();
    }
  }
  const bodies = new Map();
  for (const s of secs) {
    const n = int(/^Channel(\d+)$/i.exec(s.name)?.[1]);
    if (n === null || n < 1) continue;
    bodies.set(n - 1, s.body);
  }
  const extSec = secs.find(s => s.name.toUpperCase() === EXT_SECTION);
  const ext = extSec ? readExtension(extSec.body, encoding) : null;
  if (extSec && !ext) warnings.push('COMMUNITY_EXTENSION_UNREADABLE');
  const order = [];
  const seen = new Set();
  const take = ch => { if (bodies.has(ch) && !seen.has(ch)) { seen.add(ch); order.push(ch); } };
  if (ext) ext.order.forEach(take);
  [...bodies.keys()].sort((a, b) => a - b).forEach(take);
  let joined = false;
  const positions = order.map(ch => {
    const info = ext?.channels.get(ch);
    const body = joinLines(bodies.get(ch));
    joined ||= body.joined;
    return { text: body.text, label: info?.name || `Channel${ch + 1}`, program: Number.isInteger(info?.program) ? info.program : null, channel: ch + 1 };
  });
  if (joined) warnings.push('COMMUNITY_LINES_JOINED');
  return assemble('3mle-mml', positions, {
    title, encoding: encoding || null,
    extension: ext ? 'verified' : extSec ? 'refused' : 'absent',
    declaredMeter: ext?.meter ? [{ tick: 0, ppq: ext.meter.ppq, numerator: ext.meter.numerator, denominator: ext.meter.denominator }] : [],
    markers: (ext?.marks ?? []).map(m => ({ tick: m.tick, ppq: ext.meter?.ppq ?? null, text: m.text })),
    warnings,
  });
}

function readMmi(text) {
  const warnings = [];
  let title = '', time = '';
  const blocks = [];
  const meterChanges = [];
  const markers = [];
  let section = '';
  for (const line of text.split(/\r?\n/)) {
    const sec = /^\s*\[(.+?)\]\s*$/.exec(line);
    if (sec) { section = sec[1].trim().toLowerCase(); continue; }
    const p = kv(line);
    if (!p) continue;
    const [k, v] = p;
    if (section === 'marker') {
      if (/^\d+$/.test(k) && v.trim()) markers.push({ tick: Number(k), ppq: null, text: v.trim() });
      continue;
    }
    if (section === 'time-signature') {
      const m = /^\d+$/.test(k) ? /^\s*(\d+)\s*\/\s*(\d+)\s*$/.exec(v) : null;
      if (m) meterChanges.push({ tick: Number(k), ppq: null, numerator: Number(m[1]), denominator: Number(m[2]) });
      continue;
    }
    if (k === 'mml-track') blocks.push({ mml: v, name: '', program: null });
    else if (k === 'name' && blocks.length) blocks.at(-1).name = v.trim();
    else if (k === 'program' && blocks.length) blocks.at(-1).program = int(v);
    else if (k === 'title' && !title) title = v.trim();
    else if (k === 'time' && !time) time = v.trim();
  }
  const head = /^\s*(\d+)\s*\/\s*(\d+)\s*$/.exec(time);
  const positions = [];
  // An .mmi block is one instrument with up to three parts (melody and two
  // chords, MML@a,b,c;). Its written parts take consecutive positions and its
  // unused part slots take none; a block with nothing written keeps its one
  // position, so an empty track between two others stays where it was.
  blocks.forEach((block, bi) => {
    const parts = splitWrapped(block.mml);
    const written = parts.map((part, k) => ({ part, k })).filter(({ part }) => part);
    const name = block.name || `Track${bi + 1}`;
    if (!written.length) positions.push({ text: '', label: name, program: block.program, channel: null });
    for (const { part, k } of written) positions.push({ text: part, label: written.length > 1 || k > 0 ? `${name} #${k + 1}` : name, program: block.program, channel: null });
  });
  if (positions.some(position => /\s/.test(position.text))) warnings.push('COMMUNITY_WHITESPACE_IN_TRACK');
  return assemble('mmi', positions, {
    title, encoding: null, extension: 'absent',
    declaredMeter: [...(head ? [{ tick: 0, ppq: null, numerator: Number(head[1]), denominator: Number(head[2]) }] : []), ...meterChanges],
    markers,
    warnings,
  });
}

// File text → { format, mml, title, tracks, declaredMeter, markers, extension,
// warnings }. Throws UNSUPPORTED when the file is not one of these formats or
// cannot be laid out as six role slots without dropping or rewriting a track.
export function readCommunityMML(text) {
  const format = sniffCommunityFormat(text);
  if (format === 'mmi') return readMmi(String(text));
  if (format === '3mle-mml') return read3mle(String(text));
  throw refuse('not a 3MLE .mml or .mmi file');
}
