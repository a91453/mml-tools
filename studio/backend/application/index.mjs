// The Studio Application Service.
//
// Status: IMPLEMENTATION NOTES. This interface implements and exposes existing
// Published Canonical-aware Studio capabilities. It does not define or modify
// Canonical rules.
//
// This is the orchestration boundary for server-side and agent callers. The
// HTTP adapter, the MCP adapter and any future server transport go through it:
// they parse their own wire format, name an operation, and render the result.
// None of them holds arrangement logic, Canonical logic, Final logic or a
// second workflow, and no operation is reachable from one transport and not
// another.
//
//     ChatGPT · Claude · Codex · future models · local agents
//                            │
//                    MCP adapter · HTTP adapter
//                            │
//                  Application Service   ← this module
//                            │
//                  existing Studio backend modules
//                            │
//                     Published Canonical
//
// What this is NOT the boundary for, today: the Permanent Studio Web/PWA. That
// is a separate, already-verified deployment plane (Railway project
// `mml-tools-studio-permanent`, service `studio-web-permanent`) which serves a
// pinned, SHA256-verified release artifact from its own durable cache and
// reaches the same Canonical-aware engines directly, in the browser, through
// its own Web Worker. It does not call this service, and nothing here changes
// how it is built, verified, released or served.
//
// Both planes consume the same `studio/backend/**` engines and obey the same
// Published Canonical. Neither deployment defines Canonical. Migrating Studio
// Web onto this service is possible later and is explicitly follow-up work; it
// is not what this module does or claims.
//
// The service calls no model. It holds no OpenAI, Anthropic or Gemini
// credential, imports no provider SDK, and has no provider-specific branch: a
// model is an external caller, never a dependency. Nothing here is aware of
// which model is on the other end of a transport, and nothing may become aware
// of it — a provider-specific workflow would make the same song mean different
// things depending on who asked.
//
// Deployment is likewise not a dependency. Nothing in this layer knows about
// Railway, a container, a public origin, an OAuth grant, a release artifact or
// a verified cache: the caller's owner identity arrives as a string and the
// store's directory arrives as a path, so the same service runs unchanged in a
// test, on a laptop, on the agent backend and in whatever hosts it next.

import { buildCapabilities } from './capabilities.mjs';
import {
  ASSET_KINDS,
  ASSET_KIND_INTAKE,
  ASSET_KIND_NAMES,
  ERROR_CODES,
  ERROR_HTTP_STATUS,
  GATE_NAMES,
  GATE_NOTICE,
  GATE_STATUS,
  IDENTITY_MODEL,
  JOB_STATUS,
  JOB_TYPES,
  LIMITS,
  OPERATION_STATUS,
  StudioApplicationError,
  fail,
  isArtifactId,
  isAssetId,
  isAssetKind,
  isBaselineId,
  isCandidateId,
  isJobId,
  isProjectId,
} from './contracts.mjs';
import { createCanonicalGate } from './provenance.mjs';
import { createStore } from './store.mjs';
import { createProjectService } from './project-service.mjs';
import { createAssetService } from './asset-service.mjs';
import { createJobService } from './job-service.mjs';
import { createIntakeService } from './intake-service.mjs';
import { createArrangementService } from './arrangement-service.mjs';
import { createReviewService } from './review-service.mjs';
import { createFinalService } from './final-service.mjs';
import { createTechnicalService } from './technical-service.mjs';

export const APPLICATION_VERSION = '1.0.0';

// One writer per project at a time.
//
// The service runs in one Node process, but every mutating operation awaits
// the Canonical engines and the stored baseline between reading the project
// record and writing it back. Two overlapping calls on one project — a
// retrying agent, a duplicate request, two clients — would otherwise each
// load the same record, and the second save would drop the first one's entry
// while both answered success. Mutations are therefore serialized per project
// id at this boundary, which is the only place every transport passes through.
// Reads are not serialized; they observe whatever is committed.
function createProjectSerializer() {
  const chains = new Map();
  return async function serialized(key, work) {
    const previous = chains.get(key) ?? Promise.resolve();
    let release;
    const current = new Promise(resolve => { release = resolve; });
    const chain = previous.then(() => current);
    chains.set(key, chain);
    await previous;
    try {
      return await work();
    } finally {
      release();
      if (chains.get(key) === chain) chains.delete(key);
    }
  };
}

/**
 * Build a Studio Application Service.
 *
 * @param {object}   [options]
 * @param {string}   [options.dataDirectory] Where records and blobs are written.
 *   Omitted, the store is in memory and reports `ephemeral`.
 * @param {string}   [options.durability]    `'persistent'` when the operator has
 *   mounted a durable volume at `dataDirectory`. Reported, never assumed.
 * @param {Function} [options.loadEngines]   Test seam for simulating an
 *   unavailable Published Canonical. Production passes nothing.
 * @param {string[]} [options.transports]    Which adapters are wired in front of
 *   this instance, for capability discovery.
 */
