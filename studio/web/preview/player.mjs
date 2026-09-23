// Timbre preview: plays the validated Final MML through SpessaSynth with a
// DLS/SF2/SF3 sound bank the user selects on their own device.
//
// Architecture from the owner's earlier frontend player: one AudioContext, the
// SpessaSynth AudioWorklet synthesizer, an output gain node, and a look-ahead
// scheduler (25 ms tick, 0.3 s horizon, 0.12 s start delay). SpessaSynth has no
// way to cancel events it has already queued, so stop mutes the output for the
// look-ahead window instead of pretending the queue is empty.
//
// Studio boundaries:
//   * the engine is loaded only when the user opens the preview, from files
//     built out of the npm packages spessasynth_lib / spessasynth_core
//     (Apache-2.0; license text in the header of vendor/spessasynth/lib.js); nothing comes from a CDN;
//   * the bank comes from a user-picked file kept in this browser
//     (soundbank-store.mjs) — never uploaded, never part of a project — or,
//     without one, from the free default bank this browser downloads from its
//     upstream at first use and keeps (default-bank.mjs);
//   * this is a listening aid, never source, original-audio or in-game
//     evidence. A playback from the start also captures the events the engine
//     actually processed, which the page can record as a player readback
//     (readback.mjs); that capture is about this engine, not the game.
import { buildSchedule, indexAt, soundingAt } from './schedule.mjs';
import { MAX_CAPTURED_EVENTS, READBACK_KIND, READBACK_SCOPE } from './readback.mjs';
import { uniformProgram } from './instruments.mjs';

