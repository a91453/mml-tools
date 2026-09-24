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

// ─── per-role target index ──────────────────────────────────────────────────
//
// Every source event of a lane is measured against the same target events, so
// those are parsed and ordered once per (call, role) rather than once per source
// event. A source-by-source rescan (copy + exact-rational re-sort of every target
// for every source event, plus a filter over every target) made a whole-project
// suggestion O(N^2 log N) on the service's only thread.
//
// The index answers exactly the questions the rescan asked, with the same
// tie-breaking:
//   before      the LAST target in byTime order whose end <= source.start;
//   after       the FIRST target in byTime order whose start >= source.end;
//   collisions  every target with start < source.end and end > source.start
//               (the `overlaps` predicate), as a multiset. Their order is not
//               observable: only the count, a some() and an order-free
//               same-pitch coverage test read them.
// `rank` is a target's position in the byTime order the rescan produced (the
// same stable sort of the same input with the same comparison results), so
// "last"/"first" in that order are a max/min over ranks.
function buildTargetIndex(targetEvents) {
  const items = targetEvents.map(event => ({ event, start: f(event.start), end: f(event.end), rank: 0 }));
  const count = items.length;
  // byTime, evaluated on pre-parsed values: identical comparison results.
  const ordered = items.slice().sort((a, b) => a.start.cmp(b.start) || a.end.cmp(b.end)
    || Number(a.event.pitch) - Number(b.event.pitch) || cmpStr(String(a.event.id), String(b.event.id)));
  ordered.forEach((item, rank) => { item.rank = rank; });

  // Onset order for the binary searches. byTime is onset-first, so this is
  // normally `ordered` itself; it is re-sorted only if the tie-breakers were not
  // a consistent order (e.g. a NaN pitch), which keeps the searches exact anyway.
  const onsetOrdered = ordered.every((item, index) => index === 0 || item.start.cmp(ordered[index - 1].start) >= 0);
  const byStart = onsetOrdered ? ordered : ordered.slice().sort((a, b) => a.start.cmp(b.start) || a.rank - b.rank);
  // firstRankFrom[i]: lowest rank among byStart[i..]. -1 when empty.
  const firstRankFrom = new Array(count + 1);
  firstRankFrom[count] = -1;
  for (let i = count - 1; i >= 0; i -= 1) {
    const next = firstRankFrom[i + 1];
    firstRankFrom[i] = next === -1 ? byStart[i].rank : Math.min(next, byStart[i].rank);
  }

  const byEnd = ordered.slice().sort((a, b) => a.end.cmp(b.end) || a.rank - b.rank);
  // lastRankThrough[i]: highest rank among byEnd[0..i].
  const lastRankThrough = new Array(count);
  for (let i = 0; i < count; i += 1) lastRankThrough[i] = i === 0 ? byEnd[i].rank : Math.max(lastRankThrough[i - 1], byEnd[i].rank);

  // Max-end segment tree over byStart: the targets that start before a source
  // ends form a prefix of byStart, and only subtrees whose latest end is after
  // the source start can contain a collision.
  let size = 1;
  while (size < count) size *= 2;
  const maxEnd = new Array(2 * size).fill(null);
  for (let i = 0; i < count; i += 1) maxEnd[size + i] = byStart[i].end;
  for (let node = size - 1; node >= 1; node -= 1) {
    const left = maxEnd[2 * node];
    const right = maxEnd[2 * node + 1];
    maxEnd[node] = left === null ? right : right === null || left.cmp(right) >= 0 ? left : right;
  }
  return { count, ordered, byStart, firstRankFrom, byEnd, lastRankThrough, size, maxEnd };
}

// Smallest index in [0, list.length] whose element satisfies a predicate that
// is monotone (false...false, true...true) over the list.
function firstIndexWhere(list, predicate) {
  let low = 0;
  let high = list.length;
  while (low < high) {
    const middle = (low + high) >>> 1;
    if (predicate(list[middle])) high = middle;
    else low = middle + 1;
  }
  return low;
}

// Targets in byStart[0, startsBeforeEnd) whose end is after `sourceStart`.
function collisionsOf(index, sourceStart, startsBeforeEnd) {
  const found = [];
  if (startsBeforeEnd === 0) return found;
  const { size, maxEnd, byStart } = index;
  const nodes = [1];
  const lows = [0];
  const highs = [size];
  while (nodes.length) {
    const node = nodes.pop();
    const low = lows.pop();
    const high = highs.pop();
    if (low >= startsBeforeEnd) continue;
    const latest = maxEnd[node];
    if (latest === null || latest.cmp(sourceStart) <= 0) continue;
    if (node >= size) {
      found.push(byStart[node - size].event);
      continue;
    }
    const middle = (low + high) >>> 1;
    nodes.push(2 * node + 1, 2 * node);
    lows.push(middle, low);
    highs.push(high, middle);
  }
  return found;
}

function continuityDistance(source, sourceStart, index, startsAtOrAfterEnd) {
  // byEnd[0, endedByStart) end at or before the source start.
  const endedByStart = firstIndexWhere(index.byEnd, item => item.end.cmp(sourceStart) > 0);
  const before = endedByStart > 0 ? index.ordered[index.lastRankThrough[endedByStart - 1]].event : null;
  const afterRank = index.firstRankFrom[startsAtOrAfterEnd];
  const after = afterRank >= 0 ? index.ordered[afterRank].event : null;
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

// `times` is the source's parsed [start, end]; null when the role is empty.
function inspectEvent(source, times, index) {
  let collisions = [];
  let distance = null;
  if (index.count > 0) {
    const [sourceStart, sourceEnd] = times;
    // byStart[0, startsAtOrAfterEnd) start before the source ends; the rest
    // start at or after its end.
    const startsAtOrAfterEnd = firstIndexWhere(index.byStart, item => item.start.cmp(sourceEnd) >= 0);
    collisions = collisionsOf(index, sourceStart, startsAtOrAfterEnd);
    distance = continuityDistance(source, sourceStart, index, startsAtOrAfterEnd);
  }
  const losslessGap = collisions.length === 0;
  const unisonCovered = samePitchCovered(source, collisions);
  const differentPitchCollision = collisions.some(target => Number(target.pitch) !== Number(source.pitch));
  return Object.freeze({
    losslessGap,
    unisonCovered,
    continuityDistance: distance,
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
  // Parsed [start, end] per source event, filled on first use.
  const sourceTimes = new Array(source.length);

  const targets = normalizedRoles.map(role => {
    const targetEvents = candidate.filter(event => event.role === role && !sourceIds.has(event.id));
    const index = source.length ? buildTargetIndex(targetEvents) : null;
    let losslessGapCount = 0;
    let unisonCoveredCount = 0;
    let wouldRequireTrimOrDropCount = 0;
    let minimumContinuityDistance = null;
    for (const [position, event] of source.entries()) {
      const times = index.count ? (sourceTimes[position] ??= [f(event.start), f(event.end)]) : null;
      const inspected = inspectEvent(event, times, index);
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
