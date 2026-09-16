// G11-D accepted arrangement / decision application.
//
// `G11-D` is an *implementation stage name* used by this repository's Studio
// pipeline and roadmap documents. It is not a Published Canonical rule
// identifier, and nothing in this file publishes, amends or reinterprets a
// Canonical rule. Rule authority is discovered only through
// `docs/CANONICAL_MANIFEST.md` and the human-readable sources pinned at its
// `rules_snapshot_sha`; this module is an IMPLEMENTER of those rules.
//
// Input:  the G11-A Source-Faithful Canonical baseline, the G11-C candidate
//         suggestion derived from it (lane identity only), an optional parent
//         candidate revision, and an *explicitly accepted* decision set.
// Output: a new derived Candidate Canonical project plus a revision record, a
//         reversible per-event trace, and the baseline/parent diffs — or, when
//         anything at all does not hold, no candidate and a structured reason.
//
// Hard boundaries carried over from the rule sources:
//   * §3  the Source-Faithful Baseline is immutable. Nothing here mutates the
//         baseline, the parent candidate, or any event inside either. A new
//         project is constructed; the inputs are proven byte-identical before
//         and after.
//   * §3  no role move, removal, addition or property edit may be silent. Every
//         applied decision appears in `trace` with its input and output event
//         identities, and in the baseline and parent diffs.
//   * §4  Melody is the Lead role. A decision that demotes a source-supported
//         Lead runs the existing Lead Demotion Gate here and fails closed to
//         PENDING when the evidence chain is incomplete; "the user pressed
//         Apply" is never positive evidence. Promotion into Melody needs
//         positive role evidence for the same reason.
//   * §2  a G11-C suggestion is evidence, never acceptance. There is no code
//         path in this module by which a suggested role, a candidate status, a
//         confidence, a pitch ranking or a source authority becomes an accepted
//         decision. Acceptance is a caller-supplied, revision-bound record.
//   * §10 a new revision never overwrites its parent. Every application
//         produces a new, content-addressed candidate revision whose parent,
//         baseline, decision set and Canonical identity are all recorded.
//
// Explicitly NOT done here: MML emission, MML compression, character-limit
// reduction, timing repair, quantization, octave/register adaptation, volume
// balancing, instrument assignment, drum-face mapping, best-six optimization,
// automatic collision repair, and any readiness or acceptance verdict.
// `status: 'PASS'` means exactly one thing: the accepted decisions were applied
// faithfully, deterministically and traceably. It certifies no
// ACCEPTANCE_CRITERIA.md gate.
//
// Determinism contract: every ordering is by exact rational, integer or string
// id. No decision reads array position, object key order, Map/Set enumeration
// order, a wall-clock timestamp or a random value.

import { f, ROLES } from '../mml/index.mjs';
import {
  createCanonicalProject,
  createCanonicalNoteEvent,
  createCanonicalRestEvent,
} from '../canonical/index.mjs';
import { compareCanonicalVersions } from '../compare/version-drift.mjs';
import { evaluateLeadDemotion } from '../arbitration/lead-demotion.mjs';
import { sha256Hex } from '../source/sha256.mjs';

// ─── exact helpers ──────────────────────────────────────────────────────────

const cmpStr = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
const cmpB = (a, b) => f(a).cmp(b);
const beatKey = value => f(value).toString();
const encoder = new TextEncoder();

// Key-order-independent serialization. Two structurally equal inputs whose
// object keys were written in a different order must produce one digest, or
// "deterministic" would only mean "deterministic for the caller who happened to
// build the object our way".
export function canonicalJson(value) {
  if (value === undefined) return 'null';
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  const keys = Object.keys(value).sort(cmpStr);
  return `{${keys.map(k => `${JSON.stringify(k)}:${canonicalJson(value[k])}`).join(',')}}`;
}

export const contentDigest = value => sha256Hex(encoder.encode(canonicalJson(value)));

// ─── vocabulary ─────────────────────────────────────────────────────────────

export const SIX_ROLES = Object.freeze([...ROLES]);
export const CORE3_ROLE_NAMES = Object.freeze(['Melody', 'Chord1', 'Chord2']);
export const LEAD_ROLE = 'Melody';

// Decision types this stage applies.
export const ACCEPTED_DECISION_TYPES = Object.freeze({
  KEEP: 'KEEP',
  ASSIGN_ROLE: 'ASSIGN_ROLE',
  MOVE_ROLE: 'MOVE_ROLE',
  OMIT_FROM_SIX: 'OMIT_FROM_SIX',
  DUPLICATE_WITH_JUSTIFICATION: 'DUPLICATE_WITH_JUSTIFICATION',
});

// Decision types this stage *recognizes and refuses*. Naming them is the point:
// an unknown type is a malformed decision set and fails, while a recognized one
// reports `UNSUPPORTED` with the reason it is deferred, so a reviewer is never
// told "unknown decision" about a decision the project has actually discussed.
// None of these may be smuggled through MOVE_ROLE/ASSIGN_ROLE: every decision
// is key-allowlisted, so a pitch, octave, onset, duration or volume field on any
// decision is a rejection rather than an edit.
export const RECOGNIZED_UNSUPPORTED_DECISION_TYPES = Object.freeze({
  REDISTRIBUTE: 'G11-D applies one target disposition per event. Splitting one lane or event group across several roles needs an explicit redistribution contract with its own coverage audit; it is deferred rather than emulated by duplicate-then-drop-provenance.',
  OCTAVE_ADAPTATION: 'A derived Mobile register adaptation changes a sounding pitch. ACCEPTANCE_CRITERIA.md Gate 8 requires it to be minimal, evidence-backed and reported as adaptation, never as a source correction; it is deferred to the adaptation stage.',
  REGISTER_ADAPTATION: 'See OCTAVE_ADAPTATION. Deferred to the Mobile adaptation stage.',
  TRANSFORM_TIMING: 'Onset/duration editing rewrites source timing. It needs its own transform decision type with a full source diff and validation; G11-D changes no onset or duration.',
  TRANSFORM_PROMINENCE: 'Prominence/volume re-arbitration is Gate 8 adaptation work and is deferred; G11-D changes no volume.',
});

export const DECISION_REJECTION = Object.freeze({
  DECISION_MALFORMED: 'DECISION_MALFORMED',
  DUPLICATE_DECISION_ID: 'DUPLICATE_DECISION_ID',
  UNKNOWN_DECISION_TYPE: 'UNKNOWN_DECISION_TYPE',
  UNSUPPORTED_DECISION_TYPE: 'UNSUPPORTED_DECISION_TYPE',
  DECISION_NOT_ACCEPTED: 'DECISION_NOT_ACCEPTED',
  TARGET_MISSING: 'TARGET_MISSING',
  TARGET_AMBIGUOUS: 'TARGET_AMBIGUOUS',
  TARGET_EVENT_NOT_FOUND: 'TARGET_EVENT_NOT_FOUND',
  TARGET_EVENT_NOT_A_NOTE: 'TARGET_EVENT_NOT_A_NOTE',
  TARGET_RESOLVED_TO_NOTHING: 'TARGET_RESOLVED_TO_NOTHING',
  LANE_TARGET_REQUIRES_SUGGESTION: 'LANE_TARGET_REQUIRES_SUGGESTION',
  LANE_TARGET_UNKNOWN: 'LANE_TARGET_UNKNOWN',
  LANE_TARGET_EVENTS_NOT_IN_PARENT: 'LANE_TARGET_EVENTS_NOT_IN_PARENT',
  STALE_DECISION_REVISION_MISMATCH: 'STALE_DECISION_REVISION_MISMATCH',
  STALE_DECISION_BASELINE_CHANGED: 'STALE_DECISION_BASELINE_CHANGED',
  STALE_DECISION_SOURCE_CHANGED: 'STALE_DECISION_SOURCE_CHANGED',
  STALE_DECISION_CANONICAL_CHANGED: 'STALE_DECISION_CANONICAL_CHANGED',
  STALE_DECISION_LANE_DECOMPOSITION_CHANGED: 'STALE_DECISION_LANE_DECOMPOSITION_CHANGED',
  PREVIOUS_ROLE_MISMATCH: 'PREVIOUS_ROLE_MISMATCH',
  ASSIGN_ON_ALREADY_ASSIGNED_EVENT: 'ASSIGN_ON_ALREADY_ASSIGNED_EVENT',
  MOVE_ON_UNASSIGNED_EVENT: 'MOVE_ON_UNASSIGNED_EVENT',
  MOVE_TO_SAME_ROLE: 'MOVE_TO_SAME_ROLE',
  KEEP_CHANGES_ROLE: 'KEEP_CHANGES_ROLE',
  DUPLICATE_ON_UNASSIGNED_EVENT: 'DUPLICATE_ON_UNASSIGNED_EVENT',
  DUPLICATE_TARGETS_CURRENT_ROLE: 'DUPLICATE_TARGETS_CURRENT_ROLE',
  LEAD_DEMOTION_EVIDENCE_REQUIRED: 'LEAD_DEMOTION_EVIDENCE_REQUIRED',
  LEAD_PROMOTION_EVIDENCE_REQUIRED: 'LEAD_PROMOTION_EVIDENCE_REQUIRED',
});

