// Canonical-aware Technical Timing Repair.
//
// Responsibility boundary
// -----------------------
// `canonical/micro-timing.mjs` answers *what an interval is*. `final/micro-gap-
// enforcement.mjs` answers *what Final must do about each class*. This module
// answers one narrower question, and only for the class the other two have
// already settled:
//
//     given an interval Canonical has accepted as meaning-free technical
//     residue, is there a transformation that makes it stop existing, exactly,
//     without changing what the candidate means?
//
// It has **no classification authority**. It never inspects a duration to decide
// whether something is musical, never re-derives the 1/64 grid, never reads a
// source record, and never promotes, demotes or re-reads a decision. Its entire
// worklist is `rejectedIntervalKeys` from an enforcement report it verifies
// against a freshly computed one. An interval that is preserved, blocked, or
// absent from that list is untouchable here, and there is no code path that can
// reach one.
//
// Published authority (2026-09-13-v1, rules snapshot
// 0a172900a01fdf39c2e9e84cf176961320b779ea):
//
//   MASTER_RULES §7   "Preserve meaningful source rests, breaths, articulation
//                     gaps, and sparse passages. Do not fill true rests to
//                     improve continuity statistics. Technical micro-gaps
//                     without musical meaning may be normalized under
//                     MOBILE_SYNTAX.md."
//   MASTER_RULES §6   "Do not delay a new note-on just to hide a collision."
//   MOBILE_SYNTAX §4  `FINAL_FORBIDDEN`: "technical micro-gaps or decomposition
//                     components finer than 1/64 when they have no
//                     source-supported musical meaning"; "Preferred rewrite:
//                     exact equivalent canonical note/tie/rest decomposition
//                     that preserves event timing and attack identity."
//   MOBILE_SYNTAX §8  "A syntax optimizer MUST preserve note-on identity."
//   MOBILE_SYNTAX §11 step 1 "preserve source attacks/rests"; step 5 "ensure no
//                     zero duration or non-musical technical micro-gap remains";
//                     step 8 "keep a reversible mapping from canonical output to
//                     source events/decisions".
//   ACCEPTANCE §Gate 1 "exact timing and note-on identity preserved".
//   ACCEPTANCE §Gate 2 removals/additions/pitch/onset/duration edits must be
//                     explainable.
//
// What "may be normalized" does and does not settle
// -------------------------------------------------
// MASTER_RULES §7 permits normalizing a meaning-free technical micro-gap. That
// is a permission, not a transformation: it establishes that the interval *may*
// stop existing, and says nothing about which of several musically different
// rewrites is the right one. Canonical does not enumerate them.
//
// For a hole between a span ending at `t` and one starting at `t + d`, two
// directions exist: move the following event's onset back to `t`, or extend the
// preceding span's end forward to `t + d`.
//
// Moving the following onset is ruled out. MOBILE_SYNTAX §8 requires a syntax
// optimizer to preserve note-on identity and §11 step 1 preserves source
// attacks; ACCEPTANCE Gate 1 requires note-on identity preserved.
//
// Extending the preceding span is **not** thereby licensed, and an earlier
// revision of this module wrongly claimed it was. Read the two rules that
// actually describe a rewrite:
//
//   MOBILE_SYNTAX §4   "...decomposition that preserves event timing *and*
//                       attack identity"
//   ACCEPTANCE Gate 1  "exact timing *and* note-on identity preserved"
//
// Each names two requirements, not one. Attack identity surviving satisfies the
// second and says nothing about the first: a note whose end moves keeps its
// onset, pitch, volume and ordinal position while sounding longer than the
// candidate said it does, and the role's silence shrinks by exactly that much.
// MASTER_RULES §6's "do not delay a new note-on" is about repairing a confirmed
// non-musical *overlap*, and it forbids delaying an onset; it is not a rule that
// mandates leftward duration extension, and must not be read as one.
//
// So the direction is decided by what the transformation touches, not by a
// Canonical preference for a direction:
//
//   preceding span is a REST  the rest's end moves, no note changes. A role's
//                             silence is the complement of its note coverage, so
//                             silence and attacks are *identical point sets*
//                             before and after. Provable from the IR. Repaired.
//   preceding span is a NOTE  that note sounds longer and the silence shrinks.
//                             Nothing in the Canonical IR proves that neutral —
//                             C1 timing provenance is explicitly factual and may
//                             not be read as a verdict, and the C2 artifact
//                             attestation that could carry such a claim is not
//                             available. Fails closed, every time.
//
// Everything else is reported as unsupported; see `REPAIR_UNSUPPORTED`. A
// sub-grid *note* duration is likewise never repaired: eliminating it would
// require deleting an attack, inventing duration, or moving a neighbour, and the
// IR does not distinguish those.
//
// One neutrality class, and it is checked rather than argued
// ---------------------------------------------------------
// Every implemented operation is `silence-preserving`: it touches no note, so the
// candidate's note-event semantics and silence coverage are exactly unchanged and
// only its *representation* loses the sub-grid component. That is a claim about
// the Canonical IR and the parsed readback, both compared as exact rationals, not
// about rendered-audio bytes, which nothing here establishes.
// `verifyRepairInvariants` checks it on the produced
// project — every note byte-identical including its end, and the per-role silence
// point set unchanged — rather than trusting the plan that produced it. There is
// deliberately no weaker "the attacks survived" class.
//
// A second, separate path shares this machinery and none of its neutrality
// claim: the provisional release rendering at the end of this file
// (ACCEPTANCE_CRITERIA "Delivered first, flagged for listening", 2026-09-23-v3).
// It is not a repair. It holds a note's release -- exactly what
// `NOTE_RELEASE_NOT_PROVEN_NEUTRAL` above refuses to do, and still refuses -- for
// a delivered Final only, never in a candidate, and only for the releases the
// enforcement report lists. `repairTechnicalTiming` never reaches it.
//
// Nothing here is approximate. No epsilon, no float, no rounding, no snapping,
// no quantization, no grid search. Every comparison and every delta is exact
// rational. The repaired candidate is a *new* project with its own id and its own
// provenance record; the input project is never mutated, and the Source-Faithful
// Baseline it carries is copied through untouched so the repair shows up in the
// baseline diff instead of hiding from it.
import { f, ROLES } from '../mml/index.mjs';
import { EFFECTIVE_RULESET } from '../rules/index.mjs';
import {
  createCanonicalNoteEvent,
  createCanonicalRestEvent,
  createCanonicalProject,
} from '../canonical/index.mjs';
import {
  SAFE_GRID,
  INTERVAL_TYPES,
  MICRO_TIMING_CLASSIFICATIONS,
  createIntervalIdentity,
  intervalIdentityKey,
} from '../canonical/micro-timing.mjs';
import { MICRO_GAP_BLOCKERS, MICRO_GAP_ENFORCEMENT, enforceMicroGaps } from './micro-gap-enforcement.mjs';

export const REPAIR_STATUS = Object.freeze({
  PASS: 'PASS',
  FAIL: 'FAIL',
  PENDING: 'PENDING',
});

export const REPAIR_OPERATIONS = Object.freeze({
  // An uncovered hole whose preceding span is a *rest*: that rest's end is
  // extended to the following span's onset. No event is created or removed, and
  // no note is touched. A hole preceded by a note is not repaired — see
  // `REPAIR_UNSUPPORTED.NOTE_RELEASE_NOT_PROVEN_NEUTRAL`.
  CLOSE_GAP_INTO_PRECEDING_REST: 'close-technical-gap-into-preceding-rest',
  // A sub-grid rest event whose immediate predecessor is also a rest: the two
  // rest events describe one uninterrupted silence and become one. The
  // *classified* event survives so its accepted decision stays bound to a real
  // event; the predecessor is absorbed into it.
  COALESCE_CONTIGUOUS_RESTS: 'coalesce-technical-rest-with-preceding-rest',
});

// One class only. Every implemented operation leaves the role's notes untouched,
// so its silence and attack sets are identical point sets before and after. A
// weaker claim — "the attacks survive, so the change is fine" — is exactly what
// this layer refuses to make, and there is deliberately no constant for it.
export const REPAIR_NEUTRALITY = Object.freeze({
  SILENCE_PRESERVING: 'silence-preserving',
});

export const REPAIR_DIAGNOSTICS = Object.freeze({
  ENFORCEMENT_STALE: 'TECHNICAL_REPAIR_ENFORCEMENT_STALE',
  ENFORCEMENT_MALFORMED: 'TECHNICAL_REPAIR_ENFORCEMENT_MALFORMED',
  POLICY_NON_CONFORMANT: 'TECHNICAL_REPAIR_POLICY_NON_CONFORMANT',
  BLOCKED_INTERVAL_PRESENT: 'TECHNICAL_REPAIR_BLOCKED_INTERVAL_PRESENT',
  PRESERVED_INTERVAL_PRESENT: 'TECHNICAL_REPAIR_PRESERVED_INTERVAL_PRESENT',
  UNSUPPORTED_INTERVAL: 'TECHNICAL_REPAIR_UNSUPPORTED_INTERVAL',
  PROJECT_REBUILD_FAILED: 'TECHNICAL_REPAIR_PROJECT_REBUILD_FAILED',
  INVARIANT_VIOLATED: 'TECHNICAL_REPAIR_INVARIANT_VIOLATED',
  VERIFICATION_FAILED: 'TECHNICAL_REPAIR_VERIFICATION_FAILED',
  VERIFICATION_NOT_CLEAR: 'TECHNICAL_REPAIR_VERIFICATION_NOT_CLEAR',
  NOT_REQUIRED: 'TECHNICAL_REPAIR_NOT_REQUIRED',
  APPLIED: 'TECHNICAL_REPAIR_APPLIED',
});

export const REPAIR_SEVERITY = Object.freeze({
  ERROR: 'error',
  PENDING: 'pending',
  NOTICE: 'notice',
});

// Why a presented interval was left alone. Every one of these is a refusal to
// guess, never a silent skip: an interval carrying any of them keeps the repair
// result off `PASS`.
export const REPAIR_UNSUPPORTED = Object.freeze({
  UNSUPPORTED_INTERVAL_TYPE: 'unsupported-interval-type',
  NOTE_DURATION_RESIDUE: 'note-duration-residue-has-no-unique-neutral-repair',
  REST_DURATION_WITHOUT_PRECEDING_REST: 'rest-duration-residue-has-no-preceding-contiguous-rest',
  NOTE_RELEASE_NOT_PROVEN_NEUTRAL: 'preceding-note-release-extension-is-not-proven-semantically-neutral',
  IDENTITY_NOT_CURRENT: 'interval-identity-is-not-current-in-the-project',
  AMBIGUOUS_BOUNDARY: 'interval-boundary-event-is-ambiguous',
  INTERVAL_OCCUPIED: 'interval-is-not-empty-within-its-role',
  ROLE_UNRESOLVED: 'interval-events-do-not-share-one-assigned-role',
  DECISION_BOUND_REMOVAL: 'absorbed-event-is-referenced-by-a-decision',
  INTERACTING_REPAIRS: 'repair-interacts-with-another-repair-on-the-same-event',
});

