// G12 — Final Six-Role Reduction v1.
//
// The stage between an accepted G11-D role decision and Mobile Adaptation. It
// answers one question and publishes no verdict:
//
//   For every source-supported event that reaches this stage, where does it end
//   up in the six-role candidate that goes on to Gate 8 / Gate 9?
//
// What this stage is NOT
// ----------------------
// It is not an optimizer, not a scorer, and not a musical decision maker. It
// changes no pitch, no onset, no duration and no volume -- those are Mobile
// Adaptation's (Gate 8) and they stay there, so the two layers remain separable
// and separately reviewable. It does not delete source material to make a
// number smaller, to empty a conflict list, or to fit six roles: MASTER_RULES
// §2 puts `source-complete preservation before reduction` above every metric,
// and §3 forbids early deletion that would make later arbitration impossible.
//
// Where the decisions come from
// -----------------------------
// Every role move, duplication and omission this stage performs is an
// explicitly accepted, event-level, evidence-backed reduction decision supplied
// by a reviewer. The stage itself proposes nothing it then accepts on its own
// behalf. Material whose destination is a genuine musical choice stays PENDING,
// in the ledger, visible -- it is never resolved by a heuristic.
//
// The role application is not re-implemented here. A reduction decision is
// translated into the existing G11-D accepted-decision vocabulary and applied
// by `applyAcceptedArrangement()`, which owns the Lead demotion/promotion
// interlocks, the conflict codes, the acceptance bindings, the provenance
// invariants and the all-or-nothing atomicity. That is deliberate: a G12-only
// path around the Lead evidence contract is exactly what MASTER_RULES §4 and
// SOURCE_POLICY.md §4 forbid, and a second copy of the applier would be free to
// drift from the first.
//
// What a PASS means here
// ----------------------
// `status: 'PASS'` on a plan means *this reduction plan can be safely applied*.
// It is not Gate 4, not Gate 3, not Gate 5, not Gate 8, not Gate 9 and not
// IN_GAME_ACCEPTED. Applying it mints a derived candidate and re-opens every
// gate the reduction touched; `certifiesGates` is empty everywhere on purpose.

import { ROLES } from '../mml/index.mjs';
import { EFFECTIVE_RULESET } from '../rules/index.mjs';
import { canonicalIdentity } from '../final/emitter-contract.mjs';
import { emitFinalMml } from '../final/mml-emitter.mjs';
import { compareCanonicalVersions } from '../compare/version-drift.mjs';
import { analyzeCrossSourceHarmony, overlapRisks, overlapRiskKey, overlapPairBudgetExceeded, OVERLAP_PAIR_BUDGET } from '../arbitration/harmony.mjs';
import { evaluateCore3Completeness } from '../arbitration/core3-completeness.mjs';
import { suggestRoleCandidates } from '../arrangement/role-candidates.mjs';
import {
  ACCEPTED_DECISION_TYPES,
  CORE3_ROLE_NAMES,
  LEAD_ROLE,
  SIX_ROLES,
  baselineIdentityOf,
  candidateDigestOf,
  contentDigest,
  applyAcceptedArrangement,
} from '../arrangement/decision-application.mjs';
import { applicationIntegrity, baselineOriginResolver } from '../arrangement/decision-review.mjs';

export const FINAL_REDUCTION_STAGE = 'FINAL_SIX_ROLE_REDUCTION_V1';
export const REDUCTION_PLAN_SCHEMA = 'mml-studio/final-six-role-reduction-plan@1';
export const REDUCTION_DECISION_SCHEMA = 'mml-studio/final-six-role-reduction-decision@1';
export const REDUCTION_LEDGER_SCHEMA = 'mml-studio/final-six-role-reduction-ledger@1';
export const REDUCTION_APPLICATION_SCHEMA = 'mml-studio/final-six-role-reduction-application@1';
export const INSTRUMENT_PROFILE_SCHEMA = 'mml-studio/instrument-profile@1';

const syntax = EFFECTIVE_RULESET.mobileSyntax;
const CORE3 = new Set(CORE3_ROLE_NAMES);
const ENRICHMENT = SIX_ROLES.filter(role => !CORE3.has(role));

// ─── vocabulary ─────────────────────────────────────────────────────────────

/**
 * The five dispositions every accounted event lands on.
 *
 * `OMIT` is deliberately not something the planner can reach on its own: it
 * arrives only from an explicit, event-level, evidence-backed reviewer decision,
 * or as the record of an omission a *previous* accepted revision performed. "The
 * six roles were full" is a capacity fact, never a licence to delete.
 */
export const REDUCTION_OUTCOMES = Object.freeze({
  KEEP: 'KEEP',
  REDISTRIBUTE: 'REDISTRIBUTE',
  OVERFLOW: 'OVERFLOW',
  PENDING: 'PENDING',
  OMIT: 'OMIT',
});

// Which accounting bucket each outcome belongs to. The invariant in §7 of the
// stage contract is exactly "every accounted event is in one of these five".
export const REDUCTION_ACCOUNTING_BUCKETS = Object.freeze({
  KEEP: 'retained',
  REDISTRIBUTE: 'redistributed',
  OVERFLOW: 'overflow',
  PENDING: 'pending',
  OMIT: 'omitted',
});

/** What a reviewer may decide at this stage. */
export const REDUCTION_ACTIONS = Object.freeze({
  // Record that the reviewer looked at this material and accepts its role.
  KEEP: 'KEEP',
  // Move it to another of the six roles, or give a role to material that has
  // none. Melody in either direction goes through the Lead evidence contract.
  REDISTRIBUTE: 'REDISTRIBUTE',
  // Sound one source event in a second role as well. Enrichment, not reduction;
  // it exists here so that "duplicate into Melody" reaches the same Lead gate.
  DUPLICATE: 'DUPLICATE',
  // Leave it outside the six roles, on the record, with a reason.
  ACCEPT_OVERFLOW: 'ACCEPT_OVERFLOW',
  // Drop it from the candidate. Evidence-backed and reviewer-accepted only.
  OMIT: 'OMIT',
});

export const REDUCTION_REASON_CODES = Object.freeze({
  ROLE_ALREADY_ACCEPTED: 'ROLE_ALREADY_ACCEPTED',
  REVIEWER_ACCEPTED_KEEP: 'REVIEWER_ACCEPTED_KEEP',
  REVIEWER_ACCEPTED_REDISTRIBUTION: 'REVIEWER_ACCEPTED_REDISTRIBUTION',
  REVIEWER_ACCEPTED_DUPLICATION: 'REVIEWER_ACCEPTED_DUPLICATION',
  REVIEWER_ACCEPTED_OVERFLOW: 'REVIEWER_ACCEPTED_OVERFLOW',
  REVIEWER_ACCEPTED_OMISSION: 'REVIEWER_ACCEPTED_OMISSION',
  OMITTED_BEFORE_REDUCTION: 'OMITTED_BEFORE_REDUCTION',
  SIX_ROLE_CAPACITY_EXCEEDED: 'SIX_ROLE_CAPACITY_EXCEEDED',
  ROLE_DECISION_REQUIRED: 'ROLE_DECISION_REQUIRED',
  PERCUSSION_DRUM_FACE_MAPPING_REQUIRED: 'PERCUSSION_DRUM_FACE_MAPPING_REQUIRED',
  UNSUPPORTED_SOURCE_MATERIAL: 'UNSUPPORTED_SOURCE_MATERIAL',
});

export const REDUCTION_BLOCKERS = Object.freeze({
  SOURCE_EVENT_NOT_TRACEABLE: 'SOURCE_EVENT_NOT_TRACEABLE',
  EVENT_UNACCOUNTED: 'REDUCTION_EVENT_UNACCOUNTED',
  DECISION_TARGET_NOT_FOUND: 'REDUCTION_DECISION_TARGET_NOT_FOUND',
  DECISION_TARGET_NOT_A_NOTE: 'REDUCTION_DECISION_TARGET_NOT_A_NOTE',
  DECISION_CONFLICT: 'REDUCTION_DECISION_CONFLICT',
  DECISION_REJECTED: 'REDUCTION_DECISION_REJECTED_BY_ROLE_APPLICATION',
  OMISSION_EVIDENCE_REQUIRED: 'REDUCTION_OMISSION_EVIDENCE_REQUIRED',
  REDISTRIBUTION_EVIDENCE_REQUIRED: 'REDUCTION_REDISTRIBUTION_EVIDENCE_REQUIRED',
  PERCUSSION_IN_PITCHED_ROLE: 'REDUCTION_PERCUSSION_IN_PITCHED_ROLE',
  PERCUSSION_ROLE_ASSIGNMENT_REFUSED: 'REDUCTION_PERCUSSION_ROLE_ASSIGNMENT_REFUSED',
  CORE3_INCOMPLETE: 'REDUCTION_CORE3_INCOMPLETE',
  CORE3_REGRESSION: 'REDUCTION_CORE3_REGRESSION',
  NEW_OVERLAP_RISK: 'REDUCTION_NEW_OVERLAP_RISK_REQUIRES_REVIEW',
  NEW_CROSS_SOURCE_CONFLICT: 'REDUCTION_NEW_CROSS_SOURCE_CONFLICT_REQUIRES_REVIEW',
  COLLISION_SCAN_LIMIT: 'REDUCTION_COLLISION_SCAN_LIMIT',
  PARENT_INTEGRITY_MISMATCH: 'REDUCTION_PARENT_INTEGRITY_MISMATCH',
  CANDIDATE_NOT_THE_APPLICATION_TARGET: 'REDUCTION_CANDIDATE_NOT_THE_APPLICATION_TARGET',
  PARENT_CANONICAL_MISMATCH: 'REDUCTION_PARENT_CANONICAL_MISMATCH',
  STALE_PLAN: 'STALE_FINAL_REDUCTION_PLAN',
  NOTHING_TO_APPLY: 'REDUCTION_NOTHING_TO_APPLY',
});

