import { EFFECTIVE_RULESET, studioFinalBlockers } from '../rules/index.mjs';
import { compareCanonicalVersions } from '../compare/version-drift.mjs';
import { enforceMicroGaps } from './micro-gap-enforcement.mjs';
import { LISTEN_FIRST_CODES, deliveryBlockingGates, evaluateMachineDelivery, machineDeliveryEmitOptions } from './delivery-evaluator.mjs';
// The emitter reads a readiness *report* (an option it is handed), never this
// module, so importing it here is no cycle; see the Final emission below.
import { emitFinalMml } from './mml-emitter.mjs';
import { LEAD_EVIDENCE_IDENTITY_MISMATCH, primaryEvidenceContradictsLead } from '../arbitration/lead-demotion.mjs';

const PASS_LIKE = new Set(['PASS', 'N/A']);

// The song-level states ACCEPTANCE_CRITERIA names. They are read out of the gates
// below; nothing sets one directly.
export const SONG_STATE = Object.freeze({
  CANDIDATE: 'CANDIDATE',
  VALIDATED: 'VALIDATED',
  IN_GAME_ACCEPTED: 'IN_GAME_ACCEPTED',
});

function normalizeStatus(value, fallback = 'PENDING') {
  if (typeof value === 'string') return value;
  if (value && typeof value.status === 'string') return value.status;
  return fallback;
}

function gate(status, details = {}) {
  return Object.freeze({ status, ...details });
}

