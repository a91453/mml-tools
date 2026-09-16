// Accepted arrangement decisions for Studio Web (G11-D integration).
//
// The minimum a browser needs that a Node process does not: somewhere to keep
// the decisions a reviewer has accepted, a way to fill in the bindings those
// decisions must carry, and a derivation that cannot outlive the inputs it came
// from. All the arrangement logic lives in the backend module; nothing here
// decides anything about roles, evidence or acceptance.
//
// Five separations are load-bearing and are not conveniences:
//
//   * a decision record is not an application. Records are persisted; the
//     applied candidate is re-derived from the current source project on every
//     analysis, so what is on screen belongs to the bytes that are loaded now;
//   * the acceptance bindings are computed here from the *current* baseline and
//     the *current* lane decomposition. A caller cannot supply them, so a
//     caller cannot make a decision look fresh;
//   * a record is bound to the workspace revision it was accepted at. A
//     revision bump drops it, exactly as it drops a harmony decision, a Core3
//     approval or Lead evidence;
//   * a revision chain is re-derived, never stored. Revision N's parent is the
//     application this analysis just produced for revision N-1 -- not a
//     candidate read back from storage, not one an import claims. A stored or
//     imported "parent" therefore has no path into the backend's parent slot;
//   * a persisted application, if a restored or imported record still carries
//     one, is data. It is reported against its binding and discarded, never
//     displayed as current and never able to hand a gate a result.
//
// Two revision namespaces meet here and are never confused:
//
//   workspace.revision      an integer the Web model bumps on every source or
//                           settings change (`invalidate`). It scopes which
//                           stored records are even considered.
//   G11-D revision id       `g11d:rev:<sha256>`, content-addressed by the
//                           backend over baseline, parent, decisions, Canonical
//                           release, lanes and the candidate. It is what a
//                           decision's `reviewedRevisionId` names, and what the
//                           chain below is made of.
//
// It is deliberately free of DOM and Node APIs: it runs unchanged inside the
// analysis Worker and inside `node --test`.

import {
  applyAcceptedArrangement,
  createAcceptedDecision,
  baselineIdentityOf,
  contentDigest,
  laneDecompositionDigestOf,
} from '../backend/arrangement/decision-application.mjs';
import { canonicalIdentity } from '../backend/final/emitter-contract.mjs';

export const ACCEPTED_DECISION_RECORD_SCHEMA = 'mml-studio-web/accepted-arrangement-decision@2';

// What a decision record's integrity does and does not establish, as data.
//
//   recordEnvelope   CONTENT_ADDRESSED_SELF_CONSISTENCY: `recordDigest` is a
//                    SHA-256 over every field of the record -- schema, pipeline,
//                    workspace revision and the whole normalized decision
//                    including its acceptance block. Any single edit to any of
//                    them leaves a record that no longer agrees with itself.
//   bindings         RE_DERIVED_AT_APPLICATION: the baseline content digest,
//                    source identity digest, lane decomposition digest,
//                    Canonical rules snapshot and reviewed revision are checked
//                    by the backend against what is loaded now, every time.
//                    A record that agrees with itself and names other inputs
//                    is still refused.
//   authorship       NOT_AUTHENTICATED: `acceptedBy` and `note` are assertions.
//                    Nothing here proves who wrote a record. A digest beside
//                    mutable data is not a signature: anyone who can rewrite
//                    the record can rewrite the digest. Authenticated
//                    authorship needs a trust root (a signer, a key, a
//                    verifier) that this product does not have and this change
//                    does not invent.
export const ACCEPTED_DECISION_AUTHORSHIP = 'NOT_AUTHENTICATED';
export const ACCEPTED_DECISION_INTEGRITY = Object.freeze({
  recordEnvelope: 'CONTENT_ADDRESSED_SELF_CONSISTENCY',
  bindings: 'RE_DERIVED_AT_APPLICATION',
  authorship: ACCEPTED_DECISION_AUTHORSHIP,
  notice: 'Tamper-evident and self-consistent is not authenticated. The record digest detects an edited, stale or partially rewritten stored record; the bindings refuse a record that names inputs other than the ones loaded; neither proves who accepted the decision.',
});
export const ACCEPTED_ARRANGEMENT_SCHEMA = 'mml-studio-web/accepted-arrangement@1';

