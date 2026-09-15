// G10 C2B Phase B — source-aware micro-timing in per-song readiness / Final.
//
// Published MOBILE_SYNTAX forbids technical micro-gaps and decomposition
// components finer than 1/64 only where they carry no source-supported musical
// meaning. A sub-grid interval is therefore never forbidden merely for being
// short, and "short" is never by itself a PASS either. These regressions pin
// the four outcomes the readiness gate must keep apart, and pin what a
// microTiming PASS does *not* mean.
import test from 'node:test';
import assert from 'node:assert/strict';
import { f, F } from '../backend/mml/index.mjs';
import {
  createSource,
  createCanonicalNoteEvent,
  createCanonicalRestEvent,
  createCanonicalProject,
  createArbitrationDecision,
} from '../backend/canonical/index.mjs';
import { createTimingProvenance } from '../backend/canonical/timing.mjs';
import {
  INTERVAL_TYPES,
  MICRO_TIMING_CLASSIFICATIONS,
  MICRO_TIMING_KEEP_ACTION,
  MICRO_TIMING_TECHNICAL_ACTIONS,
  createIntervalIdentity,
  intervalIdentityKey,
  intervalIdentityLabel,
} from '../backend/canonical/micro-timing.mjs';
import { evaluateProjectReadiness } from '../backend/final/readiness.mjs';
import {
  STUDIO_IMPLEMENTATION,
  STUDIO_FINAL_MODULE_BLOCKERS,
  studioFinalBlockers,
} from '../backend/rules/index.mjs';

const KEEP = MICRO_TIMING_KEEP_ACTION;
const TECHNICAL = MICRO_TIMING_TECHNICAL_ACTIONS[0];
const JUST_BELOW = new F(1, 17);
const EXACT_GRID = new F(1, 16);

const OFFICIAL = createSource({
  id: 'official',
  label: 'Official score',
  kind: 'official-musicxml',
  authority: 'primary-symbolic',
});
const OFFICIAL_AUDIO = createSource({
  id: 'audio',
  label: 'Original official audio',
  kind: 'original-audio',
  authority: 'primary-audio',
});
const SUPPORTING_THIRD_PARTY = createSource({
  id: 'third',
  label: 'Community MIDI',
  kind: 'third-party-midi',
  authority: 'supporting',
});
const SPOOFED_THIRD_PARTY = createSource({
  id: 'spoof',
  label: 'Third-party MIDI claiming primary authority',
  kind: 'third-party-midi',
  authority: 'primary-symbolic',
});

function note({ id, start = '0', end = '1', role = 'Melody', pitch = 60, sourceId = 'official', origin = null }) {
  return createCanonicalNoteEvent({
    id,
    pitch,
    start: String(start),
    end: String(end),
    role,
    sourceIds: [sourceId],
    sourceEventIds: [`${id}/${sourceId}`],
    metadata: origin
      ? {
        timing: createTimingProvenance({
          adapter: 'fixture-adapter',
          start: { origin },
          duration: { origin },
          end: { origin },
        }),
      }
      : {},
  });
}