// What the published rule actually supports for each operation. The permission
// comes from MASTER_RULES §7; the *neutrality* comes from the transformation
// touching no note at all, which is checked on the produced project rather than
// argued here. Neither string claims Canonical mandates a direction.
const PERMITTED_BECAUSE = Object.freeze({
  [REPAIR_OPERATIONS.CLOSE_GAP_INTO_PRECEDING_REST]:
    'MASTER_RULES §7 permits normalizing a technical micro-gap that carries no musical meaning, and MOBILE_SYNTAX §4 / §11 step 5 forbid a sub-1/64 technical micro-gap in Final output. The span preceding this hole is a rest, so extending it changes no note: the role\'s silence and its attack set are identical point sets before and after, which satisfies "preserves event timing and attack identity" (MOBILE_SYNTAX §4) and "exact timing and note-on identity preserved" (ACCEPTANCE_CRITERIA Gate 1) for every note in the role. The interval was classified by the source-aware analyzer and rejected by micro-gap enforcement; this layer re-classified nothing.',
  [REPAIR_OPERATIONS.COALESCE_CONTIGUOUS_RESTS]:
    'MASTER_RULES §7 permits normalizing a technical micro-gap that carries no musical meaning, and MOBILE_SYNTAX §4 / §11 step 5 forbid a sub-1/64 component in Final output. Two contiguous rest events describe one uninterrupted silence, so coalescing them changes no note: the role\'s silence and its attack set are identical point sets before and after (MOBILE_SYNTAX §4; ACCEPTANCE_CRITERIA Gate 1). The interval was classified by the source-aware analyzer and rejected by micro-gap enforcement; this layer re-classified nothing.',
});

export const TECHNICAL_REPAIR_NOTICE = 'Technical Timing Repair is one implementation layer. A PASS means the intervals micro-gap enforcement had already rejected as meaning-free technical residue were normalized exactly, and that re-running the same enforcement on the repaired candidate agrees. It certifies no Canonical gate, does not make a song VALIDATED, and never implies IN_GAME_ACCEPTED. The repaired candidate is a distinct project from the source-faithful input, which is left unmodified.';

const SPAN_KINDS = new Set(['note', 'rest']);
const ASSIGNED_ROLES = new Set(ROLES);

function freezeDeep(value) {
  if (Array.isArray(value)) return Object.freeze(value.map(freezeDeep));
  if (value && typeof value === 'object') {
    return Object.freeze(Object.fromEntries(Object.entries(value).map(([key, child]) => [key, freezeDeep(child)])));
  }
  return value;
}

const diagnostic = (code, severity, message, details = {}) => Object.freeze({ code, severity, message, ...details });

const exactlyEqual = (left, right) => {
  try {
    return f(left).cmp(right) === 0;
  } catch {
    return false;
  }
};

function spanEvents(project) {
  const events = Array.isArray(project?.events) ? project.events : [];
  return events.filter(event => event
    && SPAN_KINDS.has(event.kind)
    && typeof event.id === 'string'
    && event.start != null
    && event.end != null);
}

// ── enforcement input: verified, never trusted ─────────────────────────────

// Structural fingerprint of the parts of an enforcement report this module acts
// on. A caller may hand in a report it already computed — the emitter does — but
// it is compared against a freshly computed one and a difference is fatal. A key
// that no longer describes the project is exactly the stale-handle bug this
// guards, and it is checked before any plan is built rather than after.
function enforcementFingerprint(report) {
  return JSON.stringify({
    status: report?.status ?? null,
    policyConformant: report?.policy?.conformant ?? null,
    safeGrid: report?.safeGrid ?? null,
    preserved: [...(report?.preservedIntervalKeys ?? [])],
    rejected: [...(report?.rejectedIntervalKeys ?? [])],
    blocked: [...(report?.blockedIntervalKeys ?? [])],
    enforcement: (report?.enforcement ?? []).map(item => ({
      identityKey: item?.identityKey ?? null,
      identity: item?.identity ?? null,
      intervalType: item?.intervalType ?? null,
      length: item?.length ?? null,
      classification: item?.classification ?? null,
      enforcement: item?.enforcement ?? null,
      eventIds: [...(item?.eventIds ?? [])],
    })),
  });
}

/**
 * The rejected worklist, admitted one record at a time.
 *
 * A rejected key is only usable when the record behind it is intact *and* still
 * says what the reject list claims. `identity` is re-created rather than read, so
 * a record whose identity no longer encodes to its own key is refused instead of
 * acted on. `enforceMicroGaps` cannot produce any of these shapes — its own
 * invariant check stops it — which is exactly why this reader is exported: a
 * defensive branch nothing exercises silently stops being a check.
 */
export function readRejectedTechnicalRecords(report) {
  const byKey = new Map();
  for (const record of report.enforcement ?? []) {
    if (record?.identityKey) byKey.set(record.identityKey, record);
  }

  const records = [];
  const malformed = [];
  for (const key of report.rejectedIntervalKeys ?? []) {
    const record = byKey.get(key);
    if (!record) {
      malformed.push({ identityKey: key, reason: 'no enforcement record carries this rejected key' });
      continue;
    }
    if (record.classification !== MICRO_TIMING_CLASSIFICATIONS.TECHNICAL_RESIDUE) {
      malformed.push({ identityKey: key, reason: `rejected record is classified ${record.classification}, not ${MICRO_TIMING_CLASSIFICATIONS.TECHNICAL_RESIDUE}` });
      continue;
    }
    if (record.enforcement !== MICRO_GAP_ENFORCEMENT.REJECT_FINAL) {
      malformed.push({ identityKey: key, reason: `rejected record carries enforcement ${record.enforcement}` });
      continue;
    }
    let identity;
    try {
      identity = createIntervalIdentity(record.identity);
    } catch (error) {
      malformed.push({ identityKey: key, reason: `interval identity is not well formed: ${error.message}` });
      continue;
    }
    if (intervalIdentityKey(identity) !== key) {
      malformed.push({ identityKey: key, reason: 'interval identity does not encode to its own key' });
      continue;
    }
    // The analyzer only ever produces sub-grid intervals, so a rejected record
    // that is not below the grid means the two modules disagree about the grid
    // itself. Exactly-on-grid timing is not a sub-grid violation, and this is the
    // one place the repair layer restates that — against the analyzer's own
    // SAFE_GRID, never against a separately invented constant.
    if (f(identity.length).cmp(SAFE_GRID) >= 0) {
      malformed.push({ identityKey: key, reason: `interval length ${identity.length} is not below the analyzer safe grid ${SAFE_GRID.toString()}` });
      continue;
    }
    records.push({ identityKey: key, identity, record });
  }

  records.sort((left, right) => (left.identityKey < right.identityKey ? -1 : left.identityKey > right.identityKey ? 1 : 0));
  return { records, malformed };
}

// ── repair planning ────────────────────────────────────────────────────────

const unsupported = (identityKey, identity, reason, detail = {}) => ({
  ok: false,
  identityKey,
  identity,
  reason,
  ...detail,
});

/**
 * Spans of one assigned role, with the role resolved from the interval's own
 * events. An interval whose events disagree about role, carry no role, or are
 * missing from the project has no unambiguous stream to repair in.
 */
function resolveRole(eventsById, eventIds) {
  const roles = new Set();
  for (const id of eventIds) {
    const event = eventsById.get(id);
    if (!event) return null;
    roles.add(event.role);
  }
  if (roles.size !== 1) return null;
  const [role] = [...roles];
  return ASSIGNED_ROLES.has(role) ? role : null;
}

/** Spans of `role` that overlap the open interval `(start, end)`. */
function spansInsideOpenInterval(roleSpans, start, end, excludeIds) {
  return roleSpans.filter(event => !excludeIds.has(event.id)
    && f(event.start).cmp(end) < 0
    && f(event.end).cmp(start) > 0);
}

function planGapClosure({ identityKey, identity, record }, context) {
  const { eventsById, spansByRole } = context;
  const previous = eventsById.get(identity.previousEventId);
  const next = eventsById.get(identity.nextEventId);
  if (!previous || !next) {
    return unsupported(identityKey, identity, REPAIR_UNSUPPORTED.IDENTITY_NOT_CURRENT, { detail: 'an event named by the interval is not in the project' });
  }

  const role = resolveRole(eventsById, [previous.id, next.id]);
  if (!role) return unsupported(identityKey, identity, REPAIR_UNSUPPORTED.ROLE_UNRESOLVED);

  // The identity must still describe the project's own timing. The enforcement
  // report was verified against a fresh computation above, so this can only
  // differ for a hand-built identity, and that is a refusal, not a repair.
  if (!exactlyEqual(previous.end, identity.start) || !exactlyEqual(next.start, identity.end)) {
    return unsupported(identityKey, identity, REPAIR_UNSUPPORTED.IDENTITY_NOT_CURRENT, {
      detail: `project timing is ${previous.end}..${next.start}, interval claims ${identity.start}..${identity.end}`,
    });
  }

  const roleSpans = spansByRole.get(role) ?? [];
  const endingHere = roleSpans.filter(event => exactlyEqual(event.end, identity.start));
  const startingThere = roleSpans.filter(event => exactlyEqual(event.start, identity.end));
  if (endingHere.length !== 1 || startingThere.length !== 1) {
    return unsupported(identityKey, identity, REPAIR_UNSUPPORTED.AMBIGUOUS_BOUNDARY, {
      detail: `${endingHere.length} span(s) end at ${identity.start} and ${startingThere.length} start at ${identity.end} in ${role}`,
    });
  }
  if (endingHere[0].id !== previous.id || startingThere[0].id !== next.id) {
    return unsupported(identityKey, identity, REPAIR_UNSUPPORTED.IDENTITY_NOT_CURRENT, { detail: 'the interval names events that are not the current boundary spans' });
  }

  const occupied = spansInsideOpenInterval(roleSpans, f(identity.start), f(identity.end), new Set([previous.id, next.id]));
  if (occupied.length) {
    return unsupported(identityKey, identity, REPAIR_UNSUPPORTED.INTERVAL_OCCUPIED, {
      detail: `${occupied.length} other span(s) of ${role} lie inside the interval`,
    });
  }

  // The whole neutrality argument turns on what the preceding span is.
  //
  // A rest: extending its end changes no note, so the role's silence — the
  // complement of its note coverage — and its attack set are the same point sets
  // before and after. Note-event semantics and silence coverage are exactly
  // unchanged. That is a proof, not a judgement.
  //
  // A note: extending its end lengthens how long that note sounds and shortens
  // the role's silence by the same amount. Attack identity surviving does not
  // make that neutral — MOBILE_SYNTAX §4 asks a rewrite to preserve "event
  // timing *and* attack identity" and ACCEPTANCE Gate 1 asks for "exact timing
  // *and* note-on identity", two requirements each, and a release move fails the
  // first. Canonical rules out moving the following onset (§8, §11 step 1) but
  // does not thereby license changing the preceding release; that the gap is
  // meaning-free establishes only that it *may* be normalized, not that this
  // particular normalization is semantically neutral. Nothing the Canonical IR
  // carries closes that gap: C1 timing provenance is explicitly factual and may
  // not be read as a verdict, and the C2 artifact attestation that could carry
  // such a claim is not available. So this fails closed.
  if (previous.kind !== 'rest') {
    return unsupported(identityKey, identity, REPAIR_UNSUPPORTED.NOTE_RELEASE_NOT_PROVEN_NEUTRAL, {
      detail: `the preceding span ${previous.id} is a ${previous.kind}; extending its release by ${f(identity.end).sub(f(identity.start)).toString()} would change how long it sounds, and no evidence in this project proves that change semantically neutral`,
    });
  }

  // Admission already established this interval is positive and below the grid.
  const delta = f(identity.end).sub(f(identity.start));

  return {
    ok: true,
    identityKey,
    identity,
    operation: REPAIR_OPERATIONS.CLOSE_GAP_INTO_PRECEDING_REST,
    neutrality: REPAIR_NEUTRALITY.SILENCE_PRESERVING,
    role,
    decisionId: record.decisionId ?? null,
    // Mutated: `previous` gains duration. `next` is read, never written.
    targetEventId: previous.id,
    absorbedEventId: null,
    touchedEventIds: [previous.id],
    before: { start: previous.start, end: previous.end },
    after: { start: previous.start, end: identity.end },
    delta: delta.toString(),
  };
}