export const LOOKAHEAD_SEC = 0.3;
export const TICK_MS = 25;
export const START_DELAY_SEC = 0.12;
// Empty bank slots are named `(Not Used)N`, or `(Not Used100` once the name
// field is full; neither is an instrument.
const PLACEHOLDER = /^\(Not Used/i;
const VENDOR = new URL('../../../vendor/spessasynth/', import.meta.url);
// The vendored engine (scripts/build-studio-web.mjs); a build test holds these
// to the versions named in vendor/spessasynth/lib.js.
export const ENGINE_VERSIONS = Object.freeze({ lib: 'spessasynth_lib@4.3.12', core: 'spessasynth_core@4.3.16' });

// `context` must be created and resumed by the caller synchronously inside the
// user's click (iOS Safari only unlocks audio within the gesture, before any
// await), which is why it is a parameter rather than created here.
export async function createPreviewEngine(bank, context) {
  if (!context?.audioWorklet) { context?.close?.(); throw Error('此瀏覽器不支援 AudioWorklet，無法試聽音色'); }
  try {
    await context.audioWorklet.addModule(new URL('./worklet-console.mjs', import.meta.url));
    await context.audioWorklet.addModule(new URL('processor.js', VENDOR));
    const { WorkletSynthesizer } = await import(new URL('lib.js', VENDOR).href);
    const synth = new WorkletSynthesizer(context);
    // Processed-event tap for the player readback. The worklet posts every
    // engine event together with its own audio clock (`currentTime`); the
    // public event handler drops that time, so the tap reads each message
    // before it is dispatched. A message without a numeric time is passed on
    // as such, and a capture containing one cannot become a readback.
    const listeners = new Set();
    const dispatch = synth.handleMessage.bind(synth);
    synth.handleMessage = message => {
      if (message?.type === 'eventCall' && listeners.size) for (const listener of listeners) listener(message.data?.type, message.data?.data, message.currentTime);
      return dispatch(message);
    };
    const out = context.createGain();
    synth.connect(out);
    out.connect(context.destination);
    await synth.isReady;
    const listed = new Promise(resolve => synth.eventHandler.addEvent('presetListChange', 'studio-preview', list => resolve(list)));
    await synth.soundBankManager.addSoundBank(bank.bytes.slice(0), 'studio-user-bank');
    const list = await Promise.race([listed, new Promise(resolve => setTimeout(() => resolve(synth.presetList), 4000))]);
    const presets = (list ?? [])
      .filter(preset => preset?.name && !PLACEHOLDER.test(preset.name))
      .map(preset => ({ program: preset.program, bankMSB: preset.bankMSB ?? 0, bankLSB: preset.bankLSB ?? 0, name: preset.name, drums: Boolean(preset.isAnyDrums ?? preset.isGMGSDrum) }))
      .sort((a, b) => a.program - b.program);
    if (!presets.length) throw Error('音色庫沒有可用的音色');
    const listen = listener => { listeners.add(listener); return () => listeners.delete(listener); };
    return { context, synth, out, presets, listen, bank: { name: bank.name, sha256: bank.sha256 } };
  } catch (error) {
    context.close?.();
    throw error;
  }
}

// `onEnd(capture, { ranged })` receives the readback capture when the playback
// started at the beginning and ran to the end, or null. A ranged playback
// (`play(from, { until })`, used by listening sessions) ends at `until`; its
// capture is marked incomplete (RANGE_LIMITED), so it can never be recorded.
export function createTransport(engine, { onPosition = () => {}, onEnd = () => {} } = {}) {
  const { context, synth, out } = engine;
  let song = null;
  // One voice per role: a program, and a drum-kit note for a drum instrument
  // (preview/instruments.mjs). Every role plays the same program by default.
  const melodic = voice => ({ program: Number(voice?.program ?? 0), drumNote: Number.isInteger(voice?.drumNote) ? voice.drumNote : null });
  let voices = Array.from({ length: 6 }, () => melodic({ program: engine.presets[0].program }));
  const pitchFor = event => voices[event.role]?.drumNote ?? event.pitch;
  const muted = [false, false, false, false, false, false];
  let events = [], duration = 0, index = 0, t0 = 0, timer = 0, frame = 0, playing = false, unmuteTimer = 0;
  // The range being played, in song seconds. `until` is null for "to the end".
  let from = 0, until = null;
  // Player readback capture: only for a playback that starts at 0. Anything
  // that makes it describe less than the whole song as loaded -- a seek, a
  // stop, a muted role, an instrument switch -- marks it incomplete.
  let capture = null, haltedAt = -Infinity;
  engine.listen?.((type, data, time) => {
    if (!capture) return;
    if (typeof time !== 'number' || !Number.isFinite(time)) { capture.timeSource = 'unknown'; return; }
    const at = Math.round((time - t0) * 1e6) / 1e6;
    if (type === 'programChange') capture.programs.push([at, data.channel, data.program, data.bankMSB ?? 0]);
    else if (type !== 'noteOn' && type !== 'noteOff') return;
    // The reset before the start (stopAll, program load) is not the song.
    else if (at < -0.01) return;
    else if (capture.events.length >= MAX_CAPTURED_EVENTS) incomplete('TOO_MANY_EVENTS');
    else capture.events.push(type === 'noteOn' ? [at, 1, data.channel, data.midiNote, data.velocity] : [at, 0, data.channel, data.midiNote, 0]);
  });
  function setVoices(list) {
    voices = Array.from({ length: 6 }, (_, role) => melodic(list?.[role]));
    if (playing) { incomplete('PROGRAM_CHANGED'); applyProgram(); }
  }
  function incomplete(reason) { if (capture && !capture.incomplete.includes(reason)) capture.incomplete.push(reason); }
  function beginCapture() {
    // A readback describes one program on every channel. Per-role
    // instruments or a drum kit make the capture incomplete, never recordable.
    const uniform = uniformProgram(voices);
    const program = uniform ?? voices[0].program;
    const preset = engine.presets.find(p => p.program === program && !p.drums) ?? engine.presets.find(p => p.program === program) ?? { program, bankMSB: 0, name: '' };
    capture = {
      kind: READBACK_KIND, scope: READBACK_SCOPE, gameTimbreEquivalent: false, timeSource: 'engine',
      sessionId: crypto.randomUUID(), capturedAt: new Date().toISOString(),
      bank: { ...engine.bank }, engine: { ...ENGINE_VERSIONS },
      program: { program: preset.program, bankMSB: preset.bankMSB ?? 0, name: preset.name },
      audioContextState: context.state ?? 'unknown', muted: [...muted], complete: false, incomplete: [],
      from: 0, duration, events: [], programs: [],
    };
    if (muted.some(Boolean)) incomplete('ROLE_MUTED');
    if (uniform === null) incomplete('PER_ROLE_INSTRUMENTS');
  }
  function finishCapture() {
    const done = capture;
    capture = null;
    if (!done) return null;
    done.complete = done.incomplete.length === 0 && done.timeSource === 'engine';
    return done;
  }

  function applyProgram() {
    for (let channel = 0; channel < 6; channel++) {
      synth.controllerChange(channel, 0, 0);
      synth.midiChannels[channel]?.setDrums?.(voices[channel].drumNote !== null);
      synth.programChange(channel, voices[channel].program);
      synth.midiChannels[channel]?.setSystemParameter('isMuted', muted[channel]);
    }
  }
  function send(event) {
    const time = t0 + event.time;
    if (event.type === 'on') synth.noteOn(event.channel, pitchFor(event), event.velocity, { time });
    else synth.noteOff(event.channel, pitchFor(event), { time });
  }
  // Nothing at or after `until` is ever queued, so a ranged playback cannot
  // leak notes past its end: the worklet cannot withdraw a queued note.
  const beyond = event => until !== null && event.time >= until;
  function tick() {
    const horizon = context.currentTime + LOOKAHEAD_SEC;
    while (index < events.length && t0 + events[index].time <= horizon && !beyond(events[index])) send(events[index++]);
    const drained = index >= events.length || beyond(events[index]);
    const endAt = until === null ? duration + 0.4 : until;
    if (drained && context.currentTime > t0 + endAt) { const ranged = until !== null; const done = finishCapture(); halt(); onEnd(done, { ranged }); }
  }
  function report() {
    if (!playing) return;
    onPosition(Math.min(duration, Math.max(0, context.currentTime - t0)), duration, synth.voiceCount);
    frame = requestAnimationFrame(report);
  }
  // Queued worklet events cannot be withdrawn: silence the output until the
  // look-ahead window has passed, then release everything once more.
  function silenceQueued() {
    clearTimeout(unmuteTimer);
    out.gain.cancelScheduledValues(context.currentTime);
    out.gain.setValueAtTime(0, context.currentTime);
    synth.stopAll(true);
    unmuteTimer = setTimeout(() => {
      synth.stopAll(true);
      out.gain.setValueAtTime(1, context.currentTime);
    }, (LOOKAHEAD_SEC + 0.08) * 1000);
  }
  function halt() {
    clearInterval(timer); cancelAnimationFrame(frame);
    timer = 0; frame = 0;
    // A capture still open here was cut short: it is dropped, never kept.
    capture = null;
    if (playing) { silenceQueued(); haltedAt = context.currentTime; }
    playing = false;
  }

  return Object.freeze({
    load(nextSong) { halt(); song = nextSong; ({ events, duration } = buildSchedule(song)); return duration; },
    setProgram(value) { setVoices(Array.from({ length: 6 }, () => ({ program: Number(value) }))); },
    // Six voices, one per role, as preview/instruments.mjs resolves them.
    setVoices,
    get voices() { return voices.map(voice => ({ ...voice })); },
    setMuted(role, value) {
      muted[role] = Boolean(value);
      if (muted[role]) incomplete('ROLE_MUTED');
      synth.midiChannels[role]?.setSystemParameter('isMuted', muted[role]);
    },
    async play(position = 0, { until: stopAt = null } = {}) {
      if (!song) throw Error('沒有可試聽的 Final MML');
      halt();
      await context.resume();
      const start = Math.min(Math.max(0, position), duration);
      // Notes queued by the previous playback cannot be withdrawn. A capture
      // waits until they have passed, so it records only this playback.
      const settle = haltedAt + LOOKAHEAD_SEC + 0.1 - context.currentTime;
      if (start === 0 && settle > 0) await new Promise(resolve => setTimeout(resolve, settle * 1000));
      clearTimeout(unmuteTimer);
      synth.stopAll(true);
      out.gain.cancelScheduledValues(context.currentTime);
      out.gain.setValueAtTime(1, context.currentTime);
      t0 = context.currentTime + START_DELAY_SEC - start;
      from = start;
      until = typeof stopAt === 'number' && Number.isFinite(stopAt) && stopAt > start ? Math.min(stopAt, duration) : null;
      if (start === 0) beginCapture();
      if (until !== null) incomplete('RANGE_LIMITED');
      applyProgram();
      index = indexAt(events, start);
      for (const held of soundingAt(events, start)) synth.noteOn(held.channel, pitchFor(held), held.velocity, { time: t0 + start });
      playing = true;
      timer = setInterval(tick, TICK_MS);
      tick();
      report();
    },
    stop() { halt(); onPosition(0, duration); },
    get playing() { return playing; },
    get duration() { return duration; },
    // What the scheduler is doing, in song seconds (for the page and its tests).
    get state() { return { playing, from, until, duration, next: events[index]?.time ?? null }; },
    position: () => (playing ? Math.min(duration, Math.max(0, context.currentTime - t0)) : 0),
    destroy() { halt(); clearTimeout(unmuteTimer); synth.destroy?.(); context.close?.(); },
  });
}
