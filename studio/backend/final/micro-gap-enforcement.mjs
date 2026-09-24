// G10 — source-aware sub-1/64 micro-gap enforcement.
//
// Responsibility boundary
// -----------------------
// `canonical/micro-timing.mjs` answers *what an interval is*: it classifies a
// sub-grid interval as source-supported, technical residue, or unproven, and it
// reports unresolved stream relationships. It holds no Final policy and reaches
// no verdict.
//
// This module answers *what Final must do about each class*. It is the single
// place where the published Final policy is applied to a classification, so a
// future Canonical-aware Final emitter and the per-song readiness gate share one
// enforcement contract instead of each re-deriving a threshold.
//
// Published authority (2026-09-13-v1, rules snapshot
// 0a172900a01fdf39c2e9e84cf176961320b779ea):
//
//   MOBILE_SYNTAX §4  `FINAL_FORBIDDEN`: "technical micro-gaps or decomposition
//                     components finer than 1/64 when they have no
//                     source-supported musical meaning".
//   MOBILE_SYNTAX §11 step 5: Final canonicalization must "ensure no zero
//                     duration or non-musical technical micro-gap remains".
//   MOBILE_SYNTAX §4  project safe timing resolution for Final Canonical
//                     decomposition is 1/64, a `FINAL_CANONICAL_POLICY`.
//   MASTER_RULES §7   "Preserve meaningful source rests, breaths, articulation
//                     gaps... Technical micro-gaps without musical meaning may
//                     be normalized under MOBILE_SYNTAX.md".
//
// This module adds no rule. `duration < 1/64 -> remove` is not the published
// rule and is not implemented here: shortness alone is never a verdict in
// either direction.
//
// Three enforcement outcomes, one per semantic state:
//
//   SOURCE_SUPPORTED_MICROTIMING -> PRESERVE      never deleted, quantized,
//                                                 absorbed by a longer neighbour
//                                                 or moved off its attack
//   TECHNICAL_RESIDUE            -> REJECT_FINAL  Final must not silently retain
//   UNKNOWN / unresolved stream  -> BLOCK_PENDING unproven either way, so the
//                                                 candidate blocks rather than
//                                                 guessing
//
// Why REJECT_FINAL and not normalize. MASTER_RULES §7 *permits* normalization of
// a meaning-free micro-gap; it does not require it, and an exact rewrite to a
// canonical note/tie/rest decomposition is the Final emitter's work, which is
// out of G10's scope. Rejecting is the fail-closed half of the permitted range:
// it never destroys source-supported material and never lets a confirmed
// artifact reach delivery. When the Final emitter lands it can consume
// `rejectedIntervalKeys` as its normalization worklist without this contract
// changing meaning.
//
// Nothing here mutates the project, the Source-Faithful Baseline, or any event.
// The module reads and reports.
import { F, f, ROLES } from '../mml/index.mjs';
import { EFFECTIVE_RULESET } from '../rules/index.mjs';
import {
  carriesCanonicalCandidateMarker,
  isReleaseRegridCandidateActive,
} from '../canonical/release-regrid-candidate.mjs';
import {
  SAFE_GRID,
  INTERVAL_TYPES,
  MICRO_TIMING_CLASSIFICATIONS,
  analyzeProjectMicroTiming,
} from '../canonical/micro-timing.mjs';
import {
  REPRESENTATION,
  TARGET_STATUS,
  analyzeReleaseTiming,
  isNotVisibleToIntervalAnalyzer,
  releaseOffsetKeyOf,
  releaseEvidenceRequirement,
  summarizeReleaseTiming,
  verifyReleaseRepresentation,
} from '../canonical/release-timing.mjs';

export const MICRO_GAP_ENFORCEMENT = Object.freeze({
  PRESERVE: 'preserve-source-supported',
  REJECT_FINAL: 'reject-final-technical-residue',
  BLOCK_PENDING: 'block-pending-unproven',
});

