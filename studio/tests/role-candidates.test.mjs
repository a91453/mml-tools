import test from 'node:test';
import assert from 'node:assert/strict';
import {
  suggestRoleCandidates,
  ROLE_CANDIDATE_STATUS,
  ROLE_DECISIONS,
  SIX_ROLES,
  CORE3_ROLE_NAMES,
  ENRICHMENT_ROLE_NAMES,
} from '../backend/arrangement/index.mjs';
import { f } from '../backend/mml/index.mjs';
import { readFileSync } from 'node:fs';

// ─── fixture helpers ────────────────────────────────────────────────────────

const note = (id, pitch, start, end, voice, extra = {}) => Object.freeze({
  kind: 'note',
  id,
  pitch,
  start,
  end,
  sourceIds: Object.freeze(extra.sourceIds ?? [extra.sourceId ?? 'fixture']),
  sourceEventIds: Object.freeze([`raw:${id}`]),
  role: extra.role ?? null,
  voice,
  volume: null,
  tags: Object.freeze(extra.tags ?? ['source-faithful']),
  metadata: Object.freeze(extra.metadata ?? {}),
});

const project = events => Object.freeze({
  schema: 'mabinogi-mobile-mml-studio/canonical-project@2',
  id: 'fixture-project',
  title: 'fixture',
  sources: Object.freeze([]),
  events: Object.freeze(events),
});

// Four quarter notes forming a varied, independently-attacking line.
const line = (prefix, pitches, voice, from = 0, extra = {}) => pitches.map((pitch, index) =>
  note(`${prefix}${index + 1}`, pitch, String(from + index), String(from + index + 1), voice, extra));

// A block chord: every member attacks and releases together, so no member is an
// independent line no matter how high it sits.
const block = (prefix, pitches, voice, start, end, extra = {}) => pitches.map((pitch, index) =>
  note(`${prefix}${index + 1}`, pitch, String(start), String(end), voice, extra));

const MELODY_VOICE = 'track:0/channel:0';
const HARMONY_VOICE = 'track:1/channel:1';
const BASS_VOICE = 'track:2/channel:2';

// Bare MIDI carries no role metadata, so a polyphonic accompaniment voice leaves
// Core3 PENDING by design: nothing establishes which of its simultaneous lanes
// is the principal harmony, nor that the others are droppable. The fail-closed
// fixtures below are the regression for that. Where a fixture's subject is
// something else entirely, this supplies the score's own role evidence so the
// Core3 question is settled and the subject under test is isolated.
const scoredHarmony = (siblings = [['#1', 'Chord3']], voice = HARMONY_VOICE) => ({
  sourceRoleEvidence: [
    { laneId: `lane:${voice}#0`, role: 'Chord1', citation: 'fixture:score accompaniment, principal part' },
    ...siblings.map(([suffix, role]) => ({
      laneId: `lane:${voice}${suffix}`,
      role,
      citation: `fixture:score accompaniment, inner part ${suffix} marked non-core`,
    })),
  ],
});

const laneOf = (candidate, laneId) => candidate.lanes.find(lane => lane.id === laneId);
const diagnostic = (candidate, code) => candidate.diagnostics.find(item => item.code === code);
const ledgerFor = (candidate, eventId) => candidate.ledger.filter(entry => entry.eventId === eventId);
const sameBeat = (a, b) => f(a).cmp(b) === 0;

// ─── invariants asserted on every fixture ───────────────────────────────────

// ACCEPTANCE_CRITERIA.md Gate 2 / the G11-C coverage obligation: input event ids
// must equal assigned ∪ pending ∪ unassigned ∪ unsupported. Nothing may vanish,
// and nothing may appear that the source did not contain.
function assertAccountedFor(candidate, events) {
  const input = new Set(events.filter(event => event.kind === 'note').map(event => event.id));
  const assigned = new Set(candidate.ledger.filter(entry => entry.selected).map(entry => entry.eventId));
  const pending = new Set(candidate.ledger.filter(entry => entry.decision === ROLE_DECISIONS.PENDING).map(entry => entry.eventId));
  const omitted = new Set(candidate.ledger.filter(entry => entry.decision === ROLE_DECISIONS.OMIT_FROM_SIX).map(entry => entry.eventId));
  const unsupported = new Set(candidate.unsupportedSourceMaterial.map(item => item.eventId));
  const accounted = new Set([...assigned, ...pending, ...omitted, ...unsupported]);
  assert.deepEqual(accounted, input, 'every source event must be assigned, pending, unassigned, or retained as unsupported');
  assert.equal(candidate.coverage.complete, true);
  assert.deepEqual([...candidate.coverage.missingEventIds], []);
  assert.deepEqual([...candidate.coverage.unknownEventIds], []);
}

// MASTER_RULES.md §3: a candidate transformation must never erase the original
// identity. The ledger restates pitch/onset/duration, and they must still match.
function assertNoMutation(candidate, events) {
  const byId = new Map(events.filter(event => event.kind === 'note').map(event => [event.id, event]));
  assert.deepEqual([...candidate.coverage.mutatedEventIds], []);
  for (const entry of candidate.ledger) {
    const source = byId.get(entry.eventId);
    assert.ok(source, `ledger entry ${entry.eventId} must trace to a source event`);
    assert.equal(entry.sourcePitch, source.pitch, `${entry.eventId} pitch must be unchanged`);
    assert.ok(sameBeat(entry.sourceStart, source.start), `${entry.eventId} onset must be unchanged`);
    assert.ok(sameBeat(entry.sourceEnd, source.end), `${entry.eventId} duration must be unchanged`);
    assert.deepEqual([...entry.sourceIds], [...source.sourceIds]);
    assert.deepEqual([...entry.sourceEventIds], [...source.sourceEventIds]);
  }
}

// The candidate must be a pure function of the event set, not of the array order
// the caller happened to build.
function assertOrderIndependent(events, options) {
  const canonical = JSON.stringify(suggestRoleCandidates(project(events), options));
  const rotated = events.map((_, index) => events[(index + 1) % events.length]);
  const reversed = [...events].reverse();
  const byIdDesc = [...events].sort((a, b) => (a.id < b.id ? 1 : a.id > b.id ? -1 : 0));
  const byPitch = [...events].sort((a, b) => a.pitch - b.pitch);
  for (const [label, variant] of [['rotated', rotated], ['reversed', reversed], ['id-desc', byIdDesc], ['pitch-asc', byPitch]]) {
    assert.equal(JSON.stringify(suggestRoleCandidates(project(variant), options)), canonical,
      `${label} input order must produce an identical candidate`);
  }
}

function run(events, options) {
  const candidate = suggestRoleCandidates(project(events), options);
  assertAccountedFor(candidate, events);
  assertNoMutation(candidate, events);
  return candidate;
}

// ─── 1. obvious monophonic Lead + harmony + bass ─────────────────────────────

const obviousEvents = [
  ...line('m', [72, 74, 76, 72], MELODY_VOICE),
  ...block('ha', [60, 64, 67], HARMONY_VOICE, 0, 2),
  ...block('hb', [59, 62, 67], HARMONY_VOICE, 2, 4),
  ...line('b', [48, 50, 43, 45], BASS_VOICE),
];

// The accompaniment is a block triad, so G11-B yields three simultaneous lanes
// from one source voice. With the score's own role evidence supplied, which lane
// is principal and which are inner colour is settled, and Core3 can be complete.
const obviousScored = scoredHarmony([['#1', 'Chord3'], ['#2', 'Chord4']]);

test('fixture 1: Lead + harmony + bass yields a Core3 candidate that explains its own completeness', () => {
  const candidate = run(obviousEvents, obviousScored);
  assertOrderIndependent(obviousEvents, obviousScored);

  assert.equal(candidate.roles.Melody.status, 'ASSIGNED');
  assert.deepEqual([...candidate.roles.Melody.laneIds], [`lane:${MELODY_VOICE}#0`]);
  assert.equal(candidate.roles.Chord1.status, 'ASSIGNED');
  assert.equal(candidate.roles.Chord2.status, 'ASSIGNED');
  assert.deepEqual([...candidate.roles.Chord2.laneIds], [`lane:${BASS_VOICE}#0`]);

  assert.equal(candidate.core3.status, 'COMPLETE');
  assert.deepEqual([...candidate.core3.missingFunctions], []);
  assert.equal(candidate.core3.identityDependsOnEnrichment, false);

  // Completeness is argued, not merely asserted: each of the four musical
  // functions has to appear in the rationale with its own verdict.
  const codes = candidate.core3.rationale.map(item => item.code);
  assert.ok(codes.includes('CORE3_EVALUATED_INDEPENDENTLY_OF_FULL6'));
  assert.ok(codes.includes('LEAD_CONTINUITY_SOURCE_SUPPORTED'));
  assert.ok(codes.includes('PRINCIPAL_HARMONY_PRESENT'));
  assert.ok(codes.includes('BASS_SKELETON_PRESENT'));
  assert.equal(candidate.core3.functions.leadContinuity.satisfied, true);
  assert.equal(candidate.core3.functions.principalHarmony.satisfied, true);
  assert.equal(candidate.core3.functions.bassSkeleton.satisfied, true);
  assert.equal(candidate.core3.functions.essentialInnerSupport.satisfied, true);
  assert.equal(candidate.core3.canonicallyCompleteGate, 'CORE3');
});

test('fixture 1: the walking bass keeps its Lead evidence instead of having it erased', () => {
  const candidate = run(obviousEvents, obviousScored);
  const bass = laneOf(candidate, `lane:${BASS_VOICE}#0`);
  // MASTER_RULES.md §8: a numerical score must never be improved by erasing
  // Lead evidence. The bass is assigned Chord2 on a stronger tier while its
  // weaker Lead evidence survives, and the disagreement is reported.
  assert.equal(bass.roleSupport.Melody.tier, 3);
  assert.equal(bass.roleSupport.Chord2.tier, 2);
  assert.equal(bass.candidateRole, 'Chord2');
  const conflict = diagnostic(candidate, 'CONFLICTING_ROLE_EVIDENCE');
  assert.ok(conflict, 'competing role evidence must be reported, not resolved silently');
  assert.deepEqual(conflict.lanes.find(item => item.laneId === bass.id).primaryEvidenceRoles, ['Chord2', 'Melody']);
  assert.equal(conflict.deleted, false);
});

// ─── 2. Lead + harmony + bass + three enrichment voices ─────────────────────

const enrichedEvents = [
  ...line('m', [72, 74, 76, 72], MELODY_VOICE),
  ...block('ha', [60, 64], HARMONY_VOICE, 0, 2),
  ...block('hb', [59, 62], HARMONY_VOICE, 2, 4),
  ...line('b', [48, 50, 43, 45], BASS_VOICE),
  // A repeated-pitch ostinato: rhythmic detail, never an independent line.
  ...[0, 1, 2, 3, 4, 5, 6, 7].map(step =>
    note(`o${step}`, 67, String(f(step).div(2)), String(f(step + 1).div(2)), 'track:3/channel:3')),
  // A sustained two-pitch pad: texture, never an independent line.
  note('p1', 55, '0', '2', 'track:4/channel:4'),
  note('p2', 57, '2', '4', 'track:4/channel:4'),
];

test('fixture 2: six roles fill with Core3 complete on its own and Full6 explaining each addition', () => {
  const candidate = run(enrichedEvents, scoredHarmony());
  assertOrderIndependent(enrichedEvents, scoredHarmony());

  for (const role of SIX_ROLES) assert.equal(candidate.roles[role].status, 'ASSIGNED', `${role} must carry a lane`);
  assert.equal(candidate.core3.status, 'COMPLETE');
  assert.equal(candidate.core3.identityDependsOnEnrichment, false);

  // Full6 is a separate reading. Removing every enrichment role must leave the
  // Core3 verdict untouched.
  for (const role of ENRICHMENT_ROLE_NAMES) {
    const contribution = candidate.full6.roleContributions[role];
    assert.equal(contribution.status !== 'EMPTY', true, `${role} must report a contribution`);
    assert.ok(contribution.addedFunctions.length, `${role} must say what musical function it adds`);
  }
  for (const entry of candidate.full6.enrichmentRationale) {
    assert.equal(entry.removingLeavesCore3Intact, true, 'no enrichment lane may hold Core3 material here');
    assert.ok(entry.eventIds.length, 'every enrichment entry must name the source events supporting it');
  }
  assert.ok(candidate.full6.addedFunctions.length);
});

test('fixture 2: Core3 is evaluable without reading any Full6 field', () => {
  const candidate = run(enrichedEvents, scoredHarmony());
  const core3LaneIds = new Set(CORE3_ROLE_NAMES.flatMap(role => candidate.roles[role].laneIds));
  const enrichmentLaneIds = ENRICHMENT_ROLE_NAMES.flatMap(role => candidate.roles[role].laneIds);
  for (const laneId of enrichmentLaneIds) assert.equal(core3LaneIds.has(laneId), false);
  for (const item of candidate.core3.rationale) {
    for (const laneId of item.laneIds ?? []) assert.equal(core3LaneIds.has(laneId), true,
      'the Core3 rationale must argue from Core3 lanes only');
  }
});

// ─── 3. vocal-rest instrumental hand-off ────────────────────────────────────

const handOffEvents = [
  // "Vocal": phrases either side of a rest at beats 2-5.
  ...line('v', [72, 74], MELODY_VOICE, 0),
  ...line('w', [76, 72], MELODY_VOICE, 5),
  // Instrumental answer that fills the rest, with a line of its own.
  ...line('i', [79, 77, 76], 'track:9/channel:5', 2),
  ...block('ha', [60, 64], HARMONY_VOICE, 0, 4),
  ...block('hb', [59, 62], HARMONY_VOICE, 4, 7),
  ...line('b', [48, 50, 43, 45, 48, 50, 43], BASS_VOICE),
];

test('fixture 3: an instrumental answer continues Melody instead of creating a false gap', () => {
  const candidate = run(handOffEvents, scoredHarmony());
  assertOrderIndependent(handOffEvents, scoredHarmony());

  assert.equal(candidate.roles.Melody.status, 'ASSIGNED');
  assert.equal(candidate.roles.Melody.laneIds.length, 2, 'both the vocal lane and the instrumental answer carry Melody');
  assert.ok(candidate.roles.Melody.laneIds.includes('lane:track:9/channel:5#0'));
  assert.ok(candidate.roles.Melody.reasons.includes('LEAD_HANDOFF_CONTINUATION'));
  assert.equal(candidate.core3.functions.leadContinuity.sourceSupportedHandOff, true);

  // A rest is not a contest, and "not proven Vocal" never demotes anything.
  assert.equal(diagnostic(candidate, 'COMPETING_LEAD_CANDIDATES'), undefined);
  assert.equal(candidate.core3.functions.leadContinuity.satisfied, true);
  assert.equal(candidate.core3.status, 'COMPLETE');
});

// ─── 4. a source top voice that is clearly accompaniment ────────────────────

const topAccompanimentEvents = [
  // The highest pitches in the whole fixture, but every member of the block
  // attacks and releases with its siblings.
  ...block('ta', [79, 72, 67], 'track:1/channel:1', 0, 2),
  ...block('tb', [77, 71, 65], 'track:1/channel:1', 2, 4),
  // The actual line, a tenth lower.
  ...line('m', [60, 62, 64, 60], MELODY_VOICE),
  ...line('b', [48, 50, 43, 45], BASS_VOICE),
];

test('fixture 4: the highest source voice does not become Melody on register alone', () => {
  const candidate = run(topAccompanimentEvents);
  assertOrderIndependent(topAccompanimentEvents);

  const top = laneOf(candidate, 'lane:track:1/channel:1#0');
  assert.equal(top.metrics.maxPitch, 79, 'the accompaniment top voice really is the highest material');
  const register = top.evidence.find(record => record.signal === 'register_position');
  assert.equal(register.measurement.registerRankFromTop, 0, 'it ranks first by register');
  assert.equal(register.strength, 'supporting', 'register may never be primary evidence');
  assert.equal(top.roleSupport.Melody.tier, null, 'and it still carries no Lead evidence');

  assert.deepEqual([...candidate.roles.Melody.laneIds], [`lane:${MELODY_VOICE}#0`]);
  const melody = laneOf(candidate, `lane:${MELODY_VOICE}#0`);
  assert.equal(melody.roleSupport.Melody.tierName, 'INDEPENDENT_MELODIC_LINE');
  // The decision must cite the function measurements, never the register record.
  for (const evidenceId of candidate.roles.Melody.evidenceIds) {
    assert.ok(/melodic_contour|attack_independence|source_role_hint|trusted_symbolic_role/.test(evidenceId),
      `Melody was justified by ${evidenceId}, which is not a role-bearing signal`);
  }
});

// ─── 5. strong bass + essential inner voice ─────────────────────────────────

const essentialInnerEvents = [
  // The Lead sings throughout, in a lower register than the accompaniment.
  ...line('m', [60, 62, 64, 60, 62, 64], MELODY_VOICE, 0),
  // Principal harmony and bass both rest across beats 2-4.
  ...block('ha', [67, 71], HARMONY_VOICE, 0, 2),
  ...block('hb', [66, 70], HARMONY_VOICE, 4, 6),
  ...line('b', [48, 50], BASS_VOICE, 0),
  ...line('c', [43, 45], BASS_VOICE, 4),
  // A sustained inner voice is the only accompaniment left in that window. It
  // sits above the Lead, so it is never the harmonic floor and cannot reach
  // Chord2 through the bass-function path.
  note('in1', 67, '2', '3', 'track:6/channel:6'),
  note('in2', 69, '3', '4', 'track:6/channel:6'),
];

