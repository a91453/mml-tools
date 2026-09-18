import { studioFinalBlockers } from '../rules/index.mjs';
import { compareCanonicalVersions } from '../compare/version-drift.mjs';
import { enforceMicroGaps } from './micro-gap-enforcement.mjs';

const PASS_LIKE = new Set(['PASS', 'N/A']);

function normalizeStatus(value, fallback = 'PENDING') {
  if (typeof value === 'string') return value;
  if (value && typeof value.status === 'string') return value.status;
  return fallback;
}

function gate(status, details = {}) {
  return Object.freeze({ status, ...details });
}

function audioGate(project, required) {
  if (!required) return gate('N/A', { reason: 'Song-specific workflow explicitly marked original audio as not applicable.' });
  const evidence = project?.metadata?.audioAlignmentEvidence;
  if (!Array.isArray(evidence) || !evidence.length) return gate('PENDING', { blockers: ['AUDIO_ALIGNMENT_EVIDENCE_MISSING'] });
  const warnings = [...new Set(evidence.flatMap(item => Array.isArray(item.warnings) ? item.warnings : []))];
  if (warnings.length) return gate('PENDING', { blockers: ['AUDIO_ALIGNMENT_REVIEW_REQUIRED'], warnings });
  return gate('PASS', { evidenceCount: evidence.length });
}

function validBaselineSnapshot(snapshot) {
  return snapshot
    && typeof snapshot === 'object'
    && typeof snapshot.id === 'string'
    && snapshot.id.trim()
    && Array.isArray(snapshot.sources)
    && Array.isArray(snapshot.events)
    && snapshot.events.length > 0;
}

function baselineGate(project) {
  const baseline = project?.metadata?.sourceFaithfulBaseline;
  if (!baseline || typeof baseline !== 'object') {
    return gate('PENDING', { blockers: ['SOURCE_FAITHFUL_BASELINE_MISSING'] });
  }

  const snapshot = baseline.snapshot;
  if (!validBaselineSnapshot(snapshot)) {
    return gate('PENDING', { blockers: ['SOURCE_FAITHFUL_BASELINE_ARTIFACT_MISSING'] });
  }

  let eventDiff;
  try {
    eventDiff = compareCanonicalVersions(snapshot, project);
  } catch (error) {
    return gate('PENDING', {
      blockers: ['SOURCE_FAITHFUL_BASELINE_DIFF_INVALID'],
      error: error.message,
    });
  }

  const leadAdded = eventDiff.notes.added.filter(event => event.role === 'Melody').map(event => event.id);
  const leadRemoved = eventDiff.notes.removed.filter(event => event.role === 'Melody').map(event => event.id);
  const leadModified = eventDiff.notes.modified
    .filter(pair => pair.before?.role === 'Melody' || pair.after?.role === 'Melody')
    .map(pair => ({ beforeId: pair.before?.id ?? null, afterId: pair.after?.id ?? null, changes: pair.changes }));
  const leadRoleMoved = eventDiff.notes.roleMoved
    .filter(pair => pair.before?.role === 'Melody' || pair.after?.role === 'Melody')
    .map(pair => ({
      beforeId: pair.before?.id ?? null,
      afterId: pair.after?.id ?? null,
      beforeRole: pair.before?.role ?? null,
      afterRole: pair.after?.role ?? null,
      changes: pair.changes,
    }));

  return gate('PASS', {
    baselineId: snapshot.id,
    eventDiff,
    leadEventDiff: Object.freeze({
      added: Object.freeze(leadAdded),
      removed: Object.freeze(leadRemoved),
      modified: Object.freeze(leadModified),
      roleMoved: Object.freeze(leadRoleMoved),
    }),
  });
}

function evidenceReportGate(reports, requiredEventIds, { reportName, blocker, noneReason }) {
  if (!Array.isArray(reports)) throw Error(`${reportName} must be an array`);
  const relevant = reports.filter(report => report?.status !== 'N/A');

  if (requiredEventIds.size) {
    const byEventId = new Map(
      relevant
        .filter(report => typeof report?.eventId === 'string' && report.eventId)
        .map(report => [report.eventId, report]),
    );
    const pendingEventIds = [...requiredEventIds].filter(id => byEventId.get(id)?.status !== 'PASS');
    if (pendingEventIds.length) {
      return gate('PENDING', {
        blockers: [blocker],
        pendingEventIds,
      });
    }
    return gate('PASS', { reviewed: requiredEventIds.size, requiredEventIds: [...requiredEventIds] });
  }

  if (!relevant.length) return gate('N/A', { reason: noneReason });
  const pending = relevant.filter(report => report.status !== 'PASS');
  return pending.length
    ? gate('PENDING', { pendingEventIds: pending.map(report => report.eventId ?? null) })
    : gate('PASS', { reviewed: relevant.length });
}

