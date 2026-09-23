// "Obvious" or "needs a person": the prescreen decision rule. Pure.
//
// Status: IMPLEMENTATION NOTES. The owner's principle: when the choice between
// alternatives is obvious the machine may decide; when it is not, the owner
// listens. The rule below is deliberately one-sided. It says OBVIOUS only when
//
//   1. at least one metric separates the alternatives decisively (its winner
//      leads the runner-up by the metric's margin threshold),
//   2. every decisive metric names the same winner,
//   3. on every other metric that winner is within tolerance of the best,
//   4. every metric that applies was actually measured, and
//   5. the winner departs no further from the source than any other
//      alternative in that bar (source fidelity outranks smoothness).
//
// Anything else is NEEDS_HUMAN with the reason(s). Bars in which the
// alternatives are identical (same notes, same instruments) are NO_DIFFERENCE.
// The thresholds are explicit configuration with a content-addressed identity
// (`apt:` + SHA-256), so a threshold change changes every report id.
//
// An OBVIOUS verdict is machine evidence only. Under the Published Canonical
// it selects nothing, accepts nothing and sets no gate.
import { sha256Hex } from '../../source/sha256.mjs';

export const DECISION_VERSION = 'mml-studio/prescreen-decision@1';

export const VERDICT = Object.freeze({
  OBVIOUS: 'OBVIOUS',
  NEEDS_HUMAN: 'NEEDS_HUMAN',
  NO_DIFFERENCE: 'NO_DIFFERENCE',
});

export const REASON = Object.freeze({
  METRICS_CONFLICT: 'METRICS_CONFLICT',
  MARGIN_TOO_SMALL: 'MARGIN_TOO_SMALL',
  NO_MACHINE_PREFERENCE: 'NO_MACHINE_PREFERENCE',
  METRIC_UNAVAILABLE: 'METRIC_UNAVAILABLE',
  SOURCE_FIDELITY_TRADEOFF: 'SOURCE_FIDELITY_TRADEOFF',
  SOURCE_FIDELITY_UNAVAILABLE: 'SOURCE_FIDELITY_UNAVAILABLE',
});

// Documented defaults (docs/AUDIO_PRESCREEN.md). For each metric (lower is
// better): a winner is decisive when (runner-up − best) ≥ max(margin_abs,
// margin_rel × runner-up); a metric is neutral when (worst − best) ≤
// max(tolerance_abs, tolerance_rel × worst); a winner is "within tolerance"
// when (its value − best) ≤ max(tolerance_abs, tolerance_rel × its value).
export const DEFAULT_THRESHOLDS = Object.freeze({
  // Low/mid roughness not inherited from the source, amplitude units.
  roughness: Object.freeze({ margin_abs: 0.004, margin_rel: 0.35, tolerance_abs: 0.0015, tolerance_rel: 0.15 }),
  // Weighted role-audibility shortfall (0 = every playing role audible).
  masking: Object.freeze({ margin_abs: 0.4, margin_rel: 0.35, tolerance_abs: 0.15, tolerance_rel: 0.15 }),
  // Mean tail-to-attack energy ratio.
  smear: Object.freeze({ margin_abs: 0.15, margin_rel: 0.35, tolerance_abs: 0.05, tolerance_rel: 0.15 }),
  // Clipped milliseconds in the bar.
  clipping: Object.freeze({ margin_abs: 1, margin_rel: 0.5, tolerance_abs: 0.25, tolerance_rel: 0.1 }),
  // 1 − similarity to the original recording.
  original_similarity: Object.freeze({ margin_abs: 0.06, margin_rel: 0.25, tolerance_abs: 0.03, tolerance_rel: 0.1 }),
});

const FIELDS = ['margin_abs', 'margin_rel', 'tolerance_abs', 'tolerance_rel'];

/** Merge a caller's overrides into the defaults; closed key set, finite and non-negative. */
export function normalizeThresholds(overrides = null) {
  const merged = {};
  if (overrides !== null && (typeof overrides !== 'object' || Array.isArray(overrides))) throw Error('thresholds must be an object');
  for (const key of Object.keys(overrides ?? {})) {
    if (!Object.hasOwn(DEFAULT_THRESHOLDS, key)) throw Error(`unknown threshold metric: ${String(key).slice(0, 40)}`);
    const value = overrides[key];
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw Error(`thresholds.${key} must be an object`);
    for (const field of Object.keys(value)) {
      if (!FIELDS.includes(field)) throw Error(`unknown threshold field: ${key}.${String(field).slice(0, 40)}`);
      if (typeof value[field] !== 'number' || !Number.isFinite(value[field]) || value[field] < 0 || value[field] > 1e6) throw Error(`thresholds.${key}.${field} must be a finite non-negative number`);
    }
  }
  for (const [metric, defaults] of Object.entries(DEFAULT_THRESHOLDS)) {
    merged[metric] = Object.freeze({ ...defaults, ...(overrides?.[metric] ?? {}) });
  }
  const values = Object.freeze(merged);
  const text = JSON.stringify({ decision: DECISION_VERSION, values });
  return Object.freeze({ id: `apt:${sha256Hex(new TextEncoder().encode(text))}`, decision: DECISION_VERSION, values });
}

const need = (t, runnerUp) => Math.max(t.margin_abs, t.margin_rel * runnerUp);
const tolerance = (t, value) => Math.max(t.tolerance_abs, t.tolerance_rel * value);