// Analyzer blockers keep the order the readiness gate has always published.
// Policy blockers are appended, so a conformant contract leaves the list byte
// for byte unchanged.
export const MICRO_GAP_BLOCKERS = Object.freeze({
  ANALYSIS_FAILED: 'MICRO_TIMING_ANALYSIS_FAILED',
  TECHNICAL_RESIDUE_PRESENT: 'MICRO_TIMING_TECHNICAL_RESIDUE_PRESENT',
  CLASSIFICATION_UNKNOWN: 'MICRO_TIMING_CLASSIFICATION_UNKNOWN',
  STREAM_IDENTITY_UNRESOLVED: 'MICRO_TIMING_STREAM_IDENTITY_UNRESOLVED',
  SAFE_GRID_UNDECLARED: 'MICRO_GAP_POLICY_SAFE_GRID_UNDECLARED',
  SAFE_GRID_MISMATCH: 'MICRO_GAP_POLICY_SAFE_GRID_MISMATCH',
  TECHNICAL_REJECTION_DISABLED: 'MICRO_GAP_POLICY_TECHNICAL_REJECTION_DISABLED',
  MEANINGFUL_REST_PRESERVATION_DISABLED: 'MICRO_GAP_POLICY_MEANINGFUL_REST_PRESERVATION_DISABLED',
  ENFORCEMENT_INVARIANT_VIOLATED: 'MICRO_GAP_ENFORCEMENT_INVARIANT_VIOLATED',
  // The project was produced by an UNPUBLISHED Canonical candidate transform
  // (canonical/release-regrid-candidate.mjs). Its timing may look clean, but no
  // Published rule authorised the change, so it can never reach PASS here.
  UNPUBLISHED_CANONICAL_CANDIDATE: 'MICRO_GAP_UNPUBLISHED_CANONICAL_CANDIDATE',
  // A note release that no admitted Final token sequence can reach
  // (canonical/release-timing.mjs). The interval analyzer above only sees
  // sub-grid *intervals*; a release one source tick before the grid followed by
  // a real rest, or at a role end, leaves no sub-grid interval and was invisible
  // to this gate while the Final emitter still could not write it. Published v1
  // needs an evidence-backed Mobile representation decision for each one.
  //
  // Only releases the interval analyzer cannot see raise it. A release followed by
  // a sub-grid gap, or a sub-grid note, already surfaces as an interval above and
  // keeps its three-way outcome there; whether a *preserved* source-supported
  // interval can be written at all stays the separate technical gate's question,
  // exactly as before. Unsupported onsets and rest boundaries have a code of
  // their own, below.
  RELEASE_NOT_FINAL_REPRESENTABLE: 'MICRO_TIMING_RELEASE_NOT_FINAL_REPRESENTABLE',
  // An onset, or a rest boundary a Final role has to reach, that no admitted
  // Final token sequence can reach (`unsupportedBoundaries`, whose entries each
  // say how they are covered). The interval analyzer only sees a boundary that
  // is an end of a sub-grid interval: it builds a gap only between two segments
  // closer than the grid, so a role's first off-grid onset, an off-grid onset
  // after a rest of at least the grid, a legato join at an off-grid point or an
  // off-grid role end leaves no interval, and this gate used to PASS while the
  // Final emitter could not write the role.
  //
  // Raised only for a boundary no other outcome here already decides: one an
  // analysed interval in its role starts or ends at keeps that interval's
  // three-way outcome, and one at a note release of its role that raises
  // RELEASE_NOT_FINAL_REPRESENTABLE keeps the release-side handling above. A
  // release under a keep claim raises nothing there, so it decides nothing
  // here either. A rest boundary where no note of its role starts
  // or ends and the role does not end lies inside one silence, which a Final
  // writes as one exact span (final/mml-emitter.mjs merges adjacent silence), so
  // it is reported and never raises this. Onsets are attacks and are never moved,
  // and no provisional rendering holds any of these, so the machine-delivery
  // schemas leave it BLOCKING (final/delivery-evaluator.mjs). This gate stays
  // PENDING, as for the release code; the Final emitter, whose question is
  // whether the candidate can be written, reports it as the proof it is
  // (MICRO_GAP_BOUNDARY_NOT_FINAL_REPRESENTABLE, FAIL).
  BOUNDARY_NOT_FINAL_REPRESENTABLE: 'MICRO_TIMING_BOUNDARY_NOT_FINAL_REPRESENTABLE',
  // A recorded release representation that does not re-verify from the project:
  // a timing change without the evidence-backed decision it claims.
  RELEASE_RECORD_INVALID: 'MICRO_TIMING_RELEASE_REPRESENTATION_RECORD_INVALID',
  // Releases still awaiting a representation decision, stated as the evidence
  // that would settle them given the sources this project holds
  // (`releaseEvidenceRequirement`). Raised only when the caller supplied the
  // project's evidence registry: without it what the project holds is unknown.
  RELEASE_EVIDENCE_REQUIRED: 'MICRO_TIMING_RELEASE_EVIDENCE_REQUIRED',
  // Added, never substituted, when the whole of what keeps this gate open is
  // release-side: every UNKNOWN interval is the gap between a note's release and
  // the next attack in its role, or a sub-grid note duration its release decides,
  // and every release Final cannot express can be held to the following attack
  // or next grid point (ACCEPTANCE_CRITERIA "Delivered first, flagged for
  // listening", 2026-09-23-v3). `provisionalReleases` lists each one. It is a
  // statement about this project, not a verdict: the intervals stay UNKNOWN,
  // the status stays PENDING, and whether a delivery may render them is decided
  // by the machine-delivery schema the loaded release declares
  // (final/delivery-evaluator.mjs), which reads exactly this code.
  RELEASE_PROVISIONAL: 'MICRO_TIMING_RELEASE_PROVISIONAL',
});