export function createStudioApplication({
  dataDirectory = null,
  durability = 'unknown',
  maxStoreBytes = LIMITS.maxStoreBytes,
  loadEngines = undefined,
  serviceVersion = APPLICATION_VERSION,
  transports = [],
} = {}) {
  const canonical = createCanonicalGate(loadEngines ? { load: loadEngines } : {});
  const store = createStore({ directory: dataDirectory, durability, maxBytes: maxStoreBytes });
  const projects = createProjectService({ store });
  const assets = createAssetService({ store, projects });
  const jobs = createJobService({ store, projects });
  const intake = createIntakeService({ canonical, projects, assets, store });
  const arrangement = createArrangementService({ canonical, projects, intake, store });
  const review = createReviewService({ canonical, projects, intake, arrangement, store });
  const final = createFinalService({ canonical, projects, review, store });
  const technical = createTechnicalService({ serviceVersion });
  const serialized = createProjectSerializer();
  const mutate = (projectId, work) => serialized(String(projectId), work);

  // Every significant result carries the Canonical provenance of the process
  // that produced it, with its five identities kept separate. A result that
  // reaches an agent without it cannot be read against the right rules snapshot.
  const envelope = async body => ({ canonical: await canonical.provenance(), ...body });

  return Object.freeze({
    version: serviceVersion,
    canonical,

    /** Factual capability discovery. Answers even when Canonical is unavailable. */
    async capabilities() {
      return buildCapabilities({
        canonical: await canonical.provenance(),
        storage: store.describe(),
        jobs: { backgroundExecution: false, cancellation: false, executionModel: 'synchronous-completion' },
        transports,
      });
    },

    // ── projects ────────────────────────────────────────────────────────────

    async createProject(owner, input = {}) {
      return envelope({ operation: OPERATION_STATUS.SUCCEEDED, project: projects.create(owner, input) });
    },

    async getProject(owner, projectId) {
      return envelope({ operation: OPERATION_STATUS.SUCCEEDED, project: projects.get(owner, projectId) });
    },

    async listProjects(owner) {
      return envelope({ operation: OPERATION_STATUS.SUCCEEDED, projects: projects.list(owner) });
    },

    // ── assets ──────────────────────────────────────────────────────────────

    async uploadAsset(owner, projectId, input) {
      return mutate(projectId, () => envelope({ operation: OPERATION_STATUS.SUCCEEDED, asset: assets.upload(owner, projectId, input) }));
    },

    async listAssets(owner, projectId) {
      return envelope({ operation: OPERATION_STATUS.SUCCEEDED, assets: assets.list(owner, projectId) });
    },

    async getAsset(owner, projectId, assetId) {
      return envelope({ operation: OPERATION_STATUS.SUCCEEDED, asset: assets.metadata(owner, projectId, assetId) });
    },

    /** Raw bytes, for a transport that is serving a download. Never for MCP. */
    readAssetBytes(owner, projectId, assetId) {
      return assets.read(owner, projectId, assetId);
    },

    // ── pipeline ────────────────────────────────────────────────────────────

    /**
     * Build the Source-Faithful Baseline from the project's symbolic assets.
     *
     * Wrapped in a job because decoding a large score is the kind of work a
     * caller should be able to look up rather than hold a request open for.
     */
    async analyzeSources(owner, projectId, options = {}) {
      return mutate(projectId, async () => {
        const { job, result } = await jobs.run(owner, projectId, JOB_TYPES.INTAKE, async () => {
          const { baseline } = await intake.run(owner, projectId, options);
          return { result: baseline, reference: baseline.baseline_id };
        });
        return envelope({ operation: OPERATION_STATUS.SUCCEEDED, job, baseline: result });
      });
    },

    /**
     * The Source-Faithful Baseline's events, with their provenance.
     *
     * A read-only projection of what intake produced: event identity, role,
     * pitch, timing and the source ids the event is traceable to. It exists
     * because the evidence a Lead decision must carry is bound to exactly these
     * source identities, and an agent confined to the transports had no way to
     * read them. Optionally narrowed to one lane of the current suggestion or
     * to named events, and paged so a long piece does not arrive in one answer.
     */
    async listBaselineEvents(owner, projectId, options = {}) {
      return envelope({ operation: OPERATION_STATUS.SUCCEEDED, ...(await arrangement.baselineEvents(owner, projectId, options)) });
    },

    /**
     * Validate and attach an original-audio alignment report to one candidate.
     *
     * The alignment itself is computed by the existing audio worker, outside
     * this process. What happens here is validation and attachment: the report
     * must name this exact candidate, must forbid symbolic mutation, and its
     * confidence and coverage warnings are carried through unchanged.
     */
    async attachAudioAlignment(owner, projectId, input) {
      return mutate(projectId, async () => {
        const { job, result } = await jobs.run(owner, projectId, JOB_TYPES.AUDIO_ALIGNMENT, async () => {
          const attached = await review.attachAudioAlignment(owner, projectId, input);
          return { result: attached, reference: input.candidateId ?? null };
        });
        return envelope({ operation: OPERATION_STATUS.SUCCEEDED, job, ...result });
      });
    },

    async suggestArrangement(owner, projectId, options = {}) {
      return mutate(projectId, async () => envelope({ operation: OPERATION_STATUS.SUCCEEDED, suggestion: await arrangement.suggest(owner, projectId, options) }));
    },

    async applyDecisions(owner, projectId, input) {
      return mutate(projectId, async () => {
        const result = await arrangement.applyDecisions(owner, projectId, input);
        return envelope({
          // The application either applied the whole set or applied nothing. A
          // refused set is a real answer about the decisions, so it is reported
          // with its own codes rather than raised as a transport failure.
          operation: result.applied ? OPERATION_STATUS.SUCCEEDED : OPERATION_STATUS.BLOCKED,
          code: result.applied ? null : ERROR_CODES.DECISION_REQUIRED,
          decisions: result,
        });
      });
    },

    async reviewCandidate(owner, projectId, input) {
      return mutate(projectId, async () => envelope({ operation: OPERATION_STATUS.SUCCEEDED, review: await review.review(owner, projectId, input) }));
    },

    async recordConfirmations(owner, projectId, confirmations) {
      return mutate(projectId, async () => envelope({ operation: OPERATION_STATUS.SUCCEEDED, ...review.record(owner, projectId, confirmations) }));
    },

    /**
     * Candidate → Final MML artifact.
     *
     * Wrapped in a job so the artifact it produced is reachable from the job
     * record as well as from the result.
     */
    async finalize(owner, projectId, input) {
      return mutate(projectId, async () => {
        const { job, result } = await jobs.run(owner, projectId, JOB_TYPES.FINALIZE, async () => {
          const outcome = await final.finalize(owner, projectId, input);
          return { result: outcome, artifactId: outcome.artifact_id, reference: outcome.candidate_id };
        });
        return envelope({ ...result, job });
      });
    },

    // ── jobs and artifacts ──────────────────────────────────────────────────

    async getJob(owner, jobId) {
      return envelope({ operation: OPERATION_STATUS.SUCCEEDED, job: jobs.get(owner, jobId) });
    },

    async listJobs(owner, projectId) {
      return envelope({ operation: OPERATION_STATUS.SUCCEEDED, jobs: jobs.list(owner, projectId) });
    },

    async getArtifact(owner, artifactId) {
      return envelope({ operation: OPERATION_STATUS.SUCCEEDED, artifact: final.find(owner, artifactId) });
    },

    // ── legacy technical validation ─────────────────────────────────────────
    //
    // Deliberately available without Published Canonical: it runs on the legacy
    // core, exactly as the original tools did, so an environment that cannot
    // load the published rules keeps the capability it already had.

    validateTechnicalMml(input) {
      return technical.validate(input);
    },

    technicalOverlapDetails(input) {
      return technical.overlapDetails(input);
    },

    // Exposed for adapters that need to describe or bound a request.
    limits: LIMITS,
    assetKinds: ASSET_KIND_NAMES,
  });
}

export {
  ASSET_KINDS,
  ASSET_KIND_INTAKE,
  ASSET_KIND_NAMES,
  ERROR_CODES,
  ERROR_HTTP_STATUS,
  GATE_NAMES,
  GATE_NOTICE,
  GATE_STATUS,
  IDENTITY_MODEL,
  JOB_STATUS,
  JOB_TYPES,
  LIMITS,
  OPERATION_STATUS,
  StudioApplicationError,
  fail,
  isArtifactId,
  isAssetId,
  isAssetKind,
  isBaselineId,
  isCandidateId,
  isJobId,
  isProjectId,
};
export { buildCapabilities, INTERFACE_VERSION } from './capabilities.mjs';
export { createCanonicalGate, provenanceOf, unloadedProvenance } from './provenance.mjs';
export { PRE_EMISSION_EXEMPT_GATES, FINAL_ARTIFACT_SCHEMA } from './final-service.mjs';
export { CONFIRMATIONS, CONFIRMATION_SCOPE, PLAYER_READBACK_VALUES, STALE_CONFIRMATION, gatesFrom } from './review-service.mjs';
export { PROJECT_RECORD_SCHEMA } from './project-service.mjs';
export { ACCEPTED_MEDIA_TYPES } from './asset-service.mjs';
