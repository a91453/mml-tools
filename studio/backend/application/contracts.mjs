// Studio Application Interface — stable vocabulary.
//
// Status: IMPLEMENTATION NOTES. This file names the identities, kinds, states
// and error codes the Application Service exposes to every transport. It
// implements and exposes existing Published Canonical-aware Studio
// capabilities; it does not define or modify Canonical rules, and no constant
// here is a musical policy.
//
// Two vocabularies deliberately stay separate and are never merged:
//
//   operation status   Did the call do what it was asked to do? `succeeded`
//                      means the orchestration ran, nothing more.
//   canonical gates    Does the song satisfy a Canonical acceptance gate? Owned
//                      by the existing backend modules, reported per gate.
//
// Collapsing them into `{ success: true }` is exactly the failure this layer
// exists to rule out (ACCEPTANCE_CRITERIA.md keeps the gates separate), so the
// two are carried in different fields of every result and never reconciled.

const freeze = Object.freeze;

// ─── identities ─────────────────────────────────────────────────────────────
//
// Durable identities an agent may store and hand back. A filesystem path, a
// temporary filename, an upload filename and a browser URL are none of these:
// they are metadata at best, and a caller that supplies one where an identity
// is expected is rejected rather than interpreted.
//
// Two identity families meet here and are not interchangeable:
//
//   opaque      `prj_`, `ast_`, `job_` — server-generated random ids. Random,
//               not content-addressed, so that possessing a digest of somebody
//               else's input does not let a caller name their record.
//   derived     `art_`, and the baseline/candidate ids below — content
//               addressed, because the thing they name IS its content. A
//               candidate id is the existing G11-D revision id verbatim; this
//               layer does not mint a second identity for the same object.
export const ID_PREFIX = freeze({
  project: 'prj_',
  asset: 'ast_',
  job: 'job_',
  run: 'run_',
  proposal: 'pro_',
  artifact: 'art_',
  // One attempt at one mutating effect. Minted by the run service immediately
  // before the effect and written both on the pending marker and on the record
  // the effect produced, so a recovered run can say "this record is what THAT
  // attempt produced" instead of "this record looks like what such an attempt
  // would produce". Internal provenance: see INTERNAL_PROVENANCE_KEYS.
  effectAttempt: 'eff_',
});

/**
 * The fields no caller may supply, on any operation, through the public
 * Application Service.
 *
 * They are the run's own record of which attempt at which step produced a
 * stored record. A caller who could set them could make an unrelated record
 * claim to be an interrupted step's effect, which is exactly the thing
 * reconciliation refuses to guess at. The public surface strips them; the
 * run-internal facade is the only path that supplies them.
 */
export const INTERNAL_PROVENANCE_KEYS = freeze(['inputFingerprint', 'effectAttemptId']);

/**
 * One operation input, rebuilt from the fields the caller actually stated.
 *
 * Deleting the internal keys from a copy is not enough, and neither is
 * checking whether the caller set them as own properties: every service reads
 * its input by ordinary property access, which walks the prototype chain. A
 * caller who hands over `Object.create({ effectAttemptId })` states the field
 * nowhere `Object.hasOwn` can see it and supplies it everywhere the service
 * looks -- which is the whole forge this boundary exists to stop.
 *
 * So the input is REBUILT: own enumerable fields only, onto a fresh object
 * literal, with the internal keys left out. Whatever prototype the caller
 * attached does not come with it, and no inherited field of any name reaches a
 * service. A public request is what the caller stated, not what it arranged to
 * be found.
 *
 * Shallow on purpose. The internal keys are top-level fields of an operation
 * input, and every nested structure is validated by the service that owns it
 * against its own closed key set -- read from own keys, exactly as here.
 */
export const withoutInternalProvenance = input => (input === null || typeof input !== 'object' || Array.isArray(input)
  ? input
  : statedFields(input, { omit: INTERNAL_PROVENANCE_KEYS }));

