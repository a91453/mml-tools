// Timed synth events for the timbre preview, built from the validated Final
// song (report.technical.song, computed in the Worker). Pure: no DOM, no audio.
//
// Time stays exact until the last step. Beats are integrated through the tempo
// map with BigInt rationals and only the resulting seconds become floats,
// because an AudioContext schedules in seconds.
//
// The volume → velocity curve and the role → channel mapping follow the
// repository owner's earlier frontend player. They describe this preview, not the
// game engine.
import { addBeat, cmpBeat, parseBeat } from '../roll-geometry.mjs';

const make = (n, d) => { const g = gcd(n, d); return { n: n / g, d: d / g }; };
function gcd(a, b) { a = a < 0n ? -a : a; b = b < 0n ? -b : b; while (b) [a, b] = [b, a % b]; return a || 1n; }
const sub = (a, b) => make(a.n * b.d - b.n * a.d, a.d * b.d);
const toSeconds = r => Number(r.n) / Number(r.d);

// v0–v15 → MIDI velocity 1–127 (owner's model: v0 is still a struck note).
export const velocityFor = volume => Math.max(1, Math.round((Number(volume) * 127) / 15));
// Six roles map to channels 0–5; channel 9 (GM percussion) is never used.
export const channelFor = role => (role < 9 ? role : role + 1);

// Beat → seconds through a tempo map [{ beat, bpm }], exact until returned.
export function tempoClock(tempo) {
  const points = [...(tempo?.length ? tempo : [{ beat: '0', bpm: 120 }])]
    .map(point => ({ beat: parseBeat(point.beat), bpm: BigInt(point.bpm) }))
    .sort((a, b) => cmpBeat(a.beat, b.beat));
  if (cmpBeat(points[0].beat, { n: 0n, d: 1n }) > 0) points.unshift({ beat: { n: 0n, d: 1n }, bpm: points[0].bpm });
  // Seconds elapsed at each tempo point, exact.
  const at = [{ n: 0n, d: 1n }];
  for (let i = 1; i < points.length; i++) {
    const span = sub(points[i].beat, points[i - 1].beat);
    at.push(addBeat(at[i - 1], make(span.n * 60n, span.d * points[i - 1].bpm)));
  }
  return beat => {
    const b = typeof beat === 'object' ? beat : parseBeat(beat);
    let i = points.length - 1;
    while (i > 0 && cmpBeat(points[i].beat, b) > 0) i--;
    const span = sub(b, points[i].beat);
    return toSeconds(addBeat(at[i], make(span.n * 60n, span.d * points[i].bpm)));
  };
}

/**
 * @param {{ tracks: Array<{ events: Array<{pitch:number,start:string,end:string,volume:number}> }>, tempo: Array<{beat:string,bpm:number}> }} song
 * @param {{ muted?: boolean[] }} options
 * @returns {{ events: Array<{ time:number, type:'on'|'off', role:number, channel:number, pitch:number, velocity?:number }>, duration:number }}
 */
export function buildSchedule(song, { muted = [] } = {}) {
  const seconds = tempoClock(song?.tempo);
  const events = [];
  let duration = 0;
  (song?.tracks ?? []).forEach((track, role) => {
    if (muted[role]) return;
    const channel = channelFor(role);
    for (const note of track.events ?? []) {
      const on = seconds(note.start);
      const off = seconds(note.end);
      events.push({ time: on, type: 'on', role, channel, pitch: note.pitch, velocity: velocityFor(note.volume ?? 8) });
      events.push({ time: off, type: 'off', role, channel, pitch: note.pitch });
      if (off > duration) duration = off;
    }
  });
  // At one instant a release goes before an attack, so a repeated pitch on
  // the same channel is re-struck instead of being cut by its own release.
  events.sort((a, b) => a.time - b.time || (a.type === b.type ? 0 : a.type === 'off' ? -1 : 1));
  return { events, duration };
}

// First event index at or after `time` (events are sorted by time).
export function indexAt(events, time) {
  let lo = 0, hi = events.length;
  while (lo < hi) { const mid = (lo + hi) >> 1; if (events[mid].time < time) lo = mid + 1; else hi = mid; }
  return lo;
}

// Notes already sounding at `time` when playback starts there: struck again at
// the start so a seek into a held note is heard.
export function soundingAt(events, time) {
  const open = new Map();
  for (const event of events) {
    if (event.time > time) break;
    const key = `${event.channel}:${event.pitch}`;
    if (event.type === 'on') open.set(key, event);
    else if (event.time <= time) open.delete(key);
  }
  return [...open.values()].filter(event => event.time < time);
}
