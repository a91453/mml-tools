// G11-D downstream wiring.
//
// This module computes nothing. It exists so that "re-run the existing
// pipeline against the applied candidate" is one named call with one shape,
// instead of six call sites that can each quietly skip a gate. Every verdict in
// the result comes from the module that already owns it:
//
//   compare/version-drift        baseline and accepted-previous diffs
//   arbitration/core3            Core3 continuity and false Lead gaps
//   arbitration/lead-demotion    the Lead Demotion Gate
//   arbitration/harmony          cross-source same-pitch / m2 / M7 / m9 review
//   final/readiness              the per-song readiness gates
//
// Nothing here relaxes, overrides, caches or short-circuits any of them, and
// nothing here reads the G11-D application's own `status` as evidence: a PASS
// from G11-D says the accepted decisions were applied faithfully, and says
// nothing about whether the arrangement is correct.

import { compareCandidateLineage, compareCanonicalVersions } from '../compare/version-drift.mjs';
import { evaluateCore3Continuity } from '../arbitration/core3.mjs';
import { evaluateCore3Completeness } from '../arbitration/core3-completeness.mjs';
import {
  evaluateLeadDemotion,
  evaluateLeadPromotion,
  leadEvidenceIdentityBlockers,
  LEAD_EVIDENCE_IDENTITY_MISMATCH,
  LEAD_EVIDENCE_PROVENANCE_PAIR_AMBIGUOUS,
} from '../arbitration/lead-demotion.mjs';
import { analyzeCrossSourceHarmony } from '../arbitration/harmony.mjs';
import { evaluateProjectReadiness } from '../final/index.mjs';
import {
  ACCEPTED_DECISION_TYPES,
  LEAD_ROLE,
  DECISION_REJECTION,
  CANONICAL_PROJECT_SCHEMA,
  revisionIdentityMatches,
  candidateDigestOf,
  baselineIdentityOf,
  snapshotDigestOf,
  leadContextDigestOf,
} from './decision-application.mjs';

/**
 * Is this application result what it says it is?
 *
 * An application result is data. Its `status`, its `candidate` and its
 * `revision` can each be edited independently after the fact, and readiness
 * reads the Source-Faithful snapshot *embedded in the candidate* -- so a
 * candidate whose snapshot was swapped for itself would show the baseline gate
 * no changes at all, and the Lead gate would find nothing to require. Nothing
 * downstream is run until the three agree with each other and with the
 * baseline the caller actually handed in:
 *
 *   revision.id                      recomputes from the revision's own content
 *   revision.candidateDigest         matches the candidate supplied
 *   revision.baselineIdentity        matches the baseline supplied
 *   candidate's embedded snapshot    matches the baseline supplied
 *   candidate.metadata.g11d.revision names this revision
 *
 * Returns the reasons rather than throwing: a forged or stale application is a
 * reportable condition, and the caller decides what to show.
 */
export function applicationIntegrity(application, against) {
  const reasons = [];
  if (!application || typeof application !== 'object') return Object.freeze({ ok: false, against: null, reasons: Object.freeze(['APPLICATION_MISSING']) });
  if (application.status !== 'PASS') reasons.push('APPLICATION_NOT_PASS');
  const candidate = application.candidate;
  const revision = application.revision;
  if (!candidate || typeof candidate !== 'object' || candidate.schema !== CANONICAL_PROJECT_SCHEMA) reasons.push('CANDIDATE_NOT_A_CANONICAL_PROJECT');
  if (!revision || typeof revision !== 'object') reasons.push('REVISION_MISSING');
  if (!against || typeof against !== 'object' || against.schema !== CANONICAL_PROJECT_SCHEMA) reasons.push('BASELINE_NOT_A_CANONICAL_PROJECT');
  if (reasons.length) return Object.freeze({ ok: false, against: null, reasons: Object.freeze(reasons) });

  if (!revisionIdentityMatches(revision)) reasons.push('REVISION_IDENTITY_TAMPERED');
  if (candidateDigestOf(candidate) !== revision.candidateDigest) reasons.push('CANDIDATE_DIGEST_MISMATCH');
  if (candidate.metadata?.g11d?.revision?.id !== revision.id) reasons.push('CANDIDATE_REVISION_MISMATCH');

  // The project supplied must be one the revision itself names: the
  // Source-Faithful baseline, or the accepted previous candidate it was applied
  // onto. Anything else is not a reference this revision was made against.
  const suppliedDigest = baselineIdentityOf(against).contentDigest;
  const role = suppliedDigest === revision.baselineIdentity?.contentDigest ? 'baseline'
    : suppliedDigest === revision.parentCandidateIdentity?.contentDigest ? 'parent'
      : null;
  if (!role) reasons.push('REVISION_BASELINE_MISMATCH');

  // Both the candidate and an accepted previous carry the same Source-Faithful
  // snapshot, so whichever reference was supplied, the candidate's snapshot has
  // something exact to agree with.
  const snapshot = candidate.metadata?.sourceFaithfulBaseline?.snapshot;
  const expectedSnapshot = role === 'baseline' ? against : role === 'parent' ? against.metadata?.sourceFaithfulBaseline?.snapshot : null;
  if (!snapshot || typeof snapshot !== 'object') reasons.push('CANDIDATE_SNAPSHOT_MISSING');
  else if (role && (!expectedSnapshot || typeof expectedSnapshot !== 'object' || snapshotDigestOf(snapshot) !== snapshotDigestOf(expectedSnapshot))) reasons.push('CANDIDATE_SNAPSHOT_NOT_THE_BASELINE');

  return Object.freeze({ ok: reasons.length === 0, against: reasons.length === 0 ? role : null, reasons: Object.freeze(reasons) });
}