test('fixture 5: Chord2 carries the bass skeleton plus essential inner support, not Bass-only', () => {
  const candidate = run(essentialInnerEvents, scoredHarmony());
  assertOrderIndependent(essentialInnerEvents, scoredHarmony());

  const chord2 = candidate.roles.Chord2.laneIds;
  assert.ok(chord2.length >= 2, 'Chord2 must be able to hold more than the bass skeleton');
  assert.ok(chord2.includes(`lane:${BASS_VOICE}#0`), 'the bass skeleton is in Chord2');
  assert.ok(chord2.includes('lane:track:6/channel:6#0'), 'the essential inner voice is in Chord2');

  const support = candidate.core3.functions.essentialInnerSupport;
  assert.equal(support.satisfied, true);
  assert.equal(support.status, 'PRESENT');
  assert.ok(support.promotedToChord2.includes('lane:track:6/channel:6#0'));

  // The inner support sits well above the bass, so Chord2 is demonstrably not
  // a Bass-only role here.
  const inner = laneOf(candidate, 'lane:track:6/channel:6#0');
  const bass = laneOf(candidate, `lane:${BASS_VOICE}#0`);
  assert.ok(inner.metrics.minPitch > bass.metrics.maxPitch);
  assert.equal(candidate.core3.status, 'COMPLETE');
  // Core3 never falls silent, and after the promotion the Lead is never left
  // without accompaniment either.
  assert.deepEqual([...candidate.core3.sourceCoverage.uncoveredSoundingWindows], []);
  assert.deepEqual([...candidate.core3.sourceCoverage.unaccompaniedSoundingWindows], []);
});

// ─── 6. ambiguous two-lead situation ────────────────────────────────────────

const twoLeadEvents = [
  ...line('p', [72, 74, 76, 72], 'track:0/channel:0'),
  ...line('q', [67, 69, 71, 67], 'track:1/channel:1'),
  ...line('b', [48, 50, 43, 45], BASS_VOICE),
];

test('fixture 6: two overlapping Lead candidates stay PENDING instead of one being deleted', () => {
  const candidate = run(twoLeadEvents);
  assertOrderIndependent(twoLeadEvents);

  assert.equal(candidate.roles.Melody.status, 'PENDING');
  assert.deepEqual([...candidate.roles.Melody.laneIds], []);
  assert.deepEqual([...candidate.roles.Melody.competingLaneIds].sort(),
    ['lane:track:0/channel:0#0', 'lane:track:1/channel:1#0']);

  const pendingDiagnostic = diagnostic(candidate, 'COMPETING_LEAD_CANDIDATES');
  assert.ok(pendingDiagnostic);
  assert.equal(pendingDiagnostic.deleted, false);
  const leadMerge = candidate.mergeDiagnostics.pendingRoleGroups.find(group => group.role === 'Melody');
  assert.ok(leadMerge, 'competing role-less Lead lanes get a merge diagnostic');
  assert.equal(leadMerge.authority, 'SUGGESTION_ONLY');
  assert.equal(leadMerge.status, 'COLLISION_REVIEW', 'overlapping Lead hypotheses are not silently coalesced');
  assert.equal(leadMerge.fullyLosslessTogether, false);
  assert.ok(leadMerge.collisionEventCount > 0);
  assert.equal(leadMerge.leadReviewRequired, true);

  // Neither candidate lost an event, and both keep their evidence.
  const pendingLaneIds = candidate.pending.map(item => item.laneId).sort();
  assert.deepEqual(pendingLaneIds, ['lane:track:0/channel:0#0', 'lane:track:1/channel:1#0']);
  for (const item of candidate.pending) {
    assert.equal(item.proposedRole, 'Melody');
    assert.ok(item.eventIds.length, 'a pending lane still names its source events');
    assert.ok(item.evidenceIds.length, 'a pending lane still carries the evidence that made it a candidate');
  }
  for (const id of ['p1', 'q1']) {
    const entries = ledgerFor(candidate, id);
    assert.equal(entries.length, 1);
    assert.equal(entries[0].decision, ROLE_DECISIONS.PENDING);
    assert.equal(entries[0].uncertainty, 'PENDING');
  }
  assert.equal(candidate.core3.status, 'PENDING');
});

// ─── 7. more than six musically meaningful source lanes ─────────────────────

const pad = (prefix, low, high, voice) => [
  note(`${prefix}1`, low, '0', '2', voice),
  note(`${prefix}2`, high, '2', '4', voice),
];

const overflowEvents = [
  ...line('m', [72, 74, 76, 72], MELODY_VOICE),
  ...block('ha', [60, 64], HARMONY_VOICE, 0, 2),
  ...block('hb', [59, 62], HARMONY_VOICE, 2, 4),
  ...line('b', [48, 50, 43, 45], BASS_VOICE),
  ...pad('p', 55, 57, 'track:3/channel:3'),
  ...pad('q', 56, 58, 'track:4/channel:4'),
  ...pad('r', 61, 63, 'track:5/channel:5'),
  ...pad('s', 65, 66, 'track:6/channel:6'),
];

test('fixture 7: lanes beyond six-role capacity overflow explicitly instead of disappearing', () => {
  const candidate = run(overflowEvents);
  assertOrderIndependent(overflowEvents);

  assert.equal(candidate.lanes.length, 8, 'the fixture really does present more lanes than roles');
  const overflow = diagnostic(candidate, 'SOURCE_LANE_OVERFLOW');
  assert.ok(overflow, 'the capacity problem must be reported');
  assert.equal(overflow.deleted, false);
  assert.equal(overflow.roleCapacity, 6);

  assert.ok(candidate.unassigned.length >= 2);
  for (const item of candidate.unassigned) {
    assert.equal(item.reason, 'SIX_ROLE_CAPACITY_EXCEEDED');
    assert.equal(item.provisional, true, 'omission from this proposal is provisional');
    assert.ok(item.eventIds.length, 'the omitted lane still names its source events');
    assert.ok(item.sourceEventIds.length, 'and still names its raw source event ids');
    assert.equal(item.competingRole, 'Chord3', 'the role it lost out on is recorded');
  }
  for (const entry of candidate.ledger.filter(item => item.decision === ROLE_DECISIONS.OMIT_FROM_SIX)) {
    assert.equal(entry.selected, false);
    assert.equal(entry.provisional, true);
    assert.ok(entry.sourcePitch !== null, 'an omitted event keeps its original identity in the ledger');
  }
  assert.equal(candidate.mergeDiagnostics.authority, 'SUGGESTION_ONLY');
  assert.equal(candidate.mergeDiagnostics.overflowLanes.length, candidate.unassigned.length);
  for (const lane of candidate.mergeDiagnostics.overflowLanes) {
    assert.ok(lane.targets.length === 6);
    assert.ok(lane.targets.every(target => target.authority === 'SUGGESTION_ONLY'));
  }
  // Six-role capacity never authorises deletion.
  assert.equal(candidate.coverage.sourceEventCount,
    candidate.coverage.assignedEventCount + candidate.coverage.pendingEventCount
    + candidate.coverage.unassignedEventCount + candidate.coverage.unsupportedEventCount);
});

// ─── 8. simultaneous same-pitch source events ───────────────────────────────

const unisonEvents = [
  ...line('m', [72, 74, 76, 72], MELODY_VOICE),
  ...block('ha', [60, 64], HARMONY_VOICE, 0, 2),
  ...block('hb', [59, 62], HARMONY_VOICE, 2, 4),
  ...line('b', [48, 50, 43, 45], BASS_VOICE),
  // Same pitch, same onset, two different source voices.
  note('u1', 64, '0', '2', 'track:7/channel:7'),
];

test('fixture 8: simultaneous same-pitch events stay traceable and are reported, not merged', () => {
  const candidate = run(unisonEvents);
  assertOrderIndependent(unisonEvents);

  const doubling = diagnostic(candidate, 'SIMULTANEOUS_SAME_PITCH_DOUBLING');
  assert.ok(doubling, 'same-pitch doubling is a review signal under MASTER_RULES.md §6');
  assert.equal(doubling.deleted, false);
  const pair = doubling.pairs.find(item => item.eventIds.includes('u1'));
  assert.ok(pair, 'the doubled pair must name both source events');
  assert.equal(pair.pitch, 64);
  assert.equal(pair.eventIds.length, 2);
  assert.notEqual(pair.laneIds[0], pair.laneIds[1], 'the two events remain in separate lanes');

  for (const eventId of pair.eventIds) {
    assert.ok(ledgerFor(candidate, eventId).length, `${eventId} must still have a ledger decision`);
  }
});

// ─── 9. one musical role represented by several lanes ───────────────────────

const multiLaneRoleEvents = [
  ...line('x', [72, 74, 76], MELODY_VOICE, 0, { sourceId: 'score-a' }),
  ...line('y', [77, 76, 74], 'track:8/channel:0', 3, { sourceId: 'score-b' }),
  ...block('ha', [60, 64], HARMONY_VOICE, 0, 3),
  ...block('hb', [59, 62], HARMONY_VOICE, 3, 6),
  ...line('b', [48, 50, 43, 45, 48, 50], BASS_VOICE),
];

test('fixture 9: a role may group several lanes without any lane losing its provenance', () => {
  const candidate = run(multiLaneRoleEvents);
  assertOrderIndependent(multiLaneRoleEvents);

  const laneIds = candidate.roles.Melody.laneIds;
  assert.equal(laneIds.length, 2);
  const grouped = laneIds.map(id => laneOf(candidate, id));
  assert.notEqual(grouped[0].sourceVoice, grouped[1].sourceVoice, 'the lanes keep separate source voices');
  assert.deepEqual([...grouped[0].sourceIds], ['score-a']);
  assert.deepEqual([...grouped[1].sourceIds], ['score-b']);
  assert.equal(grouped[0].eventIds.some(id => grouped[1].eventIds.includes(id)), false);

  // Grouping the role must not flatten the per-lane provenance away.
  const roleEventIds = new Set(candidate.roles.Melody.eventIds);
  for (const lane of grouped) for (const id of lane.eventIds) assert.ok(roleEventIds.has(id));
  for (const id of roleEventIds) {
    const entries = ledgerFor(candidate, id);
    assert.equal(entries.length, 1);
    assert.ok(laneIds.includes(entries[0].laneId), 'every ledger entry names the lane it came from');
  }
  const multiLane = diagnostic(candidate, 'ROLE_CARRIES_MULTIPLE_LANES');
  assert.ok(multiLane);
  assert.ok(multiLane.roles.some(entry => entry.role === 'Melody' && entry.laneIds.length === 2));
});

// ─── 10. source role change candidates ──────────────────────────────────────

const declaredRoleEvents = [
  ...line('m', [72, 74, 76, 72], MELODY_VOICE, 0, { role: 'Melody' }),
  ...block('ha', [60, 64], HARMONY_VOICE, 0, 2, { role: 'Chord3' }),
  ...block('hb', [59, 62], HARMONY_VOICE, 2, 4, { role: 'Chord3' }),
  ...line('b', [48, 50, 43, 45], BASS_VOICE, 0, { role: 'Chord2' }),
];

test('fixture 10: a role move is an explicit ledger entry, and an unchanged role is KEEP_ROLE', () => {
  const movedLaneId = `lane:${HARMONY_VOICE}#0`;
  const candidate = run(declaredRoleEvents, { roleOverrides: { [movedLaneId]: 'Chord1' } });

  // Chord3 -> Chord1 is a move, and the ledger states both ends of it.
  const moved = laneOf(candidate, movedLaneId);
  assert.ok(moved.eventIds.length);
  for (const id of moved.eventIds) {
    const [entry] = ledgerFor(candidate, id);
    assert.equal(entry.decision, ROLE_DECISIONS.MOVE_ROLE);
    assert.equal(entry.sourceRole, 'Chord3');
    assert.equal(entry.candidateRole, 'Chord1');
    assert.ok(entry.reason.includes('CALLER_ROLE_OVERRIDE'));
  }
  // The declared Lead and the declared bass keep their roles, also explicitly.
  for (const id of ['m1', 'b1']) {
    const [entry] = ledgerFor(candidate, id);
    assert.equal(entry.decision, ROLE_DECISIONS.KEEP_ROLE);
    assert.equal(entry.sourceRole, entry.candidateRole);
  }
  // Both ends of a move must be diffable from the ledger alone.
  const moves = candidate.ledger.filter(entry => entry.decision === ROLE_DECISIONS.MOVE_ROLE);
  assert.ok(moves.length);
  for (const move of moves) assert.notEqual(move.sourceRole, move.candidateRole);
});

test('fixture 10: a source-supported Lead is never demoted silently', () => {
  // MASTER_RULES.md §4 / SOURCE_POLICY.md §4: demotion needs positive role
  // evidence and a demotion report. G11-C is not that gate, so it refuses.
  const candidate = run(declaredRoleEvents, {
    roleOverrides: { [`lane:${MELODY_VOICE}#0`]: 'Chord3' },
  });

  assert.equal(candidate.roles.Melody.status, 'PENDING');
  assert.deepEqual([...candidate.roles.Melody.reasons], ['DECLARED_LEAD_DEMOTION_UNRESOLVED']);
  assert.equal(candidate.roles.Chord3.laneIds.includes(`lane:${MELODY_VOICE}#0`), false,
    'the override must not move the Lead into an enrichment role');
  // Nor may some other lane quietly be promoted into the vacated Melody role.
  assert.deepEqual([...candidate.roles.Melody.laneIds], []);

  const pendingEntry = candidate.pending.find(item => item.laneId === `lane:${MELODY_VOICE}#0`);
  assert.ok(pendingEntry);
  assert.deepEqual([...pendingEntry.blockers], ['LEAD_DEMOTION_NOT_EVALUATED']);
  assert.equal(pendingEntry.gate, 'studio/backend/arbitration/lead-demotion.mjs#evaluateLeadDemotion');
  for (const id of ['m1', 'm2', 'm3', 'm4']) {
    const [entry] = ledgerFor(candidate, id);
    assert.equal(entry.decision, ROLE_DECISIONS.PENDING);
    assert.equal(entry.proposedRole, 'Chord3');
    assert.equal(entry.sourceRole, 'Melody');
  }
  assert.equal(candidate.core3.status, 'PENDING');
  assert.ok(candidate.core3.missingFunctions.includes('lead-continuity'));
});

test('a declared candidate duplication is recorded as a duplication, never inferred', () => {
  const laneId = `lane:${BASS_VOICE}#0`;
  const candidate = run(declaredRoleEvents, {
    duplications: [{
      laneId,
      roles: ['Chord2', 'Chord5'],
      reason: 'Bass reinforcement requested for the second performer.',
      evidence: ['fixture:review-note-1'],
    }],
  });

  const entries = ledgerFor(candidate, 'b1');
  assert.equal(entries.length, 2, 'one ledger entry per candidate role the event appears in');
  for (const entry of entries) {
    assert.equal(entry.decision, ROLE_DECISIONS.DUPLICATE_WITH_JUSTIFICATION);
    assert.equal(entry.duplicate, true);
    assert.equal(entry.sourcePitch, 48, 'the original source event stays identifiable in every copy');
    assert.deepEqual([...entry.sourceEventIds], ['raw:b1']);
  }
  assert.deepEqual(entries.map(entry => entry.candidateRole).sort(), ['Chord2', 'Chord5']);
  assert.ok(candidate.coverage.duplicatedEventIds.includes('b1'));
  assert.deepEqual([...candidate.roles.Chord5.duplicatedLaneIds], [laneId]);

  // A duplication cannot be conjured without a justification and evidence.
  assert.throws(() => suggestRoleCandidates(project(declaredRoleEvents), {
    duplications: [{ laneId, roles: ['Chord2', 'Chord5'], reason: '', evidence: [] }],
  }), /positive reason/);
  assert.throws(() => suggestRoleCandidates(project(declaredRoleEvents), {
    duplications: [{ laneId, roles: ['Chord2', 'Chord5'], reason: 'why', evidence: [] }],
  }), /explicit evidence/);
});

// ─── 11. shuffled input ─────────────────────────────────────────────────────

test('fixture 11: caller array order never changes the candidate', () => {
  // Every fixture above already runs this check; this pins it as its own
  // regression against Map/Set enumeration order leaking into a decision.
  for (const events of [obviousEvents, enrichedEvents, handOffEvents, essentialInnerEvents, overflowEvents, twoLeadEvents]) {
    assertOrderIndependent(events);
  }
});

// ─── 12. exact rational timing ──────────────────────────────────────────────

const tripletEvents = [
  note('t1', 72, '0', '1/3', MELODY_VOICE),
  note('t2', 74, '1/3', '2/3', MELODY_VOICE),
  note('t3', 76, '2/3', '1', MELODY_VOICE),
  note('t4', 72, '1', '4/3', MELODY_VOICE),
  note('t5', 74, '4/3', '5/3', MELODY_VOICE),
  note('t6', 76, '5/3', '2', MELODY_VOICE),
  ...block('ha', [60, 64], HARMONY_VOICE, '0', '1'),
  ...block('hb', [59, 62], HARMONY_VOICE, '1', '2'),
  note('b1', 48, '0', '2/3', BASS_VOICE),
  note('b2', 50, '2/3', '4/3', BASS_VOICE),
  note('b3', 43, '4/3', '2', BASS_VOICE),
];

