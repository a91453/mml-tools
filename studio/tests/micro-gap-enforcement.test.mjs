// G10 — source-aware sub-1/64 micro-gap enforcement regressions.
//
// The rule these pin is published, not invented here. MOBILE_SYNTAX §4 makes
// `FINAL_FORBIDDEN` "technical micro-gaps or decomposition components finer
// than 1/64 **when they have no source-supported musical meaning**", §11 step 5
// requires Final canonicalization to leave no non-musical technical micro-gap,
// and MASTER_RULES §7 preserves meaningful source rests, breaths and
// articulation gaps while permitting meaning-free micro-gaps to be normalized.
//
// The failure mode these exist to make impossible is the naive reading:
//
//     duration < 1/64  =>  delete / reject
//
// which would itself violate Canonical by discarding source-supported material.
// Every test below therefore checks the *three-way* outcome, never a threshold.
//
// They also pin the half of G10 that had no coverage before: that
// `shortestSafeDenominator`, `rejectTechnicalMicroGapsBelow64` and
// `preserveMeaningfulRests` are read by executable code rather than declared and
// ignored. Those assertions look at behavior, never at the constant.
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
  SAFE_GRID,
  createIntervalIdentity,
  intervalIdentityKey,
} from '../backend/canonical/micro-timing.mjs';
import {
  MICRO_GAP_ENFORCEMENT,
  MICRO_GAP_BLOCKERS,
  enforceMicroGaps,
  readMicroGapPolicy,
  isBelowSafeGrid,
} from '../backend/final/micro-gap-enforcement.mjs';
import { evaluateProjectReadiness } from '../backend/final/readiness.mjs';
import { EFFECTIVE_RULESET } from '../backend/rules/index.mjs';
import { sha256Hex } from '../backend/source/sha256.mjs';

const KEEP = MICRO_TIMING_KEEP_ACTION;
const TECHNICAL = MICRO_TIMING_TECHNICAL_ACTIONS[0];

// The published safe grid, in Canonical IR quarter-note beats: whole-note 1/64
// is 4/64 = 1/16 IR beats. Written as the derivation, not as a magic literal.
const EXACT_GRID = new F(4, 64);

// Exactly one part in 10^20 below the grid. The float images of EXACT_GRID and
// BELOW_GRID are the same double (0.0625), so anything that compares these with
// a float or an epsilon cannot tell them apart; exact rational can.
const BELOW_GRID = EXACT_GRID.sub(new F(1, 10n ** 20n));

const OFFICIAL = createSource({
  id: 'official',
  label: 'Official MusicXML',
  kind: 'official-musicxml',
  authority: 'primary-symbolic',
});
const THIRD_PARTY = createSource({
  id: 'third',
  label: 'Community MIDI',
  kind: 'third-party-midi',
  authority: 'supporting',
});

