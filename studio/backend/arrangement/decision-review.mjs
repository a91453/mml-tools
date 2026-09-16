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
import {
  ACCEPTED_DECISION_TYPES,
  LEAD_ROLE,
  LEAD_EVIDENCE_IDENTITY_MISMATCH,
  LEAD_EVIDENCE_PROVENANCE_PAIR_AMBIGUOUS,
  DECISION_REJECTION,
  CANONICAL_PROJECT_SCHEMA,
  leadEvidenceIdentityBlockers,
  revisionIdentityMatches,
  candidateDigestOf,
  baselineIdentityOf,
  snapshotDigestOf,
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

/**
 * The Lead Demotion reports the applied decisions' own evidence supports.
 *
 * Deliberately a separate, named call rather than something
 * `reviewAppliedCandidate` does on its own: handing the readiness Lead gate a
 * set of reports is a step a caller takes explicitly, and every report is
 * produced by `evaluateLeadDemotion()` itself against the *baseline* event. A
 * decision whose evidence does not satisfy the gate produces a non-PASS report
 * here exactly as it did at application time; this never manufactures a PASS.
 *
 * `baseline` may be the Source-Faithful baseline or the accepted previous
 * candidate the revision was applied onto -- both are identities the revision
 * binds -- and nothing else. Reports produced against the accepted previous are
 * information about the step just taken; readiness keys on the Source-Faithful
 * baseline and is handed reports made against that.
 *
 * Defence in depth, and not redundant. An application result is data: it can be
 * restored from storage, hand-built, mutated, or produced by a caller that
 * bypassed the recording path entirely, so `status === 'PASS'` is not evidence
 * that the scope checks ever ran. Both the identity binding and the one-event
 * containment are therefore re-established here, against the baseline event the
 * readiness Lead gate keys on -- because this is the last place a foreign
 * citation could be re-packaged as a PASS carrying the target event's id.
 */
export function leadDemotionReportsFromApplication(application, baseline) {
  // A forged or inconsistent application produces no report at all. With no
  // report, the readiness Lead gate stays PENDING for every Lead move the
  // baseline diff finds -- the closed direction.
  if (!requirePass(application, baseline)) return [];
  const baselineById = new Map((baseline?.events ?? []).map(event => [event.id, event]));
  const reports = [];
  for (const entry of application.applied) {
    if (entry.type !== ACCEPTED_DECISION_TYPES.MOVE_ROLE && entry.type !== ACCEPTED_DECISION_TYPES.OMIT_FROM_SIX) continue;
    const destinationOf = item => (entry.type === ACCEPTED_DECISION_TYPES.OMIT_FROM_SIX ? 'omitted' : item.toRole);
    const demoted = (entry.events ?? []).filter(item =>
      item.fromRole === LEAD_ROLE
      && !(entry.type === ACCEPTED_DECISION_TYPES.MOVE_ROLE && item.toRole === LEAD_ROLE));
    if (!demoted.length) continue;

    // One evidence record, one Lead event. An entry claiming several is not
    // split, and its first event does not inherit the citation.
    if ((entry.events ?? []).length !== 1) {
      for (const item of demoted) {
        reports.push(pendingReport(item.eventId, destinationOf(item), [DECISION_REJECTION.LEAD_EVIDENCE_MULTI_EVENT_SCOPE_UNSUPPORTED]));
      }
      continue;
    }

    for (const item of demoted) {
      const event = baselineById.get(item.eventId);
      if (!event) continue;
      const destinationRole = destinationOf(item);
      const scope = leadEvidenceIdentityBlockers(entry.leadEvidence, event);
      if (scope.length) {
        // Never reaches evaluateLeadDemotion: that gate only asks for a present
        // source identity, so foreign-but-well-formed evidence can make it
        // answer PASS under this event's id.
        reports.push(pendingReport(event.id, destinationRole, scope.includes(LEAD_EVIDENCE_IDENTITY_MISMATCH) || scope.includes(LEAD_EVIDENCE_PROVENANCE_PAIR_AMBIGUOUS)
          ? scope
          : [...scope, LEAD_EVIDENCE_IDENTITY_MISMATCH]));
        continue;
      }
      try {
        reports.push(evaluateLeadDemotion({
          ...(entry.leadEvidence ?? {}),
          event,
          destinationRole,
          positiveReason: entry.leadEvidence?.positiveReason ?? entry.reason,
        }));
      } catch (error) {
        reports.push(pendingReport(event.id, destinationRole, [`LEAD_DEMOTION_EVIDENCE_INVALID: ${error.message}`]));
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
    integrity,
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
