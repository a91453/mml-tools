// Offline rendering and signal analysis for the audio prescreen.
//
// Status: IMPLEMENTATION NOTES. Runs inside the render worker (render-pool.mjs)
// so a long render never blocks the service's event loop. Deterministic by
// construction: spessasynth_core with effects off, a fixed block size, notes
// scheduled at exact sample positions, no clock, no randomness. The same
// performance, bank and settings produce the same PCM, byte for byte, on the
// same engine version.
//
// Each role plays on its own MIDI channel (channels 0-5; a drum instrument
// turns its channel into a GM drum channel), and the synthesizer's split
// output gives every role its own signal. Those per-role signals are what the
// masking analysis reads; they are never stored whole. Features are computed
// frame by frame while rendering, and only the mixed PCM's SHA-256 (and, when
// asked, the PCM itself) leaves this module.
import { createHash } from 'node:crypto';
import { BasicSoundBank, SoundBankLoader, SpessaLog, SpessaSynthProcessor } from 'spessasynth_core';
import { bandMap, chromaMap, createFft, hann, thirdOctaveEdges, frameSizeFor } from './dsp.mjs';
import { drumNotesOf, soundingPitch, velocityForVolume } from '../instruments.mjs';
import { ANCHOR_PITCHES, CALIBRATION_ID, PARTIALS, RENDERER_ID, RENDER_ENGINE, voiceKey } from './renderer-core-constants.mjs';

export const BLOCK = 256;
export const TAIL_SECONDS = 1.5;
export const CLIP_LEVEL = 0.999;
const ROLE_COUNT = 6;

SpessaLog.setLogLevel(false, false, false);

const banks = new Map();

/** Parse (once per worker) the verified bank bytes named by their SHA-256. */
export async function loadBank(sha256, bytes) {
  if (banks.has(sha256)) return banks.get(sha256);
  if (!bytes) throw Error('bank bytes are required on first use');
  await BasicSoundBank.isSF3DecoderReady;
  const view = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  const bank = SoundBankLoader.fromArrayBuffer(view.buffer.slice(view.byteOffset, view.byteOffset + view.byteLength));
  banks.clear();
  banks.set(sha256, bank);
  return bank;
}

async function newSynth(bank, sampleRate) {
  const synth = new SpessaSynthProcessor(sampleRate, { effectsEnabled: false, eventsEnabled: false, maxBufferSize: BLOCK });
  synth.soundBankManager.addSoundBank(bank, 'prescreen');
  await synth.processorInitialized;
  synth.setSystemParameter('voiceCap', 512);
  return synth;
}

function assignVoice(synth, channel, voice) {
  if (drumNotesOf(voice)) {
    synth.midiChannels[channel].setDrums(true);
    synth.programChange(channel, 0);
  } else {
    synth.programChange(channel, voice.program);
  }
}

/** Analysis settings for a sample rate: about 93 ms frames, half-frame hop. */
export function analysisSettings(sampleRate) {
  const frameSize = frameSizeFor(sampleRate, 0.09);
  const hop = frameSize / 2;
  const edges = thirdOctaveEdges(Math.min(sampleRate / 2, 11000));
  return { frameSize, hop, edges };
}

/**
 * Render one performance and analyse it frame by frame.
 *
 * `window` limits the render to [startSec, endSec) of the performance (a bar
 * range plus pre-roll); notes already sounding at startSec are struck at 0.
 */