function planRestCoalesce({ identityKey, identity, record }, context) {
  const { eventsById, spansByRole, decisionEventIds } = context;
  const event = eventsById.get(identity.eventId);
  if (!event) {
    return unsupported(identityKey, identity, REPAIR_UNSUPPORTED.IDENTITY_NOT_CURRENT, { detail: 'the event named by the interval is not in the project' });
  }
  if (!exactlyEqual(event.start, identity.start) || !exactlyEqual(event.end, identity.end)) {
    return unsupported(identityKey, identity, REPAIR_UNSUPPORTED.IDENTITY_NOT_CURRENT, {
      detail: `project timing is ${event.start}..${event.end}, interval claims ${identity.start}..${identity.end}`,
    });
  }

  // A sub-grid *note* duration is never repaired. Removing it deletes an attack,
  // lengthening it moves or overlaps a neighbour, and nothing in the IR makes one
  // of those the neutral choice. This is the refusal, stated once.
  if (event.kind !== 'rest') {
    return unsupported(identityKey, identity, REPAIR_UNSUPPORTED.NOTE_DURATION_RESIDUE, {
      detail: `${event.id} is a ${event.kind}; eliminating its duration would delete an attack, invent duration, or move a neighbouring attack`,
    });
  }

  const role = resolveRole(eventsById, [event.id]);
  if (!role) return unsupported(identityKey, identity, REPAIR_UNSUPPORTED.ROLE_UNRESOLVED);

  const roleSpans = spansByRole.get(role) ?? [];
  const preceding = roleSpans.filter(span => span.id !== event.id && exactlyEqual(span.end, event.start));
  if (preceding.length !== 1) {
    return unsupported(identityKey, identity, REPAIR_UNSUPPORTED.REST_DURATION_WITHOUT_PRECEDING_REST, {
      detail: `${preceding.length} span(s) of ${role} end exactly at ${event.start}`,
    });
  }
  const [previous] = preceding;
  if (previous.kind !== 'rest') {
    // Absorbing a rest event into a note's sustain both removes a source-backed
    // rest and lengthens a note. Those are two different changes and neither is
    // forced by the evidence, so the layer refuses rather than picking one.
    return unsupported(identityKey, identity, REPAIR_UNSUPPORTED.REST_DURATION_WITHOUT_PRECEDING_REST, {
      detail: `the preceding span ${previous.id} is a ${previous.kind}; only two contiguous rests coalesce without changing the role's silence`,
    });
  }

  const occupied = spansInsideOpenInterval(roleSpans, f(previous.start), f(event.end), new Set([previous.id, event.id]));
  if (occupied.length) {
    return unsupported(identityKey, identity, REPAIR_UNSUPPORTED.INTERVAL_OCCUPIED, {
      detail: `${occupied.length} other span(s) of ${role} lie inside ${previous.start}..${event.end}`,
    });
  }

  // The absorbed event disappears from the project, so anything that points at it
  // would be left dangling. A decision is an audit record, not something this
  // layer may rewrite, so a referenced predecessor is a refusal.
  if (decisionEventIds.has(previous.id)) {
    return unsupported(identityKey, identity, REPAIR_UNSUPPORTED.DECISION_BOUND_REMOVAL, {
      detail: `${previous.id} is referenced by an arbitration decision`,
    });
  }

  return {
    ok: true,
    identityKey,
    identity,
    operation: REPAIR_OPERATIONS.COALESCE_CONTIGUOUS_RESTS,
    neutrality: REPAIR_NEUTRALITY.SILENCE_PRESERVING,
    role,
    decisionId: record.decisionId ?? null,
    // The classified event survives and grows backwards; its predecessor is
    // folded into it. Both are mutated for conflict purposes.
    targetEventId: event.id,
    absorbedEventId: previous.id,
    touchedEventIds: [event.id, previous.id],
    before: { start: event.start, end: event.end },
    after: { start: previous.start, end: event.end },
    delta: f(previous.end).sub(f(previous.start)).toString(),
    absorbed: {
      id: previous.id,
      kind: previous.kind,
      start: previous.start,
      end: previous.end,
      role: previous.role,
      sourceIds: [...previous.sourceIds],
      sourceEventIds: [...(previous.sourceEventIds ?? [])],
    },
  };
}

function planFor(entry, context) {
  if (entry.identity.type === INTERVAL_TYPES.INTER_EVENT_GAP) return planGapClosure(entry, context);
  if (entry.identity.type === INTERVAL_TYPES.EVENT_DURATION) return planRestCoalesce(entry, context);
  return unsupported(entry.identityKey, entry.identity, REPAIR_UNSUPPORTED.UNSUPPORTED_INTERVAL_TYPE);
}

// Two plans that write the same event cannot be verified independently, and
// applying them in some order would make the result depend on that order. Both
// become unsupported instead. Real residue is sparse; a chain deserves a look.
function rejectInteractingPlans(plans) {
  const writers = new Map();
  for (const plan of plans) {
    for (const id of plan.touchedEventIds) {
      if (!writers.has(id)) writers.set(id, []);
      writers.get(id).push(plan.identityKey);
    }
  }
  const conflicted = new Set();
  for (const [, keys] of writers) {
    if (keys.length > 1) for (const key of keys) conflicted.add(key);
  }
  return {
    kept: plans.filter(plan => !conflicted.has(plan.identityKey)),
    dropped: plans
      .filter(plan => conflicted.has(plan.identityKey))
      .map(plan => unsupported(plan.identityKey, plan.identity, REPAIR_UNSUPPORTED.INTERACTING_REPAIRS, {
        detail: `shares a mutated event with another repair (${plan.touchedEventIds.join(', ')})`,
      })),
  };
}

// ── applying ───────────────────────────────────────────────────────────────

function rebuildEvent(event, { start, end, extraSourceIds = [], extraSourceEventIds = [], repairRecord, metadataKey = 'technicalTimingRepair' }) {
  const metadata = {
    ...structuredClone(event.metadata ?? {}),
    [metadataKey]: repairRecord,
  };
  const sourceIds = [...new Set([...event.sourceIds, ...extraSourceIds])];
  const sourceEventIds = [...new Set([...(event.sourceEventIds ?? []), ...extraSourceEventIds])];
  const common = {
    id: event.id,
    start,
    end,
    role: event.role,
    voice: event.voice ?? null,
    sourceIds,
    sourceEventIds,
    tags: [...(event.tags ?? [])],
    metadata,
  };
  if (event.kind === 'note') {
    return createCanonicalNoteEvent({ ...common, pitch: event.pitch, volume: event.volume ?? null });
  }
  return createCanonicalRestEvent(common);
}

function applyPlans(project, plans) {
  const removed = new Set();
  const replacements = new Map();

  for (const plan of plans) {
    const target = project.events.find(event => event.id === plan.targetEventId);
    const provenance = freezeDeep({
      operation: plan.operation,
      neutrality: plan.neutrality,
      intervalKey: plan.identityKey,
      intervalType: plan.identity.type,
      decisionId: plan.decisionId,
      before: { start: plan.before.start, end: plan.before.end },
      after: { start: plan.after.start, end: plan.after.end },
      delta: plan.delta,
      absorbedEventId: plan.absorbedEventId,
      absorbed: plan.absorbed ?? null,
      permittedBecause: PERMITTED_BECAUSE[plan.operation],
      canonical: EFFECTIVE_RULESET.canonical,
    });
    replacements.set(plan.targetEventId, rebuildEvent(target, {
      start: plan.after.start,
      end: plan.after.end,
      extraSourceIds: plan.absorbed?.sourceIds ?? [],
      extraSourceEventIds: plan.absorbed?.sourceEventIds ?? [],
      repairRecord: provenance,
    }));
    if (plan.absorbedEventId) removed.add(plan.absorbedEventId);
  }

  const events = [];
  for (const event of project.events) {
    if (removed.has(event.id)) continue;
    events.push(replacements.get(event.id) ?? event);
  }

  const metadata = {
    ...structuredClone(project.metadata ?? {}),
    technicalTimingRepair: freezeDeep({
      appliedToProjectId: project.id,
      canonical: EFFECTIVE_RULESET.canonical,
      safeGrid: SAFE_GRID.toString(),
      repairedIntervalKeys: plans.map(plan => plan.identityKey),
      repairs: plans.map(plan => ({
        intervalKey: plan.identityKey,
        operation: plan.operation,
        neutrality: plan.neutrality,
        role: plan.role,
        targetEventId: plan.targetEventId,
        absorbedEventId: plan.absorbedEventId,
        before: plan.before,
        after: plan.after,
        delta: plan.delta,
      })),
    }),
  };

  return createCanonicalProject({
    id: `${project.id}#technical-timing-repair`,
    title: `${project.title} (technical timing repair)`,
    sources: [...project.sources],
    events,
    tempoEvents: [...project.tempoEvents],
    meterEvents: [...project.meterEvents],
    decisions: [...project.decisions],
    metadata,
  });
}

