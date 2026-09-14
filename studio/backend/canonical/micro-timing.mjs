// Source-aware micro-timing analyzer (G10 C2A).
//
// Implements the already-published MOBILE_SYNTAX rule that Final Canonical safe
// timing resolution is 1/64, and that technical micro-gaps / decomposition
// components finer than 1/64 are forbidden only when they have no
// source-supported musical meaning.
//
// This module reports interval identity, evidence and classification only.
// It does not rewrite events, normalize timing, or certify Final representability.
// C1 metadata.timing remains factual provenance and is never read as a verdict.
//
// Path B (producer artifact attestation) is intentionally unavailable in C2A.
// There is no trusted internal producer channel, and project/import metadata
// or a matching producingModule string is not proof of producer identity.
import { f, F, ROLES } from '../mml/index.mjs';

// 1/64 whole-note duration = 4/64 = 1/16 quarter-note IR beats.
export const SAFE_GRID = Object.freeze(new F(4, 64));

export const INTERVAL_TYPES = Object.freeze({
  EVENT_DURATION: 'event-duration',
  INTER_EVENT_GAP: 'inter-event-gap',
});

export const MICRO_TIMING_CLASSIFICATIONS = Object.freeze({
  SOURCE_SUPPORTED_MICROTIMING: 'SOURCE_SUPPORTED_MICROTIMING',
  TECHNICAL_RESIDUE: 'TECHNICAL_RESIDUE',
  UNKNOWN: 'UNKNOWN',
});

export const MICRO_TIMING_KEEP_ACTION = 'micro-timing:keep-as-source-supported';

export const MICRO_TIMING_TECHNICAL_ACTIONS = Object.freeze([
  'micro-timing:normalize-as-technical-residue',
  'micro-timing:classify-as-technical-residue',
]);

export const UNRESOLVED_STREAM_REASON = 'unassigned-role-stream-identity';

// SOURCE_POLICY primary classes that can bind source-supported microtiming.
// Kind and authority must be compatible. An imported authority string cannot
// promote a third-party / MML / derived record into primary eligibility.
const PRIMARY_SOURCE_AUTHORITIES = Object.freeze(['primary-symbolic', 'primary-audio']);
const PRIMARY_SYMBOLIC_KINDS = Object.freeze(['official-musicxml', 'official-midi']);
const PRIMARY_AUDIO_KINDS = Object.freeze(['original-audio']);
const ASSIGNED_ROLES = new Set(ROLES);
const SPAN_KINDS = new Set(['note', 'rest']);

function asRational(value, label) {
  try {
    return f(value);
  } catch {
    throw Error(`${label} must be an exact rational-compatible value`);
  }
}

function nonEmpty(value, label) {
  if (typeof value !== 'string' || !value.trim()) throw Error(`${label} must be a non-empty string`);
  return value.trim();
}

function freezeDeep(value) {
  if (Array.isArray(value)) {
    return Object.freeze(value.map(freezeDeep));
  }
  if (value && typeof value === 'object') {
    return Object.freeze(Object.fromEntries(
      Object.entries(value).map(([key, child]) => [key, freezeDeep(child)]),
    ));
  }
  return value;
}

function rationalsEqual(left, right) {
  try {
    return f(left).cmp(right) === 0;
  } catch {
    return false;
  }
}

export function createIntervalIdentity(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw Error('interval identity must be an object');
  }
  const type = nonEmpty(input.type, 'intervalIdentity.type');
  if (!Object.values(INTERVAL_TYPES).includes(type)) {
    throw Error(`unsupported intervalIdentity.type: ${type}`);
  }
  const start = asRational(input.start, 'intervalIdentity.start');
  const end = asRational(input.end, 'intervalIdentity.end');
  if (end.cmp(start) <= 0) throw Error('intervalIdentity.end must be greater than start');
  const length = end.sub(start);
  if (input.length !== undefined && input.length !== null && !rationalsEqual(input.length, length)) {
    throw Error('intervalIdentity.length does not match end - start');
  }

  if (type === INTERVAL_TYPES.EVENT_DURATION) {
    const eventId = nonEmpty(input.eventId, 'intervalIdentity.eventId');
    return freezeDeep({
      type,
      eventId,
      start: start.toString(),
      end: end.toString(),
      length: length.toString(),
    });
  }

  const previousEventId = nonEmpty(input.previousEventId, 'intervalIdentity.previousEventId');
  const nextEventId = nonEmpty(input.nextEventId, 'intervalIdentity.nextEventId');
  if (previousEventId === nextEventId) {
    throw Error('inter-event-gap identity requires two distinct events');
  }
  return freezeDeep({
    type,
    previousEventId,
    nextEventId,
    start: start.toString(),
    end: end.toString(),
    length: length.toString(),
  });
}

