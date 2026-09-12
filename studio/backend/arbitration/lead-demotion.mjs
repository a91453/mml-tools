const ROLE_CLASSES = Object.freeze(['lead', 'accompaniment', 'inner', 'counter', 'duplicate', 'unknown']);
const AUDIO_CLASSES = Object.freeze(['foreground', 'background', 'mixed', 'unknown']);
const AVAILABILITY = Object.freeze(['available', 'unavailable']);
const SECTION_ROLES = Object.freeze(['vocal-active', 'vocal-rest', 'instrumental', 'intro', 'interlude', 'solo', 'outro', 'unknown']);

function nonEmpty(value) {
  return typeof value === 'string' && Boolean(value.trim());
}

function normalizeEvidenceItem(item, kind) {
  if (!item || typeof item !== 'object') throw Error(`${kind} evidence must be an object`);
  const availability = item.availability ?? 'available';
  if (!AVAILABILITY.includes(availability)) throw Error(`${kind}.availability must be available or unavailable`);
  if (availability === 'unavailable') return Object.freeze({ availability, classification: 'unknown', citation: item.citation ?? null });

  const allowed = kind === 'score' ? ROLE_CLASSES : AUDIO_CLASSES;
  const classification = item.classification ?? 'unknown';
  if (!allowed.includes(classification)) throw Error(`${kind}.classification is invalid`);
  if (classification !== 'unknown' && !nonEmpty(item.citation)) throw Error(`${kind} classified evidence requires a citation/source reference`);
  return Object.freeze({ availability, classification, citation: item.citation?.trim() ?? null });
}

export function evaluateLeadDemotion({
  event,
  destinationRole,
  sourceIdentity,
  sectionRole = 'unknown',
  scoreEvidence = { availability: 'unavailable' },
  audioEvidence = { availability: 'unavailable' },
  continuity = { checked: false, createsLeadGap: null, replacementEventIds: [] },
  core3 = { checked: false, status: 'PENDING' },
  positiveReason = '',
}) {
  if (!event || typeof event !== 'object') throw Error('Lead Demotion Gate requires an event');
  if (event.role !== 'Melody') return Object.freeze({ status: 'N/A', pass: true, blockers: [], warnings: [], eventId: event.id ?? null, reason: 'Event is not currently assigned to Melody/Lead.' });
  if (!nonEmpty(destinationRole) || destinationRole === 'Melody') throw Error('Lead demotion requires a non-Melody destinationRole');
  if (!SECTION_ROLES.includes(sectionRole)) throw Error('sectionRole is invalid');

  const score = normalizeEvidenceItem(scoreEvidence, 'score');
  const audio = normalizeEvidenceItem(audioEvidence, 'audio');
  const blockers = [];
  const warnings = [];

  if (!sourceIdentity || !nonEmpty(sourceIdentity.sourceId) || !nonEmpty(sourceIdentity.sourceEventId)) blockers.push('SOURCE_IDENTITY_MISSING');
  if (sectionRole === 'unknown') blockers.push('SECTION_ROLE_UNRESOLVED');
  if (!nonEmpty(positiveReason)) blockers.push('POSITIVE_DESTINATION_REASON_MISSING');

  if (!continuity?.checked) blockers.push('LEAD_CONTINUITY_NOT_CHECKED');
  else if (continuity.createsLeadGap !== false) blockers.push('LEAD_GAP_CREATED');

  if (!core3?.checked) blockers.push('CORE3_NOT_CHECKED');
  else if (core3.status !== 'PASS') blockers.push(core3.status === 'FAIL' ? 'CORE3_FAILED' : 'CORE3_UNRESOLVED');

  const scoreSupportsDemotion = score.availability === 'available' && ['accompaniment', 'inner', 'counter', 'duplicate'].includes(score.classification);
  const audioSupportsDemotion = audio.availability === 'available' && audio.classification === 'background';
  const scoreSupportsLead = score.availability === 'available' && score.classification === 'lead';
  const audioSupportsLead = audio.availability === 'available' && audio.classification === 'foreground';

  if (!scoreSupportsDemotion && !audioSupportsDemotion) blockers.push('POSITIVE_ROLE_EVIDENCE_MISSING');
  if (scoreSupportsLead || audioSupportsLead) blockers.push('SOURCE_ROLE_EVIDENCE_CONFLICT');

  if (score.availability === 'unavailable') warnings.push('SCORE_ROLE_EVIDENCE_UNAVAILABLE');
  if (audio.availability === 'unavailable') warnings.push('AUDIO_ROLE_EVIDENCE_UNAVAILABLE');
  if (sectionRole === 'vocal-rest' || ['instrumental', 'intro', 'interlude', 'solo', 'outro'].includes(sectionRole)) {
    warnings.push('INSTRUMENTAL_LEAD_WINDOW_REQUIRES_EXTRA_CAUTION');
  }

  const uniqueBlockers = [...new Set(blockers)];
  return Object.freeze({
    status: uniqueBlockers.length ? 'PENDING' : 'PASS',
    pass: uniqueBlockers.length === 0,
    eventId: event.id ?? null,
    destinationRole,
    blockers: Object.freeze(uniqueBlockers),
    warnings: Object.freeze([...new Set(warnings)]),
    evidence: Object.freeze({
      sourceIdentity: sourceIdentity ? { ...sourceIdentity } : null,
      sectionRole,
      score,
      audio,
      continuity: { ...continuity, replacementEventIds: [...(continuity?.replacementEventIds ?? [])] },
      core3: { ...core3 },
      positiveReason: positiveReason.trim(),
    }),
    notice: 'Not proven Vocal is never positive demotion evidence. Conflicting source-role evidence preserves the Source-Faithful Lead Baseline until resolved.',
  });
}