// Rejections that make the whole set invalid, versus rejections that leave the
// set well-formed but unproven. FAIL is refusal; PENDING is "the evidence
// Canonical requires is not here"; UNSUPPORTED is "this project recognizes the
// decision and has deferred it".
const PENDING_CODES = new Set([
  DECISION_REJECTION.LEAD_DEMOTION_EVIDENCE_REQUIRED,
  DECISION_REJECTION.LEAD_PROMOTION_EVIDENCE_REQUIRED,
]);
const UNSUPPORTED_CODES = new Set([DECISION_REJECTION.UNSUPPORTED_DECISION_TYPE]);

export const CONFLICT_CODES = Object.freeze({
  MULTIPLE_DISPOSITIONS: 'MULTIPLE_DISPOSITIONS',
  DISPOSITION_AND_OMISSION: 'DISPOSITION_AND_OMISSION',
  MULTIPLE_DUPLICATIONS: 'MULTIPLE_DUPLICATIONS',
  DUPLICATION_OF_OMITTED_EVENT: 'DUPLICATION_OF_OMITTED_EVENT',
});

// Allowlists. An unknown key is a rejection, not an ignored field: that is what
// keeps a pitch/onset/duration/volume edit from riding along inside a role
// decision, and what keeps a future field from being silently honoured by an
// older build.
// `schema` and `supported` are the constructor's own output fields. They are
// allowed back in so a normalized decision round-trips through storage and
// through this constructor unchanged; both are recomputed, never trusted.
const DECISION_KEYS = new Set(['schema', 'supported', 'id', 'type', 'target', 'fromRole', 'toRole', 'toRoles', 'reason', 'evidence', 'acceptance', 'section', 'leadEvidence', 'metadata']);
const TARGET_KEYS = new Set(['laneId', 'eventIds']);
const ACCEPTANCE_KEYS = new Set(['state', 'acceptedBy', 'reviewedRevisionId', 'baselineContentDigest', 'sourceIdentityDigest', 'laneDecompositionDigest', 'canonicalRulesSnapshotSha', 'note']);
const SECTION_KEYS = new Set(['start', 'end']);

// Metadata keys a parent candidate must never carry forward into a derived
// revision. Each one is read by `final/readiness.mjs` as evidence that a gate
// passed; inheriting them would let a restored or imported parent hand a fresh
// revision a gate result nobody recomputed.
const NON_INHERITABLE_METADATA_KEYS = Object.freeze(['sourceComplete', 'audioAlignmentEvidence', 'sourceFaithfulBaseline', 'g11d', 'incompleteInputs']);

const ACCEPTED_STATE = 'ACCEPTED';

// ─── small validators ───────────────────────────────────────────────────────

const isPlainObject = value => Boolean(value) && typeof value === 'object' && !Array.isArray(value);
const nonEmptyString = value => typeof value === 'string' && Boolean(value.trim());

function requireKeys(object, allowed, label) {
  for (const key of Object.keys(object).sort(cmpStr)) {
    if (!allowed.has(key)) throw Error(`${label} carries an unsupported field: ${key}`);
  }
}

function stringList(values, label, { allowEmpty = false } = {}) {
  if (!Array.isArray(values)) throw Error(`${label} must be an array`);
  const list = values.map((value, index) => {
    if (!nonEmptyString(value)) throw Error(`${label}[${index}] must be a non-empty string`);
    return value.trim();
  });
  if (!allowEmpty && !list.length) throw Error(`${label} must not be empty`);
  if (new Set(list).size !== list.length) throw Error(`${label} must not contain duplicates`);
  return list;
}

// ─── identity ───────────────────────────────────────────────────────────────

const noteEvents = project => (project?.events ?? []).filter(event => event?.kind === 'note');

// What a decision is bound to. Every field is derived from content: nothing here
// reads a timestamp, a filename, a workspace slot or a caller-supplied id.
export function baselineIdentityOf(project) {
  if (!isPlainObject(project) || !Array.isArray(project.events) || !Array.isArray(project.sources)) {
    throw Error('baselineIdentityOf requires a Canonical project');
  }
  const eventIds = project.events.map(event => event.id).sort(cmpStr);
  const sourceRecords = [...project.sources]
    .map(source => ({ id: source.id, sha256: source.sha256 ?? null, kind: source.kind, authority: source.authority }))
    .sort((a, b) => cmpStr(a.id, b.id));
  return Object.freeze({
    projectId: project.id ?? null,
    eventCount: project.events.length,
    noteEventCount: noteEvents(project).length,
    eventIdDigest: contentDigest(eventIds),
    sourceIdentityDigest: contentDigest(sourceRecords),
    contentDigest: contentDigest(project),
  });
}

// Lane identity exactly as G11-C states it. G11-D deliberately does not
// re-derive lanes: a parallel lane identity system would let a lane-targeted
// decision mean one thing to the suggestion a reviewer read and another to the
// application, which is the retargeting hazard this digest exists to stop.
export function laneDecompositionDigestOf(suggestion) {
  if (suggestion === null || suggestion === undefined) return null;
  if (!isPlainObject(suggestion) || !Array.isArray(suggestion.lanes)) {
    throw Error('laneDecompositionDigestOf requires a G11-C role-candidate result');
  }
  const lanes = suggestion.lanes
    .map(lane => ({ id: lane.id, eventIds: [...(lane.eventIds ?? [])].sort(cmpStr) }))
    .sort((a, b) => cmpStr(a.id, b.id));
  return contentDigest(lanes);
}

// The digest a revision addresses its candidate by.
//
// `metadata.g11d` is excluded because it *contains* the revision: a revision
// cannot be content-addressed over a candidate that already carries it. Every
// musical fact -- sources, events, roles, tempo, meter, decisions and all other
// metadata -- is inside the digest, so a candidate whose events or roles were
// edited no longer matches the revision that describes it.
export function candidateDigestOf(project) {
  if (!isPlainObject(project)) throw Error('candidateDigestOf requires a Canonical project');
  const metadata = {};
  for (const key of Object.keys(project.metadata ?? {}).sort(cmpStr)) {
    if (key === 'g11d') continue;
    metadata[key] = project.metadata[key];
  }
  return contentDigest({ ...project, metadata });
}

export function decisionSetDigestOf(normalizedDecisions) {
  const records = normalizedDecisions
    .map(decision => ({ ...decision }))
    .sort((a, b) => cmpStr(a.id, b.id));
  return contentDigest(records);
}

function normalizeCanonicalIdentity(identity) {
  if (!isPlainObject(identity)) throw Error('canonicalIdentity is required: bind the accepted arrangement to the Published Canonical release it was reviewed under');
  const required = ['canonical_version', 'canonical_status', 'manifest_version', 'rules_snapshot_sha'];
  for (const key of required) {
    if (!nonEmptyString(identity[key])) throw Error(`canonicalIdentity.${key} must be a non-empty string`);
  }
  if (identity.canonical_status !== 'PUBLISHED') throw Error('canonicalIdentity.canonical_status must be PUBLISHED');
  if (!/^[a-f0-9]{40}$|^[a-f0-9]{64}$/i.test(identity.rules_snapshot_sha)) throw Error('canonicalIdentity.rules_snapshot_sha must be a full Git commit SHA');
  return Object.freeze({
    canonical_version: identity.canonical_version,
    canonical_status: identity.canonical_status,
    manifest_version: identity.manifest_version,
    rules_snapshot_sha: identity.rules_snapshot_sha,
  });
}