function identityTuple(identity) {
  const normalized = createIntervalIdentity(identity);
  if (normalized.type === INTERVAL_TYPES.EVENT_DURATION) {
    return [
      normalized.type,
      normalized.eventId,
      normalized.start,
      normalized.end,
    ];
  }
  return [
    normalized.type,
    normalized.previousEventId,
    normalized.nextEventId,
    normalized.start,
    normalized.end,
  ];
}

// Structured encoding only. Do not concatenate event IDs with "->", "@", or "..":
// those delimiters are legal inside Canonical event IDs.
export function intervalIdentityKey(identity) {
  return JSON.stringify(identityTuple(identity));
}

export function intervalIdentityLabel(identity) {
  const normalized = createIntervalIdentity(identity);
  if (normalized.type === INTERVAL_TYPES.EVENT_DURATION) {
    return `${normalized.type}:${normalized.eventId}@${normalized.start}..${normalized.end}`;
  }
  return `${normalized.type}:${normalized.previousEventId}->${normalized.nextEventId}@${normalized.start}..${normalized.end}`;
}

export function identitiesMatch(expected, candidate) {
  if (!expected || !candidate) return false;
  let left;
  let right;
  try {
    left = createIntervalIdentity(expected);
    right = createIntervalIdentity(candidate);
  } catch {
    return false;
  }
  if (left.type !== right.type) return false;
  if (!rationalsEqual(left.start, right.start)) return false;
  if (!rationalsEqual(left.end, right.end)) return false;
  if (left.type === INTERVAL_TYPES.EVENT_DURATION) {
    return left.eventId === right.eventId;
  }
  return left.previousEventId === right.previousEventId
    && left.nextEventId === right.nextEventId;
}

export function createTimingArtifactAttestation({
  producingModule,
  carriesNoMusicalMeaning,
  target,
}) {
  return freezeDeep({
    producingModule: nonEmpty(producingModule, 'attestation.producingModule'),
    carriesNoMusicalMeaning: carriesNoMusicalMeaning === true,
    target: createIntervalIdentity(target),
  });
}

function spanEvents(project) {
  const events = Array.isArray(project?.events) ? project.events : [];
  return events.filter(event => event && SPAN_KINDS.has(event.kind) && event.id && event.start != null && event.end != null);
}

function durationIdentityFor(event) {
  return createIntervalIdentity({
    type: INTERVAL_TYPES.EVENT_DURATION,
    eventId: event.id,
    start: event.start,
    end: event.end,
  });
}

function gapIdentityFor(previous, next, holeStart, holeEnd) {
  return createIntervalIdentity({
    type: INTERVAL_TYPES.INTER_EVENT_GAP,
    previousEventId: previous.id,
    nextEventId: next.id,
    start: holeStart,
    end: holeEnd,
  });
}

function eventIdsFor(identity) {
  if (identity.type === INTERVAL_TYPES.EVENT_DURATION) return [identity.eventId];
  return [identity.previousEventId, identity.nextEventId];
}

function involvedSourceIds(eventsById, identity) {
  const ids = [];
  const seen = new Set();
  for (const eventId of eventIdsFor(identity)) {
    const event = eventsById.get(eventId);
    for (const sourceId of event?.sourceIds ?? []) {
      if (seen.has(sourceId)) continue;
      seen.add(sourceId);
      ids.push(sourceId);
    }
  }
  return ids;
}

function decisionEventIds(decision) {
  return Array.isArray(decision?.eventIds) ? decision.eventIds.filter(id => typeof id === 'string' && id) : [];
}

function eventIdsExactly(decision, required) {
  const actual = decisionEventIds(decision);
  if (actual.length !== required.length) return false;
  return required.every(id => actual.includes(id)) && actual.every(id => required.includes(id));
}

