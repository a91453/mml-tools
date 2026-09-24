// Player readback (Gate 6): what the preview engine actually processed,
// compared with the exact applied MML. Pure: no DOM, no audio.
//
// A capture lists the note and program events the SpessaSynth worklet reported
// as processed, each stamped with the worklet's own audio clock. It is compared
// with an independent reading of the exact MML string: the Worker parses that
// string again at every analysis, and the expected events are derived here
// without any of the preview scheduler's code (schedule.mjs, which this module
// must never import), so a scheduling fault shows up as a mismatch instead of
// agreeing with itself:
//
//   * beat → seconds is this module's own exact integration over the tempo
//     map (BigInt rationals, one sweep through the tempo map in beat order);
//   * role → channel is restated from its definition below;
//   * volume → velocity is the backend renderer's curve
//     (studio/backend/audio/instruments.mjs), not the scheduler's copy.
//
// Order, pitch and velocity are compared exactly, per channel. Timing is
// compared within TIMING_TOLERANCE_SEC of the exact tempo-map time, because
// the engine works in audio render quanta, not in beats.
//
// Scope: processed engine events, not hardware audio. A capture says nothing
// about the game's timbre, the original recording or in-game behaviour.
import { velocityForVolume } from '../../backend/audio/instruments.mjs';

export const READBACK_KIND = 'studio-preview-readback';
export const READBACK_SCOPE = 'processed_engine_events_not_hardware_audio';
export const TIMING_TOLERANCE_SEC = 0.025;
export const MAX_CAPTURED_EVENTS = 100000;
const MAX_REPORTED_ERRORS = 12;

// ─── the expected side, independent of schedule.mjs ──────────────────────────
// The tempo assumed when a song has no tempo map (t120, as the backend
// prescreen assumes too), and the parser's volume before any `v` command.
const DEFAULT_BPM = 120;
const DEFAULT_VOLUME = 8;

// Role → channel. The six roles, in their Canonical order (Melody, Chord1 …
// Chord5), take the melodic General MIDI channels in order; channel index 9 is
// GM percussion and is never one of them. The backend renderer and the core
// MIDI writer place a pitched role on its channel the same way (role i on
// channel i for the six roles).
const GM_PERCUSSION_CHANNEL = 9;
const MELODIC_CHANNELS = Object.freeze(Array.from({ length: 16 }, (_, channel) => channel).filter(channel => channel !== GM_PERCUSSION_CHANNEL));
function channelOfRole(role) {
  const channel = MELODIC_CHANNELS[role];
  if (channel === undefined) throw Error(`no melodic MIDI channel for role ${role}`);
  return channel;
}

// Exact rationals as [numerator, denominator] BigInt pairs, denominator > 0,
// in lowest terms.
const gcdOf = (a, b) => { a = a < 0n ? -a : a; b = b < 0n ? -b : b; while (b) [a, b] = [b, a % b]; return a || 1n; };
function ratio(n, d) {
  if (d === 0n) throw Error('zero denominator');
  if (d < 0n) { n = -n; d = -d; }
  const g = gcdOf(n, d);
  return [n / g, d / g];
}
const plus = ([a, b], [c, d]) => ratio(a * d + c * b, b * d);
const minus = ([a, b], [c, d]) => ratio(a * d - c * b, b * d);
const order = ([a, b], [c, d]) => { const x = a * d - c * b; return x < 0n ? -1 : x > 0n ? 1 : 0; };
// Seconds spent crossing `beats` quarter notes at `bpm`.
const crossing = ([n, d], bpm) => ratio(n * 60n, d * BigInt(bpm));

function exactBeat(value) {
  const match = /^(-?\d+)(?:\/(\d+))?$/.exec(String(value));
  if (!match) throw Error(`not an exact beat: ${String(value).slice(0, 40)}`);
  return ratio(BigInt(match[1]), BigInt(match[2] ?? '1'));
}

// Exact seconds → the nearest double. One correctly rounded division while
// both terms are exact doubles; beyond that, 64 significant bits of the
// quotient are kept before the final rounding.
const SAFE = 2n ** 53n;
const bitLength = value => value.toString(2).length;
function toSeconds([n, d]) {
  const size = n < 0n ? -n : n;
  if (size <= SAFE && d <= SAFE) return Number(n) / Number(d);
  const shift = 64 - bitLength(size) + bitLength(d);
  const quotient = shift >= 0 ? (size << BigInt(shift)) / d : size / (d << BigInt(-shift));
  return (n < 0n ? -1 : 1) * (Number(quotient) / 2 ** shift);
}