// The revision record. `id` is content-addressed over everything that decides
// what this revision *is*: which baseline, which parent, which decisions, which
// Canonical release, which lane decomposition, and the candidate those produced.
// Two runs of the same inputs therefore produce the same revision id, and a
// record whose fields were edited no longer hashes to its own id.
export function createArrangementRevision({
  index,
  parentRevisionId = null,
  baselineIdentity,
  parentCandidateIdentity = null,
  decisionSetDigest,
  canonicalIdentity,
  laneDecompositionDigest = null,
  candidateDigest,
}) {
  if (!Number.isInteger(index) || index < 1) throw Error('revision.index must be an integer >= 1');
  if (parentRevisionId !== null && !nonEmptyString(parentRevisionId)) throw Error('revision.parentRevisionId must be null or a non-empty string');
  const body = {
    index,
    parentRevisionId,
    baselineIdentity: { ...baselineIdentity },
    parentCandidateIdentity: parentCandidateIdentity ? { ...parentCandidateIdentity } : null,
    decisionSetDigest,
    canonicalIdentity: { ...canonicalIdentity },
    laneDecompositionDigest,
    candidateDigest,
  };
  return Object.freeze({
    schema: 'mabinogi-mobile-mml-studio/arrangement-revision@1',
    stage: 'G11-D',
    stageKind: 'ACCEPTED_ARRANGEMENT_REVISION',
    id: `g11d:rev:${contentDigest(body)}`,
    ...body,
    baselineIdentity: Object.freeze({ ...baselineIdentity }),
    parentCandidateIdentity: parentCandidateIdentity ? Object.freeze({ ...parentCandidateIdentity }) : null,
    canonicalIdentity: Object.freeze({ ...canonicalIdentity }),
    notice: 'A revision identity, not an acceptance verdict. It records which baseline, parent, decision set and Published Canonical release produced this candidate; it certifies no ACCEPTANCE_CRITERIA.md gate.',
  });
}

// Recompute a supplied revision record's id from its own content. A parent
// revision handed back from storage or an import is data, and this is what makes
// an edited one fail instead of being believed.
export function revisionIdentityMatches(revision) {
  if (!isPlainObject(revision) || !nonEmptyString(revision.id)) return false;
  try {
    const rebuilt = createArrangementRevision({
      index: revision.index,
      parentRevisionId: revision.parentRevisionId ?? null,
      baselineIdentity: revision.baselineIdentity,
      parentCandidateIdentity: revision.parentCandidateIdentity ?? null,
      decisionSetDigest: revision.decisionSetDigest,
      canonicalIdentity: revision.canonicalIdentity,
      laneDecompositionDigest: revision.laneDecompositionDigest ?? null,
      candidateDigest: revision.candidateDigest,
    });
    return rebuilt.id === revision.id;
  } catch { return false; }
}

// ─── accepted decision ──────────────────────────────────────────────────────

function normalizeAcceptance(acceptance) {
  if (!isPlainObject(acceptance)) throw Error('decision.acceptance is required; a G11-C suggestion is not an acceptance');
  requireKeys(acceptance, ACCEPTANCE_KEYS, 'decision.acceptance');
  if (acceptance.state !== ACCEPTED_STATE) throw Error(`decision.acceptance.state must be exactly "${ACCEPTED_STATE}"`);
  if (!nonEmptyString(acceptance.acceptedBy)) throw Error('decision.acceptance.acceptedBy must name who accepted this decision');
  if (acceptance.reviewedRevisionId !== null && !nonEmptyString(acceptance.reviewedRevisionId)) {
    throw Error('decision.acceptance.reviewedRevisionId must be null (reviewed against the Source-Faithful Baseline) or the parent revision id');
  }
  for (const key of ['baselineContentDigest', 'sourceIdentityDigest', 'canonicalRulesSnapshotSha']) {
    if (!nonEmptyString(acceptance[key])) throw Error(`decision.acceptance.${key} is required so a decision cannot be replayed against different inputs`);
  }
  if (acceptance.laneDecompositionDigest !== undefined
    && acceptance.laneDecompositionDigest !== null
    && !nonEmptyString(acceptance.laneDecompositionDigest)) {
    throw Error('decision.acceptance.laneDecompositionDigest must be null or a non-empty digest');
  }
  return Object.freeze({
    state: ACCEPTED_STATE,
    acceptedBy: acceptance.acceptedBy.trim(),
    reviewedRevisionId: acceptance.reviewedRevisionId ?? null,
    baselineContentDigest: acceptance.baselineContentDigest.trim(),
    sourceIdentityDigest: acceptance.sourceIdentityDigest.trim(),
    laneDecompositionDigest: acceptance.laneDecompositionDigest ?? null,
    canonicalRulesSnapshotSha: acceptance.canonicalRulesSnapshotSha.trim(),
    note: nonEmptyString(acceptance.note) ? acceptance.note.trim() : null,
  });
}

function normalizeTarget(target) {
  if (!isPlainObject(target)) throw Error('decision.target must be an object naming a laneId or eventIds');
  requireKeys(target, TARGET_KEYS, 'decision.target');
  const hasLane = target.laneId !== undefined && target.laneId !== null;
  const hasEvents = target.eventIds !== undefined && target.eventIds !== null;
  if (hasLane && hasEvents) throw Error('decision.target must name either laneId or eventIds, never both');
  if (!hasLane && !hasEvents) throw Error('decision.target must name a laneId or eventIds');
  if (hasLane) {
    if (!nonEmptyString(target.laneId)) throw Error('decision.target.laneId must be a non-empty string');
    return Object.freeze({ laneId: target.laneId.trim(), eventIds: null });
  }
  return Object.freeze({ laneId: null, eventIds: Object.freeze(stringList(target.eventIds, 'decision.target.eventIds')) });
}

function normalizeSection(section) {
  if (section === undefined || section === null) return null;
  if (!isPlainObject(section)) throw Error('decision.section must be an object with start and end');
  requireKeys(section, SECTION_KEYS, 'decision.section');
  let start;
  let end;
  try { start = f(section.start); end = f(section.end); }
  catch { throw Error('decision.section.start and decision.section.end must be exact rational-compatible beats'); }
  if (start.cmp(0) < 0) throw Error('decision.section.start must be >= 0');
  if (end.cmp(start) <= 0) throw Error('decision.section.end must be greater than decision.section.start');
  return Object.freeze({ start: start.toString(), end: end.toString() });
}

function normalizeRole(role, label) {
  if (!nonEmptyString(role) || !SIX_ROLES.includes(role)) throw Error(`${label} must be one of: ${SIX_ROLES.join(', ')}`);
  return role;
}

/**
 * Validate and normalize one explicitly accepted arrangement decision.
 *
 * Throws on anything malformed. There is deliberately no lenient mode and no
 * default acceptance: a decision that does not carry an `ACCEPTED` acceptance
 * record bound to a baseline digest, a source digest, a reviewed revision and a
 * Canonical rules snapshot cannot be constructed at all.
 */
export function createAcceptedDecision(input) {
  if (!isPlainObject(input)) throw Error('an accepted decision must be an object');
  requireKeys(input, DECISION_KEYS, 'decision');
  if (!nonEmptyString(input.id)) throw Error('decision.id must be a non-empty string');
  if (!nonEmptyString(input.type)) throw Error('decision.type must be a non-empty string');

  const id = input.id.trim();
  const type = input.type.trim();
  const known = Object.hasOwn(ACCEPTED_DECISION_TYPES, type);
  const recognizedUnsupported = Object.hasOwn(RECOGNIZED_UNSUPPORTED_DECISION_TYPES, type);
  if (!known && !recognizedUnsupported) throw Error(`unknown decision.type: ${type}`);

  if (!nonEmptyString(input.reason)) throw Error('decision.reason must state a positive reason for the decision');
  const evidence = stringList(input.evidence ?? [], 'decision.evidence', { allowEmpty: true });
  const acceptance = normalizeAcceptance(input.acceptance);
  const target = normalizeTarget(input.target);
  const section = normalizeSection(input.section);

  let fromRole = null;
  let toRole = null;
  let toRoles = null;

  if (input.fromRole !== undefined && input.fromRole !== null) fromRole = normalizeRole(input.fromRole, 'decision.fromRole');

  if (known) {
    if (type === ACCEPTED_DECISION_TYPES.ASSIGN_ROLE || type === ACCEPTED_DECISION_TYPES.MOVE_ROLE) {
      toRole = normalizeRole(input.toRole, 'decision.toRole');
      if (input.toRoles !== undefined && input.toRoles !== null) throw Error(`${type} uses decision.toRole, not decision.toRoles`);
    } else if (type === ACCEPTED_DECISION_TYPES.DUPLICATE_WITH_JUSTIFICATION) {
      if (input.toRole !== undefined && input.toRole !== null) throw Error('DUPLICATE_WITH_JUSTIFICATION uses decision.toRoles, not decision.toRole');
      const roles = stringList(input.toRoles ?? [], 'decision.toRoles');
      for (const role of roles) normalizeRole(role, 'decision.toRoles[]');
      toRoles = Object.freeze([...roles].sort(cmpStr));
      if (!evidence.length) throw Error('DUPLICATE_WITH_JUSTIFICATION requires explicit evidence references');
    } else {
      if (input.toRoles !== undefined && input.toRoles !== null) throw Error(`${type} does not take decision.toRoles`);
      if (type === ACCEPTED_DECISION_TYPES.OMIT_FROM_SIX && input.toRole !== undefined && input.toRole !== null) {
        throw Error('OMIT_FROM_SIX takes no destination role; omission is not a role move');
      }
      if (input.toRole !== undefined && input.toRole !== null) toRole = normalizeRole(input.toRole, 'decision.toRole');
    }
    if (type === ACCEPTED_DECISION_TYPES.MOVE_ROLE && (input.fromRole === undefined || input.fromRole === null)) {
      throw Error('MOVE_ROLE requires decision.fromRole so a stale move cannot be replayed onto a different role');
    }
  }

  const leadEvidence = input.leadEvidence === undefined || input.leadEvidence === null
    ? null
    : structuredClone(input.leadEvidence);
  if (leadEvidence !== null && !isPlainObject(leadEvidence)) throw Error('decision.leadEvidence must be an object');

  const metadata = input.metadata === undefined || input.metadata === null ? {} : structuredClone(input.metadata);
  if (!isPlainObject(metadata)) throw Error('decision.metadata must be an object');

  return Object.freeze({
    schema: 'mabinogi-mobile-mml-studio/accepted-arrangement-decision@1',
    id,
    type,
    supported: known,
    target,
    fromRole,
    toRole,
    toRoles,
    section,
    reason: input.reason.trim(),
    evidence: Object.freeze(evidence),
    acceptance,
    leadEvidence,
    metadata,
  });
}