export async function renderAnalysis({ bank, performance, sampleRate, channels, window = null, returnPcm = false }) {
  const synth = await newSynth(bank, sampleRate);
  performance.roles.forEach((role, channel) => assignVoice(synth, channel, role));
  const startSec = window?.startSec ?? 0;
  const endSec = window?.endSec ?? performance.durationSeconds;
  const events = [];
  for (const role of performance.roles) {
    // A drum role sounds a kit note: below o4c its first, from o4c its second.
    const pitchFor = note => soundingPitch(role, note.pitch);
    for (const note of role.notes) {
      if (note.off <= startSec || note.on >= endSec) continue;
      const on = Math.max(0, Math.round((note.on - startSec) * sampleRate));
      const off = Math.max(on + 1, Math.round((note.off - startSec) * sampleRate));
      events.push({ at: on, on: true, channel: role.index, pitch: pitchFor(note), velocity: velocityForVolume(note.volume) });
      events.push({ at: off, on: false, channel: role.index, pitch: pitchFor(note) });
    }
  }
  // A release goes before an attack at the same sample, so a repeated pitch
  // is struck again rather than cut by its own release.
  events.sort((a, b) => a.at - b.at || (a.on === b.on ? a.channel - b.channel || a.pitch - b.pitch : a.on ? 1 : -1));
  const total = Math.ceil((endSec - startSec + TAIL_SECONDS) * sampleRate);

  const { frameSize, hop, edges } = analysisSettings(sampleRate);
  const bands = edges.length - 1;
  const fft = createFft(frameSize);
  const win = hann(frameSize);
  const bandOf = bandMap(frameSize, sampleRate, edges);
  const pcOf = chromaMap(frameSize, sampleRate);
  const frameCount = total >= frameSize ? Math.floor((total - frameSize) / hop) + 1 : 0;
  const bandEnergy = new Float32Array(frameCount * ROLE_COUNT * bands);
  const chroma = new Float32Array(frameCount * 12);
  const flux = new Float32Array(frameCount);
  const energy = new Float32Array(frameCount);
  const chunkCount = Math.ceil(total / hop);
  const chunkPeak = new Float32Array(chunkCount);
  const chunkClipped = new Uint32Array(chunkCount);

  const ring = frameSize + BLOCK;
  const roleRing = Array.from({ length: ROLE_COUNT }, () => new Float32Array(ring));
  const outs = Array.from({ length: ROLE_COUNT }, () => [new Float32Array(BLOCK), new Float32Array(BLOCK)]);
  const fxL = new Float32Array(BLOCK);
  const fxR = new Float32Array(BLOCK);
  const re = new Float64Array(frameSize);
  const im = new Float64Array(frameSize);
  const mixRe = new Float64Array(frameSize / 2 + 1);
  const mixIm = new Float64Array(frameSize / 2 + 1);
  let previousMagnitude = new Float64Array(frameSize / 2 + 1);
  let currentMagnitude = new Float64Array(frameSize / 2 + 1);
  const hash = createHash('sha256');
  const pcm = returnPcm ? new Int16Array(total * channels) : null;
  const block16 = new Int16Array(BLOCK * channels);
  let peak = 0;
  let clipped = 0;
  let written = 0;
  let nextFrame = 0;
  let eventIndex = 0;

  const toInt16 = value => Math.max(-32768, Math.min(32767, Math.round(value * 32767)));

  const analyseFrame = index => {
    const frameStart = index * hop;
    mixRe.fill(0); mixIm.fill(0);
    let any = false;
    for (let r = 0; r < ROLE_COUNT; r++) {
      const buffer = roleRing[r];
      let silent = true;
      for (let i = 0; i < frameSize; i++) {
        const v = buffer[(frameStart + i) % ring];
        if (v !== 0) silent = false;
        re[i] = v * win[i];
        im[i] = 0;
      }
      const base = (index * ROLE_COUNT + r) * bands;
      if (silent) continue;
      any = true;
      fft(re, im);
      for (let bin = 1; bin <= frameSize / 2; bin++) {
        const power = re[bin] * re[bin] + im[bin] * im[bin];
        const band = bandOf[bin];
        if (band >= 0) bandEnergy[base + band] += power;
        mixRe[bin] += re[bin];
        mixIm[bin] += im[bin];
      }
    }
    let frameEnergy = 0;
    let frameFlux = 0;
    for (let bin = 1; bin <= frameSize / 2; bin++) {
      const power = any ? mixRe[bin] * mixRe[bin] + mixIm[bin] * mixIm[bin] : 0;
      frameEnergy += power;
      const pc = pcOf[bin];
      if (pc >= 0) chroma[index * 12 + pc] += power;
      const magnitude = Math.log1p(1000 * Math.sqrt(power));
      currentMagnitude[bin] = magnitude;
      const rise = magnitude - previousMagnitude[bin];
      if (rise > 0) frameFlux += rise;
    }
    energy[index] = frameEnergy;
    flux[index] = frameFlux;
    [previousMagnitude, currentMagnitude] = [currentMagnitude, previousMagnitude];
  };

  while (written < total) {
    while (eventIndex < events.length && events[eventIndex].at <= written) {
      const event = events[eventIndex++];
      if (event.on) synth.noteOn(event.channel, event.pitch, event.velocity);
      else synth.noteOff(event.channel, event.pitch);
    }
    const nextEvent = eventIndex < events.length ? events[eventIndex].at : Infinity;
    const count = Math.min(BLOCK, total - written, nextEvent - written);
    for (const [l, r] of outs) { l.fill(0, 0, count); r.fill(0, 0, count); }
    synth.processSplit(outs, fxL, fxR, 0, count);
    for (let i = 0; i < count; i++) {
      let left = 0;
      let right = 0;
      const position = (written + i) % ring;
      for (let r = 0; r < ROLE_COUNT; r++) {
        const l = outs[r][0][i];
        const rr = outs[r][1][i];
        left += l;
        right += rr;
        roleRing[r][position] = (l + rr) / 2;
      }
      const absolute = Math.max(Math.abs(left), Math.abs(right));
      const chunk = Math.floor((written + i) / hop);
      if (absolute > chunkPeak[chunk]) chunkPeak[chunk] = absolute;
      if (absolute >= CLIP_LEVEL) { chunkClipped[chunk]++; clipped++; }
      if (absolute > peak) peak = absolute;
      if (channels === 1) block16[i] = toInt16((left + right) / 2);
      else { block16[2 * i] = toInt16(left); block16[2 * i + 1] = toInt16(right); }
    }
    const bytes = new Uint8Array(block16.buffer, 0, count * channels * 2);
    hash.update(bytes);
    if (pcm) pcm.set(block16.subarray(0, count * channels), written * channels);
    written += count;
    while (nextFrame < frameCount && nextFrame * hop + frameSize <= written) analyseFrame(nextFrame++);
  }

  return {
    renderer: RENDERER_ID,
    engine: RENDER_ENGINE,
    sampleRate,
    channels,
    startSec,
    frames: total,
    pcmSha256: hash.digest('hex'),
    pcm,
    peak,
    clippedSamples: clipped,
    analysis: { sampleRate, frameSize, hop, bands, edges, frameCount, bandEnergy, chroma, flux, energy, chunkPeak, chunkClipped },
  };
}

