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
// second workflow.
//
// Transport coverage is not uniform, and saying so is the point: a blanket
// parity claim here is how `approveCore3SourceChange` came to exist with no
// caller on either transport, leaving a required gate unclearable from the
// Agent plane. The rule that does hold is narrower: every operation a reviewer
// needs in order to move a gate is reachable from MCP, and `tests/
// mcp-studio.test.mjs` asserts that operation-by-operation. The binary plane
// (`uploadAsset`, `readAssetBytes`) is HTTP-only by construction, because no
// tool carries bytes; `listAssets`, `getAsset`, `listJobs`,
// `recordConfirmations` on its own (it is reachable inside
// `studio_candidate_review` and `studio_finalize`) and the four technical
// validation operations are HTTP-only today.
//
// The four run operations — `planRun`, `startRun`, `getRun`, `resumeRun` —
// compose the operations above into one traceable, explicitly resumable
// workflow instance. They add no musical capability: every step is one of the
// calls already listed, and a run stops at the first point where a decision,
// an evidence record or a capability is missing. See `run-service.mjs`.
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
  INTERNAL_PROVENANCE_KEYS,
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
  isProposalId,
  isRunId,
  withoutInternalProvenance,
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
import { createRunService } from './run-service.mjs';
import { createProposalService } from './proposal-service.mjs';

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
 * @param {object}   [options.runHooks]     Test seam for simulating an
 *   interruption inside a run step, in the same spirit as `loadEngines`.
 *   Production passes nothing. See `run-service.mjs` for the three hooks and
 *   the three interruption classes they stand in for.
 */
