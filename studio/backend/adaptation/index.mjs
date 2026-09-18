// Mobile Adaptation v1 implements Gate 8 transformations, never its verdict.
// A profile is a song/target-specific, cited input, NOT an instrument database
// or a new Canonical rule. No pitch folding, clipping, deletion or role moves.
import { createCanonicalProject, createCanonicalNoteEvent, createArbitrationDecision } from '../canonical/index.mjs';
import { f, ROLES } from '../mml/index.mjs';
import { EFFECTIVE_RULESET } from '../rules/index.mjs';
import { canonicalIdentity } from '../final/emitter-contract.mjs';
import { compareCanonicalVersions } from '../compare/version-drift.mjs';
import { analyzeCrossSourceHarmony } from '../arbitration/harmony.mjs';
import { baselineIdentityOf, candidateDigestOf, contentDigest, createArrangementRevision } from '../arrangement/decision-application.mjs';
import { applicationIntegrity, baselineOriginResolver } from '../arrangement/decision-review.mjs';

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

// Same-source doubling must also be visible. The existing harmony gate only
// answers cross-source arbitration. Sustain overlaps use exact rational beats.
function collisions(project) {
  const groups = new Map();
  for (const event of project.events.filter(e => e.kind === 'note')) {
    const group = groups.get(event.pitch) ?? [];
    group.push({ event, start: f(event.start), end: f(event.end) });
    groups.set(event.pitch, group);
  }
  const result = [];
  for (const group of groups.values()) {
    group.sort((a, b) => a.start.cmp(b.start) || compareStrings(a.event.id, b.event.id));
    let active = [];
    for (const current of group) {
      active = active.filter(other => other.end.cmp(current.start) > 0);
      for (const other of active) result.push({ kind: 'same-pitch-overlap', eventIds: [other.event.id, current.event.id].sort(), pitch: current.event.pitch });
      active.push(current);
    }
  }
  return result;
}
function risks(project) {
  return [...collisions(project), ...analyzeCrossSourceHarmony(project).conflicts
    .filter(conflict => conflict.kind !== 'cross-source-same-pitch')
    .map(conflict => ({ kind: conflict.kind, eventIds: [conflict.leftEventId, conflict.rightEventId].sort(), interval: conflict.intervalSemitones }))]
    .sort((a, b) => compareStrings(riskKey(a), riskKey(b)));
}
const riskKey = risk => JSON.stringify([risk.kind, risk.eventIds, risk.pitch ?? null, risk.interval ?? null]);
const sortedEvents = events => [...events].sort((a, b) => compareStrings(a.id, b.id));
const targetDigest = (project, profile) => contentDigest(sortedEvents(project.events.filter(event => event.kind === 'note' && Object.hasOwn(profile.roles, event.role))));

// Bound collision-report allocation for pathological dense inputs. Reaching
// this implementation limit is PENDING, never a claim of collision freedom.
function collisionBudgetExceeded(notes) {
  const spans = notes.map(event => ({ start: f(event.start), end: f(event.end) })).sort((a, b) => a.start.cmp(b.start));
  let active = [], pairs = 0;
  for (const span of spans) {
    active = active.filter(end => end.cmp(span.start) > 0);
    pairs += active.length;
    if (pairs > 50000) return true;
    active.push(span.end);
  }
  return false;
}

