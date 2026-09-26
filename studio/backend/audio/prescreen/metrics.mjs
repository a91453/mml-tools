// Per-bar prescreen metrics. Pure: no I/O, no rendering.
//
// Status: IMPLEMENTATION NOTES. Every metric is "lower is better", computed
// per bar of the meter map, deterministic, and documented in
// docs/AUDIO_PRESCREEN.md. Two kinds:
//
//   note-level model  roughness and decay smear. Each note is a set of
//                     harmonic partials whose levels, held decay and release
//                     time were measured from single notes rendered with the
//                     same bank and engine (renderer-core `calibrate`). A model
//                     is what lets a number point at the event pair that
//                     produced it, e.g. one low minor second.
//   rendered signal   masking and clipping, from the rendered per-role signals
//                     and the rendered mix; original-audio similarity from the
//                     rendered mix against the recording.
//
// None of these is a musical verdict. They are machine evidence that two
// alternatives sound measurably different in a stated way.
import { cosine, pearson, resample } from './dsp.mjs';
import { tempoClock } from './performance.mjs';
import { ANCHOR_PITCHES, PARTIALS, voiceKey } from './renderer-core-constants.mjs';
import { soundingPitch } from '../instruments.mjs';

export const METRICS_VERSION = 'mml-studio/prescreen-metrics@1';
export const SOUND_METRICS = Object.freeze(['roughness', 'masking', 'smear', 'clipping']);
export const ORIGINAL_METRIC = 'original_similarity';
export const ALL_METRICS = Object.freeze([...SOUND_METRICS, ORIGINAL_METRIC]);

// Sethares' fit of the Plomp-Levelt dissonance curve (Δf in Hz), normalised so
// that one pair of equal pure partials at the roughest spacing scores 1.
const SETHARES = Object.freeze({ b1: 3.5, b2: 5.75, xStar: 0.24, s1: 0.0207, s2: 18.96 });
const SETHARES_PEAK = Math.exp(-SETHARES.b1 * SETHARES.xStar) - Math.exp(-SETHARES.b2 * SETHARES.xStar);

export const METRIC_SETTINGS = Object.freeze({
  // Pairs whose lower note is at or below this MIDI pitch count as low/mid
  // (B4 = 71). Higher pairs are reported, not used for the decision.
  lowMidMaxPitch: 71,
  roughnessStepSeconds: 0.05,
  roughnessMaxSamplesPerSegment: 32,
  tailFloor: 0.01,
  maxTailSeconds: 4,
  smearWindowSeconds: 0.1,
  maskingOffsetDb: 6,
  maskingTarget: 0.5,
  maskingWeights: Object.freeze([2, 1, 1, 1, 1, 1]),
  onsetPoints: 16,
  attributionPerBar: 2,
});

const NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
const INTERVALS = ['P1', 'm2', 'M2', 'm3', 'M3', 'P4', 'TT', 'P5', 'm6', 'M6', 'm7', 'M7'];
export const pitchName = pitch => `${NAMES[pitch % 12]}${Math.floor(pitch / 12) - 1}`;
const noteLabel = (performance, note) => `${performance.roles[note.role].name}:${note.drum ? 'drum' : pitchName(note.pitch)}@${note.start}`;
export const intervalName = (a, b) => {
  const d = Math.abs(a - b);
  return `${INTERVALS[d % 12]}${d >= 12 ? `+${Math.floor(d / 12)}oct` : ''}`;
};

// ─── the note model ─────────────────────────────────────────────────────────

function modelAt(profile, pitch) {
  const anchors = profile.anchors;
  // A drum's anchors are its kit notes: the one struck, not a blend.
  if (profile.drum) return anchors.find(anchor => anchor.pitch === pitch) ?? anchors[0];
  if (anchors.length === 1) return anchors[0];
  if (pitch <= anchors[0].pitch) return anchors[0];
  if (pitch >= anchors.at(-1).pitch) return anchors.at(-1);
  let i = 0;
  while (anchors[i + 1].pitch < pitch) i++;
  const a = anchors[i], b = anchors[i + 1];
  const w = (pitch - a.pitch) / (b.pitch - a.pitch);
  const geo = (x, y) => Math.exp(Math.log(x) * (1 - w) + Math.log(y) * w);
  const hold = (a.hold_tau_seconds === null || b.hold_tau_seconds === null) ? (a.hold_tau_seconds ?? b.hold_tau_seconds) : geo(a.hold_tau_seconds, b.hold_tau_seconds);
  const partials = a.partials.map((value, k) => value * (1 - w) + b.partials[k] * w);
  const norm = Math.sqrt(partials.reduce((sum, value) => sum + value * value, 0)) || 1;
  return {
    pitch,
    level: geo(Math.max(a.level, 1e-9), Math.max(b.level, 1e-9)),
    hold_tau_seconds: hold,
    release_tau_seconds: geo(a.release_tau_seconds, b.release_tau_seconds),
    partials: partials.map(value => value / norm),
  };
}