// ── invariants ─────────────────────────────────────────────────────────────

// A whole record, serialized independently of key order: every field of an
// event -- id, kind, pitch, start, end, volume, role, voice, sourceIds,
// sourceEventIds, tags, metadata, and anything a later IR version adds. Arrays
// keep their order; keys whose value is undefined are dropped, as JSON does.
// Comparing this rather than a list of protected fields is what makes "no
// implemented operation touches a note" total equality: a field nobody thought
// to list is still compared.
function canonicalJson(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  const keys = Object.keys(value).filter(key => value[key] !== undefined).sort();
  return `{${keys.map(key => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`;
}

const sortedIds = values => [...(Array.isArray(values) ? values : [])].sort();

// A repaired rest, less exactly what a repair may change on it: its timing
// (checked against its plan), its source identities (checked against its own
// plus those of the rest it absorbed) and the provenance record the repair
// attaches under `metadata.technicalTimingRepair`. Everything else -- kind,
// role, voice, tags and every other metadata key -- must be unchanged.
function repairedRestShape(event) {
  const { start: _start, end: _end, sourceIds: _sourceIds, sourceEventIds: _sourceEventIds, metadata, ...rest } = event;
  const { technicalTimingRepair: _record, ...otherMetadata } = metadata ?? {};
  return canonicalJson({ ...rest, metadata: otherMetadata });
}

/**
 * Every pair of spans of one assigned role that overlap in time, as
 * `role, id, id` keys with the ids ordered. Touching (one ends where the next
 * starts) is not overlapping. Exact rational comparison throughout.
 */
function overlappingSpanPairs(project) {
  const byRole = new Map();
  for (const event of project.events) {
    if (!SPAN_KINDS.has(event?.kind) || !ASSIGNED_ROLES.has(event.role)) continue;
    if (!byRole.has(event.role)) byRole.set(event.role, []);
    byRole.get(event.role).push(event);
  }
  const pairs = new Set();
  for (const [role, spans] of byRole) {
    const ordered = [...spans].sort((left, right) => f(left.start).cmp(right.start) || f(left.end).cmp(right.end));
    for (let index = 0; index < ordered.length; index += 1) {
      const current = ordered[index];
      for (let later = index + 1; later < ordered.length && f(ordered[later].start).cmp(current.end) < 0; later += 1) {
        const [first, second] = [current.id, ordered[later].id].sort();
        pairs.add(`${role}\u0000${first}\u0000${second}`);
      }
    }
  }
  return pairs;
}

/**
 * A role's silence, as the exact point set no note of that role covers.
 *
 * This is the literal statement of what `silence-preserving` claims, computed
 * from the produced project so the claim is verified rather than argued. Rests
 * are deliberately not consulted: silence is the complement of note coverage, so
 * a rest moving cannot change it and a note moving must.
 */
function silenceByRole(project) {
  const byRole = new Map();
  for (const event of project.events) {
    if (event.kind !== 'note' || !ASSIGNED_ROLES.has(event.role)) continue;
    if (!byRole.has(event.role)) byRole.set(event.role, []);
    byRole.get(event.role).push(event);
  }

  const silence = {};
  for (const [role, notes] of byRole) {
    const ordered = [...notes].sort((left, right) => f(left.start).cmp(right.start) || f(left.end).cmp(right.end));
    const spans = [];
    let cursor = f(0);
    for (const note of ordered) {
      if (f(note.start).cmp(cursor) > 0) spans.push([cursor.toString(), note.start]);
      if (f(note.end).cmp(cursor) > 0) cursor = f(note.end);
    }
    silence[role] = spans;
  }
  return silence;
}

const controlShape = event => ({ id: event.id, beat: event.beat, bpm: event.bpm ?? null, numerator: event.numerator ?? null, denominator: event.denominator ?? null });

/**
 * Everything the repair is forbidden to have done, checked against the produced
 * project rather than assumed from the plans that produced it.
 *
 * These are not defensive noise. Each one is a mutation someone could introduce
 * in this file that every happy-path assertion would still pass:
 *
 *   * a note changed in any field at all -- the whole record is compared, so
 *     its source event ids, voice, tags and metadata count as much as its
 *     pitch or release;
 *   * a rest no plan names changed in any field, its role and provenance
 *     included;
 *   * a planned rest that does not match its plan, changed beyond its timing,
 *     carries source identities other than its own plus those of the rest it
 *     absorbed, or lacks its repair's provenance record;
 *   * a plan that is not what its interval identity says: a gap closure must
 *     extend its target rest from the interval start exactly to the interval
 *     end, where the following span starts; a coalesce must span exactly the
 *     contiguous preceding rest of its role and its target;
 *   * a span of a role that overlaps another span of that role after the
 *     repair and did not before;
 *   * events reordered, invented or dropped, the tempo or meter map, source
 *     set, decision record or project metadata (the Source-Faithful Baseline
 *     it carries included) changed.
 *
 * Exported because the planners already refuse everything this would catch, so
 * nothing in production can reach these branches — and a check nothing exercises
 * silently stops being a check. A regression drives it directly with a
 * hand-built "repaired" project instead.
 */
