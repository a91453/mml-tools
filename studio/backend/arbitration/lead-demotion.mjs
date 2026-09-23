// Lead Role gates (MASTER_RULES.md §4, SOURCE_POLICY.md §4).
//
// This module is the shared place a Lead demotion or promotion is judged, and --
// since the G11-D residual hardening -- the one place a Lead evidence citation
// is bound to the event it claims to describe. Every caller reaches the same
// `sourceIdentityBlockers()`; none carries a private copy whose semantics could
// drift. A caller may run the binding *before* either gate to short-circuit, but
// each gate runs it again itself, so a caller that forgets gets the same refusal.

const ROLE_CLASSES = Object.freeze(['lead', 'accompaniment', 'inner', 'counter', 'duplicate', 'unknown']);
const AUDIO_CLASSES = Object.freeze(['foreground', 'background', 'mixed', 'unknown']);
const AVAILABILITY = Object.freeze(['available', 'unavailable']);
const SECTION_ROLES = Object.freeze(['vocal-active', 'vocal-rest', 'instrumental', 'intro', 'interlude', 'solo', 'outro', 'unknown']);
// How an audio classification was established, when the caller says so.
// SOURCE_POLICY §6: alignment/chroma/DTW/correlation/onset (and F0/CQT salience)
// metrics are evidence locators, not identity labels, and cannot alone prove
// Vocal identity, exact pitch, octave or role. A `machine-metric` audio
// classification may still raise a conflict (it can locate a problem window) but
// is never positive role evidence. Absent basis keeps the historical behaviour.
export const AUDIO_EVIDENCE_BASES = Object.freeze(['listening', 'machine-metric']);
export const AUDIO_METRIC_NOT_ROLE_EVIDENCE = 'AUDIO_METRIC_IS_A_LOCATOR_NOT_ROLE_EVIDENCE';
// What the cited source is allowed to prove, when a caller resolved the citation
// against the project's sources (SOURCE_POLICY §1): `primary` is an official
// score (§1A) or the original recording (§1B) the project holds and that is not
// a copy of a supporting file; `supporting` is third-party or derived material
// (§1C, §1D2); `unresolved` is a citation that names nothing the project holds.
// Only primary evidence is positive role evidence. Any classified evidence may
// still raise a conflict, which fails closed toward the Source-Faithful Lead.
// Absent, the historical behaviour is kept for callers that do not resolve.
export const EVIDENCE_SOURCE_AUTHORITIES = Object.freeze(['primary', 'supporting', 'unresolved']);
export const LEAD_EVIDENCE_SOURCE_NOT_AUTHORITATIVE = 'LEAD_EVIDENCE_SOURCE_NOT_AUTHORITATIVE';

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
  const normalized = { availability, classification, citation: item.citation?.trim() ?? null };
  if (kind === 'audio' && item.basis !== undefined && item.basis !== null) {
    if (!AUDIO_EVIDENCE_BASES.includes(item.basis)) throw Error('audio.basis must be listening or machine-metric');
    normalized.basis = item.basis;
  }
  if (item.sourceAuthority !== undefined && item.sourceAuthority !== null) {
    if (!EVIDENCE_SOURCE_AUTHORITIES.includes(item.sourceAuthority)) throw Error(`${kind}.sourceAuthority must be one of ${EVIDENCE_SOURCE_AUTHORITIES.join(', ')}`);
    normalized.sourceAuthority = item.sourceAuthority;
  }
  return Object.freeze(normalized);
}

// Evidence from a source that may prove a role: not a supporting or unresolved
// citation, when the caller resolved it.
const sourceMayProveRole = item => item.sourceAuthority === undefined || item.sourceAuthority === 'primary';
// Available score evidence that may count as *positive* role evidence.
const scoreIsPositiveEvidence = score => score.availability === 'available' && sourceMayProveRole(score);
// Available audio evidence that may count as *positive* role evidence: a metric
// is a locator (SOURCE_POLICY §6), whatever source it was computed from.
const audioIsPositiveEvidence = audio => audio.availability === 'available' && audio.basis !== 'machine-metric' && sourceMayProveRole(audio);
const sourceAuthorityWarnings = (score, audio) => ([score, audio].some(item => item.availability === 'available' && item.classification !== 'unknown' && item.sourceAuthority !== undefined && item.sourceAuthority !== 'primary')
  ? [LEAD_EVIDENCE_SOURCE_NOT_AUTHORITATIVE] : []);


