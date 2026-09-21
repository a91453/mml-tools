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
  statedFields,
  requireString,
} from './contracts.mjs';
import { PRE_EMISSION_EXEMPT_GATES } from './final-service.mjs';
import { ID_PREFIX, newId, sha256Of } from './store.mjs';
import { requestKeyOf } from './proposal-contracts.mjs';
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

const summarizeLegacyMergeDiagnostics = diagnostics => Object.freeze((diagnostics ?? [])
  .slice(0, LIMITS.maxReviewRequestEventIds)
  .map(entry => Object.freeze({
    lane_id: entry.laneId ?? null,
    preferred_role: entry.preferredRole ?? null,
    source_event_count: (entry.sourceEventIds ?? []).length,
    authority: entry.authority ?? null,
    targets: Object.freeze((entry.targets ?? []).slice(0, 6).map(target => Object.freeze({
      role: target.role ?? null,
      lossless_gap_count: target.losslessGapCount ?? 0,
      unison_covered_count: target.unisonCoveredCount ?? 0,
      would_require_trim_or_drop_count: target.wouldRequireTrimOrDropCount ?? 0,
      fully_lossless: target.fullyLossless === true,
      lead_review_required: target.leadReviewRequired === true,
      preferred_by_role_analysis: target.preferredByRoleAnalysis === true,
      authority: target.authority ?? null,
    }))),
  })));

const summarizeArrangementMergeDiagnostics = diagnostics => {
  if (!diagnostics || typeof diagnostics !== 'object') return null;
  return Object.freeze({
    authority: diagnostics.authority ?? null,
    pending_role_groups: Object.freeze((diagnostics.pendingRoleGroups ?? [])
      .slice(0, 6)
      .map(group => Object.freeze({
        role: group.role ?? null,
        lane_ids: Object.freeze([...(group.laneIds ?? [])].slice(0, LIMITS.maxReviewRequestEventIds)),
        status: group.status ?? null,
        fully_lossless_together: group.fullyLosslessTogether === true,
        unison_review_count: group.unisonReviewCount ?? 0,
        collision_event_count: group.collisionEventCount ?? 0,
        lead_review_required: group.leadReviewRequired === true,
        authority: group.authority ?? null,
      }))),
    overflow_lanes: Object.freeze((diagnostics.overflowLanes ?? [])
      .slice(0, LIMITS.maxReviewRequestEventIds)
      .map(entry => Object.freeze({
        lane_id: entry.laneId ?? null,
        source_event_count: (entry.sourceEventIds ?? []).length,
        authority: entry.authority ?? null,
        targets: Object.freeze((entry.targets ?? []).slice(0, 6).map(target => Object.freeze({
          role: target.role ?? null,
          lossless_gap_count: target.losslessGapCount ?? 0,
          unison_covered_count: target.unisonCoveredCount ?? 0,
          would_require_trim_or_drop_count: target.wouldRequireTrimOrDropCount ?? 0,
          fully_lossless: target.fullyLossless === true,
          lead_review_required: target.leadReviewRequired === true,
          authority: target.authority ?? null,
        }))),
      }))),
    certifies_gates: Object.freeze([]),
  });
};

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
/**
 * What each run operation accepts — one closed set per operation, not a union.
 *
 * A union lets one transport admit a field another rejects, and lets a caller
 * send a field the operation does not read: `target_candidate_id` on a resume
 * was accepted and silently ignored, and `reconcile` was accepted by a
 * read-only plan. These sets are exported so the MCP tool schemas can be locked
 * to them field for field, which is what makes "HTTP and MCP accept the same
 * inputs" a checkable claim rather than an intention.
 */
export const PLAN_INPUT_KEYS = Object.freeze([
  'asset_ids', 'meter_text', 'target_candidate_id', 'decisions', 'accepted_by',
  'final_reduction', 'mobile_adaptation', 'confirmations', 'finalize',
]);
export const START_INPUT_KEYS = Object.freeze(['idempotency_key', ...PLAN_INPUT_KEYS]);
export const RESUME_INPUT_KEYS = Object.freeze([
  'idempotency_key', 'expected_run_revision', 'asset_ids', 'meter_text',
  'adopt_candidate_id', 'adopt_artifact_id', 'decisions', 'accepted_by',
  'final_reduction', 'mobile_adaptation', 'confirmations', 'finalize', 'reconcile',
]);

/**
 * What can actually be DONE about each unprovable cause.
 *
 * An interrupted run tells a reader which operations answer it, and a
 * listed operation a reader cannot execute is worse than no hint: it sends
 * them round a loop that returns the same refusal. So the list is derived
 * from this table rather than written once for every cause, and each entry
 * says what the implementation will honour for that exact cause:
 *
 *   reconcile   `resumeRun({ reconcile: true })` settles it. True ONLY for a
 *               marker that recorded no expectation at all: there, the
 *               caller inspecting the record and declaring the state is the
 *               only evidence there can be. It is never true where an
 *               expectation exists, because `reconcile` would then have to
 *               override evidence rather than supply it -- which is exactly
 *               the replay that files a second Final.
 *   name        `resumeRun({ adopt_artifact_id | adopt_candidate_id })`
 *               settles it. True where the named path's own two proofs can
 *               still conclude for a correctly-attempted record.
 *
 * Neither: nothing this service offers can settle the run, and saying so --
 * with the read-only operations that let a reader see the damage, and
 * `startRun` -- is the honest answer. Advertising a remedy there would be
 * the same defect this table exists to remove.
 */
export const RECONCILIATION_REMEDY = Object.freeze({
  // The marker recorded nothing to match on. A caller who has inspected the
  // record is the only available evidence, and `reconcile` is how they give
  // it. Naming cannot help: there is no before-set to hold a name to.
  NO_EXPECTATION_RECORDED: { reconcile: true, name: false },
  // A before-set that can still place ONE named record after the marker,
  // even though the automatic search could not settle the set as a whole.
  MATCHING_SET_TOO_LARGE_TO_SEARCH: { reconcile: false, name: true },
  BEFORE_SET_NOT_A_SUBSET: { reconcile: false, name: true },
  RECORDS_REMOVED_SINCE_THE_MARKER: { reconcile: false, name: true },
  // A before-set too truncated to place any name, an opaque record no proof
  // can reach, and a stored Final whose body is gone. Nothing to execute.
  BEFORE_SET_NOT_RECORDED: { reconcile: false, name: false },
  SEVERAL_ADDED_AND_BEFORE_SET_TRUNCATED: { reconcile: false, name: false },
  EFFECT_ATTEMPT_NOT_RECORDED: { reconcile: false, name: false },
  // A marker restored from a build that recorded no attempt. Nothing this
  // service offers can establish what it never wrote down, and a reviewer
  // naming a record cannot either -- the marker says nothing to hold it to.
  EFFECT_ATTEMPT_EXPECTATION_NOT_RECORDED: { reconcile: false, name: false },
  EFFECT_ATTEMPT_NOT_UNIQUE: { reconcile: false, name: false },
  FINAL_ARTIFACT_BODY_UNREADABLE: { reconcile: false, name: false },
  UNKNOWN_EXPECTATION_KIND: { reconcile: false, name: false },
});

/**
 * The only request fields that carry no workflow work.
 *
 * Everything else asks the run to do or to change something, which is what an
 * audit-closed run refuses. Stating the exception rather than enumerating the
 * material fields is deliberate: a list of "material" fields is a list that can
 * be missed, and `finalize` was missed from one.
 */
const NON_WORKFLOW_INPUT_KEYS = new Set(['idempotency_key', 'expected_run_revision']);

const RUN_INPUT_KEYS = new Set([...PLAN_INPUT_KEYS, ...START_INPUT_KEYS, ...RESUME_INPUT_KEYS]);
const REDUCTION_INPUT_KEYS = new Set(['decisions', 'expected_plan_id', 'accepted_by', 'instrument_profile']);
const ADAPTATION_INPUT_KEYS = new Set(['profile', 'expected_plan_id', 'accepted_by']);
const FINALIZE_INPUT_KEYS = new Set(['technical_timing_repair', 'pickup', 'final_partial']);

/**
 * One request object, checked against its closed key set and REBUILT from it.
 *
 * Rebuilt, not just checked: the check reads own keys and everything after it
 * reads `source.field`, which walks the prototype. A caller handing over
 * `Object.create({ decisions })` states the field nowhere the check can see it
 * and supplies it everywhere the run reads it -- and `provided`, which is what
 * "did this request ask for work" is answered from, would not list it. What
 * comes back here is the caller's stated fields on a fresh object, so the two
 * readings cannot disagree.
 */
const closedObject = (value, label, allowed) => {
  requirePlainObject(value, label);
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) fail(ERROR_CODES.INVALID_REQUEST, `${label}.${key} is not an accepted field`, { accepted: [...allowed] });
  }
  return statedFields(value);
};