export function verifyRepairInvariants(before, after, plans) {
  const violations = [];
  const byKeyTarget = new Map(plans.map(plan => [plan.targetEventId, plan]));
  const absorbed = new Set(plans.filter(plan => plan.absorbedEventId).map(plan => plan.absorbedEventId));
  const beforeById = new Map(before.events.map(event => [event.id, event]));
  const afterById = new Map(after.events.map(event => [event.id, event]));

  const beforeNotes = before.events.filter(event => event.kind === 'note');
  const afterNotes = after.events.filter(event => event.kind === 'note');
  if (beforeNotes.length !== afterNotes.length) {
    violations.push(`attack count changed: ${beforeNotes.length} -> ${afterNotes.length}`);
  }
  const afterNoteById = new Map(afterNotes.map(event => [event.id, event]));
  for (const note of beforeNotes) {
    const now = afterNoteById.get(note.id);
    if (!now) {
      violations.push(`note ${note.id} disappeared`);
      continue;
    }
    // Total equality of the whole record. A note is never a repair target: not
    // its pitch, onset, volume, role, voice, provenance, tags or metadata, and
    // not its release either. A plan naming one is itself the violation.
    if (canonicalJson(note) !== canonicalJson(now)) {
      violations.push(`note ${note.id} changed — no implemented repair may touch a note, its release included`);
    }
    if (byKeyTarget.has(note.id)) violations.push(`note ${note.id} is a repair target; only a rest may be`);
  }
  for (const note of afterNotes) {
    if (!beforeNotes.some(event => event.id === note.id)) violations.push(`note ${note.id} was invented`);
  }
  for (const plan of plans) {
    if (plan.neutrality !== REPAIR_NEUTRALITY.SILENCE_PRESERVING) {
      violations.push(`repair ${plan.identityKey} claims neutrality ${plan.neutrality}, which this layer does not implement`);
    }
  }

  // Each plan against the interval identity it claims to repair and the input
  // project, so a plan that is itself wrong is caught rather than trusted.
  for (const plan of plans) {
    const target = beforeById.get(plan.targetEventId);
    if (!target) {
      violations.push(`repair ${plan.identityKey} targets ${plan.targetEventId}, which is not in the input project`);
      continue;
    }
    // A note target is reported above; there is no rest plan to check.
    if (target.kind !== 'rest') continue;
    if (!exactlyEqual(plan.before?.start, target.start) || !exactlyEqual(plan.before?.end, target.end)) {
      violations.push(`repair ${plan.identityKey} records ${target.id} as ${plan.before?.start}..${plan.before?.end}, but the input has ${target.start}..${target.end}`);
    }
    const identity = plan.identity;
    if (plan.operation === REPAIR_OPERATIONS.CLOSE_GAP_INTO_PRECEDING_REST) {
      if (identity?.type !== INTERVAL_TYPES.INTER_EVENT_GAP || identity.previousEventId !== target.id) {
        violations.push(`gap closure ${plan.identityKey} does not describe a gap after its target ${target.id}`);
        continue;
      }
      const next = beforeById.get(identity.nextEventId);
      if (!exactlyEqual(identity.start, target.end)) {
        violations.push(`gap closure ${plan.identityKey} starts at ${identity.start}, but its target ${target.id} ends at ${target.end}`);
      }
      if (!next || next.role !== target.role || !exactlyEqual(identity.end, next.start)) {
        violations.push(`gap closure ${plan.identityKey} does not end at the onset of the following span of ${target.role}`);
      }
      if (!exactlyEqual(plan.after?.start, target.start)) {
        violations.push(`gap closure ${plan.identityKey} moves the start of ${target.id}`);
      }
      if (!exactlyEqual(plan.after?.end, identity.end)) {
        violations.push(`gap closure ${plan.identityKey} extends ${target.id} to ${plan.after?.end}, not to the interval end ${identity.end}`);
      }
      if (plan.absorbedEventId) violations.push(`gap closure ${plan.identityKey} absorbs ${plan.absorbedEventId}; a gap closure removes no event`);
    } else if (plan.operation === REPAIR_OPERATIONS.COALESCE_CONTIGUOUS_RESTS) {
      if (identity?.type !== INTERVAL_TYPES.EVENT_DURATION || identity.eventId !== target.id
        || !exactlyEqual(identity.start, target.start) || !exactlyEqual(identity.end, target.end)) {
        violations.push(`rest coalesce ${plan.identityKey} does not describe the duration of its target ${target.id}`);
        continue;
      }
      const absorbedRest = beforeById.get(plan.absorbedEventId);
      if (!absorbedRest || absorbedRest.kind !== 'rest' || absorbedRest.role !== target.role || !exactlyEqual(absorbedRest.end, target.start)) {
        violations.push(`rest coalesce ${plan.identityKey} does not absorb the contiguous preceding rest of ${target.role}`);
      } else if (!exactlyEqual(plan.after?.start, absorbedRest.start) || !exactlyEqual(plan.after?.end, target.end)) {
        violations.push(`rest coalesce ${plan.identityKey} does not span exactly ${absorbedRest.id} and ${target.id}`);
      }
    } else {
      violations.push(`repair ${plan.identityKey} states operation ${plan.operation}, which this layer does not implement`);
    }
  }

  // The neutrality claim itself, checked rather than argued: the role's audible
  // silence must be the same exact point set on both sides.
  const silenceBefore = JSON.stringify(silenceByRole(before));
  const silenceAfter = JSON.stringify(silenceByRole(after));
  if (silenceBefore !== silenceAfter) violations.push('the role silence point set changed; the repair was not silence-preserving');

  const beforeRests = before.events.filter(event => event.kind === 'rest');
  const afterRestById = new Map(after.events.filter(event => event.kind === 'rest').map(event => [event.id, event]));
  for (const restEvent of beforeRests) {
    const now = afterRestById.get(restEvent.id);
    if (!now) {
      if (!absorbed.has(restEvent.id)) violations.push(`rest ${restEvent.id} disappeared without an absorption plan`);
      continue;
    }
    if (absorbed.has(restEvent.id)) violations.push(`rest ${restEvent.id} was to be absorbed but is still present`);
    const plan = byKeyTarget.get(restEvent.id);
    if (!plan) {
      if (!exactlyEqual(restEvent.start, now.start) || !exactlyEqual(restEvent.end, now.end)) {
        violations.push(`rest ${restEvent.id} moved without a repair plan`);
      } else if (canonicalJson(restEvent) !== canonicalJson(now)) {
        violations.push(`rest ${restEvent.id} changed without a repair plan: its role, voice, provenance, tags or metadata differ`);
      }
      continue;
    }
    if (!exactlyEqual(now.start, plan.after?.start) || !exactlyEqual(now.end, plan.after?.end)) {
      violations.push(`rest ${restEvent.id} does not match its plan`);
    }
    if (repairedRestShape(restEvent) !== repairedRestShape(now)) {
      violations.push(`rest ${restEvent.id} changed beyond its timing: its kind, role, voice, tags or metadata differ`);
    }
    const absorbedRest = plan.absorbedEventId ? beforeById.get(plan.absorbedEventId) : null;
    const expectedSourceIds = sortedIds([...new Set([...(restEvent.sourceIds ?? []), ...(absorbedRest?.sourceIds ?? [])])]);
    const expectedSourceEventIds = sortedIds([...new Set([...(restEvent.sourceEventIds ?? []), ...(absorbedRest?.sourceEventIds ?? [])])]);
    if (canonicalJson(sortedIds(now.sourceIds)) !== canonicalJson(expectedSourceIds)
      || canonicalJson(sortedIds(now.sourceEventIds)) !== canonicalJson(expectedSourceEventIds)) {
      violations.push(`rest ${restEvent.id} provenance is not its own plus that of the rest it absorbed`);
    }
    const record = now.metadata?.technicalTimingRepair;
    if (!record || record.intervalKey !== plan.identityKey || record.operation !== plan.operation) {
      violations.push(`rest ${restEvent.id} does not carry the provenance record of its repair`);
    }
  }
  for (const [id] of afterRestById) {
    if (!beforeRests.some(event => event.id === id)) violations.push(`rest ${id} was invented`);
  }

  // Any other event is never a repair target either.
  for (const event of before.events) {
    if (SPAN_KINDS.has(event.kind)) continue;
    const now = afterById.get(event.id);
    if (!now || canonicalJson(now) !== canonicalJson(event)) violations.push(`${event.kind} event ${event.id} changed`);
  }

  // The input's events, in the input's order, less the absorbed rests.
  const expectedOrder = before.events.map(event => event.id).filter(id => !absorbed.has(id));
  if (canonicalJson(after.events.map(event => event.id)) !== canonicalJson(expectedOrder)) {
    violations.push('event order changed: the repaired project lists the input events in their order, less the absorbed rests');
  }

  for (const event of after.events) {
    if (f(event.end).cmp(event.start) <= 0) violations.push(`${event.id} has a non-positive duration`);
  }

  // No span of a role may overlap another span of that role unless the two
  // already overlapped in the input: a plan that extends a rest over a note,
  // or grows one over another span, is caught here even when it agrees with
  // itself.
  const overlapsBefore = overlappingSpanPairs(before);
  for (const pair of overlappingSpanPairs(after)) {
    if (overlapsBefore.has(pair)) continue;
    const [role, first, second] = pair.split('\u0000');
    violations.push(`${first} and ${second} overlap in ${role} after the repair`);
  }

  // The Tempo Map, the meter map, the source set, the decision record and the
  // project metadata (the Source-Faithful Baseline included) are never a repair
  // target. A silent edit to any of them is a violation here; the repair adds
  // only its own `technicalTimingRepair` record to the project metadata.
  const controls = project => canonicalJson([...project.tempoEvents, ...project.meterEvents]);
  if (controls(before) !== controls(after)) violations.push('tempo or meter map changed');
  if (JSON.stringify(before.sources) !== JSON.stringify(after.sources)) violations.push('source set changed');
  if (JSON.stringify(before.decisions) !== JSON.stringify(after.decisions)) violations.push('decision record changed');
  const { technicalTimingRepair: _recordBefore, ...metadataBefore } = before.metadata ?? {};
  const { technicalTimingRepair: _recordAfter, ...metadataAfter } = after.metadata ?? {};
  if (canonicalJson(metadataBefore) !== canonicalJson(metadataAfter)) violations.push('project metadata changed beyond the repair record');
  if (before.id === after.id) violations.push('the repaired candidate is indistinguishable from the input project');

  return violations;
}

// ── entry point ────────────────────────────────────────────────────────────

function result(fields) {
  return Object.freeze({
    canonical: EFFECTIVE_RULESET.canonical,
    safeGrid: SAFE_GRID.toString(),
    notice: TECHNICAL_REPAIR_NOTICE,
    presentedCount: 0,
    presentedIntervalKeys: Object.freeze([]),
    repairedIntervalKeys: Object.freeze([]),
    unrepairedIntervalKeys: Object.freeze([]),
    preservedIntervalKeys: Object.freeze([]),
    blockedIntervalKeys: Object.freeze([]),
    repairs: Object.freeze([]),
    unrepaired: Object.freeze([]),
    diagnostics: Object.freeze([]),
    baselineProjectId: null,
    repairedProject: null,
    repairedProjectId: null,
    verification: null,
    finalEmissionEligible: false,
    ...fields,
  });
}

/**
 * Normalize the technical timing residue micro-gap enforcement has already
 * rejected, exactly, or say precisely why it cannot.
 *
 * `enforcement` may be supplied by a caller that already computed it; it is
 * verified against a freshly computed report and a difference is fatal. Never
 * mutates `project`. Never returns `PASS` with a presented interval left
 * unrepaired, and never returns `PASS` without the authoritative enforcement
 * pass agreeing about the repaired candidate.
 */