export const REDUCTION_WARNINGS = Object.freeze({
  EXISTING_OVERLAP_RISKS: 'EXISTING_OVERLAP_RISKS_REQUIRE_REVIEW',
  EXISTING_CROSS_SOURCE_CONFLICTS: 'EXISTING_CROSS_SOURCE_CONFLICTS_REQUIRE_REVIEW',
  OVERFLOW_RETAINED: 'OVERFLOW_MATERIAL_RETAINED',
  PENDING_RETAINED: 'PENDING_MATERIAL_RETAINED',
  UNSUPPORTED_RETAINED: 'UNSUPPORTED_MATERIAL_RETAINED',
  PERCUSSION_RETAINED: 'PERCUSSION_MATERIAL_RETAINED',
  CHARACTER_BUDGET_EXCEEDED: 'CHARACTER_BUDGET_EXCEEDED',
  CHARACTER_BUDGET_NOT_MEASURED: 'CHARACTER_BUDGET_NOT_MEASURED',
  UPSTREAM_OMISSION_NOT_VERIFIED: 'UPSTREAM_OMISSION_NOT_VERIFIED',
  CORE3_UNRESOLVED: 'CORE3_COMPLETENESS_UNRESOLVED',
  CORE3_DEPENDS_ON_ENRICHMENT: 'CORE3_DEPENDS_ON_ENRICHMENT',
  TIMBRE_DIAGNOSTIC_ONLY: 'TIMBRE_EVIDENCE_IS_DIAGNOSTIC_ONLY',
});

// ─── small helpers ──────────────────────────────────────────────────────────

const plain = value => Boolean(value) && typeof value === 'object' && !Array.isArray(value);
const cmpStr = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
const string = value => typeof value === 'string' && value.trim().length > 0;
const notes = project => (project?.events ?? []).filter(event => event.kind === 'note');
const uniqueSorted = values => [...new Set(values)].sort(cmpStr);

function requireKeys(value, allowed, name) {
  if (!plain(value)) throw Error(`${name} must be an object`);
  for (const key of Object.keys(value)) if (!allowed.includes(key)) throw Error(`${name}.${key} is unsupported`);
}

// MASTER_RULES §8: General MIDI drum note numbers are not ordinary pitched
// Mobile notes. The same three markers the Mobile adaptation stage reads.
const isPercussion = event => event?.metadata?.channel === 9
  || event?.metadata?.percussion === true
  || (event?.tags ?? []).includes('percussion');

// ─── optional instrument / timbre profile ───────────────────────────────────

/**
 * An OPTIONAL, diagnostic-only instrument profile.
 *
 * This exists so a future Timbre-Aware Reduction has a clean place to plug in,
 * and so that research artefacts (a DLS sound pack, a `.def` preset list, a
 * measured register sweep) have a shape to be carried in. It is deliberately
 * inert:
 *
 *   * G12 runs identically with and without it. Every outcome, every blocker
 *     and the plan's own identity are computed before it is read, and a
 *     regression asserts the two plans are equal apart from the diagnostics.
 *   * It can never decide KEEP, REDISTRIBUTE, OMIT or overflow, and it can
 *     never clear a gate. There is no published evidence that any third-party
 *     sound pack is equivalent to the target Mabinogi Mobile client's timbre,
 *     so SOURCE_POLICY.md gives it no authority to spend.
 *   * `verificationStatus` is a *claim by the supplier*, not a verification
 *     this module performed. Even `VERIFIED` buys nothing here: what it would
 *     buy is a Canonical question, not an implementation one.
 */
export function normalizeInstrumentProfile(input) {
  requireKeys(input, ['schema', 'instrumentId', 'targetClient', 'evidence', 'verificationStatus', 'pitch', 'dynamics', 'timbre'], 'instrumentProfile');
  if (input.schema !== INSTRUMENT_PROFILE_SCHEMA) throw Error('unsupported instrument profile schema');
  if (!string(input.instrumentId) || input.instrumentId.length > 120) throw Error('instrumentProfile.instrumentId is required');
  if (!string(input.targetClient) || input.targetClient.length > 200) throw Error('instrumentProfile.targetClient is required');
  const status = input.verificationStatus ?? 'UNVERIFIED';
  if (!['UNVERIFIED', 'PARTIAL', 'VERIFIED'].includes(status)) throw Error('instrumentProfile.verificationStatus must be UNVERIFIED, PARTIAL or VERIFIED');
  const evidence = Array.isArray(input.evidence) ? input.evidence : [];
  if (evidence.length > 50 || evidence.some(ref => !string(ref) || ref.length > 1000)) throw Error('instrumentProfile.evidence must be at most 50 reference strings');
  const range = (value, name) => {
    if (value === undefined || value === null) return [null, null];
    if (!Array.isArray(value) || value.length !== 2) throw Error(`${name} must be [min, max]`);
    return value.map(item => {
      if (item === null) return null;
      if (!Number.isInteger(item) || item < 0 || item > 127) throw Error(`${name} entries must be null or a MIDI integer`);
      return item;
    });
  };
  const pitch = plain(input.pitch) ? input.pitch : {};
  requireKeys(pitch, ['testedRange', 'usableRange', 'weakRegions'], 'instrumentProfile.pitch');
  const weakRegions = Array.isArray(pitch.weakRegions) ? pitch.weakRegions : [];
  if (weakRegions.length > 50) throw Error('instrumentProfile.pitch.weakRegions is limited to 50 entries');
  const text = (value, name, max = 400) => {
    if (value === undefined || value === null) return null;
    if (!string(value) || value.length > max) throw Error(`${name} must be null or a short string`);
    return value.trim();
  };
  const dynamics = plain(input.dynamics) ? input.dynamics : {};
  requireKeys(dynamics, ['volumeResponse'], 'instrumentProfile.dynamics');
  const timbre = plain(input.timbre) ? input.timbre : {};
  requireKeys(timbre, ['attack', 'sustain', 'decay'], 'instrumentProfile.timbre');
  return Object.freeze({
    schema: INSTRUMENT_PROFILE_SCHEMA,
    instrumentId: input.instrumentId.trim(),
    targetClient: input.targetClient.trim(),
    evidence: Object.freeze(uniqueSorted(evidence.map(ref => ref.trim()))),
    verificationStatus: status,
    pitch: Object.freeze({
      testedRange: Object.freeze(range(pitch.testedRange, 'instrumentProfile.pitch.testedRange')),
      usableRange: Object.freeze(range(pitch.usableRange, 'instrumentProfile.pitch.usableRange')),
      weakRegions: Object.freeze(weakRegions.map((region, index) => Object.freeze(range(region, `instrumentProfile.pitch.weakRegions[${index}]`)))),
    }),
    dynamics: Object.freeze({ volumeResponse: text(dynamics.volumeResponse, 'instrumentProfile.dynamics.volumeResponse') }),
    timbre: Object.freeze({
      attack: text(timbre.attack, 'instrumentProfile.timbre.attack'),
      sustain: text(timbre.sustain, 'instrumentProfile.timbre.sustain'),
      decay: text(timbre.decay, 'instrumentProfile.timbre.decay'),
    }),
    authority: 'DIAGNOSTIC_ONLY',
    notice: 'An optional, unauthenticated instrument profile. It produces diagnostics only: it decides no role, omits no material, resolves no PENDING and certifies no ACCEPTANCE_CRITERIA.md gate. Equivalence between any third-party sound pack and the target Mabinogi Mobile client is unproven.',
  });
}

// Register observations only, per role, and only for roles whose material is
// actually outside a *stated* usable range. Never a blocker, never an outcome.
function timbreDiagnostics(project, profile) {
  const [low, high] = profile.pitch.usableRange;
  const weak = profile.pitch.weakRegions.filter(region => region[0] !== null && region[1] !== null);
  const observations = [];
  for (const role of SIX_ROLES) {
    const roleNotes = notes(project).filter(event => event.role === role);
    if (!roleNotes.length) continue;
    const outside = low === null && high === null ? [] : roleNotes.filter(event =>
      (low !== null && event.pitch < low) || (high !== null && event.pitch > high));
    const inWeak = roleNotes.filter(event => weak.some(([from, to]) => event.pitch >= from && event.pitch <= to));
    if (!outside.length && !inWeak.length) continue;
    observations.push(Object.freeze({
      role,
      outsideStatedUsableRange: Object.freeze(uniqueSorted(outside.map(event => event.id))),
      insideStatedWeakRegion: Object.freeze(uniqueSorted(inWeak.map(event => event.id))),
    }));
  }
  return Object.freeze({
    instrumentId: profile.instrumentId,
    targetClient: profile.targetClient,
    verificationStatus: profile.verificationStatus,
    observations: Object.freeze(observations),
    influencedOutcomes: false,
    notice: profile.notice,
  });
}

// ─── reduction decisions ────────────────────────────────────────────────────

const DECISION_KEYS = ['schema', 'id', 'action', 'eventIds', 'fromRole', 'toRole', 'toRoles', 'reason', 'evidence', 'leadEvidence', 'note'];

