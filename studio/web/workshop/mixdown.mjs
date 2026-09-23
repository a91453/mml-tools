// Studio Workshop — ported from the owner's earlier frontend (owner-authorized port).
// Offline mixdown: the six game tracks through SpessaSynth core in a worker,
// with the user's own bank, to PCM and a 16-bit WAV. A listening aid only:
// it is not the game's timbre and never evidence.
// Workshop edits sit outside the Canonical/verified pipeline and are never evidence.
import { buildEvents, buildSetup } from "./mixnotes.mjs";
import { peakOf, gainFor, trimTail, encodeWav } from "./mixmath.mjs";
import { loadBank } from "../preview/soundbank-store.mjs";

export const SAMPLE_RATE = 44100;

const CHANNELS = 17;

const fail = (code, message) => Object.assign(new Error(message), { code });

function run(url, msg, transfer, onMessage, signal) {
  return new Promise((resolve, reject) => {
    const worker = new Worker(url, { type: "module" });
    const stop = () => { worker.terminate(); signal?.removeEventListener("abort", onAbort); };
    const onAbort = () => { stop(); reject(fail("cancelled", "cancelled")); };
    if (signal?.aborted) return onAbort();
    signal?.addEventListener("abort", onAbort);
    worker.onmessage = e => {
      const d = e.data;
      if (d.type === "error") { stop(); reject(fail("worker", d.message)); return; }
      if (d.type === "done") { stop(); resolve(d); return; }
      Promise.resolve(onMessage(d, worker)).catch(err => { stop(); reject(err); });
    };
    worker.onerror = err => {
      stop();
      reject(fail("oom", err?.message || "render worker stopped (likely out of memory)"));
    };
    worker.postMessage(msg, transfer ?? []);
  });
}

// The bank bytes: a file the user just picked, or Studio's local bank store.
async function bankBytes(bank) {
  if (bank?.kind === "file") return bank.file.arrayBuffer();
  if (bank?.kind === "store") {
    const stored = await loadBank();
    if (stored) return stored.bytes;
  }
  throw fail("nobank", "no sound bank");
}

export async function renderPcm({ song, presets = [], bank, onProgress = () => {}, signal }) {
  const sampleRate = SAMPLE_RATE;
  const { events, count, totalFrames } = buildEvents(song, { sampleRate, presets });
  if (!count) throw fail("silent", "no sounding notes");
  let left, right;
  try {
    left = new Float32Array(totalFrames);
    right = new Float32Array(totalFrames);
  } catch {
    throw fail("oom", "out of memory for the mix buffer");
  }
  const bytes = await bankBytes(bank);
  let got = 0;
  const rendered = await run(new URL("./mix-worker.mjs", import.meta.url),
    { type: "render", bytes, events, count, totalFrames, setup: buildSetup(presets), sampleRate, channels: CHANNELS },
    [events.buffer, bytes],
    d => {
      if (d.type !== "chunk") return;
      left.set(d.left, d.at);
      right.set(d.right, d.at);
      got += d.frames;
      onProgress(got / totalFrames);
    }, signal);
  if (got !== rendered.totalFrames) throw fail("truncated", `incomplete render: ${got} / ${rendered.totalFrames} frames`);

  const len = trimTail(left, right, sampleRate);
  if (!len) throw fail("silent", "the render is silent");
  const l = left.subarray(0, len), r = right.subarray(0, len);
  return { left: l, right: r, sampleRate, gain: gainFor(peakOf(l, r)) };
}

// Gain only ever lowers the level (peak ceiling), never normalises upwards.
export const pcmToWav = ({ left, right, sampleRate, gain = 1 }) =>
  new Blob([encodeWav(left, right, sampleRate, gain)], { type: "audio/wav" });