export function repairTechnicalTiming(project, { mobileSyntax, enforcement, releaseEvidenceRegistry = null } = {}) {
  if (!project || typeof project !== 'object') throw Error('Canonical project is required');

  // The same enforcement inputs the caller graded with, so the supplied report
  // and the fresh one describe the same question — including recorded release
  // representations re-graded against the project's current evidence.
  const options = {
    ...(mobileSyntax === undefined ? {} : { mobileSyntax }),
    ...(releaseEvidenceRegistry ? { releaseEvidenceRegistry } : {}),
  };
  const fresh = enforceMicroGaps(project, options);
  const diagnostics = [];

  if (enforcement && enforcementFingerprint(enforcement) !== enforcementFingerprint(fresh)) {
    diagnostics.push(diagnostic(
      REPAIR_DIAGNOSTICS.ENFORCEMENT_STALE,
      REPAIR_SEVERITY.ERROR,
      'The supplied micro-gap enforcement report does not describe this project. A repair worklist is only meaningful against the enforcement pass that produced it.',
      { suppliedStatus: enforcement?.status ?? null, currentStatus: fresh.status },
    ));
    return result({
      status: REPAIR_STATUS.FAIL,
      baselineProjectId: project.id,
      diagnostics: freezeDeep(diagnostics),
      preservedIntervalKeys: fresh.preservedIntervalKeys,
      blockedIntervalKeys: fresh.blockedIntervalKeys,
    });
  }

  const report = fresh;
  const { records, malformed } = readRejectedTechnicalRecords(report);
  const presentedIntervalKeys = records.map(entry => entry.identityKey);

  if (malformed.length) {
    diagnostics.push(diagnostic(
      REPAIR_DIAGNOSTICS.ENFORCEMENT_MALFORMED,
      REPAIR_SEVERITY.ERROR,
      `${malformed.length} rejected interval key(s) have no intact technical-residue enforcement record.`,
      { malformed: freezeDeep(malformed) },
    ));
    return result({
      status: REPAIR_STATUS.FAIL,
      baselineProjectId: project.id,
      presentedCount: presentedIntervalKeys.length,
      presentedIntervalKeys: freezeDeep(presentedIntervalKeys),
      unrepairedIntervalKeys: freezeDeep(malformed.map(item => item.identityKey)),
      preservedIntervalKeys: report.preservedIntervalKeys,
      blockedIntervalKeys: report.blockedIntervalKeys,
      diagnostics: freezeDeep(diagnostics),
    });
  }

  // A contract that has stopped echoing the published rule has already demoted
  // enforcement to PENDING. Repairing on top of it would be acting on a policy
  // this module cannot confirm, so it does not run.
  if (!report.policy.conformant) {
    diagnostics.push(diagnostic(
      REPAIR_DIAGNOSTICS.POLICY_NON_CONFORMANT,
      REPAIR_SEVERITY.PENDING,
      `The executable Final micro-gap contract is non-conformant (${report.policy.blockers.join(', ')}). No repair is attempted.`,
      { policyBlockers: report.policy.blockers },
    ));
    return result({
      status: REPAIR_STATUS.PENDING,
      baselineProjectId: project.id,
      presentedCount: presentedIntervalKeys.length,
      presentedIntervalKeys: freezeDeep(presentedIntervalKeys),
      unrepairedIntervalKeys: freezeDeep(presentedIntervalKeys),
      preservedIntervalKeys: report.preservedIntervalKeys,
      blockedIntervalKeys: report.blockedIntervalKeys,
      diagnostics: freezeDeep(diagnostics),
    });
  }

  const spans = spanEvents(project);
  const eventsById = new Map(spans.map(event => [event.id, event]));
  const spansByRole = new Map();
  for (const event of spans) {
    if (!ASSIGNED_ROLES.has(event.role)) continue;
    if (!spansByRole.has(event.role)) spansByRole.set(event.role, []);
    spansByRole.get(event.role).push(event);
  }
  const decisionEventIds = new Set((project.decisions ?? []).flatMap(decision => decision.eventIds ?? []));
  const context = { eventsById, spansByRole, decisionEventIds };

  const planned = records.map(entry => planFor(entry, context));
  const unrepaired = planned.filter(plan => !plan.ok);
  const { kept, dropped } = rejectInteractingPlans(planned.filter(plan => plan.ok));
  unrepaired.push(...dropped);
  unrepaired.sort((left, right) => (left.identityKey < right.identityKey ? -1 : left.identityKey > right.identityKey ? 1 : 0));

  let repairedProject = null;
  if (kept.length) {
    try {
      repairedProject = applyPlans(project, kept);
    } catch (error) {
      diagnostics.push(diagnostic(
        REPAIR_DIAGNOSTICS.PROJECT_REBUILD_FAILED,
        REPAIR_SEVERITY.ERROR,
        `The repaired candidate could not be built: ${error.message}`,
        {},
      ));
      return result({
        status: REPAIR_STATUS.FAIL,
        baselineProjectId: project.id,
        presentedCount: presentedIntervalKeys.length,
        presentedIntervalKeys: freezeDeep(presentedIntervalKeys),
        unrepairedIntervalKeys: freezeDeep(presentedIntervalKeys),
        preservedIntervalKeys: report.preservedIntervalKeys,
        blockedIntervalKeys: report.blockedIntervalKeys,
        diagnostics: freezeDeep(diagnostics),
      });
    }

    const violations = verifyRepairInvariants(project, repairedProject, kept);
    if (violations.length) {
      diagnostics.push(diagnostic(
        REPAIR_DIAGNOSTICS.INVARIANT_VIOLATED,
        REPAIR_SEVERITY.ERROR,
        `The repaired candidate violates ${violations.length} repair invariant(s). Nothing is emitted from it.`,
        { violations: freezeDeep(violations) },
      ));
      return result({
        status: REPAIR_STATUS.FAIL,
        baselineProjectId: project.id,
        presentedCount: presentedIntervalKeys.length,
        presentedIntervalKeys: freezeDeep(presentedIntervalKeys),
        unrepairedIntervalKeys: freezeDeep(presentedIntervalKeys),
        preservedIntervalKeys: report.preservedIntervalKeys,
        blockedIntervalKeys: report.blockedIntervalKeys,
        diagnostics: freezeDeep(diagnostics),
      });
    }
  }

  // The same authority that rejected the residue has to agree the repaired
  // candidate is clean. This is what makes "repaired" a verified claim instead of
  // this module's own opinion of its own output.
  const verification = repairedProject ? enforceMicroGaps(repairedProject, options) : report;

  // `delta` is the exact rational distance the repaired event's boundary moved:
  // for a gap closure that is the residue itself, for a coalesce it is the
  // absorbed rest's whole length. The sub-grid interval is `identity.length`.
  const repairs = kept.map(plan => freezeDeep({
    identityKey: plan.identityKey,
    identity: plan.identity,
    intervalType: plan.identity.type,
    operation: plan.operation,
    neutrality: plan.neutrality,
    role: plan.role,
    classification: MICRO_TIMING_CLASSIFICATIONS.TECHNICAL_RESIDUE,
    decisionId: plan.decisionId,
    targetEventId: plan.targetEventId,
    absorbedEventId: plan.absorbedEventId,
    before: plan.before,
    after: plan.after,
    delta: plan.delta,
    permittedBecause: PERMITTED_BECAUSE[plan.operation],
    // MOBILE_SYNTAX §11 step 8: enough to put the candidate back exactly.
    reversal: {
      restore: { eventId: plan.targetEventId, start: plan.before.start, end: plan.before.end },
      reinstate: plan.absorbed ?? null,
    },
  }));

  const repairedIntervalKeys = kept.map(plan => plan.identityKey);
  const unrepairedIntervalKeys = unrepaired.map(item => item.identityKey);

  if (unrepaired.length) {
    diagnostics.push(diagnostic(
      REPAIR_DIAGNOSTICS.UNSUPPORTED_INTERVAL,
      REPAIR_SEVERITY.PENDING,
      `${unrepaired.length} rejected interval(s) have no repair this layer can perform without choosing between musically different outcomes.`,
      { unrepaired: freezeDeep(unrepaired.map(item => ({ identityKey: item.identityKey, reason: item.reason, detail: item.detail ?? null }))) },
    ));
  }
  if (verification.blockedIntervalKeys.length) {
    diagnostics.push(diagnostic(
      REPAIR_DIAGNOSTICS.BLOCKED_INTERVAL_PRESENT,
      REPAIR_SEVERITY.PENDING,
      `${verification.blockedIntervalKeys.length} sub-grid interval(s) remain unproven. Unproven material is never repaired or acted on.`,
      { blockedIntervalKeys: verification.blockedIntervalKeys },
    ));
  }
  if (verification.preservedIntervalKeys.length) {
    diagnostics.push(diagnostic(
      REPAIR_DIAGNOSTICS.PRESERVED_INTERVAL_PRESENT,
      REPAIR_SEVERITY.NOTICE,
      `${verification.preservedIntervalKeys.length} source-supported sub-grid interval(s) are preserved untouched. No Final token is shorter than the safe grid, so the candidate is still not Final-emittable for that separate, already-published reason.`,
      { preservedIntervalKeys: verification.preservedIntervalKeys },
    ));
  }

  // Two independent guards stand between an unrepaired interval and PASS: the
  // worklist must be empty, *and* re-running enforcement on the result must find
  // nothing rejected. Dropping an interval from the worklist cannot buy a PASS.
  const everythingRepaired = unrepaired.length === 0
    && repairedIntervalKeys.length === presentedIntervalKeys.length;
  // "Clean" means what it meant before G10 raised
  // MICRO_TIMING_SOURCE_SUPPORTED_NOT_FINAL_REPRESENTABLE: PASS, or PENDING whose
  // only blocker is that code. G10 raises it exactly when something is
  // preserved and never makes G10 FAIL, so this predicate is true on exactly the
  // verifications that would be PASS without that code. The preserved interval
  // is reported by this layer itself (PRESERVED_INTERVAL_PRESENT) and still
  // keeps finalEmissionEligible false below; it does not make the repair's own
  // verification unclear. Any other PENDING -- UNKNOWN beside it, for example --
  // is still not clean.
  const verificationClean = verification.rejectedIntervalKeys.length === 0
    && (verification.status === 'PASS'
      || (verification.status === 'PENDING'
        && verification.blockers.length === 1
        && verification.blockers[0] === MICRO_GAP_BLOCKERS.SOURCE_SUPPORTED_NOT_FINAL_REPRESENTABLE));

  if (!verificationClean && everythingRepaired) {
    // A rejected interval surviving the repair is a defect in this layer; any
    // other non-PASS is the enforcement pass declining to clear the candidate.
    const survived = verification.rejectedIntervalKeys.length > 0;
    diagnostics.push(diagnostic(
      survived ? REPAIR_DIAGNOSTICS.VERIFICATION_FAILED : REPAIR_DIAGNOSTICS.VERIFICATION_NOT_CLEAR,
      survived ? REPAIR_SEVERITY.ERROR : REPAIR_SEVERITY.PENDING,
      `Re-running micro-gap enforcement on the repaired candidate returned ${verification.status} (${verification.blockers.join(', ') || 'no blockers'}).`,
      { blockers: verification.blockers, rejectedIntervalKeys: verification.rejectedIntervalKeys },
    ));
  }

  if (!presentedIntervalKeys.length) {
    diagnostics.push(diagnostic(
      REPAIR_DIAGNOSTICS.NOT_REQUIRED,
      REPAIR_SEVERITY.NOTICE,
      'Micro-gap enforcement rejected no interval, so there is nothing to repair. The candidate is returned unchanged.',
      {},
    ));
  } else if (repairs.length) {
    diagnostics.push(diagnostic(
      REPAIR_DIAGNOSTICS.APPLIED,
      REPAIR_SEVERITY.NOTICE,
      `${repairs.length} Canonical-classified technical interval(s) were normalized exactly. The repaired candidate is a distinct project; the input is unchanged.`,
      { repairedIntervalKeys: freezeDeep(repairedIntervalKeys), repairedProjectId: repairedProject?.id ?? null },
    ));
  }

  const hasError = diagnostics.some(item => item.severity === REPAIR_SEVERITY.ERROR);
  const hasPending = diagnostics.some(item => item.severity === REPAIR_SEVERITY.PENDING);
  const status = hasError
    ? REPAIR_STATUS.FAIL
    : hasPending || !everythingRepaired || !verificationClean
      ? REPAIR_STATUS.PENDING
      : REPAIR_STATUS.PASS;

  return result({
    status,
    baselineProjectId: project.id,
    presentedCount: presentedIntervalKeys.length,
    presentedIntervalKeys: freezeDeep(presentedIntervalKeys),
    repairedIntervalKeys: freezeDeep(repairedIntervalKeys),
    unrepairedIntervalKeys: freezeDeep(unrepairedIntervalKeys),
    preservedIntervalKeys: verification.preservedIntervalKeys,
    blockedIntervalKeys: verification.blockedIntervalKeys,
    repairs: Object.freeze(repairs),
    unrepaired: freezeDeep(unrepaired.map(item => ({
      identityKey: item.identityKey,
      identity: item.identity,
      reason: item.reason,
      detail: item.detail ?? null,
    }))),
    diagnostics: freezeDeep(diagnostics),
    repairedProject,
    repairedProjectId: repairedProject?.id ?? null,
    verification,
    // A repaired candidate is eligible for Final emission only when this layer
    // passed *and* nothing sub-grid is left that Final cannot write — a preserved
    // source-supported interval is provably unrepresentable and is never repaired.
    finalEmissionEligible: status === REPAIR_STATUS.PASS
      && verificationClean
      && verification.preservedIntervalKeys.length === 0,
  });
}