const requirePass = (application, baseline) => {
  if (!application || typeof application !== 'object') throw Error('reviewAppliedCandidate requires a G11-D application result');
  return applicationIntegrity(application, baseline).ok;
};

const pendingReport = (eventId, destinationRole, blockers) => Object.freeze({
  status: 'PENDING',
  pass: false,
  eventId,
  destinationRole,
  blockers: Object.freeze([...blockers]),
  warnings: Object.freeze([]),
});

// ─── Lead evidence across the revision lineage ──────────────────────────────

// Why a recovered Lead evidence record does not describe the candidate being
// graded. Each one sends the gate back to PENDING; none of them is a musical
// verdict, and none of them can turn a non-PASS into a PASS.
export const LEAD_EVIDENCE_LINEAGE_BLOCKERS = Object.freeze({
  // The promoted/demoted event is no longer in the candidate at all.
  EVENT_NOT_IN_CANDIDATE: 'LEAD_EVIDENCE_EVENT_NOT_IN_CANDIDATE',
  // The event is still there, but its musical identity moved: a citation about
  // the event as it was is not a citation about the event as it is.
  EVENT_CHANGED: 'LEAD_EVIDENCE_EVENT_CHANGED',
  // The Core3 picture the continuity / Core3 claims were made about has moved.
  CONTEXT_CHANGED: 'LEAD_EVIDENCE_CONTEXT_CHANGED',
  // The role the evidence argued for is not the role the candidate now has.
  DESTINATION_CHANGED: 'LEAD_EVIDENCE_DESTINATION_DOES_NOT_MATCH_CANDIDATE',
});

// The two Lead evidence axes. A record on one axis never answers the other: a
// citation arguing an event belongs in Melody is not a citation arguing it
// belongs out of it, and the graders are different functions.
export const LEAD_EVIDENCE_REVIEW_AXES = Object.freeze({
  PROMOTION: 'promotion',
  DEMOTION: 'demotion',
});

/**
 * Index the fresh, candidate-bound Lead evidence reviews for one axis.
 *
 * A fresh review is the reviewer's answer to a recovered record that went stale
 * -- a later revision moved the Lead picture, so the earlier citation no longer
 * describes the arrangement being graded. It replaces that record's *evidence*
 * and nothing else: the move it speaks about still has to be a move the lineage
 * actually performed, and the substituted evidence still goes through the same
 * scope binding and the same shared grader below. Recovering a record and then
 * grading fresh evidence for it is therefore one path, not two.
 *
 * Malformed entries are dropped rather than trusted. This input reaches the
 * builder from stored data, and a review that cannot be read is a review that
 * cannot substitute anything -- which leaves the recovered record exactly as it
 * was, PENDING.
 */
function freshReviewIndex(freshReviews, axis) {
  const index = new Map();
  for (const review of Array.isArray(freshReviews) ? freshReviews : []) {
    if (!review || typeof review !== 'object') continue;
    if (review.axis !== axis) continue;
    const eventId = review.eventId;
    if (typeof eventId !== 'string' || !eventId) continue;
    if (!review.leadEvidence || typeof review.leadEvidence !== 'object') continue;
    // A review with no explicit evidence reference is not a review. The apply
    // path already grades `decision.evidence` as a blocker, and the service
    // refuses a submission without one -- but this input arrives as stored
    // data, so the rule is enforced where the verdict is produced too. An entry
    // without one is ignored, which leaves the recovered record as it was.
    if (!Array.isArray(review.evidence) || !review.evidence.length) continue;
    // Later entries supersede earlier ones for the same event and axis, which
    // is what lets a reviewer retract a citation they got wrong.
    index.set(eventId, review);
  }
  return index;
}