// ─── target resolution ──────────────────────────────────────────────────────

function withinSection(event, section) {
  if (!section) return true;
  return cmpB(event.start, section.start) >= 0 && cmpB(event.end, section.end) <= 0;
}

// ─── Lead interlocks ────────────────────────────────────────────────────────

// Demotion runs the existing Lead Demotion Gate unchanged. G11-D adds no second
// opinion and relaxes nothing: an accepted decision reaches the same gate an
// unaccepted one would.
function leadDemotionBlockers(decision, event, destinationRole) {
  const evidence = decision.leadEvidence;
  if (!isPlainObject(evidence)) return ['LEAD_DEMOTION_EVIDENCE_MISSING'];
  let report;
  try {
    report = evaluateLeadDemotion({
      ...evidence,
      event,
      destinationRole,
      positiveReason: nonEmptyString(evidence.positiveReason) ? evidence.positiveReason : decision.reason,
    });
  } catch (error) { return [`LEAD_DEMOTION_EVIDENCE_INVALID: ${error.message}`]; }
  return report.status === 'PASS' ? [] : [...report.blockers];
}

// Promotion into Melody is the mirror obligation. MASTER_RULES.md §4 allows
// instrumental leads and source-supported hand-offs, so this is an
// evidence-presence interlock, not a musical judgement: it asks that the caller
// state which section this is and cite score or audio evidence that the material
// is actually the lead there. It never decides that anything *is* the lead.
const PROMOTION_SECTION_ROLES = new Set(['vocal-active', 'vocal-rest', 'instrumental', 'intro', 'interlude', 'solo', 'outro']);

function leadPromotionBlockers(decision) {
  const evidence = decision.leadEvidence;
  const blockers = [];
  if (!isPlainObject(evidence)) return ['LEAD_PROMOTION_EVIDENCE_MISSING'];
  const identity = evidence.sourceIdentity;
  if (!isPlainObject(identity) || !nonEmptyString(identity.sourceId) || !nonEmptyString(identity.sourceEventId)) blockers.push('SOURCE_IDENTITY_MISSING');
  if (!PROMOTION_SECTION_ROLES.has(evidence.sectionRole)) blockers.push('SECTION_ROLE_UNRESOLVED');
  const score = isPlainObject(evidence.scoreEvidence) ? evidence.scoreEvidence : {};
  const audio = isPlainObject(evidence.audioEvidence) ? evidence.audioEvidence : {};
  const scoreLead = score.availability !== 'unavailable' && score.classification === 'lead' && nonEmptyString(score.citation);
  const audioLead = audio.availability !== 'unavailable' && audio.classification === 'foreground' && nonEmptyString(audio.citation);
  if (!scoreLead && !audioLead) blockers.push('POSITIVE_LEAD_EVIDENCE_MISSING');
  if (!decision.evidence.length) blockers.push('EVIDENCE_REFERENCES_MISSING');
  return [...new Set(blockers)];
}

// ─── derived event identity ─────────────────────────────────────────────────

// A duplicate is derived candidate material, not a second source event. It keeps
// the original `sourceIds`/`sourceEventIds` -- that is what makes it traceable
// back to the one source event it copies -- and is marked derived so nothing
// downstream can read it as independent source support.
export function derivedDuplicateEventId(originalId, role, decisionId) {
  return `${originalId}#g11d-dup:${contentDigest({ from: originalId, role, decisionId }).slice(0, 16)}`;
}

function rebuildNote(event, overrides = {}) {
  return createCanonicalNoteEvent({
    id: overrides.id ?? event.id,
    pitch: event.pitch,
    start: event.start,
    end: event.end,
    sourceIds: [...(event.sourceIds ?? [])],
    sourceEventIds: [...(event.sourceEventIds ?? [])],
    role: overrides.role === undefined ? (event.role ?? null) : overrides.role,
    voice: event.voice ?? null,
    volume: event.volume ?? null,
    tags: overrides.tags ?? [...(event.tags ?? [])],
    metadata: overrides.metadata ?? structuredClone(event.metadata ?? {}),
  });
}

function rebuildRest(event) {
  return createCanonicalRestEvent({
    id: event.id,
    start: event.start,
    end: event.end,
    sourceIds: [...(event.sourceIds ?? [])],
    sourceEventIds: [...(event.sourceEventIds ?? [])],
    role: event.role ?? null,
    voice: event.voice ?? null,
    tags: [...(event.tags ?? [])],
    metadata: structuredClone(event.metadata ?? {}),
  });
}

const eventOrder = (a, b) =>
  cmpB(a.start, b.start)
  || cmpStr(a.kind, b.kind)
  || (Number(a.pitch ?? -1) - Number(b.pitch ?? -1))
  || cmpB(a.end, b.end)
  || cmpStr(a.id, b.id);

// ─── entry point ────────────────────────────────────────────────────────────

/**
 * Apply an explicitly accepted arrangement decision set.
 *
 * All-or-nothing. Every decision is validated, bound and conflict-checked
 * before a single output event is constructed, so a set whose seventeenth
 * decision is illegal leaves no partially applied candidate anywhere: on any
 * non-PASS result `candidate` is `null` and the inputs are byte-identical to
 * what was handed in.
 *
 * Returns a frozen result. `status: 'PASS'` means the accepted decisions were
 * applied faithfully, deterministically and traceably -- nothing more. The
 * candidate must still be re-run through the existing diff, Lead, Core3,
 * cross-source harmony, micro-timing and readiness pipeline before it is
 * anything but a candidate.
 */