// ─── Lead evidence identity binding ─────────────────────────────────────────

// The blocker a Lead evidence record earns when it does not describe the event
// it was attached to. One code, raised by one function, seen by every caller.
export const LEAD_EVIDENCE_IDENTITY_MISMATCH = 'LEAD_EVIDENCE_EVENT_IDENTITY_MISMATCH';

// The blocker a Lead evidence record earns when the target event carries more
// than one source and the Canonical IR cannot say which source event belongs to
// which source. Not a verdict on the music: the evidence scope cannot be proven
// with the representation available, so it is not guessed.
export const LEAD_EVIDENCE_PROVENANCE_PAIR_AMBIGUOUS = 'LEAD_EVIDENCE_PROVENANCE_PAIR_AMBIGUOUS';

export const SOURCE_IDENTITY_MISSING = 'SOURCE_IDENTITY_MISSING';
export const TARGET_EVENT_SOURCE_IDS_MISSING = 'TARGET_EVENT_SOURCE_IDS_MISSING';
export const TARGET_EVENT_SOURCE_EVENT_IDS_MISSING = 'TARGET_EVENT_SOURCE_EVENT_IDS_MISSING';

// Every code the binding can raise. A caller that wants to know whether a
// PENDING came from the binding rather than from the musical evidence checks
// membership here instead of re-deriving the list.
export const LEAD_EVIDENCE_IDENTITY_BLOCKERS = Object.freeze([
  SOURCE_IDENTITY_MISSING,
  TARGET_EVENT_SOURCE_IDS_MISSING,
  TARGET_EVENT_SOURCE_EVENT_IDS_MISSING,
  LEAD_EVIDENCE_PROVENANCE_PAIR_AMBIGUOUS,
  LEAD_EVIDENCE_IDENTITY_MISMATCH,
]);

const isPlainObject = value => Boolean(value) && typeof value === 'object' && !Array.isArray(value);

/**
 * Does this source identity describe *this* event?
 *
 * SOURCE_POLICY.md §4 lists source identity as the first thing a Lead move must
 * inspect. Inspecting it means confirming the identity belongs to the event
 * being moved -- not merely that two non-empty strings are present. Without
 * that, evidence gathered about event B satisfies a gate asked about event A,
 * and the gate reports a PASS carrying A's id, which is the key the readiness
 * Lead gate matches on.
 *
 * A citation is a *pair*: this source event, of this source. The Canonical IR
 * carries `sourceIds` and `sourceEventIds` as two independent arrays with no
 * pairing between them, and a source event id is source-local (raw MIDI emits
 * `track:N/event:M`), so it is not globally unique across sources. Membership
 * in each array separately proves only that the source is among the event's
 * sources and that the source event id is among its source events -- not that
 * the one belongs to the other.
 *
 * So the rule is: with exactly one source, the pair is unambiguous and the
 * citation must name that source and one of its source events. With more than
 * one source and no pair-preserving representation, the pairing cannot be
 * proven from this data, and it is not guessed: not by cross-membership, not by
 * array position, not by "it looks right". That case fails closed with
 * `LEAD_EVIDENCE_PROVENANCE_PAIR_AMBIGUOUS`. This is implementer caution under
 * the representation that exists; it asserts nothing about whether
 * multi-source provenance is valid, and adds no Canonical rule.
 *
 * Both halves of the single-source check are necessary. Two events from one
 * source share a `sourceId`, so matching only that would still let one event's
 * evidence move another; the `sourceEventId` is what pins the citation to a
 * single source event.
 *
 * A derived duplicate carries its origin's `sourceIds`/`sourceEventIds`, so it
 * binds against that origin provenance. Its own derived event id lives in a
 * different namespace and is never accepted here as a `sourceEventId`.
 *
 * Returns blocker codes; an empty array means the citation is in scope. It says
 * nothing about whether the evidence is *sufficient* -- authority, section role,
 * continuity and Core3 remain the gate's own questions.
 */
