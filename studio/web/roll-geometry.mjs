// Pure geometry for the Studio review roll (review-roll.mjs). No DOM.
//
// Viewport, zoom and gesture math ported from the owner's MML 工房
// `pianoroll.js` / `config.js` (frontend capture f1b7024f…baad9a, owner
// authorization 2026-09-23). Where the two models disagree, Studio's wins:
//
//   * MML 工房 stores time as integer ticks (PPQ 480) on a 1/32 grid. Studio's
//     data is exact rational beats, so nothing here snaps or rounds data. A beat
//     becomes a float only at the last step, a pixel coordinate, and a pixel
//     never flows back: a click resolves to an event ID, never to a time.
//   * Bar lines come from the source meter map with exact BigInt arithmetic, so
//     a 3/8 or 7/16 bar never drifts after hundreds of bars. With no meter map
//     the roll draws beats only and says so; it never assumes 4/4.
//   * The pitch axis spans the song's own range. Nothing is folded into a
//     keyboard range; a pitch outside 0–107 stays where it is and is flagged.
//
// Kept from MML 工房: discrete zoom steps with an anchor measured in content
// units (so repeated zooming never drifts), the one-axis pinch decision, the
// pinch step ratio, wheel normalisation, and grid thinning by line spacing.

export const GUTTER_W = 46;
export const RULER_H = 22;
// Pixels per quarter beat / per pitch row. Every step is an integer, so sub-beat
// lines land on whole pixels at the finer zoom levels.
export const ZOOM_W = Object.freeze([12, 16, 24, 32, 48, 64, 96, 128, 192, 256]);
export const ZOOM_H = Object.freeze([4, 6, 8, 12, 16, 24]);
export const DEFAULT_ZOOM = Object.freeze({ w: 48, h: 8 });
export const PINCH_SLOP = 12;
export const PINCH_SPAN = 40;
export const PINCH_STEP = 1.35;
export const TAP_SLOP = 8;
export const HIT_RADIUS = 10;
export const WHEEL_STEP = 100;
export const PAD_BEATS = 8;
export const OFFICIAL_PITCH_MAX = 107;

export const ROLL_ROLES = Object.freeze(['Melody', 'Chord1', 'Chord2', 'Chord3', 'Chord4', 'Chord5']);
export const laneTier = index => (index < 3 ? 'core' : index < 6 ? 'enrichment' : 'unassigned');

// ─── exact beats ────────────────────────────────────────────────────────────
const gcd = (a, b) => { a = a < 0n ? -a : a; b = b < 0n ? -b : b; while (b) [a, b] = [b, a % b]; return a || 1n; };
export function parseBeat(value) {
  const text = String(value);
  const match = /^(-?\d+)(?:\/(\d+))?$/.exec(text);
  if (!match) throw Error(`not an exact beat: ${text}`);
  const n = BigInt(match[1]);
  const d = BigInt(match[2] ?? '1');
  if (d === 0n) throw Error(`not an exact beat: ${text}`);
  const g = gcd(n, d);
  return { n: n / g, d: d / g };
}
const make = (n, d) => { const g = gcd(n, d); return { n: n / g, d: d / g }; };
export const addBeat = (a, b) => make(a.n * b.d + b.n * a.d, a.d * b.d);
export const cmpBeat = (a, b) => { const x = a.n * b.d - b.n * a.d; return x < 0n ? -1 : x > 0n ? 1 : 0; };
export const beatText = b => (b.d === 1n ? String(b.n) : `${b.n}/${b.d}`);
// Display only. The float never leaves the drawing code.
export const beatNumber = value => {
  if (typeof value === 'number') return value;
  const b = typeof value === 'object' ? value : parseBeat(value);
  return Number(b.n) / Number(b.d);
};

// Bar starts from the meter map. A meter change starts a bar even when the
// previous bar is cut short, which is what the source's own barline says.
export function barStarts(meters, endBeat, { padBeats = PAD_BEATS, maxBars = 20000 } = {}) {
  const sorted = [...(meters ?? [])]
    .map(m => ({ beat: parseBeat(m.beat), numerator: m.numerator, denominator: m.denominator }))
    .sort((a, b) => cmpBeat(a.beat, b.beat));
  if (!sorted.length) return [];
  const limit = addBeat(parseBeat(endBeat), { n: BigInt(padBeats), d: 1n });
  const bars = [];
  let meterIndex = 0;
  let at = sorted[0].beat;
  while (bars.length < maxBars && cmpBeat(at, limit) <= 0) {
    while (meterIndex + 1 < sorted.length && cmpBeat(sorted[meterIndex + 1].beat, at) <= 0) meterIndex++;
    const meter = sorted[meterIndex];
    bars.push({ index: bars.length, beat: beatText(at), numerator: meter.numerator, denominator: meter.denominator, changed: bars.length === 0 || cmpBeat(meter.beat, at) === 0 });
    let next = addBeat(at, make(4n * BigInt(meter.numerator), BigInt(meter.denominator)));
    const upcoming = sorted[meterIndex + 1];
    if (upcoming && cmpBeat(upcoming.beat, at) > 0 && cmpBeat(upcoming.beat, next) < 0) next = upcoming.beat;
    at = next;
  }
  return bars;
}