// The derivation identity a stored application is bound to. Bump it whenever
// the derivation changes shape, so a restored record shows as stale instead of
// presenting an old reading as current.
export const ACCEPTED_ARRANGEMENT_PIPELINE = 'studio-web/accepted-arrangement@2';

// How a chain relates to storage, stated as data so no reader has to infer it.
export const PARENT_MODEL = 'RE_DERIVED_NEVER_STORED';

// An implementation guard, not a Canonical rule. A decision set large enough to
// need paging is a workflow this integration has not designed.
export const MAX_ACCEPTED_DECISIONS = 500;

/**
 * The bindings an accepted decision must carry, computed from what is loaded
 * right now.
 *
 * A UI fills an acceptance block from this. It is deliberately not something a
 * caller may pass in: an identity a caller can supply is an identity a caller
 * can make stale-proof, which is the whole thing the bindings exist to prevent.
 */
export function acceptedDecisionBindings({ project, suggestion, reviewedRevisionId = null }) {
  const identity = baselineIdentityOf(project);
  return {
    state: 'ACCEPTED',
    reviewedRevisionId,
    baselineContentDigest: identity.contentDigest,
    sourceIdentityDigest: identity.sourceIdentityDigest,
    laneDecompositionDigest: laneDecompositionDigestOf(suggestion ?? null),
    canonicalRulesSnapshotSha: canonicalIdentity().rules_snapshot_sha,
  };
}

const bindingMismatches = (acceptance, expected) => {
  const reasons = [];
  if (acceptance.reviewedRevisionId !== expected.reviewedRevisionId) reasons.push('DECISION_REVISION_BINDING_MISMATCH');
  if (acceptance.baselineContentDigest !== expected.baselineContentDigest) reasons.push('DECISION_BASELINE_BINDING_MISMATCH');
  if (acceptance.sourceIdentityDigest !== expected.sourceIdentityDigest) reasons.push('DECISION_SOURCE_BINDING_MISMATCH');
  if (acceptance.laneDecompositionDigest !== expected.laneDecompositionDigest) reasons.push('DECISION_LANE_BINDING_MISMATCH');
  if (acceptance.canonicalRulesSnapshotSha !== expected.canonicalRulesSnapshotSha) reasons.push('DECISION_CANONICAL_BINDING_MISMATCH');
  return reasons;
};

/**
 * Validate one accepted decision against what is loaded, and return the record
 * to persist.
 *
 * Fails at record time as well as at apply time. Both checks are real: this one
 * keeps an unusable decision out of the workspace, and the backend's keeps a
 * persisted one from being replayed after the inputs move.
 */
export function buildAcceptedDecisionRecord({ project, suggestion, revision, reviewedRevisionId = null, decision }) {
  const normalized = createAcceptedDecision(decision);
  const expected = acceptedDecisionBindings({ project, suggestion, reviewedRevisionId });
  const reasons = bindingMismatches(normalized.acceptance, expected);
  if (reasons.length) throw Error(`STALE_ACCEPTED_DECISION: ${reasons.join(', ')}`);
  const envelope = { schema: ACCEPTED_DECISION_RECORD_SCHEMA, pipeline: ACCEPTED_ARRANGEMENT_PIPELINE, revision, decision: JSON.parse(JSON.stringify(normalized)) };
  return { ...envelope, recordDigest: acceptedDecisionRecordDigest(envelope) };
}

// Self-consistency, deliberately not authentication.
//
// The digest is taken over the *whole* record: schema, pipeline, the workspace
// revision it was accepted at, and the decision exactly as the backend
// constructor normalizes it -- type, target, roles, section, reason, evidence,
// Lead evidence, metadata, and the acceptance block with every binding, the
// reviewed revision, `acceptedBy` and `note`. There is no field a stored
// record can change and still agree with its own digest, and no field whose
// digest can be recomputed on its own after another field moved.
//
// It does not, and cannot, prove who wrote the record: anyone who can rewrite
// the stored record can rewrite the digest beside it. What actually fails
// closed against a hostile or stale workspace is the binding to the baseline
// content, the source identity, the reviewed revision and the Canonical rules
// snapshot, none of which the workspace gets to choose. See
// ACCEPTED_DECISION_INTEGRITY.
export function acceptedDecisionRecordDigest({ schema, pipeline, revision, decision }) {
  const normalized = createAcceptedDecision(decision);
  return contentDigest({ schema, pipeline, revision, decision: JSON.parse(JSON.stringify(normalized)) });
}

