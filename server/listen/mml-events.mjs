// Listening projection of a six-role MML string: notes, tempo, bars.
//
// This module is inlined verbatim (minus the `export` keywords) into the
// in-chat listening widget, so it has no imports and runs unchanged in a
// browser and in Node. It is not a validator and grades nothing: it mirrors
// the Studio parser's *ingest* reading (studio/backend/mml/parser.mjs,
// validationMode 'ingest') for the one question a player asks -- which pitch
// sounds from which beat to which beat -- and keeps that parser's recoverable
// findings only as display text. tests/listen-mml-events.test.mjs pins the
// note/tempo/total parity against the Studio parser on synthetic MML, so a
// change there that moves a note fails here rather than in someone's ear.
//
// Timing is exact: beats are reduced BigInt fractions printed the way the
// repository's `F` prints them ("88", "177/2"), because a float sum of
// triplet lengths drifts and parity would then be approximate.

export const LISTEN_ROLES = Object.freeze(['Melody', 'Chord1', 'Chord2', 'Chord3', 'Chord4', 'Chord5']);
export const LISTEN_MML_MAX_CHARACTERS = 40000;

const LENGTH_MIN = 1;
const LENGTH_MAX = 64;
const NUMERIC_NOTE_MIN = 0;
const NUMERIC_NOTE_MAX = 107;
const TEMPO_MIN = 32;
const TEMPO_MAX = 255;
const MAX_FINDINGS_PER_TRACK = 40;
const NOTE_BASE = { c: 0, d: 2, e: 4, f: 5, g: 7, a: 9, b: 11 };

const bigGcd = (a, b) => {
  a = a < 0n ? -a : a;
  b = b < 0n ? -b : b;
  while (b) [a, b] = [b, a % b];
  return a || 1n;
};

// A reduced non-negative fraction. Only what the parser needs.
class Ratio {
  constructor(n, d = 1n) {
    const g = bigGcd(n, d);
    this.n = n / g;
    this.d = d / g;
  }
  add(other) { return new Ratio(this.n * other.d + other.n * this.d, this.d * other.d); }
  mul(other) { return new Ratio(this.n * other.n, this.d * other.d); }
  cmp(other) {
    const left = this.n * other.d;
    const right = other.n * this.d;
    return left < right ? -1 : left > right ? 1 : 0;
  }
  toString() { return this.d === 1n ? String(this.n) : `${this.n}/${this.d}`; }
}

const ZERO = new Ratio(0n);

/** "177/2" or "88" to a JavaScript number. */
export function listenBeatNumber(text) {
  const match = /^(\d+)(?:\/(\d+))?$/.exec(String(text));
  if (!match) return NaN;
  return match[2] ? Number(match[1]) / Number(match[2]) : Number(match[1]);
}

/**
 * Split an `MML@a,b,c,d,e,f;` string into its six role strings, or say why not.
 * The same envelope rule the Studio parser applies.
 */
export function splitListenMml(raw) {
  if (typeof raw !== 'string' || raw.length > LISTEN_MML_MAX_CHARACTERS) return { error: '請提供40,000字以內的MML' };
  const text = raw.trim();
  if (!/^MML@/i.test(text) || !text.endsWith(';')) return { error: '請貼上從 MML@ 到 ; 的完整六軌字串' };
  const tracks = text.slice(4, -1).split(',');
  if (tracks.length !== 6) return { error: `需要六個固定軌位，目前為${tracks.length}軌` };
  return { tracks };
}