/**
 * Normalize one explicitly accepted reduction decision.
 *
 * Deliberately narrow. A decision names *events*, never a lane: the accounting
 * invariant is event-level, and a lane-shaped omission is precisely the kind of
 * bulk deletion §3 of SOURCE_POLICY forbids. It carries no pitch, onset,
 * duration or volume field -- an unknown key is a rejection, so a register or
 * prominence edit cannot ride into this stage inside a role decision. Those
 * belong to Mobile Adaptation and stay there.
 */
export function normalizeReductionDecision(input) {
  requireKeys(input, DECISION_KEYS, 'reductionDecision');
  if (input.schema !== undefined && input.schema !== REDUCTION_DECISION_SCHEMA) throw Error('unsupported reduction decision schema');
  if (!string(input.id) || input.id.length > 200) throw Error('reductionDecision.id is required');
  const action = input.action;
  if (!string(action) || !Object.hasOwn(REDUCTION_ACTIONS, action.trim())) throw Error(`unknown reductionDecision.action: ${String(action).slice(0, 60)}`);
  const normalizedAction = action.trim();
  if (!Array.isArray(input.eventIds) || !input.eventIds.length || input.eventIds.length > 5000) throw Error('reductionDecision.eventIds must name between 1 and 5000 candidate events');
  const eventIds = uniqueSorted(input.eventIds.map((id, index) => {
    if (!string(id) || id.length > 300) throw Error(`reductionDecision.eventIds[${index}] must be a non-empty event id`);
    return id.trim();
  }));
  if (!string(input.reason) || input.reason.length > 2000) throw Error('reductionDecision.reason must state a positive reason');
  const evidence = uniqueSorted((Array.isArray(input.evidence) ? input.evidence : []).map((ref, index) => {
    if (!string(ref) || ref.length > 1000) throw Error(`reductionDecision.evidence[${index}] must be a reference string`);
    return ref.trim();
  }));
  const role = (value, name) => {
    if (value === undefined || value === null) return null;
    if (!SIX_ROLES.includes(value)) throw Error(`${name} must be one of: ${SIX_ROLES.join(', ')}`);
    return value;
  };
  const fromRole = role(input.fromRole, 'reductionDecision.fromRole');
  let toRole = role(input.toRole, 'reductionDecision.toRole');
  let toRoles = null;
  if (normalizedAction === REDUCTION_ACTIONS.REDISTRIBUTE) {
    if (!toRole) throw Error('REDISTRIBUTE requires reductionDecision.toRole');
    if (input.toRoles !== undefined && input.toRoles !== null) throw Error('REDISTRIBUTE uses reductionDecision.toRole, not toRoles');
  } else if (normalizedAction === REDUCTION_ACTIONS.DUPLICATE) {
    if (toRole) throw Error('DUPLICATE uses reductionDecision.toRoles, not toRole');
    const list = Array.isArray(input.toRoles) ? input.toRoles : [];
    if (!list.length) throw Error('DUPLICATE requires reductionDecision.toRoles');
    for (const item of list) role(item, 'reductionDecision.toRoles[]');
    toRoles = Object.freeze(uniqueSorted(list));
  } else {
    if (toRole) throw Error(`${normalizedAction} takes no destination role`);
    if (input.toRoles !== undefined && input.toRoles !== null) throw Error(`${normalizedAction} takes no destination roles`);
    toRole = null;
  }
  // The evidence obligation, stated here rather than left to the caller.
  // ACCEPT_OVERFLOW is the one action that changes nothing and removes nothing:
  // it records that a reviewer saw material stay outside the six roles, so it
  // asks for a reason and not a citation. Everything else moves or removes
  // source-supported music and must cite why.
  if (normalizedAction !== REDUCTION_ACTIONS.ACCEPT_OVERFLOW && normalizedAction !== REDUCTION_ACTIONS.KEEP && !evidence.length) {
    throw Error(`${normalizedAction} requires at least one evidence reference`);
  }
  const leadEvidence = input.leadEvidence === undefined || input.leadEvidence === null ? null : structuredClone(input.leadEvidence);
  if (leadEvidence !== null && !plain(leadEvidence)) throw Error('reductionDecision.leadEvidence must be an object');
  const note = input.note === undefined || input.note === null ? null : String(input.note).slice(0, 2000);
  return Object.freeze({
    schema: REDUCTION_DECISION_SCHEMA,
    id: input.id.trim(),
    action: normalizedAction,
    eventIds: Object.freeze(eventIds),
    fromRole,
    toRole,
    toRoles,
    reason: input.reason.trim(),
    evidence: Object.freeze(evidence),
    leadEvidence,
    note,
  });
}

function normalizeReductionDecisions(input) {
  if (input === undefined || input === null) return [];
  if (!Array.isArray(input)) throw Error('reduction decisions must be an array');
  if (input.length > 2000) throw Error('a reduction decision set is limited to 2000 decisions');
  const normalized = input.map(normalizeReductionDecision);
  const ids = new Set();
  for (const decision of normalized) {
    if (ids.has(decision.id)) throw Error(`duplicate reduction decision id: ${decision.id}`);
    ids.add(decision.id);
  }
  return normalized.sort((a, b) => cmpStr(a.id, b.id));
}

/**
 * Translate reduction decisions into the existing G11-D accepted vocabulary.
 *
 * The acceptance bindings are computed from the baseline and Canonical release
 * loaded *now* and are never taken from a caller: an identity a caller can
 * supply is an identity a caller can make stale-proof, and these bindings exist
 * precisely to catch a decision reviewed against different inputs.
 */
function toRoleDecisions(decisions, { currentRoleOf, baselineIdentity, canonical, parentRevisionId, acceptedBy }) {
  const acceptance = {
    state: 'ACCEPTED',
    acceptedBy,
    reviewedRevisionId: parentRevisionId,
    baselineContentDigest: baselineIdentity.contentDigest,
    sourceIdentityDigest: baselineIdentity.sourceIdentityDigest,
    laneDecompositionDigest: null,
    canonicalRulesSnapshotSha: canonical.rules_snapshot_sha,
  };
  const built = [];
  for (const decision of decisions) {
    const common = {
      id: `g12:${decision.id}`,
      target: { eventIds: [...decision.eventIds] },
      reason: decision.reason,
      evidence: [...decision.evidence],
      acceptance,
      ...(decision.leadEvidence ? { leadEvidence: decision.leadEvidence } : {}),
      metadata: { g12: { reductionDecisionId: decision.id, action: decision.action } },
    };
    switch (decision.action) {
      case REDUCTION_ACTIONS.KEEP:
        built.push({ ...common, type: ACCEPTED_DECISION_TYPES.KEEP, ...(decision.fromRole ? { fromRole: decision.fromRole } : {}) });
        break;
      case REDUCTION_ACTIONS.REDISTRIBUTE: {
        // ASSIGN_ROLE gives unassigned material a role; MOVE_ROLE moves material
        // that already has one, and G11-D requires `fromRole` so a stale move
        // cannot be replayed onto a different role. Which one this is depends on
        // the events named, so a decision that mixes the two is split rather
        // than forced into one type that would be wrong for half of it.
        const assigned = decision.eventIds.filter(id => currentRoleOf(id) !== null);
        const unassigned = decision.eventIds.filter(id => currentRoleOf(id) === null);
        if (unassigned.length) built.push({ ...common, id: `${common.id}#assign`, target: { eventIds: unassigned }, type: ACCEPTED_DECISION_TYPES.ASSIGN_ROLE, toRole: decision.toRole });
        for (const role of uniqueSorted(assigned.map(id => currentRoleOf(id)))) {
          const events = assigned.filter(id => currentRoleOf(id) === role);
          built.push({ ...common, id: `${common.id}#move:${role}`, target: { eventIds: events }, type: ACCEPTED_DECISION_TYPES.MOVE_ROLE, fromRole: role, toRole: decision.toRole });
        }
        break;
      }
      case REDUCTION_ACTIONS.DUPLICATE:
        built.push({ ...common, type: ACCEPTED_DECISION_TYPES.DUPLICATE_WITH_JUSTIFICATION, toRoles: [...decision.toRoles] });
        break;
      case REDUCTION_ACTIONS.OMIT:
        built.push({ ...common, type: ACCEPTED_DECISION_TYPES.OMIT_FROM_SIX, ...(decision.fromRole ? { fromRole: decision.fromRole } : {}) });
        break;
      case REDUCTION_ACTIONS.ACCEPT_OVERFLOW:
        // Changes no event and claims no role: a KEEP over material that has
        // none records that the reviewer looked at it and accepts it staying
        // outside the six roles. G11-D refuses a KEEP that would change a role,
        // so this cannot quietly place anything.
        built.push({ ...common, type: ACCEPTED_DECISION_TYPES.KEEP });
        break;
      default:
        break;
    }
  }
  return built;
}

// ─── reduction analysis (G12-A) ─────────────────────────────────────────────

// Which of the six roles currently carry material, and how loaded each is.
// "Capacity" here is a fact about the delivered candidate, never a budget the
// planner is allowed to spend by deleting music.
function roleCapacityOf(project, characterCounts) {
  const perRole = SIX_ROLES.map(role => {
    const roleNotes = notes(project).filter(event => event.role === role);
    const characters = characterCounts?.get(role) ?? null;
    return Object.freeze({
      role,
      core3: CORE3.has(role),
      noteCount: roleNotes.length,
      occupied: roleNotes.length > 0,
      characters,
      characterLimit: syntax.perTrackCharacterLimit ?? null,
      overBudget: characters !== null && syntax.perTrackCharacterLimit ? characters > syntax.perTrackCharacterLimit : false,
    });
  });
  return Object.freeze({
    perRole: Object.freeze(perRole),
    occupied: Object.freeze(perRole.filter(entry => entry.occupied).map(entry => entry.role)),
    free: Object.freeze(perRole.filter(entry => !entry.occupied).map(entry => entry.role)),
    freeEnrichment: Object.freeze(perRole.filter(entry => !entry.occupied && ENRICHMENT.includes(entry.role)).map(entry => entry.role)),
  });
}