export function createStudioApplication({
  dataDirectory = null,
  durability = 'unknown',
  maxStoreBytes = LIMITS.maxStoreBytes,
  loadEngines = undefined,
  serviceVersion = APPLICATION_VERSION,
  transports = [],
  runHooks = undefined,
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
  const technical = createTechnicalService({ serviceVersion, canonical });
  const serialized = createProjectSerializer();
  const mutate = (projectId, work) => serialized(String(projectId), work);

  // One implementation per operation, reached two ways.
  //
  /**
   * One operation input as it arrives from OUTSIDE this service.
   *
   * The run records which attempt at which step produced a stored record, and
   * reconciliation adopts an interrupted step's effect on the strength of it.
   * A caller who could set those fields could make any record claim to be an
   * interrupted step's effect -- which is the one thing this whole mechanism
   * exists to refuse. The transports already build their own call shapes from
   * named request fields, so nothing reaches here over HTTP or MCP; this is
   * the boundary itself rather than a property of how the transports happen to
   * be written today, and it holds for a direct in-process caller too.
   *
   * The run does not go through it: `internal` IS the run-only path.
   */
  const publicInput = input => withoutInternalProvenance(input);

  // `internal` holds the body of every operation the run orchestrator composes.
  // The public method below is that body plus the per-project lock and the
  // provenance envelope; the orchestrator calls the body directly and takes the
  // lock itself, once per step. That is not a way around a check: every owner,
  // Canonical, integrity, evidence and acceptance check lives in the service
  // the body calls, so both callers get the identical refusal. It exists
  // because a run holding the project lock cannot call a public method that
  // takes the same lock — one project key, acquired twice, deadlocks.
  const internal = {
    isSymbolicKind: kind => ASSET_KIND_INTAKE[kind]?.intake === true,
    findAsset: (record, assetId) => assets.find(record, assetId),
    fileArtifact: (record, artifact, options) => final.fileArtifact(record, artifact, options),

    /**
     * The run id an artifact's own body names, or null.
     *
     * Only a run report carries one. It exists so that reconciling an
     * interrupted report step can tell this run's report from another run's for
     * the same candidate by identity rather than by timestamp. It reads; it
     * cannot write, and a missing or unreadable artifact answers null rather
     * than failing a reconciliation that is already trying to be careful.
     */
    artifactRunId(owner, artifactId) {
      try { return final.find(owner, artifactId)?.run_id ?? null; }
      catch { return null; }
    },

    /**
     * A stored artifact's body, for reconstructing what an effect recorded.
     *
     * An interrupted effect that persisted its artifact left the facts about
     * it in the artifact: a Final carries its own emit status, its gates and
     * its readiness summary. Reading them back is how an adopted effect ends
     * with the same audit state as one whose receipt arrived — without running
     * the emitter a second time. Read-only, and a missing or unreadable
     * artifact answers null rather than failing a careful reconciliation.
     */
    artifactBody(owner, artifactId) {
      try { return final.find(owner, artifactId) ?? null; }
      catch { return null; }
    },

    /**
     * The jobs that produced a given artifact, by the reference the job itself
     * stored. Never "the newest job": an artifact with no uniquely identifying
     * job is left without one rather than attributed to a guess.
     */
    jobsForArtifact(record, artifactId) {
      return (record.jobs ?? []).filter(entry => entry.result_artifact_id === artifactId).map(entry => entry.job_id);
    },

    /**
     * The Source-Faithful Baseline's events, for resolving a citation.
     *
     * Read-only, and the same projection `listBaselineEvents` serves. The
     * proposal layer uses it to establish that a cited event id is an event
     * this baseline actually holds, which is what makes "fabricated event id"
     * a checkable claim rather than a wish.
     */
    baselineEvents: (owner, projectId, options = {}) => arrangement.baselineEvents(owner, projectId, options),

    /**
     * The baseline's source inventory: id, kind and Canonical authority.
     *
     * The authority is carried because symbolic truth and audio truth are
     * separate evidence fields (`SOURCE_POLICY.md` §2), and a citation that
     * mislabels which one it is collapses them by the back door. Read-only, and
     * it arbitrates nothing about what either class may prove.
     */
    async baselineSources(owner, projectId) {
      const { baseline, project } = await intake.project(owner, projectId);
      return {
        baseline_id: baseline.baseline_id,
        sources: (project.sources ?? []).map(source => ({ id: source.id, kind: source.kind, authority: source.authority })),
      };
    },

    async analyzeSources(owner, projectId, options = {}) {
      const { job, result } = await jobs.run(owner, projectId, JOB_TYPES.INTAKE, async () => {
        const { baseline } = await intake.run(owner, projectId, options);
        return { result: baseline, reference: baseline.baseline_id };
      });
      return { operation: OPERATION_STATUS.SUCCEEDED, job, baseline: result };
    },

    async suggestArrangement(owner, projectId, options = {}) {
      return { operation: OPERATION_STATUS.SUCCEEDED, suggestion: await arrangement.suggest(owner, projectId, options) };
    },

    async applyDecisions(owner, projectId, input) {
      const result = await arrangement.applyDecisions(owner, projectId, input);
      return {
        // The application either applied the whole set or applied nothing. A
        // refused set is a real answer about the decisions, so it is reported
        // with its own codes rather than raised as a transport failure.
        operation: result.applied ? OPERATION_STATUS.SUCCEEDED : OPERATION_STATUS.BLOCKED,
        code: result.applied ? null : ERROR_CODES.DECISION_REQUIRED,
        decisions: result,
      };
    },

    async planFinalReduction(owner, projectId, input) {
      return { operation: OPERATION_STATUS.SUCCEEDED, reduction: await arrangement.finalReduction(owner, projectId, { ...input, apply: false }) };
    },

    async applyFinalReduction(owner, projectId, input) {
      const result = await arrangement.finalReduction(owner, projectId, { ...input, apply: true });
      const reviewResult = result.applied ? await review.review(owner, projectId, { candidateId: result.candidate_id }) : null;
      return { operation: result.applied ? OPERATION_STATUS.SUCCEEDED : OPERATION_STATUS.BLOCKED, reduction: result, review: reviewResult };
    },

    async planMobileAdaptation(owner, projectId, input) {
      return { operation: OPERATION_STATUS.SUCCEEDED, adaptation: await arrangement.mobileAdaptation(owner, projectId, { ...input, apply: false }) };
    },

    async applyMobileAdaptation(owner, projectId, input) {
      const result = await arrangement.mobileAdaptation(owner, projectId, { ...input, apply: true });
      const reviewResult = result.applied ? await review.review(owner, projectId, { candidateId: result.candidate_id }) : null;
      return { operation: result.applied || result.unchanged ? OPERATION_STATUS.SUCCEEDED : OPERATION_STATUS.BLOCKED, adaptation: result, review: reviewResult };
    },

    async reviewCandidate(owner, projectId, input) {
      return { operation: OPERATION_STATUS.SUCCEEDED, review: await review.review(owner, projectId, input) };
    },

    async finalize(owner, projectId, input) {
      const { job, result } = await jobs.run(owner, projectId, JOB_TYPES.FINALIZE, async () => {
        const outcome = await final.finalize(owner, projectId, input);
        return { result: outcome, artifactId: outcome.artifact_id, reference: outcome.candidate_id };
      });
      return { ...result, job };
    },
  };

  const runs = createRunService({
    canonical,
    projects,
    store,
    operations: internal,
    serialize: serialized,
    serviceVersion,
    hooks: runHooks,
  });

  // The AI Proposal Protocol. It is built AFTER the run service and takes it as
  // a dependency, because an accepted proposal reaches an operation through the
  // run's PUBLIC resume — the same door a caller who never used a proposal goes
  // through. It is given the internal façade only for the two READ-ONLY plan
  // derivations an acceptance needs, and it supplies no internal provenance
  // key: a proposal is external input.
  const proposals = createProposalService({
    canonical,
    projects,
    store,
    operations: internal,
    runs,
    serialize: serialized,
    serviceVersion,
  });

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
      return mutate(projectId, async () => envelope(await internal.analyzeSources(owner, projectId, options)));
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
      return mutate(projectId, async () => envelope(await internal.suggestArrangement(owner, projectId, options)));
    },

    async applyDecisions(owner, projectId, input) {
      return mutate(projectId, async () => envelope(await internal.applyDecisions(owner, projectId, publicInput(input))));
    },

    async approveCore3SourceChange(owner, projectId, input) {
      // Same serializer key as every other mutating operation. Keyed by owner
      // too, these two writes ran on a different chain from `applyDecisions`
      // and `analyzeSources`, so intake could replace the baseline between the
      // read that resolves `baseline_id` and the write that binds to it.
      return mutate(projectId, async () => envelope({
        operation: OPERATION_STATUS.SUCCEEDED,
        ...(await review.approveCore3SourceChange(owner, projectId, input)),
      }));
    },

    /**
     * Preview the Final Six-Role Reduction. Read-only: nothing is written and
     * no candidate is minted, whatever the plan says.
     */
    async planFinalReduction(owner, projectId, input) {
      return envelope(await internal.planFinalReduction(owner, projectId, publicInput(input)));
    },

    /**
     * Apply a reviewed Final Six-Role Reduction plan and re-run the review.
     *
     * The review that comes back is the ordinary candidate review of the new
     * revision. It is run here so a caller cannot mistake "applied" for
     * "reviewed": every gate the reduction touched is PENDING again until that
     * review says otherwise.
     */
    async applyFinalReduction(owner, projectId, input) {
      return mutate(projectId, async () => envelope(await internal.applyFinalReduction(owner, projectId, publicInput(input))));
    },

    async planMobileAdaptation(owner, projectId, input) {
      return envelope(await internal.planMobileAdaptation(owner, projectId, publicInput(input)));
    },

    async applyMobileAdaptation(owner, projectId, input) {
      return mutate(projectId, async () => envelope(await internal.applyMobileAdaptation(owner, projectId, publicInput(input))));
    },

    /**
     * Re-supply Lead evidence for an already-applied Lead move on one candidate.
     *
     * Its own operation, and deliberately not part of `applyDecisions`: nothing
     * moves. See `review-service.reviewLeadEvidence` for why the path has to
     * exist and what each binding refuses.
     */
    async reviewLeadEvidence(owner, projectId, input) {
      return mutate(projectId, async () => envelope({
        operation: OPERATION_STATUS.SUCCEEDED,
        ...(await review.reviewLeadEvidence(owner, projectId, input)),
      }));
    },

    async reviewCandidate(owner, projectId, input) {
      return mutate(projectId, async () => envelope(await internal.reviewCandidate(owner, projectId, input)));
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
      return mutate(projectId, async () => envelope(await internal.finalize(owner, projectId, publicInput(input))));
    },

    // ── runs ────────────────────────────────────────────────────────────────
    //
    // One traceable, explicitly resumable workflow instance over the operations
    // above. A run is not a job and not a background worker: it advances only
    // inside the call that asked it to, and it stops at the first point where a
    // decision, an evidence record or a capability is missing. See
    // `run-service.mjs` for what it will and will not do on a caller's behalf.

    /** Read-only. Creates no run and writes nothing at all. */
    async planRun(owner, projectId, input = {}) {
      return envelope({ operation: OPERATION_STATUS.SUCCEEDED, plan: await runs.plan(owner, projectId, input) });
    },

    /** Create a run and take the steps the supplied inputs already allow. */
    async startRun(owner, projectId, input = {}) {
      const result = await runs.start(owner, projectId, input);
      return envelope({ operation: OPERATION_STATUS.SUCCEEDED, ...result });
    },

    /** Read-only run state, or this project's run list when no id is named. */
    async getRun(owner, projectId, runId = null) {
      return envelope({ operation: OPERATION_STATUS.SUCCEEDED, ...(await runs.get(owner, projectId, runId)) });
    },

    /** Re-check an existing run and advance it with new input. */
    async resumeRun(owner, projectId, runId, input = {}) {
      const result = await runs.resume(owner, projectId, runId, input);
      return envelope({ operation: OPERATION_STATUS.SUCCEEDED, ...result });
    },

    // ── proposals ───────────────────────────────────────────────────────────
    //
    // The AI Proposal Protocol. An external agent reads a run's open review
    // requests, submits a structured, citable, refusable statement about one of
    // them, and a reviewer explicitly accepts or rejects it. Only an acceptance
    // reaches an operation, and it reaches the SAME operation a manual caller
    // reaches, with the same input. See `proposal-service.mjs`.
    //
    // Submitting applies nothing. There is no verdict here that moves a gate,
    // records a confirmation, resolves a PENDING or advances a run, and there
    // is no automatic acceptance of any kind in this build.

    /** Read-only. Which of a run's open review requests an agent may answer, and how. */
    async proposalTargets(owner, projectId, runId) {
      return envelope({ operation: OPERATION_STATUS.SUCCEEDED, ...(await proposals.targets(owner, projectId, runId)) });
    },

    /** Store one agent's structured statement. Applies nothing. */
    async proposeDecision(owner, projectId, input = {}) {
      return envelope({ operation: OPERATION_STATUS.SUCCEEDED, ...(await proposals.propose(owner, projectId, publicInput(input))) });
    },

    /** Read-only. One stored proposal, with the Agent Review verdict recomputed now. */
    async getProposal(owner, projectId, proposalId) {
      return envelope({ operation: OPERATION_STATUS.SUCCEEDED, ...(await proposals.get(owner, projectId, proposalId)) });
    },

    /** Read-only. This project's proposals, optionally narrowed. */
    async listProposals(owner, projectId, input = {}) {
      return envelope({ operation: OPERATION_STATUS.SUCCEEDED, ...(await proposals.list(owner, projectId, input)) });
    },

    /**
     * Record an explicit acceptance, rejection or withdrawal.
     *
     * An acceptance — and only an acceptance — routes the prepared input into
     * the existing run resume path. The run's own answer comes back unchanged
     * beside the proposal record; an applied proposal certifies nothing about
     * it.
     */
    async resolveProposal(owner, projectId, proposalId, input = {}) {
      return envelope({ operation: OPERATION_STATUS.SUCCEEDED, ...(await proposals.resolve(owner, projectId, proposalId, publicInput(input))) });
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

    // ── technical validation ────────────────────────────────────────────────
    //
    // The two Canonical operations route to the Published Canonical validator
    // and fail closed with CANONICAL_NOT_LOADED when the published rules are
    // unavailable. There is no fallback to the legacy engine: the two engines
    // disagree in both directions, so answering a Canonical question with a
    // legacy verdict would misreport the release.
    //
    // The legacy engine stays reachable under its own names, as an explicitly
    // labelled diagnostic. Its report carries `technical_ok: null`,
    // `authority: 'LEGACY_DIAGNOSTIC'` and `strict_mobile_technical: NOT_RUN`,
    // so an environment that cannot load the published rules keeps the
    // capability it already had without that capability being mistaken for a
    // Canonical PASS.

    async validateTechnicalMml(input) {
      return technical.validate(input);
    },

    async technicalOverlapDetails(input) {
      return technical.overlapDetails(input);
    },

    legacyTechnicalDiagnostic(input) {
      return technical.legacyValidate(input);
    },

    legacyTechnicalOverlapDetails(input) {
      return technical.legacyOverlapDetails(input);
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
  isProposalId,
  isRunId,
};
export { buildCapabilities, INTERFACE_VERSION } from './capabilities.mjs';
export { createCanonicalGate, provenanceOf, unloadedProvenance } from './provenance.mjs';
export { PRE_EMISSION_EXEMPT_GATES, FINAL_ARTIFACT_SCHEMA } from './final-service.mjs';
export { CONFIRMATIONS, CONFIRMATION_SCOPE, PLAYER_READBACK_VALUES, STALE_CONFIRMATION, gatesFrom } from './review-service.mjs';
export { PROJECT_RECORD_SCHEMA } from './project-service.mjs';
export {
  READINESS_GATE_OPERATIONS,
  RUN_AUTHORITY_NOTICE,
  RUN_EXECUTION_MODE,
  RUN_EXECUTION_NOTICE,
  RUN_HALT,
  RUN_RECORD_SCHEMA,
  RUN_REPORT_ARTIFACT_TYPE,
  RUN_REPORT_SCHEMA,
  RUN_REVIEW_REQUEST,
  RUN_SEPARATION_NOTICE,
  RUN_STATE,
  RUN_STATE_NAMES,
  RUN_STEP,
  RUN_STEP_OPERATION,
  RUN_STEP_ORDER,
  RUN_STEP_STATUS,
} from './run-contracts.mjs';
export { PLAN_INPUT_KEYS, RECONCILIATION_REMEDY, RESUME_INPUT_KEYS, START_INPUT_KEYS } from './run-service.mjs';
export {
  ACCEPTABLE_AGENT_REVIEW,
  AGENT_REVIEW,
  AGENT_REVIEW_NAMES,
  AGENT_REVIEW_NOTICE,
  AGENT_REVIEW_ORDER,
  CITATION_REQUIRED,
  CITES_KEYS,
  COLLAPSED_SCORE_KEYS,
  EVIDENCE_REF_KIND,
  EVIDENCE_REF_KIND_NAMES,
  EVIDENCE_SEPARATION_NOTICE,
  EVIDENCE_TRUTH_CLASS,
  EVIDENCE_TRUTH_CLASS_NAMES,
  LIST_PROPOSALS_INPUT_KEYS,
  NEVER_AGENT_SETTLABLE,
  PROPOSAL_ACTION_KEYS,
  PROPOSAL_AUTHORITY_NOTICE,
  PROPOSAL_EXECUTION_NOTICE,
  PROPOSAL_INVALIDATORS,
  PROPOSAL_KIND,
  PROPOSAL_KIND_NAMES,
  PROPOSAL_KIND_OPERATION,
  PROPOSAL_MODEL_NOTICE,
  PROPOSAL_PROTOCOL_VERSION,
  PROPOSAL_RECORD_SCHEMA,
  PROPOSAL_REFUSAL,
  PROPOSAL_SEPARATION_NOTICE,
  PROPOSAL_STATE,
  PROPOSAL_STATE_NAMES,
  PROPOSAL_TARGETS,
  PROPOSE_INPUT_KEYS,
  REQUEST_KEY_FIELDS,
  REQUEST_KEY_NOTICE,
  RESOLUTION,
  RESOLUTION_NAMES,
  RESOLVE_INPUT_KEYS,
  UNKNOWN_REQUEST_TARGETS,
  isProposalKind,
  isRequestKey,
  requestKeyOf,
} from './proposal-contracts.mjs';
export { INTERNAL_PROVENANCE_KEYS } from './contracts.mjs';
export { ACCEPTED_MEDIA_TYPES } from './asset-service.mjs';
