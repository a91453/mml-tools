// Listening timeline: bars, beats and seconds for a listening session, the
// seek maths behind "play from bar / time / marker", and the event-level diff
// behind "changed bars". Pure: no DOM, no audio, no backend import.
//
// Positions stay exact rationals (quarter beats, as in the MML parser and the
// listen-link contract) until they become seconds for the scheduler or pixels
// for the roll. Bars come from the session's meter text. Without one, 4/4 is
// used and the session says so: `assumed: true` is shown to the listener,
// because a 4/4 grid over a song in another meter puts every bar number in the
// wrong place.
import { addBeat, beatNumber, beatText, cmpBeat, parseBeat } from './roll-geometry.mjs';
import { tempoClock } from './preview/schedule.mjs';

export const LISTEN_ROLE_NAMES = Object.freeze(['Melody', 'Chord1', 'Chord2', 'Chord3', 'Chord4', 'Chord5']);
export const ASSUMED_METER_TEXT = '0 4/4';
export const MAX_BARS = 20000;

const ZERO = Object.freeze({ n: 0n, d: 1n });
const gcd = (a, b) => { a = a < 0n ? -a : a; b = b < 0n ? -b : b; while (b) [a, b] = [b, a % b]; return a || 1n; };
const make = (n, d) => { const g = gcd(n, d); return { n: n / g, d: d / g }; };
const sub = (a, b) => make(a.n * b.d - b.n * a.d, a.d * b.d);
const div = (a, b) => make(a.n * b.d, a.d * b.n);
const exact = value => (typeof value === 'object' ? value : parseBeat(String(value)));
const maxBeat = (a, b) => (cmpBeat(a, b) >= 0 ? a : b);

// "<beat> <n>/<d>" per line; beats may be integers, fractions or decimals.
export function parseMeterText(text) {
  if (typeof text !== 'string' || !text.trim()) return null;
  const meters = text.replace(/\r\n?/g, '\n').split('\n').map(line => line.trim()).filter(Boolean).map((line, index) => {
    const match = /^(\d+)(?:\/(\d+)|\.(\d+))?\s+(\d+)\/(\d+)$/.exec(line);
    if (!match) throw Error(`拍號圖第 ${index + 1} 行應為「起拍 拍號」`);
    const beat = match[3] !== undefined ? make(BigInt(match[1] + match[3]), 10n ** BigInt(match[3].length)) : make(BigInt(match[1]), BigInt(match[2] ?? '1'));
    const numerator = Number(match[4]), denominator = Number(match[5]);
    if (numerator < 1 || numerator > 255 || denominator < 1 || denominator > 128 || (denominator & (denominator - 1))) throw Error('拍號分母需為 1–128 的 2 次方，分子 1–255');
    return { beat, numerator, denominator };
  });
  if (cmpBeat(meters[0].beat, ZERO) !== 0) throw Error('拍號圖必須從第 0 拍開始');
  for (let i = 1; i < meters.length; i++) if (cmpBeat(meters[i].beat, meters[i - 1].beat) <= 0) throw Error('拍號位置必須依序且不可重複');
  return meters.map(m => ({ beat: beatText(m.beat), numerator: m.numerator, denominator: m.denominator }));
}

/**
 * Bars covering [0, end). A meter change always starts a bar, cutting the one
 * before it short, which is what the source's own barline says. The last bar
 * may be partial. There is always at least one bar.
 * @returns {{ bars: Array<{number:number,start:string,end:string,numerator:number,denominator:number,partial:boolean}>, meters: Array, assumed: boolean }}
 */
export function listenBars(meterText, endBeat) {
  const parsed = parseMeterText(meterText);
  const meters = parsed ?? parseMeterText(ASSUMED_METER_TEXT);
  const end = exact(endBeat ?? '0');
  const list = meters.map(m => ({ ...m, at: parseBeat(m.beat) }));
  const bars = [];
  let at = ZERO, index = 0;
  do {
    while (index + 1 < list.length && cmpBeat(list[index + 1].at, at) <= 0) index++;
    const meter = list[index];
    const full = make(4n * BigInt(meter.numerator), BigInt(meter.denominator));
    let next = addBeat(at, full);
    const upcoming = list[index + 1];
    if (upcoming && cmpBeat(upcoming.at, at) > 0 && cmpBeat(upcoming.at, next) < 0) next = upcoming.at;
    bars.push({ number: bars.length + 1, start: beatText(at), end: beatText(next), numerator: meter.numerator, denominator: meter.denominator, partial: cmpBeat(sub(next, at), full) !== 0 });
    at = next;
  } while (cmpBeat(at, end) < 0 && bars.length < MAX_BARS);
  return { bars, meters, assumed: !parsed };
}