/**
 * Per-role MML character pressure, measured with the real Final emitter.
 *
 * MOBILE_SYNTAX's per-role character limit is a *constraint to report*, not a
 * licence to delete notes: "Chord5 is over 2400" is never a reason to remove
 * source-supported music (MASTER_RULES §2). Real canonicalization and syntax
 * compression belong to the Final pipeline downstream, so a measurement that
 * cannot be taken is reported as not taken rather than guessed.
 */
function characterBudgetOf(project) {
  let emitted;
  try { emitted = emitFinalMml(project); }
  catch (error) { return { status: 'NOT_MEASURED', reason: error.message, limit: syntax.perTrackCharacterLimit ?? null, perRole: [], overBudget: [], counts: null }; }
  const perRole = emitted?.characterCounts?.perRole ?? [];
  if (!perRole.length) {
    return { status: 'NOT_MEASURED', reason: `emitter status ${emitted?.status ?? 'UNKNOWN'}`, limit: emitted?.characterCounts?.limit ?? syntax.perTrackCharacterLimit ?? null, perRole: [], overBudget: [], counts: null };
  }
  const limit = emitted.characterCounts.limit;
  const overBudget = perRole.filter(entry => entry.characters > limit).map(entry => Object.freeze({ role: entry.role, characters: entry.characters, limit, overBy: entry.characters - limit }));
  return {
    status: 'MEASURED',
    reason: null,
    limit,
    perRole: perRole.map(entry => Object.freeze({ role: entry.role, characters: entry.characters })),
    overBudget,
    counts: new Map(perRole.map(entry => [entry.role, entry.characters])),
  };
}

// A deterministic, diagnostic-only ranking of where undecided material *could*
// go, offered so a reviewer has somewhere to start.
//
// It accepts nothing. Every term is an integer, an exact beat string or an id,
// so the order is reproducible; and the result is attached to a PENDING item,
// which stays PENDING. MASTER_RULES §2 puts the musical decision above any
// statistic, so a suggestion never becomes an outcome and never removes an
// event. Where a real musical choice exists, the answer is PENDING.
function suggestionsFor(event, capacity, analysis) {
  const laneRole = analysis?.roleByEventId?.get(event.id) ?? null;
  const ranked = capacity.free.map(role => ({
    role,
    core3: CORE3.has(role),
    proposedByRoleAnalysis: laneRole === role,
  })).sort((a, b) =>
    Number(b.proposedByRoleAnalysis) - Number(a.proposedByRoleAnalysis)
    || Number(a.core3) - Number(b.core3)
    || cmpStr(a.role, b.role));
  return Object.freeze(ranked.slice(0, 6).map(entry => Object.freeze({
    role: entry.role,
    proposedByRoleAnalysis: entry.proposedByRoleAnalysis,
    authority: 'SUGGESTION_ONLY',
  })));
}

// The G11-C evaluation, read for diagnostics and suggestion ordering only.
// A failure to read it is reported, never thrown: an arrangement the role
// evaluator cannot parse still has to be accounted for, event by event.
function roleAnalysisOf(project) {
  try {
    const suggestion = suggestRoleCandidates(project);
    // The lane's own proposal field is `candidateRole`. Reading a field G11-C
    // does not publish would leave this index silently empty, which is a
    // suggestion list that quietly never suggests anything.
    const roleByEventId = new Map();
    for (const lane of suggestion.lanes ?? []) {
      const role = lane.candidateRole ?? null;
      if (!role || !SIX_ROLES.includes(role)) continue;
      for (const eventId of lane.eventIds ?? []) roleByEventId.set(eventId, role);
    }
    return {
      ok: true,
      error: null,
      roleByEventId,
      core3: suggestion.core3 ?? null,
      full6: suggestion.full6 ?? null,
      coverage: suggestion.coverage ?? null,
      unsupportedSourceMaterial: suggestion.unsupportedSourceMaterial ?? [],
      pending: suggestion.pending ?? [],
      diagnostics: suggestion.diagnostics ?? [],
    };
  } catch (error) {
    return { ok: false, error: error.message, roleByEventId: new Map(), core3: null, full6: null, coverage: null, unsupportedSourceMaterial: [], pending: [], diagnostics: [] };
  }
}

// G11-C reports unsupported material one event at a time, as `eventId`. Reading
// a plural field it does not publish would make the UNSUPPORTED_SOURCE_MATERIAL
// reason code unreachable, and unsupported material would be reported under the
// ordinary "a reviewer has not decided yet" code instead of as unsupported.
const unsupportedEventIdsOf = analysis => new Set((analysis.unsupportedSourceMaterial ?? [])
  .flatMap(item => (item?.eventIds ?? (string(item?.eventId) ? [item.eventId] : []))));

/**
 * The parent application a derived candidate carries inside itself.
 *
 * A candidate minted by an accepted application records its own revision and
 * the Source-Faithful snapshot it was derived from. When a caller hands in such
 * a candidate without the stored application wrapper -- the local Web plane,
 * a reload, a second reduction over a reduction -- the envelope is rebuilt from
 * that provenance and then put through the ordinary `applicationIntegrity`
 * check like any other. Nothing is asserted: a candidate whose revision does not
 * recompute from its own content, whose digest does not match, or whose snapshot
 * is not this baseline, fails that check exactly as a forged one would.
 *
 * This mints no revision and invents no provenance. A candidate with no
 * derivation record returns null and is handled by the caller.
 */
function recoverParentFromCandidate(baseline, candidate) {
  const revision = candidate?.metadata?.g11d?.revision ?? null;
  if (!plain(revision)) return null;
  const rebuilt = { status: 'PASS', candidate, revision };
  return applicationIntegrity(rebuilt, baseline).ok ? rebuilt : null;
}

// ─── the plan (G12-B) ───────────────────────────────────────────────────────

/**
 * A read-only, deterministic, content-bound Final Six-Role Reduction plan.
 *
 * `status: 'PASS'` means the plan is executable. It is not a gate result.
 *
 * Inputs:
 *   baseline               the Source-Faithful Baseline. Read, never written.
 *   candidate              the G11-D candidate (or later revision) to reduce.
 *   parent                 the stored application that produced `candidate`.
 *   decisions              explicitly accepted, event-level reduction decisions.
 *   acceptedBy             the reviewer the acceptance bindings are recorded for.
 *   parentOmittedEventIds  baseline events earlier accepted revisions omitted,
 *                          recovered from the stored lineage by the caller that
 *                          can read it. Without it an absent baseline event is
 *                          still accounted -- as an upstream omission this stage
 *                          could not verify, which is a visible warning rather
 *                          than a silent disappearance.
 *   instrumentProfile      optional; diagnostics only (see above).
 */
