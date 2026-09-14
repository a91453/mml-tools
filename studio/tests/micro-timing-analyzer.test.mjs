import test from 'node:test';
import assert from 'node:assert/strict';
import { f, F } from '../backend/mml/index.mjs';
import {
  createSource,
  createCanonicalNoteEvent,
  createCanonicalRestEvent,
  createCanonicalTempoEvent,
  createCanonicalMeterEvent,
  createArbitrationDecision,
  createCanonicalProject,
} from '../backend/canonical/index.mjs';
import { createTimingProvenance } from '../backend/canonical/timing.mjs';
import {
  SAFE_GRID,
  INTERVAL_TYPES,
  MICRO_TIMING_CLASSIFICATIONS,
  MICRO_TIMING_KEEP_ACTION,
  MICRO_TIMING_TECHNICAL_ACTIONS,
  UNRESOLVED_STREAM_REASON,
  createIntervalIdentity,
  intervalIdentityKey,
  identitiesMatch,
  createTimingArtifactAttestation,
  compareEvents,
  analyzeProjectMicroTiming,
} from '../backend/canonical/micro-timing.mjs';

const KEEP = MICRO_TIMING_KEEP_ACTION;
const TECHNICAL = MICRO_TIMING_TECHNICAL_ACTIONS[0];
const JUST_BELOW = new F(1, 17);
const EXACT_GRID = new F(1, 16);

function source(overrides = {}) {
  return createSource({
    id: 'src',
    label: 'Fixture source',
    kind: 'official-musicxml',
    authority: 'primary-symbolic',
    ...overrides,
  });
}

function timing(origin = 'source-derived', adapter = 'fixture-adapter') {
  return createTimingProvenance({
    adapter,
    start: { origin },
    duration: { origin },
    end: { origin },
  });
}

function note({
  id = 'n1',
  start = '0',
  end = '1',
  role = 'Melody',
  voice = null,
  origin = 'source-derived',
  adapter = 'fixture-adapter',
  withTiming = true,
  pitch = 60,
  sourceId = 'src',
  metadata = {},
} = {}) {
  return createCanonicalNoteEvent({
    id,
    pitch,
    start,
    end,
    role,
    voice,
    sourceIds: [sourceId],
    sourceEventIds: [`${id}/src`],
    metadata: {
      ...(withTiming ? { timing: timing(origin, adapter) } : {}),
      ...metadata,
    },
  });
}

function rest({
  id = 'r1',
  start = '0',
  end = '1',
  role = 'Melody',
  origin = 'source-derived',
  adapter = 'fixture-adapter',
  withTiming = true,
  sourceId = 'src',
} = {}) {
  return createCanonicalRestEvent({
    id,
    start,
    end,
    role,
    sourceIds: [sourceId],
    sourceEventIds: [`${id}/src`],
    metadata: withTiming ? { timing: timing(origin, adapter) } : {},
  });
}

function project({ events, decisions = [], metadata = {}, sources = [source()] } = {}) {
  return createCanonicalProject({
    id: 'g10-c2a',
    title: 'G10 C2A fixture',
    sources,
    events,
    decisions,
    metadata,
  });
}

function durationIdentity(event) {
  return createIntervalIdentity({
    type: INTERVAL_TYPES.EVENT_DURATION,
    eventId: event.id,
    start: event.start,
    end: event.end,
  });
}

function gapIdentity(previous, next) {
  return createIntervalIdentity({
    type: INTERVAL_TYPES.INTER_EVENT_GAP,
    previousEventId: previous.id,
    nextEventId: next.id,
    start: previous.end,
    end: next.start,
  });
}

function keepDecision({
  event,
  status = 'accepted',
  evidence = ['official-score measure 1 written 128th'],
  target,
  action = KEEP,
  extras = {},
} = {}) {
  const identity = target ?? durationIdentity(event);
  return createArbitrationDecision({
    id: extras.id ?? `keep:${identity.eventId ?? identity.previousEventId}`,
    eventIds: extras.eventIds ?? (identity.type === INTERVAL_TYPES.EVENT_DURATION ? [identity.eventId] : [identity.previousEventId, identity.nextEventId]),
    action,
    status,
    reason: extras.reason ?? 'Explicit current-project micro-timing keep.',
    evidence,
    metadata: {
      intervalIdentity: identity,
      evidenceSourceIds: extras.evidenceSourceIds ?? ['src'],
      ...extras.metadata,
    },
  });
}

function technicalDecision({ event, target, action = TECHNICAL, extras = {} } = {}) {
  const identity = target ?? durationIdentity(event);
  return createArbitrationDecision({
    id: extras.id ?? `tech:${identity.eventId ?? identity.previousEventId}`,
    eventIds: extras.eventIds ?? (identity.type === INTERVAL_TYPES.EVENT_DURATION ? [identity.eventId] : [identity.previousEventId, identity.nextEventId]),
    action,
    status: extras.status ?? 'accepted',
    reason: extras.reason ?? 'Explicit current-project technical-residue classification.',
    evidence: extras.evidence ?? ['producer log: inserted alignment pad'],
    metadata: { intervalIdentity: identity, ...extras.metadata },
  });
}

function snapshot(events) {
  return JSON.parse(JSON.stringify(events.map(event => ({
    id: event.id,
    kind: event.kind,
    start: event.start,
    end: event.end,
    role: event.role,
    pitch: event.pitch ?? null,
    volume: event.volume ?? null,
    sourceIds: event.sourceIds,
    sourceEventIds: event.sourceEventIds,
    metadata: event.metadata,
  }))));
}

