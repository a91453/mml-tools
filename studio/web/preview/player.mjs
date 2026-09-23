// Timbre preview: plays the validated Final MML through SpessaSynth with a
// DLS/SF2/SF3 sound bank the user selects on their own device.
//
// Architecture from the owner's MML 工房 player: one AudioContext, the
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
//     (soundbank-store.mjs) — never uploaded, never part of a project;
//   * this is a listening aid. It does not capture what the engine loaded, so
//     it cannot satisfy the player-readback gate, and it is never source,
//     original-audio or in-game evidence.
import { buildSchedule, indexAt, soundingAt } from './schedule.mjs';

export const LOOKAHEAD_SEC = 0.3;
export const TICK_MS = 25;
export const START_DELAY_SEC = 0.12;
// Empty bank slots are named `(Not Used)N`, or `(Not Used100` once the name
// field is full; neither is an instrument.
const PLACEHOLDER = /^\(Not Used/i;
const VENDOR = new URL('../../../vendor/spessasynth/', import.meta.url);

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
    const out = context.createGain();
    synth.connect(out);
    out.connect(context.destination);
    await synth.isReady;
    const listed = new Promise(resolve => synth.eventHandler.addEvent('presetListChange', 'studio-preview', list => resolve(list)));
    await synth.soundBankManager.addSoundBank(bank.bytes.slice(0), 'studio-user-bank');
    const list = await Promise.race([listed, new Promise(resolve => setTimeout(() => resolve(synth.presetList), 4000))]);
    const presets = (list ?? [])
      .filter(preset => preset?.name && !PLACEHOLDER.test(preset.name))
      .map(preset => ({ program: preset.program, bankMSB: preset.bankMSB ?? 0, bankLSB: preset.bankLSB ?? 0, name: preset.name }))
      .sort((a, b) => a.program - b.program);
    if (!presets.length) throw Error('音色庫沒有可用的音色');
    return { context, synth, out, presets, bank: { name: bank.name, sha256: bank.sha256 } };
  } catch (error) {
    context.close?.();
    throw error;
  }
}

export function createTransport(engine, { onPosition = () => {}, onEnd = () => {} } = {}) {
  const { context, synth, out } = engine;
  let song = null;
  let program = engine.presets[0].program;
  const muted = [false, false, false, false, false, false];
  let events = [], duration = 0, index = 0, t0 = 0, timer = 0, frame = 0, playing = false, unmuteTimer = 0;

  function applyProgram() {
    for (let channel = 0; channel < 6; channel++) {
      synth.controllerChange(channel, 0, 0);
      synth.programChange(channel, program);
      synth.midiChannels[channel]?.setSystemParameter('isMuted', muted[channel]);
    }
  }
  function send(event) {
    const time = t0 + event.time;
    if (event.type === 'on') synth.noteOn(event.channel, event.pitch, event.velocity, { time });
    else synth.noteOff(event.channel, event.pitch, { time });
  }
  function tick() {
    const horizon = context.currentTime + LOOKAHEAD_SEC;
    while (index < events.length && t0 + events[index].time <= horizon) send(events[index++]);
    if (index >= events.length && context.currentTime > t0 + duration + 0.4) { halt(); onEnd(); }
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
    if (playing) silenceQueued();
    playing = false;
  }

  return Object.freeze({
    load(nextSong) { halt(); song = nextSong; ({ events, duration } = buildSchedule(song)); return duration; },
    setProgram(value) { program = Number(value); if (playing) applyProgram(); },
    setMuted(role, value) {
      muted[role] = Boolean(value);
      synth.midiChannels[role]?.setSystemParameter('isMuted', muted[role]);
    },
    async play(from = 0) {
      if (!song) throw Error('沒有可試聽的 Final MML');
      halt();
      await context.resume();
      clearTimeout(unmuteTimer);
      synth.stopAll(true);
      out.gain.cancelScheduledValues(context.currentTime);
      out.gain.setValueAtTime(1, context.currentTime);
      applyProgram();
      const start = Math.min(Math.max(0, from), duration);
      t0 = context.currentTime + START_DELAY_SEC - start;
      index = indexAt(events, start);
      for (const held of soundingAt(events, start)) synth.noteOn(held.channel, held.pitch, held.velocity, { time: t0 + start });
      playing = true;
      timer = setInterval(tick, TICK_MS);
      tick();
      report();
    },
    stop() { halt(); onPosition(0, duration); },
    get playing() { return playing; },
    get duration() { return duration; },
    position: () => (playing ? Math.min(duration, Math.max(0, context.currentTime - t0)) : 0),
    destroy() { halt(); clearTimeout(unmuteTimer); synth.destroy?.(); context.close?.(); },
  });
}