/**
 * The fields a caller actually stated on one request object.
 *
 * Own enumerable fields, copied onto a fresh object literal. Whatever
 * prototype the caller attached is left behind, so a later `value.field` reads
 * only what a `Object.keys` guard could also see. Every boundary that both
 * VALIDATES a request by its keys and READS it by name needs this, because JS
 * disagrees with itself about what "has a field" means: `Object.keys` says own,
 * property access says own-or-inherited. A caller who knows that can state a
 * field where the check cannot see it and have it read where it counts.
 */
export const statedFields = (value, { omit = [] } = {}) => {
  const stated = {};
  for (const key of Object.keys(value)) {
    if (omit.includes(key)) continue;
    stated[key] = value[key];
  }
  return stated;
};

const OPAQUE_ID = /^(prj|ast|job|run|pro)_[0-9a-f]{32}$/;
const ARTIFACT_ID = /^art_[0-9a-f]{64}$/;

// Owned by `arrangement/decision-application.mjs`. Restated here as a
// recognizer only: this layer reads these ids, it never constructs them.
const BASELINE_ID = /^bas:[0-9a-f]{64}$/;
const CANDIDATE_ID = /^g11d:rev:[0-9a-f]{64}$/;

export const IDENTITY_MODEL = freeze({
  project_id: 'prj_<32 hex>, server-generated',
  asset_id: 'ast_<32 hex>, server-generated; never derived from the upload filename',
  job_id: 'job_<32 hex>, server-generated',
  run_id: 'run_<32 hex>, server-generated; the identity of one workflow instance, never of a baseline, a candidate or an artifact',
  proposal_id: 'pro_<32 hex>, server-generated; the identity of one external agent\'s statement about one open review request, never of a decision, an acceptance, an evidence record or a gate result',
  artifact_id: 'art_<sha256 of the artifact body>',
  baseline_id: 'bas:<baselineIdentityOf(project).contentDigest>, computed by the existing backend',
  candidate_id: 'g11d:rev:<sha256>, the existing G11-D revision id, used verbatim',
  notice: 'Filesystem paths, temporary filenames, upload filenames and browser URLs are never identities. Upload filenames are metadata; stored filenames are generated from the asset id.',
});

export const isProjectId = value => typeof value === 'string' && OPAQUE_ID.test(value) && value.startsWith(ID_PREFIX.project);
export const isAssetId = value => typeof value === 'string' && OPAQUE_ID.test(value) && value.startsWith(ID_PREFIX.asset);
export const isJobId = value => typeof value === 'string' && OPAQUE_ID.test(value) && value.startsWith(ID_PREFIX.job);
export const isRunId = value => typeof value === 'string' && OPAQUE_ID.test(value) && value.startsWith(ID_PREFIX.run);
export const isProposalId = value => typeof value === 'string' && OPAQUE_ID.test(value) && value.startsWith(ID_PREFIX.proposal);
export const isArtifactId = value => typeof value === 'string' && ARTIFACT_ID.test(value);
export const isBaselineId = value => typeof value === 'string' && BASELINE_ID.test(value);
export const isCandidateId = value => typeof value === 'string' && CANDIDATE_ID.test(value);

// ─── asset kinds ────────────────────────────────────────────────────────────
//
// Coordinated with the existing Canonical source vocabulary rather than
// replacing it: `canonical/index.mjs` owns `SOURCE_KINDS` and `SOURCE_AUTHORITIES`,
// and the mapping below is the only place an asset kind becomes an intake
// decision. An asset kind that carries no symbolic content maps to `null` and
// can never reach source intake.
export const ASSET_KINDS = freeze({
  ORIGINAL_AUDIO: 'original_audio',
  OFFICIAL_MIDI: 'official_midi',
  THIRD_PARTY_MIDI: 'third_party_midi',
  OFFICIAL_MUSICXML: 'official_musicxml',
  THIRD_PARTY_MUSICXML: 'third_party_musicxml',
  CURRENT_MML: 'current_mml',
  HISTORICAL_MML: 'historical_mml',
  CANONICAL_PROJECT: 'canonical_project',
  AUDIO_ALIGNMENT_REPORT: 'audio_alignment_report',
  FINAL_MML: 'final_mml',
  REPORT: 'report',
});