test('safe grid is exact 1/16 IR beat from 4/64, not a float epsilon', () => {
  assert.equal(SAFE_GRID.toString(), '1/16');
  assert.equal(new F(4, 64).cmp(SAFE_GRID), 0);
  assert.equal(f('1/16').cmp(SAFE_GRID), 0);
  assert.equal(EXACT_GRID.cmp(SAFE_GRID), 0);
  assert.equal(JUST_BELOW.cmp(SAFE_GRID), -1);
});

test('1. exactly 1/64 is not flagged', () => {
  const event = note({ id: 'exact', start: '0', end: EXACT_GRID.toString() });
  const report = analyzeProjectMicroTiming(project({ events: [event] }));
  assert.equal(report.candidateCount, 0);
  assert.deepEqual(report.intervals, []);
  assert.equal(report.hasUnresolvedStreamAnalysis, false);
});

test('2. just below 1/64 is detected', () => {
  const event = note({ id: 'below', start: '0', end: JUST_BELOW.toString() });
  const report = analyzeProjectMicroTiming(project({ events: [event] }));
  assert.equal(report.candidateCount, 1);
  assert.equal(report.intervals[0].safeGridComparison, 'below-safe-grid');
  assert.equal(report.intervals[0].classification, MICRO_TIMING_CLASSIFICATIONS.UNKNOWN);
});

test('3. source-derived provenance alone is UNKNOWN', () => {
  const event = note({ id: 'sd', end: JUST_BELOW.toString(), origin: 'source-derived' });
  assert.equal(analyzeProjectMicroTiming(project({ events: [event] })).intervals[0].classification, MICRO_TIMING_CLASSIFICATIONS.UNKNOWN);
});

test('4. tool-derived provenance alone is UNKNOWN', () => {
  const event = note({ id: 'td', end: JUST_BELOW.toString(), origin: 'tool-derived' });
  const report = analyzeProjectMicroTiming(project({ events: [event] }));
  assert.equal(report.intervals[0].classification, MICRO_TIMING_CLASSIFICATIONS.UNKNOWN);
  assert.notEqual(report.intervals[0].classification, MICRO_TIMING_CLASSIFICATIONS.TECHNICAL_RESIDUE);
});

test('5. source-notated provenance alone is not SOURCE_SUPPORTED', () => {
  const event = note({ id: 'sn', end: JUST_BELOW.toString(), origin: 'source-notated' });
  assert.equal(analyzeProjectMicroTiming(project({ events: [event] })).intervals[0].classification, MICRO_TIMING_CLASSIFICATIONS.UNKNOWN);
});

test('6. official/source authority alone is not SOURCE_SUPPORTED', () => {
  const src = source({ kind: 'official-midi', authority: 'primary-symbolic' });
  const event = note({ id: 'auth', end: JUST_BELOW.toString(), origin: 'source-notated' });
  assert.equal(analyzeProjectMicroTiming(project({ sources: [src], events: [event] })).intervals[0].classification, MICRO_TIMING_CLASSIFICATIONS.UNKNOWN);
});

test('7. accepted keep + evidence + source binding + exact target is SOURCE_SUPPORTED_MICROTIMING', () => {
  const event = note({ id: 'keep-ok', end: JUST_BELOW.toString() });
  const report = analyzeProjectMicroTiming(project({
    events: [event],
    decisions: [keepDecision({ event })],
  }));
  assert.equal(report.intervals[0].classification, MICRO_TIMING_CLASSIFICATIONS.SOURCE_SUPPORTED_MICROTIMING);
  assert.equal(report.hasUnknown, false);
  assert.equal(report.hasUnresolvedStreamAnalysis, false);
});

test('8. accepted keep with empty evidence is UNKNOWN', () => {
  const event = note({ id: 'keep-empty', end: JUST_BELOW.toString() });
  const report = analyzeProjectMicroTiming(project({
    events: [event],
    decisions: [keepDecision({ event, evidence: [] })],
  }));
  assert.equal(report.intervals[0].classification, MICRO_TIMING_CLASSIFICATIONS.UNKNOWN);
});

test('9. pending keep decision is UNKNOWN', () => {
  const event = note({ id: 'keep-pending', end: JUST_BELOW.toString() });
  assert.equal(analyzeProjectMicroTiming(project({
    events: [event],
    decisions: [keepDecision({ event, status: 'pending' })],
  })).intervals[0].classification, MICRO_TIMING_CLASSIFICATIONS.UNKNOWN);
});

test('10. rejected keep decision is UNKNOWN', () => {
  const event = note({ id: 'keep-rejected', end: JUST_BELOW.toString() });
  assert.equal(analyzeProjectMicroTiming(project({
    events: [event],
    decisions: [keepDecision({ event, status: 'rejected' })],
  })).intervals[0].classification, MICRO_TIMING_CLASSIFICATIONS.UNKNOWN);
});

test('11. accepted keep targeting the wrong interval stays UNKNOWN for the current interval', () => {
  const current = note({ id: 'current', start: '0', end: JUST_BELOW.toString() });
  const other = note({ id: 'other', start: '1', end: f('1').add(JUST_BELOW).toString() });
  const currentReport = analyzeProjectMicroTiming(project({
    events: [current, other],
    decisions: [keepDecision({ event: other })],
  })).intervals.find(item => item.identity.eventId === 'current');
  assert.equal(currentReport.classification, MICRO_TIMING_CLASSIFICATIONS.UNKNOWN);
});