export function applyAcceptedArrangement({
  baseline,
  suggestion = null,
  parent = null,
  decisions,
  canonicalIdentity,
} = {}) {
  if (!isPlainObject(baseline) || !Array.isArray(baseline.events) || !Array.isArray(baseline.sources)) {
    throw Error('applyAcceptedArrangement requires the Source-Faithful Canonical baseline project');
  }
  if (!Array.isArray(decisions)) throw Error('applyAcceptedArrangement requires an array of accepted decisions');
  const canonical = normalizeCanonicalIdentity(canonicalIdentity);

  // Immutability evidence, taken before anything else touches the inputs.
  const baselineDigestBefore = contentDigest(baseline);
  const parentCandidate = parent?.candidate ?? null;
  const parentDigestBefore = parentCandidate ? contentDigest(parentCandidate) : null;

  const baselineIdentity = baselineIdentityOf(baseline);
  const baselineEventIds = new Set(baseline.events.map(event => event.id));
  const baselineHas = eventId => baselineEventIds.has(eventId);
  const laneDigest = laneDecompositionDigestOf(suggestion);

  const rejected = [];
  const conflicts = [];
  const diagnostics = [];
  const reject = (decisionId, code, detail = {}) => {
    rejected.push(Object.freeze({ decisionId, code, ...detail }));
  };
  const note = (code, detail = {}) => { diagnostics.push(Object.freeze({ code, ...detail })); };

  // ── parent binding ──
  let parentRevision = null;
  let parentIdentity = null;
  let revisionIndex = 1;
  let fatalParent = false;
  if (parent !== null) {
    if (!isPlainObject(parent) || !isPlainObject(parent.revision) || !isPlainObject(parent.candidate)) {
      throw Error('parent must be { revision, candidate } from a previous G11-D application');
    }
    parentRevision = parent.revision;
    if (!revisionIdentityMatches(parentRevision)) {
      reject(null, 'PARENT_REVISION_IDENTITY_TAMPERED', { revisionId: parentRevision.id ?? null });
      fatalParent = true;
    }
    const observed = candidateDigestOf(parentCandidate);
    if (parentRevision.candidateDigest !== observed) {
      reject(null, 'PARENT_CANDIDATE_DIGEST_MISMATCH', { expected: parentRevision.candidateDigest ?? null, observed });
      fatalParent = true;
    }
    if (parentRevision.baselineIdentity?.contentDigest !== baselineIdentity.contentDigest) {
      reject(null, 'PARENT_BASELINE_MISMATCH', { expected: parentRevision.baselineIdentity?.contentDigest ?? null, observed: baselineIdentity.contentDigest });
      fatalParent = true;
    }
    if (parentRevision.canonicalIdentity?.rules_snapshot_sha !== canonical.rules_snapshot_sha) {
      reject(null, 'PARENT_CANONICAL_MISMATCH', { expected: parentRevision.canonicalIdentity?.rules_snapshot_sha ?? null, observed: canonical.rules_snapshot_sha });
      fatalParent = true;
    }
    parentIdentity = baselineIdentityOf(parentCandidate);
    revisionIndex = Number.isInteger(parentRevision.index) ? parentRevision.index + 1 : 2;
  }

  // The project the decisions are applied *onto*: the baseline for revision 1,
  // the parent candidate afterwards. The baseline itself is never the mutation
  // target in either case -- it is only ever read.
  const applyTo = parentCandidate ?? baseline;
  const expectedReviewedRevisionId = parentRevision?.id ?? null;
  const eventById = new Map(applyTo.events.map(event => [event.id, event]));

  // ── normalize decisions ──
  const normalized = [];
  const seenIds = new Set();
  for (const [index, input] of decisions.entries()) {
    let decision;
    try { decision = createAcceptedDecision(input); }
    catch (error) {
      reject(isPlainObject(input) && nonEmptyString(input.id) ? input.id : `decisions[${index}]`, DECISION_REJECTION.DECISION_MALFORMED, { detail: error.message });
      continue;
    }
    if (seenIds.has(decision.id)) {
      reject(decision.id, DECISION_REJECTION.DUPLICATE_DECISION_ID, { detail: 'A decision set must not contain two decisions with the same id.' });
      continue;
    }
    seenIds.add(decision.id);
    normalized.push(decision);
  }
  normalized.sort((a, b) => cmpStr(a.id, b.id));
  if (!decisions.length) reject(null, 'DECISION_SET_EMPTY', { detail: 'Applying nothing does not mint a candidate revision. Supply at least one accepted decision.' });

  const decisionSetDigest = decisionSetDigestOf(normalized);

  // ── bind, resolve, gate ──
  const laneById = new Map((suggestion?.lanes ?? []).map(lane => [lane.id, lane]));
  const resolvedByDecision = new Map();

  for (const decision of normalized) {
    // Staleness first: a decision bound to different inputs is refused before
    // its targets are even looked up, so a stale decision can never partly
    // resolve against the current revision.
    let stale = false;
    const acceptance = decision.acceptance;
    if (acceptance.reviewedRevisionId !== expectedReviewedRevisionId) {
      reject(decision.id, DECISION_REJECTION.STALE_DECISION_REVISION_MISMATCH, { expected: expectedReviewedRevisionId, observed: acceptance.reviewedRevisionId });
      stale = true;
    }
    if (acceptance.baselineContentDigest !== baselineIdentity.contentDigest) {
      reject(decision.id, DECISION_REJECTION.STALE_DECISION_BASELINE_CHANGED, { expected: baselineIdentity.contentDigest, observed: acceptance.baselineContentDigest });
      stale = true;
    }
    if (acceptance.sourceIdentityDigest !== baselineIdentity.sourceIdentityDigest) {
      reject(decision.id, DECISION_REJECTION.STALE_DECISION_SOURCE_CHANGED, { expected: baselineIdentity.sourceIdentityDigest, observed: acceptance.sourceIdentityDigest });
      stale = true;
    }
    if (acceptance.canonicalRulesSnapshotSha !== canonical.rules_snapshot_sha) {
      reject(decision.id, DECISION_REJECTION.STALE_DECISION_CANONICAL_CHANGED, { expected: canonical.rules_snapshot_sha, observed: acceptance.canonicalRulesSnapshotSha });
      stale = true;
    }
    if (decision.target.laneId !== null || acceptance.laneDecompositionDigest !== null) {
      if (acceptance.laneDecompositionDigest !== laneDigest) {
        reject(decision.id, DECISION_REJECTION.STALE_DECISION_LANE_DECOMPOSITION_CHANGED, { expected: laneDigest, observed: acceptance.laneDecompositionDigest });
        stale = true;
      }
    }
    if (stale) continue;

    if (!decision.supported) {
      reject(decision.id, DECISION_REJECTION.UNSUPPORTED_DECISION_TYPE, {
        type: decision.type,
        detail: RECOGNIZED_UNSUPPORTED_DECISION_TYPES[decision.type],
      });
      continue;
    }

    // Resolve targets.
    let targetIds;
    if (decision.target.laneId !== null) {
      if (!suggestion) { reject(decision.id, DECISION_REJECTION.LANE_TARGET_REQUIRES_SUGGESTION, { laneId: decision.target.laneId }); continue; }
      const lane = laneById.get(decision.target.laneId);
      if (!lane) { reject(decision.id, DECISION_REJECTION.LANE_TARGET_UNKNOWN, { laneId: decision.target.laneId }); continue; }
      const laneEventIds = [...lane.eventIds].sort(cmpStr);
      const missing = laneEventIds.filter(eventId => !eventById.has(eventId));
      if (missing.length) {
        reject(decision.id, DECISION_REJECTION.LANE_TARGET_EVENTS_NOT_IN_PARENT, { laneId: lane.id, missingEventIds: Object.freeze(missing) });
        continue;
      }
      targetIds = laneEventIds.filter(eventId => withinSection(eventById.get(eventId), decision.section));
    } else {
      const missing = decision.target.eventIds.filter(eventId => !eventById.has(eventId));
      if (missing.length) {
        reject(decision.id, DECISION_REJECTION.TARGET_EVENT_NOT_FOUND, { missingEventIds: Object.freeze([...missing].sort(cmpStr)) });
        continue;
      }
      const nonNotes = decision.target.eventIds.filter(eventId => eventById.get(eventId).kind !== 'note');
      if (nonNotes.length) {
        reject(decision.id, DECISION_REJECTION.TARGET_EVENT_NOT_A_NOTE, { eventIds: Object.freeze([...nonNotes].sort(cmpStr)) });
        continue;
      }
      targetIds = [...decision.target.eventIds]
        .sort(cmpStr)
        .filter(eventId => withinSection(eventById.get(eventId), decision.section));
    }

    if (!targetIds.length) {
      reject(decision.id, DECISION_REJECTION.TARGET_RESOLVED_TO_NOTHING, { section: decision.section });
      continue;
    }

    // Per-event legality against the role the parent candidate actually carries.
    const problems = [];
    const leadBlockers = [];
    for (const eventId of targetIds) {
      const event = eventById.get(eventId);
      const currentRole = event.role ?? null;
      if (decision.fromRole !== null && decision.fromRole !== currentRole) {
        problems.push({ code: DECISION_REJECTION.PREVIOUS_ROLE_MISMATCH, eventId, expected: decision.fromRole, observed: currentRole });
        continue;
      }
      switch (decision.type) {
        case ACCEPTED_DECISION_TYPES.KEEP:
          if (decision.toRole !== null && decision.toRole !== currentRole) {
            problems.push({ code: DECISION_REJECTION.KEEP_CHANGES_ROLE, eventId, currentRole, toRole: decision.toRole });
          }
          break;
        case ACCEPTED_DECISION_TYPES.ASSIGN_ROLE:
          if (currentRole !== null) problems.push({ code: DECISION_REJECTION.ASSIGN_ON_ALREADY_ASSIGNED_EVENT, eventId, currentRole });
          break;
        case ACCEPTED_DECISION_TYPES.MOVE_ROLE:
          if (currentRole === null) problems.push({ code: DECISION_REJECTION.MOVE_ON_UNASSIGNED_EVENT, eventId });
          else if (currentRole === decision.toRole) problems.push({ code: DECISION_REJECTION.MOVE_TO_SAME_ROLE, eventId, currentRole });
          break;
        case ACCEPTED_DECISION_TYPES.DUPLICATE_WITH_JUSTIFICATION:
          if (currentRole === null) problems.push({ code: DECISION_REJECTION.DUPLICATE_ON_UNASSIGNED_EVENT, eventId });
          else if (decision.toRoles.includes(currentRole)) problems.push({ code: DECISION_REJECTION.DUPLICATE_TARGETS_CURRENT_ROLE, eventId, currentRole });
          break;
        default:
          break;
      }

      // Lead interlocks. An accepted decision does not disable them.
      const leavesLead = currentRole === LEAD_ROLE
        && ((decision.type === ACCEPTED_DECISION_TYPES.MOVE_ROLE && decision.toRole !== LEAD_ROLE)
          || decision.type === ACCEPTED_DECISION_TYPES.OMIT_FROM_SIX);
      if (leavesLead) {
        const destination = decision.type === ACCEPTED_DECISION_TYPES.OMIT_FROM_SIX ? 'omitted' : decision.toRole;
        const blockers = leadDemotionBlockers(decision, event, destination);
        if (blockers.length) leadBlockers.push({ kind: 'demotion', eventId, destination, blockers });
      }
      const entersLead = currentRole !== LEAD_ROLE
        && (decision.type === ACCEPTED_DECISION_TYPES.ASSIGN_ROLE || decision.type === ACCEPTED_DECISION_TYPES.MOVE_ROLE)
        && decision.toRole === LEAD_ROLE;
      const duplicatesIntoLead = decision.type === ACCEPTED_DECISION_TYPES.DUPLICATE_WITH_JUSTIFICATION
        && decision.toRoles.includes(LEAD_ROLE);
      if (entersLead || duplicatesIntoLead) {
        const blockers = leadPromotionBlockers(decision);
        if (blockers.length) leadBlockers.push({ kind: 'promotion', eventId, destination: LEAD_ROLE, blockers });
      }
    }

    if (problems.length) {
      const byCode = new Map();
      for (const problem of problems) {
        if (!byCode.has(problem.code)) byCode.set(problem.code, []);
        byCode.get(problem.code).push(problem);
      }
      for (const code of [...byCode.keys()].sort(cmpStr)) {
        reject(decision.id, code, { events: Object.freeze(byCode.get(code).map(item => Object.freeze(item))) });
      }
      continue;
    }
    if (leadBlockers.length) {
      const demotions = leadBlockers.filter(item => item.kind === 'demotion');
      const promotions = leadBlockers.filter(item => item.kind === 'promotion');
      if (demotions.length) reject(decision.id, DECISION_REJECTION.LEAD_DEMOTION_EVIDENCE_REQUIRED, {
        events: Object.freeze(demotions.map(item => Object.freeze({ eventId: item.eventId, destinationRole: item.destination, blockers: Object.freeze([...item.blockers]) }))),
        notice: 'MASTER_RULES.md §4 / SOURCE_POLICY.md §4: demoting a source-supported Lead needs positive role evidence, preserved continuity and Core3 integrity. Acceptance is not evidence.',
      });
      if (promotions.length) reject(decision.id, DECISION_REJECTION.LEAD_PROMOTION_EVIDENCE_REQUIRED, {
        events: Object.freeze(promotions.map(item => Object.freeze({ eventId: item.eventId, destinationRole: item.destination, blockers: Object.freeze([...item.blockers]) }))),
        notice: 'MASTER_RULES.md §4: Melody is the Lead role. Promoting material into it needs positive, section-resolved role evidence; highest pitch and "nothing else is proven Lead" are forbidden inferences.',
      });
      continue;
    }

    resolvedByDecision.set(decision.id, Object.freeze([...targetIds].sort(cmpStr)));
  }

  // ── conflicts ──
  //
  // Built from a map keyed by event id, then reported in sorted order. Nothing
  // here reads array position, acceptance order or a timestamp, so there is no
  // "last decision wins" to depend on: a mutually exclusive pair is a conflict
  // whichever way the caller ordered it.
  const dispositionsByEvent = new Map();
  const duplicationsByEvent = new Map();
  for (const decision of normalized) {
    const targets = resolvedByDecision.get(decision.id);
    if (!targets) continue;
    const bucket = decision.type === ACCEPTED_DECISION_TYPES.DUPLICATE_WITH_JUSTIFICATION ? duplicationsByEvent : dispositionsByEvent;
    for (const eventId of targets) {
      if (!bucket.has(eventId)) bucket.set(eventId, []);
      bucket.get(eventId).push(decision);
    }
  }

  const conflictedDecisionIds = new Set();
  const addConflict = (code, eventId, involved, detail = {}) => {
    const decisionIds = [...new Set(involved.map(item => item.id))].sort(cmpStr);
    for (const decisionId of decisionIds) conflictedDecisionIds.add(decisionId);
    conflicts.push(Object.freeze({
      id: `${code}|${eventId}|${decisionIds.join(',')}`,
      code,
      eventId,
      decisionIds: Object.freeze(decisionIds),
      resolvedAutomatically: false,
      ...detail,
    }));
  };

  for (const eventId of [...dispositionsByEvent.keys()].sort(cmpStr)) {
    const involved = dispositionsByEvent.get(eventId);
    if (involved.length > 1) {
      const omissions = involved.filter(decision => decision.type === ACCEPTED_DECISION_TYPES.OMIT_FROM_SIX);
      addConflict(
        omissions.length && omissions.length < involved.length
          ? CONFLICT_CODES.DISPOSITION_AND_OMISSION
          : CONFLICT_CODES.MULTIPLE_DISPOSITIONS,
        eventId,
        involved,
        {
          types: Object.freeze(involved.map(decision => decision.type).sort(cmpStr)),
          targetRoles: Object.freeze([...new Set(involved.map(decision => decision.toRole).filter(role => role !== null))].sort(cmpStr)),
          notice: 'One event carries at most one disposition. Nothing is chosen by order, recency or evidence rank; the reviewer resolves it.',
        },
      );
    }
  }
  for (const eventId of [...duplicationsByEvent.keys()].sort(cmpStr)) {
    const involved = duplicationsByEvent.get(eventId);
    if (involved.length > 1) {
      addConflict(CONFLICT_CODES.MULTIPLE_DUPLICATIONS, eventId, involved, {
        notice: 'Two duplication decisions on one event are not merged. Re-issue them as one decision naming every target role.',
      });
    }
    const dispositions = dispositionsByEvent.get(eventId) ?? [];
    const omitted = dispositions.filter(decision => decision.type === ACCEPTED_DECISION_TYPES.OMIT_FROM_SIX);
    if (omitted.length) {
      addConflict(CONFLICT_CODES.DUPLICATION_OF_OMITTED_EVENT, eventId, [...involved, ...omitted], {
        notice: 'An event cannot be both omitted from the six roles and duplicated into them.',
      });
    }
  }
  conflicts.sort((a, b) => cmpStr(a.id, b.id));

  // ── verdict before construction ──
  const fatal = rejected.some(item => !PENDING_CODES.has(item.code) && !UNSUPPORTED_CODES.has(item.code)) || conflicts.length || fatalParent;
  const unsupported = rejected.some(item => UNSUPPORTED_CODES.has(item.code));
  const pending = rejected.some(item => PENDING_CODES.has(item.code));
  const status = fatal ? 'FAIL' : unsupported ? 'UNSUPPORTED' : pending ? 'PENDING' : 'PASS';

  const staleCodes = new Set([
    DECISION_REJECTION.STALE_DECISION_REVISION_MISMATCH,
    DECISION_REJECTION.STALE_DECISION_BASELINE_CHANGED,
    DECISION_REJECTION.STALE_DECISION_SOURCE_CHANGED,
    DECISION_REJECTION.STALE_DECISION_CANONICAL_CHANGED,
    DECISION_REJECTION.STALE_DECISION_LANE_DECOMPOSITION_CHANGED,
  ]);
  const stale = rejected.filter(item => staleCodes.has(item.code));

  const inputsUnchanged = () => {
    const after = contentDigest(baseline);
    const parentAfter = parentCandidate ? contentDigest(parentCandidate) : null;
    return Object.freeze({
      baselineDigestBefore,
      baselineDigestAfter: after,
      baselineUnchanged: after === baselineDigestBefore,
      parentDigestBefore,
      parentDigestAfter: parentAfter,
      parentUnchanged: parentAfter === parentDigestBefore,
    });
  };

  const commonNotice = 'G11-D applies accepted arrangement decisions. PASS means the decisions were applied faithfully, deterministically and traceably -- it certifies no ACCEPTANCE_CRITERIA.md gate and is not VALIDATED. The candidate must still be re-run through diff, Lead, Core3, cross-source harmony, micro-timing and readiness.';

  if (status !== 'PASS') {
    return Object.freeze({
      schema: 'mabinogi-mobile-mml-studio/accepted-arrangement-application@1',
      stage: 'G11-D',
      stageKind: 'ACCEPTED_ARRANGEMENT_APPLICATION',
      status,
      candidate: null,
      revision: null,
      baselineIdentity,
      parentRevisionId: expectedReviewedRevisionId,
      decisionSetDigest,
      canonicalIdentity: canonical,
      laneDecompositionDigest: laneDigest,
      applied: Object.freeze([]),
      rejected: Object.freeze([...rejected].sort((a, b) => cmpStr(String(a.decisionId), String(b.decisionId)) || cmpStr(a.code, b.code))),
      conflicts: Object.freeze(conflicts),
      stale: Object.freeze(stale),
      requiresFreshReview: stale.length > 0,
      trace: Object.freeze([]),
      omitted: Object.freeze([]),
      diffFromBaseline: null,
      diffFromParent: null,
      immutability: inputsUnchanged(),
      diagnostics: Object.freeze([...diagnostics].sort((a, b) => cmpStr(a.code, b.code))),
      downstream: DOWNSTREAM_CONTRACT,
      notice: `${commonNotice} No candidate was produced and nothing was applied: the decision set is all-or-nothing.`,
    });
  }

  // ── construction (only reached when everything above held) ──
  const roleByEvent = new Map();
  const omitEvents = new Set();
  const duplicatesByEvent = new Map();
  const traceEntries = [];
  const applied = [];

  for (const decision of normalized) {
    const targets = resolvedByDecision.get(decision.id);
    if (!targets) continue;
    const perEvent = [];
    for (const eventId of targets) {
      const event = eventById.get(eventId);
      const currentRole = event.role ?? null;
      let outputEventIds = [];
      let toRole = currentRole;
      switch (decision.type) {
        case ACCEPTED_DECISION_TYPES.KEEP:
          outputEventIds = [eventId];
          break;
        case ACCEPTED_DECISION_TYPES.ASSIGN_ROLE:
        case ACCEPTED_DECISION_TYPES.MOVE_ROLE:
          roleByEvent.set(eventId, decision.toRole);
          toRole = decision.toRole;
          outputEventIds = [eventId];
          break;
        case ACCEPTED_DECISION_TYPES.OMIT_FROM_SIX:
          omitEvents.add(eventId);
          toRole = null;
          outputEventIds = [];
          break;
        case ACCEPTED_DECISION_TYPES.DUPLICATE_WITH_JUSTIFICATION: {
          const derived = decision.toRoles.map(role => Object.freeze({
            id: derivedDuplicateEventId(eventId, role, decision.id),
            role,
          }));
          duplicatesByEvent.set(eventId, Object.freeze({ decisionId: decision.id, reason: decision.reason, evidence: decision.evidence, derived: Object.freeze(derived) }));
          outputEventIds = [eventId, ...derived.map(item => item.id)];
          break;
        }
        default:
          break;
      }
      perEvent.push({ eventId, fromRole: currentRole, toRole, outputEventIds });
      traceEntries.push({
        decisionId: decision.id,
        decisionType: decision.type,
        inputEventId: eventId,
        baselineEventId: baselineHas(eventId) ? eventId : null,
        sourceIds: Object.freeze([...(event.sourceIds ?? [])].sort(cmpStr)),
        sourceEventIds: Object.freeze([...(event.sourceEventIds ?? [])].sort(cmpStr)),
        fromRole: currentRole,
        toRole,
        outputEventIds: Object.freeze([...outputEventIds]),
        // Restated so the trace itself proves no property was edited.
        pitch: event.pitch,
        start: beatKey(event.start),
        end: beatKey(event.end),
        volume: event.volume ?? null,
        reversible: true,
      });
    }
    applied.push(Object.freeze({
      decisionId: decision.id,
      type: decision.type,
      acceptedBy: decision.acceptance.acceptedBy,
      reason: decision.reason,
      evidence: decision.evidence,
      eventCount: perEvent.length,
      events: Object.freeze(perEvent.map(item => Object.freeze({ ...item, outputEventIds: Object.freeze(item.outputEventIds) }))),
    }));
  }

  const outputEvents = [];
  const omittedRecords = [];
  for (const event of applyTo.events) {
    if (event.kind !== 'note') { outputEvents.push(rebuildRest(event)); continue; }
    if (omitEvents.has(event.id)) {
      omittedRecords.push(Object.freeze({
        eventId: event.id,
        role: event.role ?? null,
        pitch: event.pitch,
        start: beatKey(event.start),
        end: beatKey(event.end),
        sourceIds: Object.freeze([...(event.sourceIds ?? [])].sort(cmpStr)),
        sourceEventIds: Object.freeze([...(event.sourceEventIds ?? [])].sort(cmpStr)),
        stillInBaseline: baselineHas(event.id),
        notice: 'Omitted from the six-role candidate only. The source event is untouched in the Source-Faithful Baseline and appears as a removal in the baseline diff.',
      }));
      continue;
    }
    const role = roleByEvent.has(event.id) ? roleByEvent.get(event.id) : (event.role ?? null);
    outputEvents.push(rebuildNote(event, { role }));
    const duplication = duplicatesByEvent.get(event.id);
    if (!duplication) continue;
    for (const derived of duplication.derived) {
      outputEvents.push(rebuildNote(event, {
        id: derived.id,
        role: derived.role,
        tags: [...new Set([...(event.tags ?? []), 'g11d-derived-duplicate'])],
        metadata: {
          ...structuredClone(event.metadata ?? {}),
          g11d: {
            derived: ACCEPTED_DECISION_TYPES.DUPLICATE_WITH_JUSTIFICATION,
            derivedFromEventId: event.id,
            decisionId: duplication.decisionId,
            role: derived.role,
            reason: duplication.reason,
            evidence: [...duplication.evidence],
            notice: 'Derived candidate material. It copies one source event and is not independent source support.',
          },
        },
      }));
    }
  }
  outputEvents.sort(eventOrder);
  omittedRecords.sort((a, b) => cmpStr(a.eventId, b.eventId));

  // Carried-forward arbitration decisions. One that references an omitted event
  // can no longer describe this project, and is dropped loudly rather than
  // rewritten: dropping it makes the conflict it resolved re-report as
  // unresolved, which is the safe direction.
  const outputEventIdSet = new Set(outputEvents.map(event => event.id));
  const carriedDecisions = [];
  const droppedDecisionIds = [];
  for (const decision of applyTo.decisions ?? []) {
    const referenced = decision.eventIds ?? [];
    if (referenced.every(eventId => outputEventIdSet.has(eventId))) carriedDecisions.push(decision);
    else droppedDecisionIds.push(decision.id);
  }
  if (droppedDecisionIds.length) note('ARBITRATION_DECISION_DROPPED_WITH_OMITTED_EVENT', {
    decisionIds: Object.freeze([...droppedDecisionIds].sort(cmpStr)),
    notice: 'A carried arbitration decision referenced an event this revision omitted. It is dropped, so whatever it resolved is reported unresolved again rather than staying resolved against an event that is gone.',
  });

  // Metadata a parent must not hand down. Each of these is read downstream as
  // evidence that a gate passed; a fresh revision recomputes them or does
  // without them.
  const inheritedMetadata = {};
  const strippedMetadataKeys = [];
  for (const key of Object.keys(applyTo.metadata ?? {}).sort(cmpStr)) {
    if (NON_INHERITABLE_METADATA_KEYS.includes(key)) { strippedMetadataKeys.push(key); continue; }
    inheritedMetadata[key] = structuredClone(applyTo.metadata[key]);
  }
  if (strippedMetadataKeys.length) note('PARENT_GATE_METADATA_NOT_INHERITED', {
    keys: Object.freeze(strippedMetadataKeys),
    notice: 'Source completeness, audio alignment evidence and a stored baseline snapshot are gate evidence. A derived revision never inherits them; they are recomputed or absent.',
  });

  const baselineSnapshot = stripMetadataKeys(baseline, NON_INHERITABLE_METADATA_KEYS);

  const candidateWithoutRevision = createCanonicalProject({
    id: `${baseline.id}#g11d-r${revisionIndex}`,
    title: baseline.title,
    sources: [...baseline.sources],
    events: outputEvents,
    tempoEvents: [...(applyTo.tempoEvents ?? [])],
    meterEvents: [...(applyTo.meterEvents ?? [])],
    decisions: carriedDecisions,
    metadata: {
      ...inheritedMetadata,
      sourceFaithfulBaseline: { snapshot: baselineSnapshot },
    },
  });

  // The revision is content-addressed over the candidate it describes, so it is
  // computed from a candidate that does not yet carry it, and then attached.
  const candidateDigest = candidateDigestOf(candidateWithoutRevision);
  const revision = createArrangementRevision({
    index: revisionIndex,
    parentRevisionId: expectedReviewedRevisionId,
    baselineIdentity,
    parentCandidateIdentity: parentIdentity,
    decisionSetDigest,
    canonicalIdentity: canonical,
    laneDecompositionDigest: laneDigest,
    candidateDigest,
  });

  const candidate = createCanonicalProject({
    ...candidateWithoutRevision,
    metadata: {
      ...candidateWithoutRevision.metadata,
      g11d: {
        revision: JSON.parse(JSON.stringify(revision)),
        appliedDecisionIds: applied.map(item => item.decisionId),
        omittedEventIds: omittedRecords.map(item => item.eventId),
        derivedDuplicateEventIds: outputEvents
          .filter(event => event.metadata?.g11d?.derived === ACCEPTED_DECISION_TYPES.DUPLICATE_WITH_JUSTIFICATION)
          .map(event => event.id)
          .sort(cmpStr),
        certifiesGates: [],
        notice: 'Provenance for this candidate revision. It is data, not authority: it certifies no ACCEPTANCE_CRITERIA.md gate and grants no readiness result.',
      },
    },
  });

  // ── invariants, proven not asserted ──
  const immutability = inputsUnchanged();
  if (!immutability.baselineUnchanged) throw Error('G11-D INVARIANT VIOLATED: the Source-Faithful Baseline changed during application');
  if (immutability.parentUnchanged === false) throw Error('G11-D INVARIANT VIOLATED: the parent candidate changed during application');

  const inputById = new Map(noteEvents(applyTo).map(event => [event.id, event]));
  const drift = [];
  for (const event of noteEvents(candidate)) {
    const origin = event.metadata?.g11d?.derivedFromEventId ?? event.id;
    const source = inputById.get(origin);
    if (!source) { drift.push({ eventId: event.id, code: 'OUTPUT_EVENT_HAS_NO_INPUT' }); continue; }
    if (event.pitch !== source.pitch) drift.push({ eventId: event.id, code: 'PITCH_CHANGED' });
    if (cmpB(event.start, source.start) !== 0) drift.push({ eventId: event.id, code: 'ONSET_CHANGED' });
    if (cmpB(event.end, source.end) !== 0) drift.push({ eventId: event.id, code: 'DURATION_CHANGED' });
    if ((event.volume ?? null) !== (source.volume ?? null)) drift.push({ eventId: event.id, code: 'VOLUME_CHANGED' });
    if (canonicalJson([...(event.sourceIds ?? [])].sort(cmpStr)) !== canonicalJson([...(source.sourceIds ?? [])].sort(cmpStr))) drift.push({ eventId: event.id, code: 'SOURCE_IDS_CHANGED' });
    if (canonicalJson([...(event.sourceEventIds ?? [])].sort(cmpStr)) !== canonicalJson([...(source.sourceEventIds ?? [])].sort(cmpStr))) drift.push({ eventId: event.id, code: 'SOURCE_EVENT_IDS_CHANGED' });
  }
  if (drift.length) throw Error(`G11-D INVARIANT VIOLATED: ${canonicalJson(drift)}`);

  const unassignedEventIds = noteEvents(candidate).filter(event => (event.role ?? null) === null).map(event => event.id).sort(cmpStr);
  if (unassignedEventIds.length) note('UNASSIGNED_MATERIAL_RETAINED', {
    eventIds: Object.freeze(unassignedEventIds),
    notice: 'Material with no accepted role is retained in the candidate rather than dropped. Six-role capacity is a capacity fact, not permission to delete (MASTER_RULES.md §3).',
  });
  const omittedCore3 = omittedRecords.filter(item => CORE3_ROLE_NAMES.includes(item.role ?? ''));
  if (omittedCore3.length) note('CORE3_MATERIAL_OMITTED', {
    eventIds: Object.freeze(omittedCore3.map(item => item.eventId)),
    roles: Object.freeze([...new Set(omittedCore3.map(item => item.role))].sort(cmpStr)),
    notice: 'Core3 material was omitted by explicit decision. G11-D applies the decision; whether Core3 is still complete is decided by the Core3 gate against the baseline, not here.',
  });

  const diffFromBaseline = compareCanonicalVersions(baselineSnapshot, candidate);
  const diffFromParent = parentCandidate ? compareCanonicalVersions(parentCandidate, candidate) : null;

  traceEntries.sort((a, b) => cmpStr(a.decisionId, b.decisionId) || cmpStr(a.inputEventId, b.inputEventId));

  return Object.freeze({
    schema: 'mabinogi-mobile-mml-studio/accepted-arrangement-application@1',
    stage: 'G11-D',
    stageKind: 'ACCEPTED_ARRANGEMENT_APPLICATION',
    status: 'PASS',
    candidate,
    revision,
    baselineIdentity,
    parentRevisionId: expectedReviewedRevisionId,
    decisionSetDigest,
    canonicalIdentity: canonical,
    laneDecompositionDigest: laneDigest,
    applied: Object.freeze(applied),
    rejected: Object.freeze([]),
    conflicts: Object.freeze([]),
    stale: Object.freeze([]),
    requiresFreshReview: false,
    trace: Object.freeze(traceEntries.map(entry => Object.freeze(entry))),
    omitted: Object.freeze(omittedRecords),
    diffFromBaseline,
    diffFromParent,
    immutability,
    diagnostics: Object.freeze([...diagnostics].sort((a, b) => cmpStr(a.code, b.code))),
    downstream: DOWNSTREAM_CONTRACT,
    notice: commonNotice,
  });
}


