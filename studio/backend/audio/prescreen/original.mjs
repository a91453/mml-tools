// Original-recording features for the similarity metric. Pure.
//
// The recording is reached through the project's active audio-alignment
// evidence: its beat↔seconds control points map each bar of the meter map
// to a span of the recording. A bar outside the control points' range has no
// span and is not compared (the alignment is never extrapolated).
import { chromaMap, createFft, frameSizeFor, hann } from './dsp.mjs';
import { featuresBySpan } from './metrics.mjs';

/** Recording seconds of a beat by piecewise-linear interpolation, or null outside the points. */
export function alignmentClock(controlPoints) {
  const points = [...controlPoints].sort((a, b) => a.beat - b.beat);
  return beat => {
    if (points.length < 2 || beat < points[0].beat || beat > points.at(-1).beat) return null;
    let i = 0;
    while (i < points.length - 2 && points[i + 1].beat < beat) i++;
    const a = points[i], b = points[i + 1];
    if (b.beat === a.beat) return a.seconds;
    return a.seconds + ((beat - a.beat) * (b.seconds - a.seconds)) / (b.beat - a.beat);
  };
}

/** Spans (recording seconds) of bars under an alignment; null where not covered. */
export function recordingSpans(bars, controlPoints) {
  const clock = alignmentClock(controlPoints);
  return bars.map(bar => {
    const start = clock(bar.start), end = clock(bar.end);
    return start === null || end === null || end <= start ? null : { bar: bar.bar, start, end };
  });
}

/** Chroma and onset features of a mono recording for each covered bar span. */
export function recordingFeatures(mono, sampleRate, spans) {
  const covered = spans.filter(Boolean);
  if (!covered.length) return spans.map(() => null);
  const frameSize = frameSizeFor(sampleRate, 0.09);
  const hop = frameSize / 2;
  const from = Math.max(0, Math.floor(Math.min(...covered.map(span => span.start)) * sampleRate) - frameSize);
  const to = Math.min(mono.length, Math.ceil(Math.max(...covered.map(span => span.end)) * sampleRate) + frameSize);
  const fft = createFft(frameSize);
  const win = hann(frameSize);
  const pcOf = chromaMap(frameSize, sampleRate);
  const frameCount = to - from >= frameSize ? Math.floor((to - from - frameSize) / hop) + 1 : 0;
  const chroma = new Float32Array(frameCount * 12);
  const flux = new Float32Array(frameCount);
  const re = new Float64Array(frameSize);
  const im = new Float64Array(frameSize);
  let previous = new Float64Array(frameSize / 2 + 1);
  let current = new Float64Array(frameSize / 2 + 1);
  for (let index = 0; index < frameCount; index++) {
    const start = from + index * hop;
    for (let i = 0; i < frameSize; i++) { re[i] = mono[start + i] * win[i]; im[i] = 0; }
    fft(re, im);
    let rise = 0;
    for (let bin = 1; bin <= frameSize / 2; bin++) {
      const power = re[bin] * re[bin] + im[bin] * im[bin];
      const pc = pcOf[bin];
      if (pc >= 0) chroma[index * 12 + pc] += power;
      const magnitude = Math.log1p(1000 * Math.sqrt(power));
      current[bin] = magnitude;
      if (magnitude > previous[bin]) rise += magnitude - previous[bin];
    }
    flux[index] = rise;
    [previous, current] = [current, previous];
  }
  const analysis = { sampleRate, frameSize, hop, frameCount, chroma, flux };
  const features = featuresBySpan(analysis, covered, from / sampleRate);
  let k = 0;
  return spans.map(span => (span ? features[k++] : null));
}
