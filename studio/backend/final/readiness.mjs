import { studioFinalBlockers } from '../rules/index.mjs';
import { compareCanonicalVersions } from '../compare/version-drift.mjs';

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
    .map(pair => ({ beforeId: pair.before?.id ?? null, afterId: pair.after?.id ?? null, changes: pair.changes }));

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

function leadGate(reports, leadEventDiff = null) {
  if (!Array.isArray(reports)) throw Error('leadDemotionReports must be an array');

  const relevant = reports.filter(report => report?.status !== 'N/A');
  const requiredEventIds = new Set();
  for (const id of leadEventDiff?.removed ?? []) {
    if (typeof id === 'string' && id) requiredEventIds.add(id);
  }
  for (const move of leadEventDiff?.roleMoved ?? []) {
    const id = move?.beforeId ?? move?.afterId;
    if (typeof id === 'string' && id) requiredEventIds.add(id);
  }

  if (requiredEventIds.size) {
    const byEventId = new Map(
      relevant
        .filter(report => typeof report?.eventId === 'string' && report.eventId)
        .map(report => [report.eventId, report]),
    );
    const pendingEventIds = [...requiredEventIds].filter(id => byEventId.get(id)?.status !== 'PASS');
    if (pendingEventIds.length) {
      return gate('PENDING', {
        blockers: ['LEAD_DEMOTION_EVIDENCE_REQUIRED'],
        pendingEventIds,
      });
    }
    return gate('PASS', { reviewed: requiredEventIds.size, requiredEventIds: [...requiredEventIds] });
  }

  if (!relevant.length) return gate('N/A', { reason: 'No Lead demotion requires arbitration.' });
  const pending = relevant.filter(report => report.status !== 'PASS');
  return pending.length
    ? gate('PENDING', { pendingEventIds: pending.map(report => report.eventId ?? null) })
    : gate('PASS', { reviewed: relevant.length });
}

function versionGate(lineageReport, reviewed) {
  if (!lineageReport) return gate('N/A', { reason: 'No accepted previous version supplied.' });
  if (lineageReport.reviewRequired && !reviewed) return gate('PENDING', { blockers: ['VERSION_DIVERGENCE_REVIEW_REQUIRED'] });
  return gate('PASS', { divergenceIncreased: lineageReport.divergenceIncreased ?? null, reviewed: Boolean(reviewed) });
}

export function evaluateProjectReadiness({
  project,
  mmlValidation,
  core3Report,
  harmonyReport,
  leadDemotionReports = [],
  lineageReport = null,
  versionDriftReviewed = false,
  playerReadback = 'NOT_RUN',
  originalAudioRequired = true,
  inGameAcceptance = 'PENDING',
}) {
  if (!project || typeof project !== 'object') throw Error('Canonical project is required');

  const implementationBlockers = studioFinalBlockers();
  const pendingDecisions = (project.decisions ?? []).filter(decision => decision.status === 'pending');
  const sourceComplete = project.metadata?.sourceComplete === true;
  const baseline = baselineGate(project);
  const leadDemotion = leadGate(
    leadDemotionReports,
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
    core3: gate(normalizeStatus(core3Report, 'NOT_RUN'), { blockers: core3Report?.blockers ?? [] }),
    leadDemotion,
    crossSourceHarmony: gate(normalizeStatus(harmonyReport, 'NOT_RUN'), { unresolvedCount: harmonyReport?.unresolvedCount ?? null }),
    versionDrift: versionGate(lineageReport, versionDriftReviewed),
    originalAudio: audioGate(project, originalAudioRequired),
    playerReadback: gate(normalizeStatus(playerReadback, 'NOT_RUN')),
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
    'core3',
    'leadDemotion',
    'crossSourceHarmony',
    'versionDrift',
    'originalAudio',
    'playerReadback',
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
    notice: 'Module availability never certifies a song. Candidate readiness requires source completeness plus a real Source-Faithful Baseline snapshot whose event-level diff is computed against the candidate, evidence-backed review of any Lead removals/role moves, and audio/arbitration/technical/player evidence. finalAccepted additionally requires in-game acceptance.',
  });
}