export function planFinalReduction({
  baseline,
  candidate = baseline,
  parent = null,
  decisions = [],
  acceptedBy = 'reduction-preview',
  parentOmittedEventIds = null,
  instrumentProfile = null,
} = {}) {
  if (!baseline?.events || !candidate?.events) throw Error('Final Six-Role Reduction requires a Source-Faithful Baseline and a Canonical candidate');
  if (!string(acceptedBy) || acceptedBy.length > 120) throw Error('acceptedBy is required');
  const normalizedDecisions = normalizeReductionDecisions(decisions);
  const canonical = canonicalIdentity();
  const baselineIdentity = baselineIdentityOf(baseline);
  const parentCandidateIdentity = baselineIdentityOf(candidate);
  const inputDigest = candidateDigestOf(candidate);
  const blockers = [];
  const warnings = [];
  const addBlocker = (code, detail = {}) => blockers.push(Object.freeze({ code, ...detail }));
  const addWarning = (code, detail = {}) => warnings.push(Object.freeze({ code, ...detail }));

  // ── parent binding ──
  //
  // The role application applies decisions onto `parent.candidate`, or onto the
  // baseline when there is no parent. So the project this plan describes and
  // the project the decisions would land on have to be the same project. A
  // candidate that differs from the baseline with no parent to apply onto is
  // refused rather than quietly reduced against the baseline instead, which
  // would throw away exactly the role decisions this stage exists to converge.
  const resolvedParent = parent ?? recoverParentFromCandidate(baseline, candidate);
  let parentRevisionId = null;
  let parentIndex = 0;
  if (resolvedParent !== null) {
    const integrity = applicationIntegrity(resolvedParent, baseline);
    if (!integrity.ok) addBlocker(REDUCTION_BLOCKERS.PARENT_INTEGRITY_MISMATCH, { reasons: Object.freeze([...integrity.reasons]) });
    else if (candidateDigestOf(candidate) !== resolvedParent.revision.candidateDigest) addBlocker(REDUCTION_BLOCKERS.PARENT_INTEGRITY_MISMATCH, { reasons: Object.freeze(['PARENT_CANDIDATE_DIGEST_MISMATCH']) });
    if (resolvedParent.revision?.canonicalIdentity?.rules_snapshot_sha !== canonical.rules_snapshot_sha) addBlocker(REDUCTION_BLOCKERS.PARENT_CANONICAL_MISMATCH, { expected: canonical.rules_snapshot_sha, observed: resolvedParent.revision?.canonicalIdentity?.rules_snapshot_sha ?? null });
    parentRevisionId = resolvedParent.revision?.id ?? null;
    parentIndex = Number.isInteger(resolvedParent.revision?.index) ? resolvedParent.revision.index : 0;
  } else if (candidateDigestOf(candidate) !== candidateDigestOf(baseline)) {
    addBlocker(REDUCTION_BLOCKERS.CANDIDATE_NOT_THE_APPLICATION_TARGET, {
      detail: 'The candidate differs from the Source-Faithful Baseline and carries no verifiable derivation from it, so a reduction decision has nothing to be applied onto. Reduce a candidate produced by an accepted application, or one identical to the baseline.',
    });
  }

  // ── analysis inputs ──
  const candidateNotes = notes(candidate).slice().sort((a, b) => cmpStr(a.id, b.id));
  const candidateById = new Map(candidate.events.map(event => [event.id, event]));
  const resolveOrigin = baselineOriginResolver(baseline, candidate);
  const currentRoleOf = eventId => candidateById.get(eventId)?.role ?? null;
  const analysis = roleAnalysisOf(candidate);
  const unsupportedIds = unsupportedEventIdsOf(analysis);
  const budgetBefore = characterBudgetOf(candidate);
  const capacity = roleCapacityOf(candidate, budgetBefore.counts);
  // Which roles are still free *after* this plan's own decisions. Classifying
  // undecided material against the capacity before them would call an event
  // PENDING on the strength of a slot the same plan has just filled.
  let capacityAfter = capacity;

  // ── decision targets ──
  const decisionByEventId = new Map();
  for (const decision of normalizedDecisions) {
    for (const eventId of decision.eventIds) {
      const event = candidateById.get(eventId);
      if (!event) { addBlocker(REDUCTION_BLOCKERS.DECISION_TARGET_NOT_FOUND, { decisionId: decision.id, eventId }); continue; }
      if (event.kind !== 'note') { addBlocker(REDUCTION_BLOCKERS.DECISION_TARGET_NOT_A_NOTE, { decisionId: decision.id, eventId }); continue; }
      if (decisionByEventId.has(eventId)) {
        addBlocker(REDUCTION_BLOCKERS.DECISION_CONFLICT, { eventId, decisionIds: Object.freeze(uniqueSorted([decisionByEventId.get(eventId).id, decision.id])) });
        continue;
      }
      decisionByEventId.set(eventId, decision);
      // MASTER_RULES §8. Drum material is not pitched Mobile material, and the
      // six pitched roles are not where an unmapped drum face goes.
      if (isPercussion(event) && [REDUCTION_ACTIONS.REDISTRIBUTE, REDUCTION_ACTIONS.DUPLICATE].includes(decision.action)) {
        addBlocker(REDUCTION_BLOCKERS.PERCUSSION_ROLE_ASSIGNMENT_REFUSED, { decisionId: decision.id, eventId });
      }
      if (decision.action === REDUCTION_ACTIONS.OMIT && !decision.evidence.length) addBlocker(REDUCTION_BLOCKERS.OMISSION_EVIDENCE_REQUIRED, { decisionId: decision.id, eventId });
      if (decision.action === REDUCTION_ACTIONS.REDISTRIBUTE && !decision.evidence.length) addBlocker(REDUCTION_BLOCKERS.REDISTRIBUTION_EVIDENCE_REQUIRED, { decisionId: decision.id, eventId });
    }
  }

  // ── derive the proposed candidate through the existing G11-D applier ──
  //
  // Not a second implementation of role application: the same function that
  // will perform the real apply produces the projection this plan reports on,
  // so the Lead interlocks, the conflict vocabulary and the provenance
  // invariants that decide the outcome are the ones that decided it here.
  const roleDecisions = toRoleDecisions(normalizedDecisions, { currentRoleOf, baselineIdentity, canonical, parentRevisionId, acceptedBy: acceptedBy.trim() });
  let derivation = null;
  if (roleDecisions.length) {
    try { derivation = applyAcceptedArrangement({ baseline, parent: resolvedParent, decisions: roleDecisions, canonicalIdentity: canonical, stage: FINAL_REDUCTION_STAGE }); }
    catch (error) { addBlocker(REDUCTION_BLOCKERS.DECISION_REJECTED, { detail: error.message }); }
    if (derivation && derivation.status !== 'PASS') {
      for (const rejection of derivation.rejected) addBlocker(REDUCTION_BLOCKERS.DECISION_REJECTED, { decisionId: rejection.decisionId ?? null, rejection: rejection.code, detail: rejection.detail ?? null });
      for (const conflict of derivation.conflicts) addBlocker(REDUCTION_BLOCKERS.DECISION_CONFLICT, { conflict: conflict.code ?? null, eventId: conflict.eventId ?? null });
    }
  }
  const proposed = derivation?.status === 'PASS' ? derivation.candidate : candidate;
  const proposedById = new Map(proposed.events.map(event => [event.id, event]));
  // Identical projects produce identical measurements, so a plan with no role
  // change does not pay for a second Final emission to learn that.
  const budgetAfter = proposed === candidate ? budgetBefore : characterBudgetOf(proposed);
  if (proposed !== candidate) capacityAfter = roleCapacityOf(proposed, budgetAfter.counts);
  const proposedOmittedIds = new Set((derivation?.omitted ?? []).map(item => item.eventId));

  // ── event accounting ledger ──
  //
  // Keyed on the Source-Faithful Baseline's own note events: those are the
  // source-supported events entering this stage, and the invariant is about
  // them. Derived duplicates are attached to the origin they copy, so a
  // duplicate never becomes a second source event.
  const upstreamOmitted = Array.isArray(parentOmittedEventIds) ? new Set(parentOmittedEventIds.filter(string)) : null;
  const candidatesByOrigin = new Map();
  for (const event of candidateNotes) {
    const origin = resolveOrigin(event.id);
    if (!origin) { addBlocker(REDUCTION_BLOCKERS.SOURCE_EVENT_NOT_TRACEABLE, { eventId: event.id }); continue; }
    if (contentDigest([event.sourceIds, event.sourceEventIds]) !== contentDigest([origin.sourceIds, origin.sourceEventIds])) {
      addBlocker(REDUCTION_BLOCKERS.SOURCE_EVENT_NOT_TRACEABLE, { eventId: event.id, originEventId: origin.id });
      continue;
    }
    if (!candidatesByOrigin.has(origin.id)) candidatesByOrigin.set(origin.id, []);
    candidatesByOrigin.get(origin.id).push(event);
    // A drum event that already sits in a pitched role is leaked GM material,
    // not a reduction question. It blocks rather than waiting.
    if (isPercussion(event) && SIX_ROLES.includes(event.role)) addBlocker(REDUCTION_BLOCKERS.PERCUSSION_IN_PITCHED_ROLE, { eventId: event.id, role: event.role });
  }

  const items = [];
  for (const origin of notes(baseline).slice().sort((a, b) => cmpStr(a.id, b.id))) {
    const present = (candidatesByOrigin.get(origin.id) ?? []).slice().sort((a, b) => cmpStr(a.id, b.id));
    const base = {
      schema: REDUCTION_LEDGER_SCHEMA,
      baselineEventId: origin.id,
      baselineRole: origin.role ?? null,
      sourceIds: Object.freeze([...(origin.sourceIds ?? [])]),
      sourceEventIds: Object.freeze([...(origin.sourceEventIds ?? [])]),
      pitch: origin.pitch,
      start: String(origin.start),
      end: String(origin.end),
      section: Object.freeze({ start: String(origin.start), end: String(origin.end) }),
      parentRevisionId,
      parentCandidateDigest: parentCandidateIdentity.contentDigest,
    };

    if (!present.length) {
      // Absent from the candidate: an omission an earlier accepted revision
      // performed. Accounted, never silent.
      const verified = upstreamOmitted === null ? null : upstreamOmitted.has(origin.id);
      if (verified === false) addBlocker(REDUCTION_BLOCKERS.EVENT_UNACCOUNTED, { baselineEventId: origin.id });
      if (verified === null) addWarning(REDUCTION_WARNINGS.UPSTREAM_OMISSION_NOT_VERIFIED, { baselineEventId: origin.id });
      items.push(Object.freeze({
        ...base,
        candidateEventIds: Object.freeze([]),
        currentRole: null,
        proposedRole: null,
        outcome: REDUCTION_OUTCOMES.OMIT,
        accounting: REDUCTION_ACCOUNTING_BUCKETS.OMIT,
        reasonCode: REDUCTION_REASON_CODES.OMITTED_BEFORE_REDUCTION,
        decisionId: null,
        evidence: Object.freeze([]),
        upstreamOmissionVerified: verified,
        leadImpact: Object.freeze({ affectsLead: base.baselineRole === LEAD_ROLE, kind: base.baselineRole === LEAD_ROLE ? 'removal' : null, evidenceRequired: false, resolvedBy: 'PARENT_REVISION' }),
        core3Impact: Object.freeze({ leavesCore3: CORE3.has(base.baselineRole ?? ''), entersCore3: false }),
        reviewDependencies: Object.freeze(['Gate 2', 'Gate 9']),
        suggestions: Object.freeze([]),
        percussion: isPercussion(origin),
      }));
      continue;
    }

    for (const event of present) {
      const decision = decisionByEventId.get(event.id) ?? null;
      const currentRole = event.role ?? null;
      const percussion = isPercussion(event);
      let outcome;
      let reasonCode;
      let proposedRole = currentRole;
      if (decision) {
        switch (decision.action) {
          case REDUCTION_ACTIONS.OMIT:
            outcome = REDUCTION_OUTCOMES.OMIT;
            reasonCode = REDUCTION_REASON_CODES.REVIEWER_ACCEPTED_OMISSION;
            proposedRole = null;
            break;
          case REDUCTION_ACTIONS.REDISTRIBUTE:
            outcome = REDUCTION_OUTCOMES.REDISTRIBUTE;
            reasonCode = REDUCTION_REASON_CODES.REVIEWER_ACCEPTED_REDISTRIBUTION;
            proposedRole = decision.toRole;
            break;
          case REDUCTION_ACTIONS.DUPLICATE:
            outcome = REDUCTION_OUTCOMES.REDISTRIBUTE;
            reasonCode = REDUCTION_REASON_CODES.REVIEWER_ACCEPTED_DUPLICATION;
            proposedRole = currentRole;
            break;
          case REDUCTION_ACTIONS.ACCEPT_OVERFLOW:
            outcome = REDUCTION_OUTCOMES.OVERFLOW;
            reasonCode = REDUCTION_REASON_CODES.REVIEWER_ACCEPTED_OVERFLOW;
            proposedRole = null;
            break;
          default:
            // A KEEP over material that has no role does not retain it *in the
            // six roles*: it accepts that it stays outside them. Recording that
            // as `retained` would be the accounting claiming a delivery that
            // never happens, so it converges with ACCEPT_OVERFLOW instead.
            if (SIX_ROLES.includes(currentRole)) {
              outcome = REDUCTION_OUTCOMES.KEEP;
              reasonCode = REDUCTION_REASON_CODES.REVIEWER_ACCEPTED_KEEP;
            } else {
              outcome = REDUCTION_OUTCOMES.OVERFLOW;
              reasonCode = REDUCTION_REASON_CODES.REVIEWER_ACCEPTED_OVERFLOW;
              proposedRole = null;
            }
            break;
        }
      } else if (percussion) {
        // No evidence-backed Mobile drum-face mapping exists in this project,
        // so drum material stays explicitly unsupported instead of being
        // squeezed into a pitched role to complete six tracks.
        outcome = REDUCTION_OUTCOMES.PENDING;
        reasonCode = REDUCTION_REASON_CODES.PERCUSSION_DRUM_FACE_MAPPING_REQUIRED;
      } else if (SIX_ROLES.includes(currentRole)) {
        outcome = REDUCTION_OUTCOMES.KEEP;
        reasonCode = REDUCTION_REASON_CODES.ROLE_ALREADY_ACCEPTED;
      } else if (unsupportedIds.has(event.id)) {
        outcome = REDUCTION_OUTCOMES.PENDING;
        reasonCode = REDUCTION_REASON_CODES.UNSUPPORTED_SOURCE_MATERIAL;
      } else if (!capacityAfter.free.length) {
        // Material with no role and no empty role to receive it. Placing it
        // would mean displacing or merging with something already delivered --
        // a musical decision, so it is reported as overflow and retained, not
        // dropped and not auto-placed.
        outcome = REDUCTION_OUTCOMES.OVERFLOW;
        reasonCode = REDUCTION_REASON_CODES.SIX_ROLE_CAPACITY_EXCEEDED;
      } else {
        outcome = REDUCTION_OUTCOMES.PENDING;
        reasonCode = REDUCTION_REASON_CODES.ROLE_DECISION_REQUIRED;
      }

      const duplicateRoles = decision?.action === REDUCTION_ACTIONS.DUPLICATE ? decision.toRoles : null;
      const affectsLead = currentRole === LEAD_ROLE
        ? outcome !== REDUCTION_OUTCOMES.KEEP && proposedRole !== LEAD_ROLE
        : proposedRole === LEAD_ROLE || Boolean(duplicateRoles?.includes(LEAD_ROLE));
      const leadKind = !affectsLead ? null
        : currentRole === LEAD_ROLE ? (outcome === REDUCTION_OUTCOMES.OMIT ? 'removal' : 'demotion')
          : duplicateRoles?.includes(LEAD_ROLE) ? 'duplication' : 'promotion';
      // The Lead verdict is not computed here. Whether the citation is
      // sufficient is decided by the shared Lead grader inside the role
      // application above, and shows up as a G11-D rejection if it is not.
      const leadResolved = !affectsLead ? null : derivation?.status === 'PASS' ? 'LEAD_GATE_PASSED' : 'LEAD_GATE_NOT_SATISFIED';

      items.push(Object.freeze({
        ...base,
        candidateEventIds: Object.freeze(uniqueSorted([
          event.id,
          ...(proposed.events ?? []).filter(other => other.metadata?.g11d?.derivedFromEventId === event.id).map(other => other.id),
        ])),
        currentRole,
        proposedRole,
        duplicateRoles: duplicateRoles ? Object.freeze([...duplicateRoles]) : null,
        outcome,
        accounting: REDUCTION_ACCOUNTING_BUCKETS[outcome],
        reasonCode,
        decisionId: decision?.id ?? null,
        evidence: Object.freeze([...(decision?.evidence ?? [])]),
        upstreamOmissionVerified: null,
        leadImpact: Object.freeze({
          affectsLead,
          kind: leadKind,
          evidenceRequired: affectsLead,
          evidenceSupplied: affectsLead ? Boolean(decision?.leadEvidence) : null,
          resolvedBy: leadResolved,
        }),
        core3Impact: Object.freeze({
          leavesCore3: CORE3.has(currentRole ?? '') && !CORE3.has(proposedRole ?? ''),
          entersCore3: !CORE3.has(currentRole ?? '') && CORE3.has(proposedRole ?? ''),
        }),
        reviewDependencies: Object.freeze(reviewDependenciesFor(outcome, affectsLead, CORE3.has(currentRole ?? '') || CORE3.has(proposedRole ?? ''))),
        suggestions: outcome === REDUCTION_OUTCOMES.PENDING && reasonCode === REDUCTION_REASON_CODES.ROLE_DECISION_REQUIRED
          ? suggestionsFor(event, capacityAfter, analysis)
          : Object.freeze([]),
        percussion,
      }));
    }
  }

  // Every candidate note must be reachable from a ledger item, or the invariant
  // is broken in the other direction: material in the candidate with no
  // baseline origin recorded. Traceability blockers above already name those.
  const accountedCandidateIds = new Set(items.flatMap(item => item.candidateEventIds));
  for (const event of candidateNotes) {
    if (accountedCandidateIds.has(event.id)) continue;
    if (blockers.some(blocker => blocker.code === REDUCTION_BLOCKERS.SOURCE_EVENT_NOT_TRACEABLE && blocker.eventId === event.id)) continue;
    addBlocker(REDUCTION_BLOCKERS.EVENT_UNACCOUNTED, { candidateEventId: event.id });
  }
  // And every note the proposed candidate would deliver must be one the ledger
  // predicted. This is the invariant proven on the output rather than asserted
  // about the intent: a projection that produced a note nobody accounted for,
  // or dropped one the ledger says is retained, stops here.
  if (derivation?.status === 'PASS') {
    for (const event of notes(proposed)) {
      if (!accountedCandidateIds.has(event.id)) addBlocker(REDUCTION_BLOCKERS.EVENT_UNACCOUNTED, { proposedEventId: event.id });
    }
    for (const item of items) {
      const expectedPresent = item.outcome !== REDUCTION_OUTCOMES.OMIT;
      const stillThere = item.candidateEventIds.some(id => proposedById.has(id));
      if (expectedPresent && !stillThere) addBlocker(REDUCTION_BLOCKERS.EVENT_UNACCOUNTED, { baselineEventId: item.baselineEventId, detail: 'ledger predicted retention, projection dropped it' });
      if (!expectedPresent && stillThere && !item.candidateEventIds.every(id => proposedOmittedIds.has(id) || !proposedById.has(id))) {
        addBlocker(REDUCTION_BLOCKERS.EVENT_UNACCOUNTED, { baselineEventId: item.baselineEventId, detail: 'ledger recorded an omission the projection did not perform' });
      }
    }
  }

  // ── Core3, harmony, budget: before and after ──
  const core3Before = safeCore3(candidate);
  const core3After = safeCore3(proposed);
  // Gate 4 FAILs only on deficiencies a reviewer cannot answer away: an absent
  // Lead, or a Core3 whose identity depends on Chord3-Chord5. A reduction that
  // delivers one of those is blocked whatever Full6 looks like -- enrichment
  // completeness never stands in for Core3 completeness.
  if (core3After.status === 'FAIL') addBlocker(REDUCTION_BLOCKERS.CORE3_INCOMPLETE, { blockers: Object.freeze([...(core3After.blockers ?? [])]) });
  else if (core3Before.status === 'PASS' && core3After.status !== 'PASS') addBlocker(REDUCTION_BLOCKERS.CORE3_REGRESSION, { before: core3Before.status, after: core3After.status, blockers: Object.freeze([...(core3After.blockers ?? [])]) });
  else if (core3After.status === 'PENDING') {
    const dependsOnEnrichment = (core3After.blockers ?? []).includes('CORE3_ENRICHMENT_DEPENDENCE_UNRESOLVED');
    addWarning(dependsOnEnrichment ? REDUCTION_WARNINGS.CORE3_DEPENDS_ON_ENRICHMENT : REDUCTION_WARNINGS.CORE3_UNRESOLVED, { blockers: Object.freeze([...(core3After.blockers ?? [])]) });
  }

  // Both scanners read pitch, time and source identity -- never role. A pure
  // role move therefore cannot introduce a pair, which is what makes a
  // reduction safe to apply over an already-conflicted arrangement. What it
  // must not do is *clear* one, and the before/after comparison is what proves
  // the inherited risk survives into the review instead of being deleted.
  // Duplication is the one action here that adds a sounding event, so it is the
  // one that can introduce a pair, and it blocks when it does.
  const scanLimited = overlapPairBudgetExceeded(candidateNotes) || overlapPairBudgetExceeded(notes(proposed));
  if (scanLimited) addBlocker(REDUCTION_BLOCKERS.COLLISION_SCAN_LIMIT, { maxOverlappingPairs: OVERLAP_PAIR_BUDGET });
  const overlapBefore = scanLimited ? [] : overlapRisks(candidate);
  const overlapAfter = scanLimited ? [] : overlapRisks(proposed);
  const existingOverlap = new Set(overlapBefore.map(overlapRiskKey));
  const introducedOverlap = overlapAfter.filter(risk => !existingOverlap.has(overlapRiskKey(risk)));
  for (const risk of introducedOverlap) addBlocker(REDUCTION_BLOCKERS.NEW_OVERLAP_RISK, { ...risk });
  if (overlapBefore.length) addWarning(REDUCTION_WARNINGS.EXISTING_OVERLAP_RISKS, { count: overlapBefore.length });

  const harmonyBefore = analyzeCrossSourceHarmony(candidate);
  const harmonyAfter = analyzeCrossSourceHarmony(proposed);
  const existingConflicts = new Set(harmonyBefore.conflicts.map(conflict => conflict.id));
  const introducedConflicts = harmonyAfter.conflicts.filter(conflict => !existingConflicts.has(conflict.id));
  for (const conflict of introducedConflicts) addBlocker(REDUCTION_BLOCKERS.NEW_CROSS_SOURCE_CONFLICT, { conflictId: conflict.id, kind: conflict.kind, leftEventId: conflict.leftEventId, rightEventId: conflict.rightEventId, intervalName: conflict.intervalName });
  if (harmonyBefore.unresolvedCount) addWarning(REDUCTION_WARNINGS.EXISTING_CROSS_SOURCE_CONFLICTS, { count: harmonyBefore.unresolvedCount });

  if (budgetAfter.status === 'NOT_MEASURED') addWarning(REDUCTION_WARNINGS.CHARACTER_BUDGET_NOT_MEASURED, { reason: budgetAfter.reason });
  else if (budgetAfter.overBudget.length) addWarning(REDUCTION_WARNINGS.CHARACTER_BUDGET_EXCEEDED, { roles: Object.freeze(budgetAfter.overBudget) });

  // ── accounting summary ──
  const accounting = { retained: 0, redistributed: 0, overflow: 0, pending: 0, omitted: 0 };
  for (const item of items) accounting[item.accounting] += 1;
  const byBucket = bucket => Object.freeze(uniqueSorted(items.filter(item => item.accounting === bucket).map(item => item.baselineEventId)));
  if (accounting.overflow) addWarning(REDUCTION_WARNINGS.OVERFLOW_RETAINED, { count: accounting.overflow });
  if (accounting.pending) addWarning(REDUCTION_WARNINGS.PENDING_RETAINED, { count: accounting.pending });
  const unsupportedCount = items.filter(item => item.reasonCode === REDUCTION_REASON_CODES.UNSUPPORTED_SOURCE_MATERIAL).length;
  if (unsupportedCount) addWarning(REDUCTION_WARNINGS.UNSUPPORTED_RETAINED, { count: unsupportedCount });
  const percussionCount = items.filter(item => item.percussion).length;
  if (percussionCount) addWarning(REDUCTION_WARNINGS.PERCUSSION_RETAINED, { count: percussionCount });

  // ── optional timbre diagnostics, read last and binding nothing ──
  let timbre = null;
  if (instrumentProfile !== null && instrumentProfile !== undefined) {
    const normalizedProfile = normalizeInstrumentProfile(instrumentProfile);
    timbre = timbreDiagnostics(proposed, normalizedProfile);
    addWarning(REDUCTION_WARNINGS.TIMBRE_DIAGNOSTIC_ONLY, { instrumentId: normalizedProfile.instrumentId, verificationStatus: normalizedProfile.verificationStatus });
  }

  const sortedBlockers = Object.freeze([...blockers].sort((a, b) => cmpStr(JSON.stringify(a), JSON.stringify(b))));
  const sortedWarnings = Object.freeze([...warnings].sort((a, b) => cmpStr(JSON.stringify(a), JSON.stringify(b))));

  // The plan's identity is computed over everything that decides what the plan
  // *is* and nothing that does not. The optional timbre diagnostics and the
  // timbre warning are excluded on purpose: supplying a profile must not change
  // the plan a reviewer accepted, and a regression asserts exactly that.
  const identityWarnings = sortedWarnings.filter(warning => warning.code !== REDUCTION_WARNINGS.TIMBRE_DIAGNOSTIC_ONLY);
  const body = {
    schema: REDUCTION_PLAN_SCHEMA,
    stage: FINAL_REDUCTION_STAGE,
    baselineIdentity,
    parentCandidateIdentity,
    parentRevisionId,
    parentRevisionIndex: parentIndex,
    inputDigest,
    canonicalIdentity: canonical,
    acceptedBy: acceptedBy.trim(),
    decisionSetDigest: contentDigest(normalizedDecisions),
    decisions: normalizedDecisions,
    items: Object.freeze(items),
    accounting: Object.freeze({
      ...accounting,
      total: items.length,
      baselineNoteCount: notes(baseline).length,
      candidateNoteCount: candidateNotes.length,
      retainedEventIds: byBucket('retained'),
      redistributedEventIds: byBucket('redistributed'),
      overflowEventIds: byBucket('overflow'),
      pendingEventIds: byBucket('pending'),
      omittedEventIds: byBucket('omitted'),
    }),
    roleCapacity: capacity,
    characterBudget: Object.freeze({
      before: Object.freeze({ status: budgetBefore.status, limit: budgetBefore.limit, perRole: Object.freeze(budgetBefore.perRole), overBudget: Object.freeze(budgetBefore.overBudget) }),
      after: Object.freeze({ status: budgetAfter.status, limit: budgetAfter.limit, perRole: Object.freeze(budgetAfter.perRole), overBudget: Object.freeze(budgetAfter.overBudget) }),
      notice: 'A per-role character limit is a constraint to report. It is never a reason to remove source-supported music; Final canonicalization and syntax compression are downstream.',
    }),
    core3: Object.freeze({ before: summarizeCore3(core3Before), after: summarizeCore3(core3After) }),
    full6: Object.freeze({ analysisAvailable: analysis.ok, error: analysis.error, before: analysis.full6 ?? null }),
    harmony: Object.freeze({
      before: Object.freeze({ conflictCount: harmonyBefore.conflictCount, unresolvedCount: harmonyBefore.unresolvedCount, core3ThreatCount: harmonyBefore.core3ThreatCount }),
      after: Object.freeze({ conflictCount: harmonyAfter.conflictCount, unresolvedCount: harmonyAfter.unresolvedCount, core3ThreatCount: harmonyAfter.core3ThreatCount }),
      introduced: Object.freeze(introducedConflicts.map(conflict => Object.freeze({ id: conflict.id, kind: conflict.kind, leftEventId: conflict.leftEventId, rightEventId: conflict.rightEventId, intervalName: conflict.intervalName }))),
    }),
    overlapRisks: Object.freeze({
      before: Object.freeze(overlapBefore),
      after: Object.freeze(overlapAfter),
      introduced: Object.freeze(introducedOverlap),
      scanLimited,
    }),
    roleApplication: derivation
      ? Object.freeze({ status: derivation.status, appliedDecisionIds: Object.freeze(derivation.applied.map(item => item.decisionId)), rejected: Object.freeze(derivation.rejected), requiresFreshReview: derivation.requiresFreshReview })
      : Object.freeze({ status: 'NOT_RUN', appliedDecisionIds: Object.freeze([]), rejected: Object.freeze([]), requiresFreshReview: false }),
    blockers: sortedBlockers,
    warnings: Object.freeze(identityWarnings),
  };
  const id = `g12:plan:${contentDigest(body)}`;
  return Object.freeze({
    ...body,
    warnings: sortedWarnings,
    timbre,
    id,
    status: sortedBlockers.length ? 'PENDING' : 'PASS',
    certifiesGates: Object.freeze([]),
    notice: 'An executable Final Six-Role Reduction plan, not an acceptance verdict. PASS means this plan can be applied; it certifies no ACCEPTANCE_CRITERIA.md gate. Applying it re-opens Gate 3, Gate 4, Gate 5, Gate 8 and Gate 9 for the derived candidate.',
  });
}

