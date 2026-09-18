// The One-Click Orchestrator — Phase 1.
//
// Status: IMPLEMENTATION NOTES. This module composes existing Application
// Service operations into one traceable, explicitly resumable workflow
// instance. It implements and exposes existing Published Canonical-aware
// Studio capabilities; it defines and modifies no Canonical rule.
//
// What it is
// ----------
// A control layer. It decides *which existing operation to call next*, in a
// fixed order, from what the project record and the upstream reports already
// say. That is the whole of its authority.
//
// What it is not, stated as prohibitions because each one was a real temptation
// while writing it:
//
//   * not a parser, an arranger, a reducer, an adapter, an evaluator or an
//     emitter. Every musical answer comes from `studio/backend/**`, through the
//     services already wired in `index.mjs`;
//   * not a reviewer. It converts no suggestion into an acceptance, no
//     `PENDING` into KEEP / OMIT / PASS, and no missing datum into `N/A` or
//     `not required`. `source_complete`, `player_readback`, the Gate 4 / 8 / 9
//     reviews and `original_audio_required` are only ever recorded because a
//     caller stated them, with a reason, through the existing
//     `recordConfirmations` path;
//   * not a gate. It publishes no verdict of its own and keeps no allow-list of
//     "blockers that matter": a run proceeds only while the upstream readiness
//     report says nothing blocks it, so a blocker this file has never heard of
//     still stops the run;
//   * not a model client. It holds no provider SDK, no credential and no
//     provider branch, and it calls nothing outside this process;
//   * not a background worker. See `RUN_EXECUTION_NOTICE`: advancement happens
//     inside the call that asked for it and stops when that call returns.
//
// Why a run is not a job
// ----------------------
// `job-service.mjs` records one unit of work that ran inline. A run records a
// multi-step workflow instance across several such calls, and it references the
// job ids those calls produced. Neither gains a background queue or a cancel
// path by the other existing: `capabilities.jobs.background_execution` and
// `job_cancellation` stay `false`.
//
// Locking
// -------
// `index.mjs` serializes public mutations per project. This module is reached
// from those public entry points and must therefore never call a public method
// that would take the same lock again — a nested acquisition on one project key
// deadlocks by construction. It is handed an `operations` façade over the
// *internal* services instead, and it takes the lock itself, once per step,
// through the `serialize` function it is given. Per step rather than per
// advancement, so a concurrent intake, decision or confirmation on the same
// project is not shut out for the length of a whole run; the price is that
// upstream state can move between steps, which is exactly what the staleness
// re-validation at the top of every step exists to catch.
//
// Nothing here bypasses a service to avoid a lock. Every owner check, Canonical
// check, integrity check, evidence check and acceptance check still runs in the
// module that owns it, because the façade calls those modules rather than their
// internals.

import {
  ERROR_CODES,
  LIMITS,
  OPERATION_STATUS,
  fail,
  isArtifactId,
  isCandidateId,
  isRunId,
  requirePlainObject,
  requireString,
} from './contracts.mjs';
import { PRE_EMISSION_EXEMPT_GATES } from './final-service.mjs';
import { ID_PREFIX, newId, sha256Of } from './store.mjs';
import {
  READINESS_GATE_OPERATIONS,
  RUN_AUTHORITY_NOTICE,
  RUN_EXECUTION_MODE,
  RUN_EXECUTION_NOTICE,
  RUN_HALT,
  RUN_RECORD_SCHEMA,
  RUN_REPORT_ARTIFACT_TYPE,
  RUN_REPORT_SCHEMA,
  RUN_REQUEST_INVALIDATORS,
  RUN_REVIEW_REQUEST,
  RUN_SEPARATION_NOTICE,
  RUN_STATE,
  RUN_STEP,
  RUN_STEP_OPERATION,
  RUN_STEP_ORDER,
  RUN_STEP_STATUS,
} from './run-contracts.mjs';

const now = () => new Date().toISOString();
const encoder = new TextEncoder();

const REDUCTION_STAGE = 'FINAL_SIX_ROLE_REDUCTION_V1';
const ADAPTATION_STAGE = 'MOBILE_ADAPTATION_V1';
const FINAL_ARTIFACT_TYPE = 'final_mml';

// ─── bounded, stable request fingerprints ───────────────────────────────────
//
// An idempotency key binds to the payload it was first used with, so the
// payload needs one canonical spelling. `stableJson` sorts object keys and
// refuses anything that is not plain JSON, which also bounds the structure a
// caller can push through a run input: the depth and node budget is spent here
// rather than discovered by a recursion limit later.
const FINGERPRINT_LIMITS = Object.freeze({ maxDepth: 12, maxNodes: 20000, maxStringLength: 40000 });

function stableJson(value, budget, depth = 0) {
  if (depth > FINGERPRINT_LIMITS.maxDepth) fail(ERROR_CODES.INVALID_REQUEST, `Run input is nested deeper than ${FINGERPRINT_LIMITS.maxDepth} levels.`);
  if (--budget.nodes < 0) fail(ERROR_CODES.PAYLOAD_TOO_LARGE, `Run input carries more than ${FINGERPRINT_LIMITS.maxNodes} values.`);
  if (value === null || typeof value === 'boolean') return JSON.stringify(value);
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) fail(ERROR_CODES.INVALID_REQUEST, 'Run input may not carry a non-finite number.');
    return JSON.stringify(value);
  }
  if (typeof value === 'string') {
    if (value.length > FINGERPRINT_LIMITS.maxStringLength) fail(ERROR_CODES.PAYLOAD_TOO_LARGE, `Run input carries a string longer than ${FINGERPRINT_LIMITS.maxStringLength} characters.`);
    return JSON.stringify(value);
  }
  if (value === undefined) return 'null';
  if (Array.isArray(value)) return `[${value.map(item => stableJson(item, budget, depth + 1)).join(',')}]`;
  if (typeof value !== 'object') fail(ERROR_CODES.INVALID_REQUEST, `Run input may not carry a ${typeof value}.`);
  // Own enumerable keys only. A caller-supplied `__proto__` or `constructor` is
  // data here, never a prototype write, and it is fingerprinted as data.
  return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${stableJson(value[key], budget, depth + 1)}`).join(',')}}`;
}

const digestOf = value => sha256Of(encoder.encode(stableJson(value, { nodes: FINGERPRINT_LIMITS.maxNodes })));

const sameSelection = (left, right) => JSON.stringify([...(left ?? [])].sort()) === JSON.stringify([...(right ?? [])].sort());

/**
 * Whether a run may reuse a baseline, on the intake inputs beyond the asset ids.
 *
 * The meter map is an intake input, not display metadata: `normalizeMMLSource`
 * parses an MML source against it, so the same asset under two meters is two
 * different baselines with two different content-addressed ids. Comparing asset
 * ids alone would let a run that states meter B carry on using a baseline built
 * from meter A, and every decision, confirmation and candidate bound to it.
 *
 * Three answers, and the third is the one worth naming:
 *
 *   `satisfied`    no adapter in that baseline's selection read a meter (MIDI,
 *                  MusicXML, Canonical IR), or the run's meter digest is the
 *                  one the baseline was built from. A MIDI-only project is
 *                  never rebuilt over an irrelevant empty meter field.
 *   `rebuild`      the run states a different meter. Its meter is the authority
 *                  for this run, so intake runs again under it.
 *   `unprovable`   the baseline was built from a meter and this run states
 *                  none. Re-ingesting would use an empty meter and silently
 *                  produce a third baseline, so the run stops and says so.
 *
 * A baseline record written before `intake_inputs` existed carries no digest.
 * Its `formats` list does say whether an MML adapter ran, so "did a meter reach
 * an adapter" is still answerable; "which meter" is not, which is exactly the
 * unprovable case.
 */
const METER_BINDING = Object.freeze({ SATISFIED: 'satisfied', REBUILD: 'rebuild', UNPROVABLE: 'unprovable' });

function meterBinding(baseline, runMeterDigest) {
  if (!baseline) return { state: METER_BINDING.SATISFIED, consumed: false, baseline_meter_text_sha256: null, run_meter_text_sha256: runMeterDigest };
  const recorded = baseline.intake_inputs;
  const consumed = recorded
    ? recorded.meter_text_sha256 !== null && recorded.meter_text_sha256 !== undefined
    : (baseline.formats ?? []).some(entry => entry.format === 'MML');
  const baselineDigest = recorded ? (recorded.meter_text_sha256 ?? null) : null;
  const detail = { consumed, baseline_meter_text_sha256: baselineDigest, run_meter_text_sha256: runMeterDigest };
  if (!consumed) return { state: METER_BINDING.SATISFIED, ...detail };
  if (baselineDigest !== null && baselineDigest === runMeterDigest) return { state: METER_BINDING.SATISFIED, ...detail };
  if (runMeterDigest === null) return { state: METER_BINDING.UNPROVABLE, ...detail };
  return { state: METER_BINDING.REBUILD, ...detail };
}

const summarizeAccounting = accounting => Object.freeze({
  total: accounting.total ?? null,
  retained: accounting.retained ?? null,
  redistributed: accounting.redistributed ?? null,
  overflow: accounting.overflow ?? null,
  pending: accounting.pending ?? null,
  omitted: accounting.omitted ?? null,
  manifestation_count: accounting.manifestationCount ?? null,
});

/** A gate entry, carried through with its own fields and its lists bounded. */
function boundedGate(entry) {
  if (!entry || typeof entry !== 'object') return null;
  const projected = {};
  for (const [key, value] of Object.entries(entry)) {
    if (Array.isArray(value)) projected[key] = value.slice(0, LIMITS.maxReviewRequestEventIds);
    else if (value === null || ['string', 'number', 'boolean'].includes(typeof value)) projected[key] = value;
  }
  return Object.freeze(projected);
}

// ─── input normalization ────────────────────────────────────────────────────
//
// Only these fields exist. An unknown field is refused rather than ignored: a
// caller that misspells `final_reduction` must not be told its reduction
// decisions were accepted.
const RUN_INPUT_KEYS = new Set([
  'idempotency_key', 'asset_ids', 'meter_text', 'target_candidate_id', 'adopt_candidate_id',
  'adopt_artifact_id', 'decisions', 'accepted_by', 'final_reduction', 'mobile_adaptation',
  'confirmations', 'finalize', 'expected_run_revision', 'reconcile',
]);
const REDUCTION_INPUT_KEYS = new Set(['decisions', 'expected_plan_id', 'accepted_by', 'instrument_profile']);
const ADAPTATION_INPUT_KEYS = new Set(['profile', 'expected_plan_id', 'accepted_by']);
const FINALIZE_INPUT_KEYS = new Set(['technical_timing_repair', 'pickup', 'final_partial']);

const closedObject = (value, label, allowed) => {
  requirePlainObject(value, label);
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) fail(ERROR_CODES.INVALID_REQUEST, `${label}.${key} is not an accepted field`, { accepted: [...allowed] });
  }
  return value;
};

function normalizeRunInput(input, { label = 'run input' } = {}) {
  const source = input ?? {};
  closedObject(source, label, RUN_INPUT_KEYS);

  const assetIds = source.asset_ids === undefined || source.asset_ids === null ? null : (() => {
    if (!Array.isArray(source.asset_ids)) fail(ERROR_CODES.INVALID_REQUEST, 'asset_ids must be an array of asset ids, or omitted to use every symbolic asset in the project.');
    if (source.asset_ids.length > LIMITS.maxAssetsPerProject) fail(ERROR_CODES.INVALID_REQUEST, `asset_ids is limited to ${LIMITS.maxAssetsPerProject} entries.`, { received: source.asset_ids.length });
    return source.asset_ids.map((id, index) => requireString(id, `asset_ids[${index}]`, { max: 64 }));
  })();

  const decisions = source.decisions === undefined || source.decisions === null ? null : (() => {
    if (!Array.isArray(source.decisions)) fail(ERROR_CODES.INVALID_REQUEST, 'decisions must be an array of explicitly accepted arrangement decisions.');
    if (source.decisions.length > LIMITS.maxDecisionsPerRequest) fail(ERROR_CODES.INVALID_REQUEST, `A decision set is limited to ${LIMITS.maxDecisionsPerRequest} decisions.`, { received: source.decisions.length });
    return source.decisions;
  })();

  const reduction = source.final_reduction === undefined || source.final_reduction === null ? null : (() => {
    const value = closedObject(source.final_reduction, 'final_reduction', REDUCTION_INPUT_KEYS);
    if (!Array.isArray(value.decisions) || !value.decisions.length) {
      fail(ERROR_CODES.INVALID_REQUEST, 'final_reduction.decisions must be the explicitly accepted reduction decisions. A reduction with no accepted decision is not one this run may apply.');
    }
    if (value.decisions.length > LIMITS.maxDecisionsPerRequest) fail(ERROR_CODES.INVALID_REQUEST, `final_reduction.decisions is limited to ${LIMITS.maxDecisionsPerRequest} decisions.`);
    return {
      decisions: value.decisions,
      expected_plan_id: requireString(value.expected_plan_id, 'final_reduction.expected_plan_id', { max: 200 }),
      accepted_by: requireString(value.accepted_by, 'final_reduction.accepted_by', { max: 120 }),
      instrument_profile: value.instrument_profile ?? null,
    };
  })();

  const adaptation = source.mobile_adaptation === undefined || source.mobile_adaptation === null ? null : (() => {
    const value = closedObject(source.mobile_adaptation, 'mobile_adaptation', ADAPTATION_INPUT_KEYS);
    requirePlainObject(value.profile, 'mobile_adaptation.profile');
    return {
      profile: value.profile,
      expected_plan_id: requireString(value.expected_plan_id, 'mobile_adaptation.expected_plan_id', { max: 200 }),
      accepted_by: requireString(value.accepted_by, 'mobile_adaptation.accepted_by', { max: 120 }),
    };
  })();

  const finalizeOptions = source.finalize === undefined || source.finalize === null ? null : (() => {
    const value = closedObject(source.finalize, 'finalize', FINALIZE_INPUT_KEYS);
    if (value.technical_timing_repair !== undefined && value.technical_timing_repair !== null
      && value.technical_timing_repair !== true && value.technical_timing_repair !== false) {
      fail(ERROR_CODES.INVALID_REQUEST, 'finalize.technical_timing_repair must be true or false. There is no automatic mode: the repair transforms the musical candidate and stays an explicit opt-in.');
    }
    return {
      technical_timing_repair: value.technical_timing_repair === true,
      pickup: value.pickup ?? null,
      final_partial: value.final_partial ?? null,
    };
  })();

  const normalized = {
    idempotency_key: source.idempotency_key === undefined || source.idempotency_key === null
      ? null
      : requireString(source.idempotency_key, 'idempotency_key', { max: LIMITS.maxIdempotencyKeyLength }),
    asset_ids: assetIds,
    meter_text: source.meter_text === undefined || source.meter_text === null ? '' : requireString(source.meter_text, 'meter_text', { max: 4096, min: 0 }),
    target_candidate_id: source.target_candidate_id ?? null,
    adopt_candidate_id: source.adopt_candidate_id ?? null,
    adopt_artifact_id: source.adopt_artifact_id ?? null,
    decisions,
    accepted_by: source.accepted_by === undefined || source.accepted_by === null ? null : requireString(source.accepted_by, 'accepted_by', { max: 120 }),
    final_reduction: reduction,
    mobile_adaptation: adaptation,
    confirmations: source.confirmations === undefined || source.confirmations === null ? null : requirePlainObject(source.confirmations, 'confirmations'),
    finalize: finalizeOptions,
    expected_run_revision: source.expected_run_revision === undefined || source.expected_run_revision === null ? null : (() => {
      if (!Number.isSafeInteger(source.expected_run_revision) || source.expected_run_revision < 1) {
        fail(ERROR_CODES.INVALID_REQUEST, 'expected_run_revision must be the positive integer revision the caller last observed.');
      }
      return source.expected_run_revision;
    })(),
    reconcile: source.reconcile === true,
  };
  for (const field of ['target_candidate_id', 'adopt_candidate_id']) {
    if (normalized[field] !== null && !isCandidateId(normalized[field])) {
      fail(ERROR_CODES.CANDIDATE_NOT_FOUND, 'Unknown candidate', { candidate_id: String(normalized[field]).slice(0, 96), field });
    }
  }
  if (normalized.adopt_artifact_id !== null && !isArtifactId(normalized.adopt_artifact_id)) {
    fail(ERROR_CODES.ARTIFACT_NOT_FOUND, 'Unknown artifact', { artifact_id: String(normalized.adopt_artifact_id).slice(0, 96) });
  }
  return normalized;
}

