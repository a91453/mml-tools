import { f } from '../mml/index.mjs';

const CORE3 = new Set(['Melody', 'Chord1', 'Chord2']);
const ENRICHMENT = new Set(['Chord3', 'Chord4', 'Chord5']);
const RISK_INTERVALS = new Map([
  [1, 'm2'],
  [11, 'M7'],
  [13, 'm9'],
]);

const noteEvents = project => (project?.events ?? []).filter(event => event.kind === 'note');
const overlap = (a, b) => f(a.start).cmp(b.end) < 0 && f(b.start).cmp(a.end) < 0;
const maxF = (a, b) => f(a).cmp(b) >= 0 ? f(a) : f(b);
const minF = (a, b) => f(a).cmp(b) <= 0 ? f(a) : f(b);
const disjointSources = (a, b) => {
  const left = new Set(a.sourceIds ?? []);
  return (b.sourceIds ?? []).every(sourceId => !left.has(sourceId));
};

function sourceAuthorityMap(project) {
  return new Map((project.sources ?? []).map(source => [source.id, source.authority ?? 'unknown']));
}

function pairAuthorities(event, authorities) {
  return [...new Set((event.sourceIds ?? []).map(sourceId => authorities.get(sourceId) ?? 'unknown'))];
}

function conflictId(kind, left, right) {
  return `${kind}|${[left.id, right.id].sort().join('|')}`;
}

function decisionFor(project, left, right) {
  const ids = new Set([left.id, right.id]);
  return (project.decisions ?? []).find(decision =>
    decision.status === 'accepted'
    && decision.eventIds?.length >= 2
    && [...ids].every(id => decision.eventIds.includes(id))) ?? null;
}

function makeConflict(project, authorities, kind, left, right, details) {
  const start = maxF(left.start, right.start);
  const end = minF(left.end, right.end);
  const decision = decisionFor(project, left, right);
  const core3Threat = (CORE3.has(left.role) && ENRICHMENT.has(right.role)) || (CORE3.has(right.role) && ENRICHMENT.has(left.role));
  return Object.freeze({
    id: conflictId(kind, left, right),
    kind,
    leftEventId: left.id,
    rightEventId: right.id,
    start: String(start),
    end: String(end),
    leftRole: left.role,
    rightRole: right.role,
    leftPitch: left.pitch,
    rightPitch: right.pitch,
    leftAuthorities: pairAuthorities(left, authorities),
    rightAuthorities: pairAuthorities(right, authorities),
    core3Threat,
    resolved: Boolean(decision),
    decision: decision ? Object.freeze({ id: decision.id, action: decision.action, reason: decision.reason, evidence: [...decision.evidence] }) : null,
    ...details,
  });
}

export function analyzeCrossSourceHarmony(project, options = {}) {
  if (!project?.events || !project?.sources) throw Error('Cross-source harmony analysis requires a Canonical project');
  const lowMidCeiling = Number.isInteger(options.lowMidCeiling) ? options.lowMidCeiling : 71;
  const notes = noteEvents(project);
  const authorities = sourceAuthorityMap(project);
  const conflicts = [];

  for (let i = 0; i < notes.length; i++) {
    for (let j = i + 1; j < notes.length; j++) {
      const left = notes[i], right = notes[j];
      if (!overlap(left, right) || !disjointSources(left, right)) continue;
      const distance = Math.abs(left.pitch - right.pitch);

      if (distance === 0) {
        conflicts.push(makeConflict(project, authorities, 'cross-source-same-pitch', left, right, {
          intervalSemitones: 0,
          intervalName: 'P1',
          registerRisk: Math.min(left.pitch, right.pitch) <= lowMidCeiling ? 'low-mid' : 'upper',
          notice: 'Separate events from different sources double the same sounding pitch; unify source support or explicitly justify the doubling.',
        }));
        continue;
      }

      const intervalName = RISK_INTERVALS.get(distance);
      if (!intervalName) continue;
      conflicts.push(makeConflict(project, authorities, 'cross-source-dissonance', left, right, {
        intervalSemitones: distance,
        intervalName,
        registerRisk: Math.min(left.pitch, right.pitch) <= lowMidCeiling ? 'low-mid' : 'upper',
        notice: 'This is a review trigger, not an automatic deletion. Keep, move octave, reassign, or remove only with source/role/harmonic evidence.',
      }));
    }
  }

  const unresolved = conflicts.filter(conflict => !conflict.resolved);
  const core3Threats = conflicts.filter(conflict => conflict.core3Threat);
  return Object.freeze({
    status: unresolved.length ? 'PENDING' : 'PASS',
    pass: unresolved.length === 0,
    conflictCount: conflicts.length,
    unresolvedCount: unresolved.length,
    core3ThreatCount: core3Threats.length,
    conflicts: Object.freeze(conflicts),
    unresolved: Object.freeze(unresolved),
    core3Threats: Object.freeze(core3Threats),
    policy: Object.freeze({
      lowMidCeiling,
      reviewedIntervals: Object.freeze([...RISK_INTERVALS.entries()].map(([semitones, name]) => ({ semitones, name }))),
      samePitchCrossSourceReview: true,
    }),
    notice: 'A source reference proves provenance, not compatibility. Cross-source conflict decisions must be explicit; no event is automatically deleted.',
  });
}