// ── provisional release rendering (machine delivery only) ──────────────────
//
// ACCEPTANCE_CRITERIA "Delivered first, flagged for listening", rule 1
// (2026-09-23-v3). Where a sub-grid release interval stays UNKNOWN only because
// the evidence to decide the release is missing, and the release follows its
// source's systematic export offset, a delivered Final may hold that release to
// the following attack or next 1/64 grid point (EXTEND_TO_NEXT_GRID).
//
// This is not a repair and claims no neutrality: a held note sounds longer than
// the candidate says, by less than the grid. It is therefore kept apart from
// everything above:
//
//   * its only worklist is `provisionalReleases` from an enforcement report that
//     carries MICRO_TIMING_RELEASE_PROVISIONAL, verified against a freshly
//     computed report. It never decides which releases qualify;
//   * each listed release is re-checked against the project: the note is
//     current, its release is exactly the listed one, the hold is a single
//     sub-grid step onto the safe grid, and no other span of its role lies in
//     between. Every blocked interval must be closed by some listed release;
//   * the rendered project is a new project and exists for serialization only.
//     The candidate it came from is never mutated, never stored and never
//     re-graded as if it were the rendering. Its intervals stay UNKNOWN;
//   * `verifyProvisionalRenderingInvariants` checks the produced project rather
//     than the plan: only the listed notes' releases moved, each to exactly its
//     listed point, the role's silence shrank by exactly those spans, and
//     nothing else changed;
//   * the same enforcement then has to find the rendering clean.
//
// Whether a delivery may use it at all is the machine-delivery schema's call
// (final/delivery-evaluator.mjs), made by the emitter before it asks for one.

export const PROVISIONAL_RELEASE_RENDERING = Object.freeze({
  OPERATION: 'hold-release-provisionally-to-next-grid-point',
  REPRESENTATION: 'EXTEND_TO_NEXT_GRID',
  METADATA_KEY: 'provisionalReleaseRendering',
  SCOPE: 'delivered-final-only',
});

export const PROVISIONAL_RENDERING_DIAGNOSTICS = Object.freeze({
  ENFORCEMENT_STALE: 'PROVISIONAL_RELEASE_ENFORCEMENT_STALE',
  NOT_ELIGIBLE: 'PROVISIONAL_RELEASE_NOT_ELIGIBLE',
  WORKLIST_NOT_CURRENT: 'PROVISIONAL_RELEASE_WORKLIST_NOT_CURRENT',
  INTERVAL_NOT_COVERED: 'PROVISIONAL_RELEASE_INTERVAL_NOT_COVERED',
  REBUILD_FAILED: 'PROVISIONAL_RELEASE_REBUILD_FAILED',
  INVARIANT_VIOLATED: 'PROVISIONAL_RELEASE_INVARIANT_VIOLATED',
  VERIFICATION_NOT_CLEAR: 'PROVISIONAL_RELEASE_VERIFICATION_NOT_CLEAR',
  APPLIED: 'PROVISIONAL_RELEASES_RENDERED',
});

export const PROVISIONAL_RENDERING_NOTICE = 'Provisional release rendering is a delivery representation only (ACCEPTANCE_CRITERIA "Delivered first, flagged for listening"). Each listed release is held to the following attack or next 1/64 grid point in the delivered MML. The stored candidate and the Source-Faithful Baseline keep the source release, and every interval a hold closes stays UNKNOWN. It certifies nothing: not PASS, not technical residue, not source-supported meaning, not VALIDATED and not IN_GAME_ACCEPTED.';

// The parts of a report the rendering acts on, on top of what a repair acts on.
function provisionalFingerprint(report) {
  return JSON.stringify([
    enforcementFingerprint(report),
    [...(report?.blockers ?? [])],
    (report?.provisionalReleases ?? []).map(item => [item?.eventId ?? null, item?.role ?? null, item?.release ?? null, item?.heldTo ?? null, [...(item?.intervalKeys ?? [])]]),
  ]);
}

function renderingResult(fields) {
  return Object.freeze({
    canonical: EFFECTIVE_RULESET.canonical,
    safeGrid: SAFE_GRID.toString(),
    notice: PROVISIONAL_RENDERING_NOTICE,
    storedProjectId: null,
    renderedProject: null,
    renderedProjectId: null,
    renderings: Object.freeze([]),
    heldEventIds: Object.freeze([]),
    intervalKeys: Object.freeze([]),
    releaseOffsetSources: Object.freeze([]),
    preRendering: null,
    verification: null,
    diagnostics: Object.freeze([]),
    ...fields,
  });
}

const normalizedSpans = spans => spans.map(([start, end]) => [f(start).toString(), f(end).toString()]);

// Exact interval-set difference of sorted, disjoint spans.
function subtractSpans(spans, cuts) {
  let result = spans.map(([start, end]) => [f(start), f(end)]);
  for (const [cutStart, cutEnd] of cuts.map(([start, end]) => [f(start), f(end)])) {
    result = result.flatMap(([start, end]) => {
      if (cutEnd.cmp(start) <= 0 || cutStart.cmp(end) >= 0) return [[start, end]];
      const kept = [];
      if (cutStart.cmp(start) > 0) kept.push([start, cutStart]);
      if (cutEnd.cmp(end) < 0) kept.push([cutEnd, end]);
      return kept;
    });
  }
  return result.map(([start, end]) => [start.toString(), end.toString()]);
}

/**
 * Everything a provisional rendering is forbidden to have done, checked on the
 * produced project rather than assumed from the holds that produced it.
 *
 * Exported for the same reason as `verifyRepairInvariants`: the planner refuses
 * everything this catches, so a regression drives it with hand-built projects.
 */
export function verifyProvisionalRenderingInvariants(before, after, holds) {
  const violations = [];
  const held = new Map(holds.map(hold => [hold.eventId, hold]));
  const byId = events => new Map(events.map(event => [event.id, event]));
  const beforeNotes = before.events.filter(event => event.kind === 'note');
  const afterNotes = after.events.filter(event => event.kind === 'note');
  const afterNoteById = byId(afterNotes);
  if (beforeNotes.length !== afterNotes.length) violations.push(`attack count changed: ${beforeNotes.length} -> ${afterNotes.length}`);
  if (before.events.length !== after.events.length) violations.push(`event count changed: ${before.events.length} -> ${after.events.length}`);

  const shapeWithoutEnd = event => JSON.stringify({ id: event.id, kind: event.kind, pitch: event.pitch ?? null, start: event.start, volume: event.volume ?? null, role: event.role, voice: event.voice ?? null, sourceIds: [...(event.sourceIds ?? [])], sourceEventIds: [...(event.sourceEventIds ?? [])] });
  for (const note of beforeNotes) {
    const now = afterNoteById.get(note.id);
    if (!now) { violations.push(`note ${note.id} disappeared`); continue; }
    // Onset, pitch, volume, role and provenance never move. Only a listed
    // note's release does, and only to its listed point.
    if (shapeWithoutEnd(note) !== shapeWithoutEnd(now)) violations.push(`note ${note.id} changed beyond its release`);
    const hold = held.get(note.id);
    if (!hold) {
      if (!exactlyEqual(note.end, now.end)) violations.push(`note ${note.id} release moved without being listed`);
      continue;
    }
    if (!exactlyEqual(note.end, hold.release)) violations.push(`note ${note.id} was listed at release ${hold.release} but the candidate says ${note.end}`);
    if (!exactlyEqual(now.end, hold.heldTo)) violations.push(`note ${note.id} is held to ${now.end}, not its listed ${hold.heldTo}`);
    const delta = f(now.end).sub(f(note.end));
    if (delta.cmp(0) <= 0 || delta.cmp(SAFE_GRID) >= 0) violations.push(`note ${note.id} moved by ${delta.toString()}, which is not one sub-grid step later`);
    if (f(now.end).div(SAFE_GRID).d !== 1n) violations.push(`note ${note.id} is held to ${now.end}, which is not a safe-grid point`);
    const overlapped = afterNotes.filter(other => other.id !== now.id && other.role === now.role
      && f(other.start).cmp(now.end) < 0 && f(other.end).cmp(note.end) > 0);
    if (overlapped.length) violations.push(`note ${note.id} is held across ${overlapped.map(other => other.id).join(', ')}`);
  }
  for (const note of afterNotes) if (!beforeNotes.some(event => event.id === note.id)) violations.push(`note ${note.id} was invented`);
  for (const id of held.keys()) if (!beforeNotes.some(event => event.id === id)) violations.push(`listed event ${id} is not a note of the candidate`);

  // Rests are never touched at all.
  const restShape = event => JSON.stringify({ id: event.id, start: event.start, end: event.end, role: event.role, sourceIds: [...(event.sourceIds ?? [])] });
  const afterRests = byId(after.events.filter(event => event.kind === 'rest'));
  const beforeRests = before.events.filter(event => event.kind === 'rest');
  for (const restEvent of beforeRests) {
    const now = afterRests.get(restEvent.id);
    if (!now) violations.push(`rest ${restEvent.id} disappeared`);
    else if (restShape(restEvent) !== restShape(now)) violations.push(`rest ${restEvent.id} changed`);
  }
  for (const id of afterRests.keys()) if (!beforeRests.some(event => event.id === id)) violations.push(`rest ${id} was invented`);

  // The role's silence shrank by exactly the held spans, and by nothing else.
  const cutsByRole = new Map();
  for (const hold of holds) {
    if (!cutsByRole.has(hold.role)) cutsByRole.set(hold.role, []);
    cutsByRole.get(hold.role).push([hold.release, hold.heldTo]);
  }
  const silenceBefore = silenceByRole(before);
  const silenceAfter = silenceByRole(after);
  for (const role of new Set([...Object.keys(silenceBefore), ...Object.keys(silenceAfter)])) {
    const expected = subtractSpans(normalizedSpans(silenceBefore[role] ?? []), cutsByRole.get(role) ?? []);
    if (JSON.stringify(expected) !== JSON.stringify(normalizedSpans(silenceAfter[role] ?? []))) {
      violations.push(`${role}: the silence did not shrink by exactly the held spans`);
    }
  }

  for (const event of after.events) {
    if (f(event.end).cmp(event.start) <= 0) violations.push(`${event.id} has a non-positive duration`);
  }
  const controlsBefore = JSON.stringify([...before.tempoEvents].map(controlShape).concat([...before.meterEvents].map(controlShape)));
  const controlsAfter = JSON.stringify([...after.tempoEvents].map(controlShape).concat([...after.meterEvents].map(controlShape)));
  if (controlsBefore !== controlsAfter) violations.push('tempo or meter map changed');
  if (JSON.stringify(before.sources) !== JSON.stringify(after.sources)) violations.push('source set changed');
  if (JSON.stringify(before.decisions) !== JSON.stringify(after.decisions)) violations.push('decision record changed');
  if (before.id === after.id) violations.push('the rendering is indistinguishable from the stored candidate');
  return violations;
}