/** One role string to note events, exactly as the Studio ingest parser times them. */
export function parseListenTrack(raw, role) {
  const events = [];
  const tempo = [];
  const findings = [];
  const note = (message, position) => {
    if (findings.length < MAX_FINDINGS_PER_TRACK) findings.push({ role, position: position + 1, message });
  };
  const digits = /\d+/y;
  const readNumber = at => {
    digits.lastIndex = at;
    const match = digits.exec(text);
    return match ? match[0] : null;
  };

  let i = 0;
  let time = ZERO;
  let octave = 4;
  let explicitOctave = false;
  let length = 4;
  let lengthTrusted = true;
  let volume = 8;
  let pending = false;
  let lastWasNote = false;
  const text = raw.toLowerCase();
  const inLengthRange = value => Number.isSafeInteger(value) && value >= LENGTH_MIN && value <= LENGTH_MAX;

  const append = (pitch, duration, at) => {
    const end = time.add(duration);
    const last = events[events.length - 1];
    if (pending && last && last.pitch === pitch && last.end.cmp(time) === 0) {
      last.end = end;
    } else {
      if (pending) note('延音音高不同或跨越空隙', at);
      events.push({ pitch, start: time, end, volume });
    }
    pending = false;
    lastWasNote = true;
    time = end;
  };

  while (i < text.length) {
    const start = i;
    const ch = text[i++];
    if (/\s/.test(ch)) continue;

    if (ch === 't' || ch === 'o' || ch === 'l' || ch === 'v') {
      const token = readNumber(i);
      if (token === null) {
        note(`${ch.toUpperCase()}缺少數值`, start);
        continue;
      }
      i += token.length;
      const value = Number(token);
      if (ch === 't') {
        if (value < TEMPO_MIN || value > TEMPO_MAX) note(`T${value}超出${TEMPO_MIN}–${TEMPO_MAX}`, start);
        if (tempo.length && tempo[tempo.length - 1].beat.cmp(time) >= 0) note('同一拍重複或倒序Tempo', start);
        tempo.push({ beat: time, bpm: value });
      } else if (ch === 'o') {
        octave = value;
        explicitOctave = true;
      } else if (ch === 'l') {
        if (inLengthRange(value)) {
          length = value;
          lengthTrusted = true;
        } else {
          lengthTrusted = false;
          note(`L${value}超出官方長度數值範圍${LENGTH_MIN}–${LENGTH_MAX}`, start);
        }
      } else if (value < 0 || value > 15) {
        note(`V${value}超出0–15`, start);
      } else {
        volume = value;
      }
      continue;
    }

    if (ch === '<' || ch === '>') {
      octave += ch === '>' ? 1 : -1;
      continue;
    }

    if (ch === '&') {
      const last = events[events.length - 1];
      if (pending || !lastWasNote || !last || last.end.cmp(time) !== 0) note('延音必須接續同音音符，不能接休止或重複 &', start);
      pending = true;
      continue;
    }

    if (ch === 'n') {
      const token = readNumber(i);
      if (token === null) {
        note('Nxx缺少數值', start);
        pending = false;
        lastWasNote = false;
        continue;
      }
      i += token.length;
      const pitch = Number(token);
      if (!Number.isSafeInteger(pitch) || pitch < NUMERIC_NOTE_MIN || pitch > NUMERIC_NOTE_MAX) {
        note(`N${token}超出${NUMERIC_NOTE_MIN}–${NUMERIC_NOTE_MAX}`, start);
        pending = false;
        lastWasNote = false;
        continue;
      }
      if (!lengthTrusted) {
        note('前一個L值無效，Nxx時值不可推定', start);
        pending = false;
        lastWasNote = false;
        continue;
      }
      append(pitch, new Ratio(4n, BigInt(length)), start);
      continue;
    }

    if (ch in NOTE_BASE || ch === 'r') {
      let accidental = 0;
      if (ch !== 'r' && (text[i] === '+' || text[i] === '#' || text[i] === '-')) {
        accidental = text[i] === '-' ? -1 : 1;
        i++;
      }
      const token = readNumber(i);
      if (token === null && !lengthTrusted) {
        note('前一個L值無效，省略分母的音符／休止時值不可推定', start);
        pending = false;
        lastWasNote = false;
        continue;
      }
      const denominator = token === null ? length : Number(token);
      if (token !== null) i += token.length;
      let dots = 0;
      while (text[i] === '.') {
        dots++;
        i++;
      }
      if (!inLengthRange(denominator)) {
        note(`${ch}${denominator}超出官方長度數值範圍${LENGTH_MIN}–${LENGTH_MAX}`, start);
        pending = false;
        lastWasNote = false;
        continue;
      }
      const capped = BigInt(Math.min(dots, 8));
      const dotFactor = dots ? new Ratio(2n ** (capped + 1n) - 1n, 2n ** capped) : new Ratio(1n);
      const duration = new Ratio(4n, BigInt(denominator)).mul(dotFactor);
      if (ch === 'r') {
        if (pending) note('延音不能接到休止', start);
        pending = false;
        lastWasNote = false;
        time = time.add(duration);
      } else {
        if (!explicitOctave) note('首音前必須明確設定O八度', start);
        append(12 * (octave + 1) + NOTE_BASE[ch] + accidental, duration, start);
      }
      continue;
    }

    note(`無法辨識字元「${ch}」`, start);
    pending = false;
    lastWasNote = false;
  }
  if (pending) note('軌尾有未完成延音', Math.max(0, text.length - 1));

  return {
    role,
    characters: raw.length,
    empty: raw.length === 0,
    total: time.toString(),
    tempo: tempo.map(entry => ({ beat: entry.beat.toString(), bpm: entry.bpm })),
    events: events.map(event => ({ pitch: event.pitch, start: event.start.toString(), end: event.end.toString(), volume: event.volume })),
    findings,
  };
}

/**
 * The whole song: six tracks, the shared tempo map (the first non-empty
 * track's, as the Studio parser takes it) and the longest non-empty length.
 */
export function parseListenMml(raw) {
  const split = splitListenMml(raw);
  if (split.error) return { ok: false, error: split.error, tracks: [], tempo: [], total: '0', findings: [] };
  const tracks = split.tracks.map((track, index) => parseListenTrack(track, LISTEN_ROLES[index]));
  const active = tracks.filter(track => !track.empty);
  let total = '0';
  let longest = -1;
  for (const track of active) {
    const value = listenBeatNumber(track.total);
    if (value > longest) {
      longest = value;
      total = track.total;
    }
  }
  const tempo = active.length ? active[0].tempo : [];
  const findings = tracks.flatMap(track => track.findings);
  return { ok: active.length > 0, error: active.length ? null : '六軌皆空，無法建立預覽', tracks, tempo, total, findings };
}