/** Timed, modelled notes of a performance: amplitude envelopes and partials. */
export function modelNotes(performance, profiles) {
  const notes = [];
  for (const role of performance.roles) {
    const profile = profiles[voiceKey(role)];
    if (!profile) throw Error(`no calibration for voice ${voiceKey(role)}`);
    for (const note of role.notes) {
      const model = modelAt(profile, soundingPitch(role, note.pitch));
      const amplitude = model.level * (profile.volume_gain[note.volume] ?? 1);
      const holdTau = model.hold_tau_seconds ?? Infinity;
      const releaseTau = model.release_tau_seconds;
      const atRelease = amplitude * (Number.isFinite(holdTau) ? Math.exp(-(note.off - note.on) / holdTau) : 1);
      const tailEnd = note.off + Math.min(METRIC_SETTINGS.maxTailSeconds, releaseTau * Math.log(1 / METRIC_SETTINGS.tailFloor));
      const f0 = 440 * 2 ** ((note.pitch - 69) / 12);
      notes.push({
        role: role.index,
        pitch: note.pitch,
        drum: profile.drum,
        start: note.start,
        on: note.on,
        off: note.off,
        amplitude,
        atRelease,
        holdTau,
        releaseTau,
        tailEnd,
        partials: profile.drum ? null : model.partials.map((a, k) => ({ hz: (k + 1) * f0, a })).filter(p => p.a > 1e-4),
      });
    }
  }
  return notes.sort((a, b) => a.on - b.on || a.role - b.role || a.pitch - b.pitch);
}

export function envelopeAt(note, t) {
  if (t < note.on) return 0;
  if (t < note.off) return note.amplitude * (Number.isFinite(note.holdTau) ? Math.exp(-(t - note.on) / note.holdTau) : 1);
  return note.atRelease * Math.exp(-(t - note.off) / note.releaseTau);
}

/** Bar boundaries of one performance in seconds, through its own tempo map. */
export function barSeconds(performance, bars) {
  const clock = tempoClock(performance.tempo);
  return bars.map(bar => ({ bar: bar.bar, start: clock.seconds(bar.startExact), end: clock.seconds(bar.endExact) }));
}

const barIndexAt = (spans, t) => {
  let lo = 0, hi = spans.length - 1;
  if (!spans.length || t < spans[0].start || t >= spans[hi].end) return -1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (spans[mid].start <= t) lo = mid; else hi = mid - 1;
  }
  return t >= spans[lo].start && t < spans[lo].end ? lo : -1;
};

// ─── source inheritance ─────────────────────────────────────────────────────
//
// Dissonance that is already in the source is not a defect of an alternative.
// A pair is source-inherited when the reference holds both of its attacks
// (same pitch, onset within 1/32 beat) and those two reference notes overlap.

const ONSET_TOLERANCE_BEATS = 1 / 32;

export function referenceIndex(reference) {
  if (!reference) return null;
  const byPitch = new Map();
  for (const note of reference.notes) {
    if (!byPitch.has(note.pitch)) byPitch.set(note.pitch, []);
    byPitch.get(note.pitch).push(note);
  }
  return byPitch;
}

function inherited(index, x, y) {
  if (!index) return false;
  const xs = (index.get(x.pitch) ?? []).filter(note => Math.abs(note.start - x.start) <= ONSET_TOLERANCE_BEATS);
  if (!xs.length) return false;
  const ys = (index.get(y.pitch) ?? []).filter(note => Math.abs(note.start - y.start) <= ONSET_TOLERANCE_BEATS);
  // Held intervals, extended by a quarter beat for the tail each reference
  // note would ring with too.
  return xs.some(a => ys.some(b => a !== b && a.start < b.end + 0.25 && b.start < a.end + 0.25));
}

// ─── roughness ──────────────────────────────────────────────────────────────

function partialPairs(x, y) {
  const pairs = [];
  for (const p of x.partials) {
    for (const q of y.partials) {
      const df = Math.abs(p.hz - q.hz);
      const s = SETHARES.xStar / (SETHARES.s1 * Math.min(p.hz, q.hz) + SETHARES.s2);
      if (s * df > 12) continue;
      const d = (Math.exp(-SETHARES.b1 * s * df) - Math.exp(-SETHARES.b2 * s * df)) / SETHARES_PEAK;
      if (d > 1e-6) pairs.push({ ap: p.a, aq: q.a, d });
    }
  }
  return pairs;
}

