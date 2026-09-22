// Mobile Adaptation v1 implements Gate 8 transformations, never its verdict.
// A profile is a song/target-specific, cited input, NOT an instrument database
// or a new Canonical rule. No pitch folding, clipping, deletion or role moves.
//
// Release representation is the one timing transformation this stage performs,
// and it needs no profile: a note release no admitted Final token can express
// (canonical/release-timing.mjs) is moved to an adjacent 1/64 grid point only
// by an explicit decision whose evidence a human reviewer attests from an
// independent primary source. The Source-Faithful release stays on the baseline
// and on the event's record; onsets, pitches, roles and event identities never
// move, and no tie, merge or deletion is ever introduced.
import { createCanonicalProject, createCanonicalNoteEvent, createArbitrationDecision } from '../canonical/index.mjs';
import { ROLES } from '../mml/index.mjs';
import { EFFECTIVE_RULESET } from '../rules/index.mjs';
import { canonicalIdentity } from '../final/emitter-contract.mjs';
import { compareCanonicalVersions } from '../compare/version-drift.mjs';
import { overlapRisks, overlapRiskKey, overlapPairBudgetExceeded, OVERLAP_PAIR_BUDGET } from '../arbitration/harmony.mjs';
import { baselineIdentityOf, candidateDigestOf, contentDigest, createArrangementRevision } from '../arrangement/decision-application.mjs';
import { applicationIntegrity, baselineOriginResolver } from '../arrangement/decision-review.mjs';
import {
  RELEASE_RECORD_KEY,
  analyzeReleaseTiming,
  buildEvidenceRegistry,
  planReleaseRepresentation,
  releaseRecordFor,
  summarizeReleaseTiming,
} from '../canonical/release-timing.mjs';

export const MOBILE_ADAPTATION_SCHEMA = 'mml-studio/mobile-adaptation-profile@1';
const syntax = EFFECTIVE_RULESET.mobileSyntax;
const plain = value => value && typeof value === 'object' && !Array.isArray(value);
const compareStrings = (a, b) => a < b ? -1 : a > b ? 1 : 0;
const string = value => typeof value === 'string' && value.trim().length > 0;
function keys(value, allowed, name) {
  if (!plain(value)) throw Error(`${name} must be an object`);
  for (const key of Object.keys(value)) if (!allowed.includes(key)) throw Error(`${name}.${key} is unsupported`);
}
function integer(value, min, max, name) {
  if (!Number.isInteger(value) || value < min || value > max) throw Error(`${name} must be an integer from ${min} to ${max}`);
  return value;
}

export function normalizeMobileProfile(input) {
  keys(input, ['schema', 'id', 'reason', 'evidence', 'roles'], 'profile');
  if (input.schema !== MOBILE_ADAPTATION_SCHEMA) throw Error('unsupported Mobile profile schema');
  if (!string(input.id) || input.id.length > 120 || !string(input.reason) || input.reason.length > 2000) throw Error('profile id and reason are required');
  if (!Array.isArray(input.evidence) || !input.evidence.length || input.evidence.length > 50 || input.evidence.some(ref => !string(ref) || ref.length > 1000)) throw Error('profile requires evidence references for the target register/volume settings');
  keys(input.roles, ROLES, 'profile.roles');
  if (!Object.keys(input.roles).length) throw Error('profile.roles must specify at least one role');
  const roles = {};
  for (const role of ROLES) {
    if (!Object.hasOwn(input.roles, role)) continue;
    const rule = input.roles[role];
    keys(rule, ['pitchRange', 'volumeDelta', 'defaultVolume'], `profile.roles.${role}`);
    if (!Object.keys(rule).length) throw Error(`${role} requires a register or volume rule`);
    const normalized = {};
    if (rule.pitchRange !== undefined) {
      if (!Array.isArray(rule.pitchRange) || rule.pitchRange.length !== 2) throw Error(`${role}.pitchRange must be [min, max]`);
      const [min, max] = rule.pitchRange.map(n => integer(n, syntax.numericNoteMin, syntax.numericNoteMax, `${role}.pitchRange`));
      if (min > max) throw Error(`${role}.pitchRange min exceeds max`);
      normalized.pitchRange = [min, max];
    }
    if (rule.volumeDelta !== undefined) normalized.volumeDelta = integer(rule.volumeDelta, -15, 15, `${role}.volumeDelta`);
    if (rule.defaultVolume !== undefined) normalized.defaultVolume = integer(rule.defaultVolume, syntax.volumeMin, syntax.volumeMax, `${role}.defaultVolume`);
    roles[role] = normalized;
  }
  return { schema: MOBILE_ADAPTATION_SCHEMA, id: input.id.trim(), reason: input.reason.trim(), evidence: [...new Set(input.evidence.map(ref => ref.trim()))].sort(), roles };
}

