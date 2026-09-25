// The audio prescreen (音色 A/B 預篩) as an Application Service operation,
// and its shadow-mode calibration record.
//
// Status: IMPLEMENTATION NOTES. It implements no Canonical rule and moves no
// gate. It resolves 2-4 alternatives (raw MML texts, or candidates and Final
// artifacts of a project), renders them with a free GM bank, measures them bar
// by bar and says, per bar, whether one alternative is obviously better by
// every applicable machine metric, or whether the owner should listen. It
// never writes a project record: the report is computed, returned and (in a
// small in-memory cache) kept for paging.
//
// Shadow mode. So that the owner can judge the machine before trusting it, a
// project keeps a calibration record in the service data directory: the
// predictions the owner chose to record, and the owner's actual choice for a
// region, recorded later by an explicit call naming who accepted it. The
// record is read back with per-metric and per-category agreement figures.
// Nothing reads it to apply anything; the draft rule that would let an
// obvious verdict be applied provisionally
// (docs/canonical-candidates/MACHINE_PRESCREEN_SELECTION.md) is unpublished,
// and the service carries no wiring for it.
import { ERROR_CODES, LIMITS, fail, isArtifactId, isCandidateId, isProjectId, requireString } from './contracts.mjs';
import { activeAudioEntries, audioReportHash, readAudioHistory } from './audio-report-history.mjs';
import { sha256Of } from './store.mjs';
import { f } from '../../../dist/core.js';
import { GAME_INSTRUMENT_IDS } from '../audio/instruments.mjs';
import { createSoundBankProvider, bankCacheDirectory, FREE_GM_BANK, SoundBankError } from '../audio/prescreen/sound-bank.mjs';
import { createRenderPool } from '../audio/prescreen/render-pool.mjs';
import {
  MAX_BARS, TEMPO_NOT_EXACT, meterFromCanonical, meterFromText, meterText, performanceFromCanonical, performanceFromTracks,
  referenceFromCanonical, referenceFromPerformance,
} from '../audio/prescreen/performance.mjs';
import { normalizeThresholds, VERDICT } from '../audio/prescreen/decision.mjs';
import {
  LABELS, ORIGINAL_STATUS, PREROLL_SECONDS, PRESCREEN_NOTICE, PRESCREEN_REPORT_SCHEMA, RULE_DRAFT, SAMPLE_RATES,
  firstFittingRangeAfter, longestFittingRange, renderPlan, runPrescreen,
} from '../audio/prescreen/prescreen.mjs';
import { ALL_METRICS } from '../audio/prescreen/metrics.mjs';
import { decodeWav } from '../audio/prescreen/wav.mjs';

export { PRESCREEN_REPORT_SCHEMA, PRESCREEN_NOTICE };
export const PRESCREEN_SHADOW_SCHEMA = 'mml-studio/audio-prescreen-shadow@1';
export const PRESCREEN_INPUT_KEYS = Object.freeze(['alternatives', 'meter_text', 'pickup', 'instruments', 'bar_range', 'reference', 'thresholds', 'render']);
export const PRESCREEN_ALTERNATIVE_KEYS = Object.freeze(['label', 'mml', 'candidate_id', 'artifact_id', 'instruments']);
export const SHADOW_ENTRIES = Object.freeze(['prediction', 'owner_choice']);
export const NO_PREFERENCE = 'NO_PREFERENCE';

export const PRESCREEN_LIMITS = Object.freeze({
  maxMmlCharacters: 40000,
  // The bar grid's own bound (performance.mjs), repeated so the limits are
  // advertised together.
  maxBars: MAX_BARS,
  // Seconds of audio rendered for one alternative: its whole performance, or
  // with bar_range the window from the 3 s pre-roll to the end of the last
  // bar. Checked before anything renders. Render time and analysis memory
  // grow linearly with it (about 14 MB of analysis buffers per 1,000 s at
  // either sample rate; CPU per second depends on the arrangement), and
  // neither the character limit nor the bar limit bounds it: 40,000
  // characters of whole notes at T32 under a 16/4 meter stay inside
  // MAX_BARS and last 83 hours, over 4 GB of analysis per alternative.
  //
  // 1,200 s (20 minutes). The longest real song this repository has carried
  // (a six-role Final, since moved out of the public tree with the other
  // real-song material) runs 311 s; the song-length test fixture runs 220 s.
  // Twenty minutes is about four times the longest, so real songs and long
  // arrangements pass whole, while one alternative stays at about 17 MB of
  // analysis buffers and, at that song's density with the pinned bank, about
  // 18 s of CPU at 22.05 kHz mono or 40 s at 44.1 kHz stereo (measured on
  // the 311 s song: 4.5 s and 10.4 s). Anything longer is prescreened
  // section by section with bar_range.
  maxRenderSeconds: 1200,
  maxPredictionsPerProject: 256,
  maxChoicesPerProject: 4096,
  reportCacheEntries: 8,
});