function reviewDependenciesFor(outcome, affectsLead, touchesCore3) {
  const gates = new Set(['Gate 2']);
  if (affectsLead) gates.add('Gate 3');
  if (touchesCore3) gates.add('Gate 4');
  if (outcome !== REDUCTION_OUTCOMES.KEEP) { gates.add('Gate 5'); gates.add('Gate 9'); }
  return [...gates].sort(cmpStr);
}

function safeCore3(project) {
  try { return evaluateCore3Completeness({ candidate: project }); }
  catch (error) { return { status: 'PENDING', pass: false, blockers: ['CORE3_COMPLETENESS_NOT_EVALUATED'], error: error.message }; }
}

const summarizeCore3 = report => Object.freeze({
  status: report.status,
  pass: report.pass === true,
  blockers: Object.freeze([...(report.blockers ?? [])]),
});

// ─── apply (G12-C) ──────────────────────────────────────────────────────────

/**
 * Apply an accepted Final Six-Role Reduction plan, atomically.
 *
 * The plan is recomputed here from the inputs that are actually loaded, and the
 * preview's `expectedPlanId` must still name it. A plan that was previewed
 * against a different candidate, a different baseline, a different decision set
 * or a different Canonical release does not survive that comparison, so a stale
 * preview cannot be replayed onto material it never described.
 *
 * Applying produces a derived, content-addressed reduction candidate. It
 * certifies nothing: no Core3 PASS, no Lead PASS, no Full6 PASS, no Gate 8, no
 * Gate 9, no Final PASS, no IN_GAME_ACCEPTED. Every gate the reduction touched
 * is re-opened for the new candidate.
 */