/**
 * Sensory roughness per bar (Sethares' partial-pair model over the modelled
 * envelopes), as a time average over the bar: amplitude units, where one
 * sustained pair of equal full-scale pure tones at the roughest spacing is 1.
 * Every contribution is attributed to its note pair.
 */
export function roughnessByBar(performance, profiles, bars, reference = null) {
  const settings = METRIC_SETTINGS;
  const spans = barSeconds(performance, bars);
  const index = referenceIndex(reference);
  const notes = modelNotes(performance, profiles).filter(note => !note.drum);
  const results = spans.map(span => ({ bar: span.bar, lowMid: 0, high: 0, inheritedLowMid: 0, pairs: new Map(), duration: Math.max(1e-9, span.end - span.start) }));
  for (let i = 0; i < notes.length; i++) {
    const x = notes[i];
    for (let j = i + 1; j < notes.length; j++) {
      const y = notes[j];
      if (y.on >= x.tailEnd) break;
      const t0 = y.on;
      const t1 = Math.min(x.tailEnd, y.tailEnd);
      if (t1 <= t0) continue;
      const pairs = partialPairs(x, y);
      if (!pairs.length) continue;
      const lowMid = Math.min(x.pitch, y.pitch) <= settings.lowMidMaxPitch;
      const isInherited = inherited(index, x, y);
      let b = barIndexAt(spans, t0);
      if (b < 0) b = spans.findIndex(span => span.end > t0);
      for (; b >= 0 && b < spans.length && spans[b].start < t1; b++) {
        const s0 = Math.max(t0, spans[b].start), s1 = Math.min(t1, spans[b].end);
        if (s1 <= s0) continue;
        const samples = Math.min(settings.roughnessMaxSamplesPerSegment, Math.max(1, Math.ceil((s1 - s0) / settings.roughnessStepSeconds)));
        const dt = (s1 - s0) / samples;
        let total = 0;
        for (let m = 0; m < samples; m++) {
          const t = s0 + (m + 0.5) * dt;
          const ax = envelopeAt(x, t), ay = envelopeAt(y, t);
          let d = 0;
          for (const pair of pairs) d += Math.min(ax * pair.ap, ay * pair.aq) * pair.d;
          total += d * dt;
        }
        if (total <= 0) continue;
        const result = results[b];
        const value = total / result.duration;
        if (lowMid) { result.lowMid += value; if (isInherited) result.inheritedLowMid += value; }
        else result.high += value;
        if (lowMid) {
          const key = `${x.role}:${x.pitch}:${x.start}|${y.role}:${y.pitch}:${y.start}`;
          const entry = result.pairs.get(key) ?? { x, y, value: 0, inherited: isInherited };
          entry.value += value;
          result.pairs.set(key, entry);
        }
      }
    }
  }
  return results.map(result => ({
    bar: result.bar,
    low_mid: result.lowMid,
    inherited_low_mid: result.inheritedLowMid,
    // The decision value: low/mid roughness the reference does not already have.
    value: Math.max(0, result.lowMid - result.inheritedLowMid),
    high: result.high,
    attribution: [...result.pairs.values()]
      .filter(entry => entry.value >= 0.01 * result.lowMid)
      .sort((a, b) => b.value - a.value || a.x.on - b.x.on)
      .slice(0, settings.attributionPerBar)
      .map(entry => ({
        // "<role>:<pitch>@<onset beat>" for each note of the pair.
        notes: [noteLabel(performance, entry.x), noteLabel(performance, entry.y)],
        interval: intervalName(entry.x.pitch, entry.y.pitch),
        value: entry.value,
        share: result.lowMid > 0 ? entry.value / result.lowMid : 0,
        source_inherited: entry.inherited,
      })),
  }));
}

/**
 * Every modelled low/mid pair of the whole performance with its total
 * roughness, strongest first (for ranking named spots across a song).
 */