function decisionTarget(decision) {
  const metadata = decision?.metadata;
  if (!metadata || typeof metadata !== 'object') return null;
  return metadata.intervalIdentity ?? null;
}

function evidenceOf(decision) {
  return Array.isArray(decision?.evidence) ? decision.evidence.filter(item => typeof item === 'string' && item.trim()) : [];
}

function evidenceSourceIdsOf(decision) {
  const raw = decision?.metadata?.evidenceSourceIds;
  if (!Array.isArray(raw)) return [];
  const ids = [];
  const seen = new Set();
  for (const value of raw) {
    if (typeof value !== 'string' || !value.trim()) continue;
    const id = value.trim();
    if (seen.has(id)) continue;
    seen.add(id);
    ids.push(id);
  }
  return ids;
}

function sourceById(project) {
  const map = new Map();
  for (const source of project?.sources ?? []) {
    if (source && typeof source.id === 'string') map.set(source.id, source);
  }
  return map;
}

function isPrimarySourceRecord(source) {
  if (!source || typeof source !== 'object') return false;
  if (source.kind === 'derived' || source.authority === 'derived') return false;
  if (source.authority === 'primary-symbolic') {
    return PRIMARY_SYMBOLIC_KINDS.includes(source.kind);
  }
  if (source.authority === 'primary-audio') {
    return PRIMARY_AUDIO_KINDS.includes(source.kind);
  }
  return false;
}

function hasAdmissibleSourceBinding(project, decision) {
  const cited = evidenceSourceIdsOf(decision);
  if (!cited.length) return false;
  const sources = sourceById(project);
  const resolved = [];
  for (const id of cited) {
    const source = sources.get(id);
    if (!source) return false;
    resolved.push(source);
  }
  return resolved.some(isPrimarySourceRecord);
}

function matchingDecisions(project, identity) {
  const decisions = Array.isArray(project?.decisions) ? project.decisions : [];
  return decisions.filter(decision => (
    eventIdsExactly(decision, eventIdsFor(identity))
    && identitiesMatch(decisionTarget(decision), identity)
  ));
}

function classifyInterval(project, identity) {
  const matches = matchingDecisions(project, identity);
  const acceptedKeep = matches.filter(decision => (
    decision.status === 'accepted'
    && decision.action === MICRO_TIMING_KEEP_ACTION
    && evidenceOf(decision).length > 0
    && hasAdmissibleSourceBinding(project, decision)
  ));
  const acceptedTechnical = matches.filter(decision => (
    decision.status === 'accepted'
    && MICRO_TIMING_TECHNICAL_ACTIONS.includes(decision.action)
  ));

  const sourceSupported = acceptedKeep.length > 0;
  const technical = acceptedTechnical.length > 0;
  if (sourceSupported && technical) {
    return {
      classification: MICRO_TIMING_CLASSIFICATIONS.UNKNOWN,
      classificationBasis: 'conflicting-accepted-evidence',
      decisionId: null,
      evidence: [],
      attestation: null,
    };
  }
  if (acceptedKeep.length > 1 || acceptedTechnical.length > 1) {
    return {
      classification: MICRO_TIMING_CLASSIFICATIONS.UNKNOWN,
      classificationBasis: 'ambiguous-matching-decisions',
      decisionId: null,
      evidence: [],
      attestation: null,
    };
  }
  if (sourceSupported) {
    const decision = acceptedKeep[0];
    return {
      classification: MICRO_TIMING_CLASSIFICATIONS.SOURCE_SUPPORTED_MICROTIMING,
      classificationBasis: 'accepted-keep-decision',
      decisionId: decision.id ?? null,
      evidence: evidenceOf(decision),
      attestation: null,
    };
  }
  if (acceptedTechnical.length === 1) {
    const decision = acceptedTechnical[0];
    return {
      classification: MICRO_TIMING_CLASSIFICATIONS.TECHNICAL_RESIDUE,
      classificationBasis: 'accepted-technical-decision',
      decisionId: decision.id ?? null,
      evidence: evidenceOf(decision),
      attestation: null,
    };
  }

  const pendingKeep = matches.some(decision => (
    decision.status === 'pending' && decision.action === MICRO_TIMING_KEEP_ACTION
  ));
  const rejectedKeep = matches.some(decision => (
    decision.status === 'rejected' && decision.action === MICRO_TIMING_KEEP_ACTION
  ));
  const emptyEvidenceKeep = matches.some(decision => (
    decision.status === 'accepted'
    && decision.action === MICRO_TIMING_KEEP_ACTION
    && evidenceOf(decision).length === 0
  ));
  const unboundKeep = matches.some(decision => (
    decision.status === 'accepted'
    && decision.action === MICRO_TIMING_KEEP_ACTION
    && evidenceOf(decision).length > 0
    && !hasAdmissibleSourceBinding(project, decision)
  ));
  let classificationBasis = 'insufficient-proof';
  if (emptyEvidenceKeep) classificationBasis = 'accepted-keep-decision-empty-evidence';
  else if (unboundKeep) classificationBasis = 'accepted-keep-decision-without-admissible-source-binding';
  else if (pendingKeep) classificationBasis = 'pending-keep-decision';
  else if (rejectedKeep) classificationBasis = 'rejected-keep-decision';
  return {
    classification: MICRO_TIMING_CLASSIFICATIONS.UNKNOWN,
    classificationBasis,
    decisionId: null,
    evidence: [],
    attestation: null,
  };
}