export const ASSET_KIND_NAMES = freeze(Object.values(ASSET_KINDS));
export const isAssetKind = value => ASSET_KIND_NAMES.includes(value);

/**
 * How an asset kind reaches the existing intake adapters.
 *
 * `adapter` names the backend module that owns the format. `canonicalKind` is
 * the existing `canonical/index.mjs` `SOURCE_KINDS` member the adapter is
 * called with, so this interface's transport vocabulary never becomes a second
 * Canonical source vocabulary: the hyphenated Canonical names stay the schema,
 * and the underscored names here are only the wire spelling that maps onto
 * them. `authority` is the existing Canonical source authority, so an
 * "official" upload is not silently downgraded and a third-party upload is
 * never promoted. `intake: false` means the kind is evidence or output, not a
 * symbolic source, and intake refuses it rather than guessing a parser.
 */
export const ASSET_KIND_INTAKE = freeze({
  [ASSET_KINDS.ORIGINAL_AUDIO]: freeze({ intake: false, adapter: null, canonicalKind: 'original-audio', authority: 'primary-audio', mediaHint: 'audio' }),
  [ASSET_KINDS.OFFICIAL_MIDI]: freeze({ intake: true, adapter: 'midi', canonicalKind: 'official-midi', authority: 'primary-symbolic', mediaHint: 'audio/midi' }),
  [ASSET_KINDS.THIRD_PARTY_MIDI]: freeze({ intake: true, adapter: 'midi', canonicalKind: 'third-party-midi', authority: 'supporting', mediaHint: 'audio/midi' }),
  [ASSET_KINDS.OFFICIAL_MUSICXML]: freeze({ intake: true, adapter: 'musicxml', canonicalKind: 'official-musicxml', authority: 'primary-symbolic', mediaHint: 'application/xml' }),
  [ASSET_KINDS.THIRD_PARTY_MUSICXML]: freeze({ intake: true, adapter: 'musicxml', canonicalKind: 'third-party-musicxml', authority: 'supporting', mediaHint: 'application/xml' }),
  [ASSET_KINDS.CURRENT_MML]: freeze({ intake: true, adapter: 'mml', canonicalKind: 'current-mml', authority: 'derived', mediaHint: 'text/plain' }),
  [ASSET_KINDS.HISTORICAL_MML]: freeze({ intake: true, adapter: 'mml', canonicalKind: 'historical-mml', authority: 'derived', mediaHint: 'text/plain' }),
  [ASSET_KINDS.CANONICAL_PROJECT]: freeze({ intake: true, adapter: 'canonical', canonicalKind: null, authority: null, mediaHint: 'application/json' }),
  [ASSET_KINDS.AUDIO_ALIGNMENT_REPORT]: freeze({ intake: false, adapter: null, canonicalKind: null, authority: null, mediaHint: 'application/json' }),
  [ASSET_KINDS.FINAL_MML]: freeze({ intake: false, adapter: null, canonicalKind: null, authority: null, mediaHint: 'text/plain' }),
  [ASSET_KINDS.REPORT]: freeze({ intake: false, adapter: null, canonicalKind: null, authority: null, mediaHint: 'application/json' }),
});

// ─── jobs ───────────────────────────────────────────────────────────────────

export const JOB_STATUS = freeze({
  QUEUED: 'queued',
  RUNNING: 'running',
  SUCCEEDED: 'succeeded',
  FAILED: 'failed',
  CANCELLED: 'cancelled',
});

export const JOB_TYPES = freeze({
  AUDIO_ALIGNMENT: 'audio_alignment',
  INTAKE: 'intake',
  ARRANGEMENT_SUGGEST: 'arrangement_suggest',
  FINALIZE: 'finalize',
});