test('12. accepted technical-residue decision targeting the exact interval is TECHNICAL_RESIDUE', () => {
  const event = note({ id: 'tech', end: JUST_BELOW.toString(), origin: 'tool-derived' });
  const report = analyzeProjectMicroTiming(project({
    events: [event],
    decisions: [technicalDecision({ event })],
  }));
  assert.equal(report.intervals[0].classification, MICRO_TIMING_CLASSIFICATIONS.TECHNICAL_RESIDUE);
});

test('13. artifact attestation from a non-producing module is ignored', () => {
  const event = note({ id: 'wrong-prod', end: JUST_BELOW.toString(), adapter: 'real-producer' });
  const attestation = createTimingArtifactAttestation({
    producingModule: 'other-module',
    carriesNoMusicalMeaning: true,
    target: durationIdentity(event),
  });
  const report = analyzeProjectMicroTiming(project({ events: [event] }), { attestations: [attestation] });
  assert.equal(report.intervals[0].classification, MICRO_TIMING_CLASSIFICATIONS.UNKNOWN);
});

test('14. Path B remains unavailable: matching producer string does not classify TECHNICAL_RESIDUE', () => {
  const event = note({ id: 'own-prod', end: JUST_BELOW.toString(), adapter: 'real-producer', origin: 'tool-derived' });
  const attestation = createTimingArtifactAttestation({
    producingModule: 'real-producer',
    carriesNoMusicalMeaning: true,
    target: durationIdentity(event),
  });
  const report = analyzeProjectMicroTiming(project({ events: [event] }), { attestations: [attestation] });
  assert.equal(report.intervals[0].classification, MICRO_TIMING_CLASSIFICATIONS.UNKNOWN);
  assert.notEqual(report.intervals[0].classification, MICRO_TIMING_CLASSIFICATIONS.TECHNICAL_RESIDUE);
});

test('15. event-level artifact attestation must not classify a gap', () => {
  const first = note({ id: 'g1', start: '0', end: '1' });
  const second = note({ id: 'g2', start: f('1').add(JUST_BELOW).toString(), end: '2' });
  const report = analyzeProjectMicroTiming(project({ events: [first, second] }), {
    attestations: [{
      producingModule: 'fixture-adapter',
      carriesNoMusicalMeaning: true,
      target: { eventId: 'g1', start: first.end, end: second.start },
    }],
  });
  const gap = report.intervals.find(item => item.intervalType === INTERVAL_TYPES.INTER_EVENT_GAP);
  assert.ok(gap);
  assert.equal(gap.classification, MICRO_TIMING_CLASSIFICATIONS.UNKNOWN);
});

test('16. overlap is not a positive micro-gap', () => {
  const report = analyzeProjectMicroTiming(project({ events: [
    note({ id: 'o1', start: '0', end: '2' }),
    note({ id: 'o2', start: '1', end: '3' }),
  ] }));
  assert.equal(report.intervals.some(item => item.intervalType === INTERVAL_TYPES.INTER_EVENT_GAP), false);
});

test('17. zero adjacency is not a micro-gap', () => {
  const report = analyzeProjectMicroTiming(project({ events: [
    note({ id: 'z1', start: '0', end: '1' }),
    note({ id: 'z2', start: '1', end: '2' }),
  ] }));
  assert.equal(report.intervals.some(item => item.intervalType === INTERVAL_TYPES.INTER_EVENT_GAP), false);
});

test('18. trailing silence is excluded', () => {
  const report = analyzeProjectMicroTiming(project({ events: [note({ id: 'trail', start: '0', end: '1' })] }));
  assert.equal(report.intervals.some(item => item.intervalType === INTERVAL_TYPES.INTER_EVENT_GAP), false);
});

test('19. cross-role ending mismatch is not a G10 micro-gap', () => {
  const report = analyzeProjectMicroTiming(project({ events: [
    note({ id: 'm-end', role: 'Melody', start: '0', end: '2' }),
    note({ id: 'c-end', role: 'Chord1', start: '0', end: f('2').add(JUST_BELOW).toString(), pitch: 64 }),
  ] }));
  assert.equal(report.intervals.some(item => item.intervalType === INTERVAL_TYPES.INTER_EVENT_GAP), false);
  assert.equal(report.hasUnresolvedStreamAnalysis, false);
});

test('20-21. analyzer never mutates event timing, source IDs, role or pitch', () => {
  const events = [
    note({ id: 'mut-a', start: '0', end: JUST_BELOW.toString(), role: 'Melody', pitch: 67 }),
    rest({ id: 'mut-b', start: JUST_BELOW.toString(), end: '1', role: 'Melody' }),
  ];
  const before = snapshot(events);
  analyzeProjectMicroTiming(project({ events }));
  assert.deepEqual(snapshot(events), before);
});

test('22. legacy project without metadata.timing stays valid and fails closed', () => {
  const event = note({ id: 'legacy', end: JUST_BELOW.toString(), withTiming: false });
  assert.equal(event.metadata.timing, undefined);
  const report = analyzeProjectMicroTiming(project({ events: [event] }));
  assert.equal(report.intervals[0].classification, MICRO_TIMING_CLASSIFICATIONS.UNKNOWN);
});

test('23. exact rational threshold has no float-epsilon ambiguity', () => {
  const exact = note({ id: 'eps-eq', end: new F(4, 64).toString() });
  const below = note({ id: 'eps-below', start: '2', end: f('2').add(new F(4, 64).sub(new F(1, 64 * 64))).toString() });
  const report = analyzeProjectMicroTiming(project({ events: [exact, below] }));
  assert.equal(report.intervals.some(item => item.identity.eventId === 'eps-eq'), false);
  assert.equal(report.intervals.some(item => item.identity.eventId === 'eps-below'), true);
});