// ─── timeline helpers (numbers; display and seeking only) ─────────────────

export const LISTEN_DEFAULT_BPM = 120;

/** Tempo map as numbers, sorted, later entry winning at an equal beat. */
export function listenTempoMap(tempo) {
  const map = [];
  for (const entry of Array.isArray(tempo) ? tempo : []) {
    const beat = typeof entry.beat === 'number' ? entry.beat : listenBeatNumber(entry.beat);
    const bpm = Number(entry.bpm);
    if (!Number.isFinite(beat) || beat < 0 || !Number.isFinite(bpm) || bpm <= 0) continue;
    if (map.length && Math.abs(map[map.length - 1].beat - beat) < 1e-9) map[map.length - 1] = { beat, bpm };
    else map.push({ beat, bpm });
  }
  map.sort((a, b) => a.beat - b.beat);
  if (!map.length || map[0].beat > 0) map.unshift({ beat: 0, bpm: map.length ? map[0].bpm : LISTEN_DEFAULT_BPM });
  return map;
}

export function listenSecondsAt(map, beat) {
  let seconds = 0;
  for (let index = 0; index < map.length; index++) {
    const start = map[index].beat;
    if (start >= beat) break;
    const end = index + 1 < map.length ? Math.min(beat, map[index + 1].beat) : beat;
    seconds += (end - start) * 60 / map[index].bpm;
  }
  return seconds;
}

export function listenBeatAt(map, seconds) {
  let remaining = Math.max(0, seconds);
  for (let index = 0; index < map.length; index++) {
    const start = map[index].beat;
    const next = index + 1 < map.length ? map[index + 1].beat : Infinity;
    const span = (next - start) * 60 / map[index].bpm;
    if (remaining <= span) return start + remaining * map[index].bpm / 60;
    remaining -= span;
  }
  return map.length ? map[map.length - 1].beat : 0;
}

/**
 * Bars for navigation from a source-stated meter map. Lenient on purpose: a
 * player must still seek when the meter does not tile the song, so a change
 * inside a bar starts a new bar there and the last bar may be partial. Never
 * invents a meter: without one the answer is null and the view shows beats.
 */
export function listenBars(meterText, totalBeats, { pickup = null } = {}) {
  if (typeof meterText !== 'string' || !meterText.trim() || !(totalBeats > 0)) return null;
  const meter = [];
  for (const line of meterText.split('\n').filter(entry => entry.trim())) {
    const match = /^\s*(\d+(?:\/\d+|\.\d+)?)\s+(\d+)\/(\d+)\s*$/.exec(line);
    if (!match) return null;
    const beat = match[1].includes('/') ? listenBeatNumber(match[1]) : Number(match[1]);
    const numerator = Number(match[2]);
    const denominator = Number(match[3]);
    if (!Number.isFinite(beat) || numerator < 1 || numerator > 255 || denominator < 1 || denominator > 128 || (denominator & (denominator - 1))) return null;
    meter.push({ beat, numerator, denominator });
  }
  if (!meter.length || meter[0].beat !== 0) return null;
  meter.sort((a, b) => a.beat - b.beat);
  const pickupBeats = pickup === null || pickup === undefined || pickup === '' ? null : Number(listenBeatNumber(pickup));
  const bars = [];
  let cursor = 0;
  let sigIndex = 0;
  const epsilon = 1e-9;
  while (cursor < totalBeats - epsilon && bars.length < 10000) {
    while (sigIndex + 1 < meter.length && meter[sigIndex + 1].beat <= cursor + epsilon) sigIndex++;
    const sig = meter[sigIndex];
    const full = sig.numerator * 4 / sig.denominator;
    let size = bars.length === 0 && pickupBeats > 0 && pickupBeats < full ? pickupBeats : full;
    if (sigIndex + 1 < meter.length && meter[sigIndex + 1].beat < cursor + size - epsilon) size = meter[sigIndex + 1].beat - cursor;
    if (size > totalBeats - cursor) size = totalBeats - cursor;
    bars.push({ index: bars.length + 1, start: cursor, end: cursor + size, numerator: sig.numerator, denominator: sig.denominator, partial: Math.abs(size - full) > epsilon });
    cursor += size;
  }
  return bars;
}

/** The bar containing a beat (1-based index), or null without bars. */
export function listenBarAt(bars, beat) {
  if (!Array.isArray(bars) || !bars.length) return null;
  let low = 0;
  let high = bars.length - 1;
  while (low < high) {
    const middle = (low + high + 1) >> 1;
    if (bars[middle].start <= beat + 1e-9) low = middle;
    else high = middle - 1;
  }
  return bars[low];
}