// ACCEPTANCE_CRITERIA Gate 7 asks two things when official audio is part of the
// source set: beat<->recording alignment evidence exists for the relevant
// sections, AND the role / prominence / sustain / articulation /
// recording-structure questions have been reviewed. Warning-free alignment
// evidence answers only the first; "a globally implemented audio module does not
// pass this gate for a song automatically". The second is a candidate-bound,
// evidence-backed Gate 7 review (`original_audio_reviewed`), exactly as Studio
// Web already required its own `audio` review before this gate could pass.
function audioGate(project, required, reviewed = false) {
  if (!required) return gate('N/A', { reason: 'Song-specific workflow explicitly marked original audio as not applicable.' });
  const evidence = project?.metadata?.audioAlignmentEvidence;
  if (!Array.isArray(evidence) || !evidence.length) return gate('PENDING', { blockers: ['AUDIO_ALIGNMENT_EVIDENCE_MISSING'] });
  const warnings = [...new Set(evidence.flatMap(item => Array.isArray(item.warnings) ? item.warnings : []))];
  if (warnings.length) return gate('PENDING', { blockers: ['AUDIO_ALIGNMENT_REVIEW_REQUIRED'], warnings });
  if (reviewed !== true) return gate('PENDING', { blockers: ['ORIGINAL_AUDIO_GATE7_REVIEW_REQUIRED'], evidenceCount: evidence.length });
  return gate('PASS', { evidenceCount: evidence.length, reviewed: true });
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

  // Melody membership by event id, computed independently of how the diff
  // aligned notes -- and this is the thing the Lead gates key on, not the
  // alignment.
  //
  // `compareCanonicalVersions` pairs notes structurally (role, then onset),
  // never by id. So a candidate that swaps a Lead event with an inner voice at
  // the same onset -- demote melody-1 to Chord3, promote chord3-1 to Melody --
  // is aligned as the *same* Melody slot with a changed pitch, plus the
  // same Chord3 slot with a changed pitch. `roleMoved` comes back EMPTY, and
  // deriving the required set from it left both Lead gates with nothing to
  // require: `N/A`, which is PASS-like, for a Lead swap with no evidence at
  // all. Reproduced before this was written.
  //
  // Membership cannot be fooled that way: one event id, Melody on one side and
  // not the other, is a Lead move whatever the alignment made of it.
  // MASTER_RULES §4 requires positive role evidence for demoting a
  // source-supported Lead, and ACCEPTANCE_CRITERIA Gate 3 requires the evidence
  // chain for any Lead demotion; neither is conditional on a diff being able to
  // pair the notes.
  //
  // Only ids present on BOTH sides are read this way, and that restriction is
  // load-bearing rather than cautious. The two planes do not share an id space:
  // a G11-D candidate is derived from the baseline and keeps its ids, but a
  // Studio Web workspace can hold a baseline and a candidate imported as
  // separate assets, whose ids are independently generated even when the music
  // is identical. Treating a missing id as a move would then report every Lead
  // event of such a workspace as both demoted and promoted. Those cases are
  // already covered by `added`/`removed` above, which is where a note that
  // genuinely arrives or leaves belongs -- so this adds the one case the
  // alignment loses and nothing else.
  const noteById = events => new Map((events ?? [])
    .filter(event => event?.kind === 'note' && typeof event.id === 'string' && event.id)
    .map(event => [event.id, event]));
  const snapshotNotes = noteById(snapshot.events);
  const candidateNotes = noteById(project?.events);

  // Which candidate note IS this baseline note, and the reverse.
  //
  // This is the question the Lead gates actually turn on, and the diff cannot
  // answer it: `alignNotes` pairs notes by structure -- exact, then
  // role+onset+pitch, then role+onset -- and never by identity. Where both
  // sides share an id space the structural guess is usually right and any
  // mistake is caught below; where they do not, the guess is load-bearing and
  // wrong in the one case that matters:
  //
  //   baseline   A Melody C5 @0      candidate   X Melody E5 @0
  //              B Chord3 E5 @0                  Y Chord3 C5 @0
  //
  // The aligner pairs A with X and B with Y on role+onset and reports two pitch
  // modifications; `roleMoved`, `added` and `removed` all come back empty.
  // Reproduced before this was written: both Lead gates reported `N/A`, which
  // is PASS-like, for a Lead swap carrying no evidence at all.
  //
  // Correspondence is established from identity and never from coincidence:
  //
  //   the same event id            a derived candidate keeps the baseline's ids
  //   the same provenance citation one source, and the same source event ids,
  //                                so two projects built from one source
  //                                correspond even with unrelated ids
  //   a derived-duplicate chain    `derivedFromEventId` is reversible
  //
  // Pitch and onset agreement prove nothing about which source event a note is
  // -- that is exactly the substitution the Lead evidence binding refuses -- so
  // they are never consulted. A citation that cannot be pinned to one source
  // event establishes nothing either: the Canonical IR carries `sourceIds` and
  // `sourceEventIds` as independent arrays with no pairing between them, so a
  // multi-source note is ambiguous, and so is a citation two notes of the same
  // project share.
  const provenanceKey = event => {
    const sourceIds = Array.isArray(event?.sourceIds) ? event.sourceIds : [];
    const sourceEventIds = Array.isArray(event?.sourceEventIds) ? event.sourceEventIds : [];
    if (sourceIds.length !== 1 || !sourceEventIds.length) return null;
    const sourceId = typeof sourceIds[0] === 'string' ? sourceIds[0].trim() : '';
    if (!sourceId) return null;
    const cited = sourceEventIds.filter(id => typeof id === 'string' && id.trim()).map(id => id.trim()).sort();
    return cited.length === sourceEventIds.length && cited.length ? `${sourceId}\u0000${cited.join('\u0001')}` : null;
  };
  const byProvenance = notes => {
    const index = new Map();
    const ambiguous = new Set();
    for (const event of notes.values()) {
      const key = provenanceKey(event);
      if (!key) continue;
      if (index.has(key)) ambiguous.add(key);
      else index.set(key, event);
    }
    for (const key of ambiguous) index.delete(key);
    return index;
  };
  const snapshotByProvenance = byProvenance(snapshotNotes);
  const candidateByProvenance = byProvenance(candidateNotes);
  const counterpartOf = (event, byId, byProv) => {
    if (byId.has(event?.id)) return byId.get(event.id);
    const key = provenanceKey(event);
    return key ? byProv.get(key) ?? null : null;
  };

  // A derived duplicate declares the event it came from, and that chain is
  // reversible, so a justified duplicate into Melody stays an ordinary
  // answerable promotion rather than an open question. Bounded by a seen-set:
  // this reads stored candidate metadata.
  const tracesToSnapshot = event => {
    const seen = new Set();
    let current = event;
    while (current && typeof current.id === 'string' && !seen.has(current.id)) {
      if (counterpartOf(current, snapshotNotes, snapshotByProvenance)) return true;
      seen.add(current.id);
      const origin = current.metadata?.g11d?.derivedFromEventId;
      if (typeof origin !== 'string' || !origin) return false;
      current = candidateNotes.get(origin) ?? null;
      if (!current) return snapshotNotes.has(origin);
    }
    return false;
  };

  // Lead membership across that correspondence. One note, the Lead on one side
  // and not the other, is a Lead move whatever the alignment made of it.
  // MASTER_RULES §4 requires positive role evidence to demote a
  // source-supported Lead and Gate 3 requires the evidence chain for any Lead
  // demotion; neither is conditional on a diff being able to pair the notes.
  const demotedEventIds = [];
  const promotedEventIds = [];
  for (const before of snapshotNotes.values()) {
    const after = counterpartOf(before, candidateNotes, candidateByProvenance);
    if (!after) continue;
    if (before.role === 'Melody' && after.role !== 'Melody') demotedEventIds.push(before.id);
    else if (before.role !== 'Melody' && after.role === 'Melody') promotedEventIds.push(after.id);
  }

  // What correspondence could not reach. A pairing the aligner assumed, touching
  // a Lead event that has no counterpart at all, leaves the Lead question
  // neither proven nor refuted -- and Canonical requires it resolved, so it is
  // PENDING rather than absent. Membership above has already settled every note
  // that does have a counterpart, which is what keeps an ordinary shared-id
  // project, an ordinary pitch edit and an equivalent re-import out of here.
  const unresolvedDemotion = [];
  const unresolvedPromotion = [];
  for (const pair of [...(eventDiff.notes.modified ?? []), ...(eventDiff.notes.roleMoved ?? [])]) {
    if (pair?.before?.role !== 'Melody' && pair?.after?.role !== 'Melody') continue;
    const entry = Object.freeze({ beforeId: pair.before?.id ?? null, afterId: pair.after?.id ?? null, match: pair.match ?? null });
    if (pair.before?.role === 'Melody' && !counterpartOf(pair.before, candidateNotes, candidateByProvenance)) unresolvedDemotion.push(entry);
    if (pair.after?.role === 'Melody' && !tracesToSnapshot(pair.after)) unresolvedPromotion.push(entry);
  }

  return gate('PASS', {
    baselineId: snapshot.id,
    eventDiff,
    leadEventDiff: Object.freeze({
      added: Object.freeze(leadAdded),
      removed: Object.freeze(leadRemoved),
      modified: Object.freeze(leadModified),
      roleMoved: Object.freeze(leadRoleMoved),
      // One note, corresponded across the two projects, whose Lead membership
      // changed. Demotions name the baseline id, promotions the candidate id,
      // which is what the respective reports are keyed on.
      demotedEventIds: Object.freeze(demotedEventIds),
      promotedEventIds: Object.freeze(promotedEventIds),
      // Pairings the aligner assumed and identity cannot confirm, where a Lead
      // role change can be neither proven nor ruled out.
      identityUnresolved: Object.freeze({
        demotion: Object.freeze(unresolvedDemotion),
        promotion: Object.freeze(unresolvedPromotion),
      }),
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

// A Lead gate cannot be more certain than the correspondence underneath it.
//
// `unresolved` names pairings the aligner assumed across an id space the two
// projects do not share, each touching a Lead event. While one stands, whether
// a Lead role changed is unknown -- so the gate is PENDING even when every
// required event id it CAN name already has a PASS. The remedy is traceability,
// not a citation: preserve the event ids, or carry a single-source provenance
// pair on both sides, and the same material resolves to an ordinary proven move
// or an ordinary proven edit. That is why this reports its own blocker rather
// than `LEAD_*_EVIDENCE_REQUIRED`, which would send a reviewer to file evidence
// that cannot answer it.
function leadGateWithIdentity(result, unresolved) {
  if (!unresolved.length) return result;
  const { status: _status, reason: _reason, ...details } = result;
  return gate('PENDING', {
    ...details,
    blockers: [...new Set([...(result.blockers ?? []), 'LEAD_IDENTITY_CORRESPONDENCE_UNRESOLVED'])],
    unresolvedPairings: Object.freeze([...unresolved]),
  });
}

function leadDemotionGate(reports, leadEventDiff = null) {
  const requiredEventIds = new Set();
  // Membership first: it is the one derivation that does not depend on the
  // diff being able to pair the notes. The alignment-derived ids below are kept
  // as well -- the union can only require more, never less.
  for (const id of leadEventDiff?.demotedEventIds ?? []) {
    if (typeof id === 'string' && id) requiredEventIds.add(id);
  }
  for (const id of leadEventDiff?.removed ?? []) {
    if (typeof id === 'string' && id) requiredEventIds.add(id);
  }
  for (const move of leadEventDiff?.roleMoved ?? []) {
    if (move?.beforeRole !== 'Melody' || move?.afterRole === 'Melody') continue;
    const id = move.beforeId ?? move.afterId;
    if (typeof id === 'string' && id) requiredEventIds.add(id);
  }
  return leadGateWithIdentity(
    evidenceReportGate(reports, requiredEventIds, {
      reportName: 'leadDemotionReports',
      blocker: 'LEAD_DEMOTION_EVIDENCE_REQUIRED',
      noneReason: 'No Lead demotion requires arbitration.',
    }),
    leadEventDiff?.identityUnresolved?.demotion ?? [],
  );
}

// ACCEPTANCE_CRITERIA "Delivered first, flagged for listening", rule 2
// (2026-09-23-v3): a promotion into Melody whose only open question is missing
// primary evidence. Read from the Lead grader's own report for each pending
// event (arbitration/lead-demotion.mjs, arrangement/decision-review.mjs), never
// from a caller's statement about it.
//
// The report must say primary positive Lead evidence is missing -- none was
// supplied, or what was supplied is supporting-only or a metric (SOURCE_POLICY
// §1C, §6) -- and may otherwise only say which parts of the review were not
// supplied at all. Anything the grader determined (a conflict, primary
// evidence that says the event is not the Lead, a Lead gap, a Core3 failure),
// anything wrong with the evidence (malformed, describing
// another event or an earlier candidate, a citation that resolves to nothing
// the project holds), an origin outside the baseline, and a promotion with no
// report at all -- the grader never ran -- keep the gate BLOCKING.
const PRIMARY_LEAD_EVIDENCE_MISSING = new Set([
  'POSITIVE_LEAD_EVIDENCE_MISSING',
  'LEAD_EVIDENCE_MISSING',
  'LEAD_PROMOTION_EVIDENCE_MISSING',
]);
const LEAD_REVIEW_NOT_SUPPLIED = new Set([
  'SOURCE_IDENTITY_MISSING',
  'SECTION_ROLE_UNRESOLVED',
  'POSITIVE_DESTINATION_REASON_MISSING',
  'LEAD_CONTINUITY_NOT_CHECKED',
  'CORE3_NOT_CHECKED',
]);

function onlyPrimaryLeadEvidenceMissing(report) {
  if (report?.status !== 'PENDING') return false;
  const blockers = Array.isArray(report.blockers) ? report.blockers : [];
  if (!blockers.some(code => PRIMARY_LEAD_EVIDENCE_MISSING.has(code))) return false;
  // Given no evidence record at all, the lineage grader reports the absence
  // together with the binding's mismatch code: with nothing cited, nothing
  // describes another event. That exact pair is absence, and only that pair.
  const noRecordAtAll = blockers.length === 2
    && blockers.includes('LEAD_EVIDENCE_MISSING')
    && blockers.includes(LEAD_EVIDENCE_IDENTITY_MISMATCH);
  if (!noRecordAtAll && !blockers.every(code => PRIMARY_LEAD_EVIDENCE_MISSING.has(code) || LEAD_REVIEW_NOT_SUPPLIED.has(code))) return false;
  // A citation that resolves to nothing the project holds is invalid evidence,
  // not missing evidence.
  const evidence = report.evidence;
  if ([evidence?.score, evidence?.audio].some(item => item?.sourceAuthority === 'unresolved')) return false;
  // Primary evidence saying the event is not the Lead is contradicting
  // evidence, not missing evidence. The grader reports it as
  // PRIMARY_EVIDENCE_CONTRADICTS_LEAD, which is outside the allow-list above;
  // the report's own evidence is asked the same question too, so a report
  // graded before that code existed cannot pass as "evidence missing".
  return !primaryEvidenceContradictsLead(evidence?.score, evidence?.audio);
}

function withPrimaryLeadEvidenceMissing(result, reports) {
  if (result.status !== 'PENDING') return result;
  const blockers = Array.isArray(result.blockers) ? result.blockers : [];
  if (blockers.length !== 1 || blockers[0] !== 'LEAD_PROMOTION_EVIDENCE_REQUIRED') return result;
  const pending = Array.isArray(result.pendingEventIds) ? result.pendingEventIds : [];
  if (!pending.length) return result;
  // The same report per event the gate itself read.
  const byEventId = new Map(reports
    .filter(report => report?.status !== 'N/A' && typeof report?.eventId === 'string' && report.eventId)
    .map(report => [report.eventId, report]));
  if (!pending.every(id => onlyPrimaryLeadEvidenceMissing(byEventId.get(id)))) return result;
  const { status: _status, ...details } = result;
  return gate('PENDING', {
    ...details,
    blockers: [...blockers, LISTEN_FIRST_CODES.LEAD_PROMOTION_PRIMARY_EVIDENCE_MISSING],
    // Delivered as arranged and flagged "Lead unverified" where the loaded
    // machine-delivery schema says so; unresolved either way.
    unverifiedLeadEventIds: Object.freeze([...pending]),
  });
}

function leadPromotionGate(reports, leadEventDiff = null) {
  const requiredEventIds = new Set();
  for (const id of leadEventDiff?.promotedEventIds ?? []) {
    if (typeof id === 'string' && id) requiredEventIds.add(id);
  }
  for (const id of leadEventDiff?.added ?? []) {
    if (typeof id === 'string' && id) requiredEventIds.add(id);
  }
  for (const move of leadEventDiff?.roleMoved ?? []) {
    if (move?.afterRole !== 'Melody' || move?.beforeRole === 'Melody') continue;
    const id = move.afterId ?? move.beforeId;
    if (typeof id === 'string' && id) requiredEventIds.add(id);
  }
  return withPrimaryLeadEvidenceMissing(leadGateWithIdentity(
    evidenceReportGate(reports, requiredEventIds, {
      reportName: 'leadPromotionReports',
      blocker: 'LEAD_PROMOTION_EVIDENCE_REQUIRED',
      noneReason: 'No Lead promotion requires arbitration.',
    }),
    leadEventDiff?.identityUnresolved?.promotion ?? [],
  ), reports);
}

// G10. Published MOBILE_SYNTAX forbids technical micro-gaps and decomposition
// components finer than 1/64 only when they carry no source-supported musical
// meaning, so a sub-grid interval is never forbidden merely for being short.
// This gate therefore keeps the analyzer's four outcomes apart instead of
// collapsing them into a boolean:
//
//   SOURCE_SUPPORTED_MICROTIMING  proven musical meaning       -> PENDING with
//                                 MICRO_TIMING_SOURCE_SUPPORTED_NOT_FINAL_REPRESENTABLE
//   TECHNICAL_RESIDUE             proven meaning-free          -> FAIL
//   UNKNOWN                       unproven either way          -> PENDING
//   unresolved stream identity    relationship not establishable -> PENDING
//
// A source-supported interval keeps its classification and is preserved; it
// blocks because no admitted Final token is shorter than 1/64, so the loaded
// Canonical gives it no Final representation (ACCEPTANCE_CRITERIA Gate 2:
// PENDING/UNSUPPORTED, not guessed).
//
// Beside them, an onset, a rest boundary or a note release no release
// representation can move (under a keep claim, or with no valid
// representation), that the role has to reach at a position no admitted Final
// token sequence reaches and that no interval above decides, is PENDING too
// (MICRO_TIMING_BOUNDARY_NOT_FINAL_REPRESENTABLE). Such a release is decided
// only by its own sub-grid duration or the sub-grid gap after it, never by a
// sub-grid rest that merely starts at it.
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
function microTimingGate(project, releaseEvidenceRegistry) {
  const { status, blockers, ...details } = enforceMicroGaps(project, { releaseEvidenceRegistry });
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
  originalAudioReviewed = false,
  mobileAdaptation = 'PENDING',
  regressionReviewed = false,
  inGameAcceptance = 'PENDING',
  // The project's current release evidence registry. With it, recorded release
  // representations are re-graded against today's sources and assets.
  releaseEvidenceRegistry = null,
  // The Canonical identity the machine-delivery ledger is classified under: the
  // loaded release, unless a regression names another one explicitly.
  canonical = EFFECTIVE_RULESET.canonical,
  // The Final emitter's answer for exactly what would be delivered, when the
  // caller already has it: the result of its own delivery emission of this
  // project. Reused rather than emitted again.
  finalEmission = null,
  // Otherwise, how the caller delivers: `(readiness) => emit result`, handed
  // the report as it stands before the emission, called at most once and only
  // when nothing else stops delivery. Omitted, readiness emits exactly as
  // machine delivery does (`machineDeliveryEmitOptions`).
  emitFinal = null,
}) {
  if (!project || typeof project !== 'object') throw Error('Canonical project is required');
  if (emitFinal !== null && typeof emitFinal !== 'function') throw Error('emitFinal must be a function');

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
    microTiming: microTimingGate(project, releaseEvidenceRegistry),
    // Retained under its historical name so existing callers and reports keep
    // reading the source-continuity verdict they always read.
    core3: gate(normalizeStatus(core3Report, 'NOT_RUN'), { blockers: core3Report?.blockers ?? [] }),
    core3Completeness: core3CompletenessGate(core3CompletenessReport),
    leadDemotion,
    leadPromotion,
    crossSourceHarmony: gate(normalizeStatus(harmonyReport, 'NOT_RUN'), { unresolvedCount: harmonyReport?.unresolvedCount ?? null }),
    versionDrift: versionGate(lineageReport, versionDriftReviewed),
    originalAudio: audioGate(project, originalAudioRequired, originalAudioReviewed),
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
  // ACCEPTANCE_CRITERIA "Final state vocabulary", stated rather than left for a
  // caller to reassemble from two booleans: VALIDATED is every required
  // non-game gate PASS/N-A; IN_GAME_ACCEPTED additionally needs the in-game gate,
  // which only the user or a controlled target-client test records.
  const songState = finalAccepted ? SONG_STATE.IN_GAME_ACCEPTED : candidateReady ? SONG_STATE.VALIDATED : SONG_STATE.CANDIDATE;

  const report = machineDelivery => Object.freeze({
    candidateReady,
    finalAccepted,
    songState,
    machineDeliveryReady: machineDelivery.ready,
    automatedLifecycle: machineDelivery.lifecycle,
    machineDelivery,
    preGameBlocking: Object.freeze(preGameBlocking),
    gates,
    notice: READINESS_NOTICE,
  });

  // The Final itself. Every gate above can clear while the Final emitter, run
  // on exactly this project with the options delivery uses, refuses to write
  // it: a release that drifted from its baseline with no release record, a
  // Tempo position no Final token sequence reaches, a bounded duration search
  // that found nothing. Machine delivery is ready only when the emitter
  // returned an emitted Final, so it is asked -- once, and only when it is the
  // one question left: nothing stops delivery under the rule this identity
  // makes operative (`deliveryBlockingGates`), `technical` included. Asked
  // earlier, it could only restate a blocking gate as READINESS_BLOCKED. A
  // refusal is the delivery-level FINAL_EMISSION_REFUSED (or
  // FINAL_EMISSION_PENDING) entry carrying the emitter's own diagnostics
  // (final/delivery-evaluator.mjs); no gate above, no classification, no song
  // state and no emitter answer changes. A caller that already emitted hands
  // its result in and nothing is emitted twice.
  const projection = evaluateMachineDelivery(gates, { canonical });
  let emission = finalEmission;
  if (emission === null) {
    const before = report(projection);
    if (deliveryBlockingGates(before).length === 0) {
      emission = emitFinal
        ? emitFinal(before)
        : emitFinalMml(project, machineDeliveryEmitOptions(before, { releaseEvidenceRegistry, canonical }));
      // An emission that returned nothing has not shown an emitted Final.
      emission ??= Object.freeze({ status: null, diagnostics: Object.freeze([]) });
    }
  }
  return report(emission === null ? projection : evaluateMachineDelivery(gates, { canonical, finalEmission: emission }));
}

const READINESS_NOTICE = 'Module availability never certifies a song. Candidate readiness requires source completeness plus a real Source-Faithful Baseline snapshot whose event-level diff is computed against the candidate, an independent Gate 4 result for Core3 musical completeness that a clean source-continuity audit never supplies, evidence-backed review of any Lead removals/demotions and Lead additions/promotions, a source-aware micro-timing result with no confirmed technical residue and no unresolved sub-grid interval, audio/arbitration/technical/player evidence, an explicit evidence-backed Mobile adaptation review, and an explicit evidence-backed regression review. Named historical regressions without reproducible fixtures remain FIXTURE_PENDING and are never claimed as passed. finalAccepted additionally requires in-game acceptance.';