// The time of each beat in `beats` (beat texts, any order), keyed by that
// text: its seconds, and its rank in time order (equal beats share a rank).
// The beats are visited in ascending order while the tempo map is walked once
// alongside them, adding each whole tempo segment passed and then the part of
// the current one up to the beat. The first tempo holds from beat 0 even when
// the map's first point is later; a beat before 0 is extrapolated at the first
// tempo.
function timesOfBeats(tempo, beats) {
  const points = (Array.isArray(tempo) && tempo.length ? tempo : [{ beat: '0', bpm: DEFAULT_BPM }]).map(point => {
    if (!Number.isInteger(point?.bpm) || point.bpm <= 0) throw Error(`tempo map point without a positive whole BPM: ${String(point?.bpm).slice(0, 20)}`);
    return { from: exactBeat(point.beat), bpm: point.bpm };
  });
  points.sort((a, b) => order(a.from, b.from));
  const segments = order(points[0].from, [0n, 1n]) > 0 ? [{ from: [0n, 1n], bpm: points[0].bpm }, ...points] : points;
  const visits = [...new Set(beats)].map(text => [text, exactBeat(text)]).sort((a, b) => order(a[1], b[1]));
  const out = new Map();
  let index = 0, elapsed = [0n, 1n], rank = -1, previous = null;
  for (const [text, beat] of visits) {
    while (index + 1 < segments.length && order(segments[index + 1].from, beat) <= 0) {
      elapsed = plus(elapsed, crossing(minus(segments[index + 1].from, segments[index].from), segments[index].bpm));
      index++;
    }
    if (!previous || order(previous, beat) < 0) rank++;
    previous = beat;
    // Left unreduced: it only becomes a float, and its value is the same.
    const [a, b] = elapsed, [c, d] = crossing(minus(beat, segments[index].from), segments[index].bpm);
    out.set(text, { rank, seconds: toSeconds([a * d + c * b, b * d]) });
  }
  return out;
}

// Per channel, the note events the exact song asks for, in the order an
// engine must process them: by time, and a release before an attack at the
// same instant (a repeated pitch is re-struck, not cut by its own release).
export function expectedEvents(song) {
  const tracks = song?.tracks ?? [];
  const beats = tracks.flatMap(track => (track.events ?? []).flatMap(note => [String(note.start), String(note.end)]));
  const clock = timesOfBeats(song?.tempo, beats);
  const at = beat => clock.get(String(beat));
  const channels = new Map();
  tracks.forEach((track, role) => {
    const list = [];
    for (const note of track.events ?? []) {
      const on = at(note.start), off = at(note.end);
      list.push({ rank: on.rank, time: on.seconds, on: true, pitch: note.pitch, velocity: velocityForVolume(note.volume ?? DEFAULT_VOLUME) });
      list.push({ rank: off.rank, time: off.seconds, on: false, pitch: note.pitch });
    }
    // Ordered on exact time (a beat's rank); the float is only the label
    // compared with the engine's clock.
    list.sort((a, b) => a.rank - b.rank || Number(a.on) - Number(b.on));
    if (list.length) channels.set(channelOfRole(role), list.map(({ rank, ...event }) => event));
  });
  return channels;
}

const finite = value => typeof value === 'number' && Number.isFinite(value);
const int = (value, min, max) => Number.isInteger(value) && value >= min && value <= max;
const short = (value, max) => typeof value === 'string' && value.length <= max;

// Shape check for a capture coming from the page or from storage. Returns a
// clean copy with only the known fields, or throws naming what is wrong.
export function normalizeCapture(input) {
  if (!input || input.kind !== READBACK_KIND) throw Error('not a player readback capture');
  if (input.scope !== READBACK_SCOPE || input.gameTimbreEquivalent !== false) throw Error('capture scope is not processed engine events');
  if (input.timeSource !== 'engine') throw Error('capture timing is not from the engine clock');
  if (!short(input.sessionId, 100) || !input.sessionId) throw Error('capture session id missing');
  if (!short(input.capturedAt, 40) || Number.isNaN(Date.parse(input.capturedAt))) throw Error('capture time missing');
  if (!short(input.bank?.name, 300) || !/^[0-9a-f]{64}$/.test(input.bank?.sha256 ?? '')) throw Error('capture bank identity missing');
  if (!short(input.engine?.lib, 40) || !short(input.engine?.core, 40)) throw Error('capture engine version missing');
  if (!int(input.program?.program, 0, 127) || !int(input.program?.bankMSB, 0, 16383) || !short(input.program?.name, 200)) throw Error('capture program missing');
  if (!Array.isArray(input.muted) || input.muted.length !== 6 || !input.muted.every(value => typeof value === 'boolean')) throw Error('capture mute state missing');
  if (typeof input.complete !== 'boolean' || !Array.isArray(input.incomplete) || !input.incomplete.every(reason => short(reason, 80))) throw Error('capture coverage missing');
  if (!finite(input.from) || !finite(input.duration) || input.duration < 0) throw Error('capture range missing');
  if (!Array.isArray(input.events) || input.events.length > MAX_CAPTURED_EVENTS) throw Error('capture events missing or too many');
  for (const event of input.events) {
    if (!Array.isArray(event) || event.length !== 5 || !finite(event[0]) || ![0, 1].includes(event[1]) || !int(event[2], 0, 15) || !int(event[3], 0, 127) || !int(event[4], 0, 127)) throw Error('capture event malformed');
  }
  if (!Array.isArray(input.programs) || input.programs.length > 1000) throw Error('capture program changes missing');
  for (const change of input.programs) {
    if (!Array.isArray(change) || change.length !== 4 || !finite(change[0]) || !int(change[1], 0, 15) || !int(change[2], 0, 127) || !int(change[3], 0, 16383)) throw Error('capture program change malformed');
  }
  return {
    kind: READBACK_KIND, scope: READBACK_SCOPE, gameTimbreEquivalent: false, timeSource: 'engine',
    sessionId: input.sessionId, capturedAt: input.capturedAt,
    bank: { name: input.bank.name, sha256: input.bank.sha256 },
    engine: { lib: input.engine.lib, core: input.engine.core },
    program: { program: input.program.program, bankMSB: input.program.bankMSB, name: input.program.name },
    audioContextState: short(input.audioContextState, 20) ? input.audioContextState : 'unknown',
    muted: [...input.muted], complete: input.complete, incomplete: [...input.incomplete],
    from: input.from, duration: input.duration,
    events: input.events.map(event => [...event]), programs: input.programs.map(change => [...change]),
  };
}

