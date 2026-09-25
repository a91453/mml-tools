// The AI Proposal Protocol — submission, the Agent Review Policy, and
// acceptance into the operations that already exist.
//
// Status: IMPLEMENTATION NOTES. This service implements and exposes existing
// Published Canonical-aware Studio capabilities. It defines no Canonical rule,
// adds no musical capability, and holds no arrangement, reduction, adaptation,
// review or emitter logic of its own.
//
// What this module is
// -------------------
// Four operations over one new first-class durable record:
//
//   proposalTargets   read-only. Which of a run's open review requests an agent
//                     may answer, with which proposal classes, what each one
//                     would reach, and what a proposal of that class must carry.
//   propose           store one agent's structured statement. Applies nothing.
//   getProposal /     read-only. The stored statement, plus the Agent Review
//   listProposals     Policy's verdict recomputed against what is stored NOW.
//   resolveProposal   record an explicit acceptance, rejection or withdrawal.
//                     An acceptance — and only an acceptance — routes the
//                     prepared input into the existing run resume path.
//
// What this module is NOT
// -----------------------
// It is not a second musical mutation engine. Nothing here parses, arranges,
// reduces, adapts, evaluates or emits. An accepted proposal is translated into
// the ordinary input of the ordinary operation and handed to `runs.resume`,
// which re-validates every binding and performs every check it performs for a
// caller who never used a proposal at all. That is why the manual path and the
// accepted-proposal path produce the same candidate identity for the same
// input: there is only one path, and the proposal layer is a way of filling in
// its arguments.
//
// It is also not a way to reach anything the run would not reach. Acceptance
// calls `runs.resume` through its PUBLIC entry point, so the run takes its own
// per-project lock, applies its own idempotency, its own optimistic
// concurrency, its own staleness re-validation and its own interruption rules.
// Nothing here uses the run-internal façade, and nothing here supplies an
// internal provenance key: a proposal is external input, and it goes through
// the external door.
//
// Locking
// -------
// `runs.resume` takes the per-project serializer itself. This service therefore
// records the acceptance under the lock, RELEASES it, calls resume, and records
// the outcome under the lock again — because one project key acquired twice
// deadlocks by construction (`index.mjs`, `createProjectSerializer`).
//
// That leaves a window, and the window is closed by reusing what Phase 1
// already built rather than by inventing a second mechanism. The acceptance
// mints a deterministic idempotency key from the proposal id and the revision
// it was accepted at, and passes the run revision observed under the lock as
// `expected_run_revision`. So:
//
//   * a crash between the acceptance and the resume leaves a proposal in
//     `accepted`, and retrying it re-issues the SAME key — the run replays its
//     own receipt instead of applying anything twice;
//   * a concurrent writer that advanced the run in the window fails the
//     revision precondition, and the run is not applied to material the
//     acceptance never saw.
//
// The state that used to be ambiguous — the run advanced but its receipt was
// not written, which is an application interrupted inside `advance`, a process
// that died there included — is told apart by the run's own record, not by
// guessing. The run records, with every revision it takes, which request's
// write produced it (`revision_written_by`: the idempotency key, the request
// fingerprint and the revision that write produced). A retry continues from
// the run's current revision only when that record was written for the
// revision the run is at and says the latest write was this acceptance's own
// application, and the run's own reconciliation then settles whatever step it
// left pending. When anything else has written since -- a build that does not
// know the record included, which carries it onto a revision of its own -- the
// retry carries the revision the acceptance observed, the run refuses it at
// its precondition, and that is recorded as the conflict it is; the proposal
// is not marked applied.
//
// Between the two, `runs.resume` calls back into this service once, inside the
// run's OWN first lock hold, after every refusal that hold makes and before its
// first write (its `admit` option). That admission re-reads the proposal and
// records, durably and before the run writes anything, that the run has let
// this acceptance's input in (`application.run_resume_called`, never cleared),
// and which request it let in (`application.admitted_request_fingerprint`).
// That marker is what tells an accepted proposal whose application never
// reached the run apart from one whose application may have, and only the first
// may still be rejected or withdrawn -- and only while no write the run cannot
// attribute has landed on it since the acceptance, because the release a
// documented rollback returns to applies an accepted proposal without
// recording any admission (`unattributedWriteSinceAcceptance`). An attempt the
// run refuses -- at its revision precondition, say, because another
// application moved the run first -- is never admitted, so it leaves the
// marker as it was, and it pins nothing.
// The re-read is what makes withdrawal race-free: a withdrawal and the
// admission take the same lock, so either the withdrawal lands first and the
// run refuses the attempt with nothing written, or the marker lands first and
// the withdrawal is refused. See `resolve`.

import {
  ASSET_KIND_INTAKE,
  ERROR_CODES,
  ID_PREFIX,
  LIMITS,
  fail,
  isAssetId,
  isArtifactId,
  isCandidateId,
  isJobId,
  isProposalId,
  isRunId,
  requirePlainObject,
  requireString,
  statedFields,
} from './contracts.mjs';
import { newId, sha256Of } from './store.mjs';
import { createPlanDerivationMemo } from './plan-derivation-memo.mjs';
import { RUN_REVIEW_REQUEST, RUN_STATE } from './run-contracts.mjs';
import { latestUnattributedRevision } from './run-service.mjs';
import {
  ACCEPTABLE_AGENT_REVIEW,
  AGENT_REVIEW,
  AGENT_REVIEW_NOTICE,
  CITATION_REQUIRED,
  CITES_KEYS,
  COLLAPSED_SCORE_KEYS,
  CONFLICT_KEYS,
  EVIDENCE_REF_KEYS,
  EVIDENCE_REF_KIND,
  EVIDENCE_REF_KIND_NAMES,
  EVIDENCE_SEPARATION_NOTICE,
  EVIDENCE_TRUTH_CLASS,
  EVIDENCE_TRUTH_CLASS_NAMES,
  LIST_PROPOSALS_INPUT_KEYS,
  NEVER_AGENT_SETTLABLE,
  OPEN_PROPOSAL_STATES,
  PROPOSAL_ACTION_KEYS,
  PROPOSAL_AUTHORITY_NOTICE,
  PROPOSAL_EXECUTION_NOTICE,
  PROPOSAL_INVALIDATORS,
  PROPOSAL_KIND,
  PROPOSAL_KIND_OPERATION,
  PROPOSAL_MODEL_NOTICE,
  PROPOSAL_PROTOCOL_VERSION,
  PROPOSAL_RECORD_SCHEMA,
  PROPOSAL_REFUSAL,
  PROPOSAL_SEPARATION_NOTICE,
  PROPOSAL_STATE,
  PROPOSAL_TARGETS,
  PROPOSE_INPUT_KEYS,
  RESOLUTION,
  RESOLUTION_NAMES,
  RESOLVE_INPUT_KEYS,
  UNKNOWN_REQUEST_TARGETS,
  isProposalKind,
  isRequestKey,
} from './proposal-contracts.mjs';

const now = () => new Date().toISOString();
const encoder = new TextEncoder();

// Key names a proposal never carries, refused wherever one is accepted. After
// `statedFields` was fixed to use `defineProperty`, an own `__proto__` from a
// parsed request body reaches here as ordinary data -- which is exactly the
// point: it is refused by name rather than silently consumed as a prototype
// write nobody can see.
const PROTOTYPE_KEYS = Object.freeze(['__proto__', 'constructor', 'prototype']);

// ─── bounded, prototype-safe rebuild of free-form proposal structure ────────
//
// A proposal carries structure this layer does not own: a decision's
// `metadata`, a Mobile `profile`, a conflict summary. It is stored, so it has
// to be plain JSON, and it is read by name downstream, so it has to be rebuilt
// rather than filtered.
//
// Three things are refused rather than sanitized, because each one is a lie a
// caller could otherwise tell about its own input:
//
//   `__proto__` / `constructor` / `prototype`
//        `rebuilt[key] = value` for the key `__proto__` invokes the inherited
//        setter and changes the object's prototype instead of adding a field.
//        The defineProperty below makes that structurally impossible, and the
//        refusal above it means a caller is told rather than silently having a
//        field it can still read through the chain. A proposal has no
//        legitimate use for any of the three names.
//   a collapsed confidence score
//        `SOURCE_POLICY.md` §2 keeps symbolic and audio truth in separate
//        fields precisely so one number cannot hide their disagreement.
//        Dropping the field silently would read, to the agent that sent it and
//        to a reviewer skimming the record, as a confidence this service took.
//   anything that is not plain JSON
//        a function, a symbol, a non-finite number, a Date. The depth and node
//        budget is spent here rather than discovered by a recursion limit in
//        `JSON.stringify` on the way to disk.
// The free-form structure a proposal carries -- a decision's `metadata`, a
// Mobile `profile`, an instrument profile. Its own bound, deliberately not the
// rationale's: the rationale is a top-level MCP string field held to the
// inline-text rule every tool is held to, and these are nested values the
// service bounds itself.
const JSON_LIMITS = Object.freeze({ maxDepth: 10, maxNodes: 4000, maxStringLength: 4000 });

function rebuildJson(value, label, budget, depth = 0) {
  if (depth > JSON_LIMITS.maxDepth) fail(ERROR_CODES.INVALID_REQUEST, `${label} is nested deeper than ${JSON_LIMITS.maxDepth} levels.`, { refusal: PROPOSAL_REFUSAL.UNKNOWN_FIELD });
  if (--budget.nodes < 0) fail(ERROR_CODES.PAYLOAD_TOO_LARGE, `A proposal carries more than ${JSON_LIMITS.maxNodes} values.`);
  if (value === null || typeof value === 'boolean') return value;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) fail(ERROR_CODES.INVALID_REQUEST, `${label} may not be a non-finite number.`);
    return value;
  }
  if (typeof value === 'string') {
    if (value.length > JSON_LIMITS.maxStringLength) fail(ERROR_CODES.PAYLOAD_TOO_LARGE, `${label} is longer than ${JSON_LIMITS.maxStringLength} characters.`);
    return value;
  }
  if (value === undefined) return null;
  if (Array.isArray(value)) return value.map((item, index) => rebuildJson(item, `${label}[${index}]`, budget, depth + 1));
  if (typeof value !== 'object') fail(ERROR_CODES.INVALID_REQUEST, `${label} may not carry a ${typeof value}.`);

  const rebuilt = {};
  // Own enumerable keys only. Whatever prototype the caller attached is left
  // behind, so a later `value.field` reads exactly what a key-based guard could
  // also have seen.
  for (const key of Object.keys(value)) {
    if (PROTOTYPE_KEYS.includes(key)) {
      fail(ERROR_CODES.INVALID_REQUEST, `${label}.${key} is not an accepted field. A proposal has no field of that name, and one supplied here would be a prototype write rather than data.`, { refusal: PROPOSAL_REFUSAL.PROTOTYPE_POLLUTING_KEY });
    }
    if (COLLAPSED_SCORE_KEYS.includes(key)) {
      fail(ERROR_CODES.INVALID_REQUEST, `${label}.${key} is not an accepted field. ${EVIDENCE_SEPARATION_NOTICE}`, { refusal: PROPOSAL_REFUSAL.COLLAPSED_CONFIDENCE_SCORE, collapsed_score_keys: [...COLLAPSED_SCORE_KEYS] });
    }
    // A key is bounded like a value. It was not, and a key costs no node, so
    // `{ "<100000 chars>": 1 }` spent one of four thousand. That gap is not
    // what made a 7 MB proposal storable -- the byte ceiling below is what
    // answers that -- but an unmeasured string is an unmeasured string.
    if (key.length > JSON_LIMITS.maxStringLength) {
      fail(ERROR_CODES.PAYLOAD_TOO_LARGE, `${label} carries a field name longer than ${JSON_LIMITS.maxStringLength} characters.`);
    }
    Object.defineProperty(rebuilt, key, { value: rebuildJson(value[key], `${label}.${key}`, budget, depth + 1), enumerable: true, writable: true, configurable: true });
  }
  return rebuilt;
}

const jsonBudget = () => ({ nodes: JSON_LIMITS.maxNodes });

/** One request object, checked against its closed key set and rebuilt from it. */
const closedObject = (value, label, allowed) => {
  requirePlainObject(value, label);
  for (const key of Object.keys(value)) {
    // Named before the generic unknown-field refusal, because the codes exist
    // so a caller can tell one problem from another without parsing prose. A
    // `confidence` at the top level of a request and a `confidence` nested in a
    // decision are the same mistake and now get the same answer, with the same
    // notice about why symbolic and audio evidence stay in separate fields.
    if (PROTOTYPE_KEYS.includes(key)) {
      fail(ERROR_CODES.INVALID_REQUEST, `${label}.${key} is not an accepted field. A proposal has no field of that name, and one supplied here would be a prototype write rather than data.`, { refusal: PROPOSAL_REFUSAL.PROTOTYPE_POLLUTING_KEY });
    }
    if (COLLAPSED_SCORE_KEYS.includes(key)) {
      fail(ERROR_CODES.INVALID_REQUEST, `${label}.${key} is not an accepted field. ${EVIDENCE_SEPARATION_NOTICE}`, { refusal: PROPOSAL_REFUSAL.COLLAPSED_CONFIDENCE_SCORE, collapsed_score_keys: [...COLLAPSED_SCORE_KEYS] });
    }
    if (!allowed.has(key)) {
      fail(ERROR_CODES.INVALID_REQUEST, `${label}.${key} is not an accepted field`, { accepted: [...allowed], refusal: PROPOSAL_REFUSAL.UNKNOWN_FIELD });
    }
  }
  return statedFields(value);
};

const boundedArray = (value, label, max) => {
  if (!Array.isArray(value)) fail(ERROR_CODES.INVALID_REQUEST, `${label} must be an array.`);
  if (value.length > max) fail(ERROR_CODES.INVALID_REQUEST, `${label} is limited to ${max} entries.`, { received: value.length });
  return value;
};

const digestOf = value => sha256Of(encoder.encode(JSON.stringify(value)));

// ─── the service ────────────────────────────────────────────────────────────

/**
 * Build the proposal service.
 *
 * @param {object}   deps
 * @param {object}   deps.runs        The run service. Its PUBLIC `resume` is
 *   what an accepted proposal reaches: this layer holds no workflow of its own
 *   and never uses the run-internal façade.
 * @param {object}   deps.operations  The internal façade, for the two READ-ONLY
 *   plan derivations an acceptance needs. Nothing mutating is called from here.
 * @param {Function} deps.serialize   The same per-project serializer every other
 *   mutation uses. Held for the proposal record's own writes and released
 *   before `runs.resume`, which takes it itself.
 */