// ACCEPTANCE_CRITERIA "Delivered first, flagged for listening", rule 1
// (2026-09-23-v3): the executable echo of its systematic-export-offset
// precondition. A symbolic source qualifies when one sub-grid offset before the
// next safe-grid point accounts for at least this share of its releases that
// fall short of a grid point; only its releases at exactly that offset may be
// held. Exact integer comparison, never a float.
//
// It lives here, beside the one check that reads it, rather than in
// EFFECTIVE_RULESET: that object echoes the policy values every supported
// release shares, and studio/tests/bootstrap.test.mjs pins them to the first
// published snapshot.
export const PROVISIONAL_RELEASE_POLICY = Object.freeze({
  dominantOffsetMinShare: Object.freeze({ numerator: 95, denominator: 100 }),
});

// How each entry of the report's `unsupportedBoundaries` is covered, recorded on
// the entry as `coverage`. Only NONE raises BOUNDARY_NOT_FINAL_REPRESENTABLE.
export const BOUNDARY_COVERAGE = Object.freeze({
  // An analysed sub-grid interval in the boundary's role starts or ends here;
  // that interval's classification decides, as for any other interval.
  ANALYSED_INTERVAL: 'analysed-interval',
  // A note release in the boundary's role sits here and raises
  // RELEASE_NOT_FINAL_REPRESENTABLE itself (it is one
  // `notVisibleToIntervalAnalyzerCount` counts); the release-side handling
  // decides. A release target that raises nothing -- one a keep claim reports
  // SOURCE_SUPPORTED_NOT_REPRESENTABLE -- covers nothing.
  RELEASE_TARGET: 'release-target',
  // A rest boundary where no note of its role starts or ends and the role does
  // not end: it lies inside one silence, which a Final writes as one exact span.
  INSIDE_SILENCE: 'inside-silence',
  // A position the Final role has to reach and nothing here decides.
  NONE: 'none',
});

// The blockers a release-side result may carry beside RELEASE_PROVISIONAL.
const RELEASE_SIDE_BLOCKERS = new Set([
  MICRO_GAP_BLOCKERS.CLASSIFICATION_UNKNOWN,
  MICRO_GAP_BLOCKERS.RELEASE_NOT_FINAL_REPRESENTABLE,
  MICRO_GAP_BLOCKERS.RELEASE_EVIDENCE_REQUIRED,
]);

// An interval that is UNKNOWN only because the evidence is missing. A pending,
// accepted-but-unbound, conflicting or ambiguous decision on it is an open
// question of its own, not missing evidence.
const EVIDENCE_MISSING_BASES = new Set(['insufficient-proof', 'rejected-keep-decision']);

const cmpText = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

/**
 * Per symbolic source: the offset its non-representable releases share, how
 * dominant it is, and whether that meets the precondition. Read from the
 * release analysis's own `encodingObservations` (canonical/release-timing.mjs),
 * never re-derived; `releaseOffsetKeyOf` is the key both use.
 *
 * An observation, not evidence: SOURCE_POLICY §6 is unchanged, and nothing here
 * says a release is meaningless. It only says where the provisional delivery
 * default may apply.
 */
function releaseOffsetSources(releaseAnalysis) {
  const { numerator, denominator } = PROVISIONAL_RELEASE_POLICY.dominantOffsetMinShare;
  return (releaseAnalysis?.encodingObservations ?? []).map(observation => {
    const counts = Object.entries(observation.offsetsBeforeNextGrid ?? {});
    const releaseCount = counts.reduce((sum, [, count]) => sum + count, 0);
    const most = counts.reduce((max, [, count]) => Math.max(max, count), 0);
    const leaders = counts.filter(([, count]) => count === most).map(([key]) => key);
    // A tie has no dominant offset.
    const dominantOffset = leaders.length === 1 ? leaders[0] : null;
    const sample = dominantOffset === null ? null : releaseAnalysis.targets.find(target => target.sourceIds.includes(observation.sourceId)
      && releaseOffsetKeyOf(target) === dominantOffset) ?? null;
    const dominantOffsetBeats = sample ? sample.analysis.offsetBeforeNextGrid : null;
    const subGrid = dominantOffsetBeats !== null && f(dominantOffsetBeats).cmp(0) > 0 && f(dominantOffsetBeats).cmp(SAFE_GRID) < 0;
    const dominantCount = dominantOffset === null ? 0 : most;
    const meetsShare = releaseCount > 0 && BigInt(dominantCount) * BigInt(denominator) >= BigInt(numerator) * BigInt(releaseCount);
    return {
      sourceId: observation.sourceId,
      dominantOffset,
      dominantOffsetBeats,
      dominantCount,
      releaseCount,
      share: releaseCount ? `${dominantCount}/${releaseCount}` : null,
      // Display only, rounded down so it never overstates the share.
      sharePercent: releaseCount ? (Math.floor((dominantCount * 1000) / releaseCount) / 10).toFixed(1) : null,
      minimumShare: `${numerator}/${denominator}`,
      qualifies: dominantOffset !== null && subGrid && meetsShare,
    };
  }).sort((a, b) => cmpText(a.sourceId, b.sourceId));
}