// ─── zoom ───────────────────────────────────────────────────────────────────
export const zoomStep = (steps, current, dir) => {
  const i = steps.indexOf(current);
  if (i < 0) return null;
  const n = i + dir;
  return n >= 0 && n < steps.length ? steps[n] : null;
};
// Keep the content under the anchor in place, measured in beats/rows rather
// than pixels so that a dozen zoom steps do not accumulate drift.
export const zoomScroll = (scroll, anchor, oldSize, newSize) => Math.max(0, ((scroll + anchor) / oldSize) * newSize - anchor);
export function pinchAxis(span, span0, dPan) {
  const dx = span0.x >= PINCH_SPAN ? Math.abs(span.x - span0.x) : 0;
  const dy = span0.y >= PINCH_SPAN ? Math.abs(span.y - span0.y) : 0;
  const dSpan = Math.max(dx, dy);
  if (dSpan < PINCH_SLOP || dSpan <= dPan) return null;
  return dx >= dy ? 'w' : 'h';
}
export const zoomTick = (current, reference) => (current / reference >= PINCH_STEP ? 1 : current / reference <= 1 / PINCH_STEP ? -1 : 0);
export const wheelPixels = (deltaY, deltaMode, pageHeight) => (deltaMode === 1 ? deltaY * 16 : deltaMode === 2 ? deltaY * pageHeight : deltaY);
// Sub-beat grid density by line spacing, never by note value: each level keeps
// lines 12px or more apart.
export function beatDivisions(pxPerBeat) {
  let divisions = 1;
  while (divisions < 16 && pxPerBeat / (divisions * 2) >= 12) divisions *= 2;
  return divisions;
}

// ─── projection ─────────────────────────────────────────────────────────────
export function pitchSpan(projection) {
  let lo = Infinity, hi = -Infinity;
  for (const lane of [...projection.lanes.map(l => l.events), projection.unassigned]) {
    for (const e of lane) { if (e.pitch < lo) lo = e.pitch; if (e.pitch > hi) hi = e.pitch; }
  }
  if (lo === Infinity) return { low: 48, high: 84 };
  return { low: Math.max(0, lo - 3), high: Math.min(127, hi + 3) };
}

// A view is { pxPerBeat, rowH, scrollX, scrollY, width, height, low, high }.
export const beatToX = (view, beat) => GUTTER_W + beatNumber(beat) * view.pxPerBeat - view.scrollX;
// Events prepared by prepareProjection() carry display numbers `s`/`f`.
const startOf = event => event.s ?? beatNumber(event.start);
const finishOf = event => event.f ?? beatNumber(event.end);
export const pitchToY = (view, pitch) => RULER_H + (view.high - pitch) * view.rowH - view.scrollY;
export const contentSize = (view, endBeat) => ({
  width: GUTTER_W + (beatNumber(endBeat) + PAD_BEATS) * view.pxPerBeat,
  height: RULER_H + (view.high - view.low + 1) * view.rowH,
});
export function visibleBeats(view) {
  const from = Math.max(0, (view.scrollX) / view.pxPerBeat - 1);
  const to = (view.scrollX + view.width - GUTTER_W) / view.pxPerBeat + 1;
  return { from, to };
}

// Attach display numbers once, so painting never re-parses exact beats. The
// exact strings stay on each event for anything that is reported back.
export function prepareProjection(projection) {
  const prep = e => ({ ...e, s: beatNumber(e.start), f: beatNumber(e.end) });
  return {
    ...projection,
    lanes: projection.lanes.map(l => ({ ...l, events: l.events.map(prep) })),
    unassigned: projection.unassigned.map(prep),
    signals: projection.signals.map(signal => ({ ...signal, s: beatNumber(signal.start), f: beatNumber(signal.end) })),
  };
}

// Every drawable event with its lane index; lane 6 is unassigned material.
export function* eachEvent(projection, visible = null) {
  const lanes = [...projection.lanes.map(l => l.events), projection.unassigned];
  for (let lane = 0; lane < lanes.length; lane++) {
    if (visible && !visible[lane]) continue;
    for (const event of lanes[lane]) yield { lane, event };
  }
}

// Hit test in screen space. Returns an event ID (and its lane), never a time.
// A direct hit wins; otherwise the nearest note whose row centre is within
// `radius` pixels, which is what makes a fingertip usable on 6px rows.
export function hitTest(projection, view, x, y, { visible = null, radius = 0 } = {}) {
  let best = null;
  let bestDistance = Infinity;
  if (x < GUTTER_W || y < RULER_H) return null;
  for (const { lane, event } of eachEvent(projection, visible)) {
    const x0 = beatToX(view, startOf(event));
    const x1 = Math.max(x0 + 2, beatToX(view, finishOf(event)));
    const top = pitchToY(view, event.pitch);
    const inside = x >= x0 && x <= x1 && y >= top && y < top + view.rowH;
    if (inside) return { id: event.id, lane };
    if (!radius) continue;
    const dx = x < x0 ? x0 - x : x > x1 ? x - x1 : 0;
    const dy = Math.abs(y - (top + view.rowH / 2));
    const distance = Math.hypot(dx, dy);
    if (distance <= radius && distance < bestDistance) { best = { id: event.id, lane }; bestDistance = distance; }
  }
  return best;
}

const NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
// MIDI pitch name with MIDI 60 = C4. A display label, not a claim about how the
// game spells octaves (MOBILE_SYNTAX §6 keeps the O-token mapping open).
export const pitchName = pitch => `${NAMES[pitch % 12]}${Math.floor(pitch / 12) - 1}`;
export const isBlackKey = pitch => [1, 3, 6, 8, 10].includes(pitch % 12);