/** Read-only deterministic plan. PASS means executable, never Gate 8 PASS. */
export function planMobileAdaptation({ baseline, candidate = baseline, profile }) {
  const normalized = normalizeMobileProfile(profile);
  if (!baseline?.events || !candidate?.events) throw Error('Mobile adaptation requires a Source-Faithful Baseline and a Canonical candidate');
  const baselineIdentity = baselineIdentityOf(baseline);
  const inputDigest = candidateDigestOf(candidate);
  const profileDigest = contentDigest(normalized);
  const blockers = [], warnings = [], changes = [], rolePlans = [];
  const alreadyApplied = candidate.metadata?.mobileAdaptation?.profileDigest === profileDigest;
  if (alreadyApplied && candidate.metadata.mobileAdaptation.targetDigest !== targetDigest(candidate, normalized)) blockers.push({ code: 'MOBILE_PROFILE_CONTEXT_CHANGED' });
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
  for (const [role, rule] of Object.entries(normalized.roles)) {
    const events = notes.filter(event => event.role === role);
    if (!events.length) { warnings.push({ code: 'EMPTY_ROLE_UNCHANGED', role }); continue; }
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
    rolePlans.push({ role, semitones: shift, volumeDelta: alreadyApplied ? 0 : (rule.volumeDelta ?? 0), noteCount: events.length });
    for (const event of events) {
      const pitch = event.pitch + shift;
      let volume = event.volume;
      if (!alreadyApplied && (rule.volumeDelta !== undefined || rule.defaultVolume !== undefined)) {
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
  // Existing Lead re-review binds musical identity to the source event. It
  // cannot yet answer a moved Lead whose pitch/volume also changed. Refuse
  // that combination before minting a candidate with an uncleareable gate.
  for (const change of changes) {
    const origin = origins.get(change.eventId);
    if (origin && origin.role !== change.role && [origin.role, change.role].includes('Melody')) blockers.push({ code: 'LEAD_ROLE_ADAPTATION_REVIEW_UNSUPPORTED', eventId: change.eventId });
  }
  const proposed = { ...candidate, events: candidate.events.map(event => byId.has(event.id) ? { ...event, ...byId.get(event.id).after } : event) };
  for (const event of proposed.events.filter(e => e.kind === 'note')) if (event.pitch < syntax.numericNoteMin || event.pitch > syntax.numericNoteMax) blockers.push({ code: 'PITCH_OUTSIDE_MOBILE_RANGE', eventId: event.id, pitch: event.pitch });
  const scanLimited = collisionBudgetExceeded(notes);
  if (scanLimited) blockers.push({ code: 'COLLISION_SCAN_LIMIT', maxOverlappingPairs: 50000 });
  const beforeRisks = scanLimited ? [] : risks(candidate), afterRisks = scanLimited ? [] : risks(proposed);
  const existing = new Set(beforeRisks.map(riskKey));
  const introduced = afterRisks.filter(risk => !existing.has(riskKey(risk)));
  for (const risk of introduced) blockers.push({ code: 'NEW_COLLISION_REQUIRES_REVIEW', ...risk });
  if (beforeRisks.length) warnings.push({ code: 'EXISTING_COLLISIONS_REQUIRE_REVIEW', count: beforeRisks.length });
  const body = { schema: 'mml-studio/mobile-adaptation-plan@1', baselineIdentity, inputDigest, profileDigest, profile: normalized, canonicalIdentity: canonicalIdentity(), rolePlans, changes, blockers, warnings, collisions: { before: beforeRisks, after: afterRisks, introduced, scanLimited }, status: blockers.length ? 'PENDING' : 'PASS' };
  return { ...body, id: `mobile:plan:${contentDigest(body)}`, certifiesGates: [], notice: 'An executable adaptation plan, not a Mobile acceptance verdict. Evidence references are caller-supplied, not independently authenticated.' };
}

/** Atomic application; recomputes the plan and refuses stale preview identities. */
export function applyMobileAdaptation({ baseline, candidate = baseline, parent = null, profile, expectedPlanId, acceptedBy }) {
  if (!string(acceptedBy) || acceptedBy.length > 120) throw Error('acceptedBy is required');
  if (!string(expectedPlanId)) throw Error('expectedPlanId from the preview is required');
  if (parent && (!applicationIntegrity(parent, baseline).ok || candidateDigestOf(candidate) !== parent.revision.candidateDigest)) throw Error('Mobile adaptation parent integrity mismatch');
  if (parent && parent.revision.canonicalIdentity?.rules_snapshot_sha !== canonicalIdentity().rules_snapshot_sha) throw Error('Mobile adaptation parent Canonical snapshot mismatch');
  const plan = planMobileAdaptation({ baseline, candidate, profile });
  if (plan.id !== expectedPlanId) return { applied: false, status: 'PENDING', candidate: null, revision: null, plan, blockers: [{ code: 'STALE_MOBILE_ADAPTATION_PLAN' }] };
  if (plan.blockers.length || !plan.changes.length) return { applied: false, status: plan.status, candidate: null, revision: null, plan, blockers: plan.blockers, unchanged: !plan.blockers.length };
  const changed = new Map(plan.changes.map(change => [change.eventId, change]));
  const metadata = structuredClone(candidate.metadata ?? {});
  for (const key of ['sourceComplete', 'audioAlignmentEvidence', 'sourceFaithfulBaseline', 'g11d', 'incompleteInputs']) delete metadata[key];
  const snapshot = structuredClone(baseline);
  delete snapshot.metadata.sourceFaithfulBaseline;
  delete snapshot.metadata.g11d;
  const index = (parent?.revision.index ?? 0) + 1;
  const outputEvents = candidate.events.map(event => changed.has(event.id) ? createCanonicalNoteEvent({ ...event, ...changed.get(event.id).after }) : structuredClone(event));
  const adapted = createCanonicalProject({ ...candidate, id: `${baseline.id}#mobile-r${index}`,
    events: outputEvents,
    // A changed context can invalidate even a pair whose notes did not move.
    // Re-open accepted arbitration rather than carry any verdict into the revision.
    decisions: candidate.decisions.map(decision => createArbitrationDecision({ ...decision, status: decision.status === 'accepted' ? 'pending' : decision.status })),
    metadata: { ...metadata, sourceFaithfulBaseline: { snapshot }, mobileAdaptation: { planId: plan.id, profileDigest: plan.profileDigest, targetDigest: targetDigest({ events: outputEvents }, plan.profile), profile: plan.profile, inputDigest: plan.inputDigest, acceptedBy: acceptedBy.trim(), changes: plan.changes, certifiesGates: [] } },
  });
  const revision = createArrangementRevision({ stage: 'MOBILE_ADAPTATION_V1', index, parentRevisionId: parent?.revision.id ?? null, baselineIdentity: plan.baselineIdentity, parentCandidateIdentity: parent ? baselineIdentityOf(candidate) : null, decisionSetDigest: contentDigest({ planId: plan.id, acceptedBy: acceptedBy.trim() }), canonicalIdentity: plan.canonicalIdentity, candidateDigest: candidateDigestOf(adapted) });
  const output = createCanonicalProject({ ...adapted, metadata: { ...adapted.metadata, g11d: { revision, certifiesGates: [] } } });
  // Check invariants on the output, not just the intended edits.
  for (let i = 0; i < candidate.events.length; i++) {
    const before = candidate.events[i], after = output.events[i];
    const { pitch: p1, volume: v1, ...original } = before, { pitch: p2, volume: v2, ...result } = after;
    if (contentDigest(original) !== contentDigest(result)) throw Error('Mobile adaptation changed event identity, timing, role or provenance');
    if (before.kind === 'note' && (p2 - p1) % 12 !== 0) throw Error('Mobile adaptation changed pitch class');
  }
  return { schema: 'mml-studio/mobile-adaptation-application@1', stage: 'MOBILE_ADAPTATION_V1', status: 'PASS', applied: [], didApply: true, candidate: output, revision, plan, trace: plan.changes, rejected: [], conflicts: [], diagnostics: plan.warnings, diffFromBaseline: compareCanonicalVersions(baseline, output), diffFromParent: compareCanonicalVersions(candidate, output), certifiesGates: [], notice: 'Adaptation applied. Re-run review and Final validation; no acceptance gate is certified.' };
}