test('24. source-supported below-grid makes no Final representability claim', () => {
  const event = note({ id: 'src-keep', end: JUST_BELOW.toString() });
  const report = analyzeProjectMicroTiming(project({
    events: [event],
    decisions: [keepDecision({ event })],
  }));
  assert.equal(report.intervals[0].classification, MICRO_TIMING_CLASSIFICATIONS.SOURCE_SUPPORTED_MICROTIMING);
  assert.equal(report.intervals[0].finalRepresentable, null);
});

test('25. analyzer does not invent historicalRegression state', () => {
  const report = analyzeProjectMicroTiming(project({ events: [note({ id: 'hist', end: JUST_BELOW.toString() })] }));
  assert.equal(report.historicalRegression, undefined);
  assert.equal(JSON.stringify(report).includes('historicalRegression'), false);
});

test('generic event-level keep action does not establish microtiming', () => {
  const event = note({ id: 'generic-keep', end: JUST_BELOW.toString() });
  assert.equal(analyzeProjectMicroTiming(project({
    events: [event],
    decisions: [keepDecision({ event, action: 'keep' })],
  })).intervals[0].classification, MICRO_TIMING_CLASSIFICATIONS.UNKNOWN);
});

test('stale keep decision whose bounds no longer match current timing is UNKNOWN', () => {
  const event = note({ id: 'stale', start: '0', end: JUST_BELOW.toString() });
  const staleTarget = createIntervalIdentity({
    type: INTERVAL_TYPES.EVENT_DURATION,
    eventId: 'stale',
    start: '0',
    end: new F(1, 32).toString(),
  });
  assert.equal(analyzeProjectMicroTiming(project({
    events: [event],
    decisions: [keepDecision({ event, target: staleTarget })],
  })).intervals[0].classification, MICRO_TIMING_CLASSIFICATIONS.UNKNOWN);
});

test('gap keep requires both adjacent events; one event does not match', () => {
  const first = note({ id: 'gap-a', start: '0', end: '1' });
  const second = note({ id: 'gap-b', start: f('1').add(JUST_BELOW).toString(), end: '2' });
  const gap = analyzeProjectMicroTiming(project({
    events: [first, second],
    decisions: [keepDecision({
      event: first,
      target: gapIdentity(first, second),
      extras: { eventIds: [first.id], id: 'one-sided-gap' },
    })],
  })).intervals.find(item => item.intervalType === INTERVAL_TYPES.INTER_EVENT_GAP);
  assert.equal(gap.classification, MICRO_TIMING_CLASSIFICATIONS.UNKNOWN);
});

test('accepted gap keep with both events, evidence and source binding is SOURCE_SUPPORTED_MICROTIMING', () => {
  const first = note({ id: 'gap-keep-a', start: '0', end: '1' });
  const second = note({ id: 'gap-keep-b', start: f('1').add(JUST_BELOW).toString(), end: '2' });
  const gap = analyzeProjectMicroTiming(project({
    events: [first, second],
    decisions: [keepDecision({ event: first, target: gapIdentity(first, second) })],
  })).intervals.find(item => item.intervalType === INTERVAL_TYPES.INTER_EVENT_GAP);
  assert.equal(gap.classification, MICRO_TIMING_CLASSIFICATIONS.SOURCE_SUPPORTED_MICROTIMING);
});

test('tempo and meter points are not duration or gap candidates', () => {
  const report = analyzeProjectMicroTiming(createCanonicalProject({
    id: 'points',
    title: 'points',
    sources: [source()],
    events: [note({ id: 'point-n', start: '0', end: '1' })],
    tempoEvents: [createCanonicalTempoEvent({ id: 't0', beat: '0', bpm: 120, sourceIds: ['src'] })],
    meterEvents: [createCanonicalMeterEvent({ id: 'm0', beat: '0', numerator: 4, denominator: 4, sourceIds: ['src'] })],
  }));
  assert.equal(report.candidateCount, 0);
  assert.equal(report.hasUnresolvedStreamAnalysis, false);
});

test('UNKNOWN summary stays visible when any candidate is unproven', () => {
  const known = note({ id: 'known', start: '0', end: JUST_BELOW.toString() });
  const unknown = note({ id: 'unk', start: '1', end: f('1').add(JUST_BELOW).toString() });
  const report = analyzeProjectMicroTiming(project({
    events: [known, unknown],
    decisions: [keepDecision({ event: known })],
  }));
  assert.equal(report.hasUnknown, true);
  assert.equal(report.unknownCount, 1);
});

test('P1-1 rational ordering detects multi-digit beat gap 9 -> 10', () => {
  const first = note({ id: 'A9', start: '9', end: '169/17' });
  const second = note({ id: 'B10', start: '10', end: '11' });
  assert.equal(compareEvents(first, second) < 0, true);
  assert.equal(compareEvents(second, first) > 0, true);
  assert.equal(String(first.start) < String(second.start), false);
  const report = analyzeProjectMicroTiming(project({ events: [second, first] }));
  const gap = report.intervals.find(item => item.intervalType === INTERVAL_TYPES.INTER_EVENT_GAP);
  assert.ok(gap);
  assert.equal(f(gap.length).toString(), '1/17');
  assert.equal(gap.identity.previousEventId, 'A9');
  assert.equal(gap.identity.nextEventId, 'B10');
});