// Index of the bar containing `beat`; past the end, the last bar.
export function barIndexAt(bars, beat) {
  const b = exact(beat);
  let lo = 0, hi = bars.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (cmpBeat(parseBeat(bars[mid].start), b) <= 0) lo = mid; else hi = mid - 1;
  }
  return lo;
}

// Beat-in-bar label, counted in the meter's own beat unit (a quarter in 4/4,
// an eighth in 6/8), 1-based, with any remainder kept exact: "3", "2+1/2".
export function beatInBarLabel(offset, denominator) {
  const q = div(exact(offset), make(4n, BigInt(denominator)));
  const whole = q.n / q.d;
  const rest = sub(q, { n: whole, d: 1n });
  return rest.n === 0n ? String(whole + 1n) : `${whole + 1n}+${beatText(rest)}`;
}

/** Where an exact beat falls: bar number, beat-in-bar label and offset. */
export function positionAt(bars, beat) {
  const b = exact(beat);
  const bar = bars[barIndexAt(bars, b)];
  const offset = sub(b, parseBeat(bar.start));
  return { bar: bar.number, beat: beatInBarLabel(cmpBeat(offset, ZERO) < 0 ? ZERO : offset, bar.denominator), offset: beatText(offset), exact: beatText(b) };
}

// The same, for a float beat reported while playing (display only).
export function positionAtNumber(bars, beat) {
  let lo = 0, hi = bars.length - 1;
  while (lo < hi) { const mid = (lo + hi + 1) >> 1; if (beatNumber(bars[mid].start) <= beat) lo = mid; else hi = mid - 1; }
  const bar = bars[lo];
  const unit = 4 / bar.denominator;
  return { bar: bar.number, beat: Math.floor(Math.max(0, beat - beatNumber(bar.start)) / unit + 1e-9) + 1 };
}

/**
 * A playing position (a float beat) as an exact position: the start of the
 * meter beat it falls in. This is how a listener says where something was
 * ("bar 23, beat 2"); the float itself never becomes a stored position.
 */
export function snapToMeterBeat(bars, beat) {
  const index = (() => { let lo = 0, hi = bars.length - 1; while (lo < hi) { const mid = (lo + hi + 1) >> 1; if (beatNumber(bars[mid].start) <= beat) lo = mid; else hi = mid - 1; } return lo; })();
  const bar = bars[index];
  const unit = make(4n, BigInt(bar.denominator));
  const start = parseBeat(bar.start), end = parseBeat(bar.end);
  const steps = Math.max(0, Math.floor((beat - beatNumber(start)) / beatNumber(unit) + 1e-9));
  let at = addBeat(start, make(unit.n * BigInt(steps), unit.d));
  if (cmpBeat(at, end) >= 0) at = start;
  return beatText(at);
}

/**
 * Beat ↔ seconds for one parsed song. Beat → seconds is exact until the
 * returned float (the scheduler's own tempoClock); seconds → beat is display
 * only and returns a float.
 */
export function songClock(song) {
  const tempo = song?.tempo?.length ? song.tempo : [{ beat: '0', bpm: 120 }];
  const secondsAt = tempoClock(tempo);
  const points = tempo.map(point => ({ at: parseBeat(String(point.beat)), bpm: Number(point.bpm) })).sort((a, b) => cmpBeat(a.at, b.at));
  if (cmpBeat(points[0].at, ZERO) > 0) points.unshift({ at: ZERO, bpm: points[0].bpm });
  const seconds = points.map(point => secondsAt(point.at));
  const beats = points.map(point => beatNumber(point.at));
  const beatAt = time => {
    let i = points.length - 1;
    while (i > 0 && seconds[i] > time) i--;
    return beats[i] + ((time - seconds[i]) * points[i].bpm) / 60;
  };
  return { secondsAt: beat => secondsAt(exact(beat)), beatAt, duration: secondsAt(exact(song?.total ?? '0')) };
}