test('fixture 12: exact rational timing survives, and no decision reads a float', () => {
  const candidate = run(tripletEvents, scoredHarmony());
  assertOrderIndependent(tripletEvents, scoredHarmony());

  // 1/3 must still be 1/3 in the candidate, never 0.3333333333333333.
  const serialized = JSON.stringify(candidate);
  assert.equal(/\d\.\d{3,}/.test(serialized), false, 'no float-projected beat may appear anywhere in the candidate');
  assert.ok(serialized.includes('1/3'));

  const [entry] = ledgerFor(candidate, 't2');
  assert.equal(entry.sourceStart, '1/3');
  assert.equal(entry.sourceEnd, '2/3');
  const melody = laneOf(candidate, `lane:${MELODY_VOICE}#0`);
  assert.equal(melody.metrics.soundingTime, '2');
  assert.deepEqual([...melody.metrics.attackBeats], ['0', '1/3', '2/3', '1', '4/3', '5/3']);
  const bass = laneOf(candidate, `lane:${BASS_VOICE}#0`);
  assert.equal(bass.metrics.timeAsLowestSoundingPitch, '2');
  assert.equal(candidate.core3.status, 'COMPLETE');
});

// ─── 13. G11-B silence-separated chains ─────────────────────────────────────

const silenceSeparatedEvents = [
  // One source voice, two phrases with real silence between them. G11-B packs
  // both chains into a single lane; that is a packing fact, not a continuous
  // voice, and G11-C must not read it as one.
  ...line('v', [72, 74, 76], MELODY_VOICE, 0),
  ...line('w', [76, 74, 72], MELODY_VOICE, 5),
  ...block('ha', [60, 64], HARMONY_VOICE, 0, 4),
  ...block('hb', [59, 62], HARMONY_VOICE, 4, 8),
  ...line('b', [48, 50, 43, 45, 48, 50, 43, 45], BASS_VOICE),
];

test('fixture 13: lane packing across a silence is never asserted to be continuous Lead', () => {
  const candidate = run(silenceSeparatedEvents);
  assertOrderIndependent(silenceSeparatedEvents);

  const melody = laneOf(candidate, `lane:${MELODY_VOICE}#0`);
  assert.equal(melody.chainIds.length, 2, 'the two phrases are separate G11-B chains');
  assert.equal(melody.continuity.continuousVoiceAsserted, false);
  assert.ok(melody.continuity.silenceJunctions.length, 'the silence junction is retained');
  assert.equal(melody.continuity.silenceJunctions[0].from, '3');
  assert.equal(melody.continuity.silenceJunctions[0].to, '5');

  const continuity = melody.evidence.find(record => record.signal === 'continuity');
  assert.equal(continuity.strength, 'supporting');
  assert.equal(continuity.measurement.continuousVoiceAsserted, false);

  const packing = diagnostic(candidate, 'LANE_PACKING_IS_NOT_CONTINUITY');
  assert.ok(packing);
  assert.equal(packing.continuousVoiceAsserted, false);
  assert.ok(packing.lanes.some(item => item.laneId === melody.id && item.role === 'Melody'));

  // Lead continuity is still reported, but the claim is bounded.
  assert.equal(candidate.core3.functions.leadContinuity.satisfied, true);
  assert.equal(candidate.core3.functions.leadContinuity.continuousAcrossSilence, false);
  assert.ok(candidate.core3.functions.leadContinuity.silenceJunctions.length);
});

// ─── 14. same MIDI channel, different source track ──────────────────────────

const sharedChannelEvents = [
  ...line('m', [72, 74, 76, 72], 'track:0/channel:1'),
  ...line('n', [60, 62, 64, 60], 'track:1/channel:1'),
  ...line('b', [48, 50, 43, 45], 'track:2/channel:1'),
];

test('fixture 14: one MIDI channel on two tracks keeps two distinct provenances', () => {
  const candidate = run(sharedChannelEvents);
  assertOrderIndependent(sharedChannelEvents);

  const voices = candidate.lanes.map(lane => lane.sourceVoice);
  assert.deepEqual([...new Set(voices)].sort(), ['track:0/channel:1', 'track:1/channel:1', 'track:2/channel:1']);
  assert.equal(candidate.lanes.length, 3, 'a shared channel number must not merge two tracks into one lane');

  for (const lane of candidate.lanes) {
    const identity = lane.evidence.find(record => record.signal === 'source_voice_identity');
    assert.equal(identity.measurement.sourceVoice, lane.sourceVoice);
    assert.equal(identity.evidenceClass, 'symbolic');
  }
  for (const entry of candidate.ledger) {
    assert.ok(entry.sourceVoice, 'every ledger entry names the source voice it came from');
  }
});

// ─── 15. percussion / unsupported source material ───────────────────────────

const percussionEvents = [
  ...line('m', [72, 74, 76, 72], MELODY_VOICE),
  ...block('ha', [60, 64], HARMONY_VOICE, 0, 2),
  ...block('hb', [59, 62], HARMONY_VOICE, 2, 4),
  ...line('b', [48, 50, 43, 45], BASS_VOICE),
  // GM channel 10 (index 9): drum-kit selectors, not pitches.
  note('d1', 36, '0', '1', 'track:9/channel:9', { metadata: { channel: 9 } }),
  note('d2', 38, '1', '2', 'track:9/channel:9', { metadata: { channel: 9 } }),
  // An adapter that tagged its material unsupported instead.
  note('x1', 42, '2', '3', 'track:10/channel:3', { tags: ['unsupported'] }),
];

test('fixture 15: percussion and unsupported material never become a pitched role', () => {
  const candidate = run(percussionEvents, scoredHarmony());
  assertOrderIndependent(percussionEvents, scoredHarmony());

  const retained = candidate.unsupportedSourceMaterial.map(item => item.eventId);
  assert.deepEqual(retained, ['d1', 'd2', 'x1']);
  for (const item of candidate.unsupportedSourceMaterial) {
    assert.equal(item.status, 'PENDING');
    assert.ok(item.reason);
    assert.ok(item.sourceEventIds.length, 'the raw source event ids are retained for a later drum-aware stage');
  }
  assert.equal(candidate.unsupportedSourceMaterial[0].reason, 'PERCUSSION_CHANNEL_EVENT');
  assert.equal(candidate.unsupportedSourceMaterial[2].reason, 'UNSUPPORTED_SOURCE_TAG:unsupported');

  const assignedEventIds = new Set(candidate.ledger.map(entry => entry.eventId));
  for (const id of retained) assert.equal(assignedEventIds.has(id), false, `${id} must not receive a pitched role`);
  for (const lane of candidate.lanes) for (const id of retained) assert.equal(lane.eventIds.includes(id), false);

  const reported = diagnostic(candidate, 'UNSUPPORTED_SOURCE_MATERIAL_RETAINED');
  assert.ok(reported);
  assert.equal(reported.deleted, false);
  assert.equal(candidate.coverage.unsupportedEventCount, 3);
  assert.equal(candidate.core3.status, 'COMPLETE', 'pitched Core3 is unaffected by retained drum evidence');
});

// ─── 16. Core3 non-empty but musically incomplete ───────────────────────────

test('fixture 16: three non-empty roles are not completeness', () => {
  // The inner harmony line is pinned into Chord2, so all three Core3 roles hold
  // events -- but nothing in Chord2 has bass-function evidence, and the real
  // bass is pushed out to enrichment.
  const candidate = run(obviousEvents, {
    roleOverrides: {
      [`lane:${HARMONY_VOICE}#1`]: 'Chord2',
      [`lane:${BASS_VOICE}#0`]: 'Chord3',
    },
  });

  for (const role of CORE3_ROLE_NAMES) {
    assert.ok(candidate.roles[role].eventIds.length, `${role} is non-empty`);
  }
  assert.notEqual(candidate.core3.status, 'COMPLETE');
  assert.equal(candidate.core3.status, 'INCOMPLETE');
  assert.ok(candidate.core3.missingFunctions.includes('bass-skeleton'));
  assert.equal(candidate.core3.functions.bassSkeleton.satisfied, false);
  assert.equal(candidate.core3.functions.bassSkeleton.status, 'ABSENT');
  assert.ok(candidate.core3.rationale.some(item => item.code === 'BASS_SKELETON_MISSING'));
});

// ─── 17. essential material placed only in Chord3-Chord5 ────────────────────

test('fixture 17: Full6 may not hide an incomplete Core3', () => {
  // The inner voice that is the only accompaniment across beats 2-4 is pinned
  // into Chord3 instead of Core3.
  const innerLaneId = 'lane:track:6/channel:6#0';
  const candidate = run(essentialInnerEvents, { ...scoredHarmony(), roleOverrides: { [innerLaneId]: 'Chord3' } });

  assert.ok(candidate.roles.Chord3.laneIds.includes(innerLaneId));
  assert.ok(candidate.core3.essentialEventIds.length, 'the essential events are still identified');

  assert.equal(candidate.core3.status, 'INCOMPLETE');
  assert.equal(candidate.core3.identityDependsOnEnrichment, true);
  assert.ok(candidate.core3.missingFunctions.includes('essential-inner-support'));
  assert.deepEqual([...candidate.core3.functions.essentialInnerSupport.misplacedLaneIds], [innerLaneId]);
  assert.ok(candidate.core3.rationale.some(item => item.code === 'ESSENTIAL_MATERIAL_OUTSIDE_CORE3'));
  assert.ok(candidate.core3.conflicts.some(item => item.code === 'ESSENTIAL_MATERIAL_OUTSIDE_CORE3'));

  const misplaced = diagnostic(candidate, 'ESSENTIAL_MATERIAL_IN_ENRICHMENT');
  assert.ok(misplaced);
  assert.equal(misplaced.deleted, false);
  assert.deepEqual([...misplaced.laneIds], [innerLaneId]);

  // Full6 must report the dependency rather than present itself as a benefit.
  assert.equal(candidate.full6.status, 'CORE3_DEPENDENCY');
  assert.equal(candidate.full6.roleContributions.Chord3.status, 'ESSENTIAL_MATERIAL_MISPLACED');
  const entry = candidate.full6.enrichmentRationale.find(item => item.laneId === innerLaneId);
  assert.equal(entry.essential, true);
  assert.equal(entry.removingLeavesCore3Intact, false);
});

// ─── 18. redundant enrichment ───────────────────────────────────────────────

const redundantEvents = [
  ...line('m', [72, 74, 76, 72], MELODY_VOICE),
  ...block('ha', [60, 64], HARMONY_VOICE, 0, 2),
  ...block('hb', [59, 62], HARMONY_VOICE, 2, 4),
  ...line('b', [48, 50, 43, 45], BASS_VOICE),
  // A second source voice doubling the principal harmony note for note.
  note('dup1', 64, '0', '2', 'track:7/channel:7'),
  note('dup2', 62, '2', '4', 'track:7/channel:7'),
];

test('fixture 18: a duplicating enrichment lane is reported as duplication, not as a benefit', () => {
  const candidate = run(redundantEvents, scoredHarmony());
  assertOrderIndependent(redundantEvents, scoredHarmony());

  const dupLaneId = 'lane:track:7/channel:7#0';
  const entry = candidate.full6.enrichmentRationale.find(item => item.laneId === dupLaneId);
  assert.ok(entry, 'the duplicating lane still holds an enrichment slot and is still reported');
  assert.equal(entry.useful, false);
  assert.ok(entry.duplicationRisks.length);
  assert.equal(entry.duplicationRisks[0].code, 'DUPLICATES_CORE3_PITCHES');
  assert.equal(entry.duplicationRatio, '1');
  assert.equal(entry.measurement.addedPitchClassTime, '0', 'it adds no pitch class Core3 lacks');

  assert.ok(candidate.full6.duplicationRisks.some(risk => risk.laneId === dupLaneId));
  assert.equal(candidate.full6.status, 'REVIEW');

  // Reported, never removed.
  const duplication = diagnostic(candidate, 'ROLE_DUPLICATION');
  assert.ok(duplication);
  assert.equal(duplication.deleted, false);
  for (const id of ['dup1', 'dup2']) assert.equal(ledgerFor(candidate, id).length, 1);
  assert.equal(candidate.core3.status, 'COMPLETE', 'the duplication does not damage Core3');
});

// ─── 19. useful enrichment ──────────────────────────────────────────────────

const usefulEnrichmentEvents = [
  ...line('m', [72, 74, 76, 72], MELODY_VOICE),
  ...block('ha', [60, 64], HARMONY_VOICE, 0, 2),
  ...block('hb', [59, 62], HARMONY_VOICE, 2, 4),
  ...line('b', [48, 50, 43, 45], BASS_VOICE),
  // A counter-line: its own pitches, on its own offbeat attacks.
  ...[0, 1, 2, 3].map(step =>
    note(`c${step}`, [66, 69, 68, 65][step], String(f(1).div(2).add(step)), String(f(3).div(2).add(step)), 'track:7/channel:7')),
];

// Two independently-varied lines are genuinely ambiguous on derived evidence
// alone -- fixture 6 shows that case staying PENDING. Here the score says which
// part is the Lead, so the counter-line can be read as enrichment rather than as
// a rival Lead. Trusted symbolic role evidence requires a citation.
const leadDeclared = {
  sourceRoleEvidence: [
    { sourceVoice: MELODY_VOICE, role: 'Melody', citation: 'fixture:score P1 voice 1' },
    ...scoredHarmony().sourceRoleEvidence,
  ],
};

test('fixture 19: source-supported counter-line is distinguished from duplication', () => {
  const candidate = run(usefulEnrichmentEvents, leadDeclared);
  assertOrderIndependent(usefulEnrichmentEvents, leadDeclared);

  const melody = laneOf(candidate, `lane:${MELODY_VOICE}#0`);
  assert.equal(melody.roleSupport.Melody.tierName, 'DECLARED_SOURCE_ROLE');
  const trusted = melody.evidence.find(record => record.signal === 'trusted_symbolic_role');
  assert.equal(trusted.strength, 'primary');
  assert.equal(trusted.evidenceClass, 'symbolic');
  assert.equal(trusted.measurement.citation, 'fixture:score P1 voice 1');

  const counterLaneId = 'lane:track:7/channel:7#0';
  const entry = candidate.full6.enrichmentRationale.find(item => item.laneId === counterLaneId);
  assert.ok(entry);
  assert.equal(entry.useful, true);
  assert.deepEqual([...entry.duplicationRisks], []);
  assert.ok(entry.addedFunctions.includes('counter-line'));
  assert.ok(entry.addedFunctions.includes('inner-harmony'));
  assert.ok(f(entry.measurement.addedPitchClassTime).cmp(0) > 0);
  assert.equal(entry.measurement.independentAttacks, 4, 'none of its attacks coincide with a Core3 attack');
  assert.equal(entry.removingLeavesCore3Intact, true);

  assert.ok(candidate.full6.addedFunctions.includes('counter-line'));
  assert.equal(candidate.full6.roleContributions.Chord3.status, 'USEFUL');
  assert.equal(candidate.core3.status, 'COMPLETE');
});

// ─── 20. fewer-than-three-role diagnostics ──────────────────────────────────

test('fixture 20: one- and two-role readings are diagnostics, never a completeness gate', () => {
  const soloEvents = line('m', [72, 74, 76, 72], MELODY_VOICE);
  const solo = run(soloEvents);
  assert.equal(solo.roles.Melody.status, 'ASSIGNED');
  assert.equal(solo.roles.Chord1.status, 'EMPTY');
  assert.equal(solo.roles.Chord2.status, 'EMPTY');
  assert.equal(solo.core3.status, 'INCOMPLETE');
  assert.deepEqual([...solo.core3.missingFunctions], ['principal-harmony', 'bass-skeleton']);

  const duoEvents = [...soloEvents, ...line('b', [48, 50, 43, 45], BASS_VOICE)];
  const duo = run(duoEvents);
  assert.equal(duo.roles.Chord2.status, 'ASSIGNED');
  assert.equal(duo.core3.status, 'INCOMPLETE');
  assert.ok(duo.core3.missingFunctions.includes('principal-harmony'));

  for (const candidate of [solo, duo]) {
    const reduced = candidate.reducedRoleDiagnostics;
    assert.equal(reduced.canonicalCompletenessGate, 'CORE3');
    assert.deepEqual([...reduced.rolePriority], ['Melody', 'Chord1', 'Chord2']);
    assert.deepEqual(reduced.tiers.map(tier => tier.roleCount), [1, 2]);
    for (const tier of reduced.tiers) {
      assert.equal(tier.canonicalCompleteness, 'NOT_DEFINED');
      assert.equal(tier.pendingReference, 'PENDING.md P17');
      assert.ok(tier.missingFunctions.length, 'a reduced tier must say which musical functions it loses');
    }
    // No reduced tier may ever be reported as Canonically complete.
    assert.equal(JSON.stringify(reduced).includes('"COMPLETE"'), false);
    assert.equal(candidate.core3.canonicallyCompleteGate, 'CORE3');
  }
  assert.equal(ROLE_CANDIDATE_STATUS.oneRoleCompletenessRule, false);
  assert.equal(ROLE_CANDIDATE_STATUS.twoRoleCompletenessRule, false);
  assert.equal(ROLE_CANDIDATE_STATUS.reducedRolePolicy, 'PENDING.md P17 unresolved');
});

// ─── scope and gate boundaries ──────────────────────────────────────────────

