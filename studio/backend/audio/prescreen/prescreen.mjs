// The audio prescreen: render 2-4 alternatives, measure them bar by bar, and
// say which bars have an obvious winner and which a person should hear.
//
// Status: IMPLEMENTATION NOTES. This module takes alternatives that are
// already resolved to performances (the Application Service resolves MML
// texts, candidates and artifacts) and returns a deterministic report. The
// report is machine evidence only:
//
//   - it never sets Gate 7 (original-audio evidence), Gate 6 player readback,
//     in_game or any other gate, and it selects nothing;
//   - the free GM bank it renders with is not the game's timbre;
//   - an OBVIOUS verdict is not an acceptance. The proposed rule that would
//     let such a verdict be applied provisionally
//     (docs/canonical-candidates/MACHINE_PRESCREEN_SELECTION.md) is an
//     unpublished draft; nothing here applies anything.
//
// Identical inputs, bank, renderer and thresholds produce the identical
// report and report id (`aps:` + SHA-256 of the report body).
import { sha256Hex } from '../../source/sha256.mjs';
import { round } from './dsp.mjs';
import { barsFor, meterText, tempoClock } from './performance.mjs';
import { ALL_METRICS, METRICS_VERSION, METRIC_SETTINGS, ORIGINAL_METRIC, SOUND_METRICS, similarityValue } from './metrics.mjs';
import { FIDELITY_VERSION, alternativeNotes, barSignatures, fidelityByBar } from './fidelity.mjs';
import { VERDICT, contenders, decideBar } from './decision.mjs';
import { recordingSpans } from './original.mjs';
import { CALIBRATION_ID, RENDERER_ID, RENDER_ENGINE, voiceKey } from './renderer-core-constants.mjs';

export const PRESCREEN_REPORT_SCHEMA = 'mml-studio/audio-prescreen-report@1';
export const PREROLL_SECONDS = 3;
export const SAMPLE_RATES = Object.freeze([22050, 44100]);
export const LABELS = Object.freeze(['A', 'B', 'C', 'D']);
export { CALIBRATION_ID, RENDERER_ID, RENDER_ENGINE };
export const RULE_DRAFT = 'docs/canonical-candidates/MACHINE_PRESCREEN_SELECTION.md';

export const PRESCREEN_NOTICE = '機器預篩只是機器證據：它不設定 Gate 7（原曲音訊證據）、Gate 6 玩家回讀或 in_game，也不選定、接受或套用任何版本。免費 GM 音色不是遊戲音色。'
  + ' Machine prescreen evidence only: it never sets Gate 7, player readback or in_game, and selects nothing. The free GM bank is not the game timbre.';

export const ORIGINAL_STATUS = Object.freeze({
  USED: 'USED',
  NOT_APPLICABLE: 'NOT_APPLICABLE',
  UNAVAILABLE: 'ORIGINAL_AUDIO_METRIC_UNAVAILABLE',
});

const digest = value => sha256Hex(new TextEncoder().encode(typeof value === 'string' ? value : JSON.stringify(value)));

/** The render-time identity of a performance: what was actually played. */
export const performanceDigest = performance => digest({
  tempo: performance.tempo,
  roles: performance.roles.map(role => ({ instrument: role.instrument, program: role.program, drumNote: role.drumNote, notes: role.notes.map(n => [n.pitch, n.startExact, n.endExact, n.volume]) })),
});

const roundDeep = value => {
  if (typeof value === 'number') return round(value, 5);
  if (Array.isArray(value)) return value.map(roundDeep);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, roundDeep(v)]));
  return value;
};