// "m:ss.s" (or "h:mm:ss.s"); negative input reads as 0.
export function formatClock(seconds, digits = 1) {
  const value = Math.max(0, Number(seconds) || 0);
  const scale = 10 ** digits;
  const total = Math.floor(value * scale + 1e-6) / scale;
  const minutes = Math.floor(total / 60);
  const rest = total - minutes * 60;
  const [whole, fraction] = rest.toFixed(digits).split('.');
  const clock = `${String(whole).padStart(2, '0')}${digits ? `.${fraction}` : ''}`;
  return minutes >= 60 ? `${Math.floor(minutes / 60)}:${String(minutes % 60).padStart(2, '0')}:${clock}` : `${minutes}:${clock}`;
}

// "mm:ss", "m:ss.fff", "h:mm:ss" or plain seconds "75.5".
export function parseClock(text) {
  const value = String(text ?? '').trim();
  const match = /^(?:(?:(\d+):)?(\d+):)?(\d+(?:\.\d+)?)$/.exec(value);
  if (!match) throw Error('時間格式應為 分:秒（例如 1:23 或 1:23.5）');
  const [hours, minutes, seconds] = [Number(match[1] ?? 0), Number(match[2] ?? 0), Number(match[3])];
  if ((match[2] !== undefined && seconds >= 60) || (match[1] !== undefined && minutes >= 60)) throw Error('秒與分需小於 60');
  return hours * 3600 + minutes * 60 + seconds;
}

/** The exact start of bar `number` (1-based). */
export function barStart(bars, number) {
  if (!Number.isInteger(number) || number < 1 || number > bars.length) throw Error(`小節需為 1–${bars.length}`);
  return bars[number - 1].start;
}

/**
 * Where to start playing so that `beat` is heard after `preRollBars` whole
 * bars of lead-in: the start of the bar containing it, moved back that many
 * bars, never before beat 0. Always lands on a barline.
 */
export function preRollStart(bars, beat, preRollBars = 1) {
  const count = Math.max(0, Math.floor(Number(preRollBars) || 0));
  const index = Math.max(0, barIndexAt(bars, beat) - count);
  return bars[index].start;
}

/** A seek request in beats and seconds for one song clock. */
export function seekPlan({ bars, clock, beat, preRollBars = 0, untilBeat = null }) {
  const target = beatText(exact(beat));
  const from = preRollBars ? preRollStart(bars, target, preRollBars) : target;
  const fromSeconds = Math.min(clock.secondsAt(from), clock.duration);
  return {
    fromBeat: from, targetBeat: target, fromSeconds, targetSeconds: clock.secondsAt(target),
    untilBeat: untilBeat === null ? null : beatText(exact(untilBeat)),
    untilSeconds: untilBeat === null ? null : Math.min(clock.secondsAt(untilBeat), clock.duration),
  };
}

// ─── changed bars ───────────────────────────────────────────────────────────
const signature = event => `${event.start}|${event.end}|${event.pitch}|${event.volume ?? 8}`;
const byStart = (a, b) => cmpBeat(parseBeat(a.start), parseBeat(b.start)) || a.pitch - b.pitch || cmpBeat(parseBeat(a.end), parseBeat(b.end)) || (a.volume ?? 8) - (b.volume ?? 8);

// Multiset difference of exact events: what `a` has that `b` does not.
function missing(a, b) {
  const counts = new Map();
  for (const event of b) counts.set(signature(event), (counts.get(signature(event)) ?? 0) + 1);
  const out = [];
  for (const event of a) {
    const key = signature(event), left = counts.get(key) ?? 0;
    if (left > 0) counts.set(key, left - 1); else out.push(event);
  }
  return out;
}

/**
 * Event-level differences per role between two parsed songs (pitch, onset,
 * duration and volume, exact), plus tempo-map differences.
 * A removed and an added event with the same onset in one role pair up as one
 * modification, so a changed pitch reads as "changed", not as delete + insert.
 */
