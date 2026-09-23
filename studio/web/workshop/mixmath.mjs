// Studio Workshop — ported from the owner's earlier frontend (owner-authorized port).
// Mixing math: peak, gain, loudness, tail trim, segment planning.
// Workshop edits sit outside the Canonical/verified pipeline and are never evidence.
export const CEILING = 0.891;

const SILENCE = 1e-4;

const PAD_SEC = 0.05;

export function peakOf(left, right) {
  let peak = 0;
  for (let i = 0; i < left.length; i++) {
    const l = left[i] < 0 ? -left[i] : left[i];
    const r = right[i] < 0 ? -right[i] : right[i];
    if (l > peak) peak = l;
    if (r > peak) peak = r;
  }
  return peak;
}

export const gainFor = peak => (peak > CEILING ? CEILING / peak : 1);

export function trimTail(left, right, sampleRate) {
  let last = -1;
  for (let i = left.length - 1; i >= 0; i--) {
    if (Math.abs(left[i]) > SILENCE || Math.abs(right[i]) > SILENCE) { last = i; break; }
  }
  if (last < 0) return 0;
  return Math.min(left.length, last + 1 + Math.round(PAD_SEC * sampleRate));
}

export function planSegments(totalFrames, segFrames) {
  const out = [];
  for (let at = 0; at < totalFrames; at += segFrames) {
    out.push({ at, frames: Math.min(segFrames, totalFrames - at) });
  }
  return out;
}

export function addInto(master, src, at) {
  const n = Math.min(src.length, master.length - at);
  for (let i = 0; i < n; i++) master[at + i] += src[i];
  return n > 0 ? n : 0;
}

export const TARGET_LUFS = -14;

const BLOCK_SEC = 0.4;
const STEP_SEC = 0.1;

const ABS_GATE = -70;
const REL_GATE_OFFSET = -10;

const LUFS_OFFSET = -0.691;

function kWeightingStages(fs) {
  const f1 = 1681.974450955533, G = 3.999843853973347, Q1 = 0.7071752369554196;
  const K1 = Math.tan(Math.PI * f1 / fs);
  const Vh = Math.pow(10, G / 20);
  const Vb = Math.pow(Vh, 0.4996667741545416);
  const a0s = 1 + K1 / Q1 + K1 * K1;
  const shelf = {
    b0: (Vh + Vb * K1 / Q1 + K1 * K1) / a0s,
    b1: 2 * (K1 * K1 - Vh) / a0s,
    b2: (Vh - Vb * K1 / Q1 + K1 * K1) / a0s,
    a1: 2 * (K1 * K1 - 1) / a0s,
    a2: (1 - K1 / Q1 + K1 * K1) / a0s,
  };
  const f2 = 38.13547087602444, Q2 = 0.5003270373238773;
  const K2 = Math.tan(Math.PI * f2 / fs);
  const a0h = 1 + K2 / Q2 + K2 * K2;
  const hp = {
    b0: 1, b1: -2, b2: 1,
    a1: 2 * (K2 * K2 - 1) / a0h,
    a2: (1 - K2 / Q2 + K2 * K2) / a0h,
  };
  return [shelf, hp];
}

function biquad(x, { b0, b1, b2, a1, a2 }) {
  let z1 = 0, z2 = 0;
  for (let i = 0; i < x.length; i++) {
    const v = x[i];
    const y = b0 * v + z1;
    z1 = b1 * v - a1 * y + z2;
    z2 = b2 * v - a2 * y;
    x[i] = y;
  }
  return x;
}

export function loudnessLufs(left, right, sampleRate) {
  const blockLen = Math.round(BLOCK_SEC * sampleRate);
  const step = Math.round(STEP_SEC * sampleRate);
  if (left.length < blockLen) return -Infinity;

  const stages = kWeightingStages(sampleRate);
  const weighted = [left, right].map(ch => {
    const y = Float32Array.from(ch);
    for (const s of stages) biquad(y, s);
    return y;
  });

  const zs = [];
  for (let at = 0; at + blockLen <= weighted[0].length; at += step) {
    let z = 0;
    for (const ch of weighted) {
      let s = 0;
      for (let i = at; i < at + blockLen; i++) s += ch[i] * ch[i];
      z += s / blockLen;
    }
    zs.push(z);
  }
  if (!zs.length) return -Infinity;

  const loudnessOf = sum => LUFS_OFFSET + 10 * Math.log10(sum);
  const mean = arr => arr.reduce((a, b) => a + b, 0) / arr.length;

  const pass1 = zs.filter(z => z > 0 && loudnessOf(z) > ABS_GATE);
  if (!pass1.length) return -Infinity;

  const relGate = loudnessOf(mean(pass1)) + REL_GATE_OFFSET;
  const pass2 = pass1.filter(z => loudnessOf(z) > relGate);
  if (!pass2.length) return -Infinity;

  return loudnessOf(mean(pass2));
}

export function gainForLoudness(left, right, sampleRate, target = TARGET_LUFS) {
  const lufs = loudnessLufs(left, right, sampleRate);
  if (!Number.isFinite(lufs)) return { gain: 1, lufs, reached: lufs };

  const wanted = Math.pow(10, (target - lufs) / 20);
  const peak = peakOf(left, right);
  const headroom = peak > 0 ? CEILING / peak : Infinity;
  const gain = Math.min(wanted, headroom);
  return { gain, lufs, reached: lufs + 20 * Math.log10(gain) };
}

// 16-bit PCM stereo WAV. Pure and deterministic: the same PCM and gain always
// give the same bytes (no dither), so a render can be compared byte for byte.
export function encodeWav(left, right, sampleRate, gain = 1) {
  const frames = Math.min(left.length, right.length);
  const bytes = new Uint8Array(44 + frames * 4);
  const v = new DataView(bytes.buffer);
  const ascii = (at, s) => { for (let i = 0; i < s.length; i++) bytes[at + i] = s.charCodeAt(i); };
  ascii(0, "RIFF"); v.setUint32(4, 36 + frames * 4, true); ascii(8, "WAVE");
  ascii(12, "fmt "); v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 2, true);
  v.setUint32(24, sampleRate, true); v.setUint32(28, sampleRate * 4, true);
  v.setUint16(32, 4, true); v.setUint16(34, 16, true);
  ascii(36, "data"); v.setUint32(40, frames * 4, true);
  const q = x => {
    const s = Math.max(-1, Math.min(1, x * gain));
    return Math.round(s < 0 ? s * 32768 : s * 32767);
  };
  for (let i = 0, at = 44; i < frames; i++, at += 4) {
    v.setInt16(at, q(left[i]), true);
    v.setInt16(at + 2, q(right[i]), true);
  }
  return bytes;
}