/**
 * Classify one stored record. Three separate answers, never one flag:
 *
 *   structural                 the record has the shape this pipeline writes and
 *                              its decision constructs
 *   envelope                   the record agrees with its own recordDigest
 *   workspaceRevisionCurrent   it was accepted at the workspace revision that is
 *                              loaded now
 *
 * plus `authorship`, which is always NOT_AUTHENTICATED. The bindings are not
 * classified here because they are not this layer's to answer: the backend
 * re-derives them at application time against the inputs that are loaded.
 */
export function decisionRecordIntegrity(record, revision) {
  const reasons = [];
  let structural = false;
  let envelope = false;
  if (!record || typeof record !== 'object' || Array.isArray(record)) reasons.push('DECISION_RECORD_MALFORMED');
  else if (record.schema !== ACCEPTED_DECISION_RECORD_SCHEMA) reasons.push('DECISION_RECORD_SCHEMA_UNSUPPORTED');
  else if (record.pipeline !== ACCEPTED_ARRANGEMENT_PIPELINE) reasons.push('DECISION_RECORD_PIPELINE_VERSION_CHANGED');
  else if (!record.decision) reasons.push('DECISION_RECORD_EMPTY');
  else {
    try {
      const digest = acceptedDecisionRecordDigest(record);
      structural = true;
      if (typeof record.recordDigest !== 'string' || record.recordDigest !== digest) reasons.push('DECISION_RECORD_DIGEST_MISMATCH');
      else envelope = true;
    } catch (error) { reasons.push(`DECISION_RECORD_MALFORMED: ${error.message}`); }
  }
  const workspaceRevisionCurrent = Boolean(record) && typeof record === 'object' && record.revision === revision;
  if (structural && !workspaceRevisionCurrent) reasons.push('DECISION_RECORD_WORKSPACE_REVISION_MISMATCH');
  return {
    structural,
    envelope,
    workspaceRevisionCurrent,
    authorship: ACCEPTED_DECISION_AUTHORSHIP,
    usable: structural && envelope && workspaceRevisionCurrent,
    reasons,
  };
}

/**
 * The decision records that belong to this workspace revision.
 *
 * Returns the decisions and, separately, the records that cannot be used at
 * this revision. A record that is malformed, carries an unsupported schema or
 * pipeline, or does not agree with its own digest is `invalid`; one that is
 * sound but was accepted at another workspace revision is `ignored`. Nothing is
 * silently skipped: the two lists are reported beside the derivation.
 */
export function acceptedDecisionsAt(records, revision) {
  const decisions = [];
  const invalid = [];
  const ignored = [];
  for (const record of Array.isArray(records) ? records : []) {
    const integrity = decisionRecordIntegrity(record, revision);
    const id = record?.decision?.id ?? null;
    if (!integrity.structural || !integrity.envelope) {
      invalid.push({ id, reason: integrity.reasons[0], integrity });
      continue;
    }
    if (!integrity.workspaceRevisionCurrent) {
      ignored.push({ id, revision: record.revision ?? null, reason: 'DECISION_RECORD_WORKSPACE_REVISION_MISMATCH' });
      continue;
    }
    decisions.push(record.decision);
  }
  return { decisions, invalid, ignored };
}

const resultShape = (project, sourceSha256, revision, fields) => ({
  schema: ACCEPTED_ARRANGEMENT_SCHEMA,
  pipeline: ACCEPTED_ARRANGEMENT_PIPELINE,
  stage: 'G11-D',
  stageKind: 'ACCEPTED_ARRANGEMENT_APPLICATION',
  parentModel: PARENT_MODEL,
  integrity: ACCEPTED_DECISION_INTEGRITY,
  ...fields,
  derivation: derivation(project, sourceSha256, revision, fields.chain ?? []),
});