function normalizeRunInput(input, { label = 'run input', allowed = RUN_INPUT_KEYS } = {}) {
  const source = closedObject(input ?? {}, label, allowed instanceof Set ? allowed : new Set(allowed));

  const assetIds = source.asset_ids === undefined || source.asset_ids === null ? null : (() => {
    if (!Array.isArray(source.asset_ids)) fail(ERROR_CODES.INVALID_REQUEST, 'asset_ids must be an array of asset ids, or omitted to use every symbolic asset in the project.');
    if (!source.asset_ids.length) fail(ERROR_CODES.INVALID_REQUEST, 'asset_ids must name at least one asset. Omit it to use every symbolic asset in the project; an empty list selects nothing and is not a way to ask for that.');
    if (source.asset_ids.length > LIMITS.maxAssetsPerProject) fail(ERROR_CODES.INVALID_REQUEST, `asset_ids is limited to ${LIMITS.maxAssetsPerProject} entries.`, { received: source.asset_ids.length });
    return source.asset_ids.map((id, index) => requireString(id, `asset_ids[${index}]`, { max: 64 }));
  })();

  const decisions = source.decisions === undefined || source.decisions === null ? null : (() => {
    if (!Array.isArray(source.decisions)) fail(ERROR_CODES.INVALID_REQUEST, 'decisions must be an array of explicitly accepted arrangement decisions.');
    if (!source.decisions.length) fail(ERROR_CODES.INVALID_REQUEST, 'decisions must name at least one explicitly accepted arrangement decision. Omit the field to leave the run waiting for one; an empty set is not an acceptance.');
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
    meter_text: source.meter_text === undefined || source.meter_text === null ? '' : requireString(source.meter_text, 'meter_text', { max: LIMITS.maxMeterTextLength, min: 1 }),
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
      if (!Number.isSafeInteger(source.expected_run_revision) || source.expected_run_revision < 1 || source.expected_run_revision > LIMITS.maxRunRevision) {
        fail(ERROR_CODES.INVALID_REQUEST, `expected_run_revision must be the revision the caller last observed: an integer from 1 to ${LIMITS.maxRunRevision}.`);
      }
      return source.expected_run_revision;
    })(),
    reconcile: source.reconcile === true,
    // The keys the caller actually sent, so "did this request ask for work"
    // is answered from the request rather than from a maintained field list.
    provided: Object.freeze(Object.keys(source)),
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
  // The identity an agent addresses this request by, derived from what makes it
  // this request rather than from its position in a list. Computed here, at the
  // one place a request is built, so every request carries one and no caller has
  // to reconstruct the rule. See `proposal-contracts.requestKeyOf`.
  const identity = {
    code, step, gate, report_reference: reportReference, baseline_id: baselineId, candidate_id: candidateId,
  };
  return Object.freeze({
    code,
    step,
    gate,
    known,
    request_key: requestKeyOf(identity),
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
  /**
   * Whether a stored candidate is one this expectation describes.
   *
   * The before-set and the matcher below are built from this one predicate, so
   * "which candidates existed before the effect" and "which candidates could be
   * the effect" can never drift apart.
   */
  const candidateMatches = (entry, expectation) => (entry.parent_candidate_id ?? null) === (expectation.parent_candidate_id ?? null)
    && (expectation.stage === null || expectation.stage === undefined ? !entry.stage : entry.stage === expectation.stage)
    && (expectation.plan_id === null || expectation.plan_id === undefined || (entry.decision_ids ?? []).includes(expectation.plan_id));

  /**
   * A record of what already existed when a step was marked pending.
   *
   * Two parts, and the second is what makes this exact rather than best-effort:
   *
   *   `ids`             bounded, for a reader of the receipt and for naming
   *                     which of several new records is this run's. Truncated
   *                     past `LIMITS.maxEffectBeforeSet`, and `complete` says
   *                     so.
   *   `count`/`digest`  constant size, and never truncated. Together they
   *                     answer "is the current set the recorded one, or the
   *                     recorded one plus exactly this record" for a set of any
   *                     size — so a project with more matching records than the
   *                     id cap still gets an exact answer rather than a guess.
   */
  /**
   * The digest of a set of record ids.
   *
   * A plain hash of the sorted ids joined by a newline, not `digestOf`: record
   * ids are opaque tokens with no newline in them, so the join is unambiguous,
   * and this carries no node budget — a reconciliation must not fail because
   * the set it is reading is large.
   */
  const setDigest = ids => sha256Of(encoder.encode([...ids].sort().join('\n')));

  /**
   * How large a set this build will search for the one record that was added.
   *
   * The search is quadratic, so it is bounded, and past the bound the answer is
   * `EFFECT_IDENTITY_UNPROVABLE` — the run halts for a reader rather than
   * guessing or replaying. Every set this service produces is orders of
   * magnitude below it: matching artifacts of one type on one candidate, or
   * candidates sharing a parent, a stage and an accepted plan.
   */
  const MAX_RECONCILE_SEARCH = LIMITS.maxEffectBeforeSet * 8;

  const beforeSet = ids => {
    const sorted = [...ids].sort();
    return {
      ids: sorted.slice(0, LIMITS.maxEffectBeforeSet),
      complete: sorted.length <= LIMITS.maxEffectBeforeSet,
      count: sorted.length,
      digest: setDigest(sorted),
    };
  };

  /**
   * The two proofs an adopted effect needs, and why neither implies the other.
   *
   *   BEFORE-SET       proves a record POSTDATES the marker. It answers "was
   *                    this already there when the effect was attempted?" and
   *                    nothing else. Novelty alone is satisfied by any
   *                    concurrent writer: another run's step, or a direct call
   *                    on the same project.
   *   EFFECT ATTEMPT   proves a record IS WHAT THIS ATTEMPT PRODUCED. Before
   *                    each mutating effect the run mints an opaque attempt id
   *                    and stores it on the marker; the service that performs
   *                    the effect writes the same id beside the record it
   *                    produced, in the same record write.
   *
   * Both are required, on the automatic path and on the reviewer-named one
   * alike. Neither implies the other: a record can postdate the marker and
   * belong to another attempt -- another run finalizing the same candidate, a
   * second decision set applied from the same parent -- and a record can carry
   * an attempt id and predate this marker, which is an earlier attempt's
   * result and not this one's.
   *
   * Why an attempt id rather than a digest of the step's inputs: a digest can
   * only cover what the step passes explicitly. `finalize` also reads the
   * candidate's CURRENT review state -- the recorded confirmations, the player
   * readback and its MML binding, the Core3 approvals, the Lead evidence, the
   * audio alignment -- so two runs can state identical options and emit under
   * different effective review state. An input digest cannot tell those apart
   * and would have let an interrupted run adopt a Final graded under evidence
   * it never saw. The attempt id needs no enumeration of what an operation
   * reads: it names the attempt, not its arguments.
   *
   * Both fields are internal provenance. Neither is a Canonical rule, neither
   * takes part in any content-addressed identity -- not the candidate
   * revision, not the artifact id -- and no caller can supply either: the
   * public Application Service strips `INTERNAL_PROVENANCE_KEYS` from every
   * operation input, so only the run-internal facade reaches them. Because the
   * attempt id is written in the same record write as the result, a stop
   * between filing the result and recording which attempt produced it is not a
   * state this can reach; a record that nonetheless carries none is reported
   * unprovable and never replayed blindly.
   */
  const EFFECT_ATTEMPT = Object.freeze({
    MATCHES: 'MATCHES',
    DIFFERS: 'DIFFERS',
    UNREADABLE: 'UNREADABLE',
    UNRECORDED: 'UNRECORDED',
  });

  /**
   * Whether a stored record is what this step's attempt produced.
   *
   * `expected` is the attempt id the marker recorded. A marker that recorded
   * none is `UNRECORDED`, and that is NOT a wildcard: it is a marker a build
   * without attempt ids wrote, restored into a build that has them, and it can
   * establish nothing about a record minted since. Treating it as "matches
   * anything" would hand a restored run the first record that postdates its
   * before-set -- which is the ownership-by-novelty this replaced, revived by
   * an upgrade. The steps whose identity really is exact without an attempt id
   * -- intake against the committed baseline, a run report whose body names its
   * run -- are settled before this is ever consulted.
   *
   * `recorded` is what the record carries: an id written by the effect, `null`
   * when the operation ran outside a run and is no step's attempt at all, and
   * `undefined` only for a record written before attempt ids existed.
   */
  const effectAttemptOf = (expected, recorded) => {
    if (expected === null || expected === undefined) return EFFECT_ATTEMPT.UNRECORDED;
    if (recorded === undefined) return EFFECT_ATTEMPT.UNREADABLE;
    return recorded === expected ? EFFECT_ATTEMPT.MATCHES : EFFECT_ATTEMPT.DIFFERS;
  };

  /** The attempt a stored entry records, or `undefined` where it records none. */
  const recordedAttempt = entry => (entry && Object.hasOwn(entry, 'effect_attempt_id') ? entry.effect_attempt_id : undefined);

  /**
   * Whether `reconcile: true` is honoured for a marker.
   *
   * True for exactly the state whose cause is `NO_EXPECTATION_RECORDED`, which
   * is the only cause `RECONCILIATION_REMEDY` advertises it for. The two
   * cannot drift: a regression asserts the table honours it for that cause and
   * no other, and that what the run advertises is what it executes.
   */
  const reconcileSettles = expectation => expectation === null || expectation === undefined;

  /** What a reconciliation can conclude. Four answers, and three are not "rerun". */
  const EFFECT = Object.freeze({
    ABSENT: 'EFFECT_ABSENT',
    FOUND: 'EFFECT_FOUND',
    AMBIGUOUS: 'EFFECT_AMBIGUOUS',
    UNPROVABLE: 'EFFECT_IDENTITY_UNPROVABLE',
  });

  /**
   * Which of the four answers the stored before-set supports, for a set-valued
   * effect (a candidate, an artifact).
   *
   * `current` is every record that matches the expectation now. The recorded
   * count and digest decide:
   *
   *   same digest              nothing was added → the effect never happened.
   *   one more, and removing
   *   exactly one record
   *   reproduces the digest    that record is the effect. Exact at any size,
   *                            and it is the record's identity that says so,
   *                            never its timestamp.
   *   more than one more       several records were added; which is this run's
   *                            cannot be derived, so it is reported ambiguous
   *                            for a caller to name — and only when the stored
   *                            ids are complete, because naming one is only
   *                            safe while membership of the before-set can
   *                            still be checked.
   *   anything else            records this step could have produced were
   *                            removed or replaced since the marker was
   *                            written. Nothing is concluded, and nothing is
   *                            replayed.
   *
   * A marker with no recorded digest — one written by an earlier build and
   * restored — proves nothing either way, so it is UNPROVABLE rather than
   * "absent": treating it as absent would replay a non-idempotent effect.
   */
  const reconcileSet = (expectation, key, current, attempt) => {
    const recorded = expectation[`${key}_digest`];
    const count = expectation[`${key}_count`];
    if (typeof recorded !== 'string' || typeof count !== 'number') {
      return { outcome: EFFECT.UNPROVABLE, reason: 'BEFORE_SET_NOT_RECORDED' };
    }

    /**
     * Which of the records that postdate the marker this attempt produced.
     *
     * Novelty got them this far; the attempt id says which of them is this
     * attempt's. It is exact, so "which of several" is not a question this can
     * be left with: at most one record carries a given attempt id, and a
     * record carrying another one is somebody else's effect rather than a
     * weaker match. What remains is the record that carries no attempt id at
     * all -- written before attempt ids existed, or restored without one --
     * and that is unprovable rather than ambiguous, because no reviewer can
     * establish from an opaque record which attempt produced it either.
     */
    const settleNovel = novel => {
      // Nothing was added at all, so nothing needs identifying: the effect
      // never landed, whatever the marker does or does not record.
      if (novel.length === 0) return { outcome: EFFECT.ABSENT };
      const verdict = new Map(novel.map(id => [id, attempt(id)]));
      // The marker itself records no attempt, and a record postdates it. This
      // is a restored, mixed-version marker: it cannot claim what it never
      // named, and no later evidence can supply what was never written down.
      if ([...verdict.values()].includes(EFFECT_ATTEMPT.UNRECORDED)) {
        return { outcome: EFFECT.UNPROVABLE, reason: 'EFFECT_ATTEMPT_EXPECTATION_NOT_RECORDED' };
      }
      const mine = novel.filter(id => verdict.get(id) === EFFECT_ATTEMPT.MATCHES);
      if (mine.length === 1) return { outcome: EFFECT.FOUND, id: mine[0] };
      if (mine.length > 1) return { outcome: EFFECT.UNPROVABLE, reason: 'EFFECT_ATTEMPT_NOT_UNIQUE' };
      // Nothing carries this attempt id and nothing is opaque: every record
      // added since the marker belongs to another attempt, so this one's
      // effect positively never landed. The one conclusion that re-runs a step.
      return novel.every(id => verdict.get(id) === EFFECT_ATTEMPT.DIFFERS)
        ? { outcome: EFFECT.ABSENT }
        : { outcome: EFFECT.UNPROVABLE, reason: 'EFFECT_ATTEMPT_NOT_RECORDED' };
    };

    const sorted = [...current].sort();
    if (setDigest(sorted) === recorded) return { outcome: EFFECT.ABSENT };
    if (sorted.length === count + 1) {
      if (sorted.length > MAX_RECONCILE_SEARCH) return { outcome: EFFECT.UNPROVABLE, reason: 'MATCHING_SET_TOO_LARGE_TO_SEARCH' };
      const novel = sorted.filter(id => setDigest(sorted.filter(other => other !== id)) === recorded);
      if (novel.length === 1) return settleNovel(novel);
      return { outcome: EFFECT.UNPROVABLE, reason: 'BEFORE_SET_NOT_A_SUBSET' };
    }
    if (sorted.length > count + 1) {
      if (expectation[`${key}_complete`] === true && Array.isArray(expectation[key])) {
        const known = expectation[key];
        return settleNovel(sorted.filter(id => !known.includes(id)));
      }
      return { outcome: EFFECT.UNPROVABLE, reason: 'SEVERAL_ADDED_AND_BEFORE_SET_TRUNCATED' };
    }
    return { outcome: EFFECT.UNPROVABLE, reason: 'RECORDS_REMOVED_SINCE_THE_MARKER' };
  };

  /**
   * Whether a named record is the one this pending step produced.
   *
   * The named path never gets to conclude more than the automatic one, so it
   * requires the same two proofs. Novelty: removing the named record from the
   * current set reproducing the recorded digest is proof; otherwise membership
   * of the stored ids is the only evidence there is, and that is conclusive
   * only while those ids are complete. Attempt: the record must carry THIS
   * attempt's id.
   *
   * Both proofs, exactly as the automatic path requires them -- including a
   * record that carries no attempt id at all. A reviewer looking at an opaque
   * record is in the same position the service is: it does not say which
   * attempt produced it, and naming it is a statement about what the reviewer
   * believes rather than evidence about what happened. Recording a belief as
   * `EFFECT_NAMED_BY_REVIEWER`, which every downstream reader treats as a
   * settled effect, is what this refuses. The interrupted run says so in its
   * request, and offers the remedies that can actually be executed for that
   * cause instead.
   */
  const namedRecordIsThisEffect = (expectation, key, current, id, attempt) => {
    const recorded = expectation[`${key}_digest`];
    if (typeof recorded !== 'string') return { proven: false, reason: 'BEFORE_SET_NOT_RECORDED' };
    const sorted = [...current].sort();
    const novel = setDigest(sorted.filter(other => other !== id)) === recorded
      ? { proven: true }
      : (expectation[`${key}_complete`] !== true || !Array.isArray(expectation[key]))
        ? { proven: false, reason: 'BEFORE_SET_TRUNCATED' }
        : expectation[key].includes(id)
          ? { proven: false, reason: 'RECORD_PREDATES_THE_MARKER' }
          : { proven: true };
    if (!novel.proven) return novel;
    const bound = attempt(id);
    if (bound === EFFECT_ATTEMPT.DIFFERS) return { proven: false, reason: 'RECORD_IS_ANOTHER_ATTEMPT' };
    if (bound === EFFECT_ATTEMPT.UNREADABLE) return { proven: false, reason: 'EFFECT_ATTEMPT_NOT_RECORDED' };
    if (bound === EFFECT_ATTEMPT.UNRECORDED) return { proven: false, reason: 'EFFECT_ATTEMPT_EXPECTATION_NOT_RECORDED' };
    return { proven: true };
  };

  /**
   * The audit state a persisted Final already recorded, read back from it.
   *
   * A `final_mml` artifact carries what the emitter graded — its emit status,
   * its gate map and the readiness summary at emission — and the job that
   * produced it stored the artifact's id, so the job is found by that reference
   * rather than by being the newest. Everything here is read; nothing is
   * re-derived, and nothing is invented: an artifact whose body cannot be read
   * restores nothing and an artifact no job uniquely claims gets no job id.
   */
  const restoredFinal = (owner, record, artifactId) => {
    const body = operations.artifactBody(owner, artifactId);
    if (!body) return null;
    const jobs = operations.jobsForArtifact(record, artifactId);
    return {
      gates: body.gates ?? null,
      readiness_blockers: [...(body.readiness_summary?.pre_game_blocking ?? [])],
      // Exactly one job claims this artifact, or none is recorded. Attributing
      // a Final to a job that merely ran nearby would put a false identity in
      // the run report.
      job_id: jobs.length === 1 ? jobs[0] : null,
      detail: {
        operation: OPERATION_STATUS.SUCCEEDED,
        emit_status: body.emit_status ?? null,
        gates: body.gates ?? null,
        technical_timing_repair: body.technical_timing_repair ?? null,
        technical_validation: body.readiness_summary?.technical_validation ?? null,
        artifact_id: artifactId,
        candidate_id: body.candidate_id ?? null,
        restored_from: 'final_artifact',
        restored_job_ids: jobs,
      },
    };
  };

  /**
   * The expectation a pending step is actually settled against.
   *
   * Every path that reads a pending marker reads it through this: settling it,
   * deciding whether a request is asking for new work, and validating a named
   * artifact. A marker and the rule applied to it cannot disagree if there is
   * only one place that says what the marker means.
   *
   * The run report is the one step whose identity does not depend on the
   * marker: its body names the run that produced it. So a report marker written
   * by an earlier build, or restored without its expectation, is settled by
   * that identity — and `candidate_id: null` means "any candidate", as
   * `artifactsMatching` reads it, because the run id in the body is already
   * exact and a restored run may have moved candidate since.
   */
  const effectivePendingExpectation = run => {
    const pending = run.pending_step;
    if (!pending) return null;
    if (pending.step === RUN_STEP.REPORT && !pending.expectation?.expected_run_id) {
      return {
        kind: 'artifact',
        artifact_type: RUN_REPORT_ARTIFACT_TYPE,
        expected_run_id: run.run_id,
        candidate_id: null,
        recovered_from_run_identity: true,
      };
    }
    return pending.expectation ?? null;
  };

  /**
   * The state a reconciliation halt left on the run, cleared by settling it.
   *
   * An interrupted run halts on `RUN_RECONCILIATION_REQUIRED` and files a
   * `RECONCILIATION_REQUIRED` request telling a reader to inspect the record
   * and name what the step produced. Settling the step -- by finding the
   * effect, by a reviewer naming it, or by establishing that it never landed
   * -- answers exactly that question, so the halt, the blocker naming it and
   * the request asking for it stop describing anything and are dropped.
   *
   * Only those are dropped. A readiness blocker is a fact about the song that
   * a step recorded, not a fact about the interruption, so it survives
   * untouched; an adopted Final then restores its own, read back from what it
   * persisted.
   */
  const clearedReconciliationState = run => ({
    halt: null,
    needs_reconciliation: false,
    blockers: (run.blockers ?? []).filter(code => code !== ERROR_CODES.RUN_RECONCILIATION_REQUIRED),
    review_requests: (run.review_requests ?? []).filter(request => request.code !== RUN_REVIEW_REQUEST.RECONCILIATION_REQUIRED),
  });

  /**
   * The run-state transition an adopted artifact effect produces.
   *
   * One transition for both ways an artifact effect is settled — found by the
   * stored identity, or named by a reviewer — so the two differ in how the run
   * came by the result and in nothing else. A named Final restores the same
   * audit facts an automatically recovered one does, from the same source.
   */
  const adoptedArtifactChanges = (owner, record, run, { step, expectation, artifactId, inputFingerprint, reason }) => {
    const restored = expectation.artifact_type === FINAL_ARTIFACT_TYPE
      ? restoredFinal(owner, record, artifactId)
      : null;
    // A Final whose own body cannot be read cannot supply the audit facts this
    // adoption promises — what the emitter graded, and what readiness said at
    // emission. Adopting it anyway would leave a run reporting a Final with no
    // gates and no emit status; re-running the emitter would produce a second
    // Final for one attempt. Neither: the caller is told the identity cannot be
    // established. Normal storage writes the body with the entry, so this is
    // restored-record and corruption hardening rather than an ordinary path.
    if (expectation.artifact_type === FINAL_ARTIFACT_TYPE && restored === null) return null;
    const changes = {
      pending_step: null,
      needs_reconciliation: false,
      artifact_ids: [...new Set([...run.artifact_ids, artifactId])],
      steps: appendStep(run, stepReceipt({
        step,
        status: RUN_STEP_STATUS.SATISFIED,
        inputFingerprint: inputFingerprint ?? null,
        resultReference: artifactId,
        jobId: restored?.job_id ?? null,
        blockers: restored ? [...restored.readiness_blockers] : [],
        detail: { reconciled: true, reason, expectation, ...(restored ? restored.detail : {}) },
      })),
    };
    if (restored) {
      // The facts the Final itself carries: what the emitter graded, and what
      // readiness said at emission. A recovered run reports them exactly as a
      // run whose receipt arrived does — however it came to adopt the Final.
      changes.gates = restored.gates;
      changes.readiness_blockers = [...restored.readiness_blockers];
      // The run's workflow blockers are what this Final says is unsatisfied,
      // not what the interruption said. A recovered run that kept reporting
      // `RUN_RECONCILIATION_REQUIRED` beside a restored Final would name a
      // reconciliation nobody can perform, on a step that is settled.
      changes.blockers = [...restored.readiness_blockers];
      if (restored.job_id) changes.job_ids = [...new Set([...run.job_ids, restored.job_id])];
    }
    if (expectation.artifact_type === FINAL_ARTIFACT_TYPE) changes.final_artifact_id = artifactId;
    if (expectation.artifact_type === RUN_REPORT_ARTIFACT_TYPE) {
      changes.report_artifact_id = artifactId;
      changes.state = RUN_STATE.COMPLETED;
    }
    return changes;
  };

  /**
   * The attempt a stored candidate records, read against this expectation.
   *
   * Deliberately NOT folded into `candidateMatches`: the matcher defines the
   * before-set, and a before-set narrowed by the attempt id would answer "was
   * a record of my attempt already there" rather than "what was already
   * there". Novelty and ownership stay two separate questions asked of the
   * same set.
   */
  const candidateAttempt = (record, expectation) => {
    const byId = new Map(record.candidates.map(entry => [entry.candidate_id, entry]));
    return id => effectAttemptOf(expectation.effect_attempt_id, recordedAttempt(byId.get(id)));
  };

  /** The attempt a stored artifact records, read against this expectation. */
  const artifactAttempt = (record, expectation) => {
    const byId = new Map(record.artifacts.map(entry => [entry.artifact_id, entry]));
    return id => effectAttemptOf(expectation.effect_attempt_id, recordedAttempt(byId.get(id)));
  };

  /** Every candidate that matches an expectation right now. */
  const candidatesMatching = (record, expectation) => record.candidates
    .filter(entry => candidateMatches(entry, expectation))
    .map(entry => entry.candidate_id);

  /** Every artifact that matches an expectation right now. */
  /**
   * Every artifact that matches an expectation right now.
   *
   * A null `candidate_id` means "any candidate", which only the report-by-run
   * -identity recovery uses: the run id inside the report's body is already an
   * exact identity, so filtering by the run's current candidate would hide the
   * very report it is looking for. Every other expectation names its candidate.
   */
  const artifactsMatching = (record, expectation) => record.artifacts
    .filter(entry => entry.type === expectation.artifact_type)
    .filter(entry => expectation.candidate_id === null || expectation.candidate_id === undefined
      || entry.candidate_id === expectation.candidate_id)
    .map(entry => entry.artifact_id);

  /**
   * What the stored marker lets this call conclude about a pending effect.
   *
   * Always one of the four `EFFECT` answers. `ABSENT` is the only one that
   * lets a step run again, and it is returned only when the record positively
   * shows the effect never landed — never as a stand-in for "cannot tell".
   */
  const expectationSatisfiedBy = (owner, record, expectation) => {
    if (!expectation) return { outcome: EFFECT.UNPROVABLE, reason: 'NO_EXPECTATION_RECORDED' };
    if (expectation.kind === 'baseline') {
      // Asset ids do not identify a baseline. The meter map is an intake input
      // an MML source is parsed against, and a baseline that was already there
      // when the marker was written is by construction not this effect's
      // output. Both are checked, and both fail closed: an unproven identity is
      // never adopted, and the step runs again under the inputs it states.
      // A project holds one baseline, so there is no set to overflow: either
      // the committed baseline answers this step's inputs and is not the one
      // that was already there, or the step never landed.
      const baseline = record.baseline;
      if (!baseline) return { outcome: EFFECT.ABSENT };
      if (!sameSelection(baseline.asset_ids, expectation.asset_ids)) return { outcome: EFFECT.ABSENT };
      if (expectation.known_baseline_id !== undefined && baseline.baseline_id === expectation.known_baseline_id) return { outcome: EFFECT.ABSENT };
      if (expectation.meter_text_sha256 !== undefined
        && meterBinding(baseline, expectation.meter_text_sha256 ?? null).state !== METER_BINDING.SATISFIED) return { outcome: EFFECT.ABSENT };
      return { outcome: EFFECT.FOUND, baseline_id: baseline.baseline_id };
    }
    if (expectation.kind === 'candidate') {
      // Matched on the parent, the stage and — where the step names one — the
      // plan the reviewer accepted, which the candidate record stores as its
      // `decision_ids`; then narrowed to what was NOT already there when the
      // marker was written. The before-set is what the plan id cannot supply on
      // its own: G11-D names no plan, so a sibling candidate applied earlier
      // from the same parent matches the filter exactly, and adopting it would
      // record another decision set's candidate as this run's effect.
      // Adoption then requires exactly ONE remaining match: two runs can each
      // add a candidate from the same parent, and adopting whichever one
      // `find` reached would be guessing. An ambiguous answer is not an
      // answer, so it is reported as unconfirmable instead.
      // ...and then to which attempt produced each of them. The before-set
      // cannot tell this run's candidate from a candidate another caller
      // applied from the same parent while this step was interrupted: both
      // postdate the marker. The attempt id can, because the application that
      // minted it recorded the attempt it was performing beside it.
      const settled = reconcileSet(expectation, 'known_candidate_ids', candidatesMatching(record, expectation),
        candidateAttempt(record, expectation));
      if (settled.outcome === EFFECT.FOUND) return { outcome: EFFECT.FOUND, candidate_id: settled.id };
      return { ...settled, kind: 'candidate', candidate_ids: settled.ids };
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
      const matches = artifactsMatching(record, expectation);
      if (expectation.expected_run_id) {
        const owned = matches.filter(id => operations.artifactRunId(owner, id) === expectation.expected_run_id);
        if (owned.length > 1) return { outcome: EFFECT.AMBIGUOUS, kind: 'artifact', artifact_ids: owned };
        return owned.length === 1
          ? { outcome: EFFECT.FOUND, artifact_id: owned[0] }
          : { outcome: EFFECT.ABSENT };
      }
      //   attempt    a Final's body names no run, and novelty alone does not
      //              say whose Final it is: another run finalizing the same
      //              candidate also postdates the marker, and may have emitted
      //              under review state this run never saw. The filing
      //              recorded the attempt that produced it, so another
      //              attempt's Final is excluded rather than adopted as this
      //              step's.
      const settled = reconcileSet(expectation, 'known_artifact_ids', matches, artifactAttempt(record, expectation));
      if (settled.outcome === EFFECT.FOUND) return { outcome: EFFECT.FOUND, artifact_id: settled.id };
      return { ...settled, kind: 'artifact', artifact_ids: settled.ids };
    }
    return { outcome: EFFECT.UNPROVABLE, reason: 'UNKNOWN_EXPECTATION_KIND' };
  };

  /** A before-set's four fields, under one key, for storing on an expectation. */
  const recordBeforeSet = (key, set) => ({
    [key]: set.ids,
    [`${key}_complete`]: set.complete,
    [`${key}_count`]: set.count,
    [`${key}_digest`]: set.digest,
  });

  /** The matching artifacts that exist right now, for an effect's before-set. */
  const artifactsLike = (record, candidateId, artifactType) => beforeSet(record.artifacts
    .filter(entry => entry.candidate_id === candidateId && entry.type === artifactType)
    .map(entry => entry.artifact_id));

  /** The matching candidates that exist right now, for an effect's before-set. */
  const candidatesLike = (record, expectation) => beforeSet(record.candidates
    .filter(entry => candidateMatches(entry, expectation))
    .map(entry => entry.candidate_id));

  /**
   * A candidate-producing step's expectation, with its before-set attached.
   *
   * The before-set is computed from the expectation itself, so a step cannot
   * record one filter and be matched by another.
   */
  const candidateExpectation = (record, { parent, stage = null, planId = null, inputFingerprint = null, effectAttemptId = null }) => {
    const expectation = { kind: 'candidate', parent_candidate_id: parent ?? null, stage, plan_id: planId };
    return {
      ...expectation,
      ...recordBeforeSet('known_candidate_ids', candidatesLike(record, expectation)),
      // The attempt whose record this step is looking for, and the explicit
      // input it was applying. The before-set is computed from the expectation
      // WITHOUT either, so they narrow who may claim a novel record and never
      // narrow what counts as already-there.
      effect_attempt_id: effectAttemptId,
      effect_input_fingerprint: inputFingerprint,
    };
  };

  /**
   * Run one mutating step: mark it pending, apply the effect, store the receipt.
   *
   * The three interruption classes are handled by the same three writes.
   * `pending_step` is stored *before* the effect, so a stop anywhere after it
   * leaves a marker, and the marker carries the expectation, so the next call
   * can tell "effect not applied" from "effect applied, receipt lost" without
   * replaying anything.
   */
  const withEffect = async (owner, projectId, run, { step, expectation, apply, idempotent = false, inputFingerprint = null, effectAttemptId = null }) => {
    let current = bumpRun(owner, projectId, run, {
      state: RUN_STATE.RUNNING,
      // The fingerprint travels on the marker as well as on the receipt. An
      // adopted effect has to be recorded with the fingerprint the step would
      // have computed, or `nextStep` sees a receipt whose inputs it cannot
      // match and runs the step again — which is how adopting an effect rather
      // than replaying it would have replayed it anyway, one step later.
      // The attempt id travels on the marker, and the SAME id is what the
      // effect writes beside whatever record it produces. It is minted by the
      // step, before this write, so a stop anywhere after it leaves a marker
      // naming an attempt that either left a record or did not -- and never a
      // marker whose record cannot be told from a concurrent writer's.
      pending_step: { step, expectation: expectation ?? null, idempotent, input_fingerprint: inputFingerprint, effect_attempt_id: effectAttemptId, at: now() },
      needs_reconciliation: false,
    });
    await fire('beforeEffect', { step, run: current });
    const outcome = await apply();
    await fire('afterEffect', { step, run: current, outcome });
    const steps = appendStep(current, outcome.receipt);
    const replaced = replacesIdentity(current, outcome.runChanges);
    current = bumpRun(owner, projectId, current, {
      pending_step: null,
      steps,
      ...(outcome.runChanges ?? {}),
      // Whatever this effect replaced, nothing downstream of it survives it.
      ...(replaced ? invalidateDownstream(current, step, steps, { clearGates: replaced !== 'final' }) : {}),
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
      decision_set_fingerprint: decisionStepFingerprint(normalized),
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
        'An explicitly accepted arrangement decision set (KEEP / ASSIGN_ROLE / MOVE_ROLE / OMIT_FROM_SIX / DUPLICATE_WITH_JUSTIFICATION), each with a reason, evidence and the accepting reviewer. MOVE_ROLE into or out of Melody still needs a complete leadEvidence record citing the baseline source identity. For role-less source material only, an initial ASSIGN_ROLE -> Melody may omit leadEvidence solely to materialize a reversible review-pending candidate; that assignment is not Lead evidence and Gate 3 remains PENDING until candidate-bound reviewer evidence is supplied. This run resolves no PENDING lane on a caller\'s behalf.',
        'Alternatively, name an existing candidate with target_candidate_id when starting, or adopt_candidate_id when resuming. A candidate is never selected for being the newest, so a project that already holds candidates does not make this step satisfied.',
      ],
      availableOperations: ['suggestArrangement', 'listBaselineEvents', 'applyDecisions', 'startRun.target_candidate_id'],
      invalidatedBy: ['baseline', 'canonical', 'decisions'],
      detail: suggested === null ? null : {
        lane_count: suggested.lane_count ?? null,
        pending_lane_count: suggested.pending_lane_count ?? null,
        merge_diagnostics: suggested.merge_diagnostics ?? null,
        roleless_melody_candidate_boundary: 'ASSIGN_ROLE_ONLY_REVIEW_PENDING',
      },
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
        legacy_merge_diagnostics: summarizeLegacyMergeDiagnostics(plan.legacyMergeDiagnostics ?? []),
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

    // The meter map is an intake input, and only the request carries its text:
    // the run stores its digest, which cannot be re-ingested from. So a step
    // that would ingest under a meter other than the one this run states does
    // not run at all. Without this, a resume that omits `meter_text` after an
    // interrupted meter-stating intake would build a baseline from an EMPTY
    // meter and file a receipt fingerprinted with the stated one — a receipt
    // describing inputs the baseline was not built from.
    const statedMeterDigest = run.inputs.meter_text_sha256 ?? null;
    const requestMeterDigest = normalized.meter_text ? sha256Of(encoder.encode(normalized.meter_text)) : null;
    if (statedMeterDigest !== null && requestMeterDigest !== statedMeterDigest) {
      return halt(owner, projectId, run, {
        state: RUN_STATE.BLOCKED,
        reason: RUN_HALT.METER_BINDING_UNPROVABLE,
        step: RUN_STEP.INTAKE,
        requests: [stalenessRequest({
          code: RUN_HALT.METER_BINDING_UNPROVABLE,
          detail: {
            reason: 'RUN_METER_INPUT_NOT_SUPPLIED',
            baseline_id: record.baseline?.baseline_id ?? null,
            consumed: true,
            baseline_meter_text_sha256: record.baseline?.intake_inputs?.meter_text_sha256 ?? null,
            run_meter_text_sha256: statedMeterDigest,
            request_meter_text_sha256: requestMeterDigest,
          },
        })],
      });
    }
    const fingerprint = digestOf({ asset_digests: selection.digests, meter_text_sha256: statedMeterDigest });
    const applied = await withEffect(owner, projectId, run, {
      step: RUN_STEP.INTAKE,
      inputFingerprint: fingerprint,
      // Asset ids alone do not identify a baseline: the meter map is an intake
      // input an MML source is parsed against, so the marker carries it, and it
      // carries the baseline that was already committed so that one can never
      // be mistaken for this step's output.
      expectation: {
        kind: 'baseline',
        asset_ids: assetIds,
        meter_text_sha256: run.inputs.meter_text_sha256 ?? null,
        known_baseline_id: record.baseline?.baseline_id ?? null,
      },
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
              merge_diagnostics: summarizeArrangementMergeDiagnostics(suggestion.merge_diagnostics),
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
    const fingerprint = decisionStepFingerprint(normalized);
    const attemptId = newEffectAttemptId();
    const parent = run.candidate_id;
    const applied = await withEffect(owner, projectId, run, {
      step: RUN_STEP.APPLY_DECISIONS,
      inputFingerprint: fingerprint,
      effectAttemptId: attemptId,
      // G11-D names no accepted plan, so the parent and the stage alone match
      // every sibling candidate applied earlier from the same parent. The
      // before-set tells this step's candidate from those; the attempt id
      // tells it from a candidate another caller applied from the same parent
      // while this step was interrupted, which the before-set cannot -- both
      // of them postdate the marker, and only one is this attempt's.
      expectation: candidateExpectation(record, { parent, inputFingerprint: fingerprint, effectAttemptId: attemptId }),
      apply: async () => {
        const result = await operations.applyDecisions(owner, projectId, {
          decisions: normalized.decisions,
          parentCandidateId: parent,
          acceptedBy: normalized.accepted_by,
          inputFingerprint: fingerprint,
          effectAttemptId: attemptId,
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
              diagnostic_codes: [...new Set((decisions.diagnostics ?? []).map(item => item.code).filter(Boolean))].sort(),
              review_pending: (decisions.diagnostics ?? []).some(item => item.code === 'ROLELESS_LEAD_ASSIGNMENT_REVIEW_PENDING'),
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
    const attemptId = newEffectAttemptId();
    const parent = run.candidate_id;
    const applied = await withEffect(owner, projectId, run, {
      step: RUN_STEP.FINAL_REDUCTION,
      inputFingerprint: fingerprint,
      effectAttemptId: attemptId,
      // The accepted plan id names the decisions this reduction applies, so
      // the parent, the stage and the plan already exclude another input's
      // candidate. The attempt id is recorded anyway, because the plan id is
      // the reviewer's *statement* of the input and this is the attempt the
      // step actually made: one rule for every candidate-minting step, so none
      // of them rests on an argument about why it is the exception.
      expectation: candidateExpectation(record, { parent, stage: REDUCTION_STAGE, planId: normalized.final_reduction.expected_plan_id, inputFingerprint: fingerprint, effectAttemptId: attemptId }),
      apply: async () => {
        const result = await operations.applyFinalReduction(owner, projectId, {
          candidateId: parent,
          decisions: normalized.final_reduction.decisions,
          expectedPlanId: normalized.final_reduction.expected_plan_id,
          acceptedBy: normalized.final_reduction.accepted_by,
          instrumentProfile: normalized.final_reduction.instrument_profile,
          inputFingerprint: fingerprint,
          effectAttemptId: attemptId,
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
    const attemptId = newEffectAttemptId();
    const parent = run.candidate_id;
    const applied = await withEffect(owner, projectId, run, {
      step: RUN_STEP.MOBILE_ADAPTATION,
      inputFingerprint: fingerprint,
      effectAttemptId: attemptId,
      expectation: candidateExpectation(record, { parent, stage: ADAPTATION_STAGE, planId: normalized.mobile_adaptation.expected_plan_id, inputFingerprint: fingerprint, effectAttemptId: attemptId }),
      apply: async () => {
        const result = await operations.applyMobileAdaptation(owner, projectId, {
          candidateId: parent,
          profile: normalized.mobile_adaptation.profile,
          expectedPlanId: normalized.mobile_adaptation.expected_plan_id,
          acceptedBy: normalized.mobile_adaptation.accepted_by,
          inputFingerprint: fingerprint,
          effectAttemptId: attemptId,
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
    const options = finalizeOptionsOf(run, normalized);
    const fingerprint = finalizeStepFingerprint(candidateId, options);
    const attemptId = newEffectAttemptId();
    const finalsBefore = artifactsLike(record, candidateId, FINAL_ARTIFACT_TYPE);
    const applied = await withEffect(owner, projectId, run, {
      step: RUN_STEP.FINALIZE,
      inputFingerprint: fingerprint,
      effectAttemptId: attemptId,
      // A Final artifact body carries no run id, so the before-set is what
      // tells this run's Final apart from one that was already there -- and
      // the attempt id is what tells it from a Final filed for the same
      // candidate since. Novelty alone would adopt that one; the input
      // fingerprint alone would still adopt it whenever the options matched,
      // and `finalize` grades against the candidate's CURRENT review state,
      // which no digest of this step's arguments covers.
      expectation: {
        kind: 'artifact',
        candidate_id: candidateId,
        artifact_type: FINAL_ARTIFACT_TYPE,
        ...recordBeforeSet('known_artifact_ids', finalsBefore),
        effect_attempt_id: attemptId,
        effect_input_fingerprint: fingerprint,
      },
      apply: async () => {
        const result = await operations.finalize(owner, projectId, {
          candidateId,
          // Passed through exactly as supplied. Asking a run to finalize never
          // turns the repair on, and there is no automatic mode.
          technicalTimingRepair: options.technical_timing_repair === true,
          pickup: options.pickup,
          finalPartial: options.final_partial,
          inputFingerprint: fingerprint,
          effectAttemptId: attemptId,
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
    const reportsBefore = artifactsLike(record, run.candidate_id, RUN_REPORT_ARTIFACT_TYPE);
    const applied = await withEffect(owner, projectId, run, {
      step: RUN_STEP.REPORT,
      // A run report names its run, so identity settles it exactly; the
      // before-set is recorded too, for a reader of the receipt.
      expectation: {
        kind: 'artifact',
        candidate_id: run.candidate_id,
        artifact_type: RUN_REPORT_ARTIFACT_TYPE,
        expected_run_id: run.run_id,
        ...recordBeforeSet('known_artifact_ids', reportsBefore),
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

  /**
   * The APPLY_DECISIONS step's input identity: the decision set AND the
   * reviewer the run named for it.
   *
   * One helper, used by every site that asks "is this the same decision step":
   * the input the run records at start, the input a resume replaces, the
   * fingerprint the marker and the receipt carry, the rerun decision, and the
   * binding the minted candidate is recovered by. A top-level `accepted_by` is
   * part of the input and not decoration: `applyDecisions` resolves each
   * decision's reviewer as `decision.acceptedBy ?? accepted_by`, so the same
   * decisions under a different named reviewer are a different acceptance and
   * produce a different candidate. Four subtly different fingerprints for one
   * step is how a step re-runs on an input it already applied, or skips one it
   * has not.
   */
  const decisionStepFingerprint = ({ decisions, accepted_by: acceptedBy = null }) => (decisions === null || decisions === undefined
    ? null
    : digestOf({ decisions, accepted_by: acceptedBy ?? null }));

  /**
   * One attempt at one mutating effect.
   *
   * Opaque, minted here and nowhere else, and never derived from the step's
   * inputs: two attempts with byte-identical inputs are two attempts. It is
   * `INTERNAL_PROVENANCE_KEYS` on every operation input, so the public
   * Application Service strips it and no caller can claim one.
   */
  const newEffectAttemptId = () => newId(ID_PREFIX.effectAttempt);

  /** The FINALIZE step's input identity: the candidate and the emit options. */
  const FINALIZE_DEFAULT_OPTIONS = Object.freeze({ technical_timing_repair: false, pickup: null, final_partial: null });
  const finalizeOptionsOf = (run, normalized) => normalized.finalize ?? run.inputs.finalize_options ?? FINALIZE_DEFAULT_OPTIONS;
  const finalizeStepFingerprint = (candidateId, options) => digestOf({ candidate_id: candidateId, options });

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
      if (name === RUN_STEP.APPLY_DECISIONS) return Boolean(normalized.decisions?.length) && receipt.input_fingerprint !== decisionStepFingerprint(normalized);
      if (name === RUN_STEP.FINAL_REDUCTION) return Boolean(normalized.final_reduction) && receipt.input_fingerprint !== digestOf(normalized.final_reduction);
      if (name === RUN_STEP.MOBILE_ADAPTATION) return Boolean(normalized.mobile_adaptation) && receipt.input_fingerprint !== digestOf(normalized.mobile_adaptation);
      if (name === RUN_STEP.REVIEW) return receipt.input_fingerprint !== reviewFingerprint(run);
      if (name === RUN_STEP.FINALIZE) return receipt.input_fingerprint !== finalizeStepFingerprint(run.candidate_id, finalizeOptionsOf(run, normalized));
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
   * The operations an unprovable interruption advertises, for one exact cause.
   *
   * Read-only inspection is always listed: whatever the cause, a reader can
   * look. Beyond that only what `RECONCILIATION_REMEDY` says this build will
   * honour, named for the kind of record the pending step produces. When
   * nothing can settle the run, it says so and points at a new run rather than
   * listing an operation that would refuse.
   */
  const unprovableRemedy = (expectation, cause) => {
    const kind = expectation?.kind ?? null;
    const remedy = RECONCILIATION_REMEDY[cause] ?? { reconcile: false, name: false };
    const inspect = kind === 'artifact' ? ['getProject', 'getRun', 'getArtifact'] : ['getProject', 'getRun'];
    const namedOperation = kind === 'artifact' ? 'resumeRun.adopt_artifact_id' : 'resumeRun.adopt_candidate_id';
    const operations = [
      ...inspect,
      ...(remedy.name && kind ? [namedOperation] : []),
      ...(remedy.reconcile ? ['resumeRun (reconcile)'] : []),
      ...(remedy.name || remedy.reconcile ? [] : ['startRun']),
    ];
    const preamble = 'Whether this step\'s effect was persisted cannot be established from what the marker recorded, so it is not replayed: repeating it could produce a second result for one attempt.';
    const missing = remedy.name && remedy.reconcile
      ? `${preamble} Inspect the project record, then name the record this step produced (${namedOperation}) or resume with reconcile: true once the state is known.`
      : remedy.name
        ? `${preamble} Inspect the project record, then name the record this step produced (${namedOperation}). reconcile: true does not settle this cause: the marker recorded what to match on, and a flag cannot overrule the record into a replay.`
        : remedy.reconcile
          ? `${preamble} The marker recorded no expectation to match on, so inspect the project record and resume with reconcile: true once the state is known. There is nothing to hold a named record to, so naming one is refused.`
          : `${preamble} Neither naming a record nor reconcile: true can settle this cause, and neither is offered: what the run needs is missing from the record itself. Inspect it, repair or restore it outside this service if that is possible, or start a new run for this work.`;
    return { operations, missing, honoured: { reconcile: remedy.reconcile === true, adopt: remedy.name === true } };
  };

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
    const expectation = effectivePendingExpectation(run);
    // `reconcile: true` is honoured for exactly the cause `RECONCILIATION_REMEDY`
    // advertises it for -- a marker that recorded no expectation, where the
    // caller's inspection is the only evidence there can be. Where an
    // expectation exists, the record itself answers, and a boolean cannot
    // overrule it into a replay.
    const settled = reconcileSettles(expectation)
      ? { outcome: pending.idempotent === true || normalized.reconcile ? EFFECT.ABSENT : EFFECT.UNPROVABLE, reason: 'NO_EXPECTATION_RECORDED' }
      : expectationSatisfiedBy(owner, record, expectation);
    // An identified Final whose body cannot be read is not an identified
    // effect: the facts it is supposed to restore are unreachable.
    const adoption = settled.outcome === EFFECT.FOUND && settled.artifact_id
      ? adoptedArtifactChanges(owner, record, run, {
        step: pending.step,
        expectation,
        artifactId: settled.artifact_id,
        inputFingerprint: pending.input_fingerprint,
        reason: 'EFFECT_FOUND_BY_STORED_IDENTITY',
      })
      : null;
    const found = settled.outcome === EFFECT.FOUND && settled.artifact_id && adoption === null
      ? { outcome: EFFECT.UNPROVABLE, reason: 'FINAL_ARTIFACT_BODY_UNREADABLE' }
      : settled;

    // Neither presence nor absence established. This is NOT "absent": replaying
    // a non-idempotent effect on a maybe would file a second Final. The run
    // says which step is unconfirmed and stops.
    if (found.outcome === EFFECT.UNPROVABLE) {
      return {
        run: bumpRun(owner, projectId, run, {
          state: RUN_STATE.INTERRUPTED,
          needs_reconciliation: true,
          halt: { reason: RUN_HALT.RECONCILIATION_REQUIRED, step: pending.step, at: now() },
          steps: appendStep(run, stepReceipt({ step: pending.step, status: RUN_STEP_STATUS.UNCONFIRMED, detail: { reason: EFFECT.UNPROVABLE, cause: found.reason ?? null } })),
          review_requests: [reviewRequest({
            code: RUN_REVIEW_REQUEST.RECONCILIATION_REQUIRED,
            step: pending.step,
            blockers: [ERROR_CODES.RUN_RECONCILIATION_REQUIRED],
            reportReference: 'run.pending_step',
            baselineId: run.baseline_id,
            candidateId: run.candidate_id,
            missing: [unprovableRemedy(expectation, found.reason ?? null).missing],
            availableOperations: unprovableRemedy(expectation, found.reason ?? null).operations,
            invalidatedBy: ['candidate', 'baseline'],
            detail: {
              unconfirmed_step: pending.step,
              marked_at: pending.at,
              cause: found.reason ?? null,
              // What the run will actually honour for this cause, beside the
              // operations it lists. A reader comparing the two sees one answer.
              remedy: unprovableRemedy(expectation, found.reason ?? null).honoured,
            },
          })],
          blockers: [ERROR_CODES.RUN_RECONCILIATION_REQUIRED],
        }),
        halted: true,
      };
    }

    if (found.outcome === EFFECT.AMBIGUOUS) {
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
    if (found.outcome === EFFECT.FOUND) {
      // An adopted effect is that effect, so the receipt and the run state it
      // leaves behind are the ones the effect itself recorded — read back from
      // what it persisted, never re-derived by running the operation again.
      // An artifact effect goes through the same transition a reviewer-named
      // one does; only the recorded reason differs.
      const changes = { ...clearedReconciliationState(run), ...(adoption ?? {
          pending_step: null,
          needs_reconciliation: false,
          steps: appendStep(run, stepReceipt({
            step: pending.step,
            status: RUN_STEP_STATUS.SATISFIED,
            inputFingerprint: pending.input_fingerprint ?? null,
            resultReference: found.candidate_id ?? found.baseline_id ?? null,
            detail: { reconciled: true, reason: 'EFFECT_FOUND_BY_STORED_IDENTITY', expectation },
          })),
        }) };
      if (found.baseline_id) {
        // An adopted intake is the same event as an intake that returned its
        // receipt, so it leaves the run in the same state. `intake.run`
        // replaced the baseline and deleted every candidate derived from the
        // old one, so a run that kept pointing at one would be permanently
        // blocked on RUN_CANDIDATE_CHANGED — a successful intake turned into an
        // unresumable run by the loss of a receipt.
        changes.baseline_id = found.baseline_id;
        changes.candidate_id = null;
        changes.candidate_lineage = [];
      }
      if (found.candidate_id) {
        changes.candidate_id = found.candidate_id;
        changes.candidate_lineage = [...new Set([...run.candidate_lineage, found.candidate_id])];
      }
      // The same invariant an effect of this step applies: an adopted result
      // is that result, so nothing this run recorded downstream of it survives
      // — and, exactly as in `withEffect`, a Final-only replacement leaves the
      // candidate-bound gates alone rather than clearing what it just restored.
      const adoptionReplaced = replacesIdentity(run, changes);
      return {
        run: bumpRun(owner, projectId, run, adoptionReplaced
          ? { ...changes, ...invalidateDownstream(run, pending.step, changes.steps, { clearGates: adoptionReplaced !== 'final' }) }
          : changes),
        halted: false,
      };
    }
    // EFFECT_ABSENT: the record positively shows the effect never landed. That
    // is an answer to the reconciliation too, so a run that was halted asking
    // for one stops asking: the step simply runs.
    return {
      run: bumpRun(owner, projectId, run, {
        ...clearedReconciliationState(run),
        pending_step: null,
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
      // Settling the terminal report is the end of the workflow, not a step on
      // the way to more of it. Falling through here carried a run past its own
      // completed audit identity into different work.
      if (run.state === RUN_STATE.COMPLETED) return { run, halted: true };
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
  /**
   * This run's terminal report, if one exists — in the record OR in the project.
   *
   * A run report names the run that produced it, so a report naming this run is
   * this run's terminal output whether or not its receipt was ever stored. That
   * second case is what a crash between the report effect and its receipt
   * leaves behind: the workflow finished, and only the bookkeeping did not.
   */
  const terminalReportOf = (owner, record, run) => run.report_artifact_id
    ?? record.artifacts.find(entry => entry.type === RUN_REPORT_ARTIFACT_TYPE
      && operations.artifactRunId(owner, entry.artifact_id) === run.run_id)?.artifact_id
    ?? null;

  /** Whether a run has produced its terminal report and is therefore closed. */
  const auditClosed = (owner, record, run) => run.state === RUN_STATE.COMPLETED || terminalReportOf(owner, record, run) !== null;

  /**
   * The fields of this request that ask the run to do or change something.
   *
   * Settling an interrupted step is recovery of the run's OWN identity rather
   * than new work, so the field that settles the step actually pending is not
   * counted — and only that one. `adopt_candidate_id` against a pending
   * artifact step does not settle anything: it moves the run onto another
   * candidate, which is the reopening this guard exists to refuse.
   */
  const workflowInputsIn = (run, normalized) => {
    const pendingKind = effectivePendingExpectation(run)?.kind ?? null;
    const exempt = new Set(NON_WORKFLOW_INPUT_KEYS);
    if (pendingKind === 'candidate') exempt.add('adopt_candidate_id');
    if (pendingKind === 'artifact') exempt.add('adopt_artifact_id');
    if (run.pending_step) exempt.add('reconcile');
    return (normalized.provided ?? []).filter(key => !exempt.has(key));
  };

  /**
   * An audit-closed run is a record, not a workspace.
   *
   * Its report names the exact candidate and the exact Final it ended on, and a
   * reviewer may already have cited it. So it accepts NO new workflow input —
   * not a decision set, not finalize options, not `reconcile`, and not
   * `adopt_candidate_id` or `adopt_artifact_id`, which would rebuild it around
   * a different candidate or a different Final. Stating the exception
   * (`NON_WORKFLOW_INPUT_KEYS`) rather than listing the material fields is the
   * point: a list of material fields is a list that can be missed, and
   * `finalize` was missed from one, which reopened a completed run into a
   * second Final while it kept the report naming the first.
   *
   * A run whose report exists only in the project — the crash between the report
   * effect and its receipt — is closed too. Its recovery is a bare resume, which
   * settles the audit identity and nothing else; a resume that also carries new
   * work is refused rather than silently doing one and not the other.
   *
   * An idempotency replay is decided BEFORE this guard, so a genuine retry of
   * the request that completed the run is unaffected.
   */
  const refuseWorkOnAuditClosedRun = (owner, record, run, normalized) => {
    if (!auditClosed(owner, record, run)) return;
    const asked = workflowInputsIn(run, normalized);
    if (!asked.length) return;
    const report = terminalReportOf(owner, record, run);
    fail(ERROR_CODES.RUN_CONFLICT, 'This run has produced its run report, which names the candidate and the Final it ended on. It is an audit record rather than a workspace, so it takes no further workflow input. Start a new run for this work.', {
      run_id: run.run_id,
      run_state: run.state,
      reason: 'COMPLETED_RUN_IS_AUDIT_CLOSED',
      refused_fields: asked,
      candidate_id: run.candidate_id,
      final_artifact_id: run.final_artifact_id ?? null,
      report_artifact_id: report,
      available_operations: ['getRun', 'getArtifact', 'startRun'],
    });
  };

  /** Every step that runs after this one. */
  const downstreamOf = step => RUN_STEP_ORDER.slice(RUN_STEP_ORDER.indexOf(step) + 1);

  /**
   * The workflow invariant: nothing a run holds may outlive the identity it names.
   *
   * When a step produces a new baseline or a new candidate, every result this
   * run recorded downstream of it was computed against the identity that has
   * just been superseded — the review verdict, the emitted Final, the run
   * report that names both, and the gate and readiness snapshots. They are
   * dropped together, so the steps that produced them run again against the new
   * identity. Partial invalidation is the failure this prevents: a run that
   * kept its report while its candidate moved ended `completed` with a report
   * naming a different candidate and a different Final than the run itself.
   *
   * Applied from the effect's own result rather than per step, so a step that
   * mints a new identity cannot forget to declare it.
   */
  const invalidateDownstream = (run, step, steps, { clearGates = true } = {}) => {
    const later = new Set(downstreamOf(step));
    return {
      steps: steps.filter(entry => !later.has(entry.step)),
      ...(clearGates ? { gates: null, readiness_blockers: [] } : {}),
      ...(later.has(RUN_STEP.FINALIZE) ? { final_artifact_id: null } : {}),
      ...(later.has(RUN_STEP.REPORT) ? { report_artifact_id: null } : {}),
    };
  };

  /**
   * Which identity an effect's changes replace, if any.
   *
   * The run report names BOTH the candidate and the Final, so a replaced Final
   * invalidates it exactly as a replaced candidate does — `rerun(REPORT)` asks
   * only whether the run holds a report, and that predicate is correct only
   * because this clears it. The gates and the readiness snapshot are
   * candidate-bound, so a Final-only replacement leaves them alone.
   */
  const replacesIdentity = (run, changes = {}) => {
    if (changes.baseline_id !== undefined && changes.baseline_id !== run.baseline_id) return 'baseline';
    if (changes.candidate_id !== undefined && changes.candidate_id !== run.candidate_id) return 'candidate';
    if (changes.final_artifact_id !== undefined && changes.final_artifact_id !== run.final_artifact_id) return 'final';
    return null;
  };

  function resumeChanges(owner, record, run, normalized) {
    refuseWorkOnAuditClosedRun(owner, record, run, normalized);
    const inputs = { ...run.inputs };
    // The selected assets and the bytes they hold are ONE identity. Recording
    // new ids against the old digests would leave a run whose stated selection
    // and whose intake-satisfaction evidence describe different sources — and
    // intake satisfaction reads the digests, so a source added here would be
    // silently left out of the Source-Faithful Baseline.
    if (normalized.asset_ids !== null) {
      const selection = assetSelection(record, normalized.asset_ids);
      inputs.asset_ids = normalized.asset_ids;
      inputs.asset_digests = selection.digests;
    }
    if (normalized.meter_text) inputs.meter_text_sha256 = sha256Of(encoder.encode(normalized.meter_text));
    if (normalized.decisions !== null) inputs.decision_set_fingerprint = decisionStepFingerprint(normalized);
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
      // The SAME expectation the automatic path settles against, so the remedy
      // an ambiguous state advertises is one this path can actually execute.
      const expectation = effectivePendingExpectation(run);
      if (expectation?.kind !== 'artifact') {
        fail(ERROR_CODES.INVALID_REQUEST, 'adopt_artifact_id settles an interrupted artifact step, and this run has none pending.', {
          run_id: run.run_id, pending_step: pending?.step ?? null, pending_expectation_kind: expectation?.kind ?? null,
        });
      }
      const entry = record.artifacts.find(artifact => artifact.artifact_id === normalized.adopt_artifact_id);
      if (!entry) fail(ERROR_CODES.ARTIFACT_NOT_FOUND, 'Unknown artifact', { artifact_id: normalized.adopt_artifact_id, project_id: record.project_id });
      if (entry.type !== expectation.artifact_type) {
        fail(ERROR_CODES.INVALID_REQUEST, 'The artifact to adopt is not of the type this interrupted step produces.', {
          artifact_id: entry.artifact_id, artifact_type: entry.type, expected_artifact_type: expectation.artifact_type,
        });
      }
      // A null candidate is the wildcard `artifactsMatching` reads, not a
      // demand that the artifact have no candidate.
      if (expectation.candidate_id !== null && expectation.candidate_id !== undefined
        && entry.candidate_id !== expectation.candidate_id) {
        fail(ERROR_CODES.INVALID_REQUEST, 'The artifact to adopt was produced for a different candidate than this interrupted step was about.', {
          artifact_id: entry.artifact_id, artifact_candidate_id: entry.candidate_id, expected_candidate_id: expectation.candidate_id,
        });
      }
      // The same effect identity the automatic reconciliation uses, in the same
      // order, so naming an artifact can never settle a step that finding it
      // could not. Naming settles WHICH of the step's possible outputs it
      // produced; it does not widen what may count as one.
      if (expectation.expected_run_id) {
        // Exact: a run report's body names the run that produced it.
        const named = operations.artifactRunId(owner, entry.artifact_id);
        if (named !== expectation.expected_run_id) {
          fail(ERROR_CODES.INVALID_REQUEST, 'The artifact to adopt names a different run, so it is another run\'s report and not this run\'s output.', {
            artifact_id: entry.artifact_id, artifact_run_id: named, expected_run_id: expectation.expected_run_id,
          });
        }
      } else {
        // Novelty: a Final's body names no run, so the marker's before-set is
        // the evidence, and the SAME evidence the automatic path uses. Naming
        // one never concludes more: an artifact that was already there when the
        // marker was written cannot be what this step produced, and an artifact
        // whose novelty the stored before-set cannot establish is refused
        // rather than accepted on the caller's word.
        const novel = namedRecordIsThisEffect(expectation, 'known_artifact_ids', artifactsMatching(record, expectation), entry.artifact_id,
          artifactAttempt(record, expectation));
        if (!novel.proven) {
          fail(ERROR_CODES.INVALID_REQUEST, novel.reason === 'RECORD_PREDATES_THE_MARKER'
            ? 'The artifact to adopt already existed when this step was marked pending, so it cannot be what this step produced.'
            : novel.reason === 'RECORD_IS_ANOTHER_ATTEMPT'
              ? 'The artifact to adopt records the attempt that produced it, and it is not this step\'s attempt, so it is another finalize\'s Final. A Final is graded against the candidate\'s review state at the moment it was emitted, so adopting it would report gates this run never established.'
              : novel.reason === 'EFFECT_ATTEMPT_NOT_RECORDED'
                ? 'The artifact to adopt records no attempt, so which finalize produced it cannot be established -- by this service or by a reviewer reading the same record. Naming it would write a belief down as a settled effect, so it is refused.'
                : 'Whether this artifact postdates the pending step cannot be established from what the marker recorded, so it is not adopted on request either.', {
            artifact_id: entry.artifact_id, step: pending.step, marked_at: pending.at, reason: novel.reason,
            expected_effect_attempt_id: expectation.effect_attempt_id ?? null,
            artifact_effect_attempt_id: recordedAttempt(entry) ?? null,
            known_artifact_ids: expectation.known_artifact_ids,
            known_artifact_ids_complete: expectation.known_artifact_ids_complete ?? null,
          });
        }
      }
      // The same transition the automatic path applies, so a named Final
      // restores the same audit facts a recovered one does. Only the recorded
      // reason differs: how this run came by the result.
      const adopted = adoptedArtifactChanges(owner, record, run, {
        step: pending.step,
        expectation,
        artifactId: entry.artifact_id,
        inputFingerprint: pending.input_fingerprint,
        reason: 'EFFECT_NAMED_BY_REVIEWER',
      });
      if (adopted === null) {
        fail(ERROR_CODES.RUN_RECONCILIATION_REQUIRED, 'This Final\'s stored body cannot be read, so adopting it would record a Final with none of the facts it is supposed to carry. It is not adopted, and the emitter is not run again.', {
          artifact_id: entry.artifact_id, step: pending.step, reason: 'FINAL_ARTIFACT_BODY_UNREADABLE',
        });
      }
      const replaced = replacesIdentity(run, adopted);
      return {
        ...changes,
        // Naming the record this step produced answers the reconciliation, so
        // the halt, the blocker and the request that asked for it are dropped
        // before the adoption's own state is applied over them.
        ...clearedReconciliationState(run),
        ...adopted,
        ...(replaced ? invalidateDownstream(run, pending.step, adopted.steps, { clearGates: replaced !== 'final' }) : {}),
      };
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
      // answer this run recorded about the previous one is re-asked, through
      // the same invariant an effect that mints one applies.
      let steps = invalidateDownstream(run, RUN_STEP.APPLY_DECISIONS, run.steps ?? []).steps;
      // Naming a candidate is also how a caller settles an interrupted step
      // whose effect could not be told apart from another one. It is an
      // explicit statement, checked against the baseline and the lineage above
      // before it is accepted, and it is recorded as the reviewer's answer
      // rather than as something the run established for itself.
      if (run.pending_step?.expectation?.kind === 'candidate') {
        // Settling an interrupted effect and adopting a candidate produced
        // outside the run are two different statements, and only the first one
        // may write a receipt saying the effect happened. A candidate that was
        // already there when the marker was written cannot be this step's
        // output, so naming it is refused rather than recorded as the effect.
        const novel = namedRecordIsThisEffect(run.pending_step.expectation, 'known_candidate_ids', candidatesMatching(record, run.pending_step.expectation), adopted.candidate_id,
          candidateAttempt(record, run.pending_step.expectation));
        if (!novel.proven) {
          fail(ERROR_CODES.INVALID_REQUEST, novel.reason === 'RECORD_PREDATES_THE_MARKER'
            ? 'The candidate to adopt already existed when this step was marked pending, so it cannot be what this step produced. Resume without adopt_candidate_id to let the step run, or name the candidate this step actually produced.'
            : novel.reason === 'RECORD_IS_ANOTHER_ATTEMPT'
              ? 'The candidate to adopt records the attempt that produced it, and it is not this step\'s attempt, so it is another application\'s candidate and not this step\'s output. Resume without adopt_candidate_id to let the step run.'
              : novel.reason === 'EFFECT_ATTEMPT_NOT_RECORDED'
                ? 'The candidate to adopt records no attempt, so which application produced it cannot be established -- by this service or by a reviewer reading the same record. Naming it would write a belief down as a settled effect, so it is refused.'
                : 'Whether this candidate postdates the pending step cannot be established from what the marker recorded, so it is not adopted on request either.', {
            candidate_id: adopted.candidate_id, step: run.pending_step.step, marked_at: run.pending_step.at, reason: novel.reason,
            expected_effect_attempt_id: run.pending_step.expectation.effect_attempt_id ?? null,
            candidate_effect_attempt_id: recordedAttempt(adopted) ?? null,
            known_candidate_ids: run.pending_step.expectation.known_candidate_ids,
            known_candidate_ids_complete: run.pending_step.expectation.known_candidate_ids_complete ?? null,
          });
        }
        steps = [...steps.filter(entry => entry.step !== run.pending_step.step), stepReceipt({
          step: run.pending_step.step,
          status: RUN_STEP_STATUS.SATISFIED,
          inputFingerprint: run.pending_step.input_fingerprint ?? null,
          resultReference: adopted.candidate_id,
          detail: { reconciled: true, reason: 'EFFECT_NAMED_BY_REVIEWER', expectation: run.pending_step.expectation },
        })];
        Object.assign(changes, clearedReconciliationState(run));
        changes.pending_step = null;
      }
      changes.steps = steps;
      changes.gates = null;
      changes.readiness_blockers = [];
      changes.final_artifact_id = null;
      changes.report_artifact_id = null;
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
      // A read-only plan writes nothing, so it binds no idempotency key, reads
      // no run revision and adopts nothing. Those fields are simply not in its
      // accepted set, rather than accepted and then refused one at a time.
      const normalized = normalizeRunInput(input, { label: 'plan input', allowed: PLAN_INPUT_KEYS });
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
      let intakeReplacesBaseline = false;
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
      // The selection a start would snapshot, compared to the baseline's own —
      // for the named asset ids AND for the omitted case, where the contract
      // says "every symbolic asset in the project now". Treating an omitted
      // list as an automatic match would answer "satisfied" for a project that
      // has gained a source since its baseline, while the start it describes
      // re-ingests. `selection` has already resolved the omitted case.
      const assetsMatchBaseline = Boolean(record.baseline)
        && sameSelection(record.baseline.asset_ids, selection.digests.map(entry => entry.asset_id));

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
        intakeReplacesBaseline = true;
        add(RUN_STEP.INTAKE, RUN_STEP_STATUS.PLANNED, {
          will_select_asset_ids: selection.digests.map(entry => entry.asset_id),
          ...(plannedBinding.state === METER_BINDING.REBUILD
            ? { rebuild_reason: 'The stored baseline was ingested against a different meter map than this run states, and an MML source is parsed against its meter map.' }
            : {}),
          ...(current ? { invalidates_candidate_id: current.candidate_id } : {}),
        });
      }

      // A candidate descends from the baseline it was derived from. When this
      // plan's intake replaces that baseline, `intake.run` clears the
      // candidates bound to it, so the named candidate will not exist by the
      // time apply_decisions is reached. It is still echoed as what the caller
      // asked for — but it is not a downstream result this plan may treat as
      // satisfied, because the start this plan describes will re-derive one.
      const invalidatedCandidate = intakeReplacesBaseline ? current : null;
      const usableCandidate = invalidatedCandidate ? null : current;

      if (usableCandidate && !normalized.decisions?.length) {
        add(RUN_STEP.SUGGEST, RUN_STEP_STATUS.SKIPPED, { reason: 'A candidate is already available, so no new suggestion is needed to reach review. A suggestion would be derived only to support new decisions.' });
        add(RUN_STEP.APPLY_DECISIONS, RUN_STEP_STATUS.SATISFIED, { existing: { candidate_id: usableCandidate.candidate_id, stage: usableCandidate.stage ?? 'G11D_DECISION_APPLICATION' } });
      } else {
        const invalidated = invalidatedCandidate
          ? {
            invalidated_candidate_id: invalidatedCandidate.candidate_id,
            invalidated_reason: 'This plan re-ingests the sources, which replaces the Source-Faithful Baseline and clears the candidates derived from it. The named candidate will not exist when this step is reached, so it is not a satisfied result.',
          }
          : {};
        add(RUN_STEP.SUGGEST, record.baseline || intakeReplacesBaseline ? RUN_STEP_STATUS.PLANNED : RUN_STEP_STATUS.AWAITING_INPUT, {
          needs: record.baseline || intakeReplacesBaseline ? [] : ['intake must produce a Source-Faithful Baseline first'],
          ...invalidated,
        });
        if (!normalized.decisions?.length) {
          add(RUN_STEP.APPLY_DECISIONS, RUN_STEP_STATUS.AWAITING_INPUT, { needs: ['an explicitly accepted arrangement decision set'], ...invalidated });
          requests.push(decisionsRequiredRequest({ baseline_id: record.baseline?.baseline_id ?? null, steps: [] }));
        } else {
          add(RUN_STEP.APPLY_DECISIONS, RUN_STEP_STATUS.PLANNED, { decision_count: normalized.decisions.length, ...invalidated });
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
          // Echoed as the caller's requested input either way, and flagged when
          // this plan's own intake would remove it.
          target_candidate_invalidated_by_intake: Boolean(invalidatedCandidate),
          candidate_selection_notice: 'target_candidate_id is echoed only when the caller named it. A run never adopts a candidate for being the newest, so a project holding candidates does not make apply_decisions satisfied. A candidate this plan\'s own intake would replace is echoed with target_candidate_invalidated_by_intake and is not reported as a satisfied downstream result.',
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
      // A run that does not exist yet has no revision to expect and no
      // interrupted step to settle, so neither field is in its accepted set.
      const normalized = normalizeRunInput(input, { label: 'run input', allowed: START_INPUT_KEYS });
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
      const normalized = normalizeRunInput(input, { label: 'resume input', allowed: RESUME_INPUT_KEYS });
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
        // A run that is closed and is not being asked for anything is returned
        // as it stands. Reopening it to `running` and completing it again
        // would mint revisions that record no work and no decision.
        if (auditClosed(owner, record, run) && !workflowInputsIn(run, normalized).length && !run.pending_step) {
          // An idempotency key makes a retry safe by binding it to the work a
          // request performed. There is no work here to bind one to, and a key
          // that looks accepted but is bound to nothing would break the one
          // guarantee it exists for: the same key with a different payload must
          // be refused, and it cannot be if the key was never recorded. An
          // EXISTING receipt for this key is replayed above, before this.
          if (normalized.idempotency_key !== null) {
            fail(ERROR_CODES.RUN_CONFLICT, 'This run has produced its run report and this request asks for no work, so there is nothing for an idempotency key to bind to. Retrying it is already safe: resume without the key, or use the key on the request that does the work — in a new run.', {
              run_id: run.run_id,
              run_state: run.state,
              reason: 'NO_WORK_TO_BIND_AN_IDEMPOTENCY_KEY',
              idempotency_key: normalized.idempotency_key,
              bound_keys: (run.idempotency?.receipts ?? []).map(entry => entry.key),
              available_operations: ['getRun', 'getArtifact', 'startRun'],
            });
          }
          return { run, replayed: false, settled: true };
        }
        return { run: bumpRun(owner, projectId, run, resumeChanges(owner, record, run, normalized)), replayed: false };
      });

      if (prepared.settled) {
        return Object.freeze({
          run: runView(prepared.run),
          replayed: false,
          advanced: false,
          notice: 'This run has produced its run report and was asked for nothing further, so no step ran, no revision was taken and no artifact was produced. It is returned as it stands.',
        });
      }
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