/**
 * Whether every open micro-timing question of this project is a release that
 * can be held, for delivery only, to the following attack or next grid point --
 * and if so, which releases and what each one closes.
 *
 * Nothing here decides meaning. A release qualifies only when every one of its
 * sources shows a systematic export offset and the release sits at exactly that
 * offset, and when the release analysis's own EXTEND_TO_NEXT_GRID option is
 * valid for it (that option already refuses a hold that would cross a same-role
 * onset, enter an explicit rest, create a cross-role same-pitch overlap or leave
 * a sub-grid silence). Any release or interval outside that shape, any
 * unsupported onset or rest boundary, any source-supported or technical
 * interval, and any blocker beyond the three release-side ones makes the whole
 * answer "no": then nothing is held and the gate keeps its usual codes.
 */
function provisionalReleasePlan({ project, blockers, unknown, preserved, rejected, invariantViolated, recordInvalid, releaseAnalysis }) {
  const sources = releaseOffsetSources(releaseAnalysis);
  const refuse = () => Object.freeze({
    eligible: false,
    releases: Object.freeze([]),
    sources: Object.freeze(sources.map(source => Object.freeze({
      ...source,
      provisionallyRendered: 0,
      unresolved: source.releaseCount,
    }))),
  });
  if (rejected.length || preserved.length || invariantViolated || recordInvalid) return refuse();
  if (!blockers.length || !blockers.every(code => RELEASE_SIDE_BLOCKERS.has(code))) return refuse();
  if (releaseAnalysis.unsupportedBoundaries.length || !releaseAnalysis.targets.length) return refuse();

  const sourceById = new Map(sources.map(source => [source.sourceId, source]));
  const eventsById = new Map((Array.isArray(project?.events) ? project.events : [])
    .filter(event => event && typeof event.id === 'string')
    .map(event => [event.id, event]));
  const holds = new Map();
  for (const target of releaseAnalysis.targets) {
    if (target.status !== TARGET_STATUS.REPRESENTATION_DECISION_REQUIRED) return refuse();
    // The precondition, per release: every source it comes from qualifies, and
    // it sits at exactly that source's dominant offset. An outlier keeps the
    // ordinary handling, which blocks.
    const offset = releaseOffsetKeyOf(target);
    if (!target.sourceIds.length || !target.sourceIds.every(id => sourceById.get(id)?.qualifies === true
      && sourceById.get(id).dominantOffset === offset)) return refuse();
    const option = target.options.find(item => item.representation === REPRESENTATION.EXTEND_TO_NEXT_GRID);
    const event = eventsById.get(target.eventId);
    if (!option?.valid || event?.kind !== 'note') return refuse();
    const release = f(event.end);
    const heldTo = f(option.finalRelease);
    const delta = heldTo.sub(release);
    if (delta.cmp(0) <= 0 || delta.cmp(SAFE_GRID) >= 0) return refuse();
    holds.set(target.eventId, { target, event, option, offset, release, heldTo, delta, intervalKeys: [] });
  }

  for (const interval of unknown) {
    if (!EVIDENCE_MISSING_BASES.has(interval.classificationBasis)) return refuse();
    const identity = interval.identity;
    let hold = null;
    if (identity.type === INTERVAL_TYPES.INTER_EVENT_GAP) {
      // The gap after a note's release, closed exactly by holding that release.
      hold = holds.get(identity.previousEventId) ?? null;
      if (!hold || hold.release.cmp(identity.start) !== 0 || hold.heldTo.cmp(identity.end) !== 0) return refuse();
    } else if (identity.type === INTERVAL_TYPES.EVENT_DURATION) {
      // A sub-grid note whose release, once held, makes it at least a grid long.
      hold = holds.get(identity.eventId) ?? null;
      if (!hold
        || f(hold.event.start).cmp(identity.start) !== 0
        || hold.release.cmp(identity.end) !== 0
        || hold.heldTo.sub(hold.event.start).cmp(SAFE_GRID) < 0) return refuse();
    } else {
      return refuse();
    }
    hold.intervalKeys.push(interval.identityKey);
  }

  const releases = [...holds.values()]
    .sort((a, b) => cmpText(a.target.role, b.target.role) || cmpText(a.target.eventId, b.target.eventId))
    .map(({ target, event, option, offset, release, heldTo, delta, intervalKeys }) => Object.freeze({
      eventId: target.eventId,
      role: target.role,
      pitch: event.pitch,
      onset: String(event.start),
      // The candidate's release, and where a delivery holds it. The Source-Faithful
      // Baseline's release is beside them for the audit trail.
      release: release.toString(),
      heldTo: heldTo.toString(),
      delta: delta.toString(),
      deltaTicks: option.deltaTicks,
      baselineRelease: target.source.release,
      sourceIds: Object.freeze([...target.sourceIds]),
      offsetBeforeNextGrid: offset,
      effect: option.effect,
      followingShape: target.analysis.followingShape,
      representation: REPRESENTATION.EXTEND_TO_NEXT_GRID,
      // Held for delivery only; the intervals it closes stay UNKNOWN.
      classification: MICRO_TIMING_CLASSIFICATIONS.UNKNOWN,
      intervalKeys: Object.freeze([...intervalKeys].sort()),
    }));
  const rendered = source => releases.filter(item => item.sourceIds.includes(source.sourceId)).length;
  return Object.freeze({
    eligible: true,
    releases: Object.freeze(releases),
    sources: Object.freeze(sources.map(source => Object.freeze({
      ...source,
      provisionallyRendered: rendered(source),
      unresolved: source.releaseCount - rendered(source),
    }))),
  });
}

