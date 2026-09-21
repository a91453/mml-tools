// Diagnostic-only 7->6 merge analysis adapted from the user's historical frontend.
//
// This module intentionally does NOT perform a reduction. The historical frontend
// could clear the source track after trying a merge and merely report dropped /
// trimmed notes. Published Canonical forbids that as an automatic reduction path:
// source-supported material must remain traceable and no metric may silently erase
// music. Here the useful part of that older workflow is retained as read-only
// evidence for a reviewer:
//
//   - exact-fit events: can share a target role without changing pitch/onset/duration;
//   - unison-covered events: audibly covered by an existing same-pitch span, but still
//     require an explicit reviewer decision before any omission/deduplication;
//   - collisions: would require truncation/drop/re-voicing in the old editor and are
//     therefore NOT lossless redistribution candidates here.
//
// The output is SUGGESTION_ONLY. It certifies no Canonical gate and mutates nothing.

import { f } from '../mml/index.mjs';

export const LEGACY_MERGE_DIAGNOSTIC_SCHEMA = 'mml-studio/legacy-merge-diagnostic@1';

const CORE3 = new Set(['Melody', 'Chord1', 'Chord2']);
const DEFAULT_ROLES = Object.freeze(['Melody', 'Chord1', 'Chord2', 'Chord3', 'Chord4', 'Chord5']);
const cmpStr = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
const notes = events => (events ?? []).filter(event => event?.kind === 'note');
const byTime = (a, b) => f(a.start).cmp(b.start) || f(a.end).cmp(b.end) || Number(a.pitch) - Number(b.pitch) || cmpStr(String(a.id), String(b.id));
const overlaps = (left, right) => f(left.start).cmp(right.end) < 0 && f(right.start).cmp(left.end) < 0;
const covers = (target, source) => Number(target.pitch) === Number(source.pitch)
  && f(target.start).cmp(source.start) <= 0
  && f(target.end).cmp(source.end) >= 0;

function continuityDistance(source, targetEvents) {
  const ordered = [...targetEvents].sort(byTime);
  let before = null;
  let after = null;
  for (const event of ordered) {
    if (f(event.end).cmp(source.start) <= 0) before = event;
    if (after === null && f(event.start).cmp(source.end) >= 0) after = event;
  }
  const distances = [];
  if (before) distances.push(Math.abs(Number(source.pitch) - Number(before.pitch)));
  if (after) distances.push(Math.abs(Number(source.pitch) - Number(after.pitch)));
  return distances.length ? Math.min(...distances) : null;
}

function inspectEvent(source, targetEvents) {
  const collisions = targetEvents.filter(target => overlaps(source, target));
  const covering = collisions.filter(target => covers(target, source));
  const losslessGap = collisions.length === 0;
  const unisonCovered = covering.length > 0;
  return Object.freeze({
    eventId: source.id,
    losslessGap,
    unisonCovered,
    collisionCount: collisions.length,
    collisionEventIds: Object.freeze(collisions.map(event => event.id).sort(cmpStr)),
    coveringEventIds: Object.freeze(covering.map(event => event.id).sort(cmpStr)),
    continuityDistance: continuityDistance(source, targetEvents),
    // Historical merge modes would trim or drop here. This analyzer never does.
    wouldRequireTrimOrDrop: !losslessGap && !unisonCovered,
  });
}

function rankKey(entry, preferredRole) {
  return [
    entry.wouldRequireTrimOrDropCount,
    -entry.losslessGapCount,
    -entry.unisonCoveredCount,
    entry.role === preferredRole ? 0 : 1,
    CORE3.has(entry.role) ? 1 : 0,
    entry.continuityDistance === null ? Number.MAX_SAFE_INTEGER : entry.continuityDistance,
  ];
}

function compareRank(left, right, preferredRole) {
  const a = rankKey(left, preferredRole);
  const b = rankKey(right, preferredRole);
  for (let i = 0; i < a.length; i += 1) if (a[i] !== b[i]) return a[i] - b[i];
  return cmpStr(left.role, right.role);
}

/**
 * Read-only lane merge diagnostics.
 *
 * sourceEvents: the unresolved / seventh-lane events being considered.
 * candidateEvents: the whole current candidate.
 * preferredRole: optional G11-C role hypothesis; diagnostic only.
 *
 * A role can be fully lossless only when every source event lands in a gap.
 * Same-pitch coverage is deliberately NOT counted as lossless: deduplication is
 * an omission decision under Canonical and still requires review/evidence.
 */
export function analyzeLegacyMergeLane({
  sourceEvents,
  candidateEvents,
  roles = DEFAULT_ROLES,
  preferredRole = null,
} = {}) {
  const source = notes(sourceEvents).slice().sort(byTime);
  const candidate = notes(candidateEvents);
  const normalizedRoles = [...new Set((roles ?? DEFAULT_ROLES).filter(role => DEFAULT_ROLES.includes(role)))];

  const targets = normalizedRoles.map(role => {
    const targetEvents = candidate.filter(event => event.role === role && !source.some(item => item.id === event.id));
    const eventDiagnostics = source.map(event => inspectEvent(event, targetEvents));
    const distances = eventDiagnostics.map(item => item.continuityDistance).filter(Number.isFinite);
    const losslessGapCount = eventDiagnostics.filter(item => item.losslessGap).length;
    const unisonCoveredCount = eventDiagnostics.filter(item => item.unisonCovered).length;
    const wouldRequireTrimOrDropCount = eventDiagnostics.filter(item => item.wouldRequireTrimOrDrop).length;
    return Object.freeze({
      role,
      core3: CORE3.has(role),
      preferredByRoleAnalysis: preferredRole === role,
      sourceEventCount: source.length,
      targetEventCount: targetEvents.length,
      losslessGapCount,
      unisonCoveredCount,
      wouldRequireTrimOrDropCount,
      fullyLossless: source.length > 0 && losslessGapCount === source.length,
      requiresReviewerDecision: unisonCoveredCount > 0 || wouldRequireTrimOrDropCount > 0,
      continuityDistance: distances.length ? Math.min(...distances) : null,
      eventDiagnostics: Object.freeze(eventDiagnostics),
      authority: 'SUGGESTION_ONLY',
    });
  }).sort((a, b) => compareRank(a, b, preferredRole));

  return Object.freeze({
    schema: LEGACY_MERGE_DIAGNOSTIC_SCHEMA,
    authority: 'SUGGESTION_ONLY',
    sourceEventIds: Object.freeze(source.map(event => event.id)),
    preferredRole: DEFAULT_ROLES.includes(preferredRole) ? preferredRole : null,
    targets: Object.freeze(targets),
    certifiesGates: Object.freeze([]),
    mutatesCandidate: false,
    permitsAutomaticOmission: false,
    permitsAutomaticTruncation: false,
    notice: 'Historical frontend merge heuristics were adapted as read-only diagnostics. A lossless gap is a candidate for reviewer redistribution; same-pitch coverage still needs an explicit evidence-backed decision; collisions remain unresolved rather than being trimmed or dropped.',
  });
}

export const LEGACY_MERGE_DIAGNOSTIC_STATUS = Object.freeze({
  historicalFrontendReference: true,
  diagnosticOnly: true,
  sourceEventsRetained: true,
  automaticOmission: false,
  automaticTruncation: false,
  automaticRoleDecision: false,
  certifiesGates: Object.freeze([]),
});