// ─── gates ──────────────────────────────────────────────────────────────────
//
// The Canonical gate axes this interface reports. Each one is answered by the
// module that owns it; this layer transcribes those answers and adds none.
// `in_game` is never written by an emitter, a parser, a transport or a model:
// only a recorded human/controlled-client acceptance can move it, and v1
// records none, so it is `PENDING` throughout.
export const GATE_NAMES = freeze([
  'technical',
  'source',
  'audio',
  'player_readback',
  'mobile_adaptation',
  'regression',
  'in_game',
]);

export const GATE_STATUS = freeze({
  PASS: 'PASS',
  FAIL: 'FAIL',
  PENDING: 'PENDING',
  UNSUPPORTED: 'UNSUPPORTED',
  NOT_RUN: 'NOT_RUN',
  NOT_APPLICABLE: 'N/A',
});

export const OPERATION_STATUS = freeze({
  SUCCEEDED: 'succeeded',
  BLOCKED: 'blocked',
  FAILED: 'failed',
});

export const GATE_NOTICE = 'Gate axes are independent. A technical PASS certifies serialization and readback under this implementation only: it never establishes source completeness, audio alignment, player readback, Mobile adaptation, regression review or in-game acceptance. No operation result, emitter result, parser result, transport result or model call can set in_game.';

// ─── errors ─────────────────────────────────────────────────────────────────
//
// Reused first: `CANONICAL_NOT_LOADED` is the bootstrap's own failure status
// and keeps its exact spelling, and the decision/emit/readiness vocabularies
// stay where they are — a blocked finalize reports the backend's own blockers
// inside `details` rather than being re-coded here.
export const ERROR_CODES = freeze({
  CANONICAL_NOT_LOADED: 'CANONICAL_NOT_LOADED',
  // Distinct from CANONICAL_NOT_LOADED on purpose. The published rules loaded;
  // a Canonical-aware engine module could not be imported (a missing runtime
  // dependency, a partial deployment). Reporting that as a Canonical failure
  // would blame the rules for an environment problem and would make the
  // Canonical failure signal itself untrustworthy.
  ENGINE_UNAVAILABLE: 'ENGINE_UNAVAILABLE',
  PROJECT_NOT_FOUND: 'PROJECT_NOT_FOUND',
  ASSET_NOT_FOUND: 'ASSET_NOT_FOUND',
  INVALID_ASSET_KIND: 'INVALID_ASSET_KIND',
  UNSUPPORTED_SOURCE: 'UNSUPPORTED_SOURCE',
  SOURCE_INCOMPLETE: 'SOURCE_INCOMPLETE',
  JOB_NOT_FOUND: 'JOB_NOT_FOUND',
  JOB_FAILED: 'JOB_FAILED',
  RUN_NOT_FOUND: 'RUN_NOT_FOUND',
  // The caller's expected run revision is not the run's current revision, so
  // the run moved under it. Distinct from an idempotency conflict: nothing
  // about the request is malformed, the caller is simply not looking at the
  // state it thought it was.
  RUN_CONFLICT: 'RUN_CONFLICT',
  // One idempotency key, two different request payloads. Refused rather than
  // resolved in favour of either: the first request already bound the key, and
  // overwriting its run would lose whatever the first payload produced.
  IDEMPOTENCY_CONFLICT: 'IDEMPOTENCY_CONFLICT',
  // A step's effect may or may not have been persisted before the process
  // stopped, and no deterministic identity or stored reference settles it. The
  // run reports exactly which step is unconfirmed instead of replaying it.
  RUN_RECONCILIATION_REQUIRED: 'RUN_RECONCILIATION_REQUIRED',
  PROPOSAL_NOT_FOUND: 'PROPOSAL_NOT_FOUND',
  // The proposal moved under the caller, is already resolved, or is being
  // resolved into a state it cannot reach from the one it is in. Distinct from
  // PROPOSAL_REFUSED: nothing about the proposal's content is at fault.
  PROPOSAL_CONFLICT: 'PROPOSAL_CONFLICT',
  // The Agent Review Policy will not let this proposal reach an operation. The
  // verdict and its refusal codes travel in `details`; this code never says
  // which, because a caller has to read the verdict rather than infer it.
  PROPOSAL_REFUSED: 'PROPOSAL_REFUSED',
  CANDIDATE_NOT_FOUND: 'CANDIDATE_NOT_FOUND',
  ARTIFACT_NOT_FOUND: 'ARTIFACT_NOT_FOUND',
  READINESS_BLOCKED: 'READINESS_BLOCKED',
  DECISION_REQUIRED: 'DECISION_REQUIRED',
  FINALIZATION_BLOCKED: 'FINALIZATION_BLOCKED',
  TECHNICAL_TIMING_REPAIR_UNAVAILABLE: 'TECHNICAL_TIMING_REPAIR_UNAVAILABLE',
  COST_BLOCKED: 'COST_BLOCKED',
  INVALID_REQUEST: 'INVALID_REQUEST',
  NOT_AUTHENTICATED: 'NOT_AUTHENTICATED',
  FORBIDDEN: 'FORBIDDEN',
  PAYLOAD_TOO_LARGE: 'PAYLOAD_TOO_LARGE',
  STORAGE_FULL: 'STORAGE_FULL',
});