export function sourceIdentityBlockers(sourceIdentity, event) {
  const sourceIds = isPlainObject(event) && Array.isArray(event.sourceIds) ? event.sourceIds : [];
  const sourceEventIds = isPlainObject(event) && Array.isArray(event.sourceEventIds) ? event.sourceEventIds : [];
  if (!isPlainObject(sourceIdentity) || !nonEmpty(sourceIdentity.sourceId) || !nonEmpty(sourceIdentity.sourceEventId)) {
    // A missing identity on a multi-source event is reported with the reason
    // no constructor could supply one, so the reviewer sees both facts.
    return sourceIds.length > 1 ? [SOURCE_IDENTITY_MISSING, LEAD_EVIDENCE_PROVENANCE_PAIR_AMBIGUOUS] : [SOURCE_IDENTITY_MISSING];
  }
  if (!isPlainObject(event)) return [LEAD_EVIDENCE_IDENTITY_MISMATCH];

  const blockers = [];
  // An event that states no source-event identity cannot have a citation bound
  // to it at all. That fails closed rather than falling back to the source id,
  // which would re-open exactly the same-source hole this check exists to shut.
  if (!sourceIds.length) blockers.push(TARGET_EVENT_SOURCE_IDS_MISSING);
  if (!sourceEventIds.length) blockers.push(TARGET_EVENT_SOURCE_EVENT_IDS_MISSING);
  if (blockers.length) return blockers;

  // More than one source and no (sourceId, sourceEventId) pairing in the IR:
  // which source event belongs to which source cannot be established, so the
  // citation's scope cannot be proven. Fail closed before any membership test,
  // so that a citation which merely *looks* paired is never accepted either.
  if (sourceIds.length > 1) return [LEAD_EVIDENCE_PROVENANCE_PAIR_AMBIGUOUS];

  if (sourceIds[0] !== sourceIdentity.sourceId.trim()) blockers.push(LEAD_EVIDENCE_IDENTITY_MISMATCH);
  else if (!sourceEventIds.includes(sourceIdentity.sourceEventId.trim())) blockers.push(LEAD_EVIDENCE_IDENTITY_MISMATCH);
  return blockers;
}

// The same binding, for callers that hold a whole Lead evidence record rather
// than the identity alone. A missing record is reported as such rather than as
// a missing identity, so a reviewer is told which of the two to supply.
export function leadEvidenceIdentityBlockers(leadEvidence, event) {
  if (!isPlainObject(leadEvidence)) return ['LEAD_EVIDENCE_MISSING'];
  return sourceIdentityBlockers(leadEvidence.sourceIdentity, event);
}

/**
 * The only source identity this module will construct on a caller's behalf.
 *
 * It exists so that no writer has to reach into `sourceIds[0]` /
 * `sourceEventIds[0]` itself. With exactly one source, any of the event's
 * source event ids names a source event of that source, so citing the first is
 * a choice of citation, not a guess about pairing. With more than one source
 * there is nothing this function can prove, so it returns null rather than an
 * index-paired identity that the binding above would refuse anyway -- the
 * caller then records no identity, and the gate reports `SOURCE_IDENTITY_MISSING`
 * together with the pairing ambiguity for the reviewer to see.
 */