export function diffSongs(before, after) {
  const changes = [];
  for (let role = 0; role < 6; role++) {
    const old = [...(before?.tracks?.[role]?.events ?? [])].sort(byStart);
    const now = [...(after?.tracks?.[role]?.events ?? [])].sort(byStart);
    const removed = missing(old, now), added = missing(now, old);
    const addedByStart = new Map();
    for (const event of added) addedByStart.set(event.start, [...(addedByStart.get(event.start) ?? []), event]);
    for (const event of removed) {
      const partner = addedByStart.get(event.start)?.shift();
      if (partner) {
        const fields = ['pitch', 'end', 'volume'].filter(key => String(event[key] ?? 8) !== String(partner[key] ?? 8)).map(key => (key === 'end' ? 'duration' : key));
        changes.push({ role, type: 'modified', fields, before: event, after: partner, start: event.start, end: beatText(maxBeat(parseBeat(event.end), parseBeat(partner.end))) });
      } else changes.push({ role, type: 'removed', before: event, start: event.start, end: event.end });
    }
    for (const list of addedByStart.values()) for (const event of list) changes.push({ role, type: 'added', after: event, start: event.start, end: event.end });
  }
  const tempo = song => new Map((song?.tempo ?? []).map(point => [beatText(parseBeat(point.beat)), Number(point.bpm)]));
  const oldTempo = tempo(before), newTempo = tempo(after);
  for (const beat of new Set([...oldTempo.keys(), ...newTempo.keys()])) {
    if (oldTempo.get(beat) !== newTempo.get(beat)) changes.push({ role: null, type: 'tempo', start: beat, end: beat, before: oldTempo.get(beat) ?? null, after: newTempo.get(beat) ?? null });
  }
  return changes.sort((a, b) => cmpBeat(parseBeat(a.start), parseBeat(b.start)) || (a.role ?? -1) - (b.role ?? -1));
}

/**
 * The bars touched by a set of changes, in order. A note change touches every
 * bar its old or new extent overlaps; a tempo change touches the bar it is in.
 */
export function changedBars(changes, bars) {
  const touched = new Map();
  const touch = (index, change) => {
    const bar = bars[index];
    if (!touched.has(index)) touched.set(index, { number: bar.number, start: bar.start, end: bar.end, roles: new Set(), counts: { added: 0, removed: 0, modified: 0, tempo: 0 }, changes: [] });
    const entry = touched.get(index);
    if (change.role !== null) entry.roles.add(change.role);
    entry.counts[change.type] += 1;
    entry.changes.push(change);
  };
  for (const change of changes) {
    const first = barIndexAt(bars, change.start);
    if (change.type === 'tempo') { touch(first, change); continue; }
    const end = parseBeat(change.end);
    for (let index = first; index < bars.length && cmpBeat(parseBeat(bars[index].start), end) < 0; index++) touch(index, change);
  }
  return [...touched.entries()].sort((a, b) => a[0] - b[0]).map(([, entry]) => ({
    ...entry, roles: [...entry.roles].sort((a, b) => a - b).map(role => LISTEN_ROLE_NAMES[role]),
  }));
}

/** Consecutive changed bars merged into regions, for "play changed bars only". */
export function changedRegions(barsChanged) {
  const regions = [];
  for (const bar of barsChanged) {
    const last = regions.at(-1);
    if (last && last.toBar + 1 === bar.number) { last.toBar = bar.number; last.end = bar.end; for (const role of bar.roles) if (!last.roles.includes(role)) last.roles.push(role); }
    else regions.push({ fromBar: bar.number, toBar: bar.number, start: bar.start, end: bar.end, roles: [...bar.roles] });
  }
  return regions;
}

/**
 * The playback plan for "play changed bars only": each region in order, with
 * `preRollBars` bars of lead-in, ending at the region's end. Overlapping
 * lead-ins are kept as they are, so each region is heard with its own lead-in.
 */
export function changedPlaybackPlan({ regions, bars, clock, preRollBars = 1 }) {
  return regions.map(region => ({ region, ...seekPlan({ bars, clock, beat: region.start, preRollBars, untilBeat: region.end }) }));
}

/** The review-roll projection for a parsed listening song. */
export function rollProjection(song, meters) {
  let end = ZERO;
  const lanes = LISTEN_ROLE_NAMES.map((role, index) => ({
    role,
    events: (song?.tracks?.[index]?.events ?? []).map((event, i) => {
      const finish = parseBeat(event.end);
      if (cmpBeat(finish, end) > 0) end = finish;
      return { id: `${role}#${i + 1}`, pitch: event.pitch, start: event.start, end: event.end };
    }),
  }));
  const total = song?.total ? maxBeat(parseBeat(song.total), end) : end;
  return { lanes, unassigned: [], meters: meters.map(m => ({ beat: m.beat, numerator: m.numerator, denominator: m.denominator })), end: beatText(total), signals: [] };
}

// Largest end of two songs, for a bar grid that covers both.
export function songsEnd(...songs) {
  let end = ZERO;
  for (const song of songs) if (song?.total) end = maxBeat(end, parseBeat(song.total));
  return beatText(end);
}