// Transport-neutral severity. The HTTP adapter maps these to status codes and
// the MCP adapter maps them to tool errors; neither invents a code of its own.
export const ERROR_HTTP_STATUS = freeze({
  [ERROR_CODES.CANONICAL_NOT_LOADED]: 503,
  [ERROR_CODES.ENGINE_UNAVAILABLE]: 503,
  [ERROR_CODES.PROJECT_NOT_FOUND]: 404,
  [ERROR_CODES.ASSET_NOT_FOUND]: 404,
  [ERROR_CODES.INVALID_ASSET_KIND]: 400,
  [ERROR_CODES.UNSUPPORTED_SOURCE]: 422,
  [ERROR_CODES.SOURCE_INCOMPLETE]: 422,
  [ERROR_CODES.JOB_NOT_FOUND]: 404,
  [ERROR_CODES.JOB_FAILED]: 422,
  [ERROR_CODES.RUN_NOT_FOUND]: 404,
  [ERROR_CODES.RUN_CONFLICT]: 409,
  [ERROR_CODES.IDEMPOTENCY_CONFLICT]: 409,
  [ERROR_CODES.RUN_RECONCILIATION_REQUIRED]: 409,
  [ERROR_CODES.PROPOSAL_NOT_FOUND]: 404,
  [ERROR_CODES.PROPOSAL_CONFLICT]: 409,
  [ERROR_CODES.PROPOSAL_REFUSED]: 409,
  [ERROR_CODES.CANDIDATE_NOT_FOUND]: 404,
  [ERROR_CODES.ARTIFACT_NOT_FOUND]: 404,
  [ERROR_CODES.READINESS_BLOCKED]: 409,
  [ERROR_CODES.DECISION_REQUIRED]: 409,
  [ERROR_CODES.FINALIZATION_BLOCKED]: 409,
  [ERROR_CODES.TECHNICAL_TIMING_REPAIR_UNAVAILABLE]: 409,
  [ERROR_CODES.COST_BLOCKED]: 501,
  [ERROR_CODES.INVALID_REQUEST]: 400,
  [ERROR_CODES.NOT_AUTHENTICATED]: 401,
  [ERROR_CODES.FORBIDDEN]: 404,
  [ERROR_CODES.PAYLOAD_TOO_LARGE]: 413,
  [ERROR_CODES.STORAGE_FULL]: 507,
});

// `FORBIDDEN` maps to 404 on purpose. A caller who names a record they do not
// own learns only that it is not theirs to see; distinguishing "exists but
// forbidden" from "does not exist" is an existence oracle over another owner's
// identifiers.