function compareToSafeGrid(length) {
  const cmp = f(length).cmp(SAFE_GRID);
  if (cmp < 0) return 'below-safe-grid';
  if (cmp === 0) return 'equals-safe-grid';
  return 'above-safe-grid';
}

function reportFor(project, identity, eventsById) {
  const classified = classifyInterval(project, identity);
  return freezeDeep({
    identity,
    identityKey: intervalIdentityKey(identity),
    identityLabel: intervalIdentityLabel(identity),
    intervalType: identity.type,
    length: identity.length,
    safeGrid: SAFE_GRID.toString(),
    safeGridComparison: compareToSafeGrid(identity.length),
    classification: classified.classification,
    classificationBasis: classified.classificationBasis,
    decisionId: classified.decisionId,
    evidence: classified.evidence,
    attestation: classified.attestation,
    eventIds: eventIdsFor(identity),
    sourceIds: involvedSourceIds(eventsById, identity),
    // C2A answers source-support only. It never certifies Final representability.
    finalRepresentable: null,
  });
}

export function compareEvents(left, right) {
  const startCmp = f(left.start).cmp(right.start);
  if (startCmp !== 0) return startCmp;
  const endCmp = f(left.end).cmp(right.end);
  if (endCmp !== 0) return endCmp;
  const leftId = String(left.id);
  const rightId = String(right.id);
  if (leftId < rightId) return -1;
  if (leftId > rightId) return 1;
  return 0;
}

function pickBoundaryEvent(events) {
  const copy = [...events];
  copy.sort((left, right) => {
    if (String(left.id) < String(right.id)) return -1;
    if (String(left.id) > String(right.id)) return 1;
    return 0;
  });
  return copy[0] ?? null;
}

function uncoveredHoles(streamEvents) {
  if (streamEvents.length < 2) return [];
  const ordered = [...streamEvents].sort(compareEvents);
  const segments = [];
  for (const event of ordered) {
    const start = f(event.start);
    const end = f(event.end);
    const last = segments.at(-1);
    if (!last || start.cmp(last.end) > 0) {
      segments.push({ start, end, events: [event] });
      continue;
    }
    last.events.push(event);
    if (end.cmp(last.end) > 0) last.end = end;
  }

  const holes = [];
  for (let index = 0; index < segments.length - 1; index += 1) {
    const left = segments[index];
    const right = segments[index + 1];
    const length = right.start.sub(left.end);
    if (length.cmp(0) <= 0) continue;
    if (length.cmp(SAFE_GRID) >= 0) continue;
    const leftBoundary = streamEvents.filter(event => f(event.end).cmp(left.end) === 0);
    const rightBoundary = streamEvents.filter(event => f(event.start).cmp(right.start) === 0);
    const previous = pickBoundaryEvent(leftBoundary);
    const next = pickBoundaryEvent(rightBoundary);
    if (!previous || !next || previous.id === next.id) continue;
    holes.push({
      previous,
      next,
      start: left.end,
      end: right.start,
    });
  }
  return holes;
}