const stepSummary = (index, reviewedRevisionId, decisionIds, application) => ({
  index,
  reviewedRevisionId,
  decisionIds: [...decisionIds].sort(),
  status: application.status,
  revisionId: application.revision?.id ?? null,
  candidateDigest: application.revision?.candidateDigest ?? null,
  parentRevisionId: application.revision?.parentRevisionId ?? null,
  rejectedCodes: [...new Set(application.rejected.map(item => item.code))].sort(),
});

/**
 * Re-derive the accepted arrangement chain from the source project that is
 * loaded now.
 *
 * Never restores a stored candidate. Every decision goes back through the
 * backend constructor and every binding is re-checked there, so a record that
 * survived in storage across a source change is refused rather than replayed.
 *
 * Chaining. Records are grouped by the G11-D revision each one says it was
 * reviewed against. The group reviewed against the Source-Faithful Baseline
 * (`reviewedRevisionId === null`) is applied first; if that application passes,
 * the group reviewed against *that* revision's id is applied onto it as
 * revision 2, and so on. The parent handed to the backend at every step is the
 * application this call produced one step earlier -- a candidate the backend
 * itself just built, whose revision id it just computed -- so there is nothing
 * a stored or imported parent could stand in for. The backend still verifies
 * the parent (identity recompute, candidate digest, baseline and Canonical
 * identity) on every step, because that check is its own and is not skipped
 * on the strength of where the parent came from.
 *
 * Any record whose reviewed revision is not the head the chain actually
 * reached -- an edited id, a sibling revision produced by a different decision
 * set, a revision that stopped existing when an earlier step's decisions
 * changed -- is applied as the next step against the verified head and refused
 * there by the backend's own `STALE_DECISION_REVISION_MISMATCH`. The chain is
 * linear and fails closed: a step that does not PASS ends it, and every later
 * record is reported as stale rather than applied against something else.
 */
export function deriveAcceptedArrangement({ project, suggestion, records, revision, sourceSha256 = null }) {
  const { decisions, invalid, ignored } = acceptedDecisionsAt(records, revision);
  if (invalid.length) {
    return resultShape(project, sourceSha256, revision, {
      status: 'FAIL',
      decisionCount: decisions.length + invalid.length,
      invalidRecords: invalid,
      ignoredRecords: ignored,
      chain: [],
      head: null,
      application: null,
      notice: 'A stored accepted-decision record does not agree with itself. Nothing was applied: re-accept the decision against the source that is loaded now.',
    });
  }
  if (!decisions.length) {
    return resultShape(project, sourceSha256, revision, {
      status: 'NOT_REQUESTED',
      decisionCount: 0,
      invalidRecords: [],
      ignoredRecords: ignored,
      chain: [],
      head: null,
      application: null,
      notice: 'No accepted arrangement decision is recorded at this revision. The G11-C suggestion remains a suggestion.',
    });
  }
  if (decisions.length > MAX_ACCEPTED_DECISIONS) throw Error(`UNSUPPORTED: ${decisions.length} accepted decisions; the local limit is ${MAX_ACCEPTED_DECISIONS}`);

  // Group by the revision each decision was reviewed against. The key is the
  // decision's own claim; whether that claim names the verified head is decided
  // by the backend when the group is applied.
  const groups = new Map();
  for (const decision of decisions) {
    const key = decision.acceptance?.reviewedRevisionId ?? null;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(decision);
  }

  const chain = [];
  let parent = null;
  let headId = null;
  let application = null;
  const applyStep = (group, reviewedRevisionId) => {
    application = applyAcceptedArrangement({
      baseline: project,
      suggestion: suggestion ?? null,
      parent,
      decisions: group,
      canonicalIdentity: canonicalIdentity(),
    });
    chain.push(stepSummary(chain.length + 1, reviewedRevisionId, group.map(item => item.id), application));
    return application.status === 'PASS';
  };

  // Walk the chain from the baseline. Each PASS step becomes the next parent.
  while (groups.has(headId)) {
    const group = groups.get(headId);
    groups.delete(headId);
    if (!applyStep(group, headId)) break;
    parent = { revision: application.revision, candidate: application.candidate };
    headId = application.revision.id;
  }

  // Whatever is left claims a revision the chain never reached. It is applied
  // against the verified head exactly so that the backend refuses it with its
  // own stale-revision code, and the chain records why it ends here.
  if (groups.size && (application === null || application.status === 'PASS')) {
    const remaining = [...groups.values()].flat();
    applyStep(remaining, headId);
  }

  const head = parent ? { revisionId: parent.revision.id, index: parent.revision.index, candidateDigest: parent.revision.candidateDigest } : null;
  const orphaned = [...groups.keys()];
  return resultShape(project, sourceSha256, revision, {
    status: application.status,
    decisionCount: decisions.length,
    invalidRecords: [],
    ignoredRecords: ignored,
    chain,
    head,
    // The last application attempted: the head when the whole chain passed,
    // otherwise the step that ended it, with the backend's own rejections.
    application,
    staleRevisionClaims: orphaned,
    notice: application.status === 'PASS'
      ? 'An accepted-decision revision chain over a Source-Faithful Baseline, re-derived from stored records; no parent, candidate or revision was read from storage. It changes no source project and certifies no ACCEPTANCE_CRITERIA.md gate: the candidate must still pass the existing readiness pipeline.'
      : 'The accepted-decision revision chain did not fully apply. The steps that passed are listed in `chain`; the step that ended it carries the backend\'s own rejections in `application`. Nothing past that step was applied against anything.',
  });
}

