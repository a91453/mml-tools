import { studioFinalBlockers } from '../rules/index.mjs';

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

function leadGate(reports) {
  if (!Array.isArray(reports)) throw Error('leadDemotionReports must be an array');
  const relevant = reports.filter(report => report?.status !== 'N/A');
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

  const gates = Object.freeze({
    implementation: implementationBlockers.length
      ? gate('PENDING', { blockers: implementationBlockers })
      : gate('PASS'),
    source: sourceComplete
      ? gate('PASS')
      : gate('PENDING', { blockers: ['SOURCE_COMPLETENESS_NOT_CONFIRMED'], incompleteInputs: project.metadata?.incompleteInputs ?? [] }),
    technical: mmlValidation?.ok === true
      ? gate('PASS')
      : gate(mmlValidation ? 'FAIL' : 'NOT_RUN', { errors: mmlValidation?.errors ?? [] }),
    core3: gate(normalizeStatus(core3Report, 'NOT_RUN'), { blockers: core3Report?.blockers ?? [] }),
    leadDemotion: leadGate(leadDemotionReports),
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
    notice: 'Module availability never certifies a song. Candidate readiness requires song-specific source, audio, arbitration, technical and player evidence; finalAccepted additionally requires in-game acceptance.',
  });
}