const positionKey = (role, beat) => `${role}\u0000${f(beat).toString()}`;
const isAssignedSpan = event => event && (event.kind === 'note' || event.kind === 'rest')
  && event.id && event.start != null && event.end != null && ROLES.includes(event.role);

/**
 * Each onset or rest boundary no admitted Final token sequence can reach
 * (`canonical/release-timing.mjs#classifyPosition`), with how this gate covers it
 * (BOUNDARY_COVERAGE). Positions are compared per role and as exact rationals.
 *
 * A Final role is written as consecutive tokens from beat 0, so it has to reach
 * every position where one of its notes starts or ends, and the position where
 * the role ends; silence in between is one exact span however many rests the
 * candidate holds there. Nothing here moves a boundary or reads its meaning.
 */
function coverUnsupportedBoundaries(project, microTiming, releaseAnalysis) {
  const boundaries = releaseAnalysis.unsupportedBoundaries;
  // No entry, no change: the report keeps the analysis's own frozen list.
  if (!boundaries.length) return boundaries;

  const spans = (Array.isArray(project?.events) ? project.events : []).filter(isAssignedSpan);
  const byId = new Map(spans.map(event => [event.id, event]));

  const intervalEnds = new Set();
  for (const interval of microTiming.intervals) {
    for (const eventId of interval.eventIds) {
      const role = byId.get(eventId)?.role;
      if (!role) continue;
      intervalEnds.add(positionKey(role, interval.identity.start));
      intervalEnds.add(positionKey(role, interval.identity.end));
    }
  }

  // Only a release that raises RELEASE_NOT_FINAL_REPRESENTABLE decides a
  // boundary. A release under a keep claim is left out of that count, so nothing
  // on the release side is raised for it; counting it here would let a boundary
  // at an unreachable position pass this gate unblocked.
  const releaseTargets = new Set();
  for (const target of releaseAnalysis.targets) {
    if (!isNotVisibleToIntervalAnalyzer(target)) continue;
    const event = byId.get(target.eventId);
    if (event) releaseTargets.add(positionKey(target.role, event.end));
  }

  const reached = new Set();
  const roleEnds = new Map();
  for (const event of spans) {
    if (event.kind === 'note') {
      reached.add(positionKey(event.role, event.start));
      reached.add(positionKey(event.role, event.end));
    }
    const end = f(event.end);
    if (!roleEnds.has(event.role) || end.cmp(roleEnds.get(event.role)) > 0) roleEnds.set(event.role, end);
  }
  for (const [role, end] of roleEnds) reached.add(positionKey(role, end));

  return Object.freeze(boundaries.map(boundary => {
    const key = positionKey(boundary.role, boundary.position);
    let coverage = BOUNDARY_COVERAGE.NONE;
    if (intervalEnds.has(key)) coverage = BOUNDARY_COVERAGE.ANALYSED_INTERVAL;
    else if (releaseTargets.has(key)) coverage = BOUNDARY_COVERAGE.RELEASE_TARGET;
    else if (!reached.has(key)) coverage = BOUNDARY_COVERAGE.INSIDE_SILENCE;
    return Object.freeze({ ...boundary, coverage });
  }));
}

// Canonical IR beats are quarter notes, so a whole-note 1/N is 4/N IR beats.
// Exact rational throughout: no float, no rounding, no epsilon.
function safeGridFromDenominator(denominator) {
  if (!Number.isInteger(denominator) || denominator <= 0) return null;
  return new F(4, denominator);
}

/**
 * Read the Final micro-gap policy out of the executable contract and check that
 * it still implements the published rule.
 *
 * `shortestSafeDenominator`, `rejectTechnicalMicroGapsBelow64` and
 * `preserveMeaningfulRests` are contract *echoes* of MOBILE_SYNTAX §4 and
 * MASTER_RULES §7. They are read here, never treated as their own authority: a
 * contract that stops echoing the published rule is reported as non-conformant
 * and fails closed. It does not get to relax the rule, and it does not get to
 * retune the classifier's 1/64 detection window either — a disagreement between
 * the contract denominator and the analyzer grid is a blocker, not a new grid.
 */