test('the stage certifies no acceptance gate and performs no Final work', () => {
  const candidate = run(obviousEvents);
  assert.equal(candidate.stageKind, 'ARRANGEMENT_CANDIDATE');
  assert.equal(candidate.schema, 'mabinogi-mobile-mml-studio/role-candidate-arrangement@1');
  for (const gate of ['TECHNICAL_PASS', 'SOURCE_PASS', 'PLAYER_READBACK_PASS', 'AUDIO_ALIGNMENT_PASS', 'MOBILE_ADAPTATION_PASS', 'IN_GAME_ACCEPTED']) {
    assert.ok(candidate.notice.includes(gate), `${gate} must be explicitly disclaimed`);
  }
  const serialized = JSON.stringify(candidate);
  assert.equal(serialized.includes('MML@'), false, 'no paste-ready MML may be emitted here');

  for (const key of [
    'sourceEventDeletion', 'sourceEventAddition', 'pitchRewrite', 'onsetRewrite', 'durationRewrite',
    'prominenceRewrite', 'octaveShift', 'quantization', 'laneMerge', 'bestSixOptimizer',
    'collisionRepair', 'theoryCleanupPass', 'finalVolumeMapping', 'finalInstrumentAssignment',
    'finalTempoMapEmission', 'finalMmlEmission', 'pasteReadyMmlEmission', 'mobileRegisterAdaptation',
    'audioEvidenceIntake', 'performerCountAllocation',
    'certifiesTechnicalPass', 'certifiesSourcePass', 'certifiesPlayerReadbackPass',
    'certifiesAudioAlignmentPass', 'certifiesMobileAdaptationPass', 'certifiesInGameAccepted',
  ]) {
    assert.equal(ROLE_CANDIDATE_STATUS[key], false, `${key} must be declared out of scope`);
  }
  assert.equal(ROLE_CANDIDATE_STATUS.sourceEventCoverage, 'lossless');
  assert.equal(ROLE_CANDIDATE_STATUS.referenceStatus, 'MML_MABI_REFERENCE_NOT_VERIFIED');
});

test('heuristic thresholds are declared as implementer values beside their measurements', () => {
  const candidate = run(obviousEvents);
  assert.ok(candidate.thresholds.notice.includes('Not Canonical rules'));
  const melody = laneOf(candidate, `lane:${MELODY_VOICE}#0`);
  const contour = melody.evidence.find(record => record.signal === 'melodic_contour');
  assert.deepEqual(contour.threshold, { minDistinctPitches: 3, minPitchChangeRatio: '1/2' });
  // No aggregate score may stand in for the evidence that produced it.
  assert.equal(JSON.stringify(candidate).includes('melodyScore'), false);
  for (const lane of candidate.lanes) {
    for (const record of lane.evidence) {
      assert.ok(['primary', 'supporting', 'conflict'].includes(record.strength));
      assert.ok(record.measurement, 'every evidence record keeps its own measurement');
      assert.ok(['symbolic', 'symbolic-derived'].includes(record.evidenceClass),
        'symbolic and audio evidence stay distinct classes; audio never reaches this layer');
    }
  }
});

test('input contracts fail closed rather than guessing', () => {
  assert.throws(() => suggestRoleCandidates(null), /Canonical project/);
  assert.throws(() => suggestRoleCandidates({ events: 'no' }), /project.events must be an array/);
  assert.throws(() => suggestRoleCandidates(project(obviousEvents), { roleOverrides: { 'lane:nope#0': 'Melody' } }),
    /unknown candidate lane/);
  assert.throws(() => suggestRoleCandidates(project(obviousEvents), { roleOverrides: { [`lane:${BASS_VOICE}#0`]: 'Chord9' } }),
    /must be null or one of/);
  assert.throws(() => suggestRoleCandidates(project(obviousEvents), {
    sourceRoleEvidence: [{ sourceVoice: MELODY_VOICE, role: 'Melody' }],
  }), /requires a citation/);
  assert.throws(() => suggestRoleCandidates(project(obviousEvents), {
    sourceRoleEvidence: [{ sourceVoice: MELODY_VOICE, role: 'Melody', citation: 'c', evidenceClass: 'audio' }],
  }), /audio evidence is a separate class/);
  const duplicated = [...obviousEvents, obviousEvents[0]];
  assert.throws(() => suggestRoleCandidates(project(duplicated)), /duplicate source event id/);
});

test('a caller may exclude a lane from the six roles without losing it', () => {
  const laneId = `lane:${HARMONY_VOICE}#2`;
  const candidate = run(obviousEvents, { roleOverrides: { [laneId]: null } });
  const omitted = candidate.unassigned.find(item => item.laneId === laneId);
  assert.ok(omitted);
  assert.equal(omitted.reason, 'CALLER_EXCLUDED_FROM_SIX');
  assert.equal(omitted.provisional, true);
  assert.ok(omitted.eventIds.length);
  for (const id of omitted.eventIds) {
    const [entry] = ledgerFor(candidate, id);
    assert.equal(entry.decision, ROLE_DECISIONS.OMIT_FROM_SIX);
    assert.equal(entry.candidateRole, null);
  }
});

// ─── work-shape sanity on a moderate synthetic score ────────────────────────
//
// The repository's existing convention is a work-shape bound, not a wall-clock
// budget (see micro-timing-performance.test.mjs), so these assertions are about
// how the scans grow, not how fast the machine is.

function stressEvents(bars) {
  const voices = [
    { voice: MELODY_VOICE, base: 72, step: 1, duration: 1 },
    { voice: HARMONY_VOICE, base: 60, step: 2, duration: 2 },
    { voice: HARMONY_VOICE, base: 64, step: 2, duration: 2 },
    { voice: BASS_VOICE, base: 43, step: 1, duration: 1 },
    { voice: 'track:3/channel:3', base: 55, step: 4, duration: 4 },
    { voice: 'track:4/channel:4', base: 79, step: 2, duration: 2 },
  ];
  const events = [];
  voices.forEach((entry, index) => {
    for (let step = 0; step * entry.duration < bars * 4; step++) {
      const start = step * entry.duration;
      events.push(note(`s${index}-${step}`, entry.base + ((step * entry.step) % 7),
        String(start), String(start + entry.duration), entry.voice));
    }
  });
  return events;
}

test('candidate generation stays output-sensitive on a moderate full-song score', () => {
  const measurements = [25, 50, 100, 200].map(bars => {
    const events = stressEvents(bars);
    const instrumentation = {};
    const candidate = suggestRoleCandidates(project(events), { instrumentation });
    assert.equal(candidate.coverage.complete, true, 'a large score must still be fully accounted for');
    assert.equal(candidate.coverage.sourceEventCount, events.length);
    const reportedPairs = (diagnostic(candidate, 'SIMULTANEOUS_SAME_PITCH_DOUBLING')?.pairs.length ?? 0)
      + (diagnostic(candidate, 'SUSTAINED_SAME_PITCH_OVERLAP')?.pairs.length ?? 0);
    const reportedIntervals = diagnostic(candidate, 'LOW_MID_CLOSE_INTERVAL')?.candidates.length ?? 0;

    // One sweep over the exact boundary grid, not a rescan per note.
    assert.ok(instrumentation.gridIntervals <= 2 * events.length,
      `grid grew to ${instrumentation.gridIntervals} intervals for ${events.length} notes`);
    assert.ok(instrumentation.gridActiveInspections <= 2 * (events.length + instrumentation.gridIntervals),
      `sweep inspected ${instrumentation.gridActiveInspections} active entries for ${events.length} notes`);
    // The same-pitch scan is bucketed by pitch and breaks early, so it stays
    // linear in notes plus reported pairs rather than quadratic in the score.
    assert.ok(instrumentation.samePitchInspections <= 4 * (events.length + reportedPairs + 1),
      `same-pitch scan inspected ${instrumentation.samePitchInspections} pairs for ${events.length} notes`);
    assert.ok(instrumentation.closeIntervalInspections <= 4 * (instrumentation.gridActiveInspections + reportedIntervals + 1),
      `close-interval scan inspected ${instrumentation.closeIntervalInspections} pairs`);
    return { notes: events.length, ...instrumentation };
  });

  // Doubling the score must not multiply the work by four.
  for (let i = 1; i < measurements.length; i++) {
    const previous = measurements[i - 1];
    const current = measurements[i];
    assert.equal(current.notes, previous.notes * 2);
    for (const counter of ['gridIntervals', 'gridActiveInspections', 'samePitchInspections', 'closeIntervalInspections']) {
      assert.ok(current[counter] <= 3 * previous[counter],
        `${counter} went from ${previous[counter]} to ${current[counter]} when the score doubled`);
    }
  }
});

test('a large score with many source voices still overflows rather than dropping lanes', () => {
  const events = [
    ...stressEvents(20),
    ...pad('z', 50, 52, 'track:5/channel:5'),
    ...pad('y', 51, 53, 'track:6/channel:6'),
    ...pad('x', 68, 70, 'track:7/channel:7'),
  ];
  const candidate = run(events);
  assert.ok(candidate.lanes.length > SIX_ROLES.length);
  assert.ok(candidate.unassigned.length > 0);
  assert.equal(candidate.coverage.complete, true);
  assert.ok(diagnostic(candidate, 'SOURCE_LANE_OVERFLOW'));
});

// ─── remaining cross-role review signals ────────────────────────────────────

test('competing bass candidates stay PENDING rather than one being picked arbitrarily', () => {
  // Two overlapping voices that each hold the harmonic floor for half of their
  // own sounding time. Neither has a stronger claim, so Chord2 stays open.
  const events = [
    ...line('m', [72, 74, 76, 72], MELODY_VOICE),
    ...block('ha', [60, 64], HARMONY_VOICE, 0, 2),
    ...block('hb', [59, 62], HARMONY_VOICE, 2, 4),
    ...line('p', [48, 48, 52, 52], 'track:5/channel:5'),
    ...line('q', [50, 50, 46, 46], 'track:6/channel:6'),
  ];
  const candidate = run(events);
  assertOrderIndependent(events);

  assert.equal(candidate.roles.Chord2.status, 'PENDING');
  assert.deepEqual([...candidate.roles.Chord2.laneIds], []);
  assert.deepEqual([...candidate.roles.Chord2.competingLaneIds].sort(),
    ['lane:track:5/channel:5#0', 'lane:track:6/channel:6#0']);

  const competing = diagnostic(candidate, 'COMPETING_BASS_CANDIDATES');
  assert.ok(competing);
  assert.equal(competing.deleted, false);
  assert.equal(candidate.core3.status, 'PENDING');
  assert.ok(candidate.core3.missingFunctions.includes('bass-skeleton'));
  for (const item of candidate.pending.filter(entry => entry.proposedRole === 'Chord2')) {
    assert.ok(item.eventIds.length);
    assert.ok(item.evidenceIds.length);
  }
});

test('sustained same-pitch overlap, dense attacks and low/mid compression are review signals only', () => {
  const events = [
    ...line('m', [72, 74, 76, 72], MELODY_VOICE),
    ...block('ha', [60, 64], HARMONY_VOICE, 0, 2),
    ...block('hb', [59, 62], HARMONY_VOICE, 2, 4),
    ...line('b', [48, 50, 43, 45], BASS_VOICE),
    // Same pitch as the harmony, different onset, overlapping in time.
    note('s1', 60, '1', '3', 'track:7/channel:7'),
    // A minor second against the bass, low in the register.
    note('s2', 49, '0', '1', 'track:8/channel:8'),
  ];
  const candidate = run(events);
  assertOrderIndependent(events);

  const sustained = diagnostic(candidate, 'SUSTAINED_SAME_PITCH_OVERLAP');
  assert.ok(sustained, 'sustained same-pitch overlap must be reported');
  assert.equal(sustained.deleted, false);
  assert.equal(sustained.truncated, false, 'MASTER_RULES.md §6 forbids truncating to hide a collision here');
  assert.equal(sustained.rolePairsPossible, 15, 'all 15 role pairs are in scope (PENDING.md P15)');
  assert.equal(sustained.pendingReference, 'PENDING.md P11, P15');
  const pair = sustained.pairs.find(item => item.eventIds.includes('s1'));
  assert.ok(pair);
  assert.equal(pair.pitch, 60);
  assert.equal(pair.from, '1');

  const close = diagnostic(candidate, 'LOW_MID_CLOSE_INTERVAL');
  assert.ok(close);
  assert.equal(close.repaired, false);
  assert.ok(close.candidates.some(item => item.intervalName === 'm2' && item.eventIds.includes('s2')));
  for (const item of close.candidates) {
    assert.ok(item.pitches[0] < 60, 'only low/mid compression is reported');
    assert.ok([1, 11, 13].includes(item.semitones));
  }

  const dense = diagnostic(candidate, 'DENSE_SIMULTANEOUS_ATTACKS');
  assert.ok(dense, 'five or more roles attacking together is a review signal');
  assert.equal(dense.deleted, false);
  for (const occurrence of dense.occurrences) {
    assert.ok(occurrence.roleCount >= 5);
    assert.equal(occurrence.justificationRequired, true);
  }

  // Every event named by a review signal still has its own ledger decision.
  const named = new Set([
    ...sustained.pairs.flatMap(item => item.eventIds),
    ...close.candidates.flatMap(item => item.eventIds),
    ...dense.occurrences.flatMap(item => item.eventIds),
  ]);
  for (const id of named) assert.ok(ledgerFor(candidate, id).length, `${id} must still be decided, not removed`);
  assert.equal(candidate.coverage.complete, true);
});

test('the coverage audit fails closed when supplied decompositions do not cover the project', () => {
  // A caller may pass its own G11-B output. If that output is missing events,
  // the candidate must say so rather than quietly proposing roles for a subset.
  const candidate = suggestRoleCandidates(project(obviousEvents), { decompositions: [] });
  assert.equal(candidate.coverage.complete, false);
  assert.equal(candidate.coverage.missingEventIds.length, obviousEvents.length);
  const mismatch = diagnostic(candidate, 'CANDIDATE_COVERAGE_MISMATCH');
  assert.ok(mismatch);
  assert.deepEqual([...mismatch.unknownEventIds], []);
  assert.deepEqual([...mismatch.mutatedEventIds], []);
  assert.throws(() => suggestRoleCandidates(project(obviousEvents), { decompositions: 'no' }),
    /must be an array of G11-B decomposition results/);
});

test('an empty or wholly unsupported project fails closed instead of inventing a candidate', () => {
  const empty = run([]);
  assert.equal(empty.lanes.length, 0);
  assert.equal(empty.core3.status, 'INCOMPLETE');
  assert.deepEqual([...empty.core3.missingFunctions], ['lead-continuity', 'principal-harmony', 'bass-skeleton']);
  for (const role of SIX_ROLES) assert.equal(empty.roles[role].status, 'EMPTY');

  const drumsOnly = run([note('d1', 36, '0', '1', 'track:9/channel:9', { metadata: { channel: 9 } })]);
  assert.equal(drumsOnly.lanes.length, 0, 'drum evidence never becomes a pitched lane');
  assert.equal(drumsOnly.unsupportedSourceMaterial.length, 1);
  assert.equal(drumsOnly.core3.status, 'INCOMPLETE');
  assert.equal(drumsOnly.coverage.complete, true);
});

// ═══════════════════════════════════════════════════════════════════════════
// Checkpoint 2 — fail closed on unresolved core harmony
// ═══════════════════════════════════════════════════════════════════════════
//
// Checkpoint 1 could return core3.status === 'COMPLETE' in two situations where
// the evidence did not support it:
//
//   * a long sustained pad won the Chord1 coverage ranking and was then reported
//     as positively established principal harmony;
//   * a sibling lane of a Core3 source voice, sounding concurrently with Core3,
//     was left outside Core3 and treated as optional enrichment purely because
//     it did not fill a silence.
//
// Both are corrected below. Candidate ranking still happens; it just no longer
// masquerades as functional evidence.

// ─── adversarial fixture A — long pad vs. true principal harmony ────────────

const PAD_VOICE = 'track:3/channel:3';

// The pad sounds for eight lane-beats in total; the real accompaniment for four.
// A duration ranking prefers the pad. Musical evidence does not.
const padVsHarmonyEvents = [
  ...line('m', [72, 74, 76, 72], MELODY_VOICE),
  ...line('b', [48, 50, 43, 45], BASS_VOICE),
  note('pa', 55, '0', '4', PAD_VOICE),
  note('pb', 59, '0', '4', PAD_VOICE),
  ...line('h', [60, 64, 60, 64], HARMONY_VOICE),
];

test('A: a longer pad cannot outrank trusted principal-harmony evidence', () => {
  const evidenced = {
    sourceRoleEvidence: [
      { sourceVoice: HARMONY_VOICE, role: 'Chord1', citation: 'fixture:score accompaniment staff' },
      { sourceVoice: PAD_VOICE, role: 'Chord3', citation: 'fixture:score pad staff marked texture' },
    ],
  };
  const candidate = run(padVsHarmonyEvents, evidenced);
  assertOrderIndependent(padVsHarmonyEvents, evidenced);

  const voiceSounding = voice => candidate.lanes
    .filter(lane => lane.sourceVoice === voice)
    .reduce((total, lane) => total.add(lane.metrics.soundingTime), f(0));
  assert.ok(voiceSounding(PAD_VOICE).cmp(voiceSounding(HARMONY_VOICE)) > 0,
    'the pad source voice really does out-sound the accompaniment that a coverage ranking would compare it against');

  // Evidence wins; duration does not get a vote.
  assert.deepEqual([...candidate.roles.Chord1.laneIds], [`lane:${HARMONY_VOICE}#0`]);
  assert.equal(candidate.core3.functions.principalHarmony.status, 'PRESENT');
  assert.equal(candidate.core3.functions.principalHarmony.evidenceStrength, 'POSITIVE');
  assert.equal(candidate.core3.functions.principalHarmony.evidenceTierName, 'DECLARED_SOURCE_ROLE');
  assert.ok(candidate.core3.rationale.some(item => item.code === 'PRINCIPAL_HARMONY_PRESENT'));

  // The pad is not deleted; it is enrichment, on its own evidence.
  for (const laneId of [`lane:${PAD_VOICE}#0`, `lane:${PAD_VOICE}#1`]) {
    assert.equal(candidate.lanes.some(lane => lane.id === laneId), true);
    assert.equal(candidate.roles.Chord1.laneIds.includes(laneId), false);
  }
  assert.equal(candidate.core3.status, 'COMPLETE');
});