// Does the evidence -- recovered from its revision, or re-supplied by a
// candidate-bound review -- still describe the Lead picture being graded?
//
// For a recovered record the question is asked of the candidate the evidence
// was originally graded against. For a fresh review it is asked of the Lead
// context digest the reviewer recorded it under, which is the same question
// against the reviewer's own reference point. Either way a `null` digest -- an
// unreadable candidate, an unrecorded digest -- is a mismatch, never a pass.
function leadContextStillMatches(fresh, step, candidateContextDigest) {
  if (candidateContextDigest === null) return false;
  if (fresh) return typeof fresh.leadContextDigest === 'string' && fresh.leadContextDigest === candidateContextDigest;
  return contextStillMatches(step, candidateContextDigest);
}

/**
 * Order and verify a chain of G11-D applications as one revision lineage.
 *
 * Evidence recovered from an earlier revision is only worth re-grading if the
 * chain it came from is the chain that produced this candidate. Every step is
 * put through the same `applicationIntegrity()` the head application goes
 * through -- an application result is data, and a restored, hand-built or
 * edited one must not be able to introduce evidence the recording path never
 * saw. On any failure the lineage is refused whole: no steps, therefore no
 * recovered reports, therefore the readiness Lead gates stay PENDING. That is
 * the closed direction, and it is the direction a missing application already
 * takes.
 *
 * Ordering is by `revision.index`, which is content-addressed inside
 * `revision.id` and re-checked by `revisionIdentityMatches()`, so it cannot be
 * renumbered without breaking integrity first. Indices must be contiguous from
 * 1 and each step's `parentRevisionId` must name the step before it: a chain
 * with a hole in it is a chain whose missing revision could have moved exactly
 * the material the recovered evidence claims about.
 */
export function applicationLineage(applications, baseline) {
  const reasons = [];
  const empty = () => Object.freeze({ ok: false, against: null, steps: Object.freeze([]), reasons: Object.freeze([...new Set(reasons)]) });
  if (!Array.isArray(applications)) {
    reasons.push('LINEAGE_NOT_AN_ARRAY');
    return empty();
  }
  if (!applications.length) return Object.freeze({ ok: true, against: null, steps: Object.freeze([]), reasons: Object.freeze([]) });

  const steps = [];
  let against = null;
  for (const application of applications) {
    const integrity = applicationIntegrity(application, baseline);
    if (!integrity.ok) {
      reasons.push(...integrity.reasons);
      return empty();
    }
    // `applicationIntegrity` has already established that the reference handed
    // in is one this revision binds -- its Source-Faithful baseline, or the
    // accepted previous candidate it was applied onto. Both are legitimate for
    // a single revision, so neither is rejected here; what is rejected is a
    // chain that mixes them, because reports from two different references are
    // not one set of reports. In practice a multi-step chain resolves as
    // `baseline` for every step anyway: only revision N binds revision N-1's
    // candidate as its parent, so passing a parent candidate for a longer chain
    // fails integrity on the earlier steps first.
    if (against === null) against = integrity.against;
    else if (integrity.against !== against) {
      reasons.push('LINEAGE_STEPS_AGAINST_DIFFERENT_REFERENCES');
      return empty();
    }
    const index = application.revision?.index;
    if (!Number.isInteger(index) || index < 1) {
      reasons.push('LINEAGE_REVISION_INDEX_INVALID');
      return empty();
    }
    steps.push({ application, revision: application.revision, index });
  }

  steps.sort((a, b) => a.index - b.index);
  // Contiguous and parent-linked *among the steps supplied*, not necessarily
  // from revision 1. A caller may legitimately hand in one application (the
  // single-revision entry points below do exactly that) or the tail of a chain.
  // A partial chain can only lose evidence, never launder it: every recovered
  // record is still checked against the current candidate's event identity,
  // destination role and Core3 context digest before it is re-graded, so a
  // revision that is missing here and moved that material sends the record back
  // to PENDING rather than through.
  for (const [position, step] of steps.entries()) {
    if (step.index !== steps[0].index + position) {
      reasons.push('LINEAGE_INDEX_NOT_CONTIGUOUS');
      return empty();
    }
    if (position > 0 && (step.revision.parentRevisionId ?? null) !== steps[position - 1].revision.id) {
      reasons.push('LINEAGE_PARENT_REVISION_MISMATCH');
      return empty();
    }
  }

  return Object.freeze({
    ok: true,
    against,
    steps: Object.freeze(steps.map(step => Object.freeze({ ...step }))),
    reasons: Object.freeze([]),
  });
}

// ─── per-application move classifiers ───────────────────────────────────────
//
// Lifted out of the two report builders so the single-revision and the lineage
// paths classify moves with one implementation. Neither reads evidence nor
// grades anything; they only say which applied events were Lead moves.