/** Voice profiles for every voice the alternatives use, measured once per bank and rate. */
async function profilesFor({ pool, bank, sampleRate, alternatives, cache }) {
  const voices = new Map();
  for (const alternative of alternatives) {
    for (const role of alternative.performance.roles) voices.set(voiceKey(role), { program: role.program, drumNote: role.drumNote });
  }
  const missing = [...voices.entries()].filter(([key]) => !cache.has(`${bank.sha256}:${sampleRate}:${key}`));
  if (missing.length) {
    const { profiles } = await pool.run('calibrate', { sampleRate, voices: missing.map(([, voice]) => voice) }, { bank });
    for (const [key, profile] of Object.entries(profiles)) cache.set(`${bank.sha256}:${sampleRate}:${key}`, profile);
  }
  return Object.fromEntries([...voices.keys()].sort().map(key => [key, cache.get(`${bank.sha256}:${sampleRate}:${key}`)]));
}

function selectBars(allBars, range) {
  if (!range) return allBars;
  const from = range.from ?? 1;
  const to = Math.min(range.to ?? allBars.length, allBars.length);
  if (!Number.isInteger(from) || !Number.isInteger(to) || from < 1 || to < from || from > allBars.length) throw Error(`bar_range must lie within bars 1-${allBars.length}`);
  return allBars.slice(from - 1, to);
}

function windowFor(performance, bars, whole) {
  if (whole) return null;
  const clock = tempoClock(performance.tempo);
  return { startSec: Math.max(0, clock.seconds(bars[0].startExact) - PREROLL_SECONDS), endSec: clock.seconds(bars.at(-1).endExact) };
}

/**
 * What a prescreen will render, known before anything renders: the bars it
 * measures and, per alternative, the span its render covers -- the whole
 * performance, or for a bar range the window from PREROLL_SECONDS before the
 * first bar to the end of the last. `renderSeconds[a]` is that span's length
 * (the renderer's fixed release tail not counted). Pure and cheap: the
 * Application Service checks it against its render-length limit before any
 * bank is loaded or any worker is dispatched.
 */
export function renderPlan({ alternatives, meter, pickup = null, barRange = null }) {
  const total = alternatives.reduce((max, alternative) => (alternative.performance.totalBeats > max.beats
    ? { beats: alternative.performance.totalBeats, exact: alternative.performance.totalExact } : max), { beats: 0, exact: '0' });
  const allBars = barsFor(total.exact, meter, { pickup });
  const bars = selectBars(allBars, barRange);
  const whole = bars.length === allBars.length;
  const windows = alternatives.map(alternative => windowFor(alternative.performance, bars, whole));
  const renderSeconds = alternatives.map((alternative, a) => (windows[a] ? windows[a].endSec - windows[a].startSec : alternative.performance.durationSeconds));
  return { allBars, bars, whole, windows, renderSeconds };
}

/**
 * The longest bar range starting at bar `from` whose render fits in
 * `maxSeconds` for every alternative, as { from, to }, or null when not even
 * bar `from` alone fits. A window's length only grows with `to`, so this is
 * a binary search over the bar grid.
 */
export function longestFittingRange({ alternatives, allBars, from, maxSeconds }) {
  const clocks = alternatives.map(alternative => tempoClock(alternative.performance.tempo));
  const first = allBars[from - 1];
  const starts = clocks.map(clock => Math.max(0, clock.seconds(first.startExact) - PREROLL_SECONDS));
  const fits = index => clocks.every((clock, a) => clock.seconds(allBars[index].endExact) - starts[a] <= maxSeconds);
  if (!fits(from - 1)) return null;
  let lo = from - 1, hi = allBars.length - 1;
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    if (fits(mid)) lo = mid; else hi = mid - 1;
  }
  return { from, to: allBars[lo].bar };
}

/**
 * Run a prescreen.
 *
 * alternatives: [{ label, source, mml_sha256, performance }], 2-4 of them.
 * reference:    { kind, id, sha256, notes } or null.
 * original:     { status, reason?, mono?, sampleRate?, controlPoints?, audio_sha256?, alignment_report_sha256?, alignment_candidate_id? }
 */