test('B: without distinguishing evidence a candidate is still offered, but Core3 stays PENDING', () => {
  const candidate = run(padVsHarmonyEvents);
  assertOrderIndependent(padVsHarmonyEvents);

  // A useful, deterministic candidate is still produced.
  assert.equal(candidate.roles.Chord1.status, 'ASSIGNED');
  assert.equal(candidate.roles.Chord1.laneIds.length, 1);
  assert.equal(candidate.roles.Chord1.evidenceTierName, 'BEST_AVAILABLE_COVERAGE_CANDIDATE');
  assert.ok(candidate.roles.Chord1.reasons.includes('BEST_AVAILABLE_COVERAGE_CANDIDATE'));

  // But it is a candidate, not an established function.
  const principal = candidate.core3.functions.principalHarmony;
  assert.equal(principal.status, 'CANDIDATE_ONLY');
  assert.equal(principal.satisfied, false);
  assert.equal(principal.evidenceStrength, 'HEURISTIC_CANDIDATE');
  assert.deepEqual([...principal.unevidencedLaneIds], [...candidate.roles.Chord1.laneIds]);
  assert.equal(principal.measurement.establishesPrincipalHarmony, false);
  assert.ok(candidate.core3.rationale.some(item => item.code === 'PRINCIPAL_HARMONY_CANDIDATE_ONLY'));

  // Unproven is not the same as absent, and neither is COMPLETE.
  assert.equal(candidate.core3.status, 'PENDING');
  assert.ok(candidate.core3.unprovenFunctions.includes('principal-harmony'));
  assert.equal(candidate.core3.absentFunctions.includes('principal-harmony'), false);
  assert.ok(candidate.core3.missingFunctions.includes('principal-harmony'),
    'missingFunctions stays the superset of everything unsatisfied');
});

// ─── adversarial fixture B — concurrent omitted inner voice, no silence ─────

// One accompaniment source voice, three simultaneous lanes. Core3 sounds
// continuously throughout, so no silence-gap analysis can reach the two lanes
// left outside it.
const concurrentInnerEvents = [
  ...line('m', [72, 74, 76, 72], MELODY_VOICE),
  ...line('b', [48, 50, 43, 45], BASS_VOICE),
  ...block('ha', [60, 64, 67], HARMONY_VOICE, 0, 2),
  ...block('hb', [59, 62, 67], HARMONY_VOICE, 2, 4),
];

const innerSiblingIds = [`lane:${HARMONY_VOICE}#1`, `lane:${HARMONY_VOICE}#2`];

test('C/D/E: a concurrent omitted sibling blocks COMPLETE without a silence gap, and is not moved', () => {
  const candidate = run(concurrentInnerEvents);
  assertOrderIndependent(concurrentInnerEvents);

  // D: there is genuinely no silence anywhere for a gap analysis to find.
  assert.deepEqual([...candidate.core3.sourceCoverage.uncoveredSoundingWindows], []);
  assert.deepEqual([...candidate.core3.sourceCoverage.unaccompaniedSoundingWindows], []);
  assert.deepEqual([...candidate.core3.functions.essentialInnerSupport.essentialLaneIds], [],
    'the silence-gap test proves nothing essential here — that is the point');
  assert.equal(candidate.core3.functions.essentialInnerSupport.status, 'NOT_REQUIRED');

  // ...and Core3 is still not complete, because the concurrent siblings are
  // neither proven essential nor proven optional.
  assert.equal(candidate.core3.status, 'PENDING');
  assert.equal(candidate.core3.functions.concurrentHarmonyResolution.satisfied, false);
  assert.equal(candidate.core3.functions.concurrentHarmonyResolution.status, 'UNRESOLVED');
  assert.deepEqual([...candidate.core3.functions.concurrentHarmonyResolution.unresolvedLaneIds], innerSiblingIds);
  assert.ok(candidate.core3.unprovenFunctions.includes('concurrent-harmony-resolution'));
  assert.equal(candidate.core3.identityMayDependOnEnrichment, true);
  assert.equal(candidate.core3.identityDependsOnEnrichment, false,
    'unresolved is not the same as a proven dependency');
  assert.ok(candidate.core3.rationale.some(item => item.code === 'UNRESOLVED_CORE_HARMONY_SIBLING'));
  assert.ok(candidate.core3.conflicts.some(item => item.code === 'UNRESOLVED_CORE_HARMONY_SIBLING'));

  // C: the siblings are still there, whole, with their provenance.
  for (const laneId of innerSiblingIds) {
    const lane = laneOf(candidate, laneId);
    assert.ok(lane, `${laneId} must still exist`);
    assert.ok(lane.eventIds.length);
    assert.ok(lane.sourceEventIds.length);
    for (const id of lane.eventIds) assert.equal(ledgerFor(candidate, id).length, 1);
  }

  // E: the interlock reports uncertainty; it does not assign.
  for (const laneId of innerSiblingIds) {
    assert.equal(candidate.roles.Chord2.laneIds.includes(laneId), false,
      'an unresolved sibling must not be shoved into Chord2');
    assert.equal(CORE3_ROLE_NAMES.includes(laneOf(candidate, laneId).candidateRole), false);
  }
  const reported = diagnostic(candidate, 'UNRESOLVED_CORE_HARMONY_SIBLING');
  assert.ok(reported);
  assert.equal(reported.deleted, false);
  assert.equal(reported.movedToChord2, false);
  assert.deepEqual([...reported.laneIds], innerSiblingIds);
  for (const entry of reported.siblings) {
    assert.deepEqual([...entry.core3SiblingLaneIds], [`lane:${HARMONY_VOICE}#0`]);
    assert.deepEqual([...entry.core3SiblingRoles], ['Chord1']);
    assert.ok(entry.resolvedBy.includes('Chord3'));
  }
});

test('G: Full6 does not launder an unresolved Core3 dependency as harmless enrichment', () => {
  const candidate = run(concurrentInnerEvents);

  assert.equal(candidate.full6.status, 'CORE3_DEPENDENCY');
  assert.deepEqual([...candidate.full6.core3DependencyLaneIds], innerSiblingIds);
  for (const laneId of innerSiblingIds) {
    const entry = candidate.full6.enrichmentRationale.find(item => item.laneId === laneId);
    assert.ok(entry, 'the sibling still holds its enrichment slot and is still described');
    assert.equal(entry.useful, false, 'it may not be reported as useful while Core3 may need it');
    assert.equal(entry.core3DependencyUnresolved, true);
    assert.equal(entry.core3IntegrityIfRemoved, 'UNRESOLVED');
    assert.equal(entry.removingLeavesCore3Intact, false,
      'that field asserts *established* intact, which this is not');
    assert.equal(entry.essential, false, 'nor is it claimed proven essential');
    assert.ok(entry.addedFunctions.length, 'its musical contribution is still described');
  }
  for (const role of ['Chord3', 'Chord4']) {
    assert.equal(candidate.full6.roleContributions[role].status, 'CORE3_DEPENDENCY_UNRESOLVED');
  }
});

test('F: positive evidence that the sibling is optional removes the uncertainty', () => {
  const evidenced = {
    sourceRoleEvidence: [
      { laneId: `lane:${HARMONY_VOICE}#0`, role: 'Chord1', citation: 'fixture:score accompaniment, upper part' },
      { laneId: innerSiblingIds[0], role: 'Chord3', citation: 'fixture:score inner part marked optional' },
      { laneId: innerSiblingIds[1], role: 'Chord4', citation: 'fixture:score inner part marked optional' },
    ],
  };
  const candidate = run(concurrentInnerEvents, evidenced);
  assertOrderIndependent(concurrentInnerEvents, evidenced);

  assert.equal(candidate.core3.status, 'COMPLETE');
  assert.equal(candidate.core3.functions.concurrentHarmonyResolution.status, 'RESOLVED');
  assert.deepEqual([...candidate.core3.functions.concurrentHarmonyResolution.unresolvedLaneIds], []);
  assert.equal(candidate.core3.functions.principalHarmony.status, 'PRESENT');
  assert.equal(candidate.core3.identityMayDependOnEnrichment, false);
  assert.equal(diagnostic(candidate, 'UNRESOLVED_CORE_HARMONY_SIBLING'), undefined);

  // The siblings are still outside Core3 — now on evidence, not on assumption.
  assert.equal(candidate.full6.status, 'USEFUL');
  for (const laneId of innerSiblingIds) {
    const entry = candidate.full6.enrichmentRationale.find(item => item.laneId === laneId);
    assert.equal(entry.core3DependencyUnresolved, false);
    assert.equal(entry.core3IntegrityIfRemoved, 'INTACT');
    assert.equal(entry.removingLeavesCore3Intact, true);
  }
});

test('the interlock is scoped to Core3 source voices, not to every omitted lane', () => {
  // The counter-line fixture keeps its own source voice, so it is not a sibling
  // of any Core3 lane and must not trip the interlock. Making every omitted
  // lane unresolved would make the candidate useless.
  const candidate = run(usefulEnrichmentEvents, leadDeclared);
  assert.equal(candidate.core3.functions.concurrentHarmonyResolution.status, 'RESOLVED');
  assert.equal(candidate.core3.status, 'COMPLETE');
  assert.equal(candidate.full6.status, 'USEFUL');
  const counter = candidate.full6.enrichmentRationale.find(item => item.laneId === 'lane:track:7/channel:7#0');
  assert.equal(counter.useful, true);
  assert.equal(counter.core3IntegrityIfRemoved, 'INTACT');
});

test('an unresolved sibling is reported as unresolved, never as proven essential', () => {
  const candidate = run(concurrentInnerEvents);
  // Same source voice is not proof of harmonic necessity, so the sibling must
  // not be listed among the lanes the silence-gap test proved essential.
  for (const laneId of innerSiblingIds) {
    assert.equal(candidate.core3.essentialEventIds.length, 0);
    assert.equal(candidate.core3.functions.essentialInnerSupport.essentialLaneIds.includes(laneId), false);
    assert.equal(candidate.core3.functions.essentialInnerSupport.misplacedLaneIds.includes(laneId), false);
  }
  assert.equal(candidate.core3.functions.essentialInnerSupport.satisfied, true,
    'the known-essential question is answered; the concurrent one is separate');
});

test('M: the G11-C stage claims no part of the stage after it', () => {
  // This guard originally read "the G11 roadmap names only A, B and C", which
  // held while G11-C was the last stage. Accepted-decision application now
  // exists as its own module, so what the guard protects is narrower and still
  // worth protecting: G11-C's implementation, its regressions and its document
  // must not start describing, performing or certifying it. The arrangement
  // facade is deliberately no longer in this list -- exporting the next stage
  // is what a facade is for, and the facade's own claims are asserted by that
  // stage's regressions instead.
  const files = [
    'studio/backend/arrangement/role-candidates.mjs',
    'studio/tests/role-candidates.test.mjs',
    'docs/G11C_CANDIDATE_ARRANGEMENT.md',
  ];
  for (const file of files) {
    const text = readFileSync(new URL(`../../${file}`, import.meta.url), 'utf8');
    assert.equal(/G11[-_ ]?D/i.test(text), false,
      `${file} names the stage after G11-C; G11-C suggests roles and accepts nothing, `
      + 'and accepted-arrangement application lives in its own module');
  }
});

test('checkpoint 2 capability claims are declared factually', () => {
  assert.equal(ROLE_CANDIDATE_STATUS.principalHarmonyRequiresPositiveEvidence, true);
  assert.equal(ROLE_CANDIDATE_STATUS.concurrentHarmonySiblingInterlock, true);
  assert.equal(ROLE_CANDIDATE_STATUS.core3FailsClosedOnUnprovenFunction, true);
  assert.equal(ROLE_CANDIDATE_STATUS.coverageRankingEstablishesPrincipalHarmony, false);
  assert.equal(ROLE_CANDIDATE_STATUS.silenceGapIsCompleteEssentialDefinition, false);
  assert.equal(ROLE_CANDIDATE_STATUS.unresolvedSiblingForcedIntoChord2, false);
});

test('a source that declares its whole accompaniment as Chord1 gets Chord1', () => {
  // Declared lanes are co-assignees, not rivals: the overlap contest exists to
  // stop an arbitrary pick between plausible candidates, and there is nothing to
  // pick when the source names the role for all of them. Without this, failing
  // closed would deadlock the very evidence that is supposed to resolve it.
  const declaredEvents = [
    ...line('m', [72, 74, 76, 72], MELODY_VOICE, 0, { role: 'Melody' }),
    ...block('ha', [60, 64], HARMONY_VOICE, 0, 2, { role: 'Chord1' }),
    ...block('hb', [59, 62], HARMONY_VOICE, 2, 4, { role: 'Chord1' }),
    ...line('b', [48, 50, 43, 45], BASS_VOICE, 0, { role: 'Chord2' }),
  ];
  const candidate = run(declaredEvents);
  assertOrderIndependent(declaredEvents);

  assert.equal(candidate.roles.Chord1.status, 'ASSIGNED');
  assert.equal(candidate.roles.Chord1.laneIds.length, 2, 'both declared lanes carry Chord1');
  assert.equal(candidate.core3.functions.principalHarmony.status, 'PRESENT');
  assert.equal(candidate.core3.functions.principalHarmony.evidenceStrength, 'POSITIVE');
  assert.equal(candidate.core3.functions.concurrentHarmonyResolution.status, 'RESOLVED',
    'no sibling is left outside Core3, so nothing is unresolved');
  assert.equal(candidate.core3.status, 'COMPLETE');
  for (const entry of candidate.ledger) assert.equal(entry.decision, ROLE_DECISIONS.KEEP_ROLE);
});

test('failing closed does not make candidate suggestion useless', () => {
  // The bare-MIDI triad is PENDING, but the candidate is still fully formed:
  // every role is populated, every lane is placed and described, and the reason
  // Core3 cannot be called complete is named rather than hidden.
  const candidate = run(concurrentInnerEvents);
  assert.equal(candidate.core3.status, 'PENDING');
  for (const role of ['Melody', 'Chord1', 'Chord2', 'Chord3', 'Chord4']) {
    assert.equal(candidate.roles[role].status, 'ASSIGNED', `${role} still receives a candidate lane`);
    assert.ok(candidate.roles[role].eventIds.length);
  }
  assert.equal(candidate.coverage.complete, true);
  assert.equal(candidate.unassigned.length, 0, 'nothing is dropped to avoid a verdict');
  assert.equal(candidate.pending.length, 0, 'no role decision is abandoned');
  assert.ok(candidate.core3.rationale.length >= 5, 'the reasoning is still reported in full');
  for (const entry of candidate.full6.enrichmentRationale) {
    assert.ok(entry.addedFunctions.length, 'each enrichment lane still says what it adds');
  }
});

test('an absence is only called proven while no role decision is still open', () => {
  // Chord1 reads as empty here only because both of its candidate lanes are
  // locked in the unresolved Lead contest. Reporting that as a deficiency would
  // be a verdict the evidence has not earned.
  const contested = run(twoLeadEvents);
  assert.equal(contested.core3.status, 'PENDING');
  assert.equal(contested.core3.absenceProven, false);
  assert.ok(contested.core3.absentFunctions.includes('principal-harmony'));

  // With nothing open, the same absence is a real deficiency.
  const settled = run([...line('m', [72, 74, 76, 72], MELODY_VOICE), ...line('b', [48, 50, 43, 45], BASS_VOICE)]);
  assert.equal(settled.core3.status, 'INCOMPLETE');
  assert.equal(settled.core3.absenceProven, true);
  assert.ok(settled.core3.absentFunctions.includes('principal-harmony'));
});

// ═══════════════════════════════════════════════════════════════════════════
// Core3 is a three-role musical unit
// ═══════════════════════════════════════════════════════════════════════════
//
// Core3 is Melody + Chord1 + Chord2 evaluated as one musically complete
// single-player arrangement. It is NOT Melody + Chord2 with Chord1 as an
// optional middle layer. The three roles carry distinct required functions and
// no ranking among them, so a strong Lead and a strong bass never compensate for
// an unresolved or missing principal harmony.

const ACC_A = 'track:3/channel:3';
const ACC_B = 'track:4/channel:4';

// Clear Lead, clear bass, and two equally plausible accompaniments from two
// different sources. Nothing in the material settles which carries the
// principal harmony.
const crossSourceHarmonyEvents = [
  ...line('m', [72, 74, 76, 72], MELODY_VOICE, 0, { sourceId: 'official-score' }),
  ...line('b', [48, 50, 43, 45], BASS_VOICE, 0, { sourceId: 'official-score' }),
  ...line('a', [60, 64, 60, 64], ACC_A, 0, { sourceId: 'official-midi' }),
  ...line('c', [62, 65, 62, 65], ACC_B, 0, { sourceId: 'third-party-midi' }),
];

const crossSourceArbitrated = {
  sourceRoleEvidence: [
    { sourceVoice: ACC_A, role: 'Chord1', citation: 'fixture:official-midi accompaniment staff' },
    { sourceVoice: ACC_B, role: 'Chord3', citation: 'fixture:third-party alternate voicing, secondary' },
  ],
};