function note({ id, start, end, role = 'Melody', pitch = 60, sourceId = 'official', origin = null }) {
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

function eventIdsOf(identity) {
  return identity.type === INTERVAL_TYPES.EVENT_DURATION
    ? [identity.eventId]
    : [identity.previousEventId, identity.nextEventId];
}

// An accepted keep whose evidence cites a genuinely primary source that every
// event in the interval actually carries. This is what "source-supported" has
// to mean: SOURCE_POLICY §2 wants the exact source IDs and the event involved
// recorded together, and §5 says a reference proves provenance, not compatibility.
function keepDecision(identity, { evidenceSourceIds = ['official'] } = {}) {
  const eventIds = eventIdsOf(identity);
  return createArbitrationDecision({
    id: `keep:${eventIds.join('+')}`,
    eventIds,
    action: KEEP,
    status: 'accepted',
    reason: 'Source-supported articulation separation notated in the official score.',
    evidence: ['official MusicXML, measure 3, notated staccato separation'],
    metadata: { intervalIdentity: identity, evidenceSourceIds },
  });
}

// An accepted classification that the interval was produced by project tooling
// and carries no source-supported musical meaning. Note what does *not* appear:
// no duration threshold, no "looks like a rounding artifact" heuristic, no
// source-type inference. The claim is affirmed literally or it does not exist.
function technicalDecision(identity) {
  const eventIds = eventIdsOf(identity);
  return createArbitrationDecision({
    id: `tech:${eventIds.join('+')}`,
    eventIds,
    action: TECHNICAL,
    status: 'accepted',
    reason: 'Decomposition residue left by the tie-splitting pass; no source counterpart.',
    evidence: ['producer log: split residue at bar 3, no notated separation in any source'],
    metadata: { intervalIdentity: identity },
  });
}

function project({ events, decisions = [], sources = [OFFICIAL] }) {
  const baseline = createCanonicalProject({
    id: 'baseline:source-faithful',
    title: 'Source-Faithful Baseline',
    sources,
    events,
    metadata: { sourceComplete: true, baselineKind: 'source-faithful' },
  });
  return createCanonicalProject({
    id: 'song-g10',
    title: 'G10 micro-gap song',
    sources,
    events,
    decisions,
    metadata: {
      sourceComplete: true,
      sourceFaithfulBaseline: { snapshot: baseline },
      audioAlignmentEvidence: [{ sourceId: 'original-audio', warnings: [], metrics: { confidence: 0.9 } }],
    },
  });
}

function readiness(candidate) {
  return evaluateProjectReadiness({
    project: candidate,
    mmlValidation: { ok: true, errors: [] },
    core3Report: { status: 'PASS', blockers: [] },
    harmonyReport: { status: 'PASS', unresolvedCount: 0 },
    playerReadback: 'PASS',
    originalAudioRequired: true,
    mobileAdaptation: 'PASS',
  });
}

// Everything a Final pass is forbidden to move: attack onsets, releases, event
// identity, role and provenance. Compared structurally, not by a tolerance.
function eventShape(candidate) {
  return candidate.events
    .map(event => ({
      id: event.id,
      kind: event.kind,
      start: event.start,
      end: event.end,
      role: event.role,
      pitch: event.pitch ?? null,
      sourceIds: [...event.sourceIds],
    }))
    .sort((left, right) => (left.id < right.id ? -1 : left.id > right.id ? 1 : 0));
}

function withMobileSyntax(overrides) {
  return { ...EFFECTIVE_RULESET.mobileSyntax, ...overrides };
}

// A project whose only sub-grid interval is a source-supported articulation gap
// between two official events, plus the same shape with the keep withheld.
function articulationGapProject({ withKeep }) {
  const before = note({ id: 'phrase-a', start: '0', end: '1' });
  const after = note({
    id: 'phrase-b',
    start: f(1).add(BELOW_GRID).toString(),
    end: '2',
    pitch: 62,
  });
  const identity = gapIdentity(before, after);
  return {
    before,
    after,
    identity,
    candidate: project({
      events: [before, after],
      decisions: withKeep ? [keepDecision(identity)] : [],
    }),
  };
}

// ---------------------------------------------------------------------------
// 1. A source-supported gap shorter than 1/64 survives
// ---------------------------------------------------------------------------

test('G10-1 a source-supported sub-1/64 gap is preserved, not rejected for being short', () => {
  const { identity, candidate } = articulationGapProject({ withKeep: true });
  assert.equal(isBelowSafeGrid(identity.length), true, 'fixture must actually be sub-grid');

  const report = enforceMicroGaps(candidate);
  const record = report.enforcement.find(item => item.identityKey === intervalIdentityKey(identity));

  assert.ok(record, 'the sub-grid gap must be seen by the enforcement pass');
  assert.equal(record.classification, MICRO_TIMING_CLASSIFICATIONS.SOURCE_SUPPORTED_MICROTIMING);
  assert.equal(record.enforcement, MICRO_GAP_ENFORCEMENT.PRESERVE);
  assert.deepEqual([...report.preservedIntervalKeys], [record.identityKey]);
  assert.deepEqual([...report.rejectedIntervalKeys], []);
  assert.deepEqual([...report.blockedIntervalKeys], []);
  assert.equal(report.status, 'PASS');
  assert.deepEqual([...report.blockers], []);
});

test('G10-1b neither attack onset moves and no event identity changes', () => {
  const { before, after, candidate } = articulationGapProject({ withKeep: true });
  const shapeBefore = eventShape(candidate);

  enforceMicroGaps(candidate);
  readiness(candidate);

  assert.deepEqual(eventShape(candidate), shapeBefore);
  // Stated explicitly rather than only structurally: the later attack is not
  // pulled earlier, and the earlier note is not extended to swallow the gap.
  assert.equal(candidate.events.find(event => event.id === 'phrase-b').start, f(1).add(BELOW_GRID).toString());
  assert.equal(candidate.events.find(event => event.id === 'phrase-a').end, before.end);
  assert.equal(candidate.events.find(event => event.id === 'phrase-b').end, after.end);
  assert.equal(candidate.events.length, 2, 'no event may be deleted or merged away');
});

test('G10-1c preserving a sub-grid gap makes no Final representability claim', () => {
  const { candidate } = articulationGapProject({ withKeep: true });
  const report = enforceMicroGaps(candidate);
  // If this interval turns out to be undeliverable, the reason must come from a
  // representability mechanism that does not exist yet -- never from "it was
  // under 1/64, therefore technical".
  assert.equal(report.status, 'PASS');
  assert.equal(report.finalRepresentable, null);
  assert.equal(readiness(candidate).gates.microTiming.finalRepresentable, null);
});

test('G10-1d a source-supported sub-grid gap does not bypass the separate technical MML gate', () => {
  const { candidate } = articulationGapProject({ withKeep: true });
  const result = evaluateProjectReadiness({
    project: candidate,
    mmlValidation: { ok: false, errors: [{ message: 'role exceeds 2,400 characters' }] },
    core3Report: { status: 'PASS', blockers: [] },
    harmonyReport: { status: 'PASS', unresolvedCount: 0 },
    playerReadback: 'PASS',
    originalAudioRequired: true,
  });
  assert.equal(result.gates.microTiming.status, 'PASS');
  assert.equal(result.gates.technical.status, 'FAIL');
  assert.equal(result.candidateReady, false);
});

// ---------------------------------------------------------------------------
// 2. A confirmed transformation artifact is rejected, and nothing else is touched
// ---------------------------------------------------------------------------

test('G10-2 a confirmed technical sub-1/64 gap is rejected for Final, never silently passed', () => {
  const before = note({ id: 'split-left', start: '0', end: '1', origin: 'tool-derived' });
  const after = note({
    id: 'split-right',
    start: f(1).add(BELOW_GRID).toString(),
    end: '2',
    pitch: 62,
    origin: 'tool-derived',
  });
  const identity = gapIdentity(before, after);
  const candidate = project({ events: [before, after], decisions: [technicalDecision(identity)] });

  const report = enforceMicroGaps(candidate);
  const record = report.enforcement.find(item => item.identityKey === intervalIdentityKey(identity));

  assert.equal(record.classification, MICRO_TIMING_CLASSIFICATIONS.TECHNICAL_RESIDUE);
  assert.equal(record.enforcement, MICRO_GAP_ENFORCEMENT.REJECT_FINAL);
  assert.deepEqual([...report.rejectedIntervalKeys], [record.identityKey]);
  assert.deepEqual([...report.preservedIntervalKeys], []);
  assert.equal(report.status, 'FAIL');
  assert.ok(report.blockers.includes(MICRO_GAP_BLOCKERS.TECHNICAL_RESIDUE_PRESENT));

  const gate = readiness(candidate).gates.microTiming;
  assert.equal(gate.status, 'FAIL');
  assert.equal(readiness(candidate).candidateReady, false, 'a confirmed artifact must block the candidate');
});

test('G10-2b rejecting a technical gap does not edit the events that bound it', () => {
  const before = note({ id: 'split-left', start: '0', end: '1', origin: 'tool-derived' });
  const after = note({
    id: 'split-right',
    start: f(1).add(BELOW_GRID).toString(),
    end: '2',
    pitch: 62,
    origin: 'tool-derived',
  });
  const neighbour = note({ id: 'untouched', start: '3', end: '4', pitch: 64 });
  const candidate = project({
    events: [before, after, neighbour],
    decisions: [technicalDecision(gapIdentity(before, after))],
  });
  const shapeBefore = eventShape(candidate);

  assert.equal(enforceMicroGaps(candidate).status, 'FAIL');
  readiness(candidate);

  // G10 reports the violation; it does not repair it. Normalization, when it
  // arrives, belongs to the Final emitter and must preserve attack identity and
  // source-supported durations -- so nothing may be rewritten here.
  assert.deepEqual(eventShape(candidate), shapeBefore);
  assert.equal(candidate.events.length, 3);
});

// ---------------------------------------------------------------------------
// 3. Unproven provenance fails closed
// ---------------------------------------------------------------------------

test('G10-3 a sub-1/64 gap with no usable provenance is blocked, never guessed away', () => {
  const { identity, candidate } = articulationGapProject({ withKeep: false });
  const report = enforceMicroGaps(candidate);
  const record = report.enforcement.find(item => item.identityKey === intervalIdentityKey(identity));

  assert.equal(record.classification, MICRO_TIMING_CLASSIFICATIONS.UNKNOWN);
  assert.equal(record.enforcement, MICRO_GAP_ENFORCEMENT.BLOCK_PENDING);
  assert.deepEqual([...report.blockedIntervalKeys], [record.identityKey]);
  assert.deepEqual([...report.rejectedIntervalKeys], [], 'unproven must not be treated as technical');
  assert.deepEqual([...report.preservedIntervalKeys], [], 'unproven must not be treated as source-supported');
  assert.equal(report.status, 'PENDING');
  assert.ok(report.blockers.includes(MICRO_GAP_BLOCKERS.CLASSIFICATION_UNKNOWN));
  assert.equal(readiness(candidate).candidateReady, false);
});

test('G10-3b a blocked interval is not deleted, extended, or moved off its attack', () => {
  const { candidate } = articulationGapProject({ withKeep: false });
  const shapeBefore = eventShape(candidate);
  enforceMicroGaps(candidate);
  readiness(candidate);
  assert.deepEqual(eventShape(candidate), shapeBefore);
});

test('G10-3c a supporting-only source cannot upgrade an unproven gap', () => {
  // Same gap, same shape, but the cited backing is a community MIDI rather than
  // a primary symbolic/audio source, so it stays unproven.
  const before = note({ id: 'phrase-a', start: '0', end: '1', sourceId: 'third' });
  const after = note({
    id: 'phrase-b',
    start: f(1).add(BELOW_GRID).toString(),
    end: '2',
    pitch: 62,
    sourceId: 'third',
  });
  const identity = gapIdentity(before, after);
  const candidate = project({
    events: [before, after],
    sources: [OFFICIAL, THIRD_PARTY],
    decisions: [keepDecision(identity, { evidenceSourceIds: ['third'] })],
  });

  const report = enforceMicroGaps(candidate);
  const record = report.enforcement.find(item => item.identityKey === intervalIdentityKey(identity));
  assert.equal(record.classification, MICRO_TIMING_CLASSIFICATIONS.UNKNOWN);
  assert.equal(record.enforcement, MICRO_GAP_ENFORCEMENT.BLOCK_PENDING);
  assert.equal(report.status, 'PENDING');
});

// ---------------------------------------------------------------------------
// 4-5. The grid itself: at or above it nothing happens; below it, exactly
// ---------------------------------------------------------------------------

test('G10-4 an ordinary gap at or above 1/64 is left entirely alone', () => {
  const before = note({ id: 'plain-a', start: '0', end: '1' });
  const after = note({ id: 'plain-b', start: '1.5', end: '2', pitch: 62 });
  const candidate = project({ events: [before, after] });

  const report = enforceMicroGaps(candidate);
  assert.equal(report.candidateCount, 0);
  assert.deepEqual([...report.enforcement], []);
  assert.deepEqual([...report.blockers], []);
  assert.equal(report.status, 'PASS');
  assert.equal(readiness(candidate).gates.microTiming.status, 'PASS');
});

test('G10-5 exactly 1/64 is on the grid and is not a sub-grid interval', () => {
  const before = note({ id: 'edge-a', start: '0', end: '1' });
  const after = note({ id: 'edge-b', start: f(1).add(EXACT_GRID).toString(), end: '2', pitch: 62 });
  const candidate = project({ events: [before, after] });

  assert.equal(EXACT_GRID.cmp(SAFE_GRID), 0, 'the fixture grid must be the published grid');
  assert.equal(isBelowSafeGrid(EXACT_GRID), false);
  const report = enforceMicroGaps(candidate);
  assert.equal(report.candidateCount, 0);
  assert.equal(report.status, 'PASS');

  // The event-duration path takes the same boundary as the gap path: a note
  // exactly 1/64 long is on the grid, so it is not a sub-grid candidate either.
  const onGrid = note({ id: 'edge-duration', start: '0', end: EXACT_GRID.toString() });
  const durationReport = enforceMicroGaps(project({ events: [onGrid] }));
  assert.equal(durationReport.candidateCount, 0);
  assert.equal(durationReport.status, 'PASS');
});

test('G10-5b a gap below 1/64 by less than float precision is still sub-grid', () => {
  // The boundary is decided on exact rationals. These two lengths are the same
  // IEEE double, so a float comparison or an epsilon tolerance would call the
  // second one "equal to the grid" and wave it through.
  assert.equal(EXACT_GRID.num(), BELOW_GRID.num(), 'fixture must be float-indistinguishable');
  assert.equal(EXACT_GRID.cmp(BELOW_GRID), 1, 'but exactly greater as a rational');
  assert.equal(isBelowSafeGrid(BELOW_GRID), true);

  const { candidate } = articulationGapProject({ withKeep: false });
  const report = enforceMicroGaps(candidate);
  assert.equal(report.candidateCount, 1);
  assert.equal(report.status, 'PENDING');
});

test('G10-5c a sub-grid event duration is classified on the same three-way rule', () => {
  const tiny = note({ id: 'tiny', start: '0', end: BELOW_GRID.toString() });
  const identity = durationIdentity(tiny);

  const unproven = enforceMicroGaps(project({ events: [tiny] }));
  assert.equal(unproven.enforcement[0].enforcement, MICRO_GAP_ENFORCEMENT.BLOCK_PENDING);
  assert.equal(unproven.status, 'PENDING');

  const supported = enforceMicroGaps(project({ events: [tiny], decisions: [keepDecision(identity)] }));
  assert.equal(supported.enforcement[0].enforcement, MICRO_GAP_ENFORCEMENT.PRESERVE);
  assert.equal(supported.status, 'PASS');

  const technical = enforceMicroGaps(project({ events: [tiny], decisions: [technicalDecision(identity)] }));
  assert.equal(technical.enforcement[0].enforcement, MICRO_GAP_ENFORCEMENT.REJECT_FINAL);
  assert.equal(technical.status, 'FAIL');
});

// ---------------------------------------------------------------------------
// 6. The Source-Faithful Baseline is never touched
// ---------------------------------------------------------------------------

test('G10-6 the Source-Faithful Baseline is byte-identical before and after enforcement', () => {
  const tiny = note({ id: 'tiny', start: '0', end: BELOW_GRID.toString() });
  const residue = note({ id: 'residue', start: '4', end: f(4).add(BELOW_GRID).toString(), pitch: 62 });
  const supported = note({ id: 'supported', start: '8', end: f(8).add(BELOW_GRID).toString(), pitch: 64 });
  const candidate = project({
    events: [tiny, residue, supported],
    decisions: [technicalDecision(durationIdentity(residue)), keepDecision(durationIdentity(supported))],
  });

  const snapshot = candidate.metadata.sourceFaithfulBaseline.snapshot;
  const before = JSON.stringify(snapshot);
  const beforeHash = sha256Hex(before);
  const beforeClone = JSON.parse(before);

  enforceMicroGaps(candidate);
  readiness(candidate);

  const after = JSON.stringify(candidate.metadata.sourceFaithfulBaseline.snapshot);
  assert.equal(sha256Hex(after), beforeHash, 'baseline hash must be unchanged');
  assert.deepEqual(JSON.parse(after), beforeClone);
  // And the candidate's own source evidence is equally untouched.
  assert.deepEqual(
    candidate.sources.map(source => ({ id: source.id, kind: source.kind, authority: source.authority })),
    [{ id: 'official', kind: 'official-musicxml', authority: 'primary-symbolic' }],
  );
});

// ---------------------------------------------------------------------------
// 7. The contract flags are executable, not decorative
// ---------------------------------------------------------------------------

test('G10-7 the published contract is read and reported as conformant', () => {
  const policy = readMicroGapPolicy();
  assert.equal(policy.conformant, true);
  assert.deepEqual([...policy.blockers], []);
  // The grid is derived from the contract denominator, not restated: whole-note
  // 1/64 is 4/64 IR beats, and it must equal the analyzer grid exactly.
  assert.equal(policy.declaredSafeGrid, policy.analyzerSafeGrid);
  assert.equal(policy.declaredSafeGrid, SAFE_GRID.toString());
});

test('G10-7a disabling rejectTechnicalMicroGapsBelow64 changes behavior, so the flag is live', () => {
  // The observable claim: a project that is PASS under the published contract
  // stops being PASS when the flag is turned off. A dead flag could not do this.
  const clean = project({ events: [note({ id: 'plain', start: '0', end: '1' })] });
  assert.equal(enforceMicroGaps(clean).status, 'PASS');

  const mutated = enforceMicroGaps(clean, {
    mobileSyntax: withMobileSyntax({ rejectTechnicalMicroGapsBelow64: false }),
  });
  assert.equal(mutated.status, 'PENDING');
  assert.equal(mutated.policy.conformant, false);
  assert.ok(mutated.blockers.includes(MICRO_GAP_BLOCKERS.TECHNICAL_REJECTION_DISABLED));
});

test('G10-7b disabling the flag cannot turn a confirmed technical residue into a pass', () => {
  const tiny = note({ id: 'tiny', start: '0', end: BELOW_GRID.toString() });
  const candidate = project({ events: [tiny], decisions: [technicalDecision(durationIdentity(tiny))] });

  const mutated = enforceMicroGaps(candidate, {
    mobileSyntax: withMobileSyntax({ rejectTechnicalMicroGapsBelow64: false }),
  });
  // A non-conformant contract only ever fails closed. It never relaxes the
  // published rule, because the rule is published, not declared here.
  assert.equal(mutated.status, 'FAIL');
  assert.equal(mutated.enforcement[0].enforcement, MICRO_GAP_ENFORCEMENT.REJECT_FINAL);
});

test('G10-7c the safe grid comes from the contract denominator and cannot silently drift', () => {
  const { candidate } = articulationGapProject({ withKeep: true });
  assert.equal(enforceMicroGaps(candidate).status, 'PASS');

  const mismatched = enforceMicroGaps(candidate, {
    mobileSyntax: withMobileSyntax({ shortestSafeDenominator: 32 }),
  });
  assert.equal(mismatched.policy.declaredSafeGrid, new F(4, 32).toString());
  assert.equal(mismatched.policy.conformant, false);
  assert.ok(mismatched.blockers.includes(MICRO_GAP_BLOCKERS.SAFE_GRID_MISMATCH));
  assert.equal(mismatched.status, 'PENDING');
  // Critically, the declared value does not *become* the grid. A contract edit
  // must not be able to widen or narrow what Canonical calls sub-grid.
  assert.equal(mismatched.safeGrid, SAFE_GRID.toString());
});

test('G10-7d a missing or nonsensical denominator fails closed rather than defaulting', () => {
  for (const shortestSafeDenominator of [undefined, null, 0, -64, 6.5, '64']) {
    const policy = readMicroGapPolicy(withMobileSyntax({ shortestSafeDenominator }));
    assert.equal(policy.conformant, false, `denominator ${String(shortestSafeDenominator)} must not be accepted`);
    assert.ok(policy.blockers.includes(MICRO_GAP_BLOCKERS.SAFE_GRID_UNDECLARED));
  }
});

// ---------------------------------------------------------------------------
// 8. preserveMeaningfulRests, and the simplification it exists to prevent
// ---------------------------------------------------------------------------

test('G10-8 a source-supported sub-1/64 rest event is preserved, not swept up as residue', () => {
  // MASTER_RULES §7 protects meaningful source rests, breaths and articulation
  // gaps. Shortness is not evidence that a rest is meaningless.
  const before = note({ id: 'before-breath', start: '0', end: '1' });
  const breath = rest({ id: 'breath', start: '1', end: f(1).add(BELOW_GRID).toString() });
  const after = note({ id: 'after-breath', start: f(1).add(BELOW_GRID).toString(), end: '2', pitch: 62 });
  const identity = durationIdentity(breath);
  const candidate = project({
    events: [before, breath, after],
    decisions: [keepDecision(identity)],
  });

  const report = enforceMicroGaps(candidate);
  const record = report.enforcement.find(item => item.identityKey === intervalIdentityKey(identity));
  assert.equal(record.classification, MICRO_TIMING_CLASSIFICATIONS.SOURCE_SUPPORTED_MICROTIMING);
  assert.equal(record.enforcement, MICRO_GAP_ENFORCEMENT.PRESERVE);
  assert.equal(report.status, 'PASS');
  assert.equal(candidate.events.filter(event => event.kind === 'rest').length, 1);
});

test('G10-8b disabling preserveMeaningfulRests blocks rather than starting to delete rests', () => {
  const breath = rest({ id: 'breath', start: '1', end: f(1).add(BELOW_GRID).toString() });
  const candidate = project({ events: [breath], decisions: [keepDecision(durationIdentity(breath))] });

  const mutated = enforceMicroGaps(candidate, {
    mobileSyntax: withMobileSyntax({ preserveMeaningfulRests: false }),
  });
  assert.equal(mutated.policy.conformant, false);
  assert.ok(mutated.blockers.includes(MICRO_GAP_BLOCKERS.MEANINGFUL_REST_PRESERVATION_DISABLED));
  assert.equal(mutated.status, 'PENDING');
  // The rest is still preserved and still absent from the reject list: a
  // non-conformant contract never becomes a licence to discard source material.
  assert.equal(mutated.enforcement[0].enforcement, MICRO_GAP_ENFORCEMENT.PRESERVE);
  assert.deepEqual([...mutated.rejectedIntervalKeys], []);
  assert.equal(candidate.events.length, 1);
});

test('G10-8c three sub-1/64 intervals in one project reach three different outcomes', () => {
  // This is the whole point of G10 in one assertion: "everything under 1/64 is
  // technical" is not a possible reading of this report.
  const supported = note({ id: 'supported', start: '0', end: BELOW_GRID.toString() });
  const residue = note({ id: 'residue', start: '4', end: f(4).add(BELOW_GRID).toString(), pitch: 62 });
  const unproven = note({ id: 'unproven', start: '8', end: f(8).add(BELOW_GRID).toString(), pitch: 64 });
  const candidate = project({
    events: [supported, residue, unproven],
    decisions: [keepDecision(durationIdentity(supported)), technicalDecision(durationIdentity(residue))],
  });

  const report = enforceMicroGaps(candidate);
  assert.equal(report.candidateCount, 3);
  assert.deepEqual([...report.preservedIntervalKeys], [intervalIdentityKey(durationIdentity(supported))]);
  assert.deepEqual([...report.rejectedIntervalKeys], [intervalIdentityKey(durationIdentity(residue))]);
  assert.deepEqual([...report.blockedIntervalKeys], [intervalIdentityKey(durationIdentity(unproven))]);

  const preserved = new Set(report.preservedIntervalKeys);
  assert.ok(!report.rejectedIntervalKeys.some(key => preserved.has(key)));
  assert.ok(!report.blockedIntervalKeys.some(key => preserved.has(key)));

  // A confirmed violation outranks uncertainty, but the uncertainty stays visible.
  assert.equal(report.status, 'FAIL');
  assert.deepEqual([...report.blockers], [
    MICRO_GAP_BLOCKERS.TECHNICAL_RESIDUE_PRESENT,
    MICRO_GAP_BLOCKERS.CLASSIFICATION_UNKNOWN,
  ]);
});

// ---------------------------------------------------------------------------
// The Final enforcement hook a later emitter consumes
// ---------------------------------------------------------------------------

test('G10-9 the enforcement report is the contract a Final emitter can act on', () => {
  const supported = note({ id: 'supported', start: '0', end: BELOW_GRID.toString() });
  const residue = note({ id: 'residue', start: '4', end: f(4).add(BELOW_GRID).toString(), pitch: 62 });
  const candidate = project({
    events: [supported, residue],
    decisions: [keepDecision(durationIdentity(supported)), technicalDecision(durationIdentity(residue))],
  });

  const report = enforceMicroGaps(candidate);
  for (const record of report.enforcement) {
    // Structured identity only: identityLabel is presentation and collides
    // across distinct intervals, so it is deliberately not a handle here.
    assert.ok(record.identity && typeof record.identity === 'object');
    assert.equal(typeof record.identityKey, 'string');
    assert.ok(Object.values(MICRO_GAP_ENFORCEMENT).includes(record.enforcement));
    assert.ok(Array.isArray(record.eventIds) && record.eventIds.length > 0);
    assert.ok(Array.isArray(record.sourceIds));
    assert.equal(typeof record.classificationBasis, 'string');
    assert.equal(record.safeGridComparison, 'below-safe-grid');
  }
  assert.equal(Object.isFrozen(report), true);
  assert.equal(Object.isFrozen(report.enforcement), true);
});

test('G10-9b the readiness gate republishes the enforcement contract unchanged', () => {
  const supported = note({ id: 'supported', start: '0', end: BELOW_GRID.toString() });
  const candidate = project({ events: [supported], decisions: [keepDecision(durationIdentity(supported))] });

  const report = enforceMicroGaps(candidate);
  const gate = readiness(candidate).gates.microTiming;

  assert.equal(gate.status, report.status);
  assert.deepEqual(gate.enforcement, report.enforcement);
  assert.deepEqual(gate.preservedIntervalKeys, report.preservedIntervalKeys);
  assert.deepEqual(gate.rejectedIntervalKeys, report.rejectedIntervalKeys);
  assert.deepEqual(gate.blockedIntervalKeys, report.blockedIntervalKeys);
  assert.deepEqual(gate.policy, report.policy);
});

test('G10-9c an analysis that cannot run fails closed and proposes nothing', () => {
  const broken = { ...project({ events: [note({ id: 'plain', start: '0', end: '1' })] }) };
  Object.defineProperty(broken, 'events', {
    get() { throw Error('events unavailable'); },
    enumerable: true,
  });

  const report = enforceMicroGaps(broken);
  assert.equal(report.status, 'PENDING');
  assert.ok(report.blockers.includes(MICRO_GAP_BLOCKERS.ANALYSIS_FAILED));
  assert.deepEqual([...report.enforcement], []);
  assert.deepEqual([...report.preservedIntervalKeys], []);
  assert.deepEqual([...report.rejectedIntervalKeys], []);
  assert.equal(report.finalRepresentable, null);
});
