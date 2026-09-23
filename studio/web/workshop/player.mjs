// Studio Workshop — ported from the owner's earlier frontend (owner-authorized port).
// Look-ahead playback scheduler.
// Workshop edits sit outside the Canonical/verified pipeline and are never evidence.
import * as engine from "./engine.mjs";
import { chanOf } from "./config.mjs";

const LEAD    = 0.3;
const TICK_MS = 25;
const LATENCY = 0.12;

let song = null, startAt = 0, cursor = [], timer = null, playing = false, paused = false;

let fromSec = 0, toSec = Infinity;

let looping = false;

let loops = 0;

export const setLoop = on => { looping = !!on; };
export const isLooping = () => looping;

const spanSec = () =>
  Math.max(0, (Number.isFinite(toSec) ? toSec : (song ? song.duration : 0)) - fromSec);

let drainAt = 0;

let onStop = () => {};
export const setStopHandler = fn => { onStop = fn; };

// Per-track key mapping: a percussion instrument sounds a kit key, not the
// written pitch (instruments.soundingKey). Identity unless the page sets one.
let keyFor = (track, midi) => midi;
export const setKeyMapper = fn => { keyFor = fn ?? ((track, midi) => midi); };

export const isPlaying = () => playing;
export const isPaused = () => paused;

export const state = () => ({ song, startAt, playing, paused, fromSec, toSec });

export function start(parsed, range = null) {
  stop();
  engine.resume();
  engine.unmute();
  song = parsed;
  fromSec = Math.max(0, range?.fromSec ?? 0);
  toSec = range?.toSec ?? Infinity;
  const wait = Math.min(Math.max(0, drainAt - engine.now()), LEAD);
  startAt = engine.now() + Math.max(LATENCY, wait);
  cursor = song.tracks.map(() => 0);
  loops = 0;
  playing = true;
  paused = false;
  timer = setInterval(tick, TICK_MS);
  tick();
  return startAt;
}

export function pause() {
  if (!playing || paused) return;
  paused = true;
  clearInterval(timer); timer = null;
  engine.suspend();
}

export function resume() {
  if (!playing || !paused) return;
  paused = false;
  engine.resume();
  timer = setInterval(tick, TICK_MS);
  tick();
}

const at = sec => startAt + sec - fromSec;

export function positionSec() {
  if (!playing || !song) return null;
  const span = spanSec();
  let elapsed = engine.now() - startAt;
  if (elapsed < 0) elapsed = loops > 0 && span > 0 ? elapsed % span + span : 0;
  return elapsed + fromSec;
}

function resyncCursor() {
  const horizon = engine.now() + LEAD;
  cursor = song.tracks.map(tr => {
    let i = 0;
    while (i < tr.notes.length && at(tr.notes[i].start) < horizon) i++;
    return i;
  });
}

export function setRange(range = null, { toStart = false } = {}) {
  if (!playing || !song) return null;
  const from = Math.max(0, range?.fromSec ?? 0);
  const to = range?.toSec ?? Infinity;
  if (!toStart && from === fromSec && to === toSec) return null;

  const pos = positionSec();
  const prevFrom = fromSec;
  fromSec = from;
  toSec = to;

  if (!toStart && pos >= from && pos < to) {
    startAt += from - prevFrom;
    resyncCursor();
    return "keep";
  }

  seek(from);
  cursor.fill(0);
  loops = 0;
  if (!paused) tick();
  return "seek";
}

function seek(atSec) {
  engine.stopAll();
  engine.mute();
  const resumeAt = engine.now() + LEAD;
  startAt = resumeAt - (atSec - fromSec);
  engine.unmute(resumeAt);
}

export function reload(parsed, atSec, range = null) {
  if (!playing || !parsed) return false;
  song = parsed;
  fromSec = Math.max(0, range?.fromSec ?? 0);
  toSec = range?.toSec ?? Infinity;
  seek(atSec);
  resyncCursor();
  if (!paused) tick();
  return true;
}

export function seekTo(atSec) {
  if (!playing || !song) return false;
  seek(Math.min(Math.max(atSec, fromSec), toSec));
  resyncCursor();
  loops = 0;
  if (!paused) tick();
  return true;
}

function tick() {
  if (!playing) return;
  const horizon = engine.now() + LEAD;

  for (;;) {
    const stopSec = at(toSec);
    let done = true;
    song.tracks.forEach((tr, i) => {
      const ch = chanOf(i);
      while (cursor[i] < tr.notes.length) {
        const n = tr.notes[cursor[i]];
        if (n.start >= toSec) { cursor[i] = tr.notes.length; break; }
        if (at(n.start) >= horizon) break;
        cursor[i]++;
        const on = Math.max(at(n.start), startAt);
        const off = Math.min(at(n.start + n.dur), stopSec);
        if (off - on < 0.001) continue;
        const key = keyFor(i, n.midi);
        engine.noteOn(ch, key, n.vel, on);
        engine.noteOff(ch, key, off);
      }
      if (cursor[i] < tr.notes.length) done = false;
    });
    if (!done) return;

    const span = spanSec();
    if (!looping || span <= 0) {
      if (engine.now() > Math.min(at(song.duration), stopSec) + 0.6) stop();
      return;
    }

    startAt += span;
    cursor.fill(0);
    loops++;
    if (startAt >= horizon) return;
  }
}

export function stop() {
  playing = false;
  paused = false;
  clearInterval(timer); timer = null;
  engine.resume();
  engine.stopAll();
  engine.mute();
  drainAt = engine.now() + LEAD;
  onStop();
}