export function roughPairs(performance, profiles, { from = 0, to = Infinity } = {}) {
  const notes = modelNotes(performance, profiles).filter(note => !note.drum);
  const out = [];
  for (let i = 0; i < notes.length; i++) {
    const x = notes[i];
    for (let j = i + 1; j < notes.length; j++) {
      const y = notes[j];
      if (y.on >= x.tailEnd) break;
      const t0 = Math.max(y.on, from), t1 = Math.min(x.tailEnd, y.tailEnd, to);
      if (t1 <= t0 || Math.min(x.pitch, y.pitch) > METRIC_SETTINGS.lowMidMaxPitch) continue;
      const pairs = partialPairs(x, y);
      const samples = Math.min(64, Math.max(1, Math.ceil((t1 - t0) / METRIC_SETTINGS.roughnessStepSeconds)));
      const dt = (t1 - t0) / samples;
      let total = 0;
      for (let m = 0; m < samples; m++) {
        const t = t0 + (m + 0.5) * dt;
        const ax = envelopeAt(x, t), ay = envelopeAt(y, t);
        for (const pair of pairs) total += Math.min(ax * pair.ap, ay * pair.aq) * pair.d * dt;
      }
      if (total > 0) out.push({ x, y, roughness: total });
    }
  }
  return out.sort((a, b) => b.roughness - a.roughness);
}

// ─── decay smear ────────────────────────────────────────────────────────────

const smearWeight = (tail, attack) => {
  if (tail.drum) return 0.25;
  const d = Math.abs(tail.pitch - attack.pitch);
  if (d === 0) return 0;
  return d <= 12 ? 1 : 0.5;
};

/**
 * Decay smear per bar: for each pitched attack, the energy of released notes'
 * tails (any role) in the first `smearWindowSeconds` after it, relative to the
 * attack's own energy there, weighted by pitch distance (a re-struck pitch
 * does not blur, a cymbal tail blurs a little). The bar value is the mean over
 * its attacks.
 */
export function smearByBar(performance, profiles, bars) {
  const W = METRIC_SETTINGS.smearWindowSeconds;
  const spans = barSeconds(performance, bars);
  const notes = modelNotes(performance, profiles);
  const byOff = [...notes].sort((a, b) => a.off - b.off);
  const results = spans.map(span => ({ bar: span.bar, sum: 0, attacks: 0, worst: null }));
  for (const attack of notes) {
    if (attack.drum) continue;
    const b = barIndexAt(spans, attack.on);
    if (b < 0) continue;
    const held = Math.min(W, attack.off - attack.on);
    const attackEnergy = Number.isFinite(attack.holdTau)
      ? attack.amplitude ** 2 * (attack.holdTau / 2) * (1 - Math.exp((-2 * held) / attack.holdTau))
      : attack.amplitude ** 2 * held;
    let tails = 0;
    let strongest = null;
    // Released notes whose tail still rings at this attack.
    let lo = 0, hi = byOff.length;
    while (lo < hi) { const mid = (lo + hi) >> 1; if (byOff[mid].off <= attack.on + 1e-9) lo = mid + 1; else hi = mid; }
    for (let k = lo - 1; k >= 0; k--) {
      const tail = byOff[k];
      if (tail === attack) continue;
      if (tail.off < attack.on - METRIC_SETTINGS.maxTailSeconds) break;
      if (tail.tailEnd <= attack.on) continue;
      const weight = smearWeight(tail, attack);
      if (!weight) continue;
      const a0 = attack.on - tail.off, a1 = a0 + W;
      const energy = tail.atRelease ** 2 * (tail.releaseTau / 2) * (Math.exp((-2 * a0) / tail.releaseTau) - Math.exp((-2 * a1) / tail.releaseTau));
      const contribution = (weight * energy) / Math.max(attackEnergy, 1e-12);
      tails += contribution;
      if (!strongest || contribution > strongest.value) strongest = { tail, value: contribution };
    }
    const result = results[b];
    result.sum += tails;
    result.attacks++;
    if (strongest && (!result.worst || tails > result.worst.ratio)) {
      result.worst = { attack: noteLabel(performance, attack), strongest_tail: noteLabel(performance, strongest.tail), ratio: tails };
    }
  }
  return results.map(result => ({ bar: result.bar, value: result.attacks ? result.sum / result.attacks : 0, attacks: result.attacks, worst: result.worst }));
}

// ─── masking ────────────────────────────────────────────────────────────────

/**
 * Role audibility per bar from the rendered per-role signals. In each frame a
 * held role is audible in a third-octave band when its energy there is no
 * more than `maskingOffsetDb` below everything else in that band; its frame
 * audibility is the share of its own energy in such bands. The bar value is
 * the weighted shortfall below `maskingTarget` of every role holding a note
 * (Melody counts double), so 0 means every playing role can be heard.
 */