function demotionMovesOf(application) {
  const moves = [];
  for (const entry of application.applied ?? []) {
    if (entry.type !== ACCEPTED_DECISION_TYPES.MOVE_ROLE && entry.type !== ACCEPTED_DECISION_TYPES.OMIT_FROM_SIX) continue;
    const destinationOf = item => (entry.type === ACCEPTED_DECISION_TYPES.OMIT_FROM_SIX ? 'omitted' : item.toRole);
    const demoted = (entry.events ?? []).filter(item =>
      item.fromRole === LEAD_ROLE
      && !(entry.type === ACCEPTED_DECISION_TYPES.MOVE_ROLE && item.toRole === LEAD_ROLE));
    if (!demoted.length) continue;
    // One evidence record, one Lead event. An entry claiming several is not
    // split, and its first event does not inherit the citation.
    const multiEvent = (entry.events ?? []).length !== 1;
    for (const item of demoted) moves.push({ entry, item, eventId: item.eventId, destinationRole: destinationOf(item), multiEvent });
  }
  return moves;
}

function promotionMovesOf(application) {
  const candidateById = new Map((application?.candidate?.events ?? []).map(event => [event.id, event]));
  const moves = [];
  for (const entry of application.applied ?? []) {
    if (![ACCEPTED_DECISION_TYPES.ASSIGN_ROLE, ACCEPTED_DECISION_TYPES.MOVE_ROLE, ACCEPTED_DECISION_TYPES.DUPLICATE_WITH_JUSTIFICATION].includes(entry.type)) continue;

    const promoted = [];
    for (const item of entry.events ?? []) {
      if (item.fromRole === LEAD_ROLE) continue;
      if ((entry.type === ACCEPTED_DECISION_TYPES.ASSIGN_ROLE || entry.type === ACCEPTED_DECISION_TYPES.MOVE_ROLE) && item.toRole === LEAD_ROLE) {
        if (candidateById.get(item.eventId)?.role === LEAD_ROLE) promoted.push({ item, promotedEventId: item.eventId });
        continue;
      }
      if (entry.type === ACCEPTED_DECISION_TYPES.DUPLICATE_WITH_JUSTIFICATION) {
        for (const outputId of item.outputEventIds ?? []) {
          if (outputId === item.eventId) continue;
          if (candidateById.get(outputId)?.role === LEAD_ROLE) promoted.push({ item, promotedEventId: outputId });
        }
      }
    }
    if (!promoted.length) continue;
    // The application contract permits one Lead-affecting event per accepted
    // decision. Re-establish that boundary here rather than trusting a restored
    // application record to have run the interlock.
    const multiEvent = (entry.events ?? []).length !== 1;
    for (const { item, promotedEventId } of promoted) moves.push({ entry, item, promotedEventId, multiEvent });
  }
  return moves;
}

// Does this candidate event still carry the musical identity the evidence was
// graded against? Role is excluded deliberately: the role change *is* the move
// the evidence argues for.
const MUSICAL_IDENTITY_KEYS = Object.freeze(['pitch', 'start', 'end', 'volume']);
const idList = (event, key) => JSON.stringify([...(event?.[key] ?? [])].map(String).sort());
function musicalIdentityMatches(a, b) {
  if (!a || !b) return false;
  for (const key of MUSICAL_IDENTITY_KEYS) {
    if (String(a[key] ?? '') !== String(b[key] ?? '')) return false;
  }
  return idList(a, 'sourceIds') === idList(b, 'sourceIds') && idList(a, 'sourceEventIds') === idList(b, 'sourceEventIds');
}

/**
 * Resolve a candidate event back to the Source-Faithful baseline event it came
 * from, walking only the reversible derived-duplicate chain.
 *
 * Exported so the Studio Web plane resolves a promotion origin with this exact
 * walk rather than a second copy of it: the rule that a derived id is never
 * matched by pitch, time or array order lives in one place.
 */
export function baselineOriginEvent(baselineProject, candidateProject, eventId) {
  return baselineOriginOf(
    eventId,
    new Map((baselineProject?.events ?? []).map(event => [event.id, event])),
    new Map((candidateProject?.events ?? []).map(event => [event.id, event])),
  );
}

// Walk a derived duplicate's reversible chain back to the Source-Faithful
// baseline. Never guess by pitch/time or array order.
function baselineOriginOf(eventId, baselineById, candidateById) {
  const seen = new Set();
  let currentId = eventId;
  while (typeof currentId === 'string' && currentId && !seen.has(currentId)) {
    if (baselineById.has(currentId)) return baselineById.get(currentId);
    seen.add(currentId);
    const event = candidateById.get(currentId);
    currentId = event?.metadata?.g11d?.derivedFromEventId ?? null;
  }
  return null;
}