// What the draft rule recommends before a category could be published:
// agreement over at least this many owner choices, at or above this rate.
// Informational: nothing reads it to enable anything.
export const SHADOW_PUBLICATION_BAR = Object.freeze({ min_sample: 30, min_agreement: 0.95 });

const LABEL = /^[A-Za-z0-9_-]{1,16}$/;
const now = () => new Date().toISOString();
const refuse = (message, details = {}) => fail(ERROR_CODES.INVALID_REQUEST, message, details);

const ownKeys = (value, allowed, label) => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) refuse(`${label} must be an object`);
  for (const key of Object.keys(value)) if (!allowed.includes(key)) refuse(`${label}: unknown field ${String(key).slice(0, 40)}`, { field: String(key).slice(0, 40) });
  return value;
};

function instrumentsOf(value, label) {
  if (value === undefined || value === null) return null;
  if (!Array.isArray(value) || value.length !== 6 || value.some(id => !GAME_INSTRUMENT_IDS.includes(id))) {
    refuse(`${label} must list six instruments from: ${GAME_INSTRUMENT_IDS.join(', ')}`, { instruments: GAME_INSTRUMENT_IDS });
  }
  return [...value];
}

function mmlText(value, label) {
  if (typeof value !== 'string' || !value.trim() || value.length > PRESCREEN_LIMITS.maxMmlCharacters) refuse(`${label} must be a six-role MML string of at most ${PRESCREEN_LIMITS.maxMmlCharacters} characters`);
  if (/\d{4}/.test(value)) refuse(`${label} contains a number longer than three digits; Mobile MML needs none`);
  return value;
}

/** A closed, validated request. */
export function normalizePrescreenInput(input, { projectMode }) {
  ownKeys(input, PRESCREEN_INPUT_KEYS, 'prescreen request');
  const { alternatives } = input;
  if (!Array.isArray(alternatives) || alternatives.length < 2 || alternatives.length > 4) refuse('alternatives must list two to four alternatives');
  const sharedInstruments = instrumentsOf(input.instruments, 'instruments');
  const seen = new Set();
  const normalized = alternatives.map((alternative, index) => {
    ownKeys(alternative, PRESCREEN_ALTERNATIVE_KEYS, `alternatives[${index}]`);
    const kinds = ['mml', 'candidate_id', 'artifact_id'].filter(key => alternative[key] !== undefined);
    if (kinds.length !== 1) refuse(`alternatives[${index}] must name exactly one of mml, candidate_id or artifact_id`);
    const label = alternative.label ?? LABELS[index];
    if (typeof label !== 'string' || !LABEL.test(label) || label === NO_PREFERENCE || seen.has(label)) refuse(`alternatives[${index}].label must be a unique 1-16 character label (letters, digits, - or _)`);
    seen.add(label);
    const kind = kinds[0];
    if (kind !== 'mml' && !projectMode) refuse(`alternatives[${index}].${kind} needs a project_id`);
    if (kind === 'mml') mmlText(alternative.mml, `alternatives[${index}].mml`);
    if (kind === 'candidate_id' && !isCandidateId(alternative.candidate_id)) fail(ERROR_CODES.CANDIDATE_NOT_FOUND, 'Unknown candidate', { candidate_id: String(alternative.candidate_id).slice(0, 96) });
    if (kind === 'artifact_id' && !isArtifactId(alternative.artifact_id)) fail(ERROR_CODES.ARTIFACT_NOT_FOUND, 'Unknown artifact', { artifact_id: String(alternative.artifact_id).slice(0, 96) });
    return { label, kind, id: alternative[kind], instruments: instrumentsOf(alternative.instruments, `alternatives[${index}].instruments`) ?? sharedInstruments };
  });
  const meter = input.meter_text === undefined ? null : requireString(input.meter_text, 'meter_text', { max: LIMITS.maxMeterTextLength });
  if (normalized.some(entry => entry.kind === 'mml') && !meter) refuse('meter_text is required for MML alternatives: state the source-confirmed meter map, e.g. "0 4/4"; it is never assumed');
  const pickup = input.pickup === undefined ? null : requireString(input.pickup, 'pickup', { max: 32 });
  if (pickup && !/^\d+(?:\/\d+|\.\d{1,9})?$/.test(pickup)) refuse('pickup must be a non-negative integer, decimal or fraction of beats');
  let barRange = null;
  if (input.bar_range !== undefined) {
    ownKeys(input.bar_range, ['from', 'to'], 'bar_range');
    const { from = 1, to } = input.bar_range;
    if (!Number.isSafeInteger(from) || from < 1 || (to !== undefined && (!Number.isSafeInteger(to) || to < from))) refuse('bar_range must be { from, to } with 1 ≤ from ≤ to');
    barRange = { from, to: to ?? null };
  }
  // The source reference for fidelity: a caller's reference MML, or a
  // candidate of the project. Omitted in a project, it is the project's
  // Source-Faithful Baseline.
  let referenceMml = null;
  let referenceCandidateId = null;
  if (input.reference !== undefined) {
    ownKeys(input.reference, ['mml', 'candidate_id'], 'reference');
    const named = ['mml', 'candidate_id'].filter(key => input.reference[key] !== undefined);
    if (named.length !== 1) refuse('reference must name exactly one of mml or candidate_id');
    if (named[0] === 'mml') referenceMml = mmlText(input.reference.mml, 'reference.mml');
    else {
      if (!projectMode) refuse('reference.candidate_id needs a project_id');
      if (!isCandidateId(input.reference.candidate_id)) fail(ERROR_CODES.CANDIDATE_NOT_FOUND, 'Unknown candidate', { candidate_id: String(input.reference.candidate_id).slice(0, 96) });
      referenceCandidateId = input.reference.candidate_id;
    }
  }
  let render = { sampleRate: 22050, channels: 1 };
  if (input.render !== undefined) {
    ownKeys(input.render, ['sample_rate', 'channels'], 'render');
    render = { sampleRate: input.render.sample_rate ?? 22050, channels: input.render.channels ?? 1 };
    if (!SAMPLE_RATES.includes(render.sampleRate) || ![1, 2].includes(render.channels)) refuse('render.sample_rate must be 22050 or 44100 and render.channels 1 or 2');
  }
  let thresholds;
  try { thresholds = normalizeThresholds(input.thresholds ?? null); }
  catch (error) { refuse(error.message); }
  return { alternatives: normalized, meter, pickup, barRange, referenceMml, referenceCandidateId, render, thresholds };
}