export function maskingByBar(performance, analysis, bars, startSec = 0) {
  const { frameSize, hop, bands, frameCount, bandEnergy } = analysis;
  const sampleRate = analysis.sampleRate;
  const kappa = 10 ** (-METRIC_SETTINGS.maskingOffsetDb / 10);
  const spans = barSeconds(performance, bars);
  const sums = spans.map(() => new Float64Array(6));
  const counts = spans.map(() => new Uint32Array(6));
  const pointers = new Array(6).fill(0);
  const held = performance.roles.map(role => [...role.notes].sort((a, b) => a.on - b.on));
  for (let i = 0; i < frameCount; i++) {
    const t = startSec + (i * hop + frameSize / 2) / sampleRate;
    const b = barIndexAt(spans, t);
    if (b < 0) continue;
    for (let r = 0; r < 6; r++) {
      const notes = held[r];
      while (pointers[r] < notes.length && notes[pointers[r]].off <= t) pointers[r]++;
      let active = false;
      for (let k = pointers[r]; k < notes.length && notes[k].on <= t; k++) if (notes[k].off > t) { active = true; break; }
      if (!active) continue;
      let own = 0, audible = 0;
      for (let band = 0; band < bands; band++) {
        const e = bandEnergy[(i * 6 + r) * bands + band];
        if (e <= 0) continue;
        let others = 0;
        for (let s = 0; s < 6; s++) if (s !== r) others += bandEnergy[(i * 6 + s) * bands + band];
        own += e;
        if (e >= kappa * others) audible += e;
      }
      sums[b][r] += own > 0 ? audible / own : 0;
      counts[b][r]++;
    }
  }
  return spans.map((span, b) => {
    const audibility = {};
    let value = 0;
    for (let r = 0; r < 6; r++) {
      if (!counts[b][r]) continue;
      const a = sums[b][r] / counts[b][r];
      audibility[performance.roles[r].name] = a;
      value += METRIC_SETTINGS.maskingWeights[r] * Math.max(0, METRIC_SETTINGS.maskingTarget - a) / METRIC_SETTINGS.maskingTarget;
    }
    return { bar: span.bar, value, audibility };
  });
}

// ─── clipping / peak ────────────────────────────────────────────────────────

/** Peak level (dBFS) and clipped duration (ms at |x| ≥ 0.999) of the rendered mix per bar. */
export function clippingByBar(performance, analysis, bars, startSec = 0) {
  const { hop, chunkPeak, chunkClipped } = analysis;
  const sampleRate = analysis.sampleRate;
  const spans = barSeconds(performance, bars);
  const peak = new Float64Array(spans.length);
  const clipped = new Float64Array(spans.length);
  for (let i = 0; i < chunkPeak.length; i++) {
    const b = barIndexAt(spans, startSec + ((i + 0.5) * hop) / sampleRate);
    if (b < 0) continue;
    peak[b] = Math.max(peak[b], chunkPeak[i]);
    clipped[b] += chunkClipped[i];
  }
  return spans.map((span, b) => ({
    bar: span.bar,
    value: (clipped[b] / sampleRate) * 1000,
    peak_dbfs: peak[b] > 0 ? 20 * Math.log10(peak[b]) : null,
  }));
}

// ─── original-audio similarity ──────────────────────────────────────────────

/**
 * Per-bar chroma (12 pitch-class energies) and onset envelope (spectral flux
 * resampled to `onsetPoints`) of a frame analysis, for bars given in seconds.
 */
export function featuresBySpan(analysis, spans, startSec = 0) {
  const { frameSize, hop, frameCount, chroma, flux } = analysis;
  const sampleRate = analysis.sampleRate;
  const out = spans.map(() => ({ chroma: new Float64Array(12), flux: [] }));
  for (let i = 0; i < frameCount; i++) {
    const b = barIndexAt(spans, startSec + (i * hop + frameSize / 2) / sampleRate);
    if (b < 0) continue;
    for (let pc = 0; pc < 12; pc++) out[b].chroma[pc] += chroma[i * 12 + pc];
    out[b].flux.push(flux[i]);
  }
  return out.map(entry => ({ chroma: [...entry.chroma], onset: [...resample(entry.flux, METRIC_SETTINGS.onsetPoints)], frames: entry.flux.length }));
}

/**
 * 1 − similarity to the original recording per bar: the mean of chroma cosine
 * similarity and onset-envelope correlation mapped to [0, 1]. Null for a bar
 * the recording's features do not cover.
 */
export function similarityValue(rendered, original) {
  if (!rendered || !original || original.frames < 2 || rendered.frames < 2) return null;
  const chroma = cosine(rendered.chroma, original.chroma);
  if (chroma === null) return null;
  const r = pearson(rendered.onset, original.onset);
  const onset = r === null ? 0.5 : (r + 1) / 2;
  return { value: 1 - (0.5 * chroma + 0.5 * onset), chroma_similarity: chroma, onset_similarity: onset };
}

export { ANCHOR_PITCHES, PARTIALS };