// A digest failure is a reason to re-review, never a reason to throw the
// analysis away or to pass by default.
function safeLeadContextDigest(project) {
  try {
    return leadContextDigestOf(project);
  } catch {
    return null;
  }
}

function contextStillMatches(step, candidateContextDigest) {
  if (candidateContextDigest === null) return false;
  const graded = safeLeadContextDigest(step.application?.candidate);
  return graded !== null && graded === candidateContextDigest;
}

/**
 * The Lead Demotion reports the accepted decisions' own evidence supports,
 * recovered from the whole integrity-checked revision lineage and re-graded
 * against the current candidate.
 *
 * Why the lineage rather than one application. The readiness Lead gates derive
 * what needs evidence from the candidate-versus-Source-Faithful-baseline diff,
 * which accumulates for the life of the project: a Lead event demoted in
 * revision 1 is still demoted relative to the baseline in revision 9. The
 * evidence, though, lives in the `applied[]` of the one revision that performed
 * the move, and `metadata.g11d` deliberately does not inherit across revisions.
 * Reading one revision therefore loses the evidence for every earlier move, and
 * a revision that merely KEEPs an already-moved event produces no report at all
 * -- leaving a gate no later decision could ever clear, because G11-D correctly
 * refuses to re-apply a move that has already happened.
 *
 * Why this is a re-grade and not a carry-forward. Nothing recovered here is a
 * stored verdict. The previous revision's PASS is never read; what is recovered
 * is the *evidence record*, which is then put through `evaluateLeadDemotion()`
 * again against the baseline event, exactly as at application time. On top of
 * that, four things must still hold or the record is reported PENDING instead
 * of graded: the event is still in the candidate (or still legitimately
 * omitted), its musical identity is unchanged, the destination role the
 * evidence argued for is the role the candidate actually has, and the Core3
 * picture the continuity/Core3 claims were made about is unchanged. A candidate
 * that moved any of those has an unproven claim again, and MASTER_RULES §4 says
 * an unproven Lead decision is PENDING, not PASS.
 *
 * Why a fresh review substitutes evidence rather than adding a report. The
 * staleness checks above are correct and must stay, but on their own they leave
 * a reviewer nothing to do: G11-D refuses to re-apply a move that already
 * happened, so once a later revision moves the Lead picture there is no decision
 * that could carry a new citation. `freshReviews` is that missing path -- one
 * candidate-bound, axis-specific, evidence-backed review per event, recorded
 * against the exact candidate being graded. It replaces the recovered record's
 * evidence and its context reference point, and nothing else: the move must
 * still be one this lineage performed, the citation must still bind to the same
 * baseline event, the destination and musical identity checks still run, and
 * the verdict still comes from `evaluateLeadDemotion()` on this call. A review
 * recorded against a different candidate is never loaded, so the next
 * Lead-affecting revision returns the report to PENDING exactly as before.
 *
 * `baseline` is the Source-Faithful baseline. Every report is produced by
 * `evaluateLeadDemotion()` itself; this never manufactures a PASS.
 */