// A bar grid, bar_range or pickup the request got wrong, as the prescreen
// engine words it.
const isRequestProblem = error => /bar_range|meter|no notes|bars|pickup/.test(error?.message ?? '');
const roundSeconds = value => Math.round(value * 1000) / 1000;

/**
 * The render plan for resolved alternatives, refused when any alternative's
 * render would be longer than PRESCREEN_LIMITS.maxRenderSeconds. Runs before
 * the sound bank is loaded, a recording decoded or a worker dispatched: the
 * length is known from the performances alone.
 */
export function plannedRender({ alternatives, meter, pickup, barRange }) {
  let plan;
  try { plan = renderPlan({ alternatives, meter, pickup, barRange }); }
  catch (error) {
    if (isRequestProblem(error)) refuse(error.message);
    throw error;
  }
  const max = PRESCREEN_LIMITS.maxRenderSeconds;
  const over = alternatives.filter((_, a) => plan.renderSeconds[a] > max).map(alternative => alternative.label);
  if (!over.length) return plan;
  const from = plan.bars[0].bar;
  const suggested = longestFittingRange({ alternatives, allBars: plan.allBars, from, maxSeconds: max });
  // With the first bar itself over the limit, name a later section that
  // fits, or say that none does, rather than advise a range that cannot work.
  const later = suggested ? null : firstFittingRangeAfter({ alternatives, allBars: plan.allBars, from, maxSeconds: max });
  const longest = Math.max(...plan.renderSeconds);
  const span = plan.whole ? 'the whole song' : `bars ${from}-${plan.bars.at(-1).bar} (with the ${PREROLL_SECONDS} s pre-roll)`;
  const next = suggested && suggested.to < plan.allBars.length ? `, then continue from bar ${suggested.to + 1}` : '';
  refuse(`Rendering ${span} would take ${Math.ceil(longest)} s of audio for alternative${over.length > 1 ? 's' : ''} ${over.join(', ')}; the prescreen renders at most ${max} s (${max / 60} minutes) per alternative. `
    + (suggested
      ? `Prescreen it in sections with bar_range, for example {"from": ${suggested.from}, "to": ${suggested.to}}${next}.`
      : later
        ? `Even bar ${from} alone is longer than that; the first section after it that fits is bar_range {"from": ${later.from}, "to": ${later.to}}.`
        : `Even bar ${from} alone is longer than that, and so is every bar after it, so no section from bar ${from} on can be prescreened.`), {
    reason: 'RENDER_TOO_LONG',
    max_render_seconds: max,
    render_seconds: Object.fromEntries(alternatives.map((alternative, a) => [alternative.label, roundSeconds(plan.renderSeconds[a])])),
    over_limit: over,
    bars_total: plan.allBars.length,
    bar_range: plan.whole ? null : { from, to: plan.bars.at(-1).bar },
    suggested_bar_range: suggested,
    ...(suggested ? {} : { later_bar_range: later }),
  });
}