function stripMetadataKeys(project, keys) {
  const metadata = {};
  for (const key of Object.keys(project.metadata ?? {}).sort(cmpStr)) {
    if (keys.includes(key)) continue;
    metadata[key] = structuredClone(project.metadata[key]);
  }
  return createCanonicalProject({
    id: project.id,
    title: project.title,
    sources: [...project.sources],
    events: [...project.events],
    tempoEvents: [...(project.tempoEvents ?? [])],
    meterEvents: [...(project.meterEvents ?? [])],
    decisions: [...(project.decisions ?? [])],
    metadata,
  });
}

// What still has to happen after a PASS. Stated as data so no reader has to
// infer it, and so a caller that skips a gate is skipping something named.
export const DOWNSTREAM_CONTRACT = Object.freeze({
  notice: 'G11-D decides none of these. A PASS here is an application result, not a gate result.',
  mustRerun: Object.freeze([
    'compare/version-drift: candidate vs Source-Faithful Baseline',
    'compare/version-drift: candidate vs accepted previous revision',
    'arbitration/core3: Core3 continuity and false Lead gaps',
    'arbitration/lead-demotion: every Lead removal/role move in the diff',
    'arbitration/harmony: cross-source same-pitch, m2, M7, m9 and density review',
    'final/micro-gap-enforcement: source-aware sub-1/64 micro-timing',
    'final/readiness: the per-song readiness gates',
    'final/mml-emitter: Final MML emission and technical round trip',
  ]),
  certifiesGates: Object.freeze([]),
});