export function singleSourceIdentityOf(event) {
  if (!isPlainObject(event)) return null;
  const sourceIds = Array.isArray(event.sourceIds) ? event.sourceIds : [];
  const sourceEventIds = Array.isArray(event.sourceEventIds) ? event.sourceEventIds : [];
  if (sourceIds.length !== 1 || !sourceEventIds.length) return null;
  if (!nonEmpty(sourceIds[0]) || !nonEmpty(sourceEventIds[0])) return null;
  return Object.freeze({ sourceId: sourceIds[0], sourceEventId: sourceEventIds[0] });
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

  // Identity first, and inside the gate. `SOURCE_IDENTITY_MISSING` is one of
  // the binding's own codes, so presence and scope are one check with one
  // vocabulary: an identity that is present but describes another event, the
  // right source with another source event, another source with the right
  // source event, or an event whose provenance cannot pair, all stop here.
  const identityBlockers = sourceIdentityBlockers(sourceIdentity, event);
  blockers.push(...identityBlockers);
  if (sectionRole === 'unknown') blockers.push('SECTION_ROLE_UNRESOLVED');
  if (!nonEmpty(positiveReason)) blockers.push('POSITIVE_DESTINATION_REASON_MISSING');

  if (!continuity?.checked) blockers.push('LEAD_CONTINUITY_NOT_CHECKED');
  else if (continuity.createsLeadGap !== false) blockers.push('LEAD_GAP_CREATED');

  if (!core3?.checked) blockers.push('CORE3_NOT_CHECKED');
  else if (core3.status !== 'PASS') blockers.push(core3.status === 'FAIL' ? 'CORE3_FAILED' : 'CORE3_UNRESOLVED');

  const scoreSupportsDemotion = scoreIsPositiveEvidence(score) && ['accompaniment', 'inner', 'counter', 'duplicate'].includes(score.classification);
  const audioSupportsDemotion = audioIsPositiveEvidence(audio) && audio.classification === 'background';
  const scoreSupportsLead = score.availability === 'available' && score.classification === 'lead';
  // Any available audio classification can raise a conflict, including a metric.
  const audioSupportsLead = audio.availability === 'available' && audio.classification === 'foreground';

  if (!scoreSupportsDemotion && !audioSupportsDemotion) blockers.push('POSITIVE_ROLE_EVIDENCE_MISSING');
  if (scoreSupportsLead || audioSupportsLead) blockers.push('SOURCE_ROLE_EVIDENCE_CONFLICT');
  if (audio.basis === 'machine-metric' && audio.classification !== 'unknown') warnings.push(AUDIO_METRIC_NOT_ROLE_EVIDENCE);
  warnings.push(...sourceAuthorityWarnings(score, audio));

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
      // Stated as data so a reader can tell a PENDING caused by an out-of-scope
      // citation from one caused by the musical evidence.
      sourceIdentityBinding: Object.freeze({ bound: identityBlockers.length === 0, blockers: Object.freeze([...identityBlockers]) }),
      sectionRole,
      score,
      audio,
      continuity: { ...continuity, replacementEventIds: [...(continuity?.replacementEventIds ?? [])] },
      core3: { ...core3 },
      positiveReason: positiveReason.trim(),
    }),
    notice: 'Not proven Vocal is never positive demotion evidence. Conflicting source-role evidence preserves the Source-Faithful Lead Baseline until resolved. Evidence is bound to the exact source event it cites; a citation about another event, or one whose pairing cannot be proven, never certifies this one.',
  });
}

/**
 * Grade a move into Melody/Lead against the same Canonical evidence chain used
 * for Lead-role arbitration.
 *
 * This never decides that an event should become Lead. It grades evidence a
 * caller already supplied: exact source identity, resolved section role,
 * positive score/audio Lead evidence, continuity after the move, Core3
 * integrity, and an explicit positive reason for the Melody destination.
 * Conflicting positive/non-Lead source evidence fails closed to PENDING.
 */