export async function runPrescreen({
  alternatives,
  reference = null,
  meter,
  pickup = null,
  barRange = null,
  thresholds,
  render = { sampleRate: 22050, channels: 1 },
  bankProvider,
  pool,
  profileCache = new Map(),
  original = { status: ORIGINAL_STATUS.NOT_APPLICABLE, reason: 'NO_ORIGINAL_AUDIO' },
  context = {},
  returnPcm = false,
}) {
  if (!Array.isArray(alternatives) || alternatives.length < 2 || alternatives.length > 4) throw Error('two to four alternatives are required');
  if (!SAMPLE_RATES.includes(render.sampleRate) || ![1, 2].includes(render.channels)) throw Error('render sample_rate must be 22050 or 44100 and channels 1 or 2');
  const labels = alternatives.map(alternative => alternative.label);
  const { allBars, bars, windows } = renderPlan({ alternatives, meter, pickup, barRange });

  const loaded = await bankProvider.load();
  const bank = { sha256: loaded.identity.sha256, bytes: loaded.bytes };
  const profiles = await profilesFor({ pool, bank, sampleRate: render.sampleRate, alternatives, cache: profileCache });
  const referenceNotes = reference?.notes ?? null;

  const analysed = await Promise.all(alternatives.map((alternative, a) => {
    const own = Object.fromEntries(alternative.performance.roles.map(role => [voiceKey(role), profiles[voiceKey(role)]]));
    return pool.run('analyze', {
      performance: alternative.performance,
      profiles: own,
      bars,
      reference: referenceNotes ? { notes: referenceNotes } : null,
      sampleRate: render.sampleRate,
      channels: render.channels,
      window: windows[a],
      returnPcm,
    }, { bank });
  }));

  // The recording, bar by bar through the active alignment.
  let originalFeatures = null;
  let originalStatus = { status: original.status, ...(original.reason ? { reason: original.reason } : {}) };
  if (original.status === ORIGINAL_STATUS.USED) {
    const spans = recordingSpans(bars, original.controlPoints);
    originalFeatures = await pool.run('original', { mono: original.mono, sampleRate: original.sampleRate, spans }, { transfer: [original.mono.buffer] });
    originalStatus = {
      status: ORIGINAL_STATUS.USED,
      audio_sha256: original.audio_sha256,
      alignment_report_sha256: original.alignment_report_sha256,
      alignment_candidate_id: original.alignment_candidate_id ?? null,
      bars_covered: spans.filter(Boolean).length,
    };
  } else if (original.status === ORIGINAL_STATUS.UNAVAILABLE) {
    originalStatus = {
      status: ORIGINAL_STATUS.UNAVAILABLE,
      reason: original.reason,
      audio_sha256: original.audio_sha256 ?? null,
      alignment_report_sha256: original.alignment_report_sha256 ?? null,
    };
  }

  const fidelity = referenceNotes
    ? alternatives.map(alternative => fidelityByBar(alternativeNotes(alternative.performance), referenceNotes, bars))
    : null;
  const signatures = alternatives.map(alternative => barSignatures(alternative.performance, bars));

  const barReports = bars.map((bar, index) => {
    const per = name => Object.fromEntries(labels.map((label, a) => [label, analysed[a].bars[index][name].value]));
    const metrics = {};
    for (const name of SOUND_METRICS) metrics[name] = { available: true, values: per(name) };
    let similarity = null;
    if (originalStatus.status === ORIGINAL_STATUS.USED) {
      const recording = originalFeatures[index];
      similarity = Object.fromEntries(labels.map((label, a) => [label, similarityValue(analysed[a].bars[index].features, recording)]));
      const missing = labels.some(label => similarity[label] === null);
      metrics[ORIGINAL_METRIC] = missing
        ? { available: false, reason: recording ? 'NO_COMPARABLE_SIGNAL_IN_BAR' : 'BAR_NOT_COVERED_BY_ALIGNMENT' }
        : { available: true, values: Object.fromEntries(labels.map(label => [label, similarity[label].value])) };
    } else if (originalStatus.status === ORIGINAL_STATUS.UNAVAILABLE) {
      metrics[ORIGINAL_METRIC] = { available: false, reason: originalStatus.reason };
    }
    const symbolicSame = signatures.every(sig => sig[index].notes === signatures[0][index].notes);
    const identical = symbolicSame && signatures.every(sig => sig[index].voices === signatures[0][index].voices);
    const fidelityEntry = fidelity
      ? { available: true, values: Object.fromEntries(labels.map((label, a) => [label, fidelity[a][index].distance])) }
      : { available: false, reason: 'NO_REFERENCE' };
    const decision = decideBar({ labels, metrics, fidelity: fidelityEntry, identical, symbolicSame, thresholds });
    const bestOf = decision.verdict === VERDICT.NEEDS_HUMAN ? contenders({ labels, metrics, fidelity: fidelityEntry, thresholds }) : null;
    return {
      bar: bar.bar,
      beats: [bar.startExact, bar.endExact],
      verdict: decision.verdict,
      winner: decision.winner,
      ...(decision.machine_leader ? { machine_leader: decision.machine_leader } : {}),
      category: decision.category,
      reasons: decision.reasons,
      ...(decision.detail?.length ? { detail: decision.detail } : {}),
      decisive: decision.decisive,
      ...(bestOf ? { contenders: bestOf } : {}),
      metrics: Object.fromEntries(Object.entries(metrics).map(([name, metric]) => [name, metric.available ? metric.values : { unavailable: metric.reason }])),
      fidelity: fidelity
        ? Object.fromEntries(labels.map((label, a) => [label, { distance: fidelity[a][index].distance, ...Object.fromEntries(Object.entries(fidelity[a][index].counts).filter(([, n]) => n)) }]))
        : null,
      evidence: Object.fromEntries(labels.map((label, a) => {
        const b = analysed[a].bars[index];
        return [label, {
          roughness: { low_mid: b.roughness.low_mid, inherited_low_mid: b.roughness.inherited_low_mid, high: b.roughness.high, attribution: b.roughness.attribution },
          audibility: Object.fromEntries(Object.entries(b.masking.audibility).map(([role, value]) => [role, round(value, 3)])),
          smear: { attacks: b.smear.attacks, worst: b.smear.worst },
          peak_dbfs: b.clipping.peak_dbfs,
          ...(similarity?.[label] ? { original: { chroma_similarity: similarity[label].chroma_similarity, onset_similarity: similarity[label].onset_similarity } } : {}),
        }];
      })),
    };
  });

  // Contiguous bars with one verdict, winner, category and reason set.
  const regions = [];
  for (const entry of barReports) {
    const key = JSON.stringify([entry.verdict, entry.winner, entry.category, entry.reasons]);
    const last = regions.at(-1);
    if (last && last.key === key && last.bars[1] === entry.bar - 1) {
      last.bars[1] = entry.bar;
      last.beats[1] = entry.beats[1];
      last.members.push(entry);
    } else {
      regions.push({ key, bars: [entry.bar, entry.bar], beats: [...entry.beats], members: [entry] });
    }
  }
  const regionReports = regions.map(region => {
    const first = region.members[0];
    const margins = {};
    if (first.verdict === VERDICT.OBVIOUS) {
      for (const name of Object.keys(first.decisive)) {
        margins[name] = Math.min(...region.members.map(member => member.decisive[name]?.margin ?? Infinity));
      }
    }
    const offered = first.verdict === VERDICT.NEEDS_HUMAN
      ? labels.filter(label => region.members.some(member => member.contenders?.includes(label)))
      : null;
    return {
      region_id: `bars-${region.bars[0]}-${region.bars[1]}`,
      bars: region.bars,
      beats: region.beats,
      verdict: first.verdict,
      winner: first.winner,
      category: first.category,
      reasons: first.reasons,
      ...(first.verdict === VERDICT.OBVIOUS ? { min_margins: margins } : {}),
      ...(offered ? { contenders: offered } : {}),
    };
  });

  const humanReview = regionReports.filter(region => region.verdict === VERDICT.NEEDS_HUMAN).map(region => ({
    region_id: region.region_id,
    bars: region.bars,
    beats: region.beats,
    alternatives: region.contenders,
    reasons: region.reasons,
    // Hook for the listen-link integration: a payload that opens these bars
    // of these alternatives for an A/B listen. Not implemented in this build.
    listen_link: null,
  }));

  const count = verdict => barReports.filter(entry => entry.verdict === verdict).length;
  const reasonCounts = {};
  for (const entry of barReports) for (const reason of entry.reasons) reasonCounts[reason] = (reasonCounts[reason] ?? 0) + 1;
  const wins = Object.fromEntries(labels.map(label => [label, barReports.filter(entry => entry.winner === label).length]));
  const calibration = { id: CALIBRATION_ID, sha256: digest(roundDeep(profiles)), voices: Object.keys(profiles) };

  const body = roundDeep({
    schema: PRESCREEN_REPORT_SCHEMA,
    authority: {
      evidence_class: 'MACHINE_PRESCREEN',
      gate_effects: 'NONE',
      never_sets: ['audio (Gate 7 original-audio evidence)', 'player_readback (Gate 6)', 'in_game', 'technical', 'source', 'mobile_adaptation', 'regression'],
      selects_or_applies: false,
      bank_is_game_timbre: false,
      auto_apply: {
        active: false,
        reason: 'CANONICAL_RULE_UNPUBLISHED',
        rule_draft: RULE_DRAFT,
        proposed_ledger_code: 'MACHINE_PRESCREEN_SELECTED',
      },
      notice: PRESCREEN_NOTICE,
    },
    inputs: {
      ...context,
      meter: meterText(meter),
      pickup: pickup ?? null,
      bar_range: barRange ? { from: bars[0].bar, to: bars.at(-1).bar } : null,
      bars_total: allBars.length,
    },
    alternatives: alternatives.map((alternative, a) => ({
      label: alternative.label,
      source: alternative.source,
      mml_sha256: alternative.mml_sha256 ?? null,
      performance_sha256: performanceDigest(alternative.performance),
      instruments: alternative.performance.roles.map(role => role.instrument),
      duration_seconds: alternative.performance.durationSeconds,
      warnings: alternative.performance.warnings,
      render: analysed[a].render,
    })),
    reference: reference
      ? { kind: reference.kind, id: reference.id ?? null, sha256: reference.sha256 ?? null, notes: referenceNotes.length }
      : { kind: null, available: false, notice: 'No source reference: bars where the alternatives differ symbolically cannot be decided by the machine (SOURCE_FIDELITY_UNAVAILABLE).' },
    bank: loaded.identity,
    renderer: {
      id: RENDERER_ID,
      engine: RENDER_ENGINE,
      sample_rate: render.sampleRate,
      channels: render.channels,
      effects: false,
      velocity_curve: 'v0-v15 → velocity max(1, round(v·127/15)) (Studio Web preview curve)',
      calibration,
    },
    metrics: {
      version: METRICS_VERSION,
      direction: 'lower_is_better',
      names: ALL_METRICS,
      settings: METRIC_SETTINGS,
      fidelity: FIDELITY_VERSION,
    },
    thresholds,
    original_audio: originalStatus,
    summary: {
      bars: barReports.length,
      obvious: count(VERDICT.OBVIOUS),
      needs_human: count(VERDICT.NEEDS_HUMAN),
      no_difference: count(VERDICT.NO_DIFFERENCE),
      human_review_regions: humanReview.length,
      obvious_wins: wins,
      reasons: reasonCounts,
    },
    regions: regionReports,
    human_review: humanReview,
    listen_link: {
      status: 'NOT_WIRED',
      notice: 'Each human_review item names its bars and the alternatives to compare; its listen_link stays null until the listen-link integration exists.',
    },
    bars: barReports,
  });
  const report = { schema: body.schema, report_id: `aps:${digest(body)}`, ...body };
  return returnPcm
    ? { report, pcm: Object.fromEntries(labels.map((label, a) => [label, analysed[a].pcm])) }
    : { report };
}