test('Core3: a perfect Melody and bass do not compensate for unresolved cross-source Chord1', () => {
  const candidate = run(crossSourceHarmonyEvents);
  assertOrderIndependent(crossSourceHarmonyEvents);

  // Melody and Chord2 are each fully and positively satisfied.
  assert.equal(candidate.core3.functions.leadContinuity.satisfied, true);
  assert.equal(candidate.roles.Melody.status, 'ASSIGNED');
  assert.equal(candidate.core3.functions.bassSkeleton.satisfied, true);
  assert.equal(candidate.roles.Chord2.status, 'ASSIGNED');

  // Chord1 is not, and that alone blocks the whole unit.
  assert.equal(candidate.core3.functions.principalHarmony.satisfied, false);
  assert.equal(candidate.core3.status, 'PENDING');
  assert.ok(candidate.core3.missingFunctions.includes('principal-harmony'));
  assert.ok(candidate.core3.unprovenFunctions.includes('principal-harmony'));

  // The cross-source disagreement is recorded with its exact source ids, and the
  // arbitration decision is PENDING rather than absent (SOURCE_POLICY.md §2, §5).
  const crossSource = diagnostic(candidate, 'UNRESOLVED_CROSS_SOURCE_HARMONY');
  assert.ok(crossSource, 'a cross-source harmony conflict must be reported, not silently ranked away');
  assert.equal(crossSource.deleted, false);
  assert.equal(crossSource.decision, 'PENDING');
  assert.deepEqual([...crossSource.candidateSourceIds], ['official-midi', 'third-party-midi']);
  assert.equal(crossSource.candidateVoices.length, 2);
  for (const voice of crossSource.candidateVoices) {
    assert.ok(voice.sourceIds.length, 'each candidate voice names the source behind it');
    assert.ok(voice.laneIds.length);
  }
  const arbitration = candidate.core3.functions.principalHarmony.arbitration;
  assert.equal(arbitration.crossSource, true);
  assert.equal(arbitration.decision, 'PENDING');
  assert.equal(arbitration.disagreement, 'COMPETING_PRINCIPAL_HARMONY_CANDIDATES');

  // Neither accompaniment is deleted, and neither is quietly absorbed by Chord2
  // to make the candidate pass.
  for (const voice of [ACC_A, ACC_B]) {
    const lane = laneOf(candidate, `lane:${voice}#0`);
    assert.ok(lane, `${voice} must survive an unresolved arbitration`);
    assert.ok(lane.eventIds.length);
    assert.equal(candidate.roles.Chord2.laneIds.includes(lane.id), false,
      'Chord2 must not absorb the principal-harmony responsibility to force a pass');
  }
  assert.deepEqual([...candidate.roles.Chord2.laneIds], [`lane:${BASS_VOICE}#0`]);
  assert.equal(candidate.coverage.complete, true);
});

test('Core3: explicit Chord1 arbitration lets the same material reach COMPLETE', () => {
  const candidate = run(crossSourceHarmonyEvents, crossSourceArbitrated);
  assertOrderIndependent(crossSourceHarmonyEvents, crossSourceArbitrated);

  assert.equal(candidate.core3.functions.principalHarmony.satisfied, true);
  assert.equal(candidate.core3.functions.principalHarmony.status, 'PRESENT');
  assert.deepEqual([...candidate.roles.Chord1.laneIds], [`lane:${ACC_A}#0`]);
  assert.equal(candidate.core3.status, 'COMPLETE');
  assert.equal(diagnostic(candidate, 'UNRESOLVED_CROSS_SOURCE_HARMONY'), undefined);

  // The losing candidate is redistributed to enrichment on evidence, not dropped.
  const other = laneOf(candidate, `lane:${ACC_B}#0`);
  assert.ok(ENRICHMENT_ROLE_NAMES.includes(other.candidateRole));
  assert.ok(other.eventIds.every(id => ledgerFor(candidate, id).length === 1));
});

test('Core3: each of the three functions independently blocks COMPLETE', () => {
  // The same three-role backbone, degraded one function at a time. No pair of
  // satisfied functions may ever stand in for the missing third.
  const backbone = [
    ...line('m', [72, 74, 76, 72], MELODY_VOICE, 0, { role: 'Melody' }),
    ...line('h', [60, 64, 60, 64], HARMONY_VOICE, 0, { role: 'Chord1' }),
    ...line('b', [48, 50, 43, 45], BASS_VOICE, 0, { role: 'Chord2' }),
  ];
  const whole = run(backbone);
  assert.equal(whole.core3.status, 'COMPLETE', 'the intact three-role unit is the control');

  const withoutLead = run(backbone.filter(event => !event.id.startsWith('m')));
  assert.equal(withoutLead.core3.status !== 'COMPLETE', true);
  assert.ok(withoutLead.core3.missingFunctions.includes('lead-continuity'));

  const withoutHarmony = run(backbone.filter(event => !event.id.startsWith('h')));
  assert.equal(withoutHarmony.core3.status !== 'COMPLETE', true);
  assert.ok(withoutHarmony.core3.missingFunctions.includes('principal-harmony'),
    'Melody + Chord2 alone is not Core3');
  assert.equal(withoutHarmony.core3.functions.leadContinuity.satisfied, true);
  assert.equal(withoutHarmony.core3.functions.bassSkeleton.satisfied, true);

  const withoutBass = run(backbone.filter(event => !event.id.startsWith('b')));
  assert.equal(withoutBass.core3.status !== 'COMPLETE', true);
  assert.ok(withoutBass.core3.missingFunctions.includes('bass-skeleton'));
});

test('Core3: Chord3-Chord5 cannot compensate for an unresolved Chord1', () => {
  // Pile enrichment onto the unresolved cross-source candidate. Full6 material
  // must not move the Core3 verdict at all.
  const enriched = [
    ...crossSourceHarmonyEvents,
    note('e1', 55, '0', '2', 'track:5/channel:5', { sourceId: 'official-midi' }),
    note('e2', 57, '2', '4', 'track:5/channel:5', { sourceId: 'official-midi' }),
    note('e3', 79, '0', '2', 'track:6/channel:6', { sourceId: 'official-midi' }),
    note('e4', 77, '2', '4', 'track:6/channel:6', { sourceId: 'official-midi' }),
  ];
  const candidate = run(enriched);
  assert.ok(candidate.full6.rolesUsed.length >= 2, 'enrichment roles really are populated');
  assert.equal(candidate.core3.status, 'PENDING');
  assert.equal(candidate.core3.functions.principalHarmony.satisfied, false);
  assert.ok(candidate.core3.missingFunctions.includes('principal-harmony'));
});

test('Core3: the report states the three-role architecture and ranks no role above another', () => {
  const candidate = run(crossSourceHarmonyEvents);
  const architecture = candidate.core3.architecture;
  assert.equal(architecture.unit, 'Core3');
  assert.deepEqual([...architecture.roles], ['Melody', 'Chord1', 'Chord2']);
  assert.deepEqual([...architecture.roles], [...CORE3_ROLE_NAMES]);
  assert.equal(architecture.priorityAmongRoles, 'NONE');
  assert.equal(architecture.allThreeRequiredForComplete, true);
  for (const role of CORE3_ROLE_NAMES) {
    assert.ok(architecture.requiredFunctions[role], `${role} must declare its required function`);
  }
  assert.ok(architecture.requiredFunctions.Chord1.includes('principal accompaniment'));
  assert.ok(architecture.requiredFunctions.Chord2.includes('essential inner support'));
  assert.ok(architecture.evaluationQuestion.includes('Melody + Chord1 + Chord2'));

  // Every Core3 function is evaluated; none is skipped because another passed.
  for (const name of ['leadContinuity', 'principalHarmony', 'bassSkeleton', 'essentialInnerSupport', 'concurrentHarmonyResolution']) {
    assert.ok(candidate.core3.functions[name], `${name} must always be reported`);
    assert.equal(typeof candidate.core3.functions[name].satisfied, 'boolean');
  }
});

test('Core3: a derived signal never promotes a lane out of its declared role', () => {
  // A walking bass declared Chord2 also satisfies the derived tier-3 Lead
  // measurement. Letting the heuristic win promoted it to Melody and left
  // Chord2 empty, dismantling the three-role unit and inventing a Lead the
  // source never claimed — the mirror of the demotion the Lead interlock
  // already refuses (MASTER_RULES.md §0, §4).
  const events = [
    ...line('h', [60, 64, 60, 64], HARMONY_VOICE, 0, { role: 'Chord1' }),
    ...line('b', [48, 50, 43, 45], BASS_VOICE, 0, { role: 'Chord2' }),
  ];
  const candidate = run(events);
  assertOrderIndependent(events);

  const bass = laneOf(candidate, `lane:${BASS_VOICE}#0`);
  assert.equal(bass.roleSupport.Melody.tier, 3, 'the derived Lead signal is still present');
  assert.equal(bass.roleSupport.Chord2.tier, 1, 'and is outranked by the declared role');
  assert.equal(bass.candidateRole, 'Chord2');

  assert.deepEqual([...candidate.roles.Chord2.laneIds], [`lane:${BASS_VOICE}#0`]);
  assert.deepEqual([...candidate.roles.Melody.laneIds], []);
  assert.equal(candidate.core3.functions.leadContinuity.status, 'ABSENT');
  assert.equal(candidate.core3.status, 'INCOMPLETE');
  assert.deepEqual([...candidate.core3.missingFunctions], ['lead-continuity']);
  for (const entry of candidate.ledger) {
    assert.equal(entry.decision, ROLE_DECISIONS.KEEP_ROLE, 'no lane is moved off its declared role');
  }
});

test('Core3: a resolved Chord1 arbitration states why, not only that it resolved', () => {
  const candidate = run(crossSourceHarmonyEvents, crossSourceArbitrated);
  const arbitration = candidate.core3.functions.principalHarmony.arbitration;
  assert.equal(arbitration.decision, 'RESOLVED_BY_DECLARED_SOURCE_ROLE');
  assert.equal(arbitration.disagreement, null);
  assert.deepEqual([...arbitration.candidateSourceIds], ['official-midi']);
  assert.equal(arbitration.candidateVoices[0].sourceVoice, ACC_A);
});

// ═══════════════════════════════════════════════════════════════════════════
// Overlapping cross-source declared Chord1 must not be blindly co-assigned
// ═══════════════════════════════════════════════════════════════════════════
//
// A declared source role proves "this source presents this material as Chord1".
// It does not prove that two separate arrangements are mutually compatible and
// may be stacked into one Core Harmony (MASTER_RULES.md §6, SOURCE_POLICY.md
// §5). Same-source polyphony is co-assignment; overlapping cross-source
// declarations are a conflict that needs arbitration.

const SRC_A = 'official-score';
const SRC_B = 'third-party-midi';
const VOICE_A = 'track:3/channel:3';
const VOICE_B = 'track:4/channel:4';

const core3Backbone = [
  ...line('m', [72, 74, 76, 72], MELODY_VOICE, 0, { sourceId: SRC_A }),
  ...line('b', [48, 50, 43, 45], BASS_VOICE, 0, { sourceId: SRC_A }),
];

// A: one source, one accompaniment staff, several overlapping declared lanes.
test('A: same-source polyphonic declared Chord1 still co-assigns without deadlock', () => {
  const events = [
    ...core3Backbone,
    note('x1', 60, '0', '2', HARMONY_VOICE, { sourceId: SRC_A, role: 'Chord1' }),
    note('x2', 64, '0', '2', HARMONY_VOICE, { sourceId: SRC_A, role: 'Chord1' }),
    note('x3', 59, '2', '4', HARMONY_VOICE, { sourceId: SRC_A, role: 'Chord1' }),
    note('x4', 62, '2', '4', HARMONY_VOICE, { sourceId: SRC_A, role: 'Chord1' }),
  ];
  const candidate = run(events);
  assertOrderIndependent(events);

  assert.equal(candidate.roles.Chord1.status, 'ASSIGNED');
  assert.equal(candidate.roles.Chord1.laneIds.length, 2, 'both overlapping lanes of one source carry Chord1');
  assert.equal(candidate.core3.functions.principalHarmony.status, 'PRESENT');
  assert.equal(candidate.core3.functions.principalHarmony.arbitration.crossSource, false);
  assert.equal(candidate.core3.functions.principalHarmony.arbitration.decision, 'RESOLVED_BY_DECLARED_SOURCE_ROLE');
  assert.deepEqual([...candidate.core3.functions.principalHarmony.arbitration.conflicts], []);
  assert.equal(diagnostic(candidate, 'UNRESOLVED_CROSS_SOURCE_DECLARED_CHORD1'), undefined);
  assert.equal(candidate.core3.status, 'COMPLETE');
});

test('A: same source split across two source voices is still same provenance', () => {
  // Provenance is read from sourceIds, never from the sourceVoice string. Two
  // voices of one source overlapping each other are not a cross-source stack.
  const events = [
    ...core3Backbone,
    ...line('a', [60, 64, 60, 64], VOICE_A, 0, { sourceId: SRC_A, role: 'Chord1' }),
    ...line('c', [62, 65, 62, 65], VOICE_B, 0, { sourceId: SRC_A, role: 'Chord1' }),
  ];
  const candidate = run(events);
  assert.equal(candidate.roles.Chord1.laneIds.length, 2);
  assert.equal(candidate.core3.status, 'COMPLETE');
  assert.equal(diagnostic(candidate, 'UNRESOLVED_CROSS_SOURCE_DECLARED_CHORD1'), undefined);
});

// B: two sources, overlapping, both declaring Chord1.
const crossSourceStackEvents = [
  ...core3Backbone,
  ...line('a', [60, 64, 60, 64], VOICE_A, 0, { sourceId: SRC_A, role: 'Chord1' }),
  ...line('c', [62, 65, 62, 65], VOICE_B, 0, { sourceId: SRC_B, role: 'Chord1' }),
];
const stackLaneIds = [`lane:${VOICE_A}#0`, `lane:${VOICE_B}#0`];

test('B: overlapping cross-source declared Chord1 is a conflict, not a co-assignment', () => {
  const candidate = run(crossSourceStackEvents);
  assertOrderIndependent(crossSourceStackEvents);

  // Neither is stacked into Core Harmony, and neither is chosen over the other.
  assert.equal(candidate.roles.Chord1.status, 'PENDING');
  assert.deepEqual([...candidate.roles.Chord1.laneIds], []);
  assert.deepEqual([...candidate.roles.Chord1.reasons], ['CROSS_SOURCE_DECLARED_CHORD1_OVERLAP']);
  assert.equal(candidate.core3.functions.principalHarmony.satisfied, false);
  assert.equal(candidate.core3.functions.principalHarmony.status, 'PENDING');
  assert.equal(candidate.core3.status, 'PENDING');
  assert.ok(candidate.core3.unprovenFunctions.includes('principal-harmony'));

  // The disagreement is recorded with its exact source ids and where it happens.
  const arbitration = candidate.core3.functions.principalHarmony.arbitration;
  assert.equal(arbitration.crossSource, true);
  assert.equal(arbitration.decision, 'PENDING');
  assert.equal(arbitration.disagreement, 'CROSS_SOURCE_DECLARED_CHORD1_OVERLAP');
  assert.deepEqual([...arbitration.candidateSourceIds], [SRC_A, SRC_B]);
  assert.equal(arbitration.conflicts.length, 1);
  assert.deepEqual([...arbitration.conflicts[0].laneIds], [...stackLaneIds].sort());
  assert.deepEqual([...arbitration.conflicts[0].sourceIds], [SRC_A, SRC_B]);
  assert.deepEqual([...arbitration.conflicts[0].overlapWindows], [{ start: '0', end: '4' }]);

  const reported = diagnostic(candidate, 'UNRESOLVED_CROSS_SOURCE_DECLARED_CHORD1');
  assert.ok(reported);
  assert.equal(reported.deleted, false);
  assert.equal(reported.merged, false);
  assert.equal(reported.stacked, false);
  assert.equal(reported.sourcePreferred, false, 'no source authority may be applied');
  assert.equal(reported.decision, 'PENDING');
  assert.deepEqual([...reported.laneIds], [...stackLaneIds].sort());

  // Every lane, event and source id survives.
  for (const laneId of stackLaneIds) {
    const lane = laneOf(candidate, laneId);
    assert.ok(lane, `${laneId} must be preserved`);
    assert.ok(lane.eventIds.length);
    assert.ok(lane.sourceEventIds.length);
    for (const id of lane.eventIds) {
      const [entry] = ledgerFor(candidate, id);
      assert.equal(entry.decision, ROLE_DECISIONS.PENDING);
      assert.equal(entry.sourceRole, 'Chord1', 'the declaration itself is retained');
    }
  }
  const pendingIds = candidate.pending.map(item => item.laneId).sort();
  assert.deepEqual(pendingIds, [...stackLaneIds].sort());
  for (const item of candidate.pending) {
    assert.equal(item.crossSource, true);
    assert.ok(item.sourceIds.length, 'the pending record names the source behind the lane');
    assert.deepEqual([...item.blockers], ['CROSS_SOURCE_DECLARED_CHORD1_OVERLAP']);
  }
});

