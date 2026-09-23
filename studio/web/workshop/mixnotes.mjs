// Studio Workshop — ported from the owner's earlier frontend (owner-authorized port).
// Flattens a parsed song into sample-accurate note events.
// Workshop edits sit outside the Canonical/verified pipeline and are never evidence.
import { chanOf, GAME_TRACKS } from "./config.mjs";
import { isKit, soundingKey } from "./instruments.mjs";

export const TAIL_SEC = 3;

export const EV_STRIDE = 4;

export const VEL_OFF = -1;

export const MIN_DUR = 0.001;

// Only the six game tracks are rendered, as in the game.
export function notedTracks(song) {
  const out = [];
  song.tracks.slice(0, GAME_TRACKS).forEach((tr, i) => { if (tr.notes.length) out.push(i); });
  return out;
}

export function droppedTracks(song) {
  return song.tracks.slice(GAME_TRACKS)
    .map((tr, i) => (tr.notes.length ? GAME_TRACKS + i + 1 : 0))
    .filter(Boolean);
}

// presets: per-track [msb, lsb, program, mobileId?] (tracks.presetOf).
export function buildSetup(presets) {
  const out = [];
  presets.slice(0, GAME_TRACKS).forEach((p, i) => {
    if (!p) return;
    out.push({ ch: chanOf(i), msb: p[0], lsb: p[1], prog: p[2], drum: isKit(p) });
  });
  return out;
}

// Note-off sorts before note-on in the same frame. A percussion instrument's
// notes are mapped to its kit keys before they reach the synthesizer.
export function buildEvents(song, { sampleRate = 44100, tailSec = TAIL_SEC, presets = [] } = {}) {
  const raw = [];
  song.tracks.slice(0, GAME_TRACKS).forEach((tr, i) => {
    const ch = chanOf(i);
    const preset = presets[i] ?? null;
    for (const n of tr.notes) {
      if (n.dur < MIN_DUR) continue;
      const key = soundingKey(preset, n.midi);
      raw.push({ frame: Math.round(n.start * sampleRate), ch, midi: key, vel: n.vel });
      raw.push({ frame: Math.round((n.start + n.dur) * sampleRate), ch, midi: key, vel: VEL_OFF });
    }
  });
  raw.sort((a, b) => a.frame - b.frame || (a.vel < 0 ? 0 : 1) - (b.vel < 0 ? 0 : 1));
  const events = new Int32Array(raw.length * EV_STRIDE);
  raw.forEach((e, i) => {
    const o = i * EV_STRIDE;
    events[o] = e.frame;
    events[o + 1] = e.ch;
    events[o + 2] = e.midi;
    events[o + 3] = e.vel;
  });
  return {
    events,
    count: raw.length,
    totalFrames: Math.ceil((song.duration + tailSec) * sampleRate),
  };
}