test('P1-2 sustained overlap suppresses a fake inner pairwise gap', () => {
  const a = note({ id: 'ov-a', start: '0', end: '3' });
  const b = note({ id: 'ov-b', start: '1', end: '2' });
  const c = note({ id: 'ov-c', start: f('2').add(JUST_BELOW).toString(), end: '4' });
  const report = analyzeProjectMicroTiming(project({ events: [a, b, c] }));
  assert.equal(report.intervals.some(item => item.intervalType === INTERVAL_TYPES.INTER_EVENT_GAP), false);
  assert.equal(report.hasUnresolvedStreamAnalysis, false);
});

test('P1-2 role=null MusicXML-like parts are not fabricated as a gap', () => {
  const left = note({
    id: 'xml-p1',
    role: null,
    voice: '1',
    start: '0',
    end: '1',
    metadata: { partId: 'P1' },
  });
  const right = note({
    id: 'xml-p2',
    role: null,
    voice: '1',
    start: f('1').add(JUST_BELOW).toString(),
    end: '2',
    pitch: 64,
    metadata: { partId: 'P2' },
  });
  const report = analyzeProjectMicroTiming(project({ events: [left, right] }));
  assert.equal(report.intervals.some(item => item.intervalType === INTERVAL_TYPES.INTER_EVENT_GAP), false);
  assert.equal(report.hasUnresolvedStreamAnalysis, true);
  assert.equal(report.hasUnknown, true);
  assert.ok(report.unresolvedStreamIssues.length >= 1);
  assert.equal(report.unresolvedStreamIssues[0].reason, UNRESOLVED_STREAM_REASON);
});

test('P1-2 ordinary monophonic assigned-role gap is still detected', () => {
  const first = note({ id: 'mono-a', role: 'Melody', start: '0', end: '1' });
  const second = note({ id: 'mono-b', role: 'Melody', start: f('1').add(JUST_BELOW).toString(), end: '2' });
  const report = analyzeProjectMicroTiming(project({ events: [first, second] }));
  const gap = report.intervals.find(item => item.intervalType === INTERVAL_TYPES.INTER_EVENT_GAP);
  assert.ok(gap);
  assert.deepEqual(gap.eventIds, ['mono-a', 'mono-b']);
  assert.equal(report.hasUnresolvedStreamAnalysis, false);
});

test('P1-3 evidence ["trust me"] with no source binding is UNKNOWN', () => {
  const event = note({ id: 'trust', end: JUST_BELOW.toString() });
  const report = analyzeProjectMicroTiming(project({
    events: [event],
    decisions: [keepDecision({
      event,
      evidence: ['trust me'],
      extras: { evidenceSourceIds: [], metadata: { evidenceSourceIds: [] } },
    })],
  }));
  assert.equal(report.intervals[0].classification, MICRO_TIMING_CLASSIFICATIONS.UNKNOWN);
});

test('P1-3 unknown evidence source ID is UNKNOWN', () => {
  const event = note({ id: 'ghost-src', end: JUST_BELOW.toString() });
  const report = analyzeProjectMicroTiming(project({
    events: [event],
    decisions: [keepDecision({
      event,
      extras: { evidenceSourceIds: ['missing-source'] },
    })],
  }));
  assert.equal(report.intervals[0].classification, MICRO_TIMING_CLASSIFICATIONS.UNKNOWN);
});

test('P1-3 derived-only source claim does not auto-promote', () => {
  const derived = source({ id: 'tool-out', kind: 'derived', authority: 'derived', label: 'Tool dump' });
  const official = source();
  const event = note({ id: 'derived-only', end: JUST_BELOW.toString() });
  const report = analyzeProjectMicroTiming(project({
    sources: [official, derived],
    events: [event],
    decisions: [keepDecision({
      event,
      extras: { evidenceSourceIds: ['tool-out'] },
    })],
  }));
  assert.equal(report.intervals[0].classification, MICRO_TIMING_CLASSIFICATIONS.UNKNOWN);
});

test('P1-3 supporting-only source binding does not auto-promote', () => {
  const official = source();
  const supporting = source({
    id: 'third',
    kind: 'third-party-musicxml',
    authority: 'supporting',
    label: 'Third-party score',
  });
  const event = note({ id: 'support-only', end: JUST_BELOW.toString() });
  const report = analyzeProjectMicroTiming(project({
    sources: [official, supporting],
    events: [event],
    decisions: [keepDecision({
      event,
      extras: { evidenceSourceIds: ['third'] },
    })],
  }));
  assert.equal(report.intervals[0].classification, MICRO_TIMING_CLASSIFICATIONS.UNKNOWN);
});

test('P1-3 valid official source binding can establish SOURCE_SUPPORTED_MICROTIMING', () => {
  const event = note({ id: 'bound', end: JUST_BELOW.toString() });
  const report = analyzeProjectMicroTiming(project({
    events: [event],
    decisions: [keepDecision({
      event,
      extras: { evidenceSourceIds: ['src'] },
    })],
  }));
  assert.equal(report.intervals[0].classification, MICRO_TIMING_CLASSIFICATIONS.SOURCE_SUPPORTED_MICROTIMING);
});

test('P1-4 project metadata cannot spoof producer attestation', () => {
  const event = note({ id: 'spoof-meta', end: JUST_BELOW.toString(), adapter: 'fixture-adapter', origin: 'tool-derived' });
  const attestation = createTimingArtifactAttestation({
    producingModule: 'fixture-adapter',
    carriesNoMusicalMeaning: true,
    target: durationIdentity(event),
  });
  const report = analyzeProjectMicroTiming(project({
    events: [event],
    metadata: { timingArtifactAttestations: [attestation] },
  }));
  assert.equal(report.intervals[0].classification, MICRO_TIMING_CLASSIFICATIONS.UNKNOWN);
});

