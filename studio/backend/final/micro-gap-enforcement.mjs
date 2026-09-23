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
import { F, f } from '../mml/index.mjs';
import { EFFECTIVE_RULESET } from '../rules/index.mjs';
import {
  carriesCanonicalCandidateMarker,
  isReleaseRegridCandidateActive,
} from '../canonical/release-regrid-candidate.mjs';
import {
  SAFE_GRID,
  MICRO_TIMING_CLASSIFICATIONS,
  analyzeProjectMicroTiming,
} from '../canonical/micro-timing.mjs';
import {
  analyzeReleaseTiming,
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
  // exactly as before. Unsupported onsets and rest boundaries are reported in
  // `unsupportedBoundaries` for the same reason, without a blocker of their own.
  RELEASE_NOT_FINAL_REPRESENTABLE: 'MICRO_TIMING_RELEASE_NOT_FINAL_REPRESENTABLE',
  // A recorded release representation that does not re-verify from the project:
  // a timing change without the evidence-backed decision it claims.
  RELEASE_RECORD_INVALID: 'MICRO_TIMING_RELEASE_REPRESENTATION_RECORD_INVALID',
});

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
  });
}

/**
 * Apply the published Final micro-gap policy to a Canonical project.
 *
 * Returns a frozen enforcement report. It never returns PASS on uncertainty, on
 * a confirmed artifact, or on a non-conformant contract, and it never proposes
 * touching a source-supported interval.
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
  const recordInvalid = releaseRecords.violations.length > 0;
  if (recordInvalid) blockers.push(MICRO_GAP_BLOCKERS.RELEASE_RECORD_INVALID);

  // Appended last so an unmarked project's blocker list is unchanged byte for byte.
  if (carriesCanonicalCandidateMarker(project) && !isReleaseRegridCandidateActive(EFFECTIVE_RULESET.canonical?.canonical_version)) {
    blockers.push(MICRO_GAP_BLOCKERS.UNPUBLISHED_CANONICAL_CANDIDATE);
  }

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
    releaseRepresentationRecords: Object.freeze({
      recordCount: releaseRecords.recordCount,
      registryChecked: releaseRecords.registryChecked === true,
      violations: Object.freeze([...releaseRecords.violations]),
    }),
    unsupportedBoundaries: releaseAnalysis.unsupportedBoundaries,
  });
}

// Exposed so a caller can compare an interval length against the policy grid
// without re-encoding 1/64 anywhere. Exact rational comparison only.
export function isBelowSafeGrid(length) {
  return f(length).cmp(SAFE_GRID) < 0;
}