export function leadDemotionReportsFromLineage({ applications, baseline, candidate, freshReviews = [] }) {
  const lineage = applicationLineage(applications, baseline);
  if (!lineage.ok || !lineage.steps.length) return [];
  const baselineById = new Map((baseline?.events ?? []).map(event => [event.id, event]));
  const currentById = new Map((candidate?.events ?? []).map(event => [event.id, event]));
  const contextDigest = safeLeadContextDigest(candidate);
  const fresh = freshReviewIndex(freshReviews, LEAD_EVIDENCE_REVIEW_AXES.DEMOTION);

  // Oldest to newest: a later demotion of the same event replaces the earlier
  // record, and a later promotion back to Lead withdraws it. Exactly one record
  // per event id, because the readiness gate keys reports by event id and a
  // second report for the same id would make the outcome order-dependent.
  const records = new Map();
  for (const step of lineage.steps) {
    for (const move of demotionMovesOf(step.application)) records.set(move.eventId, { ...move, step });
    for (const move of promotionMovesOf(step.application)) records.delete(move.promotedEventId);
  }

  const reports = [];
  for (const record of records.values()) {
    const { entry, eventId, destinationRole, multiEvent, step } = record;
    if (multiEvent) {
      reports.push(pendingReport(eventId, destinationRole, [DECISION_REJECTION.LEAD_EVIDENCE_MULTI_EVENT_SCOPE_UNSUPPORTED]));
      continue;
    }
    const event = baselineById.get(eventId);
    if (!event) continue;

    // A candidate-bound review re-supplies the evidence for this recovered
    // move; everything else about the move -- which event, which destination,
    // which revision performed it -- still comes from the lineage.
    const review = fresh.get(eventId) ?? null;
    const leadEvidence = review ? review.leadEvidence : entry.leadEvidence;

    // Scope before staleness, and deliberately so: a citation that does not
    // describe this event is a fault in the evidence record itself, and it is
    // reported as that rather than as a fact about the candidate. The order
    // changes which reason is shown, never the outcome -- both are PENDING.
    const scope = leadEvidenceIdentityBlockers(leadEvidence, event);
    if (scope.length) {
      // Reported before the gate so the report carries the scope failure alone.
      // The gate now runs the same binding itself, so this is a presentation
      // choice, not the only thing standing between a foreign citation and a
      // PASS under this event's id.
      reports.push(pendingReport(event.id, destinationRole, scope.includes(LEAD_EVIDENCE_IDENTITY_MISMATCH) || scope.includes(LEAD_EVIDENCE_PROVENANCE_PAIR_AMBIGUOUS)
        ? scope
        : [...scope, LEAD_EVIDENCE_IDENTITY_MISMATCH]));
      continue;
    }

    // A recovered citation argues for the destination the revision moved the
    // event to, and a candidate that moved it on again has an unproven claim.
    // A FRESH citation is an argument about the candidate as it stands, so it
    // is graded against the role the event actually has now -- otherwise
    // demoting to Chord3 and later moving to Chord4 would leave a requirement
    // no re-review could answer, which is the dead-end this path exists to
    // remove, re-created one door along. The destination is a fact about the
    // candidate, never a claim in the record, so reading the current one takes
    // nothing on trust.
    const gradedDestination = review
      ? (currentById.get(event.id)?.role ?? 'omitted')
      : destinationRole;

    const stale = demotionStaleness({ destinationRole: gradedDestination, currentById, event, contextDigest, step, review });
    if (stale.length) {
      reports.push(pendingReport(event.id, gradedDestination, stale));
      continue;
    }
    try {
      reports.push(Object.freeze({
        ...evaluateLeadDemotion({
          ...(leadEvidence ?? {}),
          event,
          destinationRole: gradedDestination,
          positiveReason: leadEvidence?.positiveReason ?? (review ? review.reason : entry.reason),
        }),
        gradedFromRevisionId: step.revision.id,
        evidenceSource: review ? 'candidate-review' : 'revision',
        reviewedAt: review ? (review.at ?? null) : null,
      }));
    } catch (error) {
      reports.push(pendingReport(event.id, destinationRole, [`LEAD_DEMOTION_EVIDENCE_INVALID: ${error.message}`]));
    }
  }
  return reports;
}

// A demoted event either left Core3 for another role or left the six entirely.
// Either way the destination the reviewer argued for must be the destination the
// candidate actually has, and the event's musical identity must not have moved
// under the citation.
function demotionStaleness({ destinationRole, currentById, event, contextDigest, step, review = null }) {
  const blockers = [];
  const current = currentById.get(event.id);
  if (destinationRole === 'omitted') {
    if (current) blockers.push(LEAD_EVIDENCE_LINEAGE_BLOCKERS.DESTINATION_CHANGED);
  } else if (!current) {
    blockers.push(LEAD_EVIDENCE_LINEAGE_BLOCKERS.EVENT_NOT_IN_CANDIDATE);
  } else {
    if (current.role !== destinationRole) blockers.push(LEAD_EVIDENCE_LINEAGE_BLOCKERS.DESTINATION_CHANGED);
    if (!musicalIdentityMatches(current, event)) blockers.push(LEAD_EVIDENCE_LINEAGE_BLOCKERS.EVENT_CHANGED);
  }
  if (!leadContextStillMatches(review, step, contextDigest)) blockers.push(LEAD_EVIDENCE_LINEAGE_BLOCKERS.CONTEXT_CHANGED);
  return [...new Set(blockers)];
}

/**
 * Re-grade every promotion into Melody the revision lineage produced.
 *
 * Readiness keys promotion evidence on the *candidate* Melody event: a role
 * move/assignment keeps the source event id, while a justified duplicate gets a
 * derived event id. The musical evidence is nevertheless judged against the
 * source/baseline origin event so the citation cannot be laundered through a
 * derived id.
 *
 * The lineage and re-grade reasoning is the same as for demotion above, and one
 * asymmetry is worth naming: a promoted event is *already* Melody in every later
 * candidate, so `evaluateLeadPromotion()` short-circuits to N/A if handed the
 * candidate event. It is therefore graded as it stood immediately before the
 * move -- which is also why "just re-supply the evidence on a KEEP" cannot work
 * as a workaround, and why this recovery is the fix.
 *
 * `freshReviews` carries the candidate-bound re-reviews described on the
 * demotion builder above, on the `promotion` axis. They substitute the recovered
 * record's evidence only. The origin walk runs first and is unaffected, so a
 * derived duplicate is still graded against its Source-Faithful origin and the
 * fresh citation is bound to that origin's provenance, not to the derived id.
 */