/**
 * A structured Application Service failure.
 *
 * `details` carries the owning module's own vocabulary unchanged (blocker
 * codes, rejection codes, diagnostics). It never restates a backend verdict in
 * new words, because a paraphrased verdict is how an implementation finding
 * turns into an imagined rule.
 */
export class StudioApplicationError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = 'StudioApplicationError';
    this.code = Object.hasOwn(ERROR_HTTP_STATUS, code) ? code : ERROR_CODES.INVALID_REQUEST;
    this.details = freeze(structuredClone(details));
  }

  toJSON() {
    return { error: { code: this.code, message: this.message, details: this.details } };
  }
}

export const fail = (code, message, details = {}) => {
  throw new StudioApplicationError(code, message, details);
};

// ─── bounded input ──────────────────────────────────────────────────────────
//
// Implementation guards, not Canonical limits. They keep one request from
// exhausting the single shared Node process and the existing 500 MB Railway
// volume; none of them changes a musical rule.
export const LIMITS = freeze({
  maxAssetBytes: 64 * 1024 * 1024,
  maxInlineTextBytes: 4 * 1024 * 1024,
  maxJsonBodyBytes: 8 * 1024 * 1024,
  maxAssetsPerProject: 64,
  maxProjectsPerOwner: 256,
  maxDecisionsPerRequest: 500,
  maxEventsPerPage: 500,
  maxTitleLength: 120,
  // One project's stored workflow instances. A run record is small by
  // construction (identities, fingerprints, step receipts and bounded review
  // requests), and the cap keeps a project record bounded whatever a caller does.
  maxRunsPerProject: 32,
  maxRunStepsPerAdvance: 16,
  maxReviewRequestsPerRun: 48,
  // Review requests cite event ids so a reviewer can find the material. The
  // full list stays behind `listBaselineEvents` and the stored reports; the
  // request carries the first page and the true total.
  maxReviewRequestEventIds: 50,
  // What already existed when a step was marked pending, so an interrupted
  // effect can be told from something that was already there. Bounded because
  // it is stored; a set larger than this records itself as incomplete, and an
  // incomplete before-set proves no novelty, so nothing is adopted from it.
  maxEffectBeforeSet: 64,
  // The source-confirmed meter map an MML source is parsed against. One bound,
  // so the HTTP and MCP surfaces accept exactly the same range rather than one
  // rejecting what the other admits.
  maxMeterTextLength: 2048,
  // The optimistic-concurrency precondition a caller may state. Bounded so the
  // two transports declare and enforce the same range.
  maxRunRevision: 1000000,
  // One project's stored AI proposals. A proposal record is small by
  // construction -- identities, bounded citations, bounded rationale and one
  // bounded action -- and the cap keeps a project record bounded whatever an
  // agent does. An agent that has filled it is told so rather than silently
  // dropping its oldest statement.
  maxProposalsPerProject: 64,
  // A rationale is prose for a human reviewer. Bounded so one proposal cannot
  // push a project record past what a transport will serve, and so the two
  // transports admit exactly the same length.
  maxProposalRationaleLength: 4000,
  maxProposalCitations: 50,
  maxProposalConflicts: 32,
  maxProposalNoteLength: 500,
  maxIdempotencyReceiptsPerRun: 32,
  maxIdempotencyKeyLength: 200,
  maxFilenameLength: 255,
  maxStoreBytes: 400 * 1024 * 1024,
});

export const requireString = (value, label, { max = 200, min = 1 } = {}) => {
  if (typeof value !== 'string') fail(ERROR_CODES.INVALID_REQUEST, `${label} must be a string`);
  const trimmed = value.trim();
  if (trimmed.length < min || trimmed.length > max) fail(ERROR_CODES.INVALID_REQUEST, `${label} must be ${min}–${max} characters`);
  return trimmed;
};

export const requirePlainObject = (value, label) => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail(ERROR_CODES.INVALID_REQUEST, `${label} must be an object`);
  return value;
};