// The part of a request an idempotency key binds to: everything that could
// change what the advancement does. The key itself and the caller's observed
// revision are excluded — re-sending the same work under the same key is the
// case idempotency exists for, and a revision is a precondition, not work.
const requestFingerprintOf = normalized => digestOf({
  asset_ids: normalized.asset_ids,
  meter_text: normalized.meter_text,
  target_candidate_id: normalized.target_candidate_id,
  adopt_candidate_id: normalized.adopt_candidate_id,
  adopt_artifact_id: normalized.adopt_artifact_id,
  decisions: normalized.decisions,
  accepted_by: normalized.accepted_by,
  final_reduction: normalized.final_reduction,
  mobile_adaptation: normalized.mobile_adaptation,
  confirmations: normalized.confirmations,
  finalize: normalized.finalize,
  reconcile: normalized.reconcile,
});

// ─── review request construction ────────────────────────────────────────────
//
// A review request is a projection and nothing else. `blockers` carries the
// owning module's codes verbatim, `report_reference` says which report they
// were read from, and `available_operations` is a hint from
// `READINESS_GATE_OPERATIONS` that never decides anything.
const boundedIds = (ids, limit = LIMITS.maxReviewRequestEventIds) => {
  const list = [...new Set((ids ?? []).filter(id => typeof id === 'string' && id))];
  return { event_ids: Object.freeze(list.slice(0, limit)), event_id_total: list.length, event_ids_truncated: list.length > limit };
};

const blockerCode = entry => (typeof entry === 'string' ? entry : entry?.code ?? 'UNKNOWN');

function reviewRequest({
  code, step, gate = null, blockers = [], reportReference, baselineId = null, candidateId = null,
  eventIds = null, roles = null, existingEvidence = null, missing = [],
  availableOperations = null, invalidatedBy = [], known = true, detail = null,
}) {
  return Object.freeze({
    code,
    step,
    gate,
    known,
    blockers: Object.freeze(blockers.slice(0, LIMITS.maxReviewRequestEventIds).map(blocker => (typeof blocker === 'string' ? blocker : Object.freeze({ ...blocker })))),
    report_reference: reportReference,
    baseline_id: baselineId,
    candidate_id: candidateId,
    ...(eventIds === null ? {} : boundedIds(eventIds)),
    ...(roles === null ? {} : { roles: Object.freeze([...new Set(roles.filter(Boolean))]) }),
    existing_evidence: Object.freeze(existingEvidence ?? []),
    missing: Object.freeze(missing),
    available_operations: Object.freeze(availableOperations ?? (gate && Object.hasOwn(READINESS_GATE_OPERATIONS, gate) ? [...READINESS_GATE_OPERATIONS[gate]] : [])),
    invalidated_by: Object.freeze(invalidatedBy.map(name => RUN_REQUEST_INVALIDATORS[name] ?? name)),
    ...(detail === null ? {} : { detail: Object.freeze(detail) }),
  });
}

/**
 * Every blocking readiness gate, projected one request each.
 *
 * Driven by `readiness.preGameBlocking`, which is the upstream verdict, so a
 * gate this file has never heard of still produces a request and still blocks.
 * `known: false` says the run has no operation hint for that gate; it never
 * says the blocker may be skipped.
 */
function readinessRequests(readiness, { baselineId, candidateId, step, exempt = [] }) {
  const blocking = (readiness?.preGameBlocking ?? []).filter(name => !exempt.includes(name));
  return blocking.slice(0, LIMITS.maxReviewRequestsPerRun).map(gate => {
    const entry = readiness?.gates?.[gate] ?? null;
    const known = Object.hasOwn(READINESS_GATE_OPERATIONS, gate);
    const raw = entry?.blockers;
    return reviewRequest({
      code: RUN_REVIEW_REQUEST.READINESS_GATE_BLOCKED,
      step,
      gate,
      known,
      blockers: Array.isArray(raw) ? raw : (raw === undefined || raw === null ? [] : [raw]),
      reportReference: `readiness.gates.${gate}`,
      baselineId,
      candidateId,
      eventIds: entry?.eventIds ?? entry?.decisionIds ?? null,
      missing: known
        ? []
        : ['This readiness gate is not in the run orchestrator hint table, so no operation is suggested. It still blocks, and it is answered through the module that owns it.'],
      invalidatedBy: ['candidate', 'canonical'],
      detail: boundedGate(entry),
    });
  });
}

// ─── the service ────────────────────────────────────────────────────────────

/**
 * Build the run service.
 *
 * @param {object} deps
 * @param {object} deps.operations  Internal façade over the already-constructed
 *   services. It must NOT be the public Application Service: a public method
 *   would re-acquire the per-project lock this module already holds.
 * @param {Function} deps.serialize `(projectId, work) => Promise` — the same
 *   per-project serializer every other mutation uses.
 * @param {object} [deps.hooks]     Fault-injection seam for regressions, in the
 *   spirit of `loadEngines`. Production passes nothing. The three hooks fire
 *   before a step's effect, after the effect but before its receipt is stored,
 *   and after the receipt but before the response is returned — the three
 *   interruption classes a resumable run has to survive.
 */