/** How one metric orders the alternatives in one bar. */
export function classifyMetric(values, t) {
  const entries = Object.entries(values);
  const sorted = [...entries].sort((a, b) => a[1] - b[1] || (a[0] < b[0] ? -1 : 1));
  const best = sorted[0][1];
  const runnerUp = sorted[1][1];
  const worst = sorted.at(-1)[1];
  if (worst - best <= tolerance(t, worst)) return { kind: 'neutral', best };
  const margin = runnerUp - best;
  if (margin >= need(t, runnerUp)) return { kind: 'decisive', winner: sorted[0][0], margin, need: need(t, runnerUp), best };
  return { kind: 'indecisive', leaders: sorted.filter(([, v]) => v - best < need(t, runnerUp)).map(([label]) => label), margin, need: need(t, runnerUp), best };
}

/**
 * One bar's verdict.
 *
 * `metrics`: { name: { available: boolean, reason?: string, values?: { label: number } } }
 * `fidelity`: { available: boolean, values?: { label: distance } }
 * `identical`: same notes and instruments in every alternative.
 * `symbolicSame`: same notes (instruments may differ).
 */
export function decideBar({ labels, metrics, fidelity, identical = false, symbolicSame = false, thresholds }) {
  if (identical) return { verdict: VERDICT.NO_DIFFERENCE, winner: null, reasons: [], decisive: {}, category: null };
  const reasons = [];
  const detail = [];
  const classes = {};
  for (const [name, metric] of Object.entries(metrics)) {
    if (!metric.available || labels.some(label => typeof metric.values?.[label] !== 'number' || !Number.isFinite(metric.values[label]))) {
      reasons.push(REASON.METRIC_UNAVAILABLE);
      detail.push({ reason: REASON.METRIC_UNAVAILABLE, metric: name, why: metric.reason ?? 'NOT_MEASURED' });
      continue;
    }
    classes[name] = classifyMetric(metric.values, thresholds.values[name]);
  }
  const decisive = Object.fromEntries(Object.entries(classes).filter(([, c]) => c.kind === 'decisive').map(([name, c]) => [name, { winner: c.winner, margin: c.margin, need: c.need }]));
  const winners = [...new Set(Object.values(decisive).map(entry => entry.winner))];
  let winner = null;
  if (!winners.length) {
    const indecisive = Object.entries(classes).filter(([, c]) => c.kind === 'indecisive').map(([name]) => name);
    reasons.push(indecisive.length ? REASON.MARGIN_TOO_SMALL : REASON.NO_MACHINE_PREFERENCE);
    if (indecisive.length) detail.push({ reason: REASON.MARGIN_TOO_SMALL, metrics: indecisive });
  } else if (winners.length > 1) {
    reasons.push(REASON.METRICS_CONFLICT);
    detail.push({ reason: REASON.METRICS_CONFLICT, winners: Object.fromEntries(Object.entries(decisive).map(([name, entry]) => [name, entry.winner])) });
  } else {
    winner = winners[0];
    for (const [name, c] of Object.entries(classes)) {
      if (c.kind === 'decisive') continue;
      const value = metrics[name].values[winner];
      if (value - c.best > tolerance(thresholds.values[name], value)) {
        reasons.push(REASON.METRICS_CONFLICT);
        detail.push({ reason: REASON.METRICS_CONFLICT, metric: name, winner_worse_by: value - c.best });
      }
    }
  }
  const candidate = winner ?? null;
  if (!symbolicSame) {
    if (!fidelity?.available) {
      reasons.push(REASON.SOURCE_FIDELITY_UNAVAILABLE);
      detail.push({ reason: REASON.SOURCE_FIDELITY_UNAVAILABLE, why: fidelity?.reason ?? 'NO_REFERENCE' });
    } else if (candidate !== null) {
      const least = Math.min(...labels.map(label => fidelity.values[label]));
      if (fidelity.values[candidate] > least) {
        reasons.push(REASON.SOURCE_FIDELITY_TRADEOFF);
        detail.push({ reason: REASON.SOURCE_FIDELITY_TRADEOFF, winner_distance: fidelity.values[candidate], least_distance: least });
      }
    }
  }
  const unique = [...new Set(reasons)].sort();
  if (!unique.length && candidate !== null) {
    return { verdict: VERDICT.OBVIOUS, winner: candidate, reasons: [], decisive, category: Object.keys(decisive).sort().join('+'), detail: [] };
  }
  return { verdict: VERDICT.NEEDS_HUMAN, winner: null, machine_leader: candidate, reasons: unique, decisive, category: null, detail };
}

/**
 * The alternatives a person should compare in a bar: every alternative no
 * other one beats clearly on some metric without being worse on any metric or
 * on source fidelity. Always at least two.
 */
export function contenders({ labels, metrics, fidelity, thresholds }) {
  const usable = Object.entries(metrics).filter(([, m]) => m.available && labels.every(label => Number.isFinite(m.values?.[label])));
  const dominated = label => labels.some(other => {
    if (other === label) return false;
    let clearlyBetter = false;
    for (const [name, m] of usable) {
      const t = thresholds.values[name];
      const mine = m.values[label], theirs = m.values[other];
      if (theirs - mine > tolerance(t, theirs)) return false;
      if (mine - theirs >= need(t, mine)) clearlyBetter = true;
    }
    if (fidelity?.available && fidelity.values[other] > fidelity.values[label]) return false;
    return clearlyBetter;
  });
  const kept = labels.filter(label => !dominated(label));
  return kept.length >= 2 ? kept : [...labels];
}