// What this transformation itself can create, scanned on the candidate before
// and after so only a *newly* introduced pair blocks. The sweep itself lives
// beside the existing cross-source harmony gate in `arbitration/harmony.mjs`,
// so this stage and the Final Six-Role Reduction read one implementation of
// the reviewed interval set rather than each carrying a copy.
const sortedEvents = events => [...events].sort((a, b) => compareStrings(a.id, b.id));
const targetDigest = (project, profile) => contentDigest(sortedEvents(project.events.filter(event => event.kind === 'note' && Object.hasOwn(profile.roles, event.role))));
// The one role's own notes, so the repeat guard below is keyed per role instead
// of on the whole profile envelope.
const roleTargetDigest = (events, role) => contentDigest(sortedEvents(events.filter(event => event.kind === 'note' && event.role === role)));
// What this candidate now carries per role: the rule digest that produced it and
// the notes it produced. Roles a later profile leaves alone keep their recorded
// rule, so a profile that adds one role cannot re-offset the others.
const mergedRoleRecord = (priorRoles, roles, events) => {
  const merged = {};
  for (const [role, entry] of Object.entries(plain(priorRoles) ? priorRoles : {})) if (ROLES.includes(role) && string(entry?.rule)) merged[role] = { rule: entry.rule, target: roleTargetDigest(events, role) };
  for (const [role, rule] of Object.entries(roles)) merged[role] = { rule: contentDigest(rule), target: roleTargetDigest(events, role) };
  return merged;
};

/**
 * Read-only deterministic plan. PASS means executable, never Gate 8 PASS.
 *
 * `leadBoundEventIds` are the candidate events whose musical identity a
 * recoverable Lead evidence report is re-checked against. Comparing baseline and
 * candidate roles here cannot find all of them: a revision lineage that promotes
 * an event into Melody and a later one that moves it back leaves the two roles
 * equal while the demotion record — and its identity check — survives. The
 * caller that can read the lineage supplies them; a plane without one (the local
 * Web workspace) has no lineage to lose and passes none.
 */