export function readMicroGapPolicy(mobileSyntax = EFFECTIVE_RULESET.mobileSyntax) {
  const declaredDenominator = mobileSyntax?.shortestSafeDenominator;
  const rejectTechnical = mobileSyntax?.rejectTechnicalMicroGapsBelow64 === true;
  const preserveRests = mobileSyntax?.preserveMeaningfulRests === true;
  const declaredGrid = safeGridFromDenominator(declaredDenominator);

  const blockers = [];
  if (!declaredGrid) blockers.push(MICRO_GAP_BLOCKERS.SAFE_GRID_UNDECLARED);
  else if (declaredGrid.cmp(SAFE_GRID) !== 0) blockers.push(MICRO_GAP_BLOCKERS.SAFE_GRID_MISMATCH);
  if (!rejectTechnical) blockers.push(MICRO_GAP_BLOCKERS.TECHNICAL_REJECTION_DISABLED);
  if (!preserveRests) blockers.push(MICRO_GAP_BLOCKERS.MEANINGFUL_REST_PRESERVATION_DISABLED);

  return Object.freeze({
    declaredSafeDenominator: Number.isInteger(declaredDenominator) ? declaredDenominator : null,
    declaredSafeGrid: declaredGrid ? declaredGrid.toString() : null,
    analyzerSafeGrid: SAFE_GRID.toString(),
    rejectTechnicalMicroGapsBelow64: rejectTechnical,
    preserveMeaningfulRests: preserveRests,
    conformant: blockers.length === 0,
    blockers: Object.freeze(blockers),
  });
}

function enforcementFor(classification) {
  switch (classification) {
    case MICRO_TIMING_CLASSIFICATIONS.SOURCE_SUPPORTED_MICROTIMING:
      return MICRO_GAP_ENFORCEMENT.PRESERVE;
    case MICRO_TIMING_CLASSIFICATIONS.TECHNICAL_RESIDUE:
      return MICRO_GAP_ENFORCEMENT.REJECT_FINAL;
    default:
      // UNKNOWN, and any classification this module does not recognise.
      return MICRO_GAP_ENFORCEMENT.BLOCK_PENDING;
  }
}

// The per-interval record a Final emitter consumes. Structured identity and
// identityKey only: identityLabel is presentation and collides across distinct
// intervals, so it is never a handle.
function enforcementRecord(interval) {
  return Object.freeze({
    identity: interval.identity,
    identityKey: interval.identityKey,
    intervalType: interval.intervalType,
    length: interval.length,
    safeGridComparison: interval.safeGridComparison,
    classification: interval.classification,
    classificationBasis: interval.classificationBasis,
    enforcement: enforcementFor(interval.classification),
    decisionId: interval.decisionId,
    eventIds: interval.eventIds,
    sourceIds: interval.sourceIds,
  });
}

function failedAnalysisReport(policy, error) {
  return Object.freeze({
    status: 'PENDING',
    blockers: Object.freeze([MICRO_GAP_BLOCKERS.ANALYSIS_FAILED, ...policy.blockers]),
    error: error.message,
    policy,
    policyBlockers: policy.blockers,
    safeGrid: SAFE_GRID.toString(),
    candidateCount: null,
    sourceSupportedCount: null,
    technicalResidueCount: null,
    unknownCount: null,
    unresolvedStreamIssueCount: null,
    hasUnknown: null,
    hasUnresolvedStreamAnalysis: null,
    technicalResidueIntervals: Object.freeze([]),
    unknownIntervals: Object.freeze([]),
    sourceSupportedIntervalKeys: Object.freeze([]),
    unresolvedStreamIssues: Object.freeze([]),
    enforcement: Object.freeze([]),
    preservedIntervalKeys: Object.freeze([]),
    rejectedIntervalKeys: Object.freeze([]),
    blockedIntervalKeys: Object.freeze([]),
    finalRepresentable: null,
    releaseTiming: null,
    releaseRepresentationRecords: null,
    unsupportedBoundaries: Object.freeze([]),
    provisionalReleases: Object.freeze([]),
    provisionalReleaseIntervalKeys: Object.freeze([]),
    releaseOffsetSources: Object.freeze([]),
  });
}

/**
 * Apply the published Final micro-gap policy to a Canonical project.
 *
 * Returns a frozen enforcement report. It never returns PASS on uncertainty, on
 * a confirmed artifact, on a non-conformant contract, or on an onset or rest
 * boundary a Final role has to reach and no admitted token sequence can, and it
 * never proposes touching a source-supported interval.
 *
 * `finalRepresentable` stays null: source support answers musical meaning only.
 * Whether the emitted Final MML can represent an interval is a separate question
 * with its own mechanism, and the technical MML gate remains separately required.
 */