function leadDemotionGate(reports, leadEventDiff = null) {
  const requiredEventIds = new Set();
  for (const id of leadEventDiff?.removed ?? []) {
    if (typeof id === 'string' && id) requiredEventIds.add(id);
  }
  for (const move of leadEventDiff?.roleMoved ?? []) {
    if (move?.beforeRole !== 'Melody' || move?.afterRole === 'Melody') continue;
    const id = move.beforeId ?? move.afterId;
    if (typeof id === 'string' && id) requiredEventIds.add(id);
  }
  return evidenceReportGate(reports, requiredEventIds, {
    reportName: 'leadDemotionReports',
    blocker: 'LEAD_DEMOTION_EVIDENCE_REQUIRED',
    noneReason: 'No Lead demotion requires arbitration.',
  });
}

function leadPromotionGate(reports, leadEventDiff = null) {
  const requiredEventIds = new Set();
  for (const id of leadEventDiff?.added ?? []) {
    if (typeof id === 'string' && id) requiredEventIds.add(id);
  }
  for (const move of leadEventDiff?.roleMoved ?? []) {
    if (move?.afterRole !== 'Melody' || move?.beforeRole === 'Melody') continue;
    const id = move.afterId ?? move.beforeId;
    if (typeof id === 'string' && id) requiredEventIds.add(id);
  }
  return evidenceReportGate(reports, requiredEventIds, {
    reportName: 'leadPromotionReports',
    blocker: 'LEAD_PROMOTION_EVIDENCE_REQUIRED',
    noneReason: 'No Lead promotion requires arbitration.',
  });
}

// G10. Published MOBILE_SYNTAX forbids technical micro-gaps and decomposition
// components finer than 1/64 only when they carry no source-supported musical
// meaning, so a sub-grid interval is never forbidden merely for being short.
// This gate therefore keeps the analyzer's four outcomes apart instead of
// collapsing them into a boolean:
//
//   SOURCE_SUPPORTED_MICROTIMING  proven musical meaning       -> may PASS
//   TECHNICAL_RESIDUE             proven meaning-free          -> FAIL
//   UNKNOWN                       unproven either way          -> PENDING
//   unresolved stream identity    relationship not establishable -> PENDING
//
// The classification/enforcement split itself lives in
// final/micro-gap-enforcement.mjs, which is also where the published Final
// policy is read out of the executable contract. This gate is one of its two
// consumers; a future Canonical-aware Final emitter is the other, and neither
// re-derives the 1/64 grid or the per-class outcome.
//
// It answers the Canonical project itself. A caller-supplied "micro timing
// PASS", imported project metadata, or a decision record's own status text is
// input data, never a verdict. Uncertainty never becomes PASS, and nothing here
// mutates, quantizes, normalizes or deletes a source-supported interval to
// reach PASS.
function microTimingGate(project) {
  const { status, blockers, ...details } = enforceMicroGaps(project);
  return gate(status, {
    ...(blockers.length ? { blockers } : {}),
    ...details,
  });
}

// ACCEPTANCE_CRITERIA Gate 4 is two questions, and this file used to ask only
// one of them. `core3Continuity` is the source-relative audit: what did this
// candidate remove, modify or move away from the baseline without an approved
// reason, and is any source-supported Lead interval left uncovered.
// `core3Completeness` is Gate 4's own question: do Melody + Chord1 + Chord2
// stand up as a one-player arrangement at all.
//
// They are separate because a candidate identical to its baseline passes the
// first trivially and can fail the second completely -- a baseline that only
// ever carried a Melody is unchanged and incomplete at once. Neither gate
// implies the other, and neither is derived from the other's result.
function core3CompletenessGate(report) {
  const status = normalizeStatus(report, 'NOT_RUN');
  if (status === 'NOT_RUN') {
    return gate('PENDING', { blockers: ['CORE3_COMPLETENESS_NOT_EVALUATED'] });
  }
  const { status: _status, pass, blockers = [], notice, ...details } = report ?? {};
  return gate(status, { ...(blockers.length ? { blockers: [...blockers] } : {}), ...details });
}

function versionGate(lineageReport, reviewed) {
  if (!lineageReport) return gate('N/A', { reason: 'No accepted previous version supplied.' });
  if (lineageReport.reviewRequired && !reviewed) return gate('PENDING', { blockers: ['VERSION_DIVERGENCE_REVIEW_REQUIRED'] });
  return gate('PASS', { divergenceIncreased: lineageReport.divergenceIncreased ?? null, reviewed: Boolean(reviewed) });
}

function mobileAdaptationGate(value) {
  const status = normalizeStatus(value, 'PENDING');
  // ACCEPTANCE_CRITERIA Gate 8 is required for every Final candidate. "No
  // adaptation was needed" is still a reviewed PASS, not N/A: the reviewer has
  // established that the candidate needs no Mobile-specific transformation.
  if (status === 'N/A' || status === 'NOT_RUN') {
    return gate('PENDING', { blockers: ['MOBILE_ADAPTATION_REVIEW_REQUIRED'], reportedStatus: status });
  }
  return gate(status, status === 'PENDING' ? { blockers: ['MOBILE_ADAPTATION_REVIEW_REQUIRED'] } : {});
}

