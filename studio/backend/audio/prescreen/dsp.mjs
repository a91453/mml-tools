// Small deterministic DSP helpers for the audio prescreen. Pure: no I/O.
//
// Everything here is plain double-precision JavaScript with fixed parameters,
// so the same input produces the same numbers on every run of the same engine.

/** An in-place iterative radix-2 FFT over separate real/imaginary arrays. */
export function createFft(size) {
  if (!Number.isInteger(size) || size < 2 || (size & (size - 1))) throw Error('FFT size must be a power of two');
  const levels = Math.log2(size);
  const reverse = new Uint32Array(size);
  for (let i = 0; i < size; i++) {
    let r = 0;
    for (let bit = 0, x = i; bit < levels; bit++, x >>= 1) r = (r << 1) | (x & 1);
    reverse[i] = r;
  }
  const cos = new Float64Array(size / 2);
  const sin = new Float64Array(size / 2);
  for (let i = 0; i < size / 2; i++) {
    cos[i] = Math.cos((2 * Math.PI * i) / size);
    sin[i] = -Math.sin((2 * Math.PI * i) / size);
  }
  return function fft(re, im) {
    for (let i = 0; i < size; i++) {
      const j = reverse[i];
      if (j > i) {
        let t = re[i]; re[i] = re[j]; re[j] = t;
        t = im[i]; im[i] = im[j]; im[j] = t;
      }
    }
    for (let half = 1; half < size; half <<= 1) {
      const step = size / (half * 2);
      for (let start = 0; start < size; start += half * 2) {
        for (let k = 0; k < half; k++) {
          const wr = cos[k * step];
          const wi = sin[k * step];
          const a = start + k;
          const b = a + half;
          const xr = re[b] * wr - im[b] * wi;
          const xi = re[b] * wi + im[b] * wr;
          re[b] = re[a] - xr; im[b] = im[a] - xi;
          re[a] += xr; im[a] += xi;
        }
      }
    }
  };
}

export function hann(size) {
  const window = new Float64Array(size);
  for (let i = 0; i < size; i++) window[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / size);
  return window;
}

/** Third-octave band edges (Hz) from 50 Hz up to `maxHz`. */
export function thirdOctaveEdges(maxHz, minHz = 44.7) {
  const edges = [minHz];
  while (edges.at(-1) * 2 ** (1 / 3) < maxHz) edges.push(edges.at(-1) * 2 ** (1 / 3));
  edges.push(maxHz);
  return edges;
}

/** FFT bin → band index (or -1) for the given edges. */
export function bandMap(size, sampleRate, edges) {
  const map = new Int16Array(size / 2 + 1).fill(-1);
  for (let bin = 1; bin <= size / 2; bin++) {
    const hz = (bin * sampleRate) / size;
    for (let band = 0; band < edges.length - 1; band++) {
      if (hz >= edges[band] && hz < edges[band + 1]) { map[bin] = band; break; }
    }
  }
  return map;
}

/** FFT bin → pitch class (0 = C) for 55 Hz–5 kHz, otherwise -1. */
export function chromaMap(size, sampleRate) {
  const map = new Int8Array(size / 2 + 1).fill(-1);
  for (let bin = 1; bin <= size / 2; bin++) {
    const hz = (bin * sampleRate) / size;
    if (hz < 55 || hz > 5000) continue;
    const midi = Math.round(69 + 12 * Math.log2(hz / 440));
    map[bin] = ((midi % 12) + 12) % 12;
  }
  return map;
}

/** The FFT size used for a frame of about `seconds` at a sample rate. */
export const frameSizeFor = (sampleRate, seconds = 0.09) => 2 ** Math.ceil(Math.log2(sampleRate * seconds));

export function cosine(a, b) {
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) { dot += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i]; }
  if (na <= 0 || nb <= 0) return null;
  return dot / Math.sqrt(na * nb);
}

export function pearson(a, b) {
  const n = a.length;
  if (n < 2) return null;
  let ma = 0, mb = 0;
  for (let i = 0; i < n; i++) { ma += a[i]; mb += b[i]; }
  ma /= n; mb /= n;
  let cov = 0, va = 0, vb = 0;
  for (let i = 0; i < n; i++) { const x = a[i] - ma, y = b[i] - mb; cov += x * y; va += x * x; vb += y * y; }
  if (va <= 1e-18 || vb <= 1e-18) return null;
  return cov / Math.sqrt(va * vb);
}

/** Linear resampling of a sequence of frame values to `points` evenly spaced samples. */
export function resample(values, points) {
  const out = new Float64Array(points);
  if (!values.length) return out;
  if (values.length === 1) return out.fill(values[0]);
  for (let i = 0; i < points; i++) {
    const x = (i * (values.length - 1)) / Math.max(1, points - 1);
    const lo = Math.floor(x);
    const hi = Math.min(values.length - 1, lo + 1);
    out[i] = values[lo] + (values[hi] - values[lo]) * (x - lo);
  }
  return out;
}

/** Round a non-integer to `digits` significant digits for stable, compact reports. */
export const round = (value, digits = 5) => (value === null || value === undefined || !Number.isFinite(value)
  ? value ?? null
  : Number.isInteger(value) ? value : Number(value.toPrecision(digits)) || 0);