export function createRunService({ canonical, projects, store, operations, serialize, serviceVersion, hooks = {} }) {
  const fire = async (name, context) => { if (typeof hooks?.[name] === 'function') await hooks[name](context); };

  const runsOf = record => (Array.isArray(record.runs) ? record.runs : []);

  const findRun = (record, runId) => {
    if (!isRunId(runId)) fail(ERROR_CODES.RUN_NOT_FOUND, 'Unknown run', { run_id: String(runId).slice(0, 64) });
    const run = runsOf(record).find(entry => entry.run_id === runId);
    if (!run) fail(ERROR_CODES.RUN_NOT_FOUND, 'Unknown run', { run_id: runId, project_id: record.project_id });
    return run;
  };

  /**
   * Write one run back, re-reading the project record first.
   *
   * The re-read is the point: another writer may have added a candidate or a
   * confirmation while this step ran, and a blind save of a record captured
   * earlier would drop it. Called only under the project lock.
   */
  const putRun = (owner, projectId, run) => {
    const record = projects.load(owner, projectId);
    const runs = runsOf(record);
    const next = runs.some(entry => entry.run_id === run.run_id)
      ? runs.map(entry => (entry.run_id === run.run_id ? run : entry))
      : [...runs, run];
    projects.save({ ...record, runs: next });
    return run;
  };

  const bumpRun = (owner, projectId, run, changes) => putRun(owner, projectId, {
    ...run,
    ...changes,
    revision: run.revision + 1,
    updated_at: now(),
  });

  const appendStep = (run, receipt) => [...(run.steps ?? []).filter(entry => entry.step !== receipt.step), receipt];

  const stepReceipt = ({ step, status, inputFingerprint = null, resultReference = null, operation = null, jobId = null, detail = null, blockers = [] }) => Object.freeze({
    step,
    status,
    operation: operation ?? RUN_STEP_OPERATION[step] ?? null,
    input_fingerprint: inputFingerprint,
    result_reference: resultReference,
    job_id: jobId,
    blockers: Object.freeze(blockers.map(blockerCode)),
    ...(detail === null ? {} : { detail: Object.freeze(detail) }),
    at: now(),
  });

  const receiptOf = (run, stepName) => (run.steps ?? []).find(entry => entry.step === stepName) ?? null;

  // ── staleness ─────────────────────────────────────────────────────────────
  //
  // Re-read and re-checked at the top of every step, never once at the start of
  // an advancement. Between two steps another caller may replace the baseline,
  // re-upload an asset or apply a revision, and an approval or PASS that
  // described the old material is not evidence about the new material.
  const stalenessOf = (record, run, canonicalIdentity) => {
    const reasons = [];
    if (Array.isArray(run.inputs.asset_ids)) {
      const byId = new Map(record.assets.map(asset => [asset.asset_id, asset]));
      for (const entry of run.inputs.asset_digests ?? []) {
        const asset = byId.get(entry.asset_id);
        if (!asset) reasons.push({ code: RUN_HALT.INPUT_CHANGED, detail: { asset_id: entry.asset_id, reason: 'ASSET_REMOVED' } });
        else if (asset.sha256 !== entry.sha256 || asset.size !== entry.size) {
          reasons.push({ code: RUN_HALT.INPUT_CHANGED, detail: { asset_id: entry.asset_id, reason: 'ASSET_BYTES_CHANGED', recorded_sha256: entry.sha256, current_sha256: asset.sha256 } });
        }
      }
    }
    if (run.baseline_id && record.baseline?.baseline_id !== run.baseline_id) {
      reasons.push({ code: RUN_HALT.BASELINE_CHANGED, detail: { run_baseline_id: run.baseline_id, project_baseline_id: record.baseline?.baseline_id ?? null } });
    }
    // The baseline this run would otherwise reuse was built from an intake
    // input the run cannot prove it shares. Re-ingesting is not the answer
    // here — it would use an empty meter and produce a third baseline — so it
    // is reported rather than silently resolved either way. A run that states a
    // different meter is not this case: intake rebuilds under the stated one.
    if (record.baseline && sameSelection(record.baseline.asset_ids, (run.inputs.asset_digests ?? []).map(entry => entry.asset_id))) {
      const binding = meterBinding(record.baseline, run.inputs.meter_text_sha256 ?? null);
      if (binding.state === METER_BINDING.UNPROVABLE) {
        reasons.push({ code: RUN_HALT.METER_BINDING_UNPROVABLE, detail: { reason: 'BASELINE_METER_INPUT_UNPROVABLE', baseline_id: record.baseline.baseline_id, ...binding, state: undefined } });
      }
    }
    if (run.candidate_id && !record.candidates.some(entry => entry.candidate_id === run.candidate_id)) {
      reasons.push({ code: RUN_HALT.CANDIDATE_CHANGED, detail: { candidate_id: run.candidate_id, reason: 'CANDIDATE_NO_LONGER_STORED' } });
    }
    if (canonicalIdentity && run.canonical?.rules_snapshot_sha && canonicalIdentity.rules_snapshot_sha !== run.canonical.rules_snapshot_sha) {
      reasons.push({
        code: RUN_HALT.CANONICAL_SNAPSHOT_CHANGED,
        detail: { run_rules_snapshot_sha: run.canonical.rules_snapshot_sha, loaded_rules_snapshot_sha: canonicalIdentity.rules_snapshot_sha },
      });
    }
    return reasons;
  };

  // ── step expectations and reconciliation ──────────────────────────────────
  //
  // Before a mutating effect the run records what that effect will look like.
  // If the process stops between the effect and its receipt, the next call asks
  // the project record whether the effect is there — by the existing
  // content-addressed identity for a baseline or a candidate, and by the stored
  // artifact reference for a Final or a run report. When the answer is yes the
  // effect is adopted rather than replayed; when it is no the step is safe to
  // run again; when neither can be established the run reports the exact
  // unconfirmed step and refuses to guess.
  //
  // A temp-then-rename record write is not distributed exactly-once and is not
  // claimed to be. What makes adoption safe is that the effect's identity is
  // derived from its content, so finding it is finding *this* effect.
  const expectationSatisfiedBy = (owner, record, expectation) => {
    if (!expectation) return null;
    if (expectation.kind === 'baseline') {
      const baseline = record.baseline;
      if (!baseline) return null;
      return sameSelection(baseline.asset_ids, expectation.asset_ids) ? { baseline_id: baseline.baseline_id } : null;
    }
    if (expectation.kind === 'candidate') {
      // Matched on the parent, the stage and — where the step names one — the
      // plan the reviewer accepted, which the candidate record stores as its
      // `decision_ids`. Adoption then requires exactly ONE match: two
      // candidates can share a parent and a stage when another run applied a
      // different decision set from the same parent, and adopting whichever
      // one `find` happened to reach would be guessing. An ambiguous answer is
      // not an answer, so it is reported as unconfirmable instead.
      const matches = record.candidates.filter(entry => (entry.parent_candidate_id ?? null) === (expectation.parent_candidate_id ?? null)
        && (expectation.stage === null ? !entry.stage : entry.stage === expectation.stage)
        && (expectation.plan_id === null || expectation.plan_id === undefined || (entry.decision_ids ?? []).includes(expectation.plan_id)));
      if (matches.length > 1) return { ambiguous: true, candidate_ids: matches.map(entry => entry.candidate_id) };
      return matches.length === 1 ? { candidate_id: matches[0].candidate_id } : null;
    }
    if (expectation.kind === 'artifact') {
      // Candidate id and type alone do not identify one artifact. A candidate
      // can hold several `final_mml` artifacts — the id is the SHA-256 of a body
      // carrying `created_at`, so finalizing twice files two — and several runs
      // can each file a `run_report` for the same candidate. Two narrower
      // discriminators are used instead, in this order:
      //
      //   identity   a run report names the run that produced it, so another
      //              run's report for this candidate is not a candidate for
      //              adoption at all. This is exact, and needs no before/after
      //              comparison.
      //   novelty    a Final artifact's body carries no run id, so the run
      //              records which matching artifacts already existed *before*
      //              it attempted the effect, and adopts the one that was not
      //              there. Never "the newest": a timestamp is not evidence of
      //              whose effect it was.
      const matches = record.artifacts.filter(entry => entry.candidate_id === expectation.candidate_id && entry.type === expectation.artifact_type);
      const owned = expectation.expected_run_id
        ? matches.filter(entry => operations.artifactRunId(owner, entry.artifact_id) === expectation.expected_run_id)
        : matches.filter(entry => !(expectation.known_artifact_ids ?? []).includes(entry.artifact_id));
      if (owned.length > 1) return { ambiguous: true, kind: 'artifact', artifact_ids: owned.map(entry => entry.artifact_id) };
      return owned.length === 1 ? { artifact_id: owned[0].artifact_id } : null;
    }
    return null;
  };

  /** The matching artifacts that exist right now, for an effect's before-set. */
  const artifactsLike = (record, candidateId, artifactType) => record.artifacts
    .filter(entry => entry.candidate_id === candidateId && entry.type === artifactType)
    .map(entry => entry.artifact_id);

  /**
   * Run one mutating step: mark it pending, apply the effect, store the receipt.
   *
   * The three interruption classes are handled by the same three writes.
   * `pending_step` is stored *before* the effect, so a stop anywhere after it
   * leaves a marker, and the marker carries the expectation, so the next call
   * can tell "effect not applied" from "effect applied, receipt lost" without
   * replaying anything.
   */
  const withEffect = async (owner, projectId, run, { step, expectation, apply, idempotent = false, inputFingerprint = null }) => {
    let current = bumpRun(owner, projectId, run, {
      state: RUN_STATE.RUNNING,
      // The fingerprint travels on the marker as well as on the receipt. An
      // adopted effect has to be recorded with the fingerprint the step would
      // have computed, or `nextStep` sees a receipt whose inputs it cannot
      // match and runs the step again — which is how adopting an effect rather
      // than replaying it would have replayed it anyway, one step later.
      pending_step: { step, expectation: expectation ?? null, idempotent, input_fingerprint: inputFingerprint, at: now() },
      needs_reconciliation: false,
    });
    await fire('beforeEffect', { step, run: current });
    const outcome = await apply();
    await fire('afterEffect', { step, run: current, outcome });
    current = bumpRun(owner, projectId, current, {
      pending_step: null,
      steps: appendStep(current, outcome.receipt),
      ...(outcome.runChanges ?? {}),
    });
    await fire('beforeResponse', { step, run: current, outcome });
    return { run: current, outcome };
  };

  // ── read-only projections ─────────────────────────────────────────────────

  const runView = run => Object.freeze({
    schema: run.schema,
    run_id: run.run_id,
    project_id: run.project_id,
    revision: run.revision,
    state: run.state,
    execution_mode: run.execution_mode,
    created_at: run.created_at,
    updated_at: run.updated_at,
    // The authenticated caller, from the transport's own owner subject. The
    // reviewer names a caller supplies are recorded separately and labelled as
    // declarations: `accepted_by` is text a caller wrote, not an authenticated
    // identity, and this record never presents one as the other.
    requested_by: run.requested_by,
    declared_reviewers: Object.freeze([...(run.declared_reviewers ?? [])]),
    declared_reviewer_notice: 'declared_reviewers is caller-supplied text recorded for the audit trail. requested_by is the authenticated owner subject this call arrived under. Neither is evidence that the named person reviewed anything.',
    idempotency: Object.freeze({
      scope: run.idempotency.scope,
      key: run.idempotency.key,
      request_fingerprint: run.idempotency.request_fingerprint,
      receipts: Object.freeze((run.idempotency.receipts ?? []).map(entry => Object.freeze({ ...entry }))),
    }),
    inputs: Object.freeze({
      asset_ids: run.inputs.asset_ids === null ? null : Object.freeze([...run.inputs.asset_ids]),
      asset_digests: Object.freeze((run.inputs.asset_digests ?? []).map(entry => Object.freeze({ ...entry }))),
      meter_text_sha256: run.inputs.meter_text_sha256,
      target_candidate_id: run.inputs.target_candidate_id,
      decision_set_fingerprint: run.inputs.decision_set_fingerprint,
      reduction_fingerprint: run.inputs.reduction_fingerprint,
      adaptation_fingerprint: run.inputs.adaptation_fingerprint,
      confirmation_fingerprint: run.inputs.confirmation_fingerprint,
      finalize_options: run.inputs.finalize_options === null ? null : Object.freeze({ ...run.inputs.finalize_options }),
    }),
    baseline_id: run.baseline_id,
    candidate_id: run.candidate_id,
    candidate_lineage: Object.freeze([...(run.candidate_lineage ?? [])]),
    job_ids: Object.freeze([...(run.job_ids ?? [])]),
    artifact_ids: Object.freeze([...(run.artifact_ids ?? [])]),
    final_artifact_id: run.final_artifact_id ?? null,
    report_artifact_id: run.report_artifact_id ?? null,
    steps: Object.freeze((run.steps ?? []).map(step => Object.freeze({ ...step }))),
    halt: run.halt ? Object.freeze({ ...run.halt }) : null,
    blockers: Object.freeze([...(run.blockers ?? [])]),
    warnings: Object.freeze((run.warnings ?? []).map(entry => Object.freeze({ ...entry }))),
    review_requests: Object.freeze((run.review_requests ?? []).map(request => Object.freeze({ ...request }))),
    gates: run.gates ? Object.freeze({ ...run.gates }) : null,
    readiness_blockers: Object.freeze([...(run.readiness_blockers ?? [])]),
    pending_step: run.pending_step ? Object.freeze({ ...run.pending_step }) : null,
    needs_reconciliation: run.needs_reconciliation === true,
    canonical: Object.freeze({ ...run.canonical }),
    implementation: Object.freeze({ ...run.implementation }),
    storage: Object.freeze({ ...store.describe() }),
    separation_notice: RUN_SEPARATION_NOTICE,
    authority_notice: RUN_AUTHORITY_NOTICE,
    execution_notice: RUN_EXECUTION_NOTICE,
  });

  const runSummary = run => Object.freeze({
    run_id: run.run_id,
    revision: run.revision,
    state: run.state,
    created_at: run.created_at,
    updated_at: run.updated_at,
    baseline_id: run.baseline_id,
    candidate_id: run.candidate_id,
    final_artifact_id: run.final_artifact_id ?? null,
    report_artifact_id: run.report_artifact_id ?? null,
    review_request_count: (run.review_requests ?? []).length,
    needs_reconciliation: run.needs_reconciliation === true,
  });

  // ── construction ──────────────────────────────────────────────────────────

  const assetSelection = (record, assetIds) => {
    const symbolic = record.assets.filter(asset => operations.isSymbolicKind(asset.kind));
    const selected = assetIds === null ? symbolic : assetIds.map(assetId => operations.findAsset(record, assetId));
    return {
      selected,
      digests: selected.map(asset => ({ asset_id: asset.asset_id, kind: asset.kind, sha256: asset.sha256, size: asset.size })),
      symbolicCount: symbolic.length,
      audioCount: record.assets.filter(asset => asset.kind === 'original_audio').length,
    };
  };

  const newRun = (owner, record, normalized, { canonicalProvenance, fingerprint, selection }) => ({
    schema: RUN_RECORD_SCHEMA,
    run_id: newId(ID_PREFIX.run),
    project_id: record.project_id,
    revision: 1,
    state: RUN_STATE.CREATED,
    execution_mode: RUN_EXECUTION_MODE,
    created_at: now(),
    updated_at: now(),
    requested_by: owner,
    declared_reviewers: [...new Set([normalized.accepted_by, normalized.final_reduction?.accepted_by, normalized.mobile_adaptation?.accepted_by].filter(Boolean))],
    idempotency: {
      scope: `run:start:${record.project_id}`,
      key: normalized.idempotency_key,
      request_fingerprint: fingerprint,
      receipts: [],
    },
    inputs: {
      asset_ids: normalized.asset_ids,
      asset_digests: selection.digests,
      meter_text_sha256: normalized.meter_text ? sha256Of(encoder.encode(normalized.meter_text)) : null,
      target_candidate_id: normalized.target_candidate_id,
      decision_set_fingerprint: normalized.decisions === null ? null : digestOf(normalized.decisions),
      reduction_fingerprint: normalized.final_reduction === null ? null : digestOf(normalized.final_reduction),
      adaptation_fingerprint: normalized.mobile_adaptation === null ? null : digestOf(normalized.mobile_adaptation),
      confirmation_fingerprint: normalized.confirmations === null ? null : digestOf(normalized.confirmations),
      finalize_options: normalized.finalize,
    },
    baseline_id: record.baseline?.baseline_id ?? null,
    candidate_id: normalized.target_candidate_id,
    candidate_lineage: normalized.target_candidate_id ? [normalized.target_candidate_id] : [],
    job_ids: [],
    artifact_ids: [],
    final_artifact_id: null,
    report_artifact_id: null,
    steps: [],
    halt: null,
    blockers: [],
    warnings: [],
    review_requests: [],
    gates: null,
    readiness_blockers: [],
    pending_step: null,
    needs_reconciliation: false,
    // Two provenances, never merged. The Canonical identity selects the rules
    // the run was started under; the implementation identity records the code
    // that orchestrated it. A change to either is reported on its own, and
    // neither is a version of the other.
    canonical: {
      canonical_version: canonicalProvenance.canonical_version,
      canonical_status: canonicalProvenance.canonical_status,
      manifest_version: canonicalProvenance.manifest_version,
      rules_snapshot_sha: canonicalProvenance.rules_snapshot_sha,
      manifest_commit: canonicalProvenance.manifest_commit,
      published_main_head: canonicalProvenance.published_main_head,
      repository_head: canonicalProvenance.repository_head,
      pr_head: canonicalProvenance.pr_head,
      checkout_identity: canonicalProvenance.checkout_identity,
    },
    implementation: {
      application_version: serviceVersion,
      run_schema: RUN_RECORD_SCHEMA,
      run_service: 'run-service/1',
      notice: 'Implementation provenance. A change here is a code change, not a new Canonical release, and it never republishes or moves a rules snapshot.',
    },
  });

  // ── request builders ──────────────────────────────────────────────────────

  const symbolicSourceRequest = selection => reviewRequest({
    code: selection.symbolicCount ? RUN_REVIEW_REQUEST.SOURCE_SELECTION_REQUIRED : RUN_REVIEW_REQUEST.SYMBOLIC_SOURCE_REQUIRED,
    step: RUN_STEP.INTAKE,
    blockers: [ERROR_CODES.SOURCE_INCOMPLETE],
    reportReference: 'project.assets',
    missing: ['At least one symbolic source asset (MIDI, MusicXML, MML or Canonical IR). Original audio is evidence about timing; this build performs no audio-to-MIDI, no stem separation, no vocal isolation and no pitch transcription, so a recording alone cannot produce a Source-Faithful Baseline. A song title alone cannot either.'],
    availableOperations: ['uploadAsset (HTTP)', 'analyzeSources'],
    invalidatedBy: ['baseline'],
    detail: { symbolic_asset_count: selection.symbolicCount, original_audio_asset_count: selection.audioCount, audio_to_midi_supported: false },
  });

  const candidateSelectionRequest = (run, stepName) => reviewRequest({
    code: RUN_REVIEW_REQUEST.CANDIDATE_SELECTION_REQUIRED,
    step: stepName,
    blockers: [ERROR_CODES.CANDIDATE_NOT_FOUND],
    reportReference: 'run.candidate_id',
    baselineId: run.baseline_id,
    missing: ['A candidate for this run to act on. Name one with target_candidate_id when starting, or adopt_candidate_id when resuming after an operation outside the run produced it. A candidate is never chosen by being the newest.'],
    availableOperations: ['applyDecisions', 'startRun.target_candidate_id', 'resumeRun.adopt_candidate_id'],
    invalidatedBy: ['baseline', 'candidate'],
  });

  const decisionsRequiredRequest = run => {
    const suggested = receiptOf(run, RUN_STEP.SUGGEST)?.detail ?? null;
    return reviewRequest({
      code: RUN_REVIEW_REQUEST.ARRANGEMENT_DECISIONS_REQUIRED,
      step: RUN_STEP.APPLY_DECISIONS,
      blockers: [ERROR_CODES.DECISION_REQUIRED],
      reportReference: 'suggestArrangement.pending',
      baselineId: run.baseline_id,
      missing: [
        'An explicitly accepted arrangement decision set (KEEP / ASSIGN_ROLE / MOVE_ROLE / OMIT_FROM_SIX / DUPLICATE_WITH_JUSTIFICATION), each with a reason, evidence and the accepting reviewer. A move into or out of Melody additionally needs a complete leadEvidence record citing the baseline source identity. This run resolves no PENDING lane on a caller\'s behalf.',
        'Alternatively, name an existing candidate with target_candidate_id when starting, or adopt_candidate_id when resuming. A candidate is never selected for being the newest, so a project that already holds candidates does not make this step satisfied.',
      ],
      availableOperations: ['suggestArrangement', 'listBaselineEvents', 'applyDecisions', 'startRun.target_candidate_id'],
      invalidatedBy: ['baseline', 'canonical', 'decisions'],
      detail: suggested === null ? null : { lane_count: suggested.lane_count ?? null, pending_lane_count: suggested.pending_lane_count ?? null },
    });
  };

  const reductionRequest = (run, plan) => {
    const undecided = (plan.items ?? []).filter(item => item.outcome !== 'KEEP');
    return reviewRequest({
      code: RUN_REVIEW_REQUEST.REDUCTION_DECISIONS_REQUIRED,
      step: RUN_STEP.FINAL_REDUCTION,
      blockers: [...(plan.blockers ?? []), ...(plan.warnings ?? [])],
      reportReference: 'planFinalReduction.plan',
      baselineId: run.baseline_id,
      candidateId: run.candidate_id,
      eventIds: undecided.map(item => item.baselineEventId),
      roles: undecided.map(item => item.currentRole ?? item.baselineRole),
      missing: [
        'Explicitly accepted, event-level reduction decisions for the material the ledger does not simply retain. OVERFLOW and PENDING material stays retained and visible; a per-role character limit is never a reason to delete it, and unmapped General MIDI percussion is never assigned to a pitched role.',
        'analysis_plan_id below is the id of this decision-free analysis plan and is NOT the expected_plan_id to resume with. A reduction plan id is bound to its decision set and its reviewer, so derive the plan again through planFinalReduction with the decisions and the accepted_by you intend to apply, and resume with that id.',
      ],
      availableOperations: ['planFinalReduction', 'applyFinalReduction'],
      invalidatedBy: ['candidate', 'canonical', 'plan'],
      detail: {
        analysis_plan_id: plan.id,
        analysis_plan_decision_count: (plan.decisions ?? []).length,
        plan_accepted_by: plan.acceptedBy ?? null,
        accounting: summarizeAccounting(plan.accounting ?? {}),
        outcomes: undecided.reduce((counts, item) => ({ ...counts, [item.outcome]: (counts[item.outcome] ?? 0) + 1 }), {}),
        reason_codes: [...new Set(undecided.map(item => item.reasonCode).filter(Boolean))].slice(0, LIMITS.maxReviewRequestEventIds),
        certifies_gates: plan.certifiesGates ?? [],
      },
    });
  };

  const stalenessRequest = entry => (entry.code === RUN_HALT.METER_BINDING_UNPROVABLE
    ? reviewRequest({
      code: RUN_REVIEW_REQUEST.SOURCE_METER_BINDING_REQUIRED,
      step: RUN_STEP.INTAKE,
      blockers: [entry.code],
      reportReference: 'project.baseline.intake_inputs versus run.inputs.meter_text_sha256',
      missing: [
        'The source-confirmed meter map this run is bound to. The stored baseline was ingested against a meter map, an MML source is parsed against it, and this run states none — so the run cannot show that the baseline it would reuse is the baseline its own inputs describe.',
        'Resume with meter_text. If it matches the meter the baseline was built from, the baseline is reused; if it differs, intake runs again under the stated meter and the candidates and confirmations bound to the old baseline are dropped rather than carried over. This run never assumes a meter.',
      ],
      availableOperations: ['resumeRun with meter_text', 'analyzeSources', 'startRun (a new run stating its meter)'],
      invalidatedBy: ['baseline', 'meter'],
      detail: entry.detail,
    })
    : reviewRequest({
      code: RUN_REVIEW_REQUEST.RUN_INPUT_CHANGED,
      step: RUN_STEP.REVIEW,
      blockers: [entry.code],
      reportReference: 'run.inputs versus the committed project record',
      missing: ['An explicit decision about the changed input. An approval, confirmation, plan or PASS that described the previous material is not reusable here, and this run will not reuse one.'],
      availableOperations: ['startRun (a new run over the new inputs)', 'resumeRun with re-accepted decisions'],
      invalidatedBy: ['baseline', 'candidate', 'canonical'],
      detail: entry.detail,
    }));

  // ── halting ───────────────────────────────────────────────────────────────

  const collectBlockers = requests => [...new Set(requests.flatMap(request => request.blockers.map(blockerCode)))];

  const halt = (owner, projectId, run, { state, reason, step: stepName, requests, receipt = null }) => ({
    run: bumpRun(owner, projectId, run, {
      state,
      halt: { reason, step: stepName, at: now() },
      steps: appendStep(run, receipt ?? stepReceipt({ step: stepName, status: RUN_STEP_STATUS.AWAITING_INPUT, blockers: collectBlockers(requests) })),
      review_requests: requests.slice(0, LIMITS.maxReviewRequestsPerRun),
      blockers: collectBlockers(requests),
    }),
    halted: true,
  });

  // A halt decided by an operation's own result, after its receipt is stored.
  const haltAfterEffect = (owner, projectId, run, halted, stepName) => ({
    run: bumpRun(owner, projectId, run, {
      state: halted.state,
      halt: { reason: halted.reason, step: stepName, at: now() },
      review_requests: (halted.requests ?? []).slice(0, LIMITS.maxReviewRequestsPerRun),
      blockers: collectBlockers(halted.requests ?? []),
    }),
    halted: true,
  });

  // ── the steps ─────────────────────────────────────────────────────────────

  async function intakeStep(owner, projectId, record, run, normalized) {
    const selection = assetSelection(record, run.inputs.asset_ids);
    if (!selection.selected.length) {
      return halt(owner, projectId, run, {
        state: RUN_STATE.AWAITING_REVIEW,
        reason: selection.symbolicCount ? RUN_HALT.AWAITING_SOURCE_SELECTION : RUN_HALT.CAPABILITY_UNSUPPORTED,
        step: RUN_STEP.INTAKE,
        requests: [symbolicSourceRequest(selection)],
      });
    }
    const assetIds = selection.selected.map(asset => asset.asset_id);
    const fingerprint = digestOf({ asset_digests: selection.digests, meter_text_sha256: run.inputs.meter_text_sha256 });
    const applied = await withEffect(owner, projectId, run, {
      step: RUN_STEP.INTAKE,
      inputFingerprint: fingerprint,
      expectation: { kind: 'baseline', asset_ids: assetIds },
      apply: async () => {
        const result = await operations.analyzeSources(owner, projectId, { assetIds, meterText: normalized.meter_text });
        const baseline = result.baseline;
        return {
          receipt: stepReceipt({
            step: RUN_STEP.INTAKE,
            status: RUN_STEP_STATUS.COMPLETED,
            inputFingerprint: fingerprint,
            resultReference: baseline.baseline_id,
            jobId: result.job?.job_id ?? null,
            detail: {
              // The adapters' own verdict, carried unchanged. A baseline that
              // reports unsupported material or incomplete inputs stays marked
              // that way, and nothing in this run can raise it.
              source_complete: baseline.source_complete,
              unsupported: baseline.unsupported,
              incomplete_inputs: baseline.incomplete_inputs,
              warnings: baseline.warnings,
              asset_ids: assetIds,
            },
          }),
          runChanges: {
            baseline_id: baseline.baseline_id,
            // A new baseline invalidates every candidate derived from the old
            // one; `intake.run` already clears them, so the run drops its own
            // candidate pointer rather than keeping a reference to a record
            // that no longer exists.
            candidate_id: null,
            candidate_lineage: [],
            inputs: { ...run.inputs, asset_ids: assetIds, asset_digests: selection.digests },
            job_ids: [...run.job_ids, result.job?.job_id].filter(Boolean),
            warnings: [...(run.warnings ?? []), ...Object.keys(baseline.unsupported ?? {}).map(code => ({ step: RUN_STEP.INTAKE, code, source: 'baseline.unsupported' }))],
          },
        };
      },
    });
    return { run: applied.run, halted: false };
  }

  async function suggestStep(owner, projectId, record, run) {
    const applied = await withEffect(owner, projectId, run, {
      step: RUN_STEP.SUGGEST,
      // The suggestion cache is keyed by the baseline and the rules snapshot, so
      // a repeated derivation is the same entry rather than a second one.
      idempotent: true,
      expectation: null,
      apply: async () => {
        const result = await operations.suggestArrangement(owner, projectId, {});
        const suggestion = result.suggestion;
        return {
          receipt: stepReceipt({
            step: RUN_STEP.SUGGEST,
            status: RUN_STEP_STATUS.COMPLETED,
            inputFingerprint: digestOf({ baseline_id: suggestion.baseline_id, bindings: suggestion.bindings }),
            resultReference: suggestion.baseline_id,
            detail: {
              lane_count: suggestion.lane_count,
              pending_lane_count: suggestion.pending?.count ?? null,
              bindings: suggestion.bindings,
              notice: 'A suggestion, not an acceptance. PENDING stays PENDING.',
            },
          }),
          runChanges: {},
        };
      },
    });
    return { run: applied.run, halted: false };
  }

  async function decisionsStep(owner, projectId, record, run, normalized) {
    if (!normalized.decisions?.length) {
      return halt(owner, projectId, run, {
        state: RUN_STATE.AWAITING_REVIEW,
        reason: RUN_HALT.AWAITING_DECISIONS,
        step: RUN_STEP.APPLY_DECISIONS,
        requests: [decisionsRequiredRequest(run)],
      });
    }
    const fingerprint = digestOf(normalized.decisions);
    const parent = run.candidate_id;
    const applied = await withEffect(owner, projectId, run, {
      step: RUN_STEP.APPLY_DECISIONS,
      inputFingerprint: fingerprint,
      expectation: { kind: 'candidate', parent_candidate_id: parent, stage: null },
      apply: async () => {
        const result = await operations.applyDecisions(owner, projectId, {
          decisions: normalized.decisions,
          parentCandidateId: parent,
          acceptedBy: normalized.accepted_by,
        });
        const decisions = result.decisions;
        if (!decisions.applied) {
          const request = reviewRequest({
            code: RUN_REVIEW_REQUEST.ARRANGEMENT_DECISIONS_REFUSED,
            step: RUN_STEP.APPLY_DECISIONS,
            blockers: [ERROR_CODES.DECISION_REQUIRED, ...(decisions.rejected ?? [])],
            reportReference: 'applyDecisions.rejected',
            baselineId: run.baseline_id,
            candidateId: parent,
            missing: ['The decision set was refused as a whole, so no candidate was produced. Each rejection carries the owning module\'s own code; answer the rejection rather than deleting the decision that raised it.'],
            availableOperations: ['listBaselineEvents', 'applyDecisions', 'reviewLeadEvidence'],
            invalidatedBy: ['baseline', 'canonical', 'decisions'],
            detail: { status: decisions.status, conflict_count: (decisions.conflicts ?? []).length },
          });
          return {
            receipt: stepReceipt({
              step: RUN_STEP.APPLY_DECISIONS,
              status: RUN_STEP_STATUS.BLOCKED,
              inputFingerprint: fingerprint,
              operation: 'applyDecisions',
              blockers: [ERROR_CODES.DECISION_REQUIRED],
              detail: { status: decisions.status, rejected: (decisions.rejected ?? []).slice(0, LIMITS.maxReviewRequestEventIds), conflicts: (decisions.conflicts ?? []).slice(0, LIMITS.maxReviewRequestEventIds) },
            }),
            runChanges: {},
            halt: { state: RUN_STATE.AWAITING_REVIEW, reason: RUN_HALT.AWAITING_DECISIONS, requests: [request] },
          };
        }
        return {
          receipt: stepReceipt({
            step: RUN_STEP.APPLY_DECISIONS,
            status: RUN_STEP_STATUS.COMPLETED,
            inputFingerprint: fingerprint,
            resultReference: decisions.candidate_id,
            detail: {
              revision_index: decisions.revision_index,
              decision_count: decisions.decision_count,
              notice: 'An application PASS certifies no acceptance gate. Every gate the decisions touched is re-opened for the new candidate.',
            },
          }),
          runChanges: {
            candidate_id: decisions.candidate_id,
            candidate_lineage: [...run.candidate_lineage, decisions.candidate_id],
            declared_reviewers: [...new Set([...(run.declared_reviewers ?? []), normalized.accepted_by].filter(Boolean))],
          },
        };
      },
    });
    if (applied.outcome.halt) return haltAfterEffect(owner, projectId, applied.run, applied.outcome.halt, RUN_STEP.APPLY_DECISIONS);
    return { run: applied.run, halted: false };
  }

  async function reductionStep(owner, projectId, record, run, normalized) {
    if (!run.candidate_id) {
      return halt(owner, projectId, run, {
        state: RUN_STATE.AWAITING_REVIEW,
        reason: RUN_HALT.AWAITING_CANDIDATE_SELECTION,
        step: RUN_STEP.FINAL_REDUCTION,
        requests: [candidateSelectionRequest(run, RUN_STEP.FINAL_REDUCTION)],
      });
    }
    // Read-only first, always. The plan is what says whether a reduction
    // decision is needed at all, and what the ledger cannot retain without one.
    //
    // It is NOT the id an apply names, and the review request is careful to say
    // so. A reduction plan's identity is bound to its decision set and its
    // reviewer by the reduction stage's own rule, so the plan derived here with
    // no decisions has a different id from the plan derived with the decisions a
    // reviewer goes on to accept. Presenting the analysis plan's id as the one
    // to accept would hand every caller STALE_FINAL_REDUCTION_PLAN with no
    // explanation. The reviewer is still carried through so the analysis and
    // the eventual acceptance are at least derived for the same person.
    const previewReviewer = normalized.final_reduction?.accepted_by ?? normalized.accepted_by ?? null;
    const preview = await operations.planFinalReduction(owner, projectId, {
      candidateId: run.candidate_id,
      decisions: normalized.final_reduction?.decisions ?? [],
      acceptedBy: previewReviewer,
      instrumentProfile: normalized.final_reduction?.instrument_profile ?? null,
    });
    const plan = preview.reduction.plan;
    const accounting = plan.accounting ?? {};

    if (!normalized.final_reduction) {
      // The reduction stage's own rule: with no accepted decision and nothing
      // displaced, applying is refused as REDUCTION_NOTHING_TO_APPLY. So a
      // candidate whose every source event is already retained needs no
      // reduction revision, and minting one would be a no-op revision. This is
      // not a gate result: Gate 4, Gate 5 and Gate 8 are untouched by there
      // being nothing to reduce.
      const nothingToDecide = (plan.blockers ?? []).length === 0 && accounting.retained === accounting.total;
      if (nothingToDecide) {
        return {
          run: bumpRun(owner, projectId, run, {
            steps: appendStep(run, stepReceipt({
              step: RUN_STEP.FINAL_REDUCTION,
              status: RUN_STEP_STATUS.SKIPPED,
              operation: 'planFinalReduction',
              resultReference: plan.id,
              detail: {
                reason: 'REDUCTION_NOTHING_TO_APPLY',
                accounting: summarizeAccounting(accounting),
                certifies_gates: plan.certifiesGates ?? [],
                notice: 'Nothing was reduced and no revision was minted. Not a gate result.',
              },
            })),
          }),
          halted: false,
        };
      }
      return halt(owner, projectId, run, {
        state: RUN_STATE.AWAITING_REVIEW,
        reason: RUN_HALT.AWAITING_REDUCTION_DECISIONS,
        step: RUN_STEP.FINAL_REDUCTION,
        requests: [reductionRequest(run, plan)],
        receipt: stepReceipt({
          step: RUN_STEP.FINAL_REDUCTION,
          status: RUN_STEP_STATUS.AWAITING_INPUT,
          operation: 'planFinalReduction',
          resultReference: plan.id,
          detail: { accounting: summarizeAccounting(accounting), warnings: (plan.warnings ?? []).map(blockerCode) },
        }),
      });
    }

    const fingerprint = digestOf(normalized.final_reduction);
    const parent = run.candidate_id;
    const applied = await withEffect(owner, projectId, run, {
      step: RUN_STEP.FINAL_REDUCTION,
      inputFingerprint: fingerprint,
      expectation: { kind: 'candidate', parent_candidate_id: parent, stage: REDUCTION_STAGE, plan_id: normalized.final_reduction.expected_plan_id },
      apply: async () => {
        const result = await operations.applyFinalReduction(owner, projectId, {
          candidateId: parent,
          decisions: normalized.final_reduction.decisions,
          expectedPlanId: normalized.final_reduction.expected_plan_id,
          acceptedBy: normalized.final_reduction.accepted_by,
          instrumentProfile: normalized.final_reduction.instrument_profile,
        });
        const reduction = result.reduction;
        if (!reduction.applied) {
          const unchanged = reduction.unchanged === true;
          const request = reviewRequest({
            code: RUN_REVIEW_REQUEST.REDUCTION_APPLY_BLOCKED,
            step: RUN_STEP.FINAL_REDUCTION,
            blockers: reduction.blockers ?? [],
            reportReference: 'applyFinalReduction.blockers',
            baselineId: run.baseline_id,
            candidateId: parent,
            missing: ['The reduction was not applied. A stale plan id means the plan inputs moved and the plan must be re-previewed and re-accepted; any other blocker belongs to the reduction stage and is answered there.'],
            availableOperations: ['planFinalReduction', 'applyFinalReduction', 'approveCore3SourceChange', 'reviewLeadEvidence'],
            invalidatedBy: ['candidate', 'canonical', 'plan'],
            detail: { status: reduction.status, expected_plan_id: normalized.final_reduction.expected_plan_id, observed_plan_id: reduction.plan?.id ?? null },
          });
          return {
            receipt: stepReceipt({
              step: RUN_STEP.FINAL_REDUCTION,
              status: unchanged ? RUN_STEP_STATUS.SKIPPED : RUN_STEP_STATUS.BLOCKED,
              inputFingerprint: fingerprint,
              operation: 'applyFinalReduction',
              resultReference: reduction.plan?.id ?? null,
              blockers: reduction.blockers ?? [],
              detail: { status: reduction.status, unchanged, accounting: summarizeAccounting(reduction.plan?.accounting ?? {}) },
            }),
            runChanges: {},
            halt: unchanged ? null : { state: RUN_STATE.AWAITING_REVIEW, reason: RUN_HALT.OPERATION_BLOCKED, requests: [request] },
          };
        }
        return {
          receipt: stepReceipt({
            step: RUN_STEP.FINAL_REDUCTION,
            status: RUN_STEP_STATUS.COMPLETED,
            inputFingerprint: fingerprint,
            resultReference: reduction.candidate_id,
            detail: {
              plan_id: reduction.plan?.id ?? null,
              accounting: summarizeAccounting(reduction.accounting ?? {}),
              // Applying certifies nothing. The review the apply already ran is
              // recorded so the record shows the gates re-opened.
              gates_after_apply: result.review?.gates ?? null,
            },
          }),
          runChanges: {
            candidate_id: reduction.candidate_id,
            candidate_lineage: [...run.candidate_lineage, reduction.candidate_id],
            declared_reviewers: [...new Set([...(run.declared_reviewers ?? []), normalized.final_reduction.accepted_by].filter(Boolean))],
          },
        };
      },
    });
    if (applied.outcome.halt) return haltAfterEffect(owner, projectId, applied.run, applied.outcome.halt, RUN_STEP.FINAL_REDUCTION);
    return { run: applied.run, halted: false };
  }

  async function adaptationStep(owner, projectId, record, run, normalized) {
    if (!normalized.mobile_adaptation) {
      return {
        run: bumpRun(owner, projectId, run, {
          steps: appendStep(run, stepReceipt({
            step: RUN_STEP.MOBILE_ADAPTATION,
            status: RUN_STEP_STATUS.SKIPPED,
            operation: 'planMobileAdaptation',
            detail: {
              reason: 'NO_MOBILE_PROFILE_SUPPLIED',
              notice: 'No adaptation was attempted and no revision was minted. This is not a Gate 8 result: the Mobile adaptation review stays a separate candidate-bound, evidence-backed statement, and a run that changed nothing still needs it. A Mobile profile must be supplied by a caller with its own reason and evidence; this run invents no instrument range and no volume.',
            },
          })),
        }),
        halted: false,
      };
    }
    if (!run.candidate_id) {
      return halt(owner, projectId, run, {
        state: RUN_STATE.AWAITING_REVIEW,
        reason: RUN_HALT.AWAITING_CANDIDATE_SELECTION,
        step: RUN_STEP.MOBILE_ADAPTATION,
        requests: [candidateSelectionRequest(run, RUN_STEP.MOBILE_ADAPTATION)],
      });
    }
    const fingerprint = digestOf(normalized.mobile_adaptation);
    const parent = run.candidate_id;
    const applied = await withEffect(owner, projectId, run, {
      step: RUN_STEP.MOBILE_ADAPTATION,
      inputFingerprint: fingerprint,
      expectation: { kind: 'candidate', parent_candidate_id: parent, stage: ADAPTATION_STAGE, plan_id: normalized.mobile_adaptation.expected_plan_id },
      apply: async () => {
        const result = await operations.applyMobileAdaptation(owner, projectId, {
          candidateId: parent,
          profile: normalized.mobile_adaptation.profile,
          expectedPlanId: normalized.mobile_adaptation.expected_plan_id,
          acceptedBy: normalized.mobile_adaptation.accepted_by,
        });
        const adaptation = result.adaptation;
        if (!adaptation.applied) {
          const unchanged = adaptation.unchanged === true;
          const request = reviewRequest({
            code: RUN_REVIEW_REQUEST.MOBILE_ADAPTATION_BLOCKED,
            step: RUN_STEP.MOBILE_ADAPTATION,
            blockers: adaptation.blockers ?? [],
            reportReference: 'applyMobileAdaptation.blockers',
            baselineId: run.baseline_id,
            candidateId: parent,
            eventIds: (adaptation.blockers ?? []).flatMap(entry => entry.eventIds ?? (entry.eventId ? [entry.eventId] : [])),
            missing: [
              'The adaptation was refused by the adaptation stage. A refusal naming a Lead-bound event is the existing prohibition on re-pitching or re-voicing material a Lead evidence record still binds — including a Melody assigned from a role-less Source-Faithful Baseline. It is answered through the Lead evidence path, never by clearing the evidence, changing the baseline role, copying an older PASS or relaxing the profile.',
              'A stale plan id means the plan inputs moved — most often because the profile changed — so the plan must be re-previewed and re-accepted before it can be applied.',
            ],
            availableOperations: ['planMobileAdaptation', 'applyMobileAdaptation', 'reviewLeadEvidence', 'listBaselineEvents'],
            invalidatedBy: ['candidate', 'canonical', 'plan'],
            detail: { status: adaptation.status, expected_plan_id: normalized.mobile_adaptation.expected_plan_id, observed_plan_id: adaptation.plan?.id ?? null },
          });
          return {
            receipt: stepReceipt({
              step: RUN_STEP.MOBILE_ADAPTATION,
              status: unchanged ? RUN_STEP_STATUS.SKIPPED : RUN_STEP_STATUS.BLOCKED,
              inputFingerprint: fingerprint,
              operation: 'applyMobileAdaptation',
              resultReference: adaptation.plan?.id ?? null,
              blockers: adaptation.blockers ?? [],
              detail: { status: adaptation.status, unchanged },
            }),
            runChanges: {},
            halt: unchanged ? null : { state: RUN_STATE.AWAITING_REVIEW, reason: RUN_HALT.OPERATION_BLOCKED, requests: [request] },
          };
        }
        return {
          receipt: stepReceipt({
            step: RUN_STEP.MOBILE_ADAPTATION,
            status: RUN_STEP_STATUS.COMPLETED,
            inputFingerprint: fingerprint,
            resultReference: adaptation.candidate_id,
            detail: { plan_id: adaptation.plan?.id ?? null, change_count: adaptation.plan?.changes?.length ?? null, gates_after_apply: result.review?.gates ?? null },
          }),
          runChanges: {
            candidate_id: adaptation.candidate_id,
            candidate_lineage: [...run.candidate_lineage, adaptation.candidate_id],
            declared_reviewers: [...new Set([...(run.declared_reviewers ?? []), normalized.mobile_adaptation.accepted_by].filter(Boolean))],
          },
        };
      },
    });
    if (applied.outcome.halt) return haltAfterEffect(owner, projectId, applied.run, applied.outcome.halt, RUN_STEP.MOBILE_ADAPTATION);
    return { run: applied.run, halted: false };
  }

  async function reviewStep(owner, projectId, record, run, normalized) {
    if (!run.candidate_id) {
      return halt(owner, projectId, run, {
        state: RUN_STATE.AWAITING_REVIEW,
        reason: RUN_HALT.AWAITING_CANDIDATE_SELECTION,
        step: RUN_STEP.REVIEW,
        requests: [candidateSelectionRequest(run, RUN_STEP.REVIEW)],
      });
    }
    const candidateId = run.candidate_id;
    const fingerprint = reviewFingerprint(run);
    // Recording a confirmation is an overwrite keyed by its name, and reviewing
    // computes rather than accumulates, so the step is safe to run again. It
    // still writes, so it goes through `withEffect` and gets its own receipt.
    const applied = await withEffect(owner, projectId, run, {
      step: RUN_STEP.REVIEW,
      idempotent: true,
      inputFingerprint: fingerprint,
      expectation: null,
      apply: async () => {
        const result = await operations.reviewCandidate(owner, projectId, { candidateId, confirmations: normalized.confirmations });
        const reviewed = result.review;
        const readiness = reviewed.readiness;
        const blocking = readiness?.preGameBlocking ?? [];
        // `technical` is exempt only before emission, where requiring it would
        // be circular: no MML exists for the gate to grade. The exemption list
        // is the Final service's own `PRE_EMISSION_EXEMPT_GATES`, imported
        // rather than restated, so this can never become a second exemption
        // policy. Every other gate still blocks.
        const remaining = blocking.filter(name => !PRE_EMISSION_EXEMPT_GATES.includes(name));
        const requests = readinessRequests(readiness, {
          baselineId: run.baseline_id,
          candidateId,
          step: RUN_STEP.FINALIZE,
          exempt: [...PRE_EMISSION_EXEMPT_GATES],
        });
        return {
          receipt: stepReceipt({
            step: RUN_STEP.REVIEW,
            status: remaining.length ? RUN_STEP_STATUS.AWAITING_INPUT : RUN_STEP_STATUS.COMPLETED,
            inputFingerprint: fingerprint,
            resultReference: candidateId,
            blockers: [...blocking],
            detail: {
              gates: reviewed.gates,
              integrity_ok: reviewed.integrity?.ok ?? null,
              stale_confirmations: (reviewed.stale_confirmations ?? []).slice(0, LIMITS.maxReviewRequestEventIds),
              candidate_rules_snapshot_sha: reviewed.candidate_rules_snapshot_sha ?? null,
              loaded_rules_snapshot_sha: reviewed.loaded_rules_snapshot_sha ?? null,
              pending_decisions: (reviewed.pending_decisions ?? []).slice(0, LIMITS.maxReviewRequestEventIds),
              pre_emission_exempt_gates: [...PRE_EMISSION_EXEMPT_GATES],
            },
          }),
          runChanges: {
            gates: reviewed.gates,
            readiness_blockers: [...blocking],
            blockers: [...blocking],
            review_requests: requests,
          },
          halt: remaining.length ? { state: RUN_STATE.AWAITING_REVIEW, reason: RUN_HALT.AWAITING_REVIEW_EVIDENCE, requests } : null,
        };
      },
    });
    if (applied.outcome.halt) return haltAfterEffect(owner, projectId, applied.run, applied.outcome.halt, RUN_STEP.REVIEW);
    return { run: applied.run, halted: false };
  }

  async function finalizeStep(owner, projectId, record, run, normalized) {
    const candidateId = run.candidate_id;
    const options = normalized.finalize ?? run.inputs.finalize_options ?? { technical_timing_repair: false, pickup: null, final_partial: null };
    const fingerprint = digestOf({ candidate_id: candidateId, options });
    const applied = await withEffect(owner, projectId, run, {
      step: RUN_STEP.FINALIZE,
      inputFingerprint: fingerprint,
      // A Final artifact body carries no run id, so the before-set is what
      // tells this run's Final apart from one that was already there.
      expectation: { kind: 'artifact', candidate_id: candidateId, artifact_type: FINAL_ARTIFACT_TYPE, known_artifact_ids: artifactsLike(record, candidateId, FINAL_ARTIFACT_TYPE) },
      apply: async () => {
        const result = await operations.finalize(owner, projectId, {
          candidateId,
          // Passed through exactly as supplied. Asking a run to finalize never
          // turns the repair on, and there is no automatic mode.
          technicalTimingRepair: options.technical_timing_repair === true,
          pickup: options.pickup,
          finalPartial: options.final_partial,
        });
        const delivered = result.operation === OPERATION_STATUS.SUCCEEDED && result.artifact_id !== null;
        const requests = delivered ? [] : [
          reviewRequest({
            code: RUN_REVIEW_REQUEST.FINALIZE_BLOCKED,
            step: RUN_STEP.FINALIZE,
            blockers: [...(result.blockers ?? [])],
            reportReference: 'finalize.readiness.preGameBlocking',
            baselineId: run.baseline_id,
            candidateId,
            missing: ['No Final was delivered. A blocked finalize is an answer about the song, not a failure of the call: the orchestration ran and the listed readiness gates are unsatisfied. Each is answered through the module that owns it.'],
            availableOperations: ['reviewCandidate', 'recordConfirmations', 'approveCore3SourceChange', 'reviewLeadEvidence', 'attachAudioAlignment'],
            invalidatedBy: ['candidate', 'canonical'],
            detail: {
              emit_status: result.emit_status ?? null,
              technical_validation: result.technical_validation ?? null,
              player_readback_binding: result.player_readback_binding ?? null,
            },
          }),
          ...readinessRequests(result.readiness, { baselineId: run.baseline_id, candidateId, step: RUN_STEP.FINALIZE }),
        ];
        return {
          receipt: stepReceipt({
            step: RUN_STEP.FINALIZE,
            status: delivered ? RUN_STEP_STATUS.COMPLETED : RUN_STEP_STATUS.BLOCKED,
            inputFingerprint: fingerprint,
            resultReference: result.artifact_id,
            jobId: result.job?.job_id ?? null,
            blockers: [...(result.blockers ?? [])],
            detail: {
              operation: result.operation,
              emit_status: result.emit_status ?? null,
              gates: result.gates ?? null,
              technical_timing_repair: result.technical_timing_repair ?? null,
              // The artifact identity and the candidate it was emitted from, so
              // the run report names the exact Final this run produced rather
              // than an earlier candidate's MML.
              artifact_id: result.artifact_id,
              candidate_id: result.candidate_id ?? candidateId,
            },
          }),
          runChanges: {
            gates: result.gates ?? run.gates,
            readiness_blockers: [...(result.blockers ?? [])],
            blockers: [...(result.blockers ?? [])],
            review_requests: requests,
            job_ids: [...run.job_ids, result.job?.job_id].filter(Boolean),
            ...(delivered ? {
              final_artifact_id: result.artifact_id,
              artifact_ids: [...new Set([...run.artifact_ids, result.artifact_id])],
            } : {}),
          },
          halt: delivered ? null : { state: RUN_STATE.AWAITING_REVIEW, reason: RUN_HALT.OPERATION_BLOCKED, requests },
        };
      },
    });
    if (applied.outcome.halt) return haltAfterEffect(owner, projectId, applied.run, applied.outcome.halt, RUN_STEP.FINALIZE);
    return { run: applied.run, halted: false };
  }

  /**
   * File the run report and complete the run.
   *
   * A separate artifact with its own type and schema. It never rewrites the
   * Final artifact's content or identity: it names it. Both the exact final
   * candidate and the exact artifact id are recorded, so the report cannot
   * present an earlier candidate's MML as this run's output.
   */
  async function reportStep(owner, projectId, record, run) {
    const finalizeReceipt = receiptOf(run, RUN_STEP.FINALIZE);
    const applied = await withEffect(owner, projectId, run, {
      step: RUN_STEP.REPORT,
      // A run report names its run, so identity settles it exactly; the
      // before-set is recorded too, for a reader of the receipt.
      expectation: {
        kind: 'artifact',
        candidate_id: run.candidate_id,
        artifact_type: RUN_REPORT_ARTIFACT_TYPE,
        expected_run_id: run.run_id,
        known_artifact_ids: artifactsLike(record, run.candidate_id, RUN_REPORT_ARTIFACT_TYPE),
      },
      apply: async () => {
        const current = projects.load(owner, projectId);
        const report = {
          schema: RUN_REPORT_SCHEMA,
          type: RUN_REPORT_ARTIFACT_TYPE,
          run_id: run.run_id,
          project_id: run.project_id,
          candidate_id: run.candidate_id,
          run_revision: run.revision,
          created_at: now(),
          execution_mode: RUN_EXECUTION_MODE,
          baseline_id: run.baseline_id,
          // The exact candidate this run ended on, and the exact Final artifact
          // emitted from it. Not "the newest candidate" and not "an artifact in
          // this project": the two ids the run itself recorded.
          final_candidate_id: run.candidate_id,
          final_artifact_id: run.final_artifact_id ?? null,
          candidate_lineage: [...run.candidate_lineage],
          job_ids: [...run.job_ids],
          steps: (run.steps ?? []).map(entry => ({ step: entry.step, status: entry.status, operation: entry.operation, result_reference: entry.result_reference, at: entry.at })),
          gates: run.gates,
          readiness_blockers: [...(run.readiness_blockers ?? [])],
          warnings: [...(run.warnings ?? [])],
          emit_status: finalizeReceipt?.detail?.emit_status ?? null,
          canonical: { ...run.canonical },
          implementation: { ...run.implementation },
          separation_notice: RUN_SEPARATION_NOTICE,
          authority_notice: RUN_AUTHORITY_NOTICE,
          acceptance_notice: 'A run report is an implementation record. It certifies no Canonical gate, does not make the song VALIDATED, and never implies IN_GAME_ACCEPTED. The Final artifact it names is unmodified by this report.',
        };
        const filed = operations.fileArtifact(current, report);
        return {
          receipt: stepReceipt({
            step: RUN_STEP.REPORT,
            status: RUN_STEP_STATUS.COMPLETED,
            operation: 'fileArtifact',
            resultReference: filed.artifactId,
            detail: { artifact_type: RUN_REPORT_ARTIFACT_TYPE, final_candidate_id: run.candidate_id, final_artifact_id: run.final_artifact_id ?? null },
          }),
          runChanges: {
            report_artifact_id: filed.artifactId,
            artifact_ids: [...new Set([...run.artifact_ids, filed.artifactId])],
            state: RUN_STATE.COMPLETED,
            halt: null,
            review_requests: [],
          },
        };
      },
    });
    return { run: applied.run, halted: true };
  }

  // ── which step is next ────────────────────────────────────────────────────
  //
  // From the receipts and the committed project state, never from a timestamp.
  // A step whose recorded input fingerprint differs from the one this call's
  // inputs produce runs again: that is how a resume carrying new decisions,
  // new confirmations or new finalize options makes progress instead of
  // reporting the previous answer.
  // The review step's input identity is the candidate plus the confirmations
  // *as the run has recorded them*, not the confirmations this particular call
  // happened to carry. Keying it on the request made a bare resume — one that
  // supplies no new confirmations because the previous call already did —
  // compute a different fingerprint and re-run the review. That re-run reset
  // the run's state to `running`, which then re-filed the run report: an
  // identity taken from the request rather than from the state it produced,
  // which is the same mistake in miniature that the candidate, request and
  // artifact identities elsewhere in this file exist to avoid.
  const reviewFingerprint = run => digestOf({
    candidate_id: run.candidate_id,
    confirmation_fingerprint: run.inputs.confirmation_fingerprint ?? null,
  });

  /** The intake step's input identity: the selected assets and the meter map. */
  const intakeFingerprint = run => digestOf({
    asset_digests: run.inputs.asset_digests ?? [],
    meter_text_sha256: run.inputs.meter_text_sha256 ?? null,
  });

  /** Whether the committed baseline already answers this run's intake inputs. */
  const intakeSatisfiedBy = (record, run) => Boolean(record.baseline)
    && sameSelection(record.baseline.asset_ids, (run.inputs.asset_digests ?? []).map(entry => entry.asset_id))
    && meterBinding(record.baseline, run.inputs.meter_text_sha256 ?? null).state === METER_BINDING.SATISFIED;

  function nextStep(record, run, normalized) {
    const done = new Map((run.steps ?? []).map(entry => [entry.step, entry]));
    const rerun = name => {
      const receipt = done.get(name);
      if (!receipt) return true;
      if ([RUN_STEP_STATUS.AWAITING_INPUT, RUN_STEP_STATUS.BLOCKED, RUN_STEP_STATUS.UNCONFIRMED, RUN_STEP_STATUS.PLANNED].includes(receipt.status)) return true;
      // Intake's inputs are the selected assets AND the meter map an MML source
      // is parsed against, which is exactly what its receipt fingerprinted.
      if (name === RUN_STEP.INTAKE) return receipt.input_fingerprint !== intakeFingerprint(run);
      if (name === RUN_STEP.APPLY_DECISIONS) return Boolean(normalized.decisions?.length) && receipt.input_fingerprint !== digestOf(normalized.decisions);
      if (name === RUN_STEP.FINAL_REDUCTION) return Boolean(normalized.final_reduction) && receipt.input_fingerprint !== digestOf(normalized.final_reduction);
      if (name === RUN_STEP.MOBILE_ADAPTATION) return Boolean(normalized.mobile_adaptation) && receipt.input_fingerprint !== digestOf(normalized.mobile_adaptation);
      if (name === RUN_STEP.REVIEW) return receipt.input_fingerprint !== reviewFingerprint(run);
      if (name === RUN_STEP.FINALIZE) return receipt.input_fingerprint !== digestOf({ candidate_id: run.candidate_id, options: normalized.finalize ?? run.inputs.finalize_options ?? { technical_timing_repair: false, pickup: null, final_partial: null } });
      // Derived from what the step produced rather than from the run's
      // lifecycle state: a step that runs later in the same advancement resets
      // the state to `running`, and keying the report on that would file a
      // second report for a run that already has one.
      if (name === RUN_STEP.REPORT) return !run.report_artifact_id;
      return false;
    };
    for (const name of RUN_STEP_ORDER) {
      // Intake is satisfied only when BOTH identities agree: the selected asset
      // set and the intake inputs beyond it. A matching asset list over a
      // baseline built from a different meter is not this run's baseline.
      if (name === RUN_STEP.INTAKE && intakeSatisfiedBy(record, run)) continue;
      if (name === RUN_STEP.SUGGEST && run.candidate_id && !(normalized.decisions?.length)) continue;
      if (name === RUN_STEP.APPLY_DECISIONS && run.candidate_id && !(normalized.decisions?.length)) continue;
      if (rerun(name)) return name;
    }
    return null;
  }

  async function runNamedStep(owner, projectId, record, run, normalized, name) {
    if (name === RUN_STEP.INTAKE) return intakeStep(owner, projectId, record, run, normalized);
    if (name === RUN_STEP.SUGGEST) return suggestStep(owner, projectId, record, run);
    if (name === RUN_STEP.APPLY_DECISIONS) return decisionsStep(owner, projectId, record, run, normalized);
    if (name === RUN_STEP.FINAL_REDUCTION) return reductionStep(owner, projectId, record, run, normalized);
    if (name === RUN_STEP.MOBILE_ADAPTATION) return adaptationStep(owner, projectId, record, run, normalized);
    if (name === RUN_STEP.REVIEW) return reviewStep(owner, projectId, record, run, normalized);
    if (name === RUN_STEP.FINALIZE) return finalizeStep(owner, projectId, record, run, normalized);
    return reportStep(owner, projectId, record, run);
  }

  /**
   * Settle a step that was marked pending and never received its receipt.
   *
   * Three cases, distinguished by evidence rather than by assumption:
   *
   *   the effect is absent       → clear the marker and let the step run again.
   *   the effect is present and
   *   identifiable               → adopt it, write the receipt, continue.
   *   neither can be established → report `interrupted` with the exact step,
   *                                and refuse to replay it.
   */
  async function settlePendingStep(owner, projectId, record, run, normalized) {
    const pending = run.pending_step;
    const found = expectationSatisfiedBy(owner, record, pending.expectation);
    if (found?.ambiguous) {
      return {
        run: bumpRun(owner, projectId, run, {
          state: RUN_STATE.INTERRUPTED,
          needs_reconciliation: true,
          halt: { reason: RUN_HALT.RECONCILIATION_REQUIRED, step: pending.step, at: now() },
          steps: appendStep(run, stepReceipt({ step: pending.step, status: RUN_STEP_STATUS.UNCONFIRMED, detail: { reason: 'EFFECT_AMBIGUOUS', candidates: found.candidate_ids ?? found.artifact_ids ?? [] } })),
          review_requests: [reviewRequest({
            code: RUN_REVIEW_REQUEST.RECONCILIATION_REQUIRED,
            step: pending.step,
            blockers: [ERROR_CODES.RUN_RECONCILIATION_REQUIRED],
            reportReference: 'run.pending_step',
            baselineId: run.baseline_id,
            candidateId: run.candidate_id,
              missing: [found.kind === 'artifact'
              ? 'More than one stored artifact matches what this step was about, so which one it produced cannot be established and none is adopted. Name the one to continue with through resumeRun.adopt_artifact_id, which verifies its type, its candidate and — for a run report — that its body names this run.'
              : 'More than one stored candidate matches what this step was about, so which one it produced cannot be established and none is adopted. Name the one to continue with through resumeRun.adopt_candidate_id, which verifies its baseline and its lineage.'],
            availableOperations: found.kind === 'artifact'
              ? ['getProject', 'getRun', 'getArtifact', 'resumeRun.adopt_artifact_id']
              : ['getProject', 'getRun', 'resumeRun.adopt_candidate_id'],
            invalidatedBy: ['candidate', 'baseline'],
            detail: { unconfirmed_step: pending.step, marked_at: pending.at, matches: found.candidate_ids ?? found.artifact_ids ?? [] },
          })],
          blockers: [ERROR_CODES.RUN_RECONCILIATION_REQUIRED],
        }),
        halted: true,
      };
    }
    if (found) {
      const changes = {
        pending_step: null,
        needs_reconciliation: false,
        steps: appendStep(run, stepReceipt({
          step: pending.step,
          status: RUN_STEP_STATUS.SATISFIED,
          inputFingerprint: pending.input_fingerprint ?? null,
          resultReference: found.candidate_id ?? found.baseline_id ?? found.artifact_id ?? null,
          detail: { reconciled: true, reason: 'EFFECT_FOUND_BY_STORED_IDENTITY', expectation: pending.expectation },
        })),
      };
      if (found.baseline_id) changes.baseline_id = found.baseline_id;
      if (found.candidate_id) {
        changes.candidate_id = found.candidate_id;
        changes.candidate_lineage = [...new Set([...run.candidate_lineage, found.candidate_id])];
      }
      if (found.artifact_id && pending.expectation.artifact_type === FINAL_ARTIFACT_TYPE) {
        changes.final_artifact_id = found.artifact_id;
        changes.artifact_ids = [...new Set([...run.artifact_ids, found.artifact_id])];
      }
      if (found.artifact_id && pending.expectation.artifact_type === RUN_REPORT_ARTIFACT_TYPE) {
        changes.report_artifact_id = found.artifact_id;
        changes.artifact_ids = [...new Set([...run.artifact_ids, found.artifact_id])];
        changes.state = RUN_STATE.COMPLETED;
      }
      return { run: bumpRun(owner, projectId, run, changes), halted: false };
    }
    if (pending.expectation === null && pending.idempotent !== true && !normalized.reconcile) {
      // No identity to check and no declaration that a repeat is safe. The run
      // says which step is unconfirmed rather than replaying it.
      return {
        run: bumpRun(owner, projectId, run, {
          state: RUN_STATE.INTERRUPTED,
          needs_reconciliation: true,
          halt: { reason: RUN_HALT.RECONCILIATION_REQUIRED, step: pending.step, at: now() },
          steps: appendStep(run, stepReceipt({ step: pending.step, status: RUN_STEP_STATUS.UNCONFIRMED, detail: { reason: 'EFFECT_NOT_CONFIRMED' } })),
          review_requests: [reviewRequest({
            code: RUN_REVIEW_REQUEST.RECONCILIATION_REQUIRED,
            step: pending.step,
            blockers: [ERROR_CODES.RUN_RECONCILIATION_REQUIRED],
            reportReference: 'run.pending_step',
            baselineId: run.baseline_id,
            candidateId: run.candidate_id,
            missing: ['Whether this step\'s effect was persisted cannot be established from a deterministic identity or a stored reference, so it is not replayed. Inspect the project record and resume with reconcile: true once the state is known.'],
            availableOperations: ['getProject', 'getRun', 'resumeRun (reconcile)'],
            invalidatedBy: ['candidate', 'baseline'],
            detail: { unconfirmed_step: pending.step, marked_at: pending.at },
          })],
          blockers: [ERROR_CODES.RUN_RECONCILIATION_REQUIRED],
        }),
        halted: true,
      };
    }
    return {
      run: bumpRun(owner, projectId, run, {
        pending_step: null,
        needs_reconciliation: false,
        steps: (run.steps ?? []).filter(entry => entry.step !== pending.step),
      }),
      halted: false,
    };
  }

  /** One step, under the project lock. */
  async function step(owner, projectId, runId, normalized) {
    const record = projects.load(owner, projectId);
    let run = findRun(record, runId);

    if (run.state === RUN_STATE.COMPLETED || run.state === RUN_STATE.FAILED) return { run, halted: true };

    // A run that halted waiting on an intake input it has since supplied must
    // not keep reporting intake as waiting: the committed baseline answers the
    // run's inputs now, and a receipt that still says `awaiting_input` would
    // describe a step nobody is waiting for.
    if (intakeSatisfiedBy(record, run)) {
      const receipt = receiptOf(run, RUN_STEP.INTAKE);
      if (receipt && [RUN_STEP_STATUS.AWAITING_INPUT, RUN_STEP_STATUS.BLOCKED].includes(receipt.status)) {
        run = bumpRun(owner, projectId, run, {
          steps: appendStep(run, stepReceipt({
            step: RUN_STEP.INTAKE,
            status: RUN_STEP_STATUS.SATISFIED,
            inputFingerprint: intakeFingerprint(run),
            resultReference: record.baseline.baseline_id,
            detail: { reason: 'BASELINE_ALREADY_ANSWERS_THESE_INPUTS', intake_inputs: record.baseline.intake_inputs ?? null },
          })),
        });
      }
    }

    // An interrupted step is settled before anything else is attempted.
    if (run.pending_step) {
      const settled = await settlePendingStep(owner, projectId, record, run, normalized);
      if (settled.halted) return settled;
      run = settled.run;
    }

    const provenance = await canonical.provenance();
    if (provenance.status !== 'CANONICAL_LOADED') {
      return {
        run: bumpRun(owner, projectId, run, {
          state: RUN_STATE.BLOCKED,
          halt: { reason: ERROR_CODES.CANONICAL_NOT_LOADED, step: null, at: now() },
          blockers: [ERROR_CODES.CANONICAL_NOT_LOADED],
          review_requests: [reviewRequest({
            code: RUN_REVIEW_REQUEST.READINESS_GATE_BLOCKED,
            step: RUN_STEP.INTAKE,
            blockers: [ERROR_CODES.CANONICAL_NOT_LOADED],
            reportReference: 'canonical.provenance',
            missing: ['The Published Canonical Manifest, its rules snapshot or the required Git history could not be loaded. Canonical specification judgment is stopped and there is no legacy fallback: no old Skill, Master, Draft2, memory, cached rule set or working-tree replacement may stand in for the published snapshot.'],
            availableOperations: ['capabilities'],
            invalidatedBy: ['canonical'],
            detail: { legacy_fallback_allowed: false, status: provenance.status },
          })],
        }),
        halted: true,
      };
    }

    const stale = stalenessOf(record, run, provenance);
    if (stale.length) {
      return halt(owner, projectId, run, {
        state: RUN_STATE.BLOCKED,
        reason: stale[0].code,
        // The step that cannot be satisfied, so the receipt lands where a
        // reader looks for it. An unprovable intake input is an intake problem.
        step: stale[0].code === RUN_HALT.METER_BINDING_UNPROVABLE ? RUN_STEP.INTAKE : (run.halt?.step ?? RUN_STEP.REVIEW),
        requests: stale.map(stalenessRequest),
      });
    }

    const next = nextStep(record, run, normalized);
    if (next === null) return { run: bumpRun(owner, projectId, run, { state: RUN_STATE.COMPLETED, halt: null }), halted: true };
    return runNamedStep(owner, projectId, record, run, normalized, next);
  }

  /** One bounded advancement: at most `maxRunStepsPerAdvance` steps. */
  async function advance(owner, projectId, runId, normalized, { idempotencyKey = null, fingerprint = null } = {}) {
    let budget = LIMITS.maxRunStepsPerAdvance;
    let halted = false;
    let lastRun = null;

    while (budget-- > 0 && !halted) {
      // Each step is one lock hold: read the committed state, re-validate, act,
      // write. The next step re-reads, because between two holds another caller
      // may have changed exactly what this step depends on.
      const outcome = await serialize(String(projectId), () => step(owner, projectId, runId, normalized));
      lastRun = outcome.run;
      halted = outcome.halted;
    }
    if (!halted) {
      lastRun = await serialize(String(projectId), async () => {
        const run = findRun(projects.load(owner, projectId), runId);
        return bumpRun(owner, projectId, run, {
          state: RUN_STATE.BLOCKED,
          halt: { reason: RUN_HALT.STEP_BUDGET_EXHAUSTED, step: null, at: now() },
        });
      });
    }
    if (idempotencyKey !== null) {
      lastRun = await serialize(String(projectId), async () => {
        const run = findRun(projects.load(owner, projectId), runId);
        const receipts = [...(run.idempotency?.receipts ?? []).filter(entry => entry.key !== idempotencyKey), {
          key: idempotencyKey,
          request_fingerprint: fingerprint,
          run_revision: run.revision,
          state: run.state,
          candidate_id: run.candidate_id,
          final_artifact_id: run.final_artifact_id ?? null,
          at: now(),
        }].slice(-LIMITS.maxIdempotencyReceiptsPerRun);
        return putRun(owner, projectId, { ...run, idempotency: { ...run.idempotency, receipts } });
      });
    }
    return runView(lastRun);
  }

  /**
   * Fold a resume's inputs into the run record before any step acts on them.
   *
   * The run record is what every later step re-validates against, so a resume's
   * decisions, plan acceptances and confirmations are recorded first. Changing
   * an input is not a way to reuse an old approval: the recorded fingerprints
   * change with it, and the staleness check at the top of each step compares the
   * run's bindings against the committed state.
   */
  function resumeChanges(owner, record, run, normalized) {
    const inputs = { ...run.inputs };
    if (normalized.asset_ids !== null) inputs.asset_ids = normalized.asset_ids;
    if (normalized.meter_text) inputs.meter_text_sha256 = sha256Of(encoder.encode(normalized.meter_text));
    if (normalized.decisions !== null) inputs.decision_set_fingerprint = digestOf(normalized.decisions);
    if (normalized.final_reduction !== null) inputs.reduction_fingerprint = digestOf(normalized.final_reduction);
    if (normalized.mobile_adaptation !== null) inputs.adaptation_fingerprint = digestOf(normalized.mobile_adaptation);
    if (normalized.confirmations !== null) inputs.confirmation_fingerprint = digestOf(normalized.confirmations);
    if (normalized.finalize !== null) inputs.finalize_options = normalized.finalize;

    const changes = {
      inputs,
      state: RUN_STATE.RUNNING,
      halt: null,
      declared_reviewers: [...new Set([
        ...(run.declared_reviewers ?? []),
        normalized.accepted_by,
        normalized.final_reduction?.accepted_by,
        normalized.mobile_adaptation?.accepted_by,
      ].filter(Boolean))],
    };

    // An artifact this run may have produced is adopted only when it is named,
    // and only when every identity it must satisfy checks out: the type and the
    // candidate the interrupted step was about, and — for a run report, whose
    // body names its run — that it is this run's report rather than another
    // run's for the same candidate. It settles the interrupted step and nothing
    // else: it files nothing, emits nothing and grades nothing.
    if (normalized.adopt_artifact_id !== null) {
      const pending = run.pending_step;
      if (pending?.expectation?.kind !== 'artifact') {
        fail(ERROR_CODES.INVALID_REQUEST, 'adopt_artifact_id settles an interrupted artifact step, and this run has none pending.', {
          run_id: run.run_id, pending_step: pending?.step ?? null, pending_expectation_kind: pending?.expectation?.kind ?? null,
        });
      }
      const entry = record.artifacts.find(artifact => artifact.artifact_id === normalized.adopt_artifact_id);
      if (!entry) fail(ERROR_CODES.ARTIFACT_NOT_FOUND, 'Unknown artifact', { artifact_id: normalized.adopt_artifact_id, project_id: record.project_id });
      if (entry.type !== pending.expectation.artifact_type) {
        fail(ERROR_CODES.INVALID_REQUEST, 'The artifact to adopt is not of the type this interrupted step produces.', {
          artifact_id: entry.artifact_id, artifact_type: entry.type, expected_artifact_type: pending.expectation.artifact_type,
        });
      }
      if (entry.candidate_id !== pending.expectation.candidate_id) {
        fail(ERROR_CODES.INVALID_REQUEST, 'The artifact to adopt was produced for a different candidate than this interrupted step was about.', {
          artifact_id: entry.artifact_id, artifact_candidate_id: entry.candidate_id, expected_candidate_id: pending.expectation.candidate_id,
        });
      }
      if (pending.expectation.expected_run_id) {
        const named = operations.artifactRunId(owner, entry.artifact_id);
        if (named !== pending.expectation.expected_run_id) {
          fail(ERROR_CODES.INVALID_REQUEST, 'The artifact to adopt names a different run, so it is another run\'s report and not this run\'s output.', {
            artifact_id: entry.artifact_id, artifact_run_id: named, expected_run_id: pending.expectation.expected_run_id,
          });
        }
      }
      changes.pending_step = null;
      changes.needs_reconciliation = false;
      changes.artifact_ids = [...new Set([...run.artifact_ids, entry.artifact_id])];
      if (entry.type === FINAL_ARTIFACT_TYPE) changes.final_artifact_id = entry.artifact_id;
      if (entry.type === RUN_REPORT_ARTIFACT_TYPE) {
        changes.report_artifact_id = entry.artifact_id;
        changes.state = RUN_STATE.COMPLETED;
      }
      changes.steps = [...(run.steps ?? []).filter(step => step.step !== pending.step), stepReceipt({
        step: pending.step,
        status: RUN_STEP_STATUS.SATISFIED,
        inputFingerprint: pending.input_fingerprint ?? null,
        resultReference: entry.artifact_id,
        detail: { reconciled: true, reason: 'EFFECT_NAMED_BY_REVIEWER', expectation: pending.expectation },
      })];
      return changes;
    }

    // A candidate produced outside this run is adopted only when it is named,
    // and only when its lineage and its baseline check out. Never by timestamp,
    // and never because it is the newest thing in the project.
    if (normalized.adopt_candidate_id !== null) {
      const adopted = record.candidates.find(entry => entry.candidate_id === normalized.adopt_candidate_id);
      if (!adopted) fail(ERROR_CODES.CANDIDATE_NOT_FOUND, 'Unknown candidate', { candidate_id: normalized.adopt_candidate_id, project_id: record.project_id });
      if (run.baseline_id && adopted.baseline_id !== run.baseline_id) {
        fail(ERROR_CODES.INVALID_REQUEST, 'The candidate to adopt was derived from a different Source-Faithful Baseline than this run is bound to.', {
          candidate_id: adopted.candidate_id, run_baseline_id: run.baseline_id, candidate_baseline_id: adopted.baseline_id,
        });
      }
      if (run.candidate_id) {
        const lineage = [];
        let cursor = adopted;
        const seen = new Set();
        while (cursor && !seen.has(cursor.candidate_id)) {
          seen.add(cursor.candidate_id);
          lineage.push(cursor.candidate_id);
          cursor = cursor.parent_candidate_id ? record.candidates.find(entry => entry.candidate_id === cursor.parent_candidate_id) : null;
        }
        if (!lineage.includes(run.candidate_id)) {
          fail(ERROR_CODES.INVALID_REQUEST, 'The candidate to adopt does not descend from the candidate this run is currently on, so adopting it would silently abandon the run\'s lineage.', {
            candidate_id: adopted.candidate_id, run_candidate_id: run.candidate_id, adopted_lineage: lineage.slice(0, LIMITS.maxReviewRequestEventIds),
          });
        }
      }
      changes.candidate_id = adopted.candidate_id;
      changes.candidate_lineage = [...new Set([...run.candidate_lineage, adopted.candidate_id])];
      // An adopted candidate is a different candidate, so every candidate-bound
      // answer this run recorded about the previous one is re-asked: the review
      // and finalize receipts are dropped and both steps run again.
      let steps = (run.steps ?? []).filter(entry => ![RUN_STEP.REVIEW, RUN_STEP.FINALIZE, RUN_STEP.REPORT].includes(entry.step));
      // Naming a candidate is also how a caller settles an interrupted step
      // whose effect could not be told apart from another one. It is an
      // explicit statement, checked against the baseline and the lineage above
      // before it is accepted, and it is recorded as the reviewer's answer
      // rather than as something the run established for itself.
      if (run.pending_step?.expectation?.kind === 'candidate') {
        steps = [...steps.filter(entry => entry.step !== run.pending_step.step), stepReceipt({
          step: run.pending_step.step,
          status: RUN_STEP_STATUS.SATISFIED,
          inputFingerprint: run.pending_step.input_fingerprint ?? null,
          resultReference: adopted.candidate_id,
          detail: { reconciled: true, reason: 'EFFECT_NAMED_BY_REVIEWER', expectation: run.pending_step.expectation },
        })];
        changes.pending_step = null;
        changes.needs_reconciliation = false;
      }
      changes.steps = steps;
      changes.gates = null;
      changes.readiness_blockers = [];
    }
    return changes;
  }

  return Object.freeze({
    RUN_STEP_ORDER,

    /**
     * Read-only plan.
     *
     * Writes nothing. No record, no blob, no suggestion cache, no baseline, no
     * candidate, no artifact and no run. Where planning would need analysis
     * that has not happened, the plan says so rather than performing the
     * analysis in order to describe it.
     */
    async plan(owner, projectId, input = {}) {
      const normalized = normalizeRunInput(input, { label: 'plan input' });
      if (normalized.idempotency_key !== null) fail(ERROR_CODES.INVALID_REQUEST, 'A read-only plan writes nothing, so it binds no idempotency key.');
      if (normalized.expected_run_revision !== null) fail(ERROR_CODES.INVALID_REQUEST, 'expected_run_revision applies to resumeRun; a plan reads no run.');
      if (normalized.adopt_candidate_id !== null || normalized.adopt_artifact_id !== null) {
        fail(ERROR_CODES.INVALID_REQUEST, 'A read-only plan adopts nothing: adopt_candidate_id and adopt_artifact_id settle an interrupted step on an existing run.');
      }
      const provenance = await canonical.provenance();
      const record = projects.load(owner, projectId);
      const selection = assetSelection(record, normalized.asset_ids);

      const base = {
        project_id: record.project_id,
        canonical: provenance,
        implementation: Object.freeze({ application_version: serviceVersion, run_schema: RUN_RECORD_SCHEMA, run_service: 'run-service/1' }),
        read_only: true,
        execution_mode: RUN_EXECUTION_MODE,
        plan_only_notice: 'Read-only. This call created no run, no baseline, no suggestion cache entry, no candidate and no artifact, and it applied no decision.',
        separation_notice: RUN_SEPARATION_NOTICE,
        authority_notice: RUN_AUTHORITY_NOTICE,
        execution_notice: RUN_EXECUTION_NOTICE,
      };

      if (provenance.status !== 'CANONICAL_LOADED') {
        return Object.freeze({
          ...base,
          planned_steps: Object.freeze([]),
          existing_results: Object.freeze({}),
          review_requests: Object.freeze([]),
          capability_blockers: Object.freeze([ERROR_CODES.CANONICAL_NOT_LOADED]),
          capability_notice: 'Published Canonical is unavailable, so no Canonical-aware step can be planned. There is no legacy fallback.',
        });
      }

      const steps = [];
      const requests = [];
      const add = (step, status, detail = {}) => steps.push(Object.freeze({ step, status, operation: RUN_STEP_OPERATION[step], ...detail }));

      const targetEntry = normalized.target_candidate_id === null
        ? null
        : record.candidates.find(entry => entry.candidate_id === normalized.target_candidate_id) ?? null;
      if (normalized.target_candidate_id !== null && targetEntry === null) {
        fail(ERROR_CODES.CANDIDATE_NOT_FOUND, 'Unknown candidate', { candidate_id: normalized.target_candidate_id, project_id: record.project_id });
      }
      // Only a candidate the caller NAMED. `startRun` adopts exactly
      // `target_candidate_id` and nothing else, so a plan that fell back to the
      // newest candidate would describe a run that will not happen — and it
      // would be selecting a candidate for being the newest, which this service
      // refuses everywhere else. The project's candidates are listed under
      // `existing_results.candidate_ids` for a caller to choose from.
      const current = targetEntry;

      // The same intake answer a start would give for these inputs, meter
      // binding included: a matching asset list over a baseline built from a
      // different meter map is not this run's baseline.
      const plannedMeterDigest = normalized.meter_text ? sha256Of(encoder.encode(normalized.meter_text)) : null;
      const plannedBinding = meterBinding(record.baseline, plannedMeterDigest);
      const assetsMatchBaseline = Boolean(record.baseline)
        && (normalized.asset_ids === null || sameSelection(record.baseline.asset_ids, selection.digests.map(entry => entry.asset_id)));

      if (!selection.selected.length && !record.baseline) {
        add(RUN_STEP.INTAKE, RUN_STEP_STATUS.AWAITING_INPUT, { needs: ['a symbolic source asset'] });
        requests.push(symbolicSourceRequest(selection));
      } else if (assetsMatchBaseline && plannedBinding.state === METER_BINDING.UNPROVABLE) {
        add(RUN_STEP.INTAKE, RUN_STEP_STATUS.AWAITING_INPUT, {
          needs: ['the source-confirmed meter map this run is bound to'],
          intake_inputs: record.baseline.intake_inputs ?? null,
        });
        requests.push(stalenessRequest({
          code: RUN_HALT.METER_BINDING_UNPROVABLE,
          detail: { reason: 'BASELINE_METER_INPUT_UNPROVABLE', baseline_id: record.baseline.baseline_id, consumed: plannedBinding.consumed, baseline_meter_text_sha256: plannedBinding.baseline_meter_text_sha256, run_meter_text_sha256: plannedBinding.run_meter_text_sha256 },
        }));
      } else if (assetsMatchBaseline && plannedBinding.state === METER_BINDING.SATISFIED) {
        add(RUN_STEP.INTAKE, RUN_STEP_STATUS.SATISFIED, { existing: { baseline_id: record.baseline.baseline_id, source_complete: record.baseline.source_complete } });
      } else {
        add(RUN_STEP.INTAKE, RUN_STEP_STATUS.PLANNED, {
          will_select_asset_ids: selection.digests.map(entry => entry.asset_id),
          ...(plannedBinding.state === METER_BINDING.REBUILD
            ? { rebuild_reason: 'The stored baseline was ingested against a different meter map than this run states, and an MML source is parsed against its meter map.' }
            : {}),
        });
      }

      if (current && !normalized.decisions?.length) {
        add(RUN_STEP.SUGGEST, RUN_STEP_STATUS.SKIPPED, { reason: 'A candidate is already available, so no new suggestion is needed to reach review. A suggestion would be derived only to support new decisions.' });
        add(RUN_STEP.APPLY_DECISIONS, RUN_STEP_STATUS.SATISFIED, { existing: { candidate_id: current.candidate_id, stage: current.stage ?? 'G11D_DECISION_APPLICATION' } });
      } else {
        add(RUN_STEP.SUGGEST, record.baseline ? RUN_STEP_STATUS.PLANNED : RUN_STEP_STATUS.AWAITING_INPUT, { needs: record.baseline ? [] : ['intake must produce a Source-Faithful Baseline first'] });
        if (!normalized.decisions?.length) {
          add(RUN_STEP.APPLY_DECISIONS, RUN_STEP_STATUS.AWAITING_INPUT, { needs: ['an explicitly accepted arrangement decision set'] });
          requests.push(decisionsRequiredRequest({ baseline_id: record.baseline?.baseline_id ?? null, steps: [] }));
        } else {
          add(RUN_STEP.APPLY_DECISIONS, RUN_STEP_STATUS.PLANNED, { decision_count: normalized.decisions.length });
        }
      }

      // Whether a reduction or an adaptation is *needed* is a question only the
      // existing plan operations answer, and answering it here would mean
      // running them — which a read-only plan does not do for the reduction
      // (it writes no candidate, but it is still analysis this call refuses to
      // perform in order to describe itself) and cannot do for the adaptation
      // without a caller-supplied profile.
      add(RUN_STEP.FINAL_REDUCTION, normalized.final_reduction ? RUN_STEP_STATUS.PLANNED : RUN_STEP_STATUS.AWAITING_INPUT, {
        expected_plan_id: normalized.final_reduction?.expected_plan_id ?? null,
        needs: normalized.final_reduction ? [] : ['the run derives the read-only reduction plan and stops there unless explicitly accepted reduction decisions are supplied; a candidate whose every source event is already retained is skipped without minting a revision'],
      });
      add(RUN_STEP.MOBILE_ADAPTATION, normalized.mobile_adaptation ? RUN_STEP_STATUS.PLANNED : RUN_STEP_STATUS.SKIPPED, {
        reason: normalized.mobile_adaptation ? null : 'No evidence-bound Mobile profile was supplied, so no adaptation is attempted. Changing nothing is not a Gate 8 PASS: the Gate 8 review stays required.',
      });
      add(RUN_STEP.REVIEW, RUN_STEP_STATUS.PLANNED, { records_confirmations: normalized.confirmations !== null });
      add(RUN_STEP.FINALIZE, RUN_STEP_STATUS.PLANNED, {
        pre_emission_exempt_gates: [...PRE_EMISSION_EXEMPT_GATES],
        technical_timing_repair: normalized.finalize?.technical_timing_repair === true,
      });
      add(RUN_STEP.REPORT, RUN_STEP_STATUS.PLANNED, { artifact_type: RUN_REPORT_ARTIFACT_TYPE });

      return Object.freeze({
        ...base,
        planned_steps: Object.freeze(steps),
        existing_results: Object.freeze({
          baseline_id: record.baseline?.baseline_id ?? null,
          baseline_asset_ids: Object.freeze([...(record.baseline?.asset_ids ?? [])]),
          candidate_ids: Object.freeze(record.candidates.map(entry => entry.candidate_id)),
          // Echoed only when the caller supplied it. `candidate_ids` above is
          // the set to choose from; this service does not choose.
          target_candidate_id: current?.candidate_id ?? null,
          candidate_selection_notice: 'target_candidate_id is echoed only when the caller named it. A run never adopts a candidate for being the newest, so a project holding candidates does not make apply_decisions satisfied.',
          artifact_ids: Object.freeze(record.artifacts.map(entry => entry.artifact_id)),
          run_ids: Object.freeze(runsOf(record).map(entry => entry.run_id)),
        }),
        review_requests: Object.freeze(requests),
        capability_blockers: Object.freeze([]),
        capability_notice: 'This build performs no background execution, no job cancellation, no audio-to-MIDI transcription and no in-game test. A run changes none of those.',
      });
    },

    /** Create a run and advance it as far as the supplied inputs allow. */
    async start(owner, projectId, input = {}) {
      const normalized = normalizeRunInput(input, { label: 'run input' });
      if (normalized.expected_run_revision !== null) fail(ERROR_CODES.INVALID_REQUEST, 'expected_run_revision applies to resumeRun: a run that does not exist yet has no revision to expect.');
      if (normalized.adopt_candidate_id !== null) fail(ERROR_CODES.INVALID_REQUEST, 'adopt_candidate_id applies to resumeRun: adopting a candidate produced outside the run is a resume decision.');
      if (normalized.adopt_artifact_id !== null) fail(ERROR_CODES.INVALID_REQUEST, 'adopt_artifact_id applies to resumeRun: it settles an interrupted step on an existing run.');
      const fingerprint = requestFingerprintOf(normalized);
      const provenance = await canonical.provenance();

      const created = await serialize(String(projectId), async () => {
        const record = projects.load(owner, projectId);
        if (normalized.idempotency_key !== null) {
          const existing = runsOf(record).find(entry => entry.idempotency?.key === normalized.idempotency_key);
          if (existing) {
            if (existing.idempotency.request_fingerprint !== fingerprint) {
              fail(ERROR_CODES.IDEMPOTENCY_CONFLICT, 'This idempotency key is already bound to a different run request payload. Use a new key, or resend the original payload.', {
                run_id: existing.run_id,
                bound_request_fingerprint: existing.idempotency.request_fingerprint,
                received_request_fingerprint: fingerprint,
              });
            }
            return { run: existing, replayed: true };
          }
        }
        if (runsOf(record).length >= LIMITS.maxRunsPerProject) {
          fail(ERROR_CODES.STORAGE_FULL, `This project already holds the maximum of ${LIMITS.maxRunsPerProject} runs.`, { max_runs: LIMITS.maxRunsPerProject });
        }
        if (normalized.target_candidate_id !== null && !record.candidates.some(entry => entry.candidate_id === normalized.target_candidate_id)) {
          fail(ERROR_CODES.CANDIDATE_NOT_FOUND, 'Unknown candidate', { candidate_id: normalized.target_candidate_id, project_id: record.project_id });
        }
        const selection = assetSelection(record, normalized.asset_ids);
        const run = newRun(owner, record, normalized, { canonicalProvenance: provenance, fingerprint, selection });
        return { run: putRun(owner, projectId, run), replayed: false };
      });

      if (created.replayed) {
        return Object.freeze({
          run: runView(created.run),
          replayed: true,
          advanced: false,
          notice: 'This idempotency key is already bound to this run and this payload, so nothing was applied, no revision was taken and no artifact was produced. The run is returned as it stands.',
        });
      }
      return Object.freeze({ run: await advance(owner, projectId, created.run.run_id, normalized), replayed: false, advanced: true });
    },

    /** Re-check an existing run and advance it with new input. */
    async resume(owner, projectId, runId, input = {}) {
      const normalized = normalizeRunInput(input, { label: 'resume input' });
      const fingerprint = requestFingerprintOf(normalized);

      const prepared = await serialize(String(projectId), async () => {
        const record = projects.load(owner, projectId);
        const run = findRun(record, runId);
        // Idempotency is decided FIRST, and the revision precondition only
        // after it. The two checks are about different things and the order is
        // not a style choice: a resume that carries both a key and
        // `expected_run_revision` advances the revision when it succeeds, so
        // the network retry of that exact request arrives with a revision that
        // is now stale by construction. Checking the precondition first
        // answered `RUN_CONFLICT` to a duplicate of a request that had already
        // been applied — which is precisely the case the key exists to answer,
        // and it would push a caller towards re-sending without the key.
        //
        // The fingerprint is what makes this safe rather than lenient: the same
        // key with a different payload is still refused, and a stale
        // precondition still refuses any request that is NOT a replay.
        const receipt = normalized.idempotency_key === null
          ? null
          : (run.idempotency?.receipts ?? []).find(entry => entry.key === normalized.idempotency_key) ?? null;
        if (receipt) {
          if (receipt.request_fingerprint !== fingerprint) {
            fail(ERROR_CODES.IDEMPOTENCY_CONFLICT, 'This idempotency key is already bound to a different resume payload on this run. Use a new key, or resend the original payload.', {
              run_id: run.run_id, bound_request_fingerprint: receipt.request_fingerprint, received_request_fingerprint: fingerprint,
            });
          }
          return { run, replayed: true, receipt };
        }
        if (normalized.expected_run_revision !== null && normalized.expected_run_revision !== run.revision) {
          fail(ERROR_CODES.RUN_CONFLICT, 'The run has advanced since the revision this call expected; re-read the run before resuming.', {
            run_id: run.run_id, expected_run_revision: normalized.expected_run_revision, current_run_revision: run.revision,
          });
        }
        return { run: bumpRun(owner, projectId, run, resumeChanges(owner, record, run, normalized)), replayed: false };
      });

      if (prepared.replayed) {
        return Object.freeze({
          run: runView(prepared.run),
          replayed: true,
          advanced: false,
          idempotency_receipt: Object.freeze({ ...prepared.receipt }),
          notice: 'This idempotency key is already bound to this resume payload, so no step was re-applied, no revision was taken and no artifact was produced. The run is returned as it stands.',
        });
      }
      return Object.freeze({
        run: await advance(owner, projectId, runId, normalized, { idempotencyKey: normalized.idempotency_key, fingerprint }),
        replayed: false,
        advanced: true,
      });
    },

    /** Read-only run state, or the project's run list when no id is named. */
    async get(owner, projectId, runId = null) {
      const record = projects.load(owner, projectId);
      if (runId === null || runId === undefined) {
        return Object.freeze({
          project_id: record.project_id,
          runs: Object.freeze(runsOf(record).map(runSummary)),
          read_only: true,
          separation_notice: RUN_SEPARATION_NOTICE,
          execution_notice: RUN_EXECUTION_NOTICE,
        });
      }
      const run = findRun(record, runId);
      // Cheap, read-only staleness hints. Nothing is recomputed through the
      // Canonical engines and nothing is written: a status read must not change
      // what it reports on, and must not cost a full review.
      const provenance = await canonical.provenance();
      const staleness = stalenessOf(record, run, provenance.status === 'CANONICAL_LOADED' ? provenance : null);
      return Object.freeze({
        project_id: record.project_id,
        run: runView(run),
        read_only: true,
        canonical: provenance,
        staleness: Object.freeze(staleness.map(entry => Object.freeze({ code: entry.code, detail: Object.freeze(entry.detail) }))),
        staleness_notice: staleness.length
          ? 'This run is bound to inputs that have since changed. A resume re-validates and reports rather than reusing an approval that described the old material.'
          : 'No change was detected in the run inputs this read can check cheaply. A resume still re-validates every binding before each step.',
      });
    },
  });
}