export function enforceMicroGaps(project, { mobileSyntax, releaseEvidenceRegistry = null } = {}) {
  if (!project || typeof project !== 'object') throw Error('Canonical project is required');
  // Omitting the option reads the real contract via readMicroGapPolicy's own
  // default; passing an explicit null or a partial object fails closed there
  // rather than silently falling back to the published values.
  const policy = readMicroGapPolicy(mobileSyntax);

  let report;
  try {
    report = analyzeProjectMicroTiming(project);
  } catch (error) {
    // Fail closed: an analysis that cannot run has not cleared anything.
    return failedAnalysisReport(policy, error);
  }

  const enforcement = report.intervals.map(enforcementRecord);
  const preserved = enforcement.filter(item => item.enforcement === MICRO_GAP_ENFORCEMENT.PRESERVE);
  const rejected = enforcement.filter(item => item.enforcement === MICRO_GAP_ENFORCEMENT.REJECT_FINAL);
  const blocked = enforcement.filter(item => item.enforcement === MICRO_GAP_ENFORCEMENT.BLOCK_PENDING);

  const technicalResidue = report.intervals.filter(
    item => item.classification === MICRO_TIMING_CLASSIFICATIONS.TECHNICAL_RESIDUE,
  );
  const unknown = report.intervals.filter(
    item => item.classification === MICRO_TIMING_CLASSIFICATIONS.UNKNOWN,
  );
  const sourceSupported = report.intervals.filter(
    item => item.classification === MICRO_TIMING_CLASSIFICATIONS.SOURCE_SUPPORTED_MICROTIMING,
  );

  const blockers = [];
  if (technicalResidue.length) blockers.push(MICRO_GAP_BLOCKERS.TECHNICAL_RESIDUE_PRESENT);
  if (unknown.length) blockers.push(MICRO_GAP_BLOCKERS.CLASSIFICATION_UNKNOWN);
  if (report.unresolvedStreamIssues.length) blockers.push(MICRO_GAP_BLOCKERS.STREAM_IDENTITY_UNRESOLVED);

  // A source-supported interval must never end up on a reject list, whatever a
  // later edit does to the mapping above. This is the invariant that stops G10
  // from ever collapsing into "everything under 1/64 goes away", so it is
  // checked rather than assumed.
  const preservedKeys = new Set(preserved.map(item => item.identityKey));
  const invariantViolated = rejected.some(item => preservedKeys.has(item.identityKey))
    || preserved.some(item => item.classification !== MICRO_TIMING_CLASSIFICATIONS.SOURCE_SUPPORTED_MICROTIMING)
    || rejected.some(item => item.classification !== MICRO_TIMING_CLASSIFICATIONS.TECHNICAL_RESIDUE);
  if (invariantViolated) blockers.push(MICRO_GAP_BLOCKERS.ENFORCEMENT_INVARIANT_VIOLATED);

  blockers.push(...policy.blockers);

  // Release representability (Layer B) and recorded representations (Layer C).
  // Appended after the analyzer and policy blockers, so a project whose releases
  // Final can all express keeps its blocker list byte for byte.
  let releaseAnalysis = null;
  let releaseRecords = { recordCount: 0, violations: [] };
  try {
    releaseAnalysis = analyzeReleaseTiming({ candidate: project, baseline: project?.metadata?.sourceFaithfulBaseline?.snapshot ?? null });
    // With the project's current evidence registry every stored citation is
    // re-resolved; without one the stored grading is re-checked for shape only.
    releaseRecords = verifyReleaseRepresentation(project, { registry: releaseEvidenceRegistry });
  } catch (error) {
    return failedAnalysisReport(policy, error);
  }
  if (releaseAnalysis.notVisibleToIntervalAnalyzerCount > 0) blockers.push(MICRO_GAP_BLOCKERS.RELEASE_NOT_FINAL_REPRESENTABLE);
  // Onsets and rest boundaries (Layer B as well). Raised only when a boundary
  // Final cannot reach is covered by nothing above, so a project whose
  // boundaries Final can all reach keeps its blocker list and its report byte
  // for byte.
  const unsupportedBoundaries = coverUnsupportedBoundaries(project, report, releaseAnalysis);
  if (unsupportedBoundaries.some(item => item.coverage === BOUNDARY_COVERAGE.NONE)) {
    blockers.push(MICRO_GAP_BLOCKERS.BOUNDARY_NOT_FINAL_REPRESENTABLE);
  }
  const recordInvalid = releaseRecords.violations.length > 0;
  if (recordInvalid) blockers.push(MICRO_GAP_BLOCKERS.RELEASE_RECORD_INVALID);
  const evidenceRequirement = releaseEvidenceRegistry && releaseAnalysis.decisionRequiredCount > 0
    ? releaseEvidenceRequirement(releaseEvidenceRegistry)
    : null;
  if (evidenceRequirement) blockers.push(MICRO_GAP_BLOCKERS.RELEASE_EVIDENCE_REQUIRED);

  // Appended last so an unmarked project's blocker list is unchanged byte for byte.
  if (carriesCanonicalCandidateMarker(project) && !isReleaseRegridCandidateActive(EFFECTIVE_RULESET.canonical?.canonical_version)) {
    blockers.push(MICRO_GAP_BLOCKERS.UNPUBLISHED_CANONICAL_CANDIDATE);
  }

  // After everything else, so it can only ever be added to a list that is
  // otherwise release-side, and never changes a project's list when it is not.
  const provisional = provisionalReleasePlan({ project, blockers, unknown, preserved, rejected, invariantViolated, recordInvalid, releaseAnalysis });
  if (provisional.eligible) blockers.push(MICRO_GAP_BLOCKERS.RELEASE_PROVISIONAL);

  // A confirmed Final violation outranks uncertainty, but the uncertain counts
  // and blockers stay visible rather than being hidden behind the FAIL. A
  // non-conformant contract can only ever demote PASS to PENDING; it can never
  // promote anything, and it never turns a FAIL into a pass.
  const status = rejected.length || invariantViolated || recordInvalid
    ? 'FAIL'
    : blockers.length ? 'PENDING' : 'PASS';

  return Object.freeze({
    status,
    blockers: Object.freeze(blockers),
    policy,
    policyBlockers: policy.blockers,
    safeGrid: report.safeGrid,
    candidateCount: report.candidateCount,
    sourceSupportedCount: report.sourceSupportedCount,
    technicalResidueCount: report.technicalResidueCount,
    unknownCount: report.unknownCount,
    unresolvedStreamIssueCount: report.unresolvedStreamIssueCount,
    hasUnknown: report.hasUnknown,
    hasUnresolvedStreamAnalysis: report.hasUnresolvedStreamAnalysis,
    technicalResidueIntervals: Object.freeze(technicalResidue.map(enforcementRecord)),
    unknownIntervals: Object.freeze(unknown.map(enforcementRecord)),
    sourceSupportedIntervalKeys: Object.freeze(sourceSupported.map(item => item.identityKey)),
    unresolvedStreamIssues: report.unresolvedStreamIssues,
    // The Final enforcement hook. A Canonical-aware emitter reads `enforcement`
    // for the full per-interval contract, or the three key lists directly:
    // `preservedIntervalKeys` is what it is forbidden to delete, shorten,
    // quantize, absorb into a neighbour or move an attack across;
    // `rejectedIntervalKeys` is the confirmed-artifact worklist it must not
    // silently emit; `blockedIntervalKeys` is unproven and must not be acted on
    // at all until classified.
    enforcement: Object.freeze(enforcement),
    preservedIntervalKeys: Object.freeze(preserved.map(item => item.identityKey)),
    rejectedIntervalKeys: Object.freeze(rejected.map(item => item.identityKey)),
    blockedIntervalKeys: Object.freeze(blocked.map(item => item.identityKey)),
    finalRepresentable: null,
    // Layer B counts over every note release, and Layer C re-verification of
    // every recorded release representation. The full per-event analysis is the
    // Mobile adaptation plan's, not this report's.
    releaseTiming: summarizeReleaseTiming(releaseAnalysis),
    // Which evidence would settle the releases still awaiting a decision, or null.
    releaseEvidenceRequirement: evidenceRequirement,
    releaseRepresentationRecords: Object.freeze({
      recordCount: releaseRecords.recordCount,
      registryChecked: releaseRecords.registryChecked === true,
      violations: Object.freeze([...releaseRecords.violations]),
    }),
    // Every onset or rest boundary Final cannot reach, each with its `coverage`
    // (BOUNDARY_COVERAGE); NONE is what raised BOUNDARY_NOT_FINAL_REPRESENTABLE.
    unsupportedBoundaries,
    // With RELEASE_PROVISIONAL: every release a delivery may hold to the
    // following attack or next grid point, and the UNKNOWN interval keys each
    // one closes. Empty otherwise. The provisional rendering's only worklist.
    provisionalReleases: provisional.releases,
    provisionalReleaseIntervalKeys: Object.freeze(provisional.releases.flatMap(item => item.intervalKeys)),
    // Per symbolic source: its dominant offset before the next grid point, that
    // offset's share, whether it meets PROVISIONAL_RELEASE_POLICY, and how many
    // of its releases are held provisionally and how many remain unresolved.
    releaseOffsetSources: provisional.sources,
  });
}

// Exposed so a caller can compare an interval length against the policy grid
// without re-encoding 1/64 anywhere. Exact rational comparison only.
export function isBelowSafeGrid(length) {
  return f(length).cmp(SAFE_GRID) < 0;
}