test('P1-4 same-name adapter string spoof cannot classify TECHNICAL_RESIDUE', () => {
  const event = note({ id: 'spoof-name', end: JUST_BELOW.toString(), adapter: 'studio/backend/score/musicxml.mjs', origin: 'tool-derived' });
  const report = analyzeProjectMicroTiming(project({ events: [event] }), {
    attestations: [createTimingArtifactAttestation({
      producingModule: 'studio/backend/score/musicxml.mjs',
      carriesNoMusicalMeaning: true,
      target: durationIdentity(event),
    })],
  });
  assert.equal(report.intervals[0].classification, MICRO_TIMING_CLASSIFICATIONS.UNKNOWN);
});

test('P1-4 source-notated timing cannot be turned technical by a fake adapter-name attestation', () => {
  const event = note({ id: 'spoof-notated', end: JUST_BELOW.toString(), adapter: 'studio/backend/score/musicxml.mjs', origin: 'source-notated' });
  const report = analyzeProjectMicroTiming(project({ events: [event] }), {
    attestations: [createTimingArtifactAttestation({
      producingModule: 'studio/backend/score/musicxml.mjs',
      carriesNoMusicalMeaning: true,
      target: durationIdentity(event),
    })],
  });
  assert.equal(report.intervals[0].classification, MICRO_TIMING_CLASSIFICATIONS.UNKNOWN);
  assert.notEqual(report.intervals[0].classification, MICRO_TIMING_CLASSIFICATIONS.TECHNICAL_RESIDUE);
});

test('interval identity key is stable for matching', () => {
  const event = note({ id: 'key', start: '0', end: JUST_BELOW.toString() });
  const a = durationIdentity(event);
  assert.equal(identitiesMatch(a, durationIdentity(event)), true);
  assert.equal(intervalIdentityKey(a).includes(event.id), true);
});

test('P1-stream: unassigned different-part pair is not a fabricated gap', () => {
  const left = note({ id: 'part-a', role: null, voice: '1', start: '0', end: '1', metadata: { partId: 'P1' } });
  const right = note({
    id: 'part-b',
    role: null,
    voice: '1',
    start: f('1').add(JUST_BELOW).toString(),
    end: '2',
    pitch: 67,
    metadata: { partId: 'P2' },
  });
  const report = analyzeProjectMicroTiming(project({ events: [left, right] }));
  assert.equal(report.intervals.some(item => item.intervalType === INTERVAL_TYPES.INTER_EVENT_GAP), false);
});

test('P1-stream: same unassigned pair is not a silent clean analysis', () => {
  const left = note({ id: 'open-a', role: null, start: '0', end: '1' });
  const right = note({
    id: 'open-b',
    role: null,
    start: f('1').add(JUST_BELOW).toString(),
    end: '2',
    pitch: 64,
  });
  const report = analyzeProjectMicroTiming(project({ events: [left, right] }));
  assert.notEqual(report.hasUnresolvedStreamAnalysis, false);
  assert.notEqual(report.hasUnknown, false);
  assert.ok(report.unresolvedStreamIssueCount >= 1);
});

test('P1-stream: unresolved diagnostic names the unassigned events without inventing identity', () => {
  const left = note({ id: 'diag-a', role: null, start: '0', end: '1' });
  const right = note({
    id: 'diag-b',
    role: null,
    start: f('1').add(JUST_BELOW).toString(),
    end: '2',
    pitch: 65,
  });
  const report = analyzeProjectMicroTiming(project({ events: [left, right] }));
  const issue = report.unresolvedStreamIssues.find(item => (
    item.eventIds.includes('diag-a') && item.eventIds.includes('diag-b')
  ));
  assert.ok(issue);
  assert.equal(issue.reason, UNRESOLVED_STREAM_REASON);
  assert.equal(Object.hasOwn(issue, 'type'), false);
  assert.equal(Object.hasOwn(issue, 'previousEventId'), false);
});

test('P1-stream: assigned monophonic gap still works and is not unresolved', () => {
  const first = note({ id: 'assigned-a', role: 'Melody', start: '0', end: '1' });
  const second = note({ id: 'assigned-b', role: 'Melody', start: f('1').add(JUST_BELOW).toString(), end: '2' });
  const report = analyzeProjectMicroTiming(project({ events: [first, second] }));
  const gap = report.intervals.find(item => item.intervalType === INTERVAL_TYPES.INTER_EVENT_GAP);
  assert.ok(gap);
  assert.equal(report.hasUnresolvedStreamAnalysis, false);
  assert.deepEqual(report.unresolvedStreamIssues, []);
});

test('P1-stream: assigned-role overlap remains suppressed and resolved', () => {
  const a = note({ id: 'cov-a', role: 'Chord1', start: '0', end: '3', pitch: 60 });
  const b = note({ id: 'cov-b', role: 'Chord1', start: '1', end: '2', pitch: 64 });
  const c = note({ id: 'cov-c', role: 'Chord1', start: f('2').add(JUST_BELOW).toString(), end: '4', pitch: 67 });
  const report = analyzeProjectMicroTiming(project({ events: [a, b, c] }));
  assert.equal(report.intervals.some(item => item.intervalType === INTERVAL_TYPES.INTER_EVENT_GAP), false);
  assert.equal(report.hasUnresolvedStreamAnalysis, false);
});