function isAssignedRole(event) {
  return ASSIGNED_ROLES.has(event.role);
}

function possiblePositiveSubGridSeparation(left, right) {
  const gap = f(right.start).sub(left.end);
  return gap.cmp(0) > 0 && gap.cmp(SAFE_GRID) < 0;
}

function unresolvedPairKey(leftId, rightId, start, end) {
  return JSON.stringify([leftId, rightId, start, end]);
}

function collectUnresolvedStreamIssues(spans) {
  const unassigned = spans.filter(event => !isAssignedRole(event));
  const issues = [];
  const seen = new Set();
  for (const event of unassigned) {
    for (const other of spans) {
      if (!other || other.id === event.id) continue;
      const ordered = compareEvents(event, other) <= 0 ? [event, other] : [other, event];
      if (!possiblePositiveSubGridSeparation(ordered[0], ordered[1])) continue;
      const start = f(ordered[0].end);
      const end = f(ordered[1].start);
      const key = unresolvedPairKey(ordered[0].id, ordered[1].id, start.toString(), end.toString());
      if (seen.has(key)) continue;
      seen.add(key);
      issues.push({
        reason: UNRESOLVED_STREAM_REASON,
        eventIds: [ordered[0].id, ordered[1].id],
        start: start.toString(),
        end: end.toString(),
        length: end.sub(start).toString(),
      });
    }
  }
  issues.sort((left, right) => {
    const leftKey = unresolvedPairKey(left.eventIds[0], left.eventIds[1], left.start, left.end);
    const rightKey = unresolvedPairKey(right.eventIds[0], right.eventIds[1], right.start, right.end);
    if (leftKey < rightKey) return -1;
    if (leftKey > rightKey) return 1;
    return 0;
  });
  return issues;
}

export function analyzeProjectMicroTiming(project, options = {}) {
  if (!project || typeof project !== 'object') throw Error('Canonical project is required');
  void options;
  const spans = spanEvents(project);
  const eventsById = new Map(spans.map(event => [event.id, event]));

  const candidates = [];
  for (const event of spans) {
    const identity = durationIdentityFor(event);
    if (f(identity.length).cmp(SAFE_GRID) < 0) {
      candidates.push(reportFor(project, identity, eventsById));
    }
  }

  const byAssignedRole = new Map();
  for (const event of spans) {
    if (!isAssignedRole(event)) continue;
    if (!byAssignedRole.has(event.role)) byAssignedRole.set(event.role, []);
    byAssignedRole.get(event.role).push(event);
  }
  for (const group of byAssignedRole.values()) {
    for (const hole of uncoveredHoles(group)) {
      const identity = gapIdentityFor(hole.previous, hole.next, hole.start, hole.end);
      candidates.push(reportFor(project, identity, eventsById));
    }
  }

  const unresolvedStreamIssues = collectUnresolvedStreamIssues(spans);

  candidates.sort((left, right) => {
    if (left.identityKey < right.identityKey) return -1;
    if (left.identityKey > right.identityKey) return 1;
    return 0;
  });

  const unknown = candidates.filter(item => item.classification === MICRO_TIMING_CLASSIFICATIONS.UNKNOWN);
  const sourceSupported = candidates.filter(item => item.classification === MICRO_TIMING_CLASSIFICATIONS.SOURCE_SUPPORTED_MICROTIMING);
  const technical = candidates.filter(item => item.classification === MICRO_TIMING_CLASSIFICATIONS.TECHNICAL_RESIDUE);
  const hasUnresolvedStreamAnalysis = unresolvedStreamIssues.length > 0;

  return freezeDeep({
    safeGrid: SAFE_GRID.toString(),
    candidateCount: candidates.length,
    unknownCount: unknown.length,
    sourceSupportedCount: sourceSupported.length,
    technicalResidueCount: technical.length,
    unresolvedStreamIssueCount: unresolvedStreamIssues.length,
    hasUnknown: unknown.length > 0 || hasUnresolvedStreamAnalysis,
    hasUnresolvedStreamAnalysis,
    intervals: candidates,
    unresolvedStreamIssues,
  });
}