export function applyFinalReduction({
  baseline,
  candidate = baseline,
  parent = null,
  decisions = [],
  expectedPlanId,
  acceptedBy,
  parentOmittedEventIds = null,
  instrumentProfile = null,
} = {}) {
  if (!string(acceptedBy) || acceptedBy.length > 120) throw Error('acceptedBy is required');
  if (!string(expectedPlanId)) throw Error('expectedPlanId from the preview is required');
  const plan = planFinalReduction({ baseline, candidate, parent, decisions, acceptedBy, parentOmittedEventIds, instrumentProfile });
  if (plan.id !== expectedPlanId) {
    return Object.freeze({ schema: REDUCTION_APPLICATION_SCHEMA, stage: FINAL_REDUCTION_STAGE, applied: false, didApply: false, status: 'PENDING', candidate: null, revision: null, plan, blockers: Object.freeze([Object.freeze({ code: REDUCTION_BLOCKERS.STALE_PLAN, expected: expectedPlanId, observed: plan.id })]) });
  }
  if (plan.blockers.length) {
    return Object.freeze({ schema: REDUCTION_APPLICATION_SCHEMA, stage: FINAL_REDUCTION_STAGE, applied: false, didApply: false, status: plan.status, candidate: null, revision: null, plan, blockers: plan.blockers });
  }
  if (!plan.decisions.length) {
    return Object.freeze({ schema: REDUCTION_APPLICATION_SCHEMA, stage: FINAL_REDUCTION_STAGE, applied: false, didApply: false, status: 'PENDING', candidate: null, revision: null, plan, unchanged: true, blockers: Object.freeze([Object.freeze({ code: REDUCTION_BLOCKERS.NOTHING_TO_APPLY })]) });
  }

  const canonical = plan.canonicalIdentity;
  const resolvedParent = parent ?? recoverParentFromCandidate(baseline, candidate);
  const candidateById = new Map(candidate.events.map(event => [event.id, event]));
  const roleDecisions = toRoleDecisions(plan.decisions, {
    currentRoleOf: eventId => candidateById.get(eventId)?.role ?? null,
    baselineIdentity: plan.baselineIdentity,
    canonical,
    parentRevisionId: plan.parentRevisionId,
    acceptedBy: acceptedBy.trim(),
  });

  // The stage record travels inside the candidate, so it is part of the
  // content-addressed digest the revision is computed over: an edited ledger no
  // longer hashes to the revision that names it. It records inputs and
  // dispositions -- never a gate result.
  const stageMetadata = {
    schema: REDUCTION_LEDGER_SCHEMA,
    stage: FINAL_REDUCTION_STAGE,
    planId: plan.id,
    inputDigest: plan.inputDigest,
    parentRevisionId: plan.parentRevisionId,
    parentCandidateDigest: plan.parentCandidateIdentity.contentDigest,
    decisionSetDigest: plan.decisionSetDigest,
    decisions: plan.decisions.map(decision => JSON.parse(JSON.stringify(decision))),
    acceptedBy: acceptedBy.trim(),
    accounting: JSON.parse(JSON.stringify(plan.accounting)),
    ledger: plan.items.map(item => JSON.parse(JSON.stringify(item))),
    certifiesGates: [],
    notice: 'The Final Six-Role Reduction event accounting ledger for this candidate. It is provenance, not authority: it certifies no ACCEPTANCE_CRITERIA.md gate. A reader must check that planId and inputDigest bind it to the candidate it was read from.',
  };

  let application;
  try {
    application = applyAcceptedArrangement({ baseline, parent: resolvedParent, decisions: roleDecisions, canonicalIdentity: canonical, stage: FINAL_REDUCTION_STAGE, stageMetadata });
  } catch (error) {
    return Object.freeze({ schema: REDUCTION_APPLICATION_SCHEMA, stage: FINAL_REDUCTION_STAGE, applied: false, didApply: false, status: 'PENDING', candidate: null, revision: null, plan, blockers: Object.freeze([Object.freeze({ code: REDUCTION_BLOCKERS.DECISION_REJECTED, detail: error.message })]) });
  }
  if (application.status !== 'PASS') {
    return Object.freeze({
      schema: REDUCTION_APPLICATION_SCHEMA, stage: FINAL_REDUCTION_STAGE, applied: false, didApply: false, status: application.status,
      candidate: null, revision: null, plan,
      blockers: Object.freeze(application.rejected.map(rejection => Object.freeze({ code: REDUCTION_BLOCKERS.DECISION_REJECTED, decisionId: rejection.decisionId ?? null, rejection: rejection.code }))),
    });
  }

  // Invariants proven on the output, not asserted about the intent.
  const output = application.candidate;
  const outputById = new Map(output.events.map(event => [event.id, event]));
  const ledgerIds = new Set(plan.items.flatMap(item => item.candidateEventIds));
  for (const event of notes(output)) {
    if (!ledgerIds.has(event.id)) throw Error(`G12 INVARIANT VIOLATED: the reduction candidate delivers an event no ledger entry accounts for: ${event.id}`);
  }
  for (const item of plan.items) {
    const delivered = item.candidateEventIds.filter(id => outputById.has(id));
    if (item.outcome === REDUCTION_OUTCOMES.OMIT && delivered.length) throw Error(`G12 INVARIANT VIOLATED: ${item.baselineEventId} is recorded omitted but was delivered`);
    if (item.outcome !== REDUCTION_OUTCOMES.OMIT && item.candidateEventIds.length && !delivered.length) throw Error(`G12 INVARIANT VIOLATED: ${item.baselineEventId} is recorded retained but was not delivered`);
  }
  if (output.metadata?.g12?.planId !== plan.id) throw Error('G12 INVARIANT VIOLATED: the reduction candidate does not carry this plan');
  if (output.metadata?.g11d?.revision?.stage !== FINAL_REDUCTION_STAGE) throw Error('G12 INVARIANT VIOLATED: the reduction revision does not carry the reduction stage');

  return Object.freeze({
    schema: REDUCTION_APPLICATION_SCHEMA,
    stage: FINAL_REDUCTION_STAGE,
    stageKind: 'FINAL_SIX_ROLE_REDUCTION_APPLICATION',
    status: 'PASS',
    applied: true,
    didApply: true,
    candidate: output,
    revision: application.revision,
    plan,
    ledger: Object.freeze(plan.items),
    accounting: plan.accounting,
    roleApplication: application,
    trace: application.trace,
    omitted: application.omitted,
    diagnostics: Object.freeze([...plan.warnings, ...application.diagnostics]),
    diffFromBaseline: application.diffFromBaseline,
    diffFromParent: application.diffFromParent ?? compareCanonicalVersions(candidate, output),
    certifiesGates: Object.freeze([]),
    notice: 'A Final Six-Role Reduction candidate was produced from a reviewer-accepted plan. It certifies no ACCEPTANCE_CRITERIA.md gate: Core3, Lead, Full6, Mobile adaptation, regression and in-game acceptance are all re-opened and must be reviewed again against this candidate.',
  });
}