// Factual capability record. `false` means this stage does not do the thing --
// either because it is out of G11-D scope or because doing it would need
// evidence this layer does not have. It never means the input was silently
// accepted as if it had been handled.
export const DECISION_APPLICATION_STATUS = Object.freeze({
  // Implemented in G11-D.
  sourceFaithfulBaselineImmutable: true,
  parentCandidateImmutable: true,
  transactionalAllOrNothing: true,
  contentDerivedRevisionIdentity: true,
  revisionLineageRetained: true,
  explicitAcceptanceRequired: true,
  staleDecisionRefused: true,
  revisionBindingRequired: true,
  baselineBindingRequired: true,
  sourceIdentityBindingRequired: true,
  canonicalIdentityBindingRequired: true,
  laneDecompositionBindingRequired: true,
  orderIndependentConflictDetection: true,
  reversibleEventLevelTrace: true,
  omissionRetainedInDiffAndLedger: true,
  duplicateProvenanceRetained: true,
  deterministicDerivedEventIdentity: true,
  leadDemotionGateEnforced: true,
  leadPromotionEvidenceRequired: true,
  parentGateMetadataStripped: true,

  // Deliberately not done here.
  suggestionAutoAcceptance: false,
  highestPitchBecomesMelody: false,
  notProvenVocalDemotes: false,
  lastDecisionWinsConflictResolution: false,
  sourceAuthorityBreaksTies: false,
  randomOrTimestampIdentity: false,
  sourceEventDeletion: false,
  pitchRewrite: false,
  octaveShift: false,
  onsetRewrite: false,
  durationRewrite: false,
  prominenceRewrite: false,
  tempoMapRewrite: false,
  meterMapRewrite: false,
  redistributeAcrossRoles: false,
  bestSixOptimizer: false,
  collisionRepair: false,
  volumeBalancing: false,
  instrumentAssignment: false,
  drumFaceMapping: false,
  mmlEmission: false,
  mmlCompression: false,
  characterLimitReduction: false,
  timingRepair: false,

  // Gates this stage explicitly does not certify.
  certifiesTechnicalPass: false,
  certifiesSourcePass: false,
  certifiesPlayerReadbackPass: false,
  certifiesAudioAlignmentPass: false,
  certifiesMobileAdaptationPass: false,
  certifiesInGameAccepted: false,
  certifiesCore3Complete: false,
  certifiesReadiness: false,

  stageNameAuthority: 'IMPLEMENTATION_STAGE_NAME_NOT_CANONICAL_RULE_IDENTIFIER',
});