test('B: cited trusted-role declarations reach the same conflict as event-level roles', () => {
  const events = [
    ...core3Backbone,
    ...line('a', [60, 64, 60, 64], VOICE_A, 0, { sourceId: SRC_A }),
    ...line('c', [62, 65, 62, 65], VOICE_B, 0, { sourceId: SRC_B }),
  ];
  const cited = {
    sourceRoleEvidence: [
      { sourceVoice: VOICE_A, role: 'Chord1', citation: 'fixture:official score accompaniment staff' },
      { sourceVoice: VOICE_B, role: 'Chord1', citation: 'fixture:third-party midi accompaniment track' },
    ],
  };
  const candidate = run(events, cited);
  assertOrderIndependent(events, cited);
  assert.equal(candidate.core3.status, 'PENDING');
  assert.equal(candidate.core3.functions.principalHarmony.status, 'PENDING');
  assert.ok(diagnostic(candidate, 'UNRESOLVED_CROSS_SOURCE_DECLARED_CHORD1'));
});

// C: explicit arbitration clears it.
test('C: explicit arbitration resolves the stack and preserves the other source', () => {
  const events = [
    ...core3Backbone,
    ...line('a', [60, 64, 60, 64], VOICE_A, 0, { sourceId: SRC_A }),
    ...line('c', [62, 65, 62, 65], VOICE_B, 0, { sourceId: SRC_B }),
  ];
  const arbitrated = {
    sourceRoleEvidence: [
      { sourceVoice: VOICE_A, role: 'Chord1', citation: 'fixture:official score accompaniment staff' },
      { sourceVoice: VOICE_B, role: 'Chord3', citation: 'fixture:third-party alternate voicing, secondary' },
    ],
  };
  const candidate = run(events, arbitrated);
  assertOrderIndependent(events, arbitrated);

  assert.deepEqual([...candidate.roles.Chord1.laneIds], [`lane:${VOICE_A}#0`]);
  assert.equal(candidate.core3.functions.principalHarmony.status, 'PRESENT');
  assert.equal(candidate.core3.functions.principalHarmony.evidenceStrength, 'POSITIVE');
  assert.equal(candidate.core3.status, 'COMPLETE');
  assert.equal(diagnostic(candidate, 'UNRESOLVED_CROSS_SOURCE_DECLARED_CHORD1'), undefined);

  // The loser is preserved as enrichment, not dropped.
  const other = laneOf(candidate, `lane:${VOICE_B}#0`);
  assert.ok(ENRICHMENT_ROLE_NAMES.includes(other.candidateRole));
  assert.equal(candidate.full6.status, 'USEFUL');
  for (const id of other.eventIds) assert.equal(ledgerFor(candidate, id).length, 1);
});

// D: different sources that never overlap are not this conflict.
test('D: non-overlapping cross-source declared Chord1 is not rejected for differing source ids', () => {
  const events = [
    ...line('m', [72, 74, 76, 72, 74, 76, 72, 74], MELODY_VOICE, 0, { sourceId: SRC_A }),
    ...line('b', [48, 50, 43, 45, 48, 50, 43, 45], BASS_VOICE, 0, { sourceId: SRC_A }),
    ...line('a', [60, 64, 60, 64], VOICE_A, 0, { sourceId: SRC_A, role: 'Chord1' }),
    ...line('c', [62, 65, 62, 65], VOICE_B, 4, { sourceId: SRC_B, role: 'Chord1' }),
  ];
  const candidate = run(events);
  assertOrderIndependent(events);

  assert.equal(candidate.roles.Chord1.status, 'ASSIGNED');
  assert.equal(candidate.roles.Chord1.laneIds.length, 2, 'a sectional hand-off stays representable');
  assert.equal(candidate.core3.functions.principalHarmony.status, 'PRESENT');
  assert.equal(candidate.core3.functions.principalHarmony.arbitration.crossSource, true,
    'the cross-source fact is still recorded');
  assert.deepEqual([...candidate.core3.functions.principalHarmony.arbitration.conflicts], [],
    'but differing source ids alone are not a conflict');
  assert.equal(diagnostic(candidate, 'UNRESOLVED_CROSS_SOURCE_DECLARED_CHORD1'), undefined);
  assert.equal(candidate.core3.status, 'COMPLETE');
});

test('D: a multi-source project where only one source declares Chord1 is unaffected', () => {
  const events = [
    ...line('m', [72, 74, 76, 72], MELODY_VOICE, 0, { sourceId: SRC_A }),
    ...line('b', [48, 50, 43, 45], BASS_VOICE, 0, { sourceId: SRC_B }),
    ...line('a', [60, 64, 60, 64], VOICE_A, 0, { sourceId: SRC_A, role: 'Chord1' }),
  ];
  const candidate = run(events);
  assert.equal(candidate.core3.status, 'COMPLETE');
  assert.equal(diagnostic(candidate, 'UNRESOLVED_CROSS_SOURCE_DECLARED_CHORD1'), undefined);
});

// E: a perfect Melody and bass do not compensate for the unresolved conflict.
test('E: Melody and Chord2 both satisfied cannot carry an unresolved cross-source Chord1', () => {
  const candidate = run(crossSourceStackEvents);
  assert.equal(candidate.core3.functions.leadContinuity.satisfied, true);
  assert.equal(candidate.core3.functions.bassSkeleton.satisfied, true);
  assert.equal(candidate.core3.functions.principalHarmony.satisfied, false);
  assert.equal(candidate.core3.status, 'PENDING');
  assert.equal(candidate.core3.architecture.priorityAmongRoles, 'NONE');
  assert.equal(candidate.core3.architecture.allThreeRequiredForComplete, true);
  // Chord2 must not quietly take over the principal-harmony material either.
  assert.deepEqual([...candidate.roles.Chord2.laneIds], [`lane:${BASS_VOICE}#0`]);
  for (const laneId of stackLaneIds) {
    assert.equal(candidate.roles.Chord2.laneIds.includes(laneId), false);
  }
});

// F: enrichment cannot compensate either, and must not launder the conflict.
test('F/15: Full6 neither compensates for nor launders the unresolved conflict', () => {
  const events = [
    ...crossSourceStackEvents,
    note('t1', 55, '0', '2', 'track:5/channel:5', { sourceId: SRC_A }),
    note('t2', 57, '2', '4', 'track:5/channel:5', { sourceId: SRC_A }),
    note('t3', 79, '0', '2', 'track:6/channel:6', { sourceId: SRC_A }),
    note('t4', 77, '2', '4', 'track:6/channel:6', { sourceId: SRC_A }),
  ];
  const candidate = run(events);
  assertOrderIndependent(events);

  assert.ok(candidate.full6.rolesUsed.length >= 1, 'enrichment roles really are populated');
  assert.equal(candidate.core3.status, 'PENDING', 'Full6 material cannot move the Core3 verdict');
  assert.notEqual(candidate.full6.status, 'USEFUL',
    'Full6 may not read as plain useful enrichment while Core3 is unresolved');

  // The conflicting candidates never appear as enrichment at all.
  for (const laneId of stackLaneIds) {
    assert.equal(candidate.full6.enrichmentRationale.some(entry => entry.laneId === laneId), false,
      'an unresolved Core Harmony candidate is not optional Full6 enrichment');
    assert.equal(ENRICHMENT_ROLE_NAMES.includes(laneOf(candidate, laneId).candidateRole), false);
  }
});

// G: the declared-role protection from the previous checkpoint still holds.
test('G: a declared Chord2 bass is still not promoted to Melody by a derived signal', () => {
  const events = [
    ...line('h', [60, 64, 60, 64], HARMONY_VOICE, 0, { sourceId: SRC_A, role: 'Chord1' }),
    ...line('b', [48, 50, 43, 45], BASS_VOICE, 0, { sourceId: SRC_A, role: 'Chord2' }),
  ];
  const candidate = run(events);
  assert.deepEqual([...candidate.roles.Chord2.laneIds], [`lane:${BASS_VOICE}#0`]);
  assert.deepEqual([...candidate.roles.Melody.laneIds], []);
  assert.equal(candidate.core3.functions.leadContinuity.status, 'ABSENT');
  assert.equal(candidate.core3.status, 'INCOMPLETE');
});

// H: provenance survives the conflict untouched.
test('H: the conflict changes no pitch, onset, duration or source identity', () => {
  const candidate = run(crossSourceStackEvents);
  const byId = new Map(crossSourceStackEvents.map(event => [event.id, event]));
  assert.equal(candidate.coverage.complete, true);
  assert.deepEqual([...candidate.coverage.mutatedEventIds], []);
  for (const entry of candidate.ledger) {
    const source = byId.get(entry.eventId);
    assert.equal(entry.sourcePitch, source.pitch);
    assert.ok(f(entry.sourceStart).cmp(source.start) === 0);
    assert.ok(f(entry.sourceEnd).cmp(source.end) === 0);
    assert.deepEqual([...entry.sourceIds], [...source.sourceIds]);
    assert.deepEqual([...entry.sourceEventIds], [...source.sourceEventIds]);
  }
  // Both source identities remain distinguishable in the output.
  assert.deepEqual([...laneOf(candidate, `lane:${VOICE_A}#0`).sourceIds], [SRC_A]);
  assert.deepEqual([...laneOf(candidate, `lane:${VOICE_B}#0`).sourceIds], [SRC_B]);
});

// §11: provenance is read from source ids, and ambiguity fails closed.
test('a lane of mixed provenance is never treated as safely same-source', () => {
  const mixed = [
    ...core3Backbone,
    ...line('a', [60, 64, 60, 64], VOICE_A, 0, { sourceId: SRC_A, role: 'Chord1' }),
    ...line('c', [62, 65, 62, 65], VOICE_B, 0, { sourceIds: [SRC_A, SRC_B], role: 'Chord1' }),
  ];
  const candidate = run(mixed);
  assertOrderIndependent(mixed);
  assert.equal(candidate.core3.status, 'PENDING');
  const reported = diagnostic(candidate, 'UNRESOLVED_CROSS_SOURCE_DECLARED_CHORD1');
  assert.ok(reported);
  assert.equal(reported.conflicts[0].ambiguousProvenance, true);
  assert.deepEqual([...reported.conflicts[0].sourceIds], [SRC_A, SRC_B]);

  // Even two lanes carrying the same mixed set are not safely same-source:
  // nothing establishes that they are one arrangement.
  const bothMixed = [
    ...core3Backbone,
    ...line('a', [60, 64, 60, 64], VOICE_A, 0, { sourceIds: [SRC_A, SRC_B], role: 'Chord1' }),
    ...line('c', [62, 65, 62, 65], VOICE_B, 0, { sourceIds: [SRC_A, SRC_B], role: 'Chord1' }),
  ];
  const second = run(bothMixed);
  assert.equal(second.core3.status, 'PENDING');
  assert.ok(diagnostic(second, 'UNRESOLVED_CROSS_SOURCE_DECLARED_CHORD1'));
});

test('no automatic source authority decides the conflict', () => {
  // Neither ordering of the source ids, nor which was declared first, nor which
  // sounds longer may pick a winner. Canonical requires arbitration.
  const longerThirdParty = [
    ...core3Backbone,
    ...line('a', [60, 64], VOICE_A, 0, { sourceId: SRC_A, role: 'Chord1' }),
    ...line('c', [62, 65, 62, 65], VOICE_B, 0, { sourceId: SRC_B, role: 'Chord1' }),
  ];
  const candidate = run(longerThirdParty);
  assert.equal(candidate.roles.Chord1.status, 'PENDING');
  assert.deepEqual([...candidate.roles.Chord1.laneIds], [], 'the longer third-party source does not win');
  assert.equal(diagnostic(candidate, 'UNRESOLVED_CROSS_SOURCE_DECLARED_CHORD1').sourcePreferred, false);

  // Reversing which id sorts first must not change the outcome either.
  const swapped = [
    ...line('m', [72, 74, 76, 72], MELODY_VOICE, 0, { sourceId: 'aaa-source' }),
    ...line('b', [48, 50, 43, 45], BASS_VOICE, 0, { sourceId: 'aaa-source' }),
    ...line('a', [60, 64, 60, 64], VOICE_A, 0, { sourceId: 'zzz-source', role: 'Chord1' }),
    ...line('c', [62, 65, 62, 65], VOICE_B, 0, { sourceId: 'aaa-source', role: 'Chord1' }),
  ];
  const second = run(swapped);
  assert.equal(second.roles.Chord1.status, 'PENDING');
  assert.deepEqual([...second.roles.Chord1.laneIds], []);
});

// ─── evidence scope: a citation speaks only for the material it names ────────
//
// A cited trusted symbolic role lands in tier 1 DECLARED_SOURCE_ROLE, where it
// outranks every derived measurement and clears the Core3 interlocks. Its scope
// is therefore load-bearing: SOURCE_POLICY.md §A/§2 makes a citation a claim
// about specific material, and §5/§10 read provenance from source ids rather
// than from a voice label. Reading an entry's selectors as alternatives let the
// broadest one win, so a narrowed claim silently reached lanes it was narrowed
// away from, and a voice-only claim crossed into a source that never made it.

const SCOPE_VOICE = 'track:1/channel:1';

test('scope: a narrowing selector narrows, and never widens to unnamed lanes', () => {
  const narrowed = {
    sourceRoleEvidence: [
      { laneId: `lane:${SCOPE_VOICE}#0`, role: 'Chord1', citation: 'fixture:score accompaniment, upper part' },
      // The caller names one lane and is explicit about its provenance. Nothing
      // is said about the voice's other lanes.
      {
        sourceVoice: SCOPE_VOICE,
        laneId: `lane:${SCOPE_VOICE}#1`,
        role: 'Chord3',
        citation: 'fixture:score inner part, marked optional',
      },
    ],
  };
  const candidate = run(concurrentInnerEvents, narrowed);
  assertOrderIndependent(concurrentInnerEvents, narrowed);

  const cited = laneId => laneOf(candidate, laneId).evidence.filter(record => record.signal === 'trusted_symbolic_role');

  // The named lane carries the claim, and records every selector that had to hold.
  const named = cited(`lane:${SCOPE_VOICE}#1`);
  assert.equal(named.length, 1);
  assert.deepEqual([...named[0].supportsRoles], ['Chord3']);
  assert.deepEqual([...named[0].measurement.scopedBy], ['laneId', 'sourceVoice']);
  assert.equal(laneOf(candidate, `lane:${SCOPE_VOICE}#1`).roleSupport.Chord3.tier, 1);

  // The sibling the citation never named carries none of it.
  assert.deepEqual(cited(`lane:${SCOPE_VOICE}#2`), []);
  for (const role of ENRICHMENT_ROLE_NAMES) {
    assert.equal(laneOf(candidate, `lane:${SCOPE_VOICE}#2`).roleSupport[role].tier, null,
      `${role} must not be declared for a lane no citation names`);
  }
});

test('scope: evidence for one lane cannot clear the Core3 interlock on another', () => {
  // The fail-open this closes. Checkpoint 2 raises UNRESOLVED_CORE_HARMONY_SIBLING
  // for a concurrent sibling left outside Core3, and only positive evidence
  // naming *that lane* may clear it. Widened scope cleared it with a citation
  // that spoke for a different lane, and Core3 then reported a completeness the
  // evidence never supported.
  const narrowed = {
    sourceRoleEvidence: [
      { laneId: `lane:${SCOPE_VOICE}#0`, role: 'Chord1', citation: 'fixture:score accompaniment, upper part' },
      {
        sourceVoice: SCOPE_VOICE,
        laneId: `lane:${SCOPE_VOICE}#1`,
        role: 'Chord3',
        citation: 'fixture:score inner part, marked optional',
      },
    ],
  };
  const candidate = run(concurrentInnerEvents, narrowed);

  assert.equal(candidate.core3.status, 'PENDING');
  assert.equal(candidate.core3.functions.concurrentHarmonyResolution.status, 'UNRESOLVED');
  assert.deepEqual([...candidate.core3.functions.concurrentHarmonyResolution.unresolvedLaneIds],
    [`lane:${SCOPE_VOICE}#2`]);
  assert.ok(diagnostic(candidate, 'UNRESOLVED_CORE_HARMONY_SIBLING'));

  // Naming the remaining sibling is what clears it -- nothing else.
  const complete = run(concurrentInnerEvents, {
    sourceRoleEvidence: [
      ...narrowed.sourceRoleEvidence,
      { laneId: `lane:${SCOPE_VOICE}#2`, role: 'Chord4', citation: 'fixture:score inner part, marked optional' },
    ],
  });
  assert.equal(complete.core3.status, 'COMPLETE');
  assert.equal(complete.core3.functions.concurrentHarmonyResolution.status, 'RESOLVED');
});

// A track/channel coordinate is not provenance. Two sources of one song
// ordinarily share it, and then a voice-only citation identifies nothing.
const SHARED_VOICE = 'track:5/channel:5';
// Each source holds its own steady pitch, so G11-B separates them by voice
// continuity and every lane carries exactly one provenance. Only the label they
// share is ambiguous -- which is precisely the question under test.
const sharedLabelEvents = [
  ...core3Backbone,
  ...line('sa', [60, 60, 60, 60], SHARED_VOICE, 0, { sourceId: SRC_A }),
  ...line('sb', [67, 67, 67, 67], SHARED_VOICE, 0, { sourceId: SRC_B }),
];
const lanesFromSource = (candidate, sourceId) => candidate.lanes
  .filter(lane => lane.sourceVoice === SHARED_VOICE && lane.sourceIds.includes(sourceId));