test('P1-stream: fully assigned clean project is not marked unresolved', () => {
  const report = analyzeProjectMicroTiming(project({ events: [
    note({ id: 'clean-a', role: 'Melody', start: '0', end: '1' }),
    note({ id: 'clean-b', role: 'Melody', start: '1', end: '2' }),
    note({ id: 'clean-c', role: 'Chord1', start: '0', end: '2', pitch: 64 }),
  ] }));
  assert.equal(report.hasUnresolvedStreamAnalysis, false);
  assert.equal(report.hasUnknown, false);
  assert.equal(report.unresolvedStreamIssueCount, 0);
  assert.deepEqual(report.unresolvedStreamIssues, []);
});

test('P1-stream: lone unassigned event without a peer relationship is not unresolved', () => {
  const report = analyzeProjectMicroTiming(project({ events: [
    note({ id: 'lone-null', role: null, start: '0', end: '1' }),
  ] }));
  assert.equal(report.hasUnresolvedStreamAnalysis, false);
  assert.equal(report.intervals.some(item => item.intervalType === INTERVAL_TYPES.INTER_EVENT_GAP), false);
});

test('P1-stream: unassigned pair does not mutate event or source metadata', () => {
  const events = [
    note({ id: 'mut-null-a', role: null, start: '0', end: '1', pitch: 60 }),
    note({ id: 'mut-null-b', role: null, start: f('1').add(JUST_BELOW).toString(), end: '2', pitch: 62 }),
  ];
  const before = snapshot(events);
  analyzeProjectMicroTiming(project({ events }));
  assert.deepEqual(snapshot(events), before);
});

test('P1-key: delimiter-colliding gap identities are distinct', () => {
  const leftA = createIntervalIdentity({
    type: INTERVAL_TYPES.INTER_EVENT_GAP,
    previousEventId: 'a',
    nextEventId: 'b->c',
    start: '1',
    end: f('1').add(JUST_BELOW).toString(),
  });
  const leftB = createIntervalIdentity({
    type: INTERVAL_TYPES.INTER_EVENT_GAP,
    previousEventId: 'a->b',
    nextEventId: 'c',
    start: '1',
    end: f('1').add(JUST_BELOW).toString(),
  });
  assert.notEqual(leftA.previousEventId, leftB.previousEventId);
  assert.notEqual(leftA.nextEventId, leftB.nextEventId);
  assert.notEqual(intervalIdentityKey(leftA), intervalIdentityKey(leftB));
});

test('P1-key: identitiesMatch is structural and rejects delimiter collisions', () => {
  const pairA = createIntervalIdentity({
    type: INTERVAL_TYPES.INTER_EVENT_GAP,
    previousEventId: 'a',
    nextEventId: 'b->c',
    start: '0',
    end: JUST_BELOW.toString(),
  });
  const pairB = createIntervalIdentity({
    type: INTERVAL_TYPES.INTER_EVENT_GAP,
    previousEventId: 'a->b',
    nextEventId: 'c',
    start: '0',
    end: JUST_BELOW.toString(),
  });
  assert.equal(identitiesMatch(pairA, pairB), false);
  assert.equal(identitiesMatch(pairA, pairA), true);
});

test('P1-key: ordinary event ids still match deterministically', () => {
  const event = note({ id: 'ordinary', start: '0', end: JUST_BELOW.toString() });
  const first = durationIdentity(event);
  const second = durationIdentity(event);
  assert.equal(identitiesMatch(first, second), true);
  assert.equal(intervalIdentityKey(first), intervalIdentityKey(second));
  const report = analyzeProjectMicroTiming(project({
    events: [event],
    decisions: [keepDecision({ event })],
  }));
  assert.equal(report.intervals[0].classification, MICRO_TIMING_CLASSIFICATIONS.SOURCE_SUPPORTED_MICROTIMING);
});

test('P1-key: unresolved-stream dedupe does not collapse delimiter-colliding pairs', () => {
  const rightStart = f('1').add(JUST_BELOW).toString();
  const events = [
    note({ id: 'a', role: null, start: '0', end: '1', pitch: 60 }),
    note({ id: 'a->b', role: null, start: '0', end: '1', pitch: 64 }),
    note({ id: 'b->c', role: null, start: rightStart, end: '2', pitch: 62 }),
    note({ id: 'c', role: null, start: rightStart, end: '2', pitch: 65 }),
  ];
  const report = analyzeProjectMicroTiming(project({ events }));
  assert.equal(report.unresolvedStreamIssueCount, 4);
  const expectedPairs = [
    ['a', 'b->c'],
    ['a', 'c'],
    ['a->b', 'b->c'],
    ['a->b', 'c'],
  ];
  for (const [leftId, rightId] of expectedPairs) {
    assert.ok(
      report.unresolvedStreamIssues.some(item => (
        item.eventIds[0] === leftId && item.eventIds[1] === rightId
      )),
      `missing unresolved pair ${leftId} / ${rightId}`,
    );
  }
  assert.equal(report.hasUnresolvedStreamAnalysis, true);
});

test('P1-key: delimiter ids do not mutate events', () => {
  const events = [
    note({ id: 'a', role: 'Melody', start: '0', end: '1' }),
    note({ id: 'b->c', role: 'Melody', start: f('1').add(JUST_BELOW).toString(), end: '2', pitch: 64 }),
  ];
  const before = snapshot(events);
  const report = analyzeProjectMicroTiming(project({ events }));
  const gap = report.intervals.find(item => item.intervalType === INTERVAL_TYPES.INTER_EVENT_GAP);
  assert.ok(gap);
  assert.equal(gap.identity.previousEventId, 'a');
  assert.equal(gap.identity.nextEventId, 'b->c');
  assert.deepEqual(snapshot(events), before);
});

