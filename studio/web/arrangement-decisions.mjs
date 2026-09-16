// Accepted arrangement decisions for Studio Web (G11-D integration).
//
// The minimum a browser needs that a Node process does not: somewhere to keep
// the decisions a reviewer has accepted, a way to fill in the bindings those
// decisions must carry, and a derivation that cannot outlive the inputs it came
// from. All the arrangement logic lives in the backend module; nothing here
// decides anything about roles, evidence or acceptance.
//
// Four separations are load-bearing and are not conveniences:
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
//   * a persisted application, if a restored or imported record still carries
//     one, is data. It is reported against its binding and discarded, never
//     displayed as current and never able to hand a gate a result.
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

export const ACCEPTED_DECISION_RECORD_SCHEMA = 'mml-studio-web/accepted-arrangement-decision@1';
export const ACCEPTED_ARRANGEMENT_SCHEMA = 'mml-studio-web/accepted-arrangement@1';

// The derivation identity a stored application is bound to. Bump it whenever
// the derivation changes shape, so a restored record shows as stale instead of
// presenting an old reading as current.
export const ACCEPTED_ARRANGEMENT_PIPELINE = 'studio-web/accepted-arrangement@1';

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
  return {
    schema: ACCEPTED_DECISION_RECORD_SCHEMA,
    revision,
    contentDigest: decisionContentDigest(normalized),
    decision: JSON.parse(JSON.stringify(normalized)),
  };
}

// Self-consistency, deliberately not authentication.
//
// The digest covers what the decision *does* -- its type, target, roles,
// section, reason and evidence -- separately from the acceptance block that says
// what it was reviewed against. A record whose body was edited in storage no
// longer agrees with its own digest and is refused rather than replayed.
//
// It does not, and cannot, prove who wrote the record: anyone who can rewrite
// the stored decision can rewrite the digest beside it. What actually fails
// closed against a hostile or stale workspace is the binding to the baseline
// content, the source identity, the reviewed revision and the Canonical rules
// snapshot, none of which the workspace gets to choose.
export function decisionContentDigest(normalizedDecision) {
  const { acceptance, ...body } = normalizedDecision;
  return contentDigest(body);
}

/**
 * The decision records that belong to this workspace revision.
 *
 * Returns the decisions and, separately, the records that claim this revision
 * but cannot be used. A record is never silently skipped.
 */
export function acceptedDecisionsAt(records, revision) {
  const decisions = [];
  const invalid = [];
  for (const record of Array.isArray(records) ? records : []) {
    if (record?.schema !== ACCEPTED_DECISION_RECORD_SCHEMA || record.revision !== revision) continue;
    if (!record.decision) { invalid.push({ id: null, reason: 'DECISION_RECORD_EMPTY' }); continue; }
    let normalized;
    try { normalized = createAcceptedDecision(record.decision); }
    catch (error) { invalid.push({ id: record.decision.id ?? null, reason: `DECISION_RECORD_MALFORMED: ${error.message}` }); continue; }
    if (record.contentDigest !== decisionContentDigest(normalized)) {
      invalid.push({ id: normalized.id, reason: 'DECISION_RECORD_CONTENT_DIGEST_MISMATCH' });
      continue;
    }
    decisions.push(record.decision);
  }
  return { decisions, invalid };
}

/**
 * Re-derive the accepted arrangement from the source project that is loaded now.
 *
 * Never restores a stored candidate. Every decision goes back through the
 * backend constructor and every binding is re-checked there, so a record that
 * survived in storage across a source change is refused rather than replayed.
 */
export function deriveAcceptedArrangement({ project, suggestion, records, revision, parent = null, sourceSha256 = null }) {
  const { decisions, invalid } = acceptedDecisionsAt(records, revision);
  if (invalid.length) {
    return {
      schema: ACCEPTED_ARRANGEMENT_SCHEMA,
      pipeline: ACCEPTED_ARRANGEMENT_PIPELINE,
      stage: 'G11-D',
      stageKind: 'ACCEPTED_ARRANGEMENT_APPLICATION',
      status: 'FAIL',
      decisionCount: decisions.length + invalid.length,
      invalidRecords: invalid,
      derivation: derivation(project, sourceSha256, revision),
      application: null,
      notice: 'A stored accepted-decision record does not agree with itself. Nothing was applied: re-accept the decision against the source that is loaded now.',
    };
  }
  if (!decisions.length) {
    return {
      schema: ACCEPTED_ARRANGEMENT_SCHEMA,
      pipeline: ACCEPTED_ARRANGEMENT_PIPELINE,
      stage: 'G11-D',
      stageKind: 'ACCEPTED_ARRANGEMENT_APPLICATION',
      status: 'NOT_REQUESTED',
      decisionCount: 0,
      invalidRecords: [],
      derivation: derivation(project, sourceSha256, revision),
      application: null,
      notice: 'No accepted arrangement decision is recorded at this revision. The G11-C suggestion remains a suggestion.',
    };
  }
  if (decisions.length > MAX_ACCEPTED_DECISIONS) throw Error(`UNSUPPORTED: ${decisions.length} accepted decisions; the local limit is ${MAX_ACCEPTED_DECISIONS}`);

  const application = applyAcceptedArrangement({
    baseline: project,
    suggestion: suggestion ?? null,
    parent,
    decisions,
    canonicalIdentity: canonicalIdentity(),
  });
  return {
    schema: ACCEPTED_ARRANGEMENT_SCHEMA,
    pipeline: ACCEPTED_ARRANGEMENT_PIPELINE,
    stage: 'G11-D',
    stageKind: 'ACCEPTED_ARRANGEMENT_APPLICATION',
    status: application.status,
    decisionCount: decisions.length,
    invalidRecords: [],
    derivation: derivation(project, sourceSha256, revision),
    application,
    notice: 'An accepted-decision application over a Source-Faithful Baseline. It changes no source project and certifies no ACCEPTANCE_CRITERIA.md gate: the candidate must still pass the existing readiness pipeline.',
  };
}

function derivation(project, sourceSha256, revision) {
  const identity = baselineIdentityOf(project);
  return {
    sourceSha256: sourceSha256 ?? null,
    projectId: project.id ?? null,
    revision,
    baselineContentDigest: identity.contentDigest,
    eventCount: identity.eventCount,
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
export function acceptedArrangementBinding({ stored, project, revision, sourceSha256 = null }) {
  if (!stored) return { current: false, reasons: ['ACCEPTED_ARRANGEMENT_MISSING'] };
  const reasons = [];
  if (stored.pipeline !== ACCEPTED_ARRANGEMENT_PIPELINE) reasons.push('ACCEPTED_ARRANGEMENT_PIPELINE_VERSION_CHANGED');
  const current = derivation(project, sourceSha256, revision);
  if (stored.derivation?.sourceSha256 !== current.sourceSha256) reasons.push('ACCEPTED_ARRANGEMENT_SOURCE_BYTES_CHANGED');
  if (stored.derivation?.projectId !== current.projectId) reasons.push('ACCEPTED_ARRANGEMENT_PROJECT_CHANGED');
  if (stored.derivation?.revision !== current.revision) reasons.push('ACCEPTED_ARRANGEMENT_REVISION_CHANGED');
  if (stored.derivation?.baselineContentDigest !== current.baselineContentDigest) reasons.push('ACCEPTED_ARRANGEMENT_BASELINE_CHANGED');
  // A stored status is never read as a result, only reported as a claim.
  return { current: reasons.length === 0, reasons, claimedStatus: stored.status ?? null };
}