export function createProposalService({ canonical, projects, store, operations, runs, serialize, serviceVersion }) {
  const proposalsOf = record => (Array.isArray(record.proposals) ? record.proposals : []);
  const runsOf = record => (Array.isArray(record.runs) ? record.runs : []);

  const findProposal = (record, proposalId) => {
    if (!isProposalId(proposalId)) fail(ERROR_CODES.PROPOSAL_NOT_FOUND, 'Unknown proposal', { proposal_id: String(proposalId).slice(0, 64) });
    const proposal = proposalsOf(record).find(entry => entry.proposal_id === proposalId);
    if (!proposal) fail(ERROR_CODES.PROPOSAL_NOT_FOUND, 'Unknown proposal', { proposal_id: proposalId, project_id: record.project_id });
    return proposal;
  };

  const findRun = (record, runId) => {
    if (!isRunId(runId)) fail(ERROR_CODES.RUN_NOT_FOUND, 'Unknown run', { run_id: String(runId).slice(0, 64) });
    const run = runsOf(record).find(entry => entry.run_id === runId);
    if (!run) fail(ERROR_CODES.RUN_NOT_FOUND, 'Unknown run', { run_id: runId, project_id: record.project_id });
    return run;
  };

  /**
   * Write one proposal back, re-reading the project record first.
   *
   * The re-read is the point: another writer may have added a candidate, a run
   * step or another proposal while this call ran, and a blind save of a record
   * captured earlier would drop it. Called only under the project lock.
   */
  const putProposal = (owner, projectId, proposal) => {
    const record = projects.load(owner, projectId);
    const others = proposalsOf(record).filter(entry => entry.proposal_id !== proposal.proposal_id);
    projects.save({ ...record, proposals: [...others, proposal] });
    return proposal;
  };

  const bumpProposal = (owner, projectId, proposal, changes) =>
    putProposal(owner, projectId, { ...proposal, ...changes, revision: proposal.revision + 1, updated_at: now() });

  /**
   * Whether an accepted proposal's application may already have reached the
   * run, as far as this build's own admissions say.
   *
   * `application.run_resume_called` is set when the run ADMITS an attempt --
   * inside its own first lock hold, after every refusal of its own and before
   * its first write -- and is never cleared, so `false` means the run never
   * let an attempt made through this build in. An attempt the run refused, at
   * its revision precondition or anywhere else before admission, leaves it as
   * it was. A record without the field was accepted before this service kept
   * it, and nothing else on the record can establish that no attempt reached
   * the run -- the last recorded conflict names only the last attempt, and an
   * attempt that died inside the run records nothing at all -- so it reads as
   * `true`: the answer that refuses, not the one that guesses. (A `true`
   * recorded before admission was where it is written may name an attempt the
   * run refused; it reads as `true` too.)
   *
   * `false` is not the whole answer. A build that does not know the marker --
   * the release a documented rollback returns to -- retries an accepted
   * proposal past the policy and into the run without recording any
   * admission. Whether an acceptance may be taken back reads the run as well
   * (`unattributedWriteSinceAcceptance`, `mayBeTakenBack`).
   */
  const mayHaveReachedRun = proposal => proposal.application?.run_resume_called !== false;

  /**
   * The latest revision the run has taken since this acceptance observed it
   * that was produced by a write whose writer the run does not record -- or
   * null when every write since then recorded its writer.
   *
   * Such a write is what a build that does not know the admission marker and
   * the run's writer record leaves: the release a documented rollback returns
   * to. Its retry of an accepted proposal skips the policy, is let into the run
   * and writes to it, and records no admission, so the marker stays `false`
   * while this acceptance's application is on the run. Nothing either build
   * writes names this acceptance on every one of those writes: the key it
   * sends reaches the run only in the idempotency receipt, written once the
   * whole application has finished (and among a bounded number of receipts);
   * the input the run folds in is content, which a reviewer's own request can
   * repeat; the effect attempt ids are random; and that build's phase 3 writes
   * nothing when its process dies inside the run. What the run does record is
   * whether each revision's writer is known (`latestUnattributedRevision`), so
   * any unattributed write after the acceptance is read as one that may have
   * been this acceptance's application -- including a reviewer's resume
   * through that build, which is the cost, in the refusing direction.
   *
   * A write the acceptance observed was made before it, so it is no part of
   * its application and does not count: only revisions after
   * `application.expected_run_revision` do.
   */
  const unattributedWriteSinceAcceptance = (run, application) => {
    const unattributed = latestUnattributedRevision(run);
    if (unattributed === null) return null;
    const observed = application?.expected_run_revision;
    return Number.isInteger(observed) && unattributed <= observed ? null : unattributed;
  };

  /**
   * Whether an accepted proposal may still be rejected or withdrawn: only when
   * the run never admitted an attempt made through this build, AND no write
   * the run cannot attribute has landed on it since the acceptance. A run that
   * is not on the record cannot say the second, so it answers no.
   */
  const mayBeTakenBack = (proposal, run) => Boolean(run)
    && !mayHaveReachedRun(proposal)
    && unattributedWriteSinceAcceptance(run, proposal.application) === null;

  /**
   * Whether the run's latest write was made by this acceptance's own
   * application.
   *
   * The run records, with every revision it takes and in the same save, which
   * request's write produced it (`run.revision_written_by`: the idempotency
   * key, the request fingerprint, and the revision that write produced). This
   * acceptance's application is one key (`application.idempotency_key`) and
   * one request, the one the run's admission recorded
   * (`application.admitted_request_fingerprint`). When both match, and the
   * record is the one written for the revision the run is at now, nothing else
   * has written to the run since this application last did: not another
   * acceptance, not a reviewer's resume, and not a caller who reused this key
   * with another payload. That holds after a restart too, because it is read
   * from the run's own record rather than from anything an attempt kept in
   * memory.
   *
   * The revision check is what keeps it true across builds. A build that does
   * not know the field -- the release a rollback returns to -- writes the run
   * by spreading the record it read and bumping the revision, so it carries
   * this application's record onto a revision of its own: a reviewer's resume
   * through it would otherwise read as this application's latest write, and a
   * retry would continue onto the reviewer's run past a policy grading it
   * STALE. A record whose revision is not the run's names nobody.
   *
   * Anything else -- another writer, a record carried onto a later revision, a
   * run record written before the run kept this, an application no admission
   * recorded -- reads as `false`: the answer that refuses the retry, not the
   * one that guesses.
   */
  const lastWrittenByThisApplication = (run, application) => {
    const writer = run?.revision_written_by ?? null;
    return writer !== null
      && Number.isInteger(run.revision) && writer.revision === run.revision
      && typeof application?.idempotency_key === 'string' && writer.idempotency_key === application.idempotency_key
      && typeof application.admitted_request_fingerprint === 'string' && writer.request_fingerprint === application.admitted_request_fingerprint;
  };

  // ── request resolution ────────────────────────────────────────────────────
  //
  // A run's open review requests, addressed by the key each one carries. Two
  // answers are refused rather than resolved: a key no current request carries,
  // and a key more than one carries. The second DOES happen — `stalenessRequest`
  // projects every non-meter reason onto one fixed shape with no baseline and
  // no candidate — and it is refused rather than resolved, because picking one
  // is how ownership-by-position comes back.

  const openRequests = run => (run.review_requests ?? []);

  const requestsMatching = (run, requestKey) => openRequests(run).filter(entry => entry.request_key === requestKey);

  const admissibleKinds = request => (Object.hasOwn(PROPOSAL_TARGETS, request.code) ? PROPOSAL_TARGETS[request.code] : UNKNOWN_REQUEST_TARGETS);

  // ── citation resolution ───────────────────────────────────────────────────
  //
  // Everything a proposal cites is resolved inside ITS OWN project's record.
  // That is what makes "fabricated reference" checkable, and it is also what
  // makes a cross-project or cross-owner citation impossible rather than
  // merely refused: the record is loaded for this owner and this project, and
  // an identity that is not in it is simply not found.

  const evidenceResolvers = (record, run, citations) => ({
    // Resolved against the baseline's own source inventory, and carrying the
    // Canonical authority the intake adapters recorded, so the declared truth
    // class can be checked rather than only believed.
    [EVIDENCE_REF_KIND.SOURCE]: id => (citations.sources.has(id)
      ? { ok: true, detail: { kind: citations.sources.get(id).kind, authority: citations.sources.get(id).authority } } : { ok: false }),
    [EVIDENCE_REF_KIND.ASSET]: id => (isAssetId(id) && record.assets.some(entry => entry.asset_id === id)
      ? { ok: true, detail: { kind: record.assets.find(entry => entry.asset_id === id).kind } } : { ok: false }),
    [EVIDENCE_REF_KIND.ARTIFACT]: id => (isArtifactId(id) && record.artifacts.some(entry => entry.artifact_id === id)
      ? { ok: true, detail: { type: record.artifacts.find(entry => entry.artifact_id === id).type ?? null } } : { ok: false }),
    [EVIDENCE_REF_KIND.JOB]: id => (isJobId(id) && (record.jobs ?? []).some(entry => entry.job_id === id) ? { ok: true, detail: {} } : { ok: false }),
    [EVIDENCE_REF_KIND.CANDIDATE]: id => (isCandidateId(id) && record.candidates.some(entry => entry.candidate_id === id) ? { ok: true, detail: {} } : { ok: false }),
    [EVIDENCE_REF_KIND.BASELINE]: id => (record.baseline?.baseline_id === id ? { ok: true, detail: {} } : { ok: false }),
    [EVIDENCE_REF_KIND.RUN]: id => (isRunId(id) && runsOf(record).some(entry => entry.run_id === id) ? { ok: true, detail: {} } : { ok: false }),
    // Exactly a `report_reference` some open request on THIS run supplied. An
    // agent citing "the report the run told me about" is citing something this
    // service handed it; anything else is a string it made up.
    [EVIDENCE_REF_KIND.REPORT_REFERENCE]: id => (openRequests(run).some(entry => entry.report_reference === id) ? { ok: true, detail: {} } : { ok: false }),
  });

  /**
   * Resolve the cited baseline events and sources through the existing
   * read-only projections.
   *
   * `listBaselineEvents` and the stored baseline project are the two places
   * these identities exist. Nothing is derived here and nothing is cached: a
   * citation is checked against what the baseline holds at the moment it is
   * checked, which is why it is re-checked at acceptance too.
   */
  const resolveBaselineCitations = async (owner, projectId, cites) => {
    const resolved = { events: new Set(), sources: new Map(), baseline_id: null };
    const sources = await operations.baselineSources(owner, projectId);
    resolved.baseline_id = sources.baseline_id;
    for (const source of sources.sources) resolved.sources.set(source.id, source);
    if (cites.event_ids.length) {
      const page = await operations.baselineEvents(owner, projectId, { eventIds: [...cites.event_ids], limit: LIMITS.maxProposalCitations });
      for (const event of page.events) resolved.events.add(event.event_id);
    }
    return resolved;
  };

  // ── input normalization ───────────────────────────────────────────────────

  const normalizeCites = (value, label) => {
    const source = value === undefined || value === null ? {} : closedObject(value, label, new Set(CITES_KEYS));
    const ids = (field, max) => (source[field] === undefined || source[field] === null
      ? []
      : boundedArray(source[field], `${label}.${field}`, max).map((id, index) => requireString(id, `${label}.${field}[${index}]`, { max: 300 })));
    const evidenceRefs = (source.evidence_refs === undefined || source.evidence_refs === null
      ? []
      : boundedArray(source.evidence_refs, `${label}.evidence_refs`, LIMITS.maxProposalCitations).map((entry, index) => {
        const ref = closedObject(entry, `${label}.evidence_refs[${index}]`, new Set(EVIDENCE_REF_KEYS));
        const kind = requireString(ref.kind, `${label}.evidence_refs[${index}].kind`, { max: 40 });
        if (!EVIDENCE_REF_KIND_NAMES.includes(kind)) {
          fail(ERROR_CODES.INVALID_REQUEST, `${label}.evidence_refs[${index}].kind must be one of ${EVIDENCE_REF_KIND_NAMES.join(', ')}. A URL, a filename, a conversation excerpt and a recollection are not references this service can resolve; prose belongs in rationale, where nobody can mistake it for a pointer.`, { refusal: PROPOSAL_REFUSAL.FABRICATED_EVIDENCE_REF });
        }
        const truthClass = requireString(ref.truth_class, `${label}.evidence_refs[${index}].truth_class`, { max: 40 });
        if (!EVIDENCE_TRUTH_CLASS_NAMES.includes(truthClass)) {
          fail(ERROR_CODES.INVALID_REQUEST, `${label}.evidence_refs[${index}].truth_class must be one of ${EVIDENCE_TRUTH_CLASS_NAMES.join(', ')}. ${EVIDENCE_SEPARATION_NOTICE}`, { refusal: PROPOSAL_REFUSAL.COLLAPSED_CONFIDENCE_SCORE });
        }
        return {
          kind,
          id: requireString(ref.id, `${label}.evidence_refs[${index}].id`, { max: 300 }),
          truth_class: truthClass,
          note: ref.note === undefined || ref.note === null ? null : requireString(ref.note, `${label}.evidence_refs[${index}].note`, { max: LIMITS.maxProposalNoteLength }),
        };
      }));
    return {
      event_ids: [...new Set(ids('event_ids', LIMITS.maxProposalCitations))],
      source_ids: [...new Set(ids('source_ids', LIMITS.maxProposalCitations))],
      evidence_refs: evidenceRefs,
    };
  };

  const normalizeConflicts = (value, label) => (value === undefined || value === null
    ? []
    : boundedArray(value, label, LIMITS.maxProposalConflicts).map((entry, index) => {
      const conflict = closedObject(entry, `${label}[${index}]`, new Set(CONFLICT_KEYS));
      return {
        summary: requireString(conflict.summary, `${label}[${index}].summary`, { max: LIMITS.maxProposalNoteLength }),
        event_ids: conflict.event_ids === undefined || conflict.event_ids === null ? [] : boundedArray(conflict.event_ids, `${label}[${index}].event_ids`, LIMITS.maxProposalCitations).map((id, i) => requireString(id, `${label}[${index}].event_ids[${i}]`, { max: 300 })),
        source_ids: conflict.source_ids === undefined || conflict.source_ids === null ? [] : boundedArray(conflict.source_ids, `${label}[${index}].source_ids`, LIMITS.maxProposalCitations).map((id, i) => requireString(id, `${label}[${index}].source_ids[${i}]`, { max: 300 })),
        // Which classes of truth disagree. Recorded rather than reconciled:
        // SOURCE_POLICY.md §2 requires the disagreement itself to be on the
        // record, and this protocol has no verdict to offer about it.
        truth_classes: conflict.truth_classes === undefined || conflict.truth_classes === null ? [] : boundedArray(conflict.truth_classes, `${label}[${index}].truth_classes`, EVIDENCE_TRUTH_CLASS_NAMES.length).map((name, i) => {
          const value_ = requireString(name, `${label}[${index}].truth_classes[${i}]`, { max: 40 });
          if (!EVIDENCE_TRUTH_CLASS_NAMES.includes(value_)) fail(ERROR_CODES.INVALID_REQUEST, `${label}[${index}].truth_classes[${i}] must be one of ${EVIDENCE_TRUTH_CLASS_NAMES.join(', ')}.`);
          return value_;
        }),
      };
    }));

  const normalizeStrings = (value, label, { max, maxLength }) => (value === undefined || value === null
    ? []
    : boundedArray(value, label, max).map((entry, index) => requireString(entry, `${label}[${index}]`, { max: maxLength })));

  /**
   * One proposal action, per class, against that class's closed key set.
   *
   * Nothing here validates a decision's musical content. The decision
   * vocabulary belongs to `arrangement/decision-application.mjs`, the reduction
   * vocabulary to `reduction/index.mjs` and the profile to `adaptation/
   * index.mjs`, and restating any of them here would create a second contract
   * to keep in step with the module that owns it. What IS checked here is the
   * one thing those modules cannot check: that the caller is not supplying a
   * field this service computes.
   */
  const normalizeAction = (kind, value, label) => {
    const allowed = new Set(PROPOSAL_ACTION_KEYS[kind]);
    if (!allowed.size) {
      if (value !== undefined && value !== null) {
        fail(ERROR_CODES.INVALID_REQUEST, `A ${kind} proposal carries no action: there is nothing to apply, and describing what is missing is its whole content.`, { refusal: PROPOSAL_REFUSAL.ACTION_KIND_MISMATCH });
      }
      return null;
    }
    if (value === undefined || value === null) {
      fail(ERROR_CODES.INVALID_REQUEST, `A ${kind} proposal must carry an action.`, { accepted: [...allowed], refusal: PROPOSAL_REFUSAL.ACTION_KIND_MISMATCH });
    }
    const source = closedObject(value, label, allowed);
    const budget = jsonBudget();

    if (kind === PROPOSAL_KIND.ARRANGEMENT_DECISION || kind === PROPOSAL_KIND.FINAL_REDUCTION) {
      const decisions = boundedArray(source.decisions ?? [], `${label}.decisions`, LIMITS.maxDecisionsPerRequest);
      if (!decisions.length) {
        fail(ERROR_CODES.INVALID_REQUEST, `${label}.decisions must name at least one decision. An empty set is not a proposal about anything.`, { refusal: PROPOSAL_REFUSAL.ACTION_KIND_MISMATCH });
      }
      const prepared = decisions.map((entry, index) => {
        requirePlainObject(entry, `${label}.decisions[${index}]`);
        for (const key of Object.keys(entry)) {
          // The acceptance binding is computed by the arrangement service from
          // the baseline, the suggestion and the Canonical snapshot that are
          // loaded at APPLY time. A caller who could supply one could make a
          // decision claim to have been accepted against material it never saw.
          if (key === 'acceptance') {
            fail(ERROR_CODES.INVALID_REQUEST, `${label}.decisions[${index}].acceptance is computed by this service from the inputs that are loaded when the decision is applied, and must not be supplied.`, { refusal: PROPOSAL_REFUSAL.SERVER_COMPUTED_FIELD_SUPPLIED });
          }
          // `applyDecisions` reads a decision's own `acceptedBy` in preference
          // to the call's, and writes it into the acceptance binding. An agent
          // that could set it here would name the accepting reviewer itself,
          // and the reviewer who actually accepted the proposal would not
          // appear on the decision at all -- a suggestion turned into an
          // acceptance by one field. `note` is refused for the same reason: it
          // is written INSIDE the acceptance, where it reads as the accepting
          // reviewer's words rather than the proposer's. The agent's words
          // belong in `rationale`, and the reviewer's in the acceptance.
          if (key === 'acceptedBy' || key === 'note') {
            fail(ERROR_CODES.INVALID_REQUEST, `${label}.decisions[${index}].${key} must not be supplied by a proposal. A proposal does not name who accepted it: the explicit acceptance supplies accepted_by and its own reason, and this service uses those. State the proposer's reasoning in rationale.`, { refusal: PROPOSAL_REFUSAL.ACCEPTANCE_IDENTITY_SUPPLIED });
          }
          // `leadEvidence` is a candidate-bound REVIEWER record, and the one
          // field on a decision that a proposal must not author.
          //
          // The shared Lead grader checks that a citation BINDS: that its
          // sourceIdentity names a real Source-Faithful Baseline source event,
          // that continuity holds, that Core3 survives. It cannot check that
          // anyone actually read the score, because nothing can. So a
          // well-formed record whose score citation says "the model recalls the
          // score shows an inner voice here" grades exactly like one a reviewer
          // wrote, and both Gate 3 axes reach PASS -- a machine manufacturing
          // the evidence for its own proposal, which is precisely what
          // NEVER_AGENT_SETTLABLE says a proposal never does.
          //
          // The role decision itself stays proposable. Without reviewer
          // Lead evidence, an existing-role MOVE_ROLE into Melody still stops
          // at the Lead interlock. The one candidate-flow exception is an
          // initial ASSIGN_ROLE from role-less source material into Melody:
          // it may materialize a reversible review-pending candidate, but that
          // is not Lead evidence and cannot satisfy Gate 3. A reviewer supplies
          // the citation later through `applyDecisions` or
          // `reviewLeadEvidence`, both candidate-bound paths.
          if (key === 'leadEvidence') {
            fail(ERROR_CODES.INVALID_REQUEST, `${label}.decisions[${index}].leadEvidence must not be supplied by a proposal. A proposal is a suggestion; a Lead evidence citation is a candidate-bound review record, filed through reviewLeadEvidence, where it is graded on its cited project source, its method and its finding whoever submits it (the grader cannot check that anybody read the source, for any submitter). Propose the role decision without leadEvidence. An existing-role Lead move remains blocked by the Lead interlock; an initial role-less ASSIGN_ROLE -> Melody may only materialize a review-pending candidate. In both cases the citation must be supplied through applyDecisions or reviewLeadEvidence before Gate 3 can PASS.`, { refusal: PROPOSAL_REFUSAL.REVIEWER_EVIDENCE_RECORD_SUPPLIED });
          }
        }
        return rebuildJson(entry, `${label}.decisions[${index}]`, budget);
      });
      if (kind === PROPOSAL_KIND.ARRANGEMENT_DECISION) return { decisions: prepared };
      return {
        decisions: prepared,
        instrument_profile: source.instrument_profile === undefined || source.instrument_profile === null ? null : rebuildJson(requirePlainObject(source.instrument_profile, `${label}.instrument_profile`), `${label}.instrument_profile`, budget),
        // Optional, and an expectation rather than an input: the service
        // derives the plan itself at acceptance, through the existing read-only
        // operation, and a stated id that does not match the derived one is
        // reported as stale rather than overridden.
        //
        // A reduction plan id is bound to its decision set AND its reviewer, so
        // a stated id means nothing without the reviewer it was derived under.
        // Requiring the pair is what keeps the expectation checkable instead of
        // decorative -- an un-checkable stated field is worse than no field,
        // because an agent reads it back and believes it was honoured.
        expected_plan_id: source.expected_plan_id === undefined || source.expected_plan_id === null ? null : (() => {
          const stated = requireString(source.expected_plan_id, `${label}.expected_plan_id`, { max: 200 });
          if (source.plan_accepted_by === undefined || source.plan_accepted_by === null) {
            fail(ERROR_CODES.INVALID_REQUEST, `${label}.expected_plan_id needs ${label}.plan_accepted_by: a reduction plan id is bound to its decision set and to the reviewer it was derived under, so an id without that reviewer names nothing this service can check.`, { refusal: PROPOSAL_REFUSAL.ACTION_KIND_MISMATCH });
          }
          return stated;
        })(),
        plan_accepted_by: source.plan_accepted_by === undefined || source.plan_accepted_by === null ? null : requireString(source.plan_accepted_by, `${label}.plan_accepted_by`, { max: 120 }),
      };
    }

    if (kind === PROPOSAL_KIND.MOBILE_ADAPTATION) {
      // No reviewer here, and none is missing: an adaptation plan id is bound
      // to the candidate and the profile, so the derived id is checkable
      // against the stated one on its own. See `PROPOSAL_ACTION_KEYS`.
      return {
        profile: rebuildJson(requirePlainObject(source.profile, `${label}.profile`), `${label}.profile`, budget),
        expected_plan_id: source.expected_plan_id === undefined || source.expected_plan_id === null ? null : requireString(source.expected_plan_id, `${label}.expected_plan_id`, { max: 200 }),
      };
    }

    if (kind === PROPOSAL_KIND.SOURCE_SELECTION) {
      const assetIds = boundedArray(source.asset_ids ?? [], `${label}.asset_ids`, LIMITS.maxAssetsPerProject);
      if (!assetIds.length) {
        fail(ERROR_CODES.INVALID_REQUEST, `${label}.asset_ids must name at least one asset. An empty list selects nothing and is not a way to ask for every symbolic asset.`, { refusal: PROPOSAL_REFUSAL.ACTION_KIND_MISMATCH });
      }
      return {
        asset_ids: assetIds.map((id, index) => requireString(id, `${label}.asset_ids[${index}]`, { max: 64 })),
        meter_text: source.meter_text === undefined || source.meter_text === null ? null : requireString(source.meter_text, `${label}.meter_text`, { max: LIMITS.maxMeterTextLength }),
      };
    }

    // CANDIDATE_SELECTION.
    const candidateId = requireString(source.candidate_id, `${label}.candidate_id`, { max: 128 });
    if (!isCandidateId(candidateId)) fail(ERROR_CODES.CANDIDATE_NOT_FOUND, 'Unknown candidate', { candidate_id: candidateId.slice(0, 96) });
    return { candidate_id: candidateId };
  };

  const normalizeProposeInput = input => {
    const source = closedObject(input ?? {}, 'proposal input', new Set(PROPOSE_INPUT_KEYS));
    const kind = requireString(source.kind, 'kind', { max: 64 });
    if (!isProposalKind(kind)) {
      fail(ERROR_CODES.INVALID_REQUEST, `kind must be one of ${Object.values(PROPOSAL_KIND).join(', ')}.`, { refusal: PROPOSAL_REFUSAL.UNKNOWN_PROPOSAL_KIND });
    }
    const requestKey = requireString(source.request_key, 'request_key', { max: 96 });
    if (!isRequestKey(requestKey)) {
      fail(ERROR_CODES.INVALID_REQUEST, 'request_key must be the key a review request carries (req:<64 hex>). It is read from the run, never constructed by a caller.', { refusal: PROPOSAL_REFUSAL.FABRICATED_REQUEST_KEY });
    }
    // Stated by the agent and checked against the table, rather than read from
    // it. An agent that believes it is proposing one thing while the service
    // would apply another is refused instead of surprised.
    const expectedOperation = source.expected_operation === undefined || source.expected_operation === null
      ? null
      : requireString(source.expected_operation, 'expected_operation', { max: 200 });
    if (expectedOperation !== null && expectedOperation !== (PROPOSAL_KIND_OPERATION[kind] ?? 'none')) {
      fail(ERROR_CODES.INVALID_REQUEST, `expected_operation does not match what a ${kind} proposal reaches.`, {
        refusal: PROPOSAL_REFUSAL.EXPECTED_OPERATION_MISMATCH,
        stated: expectedOperation,
        actual: PROPOSAL_KIND_OPERATION[kind] ?? 'none',
      });
    }
    return {
      idempotency_key: source.idempotency_key === undefined || source.idempotency_key === null ? null : requireString(source.idempotency_key, 'idempotency_key', { max: LIMITS.maxIdempotencyKeyLength }),
      run_id: requireString(source.run_id, 'run_id', { max: 64 }),
      expected_run_revision: source.expected_run_revision === undefined || source.expected_run_revision === null ? null : (() => {
        if (!Number.isSafeInteger(source.expected_run_revision) || source.expected_run_revision < 1 || source.expected_run_revision > LIMITS.maxRunRevision) {
          fail(ERROR_CODES.INVALID_REQUEST, `expected_run_revision must be the run revision the agent read: an integer from 1 to ${LIMITS.maxRunRevision}.`);
        }
        return source.expected_run_revision;
      })(),
      request_key: requestKey,
      kind,
      proposed_by: requireString(source.proposed_by, 'proposed_by', { max: 120 }),
      rationale: requireString(source.rationale, 'rationale', { max: LIMITS.maxProposalRationaleLength }),
      action: normalizeAction(kind, source.action, 'action'),
      cites: normalizeCites(source.cites, 'cites'),
      unresolved_conflicts: normalizeConflicts(source.unresolved_conflicts, 'unresolved_conflicts'),
      missing_evidence: normalizeStrings(source.missing_evidence, 'missing_evidence', { max: LIMITS.maxProposalConflicts, maxLength: LIMITS.maxProposalNoteLength }),
      canonical_warnings: normalizeStrings(source.canonical_warnings, 'canonical_warnings', { max: LIMITS.maxProposalConflicts, maxLength: LIMITS.maxProposalNoteLength }),
      expected_operation: expectedOperation,
    };
  };

  const normalizeResolveInput = input => {
    const source = closedObject(input ?? {}, 'resolve input', new Set(RESOLVE_INPUT_KEYS));
    const resolution = requireString(source.resolution, 'resolution', { max: 32 });
    if (!RESOLUTION_NAMES.includes(resolution)) fail(ERROR_CODES.INVALID_REQUEST, `resolution must be one of ${RESOLUTION_NAMES.join(', ')}.`);
    if (resolution === RESOLUTION.ACCEPT && (source.accepted_by === undefined || source.accepted_by === null)) {
      fail(ERROR_CODES.INVALID_REQUEST, 'accepted_by must name who accepted this proposal. The agent\'s proposed_by is what the agent called itself; it is not an acceptance, and this service will not reuse it as one.');
    }
    return {
      resolution,
      accepted_by: source.accepted_by === undefined || source.accepted_by === null ? null : requireString(source.accepted_by, 'accepted_by', { max: 120 }),
      reason: source.reason === undefined || source.reason === null ? null : requireString(source.reason, 'reason', { max: LIMITS.maxProposalNoteLength }),
      expected_proposal_revision: source.expected_proposal_revision === undefined || source.expected_proposal_revision === null ? null : (() => {
        if (!Number.isSafeInteger(source.expected_proposal_revision) || source.expected_proposal_revision < 1 || source.expected_proposal_revision > LIMITS.maxRunRevision) {
          fail(ERROR_CODES.INVALID_REQUEST, `expected_proposal_revision must be the revision the caller last observed: an integer from 1 to ${LIMITS.maxRunRevision}.`);
        }
        return source.expected_proposal_revision;
      })(),
    };
  };

  // ── bindings ──────────────────────────────────────────────────────────────

  const assetSelectionDigest = run => digestOf((run.inputs?.asset_digests ?? []).map(entry => [entry.asset_id, entry.sha256, entry.size]).sort());

  const bindingOf = (run, request, canonicalProvenance) => ({
    rules_snapshot_sha: canonicalProvenance.rules_snapshot_sha ?? null,
    baseline_id: run.baseline_id ?? null,
    candidate_id: run.candidate_id ?? null,
    run_revision: run.revision,
    asset_selection_digest: assetSelectionDigest(run),
    decision_set_fingerprint: run.inputs?.decision_set_fingerprint ?? null,
    request_key: request.request_key,
    request_code: request.code,
    request_step: request.step,
    request_gate: request.gate ?? null,
    request_report_reference: request.report_reference ?? null,
  });

  // What the PROJECT has done under a run since a binding was taken: the
  // baseline replaced, the bound candidate gone, a selected asset's bytes no
  // longer the ones the run recorded. Shared by the Agent Review Policy, which
  // asks it of a stored proposal, and the targets read, which asks it of the
  // binding a proposal written now would get -- so the read side never
  // advertises a target every submission against which is born STALE.
  const projectMovedUnder = (record, run, bound) => {
    const moved = [];
    if (bound.baseline_id !== null && (record.baseline?.baseline_id ?? null) !== bound.baseline_id) moved.push(PROPOSAL_REFUSAL.BASELINE_CHANGED);
    if (bound.candidate_id !== null && !record.candidates.some(entry => entry.candidate_id === bound.candidate_id)) moved.push(PROPOSAL_REFUSAL.CANDIDATE_CHANGED);
    if (Array.isArray(run.inputs?.asset_ids)) {
      const byId = new Map(record.assets.map(asset => [asset.asset_id, asset]));
      for (const entry of run.inputs.asset_digests ?? []) {
        const asset = byId.get(entry.asset_id);
        if (!asset || asset.sha256 !== entry.sha256 || asset.size !== entry.size) moved.push(PROPOSAL_REFUSAL.ASSET_SELECTION_CHANGED);
      }
    }
    return moved;
  };

  // ── plan derivation ───────────────────────────────────────────────────────
  //
  // The one derivation both the Agent Review Policy and an acceptance's
  // `translate` perform, so the check the policy grades is the check an
  // acceptance would otherwise fail. Read-only: the existing plan operations
  // with `apply: false`, which write nothing and take no lock.
  //
  // It is a pure function of what is stored -- the bound candidate and its
  // lineage, the baseline, the loaded Published Canonical engines -- and of the
  // proposal's own action and the reviewer it runs under. The reviewer is the
  // one input an acceptance supplies and the policy cannot know, and it does
  // not decide whether the derivation succeeds: a reduction plan id is bound to
  // its reviewer, but the operation refuses a reviewer only for not being a
  // name of 1-120 characters, which the acceptance's own `accepted_by` and the
  // proposal's `plan_accepted_by` are both already held to.

  // What the plan operation is called with, built in one place so the memo
  // below keys on exactly the input the operation receives.
  const planOperationInput = (proposal, reviewer) => (proposal.kind === PROPOSAL_KIND.FINAL_REDUCTION
    ? {
      operation: 'planFinalReduction',
      input: {
        candidateId: proposal.binding.candidate_id,
        decisions: structuredClone(proposal.action.decisions),
        acceptedBy: reviewer,
        instrumentProfile: structuredClone(proposal.action.instrument_profile),
      },
    }
    : {
      operation: 'planMobileAdaptation',
      input: {
        candidateId: proposal.binding.candidate_id,
        profile: structuredClone(proposal.action.profile),
      },
    });

  const planIdOf = async (owner, projectId, { operation, input }) => {
    const preview = await operations[operation](owner, projectId, input);
    return (operation === 'planFinalReduction' ? preview.reduction : preview.adaptation)?.plan?.id ?? null;
  };

  const derivePlanId = (owner, projectId, proposal, reviewer) => planIdOf(owner, projectId, planOperationInput(proposal, reviewer));

  // The policy's own derivation, memoized on every input it reads
  // (`plan-derivation-memo.mjs`, which says why and on what key). The policy
  // polls it on every read; one derivation of a song-length reduction holds
  // the event loop for seconds. `translate` does not use it: an acceptance's
  // own derivations -- under the accepting reviewer, and under the named one
  // for a stated id -- run afresh after the acceptance is recorded, as the
  // backstop the INPUTS_CHANGED codes name.
  const policyPlanDerivations = createPlanDerivationMemo({
    canonical,
    store,
    planInputIdentity: (owner, projectId, candidateId) => operations.planInputIdentity(owner, projectId, candidateId),
    derive: planIdOf,
  });

  // The classes whose acceptance goes through a plan derivation, and the codes
  // a derivation that fails is graded with.
  const PLAN_CHECKS = Object.freeze({
    [PROPOSAL_KIND.FINAL_REDUCTION]: Object.freeze({
      operation: 'planFinalReduction',
      refused: PROPOSAL_REFUSAL.REDUCTION_PLAN_REFUSED,
      mismatch: PROPOSAL_REFUSAL.REDUCTION_PLAN_ID_MISMATCH,
    }),
    [PROPOSAL_KIND.MOBILE_ADAPTATION]: Object.freeze({
      operation: 'planMobileAdaptation',
      refused: PROPOSAL_REFUSAL.ADAPTATION_PLAN_REFUSED,
      mismatch: PROPOSAL_REFUSAL.ADAPTATION_PLAN_ID_MISMATCH,
    }),
  });

  /**
   * Would an acceptance be able to translate this proposal into the run's
   * input? `null` when it would; otherwise the verdict to grade it with.
   *
   * This used to be discovered only at acceptance, after the acceptance was
   * recorded. A final reduction naming an `expected_plan_id` its own decisions
   * do not produce passed the policy, which judged bindings and not the
   * translation; was accepted; failed in `translate` before `runs.resume` was
   * ever called; and failed identically on every retry, because nothing about
   * it could change. It stayed `accepted` for good, could not be withdrawn,
   * and held one of the project's open-proposal slots -- enough of them locked
   * the project out of the protocol.
   *
   * What the operation REPORTS about an action it accepts -- blockers, a Lead
   * interlock, an event left PENDING -- is not graded here. That is the
   * operation's musical answer, and it is reached at the run exactly as it is
   * for a manual caller. Only a refusal to derive a plan at all, and a stated
   * plan id the action does not produce, are this policy's business: those
   * are the two ways an acceptance's translation fails.
   */
  const planRefusal = async (owner, record, proposal) => {
    const check = PLAN_CHECKS[proposal.kind];
    // The reviewer the proposal itself names for its stated plan id, which is
    // exactly the one `translate` checks that id under; with none named, the
    // plan operation's own preview reviewer.
    const reviewer = proposal.kind === PROPOSAL_KIND.FINAL_REDUCTION ? proposal.action.plan_accepted_by : null;
    let planId;
    try {
      const derived = await policyPlanDerivations.outcome(owner, record.project_id, planOperationInput(proposal, reviewer));
      if (derived.refusal) {
        return {
          verdict: AGENT_REVIEW.INVALID,
          refusals: [check.refused],
          detail: { plan_refusal: { operation: check.operation, code: derived.refusal.code, message: derived.refusal.message } },
        };
      }
      planId = derived.plan_id;
    } catch (error) {
      // Not a refusal of the action: the stored material or the engines could
      // not be read. The same discipline as an unresolvable citation above --
      // a statement about the material, never an accusation about the proposal
      // -- and never an acceptable verdict either, because the translation
      // would fail the same way right now.
      return {
        verdict: AGENT_REVIEW.STALE,
        refusals: [error?.code === ERROR_CODES.CANDIDATE_NOT_FOUND ? PROPOSAL_REFUSAL.CANDIDATE_CHANGED : PROPOSAL_REFUSAL.BASELINE_CHANGED],
        detail: {
          plan_derivation_error: error?.code ?? ERROR_CODES.SOURCE_INCOMPLETE,
          notice: `The plan an acceptance of this proposal would derive through ${check.operation} could not be derived from the stored material. That is a statement about the material, not about the proposal.`,
        },
      };
    }
    if (!planId) {
      return {
        verdict: AGENT_REVIEW.INVALID,
        refusals: [check.refused],
        detail: { plan_refusal: { operation: check.operation, code: null, message: 'The existing plan operation produced no plan id for this action, so there is nothing an acceptance could apply.' } },
      };
    }
    if (proposal.action.expected_plan_id !== null && proposal.action.expected_plan_id !== planId) {
      return {
        verdict: AGENT_REVIEW.INVALID,
        refusals: [check.mismatch],
        detail: {
          proposed_plan_id: proposal.action.expected_plan_id,
          derived_plan_id: planId,
          ...(proposal.kind === PROPOSAL_KIND.FINAL_REDUCTION ? { plan_accepted_by: reviewer } : {}),
          notice: `The plan id this proposal states is not the plan ${check.operation} derives from its own action against the material it is bound to${proposal.kind === PROPOSAL_KIND.FINAL_REDUCTION ? ', under the reviewer it names' : ''}. An acceptance applies only a plan it derives itself and refuses a stated id that disagrees, so this proposal could never be applied as written.`,
        },
      };
    }
    return null;
  };

  // ── the Agent Review Policy ───────────────────────────────────────────────
  //
  // One verdict, from the ladder in `proposal-contracts.AGENT_REVIEW_ORDER`,
  // evaluated in order. The first rule that matches is the answer, so a caller
  // is told which problem to fix rather than handed a set to rank.
  //
  // The policy judges binding, evidence and authority. It judges no music. It
  // does not decide whether a Lead belongs in Melody, whether an omission is
  // safe, or whether a register shift preserves a role: every one of those is
  // arbitrated by the existing engines under the Published Canonical rules,
  // when the operation runs, for this caller exactly as for any other.

  const verdictOf = (verdict, refusals, detail = {}) => ({
    verdict,
    refusals: [...new Set(refusals)],
    acceptable: verdict === ACCEPTABLE_AGENT_REVIEW,
    downstream_operation: PROPOSAL_KIND_OPERATION[detail.kind] ?? null,
    notice: AGENT_REVIEW_NOTICE,
    ...detail,
  });

  /**
   * Re-evaluate one stored proposal against what is stored NOW.
   *
   * Called on every read and again, under the lock, immediately before an
   * acceptance. Never cached: a cached safety check is a safety check that can
   * be wrong, and every input it reads is one another caller can move. The one
   * engine derivation inside it (`planRefusal`) reuses an earlier outcome only
   * for byte-identical inputs, re-read on this call (`policyPlanDerivations`),
   * and the verdict is graded from that outcome afresh.
   */
  const agentReview = async (owner, record, proposal, canonicalProvenance) => {
    const kind = proposal.kind;
    const detail = { kind };

    // ── STALE. Every binding, re-read.
    const stale = [];
    const run = runsOf(record).find(entry => entry.run_id === proposal.run_id) ?? null;
    if (!run) {
      // A run this project no longer holds. Not "invalid" — the proposal was
      // well-formed when it was written — and not settlable either.
      return verdictOf(AGENT_REVIEW.STALE, [PROPOSAL_REFUSAL.REQUEST_NO_LONGER_OPEN], { ...detail, run_present: false });
    }
    const bound = proposal.binding;
    // Unknown is not a wildcard, on either side.
    //
    // This read `loaded && bound && loaded !== bound`, so a binding with no
    // snapshot -- written while the Published Canonical could not be loaded, or
    // restored from a schema that predates the field -- skipped the check
    // entirely and stayed applicable under every release published afterwards.
    // A service that cannot name the rules it is loading now cannot say the two
    // agree either, so both absences are refused rather than passed over. That
    // is the same discipline as an unrecognised request code admitting nothing
    // but a description of what is missing: what this layer cannot establish,
    // it does not assume.
    const boundSnapshot = Object.hasOwn(bound, 'rules_snapshot_sha') && bound.rules_snapshot_sha ? bound.rules_snapshot_sha : null;
    const loadedSnapshot = canonicalProvenance.rules_snapshot_sha ?? null;
    if (boundSnapshot === null || loadedSnapshot === null) stale.push(PROPOSAL_REFUSAL.CANONICAL_SNAPSHOT_UNKNOWN);
    else if (loadedSnapshot !== boundSnapshot) stale.push(PROPOSAL_REFUSAL.CANONICAL_SNAPSHOT_CHANGED);
    if ((run.baseline_id ?? null) !== (bound.baseline_id ?? null)) stale.push(PROPOSAL_REFUSAL.BASELINE_CHANGED);
    if ((run.candidate_id ?? null) !== (bound.candidate_id ?? null)) stale.push(PROPOSAL_REFUSAL.CANDIDATE_CHANGED);
    if (run.revision !== bound.run_revision) stale.push(PROPOSAL_REFUSAL.RUN_REVISION_CHANGED);
    if (assetSelectionDigest(run) !== bound.asset_selection_digest) stale.push(PROPOSAL_REFUSAL.ASSET_SELECTION_CHANGED);
    // The three above compare the proposal against the RUN. These three compare
    // it against the PROJECT, and both halves are needed: a run holds what it
    // recorded, so re-ingesting under new sources, applying a revision from
    // outside the run or re-uploading an asset moves the material without
    // moving anything the run wrote down. The run would still halt on its own
    // staleness when the acceptance reached it -- Phase 1 re-validates every
    // binding per step -- but a proposal a reader is told is applicable, and
    // which then halts the run the moment it is accepted, is a proposal whose
    // verdict was answering the wrong question.
    stale.push(...projectMovedUnder(record, run, bound));
    if ((run.inputs?.decision_set_fingerprint ?? null) !== (bound.decision_set_fingerprint ?? null)) stale.push(PROPOSAL_REFUSAL.DECISION_SET_CHANGED);
    // A completed run is an audit record, not a workspace, and an interrupted
    // one is waiting on somebody to look at a stored record. Neither is a place
    // a proposal may be applied, and both are checked here as well as by the
    // run itself, so a reader of the proposal is told why without having to
    // accept it to find out.
    if (run.state === RUN_STATE.COMPLETED || run.report_artifact_id) stale.push(PROPOSAL_REFUSAL.RUN_AUDIT_CLOSED);
    // Both markers, because they are set at different moments. `pending_step`
    // is written BEFORE a mutating effect and survives a crash; the derived
    // `needs_reconciliation` flag is written only once a LATER advancement has
    // already tried to settle that effect and failed. Reading the flag alone
    // leaves a window -- the whole window that matters -- in which a run's step
    // may or may not have landed and a proposal would be accepted onto it.
    if (run.pending_step) stale.push(PROPOSAL_REFUSAL.RUN_NEEDS_RECONCILIATION);
    if (run.needs_reconciliation === true) stale.push(PROPOSAL_REFUSAL.RUN_NEEDS_RECONCILIATION);

    const matching = requestsMatching(run, bound.request_key);
    if (matching.length === 0) stale.push(PROPOSAL_REFUSAL.REQUEST_NO_LONGER_OPEN);
    // Refused rather than resolved by position. The run does produce colliding
    // keys -- every non-meter staleness reason is projected onto one fixed
    // shape, so an asset change and a Canonical snapshot change on one run key
    // alike -- and picking either is how ownership-by-position returns. It
    // costs nothing: the requests that can collide admit only a description of
    // what is missing, which applies nothing.
    if (matching.length > 1) stale.push(PROPOSAL_REFUSAL.REQUEST_AMBIGUOUS);
    if (stale.length) return verdictOf(AGENT_REVIEW.STALE, stale, { ...detail, invalidated_by: PROPOSAL_INVALIDATORS });

    const request = matching[0];

    // ── INVALID. Re-checked, because a citation resolves against material that
    // another caller can move even while the bindings above still hold.
    const invalid = [];

    // The baseline half first: an evidence reference may name a source, and
    // whether it resolves is a question only the baseline's own inventory
    // answers.
    const citedSourceIds = [...new Set([
      ...proposal.cites.source_ids,
      ...proposal.cites.evidence_refs.filter(ref => ref.kind === EVIDENCE_REF_KIND.SOURCE).map(ref => ref.id),
    ])];
    let citations = { events: new Set(), sources: new Map() };
    if (proposal.cites.event_ids.length || citedSourceIds.length) {
      // A baseline that cannot be read is not an agent's forgery, and must not
      // be reported as one. "This identity is not in the baseline" and "there
      // is no baseline to look in" are different facts with different remedies,
      // and collapsing them would accuse a correct proposal of fabricating a
      // citation every time intake had been re-run underneath it.
      try { citations = await resolveBaselineCitations(owner, record.project_id, { event_ids: proposal.cites.event_ids, source_ids: citedSourceIds }); }
      catch (error) {
        return verdictOf(AGENT_REVIEW.STALE, [PROPOSAL_REFUSAL.BASELINE_CHANGED], {
          ...detail,
          citation_resolution_error: error?.code ?? ERROR_CODES.SOURCE_INCOMPLETE,
          notice: 'The citations this proposal carries could not be resolved against a Source-Faithful Baseline. That is a statement about the baseline, not about the proposal: nothing here says the citation was fabricated.',
        });
      }
      if (proposal.cites.event_ids.some(id => !citations.events.has(id))) invalid.push(PROPOSAL_REFUSAL.FABRICATED_EVENT_ID);
      if (proposal.cites.source_ids.some(id => !citations.sources.has(id))) invalid.push(PROPOSAL_REFUSAL.FABRICATED_SOURCE_ID);
    }

    const resolvers = evidenceResolvers(record, run, citations);
    // `Object.hasOwn` rather than a bare lookup. `kind` is validated against the
    // enum at submission, so it cannot be `constructor` today -- but a bracket
    // read on an object literal finds `Object.prototype.constructor` if it ever
    // could, and a kind with no resolver would be a TypeError at read time
    // rather than a refusal. A reference this service cannot resolve is an
    // unresolved reference, which is what `FABRICATED_EVIDENCE_REF` says.
    const resolvedRefs = proposal.cites.evidence_refs.map(ref => ({
      ...ref,
      ...(Object.hasOwn(resolvers, ref.kind) ? resolvers[ref.kind](ref.id) : { ok: false }),
    }));
    if (resolvedRefs.some(ref => !ref.ok)) invalid.push(PROPOSAL_REFUSAL.FABRICATED_EVIDENCE_REF);

    // Symbolic truth and audio truth stay in separate fields, and a citation
    // that mislabels which one it is collapses them by the back door. The check
    // is mechanical — the Canonical source authority the intake adapters
    // recorded — and it arbitrates nothing about what either class may prove.
    for (const ref of proposal.cites.evidence_refs) {
      if (ref.kind !== EVIDENCE_REF_KIND.SOURCE) continue;
      const source = citations.sources.get(ref.id);
      if (!source) continue;
      const isAudio = source.authority === 'primary-audio';
      if (isAudio && ref.truth_class === EVIDENCE_TRUTH_CLASS.SYMBOLIC) invalid.push(PROPOSAL_REFUSAL.COLLAPSED_CONFIDENCE_SCORE);
      if (!isAudio && ref.truth_class === EVIDENCE_TRUTH_CLASS.AUDIO) invalid.push(PROPOSAL_REFUSAL.COLLAPSED_CONFIDENCE_SCORE);
    }
    if (proposal.action && Object.hasOwn(proposal.action, 'asset_ids')) {
      if (proposal.action.asset_ids.some(id => !record.assets.some(entry => entry.asset_id === id))) invalid.push(PROPOSAL_REFUSAL.CROSS_PROJECT_IDENTITY);
      // A source selection names what intake ingests; an asset it cannot ingest
      // (a recording, a report) is not a selection that acceptance could apply.
      else if (proposal.action.asset_ids.some(id => ASSET_KIND_INTAKE[record.assets.find(entry => entry.asset_id === id)?.kind]?.intake !== true)) invalid.push(PROPOSAL_REFUSAL.ACTION_KIND_MISMATCH);
    }
    if (proposal.action && Object.hasOwn(proposal.action, 'candidate_id')) {
      if (!record.candidates.some(entry => entry.candidate_id === proposal.action.candidate_id)) invalid.push(PROPOSAL_REFUSAL.CROSS_PROJECT_IDENTITY);
    }
    if (invalid.length) return verdictOf(AGENT_REVIEW.INVALID, invalid, detail);

    // The translation an acceptance would perform, graded here rather than
    // discovered after the acceptance is on the record (`planRefusal`). Last on
    // this rung, and only for an otherwise valid proposal, because it is the one
    // INVALID check that runs an engine. Only for a class this request admits:
    // a class it does not admit is refused on the next rung whatever its plan
    // says, and deriving a plan against a request that binds no candidate would
    // report the request's shape as the proposal's fault.
    if (Object.hasOwn(PLAN_CHECKS, kind) && admissibleKinds(request).includes(kind)) {
      const refused = await planRefusal(owner, record, proposal);
      if (refused) return verdictOf(refused.verdict, refused.refusals, { ...detail, ...refused.detail });
    }

    // ── NOT_AGENT_SETTLABLE. Scope, before evidence: no amount of evidence
    // makes a gate confirmation into something an agent states.
    const admissible = admissibleKinds(request);
    if (!admissible.includes(kind)) {
      return verdictOf(AGENT_REVIEW.NOT_AGENT_SETTLABLE, [
        PROPOSAL_REFUSAL.TARGET_NOT_SETTLABLE_BY_THIS_CLASS,
        ...(admissible.length === 1 && admissible[0] === PROPOSAL_KIND.EVIDENCE_NEEDED ? [PROPOSAL_REFUSAL.TARGET_NOT_SETTLABLE_BY_ANY_PROPOSAL] : []),
      ], {
        ...detail,
        request_code: request.code,
        request_gate: request.gate ?? null,
        admissible_kinds: [...admissible],
        known_request_code: Object.hasOwn(PROPOSAL_TARGETS, request.code),
        never_agent_settlable: NEVER_AGENT_SETTLABLE,
      });
    }

    // ── REQUIRES_MORE_EVIDENCE.
    //
    // `evidence_needed` is checked first and deliberately escapes this rung: a
    // proposal whose entire content is "here is what is missing" is a complete
    // answer, not an incomplete one. PENDING is a legitimate and important
    // result, and this is where that is true in code rather than in prose.
    if (kind !== PROPOSAL_KIND.EVIDENCE_NEEDED) {
      const thin = [];
      // The agent's own statement about itself, taken at face value. An agent
      // that says evidence is missing is not overruled into having enough.
      if (proposal.missing_evidence.length) thin.push(PROPOSAL_REFUSAL.MISSING_EVIDENCE_DECLARED);
      // MASTER_RULES.md §0: when two authorities disagree, do not guess.
      if (proposal.unresolved_conflicts.length) thin.push(PROPOSAL_REFUSAL.UNRESOLVED_CONFLICT_DECLARED);
      if (CITATION_REQUIRED[kind] && !proposal.cites.event_ids.length && !proposal.cites.source_ids.length && !proposal.cites.evidence_refs.length) {
        thin.push(PROPOSAL_REFUSAL.NO_VERIFIABLE_CITATION);
      }
      if (thin.length) {
        return verdictOf(AGENT_REVIEW.REQUIRES_MORE_EVIDENCE, thin, {
          ...detail,
          declared_missing_evidence: proposal.missing_evidence,
          unresolved_conflict_count: proposal.unresolved_conflicts.length,
        });
      }
    }

    // ── PROPOSABLE. Admissible, bound, complete — and reaching no operation.
    if (PROPOSAL_KIND_OPERATION[kind] === null) {
      return verdictOf(AGENT_REVIEW.PROPOSABLE, [PROPOSAL_REFUSAL.NO_DOWNSTREAM_OPERATION], {
        ...detail,
        request_code: request.code,
        notice: 'Recorded for the reviewer who will answer this request. Accepting it performs no operation and advances no run: there is nothing to apply, which is what this class says.',
      });
    }

    // ── REQUIRES_EXPLICIT_ACCEPTANCE. The only actionable verdict, and it is
    // named after what is still missing.
    return verdictOf(AGENT_REVIEW.REQUIRES_EXPLICIT_ACCEPTANCE, [], {
      ...detail,
      request_code: request.code,
      resolved_citations: {
        event_ids: proposal.cites.event_ids.length,
        source_ids: proposal.cites.source_ids.length,
        evidence_refs: resolvedRefs.length,
        truth_classes: [...new Set(proposal.cites.evidence_refs.map(ref => ref.truth_class))],
      },
    });
  };

  // ── projection ────────────────────────────────────────────────────────────

  const proposalView = (proposal, review) => Object.freeze({
    proposal_id: proposal.proposal_id,
    project_id: proposal.project_id,
    run_id: proposal.run_id,
    schema: proposal.schema,
    protocol_version: proposal.protocol_version,
    revision: proposal.revision,
    state: proposal.state,
    kind: proposal.kind,
    created_at: proposal.created_at,
    updated_at: proposal.updated_at,
    // The authenticated owner who submitted it, and the text the agent called
    // itself. Two fields, never one: an `proposed_by` string is not an
    // authenticated identity and is never presented as one.
    submitted_by: proposal.submitted_by,
    proposed_by: proposal.proposed_by,
    binding: Object.freeze({ ...proposal.binding }),
    action: proposal.action === null ? null : Object.freeze(structuredClone(proposal.action)),
    rationale: proposal.rationale,
    cites: Object.freeze(structuredClone(proposal.cites)),
    unresolved_conflicts: Object.freeze(structuredClone(proposal.unresolved_conflicts)),
    missing_evidence: Object.freeze([...proposal.missing_evidence]),
    canonical_warnings: Object.freeze([...proposal.canonical_warnings]),
    expected_operation: proposal.expected_operation,
    downstream_operation: PROPOSAL_KIND_OPERATION[proposal.kind] ?? null,
    // Recomputed on every read against what is stored now. The verdict the
    // policy reached when the proposal was written is kept beside it, as
    // history, so a reviewer can see that the two differ and why.
    agent_review: review === null ? null : Object.freeze(structuredClone(review)),
    agent_review_at_submission: Object.freeze(structuredClone(proposal.agent_review_at_submission)),
    resolution: proposal.resolution === null ? null : Object.freeze(structuredClone(proposal.resolution)),
    application: proposal.application === null ? null : Object.freeze(structuredClone(proposal.application)),
    canonical: Object.freeze({ ...proposal.canonical }),
    implementation: Object.freeze({ ...proposal.implementation }),
    invalidated_by: PROPOSAL_INVALIDATORS,
    separation_notice: PROPOSAL_SEPARATION_NOTICE,
    authority_notice: PROPOSAL_AUTHORITY_NOTICE,
    execution_notice: PROPOSAL_EXECUTION_NOTICE,
    model_notice: PROPOSAL_MODEL_NOTICE,
  });

  const proposalSummary = proposal => Object.freeze({
    proposal_id: proposal.proposal_id,
    run_id: proposal.run_id,
    revision: proposal.revision,
    state: proposal.state,
    kind: proposal.kind,
    request_key: proposal.binding.request_key,
    request_code: proposal.binding.request_code,
    proposed_by: proposal.proposed_by,
    created_at: proposal.created_at,
    updated_at: proposal.updated_at,
    agent_review_at_submission: proposal.agent_review_at_submission.verdict,
    applied_run_revision: proposal.application?.run_revision_after ?? null,
  });

  // ── acceptance translation ────────────────────────────────────────────────
  //
  // One proposal class becomes one ordinary `resumeRun` input. Every field here
  // is either something the proposal carries or something the ACCEPTANCE
  // supplies; nothing is synthesized, and nothing an agent stated about who
  // accepted anything is reused.
  //
  // The two plan ids are derived, not trusted. A reduction plan id is bound to
  // its decision set AND its reviewer, so it cannot be known before an
  // acceptance names one; an adaptation plan id is bound to the candidate and
  // the profile, so it can, and is still derived rather than taken. Both are
  // derived through the EXISTING read-only plan operations, which is the same
  // thing a manual caller does before applying.
  //
  // Every check below is also graded by the Agent Review Policy, through the
  // same derivation (`planOperationInput`, `planIdOf`; `planRefusal`, which
  // holds its outcomes in `policyPlanDerivations`), so a proposal that fails
  // one of them is refused before an acceptance is ever recorded. What still
  // reaches them here is material that moved after the policy's check under
  // the lock -- or a retry that skipped the policy because an earlier attempt
  // may already have reached the run -- which is why they keep the
  // INPUTS_CHANGED codes.

  const translate = async (owner, projectId, proposal, acceptedBy) => {
    const kind = proposal.kind;
    if (kind === PROPOSAL_KIND.ARRANGEMENT_DECISION) {
      return { input: { decisions: structuredClone(proposal.action.decisions), accepted_by: acceptedBy }, derived: {} };
    }
    if (kind === PROPOSAL_KIND.FINAL_REDUCTION) {
      const planId = await derivePlanId(owner, projectId, proposal, acceptedBy);
      if (!planId) fail(ERROR_CODES.PROPOSAL_REFUSED, 'The existing reduction plan operation produced no plan id for these decisions, so there is nothing to apply.', { refusal: PROPOSAL_REFUSAL.REDUCTION_PLAN_INPUTS_CHANGED });

      // The agent's stated expectation, checked against a plan derived under
      // the reviewer the agent named. It is never the id that gets applied --
      // that is always the one derived under the ACCEPTING reviewer above --
      // but a stated expectation that no longer holds means the material moved
      // under the proposal, and that is stale rather than something to ignore.
      if (proposal.action.expected_plan_id !== null) {
        const statedId = await derivePlanId(owner, projectId, proposal, proposal.action.plan_accepted_by);
        if (statedId !== proposal.action.expected_plan_id) {
          fail(ERROR_CODES.PROPOSAL_REFUSED, 'The reduction plan this proposal named is not the plan its own decisions produce now, under the reviewer it named. Its inputs moved after the Agent Review Policy last checked it.', {
            refusal: PROPOSAL_REFUSAL.REDUCTION_PLAN_INPUTS_CHANGED,
            proposed_plan_id: proposal.action.expected_plan_id,
            plan_accepted_by: proposal.action.plan_accepted_by,
            derived_plan_id: statedId,
          });
        }
      }
      return {
        input: {
          final_reduction: {
            decisions: structuredClone(proposal.action.decisions),
            expected_plan_id: planId,
            accepted_by: acceptedBy,
            instrument_profile: proposal.action.instrument_profile,
          },
        },
        derived: { reduction_plan_id: planId, proposed_plan_id: proposal.action.expected_plan_id, plan_accepted_by: proposal.action.plan_accepted_by },
      };
    }
    if (kind === PROPOSAL_KIND.MOBILE_ADAPTATION) {
      const planId = await derivePlanId(owner, projectId, proposal, acceptedBy);
      if (!planId) fail(ERROR_CODES.PROPOSAL_REFUSED, 'The existing Mobile adaptation plan operation produced no plan id for this profile, so there is nothing to apply.', { refusal: PROPOSAL_REFUSAL.ADAPTATION_PLAN_INPUTS_CHANGED });
      // An adaptation plan is bound to the candidate and the profile, both of
      // which the proposal itself carries, so an agent CAN state this id ahead
      // of time. When it did and the derived one differs, the inputs moved
      // under it: that is stale, and stale is refused rather than overridden.
      if (proposal.action.expected_plan_id !== null && proposal.action.expected_plan_id !== planId) {
        fail(ERROR_CODES.PROPOSAL_REFUSED, 'The Mobile adaptation plan this proposal named is not the plan its own inputs produce now.', {
          refusal: PROPOSAL_REFUSAL.ADAPTATION_PLAN_INPUTS_CHANGED,
          proposed_plan_id: proposal.action.expected_plan_id,
          derived_plan_id: planId,
        });
      }
      return {
        input: { mobile_adaptation: { profile: structuredClone(proposal.action.profile), expected_plan_id: planId, accepted_by: acceptedBy } },
        derived: { adaptation_plan_id: planId },
      };
    }
    if (kind === PROPOSAL_KIND.SOURCE_SELECTION) {
      return {
        input: {
          asset_ids: [...proposal.action.asset_ids],
          ...(proposal.action.meter_text === null ? {} : { meter_text: proposal.action.meter_text }),
        },
        derived: {},
      };
    }
    // CANDIDATE_SELECTION. Named, never newest: `resumeRun` verifies the
    // candidate's baseline and lineage before adopting it, exactly as it does
    // for a caller who named one by hand.
    return { input: { adopt_candidate_id: proposal.action.candidate_id }, derived: {} };
  };

  // ── operations ────────────────────────────────────────────────────────────

  return Object.freeze({
    /**
     * Read-only. What an agent may propose against one run, right now.
     *
     * Derived from the run's own open review requests. It creates nothing,
     * writes nothing and advances nothing, and it never invents a target: a
     * request the run is not making is not listed, and a request whose code
     * this build does not recognise is listed with `known: false` and admits a
     * description of what is missing and nothing else.
     */
    async targets(owner, projectId, runId) {
      const record = projects.load(owner, projectId);
      const run = findRun(record, runId);
      const provenance = await canonical.provenance();
      const existing = proposalsOf(record).filter(entry => entry.run_id === run.run_id);
      // The refusals a proposal written now would be born with, from the same
      // checks the Agent Review Policy applies to its binding. A run whose
      // project moved under it keeps its old review requests open, but a
      // proposal against any of them could never be accepted.
      const staleAtSubmission = Object.freeze([...new Set([
        ...((provenance.rules_snapshot_sha ?? null) === null ? [PROPOSAL_REFUSAL.CANONICAL_SNAPSHOT_UNKNOWN] : []),
        ...projectMovedUnder(record, run, { baseline_id: run.baseline_id ?? null, candidate_id: run.candidate_id ?? null }),
      ])]);
      return Object.freeze({
        project_id: record.project_id,
        run_id: run.run_id,
        run_revision: run.revision,
        run_state: run.state,
        baseline_id: run.baseline_id ?? null,
        candidate_id: run.candidate_id ?? null,
        read_only: true,
        canonical: provenance,
        protocol_version: PROPOSAL_PROTOCOL_VERSION,
        // A run that is closed or waiting on an inspection accepts no proposal
        // at all, and saying so here is cheaper than letting an agent write one
        // and learn it at acceptance.
        // Reflects what the WRITE side will actually honour, the storage caps
        // included. It used to answer `true` on a project that had filled its
        // proposal budget, so the read side advertised a capability every
        // submission was then refused -- the same "a stated thing that is not
        // true" defect this protocol refuses everywhere else.
        accepts_proposals: !(run.state === RUN_STATE.COMPLETED || run.report_artifact_id || run.pending_step || run.needs_reconciliation === true)
          && staleAtSubmission.length === 0
          && proposalsOf(record).filter(entry => OPEN_PROPOSAL_STATES.includes(entry.state)).length < LIMITS.maxProposalsPerProject
          && proposalsOf(record).length < LIMITS.maxProposalsRetainedPerProject,
        // Why a proposal written now would be STALE from the start; empty when
        // it would not. The remedy is the run's own: a new run on what the
        // project holds now.
        stale_at_submission: staleAtSubmission,
        targets: Object.freeze(openRequests(run).map(request => {
          const admissible = admissibleKinds(request);
          return Object.freeze({
            request_key: request.request_key,
            code: request.code,
            step: request.step,
            gate: request.gate ?? null,
            known_request_code: Object.hasOwn(PROPOSAL_TARGETS, request.code),
            report_reference: request.report_reference,
            baseline_id: request.baseline_id ?? null,
            candidate_id: request.candidate_id ?? null,
            admissible_kinds: Object.freeze([...admissible]),
            // What each admissible class would reach, so an agent never has to
            // guess which existing operation its proposal becomes.
            operations: Object.freeze(Object.fromEntries(admissible.map(kind => [kind, PROPOSAL_KIND_OPERATION[kind]]))),
            citation_required: Object.freeze(Object.fromEntries(admissible.map(kind => [kind, CITATION_REQUIRED[kind] === true]))),
            // The upstream module's own words about what is missing, carried
            // through unchanged. This layer adds no requirement of its own.
            required_evidence: Object.freeze([...(request.missing ?? [])]),
            existing_evidence: Object.freeze([...(request.existing_evidence ?? [])]),
            blockers: Object.freeze([...(request.blockers ?? [])]),
            invalidated_by: Object.freeze([...(request.invalidated_by ?? [])]),
            proposals: Object.freeze(existing.filter(entry => entry.binding.request_key === request.request_key).map(proposalSummary)),
          });
        })),
        never_agent_settlable: NEVER_AGENT_SETTLABLE,
        evidence_separation_notice: EVIDENCE_SEPARATION_NOTICE,
        separation_notice: PROPOSAL_SEPARATION_NOTICE,
        authority_notice: PROPOSAL_AUTHORITY_NOTICE,
        model_notice: PROPOSAL_MODEL_NOTICE,
      });
    },

    /**
     * Record one agent's structured statement about one open review request.
     *
     * Applies nothing. No candidate is minted, no revision is taken, no
     * confirmation is recorded, no gate moves and the run does not advance —
     * the run's revision is not even touched. What this call does is store a
     * record and answer with the policy's verdict on it.
     */
    async propose(owner, projectId, input = {}) {
      const normalized = normalizeProposeInput(input);
      const provenance = await canonical.provenance();

      // What a key is bound to, computed from the caller's own normalized
      // request and from nothing this service has to look up. That it needs no
      // lookup is what lets the replay be decided first, below.
      const fingerprint = digestOf({
        run_id: normalized.run_id, request_key: normalized.request_key, kind: normalized.kind,
        action: normalized.action, rationale: normalized.rationale, cites: normalized.cites,
        unresolved_conflicts: normalized.unresolved_conflicts, missing_evidence: normalized.missing_evidence,
        canonical_warnings: normalized.canonical_warnings, proposed_by: normalized.proposed_by,
      });

      // ── the replay is decided FIRST, and on its own.
      //
      // `runs.resume` decides idempotency before its revision precondition and
      // says why at length: a request that succeeded advances the run, so the
      // network retry of that exact request arrives with a precondition that is
      // stale by construction. The same is true here and it is worse, because
      // what this layer resolves first is not a revision but the REQUEST -- and
      // the request a proposal answers is closed by the very advancement the
      // proposal caused. Resolving it first answered REQUEST_NO_LONGER_OPEN to
      // exactly the retry the key exists to answer, so the documented replay
      // path could not be reached once anything had moved.
      //
      // Nothing is taken on trust: the key must still be bound to this payload,
      // and what comes back is the STORED record with its verdict recomputed
      // against what is stored now -- which is how a reader learns it is stale.
      if (normalized.idempotency_key !== null) {
        const bound = await serialize(String(projectId), async () =>
          proposalsOf(projects.load(owner, projectId)).find(entry => entry.idempotency?.key === normalized.idempotency_key) ?? null);
        if (bound) {
          if (bound.idempotency.request_fingerprint !== fingerprint) {
            fail(ERROR_CODES.IDEMPOTENCY_CONFLICT, 'This idempotency key is already bound to a different proposal payload. Use a new key, or resend the original payload.', {
              proposal_id: bound.proposal_id,
              bound_request_fingerprint: bound.idempotency.request_fingerprint,
              received_request_fingerprint: fingerprint,
            });
          }
          return Object.freeze({
            proposal: proposalView(bound, await agentReview(owner, projects.load(owner, projectId), bound, provenance)),
            replayed: true,
            applied: false,
            notice: 'This idempotency key is already bound to this proposal and this payload, so nothing was stored again. The proposal is returned as it stands, with its verdict recomputed against what is stored now.',
          });
        }
      }

      // The citations are resolved BEFORE the lock, because resolving them
      // reads the baseline through the Canonical engines and a lock held
      // across that would shut out every other writer on this project for the
      // length of a score decode.
      const record = projects.load(owner, projectId);
      const run = findRun(record, normalized.run_id);
      if (normalized.expected_run_revision !== null && normalized.expected_run_revision !== run.revision) {
        fail(ERROR_CODES.RUN_CONFLICT, 'The run has advanced since the revision this proposal was written against; re-read the run before proposing.', {
          run_id: run.run_id, expected_run_revision: normalized.expected_run_revision, current_run_revision: run.revision,
        });
      }
      const matching = requestsMatching(run, normalized.request_key);
      if (matching.length !== 1) {
        fail(ERROR_CODES.INVALID_REQUEST, matching.length === 0
          ? 'No open review request on this run carries that key. A request key is derived from the request\'s own identity, so one that addresses nothing is not resolved to whatever looks closest.'
          : 'More than one open review request carries that key, so this proposal does not address one of them in particular.', {
          refusal: matching.length === 0 ? PROPOSAL_REFUSAL.REQUEST_NO_LONGER_OPEN : PROPOSAL_REFUSAL.REQUEST_AMBIGUOUS,
          request_key: normalized.request_key,
          open_request_keys: openRequests(run).map(entry => entry.request_key),
        });
      }
      const request = matching[0];

      const proposal = {
        schema: PROPOSAL_RECORD_SCHEMA,
        protocol_version: PROPOSAL_PROTOCOL_VERSION,
        proposal_id: newId(ID_PREFIX.proposal),
        project_id: record.project_id,
        run_id: run.run_id,
        revision: 1,
        state: PROPOSAL_STATE.SUBMITTED,
        kind: normalized.kind,
        created_at: now(),
        updated_at: now(),
        submitted_by: owner,
        proposed_by: normalized.proposed_by,
        idempotency: { scope: `proposal:submit:${record.project_id}`, key: normalized.idempotency_key, request_fingerprint: null },
        binding: bindingOf(run, request, provenance),
        action: normalized.action,
        rationale: normalized.rationale,
        cites: normalized.cites,
        unresolved_conflicts: normalized.unresolved_conflicts,
        missing_evidence: normalized.missing_evidence,
        canonical_warnings: normalized.canonical_warnings,
        expected_operation: normalized.expected_operation,
        agent_review_at_submission: null,
        resolution: null,
        application: null,
        // Two provenances, never merged, exactly as a run keeps them. The
        // Canonical identity selects the rules this proposal was written under;
        // the implementation identity records the code that stored it.
        canonical: {
          canonical_version: provenance.canonical_version,
          canonical_status: provenance.canonical_status,
          manifest_version: provenance.manifest_version,
          rules_snapshot_sha: provenance.rules_snapshot_sha,
          machine_delivery_schema: provenance.machine_delivery_schema ?? null,
          manifest_commit: provenance.manifest_commit,
          repository_head: provenance.repository_head,
        },
        implementation: {
          application_version: serviceVersion,
          proposal_schema: PROPOSAL_RECORD_SCHEMA,
          proposal_service: 'proposal-service/1',
          notice: 'Implementation provenance. A change here is a code change, not a new Canonical release, and it never republishes or moves a rules snapshot.',
        },
      };

      // Computed above, from the same values: `findRun` matched this run_id and
      // `requestsMatching` filtered on this request_key, so the record's copies
      // and the caller's are the same strings by construction.
      proposal.idempotency.request_fingerprint = fingerprint;

      // Measured on the record as it will be STORED, after normalization, so
      // the number means what a reader of `maxProposalBytes` thinks it means.
      // The node, depth and string budgets above bound the SHAPE of the
      // free-form structure a proposal carries; none of them bounds its size,
      // and 4000 nodes times a 4000-character string is 15 MB inside every one
      // of them.
      //
      // Measured TWICE, and the second one is the bound. The first is a cheap
      // refusal that spends no policy evaluation on a payload that cannot be
      // stored whatever the verdict. But the stored record also carries the
      // verdict, and the verdict is not a constant -- `REQUIRES_MORE_EVIDENCE`
      // echoes the caller's own `missing_evidence` back into it -- so a record
      // measured at 129,906 bytes was persisted at 146,681. A bound measured on
      // something other than what is stored is the defect this bound exists to
      // answer, one layer further in.
      const refuseOversize = value => {
        const bytes = Buffer.byteLength(JSON.stringify(value), 'utf8');
        if (bytes > LIMITS.maxProposalBytes) {
          fail(ERROR_CODES.PAYLOAD_TOO_LARGE, `A stored proposal is limited to ${LIMITS.maxProposalBytes} bytes; this one is ${bytes}. The rationale, the citations and the action are each bounded in shape, and this is the bound on their total size -- including the agent review verdict stored beside them, which repeats what the proposal declared was missing.`, {
            max_proposal_bytes: LIMITS.maxProposalBytes,
            received_bytes: bytes,
          });
        }
      };
      refuseOversize(proposal);

      const review = await agentReview(owner, record, proposal, provenance);
      proposal.agent_review_at_submission = review;
      refuseOversize(proposal);

      const stored = await serialize(String(projectId), async () => {
        const current = projects.load(owner, projectId);
        // Still first, for the caller whose two attempts are genuinely
        // concurrent rather than sequential: the replay decided before the run
        // was resolved cannot see a record another caller is still storing.
        if (normalized.idempotency_key !== null) {
          const existing = proposalsOf(current).find(entry => entry.idempotency?.key === normalized.idempotency_key);
          if (existing) {
            if (existing.idempotency.request_fingerprint !== fingerprint) {
              fail(ERROR_CODES.IDEMPOTENCY_CONFLICT, 'This idempotency key is already bound to a different proposal payload. Use a new key, or resend the original payload.', {
                proposal_id: existing.proposal_id,
                bound_request_fingerprint: existing.idempotency.request_fingerprint,
                received_request_fingerprint: fingerprint,
              });
            }
            return { proposal: existing, replayed: true };
          }
        }
        // ── the binding must still be the binding.
        //
        // Everything this proposal is bound to was read before this lock, and
        // the policy verdict about to be returned was computed against it --
        // through the Canonical engines, which is not quick. A resume that
        // commits in that window leaves the record bound to a revision and a
        // request that have both moved, and the answer handed back still says
        // REQUIRES_EXPLICIT_ACCEPTANCE. The proposal is born stale and its own
        // response says otherwise, which is the one thing this protocol takes
        // care never to do; the very next read of it disagrees with the call
        // that created it.
        //
        // So it is re-read here, where it is cheap: no engine work, just the
        // record and a comparison of the binding against the one prepared.
        // Refused rather than stored-and-marked-stale, because the caller's
        // remedy is the same either way and a refusal cannot be misread.
        const currentRun = findRun(current, normalized.run_id);
        const stillOpen = requestsMatching(currentRun, normalized.request_key);
        if (stillOpen.length !== 1 || digestOf(bindingOf(currentRun, stillOpen[0], provenance)) !== digestOf(proposal.binding)) {
          fail(ERROR_CODES.RUN_CONFLICT, 'The run moved while this proposal was being prepared, so the request it answers is no longer the request it was written against. Re-read the run and submit against the request it is making now.', {
            run_id: currentRun.run_id,
            request_key: normalized.request_key,
            prepared_run_revision: proposal.binding.run_revision,
            current_run_revision: currentRun.revision,
            open_request_keys: openRequests(currentRun).map(entry => entry.request_key),
          });
        }

        // Two caps, and they mean different things.
        //
        // The open cap is the one a caller can act on, and counting only the
        // OPEN proposals is what makes its remedy true. It used to count every
        // proposal the project had ever held, so "resolve or withdraw one"
        // was a no-op: resolving removes nothing, and the project was locked
        // out of the protocol for good at 64. An adversarial pass followed the
        // instruction exactly and got the same refusal back.
        //
        // And the remedy is named only where it exists. A submitted proposal
        // can be rejected or withdrawn, and so can an accepted one none of
        // whose application attempts the run admitted, while no write the run
        // cannot attribute has landed on it since the acceptance
        // (`mayBeTakenBack`, the same check `resolve` makes). An accepted one
        // whose application may have reached the run cannot be: it leaves the
        // open set only when a retry of its acceptance completes. A project
        // whose open set was all of that last kind was still told to "resolve
        // or withdraw one", and every attempt to do so was refused.
        const open = proposalsOf(current).filter(entry => OPEN_PROPOSAL_STATES.includes(entry.state));
        if (open.length >= LIMITS.maxProposalsPerProject) {
          const freeable = open.filter(entry => entry.state === PROPOSAL_STATE.SUBMITTED
            || mayBeTakenBack(entry, runsOf(current).find(candidate => candidate.run_id === entry.run_id))).length;
          fail(ERROR_CODES.STORAGE_FULL, freeable
            ? `This project already holds the maximum of ${LIMITS.maxProposalsPerProject} open proposals. Resolve or withdraw one before submitting another: ${freeable} of them can be rejected or withdrawn now. An accepted proposal whose application may already have reached the run cannot be; it leaves the open set when a retry of its acceptance completes.`
            : `This project already holds the maximum of ${LIMITS.maxProposalsPerProject} open proposals, and none of them can be rejected or withdrawn: every one is an accepted proposal whose application may already have reached the run. Each leaves the open set only when a retry of its acceptance completes. If the run refuses those retries for good, continue in a new project, which leaves both records intact and separately citable.`, {
            max_open_proposals: LIMITS.maxProposalsPerProject,
            open_proposals: open.length,
            retained_proposals: proposalsOf(current).length,
            withdrawable_open_proposals: freeable,
            remedy: freeable ? 'resolveProposal with reject or withdraw' : 'resolveProposal with accept to retry an accepted proposal, or startRun in a new project',
          });
        }
        // The retention cap is the one nothing frees, because a resolved
        // proposal is an audit record and is never evicted. So it promises no
        // remedy: there is none but a new project, and saying otherwise would
        // repeat the mistake above.
        if (proposalsOf(current).length >= LIMITS.maxProposalsRetainedPerProject) {
          fail(ERROR_CODES.STORAGE_FULL, `This project has retained its lifetime maximum of ${LIMITS.maxProposalsRetainedPerProject} proposals. Resolved proposals are audit records and are not removed, so nothing frees a slot here; continue in a new project, which leaves both records intact and separately citable.`, {
            max_retained_proposals: LIMITS.maxProposalsRetainedPerProject,
            retained_proposals: proposalsOf(current).length,
            remedy: 'startRun in a new project',
          });
        }
        return { proposal: putProposal(owner, projectId, proposal), replayed: false };
      });

      const finalReview = stored.replayed ? await agentReview(owner, projects.load(owner, projectId), stored.proposal, provenance) : review;
      return Object.freeze({
        proposal: proposalView(stored.proposal, finalReview),
        replayed: stored.replayed,
        applied: false,
        notice: stored.replayed
          ? 'This idempotency key is already bound to this proposal and this payload, so nothing was stored again. The proposal is returned as it stands, with its verdict recomputed against what is stored now.'
          : 'Stored. Nothing was applied: no candidate was minted, no revision was taken, no confirmation was recorded, no gate moved and the run did not advance. An explicit acceptance is a separate call.',
      });
    },

    /** Read-only. The stored statement, with the policy's verdict recomputed. */
    async get(owner, projectId, proposalId) {
      const record = projects.load(owner, projectId);
      const proposal = findProposal(record, proposalId);
      const provenance = await canonical.provenance();
      return Object.freeze({
        project_id: record.project_id,
        proposal: proposalView(proposal, await agentReview(owner, record, proposal, provenance)),
        read_only: true,
        canonical: provenance,
      });
    },

    /** Read-only. This project's proposals, optionally narrowed. */
    async list(owner, projectId, input = {}) {
      const filter = closedObject(input ?? {}, 'list input', new Set(LIST_PROPOSALS_INPUT_KEYS));
      const record = projects.load(owner, projectId);
      const provenance = await canonical.provenance();
      const selected = proposalsOf(record).filter(entry => (
        (filter.run_id === undefined || filter.run_id === null || entry.run_id === filter.run_id)
        && (filter.request_key === undefined || filter.request_key === null || entry.binding.request_key === filter.request_key)
        && (filter.state === undefined || filter.state === null || entry.state === filter.state)
        && (filter.kind === undefined || filter.kind === null || entry.kind === filter.kind)
      ));
      return Object.freeze({
        project_id: record.project_id,
        proposals: Object.freeze(selected.map(proposalSummary)),
        read_only: true,
        canonical: provenance,
        separation_notice: PROPOSAL_SEPARATION_NOTICE,
      });
    },

    /**
     * Record an explicit acceptance, rejection or withdrawal.
     *
     * A rejection and a withdrawal are records and nothing more. An acceptance
     * is the one path that reaches an operation, and it reaches it through
     * `runs.resume` — the same public entry point a caller who never used a
     * proposal goes through, with the same lock, the same idempotency, the same
     * optimistic concurrency, the same per-step staleness re-validation and the
     * same interruption rules.
     */
    async resolve(owner, projectId, proposalId, input = {}) {
      const normalized = normalizeResolveInput(input);
      const provenance = await canonical.provenance();

      // ── phase 1: decide, under the lock.
      const prepared = await serialize(String(projectId), async () => {
        const record = projects.load(owner, projectId);
        const proposal = findProposal(record, proposalId);
        if (normalized.expected_proposal_revision !== null && normalized.expected_proposal_revision !== proposal.revision) {
          fail(ERROR_CODES.PROPOSAL_CONFLICT, 'The proposal has changed since the revision this call expected; re-read it before resolving.', {
            proposal_id: proposal.proposal_id, expected_proposal_revision: normalized.expected_proposal_revision, current_proposal_revision: proposal.revision,
          });
        }
        if (!OPEN_PROPOSAL_STATES.includes(proposal.state)) {
          fail(ERROR_CODES.PROPOSAL_CONFLICT, 'This proposal is already resolved. A resolved proposal is an audit record, not a workspace: submit a new proposal instead of re-resolving this one.', {
            proposal_id: proposal.proposal_id, state: proposal.state,
          });
        }
        // An accepted proposal whose application may already have reached the
        // run may only be carried forward to that application. Rejecting or
        // withdrawing it would leave the record disagreeing with what the run
        // may already have done.
        //
        // One whose application never reached the run is a different fact, and
        // it used to get the same answer. An acceptance whose translation
        // failed before `runs.resume` -- every time, for a proposal the
        // translation could never pass -- stayed `accepted` for good, could be
        // neither rejected nor withdrawn, and held an open-proposal slot; the
        // refusal's own reason ("may already have reached the run") was false.
        // `run_resume_called` is what tells the two apart (`mayHaveReachedRun`),
        // and it is set only when the run ADMITS an attempt, so an attempt the
        // run refused before writing anything does not count as one that
        // reached it.
        //
        // Race-free, and not by refusing while an attempt is in flight. This
        // check and the admission that sets the marker (phase 2, inside the
        // run's own first lock hold) take the same lock, and the admission
        // re-reads the proposal: if this withdrawal lands first, an in-flight
        // attempt finds the proposal withdrawn and the run refuses it before
        // writing anything; if the marker lands first, this is refused. A
        // durable "attempt open" marker was the alternative and is worse: an
        // attempt that dies leaves it open for good, and nothing durable can
        // tell that attempt from a live one.
        const supersedesAcceptance = proposal.state === PROPOSAL_STATE.ACCEPTED && normalized.resolution !== RESOLUTION.ACCEPT;
        if (supersedesAcceptance && mayHaveReachedRun(proposal)) {
          const recorded = proposal.application?.run_resume_called === true;
          fail(ERROR_CODES.PROPOSAL_CONFLICT, recorded
            ? 'This proposal was already accepted, and an attempt to apply it has handed its input to the run\'s resume path and been admitted by the run, so its application may already have reached the run. It cannot be rejected or withdrawn afterwards. Retry the acceptance to finish it: the retry re-issues the same idempotency key, so a run that applied it replays its own receipt. A proposal whose retries the run keeps refusing stays accepted, and open, as the record of an acceptance that could not be finished.'
            : 'This proposal was accepted before this service recorded whether an application attempt reached the run, so it cannot establish that none did: its application may already have reached the run. It cannot be rejected or withdrawn afterwards. Retry the acceptance to finish it: the retry re-issues the same idempotency key, so a run that applied it replays its own receipt. A proposal whose retries the run keeps refusing stays accepted, and open, as the record of an acceptance that could not be finished.', {
            proposal_id: proposal.proposal_id,
            state: proposal.state,
            // `null` is "not recorded", which is not the same as `false`.
            run_resume_called: recorded ? true : null,
            last_conflict_code: proposal.application?.conflict?.code ?? null,
            remedy: 'resolveProposal with accept, to retry the application',
          });
        }
        // The marker is this build's record. The release a documented rollback
        // returns to does not know it: its retry of an accepted proposal skips
        // the policy, is let into the run and writes to it, and records no
        // admission, so after rolling forward the marker still says `false`
        // with this acceptance's application on the run. Nothing on the run
        // names this acceptance on each of that build's writes, but the run
        // does record whether each revision's writer is known, and every write
        // that build makes records none. So an acceptance is taken back only
        // while no write the run cannot attribute has landed on it since the
        // acceptance observed it -- which also refuses after a reviewer's
        // resume through that build, since nothing can tell the two apart.
        if (supersedesAcceptance) {
          const unattributed = unattributedWriteSinceAcceptance(findRun(record, proposal.run_id), proposal.application);
          if (unattributed !== null) {
            fail(ERROR_CODES.PROPOSAL_CONFLICT, `This proposal was accepted, and since the acceptance the run has taken a write that does not record which request made it (revision ${unattributed}; the acceptance observed revision ${proposal.application?.expected_run_revision ?? 'unknown'}). A build that does not keep the run's record of its writers writes the run that way -- the release a documented rollback returns to -- and that build does not record whether the run admitted an attempt of this acceptance either: its retry of an accepted proposal reaches the run without recording it. So nothing here can establish that none of this acceptance's application reached the run, and its application may already have reached the run. It cannot be rejected or withdrawn afterwards. A retry goes through the Agent Review Policy again, which refuses it as STALE because the run has moved since the acceptance, so the proposal stays accepted, and open, as the record of an acceptance that could not be finished; the remedy is a fresh proposal against the request as it stands.`, {
              proposal_id: proposal.proposal_id,
              state: proposal.state,
              run_resume_called: false,
              run_revision_at_acceptance: proposal.application?.expected_run_revision ?? null,
              unattributed_run_revision: unattributed,
              last_conflict_code: proposal.application?.conflict?.code ?? null,
              remedy: 'proposeDecision against the request as it stands',
            });
          }
        }

        if (normalized.resolution !== RESOLUTION.ACCEPT) {
          const state = normalized.resolution === RESOLUTION.REJECT ? PROPOSAL_STATE.REJECTED : PROPOSAL_STATE.WITHDRAWN;
          return {
            proposal: bumpProposal(owner, projectId, proposal, {
              state,
              resolution: {
                resolution: normalized.resolution,
                resolved_by: owner,
                reason: normalized.reason,
                at: now(),
                // The acceptance this replaces stays on the record, beside the
                // application attempts it made and their conflicts, so a reader
                // sees that it was accepted and why it never applied.
                ...(supersedesAcceptance ? { superseded_acceptance: proposal.resolution } : {}),
              },
            }),
            accepted: false,
            supersededAcceptance: supersedesAcceptance,
          };
        }

        // ── the acceptance gate. Re-evaluated here, under the lock, against
        // what is stored now — never from the verdict recorded at submission.
        //
        // Skipped for a proposal that is ALREADY accepted and carries an
        // application marker, and the order matters for the same reason it
        // matters on a run resume: an acceptance is a recorded past act, and
        // what a retry has left to do is finish applying it. Re-running the
        // policy there would refuse the very retry the marker exists for —
        // a crash between the acceptance and its application advances the run,
        // which makes the proposal stale, which would leave it accepted and
        // permanently unfinishable.
        //
        // Nothing is being taken on trust. The retry re-issues the SAME
        // deterministic idempotency key, so a run that already applied it
        // replays its own receipt; and it carries, as its revision
        // precondition, either the run's current revision -- only when the
        // run's own record says its latest write was this application's (see
        // `continueFrom` below) -- or the revision the acceptance observed, so
        // a run that moved for any other reason fails the precondition and is
        // refused. Safety here is the run's, which is where it belongs.
        //
        // Skipped only when an earlier attempt may have reached the run,
        // though, because that is the whole reason for skipping it. An
        // acceptance none of whose attempts the run ever admitted -- whether
        // they failed before calling it or the run refused them before
        // writing anything -- has not moved the run through this build, so
        // the policy reads it exactly as it read the first acceptance, and a
        // retry of it is re-checked like one rather than carried past a policy
        // that would now refuse it. (If the release a rollback returns to
        // applied it without recording an admission, the run has moved since
        // the acceptance, and the policy refuses the retry as STALE.)
        const alreadyAccepted = proposal.state === PROPOSAL_STATE.ACCEPTED && proposal.application !== null;
        const review = alreadyAccepted && mayHaveReachedRun(proposal) ? null : await agentReview(owner, record, proposal, provenance);
        if (review && !review.acceptable) {
          fail(ERROR_CODES.PROPOSAL_REFUSED, 'The Agent Review Policy will not let this proposal reach an operation.', {
            proposal_id: proposal.proposal_id,
            agent_review: review,
            acceptable_verdict: ACCEPTABLE_AGENT_REVIEW,
          });
        }

        const run = findRun(record, proposal.run_id);
        // An acceptance that was already recorded keeps its marker, so a retry
        // re-issues the SAME idempotency key and the run replays its own
        // receipt instead of applying anything twice.
        const application = proposal.application ?? {
          idempotency_key: `proposal:${proposal.proposal_id}:${proposal.revision}`,
          expected_run_revision: run.revision,
          // Where the last admitted attempt that did not finish left the run:
          // the revision its OWN request last wrote, as the run reported it
          // under its lock (phase 3). A record of that attempt, never a
          // precondition: a retry continues from what the run's own record
          // says, below.
          run_revision_at_attempt: null,
          // Whether the run ever admitted an attempt: set inside the run's own
          // first lock hold, after its refusals and before its first write
          // (phase 2), and never cleared. While it is false, and no write the
          // run cannot attribute has landed since the acceptance
          // (`mayBeTakenBack`), the proposal may still be rejected or
          // withdrawn, because nothing of it reached the run.
          run_resume_called: false,
          // Which request the run admitted for this acceptance: the request
          // fingerprint the run computed, recorded by the first admission. The
          // run records the same value on every write that request makes, and
          // a retry must carry the same request.
          admitted_request_fingerprint: null,
          accepted_by: normalized.accepted_by,
          attempted_at: now(),
          run_revision_after: null,
          run_state_after: null,
          candidate_id_after: null,
          derived: {},
          conflict: null,
        };
        // Where a retry of an application the run has already admitted
        // continues from: the run's current revision, read here under the
        // lock -- when, and only when, the run's own record, written for that
        // revision, says its latest write was this application's
        // (`lastWrittenByThisApplication`).
        // Nothing else then has moved the run since this application last
        // wrote to it, whether the attempt that wrote it was interrupted by a
        // fault, stopped by a process that died inside the run and recorded
        // nothing, or interrupted for the second time. The run's precondition
        // re-checks it under the run's own lock, so a write landing between
        // here and there is refused, and the run's own reconciliation settles
        // any step the interrupted attempt left pending.
        //
        // Otherwise the retry carries the revision the acceptance observed.
        // Once the run admitted any attempt of it, that revision can match
        // only a run nothing has written to since -- an admission whose own
        // first write never landed -- and a run anyone else moved refuses it.
        // The revision an attempt observed afterwards is never used: it may be
        // another writer's, and carrying it was how a retry used to pass its
        // precondition against a borrowed revision and be recorded `applied`
        // after another actor had moved the run.
        const continueFrom = alreadyAccepted && proposal.application.run_resume_called === true
          && lastWrittenByThisApplication(run, proposal.application)
          ? run.revision
          : null;
        return {
          proposal: alreadyAccepted ? proposal : bumpProposal(owner, projectId, proposal, {
            state: PROPOSAL_STATE.ACCEPTED,
            resolution: { resolution: RESOLUTION.ACCEPT, resolved_by: owner, accepted_by: normalized.accepted_by, reason: normalized.reason, at: now() },
            application,
          }),
          accepted: true,
          retry: alreadyAccepted,
          continueFrom,
          review,
        };
      });

      if (!prepared.accepted) {
        const record = projects.load(owner, projectId);
        const rejected = prepared.proposal.state === PROPOSAL_STATE.REJECTED;
        return Object.freeze({
          proposal: proposalView(prepared.proposal, await agentReview(owner, record, prepared.proposal, provenance)),
          applied: false,
          run: null,
          notice: prepared.supersededAcceptance
            ? `${rejected ? 'Rejected' : 'Withdrawn'} after an acceptance whose application never reached the run: the run admitted no attempt of it, and every write the run has taken since the acceptance records which request made it, so nothing of this acceptance was applied and it did not advance the run. The acceptance stays on the record as resolution.superseded_acceptance, beside the application attempts it made.`
            : rejected
              ? 'Rejected. Nothing was applied and the run did not advance; the proposal stays on the record as what was proposed and refused.'
              : 'Withdrawn. Nothing was applied and the run did not advance.',
        });
      }

      // ── phase 2: reach the existing operation, WITHOUT the project lock.
      //
      // `runs.resume` takes the same per-project serializer itself, so holding
      // it here would deadlock by construction. Everything that makes crossing
      // this boundary safe — the deterministic key, the revision precondition —
      // was recorded under the lock in phase 1.
      const application = prepared.proposal.application;
      let resumed = null;
      let failure = null;
      let derived = {};
      // Whether THIS attempt called `runs.resume`, and whether the run
      // ADMITTED it -- took it past every refusal of its own, under its own
      // lock, before writing anything. Only an admitted attempt can have
      // changed the run. The record's `run_resume_called` says whether ANY
      // attempt was admitted.
      let calledRun = false;
      let admitted = false;
      // The last revision THIS attempt's own request wrote to the run, as the
      // run reported it under its lock (resume's `wrote`); null while it has
      // written none. Never read back from the run afterwards: by then another
      // writer may have moved it.
      let ownRevision = null;
      // The proposal as the admission found it, when a rejection or
      // withdrawal had landed first.
      let resolvedMeanwhile = null;
      try {
        const translated = await translate(owner, projectId, prepared.proposal, application.accepted_by);
        derived = translated.derived;

        calledRun = true;
        resumed = await runs.resume(owner, projectId, prepared.proposal.run_id, {
          ...translated.input,
          idempotency_key: application.idempotency_key,
          // The revision precondition MOVES on a retry; it is not dropped.
          //
          // `resume` bumps the run's revision in its own first lock hold,
          // before any step runs, and writes the idempotency receipt in a last
          // hold after every step has finished. So for the whole duration of an
          // advancement the run has moved and the key is unbound -- and a crash
          // in that window left a retry carrying the pre-bump revision, which
          // could then never match. The acceptance was recorded, the work may
          // well have landed, and the one mechanism built to finish it could
          // never succeed: the proposal was stuck `accepted` for good.
          //
          // Sending no precondition at all fixed that and opened a worse hole.
          // A retry whose application may have reached the run also skips the
          // policy gate, so an acceptance whose application was interrupted
          // became a standing permission: whatever the run had since become --
          // a different reviewer's decision set, a different candidate, a
          // request that was no longer open -- the retry reached `runs.resume`
          // anyway and the proposal was recorded `applied`, naming an
          // advancement it had not caused. (A retry none of whose attempts
          // the run admitted goes back through the policy; see phase 1.)
          //
          // So the precondition is carried forward instead, to where this
          // application's OWN request last left the run -- and it is taken from
          // the run's own record of which request made its latest write, read
          // under the lock in phase 1 (`continueFrom`), not from a revision an
          // attempt observed. A retry then finishes exactly the application it
          // is a retry of, and a run that moved for any other reason fails the
          // precondition -- which is what makes skipping the policy gate safe
          // rather than merely convenient.
          //
          // It used to be the revision phase 3 of the interrupted attempt read
          // from the run. That was wherever the run was when phase 3's hold ran:
          // a reviewer's resume queued behind the interrupted hold landed its
          // bump first, phase 3 pinned the reviewer's revision, and the retry
          // passed its precondition against it and was recorded `applied` after
          // another actor had moved the run. And a process that died inside the
          // run never ran phase 3 at all, so every retry carried the pre-bump
          // revision and was refused for good, accepted and not withdrawable.
          // The run's own record answers both: it is written with every
          // revision, by the request that wrote it. The receipt is still checked
          // first, so a run that did apply this replays it either way.
          expected_run_revision: prepared.continueFrom ?? application.expected_run_revision,
        }, {
          // ── the admission: inside the run's OWN first lock hold, after every
          // refusal that hold makes and before its first write.
          //
          // This is where `run_resume_called` is recorded, and never cleared.
          // It used to be recorded in a hold of this layer's own just BEFORE
          // the call, so an attempt the run then refused -- at its revision
          // precondition, say, because another application had moved the run
          // in between -- counted as one that had reached the run although it
          // had written nothing: phase 3 pinned the revision the OTHER
          // application left the run at, the retry skipped the policy on the
          // marker's word, passed its precondition against that borrowed
          // revision and moved the run. Recorded here instead, the marker is
          // written if and only if the run let the request in, and before the
          // run writes anything: an attempt refused anywhere above this point
          // leaves it as it was, and one that may change the run cannot change
          // it unmarked. A crash between this write and the run's own leaves a
          // marker for a write that never happened, which is the safe
          // direction. Nothing here classifies the run's errors, so a refusal
          // the run adds later is covered without being named.
          //
          // And it re-reads the proposal first. A rejection or withdrawal is
          // allowed only while the marker is unset and is decided under this
          // same lock, so if one landed after phase 1 the run is refused here,
          // before it writes anything, and this attempt says so; if the
          // admission lands first, the marker is set and every later rejection
          // or withdrawal is refused.
          //
          // It also records WHICH request the run let in: the request
          // fingerprint the run computed, which the run records as the writer
          // of every revision that request produces. The first admission
          // records it; every later attempt of this acceptance must carry the
          // same request, or it is not a retry of this application but another
          // request under the same key -- the plan the acceptance derives
          // moved in between, say -- and continuing a run whose latest write
          // was the first request with a second one is exactly what a retry
          // may not do. It is refused here, before the run writes anything.
          admit: ({ request_fingerprint: requestFingerprint = null } = {}) => {
            const current = findProposal(projects.load(owner, projectId), proposalId);
            if (current.state === PROPOSAL_STATE.WITHDRAWN || current.state === PROPOSAL_STATE.REJECTED) {
              resolvedMeanwhile = current;
              fail(ERROR_CODES.PROPOSAL_CONFLICT, `This proposal was ${current.state} while its acceptance was being applied, before the application reached the run. This attempt stopped there: nothing was applied and the run did not advance.`, {
                proposal_id: proposalId,
                proposal_state: current.state,
                run_resume_called: false,
              });
            }
            const admittedFingerprint = current.application?.admitted_request_fingerprint ?? null;
            if (admittedFingerprint !== null && admittedFingerprint !== requestFingerprint) {
              fail(ERROR_CODES.IDEMPOTENCY_CONFLICT, 'This attempt would hand the run a different request than the one the run admitted for this acceptance: the same idempotency key, another request. It is not a retry of that application, so the run admitted nothing of it and wrote nothing: the input this acceptance derives has moved since the run admitted it. A retry finishes the application only while it derives that same request; work the run can no longer take is answered by a fresh proposal against the request as it stands.', {
                proposal_id: proposalId,
                idempotency_key: current.application.idempotency_key,
                admitted_request_fingerprint: admittedFingerprint,
                received_request_fingerprint: requestFingerprint,
              });
            }
            if (current.application && (current.application.run_resume_called !== true || admittedFingerprint === null)) {
              bumpProposal(owner, projectId, current, {
                application: {
                  ...current.application,
                  ...(current.application.run_resume_called === true ? {} : { run_resume_called: true, run_resume_called_at: now() }),
                  admitted_request_fingerprint: requestFingerprint,
                },
              });
            }
            admitted = true;
          },
          // Where this attempt's own request has left the run, as the run
          // reports it after each of that request's writes, under its lock.
          wrote: revision => { ownRevision = revision; },
        });
      } catch (error) {
        // Stopped at the run's door by a rejection or withdrawal. That is the
        // record now, and this attempt, which reached nothing, adds nothing
        // to it.
        if (resolvedMeanwhile) throw error;
        failure = { code: error?.code ?? ERROR_CODES.INVALID_REQUEST, message: String(error?.message ?? error).slice(0, 500), details: error?.details ?? {} };
      }

      // ── phase 3: record what happened, under the lock again.
      const settled = await serialize(String(projectId), async () => {
        const record = projects.load(owner, projectId);
        const proposal = findProposal(record, proposalId);
        if (failure) {
          // A rejection or withdrawal can have landed while this attempt was
          // failing -- only one that the run never admitted, since admission
          // sets `run_resume_called` first and that refuses both. It is the
          // record now, and a failure that reached nothing is not written over
          // it.
          if (proposal.state === PROPOSAL_STATE.WITHDRAWN || proposal.state === PROPOSAL_STATE.REJECTED) return proposal;

          // The acceptance stands and the application did not complete. The
          // proposal stays `accepted` so a retry re-issues the same key rather
          // than starting a second application, and the conflict is recorded
          // rather than swallowed.
          //
          // Where this attempt's own application left the run is recorded with
          // it, as `run_revision_at_attempt`: the last revision THIS attempt's
          // request wrote, as the run reported it under its own lock right
          // after each of that request's writes (resume's `wrote`). It is a
          // record of the attempt and nothing a retry is held to: a retry
          // continues only from what the run's own record says about its
          // latest write (phase 1, `continueFrom`).
          //
          // It is never the revision the run is at now, read here. By the time
          // this hold runs another writer may have moved the run -- a
          // reviewer's resume queued behind the interrupted hold lands its bump
          // first -- and that revision is the reviewer's. It used to be pinned
          // all the same, and it used to be the retry's precondition: the retry
          // passed against the reviewer's revision and was recorded `applied`
          // after another actor had moved the run.
          //
          // Nor is it written by an attempt that wrote nothing to the run: one
          // that failed before `runs.resume`, in the translation; one the run
          // refused before admitting it, at its revision precondition because
          // another application -- or another attempt of this same acceptance
          // -- had moved the run first; one admitted and stopped before its
          // first write. Such an attempt left the run nowhere, so the revision
          // the run happens to be at is no fact about it, and the record keeps
          // what an attempt that did write left there. A later attempt that
          // writes and does not finish records where IT left the run.
          return bumpProposal(owner, projectId, proposal, {
            application: {
              ...proposal.application,
              // Whether the run let this attempt in at all, beside what it
              // answered: a refusal before admission changed nothing.
              conflict: { ...failure, admitted_by_run: admitted, at: now() },
              derived,
              run_revision_at_attempt: ownRevision ?? proposal.application.run_revision_at_attempt ?? null,
            },
          });
        }
        return bumpProposal(owner, projectId, proposal, {
          state: PROPOSAL_STATE.APPLIED,
          application: {
            ...proposal.application,
            applied_at: now(),
            conflict: null,
            derived,
            run_revision_after: resumed.run.revision,
            run_state_after: resumed.run.state,
            candidate_id_after: resumed.run.candidate_id ?? null,
            replayed: resumed.replayed === true,
            // Whether this acceptance completed on its first attempt or on a
            // retry after an interruption. A reader of the record should not
            // have to infer which from a timestamp.
            settled_on_retry: prepared.retry === true,
          },
        });
      });

      if (failure) {
        // Which of these happened, because they have different remedies and
        // one notice for all of them told most of them something false.
        const neverAdmitted = settled.application?.run_resume_called === false;
        // How this attempt stopped short of the run, when it did.
        const shortOfTheRun = calledRun
          ? 'the run refused this attempt before admitting it: the request was turned away, under the run\'s lock, before the run wrote anything'
          : 'this attempt failed before handing the input to the run\'s resume path';
        // What a retry of an application that may have reached the run does.
        const retryNotice = 'Retrying re-issues the same idempotency key, so a run that did apply it replays its own receipt instead of applying it again. A retry continues the application only while the run\'s own record says its latest write was this application\'s, and the run\'s own reconciliation then settles any step it left pending; once another writer has moved the run, the retry is refused as a run conflict and this layer does not guess.';
        fail(failure.code, failure.message, {
          ...failure.details,
          proposal_id: proposalId,
          proposal_state: settled.state,
          run_resume_called: settled.application?.run_resume_called ?? null,
          // Whether the run let THIS attempt in; `run_resume_called` is
          // whether it let any attempt in.
          admitted_by_run: admitted,
          notice: admitted
            ? `The acceptance is recorded and the existing operation refused or could not run. Nothing was applied twice. ${retryNotice}`
            : settled.state === PROPOSAL_STATE.WITHDRAWN || settled.state === PROPOSAL_STATE.REJECTED
              ? `The acceptance's application stopped before it reached the run, and the proposal was ${settled.state} meanwhile. Nothing was applied and the run did not advance.`
              : neverAdmitted
                ? `The acceptance is recorded, and its application stopped before it reached the run: ${shortOfTheRun}, and the run has admitted no attempt of it, so nothing was applied and the run did not advance. A retry re-checks the proposal against the Agent Review Policy before trying again; it can also still be rejected or withdrawn, because nothing reached the run.`
                : `This attempt stopped before it reached the run: ${shortOfTheRun}. ${settled.application?.run_resume_called === true
                  ? 'Another attempt was admitted into the run'
                  : 'This acceptance was recorded before this service kept track of whether an attempt reached the run'}, so its application may already have landed, and the proposal cannot be rejected or withdrawn. ${retryNotice}`,
        });
      }

      const record = projects.load(owner, projectId);
      return Object.freeze({
        proposal: proposalView(settled, await agentReview(owner, record, settled, provenance)),
        applied: true,
        // The run's own answer, unchanged. Whether the operation succeeded,
        // what it produced and which gates moved are its words, not this
        // layer's, and an applied proposal certifies none of them.
        run: resumed.run,
        replayed: resumed.replayed === true,
        notice: 'The acceptance was recorded and the existing run resume path was called with the input this proposal prepared. An applied proposal is not a succeeded operation, not a gate result and not a song state: read the run\'s own steps, blockers, gates and review requests for those. in_game is unchanged and stays PENDING.',
      });
    },
  });
}