// ─── calibration ────────────────────────────────────────────────────────────
//
// The note-level model behind roughness and decay smear reads each voice's
// partial spectrum, level, held decay and release time from single notes
// rendered with the same bank and engine, so the model describes the sound
// that was actually rendered rather than a textbook instrument.

const HOLD_SECONDS = 1.0;
const RENDER_SECONDS = 1.7;

async function renderSingle(bank, sampleRate, voice, pitch, velocity, holdSeconds, totalSeconds) {
  const synth = await newSynth(bank, sampleRate);
  assignVoice(synth, 0, voice);
  const total = Math.round(totalSeconds * sampleRate);
  const off = Math.round(holdSeconds * sampleRate);
  const out = new Float32Array(total);
  const outs = [[new Float32Array(BLOCK), new Float32Array(BLOCK)]];
  const fx = new Float32Array(BLOCK);
  // `pitch` is the key struck: a kit note for a drum voice (calibrate).
  const key = pitch;
  synth.noteOn(0, key, velocity);
  let written = 0;
  let released = false;
  while (written < total) {
    if (!released && written >= off) { synth.noteOff(0, key); released = true; }
    const count = Math.min(BLOCK, total - written, released ? BLOCK : off - written);
    outs[0][0].fill(0, 0, count); outs[0][1].fill(0, 0, count);
    synth.processSplit(outs, fx, fx, 0, count);
    for (let i = 0; i < count; i++) out[written + i] = (outs[0][0][i] + outs[0][1][i]) / 2;
    written += count;
  }
  return out;
}

function rmsEnvelope(signal, sampleRate) {
  const size = Math.round(sampleRate * 0.02);
  const hop = Math.round(sampleRate * 0.01);
  const values = [];
  for (let start = 0; start + size <= signal.length; start += hop) {
    let sum = 0;
    for (let i = start; i < start + size; i++) sum += signal[i] * signal[i];
    values.push({ t: (start + size / 2) / sampleRate, rms: Math.sqrt(sum / size) });
  }
  return values;
}

function decayTau(points, fallback) {
  if (points.length < 4) return fallback;
  let st = 0, sy = 0, stt = 0, sty = 0;
  for (const { t, rms } of points) { const y = Math.log(rms); st += t; sy += y; stt += t * t; sty += t * y; }
  const n = points.length;
  const slope = (n * sty - st * sy) / (n * stt - st * st);
  if (!Number.isFinite(slope) || slope >= -0.02) return null;
  return -1 / slope;
}