function applyProvisionalHolds(project, holds) {
  const replacements = new Map();
  for (const hold of holds) {
    const target = project.events.find(event => event.id === hold.eventId);
    const record = freezeDeep({
      operation: PROVISIONAL_RELEASE_RENDERING.OPERATION,
      representation: PROVISIONAL_RELEASE_RENDERING.REPRESENTATION,
      scope: PROVISIONAL_RELEASE_RENDERING.SCOPE,
      classification: MICRO_TIMING_CLASSIFICATIONS.UNKNOWN,
      release: hold.release,
      heldTo: hold.heldTo,
      delta: hold.delta,
      intervalKeys: [...hold.intervalKeys],
      reversal: { field: 'end', restore: hold.release },
      canonical: EFFECTIVE_RULESET.canonical,
    });
    replacements.set(hold.eventId, rebuildEvent(target, {
      start: target.start,
      end: hold.heldTo,
      repairRecord: record,
      metadataKey: PROVISIONAL_RELEASE_RENDERING.METADATA_KEY,
    }));
  }
  return createCanonicalProject({
    id: `${project.id}#provisional-release-rendering`,
    title: `${project.title} (provisional release rendering)`,
    sources: [...project.sources],
    events: project.events.map(event => replacements.get(event.id) ?? event),
    tempoEvents: [...project.tempoEvents],
    meterEvents: [...project.meterEvents],
    decisions: [...project.decisions],
    metadata: {
      ...structuredClone(project.metadata ?? {}),
      [PROVISIONAL_RELEASE_RENDERING.METADATA_KEY]: freezeDeep({
        storedProjectId: project.id,
        scope: PROVISIONAL_RELEASE_RENDERING.SCOPE,
        heldEventIds: holds.map(hold => hold.eventId),
        canonical: EFFECTIVE_RULESET.canonical,
      }),
    },
  });
}

// The stored candidate's verdict the rendering started from. Counts, not key
// lists: the keys are on the enforcement report and on each rendering.
const preRenderingOf = report => freezeDeep({
  status: report?.status ?? null,
  blockers: [...(report?.blockers ?? [])],
  blockedIntervalCount: (report?.blockedIntervalKeys ?? []).length,
  unknownCount: report?.unknownCount ?? null,
});

/**
 * Hold, for a delivered Final only, exactly the releases a fresh enforcement
 * report lists under MICRO_TIMING_RELEASE_PROVISIONAL, or say precisely why not.
 *
 * `enforcement` may be supplied by a caller that already computed it; it is
 * verified against a fresh report and a difference is fatal. Never mutates
 * `project`. Returns PASS only with a rendered project the same enforcement
 * finds clean.
 */
export function renderProvisionalReleases(project, { mobileSyntax, enforcement, releaseEvidenceRegistry = null } = {}) {
  if (!project || typeof project !== 'object') throw Error('Canonical project is required');
  const options = {
    ...(mobileSyntax === undefined ? {} : { mobileSyntax }),
    ...(releaseEvidenceRegistry ? { releaseEvidenceRegistry } : {}),
  };
  const fresh = enforceMicroGaps(project, options);
  const base = {
    storedProjectId: project.id,
    preRendering: preRenderingOf(fresh),
    releaseOffsetSources: fresh.releaseOffsetSources ?? Object.freeze([]),
  };
  const refuse = (status, code, severity, message, details = {}) => renderingResult({
    ...base,
    status,
    diagnostics: freezeDeep([diagnostic(code, severity, message, details)]),
  });

  if (enforcement && provisionalFingerprint(enforcement) !== provisionalFingerprint(fresh)) {
    return refuse(REPAIR_STATUS.FAIL, PROVISIONAL_RENDERING_DIAGNOSTICS.ENFORCEMENT_STALE, REPAIR_SEVERITY.ERROR,
      'The supplied micro-gap enforcement report does not describe this project. A provisional worklist is only meaningful against the enforcement pass that produced it.');
  }
  if (fresh.status !== 'PENDING' || !fresh.blockers.includes(MICRO_GAP_BLOCKERS.RELEASE_PROVISIONAL) || !fresh.provisionalReleases?.length) {
    return refuse(REPAIR_STATUS.PENDING, PROVISIONAL_RENDERING_DIAGNOSTICS.NOT_ELIGIBLE, REPAIR_SEVERITY.PENDING,
      `Micro-gap enforcement returned ${fresh.status} (${fresh.blockers.join(', ') || 'no blockers'}) without listing every open question as a provisional release. Nothing is rendered.`,
      { blockers: fresh.blockers });
  }

  const spans = spanEvents(project);
  const eventsById = new Map(spans.map(event => [event.id, event]));
  const spansByRole = new Map();
  for (const event of spans) {
    if (!ASSIGNED_ROLES.has(event.role)) continue;
    if (!spansByRole.has(event.role)) spansByRole.set(event.role, []);
    spansByRole.get(event.role).push(event);
  }
  const blocked = new Set(fresh.blockedIntervalKeys);
  const covered = new Set();
  const holds = [];
  const refused = [];
  const listed = new Set();
  for (const item of fresh.provisionalReleases) {
    const event = eventsById.get(item.eventId);
    const refuseItem = reason => refused.push({ eventId: item.eventId ?? null, reason });
    if (!event || event.kind !== 'note') { refuseItem('listed event is not a note of this project'); continue; }
    if (listed.has(event.id)) { refuseItem('listed more than once'); continue; }
    listed.add(event.id);
    if (!ASSIGNED_ROLES.has(event.role) || event.role !== item.role) { refuseItem('role does not match the project'); continue; }
    if (!exactlyEqual(event.end, item.release)) { refuseItem(`release is ${event.end}, listed ${item.release}`); continue; }
    let release;
    let heldTo;
    try { release = f(item.release); heldTo = f(item.heldTo); } catch { refuseItem('hold point is not an exact rational'); continue; }
    const delta = heldTo.sub(release);
    if (delta.cmp(0) <= 0 || delta.cmp(SAFE_GRID) >= 0) { refuseItem(`hold by ${delta.toString()} is not one sub-grid step later`); continue; }
    if (heldTo.div(SAFE_GRID).d !== 1n) { refuseItem(`hold point ${item.heldTo} is not on the safe grid`); continue; }
    const occupied = spansInsideOpenInterval(spansByRole.get(event.role) ?? [], release, heldTo, new Set([event.id]));
    if (occupied.length) { refuseItem(`${occupied.length} other span(s) of ${event.role} lie between the release and the hold point`); continue; }
    const keys = Array.isArray(item.intervalKeys) ? item.intervalKeys : [];
    if (keys.some(key => !blocked.has(key))) { refuseItem('names an interval enforcement does not hold open'); continue; }
    for (const key of keys) covered.add(key);
    holds.push({ eventId: event.id, role: event.role, release: release.toString(), heldTo: heldTo.toString(), delta: delta.toString(), intervalKeys: [...keys] });
  }
  if (refused.length) {
    return refuse(REPAIR_STATUS.FAIL, PROVISIONAL_RENDERING_DIAGNOSTICS.WORKLIST_NOT_CURRENT, REPAIR_SEVERITY.ERROR,
      `${refused.length} listed release(s) do not describe this project. Nothing is rendered.`, { refused: freezeDeep(refused) });
  }
  const uncovered = [...blocked].filter(key => !covered.has(key));
  if (uncovered.length) {
    return refuse(REPAIR_STATUS.FAIL, PROVISIONAL_RENDERING_DIAGNOSTICS.INTERVAL_NOT_COVERED, REPAIR_SEVERITY.ERROR,
      `${uncovered.length} unproven interval(s) are not closed by any listed release. Nothing is rendered.`, { uncoveredIntervalKeys: freezeDeep(uncovered) });
  }

  let rendered;
  try {
    rendered = applyProvisionalHolds(project, holds);
  } catch (error) {
    return refuse(REPAIR_STATUS.FAIL, PROVISIONAL_RENDERING_DIAGNOSTICS.REBUILD_FAILED, REPAIR_SEVERITY.ERROR,
      `The rendering could not be built: ${error.message}`);
  }
  const violations = verifyProvisionalRenderingInvariants(project, rendered, holds);
  if (violations.length) {
    return refuse(REPAIR_STATUS.FAIL, PROVISIONAL_RENDERING_DIAGNOSTICS.INVARIANT_VIOLATED, REPAIR_SEVERITY.ERROR,
      `The rendering violates ${violations.length} invariant(s). Nothing is emitted from it.`, { violations: freezeDeep(violations) });
  }

  // The authority that listed the releases has to find the rendering clean.
  const verification = enforceMicroGaps(rendered, options);
  const clean = verification.status === 'PASS'
    && verification.blockers.length === 0
    && verification.blockedIntervalKeys.length === 0
    && verification.preservedIntervalKeys.length === 0
    && verification.rejectedIntervalKeys.length === 0
    && (verification.provisionalReleases ?? []).length === 0;
  if (!clean) {
    return renderingResult({
      ...base,
      status: REPAIR_STATUS.PENDING,
      verification,
      diagnostics: freezeDeep([diagnostic(PROVISIONAL_RENDERING_DIAGNOSTICS.VERIFICATION_NOT_CLEAR, REPAIR_SEVERITY.PENDING,
        `Re-running micro-gap enforcement on the rendering returned ${verification.status} (${verification.blockers.join(', ') || 'no blockers'}). Nothing is emitted from it.`,
        { blockers: verification.blockers })]),
    });
  }

  const renderings = fresh.provisionalReleases.map(item => freezeDeep({
    eventId: item.eventId,
    role: item.role,
    pitch: item.pitch,
    onset: item.onset,
    release: item.release,
    renderedRelease: item.heldTo,
    delta: item.delta,
    deltaTicks: item.deltaTicks ?? null,
    baselineRelease: item.baselineRelease ?? null,
    sourceIds: [...(item.sourceIds ?? [])],
    offsetBeforeNextGrid: item.offsetBeforeNextGrid ?? null,
    effect: item.effect ?? null,
    representation: PROVISIONAL_RELEASE_RENDERING.REPRESENTATION,
    classification: MICRO_TIMING_CLASSIFICATIONS.UNKNOWN,
    intervalKeys: [...item.intervalKeys],
  }));
  return renderingResult({
    ...base,
    status: REPAIR_STATUS.PASS,
    renderedProject: rendered,
    renderedProjectId: rendered.id,
    renderings: Object.freeze(renderings),
    heldEventIds: freezeDeep(holds.map(hold => hold.eventId)),
    intervalKeys: freezeDeep(fresh.provisionalReleaseIntervalKeys ?? []),
    verification,
    diagnostics: freezeDeep([diagnostic(PROVISIONAL_RENDERING_DIAGNOSTICS.APPLIED, REPAIR_SEVERITY.NOTICE,
      `${holds.length} release(s) are held provisionally for delivery. The rendering is a distinct project; the stored candidate is unchanged and its intervals stay UNKNOWN.`,
      { heldEventCount: holds.length, renderedProjectId: rendered.id })]),
  });
}