test('scope: a voice label shared by two sources is not provenance, and fails closed', () => {
  const voiceOnly = {
    sourceRoleEvidence: [
      { sourceVoice: SHARED_VOICE, role: 'Chord1', citation: 'fixture:official-score accompaniment staff' },
    ],
  };
  const candidate = run(sharedLabelEvents, voiceOnly);
  assertOrderIndependent(sharedLabelEvents, voiceOnly);

  // Both provenances are present under the one label.
  assert.ok(lanesFromSource(candidate, SRC_A).length);
  assert.ok(lanesFromSource(candidate, SRC_B).length);

  // The official score's citation never becomes third-party evidence -- and is
  // not quietly applied to the source that did make it either, because the
  // label alone does not say which that is.
  for (const lane of candidate.lanes.filter(item => item.sourceVoice === SHARED_VOICE)) {
    assert.deepEqual(lane.evidence.filter(record => record.signal === 'trusted_symbolic_role'), [],
      `${lane.id} must not inherit a claim made under an ambiguous label`);
    assert.equal(lane.roleSupport.Chord1.tier, null);
  }

  // A withheld citation is reported, never silently dropped.
  const reported = diagnostic(candidate, 'AMBIGUOUS_EVIDENCE_PROVENANCE');
  assert.ok(reported);
  assert.equal(reported.applied, false);
  assert.equal(reported.deleted, false);
  assert.equal(reported.claims.length, 1);
  assert.equal(reported.claims[0].citation, 'fixture:official-score accompaniment staff');
  assert.equal(reported.claims[0].role, 'Chord1');
  assert.deepEqual([...reported.claims[0].spansSourceIds], [SRC_A, SRC_B].sort());
  assert.deepEqual([...reported.claims[0].withheldFromLaneIds],
    candidate.lanes.filter(lane => lane.sourceVoice === SHARED_VOICE).map(lane => lane.id).sort());
});

test('scope: sourceIds re-issues the claim to exactly the provenance that made it', () => {
  const scoped = {
    sourceRoleEvidence: [
      {
        sourceVoice: SHARED_VOICE,
        sourceIds: [SRC_A],
        role: 'Chord1',
        citation: 'fixture:official-score accompaniment staff',
      },
    ],
  };
  const candidate = run(sharedLabelEvents, scoped);
  assertOrderIndependent(sharedLabelEvents, scoped);

  for (const lane of lanesFromSource(candidate, SRC_A)) {
    assert.equal(lane.roleSupport.Chord1.tier, 1, `${lane.id} is what the citation names`);
    const [record] = lane.evidence.filter(item => item.signal === 'trusted_symbolic_role');
    assert.deepEqual([...record.measurement.declaredSourceIds], [SRC_A]);
    assert.deepEqual([...record.measurement.scopedBy], ['sourceVoice', 'sourceIds']);
  }
  for (const lane of lanesFromSource(candidate, SRC_B)) {
    assert.equal(lane.roleSupport.Chord1.tier, null, `${lane.id} belongs to the other source`);
  }
  assert.equal(diagnostic(candidate, 'AMBIGUOUS_EVIDENCE_PROVENANCE'), undefined);
});

test('scope: a lane reaching outside the declared provenance is not covered by it', () => {
  // §10: a lane of mixed provenance is never treated as safely same-source.
  const mixed = [
    ...core3Backbone,
    ...line('sa', [60, 60, 60, 60], SHARED_VOICE, 0, { sourceId: SRC_A }),
    ...line('sm', [67, 67, 67, 67], SHARED_VOICE, 0, { sourceIds: [SRC_A, SRC_B] }),
  ];
  const candidate = run(mixed, {
    sourceRoleEvidence: [
      { sourceVoice: SHARED_VOICE, sourceIds: [SRC_A], role: 'Chord1', citation: 'fixture:official-score accompaniment staff' },
    ],
  });

  const sharedLanes = candidate.lanes.filter(item => item.sourceVoice === SHARED_VOICE);
  const partitioned = { covered: 0, outside: 0 };
  for (const lane of sharedLanes) {
    const covered = lane.sourceIds.every(id => id === SRC_A);
    partitioned[covered ? 'covered' : 'outside'] += 1;
    assert.equal(lane.roleSupport.Chord1.tier, covered ? 1 : null,
      `${lane.id} with provenance ${JSON.stringify(lane.sourceIds)} must ${covered ? 'be' : 'not be'} covered`);
  }
  assert.ok(partitioned.covered > 0 && partitioned.outside > 0,
    'the fixture must actually present both a covered and a reaching-outside lane');
});

test('scope: sourceIds is a provenance qualifier with its own input contract', () => {
  const withScope = sourceIds => () => suggestRoleCandidates(project(sharedLabelEvents), {
    sourceRoleEvidence: [{ sourceVoice: SHARED_VOICE, sourceIds, role: 'Chord1', citation: 'fixture:score' }],
  });
  assert.throws(withScope([]), /non-empty array of source id strings/);
  assert.throws(withScope('official-score'), /non-empty array of source id strings/);
  assert.throws(withScope([42]), /non-empty array of source id strings/);

  // It narrows an existing target; it is never a target on its own.
  assert.throws(() => suggestRoleCandidates(project(sharedLabelEvents), {
    sourceRoleEvidence: [{ sourceIds: [SRC_A], role: 'Chord1', citation: 'fixture:score' }],
  }), /must target a sourceVoice, laneId, or eventIds/);
});

// ─── source-supported Lead: authority, not which field it arrived in ────────
//
// MASTER_RULES.md §4 / SOURCE_POLICY.md §4: moving a source-supported Lead off
// Melody needs positive evidence and a demotion report, and incomplete evidence
// stays PENDING. SOURCE_POLICY.md §1.A makes an official score / trusted
// symbolic source primary authority for staff and voice placement, and §4 lists
// score-role evidence among a Lead move's inputs -- so a *cited* Lead is as
// protected as a baseline one. Gating the interlock on `lane.sourceRoles` alone
// saw only the baseline field, and a cited Lead could be demoted with no gate.

const LEAD_LANE = `lane:${MELODY_VOICE}#0`;
const plainBackbone = [
  ...line('m', [72, 74, 76, 72], MELODY_VOICE),
  ...line('h', [60, 62, 60, 62], HARMONY_VOICE),
  ...line('b', [48, 50, 43, 45], BASS_VOICE),
];

// A: the baseline-role route must stay blocked.
test('lead: a baseline declared Lead is not demoted by a caller override', () => {
  const events = [
    ...line('m', [72, 74, 76, 72], MELODY_VOICE, 0, { role: 'Melody' }),
    ...line('h', [60, 62, 60, 62], HARMONY_VOICE),
    ...line('b', [48, 50, 43, 45], BASS_VOICE),
  ];
  const options = { roleOverrides: { [LEAD_LANE]: 'Chord1' } };
  const candidate = run(events, options);
  assertOrderIndependent(events, options);

  assert.ok(!candidate.roles.Chord1.laneIds.includes(LEAD_LANE));
  const [blocked] = candidate.pending.filter(item => item.laneId === LEAD_LANE);
  assert.ok(blocked);
  assert.ok([...blocked.blockers].includes('LEAD_DEMOTION_NOT_EVALUATED'));
});

// B: the cited route must be blocked identically, with no baseline role at all.
test('lead: a cited trusted symbolic Lead is not demoted by a caller override', () => {
  const options = {
    sourceRoleEvidence: [
      { laneId: LEAD_LANE, role: 'Melody', citation: 'fixture:official score, lead staff' },
    ],
    roleOverrides: { [LEAD_LANE]: 'Chord1' },
  };
  const candidate = run(plainBackbone, options);
  assertOrderIndependent(plainBackbone, options);

  // The baseline carries no role at all: the protection comes from the citation.
  assert.deepEqual([...laneOf(candidate, LEAD_LANE).declaredSourceRoles], []);
  assert.equal(laneOf(candidate, LEAD_LANE).roleSupport.Melody.tier, 1);
  assert.equal(laneOf(candidate, LEAD_LANE).roleSupport.Melody.tierName, 'DECLARED_SOURCE_ROLE');

  assert.ok(!candidate.roles.Chord1.laneIds.includes(LEAD_LANE),
    'a cited Lead must not be demoted without the Lead Demotion Gate');
  const [blocked] = candidate.pending.filter(item => item.laneId === LEAD_LANE);
  assert.ok(blocked);
  assert.ok([...blocked.blockers].includes('LEAD_DEMOTION_NOT_EVALUATED'));
  assert.equal(blocked.gate, 'studio/backend/arbitration/lead-demotion.mjs#evaluateLeadDemotion');
});

// C: what a blocked demotion must look like, on both routes.
test('lead: a blocked demotion assigns nothing and invents no substitute Lead', () => {
  for (const [label, options] of [
    ['baseline', { roleOverrides: { [LEAD_LANE]: 'Chord1' } }],
    ['cited', {
      sourceRoleEvidence: [{ laneId: LEAD_LANE, role: 'Melody', citation: 'fixture:official score, lead staff' }],
      roleOverrides: { [LEAD_LANE]: 'Chord1' },
    }],
  ]) {
    const events = label === 'baseline'
      ? [
        ...line('m', [72, 74, 76, 72], MELODY_VOICE, 0, { role: 'Melody' }),
        ...line('h', [60, 62, 60, 62], HARMONY_VOICE),
        ...line('b', [48, 50, 43, 45], BASS_VOICE),
      ]
      : plainBackbone;
    // `run` asserts event conservation and that no pitch/onset/duration/source
    // identity moved, so the whole of C's last clause is checked here.
    const candidate = run(events, options);

    assert.equal(laneOf(candidate, LEAD_LANE).candidateRole, null, `${label}: no destination role`);
    for (const role of SIX_ROLES) {
      assert.ok(!candidate.roles[role].laneIds.includes(LEAD_LANE), `${label}: unassigned in ${role}`);
    }
    // No other lane is quietly promoted into the empty Lead slot.
    assert.equal(candidate.roles.Melody.status, 'PENDING', `${label}: Melody unresolved`);
    assert.deepEqual([...candidate.roles.Melody.laneIds], [], `${label}: no substitute Lead`);
    for (const id of laneOf(candidate, LEAD_LANE).eventIds) {
      const [entry] = ledgerFor(candidate, id);
      assert.equal(entry.decision, ROLE_DECISIONS.PENDING, `${label}: ${id} stays PENDING`);
    }
  }
});

// D: the interlock is about Lead, and must not swallow ordinary role evidence.
test('lead: cited Chord1/Chord2 evidence is unaffected by the Lead interlock', () => {
  const options = {
    sourceRoleEvidence: [
      { laneId: `lane:${HARMONY_VOICE}#0`, role: 'Chord1', citation: 'fixture:official score, accompaniment staff' },
      { laneId: `lane:${BASS_VOICE}#0`, role: 'Chord2', citation: 'fixture:official score, bass staff' },
    ],
  };
  const candidate = run(plainBackbone, options);
  assertOrderIndependent(plainBackbone, options);

  assert.deepEqual([...candidate.roles.Chord1.laneIds], [`lane:${HARMONY_VOICE}#0`]);
  assert.deepEqual([...candidate.roles.Chord2.laneIds], [`lane:${BASS_VOICE}#0`]);
  assert.deepEqual(candidate.pending.filter(item => [...item.blockers].includes('LEAD_DEMOTION_NOT_EVALUATED')), [],
    'non-Lead citations must not trip the Lead interlock');
});

// ─── event-level citation scope ─────────────────────────────────────────────
//
// Role assignment is lane-level. A citation naming a strict subset of a lane's
// events cannot be honoured as a declared role without extending its authority
// over events it never named, which breaks the event-level traceability
// MASTER_RULES.md §3 and SOURCE_POLICY.md §3 require.

// E: the widening itself.
test('events: a citation naming one event does not declare the whole lane', () => {
  const options = {
    sourceRoleEvidence: [
      { eventIds: ['m1'], role: 'Melody', citation: 'fixture:official score, bar 1 only' },
    ],
  };
  const candidate = run(plainBackbone, options);
  assertOrderIndependent(plainBackbone, options);

  const lane = laneOf(candidate, LEAD_LANE);
  assert.deepEqual([...lane.eventIds], ['m1', 'm2', 'm3', 'm4']);
  assert.notEqual(lane.roleSupport.Melody.tierName, 'DECLARED_SOURCE_ROLE',
    'm2-m4 were never named and must not inherit a declared role');

  // The citation is kept, at a strength that can never create an assignment,
  // and it still states exactly which events it does and does not cover.
  const [cited] = lane.evidence.filter(record => record.signal === 'trusted_symbolic_role');
  assert.ok(cited);
  assert.equal(cited.strength, 'supporting');
  assert.deepEqual([...cited.supportsRoles], []);
  assert.equal(cited.measurement.coversLane, false);
  assert.deepEqual([...cited.measurement.eventIds], ['m1']);
  assert.deepEqual([...cited.measurement.uncoveredEventIds], ['m2', 'm3', 'm4']);

  // And the lane fails closed rather than being decided either way.
  const [blocked] = candidate.pending.filter(item => item.laneId === LEAD_LANE);
  assert.ok(blocked);
  assert.ok([...blocked.blockers].includes('PARTIAL_EVENT_EVIDENCE_SCOPE'));

  const reported = diagnostic(candidate, 'PARTIAL_EVENT_EVIDENCE_SCOPE');
  assert.ok(reported);
  assert.equal(reported.widened, false);
  assert.equal(reported.claims.length, 1);
  assert.deepEqual([...reported.claims[0].coveredEventIds], ['m1']);
  assert.deepEqual([...reported.claims[0].uncoveredEventIds], ['m2', 'm3', 'm4']);
});

// F: partial evidence must not clear an interlock for the events it never named.
test('events: partial evidence cannot clear the Core3 sibling interlock', () => {
  const sibling = `lane:${HARMONY_VOICE}#2`;
  const partial = {
    sourceRoleEvidence: [
      { laneId: `lane:${HARMONY_VOICE}#0`, role: 'Chord1', citation: 'fixture:score accompaniment, upper part' },
      { laneId: `lane:${HARMONY_VOICE}#1`, role: 'Chord3', citation: 'fixture:score inner part, marked optional' },
      // Names only one of this lane's two events, so it cannot make the lane optional.
      { eventIds: ['ha1'], role: 'Chord4', citation: 'fixture:score inner part, bar 1 only' },
    ],
  };
  const candidate = run(concurrentInnerEvents, partial);
  assertOrderIndependent(concurrentInnerEvents, partial);

  assert.deepEqual([...laneOf(candidate, sibling).eventIds], ['ha1', 'hb1']);
  assert.notEqual(laneOf(candidate, sibling).roleSupport.Chord4.tier, 1);
  assert.notEqual(candidate.core3.status, 'COMPLETE',
    'an uncovered event may not be talked into enrichment by a partial citation');

  // Citing the lane's whole event set is what actually resolves it.
  const whole = run(concurrentInnerEvents, {
    sourceRoleEvidence: [
      ...partial.sourceRoleEvidence.slice(0, 2),
      { eventIds: ['ha1', 'hb1'], role: 'Chord4', citation: 'fixture:score inner part, marked optional' },
    ],
  });
  assert.equal(laneOf(whole, sibling).roleSupport.Chord4.tier, 1);
  assert.equal(whole.core3.status, 'COMPLETE');
  assert.equal(diagnostic(whole, 'PARTIAL_EVENT_EVIDENCE_SCOPE'), undefined);
});

// G: full coverage is still a declared role.
test('events: a citation covering every event of a lane still declares it', () => {
  const options = {
    sourceRoleEvidence: [
      { eventIds: ['m1', 'm2', 'm3', 'm4'], role: 'Melody', citation: 'fixture:official score, lead staff' },
    ],
  };
  const candidate = run(plainBackbone, options);
  assertOrderIndependent(plainBackbone, options);

  const lane = laneOf(candidate, LEAD_LANE);
  assert.equal(lane.roleSupport.Melody.tier, 1);
  assert.equal(lane.roleSupport.Melody.tierName, 'DECLARED_SOURCE_ROLE');
  assert.deepEqual([...candidate.roles.Melody.laneIds], [LEAD_LANE]);
  const [cited] = lane.evidence.filter(record => record.signal === 'trusted_symbolic_role');
  assert.equal(cited.strength, 'primary');
  assert.equal(cited.measurement.coversLane, true);
  assert.deepEqual([...cited.measurement.uncoveredEventIds], []);
  assert.equal(diagnostic(candidate, 'PARTIAL_EVENT_EVIDENCE_SCOPE'), undefined);
});

// H / I: the other two targeting routes are lane-complete by construction and
// must keep working untouched.
test('events: laneId-scoped and single-source sourceVoice-scoped citations still declare', () => {
  for (const [label, entry] of [
    ['laneId', { laneId: `lane:${HARMONY_VOICE}#0`, role: 'Chord1', citation: 'fixture:score accompaniment staff' }],
    ['sourceVoice', { sourceVoice: HARMONY_VOICE, role: 'Chord1', citation: 'fixture:score accompaniment staff' }],
  ]) {
    const options = { sourceRoleEvidence: [entry] };
    const candidate = run(plainBackbone, options);
    assertOrderIndependent(plainBackbone, options);

    const lane = laneOf(candidate, `lane:${HARMONY_VOICE}#0`);
    assert.equal(lane.roleSupport.Chord1.tier, 1, `${label}: still a declared role`);
    assert.equal(lane.roleSupport.Chord1.tierName, 'DECLARED_SOURCE_ROLE', `${label}`);
    assert.deepEqual([...candidate.roles.Chord1.laneIds], [`lane:${HARMONY_VOICE}#0`], `${label}`);
    assert.equal(diagnostic(candidate, 'PARTIAL_EVENT_EVIDENCE_SCOPE'), undefined, `${label}`);
  }
});