export function planMobileAdaptation({ baseline, candidate = baseline, profile = null, releaseRepresentation = null, evidenceSources = null, leadBoundEventIds = [] }) {
  if ((profile === null || profile === undefined) && (releaseRepresentation === null || releaseRepresentation === undefined)) {
    throw Error('Mobile adaptation requires a cited target profile, release representation decisions, or both');
  }
  // A missing profile is not an empty one: no register or volume rule is
  // invented, and only the release representation below runs.
  const normalized = profile === null || profile === undefined ? null : normalizeMobileProfile(profile);
  if (!baseline?.events || !candidate?.events) throw Error('Mobile adaptation requires a Source-Faithful Baseline and a Canonical candidate');
  const baselineIdentity = baselineIdentityOf(baseline);
  const inputDigest = candidateDigestOf(candidate);
  const profileDigest = normalized ? contentDigest(normalized) : null;
  const profileRoles = normalized?.roles ?? {};
  const blockers = [], warnings = [], changes = [], rolePlans = [];
  const leadBound = new Set(Array.isArray(leadBoundEventIds) ? leadBoundEventIds.filter(string) : []);
  // The transformation already in this candidate, recorded per role. Keying the
  // repeat guard on the role's own rule and notes -- not on the profile envelope
  // -- is what stops a re-titled profile, a new `reason` line or an added second
  // role from quietly applying the same relative offset a second time.
  const prior = candidate.metadata?.mobileAdaptation ?? null;
  const priorRoles = plain(prior?.appliedRoles) ? prior.appliedRoles : null;
  // Revisions minted before the per-role record keyed it on the whole profile.
  const legacyApplied = Boolean(normalized) && !priorRoles && prior?.profileDigest === profileDigest;
  if (legacyApplied && prior.targetDigest !== targetDigest(candidate, normalized)) blockers.push({ code: 'MOBILE_PROFILE_CONTEXT_CHANGED' });
  const notes = sortedEvents(candidate.events.filter(event => event.kind === 'note'));
  const origins = new Map();
  const resolveOrigin = baselineOriginResolver(baseline, candidate);
  for (const event of notes) {
    const origin = resolveOrigin(event.id);
    origins.set(event.id, origin);
    if (!origin || contentDigest([event.sourceIds, event.sourceEventIds]) !== contentDigest([origin.sourceIds, origin.sourceEventIds])) blockers.push({ code: 'SOURCE_EVENT_NOT_TRACEABLE', eventId: event.id });
    if (!ROLES.includes(event.role)) blockers.push({ code: 'ROLE_ASSIGNMENT_REQUIRED', eventId: event.id });
    if (event.metadata?.channel === 9 || event.metadata?.percussion === true || event.tags?.includes('percussion')) blockers.push({ code: 'DRUM_FACE_MAPPING_REQUIRED', eventId: event.id });
  }
  // Velocity is deliberately not interpreted as Mobile volume. A caller may
  // supply an evidence-backed default for undecided notes; it stays explicit.
  for (const [role, rule] of Object.entries(profileRoles)) {
    const events = notes.filter(event => event.role === role);
    if (!events.length) { warnings.push({ code: 'EMPTY_ROLE_UNCHANGED', role }); continue; }
    const recorded = priorRoles?.[role] ?? null;
    const settled = legacyApplied || (recorded?.rule === contentDigest(rule));
    // Recorded as applied, but the notes it was applied to have moved since: the
    // offset is no longer a statement about this material. Reconsider it rather
    // than either re-adding it or treating the old one as still decided.
    if (!legacyApplied && settled && recorded.target !== roleTargetDigest(candidate.events, role)) blockers.push({ code: 'MOBILE_PROFILE_CONTEXT_CHANGED', role });
    let shift = 0;
    if (rule.pitchRange) {
      const low = Math.min(...events.map(e => e.pitch)), high = Math.max(...events.map(e => e.pitch));
      const [min, max] = rule.pitchRange;
      const shifts = [];
      for (let octave = -10; octave <= 10; octave++) if (low + 12 * octave >= min && high + 12 * octave <= max) shifts.push(12 * octave);
      shifts.sort((a, b) => Math.abs(a) - Math.abs(b) || a - b);
      if (!shifts.length) blockers.push({ code: 'REGISTER_REQUIRES_PHRASE_REVIEW', role, sourceRange: [low, high], targetRange: rule.pitchRange });
      else shift = shifts[0];
    }
    rolePlans.push({ role, semitones: shift, volumeDelta: settled ? 0 : (rule.volumeDelta ?? 0), noteCount: events.length });
    for (const event of events) {
      const pitch = event.pitch + shift;
      let volume = event.volume;
      if (!settled && (rule.volumeDelta !== undefined || rule.defaultVolume !== undefined)) {
        if (volume === null) {
          if (rule.defaultVolume === undefined) blockers.push({ code: 'VOLUME_REFERENCE_REQUIRED', role, eventId: event.id });
          else volume = rule.defaultVolume;
        }
        if (volume !== null) volume += rule.volumeDelta ?? 0;
        if (volume !== null && (volume < syntax.volumeMin || volume > syntax.volumeMax)) blockers.push({ code: 'VOLUME_WOULD_CLIP', role, eventId: event.id, requestedVolume: volume });
      }
      if (pitch !== event.pitch || volume !== event.volume) changes.push({ eventId: event.id, role, before: { pitch: event.pitch, volume: event.volume }, after: { pitch, volume }, reason: normalized.reason, evidence: normalized.evidence });
    }
  }
  const byId = new Map(changes.map(change => [change.eventId, change]));
  // Existing Lead re-review binds musical identity to the source event: it
  // cannot answer an event whose pitch or volume changed under the citation, and
  // a fresh candidate-bound review cannot either, because the identity check runs
  // before the grade. Refuse that combination -- whether this candidate shows the
  // Lead move in its own roles, or only the supplied lineage still records it --
  // before minting a candidate with a gate nothing can clear.
  for (const change of changes) {
    const origin = origins.get(change.eventId);
    const movedLead = origin && origin.role !== change.role && [origin.role, change.role].includes('Melody');
    if (movedLead || leadBound.has(change.eventId)) blockers.push({ code: 'LEAD_ROLE_ADAPTATION_REVIEW_UNSUPPORTED', eventId: change.eventId, fromRole: origin?.role ?? null, toRole: change.role, boundBy: movedLead ? 'baseline-role-move' : 'lead-evidence-lineage' });
  }
  // Release representation (Layer C). Analysis and evidence grading live in
  // canonical/release-timing.mjs; this stage only turns admissible decisions into
  // candidate edits. A release change on a Lead-bound event is allowed: the Lead
  // evidence binding re-reads the event through its recorded source release
  // (`sourceIdentityOf`), so a represented release is not a different source
  // event, while a pitch or volume change above still is.
  const releaseAnalysis = analyzeReleaseTiming({ candidate, baseline });
  const priorRelease = plain(prior?.releaseRepresentation) ? prior.releaseRepresentation : null;
  const priorDecisionIds = new Set((Array.isArray(priorRelease?.decisions) ? priorRelease.decisions : []).map(decision => decision?.id).filter(string));
  const registry = buildEvidenceRegistry(evidenceSources ?? { sources: candidate.sources ?? [] });
  const releasePlan = planReleaseRepresentation({ analysis: releaseAnalysis, input: releaseRepresentation, registry });
  for (const blocker of releasePlan.blockers) blockers.push({ ...blocker });
  // A decision whose evidence does not count moves nothing and is never silent.
  // Alongside decisions that do count it is a warning; on its own it is the
  // reason nothing can be applied.
  for (const item of releasePlan.pending) warnings.push({ code: 'RELEASE_DECISION_EVIDENCE_NOT_ADMISSIBLE', decisionId: item.decisionId, reasons: [...item.reasons] });
  if (releasePlan.pending.length && !releasePlan.changes.length && !Object.keys(profileRoles).length) {
    blockers.push({ code: 'RELEASE_DECISION_EVIDENCE_NOT_ADMISSIBLE', decisionIds: releasePlan.pending.map(item => item.decisionId), reasons: [...new Set(releasePlan.pending.flatMap(item => item.reasons))] });
  }
  for (const decision of releasePlan.decisions) if (priorDecisionIds.has(decision.id)) blockers.push({ code: 'RELEASE_DECISION_ID_ALREADY_APPLIED', decisionId: decision.id });
  const releaseById = new Map(releasePlan.changes.map(change => [change.eventId, change]));
  const proposed = { ...candidate, events: candidate.events.map(event => {
    const edited = byId.has(event.id) ? { ...event, ...byId.get(event.id).after } : event;
    return releaseById.has(event.id) ? { ...edited, end: releaseById.get(event.id).after.end } : edited;
  }) };
  // A note this plan moves must land inside the Published Canonical range. A
  // note already outside it that this plan does not move is inherited, not
  // introduced: it stays a visible warning for the existing technical/Final
  // gates that refuse it, instead of making every other role unadaptable.
  for (const event of proposed.events.filter(e => e.kind === 'note')) {
    if (event.pitch >= syntax.numericNoteMin && event.pitch <= syntax.numericNoteMax) continue;
    const moved = byId.get(event.id)?.after.pitch !== byId.get(event.id)?.before.pitch;
    if (moved) blockers.push({ code: 'PITCH_OUTSIDE_MOBILE_RANGE', eventId: event.id, pitch: event.pitch });
    else warnings.push({ code: 'EXISTING_PITCH_OUTSIDE_MOBILE_RANGE', eventId: event.id, pitch: event.pitch });
  }
  const scanLimited = overlapPairBudgetExceeded(notes);
  if (scanLimited) blockers.push({ code: 'COLLISION_SCAN_LIMIT', maxOverlappingPairs: OVERLAP_PAIR_BUDGET });
  const beforeRisks = scanLimited ? [] : overlapRisks(candidate), afterRisks = scanLimited ? [] : overlapRisks(proposed);
  const existing = new Set(beforeRisks.map(overlapRiskKey));
  const introduced = afterRisks.filter(risk => !existing.has(overlapRiskKey(risk)));
  for (const risk of introduced) blockers.push({ code: 'NEW_COLLISION_REQUIRES_REVIEW', ...risk });
  if (beforeRisks.length) warnings.push({ code: 'EXISTING_COLLISIONS_REQUIRE_REVIEW', count: beforeRisks.length });
  const releaseBody = {
    summary: summarizeReleaseTiming(releaseAnalysis),
    analysisDigest: contentDigest(releaseAnalysis.targets),
    decisions: releasePlan.decisions,
    changes: releasePlan.changes,
    pending: releasePlan.pending,
    unresolvedTargetCount: releasePlan.unresolvedTargetCount,
  };
  const body = { schema: 'mml-studio/mobile-adaptation-plan@1', baselineIdentity, inputDigest, profileDigest, profile: normalized, canonicalIdentity: canonicalIdentity(), leadBoundEventIds: [...leadBound].sort(compareStrings), rolePlans, changes, releaseRepresentation: releaseBody, blockers, warnings, collisions: { before: beforeRisks, after: afterRisks, introduced, scanLimited }, status: blockers.length ? 'PENDING' : 'PASS' };
  return {
    ...body,
    id: `mobile:plan:${contentDigest(body)}`,
    // The full per-release analysis (Layer A/B) for a reviewer. It is derived
    // from the candidate and is not part of the plan identity or of any stored
    // revision; the summary and its digest are.
    releaseTiming: releaseAnalysis,
    // What still needs a target profile. Nothing here guesses one.
    profileRequirement: normalized ? null : {
      status: 'NOT_SUPPLIED',
      requiredFor: ['register (pitchRange) adaptation per role', 'Mobile volume / prominence re-arbitration (defaultVolume, volumeDelta)'],
      notice: 'No register or volume adaptation was attempted. A Mobile target profile must be supplied by a caller with its own reason and evidence; release representation does not depend on it.',
    },
    certifiesGates: [],
    notice: 'An executable adaptation plan, not a Mobile acceptance verdict. Evidence references are caller-supplied, not independently authenticated; release representation evidence counts only as a human reviewer attestation of an independent primary source.',
  };
}