function rest({ id, start, end, role = 'Melody', sourceId = 'official' }) {
  return createCanonicalRestEvent({
    id,
    start: String(start),
    end: String(end),
    role,
    sourceIds: [sourceId],
    sourceEventIds: [`${id}/${sourceId}`],
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
  identity = null,
  status = 'accepted',
  evidence = ['official score, measure 1, written 128th'],
  evidenceSourceIds = ['official'],
  id = null,
}) {
  const target = identity ?? durationIdentity(event);
  const eventIds = target.type === INTERVAL_TYPES.EVENT_DURATION
    ? [target.eventId]
    : [target.previousEventId, target.nextEventId];
  return createArbitrationDecision({
    id: id ?? `keep:${eventIds.join('+')}`,
    eventIds,
    action: KEEP,
    status,
    reason: 'Explicit source-supported micro-timing keep.',
    evidence,
    metadata: { intervalIdentity: target, evidenceSourceIds },
  });
}

function technicalDecision({ event, identity = null, id = null }) {
  const target = identity ?? durationIdentity(event);
  const eventIds = target.type === INTERVAL_TYPES.EVENT_DURATION
    ? [target.eventId]
    : [target.previousEventId, target.nextEventId];
  return createArbitrationDecision({
    id: id ?? `tech:${eventIds.join('+')}`,
    eventIds,
    action: TECHNICAL,
    status: 'accepted',
    reason: 'Explicit meaning-free technical residue classification.',
    evidence: ['producer log: inserted alignment pad'],
    metadata: { intervalIdentity: target },
  });
}

// A candidate whose every other readiness gate passes, so microTiming is the
// only variable. The Source-Faithful Baseline snapshot carries the same events
// as the candidate, which keeps the baseline and Lead-demotion gates clean.
function candidate({ events, decisions = [], sources = [OFFICIAL], metadata = {} }) {
  const baseline = createCanonicalProject({
    id: 'baseline:source-faithful',
    title: 'Source-Faithful Baseline',
    sources,
    events,
    metadata: { sourceComplete: true, baselineKind: 'source-faithful' },
  });
  return createCanonicalProject({
    id: 'song-c2b',
    title: 'C2B micro-timing song',
    sources,
    events,
    decisions,
    metadata: {
      sourceComplete: true,
      sourceFaithfulBaseline: { snapshot: baseline },
      audioAlignmentEvidence: [{ sourceId: 'original-audio', warnings: [], metrics: { confidence: 0.9 } }],
      ...metadata,
    },
  });
}

function readiness(project, overrides = {}) {
  return evaluateProjectReadiness({
    project,
    mmlValidation: { ok: true, errors: [] },
    core3Report: { status: 'PASS', blockers: [] },
    harmonyReport: { status: 'PASS', unresolvedCount: 0 },
    leadDemotionReports: [],
    lineageReport: null,
    versionDriftReviewed: false,
    playerReadback: 'PASS',
    originalAudioRequired: true,
    inGameAcceptance: 'PENDING',
    ...overrides,
  });
}

function timingSnapshot(project) {
  return JSON.parse(JSON.stringify(project.events.map(event => ({
    id: event.id,
    start: event.start,
    end: event.end,
    role: event.role,
    kind: event.kind,
  }))));
}

// A single sub-grid event duration, optionally with a decision about it.
function subGridDurationProject({ decisions = [], sources = [OFFICIAL], sourceId = 'official' } = {}) {
  const event = note({ id: 'micro', start: '0', end: JUST_BELOW.toString(), sourceId });
  return {
    event,
    project: candidate({
      events: [event],
      sources,
      decisions: decisions.map(make => make(event)),
    }),
  };
}

// ---------------------------------------------------------------------------
// 1-2. PASS: nothing sub-grid, and the 1/64 boundary itself
// ---------------------------------------------------------------------------

test('C2B-1 a project with no sub-grid candidate is microTiming PASS', () => {
  const result = readiness(candidate({ events: [note({ id: 'plain', start: '0', end: '1' })] }));
  assert.equal(result.gates.microTiming.status, 'PASS');
  assert.equal(result.gates.microTiming.candidateCount, 0);
  assert.equal(result.gates.microTiming.technicalResidueCount, 0);
  assert.equal(result.gates.microTiming.unknownCount, 0);
  assert.equal(result.gates.microTiming.unresolvedStreamIssueCount, 0);
  assert.equal(Object.hasOwn(result.gates.microTiming, 'blockers'), false);
  assert.equal(result.candidateReady, true);
});

test('C2B-2 exactly 1/64 is not treated as a forbidden sub-grid interval', () => {
  const events = [
    note({ id: 'exact-duration', start: '0', end: EXACT_GRID.toString() }),
    note({ id: 'after-exact-gap', start: f(1).add(EXACT_GRID).toString(), end: '2', pitch: 64 }),
    note({ id: 'before-exact-gap', start: EXACT_GRID.toString(), end: '1', pitch: 62 }),
  ];
  const result = readiness(candidate({ events }));
  assert.equal(result.gates.microTiming.status, 'PASS');
  assert.equal(result.gates.microTiming.candidateCount, 0);
  assert.equal(result.gates.microTiming.safeGrid, '1/16');
  assert.equal(result.candidateReady, true);
});

// ---------------------------------------------------------------------------
// 3-5. PASS through proven source support
// ---------------------------------------------------------------------------

test('C2B-3 an official-symbolic source-supported keep is microTiming PASS', () => {
  const { project } = subGridDurationProject({ decisions: [event => keepDecision({ event })] });
  const result = readiness(project);
  assert.equal(result.gates.microTiming.status, 'PASS');
  assert.equal(result.gates.microTiming.candidateCount, 1);
  assert.equal(result.gates.microTiming.sourceSupportedCount, 1);
  assert.equal(result.gates.microTiming.unknownCount, 0);
  assert.equal(result.candidateReady, true);
});

test('C2B-3b a source-supported sub-grid interval is kept, not quantized away, to reach PASS', () => {
  const { project } = subGridDurationProject({ decisions: [event => keepDecision({ event })] });
  const before = timingSnapshot(project);
  const result = readiness(project);
  assert.equal(result.gates.microTiming.status, 'PASS');
  assert.deepEqual(timingSnapshot(project), before);
  assert.equal(project.events[0].end, JUST_BELOW.toString());
});

test('C2B-4 an original-audio source-supported keep is microTiming PASS', () => {
  const { project } = subGridDurationProject({
    sources: [OFFICIAL, OFFICIAL_AUDIO],
    sourceId: 'audio',
    decisions: [event => keepDecision({ event, evidenceSourceIds: ['audio'], evidence: ['original audio A/B at 00:42'] })],
  });
  const result = readiness(project);
  assert.equal(result.gates.microTiming.status, 'PASS');
  assert.equal(result.gates.microTiming.sourceSupportedCount, 1);
});

test('C2B-5 a supporting third-party source alongside a genuine cited primary is microTiming PASS', () => {
  const { project } = subGridDurationProject({
    sources: [OFFICIAL, SUPPORTING_THIRD_PARTY],
    decisions: [event => keepDecision({ event, evidenceSourceIds: ['third', 'official'] })],
  });
  const result = readiness(project);
  assert.equal(result.gates.microTiming.status, 'PASS');
  assert.equal(result.gates.microTiming.sourceSupportedCount, 1);
});

// ---------------------------------------------------------------------------
// 6-10. PENDING: unproven source support
// ---------------------------------------------------------------------------

test('C2B-6 a third-party record spoofing primary-symbolic authority is microTiming PENDING', () => {
  const { project } = subGridDurationProject({
    sources: [SPOOFED_THIRD_PARTY],
    sourceId: 'spoof',
    decisions: [event => keepDecision({ event, evidenceSourceIds: ['spoof'] })],
  });
  const result = readiness(project);
  assert.equal(result.gates.microTiming.status, 'PENDING');
  assert.deepEqual(result.gates.microTiming.blockers, ['MICRO_TIMING_CLASSIFICATION_UNKNOWN']);
  assert.equal(result.gates.microTiming.sourceSupportedCount, 0);
  assert.equal(
    result.gates.microTiming.unknownIntervals[0].classificationBasis,
    'accepted-keep-decision-without-admissible-source-binding',
  );
  assert.equal(result.candidateReady, false);
});

test('C2B-7 an accepted keep with empty evidence is microTiming PENDING', () => {
  const { project } = subGridDurationProject({ decisions: [event => keepDecision({ event, evidence: [] })] });
  const result = readiness(project);
  assert.equal(result.gates.microTiming.status, 'PENDING');
  assert.equal(result.gates.microTiming.unknownCount, 1);
  assert.equal(
    result.gates.microTiming.unknownIntervals[0].classificationBasis,
    'accepted-keep-decision-empty-evidence',
  );
});

test('C2B-8 an accepted keep whose cited source cannot be resolved is microTiming PENDING', () => {
  const { project } = subGridDurationProject({
    decisions: [event => keepDecision({ event, evidenceSourceIds: ['no-such-source'] })],
  });
  const result = readiness(project);
  assert.equal(result.gates.microTiming.status, 'PENDING');
  assert.equal(result.gates.microTiming.unknownCount, 1);
});

test('C2B-8b an accepted keep citing no source at all is microTiming PENDING', () => {
  const { project } = subGridDurationProject({
    decisions: [event => keepDecision({ event, evidenceSourceIds: [] })],
  });
  assert.equal(readiness(project).gates.microTiming.status, 'PENDING');
});

test('C2B-9 a pending keep decision is microTiming PENDING', () => {
  const { project } = subGridDurationProject({
    decisions: [event => keepDecision({ event, status: 'pending' })],
  });
  const result = readiness(project);
  assert.equal(result.gates.microTiming.status, 'PENDING');
  assert.equal(result.gates.microTiming.unknownIntervals[0].classificationBasis, 'pending-keep-decision');
});

test('C2B-10 a rejected keep decision is not source-supported and is microTiming PENDING', () => {
  const { project } = subGridDurationProject({
    decisions: [event => keepDecision({ event, status: 'rejected' })],
  });
  const result = readiness(project);
  assert.equal(result.gates.microTiming.status, 'PENDING');
  assert.equal(result.gates.microTiming.sourceSupportedCount, 0);
  assert.equal(result.gates.microTiming.unknownIntervals[0].classificationBasis, 'rejected-keep-decision');
});

test('C2B-10b a sub-grid interval with no decision at all is microTiming PENDING', () => {
  const { project } = subGridDurationProject();
  const result = readiness(project);
  assert.equal(result.gates.microTiming.status, 'PENDING');
  assert.equal(result.gates.microTiming.unknownIntervals[0].classificationBasis, 'insufficient-proof');
});

// ---------------------------------------------------------------------------
// 11-13. FAIL: confirmed technical residue
// ---------------------------------------------------------------------------

test('C2B-11 an accepted technical-residue decision is microTiming FAIL', () => {
  const { project, event } = subGridDurationProject({ decisions: [item => technicalDecision({ event: item })] });
  const result = readiness(project);
  assert.equal(result.gates.microTiming.status, 'FAIL');
  assert.deepEqual(result.gates.microTiming.blockers, ['MICRO_TIMING_TECHNICAL_RESIDUE_PRESENT']);
  assert.equal(result.gates.microTiming.technicalResidueCount, 1);
  const [failing] = result.gates.microTiming.technicalResidueIntervals;
  assert.equal(failing.identityKey, intervalIdentityKey(durationIdentity(event)));
  assert.deepEqual(failing.eventIds, ['micro']);
  assert.equal(failing.length, JUST_BELOW.toString());
  assert.equal(failing.classification, MICRO_TIMING_CLASSIFICATIONS.TECHNICAL_RESIDUE);
  assert.equal(result.candidateReady, false);
});

test('C2B-11b readiness reports technical residue without mutating or deleting it', () => {
  const { project } = subGridDurationProject({ decisions: [item => technicalDecision({ event: item })] });
  const before = timingSnapshot(project);
  assert.equal(readiness(project).gates.microTiming.status, 'FAIL');
  assert.deepEqual(timingSnapshot(project), before);
  assert.equal(project.events.length, 1);
});

test('C2B-12 several confirmed technical residues FAIL with complete counts and identities', () => {
  const first = note({ id: 'residue-a', start: '0', end: JUST_BELOW.toString() });
  const second = note({ id: 'residue-b', start: '4', end: f(4).add(JUST_BELOW).toString(), pitch: 62 });
  const third = note({ id: 'residue-c', start: '8', end: f(8).add(JUST_BELOW).toString(), pitch: 64 });
  const project = candidate({
    events: [first, second, third],
    decisions: [
      technicalDecision({ event: first }),
      technicalDecision({ event: second }),
      technicalDecision({ event: third }),
    ],
  });
  const gate = readiness(project).gates.microTiming;
  assert.equal(gate.status, 'FAIL');
  assert.equal(gate.candidateCount, 3);
  assert.equal(gate.technicalResidueCount, 3);
  assert.equal(gate.unknownCount, 0);
  assert.equal(gate.technicalResidueIntervals.length, 3);
  assert.deepEqual(
    [...gate.technicalResidueIntervals.map(item => item.eventIds[0])].sort(),
    ['residue-a', 'residue-b', 'residue-c'],
  );
});

test('C2B-13 technical residue plus UNKNOWN stays FAIL but keeps the unknown diagnostics', () => {
  const residue = note({ id: 'residue', start: '0', end: JUST_BELOW.toString() });
  const unproven = note({ id: 'unproven', start: '4', end: f(4).add(JUST_BELOW).toString(), pitch: 62 });
  const project = candidate({
    events: [residue, unproven],
    decisions: [technicalDecision({ event: residue })],
  });
  const gate = readiness(project).gates.microTiming;
  assert.equal(gate.status, 'FAIL');
  assert.deepEqual(gate.blockers, [
    'MICRO_TIMING_TECHNICAL_RESIDUE_PRESENT',
    'MICRO_TIMING_CLASSIFICATION_UNKNOWN',
  ]);
  assert.equal(gate.technicalResidueCount, 1);
  assert.equal(gate.unknownCount, 1);
  assert.equal(gate.hasUnknown, true);
  assert.deepEqual(gate.unknownIntervals.map(item => item.eventIds[0]), ['unproven']);
  assert.deepEqual(gate.technicalResidueIntervals.map(item => item.eventIds[0]), ['residue']);
});

test('C2B-13b technical residue plus an unresolved stream stays FAIL and keeps both blockers', () => {
  const residue = note({ id: 'residue', start: '0', end: JUST_BELOW.toString() });
  const left = note({ id: 'null-a', start: '4', end: '5', role: null, pitch: 62 });
  const right = note({ id: 'null-b', start: f(5).add(JUST_BELOW).toString(), end: '6', role: null, pitch: 64 });
  const project = candidate({
    events: [residue, left, right],
    decisions: [technicalDecision({ event: residue })],
  });
  const gate = readiness(project).gates.microTiming;
  assert.equal(gate.status, 'FAIL');
  assert.deepEqual(gate.blockers, [
    'MICRO_TIMING_TECHNICAL_RESIDUE_PRESENT',
    'MICRO_TIMING_STREAM_IDENTITY_UNRESOLVED',
  ]);
  assert.equal(gate.unresolvedStreamIssueCount, 1);
  assert.equal(gate.hasUnresolvedStreamAnalysis, true);
});

// ---------------------------------------------------------------------------
// 14-15. Unresolved role-null stream identity
// ---------------------------------------------------------------------------

test('C2B-14 an unresolved role-null stream relationship is microTiming PENDING', () => {
  const left = note({ id: 'null-a', start: '0', end: '1', role: null });
  const right = note({ id: 'null-b', start: f(1).add(JUST_BELOW).toString(), end: '2', role: null, pitch: 64 });
  const gate = readiness(candidate({ events: [left, right] })).gates.microTiming;
  assert.equal(gate.status, 'PENDING');
  assert.deepEqual(gate.blockers, ['MICRO_TIMING_STREAM_IDENTITY_UNRESOLVED']);
  assert.equal(gate.unresolvedStreamIssueCount, 1);
  assert.deepEqual(gate.unresolvedStreamIssues[0].eventIds, ['null-a', 'null-b']);
  assert.equal(gate.candidateCount, 0);
  assert.equal(readiness(candidate({ events: [left, right] })).candidateReady, false);
});

test('C2B-15 a lone role-null event with no peer relationship fabricates no blocker', () => {
  const gate = readiness(candidate({
    events: [note({ id: 'lonely-null', start: '0', end: '1', role: null })],
  })).gates.microTiming;
  assert.equal(gate.status, 'PASS');
  assert.equal(gate.unresolvedStreamIssueCount, 0);
  assert.equal(gate.candidateCount, 0);
  assert.equal(Object.hasOwn(gate, 'blockers'), false);
});

test('C2B-15b a role-null event far from every peer fabricates no blocker', () => {
  const gate = readiness(candidate({
    events: [
      note({ id: 'assigned', start: '0', end: '1' }),
      note({ id: 'far-null', start: '8', end: '9', role: null, pitch: 64 }),
    ],
  })).gates.microTiming;
  assert.equal(gate.status, 'PASS');
  assert.equal(gate.unresolvedStreamIssueCount, 0);
});

// ---------------------------------------------------------------------------
// 16-17. What a microTiming PASS is not
// ---------------------------------------------------------------------------

test('C2B-16 source-supported micro-timing never sets finalRepresentable', () => {
  const { project } = subGridDurationProject({ decisions: [event => keepDecision({ event })] });
  const gate = readiness(project).gates.microTiming;
  assert.equal(gate.status, 'PASS');
  assert.equal(gate.finalRepresentable, null);
  assert.notEqual(gate.finalRepresentable, true);
});

test('C2B-17 source-supported micro-timing does not bypass a failing MML technical gate', () => {
  const { project } = subGridDurationProject({ decisions: [event => keepDecision({ event })] });
  const result = readiness(project, {
    mmlValidation: { ok: false, errors: [{ message: 'Strict Mobile rejects c128' }] },
  });
  assert.equal(result.gates.microTiming.status, 'PASS');
  assert.equal(result.gates.technical.status, 'FAIL');
  assert.equal(result.candidateReady, false);
  assert.ok(result.preGameBlocking.includes('technical'));
  assert.ok(!result.preGameBlocking.includes('microTiming'));
});

test('C2B-17b the technical MML gate and the micro-timing gate stay separate results', () => {
  const { project } = subGridDurationProject({ decisions: [event => technicalDecision({ event })] });
  const result = readiness(project);
  assert.equal(result.gates.technical.status, 'PASS');
  assert.equal(result.gates.microTiming.status, 'FAIL');
  assert.notEqual(result.gates.technical, result.gates.microTiming);
  assert.equal(Object.hasOwn(result.gates.technical, 'candidateCount'), false);
  assert.equal(Object.hasOwn(result.gates.microTiming, 'errors'), false);
});

// ---------------------------------------------------------------------------
// 18-21. Blocking behaviour
// ---------------------------------------------------------------------------

test('C2B-18 microTiming PENDING blocks candidateReady', () => {
  const { project } = subGridDurationProject();
  const result = readiness(project);
  assert.equal(result.gates.microTiming.status, 'PENDING');
  assert.equal(result.candidateReady, false);
  assert.deepEqual(result.preGameBlocking, ['microTiming']);
});

test('C2B-19 microTiming FAIL blocks candidateReady', () => {
  const { project } = subGridDurationProject({ decisions: [event => technicalDecision({ event })] });
  const result = readiness(project);
  assert.equal(result.gates.microTiming.status, 'FAIL');
  assert.equal(result.candidateReady, false);
  assert.deepEqual(result.preGameBlocking, ['microTiming']);
});

test('C2B-20 microTiming PASS does not imply finalAccepted', () => {
  const { project } = subGridDurationProject({ decisions: [event => keepDecision({ event })] });
  const result = readiness(project);
  assert.equal(result.gates.microTiming.status, 'PASS');
  assert.equal(result.candidateReady, true);
  assert.equal(result.finalAccepted, false);
  assert.equal(result.gates.inGameAcceptance.status, 'PENDING');
});

test('C2B-21 finalAccepted still requires explicit in-game acceptance', () => {
  const { project } = subGridDurationProject({ decisions: [event => keepDecision({ event })] });
  assert.equal(readiness(project, { inGameAcceptance: 'PASS' }).finalAccepted, true);
  assert.equal(readiness(project, { inGameAcceptance: 'PENDING' }).finalAccepted, false);
  assert.equal(readiness(project, { inGameAcceptance: 'FAIL' }).finalAccepted, false);

  // A FAIL micro-timing result cannot be bought off with in-game acceptance.
  const { project: failing } = subGridDurationProject({ decisions: [event => technicalDecision({ event })] });
  const accepted = readiness(failing, { inGameAcceptance: 'PASS' });
  assert.equal(accepted.candidateReady, false);
  assert.equal(accepted.finalAccepted, false);
});

test('C2B-18b microTiming is one of the pre-game blocking gates', () => {
  const { project } = subGridDurationProject();
  const result = readiness(project);
  assert.ok(result.preGameBlocking.includes('microTiming'));
  assert.equal(Object.hasOwn(result.gates, 'microTiming'), true);
});

// ---------------------------------------------------------------------------
// 22-23. Nothing outside the analyzed project can grant the gate
// ---------------------------------------------------------------------------

test('C2B-22 a caller-supplied micro-timing PASS cannot spoof the gate', () => {
  const { project } = subGridDurationProject({ decisions: [event => technicalDecision({ event })] });
  const result = evaluateProjectReadiness({
    project,
    mmlValidation: { ok: true, errors: [] },
    core3Report: { status: 'PASS', blockers: [] },
    harmonyReport: { status: 'PASS', unresolvedCount: 0 },
    playerReadback: 'PASS',
    originalAudioRequired: true,
    // Not part of the contract, and must stay inert if a caller invents it.
    microTiming: 'PASS',
    microTimingReport: { status: 'PASS', candidateCount: 0, technicalResidueCount: 0 },
  });
  assert.equal(result.gates.microTiming.status, 'FAIL');
  assert.equal(result.gates.microTiming.technicalResidueCount, 1);
  assert.equal(result.candidateReady, false);
});

test('C2B-22b project metadata claiming a micro-timing PASS cannot spoof the gate', () => {
  const event = note({ id: 'micro', start: '0', end: JUST_BELOW.toString() });
  const project = candidate({
    events: [event],
    decisions: [technicalDecision({ event })],
    metadata: {
      microTiming: 'PASS',
      microTimingGate: { status: 'PASS' },
      subGridReviewed: true,
      finalRepresentable: true,
    },
  });
  const gate = readiness(project).gates.microTiming;
  assert.equal(gate.status, 'FAIL');
  assert.equal(gate.finalRepresentable, null);
});

test('C2B-23 C1 timing provenance alone creates neither a PASS nor a FAIL classification', () => {
  for (const origin of ['source-notated', 'source-derived', 'tool-derived']) {
    const event = note({ id: `origin-${origin}`, start: '0', end: JUST_BELOW.toString(), origin });
    const gate = readiness(candidate({ events: [event] })).gates.microTiming;
    assert.equal(gate.status, 'PENDING', `${origin} must not settle the classification`);
    assert.equal(gate.unknownCount, 1);
    assert.equal(gate.technicalResidueCount, 0, `${origin} must not produce TECHNICAL_RESIDUE`);
    assert.equal(gate.sourceSupportedCount, 0, `${origin} must not produce SOURCE_SUPPORTED_MICROTIMING`);
  }
});

// ---------------------------------------------------------------------------
// 24. Readiness reads timing; it never writes it
// ---------------------------------------------------------------------------

test('C2B-24 event start/end values are exactly unchanged after readiness evaluation', () => {
  const events = [
    note({ id: 'keepable', start: '0', end: JUST_BELOW.toString() }),
    note({ id: 'residue', start: '4', end: f(4).add(JUST_BELOW).toString(), pitch: 62 }),
    note({ id: 'null-a', start: '8', end: '9', role: null, pitch: 64 }),
    note({ id: 'null-b', start: f(9).add(JUST_BELOW).toString(), end: '10', role: null, pitch: 65 }),
    rest({ id: 'silence', start: '12', end: f(12).add(JUST_BELOW).toString() }),
  ];
  const project = candidate({
    events,
    decisions: [
      keepDecision({ event: events[0] }),
      technicalDecision({ event: events[1] }),
    ],
  });
  const before = timingSnapshot(project);
  const gate = readiness(project).gates.microTiming;
  assert.equal(gate.status, 'FAIL');
  assert.deepEqual(timingSnapshot(project), before);
  assert.equal(project.events[0].end, '1/17');
  assert.equal(project.events[1].end, '69/17');
  assert.equal(project.events[4].end, '205/17');
  assert.equal(project.events.length, 5);
});

// ---------------------------------------------------------------------------
// Correctness identity: structured, never the presentation label
// ---------------------------------------------------------------------------

test('C2B intervals that share a presentation label stay distinct in readiness', () => {
  // These two gaps render to the same intervalIdentityLabel because "->" is a
  // legal character inside a Canonical event id. Anything using the label as a
  // correctness or dedupe key silently collapses them.
  const melodyLeft = note({ id: 'a', start: '0', end: '1', role: 'Melody' });
  const melodyRight = note({ id: 'b->c', start: f(1).add(JUST_BELOW).toString(), end: '2', role: 'Melody', pitch: 62 });
  const chordLeft = note({ id: 'a->b', start: '0', end: '1', role: 'Chord1', pitch: 64 });
  const chordRight = note({ id: 'c', start: f(1).add(JUST_BELOW).toString(), end: '2', role: 'Chord1', pitch: 65 });

  const melodyGap = gapIdentity(melodyLeft, melodyRight);
  const chordGap = gapIdentity(chordLeft, chordRight);
  assert.equal(intervalIdentityLabel(melodyGap), intervalIdentityLabel(chordGap));
  assert.notEqual(intervalIdentityKey(melodyGap), intervalIdentityKey(chordGap));

  const gate = readiness(candidate({
    events: [melodyLeft, melodyRight, chordLeft, chordRight],
  })).gates.microTiming;
  assert.equal(gate.status, 'PENDING');
  assert.equal(gate.candidateCount, 2);
  assert.equal(gate.unknownCount, 2);
  assert.equal(gate.unknownIntervals.length, 2);
  assert.equal(new Set(gate.unknownIntervals.map(item => item.identityKey)).size, 2);
  assert.deepEqual(
    [...gate.unknownIntervals.map(item => item.identityKey)].sort(),
    [intervalIdentityKey(chordGap), intervalIdentityKey(melodyGap)].sort(),
  );
  for (const interval of gate.unknownIntervals) {
    assert.equal(interval.identityKey, intervalIdentityKey(interval.identity));
    assert.equal(Object.hasOwn(interval, 'identityLabel'), false);
  }
});

test('C2B a keep decision only clears the exact interval it targets', () => {
  const target = note({ id: 'targeted', start: '0', end: JUST_BELOW.toString() });
  const other = note({ id: 'untargeted', start: '4', end: f(4).add(JUST_BELOW).toString(), pitch: 62 });
  const gate = readiness(candidate({
    events: [target, other],
    decisions: [keepDecision({ event: target })],
  })).gates.microTiming;
  assert.equal(gate.status, 'PENDING');
  assert.equal(gate.sourceSupportedCount, 1);
  assert.equal(gate.unknownCount, 1);
  assert.deepEqual(gate.unknownIntervals.map(item => item.eventIds[0]), ['untargeted']);
  assert.deepEqual(gate.sourceSupportedIntervalKeys, [intervalIdentityKey(durationIdentity(target))]);
});

test('C2B an assigned-role sub-grid gap can be cleared by a gap-targeted keep', () => {
  const first = note({ id: 'gap-left', start: '0', end: '1' });
  const second = note({ id: 'gap-right', start: f(1).add(JUST_BELOW).toString(), end: '2', pitch: 62 });
  const identity = gapIdentity(first, second);
  const gate = readiness(candidate({
    events: [first, second],
    decisions: [keepDecision({ event: first, identity })],
  })).gates.microTiming;
  assert.equal(gate.status, 'PASS');
  assert.equal(gate.candidateCount, 1);
  assert.equal(gate.sourceSupportedCount, 1);
  assert.deepEqual(gate.sourceSupportedIntervalKeys, [intervalIdentityKey(identity)]);
});

// ---------------------------------------------------------------------------
// Implementation-module capability (IMPLEMENTER signal only)
// ---------------------------------------------------------------------------

test('C2B the source-aware micro-timing gate is declared as an implemented module', () => {
  assert.equal(STUDIO_IMPLEMENTATION.sourceAwareMicroTimingGate, true);
  assert.ok(
    STUDIO_FINAL_MODULE_BLOCKERS.some(([key, id]) => (
      key === 'sourceAwareMicroTimingGate' && id === 'SOURCE_AWARE_MICRO_TIMING_GATE_PENDING'
    )),
    'the capability must be wired to a stable module blocker id',
  );
  assert.deepEqual(studioFinalBlockers(), []);
});

test('C2B removing or disabling the micro-timing capability is observable as a module blocker', () => {
  for (const disabled of [
    { ...STUDIO_IMPLEMENTATION, sourceAwareMicroTimingGate: false },
    Object.fromEntries(
      Object.entries(STUDIO_IMPLEMENTATION).filter(([key]) => key !== 'sourceAwareMicroTimingGate'),
    ),
  ]) {
    assert.deepEqual(studioFinalBlockers(disabled), ['SOURCE_AWARE_MICRO_TIMING_GATE_PENDING']);
  }
});

test('C2B an empty module blocker list still certifies no song', () => {
  // The module blockers say the analyzer exists. Song-specific micro-timing
  // readiness is decided only by analyzing the Canonical project.
  assert.deepEqual(studioFinalBlockers(), []);
  const { project } = subGridDurationProject({ decisions: [event => technicalDecision({ event })] });
  const result = readiness(project);
  assert.equal(result.gates.implementation.status, 'PASS');
  assert.equal(result.gates.microTiming.status, 'FAIL');
  assert.equal(result.candidateReady, false);
});

// ---------------------------------------------------------------------------
// Diagnostics contract
// ---------------------------------------------------------------------------

test('C2B the micro-timing gate exposes the full structured diagnostic set', () => {
  const residue = note({ id: 'residue', start: '0', end: JUST_BELOW.toString() });
  const unproven = note({ id: 'unproven', start: '4', end: f(4).add(JUST_BELOW).toString(), pitch: 62 });
  const supported = note({ id: 'supported', start: '8', end: f(8).add(JUST_BELOW).toString(), pitch: 64 });
  const left = note({ id: 'null-a', start: '12', end: '13', role: null, pitch: 65 });
  const right = note({ id: 'null-b', start: f(13).add(JUST_BELOW).toString(), end: '14', role: null, pitch: 67 });
  const gate = readiness(candidate({
    events: [residue, unproven, supported, left, right],
    decisions: [technicalDecision({ event: residue }), keepDecision({ event: supported })],
  })).gates.microTiming;

  for (const key of [
    'candidateCount',
    'sourceSupportedCount',
    'technicalResidueCount',
    'unknownCount',
    'unresolvedStreamIssueCount',
    'hasUnknown',
    'hasUnresolvedStreamAnalysis',
    'technicalResidueIntervals',
    'unknownIntervals',
    'sourceSupportedIntervalKeys',
    'unresolvedStreamIssues',
    'safeGrid',
    'finalRepresentable',
  ]) {
    assert.equal(Object.hasOwn(gate, key), true, `microTiming gate must expose ${key}`);
  }
  assert.equal(gate.status, 'FAIL');
  assert.equal(gate.candidateCount, 3);
  assert.equal(gate.technicalResidueCount, 1);
  assert.equal(gate.unknownCount, 1);
  assert.equal(gate.sourceSupportedCount, 1);
  assert.equal(gate.unresolvedStreamIssueCount, 1);
  assert.deepEqual(gate.blockers, [
    'MICRO_TIMING_TECHNICAL_RESIDUE_PRESENT',
    'MICRO_TIMING_CLASSIFICATION_UNKNOWN',
    'MICRO_TIMING_STREAM_IDENTITY_UNRESOLVED',
  ]);
  assert.equal(gate.safeGrid, '1/16');
});

test('C2B a micro-timing analysis that cannot run fails closed as PENDING', () => {
  const broken = { ...candidate({ events: [note({ id: 'plain', start: '0', end: '1' })] }) };
  Object.defineProperty(broken, 'events', {
    get() { throw Error('events unavailable'); },
    enumerable: true,
  });
  const result = evaluateProjectReadiness({
    project: broken,
    mmlValidation: { ok: true, errors: [] },
    core3Report: { status: 'PASS', blockers: [] },
    harmonyReport: { status: 'PASS', unresolvedCount: 0 },
    playerReadback: 'PASS',
    originalAudioRequired: false,
  });
  assert.equal(result.gates.microTiming.status, 'PENDING');
  assert.deepEqual(result.gates.microTiming.blockers, ['MICRO_TIMING_ANALYSIS_FAILED']);
  assert.equal(result.gates.microTiming.finalRepresentable, null);
  assert.equal(result.candidateReady, false);
});

test('C2B a dense role-null MusicXML-like stream is analyzed synchronously inside readiness', () => {
  const events = [];
  let cursor = f(0);
  for (let index = 0; index < 2000; index += 1) {
    const start = cursor;
    const end = start.add(new F(1, 2));
    events.push(note({
      id: `ingest:${index}`,
      start: start.toString(),
      end: end.toString(),
      role: null,
      pitch: 48 + (index % 36),
    }));
    cursor = end.add(JUST_BELOW);
  }
  const project = candidate({ events });
  const started = process.hrtime.bigint();
  const gate = readiness(project).gates.microTiming;
  const seconds = Number(process.hrtime.bigint() - started) / 1e9;
  assert.equal(gate.status, 'PENDING');
  assert.equal(gate.unresolvedStreamIssueCount, 1999);
  assert.ok(seconds < 5, `readiness took ${seconds.toFixed(3)}s for a 2000-event role-null ingest`);
});

// ---------------------------------------------------------------------------
// Adversarial audit (pre-Studio-Web): evidence scope containment
// ---------------------------------------------------------------------------
//
// C2B-6 already proves a *spoofed* primary record cannot bind a sub-grid
// interval. A genuinely primary record that carries none of the interval's own
// events is the same unproven claim wearing a real badge: SOURCE_POLICY §5 says
// a source reference proves provenance, not compatibility, and §2 requires the
// exact source IDs *and the event involved* to be recorded together. Admissible
// binding therefore has to be scoped to the interval, not merely present in the
// project. G11-C already contains role evidence this way (evidenceScope in
// backend/arrangement/role-candidates.mjs); the micro-timing gate did not.

test('C2B-A1 a genuine primary source that carries none of the interval\'s events is microTiming PENDING', () => {
  // The sub-grid note belongs only to the supporting third-party source. The
  // official score is real, primary and in the project -- but not this note's.
  const { project } = subGridDurationProject({
    sources: [OFFICIAL, SUPPORTING_THIRD_PARTY],
    sourceId: 'third',
    decisions: [event => keepDecision({ event, evidenceSourceIds: ['official'] })],
  });
  const gate = readiness(project).gates.microTiming;
  assert.equal(gate.status, 'PENDING');
  assert.deepEqual(gate.blockers, ['MICRO_TIMING_CLASSIFICATION_UNKNOWN']);
  assert.equal(gate.sourceSupportedCount, 0);
  assert.equal(
    gate.unknownIntervals[0].classificationBasis,
    'accepted-keep-decision-without-admissible-source-binding',
  );
  assert.equal(readiness(project).candidateReady, false);
});

test('C2B-A2 an interval bound to its own cited primary source stays microTiming PASS', () => {
  // Same shape, but the cited primary source is the one the note actually came
  // from. Containment must not cost a legitimate keep its PASS.
  const { project } = subGridDurationProject({
    sources: [OFFICIAL, SUPPORTING_THIRD_PARTY],
    sourceId: 'official',
    decisions: [event => keepDecision({ event, evidenceSourceIds: ['third', 'official'] })],
  });
  const gate = readiness(project).gates.microTiming;
  assert.equal(gate.status, 'PASS');
  assert.equal(gate.sourceSupportedCount, 1);
});

test('C2B-A3 an inter-event gap needs a primary source from the events that bound it', () => {
  const official = note({ id: 'lead-a', start: '0', end: '1', sourceId: 'official' });
  const strayPrimary = createSource({
    id: 'other-official',
    label: 'Official score for a different section',
    kind: 'official-musicxml',
    authority: 'primary-symbolic',
  });
  const next = note({ id: 'lead-b', start: EXACT_GRID.add(new F(1, 1)).sub(JUST_BELOW).toString(), end: '3', sourceId: 'third' });
  const target = gapIdentity(official, next);
  const decision = createArbitrationDecision({
    id: 'keep:gap',
    eventIds: [official.id, next.id],
    action: KEEP,
    status: 'accepted',
    reason: 'Claimed source-supported breath.',
    evidence: ['a citation naming an unrelated section'],
    metadata: { intervalIdentity: target, evidenceSourceIds: ['other-official'] },
  });
  const project = candidate({
    events: [official, next],
    sources: [OFFICIAL, SUPPORTING_THIRD_PARTY, strayPrimary],
    decisions: [decision],
  });
  const gate = readiness(project).gates.microTiming;
  assert.equal(gate.status, 'PENDING');
  assert.ok(gate.blockers.includes('MICRO_TIMING_CLASSIFICATION_UNKNOWN'));
  assert.equal(gate.sourceSupportedCount, 0);
});