/**
 * The verified chain head a new decision must be reviewed against.
 *
 * `null` when no revision has been derived yet (the decision is reviewed against
 * the Source-Faithful Baseline). A chain whose latest step did not PASS still
 * has the head it last reached: a new decision may join the failing step, but
 * cannot claim a revision that does not exist.
 */
export function acceptedRevisionHead(derived) {
  return derived?.head?.revisionId ?? null;
}

function derivation(project, sourceSha256, revision, chain) {
  const identity = baselineIdentityOf(project);
  const passed = chain.filter(step => step.status === 'PASS');
  return {
    sourceSha256: sourceSha256 ?? null,
    projectId: project.id ?? null,
    revision,
    baselineContentDigest: identity.contentDigest,
    eventCount: identity.eventCount,
    chainLength: passed.length,
    headRevisionId: passed.at(-1)?.revisionId ?? null,
  };
}

/**
 * Whether a stored accepted-arrangement record describes what is loaded now.
 *
 * Nothing in this integration persists an application -- it is re-derived on
 * every analysis -- so this exists for the other direction: a restored or
 * imported record may still carry one. Such a record is data, and this is what
 * lets the reader be told so instead of being shown it.
 */
export function acceptedArrangementBinding({ stored, project, revision, sourceSha256 = null, derived = null }) {
  if (!stored) return { current: false, reasons: ['ACCEPTED_ARRANGEMENT_MISSING'] };
  const reasons = [];
  if (stored.pipeline !== ACCEPTED_ARRANGEMENT_PIPELINE) reasons.push('ACCEPTED_ARRANGEMENT_PIPELINE_VERSION_CHANGED');
  const current = derived?.derivation ?? derivation(project, sourceSha256, revision, []);
  if (stored.derivation?.sourceSha256 !== current.sourceSha256) reasons.push('ACCEPTED_ARRANGEMENT_SOURCE_BYTES_CHANGED');
  if (stored.derivation?.projectId !== current.projectId) reasons.push('ACCEPTED_ARRANGEMENT_PROJECT_CHANGED');
  if (stored.derivation?.revision !== current.revision) reasons.push('ACCEPTED_ARRANGEMENT_REVISION_CHANGED');
  if (stored.derivation?.baselineContentDigest !== current.baselineContentDigest) reasons.push('ACCEPTED_ARRANGEMENT_BASELINE_CHANGED');
  // The head a stored record claims is compared with the head this analysis
  // re-derived. A claim is all it is: nothing from the stored record becomes
  // the parent of anything.
  if (derived && (stored.derivation?.headRevisionId ?? null) !== (current.headRevisionId ?? null)) reasons.push('ACCEPTED_ARRANGEMENT_HEAD_CHANGED');
  // A stored status is never read as a result, only reported as a claim.
  return { current: reasons.length === 0, reasons, claimedStatus: stored.status ?? null, claimedHeadRevisionId: stored.derivation?.headRevisionId ?? null };
}