/**
 * Factual capability record for this stage.
 *
 * `false` means the stage does not do the thing -- either because it is out of
 * G12 scope or because doing it would need evidence this layer does not have.
 * It never means an input was silently accepted as if it had been handled.
 */
export const FINAL_REDUCTION_STATUS = Object.freeze({
  eventAccountingLedger: true,
  everySourceEventAccounted: true,
  explicitOverflowRetained: true,
  explicitPendingRetained: true,
  omissionRequiresReviewerEvidence: true,
  silentDropPossible: false,
  silentTruncatePossible: false,
  characterBudgetCanDeleteMusic: false,
  leadContractReused: true,
  leadShortcut: false,
  core3EvaluatedIndependently: true,
  core3MaskableByEnrichment: false,
  harmonyModulesReused: true,
  newRiskBlocks: true,
  existingRiskRemainsVisible: true,
  registerAdaptation: false,
  volumeAdaptation: false,
  timingEdits: false,
  drumFaceMapping: false,
  instrumentAssignment: false,
  timbreAwareReduction: false,
  instrumentProfileInfluencesOutcomes: false,
  certifiesGates: Object.freeze([]),
  notice: 'G12 resolves role and six-role capacity only. Register, volume and audibility adaptation remain Gate 8 / Mobile Adaptation; Final canonicalization and syntax compression remain downstream.',
});