function regressionGate(reviewed) {
  // ACCEPTANCE_CRITERIA Gate 9 is a candidate-specific review, not an inference
  // from a clean diff or a passing test suite. Baseline/previous comparisons,
  // Lead/Core3 checks and historical fixtures are evidence the reviewer uses;
  // none of them silently upgrades this gate on its own.
  return reviewed === true
    ? gate('PASS', { historicalRegression: 'FIXTURE_PENDING', namedRegressionPassClaimed: false })
    : gate('PENDING', {
        blockers: ['REGRESSION_REVIEW_REQUIRED'],
        historicalRegression: 'FIXTURE_PENDING',
        namedRegressionPassClaimed: false,
      });
}

export function evaluateProjectReadiness({
  project,
  mmlValidation,
  core3Report,
  core3CompletenessReport = null,
  harmonyReport,
  leadDemotionReports = [],
  leadPromotionReports = [],
  lineageReport = null,
  versionDriftReviewed = false,
  playerReadback = 'NOT_RUN',
  originalAudioRequired = true,
  mobileAdaptation = 'PENDING',
  regressionReviewed = false,
  inGameAcceptance = 'PENDING',
}) {
  if (!project || typeof project !== 'object') throw Error('Canonical project is required');

  const implementationBlockers = studioFinalBlockers();
  const pendingDecisions = (project.decisions ?? []).filter(decision => decision.status === 'pending');
  const sourceComplete = project.metadata?.sourceComplete === true;
  const baseline = baselineGate(project);
  const leadDemotion = leadDemotionGate(
    leadDemotionReports,
    baseline.status === 'PASS' ? baseline.leadEventDiff : null,
  );
  const leadPromotion = leadPromotionGate(
    leadPromotionReports,
    baseline.status === 'PASS' ? baseline.leadEventDiff : null,
  );

  const gates = Object.freeze({
    implementation: implementationBlockers.length
      ? gate('PENDING', { blockers: implementationBlockers })
      : gate('PASS'),
    source: sourceComplete
      ? gate('PASS')
      : gate('PENDING', { blockers: ['SOURCE_COMPLETENESS_NOT_CONFIRMED'], incompleteInputs: project.metadata?.incompleteInputs ?? [] }),
    baseline,
    technical: mmlValidation?.ok === true
      ? gate('PASS')
      : gate(mmlValidation ? 'FAIL' : 'NOT_RUN', { errors: mmlValidation?.errors ?? [] }),
    // Deliberately separate from `technical`. That gate asks whether the
    // emitted MML is syntactically and technically valid; this one asks whether
    // sub-grid timing in the Canonical musical project has source-supported
    // meaning. Neither answer substitutes for the other.
    microTiming: microTimingGate(project),
    // Retained under its historical name so existing callers and reports keep
    // reading the source-continuity verdict they always read.
    core3: gate(normalizeStatus(core3Report, 'NOT_RUN'), { blockers: core3Report?.blockers ?? [] }),
    core3Completeness: core3CompletenessGate(core3CompletenessReport),
    leadDemotion,
    leadPromotion,
    crossSourceHarmony: gate(normalizeStatus(harmonyReport, 'NOT_RUN'), { unresolvedCount: harmonyReport?.unresolvedCount ?? null }),
    versionDrift: versionGate(lineageReport, versionDriftReviewed),
    originalAudio: audioGate(project, originalAudioRequired),
    playerReadback: gate(normalizeStatus(playerReadback, 'NOT_RUN')),
    mobileAdaptation: mobileAdaptationGate(mobileAdaptation),
    regression: regressionGate(regressionReviewed),
    inGameAcceptance: gate(normalizeStatus(inGameAcceptance, 'PENDING')),
    pendingDecisions: pendingDecisions.length
      ? gate('PENDING', { decisionIds: pendingDecisions.map(decision => decision.id) })
      : gate('PASS'),
  });

  const preGameGateNames = [
    'implementation',
    'source',
    'baseline',
    'technical',
    'microTiming',
    'core3',
    'core3Completeness',
    'leadDemotion',
    'leadPromotion',
    'crossSourceHarmony',
    'versionDrift',
    'originalAudio',
    'playerReadback',
    'mobileAdaptation',
    'regression',
    'pendingDecisions',
  ];
  const preGameBlocking = preGameGateNames.filter(name => !PASS_LIKE.has(gates[name].status));
  const candidateReady = preGameBlocking.length === 0;
  const finalAccepted = candidateReady && gates.inGameAcceptance.status === 'PASS';

  return Object.freeze({
    candidateReady,
    finalAccepted,
    preGameBlocking: Object.freeze(preGameBlocking),
    gates,
    notice: 'Module availability never certifies a song. Candidate readiness requires source completeness plus a real Source-Faithful Baseline snapshot whose event-level diff is computed against the candidate, an independent Gate 4 result for Core3 musical completeness that a clean source-continuity audit never supplies, evidence-backed review of any Lead removals/demotions and Lead additions/promotions, a source-aware micro-timing result with no confirmed technical residue and no unresolved sub-grid interval, audio/arbitration/technical/player evidence, an explicit evidence-backed Mobile adaptation review, and an explicit evidence-backed regression review. Named historical regressions without reproducible fixtures remain FIXTURE_PENDING and are never claimed as passed. finalAccepted additionally requires in-game acceptance.',
  });
}
