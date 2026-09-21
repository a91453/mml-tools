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
const maxF = (a, b) => (f(a).cmp(b) >= 0 ? f(a) : f(b));
const minF = (a, b) => (f(a).cmp(b) <= 0 ? f(a) : f(b));

function samePitchCovered(source, targets) {
  const spans = targets
    .filter(target => Number(target.pitch) === Number(source.pitch) && overlaps(source, target))
    .map(target => Object.freeze({
      start: maxF(source.start, target.start),
      end: minF(source.end, target.end),
    }))
    .filter(span => span.end.cmp(span.start) > 0)
    .sort((left, right) => left.start.cmp(right.start) || left.end.cmp(right.end));

  let cursor = f(source.start);
  for (const span of spans) {
    if (span.start.cmp(cursor) > 0) return false;
    if (span.end.cmp(cursor) > 0) cursor = span.end;
    if (cursor.cmp(source.end) >= 0) return true;
  }
  return false;
}

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

const sourceScopeKey = event => {
  // Canonical IR intentionally stores sourceIds[] and sourceEventIds[] as
  // independent arrays; do not pair them by position. For counting only, scope
  // each raw source-local id by the *whole source set* carried by that event.
  // Single-source events therefore become sourceId + rawId (the common case),
  // while ambiguous multi-source provenance stays a set-scoped identity rather
  // than an invented source/event pair.
  const ids = [...new Set(event?.sourceIds ?? [])].sort(cmpStr);
  return ids.length ? ids.join('\u001f') : '<source-unknown>';
};

const sourceEventIdentityCount = events => {
  const identities = new Set();
  for (const event of events ?? []) {
    const scope = sourceScopeKey(event);
    for (const rawId of event?.sourceEventIds ?? []) identities.add(`${scope}\u001e${rawId}`);
  }
  return identities.size;
};

function inspectEvent(source, targetEvents) {
  const collisions = targetEvents.filter(target => overlaps(source, target));
  const losslessGap = collisions.length === 0;
  const unisonCovered = samePitchCovered(source, collisions);
  const differentPitchCollision = collisions.some(target => Number(target.pitch) !== Number(source.pitch));
  return Object.freeze({
    losslessGap,
    unisonCovered,
    continuityDistance: continuityDistance(source, targetEvents),
    // A union of adjacent/overlapping same-pitch notes can cover the source
    // without one target note doing so alone. That is a dedup review, not a
    // destructive collision. Any uncovered or different-pitch collision stays
    // unsafe and is never hidden by the same-pitch material.
    wouldRequireTrimOrDrop: !losslessGap && (!unisonCovered || differentPitchCollision),
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
  const sourceIds = new Set(source.map(event => event.id));
  const candidate = notes(candidateEvents);
  const normalizedRoles = [...new Set((roles ?? DEFAULT_ROLES).filter(role => DEFAULT_ROLES.includes(role)))];

  const sourceEventCount = sourceEventIdentityCount(source);
  const rawSourceIds = new Set(source.flatMap(event => event.sourceIds ?? []));

  const targets = normalizedRoles.map(role => {
    const targetEvents = candidate.filter(event => event.role === role && !sourceIds.has(event.id));
    let losslessGapCount = 0;
    let unisonCoveredCount = 0;
    let wouldRequireTrimOrDropCount = 0;
    let minimumContinuityDistance = null;
    for (const event of source) {
      const inspected = inspectEvent(event, targetEvents);
      if (inspected.losslessGap) losslessGapCount += 1;
      if (inspected.unisonCovered) unisonCoveredCount += 1;
      if (inspected.wouldRequireTrimOrDrop) wouldRequireTrimOrDropCount += 1;
      if (Number.isFinite(inspected.continuityDistance)
        && (minimumContinuityDistance === null || inspected.continuityDistance < minimumContinuityDistance)) {
        minimumContinuityDistance = inspected.continuityDistance;
      }
    }
    return Object.freeze({
      role,
      core3: CORE3.has(role),
      leadReviewRequired: role === 'Melody',
      preferredByRoleAnalysis: preferredRole === role,
      candidateEventCount: source.length,
      sourceEventCount,
      targetEventCount: targetEvents.length,
      losslessGapCount,
      unisonCoveredCount,
      wouldRequireTrimOrDropCount,
      fullyLossless: source.length > 0 && losslessGapCount === source.length,
      requiresReviewerDecision: unisonCoveredCount > 0 || wouldRequireTrimOrDropCount > 0,
      continuityDistance: minimumContinuityDistance,
      authority: 'SUGGESTION_ONLY',
    });
  }).sort((a, b) => compareRank(a, b, preferredRole));

  return Object.freeze({
    schema: LEGACY_MERGE_DIAGNOSTIC_SCHEMA,
    authority: 'SUGGESTION_ONLY',
    candidateEventCount: source.length,
    sourceEventCount,
    sourceCount: rawSourceIds.size,
    preferredRole: DEFAULT_ROLES.includes(preferredRole) ? preferredRole : null,
    targets: Object.freeze(targets),
    certifiesGates: Object.freeze([]),
    mutatesCandidate: false,
    permitsAutomaticOmission: false,
    permitsAutomaticTruncation: false,
    notice: 'Historical frontend merge heuristics were adapted as read-only lane-level diagnostics. Per-event collision ids are intentionally not persisted here; exact candidate/raw provenance remains in the lane and event ledgers. A lossless gap is a candidate for reviewer redistribution; same-pitch coverage still needs an explicit evidence-backed decision; collisions remain unresolved rather than being trimmed or dropped.',
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