function partialsOf(signal, sampleRate, pitch, startSec) {
  const size = frameSizeFor(sampleRate, 0.18);
  const fft = createFft(size);
  const win = hann(size);
  const re = new Float64Array(size);
  const im = new Float64Array(size);
  const start = Math.min(signal.length - size, Math.max(0, Math.round(startSec * sampleRate)));
  for (let i = 0; i < size; i++) { re[i] = (signal[start + i] ?? 0) * win[i]; im[i] = 0; }
  fft(re, im);
  const f0 = 440 * 2 ** ((pitch - 69) / 12);
  const amplitudes = [];
  for (let k = 1; k <= PARTIALS; k++) {
    const hz = k * f0;
    if (hz > 0.45 * sampleRate) { amplitudes.push(0); continue; }
    const lo = Math.max(1, Math.floor((hz * 0.97 * size) / sampleRate));
    const hi = Math.min(size / 2, Math.ceil((hz * 1.03 * size) / sampleRate));
    let best = 0;
    for (let bin = lo; bin <= hi; bin++) best = Math.max(best, re[bin] * re[bin] + im[bin] * im[bin]);
    amplitudes.push(Math.sqrt(best));
  }
  const norm = Math.sqrt(amplitudes.reduce((sum, a) => sum + a * a, 0));
  return norm > 0 ? amplitudes.map(a => a / norm) : [1, ...new Array(PARTIALS - 1).fill(0)];
}

async function measure(bank, sampleRate, voice, pitch) {
  const signal = await renderSingle(bank, sampleRate, voice, pitch, 127, HOLD_SECONDS, RENDER_SECONDS);
  const envelope = rmsEnvelope(signal, sampleRate);
  let peak = { t: 0, rms: 0 };
  for (const point of envelope) if (point.t <= 0.35 && point.rms > peak.rms) peak = point;
  const floor = Math.max(peak.rms * 1e-4, 1e-7);
  const hold = envelope.filter(p => p.t >= peak.t + 0.03 && p.t <= HOLD_SECONDS - 0.02 && p.rms > floor);
  const release = envelope.filter(p => p.t >= HOLD_SECONDS + 0.015 && p.t <= HOLD_SECONDS + 0.6 && p.rms > floor);
  const holdTau = peak.rms > 0 ? decayTau(hold, null) : null;
  // Too few points: the release is shorter than the envelope can resolve. No
  // measurable decay after the release: the longest tail this model allows.
  const releaseTau = peak.rms > 0 ? decayTau(release, 0.005) ?? 5 : 0.005;
  return {
    pitch,
    level: peak.rms,
    attack_seconds: peak.t,
    // null: the held note does not measurably decay (a sustaining voice).
    hold_tau_seconds: holdTau === null ? null : Math.min(30, Math.max(0.02, holdTau)),
    release_tau_seconds: Math.min(5, Math.max(0.005, releaseTau)),
    partials: drumNotesOf(voice) ? null : partialsOf(signal, sampleRate, pitch, peak.t + 0.02),
  };
}

/** Voice profiles for the given voices (program / drum note), measured with this bank. */
export async function calibrate({ bank, sampleRate, voices }) {
  const profiles = {};
  for (const voice of voices) {
    const key = voiceKey(voice);
    if (profiles[key]) continue;
    const kit = drumNotesOf(voice);
    const drum = Boolean(kit);
    const anchors = [];
    // A drum is measured on each kit note it sounds, once per distinct note.
    for (const pitch of drum ? [...new Set(kit)] : ANCHOR_PITCHES) anchors.push(await measure(bank, sampleRate, voice, pitch));
    const reference = anchors.find(anchor => anchor.pitch === (drum ? kit[0] : 60)) ?? anchors[0];
    const gains = [];
    for (let volume = 0; volume <= 15; volume++) {
      const signal = await renderSingle(bank, sampleRate, voice, reference.pitch, velocityForVolume(volume), 0.3, 0.35);
      const env = rmsEnvelope(signal, sampleRate);
      gains.push(env.reduce((max, point) => Math.max(max, point.rms), 0));
    }
    const top = gains[15] || 1;
    profiles[key] = { key, drum, anchors, volume_gain: gains.map(gain => gain / top) };
  }
  return { calibration: CALIBRATION_ID, sampleRate, profiles };
}

export { ANCHOR_PITCHES, CALIBRATION_ID, PARTIALS, RENDERER_ID, RENDER_ENGINE, voiceKey };