export function evaluateLeadPromotion({
  event,
  destinationRole = 'Melody',
  sourceIdentity,
  sectionRole = 'unknown',
  scoreEvidence = { availability: 'unavailable' },
  audioEvidence = { availability: 'unavailable' },
  continuity = { checked: false, createsLeadGap: null, replacementEventIds: [] },
  core3 = { checked: false, status: 'PENDING' },
  positiveReason = '',
}) {
  if (!event || typeof event !== 'object') throw Error('Lead Promotion Gate requires an event');
  if (event.role === 'Melody') return Object.freeze({ status: 'N/A', pass: true, blockers: [], warnings: [], eventId: event.id ?? null, destinationRole: 'Melody', reason: 'Event is already assigned to Melody/Lead.' });
  if (destinationRole !== 'Melody') throw Error('Lead promotion requires destinationRole Melody');
  if (!SECTION_ROLES.includes(sectionRole)) throw Error('sectionRole is invalid');

  const score = normalizeEvidenceItem(scoreEvidence, 'score');
  const audio = normalizeEvidenceItem(audioEvidence, 'audio');
  const blockers = [];
  const warnings = [];

  const identityBlockers = sourceIdentityBlockers(sourceIdentity, event);
  blockers.push(...identityBlockers);
  if (sectionRole === 'unknown') blockers.push('SECTION_ROLE_UNRESOLVED');
  if (!nonEmpty(positiveReason)) blockers.push('POSITIVE_DESTINATION_REASON_MISSING');

  if (!continuity?.checked) blockers.push('LEAD_CONTINUITY_NOT_CHECKED');
  else if (continuity.createsLeadGap !== false) blockers.push('LEAD_GAP_CREATED');

  if (!core3?.checked) blockers.push('CORE3_NOT_CHECKED');
  else if (core3.status !== 'PASS') blockers.push(core3.status === 'FAIL' ? 'CORE3_FAILED' : 'CORE3_UNRESOLVED');

  const scoreSupportsLead = scoreIsPositiveEvidence(score) && score.classification === 'lead';
  const audioSupportsLead = audioIsPositiveEvidence(audio) && audio.classification === 'foreground';
  const scoreSupportsNonLead = score.availability === 'available' && ['accompaniment', 'inner', 'counter', 'duplicate'].includes(score.classification);
  // Any available audio classification can raise a conflict, including a metric.
  const audioSuggestsLead = audio.availability === 'available' && audio.classification === 'foreground';
  const audioSuggestsNonLead = audio.availability === 'available' && audio.classification === 'background';

  if (!scoreSupportsLead && !audioSupportsLead) blockers.push('POSITIVE_LEAD_EVIDENCE_MISSING');
  if ((scoreSupportsLead && audioSuggestsNonLead) || (audioSuggestsLead && scoreSupportsNonLead)) {
    blockers.push('SOURCE_ROLE_EVIDENCE_CONFLICT');
  }
  if (audio.basis === 'machine-metric' && audio.classification !== 'unknown') warnings.push(AUDIO_METRIC_NOT_ROLE_EVIDENCE);
  warnings.push(...sourceAuthorityWarnings(score, audio));

  if (score.availability === 'unavailable') warnings.push('SCORE_ROLE_EVIDENCE_UNAVAILABLE');
  if (audio.availability === 'unavailable') warnings.push('AUDIO_ROLE_EVIDENCE_UNAVAILABLE');

  const uniqueBlockers = [...new Set(blockers)];
  return Object.freeze({
    status: uniqueBlockers.length ? 'PENDING' : 'PASS',
    pass: uniqueBlockers.length === 0,
    eventId: event.id ?? null,
    destinationRole: 'Melody',
    blockers: Object.freeze(uniqueBlockers),
    warnings: Object.freeze([...new Set(warnings)]),
    evidence: Object.freeze({
      sourceIdentity: sourceIdentity ? { ...sourceIdentity } : null,
      sourceIdentityBinding: Object.freeze({ bound: identityBlockers.length === 0, blockers: Object.freeze([...identityBlockers]) }),
      sectionRole,
      score,
      audio,
      continuity: { ...continuity, replacementEventIds: [...(continuity?.replacementEventIds ?? [])] },
      core3: { ...core3 },
      positiveReason: positiveReason.trim(),
    }),
    notice: 'Promotion into Melody is a Lead-role move, not a highest-note shortcut. Positive, section-resolved Lead evidence plus reviewed continuity and Core3 integrity are required; conflicting source-role evidence remains PENDING. Evidence is bound to the exact source event it cites.',
  });
}