export function leadPromotionReportsFromLineage({ applications, baseline, candidate, freshReviews = [] }) {
  const lineage = applicationLineage(applications, baseline);
  if (!lineage.ok || !lineage.steps.length) return [];
  const baselineById = new Map((baseline?.events ?? []).map(event => [event.id, event]));
  const currentById = new Map((candidate?.events ?? []).map(event => [event.id, event]));
  const contextDigest = safeLeadContextDigest(candidate);
  const fresh = freshReviewIndex(freshReviews, LEAD_EVIDENCE_REVIEW_AXES.PROMOTION);

  const records = new Map();
  for (const step of lineage.steps) {
    for (const move of promotionMovesOf(step.application)) records.set(move.promotedEventId, { ...move, step });
    for (const move of demotionMovesOf(step.application)) records.delete(move.eventId);
  }

  const reports = [];
  for (const record of records.values()) {
    const { entry, item, promotedEventId, multiEvent, step } = record;
    if (multiEvent) {
      reports.push(pendingReport(promotedEventId, LEAD_ROLE, [DECISION_REJECTION.LEAD_EVIDENCE_MULTI_EVENT_SCOPE_UNSUPPORTED]));
      continue;
    }

    // The origin walk reads the candidate the move was applied to, because that
    // is where the derived-duplicate chain for this step exists; the current
    // candidate is consulted too so a duplicate created by a later revision
    // still resolves.
    const chain = new Map([
      ...(step.application?.candidate?.events ?? []).map(event => [event.id, event]),
      ...currentById,
    ]);
    const origin = baselineOriginOf(item.eventId, baselineById, chain);
    if (!origin) {
      reports.push(Object.freeze({
        ...pendingReport(promotedEventId, LEAD_ROLE, ['LEAD_PROMOTION_ORIGIN_NOT_IN_BASELINE']),
        originEventId: null,
      }));
      continue;
    }

    // Grade the event as it existed immediately before this role move, while
    // binding its citation to the source-faithful origin provenance. This is
    // necessary for a derived event whose origin was already Melody: the
    // derived copy is currently non-Lead even though its source ancestor was.
    const evidenceEvent = { ...origin, id: item.eventId, role: item.fromRole ?? null };

    // A candidate-bound review re-supplies this move's evidence. The origin walk
    // above has already run, so a derived duplicate is still graded against the
    // Source-Faithful origin it came from and a fresh citation cannot be
    // laundered through the derived id either.
    const review = fresh.get(promotedEventId) ?? null;
    const leadEvidence = review ? review.leadEvidence : entry.leadEvidence;

    // Scope before staleness: see the note in the demotion builder above.
    const scope = leadEvidenceIdentityBlockers(leadEvidence, evidenceEvent);
    if (scope.length) {
      reports.push(Object.freeze({
        ...pendingReport(promotedEventId, LEAD_ROLE, scope.includes(LEAD_EVIDENCE_IDENTITY_MISMATCH) || scope.includes(LEAD_EVIDENCE_PROVENANCE_PAIR_AMBIGUOUS)
          ? scope
          : [...scope, LEAD_EVIDENCE_IDENTITY_MISMATCH]),
        originEventId: origin.id,
      }));
      continue;
    }

    const current = currentById.get(promotedEventId);
    const stale = [];
    if (!current) stale.push(LEAD_EVIDENCE_LINEAGE_BLOCKERS.EVENT_NOT_IN_CANDIDATE);
    else {
      if (current.role !== LEAD_ROLE) stale.push(LEAD_EVIDENCE_LINEAGE_BLOCKERS.DESTINATION_CHANGED);
      if (!musicalIdentityMatches(current, origin)) stale.push(LEAD_EVIDENCE_LINEAGE_BLOCKERS.EVENT_CHANGED);
    }
    if (!leadContextStillMatches(review, step, contextDigest)) stale.push(LEAD_EVIDENCE_LINEAGE_BLOCKERS.CONTEXT_CHANGED);
    if (stale.length) {
      reports.push(Object.freeze({
        ...pendingReport(promotedEventId, LEAD_ROLE, [...new Set(stale)]),
        originEventId: origin.id,
      }));
      continue;
    }
    try {
      const report = evaluateLeadPromotion({
        ...(leadEvidence ?? {}),
        event: evidenceEvent,
        destinationRole: LEAD_ROLE,
        positiveReason: leadEvidence?.positiveReason ?? (review ? review.reason : entry.reason),
      });
      reports.push(Object.freeze({
        ...report,
        eventId: promotedEventId,
        originEventId: origin.id,
        gradedFromRevisionId: step.revision.id,
        evidenceSource: review ? 'candidate-review' : 'revision',
        reviewedAt: review ? (review.at ?? null) : null,
      }));
    } catch (error) {
      reports.push(Object.freeze({
        ...pendingReport(promotedEventId, LEAD_ROLE, [`LEAD_PROMOTION_EVIDENCE_INVALID: ${error.message}`]),
        originEventId: origin.id,
      }));
    }
  }
  return reports;
}