/** Atomic application; recomputes the plan and refuses stale preview identities. */
export function applyMobileAdaptation({ baseline, candidate = baseline, parent = null, profile = null, releaseRepresentation = null, evidenceSources = null, expectedPlanId, acceptedBy, leadBoundEventIds = [] }) {
  if (!string(acceptedBy) || acceptedBy.length > 120) throw Error('acceptedBy is required');
  if (!string(expectedPlanId)) throw Error('expectedPlanId from the preview is required');
  if (parent && (!applicationIntegrity(parent, baseline).ok || candidateDigestOf(candidate) !== parent.revision.candidateDigest)) throw Error('Mobile adaptation parent integrity mismatch');
  if (parent && parent.revision.canonicalIdentity?.rules_snapshot_sha !== canonicalIdentity().rules_snapshot_sha) throw Error('Mobile adaptation parent Canonical snapshot mismatch');
  const { releaseTiming: _analysis, ...plan } = planMobileAdaptation({ baseline, candidate, profile, releaseRepresentation, evidenceSources, leadBoundEventIds });
  if (plan.id !== expectedPlanId) return { applied: false, status: 'PENDING', candidate: null, revision: null, plan, blockers: [{ code: 'STALE_MOBILE_ADAPTATION_PLAN' }] };
  const releaseChanges = plan.releaseRepresentation.changes;
  if (plan.blockers.length || (!plan.changes.length && !releaseChanges.length)) return { applied: false, status: plan.status, candidate: null, revision: null, plan, blockers: plan.blockers, unchanged: !plan.blockers.length };
  const changed = new Map(plan.changes.map(change => [change.eventId, change]));
  const releaseChanged = new Map(releaseChanges.map(change => [change.eventId, change]));
  const priorAdaptation = candidate.metadata?.mobileAdaptation ?? null;
  const priorRelease = plain(priorAdaptation?.releaseRepresentation) ? priorAdaptation.releaseRepresentation : { decisions: [], changes: [] };
  const appliedDecisionIds = new Set(releaseChanges.map(change => change.decisionId));
  const metadata = structuredClone(candidate.metadata ?? {});
  for (const key of ['sourceComplete', 'audioAlignmentEvidence', 'sourceFaithfulBaseline', 'g11d', 'incompleteInputs']) delete metadata[key];
  const snapshot = structuredClone(baseline);
  delete snapshot.metadata.sourceFaithfulBaseline;
  delete snapshot.metadata.g11d;
  const index = (parent?.revision.index ?? 0) + 1;
  const outputEvents = candidate.events.map(event => {
    if (!changed.has(event.id) && !releaseChanged.has(event.id)) return structuredClone(event);
    const edited = changed.has(event.id) ? { ...event, ...changed.get(event.id).after } : { ...event };
    if (!releaseChanged.has(event.id)) return createCanonicalNoteEvent(edited);
    const release = releaseChanged.get(event.id);
    return createCanonicalNoteEvent({ ...edited, end: release.after.end, metadata: { ...(event.metadata ?? {}), [RELEASE_RECORD_KEY]: releaseRecordFor(release) } });
  });
  // The profile a release-only adaptation leaves in force is the one already
  // recorded; it is carried, never re-applied.
  const effectiveProfile = plan.profile ?? priorAdaptation?.profile ?? null;
  const adapted = createCanonicalProject({ ...candidate, id: `${baseline.id}#mobile-r${index}`,
    events: outputEvents,
    // A changed context can invalidate even a pair whose notes did not move.
    // Re-open accepted arbitration rather than carry any verdict into the revision.
    decisions: candidate.decisions.map(decision => createArbitrationDecision({ ...decision, status: decision.status === 'accepted' ? 'pending' : decision.status })),
    metadata: { ...metadata, sourceFaithfulBaseline: { snapshot }, mobileAdaptation: { planId: plan.id, profileDigest: plan.profileDigest ?? priorAdaptation?.profileDigest ?? null,
      targetDigest: effectiveProfile ? targetDigest({ events: outputEvents }, effectiveProfile) : null,
      appliedRoles: mergedRoleRecord(priorAdaptation?.appliedRoles, plan.profile?.roles ?? {}, outputEvents),
      profile: effectiveProfile, inputDigest: plan.inputDigest, acceptedBy: acceptedBy.trim(), changes: plan.changes,
      // Every decision a recorded release representation names stays stored,
      // across revisions, so the micro-timing gate can re-grade it from the
      // project alone (canonical/release-timing.mjs#verifyReleaseRepresentation).
      releaseRepresentation: {
        decisions: [...(priorRelease.decisions ?? []), ...plan.releaseRepresentation.decisions.filter(decision => appliedDecisionIds.has(decision.id))],
        changes: [...(priorRelease.changes ?? []), ...releaseChanges],
      },
      certifiesGates: [] } },
  });
  const revision = createArrangementRevision({ stage: 'MOBILE_ADAPTATION_V1', index, parentRevisionId: parent?.revision.id ?? null, baselineIdentity: plan.baselineIdentity, parentCandidateIdentity: parent ? baselineIdentityOf(candidate) : null, decisionSetDigest: contentDigest({ planId: plan.id, acceptedBy: acceptedBy.trim() }), canonicalIdentity: plan.canonicalIdentity, candidateDigest: candidateDigestOf(adapted) });
  const output = createCanonicalProject({ ...adapted, metadata: { ...adapted.metadata, g11d: { revision, certifiesGates: [] } } });
  // Check invariants on the output, not just the intended edits. A release moves
  // only where a planned, admissible decision moved it, and only to the planned
  // grid point; onset, identity, role and provenance never move.
  for (let i = 0; i < candidate.events.length; i++) {
    const before = candidate.events[i], after = output.events[i];
    const release = releaseChanged.get(before.id);
    const strip = ({ pitch, volume, end, metadata, ...rest }) => rest;
    if (contentDigest(strip(before)) !== contentDigest(strip(after))) throw Error('Mobile adaptation changed event identity, onset, role or provenance');
    if (release) {
      if (String(after.end) !== release.after.end || String(before.end) !== release.before.end) throw Error('Mobile adaptation moved a release other than as planned');
      const { [RELEASE_RECORD_KEY]: _record, ...restMetadata } = after.metadata ?? {};
      if (contentDigest(restMetadata) !== contentDigest(before.metadata ?? {})) throw Error('Mobile adaptation changed event metadata beyond the release record');
    } else if (String(before.end) !== String(after.end) || contentDigest(before.metadata ?? {}) !== contentDigest(after.metadata ?? {})) {
      throw Error('Mobile adaptation changed event identity, timing, role or provenance');
    }
    if (before.kind === 'note' && (after.pitch - before.pitch) % 12 !== 0) throw Error('Mobile adaptation changed pitch class');
  }
  return { schema: 'mml-studio/mobile-adaptation-application@1', stage: 'MOBILE_ADAPTATION_V1', status: 'PASS', applied: [], didApply: true, candidate: output, revision, plan, trace: [...plan.changes, ...releaseChanges], rejected: [], conflicts: [], diagnostics: plan.warnings, diffFromBaseline: compareCanonicalVersions(baseline, output), diffFromParent: compareCanonicalVersions(candidate, output), certifiesGates: [], notice: 'Adaptation applied. Re-run review and Final validation; no acceptance gate is certified.' };
}
