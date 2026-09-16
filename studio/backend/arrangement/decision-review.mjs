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
import { evaluateLeadDemotion } from '../arbitration/lead-demotion.mjs';
import { analyzeCrossSourceHarmony } from '../arbitration/harmony.mjs';
import { evaluateProjectReadiness } from '../final/index.mjs';
import { ACCEPTED_DECISION_TYPES, LEAD_ROLE } from './decision-application.mjs';

const requirePass = application => {
  if (!application || typeof application !== 'object') throw Error('reviewAppliedCandidate requires a G11-D application result');
  return application.status === 'PASS' && application.candidate;
};

/**
 * The Lead Demotion reports the applied decisions' own evidence supports.
 *
 * Deliberately a separate, named call rather than something
 * `reviewAppliedCandidate` does on its own: handing the readiness Lead gate a
 * set of reports is a step a caller takes explicitly, and every report is
 * produced by `evaluateLeadDemotion()` itself against the *baseline* event. A
 * decision whose evidence does not satisfy the gate produces a non-PASS report
 * here exactly as it did at application time; this never manufactures a PASS.
 */
export function leadDemotionReportsFromApplication(application, baseline) {
  if (!requirePass(application)) return [];
  const baselineById = new Map((baseline?.events ?? []).map(event => [event.id, event]));
  const reports = [];
  for (const entry of application.applied) {
    if (entry.type !== ACCEPTED_DECISION_TYPES.MOVE_ROLE && entry.type !== ACCEPTED_DECISION_TYPES.OMIT_FROM_SIX) continue;
    for (const item of entry.events) {
      if (item.fromRole !== LEAD_ROLE) continue;
      if (entry.type === ACCEPTED_DECISION_TYPES.MOVE_ROLE && item.toRole === LEAD_ROLE) continue;
      const event = baselineById.get(item.eventId);
      if (!event) continue;
      const destinationRole = entry.type === ACCEPTED_DECISION_TYPES.OMIT_FROM_SIX ? 'omitted' : item.toRole;
      try {
        reports.push(evaluateLeadDemotion({
          ...(entry.leadEvidence ?? {}),
          event,
          destinationRole,
          positiveReason: entry.leadEvidence?.positiveReason ?? entry.reason,
        }));
      } catch (error) {
        reports.push(Object.freeze({ status: 'PENDING', pass: false, eventId: event.id, destinationRole, blockers: Object.freeze([`LEAD_DEMOTION_EVIDENCE_INVALID: ${error.message}`]), warnings: Object.freeze([]) }));
      }
    }
  }
  return reports;
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
  core3ApprovedChanges = [],
  versionDriftReviewed = false,
  originalAudioRequired = true,
  playerReadback = 'NOT_RUN',
  inGameAcceptance = 'PENDING',
}) {
  if (!requirePass(application)) {
    return Object.freeze({
      status: 'NOT_APPLICABLE',
      reason: 'The accepted decision set was not applied, so there is no candidate to validate.',
      applicationStatus: application?.status ?? null,
      lineage: null,
      core3FromBaseline: null,
      core3FromPrevious: null,
      harmony: null,
      readiness: null,
    });
  }
  if (!baseline?.events) throw Error('reviewAppliedCandidate requires the Source-Faithful Canonical baseline');

  const candidate = application.candidate;
  const lineage = compareCandidateLineage({ sourceBaseline: baseline, acceptedPrevious, candidate });
  const core3FromBaseline = evaluateCore3Continuity({ baseline, candidate, approvedChanges: core3ApprovedChanges });
  const core3FromPrevious = acceptedPrevious
    ? evaluateCore3Continuity({ baseline: acceptedPrevious, candidate, approvedChanges: core3ApprovedChanges })
    : null;
  const harmony = analyzeCrossSourceHarmony(candidate);
  const readiness = evaluateProjectReadiness({
    project: candidate,
    mmlValidation,
    core3Report: core3FromBaseline,
    harmonyReport: harmony,
    leadDemotionReports,
    lineageReport: lineage,
    versionDriftReviewed,
    originalAudioRequired,
    playerReadback,
    inGameAcceptance,
  });

  return Object.freeze({
    status: 'REVIEWED',
    applicationStatus: application.status,
    revisionId: application.revision.id,
    diffFromBaseline: application.diffFromBaseline,
    diffFromPrevious: acceptedPrevious ? compareCanonicalVersions(acceptedPrevious, candidate) : application.diffFromParent,
    lineage,
    core3FromBaseline,
    core3FromPrevious,
    harmony,
    readiness,
    notice: 'Every verdict here belongs to the module that produced it. A G11-D application result is not an input to any of them, and REVIEWED is not a gate result: read readiness.candidateReady and the individual gates.',
  });
}
