// Studio Workshop — ported from the owner's earlier frontend (owner-authorized port).
// Offline render worker: SpessaSynth core (Studio's vendored build) renders the
// flattened events with the user's own bank, in 10-second chunks.
// Workshop edits sit outside the Canonical/verified pipeline and are never evidence.
import { SoundBankLoader, SpessaSynthProcessor } from "../../../vendor/spessasynth/core.js";

// The worker imports nothing but the engine; the event layout (frame, channel,
// key, velocity) is mixnotes.EV_STRIDE, held equal by a unit test.
export const EV_STRIDE = 4;

const BLOCK = 128;

const CHUNK_SEC = 10;

async function makeSynth({ bytes, setup, sampleRate, channels }) {
  const synth = new SpessaSynthProcessor(sampleRate, { maxBufferSize: BLOCK });
  await synth.processorInitialized;
  while (synth.midiChannels.length < channels) synth.createMIDIChannel();
  synth.soundBankManager.addSoundBank(SoundBankLoader.fromArrayBuffer(bytes), "main");
  postMessage({ type: "banked" });
  for (const s of setup) {
    if (s.drum) synth.midiChannels[s.ch]?.setDrums(true);
    synth.controllerChange(s.ch, 0, s.drum ? 0 : s.msb);
    synth.controllerChange(s.ch, 32, s.drum ? 0 : s.lsb);
    synth.programChange(s.ch, s.prog);
  }
  return synth;
}

function advance(synth, ev, from, to, write) {
  let frame = from;
  while (frame < to) {
    while (ev.i < ev.count && ev.events[ev.i * EV_STRIDE] <= frame) {
      const o = ev.i * EV_STRIDE;
      const ch = ev.events[o + 1], midi = ev.events[o + 2], vel = ev.events[o + 3];
      if (vel < 0) synth.noteOff(ch, midi);
      else synth.noteOn(ch, midi, vel);
      ev.i++;
    }
    const nextEvent = ev.i < ev.count ? ev.events[ev.i * EV_STRIDE] : to;
    const n = Math.min(nextEvent - frame, BLOCK, to - frame);
    if (n <= 0) throw new Error(`render stalled: frame=${frame} next=${nextEvent} to=${to}`);
    write(frame - from, n);
    frame += n;
  }
}

function renderFlat({ events, count, totalFrames, sampleRate }, synth) {
  const ev = { events, count, i: 0 };
  const chunkFrames = Math.max(BLOCK, Math.round(CHUNK_SEC * sampleRate));
  for (let at = 0; at < totalFrames; at += chunkFrames) {
    const frames = Math.min(chunkFrames, totalFrames - at);
    const left = new Float32Array(frames), right = new Float32Array(frames);
    advance(synth, ev, at, at + frames, (i, n) => synth.process(left, right, i, n));
    postMessage({ type: "chunk", at, frames, left, right }, [left.buffer, right.buffer]);
    postMessage({ type: "progress", frame: at + frames, totalFrames });
  }
}

async function render(msg) {
  const synth = await makeSynth(msg);
  renderFlat(msg, synth);
  synth.destroySynthProcessor();
  postMessage({ type: "done", totalFrames: msg.totalFrames });
}

onmessage = e => {
  const d = e.data;
  if (d?.type !== "render") return;
  render(d).catch(err => {
    postMessage({ type: "error", message: err?.message ?? String(err) });
  });
};