/**
 * The prescreen service.
 *
 * `audioPrescreen` options (all optional): `bank` (descriptor), `bytes`
 * (inject a bank), `fetchImpl`, `allowDownload`, `cacheDirectory`, `poolSize`,
 * `renderPool` (a render pool to use instead of the service's own; the caller
 * keeps it and closes it).
 */
export function createPrescreenService({ canonical, projects, intake, arrangement, final, assets, store, dataDirectory = null, options = {} }) {
  const env = process.env;
  const bankProvider = options.bankProvider ?? createSoundBankProvider({
    bank: options.bank ?? FREE_GM_BANK,
    bytes: options.bytes ?? null,
    cacheDirectory: options.cacheDirectory ?? bankCacheDirectory({ dataDirectory, env }),
    fetchImpl: options.fetchImpl ?? globalThis.fetch,
    allowDownload: options.allowDownload ?? env.MML_STUDIO_AUDIO_BANK_FETCH !== '0',
  });
  let pool = null;
  const poolFor = () => (pool ??= options.renderPool ?? createRenderPool(options.poolSize ? { size: options.poolSize } : {}));
  const profileCache = new Map();
  const reportCache = new Map();

  const parseMml = (engines, text, label, instruments) => {
    let tracks;
    try { tracks = engines.mml.splitMML(text); }
    catch (error) { refuse(`${label}: ${error.message}`); }
    const roles = ['Melody', 'Chord1', 'Chord2', 'Chord3', 'Chord4', 'Chord5'];
    const parsed = tracks.map((track, index) => engines.mml.parseTrack(track, roles[index], { mode: 'ingest' }));
    const errors = parsed.flatMap(track => track.errors);
    if (errors.length) refuse(`${label} does not parse`, { errors: errors.slice(0, 5).map(error => ({ role: error.role, position: error.position, message: error.message, code: error.code ?? null })), error_count: errors.length });
    return performanceFromTracks(parsed, { instruments });
  };

  const shadowKey = projectId => `prescreen-shadow:${projectId}`;
  const emptyShadow = projectId => ({ schema: PRESCREEN_SHADOW_SCHEMA, project_id: projectId, predictions: [], choices: [] });
  const readShadow = projectId => {
    const stored = store.getJson(shadowKey(projectId));
    return stored?.schema === PRESCREEN_SHADOW_SCHEMA && stored.project_id === projectId ? stored : emptyShadow(projectId);
  };

  /** Everything an alternative needs, resolved from the request. */
  async function resolve(owner, projectId, request) {
    const engines = await canonical.engines();
    const record = projectId === null ? null : projects.load(owner, projectId);
    const alternatives = [];
    const meters = [];
    const pickups = [];
    const candidatesInOrder = [];
    let pickup = request.pickup;
    for (const entry of request.alternatives) {
      if (entry.kind === 'mml') {
        alternatives.push({ label: entry.label, source: { kind: 'mml' }, mml_sha256: sha256Of(new TextEncoder().encode(entry.id)), performance: parseMml(engines, entry.id, `alternative ${entry.label}`, entry.instruments) });
      } else if (entry.kind === 'candidate_id') {
        const { candidate } = arrangement.loadCandidate(record, entry.id);
        let performance;
        try {
          performance = performanceFromCanonical(candidate, { instruments: entry.instruments });
        } catch (error) {
          // A Tempo the clock cannot hold exactly is a fact about this
          // candidate, refused by name rather than left to surface as an
          // internal error.
          if (error?.code !== TEMPO_NOT_EXACT) throw error;
          refuse(`alternative ${entry.label}: ${error.message}`, { candidate_id: entry.id, reason: TEMPO_NOT_EXACT, beat: error.beat, bpm: error.bpm });
        }
        alternatives.push({ label: entry.label, source: { kind: 'candidate', id: entry.id }, mml_sha256: null, performance });
        meters.push({ label: entry.label, meter: meterFromCanonical(candidate) });
        candidatesInOrder.push(entry.id);
      } else {
        const artifact = final.find(owner, entry.id);
        if (artifact?.project_id !== record.project_id) fail(ERROR_CODES.ARTIFACT_NOT_FOUND, 'Unknown artifact', { artifact_id: entry.id, project_id: record.project_id });
        if (artifact?.type !== 'final_mml' || typeof artifact.mml !== 'string' || !artifact.mml) refuse(`artifact ${entry.id} carries no delivered Final MML`, { artifact_id: entry.id });
        const digest = sha256Of(new TextEncoder().encode(artifact.mml));
        if (artifact.mml_sha256 && artifact.mml_sha256 !== digest) refuse(`artifact ${entry.id} MML does not match its recorded SHA-256`, { artifact_id: entry.id });
        alternatives.push({ label: entry.label, source: { kind: 'artifact', id: entry.id, candidate_id: artifact.candidate_id ?? null }, mml_sha256: digest, performance: parseMml(engines, artifact.mml, `artifact ${entry.id}`, entry.instruments) });
        if (artifact.final_bar?.meter_text) meters.push({ label: entry.label, meter: meterFromText(artifact.final_bar.meter_text) });
        // A delivered Final records its pickup beside its meter map; null there
        // is the statement that the Final starts on a bar line.
        if (artifact.final_bar && Object.hasOwn(artifact.final_bar, 'pickup')) pickups.push({ label: entry.label, pickup: artifact.final_bar.pickup ?? null });
        if (artifact.candidate_id) candidatesInOrder.push(artifact.candidate_id);
      }
    }
    let meter;
    try {
      meter = request.meter ? meterFromText(request.meter) : null;
    } catch (error) { refuse(`meter_text: ${error.message}`); }
    const distinct = [...new Set(meters.filter(entry => entry.meter.length).map(entry => meterText(entry.meter)))];
    if (!meter) {
      // Stating meter_text cannot reconcile maps that disagree: it must agree
      // with every declared one, so the refusal names the only remedy.
      if (distinct.length > 1) refuse('the alternatives declare different meter maps, so their bars would not line up; compare alternatives that share one meter map', { declared: distinct });
      if (!distinct.length) refuse('no meter map is known for these alternatives; state meter_text');
      meter = meterFromText(distinct[0]);
    } else if (distinct.length && distinct.some(text => text !== meterText(meter))) {
      refuse('meter_text differs from the meter map an alternative declares; the bars would not line up', { declared: distinct });
    }
    // Pickups are compared as meter maps are: a Final's pickup shifts every
    // bar line after it, so Finals declaring different pickups (a bar-aligned
    // one declares zero beats) cannot share one bar grid, and a stated pickup
    // must agree with every declared one. Compared as exact beat lengths.
    if (pickups.length) {
      const beatsOf = (text, label) => {
        try { return f(text ?? '0').toString(); }
        catch { return refuse(`${label} must be a non-negative integer, decimal or fraction of beats`); }
      };
      const declared = pickups.map(entry => ({ label: entry.label, pickup: beatsOf(entry.pickup, `alternative ${entry.label} pickup`) }));
      const distinctPickups = [...new Set(declared.map(entry => entry.pickup))];
      if (!pickup) {
        // As with meter maps, a stated pickup would contradict one of them.
        if (distinctPickups.length !== 1) refuse('the alternatives declare different pickups, so their bars would not line up; compare Finals that share one pickup', { declared });
        // All agree; zero is no pickup at all, as a bar-aligned Final records it.
        if (distinctPickups[0] !== '0') pickup = String(pickups[0].pickup);
      } else {
        const stated = beatsOf(pickup, 'pickup');
        if (distinctPickups.some(beats => beats !== stated)) refuse('pickup differs from the pickup an alternative declares; the bars would not line up', { declared });
      }
    }

    // The source reference for fidelity (and source-inherited roughness).
    let reference = null;
    if (request.referenceMml) {
      const performance = parseMml(engines, request.referenceMml, 'reference.mml', null);
      reference = { kind: 'mml', id: null, sha256: sha256Of(new TextEncoder().encode(request.referenceMml)), notes: referenceFromPerformance(performance).notes };
    } else if (request.referenceCandidateId) {
      const { candidate } = arrangement.loadCandidate(record, request.referenceCandidateId);
      reference = { kind: 'candidate', id: request.referenceCandidateId, sha256: null, notes: referenceFromCanonical(candidate).notes };
    } else if (record?.baseline) {
      const { baseline, project } = await intake.project(owner, projectId);
      reference = { kind: 'source_faithful_baseline', id: baseline.baseline_id, sha256: null, notes: referenceFromCanonical(project).notes };
    }

    const original = record ? originalAudioFor(owner, record, candidatesInOrder) : { status: ORIGINAL_STATUS.NOT_APPLICABLE, reason: 'NO_PROJECT' };
    return { alternatives, meter, pickup, reference, original, record };
  }

  /** The recording and its active alignment, when the project has both. */
  function originalAudioFor(owner, record, candidateIds) {
    const recordings = (record.assets ?? []).filter(asset => asset.kind === 'original_audio');
    if (!recordings.length) return { status: ORIGINAL_STATUS.NOT_APPLICABLE, reason: 'NO_ORIGINAL_AUDIO' };
    for (const candidateId of candidateIds) {
      let entries;
      try { entries = activeAudioEntries(readAudioHistory(store.getJson(`audio:${record.project_id}:${candidateId}`), candidateId, record.audio_evidence ?? [])); }
      catch { continue; }
      const entry = entries.find(item => recordings.some(asset => asset.sha256 === item.audio_sha256));
      if (!entry) continue;
      const identity = { audio_sha256: entry.audio_sha256, alignment_report_sha256: audioReportHash(entry.report), alignment_candidate_id: candidateId };
      if (entry.warnings?.length) return { status: ORIGINAL_STATUS.UNAVAILABLE, reason: `ALIGNMENT_WARNINGS:${[...entry.warnings].sort().join(',')}`, ...identity };
      const asset = recordings.find(item => item.sha256 === entry.audio_sha256);
      // Decoded only when a report is actually computed: the recording's
      // SHA-256 already identifies what decoding it will give.
      return { status: ORIGINAL_STATUS.USED, pending: { owner, projectId: record.project_id, assetId: asset.asset_id }, controlPoints: entry.report.alignment.control_points, ...identity };
    }
    return { status: ORIGINAL_STATUS.NOT_APPLICABLE, reason: 'NO_ACTIVE_ALIGNMENT_FOR_THESE_ALTERNATIVES' };
  }

  /** Read and decode the aligned recording; anything but WAVE PCM is unavailable. */
  function decodeOriginal(original) {
    if (!original.pending) return original;
    const { pending, ...rest } = original;
    const { bytes } = assets.read(pending.owner, pending.projectId, pending.assetId);
    const decoded = decodeWav(bytes);
    if (!decoded.ok) return { ...rest, status: ORIGINAL_STATUS.UNAVAILABLE, reason: decoded.reason };
    return { ...rest, mono: decoded.mono, sampleRate: decoded.sampleRate };
  }

  async function prescreen(owner, projectId, input) {
    if (projectId !== null && !isProjectId(projectId)) fail(ERROR_CODES.PROJECT_NOT_FOUND, 'Unknown project', { project_id: String(projectId).slice(0, 96) });
    const request = normalizePrescreenInput(input, { projectMode: projectId !== null });
    const resolved = await resolve(owner, projectId, request);
    // Sized before anything renders: a request whose render is over the
    // render-length limit is refused here, before the bank is loaded, a
    // recording decoded or a worker dispatched.
    plannedRender({ alternatives: resolved.alternatives, meter: resolved.meter, pickup: resolved.pickup, barRange: request.barRange });
    const fingerprint = JSON.stringify({
      project: projectId,
      alternatives: resolved.alternatives.map(entry => [entry.label, entry.source, entry.mml_sha256, entry.performance.roles.map(role => role.instrument), entry.source.kind === 'candidate' ? entry.performance.totalExact : null]),
      meter: meterText(resolved.meter), pickup: resolved.pickup, range: request.barRange,
      reference: resolved.reference && [resolved.reference.kind, resolved.reference.id, resolved.reference.sha256, resolved.reference.notes.length],
      original: [resolved.original.status, resolved.original.audio_sha256 ?? null, resolved.original.alignment_report_sha256 ?? null],
      thresholds: request.thresholds.id, render: request.render, bank: bankProvider.descriptor.sha256,
    });
    if (reportCache.has(fingerprint)) {
      const cached = reportCache.get(fingerprint);
      reportCache.delete(fingerprint);
      reportCache.set(fingerprint, cached);
      return cached;
    }
    let result;
    try {
      result = await runPrescreen({
        alternatives: resolved.alternatives,
        reference: resolved.reference,
        meter: resolved.meter,
        pickup: resolved.pickup,
        barRange: request.barRange,
        thresholds: request.thresholds,
        render: request.render,
        bankProvider,
        pool: poolFor(),
        profileCache,
        original: decodeOriginal(resolved.original),
        context: { mode: projectId === null ? 'mml' : 'project', project_id: projectId },
      });
    } catch (error) {
      if (error instanceof SoundBankError) fail(ERROR_CODES[error.code], error.message, error.details);
      if (error?.code === 'AUDIO_RENDER_FAILED') fail(ERROR_CODES.AUDIO_RENDER_FAILED, 'The prescreen render did not complete.', { reason: error.message.slice(0, 200) });
      if (isRequestProblem(error)) refuse(error.message);
      throw error;
    }
    reportCache.set(fingerprint, result.report);
    while (reportCache.size > PRESCREEN_LIMITS.reportCacheEntries) reportCache.delete(reportCache.keys().next().value);
    return result.report;
  }

  // ─── shadow mode ──────────────────────────────────────────────────────────

  const regionMetricWinners = (report, region) => {
    const winners = {};
    for (const metric of ALL_METRICS) {
      const named = report.bars
        .filter(bar => bar.bar >= region.bars[0] && bar.bar <= region.bars[1])
        .map(bar => bar.decisive?.[metric]?.winner ?? null)
        .filter(Boolean);
      const distinct = [...new Set(named)];
      winners[metric] = distinct.length === 1 ? distinct[0] : null;
    }
    return winners;
  };

  const predictionOf = (report, owner) => ({
    prediction_id: `psp_${report.report_id.slice(4, 36)}`,
    report_id: report.report_id,
    recorded_at: now(),
    authenticated_owner: owner,
    thresholds_id: report.thresholds.id,
    bank_sha256: report.bank.sha256,
    renderer: report.renderer.id,
    calibration_sha256: report.renderer.calibration.sha256,
    alternatives: report.alternatives.map(entry => ({ label: entry.label, source: entry.source, mml_sha256: entry.mml_sha256, performance_sha256: entry.performance_sha256 })),
    regions: report.regions.filter(region => region.verdict !== VERDICT.NO_DIFFERENCE).map(region => ({
      region_id: region.region_id,
      bars: region.bars,
      verdict: region.verdict,
      winner: region.winner,
      category: region.category,
      reasons: region.reasons,
      metric_winners: regionMetricWinners(report, region),
    })),
  });

  function agreement(shadow) {
    const latest = new Map();
    for (const choice of shadow.choices) latest.set(`${choice.prediction_id}|${choice.region_id}`, choice);
    const byPrediction = new Map(shadow.predictions.map(prediction => [prediction.prediction_id, prediction]));
    const perMetric = Object.fromEntries(ALL_METRICS.map(metric => [metric, { choices: 0, agreed: 0 }]));
    const perCategory = {};
    const obvious = { choices: 0, agreed: 0 };
    let needsHuman = 0;
    let noPreference = 0;
    for (const choice of latest.values()) {
      const region = byPrediction.get(choice.prediction_id)?.regions.find(entry => entry.region_id === choice.region_id);
      if (!region) continue;
      if (choice.chosen === NO_PREFERENCE) { noPreference++; continue; }
      for (const metric of ALL_METRICS) {
        const winner = region.metric_winners?.[metric];
        if (!winner) continue;
        perMetric[metric].choices++;
        if (winner === choice.chosen) perMetric[metric].agreed++;
      }
      if (region.verdict === VERDICT.OBVIOUS) {
        const entry = (perCategory[region.category] ??= { choices: 0, agreed: 0 });
        entry.choices++;
        obvious.choices++;
        if (region.winner === choice.chosen) { entry.agreed++; obvious.agreed++; }
      } else needsHuman++;
    }
    const rate = entry => ({ ...entry, agreement_rate: entry.choices ? entry.agreed / entry.choices : null });
    const categories = Object.fromEntries(Object.entries(perCategory).sort(([a], [b]) => (a < b ? -1 : 1)).map(([name, entry]) => [name, rate(entry)]));
    return {
      per_metric: Object.fromEntries(Object.entries(perMetric).map(([name, entry]) => [name, rate(entry)])),
      per_category: categories,
      obvious: rate(obvious),
      needs_human_choices: needsHuman,
      no_preference_choices: noPreference,
      draft_publication_bar: {
        ...SHADOW_PUBLICATION_BAR,
        categories_meeting_bar: Object.entries(categories).filter(([, entry]) => entry.choices >= SHADOW_PUBLICATION_BAR.min_sample && entry.agreement_rate >= SHADOW_PUBLICATION_BAR.min_agreement).map(([name]) => name),
        notice: `Informational. The draft rule (${RULE_DRAFT}) recommends publishing auto-apply only for a category whose owner agreement meets this bar; nothing is enabled by meeting it, and the rule is unpublished.`,
      },
    };
  }

  function shadowView(record, shadow) {
    return {
      schema: PRESCREEN_SHADOW_SCHEMA,
      project_id: record.project_id,
      storage: store.describe(),
      predictions: shadow.predictions,
      choices: shadow.choices,
      agreement: agreement(shadow),
      notice: 'Shadow-mode calibration record: machine predictions and the owner\'s recorded choices. It is not evidence for any gate and applies nothing.',
    };
  }

  return Object.freeze({
    prescreen,

    shadowStatus(owner, projectId) {
      const record = projects.load(owner, projectId);
      return shadowView(record, readShadow(record.project_id));
    },

    async recordShadow(owner, projectId, input) {
      if (!input || typeof input !== 'object' || Array.isArray(input)) refuse('shadow record request must be an object');
      const { entry, ...rest } = input;
      if (!SHADOW_ENTRIES.includes(entry)) refuse(`entry must be one of: ${SHADOW_ENTRIES.join(', ')}`);
      const record = projects.load(owner, projectId);
      if (entry === 'prediction') {
        const report = await prescreen(owner, projectId, rest);
        const shadow = readShadow(record.project_id);
        const prediction = predictionOf(report, owner);
        const existing = shadow.predictions.find(item => item.prediction_id === prediction.prediction_id);
        if (!existing) {
          if (shadow.predictions.length >= PRESCREEN_LIMITS.maxPredictionsPerProject) refuse('This project\'s shadow record holds the maximum number of predictions.', { reason: 'SHADOW_RECORD_FULL', max: PRESCREEN_LIMITS.maxPredictionsPerProject });
          shadow.predictions.push(prediction);
          store.putJson(shadowKey(record.project_id), shadow);
        }
        // The full report is not repeated here: it is the same read-only
        // prescreen, cached, and `studio_audio_prescreen` with the same
        // request returns it (paged when it is long).
        return {
          recorded: !existing,
          prediction: existing ?? prediction,
          report: { schema: report.schema, report_id: report.report_id, summary: report.summary, human_review: report.human_review },
          agreement: agreement(shadow),
        };
      }
      ownKeys(rest, ['prediction_id', 'region_id', 'chosen', 'accepted_by', 'reason'], 'owner choice');
      const acceptedBy = requireString(rest.accepted_by ?? '', 'accepted_by', { max: 120 });
      const shadow = readShadow(record.project_id);
      const prediction = shadow.predictions.find(item => item.prediction_id === rest.prediction_id);
      if (!prediction) refuse('Unknown prediction_id for this project.', { reason: 'PREDICTION_NOT_FOUND' });
      const region = prediction.regions.find(item => item.region_id === rest.region_id);
      if (!region) refuse('Unknown region_id for this prediction.', { reason: 'REGION_NOT_FOUND', regions: prediction.regions.slice(0, 20).map(item => item.region_id) });
      const labels = prediction.alternatives.map(item => item.label);
      if (rest.chosen !== NO_PREFERENCE && !labels.includes(rest.chosen)) refuse(`chosen must be one of ${[...labels, NO_PREFERENCE].join(', ')}`);
      const reason = rest.reason === undefined ? null : requireString(rest.reason, 'reason', { max: LIMITS.maxProposalNoteLength });
      if (shadow.choices.length >= PRESCREEN_LIMITS.maxChoicesPerProject) refuse('This project\'s shadow record holds the maximum number of choices.', { reason: 'SHADOW_RECORD_FULL', max: PRESCREEN_LIMITS.maxChoicesPerProject });
      const previous = [...shadow.choices].reverse().find(item => item.prediction_id === prediction.prediction_id && item.region_id === region.region_id) ?? null;
      const choice = {
        choice_id: `psc_${sha256Of(new TextEncoder().encode(`${prediction.prediction_id}|${region.region_id}|${shadow.choices.length}`)).slice(0, 32)}`,
        prediction_id: prediction.prediction_id,
        region_id: region.region_id,
        bars: region.bars,
        chosen: rest.chosen,
        machine_verdict: region.verdict,
        machine_winner: region.winner,
        accepted_by: acceptedBy,
        authenticated_owner: owner,
        reason,
        supersedes_choice_id: previous?.choice_id ?? null,
        recorded_at: now(),
      };
      shadow.choices.push(choice);
      store.putJson(shadowKey(record.project_id), shadow);
      return { recorded: true, choice, agreement: agreement(shadow) };
    },

    async close() {
      if (pool && pool !== options.renderPool) await pool.close();
      pool = null;
    },
  });
}