/**
 * The single-revision entry points, kept so existing callers and regressions are
 * unaffected. A lineage of exactly one step is the same computation: the
 * candidate the evidence was graded against *is* the candidate being graded, so
 * every staleness check is satisfied by construction.
 */
export function leadDemotionReportsFromApplication(application, baseline) {
  if (!requirePass(application, baseline)) return [];
  return leadDemotionReportsFromLineage({ applications: [application], baseline, candidate: application.candidate });
}

export function leadPromotionReportsFromApplication(application, baseline) {
  if (!requirePass(application, baseline)) return [];
  return leadPromotionReportsFromLineage({ applications: [application], baseline, candidate: application.candidate });
}

/**
 * Re-run the existing validation pipeline against an applied candidate.
 *
 * Returns the untouched reports of the modules above. `readiness.candidateReady`
 * remains the readiness answer; this function has no answer of its own and
 * deliberately publishes no aggregate verdict that could be mistaken for one.
 */
export function reviewAppliedCandidate({
  application,
  baseline,
  acceptedPrevious = null,
  mmlValidation = null,
  leadDemotionReports = [],
  leadPromotionReports = [],
  core3ApprovedChanges = [],
  core3CompletenessReviewed = false,
  versionDriftReviewed = false,
  originalAudioRequired = true,
  playerReadback = 'NOT_RUN',
  mobileAdaptation = 'PENDING',
  regressionReviewed = false,
  inGameAcceptance = 'PENDING',
}) {
  const checked = applicationIntegrity(application, baseline);
  const integrity = checked.ok && checked.against !== 'baseline'
    ? Object.freeze({ ok: false, against: null, reasons: Object.freeze(['REVIEW_REQUIRES_SOURCE_FAITHFUL_BASELINE']) })
    : checked;
  if (!integrity.ok) {
    return Object.freeze({
      status: 'NOT_APPLICABLE',
      reason: integrity.reasons.includes('APPLICATION_NOT_PASS')
        ? 'The accepted decision set was not applied, so there is no candidate to validate.'
        : 'The application result does not agree with itself or with the supplied baseline, so nothing downstream is run against it.',
      integrity,
      applicationStatus: application?.status ?? null,
      lineage: null,
      core3FromBaseline: null,
      core3FromPrevious: null,
      core3Completeness: null,
      harmony: null,
      readiness: null,
    });
  }
  const candidate = application.candidate;
  const lineage = compareCandidateLineage({ sourceBaseline: baseline, acceptedPrevious, candidate });
  const core3FromBaseline = evaluateCore3Continuity({ baseline, candidate, approvedChanges: core3ApprovedChanges });
  const core3FromPrevious = acceptedPrevious
    ? evaluateCore3Continuity({ baseline: acceptedPrevious, candidate, approvedChanges: core3ApprovedChanges })
    : null;
  // Gate 4's own question, asked of the candidate rather than of the diff. A
  // clean continuity audit above says nothing about it.
  const core3Completeness = evaluateCore3Completeness({ candidate, reviewed: core3CompletenessReviewed });
  const harmony = analyzeCrossSourceHarmony(candidate);
  const readiness = evaluateProjectReadiness({
    project: candidate,
    mmlValidation,
    core3Report: core3FromBaseline,
    core3CompletenessReport: core3Completeness,
    harmonyReport: harmony,
    leadDemotionReports,
    leadPromotionReports,
    lineageReport: lineage,
    versionDriftReviewed,
    originalAudioRequired,
    playerReadback,
    mobileAdaptation,
    regressionReviewed,
    inGameAcceptance,
  });

  return Object.freeze({
    status: 'REVIEWED',
    integrity,
    applicationStatus: application.status,
    revisionId: application.revision.id,
    diffFromBaseline: application.diffFromBaseline,
    diffFromPrevious: acceptedPrevious ? compareCanonicalVersions(acceptedPrevious, candidate) : application.diffFromParent,
    lineage,
    core3FromBaseline,
    core3FromPrevious,
    core3Completeness,
    harmony,
    readiness,
    notice: 'Every verdict here belongs to the module that produced it. A G11-D application result is not an input to any of them, and REVIEWED is not a gate result: read readiness.candidateReady and the individual gates.',
  });
}