// The verdict: does what the engine processed equal what the exact MML says?
// Never trusts a stored verdict; it is recomputed from the events every time.
export function compareReadback(song, capture) {
  const errors = [];
  const note = message => { if (errors.length < MAX_REPORTED_ERRORS) errors.push(message); };
  if (!capture.complete) note(`CAPTURE_INCOMPLETE: ${capture.incomplete.join(', ') || 'unknown'}`);
  if (capture.from !== 0) note('CAPTURE_NOT_FROM_START');
  if (capture.muted.some(Boolean)) note('ROLE_MUTED_DURING_CAPTURE');

  const expected = expectedEvents(song);
  const processed = new Map();
  for (const [time, on, channel, pitch, velocity] of capture.events) {
    if (!processed.has(channel)) processed.set(channel, []);
    processed.get(channel).push({ time, on: on === 1, pitch, velocity });
  }
  // The instrument must be loaded on every sounding channel before its first
  // note, and must not change once the song has started.
  let firstNote = Infinity;
  for (const event of capture.events) if (event[1] === 1 && event[0] < firstNote) firstNote = event[0];
  if (capture.programs.some(([time]) => time >= firstNote)) note('PROGRAM_CHANGED_DURING_CAPTURE');
  for (const channel of expected.keys()) {
    const loaded = capture.programs.filter(([time, ch]) => ch === channel && time < firstNote).at(-1);
    if (!loaded) note(`CHANNEL_${channel}_PROGRAM_NOT_LOADED`);
    else if (loaded[2] !== capture.program.program || loaded[3] !== capture.program.bankMSB) note(`CHANNEL_${channel}_PROGRAM_MISMATCH`);
  }

  let maxDrift = 0, expectedNotes = 0, processedNotes = 0;
  const channels = [...new Set([...expected.keys(), ...processed.keys()])].sort((a, b) => a - b);
  for (const channel of channels) {
    const want = expected.get(channel) ?? [];
    const got = processed.get(channel) ?? [];
    expectedNotes += want.filter(event => event.on).length;
    processedNotes += got.filter(event => event.on).length;
    if (want.length !== got.length) note(`CHANNEL_${channel}_EVENT_COUNT: expected ${want.length}, processed ${got.length}`);
    for (let i = 0; i < Math.min(want.length, got.length); i++) {
      const a = want[i], b = got[i];
      if (a.on !== b.on || a.pitch !== b.pitch || (a.on && a.velocity !== b.velocity)) {
        note(`CHANNEL_${channel}_EVENT_${i}: expected ${a.on ? 'on' : 'off'} ${a.pitch}${a.on ? ` v${a.velocity}` : ''}, processed ${b.on ? 'on' : 'off'} ${b.pitch}${b.on ? ` v${b.velocity}` : ''}`);
        break;
      }
      const drift = Math.abs(b.time - a.time);
      if (drift > maxDrift) maxDrift = drift;
      if (drift > TIMING_TOLERANCE_SEC) {
        note(`CHANNEL_${channel}_EVENT_${i}_LATE: ${Math.round(drift * 1000)} ms from the tempo-map time`);
        break;
      }
    }
  }
  return { ok: errors.length === 0, errors, expectedNotes, processedNotes, maxDriftMs: Math.round(maxDrift * 1000), toleranceMs: TIMING_TOLERANCE_SEC * 1000 };
}