function classifyWithBoundSource({ id, kind, authority, label }) {
  const bound = source({ id, kind, authority, label });
  const event = note({ id: `evt:${id}`, end: JUST_BELOW.toString(), sourceId: id });
  return analyzeProjectMicroTiming(project({
    sources: [bound],
    events: [event],
    decisions: [keepDecision({
      event,
      extras: { evidenceSourceIds: [id], id: `keep:${id}` },
    })],
  })).intervals[0].classification;
}

test('F2: third-party-midi + spoofed primary-symbolic cannot establish SOURCE_SUPPORTED', () => {
  assert.equal(classifyWithBoundSource({
    id: 'spoof-tp-midi',
    kind: 'third-party-midi',
    authority: 'primary-symbolic',
    label: 'Spoofed third-party MIDI',
  }), MICRO_TIMING_CLASSIFICATIONS.UNKNOWN);
});

test('F2: third-party-musicxml + spoofed primary-symbolic cannot establish SOURCE_SUPPORTED', () => {
  assert.equal(classifyWithBoundSource({
    id: 'spoof-tp-xml',
    kind: 'third-party-musicxml',
    authority: 'primary-symbolic',
    label: 'Spoofed third-party MusicXML',
  }), MICRO_TIMING_CLASSIFICATIONS.UNKNOWN);
});

test('F2: current-mml + spoofed primary-symbolic cannot establish SOURCE_SUPPORTED', () => {
  assert.equal(classifyWithBoundSource({
    id: 'spoof-current-mml',
    kind: 'current-mml',
    authority: 'primary-symbolic',
    label: 'Spoofed current MML',
  }), MICRO_TIMING_CLASSIFICATIONS.UNKNOWN);
});

test('F2: historical-mml + spoofed primary-symbolic cannot establish SOURCE_SUPPORTED', () => {
  assert.equal(classifyWithBoundSource({
    id: 'spoof-hist-mml',
    kind: 'historical-mml',
    authority: 'primary-symbolic',
    label: 'Spoofed historical MML',
  }), MICRO_TIMING_CLASSIFICATIONS.UNKNOWN);
});

test('F2: derived + spoofed primary-symbolic cannot establish SOURCE_SUPPORTED', () => {
  assert.equal(classifyWithBoundSource({
    id: 'spoof-derived',
    kind: 'derived',
    authority: 'primary-symbolic',
    label: 'Spoofed derived dump',
  }), MICRO_TIMING_CLASSIFICATIONS.UNKNOWN);
});

test('F2: official-midi + primary-symbolic may establish SOURCE_SUPPORTED', () => {
  assert.equal(classifyWithBoundSource({
    id: 'ok-official-midi',
    kind: 'official-midi',
    authority: 'primary-symbolic',
    label: 'Official MIDI',
  }), MICRO_TIMING_CLASSIFICATIONS.SOURCE_SUPPORTED_MICROTIMING);
});

test('F2: official-musicxml + primary-symbolic may establish SOURCE_SUPPORTED', () => {
  assert.equal(classifyWithBoundSource({
    id: 'ok-official-xml',
    kind: 'official-musicxml',
    authority: 'primary-symbolic',
    label: 'Official MusicXML',
  }), MICRO_TIMING_CLASSIFICATIONS.SOURCE_SUPPORTED_MICROTIMING);
});

test('F2: original-audio + primary-audio may establish SOURCE_SUPPORTED', () => {
  assert.equal(classifyWithBoundSource({
    id: 'ok-audio',
    kind: 'original-audio',
    authority: 'primary-audio',
    label: 'Original official audio',
  }), MICRO_TIMING_CLASSIFICATIONS.SOURCE_SUPPORTED_MICROTIMING);
});

test('F2: supporting third-party plus real primary binding may establish SOURCE_SUPPORTED', () => {
  const official = source({ id: 'official', kind: 'official-musicxml', authority: 'primary-symbolic', label: 'Official score' });
  const supporting = source({ id: 'third', kind: 'third-party-midi', authority: 'supporting', label: 'Community MIDI' });
  const event = note({ id: 'combo', end: JUST_BELOW.toString(), sourceId: 'official' });
  const report = analyzeProjectMicroTiming(project({
    sources: [official, supporting],
    events: [event],
    decisions: [keepDecision({
      event,
      extras: { evidenceSourceIds: ['third', 'official'] },
    })],
  }));
  assert.equal(report.intervals[0].classification, MICRO_TIMING_CLASSIFICATIONS.SOURCE_SUPPORTED_MICROTIMING);
});

test('F2: imported spoofed source with accepted keep still UNKNOWN without real primary', () => {
  const spoof = source({
    id: 'imported-spoof',
    kind: 'third-party-midi',
    authority: 'primary-symbolic',
    label: 'Imported authority spoof',
  });
  const event = note({ id: 'imported', end: JUST_BELOW.toString(), sourceId: 'imported-spoof' });
  const report = analyzeProjectMicroTiming(project({
    sources: [spoof],
    events: [event],
    decisions: [keepDecision({
      event,
      extras: { evidenceSourceIds: ['imported-spoof'] },
    })],
  }));
  assert.equal(report.intervals[0].classification, MICRO_TIMING_CLASSIFICATIONS.UNKNOWN);
  assert.equal(report.intervals[0].classificationBasis, 'accepted-keep-decision-without-admissible-source-binding');
});
