// Player readback (Gate 6): what the preview engine actually processed,
// compared with the exact applied MML. Pure: no DOM, no audio.
//
// A capture lists the note and program events the SpessaSynth worklet reported
// as processed, each stamped with the worklet's own audio clock. It is compared
// with an independent reading of the exact MML string: the Worker parses that
// string again at every analysis, and the expected events are derived here
// without going through buildSchedule(), so a scheduling fault shows up as a
// mismatch instead of agreeing with itself.
//
// Order, pitch and velocity are compared exactly, per channel. Timing is
// compared within TIMING_TOLERANCE_SEC of the exact tempo-map time, because
// the engine works in audio render quanta, not in beats.
//
// Scope: processed engine events, not hardware audio. A capture says nothing
// about the game's timbre, the original recording or in-game behaviour.
import { channelFor, tempoClock, velocityFor } from './schedule.mjs';

export const READBACK_KIND = 'studio-preview-readback';
export const READBACK_SCOPE = 'processed_engine_events_not_hardware_audio';
export const TIMING_TOLERANCE_SEC = 0.025;
export const MAX_CAPTURED_EVENTS = 100000;
const MAX_REPORTED_ERRORS = 12;

// Per channel, the note events the exact song asks for, in the order an
// engine must process them: by time, and a release before an attack at the
// same instant (a repeated pitch is re-struck, not cut by its own release).
export function expectedEvents(song) {
  const seconds = tempoClock(song?.tempo);
  const channels = new Map();
  (song?.tracks ?? []).forEach((track, role) => {
    const list = [];
    for (const note of track.events ?? []) {
      list.push({ time: seconds(note.start), on: true, pitch: note.pitch, velocity: velocityFor(note.volume ?? 8) });
      list.push({ time: seconds(note.end), on: false, pitch: note.pitch });
    }
    list.sort((a, b) => a.time - b.time || Number(a.on) - Number(b.on));
    if (list.length) channels.set(channelFor(role), list);
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
